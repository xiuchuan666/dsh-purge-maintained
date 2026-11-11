// 聊天命令与模型工具的注册面：四条 /命令 + 三个 purge_* 工具。
//
// 为什么值得单独一个文件：这段代码以前长在 lib/index.js 的 apply() 里，
// 只有「apply 能跑完」这一层被间接覆盖。命令名写错、备用名被删、
// description 改坏、handler 接错参数、工具的 parameters schema 少了
// additionalProperties: false —— 全都不会有人发现，用户看到的是
// 「这个命令/工具不存在」或者「模型调用被宿主拦掉」。
//
// 抽成 lib/commands.js 与 lib/tools.js 之后，用一个假的 commands / tools
// 对象就能把这些契约全部跑一遍，不需要装宿主。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  commandSpecs,
  isDuplicateCommandError,
  registerChatCommands,
  tryRegisterCommand,
} from '../lib/commands.js'
import { registerModelTools, toolSpecs } from '../lib/tools.js'

/* ────────────────────────── 假宿主 ────────────────────────── */

/** 记录注册了什么的假 commands 服务。 */
function fakeCommands({ taken = [] } = {}) {
  const registered = []
  return {
    registered,
    register(spec) {
      if (taken.includes(spec.name)) {
        throw new Error(`command "${spec.name}" is already registered`)
      }
      registered.push(spec)
    },
  }
}

/** 记录注册了什么的假 tools 服务。 */
function fakeTools() {
  const registered = []
  return { registered, register: (spec) => { registered.push(spec); return spec.name } }
}

/** 命令 handler 依赖：全部记下被怎么调用。 */
function fakeHandlers() {
  const calls = []
  return {
    calls,
    handlers: {
      purge: async (...args) => { calls.push(['purge', ...args]); return { kind: 'success', text: 'p' } },
      rules: async (...args) => { calls.push(['rules', ...args]); return { kind: 'success', text: 'r' } },
      skills: async (...args) => { calls.push(['skills', ...args]); return { kind: 'success', text: 's' } },
    },
  }
}

/** rewind 依赖：analyzeRewind / applyRewind 的返回值可以逐例改写。 */
function fakeRewind({ info = { ok: true, kind: 'sub' }, result = { ok: true } } = {}) {
  const calls = []
  return {
    calls,
    invocationSessionId: (invocation) => invocation.sessionId || 'sid',
    analyzeRewind: async (ctx, sessionId) => { calls.push(['analyze', sessionId]); return info },
    applyRewind: async (ctx, sessionId, mode) => { calls.push(['apply', sessionId, mode]); return result },
  }
}

const CONFIG = { enabled: true }
const CTX = { id: 'ctx' }

function specsOf(overrides = {}) {
  const { handlers } = fakeHandlers()
  return commandSpecs({ config: CONFIG, ctx: CTX, handlers, rewind: fakeRewind(), ...overrides })
}

/* ────────────────────────── 撞名退让 ────────────────────────── */

test('isDuplicateCommandError 只认「已注册」这一类错误', () => {
  assert.equal(isDuplicateCommandError(new Error('command "purge" is already registered')), true)
  assert.equal(isDuplicateCommandError(new Error('is already registered')), true)
  assert.equal(isDuplicateCommandError('already registered'), true)
  assert.equal(isDuplicateCommandError(new Error('permission denied')), false)
  assert.equal(isDuplicateCommandError(new Error('ENOENT: no such file')), false)
  assert.equal(isDuplicateCommandError(null), false)
  assert.equal(isDuplicateCommandError(undefined), false)
})

test('撞名时退到备用名，并记一条 warn（不是静默改名）', (t) => {
  const warnings = []
  t.mock.method(console, 'warn', (...args) => { warnings.push(args.join(' ')) })
  const commands = fakeCommands({ taken: ['purge'] })
  const name = tryRegisterCommand(commands, { name: 'purge', handler: () => {} }, ['purge-cmd'])
  assert.equal(name, 'purge-cmd')
  assert.equal(commands.registered.length, 1)
  assert.equal(commands.registered[0].name, 'purge-cmd')
  assert.match(warnings.join('\n'), /\/purge taken, registered \/purge-cmd/)
})

