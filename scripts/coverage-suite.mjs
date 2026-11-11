// npm run test:full 的编排器：跑测试 → 写 lcov → 与基线比对。
//
// 为什么要一个脚本而不是在 package.json 里写一长串 && ：
//  1. node --test 的 lcov reporter **不会自动创建目标目录**，干净 clone 上
//     直接跑会 ENOENT。这里先 mkdir。
//  2. 那条命令太长，换行后 npm script 很难读，也不好加注释。
//  3. 需要把 --test-coverage-include/exclude 与守卫脚本读取的路径绑在一起，
//     两者错配是「守卫永远看不到新数据」这类静默故障的源头。
//
// 退出码：测试失败 → 测试的退出码；覆盖率跌破 → 1；环境问题 → 2。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COVERAGE_DIR = path.join(ROOT, '.tmp-coverage')
const LCOV = path.join(COVERAGE_DIR, 'lcov.info')

// 只统计 lib/：scripts/ 自己的覆盖率有 94%~100%，混进来会稀释真正要守的部分；
// docs/ 里放的是 docs/origin 的历史快照（测试参照物），它被覆盖是正常现象。
const INCLUDE = 'lib/**'
const EXCLUDE = 'docs/**'

function main() {
  fs.mkdirSync(COVERAGE_DIR, { recursive: true })

  // 基线是在有 git 提交的目录里采集的：lib/update.js 的 canGit/gitHead 在无
  // .git 时会走 catch 分支，行/分支覆盖率比基线低十几行，守卫就会报一串
  // 看不懂的 `↓ lib/update.js`。这不是倒退，是环境不具备，所以按约定跳过
  // 比对并返回 2（环境问题），而不是报假红。
  const gitProbe = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { stdio: 'ignore' })
  const hasGit = gitProbe.status === 0
  if (!hasGit) {
    console.warn('[test:full] 当前目录没有可用的 git 提交（如来自 tgz 解包），跳过覆盖率比对。')
    console.warn('            原因：lib/update.js 的 canGit/gitHead 会走 catch 分支，')
    console.warn('            覆盖率必然低于基线，那是环境差异不是倒退。')
    console.warn('            要跑这项检查请在 git 工作副本里执行；只验测试用 npm test 即可。')
  }

  const testArgs = [
    '--test',
    '--experimental-test-coverage',
    `--test-coverage-include=${INCLUDE}`,
    `--test-coverage-exclude=${EXCLUDE}`,
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    `--test-reporter-destination=${path.relative(ROOT, LCOV)}`,
    'scripts/test-*.mjs',
  ]

  console.log(`[test:full] node ${testArgs.join(' ')}`)
  const run = spawnSync(process.execPath, testArgs, { cwd: ROOT, stdio: 'inherit', shell: false })
  if (run.error) {
    console.error(`[test:full] 无法启动 node --test: ${run.error.message}`)
    return 2
  }
  if (run.status !== 0) {
    console.error(`[test:full] 测试未通过（exit ${run.status ?? 'unknown'}），跳过覆盖率比对`)
    return run.status ?? 1
  }
  if (!fs.existsSync(LCOV)) {
    console.error(`[test:full] 测试通过但没有产出 ${path.relative(ROOT, LCOV)}`)
    return 2
  }

  if (!hasGit) return 2

  const guard = spawnSync(process.execPath, ['scripts/check-coverage-baseline.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (guard.error) {
    console.error(`[test:full] 无法启动覆盖率守卫: ${guard.error.message}`)
    return 2
  }
  return guard.status ?? 1
}

process.exit(main())
