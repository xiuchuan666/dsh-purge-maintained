#!/usr/bin/env node
/**
 * scan-chokepoints —— 结构化拦点扫描：2520 个文件 → 一页能看完的候选清单
 *
 * 用法 / usage:
 *   node scripts/scan-chokepoints.mjs                      # 扫当前宿主，人读报告
 *   node scripts/scan-chokepoints.mjs --ai-base <dir>       # 指定宿主
 *   node scripts/scan-chokepoints.mjs --json out.json       # 机器可读
 *   node scripts/scan-chokepoints.mjs --write-baseline      # 把本次形状统计写进 docs/choke-baseline.json
 *   node scripts/scan-chokepoints.mjs --baseline <file>     # 与另一份形状基线比（升级前后对比）
 *   node scripts/scan-chokepoints.mjs --dump <file>         # 用已存好的 dump-config（默认现场跑一次）
 *   node scripts/scan-chokepoints.mjs --no-dump             # 跳过 dump-config，只做形状扫描
 *   node scripts/scan-chokepoints.mjs --profile web         # dump-config 用哪个 profile
 *   node scripts/scan-chokepoints.mjs --all                 # 连「不在 dump 里 / disabled」的也列出来
 *   node scripts/scan-chokepoints.mjs --sites               # 站点级报告：每个决策点是否被补丁覆盖
 *
 * 退出码：0 = 没有真缺口 / 1 = 有未覆盖且会加载的拦点 / 2 = 用法或环境失败。
 *
 * 为什么要和 dump-config 求交：宿主树里有 320 个包，profile 实际加载的不到 210 条 id。
 * 只看形状会把实验包、客户端包、桌面外壳依赖全算成新闸门 —— 那正是关键词扫描
 * 得到 1007 个结果的原因。求交之后剩下的才是「真的会在运行时拦人、而我们没管」的。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findAiBase, resolveAiBase } from "./host-baseline-lib.mjs";
import {
  CHOKE_SCHEMA, correlate, diffShapes, findGaps, parseDumpConfig, renderChokeReport,
  findShortCircuits, scanShapes, summarizeHits,
  sitesOf, coverageOf, findSiteGaps, renderSiteReport,
} from "./chokepoints-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_BASELINE = path.join(ROOT, "docs", "choke-baseline.json");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
function opt(n, d) {
  const i = argv.indexOf("--" + n);
  if (i < 0 || !argv[i + 1] || argv[i + 1].startsWith("--")) return d === undefined ? "" : d;
  return argv[i + 1];
}
function fail(msg) {
  console.error("[choke] " + msg);
  process.exit(2);
}

const JSON_OUT = opt("json");
const NO_DUMP = flag("--no-dump");
const SHOW_ALL = flag("--all");
const WRITE_BASELINE = flag("--write-baseline");
const PROFILE = opt("profile", "web");
const LIMIT = Number(opt("limit", "30")) || 30;
const SITES = flag("--sites");
const givenBase = opt("ai-base");
const aiBase = givenBase ? resolveAiBase(givenBase) : findAiBase();
if (!aiBase) fail("没找到宿主安装。用 --ai-base <.../@deepseek-ai> 指定，或设 DSH_HOST_AI_BASE。");

/**
 * 已被补丁覆盖的包集合。
 * 来源是 lib/core.js 的 targetFiles()：它给出每个补丁键对应的绝对路径，
 * 取相对 aiBase 的第一段就是包名。这比在补丁注册表里手抄包名可靠，
 * 因为 targetFiles 是 apply 时真正会去写的那张表。
 */
async function coveredPackages() {
  const core = await import(new URL("../lib/core.js", import.meta.url).href);
  const set = new Set();
  let files;
  try {
    files = core.targetFiles(aiBase);
  } catch (error) {
    console.error("[choke] targetFiles 失败，覆盖集按空处理：" + error.message);
    return set;
  }
  const norm = (p) => String(p || "").replace(/\\/g, "/");
  const base = norm(aiBase).replace(/\/$/, "");
  for (const val of Object.values(files || {})) {
    for (const fp of Array.isArray(val) ? val : [val]) {
      const abs = norm(fp);
      if (!abs.startsWith(base + "/")) continue;
      const pkg = abs.slice(base.length + 1).split("/")[0];
      if (pkg.startsWith("dsh-")) set.add(pkg);
    }
  }
  return set;
}

