// 13 条 exact 路由的业务分支。
//
// 这些 handler 原来全埋在 lib/index.js 的 installWebServer 里，只有真的跑起
// 宿主、点开设置页才走得到，因此长期零测试。这里用假 request/response 把每条
// 路由的「方法白名单 → 参数校验 → 副作用 → 响应码」整条链跑一遍。
//
// 最贵的一类错是「点了没反应」：例如 /apply 把 405 写成 200、/rewind 忘了校
// sessionId、/restart 在清洗没完成时仍回 ok:true。这些都不会抛异常，用户只能
// 靠肉眼发现按钮没用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routeSpecs } from '../lib/routes.js'
import { getApplyProgress, resetApplyProgress } from '../lib/apply-progress.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dshpurge-routes-'))

test.after(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    // Windows 上偶发 EPERM，交给系统清理。
  }
})

/* ------------------------------------------------------------ 假 request/response */

function makeRequest({ method = 'GET', url = '/dsh-purge/x', body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:43120', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeResponse() {
  const res = { status: 0, headers: {}, body: '', ended: false }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = { ...headers }
  }
  res.end = (chunk) => {
    if (chunk !== undefined) res.body += chunk
    res.ended = true
  }
  return res
}

function jsonOf(res) {
  return res.body ? JSON.parse(res.body) : null
}

async function call(label, request) {
  const entry = routeSpecs(baseDeps()).find((item) => item.label === label)
  assert.ok(entry, `route ${label} 必须存在`)
  const response = makeResponse()
  await entry.spec.handler(request, response)
  return response
}

/* ------------------------------------------------------------ 假依赖 */

