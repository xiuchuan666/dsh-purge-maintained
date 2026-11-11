// 演练台 HTTP 桥 `POST /redteam/api` 的准入与分发。
//
// 这条路由是演练台改数据的唯一入口。判错的两个方向都很贵：
//   · 放太松 → 任何网页都能 POST 进来改资产库（CSRF），因为浏览器访问本机服务时
//     remoteAddress 本来就是 127.0.0.1；
//   · 收太紧 → 自家面板被自己挡住，表现是「点了没反应」，控制台里连报错都没有。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRIDGE_CONTENT_TYPE, bridgeGate, dispatchBridge, isLocalHost, originVerdict } from '../lib/redteam/bridge.js'

const LOCAL = '127.0.0.1:43120'
const JSON_HEADERS = { host: LOCAL, origin: `http://${LOCAL}`, 'content-type': 'application/json' }

/* ------------------------------------------------------------ isLocalHost */

test('isLocalHost 只认 localhost / 127.0.0.1 / [::1]，带不带端口都算', () => {
  for (const host of ['localhost', 'localhost:43120', '127.0.0.1', '127.0.0.1:1', '[::1]', '[::1]:8080', 'LocalHost:3000']) {
    assert.equal(isLocalHost(host), true, host)
  }
  for (const host of ['', 'example.com', 'example.com:43120', '127.0.0.2', '10.0.0.1:80', 'localhost.evil.com', undefined, null, 42]) {
    assert.equal(isLocalHost(host), false, String(host))
  }
})

/* ------------------------------------------------------------ originVerdict */

test('originVerdict：浏览器自己标 cross-site / same-site 一律拒', () => {
  assert.equal(originVerdict({ host: LOCAL, site: 'cross-site', origin: `http://${LOCAL}` }), false)
  assert.equal(originVerdict({ host: LOCAL, site: 'same-site', origin: `http://${LOCAL}` }), false)
  assert.equal(originVerdict({ host: LOCAL, site: 'CROSS-SITE', origin: `http://${LOCAL}` }), false, '大小写不该绕过')
})

test('originVerdict：没有 Origin 视为非浏览器客户端，放行（curl / 脚本要能用）', () => {
  assert.equal(originVerdict({ host: LOCAL, site: 'same-origin' }), true)
  assert.equal(originVerdict({ host: LOCAL, site: 'none', origin: '' }), true)
  assert.equal(originVerdict({}), true, '连 Host 都没有时也不该在这一层崩')
})

test('originVerdict：Origin 与 Host 一致才放行，端口不同也算跨源', () => {
  assert.equal(originVerdict({ host: LOCAL, origin: `http://${LOCAL}` }), true)
  assert.equal(originVerdict({ host: LOCAL, origin: 'http://127.0.0.1:5000' }), false, '端口不同 = 另一个源')
  assert.equal(originVerdict({ host: LOCAL, origin: 'https://127.0.0.1:43120' }), true, 'scheme 不参与比较（原实现如此）')
  assert.equal(originVerdict({ host: LOCAL, origin: 'http://evil.example' }), false)
})

test('originVerdict：Origin: null 只在 Host 是本机、且不是浏览器标注的跨站时放行', () => {
  assert.equal(originVerdict({ host: LOCAL, site: 'none', origin: 'null' }), true)
  assert.equal(originVerdict({ host: LOCAL, site: '', origin: 'null' }), true)
  assert.equal(originVerdict({ host: LOCAL, site: 'same-origin', origin: 'null' }), false, '浏览器标了 same-origin 却给 null，说明是 sandbox iframe')
  assert.equal(originVerdict({ host: 'example.com:443', site: 'none', origin: 'null' }), false, 'Host 不是本机时 null 不放行')
})

test('originVerdict：桌面端 app:// Origin 只在本机 Host 下放行', () => {
  assert.equal(originVerdict({ host: LOCAL, origin: 'app://dsh' }), true)
  assert.equal(originVerdict({ host: LOCAL, origin: 'APP://DSH' }), true, '大小写不敏感')
  assert.equal(originVerdict({ host: 'example.com', origin: 'app://dsh' }), false)
})

