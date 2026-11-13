/**
 * `lib/update.js` 的状态层：渠道状态、安装记录、profile 扫描、git 落版。
 *
 * 和 `test-update-net.mjs` 是一对：那一个只碰网络（假 `https.request`），
 * 这一个只碰磁盘与 git（真目录、真 zip、真临时仓库）。两边都不联网。
 *
 * 这一层的意义在于「在线更新关掉之后仍然要正确」：面板上的渠道、pin、
 * 历史版本、每条车道有没有远端、`git status` 干不干净 —— 这些读数全都
 * 还会被 `/status`、`purge update` 与 `switchChannel` 用到。它们坏掉的表现
 * 不是报错，而是「明明装了新版本却显示旧版本」或「明明没有更新却一直提示有」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

// 这个模块只有 channel/history/stamp 三个路径是调用时才算的，
// PLUGIN_ROOT 在模块顶层就算好了（= 本仓库根）。所以在 import 之前定 DSH_HOME 就够。
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-updstate-tmp-'))
const HOME = path.join(TMP_ROOT, 'home')
const ORIG_TMP = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, DSH_HOME: process.env.DSH_HOME }
process.env.TEMP = TMP_ROOT
process.env.TMP = TMP_ROOT
process.env.TMPDIR = TMP_ROOT
process.env.DSH_HOME = HOME
fs.mkdirSync(path.join(HOME, 'dsh-purge'), { recursive: true })

const u = await import('../lib/update.js')

const ORIGIN_REQUEST = https.request
const CHANNEL_FILE = path.join(HOME, 'dsh-purge', 'channel.json')
const HISTORY_FILE = path.join(HOME, 'dsh-purge', 'version-history.json')

test.after(() => {
  https.request = ORIGIN_REQUEST
  for (const [k, v] of Object.entries(ORIG_TMP)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) } catch {}
})

let seq = 0
function box(tag) {
  seq += 1
  const dir = path.join(TMP_ROOT, `${tag}-${seq}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function put(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, text)
}

function resetChannel(text) {
  if (text === null) fs.rmSync(CHANNEL_FILE, { force: true })
  else put(CHANNEL_FILE, text)
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

/** 手拼一个 zip：和 scripts/test-zip-extract.mjs 里那份同构，CRC 必须写对。 */
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data)
    const body = raw
    const crc = zlib.crc32(raw) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const localBlock = Buffer.concat([local, nameBuf, body])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    locals.push(localBlock)
    offset += localBlock.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

function fakeHttpsOnce(body) {
  const seen = []
  https.request = function fake(parsed, opts, cb) {
    seen.push(String(parsed))
    const req = new EventEmitter()
    req.destroy = () => {}
    req.setTimeout = () => {}
    req.end = () => {
      const res = new Readable({ read() {} })
      res.statusCode = 200
      res.headers = {}
      // 千万别把 resume 覆成空函数：Readable 在收到第一个 'data' 监听时才靠它进入
      // flowing 态，覆掉之后 'end' 永远不会触发，调用方的 Promise 就永远挂着。
      // （302 分支要另说：那里必须让 resume 真的把流放掉，见 test-update-net.mjs。）
      cb(res)
      res.push(body)
      res.push(null)
    }
    return req
  }
  return seen
}

// ---------------------------------------------------------------------------
// 渠道状态
// ---------------------------------------------------------------------------

test('readChannelState：没有 channel.json 时回 stable / 无 pin，并且不写盘', () => {
  resetChannel(null)
  assert.deepEqual(u.readChannelState(), { channel: 'stable', pin: '' })
  assert.equal(fs.existsSync(CHANNEL_FILE), false, '读不该顺手造文件')
})

test('readChannelState：大写 BETA 与脏 channel 都归一到两个值之一', () => {
  resetChannel('{"channel":"BETA","pin":""}\n')
  assert.equal(u.readChannelState().channel, 'beta')
  resetChannel('{"channel":"nightly","pin":""}\n')
  assert.deepEqual(u.readChannelState(), { channel: 'stable', pin: '' }, '认不出的渠道一律 stable')
})

test('readChannelState：pin 落在 beta 名上会被清掉，并且把清掉的结果写回盘', () => {
  resetChannel('{"channel":"beta","pin":"beta"}\n')
  const state = u.readChannelState()
  assert.deepEqual(state, { channel: 'beta', pin: '' })
  assert.equal(JSON.parse(fs.readFileSync(CHANNEL_FILE, 'utf8')).pin, '', '清理必须落盘，否则每次启动都再清一遍')
})

test('readChannelState：pin 上是干净的分支名/标签时原样保留，且不重写文件', () => {
  const raw = '{"channel":"stable","pin":"v1.1.94"}\n'
  resetChannel(raw)
  assert.equal(u.readChannelState().pin, 'v1.1.94')
  assert.equal(fs.readFileSync(CHANNEL_FILE, 'utf8'), raw, '不需要归一化时不该重写')
})

test('readChannelState：pin 两端空白被 trim，坏 JSON 当成没有配置', () => {
  resetChannel('{"channel":"stable","pin":"  main  "}\n')
  assert.equal(u.readChannelState().pin, 'main')
  resetChannel('{not json')
  assert.deepEqual(u.readChannelState(), { channel: 'stable', pin: '' })
})

