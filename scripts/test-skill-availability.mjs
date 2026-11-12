/**
 * lib/redteam/skill-availability.js —— 技能可用性自检（tools 与面板共用的唯一一份判定）。
 *
 * 坏法（都安静）：
 *   1. `checkSkill` 把「路径来自别的机器」当成不可用 → 换台电脑后整片技能显示 broken，
 *      用户以为装错了，实际技能正文能加载、只是记录的绝对路径指空。
 *   2. 占位符判定放在「VPS 已配置」之前 → 配好 VPS 的机器上永远显示 broken。
 *   3. `bundledSkillSummaries` 只扫 env 那一份 home → 换过盘 / 换过 profile 的机器上
 *      「装了却列不出来」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  bundledSkillSummaries,
  checkSkill,
  dshHomeCandidates,
  existsUnderAnyHome,
  expandSkillPath,
  officialSkillSummaries,
  pathCountsOnThisHost,
  readSkillFromRoot,
  redteamSummariesForCheck,
  referencedPathsOf,
  requiredEnvOf,
  skillLibraryOf,
  summarizeSkills,
} from '../lib/redteam/skill-availability.js'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpurge-sa-'))
test.after(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发 EPERM */
  }
})

let seq = 0
function freshHome(tag = 'h') {
  seq += 1
  const home = path.join(sandbox, `${tag}-${seq}`)
  fs.mkdirSync(home, { recursive: true })
  return home
}

/* ------------------------------------------------------------------ *
 * 一、路径展开与 home 候选
 * ------------------------------------------------------------------ */

test('expandSkillPath：${DSH_HOME} / $DSH_HOME / ~/ 三种写法都展开', () => {
  const env = { DSH_HOME: path.join(sandbox, 'h') }
  // 现状锁定：替换是纯字符串拼接，不 normalize —— 展开结果里混着 `/` 与 `\`。
  // 调用方一律直接喂 existsSync / resolve，两种分隔符都能用，所以这里只钉「前缀换对了」。
  assert.equal(path.normalize(expandSkillPath('${DSH_HOME}/redteam/toolkit', env)), path.join(env.DSH_HOME, 'redteam', 'toolkit'))
  assert.equal(path.normalize(expandSkillPath('$DSH_HOME/redteam/bin', env)), path.join(env.DSH_HOME, 'redteam', 'bin'))
  assert.equal(path.normalize(expandSkillPath('~/x', env)), path.resolve(os.homedir(), 'x'))
  assert.equal(expandSkillPath('  /abs/path  ', env), '/abs/path', '要 trim')
  assert.equal(expandSkillPath('/plain', env), '/plain')
})

test('expandSkillPath：没有 DSH_HOME 时回落到 ~/.dsh', () => {
  const out = expandSkillPath('$DSH_HOME/x', {})
  assert.equal(path.normalize(out), path.join(os.homedir(), '.dsh', 'x'))
})

test('dshHomeCandidates：env 与 ~/.dsh 两份，去重且保持顺序', () => {
  const home = freshHome()
  const out = dshHomeCandidates({ DSH_HOME: home })
  assert.equal(out[0], home, 'env 那份排第一')
  assert.equal(out.length, 2)
  assert.equal(out[1], path.resolve(os.homedir(), '.dsh'))
  assert.deepEqual(dshHomeCandidates({}), [path.resolve(os.homedir(), '.dsh')], '没有 env 就只有一份')
  assert.deepEqual(dshHomeCandidates({ DSH_HOME: path.resolve(os.homedir(), '.dsh') }), [path.resolve(os.homedir(), '.dsh')], '两份相同时去重')
})

