/**
 * 报告链路的两处边角：复现命令的「真实 curl」那一支，与「同阶段同时间」的稳定排序。
 *
 * 这两处合起来决定一件事：**报告里的 ①②③ 编号与每条命令到底是哪一条**。
 * 判错的后果都不是报错，而是「用户照着报告跑，复现不出来 / 顺序对不上现场」：
 *   · 复现命令挑错 —— 一条该原样给出的 curl 被套上通用模板（模板是 "id; whoami" 这种判定语），
 *     读者照着跑什么也复现不出来；
 *   · 顺序不稳 —— 同一次导出两次跑出两个顺序，链路图与正文互相矛盾。
 *
 * 覆盖 lib/redteam/score-report.js:445-448（真实 curl 分支）与 :697-700 / :708
 * （stepSeqOf 与它的 MAX_SAFE_INTEGER 兜底）。
 *
 * 现状锁定：返回的 `items` **数组顺序保持查询顺序**（`recorded_at, id`），
 * 链路位置只写在 `chain_no` 上 —— 报告正文用 `chain_no` 画 ①②③，所以两者不会互相矛盾，
 * 但想「按链路顺序读 items」的人必须自己按 chain_no 排（见盲区）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RedteamStore } from '../lib/redteam/store-core.js'
import { scoreReport } from '../lib/redteam/score-report.js'

const SRC = fs.readFileSync(new URL('../lib/redteam/score-report.js', import.meta.url), 'utf8')

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-purge-chain-order-'))
  const store = new RedteamStore(dir)
  try {
    const eng = store.openEngagement('chain-order', [])
    return fn({ store, eng, db: store.db(eng.id), id: eng.id })
  } finally {
    try { store.close() } catch { /* 已关闭 */ }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows EPERM */ }
  }
}

function addAsset(db, ip, name = null, cidr = '10.0.0.0/24') {
  db.prepare('INSERT INTO asset(ip, segment_cidr, state, primary_name) VALUES(?,?,?,?)')
    .run(ip, cidr, 'live', name)
  return Number(db.prepare('SELECT id FROM asset ORDER BY id DESC LIMIT 1').get().id)
}

/** 报告链路真正拿到的那一行（`p.code` 是 JOIN 出来的，不是 score_hit 的列）。 */
function hitRow(db, hitId) {
  return db.prepare('SELECT h.*, p.code FROM score_hit h JOIN score_point p ON p.id = h.point_id WHERE h.id = ?').get(hitId)
}

/** 只有 recorded_at 被钉死时才可能并列，所以排序类用例统一改写时间戳。 */
function pinRecordedAt(db, at, ids) {
  const stmt = db.prepare('UPDATE score_hit SET recorded_at = ? WHERE id = ?')
  for (const id of ids) stmt.run(at, id)
}

test('复现命令：只有推断出来的 curl 步骤时，原样给出这条命令并标 real', () => {
  withStore(({ store, db, id }) => {
    const aid = addAsset(db, '10.0.0.5', 'web-01')
    const r = store.addScoreHit(id, { code: 'web-app', asset_id: aid, target: 'http://10.0.0.5/upload.jsp', evidence: '上传冰蝎马 upload.jsp' })
    const cmd = 'curl -i -s -X POST --data-binary @/tmp/b.jsp http://10.0.0.5/upload.jsp'
    // 不给 step_id：这条步骤是「同资产上时间最近」推出来的，不是显式关联
    store.addChainStep(id, { stage_code: 'internet', title: '上传冰蝎马', tool: cmd, asset_id: aid, point_id: hitRow(db, r.id).point_id })
    const item = scoreReport(store, id, {}).items.find((x) => x.id === r.id)
    assert.ok(item, '这条命中必须出现在报告里')
    /* 步骤是推断来的：steps 有内容、step_id 仍是 null */
    assert.equal(item.step_id, null)
    assert.equal(item.steps.length, 1)
    assert.equal(item.steps[0].tool, cmd)
    /* 真实 curl：原样给出，不套模板 */
    assert.equal(item.replay_cmd_kind, 'real')
    assert.equal(item.replay_cmd, cmd)
    /* 没有抓获报文时不能假装有 */
    assert.equal(item.requests.length, 0)
    assert.equal(item.missing_evidence, true)
  })
})

test('复现命令：同一资产上有多条步骤时，取第一条带 tool 的那条（不是第一条）', () => {
  withStore(({ store, db, id }) => {
    const aid = addAsset(db, '10.0.0.6', 'web-02')
    const r = store.addScoreHit(id, { code: 'web-app', asset_id: aid, target: 'http://10.0.0.6/shell.jsp', evidence: '写入 shell.jsp' })
    const pid = hitRow(db, r.id).point_id
    store.addChainStep(id, { stage_code: 'internet', title: '探测（没记命令）', asset_id: aid, point_id: pid })
    store.addChainStep(id, { stage_code: 'internet', title: '落地', tool: 'curl -i -s http://10.0.0.6/shell.jsp', asset_id: aid, point_id: pid })
    const item = scoreReport(store, id, {}).items.find((x) => x.id === r.id)
    assert.equal(item.replay_cmd, 'curl -i -s http://10.0.0.6/shell.jsp')
    assert.equal(item.replay_cmd_kind, 'real')
  })
})