test('连备用名都被占时返回 null，且不抛错（一个插件不该让整个 apply 挂掉）', (t) => {
  const warnings = []
  t.mock.method(console, 'warn', (...args) => { warnings.push(args.join(' ')) })
  const commands = fakeCommands({ taken: ['purge', 'purge-cmd'] })
  const name = tryRegisterCommand(commands, { name: 'purge' }, ['purge-cmd'])
  assert.equal(name, null)
  assert.equal(commands.registered.length, 0)
  assert.match(warnings.join('\n'), /skip \/purge: already registered/)
})

test('非撞名错误必须原样抛出去，不能被当成撞名吞掉', () => {
  const commands = { register() { throw new Error('boom: disk full') } }
  assert.throws(() => tryRegisterCommand(commands, { name: 'purge' }, ['purge-cmd']), /boom: disk full/)
})

test('第一次就成功时不记 warn，也不用备用名', (t) => {
  const warnings = []
  t.mock.method(console, 'warn', (...args) => { warnings.push(args.join(' ')) })
  const commands = fakeCommands()
  const name = tryRegisterCommand(commands, { name: 'purge' }, ['purge-cmd'])
  assert.equal(name, 'purge')
  assert.equal(warnings.length, 0)
})

test('spec 里的其它字段原样传给宿主，只有 name 被换掉', () => {
  const commands = fakeCommands({ taken: ['purge'] })
  const spec = { name: 'purge', description: 'd', input: { hint: 'h' }, handler: () => {} }
  tryRegisterCommand(commands, spec, ['purge-cmd'])
  assert.equal(commands.registered[0].description, 'd')
  assert.equal(commands.registered[0].input.hint, 'h')
  assert.equal(commands.registered[0].name, 'purge-cmd')
})

/* ────────────────────────── 四条命令的契约 ────────────────────────── */

test('四条命令齐全，顺序固定（顺序变了菜单里的排列就变了）', () => {
  const names = specsOf().map((s) => s.spec.name)
  assert.deepEqual(names, ['purge', 'rules', 'skills', 'rewind'])
})

test('每条命令都有备用名，且备用名互不相同', () => {
  const fallbacks = specsOf().map((s) => s.fallbacks)
  assert.deepEqual(fallbacks, [['purge-cmd'], ['purge-rules'], ['purge-skills'], ['purge-rewind']])
  const flat = fallbacks.flat()
  assert.equal(new Set(flat).size, flat.length)
})

test('每条命令都有 description 与 input.hint（缺了命令列表里就是空白）', () => {
  for (const { spec } of specsOf()) {
    assert.equal(typeof spec.description, 'string', `${spec.name} 缺 description`)
    assert.ok(spec.description.length > 8, `${spec.name} 的 description 太短`)
    assert.equal(typeof spec.input?.hint, 'string', `${spec.name} 缺 input.hint`)
  }
})

test('/purge 的 handler 把 rawInput、config、ctx 一起透给 handlePurgeCommand', async () => {
  const { handlers, calls } = fakeHandlers()
  const specs = commandSpecs({ config: CONFIG, ctx: CTX, handlers, rewind: fakeRewind() })
  await specs[0].spec.handler({ rawInput: 'apply' })
  assert.deepEqual(calls[0], ['purge', 'apply', CONFIG, CTX])
})

test('/purge 的 rawInput 缺失时传空串（不是 undefined，否则 handler 里的 split 会炸）', async () => {
  const { handlers, calls } = fakeHandlers()
  const specs = commandSpecs({ config: CONFIG, ctx: CTX, handlers, rewind: fakeRewind() })
  await specs[0].spec.handler({})
  assert.equal(calls[0][1], '')
})

test('/rules 与 /skills 的 handler 只吃 rawInput，不吃 config', async () => {
  const { handlers, calls } = fakeHandlers()
  const specs = commandSpecs({ config: CONFIG, ctx: CTX, handlers, rewind: fakeRewind() })
  await specs[1].spec.handler({ rawInput: 'list' })
  await specs[2].spec.handler({ rawInput: 'list' })
  assert.deepEqual(calls[0], ['rules', 'list'])
  assert.deepEqual(calls[1], ['skills', 'list'])
})

test('/rewind 子代理且没给参数时直接回退一次', async () => {
  const rewind = fakeRewind({ info: { ok: true, kind: 'sub' } })
  const specs = commandSpecs({ config: CONFIG, ctx: CTX, handlers: fakeHandlers().handlers, rewind })
  const out = await specs[3].spec.handler({ rawInput: '', sessionId: 's1' })
  assert.equal(out.kind, 'success')
  assert.deepEqual(rewind.calls, [['analyze', 's1'], ['apply', 's1', 'once']])
})

