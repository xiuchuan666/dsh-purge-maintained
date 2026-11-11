/**
 * 自更新与打包三处缺口的守卫（docs/test-map.md 第八节）。
 *
 * 这三块以前一条测试都没有，而它们出问题的方式都很安静：
 *   - postinstall 没补 profile 的 `bundles` / `cordis.patch.yml` → 插件装了但宿主不加载，
 *     界面一切正常，只是功能「没反应」；
 *   - 卸载时先删文件再回滚补丁 → 宿主里留一堆打不回去的补丁，只能重装宿主；
 *   - 通道状态读坏文件就回落 stable 却不回写 → 面板每次刷新都显示同一份旧状态。
 *
 * 全部用临时 DSH_HOME / DSH_BASE，绝不碰真实宿主。`uninstallPurge` 会真的调
 * `core.revertAll`，所以 `DSH_BASE` 必须指向临时造出来的假宿主树。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  INSERT_BLOCK,
  PURGE_NAME,
  classifyPatchBody,
  ensureAllProfileBodyInserts,
  ensureAllProfileInstall,
  ensurePnpmAllowBuild,
  ensureProfileBundles,
  ensureProfileBodyInsert,
  formatAllowBuildLine,
  listProfileDirs,
  parseAllowBuildLine,
  profileHasPurgeBodyInsert,
  purgePnpmBuildSpecs,
  rewritePnpmAllowBuilds,
  validateAllowBuildRewrite,
} from '../lib/profile-insert.js'
import {
  listInstalledProfiles,
  shouldDeletePluginTree,
  stripPluginFromPackage,
  uninstallPurge,
  wasApplied,
} from '../lib/uninstall.js'
import {
  channelPublic,
  hideListedVersion,
  isLinkSpec,
  latestStableVersion,
  markCurrent,
  normalizeChannel,
  readChannelState,
  resolveLinkDir,
  safeUpdateRef,
  versionIsNewer,
} from '../lib/update.js'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpurge-selfupd-'))

test.after(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发 EPERM：临时目录留给系统清理 */
  }
})

let seq = 0

/** 每个用例一套独立目录，避免 A 用例写的文件影响 B 用例。 */
function freshHome() {
  seq += 1
  const home = path.join(sandbox, `home-${seq}`)
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  return home
}

function put(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, text)
  return fp
}

function read(fp) {
  return fs.readFileSync(fp, 'utf8')
}

function makeProfile(home, name, pkg = {}, patch = null) {
  const dir = path.join(home, 'profiles', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, ...pkg }, null, 2))
  if (patch !== null) fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patch)
  return dir
}

/* ------------------------------------------------------------------ *
 * 一、profile 层补齐：cordis.patch.yml 与 dsh.profile.bundles
 * ------------------------------------------------------------------ */

test('classifyPatchBody 认五种形态，只对最后一份文档下判断', () => {
  assert.equal(classifyPatchBody('').kind, 'empty')
  assert.equal(classifyPatchBody('# 只有注释\n\n').kind, 'empty')
  assert.equal(classifyPatchBody('[]\n').kind, 'empty-flow')
  assert.equal(classifyPatchBody('[ ]  # empty\n').kind, 'empty-flow')
  assert.equal(classifyPatchBody('- insert:\n    - id: x\n').kind, 'block-seq')
  assert.equal(classifyPatchBody('[a, b]\n').kind, 'flow-seq')
  assert.equal(classifyPatchBody('key: value\n').kind, 'unknown')
  // 多文档：前面那份是块序列也不算，只看最后一份 `[]`
  const multi = classifyPatchBody('- insert:\n    - id: x\n---\n[]\n')
  assert.equal(multi.kind, 'empty-flow')
  assert.equal(multi.lines[multi.emptyFlowIndex].trim(), '[]')
})

