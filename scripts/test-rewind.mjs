/**
 * `/rewind`（回退上一轮 / 上一步）的规划与执行。
 *
 * 为什么值得单独一个文件：这条命令用户是直接敲的，出错的表现分两种，
 * 一种很吵（点了没反应），一种很静——**回退了，但回到的那句不对**。
 * 后者尤其危险：用户以为「这句重发一次」，实际上是「重发上一句」或者
 * 「重发一段空字符串」，接着就把上下文彻底搞乱了。
 *
 * 所以这里钉两层：
 *   1. `planRewind` 在什么形状的事件流上切哪一刀（纯函数，最容易测也最容易改坏）；
 *   2. `applyRewind` 的四条落地路径（fork / 空白新会话 / round 连带子会话 / 没有 API）
 *      与它们必须产生的副作用顺序。
 *
 * 无法在这里覆盖的部分写在第 10 条之后：`waitTurnClosed` 的 8 秒超时、
 * 以及草稿 10 分钟过期的清理——两者都要真等，不适合放进每次提交都跑的套件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeRewind,
  applyRewind,
  getDraft,
  getPending,
  invocationSessionId,
  lastHumanUserText,
  lastTurnSubagentIds,
  pendingInboxInserts,
  planRewind,
  readLastUserText,
  takeDraft,
} from '../lib/rewind.js'

/* ------------------------------------------------------------------ 事件构造器 */

const user = (seq, text, source = { kind: 'user' }) => ({ seq, type: 'user/message', data: { content: text, source } })
const turnStart = (seq, turn) => ({ seq, type: 'turn/start', data: { turn } })
const turnEnd = (seq, turn) => ({ seq, type: 'turn/end', data: { turn } })
const stepStart = (seq, turn, step) => ({ seq, type: 'step/start', data: { turn, step } })

/* ------------------------------------------------------------------ 假宿主 */

let sessionSeq = 0
const freshSession = () => `rw-${Date.now()}-${(sessionSeq += 1)}`

/**
 * 造一个只实现 rewind 用到的五个服务的 ctx。
 * `events` 可以传数组，也可以传「每次读都返回下一个」的函数（用来模拟等待期间轮次结束）。
 */
function mkCtx(events, opts = {}) {
  const calls = []
  const at = typeof events === 'function' ? events : () => events
  const header = opts.header || { id: 's1', cwd: 'D:/w' }
  const childHeader = opts.childHeader || { id: 'child', cwd: 'D:/w' }
  const sessions = {
    get: (id) => {
      calls.push(['sessions.get', id])
      if (opts.noLive) return null
      return { header: id === header.id ? header : childHeader, snapshotEvents: () => at() }
    },
  }
  const controller = {
    fork: async (o) => { calls.push(['fork', o]); return opts.forkReturns !== undefined ? opts.forkReturns : { sessionId: 'child' } },
    create: async (o) => { calls.push(['create', o]); return opts.createReturns !== undefined ? opts.createReturns : { sessionId: 'blank' } },
    cancel: async (o) => { calls.push(['cancel', o]) },
    updateQueue: async (o) => { calls.push(['updateQueue', o]) },
  }
  if (opts.forkThrows) controller.fork = async (o) => { calls.push(['fork', o]); throw new Error('fork boom') }
  if (opts.noController) {
    delete controller.fork
    delete controller.create
  }
  const registry = {
    list: () => [{ id: 'ws-1', path: 'D:/w', sessionIds: [header.id] }],
    archiveSession: async (id) => { calls.push(['archive', id]) },
  }
  const services = {
    sessions,
    sessionController: controller,
    workspaceRegistry: registry,
    agents: opts.agents,
  }
  const ctx = {
    get: (name) => {
      calls.push(['get', name])
      return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined
    },
  }
  return { ctx, calls }
}

const labels = (calls) => calls.filter((c) => c[0] !== 'get' && c[0] !== 'sessions.get').map((c) => c[0])

/* ------------------------------------------------------------------ planRewind：once */

test('planRewind(once)：最后一个 step 之前切一刀，atSeq 是它前一条的 seq', () => {
  const events = [user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0), stepStart(3, 0, 1)]
  const plan = planRewind(events, 'once')
  assert.equal(plan.ok, true)
  assert.equal(plan.mode, 'fork')
  assert.equal(plan.unit, 'step')
  assert.equal(plan.atSeq, 2, '切在第二个 step 之前，也就是 seq 2')
  assert.equal(plan.fromSeq, 3)
  assert.equal(plan.turn, 0)
  assert.equal(plan.step, 1)
})