test('链路排序：同阶段同时间时，带步骤的那条拿 ①（没步骤的回 MAX_SAFE_INTEGER）', () => {
  withStore(({ store, db, id }) => {
    const a1 = addAsset(db, '10.0.0.5', 'first')
    const a2 = addAsset(db, '10.0.0.6', 'second')
    const r1 = store.addScoreHit(id, { code: 'web-app', asset_id: a1, target: 'http://10.0.0.5/a.jsp', evidence: '先记的那条 a' })
    const r2 = store.addScoreHit(id, { code: 'web-app', asset_id: a2, target: 'http://10.0.0.6/b.jsp', evidence: '后记但有步骤 b' })
    pinRecordedAt(db, '2026-01-01T00:00:00.000Z', [r1.id, r2.id])
    store.addChainStep(id, {
      stage_code: 'internet', title: '第二步', tool: 'curl -i -s http://10.0.0.6/b.jsp',
      asset_id: a2, point_id: hitRow(db, r1.id).point_id,
    })
    const items = scoreReport(store, id, {}).items
    assert.equal(items.length, 2, '两条都要在报告里（不同资产，不算服务重复）')
    /* 数组顺序仍是查询顺序，链路位置只看 chain_no */
    assert.deepEqual(items.map((x) => x.id), [r1.id, r2.id])
    const noOf = (hitId) => items.find((x) => x.id === hitId).chain_no
    assert.equal(noOf(r2.id), 1, '带步骤的那条是 ①')
    assert.equal(noOf(r1.id), 2, '没步骤的那条是 ② —— 即使它记得更早')
    assert.deepEqual(items.find((x) => x.id === r2.id).steps.map((s) => s.seq), [1])
    assert.deepEqual(items.find((x) => x.id === r1.id).steps, [])
  })
})

test('链路排序：两条都有步骤时，比的是各自的最小 seq', () => {
  withStore(({ store, db, id }) => {
    const a1 = addAsset(db, '10.0.0.7', 'early')
    const a2 = addAsset(db, '10.0.0.8', 'late')
    const r1 = store.addScoreHit(id, { code: 'web-app', asset_id: a1, target: 'http://10.0.0.7/a.jsp', evidence: '步骤较晚 a' })
    const r2 = store.addScoreHit(id, { code: 'web-app', asset_id: a2, target: 'http://10.0.0.8/b.jsp', evidence: '步骤更早 b' })
    pinRecordedAt(db, '2026-01-01T00:00:00.000Z', [r1.id, r2.id])
    const pid = hitRow(db, r1.id).point_id
    store.addChainStep(id, { stage_code: 'internet', title: '先发生', asset_id: a2, point_id: pid })
    store.addChainStep(id, { stage_code: 'internet', title: '后发生', asset_id: a1, point_id: pid })
    const items = scoreReport(store, id, {}).items
    const noOf = (hitId) => items.find((x) => x.id === hitId).chain_no
    assert.equal(noOf(r2.id), 1)
    assert.equal(noOf(r1.id), 2)
    assert.deepEqual(items.find((x) => x.id === r2.id).steps.map((s) => s.seq), [1])
    assert.deepEqual(items.find((x) => x.id === r1.id).steps.map((s) => s.seq), [2])
  })
})

test('链路排序：两条都没有步骤时保持查询顺序，chain_no 从 1 起连续', () => {
  withStore(({ store, db, id }) => {
    const a1 = addAsset(db, '10.0.0.9', 'x')
    const a2 = addAsset(db, '10.0.0.10', 'y')
    const r1 = store.addScoreHit(id, { code: 'web-app', asset_id: a1, target: 'http://10.0.0.9/a.jsp', evidence: '无步骤 a' })
    const r2 = store.addScoreHit(id, { code: 'web-app', asset_id: a2, target: 'http://10.0.0.10/b.jsp', evidence: '无步骤 b' })
    pinRecordedAt(db, '2026-01-01T00:00:00.000Z', [r1.id, r2.id])
    const items = scoreReport(store, id, {}).items
    /* 两条都回 MAX：减出来是 0，于是保持查询顺序（recorded_at, id） */
    assert.deepEqual(items.map((x) => x.id), [r1.id, r2.id])
    assert.deepEqual(items.map((x) => x.chain_no), [1, 2])
    assert.ok(items.every((x) => x.steps.length === 0))
  })
})

test('源码形状：并列时按最小 seq 比，兜底用 MAX_SAFE_INTEGER', () => {
  const flat = SRC.split(/\r?\n/).join('\n')
  assert.match(flat, /return seqs\.length > 0 \? Math\.min\.apply\(null, seqs\) : Number\.MAX_SAFE_INTEGER/)
  assert.match(flat, /return stepSeqOf\(a\) - stepSeqOf\(b\)/)
  assert.match(flat, /const seqs = \(x\.steps \|\| \[\]\)\.map\(\(s\) => Number\(s\.seq\)\)\.filter\(\(n\) => Number\.isFinite\(n\)\)/)
})
