/**
 * 在线更新链路的行为守卫（docs/test-map.md 第八节）。
 *
 * 这个文件里最要紧的一件事是：本维护副本把 `ONLINE_UPDATES_ENABLED` 定成 false，
 * 于是「下载 zip 覆盖插件目录」整条路都不通。坏掉的方式都很安静：
 *   - `checkUpdate` 在私有仓库下不抛错、反而回「已是最新」→ 用户以为升级成功，
 *     其实文件一个字节没变（`describeLane` 的 `hasRemote` 就是为此只认远端条目，
 *     不认 `ensureRunningVersion` 插进来的本地行）；
 *   - `switchVersion` 把 pin 落到一个列表里根本不存在的 ref → 下次 checkUpdate
 *     比对提交号永远不等，面板一直提示「有更新」；
 *   - `readChannelState` 读到坏文件回落 stable 却不回写 → 面板每次刷新都显示同一份旧状态。
 *
 * 纯函数（版本比较、通道归一、markCurrent）在 test-self-update.mjs 里已经锁过，
 * 这里只补「读写盘 + 分派 + 错误文案」这一层。
 *
 * 网络与子进程那几段（requestBuffer / remoteHeadSha / overlayFromZip / runReapplyChild）
 * 在本副本里被开关短路或被真实副作用挡住，只能读源码钉形状 —— 见文末「源码形状」一节。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyUpdate,
  autoUpdateIfNeeded,
  channelPublic,
  checkUpdate,
  findPurgeProfiles,
  handleUpdateOp,
  lastUpdateResult,
  localVersion,
  pluginRoot,
  profilePluginDir,
  readChannelState,
  realPath,
  switchChannel,
  switchVersion,
} from '../lib/update.js'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'update.js'), 'utf8')
const UPDATES_DISABLED =
  '本维护仓库为私有，在线更新不可用；请用本地 tgz 更新（见 README 更新策略）'
const DISABLED_HEAD = UPDATES_DISABLED.slice(0, 12)

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpurge-update-'))
test.after(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发 EPERM：临时目录留给系统清理 */
  }
})

let seq = 0

/** 每个用例一套独立 DSH_HOME，避免 A 用例写的 channel.json 影响 B 用例。 */
async function withHome(fn) {
  seq += 1
  const home = path.join(sandbox, `home-${seq}`)
  fs.mkdirSync(home, { recursive: true })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
}

function putJson(fp, value) {
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, `${JSON.stringify(value, null, 2)}\n`)
  return fp
}

function channelFile(home) {
  return path.join(home, 'dsh-purge', 'channel.json')
}

function historyFile(home) {
  return path.join(home, 'dsh-purge', 'version-history.json')
}

function stampFile(home) {
  return path.join(home, 'dsh-purge', 'installed-rev')
}

function putChannel(home, value) {
  return putJson(channelFile(home), value)
}

function putHistory(home, rows) {
  return putJson(historyFile(home), rows)
}

function putProfile(home, name, pkg) {
  const dir = path.join(home, 'profiles', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, ...pkg }, null, 2))
  return dir
}

/**
 * 一条「远端标签」历史记录。
 * `latest: true` 很关键：lane 的版本号取自列表里 `latest` 的那一行，
 * 不给的话 `ensureRunningVersion` 会把本地版本标成 latest，lane 就变成「本地版本」。
 */
function tagRow(overrides = {}) {
  return {
    id: 'v1.2.3',
    ref: 'v1.2.3',
    sha: 'abcdef1234567890abcdef1234567890abcdef12',
    version: '1.2.3',
    channel: 'stable',
    label: '1.2.3（正式）',
    kind: 'tag',
    latest: true,
    ...overrides,
  }
}

/** 源码里含某个片段的那一行；断言时只比片段，不写带转义的正则。 */
function lineContaining(needle) {
  const line = SRC.split(/\r?\n/).find((item) => item.includes(needle))
  assert.ok(line !== undefined, `lib/update.js 里找不到含「${needle}」的行`)
  return line
}

