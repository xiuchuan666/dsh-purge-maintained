/**
 * SQLite + FTS5 不可用时的降级（`REDTEAM_NO_FTS5=1`）。
 *
 * 为什么值得单独一个文件：FTS5 是 SQLite 的**编译期**选项，不是运行时开关。
 * Node 22.14 的 `node:sqlite` 没有它（`no such module: fts5`），22.23 有；
 * 用户换一个 Node 版本，同一个插件的行为就变了 —— 而失败方式不是报错，是
 * 「整个靶标库打不开」或「明明有的资产搜不到」。这条路径平时没人走，
 * 所以必须能主动触发、并且有断言盯着。
 *
 * `HAS_FTS5` 是 `schema.js` 的模块级常量（import 时就定了），同一进程里改
 * `process.env` 再重新 import 也不会重新求值 —— ESM 的相对 specifier 会把
 * `schema.js` 缓存住。所以这里用**子进程**跑探针：`env` 在子进程启动时生效，
 * 一次拿到「带 FTS5」与「不带 FTS5」两份结果，再在父进程里对照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE_URL = new URL('../lib/redteam/store-core.js', import.meta.url).href
const SCHEMA_URL = new URL('../lib/redteam/schema.js', import.meta.url).href

const sandbox = mkdtempSync(join(tmpdir(), 'dshpurge-fts-'))
test.after(() => {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* Windows 偶发 EPERM */ }
})

/* 探针写进临时目录，而不是写成一行 `-e`：省掉模板字符串里的反引号与 `${}` 转义。 */
const PROBE = [
  "import { mkdtempSync, rmSync } from 'node:fs'",
  "import { tmpdir } from 'node:os'",
  "import { join } from 'node:path'",
  "const root = mkdtempSync(join(tmpdir(), 'dshp-fts-child-'))",
  "const { RedteamStore } = await import(process.env.DSH_STORE_URL)",
  "const { HAS_FTS5 } = await import(process.env.DSH_SCHEMA_URL)",
  "const store = new RedteamStore(root)",
  "const id = store.openEngagement('fts', ['10.0.0.0/24']).id",
  "store.importBundle(id, { assets: [{",
  "  ip: '10.0.0.7', primary_name: 'portal.example.test',",
  "  names: [{ name: 'portal.example.test', kind: 'domain' }],",
  "  ports: [{ port: 8080, proto: 'tcp', service: 'http', product: 'nginx', version: '1.24',",
  "    banner: 'Server: nginx/1.24', title: 'Portal Login',",
  "    fingerprints: [{ category: 'web', vendor: 'nginx', product: 'nginx', version: '1.24' }] }],",
  "}] })",
  "const db = store.db(id)",
  "const namesOf = (h) => h.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map((r) => r.name)",
  "const assetTables = namesOf(db)",
  "const kbTables = namesOf(store.kb())",
  "const hits = (q) => store.listAssets(id, { q }).items.length",
  "store.savePoc({ title: 'Nginx 越界读', cve: 'CVE-2021-23017', component: 'nginx', content: 'exploit here' })",
  "const pocs = (q) => store.searchPocs({ q }).length",
  "const out = {",
  "  hasFts5: HAS_FTS5,",
  "  assetTableCount: assetTables.length,",
  "  assetFtsTables: assetTables.filter((n) => /fts/.test(n)),",
  "  assetPlainTables: assetTables.filter((n) => !/fts/.test(n)),",
  "  kbTableCount: kbTables.length,",
  "  kbFtsTables: kbTables.filter((n) => /fts/.test(n)),",
  "  kbPlainTables: kbTables.filter((n) => !/fts/.test(n)),",
  "  assetFtsRows: HAS_FTS5 ? db.prepare('SELECT COUNT(*) AS n FROM asset_fts').get().n : null,",
  "  pocFtsRows: HAS_FTS5 ? store.kb().prepare('SELECT COUNT(*) AS n FROM poc_fts').get().n : null,",
  "  assetHits: {",
  "    ip: hits('10.0.0.7'), banner: hits('nginx'), bannerMid: hits('ginx'),",
  "    title: hits('Portal'), titleMid: hits('ortal'), primaryName: hits('portal.example.test'),",
  "    fingerprint: hits('nginx'), miss: hits('zzz'), empty: hits(''),",
  "  },",
  "  pocHits: { title: pocs('Nginx'), cve: pocs('CVE-2021-23017'), content: pocs('exploit'), miss: pocs('zzz') },",
  "}",
  "store.close()",
  "try { rmSync(root, { recursive: true, force: true }) } catch {}",
  "console.log(JSON.stringify(out))",
].join('\n')

const probePath = join(sandbox, 'probe.mjs')
writeFileSync(probePath, PROBE, 'utf8')

/** 在指定 env 下跑一次探针，返回它打印的 JSON。 */
function runProbe(extraEnv = {}) {
  const env = { ...process.env, DSH_STORE_URL: STORE_URL, DSH_SCHEMA_URL: SCHEMA_URL }
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  const raw = execFileSync(process.execPath, [probePath], { env, encoding: 'utf8', timeout: 120000 })
  return JSON.parse(raw.trim().split('\n').pop())
}

