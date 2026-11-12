/**
 * 行尾审计的纯逻辑（不读盘、不调 git，方便单测）。
 *
 * 背景：本仓库的行尾约定是「按目录分工」，不是全库统一 —— lib/**\/*.js 是 CRLF
 * （跟宿主解包出来的源码一致，补丁锚点按 CRLF 写），scripts/*.mjs 是 LF，
 * README 等文档是 CRLF。约定本身没问题，问题是它从来没被检查过：
 * 2026-11-12 拆 store-core.js 时，新文件 score-report.js 就差点以 LF 入库
 * （这台机器上有两个 git，system 级 autocrlf=true 的那个会偷偷转换）。
 *
 * 这里不重写规则，只做三件事：
 *   1. 一个文件内部不许混行尾（混了之后任何跨行锚点都会 MISS）；
 *   2. 已入库文件的行尾不许悄悄改变（改了要显式 --update）；
 *   3. 新文件按「同目录多数派」推断，推断不出来就只提示、不拦。
 */

/** 允许混行尾的文件：两个都是上游产物的逐字节锚点，不能动。 */
export const MIXED_ALLOWED = new Set([
  'client.js',
  'docs/origin/client-1.1.94.js',
])

/** 只统计这些后缀；其余（图片、二进制、无后缀）一律跳过。 */
const TEXT_EXT = /\.(?:js|mjs|cjs|json|md|yml|yaml|ps1|sh|txt|html|css|svg|wscript)$/i

export function isTextPath(path) {
  return TEXT_EXT.test(String(path || ''))
}

/**
 * 数行尾。注意只数 `\n`：一个文件里 `\r\n` 的数量永远 ≤ `\n` 的数量，
 * 两者相等就是纯 CRLF，`\r\n` 为 0 就是纯 LF，介于两者之间就是混的。
 */
export function classifyText(text) {
  const s = String(text ?? '')
  const lf = (s.match(/\n/g) || []).length
  const crlf = (s.match(/\r\n/g) || []).length
  const kind = lf === 0 ? 'none' : crlf === 0 ? 'lf' : crlf === lf ? 'crlf' : 'mixed'
  return { lf, crlf, kind, lfOnly: lf - crlf }
}

/** 目录部分，根目录文件返回 `''`。 */
export function dirOf(path) {
  const p = String(path || '').replaceAll('\\', '/')
  const at = p.lastIndexOf('/')
  return at < 0 ? '' : p.slice(0, at)
}

/**
 * 从 baseline 的 `files` 映射里算每个目录的多数派。
 * 目录里的文件少于 `minSamples` 个时不算数（避免一个文件的目录把规则定死）。
 */
export function directoryMajority(files, minSamples = 3) {
  const tally = new Map()
  for (const [path, kind] of Object.entries(files || {})) {
    if (kind !== 'crlf' && kind !== 'lf') continue
    const dir = dirOf(path)
    if (!tally.has(dir)) tally.set(dir, { crlf: 0, lf: 0 })
    tally.get(dir)[kind] += 1
  }
  const out = new Map()
  for (const [dir, count] of tally) {
    const total = count.crlf + count.lf
    if (total < minSamples) continue
    if (count.crlf === count.lf) continue
    out.set(dir, count.crlf > count.lf ? 'crlf' : 'lf')
  }
  return out
}

/**
 * 审计。
 * @param {object} input
 * @param {Array<{path: string, text: string}>} input.entries 当前工作区里的文本文件
 * @param {Record<string, string>} input.baseline `path -> 'crlf' | 'lf'`
 * @returns {{errors: Array, warnings: Array, files: Record<string,string>, added: string[], changed: string[]}}
 */
export function auditEol({ entries = [], baseline = {} } = {}) {
  const files = {}
  const errors = []
  const warnings = []
  const added = []
  const changed = []
  const majority = directoryMajority(baseline)

  for (const entry of entries) {
    const path = String(entry?.path || '').replaceAll('\\', '/')
    if (!path || !isTextPath(path)) continue
    const { kind, lf, crlf } = classifyText(entry.text)
    if (kind === 'none') continue
    files[path] = kind

    if (kind === 'mixed') {
      if (!MIXED_ALLOWED.has(path)) {
        errors.push({
          code: 'mixed',
          path,
          detail: `${crlf} 行 CRLF / ${lf - crlf} 行 LF —— 同一个文件里混了两种行尾，跨行锚点会全部对不上`,
        })
      }
      continue
    }

    const was = baseline[path]
    if (!was) {
      const want = majority.get(dirOf(path))
      if (want && want !== kind) {
        errors.push({
          code: 'new-file-wrong-eol',
          path,
          detail: `新文件是 ${kind.toUpperCase()}，但同目录多数派是 ${want.toUpperCase()}`,
        })
      } else if (!want) {
        warnings.push({
          code: 'new-file-unknown-dir',
          path,
          detail: `新文件是 ${kind.toUpperCase()}，目录里样本太少推不出多数派，请确认后 --update 记进基线`,
        })
      }
      added.push(path)
      continue
    }

    if (was !== kind) {
      errors.push({
        code: 'eol-changed',
        path,
        detail: `行尾从 ${was.toUpperCase()} 变成了 ${kind.toUpperCase()}（要改就 --update 显式接受）`,
      })
      changed.push(path)
    }
  }

  // 基线里有、工作区里没有的：文件被删了，不算错，但要让调用方知道。
  const removed = Object.keys(baseline).filter((path) => !(path in files))

  return { errors, warnings, files, added, changed, removed }
}

/**
 * 判断 git 存的 blob 与工作区内容是否只差一次行尾转换。
 *
 * 这是 2026-11-12 那次事故的指纹：`git add` 时 autocrlf 把 CRLF 压成 LF，
 * 工作区看着没问题、`npm run check` 也全绿，但仓库里存的是另一份字节。
 * 只在这种「仅差行尾」的形态下报警 —— 普通未提交改动（内容真的不同）不报。
 */
export function isEolConvertedOnly(worktreeText, blobText) {
  const a = String(worktreeText ?? '')
  const b = String(blobText ?? '')
  if (a === b) return false
  const strip = (s) => s.replace(/\r\n/g, '\n')
  return strip(a) === strip(b)
}