/** 取某个函数体（从签名行到下一个顶层 `}` 之后），用于「这段里不许出现 X」的断言。 */
function bodyOf(signature, nextSignature) {
  const from = SRC.indexOf(signature)
  assert.ok(from >= 0, `找不到函数签名：${signature}`)
  let to = nextSignature ? SRC.indexOf(nextSignature, from) : SRC.length
  assert.ok(to > from, `找不到下一个函数签名：${nextSignature}`)
  // 下一个签名的前面可能还有修饰词（`export ` / `async `），按 indexOf 切会把它们
  // 尾巴留在上一段的末尾。退到行首再切，函数体才不会被这些词污染。
  if (to < SRC.length) to = SRC.lastIndexOf('\n', to) + 1
  return SRC.slice(from, to)
}

/* ------------------------------------------------------------------ *
 * 一、路径与落盘位置
 * ------------------------------------------------------------------ */

test('pluginRoot / localVersion / realPath 指向本仓库，坏路径回落 resolve', () => {
  assert.equal(pluginRoot(), ROOT)
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(localVersion(), manifest.version)
  // realPath 对存在的目录返回真实路径，对不存在的路径回落到 resolve（不抛）
  assert.equal(realPath(ROOT), fs.realpathSync(ROOT))
  const ghost = path.join(ROOT, 'no-such-dir-for-realpath')
  assert.equal(realPath(ghost), path.resolve(ghost))
})

test('readChannelState：没有任何文件时回 stable 且不写盘', async () => {
  await withHome(async (home) => {
    assert.deepEqual(readChannelState(), { channel: 'stable', pin: '' })
    // 关键：默认值不落盘，否则每次 status 都在 home 里留一个文件
    assert.equal(fs.existsSync(channelFile(home)), false)
  })
})

test('readChannelState：坏的 pin（beta 名 / beta 分支）会被清掉并回写', async () => {
  await withHome(async (home) => {
    putChannel(home, { channel: 'stable', pin: '1.2.3-beta' })
    assert.deepEqual(readChannelState(), { channel: 'stable', pin: '' })
    assert.equal(
      fs.readFileSync(channelFile(home), 'utf8'),
      '{\n  "channel": "stable",\n  "pin": ""\n}\n',
      '清掉 pin 之后必须回写，否则面板每次刷新都读到同一个坏 pin',
    )
  })
})

test('switchChannel apply:false 只写通道：两空格缩进 + 结尾换行', async () => {
  await withHome(async (home) => {
    await switchChannel('beta', { apply: false })
    const raw = fs.readFileSync(channelFile(home), 'utf8')
    assert.equal(raw, '{\n  "channel": "beta",\n  "pin": ""\n}\n')
    assert.ok(raw.endsWith('\n'))
    assert.deepEqual(readChannelState(), { channel: 'beta', pin: '' })
  })
})

test('channelPublic 默认参数读盘，未知通道回落正式版', async () => {
  await withHome(async (home) => {
    putChannel(home, { channel: 'beta', pin: 'v1.0.0' })
    assert.deepEqual(channelPublic(), { channel: 'beta', channelLabel: '测试版', pin: 'v1.0.0' })
    assert.deepEqual(channelPublic({ channel: 'nope', pin: '' }), {
      channel: 'stable',
      channelLabel: '正式版',
      pin: '',
    })
  })
})

/* ------------------------------------------------------------------ *
 * 二、profile 扫描：谁真的装了本插件
 * ------------------------------------------------------------------ */

test('findPurgeProfiles 只认 dependencies / devDependencies 里的 dsh-purge', async () => {
  await withHome(async (home) => {
    putProfile(home, 'alpha', { dependencies: { 'dsh-purge': 'file:../../a.tgz' } })
    putProfile(home, 'beta', { devDependencies: { 'dsh-purge': '^1.1.94' } })
    putProfile(home, 'gamma', { dependencies: { other: '1.0.0' } })
    putProfile(home, 'delta', { optionalDependencies: { 'dsh-purge': '1.0.0' } })
    const found = findPurgeProfiles()
    assert.deepEqual(
      found.map((item) => item.name).sort(),
      ['alpha', 'beta'],
      'optionalDependencies 与无关依赖都不算',
    )
    const alpha = found.find((item) => item.name === 'alpha')
    assert.equal(alpha.spec, 'file:../../a.tgz', 'spec 保留原始字符串')
    assert.equal(alpha.dir, path.join(home, 'profiles', 'alpha'))
  })
})

test('findPurgeProfiles：没有 profiles 目录、坏 package.json 都安静跳过', async () => {
  await withHome(async (home) => {
    assert.deepEqual(findPurgeProfiles(), [])
    const dir = path.join(home, 'profiles', 'broken')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json')
    assert.deepEqual(findPurgeProfiles(), [])
  })
})

