/**
 * lib/continue-retry.js 决定两件事：请求出错要不要自动重试、一轮结束后要不要自动发「继续」。
 *
 * 它坏掉的表现都很安静：
 *   - 该重试的不重试 → 一次网络抖动就把整轮任务停在那里，用户以为模型卡住了；
 *   - 不该重试的也重试 → 配额/鉴权错误反复打，越打越糟；
 *   - 自动续跑关不掉 → 用户还在打字，插件先替他发了一条，抢了输入框。
 *
 * 这些判据全是纯函数（除了 `installContinueRetry` 挂钩子），所以这里钉住行为，
 * 不碰真实会话。`installContinueRetry` 只测「挂了什么钩子 / 什么时候不动作」，
 * 真跑一轮 agent 需要宿主，属 docs/test-map.md 第十节列的盲区。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CONTINUE_RETRY,
  clampCount,
  createTracker,
  failureCodeOf,
  hasFreshHumanTurn,
  inboxBusy,
  inspectTurn,
  installContinueRetry,
  isAbnormalReason,
  isPermanentFailure,
  isUserAbort,
  lastTurnEnd,
  loadSettings,
  makeContinueMessage,
  mergeConfig,
  normalizeConfig,
  sendContinue,
  sessionEventsOf,
  settingsPath,
  shouldAutoContinue,
  shouldAutoRetry,
} from "../lib/continue-retry.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-continue-"));
test.after(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发 EPERM */
  }
});

const end = (seq, reason) => ({ type: "turn/end", seq, data: { turn: 1, reason } });
const userMsg = (seq, kind = "user") => ({ type: "user/message", seq, data: { source: { kind } } });

// ---------------------------------------------------------------------------
// 配置：clampCount / normalizeConfig / mergeConfig
// ---------------------------------------------------------------------------

test("clampCount：非有限值回落默认，负数夹到 0，超过 20 夹到 20，小数截断", () => {
  assert.equal(clampCount(undefined), 3);
  assert.equal(clampCount("abc"), 3);
  assert.equal(clampCount(NaN), 3);
  assert.equal(clampCount(Infinity), 3);
  assert.equal(clampCount(-5), 0);
  assert.equal(clampCount(0), 0);
  assert.equal(clampCount(21), 20);
  assert.equal(clampCount(999), 20);
  assert.equal(clampCount(3.9), 3);
  assert.equal(clampCount("7"), 7);
  assert.equal(clampCount(undefined, 5), 5);
});

test("normalizeConfig：默认值原样，字符串数字会被接受", () => {
  assert.deepEqual(normalizeConfig(), {
    autoRetry: true,
    retryMax: 3,
    autoContinue: false,
    continueMax: 3,
    continueText: "继续",
  });
  const c = normalizeConfig({ retryMax: "5", continueMax: "2" });
  assert.equal(c.retryMax, 5);
  assert.equal(c.continueMax, 2);
});

test("normalizeConfig：retryMax 归零时 autoRetry 一起关掉", () => {
  assert.equal(normalizeConfig({ retryMax: 0 }).autoRetry, false);
  assert.equal(normalizeConfig({ retryMax: 0, autoRetry: true }).autoRetry, false);
  assert.equal(normalizeConfig({ retryMax: 1, autoRetry: false }).autoRetry, false);
});

test("normalizeConfig：autoContinue 必须显式 true 且 continueMax > 0", () => {
  assert.equal(normalizeConfig({ autoContinue: true }).autoContinue, true);
  assert.equal(normalizeConfig({ autoContinue: "true" }).autoContinue, false, "只认布尔 true");
  assert.equal(normalizeConfig({ autoContinue: 1 }).autoContinue, false);
  assert.equal(normalizeConfig({ autoContinue: true, continueMax: 0 }).autoContinue, false);
});

test("normalizeConfig：continueText 去空白，空串回落默认文案", () => {
  assert.equal(normalizeConfig({ continueText: "  接着干 " }).continueText, "接着干");
  assert.equal(normalizeConfig({ continueText: "   " }).continueText, "继续");
  assert.equal(normalizeConfig({ continueText: 123 }).continueText, "继续");
  assert.equal(normalizeConfig({ continueText: "" }).continueText, "继续");
});

