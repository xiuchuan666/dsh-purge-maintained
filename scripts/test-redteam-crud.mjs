// 演练台 CRUD 与写库归一化：什么值允许进库、重复登记怎么合并、非法值报错还是静默回落。
//
// 为什么值得单独一个文件：这些方法是**模型直接调的写入口**（`redteam_vuln_add` /
// `redteam_webshell_add` / `redteam_tunnel_add` …）。它们对非法值的处理分三种，
// 而且三种都出现在同一个文件里：
//   1. 静默回落（`addVuln` 的 severity/status → info/candidate）—— 写错了不报错；
//   2. 直接抛错（`addTunnel` 的 entry_kind、`normalizeShellType`）—— 因为写错会让
//      界面红标静默失效，而事后完全查不出原因；
//   3. 保留旧值（`updateVuln` 的 status/severity）—— 只改传进来的字段。
// 这三种行为都不能靠"读代码时觉得合理"来保证，只有断言钉住。
//
// 另一类断言是**幂等**：同一条漏洞重复登记、同一个 webshell 重复登记，
// 必须是 UPDATE 而不是插第二条，否则面板上会堆满重复项。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore, targetKey } from '../lib/redteam/store-core.js'
import { WEBSHELL_STATUSES, normalizeShellStatus, normalizeShellType } from '../lib/redteam/validate.js'
import { TUNNEL_ENTRY_KINDS, tunnelIsLegit } from '../lib/redteam/score-rules.js'

/**
 * 开一个临时靶标库跑 fn。
 *
 * 清理要吞异常：Windows 上刚 close 过的 SQLite 目录偶尔会 EPERM，
 * 让清理失败冒出去会把「测试通过」变成「测试报错」。
 */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purge-crud-'))
  const store = new RedteamStore(dir)
  try {
    const eng = store.openEngagement('crud', [])
    return fn({ store, eng, db: store.db(eng.id) })
  } finally {
    try { store.close() } catch { /* 已关闭 */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows EPERM */ }
  }
}

/** 直接插资产行：CRUD 只按 id 引用资产，界面展示才需要 ip。 */
function addAsset(db, ip, cidr = '10.0.0.0/24') {
  db.prepare('INSERT INTO asset(ip, segment_cidr, state) VALUES(?,?,?)').run(ip, cidr, 'live')
  return Number(db.prepare('SELECT id FROM asset ORDER BY id DESC LIMIT 1').get().id)
}

const obsOf = (db) => db.prepare('SELECT entity_kind, attr, value, provenance FROM observation ORDER BY id').all()

/* ---------- 目标归并：聚合视图按「站点/服务」分组 ---------- */

test('targetKey 把 URL 截到 scheme+host+port', () => {
  assert.equal(targetKey('http://10.0.0.5:8080/a/b?x=1', null), 'http://10.0.0.5:8080')
  assert.equal(targetKey('https://a.example.com/p', '10.0.0.1'), 'https://a.example.com')
})

test('targetKey 对非 URL 取首个非空白段', () => {
  assert.equal(targetKey('10.0.0.5:6379', null), '10.0.0.5:6379')
  assert.equal(targetKey('not a url at all', null), 'not')
})

test('targetKey 空值回落到资产 IP', () => {
  assert.equal(targetKey('', '10.9.9.9'), '10.9.9.9')
  assert.equal(targetKey('   ', '10.9.9.9'), '10.9.9.9')
  assert.equal(targetKey(null, null), '（未指定靶标）')
})

/* ---------- 写库前的枚举规范化 ---------- */

test('normalizeShellType 认中文别名与大小写，空值算未声明', () => {
  assert.equal(normalizeShellType(undefined), null)
  assert.equal(normalizeShellType('   '), null)
  assert.equal(normalizeShellType('冰蝎'), 'behinder')
  assert.equal(normalizeShellType('BEHINDER'), 'behinder')
  assert.equal(normalizeShellType('哥斯拉'), 'godzilla')
  assert.equal(normalizeShellType('蚁剑'), 'antSword')
  assert.equal(normalizeShellType('自研'), 'custom')
})