test('profilePluginDir 只认 node_modules/dsh-purge，缺了回空串', async () => {
  await withHome(async (home) => {
    const dir = putProfile(home, 'alpha', { dependencies: { 'dsh-purge': '1.0.0' } })
    assert.equal(profilePluginDir(dir), '')
    const installed = path.join(dir, 'node_modules', 'dsh-purge')
    fs.mkdirSync(installed, { recursive: true })
    assert.equal(profilePluginDir(dir), fs.realpathSync(installed))
  })
})

/* ------------------------------------------------------------------ *
 * 三、checkUpdate：beta 空通道与「有远端」两条主路
 * ------------------------------------------------------------------ */

test('checkUpdate：beta 通道没有远端时明确回「还没有测试版」，不抛错', async () => {
  await withHome(async (home) => {
    putChannel(home, { channel: 'beta', pin: '' })
    const res = await checkUpdate()
    assert.equal(res.ok, true)
    assert.equal(res.hasUpdate, false)
    assert.equal(res.hasBeta, false)
    assert.equal(res.error, '还没有测试版')
    assert.equal(res.channel, 'beta')
    assert.equal(res.channelLabel, '测试版')
    assert.equal(res.updateTarget, 'beta', 'updateTarget 跟通道走，不是跟 ref 写死')
    assert.equal(res.localVersion, localVersion())
    assert.equal(res.remoteVersion, '')
    assert.equal(res.remoteSha, '')
    assert.ok(Array.isArray(res.versions))
    assert.equal(typeof res.via, 'string')
    assert.ok(res.via.length > 0)
  })
})

test('checkUpdate：beta 空通道的结果也会进 lastUpdateResult', async () => {
  await withHome(async (home) => {
    putChannel(home, { channel: 'beta', pin: '' })
    const res = await checkUpdate()
    assert.equal(lastUpdateResult(), res, '返回的就是记下来的那一份')
  })
})

test('checkUpdate：stable 通道没有远端时抛「在线更新不可用」', async () => {
  await withHome(async () => {
    await assert.rejects(() => checkUpdate(), (err) => {
      assert.equal(err.message, UPDATES_DISABLED)
      return true
    })
  })
})

test('checkUpdate：抛错时不覆盖上一次的结果（面板不会显示半成品）', async () => {
  await withHome(async (home) => {
    putChannel(home, { channel: 'beta', pin: '' })
    const beta = await checkUpdate()
    putChannel(home, { channel: 'stable', pin: '' })
    await assert.rejects(() => checkUpdate(), new RegExp(DISABLED_HEAD))
    assert.equal(lastUpdateResult(), beta)
  })
})

test('checkUpdate：stable 有历史标签时给出完整结果，hasUpdate 按版本号判', async () => {
  await withHome(async (home) => {
    putHistory(home, [tagRow()])
    const res = await checkUpdate()
    assert.equal(res.ok, true)
    assert.equal(res.channel, 'stable')
    assert.equal(res.channelLabel, '正式版')
    assert.equal(res.updateTarget, 'main')
    assert.equal(res.pinned, false)
    assert.equal(res.remoteVersion, '1.2.3')
    assert.equal(res.hasUpdate, true, '1.2.3 比本地版本新')
    assert.equal(res.lanes.stable.hasRemote, true)
    assert.equal(res.lanes.beta.hasRemote, false, 'beta 没有远端，不能假装有')
    assert.equal(res.lanes.stable.version, '1.2.3')
    // 现状锁定：lane 的 sha 取自远端分支头（stableSha），而在线更新关闭时它恒为空，
    // 所以这里是 '' 而不是历史记录里的 sha。哪天打开在线更新，这里会变成 7 位短号。
    assert.equal(res.lanes.stable.sha, '')
    assert.equal(res.lanes.stable.ref, 'main')
  })
})

test('checkUpdate：本地版本不在远端列表里时补一条 kind:local', async () => {
  await withHome(async (home) => {
    putHistory(home, [tagRow()])
    const res = await checkUpdate()
    const local = res.versions.find((item) => item.kind === 'local')
    assert.ok(local, '必须有一条本地版本，否则用户看不到自己现在装的是什么')
    assert.equal(local.version, localVersion())
    assert.equal(local.channel, 'stable')
    assert.equal(local.ref, 'main', '列表里没有 main 条目时本地行就用 main 当 ref')
    assert.equal(local.latest, false, '已经有一条 latest 的标签，本地行不许抢')
  })
})