function baseDeps() {
  const calls = []
  const home = join(sandbox, 'home')
  const deps = {
    calls,
    home,
    core: {
      findDshHome: () => {
        calls.push(['findDshHome'])
        return home
      },
      gatherState: async () => {
        calls.push(['gatherState'])
        return {
          surface: 'web',
          ai_base: '/ai/base',
          host_version: '0.2.2-rc.1',
          host_target: '0.2.2-rc.1',
          patch_status: { 1: 'applied' },
          display_patches: [{ id: 1, ids: [1], layer: 'host', status: 'applied' }],
          patches_applied: 1,
          dsh_home: home,
        }
      },
      ALL_PATCHES: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }],
      missingAiBaseMessage: () => '找不到宿主',
      getHooksDenySettings: () => ({ hooksDenyBypass: true }),
      refreshHooksDenySettings: () => {
        calls.push(['refreshHooksDenySettings'])
        return { hooksDenyBypass: false }
      },
      setHooksDenySettings: (patch) => {
        calls.push(['setHooksDenySettings', patch])
        return { hooksDenyBypass: patch.hooksDenyBypass }
      },
      applyRuntimeEnv: () => calls.push(['applyRuntimeEnv']),
      clearDesktopLocateCache: () => calls.push(['clearDesktopLocateCache']),
      pinDshHome: () => home,
      sanitizeDesktopCommandRuntimes: () => {
        calls.push(['sanitizeDesktopCommandRuntimes'])
        return { scrubbed: 0 }
      },
      resolveOfficialAiBase: async () => {
        calls.push(['resolveOfficialAiBase'])
        return { aiBase: '/ai/base' }
      },
      writeUnpackedAsarStamp: () => calls.push(['writeUnpackedAsarStamp']),
      readOverrideForUi: async () => {
        calls.push(['readOverrideForUi'])
        return { content: 'c', defaultContent: 'd', customized: false, usingDefault: true, path: '/p' }
      },
      commitOverrideOnApply: async () => calls.push(['commitOverrideOnApply']),
      applyPatchesAllHosts: async () => {
        calls.push(['applyPatchesAllHosts'])
        return { report: [{ patch_id: 1, name: 'one', status: 'applied' }], hosts: [{ aiBase: '/ai/base' }], hookDenyRestoreFailed: [] }
      },
      patchAllShims: async () => {
        calls.push(['patchAllShims'])
        return { cmd: true }
      },
      repairOfficialCliAfterUnpack: () => {
        calls.push(['repairOfficialCliAfterUnpack'])
        return { ok: true }
      },
      silenceCmdFlash: () => {
        calls.push(['silenceCmdFlash'])
        return { ok: true, phase1: 'ok' }
      },
      summarizeApplyReport: () => ({ applied: 1, already: 0, failed: [] }),
      allPatchHostsWritten: () => true,
      hostCleanMarkersPresent: () => false,
      desktopAsarStillSealed: () => false,
      seedPromptInjectAtBoot: () => ({ action: 'seed' }),
      saveOverrideContent: async () => {
        calls.push(['saveOverrideContent'])
        return { defaultContent: 'd' }
      },
      revertAll: async () => {
        calls.push(['revertAll'])
        return { reverted: [1, 2], errors: [] }
      },
      revertAllShims: async () => {
        calls.push(['revertAllShims'])
        return { cmd: true }
      },
      ensureHostClean: async () => {
        calls.push(['ensureHostClean'])
        return { ok: true, pending: [] }
      },
      restartSealedDesktopIfNeeded: () => ({ restarting: true, asarSwap: true }),
    },
    hostctl: {
      currentSurface: () => 'web',
      scheduleRestart: () => {
        calls.push(['scheduleRestart'])
        return { restarting: true }
      },
      restartNote: () => '重启 dsh',
    },
    rewind: {
      readLastUserText: async (_ctx, sessionId) => {
        calls.push(['readLastUserText', sessionId])
        return { ok: true, text: 'hi' }
      },
      analyzeRewind: async (_ctx, sessionId) => {
        calls.push(['analyzeRewind', sessionId])
        return { ok: true, rounds: [] }
      },
      takeDraft: (sessionId) => {
        calls.push(['takeDraft', sessionId])
        return { draft: 'd' }
      },
      getPending: () => {
        calls.push(['getPending'])
        return { pending: 'p' }
      },
      applyRewind: async (_ctx, sessionId, mode) => {
        calls.push(['applyRewind', sessionId, mode])
        return { ok: true, mode }
      },
    },
    updater: {
      localVersion: () => '1.1.94',
      lastUpdateResult: () => ({ ok: true }),
      channelPublic: () => ({ channel: 'stable' }),
      checkUpdate: async () => {
        calls.push(['checkUpdate'])
        return { ok: true, latest: '1.1.95' }
      },
      handleUpdateOp: async (body) => {
        calls.push(['handleUpdateOp', body])
        return { ok: true }
      },
    },
    uninstaller: {
      uninstallPurge: async ({ onStage }) => {
        onStage('revert')
        calls.push(['uninstallPurge'])
        return { ok: true, errors: [], cleanup: ['x'] }
      },
      scheduleCleanupRestart: () => calls.push(['scheduleCleanupRestart']),
    },
    skills: {
      skillsStatus: async () => {
        calls.push(['skillsStatus'])
        return { skills: [] }
      },
    },
    reapply: {
      patchesLostAfterHostReset: () => [],
      markPatchesApplied: () => calls.push(['markPatchesApplied']),
      markSettleRestart: () => calls.push(['markSettleRestart']),
    },
    webState: { ready: true, lastStatusPayload: null },
    setBootFullQuit: (value) => calls.push(['setBootFullQuit', value]),
    refreshHungOperator: (dir) => {
      calls.push(['refreshHungOperator', dir])
      return { text: 'hung' }
    },
    injectSnapshot: () => {
      calls.push(['injectSnapshot'])
      return { injectSource: 'prompt', injectRuleId: null, needPrompt: false }
    },
    rejectIfNeedPrompt: () => null,
    ensureRestartReady: async () => {
      calls.push(['ensureRestartReady'])
      return { ok: true, pending: [] }
    },
  }
  return deps
}

function routeOf(label, deps = baseDeps()) {
  const entry = routeSpecs(deps).find((item) => item.label === label)
  assert.ok(entry, `route ${label} 必须存在`)
  return entry
}

async function run(label, request, deps = baseDeps()) {
  const response = makeResponse()
  await routeOf(label, deps).spec.handler(request, response)
  return response
}

test.beforeEach(() => {
  resetApplyProgress()
})

/* ------------------------------------------------------------ 注册面 */

