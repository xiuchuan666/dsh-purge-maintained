import fs from "node:fs";
import path from "node:path";
import * as core from "./core.js";
import * as hostctl from "./host.js";
import * as rules from "./rules.js";
import * as skills from "./skills.js";
import * as updater from "./update.js";
import * as reapply from "./reapply.js";
import * as officialUpdate from "./official-update.js";
import { clearAssembleGuard } from "./identity.js";
import { registerAnchor } from "./anchor.js";
import { installSubagentControl } from "./subagent-control.js";
import * as rewind from "./rewind.js";
import * as continueRetry from "./continue-retry.js";
import * as uninstaller from "./uninstall.js";
import { readDrillGrant, writeDrillGrant } from "./drill-grant.js";
import { installRulesHttp, installSkillsHttp } from "./http-routes.js";
import { registerChatCommands } from "./commands.js";
import { handleRulesCommand, handleSkillsCommand } from "./chat-rules-skills.js";
import { handlePurgeCommand } from "./chat-purge.js";
import {
  injectSnapshot,
  installHungPromptGlobal,
  purgeLog,
  refreshHungOperator,
  registerPromptSections,
  rejectIfNeedPrompt,
  ensureRestartReady,
} from "./prompt-source.js";
import { installIdentityOverride, installMnemonMessageStrip } from "./inject-write.js";
export { registerPromptSections } from "./prompt-source.js";
import { registerModelTools } from "./tools.js";
import { routeSpecs } from "./routes.js";
import { installRegionGate, readAllowText, writeAllowText } from "./net-scope.js";
import {
  cancelClearOwnedSelectedDefault,
  clearOwnedSelectedDefault,
  removeStaleAgentPresetDir,
  scheduleClearOwnedSelectedDefault,
} from "./preset-default.js";
import {
  applyShouldRestart,
  isInactiveContextError,
  settleDelayMs,
  settleMayReapply,
  settleMayRestart,
  watchContextLife,
} from "./settle-policy.js";
import { ensureAllProfileInstall } from "./profile-insert.js";
import { fixProfileBom } from "./bom-guard.js";
import {
  beginApply,
  beginJob,
  endApply,
  getApplyProgress,
  resetApplyProgress,
  setApplyProgress,
} from "./apply-progress.js";
import { allowPluginRequest, readJsonBody, sendJson } from "./http.js";
import { renderStatus } from "./status-render.js";
import { createBootSettle } from "./boot-settle.js";
import {
  installCwdCapture,
  installFreshFullAccess,
  installRewindDeriveFilter,
} from "./session-access.js";

export const name = "dsh-purge";

// 不要把 pluginPackages 写进 inject：Cordis 会对 map 里每一个 key 空等。
// 便携拷贝 / Hub 残装经常没有这项服务，一写进去就是 pending → 宿主退出码 1。
export const inject = ["systemPrompt", "tools"];

let bootFullQuit = false;

const DEFAULTS = {
  enabled: true,
  autoApplyOnStart: false,
  autoUpdateOnStart: false,
  autoRevertOnMissing: false,
  injectOnce: false,
  stripMnemon: true,
  postPrompt: "",
  postPromptOrder: 5100,
  verbose: false,
  autoRetry: true,
  retryMax: 3,
  autoContinue: false,
  continueMax: 3,
  continueText: "继续",
  // Codex 风格：教模型主动发现 skill / MCP；不改官方注册与工具面。
  capabilityProtocol: true,
  hooksDenyBypass: true,
  anchorMode: "auto",     // "auto" | "off" —— off 立即关锚点，不用改代码
  subagentControl: true,  // false 立即回滚子代理审批接管
};

/* YAML 里写成 "false" 的布尔会被 JS 当真值：两个默认开启的开关一旦被写成字符串，
   用户以为关了其实还开着。统一收敛一次。 */
export const BOOLEAN_CONFIG_KEYS = [
  "enabled", "autoApplyOnStart", "autoUpdateOnStart", "autoRevertOnMissing",
  "injectOnce", "stripMnemon", "verbose", "autoRetry", "autoContinue",
  "capabilityProtocol", "hooksDenyBypass", "subagentControl",
];

export function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  for (const key of BOOLEAN_CONFIG_KEYS) {
    const value = cfg[key];
    if (typeof value === "string") cfg[key] = !/^(false|0|no|off)$/i.test(value.trim());
  }
  return cfg;
}

const log = (config, ...args) => {
  if (config?.verbose) console.log("[dsh-purge]", ...args);
};

