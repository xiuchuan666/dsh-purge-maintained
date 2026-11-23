/**
 * 模型分档载荷核心（P3-8a）：模型 -> 档位 -> 提示词变体的纯函数层。
 *
 * 这一层只做决策，不改运行时注入路径：
 *   normalizeModelId / normalizeSelection  归一化模型标识
 *   loadManifest / validateManifest        manifest 读取与契约校验
 *   matchRule / selectTier                 规则匹配与档位选择
 *   resolveVariant                         解析 promptPath 的只读文件事实
 *   planTierPrompt                         汇总成一份 apply/skip 计划
 *
 * 约束：
 *   - 除 loadManifest / resolveVariant 的只读访问外没有 I/O 副作用；
 *   - 所有 promptPath 必须锚定在显式传入的 root 内，越界抛 PROMPT_TIER_ESCAPE；
 *   - manifest 的 evidence 只是启发式标签（heuristic-unverified），不是实测结论。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PROMPT_TIER_SCHEMA = 1
export const PROMPT_TIER_KIND = 'dsh-prompt-tiers'
export const PROMPT_TIER_ESCAPE = 'PROMPT_TIER_ESCAPE'
export const PROMPT_TIER_UNKNOWN = 'PROMPT_TIER_UNKNOWN'
export const MANIFEST_READ_ERROR = 'MANIFEST_READ_ERROR'
export const MANIFEST_PARSE_ERROR = 'MANIFEST_PARSE_ERROR'

const REGEX_FLAGS = /^[a-z]*$/i

function textOf(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function lowerOf(value) {
  return textOf(value).toLowerCase()
}

function errorWithCode(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function tierListOf(manifest) {
  return manifest && Array.isArray(manifest.tiers) ? manifest.tiers : []
}

/** 按 id 找档位定义；找不到返回 null。 */
export function findTier(manifest, tierId) {
  const id = textOf(tierId)
  if (!id) return null
  for (const tier of tierListOf(manifest)) {
    if (tier && textOf(tier.id) === id) return tier
  }
  return null
}

/** 第一个 ':' 或 '/' 作为 provider 与 model 的分隔符；没有分隔符时 provider 为空。 */
function splitModel(value) {
  const text = lowerOf(value)
  if (!text) return { provider: '', model: '' }
  let separator = -1
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (char === ':' || char === '/') {
      separator = index
      break
    }
  }
  if (separator > 0) {
    return { provider: text.slice(0, separator), model: text.slice(separator + 1) }
  }
  return { provider: '', model: text }
}

/**
 * 归一化模型标识：小写、去首尾空白、拆出 provider。
 * 支持 "auto/deepseek-v4.1-flash"、"provider:model"、"model" 三种字符串写法，
 * 也接受 { provider, model } / { model } 对象。
 */
export function normalizeModelId(value) {
  if (isPlainObject(value)) {
    const explicitProvider = lowerOf(value.provider)
    const modelSource = value.model !== undefined ? value.model : value.modelId
    const parsed = splitModel(modelSource)
    return { provider: explicitProvider || parsed.provider, model: parsed.model }
  }
  return splitModel(value)
}

/**
 * 归一化选择器：返回 { provider, model, reasoningEffort? }；缺 model 返回 null。
 * input 可以是字符串，也可以是 { model, modelId?, provider?, reasoningEffort? }。
 */
export function normalizeSelection(input) {
  if (!input) return null
  if (typeof input === 'string') {
    const parsed = normalizeModelId(input)
    if (!parsed.model) return null
    return { provider: parsed.provider, model: parsed.model }
  }
  if (!isPlainObject(input)) return null
  const modelSource = input.model !== undefined ? input.model : input.modelId
  const parsed = normalizeModelId(modelSource)
  if (!parsed.model) return null
  const selection = {
    provider: lowerOf(input.provider) || parsed.provider,
    model: parsed.model,
  }
  const effortRaw = input.reasoningEffort !== undefined
    ? input.reasoningEffort
    : (input.reasoning_effort !== undefined ? input.reasoning_effort : input.effort)
  const effort = lowerOf(effortRaw)
  if (effort) selection.reasoningEffort = effort
  return selection
}

