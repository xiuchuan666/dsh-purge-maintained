import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverTests } from './check-lib.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const tests = discoverTests(root)
console.log(`[test] ${tests.length} regression tests`)
for (const test of tests) {
  console.log(`\n[test] ${test}`)
  const result = spawnSync(process.execPath, [test], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    console.error(`\n[test] FAIL ${test} (exit ${result.status ?? 'unknown'})`)
    process.exit(result.status ?? 1)
  }
}
console.log(`\n[test] PASS ${tests.length}/${tests.length}`)