// 启动自愈的依赖装配：日志跟 verbose 走，full-quit 标志要回写到模块级给 /status 读。
const bootSettle = createBootSettle({
  core, hostctl, reapply, officialUpdate, updater,
  settleMayReapply, settleMayRestart, log,
  setBootFullQuit: (v) => { bootFullQuit = v; },
});

// web 树就绪标志与上一次成功的 /status 载荷；/status 与 watchWebTreeReady 共用，
// 因此包成一个对象交给 lib/routes.js，避免两处各持一份而永远对不上。
const webState = { ready: false, lastStatusPayload: null };

function watchWebTreeReady(ctx) {
  // 必须挂在 connection 上再 await，与官方打印 URL 同一时刻。
  // apply() 里立刻 await 会在后续入口尚未入树时提前结束，session.list 仍是空的。
  // 入口复位：热重载 / disposed 后再 apply 会复用上一次 ready=true，第二次 inject 之前跑的
  // /status 把旧标志当准，这里强制重置。
  webState.ready = false;
  const mark = () => {
    webState.ready = true;
  };
  if (typeof ctx?.inject !== "function") {
    mark();
    return;
  }
  try {
    ctx.inject(["connection"], (host) => {
      const settled = host.get?.("loader")?.await?.();
      if (!settled || typeof settled.then !== "function") {
        mark();
        return;
      }
      settled.then(() => {
        if (host.get?.("webServer") !== undefined && host.get?.("connection") !== undefined) mark();
      }, mark);
    });
  } catch {
    mark();
  }
}








/**
 * 停用插件时把运行期钩子收干净。
 * 宿主侧的补丁还在（要等用户 Apply/卸载才还原），它们靠 typeof 判断调用全局钩子；
 * 这里把全局钩子换成空实现 —— 既不会让宿主崩，也不会在停用后继续注入提示词。
 */
