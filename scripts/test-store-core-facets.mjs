// 演练台库的「筛选面 / 报告面 / 死代码」—— 都是判错了不报错、只让某一页空着的那种。
//
// 为什么值得单独一个文件：
//   1. **listAssets 的五个筛选**（service / fingerprint / provenance / priority / scope）是
//      「先打哪一批」的入口。SQL 写歪（比如把 EXISTS 里的 asset_id 写成 a.id 之外的东西）
//      不会报错，只是筛出来为空 —— 用户会以为「这批资产没被收集到」。
//   2. **sort=todo** 是「还能打什么」的排序。排序串错一位，队列顺序就反了，
//      而界面照样显示一整页。
//   3. **报告里的「复现请求」段**是交付物的一部分：请求头 CR 没去掉会粘不进 Burp，
//      响应没截断会把报告撑到几十页。
//   4. 顺手清掉两处**从来没被调用过的私有成员**（`isCappedPoint` 与 `#hitTrace`）：
//      它们长得像在用（同名函数在 score-report.js 里确实在用），是「看起来权威的死代码」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RedteamStore } from '../lib/redteam/store-core.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'redteam', 'store-core.js'), 'utf8')
const ROOTS = []
const PNG = 'iVBORw0KGgo=' // \x89PNG 开头 → mime 判成 image/png

/** 开一个临时库跑 fn；清理吞异常（Windows 上刚 close 的 SQLite 目录偶尔 EPERM）。 */
function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-purge-facets-'))
  ROOTS.push(root)
  const store = new RedteamStore(root)
  try {
    return fn({ store, root })
  } finally {
    try { store.close() } catch { /* 已关闭 */ }
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows EPERM */ }
  }
}

test.after(() => {
  for (const root of ROOTS) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

/** 三台资产，端口服务指纹各不相同；priority 通过 assessAsset 写入（importBundle 不认这个字段）。 */
function seedAssets(store, id) {
  store.importBundle(id, {
    assets: [
      {
        ip: '10.0.0.1', names: [{ name: 'portal.example.test' }],
        ports: [{
          port: 80, provenance: 'active', service: 'http', product: 'nginx',
          fingerprints: [{ category: 'web', vendor: 'igor-sysoev', product: 'nginx' }],
        }],
      },
      {
        ip: '10.0.0.2',
        ports: [{ port: 445, provenance: 'passive', service: 'smb', product: 'samba' }],
      },
      {
        ip: '8.8.8.8',
        ports: [{ port: 53, provenance: 'active', service: 'dns' }, { port: 443, provenance: 'active', service: 'https' }],
      },
    ],
  })
  const a1 = store.listAssets(id, { ip: '10.0.0.1' }).items[0]
  const a2 = store.listAssets(id, { ip: '10.0.0.2' }).items[0]
  const a3 = store.listAssets(id, { ip: '8.8.8.8' }).items[0]
  store.assessAsset(id, { asset_id: a1.id, priority: 'high', potential: 'RCE' })
  store.assessAsset(id, { asset_id: a2.id, priority: 'low' })
  return { a1, a2, a3 }
}

const ips = (store, id, f) => store.listAssets(id, f).items.map((a) => a.ip).sort()

/* ======================================================== listAssets 的五个筛选 */

test('listAssets：service 同时匹配服务名与产品名（两个 LIKE 是「或」）', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-svc', ['10.0.0.0/24']).id
    seedAssets(store, id)
    assert.deepEqual(ips(store, id, { service: 'ngin' }), ['10.0.0.1'], '产品名 nginx 要能匹配')
    assert.deepEqual(ips(store, id, { service: 'samba' }), ['10.0.0.2'], '产品名 samba 要能匹配')
    assert.deepEqual(ips(store, id, { service: 'smb' }), ['10.0.0.2'], '服务名 smb 要能匹配')
    assert.deepEqual(ips(store, id, { service: 'zzz' }), [], '没命中的关键词出空表而不是全表')
  })
})

