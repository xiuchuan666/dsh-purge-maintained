// 状态面板的两件事：补丁怎么分组显示（rollupDisplayStatus / groupPatchesForDisplay /
// tallyDisplayPatches），以及补丁到底打在哪个文件上（targetFiles 的 57 个键）。
//
// 为什么这两件事要单独守：
// 1) 分组显示是「用户唯一会盯着看的那块界面」。它的状态汇总有严格优先级
//    （pending > unmatched > drifted > 全 skip > applied），一旦顺序写反，
//    面板会把「漂移」显示成「已完成」——这正是历史上「看起来全绿、实际没打上」
//    的来源。这类错误不会抛异常，只会让人误判。
// 2) targetFiles 是备份 / 回滚 / 打补丁的共同输入。它多登记一个键，备份就多覆盖
//    一个文件；少登记一个，回滚就漏还原。它还有一条反直觉规则：落空的键要整个
//    删掉，否则面板会挂一堆 ✗ 像「没清洗到位」。
//
// 本文件只用假 aiBase 树 + 临时 dshHome，不碰本机真实安装。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALL_PATCHES,
  PATCH_DISPLAY_GROUPS,
  allowTargetPath,
  groupPatchesForDisplay,
  patchAppliesHere,
  rollupDisplayStatus,
  tallyDisplayPatches,
  targetFiles,
} from '../lib/core.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dshpurge-display-'))

test.after(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    // Windows 上偶发 EPERM，临时目录留给系统清理。
  }
})

/** 写占位文件（顺带建目录），返回路径本身，方便链式使用。 */
function put(fp, content = 'x') {
  mkdirSync(join(fp, '..'), { recursive: true })
  writeFileSync(fp, content)
  return fp
}