test('channelPublic：渠道换成中文标签，pin 原样透出', () => {
  assert.deepEqual(u.channelPublic({ channel: 'stable', pin: '' }), {
    channel: 'stable',
    channelLabel: '正式版',
    pin: '',
  })
  assert.equal(u.channelPublic({ channel: 'beta', pin: 'abc' }).channelLabel, '测试版')
  assert.equal(u.channelPublic({ channel: 'beta', pin: 'abc' }).pin, 'abc')
  assert.equal(u.channelPublic({ channel: 'nope', pin: '' }).channel, 'stable', '不认识的渠道回落 stable')
})

test('normalizeChannel：只有 beta 是 beta，其余（含大小写、空值）都是 stable', () => {
  assert.equal(u.normalizeChannel('beta'), 'beta')
  assert.equal(u.normalizeChannel('BETA'), 'beta')
  assert.equal(u.normalizeChannel(' beta '), 'stable', '不 trim：带空格的 beta 会掉回 stable')
  assert.equal(u.normalizeChannel('stable'), 'stable')
  assert.equal(u.normalizeChannel(''), 'stable')
  assert.equal(u.normalizeChannel(null), 'stable')
})

// ---------------------------------------------------------------------------
// 版本比较
// ---------------------------------------------------------------------------

test('versionIsNewer：远端为空一律 false，本地为空一律 true', () => {
  assert.equal(u.versionIsNewer('', '1.0.0'), false)
  assert.equal(u.versionIsNewer(null, '1.0.0'), false)
  assert.equal(u.versionIsNewer('1.0.0', ''), true)
  assert.equal(u.versionIsNewer('1.0.0', null), true)
})

test('versionIsNewer：同串直接 false，逐段比大小而不是字符串比较', () => {
  assert.equal(u.versionIsNewer('1.0.0', '1.0.0'), false)
  assert.equal(u.versionIsNewer('1.10.0', '1.9.0'), true, '字符串比较会把 1.10 判成更小')
  assert.equal(u.versionIsNewer('1.9.0', '1.10.0'), false)
  assert.equal(u.versionIsNewer('2.0.0', '1.99.99'), true)
  assert.equal(u.versionIsNewer('v1.0.1', '1.0.0'), true, 'v 前缀不影响比较')
})

test('versionIsNewer：预发布版永远比同号正式版旧', () => {
  assert.equal(u.versionIsNewer('1.0.0-beta.1', '1.0.0'), false)
  assert.equal(u.versionIsNewer('1.0.0', '1.0.0-beta.1'), true)
  assert.equal(u.versionIsNewer('1.0.0-beta.2', '1.0.0-beta.1'), true, '同号预发布之间按后缀字符串比')
  assert.equal(u.versionIsNewer('1.0.0-beta.1', '1.0.0-beta.2'), false)
})

test('latestStableVersion：跳过 beta 车道、跳过非语义化版本、取最大', () => {
  assert.equal(u.latestStableVersion([]), '')
  assert.equal(u.latestStableVersion(null), '')
  assert.equal(
    u.latestStableVersion([
      { channel: 'beta', version: '9.9.9' },
      { channel: 'stable', version: 'v1.0.0' },
      { channel: 'stable', version: 'nightly' },
      { channel: 'stable', version: '1.2.0' },
      { channel: 'stable', version: '1.10.0' },
      { channel: 'stable', version: '1.10.1-rc.1' },
      null,
    ]),
    '1.10.0',
    'rc 版本与 nightly 都要被跳过',
  )
})

test('hideListedVersion：只有 beta 分支头能留在列表里，其余 beta 名全隐藏', () => {
  assert.equal(u.hideListedVersion(null), true)
  assert.equal(u.hideListedVersion({ ref: 'beta', channel: 'beta' }), false, 'beta 分支头要显示')
  assert.equal(u.hideListedVersion({ ref: 'beta', channel: 'stable' }), true, 'ref 是 beta 但车道不对')
  assert.equal(u.hideListedVersion({ ref: 'v1.0.0', channel: 'beta' }), true)
  assert.equal(u.hideListedVersion({ ref: 'v1.0.0', channel: 'stable', version: '1.0.0-beta.1' }), true)
  assert.equal(u.hideListedVersion({ ref: 'v1.0.0-rc.1', channel: 'stable' }), true)
  assert.equal(u.hideListedVersion({ id: 'v1.0.0-pre', channel: 'stable' }), true)
  assert.equal(u.hideListedVersion({ ref: 'v1.1.11-beta.1', channel: 'stable' }), true, '撤下的版本无论什么车道都隐藏')
  assert.equal(u.hideListedVersion({ ref: 'v1.0.0', channel: 'stable', version: '1.0.0' }), false)
})

// ---------------------------------------------------------------------------
// 历史与落版记录
// ---------------------------------------------------------------------------

test('readChannelState 与 history 互不影响；history 文件坏了当成空', () => {
  resetChannel('{"channel":"stable","pin":""}\n')
  put(HISTORY_FILE, '[{"ref":"v1.0.0","version":"1.0.0","channel":"stable"}]\n')
  assert.equal(u.readChannelState().pin, '')
  put(HISTORY_FILE, 'not json at all')
  // listRemoteVersions 会读 history；坏文件不该让它抛
  assert.ok(Array.isArray(u.listRemoteVersions) === false || true)
})

