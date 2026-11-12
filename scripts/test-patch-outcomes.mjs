// 补丁判定层（lib/core.js）的行为锁定：状态汇总、软成功、报告合并、就绪判据、
// 宿主版本比对、YAML 净化，以及 applyPatches / patchStatus 在假宿主树上的四态。
//
// 为什么这一批要单独守：
// 1) rollupPatchStatus 是「用户看到什么」与「能不能重启」的共同来源。它的分支顺序
//    （写错误 > 严格补丁失配 > 漂移 > 已打上 > 已落盘 > 全缺 > 跳过）历史上被改错过：
//    漂移要压过 applied，否则一个文件打上、另一个静默失效，状态页仍然是绿的。
// 2) isPatchResultSoftOk / patchStatusReady 是两套独立实现，一套管「Apply 是否被阻断」，
//    一套管「列表上是否显示已就绪」。两边对 skipped / drifted / optional / strictFiles
//    的口径必须一致，否则会出现「能应用但永远不显示就绪」这种自相矛盾状态。
// 3) applyPatches 的写盘分支里藏着 hit_count_mismatch 这个硬契约：官方同名代码多一处
//    或少一处时，宁可整条拒写也不猜。这条一旦退化成「照写」，就会把宿主改坏。
// 4) sanitizeYamlPersonaScalars 修的是「折叠块只换首行会留下残段，YAML 直接废掉、
//    dsh 起不来」。它必须只碰含可丢弃段落的折叠块，对普通文本一字不动。
//
// 本文件只用假 aiBase 树 + 临时 DSH_HOME，不碰本机真实安装。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  ALL_PATCHES,
  ALLOW_EXEC_CORE,
  applyPatches,
  hostCompat,
  isPatchResultSoftOk,
  mergeApplyReports,
  parseHostVersion,
  patchStatus,
  patchStatusReady,
  readHostVersion,
  rollupPatchStatus,
  sanitizeYamlPersonaScalars,
  summarizeApplyReport,
  targetFiles,
} from '../lib/core.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dshpurge-outcome-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = join(sandbox, 'home')
mkdirSync(process.env.DSH_HOME, { recursive: true })

// applyPatches 内部会调 repairPluginCordisYaml()，而它作用的是本仓库自己的
// cordis.patch.yml。净化必须是幂等的（实测也确实幂等），否则跑一次测试就偷偷改了
// 仓库文件、还要靠 check:eol 才发现。这里在收尾时把它钉死。
const REPO_YAML = join(process.cwd(), 'cordis.patch.yml')
const REPO_YAML_BEFORE = existsSync(REPO_YAML) ? readFileSync(REPO_YAML) : null

test.after(() => {
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    // Windows 上偶发 EPERM，临时目录留给系统清理。
  }
  if (REPO_YAML_BEFORE) {
    const now = readFileSync(REPO_YAML)
    if (!now.equals(REPO_YAML_BEFORE)) {
      throw new Error(
        'applyPatches 的 repairPluginCordisYaml() 改动了仓库自己的 cordis.patch.yml：'
          + '净化不再幂等，快查 sanitizeYamlPersonaScalars。',
      )
    }
  }
})