test('profileHasPurgeBodyInsert 只认 insert 段里的 id / name', () => {
  assert.equal(profileHasPurgeBodyInsert(INSERT_BLOCK), true)
  assert.equal(profileHasPurgeBodyInsert('- insert:\n    - id: dsh-purge-main\n'), true)
  assert.equal(profileHasPurgeBodyInsert('- insert:\n    - name: dsh-purge\n'), true)
  assert.equal(profileHasPurgeBodyInsert(''), false)
  assert.equal(profileHasPurgeBodyInsert('- insert:\n    - id: other\n'), false)
})

test('ensureProfileBodyInsert：空文件写入 INSERT_BLOCK，重复调用不再写', () => {
  const home = freshHome()
  const dir = makeProfile(home, 'p-empty', {}, '')
  const fp = path.join(dir, 'cordis.patch.yml')
  const first = ensureProfileBodyInsert(dir)
  assert.equal(first.ok, true)
  assert.equal(first.wrote, true)
  assert.equal(read(fp), INSERT_BLOCK)
  const second = ensureProfileBodyInsert(dir)
  assert.equal(second.ok, true)
  assert.equal(second.wrote, false)
  assert.equal(read(fp), INSERT_BLOCK)
})

test('ensureProfileBodyInsert：`[]` 整行替换，不追加成第二份文档', () => {
  const home = freshHome()
  const dir = makeProfile(home, 'p-empty-flow', {}, '[]\n')
  const fp = path.join(dir, 'cordis.patch.yml')
  assert.equal(ensureProfileBodyInsert(dir).wrote, true)
  const text = read(fp)
  assert.equal(text, INSERT_BLOCK)
  // 第二份文档的典型症状是出现两段内容；这里必须只有一段
  assert.equal(text.split('---').length - 1, 0)
})

test('ensureProfileBodyInsert：flow-seq 与 mapping 一律不动（宁可不动也别写坏）', () => {
  const home = freshHome()
  const flow = makeProfile(home, 'p-flow', {}, '[a, b]\n')
  const flowFp = path.join(flow, 'cordis.patch.yml')
  const r1 = ensureProfileBodyInsert(flow)
  assert.equal(r1.ok, false)
  assert.equal(r1.wrote, false)
  assert.equal(read(flowFp), '[a, b]\n')

  const map = makeProfile(home, 'p-map', {}, 'key: value\n')
  const mapFp = path.join(map, 'cordis.patch.yml')
  assert.equal(ensureProfileBodyInsert(map).ok, false)
  assert.equal(read(mapFp), 'key: value\n')
})

test('ensureProfileBodyInsert：已有块序列时追加成第二条 insert，前面留空行', () => {
  const home = freshHome()
  const dir = makeProfile(home, 'p-block', {}, '- insert:\n    - id: other\n')
  const fp = path.join(dir, 'cordis.patch.yml')
  assert.equal(ensureProfileBodyInsert(dir).wrote, true)
  const text = read(fp)
  assert.ok(text.startsWith('- insert:\n    - id: other\n'), text)
  assert.ok(text.includes('\n\n- insert:\n    - id: dsh-purge\n'), text)
  assert.equal(text.trimEnd().endsWith('hooksDenyBypass: true'), true)
})

test('ensureProfileBundles 补 dsh.profile.bundles 且幂等，坏 JSON 不写盘', () => {
  const home = freshHome()
  const dir = makeProfile(home, 'p-bundles', { dsh: { profile: { bundles: ['other'] } } })
  const fp = path.join(dir, 'package.json')
  assert.equal(ensureProfileBundles(dir).wrote, true)
  assert.deepEqual(JSON.parse(read(fp)).dsh.profile.bundles, ['other', PURGE_NAME])
  assert.equal(ensureProfileBundles(dir).wrote, false)

  const broken = path.join(home, 'profiles', 'p-broken')
  fs.mkdirSync(broken, { recursive: true })
  const brokenFp = put(path.join(broken, 'package.json'), '{ not json')
  const r = ensureProfileBundles(broken)
  assert.equal(r.ok, false)
  assert.equal(r.wrote, false)
  assert.equal(read(brokenFp), '{ not json')
})