test('routeSpecs 给出 13 条 exact 路由，路径与标签一一对应', () => {
  const specs = routeSpecs(baseDeps())
  assert.equal(specs.length, 13)
  const paths = specs.map((s) => s.spec.path)
  assert.deepEqual(paths, [
    '/dsh-purge/status',
    '/dsh-purge/hooks-deny',
    '/dsh-purge/last-user',
    '/dsh-purge/rewind/options',
    '/dsh-purge/rewind',
    '/dsh-purge/update',
    '/dsh-purge/apply',
    '/dsh-purge/revert',
    '/dsh-purge/uninstall',
    '/dsh-purge/drill-grant',
    '/dsh-purge/override',
    '/dsh-purge/own-servers',
    '/dsh-purge/restart',
  ])
  for (const item of specs) {
    assert.equal(item.spec.kind, 'exact', `${item.spec.path} 必须是 exact`)
    assert.equal(typeof item.spec.handler, 'function')
    assert.match(item.label, /^dsh-purge: /)
  }
  assert.equal(new Set(specs.map((s) => s.label)).size, 13, '标签不能重复，否则面板会互相覆盖')
})

/* ------------------------------------------------------------ /status */

test('/status 只认 GET，其它方法回 405 且带 Allow', async () => {
  const res = await run('dsh-purge: status', makeRequest({ method: 'POST' }))
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET')
  assert.equal(res.body, '')
})

test('/status 在清洗进行中时回 200 带 apply_progress，并用上次载荷做底', async () => {
  const deps = baseDeps()
  deps.webState = { ready: false, lastStatusPayload: { ok: true, ai_base: '/old' } }
  const { beginApply } = await import('../lib/apply-progress.js')
  beginApply('home')
  const res = await run('dsh-purge: status', makeRequest(), deps)
  assert.equal(res.status, 200)
  const body = jsonOf(res)
  assert.equal(body.ok, true)
  assert.equal(body.ai_base, '/old', '进度期要回上次成功的载荷，否则面板会闪成空白')
  assert.equal(body.ready, true, '有上次载荷就算就绪')
  assert.equal(body.apply_progress.active, true)
})

test('/status 在 web 树没就绪时回 503 而不是假绿', async () => {
  const deps = baseDeps()
  deps.webState = { ready: false, lastStatusPayload: null }
  const res = await run('dsh-purge: status', makeRequest(), deps)
  assert.equal(res.status, 503)
  assert.deepEqual(jsonOf(res).ok, false)
  assert.equal(jsonOf(res).ready, false)
})

test('/status 就绪时给出面板需要的全部字段并缓存载荷', async () => {
  const deps = baseDeps()
  const res = await run('dsh-purge: status', makeRequest(), deps)
  assert.equal(res.status, 200)
  const body = jsonOf(res)
  assert.equal(body.ok, true)
  assert.equal(body.ready, true)
  assert.equal(body.ai_base, '/ai/base')
  assert.equal(body.missing_ai_base, '')
  assert.equal(body.patches_applied, 1)
  assert.equal(body.host_version, '0.2.2-rc.1')
  assert.deepEqual(body.patch_names, { 1: 'one', 2: 'two' })
  assert.deepEqual(body.patches, [{ id: 1, ids: [1], layer: 'host', status: 'applied' }])
  assert.equal(body.plugin_version, '1.1.94')
  assert.equal(body.channel, 'stable')
  assert.equal(body.hooks_deny_bypass, true)
  assert.deepEqual(body.skills, [])
  assert.equal(body.apply_progress.active, false)
  assert.equal(deps.webState.lastStatusPayload.ok, true, '成功的载荷要缓存起来给进度期做底')
})

test('/status 在 gatherState 抛错时回 500 且仍带 apply_progress', async () => {
  const deps = baseDeps()
  deps.core.gatherState = async () => {
    throw new Error('boom')
  }
  const res = await run('dsh-purge: status', makeRequest(), deps)
  assert.equal(res.status, 500)
  assert.match(jsonOf(res).error, /boom/)
  assert.equal(jsonOf(res).apply_progress.active, false)
})

test('/status 找不到宿主时 applied 归零并给出 missing_ai_base', async () => {
  const deps = baseDeps()
  deps.core.gatherState = async () => ({ surface: 'web', ai_base: '', patches_applied: 9, dsh_home: deps.home })
  const res = await run('dsh-purge: status', makeRequest(), deps)
  const body = jsonOf(res)
  assert.equal(body.ai_base, '')
  assert.equal(body.missing_ai_base, '找不到宿主')
  assert.equal(body.patches_applied, 0, '没有宿主时不能把历史计数当成已打补丁')
  assert.equal(body.patches_total, 0)
})

