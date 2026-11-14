// `lib/web.js` 的两条「重启自己」：`scheduleRestart` 与 `scheduleCleanupRestart`。
//
// 这两条以前没测，理由写在上一个文件里 —— 它们会 spawn 一个 detached 助手，
// 然后 `setTimeout(() => process.exit(0), 250)`，直接调用就把跑测试的进程杀了。
// 但真正危险的是「有没有 spawn 对东西、payload 里带没带够信息」，那三件事全是
// 参数问题，可以逐个用假的 `spawn` / `process.exit` / `setTimeout` 拦下来看：
//   - 假 spawn 必须是**同步**返回真对象形状（`unref` 会被调）；
//   - `process.exit` 与 `setTimeout` 都是可写的 own property，拦下来不影响别的用例，
//     但必须在 `finally` 里还原（`node --test` 同一个进程里还有别的文件）。
// 唯一真的动盘的是 `silenceCmdFlash()`（它在 `spawnRestartHelper` 里）与本文件
// 第二个函数对 `lib/uninstall-restart.js` 的复制 —— 前者在本机是幂等的
// （宿主 bin.js 早已 `already_injected`，探针实测两次 SHA-256 不变），
// 后者落在 `os.tmpdir()` 下、由 `finally` 删掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const CJS_CP = require('node:child_process')
const REAL_SPAWN = CJS_CP.spawn
const REAL_EXIT = process.exit
const REAL_TIMEOUT = globalThis.setTimeout
const REAL_LOG = console.log

const SRC = readFileSync(new URL('../lib/web.js', import.meta.url), 'utf8')
const HELPER_SRC = readFileSync(new URL('../lib/uninstall-restart.js', import.meta.url), 'utf8')

const ROOT = mkdtempSync(join(tmpdir(), 'dshp-web-restart-'))
const PREV = {
  TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR,
  DSH_HOME: process.env.DSH_HOME, DSH_SURFACE: process.env.DSH_SURFACE, DSH_BASE: process.env.DSH_BASE,
  DSH_DESKTOP_INSTALL: process.env.DSH_DESKTOP_INSTALL, PORT: process.env.PORT,
  DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE,
}
process.env.TEMP = ROOT
process.env.TMP = ROOT
process.env.TMPDIR = ROOT
process.env.DSH_HOME = join(ROOT, 'home')
process.env.DSH_SURFACE = 'web'
process.env.DSH_BASE = join(ROOT, 'ai', 'node_modules', '@deepseek-ai')
delete process.env.DSH_DESKTOP_INSTALL
mkdirSync(process.env.DSH_BASE, { recursive: true })
mkdirSync(process.env.DSH_HOME, { recursive: true })

const web = await import('../lib/web.js')
const core = await import('../lib/core.js')

/** 宿主 `bin.js` 的指纹：这条测试只允许「本来就已注入」的幂等写入。 */
const HOST_BIN = 'D:/dsh-purge-maintained/node_modules/@deepseek-ai/dsh/lib/bin.js'
const hostSha = () => (existsSync(HOST_BIN) ? createHash('sha256').update(readFileSync(HOST_BIN)).digest('hex') : 'absent')
const hostBefore = hostSha()

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/**
 * 拦下 spawn / process.exit / setTimeout / console.log 四件事，跑一次 fn。
 * 返回的东西里 `spawns` 是每次 spawn 的 `{cmd, args, opts, unref}`。
 */
async function capture(fn, options = {}) {
  const spawns = []
  const exits = []
  const timers = []
  const logs = []
  CJS_CP.spawn = (cmd, args, opts) => {
    const rec = { cmd, args, opts, unref: 0 }
    spawns.push(rec)
    return { unref: () => { rec.unref += 1 }, pid: 424242 }
  }
  syncBuiltinESMExports()
  process.exit = (code) => { exits.push(code); }
  globalThis.setTimeout = (cb, ms) => { timers.push(ms); return { unref() {} } }
  console.log = (...args) => {
    if (options.logThrows) throw new Error('log boom')
    logs.push(args.join(' '))
  }
  try {
    await fn()
  } finally {
    CJS_CP.spawn = REAL_SPAWN
    syncBuiltinESMExports()
    process.exit = REAL_EXIT
    globalThis.setTimeout = REAL_TIMEOUT
    console.log = REAL_LOG
  }
  return { spawns, exits, timers, logs }
}

