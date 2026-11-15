#!/usr/bin/env node
/**
 * restriction-census —— 限制面普查：新宿主里「还有哪些会拦人的地方我们没管」
 *
 * 用法 / usage:
 *   node scripts/restriction-census.mjs                        # 扫当前宿主，人读报告
 *   node scripts/restriction-census.mjs --ai-base <dir>         # 指定宿主（默认自动探测）
 *   node scripts/restriction-census.mjs --pristine              # 扫 .tmp-rehearse/asar-pristine 的解包原件
 *   node scripts/restriction-census.mjs --json out.json         # 机器可读（含 sites / spans 统计）
 *   node scripts/restriction-census.mjs --write-baseline        # 写 docs/restriction-census.json
 *   node scripts/restriction-census.mjs --baseline <file>       # 与另一份基线比（升级前后）
 *   node scripts/restriction-census.mjs --pattern deny-copy-en  # 只看某些形状（可重复）
 *   node scripts/restriction-census.mjs --limit 40              # 报告里未覆盖条目上限
 *
 * 退出码：0 = 没有未覆盖站点；1 = 有未覆盖站点；2 = 用法或环境失败。
 *
 * 为什么要「站点级」而不是「包级」：包级覆盖的判据是「这个包有补丁」，
 * 于是一个包里 5 个决策点只改 1 个也报 covered —— 86 条到底漏了多少就永远答不出来。
 * 这里把补丁的 needle 落到行号（same file ±WINDOW 行算覆盖），逐站点求交。
 *
 * 必须在 **未打补丁的原件** 上扫（--pristine）：打过的树上 needle 已被替换，
 * 覆盖映射会全部落空，未覆盖站点数会虚高。闸表核对踩过同一个坑。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findAiBase, resolveAiBase } from "./host-baseline-lib.mjs";
import { findShortCircuits } from "./chokepoints-lib.mjs";

/**
 * 有「满权早返回守卫」的包：只要守卫在，这些包里 sandbox 相关的分支运行时走不到，
 * 站点存在但不是候选。守卫本身每次现探测（findShortCircuits），不写死——上游删了守卫，
 * 这些站点会自动重新变成候选。plugin-manager 走的是审批而非 mode，故不在表内。
 */
const SHORT_CIRCUIT_PKGS = new Set([
  "dsh-bash-sandbox",
  "dsh-pwsh-sandbox",
  "dsh-ptc-runtime-node",
  "dsh-experimental-worktree",
  "dsh-experimental-client-ui-forge",
]);
import { CENSUS_SCHEMA, DENIAL_PATTERNS, scanSites, locateNeedle, markCovered, rankCandidates, diffCensus, summarize, renderCensusReport } from "./census-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_BASELINE = path.join(ROOT, "docs", "restriction-census.json");
const PRISTINE = path.join(ROOT, ".tmp-rehearse", "asar-pristine", "dsh", "node_modules", "@deepseek-ai");
const WINDOW = 15;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
function opt(n, d) {
  const i = argv.indexOf("--" + n);
  if (i < 0 || !argv[i + 1] || argv[i + 1].startsWith("--")) return d === undefined ? "" : d;
  return argv[i + 1];
}
function opts(n) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === "--" + n && argv[i + 1]) out.push(argv[i + 1]);
  return out;
}
function fail(msg) {
  console.error("[census] " + msg);
  process.exit(2);
}

const JSON_OUT = opt("json");
const WRITE_BASELINE = flag("--write-baseline");
const LIMIT = Number(opt("limit", "30")) || 30;
const PATTERN_FILTER = opts("pattern");
const givenBase = opt("ai-base") || (flag("--pristine") ? PRISTINE : "");
const aiBase = givenBase ? resolveAiBase(givenBase) : findAiBase();
if (!aiBase) fail("没找到宿主安装。用 --ai-base <.../@deepseek-ai> 或 --pristine。");
if (flag("--pristine") && !fs.existsSync(PRISTINE)) fail("没有解包原件：" + PRISTINE);

const norm = (p) => String(p || "").replace(/\\/g, "/");
const baseNorm = norm(aiBase).replace(/\/$/, "");

/**
 * 补丁 needle → 行号 spans。
 * 路径基准必须用 core.targetFiles(aiBase)：那是 apply 时真正会去写的表，
 * 自己在注册表里拼 rel 会漏掉「同一个 file 键对应多棵树」的情况。
 */