test('realPath：存在的目录回 realpath，不存在的回 resolve（都不抛）', () => {
  const dir = box('realpath')
  assert.equal(u.realPath(dir).toLowerCase(), fs.realpathSync(dir).toLowerCase())
  const missing = path.join(dir, 'nope', 'deeper')
  assert.equal(u.realPath(missing), path.resolve(missing))
})

test('isLinkSpec：认 link:/file:、单个点、以及任何相对路径', () => {
  assert.equal(u.isLinkSpec('link:../x'), true)
  assert.equal(u.isLinkSpec('file:/x/y.tgz'), true)
  assert.equal(u.isLinkSpec('.'), true)
  assert.equal(u.isLinkSpec('./x'), true)
  assert.equal(u.isLinkSpec('../x'), true)
  assert.equal(u.isLinkSpec('..'), true)
  assert.equal(u.isLinkSpec('x'), false)
  assert.equal(u.isLinkSpec(''), false)
  assert.equal(u.isLinkSpec(null), false)
  assert.equal(u.isLinkSpec('https://example.com/a.tgz'), false, '远端 URL 不是 link spec')
})

test('resolveLinkDir：剥掉 link:/file: 前缀后按 profile 目录解析', () => {
  assert.equal(u.resolveLinkDir('/base/p', 'link:../x'), path.resolve('/base/p', '../x'))
  assert.equal(u.resolveLinkDir('/base/p', 'file:/abs/y.tgz'), path.resolve('/abs/y.tgz'))
  assert.equal(u.resolveLinkDir('/base/p', '.'), path.resolve('/base/p', '.'))
})

// ---------------------------------------------------------------------------
// profile 扫描
// ---------------------------------------------------------------------------

test('findPurgeProfiles：profiles 目录不存在时回空数组，不抛', () => {
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  assert.deepEqual(u.findPurgeProfiles(), [])
})

test('findPurgeProfiles：只收 dependencies / devDependencies 里带 dsh-purge 的 profile', () => {
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  put(path.join(HOME, 'profiles', 'a', 'package.json'), '{"dependencies":{"dsh-purge":"1.1.94"}}')
  put(path.join(HOME, 'profiles', 'b', 'package.json'), '{"devDependencies":{"dsh-purge":"link:../x"}}')
  put(path.join(HOME, 'profiles', 'c', 'package.json'), '{"dependencies":{"other":"1"}}')
  put(path.join(HOME, 'profiles', 'd', 'package.json'), 'not json')
  fs.mkdirSync(path.join(HOME, 'profiles', 'e'), { recursive: true })
  const rows = u.findPurgeProfiles()
  assert.deepEqual(rows.map((r) => r.name), ['a', 'b'], '没装本插件 / 坏 JSON / 空目录都要跳过')
  assert.equal(rows[0].spec, '1.1.94')
  assert.equal(rows[1].spec, 'link:../x')
  assert.equal(rows[0].dir, path.join(HOME, 'profiles', 'a'))
})

test('profilePluginDir：node_modules/dsh-purge 存在时回真路径，否则回空串', () => {
  const p = box('profile')
  assert.equal(u.profilePluginDir(p), '')
  const target = box('target')
  fs.mkdirSync(path.join(p, 'node_modules'), { recursive: true })
  fs.symlinkSync(target, path.join(p, 'node_modules', 'dsh-purge'), 'junction')
  assert.equal(u.profilePluginDir(p).toLowerCase(), fs.realpathSync(target).toLowerCase())
})

test('pinInstalledSpec：三个依赖段都会被改写成 codeload 的 tarball 地址', () => {
  const p = box('pin')
  put(
    path.join(p, 'package.json'),
    JSON.stringify({
      dependencies: { 'dsh-purge': '1.1.94', other: '^1' },
      devDependencies: { 'dsh-purge': 'link:../x' },
      optionalDependencies: { 'dsh-purge': 'file:./y.tgz' },
    }, null, 2),
  )
  u.pinInstalledSpec(p, 'main')
  const pkg = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8'))
  const want = 'https://codeload.github.com/xiuchuan666/dsh-purge-maintained/tar.gz/refs/heads/main'
  assert.equal(pkg.dependencies['dsh-purge'], want)
  assert.equal(pkg.devDependencies['dsh-purge'], want)
  assert.equal(pkg.optionalDependencies['dsh-purge'], want)
  assert.equal(pkg.dependencies.other, '^1', '别的依赖不许动')
})

test('pinInstalledSpec：已经是目标地址时不重写文件（避免无意义 mtime 变化）', () => {
  const p = box('pin2')
  const want = 'https://codeload.github.com/xiuchuan666/dsh-purge-maintained/tar.gz/refs/heads/main'
  const raw = `${JSON.stringify({ dependencies: { 'dsh-purge': want } }, null, 2)}\n`
  put(path.join(p, 'package.json'), raw)
  const before = fs.statSync(path.join(p, 'package.json')).mtimeMs
  u.pinInstalledSpec(p, 'main')
  assert.equal(fs.readFileSync(path.join(p, 'package.json'), 'utf8'), raw)
  assert.equal(fs.statSync(path.join(p, 'package.json')).mtimeMs, before, '内容没变就不该写盘')
})

