// lib/index.js 的 apply() 主体分支：boot 测试只证明"装得上"，这条测"装的时候
// 每个 if 走哪边"。剩下的未覆盖行全是这一类：停用路径、hung-disabled 清理、
// ctx 已经 disposed 的三种早退、桌面面的 office/runtime 异步自愈、路由包装层的跳闸。
//
// 全部用假 ctx 驱动，DSH_HOME 指到临时目录、DSH_SURFACE 固定 web，
// 且每轮都把 effect 工厂同步跑完并 dispose（否则 apply() 里那个
// setTimeout(settleInstalledPatches, 0) 会真去读本机宿主包）。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as plugin from '../lib/index.js'

let sandbox = ''
let savedHome = ''
let savedSurface = ''

before(() => {
  savedHome = process.env.DSH_HOME || ''
  savedSurface = process.env.DSH_SURFACE || ''
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-apply-'))
  process.env.DSH_HOME = sandbox
  process.env.DSH_SURFACE = 'web'
})

after(() => {
  if (savedHome) process.env.DSH_HOME = savedHome
  else delete process.env.DSH_HOME
  if (savedSurface) process.env.DSH_SURFACE = savedSurface
  else delete process.env.DSH_SURFACE
  fs.rmSync(sandbox, { recursive: true, force: true })
})

function homeDir(tag) {
  const dir = path.join(sandbox, tag)
  fs.mkdirSync(dir, { recursive: true })
  process.env.DSH_HOME = dir
  return dir
}