test('planRewind(once)：轮次里只有第一个 step 时，退到 turn/start 之前（整轮重来）', () => {
  const events = [user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0)]
  const plan = planRewind(events, 'once')
  assert.equal(plan.unit, 'step')
  assert.equal(plan.atSeq, 0, '第一个 step 退到 turn 起点之前')
  assert.equal(plan.fromSeq, 1)
})

test('planRewind(once)：没有 step 时退化成按轮处理（不会报 Nothing to undo）', () => {
  const events = [user(0, 'hello'), turnStart(1, 0)]
  const plan = planRewind(events, 'once')
  assert.equal(plan.ok, true)
  assert.equal(plan.unit, 'turn')
  assert.equal(plan.atSeq, 0)
})

test('planRewind(once)：第二轮的 step 不会退到第一轮去', () => {
  const events = [
    user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0), turnEnd(3, 0),
    user(4, 'b'), turnStart(5, 1), stepStart(6, 1, 0),
  ]
  const plan = planRewind(events, 'once')
  assert.equal(plan.atSeq, 4, '切在第二轮那句用户消息之前')
  assert.equal(plan.turn, 1)
})

/* ------------------------------------------------------------------ planRewind：round */

test('planRewind(round)：退到本轮 turn/start 之前，unit 恒为 turn', () => {
  const events = [user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0), stepStart(3, 0, 1)]
  const plan = planRewind(events, 'round')
  assert.equal(plan.ok, true)
  assert.equal(plan.unit, 'turn')
  assert.equal(plan.atSeq, 0)
  assert.equal(plan.fromSeq, 1)
})

test('planRewind(round)：轮次已结束时按 turn/end 反查本轮起点（不是退到更早的一轮）', () => {
  const events = [
    user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0), turnEnd(3, 0),
    user(4, 'b'), turnStart(5, 1), stepStart(6, 1, 0), turnEnd(7, 1),
  ]
  const plan = planRewind(events, 'round')
  assert.equal(plan.atSeq, 4)
  assert.equal(plan.fromSeq, 5)
})

test('planRewind(round)：完全没有 turn 事件时退到最后一条用户消息之前', () => {
  const events = [user(0, 'a'), user(1, 'b')]
  const plan = planRewind(events, 'round')
  assert.equal(plan.ok, true)
  assert.equal(plan.atSeq, 0)
  assert.equal(plan.text, 'b', '要重发的是最后那句')
})

test('planRewind：事件为空、或只有插件草稿时返回 Nothing to undo', () => {
  assert.deepEqual(planRewind([], 'once'), { ok: false, error: 'Nothing to undo' })
  assert.deepEqual(planRewind([], 'round'), { ok: false, error: 'Nothing to undo' })
  const draftOnly = [user(0, '[MNEMON] snapshot', { kind: 'plugin' })]
  assert.deepEqual(planRewind(draftOnly, 'round'), { ok: false, error: 'Nothing to undo' })
})

test('planRewind：切在第一行时没有更早的位置，走 blank（新建空白会话）而不是 fork', () => {
  const plan = planRewind([user(0, 'hello')], 'round')
  assert.equal(plan.mode, 'blank')
  assert.equal(plan.atSeq, undefined)
  assert.equal(plan.text, 'hello')
})

test('planRewind：mode 只认字面量 round，其余一律按 once 处理', () => {
  const events = [user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0), stepStart(3, 0, 1)]
  for (const mode of ['ROUND', 'Round', 'round ', '', null, undefined, 'step']) {
    assert.equal(planRewind(events, mode).unit, 'step', `${JSON.stringify(mode)} 应该按 once 处理`)
  }
})

/* ------------------------------------------------------------------ 文本抽取 */

test('lastHumanUserText：跳过插件草稿、取最后一条真人消息', () => {
  const events = [
    user(0, 'first'),
    user(1, '[MNEMON] runtime snapshot', { kind: 'plugin' }),
    user(2, 'second'),
  ]
  assert.equal(lastHumanUserText(events), 'second')
})

