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

const asLf = (s) => String(s ?? "").replace(/\r\n/g, "\n");
const isYamlPath = (fp) => /\.ya?ml$/i.test(fp || "");

function fileKeysOf(p) {
  return Array.isArray(p.file) ? p.file : [p.file];
}

function patchReplacements(p) {
  if (Array.isArray(p.replacements)) return p.replacements;
  return (p.patterns ?? []).map((pat) => ({ pattern: pat, replace: p.replace }));
}

function keysOfPatch(p) {
  return fileKeysOf(p).filter(Boolean);
}

/** 已被官方搬家、允许「文件在但原文不在」的键（包拆分后的旧位置）。 */
function softKeysOf(p) {
  return Array.isArray(p.softFiles) ? p.softFiles : [];
}

function pathsOf(files, key) {
  const v = files[key];
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function patchApplied(text, patch) {
  const hay = asLf(text);
  if (Array.isArray(patch.forbid) && patch.forbid.some((m) => hay.includes(asLf(m)))) return false;
  if (Array.isArray(patch.markers) && patch.markers.length > 0) {
    const match = patch.markersAny ? "some" : "every";
    return patch.markers[match]((m) => hay.includes(asLf(m)));
  }
  if (patch.marker) return hay.includes(asLf(patch.marker));
  if (typeof patch.replace === "string" && patch.replace.length > 0) {
    return hay.includes(asLf(patch.replace).split("\n")[0].slice(0, 60));
  }
  return false;
}

function matchesPattern(hay, pattern) {
  if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.replace("g", "")).test(hay);
  return hay.includes(asLf(pattern));
}

function remainingWork(text, patch, fp) {
  const hay = asLf(text);
  const yaml = isYamlPath(fp);
  for (const { pattern, replace } of patchReplacements(patch)) {
    if (!pattern || typeof replace !== "string") continue;
    if (yaml && !/^[ \t]/.test(asLf(pattern)) && /^You are a coding agent powered by\b/.test(asLf(pattern))) continue;
    if (matchesPattern(hay, pattern)) return true;
  }
  return false;
}

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

const rows = [];
let wouldApply = 0;
let settled = 0;
let drifted = 0;
let noFile = 0;
let na = 0;

for (const p of core.ALL_PATCHES) {
  if (typeof core.patchAppliesHere === "function" && !core.patchAppliesHere(p)) {
    rows.push({ id: p.id, name: p.name, status: "na", files: {} });
    na += 1;
    continue;
  }
  const stat = {};
  let status = "no-file";
  const detail = [];
  for (const key of keysOfPatch(p)) {
    const fps = pathsOf(files, key);
    if (fps.length === 0) {
      stat[key] = "no-file";
      continue;
    }
    for (const fp of fps) {
      const text = readText(fp);
      if (text == null) {
        stat[key] = "no-file";
        continue;
      }
      const res = core.applyReplacementsToText(text, p, fp);
      if (res.hitMismatch) {
        stat[key] = "hit-mismatch";
        status = "drifted";
        detail.push({
          key,
          file: fp,
          hitMismatch: res.hitMismatch,
          patterns: patchReplacements(p).map((r) => ({
            hit: matchesPattern(asLf(text), r.pattern),
            head: asLf(String(r.pattern?.source ?? r.pattern)).slice(0, 120),
          })),
        });
        continue;
      }
      if (res.changed) {
        // 全部 pattern 都命中也可能是"只打了一半"：补丁声明了 markers（every），
        // 产物里凑不齐就是部分应用 —— 首轮 e2e 就是这么抓出 #17 的。
        // 用引擎自己的判定：apply 完之后这处文件到底算不算完成。
        const settledAfter = core.filePatchOutcome(res.text, p, fp) === "applied";
        if (!settledAfter) {
          stat[key] = "partial";
          status = "drifted";
          detail.push({
            key,
            file: fp,
            partial: true,
            patterns: patchReplacements(p).map((r) => ({
              hit: matchesPattern(asLf(text), r.pattern),
              head: asLf(String(r.pattern?.source ?? r.pattern)).slice(0, 200),
            })),
          });
          continue;
        }
        stat[key] = "would-apply";
        if (status !== "drifted") status = "would-apply";
        continue;
      }
      // 一条 pattern 都没中：直接问引擎，别再维护第二份平行判定。
      // softFiles / deleteOnly / after 链式关系全在 core 里，抄一遍必然分叉
      // （#88 就曾在这里单独被记成 drifted，而顺序 apply 时它是好的）。
      const outcome = core.filePatchOutcome(text, p, fp);
      if (outcome === "applied") {
        stat[key] = "settled";
        if (status === "no-file") status = "settled";
        continue;
      }
      if (outcome === "pending") {
        stat[key] = "pending";
        if (status !== "drifted") status = "would-apply";
        continue;
      }
      if (outcome === "skipped") {
        stat[key] = "self-marked";
        if (status === "no-file") status = "settled";
        continue;
      }
      if (softKeysOf(p).includes(key)) {
        // 旧文件键被官方搬家：文件在、原文不在，不算漂移。
        stat[key] = "soft-moved";
        if (status === "no-file") status = "would-apply";
        continue;
      }
      stat[key] = "drifted";
      status = "drifted";
      detail.push({
        key,
        file: fp,
        patterns: patchReplacements(p).map((r) => ({
          hit: matchesPattern(asLf(text), r.pattern),
          head: asLf(String(r.pattern?.source ?? r.pattern)).slice(0, 200),
        })),
      });
      continue;
    }
  }
  if (status === "would-apply") wouldApply += 1;
  else if (status === "settled") settled += 1;
  else if (status === "drifted") drifted += 1;
  else noFile += 1;
  rows.push({ id: p.id, name: p.name, status, files: stat, detail: PAD ? detail : undefined });
}

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
