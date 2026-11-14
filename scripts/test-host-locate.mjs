// 宿主树 / 主目录定位的纯路径判定簇（批75）。
//
// 这一簇回答的是整个插件最要紧的一个问题：**补丁该打到哪棵树上、配置该读哪个主目录**。
// 判错的两种表现都不报错：①打到 Electron 外壳那份 `resources/app/node_modules/@deepseek-ai`
// （喂 `targetFiles()` 返回 0 文件，全场 no-file，看着像"补丁都不兼容"）；②把
// `~/.dsh` 认成桌面版真正在用的 `dsh-home`（写进去的 prompt-inject 永远不生效）。
//
// 全部用例都在临时目录里造树，不碰真实安装；`findDshHome` 一律显式传 `shimDir` /
// `prefix`，避免走到 `findShimDir()` / `findNpmPrefix()` 去扫真机。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import * as core from '../lib/core.js'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-host-locate-'))

function mk(p) {
  fs.mkdirSync(p, { recursive: true })
  return p
}
function put(p, text = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}
/** 造一棵"看起来像宿主"的树：必须含 `<base>/dsh-agent-instructions/lib`。 */
function hostTree(base) {
  mk(path.join(base, 'dsh-agent-instructions', 'lib'))
  return base
}
/** 造一个 pnpm 项目根：<ROOT>/<tag>/node_modules/.modules.yaml，返回 <ROOT>/<tag>。 */
function projOf(tag, yaml) {
  return path.dirname(path.dirname(put(path.join(ROOT, tag, 'node_modules', '.modules.yaml'), yaml)))
}
const rel = (p) => (p === null || p === undefined ? p : String(p).replace(ROOT, '$R').replace(/\\/g, '/'))

const ENV_KEYS = ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'DSH_SURFACE']
const ORIG_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

test.after(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 })
})

// ── 一、判据本身 ─────────────────────────────────────────────

test('isAiBase：只认「直接含 dsh-agent-instructions/lib」的目录，空值与 null 不抛', () => {
  const good = hostTree(path.join(ROOT, 'isbase', 'node_modules', '@deepseek-ai'))
  const noLib = mk(path.join(ROOT, 'isbase', 'node_modules', 'other', '@deepseek-ai'))
  mk(path.join(noLib, 'dsh-agent-instructions')) // 少了 lib 这一级
  assert.equal(core.isAiBase(good), true)
  assert.equal(core.isAiBase(noLib), false)
  assert.equal(core.isAiBase(path.join(ROOT, 'isbase')), false)
  assert.equal(Boolean(core.isAiBase('')), false)
  assert.equal(Boolean(core.isAiBase(null)), false)
  assert.equal(Boolean(core.isAiBase(undefined)), false)
})

test('isAiBase 对文件不认：同名文件冒充目录必须判 false', () => {
  const fake = path.join(ROOT, 'isbase', 'file-as-base')
  mk(fake)
  put(path.join(fake, 'dsh-agent-instructions'))
  assert.equal(core.isAiBase(fake), false)
})

test('isAiBase：父目录对、但 lib 这一级是文件时仍需 false（判据落在最末一级目录）', () => {
  const fake = path.join(ROOT, 'isbase', 'lib-as-file')
  put(path.join(fake, 'dsh-agent-instructions', 'lib'))
  assert.equal(core.isAiBase(fake), false)
})

