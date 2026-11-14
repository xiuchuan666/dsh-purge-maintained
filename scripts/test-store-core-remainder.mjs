// store-core 最后四处未覆盖的分支：配置落盘的分发口、截图计数的两级回填、
// 目标分组里的资产回查、以及「复现请求」段落。
//
// 为什么这四处值得单独一份文件：它们都属于「算错了不报错，只是界面/报告少一点东西」。
//   - platformConfigSave 少写一次配置 → 面板显示的还是旧平台，用户以为保存成功；
//   - 截图计数漏回填 → 得分点旁边不显示那张代表图，用户以为没截到；
//   - assetIpOf 对 null 不设防 → 一条没有资产关联的凭据会把整份报告炸掉；
//   - 「复现请求」段（直接粘进 Burp / Yakit 的那段）不生成 → 报告看起来完整，实际不能复现。
//
// 本文件只补 `test-store-core-facets.mjs` / `test-report-fidelity.mjs` 没碰到的行，
// 不重复它们已有的断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore, dispatch } from '../lib/redteam/store-core.js'

/** 开一个用完即弃的真 store；`fn` 里抛错也要把目录收干净。 */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purge-remainder-'))
  const store = new RedteamStore(dir)
  try {
    return fn(store, dir)
  } finally {
    try { store.close() } catch { /* 关过就算了 */ }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch { /* Windows 句柄未释放 */ }
  }
}

/** 建一个靶标 + 一台资产。 */
function seed(store, name = 'remainder') {
  const { id } = store.openEngagement(name, ['10.6.0.0/24'])
  const db = store.db(id)
  db.prepare('INSERT INTO asset(ip, segment_cidr, state, primary_name) VALUES(?,?,?,?)')
    .run('10.6.0.7', '10.6.0.0/24', 'live', 'gw-07')
  const assetId = db.prepare('SELECT id FROM asset ORDER BY id DESC LIMIT 1').get().id
  return { id, db, assetId }
}

/** 取一个内置得分点（默认取 `web-app`，它一定在 25 项里）。 */
function point(store, id, code = 'web-app') {
  const items = store.listScorePoints(id).items
  const hit = items.find((p) => p.code === code) || items[0]
  assert.ok(hit, '内置得分点表不该是空的')
  return hit
}

test('platformConfigSave 真的把配置写到临时靶标库的 redteam 目录里', () => {
  withStore((store, dir) => {
    const saved = dispatch(store, { op: 'platformConfigSave', config: { platform: 'linux' } })
    assert.equal(saved.ok, true, '分发口必须回 ok:true')
    // 返回的是 platformSummary 平铺对象，不是 { platform: summary }
    assert.equal(saved.runtime.effective, 'linux', '钉住平台就应立刻生效')
    assert.equal(saved.runtime.windows, false)
    assert.deepEqual(saved.config.platform, 'linux')
    // 写盘之后再读一次，证明不是只改了内存
    const reread = dispatch(store, { op: 'platformConfigGet' })
    assert.equal(reread.runtime.effective, 'linux', '重读必须还是 linux（说明配置落了盘）')
    assert.ok(reread.tools && Array.isArray(reread.tools.items), 'platformSummary 的 tools 是 { items, ... } 不是裸数组')
  })
})

test('platformConfigSave 不带 config 时按空对象处理，不抛', () => {
  withStore((store) => {
    const saved = dispatch(store, { op: 'platformConfigSave' })
    assert.equal(saved.ok, true, '缺 config 不该炸（req.config || {}）')
    assert.ok(saved.runtime && typeof saved.runtime.effective === 'string')
  })
})

test('截图按得分点与按命中两级回填：点的 shot_total 是条数之和，命中的 shot_count 是它自己的', () => {
  withStore((store) => {
    const { id, assetId } = seed(store)
    const p = point(store, id)
    const hit = store.addScoreHit(id, {
      code: p.code, asset_ip: '10.6.0.7', target: 'http://10.6.0.7/a', summary: 's', evidence: '证据一',
    })
    assert.equal(hit.counted, true, '前提：这条命中要计分，否则不会出现在得分点下面')
    const s1 = store.addShot(id, { data_base64: 'iVBORw0KGgo=', point_id: hit.point_id, hit_id: hit.id, asset_id: assetId, label: 'L' })
    const s2 = store.addShot(id, { data_base64: 'iVBORw0KGgo=', point_id: hit.point_id })
    assert.equal(s1.ok, true)
    assert.equal(s2.ok, true)

    const items = store.listScorePoints(id).items
    const one = items.find((x) => x.id === hit.point_id)
    assert.equal(one.shot_total, 2, '点级计数要把两条都算上（按 point_id 分组）')
    assert.ok(one.shot_shown <= one.shots.length)
    const row = (one.hits || []).find((h) => h.id === hit.id)
    assert.equal(row.shot_count, 1, '命中级只数挂在它自己身上的那张')
  })
})

