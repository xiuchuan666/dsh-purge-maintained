// lib/preset-default.js 的行为守卫。
//
// 这个文件只在「停用/卸载插件」那一刻跑，跑完就没人再看它。坏掉的表现是：
// 宿主下次启动时 resolve() 找不到 selectedDefault 指向的预设，直接硬抛，
// 用户看到的是「DSH 起不来了」，而控制台里没有任何一行提到本插件 —— 因为
// 停用已经「成功」返回了。所以每条都要钉具体落盘结果，不能只看返回 ok。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  clearOwnedSelectedDefault,
  scheduleClearOwnedSelectedDefault,
  cancelClearOwnedSelectedDefault,
  removeStaleAgentPresetDir,
} from '../lib/preset-default.js'

/** 造一棵假的 $DSH_HOME，files 的键是相对路径。 */
function makeHome(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-purge-preset-'))
  for (const [rel, text] of Object.entries(files)) {
    const fp = join(root, rel)
    mkdirSync(dirname(fp), { recursive: true })
    writeFileSync(fp, text, 'utf8')
  }
  return root
}

const patchPath = (home, name = 'p1') => join(home, 'profiles', name, 'cordis.patch.yml')
const read = (fp) => readFileSync(fp, 'utf8')

test('selectedDefault 指向本插件预设时改回 standard，引号与命名空间前缀都保留原样', () => {
  const cases = [
    ['selectedDefault: redteam\n', 'selectedDefault: standard\n'],
    ['selectedDefault: "redteam"\n', 'selectedDefault: "standard"\n'],
    ["selectedDefault: 'redteam'\n", "selectedDefault: 'standard'\n"],
    ['selectedDefault: myns/redteam\n', 'selectedDefault: standard\n'],
    /* 大小写：宿主解析预设 id 时不区分大小写，这里也必须认 */
    ['selectedDefault: RedTeam\n', 'selectedDefault: standard\n'],
    /* 冒号后没空格也要认（手写的 YAML 经常这样） */
    ['selectedDefault:redteam\n', 'selectedDefault:standard\n'],
    /* 缩进在块里的形态 */
    ['agent-preset-registry:\n  selectedDefault: redteam\n  default: standard\n',
      'agent-preset-registry:\n  selectedDefault: standard\n  default: standard\n'],
  ]
  for (const [before, after] of cases) {
    const home = makeHome({ 'profiles/p1/cordis.patch.yml': before })
    try {
      const r = clearOwnedSelectedDefault({ dshHome: home })
      assert.equal(r.files.length, 1, `必须报告改了这个文件：${before.trim()}`)
      assert.equal(read(patchPath(home)), after, `落盘内容不对：${before.trim()}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test('不指向本插件预设的文件一个字节都不动，也不进报告', () => {
  for (const before of [
    'selectedDefault: standard\n',
    'selectedDefault: other\n',
    'no such key here\n',
  ]) {
    const home = makeHome({ 'profiles/p1/cordis.patch.yml': before })
    try {
      const r = clearOwnedSelectedDefault({ dshHome: home })
      assert.deepEqual(r.files, [], `不该动：${before.trim()}`)
      assert.equal(read(patchPath(home)), before)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test('现状锁定：redteam-extra 这种带后缀的名字会被改成 standard-extra', () => {
  /* 正则 (?:[\w.-]+\/)?redteam 只匹配到 redteam 这几个字母，后缀留在原地。
     结果是 standard-extra —— 一个不存在的预设 id，宿主 resolve() 照样会抛。
     这不是本次要修的行为（改它会动到「命名空间前缀」的匹配），但必须让后人
     知道它长什么样，免得以为「有测试就说明这块没问题」。 */
  const home = makeHome({ 'profiles/p1/cordis.patch.yml': 'selectedDefault: redteam-extra\n' })
  try {
    const r = clearOwnedSelectedDefault({ dshHome: home })
    assert.equal(r.files.length, 1)
    assert.equal(read(patchPath(home)), 'selectedDefault: standard-extra\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('profile 目录：cordis.patch.yml 与 cordis.yml 都扫，node_modules 与其它文件名不碰', () => {
  const home = makeHome({
    'profiles/a/cordis.yml': 'selectedDefault: redteam\n',
    'profiles/b/cordis.patch.yml': 'selectedDefault: redteam\n',
    /* node_modules 直接挂在 profiles 下面（真正会被扫到的那一层），不是它的子目录 */
    'profiles/node_modules/cordis.yml': 'selectedDefault: redteam\n',
    'profiles/c/other.yml': 'selectedDefault: redteam\n',
  })
  try {
    const r = clearOwnedSelectedDefault({ dshHome: home })
    assert.deepEqual(r.files.map((fp) => fp.replace(/\\/g, '/').split('/profiles/')[1]).sort(),
      ['a/cordis.yml', 'b/cordis.patch.yml'])
    assert.equal(read(join(home, 'profiles/node_modules/cordis.yml')), 'selectedDefault: redteam\n',
      'node_modules 里的模板不能改')
    assert.equal(read(join(home, 'profiles/c/other.yml')), 'selectedDefault: redteam\n',
      '不是 cordis 配置的文件不能改')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('空的 cordis 配置文件不算改过（不进报告、不重写）', () => {
  const home = makeHome({ 'profiles/p1/cordis.patch.yml': '' })
  try {
    const before = read(patchPath(home))
    const r = clearOwnedSelectedDefault({ dshHome: home })
    assert.deepEqual(r.files, [], '空文件没什么可改，不该报告')
    assert.equal(read(patchPath(home)), before)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('没有 profiles 目录 / 空 home / 没给 home 都安静返回，不抛', () => {
  const bare = makeHome({})
  try {
    assert.deepEqual(clearOwnedSelectedDefault({ dshHome: bare }), { live: false, files: [] })
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
  const empty = makeHome({ 'profiles/.keep': '' })
  try {
    assert.deepEqual(clearOwnedSelectedDefault({ dshHome: empty }), { live: false, files: [] })
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
  /* dshHome 空串时走 findDshHome()；本机装了 DSH 也不该在这里报错 */
  assert.doesNotThrow(() => clearOwnedSelectedDefault({ dshHome: '' }))
})

test('live 侧：settings 里的 selectedDefault 是对象形态时用 update 改，并吞掉 Promise 拒绝', async () => {
  const calls = []
  const settings = {
    get: (key) => (key === 'agent-preset-registry' ? { config: { selectedDefault: 'redteam', default: 'standard' } } : undefined),
    update: (name, patch) => { calls.push([name, patch]); return Promise.reject(new Error('disk full')) },
  }
  const home = makeHome({})
  try {
    const r = clearOwnedSelectedDefault({ ctx: { get: (k) => (k === 'settings' ? settings : undefined) }, dshHome: home })
    assert.equal(r.live, true, 'update 被调用就算修好了内存态（返回的 Promise 拒绝只打日志）')
    assert.deepEqual(calls, [['agent-preset-registry', { selectedDefault: 'standard' }]])
    /* 关键：update 返回的 rejected Promise 必须被 .catch 吃掉，否则 unhandledRejection 会让进程退出 */
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('live 侧：selectedDefault 不是本插件、或 fallback 本身也是本插件时不动', () => {
  const home = makeHome({})
  try {
    /* settings.get 真的回一行：这时才走 update 那条路 */
    const notOwned = []
    clearOwnedSelectedDefault({
      ctx: {
        get: (k) => (k === 'settings'
          ? { get: () => ({ config: { selectedDefault: 'other', default: 'standard' } }), update: (n, p) => notOwned.push(p) }
          : undefined),
      },
      dshHome: home,
    })
    assert.deepEqual(notOwned, [], '别的预设不该被改')

    const ownedFallback = []
    clearOwnedSelectedDefault({
      ctx: {
        get: (k) => (k === 'settings'
          ? { get: () => ({ config: { selectedDefault: 'redteam', default: 'redteam' } }), update: (n, p) => ownedFallback.push(p) }
          : undefined),
      },
      dshHome: home,
    })
    assert.deepEqual(ownedFallback, [], 'fallback 也是 redteam 时改过去等于没改，不能写')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('live 侧认三种写法：命名空间前缀、大小写、两侧空白', () => {
  /* isOwnedPresetId 会把值 trim + toLowerCase 再比，且认 `xxx/redteam`。
     少任何一条，用户在 profile 里写的 `myns/redteam` 或 ` RedTeam ` 就清不掉，
     停用后宿主 resolve() 照样硬抛。 */
  for (const value of ['myns/redteam', 'RedTeam', '  redteam  ', 'REDTEAM']) {
    const calls = []
    const home = makeHome({})
    try {
      const r = clearOwnedSelectedDefault({
        ctx: {
          get: (k) => (k === 'settings'
            ? { get: () => ({ config: { selectedDefault: value, default: 'standard' } }), update: (n, p) => calls.push(p) }
            : undefined),
        },
        dshHome: home,
      })
      assert.equal(r.live, true, `必须认出来：${JSON.stringify(value)}`)
      assert.deepEqual(calls, [{ selectedDefault: 'standard' }], `必须写回 standard：${JSON.stringify(value)}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test('live 侧：bag 的 selectedDefault 是抛错的 getter 时整条不抛，文件侧照修', () => {
  /* clearLiveSelectedDefault 里那两个 try 只包了「取 settings / 取 row」，
     真正遍历 bags 的循环在 try 外面 —— 宿主配置节点是代理，读属性可能抛。
     外层那个 catch 就是兜这个的；少了它，停用会因为一个坏配置节点整条失败。 */
  const bag = { default: 'standard' }
  Object.defineProperty(bag, 'selectedDefault', { get() { throw new Error('proxy boom') } })
  const home = makeHome({ 'profiles/p1/cordis.patch.yml': 'selectedDefault: redteam\n' })
  try {
    const r = clearOwnedSelectedDefault({ ctx: { get: (k) => (k === 'agentPresets' ? bag : undefined) }, dshHome: home })
    assert.equal(r.live, false, '读崩了就是没修好')
    assert.equal(r.files.length, 1, 'live 侧炸了，文件侧照样要修')
    assert.equal(read(patchPath(home)), 'selectedDefault: standard\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('live 侧：settings 抛错、ctx 为 null 都当没修好，不打断文件那半', () => {
  const home = makeHome({ 'profiles/p1/cordis.patch.yml': 'selectedDefault: redteam\n' })
  try {
    const broken = { get: () => { throw new Error('service gone') } }
    const r = clearOwnedSelectedDefault({ ctx: broken, dshHome: home })
    assert.equal(r.live, false)
    assert.equal(r.files.length, 1, 'live 侧炸了，文件侧照样要修')
    assert.equal(read(patchPath(home)), 'selectedDefault: standard\n')

    assert.equal(clearOwnedSelectedDefault({ ctx: null, dshHome: home }).live, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('live 侧：agentPresets 的 config 里 selectedDefault 是 {value} 包装时改得动', () => {
  const bag = { selectedDefault: { value: 'redteam' }, default: 'standard' }
  const home = makeHome({})
  try {
    const r = clearOwnedSelectedDefault({ ctx: { get: (k) => (k === 'agentPresets' ? bag : undefined) }, dshHome: home })
    assert.equal(r.live, true)
    assert.equal(bag.selectedDefault.value, 'standard')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('live 侧：有 set() 的节点优先走 set()，不走属性赋值', () => {
  /* cordis 的 config 节点是带 set() 的代理；走属性赋值在真宿主里不会触发
     持久化，看起来改了、重启又回来。这条钉住「先 set()」。 */
  const seen = []
  const node = { value: 'redteam', set(v) { seen.push(v); this.value = v } }
  const bag = { selectedDefault: node, default: 'standard' }
  const home = makeHome({})
  try {
    const r = clearOwnedSelectedDefault({ ctx: { get: (k) => (k === 'agentPresets' ? bag : undefined) }, dshHome: home })
    assert.equal(r.live, true)
    assert.deepEqual(seen, ['standard'], '必须调 set()')
    assert.equal(node.value, 'standard')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('现状锁定：selectedDefault 是裸字符串时 live 侧改不动（只能靠文件那半）', () => {
  /* configSet 先试 node.set()，字符串没有；再试 node.value = x，对原始值赋值在
     ESM 严格模式下抛 TypeError 被吞掉 → 返回 false。于是内存态留着一个指向
     已停用预设的 id。实际安装里这一格是 cordis 的 config 代理（对象形态），
     所以走不到；写成用例是防止有人「优化」成能改字符串后语义悄悄变掉。 */
  const bag = { selectedDefault: 'redteam', default: 'standard' }
  const home = makeHome({})
  try {
    const r = clearOwnedSelectedDefault({ ctx: { get: (k) => (k === 'agentPresets' ? bag : undefined) }, dshHome: home })
    assert.equal(r.live, false)
    assert.equal(bag.selectedDefault, 'redteam')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('profile 文件只读时跳过且不抛，坏的 profile 不挡其它 profile', () => {
  /* chmod 0444 在 Windows 上会真正生效（写它 EPERM）——这个用例在 Linux 上
     也一样能过（root 也拦不住 chmod，只有真的 root 才可能绕过，CI 不是 root）。 */
  const home = makeHome({
    'profiles/ro/cordis.patch.yml': 'selectedDefault: redteam\n',
    'profiles/ok/cordis.patch.yml': 'selectedDefault: redteam\n',
  })
  try {
    chmodSync(join(home, 'profiles', 'ro', 'cordis.patch.yml'), 0o444)
    const r = clearOwnedSelectedDefault({ dshHome: home })
    /* 只读那个进不了报告，但可写那个照样修 */
    assert.equal(r.files.length, 1)
    assert.ok(r.files[0].endsWith('profiles\\ok\\cordis.patch.yml') || r.files[0].endsWith('profiles/ok/cordis.patch.yml'))
    assert.equal(read(join(home, 'profiles', 'ok', 'cordis.patch.yml')), 'selectedDefault: standard\n')
    assert.equal(read(join(home, 'profiles', 'ro', 'cordis.patch.yml')), 'selectedDefault: redteam\n')
  } finally {
    chmodSync(join(home, 'profiles', 'ro', 'cordis.patch.yml'), 0o666)
    rmSync(home, { recursive: true, force: true })
  }
})

test('profile 路径是目录时跳过（EISDIR 不算失败），能修的照修', () => {
  const home = makeHome({
    'profiles/broken/cordis.patch.yml/.keep': '',
    'profiles/ok/cordis.patch.yml': 'selectedDefault: redteam\n',
  })
  try {
    const r = clearOwnedSelectedDefault({ dshHome: home })
    assert.equal(r.files.length, 1)
    assert.equal(read(join(home, 'profiles', 'ok', 'cordis.patch.yml')), 'selectedDefault: standard\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('removeStaleAgentPresetDir 删掉遗留目录，删不到就回 false 而不抛', () => {
  const home = makeHome({ '.agent-presets/redteam/plan.md': 'x' })
  try {
    assert.equal(removeStaleAgentPresetDir(home, 'redteam'), true)
    assert.equal(existsSync(join(home, '.agent-presets/redteam')), false)
    assert.equal(removeStaleAgentPresetDir(home, 'redteam'), false, '已经没了就是 false')
    assert.equal(removeStaleAgentPresetDir(home, ''), false, '空 id 不能变成删整个 .agent-presets')
    assert.equal(existsSync(join(home, '.agent-presets')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('scheduleClearOwnedSelectedDefault 被取消时不写盘（热重载先 dispose 再 apply）', async () => {
  /* 必须真的等过 800ms 那个窗口：只「取消后立刻看一眼」是测不出来的 ——
     定时器本来就还没到点，文件当然没变，cancel 里清不清 timer 都一样绿。 */
  const home = makeHome({
    'profiles/p1/cordis.patch.yml': 'selectedDefault: redteam\n',
    '.agent-presets/redteam/plan.md': 'x',
  })
  try {
    scheduleClearOwnedSelectedDefault({ dshHome: home })
    cancelClearOwnedSelectedDefault()
    assert.equal(read(patchPath(home)), 'selectedDefault: redteam\n', '取消了就不许改')
    /* 再取消一次不能抛 */
    assert.doesNotThrow(() => cancelClearOwnedSelectedDefault())
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert.equal(read(patchPath(home)), 'selectedDefault: redteam\n', '过了定时窗口也不许改：timer 必须真的被清掉')
    assert.equal(existsSync(join(home, '.agent-presets/redteam')), true, '遗留目录也不能被清掉')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('scheduleClearOwnedSelectedDefault 的定时器 unref 过（不拖住进程退出）', () => {
  /* unref 在进程内不可观测：定时器照常触发、进程照样活着，只能读源码形状。
     少了这一句，宿主退出时会被这 800ms 的空定时器拖住 —— 桌面端表现为关窗口后
     进程残留、下次启动端口还被占。 */
  const src = readFileSync(new URL('../lib/preset-default.js', import.meta.url), 'utf8')
  assert.match(src, /if \(typeof pendingClear\.unref === "function"\) pendingClear\.unref\(\);/)
})

test('scheduleClearOwnedSelectedDefault 定时到了就改文件并顺手清掉遗留预设目录', async () => {
  const home = makeHome({
    'profiles/p1/cordis.patch.yml': 'selectedDefault: redteam\n',
    '.agent-presets/redteam/plan.md': 'x',
  })
  try {
    scheduleClearOwnedSelectedDefault({ dshHome: home })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert.equal(read(patchPath(home)), 'selectedDefault: standard\n')
    assert.equal(existsSync(join(home, '.agent-presets/redteam')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
