/**
 * prompt-tier 单元测试：纯函数、manifest 校验、变体解析、计划与 CLI 退出码。
 * 全部使用临时目录与仓库内既有 prompt 文件，不联网。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MANIFEST_PARSE_ERROR,
  MANIFEST_READ_ERROR,
  PROMPT_TIER_ESCAPE,
  PROMPT_TIER_UNKNOWN,
  findTier,
  loadManifest,
  matchRule,
  normalizeModelId,
  normalizeSelection,
  planTierPrompt,
  resolveVariant,
  selectTier,
  validateManifest,
} from '../lib/prompt-tier.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const CLI = path.join(REPO_ROOT, 'scripts', 'prompt-tier.mjs')

function validManifest() {
  return {
    schema: 1,
    kind: 'dsh-prompt-tiers',
    defaultTier: 'default',
    maxPromptChars: 1000,
    tiers: [
      { id: 'frontier', promptPath: 'prompt-frontier.txt', description: 'frontier', evidence: 'heuristic-unverified', maxPromptChars: 1000 },
      { id: 'light', promptPath: 'prompt-light.txt', description: 'light', evidence: 'heuristic-unverified', maxPromptChars: 1000 },
      { id: 'default', promptPath: 'prompt-default.txt', description: 'default', evidence: 'heuristic-unverified', maxPromptChars: 1000 },
    ],
    rules: [
      { id: 'frontier-claude', tier: 'frontier', match: { model: 'claude-opus*' } },
      { id: 'light-small', tier: 'light', match: { model: ['gpt-5*mini*', 'deepseek*flash*'] } },
    ],
  }
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-tier-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(dir, name, body) {
  const target = path.join(dir, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body)
  return target
}

function writeManifest(dir, manifest, name = 'prompt-tiers.json') {
  const target = path.join(dir, name)
  fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n')
  return target
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 20000,
  })
}

test('normalizeModelId 拆分 auto/ 前缀', () => {
  assert.deepEqual(normalizeModelId('auto/deepseek-v4.1-flash'), {
    provider: 'auto',
    model: 'deepseek-v4.1-flash',
  })
})

test('normalizeModelId 拆分 provider:model 并小写去空白', () => {
  assert.deepEqual(normalizeModelId('  OpenAI:GPT-5.2  '), {
    provider: 'openai',
    model: 'gpt-5.2',
  })
})

test('normalizeModelId 处理裸 model 与对象输入', () => {
  assert.deepEqual(normalizeModelId('Qwen3-Max'), { provider: '', model: 'qwen3-max' })
  assert.deepEqual(normalizeModelId({ provider: 'Anthropic', model: 'Claude-Opus-4' }), {
    provider: 'anthropic',
    model: 'claude-opus-4',
  })
})

test('normalizeSelection 支持字符串并保留拆出的 provider', () => {
  assert.deepEqual(normalizeSelection('auto/deepseek-v4.1-flash'), {
    provider: 'auto',
    model: 'deepseek-v4.1-flash',
  })
})

test('normalizeSelection 缺 model 返回 null', () => {
  assert.equal(normalizeSelection(null), null)
  assert.equal(normalizeSelection(''), null)
  assert.equal(normalizeSelection({ provider: 'openai' }), null)
  assert.equal(normalizeSelection({ model: '   ' }), null)
})

test('normalizeSelection 归一化 reasoningEffort 并允许 provider 覆盖', () => {
  assert.deepEqual(normalizeSelection({ model: 'gpt-5.2', provider: 'Azure', reasoningEffort: 'HIGH' }), {
    provider: 'azure',
    model: 'gpt-5.2',
    reasoningEffort: 'high',
  })
  assert.deepEqual(normalizeSelection({ modelId: 'claude-opus-4-1', reasoning_effort: 'low' }), {
    provider: '',
    model: 'claude-opus-4-1',
    reasoningEffort: 'low',
  })
})

test('matchRule 同时要求 provider 与 model 精确命中', () => {
  const rule = { match: { provider: 'openai', model: 'gpt-5' } }
  assert.equal(matchRule({ provider: 'openai', model: 'gpt-5' }, rule), true)
  assert.equal(matchRule({ provider: 'azure', model: 'gpt-5' }, rule), false)
  assert.equal(matchRule({ provider: 'openai', model: 'gpt-5.1' }, rule), false)
})

test('matchRule 支持 * 与 ? 通配', () => {
  assert.equal(matchRule({ model: 'claude-opus-4-1' }, { match: { model: 'claude-opus*' } }), true)
  assert.equal(matchRule({ model: 'gpt-5.2' }, { match: { model: 'gpt-?.?' } }), true)
  assert.equal(matchRule({ model: 'gpt-5.22' }, { match: { model: 'gpt-?.?' } }), false)
})

test('matchRule 支持 prefix: 前缀', () => {
  assert.equal(matchRule({ model: 'deepseek-v4.1-flash' }, { match: { model: 'prefix:DeepSeek-V4.1' } }), true)
  assert.equal(matchRule({ model: 'deepseek-v4.0' }, { match: { model: 'prefix:deepseek-v4.1' } }), false)
})

test('matchRule 支持 /regex/flags', () => {
  assert.equal(matchRule({ model: 'gpt-5.2' }, { match: { model: '/^gpt-5\\.[0-9]+$/' } }), true)
  assert.equal(matchRule({ model: 'gpt-5.2-preview' }, { match: { model: '/^gpt-5\\.[0-9]+$/' } }), false)
  assert.equal(matchRule({ model: 'CLAUDE-OPUS-4' }, { match: { model: '/claude-opus/i' } }), true)
})

test('matchRule 空 match 或空选择器不命中', () => {
  assert.equal(matchRule({ model: 'gpt-5' }, { match: {} }), false)
  assert.equal(matchRule(null, { match: { model: '*' } }), false)
  assert.equal(matchRule({ model: 'gpt-5' }, { match: { model: '' } }), false)
})

test('selectTier 按规则顺序取首个命中', () => {
  const manifest = {
    defaultTier: 'default',
    rules: [
      { id: 'light-first', tier: 'light', match: { model: 'gpt-5*' } },
      { id: 'frontier-second', tier: 'frontier', match: { model: 'gpt-*' } },
    ],
  }
  const first = selectTier({ model: 'gpt-5.2' }, manifest)
  assert.equal(first.tier, 'light')
  assert.equal(first.ruleIndex, 0)
  assert.equal(first.fallback, false)
  assert.equal(first.matchedBy.model, 'gpt-5*')
  const second = selectTier({ model: 'gpt-4o' }, manifest)
  assert.equal(second.tier, 'frontier')
  assert.equal(second.ruleIndex, 1)
})

test('selectTier 无命中回落 defaultTier', () => {
  const manifest = validManifest()
  const picked = selectTier({ model: 'unknown-model' }, manifest)
  assert.equal(picked.tier, 'default')
  assert.equal(picked.ruleIndex, -1)
  assert.equal(picked.fallback, true)
  assert.match(picked.reason, /fallback/)
})

test('validateManifest 接受合法 manifest', () => {
  const result = validateManifest(validManifest(), { root: REPO_ROOT })
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
})

test('validateManifest 拒绝错误 schema', () => {
  const manifest = validManifest()
  manifest.schema = 2
  const result = validateManifest(manifest)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.code === 'schema-invalid'))
})

test('validateManifest 拒绝重复档位 id', () => {
  const manifest = validManifest()
  manifest.tiers.push({ id: 'frontier', promptPath: 'other.txt', description: 'dup', evidence: 'heuristic-unverified' })
  const result = validateManifest(manifest)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.code === 'tier-id-duplicate'))
})

test('validateManifest 拒绝未知 defaultTier', () => {
  const manifest = validManifest()
  manifest.defaultTier = 'missing-tier'
  const result = validateManifest(manifest)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.code === 'default-tier-unknown'))
})

test('validateManifest 拒绝绝对路径与 .. 越界 promptPath', () => {
  const absoluteManifest = validManifest()
  absoluteManifest.tiers[0].promptPath = path.join(os.tmpdir(), 'outside.md')
  const absoluteResult = validateManifest(absoluteManifest)
  assert.equal(absoluteResult.ok, false)
  assert.ok(absoluteResult.errors.some((item) => item.code === 'tier-prompt-path-absolute'))

  const escapeManifest = validManifest()
  escapeManifest.tiers[0].promptPath = '../outside.md'
  const escapeResult = validateManifest(escapeManifest)
  assert.equal(escapeResult.ok, false)
  assert.ok(escapeResult.errors.some((item) => item.code === 'tier-prompt-path-escape'))
})

test('validateManifest 拒绝非法 maxPromptChars', () => {
  const manifest = validManifest()
  manifest.maxPromptChars = 0
  manifest.tiers[0].maxPromptChars = '1000'
  const result = validateManifest(manifest)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.code === 'max-prompt-chars-invalid'))
  assert.ok(result.errors.some((item) => item.code === 'tier-max-prompt-chars-invalid'))
})

test('validateManifest 拒绝缺失或空 match', () => {
  const missing = validManifest()
  missing.rules[0] = { id: 'bad', tier: 'frontier' }
  const missingResult = validateManifest(missing)
  assert.equal(missingResult.ok, false)
  assert.ok(missingResult.errors.some((item) => item.code === 'rule-match-missing'))

  const empty = validManifest()
  empty.rules[0] = { id: 'bad', tier: 'frontier', match: {} }
  const emptyResult = validateManifest(empty)
  assert.equal(emptyResult.ok, false)
  assert.ok(emptyResult.errors.some((item) => item.code === 'rule-match-missing'))
})

test('validateManifest 拒绝规则指向未知档位', () => {
  const manifest = validManifest()
  manifest.rules[0].tier = 'missing-tier'
  const result = validateManifest(manifest)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.code === 'rule-tier-unknown'))
})

test('validateManifest 报告描述缺失与重复规则警告', () => {
  const manifest = validManifest()
  delete manifest.tiers[0].description
  delete manifest.tiers[0].evidence
  manifest.rules.push({ id: 'dup', tier: 'frontier', match: { model: 'claude-opus*' } })
  const result = validateManifest(manifest)
  assert.equal(result.ok, true)
  const codes = result.warnings.map((item) => item.code)
  assert.ok(codes.includes('tier-description-missing'))
  assert.ok(codes.includes('tier-evidence-unverified'))
  assert.ok(codes.includes('rule-unreachable'))
})

test('resolveVariant 返回文件存在性、字符数与 sha256', (t) => {
  const dir = tempDir(t)
  writeFile(dir, 'prompt-frontier.txt', 'abc中文')
  const variant = resolveVariant('frontier', validManifest(), { root: dir })
  assert.equal(variant.exists, true)
  assert.equal(variant.chars, 5)
  assert.match(variant.sha256, /^[0-9a-f]{64}$/)
  assert.equal(variant.withinRoot, true)
  assert.equal(variant.path, path.join(dir, 'prompt-frontier.txt'))
})

test('resolveVariant 缺失文件返回 exists false', (t) => {
  const dir = tempDir(t)
  const variant = resolveVariant('frontier', validManifest(), { root: dir })
  assert.equal(variant.exists, false)
  assert.equal(variant.chars, 0)
  assert.equal(variant.sha256, null)
  assert.equal(variant.withinRoot, true)
})

test('resolveVariant 越界抛 PROMPT_TIER_ESCAPE', (t) => {
  const dir = tempDir(t)
  const manifest = validManifest()
  manifest.tiers[0].promptPath = '../outside.md'
  assert.throws(() => resolveVariant('frontier', manifest, { root: dir }), (error) => {
    assert.equal(error.code, PROMPT_TIER_ESCAPE)
    return true
  })
})

test('resolveVariant 未知档位抛 PROMPT_TIER_UNKNOWN', (t) => {
  const dir = tempDir(t)
  assert.throws(() => resolveVariant('nope', validManifest(), { root: dir }), (error) => {
    assert.equal(error.code, PROMPT_TIER_UNKNOWN)
    return true
  })
})

test('findTier 与 loadManifest 读取 JSON', (t) => {
  const dir = tempDir(t)
  const manifestPath = writeManifest(dir, validManifest())
  const loaded = loadManifest(manifestPath)
  assert.equal(findTier(loaded, 'frontier').id, 'frontier')
  assert.equal(findTier(loaded, 'missing'), null)
  assert.throws(() => loadManifest(path.join(dir, 'nope.json')), (error) => {
    assert.equal(error.code, MANIFEST_READ_ERROR)
    return true
  })
  writeFile(dir, 'broken.json', '{ not json')
  assert.throws(() => loadManifest(path.join(dir, 'broken.json')), (error) => {
    assert.equal(error.code, MANIFEST_PARSE_ERROR)
    return true
  })
})

test('planTierPrompt 计算 headroom 并 apply', (t) => {
  const dir = tempDir(t)
  writeFile(dir, 'prompt-frontier.txt', 'x'.repeat(20))
  const plan = planTierPrompt({
    selection: 'claude-opus-4-1',
    manifest: validManifest(),
    root: dir,
    contextChars: 100,
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.action, 'apply')
  assert.equal(plan.tier, 'frontier')
  assert.equal(plan.variant.chars, 20)
  assert.equal(plan.headroom, 80)
  assert.deepEqual(plan.warnings, [])
})

test('planTierPrompt 上下文不足时 skip', (t) => {
  const dir = tempDir(t)
  writeFile(dir, 'prompt-frontier.txt', 'x'.repeat(20))
  const plan = planTierPrompt({
    selection: 'claude-opus-4-1',
    manifest: validManifest(),
    root: dir,
    contextChars: 10,
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.action, 'skip')
  assert.equal(plan.headroom, -10)
  assert.ok(plan.warnings.some((item) => item.startsWith('context-overflow:')))
})

test('planTierPrompt 缺 prompt 文件时 skip', (t) => {
  const dir = tempDir(t)
  const plan = planTierPrompt({
    selection: 'claude-opus-4-1',
    manifest: validManifest(),
    root: dir,
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.action, 'skip')
  assert.ok(plan.warnings.includes('prompt-missing'))
})

test('planTierPrompt 超过 maxPromptChars 时 skip', (t) => {
  const dir = tempDir(t)
  writeFile(dir, 'prompt-frontier.txt', 'x'.repeat(10))
  const manifest = validManifest()
  manifest.tiers[0].maxPromptChars = 5
  const plan = planTierPrompt({ selection: 'claude-opus-4-1', manifest, root: dir })
  assert.equal(plan.ok, false)
  assert.equal(plan.action, 'skip')
  assert.ok(plan.warnings.some((item) => item.startsWith('prompt-too-long:')))
})

test('planTierPrompt 缺 selection 时 skip', (t) => {
  const dir = tempDir(t)
  const plan = planTierPrompt({ selection: null, manifest: validManifest(), root: dir })
  assert.equal(plan.ok, false)
  assert.equal(plan.action, 'skip')
  assert.deepEqual(plan.warnings, ['selection-missing'])
})

test('CLI --validate 对合法 manifest 退出 0', (t) => {
  const dir = tempDir(t)
  const manifestPath = writeManifest(dir, validManifest())
  const result = runCli(['--manifest', manifestPath, '--validate'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /ok: yes/)
})

test('CLI --validate 对坏 manifest 退出 2', (t) => {
  const dir = tempDir(t)
  const manifest = validManifest()
  manifest.schema = 99
  const manifestPath = writeManifest(dir, manifest)
  const result = runCli(['--manifest', manifestPath, '--validate'])
  assert.equal(result.status, 2)
  assert.match(result.stdout, /ok: no/)
  assert.match(result.stdout, /schema-invalid/)
})

test('CLI 未知参数退出 2', () => {
  const result = runCli(['--bogus'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /未知参数/)
})

test('CLI --json 输出档位、规则与变体', () => {
  const result = runCli(['--model', 'claude-opus-4-1', '--json'])
  assert.equal(result.status, 0)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.action, 'apply')
  assert.equal(payload.tier, 'frontier')
  assert.equal(payload.ruleId, 'frontier-claude-opus')
  assert.equal(payload.variant.relativePath, 'docs/prompt-inject-v6.md')
  assert.ok(payload.variant.chars > 0)
})

test('CLI --list 列出档位与规则', () => {
  const result = runCli(['--list'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /defaultTier: default/)
  assert.match(result.stdout, /frontier/)
  assert.match(result.stdout, /rules:/)
})

test('CLI 缺 --model 退出 2', () => {
  const result = runCli([])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--model/)
})

test('CLI manifest 不存在退出 2', (t) => {
  const dir = tempDir(t)
  const result = runCli(['--manifest', path.join(dir, 'missing.json'), '--validate'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /MANIFEST_READ_ERROR/)
})
