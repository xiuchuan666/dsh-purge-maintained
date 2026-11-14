// 演练台报告的「完整性」判据：一条得分说不说得清"怎么做到的"。
//
// 为什么值得单独一个文件：`hitTrace` 的 `gaps` 决定报告里那句
// 「复现完整 / 不完整」。这两条判据（账号类要挂凭据、突破类要挂隧道）在 v0.11.1
// 规则表重构成 25 项之后**用旧 code 当判据**，于是永远不出 —— 不报错、不告警，
// 只是报告从此自称完整。所以除了覆盖分支，本文件还用真规则表对拍导出的 code 清单，
// 让"规则表改名"这件事先在这里红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore } from '../lib/redteam/store-core.js'
import {
  hitTrace, scoreReport, GAP_CREDENTIAL_POINT_CODES, GAP_TUNNEL_POINT_PREFIXES,
} from '../lib/redteam/score-report.js'

const SRC = readFileSync(new URL('../lib/redteam/score-report.js', import.meta.url), 'utf8')

/** 开一个临时靶标库跑 fn；清理吞异常（Windows 上刚 close 的 SQLite 目录偶尔 EPERM）。 */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purge-fidelity-'))
  const store = new RedteamStore(dir)
  try {
    const eng = store.openEngagement('fidelity', [])
    return fn({ store, eng, db: store.db(eng.id), id: eng.id })
  } finally {
    try { store.close() } catch { /* 已关闭 */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows EPERM */ }
  }
}

function addAsset(db, ip, name = null, cidr = '10.0.0.0/24') {
  db.prepare('INSERT INTO asset(ip, segment_cidr, state, primary_name) VALUES(?,?,?,?)')
    .run(ip, cidr, 'live', name)
  return Number(db.prepare('SELECT id FROM asset ORDER BY id DESC LIMIT 1').get().id)
}

/** 记一条命中，再把「报告链路真正拿到的那个行」取回来（score_report.js:213 的 `p.code`）。 */
function addHit(store, db, id, code, assetId, target = '10.0.0.5') {
  const r = store.addScoreHit(id, { code, asset_id: assetId, target, evidence: 'probe' })
  return db.prepare('SELECT h.*, p.code FROM score_hit h JOIN score_point p ON p.id = h.point_id WHERE h.id = ?').get(r.id)
}

const CRED_GAP = '账号类得分没有登记凭据（`redteam_credential_add`）：说不清账号/口令从哪来'
const TUN_GAP = '突破类得分没有登记隧道（`redteam_tunnel_add`）：说不清通道怎么建的'

test('hitTrace：账号类得分没挂凭据时，必须明说"说不清账号从哪来"', () => {
  withStore(({ store, db, id }) => {
    const aid = addAsset(db, '10.0.0.5', 'web-01')
    const tr = hitTrace(store, db, addHit(store, db, id, 'db-credential', aid), id)
    assert.ok(tr.gaps.includes(CRED_GAP), JSON.stringify(tr.gaps))
    assert.equal(tr.complete, false)
  })
})

test('hitTrace：登记了凭据之后这条缺口消失（判据挂在真表上，不是永远为真）', () => {
  withStore(({ store, db, id }) => {
    const aid = addAsset(db, '10.0.0.5', 'web-01')
    store.addCredential(id, {
      asset_id: aid, host: '10.0.0.5', username: 'admin', secret_value: 'p',
      secret_type: 'password', source: 'leak',
    })
    const tr = hitTrace(store, db, addHit(store, db, id, 'db-credential', aid), id)
    assert.equal(tr.credentials.length, 1)
    assert.ok(!tr.gaps.includes(CRED_GAP), JSON.stringify(tr.gaps))
  })
})

test('hitTrace：Web 应用权限同样算账号类，没挂凭据要报缺口', () => {
  withStore(({ store, db, id }) => {
    const aid = addAsset(db, '10.0.0.5', 'web-01')
    const tr = hitTrace(store, db, addHit(store, db, id, 'web-app', aid), id)
    assert.ok(tr.gaps.includes(CRED_GAP), JSON.stringify(tr.gaps))
  })
})

test('hitTrace：突破类得分没登记隧道时，必须明说"说不清通道怎么建的"', () => {
  withStore(({ store, db, id }) => {
    const aid = addAsset(db, '10.0.0.5', 'web-01')
    const tr = hitTrace(store, db, addHit(store, db, id, 'boundary-logical', aid), id)
    assert.ok(tr.gaps.includes(TUN_GAP), JSON.stringify(tr.gaps))
  })
})

