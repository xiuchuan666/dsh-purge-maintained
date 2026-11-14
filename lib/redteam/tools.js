/**
 * RedTeam 智能体工具集（preset 平面）
 *
 * 这些行只向 `tools` 注册模型可见工具，自身不发布任何服务，因此不需要 isolate realm；
 * 它们解析的是 host 平面的 `ctx.redteam`（dsh-redteam-store 发布的进程级实例）。
 *
 * 设计约定：
 *   · 写入一律走 redteam_asset_add / redteam_asset_link，智能体不直接碰 SQL；
 *   · 每次发现都带 provenance（passive|active）与 tool，保证界面上的来源标注可信；
 *   · **靶标按根会话隔离**：绑定键是会话的根祖先 id，子智能体顺着
 *     `session.header.parentSession` 继承父会话的靶标 —— 多会话并行时互不串写，
 *     报告不会再被别的靶标的成果污染（v0.9.0 之前的全局「当前靶标」指针正是串写的根源）；
 *   · 并发硬约束：`redteam_agent_slot` 用 `ctx.subagents.listChildren` 的真实运行数
 *     卡住"同一靶标最多 3 个执行智能体"，超了直接拒绝，不靠提示词自觉。
 */
import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ROLE_TITLES, PLANNER_ROLE, ROLE_ORDER } from './store-core.js'
/* 技能可用性判定只有一份实现：面板的「技能库」页签与这里共用（见该文件头注释） */
import { bundledSkillSummaries, checkSkill, summarizeSkills, expandSkillPath, redteamSummariesForCheck } from './skill-availability.js'
import {
  loadPlatformConfig,
  mergeConfigEnv,
  platformSummary,
  toolkitDirOf,
} from './platform-config.js'
import { maxAgentsOf } from './settings.js'
import { EvidenceLedger, UnknownRegistry } from './evidence-ledger.mjs'
import { registerReconTools } from './tool-specs-recon.js'
import { registerFindingTools } from './tool-specs-findings.js'
import { registerScoringTools } from './tool-specs-scoring.js'
import { registerKnowledgeTools } from './tool-specs-knowledge.js'
import { registerEvidenceTools } from './tool-specs-evidence.js'

/**
 * link: 源码包不在 profile node_modules 树内，静态 import `@deepseek-ai/dsh-tools`
 * 会解析失败 → 预设行 fiber 为 undefined（never started）→ 整份「红队模式」被下拉过滤。
 * 这里从运行中的 dsh / profile 路径 createRequire。
 */
export function addCandidate(list, pkg) {
  if (!pkg) return
  const norm = String(pkg).replace(/\\/g, '/')
  if (!list.includes(norm)) list.push(norm)
}

