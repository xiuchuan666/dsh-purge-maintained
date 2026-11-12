// lib/live-cache.js 的回归测试。
//
// 守的是「改了开关 / 换了会话，提示词却没变」这一类静默失效：
// 缓存的命中条件一旦放宽，用户看到的是「设置不生效」，而控制台不会有任何报错。
// 所以这里不只测「命中」，更要测「不该命中的时候一定不命中」。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLiveCache, liveCacheSignature, sessionKeyOf } from "../lib/live-cache.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 一个「全部默认」的签名输入。每条用例只改一个字段，便于断言「改这个会失效」。
function baseParts(overrides = {}) {
  return {
    config: {},
    decision: { mode: "full", taskKind: "general" },
    redteam: false,
    policy: "fallback",
    revision: 0,
    session: "s1|/work",
    ...overrides,
  };
}

function sig(overrides) {
  return liveCacheSignature(baseParts(overrides));
}

test("同对象同签名命中，返回的是同一个值对象", () => {
  const cache = createLiveCache();
  const assembled = {};
  const value = { sections: [] };
  cache.set(assembled, "sig-a", value);
  assert.equal(cache.get(assembled, "sig-a"), value);
});

test("同对象换签名必须落空，否则改了开关看不到变化", () => {
  const cache = createLiveCache();
  const assembled = {};
  cache.set(assembled, "sig-a", { sections: [] });
  assert.equal(cache.get(assembled, "sig-b"), undefined);
});

test("换对象即使签名相同也必须落空（WeakMap 按对象隔离）", () => {
  const cache = createLiveCache();
  const first = {};
  const second = {};
  cache.set(first, "sig-a", { sections: [] });
  assert.equal(cache.get(second, "sig-a"), undefined);
});

test("没写入过的对象落空", () => {
  const cache = createLiveCache();
  assert.equal(cache.get({}, "sig-a"), undefined);
});

test("非对象 assembly 既不缓存也不抛（原始值不能当 WeakMap 键）", () => {
  const cache = createLiveCache();
  for (const bad of [null, undefined, "text", 42, true]) {
    assert.equal(cache.get(bad, "sig-a"), undefined);
    assert.doesNotThrow(() => cache.set(bad, "sig-a", { sections: [] }));
  }
});

test("非对象结果不写入，避免把 null 当成「已改写」缓存下来", () => {
  const cache = createLiveCache();
  const assembled = {};
  cache.set(assembled, "sig-a", null);
  cache.set(assembled, "sig-a", undefined);
  cache.set(assembled, "sig-a", "string");
  assert.equal(cache.get(assembled, "sig-a"), undefined);
});

test("空对象结果算有效结果（rewritePromptAssembly 可能返回 {}）", () => {
  const cache = createLiveCache();
  const assembled = {};
  const empty = {};
  cache.set(assembled, "sig-a", empty);
  assert.equal(cache.get(assembled, "sig-a"), empty);
});

test("覆盖写入后按最后一次签名判定", () => {
  const cache = createLiveCache();
  const assembled = {};
  cache.set(assembled, "sig-a", { tag: "a" });
  cache.set(assembled, "sig-b", { tag: "b" });
  assert.equal(cache.get(assembled, "sig-a"), undefined);
  assert.deepEqual(cache.get(assembled, "sig-b"), { tag: "b" });
});

// ---- 签名覆盖面：11 个输入，任一变化都必须换签名 ----

const FIELD_CASES = [
  ["enabled 关闭", { config: { enabled: false } }],
  ["capabilityProtocol 关闭", { config: { capabilityProtocol: false } }],
  ["stripMnemon 关闭", { config: { stripMnemon: false } }],
  ["anchorMode 改成 off", { config: { anchorMode: "off" } }],
  ["anchorMode 改成 always", { config: { anchorMode: "always" } }],
  ["subagentControl 关闭", { config: { subagentControl: false } }],
  ["decision.mode 变化", { decision: { mode: "minimal", taskKind: "general" } }],
  ["decision.taskKind 变化", { decision: { mode: "full", taskKind: "code" } }],
  ["进入演练台会话", { redteam: true }],
  ["workspace 策略改成 strict", { policy: "strict" }],
  ["提示词框版本号递增", { revision: 1 }],
  ["换会话 id", { session: "s2|/work" }],
  ["同会话换 cwd", { session: "s1|/other" }],
];

for (const [label, overrides] of FIELD_CASES) {
  test(`签名覆盖：${label}`, () => {
    assert.notEqual(sig(overrides), sig());
  });
}

test("签名稳定：同样输入两次算出同一个串", () => {
  assert.equal(sig(), sig());
  assert.equal(sig({ config: { anchorMode: "off" } }), sig({ config: { anchorMode: "off" } }));
});

test("显式 true 与省略等价（配置默认开启）", () => {
  assert.equal(
    sig({ config: { enabled: true, stripMnemon: true, capabilityProtocol: true, subagentControl: true } }),
    sig(),
  );
});

test("分隔符防碰撞：字段拼接不能靠「前段尾巴 + 后段头」凑出同一个串", () => {
  // anchorMode 不做枚举校验，用户真的可能写出 autofall 这种值。
  assert.notEqual(
    sig({ config: { anchorMode: "auto" }, policy: "fallback" }),
    sig({ config: { anchorMode: "autofall" }, policy: "back" }),
  );
  assert.notEqual(
    sig({ config: { anchorMode: "a" }, policy: "b" }),
    sig({ config: { anchorMode: "ab" }, policy: "" }),
  );
});

