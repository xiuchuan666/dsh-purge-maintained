#!/usr/bin/env node
// 用法：node scripts/store-repair.mjs --profile <dir> [--apply] [--store <dir>] [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diagnoseStore, applyStoreRepair, defaultStorePath, staleTarballDirs } from "../lib/store-repair.js";

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const has = (name) => argv.includes("--" + name);
if (has("help")) {
  console.log("dsh-purge store 修复\n\n  --profile DIR   桌面/web profile 目录（默认 ~/.dsh/profiles/desktop）\n  --store DIR     pnpm store/v11 目录（默认按平台推导）\n  --apply         实际删除过期 dsh-purge store 条目（默认只诊断）\n  --prune-dirs    配合 --apply，一并删除过期 tarball 指针目录\n  --json          输出 JSON");
  process.exit(0);
}
const home = process.env.USERPROFILE || process.env.HOME || "";
const profileDir = path.resolve(arg("profile", path.join(home, ".dsh", "profiles", "desktop")));
const storeDir = path.resolve(arg("store", defaultStorePath()));
const diagnosis = diagnoseStore({ profileDir, storeDir });
const result = applyStoreRepair(diagnosis, { dryRun: !has("apply") });
let pruned = [];
if (has("apply") && has("prune-dirs") && result.removed > 0) {
  pruned = staleTarballDirs(storeDir, diagnosis.plan.stale);
  for (const dir of pruned) fs.rmSync(dir, { recursive: true, force: true });
}
const report = {
  profileDir, storeDir,
  lock: diagnosis.current,
  installedVersion: diagnosis.installedVersion,
  storeExists: diagnosis.storeExists,
  keep: diagnosis.plan.keep.length,
  stale: diagnosis.plan.stale,
  result, pruned,
  applied: has("apply"),
};
if (has("json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("profile      " + profileDir);
  console.log("store        " + storeDir + (diagnosis.storeExists ? "" : "（不存在）"));
  console.log("lockfile     dsh-purge " + (diagnosis.current.packageVersion || "?") + "  " + (diagnosis.current.specifier || ""));
  console.log("installed    " + (diagnosis.installedVersion || "?"));
  console.log("store 条目   保留 " + diagnosis.plan.keep.length + " / 过期 " + diagnosis.plan.stale.length);
  for (const key of diagnosis.plan.stale) console.log("  stale  " + key);
  if (result.dryRun) console.log("\nDRY-RUN：加 --apply 才会删除（会先备份 index.db）。");
  else console.log("\n已删除 " + result.removed + " 条，备份 " + (result.backup || "无") + (pruned.length ? "，清理目录 " + pruned.length + " 个" : ""));
  if (diagnosis.current.packageVersion && diagnosis.installedVersion && diagnosis.current.packageVersion !== diagnosis.installedVersion) {
    console.log("\n注意：lockfile 与 node_modules 版本不一致，请先跑 profile:install 对齐。");
  }
}
