// scripts/census-lib.mjs 的回归测试。
// 这个模块回答「新版宿主哪里多了一道限制面、旧补丁还管不管用」。它坏掉的方式都很安静：
//   1. 正则太宽 → 命中上千条，人眼看不完，等于没扫；
//   2. 正则太窄 → 漏掉新闸门，报告说「没有未覆盖」，实际有；
//   3. 遍历语义漏了 node_modules / 内联副本 / 超大文件 / 非 lib 文件 → 统计被污染；
//   4. 最近距离算错（边界 15/16、同距取谁）→ 覆盖判断错位；
//   5. 排序/对比不确定 → 两次跑出两份报告。
// 测试用现造的假目录而不是真宿主：真宿主每次升级都变，假目录能把上面五件事钉死。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CENSUS_SCHEMA,
  DENIAL_PATTERNS,
  diffCensus,
  locateNeedle,
  markCovered,
  nearestPatch,
  rankCandidates,
  renderCensusReport,
  scanSites,
  summarize,
} from "./census-lib.mjs";

/** 造一棵假宿主树：{ "dsh-x/lib/index.js": "代码" }。 */
function fakeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "census-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

/** 造树并在测试结束后删除。 */
function withTree(t, files) {
  const root = fakeTree(files);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// ---------------------------------------------------------------- 形状表

test("schema 与形状表自洽，必需 id 齐全", () => {
  assert.equal(CENSUS_SCHEMA, 1);
  const ids = DENIAL_PATTERNS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "pattern id 必须唯一");
  for (const need of ["deny-copy-en", "deny-copy-zh", "deny-error-class", "policy-enum", "escalate-entry", "confine-call"]) {
    assert.ok(ids.includes(need), "缺少必需 id: " + need);
  }
  for (const p of DENIAL_PATTERNS) {
    assert.ok(p.re instanceof RegExp, p.id + " 要有正则");
    assert.equal(p.re.global, false, p.id + " 不要带 g 标志");
    assert.ok(["denial", "policy", "signal"].includes(p.role), p.id + " 的 role 必须是三档之一");
    assert.equal(typeof p.why, "string");
    assert.ok(p.why.length > 0, p.id + " 要有 why");
    assert.equal(typeof p.noiseLimit, "number");
  }
});

test("英文拒绝文案命中 deny-copy-en", (t) => {
  const root = withTree(t, {
    "dsh-a/lib/index.js": "throw new Error(" + JSON.stringify("File write is not allowed outside the workspace") + ");\n",
  });
  const hits = scanSites(root);
  assert.equal(hits["deny-copy-en"].length, 1);
  assert.equal(hits["deny-copy-en"][0].rel, "dsh-a/lib/index.js");
  assert.equal(hits["deny-copy-en"][0].line, 1);
  assert.match(hits["deny-copy-en"][0].text, /not allowed/);
});

test("中文拒绝文案命中 deny-copy-zh", (t) => {
  const root = withTree(t, {
    "dsh-b/lib/index.js": "if (!ok) throw new Error(" + JSON.stringify("该操作需要审批") + ");\n",
  });
  const hits = scanSites(root);
  assert.equal(hits["deny-copy-zh"].length, 1);
  assert.equal(hits["deny-copy-zh"][0].rel, "dsh-b/lib/index.js");
});

test("反例：reject / deniedHandler / 无拒绝语义的 approval 句子都不命中 deny-copy-en", (t) => {
  const root = withTree(t, {
    "dsh-c/lib/index.js": [
      "const reject = 1;",
      "function deniedHandler() {}",
      "// The approval service is injected elsewhere; it handles user consent.",
    ].join("\n") + "\n",
  });
  const hits = scanSites(root);
  assert.equal(hits["deny-copy-en"].length, 0);
  assert.equal(hits["deny-error-class"].length, 0);
});

// ---------------------------------------------------------------- 遍历语义

test("node_modules 不扫", (t) => {
  const root = withTree(t, {
    "dsh-a/lib/index.js": "const a = " + JSON.stringify("not allowed") + ";\n",
    "dsh-a/lib/node_modules/junk/x.js": "const a = " + JSON.stringify("not allowed") + ";\n",
  });
  const hits = scanSites(root);
  assert.deepEqual(hits["deny-copy-en"].map((h) => h.rel), ["dsh-a/lib/index.js"]);
});

