// P2-6b「安装真相」的回归测试：路由载荷 + 两处渲染出口。
//
// 这层的风险不是崩，而是「把读不到说成没问题」：宿主体检要说明白 ok 与有缺口，
// 最近安装、profile 版本、SLOT 长度读不到时要显形，null 不许被渲染成 0 或 ok。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { routeSpecs, installTruthPayload } from '../lib/routes.js'
import { renderStatus, installTruthLines } from '../lib/status-render.js'
import { resetApplyProgress } from '../lib/apply-progress.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dshpurge-install-truth-'))
test.after(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    // Windows 上偶发 EPERM，交给系统清理。
  }
})

/* ------------------------------------------------------------ 假 request/response */
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
function statusRequest() {
  return { method: 'GET', url: '/dsh-purge/status', headers: { host: '127.0.0.1:43120' } }
}

/* ------------------------------------------------------------ 安装真相 fixture */
function okIntegrity() {
  return {
    ok: true,
    unpackedMissing: [],
    unpackedMissingCount: 0,
    unpackedChecked: true,
    requireBuiltin: [],
    requireBuiltinCount: 0,
    nativeCount: 2,
    problems: [],
    reason: '',
  }
}
function gapIntegrity() {
  return {
    ok: false,
    unpackedMissing: ['client.js', 'lib/host.js'],
    unpackedMissingCount: 2,
    unpackedChecked: false,
    requireBuiltin: ['electron'],
    requireBuiltinCount: 1,
    nativeCount: 0,
    problems: ['unpacked 缺 2 个', 'require 内建缺 1 个'],
    reason: 'unpacked_missing',
  }
}
function okLastInstall() {
  return {
    state: 'ok',
    version: '1.1.101',
    at: '2026-11-20T10:00:00Z',
    previousVersion: '1.1.100',
    kind: 'install',
    note: '',
  }
}
function truthFixture(overrides = {}) {
  return {
    surface: 'web',
    ai_base: '/ai/base',
    dsh_home: join(sandbox, 'home'),
    host_version: '0.2.2-rc.1',
    host_target: '0.2.2-rc.1',
    host_supported: true,
    display_patches: [{ id: 1, ids: [1], layer: 'host', status: 'applied' }],
    patch_status: { 1: 'applied' },
    patches_applied: 1,
    hostVersion: '0.2.2-rc.1',
    hostIntegrity: okIntegrity(),
    lastInstall: okLastInstall(),
    slotLength: 4210,
    openSlotLength: 4096,
    profileVersion: '1.1.101',
    installTruth: {
      reason: '',
      reasons: {},
      resources: '/res',
      profile: 'default',
      profileDir: join(sandbox, 'profile'),
      pluginDir: '/plugin',
      journalPath: join(sandbox, 'journal.json'),
    },
    ...overrides,
  }
}

function depsFor(state) {
  return {
    core: {
      gatherState: async () => state,
      ALL_PATCHES: [{ id: 1, name: 'one' }],
      findDshHome: () => join(sandbox, 'home'),
      missingAiBaseMessage: () => '找不到宿主',
      getHooksDenySettings: () => ({ hooksDenyBypass: true }),
    },
    hostctl: { currentSurface: () => 'web' },
    updater: {
      localVersion: () => '1.1.101',
      lastUpdateResult: () => ({ ok: true }),
      channelPublic: () => ({ channel: 'stable' }),
    },
    skills: { skillsStatus: async () => ({ skills: [] }) },
    reapply: { patchesLostAfterHostReset: () => [] },
    webState: { ready: true, lastStatusPayload: null },
  }
}

async function statusPayload(state) {
  resetApplyProgress()
  const entry = routeSpecs(depsFor(state)).find((item) => item.label === 'dsh-purge: status')
  assert.ok(entry, '/dsh-purge/status 路由必须存在')
  const response = makeResponse()
  await entry.spec.handler(statusRequest(), response)
  assert.equal(response.status, 200)
  return JSON.parse(response.body)
}

/* ------------------------------------------------------------ 路由载荷 */

