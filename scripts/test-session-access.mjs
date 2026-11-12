// lib/session-access.js：会话权限钉死、cwd 捕获、rewind 派生过滤。
//
// 这三组都是「装钩子 + 在钩子里改宿主状态」，坏了不报错、只表现为：
//   权限芯片从完全访问掉成 workspace-write（发完第一条消息以后）
//   工作目录没被记住（下次开新会话回到默认目录）
//   回退后的派生消息没被过滤（撤销的轮次仍出现在上下文里）
// 所以每个入口都要固定：装了什么钩子、钩子里判什么、dispose 后有没有清干净。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as sessionAccess from "../lib/session-access.js";
import * as rewind from "../lib/rewind.js";
import * as rules from "../lib/rules.js";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-session-access-"));
const HOME = path.join(SANDBOX, "home");
const HOME_ENV_BEFORE = process.env.DSH_HOME;

test.after(() => {
  if (HOME_ENV_BEFORE === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = HOME_ENV_BEFORE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function useHome(tag) {
  const home = path.join(HOME, tag);
  fs.mkdirSync(home, { recursive: true });
  process.env.DSH_HOME = home;
  return home;
}

/** 假 ctx：只实现本模块用到的面，hooks 记录装上去的钩子，disposers 记录 cleanup。 */
function fakeCtx(over = {}) {
  const hooks = new Map();
  const disposers = [];
  const ctx = {
    hooks,
    disposers,
    on(name, handler) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(handler);
      return () => {
        const list = hooks.get(name) || [];
        const i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
      };
    },
    effect(fn) {
      disposers.push(fn());
    },
    get(name) {
      return ctx.services?.[name];
    },
    emit(name, ...args) {
      for (const handler of [...(hooks.get(name) || [])]) handler(...args);
    },
    ...over,
  };
  return ctx;
}

function fakeSvc(over = {}) {
  return {
    state: new Map(),
    sets: [],
    permissionState(session) {
      return this.state.get(session) ?? null;
    },
    set(session, preset) {
      this.sets.push([session, preset]);
      this.state.set(session, { preset });
    },
    ...over,
  };
}

function fakeSession(over = {}) {
  return { header: {}, ...over };
}

// ---------- permissionPresetsOf ----------

test("permissionPresetsOf：直接挂在上面的服务优先于 ctx.get", () => {
  const direct = fakeSvc();
  const viaGet = fakeSvc();
  const ctx = fakeCtx({ permissionPresets: direct, services: { permissionPresets: viaGet } });
  assert.equal(sessionAccess.permissionPresetsOf(ctx), direct);
});

test("permissionPresetsOf：只有 set 是函数才算服务（有对象但没有 set 时继续找 ctx.get）", () => {
  const viaGet = fakeSvc();
  const ctx = fakeCtx({ permissionPresets: { set: "not a function" }, services: { permissionPresets: viaGet } });
  assert.equal(sessionAccess.permissionPresetsOf(ctx), viaGet);
});

test("permissionPresetsOf：两处都没有就返回 null", () => {
  assert.equal(sessionAccess.permissionPresetsOf(fakeCtx()), null);
  assert.equal(sessionAccess.permissionPresetsOf(null), null);
  assert.equal(sessionAccess.permissionPresetsOf(undefined), null);
});

test("permissionPresetsOf：Cordis 的 Proxy 点属性会抛，两边都抛也要返回 null 而不是炸出去", () => {
  const boom = new Proxy({}, { get() { throw new Error("cannot get property without inject"); } });
  const ctx = { permissionPresets: boom, get() { throw new Error("no service"); } };
  assert.equal(sessionAccess.permissionPresetsOf(ctx), null);
});

// ---------- parentPermissionPreset ----------

test("parentPermissionPreset：没有 parentSession 就返回空串，不碰任何服务", () => {
  const svc = fakeSvc();
  const ctx = fakeCtx({ permissionPresets: svc });
  assert.equal(sessionAccess.parentPermissionPreset(ctx, fakeSession()), "");
  assert.equal(sessionAccess.parentPermissionPreset(ctx, null), "");
  assert.equal(sessionAccess.parentPermissionPreset(null, fakeSession({ header: { parentSession: "p1" } })), "");
  assert.equal(svc.sets.length, 0);
});

test("parentPermissionPreset：先问 agents 注册表，拿不到再问 sessions 存储", () => {
  const svc = fakeSvc();
  const parent = fakeSession({ header: { permissionPreset: "read-only" } });
  svc.state.set(parent, { preset: "danger-full-access" });
  const fromAgents = fakeCtx({
    permissionPresets: svc,
    agents: { get: (id) => (id === "p1" ? { session: parent } : null) },
  });
  assert.equal(sessionAccess.parentPermissionPreset(fromAgents, fakeSession({ header: { parentSession: "p1" } })), "danger-full-access");

  const fromStore = fakeCtx({
    permissionPresets: svc,
    services: { agents: { get: () => null }, sessions: { get: (id) => (id === "p1" ? parent : null) } },
  });
  assert.equal(sessionAccess.parentPermissionPreset(fromStore, fakeSession({ header: { parentSession: "p1" } })), "danger-full-access");
});

test("parentPermissionPreset：permissionState 没有时退到 header.permissionPreset", () => {
  const parent = fakeSession({ header: { permissionPreset: "workspace-write" } });
  const ctx = fakeCtx({ agents: { get: () => ({ session: parent }) } });
  assert.equal(sessionAccess.parentPermissionPreset(ctx, fakeSession({ header: { parentSession: "p1" } })), "workspace-write");
});

test("parentPermissionPreset：父会话找不到返回空串（不是 null、不是 false）", () => {
  const ctx = fakeCtx({ agents: { get: () => null }, services: { sessions: { get: () => null } } });
  assert.equal(sessionAccess.parentPermissionPreset(ctx, fakeSession({ header: { parentSession: "ghost" } })), "");
});

test("parentPermissionPreset：取父会话时抛异常要吞掉并返回空串", () => {
  const ctx = fakeCtx({ agents: { get() { throw new Error("registry down"); } } });
  assert.equal(sessionAccess.parentPermissionPreset(ctx, fakeSession({ header: { parentSession: "p1" } })), "");
});

// ---------- shouldKeepFreshFullAccess ----------

test("shouldKeepFreshFullAccess：已经是 danger-full-access / auto / custom 的都不再动", () => {
  for (const preset of ["danger-full-access", "auto", "custom"]) {
    const session = fakeSession();
    const svc = fakeSvc();
    svc.state.set(session, { preset });
    assert.equal(sessionAccess.shouldKeepFreshFullAccess(session, svc), false, preset);
  }
});

test("shouldKeepFreshFullAccess：没有预设、workspace-write、read-only 才算「新会话」", () => {
  const svc = fakeSvc();
  const blank = fakeSession();
  assert.equal(sessionAccess.shouldKeepFreshFullAccess(blank, svc), true);

  for (const preset of ["workspace-write", "read-only"]) {
    const session = fakeSession();
    svc.state.set(session, { preset });
    assert.equal(sessionAccess.shouldKeepFreshFullAccess(session, svc), true, preset);
  }
});

test("shouldKeepFreshFullAccess：auto / custom 那一支是冗余守卫，外部行为上与末尾的枚举判定等价（只能读源码钉）", () => {
  // 第一版试图用「auto / custom 已被钉住」来区分，实测删掉那半句测试照样绿：
  // auto 与 custom 既不在 {null, workspace-write, read-only} 里，末尾会判 false，
  // 所以这一支纯粹是「读起来更清楚」，不是可观察行为。钉在源码上，避免有人以为它没用就删。
  const src = fs.readFileSync(new URL("../lib/session-access.js", import.meta.url), "utf8");
  assert.match(src, /preset === "danger-full-access" \|\| preset === "auto" \|\| preset === "custom"/);
});

test("shouldKeepFreshFullAccess：用户自己钉过一次以上（permission/preset 事件多于一条）就不再覆盖", () => {
  const svc = fakeSvc();
  const events = (n) => Array.from({ length: n }, () => ({ type: "permission/preset" }));
  assert.equal(sessionAccess.shouldKeepFreshFullAccess(fakeSession({ snapshotEvents: () => events(1) }), svc), true);
  assert.equal(sessionAccess.shouldKeepFreshFullAccess(fakeSession({ snapshotEvents: () => events(2) }), svc), false);
  assert.equal(sessionAccess.shouldKeepFreshFullAccess(fakeSession({ snapshotEvents: () => events(3) }), svc), false);
});

test("shouldKeepFreshFullAccess：非 permission/preset 的事件不算（用户聊天不会挡住全开权限）", () => {
  const svc = fakeSvc();
  const session = fakeSession({
    snapshotEvents: () => [{ type: "user/message" }, { type: "assistant/message" }, { type: "user/message" }],
  });
  assert.equal(sessionAccess.shouldKeepFreshFullAccess(session, svc), true);
});

test("shouldKeepFreshFullAccess：snapshotEvents 不是函数或返回值不是数组时按「零条事件」处理", () => {
  const svc = fakeSvc();
  assert.equal(sessionAccess.shouldKeepFreshFullAccess(fakeSession(), svc), true);
  assert.equal(sessionAccess.shouldKeepFreshFullAccess(fakeSession({ snapshotEvents: "nope" }), svc), true);
  assert.equal(sessionAccess.shouldKeepFreshFullAccess(fakeSession({ snapshotEvents: () => null }), svc), true);
});

// ---------- upgradeFreshSessionAccess ----------

test("upgradeFreshSessionAccess：没有 permissionPresets 服务就静默返回（不能把插件起不来）", () => {
  assert.doesNotThrow(() => sessionAccess.upgradeFreshSessionAccess(fakeCtx(), fakeSession()));
});

test("upgradeFreshSessionAccess：新会话被钉成 danger-full-access", () => {
  const svc = fakeSvc();
  const session = fakeSession();
  sessionAccess.upgradeFreshSessionAccess(fakeCtx({ permissionPresets: svc }), session);
  assert.deepEqual(svc.sets, [[session, "danger-full-access"]]);
});

test("upgradeFreshSessionAccess：子会话继承父会话的预设，而不是一律全开", () => {
  const svc = fakeSvc();
  const parent = fakeSession({ header: { permissionPreset: "read-only" } });
  const child = fakeSession({ header: { parentSession: "p1" } });
  const ctx = fakeCtx({ permissionPresets: svc, agents: { get: () => ({ session: parent }) } });
  sessionAccess.upgradeFreshSessionAccess(ctx, child);
  assert.deepEqual(svc.sets, [[child, "read-only"]]);
});

test("upgradeFreshSessionAccess：子会话已经是父的预设时不重复 set", () => {
  const svc = fakeSvc();
  const parent = fakeSession({ header: { permissionPreset: "read-only" } });
  const child = fakeSession({ header: { parentSession: "p1" } });
  svc.state.set(child, { preset: "read-only" });
  const ctx = fakeCtx({ permissionPresets: svc, agents: { get: () => ({ session: parent }) } });
  sessionAccess.upgradeFreshSessionAccess(ctx, child);
  assert.deepEqual(svc.sets, []);
});

test("upgradeFreshSessionAccess：set 抛异常只打一行 warn，不把异常抛给宿主", () => {
  const svc = fakeSvc({
    set() { throw new Error("preset locked"); },
  });
  const warns = [];
  const warnBefore = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    assert.doesNotThrow(() => sessionAccess.upgradeFreshSessionAccess(fakeCtx({ permissionPresets: svc }), fakeSession()));
  } finally {
    console.warn = warnBefore;
  }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^\[dsh-purge\] full-access pin: preset locked$/);
});

