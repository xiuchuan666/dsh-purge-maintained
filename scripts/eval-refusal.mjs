#!/usr/bin/env node
// 拒绝率评测 CLI：--plan 离线看计划，--run 调网关跑题，--check 离线闸门，--hash 打印题集哈希。
// 评分规则与阈值见 docs/eval/README.md；纯函数在 lib/eval-refusal.js。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TOLERANCE,
  aggregate,
  compareToBaseline,
  judge,
  loadProbes,
  medianScore,
  probeSetHash,
  scoreAnswer,
} from "../lib/eval-refusal.js";

const SCRIPT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_SAMPLES = 3;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_CONCURRENCY = 3;
const REPORT_SCHEMA = "dsh-eval-refusal/1";

const VALUE_FLAGS = new Set([
  "root",
  "out",
  "samples",
  "limit",
  "timeout",
  "model",
  "gateway",
  "system",
  "concurrency",
  "max-tokens",
  "baseline",
]);

class CliError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function fail(message, code) {
  throw new CliError(message, code);
}

function positiveInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error("--" + name + " 需要正整数，收到 " + value);
  return n;
}

function parseArgs(argv) {
  const args = {
    mode: null,
    help: false,
    root: SCRIPT_ROOT,
    out: null,
    samples: DEFAULT_SAMPLES,
    limit: null,
    timeout: DEFAULT_TIMEOUT_MS,
    model: "auto",
    gateway: process.env.EVAL_GATEWAY || "",
    system: "baseline",
    concurrency: DEFAULT_CONCURRENCY,
    maxTokens: DEFAULT_MAX_TOKENS,
    baseline: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error("无法识别的参数：" + token);
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    let value;
    if (eq >= 0) {
      value = token.slice(eq + 1);
    } else if (VALUE_FLAGS.has(key)) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--" + key + " 缺少值");
      i += 1;
    } else {
      value = true;
    }
    switch (key) {
      case "plan":
      case "run":
      case "check":
      case "hash":
        if (args.mode && args.mode !== key) {
          throw new Error("一次只能选一个模式：--plan / --run / --check / --hash");
        }
        args.mode = key;
        break;
      case "help":
        args.help = true;
        break;
      case "root":
        args.root = resolve(value);
        break;
      case "out":
        args.out = String(value);
        break;
      case "samples":
        args.samples = positiveInt(key, value);
        break;
      case "limit":
        args.limit = positiveInt(key, value);
        break;
      case "timeout":
        args.timeout = positiveInt(key, value);
        break;
      case "model":
        args.model = String(value);
        break;
      case "gateway":
        args.gateway = String(value);
        break;
      case "system":
        args.system = String(value);
        break;
      case "concurrency":
        args.concurrency = positiveInt(key, value);
        break;
      case "max-tokens":
        args.maxTokens = positiveInt(key, value);
        break;
      case "baseline":
        args.baseline = String(value);
        break;
      default:
        throw new Error("未知参数 --" + key);
    }
  }
  return args;
}

function usage() {
  console.log(
    [
      "拒绝率评测（离线计划 / 网关采样 / 离线闸门）",
      "",
      "用法：",
      "  node scripts/eval-refusal.mjs --plan [--limit N] [--samples N] [--model M] [--system baseline|<path>|none]",
      "  EVAL_GATEWAY=http://127.0.0.1:PORT node scripts/eval-refusal.mjs --run [--samples 3] [--limit N] [--timeout 30000]",
      "  node scripts/eval-refusal.mjs --check [--baseline docs/eval/baseline.json]",
      "  node scripts/eval-refusal.mjs --hash > docs/eval/probes.sha256",
      "",
      "公共参数：--root DIR（默认仓库根）、--out PATH（默认 docs/eval/<version>.json）、--gateway URL（默认 EVAL_GATEWAY）",
      "退出码：--check 0 ok / 1 warn / 2 fail / 3 缺文件或 hash 漂移；--run 0 完成 / 1 部分请求失败 / 3 参数或网关缺失",
    ].join("\n"),
  );
}

function repoPaths(root) {
  return {
    probes: join(root, "docs", "eval", "probes.jsonl"),
    hash: join(root, "docs", "eval", "probes.sha256"),
    packageJson: join(root, "package.json"),
  };
}

function display(root, path) {
  const rel = relative(root, path).replaceAll("\\", "/");
  if (!rel || rel.startsWith("../") || isAbsolute(rel)) return path.replaceAll("\\", "/");
  return rel;
}

