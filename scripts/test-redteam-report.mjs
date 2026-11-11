import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { RedteamStore } from '../lib/redteam/store-core.js'
import { TUNNEL_ENTRY_KINDS } from '../lib/redteam/score-rules.js'

/*
为什么这一组值得单独一个文件：

`sessionSummary` / `attackGraph` / `report` / `importBundle` / `probeSessions` 是演练台的「出口」——
前三个把库里的东西变成界面和交付物，`importBundle` 把外部工具的输出倒进库里，
`probeSessions` 决定面板上那个「在线/离线」到底是真是假。
它们出错的表现都不是抛异常，而是「报告里少了一条成果」「图谱里资产没标成已控制」
「导入到一半失败、库里留下一批半成品」「马其实早被删了但面板还是绿的」，
用户看到的是结果不对，而不是报错。

其中 `report` 的筛选口径（只收已证实/已利用且中危以上）直接决定交付物里有什么，
所以逐条钉住；`importBundle` 的 BEGIN 位置（必须在写 scan_run 之前）靠
「失败后不留孤儿扫描记录」这一条守。
*/

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-purge-report-'))
  const store = new RedteamStore(root)
  const eng = store.openEngagement('report-test', ['10.0.0.0/24'])
  return Promise.resolve()
    .then(() => fn(store, eng.id))
    .finally(() => {
      try { store.close() } catch { /* ignore */ }
      try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 上 SQLite 目录偶发 EPERM */ }
    })
}

function seedAssets(store, id) {
  return store.importBundle(id, {
    scan: { tool: 'nmap', argv: ['-sV'], agent_session_id: 'sess-a' },
    segments: [{ cidr: '10.0.0.0/24', org: '示例单位' }],
    assets: [
      {
        ip: '10.0.0.5',
        state: 'live',
        primary_name: 'www.example.test',
        provenance: 'active',
        names: [{ name: 'www.example.test', kind: 'domain' }],
        ports: [{
          port: 80,
          proto: 'tcp',
          service: 'http',
          product: 'nginx',
          version: '1.24',
          banner: 'nginx/1.24',
          fingerprints: [{ category: 'web', vendor: 'nginx', product: 'nginx', version: '1.24' }],
        }],
      },
      { ip: '10.0.0.6', state: 'live', provenance: 'active' },
    ],
  })
}

function assetIdOf(store, id, ip) {
  return store.db(id).prepare('SELECT id FROM asset WHERE ip = ?').get(ip).id
}

/* ---------- 会话总览 ---------- */

test('会话总览：统计在线 webshell 与跨越靶标边界的隧道', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    store.addWebshell(id, { url: 'http://10.0.0.5:80/shell.php', pass_key: 'k', status: 'online', asset_id: a5 })
    store.addWebshell(id, { url: 'http://10.0.0.6:80/x.php', pass_key: 'k', status: 'offline' })
    store.addTunnel(id, { kind: 'socks5', listen: '127.0.0.1:1080', entry_kind: 'target-http', status: 'active', asset_id: a5 })
    store.addTunnel(id, { kind: 'socks5', listen: '127.0.0.1:1081', entry_kind: 'self-only', status: 'active' })
    store.addTunnel(id, { kind: 'socks5', listen: '127.0.0.1:1082', status: 'down' })

    const s = store.sessionSummary(id)
    assert.equal(s.totals.webshells, 2)
    assert.equal(s.totals.webshellsOnline, 1)
    assert.equal(s.totals.tunnels, 3)
    assert.equal(s.totals.tunnelsActive, 2)
    // 只有跨越靶标边界的通道才算突破凭证；自己 VPS 上开的不算
    assert.equal(s.totals.tunnelsLegit, 1)
    assert.equal(s.totals.tunnelsSelfOnly, 1)
    // 按 id 倒序：后登记的那条在前；没挂资产的 asset_ip 是 null，不是空串
    assert.equal(s.webshells[0].asset_ip, null, '未挂资产的 webshell 不凭空填一个 IP')
    assert.equal(s.webshells[1].asset_ip, '10.0.0.5', '挂到资产上的能反查出 IP')
    assert.equal(s.tunnels[0].entry_kind_label, null, '未声明 entry_kind 时标签为空')
    assert.equal(s.tunnels[0].legit, null, '未声明 entry_kind 时算「待确认」')
    // 声明了的必须带上中文说明，否则界面只有 target-http 这种英文 code，看不明白是什么
    assert.equal(s.tunnels[2].entry_kind, 'target-http')
    assert.equal(s.tunnels[2].entry_kind_label, TUNNEL_ENTRY_KINDS['target-http'])
    assert.ok(String(s.tunnels[2].entry_kind_label).length > 4)
    assert.equal(s.tunnels[2].legit, true)
    assert.equal(s.tunnels[1].legit, false, 'self-only 不算突破凭证')
  })
})

