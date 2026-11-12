// 知识库（POC 复用）的落库语义：`lib/redteam/store-core.js` 里 savePoc / searchPocs /
// getPoc / updatePoc / deletePoc / pocStats 这一组。
//
// 为什么值得单独一个文件：知识库是「跨靶标共享的武器库」，模型打 Nday 前第一步就查它。
// 它坏掉的方式全都**不报错**：code 净化松一格 → 正文被写到数据根目录之外（曾真发生）；
// 合并语义反过来 → 补一条验证结论把正文冲掉；排序丢掉 verified → 未验证的排到已验证前面，
// 模型照着用就打在目标上失败。这些都不会抛异常，只会安静地给出错的东西。
//
// 每个用例一份临时 root：知识库是 `<root>/knowledge.db` + `<root>/pocs/`，共用会串状态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { RedteamStore } from '../lib/redteam/store-core.js'

/** 开一个用完即弃的 store（同步：这些方法都是同步的）。 */
function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-purge-kbstore-'))
  const store = new RedteamStore(root)
  try {
    return fn(store, root)
  } finally {
    try { store.close() } catch { /* 已经关了 */ }
    rmSync(root, { recursive: true, force: true })
  }
}

const WEBLOGIC = {
  title: 'Weblogic T3 反序列化 CVE-2023-21839',
  cve: 'CVE-2023-21839',
  content: 'print(1)',
  language: 'python',
  category: 'deserialization',
}

const throws = (fn, re) => {
  assert.throws(fn, (e) => {
    assert.match(String(e.message), re)
    return true
  })
}

/* ============================================================ code 与落盘位置 */

test('code 由标题里的组件名 + 漏洞名 + CVE 编号算出，CJK 保留', () => withStore((store) => {
  const r = store.savePoc(WEBLOGIC)
  assert.equal(r.poc.code, 'weblogic-t3-反序列化-cve-2023-21839')
  assert.equal(r.created, true)
  // 落盘位置必须是 <root>/pocs/<code>/<默认文件名>
  assert.equal(r.path, join(store.pocsDirOf(), r.poc.code, 'poc.py'))
  assert.equal(readFileSync(r.path, 'utf8'), 'print(1)')
}))

test('code 里的路径分隔符会被净化，正文不会跑出 pocs/ 之外', () => withStore((store) => {
  // 历史事故：code='../../escaped-poc' 曾把正文写到数据根目录之外。
  const r = store.savePoc({ title: 'Escape', code: '../../escaped-poc', content: 'x' })
  assert.equal(r.poc.code, 'escaped-poc')
  assert.equal(r.path, join(store.pocsDirOf(), 'escaped-poc', 'poc.txt'))
  assert.equal(existsSync(join(store.root, 'escaped-poc')), false)
}))

test('净化后为空、或标题为空时明确报错，不落半条记录', () => withStore((store) => {
  throws(() => store.savePoc({ title: 'Dots', code: '...', content: 'x' }), /poc\.code invalid/)
  throws(() => store.savePoc({ title: '', content: 'x' }), /poc\.title required/)
  assert.equal(store.pocStats().total, 0)
}))

test('filename 里的分隔符换成连字符；不给就按语言/类型给默认名', () => withStore((store) => {
  assert.equal(store.savePoc({ title: 'F', code: 'f', content: 'x', filename: 'a/b\\c.py' }).path.endsWith('a-b-c.py'), true)
  const names = [
    ['python', {}, 'poc.py'],
    ['bash', {}, 'poc.sh'],
    ['nuclei', {}, 'poc.yaml'],
    [null, { kind: 'template' }, 'poc.yaml'],
    [null, {}, 'poc.txt'],
  ]
  for (const [i, [language, extra, want]] of names.entries()) {
    const r = store.savePoc({ title: 'N' + i, code: 'n' + i, content: 'x', language: language || undefined, ...extra })
    assert.equal(r.path.split(/[\\/]/).pop(), want, `language=${language} kind=${extra.kind}`)
  }
}))

