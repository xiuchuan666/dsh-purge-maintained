// 演练台统一分发（dispatch / dispatchAsync）的路由回归。
//
// 为什么单独测这一个函数：CLI、HTTP 桥、智能体工具三条入口全部汇到
// `store-core.js` 的 `dispatch(store, req)`。它自己几乎不含业务逻辑，
// 只做两件事——把 op 映射到某个 store 方法，把异常收成 `{ ok:false, error }`。
// 正因为它"只是转发"，坏了不会有任何症状：某个 op 少传一个参数、
// 别名从 `req.id` 改成 `req.code`、写操作漏了靶标闸门，界面只是"数据不对"。
//
// 所以这里用两套证据：
//   1) 记录型假 store：证明"哪个 op 调了哪个方法、参数是不是原对象"；
//   2) 真 store + 临时目录：证明"这条路真的能走通，落库了、能读回来"。
// 假 store 只用来钉接线，真 store 用来钉行为，两者不可互相替代。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore, dispatch, dispatchAsync } from '../lib/redteam/store-core.js'

/** 开一个用完即弃的真 store；`fn` 里抛错也要把目录收干净。 */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purge-dispatch-'))
  const store = new RedteamStore(dir)
  try {
    return fn(store, dir)
  } finally {
    try { store.close() } catch { /* 关过就算了 */ }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch { /* Windows 句柄未释放 */ }
  }
}

/** 建一个靶标 + 一台资产，返回常用 id。 */
function seed(store, name = 'dispatch') {
  const { id } = store.openEngagement(name, ['10.9.0.0/24'])
  const db = store.db(id)
  db.prepare('INSERT INTO asset(ip, segment_cidr, state, primary_name) VALUES(?,?,?,?)')
    .run('10.9.0.5', '10.9.0.0/24', 'live', 'gw-01')
  const assetId = db.prepare('SELECT id FROM asset ORDER BY id DESC LIMIT 1').get().id
  return { id, assetId, db }
}

/** 手工 PNG：pngSize 只读偏移 16..24，不校验 CRC，所以宽高可以随便写。 */
function pngBytes(width, height) {
  const buf = Buffer.alloc(32)  /* 必须 >24：pngSize 的长度门槛 */
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'latin1')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

/* 1x1 透明 PNG（真图，用来验证 base64 往返）。 */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * 记录型假 store：每个方法只记一行调用并按名字回一个标记对象。
 *
 * 方法表是**显式**的：dispatch 一旦开始调一个没登记的方法，测试会立刻
 * TypeError，而不是被一个万能 Proxy 悄悄接住——那才是"看着绿、其实是空转"。
 */
const RECORDED_METHODS = [
  'listEngagements', 'openEngagement', 'setActiveEngagement',
  'searchPocs', 'pocStats', 'knowledgePath', 'nucleiTemplatesDir', 'templateStats', 'searchTemplates',
  'getPoc', 'savePoc', 'updatePoc', 'deletePoc', 'markPocUsed',
  'snapshot', 'listAssets', 'getAsset', 'graph', 'attackGraph', 'stats', 'vulnStats', 'listVulns',
  'addVuln', 'updateVuln', 'listCredentials', 'addCredential', 'listAccess', 'addAccess',
  'sessionSummary', 'listWebshells', 'addWebshell', 'updateWebshell', 'listTunnels', 'listShots',
  'addShot', 'deleteShot', 'readShot', 'addTunnel', 'updateTunnel', 'domainIndex', 'listWeb',
  'listHttpEvidence', 'addHttpEvidence', 'listChain', 'addChainStep', 'report', 'updateAssetTest',
  'assessAsset', 'listScorePoints', 'saveScorePoint', 'deleteScorePoint', 'addScoreHit',
  'scoreChain', 'scoreReport', 'activeTests', 'testStats', 'consoleDigest', 'listStages', 'saveStage',
  'reportTargets', 'discoveryTimeline', 'attackFileTree', 'addAttackFile', 'readAttackFile',
  'importBundle', 'listPrompts', 'savePrompt', 'resetPrompts',
]

function recorder({ active = 'eng-1', methods = RECORDED_METHODS } = {}) {
  const calls = []
  const store = { root: '/recorder', calls }
  for (const name of methods) {
    store[name] = (...args) => {
      calls.push([name, args])
      return { mark: name }
    }
  }
  store.listEngagements = () => {
    calls.push(['listEngagements', []])
    return [{ id: active }, { id: 'older' }]
  }
  store.activeEngagementId = () => {
    calls.push(['activeEngagementId', []])
    return active
  }
  return store
}

/** 路由表的断言帮手：只跑这一条 op，然后逐条比对调用记录。 */
function expectCalls(store, req, expected) {
  store.calls.length = 0
  const result = dispatch(store, req)
  assert.equal(result.ok, true, `${req.op} 应成功：${JSON.stringify(result)}`)
  const actual = store.calls.filter(([name]) => name !== 'activeEngagementId')
  const names = expected.map(([name]) => name)
  assert.deepEqual(actual.map(([name]) => name), names, `${req.op} 调用的方法顺序不对`)
  expected.forEach(([name, argsOf], index) => {
    const got = actual[index][1]
    const want = argsOf(req, 'eng-1')
    assert.equal(got.length, want.length, `${req.op} → ${name} 参数个数：${JSON.stringify(got)}`)
    want.forEach((value, i) => {
      assert.equal(got[i], value, `${req.op} → ${name} 第 ${i + 1} 个参数应是同一个对象`)
    })
  })
  return result
}

/* ------------------------------------------------------------ 信封与错误 */

