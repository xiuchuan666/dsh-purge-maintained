import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VERIFY_SCHEMA, VERIFY_STATES, tableVersion, rowsToVerify, verifyGates, notableRows, renderGateVerify,
} from './gate-verify-lib.mjs';

// HOW THIS MODULE BREAKS
// 1. A missing needle on a DIFFERENT version is expected drift; treating it as a failure makes the
//    command red every time dshTarget moves, and a red command gets ignored.
// 2. A missing needle on the SAME version is real: table and tree are supposed to describe each
//    other. If it never shows up, the table is silently older than the tree it was committed with.
// 3. Skipped rows (no needle, only a reason) must not be counted as present, or the denominator lies.

const tableOf = (rows, version) => ({ schema: 1, kind: 'dsh-patch-gates', tree: { version: version }, rows: rows });

const readFrom = (files) => (rel) => (Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null);

test('schema is a stable number and the state words are the four we render', () => {
  assert.equal(VERIFY_SCHEMA, 1);
  assert.deepEqual(Object.values(VERIFY_STATES).sort(), ['missing', 'present', 'skipped', 'unreadable']);
});

test('tableVersion reads the pinned version, and says so when the table predates the field', () => {
  assert.equal(tableVersion(tableOf([], '0.2.2-rc.1')), '0.2.2-rc.1');
  assert.equal(tableVersion({ rows: [] }), 'unknown');
  assert.equal(tableVersion(null), 'unknown');
});

test('rowsToVerify keeps only rows that carry a needle', () => {
  const rows = rowsToVerify(tableOf([
    { patch: 1, needle: 'abc' },
    { patch: 2, reason: 'native' },
    { patch: 3, needle: '' },
  ], 'v'));
  assert.deepEqual(rows.map((r) => r.patch), [1]);
});

test('a needle that is still in the file counts as present', () => {
  const table = tableOf([{ patch: 7, name: 'SEVEN', rel: 'pkg/lib/index.js', line: 3, needle: 'const MODE = READONLY;' }], '0.2.2-rc.1');
  const result = verifyGates(table, { dir: '/t', version: '0.2.2-rc.1', readFile: readFrom({ 'pkg/lib/index.js': 'a' + String.fromCharCode(10) + 'const MODE = READONLY;' + String.fromCharCode(10) }) });
  assert.equal(result.tally.present, 1);
  assert.equal(result.tally.missing, 0);
  assert.equal(result.rows[0].state, 'present');
  assert.equal(result.drift, false);
});

test('a needle gone on a different version is drift, and drift is a number, not a failure', () => {
  const table = tableOf([{ patch: 13, name: 'ESCALATION', rel: 'pkg/lib/index.js', line: 140, needle: 'throw new Error(' }], '0.2.2-rc.1');
  const result = verifyGates(table, { dir: '/t', version: '0.2.2-rc.2', readFile: readFrom({ 'pkg/lib/index.js': 'throw new SandboxEscalationError(' }) });
  assert.equal(result.tally.missing, 1);
  assert.equal(result.drift, true);
  assert.equal(result.rows[0].state, 'missing');
});

test('the same missing needle on the pinned version is not drift - it is a stale table', () => {
  const table = tableOf([{ patch: 13, name: 'ESCALATION', rel: 'pkg/lib/index.js', needle: 'gone' }], '0.2.2-rc.2');
  const result = verifyGates(table, { dir: '/t', version: '0.2.2-rc.2', readFile: readFrom({ 'pkg/lib/index.js': 'other' }) });
  assert.equal(result.tally.missing, 1);
  assert.equal(result.drift, false);
  const lines = renderGateVerify(result, { limit: 5 });
  assert.ok(lines.some((l) => l.indexOf('re-derive') < 0), 'no re-derive banner when the versions agree');
  assert.ok(lines.some((l) => l.indexOf('#13') >= 0), 'the stale row is printed');
});

