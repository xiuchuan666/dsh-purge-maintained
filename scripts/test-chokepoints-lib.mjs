// scripts/chokepoints-lib.mjs 的回归测试。
//
// 这个模块回答「新版宿主哪里多了一道闸门、旧补丁还管不管用」。它坏掉的方式全是安静的：
//   1. 形状正则太宽 → 命中数回到上千，人眼看不完，等于没扫；
//   2. 形状正则太窄 → 漏掉新增闸门，报告说「没有缺口」，实际有；
//   3. 求交漏了 dump-config → 把装上了但 profile 没启用的包全算成缺口；
//   4. role 分错 → 工具注册点被当成闸门，缺口清单被噪声淹没；
//   5. 短路判定不看守卫行 → 上游已经放权，下游却还在报缺口，补丁越写越多且无效。
//
// 测试用假目录而不是真宿主：真宿主每次升级都会变，假目录能把上面五件事钉死。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CHOKE_SCHEMA,
  SHAPES,
  correlate,
  diffShapes,
  findGaps,
  findShortCircuits,
  packageOfEntry,
  parseDumpConfig,
  renderChokeReport,
  scanShapes,
  summarizeHits,
} from "./chokepoints-lib.mjs";

/** 造一棵假宿主树：{ "dsh-x/lib/index.js": "代码" }。 */
function fakeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choke-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

/**
 * 造 dump-config 文本。
 * 用拼接而不是字面量，是因为宿主 YAML 里的引号有两种写法，
 * 而测试自己的源码里再嵌一层引号会看不清到底在测什么。
 */