test('/rewind 主代理不带参数时只提示、不回退（回退主代理一次可能丢半轮对话）', async () => {
  const rewind = fakeRewind({ info: { ok: true, kind: 'main' } })
  const specs = commandSpecs({ config: CONFIG, ctx: CTX, handlers: fakeHandlers().handlers, rewind })
  const out = await specs[3].spec.handler({ rawInput: '', sessionId: 's1' })
  assert.equal(out.kind, 'success')
  assert.match(out.text, /\/rewind once/)
  assert.match(out.text, /\/rewind round/)
  assert.deepEqual(rewind.calls, [['analyze', 's1']])   // 没有 apply
})

test('/rewind once 与 /rewind round 分别传对应模式，且大小写不敏感', async () => {
  for (const [input, mode] of [['once', 'once'], ['ROUND', 'round'], ['Round', 'round']]) {
    const rewind = fakeRewind({ info: { ok: true, kind: 'main' } })
    const specs = commandSpecs({ config: CONFIG, ctx: CTX, handlers: fakeHandlers().handlers, rewind })
    await specs[3].spec.handler({ rawInput: input, sessionId: 's1' })
    assert.deepEqual(rewind.calls[1], ['apply', 's1', mode], `input=${input}`)
  }
})

test('/rewind 回退失败时把 error 原样当 text 返回，kind 是 error', async () => {
  const rewind = fakeRewind({ result: { ok: false, error: '当前没有可回退的消息' } })
  const specs = commandSpecs({ config: CONFIG, ctx: CTX, handlers: fakeHandlers().handlers, rewind })
  const out = await specs[3].spec.handler({ rawInput: 'once', sessionId: 's1' })
  assert.deepEqual(out, { kind: 'error', text: '当前没有可回退的消息' })
})

test('/rewind 的两次成功文案不一样（一次 vs 上一轮），别混用', async () => {
  const once = await commandSpecs({ config: CONFIG, ctx: CTX, handlers: fakeHandlers().handlers, rewind: fakeRewind() })
    .at(3).spec.handler({ rawInput: 'once', sessionId: 's1' })
  const round = await commandSpecs({ config: CONFIG, ctx: CTX, handlers: fakeHandlers().handlers, rewind: fakeRewind() })
    .at(3).spec.handler({ rawInput: 'round', sessionId: 's1' })
  assert.match(once.text, /已回退一次/)
  assert.match(round.text, /已回退上一轮/)
  assert.notEqual(once.text, round.text)
})

/* ────────────────────────── 注册编排 ────────────────────────── */

test('registerChatCommands 没有 commands 服务时返回空数组，不抛错', () => {
  assert.deepEqual(registerChatCommands(null, {}), [])
  assert.deepEqual(registerChatCommands(undefined, {}), [])
})

test('registerChatCommands 返回四条实际生效的名字', () => {
  const commands = fakeCommands()
  const out = registerChatCommands(commands, {
    config: CONFIG, ctx: CTX, handlers: fakeHandlers().handlers, rewind: fakeRewind(),
  })
  assert.deepEqual(out, ['purge', 'rules', 'skills', 'rewind'])
  assert.equal(commands.registered.length, 4)
})

test('registerChatCommands 在全撞名时返回四个 null，且一条都不注册', (t) => {
  t.mock.method(console, 'warn', () => {})
  const commands = fakeCommands({ taken: ['purge', 'purge-cmd', 'rules', 'purge-rules', 'skills', 'purge-skills', 'rewind', 'purge-rewind'] })
  const out = registerChatCommands(commands, {
    config: CONFIG, ctx: CTX, handlers: fakeHandlers().handlers, rewind: fakeRewind(),
  })
  assert.deepEqual(out, [null, null, null, null])
  assert.equal(commands.registered.length, 0)
})

test('一条撞名不影响其余三条（逐条 try/catch 的意义）', (t) => {
  t.mock.method(console, 'warn', () => {})   // 这条故意造撞名，warn 是预期输出，别污染测试日志
  const commands = fakeCommands({ taken: ['rules'] })
  const out = registerChatCommands(commands, {
    config: CONFIG, ctx: CTX, handlers: fakeHandlers().handlers, rewind: fakeRewind(),
  })
  assert.deepEqual(out, ['purge', 'purge-rules', 'skills', 'rewind'])
})

