// 演练台的 64 个模型工具：参数面必须能被宿主编译，execute 的入口分叉必须按预期走。
//
// 为什么值得单独一个文件：`lib/redteam/tools.js` 有 2269 行、64 个工具，
// 之前模块顶层就调 `loadDefineTool()`，任何没有宿主包的进程连 import 都抛错
// （`cannot resolve @deepseek-ai/dsh-tools from host`），于是这 2269 行
// 一条测试都没有、覆盖率根本不在报告里。改成本地工厂之后才测得动。
//
// 参数面用**真实宿主**的 `parameterSchemaSpecToJsonSchema` / `validateArgs` 校验，
// 不自己实现一遍 JSON Schema —— 自己实现一份等于「拿自己的理解验证自己的理解」，
// 宿主改了规则我们这边照样全绿。宿主不在的机器上这几条会 skip，其余照跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/redteam/tools.js'

const HOST_PKG = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/package.json'

/** 宿主包：找不到就 null，调用方 skip。 */
function hostTools() {
  try {
    return createRequire(HOST_PKG)('@deepseek-ai/dsh-tools')
  } catch {
    return null
  }
}

const HOST = hostTools()

/** 每个用例一份临时 root：并发上限会读 `<root>/settings.json`，共用会串状态。 */
async function withRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purge-tools-'))
  try {
    return await fn(dir)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows EPERM */ }
  }
}

/** 注册全部工具。`store` 为 undefined 时模拟宿主没给 ctx.redteam。 */
function build(store, extra = {}) {
  const registered = []
  const defined = []
  const warns = []
  const ctx = {
    defineTool: (spec) => { defined.push(spec.name); return { ...spec } },
    tools: { register: (tool) => registered.push(tool) },
    effect: () => () => {},
    on: () => () => {},
    get: () => undefined,
    logger: { warn: (m) => warns.push(m) },
    ...extra,
  }
  if (store !== undefined) ctx.redteam = store
  apply(ctx)
  return {
    registered,
    defined,
    warns,
    byName: Object.fromEntries(registered.map((t) => [t.name, t])),
  }
}

/** 只做了绑定解析、别的方法都没有的桩库。 */
function baseStore(overrides = {}) {
  return {
    root: undefined,
    activeEngagementId: () => undefined,
    listEngagements: () => [{ id: 'eng-1', name: 'ACME 科技' }],
    stats: () => ({ assets: 0 }),
    ...overrides,
  }
}

/** 每个用例一个新会话 id：`bindings` 是模块级 Map，共用一个 id 会串状态。 */
let sessionSeq = 0
const nextExec = () => {
  sessionSeq += 1
  return { agent: { session: { id: `sess-${sessionSeq}` } } }
}

const parse = (text) => JSON.parse(text)

/* ============================================================ 模块面 */

