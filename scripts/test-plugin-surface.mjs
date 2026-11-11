// lib/index.js 的插件面契约测试。
//
// 它是整个插件唯一被宿主直接读取的模块（宿主读 name / inject，用户读
// normalizeConfig 的返回值），却一直是覆盖率 0%——本轮之前没有任何测试
// import 过它。这里只锁「不能再少」的那部分：
//
//   1. 7 个 export 的名字与 inject 内容不能变，宿主靠它们装配。
//   2. normalizeConfig() 必须返回完整 18 键（DEFAULTS 本身不是 export）。
//   3. YAML 里写成字符串的布尔必须收敛成布尔——这条有真实事故背景，
//      见 BOOLEAN_CONFIG_KEYS 上方的注释。
//
// 另外三条是「现状锁定，非期望行为」。它们现在都不是我们想要的语义，但
// 改它们是产品决策（会让用户已有的配置在升级后换一种解释），不属于测试
// 机制这一轮。先钉住，免得哪天悄悄变了都没人知道。
//
// 拆成独立 test()：导出面、配置面、布尔收敛、三条现状锁定是四类互不相干的
// 事实。合成一条链时，导出面一红后面全都不跑，看不出配置面是不是也坏了——
// 而「宿主读不到 normalizeConfig」和「某个默认值变了」需要的处理完全不同。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'

const DEFAULTS = plugin.normalizeConfig()

// ------------------------------------------------------------ 导出面

test('插件的 name 与 inject 不能变（宿主按它们装配）', () => {
  assert.equal(plugin.name, 'dsh-purge')

  // 不要把 pluginPackages 写进 inject：便携拷贝 / Hub 残装没有这项服务，
  // 一写进去就是 pending → 宿主退出码 1。
  assert.deepEqual(plugin.inject, ['systemPrompt', 'tools'])
})

test('导出面：7 个名字一个不能少，也不能多', () => {
  assert.deepEqual(
    Object.keys(plugin).sort(),
    ['BOOLEAN_CONFIG_KEYS', 'apply', 'default', 'inject', 'name', 'normalizeConfig', 'registerPromptSections'],
    '导出面变了：宿主与 lib/ 内部都按名字取用，少一个就崩',
  )
  for (const key of ['apply', 'registerPromptSections', 'normalizeConfig']) {
    assert.equal(typeof plugin[key], 'function', `${key} 必须是函数`)
  }
})

test('DEFAULTS 刻意不导出：宿主要的是 normalizeConfig 的结果，不是半成品默认值', () => {
  assert.equal('DEFAULTS' in plugin, false, 'DEFAULTS 不该被导出')
})

// ------------------------------------------------------------ 配置面

test('normalizeConfig() 返回完整 18 键', () => {
  assert.equal(Object.keys(DEFAULTS).length, 18, '配置键数量变了')
  assert.deepEqual(Object.keys(DEFAULTS).sort(), [
    'anchorMode', 'autoApplyOnStart', 'autoContinue', 'autoRetry', 'autoRevertOnMissing',
    'autoUpdateOnStart', 'capabilityProtocol', 'continueMax', 'continueText', 'enabled',
    'hooksDenyBypass', 'injectOnce', 'postPrompt', 'postPromptOrder', 'retryMax',
    'stripMnemon', 'subagentControl', 'verbose',
  ])
})

test('空参、undefined、null 都得到同一份默认值', () => {
  assert.deepEqual(plugin.normalizeConfig(undefined), DEFAULTS)
  assert.deepEqual(plugin.normalizeConfig(null), DEFAULTS)
  assert.deepEqual(plugin.normalizeConfig({}), DEFAULTS)
})

