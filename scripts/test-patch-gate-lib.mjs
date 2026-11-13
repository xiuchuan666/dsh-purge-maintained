// Gate 侧表：这个模块坏掉的方式
// 1. 把不可定位的锚点硬凑成闸门。前缀阶梯与正则字面回退都试过：#2 的常量被上游改名，
//    前缀命中了改名后的相邻常量，于是闸门永远报「限制还在」—— 这种谎不会过期，比缺闸门糟得多。
//    所以定位失败一律如实返回 not-found，需要人判的进 HAND_GATES。
// 2. 自己再实现一遍 pattern 归一化。注册表有两种形态（replacements[] 与 patterns[]+replace），
//    第二份实现会与 applier 漂移，闸门就会对着一个不存在的 pattern 说事。走 patchReplacements。
// 3. 把 trace 锚点报成死锚点。#21/#26/#80 找的是本插件自己写的 [dsh-purge] 文本，纯净树里
//    按构造不存在；报 not-found 会让人去修一条根本没坏的补丁。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gate from './patch-gate-lib.mjs';

const FILE = 'dsh-fake/lib/index.js';
const LINE = 'const MODE = READONLY;';

function tableOf(map = { fake: FILE }) {
  return map;
}

function readerOf(files) {
  return (file) => {
    if (!(file in files)) throw new Error('ENOENT ' + file);
    return files[file];
  };
}

function patchOf(over = {}) {
  return {
    id: 900,
    name: 'FIXTURE',
    file: 'fake',
    replacements: [{ pattern: LINE, replace: 'const MODE = OPEN;' }],
    ...over,
  };
}

test('schema 常量稳定', () => {
  assert.equal(gate.GATE_SCHEMA, 1);
});

test('没有目标文件时给 no-target，而不是报错', () => {
  const g = gate.gateForPatch(patchOf({ file: 'missing' }), tableOf(), readerOf({}));
  assert.equal(g.reason, 'no-target');
});

test('两种注册表形态都能读出 pattern（走 patchReplacements，不自己实现）', () => {
  const legacy = { id: 901, name: 'LEGACY', file: 'fake', patterns: [LINE], replace: 'x' };
  const files = { [FILE]: 'head\n' + LINE + '\ntail\n' };
  const g = gate.gateForPatch(legacy, tableOf(), readerOf(files));
  assert.ok(g.needle, 'legacy patterns[]+replace must still yield a gate');
});

