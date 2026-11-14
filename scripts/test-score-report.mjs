// 演练台报告链路：`hitTrace` / `scoreReport` / `scoreChain` / `representativeShots`。
//
// 为什么值得单独一个文件：这四个函数决定**交付物长什么样**——报告里"这一步是怎么做到的"、
// "凭据/通道挂在哪条成果上"、"复现命令是什么"、"哪些命中不算数"，全在这里推。
// 它们过去的共同毛病是「算错了也不报错」：四处 `try { } catch { }` 把异常吞成空数组，
// 于是功能整块失效而测试全绿（实测 `tunnelIsLegit` 漏 import 就是这样：通道小节永远为空、
// `needs_channel` 永远 false、攻击链的"真实隧道 = 边界突破实锤"判定整块失效）。
//
// 所以这个文件只做一件事：**播种真数据、断言看得见的输出**，不读源码形状。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore } from '../lib/redteam/store-core.js'
import {
  hitTrace, scoreReport, scoreChain, representativeShots,
} from '../lib/redteam/score-report.js'

/** 开一个临时靶标库跑 fn；清理吞异常（Windows 上刚 close 的 SQLite 目录偶尔 EPERM）。 */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purge-report-'))
  const store = new RedteamStore(dir)
  try {
    const eng = store.openEngagement('score', [])
    return fn({ store, eng, db: store.db(eng.id), id: eng.id })
  } finally {
    try { store.close() } catch { /* 已关闭 */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows EPERM */ }
  }
}

/** 直接插资产行：`addScoreHit` 只按 id 引用资产，界面展示才需要 ip。 */
function addAsset(db, ip, name = null, cidr = '10.0.0.0/24') {
  db.prepare('INSERT INTO asset(ip, segment_cidr, state, primary_name) VALUES(?,?,?,?)')
    .run(ip, cidr, 'live', name)
  return Number(db.prepare('SELECT id FROM asset ORDER BY id DESC LIMIT 1').get().id)
}

/** 把某条命中的时间改成固定值：排序、分组代表、依赖推导都按它来，不钉住就测不出先后。 */
function setHitAt(db, hitId, iso) {
  db.prepare('UPDATE score_hit SET recorded_at = ? WHERE id = ?').run(iso, hitId)
}

/** 1×1 PNG（合法魔数 + 尺寸字节），`addShot` 靠魔数判 mime、靠 IHDR 读宽高。 */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 取一条命中的完整行，喂给 `hitTrace`（它要 h.* 的字段，不是 addScoreHit 的返回值）。 */
function hitRow(db, id) {
  return db.prepare('SELECT h.*, p.code FROM score_hit h LEFT JOIN score_point p ON p.id = h.point_id WHERE h.id = ?').get(id)
}

/* ══════════════════════════════════════════════════════════════════════════
   一、hitTrace：这条得分"是怎么拿到的"
   ══════════════════════════════════════════════════════════════════════════ */

test('hitTrace：没有任何步骤与资产时，如实报两条缺口而不是编一份说明', () => {
  withStore(({ store, db }) => {
    const r = store.addScoreHit('score', { code: 'web-app', evidence: '拿下后台管理页' })
    const trace = hitTrace(store, db, hitRow(db, r.id), 'score')
    assert.deepEqual(trace.steps, [])
    assert.equal(trace.step_source, null)
    assert.equal(trace.vuln, null)
    assert.equal(trace.how, '', 'how 是空串而不是 "undefined"')
    assert.equal(trace.complete, false)
    // 顺序有意义：先"没有步骤"，再"没有 vuln_id"
    assert.equal(trace.gaps.length, 2)
    assert.match(trace.gaps[0], /没有攻击步骤记录/)
    assert.match(trace.gaps[1], /没有关联 `vuln_id`/)
    assert.deepEqual(trace.evidence_refs, [])
  })
})

test('hitTrace：显式 step_id 优先，归因标 linked', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    const step = store.addChainStep('score', {
      stage_code: 'internal', title: '登录后台', tool: 'curl -i -s http://10.2.2.9/admin',
      asset_id: asset, evidence_ref: 'ev/1.txt',
    })
    const r = store.addScoreHit('score', {
      code: 'web-app', asset_id: asset, step_id: step.id, evidence: '后台管理员可操作',
    })
    const trace = hitTrace(store, db, hitRow(db, r.id), 'score')
    assert.equal(trace.step_source, 'linked')
    assert.equal(trace.steps.length, 1)
    assert.equal(trace.steps[0].id, step.id)
    assert.notEqual(trace.steps[0].inferred, true, '显式关联的步骤不标推断')
    assert.deepEqual(trace.evidence_refs, ['ev/1.txt'])
    assert.equal(trace.how, '登录后台; command: curl -i -s http://10.2.2.9/admin')
  })
})

test('hitTrace：没有 step_id 时按 vuln_id 归因，标 vuln', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    const vuln = store.addVuln('score', {
      asset_id: asset, cve: 'CVE-2021-44228', title: 'Log4Shell', severity: 'critical', target: 'http://10.2.2.9/app',
    })
    store.addChainStep('score', {
      stage_code: 'internet', title: '打 Log4j', tool: 'curl -X POST http://10.2.2.9/app/x -d @/tmp/p.json', vuln_id: vuln.id,
    })
    const r = store.addScoreHit('score', { code: 'web-app', asset_id: asset, vuln_id: vuln.id, evidence: 'RCE 成功' })
    const trace = hitTrace(store, db, hitRow(db, r.id), 'score')
    assert.equal(trace.step_source, 'vuln')
    assert.equal(trace.steps.length, 1)
    assert.equal(trace.vuln.cve, 'CVE-2021-44228')
    assert.equal(trace.how, 'Exploited CVE-2021-44228 Log4Shell (critical); command: curl -X POST http://10.2.2.9/app/x -d @/tmp/p.json')
  })
})