test("index.js 内联的 //#region 副本被剔除，同一段代码只计 1 条", (t) => {
  const src = "const APPROVAL_POLICIES = Object.freeze([]);\n";
  const root = withTree(t, {
    "dsh-x/lib/index.js": "//#region lib/types/foo.js\n" + src + "//#endregion\n",
    "dsh-x/lib/types/foo.js": src,
  });
  const hits = scanSites(root);
  assert.equal(hits["policy-enum"].length, 1);
  assert.equal(hits["policy-enum"][0].rel, "dsh-x/lib/index.js");
});

test("超过 maxBytes 的文件跳过", (t) => {
  const root = withTree(t, {
    "dsh-a/lib/big.js": "const a = " + JSON.stringify("not allowed") + ";\n",
  });
  const hits = scanSites(root, { maxBytes: 10 });
  assert.equal(hits["deny-copy-en"].length, 0);
});

test("非 dsh- 前缀目录跳过", (t) => {
  const root = withTree(t, {
    "otherpkg/lib/index.js": "const a = " + JSON.stringify("not allowed") + ";\n",
  });
  const hits = scanSites(root);
  assert.equal(hits["deny-copy-en"].length, 0);
});

test("只扫 lib 下 .js/.mjs/.cjs；.ts/.md 不扫，.mjs/.cjs 扫", (t) => {
  const line = "const a = " + JSON.stringify("not allowed") + ";\n";
  const root = withTree(t, {
    "dsh-a/lib/a.mjs": line,
    "dsh-a/lib/b.cjs": line,
    "dsh-a/lib/c.ts": line,
    "dsh-a/lib/readme.md": line,
  });
  const hits = scanSites(root);
  assert.deepEqual(hits["deny-copy-en"].map((h) => h.rel).sort(), ["dsh-a/lib/a.mjs", "dsh-a/lib/b.cjs"]);
});

// ---------------------------------------------------------------- locateNeedle

test("locateNeedle：字符串 needle 命中多行", () => {
  assert.deepEqual(locateNeedle("a\nNEEDLE\nb NEEDLE c", "NEEDLE"), [2, 3]);
});

test("locateNeedle：RegExp needle（非全局逐行 / 全局 matchAll）", () => {
  const text = "NEEDLE1\nx\nNEEDLE2";
  assert.deepEqual(locateNeedle(text, /NEEDLE\d/), [1, 3]);
  assert.deepEqual(locateNeedle(text, /NEEDLE\d/g), [1, 3]);
});

test("locateNeedle：找不到返回空数组", () => {
  assert.deepEqual(locateNeedle("abc\ndef", "zzz"), []);
  assert.deepEqual(locateNeedle("abc\ndef", /zzz/), []);
});

test("locateNeedle：最多返回 200 个", () => {
  const text = Array.from({ length: 250 }, () => "hit").join("\n");
  const got = locateNeedle(text, "hit");
  assert.equal(got.length, 200);
  assert.equal(got[got.length - 1], 200);
});

// ---------------------------------------------------------------- 覆盖求交

test("nearestPatch：同文件距离 15 命中、16 不命中、不同文件不命中", () => {
  const site = { rel: "a/x.js", line: 100 };
  assert.deepEqual(nearestPatch(site, [{ id: 1, rel: "a/x.js", line: 85 }]), { id: 1, distance: 15 });
  assert.equal(nearestPatch(site, [{ id: 1, rel: "a/x.js", line: 84 }]), null);
  assert.equal(nearestPatch(site, [{ id: 1, rel: "b/x.js", line: 100 }]), null);
});

test("nearestPatch：同距取 id 数值小的", () => {
  const site = { rel: "a", line: 100 };
  const spans = [{ id: 2, rel: "a", line: 85 }, { id: 1, rel: "a", line: 115 }];
  assert.deepEqual(nearestPatch(site, spans), { id: 1, distance: 15 });
});