test('现状锁定：lastHumanUserText 不认 rewind 标记，isRoundPromptEvent 认', () => {
  /* 回退标记是一条 id 以 `rewind-` 开头的合成 user/message。
     `isRoundPromptEvent` 会把它排除，`isHumanUserEvent` 不会——两个判据对同一类事件
     给出了不同答案。目前仓库里没有任何地方真的造这种标记（全仓只有这一处判据），
     所以是休眠分支；真要启用标记注入，得先让 isHumanUserEvent 也排除它，
     否则「上次那句话」会变成标记里的占位文本。 */
  const events = [
    user(0, 'real text'),
    { seq: 1, type: 'user/message', data: { id: 'rewind-7', content: 'marker', source: { kind: 'user' } } },
  ]
  assert.equal(lastHumanUserText(events), 'marker', 'isHumanUserEvent 不查 rewind 标记')
  assert.equal(planRewind(events, 'round').text, 'real text', 'isRoundPromptEvent 查了，所以规划路径不受影响')
})

test('lastHumanUserText：文本像插件草稿时也跳过，即使 source 声称是 user（第二道闸）', () => {
  /* 真正的风险场景不是 source.kind==='plugin'（第一道闸就挡住了），
     而是草稿文本混进了没有 source、或 source 被写成 user 的消息里。
     那时只有 isPluginDraft 这层正则能拦住它——拦不住的话，
     「上次那句话」会变成一整段 MNEMON 快照，回退后往输入框里塞的就是它。 */
  const events = [
    user(0, 'real question'),
    { seq: 1, type: 'user/message', data: { content: '[MNEMON] runtime snapshot ...' } },
  ]
  assert.equal(lastHumanUserText(events), 'real question')

  const second = [
    user(0, 'real question'),
    { seq: 1, type: 'user/message', data: { content: 'text\nMNEMON RUNTIME MEMORY SNAPSHOT\n...', source: { kind: 'user' } } },
  ]
  assert.equal(lastHumanUserText(second), 'real question')

  const third = [
    user(0, 'real question'),
    { seq: 1, type: 'user/message', data: { content: 'MNEMON VIEW TOOLS\nls', source: { kind: 'user' } } },
  ]
  assert.equal(lastHumanUserText(third), 'real question')
})

test('lastHumanUserText：内容是多段 block 时按 text 拼接，非 text 段丢掉', () => {
  const events = [{
    seq: 0,
    type: 'user/message',
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello ' }, { type: 'image' }, { text: 'world' }, 'plain'],
    },
  }]
  assert.equal(lastHumanUserText(events), 'hello worldplain')
})

test('lastHumanUserText：goal 轮次也算「真正发出去的那句」，但 lastHumanUserText 只认 user', () => {
  const goalOnly = [user(0, 'goal text', { kind: 'goal', round: 0 })]
  assert.equal(lastHumanUserText(goalOnly), '', 'goal 不算真人手打')
  /* 但 planRewind 认它——goal 每一轮也是「发出去的一句」。 */
  assert.equal(planRewind(goalOnly, 'round').text, 'goal text')
})

test('lastHumanUserText：goal 缺少 round 或 round 为负时不算，避免把系统消息当成用户的话', () => {
  assert.equal(planRewind([user(0, 'x', { kind: 'goal' })], 'round').ok, false)
  assert.equal(planRewind([user(0, 'x', { kind: 'goal', round: -1 })], 'round').ok, false)
  assert.equal(planRewind([user(0, 'x', { kind: 'goal', round: 3 })], 'round').text, 'x')
})

/* ------------------------------------------------------------------ 收件箱与子会话 */

test('pendingInboxInserts：只收最后一次 turn/end 之后、且还没开新一轮的 next-turn 插入，去重保序', () => {
  const events = [
    { seq: 0, type: 'turn/end', data: {} },
    { seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [{ id: 'm1' }, { id: 'm2' }] } },
    { seq: 2, type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [{ id: 'm3' }] } },
    { seq: 3, type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [{ id: 'm2' }, { id: 'm4' }] } },
  ]
  assert.deepEqual(pendingInboxInserts(events), ['m1', 'm2', 'm4'], 'next-step 不收，重复 id 只留第一次')
})

test('pendingInboxInserts：新一轮开始之后才插入的不算（那已经是新一轮的收件箱）', () => {
  const events = [
    { seq: 0, type: 'turn/end', data: {} },
    { seq: 1, type: 'turn/start', data: {} },
    { seq: 2, type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [{ id: 'new' }] } },
  ]
  assert.deepEqual(pendingInboxInserts(events), [])
})