test('listAssets：fingerprint 匹配 vendor / product / category 任一项', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-fp', ['10.0.0.0/24']).id
    seedAssets(store, id)
    assert.deepEqual(ips(store, id, { fingerprint: 'igor' }), ['10.0.0.1'], 'vendor 子串')
    assert.deepEqual(ips(store, id, { fingerprint: 'nginx' }), ['10.0.0.1'], 'product 子串')
    assert.deepEqual(ips(store, id, { fingerprint: 'web' }), ['10.0.0.1'], 'category 子串')
    assert.deepEqual(ips(store, id, { fingerprint: 'zzz' }), [])
  })
})

test('listAssets：provenance 按端口的来源筛，不是按资产', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-prov', ['10.0.0.0/24']).id
    seedAssets(store, id)
    assert.deepEqual(ips(store, id, { provenance: 'passive' }), ['10.0.0.2'])
    assert.deepEqual(ips(store, id, { provenance: 'active' }), ['10.0.0.1', '8.8.8.8'])
    assert.deepEqual(ips(store, id, { provenance: 'bogus' }), [])
  })
})

test('listAssets：priority 精确匹配（且只能靠 assessAsset 写进去）', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-prio', ['10.0.0.0/24']).id
    seedAssets(store, id)
    assert.deepEqual(ips(store, id, { priority: 'high' }), ['10.0.0.1'])
    assert.deepEqual(ips(store, id, { priority: 'low' }), ['10.0.0.2'])
    assert.deepEqual(ips(store, id, { priority: 'medium' }), [], '未评估的资产 priority 是 NULL，不是 medium')
  })
})

test('listAssets：scope 走 COALESCE 兜底，内网/外网按资产 IP 分', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-scope', ['10.0.0.0/24']).id
    seedAssets(store, id)
    assert.deepEqual(ips(store, id, { scope: 'internal' }), ['10.0.0.1', '10.0.0.2'])
    assert.deepEqual(ips(store, id, { scope: 'external' }), ['8.8.8.8'])
    assert.deepEqual(ips(store, id, { scope: 'bogus' }), [])
  })
})

/* ================================================================ 队列排序 */

test('listAssets：sort=todo 把 priority 当第一键（high → medium → low → 未评估）', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-todo', ['10.0.0.0/24']).id
    seedAssets(store, id)
    assert.deepEqual(
      store.listAssets(id, { sort: 'todo' }).items.map((a) => a.ip),
      ['10.0.0.1', '10.0.0.2', '8.8.8.8'],
      'high → low → 未评估',
    )
    /* 已测/已放弃的沉底：把它们标成 tested 之后必须排到后面去 */
    store.updateAssetTest(id, { ip: '10.0.0.1', status: 'tested' })
    assert.deepEqual(
      store.listAssets(id, { sort: 'todo' }).items.map((a) => a.ip),
      ['10.0.0.2', '8.8.8.8', '10.0.0.1'],
      'test_status 优先于 priority',
    )
  })
})

test('listAssets：sort=ports 按开放端口数从多到少', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-ports', ['10.0.0.0/24']).id
    seedAssets(store, id)
    assert.deepEqual(
      store.listAssets(id, { sort: 'ports' }).items.map((a) => a.ip),
      ['8.8.8.8', '10.0.0.1', '10.0.0.2'],
      '两条端口的排最前，其余按 ip 数值序',
    )
  })
})

/* ================================================================== 截图 */

test('listShots：不传过滤时全出，传空串等于不筛', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-shot0', ['10.0.0.0/24']).id
    seedAssets(store, id)
    store.addShot(id, { data_base64: PNG, label: 'a' })
    store.addShot(id, { data_base64: PNG, label: 'b' })
    assert.deepEqual(store.listShots(id, {}).items.map((s) => s.label), ['a', 'b'])
    assert.deepEqual(store.listShots(id, { asset_id: '' }).items.map((s) => s.label), ['a', 'b'], '空串不该变成 asset_id=0')
    assert.equal(store.listShots(id, {}).total, 2)
  })
})