test('normalizeShellType 认不出就抛错，而不是静默存原文', () => {
  assert.throws(() => normalizeShellType('bogus'), /webshell shell_type 非法/)
})

test('normalizeShellStatus 收别名、空值默认 online', () => {
  assert.equal(normalizeShellStatus(undefined), 'online')
  assert.equal(normalizeShellStatus(''), 'online')
  assert.equal(normalizeShellStatus('up'), 'online')
  assert.equal(normalizeShellStatus('alive'), 'online')
  assert.equal(normalizeShellStatus('down'), 'offline')
  assert.equal(normalizeShellStatus('failed'), 'offline')
  assert.equal(normalizeShellStatus('removed'), 'dead')
  assert.equal(normalizeShellStatus('ONLINE'), 'online')
})

test('normalizeShellStatus 认不出就抛错并列出合法值', () => {
  assert.throws(() => normalizeShellStatus('bogus'), /webshell status 非法/)
  assert.equal(WEBSHELL_STATUSES.join(','), 'online,offline,dead,unknown')
})

test('tunnelIsLegit：未声明待确认、self-only 不算、其余都算', () => {
  assert.equal(tunnelIsLegit(''), null)
  assert.equal(tunnelIsLegit(null), null)
  assert.equal(tunnelIsLegit('self-only'), false)
  assert.equal(tunnelIsLegit('target-http'), true)
  assert.equal(tunnelIsLegit('  target-agent  '), true)
})

test('TUNNEL_ENTRY_KINDS 恰好四种', () => {
  assert.deepEqual(Object.keys(TUNNEL_ENTRY_KINDS), ['target-outbound', 'target-http', 'target-agent', 'self-only'])
})

/* ---------- 漏洞：静默回落 + 幂等 ---------- */

test('addVuln 对非法 severity/status 静默回落到 info/candidate', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  const r = store.addVuln(eng.id, { asset_id: a, title: 'SQLi', severity: 'bogus', status: 'bogus' })
  assert.equal(r.updated, false)
  const row = db.prepare('SELECT severity, status FROM vuln WHERE id = ?').get(r.id)
  assert.equal(row.severity, 'info')
  assert.equal(row.status, 'candidate')
}))

test('addVuln 带 cve 时按 (asset, cve, target) 幂等', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  const first = store.addVuln(eng.id, { asset_id: a, cve: 'CVE-2021-1', title: 'x', severity: 'critical' })
  const again = store.addVuln(eng.id, { asset_id: a, cve: 'CVE-2021-1', title: 'y', severity: 'high' })
  assert.equal(again.id, first.id)
  assert.equal(again.updated, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vuln').get().n, 1)
  assert.equal(db.prepare('SELECT title, severity FROM vuln WHERE id = ?').get(first.id).title, 'y')
}))

test('addVuln 带 cve 时 target 也参与去重', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  const first = store.addVuln(eng.id, { asset_id: a, cve: 'CVE-2021-1', title: 'x', target: 'http://a/1' })
  const same = store.addVuln(eng.id, { asset_id: a, cve: 'CVE-2021-1', title: 'x', target: 'http://a/1' })
  const other = store.addVuln(eng.id, { asset_id: a, cve: 'CVE-2021-1', title: 'x', target: 'http://a/2' })
  assert.equal(same.id, first.id)
  assert.equal(same.updated, true)
  assert.notEqual(other.id, first.id)
  assert.equal(other.updated, false)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vuln').get().n, 2)
}))

test('addVuln 不带 cve 时按 (asset, title, target) 幂等，换 target 就是另一条', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  const first = store.addVuln(eng.id, { asset_id: a, title: 'XSS' })
  assert.equal(store.addVuln(eng.id, { asset_id: a, title: 'XSS' }).id, first.id)
  const other = store.addVuln(eng.id, { asset_id: a, title: 'XSS', target: 'http://a/b' })
  assert.notEqual(other.id, first.id)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vuln').get().n, 2)
}))

