/**
 * 行尾审计 CLI。
 *
 *   node scripts/check-eol.mjs            按基线校验，有错就退出码 1
 *   node scripts/check-eol.mjs --update   把当前状态写回 docs/eol-baseline.json
 *
 * 校验三件事（规则本身在 check-eol-lib.mjs 里，纯函数、有单测）：
 *   1. 文件内部不许混行尾；
 *   2. 已入库文件的行尾不许悄悄改变；
 *   3. 新文件要符合同目录多数派。
 *
 * 另外单独查一次「索引 blob 与工作区只差行尾」—— 那是 2026-11-12 那次事故的
 * 指纹：git add 时 autocrlf 把 CRLF 压成 LF，本地全绿、仓库里存的是另一份字节。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditEol, isEolConvertedOnly, isTextPath } from './check-eol-lib.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BASELINE = resolve(root, 'docs/eol-baseline.json')
const update = process.argv.includes('--update')

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
}

const tracked = git(['ls-files', '-z'])
  .split('\0')
  .filter(Boolean)
  .filter((path) => isTextPath(path))

const entries = []
for (const path of tracked) {
  let text
  try {
    text = readFileSync(resolve(root, path), 'utf8')
  } catch {
    continue
  }
  if (text.includes('\0')) continue
  entries.push({ path, text })
}

let baseline = {}
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).files || {}
} catch {
  baseline = {}
}

const report = auditEol({ entries, baseline })

if (update) {
  const files = Object.fromEntries(
    Object.entries(report.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  writeFileSync(BASELINE, `${JSON.stringify({ note: '行尾基线：node scripts/check-eol.mjs --update 重新生成', files }, null, 2)}\n`)
  console.log(`[eol] 基线已更新 ${Object.keys(files).length} 个文件（${BASELINE.replaceAll('\\', '/').split('/').slice(-1)[0]}）`)
  process.exit(0)
}

// 索引 blob 与工作区只差行尾 = autocrlf 偷偷转换过。
// 用一次 `git cat-file --batch` 把所有 blob 读出来：逐个 `cat-file blob` 要起
// 227 次进程，实测 2.7 秒，占满了整个 check 的时间预算。
const converted = []
const blobText = readBlobs(entries.map((entry) => entry.path))
for (const entry of entries) {
  const blob = blobText.get(entry.path)
  if (blob === undefined) continue
  if (isEolConvertedOnly(entry.text, blob)) converted.push(entry.path)
}

function readBlobs(paths) {
  const out = new Map()
  if (!paths.length) return out
  const input = paths.map((path) => `:${path}`).join('\n') + '\n'
  let buffer
  try {
    buffer = execFileSync('git', ['cat-file', '--batch'], {
      cwd: root,
      input,
      maxBuffer: 128 * 1024 * 1024,
    })
  } catch {
    return out
  }
  // `--batch` 的输出是「按输入顺序」逐条：`<sha> <type> <size>\n<内容>\n`。
  // 头里**没有路径**，所以只能按顺序对上输入；缺失对象是 `<输入> missing\n`，
  // 只有两段、没有内容。按声明的 size 切片，不能按行切（内容里可能有任意字节）。
  let at = 0
  let index = 0
  while (at < buffer.length && index < paths.length) {
    const headerEnd = buffer.indexOf(0x0a, at)
    if (headerEnd < 0) break
    const header = buffer.subarray(at, headerEnd).toString('utf8')
    at = headerEnd + 1
    const parts = header.split(' ')
    if (parts.length < 3) {
      // `<path> missing` / `<path> ambiguous` —— 这条没有内容，跳过但对上一个输入
      index += 1
      continue
    }
    const size = Number(parts[2])
    if (!Number.isFinite(size) || size < 0) break
    const body = buffer.subarray(at, at + size)
    at += size + 1 // 末尾那个 \n 是 --batch 自己加的
    out.set(paths[index], body.toString('utf8'))
    index += 1
  }
  return out
}

const counts = { crlf: 0, lf: 0, mixed: 0 }
for (const kind of Object.values(report.files)) counts[kind] = (counts[kind] || 0) + 1

console.log(
  `[eol] ${Object.keys(report.files).length} 个文本文件：CRLF ${counts.crlf} / LF ${counts.lf} / 混合 ${counts.mixed}`,
)

for (const warning of report.warnings) console.log(`[eol] ~ ${warning.path}：${warning.detail}`)

const failures = [...report.errors]
for (const path of converted) {
  failures.push({
    path,
    detail: '索引里的 blob 与工作区只差行尾 —— git 的 autocrlf 把它转换了，仓库里存的不是工作区这份字节',
  })
}

if (failures.length) {
  for (const failure of failures) console.error(`[eol] ✖ ${failure.path}：${failure.detail}`)
  console.error(`[eol] FAIL ${failures.length} 处；确认无误后用 --update 接受，或修掉行尾`)
  process.exit(1)
}

console.log(`[eol] PASS ${Object.keys(report.files).length} files`)