test('a file missing from this tree is unreadable, not missing - different problem, different fix', () => {
  const table = tableOf([
    { patch: 45, name: 'DESKTOP', rel: 'lib/main.js', needle: 'x' },
    { patch: 46, name: 'ALSO', rel: 'dsh-pkg/lib/index.js', needle: 'y' },
  ], 'v');
  const result = verifyGates(table, { dir: '/t', version: 'v', readFile: readFrom({ 'dsh-pkg/lib/index.js': 'y' }) });
  assert.equal(result.tally.unreadable, 1);
  assert.equal(result.tally.present, 1);
  assert.equal(result.rows[0].state, 'unreadable');
  assert.match(result.rows[0].reason, /not in this tree/);
});

test('skipped rows are counted apart so the gated denominator stays honest', () => {
  const table = tableOf([
    { patch: 2, name: 'NATIVE', reason: 'native' },
    { patch: 3, name: 'ALSO', reason: 'no-target' },
    { patch: 4, name: 'GATED', rel: 'f.js', needle: 'n' },
  ], 'v');
  const result = verifyGates(table, { dir: '/t', version: 'v', readFile: readFrom({ 'f.js': 'n' }) });
  assert.equal(result.tally.skipped, 2);
  assert.equal(result.tally.present, 1);
  assert.deepEqual(result.rows.filter((r) => r.state === 'skipped').map((r) => r.patch), [2, 3]);
});

test('rowsToVerify and verifyGates agree about what a gate is', () => {
  const table = tableOf([{ patch: 1, needle: 'aaa' }, { patch: 2, reason: 'native' }], 'v');
  const result = verifyGates(table, { dir: '/t', version: 'v', readFile: readFrom({}) });
  assert.equal(rowsToVerify(table).length, result.tally.present + result.tally.missing + result.tally.unreadable);
});

test('notableRows prints only what needs a look, and honours the limit', () => {
  const table = tableOf([
    { patch: 1, rel: 'a.js', needle: 'x' },
    { patch: 2, rel: 'b.js', needle: 'y' },
    { patch: 3, rel: 'c.js', needle: 'z' },
  ], 'v');
  const result = verifyGates(table, { dir: '/t', version: 'v', readFile: readFrom({ 'a.js': 'x' }) });
  assert.deepEqual(notableRows(result, { limit: 10 }).map((r) => r.patch), [2, 3]);
  assert.equal(notableRows(result, { limit: 1 }).length, 1);
});

test('the header states the pin and the drift banner appears only when versions differ', () => {
  const rows = [{ patch: 1, name: 'ONE', rel: 'a.js', line: 1, needle: 'x' }];
  const same = verifyGates(tableOf(rows, '0.2.2-rc.1'), { dir: '/t', version: '0.2.2-rc.1', readFile: readFrom({ 'a.js': 'x' }) });
  const sameLines = renderGateVerify(same);
  assert.ok(sameLines[0].indexOf('pinned to 0.2.2-rc.1') >= 0);
  assert.ok(!sameLines.some((l) => l.indexOf('re-derive') >= 0));
  const drift = verifyGates(tableOf(rows, '0.2.2-rc.1'), { dir: '/t', version: '0.2.2-rc.2', readFile: readFrom({ 'a.js': 'y' }) });
  const driftLines = renderGateVerify(drift);
  assert.ok(driftLines.some((l) => l.indexOf('re-derive when you bump dshTarget') >= 0));
  assert.ok(driftLines.some((l) => l.indexOf('missing 1') >= 0));
});

test('a table with no tree block renders as version unrecorded instead of crashing', () => {
  const result = verifyGates({ rows: [{ patch: 1, rel: 'a.js', needle: 'x' }] }, { dir: '/t', version: '0.2.2-rc.1', readFile: readFrom({ 'a.js': 'x' }) });
  assert.equal(result.tableVersion, 'unknown');
  assert.equal(result.drift, false);
  assert.ok(renderGateVerify(result)[0].indexOf('version unrecorded') >= 0);
});

test('a null readFile is treated as an empty tree, never as a match', () => {
  const result = verifyGates(tableOf([{ patch: 1, rel: 'a.js', needle: 'x' }], 'v'), { version: 'v' });
  assert.equal(result.tally.unreadable, 1);
  assert.equal(result.tally.present, 0);
});