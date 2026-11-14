// lib/index.js 的 apply() 剩下几处「只在坏环境下才走」的分支：
//   :154-156   ctx.inject(["connection"]) 抛错 → mark()，/status 仍要 200
//   :229-230   seedPromptInjectAtBoot 抛错 → 只 warn（本机造不出真抛，见源码形状那条）
//   :244-247   profile 自愈真的写了文件才打日志
//   :264-267   settle 定时器醒来时 ctx 已被回收 → 直接跳过
//   :269       settle 正常返回一个结论字符串
//   :320-322   桌面面 runtime 负载缺失 → 就地修复并记一笔
//   :344-346   anchor/subagent 装配抛错 → 吞掉并记 apply-hooks
//   :366-367   /purge 命令本体
//
// 两条纪律（与 test-plugin-apply.mjs 一致，但本文件独立，不共享状态）：
//   1. 必须先把 TEMP 换到本进程私有目录再 import —— lib/prompt-source.js 的
//      PURGE_INTERNAL_LOG 在模块顶层就算好，晚一步日志会写进全仓共用的 tmp 文件。
//   2. 每个用例都要全新 DSH_HOME，否则上一轮的 profiles / 日志互相污染。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-apply-edges-tmp-'))
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-apply-edges-'))
const SAVED_TMP = {
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  TMPDIR: process.env.TMPDIR,
}
process.env.TEMP = TMP_ROOT
process.env.TMP = TMP_ROOT
process.env.TMPDIR = TMP_ROOT
const LOG_FILE = path.join(TMP_ROOT, 'dsh-purge-desktop.log')

const SAVED = {
  DSH_HOME: process.env.DSH_HOME,
  DSH_SURFACE: process.env.DSH_SURFACE,
  DSH_BASE: process.env.DSH_BASE,
  DSH_DESKTOP_INSTALL: process.env.DSH_DESKTOP_INSTALL,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  npm_config_prefix: process.env.npm_config_prefix,
}

// 静态 import 会被提升到 TEMP 改写之前，所以必须动态 import。
const plugin = await import('../lib/index.js')

after(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const [key, value] of Object.entries(SAVED_TMP)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

let seq = 0
function homeBox(tag) {
  seq += 1
  const dir = path.join(ROOT, `${tag}-${seq}`)
  fs.mkdirSync(dir, { recursive: true })
  process.env.DSH_HOME = dir
  // 每次换 home 都换一份假 AI 树，避免 settle 去扫真宿主包。
  const ai = path.join(dir, 'ai', 'node_modules', '@deepseek-ai')
  fs.mkdirSync(ai, { recursive: true })
  process.env.DSH_BASE = ai
  process.env.DSH_SURFACE = 'web'
  delete process.env.DSH_DESKTOP_INSTALL
  fs.writeFileSync(LOG_FILE, '')
  return dir
}

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

function logLines() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function tagged(tag) {
  return logLines().filter((line) => line.includes(`[${tag}]`))
}

// ctx 假件：systemPrompt 用 getter，按第 n 次读取抛错，用来逐档定位 anchor 装配里
// 哪一次读取没被 try 包住。
function mkCtx(opts = {}) {
  const effects = []
  const specs = []
  const cmds = []
  const hooks = new Map()
  let spReads = 0
  const ctx = {
    name: 'fake',
    effects,
    specs,
    cmds,
    hooks,
    on(event, fn, o) {
      if (!hooks.has(event)) hooks.set(event, [])
      hooks.get(event).push({ fn, o })
      return () => {}
    },
    get(name) {
      if (name === 'commands' && opts.commands !== false) {
        return { register: (h) => { cmds.push(h); return { dispose() {} } } }
      }
      return undefined
    },
    effect(factory) {
      effects.push(factory)
      return () => {}
    },
    inject(names, fn) {
      if (opts.injectThrowsOn && names.includes(opts.injectThrowsOn)) {
        throw new Error(`inject boom: ${names.join(',')}`)
      }
      if (!names.includes('webServer') && !names.includes('connection')) return
      const host = {
        get: (key) => (key === 'loader' ? { await: () => undefined } : {}),
        effect(factory) { effects.push(factory); return () => {} },
        webServer: { register(spec) { specs.push(spec); return () => {} } },
      }
      fn(host)
    },
  }
  Object.defineProperty(ctx, 'systemPrompt', {
    configurable: true,
    get() {
      spReads += 1
      if (opts.spThrowAt && spReads >= opts.spThrowAt) throw new Error('sp getter boom')
      return {
        section: () => ({ dispose() {} }),
        context: () => ({ dispose() {} }),
        assemble: async (x) => x,
        ctx: null,
      }
    },
  })
  return ctx
}

function runEffects(ctx) {
  const errors = []
  for (const factory of ctx.effects.slice()) {
    try {
      const dispose = factory()
      if (typeof dispose === 'function') dispose()
    } catch (e) {
      errors.push(String(e && e.message ? e.message : e))
    }
  }
  return errors
}

function mkRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); return this },
    end(body) { if (body !== undefined) this.body = String(body) },
  }
}