test('hitTrace：只有同资产同得分点的步骤时退到 point 档并标 inferred', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    const pt = db.prepare("SELECT id FROM score_point WHERE code = 'terminal-access'").get()
    store.addChainStep('score', {
      stage_code: 'internal', title: '批量登录终端', tool: 'wmiexec administrator@10.2.2.9',
      asset_id: asset, point_id: pt.id,
    })
    const r = store.addScoreHit('score', { code: 'terminal-access', asset_id: asset, evidence: '终端权限 1 台' })
    const trace = hitTrace(store, db, hitRow(db, r.id), 'score')
    assert.equal(trace.step_source, 'point')
    assert.equal(trace.steps.length, 1)
    assert.equal(trace.steps[0].inferred, true, '推断来的步骤必须标出来，界面据此提示"仅供参考"')
  })
})

test('hitTrace：连同得分点都没有时才退到"同资产全部步骤"，标 asset', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    store.addChainStep('score', {
      stage_code: 'internet', title: '扫端口', tool: 'nmap -sV 10.2.2.9', asset_id: asset,
    })
    const r = store.addScoreHit('score', { code: 'web-app', asset_id: asset, evidence: '后台可写' })
    const trace = hitTrace(store, db, hitRow(db, r.id), 'score')
    assert.equal(trace.step_source, 'asset')
    assert.equal(trace.steps.length, 1)
    assert.equal(trace.steps[0].inferred, true)
    assert.equal(trace.steps[0].title, '扫端口')
  })
})

test('hitTrace：步骤里有 tool 才不算缺命令；有步骤没 tool 要专门报一条', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    store.addChainStep('score', { stage_code: 'internal', title: '手工翻文件', asset_id: asset })
    const r = store.addScoreHit('score', { code: 'file-storage', asset_id: asset, evidence: '拿到共享目录清单' })
    const trace = hitTrace(store, db, hitRow(db, r.id), 'score')
    assert.equal(trace.steps.length, 1)
    assert.ok(trace.gaps.some((g) => /攻击步骤没写 `tool`/.test(g)), '有步骤但没命令要单独报')
    assert.ok(!trace.gaps.some((g) => /没有攻击步骤记录/.test(g)), '两条缺口互斥，不能同时报')
  })
})

test('hitTrace：target 写成网段时视作资产级成果，凭据与隧道照样挂上', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9', 'gw-01', '10.2.2.0/24')
    const cred = store.addCredential('score', { asset_id: asset, host: '10.2.2.9', username: 'admin', secret_value: 'P@ssw0rd!' })
    const tun = store.addTunnel('score', {
      asset_id: asset, entry_kind: 'target-http', listen: '127.0.0.1:1080', reach: '10.20.30.0/24', command: 'chisel client',
    })
    assert.equal(tun.legit, true)
    const r = store.addScoreHit('score', { code: 'boundary-logical', asset_id: asset, target: '10.20.30.0/24', evidence: '进入逻辑隔离内网' })
    const trace = hitTrace(store, db, hitRow(db, r.id), 'score')
    assert.equal(trace.credentials.length, 1)
    assert.equal(trace.credentials[0].id, cred.id)
    assert.equal(trace.tunnels.length, 1, '通道必须挂得上 —— 挂不上说明 tunnelIsLegit 那条路径炸了')
    assert.equal(trace.tunnels[0].legit, true)
    assert.equal(trace.tunnels[0].entry_kind, 'target-http')
  })
})

// 回归：拆分 `store-core.js` 时漏了一行 import，`tunnelIsLegit` 变成未定义，
// 而调用点被 `try { } catch { }` 包着 —— 结果通道永远为空、`needs_channel` 永远 false，
// 报告少一整节、攻击链的"真实隧道"判定整块失效，而 2976 条测试全绿。
test('hitTrace：登记了隧道就必须能读出 legit，而不是被 catch 吞成空数组', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    store.addTunnel('score', { asset_id: asset, entry_kind: 'target-http', listen: '127.0.0.1:1080', reach: '10.20.30.0/24' })
    const r = store.addScoreHit('score', {
      code: 'boundary-logical', asset_id: asset, target: 'http://10.2.2.9/app', evidence: '从外网进到内网',
    })
    const trace = hitTrace(store, db, hitRow(db, r.id), 'score')
    assert.equal(trace.tunnels.length, 1)
    assert.equal(trace.tunnels[0].legit, true)
    // 自己 VPS 上的通道不算突破：legit=false 也要如实传出来，不能一起丢掉
    store.addTunnel('score', { asset_id: asset, entry_kind: 'self-only', listen: '0.0.0.0:8443', reach: '' })
    const trace2 = hitTrace(store, db, hitRow(db, r.id), 'score')
    assert.equal(trace2.tunnels.length, 2)
    assert.deepEqual(trace2.tunnels.map((t) => t.legit), [true, false])
  })
})

test('hitTrace：target 指向别的机器时不挂这台资产的凭据（否则报告又长又假）', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    store.addCredential('score', { asset_id: asset, host: '10.2.2.9', username: 'root', secret_value: 'toor' })
    const r = store.addScoreHit('score', { code: 'db-credential', asset_id: asset, target: '10.9.9.9:3306', evidence: 'MySQL root 登录' })
    const trace = hitTrace(store, db, hitRow(db, r.id), 'score')
    assert.deepEqual(trace.credentials, [])
  })
})

test('hitTrace：没写 target 的纯资产级成果，按资产挂凭据', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    store.addCredential('score', { asset_id: asset, host: '10.2.2.9', username: 'root', secret_value: 'toor' })
    const r = store.addScoreHit('score', { code: 'server-host', asset_id: asset, evidence: '拿到主机 root' })
    const trace = hitTrace(store, db, hitRow(db, r.id), 'score')
    assert.equal(trace.credentials.length, 1)
    assert.equal(trace.credentials[0].username, 'root')
  })
})