test('pendingInboxInserts：最后一次 turn/end 之前插入的整批不算（那是上一轮已经用掉的）', () => {
  /* 窗口下界是 lastEnd。去掉它，函数会把整段历史里的 next-turn 插入全部翻出来，
     回退后草稿里会塞进几十条早就不相干的排队消息。 */
  const events = [
    { seq: 0, type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [{ id: 'ancient-1' }, { id: 'ancient-2' }] } },
    { seq: 1, type: 'turn/start', data: {} },
    { seq: 2, type: 'turn/end', data: {} },
    { seq: 3, type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [{ id: 'fresh' }] } },
  ]
  assert.deepEqual(pendingInboxInserts(events), ['fresh'])
})

test('现状锁定：新一轮开始之前插入的仍被算作待发（已消费的也可能被回退时重发）', () => {
  /* 窗口是「最后一次 turn/end 之后、最后一次 turn/start 之前」。
     新一轮已经起来时，落在 start 之前的那条其实已经被这一轮读走了，
     但函数照样返回它——回退时会把它连同本轮一起重发一次。
     这条不改的理由：它只影响「回退后草稿里多一句」，而放宽/收紧窗口都可能
     让真正待发的那条漏掉，属于产品取舍，不是本轮补测试的范围。 */
  const events = [
    { seq: 0, type: 'turn/end', data: {} },
    { seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [{ id: 'old' }] } },
    { seq: 2, type: 'turn/start', data: {} },
  ]
  assert.deepEqual(pendingInboxInserts(events), ['old'])
})

test('pendingInboxInserts：非数组输入返回空数组，不抛错', () => {
  assert.deepEqual(pendingInboxInserts(null), [])
  assert.deepEqual(pendingInboxInserts(undefined), [])
  assert.deepEqual(pendingInboxInserts({}), [])
})

test('lastTurnSubagentIds：从最后一个 turn/start 起收集 catalog 与 descriptor 的子会话 id', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: {} },
    { seq: 1, type: 'subagent/catalog', data: { childId: 'old' } },
    { seq: 2, type: 'turn/end', data: {} },
    { seq: 3, type: 'turn/start', data: {} },
    { seq: 4, type: 'subagent/catalog', data: { childId: 'kid-1' } },
    { seq: 5, type: 'subagent/descriptor', data: { sessionId: 'kid-2' } },
    { seq: 6, type: 'subagent/descriptor', data: { id: 'kid-3' } },
    { seq: 7, type: 'subagent/catalog', data: { childId: 'kid-1' } },
  ]
  assert.deepEqual(lastTurnSubagentIds(events), ['kid-1', 'kid-2', 'kid-3'])
})

test('lastTurnSubagentIds：显式 fromSeq 优先于「找最后一个 turn/start」，没有 turn 事件时返回空', () => {
  const events = [
    { seq: 0, type: 'subagent/catalog', data: { childId: 'a' } },
    { seq: 5, type: 'subagent/catalog', data: { childId: 'b' } },
  ]
  assert.deepEqual(lastTurnSubagentIds(events), [], '没有 turn/start 时无从判断「最后一轮」')
  assert.deepEqual(lastTurnSubagentIds(events, 0), ['a', 'b'])
  assert.deepEqual(lastTurnSubagentIds(events, 5), ['b'])
})

test('invocationSessionId：三条取值路径与两种空值', () => {
  assert.equal(invocationSessionId({ agent: { session: { id: 's1' } } }), 's1')
  assert.equal(invocationSessionId({ agent: { sessionId: 's2' } }), 's2')
  assert.equal(invocationSessionId({ agent: { session: { header: { id: 's3' } } } }), 's3')
  assert.equal(invocationSessionId({}), undefined)
  assert.equal(invocationSessionId(null), undefined)
})

/* ------------------------------------------------------------------ applyRewind：四条落地路径 */