// ---------- pinExistingSessionAccess ----------

test("pinExistingSessionAccess：遍历 sessions.all()，把已存在的会话一起钉", () => {
  const svc = fakeSvc();
  const a = fakeSession();
  const b = fakeSession();
  const ctx = fakeCtx({ permissionPresets: svc, services: { sessions: { all: () => [a, b] } } });
  sessionAccess.pinExistingSessionAccess(ctx);
  assert.deepEqual(svc.sets, [[a, "danger-full-access"], [b, "danger-full-access"]]);
});

test("pinExistingSessionAccess：没有 all 时退到 list()，两个都没有就当空", () => {
  const svc = fakeSvc();
  const a = fakeSession();
  const viaList = fakeCtx({ permissionPresets: svc, services: { sessions: { list: () => [a] } } });
  sessionAccess.pinExistingSessionAccess(viaList);
  assert.deepEqual(svc.sets, [[a, "danger-full-access"]]);

  const none = fakeCtx({ permissionPresets: svc, services: { sessions: {} } });
  assert.doesNotThrow(() => sessionAccess.pinExistingSessionAccess(none));
  assert.equal(svc.sets.length, 1);
});

test("pinExistingSessionAccess：会话注册表还没起时抛异常要吞掉（等 session/created 再来）", () => {
  const svc = fakeSvc();
  const ctx = fakeCtx({ permissionPresets: svc, services: { sessions: { all() { throw new Error("not ready"); } } } });
  assert.doesNotThrow(() => sessionAccess.pinExistingSessionAccess(ctx));
  assert.deepEqual(svc.sets, []);
});