test('existsUnderAnyHome：遍历的是**全部**候选 home（不能只试第一个）', () => {
  // 真实场景是「文件在 ~/.dsh 下、env.DSH_HOME 指向别处」，但那要求动真实家目录，
  // 所以这条只能读源码钉：循环体必须是完整的 dshHomeCandidates(env)，不许 slice / [0]。
  const SRC = fs.readFileSync(new URL('../lib/redteam/skill-availability.js', import.meta.url), 'utf8')
  assert.match(SRC, /for \(const home of dshHomeCandidates\(env\)\) \{/)
  assert.doesNotMatch(SRC, /dshHomeCandidates\(env\)\.slice/)
  assert.doesNotMatch(SRC, /dshHomeCandidates\(env\)\[0\]/)
})

test('existsUnderAnyHome：真的哪里都没有才 false', () => {
  const env = { DSH_HOME: freshHome() }
  assert.equal(existsUnderAnyHome('$DSH_HOME/redteam/toolkit/definitely-missing.exe', env), false)
})

/* ------------------------------------------------------------------ *
 * 二、从正文里抽必需的环境变量
 * ------------------------------------------------------------------ */

test('requiredEnvOf：process.env.X 必需，且只认大写且长度 ≥3 的名字', () => {
  const out = requiredEnvOf('const k = process.env.FOFA_KEY; process.env.AB; process.env.A1B2C3;')
  assert.deepEqual(out.sort(), ['A1B2C3', 'FOFA_KEY'])
})

test('requiredEnvOf：os.environ["X"] 必需，os.environ.get("X", "默认") 不算', () => {
  const out = requiredEnvOf([
    'key = os.environ["FOFA_KEY"]',
    'host = os.environ["REDTEAM_VPS_HOST"]',
    'other = os.environ.get("OPTIONAL_KEY", "fallback")',
    "single = os.environ['SINGLE_QUOTED']",
  ].join('\n'))
  assert.deepEqual(out.sort(), ['FOFA_KEY', 'REDTEAM_VPS_HOST', 'SINGLE_QUOTED'])
})

test('requiredEnvOf：${X:?必填} 算必需，裸 $X 不算（技能里大量出现 $TARGET 这类占位）', () => {
  const out = requiredEnvOf('curl -H "key: ${FOFA_KEY:?need it}" "$TARGET" $UNSET_THING')
  assert.deepEqual(out, ['FOFA_KEY'])
})

test('requiredEnvOf：三种写法同名只算一次，空正文回空数组', () => {
  const out = requiredEnvOf('process.env.SAME_KEY\nos.environ["SAME_KEY"]\n${SAME_KEY:?}')
  assert.deepEqual(out, ['SAME_KEY'])
  assert.deepEqual(requiredEnvOf(''), [])
  assert.deepEqual(requiredEnvOf(null), [])
  assert.deepEqual(requiredEnvOf(undefined), [])
})

/* ------------------------------------------------------------------ *
 * 三、路径能不能算到这台机器上
 * ------------------------------------------------------------------ */

test('pathCountsOnThisHost：说明文件不是工具', () => {
  for (const p of ['/x/toolkit/README.md', '/x/toolkit/notes.txt', '/x/a.json', '/x/b.yaml', '/x/c.yml', '/x/d.csv']) {
    assert.equal(pathCountsOnThisHost(p), false, p)
  }
})

test('pathCountsOnThisHost：Windows 上不认 .sh / .bash / ~/.local / ~/.kimi-webbridge', () => {
  const win = 'win32'
  assert.equal(pathCountsOnThisHost('/x/toolkit/run.sh', win, 'x64'), false)
  assert.equal(pathCountsOnThisHost('/x/toolkit/run.bash', win, 'x64'), false)
  assert.equal(pathCountsOnThisHost('/home/u/.local/bin/tool', win, 'x64'), false)
  assert.equal(pathCountsOnThisHost('/home/u/.kimi-webbridge/x', win, 'x64'), false)
  assert.equal(pathCountsOnThisHost('/x/toolkit/nmap.exe', win, 'x64'), true)
})

test('pathCountsOnThisHost：跨系统的名字一律不算（另一套 CPU 的文件名也不拿来判当前系统）', () => {
  assert.equal(pathCountsOnThisHost('/x/toolkit/nmap-linux-amd64', 'win32', 'x64'), false, 'Windows 上不认 linux')
  assert.equal(pathCountsOnThisHost('/x/toolkit/nmap-darwin-arm64', 'win32', 'x64'), false, 'Windows 上不认 darwin')
  assert.equal(pathCountsOnThisHost('/x/toolkit/nmap-windows.exe', 'darwin', 'arm64'), false, 'macOS 上不认 windows')
  assert.equal(pathCountsOnThisHost('/x/toolkit/nmap-linux-arm64', 'linux', 'x64'), false, 'x64 上不认 arm64')
  assert.equal(pathCountsOnThisHost('/x/toolkit/nmap-linux-amd64', 'linux', 'x64'), true)
  assert.equal(pathCountsOnThisHost('/x/toolkit/nmap-darwin-arm64', 'darwin', 'arm64'), true)
})

test('pathCountsOnThisHost：名字里的平台标记要按分隔符边界匹配（linuxfoo 不算 linux）', () => {
  assert.equal(pathCountsOnThisHost('/x/toolkit/linuxfoo', 'win32', 'x64'), true, 'linuxfoo 里 linux 不是独立 token')
  assert.equal(pathCountsOnThisHost('/x/toolkit/foo-linux-bar', 'win32', 'x64'), false, 'foo-linux-bar 里的 linux 是独立 token')
})

test('referencedPathsOf：只留 toolkit / bin / local 下的路径，且要能算到这台机器上', () => {
  // 注意：`pathCountsOnThisHost` 用的是**真实** process.platform / process.arch，
  // 所以「哪些名字算跨系统」在不同平台上是不同的 —— 断言必须按平台分开写，
  // 否则 Linux CI 上 `nmap.exe` 会被剔掉、`nmap-linux-amd64` 反而会留下。
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  const content = [
    '用 `$DSH_HOME/redteam/toolkit/nmap` 扫',
    '还有 `$DSH_HOME/redteam/toolkit/nmap.exe`',
    '以及 `$DSH_HOME/redteam/toolkit/nmap-linux-amd64`',
    '配置在 `~/.config/foo/bar`',
    '模板在 `$DSH_HOME/redteam/toolkit/nuclei-templates/`',
    '示例 `<你的VPS_IP>/bin/x`',
  ].join('\n')
  const out = referencedPathsOf(content)
  assert.ok(out.includes('$DSH_HOME/redteam/toolkit/nmap'), '无后缀的 toolkit 二进制哪台机器都算')
  assert.equal(out.includes('$DSH_HOME/redteam/toolkit/nmap.exe'), isWin, 'exe 只在 Windows 上算')
  assert.equal(out.includes('$DSH_HOME/redteam/toolkit/nmap-linux-amd64'), !isWin && !isMac, 'linux 后缀只在 Linux 上算')
  assert.equal(out.some((p) => p.includes('.config')), false, '不在 toolkit/bin/local 下的不收')
  assert.equal(out.some((p) => p.includes('<')), false, '带占位符的不收')
})

test('referencedPathsOf：中文标点与括号结尾会被剥掉', () => {
  const out = referencedPathsOf('见 `$DSH_HOME/redteam/bin/chisel`，以及（$DSH_HOME/redteam/bin/frpc）')
  assert.ok(out.includes('$DSH_HOME/redteam/bin/chisel'), JSON.stringify(out))
  assert.ok(out.includes('$DSH_HOME/redteam/bin/frpc'), JSON.stringify(out))
})

/* ------------------------------------------------------------------ *
 * 四、技能库归属
 * ------------------------------------------------------------------ */

test('skillLibraryOf：显式 library 直接认，否则按路径猜', () => {
  assert.equal(skillLibraryOf({ library: 'official' }), 'official')
  assert.equal(skillLibraryOf({ library: 'redteam' }), 'redteam')
  assert.equal(skillLibraryOf({ path: '/h/skills/redteam/a.md' }), 'redteam')
  assert.equal(skillLibraryOf({ path: '/h/redteam/skills/a.md' }), 'redteam')
  assert.equal(skillLibraryOf({ path: '/h/skills/a.md' }), 'official')
  assert.equal(skillLibraryOf({ resourceBase: { path: '/h/skills/redteam' } }), 'redteam')
  assert.equal(skillLibraryOf({ path: '/nowhere/a.md' }), '')
  assert.equal(skillLibraryOf(null), '')
  assert.equal(skillLibraryOf('x'), '')
})

test('skillLibraryOf：反斜杠路径也能认出来', () => {
  assert.equal(skillLibraryOf({ path: 'C:\\Users\\u\\.dsh\\skills\\redteam\\a.md' }), 'redteam')
  assert.equal(skillLibraryOf({ path: 'C:\\Users\\u\\.dsh\\skills\\a.md' }), 'official')
})

/* ------------------------------------------------------------------ *
 * 五、从技能根里读同名正文
 * ------------------------------------------------------------------ */

test('readSkillFromRoot：认 <root>/<name>.md 与 <root>/<name>/SKILL.md 两种布局', () => {
  const root = freshHome('root')
  fs.writeFileSync(path.join(root, 'flat.md'), '# flat\n')
  fs.mkdirSync(path.join(root, 'bundled'), { recursive: true })
  fs.writeFileSync(path.join(root, 'bundled', 'SKILL.md'), '# bundled\n')
  assert.deepEqual(readSkillFromRoot(root, 'flat'), { path: path.join(root, 'flat.md'), content: '# flat\n' })
  assert.deepEqual(readSkillFromRoot(root, 'bundled'), { path: path.join(root, 'bundled', 'SKILL.md'), content: '# bundled\n' })
  assert.equal(readSkillFromRoot(root, 'missing'), null)
  assert.equal(readSkillFromRoot('', 'x'), null, '空 root 直接 null')
  assert.equal(readSkillFromRoot(null, 'x'), null)
  assert.equal(readSkillFromRoot(root, null), null, '名字为空时探不到任何文件')
})

test('readSkillFromRoot：<root>/SKILL.md 也能被 <root>/<name> 那一轮命中', () => {
  const root = freshHome('root2')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'sub', 'SKILL.md'), '# sub\n')
  // 传 root 的父级，靠 resolve(root, name) 那一轮进去
  const out = readSkillFromRoot(root, 'sub')
  assert.equal(out.content, '# sub\n')
})

