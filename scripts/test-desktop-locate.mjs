// 桌面端安装目录探测：注册表 / 快捷方式 / 便携 / 进程四条来源的判定链。
//
// 为什么这组必须有测试：探测错了不会报错，只会静默改错文件或者「点了应用没反应」。
// 最贵的一次是 looksLikeDesktopName 的历史 bug —— 它用 includes 匹配祖先目录名，
// 于是 npm 前缀（D:\DeepSeek Harness\npm-global\...）和 DSH_HOME 的父目录
// （D:\DeepSeek Harness\.dsh 的上级）都被当成桌面安装树，findAiBaseWeb 里每一处
// !isInsideDesktopInstall(cand) 守卫都会把正确答案踢掉，Web 面定位不到宿主。
//
// 本文件只用假路径 + 临时目录，不碰本机真实安装，也不执行 powershell：
// registryInstallDirs / runningOfficialExecutables / shortcutOfficialExecutables
// 三条来源靠 input.env 与「非 win32 直接返回空」的短路绕开。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import {
  appAsarPath,
  appDirForExecutable,
  commonDesktopInstallDirs,
  findDesktopAppExecutable,
  inferDesktopInstallDir,
  isAsarSealedPath,
  isDesktopExecutable,
  isInsideDesktopInstall,
  isOfficialHarnessExecutable,
  isSealedRuntimeDir,
  listDesktopInstallRoots,
  listDesktopPackageRoots,
  looksLikeDesktopName,
  looksLikeDesktopNameTail,
  resolveDesktopAiBase,
  resourceDirCandidates,
  resourcesDirForExecutable,
  sealedRuntimeRoots,
} from '../lib/desktop.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dshpurge-locate-'))
test.after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* Windows 偶发 EPERM */ } })

/** 写一个占位文件，返回绝对路径。 */
function put(fp, content = 'x') {
  mkdirSync(join(fp, '..'), { recursive: true })
  writeFileSync(fp, content)
  return fp
}

/** 造一棵完整安装树：<root>/DeepSeek Harness.exe + resources/app/dsh/node_modules/@deepseek-ai。 */
function makeInstall(tag, { exe = 'DeepSeek Harness.exe', aiBase = 'resources/app/dsh/node_modules/@deepseek-ai' } = {}) {
  const root = join(sandbox, tag)
  const exePath = put(join(root, exe), 'MZ')
  const ai = join(root, aiBase)
  mkdirSync(join(ai, 'dsh-agent-instructions', 'lib'), { recursive: true })
  writeFileSync(join(ai, 'dsh-agent-instructions', 'lib', 'index.js'), 'x')
  return { root, exe: exePath, ai }
}

/** 隔离探测面：清空 HOME 相关环境，argv 与 resourcesPath 都给空。 */
function isolatedInput(overrides = {}) {
  return { execPath: join(sandbox, 'node.exe'), resourcesPath: '', argv: [], env: {}, versions: {}, ...overrides }
}

/**
 * 把 home 指到空目录再跑。
 *
 * 为什么必须这么做：`commonDesktopInstallDirs` 用 `os.homedir()` 拼候选，而
 * Windows 上 `os.homedir()` 读 `USERPROFILE`。本机真的装了
 * `%LOCALAPPDATA%\Programs\DeepSeek Harness`，不隔离的话「找不到」这类断言
 * 在本机红、在干净机器绿 —— 反过来也会让「找到了」的断言失去意义。
 */
