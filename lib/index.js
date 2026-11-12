import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "./core.js";
import * as hostctl from "./host.js";
import * as rules from "./rules.js";
import * as skills from "./skills.js";
import * as updater from "./update.js";
import * as reapply from "./reapply.js";
import * as officialUpdate from "./official-update.js";
import {
  GLOBAL_PROMPT_ORDER,
  adaptInjectForMinimalPreset,
  isMnemonPluginMessage,
  isRedteamSession,
  installAssembleGuard,
  clearAssembleGuard,
  modePromptText,
  peelChatmlEnvelope,
  escapeDshInterpolation,
  resolveCwdFromContext,
  rewritePromptAssembly,
  decideInject,
} from "./identity.js";
import { capabilityProtocolText, CAPABILITY_SECTION } from "./capability-protocol.js";
import { registerAnchor, anchorTextFor, ANCHOR_SECTION } from "./anchor.js";
import { installSubagentControl } from "./subagent-control.js";
import { installSubagentRoleCapture, resolveSubagentRoleText } from "./redteam/role-section.js";
import * as rewind from "./rewind.js";
import * as continueRetry from "./continue-retry.js";
import * as uninstaller from "./uninstall.js";
import { readDrillGrant, writeDrillGrant } from "./drill-grant.js";
import { createLiveCache, liveCacheSignature, sessionKeyOf } from "./live-cache.js";
import { installRulesHttp, installSkillsHttp } from "./http-routes.js";
import { registerChatCommands } from "./commands.js";
import { handleRulesCommand, handleSkillsCommand } from "./chat-rules-skills.js";
import { handlePurgeCommand } from "./chat-purge.js";
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

function injectAllowedNow(config) {
  return config.enabled !== false;
}

/** 提示词框自改 > prompt-inject.md > 加密默认（见 rules.resolveInjectText）。 */
// 缓存按 (home, mtime, 提交版本) 失效，不再靠 200ms 时间窗：
// host 每轮 refresh 都会调 __dshPurgeHungPrompt，时间窗一过就全量 sync + 解密 23KB，
// 桌面宿主在这段时间里被拖住（#194）。只有文件或内存正文真的变了才重算。
let hungCache = { home: "", mtime: 0, rev: -1, resolved: null };
// 风暴熔断：正常一轮请求只有个位数调用；10s 内上百次说明有循环在踩，
// 直接返回上一次结果，避免继续拖住宿主主线程。
const HUNG_STORM_WINDOW_MS = 10000;
const HUNG_STORM_LIMIT = 120;
let hungStorm = { at: 0, calls: 0, tripped: false };
function statInjectMtimeMs(home) {
  if (!home) return 0;
  try {
    return Math.floor(fs.statSync(core.findOverrideFile(home)).mtimeMs);
  } catch { return 0; }
}
function refreshHungOperator(dshHome = core.findDshHome()) {
  const home = core.pinDshHome() || dshHome || core.findDshHome();
  const now = Date.now();
  const mtimeBefore = statInjectMtimeMs(home);
  const rev = core.committedOverrideRevision();
  if (
    hungCache.resolved
    && hungCache.home === home
    && hungCache.mtime === mtimeBefore
    && hungCache.rev === rev
  ) {
    return hungCache.resolved;
  }
  if (now - hungStorm.at > HUNG_STORM_WINDOW_MS) {
    hungStorm = { at: now, calls: 0, tripped: false };
  }
  hungStorm.calls += 1;
  if (hungStorm.calls > HUNG_STORM_LIMIT) {
    if (!hungStorm.tripped) {
      hungStorm.tripped = true;
      purgeLog("host.hungStorm", { calls: hungStorm.calls, windowMs: HUNG_STORM_WINDOW_MS });
    }
    if (hungCache.resolved) return hungCache.resolved;
    const pinned = core.hungOperatorPrompt() || "";
    if (pinned) return { text: pinned, source: "storm", ruleId: null };
  }
  try { core.syncPromptInjectOnDiskSync(home); } catch { /* 同步失败仍按 resolve 走 */ }
  const resolved = rules.resolveInjectText(home);
  // 兜底顺序:resolved.text > 加密默认 > 永不空串(避免二轮 fallbackInject 为空走 purge[] 残留)。
  const fallback = core.normalizeOverride(core.defaultOverrideText()) || "";
  // 框、磁盘、加密槽保持原样。发给模型只整理 ChatML 单独成行，并补上缺失的闭合标签。
  const text = resolved.text || fallback;
  if (text) {
    core.hangOperatorPrompt(text);
    // 与点「保存」同一钉钉：不点保存，组装也要读到这一份全文。
    core.rememberCommittedOverride(home, text);
  }
  const out = { ...resolved, text: text || resolved.text };
  // 用 sync 之后的 mtime + 最新提交版本存 cache，下次高频轮询直接命中。
  hungCache = {
    home,
    mtime: statInjectMtimeMs(home),
    rev: core.committedOverrideRevision(),
    resolved: out,
  };
  return out;
}