test('addVuln 只在挂到资产上时写一条 observation', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  store.addVuln(eng.id, { title: '无资产' })
  assert.equal(obsOf(db).length, 0)
  store.addVuln(eng.id, { asset_id: a, cve: 'CVE-9', title: '有资产' })
  const obs = obsOf(db)
  assert.equal(obs.length, 1)
  assert.equal(obs[0].entity_kind, 'asset')
  assert.equal(obs[0].attr, 'vuln')
  assert.equal(obs[0].value, 'CVE-9 有资产')
}))

test('addVuln 把 gained 规范成一行短标签', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  const r = store.addVuln(eng.id, { asset_id: a, title: 'x', gained: ['shell', ' db '] })
  assert.equal(db.prepare('SELECT gained FROM vuln WHERE id = ?').get(r.id).gained, 'shell, db')
  const r2 = store.addVuln(eng.id, { asset_id: a, title: 'y', gained: 'a;b，c' })
  assert.equal(db.prepare('SELECT gained FROM vuln WHERE id = ?').get(r2.id).gained, 'a, b, c')
  const r3 = store.addVuln(eng.id, { asset_id: a, title: 'z', gained: '  ' })
  assert.equal(db.prepare('SELECT gained FROM vuln WHERE id = ?').get(r3.id).gained, null)
}))

/* ---------- 漏洞列表：筛选、上限、证据截断 ---------- */

test('listVulns 的筛选条件各自生效', () => withStore(({ store, eng, db }) => {
  const a1 = addAsset(db, '10.0.0.5')
  const a2 = addAsset(db, '192.168.1.7', '192.168.1.0/24')
  store.addVuln(eng.id, { asset_id: a1, title: 'SQLi login', severity: 'critical', cve: 'CVE-2020-1', target: 'http://10.0.0.5:8080/a', evidence: 'payload' })
  store.addVuln(eng.id, { asset_id: a1, title: 'XSS', severity: 'low' })
  store.addVuln(eng.id, { asset_id: a2, title: 'RCE', severity: 'high', target: '192.168.1.7:6379' })
  assert.equal(store.listVulns(eng.id).total, 3)
  assert.deepEqual(store.listVulns(eng.id, { severity: 'critical' }).items.map((v) => v.title), ['SQLi login'])
  assert.equal(store.listVulns(eng.id, { cve: '2020' }).total, 1)
  assert.equal(store.listVulns(eng.id, { asset_id: a1 }).total, 2)
  assert.deepEqual(store.listVulns(eng.id, { cidr: '192.168.1.0/24' }).items.map((v) => v.title), ['RCE'])
  assert.deepEqual(store.listVulns(eng.id, { q: 'RCE' }).items.map((v) => v.title), ['RCE'])
  assert.deepEqual(store.listVulns(eng.id, { q: 'payload' }).items.map((v) => v.title), ['SQLi login'])
}))

test('listVulns 按严重度优先级排，同级按 id 倒序', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  store.addVuln(eng.id, { asset_id: a, title: 'low-1', severity: 'low' })
  store.addVuln(eng.id, { asset_id: a, title: 'crit', severity: 'critical' })
  store.addVuln(eng.id, { asset_id: a, title: 'low-2', severity: 'low' })
  assert.deepEqual(store.listVulns(eng.id).items.map((v) => v.title), ['crit', 'low-2', 'low-1'])
}))

test('listVulns 的 limit 上限是 1000（超过就截到 1000）', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  const stmt = db.prepare('INSERT INTO vuln(asset_id, title, severity, status, found_at) VALUES(?,?,?,?,?)')
  // node:sqlite 的 DatabaseSync 没有 better-sqlite3 的 transaction()，手工开事务。
  db.exec('BEGIN')
  for (let i = 0; i < 1005; i += 1) stmt.run(a, 'v' + i, 'info', 'candidate', '2026-01-01T00:00:00.000Z')
  db.exec('COMMIT')
  assert.equal(store.listVulns(eng.id).total, 1005)
  assert.equal(store.listVulns(eng.id).items.length, 200)
  assert.equal(store.listVulns(eng.id, { limit: 5000 }).items.length, 1000)
}))