test('firstAiBase：按顺序取第一个命中，返回值是 normalize 过的路径；全不命中回 null', () => {
  const good = hostTree(path.join(ROOT, 'first', 'ai'))
  assert.equal(core.firstAiBase([path.join(ROOT, 'first', 'nope'), good]), path.normalize(good))
  // 带 `..` 的候选要被 normalize 掉，否则下游拼路径会拼出两种写法、缓存键不相等
  assert.equal(core.firstAiBase([path.join(ROOT, 'first', 'x', '..', 'ai')]), path.normalize(good))
  // 顺序敏感：两棵树都在时，先给的那棵优先（否则等于在赌 readdir 顺序）
  const good2 = hostTree(path.join(ROOT, 'first', 'ai2'))
  assert.equal(core.firstAiBase([good, good2]), path.normalize(good))
  assert.equal(core.firstAiBase([good2, good]), path.normalize(good2))
  // 空候选要被跳过，不能当成「到此为止」——注册表里混一个空串不该让整条链作废
  assert.equal(core.firstAiBase(['', null, good]), path.normalize(good))
  assert.equal(core.firstAiBase([]), null)
  assert.equal(core.firstAiBase([null, '', undefined]), null)
})

test('nestedAiPath：嵌套安装的固定形状 @deepseek-ai/dsh/node_modules/@deepseek-ai', () => {
  assert.equal(core.nestedAiPath().replace(/\\/g, '/'), '@deepseek-ai/dsh/node_modules/@deepseek-ai')
})

// ── 二、pnpm 判定 ────────────────────────────────────────────

test('isPnpmNodeModules：.modules.yaml 或 .pnpm 任一存在即 pnpm，普通 node_modules 不算', () => {
  const withYaml = path.dirname(put(path.join(ROOT, 'pnpm1', 'node_modules', '.modules.yaml'), 'storeDir: x\n'))
  const withPnpm = path.dirname(mk(path.join(ROOT, 'pnpm2', 'node_modules', '.pnpm')))
  const plain = mk(path.join(ROOT, 'pnpm3', 'node_modules'))
  assert.equal(core.isPnpmNodeModules(withYaml), true)
  assert.equal(core.isPnpmNodeModules(withPnpm), true)
  assert.equal(core.isPnpmNodeModules(plain), false)
  assert.equal(core.isPnpmNodeModules(path.join(ROOT, 'pnpm-missing')), false)
  assert.equal(core.isPnpmNodeModules(''), false)
})

test('pnpmVirtualStoreDir：相对路径按「项目根」拼（不是 node_modules），且 .modules.yaml 优先于 .pnpm 目录', () => {
  const proj = projOf('vsd1', 'virtualStoreDir: node_modules/.pnpm\n')
  mk(path.join(proj, 'node_modules', '.pnpm'))
  assert.equal(core.pnpmVirtualStoreDir(proj), path.normalize(path.join(proj, 'node_modules', '.pnpm')))
  // 相对路径拼到 root 上，不是 root/node_modules 上 —— 写成后者会让 store 指到不存在的目录
  const proj2 = projOf('vsd2', 'virtualStoreDir: .store\n')
  assert.equal(core.pnpmVirtualStoreDir(proj2), path.normalize(path.join(proj2, '.store')))
})

test('pnpmVirtualStoreDir：绝对路径原样 normalize，引号与尾注释都要剥掉', () => {
  const absTarget = path.join(ROOT, 'vsd3', 'store-abs')
  const proj = put(
    path.join(ROOT, 'vsd3', 'node_modules', '.modules.yaml'),
    `virtualStoreDir: "${absTarget.replace(/\\/g, '/')}"   # pnpm 会带尾注释\n`,
  ).replace(/[/\\]node_modules[/\\]\.modules\.yaml$/, '')
  assert.equal(core.pnpmVirtualStoreDir(proj), path.normalize(absTarget))
  const proj2 = put(path.join(ROOT, 'vsd4', 'node_modules', '.modules.yaml'), "virtualStoreDir: '.pnpm-q'\n").replace(/[/\\]node_modules[/\\]\.modules\.yaml$/, '')
  assert.equal(core.pnpmVirtualStoreDir(proj2), path.normalize(path.join(proj2, '.pnpm-q')))
})

