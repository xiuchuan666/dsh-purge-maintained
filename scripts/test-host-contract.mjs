// 宿主契约（host-contract）的回归测试。
//
// 这套东西的价值全在「宿主改名时能立刻红」。所以测试的重点不是「能跑通」，
// 而是三条判定语义必须咬得住：
//   1. .dshpurge.bak 优先——否则我们自己的补丁会冒充宿主契约（实测证据：
//      dsh-settings 当前文件比官方原文多出 get/register/ensureLegacyDocument/
//      persistLegacy/commitLegacy 五个方法，全是我们注入的）。
//   2. memberProviders 生效——subprocess.resolveExecutable 的实现不在服务包
//      dsh-subprocess 里，而在 dsh-subprocess-local 里。
//   3. 契约缺失必须把 host:status 的 verdict 从 ok 抬成 broken。
//
// 拆成独立 test()：这 79 条断言原来全是顶层的，第一条红就整文件停住。
// 而「契约判定」本身是一个判定链，最坏的情况是解析层错、扫描层错、合并层错
// 同时发生——一次只看得到第一条，等于把排查成本推给未来的自己。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  checkContract, hasEventName, hasExportDecl, hasMemberDecl, hasServiceProvider,
  loadContract, readHostSource, renderContract, scanHost, validateContract, CONTRACT_SCHEMA,
} from './host-contract-lib.mjs'
import { mergeVerdicts } from './host-baseline-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONTRACT = path.join(ROOT, 'docs', 'host-contract.json')

const tmpRoots = []
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `host-contract-${tag}-`))
  tmpRoots.push(d)
  return d
}
after(() => {
  for (const d of tmpRoots) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* windows 偶发占用 */ }
  }
})

// ---------------------------------------------------------------- 声明探测

test('hasMemberDecl：制表符缩进的类方法必须认得（宿主就是这样缩进的）', () => {
  // 用空格缩进写正则会一条都匹配不到——实测踩过。
  assert.equal(hasMemberDecl('\tregister(route) {', 'register'), true)
  assert.equal(hasMemberDecl('\tasync resolveExecutable(command, env, signal) {', 'resolveExecutable'), true)
  assert.equal(hasMemberDecl('  section(section) {', 'section'), true, '空格缩进也要认（宽 1~12）')
  assert.equal(hasMemberDecl('\tget(id) {', 'get'), true, 'getter 形态必须认得')
})

test('hasMemberDecl：prototype 赋值形态必须认得', () => {
  assert.equal(hasMemberDecl('SlotRegistry.prototype.register = function register(x) {', 'register'), true)
})

test('hasMemberDecl：不能误判不存在的成员或顶层 const', () => {
  assert.equal(hasMemberDecl('\tget(id) {', 'set'), false, '不存在的成员不能误判')
  assert.equal(hasMemberDecl('const register = 1', 'register'), false, '顶层 const 不是类方法')
})

test('hasServiceProvider：非 ctx 变量名的 super 也要认得', () => {
  // 实测 settings 就是 super(ownerContext, "settings")
  assert.equal(hasServiceProvider('super(ownerContext, "settings")', 'settings'), true)
  assert.equal(hasServiceProvider('super(ctx, "tools")', 'tools'), true)
})

test('hasServiceProvider：provide 形态认得，且不误判别的服务名', () => {
  assert.equal(hasServiceProvider('ctx.provide("redteam", store)', 'redteam'), true)
  assert.equal(hasServiceProvider('super(ctx, "tools")', 'webServer'), false)
})

test('hasEventName：单双引号都认，写错必须 false', () => {
  assert.equal(hasEventName('ctx.on("session/created", fn)', 'session/created'), true)
  assert.equal(hasEventName("ctx.on('agent/pre-step', fn)", 'agent/pre-step'), true)
  assert.equal(hasEventName('ctx.on("session/created", fn)', 'session/createdx'), false)
})

test('hasExportDecl：函数声明 / const / export 列表三种形态', () => {
  assert.equal(hasExportDecl('function dshHomePath(...segments) {', 'dshHomePath'), true)
  assert.equal(hasExportDecl('export const dshHomePath = (x) => x', 'dshHomePath'), true)
  assert.equal(hasExportDecl('export { AGENTS_HOME_DIR_NAME, dshHomePath }', 'dshHomePath'), true, 'export 列表形态必须认得')
  assert.equal(hasExportDecl('function other() {', 'dshHomePath'), false)
})