test("markCovered：标注 coveredBy/distance，不改入参", () => {
  const sites = [{ rel: "a", line: 100 }, { rel: "z", line: 5 }];
  const out = markCovered(sites, [{ id: "p1", rel: "a", line: 98 }]);
  assert.equal(out[0].coveredBy, "p1");
  assert.equal(out[0].distance, 2);
  assert.equal(out[1].coveredBy, null);
  assert.equal(out[1].distance, null);
  assert.equal(sites[0].coveredBy, undefined, "入参不应被改");
});

// ---------------------------------------------------------------- 排序

test("rankCandidates：未覆盖在前、denial 优先、确定性", () => {
  const sites = [
    { pattern: "p1", role: "policy", rel: "dsh-b/lib/x.js", line: 2, coveredBy: "cov" },
    { pattern: "p2", role: "denial", rel: "dsh-a/lib/y.js", line: 9, coveredBy: null },
    { pattern: "p3", role: "signal", rel: "dsh-a/lib/z.js", line: 1, coveredBy: null },
    { pattern: "p4", role: "denial", rel: "dsh-a/lib/w.js", line: 3, coveredBy: null },
  ];
  const got = rankCandidates(sites);
  assert.deepEqual(got.map((s) => s.pattern), ["p4", "p2", "p3", "p1"]);
  assert.deepEqual(rankCandidates(sites), got, "同输入两次结果一致");
  assert.equal(sites[0].pattern, "p1", "入参不应被改");
});

// ---------------------------------------------------------------- 对比

test("diffCensus：line 变化与空白差异不算变更", () => {
  const prev = [
    { pattern: "p", rel: "a", text: "hello   world", line: 1 },
    { pattern: "p", rel: "b", text: "dup", line: 2 },
  ];
  const next = [
    { pattern: "p", rel: "a", text: "hello world", line: 99 },
    { pattern: "p", rel: "b", text: "dup", line: 2 },
  ];
  const d = diffCensus(prev, next);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
});

test("diffCensus：新增一条、删除一条", () => {
  const prev = [
    { pattern: "p", rel: "a", text: "x", line: 1 },
    { pattern: "p", rel: "c", text: "gone", line: 3 },
  ];
  const next = [
    { pattern: "p", rel: "a", text: "x", line: 1 },
    { pattern: "p", rel: "b", text: "new", line: 2 },
  ];
  const d = diffCensus(prev, next);
  assert.deepEqual(d.added.map((x) => x.rel), ["b"]);
  assert.deepEqual(d.removed.map((x) => x.rel), ["c"]);
});

// ---------------------------------------------------------------- 汇总与报告

test("summarize：byPattern / byPkg 与未覆盖计数", () => {
  const s = summarize([
    { pattern: "p1", rel: "dsh-a/lib/x.js", coveredBy: null },
    { pattern: "p1", rel: "dsh-a/lib/y.js", coveredBy: "c" },
    { pattern: "p2", rel: "dsh-b/lib/z.js", coveredBy: null },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.uncovered, 2);
  const p1 = s.byPattern.find((r) => r.pattern === "p1");
  assert.deepEqual(p1, { pattern: "p1", total: 2, uncovered: 1 });
  const a = s.byPkg.find((r) => r.pkg === "dsh-a");
  assert.deepEqual(a, { pkg: "dsh-a", total: 2, uncovered: 1 });
});

test("renderCensusReport：含关键标题、未覆盖条目、diff 摘要", () => {
  const sites = [
    { pattern: "deny-copy-en", rel: "dsh-a/lib/x.js", line: 7, text: "not allowed here", coveredBy: null },
    { pattern: "policy-enum", rel: "dsh-b/lib/y.js", line: 3, text: "APPROVAL_POLICIES = []", coveredBy: "cov" },
  ];
  const diff = {
    added: [{ pattern: "deny-copy-zh", rel: "dsh-c/lib/z.js", line: 1, text: "需要审批" }],
    removed: [{ pattern: "x", rel: "dsh-d/lib/w.js", line: 2, text: "gone" }],
  };
  const text = renderCensusReport({ sites, diff, limit: 5 });
  assert.match(text, /总览/);
  assert.match(text, /按 pattern/);
  assert.match(text, /未覆盖站点/);
  assert.match(text, /dsh-a\/lib\/x\.js:7/);
  assert.match(text, /新增 1 条/);
  assert.match(text, /消失 1 条/);
});