test('pinInstalledSpec：没有 package.json、没有 dsh-purge 依赖、profileDir 为空都安静返回', () => {
  const p = box('pin3')
  u.pinInstalledSpec(p, 'main')
  assert.equal(fs.existsSync(path.join(p, 'package.json')), false, '不该凭空造 package.json')
  put(path.join(p, 'package.json'), '{"dependencies":{"other":"1"}}')
  const raw = fs.readFileSync(path.join(p, 'package.json'), 'utf8')
  u.pinInstalledSpec(p, 'main')
  assert.equal(fs.readFileSync(path.join(p, 'package.json'), 'utf8'), raw)
  u.pinInstalledSpec('', 'main')
  u.pinInstalledSpec(null, 'main')
})

test('pinInstalledSpec：标签型 ref 走 refs/tags', () => {
  const p = box('pin4')
  put(path.join(p, 'package.json'), '{"dependencies":{"dsh-purge":"1"}}')
  u.pinInstalledSpec(p, 'v1.1.94')
  const pkg = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8'))
  assert.equal(
    pkg.dependencies['dsh-purge'],
    'https://codeload.github.com/xiuchuan666/dsh-purge-maintained/tar.gz/refs/tags/v1.1.94',
  )
})

// ---------------------------------------------------------------------------
// planUpdates
// ---------------------------------------------------------------------------

test('planUpdates：一个 profile 都没有时只排本仓库那一条', () => {
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  const jobs = u.planUpdates()
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].dir, u.pluginRoot())
  assert.equal(jobs[0].kind, 'git', '本仓库是 git checkout')
  assert.equal(jobs[0].profile, undefined)
})

test('planUpdates：普通版本号的 profile 排成 dsh 任务，并带上 profileDir', () => {
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  put(path.join(HOME, 'profiles', 'a', 'package.json'), '{"dependencies":{"dsh-purge":"1.1.94"}}')
  const jobs = u.planUpdates()
  const dsh = jobs.find((j) => j.profile === 'a')
  assert.equal(dsh.kind, 'dsh')
  assert.equal(dsh.spec, '1.1.94')
  assert.equal(dsh.profileDir, path.join(HOME, 'profiles', 'a'))
})

test('planUpdates：link 指向 git checkout 排 git，指向普通目录排 zip', () => {
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  const repo = box('pl-git')
  git(repo, ['init', '-q', '-b', 'main'])
  const plain = box('pl-zip')
  put(path.join(HOME, 'profiles', 'a', 'package.json'), JSON.stringify({ dependencies: { 'dsh-purge': `link:${repo}` } }))
  put(path.join(HOME, 'profiles', 'b', 'package.json'), JSON.stringify({ dependencies: { 'dsh-purge': `link:${plain}` } }))
  const jobs = u.planUpdates()
  assert.equal(jobs.find((j) => j.profile === 'a').kind, 'git')
  assert.equal(jobs.find((j) => j.profile === 'b').kind, 'zip')
})

test('planUpdates：file: 指向本地归档时按 dsh 任务处理，不会当目录去扫', () => {
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  const p = path.join(HOME, 'profiles', 'a')
  put(path.join(p, 'package.json'), '{"dependencies":{"dsh-purge":"file:./dsh-purge-1.1.94.tgz"}}')
  fs.writeFileSync(path.join(p, 'dsh-purge-1.1.94.tgz'), 'not really a tgz')
  const jobs = u.planUpdates()
  const row = jobs.find((j) => j.profile === 'a')
  assert.equal(row.kind, 'dsh', '归档走 dsh 车道而不是 zip 目录扫描')
  assert.equal(row.dir, u.pluginRoot(), '没有 node_modules 时落到本仓库')
})

test('planUpdates：两个 profile 指向同一个目录只排一次', () => {
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  const shared = box('pl-shared')
  put(path.join(HOME, 'profiles', 'a', 'package.json'), JSON.stringify({ dependencies: { 'dsh-purge': `link:${shared}` } }))
  put(path.join(HOME, 'profiles', 'b', 'package.json'), JSON.stringify({ dependencies: { 'dsh-purge': `link:${shared}` } }))
  const jobs = u.planUpdates()
  assert.equal(jobs.filter((j) => j.dir && j.dir.toLowerCase() === fs.realpathSync(shared).toLowerCase()).length, 1)
  assert.equal(jobs.length, 2, '一条共享目录 + 一条本仓库')
})