test('dispatch：空 op 与未知 op 都回 ok:false，不抛异常', () => {
  const store = recorder()
  assert.deepEqual(dispatch(store, {}), { ok: false, error: '缺少 op' })
  assert.deepEqual(dispatch(store, { op: '   ' }), { ok: false, error: '缺少 op' })
  assert.deepEqual(dispatch(store, { op: '  snapshot  ', engagement: 'eng-1' }).ok, true, '两端空白要 trim 掉')
  assert.deepEqual(dispatch(store, { op: 'nope' }), { ok: false, error: '未知操作: nope' })
  /* op 不是字符串（面板偶尔会传数字进来）也当缺失处理。 */
  assert.deepEqual(dispatch(store, { op: 42 }), { ok: false, error: '缺少 op' })
})

test('dispatch：store 抛 Error / 抛字符串 / 缺方法，全都收进 error 而不是冒泡', () => {
  const boom = (message) => () => { throw new Error(message) }
  assert.deepEqual(dispatch({ root: '/r', listAssets: boom('读盘炸了') }, { op: 'assets', engagement: 'e' }),
    { ok: false, error: '读盘炸了' })

  const throwsText = () => { throw 'plain text' }
  assert.deepEqual(dispatch({ root: '/r', listAssets: throwsText }, { op: 'assets', engagement: 'e' }),
    { ok: false, error: 'plain text' }, '非 Error 也要能转成字符串')

  /* 缺方法：TypeError 的 message 会被原样带出来——比"failed"有用得多。 */
  const missing = dispatch({ root: '/r' }, { op: 'stats', engagement: 'e' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /stats is not a function/)
})

/* ------------------------------------------------------------ 无靶标分支 */

test('dispatch：没有靶标时写操作拒绝、读操作回同一个空信封', () => {
  withStore((store) => {
    for (const op of ['addVuln', 'saveStage', 'updateVuln', 'deleteScorePoint', 'import', 'assessAsset', 'savePrompt']) {
      const result = dispatch(store, { op })
      assert.deepEqual(result, { ok: false, error: '请先在顶部选择或创建一个靶标' }, `${op} 应在写操作闸门被挡住`)
    }
    /* 读操作一律回同一个信封：前端只要判 truthy 就能渲染空白页，不会看到 undefined。
       注意 stats / sessions 也没有自己的形状——空靶标下它们是同一个信封，
       这是刻意的：没选靶标时页面不该出现 "assets 0 台、隧道 undefined 条" 这种半截数字。 */
    const empty = { ok: true, items: [], total: 0, stats: null, segments: [], stages: [], roles: [] }
    for (const op of ['assets', 'stats', 'sessions', 'chain', 'vulns', 'scores', 'stages', 'tunnels', 'shots']) {
      assert.deepEqual(dispatch(store, { op }), empty, `${op} 应回空信封`)
    }
  })
})

test('dispatch：没有靶标时 prompts 回内置六角色（不是空信封）', () => {
  withStore((store) => {
    const result = dispatch(store, { op: 'prompts' })
    assert.equal(result.ok, true)
    assert.equal(result.builtin, true, '内置稿必须标 builtin，前端据此提示"还没保存过"')
    assert.deepEqual(result.roles.map((r) => r.role), ['plan', 'recon', 'assess', 'vuln-scan', 'exploit', 'internal'])
    for (const role of result.roles) {
      assert.deepEqual(Object.keys(role), ['role', 'title', 'planner', 'dispatcher', 'content', 'updated_at'])
      assert.equal(role.updated_at, null, '内置稿没有落库时间')
      assert.equal(role.planner, role.role === 'plan', 'plan 是唯一的主会话角色')
      assert.equal(role.dispatcher, role.role !== 'plan')
      assert.ok(role.content.length > 100, `${role.role} 的内置稿不该是空串`)
    }
  })
})

/* ------------------------------------------------------------ 靶标开关 */

test('dispatch：bootstrap 先看当前指针，再看最近靶标，都没有才是 null', () => {
  assert.deepEqual(dispatch(recorder(), { op: 'bootstrap' }), {
    ok: true, root: '/recorder', engagements: [{ id: 'eng-1' }, { id: 'older' }], current: 'eng-1',
  })
  /* 请求里点名就优先它，但指针仍然会被读一次（前端要拿列表）。 */
  const named = dispatch(recorder({ active: 'eng-1' }), { op: 'bootstrap', engagement: 'older' })
  assert.equal(named.current, 'older')

  /* 指针为 null、也没有靶标：current 必须是 null 而不是空串。 */
  const blank = { root: '/r', listEngagements: () => [], activeEngagementId: () => null }
  assert.deepEqual(dispatch(blank, { op: 'bootstrap' }), { ok: true, root: '/r', engagements: [], current: null })

  /* store 上根本没有 activeEngagementId 这个函数（老宿主/极简替身）也不许抛。 */
  const minimal = { root: '/r', listEngagements: () => [{ id: 'only' }] }
  assert.equal(dispatch(minimal, { op: 'bootstrap' }).current, 'only', '没有指针方法就退到列表第一个')
})

test('dispatch：openEngagement 建靶标，activateEngagement 回 ok:false 而不是抛', () => {
  withStore((store) => {
    const opened = dispatch(store, { op: 'openEngagement', name: 'my eng', scope: ['10.0.0.0/24'] })
    assert.equal(opened.ok, true)
    assert.equal(opened.engagement.id, 'my-eng', 'id 由名字 slug 出来，空格变连字符')
    assert.deepEqual(opened.engagement.scope, ['10.0.0.0/24'])

    const activated = dispatch(store, { op: 'activateEngagement', engagement: 'my-eng' })
    assert.deepEqual(activated, { ok: true, current: 'my-eng' })

    /* 指到不存在的靶标：store 返回 false，dispatch 原样转成 ok:false 且 current 不动。 */
    const bad = dispatch(store, { op: 'activateEngagement', engagement: 'no-such' })
    assert.equal(bad.ok, false)
    assert.equal(bad.current, 'my-eng', '失败的激活不该把指针清掉')
  })
})

/* ------------------------------------------------------------ 路由表（假 store） */

test('dispatch：靶标内的读操作把整个 req 原样交给 store', () => {
  const LIST_OPS = [
    ['assets', 'listAssets'], ['graph', 'graph'], ['attackGraph', 'attackGraph'],
    ['vulns', 'listVulns'], ['credentials', 'listCredentials'], ['access', 'listAccess'],
    ['webshells', 'listWebshells'], ['tunnels', 'listTunnels'], ['shots', 'listShots'],
    ['domains', 'domainIndex'], ['web', 'listWeb'], ['httpEvidence', 'listHttpEvidence'],
    ['scores', 'listScorePoints'], ['activeTests', 'activeTests'],
    ['reportTargets', 'reportTargets'], ['discoveryTimeline', 'discoveryTimeline'],
    ['scoreChain', 'scoreChain'], ['scoreReport', 'scoreReport'],
  ]
  for (const [op, method] of LIST_OPS) {
    const store = recorder()
    const req = { op, engagement: 'eng-1', filter: 'x' }
    /* vulns 是唯一一个把统计和列表拼进同一个信封的 op，两个方法都得调到。 */
    const calls = op === 'vulns'
      ? [['vulnStats', (r, id) => [id]], ['listVulns', (r, id) => [id, r]]]
      : [[method, (r, id) => [id, r]]]
    expectCalls(store, req, calls)
  }
})

test('dispatch：只认一个 id 的读操作不带 req（多传就是把筛选条件漏进 SQL）', () => {
  const ID_ONLY = [
    ['snapshot', 'snapshot'], ['stats', 'stats'], ['vulnStats', 'vulnStats'],
    ['sessions', 'sessionSummary'], ['chain', 'listChain'], ['report', 'report'],
    ['testStats', 'testStats'], ['consoleDigest', 'consoleDigest'], ['stages', 'listStages'],
    ['attackFiles', 'attackFileTree'], ['prompts', 'listPrompts'],
  ]
  for (const [op, method] of ID_ONLY) {
    const store = recorder()
    expectCalls(store, { op, engagement: 'eng-1' }, [[method, (r, id) => [id]]])
  }
})

test('dispatch：写操作认 req 里的别名对象，不把整个信封塞给 store', () => {
  const ALIASED = [
    ['addVuln', 'addVuln', 'vuln'], ['addCredential', 'addCredential', 'credential'],
    ['addAccess', 'addAccess', 'access'], ['addWebshell', 'addWebshell', 'webshell'],
    ['addTunnel', 'addTunnel', 'tunnel'], ['addHttpEvidence', 'addHttpEvidence', 'evidence'],
    ['addChainStep', 'addChainStep', 'step'], ['assetTest', 'updateAssetTest', 'test'],
    ['assessAsset', 'assessAsset', 'assess'], ['saveScorePoint', 'saveScorePoint', 'point'],
    ['addScoreHit', 'addScoreHit', 'hit'], ['saveStage', 'saveStage', 'stage'],
    ['addAttackFile', 'addAttackFile', 'file'], ['shotAdd', 'addShot', 'shot'],
  ]
  for (const [op, method, key] of ALIASED) {
    const store = recorder()
    const payload = { [`${key}Payload`]: true }
    const req = { op, engagement: 'eng-1', [key]: payload }
    expectCalls(store, req, [[method, (r, id) => [id, r[key]]]])
  }
})

test('dispatch：别名缺省时退回整个 req（命令行只传扁平参数）', () => {
  for (const [op, method, key] of [
    ['addVuln', 'addVuln', 'vuln'], ['saveStage', 'saveStage', 'stage'],
    ['addScoreHit', 'addScoreHit', 'hit'], ['addAttackFile', 'addAttackFile', 'file'],
  ]) {
    const store = recorder()
    const req = { op, engagement: 'eng-1', title: 'flat' }
    assert.equal(req[key], undefined)
    expectCalls(store, req, [[method, (r, id) => [id, r]]])
  }
})

test('dispatch：update 三兄弟都传 (id, patch||req)', () => {
  for (const [op, method] of [['updateVuln', 'updateVuln'], ['updateWebshell', 'updateWebshell'], ['updateTunnel', 'updateTunnel']]) {
    const store = recorder()
    const patch = { status: 'active' }
    expectCalls(store, { op, engagement: 'eng-1', id: 7, patch }, [[method, (r, id) => [id, r.id, r.patch]]])

    const flat = recorder()
    expectCalls(flat, { op, engagement: 'eng-1', id: 7, status: 'active' }, [[method, (r, id) => [id, r.id, r]]])
  }
})

test('dispatch：id 优先于 code，id 为 0 也算给了 id', () => {
  /* 知识库四个 op 都是 `req.id !== undefined ? req.id : req.code`。
     注意判据是 `!== undefined`，所以 id=0 会赢过 code——数组下标那种场景。 */
  for (const [op, method] of [
    ['pocGet', 'getPoc'], ['pocDelete', 'deletePoc'],
  ]) {
    expectCalls(recorder(), { op, code: 'CVE-1' }, [[method, () => ['CVE-1']]])
    expectCalls(recorder(), { op, id: 0, code: 'CVE-1' }, [[method, () => [0]]])
    expectCalls(recorder(), { op, id: 3, code: 'CVE-1' }, [[method, () => [3]]])
  }
  /* pocUpdate 多一个补丁对象：没有 patch 包装时第二个参数就是 req 本身。 */
  expectCalls(recorder(), { op: 'pocUpdate', code: 'CVE-1' }, [['updatePoc', (r) => ['CVE-1', r]]])
  expectCalls(recorder(), { op: 'pocUpdate', id: 0, patch: { title: 'x' } }, [['updatePoc', (r) => [0, r.patch]]])
  /* pocUse 多一个 used_on。 */
  expectCalls(recorder(), { op: 'pocUse', code: 'C' }, [['markPocUsed', () => ['C', undefined]]])
  expectCalls(recorder(), { op: 'pocUse', id: 4, used_on: '10.9.0.5' }, [['markPocUsed', () => [4, '10.9.0.5']]])
})

test('dispatch：截图的两个 op 认 id 也认 shot_id', () => {
  for (const [op, method] of [['shotDelete', 'deleteShot'], ['shotData', 'readShot']]) {
    expectCalls(recorder(), { op, engagement: 'eng-1', id: 5 }, [[method, (r, id) => [id, 5]]])
    expectCalls(recorder(), { op, engagement: 'eng-1', shot_id: 6 }, [[method, (r, id) => [id, 6]]])
    /* 两个都给：id 赢。 */
    expectCalls(recorder(), { op, engagement: 'eng-1', id: 5, shot_id: 6 }, [[method, (r, id) => [id, 5]]])
  }
})

test('dispatch：pocSave 与模板两个 op 的转出形状', () => {
  const req = { op: 'pocSave', poc: { code: 'P1' } }
  expectCalls(recorder(), req, [['savePoc', (r) => [r.poc]]])
  /* 没有 poc 包装时把整个 req 当载荷——命令行/工具直传扁平字段。 */
  expectCalls(recorder(), { op: 'pocSave', code: 'P2' }, [['savePoc', (r) => [r]]])

  /* limit 的夹取：默认 40、上限 200（面板会传 999）。 */
  expectCalls(recorder(), { op: 'templateSearch', q: 'redis' }, [['searchTemplates', (r) => [r.q, 40]]])
  expectCalls(recorder(), { op: 'templateSearch', q: 'redis', limit: 999 }, [['searchTemplates', () => ['redis', 200]]])
  expectCalls(recorder(), { op: 'templateStats' }, [['templateStats', () => []]])

  /* pocSearch：有查询词才去搜模板，没有就只报表里的总数（避免空关键字扫全库）。 */
  const withQuery = recorder()
  expectCalls(withQuery, { op: 'pocSearch', q: 'redis' }, [
    ['searchPocs', (r) => [r]],
    ['searchTemplates', () => ['redis', 20]],
    ['pocStats', () => []],
    ['knowledgePath', () => []],
  ])
  const noQuery = recorder()
  expectCalls(noQuery, { op: 'pocSearch' }, [
    ['searchPocs', (r) => [r]],
    ['nucleiTemplatesDir', () => []],
    ['templateStats', () => []],
    ['pocStats', () => []],
    ['knowledgePath', () => []],
  ])
  /* templateLimit 同样夹到 100。 */
  expectCalls(recorder(), { op: 'pocSearch', q: 'x', templateLimit: 500 }, [
    ['searchPocs', (r) => [r]],
    ['searchTemplates', () => ['x', 100]],
    ['pocStats', () => []],
    ['knowledgePath', () => []],
  ])
})

test('dispatch：savePrompt / resetPrompts / deleteScorePoint / readAttackFile 的实参位置', () => {
  expectCalls(recorder(), { op: 'savePrompt', engagement: 'eng-1', role: 'recon', content: '# x' },
    [['savePrompt', (r, id) => [id, 'recon', '# x']]])
  expectCalls(recorder(), { op: 'resetPrompts', engagement: 'eng-1' },
    [['resetPrompts', (r, id) => [id, undefined]]])
  expectCalls(recorder(), { op: 'resetPrompts', engagement: 'eng-1', role: 'plan' },
    [['resetPrompts', (r, id) => [id, 'plan']]])
  expectCalls(recorder(), { op: 'deleteScorePoint', engagement: 'eng-1', id: 12 },
    [['deleteScorePoint', (r, id) => [id, 12]]])
  expectCalls(recorder(), { op: 'readAttackFile', engagement: 'eng-1', id: 3 },
    [['readAttackFile', (r, id) => [id, 3]]])
  /* asset / import 这两个 op 的第二个参数不是 req 本身。 */
  expectCalls(recorder(), { op: 'asset', engagement: 'eng-1', id: 9 }, [['getAsset', (r, id) => [id, 9]]])
  expectCalls(recorder(), { op: 'import', engagement: 'eng-1' }, [['importBundle', (r, id) => [id, r]]])
})

/* ------------------------------------------------------------ 真 store 端到端 */

test('dispatch：真 store 上每个读 op 都回 ok:true 且形状对得上', () => {
  withStore((store) => {
    const { id, assetId } = seed(store)

    const snapshot = dispatch(store, { op: 'snapshot', engagement: id })
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.engagement.id, id)
    assert.equal(typeof snapshot.stats.assets, 'number')

    const assets = dispatch(store, { op: 'assets', engagement: id })
    assert.equal(assets.total, 1)
    assert.equal(assets.sort, 'priority', '默认按优先级排')
    assert.equal(assets.items[0].ip, '10.9.0.5')

    const asset = dispatch(store, { op: 'asset', engagement: id, id: assetId })
    assert.equal(asset.asset.primary_name, 'gw-01')
    /* 查不到时不能抛，而且不能回 `asset: undefined` 之外的噪声。 */
    assert.equal(dispatch(store, { op: 'asset', engagement: id, id: 9999 }).asset, undefined)

    assert.deepEqual(dispatch(store, { op: 'graph', engagement: id }), { ok: true, nodes: [], edges: [] })
    const attack = dispatch(store, { op: 'attackGraph', engagement: id })
    assert.equal(attack.summary.total, 0)
    /* targetGroups 数的是**漏洞**落在几个目标上，光有资产不算（targetKey 从 vuln 行取）。 */
    assert.equal(attack.summary.targetGroups, 0)

    const stats = dispatch(store, { op: 'stats', engagement: id })
    for (const key of ['segments', 'assets', 'liveAssets', 'openPorts', 'services', 'fingerprints',
      'passiveSignals', 'activeSignals', 'vulns', 'credentials', 'accesses', 'untestedAssets', 'blockedAssets']) {
      assert.equal(typeof stats.stats[key], 'number', `stats.${key} 应是数字`)
    }

    const vulns = dispatch(store, { op: 'vulns', engagement: id })
    assert.equal(vulns.total, 0)
    assert.equal(vulns.stats.total, 0, 'vulns 同时带列表和统计')
    assert.equal(dispatch(store, { op: 'vulnStats', engagement: id }).stats.total, 0)

    assert.deepEqual(dispatch(store, { op: 'credentials', engagement: id }).items, [])
    assert.deepEqual(dispatch(store, { op: 'access', engagement: id }).items, [])
    assert.deepEqual(dispatch(store, { op: 'tunnels', engagement: id }).items, [])
    /* 域名视图按资产名归组：sed 里只有一台叫 gw-01 的资产，所以它自成一格（现状）。 */
    const domainGroups = dispatch(store, { op: 'domains', engagement: id }).items
    assert.deepEqual(domainGroups.map((g) => [g.domain, g.count]), [['gw-01', 1]])
    assert.deepEqual(dispatch(store, { op: 'httpEvidence', engagement: id }).items, [])
    assert.deepEqual(dispatch(store, { op: 'chain', engagement: id }).items, [])
    assert.deepEqual(dispatch(store, { op: 'attackFiles', engagement: id }).items, [])

    const sessions = dispatch(store, { op: 'sessions', engagement: id })
    assert.deepEqual(sessions.totals, {
      webshells: 0, webshellsOnline: 0, tunnels: 0, tunnelsActive: 0,
      tunnelsLegit: 0, tunnelsSelfOnly: 0, credentials: 0, access: 0,
    }, '只有计数是对的，别让两栏对不上')

    const shots = dispatch(store, { op: 'shots', engagement: id })
    assert.deepEqual([shots.total, shots.items.length], [0, 0])

    const testStats = dispatch(store, { op: 'testStats', engagement: id })
    assert.deepEqual(Object.keys(testStats.stats).sort(), ['abandoned', 'blocked', 'no_surface', 'tested', 'testing', 'untested'])

    const active = dispatch(store, { op: 'activeTests', engagement: id })
    for (const key of ['testing', 'recent', 'queue', 'stats', 'untested', 'at']) {
      assert.ok(key in active, `activeTests 缺 ${key}`)
    }

    const digest = dispatch(store, { op: 'consoleDigest', engagement: id })
    assert.deepEqual(Object.keys(digest.sections),
      ['assets', 'testing', 'agents', 'sessions', 'findings', 'chain', 'scores', 'report', 'attackfiles', 'knowledge', 'prompts', 'skills'])
    for (const [name, section] of Object.entries(digest.sections)) {
      assert.equal(typeof section.count, 'number', `consoleDigest.sections.${name}.count`)
      assert.ok('at' in section, `consoleDigest.sections.${name}.at`)
    }

    const stages = dispatch(store, { op: 'stages', engagement: id })
    assert.deepEqual(stages.items.map((s) => s.code), ['recon', 'internet', 'boundary', 'internal', 'target'])
    assert.deepEqual(stages.items.map((s) => s.ordinal), [1, 2, 3, 4, 5])

    const scores = dispatch(store, { op: 'scores', engagement: id })
    assert.equal(scores.items.length, 25, '内置 25 个得分点')
    assert.equal(scores.items.every((p) => p.counted === 0 && p.earned === 0), true, '空靶标上一条都没计')

    const targets = dispatch(store, { op: 'reportTargets', engagement: id })
    assert.equal(targets.ok, true)
    assert.ok(Array.isArray(targets.groups))

    const timeline = dispatch(store, { op: 'discoveryTimeline', engagement: id })
    assert.equal(timeline.ok, true)
    assert.equal(typeof timeline.span.total, 'number')

    const prompts = dispatch(store, { op: 'prompts', engagement: id })
    assert.equal(prompts.builtin, undefined, '有靶标时回的是落库稿，不带 builtin 标记')
    assert.equal(prompts.roles.length, 6)
  })
})

