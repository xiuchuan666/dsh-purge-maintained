// 三件「写错了也不报错」的事：旧得分项清理、多值测状态筛选、步骤连带记分。
//
// 为什么值得单独一个文件：
//   1. **旧得分项清理**是不可逆的破坏性操作 —— 清掉的是用户库里的得分点与命中。
//      判错「是否内置」的后果是：用户自建的得分点在下次读取得分面板时连同命中被静默
//      删掉，而 saveScorePoint 照样返回 ok、界面照样弹「已保存」。
//      还有一条硬纪律：**没存档成功就不删**（宁可旧点多留一轮，也不静默丢证据）。
//   2. **多值 test_status** 是「被封的资产别再去碰」这条工作流的入口。单值被当成
//      逗号串处理、或者逗号串被当成精确匹配，表现都是「筛出来的队列不对」，而不是报错。
//   3. **步骤连带记分**是模型最常走的一条路（写步骤时顺手给 point_code）。它错的方式
//      是「步骤入库了、分没记」或者「记了分但说不清怎么拿的」，两种都不报错。
//
// 这三个都只靠读代码时觉得合理是不够的，必须用真实 SQLite 库跑出来钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore } from '../lib/redteam/store-core.js'

/** 开一个临时库跑 fn；清理吞异常（Windows 上刚 close 的 SQLite 目录偶尔 EPERM）。 */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purge-legacy-score-'))
  const store = new RedteamStore(dir)
  try {
    return fn({ store, dir })
  } finally {
    try { store.close() } catch { /* 已关闭 */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows EPERM */ }
  }
}

/** 造一个靶标，并在它的库里插一条「旧体系」得分点（可选再插一条命中）。 */
function legacyPoint(store, eng, { code = 'web-account-old', builtin = 1, legacy = 0, withHit = false } = {}) {
  const db = store.db(eng.id)
  db.prepare('INSERT INTO score_point(code, name, category, points, builtin, legacy) VALUES(?,?,?,?,?,?)')
    .run(code, '旧得分点 ' + code, '旧体系', 50, builtin, legacy)
  const id = Number(db.prepare('SELECT id FROM score_point WHERE code = ?').get(code).id)
  if (withHit) {
    db.prepare('INSERT INTO score_hit(point_id, evidence, recorded_at) VALUES(?,?,?)')
      .run(id, '旧证据：admin 口令', new Date().toISOString())
  }
  return { db, id }
}

const archiveFiles = (store, eng) => {
  const runs = join(store.dirOf(eng.id), 'runs')
  if (!existsSync(runs)) return []
  return readdirSync(runs).filter((f) => f.startsWith('legacy-score-'))
}

/* ============================================================ 多值 test_status */

test('listAssets：test_status 单值仍然精确匹配', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('multi-single', [])
    const db = store.db(eng.id)
    const mk = (ip, st) => db.prepare('INSERT INTO asset(ip, segment_cidr, state, test_status) VALUES(?,?,?,?)')
      .run(ip, '10.0.0.0/24', 'live', st)
    mk('10.0.0.1', 'abandoned')
    mk('10.0.0.2', 'blocked')
    mk('10.0.0.3', 'tested')
    const ips = store.listAssets(eng.id, { test_status: 'abandoned' }).items.map((a) => a.ip)
    assert.deepEqual(ips, ['10.0.0.1'])
  })
})

test('listAssets：test_status 逗号串是「或」，写成 IN 而不是等号', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('multi-two', [])
    const db = store.db(eng.id)
    const mk = (ip, st) => db.prepare('INSERT INTO asset(ip, segment_cidr, state, test_status) VALUES(?,?,?,?)')
      .run(ip, '10.0.0.0/24', 'live', st)
    mk('10.0.0.1', 'abandoned')
    mk('10.0.0.2', 'blocked')
    mk('10.0.0.3', 'tested')
    const ips = store.listAssets(eng.id, { test_status: 'abandoned,blocked' }).items.map((a) => a.ip).sort()
    assert.deepEqual(ips, ['10.0.0.1', '10.0.0.2'], '两个状态都要出来')
    /* 精确匹配那条会把逗号串当字面值 → 一条都查不到。这条断言就是用来区分两种实现的。 */
    assert.notEqual(store.listAssets(eng.id, { test_status: 'abandoned,blocked' }).items.length, 0)
  })
})

test('listAssets：逗号串两头与中间的空格都被 trim，空段被丢掉', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('multi-space', [])
    const db = store.db(eng.id)
    const mk = (ip, st) => db.prepare('INSERT INTO asset(ip, segment_cidr, state, test_status) VALUES(?,?,?,?)')
      .run(ip, '10.0.0.0/24', 'live', st)
    mk('10.0.0.1', 'abandoned')
    mk('10.0.0.2', 'blocked')
    const ips = store.listAssets(eng.id, { test_status: ' blocked ,, abandoned ' }).items.map((a) => a.ip).sort()
    assert.deepEqual(ips, ['10.0.0.1', '10.0.0.2'])
  })
})