test('模块可以脱离宿主被 import，且声明了自己需要的服务', async () => {
  assert.equal(name, 'dsh-purge-redteam-tools')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('apply 注册 64 个工具，且每个工具都经过 defineTool 与 tools.register', async () => {
  const { registered, defined } = build(baseStore())
  assert.equal(registered.length, 64)
  assert.equal(defined.length, 64)
  // 两个钩子必须一一对应，否则某个工具绕过了 schema 编译
  assert.deepEqual(defined, registered.map((t) => t.name))
  assert.equal(new Set(registered.map((t) => t.name)).size, 64)
})

test('每个工具都有 description / parameters / output / execute', async () => {
  const { registered } = build(baseStore())
  for (const tool of registered) {
    assert.equal(typeof tool.name, 'string', tool.name)
    assert.ok(tool.description && tool.description.length > 0, `${tool.name} 缺 description`)
    assert.equal(typeof tool.parameters, 'object', tool.name)
    assert.equal(typeof tool.execute, 'function', tool.name)
    assert.equal(tool.output.schema.type, 'string', tool.name)
    assert.equal(typeof tool.output.render, 'function', tool.name)
  }
})

test('参数只用宿主认识的键，required 的参数一定在 properties 里', async () => {
  const ALLOWED = new Set(['type', 'required', 'description', 'items', 'enum', 'additionalProperties'])
  const { registered } = build(baseStore())
  for (const tool of registered) {
    /* parameters 是「参数名 → spec」的映射，所以键检查要下钻一层：
       外层键是业务参数名（target / severity …），内层键才是宿主认识的 schema 字段。 */
    for (const [param, spec] of Object.entries(tool.parameters)) {
      const where = `${tool.name}.${param}`
      assert.equal(typeof spec, 'object', `${where} 不是对象`)
      assert.ok(typeof spec.type === 'string', `${where} 缺 type`)
      for (const key of Object.keys(spec)) {
        assert.ok(ALLOWED.has(key), `${where} 用了宿主不认识的键 ${key}`)
      }
      if (spec.enum !== undefined) {
        assert.ok(Array.isArray(spec.enum) && spec.enum.length > 0, `${where} enum 为空`)
      }
      if (spec.type === 'array') {
        assert.equal(typeof spec.items, 'object', `${where} 是数组但没写 items`)
      }
    }
  }
})

/* ============================================================ 参数面（宿主校验器） */

test('64 个参数面全部能被宿主编译成 JSON Schema', async (t) => {
  if (HOST === null) return t.skip('本机没有宿主包 @deepseek-ai/dsh-tools')
  const { registered } = build(baseStore())
  for (const tool of registered) {
    const schema = HOST.parameterSchemaSpecToJsonSchema(tool.parameters)
    assert.equal(schema.type, 'object', tool.name)
    assert.equal(typeof schema.properties, 'object', tool.name)
  }
})

test('宿主拒绝缺必填、类型错、枚举外的值', async (t) => {
  if (HOST === null) return t.skip('本机没有宿主包 @deepseek-ai/dsh-tools')
  const { byName } = build(baseStore())
  const open = byName.redteam_engagement_open
  const vuln = byName.redteam_vuln_add
  const get = byName.redteam_asset_get

  assert.deepEqual(HOST.validateArgs(open.parameters, {}), ['missing required property "target"'])
  assert.deepEqual(HOST.validateArgs(open.parameters, { target: 5 }), ['"target" must be a string'])
  assert.deepEqual(HOST.validateArgs(vuln.parameters, { title: 'x', severity: 'bogus' }),
    ['"severity" must be one of ["critical","high","medium","low","info"]'])
  assert.deepEqual(HOST.validateArgs(get.parameters, { id: '3' }), ['"id" must be a number'])
  assert.deepEqual(HOST.validateArgs(vuln.parameters, { title: 'x', severity: 'high' }), [])
})

test('宿主对数组与对象参数的校验按元素/类型判定', async (t) => {
  if (HOST === null) return t.skip('本机没有宿主包 @deepseek-ai/dsh-tools')
  const { byName } = build(baseStore())
  const open = byName.redteam_engagement_open
  const record = byName.redteam_evidence_record

  assert.deepEqual(HOST.validateArgs(open.parameters, { target: 'x', scope: ['10.0.0.0/8'] }), [])
  assert.deepEqual(HOST.validateArgs(open.parameters, { target: 'x', scope: 'str' }), ['"scope" must be an array'])
  assert.deepEqual(HOST.validateArgs(open.parameters, { target: 'x', scope: [1] }), ['"scope[0]" must be a string'])
  assert.deepEqual(HOST.validateArgs(record.parameters, { operation: 'o', result: { a: 1 } }), [])
  assert.deepEqual(HOST.validateArgs(record.parameters, { operation: 'o', result: 'str' }), ['"result" must be an object'])
})

test('现状锁定：宿主不拒绝未声明的参数（多传的键会被静默忽略）', async (t) => {
  if (HOST === null) return t.skip('本机没有宿主包 @deepseek-ai/dsh-tools')
  const { byName } = build(baseStore())
  // 这不是「正确」而是「当前如此」：execute 里读不到 bogus，调用方以为自己传进去了。
  // 要改得收紧 schema（additionalProperties:false），属产品决策，本轮不动。
  assert.deepEqual(HOST.validateArgs(byName.redteam_engagement_open.parameters, { target: 'x', bogus: 1 }), [])
})

/* ============================================================ 靶标绑定解析 */

test('绑定解析：只有一个靶标时自动绑定，不用显式传 engagement', async () => {
  const seen = []
  const { byName } = build(baseStore({
    listAssets: (id) => { seen.push(id); return { total: 0, items: [] } },
  }))
  const out = parse(await byName.redteam_asset_query.execute({}, nextExec()))
  assert.equal(out.ok, true)
  assert.equal(out.engagement, 'eng-1')
  assert.deepEqual(seen, ['eng-1'])
})

test('绑定解析：显式传的 engagement 优先于全局当前靶标', async () => {
  const seen = []
  const { byName } = build(baseStore({
    activeEngagementId: () => 'global-one',
    listEngagements: () => [{ id: 'global-one' }, { id: 'explicit-one' }],
    listAssets: (id) => { seen.push(id); return { total: 0, items: [] } },
  }))
  const out = parse(await byName.redteam_asset_query.execute({ engagement: 'explicit-one' }, nextExec()))
  assert.equal(out.engagement, 'explicit-one')
  assert.deepEqual(seen, ['explicit-one'])
})

test('绑定解析：多个靶标又没绑定时报错，并提示去 open', async () => {
  const { byName } = build(baseStore({
    listEngagements: () => [{ id: 'a' }, { id: 'b' }],
  }))
  const out = parse(await byName.redteam_asset_query.execute({}, nextExec()))
  assert.equal(out.ok, false)
  assert.match(out.error, /尚未绑定靶标/)
  assert.match(out.error, /redteam_engagement_open/)
  assert.equal(out.error_kind, 'failed')
})

test('绑定解析：全局当前靶标被别的会话占用时，本会话不许跟着写', async () => {
  const store = baseStore({
    activeEngagementId: () => 'shared',
    listEngagements: () => [{ id: 'shared' }, { id: 'other' }],
    listAssets: () => ({ total: 0, items: [] }),
  })
  const { byName } = build(store)
  // 第一个会话可以占用
  assert.equal(parse(await byName.redteam_asset_query.execute({}, { agent: { session: { id: 'sess-a' } } })).ok, true)
  // 第二个会话必须被挡住，否则两个会话会往同一个靶标库串写
  const blocked = parse(await byName.redteam_asset_query.execute({}, { agent: { session: { id: 'sess-b' } } }))
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /已被另一个会话占用/)
})

test('子会话继承父会话的绑定，并且能看到自己的会话链', async () => {
  const parent = { agent: { session: { id: 'parent-1' } } }
  const { byName } = build(baseStore({
    listAssets: () => ({ total: 0, items: [] }),
    sessionSummary: () => ({ sessions: [] }),
  }))
  await byName.redteam_asset_query.execute({}, parent)
  const child = {
    agent: {
      session: {
        id: 'child-9',
        header: { parentSession: 'parent-1' },
        store: { get: () => parent.agent.session },
      },
    },
  }
  const info = parse(await byName.redteam_session_info.execute({}, child))
  assert.equal(info.session.session_id, 'child-9')
  assert.equal(info.session.parent_session, 'parent-1')
  assert.equal(info.session.root_session, 'parent-1')
  assert.equal(info.session.is_subagent, true)
  assert.deepEqual(info.session.session_chain, ['child-9', 'parent-1'])
  assert.equal(info.session.bound_engagement, 'eng-1')
})

test('session_bind 支持 id / 全名 / 子串，认不出时列出候选', async () => {
  const { byName } = build(baseStore({
    listEngagements: () => [{ id: 'id-1', name: 'ACME 科技' }, { id: 'id-2', name: 'Beta 公司' }],
  }))
  const empty = parse(await byName.redteam_session_bind.execute({}, nextExec()))
  assert.equal(empty.ok, false)
  assert.equal(empty.candidates.length, 2)
  assert.match(empty.note, /完成绑定/)

  assert.equal(parse(await byName.redteam_session_bind.execute({ engagement: 'id-2' }, nextExec())).ok, true)
  assert.equal(parse(await byName.redteam_session_bind.execute({ engagement: 'ACME 科技' }, nextExec())).ok, true)
  assert.equal(parse(await byName.redteam_session_bind.execute({ engagement: 'Beta' }, nextExec())).ok, true)

  const miss = parse(await byName.redteam_session_bind.execute({ engagement: 'nope' }, nextExec()))
  assert.equal(miss.ok, false)
  assert.match(miss.error, /靶标不存在：nope/)
  assert.deepEqual(miss.candidates, ['id-1', 'id-2'])
})

/* ============================================================ 并发闸门 */

test('agent_slot：状态里带上限、已用、空闲与注册表信息', async () => {
  await withRoot(async (root) => {
    const { byName } = build(baseStore({ root }))
    const out = parse(await byName.redteam_agent_slot.execute({ action: 'status' }, nextExec()))
    assert.equal(out.ok, true)
    assert.equal(out.max, 3)
    assert.equal(out.used, 0)
    assert.equal(out.free, 3)
    assert.equal(out.registry_available, false)
    assert.match(out.registry_note, /注册表不可用/)
  })
})

test('agent_slot：占满后 acquire 被拒，release 之后又能拿到', async () => {
  await withRoot(async (root) => {
    const { byName } = build(baseStore({ root }))
    const exec = { agent: { session: { id: 'slot-sess' } } }
    const slots = []
    for (let i = 0; i < 3; i += 1) {
      const got = parse(await byName.redteam_agent_slot.execute({ action: 'acquire', label: `w${i}` }, exec))
      assert.equal(got.ok, true)
      slots.push(got.slot)
    }
    const denied = parse(await byName.redteam_agent_slot.execute({ action: 'acquire', label: 'w3' }, exec))
    assert.equal(denied.ok, false)
    assert.match(denied.error, /并发已满/)

    const released = parse(await byName.redteam_agent_slot.execute({ action: 'release' }, exec))
    assert.equal(released.ok, true)
    assert.equal(released.released, true)
    const again = parse(await byName.redteam_agent_slot.execute({ action: 'acquire', label: 'w4' }, exec))
    assert.equal(again.ok, true)
  })
})

test('agent_slot：没有会话上下文时如实说明取不到会话 id', async () => {
  await withRoot(async (root) => {
    const { byName } = build(baseStore({ root }))
    const out = parse(await byName.redteam_agent_slot.execute({ action: 'status' }, {}))
    assert.equal(out.ok, false)
    assert.match(out.error, /取不到会话 id/)
  })
})

/* ============================================================ 错误结构化 */

test('宿主没给 ctx.redteam 时，工具报「资产库不可用」而不是崩掉', async () => {
  const { byName, warns } = build(undefined)
  assert.equal(byName.redteam_engagement_open !== undefined, true)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /ctx\.redteam unavailable/)
  const out = parse(await byName.redteam_engagement_open.execute({ target: 't' }, nextExec()))
  assert.equal(out.ok, false)
  assert.equal(out.error, '红队资产库不可用')
  assert.equal(out.error_kind, 'failed')
  assert.match(out.hint, /不要静默跳过/)
})