test('install_truth：完整 ok 载荷逐个字段落到路由输出', async () => {
  const payload = await statusPayload(truthFixture())
  const truth = payload.install_truth
  assert.ok(truth && typeof truth === 'object', 'install_truth 必须存在')
  assert.equal(truth.host_version, '0.2.2-rc.1')
  assert.deepEqual(truth.host_integrity, okIntegrity())
  assert.deepEqual(truth.last_install, okLastInstall())
  assert.equal(truth.slot_length, 4210)
  assert.equal(truth.open_slot_length, 4096)
  assert.equal(truth.profile_version, '1.1.101')
  assert.equal(truth.plugin_version, '1.1.101')
  assert.deepEqual(truth.reasons, {})
  assert.equal(truth.resources, '/res')
  assert.equal(truth.profile, 'default')
  assert.equal(truth.profile_dir, join(sandbox, 'profile'))
  assert.equal(truth.plugin_dir, '/plugin')
  assert.equal(truth.journal_path, join(sandbox, 'journal.json'))
})

test('install_truth：旧字段 host_version / host_supported 没被删掉或改名', async () => {
  const payload = await statusPayload(truthFixture())
  assert.equal(payload.host_version, '0.2.2-rc.1')
  assert.equal(payload.host_target, '0.2.2-rc.1')
  assert.equal(payload.host_supported, true)
  assert.equal(typeof payload.plugin_version, 'string')
})

test('install_truth：gatherState 没给 installTruth 时字段仍齐全、原因表退化成空对象', async () => {
  const truth = (await statusPayload(truthFixture({ installTruth: undefined }))).install_truth
  assert.deepEqual(truth.reasons, {})
  assert.equal(truth.resources, '')
  assert.equal(truth.profile_dir, '')
  assert.equal(truth.journal_path, '')
})

test('install_truth：slotLength 为 null / 字符串时给 null，不给 0', () => {
  assert.equal(installTruthPayload({ slotLength: null }, '1.0.0').slot_length, null)
  assert.equal(installTruthPayload({ slotLength: '4210' }, '1.0.0').slot_length, null)
  assert.equal(installTruthPayload({}, '1.0.0').open_slot_length, null)
  assert.equal(installTruthPayload({ slotLength: 0 }, '1.0.0').slot_length, 0)
})

/* ------------------------------------------------------------ 渲染出口 */

function renderFixture(overrides = {}) {
  return {
    ...truthFixture(overrides),
    pluginVersion: '1.1.101',
    // renderStatus 还会渲染这些常规段：给最小可渲染值，别让用例被无关字段带崩。
    files: {},
    shim_dir: '/shim',
    shim_scope: 'path',
    shim_cmd: '/shim/dsh.cmd',
    shim_ps1: '/shim/dsh.ps1',
    shim_bin: '/shim/dsh',
    has_backup: true,
    override_path: '/o/prompt-inject.md',
    override_status: 'ok',
    asar_still_sealed: false,
  }
}

function rowsOf(state) {
  return renderStatus(state).split('\n')
}

test('renderStatus：ok 载荷下六类行全在，且都是勾', () => {
  const out = rowsOf(renderFixture())
  assert.ok(out.includes('✓ 宿主体检 / host integrity: ok（unpacked 已校验，原生绑定 2 个）'))
  assert.ok(out.some((l) => l.startsWith('✓ 最近安装 / last install: ok install 1.1.101（此前 1.1.100）')))
  assert.ok(out.includes('✓ profile 版本 / profile vs plugin: 1.1.101（一致）'))
  assert.ok(out.includes('✓ SLOT 长度 / slot length: 4210（未打补丁侧 4096）'))
})

