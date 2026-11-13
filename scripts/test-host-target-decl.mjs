// 版本声明的对外契约（lib/core.js 的 HOST_TARGETS / HOST_TARGET / hostCompat）。
//
// 为什么单独守这一批：
// 1) 状态页那句「← 未适配：插件声明 X」完全由 hostCompat().ok 决定，
//    而 ok 的比较对象是 package.json 里的 dshTarget 叠 dshTargets。
//    这里一旦算错，症状不是报错，是桌面版升级后状态页一直喊「未适配」，
//    或者反过来：明明是没适配过的新版本，也一片绿。
// 2) HOST_TARGETS 是从 package.json 现算的模块级常量，`dshTarget` 会被
//    unshift 到最前，所以 dshTargets 的数组顺序并不决定 HOST_TARGETS[0]。
//    这条「谁在前」的规则没有写在任何文档里，只存在于那几行 IIFE 里。
// 3) 这批断言全部用假 aiBase 树，不读本机真实安装：本机装的是 rc.1，
//    拿它当断言基准会让「升级到 rc.2 之后测试全绿但其实没适配」变成常态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_TARGET, HOST_TARGETS, hostCompat, parseHostVersion, readHostVersion } from '../lib/core.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const sandbox = mkdtempSync(join(tmpdir(), 'dshpurge-hosttarget-'))

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

/** 造一棵只有版本声明的假宿主树：<tag>/dsh/node_modules/@deepseek-ai/dsh/package.json */
function hostTree(tag, version, name = '@deepseek-ai/dsh') {
  const aiBase = join(sandbox, tag, 'dsh', 'node_modules', '@deepseek-ai')
  const fp = join(aiBase, 'dsh', 'package.json')
  mkdirSync(dirname(fp), { recursive: true })
  writeFileSync(fp, JSON.stringify({ name, version }))
  return aiBase
}

/* --------------------------------------------------- 声明本身 */

test('HOST_TARGETS 首位就是 dshTarget，不取决于 dshTargets 的书写顺序', () => {
  // dshTarget 会被 unshift 到最前；即便有人把一个旧版本写进 dshTargets[0]，
  // HOST_TARGETS[0] 仍然是 dshTarget。这条钉的是那个 unshift。
  assert.equal(HOST_TARGETS[0], manifest.dshTarget)
  assert.equal(HOST_TARGET, manifest.dshTarget)
})

test('HOST_TARGETS = dshTarget + dshTargets，去重且保持声明顺序', () => {
  const expected = [...new Set([manifest.dshTarget, ...manifest.dshTargets])]
  assert.deepEqual(HOST_TARGETS, expected)
  assert.equal(new Set(HOST_TARGETS).size, HOST_TARGETS.length)
})

test('HOST_TARGETS 每一项都是可解析的版本号', () => {
  // hostCompat 里 any 解析不了的目标会被 Boolean(b) 静默跳过，于是「声明了
  // 一个打错的版本」等于「少声明一个版本」，只在升级当天才暴露。
  for (const target of HOST_TARGETS) {
    assert.ok(parseHostVersion(target), `unparseable target: ${target}`)
  }
})

/* --------------------------------------------------- hostCompat 判定 */

test('hostCompat：最高声明版本命中 → ok:true', () => {
  const aiBase = hostTree('top', HOST_TARGETS[0])
  const res = hostCompat(aiBase)
  assert.equal(res.known, true)
  assert.equal(res.ok, true)
  assert.equal(res.host, HOST_TARGETS[0])
  // target 是人类可读的一整串，状态页直接拿它显示。
  assert.equal(res.target, HOST_TARGETS.join(' / '))
  assert.ok(res.path.endsWith(join('dsh', 'package.json')))
})

test('hostCompat：次级声明版本仍然命中（降级回旧版不该报未适配）', () => {
  for (const target of HOST_TARGETS.slice(1)) {
    const res = hostCompat(hostTree('legacy-' + target.replace(/[^\w]/g, '-'), target))
    assert.equal(res.ok, true, target)
  }
})

test('hostCompat：没声明过的版本一律 ok:false，但仍 known:true', () => {
  // 关键区别：known 说的是「读到了宿主版本」，ok 说的是「声明里认它」。
  // 把没声明的版本判成 known:false 会让状态页什么都不显示，比报警更糟。
  const res = hostCompat(hostTree('future', '0.3.0-rc.1'))
  assert.equal(res.known, true)
  assert.equal(res.ok, false)
  assert.equal(res.host, '0.3.0-rc.1')
})

test('hostCompat：预发布后缀必须原样相等（0.2.2 ≠ 0.2.2-rc.2）', () => {
  const base = hostTree('presuffix', '0.2.2-rc.2')
  assert.equal(hostCompat(base, ['0.2.2']).ok, false)
  assert.equal(hostCompat(base, ['0.2.2-rc.2']).ok, true)
  // 大小写也算不同：parseHostVersion 保留原样，比较时不做 lowerCase。
  assert.equal(hostCompat(base, ['0.2.2-RC.2']).ok, false)
})

/* --------------------------------------------------- gatherState 的落点 */

test('状态页字段：host_supported 只在明确不兼容时才为 false', () => {
  // gatherState 用 `hostInfo.ok !== false`，也就是 ok:null（读不到宿主）算支持。
  // 这条钉住「读不到 ≠ 不支持」，否则没有 aiBase 的机器上状态页会满天报警。
  const unknown = hostCompat(join(sandbox, 'nope'), HOST_TARGETS)
  assert.equal(unknown.known, false)
  assert.equal(unknown.ok, null)
  assert.equal(unknown.ok !== false, true)

  const bad = hostCompat(hostTree('badver', 'beta'), HOST_TARGETS)
  assert.equal(bad.known, false)
  assert.equal(bad.ok, null)
  assert.equal(bad.host, 'beta')
  // 版本读到了但解析不了：host 有值、path 有值，只是没法下结论。
  assert.ok(bad.path.length > 0)
})

test('readHostVersion 与 hostCompat 对同一棵树给出同一个版本', () => {
  const aiBase = hostTree('agree', '0.2.2-rc.2')
  const read = readHostVersion(aiBase)
  const compat = hostCompat(aiBase)
  assert.equal(read.version, compat.host)
  assert.equal(read.path, compat.path)
})