test('hitTrace：不挂资产就一条凭据都不挂（host LIKE 分支实际走不到，想挂先登记资产）', () => {
  withStore(({ store, db }) => {
    store.addCredential('score', { host: 'http://10.5.5.5:8080/login', username: 'sa', secret_value: 'hunter2' })
    const r = store.addScoreHit('score', { code: 'web-app', target: 'http://10.5.5.5:8080/admin', evidence: '后台可写' })
    const trace = hitTrace(store, db, hitRow(db, r.id), 'score')
    /* 现状锁定：凭据的 `host LIKE ?` 分支只在 sameAsset 为真时才进得去，而 sameAsset 要求
       targetMatchesAsset() 为真 —— asset_id 为空时 asset 是 undefined，该函数第 120 行
       直接 return false。所以那条 LIKE 分支在这条路径上永远走不到（已在盲区登记）。
       要按主机匹配凭据，正确做法是先 insert asset 再给 hit 挂 asset_id。 */
    assert.equal(trace.credentials.length, 0)
  })
})

test('hitTrace：device 名形态的 target（pc-001）也算资产级，不因为"不像 IP"就丢掉挂载', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9', 'pc-001')
    store.addTunnel('score', { asset_id: asset, entry_kind: 'target-agent', listen: '127.0.0.1:7890', reach: '10.30.0.0/16' })
    const r = store.addScoreHit('score', { code: 'terminal-access', asset_id: asset, target: 'pc-001', evidence: '终端权限 1 台' })
    const trace = hitTrace(store, db, hitRow(db, r.id), 'score')
    assert.equal(trace.tunnels.length, 1)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   二、scoreReport：交付物本体
   ══════════════════════════════════════════════════════════════════════════ */

test('scoreReport：空库也要给一份能看的报告，不是崩掉或全 null', () => {
  withStore(({ store }) => {
    const rep = scoreReport(store, 'score')
    assert.deepEqual(rep.items, [])
    assert.deepEqual(rep.stages, [])
    assert.equal(rep.summary.count, 0)
    assert.equal(rep.summary.points, 0)
    assert.equal(rep.target, 'score', '没有 target_name 时用靶标 id 兜底')
    assert.match(rep.markdown, /^# score · 红队成果复现报告/m)
    assert.match(rep.markdown, /## 0\. 摘要与对账/)
    assert.match(rep.markdown, /## 1\. 复现前置条件/)
    assert.match(rep.markdown, /## 4\. 得分点说明/)
  })
})

test('scoreReport：有真实抓包时由报文合成 curl，标 synthesized', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    const vuln = store.addVuln('score', { asset_id: asset, title: 'SQL 注入', severity: 'high', target: 'http://10.2.2.9/item?id=1' })
    store.addHttpEvidence('score', {
      vuln_id: vuln.id, asset_id: asset, method: 'POST', url: 'http://10.2.2.9/item',
      request: 'POST /item?id=1 HTTP/1.1\r\nHost: 10.2.2.9\r\nAuthorization: Basic YTpi\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\nid=1%20union%20select%201',
      response: 'HTTP/1.1 200 OK',
    })
    const r = store.addScoreHit('score', { code: 'web-app', asset_id: asset, vuln_id: vuln.id, target: 'http://10.2.2.9/item?id=1', evidence: '注入点可读库' })
    const rep = scoreReport(store, 'score')
    const it = rep.items.find((x) => x.id === r.id)
    assert.equal(it.replay_cmd_kind, 'synthesized')
    assert.equal(
      it.replay_cmd,
      "curl -i -s -X POST -H 'Authorization: Basic YTpi' -H 'Content-Type: application/x-www-form-urlencoded'"
        + " -d 'id=1%20union%20select%201' 'http://10.2.2.9/item?id=1'",
    )
    assert.match(it.replay_cmd, /-H 'Authorization: Basic YTpi'/, '鉴权头不能丢，丢了复现是 401')
    assert.equal(it.replay_source, 'linked')
    assert.equal(it.http_entry, true)
    assert.equal(it.replay_http, 'POST /item?id=1 HTTP/1.1\r\nHost: 10.2.2.9\r\nAuthorization: Basic YTpi\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\nid=1%20union%20select%201', '有真抓包就给原文')
  })
})

test('scoreReport：显式关联步骤里的非 curl 命令原样给出，标 linked 且标成非 HTTP 协议', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    const step = store.addChainStep('score', {
      stage_code: 'internal', title: 'psexec 横向', asset_id: asset,
      tool: 'impacket-psexec administrator:P@ssw0rd@10.2.2.9 cmd.exe',
    })
    const r = store.addScoreHit('score', {
      code: 'terminal-access', asset_id: asset, step_id: step.id, target: '10.2.2.9', evidence: '终端权限 1 台',
    })
    const it = scoreReport(store, 'score').items.find((x) => x.id === r.id)
    assert.equal(it.replay_cmd, 'impacket-psexec administrator:P@ssw0rd@10.2.2.9 cmd.exe', '真实命令必须原样保留')
    assert.equal(it.replay_cmd_kind, 'linked')
    assert.equal(it.repro_kind, 'cli')
    assert.equal(it.repro_nonhttp, true, 'Burp/Yakit 发不了 SMB，报告要据此换措辞')
  })
})

test('scoreReport：靠隧道成立的边界突破条目优先用通道模板，而不是同资产那条上传马的 curl', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    // 同资产上记着一条"上传冰蝎马"的 curl：旧实现会把它当成边界突破的复现命令（张冠李戴）
    store.addChainStep('score', {
      stage_code: 'internal', title: '上传冰蝎马', asset_id: asset,
      tool: 'curl -i -s -X POST http://10.2.2.9/shell.jsp -d @/tmp/shell.bin',
    })
    store.addTunnel('score', { asset_id: asset, entry_kind: 'target-http', listen: '127.0.0.1:', reach: '10.20.30.0/24' })
    const r = store.addScoreHit('score', {
      code: 'boundary-logical', asset_id: asset, target: '10.20.30.0/24', evidence: '进入逻辑隔离内网',
    })
    const it = scoreReport(store, 'score').items.find((x) => x.id === r.id)
    assert.equal(it.replay_cmd_kind, 'template')
    assert.match(it.replay_cmd, /curl --socks5-hostname 127\.0\.0\.1/)
    assert.ok(Array.isArray(it.replay_cmd_unfilled) && it.replay_cmd_unfilled.length > 0, '端口填不上就要如实列出来')
    assert.deepEqual(it.replay_cmd_unfilled, ['<端口>'])
    assert.equal(it.repro_kind, 'method', '模板没填满不算可跑的命令')
  })
})