function installHungPromptGlobal() {
  // host 侧 inject 兜底:正常 cordis assemble 钩子 (rewriteLiveAssembly) 跟这条路径互斥,
  // 不会重复注入;插件首装 / 预设切换 / hung session / 新对话首轮钩子未就绪窗口,靠这里兜。
  // [v10 四重 fallback] 新对话首轮 refreshHungOperator 若因 cache 未就绪 / sync disk 失败 /
  // resolveInjectText 返空(极端情况)任一环节返空,host 这边读到的 inject 真空 → 模型自称
  // "我是 Claude"。四重兜底确保任何路径都不会把空串交给 host:
  //   1) refreshHungOperator — 完整路径(sync disk + resolve + pin)
  //   2) hungOperatorPrompt   — 上次挂上的内存钉子(进程生命周期)
  //   3) readPromptInjectFileSync — 直读磁盘 prompt-inject.md,绕过 sync/resolve
  //   4) defaultOverrideText — 加密槽解包,除非插件安装残缺否则非空
  // 超时熔断（#194）：这是 host 主线程同步调用的函数，一次全量 resolve 若被磁盘/解密
  // 拖到秒级，宿主就整段挂住。连续慢调用后进入冷却期，只交内存里已挂上的正文。
  const HUNG_SLOW_MS = 1500;
  const HUNG_SLOW_COOLDOWN_MS = 30000;
  let hungSlowAt = 0;
  let hungDepth = 0;
  const fn = () => {
    const norm = (s) => peelChatmlEnvelope(String(s || "").replace(/\r\n/g, "\n"));
    // 重入保护：同一轮里再进来只回内存钉子，绝不再走磁盘。
    if (hungDepth > 0) return norm(core.hungOperatorPrompt());
    if (hungSlowAt && Date.now() - hungSlowAt < HUNG_SLOW_COOLDOWN_MS) {
      const pinned = norm(core.hungOperatorPrompt());
      if (pinned) {
        purgeLog("host.hungFn", { tier: "breaker", bytes: pinned.length });
        return pinned;
      }
    }
    let home = "";
    try { home = core.findDshHome(); } catch { home = ""; }
    hungDepth += 1;
    const started = Date.now();
    try {
      try {
        const text = norm(refreshHungOperator(home).text);
        if (text) { purgeLog("host.hungFn", { tier: "refresh", bytes: text.length }); return text; }
      } catch (e) { purgeLog("host.hungFn", { tier: "refresh", err: String(e?.message || e) }); }
      try {
        const hung = norm(core.hungOperatorPrompt());
        if (hung) { purgeLog("host.hungFn", { tier: "hung", bytes: hung.length }); return hung; }
      } catch (e) { purgeLog("host.hungFn", { tier: "hung", err: String(e?.message || e) }); }
      try {
        const disk = norm(core.readPromptInjectFileSync(home));
        if (disk) { purgeLog("host.hungFn", { tier: "disk", bytes: disk.length }); return disk; }
      } catch (e) { purgeLog("host.hungFn", { tier: "disk", err: String(e?.message || e) }); }
      try {
        const sealed = norm(core.defaultOverrideText());
        if (sealed) { purgeLog("host.hungFn", { tier: "sealed", bytes: sealed.length }); return sealed; }
      } catch (e) { purgeLog("host.hungFn", { tier: "sealed", err: String(e?.message || e) }); }
      purgeLog("host.hungFn", { tier: "empty", bytes: 0 });
      return "";
    } finally {
      hungDepth -= 1;
      const cost = Date.now() - started;
      if (cost >= HUNG_SLOW_MS) {
        hungSlowAt = Date.now();
        purgeLog("host.hungFn", { tier: "slow", ms: cost });
      }
    }
  };
  globalThis.__dshPurgeHungPrompt = fn;
  return fn;
}

// 一律全文。工具步裁 6000 / .hung-disabled 两分法会切掉 HARD OUTPUT，第二轮任务必拒。
function shouldInjectAssembly(context) {
  const decision = { mode: "full", taskKind: "general", lastRole: "full", isSubagent: false };
  try {
    decision.isSubagent = context?.agent?.session?.header?.origin === "subagent";
  } catch {}
  if (globalThis.__dshPurgeRetryPending) {
    globalThis.__dshPurgeRetryPending = false;
    decision.lastRole = "retry";
  }
  return decision;
}

function readSessionEvents(session) {
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === "function") return session.snapshotEvents() || [];
  } catch { /* ignore */ }
  try {
    if (Array.isArray(session.events)) return session.events;
  } catch { /* ignore */ }
  return [];
}

// [方案2] 日志探针。写进内部文件,不污染 host stderr。Monitor 实时跟 tail -F。
const PURGE_INTERNAL_LOG = path.join(os.tmpdir(), "dsh-purge-desktop.log");
// 日志翻滚:每 ~1024 次写检查一次大小,>2MB 把当前文件 rename 成 .1 覆盖旧 .1,
// 新文件自动从头开始。长会话 / 热重载反复触发 assemble decision 不会把 tmp 吃爆。
const PURGE_INTERNAL_LOG_MAX = 2 << 20;
let _purgeLogWriteCount = 0;
function rotatePurgeInternalLog() {
  try {
    const st = fs.statSync(PURGE_INTERNAL_LOG);
    if (st.size > PURGE_INTERNAL_LOG_MAX) {
      try { fs.renameSync(PURGE_INTERNAL_LOG, `${PURGE_INTERNAL_LOG}.1`); } catch { /* 并发失败下次再试 */ }
    }
  } catch { /* 文件不存在 */ }
}
// 单行 ISO 时间戳 + 标签 + k=v... 格式。tail -F 跟 / grep 都好读。
// 值里空格会把 kv 切开,统一替换成 _ 保证 grep 稳定。
function purgeLog(tag, kv) {
  try {
    if ((++_purgeLogWriteCount & 0x3ff) === 0) rotatePurgeInternalLog();
    let line = `${new Date().toISOString()} [${tag}]`;
    if (kv) {
      for (const k of Object.keys(kv)) {
        const raw = kv[k];
        const v = raw === undefined || raw === null ? "" : String(raw).replace(/\s+/g, "_");
        line += ` ${k}=${v}`;
      }
    }
    fs.appendFileSync(PURGE_INTERNAL_LOG, line + "\n", "utf8");
  } catch {}
}
function logAssembleDecision(where, decision) {
  purgeLog(`assemble.${where}`, {
    mode: decision.mode,
    task: decision.taskKind,
    last: decision.lastRole,
    sub: decision.isSubagent,
  });
}

