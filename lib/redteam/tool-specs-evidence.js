/**
 * 红队工具定义：Evidence（时间线、证据台账、作战问题）。
 *
 * 从 lib/redteam/tools.js 按领域切出来的（原来是 2269 行的单个 apply）。
 * 这里只放工具定义本身；绑定解析、并发闸门、错误包装仍由 tools.js 提供，
 * 通过 deps 注入进来 —— 这样每个组都能独立读，且不复制任何判定逻辑。
 */
import { EvidenceLedger, UnknownRegistry } from './evidence-ledger.mjs'

export function registerEvidenceTools(deps) {
  const { ctx, store, defineTool, withStructuredErrors, text, resolveEngagement, agentOf } = deps

  function ledgerOf(engagementId) {
    if (typeof store.db !== 'function') throw new Error('红队资产库不可用')
    return new EvidenceLedger(store.db(engagementId))
  }
  function unknownsOf(engagementId) {
    if (typeof store.db !== 'function') throw new Error('红队资产库不可用')
    return new UnknownRegistry(store.db(engagementId))
  }

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_timeline',
    description: '资产「发现时间」视图：按天聚合"哪天收了多少资产"（区分内网/外网），并列出最近发现的资产。用于回答"这个资产是什么时候发现的"、检查信息收集有没有断层，也用于本轮收集的收口核对。',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: '最近资产条数，默认 50' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const data = store.discoveryTimeline(id, { limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id,
        span: data.span,
        days: data.days,
        recent: data.recent.map((a) => ({
          id: a.id, ip: a.ip, scope: a.scope, state: a.state, name: a.primary_name,
          discovered_at: a.discovered_at, last_seen: a.last_seen, open_ports: a.open_ports, priority: a.priority,
        })),
        hint: '发现时间 = 这条资产**第一次进入本库**的时刻；重复采集只刷新 last_seen。'
          + '报告附录与资产测绘页都按它排序。',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_record',
    description: '记录一条作战证据。核心纪律：confidence 必须如实填写——claimed（子智能体口头报告，禁止直接采信）/ observed（你亲自核实过）/ derived（从 observed 推理）/ inferred（推测，必须标注）。ev_id 由内容哈希生成，改一字就变，落库后可防篡改核对。相关技能：evidence-discipline。',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string', required: true, description: '操作名，如 "nmap_scan"、"webshell_established"、"sql_injection_confirmed"' },
      parameters: { type: 'object', additionalProperties: true, description: '调用参数（JSON 对象，会参与哈希）' },
      result: { type: 'object', additionalProperties: true, required: true, description: '规范化结果（JSON 对象，会参与哈希）' },
      confidence: { type: 'string', description: 'claimed | observed | derived | inferred，默认 observed' },
      authority: { type: 'string', description: 'tool-output | database-record | screenshot | request-replay | subagent-report | operator-input，默认 tool-output' },
      limitations: { type: 'array', items: { type: 'string' }, description: '局限性说明，如 ["只扫了 Top1000 端口"]' },
      supporting_ev_ids: { type: 'array', items: { type: 'string' }, description: '支撑这条证据的其他 ev_id' },
      source_agent: { type: 'string', description: '哪个子智能体产出的（claimed 时必填）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).record({
        operation: args.operation,
        parameters: args.parameters ?? {},
        result: args.result,
        confidence: args.confidence,
        authority: args.authority,
        limitations: args.limitations ?? [],
        supporting_ev_ids: args.supporting_ev_ids ?? [],
        source_agent: args.source_agent,
        recorded_by: agentOf(args),
        engagement_id: id,
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_verify',
    description: '核对子智能体回报与证据账本是否一致（hash 级核对）。matched=false 表示子智能体改口、夸大或库里没有。',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string', required: true },
      parameters: { type: 'object', additionalProperties: true },
      result: { type: 'object', additionalProperties: true, required: true },
      confidence: { type: 'string' },
      authority: { type: 'string' },
      limitations: { type: 'array', items: { type: 'string' } },
      supporting_ev_ids: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).verify({
        operation: args.operation,
        parameters: args.parameters ?? {},
        result: args.result,
        confidence: args.confidence ?? 'observed',
        authority: args.authority ?? 'tool-output',
        limitations: args.limitations ?? [],
        supporting_ev_ids: args.supporting_ev_ids ?? [],
      })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_upgrade',
    description: '把 claimed / inferred 升级为 observed。必须带 verified_result（亲自验证的回显/数据）。',
    parameters: {
      engagement: { type: 'string' },
      claimed_ev_id: { type: 'string', required: true, description: '要升级的证据 ID' },
      verified_result: { type: 'object', additionalProperties: true, description: '亲自验证后的实际结果' },
      verified_by: { type: 'string', description: '谁核实的，默认 coordinator' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).upgrade({
        claimed_ev_id: args.claimed_ev_id,
        verified_result: args.verified_result,
        verified_by: args.verified_by ?? agentOf(args),
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_list',
    description: '列出证据账本条目，可按 operation / confidence 过滤。汇报前先确认没有未升级的 claimed。',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string' },
      confidence: { type: 'string', description: 'claimed | observed | derived | inferred' },
      limit: { type: 'number' },
      offset: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const items = ledgerOf(id).list({
        operation: args.operation,
        confidence: args.confidence,
        engagement_id: id,
        limit: args.limit ?? 50,
        offset: args.offset ?? 0,
      })
      return JSON.stringify({ ok: true, engagement: id, items }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unverified_count',
    description: '当前靶标还有多少条 claimed/inferred 没有闭环核实。返回 >0 时汇报必须提醒未核实条数。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const count = ledgerOf(id).countUnresolvedClaims(id)
      return JSON.stringify({
        ok: true, engagement: id, unverified_count: count,
        hint: count > 0 ? `还有 ${count} 条 claimed/inferred 未闭环核实，汇报时不要说"已拿到"` : '所有子智能体报告都已亲自核实闭环',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_record',
    description: '记录一个还没解决的作战问题。question+domain 相同会去重。',
    parameters: {
      engagement: { type: 'string' },
      question: { type: 'string', required: true },
      severity: { type: 'string', description: 'low | medium | high | critical，默认 medium' },
      domain: { type: 'string', description: '如 internal-recon / boundary-break / lateral-movement' },
      recommended_probe: { type: 'string', description: '建议的验证手段' },
      supporting_ev_ids: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = unknownsOf(id).record({
        question: args.question,
        severity: args.severity ?? 'medium',
        domain: args.domain ?? 'general',
        recommended_probe: args.recommended_probe,
        supporting_ev_ids: args.supporting_ev_ids ?? [],
        engagement_id: id,
        recorded_by: agentOf(args),
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_resolve',
    description: '把未解决问题标为 resolved / contradicted。',
    parameters: {
      engagement: { type: 'string' },
      unk_id: { type: 'string', required: true },
      disposition: { type: 'string', required: true, description: 'resolved | contradicted' },
      resolution: { type: 'string', description: '解决说明' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = unknownsOf(id).resolve(args.unk_id, args.disposition, args.resolution, agentOf(args))
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_list',
    description: '列出未解决的作战问题，派活前先看 open 项。',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'open | investigating | blocked | contradicted | resolved' },
      severity: { type: 'string' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const items = unknownsOf(id).list({
        status: args.status ?? 'open',
        severity: args.severity,
        engagement_id: id,
        limit: args.limit ?? 50,
      })
      return JSON.stringify({ ok: true, engagement: id, items }, null, 2)
    },
  })))
}