test('dispatch：真 store 上每个写 op 都落库、回 id、能读回来', () => {
  withStore((store) => {
    const { id, assetId } = seed(store)

    const vuln = dispatch(store, { op: 'addVuln', engagement: id, vuln: { title: 'T1', severity: 'high', asset_id: assetId } })
    assert.deepEqual([vuln.ok, vuln.updated], [true, false])
    const updated = dispatch(store, { op: 'updateVuln', engagement: id, id: vuln.id, patch: { status: 'confirmed' } })
    assert.deepEqual(updated, { ok: true, updated: true, id: vuln.id })
    assert.equal(dispatch(store, { op: 'vulns', engagement: id }).stats.byStatus.confirmed, 1)

    assert.equal(dispatch(store, { op: 'addCredential', engagement: id, credential: { host: '10.9.0.5', username: 'admin' } }).id, 1)
    assert.equal(dispatch(store, { op: 'addAccess', engagement: id, access: { host: '10.9.0.5', username: 'admin' } }).id, 1)
    assert.equal(dispatch(store, { op: 'addHttpEvidence', engagement: id, evidence: { url: 'http://10.9.0.5/a' } }).id, 1)

    const shell = dispatch(store, { op: 'addWebshell', engagement: id, webshell: { url: 'http://10.9.0.5/s.jsp' } })
    assert.deepEqual([shell.ok, shell.updated], [true, false])
    assert.deepEqual(dispatch(store, { op: 'updateWebshell', engagement: id, id: shell.id, patch: { status: 'up' } }),
      { ok: true, updated: true })

    const tunnel = dispatch(store, { op: 'addTunnel', engagement: id, tunnel: { listen: '127.0.0.1:1080', entry_kind: 'target-http' } })
    assert.deepEqual([tunnel.entry_kind, tunnel.legit], ['target-http', true])
    /* 非法状态在这里被 store 抛出来、被 dispatch 收成 error —— 这是唯一能看见的白名单。 */
    assert.equal(dispatch(store, { op: 'updateTunnel', engagement: id, id: tunnel.id, patch: { status: 'up' } }).ok, false)
    assert.deepEqual(dispatch(store, { op: 'updateTunnel', engagement: id, id: tunnel.id, patch: { status: 'down' } }), { ok: true, updated: true })

    const sessions = dispatch(store, { op: 'sessions', engagement: id })
    assert.deepEqual(sessions.totals, {
      webshells: 1, webshellsOnline: 1, tunnels: 1, tunnelsActive: 0,
      tunnelsLegit: 1, tunnelsSelfOnly: 0, credentials: 1, access: 1,
    })

    const step = dispatch(store, {
      op: 'addChainStep', engagement: id,
      step: { stage: 'recon', title: 'nmap 扫端口', tool: 'nmap -sV 10.9.0.5', evidence: '22/tcp open' },
    })
    assert.equal(step.seq, 1)
    assert.equal(step.stage_code, 'recon')
    assert.equal(dispatch(store, { op: 'chain', engagement: id }).items.length, 1)

    /* 阶段码非法时回落到 legacy 映射，并把原因写进 stage_hint。 */
    /* 非法阶段码按**老 stage 字段**兜底（不是按那个非法值兜底），所以两个都得传。 */
    const legacy = dispatch(store, { op: 'addChainStep', engagement: id, step: { stage: 'exploit', stage_code: 'exploit', title: 'x' } })
    assert.equal(legacy.stage_code, 'internet')
    const orphan = dispatch(store, { op: 'addChainStep', engagement: id, step: { stage_code: 'nope', title: 'y' } })
    assert.equal(orphan.stage_code, 'recon', '连 stage 都没有就落到 recon')
    assert.match(legacy.stage_hint, /stage_code="exploit" 非法/)

    const tested = dispatch(store, { op: 'assetTest', engagement: id, test: { asset_id: assetId, status: 'tested', notes: 'n' } })
    assert.equal(tested.ok, true)
    assert.equal(tested.status, 'tested')
    const assessed = dispatch(store, { op: 'assessAsset', engagement: id, assess: { asset_id: assetId, priority: 'high' } })
    assert.deepEqual([assessed.priority, assessed.ip], ['high', '10.9.0.5'])
    /* 两个都不带 asset_id / ip 时必须报同一句中文。 */
    const missingAsset = 'asset not found（请传 asset_id 或 ip）'
    assert.equal(dispatch(store, { op: 'assetTest', engagement: id, test: {} }).error, missingAsset)
    assert.equal(dispatch(store, { op: 'assessAsset', engagement: id, assess: {} }).error, missingAsset)

    const hit = dispatch(store, { op: 'addScoreHit', engagement: id, hit: { code: 'netdev', asset_id: assetId, target: '10.9.0.5', evidence: '登录设备' } })
    assert.equal(hit.ok, true)
    assert.equal(hit.points, 200)
    const report = dispatch(store, { op: 'scoreReport', engagement: id })
    assert.equal(report.ok, true)
    /* scoreReport 的标题带靶标名；store.report（老人工报告）是另一份模板，别混。 */
    assert.match(report.markdown, /· 红队成果复现报告/)
    const scoreChain = dispatch(store, { op: 'scoreChain', engagement: id })
    assert.equal(scoreChain.summary.hits, 1)

    assert.equal(dispatch(store, { op: 'saveStage', engagement: id, stage: { code: 'recon', name: '信息收集', goal: 'g' } }).updated, true)
    assert.equal(dispatch(store, { op: 'savePrompt', engagement: id, role: 'recon', content: '# custom' }).role, 'recon')
    assert.deepEqual(dispatch(store, { op: 'resetPrompts', engagement: id, role: 'recon' }).reset, ['recon'])
    assert.equal(dispatch(store, { op: 'resetPrompts', engagement: id }).reset.length, 6)

    const report2 = dispatch(store, { op: 'report', engagement: id })
    assert.equal(report2.ok, true)
    for (const key of ['markdown', 'generated_at', 'stats']) assert.ok(key in report2, `report 缺 ${key}`)

    const imported = dispatch(store, { op: 'import', engagement: id, bundle: {} })
    assert.equal(imported.ok, true)
    assert.deepEqual(Object.keys(imported.counts).sort(),
      ['assets', 'edges', 'fingerprints', 'names', 'ports', 'segments', 'services'], '空 bundle 也要回齐七个计数')
  })
})

