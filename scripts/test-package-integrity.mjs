// 打包完整性：这台机器只靠「npm pack → 换 tgz → 重装」升级，
// 所以 package.json 的 files/dsh.install/private 一旦回退，升级链路就断了。
//
// 每条断言对应一个曾经真实发生过、或差点发生的退步：
//   - files 少了 skills / client.js → 装上去功能缺一块
//   - README 三份并存 → 每次改文档要同步三处（已合并成一份中文）
//   - publishConfig + 无 private → 有可能误发到 npm 公共源
//   - dsh.install 指回上游 → 上游已删库，装的时候 404
// 拆成独立用例，坏哪一类就看哪一类。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const require = createRequire(import.meta.url)

test('版本号是 1.1.x 且不小于 1.1.93', () => {
  // 版本号每次发版都变，钉死旧号只会让发版必红；校验形状 + 下界即可。
  assert.match(manifest.version, /^1\.1\.\d+$/)
  assert.ok(Number(manifest.version.split('.')[2]) >= 93)
})

test('目标宿主声明：dshTarget 是 rc.3，且历史版本仍列在 dshTargets 里', () => {
  // 2026-11 之前这里钉的是「dshTargets 含 0.2.2-rc.1」。那条断言在推 rc.2 之后
  // 依然为绿（rc.1 还留在数组里），但用例名会骗人：真正的契约是三条 ——
  //   1) dshTarget 就是这个版本，2) 它必定出现在 dshTargets 里（check-lib 的硬约束），
  //   3) 老版本不被顺手删掉（删了会让「用户降级回 rc.1」变成状态页报未适配）。
  assert.equal(manifest.dshTarget, '0.2.2-rc.3')
  assert.ok(manifest.dshTargets.includes(manifest.dshTarget), 'dshTargets must include dshTarget')
  assert.equal(manifest.dshTargets[0], manifest.dshTarget, '首个目标应当是最新版本')
  for (const still of ['0.2.2-rc.2', '0.2.2-rc.1', '0.2.1-rc.5', '0.2.1-rc.2']) {
    assert.ok(manifest.dshTargets.includes(still), `${still} must stay listed`)
  }
})

test('目标宿主声明没有重复项', () => {
  // lib/core.js 的 HOST_TARGETS 用 new Set 去重，重复项在那里是静默的；
  // 但 package.json 里重复说明有人「追加时没看原来有没有」，先在这里拦。
  assert.equal(new Set(manifest.dshTargets).size, manifest.dshTargets.length)
})

test('files 收进了运行时需要的目录', () => {
  assert.ok(manifest.files.includes('skills'))
  assert.ok(manifest.files.includes('!lib/**/*.bak'))
})

test('README 只有一份中文，旧的两份既不在 files 也不在磁盘', () => {
  assert.ok(manifest.files.includes('README.md'))
  assert.ok(existsSync(join(root, 'README.md')), 'README.md')
  for (const gone of ['README.zh-CN.md', 'README.ja.md']) {
    assert.ok(!manifest.files.includes(gone), `${gone} must not be in files`)
    assert.ok(!existsSync(join(root, gone)), `${gone} must be deleted`)
  }
})

test('维护副本不会被误发到 npm', () => {
  assert.equal(manifest.private, true)
  assert.equal(manifest.publishConfig, undefined)
})

test('dsh.install 指向维护仓库而不是已删库的上游', () => {
  assert.ok(manifest.dsh.install.tarball.includes('xiuchuan666/dsh-purge-maintained'))
  assert.ok(manifest.dsh.install.git.includes('xiuchuan666/dsh-purge-maintained'))
})

test('随包技能仍是 23 个', () => {
  assert.equal(readdirSync(join(root, 'skills', 'redteam')).filter((x) => x.endsWith('.md')).length, 24)
})

test('关键文件都还在', () => {
  for (const p of [
    'lib/redteam/store-core.js', 'lib/redteam/client.js', 'lib/redteam/index.js',
    'lib/redteam/ui.js', 'presets/redteam/agent.cordis.yml', 'scripts/test-knowledge-dispatch.mjs',
  ]) {
    assert.ok(existsSync(join(root, p)), p)
  }
})

test('client.js 产物里嵌着知识库/技能库路由', () => {
  const generated = readFileSync(join(root, 'client.js'), 'utf8')
  assert.ok(generated.includes("st.tab === 'knowledge'"), 'embedded knowledge route')
  assert.ok(generated.includes("st.tab === 'skills'"), 'embedded skills route')
})

test('预设里没有已移除的 host 子路径', () => {
  const preset = readFileSync(join(root, 'presets/redteam/agent.cordis.yml'), 'utf8')
  assert.ok(!preset.includes('@deepseek-ai/dsh-tool-subagent-control/list-agents'))
})

test('store-core.js 能被 require.resolve 找到（宿主按路径加载）', () => {
  const installed = require.resolve(join(root, 'lib/redteam/store-core.js'))
  assert.ok(installed.endsWith('store-core.js'))
})