test('会话总览：空靶标也返回完整结构而不是 undefined', async () => {
  await withStore((store, id) => {
    const s = store.sessionSummary(id)
    assert.deepEqual(s.webshells, [])
    assert.deepEqual(s.tunnels, [])
    assert.deepEqual(s.totals, {
      webshells: 0, webshellsOnline: 0, tunnels: 0, tunnelsActive: 0,
      tunnelsLegit: 0, tunnelsSelfOnly: 0, credentials: 0, access: 0,
    })
  })
})

/* ---------- 攻击图谱 ---------- */

test('攻击图谱：把漏洞按严重级计数挂到资产节点上', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    store.addVuln(id, { asset_id: a5, title: '弱口令', severity: 'high', status: 'confirmed' })
    store.addVuln(id, { asset_id: a5, title: '信息泄露', severity: 'low', status: 'candidate' })

    const g = store.attackGraph(id)
    const node = g.nodes.find((n) => n.id === 'asset:' + a5)
    assert.deepEqual(node.meta.vulns, { high: 1, low: 1 }, '未确认的漏洞也计入严重级分布')
    assert.equal(node.meta.owned, undefined, '没有访问会话时不该标成已控制')
  })
})

test('攻击图谱：只有已证实/已利用的漏洞才画成节点', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    const confirmed = store.addVuln(id, { asset_id: a5, cve: 'CVE-2024-0001', title: 'RCE', severity: 'critical', status: 'confirmed' })
    store.addVuln(id, { asset_id: a5, title: '待确认', severity: 'high', status: 'candidate' })
    store.addVuln(id, { asset_id: a5, title: '已修', severity: 'high', status: 'fixed' })

    const g = store.attackGraph(id)
    const vulnNodes = g.nodes.filter((n) => n.kind === 'vuln')
    assert.equal(vulnNodes.length, 1)
    assert.equal(vulnNodes[0].id, 'vuln:' + confirmed.id)
    assert.equal(vulnNodes[0].label, 'CVE-2024-0001', '有 CVE 时标签用 CVE')
    assert.equal(vulnNodes[0].meta.severity, 'critical')
    assert.deepEqual(
      g.edges.filter((e) => e.relation === 'has_vuln'),
      [{ source: 'asset:' + a5, target: 'vuln:' + confirmed.id, relation: 'has_vuln' }],
    )
  })
})

test('攻击图谱：有访问会话的资产标成已控制', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    store.addAccess(id, { asset_id: a5, host: '10.0.0.5', username: 'root', method: 'ssh', privilege: 'root' })
    const g = store.attackGraph(id)
    assert.equal(g.nodes.find((n) => n.id === 'asset:' + a5).meta.owned, true)
  })
})

test('攻击图谱：summary 就是漏洞统计（两个视图不能各算一套）', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    store.addVuln(id, { asset_id: a5, title: 'A', severity: 'high', status: 'confirmed' })
    const g = store.attackGraph(id)
    assert.deepEqual(g.summary, store.vulnStats(id))
  })
})

/* ---------- 报告 ---------- */

