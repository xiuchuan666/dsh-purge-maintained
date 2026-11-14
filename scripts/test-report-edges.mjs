// 报告正文的边角：长备注怎么截、档位校正怎么写、截图归属怎么提示、步骤为什么只出现一次。
//
// 这些分支共同点：**算错了不报错，只让报告说错话**。
//   · 长备注直接 `slice` 会切出"…后端是 3 台 LB 轮询("这种半截句子，验收人读不懂；
//   · 档位校正的段落一旦漏掉，报告里的分与面板上的分对不上，而正文一句解释都没有；
//   · 同得分点的两张图只展示一张时，另一条如果什么都不说，读的人会以为漏了证据；
//   · 同一步骤被两条归属路径同时捡到，如果不去重，攻击链里会出现两条一模一样的步骤。
//
// 所以这里只做一件事：播种真数据、断言看得见的 markdown 文本与条目字段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore } from '../lib/redteam/store-core.js'
import { hitTrace, scoreReport } from '../lib/redteam/score-report.js'

/** 开一个临时靶标库跑 fn；清理吞异常（Windows 上刚 close 的 SQLite 目录偶尔 EPERM）。 */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purge-report-edges-'))
  const store = new RedteamStore(dir)
  try {
    const eng = store.openEngagement('edges', [])
    return fn({ store, eng, db: store.db(eng.id), id: eng.id })
  } finally {
    try { store.close() } catch { /* 已关闭 */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows EPERM */ }
  }
}

function addAsset(db, ip) {
  db.prepare('INSERT INTO asset(ip, segment_cidr, state, primary_name) VALUES(?,?,?,?)')
    .run(ip, '10.0.0.0/24', 'live', null)
  return Number(db.prepare('SELECT id FROM asset ORDER BY id DESC LIMIT 1').get().id)
}

/** 1×1 PNG（合法魔数 + IHDR），`addShot` 靠魔数判 mime。 */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 取 markdown 里第一行含 needle 的行；没有就返回 undefined（用例自己断言存在性）。 */
function lineWith(md, needle) {
  return md.split('\n').find((l) => l.includes(needle))
}

/** 一条能进正文的普通命中（挂资产、给了 target，避免被"自建账号/未计分"分支吃掉）。 */
function seedHit(store, db, { ip = '10.9.9.9', code = 'web-app' } = {}) {
  const asset = addAsset(db, ip)
  const r = store.addScoreHit('edges', { code, asset_id: asset, target: 'http://' + ip + '/admin', evidence: '管理员后台可操作' })
  return { asset, hit: r }
}

/* ══════════════════════════════════════════════════════════════════════════
   一、长备注按句子边界截断
   ══════════════════════════════════════════════════════════════════════════ */

test('长备注：隧道备注 320 上限，句号落在后半段就从句号切开', () => {
  withStore(({ store, db }) => {
    const { asset } = seedHit(store, db)
    const note = '甲'.repeat(200) + '。' + '乙'.repeat(200)
    store.addTunnel('edges', { asset_id: asset, kind: 'socks5', listen: '127.0.0.1:1080', reach: '10.20.30.0/24', entry_kind: 'target-outbound', note })
    const line = lineWith(scoreReport(store, 'edges').markdown, '备注')
    assert.ok(line !== undefined, '隧道备注要出现在 1.1 通道小节里')
    // 前缀 "  - 备注：" 7 字符 + 200 个甲 + 句号 = 208
    assert.equal(line.length, 208)
    assert.ok(line.endsWith('。'), '截断点必须留着那个句号，否则读起来像断了')
    assert.ok(!line.includes('乙'), '句号之后的内容整段不要')
  })
})

test('长备注：一个分隔符都没有时原样截到上限，不硬找逗号', () => {
  withStore(({ store, db }) => {
    const { asset } = seedHit(store, db)
    store.addTunnel('edges', { asset_id: asset, kind: 'socks5', listen: '127.0.0.1:1080', reach: '10.20.30.0/24', entry_kind: 'target-outbound', note: '戊'.repeat(400) })
    const line = lineWith(scoreReport(store, 'edges').markdown, '备注')
    // 7 + 320：切在硬上限上，不去猜句子边界
    assert.equal(line.length, 327)
    assert.equal((line.match(/戊/g) || []).length, 320)
  })
})

