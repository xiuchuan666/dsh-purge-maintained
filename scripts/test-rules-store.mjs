// 规则集读写：`$DSH_HOME/rules/*.md` 这套「用户自定义规则」的存取、激活、
// 备份与恢复。
//
// 为什么这组必须有测试：这里的错误全都发生在用户已经写好的 AGENTS.md 上。
// 激活一条规则会把内容写进 `$DSH_HOME/AGENTS.md`，覆盖前先备份成
// `AGENTS.md.dsh-purge-rule.bak`；「恢复出厂」把备份写回去。写错一步就是
// 用户手写的东西被另一条规则的内容盖掉，而且**没有任何报错**——用户下次打开
// 编辑器才发现。
//
// 两条反直觉规则，测试里都钉住了：
// 1) 目标文件内容若已经等于某条规则的内容（例如刚被激活过），激活新规则时
//    **不备份**——否则备份里存的就是规则正文，恢复出厂等于把规则又写回去一遍。
// 2) 恢复出厂时，若没有备份、且目标文件内容与当前激活规则一致，就删掉目标
//    文件（说明这个文件本来就是这条规则建的）；若内容不一致，则保留并计入
//    `skipped`——用户改过的东西不能被删。
//
// 本文件全部用临时 `$DSH_HOME`，不碰真实用户目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activateRule,
  ancestorChainForCwd,
  deleteRule,
  ensureInitialState,
  formatSize,
  listRules,
  normalizeMeta,
  readActive,
  readRule,
  readRuleMeta,
  resetToOriginal,
  rulePath,
  rulesDir,
  rulesStatus,
  saveRule,
  scanCwdInstructions,
  setActive,
  targetPath,
  validRuleId,
  validTarget,
  writeRuleMeta,
} from '../lib/rules.js'

const BACKUP_SUFFIX = '.dsh-purge-rule.bak'
const sandbox = mkdtempSync(join(tmpdir(), 'dshpurge-rules-'))

test.after(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    // Windows 上偶发 EPERM，交给系统清理。
  }
})

let seq = 0
/** 每个用例一个独立 $DSH_HOME，避免共享状态。 */
function freshHome() {
  seq += 1
  const home = join(sandbox, `home-${seq}`)
  mkdirSync(home, { recursive: true })
  return home
}

/* ---------------------------------------------------------------- 标识与目标 */

test('validRuleId 只接受字母数字开头的 64 字符内标识', () => {
  assert.equal(validRuleId('a'), true)
  assert.equal(validRuleId('A_b-1.c'), true)
  assert.equal(validRuleId('1abc'), true, '数字开头是允许的（首字符只要求是字母数字）')
  assert.equal(validRuleId('.hidden'), false)
  assert.equal(validRuleId('a/b'), false)
  assert.equal(validRuleId('a b'), false)
  assert.equal(validRuleId('x'.repeat(64)), true)
  assert.equal(validRuleId('x'.repeat(65)), false)
  assert.equal(validRuleId(''), false)
  assert.equal(validRuleId(null), false)
})

test('validTarget 只认 AGENTS.md 与 CLAUDE.md，targetPath 对其它值抛错', () => {
  assert.equal(validTarget('AGENTS.md'), true)
  assert.equal(validTarget('CLAUDE.md'), true)
  assert.equal(validTarget('README.md'), false)
  assert.equal(validTarget(undefined), false)
  assert.throws(() => targetPath(sandbox, 'README.md'), /invalid target/)
})

test('normalizeMeta 给缺名字的规则用 id 兜底，目标非法时回落到 AGENTS.md', () => {
  assert.deepEqual(normalizeMeta('myid', { name: '  ', target: 'OTHER.md' }), { name: 'myid', target: 'AGENTS.md' })
  assert.deepEqual(normalizeMeta('myid', null), { name: 'myid', target: 'AGENTS.md' })
  assert.deepEqual(normalizeMeta('myid', { name: ' 两边空格 ', target: 'CLAUDE.md' }), { name: '两边空格', target: 'CLAUDE.md' })
  const long = normalizeMeta('myid', { name: 'n'.repeat(200) })
  assert.equal(long.name.length, 64, '名字超过 64 字符要截断，否则列表页会被撑爆')
})

test('formatSize 用 B / KB 两档，100KB 以上取整', () => {
  assert.equal(formatSize(0), '0 B')
  assert.equal(formatSize(1023), '1023 B')
  assert.equal(formatSize(1024), '1.0 KB')
  assert.equal(formatSize(1536), '1.5 KB')
  assert.equal(formatSize(102400), '100 KB')
  assert.equal(formatSize(-1), '0 B')
  assert.equal(formatSize(NaN), '0 B')
})