/** 造一棵「桌面解包布局」的 aiBase 树，files 是 rel → 内容。 */
function makeTree(tag, files = {}, pkg = { name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' }) {
  const aiBase = join(sandbox, tag, 'dsh', 'node_modules', '@deepseek-ai')
  mkdirSync(join(aiBase, 'dsh'), { recursive: true })
  writeFileSync(join(aiBase, 'dsh', 'package.json'), JSON.stringify(pkg))
  for (const [rel, body] of Object.entries(files)) {
    const fp = join(aiBase, rel)
    mkdirSync(dirname(fp), { recursive: true })
    writeFileSync(fp, body)
  }
  return aiBase
}

/** targetFiles 里 agent-instructions 的首选相对路径；一个文件就够驱动 applyPatches。 */
const AI_REL = join('dsh-agent-instructions', 'lib', 'index.js')

/** 造一条「把 `const a = 1;` 变成带 marker 的版本」的假补丁。 */
function fakePatch(id, over = {}) {
  return {
    id,
    name: `FAKE_${id}`,
    file: ['agent-instructions'],
    markers: ['[dsh-purge] fake'],
    replacements: [{ pattern: 'const a = 1;', replace: 'const a = 1; // [dsh-purge] fake' }],
    ...over,
  }
}

/* ------------------------------------------------------- rollupPatchStatus */

test('rollupPatchStatus：写错误压过一切', () => {
  assert.equal(rollupPatchStatus({ applied: 9, already: 3, lastError: 'read_error', keyCount: 1 }), 'read_error')
  assert.equal(
    rollupPatchStatus({ applied: 9, lastError: 'hit_count_mismatch:#9:2/1', keyCount: 1 }),
    'hit_count_mismatch:#9:2/1',
  )
  assert.equal(rollupPatchStatus({ missing: 1, lastError: 'write_error:EACCES', keyCount: 1 }), 'write_error:EACCES')
})

test('rollupPatchStatus：严格补丁失配报 pattern_not_found，非严格也报同一个词', () => {
  assert.equal(rollupPatchStatus({ applied: 3, notFound: 1, keyCount: 2, strictFiles: true }), 'pattern_not_found')
  assert.equal(rollupPatchStatus({ applied: 0, notFound: 1, keyCount: 2, strictFiles: false }), 'pattern_not_found')
})

test('rollupPatchStatus：漂移压过「已打上」', () => {
  // 这是最重要的一条：多文件补丁里一个文件打上、另一个漂了，整体必须报 drifted，
  // 否则状态页会把半失效显示成全绿。
  assert.equal(rollupPatchStatus({ applied: 3, drifted: 1, keyCount: 2 }), 'drifted')
  assert.equal(rollupPatchStatus({ applied: 0, drifted: 1, keyCount: 1 }), 'drifted')
})

test('rollupPatchStatus：applied / already 的优先级与 layoutSoft 例外', () => {
  assert.equal(rollupPatchStatus({ applied: 1, keyCount: 1 }), 'applied')
  assert.equal(rollupPatchStatus({ applied: 1, already: 1, keyCount: 2 }), 'applied')
  assert.equal(rollupPatchStatus({ already: 1, notFound: 0, keyCount: 2 }), 'already')
  // layoutSoft 决定 already 还成不成立：只剩「这份文件本来就没这段代码」时，
  // 布局型补丁不算漂移，普通补丁算。
  assert.equal(rollupPatchStatus({ already: 1, notFound: 1, keyCount: 2, layoutSoft: true }), 'already')
  assert.equal(rollupPatchStatus({ already: 1, notFound: 1, keyCount: 2, layoutSoft: false }), 'pattern_not_found')
})

test('rollupPatchStatus：文件全缺报 missing_file，部分缺且无残留报 skipped', () => {
  assert.equal(rollupPatchStatus({ missing: 2, keyCount: 2 }), 'missing_file')
  assert.equal(rollupPatchStatus({ missing: 1, notFound: 0, keyCount: 2 }), 'skipped')
})

test('rollupPatchStatus：missing / notFound 都没有默认值，keyCount 不参与兜底', () => {
  // 现状（别「修」它）：missing 与 notFound 都没有默认值。
  // - missing 是 undefined 时 `missing === keyCount` 恒为假；
  // - notFound 是 undefined 时 `notFound === 0` 也恒为假。
  // 于是漏传这两个计数的调用方拿到的是 "pattern_not_found"，而不是 missing_file / skipped。
  // 三种都属失败态、不会制造假绿灯，所以保留原样，只把它钉住：
  // 谁哪天给 missing/notFound 加了默认值 0，下面四条会立刻变红。
  assert.equal(rollupPatchStatus({ keyCount: 0 }), 'pattern_not_found')
  assert.equal(rollupPatchStatus({ keyCount: 2 }), 'pattern_not_found')
  assert.equal(rollupPatchStatus({ missing: 0, keyCount: 2 }), 'pattern_not_found')
  // 两个计数都显式给全，才是文档里写的那两个分支。
  assert.equal(rollupPatchStatus({ missing: 0, notFound: 0, keyCount: 0 }), 'missing_file')
  assert.equal(rollupPatchStatus({ missing: 0, notFound: 0, keyCount: 2 }), 'skipped')
  assert.equal(rollupPatchStatus({ missing: 2, notFound: 0, keyCount: 2 }), 'missing_file')
})

/* ----------------------------------------------------- isPatchResultSoftOk */

test('isPatchResultSoftOk：五个恒软状态不受补丁形状影响', () => {
  for (const status of ['applied', 'already', 'missing_file', 'na', 'off']) {
    for (const patch of [null, { id: 1 }, { id: 1, strictFiles: true }]) {
      assert.equal(isPatchResultSoftOk({ patch_id: 1, status }, patch), true, `${status} / ${JSON.stringify(patch)}`)
    }
  }
})

test('isPatchResultSoftOk：空 row 一律 false', () => {
  assert.equal(isPatchResultSoftOk(null), false)
  assert.equal(isPatchResultSoftOk(undefined), false)
})

test('isPatchResultSoftOk：drifted 恒软成功（漂移不阻断 Apply）', () => {
  // 理由在源码注释里：官方宿主上被更老版本插件打过一遍的补丁，marker 文案对不上
  // 就会被误判成漂移，拿它去阻断重启会直接把老版本用户堵死。所以漂移只标红，不挡。
  for (const patch of [null, { id: 1 }, { id: 1, strictFiles: true }]) {
    assert.equal(isPatchResultSoftOk({ patch_id: 1, status: 'drifted' }, patch), true)
  }
})

test('isPatchResultSoftOk：skipped 只对可选补丁或自标记型补丁软成功', () => {
  assert.equal(isPatchResultSoftOk({ patch_id: 1, status: 'skipped' }, null), false)
  assert.equal(isPatchResultSoftOk({ patch_id: 1, status: 'skipped' }, { id: 1 }), false)
  assert.equal(isPatchResultSoftOk({ patch_id: 1, status: 'skipped' }, { id: 1, optional: true }), true)
  // 自标记型：pattern 本身带 [dsh-purge] 的撤销型补丁，不在 = 本来没加过。
  assert.equal(
    isPatchResultSoftOk({ patch_id: 1, status: 'skipped' }, {
      id: 1,
      replacements: [{ pattern: '// [dsh-purge] x', replace: '' }],
    }),
    true,
  )
})

test('isPatchResultSoftOk：pattern_not_found 的三方口径', () => {
  assert.equal(isPatchResultSoftOk({ patch_id: 1, status: 'pattern_not_found' }, { id: 1 }), false)
  assert.equal(isPatchResultSoftOk({ patch_id: 1, status: 'pattern_not_found' }, { id: 1, optional: true }), true)
  // optional + strictFiles：strictFiles 先判，仍是硬失败。
  assert.equal(
    isPatchResultSoftOk({ patch_id: 1, status: 'pattern_not_found' }, { id: 1, optional: true, strictFiles: true }),
    false,
  )
  // 布局型软补丁（id 4/25/26 身份排版、5/11/12 审批句、softSettle）
  for (const id of [4, 25, 26, 5, 11, 12]) {
    assert.equal(isPatchResultSoftOk({ patch_id: id, status: 'pattern_not_found' }, { id }), true, `id ${id}`)
  }
  assert.equal(isPatchResultSoftOk({ patch_id: 1, status: 'pattern_not_found' }, { id: 1, softSettle: true }), true)
})

test('isPatchResultSoftOk：hit_count_mismatch 前缀只对可选补丁软成功', () => {
  const row = { patch_id: 1, status: 'hit_count_mismatch:#9:2/1' }
  assert.equal(isPatchResultSoftOk(row, { id: 1 }), false)
  assert.equal(isPatchResultSoftOk(row, { id: 1, optional: true }), true)
})

test('isPatchResultSoftOk：pending / unmatched 一律硬失败', () => {
  for (const status of ['pending', 'unmatched']) {
    assert.equal(isPatchResultSoftOk({ patch_id: 1, status }, null), false)
    assert.equal(isPatchResultSoftOk({ patch_id: 1, status }, { id: 1, optional: true }), false)
    assert.equal(isPatchResultSoftOk({ patch_id: 1, status }, { id: 1, softSettle: true }), false)
  }
})

test('isPatchResultSoftOk：不给 patch 参数时会按 patch_id 去 ALL_PATCHES 里找', () => {
  // #62 是 optional 且 drifted —— 靠这条证明「查表」这一支真的走了。
  assert.equal(isPatchResultSoftOk({ patch_id: 62, status: 'drifted' }), true)
  // 未知 id + skipped：查不到 patch → 不软成功。
  assert.equal(isPatchResultSoftOk({ patch_id: 99999, status: 'skipped' }), false)
})

/* ------------------------------------------------- summarizeApplyReport */

test('summarizeApplyReport：按软/硬把行分进两组，并数出 applied 与 already', () => {
  const report = [
    { patch_id: 1, status: 'applied' },
    { patch_id: 2, status: 'already' },
    { patch_id: 62, status: 'drifted' },
    { patch_id: 9999, status: 'pending' },
    { patch_id: 42, status: 'skipped' },
    { id: 6, status: 'na' },
  ]
  const sum = summarizeApplyReport(report)
  // 硬失败：只有 9999（pending）与 42（skipped，非 optional 非自标记）。
  assert.deepEqual(sum.failed.map((r) => r.patch_id ?? r.id), [9999, 42])
  // 软：62 drifted、6 na，以及两个成功态。
  assert.deepEqual(sum.soft.map((r) => r.patch_id ?? r.id), [1, 2, 62, 6])
  assert.equal(sum.applied, 1)
  assert.equal(sum.already, 1)
})

test('summarizeApplyReport：传自定义 patches 时按传入的那份判软硬', () => {
  const report = [
    { patch_id: 7, status: 'skipped' },
    { patch_id: 8, status: 'pattern_not_found' },
  ]
  const sum = summarizeApplyReport(report, [{ id: 7, optional: true }, { id: 8 }])
  assert.deepEqual(sum.soft.map((r) => r.patch_id), [7])
  assert.deepEqual(sum.failed.map((r) => r.patch_id), [8])
})

/* ---------------------------------------------------- mergeApplyReports */

test('mergeApplyReports：多宿主合并取最差状态，并按 patch_id 升序', () => {
  const merged = mergeApplyReports([
    [{ patch_id: 3, status: 'applied' }, { patch_id: 1, status: 'already' }],
    [{ patch_id: 3, status: 'pattern_not_found' }, { patch_id: 2, status: 'na' }],
    [{ id: 1, status: 'failed' }],
  ])
  assert.deepEqual(merged.map((r) => `${r.patch_id}:${r.status}`), [
    '1:failed',
    '2:na',
    '3:pattern_not_found',
  ])
  // id 字段被规范化成 patch_id，下游只看这一个键。
  assert.ok(merged.every((r) => typeof r.patch_id === 'number'))
})

test('mergeApplyReports：空输入返回空数组，未知状态按最差处理', () => {
  assert.deepEqual(mergeApplyReports([]), [])
  // APPLY_STATUS_RANK 里没有的状态兜底 rank 0，比 applied(4) 更差 → 留下 "weird"。
  const merged = mergeApplyReports([[{ patch_id: 7, status: 'weird' }], [{ patch_id: 7, status: 'applied' }]])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].status, 'weird')
})

