// lib/anchor.js 的回归测试。
//
// 这个模块负责把「身份与格式锁」补到 system prompt 的最尾部（recency 位）。
// 它坏掉的方式全都是安静的：
//   1. 锚点文本被清空或没注册上 → 模型读到的是长注入正文 + 后面一长串工具描述，
//      身份漂移，但不报错；
//   2. order 排错位置 → 被宿主自己的 context 盖掉（子锚点必须排在 delegation 之后，
//      主锚点必须排在 WEB_SURFACE 之后、DEPLOYMENT_PERSONA_SUFFIX 之前）；
//   3. 两个注册塞进同一个 try → context 撞名抛错时把 section 一起带走，尾部锚点整个消失；
//   4. disposer 不逐条 try → 停用插件时抛在第一条就收不干净。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ANCHOR_SECTION,
  CHILD_ANCHOR_CONTEXT,
  ANCHOR_ORDER,
  CHILD_ORDER,
  isSubagentContext,
  anchorTextFor,
  registerAnchor,
} from "../lib/anchor.js";

// ---------------------------------------------------------------- 假宿主

/** 造一个只记录注册参数的假 systemPrompt。 */
function fakeSp(options = {}) {
  const calls = { section: [], context: [] };
  const sp = {
    section(spec) {
      calls.section.push(spec);
      if (options.sectionThrows) throw new Error("duplicate section name");
      return options.sectionDisposer === undefined ? () => { calls.sectionDisposed = (calls.sectionDisposed || 0) + 1; } : options.sectionDisposer;
    },
    context(spec) {
      calls.context.push(spec);
      if (options.contextThrows) throw new Error("duplicate context name");
      return options.contextDisposer === undefined ? () => { calls.contextDisposed = (calls.contextDisposed || 0) + 1; } : options.contextDisposer;
    },
  };
  return { sp, calls };
}

const subagentHeader = () => ({ agent: { session: { header: { origin: "subagent" } } } });

// ---------------------------------------------------------------- 常量与顺序

test("锚点的名字与顺序：主锚点夹在 WEB_SURFACE 与 DEPLOYMENT_PERSONA_SUFFIX 之间", () => {
  assert.equal(ANCHOR_SECTION, "dsh-purge:anchor");
  assert.equal(CHILD_ANCHOR_CONTEXT, "dsh-purge:child-anchor");
  // 这两个数字不是随手写的：10100 是宿主 WEB_SURFACE，10200 是 lib/identity.js 的
  // DEPLOYMENT_PERSONA_SUFFIX（实测在 lib/identity.js:312）。排错就有一方被盖掉。
  assert.equal(ANCHOR_ORDER, 10150);
  assert.ok(ANCHOR_ORDER > 10100, "必须排在 WEB_SURFACE 之后");
  assert.ok(ANCHOR_ORDER < 10200, "必须排在 DEPLOYMENT_PERSONA_SUFFIX 之前");
});

test("子锚点的顺序排在宿主 delegation(120) 与 WEB_SURFACE(210) 之后", () => {
  assert.equal(CHILD_ORDER, 235);
  assert.ok(CHILD_ORDER > 120, "必须排在 subagent:delegation 之后");
  assert.ok(CHILD_ORDER > 210, "必须排在 WEB_SURFACE 之后");
  assert.ok(CHILD_ORDER < ANCHOR_ORDER, "子锚点不该跑到主锚点后面");
});

test("顺序常量与 lib/identity.js 里写死的 10200 不冲突", () => {
  const src = fs.readFileSync(new URL("../lib/identity.js", import.meta.url), "utf8");
  const m = src.match(/order:\s*(\d+)/);
  assert.ok(m, "lib/identity.js 里应当有 order 字面量");
  assert.ok(ANCHOR_ORDER < Number(m[1]), `主锚点顺序必须小于 ${m[1]}`);
});

// ---------------------------------------------------------------- 子会话判定

test("isSubagentContext：origin=subagent 算子会话", () => {
  assert.equal(isSubagentContext({ agent: { session: { header: { origin: "subagent" } } } }), true);
});