test('scoreReport：模板占位符全填上时才算 cli', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    store.addTunnel('score', { asset_id: asset, entry_kind: 'target-http', listen: '127.0.0.1:1080', reach: '10.20.30.0/24' })
    const r = store.addScoreHit('score', {
      code: 'boundary-logical', asset_id: asset, target: '10.20.30.0/24', evidence: '进入逻辑隔离内网',
    })
    const it = scoreReport(store, 'score').items.find((x) => x.id === r.id)
    assert.equal(it.replay_cmd_kind, 'template')
    assert.equal(it.replay_cmd, 'curl --socks5-hostname 127.0.0.1:1080 http://10.20.30.0/ -i')
    assert.equal(it.replay_cmd_unfilled, undefined, '全填好时不出这个字段（否则界面会说"还差几处"）')
    assert.equal(it.repro_kind, 'cli')
  })
})

test('scoreReport：只有步骤里的普通命令时标 from_step，并如实说明不是本步动作', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    store.addChainStep('score', {
      stage_code: 'internal', title: '资产扫描', asset_id: asset, tool: 'ffuf -u http://10.2.2.9/FUZZ -w w.txt',
    })
    /* 用一个**没有动作模板**的得分点（iiot 的 SCORE_CONFIRM.script 是空串）：否则会先被 ③ 模板
       分支接走，测出来的就不是 from_step。 */
    const r = store.addScoreHit('score', { code: 'iiot', asset_id: asset, target: 'plc-03', evidence: '拿下 PLC' })
    const it = scoreReport(store, 'score').items.find((x) => x.id === r.id)
    assert.equal(it.replay_cmd_kind, 'from_step')
    assert.equal(it.replay_source, 'step')
    assert.equal(it.replay_cmd, 'ffuf -u http://10.2.2.9/FUZZ -w w.txt')
  })
})

test('scoreReport：得分点没有动作模板且没有命令时，replay_cmd 是 null 而不是空串', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9', null, '10.2.2.0/24')
    const r = store.addScoreHit('score', { code: 'iiot', asset_id: asset, target: 'plc-03', evidence: '拿下 PLC' })
    const it = scoreReport(store, 'score').items.find((x) => x.id === r.id)
    assert.equal(it.replay_cmd, null)
    assert.equal(it.replay_cmd_kind, null)
    assert.equal(it.repro_kind, 'method')
    assert.equal(it.replay_source, null)
    assert.equal(it.confirm.script, '', 'iiot 的确认口径没有脚本')
  })
})

test('scoreReport：同一得分点 + 同一动作的批量命中合并成一条，代表条目落在多数派上', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    const step = store.addChainStep('score', {
      stage_code: 'internal', title: '批量 GPO 下发', asset_id: asset, tool: 'wmiexec administrator@10.2.2.9',
    })
    const ids = []
    for (let i = 1; i <= 5; i += 1) {
      // 第一台是特例（域管账号），其余四台是 GPO 打法：代表条目必须落在四台那侧
      const ev = i === 1 ? '域管账号登录成功 terminal-1' : 'GPO 下发成功 terminal-' + i
      const r = store.addScoreHit('score', {
        code: 'terminal-access', asset_id: asset, step_id: step.id, target: 'pc-00' + i, evidence: ev,
      })
      setHitAt(db, r.id, '2026-01-01T00:00:0' + i + 'Z')
      ids.push(r.id)
    }
    const rep = scoreReport(store, 'score')
    assert.equal(rep.items.length, 1, '五台要合并成一条，否则报告变成流水账')
    const g = rep.items[0]
    assert.equal(g.is_group, true)
    assert.equal(g.group_size, 5)
    assert.equal(g.points, 50, '合并条目的分值是成员之和（5 × 10）')
    assert.equal(g.id, ids[1], '代表条目 = 证据众数（第 2~5 条那句），不是最早那条特例')
    assert.equal(g.group_targets.length, 5)
    assert.equal(g.chain_no, 1)
  })
})

test('scoreReport：groupMin 调高就不合并，说明合并阈值是配置项而不是硬编码', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    const step = store.addChainStep('score', { stage_code: 'internal', title: '批量', asset_id: asset, tool: 'wmiexec a@10.2.2.9' })
    for (let i = 1; i <= 5; i += 1) {
      store.addScoreHit('score', { code: 'terminal-access', asset_id: asset, step_id: step.id, target: 'pc-00' + i, evidence: 'GPO 下发成功 ' + i })
    }
    assert.equal(scoreReport(store, 'score').items.length, 1)
    assert.equal(scoreReport(store, 'score', { groupMin: 6 }).items.length, 5)
  })
})

test('scoreReport：没挂动作步骤的命中永不合并（没有共同动作就没有"批量"）', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    for (let i = 1; i <= 6; i += 1) {
      store.addScoreHit('score', { code: 'netdev', asset_id: asset, target: 'sw-00' + i, evidence: '弱口令进入交换机 ' + i })
    }
    const rep = scoreReport(store, 'score')
    assert.equal(rep.items.length, 6)
    assert.ok(rep.items.every((x) => x.is_group !== true))
  })
})

