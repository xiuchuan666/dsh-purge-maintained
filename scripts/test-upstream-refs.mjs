/**
 * 上游引用守门：出厂面（lib / bin / scripts / presets / skills / .github / 根文件）
 * 里不许再出现已删库的上游仓库地址与联系方式。
 *
 * 为什么需要这条：2026-11 上游 `HunYiSage/dsh-purge` 永久删库，本仓库接管维护。
 * 残留的上游地址不会让程序崩，但会让「演练台检查更新」「欢迎页链接」指向 404，
 * 而且这类残留散在 545KB 的成品 client.js 里，靠肉眼 review 抓不住。
 *
 * 允许清单按「文件 + 理由」登记：命中清单内的文件跳过，命中清单外的立刻失败。
 * 反向也查一遍——清单里登记了但文件已经没有引用的条目要报「清单过期」，
 * 否则清单会越积越松，最后等于没有。
 *
 * 不扫描 docs/：那是历史设计与决策记录，写明「当时指向哪里」才有追溯价值；
 * 其中 docs/origin/ 更是 1.1.94 原始快照（哈希锚点），必须逐字保留。
 * 本测试只管「会被安装、会被执行、会出现在界面上」的那部分文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = 'scripts/test-upstream-refs.mjs'

/** 上游痕迹。全部是「指向已删库」的字符串，不是通用词。 */
const PATTERNS = [
  { name: '上游仓库', re: /HunYiSage\/dsh-purge/g },
  { name: '上游分叉', re: /YuJunZhiXue/g },
  { name: '上游镜像', re: /mmparko/g },
  { name: '上游频道', re: /t\.me\/LLM_PoJia/g },
]

/**
 * 允许清单：`路径或目录前缀` → 为什么允许留。
 * 目录前缀以 `/` 结尾。
 */
const ALLOW = new Map([
  ['NOTICE', 'Apache-2.0 第 4(d) 条要求保留原始署名与来源，删掉即违反许可'],
  ['LICENSE-COMMERCIAL.md', '记录上游商业授权口径与历史渠道，属于法律文件而非代码'],
  ['README.md', '署名章节必须保留原作者标识'],
  ['release-notes.md', '历史发布说明，按版本归档不再改动'],
  ['lib/update.js', '注释说明上游已删库；代码行是否干净由 test-update-source.mjs 单独断言'],
  [SELF, '本测试自身要写出被禁的模式'],
])

const TOP_FILES = [
  'client.js',
  'package.json',
  'cordis.patch.yml',
  'screenshots.json',
  'NOTICE',
  'LICENSE-COMMERCIAL.md',
  'README.md',
  'release-notes.md',
  'MAINTENANCE.md',
]

const SCAN_DIRS = ['lib', 'bin', 'scripts', 'presets', 'skills', '.github']

const TEXT_EXT = /\.(?:js|mjs|cjs|json|md|yml|yaml|txt|html|css|ps1|sh)$/i

/** 收集出厂面里所有文本文件（相对仓库根的 posix 路径）。 */
function collect(relDir, out) {
  const abs = join(ROOT, relDir)
  if (!existsSync(abs)) return
  for (const name of readdirSync(abs)) {
    const rel = relDir ? `${relDir}/${name}` : name
    const full = join(ROOT, rel)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue
      collect(rel, out)
    } else if (TEXT_EXT.test(name)) {
      out.push(rel)
    }
  }
}

function surfaceFiles() {
  const out = []
  for (const f of TOP_FILES) if (existsSync(join(ROOT, f))) out.push(f)
  for (const d of SCAN_DIRS) collect(d, out)
  return out.sort()
}

function allowed(rel) {
  for (const key of ALLOW.keys()) {
    if (key.endsWith('/')) {
      if (rel.startsWith(key)) return true
    } else if (rel === key) {
      return true
    }
  }
  return false
}

/** 返回 `[{ file, line, name, text }]`。 */
function scan() {
  const hits = []
  for (const rel of surfaceFiles()) {
    let text
    try {
      text = readFileSync(join(ROOT, rel), 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0
      for (let i = 0; i < lines.length; i += 1) {
        if (new RegExp(re.source, re.flags.replace('g', '')).test(lines[i])) {
          hits.push({ file: rel, line: i + 1, name, text: lines[i].trim().slice(0, 160) })
        }
      }
    }
  }
  return hits
}

const HITS = scan()
const OFFENDERS = HITS.filter((h) => !allowed(h.file))

test('出厂面里没有指向已删库上游的引用', () => {
  const detail = OFFENDERS.map((h) => `${h.file}:${h.line} [${h.name}] ${h.text}`).join('\n')
  assert.equal(
    OFFENDERS.length,
    0,
    `发现 ${OFFENDERS.length} 处上游引用，要么改成本仓库，要么在 ALLOW 里写明理由：\n${detail}`,
  )
})

test('允许清单没有过期条目', () => {
  const filesWithHit = new Set(HITS.map((h) => h.file))
  const stale = []
  for (const key of ALLOW.keys()) {
    if (key === SELF) continue
    const still = key.endsWith('/')
      ? [...filesWithHit].some((f) => f.startsWith(key))
      : filesWithHit.has(key)
    if (!still) stale.push(key)
  }
  assert.deepEqual(stale, [], `这些文件已经没有上游引用了，从 ALLOW 里删掉：${stale.join(', ')}`)
})

test('成品 client.js 的欢迎页链接指向本仓库', () => {
  const text = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const urls = [...text.matchAll(/"welcome\.repo":\s*"([^"]+)"/g)].map((m) => m[1])
  assert.equal(urls.length, 2, 'zh / en 两套 locale 各一条 welcome.repo')
  for (const u of urls) {
    assert.equal(u, 'https://github.com/xiuchuan666/dsh-purge-maintained')
  }
})

test('演练台兜底仓库指向本仓库', () => {
  const text = readFileSync(join(ROOT, 'lib/redteam/ui.js'), 'utf8')
  const m = text.match(/function githubRepoOf\(homepage\) \{[\s\S]{0,400}?return '([^']+)'\r?\n\}/)
  assert.ok(m, 'githubRepoOf 的兜底分支结构变了，请同步本测试')
  assert.equal(m[1], 'xiuchuan666/dsh-purge-maintained')
})

test('Release 工作流不再认上游仓库，也不再每次推送都空跑', () => {
  const text = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')
  assert.ok(
    /if: github\.repository == 'xiuchuan666\/dsh-purge-maintained'/.test(text),
    'Release 的仓库条件必须写本仓库',
  )
  assert.ok(
    !/^\s{2}push:/m.test(text.split('jobs:')[0]),
    'Release 不再由 push 触发（每次推送空跑一遍没有意义），改由 workflow_dispatch 手动触发',
  )
  assert.ok(/workflow_dispatch/.test(text), '保留手动触发入口')
})