test('hitTrace：登记了隧道之后突破类缺口消失（四条 boundary-* 都走这条判据）', () => {
  withStore(({ store, db, id }) => {
    const aid = addAsset(db, '10.0.0.5', 'web-01')
    store.addTunnel(id, {
      asset_id: aid, kind: 'socks5', listen: '127.0.0.1:1080', entry_kind: 'target-outbound',
    })
    for (const code of ['boundary-physical', 'boundary-strong']) {
      const tr = hitTrace(store, db, addHit(store, db, id, code, aid), id)
      assert.equal(tr.tunnels.length, 1, code)
      assert.ok(!tr.gaps.includes(TUN_GAP), `${code} ${JSON.stringify(tr.gaps)}`)
    }
  })
})

test('hitTrace：既不是账号类也不是突破类的得分，不会被这两条缺口误伤', () => {
  withStore(({ store, db, id }) => {
    const aid = addAsset(db, '10.0.0.5', 'web-01')
    const tr = hitTrace(store, db, addHit(store, db, id, 'terminal-access', aid), id)
    assert.ok(!tr.gaps.includes(CRED_GAP), JSON.stringify(tr.gaps))
    assert.ok(!tr.gaps.includes(TUN_GAP), JSON.stringify(tr.gaps))
    // 只剩"没有步骤"和"没有 vuln_id"这两条 —— 说明别的判据没被带歪
    assert.equal(tr.gaps.length, 2, JSON.stringify(tr.gaps))
  })
})

test('完整性判据里写的每一个 code 都真的在当前规则表里', () => {
  withStore(({ store, id }) => {
    const codes = store.listScorePoints(id).items.map((p) => p.code)
    for (const code of GAP_CREDENTIAL_POINT_CODES) {
      assert.ok(codes.includes(code), `账号类判据用了不存在的 code: ${code}`)
    }
    for (const prefix of GAP_TUNNEL_POINT_PREFIXES) {
      const hit = codes.filter((c) => c.startsWith(prefix))
      assert.ok(hit.length > 0, `突破类前缀没匹配到任何得分点: ${prefix}（现有 ${codes.join('/')}）`)
    }
  })
})

test('报告链路里不许再出现作废的旧 code（它们是"永远不出的判据"）', () => {
  for (const dead of ["'web-account-user'", "'web-account-admin'", "'db-access'", "'internal-pivot'"]) {
    assert.ok(!SRC.includes(dead), `score-report.js 里还留着作废 code: ${dead}`)
  }
  // `'boundary'` 作为**阶段** code 是合法的（`st.code === 'boundary'`），
  // 只有拿它跟得分点 code 比才是错的 —— 所以钉的是"没有裸的 includes(['boundary'"。
  assert.ok(!/includes\(\s*\[\s*'boundary'\s*\]/.test(SRC), "还拿阶段名 'boundary' 当得分点 code 用")
})

test('报告正文：WebShell / 凭据 / 通道三行都真的落到条目下（不是只出现在小节标题里）', () => {
  withStore(({ store, db, id }) => {
    const aid = addAsset(db, '10.0.0.5', 'web-01')
    store.addWebshell(id, {
      asset_id: aid, url: 'http://10.0.0.5/s.jsp', shell_type: 'behinder', pass_key: 'k1',
    })
    store.addCredential(id, {
      asset_id: aid, host: '10.0.0.5', username: 'admin', secret_value: 'p',
      secret_type: 'password', source: 'leak',
    })
    store.addTunnel(id, {
      asset_id: aid, kind: 'socks5', listen: '127.0.0.1:1080', entry_kind: 'target-outbound',
    })
    addHit(store, db, id, 'terminal-access', aid)
    const md = scoreReport(store, id, {}).markdown
    assert.match(md, /\*\*WebShell\*\*：`http:\/\/10\.0\.0\.5\/s\.jsp` behinder · 密钥 `k1`/, 'WebShell 行')
    assert.match(md, /\*\*凭据\*\*：`10\.0\.0\.5` admin/, '凭据行')
    assert.match(md, /\*\*通道\*\*：`socks5` 监听 `127\.0\.0\.1:1080`/, '通道行')
  })
})
