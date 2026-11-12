/**
 * lib/official-update.js —— 官方客户端升级后的补丁回写标记 + wscript 字面量。
 *
 * 两个坏法都安静：
 *   1. `clearStaleExtractedApps` 在没有 `resources/app` 时就把 `app.dshpurge-prev` 删掉 ——
 *      那份 prev 是 wscript 正搬回来的、或上次崩在 rename 窗口里唯一的完整副本，
 *      抢着删等于把可回滚点清零，之后宿主起不来而日志只说"找不到 main.js"。
 *   2. `wshLiteral` 不把非 ASCII 转成 `\uXXXX` —— wscript 在无 BOM 时按系统 ANSI 读文件，
 *      中文路径变成乱码，重启脚本找不到自己的安装目录，于是"重启成功但补丁没回来"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  clearStaleExtractedApps,
  clearUpgradeMarker,
  isWshAscii,
  upgradeMarkerExists,
  upgradeMarkerPath,
  wshLiteral,
} from '../lib/official-update.js'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpurge-ou-'))
test.after(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发 EPERM */
  }
})

let seq = 0
/** 造一棵 `<install>/<exe>` + `<install>/resources` 的假安装树。 */
function installTree(exe = 'DeepSeek Harness.exe', resources = []) {
  seq += 1
  const dir = path.join(sandbox, `inst-${seq}`)
  const res = path.join(dir, 'resources')
  fs.mkdirSync(res, { recursive: true })
  const exePath = path.join(dir, exe)
  fs.writeFileSync(exePath, '')
  for (const name of resources) {
    if (name.endsWith('/')) fs.mkdirSync(path.join(res, name.slice(0, -1)), { recursive: true })
    else fs.writeFileSync(path.join(res, name), 'x')
  }
  return { dir, res, exe: exePath }
}

/* ------------------------------------------------------------------ *
 * 一、升级标记路径：只有四个可执行名才算「官方桌面壳」
 * ------------------------------------------------------------------ */

test('upgradeMarkerPath：四个官方可执行名都认，且大小写不敏感', () => {
  for (const exe of ['DeepSeek Harness.exe', 'deepseek-harness.exe', 'DSH Next.exe', 'dsh-next.exe']) {
    const p = upgradeMarkerPath(`C:\\Users\\x\\AppData\\Local\\Programs\\DeepSeek Harness\\${exe}`)
    assert.equal(
      p,
      path.join('C:\\Users\\x\\AppData\\Local\\Programs\\DeepSeek Harness', 'resources', 'dsh-purge-reapply-asar'),
      exe,
    )
  }
})

test('upgradeMarkerPath：别的可执行名一律空串（不在别人的安装目录里乱写标记）', () => {
  for (const exe of ['node.exe', 'dsh.exe', 'DeepSeek Harness beta.exe', 'DeepSeekHarness.exe', '', null, undefined]) {
    assert.equal(upgradeMarkerPath(exe), '', String(exe))
  }
})

test('upgradeMarkerExists / clearUpgradeMarker 认的是同一个路径', () => {
  const { exe } = installTree('DeepSeek Harness.exe')
  const marker = upgradeMarkerPath(exe)
  assert.equal(upgradeMarkerExists(exe), false)
  fs.writeFileSync(marker, 'x')
  assert.equal(upgradeMarkerExists(exe), true)
  clearUpgradeMarker(exe)
  assert.equal(fs.existsSync(marker), false, '清掉之后就该没了')
  clearUpgradeMarker(exe)
  assert.equal(upgradeMarkerExists(exe), false, '重复清不算错')
})

test('upgradeMarkerExists / clearUpgradeMarker：非官方可执行名不碰任何文件', () => {
  const { exe } = installTree('node.exe')
  // 同名文件放在 resources 下也不该被当成标记
  fs.writeFileSync(path.join(path.dirname(exe), 'resources', 'dsh-purge-reapply-asar'), 'x')
  assert.equal(upgradeMarkerExists(exe), false, '不是官方壳就没有标记')
  clearUpgradeMarker(exe)
  assert.equal(fs.existsSync(path.join(path.dirname(exe), 'resources', 'dsh-purge-reapply-asar')), true, '不许误删')
})

/* ------------------------------------------------------------------ *
 * 二、清残留解包目录：没有 app 的时候 prev 是唯一的救命副本
 * ------------------------------------------------------------------ */

test('clearStaleExtractedApps：没有 resources/app 时一个 prev 都不删', () => {
  const { res, exe } = installTree('DeepSeek Harness.exe', ['app.dshpurge-prev/', 'app.dshpurge-prev-1700000000/'])
  clearStaleExtractedApps(exe)
  assert.equal(fs.existsSync(path.join(res, 'app.dshpurge-prev')), true, '救命副本不能被抢先删')
  assert.equal(fs.existsSync(path.join(res, 'app.dshpurge-prev-1700000000')), true)
})

test('clearStaleExtractedApps：有 app 时删掉 prev 家族，但只删目录、且名字要对上', () => {
  const { res, exe } = installTree('DeepSeek Harness.exe', [
    'app/',
    'app.dshpurge-prev/',
    'app.dshpurge-prev-1700000000/',
    'app.dshpurge-prev_1.2.3/',
    'app.dshpurge-old/', // 名字不对，不许碰
    'app.dshpurge-prev.txt', // 不是目录，不许碰
    'other/',
  ])
  clearStaleExtractedApps(exe)
  assert.equal(fs.existsSync(path.join(res, 'app.dshpurge-prev')), false)
  assert.equal(fs.existsSync(path.join(res, 'app.dshpurge-prev-1700000000')), false)
  assert.equal(fs.existsSync(path.join(res, 'app.dshpurge-prev_1.2.3')), false)
  assert.equal(fs.existsSync(path.join(res, 'app.dshpurge-old')), true, '名字不匹配的目录不许删')
  assert.equal(fs.existsSync(path.join(res, 'app.dshpurge-prev.txt')), true, '不是目录的不许删')
  assert.equal(fs.existsSync(path.join(res, 'app')), true, '活的 app 当然要留着')
  assert.equal(fs.existsSync(path.join(res, 'other')), true)
})

