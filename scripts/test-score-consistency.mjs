// 演练台计分口径：面板 / 报告 / 攻击链三处必须算出同一个总分。
//
// 为什么值得单独一个文件：这三条路径各自读一遍数据库、各自调一次
// `evaluateScoreBoard`，历史上就出现过「面板 6340 分、报告 7930 分」这种
// 同一份交付物自相矛盾的情况。代码注释里写着「必须与 listScorePoints 用同一套」，
// 但注释拦不住回归——只有把三处的数字摆在一起断言才拦得住。
//
// 另外单独钉住 `applyScoreCaps`：它是计分口径的唯一实现，四种 dedup_scope
// 与规则上限的边界行为都在这里，纯函数，测起来最省事也最能定位问题。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore } from '../lib/redteam/store-core.js'
import { applyScoreCaps, DEDUP_SCOPES, scoreCapReasonText } from '../lib/redteam/score-rules.js'

/**
 * 开一个临时靶标库跑 fn。
 *
 * 清理要吞异常：Windows 上刚 close 过的 SQLite 目录偶尔会 EPERM，
 * 让清理失败冒出去会把「测试通过」变成「测试报错」。
 */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purge-score-'))
  const store = new RedteamStore(dir)
  try {
    const eng = store.openEngagement('score', [])
    return fn({ store, eng, db: store.db(eng.id) })
  } finally {
    try { store.close() } catch { /* 已关闭 */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows EPERM */ }
  }
}

/** 直接插资产行：addScoreHit 只按 id 引用资产，界面展示才需要 ip。 */
function addAsset(db, ip, name = null) {
  db.prepare('INSERT INTO asset(ip, segment_cidr, state, primary_name) VALUES(?,?,?,?)')
    .run(ip, '10.0.0.0/24', 'live', name)
  return Number(db.prepare('SELECT id FROM asset ORDER BY id DESC LIMIT 1').get().id)
}

/**
 * 三处的总分，一次取齐——所有「口径一致」的断言都对着它比。
 *
 * 字段名带 `_` 后缀区分「数字」与「整份结果」：`board` 是分，`boardRes` 是原始返回，
 * 混着用会写出 `assert.equal(t.board, t.board)` 这种自己跟自己比的假断言。
 */
function totals(store, id) {
  const boardRes = store.listScorePoints(id)
  const reportRes = store.scoreReport(id)
  const chainRes = store.scoreChain(id)
  return {
    board: boardRes.summary.achievedPoints,
    report: reportRes.summary.points,
    chain: chainRes.summary.points,
    boardRes, reportRes, chainRes,
  }
}

/* ────────────────────────── applyScoreCaps：计分口径的唯一实现 ────────────────────────── */

const metaOf = (obj) => new Map(Object.entries(obj))

test('dedup_scope=service：同一（资产, 端口）只算分值最高的一条', () => {
  const meta = metaOf({ a: { rule: 5, cap: 0, dedup_scope: 'service', points: 100 } })
  const rows = [
    { id: 1, code: 'a', points: 100, asset_id: 1, port: 80 },
    { id: 2, code: 'a', points: 40, asset_id: 1, port: 80 },
    { id: 3, code: 'a', points: 30, asset_id: 1, port: 81 },
  ]
  const out = applyScoreCaps(rows, meta, null)
  assert.equal(out.capped, 1)
  assert.equal(out.items[1].capped, true)
  assert.equal(out.items[1].capped_reason_kind, 'dedup')
  assert.equal(out.items[1].capped_by_id, 1)
  // 另一个端口是另一个服务，不受影响
  assert.equal(out.items[2].capped, false)
})

test('dedup_scope=service 但拿不到服务键时不参与去重', () => {
  // 这条是防「静默吃掉成果」的护栏：没有 target 也没有 port 时若退回「每条自成一键」，
  // 会把 62 条 terminal-access 里的 61 条判成重复。
  const meta = metaOf({ a: { rule: 5, cap: 0, dedup_scope: 'service', points: 100 } })
  const out = applyScoreCaps([{ id: 1, code: 'a', points: 100 }, { id: 2, code: 'a', points: 100 }], meta, null)
  assert.equal(out.capped, 0)
})

test('dedup_scope=system：同一系统名只算最高权限一次', () => {
  const meta = metaOf({ a: { rule: 3, cap: 600, dedup_scope: 'system', points: 50 } })
  const rows = [
    { id: 1, code: 'a', points: 50, asset_id: 1, system_key: 'web01|80' },
    { id: 2, code: 'a', points: 50, asset_id: 1, system_key: 'web01|443' },
    { id: 3, code: 'a', points: 50, asset_id: 1, system_key: 'web01|80' },
  ]
  const out = applyScoreCaps(rows, meta, null)
  // system 口径比 service 宽：端口不同也算同一套系统，所以 2 和 3 都被 1 顶掉
  assert.equal(out.capped, 2)
  assert.equal(out.items[0].capped, false)
  assert.equal(out.items[1].capped_by_id, 1)
  assert.equal(out.items[2].capped_by_id, 1)
})

