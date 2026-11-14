// `lib/rewind.js` 的第二批边角：服务查找、草稿过期、去隐藏、空白会话创建。
// 与 `scripts/test-rewind-edges.mjs` 分工：那一份钉「等轮次结束 / 收件箱清理 / 每会话串行」，
// 这一份钉「拿不到服务时怎么退」「草稿到点作废」「回退后原会话怎么藏」。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as r from "../lib/rewind.js";

const SRC = readFileSync(new URL("../lib/rewind.js", import.meta.url), "utf8");

const EVENTS = [
  { type: "user/message", seq: 0, data: { content: "hello" } },
  { type: "turn/start", seq: 1, data: { turn: 0 } },
  { type: "step/start", seq: 2, data: { turn: 0, step: 0 } },
  { type: "step/start", seq: 3, data: { turn: 0, step: 1 } },
  { type: "turn/end", seq: 4, data: { turn: 0 } },
];

/** 只认白名单里的服务名，其余一律 undefined —— 与真实 ctx.get 的行为一致。 */
function ctxOf(services) {
  return {
    get(name) {
      if (Object.hasOwn(services, name)) return services[name];
      return undefined;
    },
  };
}

function controllerOf(childId, extra = {}) {
  const calls = [];
  const controller = {
    fork: async (arg) => {
      calls.push(["fork", arg]);
      return { sessionId: childId };
    },
    create: async (arg) => {
      calls.push(["create", arg]);
      return { sessionId: childId };
    },
    inspect: async () => ({ events: EVENTS, meta: { cwd: "/w" } }),
    cancel: async () => {},
    archiveSession: async () => {},
    ...extra,
  };
  return { controller, calls };
}

test("service：拿不到服务时一律返回 undefined，不抛", () => {
  assert.equal(r.service(undefined, "sessions"), undefined);
  assert.equal(r.service({}, "sessions"), undefined);
  assert.equal(r.service({ get: () => null }, "sessions"), null);
  assert.equal(r.service({ get: (n) => `got:${n}` }, "agents"), "got:agents");
});

test("service：ctx.get 自己抛错时也返回 undefined，而不是把异常带出去", () => {
  const ctx = {
    get() {
      throw new Error("service boom");
    },
  };
  assert.equal(r.service(ctx, "sessions"), undefined);
});

test("isRoundPromptEvent：不认识的 source.kind 一律不算「这一轮发出去的那句」", () => {
  const ev = (source) => ({ type: "user/message", data: { source, content: "hi" } });
  assert.equal(r.isRoundPromptEvent(ev({ kind: "system" })), false);
  assert.equal(r.isRoundPromptEvent(ev({ kind: "tool" })), false);
  assert.equal(r.isRoundPromptEvent(ev({ kind: "goal" })), false, "goal 缺 round 不算");
  assert.equal(r.isRoundPromptEvent(ev({ kind: "goal", round: 0 })), true);
  assert.equal(r.isRoundPromptEvent(ev({ kind: "user" })), true);
  assert.equal(r.isRoundPromptEvent(ev(undefined)), true);
  assert.equal(r.isRoundPromptEvent(ev({ kind: "plugin" })), false);
});

test("planRewindStep：整段的最开头没有可退的边界时，模式是 blank 而不是 fork", () => {
  const plan = r.planRewindStep([
    { type: "user/message", seq: 0, data: { content: "hi" } },
    { type: "step/start", seq: 0, data: { turn: 0, step: 0 } },
  ]);
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, "blank");
  assert.equal(plan.text, "hi");
  assert.equal(plan.fromSeq, 0);
  assert.equal(plan.atSeq, undefined);
});

test("planRewindStep：既没有可退边界、也没有可带走的正文时给 Nothing to undo", () => {
  const plan = r.planRewindStep([{ type: "step/start", seq: 0, data: { turn: 0, step: 0 } }]);
  assert.deepEqual(plan, { ok: false, error: "Nothing to undo" });
});

test("readSessionLog：observeSession 的 disposer 一定被调用（不是靠 GC）", async () => {
  const disposed = [];
  const ctx = ctxOf({
    sessionQuery: {
      async observeSession() {
        return {
          events: [{ type: "user/message", seq: 0, data: { content: "obs" } }],
          header: { cwd: "/obs" },
          [Symbol.dispose]() {
            disposed.push("gone");
          },
        };
      },
    },
  });
  const log = await r.readSessionLog(ctx, "s1");
  assert.equal(log.events.length, 1);
  assert.equal(log.cwd, "/obs");
  assert.deepEqual(disposed, ["gone"]);
});

