// 红队工具集「从哪找到 @deepseek-ai/dsh-tools」的解析链，以及子智能体结束时
// 自动释放并发名额的那段 effect。
//
// 为什么值得单独一个文件：这两个东西坏了都没有报错。
//   · 解析链错了 → `loadDefineTool()` 抛错 → 整份「红队模式」预设被下拉过滤，
//     用户看到的是「红队模式不见了」，日志里只有一行 cannot resolve。
//   · 自动释放错了 → 名额只增不减，第三次派活就被「并发已满」拒掉，
//     表现是「用着用着就不能派智能体了」，重启才好。
//
// 解析链覆盖四种布局（npm 全局 / profile / 桌面解包 / app.asar.unpacked），
// 每一种在宿主升级时都可能挪位，所以这里钉的是**顺序与条数**，不是「能不能找到」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addCandidate,
  considerBin,
  defineToolCandidates,
  loadDefineTool,
  apply,
} from '../lib/redteam/tools.js'

const SRC = readFileSync(new URL('../lib/redteam/tools.js', import.meta.url), 'utf8')

/* ==================================================== addCandidate */

test('addCandidate：空值不写，反斜杠归一成 /，同一个路径只留一份', () => {
  const list = []
  addCandidate(list, 'C:\\a\\b\\package.json')
  addCandidate(list, 'C:\\a\\b\\package.json')
  addCandidate(list, '')
  addCandidate(list, null)
  addCandidate(list, undefined)
  assert.deepEqual(list, ['C:/a/b/package.json'])
})

test('addCandidate：去重只归一分隔符，不归一大小写（现状：C: 与 c: 会各留一条）', () => {
  const list = []
  addCandidate(list, 'C:\\x\\package.json')
  addCandidate(list, 'C:/x/package.json')
  assert.deepEqual(list, ['C:/x/package.json'], '两种分隔符写法必须折成一条')

  const cased = []
  addCandidate(cased, 'C:/x/package.json')
  addCandidate(cased, 'c:/x/package.json')
  assert.equal(cased.length, 2, '现状锁定：大小写不同算两条 —— Windows 上是同一个目录，代价只是多试一次 createRequire')
})

test('addCandidate：保持插入顺序（顺序就是「先试哪个」）', () => {
  const list = []
  addCandidate(list, 'C:/one/package.json')
  addCandidate(list, 'C:/two/package.json')
  addCandidate(list, 'C:/one/package.json')
  assert.deepEqual(list, ['C:/one/package.json', 'C:/two/package.json'])
})

test('addCandidate：非字符串会被 String() 化，不是静默丢弃', () => {
  const list = []
  addCandidate(list, 42)
  assert.deepEqual(list, ['42'])
})

/* ==================================================== considerBin */