const payloadOf = (rec) => JSON.parse(rec.opts.env.DSH_PURGE_RESTART)

test.after(() => {
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* Windows EPERM */ }
})

/* ------------------------------------------------------------ scheduleRestart */

test('scheduleRestart 用当前 node 去跑 restart-web.js，detached 且不挂 stdio', async () => {
  const { spawns, exits, timers } = await capture(() => {
    web.scheduleRestart({ headers: { host: '127.0.0.1:51946' } })
  })
  assert.equal(spawns.length, 1)
  const rec = spawns[0]
  assert.equal(rec.cmd, process.execPath, '必须用当前 node 解释器，不能假设 PATH 上有 node')
  assert.equal(rec.args.length, 1)
  assert.match(rec.args[0], /restart-web\.js$/)
  assert.equal(rec.opts.detached, true, '不 detached 的话前台进程一退就把子进程带走')
  assert.equal(rec.opts.stdio, 'ignore')
  assert.equal(rec.opts.windowsHide, true)
  assert.equal(rec.opts.shell, false, 'shell:true 会把带空格的路径拆开')
  assert.equal(rec.unref, 1, '必须 unref，否则父进程退出前一直等它')
  assert.deepEqual(timers, [250], '250ms 后自己退出，把终端还给用户')
  assert.deepEqual(exits, [], '本例只验证排程，不该真的退出（exit 在定时器里）')
})

test('payload 带齐重启所需：kind / execPath / argv / cwd / host / port / pid / openBrowser', async () => {
  const { spawns } = await capture(() => {
    web.scheduleRestart({ headers: { host: '127.0.0.1:51946' } })
  })
  const p = payloadOf(spawns[0])
  assert.equal(p.kind, 'web')
  assert.equal(p.execPath, process.execPath)
  assert.deepEqual(p.argv, web.restartArgv(), 'argv 必须就是 restartArgv() 的结果，不能各算一套')
  assert.ok(p.argv.includes('--no-open'))
  assert.equal(p.cwd, process.cwd())
  assert.equal(p.host, '127.0.0.1')
  assert.equal(p.port, 51946)
  assert.equal(p.pid, process.pid)
  assert.equal(p.openBrowser, true, '有 request 说明是用户点的重开，应该弹浏览器')
})

test('request 为 null 时不弹浏览器（settle / 自愈重启会走这条）', async () => {
  const { spawns } = await capture(() => { web.scheduleRestart(null) })
  assert.equal(payloadOf(spawns[0]).openBrowser, false)
})

test('options.openBrowser 能压过默认推断（两种方向都要生效）', async () => {
  const a = await capture(() => { web.scheduleRestart(null, undefined, { openBrowser: true }) })
  assert.equal(payloadOf(a.spawns[0]).openBrowser, true)
  const b = await capture(() => { web.scheduleRestart({ headers: {} }, undefined, { openBrowser: false }) })
  assert.equal(payloadOf(b.spawns[0]).openBrowser, false)
})

test('那句「关掉窗口不会停」打不出来时也不许影响重启', async () => {
  /* 用户最容易犯的错就是看到终端回到提示符以为程序关了，然后再开一个 → EADDRINUSE。
     所以这句话必须打；但 console.log 抛错（管道断了）不能把重启也带崩。 */
  const { spawns, logs } = await capture(() => {
    web.scheduleRestart({ headers: { host: '127.0.0.1:3080' } })
  }, { logThrows: true })
  assert.equal(logs.length, 0)
  assert.equal(spawns.length, 1, '打印失败也必须照样 spawn')
  assert.equal(payloadOf(spawns[0]).helper, undefined, 'scheduleRestart 不带 helper，只有清理重启才带')
})

test('那句提示的原文钉住：必须说清「关窗不停、下次 dsh web 会接管」', async () => {
  const { logs } = await capture(() => { web.scheduleRestart({ headers: {} }) })
  assert.equal(logs.length, 1)
  assert.match(logs[0], /^\[dsh-purge\] restarting dsh web in the background/)
  assert.match(logs[0], /closing this window will NOT stop it/)
  assert.match(logs[0], /The next `dsh web` reclaims it automatically/)
})