/* ------------------------------------------------------------ /hooks-deny */

test('/hooks-deny GET 走 refreshHooksDenySettings（读盘后再回）', async () => {
  const deps = baseDeps()
  const res = await run('dsh-purge: hooks-deny', makeRequest(), deps)
  assert.equal(res.status, 200)
  assert.equal(jsonOf(res).hooksDenyBypass, false)
  assert.ok(deps.calls.some((c) => c[0] === 'refreshHooksDenySettings'))
})

test('/hooks-deny POST 只接受布尔，字符串 "false" 被拒 400', async () => {
  const res = await run('dsh-purge: hooks-deny', makeRequest({ method: 'POST', body: { hooksDenyBypass: 'false' } }))
  assert.equal(res.status, 400)
  assert.match(jsonOf(res).error, /must be boolean/)
})

test('/hooks-deny POST 写入并回写实际值', async () => {
  const deps = baseDeps()
  const res = await run('dsh-purge: hooks-deny', makeRequest({ method: 'POST', body: { hooksDenyBypass: false } }), deps)
  assert.equal(res.status, 200)
  assert.equal(jsonOf(res).hooksDenyBypass, false)
  assert.deepEqual(deps.calls.find((c) => c[0] === 'setHooksDenySettings'), ['setHooksDenySettings', { hooksDenyBypass: false }])
})

test('/hooks-deny 其它方法回 405 且 Allow 列出两种', async () => {
  const res = await run('dsh-purge: hooks-deny', makeRequest({ method: 'PUT' }))
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, POST')
})

/* ------------------------------------------------------------ /last-user 与 /rewind/options */

test('/last-user 把 sessionId 去掉空白后透传，非 GET 回 405', async () => {
  const deps = baseDeps()
  const ok = await run('dsh-purge: last user', makeRequest({ url: '/dsh-purge/last-user?sessionId=%20s1%20' }), deps)
  assert.equal(ok.status, 200)
  assert.deepEqual(deps.calls.find((c) => c[0] === 'readLastUserText'), ['readLastUserText', 's1'])
  const bad = await run('dsh-purge: last user', makeRequest({ method: 'POST' }))
  assert.equal(bad.status, 405)
  assert.equal(bad.headers.allow, 'GET')
})

test('/rewind/options 透传 sessionId，异常回 500', async () => {
  const deps = baseDeps()
  const res = await run('dsh-purge: rewind options', makeRequest({ url: '/dsh-purge/rewind/options?sessionId=s2' }), deps)
  assert.equal(res.status, 200)
  assert.deepEqual(deps.calls.find((c) => c[0] === 'analyzeRewind'), ['analyzeRewind', 's2'])
  deps.rewind.analyzeRewind = async () => {
    throw new Error('nope')
  }
  const err = await run('dsh-purge: rewind options', makeRequest(), deps)
  assert.equal(err.status, 500)
  assert.match(jsonOf(err).error, /nope/)
})

/* ------------------------------------------------------------ /rewind */

test('/rewind GET 有 sessionId 取草稿，没有则取待定', async () => {
  const deps = baseDeps()
  const draft = await run('dsh-purge: rewind', makeRequest({ url: '/dsh-purge/rewind?sessionId=s3' }), deps)
  assert.equal(jsonOf(draft).draft, 'd')
  const pending = await run('dsh-purge: rewind', makeRequest(), deps)
  assert.equal(jsonOf(pending).pending, 'p')
})

test('/rewind POST 缺 sessionId 回 400（不能把 undefined 当会话去回退）', async () => {
  const res = await run('dsh-purge: rewind', makeRequest({ method: 'POST', body: {} }))
  assert.equal(res.status, 400)
  assert.match(jsonOf(res).error, /sessionId/)
})

test('/rewind POST 只认 mode=round，其它值静默按 once', async () => {
  const deps = baseDeps()
  await run('dsh-purge: rewind', makeRequest({ method: 'POST', body: { sessionId: 's4', mode: 'round' } }), deps)
  await run('dsh-purge: rewind', makeRequest({ method: 'POST', body: { sessionId: 's4', mode: 'ROUND' } }), deps)
  await run('dsh-purge: rewind', makeRequest({ method: 'POST', body: { sessionId: 's4', mode: 'bogus' } }), deps)
  const modes = deps.calls.filter((c) => c[0] === 'applyRewind').map((c) => c[2])
  assert.deepEqual(modes, ['round', 'once', 'once'], '大小写不匹配与未知值都按 once')
})