test('applyRewind(once)：有更早位置时 fork，atSeq 走官方边界校正，随后把源会话归档', async () => {
  const sid = freshSession()
  const events = [user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0), turnEnd(3, 0)]
  const { ctx, calls } = mkCtx(events, { header: { id: sid, cwd: 'D:/w' }, childHeader: { id: 'child' } })
  const out = await applyRewind(ctx, sid, 'once')
  assert.equal(out.ok, true)
  assert.equal(out.sessionId, 'child')
  assert.equal(out.parentId, sid)
  assert.equal(out.mode, 'once')
  assert.equal(out.cut, 'step')
  assert.equal(out.archived, true)
  assert.deepEqual(labels(calls), ['fork', 'archive'], '先 fork 再归档源会话')
  assert.deepEqual(calls.find((c) => c[0] === 'fork')[1], { sessionId: sid, atSeq: 0 })
})

test('applyRewind(once)：切在第一行时新建空白会话（不带 fork），并把原话记成草稿', async () => {
  const sid = freshSession()
  const { ctx, calls } = mkCtx([user(0, 'hello')], { header: { id: sid, cwd: 'D:/w' } })
  const out = await applyRewind(ctx, sid, 'once')
  assert.equal(out.ok, true)
  assert.equal(out.sessionId, 'blank')
  assert.equal(out.text, 'hello')
  assert.equal(out.cut, 'turn')
  assert.deepEqual(labels(calls), ['create', 'archive'])
  /* 空白会话要落进有工作区的那条 create 分支。 */
  assert.deepEqual(calls.find((c) => c[0] === 'create')[1], { workspaceId: 'ws-1' })
})

test('applyRewind(round)：连带把本轮的子会话取消并归档（否则子会话还在后台跑）', async () => {
  const sid = freshSession()
  const events = [
    user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0),
    { seq: 3, type: 'subagent/catalog', data: { childId: 'kid-1' } },
    { seq: 4, type: 'subagent/descriptor', data: { sessionId: 'kid-2' } },
    turnEnd(5, 0),
  ]
  const { ctx, calls } = mkCtx(events, { header: { id: sid, cwd: 'D:/w' } })
  const out = await applyRewind(ctx, sid, 'round')
  assert.equal(out.ok, true)
  assert.equal(out.mode, 'round')
  assert.equal(out.cut, 'turn')
  assert.deepEqual(labels(calls), ['fork', 'archive', 'cancel', 'archive', 'cancel', 'archive'])
  assert.deepEqual(calls.filter((c) => c[0] === 'cancel').map((c) => c[1].sessionId), ['kid-1', 'kid-2'])
})

test('applyRewind：宿主没有 fork/create 时明确报「没有回退 API」，不静默失败', async () => {
  const sid = freshSession()
  const { ctx } = mkCtx([user(0, 'a')], { header: { id: sid }, noController: true })
  const out = await applyRewind(ctx, sid, 'once')
  assert.deepEqual(out, { ok: false, error: 'This dsh build has no session rewind API.' })
})

test('applyRewind：会话 id 为空时直接拒绝（不读盘、不建会话）', async () => {
  const { ctx, calls } = mkCtx([user(0, 'a')])
  assert.deepEqual(await applyRewind(ctx, '', 'once'), { ok: false, error: 'No active session' })
  assert.deepEqual(await applyRewind(ctx, null, 'round'), { ok: false, error: 'No active session' })
  assert.deepEqual(labels(calls), [])
})

/* ------------------------------------------------------------------ applyRewind：异常与边界 */

test('applyRewind：seq 不连续时官方 fork 边界算不出来，报 Nothing to undo 而不是切错位置', async () => {
  const sid = freshSession()
  const events = [user(5, 'x'), turnStart(6, 0), stepStart(7, 0, 0), turnEnd(8, 0)]
  const { ctx, calls } = mkCtx(events, { header: { id: sid } })
  const out = await applyRewind(ctx, sid, 'once')
  assert.deepEqual(out, { ok: false, error: 'Nothing to undo' })
  assert.deepEqual(labels(calls), [], '不 fork 也不归档')
})

test('applyRewind：fork 抛错时把原因透出来（不是「失败了」这种废话）', async () => {
  const sid = freshSession()
  const events = [user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0), turnEnd(3, 0)]
  const { ctx } = mkCtx(events, { header: { id: sid }, forkThrows: true })
  assert.deepEqual(await applyRewind(ctx, sid, 'once'), { ok: false, error: 'fork boom' })
})

test('applyRewind：fork 返回空值时明确说「没建成回退会话」，不能返回 ok:true', async () => {
  const sid = freshSession()
  const events = [user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0), turnEnd(3, 0)]
  const { ctx } = mkCtx(events, { header: { id: sid }, forkReturns: null })
  assert.deepEqual(await applyRewind(ctx, sid, 'once'), { ok: false, error: 'Failed to create the rewound session' })
})