function withEmptyHome(fn) {
  const home = join(sandbox, 'empty-home')
  mkdirSync(home, { recursive: true })
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.USERPROFILE = home
  process.env.HOME = home
  delete process.env.LOCALAPPDATA
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/* ────────────────────── 名字判定：祖先目录不算安装树 ────────────────────── */

test('安装根目录名本身算桌面安装（尾部那一段）', () => {
  assert.equal(looksLikeDesktopNameTail('C:/Users/x/AppData/Local/Programs/DeepSeek Harness'), true)
  assert.equal(looksLikeDesktopNameTail('C:/Users/x/AppData/Local/Programs/DSH Desktop'), true)
  assert.equal(looksLikeDesktopNameTail('C:/x/DSH NEXT.app'), true)
  assert.equal(looksLikeDesktopNameTail('C:/x/dsh-desktop-next'), true)
  assert.equal(looksLikeDesktopNameTail('C:/x/DeepSeek Bot'), true)
})

test('祖先目录叫 DeepSeek Harness 但自己不是安装根时不算（历史 bug 的回归点）', () => {
  // npm 前缀：D:\DeepSeek Harness\npm-global\node_modules
  assert.equal(looksLikeDesktopNameTail('D:/DeepSeek Harness/npm-global/node_modules'), false)
  // DSH_HOME 的父目录：D:\DeepSeek Harness\.dsh
  assert.equal(looksLikeDesktopNameTail('D:/DeepSeek Harness/.dsh'), false)
  // 同一批输入下老函数会判 true —— 这条断言把「不许退回老写法」钉住
  assert.equal(looksLikeDesktopName('D:/DeepSeek Harness/npm-global/node_modules'), true)
})

test('尾部判定大小写不敏感，且忽略结尾斜杠', () => {
  assert.equal(looksLikeDesktopNameTail('C:/x/deepseek harness/'), true)
  assert.equal(looksLikeDesktopNameTail('C:/x/DEEPSEEK-HARNESS'), true)
  assert.equal(looksLikeDesktopNameTail(''), false)
})

test('isInsideDesktopInstall 不会把 npm 前缀当成桌面安装树', () => {
  // 这是那次 bug 的用户可见表现：Web 面定位不到宿主
  assert.equal(isInsideDesktopInstall('D:/DeepSeek Harness/npm-global/node_modules/@deepseek-ai', isolatedInput()), false)
  assert.equal(isInsideDesktopInstall('D:/DeepSeek Harness/.dsh/plugins', isolatedInput()), false)
})

test('isInsideDesktopInstall 认得真正的安装树内部路径', () => {
  const { root, exe } = makeInstall('inside')
  const input = isolatedInput({ execPath: exe, resourcesPath: join(root, 'resources') })
  assert.equal(isInsideDesktopInstall(join(root, 'resources', 'app', 'dsh'), input), true)
  assert.equal(isInsideDesktopInstall(join(root, 'resources', 'app.asar.unpacked'), input), true)
})

test('isInsideDesktopInstall 对空值与非路径输入返回 false 而不是抛错', () => {
  assert.equal(isInsideDesktopInstall('', isolatedInput()), false)
  assert.equal(isInsideDesktopInstall(null, isolatedInput()), false)
  assert.equal(isInsideDesktopInstall(undefined, isolatedInput()), false)
})

/* ────────────────────── 可执行文件判定 ────────────────────── */

test('isDesktopExecutable 认社区桌面、官方宿主、bot 三类 exe', () => {
  assert.equal(isDesktopExecutable('C:/x/DSH Desktop.exe'), true)
  assert.equal(isDesktopExecutable('C:/x/DSH NEXT.exe'), true)
  assert.equal(isDesktopExecutable('C:/x/DeepSeek Harness.exe'), true)
  assert.equal(isDesktopExecutable('C:/x/deepseek-harness.exe'), true)
  assert.equal(isDesktopExecutable('C:/x/DeepSeek Bot.exe'), true)
  assert.equal(isDesktopExecutable('C:/x/node.exe'), false)
  assert.equal(isDesktopExecutable(''), false)
})

test('isOfficialHarnessExecutable 只认官方与 DSH NEXT，不认第三方 DSH Desktop', () => {
  // 这条差别决定要不要走 asar 交换：第三方 DSH Desktop 没有 asar，走错就卡住
  assert.equal(isOfficialHarnessExecutable('C:/x/DSH Desktop.exe'), false)
  assert.equal(isOfficialHarnessExecutable('C:/x/DSH NEXT.exe'), true)
  assert.equal(isOfficialHarnessExecutable('C:/x/DeepSeek Harness.exe'), true)
  assert.equal(isOfficialHarnessExecutable('C:/x/deepseek-harness.exe'), true)
})

test('isAsarSealedPath 只把 app.asar 里面当封存路径，app.asar 文件与 unpacked 都不算', () => {
  assert.equal(isAsarSealedPath('C:/r/app.asar/dsh/lib/index.js'), true)
  assert.equal(isAsarSealedPath('C:/r/app.asar'), false)
  assert.equal(isAsarSealedPath('C:/r/app.asar.unpacked/dsh/lib/index.js'), false)
  assert.equal(isAsarSealedPath('C:/r/app/dsh/lib/index.js'), false)
})

/* ────────────────────── resources / 安装目录反推 ────────────────────── */

test('inferDesktopInstallDir 从三种结构标记反推安装根', () => {
  assert.equal(inferDesktopInstallDir('C:/x/DeepSeek Harness/resources/app/dsh/node_modules'), normalize('C:/x/DeepSeek Harness'))
  assert.equal(inferDesktopInstallDir('C:/x/DeepSeek Harness/resources/app.asar.unpacked/dsh'), normalize('C:/x/DeepSeek Harness'))
  // .app 包：`/resources/app/` 先命中，所以拿回来的是 Contents 这一级（现状锁定）。
  // 这一级的父目录就是 .app，调用方（packageRootsFromInstall）再用 resourceDirCandidates 展开。
  assert.equal(inferDesktopInstallDir('C:/x/App.app/Contents/Resources/app/dsh'), normalize('C:/x/App.app/Contents'))
})

test('inferDesktopInstallDir 对不含标记的路径返回空串', () => {
  assert.equal(inferDesktopInstallDir('C:/x/npm-global/node_modules/@deepseek-ai'), '')
  assert.equal(inferDesktopInstallDir(''), '')
  // 标记在开头（i <= 0）不算：没有安装根可言
  assert.equal(inferDesktopInstallDir('/resources/app/dsh'), '')
})

test('resourceDirCandidates 按 macOS 结构 / .app 包 / 普通目录分别给候选', () => {
  assert.deepEqual(resourceDirCandidates('C:/x/App.app/Contents/MacOS'), [
    normalize('C:/x/App.app/Contents/Resources'),
    normalize('C:/x/App.app/Contents/resources'),
  ])
  assert.deepEqual(resourceDirCandidates('C:/x/App.app'), [
    normalize('C:/x/App.app/Contents/Resources'),
    normalize('C:/x/App.app/Contents/resources'),
  ])
  assert.deepEqual(resourceDirCandidates('C:/x/DeepSeek Harness'), [
    normalize('C:/x/DeepSeek Harness/resources'),
    normalize('C:/x/DeepSeek Harness/Resources'),
  ])
  assert.deepEqual(resourceDirCandidates(''), [])
})

test('resourcesDirForExecutable 优先有 app.asar 的那份，其次已存在的目录', () => {
  const { root, exe } = makeInstall('resdir')
  put(join(root, 'resources', 'app.asar'), 'asar')
  assert.equal(resourcesDirForExecutable(exe), normalize(join(root, 'resources')))
  assert.equal(appAsarPath(exe), normalize(join(root, 'resources', 'app.asar')))
  assert.equal(appDirForExecutable(exe), normalize(join(root, 'resources', 'app')))
})

test('resourcesDirForExecutable 没有 app.asar 时退到已存在目录，再退到首个候选', () => {
  const { root, exe } = makeInstall('resdir2')
  // 只有小写 resources 存在
  assert.equal(resourcesDirForExecutable(exe), normalize(join(root, 'resources')))
  // exe 在完全空目录里：候选一个都不存在，返回首个候选而不是空串
  const bare = join(sandbox, 'bare', 'App.exe')
  put(bare, 'MZ')
  assert.equal(resourcesDirForExecutable(bare), normalize(join(sandbox, 'bare', 'resources')))
})

test('resourcesDirForExecutable 传空串时返回相对 junk 路径（现状锁定，调用方必须先判 exe）', () => {
  // `path.dirname("")` 是 "."，于是它返回 "./resources" 这种相对路径。
  // 这不是期望行为，但改成空串会影响 core.js 里若干 `desktop.appAsarPath(exe)` 的
  // 调用形状，而所有调用点本来就写了 `exe ? ... : ""`。这里锁住现状，防止有人
  // 顺手改成抛错，让空 exe 从「无害 junk」变成「崩」。
  assert.equal(resourcesDirForExecutable(''), normalize('resources'))
  assert.equal(appAsarPath(''), normalize(join('resources', 'app.asar')))
})

/* ────────────────────── 安装根候选 ────────────────────── */

test('listDesktopInstallRoots 从 execPath 得到安装根', () => {
  const { root, exe } = makeInstall('roots-exe')
  assert.deepEqual(listDesktopInstallRoots(isolatedInput({ execPath: exe })), [normalize(root)])
})

test('listDesktopInstallRoots 从 resourcesPath 展开 resources / 安装根 / app / unpacked', () => {
  const { root } = makeInstall('roots-res')
  const resources = join(root, 'resources')
  const roots = listDesktopInstallRoots(isolatedInput({ resourcesPath: resources }))
  assert.deepEqual(roots, [
    normalize(resources),
    normalize(root),
    normalize(join(resources, 'app')),
    normalize(join(resources, 'app.asar.unpacked')),
  ])
})

test('listDesktopInstallRoots 从 host-process-entry 的 argv 反推四层目录', () => {
  const { root } = makeInstall('roots-argv')
  const script = put(join(root, 'resources', 'app', 'lib', 'host-process-entry.js'), 'js')
  const roots = listDesktopInstallRoots(isolatedInput({ argv: [script] }))
  assert.ok(roots.includes(normalize(root)), `期望包含安装根，实得 ${JSON.stringify(roots)}`)
  assert.ok(roots.includes(normalize(join(root, 'resources', 'app'))))
})

test('listDesktopInstallRoots 忽略不可信的 DSH_DESKTOP_INSTALL，认可信的', () => {
  const { root } = makeInstall('roots-env')
  const env = { DSH_DESKTOP_INSTALL: ['C:/totally/random', root].join(process.platform === 'win32' ? ';' : ':') }
  const roots = listDesktopInstallRoots(isolatedInput({ env }))
  assert.deepEqual(roots, [normalize(root)])
})

test('listDesktopInstallRoots 在什么都没有时返回空数组', () => {
  assert.deepEqual(listDesktopInstallRoots(isolatedInput()), [])
})

/* ────────────────────── 包根与 aiBase ────────────────────── */

test('listDesktopPackageRoots 从 resourcesPath 找到 aiBase（要求 dsh-agent-instructions/lib）', () => {
  const { root, ai } = makeInstall('pkg-res')
  const roots = listDesktopPackageRoots(isolatedInput({ resourcesPath: join(root, 'resources') }))
  assert.deepEqual(roots, [normalize(ai)])
  assert.equal(resolveDesktopAiBase(isolatedInput({ resourcesPath: join(root, 'resources') })), normalize(ai))
})

test('listDesktopPackageRoots 认得 app.asar.unpacked 与不带 dsh/ 一层的布局', () => {
  const a = makeInstall('pkg-unpacked', { aiBase: 'resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai' })
  assert.deepEqual(
    listDesktopPackageRoots(isolatedInput({ resourcesPath: join(a.root, 'resources') })),
    [normalize(a.ai)],
  )
  const b = makeInstall('pkg-flat', { aiBase: 'resources/app/node_modules/@deepseek-ai' })
  assert.deepEqual(
    listDesktopPackageRoots(isolatedInput({ resourcesPath: join(b.root, 'resources') })),
    [normalize(b.ai)],
  )
})

test('listDesktopPackageRoots 在装了两个客户端时只认当前 exe 那一份', () => {
  const mine = makeInstall('pkg-mine')
  const other = makeInstall('pkg-other')
  const base = {
    execPath: mine.exe,
    resourcesPath: join(mine.root, 'resources'),
    env: { DSH_DESKTOP_INSTALL: other.root },
  }
  // 廉价路径（discover 未开）
  assert.deepEqual(listDesktopPackageRoots(isolatedInput(base)), [normalize(mine.ai)])
  // discover 路径：这里才会去查注册表 / 进程 / 快捷方式，也正是最容易把旁边那份客户端
  // 一起带上的地方 —— 「点应用改了别人家安装」就是这么来的。
  assert.deepEqual(listDesktopPackageRoots(isolatedInput({ ...base, discover: true })), [normalize(mine.ai)])
})

test('resolveDesktopAiBase 找不到时返回 null 而不是空串或抛错', () => {
  withEmptyHome(() => {
    assert.equal(resolveDesktopAiBase(isolatedInput()), null)
  })
})

/* ────────────────────── findDesktopAppExecutable ────────────────────── */

test('findDesktopAppExecutable 认得自身就是桌面 exe 的进程', () => {
  const { exe } = makeInstall('find-self')
  assert.equal(findDesktopAppExecutable(isolatedInput({ execPath: exe })), normalize(exe))
})

test('findDesktopAppExecutable 从 resourcesPath 旁找 exe', () => {
  const { root, exe } = makeInstall('find-res')
  assert.equal(
    findDesktopAppExecutable(isolatedInput({ resourcesPath: join(root, 'resources') })),
    normalize(exe),
  )
})

test('findDesktopAppExecutable 从 host-process-entry argv 旁找 exe', () => {
  const { root, exe } = makeInstall('find-argv')
  const script = put(join(root, 'resources', 'app', 'lib', 'host-process-entry.js'), 'js')
  assert.equal(findDesktopAppExecutable(isolatedInput({ argv: [script] })), normalize(exe))
})

test('findDesktopAppExecutable 找不到时返回空串（调用方据此判断「没有桌面端」）', () => {
  withEmptyHome(() => {
    assert.equal(findDesktopAppExecutable(isolatedInput()), '')
  })
})

/* ────────────────────── 常见安装位置 ────────────────────── */

test('commonDesktopInstallDirs 按 LOCALAPPDATA / ProgramFiles / ProgramFiles(x86) 展开四个产品名', () => {
  const dirs = commonDesktopInstallDirs({
    LOCALAPPDATA: 'C:/Users/x/AppData/Local',
    ProgramFiles: 'C:/PF',
    'ProgramFiles(x86)': 'C:/PF86',
  }, {})
  for (const name of ['DeepSeek Harness', 'DSH Desktop', 'DSH NEXT', 'DeepSeek Bot']) {
    assert.ok(dirs.includes(normalize(`C:/Users/x/AppData/Local/Programs/${name}`)), `缺 LOCALAPPDATA/${name}`)
    assert.ok(dirs.includes(normalize(`C:/PF/${name}`)), `缺 ProgramFiles/${name}`)
    assert.ok(dirs.includes(normalize(`C:/PF86/${name}`)), `缺 ProgramFiles(x86)/${name}`)
  }
})

test('commonDesktopInstallDirs 不扫整盘：只列常见位置，数量可控', () => {
  const dirs = commonDesktopInstallDirs({ LOCALAPPDATA: 'C:/L', ProgramFiles: 'C:/PF' }, {})
  // 33 = 4 env 空 + 4 LOCALAPPDATA + 4 LOCALAPPDATA 裸 + 4 PF + 4 macOS /Applications
  //      + 4 ~/Applications + 5 /opt /usr/lib /usr/share + 2 ~/.local/share + 2 其它
  assert.ok(dirs.length <= 40, `候选数不该膨胀，实得 ${dirs.length}`)
  assert.equal(new Set(dirs).size, dirs.length, '候选里不该有重复')
})

test('commonDesktopInstallDirs 只在 discover 时才查注册表 / 进程 / 快捷方式', () => {
  // 启动自愈路径（discover 未开）必须廉价：这里只验它不因为 discover 缺省而改变形状
  const cheap = commonDesktopInstallDirs({ LOCALAPPDATA: 'C:/L' }, {})
  const discover = commonDesktopInstallDirs({ LOCALAPPDATA: 'C:/L' }, { discover: true })
  assert.ok(discover.length >= cheap.length)
})

/* ────────────────────── 封存运行时 ────────────────────── */

test('isSealedRuntimeDir 只认产品目录下的 bin 尾巴', () => {
  assert.equal(isSealedRuntimeDir('C:/Users/x/AppData/Roaming/DSH Desktop/host-commands/bin'), true)
  assert.equal(isSealedRuntimeDir('C:/Users/x/AppData/Local/DeepSeek Harness/runtime-commands/bin'), true)
  assert.equal(isSealedRuntimeDir('C:/foo/bin'), false)
  // 不是 bin 结尾一律不算
  assert.equal(isSealedRuntimeDir('C:/Users/x/AppData/Roaming/DSH Desktop/host-commands'), false)
  assert.equal(isSealedRuntimeDir(''), false)
})

test('sealedRuntimeRoots 覆盖换过名字的五个产品目录，且去重', () => {
  const roots = sealedRuntimeRoots({ APPDATA: 'C:/A', LOCALAPPDATA: 'C:/L' })
  for (const name of ['DSH Desktop', 'DSH NEXT', 'dsh-desktop-next', 'dsh-app', 'DeepSeek Harness']) {
    assert.ok(roots.includes(normalize(`C:/A/${name}/host-commands`)), `缺 APPDATA/${name}/host-commands`)
    assert.ok(roots.includes(normalize(`C:/L/${name}/runtime-commands`)), `缺 LOCALAPPDATA/${name}/runtime-commands`)
  }
  assert.equal(new Set(roots).size, roots.length, '不该有重复')
})
