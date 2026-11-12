// lib/boot-settle.js：启动自愈的决策树。
//
// 这一段是「补丁装上之后、用户还没动之前」跑的那一次判定，14 个 return 分支，
// 每个都只在真宿主上出现几分之一秒。抽成工厂之后，全部依赖都能注入，
// 于是每条分支都能在内存里跑完 —— 包括「密封桌面等 Apply」「官方升级后自愈」
// 「reapply 写完但已经对齐所以不重启」这些只能靠运气才在真机上碰到的路径。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createBootSettle } from "../lib/boot-settle.js";

// ---------------------------------------------------------------------------
// 假依赖
// ---------------------------------------------------------------------------

function fakeCore(over = {}) {
  const calls = [];
  const base = {
    calls,
    desktopAsarStillSealed: () => { calls.push(["desktopAsarStillSealed"]); return false; },
    rememberUnpackedArchive: () => { calls.push(["rememberUnpackedArchive"]); },
    applyRuntimeEnv: () => { calls.push(["applyRuntimeEnv"]); },
    sanitizeDesktopCommandRuntimes: () => { calls.push(["sanitizeDesktopCommandRuntimes"]); return []; },
    refreshHooksDenySettings: () => { calls.push(["refreshHooksDenySettings"]); },
    getHooksDenySettings: () => { calls.push(["getHooksDenySettings"]); return { hooksDenyBypass: true }; },
    restoreHookDenyForBases: async () => { calls.push(["restoreHookDenyForBases"]); return { failed: [] }; },
    enumeratePatchAiBases: () => { calls.push(["enumeratePatchAiBases"]); return ["base"]; },
    gatherState: async () => { calls.push(["gatherState"]); return { ai_base: "/ai", patches_pending: 3 }; },
    silenceCmdFlash: (base2) => { calls.push(["silenceCmdFlash", base2]); return { ok: true, entry: "kept" }; },
    patchAllShims: async () => { calls.push(["patchAllShims"]); },
    applyPatchesAllHosts: async () => {
      calls.push(["applyPatchesAllHosts"]);
      return { report: [{ status: "applied" }, { status: "already" }], hosts: [{ aiBase: "/ai" }] };
    },
    ALL_PATCHES: [{ id: 1 }],
    restartSealedDesktopIfNeeded: ({ ctx } = {}) => {
      calls.push(["restartSealedDesktopIfNeeded", Boolean(ctx)]);
      return { restarting: true, asarSwap: false };
    },
  };
  return Object.assign(base, over);
}

function fakeReapply(over = {}) {
  const calls = [];
  const base = {
    calls,
    ensureInstalledRevSeed: () => { calls.push(["ensureInstalledRevSeed"]); },
    healEmptyAppliedStamp: () => { calls.push(["healEmptyAppliedStamp"]); return false; },
    patchesMatchInstallStrict: async () => { calls.push(["patchesMatchInstallStrict"]); return false; },
    hostCleanEnoughToKeep: async () => { calls.push(["hostCleanEnoughToKeep"]); return false; },
    markPatchesApplied: () => { calls.push(["markPatchesApplied"]); },
    markSettleRestart: () => { calls.push(["markSettleRestart"]); },
    shouldSkipSettleRestart: () => { calls.push(["shouldSkipSettleRestart"]); return false; },
    reapplyInstalled: async (opts = {}) => { calls.push(["reapplyInstalled", opts]); return { ok: true }; },
  };
  return Object.assign(base, over);
}

function fakeHostctl(over = {}) {
  const calls = [];
  const base = {
    calls,
    currentSurface: () => "web",
    scheduleRestart: (request, ctx, options = {}) => {
      calls.push(["scheduleRestart", request, Boolean(ctx), options]);
      return { restarting: true, clean: true };
    },
  };
  return Object.assign(base, over);
}

function fakeOfficialUpdate(over = {}) {
  const calls = [];
  const base = {
    calls,
    upgradeMarkerExists: () => { calls.push(["upgradeMarkerExists"]); return false; },
    clearUpgradeMarker: () => { calls.push(["clearUpgradeMarker"]); },
    clearStaleExtractedApps: () => { calls.push(["clearStaleExtractedApps"]); },
  };
  return Object.assign(base, over);
}