test('checkUpdate：远端已有同版本 stable 条目不补 local', async () => {
  await withHome(async (home) => {
    putHistory(home, [tagRow({ id: 'main', ref: 'main', version: localVersion() })])
    const res = await checkUpdate()
    assert.equal(res.versions.some((item) => item.kind === 'local'), false)
  })
})

test('checkUpdate：同 sha + 同 ref 的历史记录只留一条', async () => {
  await withHome(async (home) => {
    putHistory(home, [tagRow(), tagRow({ label: '1.2.3（正式）· 重复' })])
    const res = await checkUpdate()
    const rows = res.versions.filter((item) => item.ref === 'v1.2.3')
    assert.equal(rows.length, 1, 'rememberVersion 按 sha|ref 去重')
  })
})

test('checkUpdate：pin 住某个 ref 时只比提交号，不比版本号', async () => {
  await withHome(async (home) => {
    putHistory(home, [tagRow()])
    putChannel(home, { channel: 'stable', pin: 'v1.2.3' })
    const res = await checkUpdate()
    assert.equal(res.pinned, true)
    // stableSha 恒为空（在线更新关闭），所以 pin 分支下 hasUpdate 一定是 false：
    // 这正好说明「pin 之后不会因为版本号更大就无限提示更新」
    assert.equal(res.lanes.stable.hasUpdate, false)
    assert.equal(res.versions.find((item) => item.ref === 'v1.2.3').current, true)
  })
})

test('checkUpdate：localSha 要么为空、要么 7 位短号（不吐 40 位）', async () => {
  await withHome(async (home) => {
    putHistory(home, [tagRow()])
    const res = await checkUpdate()
    assert.equal(typeof res.localSha, 'string')
    assert.ok(
      res.localSha.length === 0 || res.localSha.length === 7,
      `localSha 应是空或 7 位，实际 ${res.localSha}`,
    )
  })
})

test('checkUpdate：installed-rev 里的 stamp 会被当成本地提交号', async () => {
  await withHome(async (home) => {
    putHistory(home, [tagRow()])
    fs.mkdirSync(path.dirname(stampFile(home)), { recursive: true })
    fs.writeFileSync(stampFile(home), 'abcdef1234567890abcdef1234567890abcdef12\n')
    const res = await checkUpdate()
    // 有 .git 时 gitHead 优先，没有时才会用到 stamp；两种都必须是 7 位短号
    assert.equal(res.localSha.length, 7)
  })
})

/* ------------------------------------------------------------------ *
 * 四、switchChannel / switchVersion / handleUpdateOp 的分派与错误文案
 * ------------------------------------------------------------------ */

test('switchChannel 默认会真的去 apply，于是在线更新关闭时抛错且不改通道', async () => {
  await withHome(async (home) => {
    putChannel(home, { channel: 'stable', pin: '' })
    await assert.rejects(() => switchChannel('beta'), new RegExp(DISABLED_HEAD))
    assert.equal(readChannelState().channel, 'stable', 'apply 抛错前不许把通道写歪')
  })
})

test('switchVersion：已下线版本、空 ref、非法 ref、未知 ref 四种回绝', async () => {
  await withHome(async (home) => {
    putHistory(home, [tagRow()])
    const cases = [
      ['1.1.11-beta', '该版本已下线'],
      ['', '请选择要回退的版本'],
      ['   ', '请选择要回退的版本'],
      ['../evil', '请选择要回退的版本'],
      ['v9.9.9', '未知版本'],
    ]
    for (const [ref, message] of cases) {
      await assert.rejects(() => switchVersion(ref), (err) => {
        assert.equal(err.message, message, `ref=${JSON.stringify(ref)}`)
        return true
      })
    }
  })
})

test('switchVersion：列表里有的 ref 会走到 apply，于是在线更新关闭时抛错', async () => {
  await withHome(async (home) => {
    putHistory(home, [tagRow()])
    await assert.rejects(() => switchVersion('v1.2.3'), new RegExp(DISABLED_HEAD))
  })
})

