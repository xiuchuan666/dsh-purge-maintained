/**
 * 补丁锚点契约（P2-5）：把注册表里每条补丁的「针」和「打完后的形状」提成可校验的数据。
 *
 * 两种模式：
 *   注册表模式  deriveContracts(patches) / --write 不带 --tree：只描述每条补丁应有的针与产物；
 *   基线模式    deriveContracts(patches, { treeRoot, table, readFile }) / --write --tree DIR：
 *               再记录参考树里实际解析到的文件与每条针的命中次数（anchors）。--check 遇到 anchors
 *               就按基线逐项比对，只对「参考树里真正有落点」的文件负责，不再要求每条针命中每个文件。
 *
 * 与 docs/patch-gates.json 的分工：
 *   patch-gates      回答「这处限制还在不在这个版本的宿主里」——一根短针，行内、可读；
 *   patch-contracts  回答「这条针能不能在目标文件里唯一定位」和「打完之后这段应该长什么样」。
 *
 * 归一化一律走 lib/patch-outcome.mjs（normalizeText / patchReplacements / patchProducts /
 * isRetractionPatch）：注册表有 replacements[] 与 patterns[]+replace 两种形态，宿主文件是 CRLF
 * 而针按 LF 写。第二份实现必然会和 applier 漂移，契约就会对着一个不存在的 pattern 说话。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  TRACE_TOKEN,
  isRetractionPatch,
  normalizeText,
  patchProducts,
  patchReplacements,
} from './patch-outcome.mjs'

export const CONTRACT_SCHEMA = 1
export const CONTRACT_KIND = 'dsh-patch-contracts'
export const CONTRACT_STATUSES = Object.freeze(['ok', 'missing', 'ambiguous', 'na'])
export const CONTRACT_NOTE =
  '由 node scripts/patch-contracts.mjs --write 从 lib/patches 生成，勿手改；--check 拿它校验任意宿主树'

const NEWLINE = String.fromCharCode(10)
const BACKSLASH = String.fromCharCode(92)

/** 补丁的 file 字段：数组、单串、或逗号分隔的历史写法（lib/core.js 也按逗号切）。 */
export function fileKeysOf(patch) {
  const raw = patch && patch.file
  const keys = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  const out = []
  for (const key of keys) {
    const text = String(key === undefined || key === null ? '' : key).trim()
    if (text && out.indexOf(text) < 0) out.push(text)
  }
  return out
}

function patternTextOf(pattern) {
  if (pattern instanceof RegExp) return pattern.source
  return typeof pattern === 'string' ? pattern : ''
}

// g/y 必须摘掉，否则重复 exec 会因 lastIndex 漂移给出假的命中数。
function flagsOf(pattern) {
  return pattern instanceof RegExp ? String(pattern.flags || '').replace(/[gy]/g, '') : ''
}

/**
 * 跨行针：字符串里带真换行，或正则用 \n / \r / \s\S 跨行匹配。
 * 记这个字段是因为按行找的工具（patch-gates 那一类）对跨行针会直接失配，
 * 读契约时要能一眼看出「这条针不能按行定位」。
 */
export function isCrossLineNeedle(text, regex) {
  if (!text) return false
  if (text.indexOf(NEWLINE) >= 0) return true
  if (!regex) return false
  return (
    text.indexOf(BACKSLASH + 'n') >= 0 ||
    text.indexOf(BACKSLASH + 'r') >= 0 ||
    text.indexOf(BACKSLASH + 's' + BACKSLASH + 'S') >= 0
  )
}

/** 证据里给人看的一行摘要：第一条非空行，剪到 limit。 */
export function needleExcerpt(text, limit = 72) {
  const flat = normalizeText(text)
  for (const line of flat.split(NEWLINE)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    return trimmed.length > limit ? trimmed.slice(0, limit) + '...' : trimmed
  }
  return ''
}

// replace 产物里带 [dsh-purge] 的那些行。这是唯一一个官方代码里不可能出现的「已打上」证据，
// 所以它单独成一份（products 里混着官方文案，没有基线时不能当证据用）。
function traceProbesOf(patch) {
  const out = []
  for (const rep of patchReplacements(patch)) {
    const text = rep && typeof rep.replace === 'string' ? normalizeText(rep.replace) : ''
    if (text.indexOf(TRACE_TOKEN) < 0) continue
    for (const line of text.split(NEWLINE)) {
      const trimmed = line.trim()
      if (trimmed.indexOf(TRACE_TOKEN) >= 0 && out.indexOf(trimmed) < 0) out.push(trimmed)
    }
  }
  return out
}