export function considerBin(list, bin) {
  if (!bin) return
  let text = String(bin).replace(/\\/g, '/')
  try { text = realpathSync(bin).replace(/\\/g, '/') } catch { /* 解析不了就用原路径 */ }
  const needle = '/node_modules/@deepseek-ai/dsh/'
  const at = text.lastIndexOf(needle)
  if (at >= 0) addCandidate(list, text.slice(0, at + needle.length - 1) + '/package.json')
  const nm = text.lastIndexOf('/node_modules/')
  if (nm >= 0) addCandidate(list, join(text.slice(0, nm), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const dir = dirname(text)
  /* npm 全局的 argv 常常是 …/bin/dsh，真正的包在旁边的 lib/node_modules。 */
  addCandidate(list, join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  addCandidate(list, join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

/**
 * 候选 `@deepseek-ai/dsh-tools` 的 package.json 名单（越可能命中越靠前）。
 *
 * 为什么单独一个纯函数：这条链要覆盖 npm 全局 / profile / 桌面解包 / app.asar.unpacked
 * 四种布局，每一种在宿主升级时都可能挪位。做成只吃参数的纯函数，才可能在不装宿主的
 * 机器上逐条钉顺序；`loadDefineTool()` 只负责把真实进程参数喂进来。
 */
export function defineToolCandidates(options = {}) {
  const argv1 = options.argv1 === undefined ? process.argv[1] : options.argv1
  const execPath = options.execPath === undefined ? process.execPath : options.execPath
  const resourcesPath = options.resourcesPath === undefined ? (process.resourcesPath || '') : options.resourcesPath
  const cwd = options.cwd === undefined ? process.cwd() : options.cwd
  const home = options.home === undefined ? homedir() : options.home
  const dshHome = options.dshHome === undefined ? process.env.DSH_HOME : options.dshHome
  const candidates = []
  try { considerBin(candidates, argv1) } catch { /* ignore */ }
  try { considerBin(candidates, execPath) } catch { /* ignore */ }
  const homes = [dshHome, home ? join(home, '.dsh') : ''].filter(Boolean)
  for (const dir of homes) {
    addCandidate(candidates, join(dir, 'package.json'))
    for (const profile of ['web', 'desktop', 'default']) {
      addCandidate(candidates, join(dir, 'profiles', profile, 'package.json'))
      addCandidate(candidates, join(dir, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  const exeDir = execPath ? dirname(execPath) : ''
  const desktopRoots = [
    resourcesPath,
    exeDir ? join(exeDir, 'resources') : '',
    exeDir,
  ].filter(Boolean)
  for (const root of desktopRoots) {
    addCandidate(candidates, join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  }
  addCandidate(candidates, join(cwd, 'package.json'))
  addCandidate(candidates, join('D:', 'DeepSeek Harness', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  return candidates
}

/**
 * 逐条试候选表，第一条能解析出 defineTool 的就用。
 *
 * 抽出来是为了可测：本机可能直接解析成功（开发机的宿主树就在盘上），CI 上则一条都
 * 解析不到 —— 同一个函数在两种环境给出两个结果，写着「返回一个函数」的用例必然在
 * 其中一边假红。候选表由调用方给，这个函数就只依赖文件系统。
 */
export function resolveDefineTool(candidates) {
  for (const pkg of candidates || []) {
    try {
      if (!pkg || !existsSync(pkg)) continue
      const mod = createRequire(pkg)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch { /* try next */ }
  }
  throw new Error('dsh-purge/redteam/tools: cannot resolve @deepseek-ai/dsh-tools from host')
}

export function loadDefineTool() {
  try {
    const req = createRequire(import.meta.url)
    const mod = req('@deepseek-ai/dsh-tools')
    const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
    if (typeof fn === 'function') return fn
  } catch { /* 插件自己的 node_modules 里没有，再扫宿主 */ }
  return resolveDefineTool(defineToolCandidates())
}

/** 0.2.1：任何 type=object 都必须显式 additionalProperties，否则整份红队预设加载失败。 */
function sealObjectSchemas(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) {
    for (const item of node) sealObjectSchemas(item)
    return node
  }
  if (node.type === 'object' && node.additionalProperties === undefined) {
    node.additionalProperties = node.properties ? false : true
  }
  if (node.properties) {
    for (const key of Object.keys(node.properties)) sealObjectSchemas(node.properties[key])
  }
  if (node.items) sealObjectSchemas(node.items)
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    sealObjectSchemas(node.additionalProperties)
  }
  return node
}

/**
 * 用宿主提供的 defineTool 造一个「封口版」定义器。
 *
 * 为什么要工厂而不是模块级常量：`loadDefineTool()` 在模块顶层调用时，任何没有
 * 宿主的环境（单测、覆盖率统计、CI）连 import 都会抛
 * `cannot resolve @deepseek-ai/dsh-tools from host` —— 2256 行代码于是完全不可测。
 * 改成调用 apply() 时才解析：生产路径一行没变，测试可以塞一个桩进来。
 */
function makeDefineTool(rawDefineTool) {
  return function defineTool(spec) {
    if (spec && spec.parameters) sealObjectSchemas(spec.parameters)
    const tool = rawDefineTool(spec)
    if (tool && tool.parameters) sealObjectSchemas(tool.parameters)
    if (tool && tool.inputSchema) sealObjectSchemas(tool.inputSchema)
    if (tool && tool.schema) sealObjectSchemas(tool.schema)
    return tool
  }
}

/** Cordis 插件名。 */
export const name = 'dsh-purge-redteam-tools'

/** 硬依赖工具注册表；`redteam` 在 host 平面由 store 发布，预设域内用软取。 */
export const inject = ['tools']

/** 根会话 id → engagementId 绑定（一次会话内稳定；进程重启后由 agent 重新绑定）。 */
const bindings = new Map()

/** 并发闸门：根会话 id → Map(子智能体键 → 预留时间戳)。子智能体结束时自动释放。 */
const reservations = new Map()

/** FIFO cap:长会话累积失效的 session id,防无限涨。订单最老的被淘汰(FIFO,近似 LRU)。 */
const BINDINGS_CAP = 500
const RESERVATIONS_CAP = 500
function capMap(m, cap) {
  const origSet = m.set.bind(m)
  m.set = (k, v) => {
    if (!m.has(k) && m.size >= cap) {
      const first = m.keys().next().value
      if (first !== undefined) m.delete(first)
    }
    return origSet(k, v)
  }
}
capMap(bindings, BINDINGS_CAP)
capMap(reservations, RESERVATIONS_CAP)

/** 并发上限：每次调用现读 settings.json → REDTEAM_MAX_AGENTS → 默认 3。 */
function maxAgentsNow(ctx) {
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  return maxAgentsOf(root, process.env)
}

/** 一次调用的会话解析结果。 */
function sessionInfoOf(exec) {
  const agent = exec && exec.agent
  const session = agent && agent.session
  if (session === undefined || session === null) return {}
  const id = session.id === undefined ? undefined : String(session.id)
  let parentId
  try {
    const header = session.header
    parentId = header && header.parentSession !== undefined && header.parentSession !== null
      ? String(header.parentSession)
      : undefined
  } catch { parentId = undefined }
  return { id: id, parentId: parentId, session: session }
}

/**
 * 解析"根会话"：一路沿 parentSession 走到最顶层的会话 id。
 * 主会话派出的子智能体因此共享同一个绑定键，而**不同主会话之间天然隔离**。
 * 顺手把沿途会话 id 都返回，便于把绑定缓存到子会话上。
 */
function resolveRootSession(session) {
  const chain = []
  let cur = session
  let guard = 0
  while (cur !== undefined && cur !== null && guard < 64) {
    const info = sessionInfoOf({ agent: { session: cur } })
    if (info.id === undefined) break
    chain.push(info.id)
    if (info.parentId === undefined || info.parentId === '') break
    let parent
    try {
      const store = cur.store
      parent = store && typeof store.get === 'function' ? store.get(info.parentId) : undefined
    } catch { parent = undefined }
    if (parent === undefined || parent === null) {
      /* 父会话不在内存里（被回收 / 冷启动）：父 id 本身就是稳定的根键 */
      return { rootId: info.parentId, chain: chain.concat([info.parentId]) }
    }
    cur = parent
    guard += 1
  }
  return { rootId: chain.length > 0 ? chain[chain.length - 1] : undefined, chain: chain }
}

/** 绑定键 + 会话链。 */
function bindingKeyOf(exec) {
  const info = sessionInfoOf(exec)
  if (info.id === undefined) return { rootId: undefined, sessionId: undefined, chain: [] }
  const resolved = resolveRootSession(info.session)
  const rootId = resolved.rootId === undefined ? info.id : resolved.rootId
  return { rootId, sessionId: info.id, chain: resolved.chain }
}

/**
 * 解析本次调用应作用在哪个靶标上（会话隔离版）。
 *
 * 顺序：① 显式传入 → ② 本会话/父链上的绑定 → ③ 全局「当前靶标」指针
 * （仅当没有被别的会话占用；被占用时报错并提示显式绑定，**绝不静默串写**）。
 *
 * 抛错而不是"随便挑一个"是刻意的：多会话并行时挑错靶标 = 把 A 单位的成果写进
 * B 单位的库、A 的报告里出现 B 的数据（这正是要多会话隔离的原因）。
 */
function resolveEngagement(store, exec, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  const keys = Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
  for (const key of keys) {
    const bound = bindings.get(key)
    if (typeof bound === 'string' && bound.length > 0) return bound
  }
  if (typeof store.activeEngagementId === 'function') {
    const active = store.activeEngagementId()
    if (active !== undefined) {
      const holder = Array.from(bindings.entries()).find(([k, v]) => v === active && !keys.includes(k))
      if (holder !== undefined) {
        throw new Error(
          '本会话尚未绑定靶标，而全局「当前靶标」' + active + ' 已被另一个会话占用；'
          + '为避免多会话串写同一个靶标库，请显式绑定：redteam_engagement_open（新建/打开）'
          + ' 或 redteam_session_bind（绑定到已有靶标）。',
        )
      }
      for (const key of keys) bindings.set(key, active)
      return active
    }
  }
  const list = store.listEngagements()
  if (list.length === 1) {
    for (const key of keys) bindings.set(key, list[0].id)
    return list[0].id
  }
  throw new Error('尚未绑定靶标：请先调用 redteam_engagement_open 传入靶标单位名称')
}

/** 当前会话的绑定关系（redteam_session_info 与面板展示用）。 */
function bindingViewOf(exec) {
  const info = sessionInfoOf(exec)
  const { rootId, chain } = bindingKeyOf(exec)
  return {
    session_id: info.id ?? null,
    parent_session: info.parentId ?? null,
    root_session: rootId ?? null,
    session_chain: chain,
    is_subagent: info.parentId !== undefined,
    bound_engagement: rootId !== undefined ? (bindings.get(rootId) ?? null) : null,
  }
}

/** 逗号/空白分隔的清单 → 去重数组。 */
function splitList(value) {
  return String(value || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
}

/** 把一行资产压成模型可读的紧凑结构（避免把整库原始数据塞进上下文）。 */
function compactAsset(a) {
  return {
    id: a.id,
    ip: a.ip,
    segment: a.segment_cidr,
    state: a.state,
    name: a.primary_name,
    names: a.names.map((n) => n.name),
    ports: a.ports.filter((p) => p.state === 'open')
      .map((p) => p.port + '/' + p.proto + (p.service ? ' ' + [p.service, p.product, p.version].filter(Boolean).join(' ') : '') + ' [' + p.provenance + ']'),
    fingerprints: a.fingerprints.map((f) => [f.category, f.vendor, f.product, f.version].filter(Boolean).join(' ') + ' [' + f.provenance + ']'),
    passive: a.passive,
    active: a.active,
    /* 发现时间：这条资产第一次进入本库的时刻（面板与报告都按它排时间线） */
    discovered_at: a.discovered_at,
    first_seen: a.first_seen,
    last_seen: a.last_seen,
    test_status: a.test_status,
    priority: a.priority,
  }
}

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/** 角色 code 的合法值说明（写进工具 description，模型不用猜）。 */
const ROLE_HINT = '角色 code：' + ROLE_ORDER.map((r) => '`' + r + '`（' + ROLE_TITLES[r] + '）').join('、')

function bindKeysOf(exec) {
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  return Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
}

/** 实时并发占用：读 subagents 注册表里"真正在跑"的直接子会话数。 */
async function liveRunningChildren(ctx, rootSessionId) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined || subagents === null || typeof subagents.listChildren !== 'function') {
    return { available: false, running: 0, error: 'subagents 注册表不可用（无法核对实际并发数，只能按预留计数）' }
  }
  try {
    const entries = await subagents.listChildren(rootSessionId)
    const rows = Array.isArray(entries) ? entries : []
    const running = rows.filter((e) => e && e.kind === 'child' && e.activity === 'running')
    return {
      available: true,
      running: running.length,
      running_labels: running.map((e) => e.label || e.id).slice(0, 20),
      total_children: rows.filter((e) => e && e.kind === 'child').length,
    }
  } catch (error) {
    return { available: false, running: 0, error: '列子会话失败：' + (error && error.message ? error.message : String(error)) }
  }
}

/** 预留（未被 subagents 注册表覆盖的那部分，例如刚 acquire 还没起来的）。 */
function reservationList(rootId) {
  const map = reservations.get(rootId)
  if (map === undefined) return []
  return Array.from(map, ([key, at]) => ({ key, at }))
}

function addReservation(rootId, key) {
  if (!reservations.has(rootId)) reservations.set(rootId, new Map())
  reservations.get(rootId).set(key, Date.now())
}

function dropReservation(rootId, key) {
  const map = reservations.get(rootId)
  if (map === undefined) return false
  if (key === undefined) {
    /* 无 key 时只释放最早的一条（与工具描述一致）——清空整张表会把别的在途预留一起放掉，名额超卖 */
    let oldestKey = null
    let oldestAt = Infinity
    for (const [k, at] of map) {
      if (at < oldestAt) { oldestAt = at; oldestKey = k }
    }
    return oldestKey !== null ? map.delete(oldestKey) : false
  }
  return map.delete(key)
}

/**
 * 产出这条记录的智能体角色：显式传的优先，否则默认按主会话记账。
 * 这个值会写进库里的 `agent` 列，报告里"这一步是谁做的"就靠它。
 */
function agentOf(args) {
  const raw = typeof args.agent === 'string' ? args.agent.trim() : ''
  return raw !== '' ? raw : PLANNER_ROLE
}

/** 写库工具共用的 agent 参数（角色 code 白名单提示写进 description）。 */
const AGENT_PARAM = {
  type: 'string',
  description: '【建议填】产出这条记录的角色 —— ' + ROLE_HINT
    + '。报告里会按它标注"这一步是谁做的"，不填按主会话记账。',
}

/**
 * 把 store 层抛出的异常统一收敛成结构化的失败返回。
 *
 * 为什么需要：同一类错误（对象不存在 / 参数非法）此前有两种形态 ——
 * 有的工具 `return { ok:false, error }`，有的直接抛。模型拿到前者能换参数重试，
 * 拿到后者往往直接放弃这一次调用，行为不可预测。统一成前者，且**不吞原始信息**。
 * @param tool - defineTool 的返回值。
 * @returns 包了一层 try/catch 的同一个工具定义。
 */
function withStructuredErrors(tool) {
  const inner = tool.execute
  if (typeof inner !== 'function') return tool
  return Object.assign({}, tool, {
    async execute(args, exec) {
      try {
        return await inner(args, exec)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        /* 参数类错误（非法值/缺必填）与"找不到对象"分开提示，模型据此决定重试还是放弃 */
        const kind = /非法|invalid|required|不能为空|not found|不存在/i.test(message) ? 'bad_input' : 'failed'
        return JSON.stringify({
          ok: false,
          error: message,
          error_kind: kind,
          hint: kind === 'bad_input'
            ? '这是参数或对象标识的问题：核对参数名与取值（可用对应的 *_list / *_query 工具先看实际 id），修正后重试。'
            : '工具执行失败，错误原文见 error 字段；不要静默跳过，先向用户或指挥者说明卡点。',
        }, null, 2)
      }
    },
  })
}

export function apply(ctx) {
  /* 定义器在调用时解析：`ctx.defineTool` 是测试注入点，生产走 loadDefineTool()。 */
  const defineTool = makeDefineTool(
    typeof ctx?.defineTool === 'function' ? ctx.defineTool : loadDefineTool(),
  )
  let store
  try {
    store = ctx.redteam
  } catch {
    store = undefined
  }
  if (!store) {
    try { store = ctx.get('redteam') } catch { store = undefined }
  }
  if (!store) {
    ctx.logger?.warn?.('redteam-tools: host ctx.redteam unavailable — tools will report store_missing')
    store = {
      openEngagement: () => { throw new Error('红队资产库不可用') },
      listEngagements: () => [],
      stats: () => ({}),
    }
  }

  /* ── 子智能体结束时自动释放并发名额（不依赖模型记得调 release）──────────── */
  /* ctx.effect 包起来 → plugin dispose 时解绑 subagent/end,否则 handler 残留 + 热重载翻倍。 */
  ctx.effect(() => {
    let disposer = null
    try {
      disposer = ctx.on('subagent/end', (info, parent) => {
        const parentSession = parent && parent.session
        const { rootId } = bindingKeyOf({ agent: { session: parentSession } })
        const childId = info && info.id !== undefined ? String(info.id) : undefined
        if (rootId === undefined) return
        if (childId !== undefined && dropReservation(rootId, childId)) return
        /* 注册表里的键可能与 runId 不同：按时间兜底清掉最早的一个预留 */
        const map = reservations.get(rootId)
        if (map === undefined || map.size === 0) return
        let oldestKey
        let oldestAt = Number.POSITIVE_INFINITY
        for (const [key, at] of map) { if (at < oldestAt) { oldestAt = at; oldestKey = key } }
        if (oldestKey !== undefined) map.delete(oldestKey)
      })
    } catch { /* 事件不可用时只影响自动释放，手动 release 仍然可用 */ }
    return () => { try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ } }
  })

  registerReconTools({ ctx, store, defineTool, withStructuredErrors, text, ROLE_HINT, resolveEngagement, agentOf, AGENT_PARAM, compactAsset, splitList, bindKeysOf, bindingViewOf, addReservation, dropReservation, reservationList, maxAgentsNow, liveRunningChildren, bindings, reservations, bindingKeyOf, sessionInfoOf, resolveRootSession, capMap, BINDINGS_CAP, RESERVATIONS_CAP })
  registerFindingTools({ ctx, store, defineTool, withStructuredErrors, text, ROLE_HINT, resolveEngagement, agentOf, AGENT_PARAM, compactAsset, splitList, bindKeysOf, bindingViewOf, addReservation, dropReservation, reservationList, maxAgentsNow, liveRunningChildren, bindings, reservations, bindingKeyOf, sessionInfoOf, resolveRootSession, capMap, BINDINGS_CAP, RESERVATIONS_CAP })
  registerScoringTools({ ctx, store, defineTool, withStructuredErrors, text, ROLE_HINT, resolveEngagement, agentOf, AGENT_PARAM, compactAsset, splitList, bindKeysOf, bindingViewOf, addReservation, dropReservation, reservationList, maxAgentsNow, liveRunningChildren, bindings, reservations, bindingKeyOf, sessionInfoOf, resolveRootSession, capMap, BINDINGS_CAP, RESERVATIONS_CAP })
  registerKnowledgeTools({ ctx, store, defineTool, withStructuredErrors, text, ROLE_HINT, resolveEngagement, agentOf, AGENT_PARAM, compactAsset, splitList, bindKeysOf, bindingViewOf, addReservation, dropReservation, reservationList, maxAgentsNow, liveRunningChildren, bindings, reservations, bindingKeyOf, sessionInfoOf, resolveRootSession, capMap, BINDINGS_CAP, RESERVATIONS_CAP })
  registerEvidenceTools({ ctx, store, defineTool, withStructuredErrors, text, ROLE_HINT, resolveEngagement, agentOf, AGENT_PARAM, compactAsset, splitList, bindKeysOf, bindingViewOf, addReservation, dropReservation, reservationList, maxAgentsNow, liveRunningChildren, bindings, reservations, bindingKeyOf, sessionInfoOf, resolveRootSession, capMap, BINDINGS_CAP, RESERVATIONS_CAP })
}