test('listShots：point_code 走子查询，找不到得分点时是空表而不是全表', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-shot1', ['10.0.0.0/24']).id
    seedAssets(store, id)
    const pt = store.listScorePoints(id).items[0]
    store.addShot(id, { data_base64: PNG, label: 'plain' })
    store.addShot(id, { data_base64: PNG, label: 'pointed', point_code: pt.code })
    assert.deepEqual(store.listShots(id, { point_code: pt.code }).items.map((s) => s.label), ['pointed'])
    assert.deepEqual(store.listShots(id, { point_code: 'no-such-code' }).items.map((s) => s.label), [])
    assert.equal(store.listShots(id, { point_code: pt.code }).items[0].point_code, pt.code, '联表带出 code')
  })
})

test('listShots：hit_id / asset_id / vuln_id 三列都能筛，多个条件是「且」', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-shot2', ['10.0.0.0/24']).id
    seedAssets(store, id)
    store.addShot(id, { data_base64: PNG, label: 'bound', asset_id: 1, hit_id: 7, vuln_id: 3 })
    store.addShot(id, { data_base64: PNG, label: 'loose' })
    assert.deepEqual(store.listShots(id, { asset_id: 1 }).items.map((s) => s.label), ['bound'])
    assert.deepEqual(store.listShots(id, { hit_id: 7 }).items.map((s) => s.label), ['bound'])
    assert.deepEqual(store.listShots(id, { vuln_id: 3 }).items.map((s) => s.label), ['bound'])
    assert.deepEqual(store.listShots(id, { asset_id: 1, hit_id: 99 }).items.map((s) => s.label), [], '且关系')
    assert.deepEqual(store.listShots(id, { asset_id: 99 }).items.map((s) => s.label), [])
  })
})

test('addShot：既没有 data_base64 也没有 path 时报错原文，且不落一行记录', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-shot3', ['10.0.0.0/24']).id
    assert.throws(() => store.addShot(id, { label: 'x' }), /shot path or data_base64 required/)
    assert.throws(() => store.addShot(id, { data_base64: '  ' }), /shot path or data_base64 required/, '空白也算没给')
    assert.equal(store.listShots(id, {}).items.length, 0, '失败不该留下半条记录')
  })
})

/* ============================================================== 得分点维护 */

test('deleteScorePoint：内置点拒删，并指明「改用停用」', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-del0', ['10.0.0.0/24']).id
    const builtin = store.listScorePoints(id).items.find((x) => x.builtin === true)
    assert.throws(() => store.deleteScorePoint(id, builtin.id), (e) => {
      assert.match(e.message, /内置得分点不能删除/)
      assert.match(e.message, /《突破入侵类得分规则（合并版）》/)
      assert.match(e.message, /请改用「停用」/)
      return true
    })
    assert.equal(store.listScorePoints(id).items.filter((x) => x.id === builtin.id).length, 1, '拒绝之后得分点还在')
  })
})

test('deleteScorePoint：不存在的 id 报错原文', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-del1', ['10.0.0.0/24']).id
    assert.throws(() => store.deleteScorePoint(id, 999999), /得分点不存在: id=999999/)
  })
})

test('saveScorePoint：自建点的名称必填（更新与新增两条路都要拦）', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-name', ['10.0.0.0/24']).id
    const created = store.saveScorePoint(id, { name: '自建点', points: 5 })
    assert.equal(created.builtin, false)
    assert.equal(created.code, null, '不给 code 就是 null，不是空串')
    assert.throws(() => store.saveScorePoint(id, { id: created.id, name: '' }), /得分点名称必填/, '更新路径')
    assert.throws(() => store.saveScorePoint(id, { name: '   ' }), /得分点名称必填/, '新增路径（空白被 trim 掉）')
  })
})