test('switchVersion：按 id 或按 sha 前缀也能认出来（不止认 ref）', async () => {
  await withHome(async (home) => {
    // 历史上真出现过 id 与 ref 不同的条目：id 是内部标识（如裸版本号），ref 才是 git 上的名字。
    // 注意 id 本身也要过 safeUpdateRef 的白名单，所以用 '1.2.3' 而不是 'release-1234'。
    putHistory(home, [tagRow({ id: '1.2.3', ref: 'v1.2.3' })])
    await assert.rejects(() => switchVersion('1.2.3'), new RegExp(DISABLED_HEAD), '按 id 要能认出同一行')
    await assert.rejects(() => switchVersion('abcdef1'), new RegExp(DISABLED_HEAD), '按 sha 前 7 位要能认出同一行')
    await assert.rejects(() => switchVersion('1.2.4'), (err) => {
      assert.equal(err.message, '未知版本', '认不出的 id 要回绝，不能顺手当成某个版本')
      return true
    })
  })
})

test('handleUpdateOp：auto 走手动模式，永不自动升级', async () => {
  await withHome(async (home) => {
    const res = await handleUpdateOp({ op: 'auto' })
    assert.equal(res.auto, true)
    assert.equal(res.skipped, 'manual-only')
    assert.equal(res.hasUpdate, false)
    assert.equal(res.error, '')
    assert.equal(res.channel, 'stable')
    assert.equal(fs.existsSync(channelFile(home)), false, 'auto 不该顺手写通道文件')
    assert.equal(lastUpdateResult(), res)
  })
})

test('handleUpdateOp：空 body 默认按 apply 处理，关闭开关时抛错', async () => {
  await withHome(async () => {
    await assert.rejects(() => handleUpdateOp({}), new RegExp(DISABLED_HEAD))
  })
})

test('handleUpdateOp：status / check / versions 三个别名都走 checkUpdate', async () => {
  await withHome(async (home) => {
    putChannel(home, { channel: 'beta', pin: '' })
    for (const op of ['status', 'check', 'versions', 'STATUS']) {
      const res = await handleUpdateOp({ op })
      assert.equal(res.error, '还没有测试版', `${op} 应该走 checkUpdate`)
    }
  })
})

test('handleUpdateOp：channel 带 apply:false 只切通道', async () => {
  await withHome(async (home) => {
    await handleUpdateOp({ op: 'channel', channel: 'beta', apply: false })
    assert.equal(readChannelState().channel, 'beta')
  })
})

test('handleUpdateOp：switch / rollback 走 switchVersion', async () => {
  await withHome(async (home) => {
    putHistory(home, [tagRow()])
    await assert.rejects(() => handleUpdateOp({ op: 'switch', ref: 'v9.9.9' }), /未知版本/)
    await assert.rejects(
      () => handleUpdateOp({ op: 'rollback', version: '1.1.11-beta' }),
      /该版本已下线/,
    )
  })
})

test('handleUpdateOp：ref 是 beta 名但不是 beta 分支时回「该测试标签已不再提供」', async () => {
  await withHome(async () => {
    for (const ref of ['1.2.3-beta', '1.2.3-rc.1', '2.0.0-preview']) {
      await assert.rejects(() => handleUpdateOp({ ref }), /该测试标签已不再提供/, ref)
    }
  })
})

test('handleUpdateOp：非法 ref 回「未知版本」，不去 apply', async () => {
  await withHome(async () => {
    for (const ref of ['../evil', 'not a ref', '-rf']) {
      await assert.rejects(() => handleUpdateOp({ ref }), /未知版本/, ref)
    }
  })
})

test('handleUpdateOp：合法但列表里没有的 ref 也回「未知版本」', async () => {
  await withHome(async (home) => {
    putHistory(home, [tagRow()])
    await assert.rejects(() => handleUpdateOp({ ref: 'v9.9.9' }), /未知版本/)
  })
})

test('handleUpdateOp：列表里有的 ref 走到 apply，关闭开关时抛错', async () => {
  await withHome(async (home) => {
    putHistory(home, [tagRow()])
    await assert.rejects(() => handleUpdateOp({ ref: 'v1.2.3' }), new RegExp(DISABLED_HEAD))
  })
})

/* ------------------------------------------------------------------ *
 * 五、applyUpdate 的闸门
 * ------------------------------------------------------------------ */