/* ============================================================ 正文来源 */

test('既没有 content 也没有 path 时只登记元数据，path 为 null', () => withStore((store) => {
  const r = store.savePoc({ title: 'MetaOnly', code: 'meta-only' })
  assert.equal(r.created, true)
  assert.equal(r.path, null)
  assert.equal(store.getPoc('meta-only').content, '')
}))

test('path 指向的文件不存在时报错原文带上那个路径', () => withStore((store) => {
  throws(() => store.savePoc({ title: 'P', code: 'p', path: 'nope/missing.txt' }),
    /poc content or existing path required: nope\/missing\.txt/)
}))

test('path 落在允许根之外时拒绝，允许根之外的正文读不进来', () => withStore((store) => {
  // 允许的根是 [root, tmpdir]。用「当前盘/文件系统根 + 一个不存在的文件名」造越界路径：
  // 不能写死 'C:/Windows/win.ini' —— 在 Linux 上它不是绝对路径，会被拼到 root 底下，
  // 于是报的是「文件不存在」而不是「越界」，CI 上就红这一条。
  const outsideAbs = join(parse(process.cwd()).root, 'dsh-purge-outside-probe.txt')
  throws(() => store.savePoc({ title: 'Abs', code: 'abs', path: outsideAbs }),
    /path outside allowed roots/)
  // 另一条越界形状：tmpdir 的上一级（同样是绝对路径，且不在允许根里）
  const aboveTmp = join(tmpdir(), '..', 'dsh-purge-up.txt')
  throws(() => store.savePoc({ title: 'Abs2', code: 'abs2', path: aboveTmp }),
    /path outside allowed roots/)
}))

test('path 在允许根内（tmpdir）时正文被拷进 pocs/<code>/', () => withStore((store, root) => {
  const outside = join(tmpdir(), 'dsh-purge-kbstore-src.txt')
  writeFileSync(outside, 'FROM-OUTSIDE', 'utf8')
  try {
    const r = store.savePoc({ title: 'TmpSrc', code: 'tmp-src', path: outside })
    assert.equal(r.path, join(store.pocsDirOf(), 'tmp-src', 'poc.txt'))
    assert.equal(readFileSync(r.path, 'utf8'), 'FROM-OUTSIDE')
    // 源文件留在原地（不是搬走）
    assert.equal(readFileSync(outside, 'utf8'), 'FROM-OUTSIDE')
  } finally {
    rmSync(outside, { force: true })
  }
  assert.equal(typeof root, 'string')
}))

test('getPoc 读盘前也过一遍路径守卫：库里的 path 被改成外部文件时读不到正文', () => withStore((store) => {
  const r = store.savePoc({ title: 'G', code: 'g', content: 'body' })
  const outside = join(tmpdir(), 'dsh-purge-kbstore-outside.txt')
  writeFileSync(outside, 'LEAK', 'utf8')
  try {
    // 模拟库里被塞了一个越界 path（bundle 导入、手工改库都可能）
    store.kb().prepare("UPDATE poc SET content = '', path = ? WHERE code = 'g'").run(outside)
    const row = store.getPoc('g')
    assert.equal(row.content, '')
    assert.equal(row.path, outside)
  } finally {
    rmSync(outside, { force: true })
  }
  assert.equal(existsSync(r.path), true)
}))

/* ============================================================ 合并语义 */