function defaultReadFile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 参考树自身声明的宿主版本；没有 package.json 时退回目录名。 */
function readHostLabel(root) {
  for (const rel of ['package.json', 'dsh/package.json', 'resources/app/package.json']) {
    const text = defaultReadFile(path.join(root, ...rel.split('/')))
    if (!text) continue
    try {
      const data = JSON.parse(text)
      if (data && data.version) return String(data.version)
    } catch {
      // 下一个候选
    }
  }
  return path.basename(root) || 'reference'
}

/** 写进契约的 root 只保留相对信息，绝不落绝对路径。 */
function relativeRoot(root) {
  const rel = path.relative(process.cwd(), root)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/')
  return path.basename(root) || '.'
}

/**
 * 参考树基线：只记录「实际读到、且至少有一条针命中」的文件。
 * hits 与 needles 一一对应；某个文件对某条针是 0 是正常事实（#43 的四个 preset 各只带一条针），
 * 不能把 0 当成缺文件，也不能要求每条针命中每个目标文件。
 */
function buildAnchors(files, needles, treeRoot, table, readFile) {
  const anchors = []
  const seen = new Set()
  for (const key of files || []) {
    for (const raw of candidatesOf(table, key)) {
      const abs = path.resolve(raw)
      if (!insideRoot(treeRoot, abs)) continue
      const file = relOf(treeRoot, abs)
      if (seen.has(file)) continue
      seen.add(file)
      const text = readFile(abs)
      if (text === null || text === undefined) continue
      const hits = (needles || []).map((needle) => countHits(text, needle))
      if (!hits.some((count) => count > 0)) continue
      anchors.push({ key, file, hits })
    }
  }
  return anchors
}

/**
 * 注册表 → 契约。不猜、不补、不省：针就是 pattern 原文，产物就是 replace 原文。
 * 给了 treeRoot 时额外记录 anchors 与 reference；table 必须由调用方先用
 * resolveTargetTable(treeRoot) 解析（CLI 的 --write --tree 已经这么做），避免库层重复实现宿主布局。
 * 输出按 id 升序，稳定（同一份注册表永远得到同一份字节）。
 */
export function deriveContracts(patches, options = {}) {
  const treeRoot = options.treeRoot ? path.resolve(String(options.treeRoot)) : ''
  const table = options.table || null
  if (treeRoot && !table) {
    throw new Error('deriveContracts: options.table is required with treeRoot; use resolveTargetTable(treeRoot)')
  }
  const readFile = typeof options.readFile === 'function' ? options.readFile : defaultReadFile
  const reference = treeRoot
    ? { host: String(options.label || options.host || readHostLabel(treeRoot)), root: relativeRoot(treeRoot) }
    : null
  const out = []
  for (const patch of patches || []) {
    if (!patch || !Number.isInteger(patch.id)) continue
    const needles = []
    const replacements = []
    patchReplacements(patch).forEach((rep, index) => {
      const pattern = rep && rep.pattern
      const text = patternTextOf(pattern)
      if (!text) return
      const regex = pattern instanceof RegExp
      needles.push({
        index,
        pattern: text,
        regex,
        flags: flagsOf(pattern),
        crossLine: isCrossLineNeedle(text, regex),
        excerpt: needleExcerpt(text),
      })
      replacements.push({
        index,
        regex,
        replace: rep && typeof rep.replace === 'string' ? rep.replace : '',
      })
    })
    out.push({
      id: patch.id,
      name: patch.name || '',
      files: fileKeysOf(patch),
      optional: Boolean(patch.optional),
      crossLine: needles.some((needle) => needle.crossLine),
      retraction: Boolean(isRetractionPatch(patch)),
      needles,
      replacements,
      // 产物探针沿用 lib/patch-outcome.mjs 的规则（首行前 60 字符），
      // 「打上了」在契约里和结果页是同一个判据，不另立一套。
      products: patchProducts(patch),
      traceProbes: traceProbesOf(patch),
      anchors: treeRoot ? buildAnchors(fileKeysOf(patch), needles, treeRoot, table, readFile) : null,
    })
  }
  out.sort((a, b) => a.id - b.id)
  if (reference) out.reference = reference
  return out
}

