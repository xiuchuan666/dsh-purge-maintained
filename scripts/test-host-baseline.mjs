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
  buildSnapshot, diffSnapshots, fingerprintTargets, findAiBase, looksLikeHostTree,
  resolveAiBase, SNAPSHOT_SCHEMA, sha256Text,
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

console.log("host baseline helpers PASS");