test('applyRewind：fork 直接返回字符串 id 也认（宿主两种返回形态都出现过）', async () => {
  const sid = freshSession()
  const events = [user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0), turnEnd(3, 0)]
  const { ctx } = mkCtx(events, { header: { id: sid }, forkReturns: 'str-id' })
  const out = await applyRewind(ctx, sid, 'once')
  assert.equal(out.ok, true)
  assert.equal(out.sessionId, 'str-id')
})

test('applyRewind：轮次还在跑时先 cancel，等它关掉再继续（用户不必先点停止）', async () => {
  const sid = freshSession()
  const open = [user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0)]
  const closed = [...open, turnEnd(3, 0)]
  let reads = 0
  const { ctx, calls } = mkCtx(() => (reads++ === 0 ? open : closed), { header: { id: sid } })
  const out = await applyRewind(ctx, sid, 'once')
  assert.equal(out.ok, true)
  assert.ok(reads >= 3, '要重新读盘确认轮次已关闭')
  assert.deepEqual(calls.find((c) => c[0] === 'cancel')[1], { sessionId: sid })
})

test('applyRewind：同一个会话的两次调用被串行化（并发点两次不会各建一个会话）', async () => {
  const sid = freshSession()
  const events = [user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0), turnEnd(3, 0)]
  const order = []
  const { ctx } = mkCtx(events, { header: { id: sid } })
  const controller = ctx.get('sessionController')
  let n = 0
  controller.fork = async () => {
    const id = `c${(n += 1)}`
    order.push(`start:${id}`)
    await new Promise((r) => setTimeout(r, 20))
    order.push(`end:${id}`)
    return { sessionId: id }
  }
  const [a, b] = await Promise.all([applyRewind(ctx, sid, 'once'), applyRewind(ctx, sid, 'once')])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.notEqual(a.sessionId, b.sessionId, '两次都要真的 fork，但必须一前一后')
  assert.deepEqual(order, ['start:c1', 'end:c1', 'start:c2', 'end:c2'], '第二个 fork 不能插到第一个中间')
})

test('applyRewind(round)：在子会话上调用时回到主会话，并把子会话取消掉', async () => {
  const mainId = freshSession()
  const kidId = `${mainId}-kid`
  const events = [user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0), turnEnd(3, 0)]
  const calls = []
  const ctx = {
    get: (name) => {
      calls.push(['get', name])
      if (name === 'sessions') {
        return {
          get: (id) => ({
            header: id === kidId
              ? { id: kidId, origin: 'subagent', parentSession: mainId }
              : { id: mainId, cwd: 'D:/w' },
            snapshotEvents: () => events,
          }),
        }
      }
      if (name === 'sessionController') {
        return {
          fork: async (o) => { calls.push(['fork', o.sessionId]); return { sessionId: 'child' } },
          create: async () => { calls.push(['create']); return { sessionId: 'blank' } },
          cancel: async (o) => { calls.push(['cancel', o.sessionId]) },
        }
      }
      if (name === 'workspaceRegistry') return { list: () => [] }
      return undefined
    },
  }
  const out = await applyRewind(ctx, kidId, 'round')
  assert.equal(out.ok, true)
  assert.equal(out.sourceId, kidId, '返回里要记清是从哪个会话发起的')
  assert.equal(out.parentId, mainId, '真正被回退的是主会话')
  assert.ok(calls.some((c) => c[0] === 'fork' && c[1] === mainId))
  assert.ok(calls.some((c) => c[0] === 'cancel' && c[1] === kidId), '子会话要取消')
})

/* ------------------------------------------------------------------ 草稿：回退后「那句」要能直接重发 */

test('草稿：回退后 getDraft 拿得到、getPending 也指向它、takeDraft 只能取一次', async () => {
  const sid = freshSession()
  const { ctx } = mkCtx([user(0, '要重发的话')], { header: { id: sid, cwd: 'D:/w' } })
  const out = await applyRewind(ctx, sid, 'once')
  const childId = out.sessionId

  const draft = getDraft(childId)
  assert.equal(draft.text, '要重发的话')
  assert.equal(draft.parentId, sid)
  assert.equal(getPending().sessionId, childId, '面板的「上次回退」要指向同一条')

  assert.deepEqual(takeDraft(childId), draft)
  assert.equal(getDraft(childId), null, '取走之后不能再给第二遍，否则会重复发送')
})

