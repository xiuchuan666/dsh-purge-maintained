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

import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'

// ------------------------------------------------------------ 导出面

assert.equal(plugin.name, 'dsh-purge')

// 不要把 pluginPackages 写进 inject：便携拷贝 / Hub 残装没有这项服务，
// 一写进去就是 pending → 宿主退出码 1。
assert.deepEqual(plugin.inject, ['systemPrompt', 'tools'])

assert.deepEqual(
  Object.keys(plugin).sort(),
  ['BOOLEAN_CONFIG_KEYS', 'apply', 'default', 'inject', 'name', 'normalizeConfig', 'registerPromptSections'],
  '导出面变了：宿主与 lib/ 内部都按名字取用，少一个就崩',
)
for (const key of ['apply', 'registerPromptSections', 'normalizeConfig']) {
  assert.equal(typeof plugin[key], 'function', `${key} 必须是函数`)
}

// ------------------------------------------------------------ 配置面

// DEFAULTS 刻意不导出（宿主要的是 normalizeConfig 的结果，不是半成品默认值）。
assert.equal('DEFAULTS' in plugin, false, 'DEFAULTS 不该被导出')

const defaults = plugin.normalizeConfig()
assert.equal(Object.keys(defaults).length, 18, '配置键数量变了')
assert.deepEqual(Object.keys(defaults).sort(), [
  'anchorMode', 'autoApplyOnStart', 'autoContinue', 'autoRetry', 'autoRevertOnMissing',
  'autoUpdateOnStart', 'capabilityProtocol', 'continueMax', 'continueText', 'enabled',
  'hooksDenyBypass', 'injectOnce', 'postPrompt', 'postPromptOrder', 'retryMax',
  'stripMnemon', 'subagentControl', 'verbose',
])

// 空参、undefined、null 都要得到同一份默认值。
assert.deepEqual(plugin.normalizeConfig(undefined), defaults)
assert.deepEqual(plugin.normalizeConfig(null), defaults)
assert.deepEqual(plugin.normalizeConfig({}), defaults)

// 12 个布尔键必须与 BOOLEAN_CONFIG_KEYS 完全一致——两个清单不能各说各话。
assert.equal(plugin.BOOLEAN_CONFIG_KEYS.length, 12)
assert.deepEqual(plugin.BOOLEAN_CONFIG_KEYS, [
  'enabled', 'autoApplyOnStart', 'autoUpdateOnStart', 'autoRevertOnMissing',
  'injectOnce', 'stripMnemon', 'verbose', 'autoRetry', 'autoContinue',
  'capabilityProtocol', 'hooksDenyBypass', 'subagentControl',
])
for (const key of plugin.BOOLEAN_CONFIG_KEYS) {
  assert.equal(typeof defaults[key], 'boolean', `${key} 的默认值必须是布尔`)
}

// 字符串布尔收敛：这是真事故——YAML 里写 "false" 会被 JS 当真值，两个默认
// 开启的开关于是关不掉。四个否定词、大小写、前后空白都要覆盖。
for (const falsy of ['false', 'FALSE', 'False', '0', 'no', 'off', '  false  ', 'OFF']) {
  assert.equal(plugin.normalizeConfig({ enabled: falsy }).enabled, false, `enabled=${JSON.stringify(falsy)} 应解析为 false`)
}
for (const truthy of ['true', '1', 'yes', 'on', 'anything']) {
  assert.equal(plugin.normalizeConfig({ enabled: truthy }).enabled, true, `enabled=${JSON.stringify(truthy)} 应解析为 true`)
}
// 非字符串的布尔值原样保留，不被字符串化。
assert.equal(plugin.normalizeConfig({ enabled: true }).enabled, true)
assert.equal(plugin.normalizeConfig({ enabled: false }).enabled, false)
// 只收敛布尔键，其他键不动。
assert.equal(plugin.normalizeConfig({ retryMax: 'false' }).retryMax, 'false')

// ------------------------------------------------------------ 现状锁定（非期望行为）

// 以下三条都不是「正确」，是「现在是这个样」。锁住的目的是让未来的改动
// 必须显式面对它们：如果谁改成校验、trim、枚举约束，这个测试会红，那时
// 应该连同 README 的配置说明一起改，而不是顺手把断言改掉。

// 1. 数值键不做字符串转数字。{ retryMax: "9" } 会以字符串形式流到下游。
assert.equal(plugin.normalizeConfig({ retryMax: '9' }).retryMax, '9')

// 2. anchorMode 没有枚举校验：写 "bogus" 会原样透传（消费侧只认 "off"，
//    其余一律当自动，见 lib/anchor.js）。
assert.equal(plugin.normalizeConfig({ anchorMode: 'bogus' }).anchorMode, 'bogus')

// 3. continueText 不 trim：首尾空白原样保留。
assert.equal(plugin.normalizeConfig({ continueText: '   ' }).continueText, '   ')

console.log('plugin surface PASS')
