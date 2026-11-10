import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverTests, validateMetadata } from './check-lib.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-purge-verification-'))
try {
  const scripts = join(root, 'scripts')
  mkdirSync(join(scripts, 'nested'), { recursive: true })
  for (const name of ['test-b.mjs', 'test-a.mjs', 'notes.txt']) {
    writeFileSync(join(scripts, name), '')
  }
  writeFileSync(join(scripts, 'nested', 'test-c.mjs'), '')
  mkdirSync(join(scripts, 'test-directory.mjs'))
  assert.deepEqual(discoverTests(root), ['scripts/test-a.mjs', 'scripts/test-b.mjs'])

  const empty = join(root, 'empty')
  mkdirSync(join(empty, 'scripts'), { recursive: true })
  assert.throws(() => discoverTests(empty), /no test-\*\.mjs files/)

  const fixture = join(root, 'metadata')
  mkdirSync(fixture, { recursive: true })
  const manifest = {
    version: '1.2.3',
    dshTarget: '0.2.2-rc.1',
    dshTargets: ['0.2.2-rc.1'],
  }
  const writeMetadata = (value = manifest, firstLine = '# 1.2.3') => {
    writeFileSync(join(fixture, 'package.json'), JSON.stringify(value))
    writeFileSync(join(fixture, 'release-notes.md'), `${firstLine}\n`)
  }
  writeMetadata()
  assert.deepEqual(validateMetadata(fixture, [{ id: 1 }, { id: 2 }]), {
    version: '1.2.3',
    patchCount: 2,
  })

  writeMetadata(manifest, '# 1.2.2')
  assert.throws(() => validateMetadata(fixture, [{ id: 1 }]), /release-notes\.md first heading must be # 1\.2\.3/)
  writeMetadata({ ...manifest, dshTargets: ['0.2.1-rc.5'] })
  assert.throws(() => validateMetadata(fixture, [{ id: 1 }]), /dshTargets must include dshTarget/)
  writeMetadata()
  assert.throws(() => validateMetadata(fixture, [{ id: 1 }, { id: 1 }]), /duplicate patch id: 1/)
  assert.deepEqual(validateMetadata(fixture, [{ id: 76 }, { id: 70 }]), {
    version: '1.2.3',
    patchCount: 2,
  }, 'patch application order is behavior and must not be constrained by numeric id')
  assert.throws(() => validateMetadata(fixture, []), /patch registry is empty/)
  console.log('verification helpers PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}