/* ------------------------------------------------------------ 计分点两条特殊规矩 */

test('dispatch：改内建得分点不会覆盖，而是另建一个 -custom- 副本', () => {
  withStore((store) => {
    const { id } = seed(store)
    const builtin = dispatch(store, { op: 'scores', engagement: id }).items.find((p) => p.code === 'netdev')
    assert.equal(builtin.points, 200)
    assert.equal(builtin.builtin, true)

    /* 改名 + 改分：规则分值锁死，所以只能派生一条自建点。 */
    const saved = dispatch(store, { op: 'saveScorePoint', engagement: id, point: { code: 'netdev', name: builtin.name, points: 210 } })
    assert.equal(saved.ok, true)
    assert.match(saved.code, /^netdev-custom-/, '派生点的 code 带 -custom- 后缀')
    assert.equal(saved.builtin, false)
    assert.equal(saved.overridden, true)
    assert.equal(saved.points, 210)
    assert.match(saved.note, /自建得分点/)

    /* 原内建点一分不动。 */
    const again = dispatch(store, { op: 'scores', engagement: id }).items.find((p) => p.code === 'netdev')
    assert.equal(again.points, 200)

    /* 缺名字：名字是唯一必填项。 */
    assert.deepEqual(dispatch(store, { op: 'saveScorePoint', engagement: id, point: { code: 'netdev', points: 210 } }),
      { ok: false, error: '得分点名称必填' })

    /* 删自建点 → 回被删的 id；删不存在 → 中文报错。 */
    assert.deepEqual(dispatch(store, { op: 'deleteScorePoint', engagement: id, id: saved.id }), { ok: true, deleted: saved.id })
    assert.deepEqual(dispatch(store, { op: 'deleteScorePoint', engagement: id, id: 9999 }),
      { ok: false, error: '得分点不存在: id=9999' })
  })
})

