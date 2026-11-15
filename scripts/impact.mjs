#!/usr/bin/env node
/**
 * npm run impact -- <lib/file.js> ...  |  npm run impact -- --all
 *
 * 改这个文件，谁会响：① 直接 import 的测试 ② 经共享 lib 间接覆盖的测试
 * ③ docs/test-map.md 里相关的记账行 ④ lcov 里当前未覆盖的行。
 * 全只读；宿主升级后先跑它，就知道该盯哪几个测试。
 */
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPTS = path.join(REPO, "scripts");
const MAP = path.join(REPO, "docs", "test-map.md");
const LCOV = path.join(REPO, ".tmp-coverage", "lcov.info");

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const norm = (p) => String(p).split(path.sep).join("/");

// abs 路径 → "lib/xxx.js"，不在 lib/ 下则 null
const asLib = (abs) => {
  const rel = norm(path.relative(REPO, abs));
  return rel.startsWith("lib/") ? rel : null;
};

const files = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"));
const edges = new Map();
for (const f of files) {
  const full = path.join(SCRIPTS, f);
  const src = read(full);
  const set = new Set();
  const re = /(?:import[^"\']*|import\(\s*)["\']([^"\']+)["\']/g;
  for (const m of src.matchAll(re)) {
    if (!m[1].startsWith(".")) continue;
    const lib = asLib(path.resolve(path.dirname(full), m[1]));
    if (lib) set.add(lib);
    else {
      const rel = norm(path.relative(SCRIPTS, path.resolve(path.dirname(full), m[1])));
      set.add("scripts/" + rel);
    }
  }
  edges.set(f, set);
}

const tests = files.filter((f) => f.startsWith("test-"));
const libsOf = (t) => edges.get(t) ?? new Set();

const coverage = new Map();
{
  let cur = null;
  for (const line of read(LCOV).split("\n")) {
    if (line.startsWith("SF:")) cur = { file: norm(line.slice(3)).replace(/^.*?\/lib\//, "lib/"), miss: [] };
    else if (line.startsWith("DA:") && cur) { const p = line.slice(3).split(","); if (Number(p[1]) === 0) cur.miss.push(Number(p[0])); }
    else if (line === "end_of_record" && cur) { coverage.set(cur.file, cur.miss); cur = null; }
  }
}

const mapLines = read(MAP).split("\n").filter((l) => l.startsWith("|"));

let targets = process.argv.slice(2);
if (targets.includes("--all")) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js")) out.push(asLib(full));
    }
  };
  walk(path.join(REPO, "lib"));
  targets = out.filter(Boolean);
}
if (!targets.length) {
  console.error("用法: npm run impact -- <lib/file.js> ... | --all");
  process.exit(2);
}

for (const raw of targets) {
  const target = norm(raw).replace(/^\.\//, "");
  const direct = tests.filter((t) => libsOf(t).has(target));
  const indirect = [];
  for (const t of tests) {
    if (direct.includes(t)) continue;
    for (const spec of libsOf(t)) {
      if (!spec.startsWith("scripts/")) continue;
      const key = spec.slice("scripts/".length);
      const sub = edges.get(key);
      if (sub && sub.has(target)) indirect.push(`${t} 经 ${key}`);
    }
  }
  const rows = mapLines.filter((l) => l.includes(target));
  const miss = coverage.get(target);
  console.log(`\n=== ${target} ===`);
  console.log(`直接 import（${direct.length}）: ${direct.join(", ") || "（无）"}`);
  if (indirect.length) console.log(`经共享 lib（${indirect.length}）: ${indirect.join(", ")}`);
  console.log(`能力地图记账（${rows.length} 行）:`);
  for (const r of rows) console.log("  " + r.trim().slice(0, 190));
  console.log(`未覆盖行: ${miss === undefined ? "（lcov 缺此文件，先跑 npm run test:full）" : miss.length ? miss.join(", ") : "无"}`);
}