test('同一 code 再存一次是合并：正文换新、验证结论与标签留着、创建时间不动', () => withStore((store) => {
  const first = store.savePoc({ ...WEBLOGIC, verified: true, verified_note: 'note-1', tags: 'a,b' })
  /* 把创建时间改成 2000 年再合并：只断言「两次的 created_at 相等」抓不到覆盖，
     因为同一秒内 now 可能一样；改成一个明显的旧值才测得出来。 */
  store.kb().prepare("UPDATE poc SET created_at = '2000-01-01T00:00:00.000Z' WHERE code = ?").run(first.poc.code)
  const second = store.savePoc({ title: 'Weblogic T3 反序列化 v2', code: first.poc.code, content: 'print(2)' })
  assert.equal(second.created, false)

  const row = store.getPoc(first.poc.code)
  assert.equal(row.title, 'Weblogic T3 反序列化 v2')
  assert.equal(row.content, 'print(2)')
  // 这三个是「只在验证时写一次」的信息，合并时不能被空值冲掉
  assert.equal(row.verified, 1)
  assert.equal(row.verified_note, 'note-1')
  assert.equal(row.tags, 'a,b')
  assert.equal(row.created_at, '2000-01-01T00:00:00.000Z')
  assert.equal(readFileSync(second.path, 'utf8'), 'print(2)')
}))

test('合并时不给 content 就不动正文（补元数据不会冲掉正文）', () => withStore((store) => {
  const first = store.savePoc({ title: 'Keep', code: 'keep', content: 'body' })
  const second = store.savePoc({ title: 'Keep2', code: 'keep', description: 'desc' })
  /* 要查库列本身，不能只查 getPoc()：getPoc 在 content 为空时会回落到读文件，
     于是「库里正文被空值冲掉」这件事被文件兜底掩盖，测试照样绿（实测踩过）。 */
  const column = store.kb().prepare("SELECT content FROM poc WHERE code = 'keep'").get().content
  assert.equal(column, 'body')
  assert.equal(readFileSync(first.path, 'utf8'), 'body')
  /* 现状锁定：这一轮没有正文要写，所以返回值里的 path 是 null，
     但库里那条记录的 path 还指着旧文件。调用方不能拿这个 null 当「文件没了」。 */
  assert.equal(second.path, null)
  assert.equal(store.getPoc('keep').path, first.path)
}))

/* ============================================================ 归一化 */

test('kind / source / category 只认内置值，其余归一而不是原样存', () => withStore((store) => {
  const r = store.savePoc({ title: 'K', code: 'k', content: 'x', kind: 'EXP', source: 'bogus', category: 'BOGUS' })
  assert.equal(r.poc.kind, 'exp')      // 大写也认
  assert.equal(r.poc.source, 'self')   // 不认识的来源归 self
  assert.equal(r.poc.category, 'other') // 不认识的归类归 other，避免面板出现拼写变体
  assert.equal(store.savePoc({ title: 'K2', code: 'k2', content: 'x', kind: 'payload' }).poc.kind, 'payload')
}))

/* ============================================================ 检索 */

test('检索按「已验证 → 复用次数 → 更新时间」排序', () => withStore((store) => {
  const a = store.savePoc({ title: 'Alpha', content: 'AAA' })
  const b = store.savePoc({ title: 'Beta', content: 'BBB', verified: true })
  const c = store.savePoc({ title: 'Gamma', content: 'CCC' })
  store.markPocUsed(c.poc.code, '10.0.0.9')
  store.markPocUsed(c.poc.code, '10.0.0.9')

  assert.deepEqual(store.searchPocs({}).map((x) => x.code), ['beta', 'gamma', 'alpha'])
  assert.deepEqual(store.searchPocs({ verified: true }).map((x) => x.code), ['beta'])
  assert.equal(store.searchPocs({ kind: 'exp' }).length, 0)
  assert.deepEqual(store.searchPocs({ kind: 'bogus' }), [])
  assert.equal(store.searchPocs({ limit: 1 })[0].code, 'beta')
  assert.equal(a.poc.code, 'alpha')
}))

