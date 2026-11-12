/**
 * 红队工具定义：Scoring（得分、攻击链、报告导出）。
 *
 * 从 lib/redteam/tools.js 按领域切出来的（原来是 2269 行的单个 apply）。
 * 这里只放工具定义本身；绑定解析、并发闸门、错误包装仍由 tools.js 提供，
 * 通过 deps 注入进来 —— 这样每个组都能独立读，且不复制任何判定逻辑。
 */
import { join } from 'node:path'

export function registerScoringTools(deps) {
  const { ctx, store, defineTool, withStructuredErrors, text, resolveEngagement, agentOf, AGENT_PARAM } = deps

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_path',
    description: '导出攻击图谱：资产拓扑 + 漏洞节点 + 已控制资产（meta.owned）。用于横向移动路径规划与战果汇报。节点过多时用 cidr 缩小范围。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      maxNodes: { type: 'number', description: '默认 400' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 400, 1500)
      const graph = store.attackGraph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: '图谱节点过多（' + graph.nodes.length + ' > ' + maxNodes + '），请指定 cidr 缩小范围',
          summary: graph.summary,
        }, null, 2)
      }
      return JSON.stringify({
        ok: true, engagement: id, summary: graph.summary,
        owned: graph.nodes.filter((n) => n.meta && n.meta.owned).map((n) => n.label),
        nodes: graph.nodes, edges: graph.edges,
      }, null, 2)
    },
  })))

  /* ================================================================== 域名 / Web 资产 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_web_list',
    description: '列出 Web 资产（含可直接访问的 URL 与页面标题）。做 Web 渗透前先看这里，优先从接口入手。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listWeb(id, { cidr: args.cidr, limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total,
        items: result.items.map((w) => ({
          url: w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port)),
          title: w.title, ip: w.ip, segment: w.segment_cidr, port: w.port,
          service: [w.service, w.product, w.version].filter(Boolean).join(' '),
          provenance: w.provenance, asset_id: w.asset_id,
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_domain_index',
    description: '按域名维度聚合资产：每个域名关联了哪些 IP/资产。用于梳理主域名、子域与 C 段的关系。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.domainIndex(id) }, null, 2)
    },
  })))

  /* ================================================================== 得分目标 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_list',
    description: '查看得分目标面板：所有得分点（名称/分类/分值/是否已拿下/命中证据）与总分进度。**每次规划下一步之前先看这里**，按分值高低决定先打什么。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listScorePoints(id, {})
      /* 按合并版的 8 个类别分组返回：智能体一眼看到"哪些类别还没打、每项上限用了多少" */
      const groups = (result.ruleGroups || []).map((g) => ({
        category: g.name,
        items: g.tiers.length,
        points: g.points,
        cap_sum: g.capSum,
      }))
      return JSON.stringify({
        ok: true, engagement: id, summary: result.summary,
        groups,
        items: result.items.map((p) => ({
          id: p.id, code: p.code, name: p.name, category: p.category, points: p.points,
          /* 合并版的档位说明（一条含多档时，记分要用 points 参数指定本档分值） */
          tier: p.tier, cap: p.cap, cap_used: p.cap_used, dedup_scope: p.dedup_scope,
          scope_label: p.scope_label,
          enabled: p.enabled, achieved: p.hits.length > 0, hits: p.hits.length,
          counted: p.counted, earned: p.earned,
          /* 该条因计分口径 / 已达上限而不计分的条数（把它当停止信号，别在同一条上刷） */
          capped: p.capped,
          /* 两个字段各司其职：service_summary 是"这条为什么有命中不计分"的整段说明；
             capped_reason 留给**逐条命中**的具体原因（在 hits[] 里），不要拿摘要冒充它。 */
          capped_summary: p.service_summary,
          evidence: p.hits.map((h) => (h.target ? h.target + '：' : '') + h.evidence).slice(0, 3),
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_hit',
    description: '记录一次得分。得分规则已按《突破入侵类得分规则（合并版）》重构为 **25 项**（一、获取权限 21 项 + 二、突破网络边界 4 项，共 8 个类别），'
      + '另有 8 条通用规则 G1–G8 横切全部条目。**记分前先用 `redteam_score_list` 读实际 code 与该条的上限/口径**，不要凭记忆写。\n\n'
      + '**证据只写结果**：目标资产 + 拿到了什么（账号/密码/权限/数据量），不要写取得过程与路径——过程由攻击得分链路的步骤负责。'
      + '能指向"用哪个漏洞拿到的"时带上 vuln_id，报告会自动附上该漏洞的原始请求。\n\n'
      + '**多档条目用 `points` 指定本档分值**：《合并版》把同一项的多个档位并成一条（如「服务器主机权限」普通 10 / 管理员 50、'
      + '「域名控制权限」一级 50 / 二级 20、「网络设备权限」普通 100 / 管理员 200）。记分时把 `points` 填成本次实际档位的分值；'
      + '不填就用该条的主档默认值。**同一系统只按最高权限计一次**（G1）——先记了普通档、后来提权到管理员档，'
      + '再记一条管理员档（points 填高档值），系统会自动顶掉普通档那条。\n\n'
      + '**红线一：账号类得分必须先实测能登录。** 拿到账号/口令后要用浏览器（browser-automation / kimi-webbridge）或等价会话'
      + '实测登录成功、能交互访问页面，才记账号权限分——**只有凭据不算拿到账号**；登不进去的写进 redteam_asset_test 的 `test` 参数。\n\n'
      + '**红线二：自己注册的账号不算得分权限。** 自助注册、自己新建的用户/角色/后台账号、自己给自己开的权限都不算——'
      + '演练得分针对**拿到别人已有的**账号与权限。这类用 self_created=true 记录（留过程），不计分、不计数、不进报告。\n\n'
      + '**红线三：注意该条的计分口径（G1/G3）。** 每条得分点自带口径：'
      + '`同一系统只算最高权限一次`／`同一服务只算最高一条`／`整个目标只算一次`（突破网络边界）／`按台·卡·个累加`（终端、云节点、算力卡）。'
      + '且每条有自己的**上限**（如服务器主机 600 分、Web 应用 2000 分、集权系统 4000 分），到上限后同条不再累计（G3）——'
      + '返回里会用 warning 告诉你"已达上限/已被顶掉"，把它当**停止信号**，换别的条目或别的资产推进，不要在同一条上刷。\n\n'
      + '**数据成果单独计分（G2）**：邮件数据、业务数据、数据资产等按重要程度另行记录，不与权限分混算；'
      + 'evidence 必须写出**实际数据量**（如「导出 1,320,000 条用户数据」）。',
    parameters: {
      engagement: { type: 'string' },
      code: { type: 'string', description: '得分点 code（或 point_id / point_name 任选其一）；先用 redteam_score_list 核对实际 code' },
      point_id: { type: 'number' },
      point_name: { type: 'string' },
      points: { type: 'number', description: '【多档条目必填】本次命中按哪一档计分（如服务器主机权限：普通权限填 10、管理员填 50；域名控制：一级 50、二级 20）。不填则用该条主档默认值。' },
      target: { type: 'string', description: '目标资产：URL / ip:port / 主机名（**带上端口**，服务/系统口径按它判定）' },
      asset_id: { type: 'number', description: '目标资产在库里的 id' },
      port: { type: 'number', description: '【建议填】这条得分落在哪个端口（口径判定按「资产 + 端口」；target 里已带端口时可不填）' },
      vuln_id: { type: 'number', description: '【建议填】用哪个漏洞拿到的分（报告据此附原始请求）' },
      step_id: { type: 'number', description: '对应的攻击链步骤 id（可选）' },
      evidence: { type: 'string', required: true, description: '【必填】结果：拿到的东西，例如「后台管理员 tomcat/Tomcat@2024（已实测浏览器可登录）」「数据库账号 root/xxx」「导出 132 万条用户数据」。多档条目请写明档位（如"管理员权限"）。' },
      self_created: { type: 'boolean', description: '【重要】这个账号/权限是不是**自己注册、自己创建**的？是则填 true —— 只作过程记录，不计分、不进报告。拿到别人已有的账号/权限不要填（默认 false）。' },
      note: { type: 'string' },
      recorded_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addScoreHit(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_point_save',
    description: '新增或修改得分点（分值/名称/分类/说明/启用）。用户也会在界面上编辑；智能体只在必要时用（例如发现规则里还有未被记录的得分项）。带 id 为修改，不带 id 为新增。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', description: '已有得分点 id（修改时传）' },
      name: { type: 'string', required: true },
      code: { type: 'string', description: '短代码（新增时建议给，便于记录得分）' },
      category: { type: 'string', description: '分类，如 账号权限 / 服务器权限 / 数据库 / 网络突破 / 数据 / 核心目标' },
      points: { type: 'number', description: '分值' },
      description: { type: 'string', description: '得分条件说明' },
      enabled: { type: 'boolean' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.saveScorePoint(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_assess',
    description: '给资产做「易打性评估」：预期能拿下哪些成果（账号权限/RCE/服务器权限/数据库权限/敏感数据/边界突破）、优先级多高、判断理由。信息收集收口时对每个资产调用一次，供指挥者按性价比排序。',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number' },
      ip: { type: 'string' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high 容易出成果 / medium 一般 / low 难打或价值低' },
      potential: { type: 'string', description: '预期成果，如「账号权限+RCE」「数据库权限」「大量敏感信息」' },
      reason: { type: 'string', description: '判断理由：指纹版本命中 Nday、接口未鉴权、口令弱、暴露数据库、WAF 强弱等' },
      assessed_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.assessAsset(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ================================================================== 证据 / 攻击链 / 报告 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_http_evidence_add',
    description: '保存一条 HTTP 证据：原始请求与响应。报告会把它渲染成可粘贴进 Burp Suite / Yakit 的原始报文，因此 request 必须是完整可重放的原始请求（含请求行、Host 等头部、必要时 body）。',
    parameters: {
      engagement: { type: 'string' },
      vuln_id: { type: 'number', description: '关联的漏洞 id（建议填）' },
      asset_id: { type: 'number' },
      label: { type: 'string', description: '这条证据的用途，例如「越权读取用户列表」' },
      method: { type: 'string', description: 'GET/POST/…' },
      url: { type: 'string' },
      status: { type: 'number', description: '响应状态码' },
      request: { type: 'string', required: true, description: '原始请求全文（Burp 可直接粘贴）' },
      response: { type: 'string', description: '响应全文或关键片段' },
      note: { type: 'string' },
      captured_by: { type: 'string', description: '采集角色' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addHttpEvidence(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_chain_add',
    description: '记录一个攻击链步骤。**报告里「这一步怎么来的」完全靠这条记录**：账号密码怎么来的、冰蝎马怎么上的、隧道怎么搭的，都要在这里用 `tool`（实际命令原文）+ `detail`（为什么这么做、线索从哪来）+ `result`（实际回显/结果）写清楚。攻击链页面与报告按 seq 排序展示。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      stage: { type: 'string', required: true, enum: ['recon', 'vuln', 'exploit', 'access', 'pivot', 'data', 'other'], description: '动作类型（兼容字段）：recon 信息收集 | vuln 漏洞发现 | exploit 利用 | access 获得权限 | pivot 内网突破 | data 敏感数据 | other。**阶段归属用 stage_code**，这个字段只用于老数据兜底。' },
      title: { type: 'string', required: true, description: '一句话描述这一步做了什么，例如「通过后台模板上传点上传冰蝎马」「用 suo5 建 socks5 隧道」' },
      detail: { type: 'string', description: '为什么这么做、线索从哪来，例如「登录页泄露版本 Coremail XT 5.0 → 匹配 CVE-2023-xxxx → 后台模板管理可上传」' },
      tool: { type: 'string', description: '【报告复现的关键】**实际执行的命令原文**，例如 `nuclei -t CVE-2021-xxxx.yaml -u http://x`、`suo5-linux-amd64 -t http://x/shell.jsp -l 1080`、`sqlmap -u "http://x?id=1" --dump`。不写这条，报告里这一步就没法复现。' },
      result: { type: 'string', description: '【报告复现的关键】实际结果/回显摘要，例如 `uid=0(root) gid=0(root)`、「返回 200，含 1.2 万条用户数据」、「后台管理员 tomcat 登录成功」' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      access_id: { type: 'number' },
      evidence_ref: { type: 'string', description: '证据文件/会话引用，例如 runs/session-vnc.md' },
      recorded_by: { type: 'string' },
      point_code: { type: 'string', description: '【这一步拿了分就填】得分点 code（如 rce / webshell / boundary），服务端会自动记一次分并把步骤与得分互相挂上。**必须同时给 evidence，否则不会记分**（步骤照常入库）。' },
      stage_code: { type: 'string', enum: ['recon', 'internet', 'boundary', 'internal', 'target'], description: '所属作战阶段（只有这 5 个合法值）：recon(信息收集) | internet(互联网资产权限) | boundary(边界突破·搭隧道) | internal(内网资产权限) | target(靶标系统权限)。写别的值（如外部工具常见的 external/foothold/tunnel/privilege）会被忽略并退回按 stage 兜底，步骤就不落在任何阶段。' },
      evidence: { type: 'string', description: '配合 point_code 使用：这一分拿到了什么（目标资产 + 账号/权限/数据量）——**不填就不记分**。' },
      self_created: { type: 'boolean', description: '配合 point_code 使用：这一步拿到的账号/权限是**自己注册/自建**的吗？是则 true（只留过程，不计分）' },
      target: { type: 'string', description: '配合 point_code 使用：目标资产' },
      seq: { type: 'number', description: '不填则自动追加到链尾' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addChainStep(id, { ...args, engagement: undefined, agent: agentOf(args), recorded_by: args.recorded_by || args.agent })
      /* 步骤落库后提醒两件事：报告要用的 tool/result 有没有写、这一步的得分有没有记 */
      const hints = []
      if (!args.tool) hints.push('这一步没写 `tool`（实际命令）：报告里"怎么做的"会变成空白，建议补一条步骤把命令写上。')
      if (!args.result) hints.push('这一步没写 `result`（实际回显/结果）：报告复现时会缺"打没打通"的证据。')
      if (result && result.score_hint) hints.push(result.score_hint)
      return JSON.stringify({ ok: true, engagement: id, ...result, hints: hints.length > 0 ? hints : undefined }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_chain',
    description: '读取完整攻击链（按步骤顺序），用于汇报与检查链路是否闭合（入口 → 权限 → 内网突破）。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listChain(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_add',
    description: '保存一个**实际生效**的攻击文件（脚本/POC/EXP/字典）到目标文件夹，供复用与交付。目录结构：attack-files/<IP|URL主机|C段>/<文件名>。evidence 必填且必须写清验证效果（例如"回显 uid=0"、"未授权返回 200 并含数据"）——**没打通的、只是尝试过的脚本不要放进来**。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', required: true, description: '目标：IP、URL 或 C 段（同一 IP 的多个端口会归到该 IP 文件夹）' },
      name: { type: 'string', required: true, description: '文件名，例如 cve-2021-22893.sh / vnc_brute.py' },
      kind: { type: 'string', enum: ['poc', 'exp', 'script', 'wordlist', 'other'], description: '类型：poc 验证 / exp 利用 / script 脚本 / wordlist 字典' },
      description: { type: 'string', description: '这个文件做什么（一句话）' },
      evidence: { type: 'string', required: true, description: '有效性证据：实际打通的输出/回显/影响，或对应漏洞/证据 id' },
      content: { type: 'string', description: '文件内容（与 path 二选一）' },
      path: { type: 'string', description: '已存在的文件路径（相对靶标目录或绝对路径），会复制进目标文件夹（与 content 二选一）' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      created_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAttackFile(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_list',
    description: '列出已保存的攻击文件（按目标文件夹分组）。开始打某个目标前先看这里，避免重复造轮子。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: '只看某个目标' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.target) return JSON.stringify({ ok: true, engagement: id, items: store.listAttackFiles(id, { target: args.target }) }, null, 2)
      return JSON.stringify({ ok: true, engagement: id, folders: store.attackFileTree(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_report_targets',
    description: '【已弃用，改用 redteam_score_report】按目标查看成果报告（每个 IP / URL / C 段一份）：成果漏洞（含可粘贴进 Burp/Yakit 的原始请求）、已获权限、凭据、攻击文件、攻击链。用于按目标汇报或检查某个目标还缺什么。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: '只看某个目标的报告' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.reportTargets(id, {})
      const picked = args.target ? result.targets.filter((t) => t.key === args.target || t.label === args.target) : result.targets
      return JSON.stringify({
        ok: true, engagement: id, generated_at: result.generated_at, totals: result.totals,
        targets: picked.map((t) => ({ key: t.key, label: t.label, segment: t.segment, stats: t.stats })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_chain',
    description: '攻击链：按攻击面位置串起来的五个阶段 —— ① 信息收集（互联网侧）→ ② 互联网资产权限 → ③ 边界突破（搭隧道）→ ④ 内网资产权限 → ⑤ 靶标权限。返回每阶段的阶段目标、**实际拿到多少分与累计分**、涉及资产、以及边界突破阶段的真实隧道。开工时看它明确"现在在第几阶段、下一步该打哪一阶段"，汇报时按阶段给结论。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const chain = store.scoreChain(id)
      return JSON.stringify({
        ok: true, engagement: id,
        totals: { points: chain.summary.points, totalPoints: chain.summary.totalPoints, hits: chain.summary.hits,
          /* 按服务封顶（同资产同端口只算一次）而没计分的条数：账号类/数据库权限 */
          serviceCappedHits: chain.summary.serviceCappedHits || 0 },
        stages: (chain.stages || []).map((st) => ({
          code: st.code, name: st.name, goal: st.goal,
          points: st.points, cumulative: st.cumulative, counted: st.counted, hits: st.hits,
          steps: st.steps, tools: st.tools,
          methods: (st.sections || []).map((x) => x.label + '：' + (x.items || []).join('、')),
          scored: st.items.map((x) => ({ point: x.point_name, points: x.points, counted: x.counted, target: x.target,
            service: x.service || null, capped: x.capped === true, capped_reason: x.capped_reason || null })),
          assets: (st.assets || []).map((a) => a.ip + (a.scope === 'internal' ? '(内网)' : '(外网)') + ' 贡献' + a.points + '分'),
          tunnels: (st.tunnels || []).map((t) => t.kind + ' ' + t.listen + ' [' + t.status + '] 可达 ' + (t.reach || '—')),
        })),
        hint: '得分阶段是自动推导的（core-system→靶标、boundary→边界突破，其余按资产内外网归属）；写攻击链步骤时带 stage_code（只接受 recon/internet/boundary/internal/target）步骤计数才会落到正确阶段，写别的值会被忽略。账号权限与数据库权限按「同资产同端口」封顶：一个服务拿到最高权限即拿满，同服务重复命中标 capped=true 且不计分。',
      }, null, 2)
    },
  })))


  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_report',
    description: '攻击得分链路复现报告：只收录"拿到了分"的成果（没得分的漏洞不进报告），每一项都尽量附上可直接粘贴进 Yakit Repeater 复现的原始请求。需要交付报告时用这个，而不是 redteam_report。',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: '最多多少项，默认 500' },
      markdown: { type: 'boolean', description: 'true=返回 markdown 全文（默认 true）；false=只返回条目摘要' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const r = store.scoreReport(id, { limit: args.limit })
      if (args.markdown === false) {
        return JSON.stringify({ ok: true, engagement: id, summary: r.summary,
          items: r.items.map((x) => ({ seq: x.seq, point: x.point_name, points: x.points, counted: x.counted,
            target: x.target, gained: x.gained, requests: x.requests.length, missing_evidence: x.missing_evidence })) }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, summary: r.summary, markdown: r.markdown }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_report',
    description: '【已弃用，改用 redteam_score_report】生成成果报告（Markdown）：只收录**已验证/已利用且中危以上**的成果漏洞（每条附可粘贴进 Burp/Yakit 的原始请求）、攻击链、已获权限与凭据、修复建议。信息收集的资产清单、待验证/误报、低危与信息级水洞都不会出现在报告里。想让发现进报告：先 redteam_vuln_update 置为 confirmed（验证通过）或 exploited（利用成功），再 redteam_http_evidence_add 补原始请求。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.report(id)
      return JSON.stringify({ ok: true, engagement: id, generated_at: result.generated_at, stats: result.stats, markdown: result.markdown }, null, 2)
    },
  })))
}
