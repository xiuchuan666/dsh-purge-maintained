#!/usr/bin/env node
// 宿主树备份 GC：默认 dry-run；--apply 才真删，且只删 plan.remove 里、
// 复核过 root 边界的条目。退出码 1 = 有条目删失败，2 = 参数/边界问题。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatBytes, isInsideRoot, planGc, scanBackups, summarize } from "../lib/host-gc.js";

const USAGE = "usage: node scripts/host-gc.mjs --root <dir> [--keep 2] [--apply] [--json]";

function parse(argv) {
  const out = { root: null, keep: 2, apply: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") out.root = argv[++i];
    else if (arg === "--keep") out.keep = argv[++i];
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error("unknown argument: " + arg);
  }
  return out;
}

function die(code, message, extra) {
  const payload = Object.assign({ ok: false, error: message }, extra || {});
  if (process.argv.includes("--json")) console.log(JSON.stringify(payload, null, 2));
  else console.error("[host-gc] " + message);
  process.exit(code);
}

function assertSafeRoot(root) {
  const home = os.homedir();
  const dshHome = path.join(home, ".dsh");
  const rel = path.relative(dshHome, root);
  const insideDsh = !rel || rel === "." || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (root === home || insideDsh) {
    throw new Error("refusing to operate inside ~/.dsh: " + root);
  }
}

let args;
try {
  args = parse(process.argv.slice(2));
} catch (error) {
  die(2, error.message);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!args.root) die(2, "--root is required (this tool never guesses a host tree)");

const root = path.resolve(String(args.root));
let rootInfo;
try {
  rootInfo = fs.statSync(root);
} catch {
  rootInfo = null;
}
if (!rootInfo || !rootInfo.isDirectory()) die(2, "root is not a directory: " + root);
try {
  assertSafeRoot(root);
} catch (error) {
  die(2, error.message);
}

const keep = Number(args.keep);
if (!Number.isInteger(keep) || keep < 1) die(2, "--keep must be an integer >= 1");

let scan;
let plan;
let summary;
try {
  scan = scanBackups(root);
  plan = planGc(scan, { keep });
  summary = summarize(plan);
} catch (error) {
  die(2, "scan failed: " + error.message);
}

const removed = [];
const failed = [];
const violations = [];

if (args.apply) {
  for (const entry of plan.remove) {
    const target = path.resolve(String(entry.absPath || ""));
    if (!isInsideRoot(root, target)) {
      violations.push({ path: target, reason: "outside root" });
      if (!args.json) console.error("violation " + target + "  outside root");
      continue;
    }
    let info;
    try {
      info = fs.lstatSync(target);
    } catch (error) {
      failed.push({ path: target, reason: "stat failed: " + error.message });
      if (!args.json) console.error("failed   " + target + "  stat failed: " + error.message);
      continue;
    }
    if (info.isSymbolicLink()) {
      violations.push({ path: target, reason: "symlink refused" });
      if (!args.json) console.error("violation " + target + "  symlink refused");
      continue;
    }
    if (!info.isFile() && !info.isDirectory()) {
      failed.push({ path: target, reason: "not a file or directory" });
      if (!args.json) console.error("failed   " + target + "  not a file or directory");
      continue;
    }
    let realRoot;
    let realTarget;
    try {
      realRoot = fs.realpathSync(root);
      realTarget = fs.realpathSync(target);
    } catch (error) {
      failed.push({ path: target, reason: "realpath failed: " + error.message });
      if (!args.json) console.error("failed   " + target + "  realpath failed: " + error.message);
      continue;
    }
    if (!isInsideRoot(realRoot, realTarget)) {
      violations.push({ path: target, realPath: realTarget, reason: "realpath escapes root" });
      if (!args.json) console.error("violation " + target + "  realpath escapes root");
      continue;
    }
    try {
      fs.rmSync(target, { recursive: info.isDirectory(), force: false, maxRetries: 2 });
      removed.push({ path: target, kind: entry.kind, bytes: Number(entry.bytes) || 0 });
      if (!args.json) console.log("removed  " + target + "  (" + formatBytes(entry.bytes) + ")");
    } catch (error) {
      failed.push({ path: target, reason: error.message });
      if (!args.json) console.error("failed   " + target + "  " + error.message);
    }
  }
}

const mode = args.apply ? "apply" : "dry-run";

if (args.json) {
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0 && violations.length === 0,
        mode,
        root,
        keep,
        scan: { total: scan.total, sidecar: scan.sidecar.length, appPrev: scan.appPrev.length, asarBak: scan.asarBak.length },
        plan,
        summary,
        removed,
        failed,
        violations,
      },
      null,
      2,
    ),
  );
} else {
  console.log("[host-gc] " + mode + " root=" + root + " keep=" + keep + " backups=" + scan.total);
  for (const kind of ["sidecar", "appPrev", "asarBak"]) {
    const list = scan[kind];
    if (!list.length) continue;
    console.log("  " + kind + ": " + list.length);
    for (const entry of list) {
      const decision = plan.reasons[entry.absPath] || {};
      const tag = decision.action === "remove" ? "remove" : "keep  ";
      const why = decision.action === "remove" ? "  <- " + decision.reason : "";
      console.log("    " + tag + " " + entry.relPath + "  gen=" + entry.gen + "  " + formatBytes(entry.bytes) + why);
    }
  }
  console.log(
    "[host-gc] " + (args.apply ? "removed " : "would remove ") + summary.removeCount + " entries, " + summary.freedHuman + "; keeping " + summary.keepCount,
  );
  for (const risk of summary.risks) console.log("[host-gc] risk: " + risk);
  if (!args.apply) console.log("[host-gc] dry-run only; pass --apply to delete the listed remove entries");
}

if (violations.length > 0) {
  if (!args.json) console.error("[host-gc] " + violations.length + " path(s) escaped root; nothing else touched");
  process.exit(2);
}
process.exit(failed.length > 0 ? 1 : 0);
