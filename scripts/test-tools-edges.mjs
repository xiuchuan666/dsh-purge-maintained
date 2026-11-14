/**
 * `lib/redteam/tools.js` 的边角：参数封口、FIFO 上限、根会话上溯、实时并发核对、桩库。
 *
 * 为什么单独一份：`test-redteam-tools.mjs`（36 条）走的是 64 个工具的对外行为，
 * `test-tools-resolve.mjs`（26 条）走的是定义器解析与 subagent/end，两份都没碰
 * 这几个私有函数的分支 —— 而且真实参数面里没有一个 `type:'object'` 的嵌套节点
 * （实测 64 个 parameters 全树遍历，封口标记一个都没置位），对象分支只能直接调。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  sealObjectSchemas,
  makeDefineTool,
  capMap,
  sessionInfoOf,
  resolveRootSession,
  bindingKeyOf,
  liveRunningChildren,
  reservationList,
  apply,
} from "../lib/redteam/tools.js";

const SRC = readFileSync(new URL("../lib/redteam/tools.js", import.meta.url), "utf8");

function openExec(session) {
  return { agent: { session } };
}

function fakeCtx(opts = {}) {
  const tools = [];
  const warns = [];
  const effects = [];
  const handlers = [];
  const ctx = {
    defineTool: (spec) => ({ ...spec }),
    tools: { register: (tool) => tools.push(tool) },
    effect: (factory) => {
      effects.push(factory);
      return () => {};
    },
    on: (event, handler) => {
      handlers.push([event, handler]);
      return () => {};
    },
    get: () => undefined,
    logger: { warn: (msg) => warns.push(msg) },
  };
  if (opts.redteamThrows === true) {
    Object.defineProperty(ctx, "redteam", {
      configurable: true,
      get() {
        throw new Error("redteam getter boom");
      },
    });
  } else if (opts.redteam !== undefined) {
    ctx.redteam = opts.redteam;
  }
  return { ctx, tools, warns, effects, handlers };
}

test("sealObjectSchemas：数组逐项递归，本身不加 additionalProperties", () => {
  const node = { type: "array", items: [{ type: "object" }, { type: "object", properties: {} }] };
  const out = sealObjectSchemas(node);
  assert.equal(out, node);
  assert.equal(node.additionalProperties, undefined);
  assert.equal(node.items[0].additionalProperties, true);
  assert.equal(node.items[1].additionalProperties, false);
});

test("sealObjectSchemas：没有 properties 的对象封成 true，有 properties 的封成 false", () => {
  const bare = sealObjectSchemas({ type: "object" });
  assert.equal(bare.additionalProperties, true);
  const withProps = sealObjectSchemas({ type: "object", properties: { a: { type: "string" } } });
  assert.equal(withProps.additionalProperties, false);
});

test("sealObjectSchemas：已经封过的不覆盖", () => {
  const node = { type: "object", additionalProperties: true, properties: { a: { type: "string" } } };
  assert.equal(sealObjectSchemas(node).additionalProperties, true);
});

test("sealObjectSchemas：properties 里嵌套的对象也被递归封口", () => {
  const node = { type: "object", properties: { inner: { type: "object" } } };
  sealObjectSchemas(node);
  assert.equal(node.additionalProperties, false);
  assert.equal(node.properties.inner.additionalProperties, true);
});

test("sealObjectSchemas：additionalProperties 是对象时也递归下去", () => {
  const node = { type: "object", additionalProperties: { type: "object", properties: { k: { type: "string" } } } };
  sealObjectSchemas(node);
  assert.equal(node.additionalProperties.additionalProperties, false);
  assert.equal(node.additionalProperties.properties.k.additionalProperties, undefined);
});

test("sealObjectSchemas：非对象原样返回，null / 字符串 / 数字不抛", () => {
  assert.equal(sealObjectSchemas(null), null);
  assert.equal(sealObjectSchemas(undefined), undefined);
  assert.equal(sealObjectSchemas("x"), "x");
  assert.equal(sealObjectSchemas(42), 42);
});

test("makeDefineTool：spec.parameters 与返回值的 parameters / inputSchema / schema 四处都封口", () => {
  const seen = [];
  const defineTool = makeDefineTool((spec) => {
    seen.push(spec);
    return {
      parameters: { type: "object" },
      inputSchema: { type: "object" },
      schema: { type: "object" },
    };
  });
  const tool = defineTool({ parameters: { type: "object" } });
  assert.equal(seen[0].parameters.additionalProperties, true);
  assert.equal(tool.parameters.additionalProperties, true);
  assert.equal(tool.inputSchema.additionalProperties, true);
  assert.equal(tool.schema.additionalProperties, true);
});

test("makeDefineTool：没有 parameters 的 spec 与返回 undefined 的定义器都不抛", () => {
  const defineTool = makeDefineTool(() => undefined);
  assert.equal(defineTool({}), undefined);
  assert.equal(defineTool(null), undefined);
});

test("capMap：满员后新键进来先淘汰最早的键", () => {
  const m = new Map();
  capMap(m, 2);
  m.set("a", 1);
  m.set("b", 2);
  m.set("c", 3);
  assert.deepEqual([...m.keys()], ["b", "c"]);
});

test("capMap：已存在的键重设不触发淘汰，容量没满也不删", () => {
  const m = new Map();
  capMap(m, 2);
  m.set("a", 1);
  m.set("a", 2);
  assert.deepEqual([...m.keys()], ["a"]);
  assert.equal(m.get("a"), 2);
  m.set("b", 3);
  assert.deepEqual([...m.keys()], ["a", "b"]);
});

test("sessionInfoOf：没有 agent / session 时回空对象", () => {
  assert.deepEqual(sessionInfoOf(undefined), {});
  assert.deepEqual(sessionInfoOf({}), {});
  assert.deepEqual(sessionInfoOf({ agent: {} }), {});
  assert.deepEqual(sessionInfoOf({ agent: { session: null } }), {});
});

test("sessionInfoOf：header 读取抛错时 parentId 记 undefined，id 照常给", () => {
  const session = { id: 7 };
  Object.defineProperty(session, "header", {
    configurable: true,
    get() {
      throw new Error("header boom");
    },
  });
  const info = sessionInfoOf({ agent: { session } });
  assert.equal(info.id, "7");
  assert.equal(info.parentId, undefined);
  assert.equal(info.session, session);
});

test("resolveRootSession：没有父会话时根就是自己", () => {
  const r = resolveRootSession({ id: "solo" });
  assert.deepEqual(r, { rootId: "solo", chain: ["solo"] });
});

test("resolveRootSession：父会话不在内存时用父 id 当稳定根键", () => {
  // store.get 返回 undefined —— 父被回收 / 冷启动
  const r = resolveRootSession({ id: "child", header: { parentSession: "gone" }, store: { get: () => undefined } });
  assert.deepEqual(r, { rootId: "gone", chain: ["child", "gone"] });
});

test("resolveRootSession：store.get 抛错与父不在内存同一条早退", () => {
  const store = {
    get() {
      throw new Error("store boom");
    },
  };
  const r = resolveRootSession({ id: "c2", header: { parentSession: "p2" }, store });
  assert.deepEqual(r, { rootId: "p2", chain: ["c2", "p2"] });
});

test("resolveRootSession：一路能取到父会话时上溯到最顶层", () => {
  const top = { id: "top" };
  const mid = { id: "mid", header: { parentSession: "top" }, store: { get: () => top } };
  const leaf = { id: "leaf", header: { parentSession: "mid" }, store: { get: () => mid } };
  const r = resolveRootSession(leaf);
  assert.deepEqual(r, { rootId: "top", chain: ["leaf", "mid", "top"] });
});

test("resolveRootSession：父子互指的死环在上限处停下，不死循环", () => {
  const a = { id: "a", header: { parentSession: "b" } };
  const b = { id: "b", header: { parentSession: "a" } };
  a.store = { get: () => b };
  b.store = { get: () => a };
  const r = resolveRootSession(a);
  assert.equal(r.chain.length, 64);
  assert.equal(r.chain[0], "a");
  assert.equal(r.chain[63], "b");
  assert.equal(r.rootId, "b");
});

test("bindingKeyOf：没有会话时三项都是空", () => {
  assert.deepEqual(bindingKeyOf({}), { rootId: undefined, sessionId: undefined, chain: [] });
});

test("bindingKeyOf：子会话拿到父的 rootId，chain 保留中间层", () => {
  const top = { id: "top" };
  const mid = { id: "mid", header: { parentSession: "top" }, store: { get: () => top } };
  const r = bindingKeyOf({ agent: { session: mid } });
  assert.equal(r.rootId, "top");
  assert.equal(r.sessionId, "mid");
  assert.deepEqual(r.chain, ["mid", "top"]);
});

test("reservationList：没预留过的根会话回空数组", () => {
  assert.deepEqual(reservationList("never-seen-root"), []);
});

test("liveRunningChildren：只数 kind=child 且 activity=running 的，label 缺省用 id", async () => {
  const ctx = {
    get: () => ({
      listChildren: async () => [
        { kind: "child", activity: "running", label: "recon" },
        { kind: "child", activity: "running", id: "c-2" },
        { kind: "child", activity: "idle", id: "c-3" },
        { kind: "other", activity: "running", id: "c-4" },
        null,
      ],
    }),
  };
  const r = await liveRunningChildren(ctx, "root");
  assert.equal(r.available, true);
  assert.equal(r.running, 2);
  assert.deepEqual(r.running_labels, ["recon", "c-2"]);
  assert.equal(r.total_children, 3);
});

test("liveRunningChildren：listChildren 抛错时给「列子会话失败」，不往外抛", async () => {
  const ctx = {
    get: () => ({
      listChildren: async () => {
        throw new Error("list boom");
      },
    }),
  };
  const r = await liveRunningChildren(ctx, "root");
  assert.equal(r.available, false);
  assert.equal(r.running, 0);
  assert.equal(r.error, "列子会话失败：list boom");
});

test("liveRunningChildren：没有 subagents 服务（或没有 listChildren）时说清为什么核不了", async () => {
  for (const subagents of [undefined, null, {}]) {
    const r = await liveRunningChildren({ get: () => subagents }, "root");
    assert.equal(r.available, false);
    assert.equal(r.running, 0);
    assert.match(r.error, /subagents 注册表不可用/);
  }
});

test("liveRunningChildren：listChildren 返回非数组时按空表处理", async () => {
  const r = await liveRunningChildren({ get: () => ({ listChildren: async () => null }) }, "root");
  assert.equal(r.available, true);
  assert.equal(r.running, 0);
  assert.equal(r.total_children, 0);
});

test("apply：ctx.redteam 的 getter 抛错时只 warn 一条，64 个工具照常注册", () => {
  const { ctx, tools, warns } = fakeCtx({ redteamThrows: true });
  apply(ctx);
  assert.equal(tools.length, 64);
  assert.deepEqual(warns, ["redteam-tools: host ctx.redteam unavailable — tools will report store_missing"]);
});

test("apply：拿不到 store 时用桩库，调 openEngagement 报「红队资产库不可用」而不是 TypeError", () => {
  const { ctx, tools } = fakeCtx({});
  apply(ctx);
  const open = tools.find((t) => t.name === "redteam_engagement_open");
  assert.notEqual(open, undefined);
  return open.execute({ target: "示例" }, { agent: { session: { id: "s-stub" } } }).then((text) => {
    assert.match(String(text), /红队资产库不可用/);
  });
});

test("源码形状：loadDefineTool 的兜底那句仍在，桩库三件套齐全", () => {
  assert.ok(SRC.includes("return resolveDefineTool(defineToolCandidates())"));
  assert.ok(SRC.includes("openEngagement: () => { throw new Error('红队资产库不可用') }"));
  assert.ok(SRC.includes("listEngagements: () => []"));
  assert.ok(SRC.includes("stats: () => ({})"));
});