/** 契约表的规范序列化：id 升序、字段顺序固定、LF、结尾一个换行。 */
export function serializeContracts(contracts) {
  const patches = (Array.isArray(contracts) ? contracts.slice() : []).sort((a, b) => a.id - b.id)
  const payload = { schema: CONTRACT_SCHEMA, kind: CONTRACT_KIND, note: CONTRACT_NOTE }
  if (contracts && contracts.reference) payload.reference = contracts.reference
  payload.patches = patches
  return JSON.stringify(payload, null, 2) + NEWLINE
}

export function saveContracts(file, contracts) {
  const text = serializeContracts(contracts)
  const target = path.resolve(String(file))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text, 'utf8')
  return {
    file: target,
    patches: Array.isArray(contracts) ? contracts.length : 0,
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}

function normalizeNeedle(needle, index) {
  const pattern = String((needle && needle.pattern) || '')
  const regex = Boolean(needle && needle.regex)
  return {
    index: Number.isInteger(needle && needle.index) ? needle.index : index,
    pattern,
    regex,
    flags: String((needle && needle.flags) || '').replace(/[gy]/g, ''),
    crossLine: needle && needle.crossLine !== undefined
      ? Boolean(needle.crossLine)
      : isCrossLineNeedle(pattern, regex),
    excerpt: String((needle && needle.excerpt) || needleExcerpt(pattern)),
  }
}

function normalizeContract(entry) {
  const needles = (Array.isArray(entry && entry.needles) ? entry.needles : [])
    .map((needle, index) => normalizeNeedle(needle, index))
    .filter((needle) => needle.pattern)
  const replacements = (Array.isArray(entry && entry.replacements) ? entry.replacements : [])
    .map((rep, index) => ({
      index: Number.isInteger(rep && rep.index) ? rep.index : index,
      regex: Boolean(rep && rep.regex),
      replace: String((rep && rep.replace) || ''),
    }))
  const anchors = Array.isArray(entry && entry.anchors)
    ? entry.anchors.map((anchor) => ({
      key: String((anchor && anchor.key) || ''),
      file: String((anchor && anchor.file) || '').replace(/[\\]+/g, '/'),
      hits: (Array.isArray(anchor && anchor.hits) ? anchor.hits : []).map((count) => (
        Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
      )),
    })).filter((anchor) => anchor.file)
    : null
  return {
    id: entry && Number.isInteger(entry.id) ? entry.id : -1,
    name: String((entry && entry.name) || ''),
    files: Array.isArray(entry && entry.files) ? entry.files.map((key) => String(key)) : [],
    optional: Boolean(entry && entry.optional),
    crossLine: Boolean((entry && entry.crossLine) || needles.some((needle) => needle.crossLine)),
    retraction: Boolean(entry && entry.retraction),
    needles,
    replacements,
    products: Array.isArray(entry && entry.products) ? entry.products.map((probe) => String(probe)) : [],
    traceProbes: Array.isArray(entry && entry.traceProbes)
      ? entry.traceProbes.map((probe) => String(probe))
      : [],
    anchors,
  }
}

/** 读契约表：接受带 schema 包装的对象或裸数组，字段一律重新规范化（手改过的表也能读）。 */
export function loadContracts(file) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(String(file)), 'utf8'))
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.patches) ? raw.patches : null
  if (!list) throw new Error('contracts file has no patches array: ' + String(file))
  const contracts = list.map(normalizeContract).sort((a, b) => a.id - b.id)
  contracts.reference = raw && !Array.isArray(raw) && raw.reference && typeof raw.reference === 'object'
    ? raw.reference
    : null
  return contracts
}

/** 针在文本里的出现次数（非重叠）。字符串针按原文数，正则针按匹配段数。 */
export function countHits(text, needle) {
  const hay = normalizeText(text)
  if (needle && needle.regex) return countRegexHits(hay, needle.pattern, needle.flags)
  const pattern = normalizeText(needle && needle.pattern ? needle.pattern : '')
  if (!pattern) return 0
  let hits = 0
  let at = hay.indexOf(pattern)
  while (at >= 0) {
    hits += 1
    at = hay.indexOf(pattern, at + pattern.length)
  }
  return hits
}