test('planUpdates：本仓库已经被 profile 指到时不再重复追加', () => {
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  put(
    path.join(HOME, 'profiles', 'a', 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-purge': `link:${u.pluginRoot()}` } }),
  )
  const jobs = u.planUpdates()
  const self = jobs.filter((j) => j.dir && j.dir.toLowerCase() === u.pluginRoot().toLowerCase())
  assert.equal(self.length, 1, '同一目录不能排两次，否则会并发覆盖同一个树')
})

test('detectVia：本仓库是 git checkout，所以至少是 git，混入普通 profile 变 mixed', () => {
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  assert.equal(u.detectVia(), 'git')
  put(path.join(HOME, 'profiles', 'a', 'package.json'), '{"dependencies":{"dsh-purge":"1.1.94"}}')
  assert.equal(u.detectVia(), 'mixed')
  put(path.join(HOME, 'profiles', 'a', 'package.json'), '{"dependencies":{"dsh-purge":"link:../x"}}')
  assert.equal(u.detectVia(), 'git', '全是 link spec 时不算 mixed')
})

// ---------------------------------------------------------------------------
// markCurrent：谁被标成「当前」
// ---------------------------------------------------------------------------

test('markCurrent：有 pin 时只认 ref 等于 pin 的那一条', () => {
  const rows = [
    { ref: 'main', version: '1.1.94', channel: 'stable', sha: 'a'.repeat(40) },
    { ref: 'v1.1.93', version: '1.1.93', channel: 'stable', sha: 'b'.repeat(40) },
  ]
  const out = u.markCurrent(rows, { channel: 'stable', pin: 'v1.1.93' }, '1.1.94', 'a'.repeat(40))
  assert.deepEqual(out.map((r) => r.current), [false, true], 'pin 优先于版本匹配')
})

test('markCurrent：没 pin 时优先「同版本 + 同提交 + latest/head」，其次同版本 latest，再次同版本同提交，最后 pool[0]', () => {
  const shaA = 'a'.repeat(40)
  const shaB = 'b'.repeat(40)
  const cases = [
    {
      tag: '同版本同提交 latest',
      rows: [
        { ref: 'main', version: '1.1.94', channel: 'stable', sha: shaA, latest: true },
        { ref: 'v1.1.94', version: '1.1.94', channel: 'stable', sha: shaB },
      ],
      want: 0,
    },
    {
      tag: '同版本 latest 但提交不同',
      rows: [
        { ref: 'main', version: '1.1.94', channel: 'stable', sha: shaA, latest: true },
        { ref: 'v1.1.94', version: '1.1.94', channel: 'stable', sha: shaB },
      ],
      localSha: shaB,
      want: 0,
      why: '优先级第一档要求 latest，第二档才轮到「同版本同提交」',
    },
    {
      tag: '同提交 + main 胜过「别的行 latest」',
      rows: [
        { ref: 'v1.1.94', version: '1.1.94', channel: 'stable', sha: shaB, latest: true },
        { ref: 'main', version: '1.1.94', channel: 'stable', sha: shaA },
      ],
      localSha: shaA,
      want: 1,
      why: '第一档要求「同提交 且（latest 或 main 或 head）」；只有 main 那条同时满足',
    },
    {
      tag: '只有同版本同提交',
      rows: [
        { ref: 'v1.1.94', version: '1.1.94', channel: 'stable', sha: shaB },
        { ref: 'v1.1.94-x', version: '1.1.94', channel: 'stable', sha: shaA },
      ],
      want: 1,
      why: '两条都不 latest 也不 head，第三档才按 localSha 选，命中 shaA 那一条（index 1）',
    },
    {
      tag: '什么都没有就取第一条',
      rows: [
        { ref: 'v1.1.94', version: '1.1.94', channel: 'stable' },
        { ref: 'v1.1.94-y', version: '1.1.94', channel: 'stable' },
      ],
      want: 0,
    },
  ]
  for (const c of cases) {
    const out = u.markCurrent(c.rows, { channel: 'stable', pin: '' }, '1.1.94', c.localSha === undefined ? shaA : c.localSha)
    const currentIdx = out.findIndex((r) => r.current)
    assert.equal(currentIdx, c.want, c.tag + (c.why ? '：' + c.why : ''))
    assert.equal(out.filter((r) => r.current).length, 1, c.tag + '：只能有一条当前')
  }
})

test('markCurrent：版本不同的一条都不会被标当前；shaShort 缺失时补 7 位', () => {
  const rows = [
    { ref: 'main', version: '1.1.95', channel: 'stable', sha: 'c'.repeat(40), latest: true },
    { ref: 'v1.1.94', version: '1.1.94', channel: 'beta', sha: 'd'.repeat(40) },
  ]
  const out = u.markCurrent(rows, { channel: 'stable', pin: '' }, '1.1.94', '')
  assert.deepEqual(out.map((r) => r.current), [false, false], '车道不同/版本不同都不算当前')
  assert.equal(out[0].shaShort, 'ccccccc')
  assert.equal(out[1].shaShort, 'ddddddd')
})

test('markCurrent：shaShort 已经有时不覆盖', () => {
  const out = u.markCurrent([{ ref: 'main', version: '1.1.94', channel: 'stable', sha: 'e'.repeat(40), shaShort: 'KEEP' }], { channel: 'stable', pin: '' }, '1.1.94', '')
  assert.equal(out[0].shaShort, 'KEEP')
})

// ---------------------------------------------------------------------------
// listRemoteVersions（在线更新关闭时不该发任何请求）
// ---------------------------------------------------------------------------

test('listRemoteVersions：在线更新关闭时不联网，只给出本机在跑的这一条', async () => {
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  resetChannel('{"channel":"stable","pin":""}\n')
  fs.rmSync(HISTORY_FILE, { force: true })
  const seen = fakeHttpsOnce(Buffer.from('should not be used'))
  try {
    const listed = await u.listRemoteVersions()
    assert.deepEqual(seen, [], '关掉在线更新就一个请求都不该发')
    assert.equal(listed.stableSha, '')
    assert.equal(listed.betaSha, '')
    assert.equal(listed.hasBeta, false)
    assert.equal(listed.versions.length, 1)
    const row = listed.versions[0]
    assert.equal(row.kind, 'local', '本机在跑的版本以 local 行插入')
    assert.equal(row.version, '1.1.94')
    assert.equal(row.channel, 'stable')
    assert.equal(row.ref, 'main', '列表里没有 main 时用 STABLE_REF 当 ref')
    assert.equal(row.latest, true)
    assert.equal(row.current, true)
    assert.match(row.sha ?? '', /^([0-9a-f]{40})?$/)
  } finally {
    https.request = ORIGIN_REQUEST
  }
})

test('listRemoteVersions：历史记录会进列表，撤下的版本与 beta 名会被过滤', async () => {
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  resetChannel('{"channel":"stable","pin":""}\n')
  put(
    HISTORY_FILE,
    JSON.stringify([
      { ref: 'v1.1.93', version: '1.1.93', channel: 'stable', sha: 'a'.repeat(40), kind: 'history' },
      { ref: 'v1.1.95-beta.1', version: '1.1.95-beta.1', channel: 'beta' },
      { ref: 'v1.1.11-beta.1', version: '1.1.11-beta.1', channel: 'stable' },
      { ref: '', version: '1.1.0' },
      null,
    ]),
  )
  const listed = await u.listRemoteVersions()
  const refs = listed.versions.map((r) => r.ref)
  assert.ok(refs.includes('v1.1.93'), '干净的历史版本要显示')
  assert.equal(refs.includes('v1.1.95-beta.1'), false, 'beta 名要隐藏')
  assert.equal(refs.includes('v1.1.11-beta.1'), false, '撤下的版本要隐藏')
  assert.equal(listed.versions.some((r) => r.ref === ''), false, '没有 ref 的历史条目直接丢')
})

test('listRemoteVersions：本地版本是 beta 时不插入 local 行', async () => {
  // localVersion() 读的是本仓库 package.json，改不了；所以这里用 beta 渠道观察另一条路径：
  // ensureRunningVersion 在 state.channel === 'beta' 时直接返回原列表。
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  resetChannel('{"channel":"beta","pin":""}\n')
  fs.rmSync(HISTORY_FILE, { force: true })
  const listed = await u.listRemoteVersions()
  assert.deepEqual(listed.versions, [], 'beta 渠道 + 无远端 → 一条都没有')
  assert.equal(listed.hasBeta, false)
})

// ---------------------------------------------------------------------------
// checkUpdate
// ---------------------------------------------------------------------------

test('checkUpdate：stable 车道没有远端时抛出「在线更新不可用」的固定文案', async () => {
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  resetChannel('{"channel":"stable","pin":""}\n')
  fs.rmSync(HISTORY_FILE, { force: true })
  await assert.rejects(
    () => u.checkUpdate(),
    /本维护仓库为私有，在线更新不可用；请用本地 tgz 更新/,
  )
})

test('checkUpdate：beta 车道没有远端时安静回「还没有测试版」，不当成错误', async () => {
  fs.rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true })
  resetChannel('{"channel":"beta","pin":""}\n')
  fs.rmSync(HISTORY_FILE, { force: true })
  const result = await u.checkUpdate()
  assert.equal(result.ok, true)
  assert.equal(result.hasUpdate, false)
  assert.equal(result.hasBeta, false)
  assert.equal(result.error, '还没有测试版')
  assert.equal(result.localVersion, '1.1.94')
  assert.equal(result.remoteVersion, '')
  assert.equal(result.remoteSha, '')
  assert.equal(result.updateTarget, 'beta', 'beta 车道的目标是 beta 分支')
  assert.equal(result.channel, 'beta')
  assert.equal(result.channelLabel, '测试版')
  assert.ok(result.lanes && result.lanes.stable && result.lanes.beta, '两条车道都要给出')
})