test('长备注：分隔符落在前半段（不到一半）不算句子边界，继续往后找', () => {
  withStore(({ store, db }) => {
    const { asset } = seedHit(store, db)
    // 句号在 100（< 320 的一半），逗号在 300（> 一半）→ 必须用逗号
    const note = '庚'.repeat(100) + '。' + '辛'.repeat(199) + '，' + '壬'.repeat(100)
    store.addTunnel('edges', { asset_id: asset, kind: 'socks5', listen: '127.0.0.1:1080', reach: '10.20.30.0/24', entry_kind: 'target-outbound', note })
    const line = lineWith(scoreReport(store, 'edges').markdown, '备注')
    // 7 + 100 庚 + 句号 + 199 辛 + 逗号 = 308
    assert.equal(line.length, 308)
    assert.ok(line.endsWith('，'), '切点必须是后半段的那个逗号')
    assert.equal((line.match(/壬/g) || []).length, 0, '逗号之后不要')
    assert.ok(line.includes('。'), '前半段那个句号原样留着，不当切点')
  })
})

test('长备注：WebShell 会话备注用 200 上限，比隧道更短', () => {
  withStore(({ store, db }) => {
    seedHit(store, db)
    store.addWebshell('edges', {
      url: 'http://10.9.9.9/s.jsp', shell_type: 'behinder', pass_key: 'k',
      note: '癸'.repeat(150) + '；' + '子'.repeat(150),
    })
    const line = lineWith(scoreReport(store, 'edges').markdown, '癸')
    assert.ok(line !== undefined, '会话入口那一行要带备注')
    // 分号在 150（> 200 的一半）→ 切在 151；行前缀 57 字符
    assert.equal(line.length, 208)
    assert.ok(line.endsWith('；'))
    assert.ok(!line.includes('子'), '200 上限之后的内容不要')
  })
})

