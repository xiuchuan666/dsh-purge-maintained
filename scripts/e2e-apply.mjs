#!/usr/bin/env node
/**
 * e2e-apply —— 真打一遍的端到端验证 / real apply on a throwaway copy
 *
 * 用法 / usage:
 *   node scripts/e2e-apply.mjs --src <.../node_modules/@deepseek-ai> [--work <临时目录>] [--keep]
 *
 * 流程 / flow:
 *   1. 把 --src 整棵 @deepseek-ai 树复制到 --work（默认 $TEMP/dsh-purge-e2e-<pid>）
 *   2. DSH_HOME 指到同一临时目录，绝不碰真实 ~/.dsh
 *   3. 第一遍 applyPatches：统计 applied / already / drifted / missing
 *   4. 第二遍 applyPatches：必须 applied=0（幂等，marker 生效）
 *   5. patchStatus：不允许出现 pending / drifted（#88 这种链式补丁只有在顺序应用后才成立）
 *   6. revertAll：目标文件必须逐字节回到原样
 *
 * 桌面壳补丁（surfaces:["desktop"]）在这里一律跳过：它们打的是真实 Electron 安装目录，
 * 复制不出来。桌面侧靠 scripts/verify-target.mjs 对上游 TS 源核对锚点。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const argv = process.argv.slice(2);
function arg(name, fallback = "") {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const SRC = arg("src");
if (!SRC) {
  console.error("need --src <.../node_modules/@deepseek-ai>");
  process.exit(2);
}
const WORK = arg("work") || path.join(os.tmpdir(), `dsh-purge-e2e-${process.pid}`);
const KEEP = argv.includes("--keep");
const AI_BASE = path.join(WORK, "node_modules", "@deepseek-ai");
const HOME_DIR = path.join(WORK, "dsh-home");

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.dirname(AI_BASE), { recursive: true });
fs.mkdirSync(HOME_DIR, { recursive: true });
process.env.DSH_HOME = HOME_DIR;

const t0 = Date.now();
fs.cpSync(SRC, AI_BASE, { recursive: true });
console.log(`copy   : ${SRC}\n      -> ${AI_BASE}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const core = await import(new URL("../lib/core.js", import.meta.url).href);

// 桌面壳补丁打的是真实 Electron 安装，复制不出来 —— 这里显式排除。
const PATCHES = core.ALL_PATCHES.filter((p) => !(Array.isArray(p.surfaces) && p.surfaces.includes("desktop")));
const SKIPPED_DESKTOP = core.ALL_PATCHES.length - PATCHES.length;

const files = core.targetFiles(AI_BASE);
const hash = (fp) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
  } catch {
    return "";
  }
};
const targetPaths = [];
for (const v of Object.values(files)) for (const fp of Array.isArray(v) ? v : [v]) if (fp && !targetPaths.includes(fp)) targetPaths.push(fp);
const before = new Map(targetPaths.map((fp) => [fp, hash(fp)]));

const tally = (report) => {
  const out = {};
  for (const row of report) out[row.status] = (out[row.status] || 0) + 1;
  return out;
};

let failed = 0;
function check(ok, label, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) failed += 1;
}

console.log(`host   : ${core.readHostVersion(AI_BASE)?.version}  patches=${PATCHES.length} (desktop-skipped=${SKIPPED_DESKTOP})`);

// 正常流程里 UI 会先 backupAll（.dshpurge.bak），revertAll 全靠它还原。
const backup = await core.backupAll(AI_BASE);
console.log(`backup : ${backup.made.length} files`);

const first = await core.applyPatches(AI_BASE, PATCHES, { preserveClientBundles: false });
const t1 = tally(first);
console.log("apply#1:", JSON.stringify(t1));
const firstDrift = first.filter((r) => r.status === "drifted");
check(firstDrift.length === 0, "apply#1 no drifted", firstDrift.map((r) => `#${r.patch_id}:${r.name}`).join(" ") || "");
const OK1 = new Set(["applied", "already", "skipped", "na", "missing_file"]);
const unaccounted = first.filter((r) => !OK1.has(r.status));
check(unaccounted.length === 0, "apply#1 every patch accounted for", unaccounted.map((r) => `#${r.patch_id}:${r.status}`).join(" ") || "");

const second = await core.applyPatches(AI_BASE, PATCHES, { preserveClientBundles: false });
const t2 = tally(second);
console.log("apply#2:", JSON.stringify(t2));
const reApplys = second.filter((r) => r.status === "applied");
check(reApplys.length === 0, "idempotent (apply#2 writes nothing)", reApplys.map((r) => `#${r.patch_id}`).join(" ") || "");

const status = await core.patchStatus(AI_BASE, PATCHES);
const bad = Object.entries(status).filter(([, s]) => s === "pending" || s === "drifted");
console.log("status :", JSON.stringify(Object.values(status).reduce((a, s) => ({ ...a, [s]: (a[s] || 0) + 1 }), {})));
check(bad.length === 0, "patchStatus clean (no pending/drifted)", bad.map(([id, s]) => `#${id}:${s}`).join(" ") || "");

const rev = await core.revertAll(AI_BASE, {});
console.log(`revert : reverted=${rev.reverted.length} skipped=${rev.skipped.length} errors=${rev.errors.length}`);
const changed = targetPaths.filter((fp) => hash(fp) !== before.get(fp));
check(changed.length === 0, "revertAll restores every target byte-identical", changed.slice(0, 6).join(" ") || "");

if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
else console.log(`kept   : ${WORK}`);

console.log(failed === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
