// 演练台 64 个工具的 execute 业务分支：每条钉住一个工具真正返回什么。
//
// 为什么值得单独一个文件：`test-redteam-tools.mjs` 只覆盖了注册面、参数面、
// 绑定解析和并发闸门；64 个工具里绝大多数是
//   resolveEngagement → store.X(...) → JSON.stringify
// 的薄壳，行覆盖长期停在 77%。薄壳本身没什么逻辑，但**壳里塞进去的参数**
// 决定了库里到底写了什么：把 `args.asset_id` 写成 `args.id`、把 limit 忘了夹、
// 把 `entry_kind` 直接透传，症状都是「工具返回 ok:true，但数据是错的或空的」，
// 模型完全看不出来。所以这里全部断言真实取值，而不是 `ok === true`。
//
// 靶标隔离提醒：`resolveEngagement` 的绑定表是**模块级 Map**，且全局「当前靶标」
// 被别的会话占用时会直接报错。所以每个用例都 `openEngagement(..., { bindCurrent: false })`
// （不写全局指针，走「只有一个靶标就自动绑定」那条路），并且每个用例一个新会话 id。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/redteam/tools.js'
import { RedteamStore } from '../lib/redteam/store-core.js'

/** 用例序号：每个用例一个独立靶标名。靶标 id 是名字的 slug，重名会让
 *  模块级绑定表里别的会话"占着"同一个靶标，后面的用例全部被拒（实测踩过）。 */
let engagementSeq = 0
/** skills 桩要用到临时目录，但它在 withStore 之外构造（作为 extra 注入）→ 先声明后赋值。 */
let skRoot = ''