test('renderStatus：宿主体检有缺口时点名原因与缺失项，不是 ok', () => {
  const out = rowsOf(renderFixture({ hostIntegrity: gapIntegrity() }))
  const head = out.find((l) => l.includes('宿主体检 / host integrity'))
  assert.ok(head.startsWith('✗ '), '有缺口必须打叉：' + head)
  assert.match(head, /有缺口 → unpacked 缺 2 个；require 内建缺 1 个/)
  assert.ok(out.some((l) => l.includes('缺 unpacked: 2 项')))
  assert.ok(out.some((l) => l.includes('缺 unpacked 明细: client.js, lib/host.js')))
  assert.ok(out.some((l) => l.includes('缺 require 内建: electron')))
})

test('renderStatus：lastInstall=null 时按原因显示读不到，而不是 ok', () => {
  const state = renderFixture({
    lastInstall: null,
    installTruth: { ...truthFixture().installTruth, reasons: { lastInstall: 'journal 不存在' } },
  })
  const row = rowsOf(state).find((l) => l.includes('最近安装 / last install'))
  assert.ok(row.startsWith('✗ '), row)
  assert.match(row, /读不到/)
  assert.match(row, /journal 不存在/)
})

test('renderStatus：lastInstall state=done 勾、rolled-back 叉', () => {
  const done = rowsOf(renderFixture({ lastInstall: { state: 'done', version: '1.1.101', at: '', previousVersion: '', kind: 'install', note: '' } }))
    .find((l) => l.includes('最近安装 / last install'))
  assert.ok(done.startsWith('✓ '), done)
  const rolled = rowsOf(renderFixture({ lastInstall: { state: 'rolled-back', version: '1.1.101', at: '', previousVersion: '', kind: 'install', note: '' } }))
    .find((l) => l.includes('最近安装 / last install'))
  assert.ok(rolled.startsWith('✗ '), rolled)
})

test('renderStatus：profile 版本与插件版本不一致时两个值都写出并标记不一致', () => {
  const row = rowsOf(renderFixture({ profileVersion: '1.1.99' }))
    .find((l) => l.includes('profile 版本 / profile vs plugin'))
  assert.ok(row.startsWith('✗ '), row)
  assert.match(row, /1\.1\.99/)
  assert.match(row, /插件 1\.1\.101/)
  assert.match(row, /不一致/)
})

test('renderStatus：slotLength=null 不显示 0，也不显示旧值', () => {
  const out = rowsOf(renderFixture({ slotLength: null, openSlotLength: null }))
  const row = out.find((l) => l.includes('SLOT 长度 / slot length'))
  assert.ok(row.startsWith('✗ '), row)
  assert.match(row, /读不到/)
  assert.ok(!/: 0\b/.test(row), row)
})

test('installTruthLines：prefix 原样加在每行之前（给 CLI 缩进用）', () => {
  const rows = installTruthLines(renderFixture(), { prefix: '  ', pluginVersion: '1.1.101' })
  assert.ok(rows.length >= 4)
  assert.ok(rows.every((r) => r.startsWith('  ')))
})

test('installTruthLines：状态里的下划线字段（路由载荷形状）也能渲染', () => {
  const rows = installTruthLines({
    host_version: '0.2.2-rc.1',
    host_integrity: gapIntegrity(),
    last_install: null,
    slot_length: null,
    profile_version: '',
    plugin_version: '1.1.101',
    reasons: { host: '宿主目录没找到', slot: 'SLOT 段没找到', lastInstall: '无 journal' },
  })
  assert.ok(rows.some((r) => r.includes('无 journal')))
  assert.ok(rows.some((r) => r.includes('SLOT 段没找到')))
  assert.ok(rows.some((r) => r.includes('profile 版本 / profile vs plugin') && r.includes('读不到')))
})

/* ------------------------------------------------------------ CLI 复用 */

test('CLI --status 复用同一个渲染函数，而不是各写一套文案', () => {
  const binSrc = readFileSync(new URL('../bin/dsh-purge.js', import.meta.url), 'utf8')
  assert.match(binSrc, /import \{ installTruthLines \} from "\.\.\/lib\/status-render\.js"/)
  assert.match(binSrc, /installTruthLines\(state, \{ prefix: "  ", pluginVersion \}\)/)
  assert.match(binSrc, /const pluginVersion = localVersion\(\)/)
})