test('originVerdict：Origin 不是合法 URL 时拒（不是抛）', () => {
  assert.equal(originVerdict({ host: LOCAL, origin: 'not a url' }), false)
  assert.equal(originVerdict({ host: LOCAL, origin: '://' }), false)
})

/* ------------------------------------------------------------ bridgeGate */

test('bridgeGate：非 POST 先被挡，回 405 POST only', () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    assert.deepEqual(bridgeGate({ method, headers: JSON_HEADERS }), { status: 405, error: 'POST only' }, method)
  }
})

test('bridgeGate：跨源 POST 回 403，且先于 Content-Type 判定', () => {
  const cross = bridgeGate({ method: 'POST', headers: { host: LOCAL, origin: 'http://evil.example', 'content-type': 'text/plain' } })
  assert.deepEqual(cross, { status: 403, error: 'cross-origin request rejected' }, '来源比类型更该先判，否则攻击者能靠类型错误探出路由存在')
})

test('bridgeGate：同源但 Content-Type 不是 JSON 回 415（挡跨站简单请求）', () => {
  for (const ctype of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', '', undefined]) {
    const gate = bridgeGate({ method: 'POST', headers: { host: LOCAL, origin: `http://${LOCAL}`, 'content-type': ctype } })
    assert.deepEqual(gate, { status: 415, error: 'content-type must be application/json' }, String(ctype))
  }
})

test('bridgeGate：Content-Type 带 charset 或大写仍算 JSON', () => {
  for (const ctype of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON', 'application/json;charset=UTF-8']) {
    assert.equal(bridgeGate({ method: 'POST', headers: { ...JSON_HEADERS, 'content-type': ctype } }), null, ctype)
  }
})

test('bridgeGate：三道闸全过才放行（返回 null）', () => {
  assert.equal(bridgeGate({ method: 'POST', headers: JSON_HEADERS }), null)
  assert.equal(bridgeGate({ method: 'POST', headers: { host: LOCAL, 'content-type': 'application/json' } }), null, '无 Origin 的脚本也放行')
})

test('bridgeGate：headers 缺失时不抛，按跨源拒', () => {
  assert.deepEqual(bridgeGate({ method: 'POST' }), { status: 415, error: 'content-type must be application/json' })
  assert.deepEqual(bridgeGate({}), { status: 405, error: 'POST only' })
})

/* ------------------------------------------------------------ dispatchBridge */

// 每层都记一笔调用，这样「认领后短路」的断言才有意义：只断言返回值的话，
// 上层认领了但下层也被跑过，测试照样绿。
function fakeDeps(overrides = {}) {
  const calls = []
  // 不能包成 async：真实 handlePlatformOp 是同步的，包成 async 后它永远返回
  // Promise（永不为 undefined），dispatchBridge 会误判「平台层认领了」而短路。
  const layer = (name, fallback) => (...args) => {
    calls.push(name)
    return (overrides[name] || fallback)(...args)
  }
  return {
    calls,
    store: { name: 'store' },
    ctx: { name: 'ctx' },
    handlePlatformOp: layer('handlePlatformOp', () => undefined),
    handleAgentsOp: layer('handleAgentsOp', () => undefined),
    handleUpdateOp: layer('handleUpdateOp', () => undefined),
    handleSkillOp: layer('handleSkillOp', () => undefined),
    handleSkillOpFromPluginDir: layer('handleSkillOpFromPluginDir', () => undefined),
    dispatchAsync: layer('dispatchAsync', () => ({ ok: true, via: 'dispatch' })),
  }
}

test('dispatchBridge：平台层认领就短路，后面几层都不该被调用', async () => {
  const deps = fakeDeps({ handlePlatformOp: () => ({ ok: true, via: 'platform' }) })
  assert.deepEqual(await dispatchBridge(deps, { op: 'platformInfo' }), { ok: true, via: 'platform' })
  assert.deepEqual(deps.calls, ['handlePlatformOp'])
})

