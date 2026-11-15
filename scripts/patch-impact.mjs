#!/usr/bin/env node
/**
 * npm run impact:patches                    # 生成 docs/patch-impact.md
 * npm run impact:patches -- --rehearsal .tmp-rehearse/rc3.json
 *
 * 一张表回答「升级后哪条补丁可能失效、谁替它作证」：每条补丁的宿主文件、基线状态、
 * 有没有行为级验证（patch-behaviors 的 covers）、有没有进闸表（patch-gates）、
 * 以及最近一次预演里它的判定（给了 --rehearsal 才有这一列）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const BASELINE = path.join(REPO, "docs", "host-baseline.json");
const GATES = path.join(REPO, "docs", "patch-gates.json");
const OUT = path.join(REPO, "docs", "patch-impact.md");

const args = process.argv.slice(2);
const opt = (n, d = "") => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const gates = JSON.parse(fs.readFileSync(GATES, "utf8"));
const { ALL_PATCHES } = await import(pathToFileURL(path.join(REPO, "lib", "patches", "index.mjs")).href);
const { BEHAVIORS } = await import(pathToFileURL(path.join(REPO, "scripts", "patch-behaviors.mjs")).href);

const behaviourIds = new Set();
for (const b of BEHAVIORS) for (const id of b.covers ?? []) behaviourIds.add(Number(id));
const gateIds = new Set((gates.rows ?? []).map((r) => Number(r.patch)));

// 预演 JSON：兼容 host-rehearse 的几种落盘形状，能捞到 id→判定就行
const rehearsalPath = opt("--rehearsal", path.join(REPO, ".tmp-rehearse", "rc3.json"));
const verdict = new Map();
if (fs.existsSync(rehearsalPath)) {
  const raw = JSON.parse(fs.readFileSync(rehearsalPath, "utf8"));
  // host:rehearse 的报告里每步都可能带 id：只用 outcome 步（它才是"这条补丁在树上怎么了"），
  // 否则 apply 的 ok/warn、gates 的 present/missing 会覆盖掉真正的判定。
  const outcome = Array.isArray(raw.steps) ? raw.steps.find((s) => s && s.id === "outcome") : null;
  if (outcome && Array.isArray(outcome.rows)) {
    for (const row of outcome.rows) {
      const id = Number(row.id);
      const state = row.status ?? row.state ?? row.now;
      if (Number.isFinite(id) && typeof state === "string") verdict.set(id, state);
    }
  } else {
    const walk = (v) => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) { for (const x of v) walk(x); return; }
      const id = Number(v.id ?? v.patch ?? v.patchId);
      const state = v.state ?? v.verdict ?? v.status ?? v.now;
      if (Number.isFinite(id) && typeof state === "string") verdict.set(id, state);
      for (const x of Object.values(v)) walk(x);
    };
    walk(raw);
  }
}

const byId = new Map(baseline.patches.map((x) => [Number(x.id), x]));
const rows = [...ALL_PATCHES].sort((a, b) => a.id - b.id).map((patch) => {
  const base = byId.get(patch.id) ?? {};
  const files = Array.isArray(patch.file) ? patch.file.join(" + ") : String(patch.file ?? "");
  const rel = Array.isArray(patch.rel) ? patch.rel.join("/") : patch.rel ? String(patch.rel) : "";
  return {
    id: patch.id,
    name: patch.name,
    layer: patch.layer ?? "",
    files,
    rel,
    base: base.status ?? "?",
    behaviour: behaviourIds.has(patch.id) ? "✓" : "",
    gate: gateIds.has(patch.id) ? "✓" : "",
    rc3: verdict.get(patch.id) ?? (verdict.size ? "（未列出）" : "—"),
  };
});

const count = (f) => rows.filter(f).length;
const md = [
  "# 补丁影响矩阵（哪个补丁坏了，谁替它作证）",
  "",
  `> 生成：\`npm run impact:patches\`；基线 \`docs/host-baseline.json\`（${baseline.patches.length} 条）、闸表 \`docs/patch-gates.json\`（${(gates.rows ?? []).length} 行）、行为验证 \`scripts/patch-behaviors.mjs\`（${BEHAVIORS.length} 个场景）。`,
  verdict.size ? `> rc 预演判定来自 \`${path.relative(REPO, rehearsalPath).split(path.sep).join("/")}\`（${verdict.size} 条有判定）。` : "> 本次没有预演判定列（跑 `npm run host:rehearse -- --json .tmp-rehearse/rc3.json` 后带 `--rehearsal` 重新生成）。",
  "",
  `合计：**${rows.length}** 条补丁；行为级验证 **${count((r) => r.behaviour)}** 条；进闸表 **${count((r) => r.gate)}** 条；行为+闸表双证 **${count((r) => r.behaviour && r.gate)}** 条；只有文件标记、无外部证据 **${count((r) => !r.behaviour && !r.gate)}** 条。`,
  "",
  "| # | 补丁 | 层 | 宿主文件（rel） | 基线 | 行为 | 闸表 | 预演 |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => "| " + r.id + " | " + r.name + " | " + r.layer + " | " + r.files + (r.rel ? " （" + r.rel + "）" : "") + " | " + r.base + " | " + r.behaviour + " | " + r.gate + " | " + r.rc3 + " |"),
  "",
  "## 行为验证缺口（按层）",
  "",
  ...(() => {
    const gap = rows.filter((r) => !r.behaviour);
    const layers = [...new Set(gap.map((r) => r.layer))];
    const out = [];
    for (const layer of layers) {
      const list = gap.filter((r) => r.layer === layer);
      out.push(`- **${layer}** ${list.length} 条无行为断言：` + list.map((r) => `#${r.id} ${r.name}`).join("、"));
    }
    return out;
  })(),
  "",
  "代码层没有行为断言 = 升级后只有文件标记能替它作证；提示词层大多是整句替换，标记就够，属正常。",
  "",  "## 怎么用",
  "",
  "- **升级后先看「预演」列**：`stale`/`drifted` → 该补丁的锚点在新版本里变了；`native` → 上游自己改了，可以退场；`applied` → 照旧。",
  "- **行为列为空**的补丁只有文件标记作证——标记在、行为未必在。改这些补丁的代码时，配一条 `scripts/patch-behaviors.mjs` 场景比补覆盖率更值。",
  "- **闸表列为空**说明 `docs/patch-gates.json` 没有它的观测行；跑 `npm run host:gates` 看是不是被判成 `nativ*`/`no-file`。",
  "- 改动任何补丁前，先 `npm run impact -- lib/patches/index.mjs` 看哪些测试会跟着响。",
  "",
].join("\n");
fs.writeFileSync(OUT, md);
console.log(`[patch-impact] ${rows.length} 条 → ${path.relative(REPO, OUT)}`);
console.log(`[patch-impact] 行为 ${count((r) => r.behaviour)} / 闸表 ${count((r) => r.gate)} / 双证 ${count((r) => r.behaviour && r.gate)} / 仅标记 ${count((r) => !r.behaviour && !r.gate)}`);
if (verdict.size) {
  const tally = {};
  for (const v of verdict.values()) tally[v] = (tally[v] ?? 0) + 1;
  console.log("[patch-impact] 预演判定: " + JSON.stringify(tally));
}
