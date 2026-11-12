/**
 * lib/reapply.js —— `reapplyInstalled` 与那几处「吞掉异常」的兜底分支。
 *
 * 为什么不在本进程直接测：`lib/reapply.js` 只 import 了 `./core.js`，而 `reapplyInstalled`
 * 一路会调到 `patchAllShims` / `silenceCmdFlash`，跑一次就把本机 npm 全局的 shim 改掉。
 * 这里用的是「临时副本 + 桩 core」：把 `lib/reapply.js` **逐字节**复制到
 * `<sandbox>/pkg-N/lib/reapply.js`，旁边放一份桩 `core.js`，于是全部宿主副作用都被接住，
 * 而被测代码是原文（不是改写版）。真实文件一改，这里立刻跟着测新的。
 *
 * 坏法（都安静）：
 *   1. `clean` 判定少了 `allPatchHostsWritten` → 补丁没写全也算成功，面板显示「已应用」，
 *      重启后宿主直接起不来。
 *   2. 只有 `reapplied.ok` 才写戳这条被挪走 → 下次启动以为已对齐，永久停在半成品。
 *   3. `restoreSealedExtract` 那条早退被删 → 解开的新包是坏的也照样换上去。
 *   4. 各处 `catch { }` 被删 → 非桌面面（纯 CLI / 无 aiBase）直接抛，整个启动链断掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const REAL = path.join(ROOT, 'lib', 'reapply.js')
const SOURCE = fs.readFileSync(REAL, 'utf8')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpurge-reapplyflow-'))
test.after(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* Windows 偶发 EPERM */
  }
})

let seq = 0

const STUB_CORE = `
export const ALL_PATCHES = [{ id: 1 }];
export function applyRuntimeEnv() { globalThis.__rc('applyRuntimeEnv'); }
export async function gatherState() { return globalThis.__rc('gatherState'); }
export function sealedAsarHandoff() { return globalThis.__rc('sealedAsarHandoff'); }
export async function openSealedDesktopHost(arg) { return globalThis.__rc('openSealedDesktopHost', arg); }
export function rememberUnpackedArchive() { globalThis.__rc('rememberUnpackedArchive'); }
export function missingAiBaseMessage() { return '找不到宿主插件根'; }
export function refreshStaleBaksForUpgrade(aiBase) { return globalThis.__rc('refreshStaleBaksForUpgrade', aiBase); }
export async function revertAll(aiBase, opts) { return globalThis.__rc('revertAll', { aiBase, opts }); }
export async function revertAllShims() { return globalThis.__rc('revertAllShims'); }
export async function applyPatchesAllHosts(patches, opts) { return globalThis.__rc('applyPatchesAllHosts', { patches, opts }); }
export async function patchAllShims() { globalThis.__rc('patchAllShims'); }
export function silenceCmdFlash(aiBase) { return globalThis.__rc('silenceCmdFlash', aiBase); }
export function summarizeApplyReport(report) { return globalThis.__rc('summarizeApplyReport', report); }
export function allPatchHostsWritten(hosts) { return globalThis.__rc('allPatchHostsWritten', hosts); }
export function hostCleanMarkersPresent(aiBase) { return globalThis.__rc('hostCleanMarkersPresent', aiBase); }
export function restoreSealedExtract(appDir, prev) { return globalThis.__rc('restoreSealedExtract', { appDir, prev }); }
export function writeUnpackedAsarStamp(archive) { globalThis.__rc('writeUnpackedAsarStamp', archive); }
export function seedPromptInjectAtBoot(home) { return globalThis.__rc('seedPromptInjectAtBoot', home); }
export function scheduleSealedDesktopRestart(handoff) { return globalThis.__rc('scheduleSealedDesktopRestart', handoff); }
export function desktopAsarStillSealed() { return globalThis.__rc('desktopAsarStillSealed'); }
export function findAiBase() { return globalThis.__rc('findAiBase'); }
export async function patchStatus(aiBase) { return globalThis.__rc('patchStatus', aiBase); }
export function findDshHome() { return globalThis.__rc('findDshHome'); }
`