test('排序的第三键是复用次数：更新时间拉平后，用过的排前面', () => withStore((store) => {
  /* 被复用的那条必须**先建**（id 更小）：若它后建，去掉 hit_count 这一键后
     `id DESC` 也会把它排前面，用例照样绿（第一版就是这么写错的）。 */
  store.savePoc({ title: 'Used', code: 'used', content: 'x' })
  store.savePoc({ title: 'Fresh', code: 'fresh', content: 'x' })
  store.kb().prepare("UPDATE poc SET updated_at = '2020-01-01T00:00:00.000Z'").run()
  store.kb().prepare("UPDATE poc SET hit_count = 5 WHERE code = 'used'").run()
  assert.deepEqual(store.searchPocs({}).map((x) => x.code), ['used', 'fresh'])
}))

test('检索的全文命中：整词之外的子串也能查到（FTS 命中不到时退化成 LIKE）', () => withStore((store) => {
  store.savePoc({ title: 'Gamma 中间子串 ZZZ', content: 'CCC' })
  assert.deepEqual(store.searchPocs({ q: '中间子串' }).map((x) => x.code), ['gamma-中间子串-zzz'])
  assert.deepEqual(store.searchPocs({ q: 'ZZZ' }).map((x) => x.code), ['gamma-中间子串-zzz'])
  // 正文里的串也算（打之前先按正文特征找现成的）
  store.savePoc({ title: 'BodyHit', content: 'uname -a; id; whoami' })
  assert.deepEqual(store.searchPocs({ q: 'whoami' }).map((x) => x.code), ['bodyhit'])
  /* 关键一条：FTS5 按词切，`Tomcat` 命中不了 `ApacheTomcatServlet` 这个整词，
     只能靠 LIKE 兜底。没有这条，把 LIKE 兜底删掉其余用例照样绿（实测踩过）。 */
  store.savePoc({ title: 'WordToken', content: 'server: ApacheTomcatServlet/9.0' })
  assert.deepEqual(store.searchPocs({ q: 'Tomcat' }).map((x) => x.code), ['wordtoken'])
}))

test('检索的归类筛选支持逗号多值；空串等于不筛', () => withStore((store) => {
  store.savePoc({ title: 'R1', content: 'x', category: 'rce' })
  store.savePoc({ title: 'T1', content: 'x', category: 'tunnel' })
  store.savePoc({ title: 'S1', content: 'x', category: 'ssrf' })
  assert.deepEqual(store.searchPocs({ category: 'rce,tunnel' }).map((x) => x.code).sort(), ['r1', 't1'])
  assert.deepEqual(store.searchPocs({ category: 'rce' }).map((x) => x.code), ['r1'])
  assert.equal(store.searchPocs({ category: '' }).length, 3)
  assert.equal(store.searchPocs({ category: 'rce , tunnel' }).length, 2) // 逗号两侧空格要吃掉
}))

test('检索的 limit 夹在 1000 以内，负数等于不限', () => withStore((store) => {
  for (let i = 0; i < 3; i += 1) store.savePoc({ title: 'L' + i, code: 'l' + i, content: 'x' })
  assert.equal(store.searchPocs({ limit: '2' }).length, 2)
  assert.equal(store.searchPocs({}).length, 3)
  /* 夹取上限要灌到 1000 条以上才测得出来：只有三条时 `Math.min(5000, 1000)` 与
     `Number(5000)` 都给 3，删掉夹取照样绿（实测踩过）。直接往库里灌，不走 savePoc
     —— 那会写 1005 个文件。 */
  const db = store.kb()
  const ins = db.prepare("INSERT INTO poc(code, title, kind, category, content, verified, hit_count, created_at, updated_at) VALUES(?,?,?,?,?,0,0,?,?)")
  const now = new Date().toISOString()
  db.exec('BEGIN')
  for (let i = 0; i < 1005; i += 1) ins.run('bulk-' + i, 'Bulk ' + i, 'poc', 'other', 'x', now, now)
  db.exec('COMMIT')
  assert.equal(store.searchPocs({ limit: 5000 }).length, 1000)
  assert.equal(store.searchPocs({ limit: 1000 }).length, 1000)
  // 不给 limit 时默认 200（不是全给）
  assert.equal(store.searchPocs({}).length, 200)
  /* 现状锁定：`Math.min(Number(f.limit) || 200, 1000)` 对 -1 得 -1，
     SQLite 的 `LIMIT -1` 是不限，所以负数等于「全给」而不是「空」。 */
  assert.equal(store.searchPocs({ limit: -1 }).length, 1008)
}))

