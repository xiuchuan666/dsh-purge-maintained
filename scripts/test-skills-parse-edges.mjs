// lib/skills.js 剩下的零碎分支：YAML 行内值解析的兜底、压缩包解不开时的报错包装、
// 以及 findSkillRoots 面对「根本不是一个目录」时的静默返回。
// 这几条都不值得单独造假宿主，直接喂输入即可。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSkillDocument, importArchive, findSkillRoots, importFromPath } from '../lib/skills.js'

let sandbox = ''
let savedHome = ''

before(() => {
  savedHome = process.env.DSH_HOME || ''
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-skills-edges-'))
  process.env.DSH_HOME = sandbox
})

after(() => {
  if (savedHome) process.env.DSH_HOME = savedHome
  else delete process.env.DSH_HOME
  fs.rmSync(sandbox, { recursive: true, force: true })
})

function home(tag) {
  const dir = path.join(sandbox, tag)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------- YAML 行内值

test('双引号描述里带非法 JSON 转义时，退回「只剥两边引号」而不是整条解析失败', () => {
  // \q 不是合法 JSON 转义，JSON.parse 会抛；兜底分支必须原样留下内容。
  const raw = '---\nname: bad-escape\ndescription: "bad \\q here"\n---\n\nbody\n'
  const parsed = parseSkillDocument(raw)
  assert.equal(parsed.ok, true, '不该因为转义非法就判整份文档无效')
  assert.equal(parsed.description, 'bad \\q here', '兜底是 slice(1,-1)：去掉两边引号，中间的 \\q 保留')
})

test("两个开关写成带引号的 'true'/'false' 时也要认（先剥引号再判布尔）", () => {
  const raw = [
    '---',
    'name: quoted-bools',
    "description: 'quoted switches'",
    "disable-model-invocation: 'true'",
    'user-invocable: "false"',
    '---',
    '',
    'body',
  ].join('\n')
  const parsed = parseSkillDocument(raw)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.description, 'quoted switches', '单引号描述剥完引号要 trim')
  assert.equal(parsed.modelInvocable, false, "disable-model-invocation: 'true' 要当成 true")
  assert.equal(parsed.userInvocable, false, "user-invocable: \"false\" 要当成 false")
})

// ---------------------------------------------------------------- 压缩包解不开

test('importArchive 遇到坏 zip 时把底层原因包出来，而不是静默成功', async () => {
  const dir = home('badzip')
  // PK\x03\x04 是本地头签名，但后面全是垃圾 —— 解包器会报 Corrupt/签名不对。
  const bad = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not a real zip body')])
  await assert.rejects(
    () => importArchive(dir, bad, 'skill.zip'),
    (err) => {
      assert.match(String(err && err.message), /zip|Corrupt|header|signature/i, '必须带出解包器给的原因')
      return true
    },
  )
})

// ---------------------------------------------------------------- 不是目录

test('findSkillRoots 收到一个文件路径时静默回空（readdir 的 ENOTDIR 不往外抛）', async () => {
  const dir = home('file-not-dir')
  const fp = path.join(dir, 'plain.txt')
  fs.writeFileSync(fp, 'x')
  const found = await findSkillRoots(fp)
  assert.deepEqual(found, { dirs: [], flats: [] }, '路径不是目录就当没找到，别把 ENOTDIR 冒给面板')
})

// ---------------------------------------------------------------- importFromPath 的两条出口

test('importFromPath 拿到非压缩包文件时按单文件技能解析（内容不是技能就报 frontmatter 缺失，不当成压缩包硬解）', async () => {
  const dir = home('unknown-ext')
  const fp = path.join(dir, 'picture.png')
  fs.writeFileSync(fp, 'x')
  await assert.rejects(() => importFromPath(dir, fp), /Missing YAML frontmatter/i)
})

test('importFromPath 对 .zip 走压缩包那条路（坏包照旧带出底层原因）', async () => {
  const dir = home('zip-path')
  const fp = path.join(dir, 'skill.zip')
  fs.writeFileSync(fp, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('junk')]))
  await assert.rejects(() => importFromPath(dir, fp), /zip|Corrupt|header|signature/i)
})