test('/rewind POST 失败回 409 而不是 200（面板据此判断没回退成功）', async () => {
  const deps = baseDeps()
  deps.rewind.applyRewind = async () => ({ ok: false, error: 'session busy' })
  const res = await run('dsh-purge: rewind', makeRequest({ method: 'POST', body: { sessionId: 's5' } }), deps)
  assert.equal(res.status, 409)
  assert.equal(jsonOf(res).ok, false)
})

test('/rewind 其它方法回 405', async () => {
  const res = await run('dsh-purge: rewind', makeRequest({ method: 'DELETE' }))
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, POST')
})

/* ------------------------------------------------------------ /update */

test('/update GET 走 checkUpdate，POST 走 handleUpdateOp 并透传 body', async () => {
  const deps = baseDeps()
  const got = await run('dsh-purge: update', makeRequest(), deps)
  assert.equal(jsonOf(got).latest, '1.1.95')
  const posted = await run('dsh-purge: update', makeRequest({ method: 'POST', body: { op: 'install' } }), deps)
  assert.equal(posted.status, 200)
  assert.deepEqual(deps.calls.find((c) => c[0] === 'handleUpdateOp'), ['handleUpdateOp', { op: 'install' }])
})

test('/update POST 的 needsFullQuit 会置粘性标记，restartAfter 会排重启', async () => {
  const deps = baseDeps()
  deps.updater.handleUpdateOp = async () => ({ ok: true, needsFullQuit: true, restartAfter: true })
  const res = await run('dsh-purge: update', makeRequest({ method: 'POST', body: {} }), deps)
  assert.equal(res.status, 200)
  assert.ok(deps.calls.some((c) => c[0] === 'setBootFullQuit' && c[1] === true))
  assert.ok(deps.calls.some((c) => c[0] === 'scheduleRestart'))
})

test('/update 其它方法回 405', async () => {
  const res = await run('dsh-purge: update', makeRequest({ method: 'PATCH' }))
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, POST')
})

/* ------------------------------------------------------------ /apply */

test('/apply 只认 POST', async () => {
  const res = await run('dsh-purge: apply', makeRequest())
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'POST')
})

test('/apply 定位失败时回 500 并把进度标成 locate 错误', async () => {
  const deps = baseDeps()
  deps.core.resolveOfficialAiBase = async () => {
    throw new Error('asar 坏了')
  }
  const res = await run('dsh-purge: apply', makeRequest({ method: 'POST', body: {} }), deps)
  assert.equal(res.status, 500)
  assert.match(jsonOf(res).error, /asar 坏了/)
  const progress = getApplyProgress()
  assert.equal(progress.active, false, '失败后进度必须收尾，否则面板一直转圈')
  assert.equal(progress.stage, 'locate')
})

test('/apply 找不到宿主回 500 且不打补丁', async () => {
  const deps = baseDeps()
  deps.core.resolveOfficialAiBase = async () => ({ aiBase: '' })
  const res = await run('dsh-purge: apply', makeRequest({ method: 'POST', body: {} }), deps)
  assert.equal(res.status, 500)
  assert.equal(jsonOf(res).error, '找不到宿主')
  assert.equal(deps.calls.some((c) => c[0] === 'applyPatchesAllHosts'), false)
})

test('/apply 需要提示词时回 400 带 needPrompt 并清掉进度', async () => {
  const deps = baseDeps()
  deps.rejectIfNeedPrompt = () => ({ needPrompt: true, error: '缺提示词', injectSource: 'none' })
  const res = await run('dsh-purge: apply', makeRequest({ method: 'POST', body: { content: '' } }), deps)
  assert.equal(res.status, 400)
  const body = jsonOf(res)
  assert.equal(body.needPrompt, true)
  assert.equal(body.error, '缺提示词')
  assert.equal(body.override_content, '')
  assert.equal(body.defaultContent, 'd')
  assert.equal(getApplyProgress().active, false)
  assert.equal(deps.calls.some((c) => c[0] === 'applyPatchesAllHosts'), false)
})

