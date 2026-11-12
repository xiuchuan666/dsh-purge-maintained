import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MIXED_ALLOWED,
  auditEol,
  classifyText,
  dirOf,
  directoryMajority,
  isEolConvertedOnly,
  isTextPath,
} from './check-eol-lib.mjs'

// ---------- 一、行尾分类 ----------

test('classifyText：纯 CRLF、纯 LF、空文件', () => {
  assert.deepEqual(classifyText('a\r\nb\r\n'), { lf: 2, crlf: 2, kind: 'crlf', lfOnly: 0 })
  assert.deepEqual(classifyText('a\nb\n'), { lf: 2, crlf: 0, kind: 'lf', lfOnly: 2 })
  assert.deepEqual(classifyText(''), { lf: 0, crlf: 0, kind: 'none', lfOnly: 0 })
})

test('classifyText：没有换行的单行文件算 none，不算 LF', () => {
  // 单行文件（比如一个短配置）没有 `\n`，硬判成 LF 会让「新文件必须符合同目录多数派」
  // 这条规则在只有一个文件的目录里误报。
  assert.equal(classifyText('just one line').kind, 'none')
  assert.equal(classifyText('just one line\r\n').kind, 'crlf')
})

test('classifyText：混行尾能被数出来，且 lfOnly 是 LF 行数', () => {
  const mixed = classifyText('a\r\nb\nc\r\n')
  assert.equal(mixed.kind, 'mixed')
  assert.equal(mixed.lf, 3)
  assert.equal(mixed.crlf, 2)
  assert.equal(mixed.lfOnly, 1)
})

test('classifyText：null / undefined / 数字都不抛', () => {
  for (const value of [null, undefined, 0, 42, false]) {
    assert.equal(classifyText(value).kind, 'none')
  }
})

test('classifyText：连续空行与末尾无换行都按实际数', () => {
  assert.equal(classifyText('a\r\n\r\n\r\n').kind, 'crlf')
  assert.equal(classifyText('a\r\nb').crlf, 1)
  assert.equal(classifyText('a\r\nb').kind, 'crlf')
})

// ---------- 二、路径过滤与目录 ----------

test('isTextPath：认常见的文本后缀，不认二进制', () => {
  for (const path of ['a.js', 'a.mjs', 'a.json', 'a.md', 'a.yml', 'a.sh', 'a.ps1', 'a.html', 'a.svg', 'a.wscript']) {
    assert.equal(isTextPath(path), true, path)
  }
  for (const path of ['a.png', 'a.exe', 'a.asar', 'a.zip', 'a', 'Makefile', 'a.bin']) {
    assert.equal(isTextPath(path), false, path)
  }
})

test('isTextPath：后缀大小写不敏感', () => {
  assert.equal(isTextPath('A.MD'), true)
  assert.equal(isTextPath('A.Js'), true)
})

test('dirOf：根目录文件返回空串，反斜杠也认', () => {
  assert.equal(dirOf('README.md'), '')
  assert.equal(dirOf('lib/index.js'), 'lib')
  assert.equal(dirOf('lib\\redteam\\store-core.js'), 'lib/redteam')
  assert.equal(dirOf(''), '')
  assert.equal(dirOf(null), '')
})

// ---------- 三、目录多数派 ----------

test('directoryMajority：取多数派，平票不算数', () => {
  const files = {
    'a/x.js': 'crlf',
    'a/y.js': 'crlf',
    'a/z.js': 'lf',
    'b/p.js': 'lf',
    'b/q.js': 'crlf',
  }
  const majority = directoryMajority(files, 3)
  assert.equal(majority.get('a'), 'crlf')
  // b 只有 2 个样本，低于 minSamples=3，不给结论
  assert.equal(majority.has('b'), false)
})

test('directoryMajority：混合与 none 不参与投票', () => {
  const files = {
    'a/x.js': 'mixed',
    'a/y.js': 'none',
    'a/z.js': 'crlf',
    'a/w.js': 'crlf',
    'a/v.js': 'crlf',
  }
  // 有效票 3 张全 CRLF，mixed 与 none 不拉低比例
  assert.equal(directoryMajority(files, 3).get('a'), 'crlf')
})

test('directoryMajority：样本够但平票时不给结论（避免随机定规则）', () => {
  const files = {
    'a/1.js': 'crlf',
    'a/2.js': 'crlf',
    'a/3.js': 'crlf',
    'a/4.js': 'lf',
    'a/5.js': 'lf',
    'a/6.js': 'lf',
  }
  assert.equal(directoryMajority(files, 3).has('a'), false)
})

test('directoryMajority：样本不够 minSamples 时即使一边倒也不给结论', () => {
  // 2 个文件全是 LF，但门槛是 3 —— 不给结论。
  // 这条专门防「门槛被去掉」：平票那条用例在门槛失效时依然不结论，
  // 只有「一边倒但样本不足」才能区分。
  assert.equal(directoryMajority({ 'a/x.js': 'lf', 'a/y.js': 'lf' }, 3).has('a'), false)
  // 门槛调低到 2 就该给结论，证明不是永远不结论
  assert.equal(directoryMajority({ 'a/x.js': 'lf', 'a/y.js': 'lf' }, 2).get('a'), 'lf')
})

