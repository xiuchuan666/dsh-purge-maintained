// 事实库迁移（`lib/redteam/schema.js` 的 migrate / migrateKnowledge）。
//
// 为什么值得单独一个文件：迁移是**唯一一处「老库静默变形」的地方**。
// 它的失败方式不是报错，而是「跑过了但什么都没改」——因为每一段回填都包在
// `try { … } catch { /* 忽略 */ }` 里，任何 ReferenceError / SQL 错误都被吞掉，
// 库照常能打开、面板照常显示，只是 scope 全是空的、阶段映射全是 NULL。
//
// 实测踩过的两个真漏（2026-11-12）：
//   1. `migrate()` 里 `UPDATE asset SET scope = (${SCOPE_SQL})` —— SCOPE_SQL 在
//      schema.js 里**从未定义也从未 import**，ReferenceError 被 catch 吞掉，
//      老库的 scope 回填从上线起就没生效过；
//   2. `if (ensure('attack_step', 'stage_code', …))` 里的 LEGACY_STAGE_MAP 同样未定义，
//      补完列之后的映射回填一直静默跳过。
// 这两条都不是「代码读起来像对的」就能保证的，只有造出老库形状、跑一遍、看结果。
//
// 另一类断言是**可重复执行**：migrate 会被每次打开靶标调用，必须幂等，
// 且「第二次打开不许把新版阶段删掉」（源码里那条注释点名的坑）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  migrate, migrateKnowledge, DDL, KNOWLEDGE_DDL,
  POC_CATEGORIES, pocCategoryName, guessPocCategory,
} from '../lib/redteam/schema.js'
import { LEGACY_STAGE_MAP, SCOPE_SQL } from '../lib/redteam/engagement-meta.js'

