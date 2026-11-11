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
} from './coverage-baseline-lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- parseLcov ----------------------------------------------------------
{
  const lcov = [
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
    'SF:lib/index.js',
    'LH:0',
    'LF:2953',
    'end_of_record',
    '',
  ].join('\n')
  const parsed = parseLcov(lcov)
  assert.deepEqual(parsed['lib/core.js'], { lh: 100, lf: 500, fnh: 1, fnf: 10, brh: 2, brf: 8 })
  // 反斜杠要归一成正斜杠，否则 Windows 上的实测路径永远对不上基线
  assert.equal(parsed['lib\\core.js'], undefined)
  // 缺的指标补 0，不是 undefined
  assert.deepEqual(parsed['lib/index.js'], { lh: 0, lf: 2953, fnh: 0, fnf: 0, brh: 0, brf: 0 })
  assert.deepEqual(parseLcov(''), {})
  assert.deepEqual(parseLcov(null), {})
}

// ---- selectCovered ------------------------------------------------------
{
  const all = {
    'lib/core.js': { lh: 1, lf: 2, fnh: 0, fnf: 0, brh: 0, brf: 0 },
    'lib/redteam/store-core.js': { lh: 3, lf: 4, fnh: 0, fnf: 0, brh: 0, brf: 0 },
    'scripts/check-lib.mjs': { lh: 5, lf: 6, fnh: 0, fnf: 0, brh: 0, brf: 0 },
    'docs/origin/core-split-baseline-8066985/lib/core.js': { lh: 7, lf: 8, fnh: 0, fnf: 0, brh: 0, brf: 0 },
  }
  const picked = Object.keys(selectCovered(all))
  assert.deepEqual(picked, ['lib/core.js', 'lib/redteam/store-core.js'])
  // docs/origin 里的历史快照虽然名字以 lib/ 结尾，但已经不是我们要守的文件
  assert.ok(!picked.some((f) => f.startsWith('docs/')))
}

// ---- buildBaseline ------------------------------------------------------
{
  const coverage = {
    'lib/b.js': { lh: 2, lf: 4, fnh: 1, fnf: 2, brh: 0, brf: 2 },
    'lib/a.js': { lh: 1, lf: 3, fnh: 0, fnf: 1, brh: 1, brf: 1 },
  }
  const b = buildBaseline(coverage, { commit: 'abc1234', now: new Date('2026-11-11T04:00:00Z') })
  assert.equal(b.schema, BASELINE_SCHEMA)
  assert.equal(b.commit, 'abc1234')
  assert.equal(b.capturedAt, '2026-11-11T04:00:00.000Z')
  assert.deepEqual(Object.keys(b.files), ['lib/a.js', 'lib/b.js'], '文件顺序要稳定，否则每次刷新都产生无意义 diff')
  assert.deepEqual(b.files['lib/a.js'], { lh: 1, lf: 3, fnh: 0, fnf: 1, brh: 1, brf: 1 })
}