// ---------------------------------------------------------------- .bak 优先

test('readHostSource：有 .dshpurge.bak 时读备份，读不到我们自己注入的方法', () => {
  const dir = tmpDir('bak')
  const file = path.join(dir, 'index.js')
  fs.writeFileSync(file, 'var X = 1; // [dsh-purge] legacy\n\tinjected() {}\n')
  fs.writeFileSync(`${file}.dshpurge.bak`, 'var X = 1;\n\tofficial() {}\n')

  const picked = readHostSource(file)
  assert.equal(picked.from, 'bak', '有 .dshpurge.bak 时必须读备份')
  assert.ok(picked.text.includes('official'), '读到的应该是官方原文')
  assert.ok(!picked.text.includes('injected'), '不能读到我们自己注入的方法')
})

test('readHostSource：没有 .bak 时读当前文件', () => {
  const dir = tmpDir('nobak')
  const plain = path.join(dir, 'plain.js')
  fs.writeFileSync(plain, '\tsolo() {}\n')
  const now = readHostSource(plain)
  assert.equal(now.from, 'now')
  assert.ok(now.text.includes('solo'))
})

// ---------------------------------------------------- scanHost / checkContract

/** 造一棵最小宿主树：两个包，其中一个有 .bak，服务包与成员实现包刻意分开。 */
function makeHost(tag) {
  const dir = tmpDir(tag)
  const mk = (pkg, rel, text) => {
    const p = path.join(dir, pkg, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text)
  }
  // 服务提供方，且有自己的 .bak（当前文件被我们改过）
  mk('dsh-host-webserver', 'lib/index.js', 'class W extends Service { constructor(ctx) { super(ctx, "webServer") } }\n\tregister(route) {}\n\tinjectedByUs() {}\n')
  mk('dsh-host-webserver', 'lib/index.js.dshpurge.bak', 'class W extends Service { constructor(ctx) { super(ctx, "webServer") } }\n\tregister(route) {}\n')
  // 服务提供方，成员实现在另一个包
  mk('dsh-subprocess', 'lib/index.js', 'class S extends Service { constructor(ctx) { super(ctx, "subprocess") } }\n')
  mk('dsh-subprocess-local', 'lib/index.js', 'class L {\n\tasync resolveExecutable(command, env, signal) {}\n}\n')
  // 事件 + 导出
  mk('dsh-session', 'lib/index.js', 'ctx.on("session/created", x)\n')
  mk('dsh-home-paths', 'lib/index.js', 'function dshHomePath(...s) {}\nexport { dshHomePath }\n')
  return dir
}

const tree = makeHost('tree')
const scan = scanHost(tree)

const contract = {
  schema: CONTRACT_SCHEMA,
  services: [
    { name: 'webServer', package: 'dsh-host-webserver', members: ['register'] },
    { name: 'subprocess', package: 'dsh-subprocess', members: ['resolveExecutable'], memberProviders: { resolveExecutable: 'dsh-subprocess-local' } },
  ],
  events: [{ name: 'session/created' }],
  exports: [{ package: 'dsh-home-paths', name: 'dshHomePath' }],
}

test('scanHost：服务、成员、事件、导出都收进了表里', () => {
  assert.deepEqual(scan.services.get('webServer'), ['dsh-host-webserver'])
  assert.deepEqual(scan.services.get('subprocess'), ['dsh-subprocess'])
  assert.ok(scan.members.has('dsh-subprocess-local::resolveExecutable'), '成员实现包的声明要被收进表里')
  assert.equal((scan.members.get('dsh-host-webserver::register') ?? []).length, 1)
  assert.ok(scan.events.get('session/created').has('dsh-session'))
})

test('scanHost：.bak 优先，我们注入的方法不进成员表', () => {
  assert.equal(scan.members.has('dsh-host-webserver::injectedByUs'), false, '.bak 优先：我们自己注入的方法不该进入成员表')
  assert.equal(scan.files.get('dsh-host-webserver/lib/index.js').from, 'bak')
})