/* ---------------------------------------------------------------- 存取 */

test('saveRule 写入正文与元数据，listRules 按 id 排序并带上字节数', async () => {
  const home = freshHome()
  await saveRule(home, 'b-rule', '# b\n', { name: 'Bee', target: 'CLAUDE.md' })
  await saveRule(home, 'a-rule', '# a\n', { name: 'Ay', target: 'AGENTS.md' })
  const listed = await listRules(home)
  assert.deepEqual(listed.map((r) => r.id), ['a-rule', 'b-rule'])
  assert.deepEqual(listed[0], { id: 'a-rule', name: 'Ay', target: 'AGENTS.md', size: 4 })
  assert.equal(await readRule(home, 'b-rule'), '# b\n')
  assert.deepEqual(await readRuleMeta(home, 'b-rule'), { name: 'Bee', target: 'CLAUDE.md' })
})

test('listRules 在 rules 目录不存在时返回空列表，不抛', async () => {
  const home = freshHome()
  assert.deepEqual(await listRules(home), [])
})

test('listRules 忽略非 .md 文件与非法 id 文件名', async () => {
  const home = freshHome()
  await saveRule(home, 'good', 'x', { name: 'g' })
  mkdirSync(rulesDir(home), { recursive: true })
  writeFileSync(join(rulesDir(home), 'notes.txt'), 'x')
  writeFileSync(join(rulesDir(home), 'has space.md'), 'x')
  mkdirSync(join(rulesDir(home), 'dir.md'), { recursive: true })
  const listed = await listRules(home)
  assert.deepEqual(listed.map((r) => r.id), ['good'])
})

test('readRule 对不存在的 id 返回 null，对非法 id 抛错', async () => {
  const home = freshHome()
  assert.equal(await readRule(home, 'ghost'), null)
  await assert.rejects(() => readRule(home, '../etc/passwd'), /invalid rule id/)
})

test('saveRule 拒绝超过 256KB 的正文与非法 id', async () => {
  const home = freshHome()
  await assert.rejects(() => saveRule(home, 'big', 'x'.repeat(256 * 1024 + 1), { name: 'b' }), /rule too large/)
  await assert.rejects(() => saveRule(home, 'bad/id', 'x', {}), /invalid rule id/)
  assert.equal(existsSync(rulePath(home, 'big')), false, '超限时不该留下半个文件')
})

test('writeRuleMeta 拒绝非法 id，并对 meta 做归一化', async () => {
  const home = freshHome()
  await assert.rejects(() => writeRuleMeta(home, 'bad id', { name: 'x' }), /invalid rule id/)
  await writeRuleMeta(home, 'ok', { name: '  ', target: 'NOPE.md' })
  assert.deepEqual(await readRuleMeta(home, 'ok'), { name: 'ok', target: 'AGENTS.md' })
})

/* ---------------------------------------------------------------- 激活与备份 */

test('激活规则把正文写进目标文件，并把原内容备份成 .dsh-purge-rule.bak', async () => {
  const home = freshHome()
  const target = targetPath(home, 'AGENTS.md')
  writeFileSync(target, '# 用户手写的内容\n')
  await saveRule(home, 'r1', '# 规则一\n', { name: 'One', target: 'AGENTS.md' })
  const meta = await activateRule(home, 'r1')
  assert.deepEqual(meta, { name: 'One', target: 'AGENTS.md' })
  assert.equal(readFileSync(target, 'utf8'), '# 规则一\n')
  assert.equal(readFileSync(`${target}${BACKUP_SUFFIX}`, 'utf8'), '# 用户手写的内容\n')
  assert.equal(await readActive(home), 'r1')
})

test('目标文件内容已等于某条规则时不做备份（否则备份里存的是规则正文）', async () => {
  const home = freshHome()
  const target = targetPath(home, 'AGENTS.md')
  await saveRule(home, 'r1', '# 规则一\n', { name: 'One', target: 'AGENTS.md' })
  await saveRule(home, 'r2', '# 规则二\n', { name: 'Two', target: 'AGENTS.md' })
  writeFileSync(target, '# 规则一\n')
  await activateRule(home, 'r1')
  assert.equal(existsSync(`${target}${BACKUP_SUFFIX}`), false, '内容是规则正文时不能当作用户原文备份')
})

