// 会话权限钉死 + cwd 捕获 + rewind 派生消息过滤。
//
// 这一组只和宿主的会话/权限服务打交道（permissionPresets、agents、sessions、session/created）——
// 正是宿主升级最容易动的那一层。搬出 lib/index.js 是为了能用假 ctx 单测：
// 这里任何一处判错，用户看到的是「发完第一条消息权限芯片从完全权限掉成 workspace-write」，
// 或者「工作目录没被记住」，都不会报错。

import * as core from "./core.js";
import * as rewind from "./rewind.js";
import * as rules from "./rules.js";

/** Cordis 的 ctx 是 Proxy：未声明 inject 时点属性会抛 "cannot get property ... without inject"，所以两段都要包 try。 */
export function permissionPresetsOf(ctx) {
  try {
    const direct = ctx?.permissionPresets;
    if (direct && typeof direct.set === "function") return direct;
  } catch {
    /* 未 inject 这项服务时，Cordis 代理会抛，不能让新会话的全开权限钉死失败。 */
  }
  try {
    const svc = ctx?.get?.("permissionPresets");
    if (svc && typeof svc.set === "function") return svc;
  } catch {
    /* 没有这项服务。 */
  }
  return null;
}

export function parentPermissionPreset(ctx, session) {
  const parentId = session?.header?.parentSession;
  if (!parentId || !ctx) return "";
  try {
    const registry = ctx.agents || ctx.get?.("agents");
    const parent = registry?.get?.(parentId);
    let parentSession = parent?.session;
    if (!parentSession) {
      const store = ctx.get?.("sessions");
      parentSession = typeof store?.get === "function" ? store.get(parentId) : null;
    }
    if (!parentSession) return "";
    const svc = permissionPresetsOf(ctx);
    const state = typeof svc?.permissionState === "function" ? svc.permissionState(parentSession) : null;
    return state?.preset || parentSession?.header?.permissionPreset || "";
  } catch {
    return "";
  }
}

export function shouldKeepFreshFullAccess(session, svc) {
  const state = typeof svc.permissionState === "function" ? svc.permissionState(session) : null;
  const preset = state?.preset;
  if (preset === "danger-full-access" || preset === "auto" || preset === "custom") return false;
  const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
  const pins = Array.isArray(events) ? events.filter((event) => event?.type === "permission/preset") : [];
  if (pins.length > 1) return false;
  return preset == null || preset === "workspace-write" || preset === "read-only";
}

export function upgradeFreshSessionAccess(ctx, session) {
  try {
    const svc = permissionPresetsOf(ctx);
    if (!svc) return;
    const inherited = parentPermissionPreset(ctx, session);
    if (inherited) {
      const state = typeof svc.permissionState === "function" ? svc.permissionState(session) : null;
      if (state?.preset !== inherited) svc.set(session, inherited);
      return;
    }
    if (!shouldKeepFreshFullAccess(session, svc)) return;
    svc.set(session, "danger-full-access");
  } catch (error) {
    console.warn("[dsh-purge] full-access pin:", error instanceof Error ? error.message : String(error));
  }
}

/** 空会话界面按部署默认显示完全权限；建会话时若钉成 workspace-write，发消息后芯片会掉下去。 */
export function pinExistingSessionAccess(ctx) {
  try {
    const store = ctx.get?.("sessions");
    const all = typeof store?.all === "function" ? store.all()
      : typeof store?.list === "function" ? store.list()
      : [];
    for (const session of all || []) upgradeFreshSessionAccess(ctx, session);
  } catch { /* 注册表还没起来时等 session/created */ }
}

export function installFreshFullAccess(ctx) {
  if (typeof ctx.on !== "function" || ctx.__dshPurgeFullPin) return;
  ctx.__dshPurgeFullPin = true;
  // ctx.effect:plugin dispose 时解绑 session/created,否则 handler 残留 + 热重载翻倍。
  ctx.effect(() => {
    let disposer = null;
    try { disposer = ctx.on("session/created", (session) => {
      queueMicrotask(() => upgradeFreshSessionAccess(ctx, session));
    }); } catch { /* ignore */ }
    queueMicrotask(() => pinExistingSessionAccess(ctx));
    return () => {
      try { if (typeof disposer === "function") disposer(); } catch { /* ignore */ }
      delete ctx.__dshPurgeFullPin;
    };
  });
}

export function installCwdCapture(ctx) {
  if (!ctx || ctx.__dshPurgeCwdCapture) return;
  if (typeof ctx.on !== "function") return;
  ctx.__dshPurgeCwdCapture = true;
  const home = core.findDshHome();
  let lastWritten = "";
  const flush = (session) => {
    try {
      const cwd = String(session?.header?.cwd || "").trim();
      if (!cwd || !home || cwd === lastWritten) return;
      rules.writeLastCwd(home, cwd);
      lastWritten = cwd;
    } catch { /* ignore */ }
  };
  try {
    const store = ctx.get?.("sessions");
    const all = typeof store?.all === "function" ? store.all()
      : typeof store?.list === "function" ? store.list()
      : [];
    for (const session of all || []) flush(session);
  } catch { /* ignore */ }
  ctx.effect(() => {
    const disposers = [];
    try { disposers.push(ctx.on("session/created", flush)); } catch { /* ignore */ }
    try { disposers.push(ctx.on("session/event", (session) => flush(session))); } catch { /* ignore */ }
    return () => {
      for (const d of disposers) {
        try { if (typeof d === "function") d(); } catch { /* ignore */ }
      }
      delete ctx.__dshPurgeCwdCapture;
    };
  });
}

export function installRewindDeriveFilter(ctx) {
  if (!ctx || ctx.__dshPurgeRewindDerive) return;
  ctx.__dshPurgeRewindDerive = true;
  const wrapOne = (session) => {
    try { rewind.wrapSessionDeriveMessages(session); } catch { /* ignore */ }
  };
  try {
    const store = ctx.get?.("sessions");
    const all = typeof store?.all === "function" ? store.all()
      : typeof store?.list === "function" ? store.list()
      : [];
    for (const session of all || []) wrapOne(session);
  } catch { /* ignore */ }
  ctx.effect(() => {
    let disposer = null;
    try { disposer = ctx.on("session/created", (session) => wrapOne(session)); } catch { /* ignore */ }
    return () => {
      try { if (typeof disposer === "function") disposer(); } catch { /* ignore */ }
      delete ctx.__dshPurgeRewindDerive;
    };
  });
}