test('草稿：未知会话返回 null，空 id 也不抛错', () => {
  assert.equal(getDraft('never-seen'), null)
  assert.equal(getDraft(''), null)
  assert.equal(getDraft(undefined), null)
  assert.equal(takeDraft('never-seen'), null)
})

/* ------------------------------------------------------------------ 读盘三条路径 */

test('读盘：live session 的 snapshotEvents 优先（不碰 controller 与 sessionQuery）', async () => {
  const { ctx, calls } = mkCtx([user(0, 'hi')])
  const out = await readLastUserText(ctx, 's1')
  assert.deepEqual(out, { ok: true, text: 'hi' })
  assert.ok(!calls.some((c) => c[0] === 'get' && (c[1] === 'sessionQuery' || c[1] === 'sessionController')))
})

test('读盘：没有 live session 时退到 controller.inspect，meta 与 header 两种形状都认', async () => {
  const events = [user(0, 'from inspect')]
  const mk = (payload) => ({
    get: (name) => (name === 'sessions' ? { get: () => null }
      : name === 'sessionController' ? { inspect: async () => payload }
        : undefined),
  })
  assert.deepEqual(await readLastUserText(mk({ events, meta: { cwd: 'D:/w' } }), 's1'), { ok: true, text: 'from inspect' })
  assert.deepEqual(await readLastUserText(mk({ events, header: { cwd: 'D:/w' } }), 's1'), { ok: true, text: 'from inspect' })
})

test('读盘：再退到 sessionQuery.observeSession，并且一定要 dispose（否则每次读都漏一个观察者）', async () => {
  let disposed = 0
  const ctx = {
    get: (name) => (name === 'sessionQuery' ? {
      observeSession: async () => ({
        events: [user(0, 'from query')],
        header: { cwd: 'D:/w' },
        [Symbol.dispose]: () => { disposed += 1 },
      }),
    } : undefined),
  }
  assert.deepEqual(await readLastUserText(ctx, 's1'), { ok: true, text: 'from query' })
  assert.equal(disposed, 1)
})

test('读盘：三条路都走不通时报「找不到当前会话」，readLastUserText 与 analyzeRewind 各自包装成 ok:false', async () => {
  const ctx = { get: () => undefined }
  assert.deepEqual(await readLastUserText(ctx, 's1'), { ok: false, text: '', error: 'Cannot find the current session' })
  assert.deepEqual(await analyzeRewind(ctx, 's1'), { ok: false, error: 'Cannot find the current session' })
})

/* ------------------------------------------------------------------ analyzeRewind */

test('analyzeRewind：主会话报本轮子会话，子会话自己报 kind=subagent 且不带子会话列表', async () => {
  const events = [
    user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0),
    { seq: 3, type: 'subagent/catalog', data: { childId: 'kid-1' } },
    turnEnd(4, 0),
  ]
  const { ctx } = mkCtx(events, { header: { id: 's1' } })
  assert.deepEqual(await analyzeRewind(ctx, 's1'), {
    ok: true, kind: 'main', sessionId: 's1', hasSubagents: true, subagentIds: ['kid-1'],
  })

  const kidCtx = {
    get: (name) => (name === 'sessions' ? {
      get: () => ({ header: { id: 'kid', origin: 'subagent', parentSession: 's1' }, snapshotEvents: () => events }),
    } : undefined),
  }
  assert.deepEqual(await analyzeRewind(kidCtx, 'kid'), {
    ok: true, kind: 'subagent', sessionId: 'kid', hasSubagents: false, subagentIds: [],
  })
})

test('analyzeRewind：delegationDepth 也算子会话（origin 缺失时的第二种判据）', async () => {
  const ctx = {
    get: (name) => (name === 'sessions' ? {
      get: () => ({ header: { id: 'kid', delegationDepth: 2 }, snapshotEvents: () => [] }),
    } : undefined),
  }
  assert.equal((await analyzeRewind(ctx, 'kid')).kind, 'subagent')
})

test('analyzeRewind：没有会话 id 时直接拒绝', async () => {
  assert.deepEqual(await analyzeRewind({}, ''), { ok: false, error: 'No active session' })
})