function injectSnapshot(dshHome = core.findDshHome()) {
  const resolved = rules.resolveInjectText(dshHome);
  return {
    injectSource: resolved.source,
    injectRuleId: resolved.ruleId,
    needPrompt: resolved.source === "none",
  };
}

/** 框里正在显示的字优先；框空则 resolveInjectText（含 prompt-inject.md）。 */
function injectSnapshotFromBox(dshHome, boxText) {
  if (typeof boxText === "string" && core.normalizeOverride(boxText)) {
    return { injectSource: "prompt", injectRuleId: null, needPrompt: false };
  }
  const resolved = rules.resolveInjectText(dshHome);
  if (resolved.text) {
    return { injectSource: resolved.source, injectRuleId: null, needPrompt: false };
  }
  return { injectSource: "none", injectRuleId: null, needPrompt: true };
}

const NEED_PROMPT_ERROR = "提示词和规则集都是空的，必须先添加提示词";

function rejectIfNeedPrompt(dshHome, boxText) {
  const snap = injectSnapshotFromBox(dshHome, boxText);
  if (!snap.needPrompt) return null;
  return { ...snap, error: NEED_PROMPT_ERROR };
}

async function ensureRestartReady() {
  return core.ensureHostClean();
}

/** 提示词服务自己的 ctx 多半没有 scope，段会进全局层。插件若挂在某个 scope 上，预设代理的父链看不到那一层。 */
function addPromptSection(ctx, section) {
  const hosts = [];
  const push = (host) => {
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  try { push(ctx?.systemPrompt?.ctx); } catch { /* 代理未注入时点属性会抛 */ }
  push(ctx);
  const disposers = [];
  let registered = false;
  let lastError = null;
  for (const host of hosts) {
    try {
      const d = host.systemPrompt.section(section);
      registered = true;
      if (typeof d === "function") disposers.push(d);
    } catch (error) {
      const msg = String(error && error.message || error);
      if (msg.includes("already registered")) registered = true;
      else lastError = error;
    }
  }
  if (!registered && lastError) throw lastError;
  // 让 ctx.effect 在 reload / dispose 时把 section 一并撤掉；host.systemPrompt.section
  // 当前多半不返回 disposer，这段只对返回 function 的实现生效，不改变旧行为。
  if (disposers.length && typeof ctx?.effect === "function") {
    try {
      ctx.effect(() => () => {
        for (const d of disposers) {
          try { d(); } catch { /* ignore */ }
        }
      });
    } catch { /* 死 ctx */ }
  }
}

export function registerPromptSections(ctx, config) {
  addPromptSection(ctx, {
    name: "dsh-purge",
    order: GLOBAL_PROMPT_ORDER,
    interpolate: false,
    text: (context) => {
      if (!injectAllowedNow(config)) return "";
      // 标准、极简都注入同一份正文。极简只改工具句，不决定注不注入。
      return escapeDshInterpolation(
        peelChatmlEnvelope(adaptInjectForMinimalPreset(readInjectFallback(context), context)),
      );
    },
  });

  if (config.capabilityProtocol !== false) {
    addPromptSection(ctx, {
      name: CAPABILITY_SECTION,
      order: GLOBAL_PROMPT_ORDER + 1,
      interpolate: false,
      text: (context) => {
        if (!injectAllowedNow(config)) return "";
        const redteam = isRedteamSession(context);
        return capabilityProtocolText({
          redteam,
          redteamChild: false,
          enabled: true,
        });
      },
    });
  }

  const postPrompt = typeof config.postPrompt === "string" ? config.postPrompt.trim() : "";
  if (!postPrompt) return;
  if (!Number.isFinite(config.postPromptOrder) || config.postPromptOrder <= GLOBAL_PROMPT_ORDER) {
    // 旧版 throw 会把整个 apply 炸掉；postPrompt 只是附加段，降级 skip 不影响核心注入。
    console.warn(
      `[dsh-purge] postPromptOrder (${config.postPromptOrder}) 需要是 > ${GLOBAL_PROMPT_ORDER} 的有限数；跳过 postPrompt 段`,
    );
    return;
  }
  addPromptSection(ctx, {
    name: "dsh-purge:post",
    order: config.postPromptOrder,
    text: () => (injectAllowedNow(config) ? postPrompt : ""),
  });
}

function readInjectFallback(context) {
  let home = "";
  try { home = core.findDshHome(); } catch { home = ""; }
  const refreshed = refreshHungOperator(home);
  let text = refreshed.text || "";
  let source = text ? "refresh" : "none";
  if (!text) {
    const fallback = rules.ensureOperatorBody(home);
    if (fallback) { text = fallback; source = "ensure"; }
  }
  if (!text) {
    purgeLog("inject.read", { source: "empty", bytes: 0 });
    return "";
  }
  let redteam = false;
  try { redteam = isRedteamSession(context); } catch { redteam = false; }
  let subagent = false;
  try { subagent = context?.agent?.session?.header?.origin === "subagent"; } catch {}
  const out = modePromptText(text, redteam);
  purgeLog("inject.read", {
    source,
    srcTag: refreshed.source || "n/a",
    redteam,
    sub: subagent,
    rawBytes: text.length,
    outBytes: out.length,
  });
  return out;
}

function installMnemonMessageStrip(ctx, config = {}) {
  if (typeof ctx.on !== "function") return;
  if (ctx.__dshPurgeMnemonStrip) return;
  ctx.__dshPurgeMnemonStrip = true;
  const strip = config.stripMnemon !== false;
  const wrap = async (_payload, next) => {
    const decision = await next();
    if (!decision) return decision;
    // agent-loop 会读 decision.messages.length；缺数组时第二轮直接 gateway/internal 炸掉。
    const incoming = Array.isArray(decision.messages) ? decision.messages : [];
    const messages = strip ? incoming.filter((message) => !isMnemonPluginMessage(message)) : incoming;
    if (messages.length === incoming.length && Array.isArray(decision.messages)) return decision;
    return { ...decision, messages };
  };
  // 旧版 late() + queueMicrotask(late) + setTimeout(late, 1500) 三连都成功时，
  // 同一个 wrap 会在 agent/pre-step 瀑布上叠 3 层；中间插件返回的 decision 每轮被过滤 3 次。
  // 这里用 mounted 闸：第一次成功挂上就不再重试，拿回 disposer 走 ctx.effect 回收。
  let mounted = false;
  let dispose = null;
  const late = () => {
    if (mounted) return;
    try {
      const d = ctx.on("agent/pre-step", wrap, { global: true, prepend: true });
      mounted = true;
      if (typeof d === "function") dispose = d;
    } catch { /* 下一次重试 */ }
  };
  late();
  if (!mounted) queueMicrotask(late);
  let retryTimer = null;
  if (!mounted) {
    retryTimer = setTimeout(late, 1500);
    if (typeof retryTimer.unref === "function") retryTimer.unref();
  }
  try {
    ctx.effect(() => () => {
      if (retryTimer) clearTimeout(retryTimer);
      try { dispose?.(); } catch { /* ignore */ }
    });
  } catch { /* 死 ctx 时无 effect，靠下一次 apply 覆盖 */ }
}

// assemble 可能被 guard 和 waterfall 各处理一次；同一对象只改写一次。
// 签名算法与命中规则在 lib/live-cache.js（纯函数，有 test-live-cache.mjs 守着）。
const liveRewriteCache = createLiveCache();

function rewriteLiveAssembly(config, assembled, context, decision = { mode: "full", taskKind: "general" }) {
  // 同一份 assembly 可能同时经过 assemble guard 和 system-prompt/assemble 瀑布：
  // 第二次进来内容没变，没必要再走一遍 22k 正文处理。WeakMap 随对象回收，不累积。
  // 缓存键必须带上配置与会话签名：宿主复用同一个 assembly 对象时，光按对象做键
  // 会把上一轮的改写结果套到这一轮（改了开关/换了会话却看不到变化）。
  const sigHome = config.enabled !== false ? core.findDshHome() : "";
  const sigPolicy = config.enabled !== false && sigHome ? rules.readWorkspacePolicy(sigHome) : "always";
  const sigRedteam = config.enabled !== false && isRedteamSession(context);
  const sigRevision = config.enabled !== false ? core.committedOverrideRevision() : "";
  const cacheSig = liveCacheSignature({
    config,
    decision,
    redteam: sigRedteam,
    policy: sigPolicy,
    revision: sigRevision,
    session: sessionKeyOf(context),
  });
  const cached = liveRewriteCache.get(assembled, cacheSig);
  if (cached !== undefined) return cached;
  const enabled = config.enabled !== false;
  const redteam = sigRedteam;
  const full = enabled ? readInjectFallback(context) : "";
  const dshHome = sigHome;
  const cwd = resolveCwdFromContext(context);
  if (dshHome && cwd) {
    try { rules.writeLastCwd(dshHome, cwd); } catch { /* ignore */ }
  }
  const policy = sigPolicy;
  // 提示词框为空时才启用勾选的本地 cwd 规则兜底;避免跟 prompt-inject.md 叠加污染。
  let localInject = "";
  if (enabled && dshHome && !String(full || "").trim()) {
    try { localInject = rules.readSelectedCwdInject(dshHome, cwd); } catch { /* ignore */ }
  }
  // 优先级与 dropWorkspaceBaseline 的判定抽到 identity.js 的 decideInject（纯函数，
  // 有 test-prompt-inject.mjs 守着）。这里只负责读盘与副作用，不再自己算一遍。
  const injectDecision = decideInject({ enabled, policy, full, localInject });
  const inject = injectDecision.inject;
  const dropWorkspaceBaseline = injectDecision.dropWorkspaceBaseline;
  const roleText = redteam ? resolveSubagentRoleText(context) : "";
  const rewritten = rewritePromptAssembly(assembled, {
    fallbackInject: inject,
    dropMnemon: config.stripMnemon !== false,
    dropPurgeAfterFold: false,
    capabilityProtocol: config.capabilityProtocol !== false,
    context,
    roleText,
    dropWorkspaceBaseline,
    anchorText: enabled ? anchorTextFor(config) : "",
  });
  const anchorApplied = Array.isArray(rewritten?.sections)
    && rewritten.sections.some((section) => String(section?.name || "") === ANCHOR_SECTION);
  const closerFollow = closerFollowBytes(rewritten?.sections);
  // 主会话审批策略探针：never 会让 decide() 在 approval/request 瀑布之前直接 rejected，
  // 这是「一直拒绝」最直接的证据，必须随每轮装配打出来。
  const approvalPolicy = (() => {
    try {
      const session = context?.agent?.session;
      const svc = context?.agent?.ctx?.get?.("approval");
      return typeof svc?.effectivePolicy === "function" ? svc.effectivePolicy(session) : "n/a";
    } catch { return "n/a"; }
  })();
  purgeLog("assemble.rewrite", {
    enabled,
    redteam,
    mode: decision?.mode || "full",
    task: decision?.taskKind || "general",
    last: decision?.lastRole || "unknown",
    fullBytes: full.length,
    localBytes: localInject.length,
    injectBytes: inject.length,
    anchorApplied,
    roleBytes: roleText.length,
    cap: config.capabilityProtocol !== false,
    strip: config.stripMnemon !== false,
    policy,
    approval: approvalPolicy,
    dropWorkspaceBaseline,
    injectHead: Array.isArray(rewritten?.sections) && rewritten.sections[0]?.name === "dsh-purge",
    // 接上锚点之后最后一段的 name 是 dsh-purge:anchor，不是 dsh-purge。
    injectTail: Array.isArray(rewritten?.sections) && rewritten.sections.length > 0
      && /^dsh-purge(:|$)/.test(String(rewritten.sections[rewritten.sections.length - 1]?.name || "")),
    chatml: Array.isArray(rewritten?.sections) && /<project_instructions>|<\|im_start\|>/i.test(String(rewritten.sections[0]?.text || "")),
    afterCloser: closerFollow,
    cwd,
  });
  liveRewriteCache.set(assembled, cacheSig, rewritten);
  return rewritten;
}

function closerFollowBytes(sections) {
  const closer = "</project_instructions>";
  const joined = (Array.isArray(sections) ? sections : [])
    .map((section) => (typeof section?.text === "string" ? section.text : ""))
    .filter(Boolean)
    .join("\n\n");
  const at = joined.lastIndexOf(closer);
  if (at < 0) return -1;
  return joined.length - (at + closer.length);
}

function installIdentityOverride(ctx, config = {}) {
  if (typeof ctx.on !== "function") return;
  installSubagentRoleCapture(ctx);
  // installAssembleGuard 幂等:slot.rewrite 已挂的 prompt 对象只刷新 rewriteFn,
  // 不再 return 新 dispose。原实现每 400ms + 每 pre-step push 一个 noop closure 入 Set,
  // 2 小时 session 累积上万条。改为:只 track 首次真正挂上的 disposer。
  const wrapDisposers = new Set();
  const wrappedPrompts = new WeakSet();
  const trackDisposer = (d, prompt) => {
    if (typeof d !== "function") return d;
    if (prompt) {
      if (wrappedPrompts.has(prompt)) return d;
      wrappedPrompts.add(prompt);
    }
    wrapDisposers.add(d);
    return d;
  };
  const rewriteFn = (assembled, context) => {
    // 停用后旧 guard（包括隔离 loopCtx 上那份）必须立刻失效。不枚举 prompt：
    // 每个 rewriteFn 都捕获同一个 ctx，读一个运行时标志即可。
    if (ctx.__dshPurgeDisabled === true) return assembled;
    // [方案2] installAssembleGuard 走的也是这条路径,同样决策 full/anchor。
    const decision = shouldInjectAssembly(context);
    logAssembleDecision("rewriteFn", decision);
    return rewriteLiveAssembly(config, assembled, context, decision);
  };
  // interval 心跳每 400ms 调一次,正常稳态下所有参数不变 — 只在状态翻转或出错时写日志,
  // 避免每天上百万条 guard.wrap 把 7MB 日志刷爆、把真正事件淹没。
  let lastGuardSig = "";
  const wrapAssemble = (caller = "unknown") => {
    try {
      const prompt = ctx.systemPrompt;
      const d = installAssembleGuard(prompt, rewriteFn);
      const mounted = typeof d === "function";
      const tracked = trackDisposer(d, prompt);
      const sig = `${!!prompt}|${mounted}`;
      if (sig !== lastGuardSig) {
        purgeLog("guard.wrap", { caller, prompt: !!prompt, mounted });
        lastGuardSig = sig;
      }
      return tracked;
    } catch (e) {
      purgeLog("guard.wrap", { caller, err: String(e?.message || e) });
      lastGuardSig = "";
      return false;
    }
  };
  if (!ctx.__dshPurgeAssembleHook) {
    ctx.__dshPurgeAssembleHook = true;
    // cordis 不同版本的 waterfall 可能是 (assembly, context) 或 (assembly, context, next)：
    // 旧写法把 `next` 当函数直接取第 3 位，老宿主就拿到 context 当 next，await next() 立刻抛。
    // disposer 不进 wrapDisposers:ctx.effect cleanup 在 child scope 结束/预设切换都会触发,
    // 收集进去的话会被误解绑,之后再也挂不回来。cordis 真 dispose 时 listener 自己跟 ctx 释放。
    try {
      ctx.on("system-prompt/assemble", async (...args) => {
        const [assembly, context] = args;
        const next = args.length >= 3 ? args[args.length - 1] : null;
        // 入口即记录 — 看请求是否真的到达了我们的 handler;hasNext=false 时说明 cordis
        // 走的旧签名,下游 waterfall 全靠我们返回的 assembled。
        let eventsLen = 0;
        try { eventsLen = readSessionEvents(context?.agent?.session).length; } catch {}
        purgeLog("assemble.entry", {
          hasNext: typeof next === "function",
          sections: Array.isArray(assembly?.sections) ? assembly.sections.length : -1,
          events: eventsLen,
        });
        let assembled = assembly;
        if (typeof next === "function") {
          try {
            assembled = await next();
          } catch (err) {
            // 下游 waterfall 任一环节抛就会把整条 assemble 弄死,UI 卡住发不出去。
            // 吞掉改用上游装配兜底,inject 保底能挂上。
            try { console.warn("[dsh-purge] system-prompt/assemble waterfall rejected:", err?.message || err); } catch {}
            purgeLog("assemble.waterfall", { err: String(err?.message || err) });
            assembled = assembly;
          }
        }
        try {
          // [v10] 事件处理器开场主动 refresh:新对话首轮 hungCache 可能 null、
          // installAssembleGuard 可能还没包上 systemPrompt,这里强制把 pinned/磁盘读热,
          // 保证 readInjectFallback → refreshHungOperator 命中已 warm 的 cache 不走回空值路径。
          try { refreshHungOperator(core.findDshHome()); } catch { /* resolve 过程异常不阻塞 */ }
          const decision = shouldInjectAssembly(context);
          logAssembleDecision("event", decision);
          return rewriteLiveAssembly(config, assembled, context, decision);
        } catch (err) {
          try { console.warn("[dsh-purge] rewriteLiveAssembly failed:", err?.message || err); } catch {}
          purgeLog("assemble.rewriteFail", { err: String(err?.message || err) });
          return assembled;
        }
      }, { global: true, prepend: true });
    } catch { /* ctx.on 老版本签名异常,下次 apply 覆盖 */ }
  }
  // 切换预设会换掉 assemble。pre-step 瀑布在 assemble 之后才跑，第一次发送包不上。
  // 宿主在 assemble 之前调用这个函数，用的就是当前模式自己的 systemPrompt。
  const prepareAssemble = (loopCtx) => {
    try { refreshHungOperator(core.findDshHome()); } catch { /* 主目录还没有提示词 */ }
    // loopCtx 可能是宿主的 Proxy，访问 .systemPrompt 自身就会抛（代理层尚未注入服务）。
    let prompt = null;
    try { prompt = loopCtx && loopCtx.systemPrompt; } catch { prompt = null; }
    if (prompt) {
      try {
        trackDisposer(installAssembleGuard(prompt, rewriteFn), prompt);
      } catch { /* 这一层代理包不上时，下面再包插件自己的 */ }
    }
    try {
      const iso = (loopCtx && loopCtx.ctx) || loopCtx;
      if (iso && iso !== ctx) {
        registerPromptSections(iso, config);
        // 不补这一行，切换隔离上下文后锚点会消失。
        registerAnchor(iso, config);
      }
    } catch { /* 隔离层还没有 systemPrompt */ }
    wrapAssemble("prepareAssemble");
    return prompt || null;
  };
  globalThis.__dshPurgePrepareAssemble = prepareAssemble;
  const hungFn = installHungPromptGlobal();
  // complete:true 会在 waterfall 之后盖掉 sections；包住 assemble 返回值，每轮都补回注入。
  wrapAssemble("init");
  // guard 需要在每次 cordis 换 systemPrompt 代理时重挂（session 内切预设、subagent fork、
  // live-mount）。原本 20 秒后 clearInterval，之后换代理就包不上 → 第二轮 inject 走原生
  // assemble → 宿主按 token 预算裁剪 → 用户看到"只截取了部分"。installAssembleGuard 幂等
  // （wrappedPrompts WeakSet + 对象 identity 校验），400ms 持续跑到 ctx dispose 的 CPU 代价可忽略。
  // 400ms 回滚:2000ms 窗口 → 新对话第一次 assemble 可能跑在钩子挂上之前,inject 塌。
  // CPU 代价(幂等 wrap)相比"新对话失效"的用户感知,根本不值一提。
  const timer = setInterval(() => wrapAssemble("interval"), 400);
  if (typeof timer.unref === "function") timer.unref();
  // 下面三个 ctx.on 必须加 flag:installIdentityOverride 若被同一 ctx 二次 apply
  // (dispose 后重 mount / 热重载),listener 叠加会让 inject 跑 N 遍,也让 wrap 挂 N 层。
  if (!ctx.__dshPurgeSessionHook) {
    ctx.__dshPurgeSessionHook = true;
    try {
      ctx.on("session/created", () => {
        try { refreshHungOperator(core.findDshHome()); } catch { /* 主目录还没有提示词 */ }
        wrapAssemble("sessionCreated");
      });
    } catch { /* ignore */ }
  }
  if (!ctx.__dshPurgePresetHook) {
    ctx.__dshPurgePresetHook = true;
    try {
      ctx.on("agent-preset/selected", () => {
        try { refreshHungOperator(core.findDshHome()); } catch { /* 主目录还没有提示词 */ }
        wrapAssemble("presetSelected");
      }, { global: true });
    } catch { /* ignore */ }
  }
  if (!ctx.__dshPurgePreStepHook) {
    ctx.__dshPurgePreStepHook = true;
    try {
      ctx.on("agent/pre-step", (payload, next) => {
        wrapAssemble("preStep");
        return typeof next === "function" ? next() : payload;
      }, { global: true, prepend: true });
    } catch { /* ignore */ }
  }
  // 热重载/卸载时统一回收：轮询 timer、guard 代理层、暴露给 agent loop 的全局钩子，
  // 都在同一个 effect 里扫掉；避免下次 apply 再绑一层造成多次写入。
  try {
    ctx.effect(() => () => {
      clearInterval(timer);
      for (const d of wrapDisposers) {
        try { d(); } catch { /* ignore */ }
      }
      wrapDisposers.clear();
      // 清 flag,下次 apply 允许重新挂 listener;不然 ctx 复用时沉默无响应。
      delete ctx.__dshPurgeSessionHook;
      delete ctx.__dshPurgePresetHook;
      delete ctx.__dshPurgePreStepHook;
      /* 这两面 flag 以前没人清：热重载后 MnemonStrip / RegionGate 以为还装着，直接跳过。 */
      delete ctx.__dshPurgeMnemonStrip;
      delete ctx.__dshPurgeRegionGate;
      // [v10] AssembleHook 也要清。原漏删,ctx 复用时新 apply 看到 flag=true 直接跳过
      // ctx.on("system-prompt/assemble", ...),cordis event listener 永远不装 → 新对话首轮
      // 完全依赖 400ms setInterval wrapAssemble 的 guard,时间窗没赶上就 inject 真空。
      delete ctx.__dshPurgeAssembleHook;
      // 新对话 / 热重载会先 dispose 再 apply。这里若删全局 hung，
      // 空窗里立刻发送 hang 读到空串，必须等下一次 apply 才恢复。
    });
  } catch { /* 无 effect 时靠 unref + 下次 apply 自覆盖 */ }
}

function shimNeedsPatch(state) {
  if (hostctl.currentSurface() === "desktop") return false;
  return (
    state.shim_cmd === "original" ||
    state.shim_ps1 === "original" ||
    state.shim_bin === "original"
  );
}

function currentSettleScope() {
  let sealed = false;
  try { sealed = core.desktopAsarStillSealed(); } catch { /* 非桌面或还没定位安装目录 */ }
  return { surface: hostctl.currentSurface(), sealed };
}

async function settleInstalledPatches(config, ctx, life) {
  if (life && !life.alive) return "skip:inactive";
  try { core.rememberUnpackedArchive(); } catch { /* 没有官方安装目录时不必记归档 */ }
  try {
    reapply.ensureInstalledRevSeed();
  } catch (e) {
    log(config, "seed installed-rev failed:", String(e && e.message ? e.message : e));
  }
  try {
    if (reapply.healEmptyAppliedStamp()) log(config, "healed empty applied stamp");
  } catch (e) {
    log(config, "heal applied stamp failed:", String(e && e.message ? e.message : e));
  }

  if (config.autoApplyOnStart !== true) {
    try {
      if (await reapply.patchesMatchInstallStrict() || await reapply.hostCleanEnoughToKeep()) {
        reapply.markPatchesApplied();
        log(config, "boot: host files left untouched; stamp kept");
        return "boot:host-untouched";
      }
    } catch { /* 没戳也没关系，等用户点应用 */ }
    log(config, "boot: skip host writes (Apply once)");
    return "skip:boot-no-host-write";
  }

  const scope = currentSettleScope();
  if (!(await reapply.patchesMatchInstallStrict())) {
    if (!settleMayReapply(scope)) {
      log(config, "sealed desktop: skip startup reapply (wait for Apply)");
      return "skip:sealed-wait-apply";
    }
    if (await reapply.hostCleanEnoughToKeep()) {
      reapply.markPatchesApplied();
      log(config, "host already clean; kept patches and refreshed stamp");
      return "already-clean";
    }
    if (officialUpdate.upgradeMarkerExists(process.execPath)) {
      const upgraded = await reapply.reapplyInstalled({ scheduleSwap: false, upgrade: true });
      if (life && !life.alive) return "skip:inactive";
      if (!upgraded.ok) {
        log(config, "official upgrade reapply failed:", upgraded.error || "");
        return "reapply-failed";
      }
      officialUpdate.clearUpgradeMarker(process.execPath);
      officialUpdate.clearStaleExtractedApps(process.execPath);
      if (!settleMayRestart(currentSettleScope()) || reapply.shouldSkipSettleRestart()) {
        if (upgraded.needsFullQuit) bootFullQuit = true;
        log(config, "official upgrade reapplied; skip settle restart");
        return "reapplied-no-restart";
      }
      reapply.markSettleRestart();
      log(config, "official upgrade reapplied; restarting onto the new build");
      // ctx 可能在 reapply.reapplyInstalled 的 await 中被 dispose；重启前再查一次。
      if (life && !life.alive) return "skip:inactive";
      try {
        hostctl.scheduleRestart(null, ctx, { openBrowser: false });
      } catch (e) {
        log(config, "restart after official upgrade failed:", String(e && e.message ? e.message : e));
        return "restart-failed";
      }
      return "restarting";
    }

    // 启动自愈只写盘，不 swap asar / 不杀进程，避免官方 Host Fiber._reload 撞 INACTIVE_EFFECT。
    const result = await reapply.reapplyInstalled({ scheduleSwap: false });
    if (life && !life.alive) return "skip:inactive";
    if (!result.ok) {
      log(config, "reapply failed:", result.error || "");
      return "reapply-failed";
    }
    // reapply 成功后强制保证非空戳，避免 clean 路径漏写又空转（#59/#60）。
    try { reapply.markPatchesApplied(); } catch { /* ignore */ }
    if (result.needsFullQuit) {
      bootFullQuit = true;
      log(config, "reapply wrote patches; official host needs a full quit");
      return "full-quit";
    }
    if (!settleMayRestart(currentSettleScope())) {
      log(config, "reapply wrote patches; desktop settle does not restart");
      return "reapplied-no-restart";
    }
    if (reapply.shouldSkipSettleRestart()) {
      log(config, "reapply wrote patches; skip settle restart (cooldown)");
      return "reapplied-no-restart";
    }
    // 已对齐则不必再重启；只在 stamp/宿主仍不一致时重启一次。
    if (await reapply.patchesMatchInstallStrict()) {
      log(config, "reapply wrote patches; already aligned, no restart");
      return "reapplied";
    }
    reapply.markSettleRestart();
    log(config, "reapply wrote patches; restarting");
    // reapplyInstalled 自带 await；重启前再查一次 life，避免对 disposed ctx 发起 scheduleRestart。
    if (life && !life.alive) return "skip:inactive";
    try {
      // web：自愈重启不弹浏览器，关窗后不应再被反复拉起新窗口（#59/#61）。
      hostctl.scheduleRestart(null, ctx, { openBrowser: false });
    } catch (e) {
      log(config, "restart after reapply failed:", String(e && e.message ? e.message : e));
      return "restart-failed";
    }
    return "restarting";
  }

  const applied = await autoApply(config);
  if (config.autoUpdateOnStart === true) {
    updater.autoUpdateIfNeeded()
      .then((r) => {
        // ctx 可能在 autoUpdate 等待网络的过程中被 dispose（热重载 / 卸载）。
        // 回调里再碰 ctx.scheduleRestart 会命中 INACTIVE_EFFECT。
        if (life && !life.alive) return;
        log(config, "auto-update:", JSON.stringify(r));
        if (r && r.needsFullQuit) bootFullQuit = true;
        if (r && r.restartAfter && settleMayRestart(currentSettleScope())) {
          if (life && !life.alive) return;
          try { hostctl.scheduleRestart(null, ctx, { openBrowser: false }); } catch (e) {
            console.warn("[dsh-purge] auto-update restart failed:", e);
          }
        }
      })
      .catch((e) => console.warn("[dsh-purge] auto-update error:", String(e)));
  }
  return applied;
}

async function autoApply(config) {
  try {
    core.applyRuntimeEnv();
    const sanitized = core.sanitizeDesktopCommandRuntimes();
    if (sanitized.length) log(config, "desktop runtime sanitized:", JSON.stringify(sanitized));

    core.refreshHooksDenySettings();
    if (core.getHooksDenySettings().hooksDenyBypass === false) {
      const restored = await core.restoreHookDenyForBases(core.enumeratePatchAiBases());
      if (restored.failed.length) {
        log(config, "hooks-deny restore leftover:", restored.failed.join(","));
      }
    }

    const state = await core.gatherState();
    if (!state.ai_base) {
      log(config, "skip auto-apply: plugin root not found");
      return "skip:plugin_root_not_found";
    }
    try {
      const flash = core.silenceCmdFlash(state.ai_base);
      log(config, "cmd-flash:", JSON.stringify(flash));
      if (!flash.ok) log(config, "cmd-flash incomplete:", flash.entry);
    } catch (e) {
      log(config, "cmd-flash failed:", String(e));
    }

    if (state.patches_pending === 0) {
      if (config.autoApplyOnStart && shimNeedsPatch(state)) {
        await core.patchAllShims();
        core.silenceCmdFlash(state.ai_base);
        log(config, "auto-apply: patches clean, shim refreshed");
        return "already_clean:shim_patched";
      }
      log(config, "auto-apply: already clean");
      return "already_clean";
    }
    if (!config.autoApplyOnStart) {
      log(config, "auto-apply disabled");
      return "disabled";
    }
    const autoMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, { preserveClientBundles: true });
    await core.patchAllShims();
    const report = autoMulti.report;
    const flash = core.silenceCmdFlash(autoMulti.hosts[0]?.aiBase || state.ai_base);
    const applied = report.filter((r) => r.status === "applied").length;
    log(config, `auto-apply done: ${applied} applied; cmd-flash=${flash.entry} ok=${flash.ok}`);
    return flash.ok ? `applied:${applied}` : `applied:${applied}:cmd_flash_incomplete`;
  } catch (e) {
    console.warn("[dsh-purge] auto-apply error:", String(e));
    return `error:${e}`;
  }
}

/** 应用之后的那一次重启。密封包退出再打开，不再干等用户自己退出。 */
function scheduleApplyRestart(shouldRestart, ctx = null) {
  if (!shouldRestart) return { restarting: false };
  if (core.desktopAsarStillSealed()) {
    // 透传 ctx 给核心层,让密封包重启也能走 PowerShell 立即 kill Electron + requestRestart
    // 双保险路径,不再弹"host stopped"崩溃对话框 (#64)。
    const planned = core.restartSealedDesktopIfNeeded({ ctx });
    return {
      ...(planned || {}),
      restarting: Boolean(planned && (planned.restarting || planned.asarSwap)),
    };
  }
  try {
    const planned = hostctl.scheduleRestart(null, ctx);
    if (planned && (planned.restarting === false || planned.clean === false)) return planned;
    return planned || { restarting: true };
  } catch (error) {
    return { restarting: false, error: String(error && error.message ? error.message : error) };
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
    settleInstalledPatches(cfg, ctx, life)
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
        applyShouldRestart, scheduleApplyRestart,
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