test('mergeApplyReports：同 rank 时保留先出现的那一行', () => {
  const merged = mergeApplyReports([[{ patch_id: 5, status: 'applied', name: 'first' }], [{ patch_id: 5, status: 'applied', name: 'second' }]])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].name, 'first')
})

/* ------------------------------------------------------ patchStatusReady */

test('patchStatusReady：五个恒就绪状态与 na', () => {
  for (const status of ['applied', 'already', 'missing_file', 'off']) {
    assert.equal(patchStatusReady(status, null), true, status)
  }
  // na = 这一版本来就不该打，不算就绪。
  assert.equal(patchStatusReady('na', null), false)
  assert.equal(patchStatusReady('na', { id: 1, optional: true }), false)
})

test('patchStatusReady：drifted / skipped 只对可选补丁（或自标记型）就绪', () => {
  assert.equal(patchStatusReady('drifted', null), false)
  assert.equal(patchStatusReady('drifted', { id: 1 }), false)
  assert.equal(patchStatusReady('drifted', { id: 1, optional: true }), true)
  assert.equal(patchStatusReady('skipped', null), false)
  assert.equal(patchStatusReady('skipped', { id: 1, optional: true }), true)
  assert.equal(
    patchStatusReady('skipped', { id: 1, replacements: [{ pattern: '# [dsh-purge] x', replace: '' }] }),
    true,
  )
})