// ---------- installFreshFullAccess ----------

test("installFreshFullAccess：ctx 没有 on 就直接返回，不设标记也不装 effect", () => {
  const ctx = fakeCtx({ on: undefined });
  sessionAccess.installFreshFullAccess(ctx);
  assert.equal(ctx.__dshPurgeFullPin, undefined);
  assert.equal(ctx.disposers.length, 0);
});

test("installFreshFullAccess：重复调用只装一次（热重载不会翻倍）", () => {
  const ctx = fakeCtx();
  sessionAccess.installFreshFullAccess(ctx);
  sessionAccess.installFreshFullAccess(ctx);
  assert.equal(ctx.__dshPurgeFullPin, true);
  assert.equal(ctx.disposers.length, 1);
  assert.equal((ctx.hooks.get("session/created") || []).length, 1);
});

test("installFreshFullAccess：新建会话在下一个微任务里被钉成全开权限", async () => {
  const svc = fakeSvc();
  const ctx = fakeCtx({ permissionPresets: svc });
  sessionAccess.installFreshFullAccess(ctx);
  const session = fakeSession();
  ctx.emit("session/created", session);
  await Promise.resolve();
  assert.deepEqual(svc.sets, [[session, "danger-full-access"]]);
});

test("installFreshFullAccess：装的时候还会把已存在的会话补钉一遍", async () => {
  const svc = fakeSvc();
  const old = fakeSession();
  const ctx = fakeCtx({ permissionPresets: svc, services: { sessions: { all: () => [old] } } });
  sessionAccess.installFreshFullAccess(ctx);
  await Promise.resolve();
  assert.deepEqual(svc.sets, [[old, "danger-full-access"]]);
});

