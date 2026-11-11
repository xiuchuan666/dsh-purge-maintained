// 覆盖率棘轮基线守卫。
//
//   node scripts/check-coverage-baseline.mjs            比对（默认）
//   node scripts/check-coverage-baseline.mjs --update   把当前实测写成新基线
//
// 数据来源：npm run test:full 里的 lcov reporter 写出的 .tmp-coverage/lcov.info。
// 退出码：0 未跌破；1 跌破或有文件掉队；2 读数/用法失败。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  parseLcov,
  selectCovered,
  buildBaseline,
  diffBaseline,
  renderReport,
} from './coverage-baseline-lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LCOV = path.join(ROOT, '.tmp-coverage', 'lcov.info')
const BASELINE = path.join(ROOT, 'docs', 'test-baseline.json')

function gitCommit() {
  try {
    const r = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
    return r.status === 0 ? String(r.stdout || '').trim() : ''
  } catch {
    return ''
  }
}

function readCoverage() {
  if (!fs.existsSync(LCOV)) {
    console.error(`[coverage] 找不到 ${path.relative(ROOT, LCOV)}`)
    console.error('[coverage] 先跑 npm run test:full（它会用 lcov reporter 产出这个文件）')
    process.exit(2)
  }
  const raw = parseLcov(fs.readFileSync(LCOV, 'utf8'))
  const covered = selectCovered(raw)
  if (!Object.keys(covered).length) {
    console.error('[coverage] lcov 里没有任何 lib/ 文件，检查 --test-coverage-include 是否生效')
    process.exit(2)
  }
  return covered
}

function main() {
  const update = process.argv.includes('--update')
  const coverage = readCoverage()

  if (update) {
    const baseline = buildBaseline(coverage, {
      commit: gitCommit(),
      note: '棘轮基线：只许涨。刷新用 npm run test:baseline',
    })
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
    fs.writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
    const count = Object.keys(baseline.files).length
    console.log(`[coverage] 基线已更新 ${path.relative(ROOT, BASELINE)}（${count} 个文件，commit ${baseline.commit || 'unknown'}）`)
    return 0
  }

  if (!fs.existsSync(BASELINE)) {
    console.error(`[coverage] 找不到基线 ${path.relative(ROOT, BASELINE)}`)
    console.error('[coverage] 首次使用请跑 npm run test:baseline')
    return 2
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  const diff = diffBaseline(baseline, coverage)
  console.log(renderReport(diff, { baselinePath: path.relative(ROOT, BASELINE) }))
  return diff.ok ? 0 : 1
}

process.exit(main())
