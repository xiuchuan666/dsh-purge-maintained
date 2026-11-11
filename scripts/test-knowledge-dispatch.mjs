// 演练台知识库（POC 库）的路由回归。
//
// 这是 store-core.js 唯一的现成测试样本，5429 行的类里只覆盖了三个 op。
// 拆 test() 的意义不在数量，在于：搜空库、存一条、再搜出来是三个独立事实，
// 中间任一步坏了要能立刻指出来是哪一步，而不是笼统一句 dispatch failed。
//
// 每个用例自带一个临时 store：不共享状态，就不会因为执行顺序变化而假红。
// 原来的写法是一条顺序断言链，既看不到「哪一步」，也把顺序当成了隐含前提。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore, dispatch } from '../lib/redteam/store-core.js'

/** 开一个用完即弃的 store。 */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purge-kb-'))
  const store = new RedteamStore(dir)
  try {
    return fn(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const POC = {
  title: 'Local fixture',
  code: 'LOCAL-FIXTURE',
  kind: 'poc',
  source: 'manual',
  content: 'fixture content',
}

test('pocSearch 在空库上返回成功而不是报错', () => withStore((store) => {
  const empty = dispatch(store, { op: 'pocSearch', q: 'fixture' })
  assert.equal(empty.ok, true, JSON.stringify(empty))
  assert.deepEqual(empty.items, [])
}))

test('pocSave 落盘后立刻出现在 pocStats 里', () => withStore((store) => {
  const saved = dispatch(store, { op: 'pocSave', poc: POC })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(dispatch(store, { op: 'pocStats' }).stats.total, 1)
}))

test('pocSearch 能按标题找回刚存的那条', () => withStore((store) => {
  const saved = dispatch(store, { op: 'pocSave', poc: POC })
  assert.equal(saved.ok, true, JSON.stringify(saved))

  const listed = dispatch(store, { op: 'pocSearch', q: 'Local fixture' })
  assert.equal(listed.ok, true, JSON.stringify(listed))
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].title, 'Local fixture')
}))

console.log('knowledge dispatch PASS')
