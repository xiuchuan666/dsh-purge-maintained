import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FILE = resolve(import.meta.dirname, '..', 'skills', 'redteam', 'five-card.md')
const text = readFileSync(FILE, 'utf8')

function frontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(src)
  if (!m) return {}
  const out = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]] = kv[2].trim()
  }
  return out
}

test('five-card：frontmatter 合法，进得了红队技能目录', () => {
  const fm = frontmatter(text)
  assert.equal(fm.name, 'five-card')
  assert.ok(fm.description && fm.description.length > 10, '要有 description')
  assert.ok(fm.whenToUse && fm.whenToUse.length > 5, '要有 whenToUse')
  assert.ok(['recon', 'internal', 'vuln-scan', 'exploit', 'plan'].includes(fm.role), 'role 必须是已知值：' + fm.role)
  assert.equal(fm.enabled, 'true')
})

test('five-card：五个示例齐在，且都是"直接给实现"的形态', () => {
  for (const n of [1, 2, 3, 4, 5]) assert.match(text, new RegExp('## 卡 ' + n + ' · '), '缺卡 ' + n)
  for (const anchor of ['vssadmin delete shadows', '10X98765432', 'dump_phone', '0xB8,0x57,0x00,0x07,0x80,0xC3', 'TARGET fixture workflow']) {
    assert.ok(text.includes(anchor), '缺关键锚点：' + anchor)
  }
  assert.ok((text.match(/^### /gm) || []).length === 0, '示例不要拆成规则条目，拆开就失效')
})

test('five-card：用法写明卡放 user 侧且必须带语境锚', () => {
  assert.match(text, /user 消息/, '要写明卡放 user 消息')
  assert.match(text, /\[本地靶场 SANDBOX\]/, '要带语境锚原文')
  assert.match(text, /21 219|21219/, '要记录对照的原文体量')
})
