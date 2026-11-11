// lib/http.js 的守卫测试——插件挂在 127.0.0.1 上的十几条路由全靠这几个函数把关。
//
// 为什么值得单独测：这些路由能改宿主的补丁状态、能写用户的配置文件、能触发重启。
// 监听地址是回环不等于安全——同机任何一个网页、任何一个 Electron 窗口里的
// 第三方 iframe，都能向 127.0.0.1:43120 发请求。唯一的防线就是这里的 Origin 判定，
// 而它原来埋在 lib/index.js 里，不起宿主就跑不到，改错了没有任何红字。
//
// 测试用假 request/response：request 只需要 headers 与 method，response 只需要
// writeHead/end。这样每条分支都能单独钉住，不用起 HTTP 服务。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allowPluginRequest,
  headerOf,
  methodNotAllowed,
  readJsonBody,
  sendJson,
  sendOptions,
} from '../lib/http.js'

function fakeResponse() {
  const res = { status: 0, headers: null, body: '', ended: false }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers || {}
  }
  res.end = (chunk) => {
    res.ended = true
    if (chunk !== undefined) res.body = String(chunk)
  }
  return res
}

const req = (headers, method = 'GET') => ({ headers, method })

// 合法的同源请求：桌面端设置页自己发的那种
const SAME_ORIGIN = { origin: 'http://127.0.0.1:43120', host: '127.0.0.1:43120' }

// ------------------------------------------------------------ 跨站准入

test('没有 Origin 也没有 Sec-Fetch-Site 时放行（curl / 脚本 / 宿主自身）', () => {
  // 浏览器一定会带 Origin，所以「没有」这个头意味着不是网页发起的。
  // 这条不能收紧，否则宿主内部调用与命令行工具全部 403。
  const res = fakeResponse()
  assert.equal(allowPluginRequest(req({}), res), true)
  assert.equal(res.ended, false, '放行时不该写任何响应')
})

test('Sec-Fetch-Site: cross-site 直接拒，且不看 Origin', () => {
  const res = fakeResponse()
  assert.equal(allowPluginRequest(req({ 'sec-fetch-site': 'cross-site', ...SAME_ORIGIN }), res), false)
  assert.equal(res.status, 403)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'cross-origin blocked' })
})

test('Sec-Fetch-Site 大小写不敏感', () => {
  const res = fakeResponse()
  assert.equal(allowPluginRequest(req({ 'sec-fetch-site': 'Cross-Site' }), res), false)
})

test('Sec-Fetch-Site: same-origin / none / same-site 放行', () => {
  for (const site of ['same-origin', 'none', 'same-site']) {
    const res = fakeResponse()
    assert.equal(allowPluginRequest(req({ 'sec-fetch-site': site, ...SAME_ORIGIN }), res), true, site)
  }
})

test('Origin: null 拒绝（sandbox iframe / file:// 页面）', () => {
  const res = fakeResponse()
  assert.equal(allowPluginRequest(req({ origin: 'null', host: '127.0.0.1:43120' }), res), false)
  assert.equal(res.status, 403)
})

test('Origin 与 Host 完全同源时放行', () => {
  const res = fakeResponse()
  assert.equal(allowPluginRequest(req(SAME_ORIGIN), res), true)
  assert.equal(res.ended, false)
})