test('dedup_scope=target：整个靶标只算一次', () => {
  const meta = metaOf({ a: { rule: 19, cap: 0, dedup_scope: 'target', points: 1000 } })
  const rows = [
    { id: 1, code: 'a', points: 1000, asset_id: 1, target: 'x' },
    { id: 2, code: 'a', points: 1000, asset_id: 2, target: 'y' },
  ]
  const out = applyScoreCaps(rows, meta, null)
  assert.equal(out.capped, 1)
  assert.equal(out.items[1].capped_reason_kind, 'dedup')
})

test('dedup_scope=none：按台 / 卡 / 节点数累加，一条都不封', () => {
  const meta = metaOf({ a: { rule: 18, cap: 0, dedup_scope: 'none', points: 10 } })
  const rows = [
    { id: 1, code: 'a', points: 10, asset_id: 1, target: 'x' },
    { id: 2, code: 'a', points: 10, asset_id: 1, target: 'x' },
  ]
  assert.equal(applyScoreCaps(rows, meta, null).capped, 0)
})

test('规则上限：累计到 cap 为止，下一条开始封顶', () => {
  const meta = metaOf({ a: { rule: 2, cap: 100, dedup_scope: 'none', points: 50 } })
  const rows = [
    { id: 1, code: 'a', points: 50, asset_id: 1 },
    { id: 2, code: 'a', points: 50, asset_id: 2 },
    { id: 3, code: 'a', points: 50, asset_id: 3 },
  ]
  const out = applyScoreCaps(rows, meta, null)
  assert.equal(out.capped, 1)
  // 恰好等于 cap 的两条都算，第三条才超
  assert.deepEqual(out.items.map((r) => r.capped), [false, false, true])
  assert.equal(out.items[2].capped_reason_kind, 'cap')
  assert.deepEqual(out.caps.get('rule:2'), { rule: 2, cap: 100, used: 100, capped: 1 })
})

test('规则上限按分值从高到低累计，先算大额', () => {
  // 上限 95、两条 90 与 10：按分值降序时 90 先占住，10 超限被封（总 90 分）。
  // 若按插入顺序（10 在前）就会反过来：10 占位、90 被封，只剩 10 分 —— 等于少算分。
  const meta = metaOf({ a: { rule: 2, cap: 95, dedup_scope: 'none', points: 10 } })
  const rows = [
    { id: 1, code: 'a', points: 10, asset_id: 1 },
    { id: 2, code: 'a', points: 90, asset_id: 2 },
  ]
  const out = applyScoreCaps(rows, meta, null)
  assert.equal(out.items[0].capped, true)   // 小的被封
  assert.equal(out.items[1].capped, false)  // 大的留下
  assert.equal(out.caps.get('rule:2').used, 90)
})

test('cap=0 表示不设上限，不封也不记用量', () => {
  const meta = metaOf({ a: { rule: 19, cap: 0, dedup_scope: 'none', points: 1000 } })
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, code: 'a', points: 1000, asset_id: i + 1 }))
  const out = applyScoreCaps(rows, meta, null)
  assert.equal(out.capped, 0)
  assert.equal(out.caps.size, 0)
})

test('self_created 既不参与去重也不占上限', () => {
  const meta = metaOf({ a: { rule: 1, cap: 100, dedup_scope: 'service', points: 100 } })
  const rows = [
    { id: 1, code: 'a', points: 100, asset_id: 1, port: 80, self_created: 1 },
    { id: 2, code: 'a', points: 100, asset_id: 1, port: 80 },
  ]
  const out = applyScoreCaps(rows, meta, null)
  // 自建账号不占位：真实的第 2 条不该被第 1 条顶掉
  assert.equal(out.capped, 0)
})

test('不给元数据时按 code 自成一组、只去重不封顶（兼容旧调用）', () => {
  const out = applyScoreCaps([
    { id: 1, code: 'x', points: 10, asset_id: 1, port: 80 },
    { id: 2, code: 'x', points: 10, asset_id: 1, port: 80 },
  ], null, null)
  assert.equal(out.capped, 0)
  assert.equal(out.items[0].cap_group, 'code:x')
  assert.equal(out.items[0].dedup_scope, 'none')
})

test('DEDUP_SCOPES 与注释里写的四种口径一一对应', () => {
  assert.deepEqual([...DEDUP_SCOPES], ['service', 'system', 'target', 'none'])
})