/* ────────────────────────── 三个模型工具 ────────────────────────── */

/** 假 core：三个工具用到的每个函数都可单独改写。 */
function fakeCore(overrides = {}) {
  return {
    ALL_PATCHES: new Array(86).fill({}),
    gatherState: async () => ({ ai_base: '/host/ai', dsh_home: '/home' }),
    missingAiBaseMessage: () => '找不到宿主',
    applyRuntimeEnv: () => {},
    sanitizeDesktopCommandRuntimes: () => [],
    applyPatchesAllHosts: async () => ({ hosts: [{ aiBase: '/host/ai' }], report: [] }),
    patchAllShims: async () => {},
    silenceCmdFlash: () => ({ phase1: 'ok' }),
    revertAll: async () => ({ reverted: [], errors: [] }),
    revertAllShims: async () => ({}),
    ...overrides,
  }
}

const renderStatus = (state) => `status ai_base=${state.ai_base}`
const noPrompt = () => null

function toolsOf(overrides = {}) {
  return toolSpecs({ core: fakeCore(), renderStatus, rejectIfNeedPrompt: noPrompt, ...overrides })
}

test('三个工具齐全，顺序固定，名字就是模型看到的调用名', () => {
  assert.deepEqual(toolsOf().map((t) => t.name), ['purge_status', 'purge_apply', 'purge_revert'])
})

test('每个工具的 parameters 都是空对象且 additionalProperties: false（否则模型会编参数）', () => {
  for (const spec of toolsOf()) {
    assert.equal(spec.parameters.type, 'object', `${spec.name} parameters.type`)
    assert.equal(spec.parameters.additionalProperties, false, `${spec.name} 少了 additionalProperties: false`)
    assert.deepEqual(spec.parameters.properties, {}, `${spec.name} 不该有参数`)
  }
})

test('每个工具的 output.schema 只回一个 text 字符串，render 也照这个取', () => {
  for (const spec of toolsOf()) {
    assert.deepEqual(spec.output.schema, {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
    }, `${spec.name} output.schema`)
    assert.deepEqual(spec.output.render({}, { text: 'hi' }), [{ type: 'text', text: 'hi' }])
    // text 缺失时要渲染成空串而不是 "undefined"
    assert.deepEqual(spec.output.render({}, {}), [{ type: 'text', text: '' }])
    assert.deepEqual(spec.output.render({}, null), [{ type: 'text', text: '' }])
  }
})

test('description 里带补丁数，改注册表时描述会跟着变', () => {
  const specs = toolsOf()
  assert.match(specs[0].description, /86 patch/)
  assert.match(specs[1].description, /86 patch/)
})

test('purge_status 把 gatherState 的结果交给 renderStatus', async () => {
  let seen = null
  const core = fakeCore({ gatherState: async () => ({ ai_base: '/x', dsh_home: '/y' }) })
  const specs = toolSpecs({ core, renderStatus: (s) => { seen = s; return 'rendered' }, rejectIfNeedPrompt: noPrompt })
  const out = await specs[0].execute()
  assert.deepEqual(out, { text: 'rendered' })
  assert.deepEqual(seen, { ai_base: '/x', dsh_home: '/y' })
})

test('purge_apply 没有宿主目录时直接报错，不往下打补丁', async () => {
  let patched = false
  const core = fakeCore({
    gatherState: async () => ({ ai_base: null, dsh_home: '/home' }),
    applyPatchesAllHosts: async () => { patched = true; return { hosts: [], report: [] } },
  })
  const out = await (toolSpecs({ core, renderStatus, rejectIfNeedPrompt: noPrompt })[1].execute())
  assert.match(out.text, /^ERROR: 找不到宿主/)
  assert.equal(patched, false)
})

test('purge_apply 需要提示词确认时停手，把 blocked.error 原样透出', async () => {
  let patched = false
  const core = fakeCore({ applyPatchesAllHosts: async () => { patched = true; return { hosts: [], report: [] } } })
  const out = await toolSpecs({
    core, renderStatus, rejectIfNeedPrompt: () => ({ error: '先确认提示词' }),
  })[1].execute()
  assert.deepEqual(out, { text: 'ERROR: 先确认提示词' })
  assert.equal(patched, false)
})