test('deleteScorePoint：删命中失败要回滚，得分点不能被删掉', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-del2', ['10.0.0.0/24']).id
    const created = store.saveScorePoint(id, { name: '要删的点', points: 5 })
    /* 让「先删命中」这一步必然失败：直接把 score_hit 表抽走 */
    store.db(id).exec('DROP TABLE score_hit')
    assert.throws(() => store.deleteScorePoint(id, created.id), /no such table: score_hit/)
    const still = store.db(id).prepare('SELECT COUNT(*) AS n FROM score_point WHERE id = ?').get(created.id).n
    assert.equal(Number(still), 1, '事务回滚了，得分点还在')
    /* 回滚必须真的把事务收掉：接着还能开新事务（少这一步，连接会停在「事务未结束」状态，
       下一条写操作起手就是 cannot start a transaction within a transaction）。 */
    assert.doesNotThrow(() => { store.db(id).exec('BEGIN'); store.db(id).exec('COMMIT') })
  })
})

/* ================================================================ 记分解析 */

test('addScoreHit：不给 point_id / code 时能按 point_name 找到得分点', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-name-hit', ['10.0.0.0/24']).id
    seedAssets(store, id)
    const meta = store.listScorePoints(id).items.find((x) => x.builtin === true)
    const hit = store.addScoreHit(id, { point_name: meta.name, target: '10.0.0.1:80', evidence: 'shell as root' })
    assert.equal(hit.point_id, meta.id)
    assert.equal(hit.point, meta.name)
    assert.equal(hit.counted, true)
    /* 名字对不上时才落「score point not found」那条长文案 */
    assert.throws(() => store.addScoreHit(id, { point_name: '没有这个点', evidence: 'x' }), /score point not found/)
  })
})

test('addScoreHit：同服务上打了更高的一档，要明说「把 N 条旧命中顶掉了」', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-demote', ['10.0.0.0/24']).id
    seedAssets(store, id)
    const meta = store.listScorePoints(id).items.find((x) => x.dedup_scope === 'service' && x.builtin === true)
    store.addScoreHit(id, { point_id: meta.id, target: '10.0.0.1:80', evidence: 'low tier', points: 10 })
    const higher = store.addScoreHit(id, { point_id: meta.id, target: '10.0.0.1:80', evidence: 'high tier', points: 30 })
    assert.equal(higher.counted, true)
    assert.equal(higher.capped_by_service, false)
    assert.equal(higher.demoted_hits.length, 1, '低分那条被顶掉')
    assert.equal(higher.demoted_hits[0].points, 10)
    assert.match(higher.warning, /把同服务上分值更低的 1 条旧命中顶掉了/)
    assert.match(higher.warning, /同一资产同一端口只算一次/)
  })
})

test('addScoreHit：再打更低的一档不计分，且把「计分的是哪一条」写进警告', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-capped', ['10.0.0.0/24']).id
    seedAssets(store, id)
    const meta = store.listScorePoints(id).items.find((x) => x.dedup_scope === 'service' && x.builtin === true)
    store.addScoreHit(id, { point_id: meta.id, target: '10.0.0.1:80', evidence: 'high tier', points: 30 })
    const lower = store.addScoreHit(id, { point_id: meta.id, target: '10.0.0.1:80', evidence: 'lower tier', points: 5 })
    assert.equal(lower.counted, false)
    assert.equal(lower.capped_by_service, true)
    assert.equal(lower.demoted_hits.length, 0, '没有顶掉任何东西（它自己才是不计分的那条）')
    assert.match(lower.warning, /这条按规则不再计分，只作过程留痕/)
    assert.match(lower.warning, /计分的是同服务的另一条：high tier/)
  })
})

/* =============================================================== 报告与图 */

