/**
 * lib/redteam/settings.js —— 并发执行智能体上限（插件级设置，零依赖）。
 *
 * 坏法：`maxAgentsOf` 的优先级搞反（环境变量盖住文件）→ 面板上改了数字、重启后
 * 又变回 3，用户以为设置没保存；`clampMaxAgents` 不夹上下界 → 设 0 变成"一个都不许派"，
 * 设 100 把 API Key 的速率限制打满，靶场扫描自己把自己限流。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_MAX_AGENTS,
  MAX_AGENTS_LIMIT,
  clampMaxAgents,
  maxAgentsOf,
  maxAgentsSourceOf,
  readSettings,
  saveMaxAgents,
  settingsPathOf,
  writeSettings,
} from '../lib/redteam/settings.js'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpurge-set-'))
test.after(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发 EPERM */
  }
})

let seq = 0
function freshRoot(tag = 'r') {
  seq += 1
  const root = path.join(sandbox, `${tag}-${seq}`)
  return root
}

test('settingsPathOf：拼在事实库根目录下，根为空时退化成当前目录', () => {
  assert.equal(settingsPathOf('/data/redteam'), path.join('/data/redteam', 'settings.json'))
  assert.equal(settingsPathOf(''), path.join('.', 'settings.json'))
  assert.equal(settingsPathOf(undefined), path.join('.', 'settings.json'))
  assert.equal(settingsPathOf(null), path.join('.', 'settings.json'))
})

test('readSettings：文件不存在、坏 JSON、非对象三种都当空对象，绝不抛', () => {
  const root = freshRoot()
  assert.deepEqual(readSettings(root), {}, '文件不存在')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(settingsPathOf(root), '{ bad json')
  assert.deepEqual(readSettings(root), {}, '坏 JSON')
  fs.writeFileSync(settingsPathOf(root), '"text"')
  assert.deepEqual(readSettings(root), {}, '字符串不算')
  fs.writeFileSync(settingsPathOf(root), 'null')
  assert.deepEqual(readSettings(root), {}, 'null 不算')
  fs.writeFileSync(settingsPathOf(root), '{"maxAgents":5}')
  assert.deepEqual(readSettings(root), { maxAgents: 5 }, '正常读回来')
})

test('现状锁定：数组形态的 settings.json 会被原样返回（typeof [] === "object"）', () => {
  // 判据是 `parsed && typeof parsed === "object"`，数组也满足。手改坏了文件时
  // readSettings 会返回数组，随后 writeSettings 的 Object.assign({}, 数组, patch)
  // 会摊成 {0:…,1:…} 这样的怪键 —— 不会崩，但设置会「看起来保存成功、其实读不回来」。
  // 这条钉的是当前行为；真要修得先决定「数组算不算坏文件」。
  const root = freshRoot()
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(settingsPathOf(root), '[1,2,3]')
  assert.deepEqual(readSettings(root), [1, 2, 3], '现状：数组原样返回')
  assert.equal(maxAgentsOf(root, {}), DEFAULT_MAX_AGENTS, '读不到 maxAgents → 回落默认值，所以上层不受影响')
})

test('writeSettings：合并写入、自建目录、两空格缩进 + 结尾换行、返回完整设置', () => {
  const root = freshRoot()
  const first = writeSettings(root, { maxAgents: 4 })
  assert.deepEqual(first, { maxAgents: 4 })
  const raw = fs.readFileSync(settingsPathOf(root), 'utf8')
  assert.equal(raw, '{\n  "maxAgents": 4\n}\n', '落盘格式固定')
  const second = writeSettings(root, { other: 'x' })
  assert.deepEqual(second, { maxAgents: 4, other: 'x' }, '合并不覆盖旧键')
  assert.deepEqual(readSettings(root), { maxAgents: 4, other: 'x' })
})

test('writeSettings：根目录不存在时自己建出来', () => {
  const root = path.join(freshRoot('deep'), 'nested', 'root')
  assert.equal(fs.existsSync(root), false)
  writeSettings(root, { maxAgents: 2 })
  assert.equal(fs.existsSync(root), true)
  assert.equal(fs.existsSync(settingsPathOf(root)), true)
})