test('listVulns 的 limit 夹在 1..1000，非法值回落 200', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  for (let i = 0; i < 5; i += 1) store.addVuln(eng.id, { asset_id: a, title: `v${i}` })
  assert.equal(store.listVulns(eng.id, { limit: 1 }).items.length, 1)
  assert.equal(store.listVulns(eng.id, { limit: 5000 }).items.length, 5)
  assert.equal(store.listVulns(eng.id, { limit: 'x' }).items.length, 5)
}))

test('listVulns 默认截断证据到 8000 字符，显式传 evidenceLimit 才拿全文', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  const r = store.addVuln(eng.id, { asset_id: a, title: 'x', cve: 'CVE-1' })
  store.addHttpEvidence(eng.id, { vuln_id: r.id, label: 'req', method: 'POST', url: 'http://x', request: 'A'.repeat(9000), response: 'B'.repeat(100) })
  const def = store.listVulns(eng.id).items[0].http_evidence[0]
  assert.equal(def.request.length, 8000 + '\n… (truncated)'.length)
  assert.match(def.request, /… \(truncated\)$/)
  assert.equal(def.response, 'B'.repeat(100))
  assert.equal(store.listVulns(eng.id, { evidenceLimit: 60000 }).items[0].http_evidence[0].request.length, 9000)
  assert.equal(store.listVulns(eng.id, { evidenceLimit: 5 }).items[0].http_evidence[0].request, 'AAAAA\n… (truncated)')
}))

/* ---------- 漏洞更新：缺行不抛、非法值保留旧值 ---------- */

test('updateVuln 对不存在的行返回 updated:false 而不是抛错', () => withStore(({ store, eng }) => {
  assert.deepEqual(store.updateVuln(eng.id, 999, { status: 'fixed' }), { updated: false })
}))

test('updateVuln 对非法 status/severity 保留旧值，gained 仍会规范化', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  const r = store.addVuln(eng.id, { asset_id: a, title: 'x', severity: 'high', status: 'confirmed' })
  assert.equal(store.updateVuln(eng.id, r.id, { status: 'bogus', severity: 'bogus', gained: 'a;b，c' }).updated, true)
  const row = db.prepare('SELECT status, severity, gained FROM vuln WHERE id = ?').get(r.id)
  assert.equal(row.status, 'confirmed')
  assert.equal(row.severity, 'high')
  assert.equal(row.gained, 'a, b, c')
}))

/* ---------- 漏洞统计：按站点归并 ---------- */

test('vulnStats 的 targetGroups 按站点归并而不是按完整 URL', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  store.addVuln(eng.id, { asset_id: a, title: 'a', severity: 'critical', target: 'http://10.0.0.5:8080/x' })
  store.addVuln(eng.id, { asset_id: a, title: 'b', severity: 'low', target: 'http://10.0.0.5:8080/y' })
  store.addVuln(eng.id, { asset_id: a, title: 'c', severity: 'high', target: '10.0.0.5:6379' })
  const s = store.vulnStats(eng.id)
  assert.equal(s.total, 3)
  assert.deepEqual(s.bySeverity, { critical: 1, low: 1, high: 1 })
  assert.equal(s.targetGroups, 2)
}))

test('vulnStats 的 withGained / withEvidence 只数有内容的', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  const withGain = store.addVuln(eng.id, { asset_id: a, title: 'g', gained: 'shell' })
  store.addVuln(eng.id, { asset_id: a, title: 'plain' })
  store.addHttpEvidence(eng.id, { vuln_id: withGain.id, label: 'e' })
  const s = store.vulnStats(eng.id)
  assert.equal(s.total, 2)
  assert.equal(s.withGained, 1)
  assert.equal(s.withEvidence, 1)
}))

/* ---------- 凭据：host 必填、别名优先级、冲突保留旧值 ---------- */