test('listAssets 现状锁定：只多一个尾逗号（tested,）会被当成字面量查，一条都出不来', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('multi-trailing', [])
    const db = store.db(eng.id)
    const mk = (ip, st) => db.prepare('INSERT INTO asset(ip, segment_cidr, state, test_status) VALUES(?,?,?,?)')
      .run(ip, '10.0.0.0/24', 'live', st)
    mk('10.0.0.1', 'tested')
    /* 单值分支压的是**原始字符串**（不是 trim 后的 list），所以 'tested,' 会拿整个串去比。
       现状是「查不到」，而不是「按 tested 查」。这里锁住它：哪天有人把单值分支改成压 list[0]，
       这就是一次行为变化，必须显式看见。 */
    assert.equal(store.listAssets(eng.id, { test_status: 'tested,' }).items.length, 0)
    assert.equal(store.listAssets(eng.id, { test_status: 'tested' }).items.length, 1)
  })
})

test('listAssets：test_status 为空串等于不筛（不是筛「状态为空」的资产）', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('multi-empty', [])
    const db = store.db(eng.id)
    const mk = (ip, st) => db.prepare('INSERT INTO asset(ip, segment_cidr, state, test_status) VALUES(?,?,?,?)')
      .run(ip, '10.0.0.0/24', 'live', st)
    mk('10.0.0.1', 'tested')
    mk('10.0.0.2', null)
    assert.equal(store.listAssets(eng.id, { test_status: '' }).items.length, 2)
    assert.equal(store.listAssets(eng.id, {}).items.length, 2)
  })
})

test('listAssets：untested 也要能匹配到 test_status 为 NULL 的老资产（COALESCE 兜底）', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('multi-null', [])
    const db = store.db(eng.id)
    const mk = (ip, st) => db.prepare('INSERT INTO asset(ip, segment_cidr, state, test_status) VALUES(?,?,?,?)')
      .run(ip, '10.0.0.0/24', 'live', st)
    mk('10.0.0.1', null)
    mk('10.0.0.2', 'untested')
    mk('10.0.0.3', 'tested')
    const ips = store.listAssets(eng.id, { test_status: 'untested' }).items.map((a) => a.ip).sort()
    assert.deepEqual(ips, ['10.0.0.1', '10.0.0.2'])
  })
})

test('listAssets：逗号串里带 untested 时，NULL 老资产也要一起出来（IN 分支同样要 COALESCE）', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('multi-in-null', [])
    const db = store.db(eng.id)
    const mk = (ip, st) => db.prepare('INSERT INTO asset(ip, segment_cidr, state, test_status) VALUES(?,?,?,?)')
      .run(ip, '10.0.0.0/24', 'live', st)
    mk('10.0.0.1', null)
    mk('10.0.0.2', 'tested')
    mk('10.0.0.3', 'blocked')
    const ips = store.listAssets(eng.id, { test_status: 'untested,tested' }).items.map((a) => a.ip).sort()
    assert.deepEqual(ips, ['10.0.0.1', '10.0.0.2'], 'IN 分支里 NULL 也要当 untested')
  })
})

/* ============================================================ 旧得分项清理 */

test('seedScorePoints：旧内置点连同命中被清掉，并先存档到 <靶标>/runs', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('purge-with-hits', [])
    const { db, id } = legacyPoint(store, eng, { withHit: true })
    const r = store.seedScorePoints(eng.id)
    assert.equal(r.purged, true)
    assert.equal(r.purgedLegacyPoints, 1)
    assert.equal(r.purgedLegacyHits, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_point WHERE id = ?').get(id).n, 0, '得分点要删掉')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_hit WHERE point_id = ?').get(id).n, 0, '命中要一起删')

    const files = archiveFiles(store, eng)
    assert.equal(files.length, 1, '删之前必须先存档一份')
    assert.match(files[0], /^legacy-score-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/)
    const body = JSON.parse(readFileSync(join(store.dirOf(eng.id), 'runs', files[0]), 'utf8'))
    assert.ok(body.archived_at, '存档要带时间')
    assert.match(body.reason, /旧得分项整套作废/, '存档要写明原因，报告/审计才看得懂')
    assert.equal(body.points.length, 1)
    assert.equal(body.points[0].code, 'web-account-old')
    assert.equal(body.hits.length, 1)
    assert.equal(body.hits[0].evidence, '旧证据：admin 口令', '存档里要留证据原文')
  })
})