test("normalizeConfig：非对象入参不抛", () => {
  assert.equal(normalizeConfig(null).retryMax, 3);
  assert.equal(normalizeConfig("x").retryMax, 3);
});

test("mergeConfig：保存的设置压过插件配置，但 autoContinue 不许被 saved 偷偷打开", () => {
  const merged = mergeConfig({ autoRetry: true }, { autoContinue: true, retryMax: 5 });
  assert.equal(merged.autoContinue, false, "插件配置没显式开，saved 里写了 true 也不能开");
  assert.equal(merged.retryMax, 5);
  assert.equal(mergeConfig({ autoContinue: true }, {}).autoContinue, true);
  assert.equal(mergeConfig({ autoContinue: true }, { autoContinue: false }).autoContinue, false);
});

test("loadSettings：缺文件、坏 JSON、非对象都返回空对象", () => {
  const home = path.join(sandbox, "home-a");
  assert.deepEqual(loadSettings(home), {});
  fs.mkdirSync(path.dirname(settingsPath(home)), { recursive: true });
  fs.writeFileSync(settingsPath(home), "{broken");
  assert.deepEqual(loadSettings(home), {});
  fs.writeFileSync(settingsPath(home), "[1,2]");
  assert.deepEqual(loadSettings(home), [1, 2], "数组也是对象，原样返回");
  fs.writeFileSync(settingsPath(home), JSON.stringify({ retryMax: 7 }));
  assert.deepEqual(loadSettings(home), { retryMax: 7 });
});

test("settingsPath：落在 <dshHome>/dsh-purge/continue-retry.json", () => {
  assert.equal(settingsPath("H:/x"), path.join("H:/x", "dsh-purge", "continue-retry.json"));
});

// ---------------------------------------------------------------------------
// 失败分类：哪一类错误还能再试一次
// ---------------------------------------------------------------------------

test("isAbnormalReason：只有 error / aborted / interrupted / max-tokens 算异常结束", () => {
  for (const kind of ["error", "aborted", "interrupted", "max-tokens"]) {
    assert.equal(isAbnormalReason({ kind }), true, kind);
  }
  for (const kind of ["completed", "blocked", "", undefined]) {
    assert.equal(isAbnormalReason({ kind }), false, String(kind));
  }
  assert.equal(isAbnormalReason(null), false);
});

test("isUserAbort：认 user / cancel，字符串与对象两种写法都认", () => {
  assert.equal(isUserAbort({ kind: "aborted", reason: "user" }), true);
  assert.equal(isUserAbort({ kind: "aborted", reason: "cancel" }), true);
  assert.equal(isUserAbort({ kind: "aborted", reason: { kind: "user" } }), true);
  assert.equal(isUserAbort({ kind: "aborted", reason: { kind: "cancel" } }), true);
  assert.equal(isUserAbort({ kind: "aborted", reason: "timeout" }), false);
  assert.equal(isUserAbort({ kind: "error", reason: "user" }), false, "不是 aborted 就不算用户取消");
  assert.equal(isUserAbort(null), false);
});

test("failureCodeOf：error.code > failure.code > code，一律转大写", () => {
  assert.equal(failureCodeOf({ error: { code: "auth" } }), "AUTH");
  assert.equal(failureCodeOf({ failure: { code: "quota" } }), "QUOTA");
  assert.equal(failureCodeOf({ code: "transport" }), "TRANSPORT");
  assert.equal(failureCodeOf({ error: { code: "AUTH" }, failure: { code: "QUOTA" } }), "AUTH");
  assert.equal(failureCodeOf({ error: { code: "" }, failure: { code: "QUOTA" } }), "", "空串不往下穿");
  assert.equal(failureCodeOf({}), "");
  assert.equal(failureCodeOf(null), "");
});

test("isPermanentFailure：鉴权 / 配额 / 上下文超限 / 缺凭据都算永久", () => {
  for (const code of ["AUTH", "unauthorized", "QUOTA", "BILLING", "CONTEXT_OVERFLOW", "MISSING_CREDENTIAL"]) {
    assert.equal(isPermanentFailure(code), true, code);
  }
  for (const code of ["TRANSPORT", "RATE_LIMIT", "", undefined, "UNKNOWN"]) {
    assert.equal(isPermanentFailure(code), false, String(code));
  }
});