test("installFreshFullAccess：dispose 后解绑 session/created 并清掉标记（否则重新装会被自己的标记挡住）", () => {
  const ctx = fakeCtx();
  sessionAccess.installFreshFullAccess(ctx);
  const cleanup = ctx.disposers[0];
  cleanup();
  assert.equal(ctx.__dshPurgeFullPin, undefined);
  assert.equal((ctx.hooks.get("session/created") || []).length, 0);
  sessionAccess.installFreshFullAccess(ctx);
  assert.equal(ctx.disposers.length, 2);
});

test("installFreshFullAccess：ctx.on 抛异常时仍然继续（只少一个钩子，不要去炸整个插件注册）", () => {
  const boom = fakeCtx({
    on() { throw new Error("event bus not ready"); },
  });
  assert.doesNotThrow(() => sessionAccess.installFreshFullAccess(boom));
  assert.equal(boom.__dshPurgeFullPin, true);
});

// ---------- installCwdCapture ----------

test("installCwdCapture：没有 ctx / 没有 on 就返回，不设标记", () => {
  const a = fakeCtx({ on: undefined });
  sessionAccess.installCwdCapture(a);
  assert.equal(a.__dshPurgeCwdCapture, undefined);
  assert.doesNotThrow(() => sessionAccess.installCwdCapture(null));
});

test("installCwdCapture：session/created 时把 header.cwd 写进 last-cwd.txt", () => {
  const home = useHome("cwd1");
  const ctx = fakeCtx();
  sessionAccess.installCwdCapture(ctx);
  ctx.emit("session/created", fakeSession({ header: { cwd: "D:/work/a" } }));
  assert.equal(rules.readLastCwd(home), "D:/work/a");
});