test('桩库缺方法时报错原文照抄，不吞成「失败」了事', async () => {
  const { byName } = build(baseStore())
  const out = parse(await byName.redteam_score_list.execute({}, nextExec()))
  assert.equal(out.ok, false)
  assert.match(out.error, /listScorePoints is not a function/)
  assert.equal(out.error_kind, 'failed')
})

test('非法入参归到 bad_input，并给出「先查 id」的提示', async () => {
  const { byName } = build(baseStore({
    listVulns: () => { throw new Error('非法 severity') },
  }))
  const out = parse(await byName.redteam_vuln_query.execute({}, nextExec()))
  assert.equal(out.ok, false)
  assert.equal(out.error_kind, 'bad_input')
  assert.match(out.hint, /_list|_query/)
})

/* ============================================================ 只读工具 */

test('asset_query 把 limit 夹到 200 以内', async () => {
  const seen = []
  const { byName } = build(baseStore({
    listAssets: (id, filter) => { seen.push(filter); return { total: 0, items: [] } },
  }))
  await byName.redteam_asset_query.execute({ limit: 9999, cidr: '10.0.0.0/24' }, nextExec())
  assert.equal(seen[0].limit, 200)
  assert.equal(seen[0].cidr, '10.0.0.0/24')
})

test('roles 按固定顺序列出角色，不依赖 store', async () => {
  const { byName } = build(baseStore())
  const out = parse(await byName.redteam_roles.execute({}, nextExec()))
  assert.equal(out.ok, true)
  assert.equal(out.roles[0].role, 'plan')
  assert.equal(out.roles[0].title, '主会话（指挥）')
  assert.ok(out.roles.length >= 5)
})

test('preflight 在没有 skills 服务时也给出可读结论，而不是空对象', async () => {
  const { byName } = build(baseStore())
  const out = parse(await byName.redteam_preflight.execute({}, nextExec()))
  assert.equal(typeof out.all_checked, 'object')
  assert.equal(out.all_checked.registry_total, 23)
  assert.equal(out.all_checked.broken, 0)
  assert.equal(out.onboarding.complete, false)
})

/* ============================================================ 现状锁定 */

test('现状锁定：engagement_open 缺 target 时不在 execute 层拦截（靠宿主 validateArgs）', async () => {
  const { byName } = build(baseStore({
    openEngagement: (target) => ({ id: `eng-${target}`, name: String(target), stats: {} }),
  }))
  const out = parse(await byName.redteam_engagement_open.execute({}, nextExec()))
  // 这不是「正确」而是「当前如此」：execute 层不做二次校验，参数缺失由宿主 schema 挡。
  // 把校验挪进 execute 会让「宿主已校验」和「工具再校验」两份规则漂移，属产品决策。
  assert.equal(out.ok, true)
  assert.equal(out.engagement.id, 'eng-undefined')
})