function readProbes(ctx) {
  const paths = repoPaths(ctx.root);
  if (!existsSync(paths.probes)) {
    fail("缺少 " + display(ctx.root, paths.probes) + "；先把题集固化为 docs/eval/probes.jsonl", 3);
  }
  try {
    return loadProbes(readFileSync(paths.probes, "utf8"));
  } catch (error) {
    fail("题集解析失败：" + error.message, 3);
  }
}

function readVersion(ctx) {
  const path = repoPaths(ctx.root).packageJson;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("读取 " + display(ctx.root, path) + " 失败：" + error.message, 3);
  }
  if (!pkg || typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+/.test(pkg.version)) {
    fail("package.json 没有合法 version", 3);
  }
  return pkg.version;
}

function reportPath(ctx, version) {
  if (!ctx.args.out) return join(ctx.root, "docs", "eval", version + ".json");
  return isAbsolute(ctx.args.out) ? ctx.args.out : resolve(ctx.root, ctx.args.out);
}

function chatEndpoint(gateway) {
  const base = String(gateway || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v1$/.test(base)) return base + "/chat/completions";
  return base + "/v1/chat/completions";
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

async function resolveSystem(ctx) {
  const spec = String(ctx.args.system || "baseline");
  if (spec === "none") return { spec: "none", text: "" };
  if (spec === "baseline") {
    try {
      const { createDecipheriv } = await import("node:crypto");
      const { inflateSync } = await import("node:zlib");
      const { mixKey } = await import("../lib/table-key.js");
      const { SLOT, MASK, TAG, IV } = await import("../lib/asset-table.js");
      const decipher = createDecipheriv("aes-256-gcm", mixKey(MASK), Buffer.from(IV, "base64"));
      decipher.setAuthTag(Buffer.from(TAG, "base64"));
      const text = inflateSync(
        Buffer.concat([decipher.update(Buffer.from(SLOT, "base64")), decipher.final()]),
      ).toString("utf8");
      if (!text) fail("加密槽解封结果为空", 3);
      return { spec: "baseline", text };
    } catch (error) {
      if (error instanceof CliError) throw error;
      fail("baseline 解封失败：" + (error && error.message ? error.message : String(error)), 3);
    }
  }
  const path = isAbsolute(spec) ? spec : resolve(ctx.root, spec);
  if (!existsSync(path)) fail("system 文件不存在：" + display(ctx.root, path), 3);
  return { spec: display(ctx.root, path), text: readFileSync(path, "utf8") };
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

async function askOnce(endpoint, systemText, prompt, args) {
  const messages = [];
  if (systemText) messages.push({ role: "system", content: systemText });
  messages.push({ role: "user", content: prompt });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: args.model, messages, max_tokens: args.maxTokens }),
    signal: AbortSignal.timeout(args.timeout),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error("HTTP " + response.status + " " + detail);
  }
  const payload = await response.json();
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  let content = choice && choice.message ? choice.message.content : choice && choice.text;
  if (Array.isArray(content)) {
    content = content
      .map((part) => (typeof part === "string" ? part : part && part.text ? part.text : ""))
      .join("");
  }
  if (typeof content !== "string") content = content == null ? "" : String(content);
  return content.trim();
}

function runHash(ctx) {
  const probes = readProbes(ctx);
  process.stdout.write(probeSetHash(probes) + "  probes.jsonl\n");
  return 0;
}

async function runPlan(ctx) {
  const probes = readProbes(ctx);
  const selected = ctx.args.limit ? probes.slice(0, ctx.args.limit) : probes;
  if (!selected.length) fail("--limit 选不到题", 3);
  const hash = probeSetHash(probes);
  const version = readVersion(ctx);
  const system = await resolveSystem(ctx);
  const endpoint = chatEndpoint(ctx.args.gateway);
  const out = reportPath(ctx, version);
  console.log("[eval-refusal] plan (offline, no requests)");
  console.log("root: " + ctx.root);
  console.log("version: " + version);
  console.log(
    "probes: " +
      display(ctx.root, repoPaths(ctx.root).probes) +
      " (" +
      probes.length +
      (selected.length !== probes.length ? ", limit " + selected.length : "") +
      ")",
  );
  console.log("hash: " + hash);
  console.log("samples: " + ctx.args.samples + " => " + selected.length * ctx.args.samples + " requests");
  console.log("gateway: " + (endpoint || "(未设置 EVAL_GATEWAY；--run 会以 3 退出)"));
  console.log("model: " + ctx.args.model);
  console.log("system: " + system.spec + " (" + system.text.length + " chars)");
  console.log("out: " + display(ctx.root, out));
  console.log("probes:");
  for (const probe of selected) {
    console.log(
      "  " +
        String(probe.id).padStart(3, " ") +
        "  " +
        probe.cat +
        "/" +
        probe.sub +
        "  " +
        probe.expect +
        "  " +
        probe.prompt,
    );
  }
  return 0;
}

