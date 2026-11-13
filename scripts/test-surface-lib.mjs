// Surface descriptions: the tests exist because a diff is only useful if it is quiet about things
// that did not change.
//
// Three ways this module breaks, all covered below:
// 1. describing values by identity - two Config schemas are never ===, so everything looks changed;
// 2. describing functions by source text - every rewording shows up and buries the real change;
// 3. throwing on one hostile export and blanking the whole package.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as lib from './surface-lib.mjs';

test('schema is stable', () => {
  assert.equal(lib.SURFACE_SCHEMA, 1);
});

test('describeValue describes by shape, never by identity', () => {
  assert.equal(lib.describeValue(null), 'null');
  assert.equal(lib.describeValue('x'), 'string');
  assert.equal(lib.describeValue(3), 'number');
  assert.equal(lib.describeValue(undefined), 'undefined');
  assert.equal(lib.describeValue([1, 2, 3]), 'array/3');
  assert.equal(lib.describeValue(function two(a, b) {}), 'function/2');
  assert.equal(lib.describeValue(class Thing { constructor(a) { this.a = a; } }), 'class/1');
  // Two schema functions with the same arity read the same, which is the point: a Config object
  // built fresh on every load must not look like a change.
  const a = (v) => v;
  const b = (v) => v;
  assert.notEqual(a, b);
  assert.equal(lib.describeValue(a), lib.describeValue(b));
  // `length` is writable on a function, and a library that mocks one (a proxy wrapper, a bundler
  // shim) can hand us a non-integer. Without the guard the descriptor reads 'function/x' or
  // 'function/1.5', which never equals another load's answer and turns every diff into noise.
  const odd = function oddity() {};
  Object.defineProperty(odd, 'length', { value: 'x', configurable: true });
  assert.equal(lib.describeValue(odd), 'function/0');
  const half = function halfway() {};
  Object.defineProperty(half, 'length', { value: 1.5, configurable: true });
  assert.equal(lib.describeValue(half), 'function/0');
});

test('describeValue summarises object keys and caps the list', () => {
  assert.equal(lib.describeValue({}), 'object');
  assert.equal(lib.describeValue({ b: 1, a: 2 }), 'object{a,b}');
  const wide = {};
  for (const key of ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8']) wide[key] = 1;
  assert.equal(lib.describeValue(wide), 'object{k1,k2,k3,k4,k5,k6,+2}');
  assert.equal(lib.describeValue({ a: { b: 1 } }, 1), 'object');
});

test('describeValue degrades instead of throwing on a hostile object', () => {
  const hostile = new Proxy({}, { ownKeys() { throw new Error('nope'); } });
  assert.equal(lib.describeValue(hostile), 'object');
});

test('describeExport gives a class its statics and prototype surface', () => {
  class Service {
    constructor() {}
    start() {}
    stop() {}
    static create() {}
  }
  const described = lib.describeExport(Service);
  assert.equal(described.kind, 'class/0');
  assert.deepEqual(described.statics, ['create']);
  assert.deepEqual(described.proto, ['start', 'stop']);
  // name/length/prototype are noise on every function; 'constructor' is noise on every prototype.
  assert.equal(described.statics.includes('length'), false);
  assert.equal(described.proto.includes('constructor'), false);
});

test('describeExport lists object keys but not arrays', () => {
  assert.deepEqual(lib.describeExport({ b: 1, a: 2 }).keys, ['a', 'b']);
  assert.equal(lib.describeExport([1, 2]).keys, undefined);
  assert.equal(lib.describeExport('text').keys, undefined);
});

test('describeModule skips default and survives an export that throws when read', () => {
  const mod = { alpha: 1, beta: () => {} };
  Object.defineProperty(mod, 'default', { enumerable: true, get() { return 'x'; } });
  Object.defineProperty(mod, 'bad', { enumerable: true, get() { throw new Error('boom'); } });
  const described = lib.describeModule(mod);
  assert.deepEqual(Object.keys(described).sort(), ['alpha', 'bad', 'beta']);
  assert.deepEqual(described.bad, { kind: 'unreadable' });
  assert.equal(described.alpha.kind, 'number');
});

test('diffSurface reports added, removed and kind changes', () => {
  const before = { gone: { kind: 'function/1' }, keeper: { kind: 'string' } };
  const after = { keeper: { kind: 'number' }, fresh: { kind: 'class/2' } };
  assert.deepEqual(lib.diffSurface(before, after), [
    { name: 'fresh', change: 'added', detail: 'class/2' },
    { name: 'gone', change: 'removed', detail: 'function/1' },
    { name: 'keeper', change: 'kind', detail: 'string -> number' },
  ]);
});

test('diffSurface reports added and removed statics and prototype methods', () => {
  const before = { S: { kind: 'class/0', statics: ['a'], proto: ['x', 'y'] } };
  const after = { S: { kind: 'class/0', statics: ['a', 'b'], proto: ['y', 'z'] } };
  assert.deepEqual(lib.diffSurface(before, after), [
    { name: 'S', change: 'statics', detail: '+b' },
    { name: 'S', change: 'proto', detail: '+z -x' },
  ]);
});

test('diffSurface is silent when only the function body changed', () => {
  // Failure mode 2: a patch that rewords a sentence inside a body must not show up as a surface
  // change, or the real ones drown. Arity is all we compare.
  const before = { run: lib.describeExport(function run() { return 'old wording'; }) };
  const after = { run: lib.describeExport(function run() { return 'new wording'; }) };
  assert.deepEqual(lib.diffSurface(before, after), []);
});

test('diffSurface forgets nothing when the two sides are identical data', () => {
  const shape = { A: { kind: 'class/0', statics: [], proto: ['m'] }, o: { kind: 'object', keys: ['k'] } };
  assert.deepEqual(lib.diffSurface(shape, JSON.parse(JSON.stringify(shape))), []);
});

test('sign caps long deltas so one wide object cannot flood the report', () => {
  const before = { o: { kind: 'object', keys: [] } };
  const after = { o: { kind: 'object', keys: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] } };
  const rows = lib.diffSurface(before, after);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail, '+a,b,c,d,e,f,g,h,+2');
});