test("readSessionLog：disposer 自己抛错时吞掉，正文照常返回", async () => {
  const ctx = ctxOf({
    sessionQuery: {
      async observeSession() {
        return {
          events: [],
          header: {},
          [Symbol.dispose]() {
            throw new Error("dispose boom");
          },
        };
      },
    },
  });
  const log = await r.readSessionLog(ctx, "s1");
  assert.deepEqual(log.events, []);
});

test("getAgent：agents.get 抛错时返回 undefined，不把异常带出去", () => {
  const ctx = ctxOf({
    agents: {
      get() {
        throw new Error("agents boom");
      },
    },
  });
  assert.equal(r.getAgent(ctx, "s1"), undefined);
});

test("getAgent：只有 agent(id) 没有 get(id) 的宿主也能取到", () => {
  const ctx = ctxOf({ agents: { agent: (id) => ({ id }) } });
  assert.deepEqual(r.getAgent(ctx, "s9"), { id: "s9" });
  assert.equal(r.getAgent(ctxOf({}), "s9"), undefined);
});

test("resetRequestSeries：三个字段各自独立兜错，前一个抛不影响后两个", () => {
  const touched = [];
  const agent = {};
  Object.defineProperty(agent, "requestHeaderLogged", {
    set() {
      throw new Error("header boom");
    },
  });
  Object.defineProperty(agent, "requestSurfaceGeneration", {
    set(v) {
      touched.push(["gen", v]);
    },
  });
  Object.defineProperty(agent, "frozenMessages", {
    get() {
      return {
        clear() {
          touched.push(["clear"]);
        },
      };
    },
  });
  const ctx = ctxOf({ agents: { get: () => agent } });
  r.resetRequestSeries(ctx, "s1");
  assert.deepEqual(touched, [["gen", -1], ["clear"]]);
});

test("resetRequestSeries：frozenMessages 的 getter 自己抛错也被吞掉", () => {
  const agent = {};
  Object.defineProperty(agent, "requestHeaderLogged", { set() {} });
  Object.defineProperty(agent, "requestSurfaceGeneration", { set() {} });
  Object.defineProperty(agent, "frozenMessages", {
    get() {
      throw new Error("frozen boom");
    },
  });
  assert.doesNotThrow(() => r.resetRequestSeries(ctxOf({ agents: { get: () => agent } }), "s1"));
});

test("resetRequestSeries：会话没活着的 agent 时直接返回", () => {
  assert.doesNotThrow(() => r.resetRequestSeries(ctxOf({}), "s1"));
});

test("resolveMainSession：父子指针互指成环时，回到入口会话而不是死循环", async () => {
  const reads = [];
  const ctx = ctxOf({
    sessions: {
      get(id) {
        reads.push(id);
        return {
          snapshotEvents: () => [],
          header: { origin: "subagent", delegationDepth: 1, parentSession: id === "a" ? "b" : "a" },
        };
      },
    },
  });
  const target = await r.resolveMainSession(ctx, "a");
  assert.equal(target.sessionId, "a");
  assert.deepEqual(reads, ["a", "b", "a"]);
});

test("resolveMainSession：普通主力会话直接就是它自己", async () => {
  const ctx = ctxOf({
    sessions: {
      get: (id) => ({ snapshotEvents: () => [], header: { id } }),
    },
  });
  const target = await r.resolveMainSession(ctx, "main-1");
  assert.equal(target.sessionId, "main-1");
  assert.deepEqual(target.log.header, { id: "main-1" });
});

test("liveSession：sessions.get 抛错时返回 null", () => {
  const ctx = ctxOf({
    sessions: {
      get() {
        throw new Error("live boom");
      },
    },
  });
  assert.equal(r.liveSession(ctx, "s1"), null);
  assert.deepEqual(r.liveSession(ctxOf({ sessions: { get: (id) => ({ id }) } }), "s2"), { id: "s2" });
});

test("createBlank：工作区也找不到时用 create({})，不传空字符串参数", async () => {
  const { controller, calls } = controllerOf("blank-1");
  await r.createBlank(ctxOf({}), controller, "src", "");
  assert.deepEqual(calls, [["create", {}]]);
});

test("createBlank：只有 cwd 时按 cwd 建，工作区优先于 cwd", async () => {
  const { controller, calls } = controllerOf("blank-2");
  await r.createBlank(ctxOf({}), controller, "src", "/cwd");
  assert.deepEqual(calls[0], ["create", { cwd: "/cwd" }]);

  const registry = { list: () => [{ id: "w1", sessionIds: ["src"], path: "/cwd" }] };
  const second = controllerOf("blank-3");
  await r.createBlank(ctxOf({ workspaceRegistry: registry }), second.controller, "src", "/cwd");
  assert.deepEqual(second.calls[0], ["create", { workspaceId: "w1" }]);
});