test('长备注：备注只有空白时行还在、内容为空（现状，不是把它当没写）', () => {
  withStore(({ store, db }) => {
    const { asset } = seedHit(store, db)
    store.addTunnel('edges', { asset_id: asset, kind: 'socks5', listen: '127.0.0.1:1080', reach: '10.20.30.0/24', entry_kind: 'target-outbound', note: '   ' })
    const line = lineWith(scoreReport(store, 'edges').markdown, '备注')
    assert.equal(line, '  - 备注：')
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   二、档位校正：数值被下调过就必须在正文里说出来
   ══════════════════════════════════════════════════════════════════════════ */

test('档位校正：备注里写了「校正」就单起一段，逐条列出目标与校正后分值', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.9.9.9')
    store.addScoreHit('edges', { code: 'terminal-access', asset_id: asset, target: '10.9.9.9', evidence: '终端权限 1 台', points: 50, note: '复核时按档位校正：原 60 分下调至 50 分' })
    const md = scoreReport(store, 'edges').markdown
    assert.ok(md.includes('> **档位校正**：以下 1 条在最终复核时下调了档位'), '要说明有几条被下调')
    assert.ok(md.includes('下列数值为**校正后**的口径'), '要说明正文里的数是校正后的')
    const line = lineWith(md, '10.9.9.9')
    assert.ok(line.includes('**50 分**'), '列出的必须是校正后的分值')
    assert.ok(line.includes('原 60 分下调至 50 分'), '备注原文要带上，验收人才能对账')
  })
})

test('档位校正：没有「校正」字样就完全不出现这一段', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.9.9.9')
    store.addScoreHit('edges', { code: 'terminal-access', asset_id: asset, target: '10.9.9.9', evidence: '终端权限 1 台', points: 50, note: '按档位表取 50 分' })
    const md = scoreReport(store, 'edges').markdown
    assert.ok(!md.includes('档位校正'), '没下调过就不能出现这段，否则数字看着像被动过')
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   三、截图：同得分点只展示代表图时，另一条要指明去哪看
   ══════════════════════════════════════════════════════════════════════════ */

test('截图归属：同得分点两张图分给两条命中，没分到的那条要写明去代表图看', () => {
  withStore(({ store, db }) => {
    const a1 = addAsset(db, '10.3.3.1')
    const a2 = addAsset(db, '10.3.3.2')
    const h1 = store.addScoreHit('edges', { code: 'web-app', asset_id: a1, target: 'http://10.3.3.1/admin', evidence: '管理员后台可操作' })
    store.addScoreHit('edges', { code: 'web-app', asset_id: a2, target: 'http://10.3.3.2/admin', evidence: '管理员后台可操作（另一台）' })
    store.addShot('edges', { hit_id: h1.id, point_code: 'web-app', data_base64: PNG_1X1, label: '后台页面' })
    const rep = scoreReport(store, 'edges')
    assert.equal(rep.items.length, 2, '两条不同目标不合并')
    assert.equal(rep.items[0].shots.length, 1)
    assert.equal(rep.items[1].shots.length, 0, '代表图只给一条')
    assert.equal(rep.items[1].shot_total, 1, '但这条知道同得分点总共几张')
    assert.ok(rep.markdown.includes('本条的证据截图已在该得分点的代表图中展示'), '要指路，别让人以为漏了证据')
    assert.ok(rep.markdown.includes('该得分点共 1 张截图'), '要报总数')
    assert.ok(rep.markdown.includes('![后台页面]'), '有图那条正常展示，alt 用 label')
  })
})

test('截图归属：本得分点一张图都没有时，不出现"去看代表图"的指路', () => {
  withStore(({ store, db }) => {
    seedHit(store, db)
    const md = scoreReport(store, 'edges').markdown
    assert.ok(!md.includes('已在该得分点的代表图中展示'), '没有图就不能指向不存在的图')
    assert.ok(!md.includes('**证据截图**'), '没有截图段')
  })
})

/* ⚠️ 一处今天走不到的守卫（不要为它硬凑用例）：
   pushStep 里「已有的是推断、这次来的是实锤 → 把推断标记撤掉」那半句，
   在现有归因顺序下永远不触发 —— 顺序固定是 linked → vuln → point(推断) → asset(推断)，
   推断项总在实锤之后进来，所以先压进 map 的从来不是推断项。
   保留它是为了将来若有人调换查询顺序时不静默把实锤降级成推断；
   行为层区分不了，所以这里只按「显式那条不标推断、兄弟步骤标推断」来钉。 */
/* ══════════════════════════════════════════════════════════════════════════
   四、步骤去重：同一步骤被两条归属路径捡到只算一条，且显式优先
   ══════════════════════════════════════════════════════════════════════════ */

test('步骤去重：同一步骤既被推断路径捡到、又被 step_id 显式关联，只留一条且不标推断', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.4.4.4')
    const pt = db.prepare("SELECT id FROM score_point WHERE code = 'terminal-access'").get()
    const step = store.addChainStep('edges', { stage_code: 'internal', title: '批量登录', tool: 'wmiexec administrator@10.4.4.4', asset_id: asset, point_id: pt.id })
    const h = store.addScoreHit('edges', { code: 'terminal-access', asset_id: asset, step_id: step.id, evidence: '终端权限 1 台' })
    const row = db.prepare('SELECT h.*, p.code FROM score_hit h LEFT JOIN score_point p ON p.id = h.point_id WHERE h.id = ?').get(h.id)
    const trace = hitTrace(store, db, row, 'edges')
    assert.equal(trace.steps.length, 1, '同一步骤不能出现两次')
    assert.equal(trace.steps[0].inferred, false, '显式关联优先于推断')
    assert.equal(trace.step_source, 'linked')
  })
})

test('步骤去重：两条命中指向同一步骤时，各自的步骤列表都只有一条', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.4.4.5')
    const step = store.addChainStep('edges', { stage_code: 'internal', title: '一条命令', tool: 'id', asset_id: asset })
    const h1 = store.addScoreHit('edges', { code: 'server-host', asset_id: asset, step_id: step.id, evidence: '回显 uid=0' })
    const h2 = store.addScoreHit('edges', { code: 'terminal-access', asset_id: asset, step_id: step.id, evidence: '终端权限 1 台' })
    for (const id of [h1.id, h2.id]) {
      const row = db.prepare('SELECT h.*, p.code FROM score_hit h LEFT JOIN score_point p ON p.id = h.point_id WHERE h.id = ?').get(id)
      const trace = hitTrace(store, db, row, 'edges')
      assert.equal(trace.steps.length, 1)
      assert.equal(trace.steps[0].id, step.id)
    }
  })
})

