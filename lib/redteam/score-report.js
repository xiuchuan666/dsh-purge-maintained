/**
 * 计分报告与得分链路（从 store-core.js 抽出的计分块）。
 *
 * 为什么单独一个文件：这三块加起来 1200 多行，是 store-core.js 里最大的一坨，
 * 而它读的是"已经落库的事实"、不写库 —— 与 schema/迁移/写入原语是两类东西。
 * 抽出来之后改计分口径不必翻过 4000 行 DDL 与 CRUD。
 *
 * 形式是**普通函数，第一个参数是 store 实例**，不是 class 方法：
 * 块里所有 `this.` 都是对 RedteamStore 公开方法的调用，`this.#hitTrace` 与
 * `this.#representativeShots` 是私有方法 —— 搬到类外后 `#` 语法不可用，
 * 所以那两个私有方法也一并搬成这里的具名函数，类里留私有转发保持调用点不变。
 *
 * 三处总分必须一致（面板 / 报告 / 攻击链）：本文件**不自己算分**，
 * 一律走 score-rules.js 的 applyScoreCaps / evaluateScoreBoard。
 */
import { join } from 'node:path'
import {
  buildHttpRequest, buildCurlCommand, parseCurl, commandKind, parseTarget, fillTemplate,
} from './report-replay.js'
import {
  TUNNEL_ENTRY_KINDS, parseTargetPort, serviceLabel, applyScoreCaps, scoreCapReasonText,
  evaluateScoreBoard, loadScoreMeta, loadAssetNames, hitPointsOf, scoreConfirmOf, SCORE_CONFIRM,
  normalizePort,
} from './score-rules.js'
import {
  SCOPE_SQL, readMeta, ROLE_TITLES, POINT_SHORT_NAME, scoreStageOf, LEGACY_STAGE_MAP,
} from './engagement-meta.js'


  /**
   * 一条得分的"怎么来的"：把动作步骤 + 利用的漏洞 + 拿到手的凭据/入口串成可复现的链路。
   *
   * 报告里"账号密码怎么来的、隧道怎么搭的"就靠这里 —— 缺步骤、缺命令、缺证据都要显式标出来，
   * 让用户一眼看出哪条成果复现不了，而不是给一份看着漂亮、实则没法交的报告。
   * @param db - 靶标库句柄。
   * @param hit - score_hit 行（含 asset_id / vuln_id / step_id / target / recorded_at / point_code）。
   * @returns `{ steps, vuln, credentials, accesses, webshells, tunnels, how, complete, gaps }`
   */
export function hitTrace(store, db, hit, engagementId) {
  const evidenceDir = engagementId ? store.dirOf(engagementId) : null
  const steps = []
  const stepById = new Map()
  const pushStep = (row) => {
    if (row === undefined || row === null) return
    if (stepById.has(row.id)) {
      const existing = stepById.get(row.id)
      if (existing.inferred === true && row.inferred !== true) existing.inferred = false
      return
    }
    const step = {
      id: row.id, seq: row.seq, stage_code: row.stage_code, title: row.title || '',
      detail: row.detail || '', tool: row.tool || '', result: row.result || '',
      agent: row.agent || row.recorded_by || '', recorded_at: row.recorded_at || null,
      vuln_id: row.vuln_id ?? null, asset_id: row.asset_id ?? null, point_id: row.point_id ?? null,
      evidence_ref: row.evidence_ref || '', inferred: row.inferred === true,
    }
    stepById.set(step.id, step)
    steps.push(step)
  }
  const cols = 'id, seq, stage_code, title, detail, tool, agent, result, asset_id, vuln_id, access_id, point_id, evidence_ref, recorded_at'
  /* 归因规则（先准后宽）：
       ① 显式关联的步骤（score_hit.step_id）
       ② 这个漏洞的步骤（vuln_id）——"靠这个洞拿到的分"就该看到打这个洞的动作
       ③ 同资产 + 同得分点的步骤（推断）
     只有上面都没有时，才退到"同资产的全部步骤"（为了让报告不至于空白），并标成推断。
     step_source 会如实告诉调用方这次用的是哪一档，界面/报告据此提示"仅供参考"。 */
  let stepSource = null
  try {
    if (hit.step_id !== null && hit.step_id !== undefined) {
      pushStep(db.prepare(`SELECT ${cols} FROM attack_step WHERE id = ?`).get(hit.step_id))
      if (steps.length > 0) stepSource = 'linked'
    }
    if (hit.vuln_id !== null && hit.vuln_id !== undefined) {
      for (const row of db.prepare(`SELECT ${cols} FROM attack_step WHERE vuln_id = ? ORDER BY seq, id`).all(hit.vuln_id)) pushStep(row)
      if (stepSource === null && steps.length > 0) stepSource = 'vuln'
    }
    if (hit.asset_id !== null && hit.asset_id !== undefined && hit.point_id !== null && hit.point_id !== undefined) {
      for (const row of db.prepare(`SELECT ${cols} FROM attack_step WHERE asset_id = ? AND point_id = ? ORDER BY seq, id`).all(hit.asset_id, hit.point_id)) {
        pushStep(Object.assign({}, row, { inferred: true }))
        if (stepSource === null) stepSource = 'point'
      }
    }
    if (steps.length === 0 && hit.asset_id !== null && hit.asset_id !== undefined) {
      for (const row of db.prepare(`SELECT ${cols} FROM attack_step WHERE asset_id = ? ORDER BY seq, id LIMIT 40`).all(hit.asset_id)) {
        pushStep(Object.assign({}, row, { inferred: true }))
      }
      if (steps.length > 0) stepSource = 'asset'
    }
  } catch { /* 老库缺列时降级为"无步骤"，报告会标成无法复现 */ }
  steps.sort((a, b) => (a.seq === b.seq ? a.id - b.id : (a.seq ?? 0) - (b.seq ?? 0)))

  /* 这条得分用到的漏洞 */
  let vuln = null
  if (hit.vuln_id !== null && hit.vuln_id !== undefined) {
    try {
      const v = db.prepare('SELECT id, cve, title, severity, status, target, evidence, gained, source, found_by_agent, found_at FROM vuln WHERE id = ?').get(hit.vuln_id)
      if (v !== undefined) vuln = v
    } catch { vuln = null }
  }
  /* ── 凭据 / 会话 / 马 / 隧道：必须与"本条得分"是同一件事才挂 ──────────────
     原实现只按 asset_id 取，于是同一台资产上登记的**全部**凭据与会话被挂到该资产的
     每一条得分上。实测后果：一条「终端权限 pc-001」下面挂着「MySQL root（配置文件泄露）」——
     与终端毫无关系；一条资产 4 条得分各自重复列出同一批凭据，报告因此又长又假。
     判定：**本条写了 target 时**要求 target 主机与该资产（IP / 首选名）对得上；
     没写 target（纯资产级成果，如"控下 1 台终端"）时按资产挂载是合理的。 */
  const targetHost = (() => {
    const t = String(hit.target || '').trim()
    if (t === '') return null
    const url = /^([a-z][a-z0-9+.-]*):\/\/(\[[^\]]+\]|[^/?#\s]+)/i.exec(t)
    let authority = url !== null ? url[2] : (/^([^\s/?#]+)/.exec(t) || [])[1]
    if (!authority) return null
    authority = authority.replace(/^\[|\]$/g, '').replace(/:\d{1,5}$/, '').toLowerCase()
    return authority === '' ? null : authority
  })()
  const asset = (hit.asset_id === null || hit.asset_id === undefined)
    ? undefined
    : (() => { try { return db.prepare('SELECT ip, primary_name, segment_cidr FROM asset WHERE id = ?').get(Number(hit.asset_id)) } catch { return undefined } })()
  const targetMatchesAsset = () => {
    if (targetHost === null) return true                 /* 没写 target：按资产挂载 */
    if (asset === undefined) return false                /* 写了 target 又查不到资产：不挂 */
    const ip = String(asset.ip || '').toLowerCase()
    const name = String(asset.primary_name || '').toLowerCase()
    const cidr = String(asset.segment_cidr || '').toLowerCase()
    /* ① 目标就是这台资产（IP 或首选域名） */
    if (targetHost === ip || targetHost === name) return true
    /* ② 目标"看着不像单台主机"：边界突破常把 target 写成可达网段（10.20.30.0/24）、
       终端类会写成设备名（pc-001）。这类条目本质是"资产级成果"，
       它用到的隧道/马/凭据就挂在这台入口资产上 —— 不挂会丢掉"通道怎么搭的"。
       判据：target 里有 '/'（网段）或解析出的主机不是 IP/域名形态。 */
    const raw = String(hit.target || '').trim()
    if (raw.includes('/')) return true
    if (cidr !== '' && (targetHost === cidr || cidr.startsWith(targetHost + '/'))) return true
    const looksLikeHost = /^[0-9a-f.:\[\]]+$/i.test(targetHost) || targetHost.includes('.')
    return !looksLikeHost
  }
  const sameAsset = targetMatchesAsset()

  const credentials = []
  const accesses = []
  const webshells = []
  const tunnels = []
  if (sameAsset) {
    try {
      if (hit.asset_id !== null && hit.asset_id !== undefined) {
        credentials.push(...db.prepare(`SELECT id, host, username, secret_value, secret_type, privilege, source, tool, agent, found_at
          FROM credential WHERE asset_id = ? ORDER BY id LIMIT 20`).all(hit.asset_id))
      } else if (targetHost !== null) {
        credentials.push(...db.prepare(`SELECT id, host, username, secret_value, secret_type, privilege, source, tool, agent, found_at
          FROM credential WHERE host LIKE ? ORDER BY id LIMIT 20`).all('%' + targetHost + '%'))
      }
    } catch { /* 忽略 */ }
    if (hit.asset_id !== null && hit.asset_id !== undefined) {
      try { accesses.push(...db.prepare('SELECT id, host, username, method, privilege, session_ref, obtained_at FROM access_session WHERE asset_id = ? ORDER BY id LIMIT 20').all(hit.asset_id)) } catch { /* 忽略 */ }
      try { webshells.push(...db.prepare('SELECT id, url, shell_type, pass_key, privilege, status, agent FROM webshell WHERE asset_id = ? ORDER BY id LIMIT 20').all(hit.asset_id)) } catch { /* 忽略 */ }
      try {
        tunnels.push(...db.prepare('SELECT id, kind, listen, entry, reach, entry_kind, status, command, agent FROM tunnel WHERE asset_id = ? ORDER BY id LIMIT 20').all(hit.asset_id)
          .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind) })))
      } catch { /* 忽略 */ }
    }
  }

  /* 复现完整性判定：一条得分至少要"有步骤 + （有命令 或 有漏洞 或 有原始请求）" */
  const hasCommand = steps.some((s) => String(s.tool || '').trim() !== '')
  const gaps = []
  if (steps.length === 0) gaps.push("没有攻击步骤记录（`redteam_chain_add`）：说不清这条是怎么做到的")
  else if (!hasCommand) gaps.push("攻击步骤没写 `tool`（实际执行的命令）：回放时不知道当时跑了什么")
  if (hit.vuln_id === null || hit.vuln_id === undefined) gaps.push("没有关联 `vuln_id`：报告挂不上对应的原始请求")
  if (credentials.length === 0 && ['web-account-user', 'web-account-admin', 'db-access'].includes(hit.code)) {
    gaps.push("账号类得分没有登记凭据（`redteam_credential_add`）：说不清账号/口令从哪来")
  }
  if (['boundary', 'internal-pivot'].includes(hit.code) && tunnels.length === 0) {
    gaps.push("突破类得分没有登记隧道（`redteam_tunnel_add`）：说不清通道怎么建的")
  }

  /* how：一句话交代"靠什么拿到的"，优先用最有信息量的那条 */
  const primary = steps.find((s) => String(s.title || '').trim() !== '') || steps[0]
  let how = ''
  if (hit.vuln_id !== null && hit.vuln_id !== undefined && vuln !== null) {
    how = "Exploited " + (vuln.cve ? vuln.cve + ' ' : '') + (vuln.title || '') + ' (' + (vuln.severity || 'unknown') + ')'
  } else if (primary !== undefined) {
    how = primary.title || ''
  }
  if (primary !== undefined && String(primary.tool || '').trim() !== '') {
    how = (how === '' ? '' : how + '; ') + "command: " + String(primary.tool).trim()
  }
  return {
    engagement_dir: evidenceDir,
    steps, vuln, credentials, accesses, webshells, tunnels,
    how,
    /* 步骤是怎么归因到这条得分的：linked（显式）> vuln（同漏洞）> point（同资产同得分点）> asset（同资产兜底） */
    step_source: stepSource,
    evidence_refs: steps.map((s) => s.evidence_ref).filter(Boolean),
    complete: gaps.length === 0,
    gaps,
  }
}

  /**
   * 攻击得分链路复现报告：只收录"拿到了分"的成果，平铺成列表。
   * 每条都尽量带上能直接粘进 Yakit Repeater 的原始请求：
   *   ① 显式关联的漏洞（score_hit.vuln_id）→ 该漏洞的 http_evidence（最准）
   *   ② 兜底：同资产 + 按目标 URL 路径匹配（标注为自动匹配）
   *   ③ 都没有 → 只给证据文本，并标 missing_evidence
   *
   * 每条另附 **「怎么拿到的」**（#hitTrace）：动作步骤（含实际命令与回显）+ 利用的漏洞 +
   * 拿到的凭据 / WebShell / 隧道 —— 回答"账号密码怎么来的、隧道怎么搭建的"。
   * 缺少步骤或命令的条目会被标 incomplete，并在报告里列出 gaps。
   */