test('pnpmVirtualStoreDir：没有 virtualStoreDir 键时回退 node_modules/.pnpm；连 .pnpm 也没有回 null', () => {
  const withFallback = projOf('vsd5', 'storeDir: .pnpm-store\n')
  mk(path.join(withFallback, 'node_modules', '.pnpm'))
  assert.equal(core.pnpmVirtualStoreDir(withFallback), path.normalize(path.join(withFallback, 'node_modules', '.pnpm')))
  const noFallback = projOf('vsd6', 'storeDir: .pnpm-store\n')
  assert.equal(core.pnpmVirtualStoreDir(noFallback), null)
})

test('pnpmVirtualStoreDir：.modules.yaml 读不出来（目录冒充）时也回退 .pnpm，不抛', () => {
  const proj = path.join(ROOT, 'vsd7')
  mk(path.join(proj, 'node_modules', '.modules.yaml'))
  mk(path.join(proj, 'node_modules', '.pnpm'))
  assert.equal(core.pnpmVirtualStoreDir(proj), path.normalize(path.join(proj, 'node_modules', '.pnpm')))
})

test('pnpmVirtualStoreDir：非 pnpm 项目与 null/空串一律 null（不能凭 node_modules 存在就猜）', () => {
  const plain = mk(path.join(ROOT, 'vsd8', 'node_modules'))
  assert.equal(core.pnpmVirtualStoreDir(path.join(ROOT, 'vsd8')), null)
  assert.equal(core.pnpmVirtualStoreDir(path.join(ROOT, 'vsd8', 'node_modules', 'x')), null)
  assert.equal(core.pnpmVirtualStoreDir(null), null)
  assert.equal(core.pnpmVirtualStoreDir(''), null)
  assert.ok(plain)
})

test('pnpmProjectRootNear：从任何一层往上找 pnpm 项目根，最多 4 层；base 本身是 node_modules 时回它的父级', () => {
  const proj = projOf('near', 'virtualStoreDir: node_modules/.pnpm\n')
  assert.equal(core.pnpmProjectRootNear(proj), path.normalize(proj))
  assert.equal(core.pnpmProjectRootNear(path.join(proj, 'node_modules')), path.normalize(proj))
  assert.equal(core.pnpmProjectRootNear(path.join(proj, 'node_modules', '@deepseek-ai', 'dsh', 'lib')), path.normalize(proj))
  assert.equal(core.pnpmProjectRootNear(path.join(ROOT, 'near-plain', 'node_modules')), null)
  assert.equal(core.pnpmProjectRootNear(null), null)
})

test('pnpmProjectRootNear 的四层上限：第 5 层才遇到 pnpm 时回 null', () => {
  const proj = projOf('near2', 'virtualStoreDir: node_modules/.pnpm\n')
  const deep = mk(path.join(proj, 'a', 'b', 'c', 'd', 'e'))
  assert.equal(core.pnpmProjectRootNear(deep), null)
  assert.equal(core.pnpmProjectRootNear(mk(path.join(proj, 'a', 'b', 'c'))), path.normalize(proj))
})