/** 每个用例一份临时 root + 一份靶标库；`bindCurrent:false` 见文件头。 */
async function withStore(fn, options = {}) {
  engagementSeq += 1
  const root = mkdtempSync(join(tmpdir(), 'dsh-purge-branch-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'dshhome')
  let store
  try {
    mkdirSync(process.env.DSH_HOME, { recursive: true })
    store = new RedteamStore(root)
    const opened = store.openEngagement(`分支靶标-${engagementSeq}`, ['10.0.0.0/24'], { bindCurrent: false })
    const exec = nextExec()
    const byName = build({ redteam: store, ...(options.extra || {}) })
    const call = async (name, args = {}) => {
      const tool = byName[name]
      assert.ok(tool, `工具 ${name} 没注册`)
      const out = await tool.execute(args, exec)
      assert.equal(typeof out, 'string', `${name} 必须返回字符串`)
      return JSON.parse(out)
    }
    return await fn({ root, store, engagement: opened.id, byName, call })
  } finally {
    try { store && store.close() } catch { /* 已关 */ }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows EPERM */ }
  }
}

/** 注册全部工具，返回 name → tool。`extra` 用来塞 skills 服务之类的注入。 */
function build(extra = {}) {
  const registered = []
  const ctx = {
    defineTool: (spec) => spec,
    tools: { register: (t) => registered.push(t) },
    effect: () => () => {},
    on: () => () => {},
    get: () => undefined,
    logger: { warn: () => {} },
    ...extra,
  }
  apply(ctx)
  return Object.fromEntries(registered.map((t) => [t.name, t]))
}

/** 每个用例一个新会话 id：绑定表是模块级的，共用会串状态。 */
let sessionSeq = 0
const nextExec = () => {
  sessionSeq += 1
  return { agent: { session: { id: `branch-${sessionSeq}` } } }
}

/** 造一份带端口/服务/域名的资产，web_list 与 domain_index 都要它。 */
function seedWeb(store, engagement) {
  store.importBundle(engagement, {
    scan: { tool: 'httpx', argv: ['httpx'] },
    segments: [{ cidr: '10.0.0.0/24', source: 'active' }],
    assets: [{
      ip: '10.0.0.5',
      primary_name: 'www.example.test',
      state: 'live',
      ports: [
        { port: 80, service: 'http' },
        { port: 443, service: 'https', product: 'nginx', version: '1.24' },
        { port: 8080, title: 'Tomcat' },
        { port: 8443, url: 'https://10.0.0.5:8443/admin', title: 'Admin' },
        { port: 3306 },
      ],
      names: [{ name: 'www.example.test' }],
    }],
  })
}

/* ==================================================== 资产面 */

test('asset_add 返回紧凑资产与发现时间，重复采集只刷新 last_seen', async () => {
  await withStore(async ({ store, engagement, call }) => {
    /* 先塞一条别的资产：工具回给模型的必须是「刚写入的这一条」，而不是库里随便一条。
       只放一条资产时，取回哪条都一样，把 ip 过滤去掉也测不出来。
       注意 counts 是这一次 importBundle 的增量，不是库里的总数。 */
    await call('redteam_asset_add', { ip: '10.0.0.1', tool: 'nmap' })
    const first = await call('redteam_asset_add', { ip: '10.0.0.5', hostname: 'www.example.test', tool: 'nmap' })
    assert.equal(first.ok, true)
    assert.equal(first.engagement, engagement)
    assert.equal(first.counts.assets, 1)
    assert.equal(first.asset.ip, '10.0.0.5')
    assert.equal(first.asset.segment, '10.0.0.0/24')
    assert.equal(first.asset.state, 'unknown')
    assert.equal(first.asset.test_status, 'untested')
    assert.equal(first.asset.name, null)
    assert.deepEqual(first.asset.names, [])
    assert.deepEqual(first.asset.ports, [])
    assert.equal(first.discovered_at, first.asset.discovered_at)
    assert.match(first.hint, new RegExp(`发现时间已记为 ${first.discovered_at.replace(/[.]/g, '\\.')}`))

    const again = await call('redteam_asset_add', { ip: '10.0.0.5', tool: 'nmap' })
    /* 发现时间不动、last_seen 前进：这是 hint 承诺的语义，改坏了界面上的时间线就错位 */
    assert.equal(again.discovered_at, first.discovered_at)
    assert.ok(again.asset.last_seen >= first.asset.last_seen)
    assert.equal(again.counts.assets, 1, '同一 IP 再采一次不应变成两条资产')
  })
})

test('asset_query 的 limit 夹在 200 以内，total 与 returned 分开报', async () => {
  await withStore(async ({ store, engagement, call }) => {
    /* 灌 250 条：只有超过 200 才能证明 limit 真的被夹住（store 层不夹，夹取只在工具层）。
       cidr 过滤是「分段相等」不是「落在网段内」——资产按 IP 自动落到 10.9.0.0/24，
       所以这里必须用 /24 去筛，写 /16 会一条都命中不了。 */
    const assets = []
    for (let i = 1; i <= 250; i += 1) assets.push({ ip: `10.9.0.${i}` })
    store.importBundle(engagement, { segments: [{ cidr: '10.9.0.0/24', source: 'active' }], assets })
    const all = await call('redteam_asset_query', { cidr: '10.9.0.0/24', limit: 9999 })
    assert.equal(all.total, 250, 'total 是命中总数，不受 limit 影响')
    assert.equal(all.returned, 200, 'limit 传 9999 也只回 200 条')
    assert.equal(all.items.length, 200)
    const one = await call('redteam_asset_query', { cidr: '10.9.0.0/24', limit: 1 })
    assert.equal(one.total, 250)
    assert.equal(one.returned, 1)
    const dflt = await call('redteam_asset_query', { cidr: '10.9.0.0/24' })
    assert.equal(dflt.returned, 50, '不给 limit 时默认 50')
  })
})

test('asset_get 命中给完整行，落空给「资产不存在」', async () => {
  await withStore(async ({ store, call }) => {
    const added = await call('redteam_asset_add', { ip: '10.0.0.5', tool: 'nmap' })
    const got = await call('redteam_asset_get', { id: added.asset.id })
    assert.equal(got.ok, true)
    assert.equal(got.asset.ip, '10.0.0.5')
    assert.equal(got.asset.segment_cidr, '10.0.0.0/24')
    assert.equal(got.asset.scope, 'internal')
    assert.equal(got.asset.open_ports, 0)
    assert.deepEqual(got.asset.edges, [])
    const missing = await call('redteam_asset_get', { id: 99999 })
    assert.deepEqual(missing, { ok: false, error: '资产不存在' })
  })
})

test('asset_stats 同时给计数与分段清单', async () => {
  await withStore(async ({ store, call }) => {
    await call('redteam_asset_add', { ip: '10.0.0.5', tool: 'nmap' })
    const stats = await call('redteam_asset_stats', {})
    assert.equal(stats.ok, true)
    assert.equal(stats.stats.assets, 1)
    assert.equal(stats.stats.segments, 1)
    assert.equal(stats.stats.untestedAssets, 1)
    assert.equal(stats.segments.length, 1)
    assert.equal(stats.segments[0].cidr, '10.0.0.0/24')
    assert.equal(stats.segments[0].assets, 1)
    assert.equal(stats.segments[0].scope, 'internal')
  })
})

test('asset_graph 超限时把分段清单一起回给模型去缩小范围', async () => {
  await withStore(async ({ store, engagement, call }) => {
    await call('redteam_asset_add', { ip: '10.0.0.5', tool: 'nmap' })
    const ok = await call('redteam_asset_graph', {})
    assert.equal(ok.ok, true)
    assert.ok(ok.nodes.some((n) => n.kind === 'segment' && n.label === '10.0.0.0/24'))
    assert.ok(ok.nodes.some((n) => n.kind === 'asset' && n.label === '10.0.0.5'))
    assert.ok(ok.edges.some((e) => e.relation === 'contains'))
    /* 小图超限：maxNodes 传 1 时任何图都超 */
    const over = await call('redteam_asset_graph', { maxNodes: 1 })
    assert.equal(over.ok, false)
    assert.equal(over.error, `图谱节点过多（${ok.nodes.length} > 1），请指定 cidr 缩小范围`)
    assert.equal(over.segments[0].cidr, '10.0.0.0/24')
    assert.equal(over.segments[0].assets, 1)

    /* maxNodes 的夹取上限 1000：只有图本身超过 1000 个节点时，传 2000 才测得出来。
       不夹的话 1106 <= 2000 会正常返回，夹到 1000 才会报超限。
       注意不能带 cidr：带上 cidr 时 graph 只回那一个分段节点（实测 1100 条资产 + cidr 过滤 = 1 个节点）。 */
    const assets = []
    for (let i = 1; i <= 1100; i += 1) assets.push({ ip: `10.8.${Math.floor((i - 1) / 250)}.${((i - 1) % 250) + 1}` })
    store.importBundle(engagement, { segments: [{ cidr: '10.8.0.0/16', source: 'active' }], assets })
    const big = await call('redteam_asset_graph', { maxNodes: 2000 })
    assert.equal(big.ok, false, 'maxNodes 传 2000 会被夹到 1000，图超过 1000 就必须报超限')
    assert.match(big.error, / > 1000），请指定 cidr 缩小范围$/)
  })
})

test('attack_path 导出攻击图谱，标出已控制资产，节点过多时按 maxNodes 夹取', async () => {
  await withStore(async ({ store, engagement, call }) => {
    const a = await call('redteam_asset_add', { ip: '10.0.0.5', tool: 'nmap' })
    await call('redteam_access_add', { host: '10.0.0.5', asset_id: a.asset.id, method: 'ssh', privilege: 'admin' })
    const path = await call('redteam_attack_path', {})
    assert.equal(path.ok, true)
    assert.equal(path.engagement, engagement)
    /* owned 是「已经在手里的资产」，横向移动的起点。丢了它这张图就只是拓扑，不是攻击路径。 */
    assert.deepEqual(path.owned, ['10.0.0.5'], '拿到 access 的资产必须出现在 owned 里')
    assert.ok(path.nodes.length >= 2, '至少一个分段节点 + 一个资产节点')
    assert.ok(path.edges.length >= 1)
    assert.equal(typeof path.summary.total, 'number')

    /* maxNodes 默认 400、上限 1500：传 0 走默认（不是回 0 个节点），传 99999 被夹到 1500。 */
    const zero = await call('redteam_attack_path', { maxNodes: 0 })
    assert.equal(zero.ok, true, 'maxNodes=0 是假值，回落默认 400 而不是把图清空')

    /* attack_path 的上限是 1500（不是 asset_graph 的 1000），所以这里要灌到 1500 以上。 */
    const assets = []
    for (let i = 1; i <= 1600; i += 1) assets.push({ ip: `10.7.${Math.floor((i - 1) / 250)}.${((i - 1) % 250) + 1}` })
    store.importBundle(engagement, { segments: [{ cidr: '10.7.0.0/16', source: 'active' }], assets })
    const over = await call('redteam_attack_path', { maxNodes: 2000 })
    assert.equal(over.ok, false, 'maxNodes 传 2000 会被夹到 1500，图超过 1500 就必须报超限')
    assert.match(over.error, / > 1500），请指定 cidr 缩小范围$/)
    assert.equal(typeof over.summary.total, 'number', '超限时也要把 summary 回给模型判断规模')
    assert.equal(over.nodes, undefined, '超限时不回节点，避免把上万行塞进上下文')
  })
})

test('http_evidence_add 落一条原始报文，返回新记录 id', async () => {
  await withStore(async ({ store, engagement, call }) => {
    const added = await call('redteam_http_evidence_add', {
      label: '越权读取用户列表',
      method: 'POST',
      url: 'http://10.0.0.5:8080/api/users',
      status: 200,
      request: 'POST /api/users HTTP/1.1\\r\\nHost: 10.0.0.5:8080\\r\\n\\r\\n{"page":1}',
      response: '{"total":2}',
      note: '未带 token 也能读',
      captured_by: 'exploit',
    })
    assert.equal(added.ok, true)
    assert.equal(added.engagement, engagement)
    assert.equal(added.id, 1)
    /* 必须真的落库：报告要靠它渲染成能粘进 Burp 的原始报文 */
    const rows = store.listHttpEvidence(engagement, {})
    assert.equal(rows.length, 1)
    assert.equal(rows[0].method, 'POST')
    assert.equal(rows[0].status, 200)
    assert.equal(rows[0].label, '越权读取用户列表')
    assert.match(rows[0].request, /^POST \/api\/users HTTP\/1\.1/)
    assert.equal(rows[0].captured_by, 'exploit')
    assert.ok(rows[0].captured_at)
  })
})

test('poc_add 把来源靶标的名称补全成 id + 中文名，查不到就原样记下', async () => {
  await withStore(async ({ store, engagement, call }) => {
    const known = await call('redteam_poc_add', {
      title: 'Tomcat 弱口令 CVE-2020-1938', content: 'print(1)', language: 'python',
      category: 'weak-password', engagement: '分支靶标',
    })
    assert.equal(known.ok, true)
    /* 只给了一个名字片段：必须补成完整靶标名，而不是把片段当名字记下来 */
    const row = store.getPoc(known.code)
    assert.equal(row.engagement_id, engagement, '片段要解析回真实靶标 id')
    assert.match(row.engagement_name, /^分支靶标-\d+$/, '名称补全成完整靶标名，不是传进来的片段')
    assert.equal(known.engagement, row.engagement_name)

    const unknown = await call('redteam_poc_add', {
      title: 'Struts2 S2-045', content: 'x', category: 'rce', engagement: '某个已经不存在的靶标',
    })
    assert.equal(unknown.ok, true, '来源靶标查不到不能挡住入库，知识本来就是跨靶标复用的')
    assert.equal(unknown.engagement, '某个已经不存在的靶标', '查不到就原样记下，别丢')
    /* 两列都要落：只留 engagement_name 时面板按 id 检索就找不到这条来源 */
    const urow = store.getPoc(unknown.code)
    assert.equal(urow.engagement_id, '某个已经不存在的靶标')
    assert.equal(urow.engagement_name, '某个已经不存在的靶标')
  })
})

test('asset_timeline 按天聚合，并说明发现时间的含义', async () => {
  await withStore(async ({ store, call }) => {
    await call('redteam_asset_add', { ip: '10.0.0.5', tool: 'nmap' })
    const tl = await call('redteam_asset_timeline', {})
    assert.equal(tl.ok, true)
    assert.equal(tl.span.total, 1)
    assert.equal(tl.days.length, 1)
    assert.equal(tl.days[0].assets, 1)
    assert.equal(tl.days[0].internal, 1)
    assert.equal(tl.days[0].external, 0)
    assert.equal(tl.recent[0].ip, '10.0.0.5')
    assert.equal(tl.recent[0].scope, 'internal')
    assert.match(tl.hint, /重复采集只刷新 last_seen/)
  })
})

test('asset_link 把边数回报给模型', async () => {
  await withStore(async ({ store, call }) => {
    const a = await call('redteam_asset_add', { ip: '10.0.0.5', tool: 'nmap' })
    const b = await call('redteam_asset_add', { ip: '10.0.0.6', tool: 'nmap' })
    const linked = await call('redteam_asset_link', {
      src_kind: 'asset', src_id: String(a.asset.id), dst_kind: 'asset', dst_id: String(b.asset.id), relation: 'peer',
    })
    assert.equal(linked.ok, true)
    assert.equal(linked.edges, 1)
  })
})

test('asset_test 与 asset_assess 用 ip 或 asset_id 都能定位，定位不到给参数提示', async () => {
  await withStore(async ({ store, call }) => {
    const added = await call('redteam_asset_add', { ip: '10.0.0.7', tool: 'nmap' })
    const byIp = await call('redteam_asset_test', {
      ip: '10.0.0.7', status: 'testing', test: 'nmap 全端口', surface: 'SMB 445 未测', blocked: true, updated_by: 'recon',
    })
    assert.equal(byIp.ok, true)
    assert.equal(byIp.asset_id, added.asset.id)
    assert.equal(byIp.status, 'testing')
    assert.equal(byIp.blocked_count, 1, 'blocked=true 时封禁计数 +1')
    /* 追加式：每行带 [时间戳] 前缀。少了前缀就分不清哪次测的，历史会被"记一行"悄悄冲掉。 */
    assert.match(byIp.test_notes, /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] nmap 全端口$/)
    assert.match(byIp.surface, /SMB 445/)
    const byId = await call('redteam_asset_test', { asset_id: added.asset.id, status: 'tested', test: '复测' })
    assert.equal(byId.asset_id, added.asset.id)
    const lines = byId.test_notes.split('\n')
    assert.equal(lines.length, 2, '第二次测试是追加一行，不是覆盖')
    assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] nmap 全端口$/)
    assert.match(lines[1], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] 复测$/)

    const assessed = await call('redteam_asset_assess', {
      ip: '10.0.0.7', priority: 'high', potential: '账号权限+RCE', reason: 'nginx 1.24 命中 Nday', assessed_by: 'recon',
    })
    assert.equal(assessed.ok, true)
    assert.equal(assessed.priority, 'high')
    assert.equal(assessed.potential, '账号权限+RCE')
    assert.equal(assessed.ip, '10.0.0.7')
    assert.ok(assessed.assessed_at)

    const bad = await call('redteam_asset_test', { status: 'testing' })
    assert.equal(bad.ok, false)
    assert.equal(bad.error_kind, 'bad_input')
    assert.equal(bad.error, 'asset not found（请传 asset_id 或 ip）')
  })
})