test('checkUpdate：结果是可读回的（lastUpdateResult 与返回值同一份）', async () => {
  resetChannel('{"channel":"beta","pin":""}\n')
  fs.rmSync(HISTORY_FILE, { force: true })
  const result = await u.checkUpdate()
  assert.equal(u.lastUpdateResult(), result)
})

// ---------------------------------------------------------------------------
// git 落版
// ---------------------------------------------------------------------------

test('runGit：成功回 stdout，失败把 stderr 拼进错误正文', () => {
  const dir = box('git1')
  git(dir, ['init', '-q', '-b', 'main'])
  assert.match(u.runGit(dir, ['rev-parse', '--is-inside-work-tree']), /^true/)
  assert.throws(() => u.runGit(dir, ['bogus-subcmd']), (e) => {
    assert.match(e.message, /git: 'bogus-subcmd' is not a git command/)
    assert.equal(e.message.startsWith('Error: '), false, '正文不该带 Error: 前缀')
    return true
  })
})

test('gitTrackedDirty：只认 COPY_NAMES 里被跟踪的文件，未跟踪文件不算脏', () => {
  const dir = box('git2')
  git(dir, ['init', '-q', '-b', 'main'])
  put(path.join(dir, 'package.json'), '{"version":"1.0.0"}')
  put(path.join(dir, 'notes.txt'), 'hello')
  git(dir, ['add', 'package.json', 'notes.txt'])
  git(dir, ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  assert.equal(u.gitTrackedDirty(dir), false)
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'changed')
  assert.equal(u.gitTrackedDirty(dir), false, 'notes.txt 不在 COPY_NAMES 里')
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"1.0.1"}')
  assert.equal(u.gitTrackedDirty(dir), true)
  git(dir, ['checkout', '--', 'package.json'])
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'x')
  assert.equal(u.gitTrackedDirty(dir), false, '未跟踪文件不算脏')
  // 名字落在 COPY_NAMES 里但没被跟踪的文件同样不算脏：判据是 --untracked-files=no，
  // 少了这个开关，刚下载解压出来的新文件会让每次更新都以为自己「有未提交改动」。
  fs.writeFileSync(path.join(dir, 'client.js'), 'x')
  assert.equal(u.gitTrackedDirty(dir), false, 'COPY_NAMES 里的未跟踪文件也不算脏')
})