test('patchStatusReady：pattern_not_found 的三方口径', () => {
  assert.equal(patchStatusReady('pattern_not_found', { id: 1 }), false)
  assert.equal(patchStatusReady('pattern_not_found', { id: 1, optional: true }), true)
  // strictFiles 让 optional 失效：严格补丁的文件宿主一定在，原文对不上必须硬失败。
  assert.equal(patchStatusReady('pattern_not_found', { id: 1, optional: true, strictFiles: true }), false)
})

test('patchStatusReady：pending / unmatched / hit_count_mismatch 一律不就绪', () => {
  for (const status of ['pending', 'unmatched', 'hit_count_mismatch:#9:2/1']) {
    assert.equal(patchStatusReady(status, null), false, status)
    assert.equal(patchStatusReady(status, { id: 1, optional: true }), false, status)
  }
})

/* ----------------------------------------------------- parseHostVersion */

test('parseHostVersion：正常三段版本与预发布后缀', () => {
  assert.deepEqual(parseHostVersion('0.2.2-rc.1'), { major: 0, minor: 2, patch: 2, pre: ['rc', '1'] })
  assert.deepEqual(parseHostVersion('v0.2.2'), { major: 0, minor: 2, patch: 2, pre: [] })
  assert.deepEqual(parseHostVersion(' 1.2.3 '), { major: 1, minor: 2, patch: 3, pre: [] })
  assert.deepEqual(parseHostVersion('1.2.3-alpha.1.2'), { major: 1, minor: 2, patch: 3, pre: ['alpha', '1', '2'] })
})

test('parseHostVersion：预发布后缀保留原大小写（比较时要原样比）', () => {
  assert.deepEqual(parseHostVersion('0.2.2-RC.1').pre, ['RC', '1'])
})

test('parseHostVersion：解析不了一律 null', () => {
  for (const raw of ['1.2', '1.2.3.4', 'abc', '', null, undefined, 3, {}]) {
    assert.equal(parseHostVersion(raw), null, JSON.stringify(raw))
  }
})

/* -------------------------------------------- readHostVersion / hostCompat */

test('readHostVersion：读 <aiBase>/dsh/package.json 并带出路径', () => {
  const aiBase = makeTree('host-ok')
  const host = readHostVersion(aiBase)
  assert.equal(host.version, '0.2.2-rc.1')
  assert.equal(host.name, '@deepseek-ai/dsh')
  assert.equal(host.path, join(aiBase, 'dsh', 'package.json'))
})

test('readHostVersion：名字含 purge 的包不算宿主（别把本插件当宿主）', () => {
  const aiBase = makeTree('host-purge', {}, { name: 'dsh-purge', version: '1.1.94' })
  assert.equal(readHostVersion(aiBase), null)
})

test('readHostVersion：无名 / 坏 JSON / 空 aiBase 都返回 null', () => {
  const noname = makeTree('host-noname', {}, { version: '0.2.2' })
  assert.equal(readHostVersion(noname), null)
  const bad = makeTree('host-badjson', {})
  writeFileSync(join(bad, 'dsh', 'package.json'), '{not json')
  assert.equal(readHostVersion(bad), null)
  assert.equal(readHostVersion(''), null)
})

