import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

// 快照是本次拆分前 core 及其 9 个直接依赖，不是第二份补丁清单。
// 不依赖 Git 历史或 tar：CI 浅克隆、发布包解压后均能运行同一项检查。
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const beforeRoot = resolve(root, 'docs', 'origin', 'core-split-baseline-8066985')
const before = await import(pathToFileURL(join(beforeRoot, 'lib', 'core.js')).href)
const after = await import(pathToFileURL(join(root, 'lib', 'core.js')).href)
assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'core public export names')

assert.equal(after.ALL_PATCHES.length, 86)
assert.ok(isDeepStrictEqual(after.ALL_PATCHES, before.ALL_PATCHES), 'all patch values, including RegExp flags and function replacements')
assert.deepEqual(after.ALL_PATCHES.map(({ id }) => id), before.ALL_PATCHES.map(({ id }) => id), 'application order')
const composed = await import(pathToFileURL(join(root, 'lib', 'patches', 'index.mjs')).href)
assert.ok(isDeepStrictEqual(composed.ALL_PATCHES, before.ALL_PATCHES), 'composed registry preserves baseline values')
const id76 = after.ALL_PATCHES.findIndex(({ id }) => id === 76)
const id70 = after.ALL_PATCHES.findIndex(({ id }) => id === 70)
assert.ok(id76 >= 0 && id76 < id70, 'replacement precedence: 76 precedes 70')

  // 让真实引擎消费真实 patch，而不是把 pattern/replace 拆成第二套替换逻辑。
  // 不把「单条 replacement 幂等」当契约：完整补丁可含升级链和防重入标记。
let exercised = 0
let replacements = 0
for (let i = 0; i < after.ALL_PATCHES.length; i++) {
  const patch = after.ALL_PATCHES[i]
  const oldPatch = before.ALL_PATCHES[i]
  for (const rep of patch.replacements || []) {
    replacements++
    if (typeof rep.pattern !== 'string' || !rep.pattern) continue
    for (const [text, file] of [
      [`header\n${rep.pattern}\nfooter\n`, 'lib/index.js'],
      [`header\r\n${rep.pattern}\r\nfooter\r\n`, 'lib/index.js'],
      [`header\n${rep.pattern}\nfooter\n`, 'agent.cordis.yml'],
    ]) {
      const beforeResult = before.applyReplacementsToText(text, oldPatch, file)
      const afterResult = after.applyReplacementsToText(text, patch, file)
      assert.ok(isDeepStrictEqual(afterResult, beforeResult), `engine result for patch ${patch.id}, ${file}`)
      exercised++
    }
  }
}
assert.equal(replacements, 239, 'every replacement is covered by the object comparison')
assert.ok(exercised > 300, `exercise string replacements, got ${exercised}`)
console.log(`core split PASS (${after.ALL_PATCHES.length} patches, ${replacements} replacements, ${exercised} engine comparisons)`)
