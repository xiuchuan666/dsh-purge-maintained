/**
 * 桌面端那三段 PowerShell 脚本本身，以及围绕它们的纯函数。
 *
 * 为什么值得单独一个文件：这三段脚本要在**宿主进程被自己杀掉之后**继续跑，
 * 出错的表现是「点了应用，DSH 全死，什么都没变」—— 用户只能重装。
 * 它们没法在 fixture 里真跑（要真 powershell + 真安装树 + 真进程），
 * 所以这里钉的是**脚本文本必须满足的约束**：先杀 Electron main 再杀 host、
 * 不用 `taskkill /IM`（会误伤同名第三方）、挪不动时要留 rename-pending 并拉起原版、
 * 幂等块必须三级回退。
 *
 * 文本断言很脆（改一个字就红），这是刻意的：这三段脚本改坏一次就是一次事故，
 * 每次改动都应该有人重新读一遍、并在提交信息里说明为什么改。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ASAR_SWAP_PS1,
  desktopRestartChoice,
  desktopCliEntryPatched,
  officialCliShimBodies,
  patchOfficialCliCmdText,
  planOfficialRestart,
  scheduleAsarRenameWhenIdle,
  sealedSwapKind,
} from '../lib/desktop.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dshpurge-deskscripts-'))
test.after(() => {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* Windows 偶发 EPERM */ }
})

/* ------------------------------------------------------------------ ASAR_SWAP_PS1 */

test('换包脚本：三个必填参数齐全，且带 deadline 兜底（不能无限等）', () => {
  assert.match(ASAR_SWAP_PS1, /\[Parameter\(Mandatory = \$true\)\]\[int\]\$WaitPid/)
  assert.match(ASAR_SWAP_PS1, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$AsarPath/)
  assert.match(ASAR_SWAP_PS1, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExePath/)
  assert.match(ASAR_SWAP_PS1, /\$deadline = \(Get-Date\)\.AddSeconds\(10\)/)
})

test('换包脚本：先杀 Electron main，再杀整棵安装树（顺序反了就会弹 crash 对话框）', () => {
  const mainKill = ASAR_SWAP_PS1.indexOf('$mains = @(Get-CimInstance')
  const treeKill = ASAR_SWAP_PS1.indexOf('Stop-HarnessInstall\n') >= 0
    ? ASAR_SWAP_PS1.indexOf('Stop-HarnessInstall\n')
    : ASAR_SWAP_PS1.indexOf('Stop-HarnessInstall\r\n')
  assert.ok(mainKill > 0, '必须单独筛出 Electron main')
  assert.ok(treeKill > mainKill, 'main 的筛选与 kill 必须排在整树 kill 之前')
  /* main 的判据是「同一 exe 且命令行没有 --type=」，否则会把渲染进程也当 main。 */
  assert.match(ASAR_SWAP_PS1, /\(\$ep\.ToLower\(\) -eq \$exeNorm\) -and \(\$_\.CommandLine -notmatch '--type='\)/)
})

test('换包脚本：按安装根路径杀进程，绝不用 taskkill /IM 全名杀', () => {
  /* 任意形态的 taskkill 全名杀都不允许（`taskkill.exe /F /IM` 同样误伤）。 */
  assert.ok(!/taskkill[^\r\n]*\/IM/i.test(ASAR_SWAP_PS1), 'taskkill /IM 会误伤同名的第三方进程')
  /* 整树 kill 必须真的被调用（定义留着但没人调 = 脚本什么都没杀）。 */
  assert.ok((ASAR_SWAP_PS1.match(/^\s*Stop-HarnessInstall\s*$/gm) || []).length >= 2, 'Stop-HarnessInstall 至少要被调用两次')
  assert.ok(ASAR_SWAP_PS1.includes("$low.StartsWith($installRoot.ToLower() + '\\')"), '按安装根前缀匹配')
})

