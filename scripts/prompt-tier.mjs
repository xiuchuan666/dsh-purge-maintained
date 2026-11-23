#!/usr/bin/env node
/**
 * prompt-tier CLI：读取 docs/prompt-tiers.json，把模型选择器解析成档位与提示词变体。
 *
 *   node scripts/prompt-tier.mjs --model deepseek-v4.1-flash
 *   node scripts/prompt-tier.mjs --model gpt-5.2 --provider openai --json
 *   node scripts/prompt-tier.mjs --list
 *   node scripts/prompt-tier.mjs --validate
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROMPT_TIER_KIND,
  PROMPT_TIER_SCHEMA,
  loadManifest,
  normalizeSelection,
  planTierPrompt,
  resolveVariant,
  selectTier,
  validateManifest,
} from '../lib/prompt-tier.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const DEFAULT_MANIFEST = path.join(REPO_ROOT, 'docs', 'prompt-tiers.json')

const USAGE = [
  '用法：node scripts/prompt-tier.mjs --model MODEL [--provider PROVIDER] [--context-chars N] [--json]',
  '      node scripts/prompt-tier.mjs --list [--json]',
  '      node scripts/prompt-tier.mjs --validate [--json]',
  '',
  '选项：',
  '  --manifest PATH       manifest 路径（默认 docs/prompt-tiers.json）',
  '  --model MODEL         模型 id，支持 provider/model、provider:model 或裸 model',
  '  --provider PROVIDER   显式 provider；会覆盖 --model 里拆出的 provider',
  '  --context-chars N     当前可用上下文字符数，用于计算 headroom',
  '  --json                JSON 输出',
  '  --list                列出档位与规则',
  '  --validate            只校验 manifest',
  '  -h, --help            显示本帮助',
].join('\n')

class CliError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CliError'
  }
}

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    model: null,
    provider: null,
    contextChars: null,
    json: false,
    list: false,
    validate: false,
    help: false,
  }
  const valueFlags = {
    '--manifest': 'manifest',
    '--model': 'model',
    '--provider': 'provider',
    '--context-chars': 'contextChars',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const equals = argument.indexOf('=')
    const name = equals >= 0 ? argument.slice(0, equals) : argument
    const inline = equals >= 0 ? argument.slice(equals + 1) : null
    if (name === '--json') {
      options.json = true
      continue
    }
    if (name === '--list') {
      options.list = true
      continue
    }
    if (name === '--validate') {
      options.validate = true
      continue
    }
    if (name === '--help' || name === '-h') {
      options.help = true
      continue
    }
    if (Object.prototype.hasOwnProperty.call(valueFlags, name)) {
      let value = inline
      if (value === null) {
        index += 1
        value = argv[index]
      }
      if (value === undefined || value === '') throw new CliError('参数 ' + name + ' 缺值')
      options[valueFlags[name]] = value
      continue
    }
    throw new CliError('未知参数：' + argument)
  }
  if (options.contextChars !== null) {
    if (!/^[0-9]+$/.test(String(options.contextChars))) throw new CliError('--context-chars 必须是正整数')
    options.contextChars = Number(options.contextChars)
    if (!Number.isInteger(options.contextChars) || options.contextChars <= 0) {
      throw new CliError('--context-chars 必须是正整数')
    }
  }
  if (options.list && options.validate) throw new CliError('--list 与 --validate 不能同时使用')
  return options
}

function loadChecked(manifestPath) {
  let manifest
  try {
    manifest = loadManifest(manifestPath)
  } catch (error) {
    throw new CliError((error && error.code ? error.code : 'MANIFEST_ERROR') + ': ' + (error && error.message ? error.message : String(error)))
  }
  const validation = validateManifest(manifest, { root: REPO_ROOT })
  return { manifest, validation }
}

function printValidation(validation, manifestPath) {
  console.log('manifest: ' + manifestPath)
  console.log('schema: ' + PROMPT_TIER_SCHEMA + '（' + PROMPT_TIER_KIND + '）')
  console.log('ok: ' + (validation.ok ? 'yes' : 'no'))
  console.log('errors: ' + validation.errors.length)
  for (const item of validation.errors) {
    console.log('  error [' + item.code + '] ' + (item.where ? item.where + ': ' : '') + item.message)
  }
  console.log('warnings: ' + validation.warnings.length)
  for (const item of validation.warnings) {
    console.log('  warning [' + item.code + '] ' + (item.where ? item.where + ': ' : '') + item.message)
  }
}

function validationJson(validation, manifestPath) {
  return {
    ok: validation.ok,
    manifest: manifestPath,
    errors: validation.errors,
    warnings: validation.warnings,
  }
}

function listPayload(manifest, manifestPath) {
  const tiers = Array.isArray(manifest.tiers) ? manifest.tiers : []
  const rules = Array.isArray(manifest.rules) ? manifest.rules : []
  return {
    ok: true,
    manifest: manifestPath,
    defaultTier: manifest.defaultTier,
    maxPromptChars: manifest.maxPromptChars,
    tiers: tiers.map((tier) => {
      let chars = null
      let exists = false
      try {
        const variant = resolveVariant(tier, manifest, { root: REPO_ROOT })
        chars = variant.chars
        exists = variant.exists
      } catch {
        chars = null
        exists = false
      }
      return {
        id: tier.id,
        title: tier.title,
        description: tier.description,
        promptPath: tier.promptPath,
        maxPromptChars: tier.maxPromptChars === undefined ? manifest.maxPromptChars : tier.maxPromptChars,
        exists,
        chars,
      }
    }),
    rules: rules.map((rule, index) => ({
      index,
      id: rule.id,
      tier: rule.tier,
      match: rule.match,
      reason: rule.reason,
    })),
  }
}

function printList(payload) {
  console.log('manifest: ' + payload.manifest)
  console.log('defaultTier: ' + payload.defaultTier)
  console.log('tiers:')
  for (const tier of payload.tiers) {
    const size = tier.exists ? tier.chars + ' chars' : 'missing'
    console.log('  ' + tier.id.padEnd(10) + tier.promptPath.padEnd(26) + size)
    if (tier.description) console.log('    ' + tier.description)
  }
  console.log('rules:')
  for (const rule of payload.rules) {
    console.log('  #' + rule.index + ' ' + String(rule.id || '(no-id)').padEnd(24) + '-> ' + rule.tier + '  ' + JSON.stringify(rule.match))
  }
}

function planPayload(options, manifest, manifestPath) {
  const selection = normalizeSelection({ model: options.model, provider: options.provider })
  if (!selection) throw new CliError('--model 不能为空')
  const picked = selectTier(selection, manifest)
  const plan = planTierPrompt({
    selection,
    manifest,
    root: REPO_ROOT,
    contextChars: options.contextChars,
  })
  const relativePath = plan.variant ? path.relative(REPO_ROOT, plan.variant.path).split(path.sep).join('/') : null
  return {
    ok: plan.ok,
    action: plan.action,
    manifest: manifestPath,
    selection,
    tier: plan.tier,
    ruleIndex: picked.ruleIndex,
    ruleId: picked.ruleIndex >= 0 && manifest.rules[picked.ruleIndex] ? manifest.rules[picked.ruleIndex].id : null,
    matchedBy: picked.matchedBy,
    fallback: picked.fallback,
    reason: picked.reason,
    variant: plan.variant ? {
      path: plan.variant.path,
      relativePath,
      exists: plan.variant.exists,
      chars: plan.variant.chars,
      sha256: plan.variant.sha256,
      withinRoot: plan.variant.withinRoot,
    } : null,
    maxPromptChars: manifest.maxPromptChars,
    headroom: plan.headroom,
    warnings: plan.warnings,
  }
}

function printPlan(payload) {
  console.log('manifest: ' + payload.manifest)
  console.log('model: ' + payload.selection.model + (payload.selection.provider ? ' (provider: ' + payload.selection.provider + ')' : ''))
  console.log('tier: ' + payload.tier + (payload.fallback ? ' (fallback)' : ''))
  console.log('rule: ' + (payload.ruleIndex >= 0 ? '#' + payload.ruleIndex + ' ' + (payload.ruleId || '') : '(no rule)'))
  if (payload.reason) console.log('reason: ' + payload.reason)
  if (payload.variant) {
    console.log('variant: ' + payload.variant.relativePath)
    console.log('chars: ' + payload.variant.chars + ' / ' + payload.maxPromptChars)
    console.log('sha256: ' + (payload.variant.sha256 || '(missing)'))
  }
  console.log('action: ' + payload.action)
  if (payload.headroom !== null) console.log('headroom: ' + payload.headroom)
  console.log('warnings: ' + (payload.warnings.length ? payload.warnings.join(', ') : 'none'))
}

function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error('prompt-tier: ' + error.message)
    console.error(USAGE)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  try {
    const { manifest, validation } = loadChecked(options.manifest)
    if (options.validate) {
      if (options.json) console.log(JSON.stringify(validationJson(validation, options.manifest), null, 2))
      else printValidation(validation, options.manifest)
      return validation.ok ? 0 : 2
    }
    if (!validation.ok) {
      if (options.json) console.log(JSON.stringify(validationJson(validation, options.manifest), null, 2))
      else printValidation(validation, options.manifest)
      return 2
    }
    if (options.list) {
      const payload = listPayload(manifest, options.manifest)
      if (options.json) console.log(JSON.stringify(payload, null, 2))
      else printList(payload)
      return 0
    }
    const payload = planPayload(options, manifest, options.manifest)
    if (options.json) console.log(JSON.stringify(payload, null, 2))
    else printPlan(payload)
    return 0
  } catch (error) {
    if (error instanceof CliError) {
      console.error('prompt-tier: ' + error.message)
      return 2
    }
    console.error('prompt-tier: ' + (error && error.stack ? error.stack : String(error)))
    return 2
  }
}

process.exitCode = main(process.argv.slice(2))
