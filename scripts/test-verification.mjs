// check-lib.mjs 两个纯函数的行为锁定：测试发现规则、元数据校验规则。
//
// 拆成独立用例的理由：discoverTests 与 validateMetadata 是**全部**检查链的入口，
// 它们错了会以「检查器本身崩了」的形式出现，而不是某条业务断言红。这时最想知道的
// 是「发现规则错了」还是「元数据规则错了」——一条链只会告诉你第一个错。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverTests, validateMetadata } from './check-lib.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-purge-verification-'))

test.after(() => {
  rmSync(root, { recursive: true, force: true })
})

// ------------------------------------------------------------ discoverTests

test('只认 scripts/ 直接子级的 test-*.mjs，排序后返回', () => {
  const scripts = join(root, 'scripts')
  mkdirSync(join(scripts, 'nested'), { recursive: true })
  for (const name of ['test-b.mjs', 'test-a.mjs', 'notes.txt']) writeFileSync(join(scripts, name), '')
  writeFileSync(join(scripts, 'nested', 'test-c.mjs'), '')
  mkdirSync(join(scripts, 'test-directory.mjs'))
  assert.deepEqual(discoverTests(root), ['scripts/test-a.mjs', 'scripts/test-b.mjs'])
})

test('一个测试都找不到时抛错（而不是静默通过）', () => {
  const empty = join(root, 'empty')
  mkdirSync(join(empty, 'scripts'), { recursive: true })
  assert.throws(() => discoverTests(empty), /no test-\*\.mjs files/)
})

// ------------------------------------------------------------ validateMetadata

const manifest = {
  version: '1.2.3',
  dshTarget: '0.2.2-rc.1',
  dshTargets: ['0.2.2-rc.1'],
}
const fixture = join(root, 'metadata')
mkdirSync(fixture, { recursive: true })

/** 写一套元数据 fixture，默认是健康的一套。 */
function writeMetadata(value = manifest, firstLine = '# 1.2.3') {
  writeFileSync(join(fixture, 'package.json'), JSON.stringify(value))
  writeFileSync(join(fixture, 'release-notes.md'), `${firstLine}\n`)
}

test('健康的元数据通过，并回传版本与补丁数', () => {
  writeMetadata()
  assert.deepEqual(validateMetadata(fixture, [{ id: 1 }, { id: 2 }]), {
    version: '1.2.3',
    patchCount: 2,
  })
})

test('发布说明首行与 version 不一致时失败（发版门禁）', () => {
  writeMetadata(manifest, '# 1.2.2')
  assert.throws(() => validateMetadata(fixture, [{ id: 1 }]), /release-notes\.md first heading must be # 1\.2\.3/)
})

test('dshTargets 不含 dshTarget 时失败', () => {
  writeMetadata({ ...manifest, dshTargets: ['0.2.1-rc.5'] })
  assert.throws(() => validateMetadata(fixture, [{ id: 1 }]), /dshTargets must include dshTarget/)
})

test('补丁 id 重复时失败', () => {
  writeMetadata()
  assert.throws(() => validateMetadata(fixture, [{ id: 1 }, { id: 1 }]), /duplicate patch id: 1/)
})

test('补丁 id 不要求数值升序（应用顺序是行为，见 #76 先于 #70）', () => {
  writeMetadata()
  assert.deepEqual(validateMetadata(fixture, [{ id: 76 }, { id: 70 }]), {
    version: '1.2.3',
    patchCount: 2,
  }, 'patch application order is behavior and must not be constrained by numeric id')
})

test('补丁表为空时失败', () => {
  writeMetadata()
  assert.throws(() => validateMetadata(fixture, []), /patch registry is empty/)
})
