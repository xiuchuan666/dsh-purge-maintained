import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore, dispatch } from '../lib/redteam/store-core.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-purge-kb-'))
const store = new RedteamStore(dir)
try {
  const empty = dispatch(store, { op: 'pocSearch', q: 'fixture' })
  assert.equal(empty.ok, true, JSON.stringify(empty))
  assert.equal(empty.items.length, 0)
  const saved = dispatch(store, { op: 'pocSave', poc: { title: 'Local fixture', code: 'LOCAL-FIXTURE', kind: 'poc', source: 'manual', content: 'fixture content' } })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const listed = dispatch(store, { op: 'pocSearch', q: 'Local fixture' })
  assert.equal(listed.ok, true, JSON.stringify(listed))
  assert.equal(listed.items.length, 1)
  assert.equal(dispatch(store, { op: 'pocStats' }).stats.total, 1)
  console.log('knowledge dispatch PASS')
} finally {
  store.close()
  rmSync(dir, { recursive: true, force: true })
}