test("installCwdCapture：同一个 cwd 第二次不重复写盘（session/event 每次都触发，避免每个事件都写一遍）", () => {
  const home = useHome("cwd2");
  const ctx = fakeCtx();
  sessionAccess.installCwdCapture(ctx);
  const session = fakeSession({ header: { cwd: "D:/work/b" } });
  ctx.emit("session/created", session);
  const fp = path.join(home, "dsh-purge", "last-cwd.txt");
  const first = fs.statSync(fp).mtimeMs;
  const writes = [];
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (...args) => {
    writes.push(String(args[0]));
    return realWrite(...args);
  };
  try {
    for (let i = 0; i < 5; i += 1) ctx.emit("session/event", session);
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.deepEqual(writes, []);
  assert.equal(rules.readLastCwd(home), "D:/work/b");
  assert.equal(fs.statSync(fp).mtimeMs, first);
});

test("installCwdCapture：换成另一个 cwd 会跟着改", () => {
  const home = useHome("cwd3");
  const ctx = fakeCtx();
  sessionAccess.installCwdCapture(ctx);
  ctx.emit("session/created", fakeSession({ header: { cwd: "D:/work/c" } }));
  ctx.emit("session/event", fakeSession({ header: { cwd: "D:/work/d" } }));
  assert.equal(rules.readLastCwd(home), "D:/work/d");
});

test("installCwdCapture：cwd 为空 / 全空白 / 没有 header 时一律不写（不能把上次的目录清空）", () => {
  const home = useHome("cwd4");
  const ctx = fakeCtx();
  sessionAccess.installCwdCapture(ctx);
  ctx.emit("session/created", fakeSession({ header: { cwd: "D:/work/e" } }));
  assert.equal(rules.readLastCwd(home), "D:/work/e");
  for (const session of [fakeSession({ header: { cwd: "" } }), fakeSession({ header: { cwd: "   " } }), fakeSession(), null, undefined]) {
    ctx.emit("session/event", session);
  }
  assert.equal(rules.readLastCwd(home), "D:/work/e");
});

test("installCwdCapture：空 cwd 的挡板有两道（flush 里一道、writeLastCwd 里一道），外部行为等价，读源码钉住", () => {
  // 删掉 flush 里那句 `!cwd` 测试照样绿：rules.writeLastCwd 自己也会挡空串。
  // 留着是为了省一次 fs 调用与一次 mkdir，不是可观察行为 —— 谁要删得先改这条。
  const src = fs.readFileSync(new URL("../lib/session-access.js", import.meta.url), "utf8");
  assert.match(src, /if \(!cwd \|\| !home \|\| cwd === lastWritten\) return;/);
});

test("installCwdCapture：装的时候扫一遍已有会话（不然重启后要等新会话才记住目录）", () => {
  const home = useHome("cwd5");
  const ctx = fakeCtx({ services: { sessions: { all: () => [fakeSession({ header: { cwd: "D:/work/f" } })] } } });
  sessionAccess.installCwdCapture(ctx);
  assert.equal(rules.readLastCwd(home), "D:/work/f");
});

test("installCwdCapture：挂 session/created 与 session/event 两个钩子，dispose 两个都摘掉并清标记", () => {
  useHome("cwd6");
  const ctx = fakeCtx();
  sessionAccess.installCwdCapture(ctx);
  assert.equal((ctx.hooks.get("session/created") || []).length, 1);
  assert.equal((ctx.hooks.get("session/event") || []).length, 1);
  ctx.disposers[0]();
  assert.equal(ctx.__dshPurgeCwdCapture, undefined);
  assert.equal((ctx.hooks.get("session/created") || []).length, 0);
  assert.equal((ctx.hooks.get("session/event") || []).length, 0);
});

test("installCwdCapture：重复调用只装一次", () => {
  useHome("cwd7");
  const ctx = fakeCtx();
  sessionAccess.installCwdCapture(ctx);
  sessionAccess.installCwdCapture(ctx);
  assert.equal(ctx.disposers.length, 1);
});

// ---------- installRewindDeriveFilter ----------

test("installRewindDeriveFilter：没有 ctx 就返回；有 ctx 但没 on 时仍然装（on 的异常在 effect 里被 try 吞掉）", () => {
  // 现状锁定：这个入口不像 installCwdCapture 那样先挡 `typeof ctx.on !== "function"`，
  // 它把 on 的缺失留到 effect 内部的 try/catch 里兜。外部表现一样（不会抛），
  // 但标记位会先被置上 —— 顺序不同，写在这里免得以后误以为它和 cwd 那组一样。
  const a = fakeCtx({ on: undefined });
  assert.doesNotThrow(() => sessionAccess.installRewindDeriveFilter(a));
  assert.equal(a.__dshPurgeRewindDerive, true);
  assert.equal(a.disposers.length, 1);
  assert.doesNotThrow(() => sessionAccess.installRewindDeriveFilter(null));
});

test("installRewindDeriveFilter：只挂 session/created 一个钩子", () => {
  const ctx = fakeCtx();
  sessionAccess.installRewindDeriveFilter(ctx);
  assert.equal(ctx.__dshPurgeRewindDerive, true);
  assert.equal((ctx.hooks.get("session/created") || []).length, 1);
  assert.equal(ctx.disposers.length, 1);
});

test("installRewindDeriveFilter：dispose 后解绑并清标记", () => {
  const ctx = fakeCtx();
  sessionAccess.installRewindDeriveFilter(ctx);
  ctx.disposers[0]();
  assert.equal(ctx.__dshPurgeRewindDerive, undefined);
  assert.equal((ctx.hooks.get("session/created") || []).length, 0);
});

test("installRewindDeriveFilter：重复调用只装一次（热重载不会挂两个钩子）", () => {
  const ctx = fakeCtx();
  sessionAccess.installRewindDeriveFilter(ctx);
  sessionAccess.installRewindDeriveFilter(ctx);
  sessionAccess.installRewindDeriveFilter(ctx);
  assert.equal(ctx.disposers.length, 1);
  assert.equal((ctx.hooks.get("session/created") || []).length, 1);
});

test("installRewindDeriveFilter：现状锁定 —— rewind.wrapSessionDeriveMessages 在 lib/rewind.js 里不存在，整段是空转", () => {
  // 上游 1.1.94 就是这个状态：钩子挂上了，钩子里调一个不存在的函数，
  // 被 try/catch 吞掉，所以「回退后过滤派生消息」这件事实际从没生效过。
  // 不顺手补实现（会改变公开行为），但一旦有人在 rewind.js 里加了这个函数，
  // 这条断言会红，提醒把那边的语义一起补上测试。
  assert.equal(typeof rewind.wrapSessionDeriveMessages, "undefined");
  const ctx = fakeCtx();
  sessionAccess.installRewindDeriveFilter(ctx);
  assert.doesNotThrow(() => ctx.emit("session/created", fakeSession()));
});

test("installRewindDeriveFilter：装的时候会扫已有会话，但包函数不存在，所以一个都不会被碰到", () => {
  // 现状锁定：wrapOne 一进 try 就抛 ReferenceError（函数不存在），
  // 于是「扫已有会话」这段现在没有任何可观察效果 —— 连坏会话都不会露出来。
  // 有人在 rewind.js 里补上 wrapSessionDeriveMessages 之后，这里会变成 touched === 1。
  let touched = 0;
  const sessions = [
    { snapshotEvents: () => { touched += 1; return []; } },
    { get snapshotEvents() { throw new Error("bad session"); } },
  ];
  const ctx = fakeCtx({ services: { sessions: { all: () => sessions } } });
  assert.doesNotThrow(() => sessionAccess.installRewindDeriveFilter(ctx));
  assert.equal(touched, 0);
});

// ---------- 模块面 ----------

test("导出面固定：八个入口，名字不能改（index.js 按名字 import）", () => {
  assert.deepEqual(Object.keys(sessionAccess).sort(), [
    "installCwdCapture",
    "installFreshFullAccess",
    "installRewindDeriveFilter",
    "parentPermissionPreset",
    "permissionPresetsOf",
    "pinExistingSessionAccess",
    "shouldKeepFreshFullAccess",
    "upgradeFreshSessionAccess",
  ]);
});

test("源码形状：三处 effect 的 cleanup 都 delete 了标记（漏一处就会在热重载后永久失能）", () => {
  const src = fs.readFileSync(new URL("../lib/session-access.js", import.meta.url), "utf8");
  for (const flag of ["__dshPurgeFullPin", "__dshPurgeCwdCapture", "__dshPurgeRewindDerive"]) {
    assert.match(src, new RegExp(`delete ctx\\.${flag};`), flag);
  }
  assert.equal((src.match(/delete ctx\.__dshPurge/g) || []).length, 3);
});

test("源码形状：cwd 捕获用 rules.writeLastCwd，不自己拼路径", () => {
  const src = fs.readFileSync(new URL("../lib/session-access.js", import.meta.url), "utf8");
  assert.match(src, /rules\.writeLastCwd\(home, cwd\)/);
  assert.doesNotMatch(src, /last-cwd\.txt/);
});
