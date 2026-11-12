// 提示词来源与内部诊断日志。
//
// 这一层只做三件事：把「当前该注入的正文」从（提示词框 > prompt-inject.md > 加密默认）里读出来、
// 按 (home, mtime, 提交版本) 缓存并做风暴/慢调用熔断、把过程写进临时日志文件供 tail -F 跟。
// 它不认识 Cordis：唯一的宿主接触面是 globalThis.__dshPurgeHungPrompt（installHungPromptGlobal），
// 那是宿主侧同步兜底直接调用的裸函数。
//
// 从 lib/index.js 搬出来的理由：这 339 行原先在 index.js 里一行都测不到，
// 坏了的表现是「模型自称我是 Claude」或「首轮注入是空串」，全程不报错。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "./core.js";
import * as rules from "./rules.js";
import {
  GLOBAL_PROMPT_ORDER,
  adaptInjectForMinimalPreset,
  isRedteamSession,
  modePromptText,
  peelChatmlEnvelope,
  escapeDshInterpolation,
} from "./identity.js";
import { capabilityProtocolText, CAPABILITY_SECTION } from "./capability-protocol.js";

export function injectAllowedNow(config) {
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
export function refreshHungOperator(dshHome = core.findDshHome()) {
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

export function installHungPromptGlobal() {
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
export function shouldInjectAssembly(context) {
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

export function readSessionEvents(session) {
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
export function purgeLog(tag, kv) {
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
export function logAssembleDecision(where, decision) {
  purgeLog(`assemble.${where}`, {
    mode: decision.mode,
    task: decision.taskKind,
    last: decision.lastRole,
    sub: decision.isSubagent,
  });
}

export function injectSnapshot(dshHome = core.findDshHome()) {
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

export function rejectIfNeedPrompt(dshHome, boxText) {
  const snap = injectSnapshotFromBox(dshHome, boxText);
  if (!snap.needPrompt) return null;
  return { ...snap, error: NEED_PROMPT_ERROR };
}

export async function ensureRestartReady() {
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

export function readInjectFallback(context) {
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