test('checkContract：最小宿主树全中，项数是 6（2 服务 + 2 成员 + 1 事件 + 1 导出）', () => {
  const r = checkContract(contract, scan)
  assert.equal(r.ok, true, `最小宿主树应该全中，缺: ${JSON.stringify(r.missing)}`)
  assert.equal(r.total, 6)
})

test('checkContract：成员指向服务包（不配 memberProviders）必须红，并提示搬包', () => {
  // 这条正是「服务包 ≠ 成员实现包」的证据。
  const wrong = { ...contract, services: [contract.services[0], { ...contract.services[1], memberProviders: {} }] }
  const r = checkContract(wrong, scan)
  assert.equal(r.ok, false)
  assert.equal(r.missing.length, 1)
  assert.equal(r.missing[0].name, 'subprocess.resolveExecutable')
  assert.match(r.missing[0].detail, /dsh-subprocess 里没有 resolveExecutable\(\) 的声明/)
  assert.match(r.missing[0].detail, /但在 dsh-subprocess-local 里有，可能搬包了/, '缺的时候要说清成员实际在哪个包——升级当天最常见的就是搬包')
})

test('checkContract：事件名写错必须红', () => {
  const r = checkContract({ ...contract, events: [{ name: 'session/createdx' }] }, scan)
  assert.equal(r.ok, false)
  assert.equal(r.missing[0].kind, 'event')
  assert.match(r.missing[0].detail, /没有任何宿主包提到这个事件名/)
})

test('checkContract：导出写错必须红', () => {
  const r = checkContract({ ...contract, exports: [{ package: 'dsh-home-paths', name: 'nope' }] }, scan)
  assert.equal(r.ok, false)
  assert.equal(r.missing[0].kind, 'export')
})

test('checkContract：服务名写错必须红，并指出没在哪个包里找到', () => {
  const r = checkContract({ ...contract, services: [{ name: 'httpServer', package: 'dsh-host-webserver', members: [] }] }, scan)
  assert.equal(r.ok, false)
  assert.match(r.missing[0].detail, /未在 dsh-host-webserver 里找到/)
})

// ------------------------------------------------------------ validateContract

test('validateContract：非对象 / schema 不符 / services 为空都要拒绝', () => {
  assert.throws(() => validateContract(null), /不是对象/)
  assert.throws(() => validateContract({ schema: 99, services: [{ name: 'a', package: 'b', members: [] }], events: [] }), /schema=99/)
  assert.throws(() => validateContract({ schema: CONTRACT_SCHEMA, services: [], events: [] }), /services 必须是非空数组/)
})

test('validateContract：缺 package / members 非数组 / 含空值都要拒绝', () => {
  assert.throws(() => validateContract({ schema: CONTRACT_SCHEMA, services: [{ name: 'a', members: [] }], events: [] }), /缺 package/)
  assert.throws(() => validateContract({ schema: CONTRACT_SCHEMA, services: [{ name: 'a', package: 'b' }], events: [] }), /members 必须是数组/)
  assert.throws(() => validateContract({ schema: CONTRACT_SCHEMA, services: [{ name: 'a', package: 'b', members: [''] }], events: [] }), /含空值/)
})

test('validateContract：events 非数组要拒绝，健康契约要通过', () => {
  assert.throws(() => validateContract({ schema: CONTRACT_SCHEMA, services: [{ name: 'a', package: 'b', members: [] }] }), /events 必须是数组/)
  assert.doesNotThrow(() => validateContract({ schema: CONTRACT_SCHEMA, services: [{ name: 'a', package: 'b', members: [] }], events: [] }))
})

// ------------------------------------------------------------ renderContract

test('renderContract：PASS 行给出四项分类计数', () => {
  const ok = renderContract({ ok: true, total: 25, missing: [], counts: { service: 8, member: 9, event: 7, export: 1 }, rows: [] })
  assert.match(ok, /\[contract\] PASS 25 项全部命中（服务 8 \/ 成员 9 \/ 事件 7 \/ 导出 1）/)
})

test('renderContract：FAIL 行给出判断路径，而不是只报错', () => {
  const bad = renderContract({
    ok: false, total: 25, counts: {}, rows: [],
    missing: [{ kind: 'service', name: 'webServer', detail: '未在 dsh-host-webserver 里找到' }],
  })
  assert.match(bad, /\[contract\] FAIL 1\/25 项缺失/)
  assert.match(bad, /webServer/)
  assert.match(bad, /先确认是改名还是删除/, '缺的时候要给出判断路径，不是只报错')
})