const tick = () => new Promise((r) => setImmediate(r))

async function statusAfter(ctx) {
  const spec = ctx.specs.find((s) => s.path === '/dsh-purge/status')
  assert.ok(spec, '必须注册了 /dsh-purge/status')
  const res = mkRes()
  await spec.handler({ method: 'GET', url: '/dsh-purge/status', headers: {} }, res)
  return res.statusCode
}

// ------------------------------------------------------------ 注入失败

test('inject 对 connection 抛错时 /status 仍回 200（catch 里也 mark）', async () => {
  homeBox('inject-throw')
  const ctx = mkCtx({ injectThrowsOn: 'connection' })
  let threw = null
  try {
    plugin.apply(ctx, {})
    runEffects(ctx)
  } catch (e) {
    threw = String(e.message)
  }
  assert.equal(threw, null, 'watchWebTreeReady 抛错不该冒到 apply')
  assert.equal(await statusAfter(ctx), 200)
})

test('inject 抛错不影响后面的路由注册（16 条仍在）', async () => {
  homeBox('inject-throw-routes')
  const ctx = mkCtx({ injectThrowsOn: 'connection' })
  plugin.apply(ctx, {})
  runEffects(ctx)
  assert.equal(ctx.specs.length, 16, `路由数应是 16，实际 ${ctx.specs.length}`)
  assert.ok(ctx.specs.some((s) => s.path === '/dsh-purge/last-user'))
})

test('inject 正常时 /status 也是 200（mark 的两条路都收敛到 ready）', async () => {
  homeBox('inject-ok')
  const ctx = mkCtx({})
  plugin.apply(ctx, {})
  runEffects(ctx)
  assert.equal(await statusAfter(ctx), 200)
})

// ------------------------------------------------------------ apply 主体日志

test('verbose 时打出 seed 与 plugin enabled 两行', () => {
  homeBox('verbose')
  const ctx = mkCtx({})
  const logs = []
  const realLog = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }
  try {
    plugin.apply(ctx, { verbose: true })
    runEffects(ctx)
  } finally {
    console.log = realLog
  }
  const text = logs.join('\n')
  assert.match(text, /\[dsh-purge\] seed prompt-inject: /)
  assert.match(text, /\[dsh-purge\] plugin enabled/)
})

test('profile 自愈真写了文件才打日志（insert 与 bundles 分别标注）', () => {
  const home = homeBox('profile-heal')
  const dir = path.join(home, 'profiles', 'p1')
  put(path.join(dir, 'package.json'), '{"dependencies":{"dsh-purge":"file:../x"}}\n')
  put(path.join(dir, 'node_modules', 'dsh-purge', 'package.json'), '{"name":"dsh-purge"}\n')
  const ctx = mkCtx({})
  const logs = []
  const realLog = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }
  try {
    plugin.apply(ctx, { verbose: true })
    runEffects(ctx)
  } finally {
    console.log = realLog
  }
  const heal = logs.filter((line) => line.includes('profile heal:'))
  assert.equal(heal.length, 1, `应只有一行 profile heal，实际 ${JSON.stringify(heal)}`)
  assert.ok(heal[0].includes(path.join('profiles', 'p1')), heal[0])
  assert.ok(fs.existsSync(path.join(dir, 'cordis.patch.yml')), 'cordis.patch.yml 应被补上')
})

test('没有需要自愈的 profile 时不打 profile heal 日志', () => {
  homeBox('profile-none')
  const ctx = mkCtx({})
  const logs = []
  const realLog = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }
  try {
    plugin.apply(ctx, { verbose: true })
    runEffects(ctx)
  } finally {
    console.log = realLog
  }
  assert.equal(logs.filter((line) => line.includes('profile heal:')).length, 0)
})

// ------------------------------------------------------------ settle 定时器

