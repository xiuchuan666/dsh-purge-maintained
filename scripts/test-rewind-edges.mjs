/**
 * `/rewind` 的三条「静默失败」路径：等轮次关闭、清 inbox、同一会话排队。
 *
 * 为什么单独一个文件、而不是并进 `test-rewind.mjs`：那个文件原来在第 10 条之后
 * 写着「这两件事要真等，不适合放进每次提交都跑的套件」——`waitTurnClosed` 的 8 秒
 * 超时与草稿 10 分钟过期。这一批把超时改成**参数注入**（`timeoutMs`）之后就不再需要
 * 真等 8 秒，于是把三条路径都搬进守卫：
 *
 *   1. `waitTurnClosed` 超时抛什么、超时前读了几次盘（读太多次 = 忙等，读太少 = 卡死）；
 *   2. `disarmRewoundSession` 到底 cancel 了没有、inbox 里的消息有没有逐条摘掉
 *      —— 漏摘的表现是「回退之后新会话自己往下跑」，用户看到的是「我什么都没发，它自己又答了」；
 *   3. `rewindOneSession` 的串行锁：同一会话连点两次 `/rewind`，第二次必须等第一次落地；
 *      第一次抛错时第二次**仍然要跑**（锁的 onRejected 分支，删掉它第二次就永远卡住）。
 *
 * `DRAFT_TTL_MS` 那条仍然不测：`Date.now` 在模块里直接调用，要测只能改全局计时器，
 * 而那会把同一进程里其他用例的时间判断一起改掉（`node --test` 是同进程跑一个文件）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  asEventList,
  disarmRewoundSession,
  rewindOneSession,
  waitTurnClosed,
} from '../lib/rewind.js'

/* ------------------------------------------------------------------ 事件构造器 */

const user = (seq, text) => ({ seq, type: 'user/message', data: { content: text, source: { kind: 'user' } } })
const turnStart = (seq, turn) => ({ seq, type: 'turn/start', data: { turn } })
const turnEnd = (seq, turn) => ({ seq, type: 'turn/end', data: { turn } })
const stepStart = (seq, turn, step) => ({ seq, type: 'step/start', data: { turn, step } })

const OPEN = [user(0, 'a'), turnStart(1, 0)]
const CLOSED_AFTER_SLEEP = [OPEN, [...OPEN, turnEnd(2, 0)]]

/* ------------------------------------------------------------------ 假宿主 */

/** 只实现这些路径用到的四个服务。`reads` 记「读了几次盘」。 */
function mkCtx(opts = {}) {
  const calls = []
  let reads = 0
  const events = opts.events
  const agent = opts.agent
  const ctx = {
    get: (name) => {
      calls.push(['get', name])
      if (opts.noServices) return undefined
      if (name === 'sessions') {
        if (opts.sessionsThrows) {
          return {
            get: () => {
              throw new Error('sessions boom')
            },
          }
        }
        return {
          get: () => {
            reads += 1
            return {
              header: opts.header || { id: 's1', cwd: 'D:/w' },
              snapshotEvents: () => (typeof events === 'function' ? events(reads) : events),
            }
          },
        }
      }
      if (name === 'sessionController') {
        return opts.controller === null
          ? undefined
          : {
              updateQueue: async (o) => {
                calls.push(['updateQueue', o.itemId])
                if (opts.updateQueueThrows && o.itemId === 'a') throw new Error('queue boom')
              },
            }
      }
      if (name === 'agents') return { get: () => agent }
      return undefined
    },
  }
  return { ctx, calls, readsNow: () => reads }
}

function mkAgent({ phase = 'running', inbox, cancelThrows = false, inboxThrows = false } = {}) {
  const calls = []
  const agent = {
    phase: { kind: phase, abort: () => {} },
    cancel: async (a, b) => {
      calls.push(['cancel', a, b])
      if (cancelThrows) throw new Error('cancel boom')
    },
  }
  if (inboxThrows) {
    Object.defineProperty(agent, 'inbox', {
      get() {
        throw new Error('inbox boom')
      },
    })
  } else {
    agent.inbox = inbox || { nextTurn: [], nextStep: [] }
  }
  return { agent, calls }
}