test('applyUpdate：在线更新关闭时第一句就抛，且不改任何状态文件', async () => {
  await withHome(async (home) => {
    putChannel(home, { channel: 'stable', pin: 'v1.0.0' })
    await assert.rejects(() => applyUpdate([]), new RegExp(DISABLED_HEAD))
    assert.deepEqual(readChannelState(), { channel: 'stable', pin: 'v1.0.0' })
    assert.equal(fs.existsSync(historyFile(home)), false)
  })
})

test('applyUpdate：无参调用也会先算 planUpdates，但同样被闸门挡下', async () => {
  await withHome(async () => {
    await assert.rejects(() => applyUpdate(), new RegExp(DISABLED_HEAD))
  })
})

test('autoUpdateIfNeeded 恒回 manual-only，且写进 lastUpdateResult', async () => {
  await withHome(async () => {
    const res = await autoUpdateIfNeeded()
    assert.equal(res.auto, true)
    assert.equal(res.skipped, 'manual-only')
    assert.equal(res.hasUpdate, false)
    assert.equal(res.channel, 'stable')
    assert.equal(lastUpdateResult(), res)
  })
})

/* ------------------------------------------------------------------ *
 * 六、源码形状：外部行为测不到的几处必须靠读源码钉住
 *
 * 这几段要么被 `ONLINE_UPDATES_ENABLED = false` 短路（下载、远端查询），
 * 要么一跑就改本机安装（git reset、覆盖插件目录、起子进程）。断言只比
 * 「源码里确实存在这个片段」，不写带反斜杠的正则，免得被转义层数坑到。
 * ------------------------------------------------------------------ */

test('源码形状：在线更新开关、闸门位置、不联网的短路', () => {
  assert.ok(SRC.includes('const ONLINE_UPDATES_ENABLED = false;'))
  // 闸门必须是 _applyUpdateImpl 的第一句：挪到后面就会出现「文件已经覆盖一半才抛」
  const impl = bodyOf('async function _applyUpdateImpl(', 'export async function switchChannel(')
  const head = impl.split(/\r?\n/).slice(1, 3).join('\n')
  assert.ok(
    head.includes('if (!ONLINE_UPDATES_ENABLED) throw new Error(UPDATES_DISABLED_MESSAGE);'),
    '闸门必须在函数体第一句',
  )
  // listRemoteVersions 关闭时不联网，直接给空值（原路径要等四个端点超时，实测 14502ms）
  const listed = bodyOf('async function listRemoteVersions(', 'function describeLane(')
  assert.ok(listed.includes('ONLINE_UPDATES_ENABLED'))
  assert.ok(listed.includes('["", "", []]'), '关掉时必须给空值，否则面板要等超时')
  assert.ok(listed.includes('14502ms'), '注释要留下「为什么关掉」的实测数字')
})

test('源码形状：archiveZipUrl / archiveTarballUrl 三种 ref 形态', () => {
  const zip = bodyOf('function archiveZipUrl(', 'function archiveTarballUrl(')
  assert.ok(zip.includes('/^[0-9a-f]{40}$/i.test(value)'), '40 位 sha 要走 /zip/<sha>')
  assert.ok(zip.includes('/zip/refs/tags/'), '标签走 refs/tags')
  assert.ok(zip.includes('/zip/refs/heads/'), '分支走 refs/heads')
  assert.ok(zip.includes('encodeURIComponent(value)'), 'ref 必须编码')
  const tar = bodyOf('function archiveTarballUrl(', 'function readStamp(')
  assert.ok(tar.includes('/tar.gz/refs/tags/'))
  assert.ok(tar.includes('/tar.gz/refs/heads/'))
  assert.ok(tar.includes('tar.gz/${value}'))
})

test('源码形状：rewriteDownloadUrl 只把 github.com/archive 改写到 codeload', () => {
  const body = bodyOf('function rewriteDownloadUrl(', 'function requestBuffer(')
  // 源码里 github.com 是写在正则里的（`https:\\/\\/github\\.com`），所以比转义后的字面量
  assert.ok(body.includes('github\\.com'), '只认 github.com 的 archive 地址')
  assert.ok(body.includes('https://codeload.github.com/'), '改写到 codeload')
  assert.ok(body.includes('archive'), '匹配的是 /archive/ 段')
  assert.ok(body.includes('refs'), '要覆盖 refs/tags 与 refs/heads')
  assert.ok(body.includes('{7,40}'), '裸 sha 也要覆盖（7–40 位）')
  assert.ok(body.includes('decodeURIComponent'), 'ref 取出来要解码')
  assert.ok(body.trimEnd().endsWith('}'), '函数体要完整')
})