test('settle 醒来时 ctx 已回收 → 直接跳过，不去扫宿主', async () => {
  homeBox('settle-inactive')
  const ctx = mkCtx({})
  const logs = []
  const realLog = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }
  try {
    plugin.apply(ctx, { verbose: true })
    // 只跑「life」那一个 effect（源码里带 alive），不能跑全部 ——
    // 第 3 个 effect 是 () => () => clearTimeout(settleTimer)，一起跑会把定时器撤掉，
    // 那样测到的是「定时器没响」而不是「响了但 ctx 已回收」。
    const lifeEffect = ctx.effects.find((f) => String(f).includes('alive'))
    assert.ok(lifeEffect, '必须有一个负责 life 的 effect')
    const dispose = lifeEffect()
    if (typeof dispose === 'function') dispose()
    await new Promise((r) => setTimeout(r, 30))
    await tick()
  } finally {
    console.log = realLog
  }
  assert.ok(
    logs.some((line) => line.includes('settle skipped: inactive context')),
    `应打出 settle skipped，实际 ${JSON.stringify(logs)}`,
  )
})

test('settle 正常返回结论字符串并写进日志', async () => {
  homeBox('settle-ok')
  const ctx = mkCtx({})
  const logs = []
  const realLog = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }
  try {
    plugin.apply(ctx, { verbose: true })
    // 不跑 effect：life 仍活着，定时器 0ms 后自己醒来。
    // 但醒来之后那一步会真的去核对宿主树（patchesMatchInstallStrict 要 stat 一遍），
    // 本机实测 130–180ms 才出结论 —— 固定等 60ms 在这台机器上会假红，所以改成轮询。
    for (let i = 0; i < 200; i += 1) {
      if (logs.some((line) => /\[dsh-purge\] settle: /.test(line))) break
      await new Promise((r) => setTimeout(r, 20))
    }
    for (const factory of ctx.effects.slice()) {
      try { const d = factory(); if (typeof d === 'function') d() } catch {}
    }
  } finally {
    console.log = realLog
  }
  const settle = logs.filter((line) => /\[dsh-purge\] settle: /.test(line))
  assert.equal(settle.length, 1, `应恰好一行 settle 结论，实际 ${JSON.stringify(logs)}`)
  assert.match(settle[0], /(boot:host-untouched|skip:boot-no-host-write|skip:inactive)(\s|$)/)
})

// ------------------------------------------------------------ /purge 命令

test('/purge 无子命令时回帮助文本而不是报错', async () => {
  homeBox('purge-help')
  const ctx = mkCtx({})
  plugin.apply(ctx, {})
  runEffects(ctx)
  // registerChatCommands 一次注册四条（purge / rules / skills / rewind），按 name 取。
  assert.deepEqual(ctx.cmds.map((c) => c.name).sort(), ['purge', 'rewind', 'rules', 'skills'])
  const spec = ctx.cmds.find((c) => c.name === 'purge')
  assert.deepEqual(Object.keys(spec).sort(), ['description', 'handler', 'input', 'name'])
  const out = await spec.handler({ rawInput: '/purge', args: [], input: '/purge' })
  assert.equal(out.kind, 'success')
  assert.match(out.text, /^dsh-purge 命令：/)
  assert.match(out.text, /\/purge apply/)
})

test('/purge status 走状态渲染分支且不抛', async () => {
  homeBox('purge-status')
  const ctx = mkCtx({})
  plugin.apply(ctx, {})
  runEffects(ctx)
  const spec = ctx.cmds.find((c) => c.name === 'purge')
  const out = await spec.handler({ rawInput: '/purge status', args: ['status'], input: '/purge status' })
  assert.ok(out && typeof out === 'object')
  assert.match(String(out.text || ''), /\S/)
})

// ------------------------------------------------------------ 桌面面自愈

function fakeInstall(tag, { withOffice = false } = {}) {
  const root = path.join(ROOT, `install-${tag}-${(seq += 1)}`)
  const exe = path.join(root, 'DeepSeek Harness.exe')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, 'MZ')
  fs.mkdirSync(path.join(root, 'resources', 'app'), { recursive: true })
  if (withOffice) put(path.join(root, 'resources', 'runtime', 'office-skills', 'office', 'SKILL.md'), '# office\n')
  process.env.DSH_DESKTOP_INSTALL = root
  process.env.DSH_SURFACE = 'desktop'
  return root
}