/* ------------------------------------------------------------ 截图与尺寸嗅探 */

/** 拼一张最小 JPEG：SOF0 里放宽高，其余段只够让扫描器走到 SOF。 */
function jpegBytes(width, height) {
  const app0 = Buffer.alloc(18)
  app0.writeUInt16BE(16, 0)
  app0.write('JFIF\0', 2, 'latin1')
  const sof = Buffer.alloc(15)
  sof.writeUInt16BE(17, 0)
  sof.writeUInt8(8, 2)
  sof.writeUInt16BE(height, 3)
  sof.writeUInt16BE(width, 5)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0]), app0,
    Buffer.from([0xff, 0xc0]), sof,
    Buffer.from([0xff, 0xd9]),
  ])
}

/** 拼一个 WebP 头：`fmt` 是 VP8X（扩展）或 `VP8 `（有损）。 */
function webpBytes(fmt, width, height) {
  const buf = Buffer.alloc(40)
  buf.write('RIFF', 0, 'latin1')
  buf.writeUInt32LE(32, 4)
  buf.write('WEBP', 8, 'latin1')
  buf.write(fmt, 12, 'latin1')
  buf.writeUInt32LE(10, 16)
  if (fmt === 'VP8X') {
    buf.writeUIntLE(width - 1, 24, 3)
    buf.writeUIntLE(height - 1, 27, 3)
  } else {
    buf.writeUInt16LE(width & 0x3fff, 26)
    buf.writeUInt16LE(height & 0x3fff, 28)
  }
  return buf
}

