import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const require = createRequire(import.meta.url)
// 版本号每次发版都变，钉死旧号只会让发版必红；改为校验 semver 形状 + 不小于 1.1.93。
assert.match(manifest.version, /^1\.1\.\d+$/)
assert.ok(Number(manifest.version.split('.')[2]) >= 93)
assert.ok(manifest.dshTargets.includes('0.2.2-rc.1'))
assert.ok(manifest.files.includes('skills'))
assert.ok(manifest.files.includes('!lib/**/*.bak'))
assert.equal(readdirSync(join(root, 'skills', 'redteam')).filter(x => x.endsWith('.md')).length, 23)
for (const path of ['lib/redteam/store-core.js', 'lib/redteam/client.js', 'lib/redteam/index.js', 'lib/redteam/ui.js', 'presets/redteam/agent.cordis.yml', 'scripts/test-knowledge-dispatch.mjs']) {
  assert.ok(existsSync(join(root, path)), path)
}
const generated = readFileSync(join(root, 'client.js'), 'utf8')
assert.ok(generated.includes("st.tab === 'knowledge'"), 'embedded knowledge route')
assert.ok(generated.includes("st.tab === 'skills'"), 'embedded skills route')
assert.ok(!readFileSync(join(root, 'presets/redteam/agent.cordis.yml'), 'utf8').includes('@deepseek-ai/dsh-tool-subagent-control/list-agents'))
const installed = require.resolve(join(root, 'lib/redteam/store-core.js'))
assert.ok(installed.endsWith('store-core.js'))
console.log('package integrity PASS')