test('addCredential 缺 host 抛错', () => withStore(({ store, eng }) => {
  assert.throws(() => store.addCredential(eng.id, {}), /credential\.host 必填/)
}))

test('addCredential 的明文取值优先级 secret_value > secret > password > value', () => withStore(({ store, eng, db }) => {
  const r = store.addCredential(eng.id, { host: 'h1', username: 'u', value: 'v', password: 'p', secret: 's', secret_value: 'sv' })
  assert.equal(db.prepare('SELECT secret_value FROM credential WHERE id = ?').get(r.id).secret_value, 'sv')
  const r2 = store.addCredential(eng.id, { host: 'h2', username: 'u', password: 'p', secret: 's' })
  assert.equal(db.prepare('SELECT secret_value FROM credential WHERE id = ?').get(r2.id).secret_value, 's')
}))

test('addCredential 同 (host, username, secret_type) 冲突时保留旧值但刷新 found_at', () => withStore(({ store, eng, db }) => {
  const r = store.addCredential(eng.id, { host: 'h1', username: 'u', secret_value: 'p1', note: 'first' })
  const again = store.addCredential(eng.id, { host: 'h1', username: 'u' })
  assert.equal(again.id, r.id)
  const row = db.prepare('SELECT secret_value, note, found_at FROM credential WHERE id = ?').get(r.id)
  assert.equal(row.secret_value, 'p1')
  assert.equal(row.note, 'first')
  assert.ok(row.found_at)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credential').get().n, 1)
}))

test('listCredentials 的 withValue 只返回有明文的', () => withStore(({ store, eng }) => {
  store.addCredential(eng.id, { host: 'h1', username: 'a', secret_value: 'p' })
  store.addCredential(eng.id, { host: 'h1', username: 'b', secret_ref: 'vault://x' })
  assert.equal(store.listCredentials(eng.id).length, 2)
  assert.equal(store.listCredentials(eng.id, { withValue: true }).length, 1)
  assert.equal(store.listCredentials(eng.id, { username: 'b' }).length, 1)
}))

/* ---------- 访问会话 ---------- */

test('addAccess 缺 host 抛错，挂资产时写 observation', () => withStore(({ store, eng, db }) => {
  assert.throws(() => store.addAccess(eng.id, {}), /access\.host 必填/)
  const a = addAsset(db, '10.0.0.5')
  const r = store.addAccess(eng.id, { host: 'h2', asset_id: a, method: 'ssh', username: 'root', privilege: 'root' })
  assert.equal(store.listAccess(eng.id).length, 1)
  const obs = obsOf(db)
  assert.equal(obs.length, 1)
  assert.equal(obs[0].attr, 'access')
  assert.equal(obs[0].value, 'ssh root root')
  assert.ok(r.id > 0)
}))

/* ---------- WebShell ---------- */

test('addWebshell 缺 url 抛错', () => withStore(({ store, eng }) => {
  assert.throws(() => store.addWebshell(eng.id, {}), /webshell\.url 必填/)
}))

