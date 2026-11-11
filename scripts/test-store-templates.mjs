// 演练台的 nuclei 模板索引：本地已有现成 POC 时先查它，省掉一轮互联网检索。
//
// 索引是「按需构建 + 落盘缓存」：13k 个 yaml 逐个解析太慢，所以构建一次后靠
// `.nuclei-index.json` 复用，只有目录变了或缓存超过 7 天才重建。
//
// 拆成独立文件而不是塞进 knowledge-dispatch，是因为这里测的是缓存状态机
// （命中 / 过期 / 损坏 / 无目录），与 POC 库的 dispatch 路由是两件事：
// 缓存坏了不该让 POC 检索的失败信息混在一起。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore } from '../lib/redteam/store-core.js'

const DAY = 24 * 3600 * 1000

const TEMPLATE = [
  'id: CVE-2024-1234',
  'info:',
  '  name: Acme RCE',
  '  severity: critical',
  '  tags: acme,rce',
  '',
].join('\n')

/**
 * 把 HOME 指到一个空临时目录再跑 fn。
 *
 * `nucleiTemplatesDir()` 在 root 里找不到模板时会回退到 `~/.local/nuclei-templates`
 * 与 `~/nuclei-templates`——开发机上这两个目录常常真的存在（本机就有），
 * 不隔离的话「没装模板」这条用例在别人机器上过、在本机红。
 */
function withEmptyHome(fn) {
  const keys = ['USERPROFILE', 'HOME']
  const saved = keys.map((k) => [k, process.env[k]])
  const home = mkdtempSync(join(tmpdir(), 'dsh-purge-home-'))
  for (const k of keys) process.env[k] = home
  try {
    return fn(home)
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  }
}

/** 开一个带 nuclei 模板目录的 store；没有模板时连目录都不建，用来测「没装模板」。 */
function withTemplates(fn, { templates = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purge-tpl-'))
  if (templates) {
    const http = join(dir, 'toolkit', 'nuclei-templates', 'http')
    mkdirSync(http, { recursive: true })
    writeFileSync(join(http, 'CVE-2024-1234.yaml'), TEMPLATE, 'utf8')
  }
  const store = new RedteamStore(dir)
  try {
    return fn({ dir, store, cachePath: join(dir, 'pocs', '.nuclei-index.json') })
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('没有 nuclei 模板目录时返回空概览，而不是报错', () => withEmptyHome(() => withTemplates(({ store }) => {
  assert.deepEqual(store.templateStats(), { dir: null, total: 0, cve: 0 })
  assert.deepEqual(store.searchTemplates('cve'), { dir: null, total: 0, items: [] })
}, { templates: false })))

test('首次调用建立索引并落盘', () => withTemplates(({ store, cachePath }) => {
  const stats = store.templateStats()
  assert.equal(stats.total, 1)
  assert.equal(stats.cve, 1)

  const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
  assert.equal(cache.items.length, 1)
  assert.equal(typeof cache.built_at, 'number')
}))

test('第二次调用命中缓存：结果一致且缓存文件不被重写', () => withTemplates(({ store, cachePath }) => {
  const first = store.templateStats()
  const before = statSync(cachePath).mtimeMs

  const second = store.templateStats()
  assert.deepEqual(second, first)

  // 缓存命中的判据是「没有重新写盘」。只看结果相等会漏掉「每次都重建」这种退化。
  assert.equal(statSync(cachePath).mtimeMs, before)
}))

test('缓存超过 7 天后重建，看得到新加的模板', () => withTemplates(({ dir, store, cachePath }) => {
  store.templateStats()
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
  cache.built_at = Date.now() - 8 * DAY
  writeFileSync(cachePath, JSON.stringify(cache), 'utf8')

  const http = join(dir, 'toolkit', 'nuclei-templates', 'http')
  writeFileSync(join(http, 'CVE-2025-9999.yaml'), TEMPLATE.replace('CVE-2024-1234', 'CVE-2025-9999'), 'utf8')

  assert.equal(store.templateStats().total, 2)
}))

test('缓存文件坏掉时重建索引，而不是把异常抛给调用方', () => withTemplates(({ store, cachePath }) => {
  // 先跑一次让 pocs/ 目录存在，否则写坏缓存会失败在「目录不存在」而不是「JSON 坏了」。
  store.templateStats()
  writeFileSync(cachePath, '{ this is not json', 'utf8')
  assert.equal(store.templateStats().total, 1)
}))

test('检索：CVE 编号按文件名命中，关键字按 name 与 tags 命中', () => withTemplates(({ store }) => {
  assert.equal(store.searchTemplates('cve-2024-1234').items.length, 1)
  assert.equal(store.searchTemplates('acme').items[0].name, 'Acme RCE')
  assert.equal(store.searchTemplates('rce').items[0].severity, 'critical')
}))

test('空查询只报总数、不返回条目', () => withTemplates(({ store }) => {
  const out = store.searchTemplates('')
  assert.equal(out.total, 1)
  assert.deepEqual(out.items, [])
}))

test('limit 截断结果，但总数仍是全量', () => withTemplates(({ dir, store }) => {
  const http = join(dir, 'toolkit', 'nuclei-templates', 'http')
  for (const n of [1, 2, 3]) {
    writeFileSync(join(http, `CVE-2024-000${n}.yaml`), TEMPLATE.replace('CVE-2024-1234', `CVE-2024-000${n}`), 'utf8')
  }
  const out = store.searchTemplates('cve', 2)
  assert.equal(out.items.length, 2)
  assert.equal(out.total, 4)
}))

console.log('store templates PASS')