/**
 * 造一份「原文 + 桩 core」的独立包，返回它的 reapply 模块。
 * `answers` 里每个键对应一个桩函数：返回值、或 `{ throw: '...' }`、或 `{ value }`。
 */
async function loadIsolated(answers = {}, version = '1.1.94') {
  seq += 1
  const pkg = path.join(sandbox, `pkg-${seq}`)
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'lib', 'reapply.js'), SOURCE, 'utf8')
  fs.writeFileSync(path.join(pkg, 'lib', 'core.js'), STUB_CORE, 'utf8')
  if (version === null) {
    // 不写 package.json，测 pluginVersion() 的 catch
  } else {
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'stub', version }), 'utf8')
  }
  const home = path.join(pkg, 'home')
  fs.mkdirSync(home, { recursive: true })

  const calls = []
  globalThis.__stubCalls = calls
  globalThis.__rc = (name, arg) => {
    calls.push({ name, arg })
    const a = answers[name]
    if (a && typeof a === 'object' && 'throw' in a) throw new Error(a.throw)
    if (name === 'findDshHome') return home
    if (name === 'missingAiBaseMessage') return '找不到宿主插件根'
    if (a === undefined) return undefined
    if (a && typeof a === 'object' && 'value' in a) return a.value
    return a
  }
  const mod = await import(pathToFileURL(path.join(pkg, 'lib', 'reapply.js')).href + `?v=${seq}`)
  return { mod, calls, pkg, home }
}

const namesOf = (calls) => calls.map((c) => c.name)
const countOf = (calls, name) => calls.filter((c) => c.name === name).length
const argOf = (calls, name) => calls.find((c) => c.name === name)?.arg

/** 一套「干净成功」的默认应答。 */
function happy(over = {}) {
  return {
    gatherState: { value: { ai_base: '/ai/base' } },
    sealedAsarHandoff: { value: null },
    refreshStaleBaksForUpgrade: { value: [] },
    revertAll: { value: { reverted: ['a', 'b'] } },
    applyPatchesAllHosts: { value: { hosts: [{ aiBase: '/ai/base' }], report: { applied: 86, failed: [] } } },
    silenceCmdFlash: { value: { ok: true } },
    summarizeApplyReport: { value: { applied: 86, failed: [] } },
    allPatchHostsWritten: { value: true },
    hostCleanMarkersPresent: { value: true },
    desktopAsarStillSealed: { value: false },
    findAiBase: { value: '/ai/base' },
    patchStatus: { value: {} },
    seedPromptInjectAtBoot: { value: { action: 'ok' } },
    ...over,
  }
}

/* ------------------------------------------------------------------ *
 * 一、成功路径的完整调用链
 * ------------------------------------------------------------------ */

test('reapplyInstalled：干净成功时按固定顺序走完，返回 ok 与计数', async () => {
  const { mod, calls, home } = await loadIsolated(happy())
  const out = await mod.reapplyInstalled()
  assert.equal(out.ok, true)
  assert.equal(out.error, '')
  assert.equal(out.version, '1.1.94')
  assert.equal(out.reverted, 2, 'reverted 取 revertAll 返回数组的长度')
  assert.equal(out.applied, 86)
  assert.equal(out.failed, 0)
  assert.equal(out.renamed, false)
  assert.equal(out.needsFullQuit, false)
  assert.equal(out.cmdFlashOk, true)

  const order = namesOf(calls).filter((n) => n !== 'findDshHome')
  assert.deepEqual(order.slice(0, 6), [
    'applyRuntimeEnv',
    'gatherState',
    'sealedAsarHandoff',
    'rememberUnpackedArchive',
    'refreshStaleBaksForUpgrade',
    'revertAll',
  ])
  assert.ok(order.indexOf('revertAllShims') > order.indexOf('revertAll'), '先还原文件再还原 shim')
  assert.ok(order.indexOf('applyPatchesAllHosts') > order.indexOf('revertAllShims'))
  assert.ok(order.indexOf('patchAllShims') > order.indexOf('applyPatchesAllHosts'))
  assert.ok(order.indexOf('silenceCmdFlash') > order.indexOf('patchAllShims'))
  assert.ok(order.indexOf('seedPromptInjectAtBoot') > order.indexOf('silenceCmdFlash'))

  // clean 时一定打戳：installed-rev 与 applied.json 都落在桩 home 下
  assert.equal(fs.readFileSync(path.join(home, 'dsh-purge', 'installed-rev'), 'utf8').trim(), 'apply:1.1.94')
  const stamp = JSON.parse(fs.readFileSync(path.join(home, 'dsh-purge', 'applied.json'), 'utf8'))
  assert.equal(stamp.version, '1.1.94')
  assert.equal(stamp.sha, 'apply:1.1.94')
})