test('检索结果只带正文长度，不把正文整段拖出来', () => withStore((store) => {
  store.savePoc({ title: 'Big', content: 'x'.repeat(500) })
  const row = store.searchPocs({})[0]
  assert.equal(row.content, undefined)
  assert.equal(row.content_bytes, 500)
  assert.equal(row.has_content, 1)
  // getPoc 才给正文
  assert.equal(store.getPoc('big').content.length, 500)
}))

/* ============================================================ 单条读写 */

test('getPoc 认数字 id 也认 code，空 key 返回 undefined', () => withStore((store) => {
  const r = store.savePoc({ title: 'One', code: 'one', content: 'x' })
  assert.equal(store.getPoc(r.poc.id).code, 'one')
  assert.equal(store.getPoc('one').code, 'one')
  assert.equal(store.getPoc(String(r.poc.id)).code, 'one')
  assert.equal(store.getPoc(''), undefined)
  assert.equal(store.getPoc(undefined), undefined)
  assert.equal(store.getPoc('nope'), undefined)
}))

test('updatePoc 改正文才重写文件，改元数据不碰文件', () => withStore((store) => {
  const r = store.savePoc({ title: 'U', code: 'u', content: 'v1' })
  const mtime = () => readFileSync(r.path, 'utf8')

  store.updatePoc('u', { verified_note: '在 10.0.0.9 回显' })
  assert.equal(mtime(), 'v1')

  const after = store.updatePoc('u', { content: 'v2' })
  assert.equal(after.content, 'v2')
  assert.equal(mtime(), 'v2')
  // 文件名沿用原来的（poc.txt 不会因为改正文变成 poc.py）
  assert.equal(after.path, r.path)
}))

test('updatePoc 只改元数据时不重建正文文件（文件被删也不会被凭空写回）', () => withStore((store) => {
  const r = store.savePoc({ title: 'Gone', code: 'gone', content: 'v1' })
  rmSync(r.path, { force: true })
  /* 这一条比「读回来还是 v1」有区分力：正文只留在文件里时，
     `if (next.content !== row.content)` 被改成恒真会把文件重新写出来，而读回正文
     那条断言看不出差别（getPoc 从库里拿得到 v1）。 */
  const after = store.updatePoc('gone', { description: 'only meta' })
  assert.equal(existsSync(r.path), false)
  assert.equal(after.path, r.path)
  // 真的改了正文才会落盘
  store.updatePoc('gone', { content: 'v2' })
  assert.equal(existsSync(r.path), true)
  assert.equal(readFileSync(r.path, 'utf8'), 'v2')
}))

test('updatePoc 的 verified 走三态：不给就保持，false 真的写 0', () => withStore((store) => {
  const r = store.savePoc({ title: 'V', code: 'v', content: 'x', verified: true })
  assert.equal(store.updatePoc('v', { title: 'V2' }).verified, 1)
  assert.equal(store.updatePoc('v', { verified: false }).verified, 0)
  assert.equal(store.updatePoc('v', { verified: true }).verified, 1)
  assert.equal(store.getPoc(r.poc.code).verified, 1)
}))

test('updatePoc 找不到条目时抛错（不是静默返回 undefined）', () => withStore((store) => {
  throws(() => store.updatePoc('nope', { verified: true }), /poc not found: nope/)
}))

