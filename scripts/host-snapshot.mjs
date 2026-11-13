#!/usr/bin/env node
/**
 * host-snapshot —— 给整个宿主树拍一份独立基线，不依赖 .bak
 *
 * 用法 / usage:
 *   node scripts/host-snapshot.mjs                        # 拍当前宿主 → docs/host-tree.json
 *   node scripts/host-snapshot.mjs --out <file>           # 换输出路径
 *   node scripts/host-snapshot.mjs --ai-base <dir>        # 指定宿主（默认自动探测）
 *   node scripts/host-snapshot.mjs --diff a.json b.json   # 只比对两份快照
 *   node scripts/host-snapshot.mjs --pristine             # 树上有注入标记就退出 3
 *   node scripts/host-snapshot.mjs --json                 # 机器可读输出
 *   node scripts/host-snapshot.mjs --only dsh-sandbox,dsh-tools
 *   node scripts/host-snapshot.mjs --include-maps --include-baks
 *
 * 退出码：0 = 成功 / 1 = 用法或环境失败 / 3 = --pristine 但树已被打过补丁。
 *
 * 为什么默认拒收脏树：拿打过补丁的树当基线，等于把「我们的改动」记成「上游原文」，
 * 下一次 diff 全是噪声。--pristine 就是给 CI 用的那道门。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findAiBase, resolveAiBase } from "./host-baseline-lib.mjs";
import {
  buildTreeSnapshot, diffTreeSnapshots, isCleanSnapshot, readHostVersion,
  renderTreeDiff, TREE_SNAPSHOT_SCHEMA, walkHostTree,
} from "./host-snapshot-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_OUT = path.join(ROOT, "docs", "host-tree.json");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
function opt(n, d) {
  const i = argv.indexOf("--" + n);
  if (i < 0 || !argv[i + 1] || argv[i + 1].startsWith("--")) return d === undefined ? "" : d;
  return argv[i + 1];
}

function fail(msg, code) {
  console.error("[snapshot] " + msg);
  process.exit(code === undefined ? 1 : code);
}

const JSON_OUT = flag("--json");
const PRISTINE = flag("--pristine");
const INCLUDE_MAPS = flag("--include-maps");
const INCLUDE_BAKS = flag("--include-baks");
const ONLY_RAW = opt("only");
const ONLY = ONLY_RAW ? ONLY_RAW.split(",").map((s) => s.trim()).filter(Boolean) : null;

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (error) {
    fail("读不了快照 " + fp + "：" + error.message);
  }
}

function checkSchema(snap, fp) {
  if (!snap || snap.schema !== TREE_SNAPSHOT_SCHEMA || snap.kind !== "dsh-host-tree") {
    fail(fp + " 不是 host-tree 快照（schema=" + (snap && snap.schema) + " kind=" + (snap && snap.kind) + "）");
  }
  return snap;
}

/** --diff 模式：两份已存在的快照比对，不碰宿主。 */
function runDiff() {
  const iDiff = argv.indexOf("--diff");
  const given = [];
  for (let i = iDiff + 1; i < argv.length && given.length < 2; i += 1) {
    if (!argv[i].startsWith("--")) given.push(argv[i]);
  }
  if (given.length < 2) fail("--diff 需要两份快照文件：--diff a.json b.json");
  const a = checkSchema(readJson(path.resolve(given[0])), given[0]);
  const b = checkSchema(readJson(path.resolve(given[1])), given[1]);
  const diff = diffTreeSnapshots(a, b);
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(diff, null, 2) + "\n");
  } else {
    for (const line of renderTreeDiff(diff, { limit: Number(opt("limit", "40")) || 40 })) console.log(line);
    console.log("[snapshot] 结论 " + diff.verdict);
  }
  process.exit(diff.verdict === "unreliable" ? 1 : 0);
}

function runCapture() {
  const givenBase = opt("ai-base");
  const aiBase = givenBase ? resolveAiBase(givenBase) : findAiBase();
  if (!aiBase) {
    fail("没找到宿主安装。用 --ai-base <resources/app/dsh/node_modules/@deepseek-ai> 指定，或设 DSH_HOST_AI_BASE。");
  }
  const out = path.resolve(opt("out", DEFAULT_OUT));
  const host = readHostVersion(aiBase);
  const started = Date.now();
  const walked = walkHostTree(aiBase, { includeMaps: INCLUDE_MAPS, includeBaks: INCLUDE_BAKS, only: ONLY });
  const snap = buildTreeSnapshot({ aiBase, walked, host });
  const elapsed = Date.now() - started;
  const clean = isCleanSnapshot(snap);

  if (PRISTINE && !clean) {
    console.error("[snapshot] 树上有 " + snap.stats.purgeFiles + " 个文件带注入标记，拒收为基线");
    console.error("[snapshot] 干净的宿主请用 host-preview 装出来的 .tmp-preview/tree 当 --ai-base");
    process.exit(3);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snap, null, 2) + "\n");

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ host, stats: snap.stats, clean, out }, null, 2) + "\n");
  } else {
    console.log("[snapshot] 宿主 " + host.version + (host.name ? " (" + host.name + ")" : ""));
    console.log("[snapshot] 包 " + snap.stats.packages + " / 文件 " + snap.stats.files
      + " / " + (snap.stats.bytes / 1048576).toFixed(2) + "MB / 用了 " + elapsed + "ms");
    console.log("[snapshot] 干净树：" + (clean ? "是" : "否（" + snap.stats.purgeFiles + " 个文件带标记）"));
    console.log("[snapshot] 写入 " + out);
  }
  process.exit(0);
}

if (flag("--diff")) runDiff();
else runCapture();
