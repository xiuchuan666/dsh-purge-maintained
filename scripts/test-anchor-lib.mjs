// 锚点计算：这个模块坏掉的方式
// 1. 返回一个不唯一的锚点。补丁会打在第一个匹配位置上，看起来成功，实际改了别处。
//    所以 shortestUniqueAnchor 只在 occurrences === 1 时返回 unique: true，否则如实说 false。
// 2. 返回的锚点带首尾空白差异。CRLF 文件里行尾是 \r\n，锚点若含 \r，用 \n 写的 pattern 永远不中。
//    所以 tighten 先把两端空白削掉，anchorForLine 也把行尾 \r 剥掉。
// 3. 每次跑出不同长度。增长顺序固定（先右后左，逐字符），同一输入必须同一锚点。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lib from './anchor-lib.mjs';

const SRC = [
  'line one',
  'const mode = "read-only";',
  'if (mode === "read-only") {',
  '  return deny();',
  '}',
].join('\n');

test('occurrences 从左到右不重叠', () => {
  assert.deepEqual(lib.occurrences('aaaa', 'aa'), [0, 2]);
  assert.deepEqual(lib.occurrences('abc', 'z'), []);
  assert.deepEqual(lib.occurrences('abc', ''), []);
  assert.deepEqual(lib.occurrences(null, 'a'), []);
});

test('isUnique 只认恰好一次', () => {
  assert.equal(lib.isUnique(SRC, 'const mode'), true);
  assert.equal(lib.isUnique(SRC, 'mode'), false);
});

test('lineRangeAt 给出不含行尾的范围，CRLF 也不带 \\r', () => {
  const r = lib.lineRangeAt(SRC, 2);
  assert.equal(r.text, 'const mode = "read-only";');
  assert.equal(SRC.slice(r.start, r.end), r.text);
  const crlf = lib.lineRangeAt('a\r\nb\r\n', 1);
  assert.equal(crlf.text, 'a');
  assert.equal(lib.lineRangeAt(SRC, 99), null);
  assert.equal(lib.lineRangeAt(SRC, 0), null);
});

test('lineOfIndex 把偏移换算成 1 基行号', () => {
  assert.equal(lib.lineOfIndex(SRC, 0), 1);
  assert.equal(lib.lineOfIndex(SRC, SRC.indexOf('const')), 2);
  assert.equal(lib.lineOfIndex(SRC, SRC.indexOf('return')), 4);
});

test('shortestUniqueAnchor 用最短窗口做到唯一', () => {
  const range = lib.lineRangeAt(SRC, 4);
  const r = lib.shortestUniqueAnchor(SRC, range.start, range.end);
  assert.equal(r.unique, true);
  assert.equal(lib.occurrences(SRC, r.anchor).length, 1);
  // 必须覆盖该行的实质内容（trim 后的核心），否则锚点指的就不是这一行；
  // 两端的空白会被削掉，所以不能拿含空白的整行范围来断言。
  assert.ok(r.anchor.includes(range.text.trim()));
  assert.ok(r.anchor.length < 40, 'should not swallow the file');
});

test('两行完全相同时如实返回 unique: false，而不是硬凑一个', () => {
  const dup = 'same();\nsame();\n';
  const line = lib.lineRangeAt(dup, 1);
  const r = lib.shortestUniqueAnchor(dup, line.start, line.end, { maxLength: 6 });
  assert.equal(r.unique, false);
  assert.equal(r.slack, 0);
});

test('增长顺序固定：同一输入两次调用得到同一锚点', () => {
  const a = lib.anchorForLine(SRC, 3);
  const b = lib.anchorForLine(SRC, 3);
  assert.equal(a.anchor, b.anchor);
  assert.equal(a.slack, b.slack);
});

test('slack 表示还差多少字符就撞上重复，是「下个版本还活不活」的指标', () => {
  const r = lib.anchorForLine(SRC, 2);
  assert.equal(r.slack, lib.DEFAULT_MAX_ANCHOR - r.anchor.length);
  assert.ok(r.slack > 0);
});

test('两端的空白被削掉，锚点不以空格或换行开头', () => {
  const src = 'head\n    indented_call();\n tail\n';
  const r = lib.anchorForLine(src, 2);
  assert.equal(r.anchor.startsWith(' '), false);
  assert.equal(r.anchor.endsWith(' '), false);
  assert.equal(r.unique, true);
});

test('anchorReport 报出冲突次数与所在行，用来解释为什么不能打', () => {
  const rep = lib.anchorReport(SRC, 'mode');
  assert.equal(rep.count, 2);
  assert.deepEqual(rep.lines, [2, 3]);
});

test('renderAnchor 把制表符与换行显形', () => {
  assert.equal(lib.renderAnchor('a\tb'), 'a\\tb');
  assert.equal(lib.renderAnchor('a\nb'), 'a\\nb');
  assert.ok(lib.renderAnchor('x'.repeat(200), { width: 10 }).length <= 10);
});

test('anchorForLine 对越界行返回 null 而不是抛错', () => {
  assert.equal(lib.anchorForLine(SRC, 999), null);
});