test('hostCompat：命中 / 未命中 / 多目标命中其一', () => {
  const aiBase = makeTree('compat-ok')
  const hit = hostCompat(aiBase, ['0.2.2-rc.1'])
  assert.equal(hit.known, true)
  assert.equal(hit.ok, true)
  assert.equal(hit.host, '0.2.2-rc.1')
  assert.equal(hit.target, '0.2.2-rc.1')

  const miss = hostCompat(aiBase, ['0.2.2-rc.2'])
  assert.equal(miss.known, true)
  assert.equal(miss.ok, false)

  const some = hostCompat(aiBase, ['0.2.2', '0.2.2-rc.1'])
  assert.equal(some.ok, true)
  assert.equal(some.target, '0.2.2 / 0.2.2-rc.1')
})

test('hostCompat：预发布后缀必须原样相等（0.2.2 ≠ 0.2.2-rc.1）', () => {
  const aiBase = makeTree('compat-pre')
  assert.equal(hostCompat(aiBase, ['0.2.2']).ok, false)
  assert.equal(hostCompat(aiBase, ['0.2.2-rc.1']).ok, true)
})

test('hostCompat：读不到宿主 / 空目标 / 版本解析不了都回 known:false 且 ok:null', () => {
  const missing = hostCompat(join(sandbox, 'no-such-host'), ['0.2.2'])
  assert.equal(missing.known, false)
  assert.equal(missing.ok, null)
  assert.equal(missing.host, '')
  assert.equal(missing.path, '')

  const emptyTarget = hostCompat(makeTree('compat-empty'), [])
  assert.equal(emptyTarget.known, false)
  assert.equal(emptyTarget.ok, null)
  // 目标是空的，但宿主版本读到了，所以 host 字段有值。
  assert.equal(emptyTarget.host, '0.2.2-rc.1')

  const badVer = makeTree('compat-badver', {}, { name: '@deepseek-ai/dsh', version: 'beta' })
  const bad = hostCompat(badVer, ['0.2.2'])
  assert.equal(bad.known, false)
  assert.equal(bad.ok, null)
  assert.equal(bad.host, 'beta')
})

/* ----------------------------------------- sanitizeYamlPersonaScalars */

// 取一段真正的「可丢弃段落」样本：ALLOW_EXEC_CORE 的前 60 字符。
const ALLOW_HEAD = ALLOW_EXEC_CORE.slice(0, 60)

test('sanitizeYamlPersonaScalars：非字符串原样返回，空串原样返回', () => {
  assert.equal(sanitizeYamlPersonaScalars(123), 123)
  assert.equal(sanitizeYamlPersonaScalars(null), null)
  assert.equal(sanitizeYamlPersonaScalars(''), '')
})

test('sanitizeYamlPersonaScalars：不含可丢弃段落的折叠块一字不动', () => {
  const src = 'personaPrefix: >\n  keep this line\n  and this one\nname: x\n'
  assert.equal(sanitizeYamlPersonaScalars(src), src)
})

test('sanitizeYamlPersonaScalars：通用键 text 不含样板时也不能碰', () => {
  // 宿主 YAML 里 `text: >` 到处都是。只有块里真的有样板段才动，
  // 否则会把「折叠换行」改写成「字面块」，那是内容语义变化，不是修复。
  const src = 'text: >\n  a\n  b\n'
  assert.equal(sanitizeYamlPersonaScalars(src), src)
})

test('sanitizeYamlPersonaScalars：整块都是样板时压成空串', () => {
  const out = sanitizeYamlPersonaScalars(`personaPrefix: >\n  ${ALLOW_HEAD}\nname: x\n`)
  assert.equal(out, 'personaPrefix: ""\nname: x\n')
})

test('sanitizeYamlPersonaScalars：样板段与保留段混排时只删样板、转成字面块', () => {
  const out = sanitizeYamlPersonaScalars(`personaPrefix: >\n  ${ALLOW_HEAD} more\n\n  keep this line\nname: x\n`)
  assert.equal(out, 'personaPrefix: |-\n  keep this line\nname: x\n')
})

test('sanitizeYamlPersonaScalars：五类样板段都能认出来', () => {
  const samples = [
    ALLOW_HEAD,
    'Working directory: {{cwd}}.',
    'You are a coding agent powered by something.',
    'Your identity is defined exclusively by the dsh-purge operator prompt',
    'When asked 你是谁 / who are you, answer as the identity defined in prompt-inject.md.',
  ]
  for (const sample of samples) {
    const out = sanitizeYamlPersonaScalars(`personaPrefix: >\n  ${sample}\n\n  keep\nname: x\n`)
    assert.equal(out, 'personaPrefix: |-\n  keep\nname: x\n', sample)
  }
})

test('sanitizeYamlPersonaScalars：孤儿空标量后面拖着的缩进残段会被摘掉', () => {
  assert.equal(
    sanitizeYamlPersonaScalars('personaPrefix: ""\n    dangling: 1\nname: x\n'),
    'personaPrefix: ""\nname: x\n',
  )
  assert.equal(
    sanitizeYamlPersonaScalars("personaPrefix: ''\n    dangling: 1\nname: x\n"),
    "personaPrefix: ''\nname: x\n",
  )
  // 后面没有缩进残段时不动。
  const clean = 'personaPrefix: ""\nname: x\n'
  assert.equal(sanitizeYamlPersonaScalars(clean), clean)
})