/** 造一棵「桌面解包布局」的 aiBase：@deepseek-ai/<pkg>/lib/index.js。 */
function makeAiBase(tag, { nested = false } = {}) {
  const root = join(sandbox, tag)
  const aiBase = join(root, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai')
  put(join(aiBase, 'dsh-agent-instructions', 'lib', 'index.js'))
  put(join(aiBase, 'dsh-system-prompt', 'lib', 'index.js'))
  put(join(aiBase, 'dsh-tool-web', 'lib', 'index.js'))
  mkdirSync(join(aiBase, 'dsh-base'), { recursive: true })
  put(join(aiBase, 'dsh-base', 'cordis.patch.yml'))
  put(join(aiBase, 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' }))
  if (nested) {
    const inner = join(aiBase, 'dsh', 'node_modules', '@deepseek-ai')
    put(join(inner, 'dsh-system-prompt', 'lib', 'index.js'))
    put(join(inner, 'dsh-tool-web', 'lib', 'index.js'))
  }
  return { root, aiBase }
}

const allApplied = (surface) =>
  groupPatchesForDisplay(ALL_PATCHES, Object.fromEntries(ALL_PATCHES.map((p) => [p.id, 'applied'])), surface)

/* ---------------------------------------------------------------- 状态汇总 */

test('rollupDisplayStatus 把 pending 排在最前，压过一切', () => {
  assert.equal(rollupDisplayStatus(['applied', 'pending']), 'pending')
  assert.equal(rollupDisplayStatus(['drifted', 'pending']), 'pending')
  assert.equal(rollupDisplayStatus(['pending', 'unmatched']), 'pending')
})

test('rollupDisplayStatus 把 unmatched 排在 drifted 之前', () => {
  assert.equal(rollupDisplayStatus(['drifted', 'unmatched']), 'unmatched')
  assert.equal(rollupDisplayStatus(['applied', 'unmatched']), 'unmatched')
})

test('rollupDisplayStatus 让 drifted 压过 applied（漂移不能被当成已完成）', () => {
  assert.equal(rollupDisplayStatus(['applied', 'drifted']), 'drifted')
  assert.equal(rollupDisplayStatus(['already', 'drifted']), 'drifted')
  assert.equal(rollupDisplayStatus(['drifted']), 'drifted')
})

test('rollupDisplayStatus 在全部跳过时给出 skipped，不给出 applied', () => {
  assert.equal(rollupDisplayStatus(['skipped', 'missing_file', 'off']), 'skipped')
  assert.equal(rollupDisplayStatus(['skipped']), 'skipped')
})

test('rollupDisplayStatus 只要有一条完成就算 applied', () => {
  assert.equal(rollupDisplayStatus(['applied', 'skipped']), 'applied')
  assert.equal(rollupDisplayStatus(['already', 'off']), 'applied')
})

test('rollupDisplayStatus 对空输入与未知状态都退化成 skipped', () => {
  assert.equal(rollupDisplayStatus([]), 'skipped')
  assert.equal(rollupDisplayStatus(['没这个状态']), 'skipped')
  assert.equal(rollupDisplayStatus([null, undefined]), 'skipped')
})

/* ---------------------------------------------------------------- 分组 */

test('PATCH_DISPLAY_GROUPS 里每个 id 都真的存在，且没有 id 属于两个组', () => {
  const known = new Set(ALL_PATCHES.map((p) => p.id))
  const seen = new Map()
  for (const [group, ids] of Object.entries(PATCH_DISPLAY_GROUPS)) {
    for (const id of ids) {
      assert.ok(known.has(id), `分组 ${group} 里的 #${id} 在 ALL_PATCHES 中不存在`)
      assert.equal(seen.get(id), undefined, `#${id} 同时属于 ${seen.get(id)} 与 ${group}`)
      seen.set(id, group)
    }
  }
})

test('分组显示按组的首个小 id 升序排列，组内保留全部 id', () => {
  const rows = allApplied('desktop')
  const ids = rows.map((r) => r.id)
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b))
  const disclaimer = rows.find((r) => r.ids.length > 1 && r.ids[0] === Math.min(...PATCH_DISPLAY_GROUPS.disclaimer))
  assert.deepEqual(disclaimer.ids.slice().sort((a, b) => a - b), PATCH_DISPLAY_GROUPS.disclaimer.slice().sort((a, b) => a - b))
  assert.equal(disclaimer.id, Math.min(...PATCH_DISPLAY_GROUPS.disclaimer))
})

test('没有分组的补丁各自成一行，id 就是补丁 id', () => {
  const grouped = new Set(Object.values(PATCH_DISPLAY_GROUPS).flat())
  const solo = ALL_PATCHES.filter((p) => !grouped.has(p.id)).map((p) => p.id)
  const rows = allApplied('web')
  const soloRows = rows.filter((r) => r.ids.length === 1)
  const soloRowIds = new Set(soloRows.map((r) => r.id))
  for (const id of solo) {
    if (rows.some((r) => r.ids.includes(id))) assert.ok(soloRowIds.has(id), `#${id} 应该自成一行`)
  }
})

test('组的 layer 取自组内 lead 补丁，缺 layer 时给空串', () => {
  const rows = allApplied('web')
  for (const row of rows) {
    const lead = ALL_PATCHES.find((p) => p.id === row.id)
    assert.equal(row.layer, lead?.layer || '')
  }
})

test('只适配桌面的补丁不会出现在 web 面', () => {
  const web = allApplied('web')
  const desktop = allApplied('desktop')
  const desktopOnly = ALL_PATCHES.filter((p) => Array.isArray(p.surfaces) && p.surfaces.includes('desktop') && !p.surfaces.includes('web'))
  assert.ok(desktopOnly.length > 0, '宿主上应该存在只适配桌面的补丁，否则这条断言没有意义')
  for (const p of desktopOnly) {
    assert.ok(!web.some((r) => r.ids.includes(p.id)), `#${p.id} 不该出现在 web 面`)
    assert.ok(desktop.some((r) => r.ids.includes(p.id)), `#${p.id} 应该出现在 desktop 面`)
  }
})

test('patch_status 里缺状态或状态为 na 的补丁不进行', () => {
  const [first, second, third] = PATCH_DISPLAY_GROUPS.disclaimer
  const rows = groupPatchesForDisplay(ALL_PATCHES, { [first]: 'applied', [second]: 'na', [third]: 'applied' }, 'web')
  assert.ok(!rows.some((r) => r.ids.includes(second)), 'na 的补丁不该出现')
  assert.ok(rows.some((r) => r.ids.includes(first)))
})

test('未知状态不丢行，汇总退化成 skipped', () => {
  const id = PATCH_DISPLAY_GROUPS.disclaimer[0]
  const rows = groupPatchesForDisplay(ALL_PATCHES, { [id]: '外星状态' }, 'web')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'skipped')
})

/* ---------------------------------------------------------------- 计数 */

test('tallyDisplayPatches 把跳过同时计入 skipped 与 ready', () => {
  const tally = tallyDisplayPatches([{ status: 'applied' }, { status: 'skipped' }, { status: 'off' }])
  assert.equal(tally.total, 3)
  assert.equal(tally.applied, 1)
  assert.equal(tally.skipped, 2)
  assert.equal(tally.ready, 3, '跳过也算就绪，否则 68 applied 与 68/70 applied 分不清')
  assert.equal(tally.na, 2)
})

test('tallyDisplayPatches 不把 drifted 算成就绪', () => {
  const tally = tallyDisplayPatches([{ status: 'applied' }, { status: 'drifted' }])
  assert.equal(tally.drifted, 1)
  assert.equal(tally.ready, 1, '漂移不能算就绪')
})