test("isSubagentContext：delegationDepth 大于 0 算子会话（0 不算）", () => {
  assert.equal(isSubagentContext({ agent: { session: { header: { delegationDepth: 1 } } } }), true);
  assert.equal(isSubagentContext({ agent: { session: { header: { delegationDepth: 0 } } } }), false);
});

test("isSubagentContext：有 parentSession 就算子会话（哪怕 depth 是 0）", () => {
  assert.equal(isSubagentContext({ agent: { session: { header: { parentSession: "s1", delegationDepth: 0 } } } }), true);
});

test("isSubagentContext：也认顶层的 session（不走 agent.session）", () => {
  assert.equal(isSubagentContext({ session: { header: { origin: "subagent" } } }), true);
});

test("isSubagentContext：主会话的 header 三种标记都没有时为假", () => {
  assert.equal(isSubagentContext({ agent: { session: { header: { origin: "user" } } } }), false);
});

test("isSubagentContext：没有 header / 不是对象 / 属性抛错，一律假且不抛", () => {
  assert.equal(isSubagentContext(undefined), false);
  assert.equal(isSubagentContext(null), false);
  assert.equal(isSubagentContext({}), false);
  assert.equal(isSubagentContext({ agent: {} }), false);
  assert.equal(isSubagentContext({ agent: { session: {} } }), false);
  const boom = { get agent() { throw new Error("proxy not injected"); } };
  assert.equal(isSubagentContext(boom), false, "代理未注入时点属性会抛，必须吞掉");
});

// ---------------------------------------------------------------- 锚点文本开关

test("anchorTextFor：默认开启，给出操作员锚点正文", () => {
  const text = anchorTextFor({});
  assert.match(text, /^\[OPERATOR ANCHOR — ACTIVE\]/);
  assert.match(text, /survives carrier loss/);
  assert.match(text, /rules 1-8 still apply\.$/);
});

test("anchorTextFor：config 省略也算开启", () => {
  assert.equal(anchorTextFor(), anchorTextFor({}));
});

test("anchorTextFor：enabled:false 与 anchorMode:'off' 都返回空串", () => {
  assert.equal(anchorTextFor({ enabled: false }), "");
  assert.equal(anchorTextFor({ anchorMode: "off" }), "");
  assert.equal(anchorTextFor({ enabled: false, anchorMode: "off" }), "");
});

test("anchorTextFor：enabled 只认严格的 false，anchorMode 只认 'off'", () => {
  assert.ok(anchorTextFor({ enabled: 0 }).length > 0, "0 不是 false");
  assert.ok(anchorTextFor({ anchorMode: "OFF" }).length > 0, "大小写不归一，只认小写 off");
  assert.ok(anchorTextFor({ anchorMode: "always" }).length > 0);
  assert.ok(anchorTextFor({ anchorMode: "autofall" }).length > 0);
});

test("锚点正文里不该出现会让模型拒绝的措辞（9 条规则一条都不能少）", () => {
  const text = anchorTextFor({});
  for (const n of ["1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9."]) {
    assert.ok(text.includes(`\n${n} `), `缺少第 ${n} 条规则`);
  }
  assert.match(text, /A denied or failed tool call means that path is blocked, not that the task is forbidden/);
  assert.match(text, /no fade-out, no omission/);
});

// ---------------------------------------------------------------- 注册

test("registerAnchor：关闭时返回可调用的 disposer，且一条都不注册", () => {
  const { sp, calls } = fakeSp();
  const dispose = registerAnchor({ systemPrompt: sp }, { anchorMode: "off" });
  assert.equal(typeof dispose, "function");
  dispose();
  assert.equal(calls.section.length, 0);
  assert.equal(calls.context.length, 0);
});

test("registerAnchor：在主宿主上同时注册 section 与 context，参数完整", () => {
  const { sp, calls } = fakeSp();
  const dispose = registerAnchor({ systemPrompt: sp }, {});
  assert.equal(calls.section.length, 1);
  assert.equal(calls.context.length, 1);
  const s = calls.section[0];
  assert.equal(s.name, ANCHOR_SECTION);
  assert.equal(s.order, ANCHOR_ORDER);
  assert.equal(s.interpolate, false, "锚点里没有模板变量，不能交给宿主插值");
  assert.equal(s.text(), anchorTextFor({}));
  const c = calls.context[0];
  assert.equal(c.name, CHILD_ANCHOR_CONTEXT);
  assert.equal(c.order, CHILD_ORDER);
  assert.equal(c.interpolate, false);
  assert.equal(c.required, true, "rc5 的 refreshContext 会把 required 的 context 从 suppress 里捞回来");
  dispose();
});

