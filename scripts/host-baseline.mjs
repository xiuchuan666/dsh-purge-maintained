#!/usr/bin/env node
/**
 * host-baseline —— 宿主适配基线：升级后一条命令看清「哪些补丁废了」
 *
 * 用法 / usage:
 *   node scripts/host-baseline.mjs --capture            # 把当前宿主状态记成基线
 *   node scripts/host-baseline.mjs                       # 与基线比对（默认动作）
 *   node scripts/host-baseline.mjs --ai-base <dir>       # 指定宿主（默认自动探测）
 *   node scripts/host-baseline.mjs --pad                 # 失效时打印每条 pattern 命中情况
 *   node scripts/host-baseline.mjs --baseline <file>     # 换一份基线文件
 *
 * 退出码：0 = ok/review，1 = broken（有补丁从可用跌成 drifted），2 = 用法/探测失败。
 *
 * 只读：不改宿主任何文件。补丁分类全部来自 verify-target.mjs 的既有判定，
 * 这里不再维护第二份平行逻辑。宿主契约（我们调的 API 还在不在）来自
 * host-contract-lib.mjs，同样只合并 verdict、不重算。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildSnapshot, diffSnapshots, findAiBase, mergeVerdicts, renderDiff, resolveAiBase, SNAPSHOT_SCHEMA,
} from "./host-baseline-lib.mjs";
import { checkContract, loadContract, scanHost } from "./host-contract-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_BASELINE = path.join(ROOT, "docs", "host-baseline.json");
const DEFAULT_CONTRACT = path.join(ROOT, "docs", "host-contract.json");

const argv = process.argv.slice(2);
function arg(name, fallback = "") {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}
const CAPTURE = argv.includes("--capture");
const PAD = argv.includes("--pad");
const JSON_OUT = argv.includes("--json");
const BASELINE_FILE = path.resolve(arg("baseline") || DEFAULT_BASELINE);

function fail(msg) {
  console.error(`[host] ${msg}`);
  process.exitCode = 2;
  process.exit(2);
}

const core = await import(new URL("../lib/core.js", import.meta.url).href);

const given = arg("ai-base");
const aiBase = given ? resolveAiBase(given) : findAiBase();
if (!aiBase) {
  fail(given
    ? `给的路径不是宿主 @deepseek-ai 目录: ${given}`
    : "没找到宿主安装。用 --ai-base <resources/app/dsh/node_modules/@deepseek-ai> 指定，或设 DSH_HOST_AI_BASE。");
}

/** 借 verify-target 做分类，避免两处判定逻辑分叉。--pad 时把它那张表直接透出来。 */
function probe() {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-host-")), "probe.json");
  const args = [path.join(HERE, "verify-target.mjs"), "--ai-base", aiBase, "--json", tmp];
  if (PAD) args.push("--pad");
  const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", stdio: PAD ? "inherit" : "pipe" });
  if (!fs.existsSync(tmp)) {
    if (!PAD) {
      process.stderr.write(res.stdout || "");
      process.stderr.write(res.stderr || "");
    }
    fail("verify-target 没有产出结果，先单独跑一次看报错");
  }
  const parsed = JSON.parse(fs.readFileSync(tmp, "utf8"));
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  return parsed;
}

const probeOut = probe();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const snapshot = buildSnapshot({
  host: core.readHostVersion(aiBase),
  aiBase,
  files: core.targetFiles(aiBase),
  rows: probeOut.rows,
  packageVersion: pkg.version,
});

if (CAPTURE) {
  fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
  const rel = path.relative(ROOT, BASELINE_FILE).replace(/\\/g, "/");
  console.log(`[host] 基线已写入 ${rel}`);
  console.log(`[host] host=${snapshot.host.version} patches=${snapshot.summary.patches} `
    + `settled=${snapshot.summary.settled} would-apply=${snapshot.summary.wouldApply} `
    + `drifted=${snapshot.summary.drifted} no-file=${snapshot.summary.noFile} na=${snapshot.summary.na}`);
  console.log(`[host] 目标文件 ${Object.keys(snapshot.files).length} 个已记录指纹`);
  process.exitCode = 0;
} else {
  if (!fs.existsSync(BASELINE_FILE)) {
    fail(`没有基线文件 ${path.relative(ROOT, BASELINE_FILE).replace(/\\/g, "/")}，先跑 --capture`);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  if (baseline.schema !== SNAPSHOT_SCHEMA) {
    console.error(`[host] 基线 schema=${baseline.schema} 与当前 ${SNAPSHOT_SCHEMA} 不同，请重新 --capture`);
  }
  const diff = diffSnapshots(baseline, snapshot);

  // 契约：宿主把这些 API 改名/删掉时，补丁照样能打上去，所以必须单算一遍。
  // 契约文件缺失不算破——有人可能就想只查补丁；但要在输出里说清楚没查。
  let contract = null;
  let contractSkip = "";
  const contractFile = path.resolve(arg("contract") || DEFAULT_CONTRACT);
  if (!fs.existsSync(contractFile)) {
    contractSkip = "未找到 docs/host-contract.json，本次只查补丁";
  } else {
    try {
      contract = checkContract(loadContract(contractFile), scanHost(aiBase));
    } catch (e) {
      contractSkip = `契约检查失败: ${e.message}`;
    }
  }

  const verdict = mergeVerdicts(diff.verdict, contract);
  if (JSON_OUT) {
    console.log(JSON.stringify({
      baselineFile: BASELINE_FILE,
      baselineAt: baseline.capturedAt,
      verdict,
      diff,
      contract: contract ? { ok: contract.ok, total: contract.total, counts: contract.counts, missing: contract.missing } : null,
      contractSkip,
    }, null, 2));
  } else {
    console.log(renderDiff(diff, { contract }));
    if (contractSkip) console.log(`[host] ${contractSkip}`);
  }
  process.exitCode = verdict === "broken" ? 1 : 0;
}