test("shouldAutoRetry：signal 已中止就不重试，永久失败也不重试", () => {
  assert.equal(shouldAutoRetry({ code: "TRANSPORT" }, { aborted: true }), false);
  assert.equal(shouldAutoRetry({ code: "TRANSPORT" }, {}), true);
  assert.equal(shouldAutoRetry({ code: "AUTH" }, {}), false);
  assert.equal(shouldAutoRetry({}, {}), true, "没有 code 视为可重试");
  assert.equal(shouldAutoRetry(null, null), true);
});

test("shouldAutoContinue：异常结束且不是用户取消、也不是永久码才续跑", () => {
  assert.equal(shouldAutoContinue({ kind: "error" }), true);
  assert.equal(shouldAutoContinue({ kind: "max-tokens" }), true);
  assert.equal(shouldAutoContinue({ kind: "completed" }), false);
  assert.equal(shouldAutoContinue({ kind: "aborted", reason: "user" }), false);
  assert.equal(shouldAutoContinue({ kind: "error", error: { code: "AUTH" } }), false);
  assert.equal(shouldAutoContinue({ kind: "error", error: { code: "TRANSPORT" } }), false, "TRANSPORT 官方已重试过");
  assert.equal(shouldAutoContinue({ kind: "error", error: { code: "RATE_LIMIT" } }), false);
  assert.equal(shouldAutoContinue({ kind: "error", error: { code: "SOMETHING_NEW" } }), true);
});

// ---------------------------------------------------------------------------
// 事件读取：哪一轮结束了、之后有没有真人说话
// ---------------------------------------------------------------------------

test("lastTurnEnd：取最后一条 turn/end，没有就返回 null", () => {
  assert.equal(lastTurnEnd([]), null);
  assert.equal(lastTurnEnd(null), null);
  assert.equal(lastTurnEnd([{ type: "user/message", seq: 0 }]), null);
  const events = [end(3, { kind: "completed" }), end(9, { kind: "error" })];
  assert.equal(lastTurnEnd(events).seq, 9);
});

test("inspectTurn：把最后一轮的结束原因整理成一份判定", () => {
  assert.deepEqual(inspectTurn([]), {
    seq: 0,
    turn: 0,
    reason: null,
    abnormal: false,
    userAbort: false,
    auto: false,
  });
  const info = inspectTurn([{ type: "turn/end", seq: 12, data: { turn: 4, reason: { kind: "error" } } }]);
  assert.equal(info.seq, 12);
  assert.equal(info.turn, 4);
  assert.equal(info.abnormal, true);
  assert.equal(info.userAbort, false);
  assert.equal(info.auto, true);
});

test("hasFreshHumanTurn：只认 turn/end 之后的真人消息，插件自己的不算", () => {
  const e = end(5, { kind: "completed" });
  assert.equal(hasFreshHumanTurn([e]), false);
  assert.equal(hasFreshHumanTurn([e, userMsg(6)]), true);
  assert.equal(hasFreshHumanTurn([e, userMsg(6, "plugin")]), false);
  assert.equal(hasFreshHumanTurn([e, userMsg(6, "dsh-purge")]), false, "自动续跑自己发的那条不能算真人");
  assert.equal(
    hasFreshHumanTurn([userMsg(1), e]),
    false,
    "本轮开始前那条真人消息已经被消费掉了，不能算「刚说过话」",
  );
  assert.equal(hasFreshHumanTurn([userMsg(1)]), true, "还没有 turn/end 时全表都算");
  assert.equal(hasFreshHumanTurn([]), false);
  assert.equal(hasFreshHumanTurn(null), false);
});

test("inboxBusy：hasPending / size / length 三种形状都认", () => {
  assert.equal(inboxBusy({ inbox: { hasPending: () => true } }), true);
  assert.equal(inboxBusy({ inbox: { hasPending: () => false } }), false);
  assert.equal(inboxBusy({ inbox: { size: 2 } }), true);
  assert.equal(inboxBusy({ inbox: { length: 1 } }), true);
  assert.equal(inboxBusy({ inbox: { size: 0, length: 0 } }), false);
  assert.equal(inboxBusy({}), false);
  assert.equal(inboxBusy(null), false);
  assert.equal(
    inboxBusy({
      inbox: {
        get hasPending() {
          throw new Error("boom");
        },
      },
    }),
    false,
    "读 inbox 抛错时当作不忙，不能把状态机卡死",
  );
});