/**
 * 现场跑一次 --dump-config。
 * 它不启动宿主、不碰状态，秒级返回；但要在宿主自己的 bin 上跑，
 * 所以路径从 aiBase 往里推：<aiBase>/dsh/lib/bin.js。
 */
function dumpConfig() {
  const bin = path.join(aiBase, "dsh", "lib", "bin.js");
  if (!fs.existsSync(bin)) return { ok: false, why: "找不到 " + bin };
  const res = spawnSync(process.execPath, [bin, "--profile", PROFILE, "--dump-config"], {
    encoding: "utf8",
    timeout: 180000,
    env: Object.assign({}, process.env, { DSH_HOME: process.env.DSH_HOME || path.join(os.homedir(), ".dsh") }),
  });
  if (res.status !== 0 || !res.stdout) {
    return { ok: false, why: "dump-config 退出码 " + res.status + "：" + String(res.stderr || "").slice(0, 300) };
  }
  return { ok: true, text: res.stdout };
}

/**
 * 形状基线：只存 (shape, pkg) → 命中数。
 * 不存行号不存文本 —— 那些每次升级都会变，存了只会制造伪差异。
 */
function toBaseline(hits) {
  const counts = {};
  for (const [shape, list] of Object.entries(hits)) {
    for (const h of list) {
      const pkg = h.rel.split("/")[0];
      const k = shape + "|" + pkg;
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  return counts;
}

/** 把基线里的 counts 还原成 diffShapes 能吃的形状（只需要 rel 的第一段与条数）。 */
function fromBaseline(counts) {
  const hits = {};
  for (const [k, n] of Object.entries(counts || {})) {
    const [shape, pkg] = k.split("|");
    if (!shape || !pkg) continue;
    if (!hits[shape]) hits[shape] = [];
    for (let i = 0; i < n; i += 1) hits[shape].push({ rel: pkg + "/-", line: 0, text: "" });
  }
  return hits;
}

/**
 * 在文本里定位 needle 出现的行号（1-based）。string 用逐行 includes，RegExp 用逐行 test。
 * 同一补丁可能命中多行；最多取 200 行，避免病态正则刷屏。
 */
function lineOfIndex(text, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

function locateNeedleInText(text, needle) {
  const out = [];
  const t = String(text == null ? "" : text);
  if (needle == null) return out;
  if (typeof needle === "string") {
    if (!needle) return out;
    let from = 0;
    while (out.length < 200) {
      const at = t.indexOf(needle, from);
      if (at < 0) break;
      out.push(lineOfIndex(t, at));
      from = at + Math.max(1, needle.length);
    }
    return out;
  }
  if (needle instanceof RegExp) {
    const flags = needle.flags.includes("g") ? needle.flags : needle.flags + "g";
    const re = new RegExp(needle.source, flags);
    let m;
    while (out.length < 200 && (m = re.exec(t)) !== null) {
      out.push(lineOfIndex(t, m.index));
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return out;
}

/**
 * 从补丁注册表推「站点 span」：每个补丁的每条 replacement pattern 在目标文件里命中的行号。
 * 结构对齐 restriction-census.buildSpans，但这里内联实现，只产出 [{ id, rel, line }]。
 */
async function buildSpans() {
  const core = await import(new URL("../lib/core.js", import.meta.url).href);
  let files;
  let patches;
  try {
    files = core.targetFiles(aiBase);
    patches = core.ALL_PATCHES || [];
  } catch (error) {
    console.error("[choke] 读 targetFiles/ALL_PATCHES 失败，站点 span 按空处理：" + error.message);
    return { spans: [], note: { patches: 0, spans: 0 } };
  }
  const norm = (p) => String(p || "").replace(/\\/g, "/");
  const base = norm(aiBase).replace(/\/$/, "");
  const cache = new Map();
  const spans = [];
  const note = { patches: patches.length, files: 0, needles: 0, located: 0, markers: 0, markerLocated: 0, spans: 0 };
  for (const p of patches) {
    const keys = Array.isArray(p.file) ? p.file : [p.file];
    for (const key of keys) {
      const val = files ? files[key] : null;
      if (!val) continue;
      for (const absRaw of Array.isArray(val) ? val : [val]) {
        const abs = norm(absRaw);
        if (!abs.startsWith(base + "/")) continue;
        const rel = abs.slice(base.length + 1);
        let text = cache.get(abs);
        if (text === undefined) {
          try { text = fs.readFileSync(abs, "utf8"); } catch { text = null; }
          cache.set(abs, text);
        }
        if (text === null) continue;
        note.files += 1;
        for (const rep of p.replacements || []) {
          const needle = rep && rep.pattern;
          if (needle == null) continue;
          note.needles += 1;
          const lines = locateNeedleInText(text, needle);
          if (!lines.length) continue;
          note.located += 1;
          const id = p.name || String(p.id);
          for (const line of lines) spans.push({ id, rel, line });
        }
        for (const mk of p.markers || []) {
          if (typeof mk !== "string" || !mk) continue;
          note.markers += 1;
          const mlines = locateNeedleInText(text, mk);
          if (!mlines.length) continue;
          note.markerLocated += 1;
          const mid = p.name || String(p.id);
          for (const line of mlines) spans.push({ id: mid, rel, line });
        }
      }
    }
  }
  note.spans = spans.length;
  return { spans, note };
}

/** 站点基线：line-agnostic 的 (shape, rel) → 计数，与 toBaseline 同理去掉易变行号。 */
function siteCensusOf(sites) {
  const counts = {};
  for (const s of sites) {
    const k = s.shape + "|" + s.rel;
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

/**
 * --sites 站点级报告：命中展开成站点 → 用补丁 span 标覆盖 → 分流缺口 → 中文报告。
 * 不加 --sites 时完全不走这里，默认输出逐字节不变。
 */
async function runSites({ covered, hits }) {
  const spanned = await buildSpans();
  const sites = sitesOf(hits);
  const coveredSites = coverageOf(sites, spanned.spans, { window: 15 });
  const shortCircuits = findShortCircuits(aiBase);
  const upstream = Object.fromEntries([...covered].map((p) => [p, true]));
  const { gaps, watch, ignored } = findSiteGaps(coveredSites, { shortCircuits, upstream });

  const byMap = new Map();
  for (const s of coveredSites) {
    const cur = byMap.get(s.pkg) || { pkg: s.pkg, sites: 0, covered: 0, uncovered: 0 };
    cur.sites += 1;
    if (s.coveredBy != null) cur.covered += 1;
    else cur.uncovered += 1;
    byMap.set(s.pkg, cur);
  }
  const byPkg = [...byMap.values()].sort((a, b) =>
    b.uncovered - a.uncovered || b.sites - a.sites || (a.pkg < b.pkg ? -1 : 1));
  const coveredCount = coveredSites.filter((s) => s.coveredBy != null).length;
  const siteSummary = {
    total: coveredSites.length,
    covered: coveredCount,
    uncovered: coveredSites.length - coveredCount,
    byPkg,
    spans: spanned.note,
  };

  const report = renderSiteReport({ gaps, watch, ignored, summary: siteSummary, limit: LIMIT });

  if (WRITE_BASELINE) {
    const baselineFile = path.resolve(opt("baseline", DEFAULT_BASELINE));
    let doc = {};
    if (fs.existsSync(baselineFile)) {
      try { doc = JSON.parse(fs.readFileSync(baselineFile, "utf8")); } catch (error) {
        console.error("[choke] 基线读不了，站点普查仍写入新文件：" + error.message);
      }
    }
    doc.schema = CHOKE_SCHEMA;
    doc.kind = "dsh-choke-baseline";
    doc.capturedAt = new Date().toISOString();
    doc.profile = PROFILE;
    doc.aiBase = aiBase.replace(/\\/g, "/");
    if (!doc.shapes) doc.shapes = summarizeHits(hits).map((s) => ({ shape: s.shape, total: s.total, files: s.files }));
    if (!doc.counts) doc.counts = toBaseline(hits);
    doc.siteCensus = siteCensusOf(coveredSites);
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, JSON.stringify(doc, null, 2) + "\n");
    console.log("[choke:sites] 站点普查写入 " + baselineFile + "（siteCensus " + Object.keys(doc.siteCensus).length + " 组）");
  }

  if (JSON_OUT) {
    const payload = {
      aiBase,
      profile: PROFILE,
      mode: "sites",
      scannedAt: new Date().toISOString(),
      spans: spanned.note,
      summary: siteSummary,
      sites: coveredSites,
      gaps,
      watch,
      ignored: SHOW_ALL ? ignored : undefined,
    };
    fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(payload, null, 2) + "\n");
  }

  console.log(report);
  if (gaps.length > 0) {
    console.log("[choke:sites] 结论：有 " + gaps.length + " 个站点未覆盖且会加载，需要人工判断是否加补丁");
  } else {
    console.log("[choke:sites] 结论：没有未覆盖的站点");
  }
  process.exit(gaps.length > 0 ? 1 : 0);
}

async function main() {
  const covered = await coveredPackages();
  const hits = scanShapes(aiBase);
  const summary = summarizeHits(hits);

  if (SITES) return runSites({ covered, hits });

  let dump = null;
  let dumpNote = "";
  const dumpFile = opt("dump");
  if (NO_DUMP) {
    dumpNote = "按 --no-dump 跳过（无法区分「会加载」与「装了没用」）";
  } else if (dumpFile) {
    try {
      dump = parseDumpConfig(fs.readFileSync(path.resolve(dumpFile), "utf8"));
    } catch (error) {
      fail("读不了 dump 文件 " + dumpFile + "：" + error.message);
    }
  } else {
    const got = dumpConfig();
    if (got.ok) dump = parseDumpConfig(got.text);
    else dumpNote = "dump-config 失败，按全树计算：" + got.why;
  }

  const shortCircuits = findShortCircuits(aiBase);
  const rows = dump
    ? correlate(hits, dump, covered, shortCircuits)
    : correlate(hits, { entries: [] }, covered, shortCircuits);
  const { gaps, watch, targets, ignored } = dump
    ? findGaps(rows)
    : {
      gaps: [],
      watch: [],
      targets: [],
      ignored: rows.map((r) => Object.assign({}, r, { reason: "没有 dump-config，无法判断是否加载" })),
    };

  const baselineFile = path.resolve(opt("baseline", DEFAULT_BASELINE));
  let diff = null;
  let baseline = null;
  if (fs.existsSync(baselineFile)) {
    try {
      baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
    } catch (error) {
      console.error("[choke] 基线读不了，跳过对比：" + error.message);
    }
  }
  if (baseline && baseline.counts) diff = diffShapes(fromBaseline(baseline.counts), hits);

  if (WRITE_BASELINE) {
    const out = {
      schema: CHOKE_SCHEMA,
      kind: "dsh-choke-baseline",
      capturedAt: new Date().toISOString(),
      profile: PROFILE,
      aiBase: aiBase.replace(/\\/g, "/"),
      shapes: summary.map((s) => ({ shape: s.shape, total: s.total, files: s.files })),
      counts: toBaseline(hits),
    };
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, JSON.stringify(out, null, 2) + "\n");
    console.log("[choke] 形状基线写入 " + baselineFile + "（" + Object.keys(out.counts).length + " 组）");
  }

  const report = renderChokeReport({ gaps, watch, targets, ignored, summary, diff, limit: LIMIT });
  if (dump && dumpNote) report.unshift("[choke] " + dumpNote);
  if (!dump) report.unshift("[choke] 注意：" + (dumpNote || "没有 dump-config"));

  const payload = {
    aiBase,
    profile: PROFILE,
    scannedAt: new Date().toISOString(),
    dump: dump ? { sections: dump.sections, entries: dump.entries.length } : null,
    covered: [...covered].sort(),
    shortCircuits: Object.fromEntries([...shortCircuits].map((kv) => [kv[0], kv[1].rel + ":" + kv[1].line])),
    summary,
    gaps,
    watch,
    targets,
    ignored: SHOW_ALL ? ignored : undefined,
    diff,
  };

  if (JSON_OUT) {
    fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(payload, null, 2) + "\n");
  }
  for (const line of report) console.log(line);
  if (gaps.length > 0) {
    console.log("[choke] 结论：有 " + gaps.length + " 组拦点会加载且没有补丁覆盖，需要人工判断是否加补丁");
  } else {
    console.log("[choke] 结论：没有未覆盖的拦点");
  }
  process.exit(gaps.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("[choke] 失败：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});