test('tallySurfaces counts changed, unchanged and unreadable separately', () => {
  const packages = [
    { pkg: 'a', rows: [{ name: 'x' }, { name: 'y' }] },
    { pkg: 'b', rows: [] },
    { pkg: 'c', rows: [], error: 'not in baseline' },
  ];
  assert.deepEqual(lib.tallySurfaces(packages), { packages: 3, changed: 1, unchanged: 1, unreadable: 1, rows: 2 });
  assert.deepEqual(lib.tallySurfaces([]), { packages: 0, changed: 0, unchanged: 0, unreadable: 0, rows: 0 });
});

test('behaviourCandidates keeps packages that have something callable to observe', () => {
  const packages = [
    { pkg: 'text-only', patches: [1], rows: [] },
    { pkg: 'real', patches: [2, 3], rows: [{ name: 'f', change: 'added', detail: 'function/2' }] },
    { pkg: 'broken', patches: [4], rows: [{ name: 'f' }], error: 'import failed' },
  ];
  const candidates = lib.behaviourCandidates(packages);
  assert.deepEqual(candidates.map((c) => c.pkg), ['real']);
  assert.deepEqual(candidates[0].patches, [2, 3]);
});

test('renderSurfaces prints a summary, skips quiet packages and links back to patch ids', () => {
  const lines = lib.renderSurfaces([
    { pkg: 'dsh-settings', patches: [42], rows: [{ name: 'SettingsForms', change: 'proto', detail: '+get' }] },
    { pkg: 'dsh-quiet', patches: [7], rows: [] },
    { pkg: 'dsh-missing', patches: [8], rows: [], error: 'not in host' },
  ]);
  const text = lines.join(String.fromCharCode(10));
  assert.match(text, new RegExp('^== surfaces: 3 package\\(s\\) / changed 1 / unchanged 1 / unreadable 1'));
  assert.match(text, new RegExp('dsh-settings  patches:42  1 change\\(s\\)'));
  assert.match(text, new RegExp('SettingsForms  proto  \\+get'));
  assert.match(text, new RegExp('dsh-missing  unreadable \\(not in host\\)'));
  assert.equal(text.includes('dsh-quiet'), false);
});

test('renderSurfaces honours the row limit and says how many it hid', () => {
  const rows = [];
  for (let i = 0; i < 5; i += 1) rows.push({ name: 'e' + i, change: 'added', detail: 'function/0' });
  const text = lib.renderSurfaces([{ pkg: 'p', patches: [1], rows: rows }], { limit: 2 }).join(String.fromCharCode(10));
  assert.match(text, new RegExp('e0  added'));
  assert.match(text, new RegExp('e1  added'));
  assert.equal(text.includes('e2  added'), false);
  assert.match(text, new RegExp('\\.\\.\\. 3 more'));
});