test("sessionEventsOf：优先 snapshotEvents，其次 events 数组，都没有给空数组", () => {
  assert.deepEqual(sessionEventsOf({ session: { snapshotEvents: () => [1, 2] } }), [1, 2]);
  assert.deepEqual(sessionEventsOf({ session: { events: [3] } }), [3]);
  assert.deepEqual(
    sessionEventsOf({
      session: {
        snapshotEvents: () => {
          throw new Error("boom");
        },
        events: [4],
      },
    }),
    [4],
    "snapshotEvents 抛错要退到 events",
  );
  assert.deepEqual(sessionEventsOf({ session: { snapshotEvents: () => null } }), []);
  assert.deepEqual(sessionEventsOf({}), []);
  assert.deepEqual(sessionEventsOf(null), []);
});

// ---------------------------------------------------------------------------
// 发消息
// ---------------------------------------------------------------------------

test("makeContinueMessage：形状固定，id 带前缀且每次不同", () => {
  const a = makeContinueMessage("继续");
  const b = makeContinueMessage("继续");
  assert.equal(a.role, "user");
  assert.deepEqual(a.content, [{ type: "text", text: "继续" }]);
  assert.deepEqual(a.source, { kind: "dsh-purge", form: "notice", summary: "continue" });
  assert.match(a.id, /^dsh-purge-continue-/);
  assert.notEqual(a.id, b.id);
});

test("makeContinueMessage：空文案回落默认，前后空白会去掉", () => {
  assert.equal(makeContinueMessage("").content[0].text, DEFAULT_CONTINUE_RETRY.continueText);
  assert.equal(makeContinueMessage("   ").content[0].text, DEFAULT_CONTINUE_RETRY.continueText);
  assert.equal(makeContinueMessage(null).content[0].text, DEFAULT_CONTINUE_RETRY.continueText);
  assert.equal(makeContinueMessage("  接着 ").content[0].text, "接着");
});

