// assemble 改写缓存的纯逻辑层。
//
// 背景：宿主可能把同一份 assembly 对象先后交给 assemble guard 与
// system-prompt/assemble 瀑布，我们只该改写一次；但缓存键**不能**只用对象本身——
// 宿主复用同一个 assembly 对象时，上一轮的改写结果会被套到这一轮，表现就是
// 「改了开关 / 换了会话，提示词却没变」。用户能直接感知这种失效，却看不到任何报错，
// 所以签名必须覆盖所有会改变输出的输入，并由 scripts/test-live-cache.mjs 逐项钉住。
//
// 这里只做纯计算与 WeakMap 存取，读盘与副作用仍留在 lib/index.js。

/**
 * 会话标识：优先 header.id，退到 header.sessionId，再退到空串；cwd 一并计入，
 * 因为 cwd 会改变 workspace 规则与 cwd 兜底注入。属性访问可能抛（代理未注入），
 * 抛了就当没有会话，不能把异常冒到 assemble 路径上。
 * @returns {string} `${id}|${cwd}`
 */
export function sessionKeyOf(context) {
  try {
    const header = context?.agent?.session?.header || {};
    return `${header.id || header.sessionId || ""}|${header.cwd || ""}`;
  } catch {
    return "";
  }
}

// 相邻字段之间必须有不可能是合法取值的分隔符，否则会出现「前一段的尾巴 + 后一段的头」
// 拼成同一个字符串的碰撞（例如 anchorMode="auto" + policy="fallback" 与
// anchorMode="autofall" + policy="back"）。anchorMode 目前不做枚举校验，
// 用户配置里真的可能写出这种值，所以沿用原有的 \u0001 分隔（与拆分前逐字一致）。
const SIG_SEP = "\u0001";

/**
 * 计算改写缓存签名。字段顺序固定，改动这里必须同步 scripts/test-live-cache.mjs。
 *
 * 每一项都对应一个「变了就必须重算」的输入：
 * - enabled / capabilityProtocol / stripMnemon / subagentControl / anchorMode：影响注入正文与段结构
 * - decision.mode / decision.taskKind：影响裁剪策略
 * - redteam：演练台会话会换成另一套角色段
 * - policy：workspace 策略决定是否剥掉宿主基线段
 * - revision：提示词框刚提交时 mtime 可能没变，靠版本号让缓存失效
 * - session：换会话 / 换 cwd 必须重算
 *
 * @param {{config?: object, decision?: object, redteam?: boolean, policy?: string, revision?: number|string, session?: string}} parts
 * @returns {string}
 */
export function liveCacheSignature(parts = {}) {
  const config = parts.config || {};
  const decision = parts.decision || { mode: "full", taskKind: "general" };
  return [
    config.enabled !== false,
    config.capabilityProtocol !== false,
    config.stripMnemon !== false,
    config.anchorMode || "",
    config.subagentControl !== false,
    decision && decision.mode,
    decision && decision.taskKind,
    parts.redteam === true,
    parts.policy || "",
    parts.revision === undefined || parts.revision === null ? "" : String(parts.revision),
    parts.session || "",
  ].join(SIG_SEP);
}

/**
 * 按 assembly 对象缓存改写结果。WeakMap 随对象回收，不累积。
 * 非对象输入一律不缓存（原始值做 WeakMap 键会抛）。
 */
export function createLiveCache() {
  const store = new WeakMap();
  return {
    /** 命中且签名一致才返回缓存值；否则返回 undefined 让调用方重算。 */
    get(assembled, sig) {
      if (!assembled || typeof assembled !== "object") return undefined;
      const hit = store.get(assembled);
      return hit && hit.sig === sig ? hit.value : undefined;
    },
    /** 只缓存对象结果，避免把 null 当成「已改写」。 */
    set(assembled, sig, value) {
      if (!assembled || typeof assembled !== "object") return;
      if (!value || typeof value !== "object") return;
      store.set(assembled, { sig, value });
    },
  };
}