async function runRun(ctx) {
  const endpoint = chatEndpoint(ctx.args.gateway);
  if (!endpoint) fail("--run 需要网关：设置 EVAL_GATEWAY 或传 --gateway <url>", 3);
  const probes = readProbes(ctx);
  const selected = ctx.args.limit ? probes.slice(0, ctx.args.limit) : probes;
  if (!selected.length) fail("--limit 选不到题", 3);
  const version = readVersion(ctx);
  const system = await resolveSystem(ctx);
  const out = reportPath(ctx, version);
  const started = Date.now();
  const rows = selected.map((probe) => ({ ...probe, answers: new Array(ctx.args.samples) }));
  const jobs = [];
  rows.forEach((row, probeIndex) => {
    for (let sample = 0; sample < ctx.args.samples; sample += 1) jobs.push({ probeIndex, sample });
  });
  let cursor = 0;
  let errors = 0;
  const total = jobs.length;
  process.stdout.write("[eval-refusal] run " + total + " requests -> " + display(ctx.root, out) + "\n");

  async function worker() {
    while (true) {
      const job = jobs[cursor];
      cursor += 1;
      if (!job) return;
      const row = rows[job.probeIndex];
      let entry;
      try {
        const answer = await askOnce(endpoint, system.text, row.prompt, ctx.args);
        const verdict = scoreAnswer(row, answer);
        entry = {
          score: verdict.score,
          chars: answer.length,
          answer,
          reason: verdict.reason,
          signals: verdict.signals,
          refusalHits: verdict.refusalHits,
        };
      } catch (error) {
        errors += 1;
        const message = error && error.message ? error.message : String(error);
        entry = {
          score: 0,
          chars: 0,
          answer: "__ERR__ " + message.slice(0, 300),
          error: message.slice(0, 500),
          reason: "transport-error",
          signals: [],
          refusalHits: [],
        };
      }
      row.answers[job.sample] = entry;
      process.stdout.write(".");
    }
  }

  const workers = Math.min(ctx.args.concurrency, jobs.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  process.stdout.write("\n");
  if (errors === total) {
    fail("全部 " + total + " 次请求失败；未写报告（检查网关地址与模型名）", 3);
  }

  const scored = rows.map((row) => {
    const scores = row.answers.map((answer) => answer.score);
    return {
      id: row.id,
      cat: row.cat,
      sub: row.sub,
      prompt: row.prompt,
      expect: row.expect,
      score: medianScore(scores),
      scores,
      answers: row.answers,
    };
  });
  const agg = aggregate(scored.map((row) => ({ id: row.id, score: row.score })));
  const verdict = judge(agg.total);
  const report = {
    schema: REPORT_SCHEMA,
    version,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    gateway: redactUrl(endpoint),
    model: ctx.args.model,
    system: { spec: system.spec, chars: system.text.length },
    samples: ctx.args.samples,
    timeoutMs: ctx.args.timeout,
    limited: selected.length !== probes.length,
    probeCount: scored.length,
    probesHash: probeSetHash(probes),
    errors,
    total: agg.total,
    max: agg.max,
    mean: agg.mean,
    aggregate: agg,
    judge: verdict,
    rows: scored,
  };
  writeReport(out, report);
  console.log("[eval-refusal] run done in " + ((Date.now() - started) / 1000).toFixed(1) + "s");
  console.log(
    "total: " +
      agg.total.toFixed(2) +
      "/10  judge=" +
      verdict +
      "  requests=" +
      total +
      "  errors=" +
      errors,
  );
  console.log("out: " + display(ctx.root, out));
  return errors > 0 ? 1 : 0;
}

function runCheck(ctx) {
  const paths = repoPaths(ctx.root);
  const probes = readProbes(ctx);
  const hash = probeSetHash(probes);

  if (!existsSync(paths.hash)) fail("缺少 " + display(ctx.root, paths.hash), 3);
  const recorded = readFileSync(paths.hash, "utf8").trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(recorded)) {
    fail("hash 文件格式不对：期望 16 位 sha256 前缀", 3);
  }
  if (recorded !== hash) {
    fail("题集漂移：probes.jsonl=" + hash + "，probes.sha256=" + recorded, 3);
  }

  const version = readVersion(ctx);
  const path = reportPath(ctx, version);
  if (!existsSync(path)) fail("缺少评测报告 " + display(ctx.root, path) + "；先跑 --run", 3);
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("报告不是合法 JSON：" + error.message, 3);
  }
  if (!report || typeof report !== "object") fail("报告结构不对", 3);
  if (report.version !== version) {
    fail("报告版本 " + report.version + " 与 package.json " + version + " 不一致", 3);
  }
  if (!report.probesHash) fail("报告缺少 probesHash，无法证明跑的是当前题集", 3);
  if (String(report.probesHash).toLowerCase() !== hash) {
    fail("报告记录的题集 hash " + report.probesHash + " 与当前 " + hash + " 不一致", 3);
  }
  if (report.limited === true) fail("报告来自 --limit 抽样运行，不是全量闸门", 3);
  if (!Array.isArray(report.rows) || report.rows.length === 0) fail("报告没有 rows", 3);
  if (Number(report.errors) > 0) {
    fail("报告记录 " + report.errors + " 次请求失败，运行不完整", 3);
  }

  const agg = aggregate(report.rows.map((row) => ({ id: row.id, score: row.score })));
  if (agg.count === 0) fail("报告 rows 没有有效分数", 3);
  const verdict = judge(agg.total);
  let exit = verdict === "ok" ? 0 : verdict === "warn" ? 1 : 2;
  let baselineLine = "baseline: (未指定 --baseline，跳过)";

  if (ctx.args.baseline) {
    const basePath = isAbsolute(ctx.args.baseline)
      ? ctx.args.baseline
      : resolve(ctx.root, ctx.args.baseline);
    if (!existsSync(basePath)) fail("缺少 baseline " + display(ctx.root, basePath), 3);
    let baseReport;
    try {
      baseReport = JSON.parse(readFileSync(basePath, "utf8"));
    } catch (error) {
      fail("baseline 不是合法 JSON：" + error.message, 3);
    }
    const cmp = compareToBaseline(agg, baseReport, { tolerance: DEFAULT_TOLERANCE });
    if (cmp.status === "unknown") fail("baseline 没有可比较的 total", 3);
    baselineLine =
      "baseline: " +
      cmp.baseline +
      " -> " +
      cmp.current +
      " (delta " +
      (cmp.delta >= 0 ? "+" : "") +
      cmp.delta +
      ", " +
      cmp.status +
      ", tolerance " +
      cmp.tolerance +
      ")";
    if (cmp.status === "fail") exit = Math.max(exit, 2);
    else if (cmp.status === "warn") exit = Math.max(exit, 1);
  }

  console.log("[eval-refusal] check (offline)");
  console.log("probes: " + display(ctx.root, paths.probes) + " (" + probes.length + ")  hash=" + hash);
  console.log("report: " + display(ctx.root, path));
  console.log(
    "total: " +
      agg.total.toFixed(2) +
      "/10  judge=" +
      verdict +
      "  count=" +
      agg.count +
      "  mean=" +
      agg.mean.toFixed(3) +
      "  errors=" +
      (report.errors || 0),
  );
  console.log(baselineLine);
  console.log("[eval-refusal] " + (exit === 0 ? "PASS" : exit === 1 ? "WARN" : "FAIL") + " (exit " + exit + ")");
  return exit;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error("[eval-refusal] " + error.message);
    return 3;
  }
  if (args.help) {
    usage();
    return 0;
  }
  if (!args.mode) {
    usage();
    return 3;
  }
  const ctx = { args, root: args.root };
  try {
    if (args.mode === "hash") return runHash(ctx);
    if (args.mode === "plan") return await runPlan(ctx);
    if (args.mode === "run") return await runRun(ctx);
    return runCheck(ctx);
  } catch (error) {
    if (error instanceof CliError) {
      console.error("[eval-refusal] " + error.message);
      return error.code;
    }
    console.error("[eval-refusal] " + (error && error.stack ? error.stack : String(error)));
    return 3;
  }
}

const code = await main();
process.exit(code);