// 上一条只比「三种空参互相一致」，不比「值是什么」：把 enabled 默认从 true 改成
// false，18 键、类型、布尔收敛全都不受影响，测试一片绿。这类改动正是最需要被
// 看见的（用户在升级后会突然发现功能默认关掉了），所以默认值本身要逐项钉住。
test('18 个默认值逐个锁定（改任何一个都必须显式改这份清单）', () => {
  assert.deepEqual(DEFAULTS, {
    enabled: true,
    autoApplyOnStart: false,
    autoUpdateOnStart: false,
    autoRevertOnMissing: false,
    injectOnce: false,
    stripMnemon: true,
    postPrompt: '',
    postPromptOrder: 5100,
    verbose: false,
    autoRetry: true,
    retryMax: 3,
    autoContinue: false,
    continueMax: 3,
    continueText: '继续',
    capabilityProtocol: true,
    hooksDenyBypass: true,
    anchorMode: 'auto',
    subagentControl: true,
  })
})

test('BOOLEAN_CONFIG_KEYS 与布尔默认值必须对齐（两个清单不能各说各话）', () => {
  assert.equal(plugin.BOOLEAN_CONFIG_KEYS.length, 12)
  assert.deepEqual(plugin.BOOLEAN_CONFIG_KEYS, [
    'enabled', 'autoApplyOnStart', 'autoUpdateOnStart', 'autoRevertOnMissing',
    'injectOnce', 'stripMnemon', 'verbose', 'autoRetry', 'autoContinue',
    'capabilityProtocol', 'hooksDenyBypass', 'subagentControl',
  ])
  for (const key of plugin.BOOLEAN_CONFIG_KEYS) {
    assert.equal(typeof DEFAULTS[key], 'boolean', `${key} 的默认值必须是布尔`)
  }
})

// ------------------------------------------------------------ 字符串布尔收敛

// 这是真事故：YAML 里写 "false" 会被 JS 当真值，两个默认开启的开关于是关不掉。
test('字符串布尔收敛成 false：四个否定词、大小写、前后空白都要覆盖', () => {
  for (const falsy of ['false', 'FALSE', 'False', '0', 'no', 'off', '  false  ', 'OFF']) {
    assert.equal(
      plugin.normalizeConfig({ enabled: falsy }).enabled,
      false,
      `enabled=${JSON.stringify(falsy)} 应解析为 false`,
    )
  }
})

test('字符串布尔收敛成 true：可识别的真值与任意非空字符串', () => {
  for (const truthy of ['true', '1', 'yes', 'on', 'anything']) {
    assert.equal(
      plugin.normalizeConfig({ enabled: truthy }).enabled,
      true,
      `enabled=${JSON.stringify(truthy)} 应解析为 true`,
    )
  }
})

test('非字符串的布尔值原样保留，不被字符串化', () => {
  assert.equal(plugin.normalizeConfig({ enabled: true }).enabled, true)
  assert.equal(plugin.normalizeConfig({ enabled: false }).enabled, false)
})

test('只收敛布尔键，其他键不动', () => {
  assert.equal(plugin.normalizeConfig({ retryMax: 'false' }).retryMax, 'false')
})

// ------------------------------------------------------------ 现状锁定（非期望行为）

// 以下三条都不是「正确」，是「现在是这个样」。锁住的目的是让未来的改动
// 必须显式面对它们：如果谁改成校验、trim、枚举约束，这个测试会红，那时
// 应该连同 README 的配置说明一起改，而不是顺手把断言改掉。

test('现状锁定：数值键不做字符串转数字，{retryMax:"9"} 以字符串流到下游', () => {
  assert.equal(plugin.normalizeConfig({ retryMax: '9' }).retryMax, '9')
})

test('现状锁定：anchorMode 没有枚举校验，"bogus" 原样透传（消费侧只认 "off"）', () => {
  assert.equal(plugin.normalizeConfig({ anchorMode: 'bogus' }).anchorMode, 'bogus')
})

test('现状锁定：continueText 不 trim，首尾空白原样保留', () => {
  assert.equal(plugin.normalizeConfig({ continueText: '   ' }).continueText, '   ')
})

console.log('plugin surface PASS')