test('/apply 成功时按顺序走完 定位→override→补丁→shim→flash→seed 并回统计', async () => {
  const deps = baseDeps()
  const res = await run('dsh-purge: apply', makeRequest({ method: 'POST', body: { content: 'x' } }), deps)
  assert.equal(res.status, 200)
  const body = jsonOf(res)
  assert.equal(body.ok, true)
  assert.equal(body.complete, true)
  assert.equal(body.applied, 1)
  assert.equal(body.already, 0)
  assert.equal(body.failed, 0)
  assert.equal(body.override_installed, 'seed')
  assert.equal(body.override_content, 'hung')
  assert.equal(body.injectSource, 'prompt')
  const order = deps.calls.map((c) => c[0]).filter((n) => [
    'applyRuntimeEnv', 'sanitizeDesktopCommandRuntimes', 'gatherState', 'resolveOfficialAiBase',
    'commitOverrideOnApply', 'applyPatchesAllHosts', 'patchAllShims', 'repairOfficialCliAfterUnpack',
    'silenceCmdFlash', 'markPatchesApplied',
  ].includes(n))
  assert.deepEqual(order, [
    'applyRuntimeEnv',
    'sanitizeDesktopCommandRuntimes',
    'gatherState',
    'resolveOfficialAiBase',
    'commitOverrideOnApply',
    'applyPatchesAllHosts',
    'patchAllShims',
    'repairOfficialCliAfterUnpack',
    'silenceCmdFlash',
    'markPatchesApplied',
  ])
  assert.equal(getApplyProgress().stage, 'done')
})

test('/apply 补丁全部 pattern_not_found 时仍算「提示词就绪」并允许重启', async () => {
  const deps = baseDeps()
  deps.core.summarizeApplyReport = () => ({ applied: 0, already: 0, failed: [{ status: 'pattern_not_found' }] })
  const res = await run('dsh-purge: apply', makeRequest({ method: 'POST', body: {} }), deps)
  const body = jsonOf(res)
  assert.equal(body.complete, false, 'complete 只认零失败')
  assert.equal(body.restarting, true, '提示词已写入就重启，不能被对不上版本的代码补丁拦住')
})

test('/apply 有失败且不是 pattern_not_found 时不重启也不标已应用', async () => {
  const deps = baseDeps()
  deps.core.summarizeApplyReport = () => ({ applied: 0, already: 0, failed: [{ status: 'write_failed' }] })
  const res = await run('dsh-purge: apply', makeRequest({ method: 'POST', body: {} }), deps)
  const body = jsonOf(res)
  assert.equal(body.restarting, false)
  assert.equal(deps.calls.some((c) => c[0] === 'markPatchesApplied'), false)
  assert.equal(getApplyProgress().error, 'incomplete')
})

test('/apply 抛错时回 500 并收尾进度', async () => {
  const deps = baseDeps()
  deps.core.applyPatchesAllHosts = async () => {
    throw new Error('patch boom')
  }
  const res = await run('dsh-purge: apply', makeRequest({ method: 'POST', body: {} }), deps)
  assert.equal(res.status, 500)
  assert.match(jsonOf(res).error, /patch boom/)
  assert.equal(getApplyProgress().active, false)
})

/* ------------------------------------------------------------ /revert */

test('/revert 只认 POST，有宿主时同时回滚补丁与 shim', async () => {
  const deps = baseDeps()
  const bad = await run('dsh-purge: revert', makeRequest(), deps)
  assert.equal(bad.status, 405)
  const res = await run('dsh-purge: revert', makeRequest({ method: 'POST' }), deps)
  assert.equal(res.status, 200)
  const body = jsonOf(res)
  assert.equal(body.reverted, 2)
  assert.equal(body.errors, 0)
  assert.equal(body.shim.cmd, true)
  assert.match(body.note, /prompt-inject\.md 保留/)
  assert.equal(getApplyProgress().kind, 'revert')
})

test('/revert 没有宿主时跳过 revertAll 但仍收 shim', async () => {
  const deps = baseDeps()
  deps.core.gatherState = async () => ({ ai_base: '', dsh_home: deps.home })
  const res = await run('dsh-purge: revert', makeRequest({ method: 'POST' }), deps)
  assert.equal(res.status, 200)
  assert.equal(jsonOf(res).reverted, undefined)
  assert.equal(deps.calls.some((c) => c[0] === 'revertAll'), false)
  assert.equal(deps.calls.some((c) => c[0] === 'revertAllShims'), true)
})

