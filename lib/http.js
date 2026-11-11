// HTTP 路由的公共零件：请求头读取、跨站拒绝、方法校验、JSON 收发。
//
// 这些函数原来散在 lib/index.js 里，被 installWebServer 的十几条路由共用，
// 却没有任何测试能直接调用它们——要验证「跨站请求会不会被挡」得先把整个宿主跑起来。
// 抽出来是为了让守卫本身可测：allowPluginRequest 的每一条分支都对应一种真实的攻击面。
//
// 行为与抽取前逐字一致，唯一的差别是现在可以从外部 import。

/** 读一个请求头：大小写不敏感，数组取第一个，缺失返回空串。 */
export function headerOf(request, name) {
  const headers = request?.headers;
  if (!headers) return "";
  const value = headers[name] ?? headers[String(name).toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

/** 统一的跨站拒绝响应：403 + no-store，不泄漏任何路由内部信息。 */
export function denyCrossOrigin(response) {
  response.writeHead(403, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ ok: false, error: "cross-origin blocked" }));
}

/**
 * 本地 HTTP 路由的准入判定。
 *
 * 桌面端把插件路由挂在 127.0.0.1 的 webServer 上，同机任何网页都能向这个端口发请求，
 * 所以必须靠 Origin 判断来源，不能只靠监听地址。
 *   - sec-fetch-site: cross-site → 直接拒（现代浏览器一定会带）
 *   - Origin: null → 拒（sandbox iframe / file:// 页面）
 *   - 没有 Origin → 放行（curl、脚本、宿主自身；浏览器不会省略这个头）
 *   - Origin 解析失败 → 拒
 *   - Origin 的 host 与 Host 头不一致 → 拒（DNS rebinding 的典型特征）
 */
export function allowPluginRequest(request, response) {
  const site = headerOf(request, "sec-fetch-site").toLowerCase();
  if (site === "cross-site") {
    denyCrossOrigin(response);
    return false;
  }
  const origin = headerOf(request, "origin").trim();
  if (origin === "null") {
    denyCrossOrigin(response);
    return false;
  }
  if (!origin) return true;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    denyCrossOrigin(response);
    return false;
  }
  const host = headerOf(request, "host").trim();
  if (!host || originHost.toLowerCase() !== host.toLowerCase()) {
    denyCrossOrigin(response);
    return false;
  }
  return true;
}

/** 方法不在白名单里就回 405 + Allow 头，返回 true 表示已经处理完、调用方应直接 return。 */
export function methodNotAllowed(request, response, allow) {
  if (allow.includes(request.method)) return false;
  response.writeHead(405, { allow: allow.join(", ") });
  response.end();
  return true;
}

/** 统一的 JSON 响应：所有路由共用同一组头，避免某条路由漏掉 no-store。 */
export function sendJson(response, status, payload) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

/** OPTIONS 预检的 204。 */
export function sendOptions(response) {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

/**
 * 读 JSON 请求体：流式累加，超过上限立刻抛错（不把超大 body 读进内存）。
 * 空 body 当作 {}，非法 JSON 让 JSON.parse 的异常冒上去由路由回 500。
 */
export async function readJsonBody(request, maxBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 512 * 1024;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}