test("sendContinue：没有 agent 或没有 followup 时返回可读错误，不抛", () => {
  assert.deepEqual(sendContinue(null, "继续"), {
    ok: false,
    error: "No agent in this session to continue",
  });
  assert.equal(sendContinue({}, "继续").ok, false);
  const sent = [];
  assert.deepEqual(sendContinue({ followup: (m) => sent.push(m) }, "走"), { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content[0].text, "走");
  const failed = sendContinue(
    {
      followup: () => {
        throw new Error("inbox full");
      },
    },
    "走",
  );
  assert.deepEqual(failed, { ok: false, error: "inbox full" });
});

// ---------------------------------------------------------------------------
// 预算：createTracker
// ---------------------------------------------------------------------------

test("tracker.takeRetry：按 max 计数，同一个 key 不重复消耗", () => {
  const t = createTracker();
  assert.equal(t.takeRetry("s1", "1:0:AUTH", 2), true);
  assert.equal(t.takeRetry("s1", "1:0:AUTH", 2), false, "同一个失败点只试一次");
  assert.equal(t.takeRetry("s1", "2:0:AUTH", 2), true);
  assert.equal(t.takeRetry("s1", "3:0:AUTH", 2), false, "预算用完");
  assert.equal(t.takeRetry("s2", "1:0:AUTH", 2), true, "换会话重新计数");
});

test("tracker.takeRetry：max <= 0 时一次都不给，没有会话 id 时也不给", () => {
  const t = createTracker();
  assert.equal(t.takeRetry("s1", "k", 0), false);
  assert.equal(t.takeRetry("", "k", 3), false);
  assert.equal(t.takeRetry(null, "k", 3), false);
});

test("tracker.takeContinue：按 max 计数，同一个 seq 不重复消耗", () => {
  const t = createTracker();
  assert.equal(t.takeContinue("s1", 10, 2), true);
  assert.equal(t.takeContinue("s1", 10, 2), false, "同一轮结束点不重复续跑");
  assert.equal(t.takeContinue("s1", 11, 2), true);
  assert.equal(t.takeContinue("s1", 12, 2), false, "预算用完");
});

test("tracker.takeContinue：连续失败到 maxFailStreak 后永久停手（Issue #85）", () => {
  const t = createTracker();
  for (let i = 1; i <= 3; i += 1) {
    assert.equal(t.takeContinue("s1", i, 10), true, `第 ${i} 次`);
    t.refundContinue("s1", i);
  }
  assert.equal(t.takeContinue("s1", 4, 10), false, "连续失败 3 次后不再续跑");
  assert.equal(t.takeContinue("s2", 4, 10), true, "换会话不受影响");
});

test("tracker.refundContinue：退还名额但不清 seq，避免同一失败点反复消耗", () => {
  const t = createTracker();
  assert.equal(t.takeContinue("s1", 5, 3), true);
  t.refundContinue("s1", 5);
  assert.equal(t.takeContinue("s1", 5, 3), false, "同一 seq 退回来也不许再发");
  assert.equal(t.takeContinue("s1", 6, 3), true, "换 seq 可以继续");
});

test("tracker.refundContinue：没有消耗过时是空操作，不会把计数打成负数", () => {
  const t = createTracker();
  t.refundContinue("s1", 1);
  assert.equal(t.takeContinue("s1", 2, 1), true);
  assert.equal(t.takeContinue("s1", 3, 1), false);
});

test("tracker.resetIfCompleted：正常结束会清掉计数与失败记录", () => {
  const t = createTracker();
  // 先把失败连击攒满：三次「取了又退」→ failStreak = 3
  for (let i = 1; i <= 3; i += 1) {
    assert.equal(t.takeContinue("s1", i, 10), true);
    t.refundContinue("s1", i);
  }
  assert.equal(t.takeContinue("s1", 4, 10), false, "连击满了就不再续跑");
  t.resetIfCompleted("s1", { kind: "completed" });
  assert.equal(t.takeContinue("s1", 5, 10), true, "正常结束后失败连击清零，可以重新开始");
  // 说明：resetIfCompleted 里那两行 `cur.failStreak = 0; cur.failedSeqs = undefined;`
  // 实际上是冗余的——紧接着的 this.reset(sessionId) 会把整条会话记录删掉，
  // 所以「单独改这两行」在外部完全观测不到（RED 演练里这一改是 GREEN）。
  // 这里钉的是对外可见的语义：完成后可以重新开始，且 seq 记录也一并清掉。
  t.resetIfCompleted("s1", { kind: "completed" });
  assert.equal(t.takeContinue("s1", 5, 10), true, "reset 后 seq 记录也清了，同一 seq 可以再用");
});

test("tracker.resetIfCompleted：blocked 也算结束，error 不算", () => {
  const t = createTracker();
  t.takeContinue("s1", 1, 1);
  t.resetIfCompleted("s1", { kind: "error" });
  assert.equal(t.takeContinue("s1", 2, 1), false, "error 不该清预算");
  t.resetIfCompleted("s1", { kind: "blocked" });
  assert.equal(t.takeContinue("s1", 3, 1), true);
});

test("tracker.reset：清掉整个会话的状态", () => {
  const t = createTracker();
  t.takeRetry("s1", "k", 1);
  t.reset("s1");
  assert.equal(t.takeRetry("s1", "k", 1), true);
  t.reset("");
  t.reset(null);
});

test("createTracker：会话数超过 200 时淘汰最早的 50 个，不无限涨", () => {
  const t = createTracker();
  for (let i = 0; i < 200; i += 1) t.takeRetry(`s${i}`, "k", 1);
  assert.equal(t.takeRetry("s0", "k", 1), false, "还没溢出，s0 仍在表里");
  t.takeRetry("s200", "k", 1); // 触发溢出，淘汰最早的 50 个
  assert.equal(t.takeRetry("s0", "k", 1), true, "s0 已被淘汰，重新计数");
  assert.equal(t.takeRetry("s199", "k", 1), false, "s199 还在表里");
});

test("tracker.refundContinue：失败 seq 记录最多 256 条，超了删最老的", () => {
  const t = createTracker();
  for (let i = 0; i < 300; i += 1) {
    t.takeContinue("s1", i + 1, 10000, 100000);
    t.refundContinue("s1", i + 1);
  }
  // 只验证「没崩、还能继续用」——Set 的容量是内部实现，不对外暴露
  assert.equal(t.takeContinue("s1", 9999, 10000, 100000), true);
});

// ---------------------------------------------------------------------------
// installContinueRetry：挂什么钩子、什么时候不动作
// ---------------------------------------------------------------------------

function fakeCtx() {
  const regs = [];
  return {
    regs,
    ctx: {
      on(name, handler, opts) {
        const rec = { name, handler, opts, off: false };
        regs.push(rec);
        return () => {
          rec.off = true;
        };
      },
    },
  };
}

test("installContinueRetry：两个钩子都带 global，dispose 后都摘掉", () => {
  const { regs, ctx } = fakeCtx();
  const h = installContinueRetry(ctx, { config: {} });
  assert.deepEqual(
    regs.map((r) => r.name),
    ["agent/request-error", "agent/status"],
  );
  assert.ok(regs.every((r) => r.opts?.global === true), "必须 global，否则子会话/别的会话看不到");
  h.dispose();
  assert.ok(regs.every((r) => r.off), "dispose 要摘干净");
});

test("installContinueRetry：ctx 没有 on 时不抛，dispose 也可调用", () => {
  const h = installContinueRetry({}, { config: {} });
  h.dispose();
  const h2 = installContinueRetry(null, {});
  h2.dispose();
});

test("installContinueRetry：下游已经决定 retry 时不再插手", async () => {
  const { regs, ctx } = fakeCtx();
  installContinueRetry(ctx, { config: { retryMax: 3 } }).dispose?.();
  const h = installContinueRetry(ctx, { config: { retryMax: 3 } });
  const handler = regs.find((r) => r.name === "agent/request-error").handler;
  const out = await handler({ agent: { id: "s1" }, failure: { code: "TRANSPORT" } }, async () => ({
    kind: "retry",
  }));
  assert.deepEqual(out, { kind: "retry" }, "原样把下游结果返回");
  h.dispose();
});

test("installContinueRetry：可重试的失败会被改成 retry，并置上重试标记", async () => {
  const { regs, ctx } = fakeCtx();
  const h = installContinueRetry(ctx, { config: { retryMax: 2 } });
  const handler = regs.find((r) => r.name === "agent/request-error").handler;
  globalThis.__dshPurgeRetryPending = false;
  const out = await handler(
    { agent: { id: "s1" }, turn: 1, step: 0, failure: { code: "TRANSPORT" } },
    async () => undefined,
  );
  assert.deepEqual(out, { kind: "retry" });
  assert.equal(globalThis.__dshPurgeRetryPending, true, "retry 不是用户触发，必须靠标记让 assemble 重塞 inject");
  h.dispose();
});

test("installContinueRetry：永久失败、signal 已中止、预算用完都不重试", async () => {
  const { regs, ctx } = fakeCtx();
  const h = installContinueRetry(ctx, { config: { retryMax: 1 } });
  const handler = regs.find((r) => r.name === "agent/request-error").handler;

  assert.equal(
    await handler({ agent: { id: "s1" }, failure: { code: "AUTH" } }, async () => undefined),
    undefined,
    "AUTH 不重试",
  );
  assert.equal(
    await handler(
      { agent: { id: "s1" }, failure: { code: "TRANSPORT" }, signal: { aborted: true } },
      async () => undefined,
    ),
    undefined,
    "已中止不重试",
  );
  // 预算 1：上一次 TRANSPORT 已经被 aborted 那条吃掉了？没有——那条在 shouldAutoRetry 就返回了。
  assert.deepEqual(
    await handler({ agent: { id: "s1" }, turn: 2, failure: { code: "TRANSPORT" } }, async () => undefined),
    { kind: "retry" },
    "第一次真正重试",
  );
  assert.equal(
    await handler({ agent: { id: "s1" }, turn: 3, failure: { code: "TRANSPORT" } }, async () => undefined),
    undefined,
    "预算用完",
  );
  h.dispose();
});

test("installContinueRetry：autoRetry 关掉时一律不重试", async () => {
  const { regs, ctx } = fakeCtx();
  const h = installContinueRetry(ctx, { config: { autoRetry: false } });
  const handler = regs.find((r) => r.name === "agent/request-error").handler;
  assert.equal(
    await handler({ agent: { id: "s1" }, failure: { code: "TRANSPORT" } }, async () => undefined),
    undefined,
  );
  h.dispose();
});

test("installContinueRetry：autoContinue 默认关着，idle 之后不会替用户发消息", async () => {
  const { regs, ctx } = fakeCtx();
  const h = installContinueRetry(ctx, { config: {} });
  const sent = [];
  const agent = {
    id: "s1",
    status: "idle",
    followup: (m) => sent.push(m),
    session: { snapshotEvents: () => [end(3, { kind: "error" })] },
  };
  regs.find((r) => r.name === "agent/status").handler({ status: "idle", agent });
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(sent.length, 0, "默认 autoContinue=false，不能抢用户的输入框");
  h.dispose();
});

test("installContinueRetry：显式打开 autoContinue 后才在 idle 后补一句", async () => {
  const { regs, ctx } = fakeCtx();
  const h = installContinueRetry(ctx, { config: { autoContinue: true, continueText: "接着" } });
  const sent = [];
  const agent = {
    id: "s1",
    status: "idle",
    followup: (m) => sent.push(m),
    session: { snapshotEvents: () => [end(3, { kind: "error" })] },
  };
  regs.find((r) => r.name === "agent/status").handler({ status: "idle", agent });
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content[0].text, "接着");
  h.dispose();
});

