import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const template = readFileSync(resolve(root, 'presets/redteam/agent.cordis.yml'), 'utf8')
const host = readFileSync(resolve(root, 'lib/redteam/index.js'), 'utf8')
assert.doesNotMatch(template, /@deepseek-ai\/dsh-tool-subagent-control\/list-agents/, 'bundled redteam template references removed host subpath')
assert.match(host, /stripObsoleteListAgents\(.*\.text\)/, 'existing preset repair must remove obsolete plugin')
console.log('preset compatibility PASS')