test('报告：带 HTTP 证据的漏洞要出「复现请求」段，请求去 CR、响应截断', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-repro', ['10.0.0.0/24']).id
    const { a1 } = seedAssets(store, id)
    const v = store.addVuln(id, {
      title: 'SQL 注入', severity: 'high', status: 'exploited', asset_id: a1.id,
      target: 'http://10.0.0.1/a', evidence: 'union select 回显',
    })
    store.addHttpEvidence(id, {
      vuln_id: v.id, method: 'GET', url: 'http://10.0.0.1/a?id=1',
      request: 'GET /a?id=1 HTTP/1.1\r\nHost: 10.0.0.1\r\n\r\n',
      response: 'HTTP/1.1 200 OK\r\n\r\n' + 'x'.repeat(2500),
    })
    const text = store.report(id, {}).markdown
    assert.ok(text.includes('复现请求（可直接粘进 Burp Suite / Yakit）'), '段标题')
    assert.ok(text.includes('GET /a?id=1 HTTP/1.1\nHost: 10.0.0.1'), '请求里的 CR 必须去掉')
    assert.equal(text.includes('\r'), false, '整份报告里不该再有 CR')
    assert.equal(text.includes('x'.repeat(2000)), false, '响应摘要必须被截断到 2000 字符以内')
    assert.equal(text.includes('x'.repeat(1900)), true)
  })
})

test('报告：没有 HTTP 证据时不出「复现请求」段（不能留一个空壳标题）', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-repro0', ['10.0.0.0/24']).id
    const { a1 } = seedAssets(store, id)
    store.addVuln(id, { title: '目录遍历', severity: 'high', status: 'exploited', asset_id: a1.id, target: 'http://10.0.0.1/', evidence: '读了 /etc/passwd' })
    const text = store.report(id, {}).markdown
    assert.ok(text.includes('目录遍历'), '漏洞本身要在报告里')
    assert.equal(text.includes('复现请求'), false)
  })
})

test('attackGraph：段-资产-端口-漏洞四类节点用边连起来，summary 数得上', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-graph', ['10.0.0.0/24']).id
    const { a1 } = seedAssets(store, id)
    store.addVuln(id, { title: 'RCE', severity: 'critical', status: 'exploited', asset_id: a1.id, target: 'http://10.0.0.1/', evidence: 'id' })
    const g = store.attackGraph(id, {})
    assert.deepEqual(Object.keys(g).sort(), ['edges', 'nodes', 'summary'])
    const kinds = new Set(g.nodes.map((n) => n.kind))
    assert.deepEqual([...kinds].sort(), ['asset', 'port', 'segment', 'vuln'], '四类节点都要在图里')
    assert.equal(g.nodes.filter((n) => n.kind === 'asset').length, 3, '三台资产都进图')
    const edge = (rel) => g.edges.filter((e) => e.relation === rel).length
    assert.equal(edge('contains'), 3, 'segment → 每台资产各一条 contains')
    assert.equal(edge('has_vuln'), 1, '只有一条漏洞')
    assert.equal(edge('exposes'), 4, '每台资产的每个端口各一条 exposes（1 + 1 + 2）')
    assert.equal(g.summary.bySeverity.critical, 1)
    assert.equal(g.summary.byStatus.exploited, 1)
    assert.equal(g.summary.withEvidence, 1)
  })
})

/* ================================================================ 知识库 */

test('searchPocs：engagement 既认 id 也认名字子串，认不到时是空表', () => {
  withStore(({ store }) => {
    /* 名字与 id 刻意不同：id 是 slug（fac-poc-client），名字是中文件名。
       两条 SQL 分支才不会互相掩盖 —— 拿 id 去测「名字模糊匹配」会假绿。 */
    const eng = store.openEngagement('Fac POC 客户', ['10.0.0.0/24'])
    assert.notEqual(eng.id, eng.name, '前置条件：id 与 name 不同')
    store.savePoc({
      title: 'Tomcat 反序列化 CVE-2020-1111', kind: 'exp', category: 'rce', content: 'whoami',
      engagement_id: eng.id, engagement_name: eng.name,
    })
    store.savePoc({ title: 'Aapche 路径穿越', kind: 'exp', category: 'lfi', content: 'id' })
    assert.equal(store.searchPocs({}).length, 2)
    assert.equal(store.searchPocs({ engagement: eng.id }).length, 1, '按 id 精确命中')
    assert.equal(store.searchPocs({ engagement: '客户' }).length, 1, '按名字子串走 LIKE 分支')
    assert.equal(store.searchPocs({ engagement: 'nope' }).length, 0)
  })
})