test("installContinueRetry：dispose 之后排着的定时器不会再发消息", async () => {
  const { regs, ctx } = fakeCtx();
  const h = installContinueRetry(ctx, { config: { autoContinue: true } });
  const sent = [];
  const agent = {
    id: "s1",
    status: "idle",
    followup: (m) => sent.push(m),
    session: { snapshotEvents: () => [end(3, { kind: "error" })] },
  };
  regs.find((r) => r.name === "agent/status").handler({ status: "idle", agent });
  h.dispose();
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(sent.length, 0, "dispose 必须清掉 pending 定时器");
});

test("installContinueRetry：agent 还在跑、收件箱有货、刚有真人说话时都不续跑", async () => {
  const { regs, ctx } = fakeCtx();
  const h = installContinueRetry(ctx, { config: { autoContinue: true } });
  const sent = [];
  const mk = (extra) => ({
    id: "s1",
    status: "idle",
    followup: (m) => sent.push(m),
    session: { snapshotEvents: () => [end(3, { kind: "error" })] },
    ...extra,
  });
  const handler = regs.find((r) => r.name === "agent/status").handler;

  handler({ status: "idle", agent: mk({ status: "running" }) });
  await new Promise((r) => setTimeout(r, 320));
  assert.equal(sent.length, 0, "还在跑就别插话");

  handler({ status: "idle", agent: mk({ inbox: { hasPending: () => true } }) });
  await new Promise((r) => setTimeout(r, 320));
  assert.equal(sent.length, 0, "收件箱有货时让队列先走");

  handler({
    status: "idle",
    agent: {
      id: "s1",
      status: "idle",
      followup: (m) => sent.push(m),
      session: { snapshotEvents: () => [end(3, { kind: "error" }), userMsg(4)] },
    },
  });
  await new Promise((r) => setTimeout(r, 320));
  assert.equal(sent.length, 0, "真人刚说过话，不要抢");
  h.dispose();
});