/* ------------------------------------------------------------------ *
 * 六、checkSkill：判定主体
 * ------------------------------------------------------------------ */

test('checkSkill：正文读不到 + 文件真不在 → broken（file-missing）', () => {
  const out = checkSkill({ name: 'x', content: '', path: path.join(sandbox, 'nope.md') })
  assert.equal(out.status, 'broken')
  assert.equal(out.issues[0].kind, 'file-missing')
  assert.match(out.issues[0].detail, /技能文件在本机不存在/)
  assert.deepEqual(out.needs_user, [])
  assert.equal(typeof out.issues[0].fix, 'string', '每条问题都要带修复方法')
})

test('checkSkill：正文读不到但没有文件路径 → unknown（content-missing），不算坏', () => {
  const out = checkSkill({ name: 'x', content: '   ' })
  assert.equal(out.status, 'unknown')
  assert.equal(out.issues[0].kind, 'content-missing')
  assert.match(out.issues[0].detail, /只有元数据/)
})

test('checkSkill：正文在手 = 能加载，路径指空只记 file-stale 且仍是 available', () => {
  const out = checkSkill({ name: 'x', content: '# 有正文\n', path: path.join(sandbox, 'gone.md') }, { env: {} })
  assert.equal(out.status, 'available', '换机器后路径必然指空，不能据此判不可用')
  const stale = out.issues.find((i) => i.kind === 'file-stale')
  assert.ok(stale, JSON.stringify(out.issues))
  assert.match(stale.detail, /技能正文仍可加载/)
})