test('报告：只收已证实/已利用且中危以上的成果漏洞', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    store.addVuln(id, { asset_id: a5, title: '确认高危', severity: 'high', status: 'confirmed' })
    store.addVuln(id, { asset_id: a5, title: '已利用严重', severity: 'critical', status: 'exploited' })
    store.addVuln(id, { asset_id: a5, title: '待确认高危', severity: 'high', status: 'candidate' })
    store.addVuln(id, { asset_id: a5, title: '确认低危', severity: 'low', status: 'confirmed' })
    store.addVuln(id, { asset_id: a5, title: '确认信息级', severity: 'info', status: 'confirmed' })
    store.addVuln(id, { asset_id: a5, title: '误报', severity: 'high', status: 'false-positive' })

    const r = store.report(id)
    assert.equal(r.stats.results, 2)
    assert.equal(r.stats.filteredOut, 4)
    assert.deepEqual(r.stats.bySeverity, { critical: 1, high: 1, medium: 0, low: 0, info: 0 })
    assert.equal(r.stats.exploited, 1)
    assert.match(r.markdown, /确认高危/)
    assert.match(r.markdown, /已利用严重/)
    assert.doesNotMatch(r.markdown, /待确认高危/)
    assert.doesNotMatch(r.markdown, /确认低危/)
  })
})

test('报告：all:true 时把全部漏洞都写进交付物（自查用）', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    store.addVuln(id, { asset_id: a5, title: '待确认高危', severity: 'high', status: 'candidate' })
    store.addVuln(id, { asset_id: a5, title: '确认低危', severity: 'low', status: 'confirmed' })
    const r = store.report(id, { all: true })
    assert.equal(r.stats.results, 2)
    assert.equal(r.stats.filteredOut, 0)
    assert.match(r.markdown, /待确认高危/)
    assert.doesNotMatch(r.markdown, /未纳入/, 'includeAll 时不该再出现「另有 N 条未纳入」的脚注')
  })
})

test('报告：按严重级从高到低排序（哪怕数据源顺序被打乱）', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    store.addVuln(id, { asset_id: a5, title: '中危项', severity: 'medium', status: 'confirmed' })
    store.addVuln(id, { asset_id: a5, title: '严重项', severity: 'critical', status: 'confirmed' })
    store.addVuln(id, { asset_id: a5, title: '高危项', severity: 'high', status: 'confirmed' })

    // listVulns 本身已经按严重级排过一次，所以直接读库看不出 report 自己有没有排。
    // 把数据源换成故意打乱的顺序，才是真正在测 report 的排序。
    const realListVulns = store.listVulns.bind(store)
    store.listVulns = () => {
      const items = realListVulns(id, { limit: 2000, evidenceLimit: 60000 }).items
      return { items: items.slice().reverse() }
    }
    const md = store.report(id).markdown
    store.listVulns = realListVulns
    assert.ok(md.indexOf('严重项') < md.indexOf('高危项'), 'critical 必须在 high 之前')
    assert.ok(md.indexOf('高危项') < md.indexOf('中危项'), 'high 必须在 medium 之前')
  })
})

test('报告：四个章节与小标题固定（交付物格式不能漂）', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const r = store.report(id)
    assert.match(r.markdown, /^# 红队演练成果报告 — report-test$/m)
    assert.match(r.markdown, /^## 1\. 成果漏洞$/m)
    assert.match(r.markdown, /^## 2\. 攻击链$/m)
    assert.match(r.markdown, /^## 3\. 已获取的权限与凭据$/m)
    assert.match(r.markdown, /^## 4\. 修复建议$/m)
    assert.match(r.markdown, /- 授权范围：10\.0\.0\.0\/24/)
    assert.match(r.markdown, /本次演练没有可交付的成果漏洞/)
    assert.match(r.markdown, /（没有记录攻击步骤）/)
    assert.match(r.markdown, /（没有拿到可用的访问权限）/)
    assert.match(r.markdown, /（没有获取凭据）/)
  })
})

test('报告：把复现请求原样贴进代码块（可直接粘进 Burp）', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    const v = store.addVuln(id, { asset_id: a5, title: 'SQL 注入', severity: 'high', status: 'confirmed' })
    store.addHttpEvidence(id, {
      vuln_id: v.id,
      method: 'POST',
      url: 'http://10.0.0.5/login',
      status: 200,
      request: 'POST /login HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\nid=1',
      response: 'HTTP/1.1 200 OK\r\n\r\nok',
    })
    const md = store.report(id).markdown
    assert.match(md, /\*\*复现请求（可直接粘进 Burp Suite \/ Yakit）\*\*/)
    assert.match(md, /```http\nPOST \/login HTTP\/1\.1\nHost: 10\.0\.0\.5\n\nid=1\n```/, 'CR 必须被去掉，否则代码块里会多出空行')
    assert.match(md, /响应摘要：/)
  })
})

