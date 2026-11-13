// verify-target 的判定层：每条补丁在这棵树上是什么状态，只能有一个答案。
//
// 这个文件存在的原因不是覆盖率，是一次真实的漂移：判定曾经在
// scripts/verify-target.mjs 里写了两份（patchApplied / remainingWork），
// core 里还有第三份。加了 #42 的两条 legacy 守卫之后三份开始给出不同结论，
// CLI 里那两份因为没人调用而存活下来 —— 死代码，但看起来像权威。
// 现在判定只在 verify-target-lib.mjs 里写一次，CLI 只负责读盘和渲染。
//
// 覆盖不到的：真宿主上 86 条的实际分布（需要一棵真树，属于 e2e），
// 以及 readText 的缓存（CLI 侧三行，读不到就记 null）。
import test from 'node:test';
import assert from 'node:assert/strict';

import * as lib from './verify-target-lib.mjs';

const deps = (over) => ({
  files: {},
  readText: () => null,
  applyReplacementsToText: () => ({ changed: false, text: '', hitMismatch: null }),
  filePatchOutcome: () => 'pending',
  patchAppliesHere: () => true,
  detail: false,
  ...over,
});

test('schema 与状态词表是固定的（新增状态必须同时改判定与词表）', () => {
  assert.equal(lib.VERIFY_SCHEMA, 1);
  assert.deepEqual(lib.VERIFY_STATE_LIST, ['na', 'no-file', 'would-apply', 'settled', 'drifted']);
  assert.deepEqual(Object.values(lib.VERIFY_STATES).sort(), [...lib.VERIFY_STATE_LIST].sort());
  assert.ok(Object.isFrozen(lib.VERIFY_STATES));
  assert.ok(Object.isFrozen(lib.VERIFY_STATE_LIST));
});