test("sessionEventsOf：两条读事件的路都抛错时给空数组，不让异常漏出去", () => {
  const agent = {
    session: {
      snapshotEvents: () => {
        throw new Error("snapshot boom");
      },
      get events() {
        throw new Error("events boom");
      },
    },
  };
  // 上一条用例只覆盖了「snapshotEvents 抛错 → 退到 events 数组」。
  // 这条覆盖再往下掉一层：events 这个属性本身读出来就炸，
  // 只能返回空数组。少了这个出口，一个坏 session 就能让
  // agent/status 钩子整条抛出去，宿主那一侧的 idle 处理跟着断。
  assert.deepEqual(sessionEventsOf(agent), []);
});

test("installContinueRetry：ctx.on 不认第三个参数时退回两参注册", () => {
  const regs = [];
  const ctx = {
    on(name, handler, opts) {
      if (arguments.length > 2) throw new TypeError("expects 2 arguments");
      const rec = { name, handler, opts, off: false };
      regs.push(rec);
      return () => {
        rec.off = true;
      };
    },
  };
  const h = installContinueRetry(ctx, { config: {} });
  assert.deepEqual(
    regs.map((r) => r.name),
    ["agent/request-error", "agent/status"],
    "两参注册也要把两个钩子都挂上",
  );
  assert.ok(regs.every((r) => r.opts === undefined), "退回两参时不再传 global");
  h.dispose();
  assert.ok(regs.every((r) => r.off), "退回注册的钩子也要能摘掉");
});

