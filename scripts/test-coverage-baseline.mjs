// 覆盖率棘轮基线：纯函数层与「配置三处必须对齐」的守卫。
//
// 拆成独立 test()：这里对比的是 lcov 解析、文件筛选、基线构造、比对判定、
// 报告文案五件互相独立的事，外加一组「脚本/守卫/.gitignore 三处路径不能错配」
// 的一致性断言。原来是一条链，第一处红就再也看不到后面——
// 而路径错配恰恰是那种「守卫永远看不到新数据、永远静默通过」的故障，
// 它必须能和别的问题一起暴露出来，而不是排在队尾。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BASELINE_SCHEMA,
  parseLcov,
  selectCovered,
  buildBaseline,
  diffBaseline,
  renderReport,
  toleranceOf,
} from './coverage-baseline-lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const zero = { lh: 0, lf: 0, fnh: 0, fnf: 0, brh: 0, brf: 0 }
const row = (over = {}) => ({ ...zero, ...over })

// --------------------------------------------------------------- parseLcov

test('parseLcov：反斜杠路径归一成正斜杠', () => {
  const parsed = parseLcov([
    'TN:',
    'SF:lib\\core.js',
    'FN:1,foo',
    'FNH:1',
    'FNF:10',
    'BRH:2',
    'BRF:8',
    'LH:100',
    'LF:500',
    'end_of_record',
    '',
  ].join('\n'))
  assert.deepEqual(parsed['lib/core.js'], { lh: 100, lf: 500, fnh: 1, fnf: 10, brh: 2, brf: 8 })
  // 否则 Windows 上的实测路径永远对不上基线
  assert.equal(parsed['lib\\core.js'], undefined)
})

test('parseLcov：缺的指标补 0，不是 undefined', () => {
  const parsed = parseLcov(['SF:lib/index.js', 'LH:0', 'LF:2953', 'end_of_record'].join('\n'))
  assert.deepEqual(parsed['lib/index.js'], { lh: 0, lf: 2953, fnh: 0, fnf: 0, brh: 0, brf: 0 })
})

test('parseLcov：空输入与 null 都返回空对象', () => {
  assert.deepEqual(parseLcov(''), {})
  assert.deepEqual(parseLcov(null), {})
})

// ------------------------------------------------------------ selectCovered

test('selectCovered：只留 lib/，排除 scripts/ 与 docs/origin 历史快照', () => {
  const all = {
    'lib/core.js': row({ lh: 1, lf: 2 }),
    'lib/redteam/store-core.js': row({ lh: 3, lf: 4 }),
    'scripts/check-lib.mjs': row({ lh: 5, lf: 6 }),
    'docs/origin/core-split-baseline-8066985/lib/core.js': row({ lh: 7, lf: 8 }),
  }
  const picked = Object.keys(selectCovered(all))
  assert.deepEqual(picked, ['lib/core.js', 'lib/redteam/store-core.js'])
  // docs/origin 里的历史快照虽然名字以 lib/ 结尾，但已经不是我们要守的文件
  assert.ok(!picked.some((f) => f.startsWith('docs/')))
})

// ------------------------------------------------------------ buildBaseline

test('buildBaseline：schema/commit/时间戳正确，文件顺序稳定', () => {
  const b = buildBaseline({
    'lib/b.js': { lh: 2, lf: 4, fnh: 1, fnf: 2, brh: 0, brf: 2 },
    'lib/a.js': { lh: 1, lf: 3, fnh: 0, fnf: 1, brh: 1, brf: 1 },
  }, { commit: 'abc1234', now: new Date('2026-11-11T04:00:00Z') })
  assert.equal(b.schema, BASELINE_SCHEMA)
  assert.equal(b.commit, 'abc1234')
  assert.equal(b.capturedAt, '2026-11-11T04:00:00.000Z')
  assert.deepEqual(Object.keys(b.files), ['lib/a.js', 'lib/b.js'], '文件顺序要稳定，否则每次刷新都产生无意义 diff')
  assert.deepEqual(b.files['lib/a.js'], { lh: 1, lf: 3, fnh: 0, fnf: 1, brh: 1, brf: 1 })
})