/* ────────────────────────── 三处口径必须一致 ────────────────────────── */

test('普通命中：面板 / 报告 / 攻击链总分一致', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5', 'web01')
  store.addScoreHit(eng.id, { code: 'web-app', asset_id: a, target: 'http://10.0.0.5:80', evidence: '后台弱口令' })
  const t = totals(store, eng.id)
  assert.equal(t.board, 100)
  assert.equal(t.report, t.board)
  assert.equal(t.chain, t.board)
}))

test('同服务重复命中：三处都只算最高一条', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5', 'web01')
  store.addScoreHit(eng.id, { code: 'web-app', asset_id: a, target: 'http://10.0.0.5:80', evidence: '第一条' })
  store.addScoreHit(eng.id, { code: 'web-app', asset_id: a, target: 'http://10.0.0.5:80', evidence: '第二条' })
  const t = totals(store, eng.id)
  assert.equal(t.board, 100)
  assert.equal(t.report, 100)
  assert.equal(t.chain, 100)
  // 各自的「被顶掉」计数也要对得上
  assert.equal(t.boardRes.summary.serviceCappedHits, 1)
  assert.equal(t.reportRes.summary.serviceCappedExcluded, 1)
}))

test('自建账号：三处都不计分，但都记得它存在', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5', 'web01')
  store.addScoreHit(eng.id, { code: 'web-app', asset_id: a, target: 'http://10.0.0.5:80', evidence: '自己注册的' , self_created: true })
  const t = totals(store, eng.id)
  assert.equal(t.board, 0)
  assert.equal(t.report, 0)
  assert.equal(t.chain, 0)
  assert.equal(t.boardRes.summary.selfCreatedHits, 1)
  assert.equal(t.reportRes.summary.selfCreatedExcluded, 1)
  assert.equal(t.chainRes.summary.selfCreatedHits, 1)
}))

test('停用得分点：三处都按 0 算（否则同一份交付物出现两个总分）', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5', 'web01')
  store.addScoreHit(eng.id, { code: 'web-app', asset_id: a, target: 'http://10.0.0.5:80', evidence: '后台弱口令' })
  const point = store.listScorePoints(eng.id).items.find((p) => p.code === 'web-app')
  store.saveScorePoint(eng.id, { id: point.id, enabled: false })

  const t = totals(store, eng.id)
  assert.equal(t.board, 0)
  assert.equal(t.report, 0)
  assert.equal(t.chain, 0)
  assert.equal(t.boardRes.summary.pointCount, 24)  // 停用后只剩 24 个启用点
  assert.equal(t.reportRes.summary.disabledExcluded, 1)
  // 攻击链的总分是直接借面板的，所以只比总分抓不到「条目自己还标着 counted」这种漂移。
  // 条目级的 counted 会被 redteam_attack_chain 逐条透出去，必须一起钉住。
  assert.equal(t.chainRes.items[0].counted, false)
  // 报告则把停用命中整条剔出正文，只在页脚报数
  assert.equal(t.reportRes.items.length, 0)
}))

test('规则上限吃满：三处都停在 cap 上', () => withStore(({ store, eng, db }) => {
  // terminal-access 10 分 / 上限 600 → 63 台时第 61 台起超限
  const ids = Array.from({ length: 63 }, (_, i) => addAsset(db, '10.0.1.' + i, 'pc' + i))
  for (const id of ids) {
    store.addScoreHit(eng.id, { code: 'terminal-access', asset_id: id, target: 'pc-' + id, evidence: '终端 ' + id })
  }
  const t = totals(store, eng.id)
  assert.equal(t.board, 600)
  assert.equal(t.report, 600)
  assert.equal(t.chain, 600)
  assert.equal(t.boardRes.summary.cappedByRuleLimit, 3)
  const ta = t.boardRes.items.find((p) => p.code === 'terminal-access')
  assert.equal(ta.cap_used, 600)
  assert.equal(ta.counted, 60)
}))

test('命中自带分值（合并版多档）：三处都按命中分值算，不按得分点默认值', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5', 'web01')
  // web-app 默认 100，这条命中显式写 50（普通管理员档）
  store.addScoreHit(eng.id, { code: 'web-app', asset_id: a, target: 'http://10.0.0.5:80', evidence: '普通管理员', points: 50 })
  const t = totals(store, eng.id)
  assert.equal(t.board, 50)
  assert.equal(t.report, 50)
  assert.equal(t.chain, 50)
  assert.equal(t.reportRes.items[0].points, 50)
}))