test('renderSurfaces falls back to the default limit when the caller passes a non-integer', () => {
  // `slice(0, 'abc')` is `slice(0, 0)`: a limit that came from an unparsed CLI flag would print a
  // package header and hide every row under it, which reads exactly like "nothing changed".
  const rows = [];
  for (let i = 0; i < 3; i += 1) rows.push({ name: 'e' + i, change: 'added', detail: 'function/0' });
  const text = lib.renderSurfaces([{ pkg: 'p', patches: [], rows: rows }], { limit: 'abc' }).join(String.fromCharCode(10));
  assert.match(text, new RegExp('e0  added'));
  assert.match(text, new RegExp('e2  added'));
  assert.equal(text.includes('more'), false);
});

test('renderInvariant prints known rows as ok and new rows as NEW with their patch ids', () => {
  const lines = lib.renderInvariant({
    expected: [{ pkg: 'dsh-settings', patches: [42], name: 'SettingsForms', change: 'proto', detail: '+get' }],
    unexpected: [{ pkg: 'dsh-sandbox', patches: [13, 35], name: 'SandboxError', change: 'statics', detail: '+code' }],
  });
  const text = lines.join(String.fromCharCode(10));
  assert.match(text, new RegExp('^== surface invariant: 1 known / 1 unexpected'));
  assert.match(text, new RegExp('   ok   dsh-settings SettingsForms proto \\+get'));
  assert.match(text, new RegExp('   NEW  dsh-sandbox SandboxError statics \\+code  \\(patches 13,35\\)'));
});

test('renderInvariant honours the limit and says how many it hid', () => {
  const unexpected = [];
  for (let i = 0; i < 4; i += 1) unexpected.push({ pkg: 'p', patches: [], name: 'n' + i, change: 'added', detail: 'y' });
  const text = lib.renderInvariant({ expected: [], unexpected: unexpected }, { limit: 2 }).join(String.fromCharCode(10));
  assert.match(text, new RegExp('n0'));
  assert.match(text, new RegExp('n1'));
  assert.equal(text.includes('n2'), false);
  assert.match(text, new RegExp('\\.\\.\\. 2 more'));
});

test('renderInvariant falls back to the default limit when the caller passes a non-integer', () => {
  // Same trap as renderSurfaces: `slice(0, 'abc')` is `slice(0, 0)`, so a bad --limit would print
  // "0 known / 3 unexpected" and then hide all three lines with no "more" marker to explain it.
  const unexpected = [];
  for (let i = 0; i < 3; i += 1) unexpected.push({ pkg: 'p', patches: [], name: 'n' + i, change: 'added', detail: 'y' });
  const text = lib.renderInvariant({ expected: [], unexpected: unexpected }, { limit: 'abc' }).join(String.fromCharCode(10));
  assert.match(text, new RegExp('n0'));
  assert.match(text, new RegExp('n2'));
  assert.equal(text.includes('more'), false);
});

test('renderInvariant prints a dash when a new row has no patch behind it', () => {
  const text = lib.renderInvariant({ expected: [], unexpected: [{ pkg: 'p', patches: [], name: 'x', change: 'kind', detail: 'a -> b' }] }).join(String.fromCharCode(10));
  assert.match(text, new RegExp('\\(patches -\\)'));
});
test('checkInvariant passes the one surface change we mean to make', () => {
  const result = lib.checkInvariant([
    { pkg: 'dsh-settings', patches: [42], rows: [{ name: 'SettingsForms', change: 'proto', detail: '+get' }] },
  ], [{ patch: 42, pkg: 'dsh-settings', name: 'SettingsForms', change: 'proto', detail: '+get', why: 'legacy api' }]);
  assert.equal(result.expected.length, 1);
  assert.equal(result.unexpected.length, 0);
});

test('checkInvariant treats any other export reshape as an accident', () => {
  // The premise behind every behaviour assertion is that a patch only rewrites text. When a patch
  // starts adding exports, the assertions coded against the old shape may still pass while the API
  // quietly grew - so an unlisted row must be loud.
  const result = lib.checkInvariant([
    { pkg: 'dsh-tools', patches: [60, 62], rows: [{ name: 'WhateverError', change: 'added', detail: 'class/2' }] },
  ], []);
  assert.equal(result.expected.length, 0);
  assert.deepEqual(result.unexpected, [
    { pkg: 'dsh-tools', patches: [60, 62], name: 'WhateverError', change: 'added', detail: 'class/2' },
  ]);
});

test('checkInvariant matches on the detail string too, so a different method set is not excused', () => {
  const known = [{ patch: 42, pkg: 'dsh-settings', name: 'SettingsForms', change: 'proto', detail: '+get' }];
  const result = lib.checkInvariant([
    { pkg: 'dsh-settings', patches: [42], rows: [{ name: 'SettingsForms', change: 'proto', detail: '+get,+drop' }] },
  ], known);
  assert.equal(result.expected.length, 0);
  assert.equal(result.unexpected.length, 1);
});