// ------------------------------------------------------------ diffBaseline

const baseline = {
  schema: BASELINE_SCHEMA,
  files: {
    'lib/core.js': { lh: 100, lf: 500, fnh: 5, fnf: 10, brh: 20, brf: 40 },
    'lib/gone.js': { lh: 1, lf: 2, fnh: 0, fnf: 0, brh: 0, brf: 0 },
  },
}
const CORE = { lh: 100, lf: 500, fnh: 5, fnf: 10, brh: 20, brf: 40 }
const GONE = { lh: 1, lf: 2, fnh: 0, fnf: 0, brh: 0, brf: 0 }

test('diffBaseline：完全一致时 ok 且无任何行', () => {
  const same = diffBaseline(baseline, { 'lib/core.js': CORE, 'lib/gone.js': GONE })
  assert.equal(same.ok, true)
  assert.deepEqual(same.rows, [])
  assert.deepEqual(same.dropped, [])
  assert.deepEqual(same.missing, [])
  assert.deepEqual(same.added, [])
})

test('diffBaseline：覆盖率下跌 → 红', () => {
  const down = diffBaseline(baseline, { 'lib/core.js': { ...CORE, lh: 98 }, 'lib/gone.js': GONE })
  assert.equal(down.ok, false)
  assert.deepEqual(down.dropped, [{ file: 'lib/core.js', metric: 'lh', before: 100, after: 98 }])
})

test('diffBaseline：覆盖率上涨 → 绿，但要在报告里看得见', () => {
  const up = diffBaseline(baseline, { 'lib/core.js': { ...CORE, lh: 120 }, 'lib/gone.js': GONE })
  assert.equal(up.ok, true)
  assert.deepEqual(up.dropped, [])
  assert.deepEqual(up.rows, [{ file: 'lib/core.js', metric: 'lh', before: 100, after: 120 }])
})

// 下面三条守的是「总数不算倒退」这个判定。真实事故：把 lib/index.js 里 3 行
// 冗余判定抽成纯函数后 lf 2953→2950，lh 反而 +1，检查器却报 FAIL——删代码
// 让总数变小不是覆盖率问题，只有「原来跑到的现在跑不到」才是。
test('diffBaseline：行总数变小但命中数没掉 → 绿（删冗余代码不该红）', () => {
  const shrunk = diffBaseline(baseline, {
    'lib/core.js': { ...CORE, lf: 480, lh: 101 },
    'lib/gone.js': GONE,
  })
  assert.equal(shrunk.ok, true, '总数下降不等于覆盖倒退')
  assert.deepEqual(shrunk.dropped, [])
  assert.deepEqual(shrunk.rows, [
    { file: 'lib/core.js', metric: 'lh', before: 100, after: 101 },
    { file: 'lib/core.js', metric: 'lf', before: 500, after: 480 },
  ])
})

test('diffBaseline：函数总数、分支总数变小同样不红', () => {
  const shrunk = diffBaseline(baseline, {
    'lib/core.js': { ...CORE, fnf: 8, brf: 30 },
    'lib/gone.js': GONE,
  })
  assert.equal(shrunk.ok, true)
  assert.deepEqual(shrunk.dropped, [])
})

test('diffBaseline：函数命中数与分支命中数下跌仍然红', () => {
  const downFn = diffBaseline(baseline, { 'lib/core.js': { ...CORE, fnh: 4 }, 'lib/gone.js': GONE })
  assert.equal(downFn.ok, false)
  assert.deepEqual(downFn.dropped, [{ file: 'lib/core.js', metric: 'fnh', before: 5, after: 4 }])

  const downBr = diffBaseline(baseline, { 'lib/core.js': { ...CORE, brh: 19 }, 'lib/gone.js': GONE })
  assert.equal(downBr.ok, false)
  assert.deepEqual(downBr.dropped, [{ file: 'lib/core.js', metric: 'brh', before: 20, after: 19 }])
})

test('diffBaseline：基线里有、本次没记录 → 红（文件被删或被 exclude 误伤）', () => {
  const gone = diffBaseline(baseline, { 'lib/core.js': CORE })
  assert.equal(gone.ok, false)
  assert.deepEqual(gone.missing, ['lib/gone.js'])
})