test('addWebshell 同 url+pass_key 重复登记是 UPDATE 而不是插第二条', () => withStore(({ store, eng, db }) => {
  const first = store.addWebshell(eng.id, { url: 'http://t/s.jsp', pass_key: 'k', shell_type: '冰蝎' })
  assert.equal(first.updated, false)
  const again = store.addWebshell(eng.id, { url: 'http://t/s.jsp', pass_key: 'k', shell_type: 'godzilla' })
  assert.equal(again.id, first.id)
  assert.equal(again.updated, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM webshell').get().n, 1)
  assert.equal(db.prepare('SELECT shell_type FROM webshell WHERE id = ?').get(first.id).shell_type, 'godzilla')
}))

test('addWebshell 换 pass_key 就是另一条', () => withStore(({ store, eng, db }) => {
  store.addWebshell(eng.id, { url: 'http://t/s.jsp', pass_key: 'k1' })
  store.addWebshell(eng.id, { url: 'http://t/s.jsp', pass_key: 'k2' })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM webshell').get().n, 2)
}))

// 现状锁定，不是期望行为：重复登记时 `normalizeShellStatus(undefined)` 得到 "online"，
// 而 UPDATE 写的是 `status = COALESCE(?, status)` —— 于是"没传状态"会把 down 覆盖回 online。
// 改它属产品决策（要区分"没传"与"传了 online"），这里只保证改动无法悄悄发生。
test('addWebshell 重复登记不传 status 会把状态覆盖回 online（现状锁定）', () => withStore(({ store, eng }) => {
  store.addWebshell(eng.id, { url: 'u1', pass_key: 'k', status: 'down' })
  assert.equal(store.listWebshells(eng.id)[0].status, 'offline')
  store.addWebshell(eng.id, { url: 'u1', pass_key: 'k' })
  assert.equal(store.listWebshells(eng.id)[0].status, 'online')
}))

test('updateWebshell 走同一套规范化，非法值抛错', () => withStore(({ store, eng }) => {
  const r = store.addWebshell(eng.id, { url: 'http://t/s.jsp' })
  assert.throws(() => store.updateWebshell(eng.id, r.id, {}), /没有可更新的字段/)
  assert.throws(() => store.updateWebshell(eng.id, r.id, { status: 'bogus' }), /webshell status 非法/)
  assert.throws(() => store.updateWebshell(eng.id, r.id, { shell_type: 'bogus' }), /webshell shell_type 非法/)
  assert.deepEqual(store.updateWebshell(eng.id, r.id, { status: 'down', shell_type: '哥斯拉' }), { updated: true })
  assert.equal(store.listWebshells(eng.id)[0].shell_type, 'godzilla')
}))

test('updateWebshell 对不存在的 id 抛 webshell 不存在', () => withStore(({ store, eng }) => {
  assert.throws(() => store.updateWebshell(eng.id, 999, { note: 'x' }), /webshell 不存在/)
}))

/* ---------- 隧道：entry_kind 是得分凭证，写错必须报错 ---------- */

test('addTunnel 的 entry_kind 非法值抛错并列出合法值', () => withStore(({ store, eng }) => {
  assert.throws(() => store.addTunnel(eng.id, { entry_kind: 'bogus' }), /entry_kind 非法/)
  // 前后空白是容忍的（trim 后再查表）——模型多打一个空格不该被判非法。
  assert.equal(store.addTunnel(eng.id, { entry_kind: ' target-http  ' }).entry_kind, 'target-http')
  assert.throws(() => store.addTunnel(eng.id, { entry_kind: 'target-httpx' }), /entry_kind 非法/)
}))

test('addTunnel 不声明 entry_kind 落 null 并给「建议补」提示', () => withStore(({ store, eng }) => {
  const r = store.addTunnel(eng.id, { kind: 'socks5', listen: '0.0.0.0:1080' })
  assert.equal(r.entry_kind, null)
  assert.equal(r.legit, null)
  assert.match(r.warning, /建议补 entry_kind/)
  const blank = store.addTunnel(eng.id, { entry_kind: '   ' })
  assert.equal(blank.entry_kind, null)
}))

test('addTunnel 的 self-only 标 legit:false 并给警告，其它目标侧取值 legit:true', () => withStore(({ store, eng }) => {
  const self = store.addTunnel(eng.id, { entry_kind: 'self-only' })
  assert.equal(self.legit, false)
  assert.match(self.warning, /不算隧道、不算边界突破/)
  const http = store.addTunnel(eng.id, { entry_kind: ' target-http ' })
  assert.equal(http.entry_kind, 'target-http')
  assert.equal(http.legit, true)
  assert.equal(http.warning, undefined)
}))

test('listTunnels 每条都挂 legit 与中文标签', () => withStore(({ store, eng }) => {
  store.addTunnel(eng.id, { entry_kind: 'target-agent' })
  store.addTunnel(eng.id, { entry_kind: 'self-only' })
  store.addTunnel(eng.id, {})
  const rows = store.listTunnels(eng.id)
  assert.deepEqual(rows.map((t) => t.legit), [null, false, true])
  assert.equal(rows[2].entry_kind_label, TUNNEL_ENTRY_KINDS['target-agent'])
  assert.equal(rows[0].entry_kind_label, null)
}))

test('updateTunnel 校验 status 与 entry_kind，空 patch 与缺行各有报错', () => withStore(({ store, eng }) => {
  const r = store.addTunnel(eng.id, { entry_kind: 'target-http' })
  assert.throws(() => store.updateTunnel(eng.id, r.id, {}), /没有可更新的字段/)
  assert.throws(() => store.updateTunnel(eng.id, r.id, { status: 'bogus' }), /隧道状态非法/)
  assert.throws(() => store.updateTunnel(eng.id, r.id, { entry_kind: 'bogus' }), /entry_kind 非法/)
  assert.throws(() => store.updateTunnel(eng.id, 999, { note: 'x' }), /隧道不存在/)
  assert.deepEqual(store.updateTunnel(eng.id, r.id, { entry_kind: '  ', status: 'down' }), { updated: true })
  const row = store.listTunnels(eng.id)[0]
  assert.equal(row.entry_kind, null)
  assert.equal(row.status, 'down')
}))

// 现状锁定：新增路径不校验 status（只有 update 校验），写进去什么就是什么。
test('addTunnel 不校验 status（现状锁定）', () => withStore(({ store, eng }) => {
  store.addTunnel(eng.id, { status: 'bogus', entry_kind: 'target-http' })
  assert.equal(store.listTunnels(eng.id)[0].status, 'bogus')
}))

/* ---------- 资产测试状态 ---------- */

test('updateAssetTest 找不到资产时抛错', () => withStore(({ store, eng }) => {
  assert.throws(() => store.updateAssetTest(eng.id, {}), /asset not found/)
  assert.throws(() => store.updateAssetTest(eng.id, { asset_id: 999 }), /asset not found/)
}))

test('updateAssetTest 非法 status 保留原值，test 与 notes 都追加到记录里', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  const first = store.updateAssetTest(eng.id, { ip: '10.0.0.5', status: 'bogus' })
  assert.equal(first.status, 'untested')
  const r = store.updateAssetTest(eng.id, { asset_id: a, test: 'ran nmap', notes: 'also notes' })
  assert.match(r.test_notes, /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] ran nmap; also notes$/)
  const again = store.updateAssetTest(eng.id, { asset_id: a, test: 'second' })
  assert.equal(again.test_notes.split('\n').length, 2)
}))