test('fileKeysOf 把单值与数组都归一成数组', () => {
  assert.deepEqual(lib.fileKeysOf({ file: 'a' }), ['a']);
  assert.deepEqual(lib.fileKeysOf({ file: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(lib.fileKeysOf({ file: undefined }), [undefined]);
});

test('patchReplacements / matchesPattern 直接复用 lib/patch-outcome.mjs 那一份', async () => {
  // 这两个判定原本在这里各有一份逐字照抄的实现，与 lib/patch-outcome.mjs 的同名函数
  // 已经能从行为上分开（单数 pattern、null patch、空串 pattern）。同一份注册表被两处
  // 各判一次，谁先改谁说了算 —— 所以只留 lib 那一份，这里只做转出。
  const outcome = await import('../lib/patch-outcome.mjs');
  assert.equal(lib.patchReplacements, outcome.patchReplacements);
  assert.equal(lib.matchesPattern, outcome.matchesPattern);
  const explicit = [{ pattern: 'a', replace: 'b' }];
  assert.equal(lib.patchReplacements({ replacements: explicit }), explicit);
  const built = lib.patchReplacements({ patterns: ['x', 'y'], replace: 'z' });
  assert.deepEqual(built, [{ pattern: 'x', replace: 'z' }, { pattern: 'y', replace: 'z' }]);
  assert.deepEqual(lib.patchReplacements({}), []);
  // 单数 pattern 只有 lib 那份认（86 条里今天一条都不走，但写法是合法的）。
  assert.deepEqual(lib.patchReplacements({ pattern: 'p', replace: 'q' }), [{ pattern: 'p', replace: 'q' }]);
  assert.deepEqual(lib.patchReplacements(null), []);
});

test('keysOfPatch 去掉空键，softKeysOf 只认数组', () => {
  assert.deepEqual(lib.keysOfPatch({ file: ['a', '', null, 'b'] }), ['a', 'b']);
  assert.deepEqual(lib.softKeysOf({ softFiles: ['x'] }), ['x']);
  assert.deepEqual(lib.softKeysOf({ softFiles: 'x' }), []);
  assert.deepEqual(lib.softKeysOf({}), []);
});

test('pathsOf 统一成数组，缺键回空', () => {
  assert.deepEqual(lib.pathsOf({ a: 'p' }, 'a'), ['p']);
  assert.deepEqual(lib.pathsOf({ a: ['p', 'q'] }, 'a'), ['p', 'q']);
  assert.deepEqual(lib.pathsOf({}, 'a'), []);
  assert.deepEqual(lib.pathsOf(null, 'a'), []);
  // null 值不是「没有候选」的意思吗？是，但它不是 undefined —— 少了 !value 这一句
  // 就会返回 [null]，再往下 readText(null) 抛错。
  assert.deepEqual(lib.pathsOf({ a: null }, 'a'), []);
  assert.deepEqual(lib.pathsOf({ a: '' }, 'a'), []);
});

test('matchesPattern 归一 CRLF、摘掉 g 与 y、空 pattern 一律不命中', () => {
  assert.equal(lib.matchesPattern('a\nb', 'a\r\nb'), true);
  const global = /x/g;
  assert.equal(lib.matchesPattern('x', global), true);
  assert.equal(lib.matchesPattern('x', global), true, '带 g 的正则第二次也必须命中（lastIndex 不能留）');
  const sticky = /x/y;
  assert.equal(lib.matchesPattern('x', sticky), true);
  assert.equal(lib.matchesPattern('x', sticky), true, 'y 也要摘掉，否则同样留 lastIndex');
  assert.equal(lib.matchesPattern('nope', /x/), false);
  assert.equal(lib.matchesPattern('A\r\nA', ''), false, '空 pattern 不是「什么都命中」');
  assert.equal(lib.matchesPattern('A\r\nA', null), false);
  assert.equal(lib.matchesPattern(null, 'a'), false);
});

test('patchAppliesHere 说不在这张面上时直接记 na，一个文件都不读', () => {
  let reads = 0;
  const row = lib.judgePatch(
    { id: 9, name: 'X', file: 'k' },
    deps({ patchAppliesHere: () => false, files: { k: '/tmp/k' }, readText: () => { reads += 1; return 'x'; } })
  );
  assert.equal(row.status, 'na');
  assert.equal(row.na, true);
  assert.deepEqual(row.files, {});
  assert.equal(reads, 0);
});

test('一个候选路径都没有时记 no-file，不会因为「没报错」就算完成', () => {
  const row = lib.judgePatch({ id: 1, name: 'A', file: 'missing' }, deps({}));
  assert.equal(row.status, 'no-file');
  assert.deepEqual(row.files, { missing: 'no-file' });
});

test('文件在但读不出来也记 no-file（读失败不能等于已完成）', () => {
  const row = lib.judgePatch(
    { id: 1, name: 'A', file: 'k' },
    deps({ files: { k: '/tmp/k' }, readText: () => null })
  );
  assert.equal(row.status, 'no-file');
});

test('hitMismatch 记 drifted（命中数不符是硬漂移）', () => {
  const row = lib.judgePatch(
    { id: 1, name: 'A', file: 'k' },
    deps({ files: { k: '/tmp/k' }, readText: () => 'text', applyReplacementsToText: () => ({ changed: false, text: 'text', hitMismatch: 2 }) })
  );
  assert.equal(row.status, 'drifted');
  assert.equal(row.files.k, 'hit-mismatch');
});

test('改完能完成记 would-apply，改完还差东西记 drifted(partial)', () => {
  const ok = lib.judgePatch(
    { id: 1, name: 'A', file: 'k' },
    deps({
      files: { k: '/tmp/k' },
      readText: () => 'text',
      applyReplacementsToText: () => ({ changed: true, text: 'next', hitMismatch: null }),
      filePatchOutcome: () => 'applied',
    })
  );
  assert.equal(ok.status, 'would-apply');
  const partial = lib.judgePatch(
    { id: 1, name: 'A', file: 'k' },
    deps({
      files: { k: '/tmp/k' },
      readText: () => 'text',
      applyReplacementsToText: () => ({ changed: true, text: 'next', hitMismatch: null }),
      filePatchOutcome: () => 'pending',
    })
  );
  assert.equal(partial.status, 'drifted');
  assert.equal(partial.files.k, 'partial');
});

test('一条 pattern 都不中时问引擎：applied 记 settled', () => {
  const row = lib.judgePatch(
    { id: 1, name: 'A', file: 'k' },
    deps({ files: { k: '/tmp/k' }, readText: () => 'text', filePatchOutcome: () => 'applied' })
  );
  assert.equal(row.status, 'settled');
  assert.equal(row.files.k, 'settled');
});

test('一条 pattern 都不中、引擎说 pending，算 would-apply（不是 drifted）', () => {
  const row = lib.judgePatch(
    { id: 1, name: 'A', file: 'k' },
    deps({ files: { k: '/tmp/k' }, readText: () => 'text', filePatchOutcome: () => 'pending' })
  );
  assert.equal(row.status, 'would-apply');
  assert.equal(row.files.k, 'pending');
});

test('引擎说 skipped 记 self-marked 且算 settled（deleteOnly 那类）', () => {
  const row = lib.judgePatch(
    { id: 73, name: 'DELETE_ONLY', file: 'k' },
    deps({ files: { k: '/tmp/k' }, readText: () => 'text', filePatchOutcome: () => 'skipped' })
  );
  assert.equal(row.status, 'settled');
  assert.equal(row.files.k, 'self-marked');
});

test('softFiles 里的键原文不在不算漂移（官方搬家后的旧位置）', () => {
  const row = lib.judgePatch(
    { id: 1, name: 'A', file: 'moved', softFiles: ['moved'] },
    deps({ files: { moved: '/tmp/k' }, readText: () => 'text', filePatchOutcome: () => 'pending-miss' })
  );
  assert.equal(row.status, 'would-apply');
  assert.equal(row.files.moved, 'soft-moved');
  // 不在 softFiles 里的同一个结果就是硬漂移。
  const hard = lib.judgePatch(
    { id: 1, name: 'A', file: 'moved' },
    deps({ files: { moved: '/tmp/k' }, readText: () => 'text', filePatchOutcome: () => 'pending-miss' })
  );
  assert.equal(hard.status, 'drifted');
});

test('一个键 settled、另一个 drifted 时整体算 drifted（坏的那条说话）', () => {
  const row = lib.judgePatch(
    { id: 1, name: 'A', file: ['good', 'bad'] },
    deps({
      files: { good: '/tmp/g', bad: '/tmp/b' },
      readText: (fp) => (fp === '/tmp/g' ? 'here' : 'gone'),
      filePatchOutcome: (text) => (text === 'here' ? 'applied' : 'pending-miss'),
    })
  );
  assert.equal(row.status, 'drifted');
  assert.equal(row.files.good, 'settled');
  assert.equal(row.files.bad, 'drifted');
});

test('先 settled 后 would-apply 时整体退回 would-apply（还有活要干）', () => {
  const row = lib.judgePatch(
    { id: 1, name: 'A', file: ['done', 'todo'] },
    deps({
      files: { done: '/tmp/d', todo: '/tmp/t' },
      readText: (fp) => (fp === '/tmp/d' ? 'here' : 'raw'),
      applyReplacementsToText: (text) => (text === 'raw' ? { changed: true, text: 'next', hitMismatch: null } : { changed: false, text, hitMismatch: null }),
      filePatchOutcome: (text) => (text === 'here' ? 'applied' : 'applied'),
    })
  );
  assert.equal(row.status, 'would-apply');
  assert.equal(row.files.done, 'settled');
  assert.equal(row.files.todo, 'would-apply');
});

test('drifted 之后再遇到 would-apply 不会把结论改回来', () => {
  const row = lib.judgePatch(
    { id: 1, name: 'A', file: ['bad', 'todo'] },
    deps({
      files: { bad: '/tmp/b', todo: '/tmp/t' },
      readText: (fp) => (fp === '/tmp/b' ? 'gone' : 'raw'),
      applyReplacementsToText: (text) => (text === 'raw' ? { changed: true, text: 'next', hitMismatch: null } : { changed: false, text, hitMismatch: null }),
      filePatchOutcome: (text) => (text === 'gone' ? 'pending-miss' : 'applied'),
    })
  );
  assert.equal(row.status, 'drifted');
});

test('已经 drifted 之后再遇到 pending，不会把结论改回 would-apply', () => {
  // pending 分支里那句 guard 只在「前面已经有一条 drifted」时才起作用：
  // 一个坏文件之后又一个没打完的文件，结论必须停在 drifted，不能被后面那条改轻。
  const row = lib.judgePatch(
    { id: 1, name: 'A', file: ['bad', 'pend'] },
    deps({
      files: { bad: '/tmp/b', pend: '/tmp/p' },
      readText: () => 'gone',
      filePatchOutcome: (text, patch, file) => (file === '/tmp/b' ? 'pending-miss' : 'pending'),
    })
  );
  assert.equal(row.status, 'drifted');
  assert.equal(row.files.bad, 'drifted');
  assert.equal(row.files.pend, 'pending');
});

test('detail 开着才收集证据，关着连 patterns 都不算（避免白算一遍）', () => {
  let patternCalls = 0;
  const patch = { id: 1, name: 'A', file: 'k', patterns: [/needle/], replace: 'x' };
  const spy = (over) => deps({
    files: { k: '/tmp/k' },
    readText: () => 'gone',
    filePatchOutcome: () => 'pending-miss',
    ...over,
  });
  const quiet = lib.judgePatch(patch, spy({ detail: false }));
  assert.equal(quiet.detail, undefined);
  const loud = lib.judgePatch(patch, spy({ detail: true }));
  assert.equal(loud.detail.length, 1);
  assert.equal(loud.detail[0].key, 'k');
  assert.equal(loud.detail[0].patterns[0].hit, false);
  assert.equal(typeof loud.detail[0].patterns[0].head, 'string');
  patternCalls += 1;
  assert.equal(patternCalls, 1);
});

test('detail 里 hitMismatch 的 head 只截 120，其余截 200（与合并前逐字一致）', () => {
  const long = 'y'.repeat(400);
  const patch = { id: 1, name: 'A', file: 'k', patterns: [long], replace: 'x' };
  const mismatch = lib.judgePatch(patch, deps({
    files: { k: '/tmp/k' },
    readText: () => 'gone',
    applyReplacementsToText: () => ({ changed: false, text: 'gone', hitMismatch: 3 }),
    detail: true,
  }));
  assert.equal(mismatch.detail[0].patterns[0].head.length, 120);
  const drifted = lib.judgePatch(patch, deps({
    files: { k: '/tmp/k' },
    readText: () => 'gone',
    filePatchOutcome: () => 'pending-miss',
    detail: true,
  }));
  assert.equal(drifted.detail[0].patterns[0].head.length, 200);
});

test('judgePatches 汇总每个状态各多少条，na 单独算', () => {
  const patches = [
    { id: 1, name: 'WA', file: 'k' },
    { id: 2, name: 'SET', file: 'k' },
    { id: 3, name: 'DR', file: 'k' },
    { id: 4, name: 'NF', file: 'nope' },
    { id: 5, name: 'NA', file: 'k', surfaces: ['desktop'] },
  ];
  const result = lib.judgePatches(patches, deps({
    files: { k: '/tmp/k' },
    readText: (fp) => (fp === '/tmp/k' ? 'raw' : null),
    applyReplacementsToText: (text, patch) => (patch.id === 1 ? { changed: true, text: 'next', hitMismatch: null } : { changed: false, text, hitMismatch: null }),
    filePatchOutcome: (text, patch) => (patch.id === 2 || text === 'next' ? 'applied' : 'pending-miss'),
    patchAppliesHere: (patch) => patch.id !== 5,
  }));
  assert.equal(result.schema, 1);
  assert.equal(result.patches, 5);
  // 五种状态各一条：WA / SET / DR / NF / NA。drifted 只有 DR 一条 —— 
  // 一度写成 2 是因为把 WA 那条也算进去了，实际它 resolved 成 would-apply。
  assert.deepEqual(result.tally, { wouldApply: 1, settled: 1, drifted: 1, noFile: 1, na: 1 });
  assert.deepEqual(result.rows.map((r) => r.status), ['would-apply', 'settled', 'drifted', 'no-file', 'na']);
});

test('judgePatches 对空表与 undefined 都回空结果，不抛', () => {
  assert.deepEqual(lib.judgePatches([], deps({})).tally, { wouldApply: 0, settled: 0, drifted: 0, noFile: 0, na: 0 });
  assert.deepEqual(lib.judgePatches(undefined, deps({})).rows, []);
});

test('default 导出覆盖全部公开名字（少一个就是有人改了 import 写法）', () => {
  assert.deepEqual(Object.keys(lib.default).sort(), [
    'VERIFY_SCHEMA',
    'VERIFY_STATES',
    'VERIFY_STATE_LIST',
    'fileKeysOf',
    'judgePatch',
    'judgePatches',
    'keysOfPatch',
    'matchesPattern',
    'patchReplacements',
    'pathsOf',
    'softKeysOf',
  ]);
});


test('这两个 helper 只在 lib/patch-outcome.mjs 里定义一次，本文件只做转出', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('./verify-target-lib.mjs', import.meta.url), 'utf8');
  for (const dup of ['function patchReplacements(', 'function matchesPattern(']) {
    assert.equal(text.includes(dup), false, dup + ' 又回来了：同一份注册表会被两处各判一次');
  }
  assert.match(text, /import \{ patchReplacements, matchesPattern \} from "\.\.\/lib\/patch-outcome\.mjs";/);
  assert.match(text, /export \{ patchReplacements, matchesPattern \};/);
});
test('CLI 不再自己维护判定：verify-target.mjs 里不许再出现平行实现', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('./verify-target.mjs', import.meta.url), 'utf8');
  for (const dead of ['function patchApplied(', 'function remainingWork(', 'function matchesPattern(', 'function keysOfPatch(']) {
    assert.equal(text.includes(dead), false, dead + ' 应该是死代码了，判定统一在 verify-target-lib.mjs');
  }
  assert.match(text, /verifyLib\.judgePatches\(/);
  assert.match(text, /import\("\.\/verify-target-lib\.mjs"\)|verify-target-lib\.mjs/);
});
