// lib/index.js 的「真 boot 一次」契约测试。
//
// 为什么需要这一条：2167 条用例里没有任何一条执行过 installWebServer —— 它挂在
// ctx.inject(["webServer"]) 的回调里，只有宿主真的提供 webServer 服务才走得到。
// 批53 收窄 import 时把 ensureRestartReady 删了，node --check 通过、全量测试全绿，
// 但宿主一启动就 ReferenceError（实测：applyOutcome=no-throw、effects=12 个全跑完后
// effectErrors 里躺着 "ReferenceError: ensureRestartReady is not defined"）。
//
// 这条测试的做法是：假 ctx 提供 webServer → 调 apply() → 同步跑一遍所有 effect 工厂
// → 断言没有抛错、16 条路由都注册上了（13 条 exact + 3 条 prefix）。
// 它同时兜住「以后再把某个名字从 import 里删掉」这一类错误，不只是这一个名字。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as plugin from '../lib/index.js'

const SRC = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

let sandbox = ''
let savedHome = ''
let savedSurface = ''

before(() => {
  savedHome = process.env.DSH_HOME || ''
  savedSurface = process.env.DSH_SURFACE || ''
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-boot-'))
  process.env.DSH_HOME = sandbox
  // 固定成 web：desktop 面会走 healOfficeSkills / inspectRuntimePayload 那些
  // 真碰安装目录的分支，与这条测试要证明的事无关。
  process.env.DSH_SURFACE = 'web'
})

after(() => {
  if (savedHome) process.env.DSH_HOME = savedHome
  else delete process.env.DSH_HOME
  if (savedSurface) process.env.DSH_SURFACE = savedSurface
  else delete process.env.DSH_SURFACE
  fs.rmSync(sandbox, { recursive: true, force: true })
})

function fakeCtx() {
  const effects = []
  const registered = []
  const disposers = []
  const hooks = new Map()
  return {
    effects,
    registered,
    disposers,
    hooks,
    on(event, fn, opts) {
      if (!hooks.has(event)) hooks.set(event, [])
      hooks.get(event).push({ fn, opts })
      return () => {}
    },
    effect(factory) {
      effects.push(factory)
      return () => {}
    },
    get(name) {
      if (name === 'commands') return { register: () => ({ dispose() {} }) }
      return undefined
    },
    inject(names, fn) {
      if (!names.includes('webServer')) return
      const host = {
        get: () => undefined,
        effect(factory) { effects.push(factory); return () => {} },
        webServer: {
          register(spec) {
            registered.push({ kind: spec.kind, path: spec.path })
            return () => { disposers.push(spec.path) }
          },
        },
      }
      fn(host)
    },
    systemPrompt: {
      section() { return { dispose() {} } },
      assemble: async (x) => x,
      ctx: null,
    },
  }
}

// 同步跑完所有 effect 工厂并把返回的 disposer 立刻执行掉：
// apply() 里有一个 setTimeout(settleInstalledPatches, 0)，它的清理函数就在
// 某个 effect 的返回值里，同步 dispose 掉才能在定时器触发前把它撤掉 ——
// 否则这条测试会真的去读本机宿主包。
function runEffects(ctx) {
  const errors = []
  for (const factory of ctx.effects) {
    try {
      const dispose = factory()
      if (typeof dispose === 'function') dispose()
    } catch (e) {
      errors.push(`${e && e.constructor ? e.constructor.name : 'Error'}: ${e && e.message ? e.message : String(e)}`)
    }
  }
  return errors
}

test('boot：提供 webServer 时 apply() 与所有 effect 都不抛错（ReferenceError 会在这里露出来）', () => {
  const ctx = fakeCtx()
  assert.doesNotThrow(() => plugin.apply(ctx, {}), 'apply() 本体不能抛')
  const errors = runEffects(ctx)
  assert.deepEqual(errors, [], `effect 执行期间抛错了：${errors.join(' | ')}`)
})

test('boot：16 条路由都注册上了（13 条 exact + 3 条 prefix）', () => {
  const ctx = fakeCtx()
  plugin.apply(ctx, {})
  runEffects(ctx)
  const exact = ctx.registered.filter((r) => r.kind === 'exact')
  const prefix = ctx.registered.filter((r) => r.kind === 'prefix')
  assert.equal(exact.length, 13, `exact 路由数量不对：${exact.map((r) => r.path).join(',')}`)
  assert.equal(prefix.length, 3, `prefix 路由数量不对：${prefix.map((r) => r.path).join(',')}`)
  for (const want of ['/dsh-purge/status', '/dsh-purge/apply', '/dsh-purge/revert', '/dsh-purge/restart']) {
    assert.ok(exact.some((r) => r.path === want), `缺 ${want}`)
  }
  for (const want of ['/dsh-purge/rules', '/dsh-purge/skills', '/dsh-purge/skill']) {
    assert.ok(prefix.some((r) => r.path === want), `缺 prefix ${want}`)
  }
})

test('boot：enabled:false 时一条路由都不注册，也不抛错', () => {
  const ctx = fakeCtx()
  assert.doesNotThrow(() => plugin.apply(ctx, { enabled: false }))
  runEffects(ctx)
  assert.equal(ctx.registered.length, 0, '停用后不该注册任何路由')
})

// 静态守卫：installWebServer 里传给 routeSpecs 的每个依赖名，必须能在文件顶部的
// import 里找到，或者在文件里自己声明。这条比 boot 测试更早失败、也更能指出名字。
test('源码形状：routeSpecs 的 deps 里每个名字都必须有来处（import 或本文件声明）', () => {
  const start = SRC.indexOf('routeSpecs({')
  assert.ok(start > 0, '找不到 routeSpecs({ 调用')
  const end = SRC.indexOf('}))', start)
  assert.ok(end > start, '找不到 routeSpecs 调用的收尾')
  const block = SRC.slice(start, end)

  // 收集 import 进来的名字
  const imported = new Set()
  for (const m of SRC.matchAll(/^import\s*(?:\*\s*as\s*([\w$]+)|\{([^}]*)\}|([\w$]+))\s*from\s*"([^"]+)";$/gm)) {
    if (m[1]) imported.add(m[1])
    if (m[3]) imported.add(m[3])
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const name = part.split(/\s+as\s+/).pop().trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) imported.add(name)
      }
    }
  }
  // 收集本文件声明的名字（顶层 function / const / let / var）与所有函数形参
  const declared = new Set()
  for (const m of SRC.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)/gm)) {
    declared.add(m[1])
    for (const part of m[2].split(',')) {
      const name = part.split('=')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
    }
  }
  for (const m of SRC.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([\w$]+)/gm)) declared.add(m[1])

  // deps 对象里的 key: value 简写（value 是裸名字）
  const bare = []
  for (const m of block.matchAll(/(^|[\s,{])([A-Za-z_$][\w$]*)\s*(?=,|\s*})/gm)) {
    const name = m[2]
    if (!/^[a-z_$]/i.test(name)) continue
    bare.push(name)
  }
  const missing = [...new Set(bare)].filter((n) => !imported.has(n) && !declared.has(n))
  assert.deepEqual(missing, [], `这些名字在 routeSpecs 的 deps 里被用到，但既没 import 也没声明：${missing.join(',')}`)
})