test('purge_apply 成功时统计 applied / already，并带上桌面清洗条数与 phase-1', async () => {
  const core = fakeCore({
    sanitizeDesktopCommandRuntimes: () => ['a', 'b'],
    applyPatchesAllHosts: async () => ({
      hosts: [{ aiBase: '/host/ai' }],
      report: [{ status: 'applied' }, { status: 'applied' }, { status: 'already' }, { status: 'skipped' }],
    }),
    silenceCmdFlash: () => ({ phase1: 'done' }),
  })
  const out = await toolSpecs({ core, renderStatus, rejectIfNeedPrompt: noPrompt })[1].execute()
  assert.equal(out.text, '清洗完成 / applied=2, already=1. desktop_scrub=2 phase-1=done 重启 dsh 生效.')
})

test('purge_apply 没有桌面清洗时不留多余空格', async () => {
  const core = fakeCore({
    applyPatchesAllHosts: async () => ({ hosts: [{ aiBase: '/h' }], report: [{ status: 'applied' }] }),
  })
  const out = await toolSpecs({ core, renderStatus, rejectIfNeedPrompt: noPrompt })[1].execute()
  assert.doesNotMatch(out.text, /desktop_scrub/)
  assert.match(out.text, /applied=1, already=0\. phase-1=/)
})

test('purge_apply 走 preserveClientBundles: false 与 forApply: true（客户端产物由构建链负责）', async () => {
  let seenOptions = null
  const core = fakeCore({
    applyPatchesAllHosts: async (_patches, options) => {
      seenOptions = options
      return { hosts: [{ aiBase: '/h' }], report: [] }
    },
  })
  await toolSpecs({ core, renderStatus, rejectIfNeedPrompt: noPrompt })[1].execute()
  assert.deepEqual(seenOptions, { preserveClientBundles: false, forApply: true })
})

test('purge_revert 有宿主时同时回滚补丁与 shim，并报出两边的数', async () => {
  const core = fakeCore({
    revertAll: async () => ({ reverted: [{}, {}, {}], errors: [] }),
    revertAllShims: async () => ({ d1: 1, d2: 2 }),
  })
  const out = await toolSpecs({ core, renderStatus, rejectIfNeedPrompt: noPrompt })[2].execute()
  assert.equal(out.text, '回滚完成 / reverted=3, shim_dirs=2. 重启 dsh 恢复.')
})

test('purge_revert 有错误时把 errors 数带上（否则用户以为全好了）', async () => {
  const core = fakeCore({
    revertAll: async () => ({ reverted: [{}], errors: [{}, {}] }),
    revertAllShims: async () => ({}),
  })
  const out = await toolSpecs({ core, renderStatus, rejectIfNeedPrompt: noPrompt })[2].execute()
  assert.match(out.text, /reverted=1 errors=2/)
})

test('purge_revert 没有宿主目录时跳过补丁回滚，但仍然收 shim', async () => {
  let revertCalled = false
  const core = fakeCore({
    gatherState: async () => ({ ai_base: null, dsh_home: '/home' }),
    revertAll: async () => { revertCalled = true; return { reverted: [], errors: [] } },
    revertAllShims: async () => ({ d1: 1 }),
  })
  const out = await toolSpecs({ core, renderStatus, rejectIfNeedPrompt: noPrompt })[2].execute()
  assert.equal(revertCalled, false)
  assert.equal(out.text, '回滚完成 / shim_dirs=1. 重启 dsh 恢复.')
})

/* ────────────────────────── 工具注册编排 ────────────────────────── */

test('registerModelTools 没有 tools 服务时返回空数组（老宿主只有命令没有工具）', () => {
  assert.deepEqual(registerModelTools({}, { core: fakeCore(), renderStatus, rejectIfNeedPrompt: noPrompt }), [])
  assert.deepEqual(registerModelTools(null, {}), [])
})

test('registerModelTools 注册三个工具并回传注册结果', () => {
  const tools = fakeTools()
  const out = registerModelTools({ tools }, { core: fakeCore(), renderStatus, rejectIfNeedPrompt: noPrompt })
  assert.deepEqual(out, ['purge_status', 'purge_apply', 'purge_revert'])
  assert.equal(tools.registered.length, 3)
})