/* ======================================================= 靶标列表与提示词 */

test('listEngagements：库坏了也照样列出靶标，统计位是 null（不是抛错、不是 0）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-purge-facets-bad-'))
  ROOTS.push(root)
  const store = new RedteamStore(root)
  const id = store.openEngagement('fac-bad', ['10.0.0.0/24']).id
  store.close()
  writeFileSync(join(root, 'engagements', id, 'assets.db'), 'not a sqlite file at all')
  const again = new RedteamStore(root)
  try {
    const list = again.listEngagements({ stats: true })
    assert.deepEqual(list.map((e) => e.id), [id], '坏库的靶标也要在列表里')
    assert.equal(list[0].stats, null, '统计位留 null：界面上「0 台资产」和「读不出来」不能混为一谈')
    assert.throws(() => again.stats(id), /not a database|file is encrypted/i, '直接问统计才抛')
  } finally {
    try { again.close() } catch { /* 忽略 */ }
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows EPERM */ }
  }
})

test('refreshDefaultPrompts：覆盖非默认正文前留一份 .bak，force 才动', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-prompt', ['10.0.0.0/24']).id
    const roles = store.listPrompts(id)
    const role = (Array.isArray(roles) ? roles : []).map((r) => r.role).find((r) => r === 'plan')
    assert.equal(role, 'plan', '先把默认提示词落盘')
    store.savePrompt(id, 'plan', 'CUSTOM BODY')
    const kept = store.refreshDefaultPrompts(id, {})
    assert.deepEqual(kept.kept, ['plan'], '内容不是默认值 → 默认跳过')
    assert.equal(kept.changed, 0)
    const forced = store.refreshDefaultPrompts(id, { force: true })
    assert.equal(forced.changed, 1, 'force 才覆盖')
    const baks = readdirSync(store.promptsDirOf(id)).filter((f) => f.includes('.bak-'))
    assert.equal(baks.length, 1, '覆盖前留一份 .bak')
    assert.equal(baks[0].startsWith('plan.md.bak-'), true)
  })
})

test('readAttackFile：库里的 path 被改成靶标目录之外时读不到正文，只回一句拒绝原因', () => {
  withStore(({ store }) => {
    const id = store.openEngagement('fac-af', ['10.0.0.0/24']).id
    const f = store.addAttackFile(id, { name: 'a.txt', target: '10.0.0.1', content: 'hello', evidence: 'verified' })
    assert.equal(store.readAttackFile(id, f.kind === undefined ? 1 : Number(store.db(id).prepare('SELECT MAX(id) AS n FROM attack_file').get().n)).content, 'hello')
    const fid = Number(store.db(id).prepare('SELECT MAX(id) AS n FROM attack_file').get().n)
    store.db(id).prepare('UPDATE attack_file SET path = ? WHERE id = ?').run('C:/Windows/win.ini', fid)
    const row = store.readAttackFile(id, fid)
    assert.match(row.content, /^\(rejected or read failed: /)
    assert.match(row.content, /path outside allowed roots/)
  })
})

/* ============================================================ 死代码守卫 */

test('源码形状：两处从未被调用的私有成员已经删掉，且 import 里不再带 hitTrace', () => {
  assert.equal(SRC.includes('isCappedPoint'), false, 'isCappedPoint 是死代码（定义处之外没有调用）')
  assert.equal(SRC.includes('#hitTrace'), false, '#hitTrace 只是转发出 score-report.js 的 hitTrace，没人调用')
  const importLine = SRC.split(/\r?\n/).find((l) => l.startsWith('import') && l.includes('./score-report.js'))
  assert.ok(importLine, 'score-report 的 import 还在')
  assert.equal(importLine.includes('hitTrace'), false, '删掉死方法之后这个名字也不该再 import')
  assert.ok(importLine.includes('representativeShots'), '真正在用的名字不能顺手删掉')
})