test('源码形状：下载只走 https，跳转有白名单与跳数上限', () => {
  assert.ok(lineContaining('update: unsupported protocol').includes('parsed.protocol'))
  assert.ok(SRC.includes('redirectsLeft <= 0'))
  assert.ok(SRC.includes('http redirect loop'))
  assert.ok(SRC.includes('update: redirect rejected (non-https: '))
  assert.ok(SRC.includes('update: redirect rejected (host not allowed: '))
  assert.ok(SRC.includes('const UPDATE_REDIRECT_ALLOWED_HOSTS = new Set(['))
  assert.ok(SRC.includes('update: response exceeds '))
  assert.ok(SRC.includes('GitHub 超时'))
  // 白名单里必须有 codeload 与 jsdelivr：少了它们，正常下载会被自己挡住
  const allow = bodyOf('const UPDATE_REDIRECT_ALLOWED_HOSTS = new Set([', 'const MAX_UPDATE_BYTES')
  for (const host of ['github.com', 'codeload.github.com', 'raw.githubusercontent.com', 'cdn.jsdelivr.net']) {
    assert.ok(allow.includes(`"${host}"`), `白名单缺 ${host}`)
  }
})

test('源码形状：pinInstalledSpec 只改三个依赖段，绝不碰 pnpm-lock.yaml', () => {
  const body = bodyOf('function pinInstalledSpec(', 'function planUpdates(')
  assert.ok(body.includes('["dependencies", "devDependencies", "optionalDependencies"]'))
  assert.ok(body.includes('archiveTarballUrl(ref)'), '要落到 codeload 的 tar.gz')
  assert.ok(body.includes('JSON.stringify(pkg, null, 2)'), '写回必须两空格缩进')
  assert.ok(body.includes('曾经用正则把 pnpm-lock.yaml'), '注释要留下为什么不动 lockfile')
  assert.ok(body.includes('Broken lockfile'), '注释要留下当年踩到的具体报错')
  assert.equal(body.includes('pnpm-lock.yaml"'), false, '代码里不许出现对 lockfile 的写操作')
})

test('源码形状：overlayFromZip 先解到临时目录，再按 COPY_NAMES 逐项覆盖', () => {
  const body = bodyOf('async function overlayFromZip(', 'function parseReapplyOutput(')
  assert.ok(body.includes('new Set(dests.filter(Boolean).map((d) => realPath(d)))'), '去重按真实路径')
  assert.ok(body.includes('fsp.mkdtemp(path.join(os.tmpdir(), "dsh-purge-upd-"))'))
  assert.ok(body.includes('"zip 里没有 package.json"'))
  assert.ok(body.includes('fsp.cp(from, to, { recursive: true, force: true })'))
  assert.ok(body.includes('fsp.rm(tmp, { recursive: true, force: true })'), 'finally 里必须清临时目录')
  assert.ok(body.includes('可能被进程占用'), '删不掉目录时要说清原因，别写半套文件')
  assert.ok(body.includes('COPY_NAMES'))
})

test('源码形状：runReapplyChild 用 Electron 当 node 跑，且不许带重启标记', () => {
  const body = bodyOf('function runReapplyChild(', 'let applyUpdateInflight')
  assert.ok(body.includes('ELECTRON_RUN_AS_NODE: "1"'))
  assert.ok(body.includes('delete env.DSH_PURGE_RESTART'), '子进程里不能再触发重启链')
  assert.ok(body.includes('"--expose-internals"'))
  assert.ok(body.includes('timeout: 180000'))
  assert.ok(body.includes('8 * 1024 * 1024'), 'maxBuffer 要够大，否则长日志被截断')
  assert.ok(body.includes('缺少重新应用脚本'))
})

test('源码形状：parseReapplyOutput 只认最后一条 JSON 行', () => {
  const body = bodyOf('function parseReapplyOutput(', 'function runReapplyChild(')
  assert.ok(body.includes('.split(/\\r?\\n/)'), '按行切（CRLF 也要能切）')
  assert.ok(body.includes('startsWith("{")'))
  assert.ok(body.includes('.pop()'), '取最后一条，前面可能有噪声日志')
  assert.ok(body.includes('JSON.parse(line)'))
})