function fakeUpdater(over = {}) {
  const calls = [];
  const base = {
    calls,
    autoUpdateIfNeeded: () => { calls.push(["autoUpdateIfNeeded"]); return Promise.resolve({ ok: true }); },
  };
  return Object.assign(base, over);
}

// deps() 的每个 fake 都可以覆盖；logs 收集 log(config, ...args) 的全量，便于断言「有没有说这一句话」。
function deps(over = {}) {
  const logs = [];
  const d = {
    logs,
    core: fakeCore(over.core),
    hostctl: fakeHostctl(over.hostctl),
    reapply: fakeReapply(over.reapply),
    officialUpdate: fakeOfficialUpdate(over.officialUpdate),
    updater: fakeUpdater(over.updater),
    settleMayReapply: over.settleMayReapply || (() => true),
    settleMayRestart: over.settleMayRestart || (() => true),
    log: (config, ...args) => { logs.push(args.map(String).join(" ")); },
    bootFullQuit: [],
  };
  d.setBootFullQuit = (v) => { d.bootFullQuit.push(v); };
  d.api = createBootSettle(d);
  return d;
}

const CFG = { autoApplyOnStart: true, autoUpdateOnStart: false };
const LIFE = { alive: true };

// ---------------------------------------------------------------------------
// 导出形状
// ---------------------------------------------------------------------------

