#!/usr/bin/env node
/**
 * test-host-baseline —— 宿主基线纯函数层的回归测试
 *
 * 全部用临时目录做 fixture，不碰真实宿主：
 *   resolveAiBase   只认「有 dsh/package.json 的真宿主树」
 *   fingerprintTargets  数组值摊平、缺失文件跳过、相对路径 posix 化
 *   buildSnapshot   汇总计数与 schema
 *   diffSnapshots   版本/文件/补丁三种变化与 verdict 分级
 *
 * 拆成独立 test()：这一组断言决定「宿主升级后哪个补丁废了」的可信度。
 * 原来是一个个 {} 块，第一处失败后面的全不跑；而升级当天同时出现
 * 「版本变了 + 某个补丁 drifted + 一个文件消失了」是常态，必须一次看全。
 */
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  auditStampVsTree, buildSnapshot, diffSnapshots, fingerprintTargets, findAiBase, looksLikeHostTree,
  mergeVerdicts, renderDiff, resolveAiBase, SNAPSHOT_SCHEMA, sha256Text,
} from "./host-baseline-lib.mjs";

const tmpRoots = [];
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-hb-${tag}-`));
  tmpRoots.push(d);
  return d;
}
function write(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text);
}

after(() => {
  for (const d of tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发占用，忽略 */
    }
  }
});

/** 造一棵最小宿主树：<app>/dsh/node_modules/@deepseek-ai/dsh/package.json */
function fixtureHost(version = "0.2.2-rc.1") {
  const app = tmpDir("app");
  const ai = path.join(app, "dsh", "node_modules", "@deepseek-ai");
  write(path.join(ai, "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version }));
  write(path.join(ai, "dsh-agent-instructions", "lib", "index.js"), `// host ${version}\n`);
  return { app, ai: ai.replace(/\\/g, "/") };
}

const rows = [
  { id: 1, name: "A", status: "settled", files: { k: "settled" } },
  { id: 2, name: "B", status: "settled", files: { k: "settled" } },
  { id: 3, name: "C", status: "drifted", files: { k: "drifted" } },
  { id: 4, name: "D", status: "no-file", files: { k: "no-file" } },
  { id: 5, name: "E", status: "na", files: {} },
];
/** 同一批补丁「全部装好」的状态：用来构造 settled -> drifted / drifted -> settled。 */
const settledRows = [
  { id: 1, name: "A", status: "settled" },
  { id: 2, name: "B", status: "settled" },
  { id: 3, name: "C", status: "settled" },
  { id: 4, name: "D", status: "no-file" },
  { id: 5, name: "E", status: "na" },
];

// ------------------------------------------------------------ resolveAiBase

test("resolveAiBase：app 与 @deepseek-ai 自身都能解析", () => {
  const { app, ai } = fixtureHost();
  assert.equal(resolveAiBase(app), ai, "app 目录应解析到 dsh/node_modules/@deepseek-ai");
  assert.equal(resolveAiBase(ai), ai, "@deepseek-ai 自身应原样返回");
});

