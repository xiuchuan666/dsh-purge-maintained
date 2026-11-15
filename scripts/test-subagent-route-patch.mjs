// #91 / #94 的行为证据：这两条补丁删的是「子代理路由 / 模型发现按 Session 策略拦截」的两个 throw。
//
// 只断言「注册表里有这个 patch」不够：needle 写错一个字符，patch 会在真实宿主上静默变成
// missing_file，而状态表看起来一切正常。所以这里直接拿原件文本跑替换，断言：①两个 throw 都被换掉，
// ②换上去的是 return / void 0 这种无害语句，③同文件里 :189 的 provider 校验没被误伤。
//
// 原件来自本地解包副本 .tmp-rehearse/asar-pristine（不进仓库），CI 上没有它 —— 前两例 skip，
// 第三例只读仓库内文件，照常跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const PRISTINE = path.join(root, '.tmp-rehearse', 'asar-pristine', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tool-subagent', 'lib', 'index.js')
const NO_PRISTINE = !fs.existsSync(PRISTINE) && '需要本地 .tmp-rehearse/asar-pristine 解包副本（不进仓库）'
const { ALL_PATCHES } = await import(pathToFileURL(path.join(root, 'lib', 'core.js')).href)
const patchOf = (id) => ALL_PATCHES.find((p) => Number(p.id) === id)

test('#91 SUBAGENT_ROUTE_POLICY_BYPASS：路由策略 throw 换成 return，且 needle 唯一', { skip: NO_PRISTINE }, () => {
  const patch = patchOf(91)
  assert.ok(patch, 'patch #91 必须还在注册表里')
  assert.equal(patch.file[0], 'tool-subagent')
  assert.deepEqual(patch.markers, ['[dsh-purge] child route policy bypassed'])
  const src = fs.readFileSync(PRISTINE, 'utf8')
  const rep = patch.replacements[0]
  assert.equal(src.split(rep.pattern).length - 1, 1, '#91 的 needle 在原件里必须唯一')
  const out = src.split(rep.pattern).join(rep.replace)
  assert.ok(out.includes('[dsh-purge] child route policy bypassed'), '标记必须写进文件')
  assert.ok(!out.includes('explicit selection is limited to the parent route'), '策略限制的文案必须消失')
  assert.ok(out.includes('LLM provider'), '同文件的 provider 校验（#22，裁决不打）必须原样保留')
})

test('#94 SUBAGENT_MODEL_DISCOVERY_BYPASS：模型发现的 route throw 换成 void 0，解析函数仍在', { skip: NO_PRISTINE }, () => {
  const patch = patchOf(94)
  assert.ok(patch, 'patch #94 必须还在注册表里')
  assert.deepEqual(patch.markers, ['[dsh-purge] model discovery bypass'])
  const src = fs.readFileSync(PRISTINE, 'utf8')
  const rep = patch.replacements[0]
  assert.equal(src.split(rep.pattern).length - 1, 1, '#94 的 needle 在原件里必须唯一')
  const out = src.split(rep.pattern).join(rep.replace)
  assert.ok(out.includes('[dsh-purge] model discovery bypass'), '标记必须写进文件')
  assert.ok(out.includes('llm.resolveModelInfo(provider.id, request.model, signal)'), 'resolveModelInfo 必须还在')
})

test('两条补丁的形状：单文件、有 marker、replace 是 return/void 0（不引入新逻辑）', () => {
  for (const [id, marker, shape] of [[91, '[dsh-purge] child route policy bypassed', /^return; /], [94, '[dsh-purge] model discovery bypass', /^void 0; /]]) {
    const patch = patchOf(id)
    assert.ok(patch, `patch #${id} 必须在注册表里`)
    assert.deepEqual(patch.file, ['tool-subagent'], `#${id} file`)
    assert.deepEqual(patch.rel, ['lib', 'index.js'], `#${id} rel`)
    assert.deepEqual(patch.markers, [marker], `#${id} markers`)
    assert.equal(patch.replacements.length, 1, `#${id} 单条 replacement`)
    assert.match(patch.replacements[0].replace, shape, `#${id} 替换成无害语句`)
  }
})

test('预设里 modelSelection / modelDiscovery 用的是宿主 Config 的真实字段名', () => {
  const preset = fs.readFileSync(path.join(root, 'presets', 'redteam', 'agent.cordis.yml'), 'utf8')
  assert.match(preset, /^\s*modelSelection: true$/m, '必须写 modelSelection（0.2.2 的 Config 字段）')
  assert.match(preset, /^\s*modelDiscovery: true$/m, '必须写 modelDiscovery，否则 list_subagent_models 不注册')
  assert.ok(!/^\s*modelSelectionSettings:/m.test(preset), 'modelSelectionSettings 是旧键名，schemastery 会静默剥掉')
})