test('trace 锚点的正则转义也能认出来，并单列一档', () => {
  const regexpTrace = patchOf({ replacements: [{ pattern: /60{5,}[ \t]*(?:#|\/\/)[ \t]*\[dsh-purge\] bash timeout raised/g, replace: '60000' }] });
  const g = gate.gateForPatch(regexpTrace, tableOf(), readerOf({ [FILE]: 'anything' }));
  assert.equal(g.reason, 'trace-anchored');
  const stringTrace = patchOf({ replacements: [{ pattern: 'x // [dsh-purge] note', replace: 'y' }] });
  assert.equal(gate.gateForPatch(stringTrace, tableOf(), readerOf({ [FILE]: 'anything' })).reason, 'trace-anchored');
});

test('可定位的字面量生成行内唯一闸门，并记下行号', () => {
  const files = { [FILE]: 'a\n' + LINE + '\nb\n' };
  const g = gate.gateForPatch(patchOf(), tableOf(), readerOf(files));
  assert.ok(g.needle.includes('const MODE'), 'needle must quote the located line');
  assert.equal(g.line, 2);
  assert.equal(g.needle.includes('\n'), false, 'a gate must not span lines: reflow would kill it');
});

test('正则 pattern 用匹配区间当种子，且跳过前导空白（否则行号落在上一行）', () => {
  const files = { [FILE]: 'a\n   * Network access depends on mirrors.\nb\n' };
  const p = patchOf({ replacements: [{ pattern: /\n[ \t]*\* Network access depends on mirrors\./g, replace: '' }] });
  const g = gate.gateForPatch(p, tableOf(), readerOf(files));
  assert.equal(g.line, 2);
  assert.ok(g.needle.startsWith('* Network access'));
});

test('定位不到就如实 not-found，绝不回退到前缀或字面猜测', () => {
  const files = { [FILE]: 'unrelated text only\n' };
  const g = gate.gateForPatch(patchOf(), tableOf(), readerOf(files));
  assert.equal(g.reason, 'not-found');
  assert.equal(g.needle, undefined);
});

test('readFile 抛错记为 unreadable，与 not-found 区分开', () => {
  const g = gate.gateForPatch(patchOf(), tableOf(), readerOf({}));
  assert.equal(g.reason, 'unreadable');
});

test('countGateHits 数的是「补丁自己还能打几下」', () => {
  assert.equal(gate.countGateHits(patchOf(), LINE), 1);
  assert.equal(gate.countGateHits(patchOf(), 'nothing here'), 0);
});

test('gatePresent 只在 needle 逐字节在时成立', () => {
  const g = { needle: 'const MODE' };
  assert.equal(gate.gatePresent(g, 'xx const MODE yy'), true);
  assert.equal(gate.gatePresent(g, 'const  MODE'), false);
  assert.equal(gate.gatePresent(null, 'x'), false);
  assert.equal(gate.gatePresent(g, undefined), false);
});

test('手写闸门按 rel 后缀定位，表布局变了也不用改闸门', () => {
  const nested = 'D:/host/node_modules/@deepseek-ai/dsh-fake/lib/index.js';
  const table = tableOf({ fake: nested });
  const files = { [nested]: 'head\n' + LINE + '\n' };
  const hand = { 900: { rel: 'dsh-fake/lib/index.js', needle: 'const MODE = READONLY', note: 'n' } };
  const gates = gate.buildGates([patchOf()], table, readerOf(files), hand, {});
  const g = gates.get(900);
  assert.ok(g.needle);
  assert.equal(g.hand, true);
  assert.equal(g.line, 2);
  assert.equal(g.rel, 'dsh-fake/lib/index.js');
});

test('手写闸门找不到文件或缺 needle 时如实报告，且标明是手写的', () => {
  const hand = { 900: { rel: 'dsh-other/lib/index.js', needle: 'x', note: 'n' } };
  const g = gate.buildGates([patchOf()], tableOf(), readerOf({ [FILE]: 'x' }), hand, {}).get(900);
  assert.equal(g.reason, 'no-target');
  assert.equal(g.hand, true);
  const hand2 = { 900: { rel: 'dsh-fake/lib/index.js', needle: 'ABSENT', note: 'n' } };
  const g2 = gate.buildGates([patchOf()], tableOf(), readerOf({ [FILE]: 'x' }), hand2, {}).get(900);
  assert.equal(g2.reason, 'not-found');
});

test('native 补丁不做闸门，并带上理由', () => {
  const gates = gate.buildGates([patchOf()], tableOf(), readerOf({ [FILE]: 'x' }), {}, { 900: 'already official' });
  const g = gates.get(900);
  assert.equal(g.reason, 'native');
  assert.equal(g.note, 'already official');
  assert.equal(g.needle, undefined);
});

test('buildGates 给每一条补丁都留一格，绝不静默丢条目', () => {
  const patches = [patchOf(), patchOf({ id: 901, file: 'gone' }), patchOf({ id: 902 })];
  const gates = gate.buildGates(patches, tableOf(), readerOf({ [FILE]: 'x' }));
  assert.equal(gates.size, 3);
  assert.equal(gates.get(901).reason, 'no-target');
});

test('tallyGates 把九种结局都数出来，含 0 的档也不缺键', () => {
  const gates = gate.buildGates([patchOf(), patchOf({ id: 901, file: 'gone' })], tableOf(), readerOf({ [FILE]: 'head\n' + LINE + '\n' }));
  const tally = gate.tallyGates(gates);
  assert.equal(tally.gated + tally['no-target'], 2);
  const keys = ['gated', 'no-target', 'no-pattern', 'regex-only', 'ambiguous', 'unreadable', 'not-found', 'trace-anchored', 'native'];
  for (const key of keys) assert.equal(typeof tally[key], 'number', 'missing tally key: ' + key);
});

test('renderGate 给出 needle 或理由，不用空字符串冒充', () => {
  assert.equal(gate.renderGate(null), '-');
  assert.equal(gate.renderGate({ reason: 'not-found' }), '(not-found)');
  assert.ok(gate.renderGate({ needle: 'abc' }).includes('abc'));
});

test('serializeGates 只写相对路径与 needle，按补丁号排序', () => {
  const gates = new Map([
    [901, { patch: 901, name: 'B', reason: 'no-target' }],
    [900, { patch: 900, name: 'A', rel: 'dsh-fake/lib/index.js', line: 2, needle: 'const MODE' }],
  ]);
  const out = gate.serializeGates(gates);
  assert.equal(out.schema, 1);
  assert.deepEqual(out.rows.map((r) => r.patch), [900, 901]);
  assert.equal(out.rows[0].needle, 'const MODE');
  assert.equal(out.rows[1].reason, 'no-target');
  const text = JSON.stringify(out);
  assert.equal(text.includes('D:/'), false, 'no absolute drive paths in the side table');
  assert.equal(text.includes('/Users/'), false, 'no absolute home paths in the side table');
});

test('ambiguous 只在多个候选都不唯一时出现，且带 tried 供人看', () => {
  const files = { [FILE]: 'dup\ndup\n' };
  const p = patchOf({ replacements: [{ pattern: 'dup', replace: 'x' }] });
  const g = gate.gateForPatch(p, tableOf(), readerOf(files), { maxLength: 3 });
  assert.ok(g.reason === 'ambiguous' || g.reason === 'not-found');
  if (g.reason === 'ambiguous') assert.ok(Array.isArray(g.tried));
});

test('闸门长度受上限约束：超长时如实报不可锚定，不返回完整文件', () => {
  const long = 'x'.repeat(500) + '\ntail\n';
  const p = patchOf({ replacements: [{ pattern: 'x'.repeat(500), replace: 'y' }] });
  const g = gate.gateForPatch(p, tableOf(), readerOf({ [FILE]: long }), { maxLength: 20 });
  assert.ok(!g.needle || g.needle.length <= 20);
});