test("boot-settle：导出五个函数，且模块本身不 import 任何本项目模块（靠注入而不是 import）", async () => {
  const d = deps();
  assert.deepEqual(Object.keys(d.api).sort(), [
    "autoApply",
    "currentSettleScope",
    "scheduleApplyRestart",
    "settleInstalledPatches",
    "shimNeedsPatch",
  ]);
  for (const fn of Object.values(d.api)) assert.equal(typeof fn, "function");

  const src = await import("node:fs").then((m) => m.readFileSync(new URL("../lib/boot-settle.js", import.meta.url), "utf8"));
  assert.doesNotMatch(src, /^import .*from "\.\//m, "boot-settle.js 不该 import 本项目任何模块");
  assert.match(src, /^export function createBootSettle\(deps = \{\}\) \{$/m);
});

// ---------------------------------------------------------------------------
// shimNeedsPatch / currentSettleScope
// ---------------------------------------------------------------------------

test("shimNeedsPatch：桌面面恒 false（桌面树没有 shim，判 true 会每次启动都去 patch）", () => {
  const d = deps({ hostctl: { currentSurface: () => "desktop" } });
  assert.equal(d.api.shimNeedsPatch({ shim_cmd: "original" }), false);
});

test("shimNeedsPatch：三个 shim 任一个是 original 就要打", () => {
  const d = deps();
  assert.equal(d.api.shimNeedsPatch({ shim_cmd: "original" }), true);
  assert.equal(d.api.shimNeedsPatch({ shim_ps1: "original" }), true);
  assert.equal(d.api.shimNeedsPatch({ shim_bin: "original" }), true);
  assert.equal(d.api.shimNeedsPatch({ shim_cmd: "patched", shim_ps1: "patched", shim_bin: "patched" }), false);
  assert.equal(d.api.shimNeedsPatch({}), false);
});

test("currentSettleScope：desktopAsarStillSealed 抛错时 sealed 记 false，不冒泡", () => {
  const d = deps({
    core: { desktopAsarStillSealed: () => { throw new Error("还没定位安装目录"); } },
    hostctl: { currentSurface: () => "web" },
  });
  assert.deepEqual(d.api.currentSettleScope(), { surface: "web", sealed: false });
});

test("currentSettleScope：密封时 sealed 记 true，surface 原样带出", () => {
  const d = deps({
    core: { desktopAsarStillSealed: () => true },
    hostctl: { currentSurface: () => "desktop" },
  });
  assert.deepEqual(d.api.currentSettleScope(), { surface: "desktop", sealed: true });
});

// ---------------------------------------------------------------------------
// settleInstalledPatches：不进主分支的四种早退
// ---------------------------------------------------------------------------

test("settleInstalledPatches：life 已 dispose 就立刻 skip:inactive，连归档都不记", async () => {
  const d = deps();
  assert.equal(await d.api.settleInstalledPatches(CFG, null, { alive: false }), "skip:inactive");
  assert.deepEqual(d.core.calls, [], "不该碰 core 任何东西");
});

test("settleInstalledPatches：seed/heal 抛错只记日志，不阻断后面的判定", async () => {
  const d = deps({
    reapply: {
      ensureInstalledRevSeed: () => { throw new Error("seed boom"); },
      healEmptyAppliedStamp: () => { throw new Error("heal boom"); },
    },
  });
  const out = await d.api.settleInstalledPatches(CFG, null, LIFE);
  assert.ok(d.logs.some((l) => l.includes("seed installed-rev failed: seed boom")), d.logs.join(" | "));
  assert.ok(d.logs.some((l) => l.includes("heal applied stamp failed: heal boom")), d.logs.join(" | "));
  assert.equal(out, "restarting", "heal 抛错只记日志，后面照常往下走");
});

test("settleInstalledPatches：heal 返回 true 时记 healed 一行", async () => {
  const d = deps({ reapply: { healEmptyAppliedStamp: () => true } });
  await d.api.settleInstalledPatches(CFG, null, LIFE);
  assert.ok(d.logs.includes("healed empty applied stamp"), d.logs.join(" | "));
});

test("settleInstalledPatches：autoApplyOnStart 不是 true 时，宿主没被动过就只保戳（boot:host-untouched）", async () => {
  const d = deps({ reapply: { patchesMatchInstallStrict: async () => true } });
  assert.equal(await d.api.settleInstalledPatches({}, null, LIFE), "boot:host-untouched");
  assert.ok(d.reapply.calls.some((c) => c[0] === "markPatchesApplied"));
  assert.equal(d.core.calls.some((c) => c[0] === "applyPatchesAllHosts"), false, "不该写宿主");
});

test("settleInstalledPatches：autoApplyOnStart 不是 true 且两条判据都假时，一次都不写盘（skip:boot-no-host-write）", async () => {
  const d = deps();
  assert.equal(await d.api.settleInstalledPatches({}, null, LIFE), "skip:boot-no-host-write");
  assert.equal(d.reapply.calls.some((c) => c[0] === "markPatchesApplied"), false);
});

test("settleInstalledPatches：autoApplyOnStart 不是 true 且两条判据都抛错时也不炸（catch 兜住等用户点应用）", async () => {
  const d = deps({
    reapply: {
      patchesMatchInstallStrict: async () => { throw new Error("no stamp"); },
      hostCleanEnoughToKeep: async () => { throw new Error("no stamp"); },
    },
  });
  assert.equal(await d.api.settleInstalledPatches({}, null, LIFE), "skip:boot-no-host-write");
});

// ---------------------------------------------------------------------------
// settleInstalledPatches：主分支
// ---------------------------------------------------------------------------

test("settleInstalledPatches：密封桌面且不许 reapply 时等用户点应用（skip:sealed-wait-apply）", async () => {
  const d = deps({ settleMayReapply: () => false });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, LIFE), "skip:sealed-wait-apply");
  assert.equal(d.reapply.calls.some((c) => c[0] === "reapplyInstalled"), false);
});

test("settleInstalledPatches：戳对不上但宿主已经够干净时只刷戳（already-clean）", async () => {
  const d = deps({ reapply: { hostCleanEnoughToKeep: async () => true } });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, LIFE), "already-clean");
  assert.ok(d.reapply.calls.some((c) => c[0] === "markPatchesApplied"));
  assert.equal(d.reapply.calls.some((c) => c[0] === "reapplyInstalled"), false);
});

test("settleInstalledPatches：官方升级后自愈失败时回 reapply-failed，并保留升级标记（好让下次启动再试）", async () => {
  const d = deps({
    officialUpdate: { upgradeMarkerExists: () => true },
    reapply: { reapplyInstalled: async () => ({ ok: false, error: "swap busy" }) },
  });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, LIFE), "reapply-failed");
  assert.ok(d.logs.some((l) => l.includes("official upgrade reapply failed: swap busy")));
  assert.equal(d.officialUpdate.calls.some((c) => c[0] === "clearUpgradeMarker"), false, "失败不能清标记");
});