test('tallyDisplayPatches 逐类计数，并兼容 status 与 st 两种字段名', () => {
  const tally = tallyDisplayPatches([
    { status: 'applied' },
    { st: 'already' },
    { status: 'pending' },
    { status: 'unmatched' },
    { status: 'drifted' },
    { status: 'skipped' },
    { status: 'na' },
    {},
  ])
  assert.deepEqual(tally, {
    applied: 2,
    pending: 1,
    unmatched: 1,
    skipped: 3,
    drifted: 1,
    total: 8,
    ready: 5,
    na: 3,
  })
})

test('面板与计数对同一批输入给出一致结论', () => {
  const rows = allApplied('web')
  const tally = tallyDisplayPatches(rows)
  assert.equal(tally.total, rows.length)
  assert.equal(tally.applied, rows.length)
  assert.equal(tally.ready, rows.length)
})

/* ---------------------------------------------------------------- 适用面 */

test('patchAppliesHere 对没声明 surfaces 的补丁一律放行', () => {
  const plain = ALL_PATCHES.find((p) => !Array.isArray(p.surfaces) || p.surfaces.length === 0)
  assert.ok(plain, '宿主上应该存在没声明 surfaces 的补丁')
  for (const surface of ['web', 'desktop', 'gui', 'tui']) {
    assert.equal(patchAppliesHere(plain, surface), true)
  }
  assert.equal(patchAppliesHere(undefined, 'web'), true)
})

test('patchAppliesHere 只认声明里的面，gui 与 tui 回落到 web 适配器', () => {
  const desktopOnly = ALL_PATCHES.find((p) => Array.isArray(p.surfaces) && p.surfaces.includes('desktop'))
  assert.ok(desktopOnly)
  assert.equal(patchAppliesHere(desktopOnly, 'desktop'), true)
  assert.equal(patchAppliesHere(desktopOnly, 'web'), false)
  assert.equal(patchAppliesHere(desktopOnly, 'gui'), false)
  assert.equal(patchAppliesHere(desktopOnly, 'tui'), false)
})

/* ---------------------------------------------------------------- 落点 */

test('targetFiles 只登记真实存在的文件，落空的键整个删掉', () => {
  const { aiBase } = makeAiBase('flat')
  const home = join(sandbox, 'flat-home')
  const files = targetFiles(aiBase, home)
  assert.ok(files['system-prompt'], '平铺布局的 dsh-system-prompt 应该被登记')
  assert.ok(files['agent-instructions'])
  for (const [key, val] of Object.entries(files)) {
    assert.notEqual(val, '', `${key} 不该登记成空串`)
    if (Array.isArray(val)) assert.ok(val.length > 0, `${key} 不该登记成空数组`)
  }
  assert.equal(files['preset-unrestricted'], undefined, '没装用户预设时不登记')
  assert.equal(files['compaction-instant-client'], undefined, '没有 web profile 时不登记')
})

test('targetFiles 在 aiBase 不存在时返回空对象，不抛', () => {
  assert.deepEqual(targetFiles(join(sandbox, 'nope'), join(sandbox, 'nope-home')), {})
  assert.deepEqual(targetFiles(sandbox, sandbox), {})
})

test('嵌套布局会额外登记四个 -nested 键，平铺布局不会', () => {
  const flat = targetFiles(makeAiBase('n1').aiBase, join(sandbox, 'n1-home'))
  const nested = targetFiles(makeAiBase('n2', { nested: true }).aiBase, join(sandbox, 'n2-home'))
  const nestedKeys = ['system-prompt-nested', 'tool-web-nested', 'hooks-claude-code-nested', 'hooks-codex-nested']
  for (const key of nestedKeys) assert.equal(flat[key], undefined, `平铺布局不该有 ${key}`)
  assert.ok(nested['system-prompt-nested'], '嵌套布局应该登记 system-prompt-nested')
  assert.ok(nested['tool-web-nested'], '嵌套布局应该登记 tool-web-nested')
  assert.equal(nested['hooks-claude-code-nested'], undefined, '嵌套根下没有的包仍不登记')
  assert.ok(nested['system-prompt-nested'].includes(join('@deepseek-ai', 'dsh', 'node_modules')), '嵌套键必须指向 dsh/node_modules 那一层')
})

test('targetFiles 会登记 dshHome 下的用户预设与演练台依赖', () => {
  const { aiBase } = makeAiBase('home')
  const home = join(sandbox, 'home-real')
  const preset = put(join(home, '.agent-presets', 'unrestricted', 'agent.cordis.yml'))
  const compaction = put(join(home, 'profiles', 'web', 'node_modules', 'dsh-compaction-instant', 'src', 'client.js'))
  const bootstrap = put(join(home, 'profiles', 'web', 'node_modules', '@linxin666', 'dsh-liangshen', 'presets', 'liangshen', 'tool-bootstrap.mjs'))
  const files = targetFiles(aiBase, home)
  assert.equal(files['preset-unrestricted'], preset)
  assert.equal(files['agent-preset'], preset, 'agent-preset 优先用用户预设')
  assert.deepEqual(files['compaction-instant-client'], [compaction])
  assert.deepEqual(files['liangshen-tool-bootstrap'], [bootstrap])
})