/* ------------------------------------------------------------------ asEventList */

test('asEventList：数组原样返回（同一个引用，不做拷贝）', () => {
  const events = [{ seq: 0 }]
  assert.equal(asEventList(events), events)
})

test('asEventList：Set 与生成器都被摊成数组', () => {
  assert.deepEqual(asEventList(new Set([1, 2])), [1, 2])
  function* gen() {
    yield 3
    yield 4
  }
  assert.deepEqual(asEventList(gen()), [3, 4])
})

test('asEventList：可迭代但迭代中途抛错时吞掉，返回空数组（不是把异常抛给调用方）', () => {
  const broken = {
    [Symbol.iterator]() {
      return {
        next() {
          throw new Error('iterate boom')
        },
      }
    },
  }
  assert.deepEqual(asEventList(broken), [])
})

test('asEventList：null / 数字 / 普通对象一律空数组；字符串因为可迭代会被拆成字符（现状）', () => {
  for (const value of [null, undefined, 42, {}, true]) {
    assert.deepEqual(asEventList(value), [], `${String(value)} 应该是空数组`)
  }
  assert.deepEqual(asEventList('ab'), ['a', 'b'], '字符串是可迭代的，现状会拆字符')
})

/* ------------------------------------------------------------------ waitTurnClosed */

test('waitTurnClosed：轮次一直开着就抛固定文案，且中间真的去读盘（不是干等）', async () => {
  const { ctx, readsNow } = mkCtx({ events: OPEN })
  const started = Date.now()
  await assert.rejects(
    () => waitTurnClosed(ctx, 's1', 120),
    /^Error: The turn is still running\. Click Stop first, then undo\.$/,
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 120, `应该等满 120ms，实得 ${elapsed}ms`)
  assert.ok(readsNow() >= 2, `至少读两次盘（初读 + 睡醒后重读），实得 ${readsNow()}`)
})

test('waitTurnClosed：睡一觉之后轮次关了，返回的就是那份关掉的日志', async () => {
  const { ctx, readsNow } = mkCtx({ events: (n) => CLOSED_AFTER_SLEEP[Math.min(n - 1, 1)] })
  const log = await waitTurnClosed(ctx, 's1', 5000)
  assert.equal(readsNow(), 2, '第一次读到「开着」、睡完再读一次就够')
  assert.equal(log.events.at(-1).type, 'turn/end')
})

test('waitTurnClosed：一开始就没有开着的轮次，只读一次盘、不睡', async () => {
  const { ctx, readsNow } = mkCtx({ events: [turnStart(0, 0), turnEnd(1, 0)] })
  const log = await waitTurnClosed(ctx, 's1', 5000)
  assert.equal(readsNow(), 1)
  assert.equal(log.events.length, 2)
})

test('waitTurnClosed：sessions 服务自己抛错时原样冒泡（不吞、也不改写成别的文案）', async () => {
  const { ctx } = mkCtx({ sessionsThrows: true })
  await assert.rejects(() => waitTurnClosed(ctx, 's1', 200), /sessions boom/)
})

test('waitTurnClosed：三个读盘服务一个都没有时才报「Cannot find the current session」', async () => {
  /* 三条读盘路（sessions / sessionController.inspect / sessionQuery.observeSession）全落空
     才是「找不到会话」；上面的用例证明前者的失败不会被这条兜底文案吃掉。 */
  await assert.rejects(() => waitTurnClosed(mkCtx({ noServices: true }).ctx, 's1', 200), /^Error: Cannot find the current session$/)
})

/* ------------------------------------------------------------------ disarmRewoundSession */

test('disarmRewoundSession：默认会 cancel 正在跑的 agent，并且 keepInbox', async () => {
  const { agent, calls } = mkAgent({ phase: 'running' })
  const { ctx } = mkCtx({ events: [], agent })
  await disarmRewoundSession(ctx, 's1')
  assert.deepEqual(calls, [['cancel', { kind: 'user' }, { keepInbox: true }]])
})