/** 内存库 + 只建到「老版本」的形状，再交给 migrate。 */
function legacyDb({ assetColumns, attackStepColumns = ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'stage TEXT'] }) {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE asset (${assetColumns.join(', ')})`)
  db.exec(`CREATE TABLE attack_step (${attackStepColumns.join(', ')})`)
  return db
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
}

/* ────────────────────────────────────────────────────────────── 内外网回填 */

test('migrate：老库的 asset.scope 按 IP 归属回填（SCOPE_SQL 真的被引用到了）', () => {
  const db = legacyDb({
    assetColumns: ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'ip TEXT', 'scope TEXT',
      'first_seen TEXT', 'last_seen TEXT', 'discovered_at TEXT'],
  })
  const insert = db.prepare('INSERT INTO asset (ip) VALUES (?)')
  for (const ip of ['10.1.2.3', '192.168.5.5', '172.20.1.1', '127.0.0.1', '100.64.0.1', '8.8.8.8', '1.1.1.1']) insert.run(ip)
  migrate(db)
  const rows = db.prepare('SELECT ip, scope FROM asset ORDER BY ip').all()
  const byIp = Object.fromEntries(rows.map((r) => [r.ip, r.scope]))
  // RFC1918 + 回环 + CGNAT 判内网，其余外网 —— 与 SCOPE_SQL 的口径逐条对上
  assert.equal(byIp['10.1.2.3'], 'internal')
  assert.equal(byIp['192.168.5.5'], 'internal')
  assert.equal(byIp['172.20.1.1'], 'internal')
  assert.equal(byIp['127.0.0.1'], 'internal')
  assert.equal(byIp['100.64.0.1'], 'internal')
  assert.equal(byIp['8.8.8.8'], 'external')
  assert.equal(byIp['1.1.1.1'], 'external')
})

test('migrate：172 段只认 16–31，172.15 / 172.32 都是外网（边界不是「172. 开头就算」）', () => {
  const db = legacyDb({
    assetColumns: ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'ip TEXT', 'scope TEXT',
      'first_seen TEXT', 'last_seen TEXT', 'discovered_at TEXT'],
  })
  const insert = db.prepare('INSERT INTO asset (ip) VALUES (?)')
  for (const ip of ['172.15.0.1', '172.16.0.1', '172.31.255.254', '172.32.0.1']) insert.run(ip)
  migrate(db)
  const byIp = Object.fromEntries(db.prepare('SELECT ip, scope FROM asset').all().map((r) => [r.ip, r.scope]))
  assert.equal(byIp['172.15.0.1'], 'external')
  assert.equal(byIp['172.16.0.1'], 'internal')
  assert.equal(byIp['172.31.255.254'], 'internal')
  assert.equal(byIp['172.32.0.1'], 'external')
})

test('migrate：已经手工指定过 scope 的行不被覆盖（回填只碰 NULL 与空串）', () => {
  const db = legacyDb({
    assetColumns: ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'ip TEXT', 'scope TEXT',
      'first_seen TEXT', 'last_seen TEXT', 'discovered_at TEXT'],
  })
  db.prepare('INSERT INTO asset (ip, scope) VALUES (?, ?)').run('10.1.2.3', 'external')
  db.prepare('INSERT INTO asset (ip, scope) VALUES (?, ?)').run('8.8.8.8', 'internal')
  db.prepare('INSERT INTO asset (ip, scope) VALUES (?, ?)').run('10.9.9.9', '')
  migrate(db)
  const byIp = Object.fromEntries(db.prepare('SELECT ip, scope FROM asset').all().map((r) => [r.ip, r.scope]))
  // 手工指定的两个原样保留 —— 人比 SQL 推断可信
  assert.equal(byIp['10.1.2.3'], 'external')
  assert.equal(byIp['8.8.8.8'], 'internal')
  // 空串算「没有」，按 IP 回填
  assert.equal(byIp['10.9.9.9'], 'internal')
})

/* ────────────────────────────────────────────────────────── 阶段映射回填 */

test('migrate：老库补出 stage_code 列后，按 LEGACY_STAGE_MAP 把老阶段映射成新阶段', () => {
  const db = legacyDb({
    assetColumns: ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'ip TEXT'],
    attackStepColumns: ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'stage TEXT'],
  })
  const insert = db.prepare('INSERT INTO attack_step (stage) VALUES (?)')
  const legacyStages = Object.keys(LEGACY_STAGE_MAP)
  for (const s of legacyStages) insert.run(s)
  migrate(db)
  assert.ok(columnsOf(db, 'attack_step').includes('stage_code'))
  const rows = db.prepare('SELECT stage, stage_code FROM attack_step ORDER BY id').all()
  assert.equal(rows.length, legacyStages.length)
  for (const row of rows) {
    assert.equal(row.stage_code, LEGACY_STAGE_MAP[row.stage], `stage=${row.stage} 没映射到新阶段`)
  }
})

test('migrate：stage_code 列本来就存在时不再重跑映射（否则用户手工指定的阶段会被打回自动值）', () => {
  const db = legacyDb({
    assetColumns: ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'ip TEXT'],
    attackStepColumns: ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'stage TEXT', 'stage_code TEXT'],
  })
  // 用户显式指定 ⑤ 靶标权限，而 legacy stage 是 exploit —— 重跑映射会把它改成 internet
  db.prepare('INSERT INTO attack_step (stage, stage_code) VALUES (?, ?)').run('exploit', 'target')
  migrate(db)
  const row = db.prepare('SELECT stage, stage_code FROM attack_step').get()
  assert.equal(row.stage_code, 'target')
})

test('migrate：上一版的阶段 code 被清成 NULL，好让映射重来；但 target 不清（同名不同义）', () => {
  const db = legacyDb({
    assetColumns: ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'ip TEXT'],
    attackStepColumns: ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'stage TEXT', 'stage_code TEXT'],
  })
  const insert = db.prepare('INSERT INTO attack_step (stage, stage_code) VALUES (?, ?)')
  for (const code of ['external', 'foothold', 'tunnel', 'privilege', 'target', 'recon']) insert.run('x', code)
  migrate(db)
  const codes = db.prepare('SELECT stage_code FROM attack_step ORDER BY id').all().map((r) => r.stage_code)
  // 前四个是上一版的阶段名，已作废
  assert.deepEqual(codes.slice(0, 4), [null, null, null, null])
  // target 与 recon 在新版里仍是合法阶段，必须留着
  assert.equal(codes[4], 'target')
  assert.equal(codes[5], 'recon')
})

/* ──────────────────────────────────────────────────────── 其它回填与幂等 */

test('migrate：discovered_at 用 first_seen 顶上（只补空值）', () => {
  const db = legacyDb({
    assetColumns: ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'ip TEXT', 'scope TEXT',
      'first_seen TEXT', 'last_seen TEXT', 'discovered_at TEXT'],
  })
  const insert = db.prepare('INSERT INTO asset (ip, first_seen, last_seen, discovered_at) VALUES (?, ?, ?, ?)')
  insert.run('10.0.0.1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', null)
  insert.run('10.0.0.2', null, '2026-03-01T00:00:00Z', null)
  insert.run('10.0.0.3', '2026-01-01T00:00:00Z', null, '2026-04-01T00:00:00Z')
  migrate(db)
  const byIp = Object.fromEntries(db.prepare('SELECT ip, discovered_at FROM asset').all().map((r) => [r.ip, r.discovered_at]))
  assert.equal(byIp['10.0.0.1'], '2026-01-01T00:00:00Z')
  assert.equal(byIp['10.0.0.2'], '2026-03-01T00:00:00Z')
  assert.equal(byIp['10.0.0.3'], '2026-04-01T00:00:00Z') // 已有值不覆盖
})

test('migrate：score_hit.port 从 target 解析回填（解析不出来的保持 NULL）', () => {
  // 这里要的是「新库上跑迁移」，所以直接整套 DDL 建表 ——
  // 不能先手工建一个残缺的 asset（CREATE TABLE IF NOT EXISTS 会跳过它，
  // 紧接着 `ix_asset_segment ON asset(segment_cidr)` 就会报 no such column）。
  const db = new DatabaseSync(':memory:')
  db.exec(DDL)
  const pointId = db.prepare(
    "INSERT INTO score_point (code, name) VALUES ('x', 'x') RETURNING id",
  ).get().id
  const insert = db.prepare('INSERT INTO score_hit (point_id, target, port) VALUES (?, ?, ?)')
  insert.run(pointId, '10.0.0.5:8080', null)
  insert.run(pointId, 'http://10.0.0.5:9090/admin', null)
  insert.run(pointId, '10.0.0.5', null)
  insert.run(pointId, null, null)
  // 已经写过端口的行不许被 target 覆盖：工具传的 port 比从 target 猜的可信
  insert.run(pointId, '10.0.0.6:1234', 443)
  migrate(db)
  const ports = db.prepare('SELECT target, port FROM score_hit ORDER BY id').all()
  assert.equal(ports[0].port, 8080)
  assert.equal(ports[1].port, 9090)
  assert.equal(ports[2].port, null) // 没有端口就不瞎猜
  assert.equal(ports[3].port, null)
  assert.equal(ports[4].port, 443) // 已有值保留
})

test('migrate：可重复执行 —— 跑两遍结果完全一致，且第二遍不重建表', () => {
  const db = legacyDb({
    assetColumns: ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'ip TEXT', 'scope TEXT',
      'first_seen TEXT', 'last_seen TEXT', 'discovered_at TEXT'],
  })
  db.prepare('INSERT INTO asset (ip) VALUES (?)').run('10.1.2.3')
  migrate(db)
  const first = {
    columns: columnsOf(db, 'asset'),
    rows: db.prepare('SELECT ip, scope, discovered_at FROM asset').all(),
  }
  migrate(db)
  const second = {
    columns: columnsOf(db, 'asset'),
    rows: db.prepare('SELECT ip, scope, discovered_at FROM asset').all(),
  }
  assert.deepEqual(second, first)
})

test('migrate：空库（表都还不存在）不抛 —— 首次建库时回填全部静默跳过', () => {
  const db = new DatabaseSync(':memory:')
  assert.doesNotThrow(() => migrate(db))
  // 一个表都没建出来（migrate 只补列，不建表；建表是 DDL 的事）
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 0)
})

/* ─────────────────────────────────────────────────── 知识库迁移 */

function legacyKnowledgeDb() {
  const db = new DatabaseSync(':memory:')
  // 老形状：没有 category / engagement_* / asset_target / found_by_agent 五列
  db.exec(`CREATE TABLE poc (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT, title TEXT, cve TEXT, component TEXT, content TEXT
  )`)
  return db
}

test('migrateKnowledge：老库补出五个新列与两个索引', () => {
  const db = legacyKnowledgeDb()
  migrateKnowledge(db)
  const cols = columnsOf(db, 'poc')
  for (const c of ['category', 'engagement_id', 'engagement_name', 'asset_target', 'found_by_agent']) {
    assert.ok(cols.includes(c), `缺列 ${c}`)
  }
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'poc'").all().map((r) => r.name)
  assert.ok(indexes.includes('ix_poc_category'))
  assert.ok(indexes.includes('ix_poc_engagement'))
})

test('migrateKnowledge：category 为空的条目按 code/标题/组件推测归类', () => {
  const db = legacyKnowledgeDb()
  const insert = db.prepare('INSERT INTO poc (code, title, component) VALUES (?, ?, ?)')
  insert.run('CVE-2021-44228', 'Log4j2 JNDI 注入', 'log4j')
  insert.run(null, '备份文件与源码泄露', 'nginx')
  insert.run(null, '某系统未授权访问', 'actuator')
  insert.run(null, '完全没线索的一条', null)
  migrateKnowledge(db)
  const rows = db.prepare('SELECT title, category FROM poc ORDER BY id').all()
  assert.equal(rows[0].category, 'deserialization')
  assert.equal(rows[1].category, 'info-leak')
  assert.equal(rows[2].category, 'unauthorized')
  assert.equal(rows[3].category, 'other')
})

test('migrateKnowledge：已经有 category 的条目不被改写（人填的比推测可信）', () => {
  const db = legacyKnowledgeDb()
  db.exec("ALTER TABLE poc ADD COLUMN category TEXT")
  db.prepare('INSERT INTO poc (code, title, category) VALUES (?, ?, ?)').run('x', 'Log4j2 JNDI 注入', 'other')
  migrateKnowledge(db)
  assert.equal(db.prepare('SELECT category FROM poc').get().category, 'other')
})

test('migrateKnowledge：可重复执行', () => {
  const db = legacyKnowledgeDb()
  db.prepare('INSERT INTO poc (code, title, component) VALUES (?, ?, ?)').run('x', 'SQL 注入拖库', 'mysql')
  migrateKnowledge(db)
  const first = db.prepare('SELECT id, category FROM poc ORDER BY id').all()
  migrateKnowledge(db)
  const second = db.prepare('SELECT id, category FROM poc ORDER BY id').all()
  assert.deepEqual(second, first)
})

/* ─────────────────────────────────────────────────── 归类口径（纯函数） */

test('guessPocCategory：越具体的类别优先（「任意文件上传」压过泛化的「上传」）', () => {
  // 同时含「文件上传」与「注入」时，文件上传排在前面
  assert.equal(guessPocCategory('任意文件上传 getshell'), 'file-upload')
  // 只含注入关键词
  assert.equal(guessPocCategory('SQL 注入 拖库'), 'sqli')
  // 反序列化排在最前，哪怕标题里也提到 rce
  assert.equal(guessPocCategory('fastjson 反序列化 RCE'), 'deserialization')
})

test('guessPocCategory：都不中才落 other，空输入也是 other', () => {
  assert.equal(guessPocCategory('一条没有关键词的记录'), 'other')
  assert.equal(guessPocCategory(''), 'other')
  assert.equal(guessPocCategory(null), 'other')
})

test('pocCategoryName：已知 code 给中文名，未知 code 原样返回，空值给「未归类」', () => {
  const first = POC_CATEGORIES[0]
  assert.equal(pocCategoryName(first.code), first.name)
  assert.equal(pocCategoryName('my-own-category'), 'my-own-category')
  assert.equal(pocCategoryName(''), '未归类')
  assert.equal(pocCategoryName(null), '未归类')
})

test('POC_CATEGORIES：code 唯一、每项都有中文名与提示，且以 other 收尾', () => {
  const codes = POC_CATEGORIES.map((c) => c.code)
  assert.equal(new Set(codes).size, codes.length)
  for (const c of POC_CATEGORIES) {
    assert.ok(c.code && c.name && c.hint, `分类项不完整：${JSON.stringify(c)}`)
  }
  assert.equal(codes[codes.length - 1], 'other')
})

/* ──────────────────────────────────────────────── 建表口径（DDL 自洽） */

test('migrate：port 回填遇到解析不出的 target 不写 NULL（源码形状 —— 写 NULL 与不写等价，行为上测不出来）', () => {
  // 为什么只能钉源码：这段的 SELECT 已经过滤了 `port IS NULL`，
  // 所以「解析失败时 upd.run(null, id)」与「跳过」在库里产生的结果完全相同 ——
  // 一个是「本来就没值」，另一个是「写了个 NULL 上去」。行为断言区分不了，
  // 只有形状断言能防住有人把守卫删掉后误以为无害。
  const src = readFileSync(new URL('../lib/redteam/schema.js', import.meta.url), 'utf8')
  const at = src.indexOf('SELECT id, target FROM score_hit WHERE port IS NULL')
  assert.ok(at > 0, '找不到 port 回填段')
  const region = src.slice(at, at + 700)
  assert.match(region, /if \(port !== null\) upd\.run\(port, row\.id\)/)
})

test('DDL：能建出全套表，且 asset / score_hit 的关键列都在（含 migrate 补的那几列）', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(DDL)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name)
  for (const t of ['asset', 'score_hit', 'score_point', 'vuln', 'credential', 'webshell', 'tunnel', 'attack_step', 'stage', 'shot']) {
    assert.ok(tables.includes(t), `缺表 ${t}`)
  }
  // 建表语句里的列
  const assetCols = columnsOf(db, 'asset')
  for (const c of ['segment_cidr', 'ip', 'ip_int', 'discovered_at', 'test_status', 'blocked_count', 'priority']) {
    assert.ok(assetCols.includes(c), `asset 缺列 ${c}`)
  }
  const hitCols = columnsOf(db, 'score_hit')
  for (const c of ['point_id', 'points', 'multiplier', 'port']) {
    assert.ok(hitCols.includes(c), `score_hit 缺列 ${c}`)
  }
  // 这两列**不在** DDL 里，只由 migrate 补 —— 正好证明迁移确实是必需的一步
  assert.ok(!assetCols.includes('scope'), 'scope 不该写进 DDL（老库靠 migrate 补）')
  assert.ok(!hitCols.includes('stage_code'), 'stage_code 不该写进 DDL（老库靠 migrate 补）')
  migrate(db)
  assert.ok(columnsOf(db, 'asset').includes('scope'), 'migrate 没给 asset 补出 scope')
  assert.ok(columnsOf(db, 'score_hit').includes('stage_code'), 'migrate 没给 score_hit 补出 stage_code')
})

test('DDL：对已经建好的库重复执行不抛（CREATE TABLE IF NOT EXISTS）', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(DDL)
  assert.doesNotThrow(() => db.exec(DDL))
})

test('KNOWLEDGE_DDL：能建出 poc 表与全文检索列（FTS5 缺席时不建虚拟表）', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(KNOWLEDGE_DDL)
  const cols = columnsOf(db, 'poc')
  for (const c of ['code', 'title', 'cve', 'component', 'content', 'verified', 'kind']) {
    assert.ok(cols.includes(c), `poc 缺列 ${c}`)
  }
})

test('SCOPE_SQL 与 LEGACY_STAGE_MAP 确实从 engagement-meta.js 导出（schema.js 靠它们回填）', () => {
  assert.equal(typeof SCOPE_SQL, 'string')
  assert.match(SCOPE_SQL, /THEN 'internal' ELSE 'external' END/)
  assert.ok(LEGACY_STAGE_MAP && typeof LEGACY_STAGE_MAP === 'object')
  // 上一版的阶段名 → 新版五个阶段之一
  assert.deepEqual(Object.keys(LEGACY_STAGE_MAP).sort(),
    ['access', 'data', 'exploit', 'other', 'pivot', 'recon', 'vuln'])
  for (const v of Object.values(LEGACY_STAGE_MAP)) {
    assert.ok(['recon', 'internet', 'boundary', 'internal', 'target'].includes(v), `映射目标不是合法阶段：${v}`)
  }
})
