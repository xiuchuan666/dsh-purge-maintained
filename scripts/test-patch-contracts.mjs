#!/usr/bin/env node
/**
 * lib/patch-contracts.js + scripts/patch-contracts.mjs 的自测。
 *
 * 全程用临时树，不联网、不碰宿主：临时树里只放必要的 dsh-* 包目录，
 * checkTree 的 table 用注入的 key -> 绝对路径（和 lib/core.js targetFiles 同形），
 * 只有在 CLI 用例里才走真实的 targetFiles 解析。
 *
 * 覆盖：单行 / 跨行 / 多文件 / 多 pattern、missing、同针两次→ambiguous、
 * optional 缺包→na、已打上痕迹→ok/replaced、CRLF 归一化、树外路径忽略、
 * --write 幂等与 --check 退出码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  checkTree,
  contractStats,
  countHits,
  deriveContracts,
  loadContracts,
  saveContracts,
  serializeContracts,
  summarizeRows,
} from '../lib/patch-contracts.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const cliPath = path.join(here, 'patch-contracts.mjs')
const NL = String.fromCharCode(10)
const CR = String.fromCharCode(13)

function tmpBase() {
  const candidates = [process.env.TEMP, process.env.TMP, os.tmpdir()]
  for (const candidate of candidates) {
    if (candidate && candidate.indexOf('undefined') < 0) return candidate
  }
  return process.cwd()
}

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(tmpBase(), 'dsh-contracts-'))
  for (const [rel, text] of Object.entries(files || {})) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text, 'utf8')
  }
  return root
}

function tableFor(root, map) {
  const table = {}
  for (const [key, rels] of Object.entries(map || {})) {
    const list = Array.isArray(rels) ? rels : [rels]
    table[key] = list.map((rel) => path.join(root, ...rel.split('/')))
  }
  return table
}

async function runOne(patch, root, map, options) {
  const rows = await checkTree(deriveContracts([patch]), root, {
    table: tableFor(root, map),
    ...(options || {}),
  })
  return rows[0]
}

function simplePatch(fields) {
  return {
    id: 1,
    name: 'fixture',
    file: 'alpha',
    replacements: [{ pattern: 'const MODE = 0', replace: 'const MODE = OPEN' }],
    ...(fields || {}),
  }
}

test('deriveContracts：单行针保留原文、replace 与产物探针', () => {
  const contract = deriveContracts([simplePatch()])[0]
  assert.equal(contract.id, 1)
  assert.deepEqual(contract.files, ['alpha'])
  assert.equal(contract.optional, false)
  assert.equal(contract.crossLine, false)
  assert.equal(contract.needles.length, 1)
  assert.equal(contract.needles[0].pattern, 'const MODE = 0')
  assert.equal(contract.needles[0].regex, false)
  assert.equal(contract.needles[0].excerpt, 'const MODE = 0')
  assert.equal(contract.replacements[0].replace, 'const MODE = OPEN')
  assert.deepEqual(contract.products, ['const MODE = OPEN'])
})

test('deriveContracts：旧写法 patterns + replace 展开成多条针，逗号 file 拆开去重', () => {
  const contract = deriveContracts([{
    id: 2,
    name: 'legacy',
    file: 'alpha, beta ,alpha',
    patterns: ['let a = 1', 'let b = 2'],
    replace: 'let a = 2',
    marker: 'let a = 2',
  }])[0]
  assert.deepEqual(contract.files, ['alpha', 'beta'])
  assert.equal(contract.needles.length, 2)
  assert.deepEqual(contract.needles.map((needle) => needle.pattern), ['let a = 1', 'let b = 2'])
  assert.deepEqual(contract.replacements.map((rep) => rep.replace), ['let a = 2', 'let a = 2'])
})

test('deriveContracts：正则针记 regex，摘掉 g/y，跨行标记为 true', () => {
  const contract = deriveContracts([{
    id: 3,
    name: 'regex',
    file: 'alpha',
    replacements: [{ pattern: /START[\s\S]*?END/gy, replace: 'X' }],
  }])[0]
  assert.equal(contract.needles[0].regex, true)
  assert.equal(contract.needles[0].flags, '')
  assert.ok(!contract.needles[0].flags.includes('g'))
  assert.ok(!contract.needles[0].flags.includes('y'))
  assert.equal(contract.needles[0].crossLine, true)
  assert.equal(contract.crossLine, true)
  assert.equal(contract.needles[0].pattern, 'START[\\s\\S]*?END')
})

test('deriveContracts：按 id 升序且序列化幂等（LF、结尾换行）', () => {
  const contracts = deriveContracts([
    { id: 9, name: 'n9', file: 'alpha', replacements: [{ pattern: 'x9', replace: 'y9' }] },
    { id: 3, name: 'n3', file: 'alpha', replacements: [{ pattern: 'x3', replace: 'y3' }] },
  ])
  assert.deepEqual(contracts.map((contract) => contract.id), [3, 9])
  const first = serializeContracts(contracts)
  assert.equal(serializeContracts(contracts), first)
  assert.ok(!first.includes(CR))
  assert.ok(first.endsWith(NL))
  const parsed = JSON.parse(first)
  assert.equal(parsed.schema, 1)
  assert.equal(parsed.patches.length, 2)
})

test('checkTree：单行针唯一命中 → ok / needle', async () => {
  const root = tmpTree({ 'pkg/lib/index.js': ['alpha', 'const MODE = 0', 'omega'].join(NL) })
  try {
    const row = await runOne(simplePatch(), root, { alpha: 'pkg/lib/index.js' })
    assert.equal(row.status, 'ok')
    assert.equal(row.file, 'pkg/lib/index.js')
    assert.equal(row.hits, 1)
    assert.equal(row.evidence.phase, 'needle')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：CRLF 文件对 LF 针一样能定位', async () => {
  const root = tmpTree({ 'pkg/lib/index.js': ['alpha', 'const MODE = 0', 'omega'].join(CR + NL) })
  try {
    const row = await runOne(simplePatch(), root, { alpha: 'pkg/lib/index.js' })
    assert.equal(row.status, 'ok')
    assert.equal(row.hits, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：跨行针 → ok 且契约标了 crossLine', async () => {
  const needle = ['line one', 'line two', 'line three'].join(NL)
  const root = tmpTree({ 'pkg/lib/index.js': ['head', needle, 'tail'].join(NL) })
  try {
    const patch = {
      id: 4,
      name: 'multi',
      file: 'alpha',
      replacements: [{ pattern: needle, replace: 'short' }],
    }
    const contract = deriveContracts([patch])[0]
    assert.equal(contract.crossLine, true)
    const row = await runOne(patch, root, { alpha: 'pkg/lib/index.js' })
    assert.equal(row.status, 'ok')
    assert.equal(row.hits, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：多文件全部命中 → ok', async () => {
  const root = tmpTree({
    'a/lib/index.js': 'alpha' + NL + 'const MODE = 0' + NL,
    'b/lib/index.js': 'beta' + NL + 'const MODE = 0' + NL,
  })
  try {
    const row = await runOne(simplePatch({ file: ['alpha', 'beta'] }), root, {
      alpha: 'a/lib/index.js',
      beta: 'b/lib/index.js',
    })
    assert.equal(row.status, 'ok')
    assert.equal(row.hits, 1)
    assert.equal(row.evidence.files.length, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：多文件缺一个目标文件 → missing（不被另一文件的命中盖住）', async () => {
  const root = tmpTree({ 'a/lib/index.js': 'alpha' + NL + 'const MODE = 0' + NL })
  try {
    const row = await runOne(simplePatch({ file: ['alpha', 'beta'] }), root, {
      alpha: 'a/lib/index.js',
      beta: 'b/lib/index.js',
    })
    assert.equal(row.status, 'missing')
    assert.equal(row.evidence.phase, 'absent-file')
    assert.ok(row.evidence.failures.some((failure) => failure.reason === 'target file for key beta not found'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：多针只命中一部分 → missing（partial: other needles present）', async () => {
  const root = tmpTree({ 'pkg/lib/index.js': ['let a = 1', 'unrelated line'].join(NL) })
  try {
    const patch = {
      id: 7,
      name: 'multi-needle',
      file: 'alpha',
      patterns: ['let a = 1', 'let b = 2'],
      replace: 'let a = 2',
    }
    const row = await runOne(patch, root, { alpha: 'pkg/lib/index.js' })
    assert.equal(row.status, 'missing')
    assert.equal(row.evidence.phase, 'partial')
    assert.ok(row.evidence.failures.some((failure) => failure.reason.includes('needle 1 missing in pkg/lib/index.js (partial: other needles present)')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：多针全部唯一命中 → ok', async () => {
  const root = tmpTree({ 'pkg/lib/index.js': ['let a = 1', 'let b = 2'].join(NL) })
  try {
    const patch = {
      id: 8,
      name: 'multi-needle-ok',
      file: 'alpha',
      patterns: ['let a = 1', 'let b = 2'],
      replace: 'let a = 2',
    }
    const row = await runOne(patch, root, { alpha: 'pkg/lib/index.js' })
    assert.equal(row.status, 'ok')
    assert.equal(row.evidence.phase, 'needle')
    assert.equal(row.evidence.files[0].hits.join(','), '1,1')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：asar 布局 root/dsh/node_modules/@deepseek-ai 能解析 sandbox-local', async () => {
  const root = tmpTree({
    'dsh/node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js': 'const SANDBOX = "local"' + NL,
  })
  try {
    const patch = simplePatch({
      id: 9,
      file: 'sandbox-local',
      replacements: [{ pattern: 'const SANDBOX = "local"', replace: 'const SANDBOX = "patched"' }],
    })
    const rows = await checkTree(deriveContracts([patch]), root)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'ok')
    assert.equal(rows[0].evidence.phase, 'needle')
    assert.equal(rows[0].file, 'dsh/node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：同一条针出现两次 → ambiguous（即使另一条针唯一）', async () => {
  const root = tmpTree({ 'pkg/lib/index.js': ['const MODE = 0', 'const MODE = 0', 'let unique = 1'].join(NL) })
  try {
    const patch = {
      id: 5,
      name: 'dup',
      file: 'alpha',
      replacements: [
        { pattern: 'const MODE = 0', replace: 'a' },
        { pattern: 'let unique = 1', replace: 'b' },
      ],
    }
    const row = await runOne(patch, root, { alpha: 'pkg/lib/index.js' })
    assert.equal(row.status, 'ambiguous')
    assert.equal(row.hits, 2)
    assert.equal(row.evidence.phase, 'needle')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：针不在、无痕迹 → missing / drifted', async () => {
  const root = tmpTree({ 'pkg/lib/index.js': 'const MODE = LEGACY' + NL })
  try {
    const row = await runOne(simplePatch(), root, { alpha: 'pkg/lib/index.js' })
    assert.equal(row.status, 'missing')
    assert.equal(row.hits, 0)
    assert.equal(row.evidence.phase, 'drifted')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：optional 目标包不在树里 → na / absent-file', async () => {
  const root = tmpTree({ 'a/lib/index.js': 'nothing' })
  try {
    const row = await runOne(simplePatch({ optional: true, file: 'gamma' }), root, {
      alpha: 'a/lib/index.js',
    })
    assert.equal(row.status, 'na')
    assert.equal(row.evidence.phase, 'absent-file')
    assert.equal(row.file, '')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：optional 包在但针不在 → na / optional', async () => {
  const root = tmpTree({ 'g/lib/index.js': 'nothing here' })
  try {
    const row = await runOne(simplePatch({ optional: true, file: 'gamma' }), root, {
      gamma: 'g/lib/index.js',
    })
    assert.equal(row.status, 'na')
    assert.equal(row.evidence.phase, 'optional')
    assert.equal(row.file, 'g/lib/index.js')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：针不在但留了 [dsh-purge] 痕迹 → ok / replaced', async () => {
  const root = tmpTree({ 'pkg/lib/index.js': 'const MODE = OPEN /* [dsh-purge] patched */' + NL })
  try {
    const patch = {
      id: 6,
      name: 'applied',
      file: 'alpha',
      replacements: [{ pattern: 'const MODE = 0', replace: 'const MODE = OPEN /* [dsh-purge] patched */' }],
    }
    const row = await runOne(patch, root, { alpha: 'pkg/lib/index.js' })
    assert.equal(row.status, 'ok')
    assert.equal(row.evidence.phase, 'replaced')
    assert.equal(row.evidence.files[0].trace, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：回缩补丁针不在 → na / retraction（不走 missing）', async () => {
  const root = tmpTree({ 'pkg/lib/index.js': 'clean host file' + NL })
  try {
    const patch = simplePatch({ skipIfMarked: true })
    const row = await runOne(patch, root, { alpha: 'pkg/lib/index.js' })
    assert.equal(row.status, 'na')
    assert.equal(row.evidence.phase, 'retraction')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkTree：树外路径被忽略，不会被当成命中', async () => {
  const outside = tmpTree({ 'x/lib/index.js': 'const MODE = 0' + NL })
  const root = tmpTree({ 'a/lib/index.js': 'nothing' })
  try {
    const rows = await checkTree(deriveContracts([simplePatch()]), root, {
      table: { alpha: path.join(outside, 'x', 'lib', 'index.js') },
    })
    assert.equal(rows[0].status, 'missing')
    assert.equal(rows[0].evidence.phase, 'absent-file')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('checkTree：productEvidence=any 时产物探针也算已打上', async () => {
  const root = tmpTree({ 'pkg/lib/index.js': 'const MODE = OPEN' + NL })
  try {
    const patch = simplePatch()
    const strict = await runOne(patch, root, { alpha: 'pkg/lib/index.js' })
    assert.equal(strict.status, 'missing')
    const loose = await runOne(patch, root, { alpha: 'pkg/lib/index.js' }, { productEvidence: 'any' })
    assert.equal(loose.status, 'ok')
    assert.equal(loose.evidence.phase, 'replaced')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('countHits：字符串按非重叠计数、正则按匹配段计数、空针为 0', () => {
  assert.equal(countHits('aa aa aa', { pattern: 'aa' }), 3)
  assert.equal(countHits('aa aa aa', { pattern: 'a+' , regex: true }), 3)
  assert.equal(countHits('abc', { pattern: '' }), 0)
})

test('基线契约：参考树命中一致 → ok / baseline', async () => {
  const root = tmpTree({ 'pkg/lib/index.js': 'const MODE = 0' + NL })
  try {
    const contracts = deriveContracts([simplePatch()], {
      treeRoot: root,
      table: tableFor(root, { alpha: 'pkg/lib/index.js' }),
      label: 'fixture-baseline',
    })
    assert.equal(contracts.reference.host, 'fixture-baseline')
    assert.equal(contracts[0].anchors.length, 1)
    assert.deepEqual(contracts[0].anchors[0], { key: 'alpha', file: 'pkg/lib/index.js', hits: [1] })
    const row = (await checkTree(contracts, root))[0]
    assert.equal(row.status, 'ok')
    assert.equal(row.evidence.phase, 'baseline')
    assert.equal(row.evidence.baseline, true)
    assert.equal(row.evidence.anchors, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('基线契约：按 key 映射到不同宿主布局 → ok', async () => {
  const reference = tmpTree({ 'dsh/node_modules/@deepseek-ai/dsh-demo/lib/index.js': 'const MODE = 0' + NL })
  const host = tmpTree({ 'node_modules/@deepseek-ai/dsh-demo/lib/index.js': 'const MODE = 0' + NL })
  try {
    const contracts = deriveContracts([simplePatch({ file: 'demo' })], {
      treeRoot: reference,
      table: tableFor(reference, { demo: 'dsh/node_modules/@deepseek-ai/dsh-demo/lib/index.js' }),
      label: 'fixture-layout',
    })
    const row = (await checkTree(contracts, host, {
      table: tableFor(host, { demo: 'node_modules/@deepseek-ai/dsh-demo/lib/index.js' }),
    }))[0]
    assert.equal(row.status, 'ok')
    assert.equal(row.file, 'node_modules/@deepseek-ai/dsh-demo/lib/index.js')
  } finally {
    fs.rmSync(reference, { recursive: true, force: true })
    fs.rmSync(host, { recursive: true, force: true })
  }
})

test('基线契约：多文件各带一条针、每行有 0 命中 → ok（#43 式）', async () => {
  const root = tmpTree({
    'a/lib/index.js': 'A' + NL,
    'b/lib/index.js': 'B' + NL,
    'c/lib/index.js': 'C' + NL,
  })
  try {
    const patch = {
      id: 43,
      name: 'preset-strip',
      file: ['alpha', 'beta', 'gamma'],
      patterns: ['A', 'B', 'C'],
      replace: 'X',
    }
    const contracts = deriveContracts([patch], {
      treeRoot: root,
      table: tableFor(root, { alpha: 'a/lib/index.js', beta: 'b/lib/index.js', gamma: 'c/lib/index.js' }),
      label: 'fixture-43',
    })
    assert.equal(contracts[0].anchors.length, 3)
    assert.deepEqual(contracts[0].anchors.map((anchor) => anchor.hits), [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
    const row = (await checkTree(contracts, root))[0]
    assert.equal(row.status, 'ok')
    assert.equal(row.evidence.reason, 'all 3 anchor(s) match reference baseline')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('基线契约：锚点文件缺失 → missing / absent-file', async () => {
  const reference = tmpTree({ 'pkg/lib/index.js': 'const MODE = 0' + NL })
  const host = tmpTree({})
  try {
    const contracts = deriveContracts([simplePatch()], {
      treeRoot: reference,
      table: tableFor(reference, { alpha: 'pkg/lib/index.js' }),
      label: 'fixture-missing',
    })
    const row = (await checkTree(contracts, host))[0]
    assert.equal(row.status, 'missing')
    assert.equal(row.evidence.phase, 'absent-file')
    assert.ok(row.evidence.failures.some((failure) => failure.reason === 'target file for key alpha not found'))
  } finally {
    fs.rmSync(reference, { recursive: true, force: true })
    fs.rmSync(host, { recursive: true, force: true })
  }
})

test('基线契约：命中 1 → 2 → ambiguous', async () => {
  const reference = tmpTree({ 'pkg/lib/index.js': 'const MODE = 0' + NL })
  const host = tmpTree({ 'pkg/lib/index.js': ['const MODE = 0', 'const MODE = 0'].join(NL) })
  try {
    const contracts = deriveContracts([simplePatch()], {
      treeRoot: reference,
      table: tableFor(reference, { alpha: 'pkg/lib/index.js' }),
      label: 'fixture-ambiguous',
    })
    const row = (await checkTree(contracts, host))[0]
    assert.equal(row.status, 'ambiguous')
    assert.ok(row.evidence.reason.includes('expected 1 actual 2'))
    assert.equal(row.evidence.phase, 'baseline')
  } finally {
    fs.rmSync(reference, { recursive: true, force: true })
    fs.rmSync(host, { recursive: true, force: true })
  }
})

test('基线契约：参考树无落点 → na / no-anchor', async () => {
  const root = tmpTree({ 'pkg/lib/index.js': 'const MODE = LEGACY' + NL })
  try {
    const contracts = deriveContracts([simplePatch()], {
      treeRoot: root,
      table: tableFor(root, { alpha: 'pkg/lib/index.js' }),
      label: 'fixture-no-anchor',
    })
    assert.equal(contracts[0].anchors.length, 0)
    const row = (await checkTree(contracts, root))[0]
    assert.equal(row.status, 'na')
    assert.equal(row.evidence.phase, 'no-anchor')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('CLI：--write --tree 对 asar 布局生成 anchors 基线', () => {
  const base = fs.mkdtempSync(path.join(tmpBase(), 'dsh-contracts-baseline-'))
  const root = path.join(base, 'tree')
  const file = path.join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-sandbox-local', 'lib', 'index.js')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'const value = "(deny file-write*)"' + NL, 'utf8')
  const out = path.join(base, 'contracts.json')
  try {
    const run = spawnSync(process.execPath, [cliPath, '--write', '--out', out, '--tree', root, '--label', 'fixture-asar'], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /baseline=true/)
    const data = JSON.parse(fs.readFileSync(out, 'utf8'))
    assert.equal(data.reference.host, 'fixture-asar')
    const patch = data.patches.find((entry) => entry.id === 6)
    assert.equal(patch.anchors.length, 1)
    assert.equal(patch.anchors[0].file, 'dsh/node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js')
    assert.deepEqual(patch.anchors[0].hits, [1])
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('真注册表：88 条补丁全部有针、id 唯一、统计口径一致', async () => {
  const core = await import('../lib/core.js')
  const contracts = deriveContracts(core.ALL_PATCHES)
  const stats = contractStats(contracts)
  assert.equal(stats.patches, 88)
  assert.ok(stats.needles >= stats.patches)
  assert.equal(new Set(contracts.map((contract) => contract.id)).size, contracts.length)
  for (const contract of contracts) assert.ok(contract.needles.length > 0, 'patch ' + contract.id + ' 没有针')
  const summary = summarizeRows(await checkTree(contracts, path.join(tmpBase(), 'no-such-tree')))
  assert.equal(summary.total, 88)
})

test('CLI：--write 幂等（两次字节一致、LF、结尾换行）', () => {
  const base = fs.mkdtempSync(path.join(tmpBase(), 'dsh-contracts-cli-'))
  const out = path.join(base, 'contracts.json')
  try {
    const first = spawnSync(process.execPath, [cliPath, '--write', '--out', out], { encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr)
    const text = fs.readFileSync(out, 'utf8')
    const second = spawnSync(process.execPath, [cliPath, '--write', '--out', out], { encoding: 'utf8' })
    assert.equal(second.status, 0, second.stderr)
    assert.equal(fs.readFileSync(out, 'utf8'), text)
    assert.ok(!text.includes(CR))
    assert.ok(text.endsWith(NL))
    assert.equal(JSON.parse(text).patches.length, 88)
    assert.equal(loadContracts(out).length, 88)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('CLI：--check --json 先 ok 后 missing，退出码 0/1', () => {
  const base = fs.mkdtempSync(path.join(tmpBase(), 'dsh-contracts-check-'))
  const root = path.join(base, 'tree')
  const file = path.join(root, 'dsh-sandbox-local', 'lib', 'index.js')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, ['alpha', 'const MODE = 0', 'omega'].join(NL), 'utf8')
  const contractsFile = path.join(base, 'contracts.json')
  saveContracts(contractsFile, deriveContracts([simplePatch({ file: 'sandbox-local' })]))
  try {
    const okRun = spawnSync(process.execPath, [cliPath, '--check', '--tree', root, '--contracts', contractsFile, '--json'], { encoding: 'utf8' })
    assert.equal(okRun.status, 0, okRun.stderr)
    const report = JSON.parse(okRun.stdout)
    assert.equal(report.summary.ok, 1)
    assert.equal(report.rows[0].file, 'dsh-sandbox-local/lib/index.js')
    fs.writeFileSync(file, ['alpha', 'const MODE = LEGACY', 'omega'].join(NL), 'utf8')
    const badRun = spawnSync(process.execPath, [cliPath, '--check', '--tree', root, '--contracts', contractsFile, '--json'], { encoding: 'utf8' })
    assert.equal(badRun.status, 1)
    assert.equal(JSON.parse(badRun.stdout).summary.missing, 1)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