test('dispatch：截图入库时四种容器、五种字节的宽高都能读出来', () => {
  withStore((store) => {
    const { id } = seed(store)
    const cases = [
      ['png', Buffer.from(PNG_1X1, 'base64'), 'image/png', 1, 1],
      ['png 2x3', pngBytes(2, 3), 'image/png', 2, 3],
      ['jpeg', jpegBytes(64, 32), 'image/jpeg', 64, 32],
      ['vp8x', webpBytes('VP8X', 800, 600), 'image/webp', 800, 600],
      ['vp8', webpBytes('VP8 ', 320, 240), 'image/webp', 320, 240],
    ]
    const ids = cases.map(([label, buf, mime, width, height]) => {
      const added = dispatch(store, { op: 'shotAdd', engagement: id, shot: { data_base64: buf.toString('base64'), label } })
      assert.equal(added.ok, true, `${label} 应入库`)
      const row = store.db(id).prepare('SELECT mime, width, height, bytes FROM shot WHERE id = ?').get(added.id)
      assert.deepEqual([row.mime, row.width, row.height], [mime, width, height], `${label} 的 mime/宽高`)
      assert.equal(row.bytes, buf.length)
      return added.id
    })
    assert.equal(new Set(ids).size, 5, '五次入库是五条不同记录')

    /* 读回：base64 原样，能还原成同样的字节。 */
    const back = dispatch(store, { op: 'shotData', engagement: id, id: ids[0] })
    assert.equal(back.mime, 'image/png')
    assert.equal(Buffer.from(back.base64, 'base64').toString('base64'), PNG_1X1)

    /* 删掉一条，列表要少一条；再删同一条要报"不存在"。 */
    assert.deepEqual(dispatch(store, { op: 'shotDelete', engagement: id, id: ids[0] }), { ok: true, id: ids[0] })
    assert.equal(dispatch(store, { op: 'shots', engagement: id }).total, 4)
    assert.equal(dispatch(store, { op: 'shotDelete', engagement: id, id: ids[0] }).error, `shot not found: ${ids[0]}`)
  })
})

