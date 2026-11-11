// 红队预设与 0.2.x 宿主的兼容性守卫。
//
// 背景：`@deepseek-ai/dsh-tool-subagent-control/list-agents` 这个 host 子路径
// 在 0.2.x 被移除。随包模板里若还留着它，用户装完就是启动失败；而我们自己的
// 修复函数若不再删它，老用户的既有预设也修不回来。两件事必须同时成立，所以
// 拆成两条独立用例——只查一处会放过另一半。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const template = readFileSync(resolve(root, 'presets/redteam/agent.cordis.yml'), 'utf8')
const host = readFileSync(resolve(root, 'lib/redteam/index.js'), 'utf8')

const OBSOLETE = /@deepseek-ai\/dsh-tool-subagent-control\/list-agents/

test('随包模板不再引用已移除的 host 子路径', () => {
  assert.doesNotMatch(template, OBSOLETE)
})

test('既有预设的修复函数仍在删除这条引用', () => {
  assert.match(host, /stripObsoleteListAgents\(.*\.text\)/)
})