test("settleInstalledPatches：官方升级自愈成功但当前面不许重启时清标记 + 记 full-quit（reapplied-no-restart）", async () => {
  const d = deps({
    officialUpdate: { upgradeMarkerExists: () => true },
    reapply: { reapplyInstalled: async () => ({ ok: true, needsFullQuit: true }) },
    settleMayRestart: () => false,
  });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, LIFE), "reapplied-no-restart");
  const cleared = d.officialUpdate.calls.map((c) => c[0]).filter((n) => n.startsWith("clear"));
  assert.deepEqual(cleared, ["clearUpgradeMarker", "clearStaleExtractedApps"]);
  assert.deepEqual(d.bootFullQuit, [true]);
  assert.equal(d.hostctl.calls.some((c) => c[0] === "scheduleRestart"), false);
});

test("settleInstalledPatches：官方升级自愈成功、该重启就重启（restarting），且不弹浏览器", async () => {
  const d = deps({
    officialUpdate: { upgradeMarkerExists: () => true },
    reapply: { reapplyInstalled: async () => ({ ok: true }) },
  });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, LIFE), "restarting");
  const restart = d.hostctl.calls.find((c) => c[0] === "scheduleRestart");
  assert.deepEqual(restart[3], { openBrowser: false });
  assert.ok(d.reapply.calls.some((c) => c[0] === "markSettleRestart"));
});

test("settleInstalledPatches：官方升级路径里重启抛错时回 restart-failed", async () => {
  const d = deps({
    officialUpdate: { upgradeMarkerExists: () => true },
    reapply: { reapplyInstalled: async () => ({ ok: true }) },
    hostctl: { scheduleRestart: () => { throw new Error("no window"); } },
  });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, LIFE), "restart-failed");
  assert.ok(d.logs.some((l) => l.includes("restart after official upgrade failed: no window")));
});

test("settleInstalledPatches：普通自愈失败时回 reapply-failed，且不刷戳（避免把半成品当完成）", async () => {
  const d = deps({ reapply: { reapplyInstalled: async () => ({ ok: false, error: "locked" }) } });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, LIFE), "reapply-failed");
  assert.equal(d.reapply.calls.some((c) => c[0] === "markPatchesApplied"), false);
  assert.deepEqual(d.bootFullQuit, [], "自愈失败不该要求完整退出");
  assert.equal(d.hostctl.calls.some((c) => c[0] === "scheduleRestart"), false, "自愈失败不该重启");
});

test("settleInstalledPatches：reapply 成功但官方宿主要完整退出时回 full-quit 并置标", async () => {
  const d = deps({ reapply: { reapplyInstalled: async () => ({ ok: true, needsFullQuit: true }) } });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, LIFE), "full-quit");
  assert.deepEqual(d.bootFullQuit, [true]);
  assert.equal(d.hostctl.calls.some((c) => c[0] === "scheduleRestart"), false);
});

test("settleInstalledPatches：reapply 成功但当前面不许重启时回 reapplied-no-restart", async () => {
  const d = deps({
    reapply: { reapplyInstalled: async () => ({ ok: true }) },
    settleMayRestart: () => false,
  });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, LIFE), "reapplied-no-restart");
  assert.equal(
    d.reapply.calls.some((c) => c[0] === "markPatchesApplied"),
    true,
    "reapply 成功后必须强制保戳，否则 clean 路径会漏写又空转（#59/#60）",
  );
  assert.ok(d.logs.includes("reapply wrote patches; desktop settle does not restart"));
});

test("settleInstalledPatches：reapply 成功但冷却期还没过时也不再重启", async () => {
  const d = deps({
    reapply: { reapplyInstalled: async () => ({ ok: true }), shouldSkipSettleRestart: () => true },
  });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, LIFE), "reapplied-no-restart");
  assert.ok(d.logs.includes("reapply wrote patches; skip settle restart (cooldown)"));
});