test('reapplyInstalled：preserveClientBundles 默认 true，显式 false 时如实传下去', async () => {
  const a = await loadIsolated(happy())
  await a.mod.reapplyInstalled()
  assert.equal(argOf(a.calls, 'revertAll').opts.preserveClientBundles, true, '默认保留 client 产物')
  assert.equal(argOf(a.calls, 'applyPatchesAllHosts').opts.preserveClientBundles, true)
  assert.equal(argOf(a.calls, 'applyPatchesAllHosts').opts.forApply, true, 'apply 路径要带 forApply')

  const b = await loadIsolated(happy())
  await b.mod.reapplyInstalled({ preserveClientBundles: false })
  assert.equal(argOf(b.calls, 'revertAll').opts.preserveClientBundles, false)
})

test('reapplyInstalled：ALL_PATCHES 原样交给 applyPatchesAllHosts（不能自己截一段）', async () => {
  const { mod, calls } = await loadIsolated(happy())
  await mod.reapplyInstalled()
  assert.deepEqual(argOf(calls, 'applyPatchesAllHosts').patches, [{ id: 1 }])
})

/* ------------------------------------------------------------------ *
 * 二、三条早退
 * ------------------------------------------------------------------ */

test('reapplyInstalled：gatherState 抛错时原样回传错误，一个副作用都不做', async () => {
  const { mod, calls } = await loadIsolated(happy({ gatherState: { throw: '宿主状态读不到' } }))
  const out = await mod.reapplyInstalled()
  assert.deepEqual(out, { ok: false, error: '宿主状态读不到' })
  assert.deepEqual(namesOf(calls), ['applyRuntimeEnv', 'gatherState'], '抛错后不能再往下走')
})

test('reapplyInstalled：openSealedDesktopHost 抛错时原样回传错误', async () => {
  const { mod, calls } = await loadIsolated(happy({
    gatherState: { value: { ai_base: '' } },
    sealedAsarHandoff: { value: { asar: true } },
    openSealedDesktopHost: { throw: '解包失败' },
  }))
  const out = await mod.reapplyInstalled()
  assert.deepEqual(out, { ok: false, error: '解包失败' })
  assert.equal(countOf(calls, 'revertAll'), 0)
})

test('reapplyInstalled：拿不到 aiBase 时回 missingAiBaseMessage 的正文', async () => {
  const { mod, calls } = await loadIsolated(happy({
    gatherState: { value: { ai_base: '' } },
    sealedAsarHandoff: { value: null },
    openSealedDesktopHost: { value: { aiBase: '' } },
  }))
  const out = await mod.reapplyInstalled()
  assert.deepEqual(out, { ok: false, error: '找不到宿主插件根' })
  assert.equal(countOf(calls, 'applyPatchesAllHosts'), 0)
})

test('reapplyInstalled：aiBase 空但 openSealedDesktopHost 交回了新的，就继续往下做', async () => {
  const { mod, calls } = await loadIsolated(happy({
    gatherState: { value: { ai_base: '' } },
    sealedAsarHandoff: { value: null },
    openSealedDesktopHost: { value: { aiBase: '/ai/opened' } },
  }))
  const out = await mod.reapplyInstalled()
  assert.equal(out.ok, true)
  assert.equal(argOf(calls, 'revertAll').aiBase, '/ai/opened', '后续全部用交回来的新根')
})

/* ------------------------------------------------------------------ *
 * 三、clean 判定与失败回滚
 * ------------------------------------------------------------------ */