test("findWorkspace：先按 sessionIds 找，再退回按路径找", () => {
  const registry = {
    list: () => [
      { id: "by-path", sessionIds: [], path: "/p" },
      { id: "by-session", sessionIds: ["s1"], path: "/other" },
    ],
  };
  const ctx = ctxOf({ workspaceRegistry: registry });
  assert.equal(r.findWorkspace(ctx, "s1").id, "by-session");
  assert.equal(r.findWorkspace(ctx, "nope", "/p").id, "by-path");
  assert.equal(r.findWorkspace(ctx, "nope"), undefined);
  assert.equal(r.findWorkspace(ctxOf({}), "s1"), undefined);
});

test("hideRewoundSource：工作区实体能 detachSession 时，把会话从列表里摘掉", async () => {
  const detached = [];
  const registry = {
    list: () => [{ id: "w1", sessionIds: ["s1"], path: "/p" }],
    get: (id) => ({
      id,
      async detachSession(sessionId) {
        detached.push(sessionId);
      },
    }),
  };
  const hidden = await r.hideRewoundSource(ctxOf({ workspaceRegistry: registry }), "s1");
  assert.equal(hidden, true);
  assert.deepEqual(detached, ["s1"]);
});

test("hideRewoundSource：没有任何藏匿手段时返回 false，不抛", async () => {
  assert.equal(await r.hideRewoundSource(ctxOf({}), "s1"), false);
  assert.equal(await r.hideRewoundSource(ctxOf({}), ""), false);
});

test("hideRewoundSource：workspaces 服务上的 archiveSession 也算数", async () => {
  const archived = [];
  const workspaces = {
    async archiveSession(sessionId) {
      archived.push(sessionId);
    },
  };
  const hidden = await r.hideRewoundSource(ctxOf({ workspaces }), "s1");
  assert.equal(hidden, true);
  assert.deepEqual(archived, ["s1"]);
});

test("hideRewoundSource：registry 与 workspaces 都能归档时，优先用 registry", async () => {
  const hits = [];
  const registry = {
    async archiveSession(sessionId) {
      hits.push(["registry", sessionId]);
    },
  };
  const workspaces = {
    async archiveSession(sessionId) {
      hits.push(["workspaces", sessionId]);
    },
  };
  const hidden = await r.hideRewoundSource(ctxOf({ workspaceRegistry: registry, workspaces }), "s1");
  assert.equal(hidden, true);
  assert.deepEqual(hits, [["registry", "s1"]]);
});

test("草稿到点作废：getDraft 与 getPending 都回 null，且草稿被真的删掉", async () => {
  const { controller } = controllerOf("child-ttl");
  const ctx = ctxOf({ sessionController: controller });
  const res = await r.rewindOneSession(ctx, controller, "s-ttl", { mode: "once" });
  assert.equal(res.ok, true);
  assert.equal(res.sessionId, "child-ttl");
  assert.equal(r.getDraft("child-ttl")?.sessionId, "child-ttl");

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 11 * 60 * 1000;
    assert.equal(r.getDraft("child-ttl"), null, "过期草稿要回 null");
    assert.equal(r.getPending(), null, "过期 pending 也要回 null");
    assert.equal(r.takeDraft("child-ttl"), null);
  } finally {
    Date.now = realNow;
  }
  // 过期那一次已经把记录删了，所以把时钟拨回来也读不到了。
  assert.equal(r.getDraft("child-ttl"), null);
  // pending 必须是被「真的清空」，而不是每次靠时间判据回 null —— 时钟拨回来之后也得是 null。
  assert.equal(r.getPending(), null);
});

test("源码形状：三条「到点作废」判据都还在，且过期时真的删记录", () => {
  assert.ok(SRC.includes("if (Date.now() - rec.at > DRAFT_TTL_MS) {"), "getDraft 的过期判据");
  assert.ok(SRC.includes("if (Date.now() - lastPending.at > DRAFT_TTL_MS) {"), "getPending 的过期判据");
  assert.ok(SRC.includes("pendingDrafts.delete(sessionId);"), "过期时要删草稿");
  assert.ok(SRC.includes("lastPending = null;"), "过期时要把 pending 清空");
  // 三个字段各自包一层 try：漏掉任一层的 catch 都会让「宿主字段只读」把整段回退搞挂。
  const region = SRC.slice(SRC.indexOf("function resetRequestSeries("), SRC.indexOf("export async function disarmRewoundSession("));
  assert.equal((region.match(/try \{/g) || []).length, 3, "resetRequestSeries 里必须是三段独立 try");
  assert.equal((region.match(/\} catch \{/g) || []).length, 3, "三段 try 各自要有 catch");
});
