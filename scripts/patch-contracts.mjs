#!/usr/bin/env node
/**
 * 补丁锚点契约 CLI（P2-5）。
 *
 *   node scripts/patch-contracts.mjs --write [FILE] [--tree DIR] [--label VERSION]
 *       从 lib/core.js 的 ALL_PATCHES 生成契约表（默认 docs/patch-contracts.json）：
 *       id 升序、字段顺序固定、LF、结尾一个换行 —— 同一份注册表永远得到同一份字节。
 *       带 --tree 时读参考树，给每条补丁记录 anchors（实际解析到的文件 × 每条针的命中次数）
 *       与 reference（host / 相对 root）；不带 --tree 时保持旧的注册表模式，输出明确 baseline=false。
 *
 *   node scripts/patch-contracts.mjs --check --tree DIR [--json] [--contracts FILE] [--applied]
 *       拿契约表校验一棵宿主树，每条补丁一个状态：
 *         ok         基线 anchor 的文件与命中次数全部一致（可以安全地打）/ 或已打上（留了本插件痕迹）
 *         missing    文件缺失 / 基线命中的针不见了（drifted）/ 只打上了一部分（partial）
 *         ambiguous  某条针的命中次数与基线不同（例如 1→2），无法确定改哪一处
 *         na         目标包不在这棵树里（optional）、回缩补丁、或参考树里本来就没有落点（no-anchor）
 *       DIR 可以是 resources/app、npm 的 @deepseek-ai 底座，或它们的上级目录。
 *       --applied 把产物探针也算作「已打上」的证据（只适合已经打过补丁的树；
 *       纯净树上产物可能撞官方文案，默认只认 [dsh-purge] 痕迹）。
 *
 * 退出码：0 全部 ok/na；1 有 missing 或 ambiguous（ambiguous 同样算失败：命中次数与基线不一致，
 * 无法确定改哪一处，必须先人工收窄）；2 参数 / 文件错。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkTree,
  contractStats,
  deriveContracts,
  failingRows,
  loadContracts,
  resolveTargetTable,
  saveContracts,
  summarizeRows,
} from '../lib/patch-contracts.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const DEFAULT_OUT = path.join(repoRoot, 'docs', 'patch-contracts.json')

const USAGE = [
  '用法:',
  '  node scripts/patch-contracts.mjs --write [FILE] [--tree DIR] [--label VERSION]',
  '      从 lib/core.js 的 ALL_PATCHES 生成契约表（默认 docs/patch-contracts.json）。',
  '      带 --tree 时读参考树生成 anchors 基线（正式 docs 必须用这种模式）。',
  '  node scripts/patch-contracts.mjs --check --tree DIR [--json] [--contracts FILE] [--applied]',
  '      用契约表校验一棵宿主树；DIR 可以是 resources/app、npm 的 @deepseek-ai 底座或其上级目录。',
  '      --applied 把产物探针也算作已打上的证据（只适合已打过补丁的树）。',
  '退出码: 0 全部 ok/na；1 有 missing/ambiguous（ambiguous 也算失败：命中次数与基线不一致）；2 参数或文件错。',
].join(String.fromCharCode(10))

function parseArgs(argv) {
  const opts = { mode: '', out: '', tree: '', label: '', contracts: '', json: false, applied: false }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--write') opts.mode = 'write'
    else if (arg === '--check') opts.mode = 'check'
    else if (arg === '--json') opts.json = true
    else if (arg === '--applied') opts.applied = true
    else if (arg === '--help' || arg === '-h') opts.mode = 'help'
    else if (arg === '--tree') { opts.tree = argv[i + 1] || ''; i += 1 }
    else if (arg.startsWith('--tree=')) opts.tree = arg.slice('--tree='.length)
    else if (arg === '--label') { opts.label = argv[i + 1] || ''; i += 1 }
    else if (arg.startsWith('--label=')) opts.label = arg.slice('--label='.length)
    else if (arg === '--contracts') { opts.contracts = argv[i + 1] || ''; i += 1 }
    else if (arg.startsWith('--contracts=')) opts.contracts = arg.slice('--contracts='.length)
    else if (arg === '--out') { opts.out = argv[i + 1] || ''; i += 1 }
    else if (arg.startsWith('--out=')) opts.out = arg.slice('--out='.length)
    else rest.push(arg)
  }
  if (!opts.out && opts.mode === 'write' && rest.length) opts.out = rest[0]
  return opts
}

// patch-gates 的 --tree 习惯写 name=DIR；这里两种写法都收。
function treeDirOf(value) {
  const text = String(value || '')
  const at = text.indexOf('=')
  return at > 0 ? text.slice(at + 1) : text
}

function relFromCwd(file) {
  const rel = path.relative(process.cwd(), file)
  return (rel || file).split(path.sep).join('/')
}

async function runWrite(outFile, opts) {
  const core = await import('../lib/core.js')
  const patches = core.ALL_PATCHES
  if (!Array.isArray(patches) || patches.length === 0) {
    console.error('[contracts] lib/core.js 没有 ALL_PATCHES，拒绝写空表')
    return 2
  }
  const tree = opts && opts.tree ? treeDirOf(opts.tree) : ''
  let contracts
  let baseline = false
  if (tree) {
    const table = await resolveTargetTable(tree)
    contracts = deriveContracts(patches, {
      treeRoot: tree,
      table,
      label: opts.label || undefined,
    })
    baseline = true
  } else {
    contracts = deriveContracts(patches)
  }
  const result = saveContracts(outFile, contracts)
  const stats = contractStats(contracts)
  const anchors = contracts.reduce((total, contract) => total + ((contract.anchors || []).length), 0)
  const reference = contracts.reference || null
  console.log('[contracts] 写入 ' + relFromCwd(result.file) + '：' + stats.patches + ' 条补丁，'
    + stats.needles + ' 条针（跨行 ' + stats.crossLine + ' 条），可选 ' + stats.optional
    + ' 条，回缩 ' + stats.retraction + ' 条，' + result.bytes + ' 字节')
  console.log('[contracts] baseline=' + (baseline ? 'true' : 'false')
    + (baseline ? ' anchors=' + anchors + ' reference=' + reference.host + ' root=' + reference.root : '')
    + (baseline ? '' : '（注册表模式，未读参考树）'))
  return 0
}

async function runCheck(opts) {
  const tree = treeDirOf(opts.tree)
  if (!tree) {
    console.error('[contracts] --check 需要 --tree DIR')
    return 2
  }
  const contractFile = opts.contracts || DEFAULT_OUT
  let contracts
  try {
    contracts = loadContracts(contractFile)
  } catch (error) {
    console.error('[contracts] 读不了契约表 ' + relFromCwd(path.resolve(contractFile)) + '：' + error.message)
    return 2
  }
  const rows = await checkTree(contracts, tree, {
    productEvidence: opts.applied ? 'any' : 'trace',
  })
  const summary = summarizeRows(rows)
  const failures = failingRows(rows)
  const phases = {}
  for (const row of rows) {
    const phase = row.evidence && row.evidence.phase ? row.evidence.phase : 'unknown'
    phases[phase] = (phases[phase] || 0) + 1
  }
  const baseline = contracts.some((contract) => Array.isArray(contract.anchors))
  if (opts.json) {
    console.log(JSON.stringify({
      schema: 1,
      kind: 'dsh-patch-contracts-report',
      tree: path.resolve(tree),
      contracts: path.resolve(contractFile),
      baseline,
      reference: contracts.reference || null,
      summary,
      phases,
      rows,
    }, null, 2))
    return failures.length ? 1 : 0
  }
  console.log('[contracts] tree ' + path.resolve(tree))
  console.log('[contracts] baseline=' + (baseline ? 'true' : 'false')
    + (contracts.reference ? ' reference=' + contracts.reference.host + ' root=' + contracts.reference.root : ''))
  console.log('[contracts] ' + summary.total + ' 条：ok=' + summary.ok + ' missing=' + summary.missing
    + ' ambiguous=' + summary.ambiguous + ' na=' + summary.na)
  const traced = rows.filter((row) => (row.evidence.files || []).some((file) => file.trace)).length
  if (!opts.applied && traced > 0) {
    console.log('[contracts] 提示：这棵树里有 ' + traced + ' 条补丁留下了 [dsh-purge] 痕迹（已打过补丁）；'
      + '按「已打上」判读请加 --applied')
  }
  for (const row of failures) {
    const where = row.file || (row.evidence && row.evidence.keys ? row.evidence.keys.join(',') : '') || '-'
    const needle = row.evidence && row.evidence.firstNeedle ? row.evidence.firstNeedle : ''
    console.log('[contracts] ' + row.status + ' #' + row.id + ' ' + row.name + ' ' + where
      + ' :: ' + row.evidence.reason + (needle ? ' | 针: ' + needle : ''))
  }
  return failures.length ? 1 : 0
}

const opts = parseArgs(process.argv.slice(2))
let code = 2
try {
  if (opts.mode === 'help') {
    console.log(USAGE)
    code = 0
  } else if (opts.mode === 'write') {
    code = await runWrite(opts.out || DEFAULT_OUT, opts)
  } else if (opts.mode === 'check') {
    code = await runCheck(opts)
  } else {
    console.log(USAGE)
  }
} catch (error) {
  console.error('[contracts] ' + (error && error.stack ? error.stack : error))
  code = 2
}
process.exitCode = code