test('reapplyInstalled：failed 非空 → 不 clean、不打戳', async () => {
  const { mod, calls, home } = await loadIsolated(happy({
    summarizeApplyReport: { value: { applied: 80, failed: ['#12', '#30'] } },
  }))
  const out = await mod.reapplyInstalled()
  assert.equal(out.ok, false)
  assert.equal(out.error, 'Clean did not complete')
  assert.equal(out.failed, 2)
  assert.equal(fs.existsSync(path.join(home, 'dsh-purge', 'applied.json')), false, '没清干净绝不能打戳')
  assert.equal(countOf(calls, 'seedPromptInjectAtBoot'), 0)
})

test('reapplyInstalled：宿主一个文件都没写进去时也不算 clean（只看 failed 会漏）', async () => {
  const { mod } = await loadIsolated(happy({
    allPatchHostsWritten: { value: false },
    hostCleanMarkersPresent: { value: false },
  }))
  const out = await mod.reapplyInstalled()
  assert.equal(out.ok, false, 'allPatchHostsWritten 与 hostCleanMarkersPresent 都为假时必须失败')
})

test('reapplyInstalled：没写全但清洗标记还在时仍算 clean（标记是兜底口径）', async () => {
  const { mod } = await loadIsolated(happy({
    allPatchHostsWritten: { value: false },
    hostCleanMarkersPresent: { value: true },
  }))
  const out = await mod.reapplyInstalled()
  assert.equal(out.ok, true)
})

test('reapplyInstalled：clean 但 cmd flash 没打上时只 warn，流程继续', async () => {
  const { mod } = await loadIsolated(happy({ silenceCmdFlash: { value: { ok: false } } }))
  const out = await mod.reapplyInstalled()
  assert.equal(out.ok, true, 'flash 失败不该把整次应用判死')
  assert.equal(out.cmdFlashOk, false, '但面板要能看到 false')
})

test('reapplyInstalled：freshExtract 失败时回滚解包目录，并如实报 restored', async () => {
  // 注意 `opened` 既是 handoff 也是 freshExtract（源码 `if (opened.extracted) freshExtract = opened;`），
  // 所以 appDir / prev / archive 都挂在 openSealedDesktopHost 的返回对象顶层。
  const { mod, calls } = await loadIsolated(happy({
    gatherState: { value: { ai_base: '' } },
    sealedAsarHandoff: { value: { asar: true } },
    openSealedDesktopHost: { value: { aiBase: '/ai/new', extracted: true, appDir: '/res/app', prev: '/res/app.prev' } },
    summarizeApplyReport: { value: { applied: 0, failed: ['#1'] } },
    restoreSealedExtract: { value: true },
  }))
  const out = await mod.reapplyInstalled()
  assert.equal(out.ok, false)
  assert.equal(out.restored, true)
  assert.equal(out.reverted, 0, '刚解开的目录没有可还原的补丁')
  assert.match(out.error, /previous unpacked directory was restored/)
  assert.deepEqual(argOf(calls, 'restoreSealedExtract'), { appDir: '/res/app', prev: '/res/app.prev' })
  assert.equal(countOf(calls, 'revertAll'), 0, 'freshExtract 时不做 revertAll')
  assert.equal(countOf(calls, 'revertAllShims'), 0)
  assert.equal(countOf(calls, 'refreshStaleBaksForUpgrade'), 0, '刚解开就是官方原件，不用刷 bak')
})

test('reapplyInstalled：freshExtract 回滚也失败时报短文案，不假装 restored', async () => {
  const { mod } = await loadIsolated(happy({
    gatherState: { value: { ai_base: '' } },
    sealedAsarHandoff: { value: { asar: true } },
    openSealedDesktopHost: { value: { aiBase: '/ai/new', extracted: true, appDir: '/res/app', prev: '/res/app.prev' } },
    summarizeApplyReport: { value: { applied: 0, failed: ['#1'] } },
    restoreSealedExtract: { value: false },
  }))
  const out = await mod.reapplyInstalled()
  assert.equal(out.restored, false)
  assert.equal(out.error, 'Clean did not complete')
})

