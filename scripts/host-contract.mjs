#!/usr/bin/env node
/**
 * host-contract —— 宿主契约检查：我们依赖的宿主服务 / 事件 / 导出还在不在
 *
 * 用法 / usage:
 *   node scripts/host-contract.mjs                   # 用自动探测到的宿主
 *   node scripts/host-contract.mjs --ai-base <dir>   # 指定宿主 @deepseek-ai 目录
 *   node scripts/host-contract.mjs --json             # 机器可读
 *   node scripts/host-contract.mjs --contract <file>  # 换一份契约
 *
 * 退出码：0 = 全部命中，1 = 有缺失，2 = 探测/用法失败。
 *
 * 只读：不改宿主任何文件。
 *
 * 与 host:status 的分工：host:status 看「补丁还能不能打上去」（文本匹配），
 * 这里看「我们调的宿主 API 还在不在」（符号契约）。宿主改名时前者照样绿，
 * 所以两者都要，判定不重叠。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkContract, loadContract, renderContract, scanHost, CONTRACT_SCHEMA,
} from "./host-contract-lib.mjs";
import { findAiBase, resolveAiBase } from "./host-baseline-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_CONTRACT = path.join(ROOT, "docs", "host-contract.json");

const argv = process.argv.slice(2);
function arg(name, fallback = "") {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}
const JSON_OUT = argv.includes("--json");
const CONTRACT_FILE = path.resolve(arg("contract") || DEFAULT_CONTRACT);

function fail(msg) {
  console.error(`[contract] ${msg}`);
  process.exit(2);
}

if (!fs.existsSync(CONTRACT_FILE)) {
  fail(`没有契约文件 ${path.relative(ROOT, CONTRACT_FILE).replace(/\\/g, "/")}`);
}

let contract;
try {
  contract = loadContract(CONTRACT_FILE);
} catch (e) {
  fail(`契约文件读不动: ${e.message}`);
}
if (contract.schema !== CONTRACT_SCHEMA) {
  console.error(`[contract] 契约 schema=${contract.schema} 与当前 ${CONTRACT_SCHEMA} 不同，请先迁移`);
}

const given = arg("ai-base");
const aiBase = given ? resolveAiBase(given) : findAiBase();
if (!aiBase) {
  fail(given
    ? `给的路径不是宿主 @deepseek-ai 目录: ${given}`
    : "没找到宿主安装。用 --ai-base <resources/app/dsh/node_modules/@deepseek-ai> 指定，或设 DSH_HOST_AI_BASE。");
}

const t0 = Date.now();
const scan = scanHost(aiBase);
const elapsed = Date.now() - t0;
const result = checkContract(contract, scan);

if (JSON_OUT) {
  console.log(JSON.stringify({
    aiBase,
    contractFile: CONTRACT_FILE,
    hostVersion: contract.hostVersion,
    capturedAt: contract.capturedAt,
    elapsedMs: elapsed,
    scannedFiles: scan.files.size,
    ok: result.ok,
    total: result.total,
    counts: result.counts,
    missing: result.missing,
    rows: result.rows,
  }, null, 2));
} else {
  console.log(renderContract(result));
  if (result.ok) console.log(`[contract] 扫描 ${scan.files.size} 个宿主文件 / ${elapsed}ms`);
}

process.exit(result.ok ? 0 : 1);