// ---- diffBaseline -------------------------------------------------------
{
  const baseline = {
    schema: BASELINE_SCHEMA,
    files: {
      'lib/core.js': { lh: 100, lf: 500, fnh: 5, fnf: 10, brh: 20, brf: 40 },
      'lib/gone.js': { lh: 1, lf: 2, fnh: 0, fnf: 0, brh: 0, brf: 0 },
    },
  }
  const same = diffBaseline(baseline, {
    'lib/core.js': { lh: 100, lf: 500, fnh: 5, fnf: 10, brh: 20, brf: 40 },
    'lib/gone.js': { lh: 1, lf: 2, fnh: 0, fnf: 0, brh: 0, brf: 0 },
  })
  assert.equal(same.ok, true)
  assert.deepEqual(same.rows, [])
  assert.deepEqual(same.dropped, [])
  assert.deepEqual(same.missing, [])
  assert.deepEqual(same.added, [])

  // 下跌：红
  const down = diffBaseline(baseline, {
    'lib/core.js': { lh: 98, lf: 500, fnh: 5, fnf: 10, brh: 20, brf: 40 },
    'lib/gone.js': { lh: 1, lf: 2, fnh: 0, fnf: 0, brh: 0, brf: 0 },
  })
  assert.equal(down.ok, false)
  assert.deepEqual(down.dropped, [{ file: 'lib/core.js', metric: 'lh', before: 100, after: 98 }])

  // 上涨：绿，但要在报告里看得见
  const up = diffBaseline(baseline, {
    'lib/core.js': { lh: 120, lf: 500, fnh: 5, fnf: 10, brh: 20, brf: 40 },
    'lib/gone.js': { lh: 1, lf: 2, fnh: 0, fnf: 0, brh: 0, brf: 0 },
  })
  assert.equal(up.ok, true)
  assert.deepEqual(up.dropped, [])
  assert.deepEqual(up.rows, [{ file: 'lib/core.js', metric: 'lh', before: 100, after: 120 }])

  // 基线有、实测没有：红（文件被删或被 exclude 误伤）
  const gone = diffBaseline(baseline, {
    'lib/core.js': { lh: 100, lf: 500, fnh: 5, fnf: 10, brh: 20, brf: 40 },
  })
  assert.equal(gone.ok, false)
  assert.deepEqual(gone.missing, ['lib/gone.js'])

  // 实测有、基线没有：只提示，不红（新增文件不该卡住开发）
  const added = diffBaseline(baseline, {
    'lib/core.js': { lh: 100, lf: 500, fnh: 5, fnf: 10, brh: 20, brf: 40 },
    'lib/gone.js': { lh: 1, lf: 2, fnh: 0, fnf: 0, brh: 0, brf: 0 },
    'lib/new.js': { lh: 0, lf: 10, fnh: 0, fnf: 1, brh: 0, brf: 0 },
  })
  assert.equal(added.ok, true)
  assert.deepEqual(added.added, ['lib/new.js'])
}

// ---- renderReport -------------------------------------------------------
{
  const clean = renderReport({ ok: true, rows: [], missing: [], added: [], dropped: [] })
  assert.match(clean, /\[coverage\] PASS/)
  assert.match(clean, /完全一致/)

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

  const risen = renderReport({
    ok: true,
    rows: [{ file: 'lib/core.js', metric: 'lh', before: 100, after: 105 }],
    missing: [],
    added: [],
    dropped: [],
  })
  assert.match(risen, /↑ lib\/core\.js 行 100 → 105 \(\+5\)/)
}

// ---- 与 package.json 的一致性 -------------------------------------------
// 守卫脚本读死 .tmp-coverage/lcov.info，而 lcov 目标由 scripts/coverage-suite.mjs 决定。
// 两边路径一旦错配，「守卫永远看不到新数据」这种静默故障不会有人发现。
{
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts['test:full'], 'node scripts/coverage-suite.mjs')
  assert.match(String(manifest.scripts['test:baseline'] || ''), /check-coverage-baseline\.mjs --update/)

  const full = fs.readFileSync(path.join(ROOT, 'scripts', 'coverage-suite.mjs'), 'utf8')
  assert.match(full, /--test-coverage-include=\$\{INCLUDE\}/)
  assert.match(full, /const INCLUDE = 'lib\/\*\*'/, '只能统计 lib/，否则 scripts/ 的高覆盖会稀释真问题')
  assert.match(full, /const EXCLUDE = 'docs\/\*\*'/, 'docs/origin 是测试参照物，被覆盖是正常现象')
  assert.match(full, /--test-reporter=lcov/)
  assert.match(full, /mkdirSync\(COVERAGE_DIR/, 'lcov reporter 不会自建目录，干净 clone 上必须自己建')
  assert.match(full, /check-coverage-baseline\.mjs/)
  // 无 .git 时覆盖率必然偏低（update.js 的 git 探测走 catch），
  // 这是环境差异不是倒退，必须跳过而不是报假红。
  assert.match(full, /rev-parse.*HEAD|rev-parse', \['HEAD'\]/, '要先探 git 是否可用')
  assert.match(full, /if \(!hasGit\) return 2/, '无 git 时返回 2（环境问题）而不是 1')

  // 守卫读的路径必须就是 test-full 写的路径
  const guardSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'check-coverage-baseline.mjs'), 'utf8')
  assert.match(guardSrc, /'\.tmp-coverage', 'lcov\.info'/, '守卫的 lcov 路径要与 test-full 一致')

  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  assert.match(ignore, /^\/\.tmp-coverage\/$/m, '.tmp-coverage 必须在 .gitignore 里')
}

console.log('coverage baseline PASS')