test('reapplyInstalled：刷旧 bak 抛错只 warn，不影响后面继续打补丁', async () => {
  const { mod, calls } = await loadIsolated(happy({
    refreshStaleBaksForUpgrade: { throw: 'bak 读不到' },
  }))
  const out = await mod.reapplyInstalled()
  assert.equal(out.ok, true)
  assert.equal(countOf(calls, 'applyPatchesAllHosts'), 1, '抛错不能中断主流程')
})

test('reapplyInstalled：seedPromptInjectAtBoot 抛错只 warn；返回 action:error 也只 warn', async () => {
  const a = await loadIsolated(happy({ seedPromptInjectAtBoot: { throw: '种子失败' } }))
  assert.equal((await a.mod.reapplyInstalled()).ok, true)
  const b = await loadIsolated(happy({ seedPromptInjectAtBoot: { value: { action: 'error', reason: 'x' } } }))
  assert.equal((await b.mod.reapplyInstalled()).ok, true)
})

/* ------------------------------------------------------------------ *
 * 四、换包（sealed asar）与重启口径
 * ------------------------------------------------------------------ */

test('reapplyInstalled：换包成功时 renamed=true 并要求退出重启', async () => {
  // `handoff = opened`（不是 opened.swapAsar），所以 asar 标记要在返回对象顶层；
  // swapAsar 只用来判断「这次是换包而不是就地解包」。
  const { mod, calls } = await loadIsolated(happy({
    gatherState: { value: { ai_base: '' } },
    sealedAsarHandoff: { value: { asar: true } },
    openSealedDesktopHost: { value: { aiBase: '/ai/new', asar: true, swapAsar: { asar: true, appDir: '/res/app' } } },
    scheduleSealedDesktopRestart: { value: { renamed: true } },
  }))
  const out = await mod.reapplyInstalled()
  assert.equal(out.ok, true)
  assert.equal(out.renamed, true)
  assert.equal(out.needsFullQuit, true)
  assert.equal(countOf(calls, 'scheduleSealedDesktopRestart'), 1)
})

test('reapplyInstalled：要换包但没挪开时 pending 也算需要重启', async () => {
  const { mod } = await loadIsolated(happy({
    gatherState: { value: { ai_base: '' } },
    sealedAsarHandoff: { value: { asar: true } },
    openSealedDesktopHost: { value: { aiBase: '/ai/new', asar: true, swapAsar: { asar: true } } },
    scheduleSealedDesktopRestart: { value: { renamed: false } },
  }))
  const out = await mod.reapplyInstalled()
  assert.equal(out.renamed, false)
  assert.equal(out.needsFullQuit, true, 'asar 还在原位时用户必须退出重启')
})

test('reapplyInstalled：scheduleSwap:false 时既不排重启也不要求退出', async () => {
  const { mod, calls } = await loadIsolated(happy({
    gatherState: { value: { ai_base: '' } },
    sealedAsarHandoff: { value: { asar: true } },
    openSealedDesktopHost: { value: { aiBase: '/ai/new', asar: true, swapAsar: { asar: true } } },
  }))
  const out = await mod.reapplyInstalled({ scheduleSwap: false })
  assert.equal(countOf(calls, 'scheduleSealedDesktopRestart'), 0)
  assert.equal(out.renamed, false)
  assert.equal(out.needsFullQuit, false)
})

test('reapplyInstalled：没有换包需求时不排重启、也不要求退出', async () => {
  const { mod, calls } = await loadIsolated(happy())
  const out = await mod.reapplyInstalled()
  assert.equal(countOf(calls, 'scheduleSealedDesktopRestart'), 0)
  assert.equal(out.needsFullQuit, false)
})

test('reapplyInstalled：freshExtract 且有 archive 时写解包戳', async () => {
  const { mod, calls } = await loadIsolated(happy({
    gatherState: { value: { ai_base: '' } },
    sealedAsarHandoff: { value: { asar: true } },
    openSealedDesktopHost: { value: { aiBase: '/ai/new', extracted: true, appDir: '/res/app', archive: '/res/app.asar' } },
  }))
  await mod.reapplyInstalled()
  assert.equal(argOf(calls, 'writeUnpackedAsarStamp'), '/res/app.asar')
})