test('checkInvariant ignores packages with no rows and packages that failed to load', () => {
  const result = lib.checkInvariant([
    { pkg: 'quiet', patches: [1], rows: [] },
    { pkg: 'broken', patches: [2], rows: [{ name: 'x', change: 'added', detail: 'y' }], error: 'import failed' },
  ], []);
  assert.equal(result.expected.length, 0);
  assert.equal(result.unexpected.length, 1);
});
test('packageTargets keeps only packages below the tree and merges their registry keys', () => {
  const targetMap = {
    escalation: 'D:/host/dsh-sandbox/lib/index.js',
    'tool-fs': ['D:/host/dsh-tool-fs/lib/index.js'],
    'desktop-shell': 'C:/Program Files/DeepSeek/main.js',
    'pi-ai': 'D:/host/@earendil-works/pi-ai/dist/index.js',
    nowhere: undefined,
  };
  const found = lib.packageTargets(targetMap, 'D:/host');
  assert.deepEqual([...found.keys()].sort(), ['dsh-sandbox', 'dsh-tool-fs']);
  assert.deepEqual(found.get('dsh-sandbox').keys, ['escalation']);
});

test('packageTargets merges two keys that land in the same package', () => {
  const found = lib.packageTargets({
    'user-approval': 'D:/host/dsh-user-approval/lib/index.js',
    'user-approval-code': 'D:/host/dsh-user-approval/lib/types/index.js',
  }, 'D:/host');
  assert.deepEqual(found.get('dsh-user-approval').keys.sort(), ['user-approval', 'user-approval-code']);
});

test('packageTargets lists each registry key once even when two of its files land in one package', () => {
  // One patch can write two files inside the same package (lib/index.js and lib/types/index.js).
  // Without the dedupe the package row repeats the id: "patches:42,42", which reads as two patches.
  const found = lib.packageTargets({
    'user-approval': ['D:/host/dsh-user-approval/lib/index.js', 'D:/host/dsh-user-approval/lib/types/index.js'],
  }, 'D:/host');
  assert.deepEqual(found.get('dsh-user-approval').keys, ['user-approval']);
});

test('packageTargets accepts backslashes and a trailing separator on the tree root', () => {
  const BS = String.fromCharCode(92);
  const root = ['D:', 'host', ''].join(BS);
  const file = ['D:', 'host', 'dsh-sandbox', 'lib', 'index.js'].join(BS);
  const found = lib.packageTargets({ escalation: file }, root);
  assert.deepEqual([...found.keys()], ['dsh-sandbox']);
});

test('packageTargets does not let a sibling directory with the same prefix through', () => {
  // 'D:/host-extra/...' starts with 'D:/host' as a string but is not inside the tree; the trailing
  // separator is what stops it. That alone is not the whole story though - see the next test, where
  // the trailing separator is not enough either.
  const found = lib.packageTargets({ x: 'D:/host-extra/dsh-sandbox/lib/index.js' }, 'D:/host');
  assert.equal(found.size, 0);
});

test('packageTargets 的尾随分隔符是唯一挡住对齐错位的守卫', () => {
  // 上面那条 fixture 其实杀不掉这个守卫：D:/host-extra/... 切掉 base 长度后剩下 '-extra/...'，
  // 名字不以 dsh- 开头，于是它在下一道 dsh- 前缀过滤就被拦住了 —— 两条守卫在这条 fixture 上
  // 互为备份，删掉任何一条测试都还是绿的（这次变异演练就抓到它俩都是 GREEN）。
  // 这条 fixture 让切片结果正好对齐成一个 dsh- 包名：'D:/hostXdsh-zzz/' 不以 'D:/host/' 开头，
  // 但按 base 长度切掉前 8 个字符后剩下的正是 'dsh-zzz/lib/index.js'。
  const found = lib.packageTargets({ x: 'D:/hostXdsh-zzz/lib/index.js' }, 'D:/host');
  assert.equal(found.size, 0);
});

test('packageTargets never reads a package out of a path that merely lines up after the root', () => {
  // The `startsWith(base)` guard is not redundant with the `dsh-` name filter: this sibling is one
  // byte longer than the root, so slicing at base.length lands exactly on 'dsh-'. Drop the guard and
  // a directory outside the tree gets reported as a package the patches write into.
  const found = lib.packageTargets({ x: 'D:/host2dsh-sandbox/lib/index.js' }, 'D:/host');
  assert.equal(found.size, 0);
});
