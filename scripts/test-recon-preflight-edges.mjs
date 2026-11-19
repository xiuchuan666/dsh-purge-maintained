// redteam_preflight 的「下一步该说什么」与「坏掉的技能怎么修」这两块：
// `lib/redteam/tool-specs-recon.js` 里那 5 个 next 分支 + broken 的 fixes 映射，
// 以及 summaries 过滤后 fromBundle 翻假时重算的那两条。
//
// 为什么值得单独一个文件：`test-redteam-tool-branches.mjs` 里那 5 条 preflight 用例
// 全部跑在**本机真实平台**（win32）上，而 next 的第一个分支是
// `plat.runtime.windows && (!hasMarker || missing.length > 0 || allBroken.length > 0)`
// —— 在 Windows 上它恒真，后面四个分支一条都走不到。于是「缺什么」的文案
// 从来没被验证过，而模型正是照着这句话去问用户的。
//
// 平台用 config.json 的 `platform: "linux"` 钉住（`isWinLike` 先看显式配置，
// 再看 os.platform），所以两平台跑出来的结果一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/redteam/tools.js'
import { RedteamStore } from '../lib/redteam/store-core.js'

const SRC = readFileSync(new URL('../lib/redteam/tool-specs-recon.js', import.meta.url), 'utf8')

/** 与 `lib/redteam/platform-config.js` 的 TOOL_CATALOG 对齐（15 个）。 */
const TOOL_IDS = ['nmap', 'nuclei', 'masscan', 'fscan', 'gogo', 'suo5', 'frpc', 'frps', 'chisel', 'ffuf',
  'httpx', 'dnsx', 'subfinder', 'ksubdomain', 'impacket']

let seq = 0

/**
 * 每个用例一套临时现场：新 root、新 DSH_HOME、新靶标、新会话 id。
 * `config` 写进 `$DSH_HOME/redteam/config.json`；`files` 的键是相对 `$DSH_HOME` 的路径，
 * 值是字符串或 `(home) => string`（要拼绝对路径时用它）。
 */