test("settleInstalledPatches：reapply 写完再查一次已经对齐时不再重启（reapplied）", async () => {
  let matchCalls = 0;
  const d = deps({
    reapply: {
      reapplyInstalled: async () => ({ ok: true }),
      // 第一次（进主分支前）返回 false，第二次（写完复核）返回 true
      patchesMatchInstallStrict: async () => { matchCalls += 1; return matchCalls > 1; },
    },
  });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, LIFE), "reapplied");
  assert.equal(d.hostctl.calls.some((c) => c[0] === "scheduleRestart"), false);
});

test("settleInstalledPatches：reapply 写完仍不对齐时重启一次（restarting），不弹浏览器", async () => {
  const d = deps({ reapply: { reapplyInstalled: async () => ({ ok: true }) } });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, LIFE), "restarting");
  const restart = d.hostctl.calls.find((c) => c[0] === "scheduleRestart");
  assert.deepEqual(restart[3], { openBrowser: false });
});

test("settleInstalledPatches：重启抛错时回 restart-failed", async () => {
  const d = deps({
    reapply: { reapplyInstalled: async () => ({ ok: true }) },
    hostctl: { scheduleRestart: () => { throw new Error("boom"); } },
  });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, LIFE), "restart-failed");
  assert.ok(d.logs.some((l) => l.includes("restart after reapply failed: boom")));
});

test("settleInstalledPatches：reapply 的 await 期间 ctx 被 dispose 时，重启前再拦一次（skip:inactive）", async () => {
  const life = { alive: true };
  const d = deps({
    reapply: {
      reapplyInstalled: async () => { life.alive = false; return { ok: true }; },
    },
  });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, life), "skip:inactive");
  assert.equal(d.hostctl.calls.some((c) => c[0] === "scheduleRestart"), false);
});

test("settleInstalledPatches：对齐复核那一段 await 期间 ctx 被 dispose，也要在重启前拦住", async () => {
  // patchesMatchInstallStrict 会被调用两次：第一次在 reapplyInstalled 之前（第 66 行），
  // 第二次是「写完再复核」（第 126 行）。第一次就置 dead 的话会停在 105 行那次检查，
  // 测不到「重启前再查一次」。所以计数：第一次正常返回 false，第二次才置 dead。
  const life = { alive: true };
  let rounds = 0;
  const d = deps({
    reapply: {
      patchesMatchInstallStrict: async () => {
        rounds += 1;
        if (rounds === 2) {
          life.alive = false;
          return false;
        }
        return false;
      },
    },
  });
  assert.equal(await d.api.settleInstalledPatches(CFG, null, life), "skip:inactive");
  assert.equal(rounds, 2, "必须走到「写完再复核」那次，才是重启前的那道检查");
  assert.equal(d.hostctl.calls.some((c) => c[0] === "scheduleRestart"), false, "ctx 已 dispose 不该再发起重启");
});

test("settleInstalledPatches：走完主分支且开着自动更新时，把 autoUpdateIfNeeded 的结果记下来", async () => {
  const d = deps({
    reapply: { patchesMatchInstallStrict: async () => true },
    updater: { autoUpdateIfNeeded: () => Promise.resolve({ ok: true, restartAfter: false }) },
  });
  await d.api.settleInstalledPatches({ autoApplyOnStart: true, autoUpdateOnStart: true }, null, LIFE);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(d.logs.some((l) => l.startsWith("auto-update:")), d.logs.join(" | "));
});

test("settleInstalledPatches：自动更新说 needsFullQuit 时置 bootFullQuit", async () => {
  const d = deps({
    reapply: { patchesMatchInstallStrict: async () => true },
    updater: { autoUpdateIfNeeded: () => Promise.resolve({ needsFullQuit: true }) },
  });
  await d.api.settleInstalledPatches({ autoApplyOnStart: true, autoUpdateOnStart: true }, null, LIFE);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(d.bootFullQuit, [true]);
});