test('checkSkill：缺环境变量记 env-missing，并进 needs_user', () => {
  const out = checkSkill({ name: 'x', content: 'process.env.FOFA_KEY' }, { env: {} })
  assert.equal(out.status, 'available')
  assert.equal(out.issues[0].kind, 'env-missing')
  assert.match(out.issues[0].detail, /FOFA_KEY/)
  assert.deepEqual(out.needs_user, ['环境变量 FOFA_KEY'])
  assert.deepEqual(out.checked.missing_env, ['FOFA_KEY'])
  const ok = checkSkill({ name: 'x', content: 'process.env.FOFA_KEY' }, { env: { FOFA_KEY: 'v' } })
  assert.equal(ok.issues.length, 0, '配上了就不报')
})

test('checkSkill：引用的本机路径不存在记 path-missing，超过 6 处只列前 6 个', () => {
  // 文件名不能带 `.exe`：`pathCountsOnThisHost` 在非 Windows 上会把它判成「跨系统二进制」
  // 直接剔掉，那样一条 path-missing 都造不出来（Linux CI 上就是这么红的）。
  const lines = []
  for (let i = 0; i < 9; i += 1) lines.push('$DSH_HOME/redteam/toolkit/missing' + i)
  const out = checkSkill({ name: 'x', content: lines.join('\n') }, { env: { DSH_HOME: freshHome() } })
  const issue = out.issues.find((i) => i.kind === 'path-missing')
  assert.ok(issue, JSON.stringify(out.issues))
  assert.match(issue.detail, /等 9 处/)
  assert.equal(issue.paths.length, 9, 'issues 里保留完整清单')
})

