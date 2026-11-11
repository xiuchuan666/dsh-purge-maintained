// 补丁注册表拆分等价性：lib/patches/ 里的 86 条补丁必须与拆分前逐字节一致。
//
// 快照是本次拆分前 core 及其 9 个直接依赖，不是第二份补丁清单。
// 不依赖 Git 历史或 tar：CI 浅克隆、发布包解压后均能运行同一项检查。
//
// 拆 test() 的意义：这里比的是四个不同层次的事实——导出面、补丁对象全等、
// 应用顺序、以及真实引擎跑出的结果。任何一层退化，都要能立刻说出是哪一层，
// 而不是一句 "core split FAIL"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const beforeRoot = resolve(root, 'docs', 'origin', 'core-split-baseline-8066985')
const before = await import(pathToFileURL(join(beforeRoot, 'lib', 'core.js')).href)
const after = await import(pathToFileURL(join(root, 'lib', 'core.js')).href)

test('core 的公开导出名一字不差', () => {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'core public export names')
})

test('补丁总数是 86', () => {
  assert.equal(after.ALL_PATCHES.length, 86)
})

test('每条补丁逐字段相等（含 RegExp flags 与函数型 replace）', () => {
  assert.ok(
    isDeepStrictEqual(after.ALL_PATCHES, before.ALL_PATCHES),
    'all patch values, including RegExp flags and function replacements',
  )
})

test('应用顺序与拆分前一致', () => {
  assert.deepEqual(
    after.ALL_PATCHES.map(({ id }) => id),
    before.ALL_PATCHES.map(({ id }) => id),
    'application order',
  )
})

test('合成后的注册表（lib/patches/index.mjs）保留基线值', async () => {
  const composed = await import(pathToFileURL(join(root, 'lib', 'patches', 'index.mjs')).href)
  assert.ok(isDeepStrictEqual(composed.ALL_PATCHES, before.ALL_PATCHES), 'composed registry preserves baseline values')
})

test('replacement 优先级：#76 仍排在 #70 之前', () => {
  const id76 = after.ALL_PATCHES.findIndex(({ id }) => id === 76)
  const id70 = after.ALL_PATCHES.findIndex(({ id }) => id === 70)
  assert.ok(id76 >= 0 && id76 < id70, 'replacement precedence: 76 precedes 70')
})

test('真实引擎在真实补丁上的行为与拆分前逐条相同', () => {
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
})