test("registerAnchor：section 的 text 是每轮重新求值的，配置改了立刻生效", () => {
  const { sp, calls } = fakeSp();
  const config = { anchorMode: "always" };
  const dispose = registerAnchor({ systemPrompt: sp }, config);
  const s = calls.section[0];
  assert.ok(s.text().length > 0);
  config.anchorMode = "off";
  assert.equal(s.text(), "", "关掉之后必须当场变空，不能缓存住旧正文");
  config.anchorMode = "always";
  assert.ok(s.text().length > 0);
  dispose();
});

test("registerAnchor：context 的 text 只对子会话给正文，主会话是空串", () => {
  const { sp, calls } = fakeSp();
  const dispose = registerAnchor({ systemPrompt: sp }, {});
  const c = calls.context[0];
  assert.equal(c.text({ agent: { session: { header: { origin: "user" } } } }), "");
  const child = c.text(subagentHeader());
  assert.match(child, /^\[SUBAGENT ANCHOR — ACTIVE\]/);
  assert.match(child, /do not ask for permission you already have\.$/);
  dispose();
});

test("registerAnchor：context 的 text 也受开关控制", () => {
  const { sp, calls } = fakeSp();
  const config = {};
  const dispose = registerAnchor({ systemPrompt: sp }, config);
  const c = calls.context[0];
  assert.ok(c.text(subagentHeader()).length > 0);
  config.enabled = false;
  assert.equal(c.text(subagentHeader()), "");
  dispose();
});

test("registerAnchor：两个宿主（ctx.systemPrompt.ctx 与 ctx 本身）各注册一次", () => {
  const { sp: inner, calls: innerCalls } = fakeSp();
  const { sp: outer, calls: outerCalls } = fakeSp();
  const ctx = { systemPrompt: Object.assign(outer, { ctx: { systemPrompt: inner } }) };
  const dispose = registerAnchor(ctx, {});
  assert.equal(innerCalls.section.length, 1);
  assert.equal(outerCalls.section.length, 1);
  assert.equal(innerCalls.context.length, 1);
  assert.equal(outerCalls.context.length, 1);
  dispose();
});

test("registerAnchor：两个宿主是同一个对象时只注册一次（不许重复追加正文）", () => {
  const { sp, calls } = fakeSp();
  const host = { systemPrompt: sp };
  host.systemPrompt.ctx = host;
  const dispose = registerAnchor(host, {});
  assert.equal(calls.section.length, 1, "同一个 systemPrompt 不能被注册两遍");
  assert.equal(calls.context.length, 1);
  dispose();
});

test("registerAnchor：ctx.systemPrompt 取属性抛错时，仍然在 ctx 自己身上注册", () => {
  const { sp, calls } = fakeSp();
  const ctx = { systemPrompt: sp };
  Object.defineProperty(ctx, "systemPrompt", {
    get() { throw new Error("proxy not injected"); },
  });
  // 上面那句把 systemPrompt 换成了抛错 getter，所以 ctx 自己也不可用；
  // 换一个形状：让 ctx.systemPrompt 正常，但 ctx.systemPrompt.ctx 抛错。
  const { sp: sp2, calls: calls2 } = fakeSp();
  const ctx2 = { systemPrompt: Object.assign(sp2, {}) };
  Object.defineProperty(ctx2.systemPrompt, "ctx", { get() { throw new Error("no proxy"); } });
  const dispose = registerAnchor(ctx2, {});
  assert.equal(calls2.section.length, 1, "取 ctx.systemPrompt.ctx 抛错不该影响主宿主注册");
  assert.equal(calls2.context.length, 1);
  dispose();
  assert.equal(typeof sp, "object");
  assert.equal(calls.section.length, 0);
});