/* 两次探测各跑一次，后面的用例共享结果（子进程开销大，别每条都跑）。 */
const withFts = runProbe({ REDTEAM_NO_FTS5: undefined })
const withoutFts = runProbe({ REDTEAM_NO_FTS5: '1' })

test('环境开关：REDTEAM_NO_FTS5=1 关掉 FTS5，其它值不关', () => {
  assert.equal(withoutFts.hasFts5, false)
  /* 本机 Node 是否带 FTS5 由构建决定，两种都允许；只要求「默认值 = 真实能力」。 */
  const onlyOneTriggers = runProbe({ REDTEAM_NO_FTS5: '0' })
  assert.equal(onlyOneTriggers.hasFts5, withFts.hasFts5, 'REDTEAM_NO_FTS5=0 不该关掉 FTS5')
})

test('有 FTS5：靶标库多出 asset_fts，知识库多出 poc_fts', () => {
  if (!withFts.hasFts5) return // 本机 Node 构建不带 FTS5，这组跳过
  assert.equal(withFts.assetFtsTables.length, 6, 'asset_fts 及其影子表')
  assert.ok(withFts.assetFtsTables.includes('asset_fts'))
  assert.equal(withFts.kbFtsTables.length, 6, 'poc_fts 及其影子表')
  assert.ok(withFts.kbFtsTables.includes('poc_fts'))
  assert.equal(withFts.assetFtsRows, 1, '导入一个资产就有一条索引行')
  assert.equal(withFts.pocFtsRows, 1, '存一份 POC 就有一条索引行')
})

test('无 FTS5：两张虚拟表都不建，但普通表一张不少', () => {
  assert.deepEqual(withoutFts.assetFtsTables, [], '不该有 asset_fts')
  assert.deepEqual(withoutFts.kbFtsTables, [], '不该有 poc_fts')
  /* 关键：虚拟表建不起来不能把整份 DDL 带崩 —— 普通表必须与有 FTS5 时完全一致。 */
  assert.deepEqual(withoutFts.assetPlainTables, withFts.assetPlainTables)
  assert.deepEqual(withoutFts.kbPlainTables, withFts.kbPlainTables)
  assert.equal(withoutFts.assetTableCount, withoutFts.assetPlainTables.length)
})

test('无 FTS5：资产检索退化成 LIKE，但六种检索面都还能命中', () => {
  const h = withoutFts.assetHits
  assert.equal(h.ip, 1, '按 IP')
  assert.equal(h.banner, 1, '按 banner')
  assert.equal(h.title, 1, '按标题')
  assert.equal(h.primaryName, 1, '按主域名')
  assert.equal(h.fingerprint, 1, '按指纹')
  assert.equal(h.miss, 0, '搜不到就是 0，不是抛错')
  assert.equal(h.empty, 1, '空查询不过滤')
})

test('无 FTS5：POC 检索退化成 LIKE，标题/编号/正文都还能命中', () => {
  assert.equal(withoutFts.pocHits.title, 1)
  assert.equal(withoutFts.pocHits.cve, 1)
  assert.equal(withoutFts.pocHits.content, 1)
  assert.equal(withoutFts.pocHits.miss, 0)
})

test('现状锁定：banner 中间子串两种模式结果不同（LIKE 能搜到、FTS 前缀匹配搜不到）', () => {
  /* FTS5 的 MATCH 用 `"term"*` 做前缀匹配，`ginx` 不是 `nginx` 的前缀 → 0 条；
     LIKE 走 `%ginx%` → 1 条。同一个输入换台机器结果不同，用户能直接感知。
     不改的理由：统一成 LIKE 会让装了 FTS5 的机器丢掉分词与前缀能力（资产上万条时慢一个量级）。 */
  assert.equal(withFts.assetHits.bannerMid, withFts.hasFts5 ? 0 : 1)
  assert.equal(withoutFts.assetHits.bannerMid, 1)
  /* 反过来，前缀匹配两边都能命中，这是 LIKE 也不弱的地方。 */
  assert.equal(withFts.assetHits.banner, 1)
  assert.equal(withoutFts.assetHits.banner, 1)
})

test('降级不是「静默少功能」：两种模式下同一批查询的可命中集合一致', () => {
  /* 除了上面那条中间子串差异，其余检索面必须完全对齐 ——
     否则「换 Node 版本」会变成「换一个插件」。 */
  const keys = ['ip', 'banner', 'title', 'titleMid', 'primaryName', 'fingerprint', 'miss', 'empty']
  for (const k of keys) {
    assert.equal(withFts.assetHits[k], withoutFts.assetHits[k], '资产检索面 ' + k)
  }
  for (const k of ['title', 'cve', 'content', 'miss']) {
    assert.equal(withFts.pocHits[k], withoutFts.pocHits[k], 'POC 检索面 ' + k)
  }
})