test("resolveAiBase：外壳依赖树不能被当成宿主", () => {
  const { app, ai } = fixtureHost();
  const shell = path.join(app, "node_modules", "@deepseek-ai");
  write(path.join(shell, "dsh-desktop", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-desktop" }));
  assert.equal(looksLikeHostTree(shell), false, "没有 dsh/package.json 的外壳依赖树不是宿主");
  assert.equal(resolveAiBase(shell) === ai, false, "外壳依赖树不能被当成宿主");
});

test("resolveAiBase：不存在的路径与空输入都返回 null", () => {
  assert.equal(resolveAiBase(path.join(tmpDir("empty"), "nope")), null, "不存在的路径返回 null");
  assert.equal(resolveAiBase(""), null, "空输入返回 null");
});

// --------------------------------------------------------------- findAiBase

test("findAiBase：环境变量优先", () => {
  const { app, ai } = fixtureHost();
  assert.equal(findAiBase({ env: { DSH_HOST_AI_BASE: app }, programsDir: path.join(app, "none") }), ai);
});

test("findAiBase：都没有时返回 null", () => {
  const { app } = fixtureHost();
  assert.equal(findAiBase({ env: {}, programsDir: path.join(app, "none") }), null);
});

test("findAiBase：programsDir 下按 /deepseek|dsh/i 命中", () => {
  const root = tmpDir("programs");
  const nested = fixtureHost("0.2.1-rc.5");
  const fake = path.join(root, "DeepSeek Harness");
  fs.mkdirSync(path.join(fake, "resources"), { recursive: true });
  fs.renameSync(nested.app, path.join(fake, "resources", "app"));
  assert.equal(
    findAiBase({ env: {}, programsDir: root }),
    path.join(fake, "resources", "app", "dsh", "node_modules", "@deepseek-ai").replace(/\\/g, "/"),
  );
});

// -------------------------------------------------------- fingerprintTargets

test("fingerprintTargets：数组摊平、缺失跳过、相对路径 posix 化", () => {
  const { ai } = fixtureHost();
  const a = path.join(ai, "dsh-agent-instructions", "lib", "index.js");
  const b = path.join(ai, "second", "x.js");
  write(b, "second\n");
  const fp = fingerprintTargets(ai, {
    single: a,
    multi: [a, b],
    gone: path.join(ai, "missing.js"),
    goneArr: [path.join(ai, "missing.js")],
    blank: "",
  });
  assert.deepEqual(Object.keys(fp).sort(), ["multi#0", "multi#1", "single"]);
  assert.equal(fp.single.rel, "dsh-agent-instructions/lib/index.js", "相对路径用 posix 分隔");
  assert.equal(fp.single.sha256, sha256Text(fs.readFileSync(a, "utf8")), "sha256 与内容一致");
  assert.equal(fp.single.bytes, fs.statSync(a).size);
});

// ------------------------------------------------------------ buildSnapshot

test("buildSnapshot：schema/时间戳/汇总计数正确，且不含本机绝对路径", () => {
  const { ai } = fixtureHost();
  const snap = buildSnapshot({
    host: { version: "0.2.2-rc.1", name: "@deepseek-ai/dsh", path: "x" },
    aiBase: ai,
    files: { single: path.join(ai, "dsh-agent-instructions", "lib", "index.js") },
    rows,
    capturedAt: "2026-01-01T00:00:00.000Z",
    packageVersion: "1.1.94",
  });
  assert.equal(snap.schema, SNAPSHOT_SCHEMA);
  assert.equal(snap.capturedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(snap.pluginVersion, "1.1.94");
  assert.deepEqual(snap.summary, { patches: 5, settled: 2, wouldApply: 0, drifted: 1, noFile: 1, na: 1 });
  assert.equal(snap.aiBase.includes("\\"), false, "aiBase 落盘前统一成 posix");
  assert.equal(JSON.stringify(snap).includes(tmpRoots[0]), false, "快照里不该出现本机临时目录");
});

// ------------------------------------------------------------ diffSnapshots

/** 造一对快照：a 用 rowsA、b 用 rowsB，其余相同。 */
function pair({ versionA = "v", versionB = "v", rowsA = rows, rowsB = rows, fileA = {}, fileB = {} } = {}) {
  const { ai } = fixtureHost();
  return [
    buildSnapshot({ host: { version: versionA }, aiBase: ai, files: fileA, rows: rowsA }),
    buildSnapshot({ host: { version: versionB }, aiBase: ai, files: fileB, rows: rowsB }),
  ];
}

test("diffSnapshots：两份相同 → ok", () => {
  const [a, b] = pair();
  const d = diffSnapshots(a, b);
  assert.equal(d.verdict, "ok");
  assert.equal(d.versionChanged, false);
  assert.deepEqual(d.files, []);
  assert.deepEqual(d.transitions, []);
});

test("diffSnapshots：仅版本变化 → review，并报出前后版本", () => {
  const [a, b] = pair({ versionA: "0.2.2-rc.1", versionB: "0.2.3" });
  const d = diffSnapshots(a, b);
  assert.equal(d.verdict, "review");
  assert.equal(d.fromVersion, "0.2.2-rc.1");
  assert.equal(d.toVersion, "0.2.3");
  assert.equal(d.versionChanged, true);
  assert.deepEqual(d.broken, []);
});

test("diffSnapshots：文件内容变了 → review 且列出该文件", () => {
  const { ai } = fixtureHost();
  const fp1 = path.join(ai, "dsh-agent-instructions", "lib", "index.js");
  const a = buildSnapshot({ host: { version: "0.2.2-rc.1" }, aiBase: ai, files: { single: fp1 }, rows });
  fs.writeFileSync(fp1, "// rewritten\n");
  const b = buildSnapshot({ host: { version: "0.2.2-rc.1" }, aiBase: ai, files: { single: fp1 }, rows });
  const d = diffSnapshots(a, b);
  assert.equal(d.verdict, "review");
  assert.equal(d.files.length, 1);
  assert.equal(d.files[0].state, "changed");
  assert.equal(d.files[0].key, "single");
});

test("diffSnapshots：文件新增/移除各自标出", () => {
  const { ai } = fixtureHost();
  const fp1 = path.join(ai, "dsh-agent-instructions", "lib", "index.js");
  const a = buildSnapshot({ host: { version: "v" }, aiBase: ai, files: {}, rows });
  const b = buildSnapshot({ host: { version: "v" }, aiBase: ai, files: { single: fp1 }, rows });
  assert.equal(diffSnapshots(a, b).files[0].state, "added");
  assert.equal(diffSnapshots(b, a).files[0].state, "removed");
});

test("diffSnapshots：settled → drifted 必须 broken", () => {
  const [a, b] = pair({ rowsA: settledRows, rowsB: rows });
  const d = diffSnapshots(a, b);
  assert.equal(d.verdict, "broken");
  assert.deepEqual(d.broken.map((x) => x.id), [3]);
  assert.equal(d.broken[0].to, "drifted");
});

test("diffSnapshots：no-file → would-apply 是「新增可打」，不是失效", () => {
  const [a, b] = pair({
    rowsB: [
      { id: 1, name: "A", status: "settled" }, { id: 2, name: "B", status: "settled" },
      { id: 3, name: "C", status: "drifted" }, { id: 4, name: "D", status: "would-apply" },
      { id: 5, name: "E", status: "na" },
    ],
  });
  const d = diffSnapshots(a, b);
  assert.equal(d.verdict, "review");
  assert.deepEqual(d.gained.map((g) => g.id), [4]);
});

test("diffSnapshots：drifted → settled 是 recovered，verdict 回到 review", () => {
  const [a, b] = pair({ rowsA: rows, rowsB: settledRows });
  const d = diffSnapshots(a, b);
  const t = d.transitions.find((x) => x.id === 3);
  assert.equal(t.severity, "recovered");
  assert.equal(d.verdict, "review");
});

test("diffSnapshots：补丁从表里消失 → broken", () => {
  const [a, b] = pair({ rowsA: rows, rowsB: rows.slice(1) });
  const d = diffSnapshots(a, b);
  assert.equal(d.verdict, "broken");
  assert.equal(d.transitions[0].to, "(gone)");
});

test("diffSnapshots：任一参数缺失要抛错", () => {
  assert.throws(() => diffSnapshots(null, {}), /both snapshots/);
});

// ---------- settled → would-apply 必须是 broken（2026-11-12 实测事故） ----------
// 事故现场：宿主树被换回原版，79 条 settled 全变成 would-apply。
// 老判定把它算成 changed/review，输出「有变化但补丁仍站得住」——语义反了。
// would-apply 的含义就是「原文是原版、这条 pattern 现在能打上去」，也就是没打。

test("diffSnapshots：settled → would-apply 必须 broken（补丁不在树上，重打即可）", () => {
  const [a, b] = pair({
    rowsA: settledRows,
    rowsB: settledRows.map((r) => (r.id === 1 ? { ...r, status: "would-apply" } : r)),
  });
  const d = diffSnapshots(a, b);
  assert.equal(d.verdict, "broken");
  assert.deepEqual(d.broken.map((x) => x.id), [1]);
  assert.equal(d.broken[0].severity, "unapplied");
  assert.equal(d.broken[0].from, "settled");
  assert.equal(d.broken[0].to, "would-apply");
});

test("diffSnapshots：79 条全从 settled 掉成 would-apply 时一条都不漏", () => {
  const many = Array.from({ length: 79 }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, status: "settled" }));
  const allUnapplied = many.map((r) => ({ ...r, status: "would-apply" }));
  const a = buildSnapshot({ host: { version: "0.2.2-rc.1" }, aiBase: "/x", files: {}, rows: many });
  const b = buildSnapshot({ host: { version: "0.2.2-rc.1" }, aiBase: "/x", files: {}, rows: allUnapplied });
  const d = diffSnapshots(a, b);
  assert.equal(d.verdict, "broken");
  assert.equal(d.broken.length, 79);
  assert.ok(d.broken.every((x) => x.severity === "unapplied"));
});

test("diffSnapshots：drifted → would-apply 记 still-broken（从「要改 pattern」变成「重打就行」，但仍没装）", () => {
  // 两种状态都是「没装」，但修法从「改 pattern」降级成「重打」。
  // 按既有约定 still-broken 仍计入 broken（与 no-file → drifted 一致），
  // 只是 severity 名不同，看输出能知道该干哪件事。
  const [a, b] = pair({
    rowsA: [{ id: 3, name: "C", status: "drifted" }],
    rowsB: [{ id: 3, name: "C", status: "would-apply" }],
  });
  const d = diffSnapshots(a, b);
  const t = d.transitions.find((x) => x.id === 3);
  assert.equal(t.severity, "still-broken");
  assert.equal(t.from, "drifted");
  assert.equal(t.to, "would-apply");
  assert.equal(d.verdict, "broken");
});

test("diffSnapshots：no-file → would-apply 仍算「新增可打」，不能被 unapplied 误伤", () => {
  const [a, b] = pair({
    rowsA: [{ id: 4, name: "D", status: "no-file" }],
    rowsB: [{ id: 4, name: "D", status: "would-apply" }],
  });
  const d = diffSnapshots(a, b);
  assert.deepEqual(d.gained.map((g) => g.id), [4]);
  assert.equal(d.broken.length, 0);
  assert.equal(d.verdict, "review");
});

test("diffSnapshots：settled → settled 不变，verdict 仍 ok（防过度报警）", () => {
  const [a, b] = pair({ rowsA: settledRows, rowsB: settledRows });
  assert.equal(diffSnapshots(a, b).verdict, "ok");
});

test("renderDiff：broken 时把「重打即可」与「要改 pattern」分成两行", () => {
  const [a, b] = pair({
    rowsA: settledRows,
    rowsB: settledRows.map((r) => (r.id === 1 ? { ...r, status: "would-apply" } : r.id === 2 ? { ...r, status: "drifted" } : r)),
  });
  const text = renderDiff(diffSnapshots(a, b), {});
  assert.match(text, /补丁不在树上（重打即可）: #1 A/);
  assert.match(text, /失效补丁（要改 pattern）: #2 B/);
  assert.match(text, /按上面的分类处理后再跑一次/);
});

test("renderDiff：只有 unapplied 时不该提示「要改 pattern」", () => {
  const [a, b] = pair({
    rowsA: settledRows,
    rowsB: settledRows.map((r) => (r.id === 1 ? { ...r, status: "would-apply" } : r)),
  });
  const text = renderDiff(diffSnapshots(a, b), {});
  assert.match(text, /补丁不在树上（重打即可）/);
  assert.doesNotMatch(text, /要改 pattern/);
  assert.doesNotMatch(text, /verify-target/);
});

// ---------- 状态戳与宿主树的自洽性（2026-11-12 实测事故的守卫） ----------
// 事故现场：applied.json 写 {version:"1.1.94", sha:"apply:1.1.94"}，
// 而 resources/app 下 59 个目标文件里 55 个是原版、dsh-purge 标记计数 0。
// 那时 host:status 只报 verdict=review（"补丁还站得住"），语义完全反了。

test("auditStampVsTree：戳说已应用、树上没标记 → stamp-lies / broken", () => {
  const a = auditStampVsTree({
    stamp: { version: "1.1.94", sha: "apply:1.1.94" },
    installedRev: "apply:1.1.94",
    pluginVersion: "1.1.94",
    markersPresent: false,
  });
  assert.equal(a.state, "stamp-lies");
  assert.equal(a.verdict, "broken");
  assert.equal(a.claimsApplied, true);
  assert.equal(a.placeholder, true);
  assert.match(a.detail, /戳在撒谎/);
});

test("auditStampVsTree：戳说已应用、树上也有标记 → consistent-applied / ok", () => {
  const a = auditStampVsTree({
    stamp: { version: "1.1.94", sha: "abc1234" },
    installedRev: "abc1234",
    pluginVersion: "1.1.94",
    markersPresent: true,
  });
  assert.equal(a.state, "consistent-applied");
  assert.equal(a.verdict, "ok");
  assert.equal(a.placeholder, false);
});

test("auditStampVsTree：戳是旧版本 → stale-stamp，无论树上有没有标记都要重打", () => {
  const withMarkers = auditStampVsTree({
    stamp: { version: "1.1.93", sha: "abc1234" },
    pluginVersion: "1.1.94",
    markersPresent: true,
  });
  const without = auditStampVsTree({
    stamp: { version: "1.1.93", sha: "abc1234" },
    pluginVersion: "1.1.94",
    markersPresent: false,
  });
  assert.equal(withMarkers.state, "stale-stamp");
  assert.equal(without.state, "stale-stamp");
  assert.equal(withMarkers.claimsApplied, false);
  // 旧戳不算撒谎：版本对不上时本来就不该声称「这次装的已经应用」。
  assert.equal(withMarkers.verdict, "ok");
});

test("auditStampVsTree：树上有标记但没有戳 → tree-lies / review（功能在，记录过期）", () => {
  const a = auditStampVsTree({ stamp: null, pluginVersion: "1.1.94", markersPresent: true });
  assert.equal(a.state, "tree-lies");
  assert.equal(a.verdict, "review");
  assert.match(a.detail, /记录过期/);
});

test("auditStampVsTree：干净状态（无戳无标记）→ no-stamp / ok", () => {
  const a = auditStampVsTree({ stamp: null, pluginVersion: "1.1.94", markersPresent: false });
  assert.equal(a.state, "no-stamp");
  assert.equal(a.verdict, "ok");
});

test("auditStampVsTree：找不到宿主根 → unknown-base，绝不判 broken（#59 防误报）", () => {
  const a = auditStampVsTree({
    stamp: { version: "1.1.94", sha: "apply:1.1.94" },
    pluginVersion: "1.1.94",
    markersPresent: false,
    hasAiBase: false,
  });
  assert.equal(a.state, "unknown-base");
  assert.equal(a.verdict, "ok");
  assert.match(a.detail, /不等于补丁丢失/);
});

test("auditStampVsTree：戳缺 sha 或 version 都不算「声称已应用」", () => {
  const noSha = auditStampVsTree({ stamp: { version: "1.1.94" }, pluginVersion: "1.1.94", markersPresent: false });
  const noVersion = auditStampVsTree({ stamp: { sha: "abc" }, pluginVersion: "1.1.94", markersPresent: false });
  assert.equal(noSha.claimsApplied, false);
  assert.equal(noVersion.claimsApplied, false);
  assert.notEqual(noSha.state, "stamp-lies");
  assert.notEqual(noVersion.state, "stamp-lies");
});

test("auditStampVsTree：空输入不抛，给 no-stamp", () => {
  assert.equal(auditStampVsTree().state, "no-stamp");
  assert.equal(auditStampVsTree({}).verdict, "ok");
});

test("mergeVerdicts：戳撒谎能单独把 verdict 拉到 broken（补丁与契约都 ok 时）", () => {
  const lying = auditStampVsTree({
    stamp: { version: "1.1.94", sha: "apply:1.1.94" },
    pluginVersion: "1.1.94",
    markersPresent: false,
  });
  assert.equal(mergeVerdicts("ok", null, lying), "broken");
  // 三参缺省时行为与旧两参一致，不能因为新增参数让老的调用点变成 review。
  assert.equal(mergeVerdicts("ok", null), "ok");
  assert.equal(mergeVerdicts("review", null), "review");
});

test("mergeVerdicts：tree-lies 只把 ok 抬到 review，不覆盖更严重的 patch verdict", () => {
  const stale = auditStampVsTree({ stamp: null, pluginVersion: "1.1.94", markersPresent: true });
  assert.equal(stale.verdict, "review");
  assert.equal(mergeVerdicts("ok", null, stale), "review");
  assert.equal(mergeVerdicts("broken", null, stale), "broken");
});

test("mergeVerdicts：契约失败仍然压过一切（含 tree-lies）", () => {
  const stale = auditStampVsTree({ stamp: null, pluginVersion: "1.1.94", markersPresent: true });
  assert.equal(mergeVerdicts("ok", { ok: false }, stale), "broken");
});

test("renderDiff：stamp-lies 那行排在最前，且带上 state 与原因", () => {
  const [a, b] = pair();
  const diff = diffSnapshots(a, b);
  const lying = auditStampVsTree({
    stamp: { version: "1.1.94", sha: "apply:1.1.94" },
    pluginVersion: "1.1.94",
    markersPresent: false,
  });
  const text = renderDiff(diff, { stampAudit: lying });
  const lines = text.split("\n");
  assert.match(lines[0], /verdict=broken/);
  assert.match(lines[1], /✖ 状态戳核对 stamp-lies/);
  assert.match(lines[1], /戳在撒谎/);
});

test("renderDiff：一致时给 ✓，review 态给 !", () => {
  const [a, b] = pair();
  const diff = diffSnapshots(a, b);
  const good = renderDiff(diff, {
    stampAudit: auditStampVsTree({
      stamp: { version: "1.1.94", sha: "abc1234" },
      pluginVersion: "1.1.94",
      markersPresent: true,
    }),
  });
  const stale = renderDiff(diff, {
    stampAudit: auditStampVsTree({ stamp: null, pluginVersion: "1.1.94", markersPresent: true }),
  });
  assert.match(good.split("\n")[1], /✓ 状态戳核对 consistent-applied/);
  assert.match(stale.split("\n")[1], /! 状态戳核对 tree-lies/);
});

test("renderDiff：不传 stampAudit 时输出与旧版一致（不多一行）", () => {
  const [a, b] = pair();
  const diff = diffSnapshots(a, b);
  const text = renderDiff(diff, {});
  assert.equal(text.split("\n").filter((l) => l.includes("状态戳核对")).length, 0);
});

console.log("host baseline helpers PASS");