test('directoryMajority：mixed 不占样本数（否则会偷偷把门槛凑够）', () => {
  // 2 个 CRLF + 1 个 mixed：真实有效样本只有 2 个，低于门槛 → 不给结论。
  // 如果 mixed 也被算进 total，样本数会变成 3、结论变成 crlf。
  const files = { 'a/x.js': 'crlf', 'a/y.js': 'crlf', 'a/z.js': 'mixed' }
  assert.equal(directoryMajority(files, 3).has('a'), false)
  // 补一个真的 LF 之后有效样本到 3 个，才给结论
  assert.equal(directoryMajority({ ...files, 'a/w.js': 'lf' }, 3).get('a'), 'crlf')
})

test('directoryMajority：空输入与非法输入返回空 Map', () => {
  assert.equal(directoryMajority({}).size, 0)
  assert.equal(directoryMajority(null).size, 0)
  assert.equal(directoryMajority(undefined).size, 0)
})

// ---------- 四、审计：混行尾 ----------

test('auditEol：文件内部混行尾报错', () => {
  const report = auditEol({ entries: [{ path: 'lib/a.js', text: 'a\r\nb\n' }], baseline: { 'lib/a.js': 'crlf' } })
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0].code, 'mixed')
  assert.match(report.errors[0].detail, /1 行 CRLF \/ 1 行 LF/)
})

test('auditEol：两个上游锚点允许混行尾，如实记成 mixed 但不报错', () => {
  // 基线记的是「现状」，所以允许清单里的文件也要如实写 mixed；
  // 只是不产生 error。这样 --update 之后能看出它们本来就是混的，
  // 而不是被悄悄抹成某一种。
  for (const path of MIXED_ALLOWED) {
    const report = auditEol({ entries: [{ path, text: 'a\r\nb\n' }], baseline: {} })
    assert.equal(report.errors.length, 0, path)
    assert.equal(report.files[path], 'mixed', path)
  }
})

test('auditEol：允许清单里的路径必须正好是上游那两个文件', () => {
  // 这条是防「为了过检查把新文件塞进白名单」：清单只能有两个成员。
  assert.equal(MIXED_ALLOWED.size, 2)
  assert.ok(MIXED_ALLOWED.has('client.js'))
  assert.ok(MIXED_ALLOWED.has('docs/origin/client-1.1.94.js'))
})

// ---------- 五、审计：已入库文件行尾不许变 ----------

test('auditEol：已入库文件行尾变了报错', () => {
  const report = auditEol({ entries: [{ path: 'lib/a.js', text: 'a\nb\n' }], baseline: { 'lib/a.js': 'crlf' } })
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0].code, 'eol-changed')
  assert.match(report.errors[0].detail, /CRLF 变成了 LF/)
  assert.deepEqual(report.changed, ['lib/a.js'])
})

test('auditEol：行尾没变不报错', () => {
  const report = auditEol({ entries: [{ path: 'lib/a.js', text: 'a\r\nb\r\n' }], baseline: { 'lib/a.js': 'crlf' } })
  assert.equal(report.errors.length, 0)
  assert.equal(report.files['lib/a.js'], 'crlf')
})

test('auditEol：基线里有、工作区里没有的文件不算错，只列进 removed', () => {
  const report = auditEol({ entries: [], baseline: { 'lib/gone.js': 'crlf' } })
  assert.equal(report.errors.length, 0)
  assert.deepEqual(report.removed, ['lib/gone.js'])
})

// ---------- 六、审计：新文件要符合同目录多数派 ----------

test('auditEol：新文件行尾与同目录多数派不一致时报错', () => {
  const baseline = { 'lib/a.js': 'crlf', 'lib/b.js': 'crlf', 'lib/c.js': 'crlf' }
  const report = auditEol({ entries: [{ path: 'lib/new.js', text: 'x\n' }], baseline })
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0].code, 'new-file-wrong-eol')
  assert.match(report.errors[0].detail, /LF，但同目录多数派是 CRLF/)
  assert.deepEqual(report.added, ['lib/new.js'])
})

test('auditEol：新文件与多数派一致时静默通过，只记进 added', () => {
  const baseline = { 'lib/a.js': 'crlf', 'lib/b.js': 'crlf', 'lib/c.js': 'crlf' }
  const report = auditEol({ entries: [{ path: 'lib/new.js', text: 'x\r\n' }], baseline })
  assert.equal(report.errors.length, 0)
  assert.deepEqual(report.added, ['lib/new.js'])
})