test('scoreReport：条目按阶段顺序编号，跳过空阶段也不重排（②③④ 才是链路真实位置）', () => {
  withStore(({ store, db }) => {
    const ext = addAsset(db, '203.0.113.9', null, '203.0.113.0/24')
    const inner = addAsset(db, '10.2.2.9')
    /* internet 阶段：外网资产 + 没有 POINT_STAGE_OVERRIDE 的得分点（web-app 被硬指到 target，
       拿它测 internet 会得到 target —— 见下面那条 web-app 的单独断言） */
    store.addScoreHit('score', { code: 'netdev', asset_id: ext, target: 'http://203.0.113.9/', evidence: '外网路由器' })
    // boundary 阶段（POINT_STAGE_OVERRIDE 硬指 boundary）→ 期望 ③
    store.addScoreHit('score', { code: 'boundary-strong', asset_id: inner, target: '10.30.0.0/16', evidence: '进入强隔离内网' })
    // internal 阶段 → 期望 ④
    store.addScoreHit('score', { code: 'terminal-access', asset_id: inner, target: '10.2.2.9', evidence: '终端权限 1 台' })
    const rep = scoreReport(store, 'score')
    assert.deepEqual(rep.items.map((x) => x.code), ['netdev', 'boundary-strong', 'terminal-access'])
    assert.deepEqual(rep.items.map((x) => x.chain_no), [1, 2, 3])
    /* 空阶段被过滤掉，但 ordinal 仍是链路真实位置（recon=1 被跳过，第一条是 2） */
    assert.deepEqual(rep.stages.map((s) => [s.code, s.ordinal]), [['internet', 2], ['boundary', 3], ['internal', 4]])
    assert.deepEqual(rep.stages.map((s) => s.cumulative), [200, 10200, 10210])
  })
})

test('scoreReport：阶段顺序压过时间顺序 —— 后发生的边界突破仍排在先发生的内网条目之前', () => {
  withStore(({ store, db }) => {
    const ext = addAsset(db, '203.0.113.5', null, '203.0.113.0/24')
    const inner = addAsset(db, '10.9.9.9', null, '10.9.9.0/24')
    /* 故意让时间顺序与阶段顺序相反：内网条目先发生、边界突破后发生。
       排序第一键是阶段，所以报告里仍然是"先突破、再进内网"。 */
    const a1 = store.addScoreHit('score', { code: 'terminal-access', asset_id: inner, target: '10.9.9.9', evidence: '内网终端 1 台' })
    setHitAt(db, a1.id, '2026-01-01T00:00:01Z')
    const a2 = store.addScoreHit('score', { code: 'boundary-logical', asset_id: ext, target: '10.99.0.0/16', evidence: '进入逻辑隔离内网' })
    setHitAt(db, a2.id, '2026-01-01T00:00:09Z')
    const rep = scoreReport(store, 'score')
    const boundary = rep.items.find((x) => x.code === 'boundary-logical')
    const terminal = rep.items.find((x) => x.code === 'terminal-access')
    assert.equal(boundary.chain_no, 1, '边界突破是链条里的第 1 条')
    assert.equal(terminal.chain_no, 2, '内网条目排第 2，不因为时间更早而抢到前面')
    /* items 数组本身是 SQL 顺序（按 recorded_at），编号在排序副本上算 ——
       两者不一致正是这条用例要钉的：只按时间排会得到[内网, 边界]这种倒过来的链路。 */
    assert.equal(rep.items[0].code, 'terminal-access')
    const md = rep.markdown
    assert.ok(md.indexOf('## ③ 边界突破') < md.indexOf('## ④ 内网资产权限'), 'markdown 章节也必须按阶段排')
  })
})

test('scoreReport：web-app 这类被硬指阶段的得分点，阶段跟着表走而不是跟着资产走', () => {
  withStore(({ store, db }) => {
    const ext = addAsset(db, '203.0.113.9', null, '203.0.113.0/24')
    const r = store.addScoreHit('score', { code: 'web-app', asset_id: ext, target: 'http://203.0.113.9/', evidence: '外网后台' })
    const it = scoreReport(store, 'score').items.find((x) => x.id === r.id)
    /* 资产是外网（scope=external → 本该 internet），但 POINT_STAGE_OVERRIDE['web-app']='target'
       优先 —— 记下来，否则下次有人"修"成跟资产走会把报告章节顺序整片打乱。 */
    assert.equal(it.stage_code, 'target')
  })
})

test('scoreReport：自建账号与停用得分点的命中不进正文，只报个数', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    store.addScoreHit('score', { code: 'web-app', asset_id: asset, evidence: '真实后台' })
    store.addScoreHit('score', { code: 'web-app', asset_id: asset, evidence: '自己注册的账号', self_created: true })
    db.prepare("UPDATE score_point SET enabled = 0 WHERE code = 'file-storage'").run()
    store.addScoreHit('score', { code: 'file-storage', asset_id: asset, evidence: '共享目录' })
    const rep = scoreReport(store, 'score')
    assert.equal(rep.items.length, 1)
    assert.equal(rep.items[0].code, 'web-app')
    assert.equal(rep.summary.selfCreatedExcluded, 1)
    assert.equal(rep.summary.disabledExcluded, 1)
    assert.equal(rep.summary.points, 100, '总分与面板口径一致：停用与自建都不算')
  })
})

test('scoreReport：纯英文单词的用户名不当特征串认领，带数字或域的才认', () => {
  withStore(({ store, db }) => {
    const redis = addAsset(db, '10.1.2.1')
    const ext = addAsset(db, '203.0.113.5', null, '203.0.113.0/24')
    /* 来源条目：口令是从 10.7.7.7 那台 Redis 拿的（强线索取凭据 tool/note 的第一个 IP） */
    store.addScoreHit('score', { code: 'db-credential', asset_id: redis, target: '10.7.7.7', evidence: 'Redis 弱口令可取全量' })
    store.addCredential('score', { host: '10.1.2.1', username: 'svc-1041', secret_value: 'Aa1-Bb2-Cc3', tool: 'redis-cli -h 10.7.7.7:6379 取值' })
    store.addCredential('score', { host: '10.1.2.1', username: 'default', secret_value: 'Zz9-Qw8-Er7', tool: 'redis-cli -h 10.7.7.7:6379 取值' })
    store.addScoreHit('score', { code: 'secdev', asset_id: ext, target: '10.1.2.1', evidence: 'svc-1041 口令登录安全设备' })
    store.addScoreHit('score', { code: 'iiot', asset_id: ext, target: '10.1.2.1', evidence: 'default 口令登录物联网设备' })
    const rep = scoreReport(store, 'score')
    const good = rep.items.find((x) => x.code === 'secdev')
    const bad = rep.items.find((x) => x.code === 'iiot')
    assert.deepEqual(good.deps.map((d) => d.name), ['db-credential'], '工号形态的账号是特征串，认领得对')
    /* 实测踩过：边界条目的证据里写着 `default via 10.1.2.1`，于是用户名 default 的
       Redis 凭据被认成本条来处，推出"跨境突破依赖 Redis"。纯英文单词一律不认。 */
    assert.deepEqual(bad.deps, [], '纯英文单词会撞车，不能拿来认领')
  })
})