function resetRuntimeHooks(ctx) {
  for (const key of [
    "__dshPurgeSessionHook", "__dshPurgePresetHook", "__dshPurgePreStepHook",
    "__dshPurgeAssembleHook", "__dshPurgeMnemonStrip", "__dshPurgeRegionGate",
  ]) {
    try { delete ctx[key]; } catch { /* ignore */ }
  }
  try { globalThis.__dshPurgeHungPrompt = () => ""; } catch { /* ignore */ }
  try { globalThis.__dshPurgePrepareAssemble = () => null; } catch { /* ignore */ }
  // guard 的 dispose 是 noop，停用后 slot.rewrite 仍指向旧闭包（enabled:true）→ 继续注入。
  try { clearAssembleGuard(ctx.systemPrompt); } catch { /* 无 systemPrompt 时无需清理 */ }
  // 隔离 loopCtx 上的 guard 与主 ctx 共用这个标志，一次置位全部失效。
  try { ctx.__dshPurgeDisabled = true; } catch { /* ignore */ }
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled) {
    purgeLog("boot", { enabled: false });
    try { clearOwnedSelectedDefault({ ctx, dshHome: core.findDshHome() }); } catch { /* 停用不被清默认挡住 */ }
    try { removeStaleAgentPresetDir(core.findDshHome(), "redteam"); } catch { /* ignore */ }
    resetRuntimeHooks(ctx);
    return;
  }
  try { delete ctx.__dshPurgeDisabled; } catch { /* ignore */ }
  cancelClearOwnedSelectedDefault();
  try {
    ctx.effect(() => () => {
      try { scheduleClearOwnedSelectedDefault({ ctx, dshHome: core.findDshHome() }); } catch { /* 停用不被清默认挡住 */ }
    });
  } catch { /* 无 effect 时靠 uninstall / enabled:false 清 */ }
  purgeLog("boot", {
    enabled: true,
    surface: hostctl.currentSurface(),
    stripMnemon: cfg.stripMnemon !== false,
    cap: cfg.capabilityProtocol !== false,
  });
  core.setHooksDenyConfigValue(cfg.hooksDenyBypass);
  core.refreshHooksDenySettings();
  try {
    const home = core.pinDshHome() || core.findDshHome();
    purgeLog("home", { home: home || "(none)" });
    try {
      if (home) {
        const flag = path.join(home, ".hung-disabled");
        if (fs.existsSync(flag)) {
          fs.unlinkSync(flag);
          purgeLog("hung-disabled", { removed: flag });
        }
      }
    } catch (e) { purgeLog("hung-disabled", { err: String(e?.message || e) }); }
    installHungPromptGlobal();
    // Apply→cleanup→restart 成功后，默认把加密提示词 seed 进 prompt-inject.md。
    // 用户已经改过的文件不动；只有「没有」或「仍是空文件」时才补写。
    try {
      const seed = core.seedPromptInjectAtBoot(home);
      log(cfg, "seed prompt-inject:", seed?.action || "noop", seed?.reason || "");
    } catch (e) {
      console.warn("[dsh-purge] seed prompt-inject failed:", String(e && e.message ? e.message : e));
    }
    refreshHungOperator(home);
  } catch { /* 主目录还没有时，组装会再挂内置默认 */ }
  // 启动不写宿主包。补丁 / bak / client.js / runtime 只在点「应用」时写一次。
  const life = watchContextLife(ctx);
  if (!life.alive) {
    console.warn("[dsh-purge] skip apply: inactive context");
    return;
  }
  log(cfg, "plugin enabled");
  try {
    const home = core.pinDshHome() || core.findDshHome();
    const healed = ensureAllProfileInstall(home);
    for (const item of healed) {
      if (item.insert?.wrote || item.bundles?.wrote) {
        log(cfg, "profile heal:", item.dir, item.insert?.wrote ? "insert" : "", item.bundles?.wrote ? "bundles" : "");
      }
    }
  } catch { /* 自愈失败不挡主入口 */ }
  // 清单 BOM 自愈：0.2.2 的 readProfileManifest 直接 JSON.parse，带 BOM 的
  // profiles/*/package.json 会让桌面端下次启动直接崩（本轮已经起来了，先修好下一轮）。
  try {
    const home = core.pinDshHome() || core.findDshHome();
    const bomFix = fixProfileBom(home);
    for (const item of bomFix.fixed) log(cfg, "manifest bom stripped:", item.path);
    for (const item of bomFix.failed) console.warn("[dsh-purge] manifest bom fix failed:", item.path, item.error);
  } catch { /* 修不了也不能挡启动 */ }
  core.applyRuntimeEnv();
  try {
    const home = core.pinDshHome() || core.findDshHome();
    refreshHungOperator(home);
  } catch { /* 主目录还没有时，组装会再挂内置默认 */ }

  const settleTimer = setTimeout(() => {
    if (!life.alive) {
      log(cfg, "settle skipped: inactive context");
      return;
    }
    bootSettle.settleInstalledPatches(cfg, ctx, life)
      .then((r) => log(cfg, "settle:", r))
      .catch((e) => {
        if (isInactiveContextError(e)) {
          log(cfg, "settle skipped: inactive context");
          return;
        }
        console.warn("[dsh-purge] settle error:", String(e));
      });
    rules.ensureInitialState(core.findDshHome())
      .then((r) => log(cfg, "rules init:", JSON.stringify(r)))
      .catch((e) => console.warn("[dsh-purge] rules init error:", String(e)));
  }, settleDelayMs(hostctl.currentSurface()));
  try {
    ctx.effect(() => () => clearTimeout(settleTimer));
  } catch (e) {
    if (isInactiveContextError(e)) {
      clearTimeout(settleTimer);
      console.warn("[dsh-purge] skip apply: inactive context");
      return;
    }
    throw e;
  }

  try {
    applyHostHooks(ctx, cfg);
  } catch (e) {
    if (isInactiveContextError(e)) {
      console.warn("[dsh-purge] skip apply: inactive context");
      return;
    }
    throw e;
  }
}