test('reapplyInstalled：没有 freshExtract 时不写解包戳', async () => {
  const { mod, calls } = await loadIsolated(happy())
  await mod.reapplyInstalled()
  assert.equal(countOf(calls, 'writeUnpackedAsarStamp'), 0)
})

test('reapplyInstalled：version 取 package.json；package.json 缺失时回空串', async () => {
  const a = await loadIsolated(happy(), '2.0.0-beta.1')
  assert.equal((await a.mod.reapplyInstalled()).version, '2.0.0-beta.1')
  const b = await loadIsolated(happy(), null)
  const out = await b.mod.reapplyInstalled()
  assert.equal(out.version, '')
})

/* ------------------------------------------------------------------ *
 * 五、那些「吞掉异常」的兜底分支
 * ------------------------------------------------------------------ */

test('hostStillHasAppliedPatches：desktopAsarStillSealed 抛错时当「不是密封」继续判', async () => {
  const { mod } = await loadIsolated(happy({ desktopAsarStillSealed: { throw: '非桌面面' } }))
  assert.equal(mod.hostStillHasAppliedPatches(), true)
})

test('hostStillHasAppliedPatches：findAiBase 抛错时算「还在」（不能因为读不到就判丢）', async () => {
  const { mod } = await loadIsolated(happy({ findAiBase: { throw: '读不到' } }))
  assert.equal(mod.hostStillHasAppliedPatches(), true, '#59：找不到根不等于补丁丢了')
})

test('hostStillHasAppliedPatches：findAiBase 空串时也算「还在」', async () => {
  const { mod } = await loadIsolated(happy({ findAiBase: { value: '' } }))
  assert.equal(mod.hostStillHasAppliedPatches(), true)
})

test('hostStillHasAppliedPatches：有根但清洗标记没了 → false', async () => {
  const { mod } = await loadIsolated(happy({ hostCleanMarkersPresent: { value: false } }))
  assert.equal(mod.hostStillHasAppliedPatches(), false)
})

test('hostPatchesStillPending：patchStatus 抛错时按「没有 pending」处理', async () => {
  const { mod } = await loadIsolated(happy({ patchStatus: { throw: '炸了' } }))
  assert.equal(await mod.hostPatchesStillPending(), false)
})

test('hostPatchesStillPending：findAiBase 抛错时也是 false', async () => {
  const { mod } = await loadIsolated(happy({ findAiBase: { throw: '炸了' } }))
  assert.equal(await mod.hostPatchesStillPending(), false)
})

test('hostPatchesStillPending：有一个 pending 就 true', async () => {
  const { mod } = await loadIsolated(happy({ patchStatus: { value: { 12: 'applied', 30: 'pending' } } }))
  assert.equal(await mod.hostPatchesStillPending(), true)
})

test('hostCleanEnoughToKeep：findAiBase 抛错时 false（不能当成「够干净」）', async () => {
  const { mod } = await loadIsolated(happy({ findAiBase: { throw: '炸了' } }))
  assert.equal(await mod.hostCleanEnoughToKeep(), false)
})

test('hostCleanEnoughToKeep：标记在但还有 pending 时 false', async () => {
  const { mod } = await loadIsolated(happy({ patchStatus: { value: { 30: 'pending' } } }))
  assert.equal(await mod.hostCleanEnoughToKeep(), false)
})

test('hostCleanEnoughToKeep：标记在且无 pending 时 true', async () => {
  const { mod } = await loadIsolated(happy({ patchStatus: { value: { 30: 'applied' } } }))
  assert.equal(await mod.hostCleanEnoughToKeep(), true)
})

test('patchesLostAfterHostReset：desktopAsarStillSealed 抛错时不因此判丢失', async () => {
  const { mod, home } = await loadIsolated(happy({ desktopAsarStillSealed: { throw: '非桌面面' } }))
  fs.mkdirSync(path.join(home, 'dsh-purge'), { recursive: true })
  fs.writeFileSync(path.join(home, 'dsh-purge', 'applied.json'), JSON.stringify({ version: '1.1.94', sha: 'abc1234' }))
  assert.equal(mod.patchesLostAfterHostReset(), false, '标记还在就不算丢失')
})