test('dispatchBridge：四层按 platform → agents → update → skill 顺序问，全部不认识才兜底', async () => {
  const deps = fakeDeps()
  assert.deepEqual(await dispatchBridge(deps, { op: 'assetsList' }), { ok: true, via: 'dispatch' })
  assert.deepEqual(deps.calls, ['handlePlatformOp', 'handleAgentsOp', 'handleUpdateOp', 'handleSkillOp', 'dispatchAsync'])
})

test('dispatchBridge：agents 认领时 update / skill / dispatch 都不跑', async () => {
  const deps = fakeDeps({ handleAgentsOp: () => ({ ok: true, via: 'agents' }) })
  assert.deepEqual(await dispatchBridge(deps, {}), { ok: true, via: 'agents' })
  assert.deepEqual(deps.calls, ['handlePlatformOp', 'handleAgentsOp'])
})

test('dispatchBridge：update 认领时技能层不跑', async () => {
  const deps = fakeDeps({ handleUpdateOp: () => ({ ok: true, via: 'update' }) })
  assert.deepEqual(await dispatchBridge(deps, {}), { ok: true, via: 'update' })
  assert.deepEqual(deps.calls, ['handlePlatformOp', 'handleAgentsOp', 'handleUpdateOp'])
})

test('dispatchBridge：技能层认领时不再兜底', async () => {
  const deps = fakeDeps({ handleSkillOp: () => ({ ok: true, via: 'skill' }) })
  assert.deepEqual(await dispatchBridge(deps, { op: 'skillList' }), { ok: true, via: 'skill' })
  assert.deepEqual(deps.calls, ['handlePlatformOp', 'handleAgentsOp', 'handleUpdateOp', 'handleSkillOp'])
})

test('dispatchBridge：技能层抛错时，skillCatalog / skillRead 退到读文件而不是 400', async () => {
  for (const op of ['skillCatalog', 'skillRead']) {
    const deps = fakeDeps({
      handleSkillOp: () => { throw new Error('ctx.inject 缺失') },
      handleSkillOpFromPluginDir: (request) => ({ ok: true, via: 'dir', op: request.op }),
    })
    assert.deepEqual(await dispatchBridge(deps, { op }), { ok: true, via: 'dir', op }, op)
    assert.ok(deps.calls.includes('handleSkillOpFromPluginDir'))
    assert.ok(!deps.calls.includes('dispatchAsync'), '兜底层不该再跑')
  }
})

test('dispatchBridge：文件兜底也失败时回带原始错误的 ok:false（不是 400）', async () => {
  const deps = fakeDeps({
    handleSkillOp: () => { throw new Error('ctx.inject 缺失') },
    handleSkillOpFromPluginDir: () => ({ ok: false, error: '目录不存在' }),
  })
  const result = await dispatchBridge(deps, { op: 'skillRead' })
  assert.equal(result.ok, false)
  assert.match(result.error, /技能读取失败/)
  assert.match(result.error, /ctx\.inject 缺失/, '要带上真实原因，否则用户只看到「读取失败」无从排查')
})

test('dispatchBridge：技能层抛错且 op 不是技能类时原样抛出（让上层回 400）', async () => {
  const deps = fakeDeps({
    handleSkillOp: () => { throw new Error('真炸了') },
  })
  await assert.rejects(() => dispatchBridge(deps, { op: 'assetsList' }), /真炸了/)
  assert.ok(!deps.calls.includes('handleSkillOpFromPluginDir'), '不该对非技能 op 走文件兜底')
})

test('dispatchBridge：request 为 null 时技能兜底不崩，仍把原错误抛上去', async () => {
  const deps = fakeDeps({
    handleSkillOp: () => { throw new Error('boom') },
  })
  await assert.rejects(() => dispatchBridge(deps, null), /boom/)
})

test('BRIDGE_CONTENT_TYPE 是 application/json（改这个值等于放宽跨站闸门）', () => {
  assert.equal(BRIDGE_CONTENT_TYPE, 'application/json')
})