test("settleInstalledPatches：自动更新重启抛错只 warn，不冒泡", async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(" "));
  try {
    const d = deps({
      reapply: { patchesMatchInstallStrict: async () => true },
      hostctl: { scheduleRestart: () => { throw new Error("dead"); } },
      updater: { autoUpdateIfNeeded: () => Promise.resolve({ restartAfter: true }) },
    });
    await d.api.settleInstalledPatches({ autoApplyOnStart: true, autoUpdateOnStart: true }, null, LIFE);
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(warns.some((w) => w.includes("auto-update restart failed")), warns.join(" | "));
  } finally {
    console.warn = origWarn;
  }
});

test("settleInstalledPatches：自动更新整体 reject 时也只 warn", async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(" "));
  try {
    const d = deps({
      reapply: { patchesMatchInstallStrict: async () => true },
      updater: { autoUpdateIfNeeded: () => Promise.reject(new Error("offline")) },
    });
    await d.api.settleInstalledPatches({ autoApplyOnStart: true, autoUpdateOnStart: true }, null, LIFE);
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(warns.some((w) => w.includes("auto-update error")), warns.join(" | "));
  } finally {
    console.warn = origWarn;
  }
});

// ---------------------------------------------------------------------------
// autoApply
// ---------------------------------------------------------------------------

test("autoApply：找不到插件根时回 skip:plugin_root_not_found，不写宿主", async () => {
  const d = deps({ core: { gatherState: async () => ({ ai_base: "", patches_pending: 3 }) } });
  assert.equal(await d.api.autoApply(CFG), "skip:plugin_root_not_found");
  assert.equal(d.core.calls.some((c) => c[0] === "applyPatchesAllHosts"), false);
});

test("autoApply：sanitize 有结果时把那批路径记下来", async () => {
  const d = deps({
    core: {
      sanitizeDesktopCommandRuntimes: () => ["C:/a.cmd"],
      gatherState: async () => ({ ai_base: "/ai", patches_pending: 0 }),
    },
  });
  await d.api.autoApply(CFG);
  assert.ok(d.logs.some((l) => l.includes("desktop runtime sanitized:") && l.includes("a.cmd")));
});

test("autoApply：hooksDeny 被关掉时要还原，还原失败把清单记进日志", async () => {
  const d = deps({
    core: {
      getHooksDenySettings: () => ({ hooksDenyBypass: false }),
      restoreHookDenyForBases: async () => ({ failed: ["baseA", "baseB"] }),
      gatherState: async () => ({ ai_base: "/ai", patches_pending: 0 }),
    },
  });
  await d.api.autoApply(CFG);
  assert.ok(d.logs.some((l) => l === "hooks-deny restore leftover: baseA,baseB"), d.logs.join(" | "));
});

test("autoApply：silenceCmdFlash 抛错只记一行，不阻断后面的装配", async () => {
  const d = deps({
    core: {
      silenceCmdFlash: () => { throw new Error("no cmd"); },
      gatherState: async () => ({ ai_base: "/ai", patches_pending: 0 }),
    },
  });
  const out = await d.api.autoApply(CFG);
  assert.ok(d.logs.some((l) => l.startsWith("cmd-flash failed:")), d.logs.join(" | "));
  assert.equal(out, "already_clean", "silenceCmdFlash 抛错不该让整段变成 error");
});

test("autoApply：cmd-flash 不完整时单独记一行", async () => {
  const d = deps({
    core: {
      silenceCmdFlash: () => ({ ok: false, entry: "dsh.cmd" }),
      gatherState: async () => ({ ai_base: "/ai", patches_pending: 5 }),
    },
  });
  await d.api.autoApply(CFG);
  assert.ok(d.logs.some((l) => l === "cmd-flash incomplete: dsh.cmd"), d.logs.join(" | "));
});

test("autoApply：补丁已经齐了但 shim 还是原版时顺手补 shim（already_clean:shim_patched）", async () => {
  const d = deps({
    core: {
      gatherState: async () => ({ ai_base: "/ai", patches_pending: 0, shim_cmd: "original" }),
    },
  });
  assert.equal(await d.api.autoApply(CFG), "already_clean:shim_patched");
  assert.ok(d.core.calls.some((c) => c[0] === "patchAllShims"));
});