/* ==================================================== 漏洞 / 凭据 / 权限 */

test('vuln_add/query/update 都把最新统计一起回给模型', async () => {
  await withStore(async ({ store, call }) => {
    const added = await call('redteam_vuln_add', {
      title: 'CVE-2021-44228 Log4j RCE', severity: 'critical', status: 'confirmed', evidence: '回显 uid=0',
    })
    assert.equal(added.ok, true)
    assert.equal(added.updated, false)
    assert.equal(added.stats.total, 1)
    assert.equal(added.stats.bySeverity.critical, 1)
    assert.equal(added.stats.byStatus.confirmed, 1)

    const queried = await call('redteam_vuln_query', {})
    assert.equal(queried.total, 1)
    assert.equal(queried.items[0].title, 'CVE-2021-44228 Log4j RCE')
    assert.equal(queried.stats.total, 1)

    const updated = await call('redteam_vuln_update', { id: added.id, status: 'exploited' })
    assert.equal(updated.ok, true)
    assert.equal(updated.updated, true)
    assert.equal(updated.stats.byStatus.exploited, 1)
    assert.equal(updated.stats.byStatus.confirmed, undefined, '状态是覆盖不是累加')
  })
})

test('credential_add/list 与 access_add/list 各走各的表', async () => {
  await withStore(async ({ store, call }) => {
    const cred = await call('redteam_credential_add', { host: '10.0.0.5', username: 'admin', password: 'p@ss' })
    assert.equal(cred.ok, true)
    const creds = await call('redteam_credential_list', {})
    assert.equal(creds.items.length, 1)
    assert.equal(creds.items[0].host, '10.0.0.5')
    assert.equal(creds.items[0].username, 'admin')
    assert.equal(creds.items[0].secret_value, 'p@ss')

    const acc = await call('redteam_access_add', { host: '10.0.0.5', username: 'root', privilege: 'admin', method: 'ssh' })
    assert.equal(acc.ok, true)
    const accs = await call('redteam_access_list', {})
    assert.equal(accs.items.length, 1)
    assert.equal(accs.items[0].privilege, 'admin')
    assert.equal(accs.items[0].method, 'ssh')
    assert.equal(creds.items.length, 1, 'access 写入不应污染凭据表')
  })
})