// ------------------------------------------------------------ verdict 合并

test('mergeVerdicts：契约坏必须把 verdict 抬成 broken，否则宿主改名时假绿', () => {
  assert.equal(mergeVerdicts('ok', { ok: false }), 'broken')
  assert.equal(mergeVerdicts('review', { ok: false }), 'broken')
})

test('mergeVerdicts：契约好时透传补丁 verdict', () => {
  assert.equal(mergeVerdicts('ok', { ok: true }), 'ok')
  assert.equal(mergeVerdicts('review', { ok: true }), 'review')
})

test('mergeVerdicts：补丁坏了不能被契约正常掩盖；没契约时退回只看补丁', () => {
  assert.equal(mergeVerdicts('broken', { ok: true }), 'broken')
  assert.equal(mergeVerdicts('ok', null), 'ok', '没有契约时退回只看补丁')
})

// ------------------------------------------------------------ 真实契约文件

test('docs/host-contract.json：规模与 subprocess 实现包都对', () => {
  const c = loadContract(CONTRACT)
  assert.equal(c.schema, CONTRACT_SCHEMA)
  assert.ok(c.services.length >= 8, `契约里至少要有 8 个服务，实际 ${c.services.length}`)
  assert.ok(c.events.length >= 7, `至少 7 个事件，实际 ${c.events.length}`)
  const sub = c.services.find((s) => s.name === 'subprocess')
  assert.ok(sub, 'subprocess 必须在契约里')
  assert.equal(sub.memberProviders?.resolveExecutable, 'dsh-subprocess-local', 'subprocess.resolveExecutable 必须指到实现包')
})

test('docs/host-contract.json：settings 只写 update，并说明 get 是我们注入的', () => {
  const settings = loadContract(CONTRACT).services.find((s) => s.name === 'settings')
  assert.ok(settings, 'settings 必须在契约里')
  assert.ok(settings.why.includes('get'), 'settings 条目要写明「宿主没有 get()」这件事')
  assert.equal(settings.members.includes('get'), false, 'settings.get 是我们注入的，不能写进契约')
})

// ------------------------------------------------------------ CLI 一致性

test('host:status 脚本接的是 host-baseline，且真的合并了契约', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(typeof pkg.scripts['host:status'], 'string')
  assert.ok(pkg.scripts['host:status'].includes('host-baseline.mjs'))

  // host-baseline 必须真的合并契约，否则接进去等于没接
  const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'host-baseline.mjs'), 'utf8')
  assert.match(cli, /from "\.\/host-contract-lib\.mjs"/, 'host-baseline 要 import 契约层')
  assert.match(cli, /mergeVerdicts\(/, 'host:status 的 verdict 必须经过合并')
  assert.match(cli, /DEFAULT_CONTRACT/, '契约文件路径要是常量，别写死在调用处')
})

test('host-contract CLI 用退出码表达结果', () => {
  const contractCli = fs.readFileSync(path.join(ROOT, 'scripts', 'host-contract.mjs'), 'utf8')
  assert.match(contractCli, /process\.exit\(result\.ok \? 0 : 1\)/, '契约 CLI 必须用退出码表达结果')
})

// ------------------------------------------------ 真实宿主（没有就跳过）

test('真实宿主上跑一次（本机没有宿主则跳过，CI 正常）', () => {
  const probe = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'host-contract.mjs'), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
  })
  if (probe.status === 2) {
    console.log('host contract: 本机没有宿主，跳过真实扫描（CI 正常）')
    return
  }
  assert.equal(probe.status, 0, `真实宿主契约应全中，实际退出码 ${probe.status}:\n${probe.stdout}\n${probe.stderr}`)
  const j = JSON.parse(probe.stdout)
  assert.equal(j.ok, true)
  assert.ok(j.total >= 25, `契约项数不该少于 25，实际 ${j.total}`)
  assert.ok(j.scannedFiles > 100, `扫到的宿主文件数明显偏少: ${j.scannedFiles}`)
})

console.log('host contract PASS')
