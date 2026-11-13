#!/usr/bin/env node
/**
 * verify-target —— 宿主适配体检 / host-adaptation probe
 *
 * 用法 / usage:
 *   node scripts/verify-target.mjs --ai-base <@deepseek-ai 目录> [--json out.json] [--pad]
 *
 * --ai-base 既可以是安装布局 <...>/node_modules/@deepseek-ai，
 *            也可以是解包布局 <app>/dsh/node_modules/@deepseek-ai。
 *
 * 对每一个补丁、每一处目标文件，走与真实 apply 完全相同的
 * applyReplacementsToText()，只分类不写盘：
 *   would-apply  原文命中，pattern 仍有效（升级后这里还有救）
 *   settled      marker 已在，已完成
 *   drifted      文件在、marker 无、pattern 一条不中 —— 上游改写/搬走，必须修
 *   no-file      目标文件不存在（布局差异，不算漂移）
 *
 * --pad 会把 drifted 的补丁按 pattern 逐条标出命中情况，便于定位改哪个字面量。
 *
 * 判定层在 scripts/verify-target-lib.mjs（judgePatch / judgePatches），本文件只负责
 * 解析参数、读盘、渲染。这样判定表可以整张用 Map 造出来测，不需要真的宿主树。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const argv = process.argv.slice(2);
function arg(name, fallback = "") {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const AI_BASE = arg("ai-base") || path.join(ROOT, "node_modules", "@deepseek-ai");
const JSON_OUT = arg("json");
const PAD = argv.includes("--pad");

const core = await import(new URL("../lib/core.js", import.meta.url).href);
const verifyLib = await import(new URL("./verify-target-lib.mjs", import.meta.url).href);

const files = core.targetFiles(AI_BASE);
const host = core.readHostVersion(AI_BASE);
const compat = core.hostCompat(AI_BASE);
const textCache = new Map();
function readText(fp) {
  if (!textCache.has(fp)) {
    try {
      textCache.set(fp, fs.readFileSync(fp, "utf8"));
    } catch {
      textCache.set(fp, null);
    }
  }
  return textCache.get(fp);
}

const judged = verifyLib.judgePatches(core.ALL_PATCHES, {
  files,
  readText,
  applyReplacementsToText: core.applyReplacementsToText,
  filePatchOutcome: core.filePatchOutcome,
  patchAppliesHere: core.patchAppliesHere,
  detail: PAD,
});

const rows = judged.rows;
const wouldApply = judged.tally.wouldApply;
const settled = judged.tally.settled;
const drifted = judged.tally.drifted;
const noFile = judged.tally.noFile;
const na = judged.tally.na;
const summary = {
  aiBase: AI_BASE,
  host: host?.version ?? "unknown",
  hostPath: host?.path ?? "",
  compat,
  patches: core.ALL_PATCHES.length,
  wouldApply,
  settled,
  drifted,
  noFile,
  na,
  rows,
};
if (JSON_OUT) {
  fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(summary, null, 2));
}
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log(`ai-base : ${AI_BASE}`);
console.log(`host    : ${summary.host}  (target ${compat.target}  ok=${compat.ok})`);
console.log(`patches : ${summary.patches}  would-apply=${wouldApply}  settled=${settled}  drifted=${drifted}  no-file=${noFile}  na=${na}`);
console.log("");
console.log(`${pad("#", 4)}${pad("name", 42)}${pad("status", 14)}files`);
for (const r of rows) {
  const filesTxt = Object.entries(r.files).map(([k, v]) => `${k}:${v}`).join(" ");
  const mark = r.status === "drifted" ? "✗" : r.status === "would-apply" ? "~" : r.status === "settled" ? "✓" : "·";
  console.log(`${mark}${padL(r.id, 3)} ${pad(r.name, 42)}${pad(r.status, 14)}${filesTxt}`);
  if (PAD && r.detail) {
    for (const d of r.detail) {
      console.log(`      ${d.key} ${d.file}`);
      for (const pat of d.patterns || []) {
        console.log(`        ${pat.hit ? "HIT " : "miss"} ${pat.head.replace(/\n/g, "\\n").slice(0, 160)}`);
      }
    }
  }
}
console.log("");
console.log(`drifted: ${drifted}/${summary.patches}`);
process.exitCode = drifted > 0 ? 1 : 0;
