import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function discoverTests(root) {
  const tests = readdirSync(join(root, 'scripts'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^test-.*\.mjs$/.test(entry.name))
    .map((entry) => `scripts/${entry.name}`)
    .sort()
  if (tests.length === 0) throw new Error('no test-*.mjs files found in scripts/')
  return tests
}

export function validateMetadata(root, patches) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const version = manifest.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('package.json version must be a semver string')
  }
  const notes = readFileSync(join(root, 'release-notes.md'), 'utf8')
  const firstHeading = notes.split(/\r?\n/, 1)[0]
  if (firstHeading !== `# ${version}`) {
    throw new Error(`release-notes.md first heading must be # ${version}; received: ${firstHeading}`)
  }
  if (!Array.isArray(manifest.dshTargets) || !manifest.dshTargets.includes(manifest.dshTarget)) {
    throw new Error('dshTargets must include dshTarget')
  }
  if (!Array.isArray(patches) || patches.length === 0) throw new Error('patch registry is empty')
  const ids = new Set()
  for (const patch of patches) {
    const id = patch?.id
    if (!Number.isInteger(id) || id < 0) throw new Error(`invalid patch id: ${id}`)
    if (ids.has(id)) throw new Error(`duplicate patch id: ${id}`)
    ids.add(id)
  }
  return { version, patchCount: patches.length }
}