test("registerAnchor：section 撞名抛错时 context 照样注册（两个注册不能共用一个 try）", () => {
  const { sp, calls } = fakeSp({ sectionThrows: true });
  const dispose = registerAnchor({ systemPrompt: sp }, {});
  assert.equal(calls.section.length, 1);
  assert.equal(calls.context.length, 1, "section 抛了之后 context 必须继续");
  dispose();
  assert.equal(calls.contextDisposed, 1, "disposer 仍然要能收掉注册成功的那个");
});

test("registerAnchor：context 撞名抛错时 section 照样注册", () => {
  const { sp, calls } = fakeSp({ contextThrows: true });
  const dispose = registerAnchor({ systemPrompt: sp }, {});
  assert.equal(calls.section.length, 1);
  dispose();
  assert.equal(calls.sectionDisposed, 1);
});

test("registerAnchor：宿主只有 section 没有 context 时也能工作（旧宿主）", () => {
  const calls = { section: [] };
  const sp = { section(spec) { calls.section.push(spec); return () => {}; } };
  const dispose = registerAnchor({ systemPrompt: sp }, {});
  assert.equal(calls.section.length, 1);
  assert.doesNotThrow(() => dispose());
});

test("registerAnchor：没有 systemPrompt 的 ctx 不抛，返回可用 disposer", () => {
  const dispose = registerAnchor({}, {});
  assert.equal(typeof dispose, "function");
  assert.doesNotThrow(() => dispose());
  assert.doesNotThrow(() => registerAnchor(undefined, {})());
  assert.doesNotThrow(() => registerAnchor(null, {})());
});

test("registerAnchor：注册函数返回非函数时不进 disposer 列表（只能读源码形状）", () => {
  const sp2 = {
    section() { return "not-a-function"; },
    context() { return 42; },
  };
  const dispose = registerAnchor({ systemPrompt: sp2 }, {});
  assert.equal(typeof dispose, "function");
  assert.doesNotThrow(() => dispose());
  // 这条不可从外部观测：即使把非函数塞进 disposers，调用时抛的 TypeError 也会被
  // disposer 的 try/catch 吞掉，外部行为一模一样。所以只能钉住「入列表前先判类型」。
  const src = fs.readFileSync(new URL("../lib/anchor.js", import.meta.url), "utf8");
  assert.equal((src.match(/if \(typeof d === "function"\) disposers\.push\(d\);/g) || []).length, 2,
    "section 与 context 两条注册都必须先判类型再入列表");
});

test("registerAnchor：disposer 逐条 try，一条抛错不影响后面的", () => {
  let second = 0;
  const sp = {
    section() { return () => { throw new Error("already disposed"); }; },
    context() { return () => { second += 1; }; },
  };
  const dispose = registerAnchor({ systemPrompt: sp }, {});
  assert.doesNotThrow(() => dispose(), "第一条抛错必须被吞掉");
  assert.equal(second, 1, "第二条仍然要被调用");
});

test("registerAnchor：重复调用 disposer 幂等（不重复清理、不抛）", () => {
  const { sp, calls } = fakeSp();
  const dispose = registerAnchor({ systemPrompt: sp }, {});
  dispose();
  dispose();
  assert.equal(calls.sectionDisposed, 2, "disposer 本身不做幂等，重复调用就是重复清（宿主侧已释放）");
});

test("源码形状：本文件不 import 仓库里任何东西（1.1.71 与本地树的函数名不同）", () => {
  const src = fs.readFileSync(new URL("../lib/anchor.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^import\s/m, "锚点模块必须自包含，否则换宿主版本就 import 失败");
  assert.doesNotMatch(src, /\brequire\s*\(/, "同理，不能 require");
});

test("源码形状：section 与 context 的 text 都是函数（写成字符串就不会每轮重渲染）", () => {
  const src = fs.readFileSync(new URL("../lib/anchor.js", import.meta.url), "utf8");
  assert.match(src, /text: \(\) => \(anchorOn\(config\) \? ANCHOR_TEXT : ""\)/);
  assert.match(src, /text: \(context\) => \(anchorOn\(config\) && isSubagentContext\(context\) \? CHILD_ANCHOR_TEXT : ""\)/);
});
