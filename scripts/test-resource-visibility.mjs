// 演练台「知识库 / 技能库」必须对用户可见可用。
//
// 这几条都是「有人为了让某处安静下来而顺手关掉一个功能」的防线：
// 关掉 tab、去掉路由、把接口改成返回错误。任何一处被关，用户的资源就白随包发了。
// 拆成独立用例，是为了下次真被关掉时能立刻看出关的是 tab、路由还是接口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ui = readFileSync(resolve(root, 'lib/redteam/client.js'), 'utf8')
const store = readFileSync(resolve(root, 'lib/redteam/store-core.js'), 'utf8')

test('随包技能数量没变（少一个就是用户少一份资源）', () => {
  const bundled = readdirSync(resolve(root, 'skills/redteam')).filter((x) => x.endsWith('.md'))
  // 2026-11-19：新增 five-card（五类示范答复卡），23 → 24，只增不减
  assert.equal(bundled.length, 24, 'bundled skill resource count')
})

test('两个 tab 都还在侧栏列表里', () => {
  assert.match(ui, /\['knowledge', '知识库'\]/, 'knowledge tab must be visible')
  assert.match(ui, /\['skills', '技能库'\]/, 'skills tab must be visible')
})

test('两个 tab 各自有渲染分支', () => {
  assert.match(ui, /st\.tab === 'knowledge'\) body = h\(KnowledgeTab/, 'knowledge route must render its panel')
  assert.match(ui, /st\.tab === 'skills'\) body = h\(SkillsTab/, 'skills route must render its panel')
})

test('知识库接口仍然接在 store 上，且没有被改成「已下架」', () => {
  assert.match(store, /if \(op === 'pocSearch'\) \{/, 'POC search endpoint must be routed')
  assert.doesNotMatch(store, /error: '开源版已下架知识库'/, 'knowledge endpoint must not be disabled')
})