async function withPreflight(fn, options = {}) {
  seq += 1
  const root = mkdtempSync(join(tmpdir(), 'dsh-purge-preflight-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'dshhome')
  const home = process.env.DSH_HOME
  let store
  try {
    mkdirSync(join(home, 'redteam'), { recursive: true })
    for (const [rel, body] of Object.entries(options.files || {})) {
      const fp = join(home, rel)
      mkdirSync(join(fp, '..'), { recursive: true })
      writeFileSync(fp, typeof body === 'function' ? body(home) : body)
    }
    if (options.toolkit) {
      mkdirSync(join(home, 'redteam', 'toolkit'), { recursive: true })
      writeFileSync(join(home, 'redteam', 'toolkit', 'fscan'), 'x')
    }
    /* tools 里写绝对路径：resolveTool 认「已配置且 existsSync」就直接用，不再上 PATH 找，
       这样「工具齐不齐」这个变量被彻底钉死。 */
    const tools = {}
    if (options.allTools) {
      mkdirSync(join(home, 'bin'), { recursive: true })
      for (const id of TOOL_IDS) {
        const fp = join(home, 'bin', `tool-${id}`)
        writeFileSync(fp, 'x')
        tools[id] = fp
      }
    }
    const cfg = { platform: 'linux', tools, ...(options.config || {}) }
    if (options.config && options.config.env) cfg.env = options.config.env
    writeFileSync(join(home, 'redteam', 'config.json'), JSON.stringify(cfg))
    store = new RedteamStore(root)
    store.openEngagement(`preflight-靶标-${seq}`, ['10.0.0.0/24'], { bindCurrent: false })
    const registered = []
    apply({
      defineTool: (s) => s,
      tools: { register: (t) => registered.push(t) },
      effect: () => () => {},
      on: () => () => {},
      get: (k) => (k === 'skills' ? options.skills : undefined),
      logger: { warn: () => {} },
      redteam: store,
    })
    const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
    const call = async (name, args = {}) => {
      const out = await byName[name].execute(args, { agent: { session: { id: `pf-${seq}` } } })
      assert.equal(typeof out, 'string')
      return JSON.parse(out)
    }
    return await fn({ root, home, call, store })
  } finally {
    try { store && store.close() } catch { /* 已关 */ }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows EPERM */ }
  }
}

/** 一个「正文读不到、文件也不在本机」的坏技能：唯一的 broken 来源。 */
function brokenSkill() {
  return {
    name: 'redteam-vps-broken',
    description: '坏掉的技能',
    content: '',
    library: 'redteam',
    path: join(tmpdir(), 'not-here', 'SKILL.md'),
    resourceBase: { kind: 'directory', path: join(tmpdir(), 'not-here') },
  }
}

/** 一份完整的可用技能，用来让 allBroken 保持 0。 */
function goodSkill() {
  return {
    name: 'redteam-good',
    description: '好的技能',
    content: '这里没有占位符，也没有环境变量要求。',
    library: 'redteam',
    path: join(tmpdir(), 'good', 'SKILL.md'),
    resourceBase: { kind: 'directory', path: join(tmpdir(), 'good') },
  }
}

const skillsOf = (items, getImpl) => ({
  list: async () => items,
  get: getImpl || (async (n) => ({ path: join(tmpdir(), n, 'SKILL.md'), content: '正文' })),
})

/** 配齐 FOFA + VPS + 15 个工具路径的现场：只留「技能坏不坏」这一个变量。 */
const CONFIGURED = {
  allTools: true,
  config: { env: { FOFA_KEY: 'k'.repeat(16), REDTEAM_VPS_KEY: '' } },
  files: {
    'redteam/.setup-complete': '',
    'redteam/vps/id_rsa': 'key',
    '.env': (home) => 'REDTEAM_VPS_KEY=' + join(home, 'redteam', 'vps', 'id_rsa') + '\n',
  },
}

/* ==================================================== next 的五个分支 */

test('linux 上首次使用、又没有 setup.sh 时，next 说「这是正常情况」而不是报错', async () => {
  await withPreflight(async ({ call }) => {
    const pf = await call('redteam_preflight', {})
    assert.equal(pf.platform.runtime.windows, false, 'platform:linux 必须让 runtime.windows 为假')
    assert.match(pf.onboarding.runtime_hint, /专供演练的 Kali 虚拟机/, 'linux 那半句 runtime_hint 要走它自己那一行')
    /* 第二行讲的是「为什么别在日常机上跑」—— 丢了就只剩一半理由，
       而这句正是决定用户敢不敢在这台机器上落私钥的唯一提示。 */
    assert.match(pf.onboarding.runtime_hint, /演练完虚拟机可直接丢弃/)
    assert.equal(pf.onboarding.first_run, true)
    assert.equal(pf.onboarding.marker.exists, false)
    assert.equal(pf.onboarding.setup_script.exists, false)
    assert.match(pf.next, /首次使用，且本机没有安装脚本/)
    assert.match(pf.next, /这是正常情况，不是故障/, '没有 setup.sh 不是故障，文案必须这么说')
    assert.match(pf.next, /crt\.sh/, '降级方案要写清楚')
  }, { skills: skillsOf([goodSkill()]) })
})

test('linux 上有 setup.sh 但还没跑过时，next 只让用户自己执行 --check', async () => {
  await withPreflight(async ({ call }) => {
    const pf = await call('redteam_preflight', {})
    assert.equal(pf.onboarding.setup_script.exists, true)
    assert.equal(pf.onboarding.marker.exists, false)
    assert.match(pf.next, /让用户自己执行/)
    assert.match(pf.next, /--check/)
    assert.match(pf.next, /不要由智能体执行 --yes/, '有脚本不等于智能体可以去装')
  }, {
    files: { 'redteam/setup.sh': '#!/bin/sh\n' },
    skills: skillsOf([goodSkill()]),
  })
})

test('linux 上已有 marker 但缺 FOFA 时，next 归到「有缺口」并指向 missing', async () => {
  await withPreflight(async ({ call }) => {
    const pf = await call('redteam_preflight', {})
    assert.equal(pf.onboarding.marker.exists, true)
    assert.ok(pf.onboarding.missing.length > 0, '没配 FOFA_KEY 必须有缺口')
    assert.equal(pf.onboarding.complete, false)
    assert.match(pf.next, /有缺口/)
    assert.match(pf.next, /onboarding\.missing/)
    assert.match(pf.next, /不要替用户下载工具/)
    /* 没点名 include 时，全局缺口就直接把 ok 拖成 false —— 这是模型判断
       「能不能开工」的唯一依据，不能宽松。 */
    assert.equal(pf.ok, false)
  }, {
    files: { 'redteam/.setup-complete': '' },
    skills: skillsOf([goodSkill()]),
  })
})

test('配齐了 key 但技能坏掉时，next 指向 broken 的 needs_user，并给出每条 fixes', async () => {
  /* 这条技能的 `skills.get` 也必须给不出正文 —— 否则 fromBundle 翻假之后
     预检会去问宿主取正文，拿到「正文」这条技能就不再是 broken 了（实测踩过）。 */
  const emptyGet = async () => ({ path: join(tmpdir(), 'not-here', 'SKILL.md'), content: '' })
  await withPreflight(async ({ call }) => {
    const pf = await call('redteam_preflight', {})
    assert.equal(pf.onboarding.missing.length, 0, JSON.stringify(pf.onboarding.missing))
    assert.equal(pf.ok, false, '有 broken 技能时 ok 必须是 false')
    assert.ok(pf.broken.length >= 1)
    const first = pf.broken[0]
    assert.equal(first.name, 'redteam-vps-broken')
    assert.ok(Array.isArray(first.fixes), 'fixes 必须是数组')
    assert.ok(first.fixes.length >= 1, '文件不存在这条必须能给出修复步骤')
    assert.ok(first.fixes.every((f) => typeof f === 'string' && f.length > 0))
    assert.match(first.fix_note, /不要由你下载/)
    assert.match(pf.next, /把 broken 里 needs_user 一次性列给用户/)
  }, { ...CONFIGURED, skills: skillsOf([brokenSkill()], emptyGet) })
})

test('全部干净时 next 就是「全部可用，可以开工。」', async () => {
  await withPreflight(async ({ call }) => {
    const pf = await call('redteam_preflight', {})
    assert.equal(pf.onboarding.complete, true, JSON.stringify(pf.onboarding.missing))
    assert.equal(pf.all_checked.broken, 0)
    assert.equal(pf.next, '全部可用，可以开工。')
    assert.deepEqual(pf.broken, [])
    assert.equal(pf.ok, true)
  }, { ...CONFIGURED, skills: skillsOf([goodSkill()]) })
})

/* ==================================================== toolkit 与 fromBundle */

test('toolkit 目录存在时把里面的条目列出来', async () => {
  await withPreflight(async ({ call }) => {
    const pf = await call('redteam_preflight', {})
    assert.equal(pf.toolkit.exists, true)
    assert.ok(pf.toolkit.entries.includes('fscan'), JSON.stringify(pf.toolkit.entries))
  }, { ...CONFIGURED, toolkit: true, skills: skillsOf([goodSkill()]) })
})

test('skills.list 给的条目缺正文时，fromBundle 翻假并按 skills.get 重新取正文', async () => {
  const got = []
  const bare = {
    name: 'redteam-bare',
    description: '只有元数据的技能',
    library: 'redteam',
    resourceBase: { kind: 'directory', path: join(tmpdir(), 'bare') },
  }
  await withPreflight(async ({ call }) => {
    /* include 只点名这一个：否则 summary 里还会并进随包的 24 个技能，
       「有没有问 skills.get 要正文」这件事就被稀释掉了。 */
    const pf = await call('redteam_preflight', { include: 'redteam-bare' })
    assert.deepEqual(got, ['redteam-bare'], 'fromBundle 为假时必须问 skills.get 要正文')
    assert.equal(pf.checked, 1)
    /* 正文里有 `<你的VPS_IP>` 只是 issue（needs_user），不是 broken：
       技能可用、但要让用户把占位符填掉。这一点钉住，免得以后把 placeholder 升级成 broken。 */
    assert.deepEqual(pf.available, ['redteam-bare'])
    assert.deepEqual(pf.broken, [])
    /* 现状（已记进 test-map 盲区）：占位符只算 issue，不算 broken；
       而返回体里只有 broken 会带 needs_user / problems，所以「正文里有 <你的VPS_IP>」
       这件事在 preflight 结果里**是看不见的**。要钉住这个现状，免得以后有人
       以为 available 的技能也会把自己缺什么报出来。 */
    assert.deepEqual(pf.needs_user_flat, [])
    assert.equal(pf.next, '全部可用，可以开工。')
  }, {
    ...CONFIGURED,
    skills: skillsOf([bare], async (n) => {
      got.push(n)
      return { path: join(tmpdir(), 'bare', 'SKILL.md'), content: '反弹 Shell 连 <你的VPS_IP>' }
    }),
  })
})

test('skills.get 抛错时按「没有正文」继续体检，不整条报废', async () => {
  const bare = {
    name: 'redteam-bare',
    description: '只有元数据',
    library: 'redteam',
    resourceBase: { kind: 'directory', path: join(tmpdir(), 'bare') },
  }
  await withPreflight(async ({ call }) => {
    const pf = await call('redteam_preflight', { include: 'redteam-bare' })
    assert.equal(pf.checked, 1, 'get 抛错也要照常出一条结论')
    /* all_checked 只有 registry_total/checked/broken/available 四个键，没有 unknown；
       所以「这一条到底归到哪一类」要自己加 available+broken 再看。 */
    assert.equal(pf.available.length + pf.broken.length, 1)
    assert.equal(pf.all_checked.checked, 1)
  }, {
    ...CONFIGURED,
    skills: skillsOf([bare], async () => { throw new Error('get boom') }),
  })
})

/* ==================================================== 不可达的那一段 */

test('「读技能目录失败且内置技能也为空」这一支靠源码形状钉住（本仓库不可达）', () => {
  /* 条件是 `bundledSkills.length === 0`，而 bundledSkillSummaries() 扫的是
     随包 skills/redteam（恒有 20 多个 .md）与 $DSH_HOME/redteam/skills，
     任何安装形态下都不为空。这一支仍然重要：它是「连兜底都没有」时唯一的出口。 */
  assert.match(SRC, /if \(bundledSkills\.length === 0\) \{/)
  assert.match(SRC, /error: '读取技能目录失败：'/)
  assert.match(SRC, /summaries = bundledSkills\r?\n\s*fromBundle = true/)
})