test('checkSkill：占位符在 VPS 没配时记 placeholder，配了就完全不提', () => {
  const content = '把 <你的VPS_IP> 换成真地址，主机名 <你的VPS_主机名>'
  const without = checkSkill({ name: 'x', content }, { env: {} })
  assert.deepEqual(without.needs_user.sort(), ['VPS 地址', 'VPS 主机名'].sort())
  const withVps = checkSkill({ name: 'x', content }, { env: { REDTEAM_VPS_HOST: '1.2.3.4' } })
  assert.equal(withVps.issues.some((i) => i.kind === 'placeholder'), false, '配好 VPS 后占位符只是文档写法')
  assert.deepEqual(withVps.needs_user, [])
})

test('checkSkill：空白字符串的 VPS 配置不算配（trim 后为空）', () => {
  const out = checkSkill({ name: 'x', content: '<VPS_IP>' }, { env: { REDTEAM_VPS_HOST: '   ' } })
  assert.equal(out.issues.some((i) => i.kind === 'placeholder'), true)
})

test('checkSkill：同名技能在别的根里问题更少时如实说明 shadowed', () => {
  const good = freshHome('good')
  fs.writeFileSync(path.join(good, 'dup.md'), '# 干净的正文\n')
  const badRoot = freshHome('bad')
  const out = checkSkill(
    { name: 'dup', content: 'process.env.MISSING_KEY_XYZ', root: badRoot },
    { env: {}, sameNameIn: [good, badRoot] },
  )
  const shadow = out.issues.find((i) => i.kind === 'shadowed')
  assert.ok(shadow, JSON.stringify(out.issues))
  assert.equal(out.shadowed_by, good)
  assert.equal(out.shadowed_path, path.join(good, 'dup.md'))
  assert.equal(shadow.other_root, good)
})

test('checkSkill：别的根里内容一样或问题更多时不说 shadowed', () => {
  const rootA = freshHome('a')
  const rootB = freshHome('b')
  fs.writeFileSync(path.join(rootB, 'same.md'), 'process.env.MISSING_KEY_XYZ')
  const same = checkSkill(
    { name: 'same', content: 'process.env.MISSING_KEY_XYZ', root: rootA },
    { env: {}, sameNameIn: [rootB] },
  )
  assert.equal(same.issues.some((i) => i.kind === 'shadowed'), false, '内容一样不算被盖住')
  assert.equal(same.shadowed_by, undefined)
})

test('checkSkill：summarizeSkills 逐状态计数', () => {
  const out = summarizeSkills([
    { status: 'available' },
    { status: 'available' },
    { status: 'broken' },
    { status: 'unknown' },
  ])
  assert.deepEqual(out, { total: 4, available: 2, broken: 1, unknown: 1 })
  assert.deepEqual(summarizeSkills([]), { total: 0, available: 0, broken: 0, unknown: 0 })
})

/* ------------------------------------------------------------------ *
 * 七、红队技能筛选与打包兜底
 * ------------------------------------------------------------------ */