test('clampMaxAgents：收敛到 [1, 10] 的整数，非法输入回默认值', () => {
  assert.equal(DEFAULT_MAX_AGENTS, 3)
  assert.equal(MAX_AGENTS_LIMIT, 10)
  assert.equal(clampMaxAgents(0), 1, '0 要抬到 1，否则一个智能体都派不出去')
  assert.equal(clampMaxAgents(-5), 1)
  assert.equal(clampMaxAgents(1), 1)
  assert.equal(clampMaxAgents(3), 3)
  assert.equal(clampMaxAgents(10), 10)
  assert.equal(clampMaxAgents(11), 10, '超过硬上限要压回去')
  assert.equal(clampMaxAgents(999), 10)
  assert.equal(clampMaxAgents(3.9), 3, '向下取整')
  assert.equal(clampMaxAgents('7'), 7, '数字串照收')
  assert.equal(clampMaxAgents('abc'), DEFAULT_MAX_AGENTS)
  assert.equal(clampMaxAgents(NaN), DEFAULT_MAX_AGENTS)
  assert.equal(clampMaxAgents(Infinity), DEFAULT_MAX_AGENTS)
  assert.equal(clampMaxAgents(undefined), DEFAULT_MAX_AGENTS)
  assert.equal(clampMaxAgents(null), 1, 'null 转成 0，是有限数 → 走夹取成 1（现状，不是默认值）')
})

test('maxAgentsOf：settings.json 优先，其次环境变量，最后默认 3', () => {
  const root = freshRoot()
  assert.equal(maxAgentsOf(root, {}), DEFAULT_MAX_AGENTS, '都没有就是 3')
  assert.equal(maxAgentsOf(root, { REDTEAM_MAX_AGENTS: '6' }), 6, '环境变量生效')
  writeSettings(root, { maxAgents: 5 })
  assert.equal(maxAgentsOf(root, { REDTEAM_MAX_AGENTS: '6' }), 5, '文件要盖住环境变量')
  writeSettings(root, { maxAgents: 0 })
  assert.equal(maxAgentsOf(root, { REDTEAM_MAX_AGENTS: '6' }), 6, '文件里 0 不算有效值，回落环境变量')
  writeSettings(root, { maxAgents: 'abc' })
  assert.equal(maxAgentsOf(root, { REDTEAM_MAX_AGENTS: 'abc' }), DEFAULT_MAX_AGENTS, '两边都不是数 → 默认')
  assert.equal(maxAgentsOf(root, { REDTEAM_MAX_AGENTS: '99' }), 10, '环境变量也要夹')
  assert.equal(maxAgentsOf(root, { REDTEAM_MAX_AGENTS: '0' }), DEFAULT_MAX_AGENTS, '0 不算有效值')
})

test('maxAgentsSourceOf：如实说明当前值来自哪一层', () => {
  const root = freshRoot()
  assert.equal(maxAgentsSourceOf(root, {}), 'default')
  assert.equal(maxAgentsSourceOf(root, { REDTEAM_MAX_AGENTS: '6' }), 'env')
  writeSettings(root, { maxAgents: 5 })
  assert.equal(maxAgentsSourceOf(root, { REDTEAM_MAX_AGENTS: '6' }), 'settings')
  writeSettings(root, { maxAgents: 0 })
  assert.equal(maxAgentsSourceOf(root, { REDTEAM_MAX_AGENTS: '6' }), 'env', '文件里 0 不算数')
  writeSettings(root, { maxAgents: 0 })
  assert.equal(maxAgentsSourceOf(root, {}), 'default')
})

test('saveMaxAgents：夹取后落盘，并返回实际生效值', () => {
  const root = freshRoot()
  assert.equal(saveMaxAgents(root, 7), 7)
  assert.deepEqual(readSettings(root), { maxAgents: 7 })
  assert.equal(saveMaxAgents(root, 0), 1, '0 落盘成 1')
  assert.deepEqual(readSettings(root), { maxAgents: 1 })
  assert.equal(saveMaxAgents(root, 99), 10)
  assert.deepEqual(readSettings(root), { maxAgents: 10 })
  assert.equal(saveMaxAgents(root, 'abc'), DEFAULT_MAX_AGENTS)
  assert.deepEqual(readSettings(root), { maxAgents: DEFAULT_MAX_AGENTS })
})

test('saveMaxAgents 之后 maxAgentsOf 读到的就是存进去的值（工具侧与面板侧同一份）', () => {
  const root = freshRoot()
  const applied = saveMaxAgents(root, 8)
  assert.equal(maxAgentsOf(root, { REDTEAM_MAX_AGENTS: '2' }), applied, '工具闸门读的是同一份，不被环境变量盖住')
  assert.equal(maxAgentsSourceOf(root, { REDTEAM_MAX_AGENTS: '2' }), 'settings')
})

test('saveMaxAgents 不冲掉其它键（面板以后加设置项也不会互相踩）', () => {
  const root = freshRoot()
  writeSettings(root, { somethingElse: true, maxAgents: 3 })
  saveMaxAgents(root, 6)
  assert.deepEqual(readSettings(root), { somethingElse: true, maxAgents: 6 })
})