test('dispatch：认不出尺寸时宽高为 null，但 mime 仍按魔数判', () => {
  withStore((store) => {
    const { id } = seed(store)
    /* 纯文本：既不是 PNG 也不是 JPEG/WebP → 落成 octet-stream，不猜尺寸。 */
    const text = dispatch(store, { op: 'shotAdd', engagement: id, shot: { data_base64: Buffer.from('just some text, nothing image-like').toString('base64'), label: 't' } })
    const textRow = store.db(id).prepare('SELECT mime, width, height FROM shot WHERE id = ?').get(text.id)
    assert.deepEqual([textRow.mime, textRow.width, textRow.height], ['application/octet-stream', null, null])

    /* 截断的 PNG：魔数够判 mime，但长度不足 24 字节，尺寸读不出。 */
    const cut = dispatch(store, { op: 'shotAdd', engagement: id, shot: { data_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]).toString('base64'), label: 'c' } })
    const cutRow = store.db(id).prepare('SELECT mime, width, height FROM shot WHERE id = ?').get(cut.id)
    assert.deepEqual([cutRow.mime, cutRow.width, cutRow.height], ['image/png', null, null])
  })
})

/* ------------------------------------------------------------ 攻击文件 */

test('dispatch：攻击文件四道必填闸的文案各不相同', () => {
  withStore((store) => {
    const { id } = seed(store)
    assert.equal(dispatch(store, { op: 'addAttackFile', engagement: id, file: { name: 'a.py', evidence: 'e', content: 'x' } }).error,
      'attack file target required (IP / URL / CIDR)')
    assert.equal(dispatch(store, { op: 'addAttackFile', engagement: id, file: { target: '10.9.0.5', evidence: 'e', content: 'x' } }).error,
      'attack file name required')
    assert.match(dispatch(store, { op: 'addAttackFile', engagement: id, file: { target: '10.9.0.5', name: 'a.py', content: 'x' } }).error,
      /^attack file evidence required/)
    assert.equal(dispatch(store, { op: 'addAttackFile', engagement: id, file: { target: '10.9.0.5', name: 'a.py', evidence: 'e' } }).error,
      'attack file content or path required')
  })
})