test('G6 IPv6 倍率 ×3：三处都乘过，不会重复乘成 ×9', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '2001:db8::1', 'v6host')
  store.addScoreHit(eng.id, { code: 'server-host', asset_id: a, target: 'http://[2001:db8::1]:22', evidence: 'root 权限' })
  const t = totals(store, eng.id)
  assert.equal(t.board, 150)   // 50 × 3
  assert.equal(t.report, 150)
  assert.equal(t.chain, 150)
  assert.equal(t.chainRes.items[0].multiplier, 3)
}))

test('G5 数据规模 ×2：三处都乘过', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.6', 'db01')
  store.addScoreHit(eng.id, { code: 'db-credential', asset_id: a, target: '10.0.0.6:3306', evidence: '1.2 亿条记录', data_scale: 'large' })
  const t = totals(store, eng.id)
  assert.equal(t.board, 100)   // 50 × 2
  assert.equal(t.report, 100)
  assert.equal(t.chain, 100)
}))

test('多个得分点混在一起：三处总分仍然一致', () => withStore(({ store, eng, db }) => {
  const web = addAsset(db, '10.0.0.5', 'web01')
  const host = addAsset(db, '10.0.0.9', 'srv01')
  store.addScoreHit(eng.id, { code: 'web-app', asset_id: web, target: 'http://10.0.0.5:80', evidence: '后台弱口令' })
  store.addScoreHit(eng.id, { code: 'server-host', asset_id: host, target: '10.0.0.9:22', evidence: 'root shell' })
  store.addScoreHit(eng.id, { code: 'terminal-access', asset_id: host, target: '10.0.0.9', evidence: '终端回显' })
  const t = totals(store, eng.id)
  assert.equal(t.board, 160)   // 100 + 50 + 10
  assert.equal(t.report, 160)
  assert.equal(t.chain, 160)
}))

/* ────────────────────────── 报告正文与 summary 必须对得上 ────────────────────────── */

test('报告的 markdown 总分与 summary.points 是同一个数', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5', 'web01')
  store.addScoreHit(eng.id, { code: 'web-app', asset_id: a, target: 'http://10.0.0.5:80', evidence: '后台弱口令' })
  const report = store.scoreReport(eng.id)
  // 正文里写死的是「**N 分**」，用户读到的就是这个数
  assert.match(report.markdown, /\| \*\*100 分\*\* \|/)
}))

test('报告里被顶掉的命中只出现在页脚，不进正文条目', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5', 'web01')
  store.addScoreHit(eng.id, { code: 'web-app', asset_id: a, target: 'http://10.0.0.5:80', evidence: '第一条' })
  store.addScoreHit(eng.id, { code: 'web-app', asset_id: a, target: 'http://10.0.0.5:80', evidence: '第二条' })
  const report = store.scoreReport(eng.id)
  assert.equal(report.items.length, 1)
  assert.equal(report.summary.serviceCappedExcluded, 1)
  assert.equal(report.summary.serviceCapped.length, 1)
}))

/* ────────────────────────── 不计分原因文案 ────────────────────────── */

test('去重与超上限的文案是两种措辞，不能混用', () => {
  const dedup = scoreCapReasonText({ capped_reason_kind: 'dedup', target: 'http://h:80', asset_ip: 'h' }, 50)
  assert.match(dedup, /同一目标只算分值最高的那条/)
  assert.match(dedup, /\+50 分/)

  const cap = scoreCapReasonText({ capped_reason_kind: 'cap', target: 'http://h:80', rule: 1, rule_cap: 100 })
  assert.match(cap, /累计得分已达该规则上限（100 分）/)
})

test('去重文案在没有被顶掉分值时不硬写 +N 分', () => {
  const text = scoreCapReasonText({ capped_reason_kind: 'dedup', target: 'http://h:80' }, null)
  assert.ok(!text.includes('+null'))
  assert.match(text, /同一目标只算分值最高的那条）/)
})

/* ────────────────────────── 已知的字段残留（现状锁定） ────────────────────────── */

test('攻击链的 totalPoints 仍是 undefined —— 现状锁定，不是期望行为', () => withStore(({ store, eng, db }) => {
  const a = addAsset(db, '10.0.0.5', 'web01')
  store.addScoreHit(eng.id, { code: 'web-app', asset_id: a, target: 'http://10.0.0.5:80', evidence: '后台弱口令' })
  const chain = store.scoreChain(eng.id)
  // scoreChain 从 listScorePoints 借 summary.totalPoints，但那个字段从来不存在。
  // 报告与面板都不读它，只有 redteam_attack_chain 工具把它透出去（值恒为 undefined）。
  // 真要修就得改工具输出形状，属于产品决策，不在这轮测试机制里做——但必须钉住，
  // 免得哪天有人以为它该有值而顺手改坏 points 的取值。
  assert.equal(chain.summary.totalPoints, undefined)
  assert.equal(chain.summary.points, 100)
}))