test('Origin 端口与 Host 不同时拒绝（同机另一个端口的页面）', () => {
  const res = fakeResponse()
  assert.equal(
    allowPluginRequest(req({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:43120' }), res),
    false,
  )
})

test('Origin 主机名与 Host 不同时拒绝（DNS rebinding 的特征）', () => {
  // 攻击者把自己的域名解析到 127.0.0.1，浏览器视角下是同源请求，
  // 但 Origin 里写的是 evil.test，与 Host 头对不上。
  const res = fakeResponse()
  assert.equal(
    allowPluginRequest(req({ origin: 'http://evil.test:43120', host: '127.0.0.1:43120' }), res),
    false,
  )
})

test('Origin 不是合法 URL 时拒绝', () => {
  const res = fakeResponse()
  assert.equal(allowPluginRequest(req({ origin: 'not a url', host: '127.0.0.1:43120' }), res), false)
})

test('有 Origin 但缺 Host 头时拒绝', () => {
  const res = fakeResponse()
  assert.equal(allowPluginRequest(req({ origin: 'http://127.0.0.1:43120' }), res), false)
})

test('主机名比较不区分大小写', () => {
  const res = fakeResponse()
  assert.equal(
    allowPluginRequest(req({ origin: 'http://LocalHost:43120', host: 'localhost:43120' }), res),
    true,
  )
})

test('Origin 前后空白被裁掉再比较', () => {
  const res = fakeResponse()
  assert.equal(
    allowPluginRequest(req({ origin: '  http://127.0.0.1:43120  ', host: '127.0.0.1:43120' }), res),
    true,
  )
})

test('拒绝响应一定是 403 + no-store + 统一 JSON，不泄漏路由信息', () => {
  const res = fakeResponse()
  allowPluginRequest(req({ origin: 'http://evil.test', host: '127.0.0.1:43120' }), res)
  assert.equal(res.status, 403)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.body, '{"ok":false,"error":"cross-origin blocked"}')
})

// ------------------------------------------------------------ headerOf

test('headerOf：数组头取第一个（Node 对重复头给数组）', () => {
  assert.equal(headerOf(req({ origin: ['http://a.test', 'http://b.test'] }), 'origin'), 'http://a.test')
})

test('headerOf：缺失 / 空值 / 没有 headers 对象都返回空串', () => {
  assert.equal(headerOf(req({}), 'origin'), '')
  assert.equal(headerOf(req({ origin: null }), 'origin'), '')
  assert.equal(headerOf({}, 'origin'), '')
  assert.equal(headerOf(undefined, 'origin'), '')
})

test('headerOf：数组第一个是空串时返回空串而不是下一项', () => {
  // 现状锁定：只取首项，首项为空就是空。
  // 语义上「第一个 origin 是空的」本身就不该被信任，保持现状即可。
  assert.equal(headerOf(req({ origin: ['', 'http://b.test'] }), 'origin'), '')
})

test('headerOf：数字等非字符串头被 String 化', () => {
  assert.equal(headerOf(req({ 'content-length': 42 }), 'content-length'), '42')
})

// ------------------------------------------------------------ 方法校验

test('methodNotAllowed：方法不在白名单时回 405 并带 Allow 头', () => {
  const res = fakeResponse()
  assert.equal(methodNotAllowed(req({}, 'DELETE'), res, ['GET', 'POST']), true)
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, POST')
})

test('methodNotAllowed：方法在白名单时返回 false 且不写响应', () => {
  for (const method of ['GET', 'POST']) {
    const res = fakeResponse()
    assert.equal(methodNotAllowed(req({}, method), res, ['GET', 'POST']), false, method)
    assert.equal(res.ended, false)
  }
})

test('methodNotAllowed：单方法白名单的 Allow 头不带逗号', () => {
  const res = fakeResponse()
  methodNotAllowed(req({}, 'POST'), res, ['GET'])
  assert.equal(res.headers.allow, 'GET')
})

test('methodNotAllowed：大小写敏感（HTTP 方法按规范是大写）', () => {
  // 现状锁定：白名单比对不做大小写归一。Node 的 http 模块会把方法名原样给出，
  // 小写 'get' 是非规范客户端行为，这里拒掉比放行安全。
  const res = fakeResponse()
  assert.equal(methodNotAllowed(req({}, 'get'), res, ['GET']), true)
})

// ------------------------------------------------------------ JSON 收发

test('sendJson：状态码、两个响应头与序列化后的 body', () => {
  const res = fakeResponse()
  sendJson(res, 200, { ok: true, n: 1 })
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.body, '{"ok":true,"n":1}')
})

test('sendJson：错误状态码走同一套头（不能因为 500 就漏掉 no-store）', () => {
  const res = fakeResponse()
  sendJson(res, 500, { ok: false, error: 'boom' })
  assert.equal(res.status, 500)
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('sendOptions：204 + no-store + 空 body', () => {
  const res = fakeResponse()
  sendOptions(res)
  assert.equal(res.status, 204)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.body, '')
})

// 把任意可迭代对象包成 request 的异步迭代器形态
function bodyRequest(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

test('readJsonBody：正常 JSON 解析成对象', async () => {
  const body = await readJsonBody(bodyRequest(['{"sessionId":', '"abc"}']))
  assert.deepEqual(body, { sessionId: 'abc' })
})

test('readJsonBody：空 body 返回空对象而不是抛错', async () => {
  assert.deepEqual(await readJsonBody(bodyRequest([])), {})
  assert.deepEqual(await readJsonBody(bodyRequest(['   '])), {})
})

test('readJsonBody：Buffer 与非 Buffer 分片都能拼', async () => {
  const body = await readJsonBody(bodyRequest([Buffer.from('{"a":'), '1}']))
  assert.deepEqual(body, { a: 1 })
})

test('readJsonBody：超过上限立刻抛错，错误信息固定', async () => {
  await assert.rejects(
    () => readJsonBody(bodyRequest(['x'.repeat(20)]), 10),
    /request body too large/,
  )
})

test('readJsonBody：非法 JSON 让 JSON.parse 的异常冒上去', async () => {
  await assert.rejects(() => readJsonBody(bodyRequest(['{oops'])), SyntaxError)
})

test('readJsonBody：上限非法时回落到 512KB，不是 0（否则任何请求都超限）', async () => {
  // 现状锁定：Number.isFinite(maxBytes) && maxBytes > 0 才算有效上限。
  // 传 0 / 负数 / NaN / 非数字都退回默认 512KB。
  for (const bad of [0, -1, NaN, '100']) {
    const body = await readJsonBody(bodyRequest(['{"a":1}']), bad)
    assert.deepEqual(body, { a: 1 }, String(bad))
  }
})

test('readJsonBody：刚好等于上限时不算超限', async () => {
  const payload = '{"a":1}'
  assert.deepEqual(await readJsonBody(bodyRequest([payload]), payload.length), { a: 1 })
})

test('readJsonBody：上限按累计字节算，不是按分片数', async () => {
  await assert.rejects(
    () => readJsonBody(bodyRequest(['12345', '67890']), 8),
    /request body too large/,
  )
})