test('auditEol：目录样本太少时只提示不拦', () => {
  const report = auditEol({ entries: [{ path: 'lib/newdir/x.js', text: 'a\n' }], baseline: {} })
  assert.equal(report.errors.length, 0)
  assert.equal(report.warnings.length, 1)
  assert.equal(report.warnings[0].code, 'new-file-unknown-dir')
})

test('auditEol：--update 之前的新文件即使目录有明确多数派也不会被当成「已入库」', () => {
  // baseline 里没有它 → 走 added 分支，不做 eol-changed 判断。这条防止
  // 「新文件第一次 --update 之后被误判成行尾变更」。
  const baseline = { 'lib/a.js': 'crlf', 'lib/b.js': 'crlf', 'lib/c.js': 'crlf' }
  const report = auditEol({ entries: [{ path: 'lib/new.js', text: 'a\r\n' }], baseline })
  assert.deepEqual(report.changed, [])
  assert.equal(report.errors.length, 0)
})

// ---------- 七、autocrlf 指纹 ----------

test('isEolConvertedOnly：只差行尾时返回 true', () => {
  assert.equal(isEolConvertedOnly('a\r\nb\r\n', 'a\nb\n'), true)
  assert.equal(isEolConvertedOnly('a\nb\n', 'a\r\nb\r\n'), true)
})

test('isEolConvertedOnly：内容相同或内容真的不同都返回 false', () => {
  assert.equal(isEolConvertedOnly('a\r\nb\r\n', 'a\r\nb\r\n'), false)
  assert.equal(isEolConvertedOnly('a\r\nb\r\n', 'a\r\nc\r\n'), false)
  // 只差一个字符但行尾一样，也是内容变更，不该报成行尾问题
  assert.equal(isEolConvertedOnly('a\n', 'a\n\n'), false)
})

test('isEolConvertedOnly：null 与空串不抛', () => {
  assert.equal(isEolConvertedOnly(null, null), false)
  assert.equal(isEolConvertedOnly('', ''), false)
  assert.equal(isEolConvertedOnly('a\r\n', ''), false)
})

// ---------- 八、真实仓库的形状 ----------

test('源码形状：多数派统计里那道「只收 crlf/lf」的守卫还在', async () => {
  // 这条守卫行为上等价于没有：mixed/none 被计数时只是把 `tally[dir][kind]` 变成
  // NaN，而 total 只累加 crlf 与 lf，所以结论不变 —— RED 演练里注入「删掉它」
  // 永远是绿的。但它挡住的是 NaN 污染：一旦以后有人把 total 改成
  // `Object.values(count).reduce(...)`，NaN 会立刻把结论吞掉。
  // 所以只能钉源码形状。
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./check-eol-lib.mjs', import.meta.url), 'utf8')
  assert.match(source, /if \(kind !== 'crlf' && kind !== 'lf'\) continue/)
  // total 必须只由 crlf 与 lf 相加，不能遍历整个 bucket
  assert.match(source, /const total = count\.crlf \+ count\.lf/)
  assert.doesNotMatch(source, /Object\.values\(count\)\.reduce/)
})

test('真实仓库：基线里的文件数与分类都自洽', async () => {
  const { readFileSync } = await import('node:fs')
  const baseline = JSON.parse(readFileSync(new URL('../docs/eol-baseline.json', import.meta.url), 'utf8'))
  // 只允许这三种值；出现别的东西说明基线被手改坏了。
  // mixed 只可能出现在允许清单里（client.js 与它的上游锚点）。
  for (const [path, kind] of Object.entries(baseline.files)) {
    assert.ok(['crlf', 'lf', 'mixed'].includes(kind), `${path} -> ${kind}`)
    if (kind === 'mixed') assert.ok(MIXED_ALLOWED.has(path), `${path} 是 mixed 但不在允许清单里`)
  }
  // lib/**/*.js 绝大多数是 CRLF —— 这是补丁锚点能对上的前提
  const libJs = Object.entries(baseline.files).filter(([path]) => path.startsWith('lib/') && path.endsWith('.js'))
  const libCrlf = libJs.filter(([, kind]) => kind === 'crlf').length
  assert.ok(libCrlf / libJs.length > 0.9, `lib 下的 js 应绝大多数是 CRLF，实际 ${libCrlf}/${libJs.length}`)
  // 我们自己写的回归测试（scripts/test-*.mjs）必须全是 LF。
  // 不去断言整个 scripts/ 目录：里面有 8 个上游带过来的 CRLF 脚本
  // （build-client / patch-client-dock / e2e-* / verify-target 等），
  // 它们逐字节是上游产物的一部分，改行尾等于改产物。
  const tests = Object.entries(baseline.files).filter(
    ([path]) => path.startsWith('scripts/test-') && path.endsWith('.mjs'),
  )
  const testsLf = tests.filter(([, kind]) => kind === 'lf').length
  assert.equal(testsLf, tests.length, `scripts/test-*.mjs 应全是 LF，实际 ${testsLf}/${tests.length}`)
})