test('updateAssetTest 的 blocked 累加，到第 3 次给转向提示', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  assert.equal(store.updateAssetTest(eng.id, { asset_id: a, blocked: true }).blocked_count, 1)
  assert.equal(store.updateAssetTest(eng.id, { asset_id: a, blocked: true }).blocked_count, 2)
  const third = store.updateAssetTest(eng.id, { asset_id: a, blocked: true })
  assert.equal(third.blocked_count, 3)
  assert.match(third.hint, /超过 3 次规则/)
  assert.equal(store.updateAssetTest(eng.id, { asset_id: a, test: 'x' }).blocked_count, 3)
}))

test('updateAssetTest 每次写测试记录都留一条 observation', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5')
  store.updateAssetTest(eng.id, { asset_id: a, test: 'one' })
  store.updateAssetTest(eng.id, { asset_id: a, blocked: true })
  const obs = obsOf(db)
  assert.deepEqual(obs.map((o) => o.attr), ['test', 'blocked'])
  assert.equal(obs[1].value, 'blocked 1 time(s)')
}))

/* ---------- 资产评估 ---------- */

test('assessAsset 非法 priority 保留原值，找不到资产抛错', () => withStore(({ store, eng, db }) => {
  addAsset(db, '10.0.0.5')
  const r = store.assessAsset(eng.id, { ip: '10.0.0.5', priority: 'bogus', potential: 'p' })
  assert.equal(r.priority, 'medium')
  assert.equal(r.potential, 'p')
  assert.throws(() => store.assessAsset(eng.id, {}), /asset not found/)
}))