test('ensurePnpmAllowBuild：空文件直接产裸包名，pnpm 11 删来源键、pnpm 12 保留', () => {
  const home = freshHome()
  const empty = makeProfile(home, 'p-pnpm-empty')
  const fp = path.join(empty, 'pnpm-workspace.yaml')
  const r = ensurePnpmAllowBuild(empty)
  assert.equal(r.wrote, true)
  assert.equal(read(fp), `allowBuilds:\n  ${PURGE_NAME}: true\n`)
  assert.equal(ensurePnpmAllowBuild(empty).wrote, false)

  // pnpm 11 见到 `dsh-purge@https://…` 会 ERR_PNPM_INVALID_VERSION_UNION，必须清掉
  const v11 = makeProfile(home, 'p-pnpm-11', { packageManager: 'pnpm@11.2.2' })
  const v11Fp = put(path.join(v11, 'pnpm-workspace.yaml'),
    `allowBuilds:\n  "${PURGE_NAME}@git+https://x/y": true\n`)
  assert.equal(ensurePnpmAllowBuild(v11).wrote, true)
  assert.equal(read(v11Fp), `allowBuilds:\n  ${PURGE_NAME}: true\n`)

  // pnpm 12 只认来源键，删了就要重新弹审批：来源键必须留着，同时补一条裸包名
  const v12 = makeProfile(home, 'p-pnpm-12', { packageManager: 'pnpm@12.0.0' })
  const v12Text = `allowBuilds:\n  "${PURGE_NAME}@git+https://x/y": true\n`
  put(path.join(v12, 'pnpm-workspace.yaml'), v12Text)
  assert.equal(ensurePnpmAllowBuild(v12).wrote, true)
  assert.equal(read(path.join(v12, 'pnpm-workspace.yaml')),
    `${v12Text}  ${PURGE_NAME}: true\n`)
})

test('pnpmMajor 以 node_modules/.modules.yaml 为准，压过 package.json', () => {
  const home = freshHome()
  const dir = makeProfile(home, 'p-pnpm-modules', { packageManager: 'pnpm@12.0.0' })
  put(path.join(dir, 'node_modules', '.modules.yaml'), 'packageManager: pnpm@11.9.0\n')
  const fp = put(path.join(dir, 'pnpm-workspace.yaml'),
    `allowBuilds:\n  "${PURGE_NAME}@git+https://x/y": true\n`)
  assert.equal(ensurePnpmAllowBuild(dir).wrote, true)
  assert.equal(read(fp), `allowBuilds:\n  ${PURGE_NAME}: true\n`)
})

test('ensurePnpmAllowBuild 现状锁定：原文有重复键仍会被去重后写入', () => {
  const home = freshHome()
  const dir = makeProfile(home, 'p-pnpm-dup')
  const fp = put(path.join(dir, 'pnpm-workspace.yaml'), 'allowBuilds:\n  a: true\n  a: true\n')
  assert.equal(validateAllowBuildRewrite(read(fp)), false)
  const r = ensurePnpmAllowBuild(dir)
  // 先 rewrite 再校验，校验的是 next 而不是原文 —— 所以坏原文也被「修好」并落盘
  assert.equal(r.wrote, true)
  assert.equal(read(fp), 'allowBuilds:\n  a: true\n  dsh-purge: true\n')
})

test('ensurePnpmAllowBuild：重写后仍不合法的原文一律不写盘', () => {
  const home = freshHome()
  const dir = makeProfile(home, 'p-pnpm-topdup')
  // 顶层键重复的 YAML 本身坏，rewrite 只是追加一段，救不回来 → 必须原样留着
  const raw = 'a: 1\na: 2\n'
  const fp = put(path.join(dir, 'pnpm-workspace.yaml'), raw)
  const r = ensurePnpmAllowBuild(dir)
  assert.equal(r.ok, false)
  assert.equal(r.wrote, false)
  assert.equal(r.reason, 'allowBuilds-invalid')
  assert.equal(read(fp), raw)
})