test('clearStaleExtractedApps：先摘掉旧树里的 runtime 再删整棵树（防 junction 删穿）', () => {
  const { res, exe } = installTree('DeepSeek Harness.exe', ['app/'])
  const prev = path.join(res, 'app.dshpurge-prev')
  fs.mkdirSync(path.join(prev, 'runtime'), { recursive: true })
  fs.writeFileSync(path.join(prev, 'runtime', 'node.exe'), 'x')
  fs.writeFileSync(path.join(prev, 'main.js'), 'x')
  clearStaleExtractedApps(exe)
  assert.equal(fs.existsSync(prev), false)
})

test('clearStaleExtractedApps：符号链接形态的 prev 绝不碰（它可能正指向 resources/runtime）', () => {
  const { res, exe } = installTree('DeepSeek Harness.exe', ['app/', 'runtime/'])
  fs.writeFileSync(path.join(res, 'runtime', 'node.exe'), 'x')
  const prev = path.join(res, 'app.dshpurge-prev')
  let canLink = true
  try {
    fs.symlinkSync(path.join(res, 'runtime'), prev, 'junction')
  } catch {
    canLink = false
  }
  if (!canLink) {
    // 造不出链接的机器上退回源码形状断言：删之前必须同时判 isSymbolicLink 与 isDirectory。
    const src = fs.readFileSync(new URL('../lib/official-update.js', import.meta.url), 'utf8')
    assert.match(src, /if \(st\.isSymbolicLink\(\) \|\| !st\.isDirectory\(\)\) continue;/)
    return
  }
  try {
    clearStaleExtractedApps(exe)
    assert.equal(fs.existsSync(prev), true, 'junction 不许删')
    assert.equal(fs.existsSync(path.join(res, 'runtime', 'node.exe')), true, '链接指向的内容更不能被删穿')
  } finally {
    // 只摘链接本身，绝不 recursive（对 junction 递归会把目标清空）。
    try { fs.unlinkSync(prev) } catch { /* 已经不在了 */ }
  }
})

test('clearStaleExtractedApps：非官方可执行名直接返回，不读目录', () => {
  const { res, exe } = installTree('node.exe', ['app/', 'app.dshpurge-prev/'])
  clearStaleExtractedApps(exe)
  assert.equal(fs.existsSync(path.join(res, 'app.dshpurge-prev')), true)
})

test('clearStaleExtractedApps：resources 读不到时静默返回，不抛', () => {
  seq += 1
  const dir = path.join(sandbox, `bare-${seq}`)
  fs.mkdirSync(dir, { recursive: true })
  const exe = path.join(dir, 'DeepSeek Harness.exe')
  fs.writeFileSync(exe, '')
  assert.doesNotThrow(() => clearStaleExtractedApps(exe))
})

/* ------------------------------------------------------------------ *
 * 三、wscript 字面量：整份脚本必须保持 ASCII
 * ------------------------------------------------------------------ */

test('wshLiteral：纯 ASCII 原样加引号', () => {
  assert.equal(wshLiteral('C:\\Program Files\\DeepSeek Harness'), '"C:\\\\Program Files\\\\DeepSeek Harness"')
  assert.equal(wshLiteral(''), '""')
  assert.equal(wshLiteral(null), '""')
  assert.equal(wshLiteral(undefined), '""')
})

test('wshLiteral：非 ASCII 一律转 \\uXXXX，且转出来真的是 ASCII', () => {
  const out = wshLiteral('C:\\用户\\桌面\\宿主')
  assert.equal(out.includes('用'), false, '不许留原字符')
  assert.match(out, /\\u7528/, '「用」是 U+7528')
  assert.equal(isWshAscii(out), true)
  assert.equal(JSON.parse(out), 'C:\\用户\\桌面\\宿主', '转出来还得能还原成原串')
})

test('wshLiteral：\u007f 以上才算非 ASCII（0x7f 边界）', () => {
  assert.equal(wshLiteral('a\u007e'), '"a\u007e"', '0x7e 留着')
  assert.match(wshLiteral('a\u007f'), /\\u007f/, '0x7f 要转')
})

test('isWshAscii：空串算 ASCII，任意一个超界字符就不算', () => {
  assert.equal(isWshAscii(''), true)
  assert.equal(isWshAscii('abc\r\n\t"\\\\'), true)
  assert.equal(isWshAscii('abc中'), false)
  assert.equal(isWshAscii('abc\u0080'), false)
  assert.equal(isWshAscii(null), true, 'null 当空串')
  assert.equal(isWshAscii(123), true, '数字当 "123"')
})

test('源码形状：标记名与 resources 段都写死在模块顶部，重启脚本按同一个名字找', () => {
  const src = fs.readFileSync(new URL('../lib/official-update.js', import.meta.url), 'utf8')
  assert.match(src, /const MARKER_NAME = "dsh-purge-reapply-asar";/)
  assert.match(src, /path\.join\(path\.dirname\(exe\), "resources", MARKER_NAME\)/)
})