test('seedScorePoints：存档写不下去就一条都不删（宁可多留一轮，不能静默丢证据）', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('purge-no-archive', [])
    const { db, id } = legacyPoint(store, eng, { withHit: true })
    const runs = join(store.dirOf(eng.id), 'runs')
    rmSync(runs, { recursive: true, force: true })
    writeFileSync(runs, 'not a dir', 'utf8') // 让 mkdirSync(runs) 抛错
    const r = store.seedScorePoints(eng.id)
    assert.equal(r.purged, false, '存档失败时不许报告已清理')
    assert.equal(r.purgedLegacyPoints, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_point WHERE id = ?').get(id).n, 1, '得分点必须还在')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_hit WHERE point_id = ?').get(id).n, 1, '命中必须还在')
  })
})

test('seedScorePoints：没有命中就直删，不建空存档文件', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('purge-no-hits', [])
    const { db, id } = legacyPoint(store, eng, { withHit: false })
    const r = store.seedScorePoints(eng.id)
    assert.equal(r.purgedLegacyPoints, 1)
    assert.equal(r.purgedLegacyHits, 0)
    assert.equal(archiveFiles(store, eng).length, 0, '没有命中就没有要存档的东西')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_point WHERE id = ?').get(id).n, 0)
  })
})

test('seedScorePoints：用户自建点（builtin=0 且 legacy=0）一律不动，哪怕 code 长得很像旧点', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('purge-keep-mine', [])
    const { db, id } = legacyPoint(store, eng, { code: 'web-account-mine', builtin: 0, legacy: 0, withHit: true })
    const r = store.seedScorePoints(eng.id)
    assert.equal(r.purged, false)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_point WHERE id = ?').get(id).n, 1, '自建点不能被当成旧体系残留')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_hit WHERE point_id = ?').get(id).n, 1)
    assert.equal(archiveFiles(store, eng).length, 0)
  })
})

test('seedScorePoints：legacy=1 的老库点（builtin 还是 0）也要清', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('purge-legacy-flag', [])
    const { db, id } = legacyPoint(store, eng, { code: 'boundary-old', builtin: 0, legacy: 1, withHit: false })
    const r = store.seedScorePoints(eng.id)
    assert.equal(r.purgedLegacyPoints, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_point WHERE id = ?').get(id).n, 0)
  })
})

test('seedScorePoints：清完之后再跑是幂等的，不会报 purged', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('purge-idempotent', [])
    legacyPoint(store, eng, { withHit: true })
    const db = store.db(eng.id)
    const first = store.seedScorePoints(eng.id)
    const second = store.seedScorePoints(eng.id)
    assert.equal(first.purged, true)
    /* 现状：内置点还在时，同步循环每条都算一次 changes，于是 synced>0，
       函数走不到 `{ seeded: 0 }` 那条早退分支，回的是完整对象（全零）。 */
    assert.equal(second.seeded, 0, '第二次没有要补的点')
    assert.equal(second.purged, false, '第二次没有要清的点')
    assert.equal(second.purgedLegacyPoints, 0)
    assert.equal(second.purgedLegacyHits, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_point').get().n, 25, '内置点一个不多一个不少')
  })
})

test('seedScorePoints：内置点被误删后能靠这一条自愈补回来（清理不能把播种搞坏）', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('purge-reseed', [])
    const db = store.db(eng.id)
    const victim = db.prepare('SELECT code FROM score_point ORDER BY id LIMIT 1').get().code
    db.prepare('DELETE FROM score_point WHERE code = ?').run(victim)
    legacyPoint(store, eng, { withHit: true })
    const r = store.seedScorePoints(eng.id)
    assert.equal(r.seeded, 1, '被删的内置点要补回来')
    assert.equal(r.purgedLegacyPoints, 1, '同时把旧点清掉')
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM score_point WHERE code = ?').get(victim).n === 1)
  })
})

test('源码形状：存档失败必须先 throw，DELETE 只能排在它后面', () => {
  const src = readFileSync(new URL('../lib/redteam/store-core.js', import.meta.url), 'utf8')
  const at = src.indexOf("if (!archived) throw new Error('legacy score archive failed; purge skipped')")
  assert.ok(at > 0, '那句守卫必须存在（删掉它就等于「删了再说」）')
  const delPoint = src.indexOf('DELETE FROM score_point WHERE id IN')
  const delHit = src.indexOf('DELETE FROM score_hit WHERE point_id IN')
  assert.ok(delPoint > at && delHit > at, '两处 DELETE 都必须排在存档守卫之后')
  /* 存档落在 runs/（与其它证据同处一地），不是随便一个目录 */
  const arch = src.slice(src.indexOf('const dir = join(this.dirOf(id), \'runs\')'), at)
  assert.ok(arch.includes('legacy-score-'), '存档文件名前缀要能被人 grep 到')
})

/* ============================================================ 步骤连带记分 */