// fakeCtx(opts)：
//   opts.effectThrow   —— 第几次 ctx.effect 调用抛 INACTIVE_EFFECT（1 起算，0 表示不抛）
//   opts.noEffect      —— 不提供 ctx.effect（老宿主）
//   opts.noInject      —— 不提供 ctx.inject（watchWebTreeReady 的第一条分支）
//   opts.loaderAwait   —— connection 上 loader.await() 返回什么；undefined 表示返回无 then 的值
//   opts.hostServices  —— connection/webServer 是否都在（决定 mark 走 then 还是 catch）
function fakeCtx(opts = {}) {
  const effects = []
  const registered = []
  const specs = []
  const hooks = new Map()
  let effectCalls = 0
  const ctx = {
    name: 'fake',
    effects,
    registered,
    specs,
    hooks,
    on(event, fn, o) {
      if (!hooks.has(event)) hooks.set(event, [])
      hooks.get(event).push({ fn, o })
      return () => {}
    },
    get(name) {
      if (name === 'commands') return { register: () => ({ dispose() {} }) }
      return undefined
    },
    systemPrompt: {
      section() { return { dispose() {} } },
      assemble: async (x) => x,
      ctx: null,
    },
  }
  if (!opts.noEffect) {
    ctx.effect = (factory) => {
      effectCalls += 1
      if (opts.effectThrow && effectCalls === opts.effectThrow) {
        const e = new Error('inactive context')
        e.code = 'INACTIVE_EFFECT'
        throw e
      }
      effects.push(factory)
      return () => {}
    }
  }
  if (!opts.noInject) {
    ctx.inject = (names, fn) => {
      // watchWebTreeReady 只要 connection；installWebServer 只要 webServer。
      // opts.noConn 时对 connection 的 inject 直接不回调（模拟还没入树）。
      if (opts.noConn && names.includes('connection') && !names.includes('webServer')) return
      if (!names.includes('webServer') && !names.includes('connection')) return
      const host = {
        get: (key) => {
          if (opts.hostServices === false) return undefined
          if (key === 'loader') {
            return {
              await: () => {
                if (opts.loaderAwait === undefined) return opts.loaderAwait
                return opts.loaderAwait
              },
            }
          }
          return {}
        },
        effect(factory) { effects.push(factory); return () => {} },
        webServer: {
          register(spec) {
            specs.push(spec)
            registered.push({ kind: spec.kind, path: spec.path })
            return () => {}
          },
        },
      }
      fn(host)
    }
  }
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

// /status 是 webState.ready 唯一的对外读数：ready=false 回 503，true 回 200。
// watchWebTreeReady 的四条分支只能靠这个读数区分，别用「不抛就算过」。
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

async function statusCodeAfterApply(opts) {
  const ctx = fakeCtx(opts)
  plugin.apply(ctx, {})
  runEffects(ctx)
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  const spec = ctx.specs.find((s) => s.path === '/dsh-purge/status')
  assert.ok(spec, '必须注册了 /dsh-purge/status')
  const res = mkRes()
  await spec.handler({ method: 'GET', url: '/dsh-purge/status', headers: {} }, res)
  return res.statusCode
}

// ------------------------------------------------------------ 停用路径

test('apply：enabled:false 时清掉运行期钩子并置 __dshPurgeDisabled', () => {
  const home = homeDir('disabled')
  const ctx = fakeCtx()
  ctx.__dshPurgeSessionHook = () => 'x'
  ctx.__dshPurgePresetHook = () => 'x'
  plugin.apply(ctx, { enabled: false })
  assert.equal(ctx.__dshPurgeSessionHook, undefined, '停用后宿主的会话钩子必须摘掉')
  assert.equal(ctx.__dshPurgePresetHook, undefined)
  assert.equal(ctx.__dshPurgeDisabled, true, '停用后必须置禁标志，隔离 loopCtx 上的 guard 才能失效')
  assert.equal(ctx.registered.length, 0, '停用后不该注册路由')
  assert.equal(typeof globalThis.__dshPurgeHungPrompt, 'function', 'hung 钩子要换成空实现而不是删掉')
  assert.equal(globalThis.__dshPurgeHungPrompt(), '', '停用后 hung 钩子必须返回空串')
  assert.ok(fs.existsSync(home), 'home 目录仍在')
})

test('apply：启用时把 __dshPurgeDisabled 删掉（热重载后重新启用）', () => {
  homeDir('reenable')
  const ctx = fakeCtx()
  ctx.__dshPurgeDisabled = true
  plugin.apply(ctx, {})
  runEffects(ctx)
  assert.equal(ctx.__dshPurgeDisabled, undefined, '重新启用必须把禁标志删掉')
})

// ------------------------------------------------------------ hung-disabled 清理

test('apply：home 里的 .hung-disabled 会被删掉', () => {
  const home = homeDir('hungflag')
  const flag = path.join(home, '.hung-disabled')
  fs.writeFileSync(flag, '')
  assert.ok(fs.existsSync(flag))
  const ctx = fakeCtx()
  plugin.apply(ctx, {})
  runEffects(ctx)
  assert.equal(fs.existsSync(flag), false, '启动时必须把 .hung-disabled 清掉，否则注入一直关着')
})

// ------------------------------------------------------------ ctx 已 disposed 的三种早退

test('apply：watchContextLife 报 inactive 时不往下装钩子', () => {
  homeDir('inactive-early')
  // 第 1 次 ctx.effect 是 scheduleClearOwnedSelectedDefault 的回收器；
  // watchContextLife 用的是下一次。让它抛 INACTIVE_EFFECT → life.alive=false。
  const ctx = fakeCtx({ effectThrow: 2 })
  assert.doesNotThrow(() => plugin.apply(ctx, {}), 'inactive 是正常路径，不该抛')
  assert.equal(ctx.registered.length, 0, 'life 已经 false，不该再注册路由')
  assert.equal(ctx.effects.length, 1, '只有第一个 effect 登记成功')
})

test('apply：登记 settleTimer 回收器时抛 inactive → 清掉定时器并早退', () => {
  homeDir('inactive-timer')
  // 1: 清默认回收器；2: watchContextLife；3: settleTimer 回收器
  const ctx = fakeCtx({ effectThrow: 3 })
  assert.doesNotThrow(() => plugin.apply(ctx, {}))
  assert.equal(ctx.registered.length, 0, '定时器回收器失败后就该早退，不装钩子')
})

test('apply：applyHostHooks 抛 inactive → 吞掉并不再注册 web server', () => {
  homeDir('inactive-hooks')
  // 1: 清默认；2: watchContextLife；3: settleTimer 回收器；4+: 各 hook 自己的 effect
  const ctx = fakeCtx({ effectThrow: 4 })
  assert.doesNotThrow(() => plugin.apply(ctx, {}))
  assert.equal(ctx.registered.length, 0, 'applyHostHooks 早退后不该走到 installWebServer')
})

// ------------------------------------------------------------ watchWebTreeReady 四条分支

test('watchWebTreeReady：ctx 有 inject 但没有 connection 服务时不影响 apply', () => {
  homeDir('wwtr-conn-only')
  // watchWebTreeReady 自己判 `typeof ctx.inject !== "function"` 才 mark；
  // 但 installWebServer 无条件调 ctx.inject —— 所以「没有 inject 的宿主」这一层
  // apply() 是走不到的，只能测「有 inject、没有 connection」这条。
  const ctx = fakeCtx({ noConn: true })
  assert.doesNotThrow(() => plugin.apply(ctx, {}))
  runEffects(ctx)
  assert.ok(ctx.registered.some((r) => r.path === '/dsh-purge/status'), '没有 connection 也要注册 HTTP 路由')
})

test('watchWebTreeReady：loader.await() 返回非 thenable → 立刻 mark', () => {
  homeDir('wwtr-nonpromise')
  const ctx = fakeCtx({ loaderAwait: 42 })
  assert.doesNotThrow(() => plugin.apply(ctx, {}))
  runEffects(ctx)
  assert.ok(ctx.registered.some((r) => r.path === '/dsh-purge/status'), '渲染路由仍然要注册')
})

test('watchWebTreeReady：loader.await() 是 promise，服务齐了才 mark', async () => {
  homeDir('wwtr-promise')
  const ctx = fakeCtx({ loaderAwait: Promise.resolve() })
  plugin.apply(ctx, {})
  runEffects(ctx)
  await new Promise((r) => setImmediate(r))
  assert.ok(ctx.registered.some((r) => r.kind === 'exact'), 'promise 分支也要注册路由')
})

test('watchWebTreeReady：connection host 上拿不到服务时也能 mark（失败回调就是 mark）', async () => {
  homeDir('wwtr-missing')
  // hostServices=false → host.get 全返回 undefined。settled.then(onOk, mark) 的**第二个参数就是 mark**，
  // 所以「服务不齐」和「服务齐」对外读数相同：/status 都回 200。
  // 换句话说这条分支在运行期不可区分，只能锁现状（谁把失败回调改成 noop 会立刻变红）。
  const code = await statusCodeAfterApply({ loaderAwait: Promise.resolve(), hostServices: false })
  assert.equal(code, 200, '服务缺失走的是 then 的失败回调，那也是 mark')
})

test('watchWebTreeReady：没有 connection 服务时 /status 停在 503', async () => {
  homeDir('wwtr-noconn')
  // noConn → ctx.inject(["connection"]) 根本不回调 → ready 永远 false → 503。
  // 这是四条分支里唯一有可观察差异的一条，别把断言写成「不抛就算过」。
  const code = await statusCodeAfterApply({ noConn: true })
  assert.equal(code, 503, 'connection 没入树就回 503，前端才会显示"正在启动"')
})

test('watchWebTreeReady：loader.await() 返回非 thenable 时 /status 直接 200', async () => {
  homeDir('wwtr-sync')
  const code = await statusCodeAfterApply({ loaderAwait: 42 })
  assert.equal(code, 200, '非 thenable 走同步 mark')
})

// ------------------------------------------------------------ 桌面面的异步自愈

test('apply：桌面面会排一个 setImmediate 去自愈 office 与 runtime', async () => {
  const saved = process.env.DSH_SURFACE
  process.env.DSH_SURFACE = 'desktop'
  try {
    homeDir('desktop-heal')
    const ctx = fakeCtx()
    plugin.apply(ctx, {})
    runEffects(ctx)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    assert.ok(true, 'setImmediate 自愈不能抛，抛了会冒到定时器外面')
  } finally {
    if (saved === undefined) delete process.env.DSH_SURFACE
    else process.env.DSH_SURFACE = saved
  }
})

test('apply：桌面自愈只在 desktop 面排程（web 面一个 setImmediate 都不排）', () => {
  // 这条只能读源码：本机 healOfficeSkillsRuntimeOnDisk 在 web 面根本不会被调用，
  // 而 desktop 面的调用结果是 {ok:true,healed:false}（技能已就位）→ 不写日志、无副作用。
  // 也就是说「区分桌面面」这个判定在运行期不可观察，只能钉住那行守卫本身。
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(
    src,
    /if \(hostctl\.currentSurface\(\) === "desktop"\) \{/,
    '桌面自愈必须挂在 surface 判定里，否则 web 面每次启动都去摸安装目录',
  )
  // setImmediate 只有一处，且在同一个 if 里 —— 顺序变了就说明有人把自愈挪到了热路径上。
  const guardAt = src.indexOf('if (hostctl.currentSurface() === "desktop") {')
  const immAt = src.indexOf('setImmediate(')
  assert.ok(immAt > guardAt, 'setImmediate 必须在 surface 守卫之后')
  assert.equal(src.split('setImmediate(').length - 1, 1, '整套启动路径只能有一处 setImmediate')
})

test('apply：watchWebTreeReady 的非 thenable 分支与失败回调都必须先 mark', () => {
  // 这两条在运行期都等价于「/status 回 200」：删掉非 thenable 的早退后
  // 42.then 会抛 TypeError，被外层 catch 接住再 mark；删掉失败回调后也不会变 503。
  // 所以唯一能钉住的是「mark 在这两处都出现过」，别让后人以为删掉没影响。
  // lib/*.js 是 CRLF，读进来先去掉 \r，正则才不用到处写 \r?\n。
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(
    src,
    /if \(!settled \|\| typeof settled\.then !== "function"\) \{\n\s*mark\(\);\n\s*return;/,
    '非 thenable 必须先同步 mark 再 return',
  )
  assert.match(
    src,
    /settled\.then\(\(\) => \{[\s\S]{0,200}\}, mark\);/,
    'then 的失败回调必须是 mark 本身（服务不齐时也要放行 /status）',
  )
})

test('apply：ctx.effect 的登记处一共 12 处（删掉任何一处都会掉到 11）', () => {
  // settleTimer 的回收器、watchContextLife 的生命期钩子、continue-retry 的清理
  // 都是「登记一次、没有别的等价路径」的；少一处就等于泄漏一个定时器或闭包。
  homeDir('effect-count')
  const ctx = fakeCtx()
  plugin.apply(ctx, {})
  const before = ctx.effects.length
  runEffects(ctx)
  assert.equal(before, 12, `apply() + applyHostHooks() 一共登记 12 个 effect，实际 ${before}`)
})

// ------------------------------------------------------------ 路由包装层

test('路由包装：跨站请求被 allowPluginRequest 拦下，回 403 而不是业务响应', async () => {
  homeDir('route-guard')
  const ctx = fakeCtx()
  plugin.apply(ctx, {})
  runEffects(ctx)
  const statusSpec = ctx.specs.find((s) => s.path === '/dsh-purge/status')
  assert.ok(statusSpec, '必须注册了 /dsh-purge/status')

  const mkRes = () => ({
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); return this },
    end(body) { if (body !== undefined) this.body = String(body) },
  })
  const call = async (headers, method = 'GET') => {
    const res = mkRes()
    await statusSpec.handler({ method, url: '/dsh-purge/status', headers }, res)
    return res
  }

  // 跨站（sec-fetch-site）→ 403
  const crossSite = await call({ 'sec-fetch-site': 'cross-site' })
  assert.equal(crossSite.statusCode, 403, `跨站必须回 403，实际 ${crossSite.statusCode}`)
  assert.match(crossSite.body, /cross-origin blocked/, '403 正文必须是固定的拒绝串')

  // Origin: null → 403
  const nullOrigin = await call({ origin: 'null' })
  assert.equal(nullOrigin.statusCode, 403)

  // Origin 与 Host 不一致（DNS rebinding）→ 403
  const rebind = await call({ origin: 'https://evil.example', host: '127.0.0.1:3080' })
  assert.equal(rebind.statusCode, 403)

  // 没有 Origin（curl / 宿主自身）→ 放行，进业务层拿 405（方法不是 GET 时）
  const noOrigin = await call({}, 'POST')
  assert.equal(noOrigin.statusCode, 405, '同源 POST 应进业务层被方法闸挡下')
  assert.equal(noOrigin.headers.allow, 'GET')
})

// ------------------------------------------------------------ 命令与工具面接线

test('apply：/purge 的 deps 里 scheduleApplyRestart 来自 bootSettle（不是裸函数）', () => {
  homeDir('purge-deps')
  const ctx = fakeCtx()
  plugin.apply(ctx, {})
  runEffects(ctx)
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /scheduleApplyRestart: bootSettle\.scheduleApplyRestart,/, 'purge 必须拿到 boot-settle 里那个实现')
  assert.match(src, /rules: \(rawInput\) => handleRulesCommand\(rawInput, \{ refreshHungOperator \}\)/, 'rules 命令必须带上 refresh 依赖')
  assert.match(src, /skills: \(rawInput\) => handleSkillsCommand\(rawInput\)/, 'skills 命令不需要 refresh 依赖')
})