test('redteamSummariesForCheck：官方技能剔除，红队与同名打包技能保留，同名只留第一份', () => {
  const out = redteamSummariesForCheck(
    [
      { name: 'a', path: '/h/skills/a.md' }, // official → 剔
      { name: 'b', path: '/h/skills/redteam/b.md' },
      { name: 'c', path: '/h/other/c.md' }, // 说不清库 → 剔（除非 scoped）
      { name: 'b', path: '/h/skills/redteam/b2.md' }, // 同名 → 剔
    ],
    [{ name: 'bundled-one', content: 'x' }],
    false,
  )
  assert.deepEqual(out.map((x) => x.name), ['b', 'bundled-one'])
})

test('redteamSummariesForCheck：scoped=true 时说不清库的也收；打包里的同名不重复加', () => {
  const out = redteamSummariesForCheck(
    [{ name: 'c', path: '/h/other/c.md' }, { name: 'bundled-one' }],
    [{ name: 'bundled-one' }, { name: 'bundled-two' }],
    true,
  )
  assert.deepEqual(out.map((x) => x.name), ['c', 'bundled-one', 'bundled-two'])
})

test('redteamSummariesForCheck：入参不是数组时按空处理，不抛', () => {
  assert.deepEqual(redteamSummariesForCheck(null, null, false), [])
  assert.deepEqual(redteamSummariesForCheck(undefined, undefined, true), [])
})

test('bundledSkillSummaries：本包的 skills/redteam 至少有若干条，且都带正文与路径', () => {
  const out = bundledSkillSummaries()
  assert.ok(out.length >= 10, '本仓 skills/redteam 里有一批 .md：' + out.length)
  for (const item of out.slice(0, 5)) {
    assert.equal(typeof item.name, 'string')
    assert.equal(item.library, 'redteam')
    assert.ok(item.content.length > 0, item.name + ' 要有正文')
    assert.ok(item.path.endsWith('.md'), item.path)
    assert.equal(item.resourceBase.kind, 'directory')
  }
})

test('bundledSkillSummaries：$DSH_HOME/redteam/skills 里的技能也会被收进来', () => {
  const home = freshHome('bt')
  fs.mkdirSync(path.join(home, 'redteam', 'skills'), { recursive: true })
  fs.writeFileSync(path.join(home, 'redteam', 'skills', 'zz-test-only-skill.md'), '# 测试技能\n\n正文\n')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const out = bundledSkillSummaries()
    const hit = out.find((x) => x.name === 'zz-test-only-skill')
    assert.ok(hit, 'DSH_HOME 下的红队技能要能列出来')
    assert.equal(hit.description, '测试技能', 'description 取第一行 # 标题')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('officialSkillSummaries：目录形态读 SKILL.md、扁平形态读 <name>.md、跳过 .system 与空文件', () => {
  const home = freshHome('off')
  const dir = path.join(home, 'skills')
  fs.mkdirSync(path.join(dir, 'bundled'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'bundled', 'SKILL.md'), '---\ndescription: 打包技能\n---\n正文\n')
  fs.writeFileSync(path.join(dir, 'flat.md'), '# 扁平技能\n')
  fs.mkdirSync(path.join(dir, '.system'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.system', 'SKILL.md'), '# 系统\n')
  fs.mkdirSync(path.join(dir, '.hidden'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.hidden', 'SKILL.md'), '# 隐藏\n')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# 根上的 SKILL.md 不算技能\n')
  fs.mkdirSync(path.join(dir, 'empty'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'empty', 'SKILL.md'), '   \n')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const out = officialSkillSummaries()
    assert.deepEqual(out.map((x) => x.name).sort(), ['bundled', 'flat'])
    const bundled = out.find((x) => x.name === 'bundled')
    assert.equal(bundled.description, '打包技能', 'frontmatter 的 description 优先')
    assert.equal(bundled.library, 'official')
    assert.equal(out.find((x) => x.name === 'flat').description, '扁平技能', '没有 frontmatter 就用 # 标题')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('officialSkillSummaries：skills 目录不存在时回空数组，不抛', () => {
  const home = freshHome('none')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.deepEqual(officialSkillSummaries(), [])
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})