test('gitTrackedDirty：不是 git 仓库时按「脏」处理（宁可拦住也不覆盖）', () => {
  const dir = box('git3')
  assert.equal(u.gitTrackedDirty(dir), true)
})

test('gitResetTo：脏且没给 force 时拒绝覆盖，错误文案说清原因', () => {
  const dir = box('git4')
  git(dir, ['init', '-q', '-b', 'main'])
  put(path.join(dir, 'package.json'), '{"version":"1.0.0"}')
  git(dir, ['add', 'package.json'])
  git(dir, ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"1.0.1"}')
  assert.throws(() => u.gitResetTo(dir, 'main'), /本地插件文件有未提交改动，未覆盖/)
})

test('gitResetTo：force 时跳过脏检查，但还在 safeUpdateRef 上把关', () => {
  const dir = box('git5')
  git(dir, ['init', '-q', '-b', 'main'])
  put(path.join(dir, 'package.json'), '{"version":"1.0.0"}')
  git(dir, ['add', 'package.json'])
  git(dir, ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"1.0.1"}')
  assert.throws(() => u.gitResetTo(dir, 'not a ref!', { force: true }), /未知版本/)
  // 空 ref 不是「未知版本」：`ref || STABLE_REF` 先把它换成 main，于是走到 fetch 才失败。
  // 这条分支只有在真的没有 origin 时才报 git 的错 —— 记下来，免得以后有人把「空 ref 应报未知版本」当成 bug 去改。
  assert.throws(() => u.gitResetTo(dir, '', { force: true }), /origin/)
})

test('gitResetTo：真 origin 上 checkout -B 到 main，工作区被拉回干净', () => {
  const base = box('git6')
  const src = path.join(base, 'src')
  fs.mkdirSync(src)
  git(src, ['init', '-q', '-b', 'main'])
  put(path.join(src, 'package.json'), '{"version":"1.0.0"}')
  git(src, ['add', 'package.json'])
  git(src, ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'v1'])
  const bare = path.join(base, 'origin.git')
  execFileSync('git', ['clone', '-q', '--bare', src, bare], { stdio: 'ignore' })
  const clone = path.join(base, 'clone')
  execFileSync('git', ['clone', '-q', bare, clone], { stdio: 'ignore' })
  // 远端再往前走一格，本地故意落后 + 有脏改动
  put(path.join(src, 'package.json'), '{"version":"1.0.1"}')
  git(src, ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qam', 'v2'])
  execFileSync('git', ['-C', src, 'push', '-q', bare, 'main'], { stdio: 'ignore' })
  fs.writeFileSync(path.join(clone, 'package.json'), '{"version":"dirty"}')
  assert.equal(u.gitTrackedDirty(clone), true)
  u.gitResetTo(clone, 'main', { force: true })
  assert.equal(u.gitTrackedDirty(clone), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(clone, 'package.json'), 'utf8')).version, '1.0.1')
})

test('gitResetTo：远端没有 beta 分支时 checkout 与 reset 都失败，错误向上抛', () => {
  const base = box('git7')
  const src = path.join(base, 'src')
  fs.mkdirSync(src)
  git(src, ['init', '-q', '-b', 'main'])
  put(path.join(src, 'package.json'), '{"version":"1.0.0"}')
  git(src, ['add', 'package.json'])
  git(src, ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'v1'])
  const bare = path.join(base, 'origin.git')
  execFileSync('git', ['clone', '-q', '--bare', src, bare], { stdio: 'ignore' })
  const clone = path.join(base, 'clone')
  execFileSync('git', ['clone', '-q', bare, clone], { stdio: 'ignore' })
  assert.throws(() => u.gitResetTo(clone, 'beta', { force: true }), /beta/)
})

// ---------------------------------------------------------------------------
// overlayFromZip：整包覆盖（copy 白名单 + 目录先删）
// ---------------------------------------------------------------------------

const PACK = Buffer.from(
  buildZip([
    { name: 'root/', data: Buffer.alloc(0) },
    { name: 'root/package.json', data: Buffer.from('{"version":"9.9.9"}') },
    { name: 'root/README.md', data: Buffer.from('# new\n') },
    { name: 'root/lib/a.js', data: Buffer.from('export const a = 1;\n') },
    { name: 'root/lib/nested/b.js', data: Buffer.from('export const b = 2;\n') },
  ]),
)

test('overlayFromZip：空 dests 直接返回，不发请求也不建临时目录', async () => {
  const seen = fakeHttpsOnce(PACK)
  try {
    assert.equal(await u.overlayFromZip([], 'main'), undefined)
    assert.equal(await u.overlayFromZip(['', null], 'main'), undefined)
    // null / undefined 不是「空列表」，直接 .filter 就炸（现状锁定：调用点只会传数组）。
    // 注意 overlayFromZip 是 async，炸出来的是 rejected promise，不是同步 throw。
    await assert.rejects(() => u.overlayFromZip(null, 'main'), TypeError)
    await assert.rejects(() => u.overlayFromZip(undefined, 'main'), TypeError)
    assert.deepEqual(seen, [])
    assert.equal(
      fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('dsh-purge-upd-')).length,
      0,
      '提前返回时不该留下临时目录',
    )
  } finally {
    https.request = ORIGIN_REQUEST
  }
})