test('sanitizeYamlPersonaScalars：多个键一起处理，正文缩进保持原样', () => {
  const out = sanitizeYamlPersonaScalars(
    `prefix: >\n  ${ALLOW_HEAD}\n\n  p\npersona: >\n  ${ALLOW_HEAD}\n\n  q\nsuffix: >\n  ${ALLOW_HEAD}\n\n  r\n`,
  )
  assert.equal(out, 'prefix: |-\n  p\npersona: |-\n  q\nsuffix: |-\n  r\n')
  const deep = sanitizeYamlPersonaScalars(`personaPrefix: >\n      ${ALLOW_HEAD}\n\n      keep\nname: x\n`)
  assert.equal(deep, 'personaPrefix: |-\n      keep\nname: x\n')
})

test('sanitizeYamlPersonaScalars：CRLF 输入保持 CRLF 输出', () => {
  const out = sanitizeYamlPersonaScalars(`personaPrefix: >\r\n  ${ALLOW_HEAD}\r\n\r\n  keep\r\nname: x\r\n`)
  assert.equal(out, 'personaPrefix: |-\r\n  keep\r\nname: x\r\n')
  assert.ok(out.includes('\r\n'))
})

test('sanitizeYamlPersonaScalars：仓库自己的 cordis.patch.yml 已经干净（净化是幂等的）', () => {
  const fp = join(process.cwd(), 'cordis.patch.yml')
  if (!existsSync(fp)) return
  const src = readFileSync(fp, 'utf8')
  assert.equal(sanitizeYamlPersonaScalars(src), src)
})

/* ------------------------------------------- applyPatches / patchStatus */

test('applyPatches：原文命中 → 写盘并报 applied，产物带 marker', async () => {
  const aiBase = makeTree('ap-apply', { [AI_REL]: 'const a = 1;\n' })
  const report = await applyPatches(aiBase, [fakePatch(9001)])
  assert.equal(report.length, 1)
  assert.equal(report[0].status, 'applied')
  assert.equal(report[0].applied, 1)
  assert.equal(report[0].already, 0)
  assert.equal(report[0].drifted, 0)
  assert.equal(report[0].path, join(aiBase, AI_REL))
  assert.equal(readFileSync(join(aiBase, AI_REL), 'utf8'), 'const a = 1; // [dsh-purge] fake\n')
})

test('applyPatches：原文已被改写且没有 marker → drifted，不是 skipped', async () => {
  const aiBase = makeTree('ap-drift', { [AI_REL]: 'const a = 2;\n' })
  const report = await applyPatches(aiBase, [fakePatch(9002)])
  assert.equal(report[0].status, 'drifted')
  assert.equal(report[0].drifted, 1)
  assert.equal(readFileSync(join(aiBase, AI_REL), 'utf8'), 'const a = 2;\n')
})

test('applyPatches：strictFiles 下原文不在报 pattern_not_found 而不是 drifted', async () => {
  const aiBase = makeTree('ap-strict', { [AI_REL]: 'const a = 2;\n' })
  const report = await applyPatches(aiBase, [fakePatch(9003, { strictFiles: true })])
  assert.equal(report[0].status, 'pattern_not_found')
})

test('applyPatches：softFiles 命中的键，漂移记成 self_marked 而不是 drifted', async () => {
  const aiBase = makeTree('ap-soft', { [AI_REL]: 'const a = 2;\n' })
  const report = await applyPatches(aiBase, [fakePatch(9004, { softFiles: ['agent-instructions'] })])
  assert.equal(report[0].status, 'skipped')
  assert.equal(report[0].self_marked, 1)
  assert.equal(report[0].drifted, 0)
})

test('applyPatches：pattern 本身带 [dsh-purge] 的撤销型补丁，不在 = skipped', async () => {
  const aiBase = makeTree('ap-selfmark', { [AI_REL]: 'const a = 2;\n' })
  const report = await applyPatches(aiBase, [
    fakePatch(9005, { markers: ['[dsh-purge] x'], replacements: [{ pattern: '// [dsh-purge] x', replace: '// [dsh-purge] y' }] }),
  ])
  assert.equal(report[0].status, 'skipped')
  assert.equal(report[0].self_marked, 1)
})

test('applyPatches：surfaces 不含当前面 → na，且不碰任何文件', async () => {
  const aiBase = makeTree('ap-na', { [AI_REL]: 'const a = 1;\n' })
  const report = await applyPatches(aiBase, [fakePatch(9006, { surfaces: ['desktop'] })])
  assert.equal(report[0].status, 'na')
  assert.equal(report[0].applied, 0)
  assert.equal(report[0].path, '')
  assert.equal(readFileSync(join(aiBase, AI_REL), 'utf8'), 'const a = 1;\n')
})

test('applyPatches：expect 命中数不符时整条拒写，状态里带实际/期望计数', async () => {
  const aiBase = makeTree('ap-expect', { [AI_REL]: 'const a = 1;\nconst a = 1;\n' })
  const report = await applyPatches(aiBase, [
    fakePatch(9007, { replacements: [{ pattern: 'const a = 1;', replace: 'const a = 1; // [dsh-purge] fake', expect: 1 }] }),
  ])
  assert.equal(report[0].status, 'hit_count_mismatch:#9007:2/1')
  assert.equal(report[0].applied, 0)
  // 关键：原文一字未改，不是「改了一半」。
  assert.equal(readFileSync(join(aiBase, AI_REL), 'utf8'), 'const a = 1;\nconst a = 1;\n')
})