test('报告：修复建议按证据生成，且最后一条永远在', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    store.addVuln(id, { asset_id: a5, cve: 'CVE-2024-0001', title: 'RCE', severity: 'critical', status: 'exploited' })
    store.addAccess(id, { asset_id: a5, host: '10.0.0.5', method: 'webshell' })
    store.addAccess(id, { asset_id: a5, host: '10.0.0.6', method: 'rdp' })
    store.addCredential(id, { host: '10.0.0.5', username: 'sa', secret_type: 'connection-string' })

    const md = store.report(id).markdown
    assert.match(md, /1\. 先按上面的 CVE 编号修补受影响组件/)
    assert.match(md, /2\. 收紧文件上传与命令执行/)
    assert.match(md, /3\. 收敛远程管理面/)
    assert.match(md, /4\. 数据库连接串不要经 API\/配置泄露/)
    assert.match(md, /5\. 对本次涉及的业务接口补齐统一鉴权与越权校验/, '固定收尾那条的序号要跟着前文走')
  })
})

test('报告：没有 CVE 时不会凭空生成补丁建议', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    store.addVuln(id, { asset_id: a5, title: '弱口令', severity: 'high', status: 'confirmed' })
    const md = store.report(id).markdown
    assert.doesNotMatch(md, /先按上面的 CVE 编号修补/)
    assert.match(md, /1\. 对本次涉及的业务接口补齐统一鉴权与越权校验/, '只有收尾那条时它排第 1')
  })
})

test('报告：被筛掉的条数写进脚注，且只写一次', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    store.addVuln(id, { asset_id: a5, title: '确认高危', severity: 'high', status: 'confirmed' })
    store.addVuln(id, { asset_id: a5, title: '待确认', severity: 'high', status: 'candidate' })
    store.addVuln(id, { asset_id: a5, title: '低危', severity: 'low', status: 'confirmed' })
    const md = store.report(id).markdown
    assert.match(md, /> 本报告只收已证实\/已利用且中危及以上的成果漏洞；另有 2 条待确认、误报、低危或信息级记录未纳入/)
    assert.equal(md.match(/另有 \d+ 条/g).length, 1)
  })
})

test('报告：stats 覆盖条数、攻击链与凭据', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    store.addVuln(id, { asset_id: a5, title: '确认高危', severity: 'high', status: 'confirmed' })
    store.addAccess(id, { asset_id: a5, host: '10.0.0.5', method: 'ssh' })
    store.addCredential(id, { host: '10.0.0.5', username: 'root', secret_type: 'password' })
    store.addChainStep(id, { stage: 'recon', title: '端口扫描' })
    store.addChainStep(id, { stage: 'initial', title: '打点成功' })

    const r = store.report(id)
    assert.equal(r.stats.accesses, 1)
    assert.equal(r.stats.credentials, 1)
    assert.equal(r.stats.chainSteps, 2)
    assert.match(r.markdown, /控制资产 1 台 · 获取凭据 1 组/)
    assert.match(r.markdown, /1\. \*\*\[recon\] 端口扫描\*\*/)
    assert.match(r.markdown, /2\. \*\*\[initial\] 打点成功\*\*/)
  })
})

test('报告：空靶标也能出一份可交付的空报告', async () => {
  await withStore((store, id) => {
    const r = store.report(id)
    assert.equal(r.stats.results, 0)
    assert.equal(r.stats.filteredOut, 0)
    assert.match(r.markdown, /0 条成果漏洞（严重 0 · 高危 0 · 中危 0）/)
    assert.ok(r.generated_at)
  })
})