test('已存在备份时不覆盖它（第一份用户原文必须留住）', async () => {
  const home = freshHome()
  const target = targetPath(home, 'AGENTS.md')
  writeFileSync(target, '# 用户原文\n')
  await saveRule(home, 'r1', '# 规则一\n', { name: 'One', target: 'AGENTS.md' })
  await saveRule(home, 'r2', '# 规则二\n', { name: 'Two', target: 'AGENTS.md' })
  await activateRule(home, 'r1')
  await activateRule(home, 'r2')
  assert.equal(readFileSync(`${target}${BACKUP_SUFFIX}`, 'utf8'), '# 用户原文\n')
  assert.equal(readFileSync(target, 'utf8'), '# 规则二\n')
})

test('目标文件不存在时不备份也不抛', async () => {
  const home = freshHome()
  await saveRule(home, 'r1', '# 规则一\n', { name: 'One', target: 'CLAUDE.md' })
  await activateRule(home, 'r1')
  assert.equal(readFileSync(targetPath(home, 'CLAUDE.md'), 'utf8'), '# 规则一\n')
  assert.equal(existsSync(`${targetPath(home, 'CLAUDE.md')}${BACKUP_SUFFIX}`), false)
})

test('激活不存在的规则抛错，且不动目标文件', async () => {
  const home = freshHome()
  const target = targetPath(home, 'AGENTS.md')
  writeFileSync(target, '# 原文\n')
  await assert.rejects(() => activateRule(home, 'ghost'), /rule not found/)
  assert.equal(readFileSync(target, 'utf8'), '# 原文\n')
  assert.equal(await readActive(home), null)
})

test('保存当前激活的规则会立刻把新正文同步到目标文件', async () => {
  const home = freshHome()
  const target = targetPath(home, 'AGENTS.md')
  await saveRule(home, 'r1', '# v1\n', { name: 'One', target: 'AGENTS.md' })
  await activateRule(home, 'r1')
  await saveRule(home, 'r1', '# v2\n', { name: 'One', target: 'AGENTS.md' })
  assert.equal(readFileSync(target, 'utf8'), '# v2\n')
  assert.equal(await readActive(home), 'r1')
})

test('保存未激活的规则不会碰目标文件', async () => {
  const home = freshHome()
  const target = targetPath(home, 'AGENTS.md')
  writeFileSync(target, '# 原文\n')
  await saveRule(home, 'r1', '# v1\n', { name: 'One', target: 'AGENTS.md' })
  assert.equal(readFileSync(target, 'utf8'), '# 原文\n')
})

/* ---------------------------------------------------------------- 恢复出厂 */

test('恢复出厂优先用备份，成功后删掉备份', async () => {
  const home = freshHome()
  const target = targetPath(home, 'AGENTS.md')
  writeFileSync(target, '# 用户原文\n')
  await saveRule(home, 'r1', '# 规则一\n', { name: 'One', target: 'AGENTS.md' })
  await activateRule(home, 'r1')
  const result = await resetToOriginal(home)
  assert.deepEqual(result, { removed: [], skipped: [], restored: [target] })
  assert.equal(readFileSync(target, 'utf8'), '# 用户原文\n')
  assert.equal(existsSync(`${target}${BACKUP_SUFFIX}`), false)
  assert.equal(await readActive(home), null)
})

test('没有备份且目标文件等于激活规则正文时删掉文件', async () => {
  const home = freshHome()
  const target = targetPath(home, 'AGENTS.md')
  await saveRule(home, 'r1', '# 规则一\n', { name: 'One', target: 'AGENTS.md' })
  await activateRule(home, 'r1')
  const result = await resetToOriginal(home)
  assert.deepEqual(result, { removed: [target], skipped: [], restored: [] })
  assert.equal(existsSync(target), false, '这个文件本来就是规则建的，应当删掉')
})

test('没有备份但用户改过目标文件时保留并计入 skipped', async () => {
  const home = freshHome()
  const target = targetPath(home, 'AGENTS.md')
  await saveRule(home, 'r1', '# 规则一\n', { name: 'One', target: 'AGENTS.md' })
  await activateRule(home, 'r1')
  writeFileSync(target, '# 用户改过\n')
  const result = await resetToOriginal(home)
  assert.deepEqual(result, { removed: [], skipped: [target], restored: [] })
  assert.equal(readFileSync(target, 'utf8'), '# 用户改过\n', '用户改过的内容一个字节都不能动')
})

test('恢复出厂会清掉 state.json，且没有激活规则时是空操作', async () => {
  const home = freshHome()
  assert.deepEqual(await resetToOriginal(home), { removed: [], skipped: [], restored: [] })
  await setActive(home, 'r1')
  await resetToOriginal(home)
  assert.equal(await readActive(home), null)
})

/* ---------------------------------------------------------------- 状态与清理 */