test('allowBuilds 行格式与校验：URL 键加引号，round-trip 无损', () => {
  assert.equal(formatAllowBuildLine('a'), '  a: true')
  assert.equal(formatAllowBuildLine('a@https://x/y'), '  "a@https://x/y": true')
  assert.deepEqual(parseAllowBuildLine('  "a@https://x/y": true'), { key: 'a@https://x/y', value: 'true' })
  assert.deepEqual(parseAllowBuildLine("  'a@git+https://x/y': true"), { key: 'a@git+https://x/y', value: 'true' })
  // 未加引号的 URL 键：URL 里的冒号后面跟 `/`，不会把键切断
  assert.deepEqual(parseAllowBuildLine('  a@https://x/y: true'), { key: 'a@https://x/y', value: 'true' })
  // 顶层键（无缩进）不算 allowBuilds 条目
  assert.equal(parseAllowBuildLine('allowBuilds:'), null)
  assert.equal(validateAllowBuildRewrite('allowBuilds:\n  a: true\n'), true)
  assert.equal(validateAllowBuildRewrite('allowBuilds:\n  a: true\n  a: true\n'), false)
  assert.equal(validateAllowBuildRewrite('a: 1\na: 2\n'), false)
  assert.equal(purgePnpmBuildSpecs().join(','), PURGE_NAME)
})

test('ensureAllProfileInstall 只处理真的装了本插件的 profile', () => {
  const home = freshHome()
  const owned = makeProfile(home, 'p-own', { dsh: { profile: { bundles: [PURGE_NAME] } } }, '[]\n')
  const byModule = makeProfile(home, 'p-module', {})
  put(path.join(byModule, 'node_modules', PURGE_NAME, 'package.json'), '{"name":"dsh-purge"}')
  const unrelated = makeProfile(home, 'p-unrelated', {}, '[]\n')

  const rows = ensureAllProfileInstall(home)
  const names = rows.map((r) => path.basename(r.dir)).sort()
  assert.deepEqual(names, ['p-module', 'p-own'])
  assert.equal(read(path.join(owned, 'cordis.patch.yml')), INSERT_BLOCK)
  assert.equal(read(path.join(unrelated, 'cordis.patch.yml')), '[]\n')
  assert.equal(read(path.join(unrelated, 'package.json')).includes('bundles'), false)
  for (const row of rows) assert.equal(row.ok, true, JSON.stringify(row))

  const inserted = ensureAllProfileBodyInserts(home)
  assert.equal(inserted.length, rows.length)
  assert.equal(inserted.every((row) => row.ok === true), true)
  assert.equal(inserted.every((row) => row.wrote === false), true)
  assert.equal(listProfileDirs(home).length, 3)
})

/* ------------------------------------------------------------------ *
 * 二、卸载：先还原再删，且不碰源码目录
 * ------------------------------------------------------------------ */

test('wasApplied 四路：备份 / 已打补丁 / shim 已改 / 都没有', () => {
  assert.equal(wasApplied(null), false)
  assert.equal(wasApplied({}), false)
  assert.equal(wasApplied({ has_backup: true }), true)
  assert.equal(wasApplied({ patches_applied: 2 }), true)
  assert.equal(wasApplied({ shim_ps1: 'patched' }), true)
  assert.equal(wasApplied({ shim_cmd: 'original', shim_ps1: 'original', shim_bin: 'original' }), false)
})