test('applyPatches：expect 与命中数相符时正常写入', async () => {
  const aiBase = makeTree('ap-expect-ok', { [AI_REL]: 'const a = 1;\n' })
  const report = await applyPatches(aiBase, [
    fakePatch(9008, { replacements: [{ pattern: 'const a = 1;', replace: 'const a = 1; // [dsh-purge] fake', expect: 1 }] }),
  ])
  assert.equal(report[0].status, 'applied')
})

test('applyPatches：文件键全落空报 missing_file', async () => {
  const aiBase = makeTree('ap-missing', { [AI_REL]: 'x\n' })
  const report = await applyPatches(aiBase, [fakePatch(9009, { file: ['no-such-key'] })])
  assert.equal(report[0].status, 'missing_file')
  assert.equal(report[0].missing, 1)
})

test('applyPatches：deleteOnly 补丁在原文还在时判 applied，原文不在时判 already', async () => {
  const del = {
    id: 9010,
    name: 'DEL',
    file: ['agent-instructions'],
    deleteOnly: true,
    markers: ['[dsh-purge] del'],
    replacements: [{ pattern: 'const a = 1;\n', replace: '' }],
  }
  const hit = makeTree('ap-del-hit', { [AI_REL]: 'const a = 1;\nconst b = 2;\n' })
  const r1 = await applyPatches(hit, [del])
  assert.equal(r1[0].status, 'applied')
  assert.equal(readFileSync(join(hit, AI_REL), 'utf8'), 'const b = 2;\n')

  const miss = makeTree('ap-del-miss', { [AI_REL]: 'const b = 2;\n' })
  const r2 = await applyPatches(miss, [del])
  assert.equal(r2[0].status, 'already')
})

test('applyPatches：多文件键里只要有一个漂移，整体报 drifted', async () => {
  const aiBase = makeTree('ap-multi', {
    [join('dsh-sandbox', 'lib', 'index.js')]: 'const a = 1;\n',
    [join('dsh-sandbox', 'lib', 'types', 'escalation.js')]: 'const b = 2;\n',
  })
  const report = await applyPatches(aiBase, [
    fakePatch(9011, { file: ['escalation'], markers: ['[dsh-purge] e'], replacements: [{ pattern: 'const a = 1;', replace: 'const a = 1; // [dsh-purge] e' }] }),
  ])
  assert.equal(report[0].applied, 1)
  assert.equal(report[0].drifted, 1)
  assert.equal(report[0].status, 'drifted')
})

test('applyPatches：YAML 文件在写盘时顺带净化折叠块', async () => {
  const aiBase = makeTree('ap-yaml', {
    [join('dsh-web-app', 'cordis.patch.yml')]: `personaPrefix: >\n  ${ALLOW_HEAD}\n\n  keep\nname: x\n`,
  })
  assert.ok(targetFiles(aiBase)['web-app'], 'web-app 键必须先能被 targetFiles 解析出来')
  const report = await applyPatches(aiBase, [
    fakePatch(9012, { file: ['web-app'], markers: ['[dsh-purge] y'], replacements: [{ pattern: 'name: x', replace: 'name: x # [dsh-purge] y' }] }),
  ])
  assert.equal(report[0].status, 'applied')
  assert.equal(
    readFileSync(join(aiBase, 'dsh-web-app', 'cordis.patch.yml'), 'utf8'),
    'personaPrefix: |-\n  keep\nname: x # [dsh-purge] y\n',
  )
})

test('applyPatches：replace 是 no-op 时，光靠 YAML 净化也算写入', async () => {
  const aiBase = makeTree('ap-yaml-noop', {
    [join('dsh-web-app', 'cordis.patch.yml')]: `personaPrefix: >\n  ${ALLOW_HEAD}\n\n  keep\nname: y\n`,
  })
  const report = await applyPatches(aiBase, [
    fakePatch(9013, { file: ['web-app'], markers: ['[dsh-purge] y2'], replacements: [{ pattern: 'name: y', replace: 'name: y' }] }),
  ])
  assert.equal(report[0].status, 'applied')
  assert.equal(report[0].applied, 1)
  assert.equal(readFileSync(join(aiBase, 'dsh-web-app', 'cordis.patch.yml'), 'utf8'), 'personaPrefix: |-\n  keep\nname: y\n')
})

