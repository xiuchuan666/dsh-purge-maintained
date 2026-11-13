#!/usr/bin/env node
// 五态补丁报告：把「哪条补丁还有活 / 哪条已达成 / 哪条该退役」用基线差算出来。
//
//   node scripts/patch-outcome-report.mjs                       # 真宿主，无基线（只能给 pending/applied/unknown）
//   node scripts/patch-outcome-report.mjs --baseline-tree DIR   # 有纯净基线：五态齐全
//   node scripts/patch-outcome-report.mjs --json out.json --details
//
// --baseline-tree 指向一棵干净安装的 @deepseek-ai 目录（npm install 到临时目录得到的，
// 与 .dshpurge.bak 无关）。没有基线时 native/stale 无法区分，函数会返回 unknown 而不是猜。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ALL_PATCHES } from "../lib/patches/index.mjs";
import * as core from "../lib/core.js";
import {
  PATCH_STATES,
  UNKNOWN,
  STATE_LIST,
  classifyPatch,
  tallyStates,
  needsAttention,
} from "../lib/patch-outcome.mjs";
import { findAiBase, resolveAiBase } from "./host-baseline-lib.mjs";

function parseArgs(argv) {
  const out = { aiBase: null, baselineTree: null, json: null, details: false, only: null, limit: 40 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--ai-base") out.aiBase = argv[++i];
    else if (a === "--baseline-tree") out.baselineTree = argv[++i];
    else if (a === "--json") out.json = argv[++i];
    else if (a === "--details") out.details = true;
    else if (a === "--only") out.only = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error("unknown argument: " + a);
  }
  return out;
}

function readMaybe(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

function targetsFor(aiBase) {
  // 用 core.targetFiles 而不是手抄路径表：那是 apply 时真正写的那张表。
  return core.targetFiles(aiBase);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: patch-outcome-report.mjs [--ai-base DIR] [--baseline-tree DIR] [--json FILE] [--details] [--only NAME] [--limit N]");
    return 0;
  }
  let aiBase;
  try {
    aiBase = args.aiBase ? resolveAiBase(args.aiBase) : findAiBase();
  } catch (err) {
    console.error("cannot resolve host ai base: " + err.message);
    return 2;
  }
  const baseAi = args.baselineTree ? resolveAiBase(args.baselineTree) : null;
  const files = targetsFor(aiBase);
  const baseFiles = baseAi ? targetsFor(baseAi) : null;

  const results = [];
  for (const patch of ALL_PATCHES) {
    if (args.only && String(patch.name).indexOf(args.only) < 0 && String(patch.id) !== String(args.only)) continue;
    const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
    const inputs = [];
    for (const key of keys) {
      const v = files[key];
      const arr = (Array.isArray(v) ? v : [v]).filter(Boolean);
      if (arr.length === 0) { inputs.push({ file: key + "(unresolved)", fileText: null, baselineText: null }); continue; }
      for (const fp of arr) {
        const rel = path.relative(aiBase, fp);
        const baseFp = baseFiles ? path.join(baseAi, rel) : null;
        inputs.push({
          file: rel,
          fileText: readMaybe(fp),
          baselineText: baseFp ? readMaybe(baseFp) : null,
        });
      }
    }
    results.push(classifyPatch(patch, inputs));
  }

  const tally = tallyStates(results);
  const attention = results.filter(function (r) { return needsAttention(r.state); });
  const stale = results.filter(function (r) { return r.state === PATCH_STATES.STALE; });
  const line = function (label, n) { return "  " + label + ": " + n; };
  console.log("host ai base : " + aiBase);
  console.log("baseline tree: " + (baseAi || "(none — native/stale cannot be told apart)"));
  console.log("patches      : " + results.length);
  console.log("states:");
  for (const s of STATE_LIST.concat([UNKNOWN])) console.log(line(s, tally[s] || 0));
  if (stale.length) {
    console.log("");
    console.log("stale (anchor and product both gone, file untouched — retire or re-anchor): " + stale.length);
    for (const r of stale.slice(0, args.limit)) console.log("  #" + r.id + " " + r.name);
    if (stale.length > args.limit) console.log("  ... " + (stale.length - args.limit) + " more");
  }
  if (attention.length) {
    console.log("");
    console.log("needs attention (drifted/unknown): " + attention.length);
    for (const r of attention.slice(0, args.limit)) {
      const why = r.files.map(function (f) { return f.state + (f.reasons && f.reasons.length ? " [" + f.reasons[0] + "]" : ""); }).join("; ");
      console.log("  #" + r.id + " " + r.name + " — " + why);
    }
    if (attention.length > args.limit) console.log("  ... " + (attention.length - args.limit) + " more");
  }
  if (args.details) {
    console.log("");
    console.log("detail:");
    for (const r of results) {
      const sub = r.files.map(function (f) { return "    " + f.state.padEnd(8) + " " + f.file + (f.reasons.length ? "  (" + f.reasons.join(" | ") + ")" : ""); }).join("\n");
      console.log("  #" + r.id + " " + r.name + " => " + r.state);
      if (sub) console.log(sub);
    }
  }
  if (args.json) {
    const payload = {
      schema: 1,
      kind: "dsh-patch-outcome",
      aiBase,
      baselineTree: baseAi,
      capturedAt: new Date().toISOString(),
      tally,
      patches: results,
    };
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(args.json, JSON.stringify(payload, null, 2) + "\n");
    console.log("");
    console.log("wrote " + args.json);
  }
  // 退出码：有需要人看的 drifted/unknown → 1；只有 stale（可批量退役）→ 0。
  return attention.length > 0 ? 1 : 0;
}

process.exitCode = main();