test('传给子进程的环境里不含 DSH_PERMISSION_MODE / DSH_PURGE_RESTART（否则会串到下一轮）', async () => {
  process.env.DSH_PERMISSION_MODE = 'danger-full-access'
  try {
    const { spawns } = await capture(() => { web.scheduleRestart({ headers: {} }) })
    const env = spawns[0].opts.env
    assert.equal(env.DSH_PERMISSION_MODE, undefined)
    assert.equal(JSON.parse(env.DSH_PURGE_RESTART).kind, 'web', 'DSH_PURGE_RESTART 只剩本次自己的那一份')
  } finally {
    delete process.env.DSH_PERMISSION_MODE
  }
})

/* ----------------------------------------------------- scheduleCleanupRestart */

test('scheduleCleanupRestart 把 uninstall-restart.js 复制到临时目录再跑它', async () => {
  const { spawns, timers } = await capture(() => {
    web.scheduleCleanupRestart({ request: { headers: { host: '127.0.0.1:51946' } }, cleanup: ['x', 'y'] })
  })
  const rec = spawns[0]
  const dest = rec.args[0]
  assert.match(dest, new RegExp(`dsh-purge-uninst-${process.pid}\\.mjs$`))
  assert.ok(dest.startsWith(ROOT), '必须落在 os.tmpdir() 下：' + dest)
  assert.ok(existsSync(dest))
  assert.equal(sha256(readFileSync(dest, 'utf8')), sha256(HELPER_SRC), '必须是逐字节复制')
  assert.deepEqual(timers, [400], '清理比重启多给 150ms：要等删除跑完')
})

test('清理重启的 payload 带 cleanup 与 helper 自己，argv 省略时回落 restartArgv', async () => {
  const { spawns } = await capture(() => {
    web.scheduleCleanupRestart({ request: { headers: {} }, cleanup: ['a'] })
  })
  const rec = spawns[0]
  const p = payloadOf(rec)
  assert.equal(p.kind, 'web')
  assert.deepEqual(p.cleanup, ['a'])
  assert.equal(p.helper, rec.args[0], 'helper 必须指向复制出来的那份，不是仓库里的源码')
  assert.deepEqual(p.argv, web.restartArgv())
  assert.equal(p.openBrowser, true)
})

test('调用方给了 argv 就用调用方的，没有 request 就不弹浏览器', async () => {
  const argv = ['C:/fake/lib/bin.js', 'web', '--port', '3999', '--no-open']
  const { spawns } = await capture(() => {
    web.scheduleCleanupRestart({ restartArgv: argv, cleanup: [] })
  })
  const p = payloadOf(spawns[0])
  assert.deepEqual(p.argv, argv)
  assert.deepEqual(p.cleanup, [])
  assert.equal(p.openBrowser, false)
})

test('无参调用也对：restartArgv 回落、cleanup 空表、不抛', async () => {
  const { spawns } = await capture(() => { web.scheduleCleanupRestart() })
  const p = payloadOf(spawns[0])
  assert.ok(Array.isArray(p.argv) && p.argv.length > 0)
  assert.deepEqual(p.cleanup, [])
  assert.equal(p.openBrowser, false)
  assert.equal(p.host, '127.0.0.1')
})

test('两次清理重启复制的是同一个文件名（同 pid 覆盖写，不堆临时文件）', async () => {
  const a = await capture(() => { web.scheduleCleanupRestart({ cleanup: [] }) })
  const b = await capture(() => { web.scheduleCleanupRestart({ cleanup: [] }) })
  assert.equal(a.spawns[0].args[0], b.spawns[0].args[0])
})

/* ------------------------------------------------------------------- 形状 */

test('源码形状：spawn 的五个选项与 250/400 两个延时都写死在调用的地方', () => {
  assert.match(SRC, /detached: true,/)
  assert.match(SRC, /stdio: "ignore",/)
  assert.match(SRC, /windowsHide: true,/)
  assert.match(SRC, /shell: false,/)
  assert.match(SRC, /setTimeout\(\(\) => process\.exit\(0\), exitAfter\);/)
  assert.match(SRC, /function spawnRestartHelper\(helper, payload, exitAfter = 250\)/)
  assert.match(SRC, /\}, 400\);/)
  /* 提示语里的反引号会被当成 Markdown 行内代码，写进源码就是普通字符 —— 钉住它没被"顺手"去掉 */
  assert.ok(SRC.includes('`dsh web`'))
  assert.equal(hostSha(), hostBefore, '这条测试不许改宿主 bin.js（本机现状是已注入的幂等写入）')
})