test('role_prompt 只认真实角色名，未知角色回 ok:false 而不是抛错', async () => {
  await withStore(async ({ store, call }) => {
    const plan = await call('redteam_role_prompt', { role: 'plan' })
    assert.equal(plan.ok, true)
    assert.equal(plan.role, 'plan')
    assert.equal(plan.title, '主会话（指挥）')
    /* 必须是正文，不是标题：把 prompt 换成 title 时这一条要红 */
    assert.match(plan.prompt, /^# 主会话（红队指挥）/)
    assert.ok(plan.prompt.length > 1000, '角色稿是完整提示词正文，不是一行标题')
    assert.ok(plan.updated_at)

    /* `planner` 是常见误写：必须回 ok:false + 「未知角色」，不能静默回空正文 */
    const wrong = await call('redteam_role_prompt', { role: 'planner' })
    assert.deepEqual(wrong, { ok: false, error: '未知角色' })

    const reset = await call('redteam_role_prompt_reset', { role: 'plan' })
    assert.equal(reset.ok, true)
    const thrown = await call('redteam_role_prompt_reset', { role: 'planner' })
    assert.equal(thrown.ok, false)
    assert.equal(thrown.error_kind, 'failed')
    assert.match(thrown.error, /unknown role: planner/)
  })
})

test('sessions 把 webshell/隧道投影成模型可读的形状，并带上边界突破口径', async () => {
  await withStore(async ({ store, call }) => {
    await call('redteam_webshell_add', { url: 'http://10.0.0.5/shell.php', pass_key: 'k', shell_type: 'behinder' })
    await call('redteam_tunnel_add', {
      kind: 'socks5', listen: '127.0.0.1:1080', entry: '10.0.0.5:22', entry_kind: 'target-outbound',
    })
    const s = await call('redteam_sessions', {})
    assert.equal(s.ok, true)
    assert.equal(s.totals.webshells, 1)
    assert.equal(s.totals.webshellsOnline, 1)
    assert.equal(s.totals.tunnels, 1)
    assert.equal(s.totals.tunnelsActive, 1)
    assert.equal(s.totals.tunnelsLegit, 1)
    assert.equal(s.webshells[0].url, 'http://10.0.0.5/shell.php')
    assert.equal(s.webshells[0].type, 'behinder')
    assert.equal(s.tunnels[0].entry_kind, 'target-outbound')
    assert.equal(s.tunnels[0].legit, true)
    assert.match(s.hint, /legit=false/)
    assert.match(s.hint, /legit=null 表示未声明 entry_kind/)
  })
})

test('webshell_add 一律写 online，webshell_update 只改传进来的字段', async () => {
  await withStore(async ({ store, call }) => {
    const added = await call('redteam_webshell_add', { url: 'http://10.0.0.5/s.php', pass_key: 'k' })
    assert.equal(added.ok, true)
    assert.equal(added.updated, false)
    const listed = await call('redteam_webshell_list', {})
    /* 工具层显式写了 status:'online'，但 store 层的 normalizeShellStatus('') 默认也给 online，
       所以这条断言钉的是「登记后就是 online」这个结果，不是那行字面量本身 —— 改坏了不可观测。 */
    assert.equal(listed.items[0].status, 'online', '刚登记的 webshell 先按 online 处理')
    assert.equal(listed.items[0].asset_ip, null, '没挂资产时 asset_ip 是 null 不是空串')

    const updated = await call('redteam_webshell_update', { id: added.id, note: '换了个马' })
    assert.equal(updated.ok, true)
    assert.equal(updated.updated, true)
    const after = await call('redteam_webshell_list', {})
    assert.equal(after.items[0].note, '换了个马')
    assert.equal(after.items[0].url, 'http://10.0.0.5/s.php', '只改 note，不该动 url')
  })
})

test('tunnel_add 拒绝非法 entry_kind，合法值才写库并标出 legit', async () => {
  await withStore(async ({ store, call }) => {
    const bad = await call('redteam_tunnel_add', {
      kind: 'socks5', listen: '127.0.0.1:1080', entry: '10.0.0.5:22', entry_kind: 'target-side',
    })
    assert.equal(bad.ok, false)
    assert.equal(bad.error_kind, 'bad_input')
    assert.match(bad.error, /entry_kind 非法/)
    assert.match(bad.error, /target-outbound \/ target-http \/ target-agent \/ self-only/)

    const selfOnly = await call('redteam_tunnel_add', {
      kind: 'socks5', listen: '127.0.0.1:1081', entry: '1.2.3.4:22', entry_kind: 'self-only',
    })
    assert.equal(selfOnly.ok, true)
    const listed = await call('redteam_tunnel_list', {})
    assert.equal(listed.items.length, 1, '非法那条不该落库')
    assert.equal(listed.items[0].entry_kind, 'self-only')
    assert.equal(listed.items[0].legit, false, 'self-only 不算跨越靶标边界')
    assert.match(listed.items[0].entry_kind_label, /只在自己 VPS/)

    const updated = await call('redteam_tunnel_update', { id: selfOnly.id, entry_kind: 'target-agent' })
    assert.equal(updated.ok, true)
    const after = await call('redteam_tunnel_list', {})
    assert.equal(after.items[0].legit, true, '补上目标侧那一端之后才算突破')
  })
})

test('session_check 汇总在线数与可用数，探测不通就如实标 offline/down', async () => {
  await withStore(async ({ store, call }) => {
    await call('redteam_webshell_add', { url: 'http://127.0.0.1:9/never.php', pass_key: 'k' })
    await call('redteam_tunnel_add', {
      kind: 'socks5', listen: '127.0.0.1:9', entry: '10.0.0.5:22', entry_kind: 'target-outbound',
    })
    const checked = await call('redteam_session_check', { timeoutMs: 400 })
    assert.equal(checked.ok, true)
    assert.equal(checked.summary, `WebShell 在线 0/${checked.webshells.length}，隧道可用 0/${checked.tunnels.length}`)
    assert.equal(checked.webshells[0].status, 'offline')
    assert.equal(checked.tunnels[0].status, 'down')
    assert.ok(checked.checked_at)
    /* 结果要回写库：面板与下一次 sessions 读的是库里的 status */
    const listed = await call('redteam_webshell_list', {})
    assert.equal(listed.items[0].status, 'offline')
  })
})

/* ==================================================== 站点与域名 */

test('web_list 拼 URL 时按端口决定协议与是否带端口，service 是三个字段拼接', async () => {
  await withStore(async ({ store, engagement, call }) => {
    seedWeb(store, engagement)
    const web = await call('redteam_web_list', {})
    assert.equal(web.total, 4, '3306 不在 Web 端口白名单里，不该出现')
    const byPort = Object.fromEntries(web.items.map((x) => [x.port, x]))
    assert.equal(byPort[80].url, 'http://10.0.0.5', '80 不写端口')
    assert.equal(byPort[443].url, 'https://10.0.0.5', '443 不写端口但走 https')
    assert.equal(byPort[8080].url, 'http://10.0.0.5:8080')
    assert.equal(byPort[8443].url, 'https://10.0.0.5:8443/admin', '有 url 就用 url 原值')
    assert.equal(byPort[443].service, 'https nginx 1.24', 'service/product/version 按空格拼')
    assert.equal(byPort[8080].service, '', '三个都空时是空串不是 null')
    assert.equal(byPort[8080].title, 'Tomcat')

    assert.equal((await call('redteam_web_list', { cidr: '10.9.9.0/24' })).total, 0)
    assert.equal((await call('redteam_web_list', { limit: 1 })).items.length, 1)
  })
})

test('domain_index 把域名与它指向的资产归到一起', async () => {
  await withStore(async ({ store, engagement, call }) => {
    seedWeb(store, engagement)
    const idx = await call('redteam_domain_index', {})
    assert.equal(idx.ok, true)
    assert.equal(idx.items.length, 1)
    assert.equal(idx.items[0].domain, 'www.example.test')
    assert.equal(idx.items[0].count, 1)
    assert.equal(idx.items[0].assets[0].ip, '10.0.0.5')
  })
})

/* ==================================================== 计分 */

test('score_list 的 groups 与 items 都是投影后的形状，evidence 取前三条', async () => {
  await withStore(async ({ store, call }) => {
    const listed = await call('redteam_score_list', {})
    assert.equal(listed.ok, true)
    assert.equal(listed.summary.pointCount, 25)
    assert.ok(listed.groups.length >= 8)
    assert.deepEqual(Object.keys(listed.groups[0]).sort(), ['cap_sum', 'category', 'items', 'points'])
    /* groups 里 items 是「该组的档位数」、points 是该组已得分（不是分值）；
       写成 points: g.tiers.length 会把档位数当成分数，所以这里钉住两组的真实取值。 */
    const general = listed.groups.find((g) => g.category === '控制一般系统')
    assert.equal(general.items, 4, '控制一般系统有 4 个档位')
    assert.equal(general.points, 0, '还没得分时是 0，不是档位数')
    assert.equal(general.cap_sum, 2000)
    const netinfra = listed.groups.find((g) => g.category === '控制网络基础设施')
    assert.equal(netinfra.items, 8)
    assert.equal(netinfra.cap_sum, 18000)
    const item = listed.items.find((x) => x.code === 'terminal-access')
    assert.equal(item.points, 10)
    assert.equal(item.cap, 600)
    assert.equal(item.dedup_scope, 'system')
    assert.equal(item.achieved, false)
    assert.equal(item.hits, 0)
    assert.deepEqual(item.evidence, [])

    await call('redteam_score_hit', { point_id: item.id, evidence: '回显 uid=0', target: '10.0.0.5' })
    const after = await call('redteam_score_list', {})
    const hit = after.items.find((x) => x.code === 'terminal-access')
    assert.equal(hit.achieved, true)
    assert.equal(hit.hits, 1)
    assert.equal(hit.earned, 10)
    assert.deepEqual(hit.evidence, ['10.0.0.5：回显 uid=0'], '有 target 时前面拼「目标：」')
  })
})

test('score_hit 回基础分/倍数/实得分，旧 code 给迁移提示', async () => {
  await withStore(async ({ store, call }) => {
    const hit = await call('redteam_score_hit', {
      point_id: 2, evidence: '回显 uid=0', target: '10.0.0.5', port: 8443,
    })
    assert.equal(hit.ok, true)
    assert.equal(hit.base_points, 10)
    assert.equal(hit.multiplier, 1)
    assert.equal(hit.points, 10)
    assert.equal(hit.counted, true)
    assert.equal(hit.port, 8443)
    assert.equal(hit.service, '10.0.0.5:8443', 'service 是「目标:端口」，用于同服务封顶')
    assert.equal(hit.summary.achievedPoints, 10)

    const legacy = await call('redteam_score_hit', { point_code: 'webshell', evidence: 'e' })
    assert.equal(legacy.ok, false)
    assert.equal(legacy.error_kind, 'bad_input')
    assert.match(legacy.error, /已按《突破入侵类得分规则（合并版）》重构为 25 项/)
  })
})

test('score_point_save 建自建得分点，明确标 builtin=false 且不受旧体系清理', async () => {
  await withStore(async ({ store, call }) => {
    const saved = await call('redteam_score_point_save', {
      code: 'custom-intranet', name: '内网横向控制', category: 'INTERNAL', points: 50,
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.builtin, false)
    assert.equal(saved.overridden, true)
    assert.equal(saved.points, 50)
    assert.match(saved.note, /已新增自建得分点/)
    const listed = await call('redteam_score_list', {})
    const mine = listed.items.find((x) => x.code === 'custom-intranet')
    assert.equal(mine.points, 50)
  })
})

test('attack_chain 的 totals 与 stages 形状，非法 stage_code 回落到 recon 并说明', async () => {
  await withStore(async ({ call }) => {
    const good = await call('redteam_chain_add', { stage_code: 'recon', action: '资产测绘', tool: 'fscan', result: 'open 80' })
    assert.equal(good.stage_code, 'recon')
    assert.equal(good.stage_hint, null, '合法 stage_code 不该有 stage_hint')
    const bad = await call('redteam_chain_add', { stage_code: 'not-a-stage', action: '乱写' })
    /* 现状：非法 stage_code 不是「丢到 other」，而是**回落 recon 并给出 stage_hint**。
       改坏了的表现是这一步静默消失（报告里少一条），所以必须钉住回落 + 提示文案。 */
    assert.equal(bad.stage_code, 'recon')
    assert.match(bad.stage_hint, /stage_code="not-a-stage" 非法（已忽略）/)
    assert.match(bad.stage_hint, /只接受 recon\/internet\/boundary\/internal\/target/)

    const chain = await call('redteam_attack_chain', {})
    assert.equal(chain.ok, true)
    assert.deepEqual(Object.keys(chain.totals).sort(), ['hits', 'points', 'serviceCappedHits'])
    assert.equal(chain.totals.points, 0)
    const recon = chain.stages.find((s) => s.code === 'recon')
    assert.equal(recon.steps, 2, '两条都落到 recon（合法那条 + 回落那条）')
    assert.equal(recon.goal.length > 0, true)
    assert.ok(recon.methods.length > 0)
    assert.match(recon.methods[0], /：/, 'methods 是「标题：条目1、条目2」')
    assert.deepEqual(recon.scored, [])
    assert.equal(chain.stages.filter((s) => s.code !== 'recon').every((s) => s.steps === 0), true)
    assert.match(chain.hint, /stage_code（只接受 recon\/internet\/boundary\/internal\/target）/)
  })
})

test('score_report 默认给 markdown，markdown=false 时给可筛的条目', async () => {
  await withStore(async ({ store, call }) => {
    await call('redteam_score_hit', { point_id: 2, evidence: '回显 uid=0', target: '10.0.0.5' })
    const full = await call('redteam_score_report', {})
    assert.equal(full.ok, true)
    assert.equal(full.summary.count, 1)
    assert.equal(full.summary.points, 10)
    assert.match(full.markdown, /红队成果复现报告/)
    assert.equal(full.items, undefined, '默认模式不返回 items')

    const lean = await call('redteam_score_report', { markdown: false })
    assert.equal(lean.markdown, undefined)
    assert.equal(lean.items.length, 1)
    assert.equal(lean.items[0].seq, 1)
    assert.equal(lean.items[0].points, 10)
    assert.equal(lean.items[0].requests, 0, 'requests 是条数不是数组')
    assert.equal(lean.items[0].missing_evidence, true, '没请求也没证据时必须标出来')
  })
})

test('score_report 的 limit 真的传给 store.scoreReport（两条成果时只回一条）', async () => {
  await withStore(async ({ store, call }) => {
    /* 两条不同得分点，各自一条 hit：不传 limit 时两条都进报告，limit:1 时只剩第一条。
       这里必须造两条 —— 只有一条时「传了 limit」与「没传」产出完全相同，测不出漏传。 */
    await call('redteam_score_hit', { point_id: 2, evidence: '回显 uid=0', target: '10.0.0.5' })
    await call('redteam_score_hit', { point_id: 3, evidence: 'root 登录成功', target: '10.0.0.6' })

    const all = await call('redteam_score_report', { markdown: false })
    assert.equal(all.summary.count, 2)
    assert.deepEqual(all.items.map((x) => x.seq), [1, 2])

    const one = await call('redteam_score_report', { markdown: false, limit: 1 })
    assert.equal(one.items.length, 1, 'limit:1 必须真的截断')
    assert.equal(one.items[0].seq, 1)
    assert.equal(one.items[0].point, all.items[0].point)
    /* summary 是**按 limit 之后的 items 算**（实测现状）：limit:1 时 count 也是 1。
       想让 summary 保持全量口径得另算一遍，属产品决策，这里只锁现状。 */
    assert.equal(one.summary.count, 1, 'summary 与 items 同口径，都受 limit 约束')
    assert.equal(one.summary.points, all.items[0].points)
  })
})

/* ==================================================== 攻击链与攻击文件 */

test('chain_add 的 hints 三源：缺 tool / 缺 result / 得分提示', async () => {
  await withStore(async ({ store, call }) => {
    const bare = await call('redteam_chain_add', { action: '裸步骤' })
    assert.equal(bare.ok, true)
    assert.equal(bare.seq, 1)
    assert.equal(bare.hints.length, 2)
    assert.match(bare.hints[0], /没写 `tool`/)
    assert.match(bare.hints[1], /没写 `result`/)

    const full = await call('redteam_chain_add', {
      action: '扫描', tool: 'nmap -sV', result: '22/tcp open ssh', recorded_by: 'recon',
    })
    assert.equal(full.seq, 2)
    assert.equal('hints' in full, false, '两个都写了就不该有 hints 键')

    const chain = await call('redteam_chain', {})
    assert.equal(chain.items.length, 2)
    assert.equal(chain.items[1].tool, 'nmap -sV')
    assert.equal(chain.items[1].recorded_by, 'recon')
  })
})

test('attack_file_add 强制写有效性证据，落盘后 list 两种形态都能读', async () => {
  await withStore(async ({ root, store, call }) => {
    const rejected = await call('redteam_attack_file_add', { target: '10.0.0.9', name: 'cve.sh', content: 'echo 1' })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error_kind, 'bad_input')
    assert.match(rejected.error, /attack file evidence required/)

    const saved = await call('redteam_attack_file_add', {
      target: '10.0.0.9', name: 'cve.sh', kind: 'poc', evidence: '回显 uid=0', content: 'echo 1', description: '验证用',
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.name, 'cve.sh')
    assert.equal(saved.kind, 'poc')
    assert.ok(saved.path.includes(join('attack-files', '10.0.0.9', 'cve.sh')))
    assert.equal(readFileSync(saved.path, 'utf8'), 'echo 1')
    assert.ok(existsSync(saved.path))

    const tree = await call('redteam_attack_file_list', {})
    assert.equal(tree.folders.length, 1)
    assert.equal(tree.folders[0].target, '10.0.0.9')
    assert.equal(tree.folders[0].count, 1)
    assert.equal(tree.folders[0].files[0].evidence, '回显 uid=0')

    const flat = await call('redteam_attack_file_list', { target: '10.0.0.9' })
    assert.equal(flat.items.length, 1)
    assert.equal(flat.folders, undefined, '按 target 查时返回 items 不是 folders')
  })
})

/* ==================================================== 报告 */

test('report_targets 可按 key/label 过滤，totals 是过滤前的口径', async () => {
  await withStore(async ({ store, call }) => {
    await call('redteam_vuln_add', { title: 'SSRF', severity: 'high', status: 'confirmed', target: '10.0.0.5' })
    await call('redteam_vuln_add', { title: '弱口令', severity: 'medium', status: 'confirmed', target: '10.0.0.6' })
    const all = await call('redteam_report_targets', {})
    assert.equal(all.ok, true)
    assert.equal(all.totals.vulns, 2)
    assert.equal(all.targets.length, 2)
    assert.deepEqual(Object.keys(all.targets[0]).sort(), ['key', 'label', 'segment', 'stats'])

    const one = await call('redteam_report_targets', { target: '10.0.0.5' })
    assert.equal(one.targets.length, 1)
    assert.equal(one.targets[0].key, '10.0.0.5')
    assert.equal(one.targets[0].stats.vulns, 1)
    assert.equal(one.totals.vulns, 2, 'totals 不跟着过滤走')

    const none = await call('redteam_report_targets', { target: 'no-such-target' })
    assert.deepEqual(none.targets, [])
  })
})

test('report 一次给出 stats 与四章节 markdown', async () => {
  await withStore(async ({ store, call }) => {
    await call('redteam_vuln_add', { title: 'Log4j RCE', severity: 'critical', status: 'exploited' })
    await call('redteam_access_add', { host: '10.0.0.5', privilege: 'admin' })
    await call('redteam_credential_add', { host: '10.0.0.5', username: 'root', password: 'x' })
    const report = await call('redteam_report', {})
    assert.equal(report.ok, true)
    assert.ok(report.generated_at)
    assert.equal(report.stats.results, 1)
    assert.equal(report.stats.exploited, 1)
    assert.equal(report.stats.bySeverity.critical, 1)
    assert.equal(report.stats.accesses, 1)
    assert.equal(report.stats.credentials, 1)
    assert.match(report.markdown, /## 1\. 成果漏洞/)
    assert.match(report.markdown, /## 4\. 修复建议/)
    assert.match(report.markdown, /Log4j RCE/)
  })
})

/* ==================================================== 证据与未知 */

test('evidence_record 必须带 operation，成功给 ev_ 前缀的 64 位哈希', async () => {
  await withStore(async ({ store, call }) => {
    const rejected = await call('redteam_evidence_record', { result: { out: 'x' } })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error, 'operation is required and must be a string')

    const rec = await call('redteam_evidence_record', {
      operation: 'id', result: { out: 'uid=0' }, target: '10.0.0.5',
    })
    assert.equal(rec.ok, true)
    assert.match(rec.ev_id, /^ev_[0-9a-f]{64}$/)
    assert.equal(rec.duplicate, false)

    const again = await call('redteam_evidence_record', { operation: 'id', result: { out: 'uid=0' } })
    assert.equal(again.ev_id, rec.ev_id, '同样的 operation+result 哈希必须一致')
    assert.equal(again.duplicate, true, '第二次要标重复，避免同一件事记两遍')
  })
})

test('evidence_verify 用哈希核对，改一个字节就 matched=false 并给出两边 ev_id', async () => {
  await withStore(async ({ store, call }) => {
    const rec = await call('redteam_evidence_record', { operation: 'id', result: { out: 'uid=0' } })
    const same = await call('redteam_evidence_verify', { operation: 'id', result: { out: 'uid=0' } })
    assert.equal(same.matched, true)
    assert.equal(same.ev_id, rec.ev_id)

    const diff = await call('redteam_evidence_verify', { operation: 'id', result: { out: 'uid=1' } })
    assert.equal(diff.matched, false)
    assert.equal(diff.actual_ev_id, null)
    assert.match(diff.expected_ev_id, /^ev_[0-9a-f]{64}$/)
    assert.notEqual(diff.expected_ev_id, rec.ev_id)
    assert.equal(diff.note, 'no matching evidence in ledger')
  })
})

test('evidence_upgrade 把 claimed 升成 observed，unverified_count 随之归零', async () => {
  await withStore(async ({ store, call }) => {
    const claimed = await call('redteam_evidence_record', {
      operation: 'ls /root', result: { out: 'flag' }, confidence: 'claimed', source_agent: 'recon',
    })
    const before = await call('redteam_unverified_count', {})
    assert.equal(before.unverified_count, 1)
    assert.match(before.hint, /还有 1 条 claimed\/inferred 未闭环核实/)

    const upgraded = await call('redteam_evidence_upgrade', {
      claimed_ev_id: claimed.ev_id, verified_result: { out: 'flag' }, verified_by: 'coordinator',
    })
    assert.equal(upgraded.ok, true)
    assert.match(upgraded.ev_id, /^ev_[0-9a-f]{64}$/)
    assert.notEqual(upgraded.ev_id, claimed.ev_id, '升级是新增一条 observed，不是原地改 claimed')

    const after = await call('redteam_unverified_count', {})
    assert.equal(after.unverified_count, 0)
    assert.equal(after.hint, '所有子智能体报告都已亲自核实闭环')

    const listed = await call('redteam_evidence_list', { confidence: 'observed' })
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].confidence, 'observed')
    assert.equal(listed.items[0].operation, 'ls /root')
  })
})

test('unknown_record/list/resolve 走完一轮，disposition 只认三个值', async () => {
  await withStore(async ({ store, call }) => {
    const rec = await call('redteam_unknown_record', {
      question: '内网 172.16.0.0/16 是否可达', severity: 'high', domain: 'boundary-break', recommended_probe: 'socks5 扫 445',
    })
    assert.equal(rec.ok, true)
    assert.match(rec.unk_id, /^unk_[0-9a-f]{64}$/)
    assert.equal(rec.duplicate, false)

    const dup = await call('redteam_unknown_record', {
      question: '内网 172.16.0.0/16 是否可达', severity: 'high', domain: 'boundary-break',
    })
    assert.equal(dup.unk_id, rec.unk_id, 'question+domain 相同要去重')
    assert.equal(dup.duplicate, true)

    const open = await call('redteam_unknown_list', {})
    assert.equal(open.items.length, 1)
    assert.equal(open.items[0].status, 'open')
    assert.equal(open.items[0].severity, 'high')
    assert.equal(open.items[0].domain, 'boundary-break')

    const bad = await call('redteam_unknown_resolve', { unk_id: rec.unk_id, disposition: 'done' })
    assert.equal(bad.ok, false)
    assert.equal(bad.error, 'disposition must be resolved|contradicted')

    const ok = await call('redteam_unknown_resolve', { unk_id: rec.unk_id, disposition: 'resolved', resolution: '经 socks5 可达' })
    assert.equal(ok.ok, true)
    assert.equal(ok.unk_id, rec.unk_id)
    const after = await call('redteam_unknown_list', {})
    assert.deepEqual(after.items, [], '默认只列 open')
    const resolved = await call('redteam_unknown_list', { status: 'resolved' })
    assert.equal(resolved.items.length, 1)
    assert.equal(resolved.items[0].resolution, '经 socks5 可达')
  })
})

/* ==================================================== 截图 */

test('shot_add 校验源文件存在，成功后可列可删', async () => {
  await withStore(async ({ root, store, call }) => {
    const missing = await call('redteam_shot_add', { path: join(root, 'nope.png') })
    assert.equal(missing.ok, false)
    assert.equal(missing.error_kind, 'bad_input')
    assert.match(missing.error, /shot source not found/)

    const png = join(root, 'shot.png')
    writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
    const added = await call('redteam_shot_add', { path: png, label: '后台截图', note: 'admin 面板' })
    assert.equal(added.ok, true)
    assert.equal(added.bytes, 8)
    assert.match(added.file, /-shot-01\.png$/, '没给 point_code 时文件名用 shot')
    assert.match(added.sha256, /^[0-9a-f]{64}$/)

    const listed = await call('redteam_shot_list', {})
    assert.equal(listed.total, 1)
    assert.equal(listed.items[0].label, '后台截图')
    assert.equal(listed.items[0].kind, 'screenshot')
    assert.equal(listed.items[0].mime, 'image/png')

    const deleted = await call('redteam_shot_delete', { id: added.id })
    assert.equal(deleted.ok, true)
    assert.equal(deleted.id, added.id)
    assert.equal((await call('redteam_shot_list', {})).total, 0)
  })
})

/* ==================================================== 并发闸门 */

test('agent_slot 的 status/acquire/release 三支与未知 key', async () => {
  await withStore(async ({ store, call }) => {
    const status = await call('redteam_agent_slot', { action: 'status' })
    assert.equal(status.ok, true)
    assert.equal(status.max, 3)
    assert.equal(status.used, 0)
    assert.equal(status.free, 3)
    assert.equal(status.registry_available, false, '没装 subagents 服务时如实标不可用')
    assert.match(status.hint, /还有 3 个名额/)

    const acquired = await call('redteam_agent_slot', { action: 'acquire', label: '信息收集' })
    assert.equal(acquired.ok, true)
    assert.equal(acquired.used, 1)
    assert.equal(acquired.free, 2)
    assert.match(acquired.slot, /^信息收集#\d+$/)
    assert.match(acquired.hint, /派完之后要记得/)

    const released = await call('redteam_agent_slot', { action: 'release' })
    assert.equal(released.released, true)
    assert.equal(released.used, 0)

    const unknown = await call('redteam_agent_slot', { action: 'release', key: 'no-such-key' })
    assert.equal(unknown.released, false, 'key 不存在时如实回 false，不要假装释放了')
    assert.equal(unknown.ok, true)
  })
})

/* ==================================================== preflight 的四条分叉 */

test('preflight 没有 skills 服务时用本包技能兜底体检，不整条报废', async () => {
  await withStore(async ({ call }) => {
    const pf = await call('redteam_preflight', {})
    assert.equal(pf.ok, false, '缺 FOFA/VPS 时 ok 必须是 false')
    /* 本仓库 skills/redteam 恒有 23 个 .md，所以「桌面端无 skills inject」那条早退支
       在这里走不到（见 docs/test-map.md 盲区 19）；能走到的兜底路径是这个形状：
       照常体检本包技能，skills_root_hint 是那句「只检查红队技能」。 */
    assert.match(pf.skills_root_hint, /这里只检查红队技能/)
    assert.ok(pf.onboarding, '兜底路径也要给 onboarding')
    assert.ok(Array.isArray(pf.onboarding.missing))
    assert.ok(pf.platform, '兜底路径也要给平台探测')
    assert.ok(pf.toolkit && typeof pf.toolkit.exists === 'boolean')
    assert.ok(pf.next.length > 0)
    assert.ok(pf.checked >= 20, '本包技能要照常体检')
    assert.equal(pf.all_checked.registry_total, pf.summary.total)
  })
})

test('preflight 的「桌面端无 skills inject」早退支靠源码形状钉住（本仓库不可达）', () => {
  /* 这条早退支的条件是 skillsMissing && bundledSkillSummaries().length === 0；
     本包自带 skills/redteam 的 23 个 .md，任何安装形态下都不为空，所以
     公开路径上走不到。它仍然重要（桌面端没有 skills inject 时整条 preflight
     会报废），用形状断言钉住守卫与返回体。 */
  const src = readFileSync(new URL('../lib/redteam/tool-specs-recon.js', import.meta.url), 'utf8')
  assert.match(src, /if \(skillsMissing && bundledSkills\.length === 0\) \{/)
  assert.match(src, /skills_root_hint: '宿主 skills 服务不可用：已跳过技能正文体检，仅返回平台工具探测。/)
  assert.match(src, /ok: missing\.length === 0 && toolMissing\.length === 0,/)
})

test('preflight 用 skills 服务时按 include 只体检点名的技能', async () => {
  const listed = []
  const skills = {
    list: async (opts) => {
      listed.push(opts)
      return [
        { name: 'redteam-setup', description: '环境适配', content: '需要 FOFA_KEY 与 VPS 地址', library: 'redteam', resourceBase: { kind: 'directory', path: join(skRoot, 'redteam-setup') } },
        { name: 'redteam-recon', description: '信息收集', content: '没有占位符', library: 'redteam', resourceBase: { kind: 'directory', path: join(skRoot, 'redteam-recon') } },
      ]
    },
    get: async (n) => ({ path: join(skRoot, n, 'SKILL.md'), content: n === 'redteam-setup' ? '需要 FOFA_KEY 与 VPS 地址' : '没有占位符' }),
  }
  await withStore(async ({ root, call }) => {
    skRoot = join(root, 'sk')
    const pf = await call('redteam_preflight', { include: 'redteam-recon,ghost' })
    assert.equal(listed.length, 1)
    assert.deepEqual(listed[0], { scope: 'scope-redteam' }, '有 agentPresets 时必须带 scope 去 list')
    assert.equal(pf.ok, true, 'include 模式下 ok 只看点名技能')
    assert.equal(pf.all_checked.checked, 1)
    assert.deepEqual(pf.include.requested, ['redteam-recon', 'ghost'])
    assert.deepEqual(pf.include.unknown, ['ghost'])
    assert.match(pf.include.note, /ok 只覆盖点名的技能/)
    assert.equal(pf.wanted_count, 1)
    assert.ok(Array.isArray(pf.needs_user_flat))
  }, {
    extra: {
      skills,
      get: (k) => (k === 'skills' ? skills : (k === 'agentPresets' ? { standingKeyFor: async () => 'scope-redteam' } : undefined)),
    },
  })
})

test('preflight 读技能目录失败但有内置兜底时继续体检', async () => {
  const broken = { list: async () => { throw new Error('registry offline') } }
  await withStore(async ({ call }) => {
    const pf = await call('redteam_preflight', {})
    assert.equal(pf.ok, false, '缺 FOFA/VPS 仍然 ok:false')
    /* 有内置兜底时不能整条报废，也不该报「宿主 skills 服务不可用」（那是真空路径的文案）；
       两种情况共用同一句 skills_root_hint，所以这里钉的是「不是降级文案」+ 照常体检。 */
    assert.doesNotMatch(pf.skills_root_hint, /宿主 skills 服务不可用/, '走了内置兜底就不是降级路径')
    assert.ok(pf.checked >= 20, '内置技能清单要照常体检')
    assert.ok(pf.all_checked.registry_total >= 20)
    assert.equal(pf.summary.total, pf.all_checked.registry_total)
  }, { extra: { skills: broken, get: (k) => (k === 'skills' ? broken : undefined) } })
})

test('preflight 解析 $DSH_HOME/.env：export 前缀、引号、行内注释都按 shell 习惯处理', async () => {
  await withStore(async ({ root, store, call }) => {
    const home = process.env.DSH_HOME
    mkdirSync(join(home, 'redteam'), { recursive: true })
    writeFileSync(join(home, 'id_rsa'), 'k')
    writeFileSync(join(home, '.env'), [
      '# 注释行不算',
      'export FOFA_KEY="abcdef1234567890"',
      'REDTEAM_VPS_HOST=1.2.3.4 # 这是注释要剥掉',
      `REDTEAM_VPS_KEY=${join(home, 'id_rsa')}`,
      'EMPTY_KEY=',
      '',
    ].join('\n'))
    const pf = await call('redteam_preflight', {})
    const cfg = pf.onboarding.configured
    assert.equal(cfg.fofa_key, 'configured(abcd…7890)', '长 key 只露前 4 后 4')
    assert.equal(cfg.vps_host, '1.2.3.4', '行内注释必须剥掉')
    assert.match(cfg.vps_key, /^configured\(/)
    assert.equal(cfg.env_file.exists, true)
    assert.deepEqual(cfg.env_file.keys.sort(), ['FOFA_KEY', 'REDTEAM_VPS_HOST', 'REDTEAM_VPS_KEY'], '空值不登记进 keys')
    assert.equal(pf.onboarding.missing.some((m) => m.startsWith('FOFA_KEY')), false, '配齐了就不该再报缺 FOFA')
  })
})

/* ==================================================== 角色表 */

test('roles 返回六个角色与中文标题', async () => {
  await withStore(async ({ store, call }) => {
    const roles = await call('redteam_roles', {})
    assert.equal(roles.ok, true)
    assert.deepEqual(roles.roles.map((r) => r.role), ['plan', 'recon', 'assess', 'vuln-scan', 'exploit', 'internal'])
    assert.equal(roles.roles[0].title, '主会话（指挥）')
    assert.equal(roles.roles[5].title, '内网渗透')
  })
})