test('patchesLostAfterHostReset：findAiBase 抛错时也不判丢失', async () => {
  const { mod, home } = await loadIsolated(happy({ findAiBase: { throw: '炸了' } }))
  fs.mkdirSync(path.join(home, 'dsh-purge'), { recursive: true })
  fs.writeFileSync(path.join(home, 'dsh-purge', 'applied.json'), JSON.stringify({ version: '1.1.94', sha: 'abc1234' }))
  assert.equal(mod.patchesLostAfterHostReset(), false)
})

test('healEmptyAppliedStamp：findAiBase 抛错时按「找不到根」处理，允许补戳', async () => {
  const { mod, home } = await loadIsolated(happy({ findAiBase: { throw: '炸了' }, desktopAsarStillSealed: { value: false } }))
  fs.mkdirSync(path.join(home, 'dsh-purge'), { recursive: true })
  fs.writeFileSync(path.join(home, 'dsh-purge', 'applied.json'), JSON.stringify({ version: '1.1.94', sha: '' }))
  assert.equal(mod.healEmptyAppliedStamp(), true, '#59：读不到根时补戳打断自重启')
})

test('healEmptyAppliedStamp：desktopAsarStillSealed 抛错时按「不密封」继续', async () => {
  const { mod, home } = await loadIsolated(happy({
    desktopAsarStillSealed: { throw: '非桌面面' },
    hostCleanMarkersPresent: { value: true },
  }))
  fs.mkdirSync(path.join(home, 'dsh-purge'), { recursive: true })
  fs.writeFileSync(path.join(home, 'dsh-purge', 'applied.json'), JSON.stringify({ version: '1.1.94', sha: '' }))
  assert.equal(mod.healEmptyAppliedStamp(), true)
})

/* ------------------------------------------------------------------ *
 * 六、密封包（asar）为真时的那几条判据
 *
 * 为什么单独一组：桌面端还没换包时 `desktopAsarStillSealed()` 为 true，
 * 此时宿主上的标记即使还在也**不能**当成「补丁还在」—— 补丁全在 asar 里，
 * 一旦判成「还在」，升级后就不再重打，用户看到的是面板说已清洗、实际没生效。
 * 这三条之前一直是 RED 演练里的 GREEN（既有 test-reapply-settle.mjs 只覆盖了
 * 「抛错」与「非密封」两种，没覆盖「密封为真」），补在这里。
 * ------------------------------------------------------------------ */

test('hostStillHasAppliedPatches：密封包未换开时一律算「不在」（不看标记）', async () => {
  const { mod } = await loadIsolated(happy({ desktopAsarStillSealed: { value: true } }))
  assert.equal(mod.hostStillHasAppliedPatches(), false, 'asar 还封着 → 补丁不在宿主文件里')
})

test('patchesMatchInstallStrict：快路径全过但宿主还有 pending 时仍算未对齐', async () => {
  const { mod, home } = await loadIsolated(happy({
    patchStatus: { value: { 30: 'pending' } },
  }))
  fs.mkdirSync(path.join(home, 'dsh-purge'), { recursive: true })
  fs.writeFileSync(path.join(home, 'dsh-purge', 'installed-rev'), 'abc1234\n')
  fs.writeFileSync(
    path.join(home, 'dsh-purge', 'applied.json'),
    JSON.stringify({ version: '1.1.94', sha: 'abc1234' }),
  )
  assert.equal(mod.patchesMatchInstall(), true, '快路径本身是过的')
  assert.equal(await mod.patchesMatchInstallStrict(), false, '但还有 pending → 严格判据必须 false')
})

test('patchesLostAfterHostReset：有戳且密封包还在 → 直接判丢失（不等宿主标记）', async () => {
  const { mod, home } = await loadIsolated(happy({ desktopAsarStillSealed: { value: true } }))
  fs.mkdirSync(path.join(home, 'dsh-purge'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'dsh-purge', 'applied.json'),
    JSON.stringify({ version: '1.1.94', sha: 'abc1234' }),
  )
  assert.equal(mod.patchesLostAfterHostReset(), true, 'asar 封回去等于补丁丢了')
})