function applyHostHooks(ctx, cfg) {
  try {
    const home = core.pinDshHome() || core.findDshHome();
    refreshHungOperator(home);
  } catch { /* 主目录尚未就绪 */ }
  // 桌面端 office 技能缺失会让启动直接退出；异步补回，别挡启动热路径。
  if (hostctl.currentSurface() === "desktop") {
    setImmediate(() => {
      try {
        const office = core.healOfficeSkillsRuntimeOnDisk();
        if (office && office.healed) purgeLog("heal-office-skills", office);
      } catch { /* 没装桌面或目录不可写 */ }
      // #195: resources/runtime 被清空后，插件市场连"安装"都起不来（pnpm MODULE_NOT_FOUND），
      // 而状态页全绿。这里跟 office 技能一样，启动时探测一次、缺了就从宿主 root 副本原地补齐。
      try {
        const probe = core.inspectRuntimePayload();
        if (probe && probe.ok === false) {
          const healed = core.healRuntimePayloadOnDisk();
          purgeLog("heal-runtime-payload", healed);
        }
      } catch { /* 没装桌面或目录不可写 */ }
    });
  }
  installIdentityOverride(ctx, cfg);
  installRegionGate(ctx);
  installFreshFullAccess(ctx);
  installRewindDeriveFilter(ctx);
  installCwdCapture(ctx);
  installMnemonMessageStrip(ctx, cfg);
  registerPromptSections(ctx, cfg);
  // 尾部锚点 + 子代理审批接管。两者都返回 disposer，统一挂到 ctx.effect 回收；
  // 老宿主没有 effect 时靠 cordis scope 自己回收。
  try {
    const disposeAnchor = registerAnchor(ctx, cfg);
    const disposeSubagent = installSubagentControl(ctx, cfg);
    try {
      ctx.effect(() => () => {
        try { disposeAnchor?.(); } catch { /* 释放过就忽略 */ }
        try { disposeSubagent?.(); } catch { /* 释放过就忽略 */ }
      });
    } catch { /* 已释放 */ }
  } catch (e) {
    purgeLog("apply-hooks", { name: "anchor/subagent", err: String(e?.message || e) });
  }

  // 本次 apply 作用域内的 continue-retry 状态；旧 ctx dispose 会把这些闭包一并带走。
  const continuePluginCfg = cfg;
  const savedContinueSettings = continueRetry.loadSettings(core.findDshHome());
  const continueRuntime = continueRetry.installContinueRetry(ctx, {
    getConfig: () => continueRetry.mergeConfig(continuePluginCfg, savedContinueSettings),
  });
  try {
    ctx.effect(() => () => {
      try { continueRuntime?.dispose?.(); } catch { /* ignore */ }
    });
  } catch { /* 无 effect 时靠 cordis scope 自己回收 */ }

  const commands = ctx.get?.("commands");
  registerChatCommands(commands, {
    config: cfg,
    ctx,
    handlers: {
      purge: (rawInput, config, cmdCtx) => handlePurgeCommand(rawInput, config, cmdCtx, {
        core, uninstaller, reapply, renderStatus, rejectIfNeedPrompt, refreshHungOperator,
        applyShouldRestart, scheduleApplyRestart: bootSettle.scheduleApplyRestart,
      }),
      rules: (rawInput) => handleRulesCommand(rawInput, { refreshHungOperator }),
      skills: (rawInput) => handleSkillsCommand(rawInput),
    },
    rewind,
  });
  registerModelTools(ctx, { core, renderStatus, rejectIfNeedPrompt });

  installWebServer(ctx, cfg);
}

function installWebServer(ctx, cfg) {
  // 桌面端内嵌 @deepseek-ai/dsh-web-app，设置页同样走 webServer（常见 43120），不是只给官方 dsh web。
  watchWebTreeReady(ctx);
  ctx.inject(["webServer"], (host) => {
    host.effect(() => {
      // 收集所有子路由的 unregister disposer；host.effect 的 cleanup 一把全撤。
      // 旧版本只注册不收，plugin reload 时上一轮的 handler 仍挂着，新的叠在之上。
      const routeDisposers = [];
      const trackRoute = (d) => {
        if (typeof d === "function") routeDisposers.push(d);
        return d;
      };
      const registerPluginRoute = (spec, label) => trackRoute(host.webServer.register({
        ...spec,
        handler: async (request, response) => {
          if (!allowPluginRequest(request, response)) return;
          return spec.handler(request, response);
        },
      }, label));
      // 13 条 exact 路由的业务分支在 lib/routes.js，这里只做注册与守卫包装。
      for (const entry of routeSpecs({
        ctx,
        webState,
        setBootFullQuit: (v) => { bootFullQuit = v; },
        getBootFullQuit: () => bootFullQuit,
        refreshHungOperator,
        injectSnapshot,
        rejectIfNeedPrompt,
        ensureRestartReady,
      })) {
        registerPluginRoute(entry.spec, entry.label);
      }
      trackRoute(installRulesHttp(host.webServer, { refreshHungOperator, injectSnapshot }));
      trackRoute(installSkillsHttp(host.webServer));
      return () => {
        for (let i = routeDisposers.length - 1; i >= 0; i -= 1) {
          try { routeDisposers[i](); } catch { /* ignore */ }
        }
        routeDisposers.length = 0;
      };
    }, "dsh-purge: http routes");
  });
}

const plugin = {
  name,
  inject,
  apply,
};

export default plugin;