test('addChainStep：带 point_code + evidence 时同一次调用完成「动作 + 得分」，两边互相挂上', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('step-score', [])
    const db = store.db(eng.id)
    const p = db.prepare('SELECT id, code, points FROM score_point ORDER BY id LIMIT 1').get()
    const r = store.addChainStep(eng.id, { title: '拿下控制台', point_code: p.code, evidence: '用 admin:Passw0rd 登入' })
    assert.ok(r.hit, '要顺手记一条命中')
    assert.equal(r.hit.point_id, p.id)
    assert.equal(r.score_hint, null, '顺利记上就不该有提示')
    const step = db.prepare('SELECT id, point_id FROM attack_step WHERE id = ?').get(r.id)
    assert.equal(step.point_id, p.id, '步骤行上也要写 point_id')
    const hitRow = db.prepare('SELECT step_id, evidence FROM score_hit WHERE id = ?').get(r.hit.id)
    assert.equal(hitRow.step_id, r.id, '命中要挂回这条步骤，否则说不清分怎么拿的')
    assert.equal(hitRow.evidence, '用 admin:Passw0rd 登入')
  })
})

test('addChainStep：给了 point_code 但没有 evidence → 步骤入库、不记分，并且明确告诉模型', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('step-no-evidence', [])
    const db = store.db(eng.id)
    const p = db.prepare('SELECT id, code FROM score_point ORDER BY id LIMIT 1').get()
    const r = store.addChainStep(eng.id, { title: '只写了个标题', point_code: p.code })
    assert.equal(r.hit, null)
    assert.match(r.score_hint, /没有\*\*没有记分\*\*|没有\*\*记分\*\*|没有记分/)
    assert.match(r.score_hint, /evidence/, '提示里要说明补 evidence 才能记分')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_hit').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attack_step').get().n, 1, '步骤本身必须照常入库')
  })
})

test('addChainStep：既没 point_code 也没 point_id → 只写步骤，连提示都不出（不是错误）', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('step-no-point', [])
    const r = store.addChainStep(eng.id, { title: '侦察了一下', evidence: 'nmap 输出 22/80' })
    assert.equal(r.hit, null)
    assert.equal(r.score_hint, null)
  })
})

test('addChainStep：evidence 只有空白也算「没给 evidence」', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('step-blank-evidence', [])
    const db = store.db(eng.id)
    const p = db.prepare('SELECT id, code FROM score_point ORDER BY id LIMIT 1').get()
    const r = store.addChainStep(eng.id, { title: 'x', point_code: p.code, evidence: '   ' })
    assert.equal(r.hit, null)
    /* 关键：空白 evidence 必须走「本来就没给」这条路（提示里说**没有记分**），
       而不是闯进 addScoreHit 再被它的 evidence 校验打回来（提示里说「记分失败」）。
       两者模型看到的提示完全不同：后者会让它以为记分逻辑坏了。 */
    assert.ok(r.score_hint, '空白 evidence 要按「没给」处理并提示')
    assert.ok(r.score_hint.includes('没有记分'), '提示要说明本次没有记分')
    assert.doesNotMatch(r.score_hint, /记分失败/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_hit').get().n, 0)
  })
})

test('addChainStep 现状锁定：point_id 指向不存在的得分点也照写一条 0 分命中（不报错）', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('step-ghost-point', [])
    const db = store.db(eng.id)
    const r = store.addChainStep(eng.id, { title: 'x', point_id: 999999, evidence: '有点奇怪的调用' })
    /* addScoreHit 只在 pointId 为 null 时才报 not found；显式给了一个非法 id 就直接插库。
       现状：得分点名字为 null、分值为 0，所以不会把总分刷高，但它确实是一条「看得见、
       不产生分」的命中。这里锁住现状，免得以后改成静默丢弃或改成抛错时无人察觉。 */
    assert.ok(r.hit)
    assert.equal(r.hit.point, null)
    assert.equal(r.hit.points, 0)
    const row = db.prepare('SELECT point_id FROM score_hit WHERE id = ?').get(r.hit.id)
    assert.equal(row.point_id, 999999)
  })
})

test('addChainStep：step.point_id 与命中的 point_id 是同一个，且 seq 连续递增', () => {
  withStore(({ store }) => {
    const eng = store.openEngagement('step-seq', [])
    const db = store.db(eng.id)
    const p = db.prepare('SELECT id, code FROM score_point ORDER BY id LIMIT 1').get()
    const a = store.addChainStep(eng.id, { title: 'a', evidence: 'x' })
    const b = store.addChainStep(eng.id, { title: 'b', point_code: p.code, evidence: 'y' })
    const rows = db.prepare('SELECT seq FROM attack_step ORDER BY seq').all().map((r) => r.seq)
    assert.deepEqual(rows, [1, 2])
    assert.equal(b.seq, 2)
    assert.equal(b.point_id, p.id)
    assert.notEqual(a.id, b.id)
  })
})