test('pnpmHoistAiBases：命中时给「虚拟库里的 @deepseek-ai」，非 pnpm 与 null 给空数组', () => {
  const proj = projOf('hoist', 'virtualStoreDir: node_modules/.pnpm\n')
  const storeAi = mk(path.join(proj, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai'))
  assert.deepEqual(core.pnpmHoistAiBases(proj).map(rel), [rel(storeAi)])
  assert.deepEqual(core.pnpmHoistAiBases(path.join(ROOT, 'hoist-plain')), [])
  // 注意：不能拿 hoist/plain —— 往上走会撞到 hoist 这个 pnpm 根，pnpmProjectRootNear 是对的
  assert.deepEqual(core.pnpmHoistAiBases(path.join(ROOT, 'hoist', 'plain')), [path.normalize(storeAi)])
  assert.deepEqual(core.pnpmHoistAiBases(null), [])
})

// ── 三、候选路径表 ───────────────────────────────────────────

test('aiBaseGuessesAround：11 个候选，顺序是「自己 → 自己 node_modules → 自己 dsh/node_modules → 上两层」', () => {
  const dir = path.join(ROOT, 'guess', 'x')
  const got = core.aiBaseGuessesAround(dir).map(rel)
  assert.equal(got.length, 10)
  assert.equal(got[0], rel(dir))
  assert.equal(got[1], rel(path.join(dir, '@deepseek-ai')))
  assert.equal(got[2], rel(path.join(dir, 'node_modules', '@deepseek-ai')))
  assert.equal(got[3], rel(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')))
  assert.equal(got[4], rel(path.join(dir, 'dsh', 'node_modules', '@deepseek-ai')))
  assert.equal(got[6], rel(path.join(dir, '..', 'node_modules', '@deepseek-ai')))
  assert.equal(got[8], rel(path.join(dir, '..', '..', 'node_modules', '@deepseek-ai')))
})

test('aiBaseGuessesAround：空串与 null 回空数组（不抛、也不返回 [null]）', () => {
  assert.deepEqual(core.aiBaseGuessesAround(''), [])
  assert.deepEqual(core.aiBaseGuessesAround(null), [])
})

test('aiBaseGuessesFor：7 个候选，第一项是 base 自己的 node_modules 嵌套路径', () => {
  const base = path.join(ROOT, 'guessfor')
  const got = core.aiBaseGuessesFor(base).map(rel)
  assert.equal(got.length, 6)
  assert.equal(got[0], rel(path.join(base, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')))
  assert.equal(got[2], rel(path.join(base, 'node_modules', '@deepseek-ai')))
  assert.equal(got[4], rel(path.join(base, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')))
})

test('aiBaseGuessesFor：空串与 null 回空数组', () => {
  assert.deepEqual(core.aiBaseGuessesFor(''), [])
  assert.deepEqual(core.aiBaseGuessesFor(null), [])
})

test('walkAncestorsForAiBase：向上逐层找，命中就返回；一层都没有回 null', () => {
  const ai = hostTree(path.join(ROOT, 'walk', 'node_modules', '@deepseek-ai'))
  const start = mk(path.join(ROOT, 'walk', 'A', 'B', 'C', 'lib'))
  // 从 C/lib 出发：i=0 覆盖 lib/..（C）与 C/..（B），i=1 覆盖 B/..（A），i=2 才到 walk/
  assert.equal(core.walkAncestorsForAiBase(start, 3), path.normalize(ai))
  assert.equal(core.walkAncestorsForAiBase(start, 2), null)
  assert.equal(core.walkAncestorsForAiBase(path.join(ROOT, 'walk-nowhere')), null)
})

test('walkAncestorsForAiBase：maxUp 缺省 10 层够用，且 0 层时直接 null', () => {
  const ai = hostTree(path.join(ROOT, 'walk2', 'node_modules', '@deepseek-ai'))
  const start = mk(path.join(ROOT, 'walk2', 'a', 'b', 'c', 'd', 'e'))
  assert.equal(core.walkAncestorsForAiBase(start, 0), null)
  assert.equal(core.walkAncestorsForAiBase(start), path.normalize(ai))
})

// ── 四、按主目录找宿主树 ────────────────────────────────────

test('findAiBaseFromDshHome：直接 node_modules/@deepseek-ai 命中', () => {
  const home = path.join(ROOT, 'fh1')
  const ai = hostTree(path.join(home, 'node_modules', '@deepseek-ai'))
  assert.equal(core.findAiBaseFromDshHome(home), path.normalize(ai))
})

test('findAiBaseFromDshHome：嵌套安装 node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai 命中', () => {
  const home = path.join(ROOT, 'fh2')
  const ai = hostTree(path.join(home, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  assert.equal(core.findAiBaseFromDshHome(home), path.normalize(ai))
})

test('findAiBaseFromDshHome：profiles/<名>/node_modules/@deepseek-ai 命中（多 profile 时按 readdir 顺序）', () => {
  const home = path.join(ROOT, 'fh3')
  const ai = hostTree(path.join(home, 'profiles', 'work', 'node_modules', '@deepseek-ai'))
  assert.equal(core.findAiBaseFromDshHome(home), path.normalize(ai))
})

test('findAiBaseFromDshHome：pnpm 布局要顺着 .modules.yaml 的 virtualStoreDir 找过去', () => {
  const home = path.join(ROOT, 'fh4')
  put(path.join(home, 'profiles', 'p1', 'node_modules', '.modules.yaml'), 'virtualStoreDir: node_modules/.pnpm\n')
  const ai = hostTree(path.join(home, 'profiles', 'p1', 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai'))
  assert.equal(core.findAiBaseFromDshHome(home), path.normalize(ai))
})

test('findAiBaseFromDshHome：四路都不命中回 null；空串与非目录也回 null', () => {
  const empty = mk(path.join(ROOT, 'fh5', 'profiles', 'p1'))
  assert.ok(empty)
  assert.equal(core.findAiBaseFromDshHome(path.join(ROOT, 'fh5')), null)
  assert.equal(core.findAiBaseFromDshHome(path.join(ROOT, 'fh-missing')), null)
  assert.equal(core.findAiBaseFromDshHome(''), null)
  assert.equal(core.findAiBaseFromDshHome(undefined), null)
})

// ── 五、主目录判定 ──────────────────────────────────────────

test('isDshHomeDir：只认 basename 是 .dsh / dsh-home，且大小写不敏感', () => {
  mk(path.join(ROOT, 'home-ok', '.dsh'))
  mk(path.join(ROOT, 'home-ok', 'DSH-HOME'))
  mk(path.join(ROOT, 'home-ok', 'other'))
  assert.equal(core.isDshHomeDir(path.join(ROOT, 'home-ok', '.dsh')), true)
  assert.equal(core.isDshHomeDir(path.join(ROOT, 'home-ok', 'DSH-HOME')), true)
  assert.equal(core.isDshHomeDir(path.join(ROOT, 'home-ok', 'other')), false)
  assert.equal(core.isDshHomeDir(''), false)
})

test('homeHasHarnessData：prompt-inject.md / profiles 目录 / cordis.patch.yml 任一即算，空目录不算', () => {
  put(path.join(ROOT, 'hd', 'hi1', 'prompt-inject.md'))
  mk(path.join(ROOT, 'hd', 'hi2', 'profiles'))
  put(path.join(ROOT, 'hd', 'hi3', 'cordis.patch.yml'))
  mk(path.join(ROOT, 'hd', 'hi4'))
  assert.equal(core.homeHasHarnessData(path.join(ROOT, 'hd', 'hi1')), true)
  assert.equal(core.homeHasHarnessData(path.join(ROOT, 'hd', 'hi2')), true)
  assert.equal(core.homeHasHarnessData(path.join(ROOT, 'hd', 'hi3')), true)
  assert.equal(core.homeHasHarnessData(path.join(ROOT, 'hd', 'hi4')), false)
  assert.equal(core.homeHasHarnessData(null), false)
})

/** findDshHome 的 web 面沙箱：HOME 与两个 APPDATA 全部指到临时目录，shim/prefix 显式给。 */
function sandboxEnv(home) {
  return {
    DSH_SURFACE: 'web',
    USERPROFILE: home,
    HOME: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  }
}

test('findDshHome：env.DSH_HOME 最优先，且要去掉首尾空白后 normalize', () => {
  const home = mk(path.join(ROOT, 'dh1'))
  const env = sandboxEnv(home)
  const target = path.join(ROOT, 'dh1', 'from-env')
  assert.equal(core.findDshHome({ env: { ...env, DSH_HOME: target }, shimDir: '', prefix: '' }), path.normalize(target))
  assert.equal(
    core.findDshHome({ env: { ...env, DSH_HOME: `  ${target}  ` }, shimDir: '', prefix: '' }),
    path.normalize(target),
  )
})

test('findDshHome：DSH_HOME 只有空白时当作没设，继续走后面的分支', () => {
  const home = mk(path.join(ROOT, 'dh2'))
  mk(path.join(home, '.dsh', 'profiles'))
  const env = { ...sandboxEnv(home), DSH_HOME: '   ' }
  const got = withEnv(
    env,
    () => core.findDshHome({ env, shimDir: path.join(ROOT, 'dh2', 'noshim'), prefix: path.join(ROOT, 'dh2', 'noprefix') }),
  )
  assert.equal(got, path.normalize(path.join(home, '.dsh')))
})

test('findDshHome：web 面认「启动器旁边的 .dsh」，优先于 ~/.dsh', () => {
  const home = mk(path.join(ROOT, 'dh3'))
  mk(path.join(home, '.dsh', 'profiles'))
  const shim = path.join(ROOT, 'dh3', 'shim')
  mk(path.join(shim, '.dsh', 'profiles'))
  assert.equal(
    withEnv(
      sandboxEnv(home),
      () => core.findDshHome({ env: sandboxEnv(home), shimDir: shim, prefix: path.join(ROOT, 'dh3', 'prefix') }),
    ),
    path.normalize(path.join(shim, '.dsh')),
  )
})

test('findDshHome：四处都没有时仍回 ~/.dsh（不抛 ENOENT，让人能看见路径）', () => {
  const home = mk(path.join(ROOT, 'dh4'))
  assert.equal(
    withEnv(
      sandboxEnv(home),
      () => core.findDshHome({ env: sandboxEnv(home), shimDir: path.join(ROOT, 'dh4', 'noshim'), prefix: path.join(ROOT, 'dh4', 'noprefix') }),
    ),
    path.join(home, '.dsh'),
  )
})

test('desktopDshHomeGuesses：win32 给 APPDATA 与 LOCALAPPDATA 两条，环境变量为空时不抛', () => {
  const appdata = path.join(ROOT, 'ddd', 'Roaming')
  const localapp = path.join(ROOT, 'ddd', 'Local')
  const environ = { ...process.env, APPDATA: appdata, LOCALAPPDATA: localapp }
  const got = withPlatform('win32', () => withEnv(environ, () => core.desktopDshHomeGuesses()))
  assert.deepEqual(got.map(rel), [
    rel(path.join(appdata, 'DeepSeek Harness', 'dsh-home')),
    rel(path.join(localapp, 'DeepSeek Harness', 'dsh-home')),
  ])
  const bare = withPlatform('win32', () => withEnv({ ...process.env, APPDATA: '', LOCALAPPDATA: '' }, () => core.desktopDshHomeGuesses()))
  assert.equal(bare.length, 2)
  assert.ok(bare[0].includes(path.join('AppData', 'Roaming')))
  assert.ok(bare[1].includes(path.join('AppData', 'Local')))
})

test('desktopDshHomeGuesses：darwin 给 Library/Application Support，linux 回空数组（官方没有 linux 桌面壳）', () => {
  const home = os.homedir()
  assert.deepEqual(withPlatform('darwin', () => core.desktopDshHomeGuesses()), [
    path.join(home, 'Library', 'Application Support', 'DeepSeek Harness', 'dsh-home'),
  ])
  assert.deepEqual(withPlatform('linux', () => core.desktopDshHomeGuesses()), [])
})

test('findWslWindowsDshHome：非 linux 一律空串；linux 下 /mnt/c/Users 不存在也回空串', () => {
  assert.equal(core.findWslWindowsDshHome({}), '')
  const got = withPlatform('linux', () => core.findWslWindowsDshHome({ WSL_DISTRO_NAME: 'Ubuntu' }))
  assert.equal(got, '')
})

function withPlatform(value, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', desc)
  }
}

function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) {
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