test('shouldDeletePluginTree 只认安装树，npm link 的源码目录不删', () => {
  assert.equal(shouldDeletePluginTree('C:/x/node_modules/dsh-purge'), true)
  assert.equal(shouldDeletePluginTree('C:/Users/me/src/dsh-purge'), false)
  assert.equal(shouldDeletePluginTree(''), false)
})

test('stripPluginFromPackage 清四个依赖段 + 顶层与嵌套 bundles/plugins', () => {
  const pkg = {
    dependencies: { 'dsh-purge': '1.0.0', a: '2' },
    devDependencies: { 'dsh-purge': 'link:../x' },
    peerDependencies: { 'dsh-purge': '*' },
    optionalDependencies: { 'dsh-purge': '1' },
    bundles: ['dsh-purge@1.2.3', 'other'],
    plugins: [{ id: 'dsh-purge' }, { name: 'dsh-purge' }, { id: 'keep' }],
    dsh: { profile: { bundles: ['dsh-purge', 'other'], plugins: ['dsh-purge'] } },
  }
  assert.equal(stripPluginFromPackage(pkg), true)
  assert.deepEqual(pkg.dependencies, { a: '2' })
  assert.deepEqual(pkg.devDependencies, {})
  assert.deepEqual(pkg.peerDependencies, {})
  assert.deepEqual(pkg.optionalDependencies, {})
  assert.deepEqual(pkg.bundles, ['other'])
  assert.deepEqual(pkg.plugins, [{ id: 'keep' }])
  assert.deepEqual(pkg.dsh.profile.bundles, ['other'])
  assert.deepEqual(pkg.dsh.profile.plugins, [])
  // 幂等：没有 purge 时不报 changed
  assert.equal(stripPluginFromPackage(pkg), false)
  assert.equal(stripPluginFromPackage(null), false)
})

test('listInstalledProfiles 三种识别方式都算装了', () => {
  const home = freshHome()
  makeProfile(home, 'a-deps', { dependencies: { 'dsh-purge': '1.2.3' } })
  makeProfile(home, 'b-bundles', { dsh: { profile: { bundles: [PURGE_NAME] } } })
  const c = makeProfile(home, 'c-module', {})
  put(path.join(c, 'node_modules', PURGE_NAME, 'package.json'), '{"name":"dsh-purge"}')
  makeProfile(home, 'd-other', { dependencies: { other: '1.0.0' } })

  const rows = listInstalledProfiles(home)
  assert.deepEqual(rows.map((r) => r.name), ['a-deps', 'b-bundles', 'c-module'])
  assert.equal(rows[0].spec, '1.2.3')
  assert.equal(rows[2].hasModule, true)
  assert.equal(listInstalledProfiles(path.join(home, 'nope')).length, 0)
})

test('uninstallPurge 先还原再清理，stage 顺序固定且真的摘掉 profile 里的引用', async () => {
  const home = freshHome()
  // 假宿主树：让 gatherState 找到 ai_base，revertAll 才有对象可动
  const ai = path.join(home, 'ai')
  put(path.join(ai, 'dsh-agent-instructions', 'lib', 'index.js'), 'module.exports = {}\n')
  process.env.DSH_BASE = ai
  const pdir = makeProfile(home, 'web', {
    dependencies: { 'dsh-purge': '1.2.3', other: '1.0.0' },
    dsh: { profile: { bundles: ['dsh-purge', 'other'] } },
  })

  const stages = []
  const out = await uninstallPurge({ onStage: (s) => stages.push(s) })
  assert.deepEqual(stages, ['locate', 'revert', 'shim', 'flash', 'cleanup', 'done'])
  assert.equal(out.ok, true)
  assert.equal(out.errors.length, 0)
  assert.deepEqual(out.profiles, ['web'])
  assert.deepEqual(out.stripped, ['web'])
  assert.equal(out.needRestart, true)
  assert.equal(out.drillGrantCleared, false)
  assert.equal(out.presetDefault.live, false)

  const pkg = JSON.parse(read(path.join(pdir, 'package.json')))
  assert.deepEqual(pkg.dependencies, { other: '1.0.0' })
  assert.deepEqual(pkg.dsh.profile.bundles, ['other'])
  delete process.env.DSH_BASE
})