test('步骤去重：显式关联的那条不标推断，同得分点捡来的兄弟步骤才标', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.4.4.6')
    const pt = db.prepare("SELECT id FROM score_point WHERE code = 'terminal-access'").get()
    const linked = store.addChainStep('edges', { stage_code: 'internal', title: '这条是本步', tool: 'id', asset_id: asset, point_id: pt.id })
    store.addChainStep('edges', { stage_code: 'internal', title: '这条只是同得分点', tool: 'whoami', asset_id: asset, point_id: pt.id })
    const h = store.addScoreHit('edges', { code: 'terminal-access', asset_id: asset, step_id: linked.id, evidence: '终端权限 1 台' })
    const row = db.prepare('SELECT h.*, p.code FROM score_hit h LEFT JOIN score_point p ON p.id = h.point_id WHERE h.id = ?').get(h.id)
    const trace = hitTrace(store, db, row, 'edges')
    assert.equal(trace.step_source, 'linked')
    assert.equal(trace.steps.length, 2, '同得分点的两条步骤都会进来')
    const byId = new Map(trace.steps.map((s) => [s.id, s]))
    assert.equal(byId.get(linked.id).inferred, false, '显式关联的那条是实锤')
    assert.equal(trace.steps.filter((s) => s.inferred === true).length, 1, '另一条靠推断进来，要标出来')
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   五、摘要里的复现入口分类：三种方式各算一条，不混在一起
   ══════════════════════════════════════════════════════════════════════════ */

test('摘要统计：回放请求 / 命令行 / 其它方式三类分开数，合计等于正文条数', () => {
  withStore(({ store, db }) => {
    /* ① 有真抓包 → http（Burp / Yakit 回放） */
    const a1 = addAsset(db, '10.5.5.1')
    const s1 = store.addChainStep('edges', {
      stage_code: 'internet', title: '注入', tool: 'curl -i -s "http://10.5.5.1/item?id=1"',
      asset_id: a1,
    })
    store.addHttpEvidence('edges', {
      asset_id: a1, method: 'POST', url: 'http://10.5.5.1/item?id=1',
      request: 'POST /item?id=1 HTTP/1.1\r\nHost: 10.5.5.1\r\n\r\nid=1', response: 'HTTP/1.1 200 OK',
    })
    store.addScoreHit('edges', { code: 'web-app', asset_id: a1, step_id: s1.id, target: 'http://10.5.5.1/item', evidence: '注入进后台' })
    /* ② 关联步骤里是真实命令 → cli */
    const a2 = addAsset(db, '10.5.5.2')
    const s2 = store.addChainStep('edges', { stage_code: 'internal', title: '横向', tool: 'impacket-psexec administrator:P@ss@10.5.5.2 cmd.exe', asset_id: a2 })
    store.addScoreHit('edges', { code: 'server-host', asset_id: a2, step_id: s2.id, target: '10.5.5.2', evidence: '回显 uid=0' })
    /* ③ 只有动作口径、没有命令 → method */
    const a3 = addAsset(db, '10.5.5.3')
    store.addScoreHit('edges', { code: 'iiot', asset_id: a3, target: '10.5.5.3', evidence: '工业设备被拿下' })
    const rep = scoreReport(store, 'edges')
    assert.deepEqual(rep.items.map((x) => x.repro_kind).sort(), ['cli', 'http', 'method'])
    const cells = (rep.markdown.split('\n').find((l) => l.startsWith('| **')) || '').split('|').map((c) => c.trim())
    assert.equal(cells[1], '**' + rep.summary.points + ' 分**')
    assert.equal(cells[2], '3 条', '正文条数')
    assert.equal(cells[3], '1 条', 'Burp/Yakit 回放')
    assert.equal(cells[4], '1 条', '命令行回放')
    assert.equal(cells[5], '1 条', '其它方式')
  })
})

test('摘要统计：没有截图时说 0 张，不说"现场 0 张 / 生成 0 张"', () => {
  withStore(({ store, db }) => {
    seedHit(store, db)
    const line = scoreReport(store, 'edges').markdown.split('\n').find((l) => l.startsWith('| **'))
    assert.ok(line.includes('0 张截图'), '没有截图要明说')
    assert.ok(!line.includes('现场截图'), '全是 0 时不要解释"哪些是生成的"')
  })
})
