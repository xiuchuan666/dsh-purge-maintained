// #195/#196 回归：两处"删/建"路径必须按新契约工作。
//  1) 官方 CLI 启动器要能从零生成（安装包已不下发 runtime\cli\bin）；
//  2) clearStaleExtractedApps 在没有 resources\app 时绝不能把 prev（唯一完整副本）删掉。
//
// 第二条尤其不能只看到「第一处失败」：这里一旦判错，用户丢的是唯一能回退的
// 完整副本。所以守卫的三个分支（唯一副本 / 已恢复 / 非官方 exe）必须是三条
// 独立用例，任意一条红都要能单独看见。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { officialCliShimBodies, desktopCliEntryPatched } = await import(
  new URL('../lib/desktop.js', import.meta.url).href
)
const { clearStaleExtractedApps } = await import(
  new URL('../lib/official-update.js', import.meta.url).href
)

const sandbox = mkdtempSync(join(tmpdir(), 'dshpurge-guards-'))

test.after(() => {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* windows 偶发占用 */ }
})

// ---------------------------------------------------------------- 1) 启动器模板

test('cmd 模板：三段路径回退、标记、CRLF、以及「exe 在 resources 上一级」', () => {
  const bodies = officialCliShimBodies('DSH NEXT.exe')
  assert.ok(bodies.cmd.includes('REM dsh-purge cli entry begin'), 'cmd needs begin marker')
  assert.ok(bodies.cmd.includes('REM dsh-purge cli entry end'), 'cmd needs end marker')
  assert.ok(bodies.cmd.includes('app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js'))
  assert.ok(bodies.cmd.includes('app.asar.unpacked\\dsh\\node_modules'), 'cmd needs the unpacked fallback')
  assert.ok(bodies.cmd.includes('app\\dsh\\node_modules'), 'cmd needs the app/ fallback')
  assert.ok(bodies.cmd.includes('"%~dp0..\\..\\..\\..\\DSH NEXT.exe" "%entry%" %*'),
    'cmd must launch the exe one level ABOVE resources (4 x ..)')
  assert.ok(bodies.cmd.includes('\r\n'), 'cmd must use CRLF')
})

test('sh 模板：shebang、标记、exec 到上一级 exe', () => {
  const bodies = officialCliShimBodies('DSH NEXT.exe')
  assert.ok(bodies.sh.startsWith('#!/bin/sh'))
  assert.ok(bodies.sh.includes('exec "$(dirname "$resources")/DSH NEXT.exe" "$entry" "$@"'))
  assert.ok(bodies.sh.includes('# dsh-purge cli entry begin'))
})

test('ps1 模板：自己定位 resources、转发 @args，且不能长得像 sh', () => {
  const bodies = officialCliShimBodies('DSH NEXT.exe')
  assert.ok(bodies.ps1.includes('$PSScriptRoot'), 'ps1 must resolve resources relative to itself')
  assert.ok(bodies.ps1.includes("& (Join-Path (Split-Path $resources -Parent) 'DSH NEXT.exe') $entry @args"))
  assert.ok(bodies.ps1.includes('@args'), 'ps1 must forward args')
  // 不能出现 "$entry" 字面量：那会让 patchOfficialCliShimText 把 sh 语法塞进 ps1。
  assert.ok(!bodies.ps1.includes('"$entry"'), 'ps1 must not look like a sh shim')
})

test('三份生成的启动器都能被 desktopCliEntryPatched 认成「已打过补丁」', () => {
  const bodies = officialCliShimBodies('DSH NEXT.exe')
  for (const [name, body] of Object.entries({ dsh: bodies.sh, 'dsh.cmd': bodies.cmd, 'dsh.ps1': bodies.ps1 })) {
    const fp = join(sandbox, name)
    writeFileSync(fp, body)
    assert.equal(desktopCliEntryPatched(fp), true, `${name} must be recognised as patched`)
  }
})

// ---------------------------------------------------------------- 2) prev 清理守卫

/** 造一套安装目录：app 存在与否由调用方决定。 */
function makeInstall(tag, { withApp }) {
  const install = join(sandbox, tag, 'DeepSeek Harness')
  const resources = join(install, 'resources')
  const exe = join(install, 'DeepSeek Harness.exe')
  if (withApp) mkdirSync(join(resources, 'app'), { recursive: true })
  else mkdirSync(resources, { recursive: true })
  return { install, resources, exe }
}

function seedPrevDirs(resources) {
  const prev = join(resources, 'app.dshpurge-prev')
  const prevTs = join(resources, 'app.dshpurge-prev-1700000000000')
  const lookalike = join(resources, 'app.dshpurge-prevold')
  for (const dir of [prev, prevTs, lookalike]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'keep.txt'), 'x')
  }
  return { prev, prevTs, lookalike }
}

test('resources/app 不见了：prev 是唯一副本，一个都不许删', () => {
  const { resources, exe } = makeInstall('gone-app', { withApp: true })
  const dirs = seedPrevDirs(resources)
  rmSync(join(resources, 'app'), { recursive: true, force: true })

  clearStaleExtractedApps(exe)

  for (const dir of Object.values(dirs)) {
    assert.ok(existsSync(dir), `must keep ${dir} while resources/app is gone`)
  }
})

test('app 回来了：只回收真正的前缀目录，长得像的不动', () => {
  const { resources, exe } = makeInstall('app-back', { withApp: true })
  const dirs = seedPrevDirs(resources)

  clearStaleExtractedApps(exe)

  assert.equal(existsSync(dirs.prev), false, 'prev must be reclaimed once app is back')
  assert.equal(existsSync(dirs.prevTs), false, 'timestamped prev must be reclaimed')
  assert.equal(existsSync(dirs.lookalike), true, 'lookalike directory must be left alone')
})

test('exe 不是官方宿主名：整个函数不该动手', () => {
  const other = join(sandbox, 'foreign', 'resources')
  mkdirSync(join(other, 'app'), { recursive: true })
  mkdirSync(join(other, 'app.dshpurge-prev'), { recursive: true })

  clearStaleExtractedApps(join(sandbox, 'foreign', 'chrome.exe'))

  assert.ok(existsSync(join(other, 'app.dshpurge-prev')), 'non-harness exe must be ignored')
})
