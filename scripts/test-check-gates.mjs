import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTable, renderReport, REASONS, NOT_CHECKED } from './check-gates.mjs';

// What breaks this check:
// - it passes when the side table and the registry have drifted apart, so a patch ships with no
//   gate and nobody notices until an upgrade kills it;
// - it passes a needle that spans lines or is written as an absolute path, both of which make the
//   table machine-specific or reflow-fragile - the two failure modes a gate exists to avoid;
// - it reports PASS without saying what it did not check, so a green line reads as more than it is.

const patch = (id, name) => ({ id, name });
const row = (id, name, extra) => ({ patch: id, name, ...extra });

test('对齐时零问题，gated 计数只算有 needle 的行', () => {
  const table = { rows: [row(1, 'A', { rel: 'a/lib/i.js', line: 3, needle: 'const ALPHA = 1;' }), row(2, 'B', { reason: 'native' })] };
  const r = checkTable(table, [patch(1, 'A'), patch(2, 'B')]);
  assert.deepEqual(r.problems, []);
  assert.equal(r.stats.gated, 1);
  assert.equal(r.stats.reasonCount.gated, 1);
});

test('注册表新增了补丁而侧表没跟上 → 报缺行', () => {
  const table = { rows: [row(1, 'A', { reason: 'native' })] };
  const r = checkTable(table, [patch(1, 'A'), patch(2, 'B')]);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /patch 2 \(B\) has no row/);
});

test('侧表留着注册表已删掉的补丁 → 报孤儿行', () => {
  const table = { rows: [row(9, 'GONE', { reason: 'native' })] };
  const r = checkTable(table, []);
  assert.match(r.problems[0], /row 9 \(GONE\) has no patch/);
});

test('补丁改名了而侧表还是旧名 → 报名字不一致（读者会照旧名找错行）', () => {
  const table = { rows: [row(4, 'OLD_NAME', { reason: 'native' })] };
  const r = checkTable(table, [patch(4, 'NEW_NAME')]);
  assert.ok(r.problems.some((p) => /is named NEW_NAME but the table says OLD_NAME/.test(p)));
});

test('跨行 needle 判失败：它在下次重排时就死', () => {
  const table = { rows: [row(5, 'E', { rel: 'a/b.js', line: 1, needle: 'first line\nsecond line' })] };
  const r = checkTable(table, [patch(5, 'E')]);
  assert.ok(r.problems.some((p) => /spanning lines/.test(p)));
});

test('绝对路径判失败：侧表必须跨机器一致', () => {
  const table = { rows: [row(6, 'F', { rel: 'D:\\trees\\rc1\\a.js', line: 1, needle: 'const F = 1;' })] };
  const r = checkTable(table, [patch(6, 'F')]);
  assert.ok(r.problems.some((p) => /absolute path/.test(p)));
});

test('未知 reason 判失败，gated 缺 needle/rel/line 也判失败', () => {
  const table = { rows: [row(7, 'G', { reason: 'whatever' }), row(8, 'H', { rel: 'a/b.js', line: 2 })] };
  const r = checkTable(table, [patch(7, 'G'), patch(8, 'H')]);
  assert.ok(r.problems.some((p) => /unknown reason/.test(p)));
  assert.ok(r.problems.some((p) => /has neither a needle nor a reason/.test(p)));
});

test('报告里必须写明「这里没检查什么」', () => {
  const out = renderReport({ problems: [], warnings: [], stats: { rows: 2, patches: 2, gated: 1, reasonCount: { gated: 1, native: 1 } } });
  assert.match(out, /\[gates\] PASS/);
  assert.equal(NOT_CHECKED.length, 3);
  assert.ok(REASONS.includes('gated') && REASONS.includes('native'));
});