test('uninstallPurge 把数据目录登记进清理队列，安装树永不登记', async () => {
  const home = freshHome()
  const ai = path.join(home, 'ai')
  put(path.join(ai, 'dsh-agent-instructions', 'lib', 'index.js'), 'module.exports = {}\n')
  process.env.DSH_BASE = ai
  fs.mkdirSync(path.join(home, 'dsh-purge'), { recursive: true })

  const out = await uninstallPurge({ onStage: () => {} })
  assert.equal(out.ok, true)
  const cleaned = out.cleanup.map((p) => path.basename(p))
  assert.ok(cleaned.includes('dsh-purge'), out.cleanup.join(' | '))
  // resources/ 下的 junction 一旦被递归删掉会清空整个 runtime，必须排除
  assert.equal(out.cleanup.some((p) => /[\\/]resources[\\/]/.test(p)), false)
  delete process.env.DSH_BASE
})

/* ------------------------------------------------------------------ *
 * 三、通道与版本状态
 * ------------------------------------------------------------------ */

test('normalizeChannel 只认 beta，其余一律 stable（现状锁定：不做 trim）', () => {
  assert.equal(normalizeChannel('beta'), 'beta')
  assert.equal(normalizeChannel('BETA'), 'beta')
  assert.equal(normalizeChannel('stable'), 'stable')
  assert.equal(normalizeChannel(''), 'stable')
  assert.equal(normalizeChannel(undefined), 'stable')
  // 现状锁定：写进来的值是 trim 过的（writeChannelState 会 trim pin，channel 走 normalize），
  // 所以带空白的 ` Beta ` 直接判成 stable；真要支持得先改 normalizeChannel 本身。
  assert.equal(normalizeChannel('  Beta '), 'stable')
})

test('versionIsNewer 七组：core 比较优先，pre 比无 pre 旧', () => {
  assert.equal(versionIsNewer('1.0.0', '0.9.9'), true)
  assert.equal(versionIsNewer('1.0.0', '1.0.0'), false)
  assert.equal(versionIsNewer('1.0.0', '1.0.0-beta'), true)
  assert.equal(versionIsNewer('1.0.0-beta', '1.0.0'), false)
  assert.equal(versionIsNewer('1.0.1-beta', '1.0.0'), true)
  assert.equal(versionIsNewer('v2.0.0', '1.9.9'), true)
  assert.equal(versionIsNewer('', '1.0.0'), false)
  assert.equal(versionIsNewer('1.0.0', ''), true)
})

test('latestStableVersion 跳过 beta 通道、beta 名与已撤回版本', () => {
  const versions = [
    { version: '1.1.0', channel: 'stable' },
    { version: '1.2.0-beta', channel: 'beta' },
    { version: '1.1.9', channel: 'stable' },
    { version: 'v1.3.0', channel: 'stable' },
    { version: '1.1.11-beta', channel: 'stable' },
    // 版本号更大的 beta 也不能顶上来
    { version: '9.9.9', channel: 'beta' },
    { version: '2.0.0-beta', channel: 'stable' },
  ]
  assert.equal(latestStableVersion(versions), '1.3.0')
  assert.equal(latestStableVersion([]), '')
  assert.equal(latestStableVersion(null), '')
})

test('hideListedVersion：beta 通道头可见，其余 beta 名一律隐藏', () => {
  assert.equal(hideListedVersion({ version: '1.2.0-beta', channel: 'beta', ref: 'beta' }), false)
  assert.equal(hideListedVersion({ version: '1.2.0-beta', channel: 'beta', ref: 'v1.2.0-beta' }), true)
  assert.equal(hideListedVersion({ version: '1.2.0', channel: 'stable' }), false)
  assert.equal(hideListedVersion({ version: '1.1.11-beta', channel: 'stable' }), true)
  assert.equal(hideListedVersion(null), true)
})