test('源码形状：只有重新应用成功才写 guard / stamp / history', () => {
  const body = bodyOf('async function _applyUpdateImpl(', 'export async function switchChannel(')
  assert.ok(body.includes('const reapplied = runReapplyChild();'))
  const at = body.indexOf('if (reapplied.ok === true) {')
  assert.ok(at > 0, '必须用 === true 判断，undefined 不算成功')
  const tail = body.slice(at, at + 900)
  assert.ok(tail.includes('markAutoUpdateGuard(ref, sha)'))
  assert.ok(tail.includes('writeStamp(sha)'))
  assert.ok(tail.includes('pushHistory('))
})

test('源码形状：gitTrackedDirty 出错时按「有改动」处理（宁可不动）', () => {
  const body = bodyOf('function gitTrackedDirty(', 'let lastUpdate')
  assert.ok(body.includes('--untracked-files=no'), '只看已跟踪文件，未跟踪的不算脏')
  assert.ok(body.includes('...COPY_NAMES'), '只看插件自己的文件')
  assert.ok(/\}\s*catch\s*\{\s*return true;/.test(body), 'catch 必须 return true')
})

test('源码形状：pushHistory 只留 20 条且同 ref 去重', () => {
  const body = bodyOf('function pushHistory(', 'function archiveZipUrl(')
  assert.ok(body.includes('readHistory().filter((item) => item && item.ref !== entry.ref)'))
  assert.ok(body.includes('.slice(0, 20)'))
  assert.ok(body.includes('JSON.stringify(next, null, 2)'))
})

test('源码形状：markAutoUpdateGuard 落三个键，writeStamp 空值不写', () => {
  const guard = bodyOf('function markAutoUpdateGuard(', 'export function normalizeChannel(')
  assert.ok(guard.includes('ref: String(ref || "")'))
  assert.ok(guard.includes('sha: String(sha || "")'))
  assert.ok(guard.includes('at: new Date().toISOString()'))
  const stamp = bodyOf('function writeStamp(', 'function sameRev(')
  assert.ok(stamp.includes('if (!value) return;'), '空提交号不许写盘，否则下次会被当成本地版本')
})

test('源码形状：isAbortError 认三个名字，versionFromPackageText 只取 version', () => {
  const abort = bodyOf('function isAbortError(', 'function rewriteDownloadUrl(')
  assert.ok(abort.includes('"AbortError"'))
  assert.ok(abort.includes('"TimeoutError"'))
  assert.ok(abort.includes('aborted|abort'))
  const ver = bodyOf('function versionFromPackageText(', 'const _remotePkgVerCache')
  assert.ok(ver.includes('pkg && pkg.version ? String(pkg.version) : ""'))
})

test('源码形状：applyUpdate 同时只跑一次，第二次共享同一个 Promise', () => {
  const body = bodyOf('export async function applyUpdate(', 'async function _applyUpdateImpl(')
  assert.ok(SRC.includes('let applyUpdateInflight = null;'))
  assert.ok(body.includes('if (applyUpdateInflight) return applyUpdateInflight;'))
  assert.ok(body.includes('applyUpdateInflight = null;'), 'finally 里必须复位，否则一次失败就永远卡住')
})

test('源码形状：channels 与 copy 清单是这份维护副本的取值', () => {
  assert.ok(SRC.includes('const REPO = "xiuchuan666/dsh-purge-maintained";'))
  assert.ok(SRC.includes('const STABLE_REF = "main";'))
  assert.ok(SRC.includes('const BETA_REF = "beta";'))
  assert.ok(SRC.includes('stable: { id: "stable", ref: STABLE_REF, label: "正式版" }'))
  assert.ok(SRC.includes('beta: { id: "beta", ref: BETA_REF, label: "测试版" }'))
  const copy = bodyOf('const COPY_NAMES = [', 'const HIDDEN')
  assert.ok(copy.includes('"README.md"'))
  assert.equal(copy.includes('README.zh-CN.md'), false, '上游的中文 README 不在清单里')
  assert.ok(copy.includes('"cordis.patch.yml"'), '补丁清单必须一起拷，否则新版插件不生效')
})