function dumpOf(rows, section) {
  const lines = [];
  if (section) lines.push("# == " + section);
  rows.forEach((r, i) => {
    lines.push("- id: " + (r.id === undefined ? "id" + i : r.id));
    lines.push("  name: " + JSON.stringify("@deepseek-ai/" + r.pkg));
    if (r.disabled === true) lines.push("  disabled: true");
    if (r.expr) lines.push("  disabled: !!js " + JSON.stringify(r.expr));
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------- 形状定义

test("schema 与形状表自洽", () => {
  assert.equal(CHOKE_SCHEMA, 1);
  const ids = SHAPES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "形状 id 必须唯一");
  for (const s of SHAPES) {
    assert.ok(s.re instanceof RegExp, s.id + " 要有正则");
    assert.ok(["restriction", "signal", "target"].includes(s.role), s.id + " 的 role 必须是三档之一");
    assert.equal(s.re.global, false, s.id + " 不要带 g 标志（会被 lastIndex 坑）");
  }
});

test("形状正则在真实写法上命中，在装饰性文本上不命中", () => {
  const hit = (id, line) => SHAPES.find((s) => s.id === id).re.test(line);
  assert.ok(hit("approval-call", "this.ctx.approval.setPolicy(agent, policy);"));
  assert.ok(hit("approval-call", "const p = ctx.approval.overrideOf(agent.session);"));
  assert.ok(hit("sandbox-policy", "this.mode = ctx.sandboxPolicy.defaultMode;"));
  assert.ok(hit("sandbox-confine", "return this.ctx.sandbox.confine(argv, policy, signal);"));
  assert.ok(hit("inject-decl", "static inject = [subprocess, sandbox, sandboxPolicy];".replace(/[a-z]/gi, (c) => c)));
  assert.ok(hit("deny-throw", "throw new SandboxUnavailableError(mode, detail);"));
  assert.ok(hit("escalation-call", "await approveEscalation({ requestedMode }, x);"));
  assert.ok(hit("mode-literal", "if (mode === " + JSON.stringify("danger-full-access") + ") return;"));
  assert.ok(hit("mode-literal", JSON.stringify("read-only") + " === requested ? a : b;"));
  // 只是定义常量、没有比较，不算判断点
  assert.equal(hit("mode-literal", "const M = " + JSON.stringify("danger-full-access") + ";" + "\n"), false);
  // 装饰性用法不该命中：这是关键词扫描失效的根源
  assert.equal(hit("approval-call", "// the approval service is injected elsewhere"), false);
  assert.equal(hit("deny-throw", "// errors are thrown by the provider"), false);
});

test("inject-decl 认 static inject 声明，不认普通数组", () => {
  const re = SHAPES.find((s) => s.id === "inject-decl").re;
  assert.ok(re.test("static inject = [a, b, permission];"));
  assert.ok(re.test("static inject = [approval];"));
  assert.equal(re.test("const inject = [a, b];"), false);
});

// ---------------------------------------------------------------- 扫描

test("scanShapes 按包分文件收集，跳过 node_modules 与非代码文件", () => {
  const root = fakeTree({
    "dsh-a/lib/index.js": "ctx.sandboxPolicy.resolve();\n",
    "dsh-a/lib/node_modules/junk/x.js": "ctx.sandboxPolicy.resolve();\n",
    "dsh-b/lib/deep/inner.js": "throw new SandboxUnavailableError(1);\n",
    "dsh-b/lib/readme.md": "ctx.sandboxPolicy.resolve();\n",
  });
  const hits = scanShapes(root);
  assert.deepEqual(hits["sandbox-policy"].map((h) => h.rel), ["dsh-a/lib/index.js"]);
  assert.deepEqual(hits["deny-throw"].map((h) => h.rel), ["dsh-b/lib/deep/inner.js"]);
  assert.equal(hits["deny-throw"][0].line, 1);
});

test("scanShapes 剔除被 index.js 内联的副本，同一段代码不数两遍", () => {
  const src = "const DEFAULT_RETRYABLE_CODES = Object.freeze([\n";
  const root = fakeTree({
    "dsh-x/lib/index.js": "//#region lib/types/retry-policy.js\n" + src + "//#endregion\n",
    "dsh-x/lib/types/retry-policy.js": src,
  });
  const hits = scanShapes(root);
  assert.deepEqual(hits["vocab"].map((h) => h.rel), ["dsh-x/lib/index.js"]);
});

test("summarizeHits 给出总数、文件数、按包排行", () => {
  const hits = {
    "sandbox-policy": [
      { rel: "dsh-a/lib/index.js", line: 1, text: "" },
      { rel: "dsh-a/lib/index.js", line: 2, text: "" },
      { rel: "dsh-b/lib/index.js", line: 3, text: "" },
    ],
  };
  const [row] = summarizeHits(hits);
  assert.equal(row.total, 3);
  assert.equal(row.files, 2);
  assert.deepEqual(row.packages, [["dsh-a", 2], ["dsh-b", 1]]);
});

// ---------------------------------------------------------------- dump-config

test("parseDumpConfig 按 - id 切块，记段落头与 disabled", () => {
  const dump = parseDumpConfig(dumpOf([
    { id: "a", pkg: "dsh-sandbox" },
    { id: "b", pkg: "dsh-llm", disabled: true },
    { id: "c", pkg: "dsh-web-app/dist", expr: "!ctx.get(profileContext)" },
  ], "@deepseek-ai/dsh-base"));
  assert.equal(dump.entries.length, 3);
  assert.deepEqual(dump.sections, ["@deepseek-ai/dsh-base"]);
  assert.equal(dump.entries[0].name, "@deepseek-ai/dsh-sandbox");
  assert.equal(dump.entries[1].disabled, true);
  assert.equal(dump.entries[1].section, "@deepseek-ai/dsh-base");
  assert.match(dump.entries[2].disabledExpr, /!!js/);
});

test("parseDumpConfig 认单引号写法，也认多段落", () => {
  const text = [
    "# == base",
    "- id: a",
    "  name: " + String.fromCharCode(39) + "@deepseek-ai/dsh-a" + String.fromCharCode(39),
    "# == web",
    "- id: b",
    "  name: " + String.fromCharCode(39) + "@deepseek-ai/dsh-b" + String.fromCharCode(39),
  ].join("\n");
  const dump = parseDumpConfig(text);
  assert.deepEqual(dump.sections, ["base", "web"]);
  assert.deepEqual(dump.entries.map((e) => e.name), ["@deepseek-ai/dsh-a", "@deepseek-ai/dsh-b"]);
  assert.equal(dump.entries[1].section, "web");
});

test("packageOfEntry 能把包内子入口还原成包名", () => {
  assert.equal(packageOfEntry({ name: "@deepseek-ai/dsh-sandbox" }), "dsh-sandbox");
  assert.equal(packageOfEntry({ name: "@deepseek-ai/dsh-web-app/dist" }), "dsh-web-app");
  assert.equal(packageOfEntry({ name: "bare-name" }), "");
});

// ---------------------------------------------------------------- 求交与分流

function rowsFor(hits, rows, covered, guards) {
  return correlate(hits, parseDumpConfig(dumpOf(rows)), covered, guards || new Map());
}

test("findGaps 的三道过滤：不在 dump / disabled / 已覆盖", () => {
  const hits = {
    "sandbox-policy": [
      { rel: "dsh-loaded/lib/index.js", line: 1, text: "" },
      { rel: "dsh-off/lib/index.js", line: 1, text: "" },
      { rel: "dsh-absent/lib/index.js", line: 1, text: "" },
      { rel: "dsh-covered/lib/index.js", line: 1, text: "" },
    ],
  };
  const rows = [
    { pkg: "dsh-loaded" },
    { pkg: "dsh-off", disabled: true },
    { pkg: "dsh-covered" },
  ];
  const res = findGaps(rowsFor(hits, rows, new Set(["dsh-covered"])));
  assert.deepEqual(res.gaps.map((g) => g.pkg), ["dsh-loaded"]);
  const why = Object.fromEntries(res.ignored.map((i) => [i.pkg, i.reason]));
  assert.match(why["dsh-off"], /disabled/);
  assert.match(why["dsh-absent"], /不在 dump-config/);
  assert.match(why["dsh-covered"], /已有补丁覆盖/);
});

test("findGaps 按 role 分流：路标与附着点不冒充缺口", () => {
  const hits = {
    "sandbox-policy": [{ rel: "dsh-a/lib/index.js", line: 1, text: "" }],
    "vocab": [{ rel: "dsh-b/lib/index.js", line: 1, text: "" }],
    "tool-register": [{ rel: "dsh-c/lib/index.js", line: 1, text: "" }],
  };
  const res = findGaps(rowsFor(hits, [{ pkg: "dsh-a" }, { pkg: "dsh-b" }, { pkg: "dsh-c" }], new Set()));
  assert.deepEqual(res.gaps.map((g) => g.shape), ["sandbox-policy"]);
  assert.deepEqual(res.watch.map((g) => g.shape), ["vocab"]);
  assert.deepEqual(res.targets.map((g) => g.shape), ["tool-register"]);
});

test("满权早返回守卫让 mode 相关形状退出缺口清单，审批类不退出", () => {
  const hits = {
    "sandbox-policy": [{ rel: "dsh-guarded/lib/index.js", line: 1, text: "" }],
    "deny-throw": [{ rel: "dsh-guarded/lib/index.js", line: 2, text: "" }],
    "escalation-call": [{ rel: "dsh-guarded/lib/index.js", line: 3, text: "" }],
  };
  const guards = new Map([["dsh-guarded", { rel: "dsh-guarded/lib/index.js", line: 68, text: "guard" }]]);
  const res = findGaps(rowsFor(hits, [{ pkg: "dsh-guarded" }], new Set(), guards));
  assert.deepEqual(res.gaps.map((g) => g.shape), ["escalation-call"]);
});

test("上游已覆盖时短路理由写明是哪条补丁", () => {
  const hits = { "sandbox-confine": [{ rel: "dsh-bash-sandbox/lib/index.js", line: 1, text: "" }] };
  const covered = new Set(["dsh-sandbox-policy"]);
  const res = findGaps(rowsFor(hits, [{ pkg: "dsh-bash-sandbox" }], covered));
  // 上游覆盖由 correlate 一次算清（row.upstream.covered），findGaps 不再收第二个参数：
  // 规则只有一个计算点，测试里也就不会出现「传给了 A、规则在 B」的静默失效。
  assert.equal(res.gaps.length, 0);
  assert.match(res.ignored[0].reason, /dsh-sandbox-policy 已覆盖/);
});

test("findShortCircuits 认出两种写法，不误报没守卫的包", () => {
  const root = fakeTree({
    "dsh-a/lib/index.js": "if (mode === " + JSON.stringify("danger-full-access") + ") return ok();\n",
    "dsh-b/lib/index.js": "const c = policy.mode === " + JSON.stringify("danger-full-access") + " ? void 0 : await confine();\n",
    "dsh-c/lib/index.js": "const m = " + JSON.stringify("danger-full-access") + ";\n",
  });
  const guards = findShortCircuits(root);
  assert.deepEqual([...guards.keys()].sort(), ["dsh-a", "dsh-b"]);
  assert.equal(guards.get("dsh-a").line, 1);
});

// ---------------------------------------------------------------- 对比与报告

test("diffShapes 给出新增 / 变多 / 消失", () => {
  const before = { "sandbox-policy": [{ rel: "dsh-a/lib/i.js", line: 1, text: "" }] };
  const after = {
    "sandbox-policy": [
      { rel: "dsh-a/lib/i.js", line: 1, text: "" },
      { rel: "dsh-a/lib/i.js", line: 2, text: "" },
      { rel: "dsh-new/lib/i.js", line: 1, text: "" },
    ],
  };
  const d = diffShapes(before, after);
  assert.deepEqual(d.added.map((x) => x.pkg), ["dsh-new"]);
  assert.deepEqual(d.grown.map((x) => [x.pkg, x.was, x.n]), [["dsh-a", 1, 2]]);
  assert.equal(d.removed.length, 0);
});

test("renderChokeReport 三段都进报告，排除理由聚合", () => {
  const lines = renderChokeReport({
    gaps: [{ shape: "deny-throw", pkg: "dsh-a", hits: 2, sample: ["dsh-a/lib/i.js:1  throw"] }],
    watch: [{ shape: "vocab", pkg: "dsh-b", hits: 1, sample: [] }],
    targets: [{ shape: "tool-register", pkg: "dsh-c", hits: 3, sample: [] }],
    ignored: [
      { shape: "vocab", pkg: "dsh-d", reason: "已有补丁覆盖" },
      { shape: "vocab", pkg: "dsh-e", reason: "已有补丁覆盖" },
    ],
    summary: [{ shape: "deny-throw", total: 2, files: 1, packages: [] }],
    limit: 5,
  });
  const text = lines.join("\n");
  assert.match(text, /真缺口.*1 组/);
  assert.match(text, /路标.*1 组/);
  assert.match(text, /附着点.*1 组/);
  assert.match(text, /2 组（已有补丁覆盖）/);
});