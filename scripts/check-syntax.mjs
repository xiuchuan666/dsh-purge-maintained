import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)
      ? [relative(root, path).replaceAll('\\', '/')]
      : []
  })
}

const files = ['bin', 'lib', 'scripts'].flatMap((directory) => sourceFiles(resolve(root, directory)))
// client.js 在仓库根目录，不在 bin/lib/scripts 里，单独纳入
if (existsSync(resolve(root, 'client.js'))) files.push('client.js')
files.sort()
console.log(`[syntax] checking ${files.length} JavaScript files`)
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
await import(pathToFileURL(resolve(root, 'lib/index.js')).href)
console.log(`[syntax] PASS ${files.length} files; lib/index.js imported`)
