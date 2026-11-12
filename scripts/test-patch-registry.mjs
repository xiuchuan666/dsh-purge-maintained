// 补丁注册表拆分等价性：lib/patches/ 里的 86 条补丁，与拆分前快照的关系必须是
// 「原有条目一字不改 + 只允许在末尾追加 replacement」。
//
// 快照是本次拆分前 core 及其 9 个直接依赖，不是第二份补丁清单。
// 不依赖 Git 历史或 tar：CI 浅克隆、发布包解压后均能运行同一项检查。
//
// 拆 test() 的意义：这里比的是四个不同层次的事实——导出面、补丁对象全等、
// 应用顺序、以及真实引擎跑出的结果。任何一层退化，都要能立刻说出是哪一层，
// 而不是一句 "core split FAIL"。
//
// 为什么要允许追加：上游 0.2.2-rc.2 改了这些补丁要改的代码，只在末尾追加新版
// 形态的 replacement 才能在两个版本上都能打上。追加必须满足三条：前面的条目
// 逐字段不变、原有条目顺序不变、追加上去的条目自己也幂等（由
// scripts/test-patch-upgrade.mjs 在真实 rc.2 窗口上验证）。这样「改错一个字面量」
// 和「合法地跟上上游」是两种可区分的事件，前者红，后者绿。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const beforeRoot = resolve(root, 'docs', 'origin', 'core-split-baseline-8066985')
const before = await import(pathToFileURL(join(beforeRoot, 'lib', 'core.js')).href)
const after = await import(pathToFileURL(join(root, 'lib', 'core.js')).href)

// 已知允许追加 replacement 的补丁：上游 0.2.2-rc.2 改了这些代码的形状。
// 新追加一条就要在这里登记，否则「悄悄多一条」会被当成回归。
const APPEND_ALLOWED = new Map([
  [13, 1], // ESCALATION_WIDENING_EXEMPT：rc.2 换成 SandboxEscalationError
  [18, 1], // REPEAT_TOOL_REMINDER_DISABLED：rc.2 删掉 block 分支
  [35, 1], // ESCALATION_NEVER_REJECT：rc.2 的 switch 分支重写
  [56, 2], // REWIND_HIDE_CUT_ONLY：rc.2 的 client.js 被压成 minified
  [62, 6], // OFFICIAL_TOOL_ASK_FAILOPEN：approvalDenial() 调用形态 + TS 排版（cancelled 分支不放行）
  [77, 1], // REWIND_DROP_SENT_ON_APPEND：同一个 minified 文件
])

function replacementsOf(patch) {
  return Array.isArray(patch?.replacements) ? patch.replacements : []
}

test('core 的公开导出名一字不差', () => {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'core public export names')
})

test('补丁总数是 86', () => {
  assert.equal(after.ALL_PATCHES.length, 86)
})

test('每条补丁的 id 与顺序与拆分前一致', () => {
  assert.deepEqual(
    after.ALL_PATCHES.map(({ id }) => id),
    before.ALL_PATCHES.map(({ id }) => id),
    'application order',
  )
})

test('除 replacements 外的每个字段逐字段相等（含 RegExp flags 与函数型 replace）', () => {
  const strip = (patch) => {
    const copy = { ...patch }
    delete copy.replacements
    return copy
  }
  for (let i = 0; i < after.ALL_PATCHES.length; i++) {
    const now = after.ALL_PATCHES[i]
    const was = before.ALL_PATCHES[i]
    assert.ok(
      isDeepStrictEqual(strip(now), strip(was)),
      `patch ${now.id} metadata changed since the split snapshot`,
    )
  }
})

test('既有 replacement 一字不改，只在末尾追加', () => {
  for (let i = 0; i < after.ALL_PATCHES.length; i++) {
    const now = after.ALL_PATCHES[i]
    const was = before.ALL_PATCHES[i]
    const nowReps = replacementsOf(now)
    const wasReps = replacementsOf(was)
    assert.ok(
      isDeepStrictEqual(nowReps.slice(0, wasReps.length), wasReps),
      `patch ${now.id} must keep its ${wasReps.length} original replacements verbatim and in order`,
    )
  }
})