test('scoreReport：前置推导只用本条自己写出来的线索，推不出就不编', () => {
  withStore(({ store, db }) => {
    const es = addAsset(db, '10.2.2.9')
    const dc = addAsset(db, '10.3.3.7')
    store.addScoreHit('score', { code: 'bigdata-system', asset_id: es, target: '10.2.2.9:9200', evidence: 'ES 聊天记录里翻到域管口令' })
    store.addScoreHit('score', {
      code: 'central-system', asset_id: dc, target: '10.3.3.7',
      evidence: '用 ES 里翻到的口令登录域控，来源 10.2.2.9',
    })
    // 第三条完全无关：不该被硬塞一个前置
    store.addScoreHit('score', { code: 'netdev', asset_id: dc, target: '10.9.9.9', evidence: '交换机弱口令' })
    const rep = scoreReport(store, 'score')
    const central = rep.items.find((x) => x.code === 'central-system')
    assert.equal(central.deps.length, 1, '同分组的条目不能互相当前置')
    assert.equal(central.deps[0].target, '10.2.2.9:9200')
    const netdev = rep.items.find((x) => x.code === 'netdev')
    assert.deepEqual(netdev.deps, [])
  })
})

test('scoreReport：互为前置的两条一起撤掉，不能互相指认', () => {
  withStore(({ store, db }) => {
    const a1 = addAsset(db, '10.3.3.7')
    const a2 = addAsset(db, '10.3.3.8')
    store.addScoreHit('score', { code: 'server-host', asset_id: a1, target: '10.3.3.7', evidence: '从 10.3.3.8 跳过来拿到主机' })
    store.addScoreHit('score', { code: 'db-credential', asset_id: a2, target: '10.3.3.8', evidence: '从 10.3.3.7 上翻到数据库口令' })
    const rep = scoreReport(store, 'score')
    assert.deepEqual(rep.items.map((x) => x.deps), [[], []])
  })
})

test('scoreReport：needs_channel 只在"非 internet 阶段且有通道"时为 true', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    store.addTunnel('score', { asset_id: asset, entry_kind: 'target-http', listen: '127.0.0.1:1080', reach: '10.20.30.0/24' })
    store.addScoreHit('score', { code: 'boundary-logical', asset_id: asset, target: '10.20.30.0/24', evidence: '进入逻辑隔离内网' })
    const rep = scoreReport(store, 'score')
    assert.equal(rep.items[0].needs_channel, true, '这条判定在 tunnelIsLegit 漏 import 时恒为 false')
    assert.equal(rep.summary.tunnels, 1)
  })
})

test('scoreReport：外网阶段的条目即使挂了通道，也不提示"需要通道"', () => {
  withStore(({ store, db }) => {
    const ext = addAsset(db, '203.0.113.5', null, '203.0.113.0/24')
    store.addTunnel('score', { asset_id: ext, entry_kind: 'target-http', listen: '127.0.0.1:1080', reach: '10.20.30.0/24' })
    store.addScoreHit('score', { code: 'netdev', asset_id: ext, target: '203.0.113.5', evidence: '外网交换机弱口令' })
    const it = scoreReport(store, 'score').items[0]
    /* 通道确实挂上了（trace 走资产级），但这一条本身就在 internet 阶段 ——
       外网成果不需要通道就能复现，标成"需要通道"是把验收人往错的方向带。 */
    assert.equal(it.stage_code, 'internet')
    assert.equal(it.tunnels.length, 1)
    assert.equal(it.needs_channel, false)
  })
})

test('scoreReport：代表截图按得分点取，现场截图优先于生成的证据卡，且报出总数', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    const r = store.addScoreHit('score', { code: 'terminal-access', asset_id: asset, target: '10.2.2.9', evidence: '终端权限 1 台' })
    const point = db.prepare("SELECT id FROM score_point WHERE code = 'terminal-access'").get()
    for (const [label, kind, at] of [['L0', 'screenshot', '2026-01-01T00:00:01Z'], ['L1', 'screenshot', '2026-01-01T00:00:02Z'], ['CARD', 'card', '2026-01-01T00:00:00Z'], ['L2', 'screenshot', '2026-01-01T00:00:03Z']]) {
      store.addShot('score', { point_id: point.id, hit_id: r.id, kind, data_base64: PNG_1X1, captured_at: at, label })
    }
    const rep = scoreReport(store, 'score')
    const it = rep.items[0]
    assert.equal(it.shot_total, 4, '总数是这点下全部截图，不是本次挑出的张数')
    assert.equal(it.shots.length, 3, '每个得分点最多 3 张')
    assert.deepEqual(it.shots.map((s) => s.label), ['L0', 'L1', 'L2'], '证据卡排最后，不能把真截图挤掉')
    assert.match(it.shots[0].url, /^shots\//)
  })
})

