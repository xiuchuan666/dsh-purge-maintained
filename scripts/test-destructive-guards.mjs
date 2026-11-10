// #195/#196 回归：两处"删/建"路径必须按新契约工作。
//  1) 官方 CLI 启动器要能从零生成（安装包已不下发 runtime\cli\bin）；
//  2) clearStaleExtractedApps 在没有 resources\app 时绝不能把 prev（唯一完整副本）删掉。
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
try {
  // ---- 1) 启动器模板
  const bodies = officialCliShimBodies('DSH NEXT.exe')
  assert.ok(bodies.cmd.includes('REM dsh-purge cli entry begin'), 'cmd needs begin marker')
  assert.ok(bodies.cmd.includes('REM dsh-purge cli entry end'), 'cmd needs end marker')
  assert.ok(bodies.cmd.includes('app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js'))
  assert.ok(bodies.cmd.includes('app.asar.unpacked\\dsh\\node_modules'), 'cmd needs the unpacked fallback')
  assert.ok(bodies.cmd.includes('app\\dsh\\node_modules'), 'cmd needs the app/ fallback')
  assert.ok(bodies.cmd.includes('"%~dp0..\\..\\..\\..\\DSH NEXT.exe" "%entry%" %*'),
    'cmd must launch the exe one level ABOVE resources (4 x ..)')
  assert.ok(bodies.cmd.includes('\r\n'), 'cmd must use CRLF')
  assert.ok(bodies.sh.startsWith('#!/bin/sh'))
  assert.ok(bodies.sh.includes('exec "$(dirname "$resources")/DSH NEXT.exe" "$entry" "$@"'))
  assert.ok(bodies.sh.includes('# dsh-purge cli entry begin'))
  assert.ok(bodies.ps1.includes('$PSScriptRoot'), 'ps1 must resolve resources relative to itself')
  assert.ok(bodies.ps1.includes("& (Join-Path (Split-Path $resources -Parent) 'DSH NEXT.exe') $entry @args"))
  assert.ok(bodies.ps1.includes("@args"), 'ps1 must forward args')
  // 不能出现 "$entry" 字面量：那会让 patchOfficialCliShimText 把 sh 语法塞进 ps1。
  assert.ok(!bodies.ps1.includes('"$entry"'), 'ps1 must not look like a sh shim')

  for (const [name, body] of Object.entries({ dsh: bodies.sh, 'dsh.cmd': bodies.cmd, 'dsh.ps1': bodies.ps1 })) {
    const fp = join(sandbox, name)
    writeFileSync(fp, body)
    assert.equal(desktopCliEntryPatched(fp), true, `${name} must be recognised as patched`)
  }

  // ---- 2) prev 清理守卫
  const install = join(sandbox, 'DeepSeek Harness')
  const resources = join(install, 'resources')
  const exe = join(install, 'DeepSeek Harness.exe')
  const app = join(resources, 'app')
  const prev = join(resources, 'app.dshpurge-prev')
  const prevTs = join(resources, 'app.dshpurge-prev-1700000000000')
  const lookalike = join(resources, 'app.dshpurge-prevold')
  mkdirSync(app, { recursive: true })
  for (const dir of [prev, prevTs, lookalike]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'keep.txt'), 'x')
  }

  // a) app 不见了 → prev 就是唯一副本，一个都不许删
  rmSync(app, { recursive: true, force: true })
  clearStaleExtractedApps(exe)
  for (const dir of [prev, prevTs, lookalike]) {
    assert.ok(existsSync(dir), `must keep ${dir} while resources\\app is gone`)
  }

  // b) app 回来了 → 只回收真正的前缀目录，长得像的（prevold）不动
  mkdirSync(app, { recursive: true })
  clearStaleExtractedApps(exe)
  assert.equal(existsSync(prev), false, 'prev must be reclaimed once app is back')
  assert.equal(existsSync(prevTs), false, 'timestamped prev must be reclaimed')
  assert.equal(existsSync(lookalike), true, 'lookalike directory must be left alone')

  // c) 文件名不是官方宿主 exe 时整个函数不该动手（避免被别的安装目录误触发）
  const foreign = join(sandbox, 'other', 'resources')
  mkdirSync(join(foreign, 'app.dshpurge-prev'), { recursive: true })
  clearStaleExtractedApps(join(sandbox, 'other', 'chrome.exe'))
  assert.ok(existsSync(join(foreign, 'app.dshpurge-prev')), 'non-harness exe must be ignored')

  console.log('destructive guards PASS')
} finally {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* windows 偶发占用 */ }
}