test('diffBaseline：本次新增文件 → 只提示，不红', () => {
  const added = diffBaseline(baseline, {
    'lib/core.js': CORE,
    'lib/gone.js': GONE,
    'lib/new.js': { lh: 0, lf: 10, fnh: 0, fnf: 1, brh: 0, brf: 0 },
  })
  assert.equal(added.ok, true)
  assert.deepEqual(added.added, ['lib/new.js'])
})

// ------------------------------------------------- 环境容差（ENV_TOLERANCE）
// 背景：lib/desktop.js 的分支命中数取决于跑测试那台机器的文件系统现状
// （~/.dsh 在不在、%TEMP% 里有没有上次重启留下的 .ps1、npm 全局装没装 DSH）。
// 同一 commit 在干净 worktree 里也复现不出基线那几个分支，连跑 4 次稳定在
// brh 310~311。给它留容差，但容差内的下跌必须**在报告里看得见**。

const DESKTOP = { lh: 1386, lf: 2260, fnh: 72, fnf: 107, brh: 311, brf: 419 }
const desktopBaseline = {
  schema: BASELINE_SCHEMA,
  files: { 'lib/desktop.js': { ...DESKTOP, fnh: 73, brh: 312, brf: 420 } },
}

test('toleranceOf：只对登记过的文件与指标给容差', () => {
  assert.equal(toleranceOf('lib/desktop.js', 'fnh'), 2)
  assert.equal(toleranceOf('lib/desktop.js', 'brh'), 4)
  // 2026-11-15：基线提交 82abbcf 在干净 worktree 复跑 lh 只有 1837（基线 1842），HEAD 是 1835。
  // 这 7 行同属本机文件系统现状漂移，故连行命中一起登记；超出 7 仍然红。
  assert.equal(toleranceOf('lib/desktop.js', 'lh'), 7, '行命中也属环境漂移，容差 7')
  assert.equal(toleranceOf('lib/core.js', 'brh'), 0, '没登记的文件一律 0')
  assert.equal(toleranceOf('lib/desktop.js', 'nope'), 0, '不认识的指标 0')
})

test('diffBaseline：容差内的环境漂移不红，但要进 tolerated 留痕', () => {
  const d = diffBaseline(desktopBaseline, { 'lib/desktop.js': DESKTOP })
  assert.equal(d.ok, true, '容差内不该报 FAIL')
  assert.deepEqual(d.dropped, [])
  assert.deepEqual(d.tolerated, [
    { file: 'lib/desktop.js', metric: 'fnh', before: 73, after: 72, tolerance: 2 },
    { file: 'lib/desktop.js', metric: 'brh', before: 312, after: 311, tolerance: 4 },
  ])
})

test('diffBaseline：超出容差仍然红（容差不是免死金牌）', () => {
  const d = diffBaseline(desktopBaseline, { 'lib/desktop.js': { ...DESKTOP, brh: 307 } })
  assert.equal(d.ok, false, '掉了 5 个分支，超出容差 4')
  assert.deepEqual(d.dropped, [{ file: 'lib/desktop.js', metric: 'brh', before: 312, after: 307 }])
  assert.deepEqual(d.tolerated, [
    { file: 'lib/desktop.js', metric: 'fnh', before: 73, after: 72, tolerance: 2 },
  ])
})

test('diffBaseline：没登记容差的文件掉一格照样红', () => {
  const d = diffBaseline(baseline, { 'lib/core.js': { ...CORE, brh: 19 }, 'lib/gone.js': GONE })
  assert.equal(d.ok, false)
  assert.deepEqual(d.tolerated, [], 'lib/core.js 没有容差')
})

test('renderReport：容差行用 ~ 前缀并写明容差额度', () => {
  const text = renderReport({
    ok: true,
    rows: [{ file: 'lib/desktop.js', metric: 'brh', before: 312, after: 311 }],
    missing: [],
    added: [],
    dropped: [],
    tolerated: [{ file: 'lib/desktop.js', metric: 'brh', before: 312, after: 311, tolerance: 4 }],
  })
  assert.match(text, /\[coverage\] PASS/)
  assert.match(text, /~ lib\/desktop\.js 分支 312 → 311 \(-1，在环境容差 4 内\)/)
})