test('markPocUsed 累加复用次数并记最后一次用在哪儿', () => withStore((store) => {
  store.savePoc({ title: 'Use', code: 'use', content: 'x' })
  assert.deepEqual(store.markPocUsed('use', '10.0.0.9'), { ok: true, id: 1, code: 'use', hit_count: 1 })
  assert.equal(store.markPocUsed('use', '10.0.0.10').hit_count, 2)
  const row = store.getPoc('use')
  assert.equal(row.hit_count, 2)
  assert.equal(row.used_on, '10.0.0.10')
  assert.deepEqual(store.markPocUsed('nope', 'x'), { ok: false, error: 'poc not found: nope' })
}))

/* ============================================================ 删除 */

test('deletePoc 连落盘目录一起删，并报出删了几个文件', () => withStore((store) => {
  const r = store.savePoc({ title: 'Del', code: 'del', content: 'x' })
  const dir = join(store.pocsDirOf(), 'del')
  assert.equal(existsSync(r.path), true)
  assert.deepEqual(store.deletePoc('del'), { ok: true, id: 1, code: 'del', deleted: true, removed_files: 1 })
  assert.equal(existsSync(dir), false)
  assert.equal(store.getPoc('del'), undefined)
  // 再删一次是「找不到」而不是崩
  assert.deepEqual(store.deletePoc('del'), { ok: false, error: 'poc not found: del' })
}))

test('deletePoc 只删自己那一条，别人的目录不动', () => withStore((store) => {
  store.savePoc({ title: 'A', code: 'a', content: 'x' })
  store.savePoc({ title: 'B', code: 'b', content: 'x' })
  store.deletePoc('a')
  assert.deepEqual(readdirSync(store.pocsDirOf()).sort(), ['b'])
}))

/* ============================================================ 概览 */

test('pocStats 的归类表固定 14 条、顺序按内置表走，计数为 0 也列出来', () => withStore((store) => {
  store.savePoc({ title: 'S', code: 's', content: 'x', category: 'deserialization' })
  const stats = store.pocStats()
  const codes = stats.byCategory.map((c) => c.code)
  assert.equal(codes.length, 14)
  assert.equal(codes[0], 'rce')
  assert.equal(codes[13], 'other')
  assert.equal(stats.byCategory.find((c) => c.code === 'deserialization').n, 1)
  assert.equal(stats.byCategory.find((c) => c.code === 'rce').n, 0)
}))

test('pocStats 把内置表之外的归类追加在尾部，不让它凭空消失', () => withStore((store) => {
  const r = store.savePoc({ title: 'C', code: 'c', content: 'x' })
  // savePoc 会把未知归类归到 other，所以自定义归类只可能来自手工改库或导入
  store.kb().prepare("UPDATE poc SET category = 'my-own' WHERE code = 'c'").run()
  const tail = store.pocStats().byCategory.at(-1)
  assert.equal(tail.code, 'my-own')
  assert.equal(tail.name, 'my-own')
  assert.equal(tail.hint, '')
  assert.equal(tail.n, 1)
  assert.equal(r.poc.category, 'other')
}))

test('pocStats 的计数口径：total / verified / withContent / reused / uncategorized', () => withStore((store) => {
  store.savePoc({ title: 'A', code: 'a', content: 'x', verified: true, category: 'rce' })
  store.savePoc({ title: 'B', code: 'b' })              // 无正文、无归类
  store.savePoc({ title: 'C', code: 'c', content: 'y', category: 'sqli' })
  store.markPocUsed('a', '10.0.0.9')
  store.markPocUsed('a', '10.0.0.9')

  const s = store.pocStats()
  assert.equal(s.total, 3)
  assert.equal(s.verified, 1)
  /* withContent 只看库里的 content 列：正文只在文件里（库里被清空）的不算。
     这不是 bug —— 面板要的是「模型能不能直接读到正文」，读文件那条路是 getPoc 的兜底。 */
  assert.equal(s.withContent, 2)
  assert.equal(s.reused, 2)
  assert.equal(s.uncategorized, 1)
  assert.equal(s.dbPath, join(store.root, 'knowledge.db'))
  assert.equal(typeof s.earliest, 'string')
  assert.equal(typeof s.latest, 'string')
}))