test("revision 是数字 0 与字符串 \"0\" 等价，缺省与空串等价", () => {
  assert.equal(sig({ revision: 0 }), sig({ revision: "0" }));
  assert.equal(sig({ revision: undefined }), sig({ revision: null }));
  assert.equal(sig({ revision: undefined }), sig({ revision: "" }));
});

test("revision 递增必须换签名（提示词框提交但 mtime 没变的情况）", () => {
  assert.notEqual(sig({ revision: 0 }), sig({ revision: 1 }));
});

test("缺省 decision 按 full/general 处理，不抛", () => {
  assert.equal(sig({ decision: undefined }), sig());
  assert.equal(sig({ decision: null }), sig());
});

test("config 缺省当作默认开启", () => {
  assert.equal(sig({ config: undefined }), sig({ config: {} }));
  assert.equal(sig({ config: null }), sig({ config: {} }));
});

// ---- sessionKeyOf ----

test("sessionKeyOf：优先 header.id，其次 sessionId，再退空串", () => {
  const wrap = (header) => ({ agent: { session: { header } } });
  assert.equal(sessionKeyOf(wrap({ id: "a", sessionId: "b", cwd: "/w" })), "a|/w");
  assert.equal(sessionKeyOf(wrap({ sessionId: "b", cwd: "/w" })), "b|/w");
  assert.equal(sessionKeyOf(wrap({ cwd: "/w" })), "|/w");
  assert.equal(sessionKeyOf(wrap({})), "|");
});

test("sessionKeyOf：没有 context / 没有 session 退化成 |，不抛", () => {
  // 与拆分前内联实现逐字一致：header 缺失时两边都取空串，仍带分隔符。
  assert.equal(sessionKeyOf(), "|");
  assert.equal(sessionKeyOf(null), "|");
  assert.equal(sessionKeyOf({}), "|");
  assert.equal(sessionKeyOf({ agent: {} }), "|");
});

test("sessionKeyOf：属性访问抛异常时返回空串（代理未注入时点属性会抛）", () => {
  const boom = {
    get agent() {
      throw new Error("proxy not injected");
    },
  };
  assert.equal(sessionKeyOf(boom), "");
});

test("sessionKeyOf：cwd 参与签名，换 cwd 必须换 key", () => {
  const a = sessionKeyOf({ agent: { session: { header: { id: "s", cwd: "/a" } } } });
  const b = sessionKeyOf({ agent: { session: { header: { id: "s", cwd: "/b" } } } });
  assert.notEqual(a, b);
});

// ---- 生产接线：真正持有 rewriteLiveAssembly 的那个文件必须用这套纯函数 ----
//
// 2026-11-13 批53 把 rewriteLiveAssembly 从 lib/index.js 搬进 lib/inject-write.js。
// 这组断言盯的是「缓存接线」，不是「它在哪个文件」，所以按持有者读：
// 逐个候选文件读出来，谁里面有 rewriteLiveAssembly 就断言谁。
// 这样以后再搬家不用改这五条，只要能找到持有者即可。

const WIRING_HOLDERS = ["lib/inject-write.js", "lib/index.js"].map((rel) => ({
  rel,
  text: fs.readFileSync(path.join(ROOT, rel), "utf8"),
}));

const holder = WIRING_HOLDERS.find((f) => f.text.includes("function rewriteLiveAssembly("));
if (!holder) throw new Error("找不到 rewriteLiveAssembly 的持有者，生产接线断言无从校验");

test("生产接线：持有 rewriteLiveAssembly 的文件用 createLiveCache 建缓存", () => {
  assert.match(holder.text, /const liveRewriteCache = createLiveCache\(\);/);
  assert.doesNotMatch(holder.text, /const liveRewriteCache = new WeakMap\(\);/);
});

test("生产接线：持有者用 liveCacheSignature 算签名，不再内联数组", () => {
  assert.match(holder.text, /const cacheSig = liveCacheSignature\(\{/);
  assert.doesNotMatch(holder.text, /const cacheSig = \[/);
});

test("生产接线：命中判定走 cache.get(obj, sig) 且必须比对 undefined", () => {
  // 缓存值可能是空对象，用 `if (cached)` 会把空对象当未命中，白算一遍；
  // 反过来用 `if (cached !== undefined)` 才是对的。
  assert.match(holder.text, /const cached = liveRewriteCache\.get\(assembled, cacheSig\);/);
  assert.match(holder.text, /if \(cached !== undefined\) return cached;/);
});

test("生产接线：写缓存走 cache.set(obj, sig, value)，不再手工拼 {sig, value}", () => {
  assert.match(holder.text, /liveRewriteCache\.set\(assembled, cacheSig, rewritten\);/);
  assert.doesNotMatch(holder.text, /liveRewriteCache\.set\(assembled, \{ sig: cacheSig/);
});

test("生产接线：会话签名来自 sessionKeyOf，不是就地读 header", () => {
  assert.match(holder.text, /session: sessionKeyOf\(context\)/);
});

test("生产接线：lib/index.js 里不再留内联缓存（搬走后不能有第二份）", () => {
  const indexText = WIRING_HOLDERS.find((f) => f.rel === "lib/index.js").text;
  assert.doesNotMatch(indexText, /new WeakMap\(\)/);
  assert.doesNotMatch(indexText, /liveRewriteCache\./);
});