test('dispatch：攻击文件落到按目标分组的目录里，读回来内容一致', () => {
  withStore((store, dir) => {
    const { id } = seed(store)
    const added = dispatch(store, {
      op: 'addAttackFile', engagement: id,
      file: { target: '10.9.0.5/app', name: 'poc.py', evidence: '返回 uid=0', content: 'print("pwn")' },
    })
    assert.equal(added.ok, true)
    assert.equal(added.name, 'poc.py')
    assert.equal(added.kind, 'script', 'kind 不给默认 script')
    assert.match(added.path, /attack-files[\\/]+10\.9\.0\.5_app[\\/]+poc\.py$/, '路径要落在本靶标的 attack-files/<slug>/ 下')

    const tree = dispatch(store, { op: 'attackFiles', engagement: id })
    assert.equal(tree.items.length, 1)
    assert.equal(tree.items[0].target, '10.9.0.5/app')
    assert.equal(tree.items[0].count, 1)

    const row = store.db(id).prepare('SELECT id FROM attack_file').get()
    const read = dispatch(store, { op: 'readAttackFile', engagement: id, id: row.id })
    assert.equal(read.ok, true)
    assert.equal(read.content, 'print("pwn")')
    assert.equal(read.evidence, '返回 uid=0')

    /* 不存在的 id：回 {ok:true} 而不是抛——面板点到一个被并发删掉的条目不该白屏。 */
    assert.deepEqual(dispatch(store, { op: 'readAttackFile', engagement: id, id: 9999 }), { ok: true })

    /* 同一个 target+name 再存一次是覆盖（不产生第二条）。 */
    dispatch(store, { op: 'addAttackFile', engagement: id, file: { target: '10.9.0.5/app', name: 'poc.py', evidence: '第二次', content: 'print(2)' } })
    assert.equal(dispatch(store, { op: 'attackFiles', engagement: id }).items[0].count, 1)
    assert.equal(dispatch(store, { op: 'readAttackFile', engagement: id, id: row.id }).content, 'print(2)')

    /* 用 path 而不是 content：源文件必须在本靶标目录内。 */
    const inside = join(store.dirOf(id), 'src.py')
    writeFileSync(inside, 'from path\n')
    const copied = dispatch(store, { op: 'addAttackFile', engagement: id, file: { target: '10.9.0.5', name: 'src.py', evidence: 'e', path: inside } })
    assert.equal(copied.ok, true)
    assert.equal(store.readAttackFile(id, store.db(id).prepare("SELECT id FROM attack_file WHERE name = 'src.py'").get().id).content, 'from path\n')

    /* 源文件允许的范围是「本靶标目录」+ 系统临时目录（剪贴板上拖进来的文件通常落那儿）。
       超出这两个根就必须拒，否则面板会变成任意文件复制器。
       注意判据是 tmpdir() 而不是 store root：仓库里的 package.json 正好是越界样本。 */
    const rejected = dispatch(store, { op: 'addAttackFile', engagement: id, file: { target: '10.9.0.5', name: 'o.py', evidence: 'e', path: join(process.cwd(), 'package.json') } })
    assert.equal(rejected.ok, false)
    assert.match(rejected.error, /outside|within|拒绝|not allowed/i, '越界要给出可读原因：' + rejected.error)
  })
})

/* ------------------------------------------------------------ dispatchAsync */

test('dispatchAsync：probeSessions 没有靶标时直接回空，不去连网', async () => {
  const store = {
    root: '/r',
    probeSessions: async () => { throw new Error('不该被调用') },
  }
  assert.deepEqual(await dispatchAsync(store, { op: 'probeSessions' }), { ok: true, items: [], note: '还没有靶标' })

  /* 指针为 null 也算没有靶标。 */
  assert.deepEqual(await dispatchAsync({ root: '/r', activeEngagementId: () => null }, { op: 'probeSessions' }),
    { ok: true, items: [], note: '还没有靶标' })
  /* 请求里点名就用它，哪怕指针是空的。 */
  const called = []
  const named = { root: '/r', activeEngagementId: () => null, probeSessions: async (id, req) => { called.push([id, req]); return { items: [1] } } }
  assert.deepEqual(await dispatchAsync(named, { op: 'probeSessions', engagement: ' eng-9 ' }), { ok: true, items: [1] })
  assert.equal(called[0][0], 'eng-9', '靶标 id 要 trim')
})

test('dispatchAsync：probeSessions 抛什么都收成 error', async () => {
  const boom = { root: '/r', activeEngagementId: () => 'e', probeSessions: async () => { throw new Error('探测炸了') } }
  assert.deepEqual(await dispatchAsync(boom, { op: 'probeSessions' }), { ok: false, error: '探测炸了' })
  const text = { root: '/r', activeEngagementId: () => 'e', probeSessions: async () => { throw 'plain' } }
  assert.deepEqual(await dispatchAsync(text, { op: 'probeSessions' }), { ok: false, error: 'plain' })
})

test('dispatchAsync：其余 op 一律转发同步 dispatch（同一个信封）', async () => {
  const store = recorder()
  const viaAsync = await dispatchAsync(store, { op: 'stats', engagement: 'eng-1' })
  assert.deepEqual(viaAsync, dispatch(store, { op: 'stats', engagement: 'eng-1' }))
  /* 未知 op 也走同步分支，不该掉进 probeSessions 的 try。 */
  assert.deepEqual(await dispatchAsync(recorder(), { op: 'zzz' }), { ok: false, error: '未知操作: zzz' })
})