test('rulesStatus 报出激活规则、目标文件同步状态与注入来源', async () => {
  const home = freshHome()
  await saveRule(home, 'r1', '# 规则一\n', { name: 'One', target: 'CLAUDE.md' })
  await activateRule(home, 'r1')
  const st = await rulesStatus(home, home)
  assert.equal(st.active, 'r1')
  assert.equal(st.active_target, 'CLAUDE.md')
  assert.equal(st.agents_exists, true)
  assert.equal(st.agents_synced, true)
  assert.equal(st.agents_path, targetPath(home, 'CLAUDE.md'))
  assert.equal(st.rules_dir, rulesDir(home))
  assert.deepEqual(st.workspace_policies, ['fallback', 'strict', 'always'])
  assert.equal(st.injectRuleId, null, '规则集不参与 system 注入链，只改目标文件')
})

test('rulesStatus 在目标文件被改过时报未同步', async () => {
  const home = freshHome()
  await saveRule(home, 'r1', '# 规则一\n', { name: 'One', target: 'AGENTS.md' })
  await activateRule(home, 'r1')
  writeFileSync(targetPath(home, 'AGENTS.md'), '# 手改\n')
  const st = await rulesStatus(home, home)
  assert.equal(st.agents_exists, true)
  assert.equal(st.agents_synced, false)
})

test('deleteRule 删正文与元数据，并在删的正是激活规则时清掉 state', async () => {
  const home = freshHome()
  await saveRule(home, 'r1', 'x', { name: 'One' })
  await setActive(home, 'r1')
  await deleteRule(home, 'r1')
  assert.equal(await readRule(home, 'r1'), null)
  assert.equal(existsSync(join(rulesDir(home), 'r1.json')), false)
  assert.equal(await readActive(home), null)
})

test('deleteRule 对不存在的 id 静默成功，对非法 id 抛错', async () => {
  const home = freshHome()
  await deleteRule(home, 'ghost')
  await assert.rejects(() => deleteRule(home, 'bad id'), /invalid rule id/)
})

test('ensureInitialState 清掉指向已不存在规则的激活标记', async () => {
  const home = freshHome()
  await saveRule(home, 'r1', 'x', { name: 'One' })
  await setActive(home, 'r1')
  assert.deepEqual(await ensureInitialState(home), { active: 'r1' })
  await deleteRule(home, 'r1')
  await setActive(home, 'r1')
  assert.deepEqual(await ensureInitialState(home), { active: null })
  assert.equal(existsSync(join(rulesDir(home), 'state.json')), false)
})

/* ---------------------------------------------------------------- cwd 扫描 */

test('ancestorChainForCwd 遇到 .git 就停在项目根，并把链按由浅到深排', () => {
  const root = join(sandbox, 'proj')
  mkdirSync(join(root, '.git'), { recursive: true })
  const deep = join(root, 'a', 'b')
  mkdirSync(deep, { recursive: true })
  assert.deepEqual(ancestorChainForCwd(deep), [root, join(root, 'a'), deep])
})

test('ancestorChainForCwd 找不到根标记时只返回 cwd 这一层', () => {
  const lone = join(sandbox, 'lone', 'x')
  mkdirSync(lone, { recursive: true })
  assert.deepEqual(ancestorChainForCwd(lone), [lone])
  assert.deepEqual(ancestorChainForCwd(''), [])
})

test('scanCwdInstructions 区分 cwd / ancestor / root 三层并带预览', () => {
  const root = join(sandbox, 'scan')
  mkdirSync(join(root, '.git'), { recursive: true })
  const deep = join(root, 'a', 'b')
  mkdirSync(deep, { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), 'root agents')
  writeFileSync(join(root, 'a', 'CLAUDE.md'), 'mid claude')
  writeFileSync(join(deep, 'AGENTS.local.md'), 'leaf local')
  const scan = scanCwdInstructions(deep)
  assert.deepEqual(scan.map((i) => [i.name, i.scope]), [
    ['AGENTS.md', 'root'],
    ['CLAUDE.md', 'ancestor'],
    ['AGENTS.local.md', 'cwd'],
  ])
  assert.equal(scan[0].preview, 'root agents')
  assert.equal(scan[0].dir, root)
  assert.ok(scan[0].size > 0)
  assert.ok(scan[0].mtime > 0)
})

test('scanCwdInstructions 忽略目录同名的候选文件，空 cwd 返回空列表', () => {
  const dir = join(sandbox, 'dirfile')
  mkdirSync(join(dir, 'AGENTS.md'), { recursive: true })
  assert.deepEqual(scanCwdInstructions(dir), [])
  assert.deepEqual(scanCwdInstructions(''), [])
})