const REAL_OFFICE = path.join(
  'C:',
  'Users',
  'Administrator',
  'AppData',
  'Local',
  'Programs',
  'DeepSeek Harness',
  'resources',
  'runtime',
  'office-skills',
  'office',
  'SKILL.md',
)

test('桌面面 office-skills 缺失时按「真补齐才记账」处理（不写真机）', async () => {
  homeBox('desktop-office')
  const realOffice = fs.existsSync(REAL_OFFICE)
  const before = realOffice ? fs.statSync(REAL_OFFICE).mtimeMs : null
  const root = fakeInstall('office')
  const ctx = mkCtx({})
  plugin.apply(ctx, {})
  await tick()
  await tick()
  const copied = path.join(root, 'resources', 'runtime', 'office-skills', 'office', 'SKILL.md')
  const lines = tagged('heal-office-skills')
  // 这条分支的契约是「真补齐了才记一笔」：
  //   本机有官方 office 资产（source 找得到）→ 复制成功 → 恰好一行、healed=true、文件真在；
  //   没有资产（干净的 CI 机器）→ reason:"no-source" → 一行都不许有。
  assert.ok(lines.length <= 1, `最多一笔 office 自愈，实际 ${JSON.stringify(logLines())}`)
  if (lines.length === 1) {
    assert.match(lines[0], /healed=true/)
    assert.ok(fs.existsSync(copied), '报告 healed=true 就必须真有文件落盘')
  } else {
    assert.equal(fs.existsSync(copied), false, '没记账就不许偷偷写文件')
  }
  if (before !== null) {
    assert.equal(fs.statSync(REAL_OFFICE).mtimeMs, before, '不许改写真机 office-skills')
  }
  runEffects(ctx)
})

test('桌面面 runtime 负载缺失时记 heal-runtime-payload（ok=false）', async () => {
  homeBox('desktop-runtime')
  fakeInstall('runtime')
  const ctx = mkCtx({})
  plugin.apply(ctx, {})
  await tick()
  await tick()
  const lines = tagged('heal-runtime-payload')
  assert.equal(lines.length, 1, `应记一笔 runtime 自愈，实际 ${JSON.stringify(logLines())}`)
  assert.match(lines[0], /ok=false/)
  runEffects(ctx)
})

test('web 面根本不进桌面自愈分支', async () => {
  homeBox('web-surface')
  const ctx = mkCtx({})
  plugin.apply(ctx, {})
  await tick()
  await tick()
  assert.equal(tagged('heal-office-skills').length, 0)
  assert.equal(tagged('heal-runtime-payload').length, 0)
  runEffects(ctx)
})

// ------------------------------------------------------------ anchor 装配失败

test('systemPrompt 第 6 次读取抛错 → 吞掉并记 apply-hooks', () => {
  homeBox('anchor-throw')
  const ctx = mkCtx({ spThrowAt: 6 })
  let threw = null
  try {
    plugin.apply(ctx, {})
    runEffects(ctx)
  } catch (e) {
    threw = String(e.message)
  }
  assert.equal(threw, null, '装配失败不该冒到 apply')
  assert.equal(ctx.specs.length, 16, '后面的路由注册仍要跑完')
  const lines = tagged('apply-hooks')
  assert.equal(lines.length, 1, `应记一笔 apply-hooks，实际 ${JSON.stringify(logLines())}`)
  assert.match(lines[0], /name=anchor\/subagent/)
  assert.match(lines[0], /err=sp_getter_boom/)
})

// ------------------------------------------------------------ 源码形状

const INDEX_SRC = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('源码形状：no-inject 早退仍在（经 apply 走不到）、seed 抛错只 warn', () => {
  // watchWebTreeReady 的「没有 ctx.inject」分支：installWebServer 无条件调 ctx.inject，
  // 所以经 apply() 永远走不到，只能钉源码。
  const noInject = 'if (typeof ctx?.inject !== "function") {'
  assert.ok(INDEX_SRC.includes(noInject), 'no-inject 早退不许删')
  const at = INDEX_SRC.indexOf(noInject)
  const block = INDEX_SRC.slice(at, at + 120)
  assert.match(block, /mark\(\);/)
  assert.match(block, /return;/)
  // seedPromptInjectAtBoot 内部已把写盘失败转成 action:"error"，这个 catch 只兜真正的异常。
  assert.ok(INDEX_SRC.includes('[dsh-purge] seed prompt-inject failed:'), 'seed 抛错只 warn 不中断')
  assert.ok(!INDEX_SRC.includes('throw e;\n  }\n  refreshHungOperator(home)'))
})