test('换包脚本：挪 asar 前先清旧 .bak，挪不动时留 rename-pending 并把原版拉起来', () => {
  assert.match(ASAR_SWAP_PS1, /\$bak = "\$AsarPath\.bak"/)
  assert.match(ASAR_SWAP_PS1, /if \(Test-Path -LiteralPath \$bak\) \{ Remove-Item -LiteralPath \$bak -Force/)
  /* 失败分支：写 lock + 记日志 + 启动原版。少任何一步都会把用户留在空桌面上。 */
  assert.match(ASAR_SWAP_PS1, /\$lock = \$AsarPath \+ '\.rename-pending'/)
  assert.match(ASAR_SWAP_PS1, /Set-Content -LiteralPath \$lock -Value \(\(Get-Date\)\.ToString\('o'\)\) -Encoding ascii/)
  assert.match(ASAR_SWAP_PS1, /relaunching original app \(asar still sealed\)/)
  /* 成功分支：删 lock 再启动，否则下一次会被自己的 30 分钟窗口挡住。 */
  assert.match(ASAR_SWAP_PS1, /if \(\$moved\) \{\r\n  Remove-Item -LiteralPath \$lock -Force/)
})

test('换包脚本：Move-Item 报拒绝访问时用 .NET 直调再试一次，并保留真实错误', () => {
  assert.match(ASAR_SWAP_PS1, /\[System\.IO\.File\]::Move\(\$AsarPath, \$bak\)/)
  assert.match(ASAR_SWAP_PS1, /\$moveErr = \$_\$?\.?Exception\.Message/)
  /* 重试循环有上限，不能死等。 */
  assert.match(ASAR_SWAP_PS1, /for \(\$i = 0; \$i -lt 80; \$i\+\+\)/)
})

test('换包脚本：CRLF 拼行（PowerShell 对 LF 也能跑，但混行尾会让 diff 与 review 变噪音）', () => {
  assert.ok(ASAR_SWAP_PS1.includes('\r\n'), '必须是 CRLF')
  assert.equal(ASAR_SWAP_PS1.split('\n').length - 1, ASAR_SWAP_PS1.split('\r\n').length - 1, '不能混入裸 LF')
})

/* ------------------------------------------------------------------ 幂等块 */

test('官方 CLI 三件套：每条都三级回退（asar → asar.unpacked → app）', () => {
  const bodies = officialCliShimBodies('DSH NEXT.exe')
  for (const [name, body] of Object.entries({ sh: bodies.sh, cmd: bodies.cmd, ps1: bodies.ps1 })) {
    assert.ok(body.includes('app.asar'), name + ' 必须优先 app.asar')
    assert.ok(body.includes('app.asar.unpacked'), name + ' 必须回退 app.asar.unpacked')
    assert.ok(body.includes('app/dsh') || body.includes('app\\dsh'), name + ' 必须回退到解包后的 app/')
  }
})

test('官方 CLI 三件套：启动器名字注入进去，缺省是 DeepSeek Harness.exe', () => {
  const custom = officialCliShimBodies('DSH NEXT.exe')
  for (const body of [custom.sh, custom.cmd, custom.ps1]) assert.ok(body.includes('DSH NEXT.exe'))
  const fallback = officialCliShimBodies('')
  for (const body of [fallback.sh, fallback.cmd, fallback.ps1]) assert.ok(body.includes('DeepSeek Harness.exe'))
})

test('官方 CLI 三件套：sh 退 3 级拿 resources、exe 在上一级（差一级就是 not recognized）', () => {
  const { sh, cmd } = officialCliShimBodies('x.exe')
  assert.ok(sh.includes('"$(dirname -- "$0")/../../.."'), 'sh 从 bin/ 退 3 级')
  assert.ok(sh.includes('exec "$(dirname "$resources")/x.exe"'), 'exe 在 resources 的上一级')
  assert.ok(cmd.includes('%~dp0..\\..\\..\\app.asar'), 'cmd 同样从 bin/ 退 3 级')
  assert.ok(cmd.includes('"%~dp0..\\..\\..\\..\\x.exe"'), 'cmd 的 exe 退 4 级')
})

test('官方 CLI 三件套：行尾按平台分开（sh 用 LF，cmd/ps1 用 CRLF）', () => {
  const { sh, cmd, ps1 } = officialCliShimBodies('x.exe')
  assert.ok(!sh.includes('\r'), 'sh 不能带 CR，否则 /bin/sh 会把 CR 当参数的一部分')
  assert.ok(cmd.includes('\r\n'))
  assert.ok(ps1.includes('\r\n'))
})

test('patchOfficialCliCmdText：裸 asar 路径改写成三级块，二次调用幂等', () => {
  const original = [
    '@ECHO off',
    'set "ELECTRON_RUN_AS_NODE=1"',
    '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
    '',
  ].join('\r\n')
  const first = patchOfficialCliCmdText(original)
  assert.equal(first.changed, true)
  assert.match(first.text, /REM dsh-purge cli entry begin/)
  assert.match(first.text, /set "entry=%~dp0\.\.\\\.\.\\\.\.\\app\.asar\\/)
  assert.match(first.text, /if not exist "%entry%" set "entry=%~dp0\.\.\\\.\.\\\.\.\\app\.asar\.unpacked\\/)
  assert.match(first.text, /if not exist "%entry%" set "entry=%~dp0\.\.\\\.\.\\\.\.\\app\\/)
  /* 原文那行 asar 路径必须被换成 %entry%，否则回退等于没生效。 */
  assert.match(first.text, /"%entry%" %\*\r?\n?$/)
  /* 旧形态是「%~dp0..\..\..\app.asar\...」直接写在命令行里；改写后必须只剩 %entry%。 */
  assert.ok(!first.text.includes('"%~dp0..\\..\\..\\app.asar'), '旧路径要全部替换掉')
  /* 两条 if not exist + 最后一行调用，共三处引用（set 那一行是 entry= 不是 %entry%）。 */
  assert.equal(first.text.split('%entry%').length - 1, 3, '两条回退 + 一行调用')

  const second = patchOfficialCliCmdText(first.text)
  assert.equal(second.changed, false)
  assert.equal(second.already, true)
  assert.equal(second.text, first.text)
})

test('patchOfficialCliCmdText：不含 asar 的 cmd 原样返回，不做任何猜测', () => {
  const plain = '@ECHO off\r\nrem nothing here\r\n'
  const out = patchOfficialCliCmdText(plain)
  assert.deepEqual(out, { changed: false, text: plain })
  assert.deepEqual(patchOfficialCliCmdText(''), { changed: false, text: '' })
})

test('desktopCliEntryPatched：认标记，不认文件是否存在以外的东西', () => {
  const hit = join(sandbox, 'dsh.cmd')
  writeFileSync(hit, 'REM dsh-purge cli entry begin\r\n', 'utf8')
  assert.equal(desktopCliEntryPatched(hit), true)
  const miss = join(sandbox, 'plain.cmd')
  writeFileSync(miss, '@ECHO off\r\n', 'utf8')
  assert.equal(desktopCliEntryPatched(miss), false)
  assert.equal(desktopCliEntryPatched(join(sandbox, 'nope.cmd')), false)
})

/* ------------------------------------------------------------------ 重启决策 */

test('planOfficialRestart：没有进行中标记就从零开始，wscript 可用时走 wscript', () => {
  const plan = planOfficialRestart({ wshJs: true, scriptAscii: true })
  assert.deepEqual(plan, { action: 'start', kind: 'wscript', writeInflight: true, clearInflight: false })
})

test('planOfficialRestart：wscript 不可用或脚本不是 ASCII 时改走 PowerShell，并清掉陈旧标记', () => {
  assert.deepEqual(
    planOfficialRestart({ wshJs: false }),
    { action: 'start', kind: 'powershell', writeInflight: false, clearInflight: true },
  )
  assert.deepEqual(
    planOfficialRestart({ wshJs: true, scriptAscii: false }),
    { action: 'start', kind: 'powershell', writeInflight: false, clearInflight: true },
  )
})

test('planOfficialRestart：只有「新鲜标记 + 日志说 running」才算已在重启', () => {
  assert.deepEqual(planOfficialRestart({ inflightAgeMs: 1000, logState: 'running' }), { action: 'already' })
  /* 写过 begin 但停掉了（aborted / done）—— 这次点击要重新开始，否则用户点了没反应。 */
  assert.equal(planOfficialRestart({ inflightAgeMs: 1000, logState: 'aborted' }).action, 'start')
  assert.equal(planOfficialRestart({ inflightAgeMs: 1000, logState: 'done' }).action, 'start')
  assert.equal(planOfficialRestart({ inflightAgeMs: 1000, logState: 'none' }).action, 'start')
})

test('planOfficialRestart：45 秒窗口之外的标记不算进行中（陈旧标记不能吃掉点击）', () => {
  assert.equal(planOfficialRestart({ inflightAgeMs: 44000, logState: 'running' }).action, 'already')
  assert.equal(planOfficialRestart({ inflightAgeMs: 46000, logState: 'running' }).action, 'start')
  /* 时钟回拨（age 为负）也按陈旧处理。 */
  assert.equal(planOfficialRestart({ inflightAgeMs: -1000, logState: 'running' }).action, 'start')
  assert.equal(planOfficialRestart({ inflightAgeMs: NaN, logState: 'running' }).action, 'start')
})

test('planOfficialRestart：logStarted 是 logState 的退化写法（老调用点还在用）', () => {
  assert.deepEqual(planOfficialRestart({ inflightAgeMs: 1000, logStarted: true }), { action: 'already' })
  assert.equal(planOfficialRestart({ inflightAgeMs: 1000, logStarted: false }).action, 'start')
})

test('desktopRestartChoice：官方 Windows 包走 wscript 那套，密封 asar 走换包，其余按能力退化', () => {
  /* 用正斜杠：CI 在 ubuntu 上跑，path.basename 不把反斜杠当分隔符，
     反斜杠路径在那边会整串当一个文件名，这条断言就会变成「在 Linux 上测 Windows 路径」。 */
  const officialExe = 'C:/Users/x/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
  assert.equal(desktopRestartChoice({ platform: 'win32', exe: officialExe }), 'windows-official')
  assert.equal(desktopRestartChoice({ platform: 'linux', exe: officialExe }), 'helper')
  assert.equal(
    desktopRestartChoice({ platform: 'linux', exe: '/opt/DSH Desktop/DSH Desktop', asarSealed: true }),
    'asar-swap',
  )
  assert.equal(desktopRestartChoice({ platform: 'linux', exe: '/opt/DSH Desktop/DSH Desktop' }), 'helper')
  assert.equal(desktopRestartChoice({ platform: 'linux', hasRuntime: true }), 'request-restart')
  assert.equal(desktopRestartChoice({ platform: 'linux' }), 'helper')
})

test('desktopRestartChoice：openBrowser:false 一律 skip（启动自检不能把桌面进程杀掉）', () => {
  const officialExe = 'C:/x/DeepSeek Harness/DeepSeek Harness.exe'
  assert.equal(desktopRestartChoice({ platform: 'win32', exe: officialExe, openBrowser: false }), 'skip')
  assert.equal(desktopRestartChoice({ platform: 'linux', hasRuntime: true, openBrowser: false }), 'skip')
})

test('sealedSwapKind：Windows 用 PowerShell，其它平台用 restart-desktop.js 助手', () => {
  assert.equal(sealedSwapKind('win32'), 'powershell')
  assert.equal(sealedSwapKind('linux'), 'helper')
  assert.equal(sealedSwapKind('darwin'), 'helper')
})

/* ------------------------------------------------------------------ 空闲改名 */

test('scheduleAsarRenameWhenIdle：缺 exe 或 asar 直接返回，不写锁也不起进程', () => {
  assert.deepEqual(scheduleAsarRenameWhenIdle({}), { pending: false })
  assert.deepEqual(scheduleAsarRenameWhenIdle({ exe: 'C:\\x.exe' }), { pending: false })
  assert.deepEqual(scheduleAsarRenameWhenIdle({ asar: 'C:\\app.asar' }), { pending: false })
})

test('scheduleAsarRenameWhenIdle：30 分钟内的锁算「已经排过队」，不重复起进程', () => {
  const asar = join(sandbox, 'app.asar')
  writeFileSync(asar, 'sealed', 'utf8')
  const lock = asar + '.rename-pending'
  writeFileSync(lock, String(Date.now()) + '\n', 'utf8')
  const oneMinAgo = Math.floor(Date.now() / 1000) - 60
  utimesSync(lock, oneMinAgo, oneMinAgo)
  const before = statSync(lock).mtimeMs
  const out = scheduleAsarRenameWhenIdle({ exe: join(sandbox, 'x.exe'), asar })
  assert.deepEqual(out, { pending: true, already: true })
  /* 既不能改锁内容，也不能删了重写 —— 否则「已排队」会变成「一直排队」。 */
  assert.equal(statSync(lock).mtimeMs, before)
})

test('scheduleAsarRenameWhenIdle：30 分钟以上的锁视为陈旧（会清掉重做）', () => {
  const asar = join(sandbox, 'stale.asar')
  writeFileSync(asar, 'sealed', 'utf8')
  const lock = asar + '.rename-pending'
  writeFileSync(lock, 'old\n', 'utf8')
  const old = (Date.now() - 31 * 60 * 1000) / 1000
  utimesSync(lock, old, old)
  /* 只验证「不返回 already」这一件事：真的起 powershell 会挂 30 分钟，不能在测试里跑。 */
  const before = statSync(lock).mtimeMs
  const out = scheduleAsarRenameWhenIdle({ exe: '', asar })
  assert.deepEqual(out, { pending: false }, '缺 exe 时仍然早返回')
  assert.equal(statSync(lock).mtimeMs, before, '早返回不能顺手把锁删掉')
})