/** 读取 manifest JSON；读失败 / 解析失败都抛带 code 的 Error。 */
export function loadManifest(filePath) {
  const target = textOf(filePath)
  if (!target) throw errorWithCode(MANIFEST_READ_ERROR, 'manifest 路径为空')
  let text
  try {
    text = fs.readFileSync(target, 'utf8')
  } catch (error) {
    throw errorWithCode(MANIFEST_READ_ERROR, '读不了 manifest：' + (error && error.message ? error.message : String(error)))
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw errorWithCode(MANIFEST_PARSE_ERROR, 'manifest 不是合法 JSON：' + (error && error.message ? error.message : String(error)))
  }
}

function pushError(errors, code, message, where) {
  errors.push({ code, message, where: where || '' })
}

function pushWarning(warnings, code, message, where) {
  warnings.push({ code, message, where: where || '' })
}

function hasParentSegment(value) {
  return String(value).split(/[\\/]+/).some((part) => part === '..')
}

function isAbsolutePath(value) {
  const text = String(value)
  if (path.isAbsolute(text)) return true
  return /^[A-Za-z]:[\\/]/.test(text)
}

/** target 是否在 root 内（含 root 本身）；用 path.relative 判断，跨盘符会是绝对路径。 */
function withinRoot(rootAbs, targetAbs) {
  const rel = path.relative(rootAbs, targetAbs)
  if (!rel) return true
  if (path.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !rel.startsWith('../')
}

/** 解析 "/source/flags" 形式的正则；非法返回 null。 */
function parseRegexPattern(value) {
  const text = textOf(value)
  if (!text.startsWith('/')) return null
  const end = text.lastIndexOf('/')
  if (end <= 0) return null
  const source = text.slice(1, end)
  const flags = text.slice(end + 1)
  if (!REGEX_FLAGS.test(flags)) return null
  try {
    return new RegExp(source, flags.replace(/[gy]/g, ''))
  } catch {
    return null
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')
}

function globRegExp(glob) {
  let pattern = '^'
  for (const char of String(glob)) {
    if (char === '*') pattern += '.*'
    else if (char === '?') pattern += '.'
    else pattern += escapeRegExp(char)
  }
  return new RegExp(pattern + '$', 'i')
}

/** 单个 pattern 对单个字段值的匹配：精确 / glob / prefix: / /regex/flags。 */
function matchPattern(value, pattern) {
  const text = textOf(value)
  if (!text) return false
  if (pattern instanceof RegExp) {
    const flags = String(pattern.flags || '').replace(/[gy]/g, '')
    return new RegExp(pattern.source, flags).test(text)
  }
  const raw = textOf(pattern)
  if (!raw) return false
  if (raw.startsWith('/')) {
    const compiled = parseRegexPattern(raw)
    if (compiled) return compiled.test(text)
  }
  if (raw.toLowerCase().startsWith('prefix:')) {
    const prefix = raw.slice('prefix:'.length).trim().toLowerCase()
    return Boolean(prefix) && text.toLowerCase().startsWith(prefix)
  }
  return globRegExp(raw).test(text)
}

function matchFieldsOf(rule) {
  const match = rule && rule.match !== undefined ? rule.match : rule
  if (!isPlainObject(match)) return []
  const fields = []
  for (const field of ['provider', 'model']) {
    const raw = match[field]
    if (raw === undefined || raw === null) continue
    const list = Array.isArray(raw) ? raw : [raw]
    fields.push({ field, patterns: list })
  }
  return fields
}

function describeMatch(match) {
  if (!isPlainObject(match)) return ''
  const parts = []
  for (const field of ['provider', 'model']) {
    const raw = match[field]
    if (raw === undefined || raw === null) continue
    const list = Array.isArray(raw) ? raw : [raw]
    parts.push(field + '=' + list.map((item) => String(item)).join('|'))
  }
  return parts.join(' ')
}

/**
 * 规则命中：rule.match 里出现的每个字段都必须命中（AND），
 * 字段值支持精确、* / ? glob、prefix: 前缀与 /regex/flags。
 */
export function matchRule(selection, rule) {
  if (!isPlainObject(selection)) return false
  const fields = matchFieldsOf(rule)
  if (!fields.length) return false
  for (const { field, patterns } of fields) {
    const value = textOf(selection[field])
    if (!value) return false
    let hit = false
    for (const pattern of patterns) {
      if (matchPattern(value, pattern)) {
        hit = true
        break
      }
    }
    if (!hit) return false
  }
  return true
}

/**
 * 按 rules 顺序取首个命中；无命中回落 defaultTier。
 * 返回 { tier, ruleIndex, matchedBy, fallback, reason }。
 */
export function selectTier(selection, manifest) {
  const rules = manifest && Array.isArray(manifest.rules) ? manifest.rules : []
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]
    if (!rule || !matchRule(selection, rule)) continue
    return {
      tier: textOf(rule.tier),
      ruleIndex: index,
      matchedBy: isPlainObject(rule.match) ? { ...rule.match } : null,
      fallback: false,
      reason: 'rule #' + index + ' matched ' + (describeMatch(rule.match) || '(empty)'),
    }
  }
  const defaultTier = textOf(manifest && manifest.defaultTier)
  return {
    tier: defaultTier,
    ruleIndex: -1,
    matchedBy: null,
    fallback: true,
    reason: defaultTier
      ? 'no rule matched' + (selection && selection.model ? ' model=' + selection.model : '') + '; fallback to defaultTier=' + defaultTier
      : 'no rule matched and manifest.defaultTier is empty',
  }
}