test("autoApply：补丁已经齐了、shim 也没问题时就只回 already_clean", async () => {
  const d = deps({ core: { gatherState: async () => ({ ai_base: "/ai", patches_pending: 0 }) } });
  assert.equal(await d.api.autoApply(CFG), "already_clean");
  assert.equal(d.core.calls.some((c) => c[0] === "patchAllShims"), false);
});

test("autoApply：autoApplyOnStart 关掉时回 disabled（补丁还有待办也不写）", async () => {
  const d = deps();
  assert.equal(await d.api.autoApply({ autoApplyOnStart: false }), "disabled");
  assert.equal(d.core.calls.some((c) => c[0] === "applyPatchesAllHosts"), false);
});

test("autoApply：写完之后 cmd-flash 也不 ok 时在返回值里带 :cmd_flash_incomplete", async () => {
  let flashCalls = 0;
  const d = deps({
    core: {
      silenceCmdFlash: () => { flashCalls += 1; return { ok: flashCalls === 1, entry: "e" }; },
    },
  });
  assert.equal(await d.api.autoApply(CFG), "applied:1:cmd_flash_incomplete");
  assert.ok(d.logs.some((l) => l.startsWith("auto-apply done: 1 applied")), d.logs.join(" | "));
});

test("autoApply：整个 try 抛错时回 error:…，并且只 warn", async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(" "));
  try {
    const d = deps({ core: { applyRuntimeEnv: () => { throw new Error("nope"); } } });
    assert.match(await d.api.autoApply(CFG), /^error:/);
    assert.ok(warns.some((w) => w.includes("auto-apply error")), warns.join(" | "));
  } finally {
    console.warn = origWarn;
  }
});

// ---------------------------------------------------------------------------
// scheduleApplyRestart
// ---------------------------------------------------------------------------

test("scheduleApplyRestart：不需要重启时直接回 restarting:false，连宿主都不问", () => {
  const d = deps();
  assert.deepEqual(d.api.scheduleApplyRestart(false, null), { restarting: false });
  assert.deepEqual(d.core.calls, []);
});

test("scheduleApplyRestart：密封包走 restartSealedDesktopIfNeeded，并把 asarSwap 也算成 restarting", () => {
  const seen = [];
  const d = deps({
    core: {
      desktopAsarStillSealed: () => true,
      restartSealedDesktopIfNeeded: (arg) => { seen.push(arg); return { asarSwap: true }; },
    },
  });
  assert.deepEqual(d.api.scheduleApplyRestart(true, { id: 1 }), { asarSwap: true, restarting: true });
  assert.deepEqual(seen, [{ ctx: { id: 1 } }], "ctx 必须透传给密封包重启，否则清不掉 Electron");
});

test("scheduleApplyRestart：普通面 scheduleRestart 说没重启就原样透出，不改写", () => {
  const d = deps({ hostctl: { scheduleRestart: () => ({ restarting: false, clean: false }) } });
  assert.deepEqual(d.api.scheduleApplyRestart(true, null), { restarting: false, clean: false });
});

test("scheduleApplyRestart：`return planned` 那条守卫在返回值上不可观察，只能按源码钉住", () => {
  // 走查：`if (planned && (planned.restarting === false || planned.clean === false)) return planned;`
  // 与后面的 `return planned || { restarting: true }` 在 planned 为真值时返回同一个对象，
  // 为假值时前者不触发 —— 两条路径的结果恒等，所以这里只能钉源码形状，不伪造行为用例。
  const SRC = fs.readFileSync("lib/boot-settle.js", "utf8");
  assert.match(SRC, /if \(planned && \(planned\.restarting === false \|\| planned\.clean === false\)\) return planned;/);
});

test("scheduleApplyRestart：普通面 scheduleRestart 什么都不返回时兜成 restarting:true", () => {
  const d = deps({ hostctl: { scheduleRestart: () => null } });
  assert.deepEqual(d.api.scheduleApplyRestart(true, null), { restarting: true });
});

test("scheduleApplyRestart：scheduleRestart 抛错时回 {restarting:false,error}，不冒泡", () => {
  const d = deps({ hostctl: { scheduleRestart: () => { throw new Error("no pwsh"); } } });
  assert.deepEqual(d.api.scheduleApplyRestart(true, null), { restarting: false, error: "no pwsh" });
});