test('/revert 回滚出错时进度标 incomplete', async () => {
  const deps = baseDeps()
  deps.core.revertAll = async () => ({ reverted: [1], errors: ['e'] })
  await run('dsh-purge: revert', makeRequest({ method: 'POST' }), deps)
  assert.equal(getApplyProgress().error, 'incomplete')
})

/* ------------------------------------------------------------ /uninstall */

test('/uninstall 成功时回 200 并排清理重启', async () => {
  const deps = baseDeps()
  const bad = await run('dsh-purge: uninstall', makeRequest(), deps)
  assert.equal(bad.status, 405)
  const res = await run('dsh-purge: uninstall', makeRequest({ method: 'POST' }), deps)
  assert.equal(res.status, 200)
  assert.equal(jsonOf(res).ok, true)
  assert.equal(jsonOf(res).fullApp, false)
  assert.ok(deps.calls.some((c) => c[0] === 'scheduleCleanupRestart'))
})

test('/uninstall 失败时回 500 且不排重启', async () => {
  const deps = baseDeps()
  deps.uninstaller.uninstallPurge = async () => ({ ok: false, errors: ['还原失败'] })
  const res = await run('dsh-purge: uninstall', makeRequest({ method: 'POST' }), deps)
  assert.equal(res.status, 500)
  assert.equal(deps.calls.some((c) => c[0] === 'scheduleCleanupRestart'), false)
  assert.equal(getApplyProgress().error, '还原失败')
})

/* ------------------------------------------------------------ /drill-grant */

test('/drill-grant GET 未授权时 granted=false，POST 后变 true 并落盘', async () => {
  const deps = baseDeps()
  const first = await run('dsh-purge: drill-grant', makeRequest(), deps)
  assert.equal(first.status, 200)
  assert.equal(jsonOf(first).granted, false)
  const second = await run('dsh-purge: drill-grant', makeRequest({ method: 'POST' }), deps)
  assert.equal(jsonOf(second).granted, true)
  assert.ok(jsonOf(second).at)
  const third = await run('dsh-purge: drill-grant', makeRequest(), deps)
  assert.equal(jsonOf(third).granted, true, '授权要落盘，插件升级后不再弹窗')
})

test('/drill-grant 其它方法回 405', async () => {
  const res = await run('dsh-purge: drill-grant', makeRequest({ method: 'DELETE' }))
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, POST')
})

/* ------------------------------------------------------------ /override */

test('/override GET 先 seed 再读，回 ui 与注入快照', async () => {
  const deps = baseDeps()
  const res = await run('dsh-purge: override', makeRequest(), deps)
  assert.equal(res.status, 200)
  const body = jsonOf(res)
  assert.equal(body.ok, true)
  assert.equal(body.content, 'c')
  assert.equal(body.defaultContent, 'd')
  assert.equal(body.injectSource, 'prompt')
  assert.ok(deps.calls.some((c) => c[0] === 'refreshHungOperator'))
})

test('/override POST 非字符串回 400（null 不能当成「清空」写进去）', async () => {
  const res = await run('dsh-purge: override', makeRequest({ method: 'POST', body: { content: 42 } }))
  assert.equal(res.status, 400)
  assert.match(jsonOf(res).error, /content must be a string/)
})

test('/override POST 需要提示词时回 400 且不回显已保存内容', async () => {
  const deps = baseDeps()
  deps.rejectIfNeedPrompt = () => ({ needPrompt: true, error: '缺提示词' })
  const res = await run('dsh-purge: override', makeRequest({ method: 'POST', body: { content: '' } }), deps)
  assert.equal(res.status, 400)
  assert.equal(jsonOf(res).content, '')
  assert.equal(deps.calls.some((c) => c[0] === 'saveOverrideContent'), false)
})

test('/override POST 保存成功后回写框里的实际正文', async () => {
  const deps = baseDeps()
  const res = await run('dsh-purge: override', makeRequest({ method: 'POST', body: { content: 'new' } }), deps)
  assert.equal(res.status, 200)
  assert.equal(jsonOf(res).content, 'hung')
  assert.equal(jsonOf(res).defaultContent, 'd')
  assert.ok(deps.calls.some((c) => c[0] === 'saveOverrideContent'))
})

/* ------------------------------------------------------------ /own-servers */