test('readChannelState 坏文件回落 stable，beta pin 被清空并回写', () => {
  const home = freshHome()
  const fp = path.join(home, 'dsh-purge', 'channel.json')
  assert.deepEqual(readChannelState(), { channel: 'stable', pin: '' })
  assert.equal(fs.existsSync(fp), false, '没有文件时不该凭空写盘')

  put(fp, '{ broken')
  assert.deepEqual(readChannelState(), { channel: 'stable', pin: '' })

  put(fp, JSON.stringify({ channel: 'BETA', pin: 'v1.1.11-beta' }))
  const state = readChannelState()
  assert.deepEqual(state, { channel: 'beta', pin: '' })
  // 清掉的 pin 必须落盘，否则面板每次刷新都读到同一个坏 pin
  assert.deepEqual(JSON.parse(read(fp)), { channel: 'beta', pin: '' })

  put(fp, JSON.stringify({ channel: 'beta', pin: '1.0.0' }))
  assert.deepEqual(readChannelState(), { channel: 'beta', pin: '1.0.0' })
})

test('channelPublic 给出中文标签，未知通道回落正式版', () => {
  assert.deepEqual(channelPublic({ channel: 'stable', pin: '' }),
    { channel: 'stable', channelLabel: '正式版', pin: '' })
  assert.deepEqual(channelPublic({ channel: 'beta', pin: '1.0.0' }),
    { channel: 'beta', channelLabel: '测试版', pin: '1.0.0' })
  assert.equal(channelPublic({ channel: 'bogus', pin: '' }).channelLabel, '正式版')
})

test('safeUpdateRef 只放行 semver / 分支名 / 短 sha', () => {
  for (const ok of ['main', 'master', 'beta', 'v1.2.3', '1.2.3-beta.1', 'abcdef1']) {
    assert.equal(safeUpdateRef(ok), ok, ok)
  }
  for (const bad of ['', 'a b', '../../etc', 'main; rm -rf /', 'v1']) {
    assert.equal(safeUpdateRef(bad), '', bad)
  }
})

test('isLinkSpec / resolveLinkDir 认本地链接安装', () => {
  for (const spec of ['link:../x', 'file:./x', '.', './x', '../x']) {
    assert.equal(isLinkSpec(spec), true, spec)
  }
  assert.equal(isLinkSpec('1.2.3'), false)
  assert.equal(isLinkSpec(''), false)
  assert.equal(path.basename(resolveLinkDir(path.join(sandbox, 'a', 'b'), 'link:../c')), 'c')
})

test('markCurrent 只在同版本同通道里挑当前行，pin 优先', () => {
  const rows = [
    { version: '1.2.0', channel: 'stable', ref: 'main', sha: 'abcdef1234' },
    { version: '1.1.0', channel: 'stable', ref: 'v1.1.0', sha: 'ffff' },
  ]
  const marked = markCurrent(rows, { channel: 'stable', pin: '' }, '1.2.0', 'abcdef1234')
  assert.deepEqual(marked.map((r) => [r.version, r.current, r.shaShort]),
    [['1.2.0', true, 'abcdef1'], ['1.1.0', false, 'ffff']])

  // pin 指向哪一行就标哪一行，哪怕版本更旧
  const pinned = markCurrent(rows, { channel: 'stable', pin: 'v1.1.0' }, '1.2.0', 'abcdef1234')
  assert.deepEqual(pinned.map((r) => r.current), [false, true])

  // 版本对不上时一行都不标，避免把旧提交号当当前
  const none = markCurrent(rows, { channel: 'stable', pin: '' }, '9.9.9', 'zzz')
  assert.deepEqual(none.map((r) => r.current), [false, false])
})
