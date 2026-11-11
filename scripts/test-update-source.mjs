// 锁定「在线更新已关闭」这件事，别让上游引用或 master 分支悄悄回来。
// 只做静态断言 + 纯函数调用，不碰网络，CI 与离线环境都能跑。
//
// 拆成独立用例的理由：这里的七条各自防的是不同退步——指回已删库的仓库、
// 硬编码 master 分支、把开关打开、复制清单带已删文件、启动时自动升级、
// 把 404 吞成「已是最新」。一条链只看得到第一条。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = readFileSync(join(root, 'lib/update.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const updater = await import('../lib/update.js')

// 注释里的历史说明不算，只看可执行行。
const codeLines = source
  .split(/\r?\n/)
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')

test('更新源只能是维护仓库', () => {
  assert.match(source, /const REPO = "xiuchuan666\/dsh-purge-maintained";/, 'REPO must point at the maintained repo')
  assert.match(source, /const STABLE_REF = "main";/, 'STABLE_REF must be main')
})

test('代码里不再出现已永久删库的上游', () => {
  assert.ok(!codeLines.includes('HunYiSage'), 'lib/update.js code must not reference the deleted upstream repo')
})

test('没有按 "master" 分支名硬编码的分支判断（ref 白名单除外）', () => {
  assert.ok(!/item\.ref === "master"/.test(codeLines), 'no hardcoded "master" branch comparisons')
  assert.ok(!/= "master"|: "master"/.test(codeLines), 'no "master" default refs')
})

test('在线更新开关是关的，且给出可读的替代说明', () => {
  assert.match(source, /const ONLINE_UPDATES_ENABLED = false;/, 'online updates must stay disabled')
  assert.match(source, /const UPDATES_DISABLED_MESSAGE =\s*\n?\s*"本维护仓库为私有/, 'disabled message must explain the tgz path')
})

test('自更新复制清单里没有已删除的 README', () => {
  const start = source.indexOf('const COPY_NAMES = [')
  const copyBlock = source.slice(start, source.indexOf('];', start))
  assert.ok(!copyBlock.includes('README.zh-CN.md'), 'COPY_NAMES must not list deleted README.zh-CN.md')
  assert.ok(copyBlock.includes('"README.md"'), 'COPY_NAMES must list README.md')
})

test('启动路径恒不自动升级，本地版本来自 package.json', () => {
  assert.equal(updater.localVersion(), manifest.version)
})

test('autoUpdateIfNeeded 恒返回 manual-only', async () => {
  const auto = await updater.autoUpdateIfNeeded()
  assert.equal(auto.auto, true)
  assert.equal(auto.skipped, 'manual-only')
  assert.equal(auto.hasUpdate, false)
})

test('面板更新明确失败，不把 404 / 私有仓库吞成「已是最新」', async () => {
  // 用临时 DSH_HOME 隔离状态文件，跑完恢复。
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, '.tmp-split', 'update-source-test-home')
  try {
    for (const call of ['checkUpdate', 'applyUpdate']) {
      let message = ''
      try {
        await updater[call]()
      } catch (e) {
        message = String(e && e.message ? e.message : e)
      }
      assert.ok(message.includes('在线更新不可用'), `${call} must fail with the disabled message, got: ${message || '(no error)'}`)
    }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
})
