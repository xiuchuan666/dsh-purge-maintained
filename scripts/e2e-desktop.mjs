#!/usr/bin/env node
/*
 * 桌面壳（Electron 主进程 bundle）补丁端到端验证。
 *
 * 用途：`surfaces: ["desktop"]` 的补丁在纯 node 环境里会被 patchAppliesHere()
 * 判为 na，普通 e2e（scripts/e2e-apply.mjs）永远跳过它们。本脚本直接把
 * 「纯净的 resources/app/lib/main.js」喂给 applyReplacementsToText()，按 id
 * 顺序打一遍、再打一遍验幂等、最后跑 node --check 验语法。
 *
 * 用法：
 *   node scripts/e2e-desktop.mjs --main <纯净 main.js 路径> [--label 0.2.2-rc.1] [--out <目录>]
 *
 * 纯净基线从哪来：
 *   - 0.2.2-rc.1：从官方安装包的 resources/app.asar 里拆出来（脚本 asar-dump.mjs）
 *   - 0.2.1-rc.5：安装目录里的 main.js.dshpurge.bak（插件自己打的备份）
 *   注意：安装目录里的 main.js 是「已打补丁」的，不能当基线。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const coreUrl = new URL("../lib/core.js", import.meta.url);
const core = await import(coreUrl.href);

function argOf(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}

const mainPath = argOf("main", null);
if (!mainPath) {
  console.error("用法: node scripts/e2e-desktop.mjs --main <main.js> [--label X] [--out DIR]");
  process.exit(2);
}
const label = argOf("label", path.basename(path.dirname(path.dirname(mainPath))));
const outDir = argOf("out", path.join(path.dirname(mainPath), ".."));

const DESKTOP_IDS = [45, 46, 82, 83, 84, 92, 93];
const fp = "desktop-shell";
const pristine = fs.readFileSync(mainPath, "utf8");
let text = pristine;
const rows = [];

for (const id of DESKTOP_IDS) {
  const patch = core.ALL_PATCHES.find((p) => p.id === id);
  if (!patch) {
    rows.push({ id, state: "MISSING_PATCH" });
    continue;
  }
  const res = core.applyReplacementsToText(text, patch, fp);
  const applied = core.filePatchOutcome(text, patch, fp) === "applied";
  rows.push({
    id,
    name: patch.name,
    changed: Boolean(res.changed),
    already: applied,
    reason: res.reason ?? "",
  });
  text = res.text;
}

// 幂等：同一份产物再打一遍，必须零写入且每条都已 applied。
let secondChanged = 0;
{
  let t2 = text;
  for (const id of DESKTOP_IDS) {
    const patch = core.ALL_PATCHES.find((p) => p.id === id);
    if (!patch) continue;
    const res = core.applyReplacementsToText(t2, patch, fp);
    if (res.changed) secondChanged += 1;
    t2 = res.text;
  }
}

// 打完后的 marker 覆盖情况
const marks = rows.map((r) => {
  const patch = core.ALL_PATCHES.find((p) => p.id === r.id);
  const outcome = patch ? core.filePatchOutcome(text, patch, fp) : "missing";
  return { id: r.id, outcome, applied: outcome === "applied" };
});

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `main.patched.${label}.js`);
fs.writeFileSync(outFile, text);

let syntax = "FAIL";
try {
  execFileSync(process.execPath, ["--check", outFile], { stdio: "pipe" });
  syntax = "OK";
} catch (err) {
  syntax = `FAIL: ${String(err.stderr || err.message).slice(0, 400)}`;
}

const order = rows.map((r) => `#${r.id}:${r.changed ? "applied" : r.already ? "already" : "NOOP"}`).join(" ");
const allApplied = marks.every((m) => m.applied);
const fail = secondChanged > 0 || syntax !== "OK" || !allApplied;

console.log(`[desktop-e2e] label=${label}`);
console.log(`[desktop-e2e] main=${mainPath} (${pristine.length} bytes)`);
console.log(`[desktop-e2e] order: ${order}`);
console.log(`[desktop-e2e] second pass changed=${secondChanged} (want 0)`);
console.log(`[desktop-e2e] outcomes: ${marks.map((m) => `#${m.id}=${m.outcome}`).join(" ")}`);
console.log(`[desktop-e2e] node --check=${syntax}`);
console.log(`[desktop-e2e] output=${outFile}`);
console.log(`RESULT: ${fail ? "FAIL" : "PASS"}`);
process.exit(fail ? 1 : 0);
