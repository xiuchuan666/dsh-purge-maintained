/**
 * 提示词装配的写入侧：mnemon 消息剥离、装配改写、身份覆盖安装。
 *
 * 这一层是「注入到底有没有生效」的最后一段执行路径：installMnemonMessageStrip 决定
 * 插件消息是否进上下文，rewriteLiveAssembly 决定每轮装配长什么样，
 * installIdentityOverride 把 guard 与 waterfall 都挂上。三处判错的表现都是
 * 「AI 行为变了但没有任何报错」，所以单独成文件以便脱离宿主单测。
 *
 * 与 lib/prompt-source.js 的分工：那边只负责读盘与缓存出正文，这边负责把正文写进装配。
 */
import * as core from "./core.js";
import * as rules from "./rules.js";
import {
  isMnemonPluginMessage,
  isRedteamSession,
  installAssembleGuard,
  resolveCwdFromContext,
  rewritePromptAssembly,
  decideInject,
} from "./identity.js";
import { registerAnchor, anchorTextFor, ANCHOR_SECTION } from "./anchor.js";
import { installSubagentRoleCapture, resolveSubagentRoleText } from "./redteam/role-section.js";
import { createLiveCache, liveCacheSignature, sessionKeyOf } from "./live-cache.js";
import {
  installHungPromptGlobal,
  logAssembleDecision,
  purgeLog,
  readInjectFallback,
  readSessionEvents,
  refreshHungOperator,
  registerPromptSections,
  shouldInjectAssembly,
} from "./prompt-source.js";

export function installMnemonMessageStrip(ctx, config = {}) {
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

export function rewriteLiveAssembly(config, assembled, context, decision = { mode: "full", taskKind: "general" }) {
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

export function closerFollowBytes(sections) {
  const closer = "</project_instructions>";
  const joined = (Array.isArray(sections) ? sections : [])
    .map((section) => (typeof section?.text === "string" ? section.text : ""))
    .filter(Boolean)
    .join("\n\n");
  const at = joined.lastIndexOf(closer);
  if (at < 0) return -1;
  return joined.length - (at + closer.length);
}

export function installIdentityOverride(ctx, config = {}) {
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