test("installContinueRetry：ctx.on 两参也不认时宁可一个钩子都不挂，也不抛", () => {
  let calls = 0;
  const ctx = {
    on() {
      calls += 1;
      throw new Error("on boom");
    },
  };
  const h = installContinueRetry(ctx, { config: {} });
  assert.equal(calls, 4, "每个事件各试两种签名（3 参 + 2 参）");
  h.dispose(); // 两个 off 都是 null，dispose 不能炸
});

test("installContinueRetry：续跑那句发不出去时把名额退回去，并留一行 warn", async () => {
  const { regs, ctx } = fakeCtx();
  const h = installContinueRetry(ctx, { config: { autoContinue: true, continueMax: 1 } });
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args.map(String).join(" "));
  try {
    const boomAgent = () => ({
      id: "s1",
      status: "idle",
      followup: () => {
        throw new Error("followup boom");
      },
      session: { snapshotEvents: () => [end(3, { kind: "error" })] },
    });
    const handler = regs.find((r) => r.name === "agent/status").handler;
    handler({ status: "idle", agent: boomAgent() });
    await new Promise((r) => setTimeout(r, 350));

    assert.equal(warned.length, 1, "发不出去要有且只有一行 warn");
    assert.match(warned[0], /auto-continue send failed/);
    assert.match(warned[0], /session=s1/);
    assert.match(warned[0], /seq=3/);
    assert.match(warned[0], /followup boom/);

    // 名额必须退回来：continueMax=1 时，如果不 refund，下一个失败点也只能干看着。
    // 注意必须换一个新的 seq —— refundContinue 故意保留 lastContinueSeq，
    // 同一个失败点不会再消耗第二次（见下一条用例）。
    const okSent = [];
    handler({
      status: "idle",
      agent: {
        id: "s1",
        status: "idle",
        followup: (m) => okSent.push(m),
        session: { snapshotEvents: () => [end(5, { kind: "error" })] },
      },
    });
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(okSent.length, 1, "上一次发送失败不能把本会话的续跑名额吃掉");
    assert.equal(okSent[0].content[0].text, "继续", "补的是默认那句");
  } finally {
    console.warn = realWarn;
    h.dispose();
  }
});

test("installContinueRetry：同一条失败点退款之后不再重复续跑，seq 变了才行", async () => {
  const { regs, ctx } = fakeCtx();
  const h = installContinueRetry(ctx, { config: { autoContinue: true, continueMax: 1 } });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const mk = (seq) => ({
      id: "s1",
      status: "idle",
      followup: () => {
        throw new Error("followup boom");
      },
      session: { snapshotEvents: () => [end(seq, { kind: "error" })] },
    });
    const handler = regs.find((r) => r.name === "agent/status").handler;
    handler({ status: "idle", agent: mk(3) });
    await new Promise((r) => setTimeout(r, 350));
    // 同一个 seq 再来一次：refundContinue 保留失败记录，不该再试
    let tries = 0;
    const agent2 = mk(3);
    agent2.followup = () => {
      tries += 1;
      throw new Error("followup boom");
    };
    handler({ status: "idle", agent: agent2 });
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(tries, 0, "同一失败点退过一次就不再消耗第二次");
  } finally {
    console.warn = realWarn;
    h.dispose();
  }
});