test('没有截图的得分点 shot_total 是 0 而不是 undefined', () => {
  withStore((store) => {
    const { id } = seed(store)
    const items = store.listScorePoints(id).items
    for (const it of items) assert.equal(it.shot_total, 0, `${it.code} 的 shot_total 应是 0`)
  })
})

test('shotBrief 的四个默认值：kind 落 screenshot、mime 落 image/png、空串字段与 bytes 归零', () => {
  withStore((store) => {
    const { id, assetId } = seed(store)
    const p = point(store, id)
    const hit = store.addScoreHit(id, {
      code: p.code, asset_ip: '10.6.0.7', target: 'http://10.6.0.7/a', summary: 's', evidence: '证据一',
    })
    // 先正常写一张，再把可空列一律置 NULL —— 老库里就是这种行，
    // 逼出 shotBrief 里那六个 || 兜底（kind / mime / label / note / target / source_ref）
    const made = store.addShot(id, { data_base64: 'iVBORw0KGgo=', point_id: hit.point_id, hit_id: hit.id, asset_id: assetId })
    assert.equal(made.ok, true)
    const nulled = store.db(id).prepare(
      'UPDATE shot SET kind = NULL, mime = NULL, label = NULL, note = NULL, target = NULL, source_ref = NULL WHERE id = ?',
    ).run(made.id).changes
    assert.equal(nulled, 1, '前提：列要允许 NULL，才能构造出「老库那行」')
    const one = store.listScorePoints(id).items.find((x) => x.id === hit.point_id)
    const shot = one.shots[0]
    assert.ok(shot, '得有一张代表图才谈得上兜底')
    assert.equal(shot.kind, 'screenshot', '没写 kind 时默认是现场截图')
    assert.equal(shot.mime, 'image/png', '没写 mime 时默认 png')
    assert.equal(shot.label, '')
    assert.equal(shot.note, '')
    assert.equal(shot.target, '')
    assert.equal(shot.source_ref, '')
    assert.ok(shot.bytes > 0, 'bytes 取实际写入字节')
    assert.match(shot.url, /^shots\//, 'url 是相对路径，不带盘符')
  })
})

test('按目标分组时，凭据/权限/清单都靠 asset_id 回查到 IP 上；asset_id 为空的走 host 归一', () => {
  withStore((store) => {
    const { id, assetId } = seed(store)
    store.addAccess(id, { asset_id: assetId, host: '10.6.0.7', username: 'root', method: 'ssh' })
    store.addCredential(id, { asset_id: assetId, host: '10.6.0.7', username: 'admin', secret: 'p' })
    // 没有资产关联的那种：`assetIpOf(undefined)` 回 undefined，必须回退到 slugTarget(host)，
    // 不能让整份报告炸掉（`credential.host` 本身是必填，所以这里给一个 URL 形态的 host）
    store.addCredential(id, { host: 'http://loose.example:8080/x', username: 'loose' })
    const rt = store.reportTargets(id)
    const keys = rt.targets.map((t) => t.key)
    assert.ok(keys.includes('10.6.0.7'), `资产 IP 应成为分组键，实际 ${JSON.stringify(keys)}`)
    assert.equal(keys.length, 2, `另一条走 host 归一，实际 ${JSON.stringify(keys)}`)
    const loose = rt.targets.find((t) => t.key !== '10.6.0.7')
    // 键必须是 slugTarget(host) 的结果（`http://loose.example:8080/x` → `loose.example`），
    // 而不是 undefined —— 后者会让整份报告多出一个没有名字的分组
    assert.equal(loose.key, 'loose.example', `没有资产关联时按 host 归一，实际 ${JSON.stringify(loose.key)}`)
    assert.equal(loose.stats.credentials, 1)
    assert.equal(loose.stats.accesses, 0)
    assert.equal(loose.kind, 'host', '非 IP 形态的键标 host（不是 ip）')
    const ip = rt.targets.find((t) => t.key === '10.6.0.7')
    assert.equal(ip.stats.accesses, 1)
    assert.equal(ip.stats.credentials, 1)
    assert.equal(ip.segment, '10.6.0.0/24', 'segment 由资产回填')
    assert.match(ip.markdown, /### Credentials/)
    assert.match(ip.markdown, /### Obtained privileges/)
  })
})

test('复现请求段：请求去掉 CR、响应截 2000 字、label 缺省时用 method + url', () => {
  withStore((store) => {
    const { id } = seed(store)
    const v = store.addVuln(id, {
      asset_ip: '10.6.0.7', target: 'http://10.6.0.7/a', title: '未授权', severity: 'high', status: 'confirmed', evidence: 'E',
    })
    const longResp = 'HTTP/1.1 200 OK\r\n\r\n' + 'x'.repeat(4000)
    store.addHttpEvidence(id, {
      vuln_id: v.id, method: 'GET', url: 'http://10.6.0.7/a',
      request: 'GET /a HTTP/1.1\r\nHost: 10.6.0.7\r\n\r\n', response: longResp,
    })
    const rt = store.reportTargets(id)
    const md = rt.targets.find((t) => t.key === '10.6.0.7').markdown
    assert.match(md, /\*\*复现请求（可直接粘进 Burp Suite \/ Yakit）\*\*：/, '这段是报告能不能复现的关键')
    assert.match(md, /\*GET http:\/\/10\.6\.0\.7\/a\*/, '没写 label 时用 method + url')
    assert.ok(!md.includes('\r'), '报告正文里不许留 CR（粘进 Burp 会多出空行）')
    assert.ok(md.includes('响应摘要：'), '有响应体才写这一段')
    // 截断：`slice(0, 2000)` 作用在「去 CR 之后的整段响应」上，所以 x 的个数 = 2000 - 状态行长度。
    // 状态行 `HTTP/1.1 200 OK` 去 CR 后是 `HTTP/1.1 200 OK\n\n` = 17 字符 → 2000 - 17 = 1983。
    const xs = md.match(/x{100,}/)
    assert.ok(xs, '应能看到响应正文')
    assert.equal(xs[0].length, 1983, `响应应截到 2000 字（含状态行），实际 x 有 ${xs[0].length} 个`)
  })
})

test('复现请求段：有 label 时用 label；没有响应体就不写「响应摘要」', () => {
  withStore((store) => {
    const { id } = seed(store)
    const v = store.addVuln(id, {
      asset_ip: '10.6.0.7', target: 'http://10.6.0.7/b', title: 'T2', severity: 'high', status: 'confirmed', evidence: 'E',
    })
    store.addHttpEvidence(id, { vuln_id: v.id, method: 'POST', url: 'http://10.6.0.7/b', request: 'POST /b HTTP/1.1', label: 'behinder 连一句话' })
    const md = store.reportTargets(id).targets.find((t) => t.key === '10.6.0.7').markdown
    assert.match(md, /\*behinder 连一句话\*/)
    assert.ok(!md.includes('响应摘要：'), '没响应体就不该有这一段')
  })
})

test('没有 http 证据的漏洞不生成复现请求段', () => {
  withStore((store) => {
    const { id } = seed(store)
    store.addVuln(id, { asset_ip: '10.6.0.7', target: 'http://10.6.0.7/c', title: 'T3', severity: 'high', status: 'confirmed', evidence: 'E' })
    const md = store.reportTargets(id).targets.find((t) => t.key === '10.6.0.7').markdown
    assert.ok(!md.includes('复现请求'), '没证据就别硬凑一段空壳')
    assert.match(md, /### Result vulnerabilities/)
  })
})

test('源码形状：四个出口都不能被顺手简化掉', async () => {
  const { readFileSync } = await import('node:fs')
  const raw = readFileSync(new URL('../lib/redteam/store-core.js', import.meta.url), 'utf8')
  const src = raw.split(/\r?\n/).join('\n')
  assert.match(src, /if \(op === 'platformConfigSave'\) \{\n\s+savePlatformConfig\(req\.config \|\| \{\}, store\.root\)\n\s+return platformSummary\(store\.root\)/, '分发口要先落盘再回读，不是只回内存里的那份')
  assert.match(src, /it\.shot_total = shotCountByPoint\.get\(Number\(it\.id\)\) \|\| 0/, '点级计数缺省必须是 0')
  assert.match(src, /h\.shot_count = shotCountByHit\.get\(Number\(h\.id\)\) \|\| 0/, '命中级计数缺省必须是 0')
  assert.match(src, /if \(assetId === null \|\| assetId === undefined\) return undefined/, 'assetIpOf 必须对 null / undefined 早退')
  assert.match(src, /\.slice\(0, 2000\)/, '响应正文必须截断，否则报告能有几十兆')
})