function countRegexHits(hay, source, flags) {
  const set = new Set(String(flags || '').split(''))
  set.add('g')
  let re
  try {
    re = new RegExp(source, [...set].join(''))
  } catch {
    return 0
  }
  let hits = 0
  let guard = 0
  let match = re.exec(hay)
  while (match) {
    hits += 1
    if (match[0].length === 0) re.lastIndex += 1
    guard += 1
    if (guard > 50000) break
    match = re.exec(hay)
  }
  return hits
}

function candidatesOf(table, key) {
  const value = table ? table[key] : undefined
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item)
  return typeof value === 'string' && value ? [value] : []
}

function insideRoot(root, file) {
  const rel = path.relative(root, file)
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 默认的 key → 路径映射：直接用宿主的 targetFiles（lib/core.js），不在这里重写一遍布局。
 * 一棵宿主的包树有几种常见布局：app 树本身、app/dsh、node_modules/@deepseek-ai、
 * asar 里的 dsh/node_modules/@deepseek-ai、resources/app（可能再套一层 dsh/node_modules）……
 * 每个候选 base 只有存在才试；targetFiles 拿到哪个 base，就按哪个 base 拼包路径。
 * 最后只留树内的路径 —— 这样 checkTree 永远是「只对这一棵树下结论」。
 */
async function defaultTable(root) {
  let core
  try {
    core = await import('./core.js')
  } catch {
    return {}
  }
  if (typeof core.targetFiles !== 'function') return {}
  const bases = [
    root,
    path.join(root, 'dsh'),
    path.join(root, 'node_modules', '@deepseek-ai'),
    path.join(root, 'dsh', 'node_modules', '@deepseek-ai'),
    path.join(root, 'resources', 'app'),
    path.join(root, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai'),
    path.join(root, 'app'),
    path.join(root, 'app', 'dsh', 'node_modules', '@deepseek-ai'),
  ]
  const merged = {}
  for (const base of bases) {
    let table = {}
    try {
      table = core.targetFiles(base) || {}
    } catch {
      table = {}
    }
    for (const key of Object.keys(table)) {
      for (const file of candidatesOf(table, key)) {
        if (!insideRoot(root, path.resolve(file))) continue
        if (!merged[key]) merged[key] = []
        if (merged[key].indexOf(file) < 0) merged[key].push(file)
      }
    }
  }
  return merged
}

function relOf(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

/** CLI / 调用方用的目标表解析：只暴露「树 → key → 绝对路径」这一步。 */
export async function resolveTargetTable(treeRoot) {
  return defaultTable(path.resolve(String(treeRoot)))
}

/**
 * 基线契约：anchors 是参考树里实际有落点的文件 × 每条针的命中次数。
 * 判定按 anchor 逐项做，文件缺失 / 命中 0 / 次数变化各自有明确状态；
 * 没有失败 anchor 就是 ok，不因为「另一个文件本来就不含这条针」报错。
 */
function resolveAnchorFile(root, table, key, rel, readFile) {
  const mapped = candidatesOf(table, key)
    .map((file) => path.resolve(file))
    .filter((file) => insideRoot(root, file))
  if (mapped.length > 0) {
    const exact = mapped.find((file) => relOf(root, file) === rel)
    if (exact) return exact
    const existing = mapped.find((file) => readFile(file) !== null && readFile(file) !== undefined)
    if (existing) return existing
    return mapped[0]
  }
  return path.join(root, ...rel.split('/'))
}

function checkBaselineContract(contract, root, table, readFile, options = {}) {
  const productEvidence = options.productEvidence || 'trace'
  const needles = (contract && contract.needles) || []
  const anchors = (contract && contract.anchors) || []
  const evidenceFiles = []
  const base = {
    optional: Boolean(contract.optional),
    retraction: Boolean(contract.retraction),
    crossLine: Boolean(contract.crossLine),
    needles: needles.length,
    keys: (contract && contract.files) || [],
    files: evidenceFiles,
    firstNeedle: (contract.needles && contract.needles[0] && contract.needles[0].excerpt) || '',
    productEvidence,
    baseline: true,
    anchors: anchors.length,
  }
  const row = (status, phase, file, hits, reason, failures) => ({
    id: contract.id,
    name: contract.name || '',
    status,
    file,
    hits,
    evidence: { ...base, phase, reason, failures: failures || [] },
  })

  if (anchors.length === 0) {
    return row('na', 'no-anchor', '', 0,
      'reference baseline has no anchor: patch has no needle hit in the reference tree')
  }

  const failures = []
  let pending = 0
  let applied = 0
  let absent = 0
  for (const anchor of anchors) {
    const key = String((anchor && anchor.key) || '')
    const rel = String((anchor && anchor.file) || '')
    const expected = (Array.isArray(anchor && anchor.hits) ? anchor.hits : []).map((count) => (
      Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
    ))
    if (!rel) continue
    const abs = resolveAnchorFile(root, table, key, rel, readFile)
    const shown = relOf(root, abs)
    const text = readFile(abs)
    if (text === null || text === undefined) {
      absent += 1
      evidenceFiles.push({ key, file: shown, exists: false, hits: null, trace: false, product: false, baseline: expected })
      if (!contract.optional) {
        failures.push({ key, file: shown, kind: 'absent-file', reason: 'target file for key ' + key + ' not found' })
      }
      continue
    }
    const hits = needles.map((needle) => countHits(text, needle))
    const trace = (contract.traceProbes || []).some((probe) => countHits(text, { pattern: probe }) > 0)
    const product = trace || (productEvidence === 'any'
      ? (contract.products || []).some((probe) => countHits(text, { pattern: probe }) > 0)
      : false)
    evidenceFiles.push({ key, file: shown, exists: true, hits, trace, product, baseline: expected })
    const exact = expected.length === hits.length && expected.every((count, index) => count === hits[index])
    if (exact) {
      pending += 1
      continue
    }
    const missingNeedles = []
    let intact = false
    let ambiguous = false
    const width = Math.max(expected.length, hits.length)
    for (let i = 0; i < width; i += 1) {
      const want = expected[i] || 0
      const actual = hits[i] || 0
      if (want === actual) {
        if (want > 0) intact = true
        continue
      }
      if (want > 0 && actual === 0) {
        missingNeedles.push(i)
      } else {
        ambiguous = true
        failures.push({
          key,
          file: shown,
          kind: 'ambiguous',
          needle: i,
          reason: 'needle ' + i + ' hit count changed in ' + rel + ': expected ' + want + ' actual ' + actual,
        })
      }
    }
    if (missingNeedles.length > 0 && !ambiguous) {
      if (product && !intact) {
        applied += 1
      } else if (product && intact) {
        failures.push({
          key,
          file: shown,
          kind: 'partial',
          needle: missingNeedles[0],
          reason: 'partial patch: needle ' + missingNeedles[0] + ' is gone but other needles still present in ' + rel,
        })
      } else {
        for (const index of missingNeedles) {
          failures.push({
            key,
            file: shown,
            kind: 'drifted',
            needle: index,
            reason: 'needle ' + index + ' missing in ' + rel,
          })
        }
      }
    }
  }

  if (contract.optional && (failures.length > 0 || absent > 0)) {
    const ambiguous = failures.find((failure) => failure.kind === 'ambiguous')
    if (ambiguous) {
      return row('ambiguous', 'baseline', ambiguous.file, 0, ambiguous.reason, failures)
    }
    return row('na', absent > 0 ? 'absent-file' : 'optional', evidenceFiles[0] ? evidenceFiles[0].file : '', 0,
      absent > 0 ? 'optional: target package is not in this tree' : 'optional: reference anchor absent or drifted')
  }
  if (failures.length > 0) {
    const ambiguous = failures.find((failure) => failure.kind === 'ambiguous')
    if (ambiguous) return row('ambiguous', 'baseline', ambiguous.file, 0, ambiguous.reason, failures)
    const first = failures[0]
    const phase = first.kind === 'drifted' ? 'drifted' : first.kind === 'partial' ? 'partial' : 'absent-file'
    return row('missing', phase, first.file, 0, first.reason, failures)
  }
  if (applied > 0 && pending === 0) {
    return row('ok', 'replaced', evidenceFiles[0] ? evidenceFiles[0].file : '', 0,
      'needle gone, plugin trace present (already applied)')
  }
  if (applied > 0 && pending > 0) {
    return row('missing', 'partial', evidenceFiles[0] ? evidenceFiles[0].file : '', 0,
      'partial patch: ' + applied + ' anchor(s) applied but ' + pending + ' still carry the needle')
  }
  return row('ok', 'baseline', evidenceFiles[0] ? evidenceFiles[0].file : '', 1,
    'all ' + anchors.length + ' anchor(s) match reference baseline')
}

/**
 * 单条契约对单棵树的判定。带 anchors 的契约走基线比对；没有 anchors 的旧契约沿用下面的
 * 注册表模式（每条针 × 每个目标文件都要恰好命中一次）。
 */
export function checkContract(contract, root, table, readFile, options = {}) {
  if (contract && Array.isArray(contract.anchors)) {
    return checkBaselineContract(contract, root, table, readFile, options)
  }
  return checkLegacyContract(contract, root, table, readFile, options)
}

/**
 * 旧的注册表模式判定：
 * 契约是「一组针 × 一组目标文件」：replacements 逐条顺序应用，多文件各自要命中。
 * 所以判定的单位不是「有没有一条针命中」，而是「每一个目标文件里的每一条针是否都恰好命中一次」——
 * 少一条针、少一个文件都是 partial patch，必须报出来，不能被另一条针的唯一命中盖住。
 */
function checkLegacyContract(contract, root, table, readFile, options = {}) {

  const productEvidence = options.productEvidence || 'trace'
  const keys = (contract && contract.files) || []
  const needles = (contract && contract.needles) || []
  const evidenceFiles = []
  const present = []
  const absentKeys = []
  const seen = new Set()
  for (const key of keys) {
    let found = 0
    for (const raw of candidatesOf(table, key)) {
      const abs = path.resolve(raw)
      if (!insideRoot(root, abs)) continue
      const file = relOf(root, abs)
      if (seen.has(file)) {
        found += 1
        continue
      }
      seen.add(file)
      const text = readFile(abs)
      if (text === null || text === undefined) {
        evidenceFiles.push({ key, file, exists: false, hits: null, trace: false, product: false })
        continue
      }
      // 只有真正读到的文件才算这个 key 解析到了：路径写着但文件不存在，等同于缺包。
      found += 1
      const hits = needles.map((needle) => countHits(text, needle))
      const trace = (contract.traceProbes || []).some((probe) => countHits(text, { pattern: probe }) > 0)
      const product = trace || (productEvidence === 'any'
        ? (contract.products || []).some((probe) => countHits(text, { pattern: probe }) > 0)
        : false)
      present.push({ key, file, hits, trace, product })
      evidenceFiles.push({ key, file, exists: true, hits, trace, product })
    }
    if (found === 0) absentKeys.push(key)
  }

  const base = {
    optional: Boolean(contract.optional),
    retraction: Boolean(contract.retraction),
    crossLine: Boolean(contract.crossLine),
    needles: (contract.needles || []).length,
    keys,
    files: evidenceFiles,
    firstNeedle: (contract.needles && contract.needles[0] && contract.needles[0].excerpt) || '',
    productEvidence,
  }
  const row = (status, phase, file, hits, reason, failures) => ({
    id: contract.id,
    name: contract.name || '',
    status,
    file,
    hits,
    evidence: { ...base, phase, reason, failures: failures || [] },
  })

  if (keys.length === 0) {
    return row('na', 'no-target', '', 0, 'registration has no file key: contract cannot be located by construction')
  }
  if (present.length === 0) {
    if (contract.optional) return row('na', 'absent-file', '', 0, 'optional: target package is not in this tree')
    return row('missing', 'absent-file', '', 0,
      'target file for key ' + (absentKeys[0] || keys[0]) + ' not found',
      absentKeys.map((key) => ({ key, kind: 'absent', reason: 'target file for key ' + key + ' not found' })))
  }

  // 1) 同一条针在同一文件命中多次 = 无法唯一定位（先判坏，任何 ok 都不能盖住它）。
  for (const item of present) {
    for (let i = 0; i < item.hits.length; i += 1) {
      if (item.hits[i] > 1) {
        return row('ambiguous', 'needle', item.file, item.hits[i],
          'needle ' + i + ' occurs ' + item.hits[i] + ' times in ' + item.file)
      }
    }
  }

  // 2) 逐文件逐针统计缺项：契约是「一组针 × 一组文件」，每一条针在每一个目标文件里都必须恰好命中一次。
  //    少一条针、少一个文件都是 partial patch，不能被另一条针的唯一命中盖住。
  const pending = []
  const partial = []
  for (const item of present) {
    const zeros = []
    for (let i = 0; i < item.hits.length; i += 1) {
      if (item.hits[i] === 0) zeros.push(i)
    }
    if (zeros.length === 0) pending.push(item)
    else partial.push({ item, zeros })
  }

  if (absentKeys.length === 0 && partial.length === 0) {
    return row('ok', 'needle', pending[0].file, 1,
      'all ' + needles.length + ' needle(s) uniquely locate across ' + pending.length + ' file(s)')
  }

  // 3) 缺文件或缺针：只有该文件已有插件痕迹才算已打上，否则就是缺锚点。
  if (contract.optional) {
    return row('na', absentKeys.length > 0 ? 'absent-file' : 'optional', present[0].file, 0,
      absentKeys.length > 0
        ? 'optional: target package is not in this tree'
        : 'optional: needle absent, target declared best-effort')
  }
  if (contract.retraction) {
    return row('na', 'retraction', present[0].file, 0,
      'retraction patch: anchor is plugin-own trace, absent means nothing to undo')
  }

  const failures = []
  for (const key of absentKeys) {
    failures.push({ key, file: '', kind: 'absent-file', reason: 'target file for key ' + key + ' not found' })
  }
  for (const entry of partial) {
    const item = entry.item
    if (item.product) continue
    const firstZero = entry.zeros[0]
    const others = item.hits.filter((hits, index) => index !== firstZero && hits > 0).length
    const allZero = item.hits.every((hits) => hits === 0)
    failures.push({
      key: item.key,
      file: item.file,
      kind: allZero ? 'drifted' : 'partial',
      reason: 'needle ' + firstZero + ' missing in ' + item.file
        + (allZero ? ' (no needle hits)' : ' (partial: other needles present)'),
    })
  }
  if (failures.length > 0) {
    const first = failures[0]
    return row('missing', first.kind, first.file, 0, first.reason, failures)
  }

  // 4) 没有缺项失败、但也不是全部定位：部分文件已打上（有痕迹），另一些文件还带着针。
  if (pending.length > 0) {
    const traced = partial[0].item
    return row('missing', 'partial', pending[0].file, 0,
      'partial patch: ' + traced.file + ' looks applied but ' + pending[0].file + ' still has the needle',
      [{ key: traced.key, file: traced.file, kind: 'partial', reason: 'already applied while ' + pending[0].file + ' still has the needle' }])
  }
  return row('ok', 'replaced', partial[0].item.file, 0,
    'needle gone, plugin trace present (already applied)')
}

/**
 * 一整张契约表 × 一棵树。
 *
 * options.table        key -> 绝对路径（或数组）；不给就走 lib/core.js 的 targetFiles
 * options.targetFiles  自定义映射函数 (root) -> table
 * options.readFile     (abs) -> 文本或 null；测试用它绕开真实磁盘
 * options.productEvidence  'trace'（默认，只认 [dsh-purge] 痕迹）| 'any'（连产物探针一起认，
 *                      只适合已经打过补丁的树；纯净树上产物探针可能撞官方文案）
 */
export async function checkTree(contracts, treeRoot, options = {}) {
  const root = path.resolve(String(treeRoot))
  const table = options.table
    || (typeof options.targetFiles === 'function' ? options.targetFiles(root) : await defaultTable(root))
  const readFile = options.readFile || ((file) => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  })
  const rows = []
  for (const contract of contracts || []) {
    rows.push(checkContract(contract, root, table || {}, readFile, options))
  }
  return rows
}

export function summarizeRows(rows) {
  const summary = { total: 0, ok: 0, missing: 0, ambiguous: 0, na: 0 }
  for (const row of rows || []) {
    summary.total += 1
    if (summary[row.status] === undefined) summary[row.status] = 0
    summary[row.status] += 1
  }
  return summary
}

/** 需要人处理的行（missing / ambiguous），顺序即 id 顺序。 */
export function failingRows(rows) {
  return (rows || []).filter((row) => row.status === 'missing' || row.status === 'ambiguous')
}

/** 契约表的规模统计，给 --write 的回执用。 */
export function contractStats(contracts) {
  const list = contracts || []
  let needles = 0
  let crossLine = 0
  let optional = 0
  let retraction = 0
  for (const contract of list) {
    needles += (contract.needles || []).length
    if (contract.crossLine) crossLine += 1
    if (contract.optional) optional += 1
    if (contract.retraction) retraction += 1
  }
  return { patches: list.length, needles, crossLine, optional, retraction }
}