test('targetFiles 不把别的宿主面的 profile 收进来', () => {
  const { aiBase } = makeAiBase('zone')
  const home = join(sandbox, 'zone-home')
  const web = put(join(home, 'profiles', 'web', 'node_modules', 'dsh-compaction-instant', 'src', 'client.js'))
  put(join(home, 'profiles', 'desktop', 'node_modules', 'dsh-compaction-instant', 'src', 'client.js'))
  const files = targetFiles(aiBase, home)
  assert.deepEqual(files['compaction-instant-client'], [web], '只收当前面能写的 profile')
})

test('targetFiles 逐次调用互不串味：同一个 aiBase 连调结果稳定', () => {
  const home = join(sandbox, 'restore-home')
  const web = put(join(home, 'profiles', 'web', 'node_modules', 'dsh-compaction-instant', 'src', 'client.js'))
  const desk = put(join(home, 'profiles', 'desktop', 'node_modules', 'dsh-compaction-instant', 'src', 'client.js'))
  const { aiBase } = makeAiBase('restore')
  const first = targetFiles(aiBase, home)['compaction-instant-client']
  const second = targetFiles(aiBase, home)['compaction-instant-client']
  assert.deepEqual(first, [web], '桌面面只收 web profile')
  assert.deepEqual(second, first, '连调两次必须一致，否则说明有状态残留')
  // 桌面面自己的 profile 是宿主运行目录，不是补丁落点，两条路径下都不该进表。
  assert.ok(!first.includes(desk))
})

test('targetFiles 按「正在清洗的这棵树」判定落点，不按进程 surface 猜', () => {
  // 事故复盘：pi-ai-* 三条补丁（#47 / #49 / #57）的目标文件在桌面树里真实存在，
  // 但 listPiAiApiFiles 内部用 keepSurfaceFile(fp) 判定，而它当时只看 allowTargetPath
  // （进程级 surface）。CLI 跑 host:status 时 surface 推成 web，桌面树里这些路径被判成
  // desktop-install 而丢掉 —— 于是 applyPatches 报 missing_file、verify-target 按 argv
  // 推成 desktop 又报 would-apply，两处口径分叉，用户看到「补丁全丢了」。
  const { root, aiBase } = makeAiBase('piai')
  const apiDir = join(root, 'resources', 'app', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api')
  const anthropic = put(join(apiDir, 'anthropic-messages.js'))
  const completions = put(join(apiDir, 'openai-completions.js'))
  const responses = put(join(apiDir, 'openai-responses-shared.js'))
  // 用 DSH_DESKTOP_INSTALL 把这棵假树登记成「桌面安装」，让 pathZone 判成 desktop-install。
  // 不设的话临时目录落在 shared，allowTargetPath 会放行，这条用例就测不出东西。
  const prev = process.env.DSH_DESKTOP_INSTALL
  process.env.DSH_DESKTOP_INSTALL = root
  try {
    assert.equal(allowTargetPath(anthropic), false, '前提不成立：桌面安装目录里的文件不该被 surface 判定放行')
    const files = targetFiles(aiBase, join(sandbox, 'piai-home'))
    assert.deepEqual(files['pi-ai-anthropic-messages'], [anthropic], '桌面树里的 pi-ai 文件必须登记，否则 #47/#49 打不上')
    assert.deepEqual(files['pi-ai-completions'], [completions], '#57 的落点要登记')
    assert.deepEqual(files['pi-ai-responses-shared'], [responses], '#57 的另一个落点要登记')
  } finally {
    if (prev === undefined) delete process.env.DSH_DESKTOP_INSTALL
    else process.env.DSH_DESKTOP_INSTALL = prev
  }
})

test('targetFiles 不登记官方文档支持的用户 patch 层', () => {
  const { aiBase } = makeAiBase('patchlayer')
  const home = join(sandbox, 'patchlayer-home')
  const userLayer = put(join(home, 'profiles', 'web', 'cordis.patch.yml'))
  const files = targetFiles(aiBase, home)
  const hits = Object.entries(files).filter(([, v]) => String(Array.isArray(v) ? v.join(',') : v).includes(userLayer))
  assert.deepEqual(hits, [], 'profiles/<name>/cordis.patch.yml 是用户自己的追加层，进 backup/revert 会盖掉用户改动')
  // 宿主自带的那份 dsh-base/cordis.patch.yml 是补丁目标，必须登记。
  assert.ok(files['base'] && files['base'].endsWith('cordis.patch.yml'), '宿主自带的 base patch 层要登记')
})
