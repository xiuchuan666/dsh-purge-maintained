// 演练台 HTTP 桥 `POST /redteam/api` 的准入与分发。
//
// 这条路由是演练台浏览器半侧改数据的唯一入口，判错了的后果是「任何网页都能
// POST 进来改资产库」（CSRF），或者反过来「自家面板自己被挡」（点了没反应）。
// 原来整段写死在 lib/redteam/ui.js 的 apply() 里，只能靠开浏览器点。
//
// 这里把三件事拆成可测的纯函数：
//   · originVerdict —— Origin / Sec-Fetch-Site / Host 三元判定
//   · bridgeGate —— 方法白名单 + 来源 + Content-Type 三道闸
//   · dispatchBridge —— op 路由顺序（平台 → 代理 → 更新 → 技能 → 兜底）
// 副作用（读写响应、解析 body）仍留在 ui.js，它负责把 request/response 传进来。

/** 只接受 JSON：跨站「简单请求」（text/plain 表单）过不了这一关。 */
export const BRIDGE_CONTENT_TYPE = "application/json";

/** Host 是不是本机（含端口）。桌面端 Origin 是 app:// 或 null，只有此时才放行。 */
export function isLocalHost(host) {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(typeof host === "string" ? host : "");
}

/**
 * 来源判定。**不能**因为 remoteAddress 是回环就放行 —— 浏览器访问本机服务时它
 * 本来就是 127.0.0.1，等于任何网页都能 POST 进来改数据。
 */
export function originVerdict({ host = "", site = "", origin } = {}) {
  const siteLower = String(site || "").toLowerCase();
  const hostLocal = isLocalHost(host);
  // 浏览器自己标的跨站请求直接拒（也覆盖 sandbox iframe 的 Origin: null）。
  if (siteLower === "cross-site" || siteLower === "same-site") return false;
  // 非浏览器客户端（curl / 脚本）没有 Origin。
  if (origin === undefined || origin === "") return true;
  if (origin === "null") return hostLocal && (siteLower === "" || siteLower === "none");
  if (/^app:/i.test(String(origin))) return hostLocal;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 三道闸，按顺序短路。返回 null 表示放行，否则返回要写回的 `{status, error}`。
 * 顺序有意义：先判方法（省掉后续所有工作），再判来源（安全），最后判类型
 * （这条最便宜但只对「已经同源」的请求才有意义）。
 */
export function bridgeGate({ method = "GET", headers = {} } = {}) {
  if (method !== "POST") return { status: 405, error: "POST only" };
  const host = typeof headers.host === "string" ? headers.host : "";
  const site = headers["sec-fetch-site"] || "";
  const origin = headers.origin;
  if (!originVerdict({ host, site, origin })) {
    return { status: 403, error: "cross-origin request rejected" };
  }
  const ctype = String(headers["content-type"] || "").toLowerCase();
  if (!ctype.includes(BRIDGE_CONTENT_TYPE)) {
    return { status: 415, error: "content-type must be application/json" };
  }
  return null;
}

/**
 * op 路由。返回 `undefined` 表示「这一层不认识」，继续往下走；返回别的值就是
 * 最终响应体。顺序与拆分前一致：平台 → 代理 → 更新 → 技能（含文件兜底）→ 兜底。
 *
 * 技能层特殊：`handleSkillOp` 在桌面端可能因为 `ctx.inject` 缺失抛错，此时
 * **不能**回 400，要退到 `handleSkillOpFromPluginDir` 直接读文件；只有它也不
 * 认这个 op 时才把原始错误抛上去。
 */
export async function dispatchBridge(deps, request) {
  const platformResult = deps.handlePlatformOp(deps.store, request);
  if (platformResult !== undefined) return platformResult;

  const agentsResult = await deps.handleAgentsOp(deps.ctx, request);
  if (agentsResult !== undefined) return agentsResult;

  const updateResult = await deps.handleUpdateOp(deps.ctx, request);
  if (updateResult !== undefined) return updateResult;

  let skillResult;
  try {
    skillResult = await deps.handleSkillOp(deps.ctx, request);
  } catch (skillErr) {
    if (request && (request.op === "skillCatalog" || request.op === "skillRead")) {
      skillResult = deps.handleSkillOpFromPluginDir(request);
      if (!skillResult || skillResult.ok === false) {
        skillResult = {
          ok: false,
          error: "技能读取失败： " + (skillErr && skillErr.message ? skillErr.message : String(skillErr)),
        };
      }
    } else {
      throw skillErr;
    }
  }
  if (skillResult !== undefined) return skillResult;
  return deps.dispatchAsync(deps.store, request);
}