test('disarmRewoundSession：cancel:false 时即使 agent 还在跑也一个都不 cancel（fork 出来的新会话走这条）', async () => {
  /* 为什么这条重要：fork 之后 abort 再发消息会走官方的 wakingAfterAbort，等于把
     「用户刚回退、还没说话」变成「它自己又开始答」——所以 doRewindOneSession 传的是 cancel:false。 */
  const { agent, calls } = mkAgent({ phase: 'running' })
  const { ctx } = mkCtx({ events: [], agent })
  await disarmRewoundSession(ctx, 's1', { cancel: false })
  assert.deepEqual(calls, [])
})

test('disarmRewoundSession：agent 已经 idle 就不 cancel', async () => {
  const { agent, calls } = mkAgent({ phase: 'idle' })
  const { ctx } = mkCtx({ events: [], agent })
  await disarmRewoundSession(ctx, 's1')
  assert.deepEqual(calls, [])
})

test('disarmRewoundSession：inbox 里的 nextTurn / nextStep 去重后逐条摘掉，空 id 跳过', async () => {
  const { agent } = mkAgent({
    phase: 'idle',
    inbox: { nextTurn: [{ id: 'a' }, { id: 'a' }, {}], nextStep: [{ id: 'b' }] },
  })
  const { ctx, calls } = mkCtx({ events: [], agent })
  await disarmRewoundSession(ctx, 's1')
  assert.deepEqual(calls.filter((c) => c[0] === 'updateQueue'), [
    ['updateQueue', 'a'],
    ['updateQueue', 'b'],
  ])
})

test('disarmRewoundSession：日志里插进去待发的那几条也一起摘（不只看 agent.inbox）', async () => {
  const events = [
    turnEnd(0, 0),
    { seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [{ id: 'q1' }, { id: 'q2' }] } },
  ]
  const { agent } = mkAgent({ phase: 'idle' })
  const { ctx, calls } = mkCtx({ events, agent })
  await disarmRewoundSession(ctx, 's1')
  assert.deepEqual(calls.filter((c) => c[0] === 'updateQueue'), [
    ['updateQueue', 'q1'],
    ['updateQueue', 'q2'],
  ])
})

test('disarmRewoundSession：某一条摘不掉不影响后面几条（每条各自 try）', async () => {
  const { agent } = mkAgent({ phase: 'idle', inbox: { nextTurn: [{ id: 'a' }, { id: 'b' }], nextStep: [] } })
  const { ctx, calls } = mkCtx({ events: [], agent, updateQueueThrows: true })
  await disarmRewoundSession(ctx, 's1')
  assert.deepEqual(calls.filter((c) => c[0] === 'updateQueue'), [
    ['updateQueue', 'a'],
    ['updateQueue', 'b'],
  ])
})

test('disarmRewoundSession：cancel 同步抛错时也不外泄（真服务可能不是 async）', async () => {
  /* 为什么单开一条：`agent.cancel` 是宿主给的方法，真实现可能是同步抛（不是 rejected promise）。
     异步抛错由 ignoreSettled 兜，同步抛错只能靠外面那层 try —— 两层都在才都安全。 */
  const calls = []
  const agent = {
    phase: { kind: 'running', abort: () => {} },
    cancel: () => {
      calls.push('cancel')
      throw new Error('sync cancel boom')
    },
    inbox: { nextTurn: [], nextStep: [] },
  }
  const { ctx } = mkCtx({ events: [], agent })
  await disarmRewoundSession(ctx, 's1')
  assert.deepEqual(calls, ['cancel'], '确实调了 cancel，且异常没有冒出去')
})

test('disarmRewoundSession：cancel 抛错、读日志抛错、读 inbox 抛错，三条都被吞掉不外泄', async () => {
  const { agent } = mkAgent({ phase: 'running', cancelThrows: true, inboxThrows: true })
  const { ctx } = mkCtx({ events: [], agent })
  await disarmRewoundSession(ctx, 's1')
  await disarmRewoundSession(mkCtx({ sessionsThrows: true, agent }).ctx, 's1', { cancel: false })
})

test('disarmRewoundSession：没有 sessionId 就立刻返回，一个服务都不碰', async () => {
  const { ctx, calls } = mkCtx({ events: [] })
  await disarmRewoundSession(ctx, '')
  assert.deepEqual(calls, [])
})