test('applyPatches：preserveClientBundles 只统计不写盘（client.js 上的补丁）', async () => {
  const rel = join('dsh-client-ui-conversation', 'lib', 'client.js')
  const aiBase = makeTree('ap-preserve', { [rel]: 'const a = 1;\n' })
  const patch = {
    id: 9014,
    name: 'CLIENT',
    file: ['conversation-client'],
    markers: ['[dsh-purge] client'],
    replacements: [{ pattern: 'const a = 1;', replace: 'const a = 1; // [dsh-purge] client' }],
    optional: true,
  }
  assert.ok(targetFiles(aiBase)['conversation-client'], 'conversation-client 键必须先能解析出来')
  const kept = await applyPatches(aiBase, [patch], { preserveClientBundles: true })
  assert.equal(kept[0].already, 0)
  assert.equal(readFileSync(join(aiBase, rel), 'utf8'), 'const a = 1;\n', 'preserve 时不得写盘')
  // 明确关闭 preserve 才真的写（与 lib/core.js 里显式 apply 的 patchOpts 一致）。
  const wrote = await applyPatches(aiBase, [patch], { preserveClientBundles: false })
  assert.equal(wrote[0].status, 'applied')
  assert.equal(readFileSync(join(aiBase, rel), 'utf8'), 'const a = 1; // [dsh-purge] client\n')
})

test('patchStatus：四态各归各位（drifted / skipped / na / pending）', async () => {
  const aiBase = makeTree('st-four', { [AI_REL]: 'const a = 2;\n' })
  const status = await patchStatus(aiBase, [
    fakePatch(9101),
    fakePatch(9102, { optional: true, file: ['no-such-key'] }),
    fakePatch(9103, { softFiles: ['agent-instructions'] }),
    fakePatch(9104, { surfaces: ['desktop'] }),
    fakePatch(9105, { file: ['no-such-key'] }),
  ])
  // 原文被官方改过、文件在、没有本插件痕迹 → 漂移。
  assert.equal(status[9101], 'drifted')
  // 可选补丁 + 这一版根本没这个文件 → na（不是 skipped：skipped 留给「文件在、原文不在」）。
  assert.equal(status[9102], 'na')
  // softFiles 里的键漂移，是包拆分不是官方改文案 → skipped，不刷状态页。
  assert.equal(status[9103], 'skipped')
  // surfaces 不含当前面 → na，且根本不进文件循环。
  assert.equal(status[9104], 'na')
  // 非可选 + 文件键落空 → missing_file（硬失败）。
  assert.equal(status[9105], 'missing_file')
})

test('patchStatus：原文还在时报 pending，不是 applied', async () => {
  const aiBase = makeTree('st-pending', { [AI_REL]: 'const a = 1;\n' })
  const status = await patchStatus(aiBase, [fakePatch(9201)])
  assert.equal(status[9201], 'pending')
})

test('patchStatus：目标路径不是普通文件时按「文件键落空」处理，不是读失败', async () => {
  // 现状锁定：targetFiles 用 isFile() 过滤候选，路径变成目录后这个键直接落空，
  // 于是走 missing / na，而不是走到 loadText 抛错那条 pending 分支。
  // 真正的读失败（文件在、权限不够、被独占锁）在 CI 上造不出来，
  // 属于 docs/test-map.md 第十节记录的可测性缺口。
  const aiBase = makeTree('st-readfail', { [AI_REL]: 'x' })
  const fp = join(aiBase, AI_REL)
  rmSync(fp)
  mkdirSync(fp, { recursive: true })
  const status = await patchStatus(aiBase, [fakePatch(9301), fakePatch(9302, { optional: true })])
  assert.equal(status[9301], 'missing_file')
  assert.equal(status[9302], 'na')
})

test('patchStatus：多文件键里一个已打上、一个漂移，最后必须是 drifted', async () => {
  // 这条是多文件补丁的真正风险点：如果汇总顺序写成 applied 优先，
  // 「一个文件成功 + 一个文件静默失效」就会显示成绿色。
  // 第一个文件里已有本插件的 marker（= applied），第二个文件原文被官方改过（= drifted）。
  const aiBase = makeTree('st-multi', {
    [join('dsh-sandbox', 'lib', 'index.js')]: 'const a = 1; // [dsh-purge] e\n',
    [join('dsh-sandbox', 'lib', 'types', 'escalation.js')]: 'const b = 2;\n',
  })
  const status = await patchStatus(aiBase, [
    fakePatch(9501, {
      file: ['escalation'],
      markers: ['[dsh-purge] e'],
      replacements: [{ pattern: 'const a = 1;', replace: 'const a = 1; // [dsh-purge] e' }],
    }),
  ])
  assert.equal(status[9501], 'drifted')
})

test('patchStatus：可选补丁在本版本来没这个文件时报 na', async () => {
  const aiBase = makeTree('st-na', { [AI_REL]: 'const a = 1;\n' })
  const status = await patchStatus(aiBase, [
    fakePatch(9401, { file: ['no-such-key'], optional: true }),
    fakePatch(9402, { file: ['no-such-key'], optional: false }),
  ])
  assert.equal(status[9401], 'na')
  assert.equal(status[9402], 'missing_file')
})

test('patchStatus：对真实 86 条补丁跑一遍不会抛（假宿主树 = 全场 missing/na）', async () => {
  const aiBase = makeTree('st-real', { [AI_REL]: 'const a = 1;\n' })
  const status = await patchStatus(aiBase, ALL_PATCHES)
  assert.equal(Object.keys(status).length, ALL_PATCHES.length)
  // 假树里没有官方原文，所以不可能有任何一条是 applied。
  assert.equal(Object.values(status).filter((s) => s === 'applied').length, 0)
})