/* ---------- 采集导入 ---------- */

test('导入：counts 逐类计数与 scan_run_id', async () => {
  await withStore((store, id) => {
    const out = seedAssets(store, id)
    assert.equal(out.counts.segments, 1)
    assert.equal(out.counts.assets, 2)
    assert.equal(out.counts.ports, 1)
    assert.equal(out.counts.services, 1)
    assert.equal(out.counts.fingerprints, 1)
    assert.equal(out.counts.names, 1)
    assert.equal(out.counts.edges, 0, 'bundle.edges 才是边，域名边不算在 counts 里')
    assert.ok(Number.isInteger(out.scan_run_id) && out.scan_run_id > 0)
    assert.equal(out.stats.assets, 2)
    assert.equal(out.stats.openPorts, 1)
    assert.equal(out.stats.services, 1)
  })
})

test('导入：扫描记录带上工具与会话，便于回溯是哪次采集', async () => {
  await withStore((store, id) => {
    const out = seedAssets(store, id)
    const run = store.db(id).prepare('SELECT * FROM scan_run WHERE id = ?').get(out.scan_run_id)
    assert.equal(run.tool, 'nmap')
    assert.equal(run.agent_session_id, 'sess-a')
    assert.equal(run.status, 'completed')
    assert.equal(run.argv, '["-sV"]')
  })
})

test('导入：域名自动连到资产（resolves 边）', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    const edges = store.db(id).prepare("SELECT * FROM edge WHERE relation = 'resolves'").all()
    assert.equal(edges.length, 1)
    assert.equal(edges[0].src_id, 'www.example.test')
    assert.equal(edges[0].dst_id, String(a5))
  })
})

test('导入：端口/服务/指纹落库，且 banner 与 title 按 COALESCE 增量补', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    store.importBundle(id, {
      assets: [{ ip: '10.0.0.5', ports: [{ port: 80, state: 'open', title: '登录页' }] }],
    })
    const port = store.db(id).prepare('SELECT * FROM port WHERE asset_id = ? AND port = 80').get(a5)
    assert.equal(port.banner, 'nginx/1.24', '第二次没给 banner，不能把原来的清掉')
    assert.equal(port.title, '登录页', '第二次给了 title 就更新')
    assert.equal(store.db(id).prepare('SELECT COUNT(*) AS n FROM port WHERE asset_id = ?').get(a5).n, 1, '同端口不能插第二条')
  })
})

test('导入：中途失败整体回滚，不留孤儿扫描记录与半截资产', async () => {
  await withStore((store, id) => {
    const before = store.db(id).prepare('SELECT COUNT(*) AS n FROM scan_run').get().n
    const bad = {
      ip: '10.0.0.99',
      get ports() { throw new Error('boom') },
    }
    assert.throws(
      () => store.importBundle(id, { scan: { tool: 'nmap' }, segments: [{ cidr: '10.9.9.0/24' }], assets: [bad] }),
      /boom/,
    )
    assert.equal(
      store.db(id).prepare('SELECT COUNT(*) AS n FROM scan_run').get().n,
      before,
      'BEGIN 必须在写 scan_run 之前，否则回滚会留下孤儿记录',
    )
    assert.equal(store.db(id).prepare('SELECT COUNT(*) AS n FROM asset WHERE ip = ?').get('10.0.0.99').n, 0)
    assert.equal(store.db(id).prepare('SELECT COUNT(*) AS n FROM segment WHERE cidr = ?').get('10.9.9.0/24').n, 0)
  })
})

test('导入：bundle.edges 逐条写入并计入 counts', async () => {
  await withStore((store, id) => {
    seedAssets(store, id)
    const a5 = assetIdOf(store, id, '10.0.0.5')
    const out = store.importBundle(id, {
      edges: [{ src_kind: 'asset', src_id: a5, dst_kind: 'asset', dst_id: 99, relation: 'reaches', confidence: 0.8 }],
    })
    assert.equal(out.counts.edges, 1)
    const e = store.db(id).prepare("SELECT * FROM edge WHERE relation = 'reaches'").get()
    assert.equal(e.src_id, String(a5))
    assert.equal(e.confidence, 0.8)
  })
})