test('/own-servers GET 读白名单，POST 非字符串回 400', async () => {
  const deps = baseDeps()
  const got = await run('dsh-purge: own-servers', makeRequest(), deps)
  assert.equal(got.status, 200)
  assert.equal(typeof jsonOf(got).content, 'string')
  const bad = await run('dsh-purge: own-servers', makeRequest({ method: 'POST', body: { content: null } }), deps)
  assert.equal(bad.status, 400)
  assert.match(jsonOf(bad).error, /content must be a string/)
})

// 现状锁定：writeAllowText 在 1.1.94 里是个空壳（`allowCache = ...` 引用了未声明
// 的变量，且忽略入参），所以 POST 永远 500。这不是本轮改出来的——基线提交里
// lib/net-scope.js 一字未动。它和地域闸门、解限逻辑同属上游刻意留空的部分，
// 修它属于产品决策（要不要恢复自建服务器白名单），不属于测试机制这一轮。
// 钉住它的意义：谁哪天「顺手」把它改成返回 200 但不落盘，这条会红。
test('/own-servers POST 当前回 500（writeAllowText 是上游空壳，非本轮引入）', async () => {
  const deps = baseDeps()
  const res = await run('dsh-purge: own-servers', makeRequest({ method: 'POST', body: { content: 'https://a.example\n' } }), deps)
  assert.equal(res.status, 500)
  assert.match(jsonOf(res).error, /allowCache is not defined/)
})

test('/own-servers 其它方法回 405', async () => {
  const res = await run('dsh-purge: own-servers', makeRequest({ method: 'PUT' }))
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, POST')
})

/* ------------------------------------------------------------ /restart */

test('/restart 只认 POST', async () => {
  const res = await run('dsh-purge: restart', makeRequest())
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'POST')
})

test('/restart 清洗没完成时回 ok:false 并清掉粘性标记', async () => {
  const deps = baseDeps()
  deps.ensureRestartReady = async () => ({ ok: false, error: '还有 3 条没打上', pending: [1, 2, 3] })
  const res = await run('dsh-purge: restart', makeRequest({ method: 'POST' }), deps)
  assert.equal(res.status, 200)
  const body = jsonOf(res)
  assert.equal(body.ok, false)
  assert.equal(body.restarting, false)
  assert.deepEqual(body.pending, [1, 2, 3])
  assert.ok(deps.calls.some((c) => c[0] === 'setBootFullQuit' && c[1] === false))
  assert.equal(deps.calls.some((c) => c[0] === 'scheduleRestart'), false)
})

test('/restart 计划里 clean=false 时取消重启（写不进宿主就别重启）', async () => {
  const deps = baseDeps()
  deps.hostctl.scheduleRestart = () => ({ restarting: true, clean: false })
  const res = await run('dsh-purge: restart', makeRequest({ method: 'POST' }), deps)
  assert.equal(jsonOf(res).ok, false)
  assert.match(jsonOf(res).error, /清洗没有写进当前宿主/)
  assert.equal(jsonOf(res).restarting, false)
})

test('/restart 正常路径回 restarting 与 asar 状态', async () => {
  const deps = baseDeps()
  const res = await run('dsh-purge: restart', makeRequest({ method: 'POST' }), deps)
  assert.equal(res.status, 200)
  const body = jsonOf(res)
  assert.equal(body.ok, true)
  assert.equal(body.restarting, true)
  assert.equal(body.surface, 'web')
  assert.equal(body.fullApp, false)
  assert.equal(body.note, '正在重启。')
})

test('/restart 密封包走 restartSealedDesktopIfNeeded 并标 needsFullQuit', async () => {
  const deps = baseDeps()
  deps.core.desktopAsarStillSealed = () => true
  const res = await run('dsh-purge: restart', makeRequest({ method: 'POST' }), deps)
  const body = jsonOf(res)
  assert.equal(body.needsFullQuit, true)
  assert.equal(body.restarting, true)
  assert.equal(deps.calls.some((c) => c[0] === 'scheduleRestart'), false, '密封包不能走普通重启')
})

test('/restart 抛错回 500', async () => {
  const deps = baseDeps()
  deps.ensureRestartReady = async () => {
    throw new Error('clean boom')
  }
  const res = await run('dsh-purge: restart', makeRequest({ method: 'POST' }), deps)
  assert.equal(res.status, 500)
  assert.match(jsonOf(res).error, /clean boom/)
})