/* ------------------------------------------------------------------ rewindOneSession 串行锁 */

const REWINDABLE = [user(0, 'a'), turnStart(1, 0), stepStart(2, 0, 0), stepStart(3, 0, 1), turnEnd(4, 0)]

function mkRewindCtx({ forkDelay = 0, failFirstFork = false } = {}) {
  const calls = []
  let forks = 0
  const controller = {
    fork: async () => {
      forks += 1
      calls.push(['fork:start', forks])
      if (failFirstFork && forks === 1) throw new Error('fork boom')
      if (forkDelay) await new Promise((r) => setTimeout(r, forkDelay))
      calls.push(['fork:end', forks])
      return { sessionId: `child-${forks}` }
    },
    create: async () => ({ sessionId: 'blank' }),
    cancel: async () => {},
    updateQueue: async () => {},
  }
  const ctx = {
    get: (name) => {
      if (name === 'sessions') {
        return { get: () => ({ header: { id: 's1', cwd: 'D:/w' }, snapshotEvents: () => REWINDABLE }) }
      }
      if (name === 'sessionController') return controller
      if (name === 'workspaceRegistry') return { list: () => [], archiveSession: async () => {} }
      if (name === 'agents') return { get: () => undefined }
      return undefined
    },
  }
  return { ctx, controller, calls }
}

test('rewindOneSession：同一会话连点两次，第二次必须等第一次 fork 完成（期间不并发）', async () => {
  const { ctx, controller, calls } = mkRewindCtx({ forkDelay: 60 })
  const first = rewindOneSession(ctx, controller, 's1', { mode: 'once' })
  const second = rewindOneSession(ctx, controller, 's1', { mode: 'once' })
  const [r1, r2] = await Promise.all([first, second])
  assert.deepEqual(calls, [
    ['fork:start', 1],
    ['fork:end', 1],
    ['fork:start', 2],
    ['fork:end', 2],
  ])
  assert.deepEqual([r1.sessionId, r2.sessionId], ['child-1', 'child-2'])
})

test('rewindOneSession：第一次抛错时第二次仍然要跑（锁的 onRejected 分支，删掉它第二次会永远卡住）', async () => {
  const { ctx, controller, calls } = mkRewindCtx({ failFirstFork: true })
  const first = rewindOneSession(ctx, controller, 's1', { mode: 'once' })
  const second = rewindOneSession(ctx, controller, 's1', { mode: 'once' })
  const settled = await Promise.allSettled([first, second])
  assert.equal(settled[0].status, 'rejected')
  assert.equal(settled[1].status, 'fulfilled')
  assert.equal(settled[1].value.ok, true)
  assert.deepEqual(calls, [
    ['fork:start', 1],
    ['fork:start', 2],
    ['fork:end', 2],
  ])
})

test('rewindOneSession：第一次失败之后锁被清掉，紧接着再调一次照常执行', async () => {
  const { ctx, controller } = mkRewindCtx({ failFirstFork: true })
  const first = rewindOneSession(ctx, controller, 's1', { mode: 'once' })
  await assert.rejects(() => first, /fork boom/)
  const again = await rewindOneSession(ctx, controller, 's1', { mode: 'once' })
  assert.equal(again.ok, true)
  assert.equal(again.sessionId, 'child-2')
})

test('rewindOneSession：sessionId 为空时不进锁，直接执行一次', async () => {
  const { ctx, controller, calls } = mkRewindCtx({})
  const r = await rewindOneSession(ctx, controller, '', { mode: 'once' })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, [
    ['fork:start', 1],
    ['fork:end', 1],
  ])
})

/* ------------------------------------------------------------------ 源码形状 */

test('源码形状：锁的两条分支各自都要清 map，且判据是「还是我这一条」（不是无条件 delete）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/rewind.js', import.meta.url), 'utf8')
  const purge = src.match(/if \(rewindLocks\.get\(key\) === next\) rewindLocks\.delete\(key\);/g) || []
  assert.equal(purge.length, 2, '串行锁成功/失败两条分支各要清一次')
  assert.ok(!/rewindLocks\.delete\(key\)\s*;?\s*\n\s*rewindLocks\.set/.test(src), '不许无条件 delete 后再 set')
})
