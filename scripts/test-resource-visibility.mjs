import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ui = readFileSync(resolve(root, 'lib/redteam/client.js'), 'utf8')
const store = readFileSync(resolve(root, 'lib/redteam/store-core.js'), 'utf8')
const bundled = readdirSync(resolve(root, 'skills/redteam')).filter((x) => x.endsWith('.md'))
assert.equal(bundled.length, 23, 'bundled skill resource count')
assert.match(ui, /\['knowledge', '知识库'\]/, 'knowledge tab must be visible')
assert.match(ui, /\['skills', '技能库'\]/, 'skills tab must be visible')
assert.match(ui, /st\.tab === 'knowledge'\) body = h\(KnowledgeTab/, 'knowledge route must render its panel')
assert.match(ui, /st\.tab === 'skills'\) body = h\(SkillsTab/, 'skills route must render its panel')
assert.match(store, /if \(op === 'pocSearch'\) \{/, 'POC search endpoint must be routed')
assert.doesNotMatch(store, /error: '开源版已下架知识库'/, 'knowledge endpoint must not be disabled')
console.log('resource visibility PASS')