test('considerBin：包内 bin 先给包根，再给 lib/node_modules 与 node_modules 两种 npm 布局', () => {
  const list = []
  considerBin(list, 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\bin\\dsh.js')
  assert.deepEqual(list, [
    'C:/Users/x/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json',
    'C:/Users/x/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/package.json',
    'C:/Users/x/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh/package.json',
  ])
})

test('considerBin：包根那条由两条规则同时产出，去重后只留一份', () => {
  const list = []
  considerBin(list, '/opt/host/node_modules/@deepseek-ai/dsh/bin/dsh.js')
  assert.deepEqual(list, [
    '/opt/host/node_modules/@deepseek-ai/dsh/package.json',
    '/opt/host/node_modules/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/opt/host/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh/package.json',
  ])
  assert.equal(list.includes('/opt/host/node_modules/@deepseek-ai/dsh/package.json'), true)
})

test('considerBin：npm 全局启动器（argv 在 bin 同级）退一级找 lib/node_modules 与 node_modules', () => {
  const list = []
  considerBin(list, '/usr/local/bin/dsh')
  assert.deepEqual(list, [
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/usr/local/node_modules/@deepseek-ai/dsh/package.json',
  ])
})

test('considerBin：Windows 的 npm 前缀同样按「退一级」处理', () => {
  const list = []
  considerBin(list, 'C:\\Users\\x\\AppData\\Roaming\\npm\\dsh.cmd')
  assert.deepEqual(list, [
    'C:/Users/x/AppData/Roaming/lib/node_modules/@deepseek-ai/dsh/package.json',
    'C:/Users/x/AppData/Roaming/node_modules/@deepseek-ai/dsh/package.json',
  ])
})

test('considerBin：空值不写；realpath 解析不了时退回原路径继续按规则拼', () => {
  const empty = []
  considerBin(empty, '')
  considerBin(empty, null)
  assert.deepEqual(empty, [])

  const list = []
  considerBin(list, 'C:\\nope\\does\\not\\exist\\node_modules\\@deepseek-ai\\dsh\\bin\\dsh.js')
  assert.equal(list.length, 3, '路径不存在时 realpathSync 抛错，必须保留原串继续算，而不是整条放弃')
  assert.ok(list[0].endsWith('/node_modules/@deepseek-ai/dsh/package.json'))
})

/* ============================================ defineToolCandidates */

const ROOTS = {
  argv1: '/r/npm/node_modules/@deepseek-ai/dsh/bin/dsh.js',
  execPath: '/r/app/DeepSeek Harness.exe',
  resourcesPath: '/r/app/resources',
  cwd: '/r/cwd',
  home: '/r/home',
  dshHome: '/r/dshhome',
}

test('defineToolCandidates：argv 与 execPath 先于所有主目录，命中率最高的排最前', () => {
  const list = defineToolCandidates(ROOTS)
  assert.equal(list[0], '/r/npm/node_modules/@deepseek-ai/dsh/package.json')
  // execPath 指到 exe 时，「退一级」规则会把它当成 <dir>/bin/x 处理，于是落到 /r 而不是 /r/app。
  // 现状刻意保留：多试一条只多一次 existsSync，少猜一种布局就会整份预设消失。
  assert.equal(list[3], '/r/lib/node_modules/@deepseek-ai/dsh/package.json')
  assert.equal(list[4], '/r/node_modules/@deepseek-ai/dsh/package.json')
})

test('defineToolCandidates：每个主目录给 7 个候选（顶层 1 + web/desktop/default 各 2）', () => {
  const list = defineToolCandidates(ROOTS)
  const dshHome = list.filter((x) => x.startsWith('/r/dshhome/'))
  assert.equal(dshHome.length, 7)
  assert.deepEqual(dshHome, [
    '/r/dshhome/package.json',
    '/r/dshhome/profiles/web/package.json',
    '/r/dshhome/profiles/web/node_modules/@deepseek-ai/dsh/package.json',
    '/r/dshhome/profiles/desktop/package.json',
    '/r/dshhome/profiles/desktop/node_modules/@deepseek-ai/dsh/package.json',
    '/r/dshhome/profiles/default/package.json',
    '/r/dshhome/profiles/default/node_modules/@deepseek-ai/dsh/package.json',
  ])
  const fallbackHome = list.filter((x) => x.startsWith('/r/home/.dsh/'))
  assert.equal(fallbackHome.length, 7, '没设 DSH_HOME 时 <home>/.dsh 也要扫同样七条')
  /* 顺序有意义：loadDefineTool 逐条 createRequire，第一条能解析的就赢了。
     显式指定的 DSH_HOME 必须先于「猜出来的 <home>/.dsh」，否则旧主目录会把当前的压掉。 */
  assert.ok(
    list.indexOf('/r/dshhome/package.json') < list.indexOf('/r/home/.dsh/package.json'),
    'DSH_HOME 那七条必须排在 <home>/.dsh 那七条之前',
  )
})

test('defineToolCandidates：桌面根去重后只留两组（resources 与 exeDir/resources 相同，exeDir 自己一组）', () => {
  const list = defineToolCandidates(ROOTS)
  const desktop = list.filter((x) => x.startsWith('/r/app/'))
  // resources 组 4 条 + exeDir 组 4 条；resourcesPath 与 join(exeDir,'resources') 是同一个目录，已去重
  assert.deepEqual(desktop, [
    '/r/app/resources/app/node_modules/@deepseek-ai/dsh/package.json',
    '/r/app/resources/app/dsh/node_modules/@deepseek-ai/dsh/package.json',
    '/r/app/resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh/package.json',
    '/r/app/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh/package.json',
    '/r/app/app/node_modules/@deepseek-ai/dsh/package.json',
    '/r/app/app/dsh/node_modules/@deepseek-ai/dsh/package.json',
    '/r/app/app.asar.unpacked/node_modules/@deepseek-ai/dsh/package.json',
    '/r/app/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh/package.json',
  ])
})

test('defineToolCandidates：全空环境只剩 cwd 那条与本机历史硬编码那条，不抛错', () => {
  const list = defineToolCandidates({
    argv1: '', execPath: '', resourcesPath: '', cwd: '', home: '', dshHome: '',
  })
  assert.deepEqual(list, [
    'package.json',
    'D:/DeepSeek Harness/npm-global/node_modules/@deepseek-ai/dsh/package.json',
  ])
})

test('defineToolCandidates：分隔符一律归一成 /（否则跨平台去重会失效）', () => {
  const list = defineToolCandidates(ROOTS)
  assert.equal(list.some((x) => x.includes('\\')), false)
  assert.equal(new Set(list).size, list.length, '归一之后不该再出现重复')
})

test('defineToolCandidates：不传参数时读真实 process，且至少给出 cwd 那条', () => {
  const list = defineToolCandidates()
  assert.ok(Array.isArray(list) && list.length > 0)
  assert.ok(list.includes(join(process.cwd(), 'package.json').replace(/\\/g, '/')))
})

/* ==================================================== loadDefineTool */

test('loadDefineTool：本仓库里能直接解析到宿主包，返回一个函数（不是模块对象）', () => {
  const fn = loadDefineTool()
  assert.equal(typeof fn, 'function')
})

test('源码形状：loadDefineTool 先试插件自己的解析，再退候选表；错误文案要能被搜到', () => {
  const body = SRC.slice(SRC.indexOf('export function loadDefineTool()'), SRC.indexOf('/** 0.2.1：'))
  assert.ok(body.includes("createRequire(import.meta.url)"), '第一优先必须是插件自己的 require')
  assert.ok(body.indexOf('createRequire(import.meta.url)') < body.indexOf('defineToolCandidates()'), '先本地解析，再扫宿主')
  assert.ok(body.includes("throw new Error('dsh-purge/redteam/tools: cannot resolve @deepseek-ai/dsh-tools from host')"))
  assert.ok(body.includes('existsSync(pkg)'), '候选表里不存在的路径要跳过，不能直接 require 一个不存在的目录')
})

/* ============================================ 子智能体结束自动释放 */

function buildCtx() {
  const registered = []
  const handlers = new Map()
  const disposers = []
  const ctx = {
    defineTool: (spec) => ({ ...spec }),
    tools: { register: (tool) => registered.push(tool) },
    effect: (fn) => {
      const disposer = fn()
      disposers.push(disposer)
      return disposer
    },
    on: (event, fn) => {
      handlers.set(event, fn)
      return () => { handlers.delete(event) }
    },
    get: () => undefined,
    logger: { warn: () => {} },
  }
  apply(ctx)
  return { ctx, registered, handlers, disposers, byName: Object.fromEntries(registered.map((t) => [t.name, t])) }
}

const parse = (text) => JSON.parse(text)

test('apply：用 ctx.effect 包住 subagent/end 注册，dispose 时解绑（否则热重载会翻倍）', () => {
  const { handlers, disposers } = buildCtx()
  assert.equal(typeof handlers.get('subagent/end'), 'function')
  assert.equal(disposers.length >= 1, true)
  for (const d of disposers) {
    if (typeof d === 'function') d()
  }
  assert.equal(handlers.has('subagent/end'), false, 'disposer 必须真的把监听摘掉')
})

test('子智能体结束：拿不到父会话时静默返回，不误释放别人的名额', async () => {
  const { handlers, byName } = buildCtx()
  const exec = { agent: { session: { id: 'auto-sess-1' } } }
  const got = parse(await byName.redteam_agent_slot.execute({ action: 'acquire', label: 'w1' }, exec))
  assert.equal(got.ok, true)
  const fire = handlers.get('subagent/end')
  fire({ id: 'child-1' }, undefined)
  fire({ id: 'child-1' }, {})
  fire(null, { session: {} })
  const status = parse(await byName.redteam_agent_slot.execute({ action: 'status' }, exec))
  assert.equal(status.used, 1, '没有父会话就不该动预留表')
  // 注：那一行 `if (rootId === undefined) return` 是防御性早退，删掉后行为不变
  // （reservations 里不可能存在 undefined 这个键：addReservation 只会收到解析出来的根会话 id）。
  // RED 演练里它是等价的，所以这里不假装能测出删掉它的差别。
})

test('子智能体结束：注册表里的 id 与预留键对不上时，按时间兜底释放最早的一条', async () => {
  const { handlers, byName } = buildCtx()
  const exec = { agent: { session: { id: 'auto-sess-2' } } }
  const a = parse(await byName.redteam_agent_slot.execute({ action: 'acquire', label: 'w1' }, exec))
  const b = parse(await byName.redteam_agent_slot.execute({ action: 'acquire', label: 'w2' }, exec))
  assert.equal(a.ok && b.ok, true)
  let status = parse(await byName.redteam_agent_slot.execute({ action: 'status' }, exec))
  assert.equal(status.used, 2)

  const fire = handlers.get('subagent/end')
  // 预留键是 `<label>#<ts>`，真实 runId 永远对不上 → 必须走兜底分支
  fire({ id: 'run-that-cannot-match' }, { session: { id: 'auto-sess-2' } })
  status = parse(await byName.redteam_agent_slot.execute({ action: 'status' }, exec))
  assert.equal(status.used, 1, '兜底释放必须真的少一个名额')
  assert.equal(status.reservations.length, 1, '释放的是最早那条（w1），不是整表清空')
  assert.ok(status.reservations[0].key.startsWith('w2#'), '留下的应当是后占的那条')
})

test('子智能体结束：预留表本来就空时不抛错（子会话先于 acquire 结束是常见情况）', async () => {
  const { handlers, byName } = buildCtx()
  const exec = { agent: { session: { id: 'auto-sess-3' } } }
  const fire = handlers.get('subagent/end')
  assert.doesNotThrow(() => fire({ id: 'child' }, { session: { id: 'auto-sess-3' } }))
  const status = parse(await byName.redteam_agent_slot.execute({ action: 'status' }, exec))
  assert.equal(status.used, 0)
})

/* ==================================================== 源码形状 */

test('源码形状：释放逻辑只用 dropReservation 与「最早一条」两种手段，不清空整张表', () => {
  const start = SRC.indexOf("ctx.on('subagent/end'")
  assert.ok(start > 0)
  const body = SRC.slice(start, start + 1400)
  assert.ok(body.includes('dropReservation(rootId, childId)'), '能精确对上时按 id 释放')
  assert.ok(body.includes('oldestKey'), '对不上时按时间兜底释放最早的一条')
  assert.equal(/reservations\.(clear|delete)\(/.test(body), false, '整表清空会把别的在途预留一起放掉，名额就超卖了')
})
