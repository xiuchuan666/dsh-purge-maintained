/**
 * BOM 守卫单测 / BOM guard test.
 *
 * 覆盖 0.2.2 桌面端「Unexpected token '\uFEFF' … is not valid JSON」这一类救砖场景：
 *   1. 带 BOM 的 profiles/<x>/package.json → scan 报 bom，fix 后首字节不是 BOM 且 JSON 可解析
 *   2. 不带 BOM 的正常清单 → scan 干净，fix 不动文件（mtime 不变）
 *   3. 剥了 BOM 仍解析不过的 JSON → 报 broken，fix 不写盘（不把坏文件写得更坏）
 *   4. cordis.patch.yml 的 BOM 也一并剥掉，且 YAML 内容原样
 *
 * 为什么拆成 test()：这里原本是顺序断言，第一处失败就整文件停住，后面的场景
 * 根本不执行。救砖逻辑一次坏两个分支是常事（比如「能修的不修」和「不该修的修了」），
 * 那时只看到第一条就等于什么都不知道。
 *
 * 跑法：node scripts/test-bom-guard.mjs（或 npm test）
 */
import { test, after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { scanProfileBom, fixProfileBom, readTextNoBom, hasBom } from '../lib/bom-guard.js'

const BOM = '\uFEFF'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bomguard-'))
const home = path.join(root, 'dshhome')
const good = path.join(home, 'profiles', 'good')
const broken = path.join(home, 'profiles', 'broken')
const clean = path.join(home, 'profiles', 'clean')
for (const dir of [good, broken, clean]) fs.mkdirSync(dir, { recursive: true })

// 1) 带 BOM 的合法清单
const goodPkg = { name: 'dsh-profile-good', dsh: { profile: { bundles: ['dsh-purge'] } } }
fs.writeFileSync(path.join(good, 'package.json'), BOM + JSON.stringify(goodPkg, null, 2) + '\n', 'utf8')
fs.writeFileSync(path.join(good, 'cordis.patch.yml'), BOM + '- insert:\n    - id: dsh-purge\n', 'utf8')

// 2) 正常清单
const cleanPkg = { name: 'dsh-profile-clean' }
fs.writeFileSync(path.join(clean, 'package.json'), JSON.stringify(cleanPkg, null, 2) + '\n', 'utf8')
const cleanStatBefore = fs.statSync(path.join(clean, 'package.json')).mtimeMs

// 3) 剥 BOM 后仍然坏的 JSON
fs.writeFileSync(path.join(broken, 'package.json'), BOM + '{ "name": "x", ', 'utf8')

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('scan 点出所有 BOM 清单，并单独标出修不了的那个', () => {
  const before = scanProfileBom(home)
  assert.equal(before.bom.length, 3, `expected 3 BOM manifests, got ${before.bom.length}`)
  assert.equal(before.broken.length, 1, `expected 1 broken manifest, got ${before.broken.length}`)
  assert.equal(before.ok, false)
})

test('fix 只写能修的清单，坏文件一个字节都不动', () => {
  const fixed = fixProfileBom(home)
  assert.equal(fixed.fixed.length, 2, `expected 2 fixed, got ${fixed.fixed.length}`)
  assert.equal(fixed.failed.length, 1, `expected 1 refused, got ${fixed.failed.length}`)

  const goodPkgRaw = fs.readFileSync(path.join(good, 'package.json'), 'utf8')
  assert.equal(hasBom(goodPkgRaw), false, 'package.json still has BOM')
  assert.deepEqual(JSON.parse(goodPkgRaw), goodPkg, 'JSON 内容必须逐字段不变')

  // YAML 只该被剥掉 BOM，正文一个字符都不能动。
  const goodYml = fs.readFileSync(path.join(good, 'cordis.patch.yml'), 'utf8')
  assert.equal(hasBom(goodYml), false, 'cordis.patch.yml still has BOM')
  assert.equal(goodYml, '- insert:\n    - id: dsh-purge\n')

  assert.equal(readTextNoBom(path.join(broken, 'package.json')).startsWith('{'), true)
})

test('修不了的清单保持原样，不被「顺手修坏」', () => {
  const brokenRaw = fs.readFileSync(path.join(broken, 'package.json'), 'utf8')
  assert.equal(hasBom(brokenRaw), true, 'broken manifest must be left untouched')
  assert.equal(brokenRaw, BOM + '{ "name": "x", ', '坏文件的字节必须完全没变')
})

test('fix 之后再 scan：只剩那个修不了的', () => {
  const after2 = scanProfileBom(home)
  assert.equal(after2.bom.length, 1, 'only the unrepairable BOM should remain')
  assert.equal(after2.broken.length, 1)
})

test('本来干净的清单不会被重写（mtime 不变）', () => {
  const cleanStatAfter = fs.statSync(path.join(clean, 'package.json')).mtimeMs
  assert.equal(cleanStatAfter, cleanStatBefore, 'clean manifest must not be rewritten')
  assert.equal(hasBom(fs.readFileSync(path.join(clean, 'package.json'), 'utf8')), false)
})
