// #195 回归：resources/runtime 被清空后，插件必须能自己发现并原地补齐。
//
// 背景：DSH 桌面版把 node/pnpm/python 放在 resources/runtime/primary-runtime，
// 插件市场的每一次安装/更新/回滚都 execa 那个 pnpm.mjs；目录一空，
// 全部操作就 Error: Cannot find module ...pnpm\bin\pnpm.mjs (MODULE_NOT_FOUND)，
// 而状态页仍然显示"已应用"——最坏的失败模式：报假绿灯。
//
// 六个场景以前是一条断言链，第一处失败后面五条根本不跑。而这里的场景是
// 互相独立的失败模式（探测 / 自愈 / 幂等 / 半残 / 无来源 / 坏来源），
// 恰恰最需要一次看全。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspectRuntimePayload, healRuntimePayload } from '../lib/desktop.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dshpurge-runtime-'))
const PKG = '737280' // 标记内容，便于确认真的是从 source 复制的
const NODE_BIN = process.platform === 'win32' ? 'node.exe' : 'node'

function put(fp, bytes, fill = 'x') {
  mkdirSync(resolve(fp, '..'), { recursive: true })
  writeFileSync(fp, fill.repeat(Math.ceil(bytes / fill.length)))
}

/** 造一份健康的宿主 root 副本（~/.dsh/dsh-runtimes/dsh-primary-runtime）。 */
function makeSource(dir, { withPnpm = true, withNode = true } = {}) {
  const dep = join(dir, 'dependencies')
  if (withPnpm) put(join(dep, 'pnpm', 'bin', 'pnpm.mjs'), 4096, PKG)
  if (withNode) put(join(dep, 'node', 'bin', NODE_BIN), 2 << 20, 'N')
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ desktopVersion: '0.2.2-rc.1' }))
  return dir
}

/** 造一个被清空过的桌面安装：resources/app 在，resources/runtime 空。 */
function makeBrokenInstall(tag) {
  const resources = join(sandbox, tag, 'resources')
  mkdirSync(join(resources, 'app'), { recursive: true })
  mkdirSync(join(resources, 'runtime'), { recursive: true })
  return resources
}

test('空 runtime 被判定为坏，并点名缺了什么', () => {
  const broken = makeBrokenInstall('empty')
  const probe = inspectRuntimePayload(broken)
  assert.equal(probe.ok, false, 'empty runtime must not report ok')
  assert.ok(probe.missing.some((m) => m.includes('pnpm.mjs')), 'must name pnpm.mjs as missing')
  assert.ok(probe.missing.some((m) => m.startsWith('bin/')), 'must name the bin/node launcher as missing')
})

test('自愈：从宿主 root 副本补齐 primary-runtime + bin/node', () => {
  const broken = makeBrokenInstall('heal')
  const source = makeSource(join(sandbox, 'src', 'dsh-primary-runtime'))
  const healed = healRuntimePayload(broken, { sources: [source] })
  assert.equal(healed.ok, true, 'heal must end ok: ' + JSON.stringify(healed))
  assert.equal(healed.healed, true, 'first heal must report healed')
  assert.ok(healed.copied.includes('primary-runtime'), 'must copy primary-runtime')
  assert.ok(healed.copied.includes(`bin/${NODE_BIN}`), 'must restore bin/node')
  assert.ok(existsSync(join(broken, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')))
  assert.equal(inspectRuntimePayload(broken).ok, true, 'probe must be ok after heal')
  if (process.platform === 'win32') {
    assert.ok(existsSync(join(broken, 'runtime', 'bin', 'node.cmd')), 'windows launcher shim must exist')
  }
})

test('幂等：已经好的 runtime 再修一次不动盘', () => {
  const broken = makeBrokenInstall('idem')
  const source = makeSource(join(sandbox, 'src-idem', 'dsh-primary-runtime'))
  assert.equal(healRuntimePayload(broken, { sources: [source] }).healed, true)
  const again = healRuntimePayload(broken, { sources: [source] })
  assert.equal(again.ok, true)
  assert.equal(again.healed, false, 'second heal must be a no-op')
})

test('半残目录（只剩 node 没有 pnpm）能修，且旧目录挪走留证', () => {
  const half = makeBrokenInstall('half')
  const halfSrc = makeSource(join(sandbox, 'src2', 'dsh-primary-runtime'))
  put(join(half, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', NODE_BIN), 2 << 20, 'O')
  const halfHealed = healRuntimePayload(half, { sources: [halfSrc] })
  assert.equal(halfHealed.ok, true, 'half-broken runtime must heal: ' + JSON.stringify(halfHealed))
  assert.ok(halfHealed.stale && existsSync(halfHealed.stale), 'stale primary-runtime must be moved aside, not deleted')
  const dirs = readdirSync(join(half, 'runtime')).filter((n) => n.includes('dshpurge-stale-'))
  assert.equal(dirs.length, 1, 'exactly one stale copy kept')
})

test('没有可用来源时如实报错，不能假装修好', () => {
  const orphan = makeBrokenInstall('orphan')
  const failed = healRuntimePayload(orphan, { sources: [join(sandbox, 'nope', 'dsh-primary-runtime')] })
  assert.equal(failed.ok, false, 'must not claim ok without a source')
  assert.ok(failed.errors.includes('still_missing'), 'must report still_missing: ' + JSON.stringify(failed))
})

test('来源本身残缺（缺 pnpm）不能被当成来源', () => {
  const badSrc = makeSource(join(sandbox, 'src3', 'dsh-primary-runtime'), { withPnpm: false })
  const orphan2 = makeBrokenInstall('orphan2')
  const failed2 = healRuntimePayload(orphan2, { sources: [badSrc] })
  assert.equal(failed2.ok, false, 'incomplete source must be rejected')
  assert.equal(failed2.source, null, 'must not record a bad source')
})

test.after(() => {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* windows 上偶尔占用 */ }
})