test('追加条数逐条等于登记值（多一条少一条都要在这里说清楚）', () => {
  const extra = new Map()
  for (let i = 0; i < after.ALL_PATCHES.length; i++) {
    const now = after.ALL_PATCHES[i]
    const was = before.ALL_PATCHES[i]
    const delta = replacementsOf(now).length - replacementsOf(was).length
    if (delta !== 0) extra.set(Number(now.id), delta)
  }
  assert.deepEqual(extra, APPEND_ALLOWED, 'replacement appends since the split snapshot')
})

test('追加的条目形状合法：有 pattern 有 replace，且不会空转', () => {
  for (const [id, delta] of APPEND_ALLOWED) {
    const now = after.ALL_PATCHES.find((p) => Number(p.id) === id)
    const was = before.ALL_PATCHES.find((p) => Number(p.id) === id)
    const added = replacementsOf(now).slice(replacementsOf(was).length)
    assert.equal(added.length, delta, `#${id} appended count`)
    for (const rep of added) {
      assert.ok(typeof rep.pattern === 'string' && rep.pattern.length > 10, `#${id} appended pattern`)
      assert.ok(typeof rep.replace === 'string' && rep.replace.length > 0, `#${id} appended replace`)
      assert.notEqual(rep.pattern, rep.replace, `#${id} appended replacement must change something`)
    }
  }
})

test('合成后的注册表（lib/patches/index.mjs）与 lib/core.js 完全一致', async () => {
  const composed = await import(pathToFileURL(join(root, 'lib', 'patches', 'index.mjs')).href)
  assert.ok(isDeepStrictEqual(composed.ALL_PATCHES, after.ALL_PATCHES), 'composed registry matches core')
})

test('replacement 优先级：#76 仍排在 #70 之前', () => {
  const id76 = after.ALL_PATCHES.findIndex(({ id }) => id === 76)
  const id70 = after.ALL_PATCHES.findIndex(({ id }) => id === 70)
  assert.ok(id76 >= 0 && id76 < id70, 'replacement precedence: 76 precedes 70')
})

test('真实引擎在拆分前的每条 replacement 上行为不变', () => {
  // 让真实引擎消费真实 patch，而不是把 pattern/replace 拆成第二套替换逻辑。
  // 只跑既有条目：追加的条目本来就是为上游新形态准备的，用旧快照的引擎跑它没有意义。
  // 不把「单条 replacement 幂等」当契约：完整补丁可含升级链和防重入标记。
  let exercised = 0
  for (let i = 0; i < after.ALL_PATCHES.length; i++) {
    const patch = after.ALL_PATCHES[i]
    const oldPatch = before.ALL_PATCHES[i]
    const nowReps = replacementsOf(patch)
    const oldReps = replacementsOf(oldPatch)
    for (let k = 0; k < oldReps.length; k++) {
      const rep = oldReps[k]
      if (typeof rep.pattern !== 'string' || !rep.pattern) continue
      // 引擎按整条补丁跑，所以把「当前补丁」裁成只有前缀这些条目再比。
      const prefixNow = { ...patch, replacements: nowReps.slice(0, k + 1) }
      const prefixOld = { ...oldPatch, replacements: oldReps.slice(0, k + 1) }
      for (const [text, file] of [
        [`header\n${rep.pattern}\nfooter\n`, 'lib/index.js'],
        [`header\r\n${rep.pattern}\r\nfooter\r\n`, 'lib/index.js'],
        [`header\n${rep.pattern}\nfooter\n`, 'agent.cordis.yml'],
      ]) {
        const beforeResult = before.applyReplacementsToText(text, prefixOld, file)
        const afterResult = after.applyReplacementsToText(text, prefixNow, file)
        assert.ok(isDeepStrictEqual(afterResult, beforeResult), `engine result for patch ${patch.id}, ${file}`)
        exercised++
      }
    }
  }
  assert.ok(exercised > 300, `exercise string replacements, got ${exercised}`)
})