/**
 * 校验 manifest 契约。errors / warnings 都是 { code, message, where } 数组。
 * options.root 用于把 promptPath 解析到真实路径并确认没有逃逸；不提供 root 时只做词法校验并告警。
 */
export function validateManifest(manifest, options = {}) {
  const errors = []
  const warnings = []
  if (!isPlainObject(manifest)) {
    pushError(errors, 'manifest-not-object', 'manifest 必须是对象')
    return { ok: false, errors, warnings }
  }
  if (manifest.schema !== PROMPT_TIER_SCHEMA) {
    pushError(errors, 'schema-invalid', 'schema 必须是 ' + PROMPT_TIER_SCHEMA + '，实际是 ' + String(manifest.schema))
  }
  if (manifest.kind !== undefined && manifest.kind !== PROMPT_TIER_KIND) {
    pushWarning(warnings, 'kind-unexpected', 'kind 不是 ' + PROMPT_TIER_KIND + '：' + String(manifest.kind))
  }
  const rootText = textOf(options.root)
  const rootAbs = rootText ? path.resolve(rootText) : ''

  const tiers = manifest.tiers
  const tiersValid = Array.isArray(tiers) && tiers.length > 0
  const tierIds = new Set()
  if (!tiersValid) {
    pushError(errors, 'tiers-invalid', 'tiers 必须是非空数组')
  } else {
    tiers.forEach((tier, index) => {
      const where = 'tiers[' + index + ']'
      if (!isPlainObject(tier)) {
        pushError(errors, 'tier-invalid', '档位必须是对象', where)
        return
      }
      const id = textOf(tier.id)
      if (!id) pushError(errors, 'tier-id-missing', '档位缺少 id', where + '.id')
      else if (tierIds.has(id)) pushError(errors, 'tier-id-duplicate', '档位 id 重复：' + id, where + '.id')
      else tierIds.add(id)

      const promptPath = textOf(tier.promptPath)
      if (!promptPath) {
        pushError(errors, 'tier-prompt-path-missing', '档位缺少 promptPath', where + '.promptPath')
      } else if (isAbsolutePath(promptPath)) {
        pushError(errors, 'tier-prompt-path-absolute', 'promptPath 必须是相对路径：' + promptPath, where + '.promptPath')
      } else if (hasParentSegment(promptPath)) {
        pushError(errors, 'tier-prompt-path-escape', 'promptPath 含 .. 段，可能越出 root：' + promptPath, where + '.promptPath')
      } else if (rootAbs && !withinRoot(rootAbs, path.resolve(rootAbs, promptPath))) {
        pushError(errors, 'tier-prompt-path-escape', 'promptPath 越出 root：' + promptPath, where + '.promptPath')
      }

      if (!textOf(tier.description)) pushWarning(warnings, 'tier-description-missing', '档位缺少 description', where + '.description')
      if (textOf(tier.evidence) !== 'heuristic-unverified') {
        pushWarning(warnings, 'tier-evidence-unverified', '档位 evidence 建议写成 heuristic-unverified', where + '.evidence')
      }
      if (tier.maxPromptChars !== undefined && !(Number.isInteger(tier.maxPromptChars) && tier.maxPromptChars > 0)) {
        pushError(errors, 'tier-max-prompt-chars-invalid', '档位 maxPromptChars 必须是正整数', where + '.maxPromptChars')
      }
    })
  }

  const defaultTier = textOf(manifest.defaultTier)
  if (!defaultTier) pushError(errors, 'default-tier-missing', 'defaultTier 不能为空')
  else if (tiersValid && !tierIds.has(defaultTier)) {
    pushError(errors, 'default-tier-unknown', 'defaultTier 不在 tiers 里：' + defaultTier, 'defaultTier')
  }
  if (!(Number.isInteger(manifest.maxPromptChars) && manifest.maxPromptChars > 0)) {
    pushError(errors, 'max-prompt-chars-invalid', 'maxPromptChars 必须是正整数', 'maxPromptChars')
  }

  if (!Array.isArray(manifest.rules)) {
    pushError(errors, 'rules-invalid', 'rules 必须是数组', 'rules')
  } else {
    const seen = new Set()
    manifest.rules.forEach((rule, index) => {
      const where = 'rules[' + index + ']'
      if (!isPlainObject(rule)) {
        pushError(errors, 'rule-invalid', '规则必须是对象', where)
        return
      }
      const tierId = textOf(rule.tier)
      if (!tierId) pushError(errors, 'rule-tier-missing', '规则缺少 tier', where + '.tier')
      else if (tiersValid && !tierIds.has(tierId)) pushError(errors, 'rule-tier-unknown', '规则指向未知档位：' + tierId, where + '.tier')

      const match = rule.match
      if (!isPlainObject(match)) {
        pushError(errors, 'rule-match-missing', '规则缺少 match 对象', where + '.match')
      } else {
        let fieldCount = 0
        for (const field of ['provider', 'model']) {
          const raw = match[field]
          if (raw === undefined || raw === null) continue
          const list = Array.isArray(raw) ? raw : [raw]
          let usable = 0
          for (const item of list) {
            const value = textOf(item)
            if (!value) continue
            usable += 1
            if (value.startsWith('/') && parseRegexPattern(value) === null) {
              pushError(errors, 'rule-pattern-invalid', '正则无法编译：' + value, where + '.match.' + field)
            }
          }
          if (usable === 0) pushError(errors, 'rule-pattern-invalid', 'match.' + field + ' 没有有效值', where + '.match.' + field)
          else fieldCount += 1
        }
        if (fieldCount === 0) pushError(errors, 'rule-match-missing', 'match 至少要给出 provider 或 model', where + '.match')
        const signature = JSON.stringify(match)
        if (seen.has(signature)) pushWarning(warnings, 'rule-unreachable', '与前序规则完全同形，永远轮不到', where)
        else seen.add(signature)
      }
    })
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * 解析档位的 promptPath 到绝对路径（只读）：
 * 返回 { path, exists, chars, sha256, withinRoot }；路径越出 root 抛 PROMPT_TIER_ESCAPE。
 */
export function resolveVariant(tier, manifest, options = {}) {
  const definition = typeof tier === 'string' ? findTier(manifest, tier) : (isPlainObject(tier) ? tier : null)
  if (!definition) {
    throw errorWithCode(PROMPT_TIER_UNKNOWN, '未知档位：' + (textOf(tier) || '(empty)'))
  }
  const promptPath = textOf(definition.promptPath)
  if (!promptPath) {
    throw errorWithCode(PROMPT_TIER_UNKNOWN, '档位 ' + textOf(definition.id) + ' 缺少 promptPath')
  }
  const rootAbs = path.resolve(textOf(options.root) || '.')
  const target = path.resolve(rootAbs, promptPath)
  const within = withinRoot(rootAbs, target)
  if (!within) {
    throw errorWithCode(PROMPT_TIER_ESCAPE, 'promptPath 越出 root：' + promptPath)
  }
  let exists = false
  let chars = 0
  let sha256 = null
  try {
    const stat = fs.statSync(target)
    if (stat.isFile()) {
      const buffer = fs.readFileSync(target)
      exists = true
      chars = buffer.toString('utf8').length
      sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    }
  } catch {
    exists = false
  }
  return { path: target, exists, chars, sha256, withinRoot: within }
}

/**
 * 只做计划，不写文件：
 * 返回 { ok, action: "apply"|"skip", tier, variant, headroom, warnings }。
 * contextChars 缺失时 headroom 为 null；prompt 不存在 / 超过 maxPromptChars / 超过上下文预算都会 skip。
 */
export function planTierPrompt({ selection, manifest, root, contextChars } = {}) {
  const warnings = []
  const normalized = normalizeSelection(selection)
  if (!normalized) {
    return { ok: false, action: 'skip', tier: null, variant: null, headroom: null, warnings: ['selection-missing'] }
  }
  const picked = selectTier(normalized, manifest)
  if (!picked.tier) {
    return { ok: false, action: 'skip', tier: null, variant: null, headroom: null, warnings: ['tier-unresolved'] }
  }
  let variant
  try {
    variant = resolveVariant(picked.tier, manifest, { root })
  } catch (error) {
    warnings.push(error && error.code ? error.code : 'prompt-resolve-error')
    return { ok: false, action: 'skip', tier: picked.tier, variant: null, headroom: null, warnings }
  }
  if (!variant.exists) {
    warnings.push('prompt-missing')
    return { ok: false, action: 'skip', tier: picked.tier, variant, headroom: null, warnings }
  }
  const definition = findTier(manifest, picked.tier)
  const tierMax = definition && definition.maxPromptChars !== undefined ? definition.maxPromptChars : undefined
  const maxRaw = tierMax !== undefined ? tierMax : manifest && manifest.maxPromptChars
  const maxChars = Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : Infinity
  if (!Number.isFinite(maxChars)) warnings.push('max-prompt-chars-missing')

  let action = 'apply'
  let headroom = null
  if (variant.chars > maxChars) {
    warnings.push('prompt-too-long:' + variant.chars + '>' + maxChars)
    action = 'skip'
  }
  if (contextChars !== undefined && contextChars !== null) {
    const budget = Number(contextChars)
    if (!Number.isFinite(budget) || budget <= 0) {
      warnings.push('context-chars-invalid')
    } else {
      headroom = budget - variant.chars
      if (headroom < 0) {
        warnings.push('context-overflow:' + variant.chars + '>' + budget)
        action = 'skip'
      }
    }
  }
  return { ok: action === 'apply', action, tier: picked.tier, variant, headroom, warnings }
}