/* ---------- 连通性探测 ---------- */

test('探测：能连上的 webshell 标 online、能连上的隧道标 active', async () => {
  await withStore(async (store, id) => {
    const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok') })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    const tcp = net.createServer((s) => s.end())
    await new Promise((r) => tcp.listen(0, '127.0.0.1', r))
    const tcpPort = tcp.address().port
    try {
      const w = store.addWebshell(id, { url: 'http://127.0.0.1:' + port + '/s.php', pass_key: 'k' })
      const t = store.addTunnel(id, { kind: 'socks5', listen: '127.0.0.1:' + tcpPort, entry_kind: 'target-http' })
      const out = await store.probeSessions(id, { timeoutMs: 2000 })
      assert.equal(out.webshells.length, 1)
      assert.equal(out.webshells[0].status, 'online')
      assert.equal(out.webshells[0].note, 'HTTP 200')
      assert.equal(out.tunnels[0].status, 'active')
      assert.equal(out.tunnels[0].note, '')
      assert.ok(out.checkedAt)
      // 结果必须回写到库里，否则面板刷新又变回旧状态
      const row = store.db(id).prepare('SELECT * FROM webshell WHERE id = ?').get(w.id)
      assert.equal(row.status, 'online')
      assert.equal(row.check_note, 'HTTP 200')
      assert.ok(Number.isFinite(row.latency_ms))
      assert.equal(store.db(id).prepare('SELECT status FROM tunnel WHERE id = ?').get(t.id).status, 'active')
    } finally {
      server.close()
      tcp.close()
    }
  })
})

test('探测：连不上时 webshell 标 offline、隧道标 down，并把原因写进 check_note', async () => {
  await withStore(async (store, id) => {
    store.addWebshell(id, { url: 'http://127.0.0.1:1/s.php', pass_key: 'k' })
    store.addTunnel(id, { kind: 'socks5', listen: '127.0.0.1:1', entry_kind: 'target-http' })
    const out = await store.probeSessions(id, { timeoutMs: 1000 })
    assert.equal(out.webshells[0].status, 'offline')
    assert.ok(out.webshells[0].note.length > 0, '失败原因必须留痕，不能是空字符串')
    assert.equal(out.tunnels[0].status, 'down')
    assert.ok(out.tunnels[0].note.length > 0)
  })
})

test('探测：隧道没有 listen 地址时不发连接，直接说明原因', async () => {
  await withStore(async (store, id) => {
    store.addTunnel(id, { kind: 'socks5', listen: '', entry_kind: 'target-http' })
    const out = await store.probeSessions(id, { timeoutMs: 1000 })
    assert.equal(out.tunnels[0].status, 'down')
    assert.equal(out.tunnels[0].note, 'No listen address; cannot probe')
  })
})

test('探测：listen 解析不出端口时给出原始值，不静默当 0', async () => {
  await withStore(async (store, id) => {
    store.addTunnel(id, { kind: 'socks5', listen: '127.0.0.1:abc', entry_kind: 'target-http' })
    const out = await store.probeSessions(id, { timeoutMs: 1000 })
    assert.equal(out.tunnels[0].note, 'Cannot parse port: 127.0.0.1:abc')
  })
})

test('现状锁定：webshell 只按「HTTP 状态 < 500」判在线，404 也算 online', async () => {
  await withStore(async (store, id) => {
    const server = http.createServer((req, res) => { res.writeHead(404); res.end('nope') })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    try {
      store.addWebshell(id, { url: 'http://127.0.0.1:' + port + '/s.php', pass_key: 'k' })
      const out = await store.probeSessions(id, { timeoutMs: 2000 })
      // 马还在不在其实该看「文件还在不在」，404 也可能是马被删了；
      // 现在这版只看服务端是否活着，属于已知口径，改它要动「在线」的语义。
      assert.equal(out.webshells[0].status, 'online')
      assert.equal(out.webshells[0].note, 'HTTP 404')
    } finally {
      server.close()
    }
  })
})