async function buildSpans() {
  const core = await import(new URL("../lib/core.js", import.meta.url).href);
  const files = core.targetFiles(aiBase);
  const patches = core.ALL_PATCHES || [];
  const spans = [];
  const note = { patches: patches.length, withFile: 0, needles: 0, located: 0, outside: 0, unreadable: 0 };
  const textCache = new Map();
  for (const p of patches) {
    // p.file 可能是数组（一条补丁同时挂多个 file 键）；只取单键会把这些补丁整条漏掉。
    const keys = Array.isArray(p.file) ? p.file : [p.file];
    const paths = [];
    for (const k of keys) {
      const v = files ? files[k] : null;
      if (!v) continue;
      for (const abs of (Array.isArray(v) ? v : [v])) paths.push(abs);
    }
    if (!paths.length) continue;
    note.withFile += 1;
    const list = paths;
    for (const abs of list) {
      const a = norm(abs);
      if (!a.startsWith(baseNorm + "/")) { note.outside += 1; continue; }
      const rel = a.slice(baseNorm.length + 1);
      let text = textCache.get(a);
      if (text === undefined) {
        try { text = fs.readFileSync(abs, "utf8"); } catch { text = null; }
        textCache.set(a, text);
      }
      if (text === null) { note.unreadable += 1; continue; }
      // 两种注册表写法都要认：老式 { patterns: [...], replace }，新式 { replacements: [{pattern, replace}] }。
      const needles = [];
      for (const pat of p.patterns || []) needles.push(pat);
      for (const rep of p.replacements || []) if (rep && rep.pattern != null) needles.push(rep.pattern);
      for (const needle of needles) {
        if (needle === undefined || needle === null) continue;
        note.needles += 1;
        const lines = locateNeedle(text, needle);
        if (!lines.length) continue;
        note.located += 1;
        // 一条 needle 命中多处时全部记上：替换会改所有命中
        for (const line of lines) spans.push({ id: p.name || String(p.id), rel, line });
      }
    }
  }
  return { spans, note };
}

function flatten(sites) {
  const out = [];
  for (const [pattern, list] of Object.entries(sites || {})) {
    for (const s of list) out.push(Object.assign({ pattern }, s));
  }
  return out;
}

function loadBaseline(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(doc.sites) ? doc.sites : null;
  } catch {
    return null;
  }
}

async function main() {
  const { spans, note } = await buildSpans();
  // --pattern 选的是「形状」（patternId），不是包名；包名过滤是 scanSites 的 only 参数，别混。
  const chosen = PATTERN_FILTER.length
    ? DENIAL_PATTERNS.filter((p) => PATTERN_FILTER.includes(p.id))
    : null;
  const raw = scanSites(aiBase, chosen ? { patterns: chosen } : {});
  const sites = flatten(raw);
  const guard = findShortCircuits(aiBase);
  const marked = sites.map((s) => {
    const pkg = String(s.rel || "").split("/")[0];
    const hit = SHORT_CIRCUIT_PKGS.has(pkg) ? guard.get(pkg) : null;
    return hit ? Object.assign({}, s, { shortCircuited: hit.rel + ":" + hit.line }) : s;
  });
  const covered = markCovered(marked, spans, { window: WINDOW });
  const ranked = rankCandidates(covered);
  const summary = summarize(ranked);
  const baselineFile = opt("baseline") || DEFAULT_BASELINE;
  const prev = loadBaseline(baselineFile);
  const diff = prev ? diffCensus(prev, ranked) : { added: [], removed: [], skipped: true };
  const report = renderCensusReport({ sites: ranked, summary, diff, limit: LIMIT });

  if (JSON_OUT) {
    const doc = {
      schema: CENSUS_SCHEMA,
      generatedAt: new Date().toISOString(),
      aiBase,
      window: WINDOW,
      spans: note,
      summary,
      diff,
      sites: ranked,
    };
    fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify(doc, null, 2) + "\n", "utf8");
    console.log("[census] 已写 " + JSON_OUT + "（" + ranked.length + " 站点 / 未覆盖 " + summary.uncovered + "）");
  }

  if (WRITE_BASELINE) {
    const doc = {
      schema: CENSUS_SCHEMA,
      generatedAt: new Date().toISOString(),
      aiBase,
      window: WINDOW,
      spans: note,
      summary,
      sites: ranked.map((s) => ({ pattern: s.pattern, rel: s.rel, line: s.line, text: s.text, coveredBy: s.coveredBy })),
    };
    fs.mkdirSync(path.dirname(DEFAULT_BASELINE), { recursive: true });
    fs.writeFileSync(DEFAULT_BASELINE, JSON.stringify(doc, null, 2) + "\n", "utf8");
    console.log("[census] 基线已写 " + DEFAULT_BASELINE);
  }

  if (!JSON_OUT) console.log(report);
  process.exit(summary.uncovered > 0 ? 1 : 0);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