test('scoreReport：shotRef=relative 时 markdown 里写相对路径，整包拷走就能看', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    const r = store.addScoreHit('score', { code: 'terminal-access', asset_id: asset, target: '10.2.2.9', evidence: '终端权限 1 台' })
    const point = db.prepare("SELECT id FROM score_point WHERE code = 'terminal-access'").get()
    const shot = store.addShot('score', { point_id: point.id, hit_id: r.id, data_base64: PNG_1X1, label: 'RELSHOT' })
    const rel = scoreReport(store, 'score', { shotRef: 'relative' }).markdown
    assert.ok(rel.includes('shots/' + shot.file), '相对模式要出现 shots/<file>')
    const abs = scoreReport(store, 'score').markdown
    assert.ok(abs.includes(store.shotsDirOf('score')), '默认给绝对路径，下载到哪都能显示')
  })
})

test('scoreReport：记录里已写明"未验证"的凭据不进 1.2 节，只留能用的', () => {
  withStore(({ store, db }) => {
    const inner = addAsset(db, '10.9.9.9', null, '10.9.9.0/24')
    store.addScoreHit('score', { code: 'server-host', asset_id: inner, target: '10.9.9.9', evidence: '登录主机 10.9.9.9' })
    store.addCredential('score', { host: '10.9.9.9', username: 'root9x', secret_value: 'Un9-Ver8-If7', note: '未验证：只在配置文件里看到' })
    store.addCredential('score', { host: '10.9.9.9', username: 'root8y', secret_value: 'Ok8-Ver7-If6', note: '已登录验证' })
    const md = scoreReport(store, 'score').markdown
    const seg = md.slice(md.indexOf('### 1.2 凭据'), md.indexOf('### 1.3 工具接入'))
    /* 列出来就是给验收人照着复现的，"未验证"的写进去只会让人白试一次。 */
    assert.ok(seg.includes('root8y'), '验证过的要列')
    assert.ok(!seg.includes('root9x'), '未验证的不能列')
  })
})

test('scoreReport：阶段小节标题必须带条数与分值，否则看不出这一阶段值多少分', () => {
  withStore(({ store, db }) => {
    const ext = addAsset(db, '203.0.113.5', null, '203.0.113.0/24')
    store.addScoreHit('score', { code: 'boundary-logical', asset_id: ext, target: '10.99.0.0/16', evidence: '进入逻辑隔离内网' })
    const md = scoreReport(store, 'score').markdown
    const line = md.match(/^## ③ .*$/m)
    assert.ok(line !== null, '缺 ③ 阶段小节')
    assert.equal(line[0], '## ③ 边界突破（1 条 · +1000 分）')
  })
})

test('scoreReport：markdown 章节顺序固定，供给验收人从上往下读', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    store.addScoreHit('score', { code: 'terminal-access', asset_id: asset, target: '10.2.2.9', evidence: '终端权限 1 台' })
    const md = scoreReport(store, 'score').markdown
    const order = [
      '## 0. 摘要与对账', '### 0.1 得分点使用情况', '### 0.2 记录与计分对账', '### 0.3 复现索引',
      '## 1. 复现前置条件', '### 1.1 通道', '### 1.2 凭据', '### 1.3 工具接入', '### 1.4 工具能力边界',
      '## 2. 攻击链（按依赖顺序）', '## 3. 条目明细', '## 4. 得分点说明',
    ]
    let at = -1
    for (const h of order) {
      const i = md.indexOf(h)
      assert.ok(i !== -1, '缺章节：' + h)
      assert.ok(i > at, '章节顺序错了：' + h)
      at = i
    }
    assert.match(md, /^### 3\.1 /m, '条目标题带链路序号')
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   三、scoreChain：攻击链页用的那条链
   ══════════════════════════════════════════════════════════════════════════ */

test('scoreChain：命中自带分值优先于得分点默认值，别名不能被同名列遮蔽', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    // terminal-access 默认 10 分；这条显式写了 30（管理员档）
    store.addScoreHit('score', { code: 'terminal-access', asset_id: asset, target: '10.2.2.9', evidence: '终端管理员', points: 30 })
    const chain = scoreChain(store, 'score')
    assert.equal(chain.items.length, 1)
    assert.equal(chain.items[0].point_default, 10)
    assert.equal(chain.items[0].points, 30, 'SQL 里 h.points 与 p.points 同名，取错就会掉回默认值')
    assert.equal(chain.summary.points, 30)
  })
})

test('scoreChain：动作三档归因（显式 / 同得分点同资产 / 同资产时间早于本条）', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    const s1 = store.addChainStep('score', { stage_code: 'internal', title: '第一步', asset_id: asset })
    const s2 = store.addChainStep('score', { stage_code: 'internal', title: '第二步', asset_id: asset })
    // ① 显式 step_id
    const a = store.addScoreHit('score', { code: 'terminal-access', asset_id: asset, step_id: s2.id, evidence: '显式' })
    // ② 无 step_id，但同资产同得分点有一步（s1 挂到该得分点）
    const pt = db.prepare("SELECT id FROM score_point WHERE code = 'netdev'").get()
    const s3 = store.addChainStep('score', { stage_code: 'internal', title: '交换机', asset_id: asset, point_id: pt.id })
    const b = store.addScoreHit('score', { code: 'netdev', asset_id: asset, evidence: '同点同资产' })
    // ③ 都没有：退到同资产里时间更早的最后一步
    const c = store.addScoreHit('score', { code: 'file-storage', asset_id: asset, evidence: '兜底' })
    const chain = scoreChain(store, 'score')
    const byId = new Map(chain.items.map((x) => [x.id, x]))
    assert.equal(byId.get(a.id).action.id, s2.id)
    assert.equal(byId.get(a.id).action_inferred, false)
    assert.equal(byId.get(b.id).action.id, s3.id, '同得分点同资产的步骤优先于"同资产任意步骤"')
    assert.equal(byId.get(b.id).action_inferred, false)
    assert.equal(byId.get(c.id).action.id, s3.id, '兜底取同资产里最早的那条（s1）')
    assert.equal(byId.get(c.id).action_inferred, true, '兜底来的必须标推断')
    assert.equal(s1.id < s3.id, true)
  })
})