// ------------------------------------------------------------ renderReport

test('renderReport：一致时说「完全一致」', () => {
  const clean = renderReport({ ok: true, rows: [], missing: [], added: [], dropped: [] })
  assert.match(clean, /\[coverage\] PASS/)
  assert.match(clean, /完全一致/)
})

test('renderReport：下降/缺失/新增三种行都要出现', () => {
  const dirty = renderReport({
    ok: false,
    rows: [{ file: 'lib/core.js', metric: 'lh', before: 100, after: 98 }],
    missing: ['lib/gone.js'],
    added: ['lib/new.js'],
    dropped: [{ file: 'lib/core.js', metric: 'lh', before: 100, after: 98 }],
  })
  assert.match(dirty, /\[coverage\] FAIL/)
  assert.match(dirty, /↓ lib\/core\.js 行 100 → 98 \(-2\)/)
  assert.match(dirty, /lib\/gone\.js 在基线里但本次没有覆盖率记录/)
  assert.match(dirty, /lib\/new\.js 本次新增/)
})

test('renderReport：上涨用 ↑ 并带增量', () => {
  const risen = renderReport({
    ok: true,
    rows: [{ file: 'lib/core.js', metric: 'lh', before: 100, after: 105 }],
    missing: [],
    added: [],
    dropped: [],
  })
  assert.match(risen, /↑ lib\/core\.js 行 100 → 105 \(\+5\)/)
})

// ------------------------------------------- 与 package.json / .gitignore 的一致性
// 守卫脚本读死 .tmp-coverage/lcov.info，而 lcov 目标由 scripts/coverage-suite.mjs 决定。
// 两边路径一旦错配，「守卫永远看不到新数据」这种静默故障不会有人发现。

test('package.json 的三个脚本指向正确的入口', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts['test:full'], 'node scripts/coverage-suite.mjs')
  assert.match(String(manifest.scripts['test:baseline'] || ''), /check-coverage-baseline\.mjs --update/)
})

test('coverage-suite 的 include/exclude 与 reporter 配置', () => {
  const full = fs.readFileSync(path.join(ROOT, 'scripts', 'coverage-suite.mjs'), 'utf8')
  assert.match(full, /--test-coverage-include=\$\{INCLUDE\}/)
  assert.match(full, /const INCLUDE = 'lib\/\*\*'/, '只能统计 lib/，否则 scripts/ 的高覆盖会稀释真问题')
  assert.match(full, /const EXCLUDE = 'docs\/\*\*'/, 'docs/origin 是测试参照物，被覆盖是正常现象')
  assert.match(full, /--test-reporter=lcov/)
  assert.match(full, /mkdirSync\(COVERAGE_DIR/, 'lcov reporter 不会自建目录，干净 clone 上必须自己建')
  assert.match(full, /check-coverage-baseline\.mjs/)
})

test('无 .git 时返回 2（环境问题）而不是 1', () => {
  // 无 .git 时覆盖率必然偏低（update.js 的 git 探测走 catch），
  // 这是环境差异不是倒退，必须跳过而不是报假红。
  const full = fs.readFileSync(path.join(ROOT, 'scripts', 'coverage-suite.mjs'), 'utf8')
  assert.match(full, /rev-parse.*HEAD|rev-parse', \['HEAD'\]/, '要先探 git 是否可用')
  assert.match(full, /if \(!hasGit\) return 2/, '无 git 时返回 2（环境问题）而不是 1')
})

test('守卫读的 lcov 路径必须就是 test:full 写的路径', () => {
  const guardSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'check-coverage-baseline.mjs'), 'utf8')
  assert.match(guardSrc, /'\.tmp-coverage', 'lcov\.info'/, '守卫的 lcov 路径要与 test:full 一致')
})

test('.tmp-coverage 在 .gitignore 里', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  assert.match(ignore, /^\/\.tmp-coverage\/$/m, '.tmp-coverage 必须在 .gitignore 里')
})
