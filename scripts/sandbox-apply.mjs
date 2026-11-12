#!/usr/bin/env node
/* 在旁路副本里重打 86 条补丁，并把结果与 docs/host-baseline.json 逐字节对拍。
 *
 * 用途：宿主升级或被换回原版之后，先在这里确认「这套补丁还能不能打出与上次
 * 一模一样的字节」，再决定动不动真宿主。全程只写 .tmp-sandbox/，真宿主一个字节都不碰。
 *
 *   node scripts/sandbox-apply.mjs                 # 默认用本机桌面树
 *   node scripts/sandbox-apply.mjs --source <dir>  # 指定 @deepseek-ai 目录
 *   node scripts/sandbox-apply.mjs --keep          # 保留上次的副本，不重建
 *   node scripts/sandbox-apply.mjs --json          # 只输出 JSON
 *
 * 退出码：0 = 复现成功（与基线逐字节一致、第二次重打全 already）
 *         1 = 有差异（drift / missing / no-marker / not-idempotent）
 *         2 = 环境问题（找不到宿主树、沙盒目录不安全）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  packagesFromTargetFiles,
  summarizeStatuses,
  compareToBaseline,
  describeOutcome,
  isSafeSandboxDir,
} from "./sandbox-apply-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SANDBOX = path.join(REPO, ".tmp-sandbox");
const HOME = path.join(SANDBOX, "home");
const AI = path.join(SANDBOX, "ai", "@deepseek-ai");
const BASELINE = path.join(REPO, "docs", "host-baseline.json");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback = "") => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DEFAULT_SOURCES = [
  "C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai",
  path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"),
];

function pickSource() {
  const explicit = opt("--source");
  if (explicit) return path.resolve(explicit);
  for (const cand of DEFAULT_SOURCES) {
    if (fs.existsSync(path.join(cand, "dsh-agent-instructions", "lib", "index.js"))) return cand;
  }
  return "";
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

function walkStats(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(p).size;
        } catch {
          /* 复制后仍可能被占用，跳过体积统计 */
        }
      }
    }
  }
  return { files, bytes };
}

function digestFile(fp) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
  } catch {
    return null;
  }
}

async function main() {
  const source = pickSource();
  if (!source) {
    console.error("[sandbox] 找不到宿主树，用 --source 指定 @deepseek-ai 目录");
    process.exit(2);
  }

  const safety = isSafeSandboxDir(SANDBOX, {
    repoRoot: REPO,
    protectedRoots: [
      source,
      "C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness",
      path.join(os.homedir(), ".dsh"),
    ],
  });
  if (!safety.ok) {
    console.error(`[sandbox] 沙盒目录不安全：${safety.reason}`);
    process.exit(2);
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  const core = await import(new URL("../lib/core.js", import.meta.url).href);

  const files = core.targetFiles(source);
  const packages = packagesFromTargetFiles(files, source);
  if (packages.length === 0) {
    console.error("[sandbox] 从 targetFiles 推不出任何包目录 —— 宿主树形状不认识");
    process.exit(2);
  }

  if (!flag("--keep")) fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(AI, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });

  for (const pkg of packages) {
    const from = path.join(source, pkg);
    if (!fs.existsSync(from)) {
      console.error(`[sandbox] 源树缺包：${pkg}`);
      process.exit(2);
    }
    copyTree(from, path.join(AI, pkg));
  }
  const copied = walkStats(AI);

  process.env.DSH_HOME = HOME;

  const first = await core.applyPatches(AI, core.ALL_PATCHES, { preserveClientBundles: false });
  const firstCounts = summarizeStatuses(first).counts;
  const markersPresent = core.hostCleanMarkersPresent(AI);

  const digests = new Map();
  for (const meta of Object.values(baseline.files)) {
    digests.set(String(meta.rel), digestFile(path.join(AI, String(meta.rel))));
  }
  const compare = compareToBaseline(baseline.files, digests);

  const second = await core.applyPatches(AI, core.ALL_PATCHES, { preserveClientBundles: false });
  const secondCounts = summarizeStatuses(second).counts;

  const outcome = describeOutcome({ compare, markersPresent, firstCounts, secondCounts });
  const payload = {
    source,
    sandbox: SANDBOX,
    packages: packages.length,
    copied,
    surface: (await import(new URL("../lib/surface.js", import.meta.url).href)).detectSurface(),
    patches: core.ALL_PATCHES.length,
    firstCounts,
    secondCounts,
    markersPresent,
    compare: { total: compare.total, same: compare.same, diff: compare.diff, missing: compare.missing },
    differing: compare.rows.filter((r) => r.state !== "same").slice(0, 40),
    outcome,
  };

  if (flag("--json")) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log(`[sandbox] 源树 ${source}`);
    console.log(`[sandbox] 复制 ${packages.length} 个包 / ${copied.files} 个文件 / ${(copied.bytes / 1048576).toFixed(1)}MB 到 ${SANDBOX}`);
    console.log(`[sandbox] 面 ${payload.surface}，补丁 ${payload.patches} 条`);
    console.log(`[sandbox] 首次重打 ${JSON.stringify(firstCounts)}`);
    console.log(`[sandbox] 宿主注入标记 ${markersPresent ? "在" : "不在"}`);
    console.log(`[sandbox] 与基线对拍 ${compare.total} 个文件：一致 ${compare.same} / 不一致 ${compare.diff} / 缺失 ${compare.missing}`);
    for (const row of compare.rows.filter((r) => r.state !== "same").slice(0, 20)) {
      console.log(`[sandbox]   ${row.state} ${row.rel} 基线 ${row.want || "-"} 现在 ${row.got || "-"}`);
    }
    console.log(`[sandbox] 第二次重打 ${JSON.stringify(secondCounts)}`);
    console.log(`[sandbox] 结论 ${outcome.verdict}：${outcome.detail}`);
  }

  process.exit(outcome.verdict === "reproduced" ? 0 : 1);
}

main().catch((error) => {
  console.error(`[sandbox] 失败：${error?.stack || error}`);
  process.exit(2);
});