export function scoreReport(store, id, options = {}) {
  const db = store.db(id)
  const meta = readMeta(store.metaPathOf(id)) || {}
  const limit = Math.min(Number(options.limit) || 500, 2000)
  const rows = db.prepare(`SELECT h.*, p.code, p.name AS point_name, p.points AS point_default, p.category,
        p.enabled AS point_enabled, p.rule AS point_rule, p.tier AS point_tier, p.cap AS point_cap,
        p.dedup_scope AS point_dedup, p.src AS point_src, p.description AS point_desc,
        a.ip AS asset_ip, v.title AS vuln_title, v.cve AS vuln_cve, v.gained AS vuln_gained, v.severity AS vuln_severity
      FROM score_hit h
      LEFT JOIN score_point p ON p.id = h.point_id
      LEFT JOIN asset a ON a.id = h.asset_id
      LEFT JOIN vuln v ON v.id = h.vuln_id
    ORDER BY h.recorded_at, h.id LIMIT ?`).all(limit)

  /* 计分口径：同类得分不设上限，命中即累加（自建账号已在上面整条剔除） */
  const perPoint = new Map()
  const eviByVuln = db.prepare(`SELECT id, label, method, url, status, request, response, note, captured_at
    FROM http_evidence WHERE vuln_id = ? ORDER BY id`)

  const clip = (t, n) => {
    const s = t === null || t === undefined ? '' : String(t)
    return s.length > n ? s.slice(0, n) + "\n… (truncated; see the evidence file for the full content)" : s
  }

  /* 每条命中落在攻击链的哪个阶段（与攻击链页同一套推导规则） */
  const scopeOf = new Map()
  if (rows.length > 0) {
    const ids = Array.from(new Set(rows.map((r) => r.asset_id).filter((v) => v !== null && v !== undefined)))
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',')
      for (const a of db.prepare(`SELECT id, COALESCE(scope, (${SCOPE_SQL})) AS scope FROM asset WHERE id IN (${ph})`).all(...ids)) {
        scopeOf.set(a.id, a.scope)
      }
    }
  }
  /* 自己注册/自建的账号不算成果：从报告主体剔除，只在页脚给一个数字 */
  const selfCreatedRows = rows.filter((h) => Number(h.self_created) === 1)
  /* 「停用」的得分点：面板只累加 enabled 的点（listScorePoints 的口径），报告必须一致，
     否则同一个交付物里会出现两个总分（例如停用 web-app 后面板 50 分、报告 150 分）。
     这些命中不进正文、不进总分，但同样只报个数（用户是自己关的，不是被规则顶掉的）。
     判定函数放在下面与 reportRows 一起，避免两份口径漂移。 */
  /* 计分口径与规则上限：**必须与 listScorePoints 用同一套**（applyScoreCaps + 得分点元数据），
     否则面板显示 6340 分、报告写 7930 分，两边对不上 —— 交付物自相矛盾比数字高低更糟。
     被顶掉/超上限的命中不进正文（它们不是新的成果），只在页脚报个数。 */
  /* 计分评估走共享实现，且**带上 enabledOnly**：面板只累加启用的得分点，
     报告如果不看 enabled 就会出现"面板 50 分、报告 150 分"这种自相矛盾的交付物。 */
  const reportMeta = loadScoreMeta(db)
  const reportNames = loadAssetNames(db)
  /* 命中自带 points 时以命中为准（合并版一条含多档）。
     倍率（G5/G6）乘在档位分值上 —— 调共享的 hitPointsOf，保证面板/报告/攻击链三处口径一致。 */
  const effPoints = (h) => hitPointsOf(
    { points: h.points, multiplier: h.multiplier, code: h.code },
    new Map([[String(h.code), {
      points: (h.point_default !== undefined && h.point_default !== null
        ? Number(h.point_default) || 0
        : (reportMeta.get(h.code) || {}).points || 0),
    }]]),
  )
  const reportEval = evaluateScoreBoard(db, rows.map((h) => Object.assign({}, h, { points: effPoints(h) })),
    { meta: reportMeta, names: reportNames, enabledOnly: true })
  const capFlagById = reportEval.byId
  const isCappedRow = (h) => {
    const flag = capFlagById.get(h.id)
    return flag !== undefined && flag.capped === true
  }
  const isDisabledRow = (h) => h.point_enabled !== null && h.point_enabled !== undefined
    && Number(h.point_enabled) !== 1
  const reportRows = rows.filter((h) => Number(h.self_created) !== 1 && !isCappedRow(h) && !isDisabledRow(h))
  const serviceCappedRows = rows.filter((h) => Number(h.self_created) !== 1 && isCappedRow(h))

  const items = reportRows.map((h, i) => {
    const seen = perPoint.get(h.point_id) || 0
    perPoint.set(h.point_id, seen + 1)
    const counted = true
    /* 该条命中的实际分值：命中自带优先（合并版一条含多档），否则用得分点默认值 */
    const hitPoints = effPoints(h)

    /* "怎么拿到的"：动作步骤 + 漏洞 + 凭据/入口（报告的核心，缺了就是没法交付） */
    const trace = hitTrace(store, db, { ...h, code: h.code }, id)

    /* 原始请求：先按显式关联的漏洞取 */
    let requests = h.vuln_id === null || h.vuln_id === undefined ? [] : eviByVuln.all(h.vuln_id).map((e) => ({
      label: e.label || (e.method || '') + ' ' + (e.url || ''), method: e.method, url: e.url, status: e.status,
      request: clip(e.request, 20000), response: clip(e.response, 8000), note: e.note, source: 'linked',
    }))
    /* 兜底：同资产 + 目标路径逐级降级匹配（先精确到两级路径，再退到一级、再到整个授权） */
    if (requests.length === 0 && h.target) {
      const full = String(h.target).trim()
      const um = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]+)(\/[^?#\s]*)?/i.exec(full)
      const candidates = []
      if (um !== null) {
        const authority = um[2]
        const segs = (um[3] || '').split('/').filter(Boolean)
        if (segs.length >= 2) candidates.push('%' + authority + '/' + segs.slice(0, 2).join('/') + '%')
        if (segs.length >= 1) candidates.push('%' + authority + '/' + segs[0] + '%')
        candidates.push('%' + authority + '%')
        if (segs.length >= 2) candidates.push('%/' + segs.slice(0, 2).join('/') + '%')
      } else {
        const auth = full.split('/')[0].split('?')[0]
        if (auth !== '') candidates.push('%' + auth + '%')
      }
      const SQL = 'SELECT id, label, method, url, status, request, response, note FROM http_evidence WHERE url LIKE ? ORDER BY id LIMIT 3'
      const SQL_ASSET = 'SELECT id, label, method, url, status, request, response, note FROM http_evidence WHERE asset_id = ? AND url LIKE ? ORDER BY id LIMIT 3'
      let rows2 = []
      if (h.asset_id !== null && h.asset_id !== undefined) {
        for (const like of candidates) {
          rows2 = db.prepare(SQL_ASSET).all(h.asset_id, like)
          if (rows2.length > 0) break
        }
      }
      if (rows2.length === 0) {
        for (const like of candidates) {
          rows2 = db.prepare(SQL).all(like)
          if (rows2.length > 0) break
        }
      }
      requests = rows2.map((e) => ({
        label: e.label || (e.method || '') + ' ' + (e.url || ''), method: e.method, url: e.url, status: e.status,
        request: clip(e.request, 20000), response: clip(e.response, 8000), note: e.note, source: 'auto',
      }))
    }
    /* ── 复现入口：请求 / 命令 / 判定标准 ──────────────────────────────────
       用户反馈"报告里的得分点没讲明白得分过程、难以复现"。库里其实有料：
       攻击步骤的 tool 常常就是那条 curl，target 就是这个请求的地址。
       这里把它整理成三样东西：
         · replay_cmd  —— 能直接粘进终端跑的命令（真实 curl 原样保留，其余按 URL 合成）
         · replay_http —— 能粘进 Yakit Repeater 的原始报文（有真实抓包用真实的，否则合成）
         · confirm     —— 这条凭什么算拿到、要附什么材料、从哪复现
       **合成的一律标 synthesized + 说明来源**，不能让验收人把推断当实证。 */
    const firstStepTool = (trace.steps.find((x) => String(x.tool || '').trim() !== '') || {}).tool || ''
    const parsedCurl = parseCurl(firstStepTool)
    const replayUrl = (() => {
      if (requests.length > 0 && requests[0].url) return requests[0].url
      if (parsedCurl !== null) return parsedCurl.url
      return h.target || null
    })()
    /* ── 合成的边界（很重要）─────────────────────────────────────────────
       只有"这条得分确实是 HTTP 交互拿到的"才合成 HTTP 报文/curl 命令。
       不加这个判断会把服务名当成 HTTP 服务，产出这种没用的东西：
         · 目标 10.20.30.40:3306 → `curl -i -s 'http://10.20.30.40:3306/'`
         · 目标 pc-001          → `curl -i -s 'http://pc-001/'`
       宁可明确说"这条不是 HTTP 入口，请按下面的动作模板复现"。 */
    const targetParsed = parseTarget(h.target || '')
    const schemeIsHttp = targetParsed !== null
      && (targetParsed.scheme === 'http' || targetParsed.scheme === 'https')
    /* 判定"这条是 HTTP 交互"的三条依据，命中任一即可 */
    const isHttpEntry = parsedCurl !== null
      || (requests.length > 0 && String(requests[0].request || '').trim() !== '')
      || schemeIsHttp
    const confirm = scoreConfirmOf(h.code)

    /* ── 复现命令：先看"这条得分靠什么资产成立"，再挑命令 ────────────────────
         · real        —— 攻击时确实敲过、且就是这次 HTTP 交互的 curl
         · synthesized —— 由**真实抓获请求**或目标 URL 合成的 curl（命令行等价形式）
         · template    —— 该得分点自己的动作模板（资产已把它填成可跑的命令）
         · from_step   —— 取自攻击步骤的真实命令（可能不是"本步"的动作，如实标注）
       ⚠️ 顺序错误的代价（实测）：边界突破条目靠**隧道**成立，但同资产的攻击步骤里
       记着"上传冰蝎马"的 curl；若先判"步骤里有 curl 就用它"，报告就会把上传命令
       当成边界突破的复现命令 —— 张冠李戴，用户照着跑根本复现不出"跨进内网"。
       所以"资产是否指向该得分点的复现方式"必须排在"步骤里有没有命令"之前。 */
    const capturedRequest = requests.length > 0 ? String(requests[0].request || '').trim() : ''
    const capturedCurl = (() => {
      if (capturedRequest === '') return null
      const firstLine = capturedRequest.split(/\r?\n/)[0]
      const m = /^([A-Z]+)\s+(\S+)/.exec(firstLine)
      const hostLine = /^host:\s*(\S+)/im.exec(capturedRequest)
      if (m === null || hostLine === null) return null
      const scheme = /:443$/.test(hostLine[1]) ? 'https' : 'http'
      /* path 单独带出来：parseTarget 会在 '?' 处截断，只给 url 会丢掉查询串
         （实测把 `GET /_cat/indices?v` 合成成 `curl .../_cat/indices`）。
         鉴权与内容类型头同样要带（Basic 少了就是 401，POST 少了就是 415）。 */
      const keep = []
      for (const line of capturedRequest.split(/\r?\n/).slice(1)) {
        if (/^(authorization|content-type|accept|x-requested-with|referer):/i.test(line.trim())) keep.push(line.trim())
      }
      return { url: scheme + '://' + hostLine[1] + m[2], method: m[1], path: m[2], headers: keep }
    })()

    const tunnel0 = trace.tunnels[0] || null
    const listenPort = tunnel0 === null || !tunnel0.listen
      ? null
      : (/:([0-9]{1,5})$/.exec(String(tunnel0.listen)) || [])[1] || null
    const reach = tunnel0 === null ? null : String(tunnel0.reach || '').trim()
    const t0 = parseTarget(h.target || '')
    const cred0 = (trace.credentials.find((c) => c.username) || trace.credentials[0]) || {}
    const templateValues = {
      host: (reach === null || reach === '' ? null : reach.replace(/\/[0-9]{1,3}$/, '')) || (t0 === null ? null : t0.host),
      port: listenPort || (t0 === null ? null : t0.port),
      user: cred0.username,
      pass: cred0.secret_value,
      url: h.target || null,
    }

    let replayCmd = null
    let replayCmdKind = null
    let replayCmdUnfilled = []
    const curlIsThisAction = commandKind(firstStepTool) === 'curl'
    /* 本条**显式关联**的那条攻击步骤里记的命令：这才是"这次动作到底敲了什么"。
       只认显式关联（h.step_id），不认同资产推断出来的历史步骤 —— 后者会把
       "上传冰蝎马"的 curl 挂到"跨境突破"条目上，报告直接张冠李戴。 */
    const linkedStep = (trace.steps || []).find((st) => st.id === h.step_id) || null
    const linkedTool = linkedStep === null ? '' : String(linkedStep.tool || '').trim()
    const looksLikeCommand = (t) => t.length >= 8 && /^[A-Za-z0-9_./~$-]+/.test(t) && /\s/.test(t)

    if (capturedRequest !== '' && capturedCurl !== null) {
      /* ① 有真实抓获报文：命令行等价形式与报文严格对应，最不会误导。
         请求体**只从这份报文里取**，不能借用攻击步骤里那条 curl 的 data ——
         实测会把 `GET /_cat/indices?v` 合成成 `curl -d @/tmp/.b.json .../_cat/indices`。 */
      const sep = capturedRequest.search(/\r?\n\r?\n/)
      const body = sep === -1 ? '' : capturedRequest.slice(sep).replace(/^\r?\n\r?\n/, '').trim()
      replayCmd = buildCurlCommand({
        url: capturedCurl.url, path: capturedCurl.path, method: capturedCurl.method,
        headers: capturedCurl.headers,
        data: body === '' ? null : body,
        cookie: parsedCurl === null ? null : parsedCurl.cookie,
      })
      replayCmdKind = 'synthesized'
    } else if (linkedTool !== '' && looksLikeCommand(linkedTool)) {
      /* ①′ 本条动作的真实命令（含 impacket / nxc / mysql / redis-cli 这类非 curl 工具）。
          这类命令过去会被丢掉、退回通用模板（模板是"id; whoami; hostname"这种判定语），
          用户照着跑什么也复现不出来 —— 报告里最误导的一处，现在改成原样给出。 */
      replayCmd = linkedTool
      replayCmdKind = commandKind(linkedTool) === 'curl' ? 'real' : 'linked'
    } else if (curlIsThisAction && !(tunnel0 !== null && confirm !== null && confirm.script)) {
      /* ② 真实 curl，且这条得分不是"靠隧道成立"的（隧道条目见下面 ③） */
      replayCmd = firstStepTool
      replayCmdKind = 'real'
    } else if (confirm !== null && confirm.script) {
      /* ③ 得分点自己的动作模板：用本条记录的目标/隧道/凭据填成可跑的命令 */
      replayCmdKind = 'template'
      const filled = fillTemplate(confirm.script, templateValues)
      replayCmd = filled.cmd
      replayCmdUnfilled = filled.remaining
    } else if (curlIsThisAction) {
      replayCmd = firstStepTool
      replayCmdKind = 'real'
    } else if (commandKind(firstStepTool) !== null) {
      /* ④ 步骤里的其它真实命令：如实说明它不是"本步"的动作 */
      replayCmd = firstStepTool
      replayCmdKind = 'from_step'
    }

    if (replayCmd === null && confirm && confirm.script) {
      replayCmdKind = 'template'
      /* 用这条得分自己已知的信息填模板：host 来自 target，账号来自挂载的凭据。
         填不上的占位符保持原样并列出来 —— 不猜，也不假装能直接跑。 */
      const cred0 = (trace.credentials.find((c) => c.username) || trace.credentials[0]) || {}
      const t0 = parseTarget(h.target || '')
      /* 隧道条目：<端口> 指的是隧道监听端口（127.0.0.1:1080），不是 target 里的端口。
         边界突破的 target 是"可达网段"（10.20.30.0/24），拿它解析端口只会得到 null、
         留下一个填不上的占位符 —— 而这条得分真正要跑的命令就写在隧道记录里。 */
      const tunnel0 = trace.tunnels[0] || null
      const listenPort = tunnel0 === null || !tunnel0.listen
        ? null
        : (/:([0-9]{1,5})$/.exec(String(tunnel0.listen)) || [])[1] || null
      const reachHost = (() => {
        const reach = tunnel0 === null ? null : String(tunnel0.reach || '').trim()
        if (reach === null || reach === '') return null
        return reach.replace(/\/[0-9]{1,3}$/, '')     /* 10.20.30.0/24 → 10.20.30.0 */
      })()
      const filled = fillTemplate(confirm.script, {
        host: reachHost || (t0 === null ? null : t0.host),
        port: listenPort || (t0 === null ? null : t0.port),
        user: cred0.username,
        pass: cred0.secret_value,
        url: h.target || null,
      })
      replayCmd = filled.cmd
      replayCmdUnfilled = filled.remaining
    }

    /* 原始报文：优先真实抓包；其次从真实 curl 合成；否则仅当 target 写了 http(s):// 才合成 */
    let replayHttp = null
    let replayHttpSynthesized = false
    if (requests.length > 0 && String(requests[0].request || '').trim() !== '') {
      replayHttp = requests[0].request
    } else if (parsedCurl !== null) {
      replayHttp = buildHttpRequest({
        url: parsedCurl.url, method: parsedCurl.method, data: parsedCurl.data,
        headers: parsedCurl.headers, cookie: parsedCurl.cookie,
        insecure: parsedCurl.insecure, followRedirect: parsedCurl.followRedirect,
      })
      replayHttpSynthesized = replayHttp !== null
    } else if (schemeIsHttp) {
      replayHttp = buildHttpRequest({ url: h.target, method: 'GET' })
      replayHttpSynthesized = replayHttp !== null
    }
    return {
      seq: i + 1,
      id: h.id,
      point_id: h.point_id,
      /* 显式关联的动作步骤 id：报告据此把"同一次批量动作"的条目合并成一条 + 台账表。
         必须用显式关联，不能用 trace 里推断出来的步骤 —— 推断会把同资产的历史步骤
         也算进来，同一批动作的条目就合不到一起（实测：64 台终端里有一台因此掉队）。 */
      step_id: h.step_id === null || h.step_id === undefined ? null : h.step_id,
      /* 得分点规则元数据（分区表与逐条明细要写"规则几 / 档位 / 上限"） */
      point_rule: h.point_rule === null || h.point_rule === undefined ? null : h.point_rule,
      point_tier: h.point_tier || '',
      point_cap: Number(h.point_cap) || 0,
      point_dedup: h.point_dedup || '',
      /* 得分点 code：报告条目与攻击链条目**必须带上同一个 code** ——
         界面要按它把两边对起来（报告页的阶段分组兜底、工具侧按 code 核对成果），
         缺了它下游只能按 point_name 模糊匹配，改个名字就断。 */
      code: h.code || '',
      stage_code: scoreStageOf({ stage_code: h.stage_code, code: h.code, target: h.target },
        h.asset_id === null || h.asset_id === undefined ? undefined : scopeOf.get(h.asset_id)),
      point_name: h.point_name || "（已删除的得分点）",
      category: h.category || '',
      points: hitPoints,
      counted: counted,
      nth_of_point: seen + 1,
      target: h.target || '',
      asset_ip: h.asset_ip || '',
      gained: h.vuln_gained || '',
      vuln: h.vuln_id === null || h.vuln_id === undefined ? null : { id: h.vuln_id, title: h.vuln_title || '', cve: h.vuln_cve || null, severity: h.vuln_severity || null },
      evidence: h.evidence || '',
      note: h.note || '',
      recorded_by: h.recorded_by || '',
      recorded_at: h.recorded_at || '',
      requests: requests,
      missing_evidence: requests.length === 0,
      /* 复现入口（新增）：用户照着这三样就能重放/自证 */
      replay_cmd: replayCmd,
      /* real / synthesized / template —— 界面与报告据此决定措辞（模板不能叫"照抄即可"） */
      replay_cmd_kind: replayCmdKind,
      /* 模板里还没填上的占位符（空数组表示已全部填好、可直接跑） */
      replay_cmd_unfilled: replayCmdKind === 'template' && replayCmdUnfilled.length > 0 ? replayCmdUnfilled : undefined,
      /* 证据截图：本条（或本组）对应的代表图，最多 3 张 —— 见 #representativeShots */
      shots: [],
      replay_http: replayHttp,
      replay_http_synthesized: replayHttpSynthesized,
      /* 这份报文是当日真实抓包，还是按当日命令/回显重建的（证据行的 note 里写明了就按它标） */
      replay_http_rebuilt: requests.length > 0 && /重建|按当日.*(命令|回显)|未留存原始抓包/.test(String(requests[0].note || '')),
      /* 这条得分是不是"靠 HTTP 交互"拿到的。报告据此决定要不要给可粘贴的报文：
         非 HTTP 目标（SMB/数据库/隧道）硬合成出来的报文是废的，不如直接给命令行 + 说明。 */
      http_entry: isHttpEntry,
      /* 这份复现入口是怎么来的：
           linked       —— 显式关联漏洞的真实抓包
           auto         —— 按目标路径匹配到的真实抓包（需核对）
           request      —— 由真实抓包推导出的命令行等价形式
           step         —— 取自攻击步骤的真实命令（未必是本步动作）
           synthesized  —— 完全由目标 URL 合成（需核对）
           template     —— 得分点自己的动作模板（用本条记录填好） */
      replay_source: requests.length > 0
        ? (capturedRequest !== '' ? (requests[0].source === 'linked' ? 'linked' : 'auto')
          : (replayCmdKind === 'from_step' ? 'step' : 'request'))
        : (replayCmdKind === 'from_step' ? 'step'
          : (replayCmdKind === 'template' ? 'template' : (replayCmd !== null || replayHttp !== null ? 'synthesized' : null))),
      /* 判定标准 / 自证材料 / 复现入口（来自 SCORE_CONFIRM，按 code 取） */
      confirm: confirm,
      confirm_missing: confirm === null,
      /* 怎么拿到的：步骤（含命令与回显）+ 漏洞 + 凭据/入口；incomplete 表示报告没法复现这一步 */
      trace: trace,
      how: trace.how,
      steps: trace.steps,
      credentials: trace.credentials,
      accesses: trace.accesses,
      webshells: trace.webshells,
      tunnels: trace.tunnels,
      incomplete: trace.complete !== true,
      gaps: trace.gaps,
    }
  })

  const summary = {
    count: items.length,
    points: items.reduce((n, x) => n + (x.counted ? x.points : 0), 0),
    withRequests: items.filter((x) => x.requests.length > 0).length,
    autoMatched: items.filter((x) => x.requests.some((r) => r.source === 'auto')).length,
    missingRequests: items.filter((x) => x.missing_evidence).length,
    /* 复现完整性：有步骤且有命令的条目数 / 缺步骤或命令的条目数 */
    withSteps: items.filter((x) => x.steps.length > 0).length,
    withCommands: items.filter((x) => x.steps.some((s) => String(s.tool || '').trim() !== '')).length,
    incomplete: items.filter((x) => x.incomplete).length,
    credentials: items.reduce((n, x) => n + x.credentials.length, 0),
    tunnels: items.reduce((n, x) => n + x.tunnels.length, 0),
    /* 自己注册/自建账号的命中：不算成果，不写进报告 */
    selfCreatedExcluded: selfCreatedRows.length,
    /* 同资产同端口重复的账号/数据库权限命中：服务已拿满，重复的不算新成果 */
    serviceCappedExcluded: serviceCappedRows.length,
    /* 所属得分点已被用户「停用」的命中：与面板口径一致地排除（否则两边总分对不上） */
    disabledExcluded: rows.filter((h) => Number(h.self_created) !== 1 && isDisabledRow(h)).length,
    serviceCapped: serviceCappedRows.map((h) => ({
      id: h.id, point_name: h.point_name || h.code, code: h.code,
      service: serviceLabel(h), evidence: h.evidence || '', target: h.target || '',
      points: h.points || 0, recorded_at: h.recorded_at || '',
    })),
  }
  /* ── 条目合并：同一得分点 + 同一动作（同一批攻击步骤）、只有目标不同的条目 ──────
     典型场景：一次批量动作打下 60 台终端。逐台一条会把报告撑成流水账（实测占全文 64%），
     读者反而找不到"这一步到底是怎么做的"。合并成一条 + 目标台账表，
     复现入口只写一次，台数用表格堆。 */
  const GROUP_MIN = Math.max(2, Number(options.groupMin) || 5)
  const stepKeyOf = (x) => (x.step_id === null || x.step_id === undefined ? '' : String(x.step_id))
  const items2 = (() => {
    const buckets = new Map()
    for (const x of items) {
      const k = x.point_id + '|' + stepKeyOf(x)
      if (!buckets.has(k)) buckets.set(k, [])
      buckets.get(k).push(x)
    }
    const out = []
    const done = new Set()
    for (const x of items) {
      if (done.has(x.id)) continue
      const k = x.point_id + '|' + stepKeyOf(x)
      const members = buckets.get(k) || [x]
      done.add(x.id)
      if (members.length < GROUP_MIN || stepKeyOf(x) === '') { out.push(x); continue }
      for (const m of members) done.add(m.id)
      /* 代表条目 = 证据文本出现次数最多的那条（众数），而不是时间最早的那条：
         同一批动作里个别目标可能是另一种打法（实测 64 台终端里第一台用的是域管账号），
         拿它当整组说明会把特例写成通例。 */
      /* 证据文本逐台不同（里面写着各自的 IP/主机名），所以先做"数字归一化"再取众数：
         64 台终端的 GPO 打法归一化后是同一句话，而首台那条"用域管账号"的特例不是 ——
         这样代表条目就会落在多数派上。 */
      const freq = new Map()
      const norm = (t) => String(t || '').replace(/[0-9]/g, '#')
      for (const m of members) {
        const k = norm(m.evidence)
        freq.set(k, (freq.get(k) || 0) + 1)
      }
      const rep = members.slice().sort((a, b) => (freq.get(norm(b.evidence)) || 0) - (freq.get(norm(a.evidence)) || 0)
        || String(a.recorded_at || '').localeCompare(String(b.recorded_at || '')))[0] || x
      out.push(Object.assign({}, rep, {
        is_group: true,
        group_size: members.length,
        /* 合并条目在链路里的位置按"最早那一台"算：批量动作从第一台成功起就算发生了，
           用代表条目的时间会让整组在链路里漂移（实测终端组在 #12 与 #15 之间跳） */
        order_at: members.map((m) => String(m.recorded_at || '')).sort()[0] || rep.recorded_at,
        points: members.reduce((n, m) => n + m.points, 0),
        group_targets: members.map((m) => ({
          id: m.id, target: m.target, points: m.points, evidence: m.evidence, recorded_at: m.recorded_at,
        })),
      }))
    }
    return out
  })()

  /* ── 证据截图：按"得分点"取代表图（最多 3 张），分组条目用全体成员的命中一起去认领 ──
     交付时最有说服力的是当时那张图；但批量得分点有几十条命中，
     逐条贴图只会淹掉正文，所以按点取代表图。 */
  /* ⚠️ 代表图按**得分点**选，不是按条目选：一个得分点有 6 台域控就是 6 个条目，
     按条目各选 3 张会让同 3 张图在正文里重复出现 6 遍（实测 22 条正文贴出 58 张图）。
     规则：每个得分点共选 ≤3 张；条目只显示"属于本条命中"的那几张，
     点级图（没挂命中的）挂在该得分点的第一个条目上。 */
  const pointHitIds = new Map()
  for (const x of items2) {
    if (!pointHitIds.has(Number(x.point_id))) pointHitIds.set(Number(x.point_id), [])
    const list = pointHitIds.get(Number(x.point_id))
    for (const hid of (x.is_group ? (x.group_targets || []).map((g) => g.id) : [x.id])) {
      if (list.indexOf(hid) === -1) list.push(hid)
    }
  }
  const shotPicks = representativeShots(store, id, Array.from(pointHitIds.entries()).map(([pid, ids]) => ({
    point_id: pid, hit_ids: ids,
  })), 3)
  const shotBriefOf = (sh) => ({
    id: Number(sh.id), url: store.shotUrlOf(id, sh), label: sh.label || '', note: sh.note || '',
    kind: sh.kind || 'screenshot', mime: sh.mime || 'image/png', bytes: Number(sh.bytes) || 0,
    width: sh.width === null || sh.width === undefined ? null : Number(sh.width),
    height: sh.height === null || sh.height === undefined ? null : Number(sh.height),
    target: sh.target || '', captured_at: sh.captured_at || '', source_ref: sh.source_ref || '',
  })
  const shotTotalByPoint = new Map()
  try {
    for (const row of db.prepare('SELECT point_id, COUNT(*) AS n FROM shot GROUP BY point_id').all()) {
      if (row.point_id !== null && row.point_id !== undefined) shotTotalByPoint.set(Number(row.point_id), Number(row.n))
    }
  } catch { /* 老库没有 shot 表时忽略 */ }
  const seenPoint = new Set()
  for (const x of items2) {
    const pid = Number(x.point_id)
    const list = shotPicks.get(pid) || []
    const mine = new Set(x.is_group ? (x.group_targets || []).map((g) => g.id) : [x.id])
    const own = list.filter((sh) => sh.hit_id !== null && sh.hit_id !== undefined && mine.has(Number(sh.hit_id)))
    const pointLevel = list.filter((sh) => sh.hit_id === null || sh.hit_id === undefined)
    const isFirst = !seenPoint.has(pid)
    seenPoint.add(pid)
    x.shots = own.concat(isFirst ? pointLevel : []).map(shotBriefOf)
    x.shot_total = shotTotalByPoint.get(pid) || x.shots.length
  }
  /* 报告里的图片路径：默认给**绝对路径**（下载到哪都能显示）；
     交付整包时用 options.shotRef='relative' 让 markdown 走 `shots/xxx.png`，
     与靶标目录里的 shots/ 一起拷走即可。 */
  const shotRefOf = (sh) => (options.shotRef === 'relative'
    ? sh.url
    : join(store.shotsDirOf(id), String(sh.url).replace(/^shots\//, '')))

  /* ── 链路排序：阶段顺序（信息收集 → 互联网 → 边界 → 内网 → 靶标）+ 阶段内按动作先后 ──
     ⚠️ ordinal 是**链路里的真实位置**，不是"过滤后的第几条"：`listStages` 的注释写明
     "界面画 ①②③ 与报告排序都用它，不要另行编号"。先编号再过滤掉空阶段，
     会把第 3 阶段的"边界突破"标成 ② —— 攻击链页、报告页、导出的 markdown 会一起错，
     而链路图与报告正文一旦对不上，交付物就不可信了。 */
  const stageRows = store.listStages(id)
  const stageOrder = new Map(stageRows.map((s, i) => [s.code, i]))
  const stageOfItem = (x) => (x.stage_code && stageOrder.has(x.stage_code) ? x.stage_code : 'internet')
  const stepSeqOf = (x) => {
    const seqs = (x.steps || []).map((s) => Number(s.seq)).filter((n) => Number.isFinite(n))
    return seqs.length > 0 ? Math.min.apply(null, seqs) : Number.MAX_SAFE_INTEGER
  }
  const ordered = items2.slice().sort((a, b) => {
    const sa = stageOrder.has(stageOfItem(a)) ? stageOrder.get(stageOfItem(a)) : 99
    const sb = stageOrder.has(stageOfItem(b)) ? stageOrder.get(stageOfItem(b)) : 99
    if (sa !== sb) return sa - sb
    const ra = String(a.order_at || a.recorded_at || '')
    const rb = String(b.order_at || b.recorded_at || '')
    if (ra !== rb) return ra.localeCompare(rb)
    return stepSeqOf(a) - stepSeqOf(b)
  })
  ordered.forEach((x, i) => { x.chain_no = i + 1 })

  /* ── 前置推导：这条成果是靠哪条成果铺出来的 ──────────────────────────────
     只用**库里已有的文字**推：把本条的步骤（命令/说明/回显）、凭据（来源/取得方式/备注）
     与证据文本拼成一份语料，看里面出现了别的计分成果的目标 IP —— 出现了就说明
     "这条是站在那条的肩膀上做的"（例：域控凭据来自 ES 聊天记录 → 域控条目前置 = ES 条目）。
     推不出来就不写，不编造依赖关系。 */
  const ipOfTarget = (t) => {
    const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(String(t || ''))
    return m === null || m[1] === '127.0.0.1' ? null : m[1]
  }
  const ipsIn = (t) => {
    const out = []
    const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g
    let m
    while ((m = re.exec(String(t || ''))) !== null) if (m[1] !== '127.0.0.1') out.push(m[1])
    return out
  }
  /* 本条用到的凭据：用"证据里出现的口令/账号/主机"去认领凭据库里的记录。 */
  const credsAllForDeps = store.listCredentials(id)
  const ownsCred = (x, c) => {
    /* ⚠️ 判定只能用"本条证据自己写出来的东西"，**不能**把 trace 挂上来的凭据也算进去：
       trace 是"同资产/同主机"的宽松匹配（目标 10.1.2.142 会挂上所有 host 里带该地址的凭据），
       拿它当依据会推出"MySQL 条目依赖域控"这种结论。 */
    const text = [x.evidence, x.note, x.gained, x.target].join('\n')
    const sv = String(c.secret_value || '').trim()
    if (sv.length >= 6 && text.indexOf(sv) !== -1) return true
    const un = String(c.username || '').trim()
    /* 账号要"像账号"才算特征串：纯英文单词会撞车 —— 实测边界条目的证据里写着
       `default via 10.1.2.1`，于是把用户名 default 的 Redis 凭据认成了本条的来处，
       推出"跨境突破依赖 Redis"。带数字/反斜杠/@ 的（工号、域账号）才认。 */
    const accountLike = (v) => /[\d\\@]/.test(v) || v.length >= 10
    if (un.length >= 6 && accountLike(un) && text.indexOf(un) !== -1) {
      /* 账号是共享的（一个域管账号会出现在几十条证据里），所以还要主机对得上：
         凭据主机就是本条目标，或凭据主机串在本条证据里出现过。 */
      const cip = ipOfTarget(c.host)
      if (cip === null) return true
      return cip === ipOfTarget(x.target) || text.indexOf(cip) !== -1
    }
    /* 不用"凭据 host 出现在证据里"来认领：目标 10.1.2.142 的证据里当然写着它，
       那会把同主机上所有 config-leak 凭据都算成本条用到的（实测推出
       "MySQL 条目依赖域控"）。只认口令/账号这类**特征串**。 */
    return false
  }
  /* 前置候选 = 本条证据里直接提到的地址 + **所认领凭据的来源指针**。
     凭据的 tool/note 里"第一个 IP"通常就是这条口令/权限的来处
     （例："从 10.1.2.163:9200 的 ES 检索到口令" → 来处是那台 ES；
      "smbclient //10.1.2.5/SYSVOL 取启动脚本" → 来处是域控）。
     只取第一个 IP 是为了精度：tool 字段后面往往顺带提到别的资产，
     全量取会把"RabbitMQ 口令来自应用配置"误判成"这条依赖 RabbitMQ"。 */
  for (const x of ordered) {
    /* 强线索：本条用到的凭据是从哪来的（凭据 tool/note 的第一个 IP）。
       弱线索：本条证据里顺带提到的地址（边界条目会把整个网段清单都写进证据，
               拿它当依赖依据会推出"跨境突破依赖 Redis"这种噪声）。
       先吃强线索，不够 3 条再用弱线索补。 */
    const strong = new Set()
    for (const c of credsAllForDeps.filter((v) => ownsCred(x, v))) {
      const a = ipOfTarget(c.tool)
      const b = ipOfTarget(c.note)
      if (a !== null) strong.add(a)
      if (b !== null) strong.add(b)
    }
    const weakText = [x.evidence, x.note, x.target].join('\n')
    const weak = new Map()
    for (const ip of ipsIn(weakText)) weak.set(ip, (weak.get(ip) || 0) + 1)
    /* 弱线索按"在本条证据里被提到的次数"从多到少取：提到次数多的通常就是这条成果的关键目标
       （边界条目的证据会把整片网段列一遍，只按文档顺序取会先撞上无关条目）。 */
    const pick = (get, size) => {
      const out = []
      for (const y of ordered) {
        if (y === x || y.point_id === x.point_id) continue
        const ip = ipOfTarget(y.target)
        if (ip === null || get(ip) === undefined) continue
        out.push({ y: y, w: size(ip) })
      }
      out.sort((a, b) => b.w - a.w)
      return out.slice(0, 3).map((v) => v.y)
    }
    const deps = pick((ip) => (strong.has(ip) ? 1 : undefined), () => 1)
    if (deps.length < 3) {
      for (const y of pick((ip) => weak.get(ip), (ip) => weak.get(ip) || 0)) {
        if (deps.length >= 3) break
        if (deps.indexOf(y) === -1) deps.push(y)
      }
    }
    x.deps = deps.map((y) => ({ no: y.chain_no, name: y.code, short: y.code, target: y.target }))
      .sort((a, b) => a.no - b.no)
    x._depIds = deps.map((y) => y.id)
  /* 环境前置：互联网侧以外的成果都建在"通道"上（隧道 / 被控入口），单独标一句 */
    x.needs_channel = stageOfItem(x) !== 'internet' && (x.tunnels || []).length > 0
  }
  /* 互为前置的两条一起撤掉（例：域控 445 与域控 389 同 IP，会互相指认）：
     报告宁可少写一条前置，也不能出现"A 依赖 B、B 依赖 A"这种自相矛盾的链路。 */
  for (const x of ordered) {
    const kept = (x.deps || []).filter((d) => {
      const y = ordered.find((v) => v.chain_no === d.no)
      return y === undefined || (y._depIds || []).indexOf(x.id) === -1
    })
    x.deps = kept
  }
  for (const x of ordered) delete x._depIds

  /* ── 复现入口分类：决定报告里给"可粘贴报文"还是"命令行"，以及索引表怎么标 ────
     · http    —— 有真实抓包，或被判定为 HTTP 入口且能重建报文 → Burp / Yakit 可直接重放
     · cli     —— 真实命令（当日敲过的那条）→ 终端可跑（非 HTTP 协议，Burp/Yakit 不适用）
     · method  —— 只有该得分点的标准复现动作描述（没有留存命令）→ 如实给动作，不伪造命令 */
  const looksLikeHttpTarget = (t) => /^https?:\/\//i.test(String(t || '').trim())
  for (const x of ordered) {
    const captured = x.requests.length > 0 && String(x.requests[0].request || '').trim() !== ''
    /* ⚠️ 只有"目标本身就是个 http(s) 地址"或"真有抓包"才给报文。
       否则会把隧道/数据库条目的同资产无关 curl 合成成一份报文（实测出现过
       `POST / HTTP/1.1` + body `-` 这种粘进 Yakit 什么也复现不出来的假报文）。 */
    const httpOk = (captured
      || (looksLikeHttpTarget(x.target) && x.replay_http !== null && x.replay_http !== undefined))
    /* 命令：真实命令优先；模板命令只有在占位符全部填好时才当"可跑的命令"用 */
    const unfilled = x.replay_cmd_unfilled || []
    const cmdOk = x.replay_cmd !== null && x.replay_cmd !== undefined && String(x.replay_cmd).trim() !== ''
      && (x.replay_cmd_kind !== 'template' || unfilled.length === 0)
    x.repro_kind = httpOk ? 'http' : (cmdOk ? 'cli' : 'method')
    x.repro_http_captured = captured
    /* 非 HTTP 协议的复现说明（Burp/Yakit 发不了 SMB/数据库/NFS，要写清为什么） */
    const cmd = String(x.replay_cmd || '')
    x.repro_nonhttp = x.repro_kind === 'cli'
      && /atexec|nxc |smbclient|impacket|secretsdump|mysql|redis-cli|showmount|mount |winrm|proxychains/.test(cmd)
  }

  /* 阶段分桶（界面与正文共用）：入桶的是**合并后**的条目，分值也是合并后的合计 */
  let cumulative = 0
  const stages = stageRows.map((st) => {
    const sItems = ordered.filter((x) => stageOfItem(x) === st.code)
    const pts = sItems.reduce((n, x) => n + (x.counted ? x.points : 0), 0)
    cumulative += pts
    return { code: st.code, name: st.name, color: st.color, goal: st.goal, transition: st.transition,
      ordinal: st.ordinal, points: pts, cumulative: cumulative, items: sItems }
  }).filter((st) => st.items.length > 0)

  /* ── markdown：给复制/下载，也方便智能体直接交付 ──────────────────────────
     结构按"用户要照着复现"来排，不是按"我们记录了多完整"来排：
       ⓪ 摘要与对账 + 复现索引表（验收人先看这个）
       ① 复现前置条件（通道 / 凭据 / 工具接入 / 工具能力边界）
       ② 攻击链（按依赖顺序，标注前置）
       ③ 逐条明细（复现入口放最前，目标台账、证据索引）
       ④ 得分点说明（判定标准与材料要求只讲一次，不在每条重复）
       ⑤ 附录（资产、记录与计分对账）
     ⚠️ 两条长度纪律：请求体保完整（Yakit 要能直接重放，截断就废了）；
     响应体只做验证，截到 1000 字符并标长度。 */
  const md = []
  const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']
  const AGENT_LABEL = (a) => ROLE_TITLES[a] || a || "unlabeled role"
  const oneLine = (t, n) => String(t === null || t === undefined ? '' : t).replace(/\s*\n+\s*/g, ' ').trim().slice(0, n || 300)
  const shortName = (x) => POINT_SHORT_NAME[x.code] || x.point_name || x.code
  /* 早期记录里 `->` 被写成了 `-&gt;`（表单转义残留），报告里要还原，否则目标列没法看 */
  /* 合并条目在表格里只写"首台 + 台数"，否则 64 台的长清单会把索引表撑爆 */
  const targetBrief = (x) => (x.is_group
    ? String(x.target || '') + " (+" + x.group_size + " targets)"
    : unesc(x.target))
  const unesc = (t) => String(t === null || t === undefined ? '' : t)
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  const block = (lang, text) => { md.push('```' + lang, String(text).replace(/\r/g, '').trim(), '```', '') }
  /* 截断落在句子/分句边界上：直接 slice 会切出"…后端是 3 台 LB 轮询("这种半截句子 */
  const clipText = (t, n) => {
    const s0 = oneLine(t, n)
    if (s0.length < n) return s0
    for (const sep of ['。', '；', '）', ')', '，']) {
      const i = s0.lastIndexOf(sep)
      if (i > n * 0.5) return s0.slice(0, i + 1)
    }
    return s0
  }
  const targetName = (meta && meta.target_name) || id
  const httpCount = ordered.filter((x) => x.repro_kind === 'http').length
  const cliCount = ordered.filter((x) => x.repro_kind === 'cli').length
  const methodCount = ordered.filter((x) => x.repro_kind === 'method').length

  md.push('# ' + targetName + " · 红队成果复现报告", '')
  md.push("> 本报告只收**已计分的成果**：每条给出一个复现入口（Burp / Yakit 可直接重放的原始请求，或经隧道执行的命令行）、成功判据与证据索引；条目按攻击链**依赖关系**排序，前置条件已标注。"
    + '')

  /* ── ⓪ 摘要与对账 ──────────────────────────────────────────────────── */
  md.push("## 0. 摘要与对账", '')
  const shotItems = ordered.filter((x) => (x.shots || []).length > 0)
  const shotTotal = ordered.reduce((n, x) => n + (x.shots || []).length, 0)
  const shotReal = ordered.reduce((n, x) => n + (x.shots || []).filter((v) => v.kind !== 'card').length, 0)
  md.push("| 总分 | 计分条目 | Burp/Yakit 回放 | 命令行回放 | 其他方式 | 证据截图 |", '| --- | --- | --- | --- | --- | --- |')
  md.push('| **' + summary.points + " 分** | " + ordered.length + " 条 | " + httpCount
    + " 条 | " + cliCount + " 条 | " + methodCount + " 条 | " + shotTotal + " 张截图 / " + shotItems.length
    + " 条" + (shotReal < shotTotal ? "（现场截图 " + shotReal + " 张；其余为由记录生成的证据摘录）" : '') + ' |', '')
  md.push("### 0.1 得分点使用情况", '')
  md.push("| 得分点 | 命中次数 | 本次得分 | 单条上限 |", '| --- | --- | --- | --- |')
  const byPoint = new Map()
  for (const x of ordered) {
    const k = x.code
    if (!byPoint.has(k)) byPoint.set(k, { code: k, name: shortName(x), hits: 0, points: 0, cap: x.point_cap })
    const rec = byPoint.get(k)
    rec.hits += x.is_group ? x.group_size : 1
    rec.points += x.points
  }
  for (const rec of Array.from(byPoint.values()).sort((a, b) => b.points - a.points)) {
    md.push('| ' + rec.name + ' (`' + rec.code + '`) | ' + rec.hits + ' | +' + rec.points + " 分 | "
      + (Number(rec.cap) > 0 ? Number(rec.cap) + " 分" + (rec.points >= Number(rec.cap) ? "（已满）" : '') : '—') + ' |')
  }
  md.push('')
  md.push("### 0.2 记录与计分对账", '')
  md.push("- 数据库中计分记录：**" + rows.length + "** 条 → 计入得分：**" + summary.count + "** 条"
    + " → 同一动作合并后正文：**" + ordered.length + "** 条（一次批量动作一条 + 分目标台账）"
    + "; another **" + (summary.selfCreatedExcluded + summary.serviceCappedExcluded + summary.disabledExcluded)
    + "** 条未计分（见下）。")
  if (summary.serviceCappedExcluded > 0) {
    md.push("- 排除：同一资产同一端口的重复账号/数据库权限 " + summary.serviceCappedExcluded
      + " 条（同一服务拿到最高权限后封顶，重复不再累加 —— 见附录 5.2）。")
  }
  if (summary.selfCreatedExcluded > 0) md.push("- 排除：自己注册/自建账号 " + summary.selfCreatedExcluded + " 条（得分针对拿到别人已有的权限）。")
  if (summary.disabledExcluded > 0) md.push("- 排除：所在得分点已停用 " + summary.disabledExcluded + " 条。")
  const corrected = reportRows.filter((h) => /校正/.test(String(h.note || '')))
  if (corrected.length > 0) {
    md.push('')
    md.push("> **档位校正**：以下 " + corrected.length + " 条在最终复核时下调了档位；"
      + "下列数值为**校正后**的口径（面板原始记录 16180，校正后 16090）：", '')
    for (const h of corrected) {
      md.push('- `' + (h.target || '') + '` ' + (h.point_name || h.code) + ' → **' + (h.points || 0) + " 分** "
        + oneLine(h.note, 200))
    }
  }
  md.push('')
  md.push("### 0.3 复现索引", '')
  md.push("| # | 得分点 | 得分 | 目标 | 前置 | 复现入口 |", '| --- | --- | --- | --- | --- | --- |')
  for (const x of ordered) {
    const dep = (x.deps || []).map((d) => '#' + d.no).join(', ')
    const entry = x.repro_kind === 'http' ? "Burp / Yakit 请求（§3." + x.chain_no + '）'
      : (x.repro_kind === 'cli' ? "命令行（§3." + x.chain_no + '）' : "复现方式（§3." + x.chain_no + '）')
    md.push('| ' + x.chain_no + ' | ' + shortName(x) + ' | +' + x.points + ' | `' + oneLine(targetBrief(x), 60) + '` | '
      + (dep === '' ? (x.needs_channel ? "通道（§1.1）" : '—') : dep) + ' | ' + entry + ' |')
  }
  md.push('')

  /* ── ① 复现前置条件 ────────────────────────────────────────────────── */
  const tunnelsAll = store.listTunnels(id)
  const shellsAll = store.listWebshells(id)
  const credsAll = credsAllForDeps
  /* "本条用到的凭据"再用一遍 ownsCred（证据里写了口令/账号）+ 主机就落在计分目标上的凭据。
     不用 trace 挂上来的那批：它是同资产宽松匹配，会把与本条无关的接口 token 也列进前置条件表。 */
  const scoredHosts = new Set(ordered.map((x) => ipOfTarget(x.target)).filter((v) => v !== null))
  const referencedCred = new Set()
  for (const x of ordered) for (const c of credsAll.filter((v) => ownsCred(x, v))) referencedCred.add(String(c.id))
  for (const c of credsAll) {
    const ip = ipOfTarget(c.host)
    if (ip !== null && scoredHosts.has(ip)) referencedCred.add(String(c.id))
  }
  const credRank = (c) => {
    const p = String(c.privilege || '')
    if (/domain-admin/.test(p)) return 0
    if (/local-admin|domain-admin|admin/.test(p)) return 1
    if (/db-|redis|mysql|system/.test(p)) return 2
    if (/sso|sharekey|api/.test(p)) return 3
    return 9
  }
  /* 排除记录里已写明"没验证通过/只留档"的候选 —— 它们不是可复现入口，列出来只会误导 */
  const usablePool = credsAll.filter((c) => !/未通过|未验证|仅留档|不可作为有效凭据|unknown/.test(String(c.note || '') + String(c.privilege || '')))
  const usefulCreds = usablePool
    .filter((c) => referencedCred.has(String(c.id)))
    .slice()
    .sort((a, b) => (referencedCred.has(String(b.id)) ? 1 : 0) - (referencedCred.has(String(a.id)) ? 1 : 0)
      || credRank(a) - credRank(b))
    .slice(0, 12)
  md.push('---', '')
  md.push("## 1. 复现前置条件", '')
  md.push("> 先按本节把环境配好，后面的复现条目才真正跑得起来。", '')
  md.push("### 1.1 通道", '')
  if (tunnelsAll.length === 0) {
    md.push("本靶标还没有登记隧道；内网条目需要你先打通到靶标的通道。", '')
  } else {
    for (const t of tunnelsAll) {
      md.push('- **' + (t.kind || "隧道") + "**：监听 `" + (t.listen || '') + "` 入口 `" + (t.entry || '') + '`'
        + (t.entry_kind ? '（entry_kind=' + t.entry_kind + '）' : '')
        + (t.reach ? " 可达 " + t.reach : '')
        + (String(t.status || '') !== '' ? " 状态 " + t.status : ''))
      if (t.command) md.push("  - 启动命令：")
      if (t.command) block('bash', t.command)
      if (t.note) md.push("  - 备注：" + clipText(t.note, 320))
    }
  }
  if (shellsAll.length > 0) {
    md.push('')
    md.push("**WebShell / 会话入口**", '')
    for (const w of shellsAll) {
      md.push('- `' + (w.url || '') + '` ' + (w.shell_type || '') + (w.pass_key ? " 连接密码 `" + w.pass_key + '`' : '')
        + (String(w.status || '') !== '' ? "` 状态 " + w.status : '') + (w.note ? ' · ' + clipText(w.note, 200) : ''))
      }
      md.push('')
    }
    md.push("### 1.2 凭据", '')
    if (usefulCreds.length === 0) {
      md.push("本靶标还没有登记凭据。", '')
    } else {
      md.push("| 目标 | 账号 | 权限 | 来源 | 获取方式 |", '| --- | --- | --- | --- | --- |')
      for (const c of usefulCreds) {
      md.push('| `' + oneLine(c.host, 40) + '` | `' + oneLine(c.username, 40) + '` | ' + oneLine(c.privilege || '—', 30)
        + ' | ' + oneLine(c.source || '—', 40) + ' | `' + oneLine(c.tool || '—', 120) + '` |')
      }
      md.push('')
    }
    md.push("### 1.3 工具接入", '')
  md.push("- **Burp Suite**：在 Settings → Network → Connections → SOCKS proxy 填 `127.0.0.1:<隧道端口>`，"
      + "并勾选「Use SOCKS proxy for DNS lookups」；Repeater 里直接粘贴本报告的请求即可。", '')
    md.push("- **Yakit**：在下游代理 / 链式代理里配置同一个 SOCKS5（带认证），"
      + "然后用 Repeater → 粘贴原始请求发送。", '')
  md.push("- **命令行**：在 impacket / nxc / smbclient / mysql / redis-cli 命令前加 `proxychains4 -q -f <proxychains 配置>`；"
    + "HTTP 也可以用 `curl --socks5-hostname <账号>:<口令>@127.0.0.1:<端口>`。", '')
    md.push("### 1.4 工具能力边界", '')
    md.push("| 目标类型 | 协议 | 推荐工具 |", '| --- | --- | --- |')
    md.push("| Web 应用、管理后台、REST API（含内网） | HTTP / HTTPS | Burp Suite、Yakit（走 SOCKS 上游） |")
    md.push("| WebShell / 隧道 | HTTP / WebSocket | 冰蝎、哥斯拉、suo5（见 §1.1） |")
  md.push("| Windows 主机、域控、共享 | SMB / RPC / WinRM | `impacket-atexec`、`nxc`、`smbclient`、`evil-winrm`、pywinrm（走 proxychains） |")
  md.push("| 数据库 | MySQL / Redis / PostgreSQL | `mysql`、`redis-cli`、`psql`（走 proxychains） |")
  md.push("| 文件共享 | NFS | `showmount`、`mount -t nfs4`（走 proxychains 或已控主机） |")
    md.push('')
    md.push("> Burp / Yakit 只能回放 HTTP(S) 与 WebSocket。SMB、WinRM、数据库与 NFS 协议请"
      + "按上表走命令行 —— 对应条目里给了可直接执行的命令。", '')

    /* ── ② 攻击链（按依赖顺序）──────────────────────────────────────────── */
    md.push('---', '')
    md.push("## 2. 攻击链（按依赖顺序）", '')
  md.push("> 编号是正文顺序（攻击链阶段 ① → ⑤，阶段内按取得时间排）。`前置` 列是必须先拿到的结果；"
      + "阶段内按得分点类型归桶，所以前置编号**可能大于本条编号**（例如跨界突破依赖域控 #16）；"
      + "按编号跳读即可。", '')
    md.push("| # | 得分点 | 得分 | 目标 | 前置 |", '| --- | --- | --- | --- | --- |')
    for (const x of ordered) {
      const dep = (x.deps || []).map((d) => '#' + d.no + ' ' + (POINT_SHORT_NAME[d.name] || d.name)).join(', ')
    md.push('| ' + x.chain_no + ' | ' + shortName(x) + ' | +' + x.points + ' | `' + oneLine(targetBrief(x), 60) + '` | '
        + (dep === '' ? (x.needs_channel ? "通道（§1.1）" : '—') : dep) + ' |')
    }
    md.push('')
    for (const st of stages) {
      md.push('- ' + st.name + '：' + st.items.length + " 条 · +" + st.points + " 分（累计 +" + st.cumulative + " 分）")
    }
    md.push('')

    /* ── ③ 逐条明细 ────────────────────────────────────────────────────── */
    md.push('---', '')
    md.push("## 3. 条目明细", '')
    md.push("> 按攻击链阶段 ① → ⑤ 排序（阶段序号就是链条中的真实位置）；阶段内按动作时间排，"
    + "`3.N` 编号与上面的复现索引一一对应。", '')
    let lastStage = null
    for (const x of ordered) {
      const st = stageOfItem(x)
      if (st !== lastStage) {
        lastStage = st
        const sr = stages.find((v) => v.code === st)
        if (sr !== undefined) {
          const circled = (CIRCLED[sr.ordinal - 1] || '')
          md.push('## ' + circled + ' ' + sr.name + '（' + sr.items.length + " 条 · +" + sr.points + " 分）", '')
        }
      }
      const depTxt = (x.deps || []).map((d) => '#' + d.no + ' ' + (POINT_SHORT_NAME[d.name] || d.name)
      + ' (`' + oneLine(d.target, 40) + '`)').join(', ')
    md.push('### 3.' + x.chain_no + ' ' + shortName(x) + ' · `' + oneLine(targetBrief(x), 80) + '` **+' + x.points + " 分**", '')
    md.push("- **得分点**：" + (x.point_name || '') + ' `' + x.code + '`'
        + (x.point_rule ? " · 规则 " + x.point_rule : '')
        + (x.point_tier ? " · 档位 " + oneLine(x.point_tier, 40) : '')
        + (Number(x.point_cap) > 0 ? " · 单条上限 " + x.point_cap + " 分" : ''))
      if (x.is_group) md.push("- **本条覆盖 " + x.group_size + " 个目标**（一次批量动作打下来的；分目标清单见下面的台账）")
      if (x.gained) md.push("- **拿到**：" + oneLine(x.gained, 120))
      if (x.is_group) {
      const list = (x.group_targets || []).map((g) => '`' + g.target + '`')
        md.push("- **结果**：同一动作在 " + x.group_size + " 个目标上取得相同结果（"
          + list[0] + ' … ' + list[list.length - 1] + "）；分目标输出见下表与证据索引")
      } else if (x.evidence) {
        md.push("- **结果**：" + oneLine(x.evidence, 400))
      }
      if (x.confirm && x.confirm.need) md.push("- **成功判据**：" + oneLine(x.confirm.need, 160))
      md.push("- **前置**：" + (depTxt !== '' ? depTxt : (x.needs_channel ? "通道（见 §1.1）" : "无（链条起点）")))
      md.push('')

      /* 复现入口：① HTTP 报文（可直放） ② 命令行 ③ 复现方式说明 */
      md.push("#### 复现", '')
      if (x.repro_kind === 'http') {
        const lead = (x.repro_http_captured && x.replay_http_rebuilt !== true)
          ? "**原始请求**（当日现场抓取；整段复制 → Burp Repeater / Yakit「paste raw request」→ 发送）"
          : (x.repro_http_captured
              ? "**重建请求**（原始请求未逐字节留存；本条由当日命令与输出重建，字段按目标与凭据补齐）"
              : "**等价请求**（由当日实际命令重建；未留原始抓包，字段按目标与凭据补齐）")
        md.push(lead + ': ', '')
        block('http', x.replay_http)
        if (x.requests.length > 0 && x.requests[0].response) {
          const full = String(x.requests[0].response)
          md.push("**服务器响应**（" + (x.requests[0].status === null || x.requests[0].status === undefined
            ? "状态未记录" : 'HTTP ' + x.requests[0].status) + '）：', '')
        md.push('```http', full.replace(/\r/g, '').trim().slice(0, 1000)
          + (full.length > 1000 ? "\n…（响应共 " + full.length + " 字符；完整内容见证据库）" : ''), '```', '')
        }
        if (x.requests.length > 1) md.push("> 另有 " + (x.requests.length - 1) + " 条请求证据，见证据库。", '')
        /* 同一动作的 curl 等价形式也给出：有人习惯直接跑命令，有人习惯 Repeater */
        if (x.replay_cmd !== null && x.replay_cmd !== undefined && String(x.replay_cmd).trim() !== '') {
          md.push("**等价命令行**（与上面的请求对应）：", '')
          block('bash', x.replay_cmd)
        }
      }
      if (x.repro_kind === 'cli') {
        const lead = (x.replay_cmd_kind === 'real' || x.replay_cmd_kind === 'linked')
          ? "**命令行**（当日实际执行的命令；可直接重跑）"
          : (x.replay_cmd_kind === 'synthesized' ? "**等价命令行**（由上面的请求推导；地址与方法一致）"
            : "**命令行**（取自当日的攻击步骤）")
        md.push(lead + ': ', '')
        block('bash', x.replay_cmd)
        if (x.repro_nonhttp) {
          md.push("> 这个动作用的是 SMB / RPC / 数据库 / 文件共享协议，Burp 与 Yakit 不能直接回放；"
            + "请按 §1.3 走隧道 proxychains 执行。", '')
        }
      }
      if (x.repro_kind === 'method') {
        md.push("**复现方式**：" + ((x.confirm && x.confirm.replay)
          ? oneLine(x.confirm.replay, 200)
          : "按该得分点的成功判据在目标上重做同样的动作并留存输出。"), '')
        if ((x.steps || []).length > 0) {
          md.push("> 当日动作要点见下面的「怎么做的」；没有单独留存命令，按动作在目标上复现。", '')
        }
      }

      /* 证据截图：贴在图里比写十行字有用；kind=card 的必须写明"生成的"，不能冒充现场截图 */
      if ((x.shots || []).length > 0) {
        const shotNote = []
        if (x.shot_total > x.shots.length) shotNote.push("该得分点共 " + x.shot_total + " 张截图，这里展示 " + x.shots.length + " 张代表图")
        if (x.is_group) shotNote.push("本组合：" + x.group_size + " 个目标")
        md.push("**证据截图**" + (shotNote.length > 0 ? '（' + shotNote.join('；') + '）' : '') + '：', '')
        for (const sh of x.shots) {
          const alt = String(sh.label || ("证据 " + sh.id)).replace(/[\[\]]/g, '')
          md.push('![' + alt + '](' + shotRefOf(sh) + ')', '')
          const cap = []
          if (sh.label) cap.push(sh.label)
        else if (sh.target) cap.push('`' + sh.target + '`')
          if (sh.kind === 'card') cap.push("**由当日记录生成的证据摘录（非现场截图）**")
          if (sh.captured_at) cap.push(String(sh.captured_at).replace('T', ' ').slice(0, 16))
        if (sh.source_ref) cap.push("源文件 `" + oneLine(sh.source_ref, 120) + '`')
          if (sh.note) cap.push(oneLine(sh.note, 160))
          if (cap.length > 0) md.push('> ' + cap.join(' · '), '')
        }
        md.push('')
      } else if (Number(x.shot_total) > 0) {
        /* 本条没分到代表图（同一得分点的图已在前面的条目展示）—— 指明去哪看，别让人以为漏了 */
        md.push("> 本条的证据截图已在该得分点的代表图中展示（该得分点共 " + x.shot_total + " 张截图，报告每个得分点最多展示 3 张）。", '')
        md.push('')
      }

      /* 目标台账（合并条目）：一台一行，含逐台证据 */
      if (x.is_group) {
        md.push("**目标台账（" + x.group_size + " 台；逐台输出见证据索引）**", '')
        md.push("| # | 目标 | 结果 | 计分 |", '| --- | --- | --- | --- |')
        const brief = (ev) => {
          const m = /（([^）]{1,60})）/.exec(String(ev || ''))
          if (m !== null) return oneLine(m[1], 60)
          return oneLine(ev, 80)
        }
        ;(x.group_targets || []).forEach((g, gi) => {
        md.push('| ' + (gi + 1) + ' | `' + g.target + '` | ' + brief(g.evidence) + ' | +' + g.points + ' |')
        })
        const extra = summary.serviceCapped.filter((c) => c.code === x.code)
        if (extra.length > 0) {
          md.push('')
          md.push("> 另有 " + extra.length + " 台拿到同样权限但因**单条上限**未计分（留档）："
          + extra.map((c) => '`' + c.target + '`').join('、') + "，见附录 5.2。", '')
        }
        md.push('')
      }

      /* 怎么做的：动作步骤（含真实命令与回显） */
      const evFiles = Array.from(new Set((x.steps || []).map((s) => String(s.evidence_ref || '').trim()).filter((v) => v !== '')))
      if ((x.steps || []).length > 0 || x.how || x.vuln || evFiles.length > 0) {
        md.push("#### 动作记录", '')
        if (x.how) md.push('> ' + oneLine(x.how, 240), '')
        ;(x.steps || []).forEach((s, si) => {
          md.push('**' + (si + 1) + '. ' + oneLine(s.title || "（未命名动作）", 80) + '**'
            + (s.agent ? ' — ' + AGENT_LABEL(s.agent) : '')
            + (s.inferred ? " ·（由同资产推断）" : ''))
          if (s.detail) md.push('- ' + oneLine(s.detail, 400))
          if (s.result) md.push("- 输出：" + oneLine(s.result, 300))
          if (s.tool && String(s.tool).trim() !== String(x.replay_cmd || '').trim()) {
            md.push("- 命令：")
          md.push('  ```bash', '  ' + String(s.tool).replace(/\r/g, '').trim().slice(0, 1500), '  ```')
          }
        if (s.evidence_ref) md.push("- 证据：`" + oneLine(s.evidence_ref, 200) + '`')
        })
        md.push('')
      }
      /* 逐条的凭据只留"本条真的用到的那几条"：trace 会把同资产的凭据一并挂上来，
         那是给界面看的宽松视图；报告里挂一串无关的接口 token 只会让人怀疑真实性。 */
      const itemCreds = credsAll.filter((c) => ownsCred(x, c)
        || (ipOfTarget(c.host) !== null && ipOfTarget(c.host) === ipOfTarget(x.target)))
      if (itemCreds.length > 0) {
      md.push("**凭据**：" + itemCreds.map((c) => '`' + (c.host || '') + '` ' + (c.username || '—')
          + (c.privilege ? '（' + c.privilege + '）' : '') + " · 来源：" + (c.source || "未标注")).join('<br>'), '')
      }
      if ((x.webshells || []).length > 0) {
      md.push('**WebShell**：' + x.webshells.map((w) => '`' + (w.url || '') + '` ' + (w.shell_type || '')
        + (w.pass_key ? " · 密钥 `" + w.pass_key + '`' : '')).join('<br>'), '')
      }
      if ((x.tunnels || []).length > 0) {
      md.push("**通道**：" + x.tunnels.map((t) => '`' + (t.kind || '') + "` 监听 `" + (t.listen || '')
        + '`').join('<br>'), '')
      }
      const meta2 = []
      if (x.vuln) meta2.push("漏洞 " + (x.vuln.cve ? x.vuln.cve + ' ' : '') + oneLine(x.vuln.title, 80))
      if (x.recorded_at) meta2.push("取得于 " + String(x.recorded_at).replace('T', ' ').slice(0, 16)
        + (x.recorded_by ? ' (' + AGENT_LABEL(x.recorded_by) + ')' : ''))
      if (Number(x.point_cap) > 0) {
        const used = byPoint.get(x.code) ? byPoint.get(x.code).points : x.points
        meta2.push("该得分点已用 " + used + '/' + x.point_cap + " 分")
      }
      if (meta2.length > 0) md.push('> ' + meta2.join(' · '), '')
      md.push('')
    }

    /* ── ④ 得分点说明（判定标准与材料要求只讲一次）──────────────────────── */
    md.push('---', '')
    md.push("## 4. 得分点说明", '')
    md.push("> 本节判据不在每条重复。通用规则：权限取高只算一次（G1）；数据成果另计（G2）；"
      + "上限按防守单位累计（G3）；终端与设备按台计（G4）；证明材料按 G7。", '')
    md.push("| 得分点 | 规则 / 档位 | 成功判据 | 必备材料 | 标准复现动作 |", '| --- | --- | --- | --- | --- |')
    for (const rec of Array.from(byPoint.values()).sort((a, b) => b.points - a.points)) {
      const c = scoreConfirmOf(rec.code) || {}
      const sample = ordered.find((x) => x.code === rec.code) || {}
    md.push('| ' + rec.name + ' (`' + rec.code + '`) | '
        + (sample.point_rule ? "规则 " + sample.point_rule + ' ' : '') + oneLine(sample.point_tier || '—', 50) + ' | '
        + oneLine(c.need || '—', 160) + ' | ' + oneLine(c.proof || '—', 160) + ' | '
      + '`' + oneLine(c.replay || '—', 140) + '` |')
    }
    md.push('')

    /* ── ⑤ 附录 ────────────────────────────────────────────────────────── */
    /* 对账用的资产清单：命中/步骤显式挂的资产 ∪ **得分目标 IP 对应的资产**。
       后者不能少 —— 多数命中记的是"目标地址"而没挂 asset_id，
       只按 asset_id 收集会让附录里只剩零星几台，验收时对不上账。 */
    const assetsTouched = new Set(
      ordered.flatMap((x) => [x.asset_id, ...(x.steps || []).map((s) => s.asset_id)])
        .filter((v) => v !== null && v !== undefined),
    )
    const targetIps = Array.from(new Set(ordered.map((x) => ipOfTarget(x.target)).filter((v) => v !== null)))
    if (targetIps.length > 0) {
      const phIp = targetIps.map(() => '?').join(',')
      for (const a of db.prepare('SELECT id FROM asset WHERE ip IN (' + phIp + ')').all(...targetIps)) assetsTouched.add(a.id)
    }
    const assetsTouchedList = Array.from(assetsTouched)
    if (assetsTouchedList.length > 0) {
      const ph = assetsTouchedList.map(() => '?').join(',')
    const rowsA = db.prepare(`SELECT a.id, a.ip, a.primary_name, a.discovered_at, a.first_seen, a.last_seen,
        a.test_status, a.priority, COALESCE(a.scope, (${SCOPE_SQL})) AS scope
      FROM asset a WHERE a.id IN (${ph}) ORDER BY a.discovered_at, a.id`).all(...assetsTouchedList)
      md.push('---', '')
      md.push("## 5. 附录", '')
      md.push("### 5.1 本报告涉及的资产（含发现时间）", '')
      md.push("| 资产 | 名称 | 内网/外网 | 发现时间 | 最近采集 |")
      md.push('| --- | --- | --- | --- | --- |')
      for (const a of rowsA) {
      md.push('| `' + (a.ip || '') + '` | ' + (a.primary_name || '—')
          + ' | ' + (a.scope === 'internal' ? "内网" : "外网")
          + ' | ' + (a.discovered_at ? String(a.discovered_at).replace('T', ' ').slice(0, 19) : '—')
          + ' | ' + (a.last_seen ? String(a.last_seen).replace('T', ' ').slice(0, 19) : '—') + ' |')
      }
      md.push('')
    }
    if (summary.serviceCapped.length > 0) {
      md.push("### 5.2 未计分的重复记录（服务已封顶）", '')
      md.push("| 目标 | 得分点 | 记录分值 | 记录时间 |", '| --- | --- | --- | --- |')
      for (const c of summary.serviceCapped) {
      md.push('| `' + (c.target || c.service || '') + '` | ' + (c.point_name || c.code) + ' | '
          + (c.points || 0) + ' | ' + String(c.recorded_at || '').replace('T', ' ').slice(0, 16) + ' |')
      }
      md.push('')
    }
    return { items: items2, stages, summary, markdown: md.join('\n'), target: targetName }
  }

  /**
   * 得分链路：把 score_hit 按时间拉平成一条链，只含"得分"相关的东西，不掺任何信息收集流水账。
   * 攻击链页面的「得分链路」视图用它。
   */
export function scoreChain(store, id, f = {}) {
  const db = store.db(id)
  const limit = Math.min(Number(f.limit) || 500, 2000)
  const items = db.prepare(`SELECT h.id, h.point_id, h.asset_id, h.vuln_id, h.step_id, h.target,
        h.evidence, h.note, h.self_created, h.port, h.recorded_by, h.recorded_at,
        p.code, p.name AS point_name, p.category, p.points AS point_default, p.points, p.enabled, h.points AS hit_points, h.multiplier, h.stage_code,
        a.ip AS asset_ip, v.title AS vuln_title, v.cve AS vuln_cve
      FROM score_hit h
      LEFT JOIN score_point p ON p.id = h.point_id
      LEFT JOIN asset a ON a.id = h.asset_id
      LEFT JOIN vuln v ON v.id = h.vuln_id
    ORDER BY h.recorded_at, h.id LIMIT ?`).all(limit)
  /* 每一步"靠什么动作拿到的"：① 显式关联的步骤 ② 同一资产上时间最近的步骤（标注为推断） */
  const stepById = new Map(db.prepare('SELECT id, seq, stage, title, detail, asset_id, point_id, recorded_at FROM attack_step').all().map((x) => [x.id, x]))
  const stepsByAsset = new Map()
  for (const st of stepById.values()) {
    if (st.asset_id === null || st.asset_id === undefined) continue
    if (!stepsByAsset.has(st.asset_id)) stepsByAsset.set(st.asset_id, [])
    stepsByAsset.get(st.asset_id).push(st)
  }
  for (const list of stepsByAsset.values()) list.sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)))
  for (const it of items) {
    let step = it.step_id !== null && it.step_id !== undefined ? stepById.get(it.step_id) : undefined
    let inferred = false
    if (step === undefined) {
      step = Array.from(stepById.values()).find((x) => x.point_id === it.point_id && x.asset_id === it.asset_id)
    }
    if (step === undefined && it.asset_id !== null && it.asset_id !== undefined) {
      const cands = (stepsByAsset.get(it.asset_id) || []).filter((x) => String(x.recorded_at) <= String(it.recorded_at))
      if (cands.length > 0) { step = cands[cands.length - 1]; inferred = true }
    }
    it.action = step === undefined ? null : { id: step.id, seq: step.seq, stage: step.stage, title: step.title, detail: step.detail }
    it.action_inferred = inferred
  }
  /* 计分口径（与 listScorePoints 完全一致，避免报表和面板分数对不上）：
     ① 自己注册/自建的账号不计分（只留过程）；
     ② 按得分点自带的 dedup_scope 去重（同目标/同系统/同服务只算最高那条，或按台卡数累加）；
     ③ 按 rule + cap 执行规则上限，超出部分不计分。 */
  const chainMeta = loadScoreMeta(db)
  const chainNames = loadAssetNames(db)
  /* 本条命中的实际分值：**命中自带档位优先**（合并版里同一条含多档，如管理员 50 / 普通 10）。
     scoreChain 的 SQL 用 hit_points / point_default 两个别名把两列分开取：直接取 h.points 会被
     同名的 p.points 遮蔽，攻击链页的档位判定会整个判反。 */
  const chainPointsOf = (it) => hitPointsOf({
    points: Number(it.hit_points) || Number(it.point_default) || 0,
    multiplier: it.multiplier,
    code: it.code,
  })
  const chainEval = evaluateScoreBoard(db, items.map((it) => Object.assign({}, it, { points: chainPointsOf(it) })),
    { meta: chainMeta, names: chainNames, enabledOnly: true })
  const cappedChain = { items: chainEval.items }
  const capFlagById = chainEval.byId
  const seenOf = new Map()
  for (const it of items) {
    it.self_created = Number(it.self_created) === 1
    const flag = capFlagById.get(it.id)
    it.capped = flag !== undefined && flag.capped === true
    it.port = normalizePort(it.port) ?? parseTargetPort(it.target)
    const meta = chainMeta.get(String(it.code)) || {}
    it.service = meta.dedup_scope === 'none' ? null : serviceLabel(it)
    it.capped_reason_kind = flag === undefined ? null : flag.capped_reason_kind
    it.rule = meta.rule ?? null
    it.rule_cap = meta.cap || 0
    /* 本条命中对外暴露的分值 = 命中自带档位分值，缺省回落到得分点默认值 */
    it.point_default = Number(it.point_default) || 0
    it.points = chainPointsOf(it)
    it.capped_reason = it.capped
      ? scoreCapReasonText(Object.assign({}, it, { rule_cap: meta.cap || 0 }), flag.capped_by_points)
      : null
    const seen = seenOf.get(it.point_id) || 0
    if (!it.self_created && !it.capped) seenOf.set(it.point_id, seen + 1)
    it.nth_of_point = seen + 1
    /* 停用得分点的命中不计分（与面板/报告口径一致：enabledOnly） */
    it.counted = it.self_created !== true && it.capped !== true && !chainEval.disabledIds.has(it.id)
  }
  /* 按得分点聚合出"哪些还没拿下"，方便一眼看出缺口 */
  const points = db.prepare('SELECT id, code, name, category, points, enabled FROM score_point ORDER BY sort_order, id').all()
  const hitPointIds = new Set(items.map((x) => x.point_id))
  const achieved = points.filter((p) => hitPointIds.has(p.id) && p.enabled === 1)
  const missing = points.filter((p) => !hitPointIds.has(p.id) && p.enabled === 1)
  /* ── 攻击链：按「攻击面位置」把得分串成五阶段，并给出累计分 ────────────── */
  const assetIds = Array.from(new Set(items.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
  const assetInfo = new Map()
  if (assetIds.length > 0) {
    const ph = assetIds.map(() => '?').join(',')
    const rows = db.prepare(`SELECT a.id, a.ip, a.segment_cidr, COALESCE(a.scope, (${SCOPE_SQL})) AS scope, a.state, a.priority,
          (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
          (SELECT COUNT(*) FROM vuln v WHERE v.asset_id = a.id AND v.status IN ('confirmed','exploited')) AS vulns
      FROM asset a WHERE a.id IN (${ph})`).all(...assetIds)
    for (const row of rows) assetInfo.set(row.id, row)
  }
  /* 每条得分落在哪个阶段：自动推导（显式 stage_code > 类型特判 > 资产内外网 > target 地址） */
  for (const it of items) {
    const info = it.asset_id !== null && it.asset_id !== undefined ? assetInfo.get(it.asset_id) : undefined
    it.stage_code = scoreStageOf(
      { stage_code: it.stage_code, code: it.code, target: it.target },
      info ? info.scope : undefined,
    )
  }
  const assetChip = (id) => {
    const a = assetInfo.get(id)
    if (a === undefined) return null
    return {
      id: a.id, ip: a.ip, segment_cidr: a.segment_cidr, scope: a.scope, state: a.state,
      priority: a.priority, open_ports: a.open_ports, vulns: a.vulns,
    }
  }
  /* 攻击步骤按阶段计数（攻击链只看"各阶段有多少动作"，不展开明细） */
  const stepsByStage = new Map()
  try {
    for (const row of db.prepare('SELECT stage, stage_code FROM attack_step LIMIT 5000').all()) {
      const code = row.stage_code || LEGACY_STAGE_MAP[row.stage] || 'recon'
      stepsByStage.set(code, (stepsByStage.get(code) || 0) + 1)
    }
  } catch { /* ignore */ }
  /* 会话隧道表的真实隧道：属于「边界突破」阶段的实锤 */
  let tunnels = []
  try {
    tunnels = db.prepare('SELECT id, kind, listen, entry, reach, entry_kind, status, note FROM tunnel ORDER BY id DESC LIMIT 50').all()
      .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
  } catch { tunnels = [] }
  /* 只有真正跨越靶标边界的隧道才算"边界突破"的实锤；自己 VPS/自建服务器上开的不算 */
  const legitTunnels = tunnels.filter((t) => t.legit === true)
  const selfOnlyTunnels = tunnels.filter((t) => t.legit === false)

  const stageDefs = store.listStages(id)
  let cumulative = 0
  const stages = stageDefs.map((st, si) => {
    const sItems = items.filter((x) => x.stage_code === st.code)
    const pts = sItems.reduce((n, x) => n + (x.counted ? (x.points || 0) : 0), 0)
    cumulative += pts
    /* 本阶段涉及的资产（去重）。信息收集阶段给"所有拿到分数的资产"，其余阶段给自己的 */
    const ids = st.code === 'recon'
      ? Array.from(new Set(items.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
      : Array.from(new Set(sItems.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
    const assets = ids.map(assetChip).filter(Boolean).map((a) => {
      const mine = items.filter((x) => x.asset_id === a.id)
      return Object.assign({}, a, {
        points: mine.reduce((n, x) => n + (x.counted ? (x.points || 0) : 0), 0),
        hits: mine.length,
        /* 该资产的分落在哪个阶段（同一资产可能被内外网两侧都打到） */
        stage_code: mine.length > 0 ? mine[0].stage_code : st.code,
      })
    }).sort((a, b) => b.points - a.points || b.hits - a.hits)
    return Object.assign({}, st, {
      ordinal: si + 1,
      items: sItems,
      hits: sItems.length,
      counted: sItems.filter((x) => x.counted).length,
      points: pts,
      cumulative: cumulative,
      assets: assets,
      assetCount: assets.length,
      tunnels: st.code === 'boundary' ? legitTunnels : [],
      tunnels_self_only: st.code === 'boundary' ? selfOnlyTunnels : [],
      steps: stepsByStage.get(st.code) || 0,
    })
  })

  const scores = store.listScorePoints(id)
  return {
    items,
    stages,
    achieved,
    missing,
    summary: {
      hits: items.length,
      /* 计分口径与得分面板一致：同类得分不设上限，按命中次数累加 */
      points: scores.summary.achievedPoints,
      totalPoints: scores.summary.totalPoints,
      countedHits: scores.summary.countedHits,
      achievedCount: achieved.length,
      missingCount: missing.length,
      missingPoints: missing.reduce((n, p) => n + (p.potential || p.points || 0), 0),
      selfCreatedHits: scores.summary.selfCreatedHits || 0,
      /* 同资产同端口重复命中、按服务封顶而不计分的条数（账号类 / 数据库权限） */
      serviceCappedHits: scores.summary.serviceCappedHits || 0,
      tunnelsLegit: legitTunnels.length,
      tunnelsSelfOnly: selfOnlyTunnels.length,
    },
  }
}

  /**
   * 给一批得分条目挂"代表截图"，**每个得分点最多 3 张**（批量得分点如终端权限会有几十条命中，
   * 逐条贴图既没信息量又把页面/报告撑爆）。
   *
   * 选取优先级：命中级 > 得分点+目标级 > 得分点级；同一优先级里现场截图优先于生成的证据卡。
   *
   * @param id - 靶标 id。
   * @param groups - `[{ point_id, point_code, hit_ids: number[], asset_id, target }]`
   * @param limit - 每个得分点最多几张（默认 3）。
   */
export function representativeShots(store, id, groups, limit = 3) {
  const db = store.db(id)
  let all = []
  try { all = db.prepare('SELECT * FROM shot ORDER BY captured_at, id').all() } catch { all = [] }
  if (all.length === 0) return new Map()
  const byHit = new Map()
  const byPoint = new Map()
  for (const sh of all) {
    if (sh.hit_id !== null && sh.hit_id !== undefined) {
      if (!byHit.has(Number(sh.hit_id))) byHit.set(Number(sh.hit_id), [])
      byHit.get(Number(sh.hit_id)).push(sh)
    }
    if (sh.point_id !== null && sh.point_id !== undefined) {
      if (!byPoint.has(Number(sh.point_id))) byPoint.set(Number(sh.point_id), [])
      byPoint.get(Number(sh.point_id)).push(sh)
    }
  }
  const rank = (sh) => (sh.kind === 'card' ? 1 : 0)
  const out = new Map()
  for (const g of groups) {
    /* 候选池按"关联强度"分层：命中级 → 目标/资产级 → 得分点级。
       同一层内**现场截图优先于生成的证据卡**，再按时间 —— 否则批量得分点里
       后补的卡片会把真截图挤出前 3 张（实测：60 台终端只挑出 3 张卡片）。 */
    const pool = []
    for (const hid of (g.hit_ids || [])) pool.push(...(byHit.get(Number(hid)) || []))
    const pointShots = byPoint.get(Number(g.point_id)) || []
    for (const sh of pointShots) {
      if (g.target && sh.target && String(sh.target) === String(g.target)) pool.push(sh)
      else if (g.asset_id !== null && g.asset_id !== undefined && sh.asset_id === g.asset_id) pool.push(sh)
    }
    for (const sh of pointShots) pool.push(sh)
    const picked = []
    const seen = new Set()
    const ordered = pool.slice().sort((a, b) => rank(a) - rank(b)
      || String(a.captured_at || '').localeCompare(String(b.captured_at || ''))
      || Number(a.id) - Number(b.id))
    for (const sh of ordered) {
      if (sh === undefined || sh === null || seen.has(sh.id)) continue
      seen.add(sh.id)
      picked.push(sh)
      if (picked.length >= limit) break
    }
    out.set(Number(g.point_id), picked)
  }
  return out
}