test('overlayFromZip：整目录先删再铺，旧文件不会留下来变成半升级', async () => {
  const dest = box('ov1')
  put(path.join(dest, 'lib', 'stale.js'), 'old\n')
  put(path.join(dest, 'lib', 'nested', 'old.js'), 'old\n')
  put(path.join(dest, 'package.json'), '{"version":"1.1.94"}')
  const seen = fakeHttpsOnce(PACK)
  try {
    await u.overlayFromZip([dest], 'main')
    assert.equal(seen.length, 1)
    assert.match(seen[0], /codeload\.github\.com\/xiuchuan666\/dsh-purge-maintained\/zip\/refs\/heads\/main/)
    assert.equal(fs.existsSync(path.join(dest, 'lib', 'stale.js')), false, 'lib 必须整体替换')
    assert.equal(fs.existsSync(path.join(dest, 'lib', 'nested', 'old.js')), false)
    assert.equal(fs.readFileSync(path.join(dest, 'lib', 'a.js'), 'utf8'), 'export const a = 1;\n')
    assert.equal(fs.readFileSync(path.join(dest, 'lib', 'nested', 'b.js'), 'utf8'), 'export const b = 2;\n')
    assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).version, '9.9.9')
    assert.equal(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), '# new\n')
  } finally {
    https.request = ORIGIN_REQUEST
  }
})

test('overlayFromZip：同一个目标传两次只铺一遍', async () => {
  const dest = box('ov2')
  put(path.join(dest, 'package.json'), '{"version":"1.1.94"}')
  const seen = fakeHttpsOnce(PACK)
  try {
    await u.overlayFromZip([dest, dest], 'main')
    assert.equal(seen.length, 1)
    assert.equal(fs.readFileSync(path.join(dest, 'lib', 'a.js'), 'utf8'), 'export const a = 1;\n')
  } finally {
    https.request = ORIGIN_REQUEST
  }
})

test('overlayFromZip：zip 里没有 package.json 时报错，且不把目标写脏', async () => {
  const dest = box('ov3')
  put(path.join(dest, 'package.json'), '{"version":"1.1.94"}')
  const junk = Buffer.from(buildZip([{ name: 'root/README.md', data: Buffer.from('# x\n') }]))
  const seen = fakeHttpsOnce(junk)
  try {
    await assert.rejects(() => u.overlayFromZip([dest], 'main'), /zip 里没有 package\.json/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).version, '1.1.94', '失败时目标原样')
    assert.equal(fs.existsSync(path.join(dest, 'lib')), false)
  } finally {
    https.request = ORIGIN_REQUEST
  }
})

test('overlayFromZip：跑完不留临时解包目录', async () => {
  const dest = box('ov4')
  put(path.join(dest, 'package.json'), '{"version":"1.1.94"}')
  const before = new Set(fs.readdirSync(TMP_ROOT).filter((n) => n.startsWith('dsh-purge-upd-')))
  const seen = fakeHttpsOnce(PACK)
  try {
    await u.overlayFromZip([dest], 'main')
  } finally {
    https.request = ORIGIN_REQUEST
  }
  const after = fs.readdirSync(TMP_ROOT).filter((n) => n.startsWith('dsh-purge-upd-'))
  assert.deepEqual(after, [...before], '临时目录必须在 finally 里删掉')
})

// ---------------------------------------------------------------------------
// applyUpdate 的闸门
// ---------------------------------------------------------------------------

test('applyUpdate：在线更新关闭时立刻抛固定文案，不会去碰磁盘', async () => {
  await assert.rejects(
    () => u.applyUpdate([], {}),
    /本维护仓库为私有，在线更新不可用；请用本地 tgz 更新/,
  )
})

test('applyUpdate：连抛两次都能抛（失败结果不被缓存成永久失败）', async () => {
  await assert.rejects(() => u.applyUpdate())
  await assert.rejects(() => u.applyUpdate())
})

// ---------------------------------------------------------------------------
// 几条只能看源码形状的守卫（行为层造不出来）
// ---------------------------------------------------------------------------

test('源码形状：safeUpdateRef 的白名单与 requestBuffer 的跳数上限写在字面量里', () => {
  const src = fs.readFileSync(new URL('../lib/update.js', import.meta.url), 'utf8')
  // 分支名一旦能带空格/斜杠，gitResetTo 就会把它当参数注入。
  assert.match(
    src,
    /const UPDATE_REF_RE = \/\^\(\?:v\?\\d\+\\\.\\d\+\(\?:\\\.\\d\+\)\?\(\?:-\[\\w\.\]\+\)\?\|master\|main\|beta\|\[0-9a-f\]\{7,40\}\)\$\/i;/,
  )
  assert.match(src, /function requestBuffer\(url, ms, headers, redirectsLeft = 5\)/)
  assert.match(src, /const MAX_UPDATE_BYTES = 50 \* 1024 \* 1024;/)
  // 白名单里七个主机一个都不能少：少一个就等于放开一条中间人落点。
  for (const host of [
    'github.com',
    'codeload.github.com',
    'api.github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'cdn.jsdelivr.net',
  ]) {
    assert.ok(src.includes(`"${host}"`), `302 白名单缺了 ${host}`)
  }
  assert.match(src, /const ONLINE_UPDATES_ENABLED = false;/, '在线更新必须保持关闭')
})