test('scoreChain：stages 是五个阶段的定长表，空阶段也返回，ordinal 就是链路位置', () => {
  withStore(({ store, db }) => {
    const inner = addAsset(db, '10.2.2.9')
    store.addScoreHit('score', { code: 'boundary-logical', asset_id: inner, target: '10.20.30.0/24', evidence: '进入逻辑隔离内网' })
    store.addScoreHit('score', { code: 'terminal-access', asset_id: inner, target: '10.2.2.9', evidence: '终端权限 1 台' })
    const chain = scoreChain(store, 'score')
    /* 与 scoreReport 的 stages 不同：这里**不**过滤空阶段（攻击链页要画完整五段），
       靠 items.length === 0 区分有没有东西。 */
    assert.deepEqual(chain.stages.map((s) => s.code), ['recon', 'internet', 'boundary', 'internal', 'target'])
    assert.deepEqual(chain.stages.map((s) => s.ordinal), [1, 2, 3, 4, 5])
    assert.deepEqual(chain.stages.map((s) => s.hits), [0, 0, 1, 1, 0])
    assert.deepEqual(chain.stages.map((s) => s.cumulative), [0, 0, 1000, 1010, 1010])
    assert.deepEqual(chain.stages.map((s) => s.items.length), [0, 0, 1, 1, 0])
  })
})

test('scoreChain：通道分真伪两栏统计，自己 VPS 上的不算突破证据', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    store.addTunnel('score', { asset_id: asset, entry_kind: 'target-http', listen: '127.0.0.1:1080', reach: '10.20.30.0/24' })
    store.addTunnel('score', { asset_id: asset, entry_kind: 'self-only', listen: '0.0.0.0:8443', reach: '' })
    store.addScoreHit('score', { code: 'boundary-logical', asset_id: asset, target: '10.20.30.0/24', evidence: '进入逻辑隔离内网' })
    const chain = scoreChain(store, 'score')
    assert.equal(chain.summary.tunnelsLegit, 1)
    assert.equal(chain.summary.tunnelsSelfOnly, 1)
    /* 两个通道只挂在 boundary 阶段的**数组**上（别的阶段是空数组），不是数字 */
    const boundary = chain.stages.find((s) => s.code === 'boundary')
    assert.equal(boundary.tunnels.length, 1)
    assert.equal(boundary.tunnels[0].entry_kind, 'target-http')
    assert.equal(boundary.tunnels[0].legit, true)
    assert.equal(boundary.tunnels_self_only.length, 1)
    assert.equal(boundary.tunnels_self_only[0].legit, false)
    for (const st of chain.stages) {
      if (st.code === 'boundary') continue
      assert.deepEqual([st.tunnels.length, st.tunnels_self_only.length], [0, 0])
    }
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   四、representativeShots：按得分点挑代表图
   ══════════════════════════════════════════════════════════════════════════ */

test('representativeShots：没有截图时回空 Map，不是 null', () => {
  withStore(({ store }) => {
    const out = representativeShots(store, 'score', [{ point_id: 1, hit_ids: [1] }], 3)
    assert.equal(out instanceof Map, true)
    assert.equal(out.size, 0)
  })
})

test('representativeShots：limit 控制张数，同层按时间先后', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    const r = store.addScoreHit('score', { code: 'terminal-access', asset_id: asset, target: '10.2.2.9', evidence: '终端权限 1 台' })
    const point = db.prepare("SELECT id FROM score_point WHERE code = 'terminal-access'").get()
    for (const [label, at] of [['A', '2026-01-01T00:00:02Z'], ['B', '2026-01-01T00:00:01Z'], ['C', '2026-01-01T00:00:03Z']]) {
      store.addShot('score', { point_id: point.id, hit_id: r.id, data_base64: PNG_1X1, captured_at: at, label })
    }
    const groups = [{ point_id: point.id, hit_ids: [r.id] }]
    assert.deepEqual(representativeShots(store, 'score', groups, 2).get(point.id).map((s) => s.label), ['B', 'A'])
    assert.deepEqual(representativeShots(store, 'score', groups, 3).get(point.id).map((s) => s.label), ['B', 'A', 'C'])
    assert.equal(representativeShots(store, 'score', groups).get(point.id).length, 3, '默认 3 张')
  })
})

test('representativeShots：候选池虽然按关联强度分层，最终排序只看 kind / 时间 / id', () => {
  withStore(({ store, db }) => {
    const asset = addAsset(db, '10.2.2.9')
    const r1 = store.addScoreHit('score', { code: 'terminal-access', asset_id: asset, target: '10.2.2.9', evidence: '第一台' })
    const r2 = store.addScoreHit('score', { code: 'terminal-access', asset_id: asset, target: '10.2.2.10', evidence: '第二台' })
    const point = db.prepare("SELECT id FROM score_point WHERE code = 'terminal-access'").get()
    store.addShot('score', { point_id: point.id, hit_id: r2.id, data_base64: PNG_1X1, captured_at: '2026-01-01T00:00:01Z', label: 'R2' })
    store.addShot('score', { point_id: point.id, hit_id: r1.id, data_base64: PNG_1X1, captured_at: '2026-01-01T00:00:05Z', label: 'R1' })
    const picked = representativeShots(store, 'score', [{ point_id: point.id, hit_ids: [r1.id] }], 3).get(point.id)
    /* 现状锁定（源码 :1510-1522 的注释说"按关联强度分层"，但 pool 是一个平数组，
       随后 sort 只比 rank/captured_at/id —— 分层只影响去重与截断，**不影响先后**）。
       所以哪怕 R1 挂在本条命中上，时间更晚的 R2 仍排在前面。
       真要"先自家图再借来的图"，得给 rank 加上层级维度（那会改动报告观感，先记着）。 */
    assert.deepEqual(picked.map((s) => s.label), ['R2', 'R1'])
    /* 但两层的图都在候选池里：借来的图不是被排除，只是排在后面 */
    assert.equal(picked.length, 2)
  })
})
