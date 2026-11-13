// 补丁锚点矩阵：这个模块坏掉的方式
// 1. 把「纯净树上锚点死了」一律说成 retire。插入型补丁（skipIfMarked）的锚点是代码位置，
//    上游把那一行挪走也是死锚点，那是 re-anchor 不是退役；#12 是「上游改写了句子但限制还在」，
//    同样不是退役。所以判定分六档，dead 只是其中一档，结论要靠人读锚点文本。
// 2. 在已打补丁的树上跑。那里的命中只说明补丁还没跑，正是问题反面。
// 3. 自己再实现一遍 pattern 匹配。countPatternHits 从 lib/patch-outcome.mjs 注入，两处实现
//    会漂移，矩阵就会说谎。测试里用一个只认字面量的假 outcome 来锁这个契约。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lib from './patch-matrix-lib.mjs';

const TRACE = '[dsh-purge]';

function fakeOutcome(overrides = {}) {
  return {
    countPatternHits(text, patch) {
      let hits = 0;
      for (const rep of (patch && patch.replacements) || []) {
        if (typeof rep.pattern === 'string' && rep.pattern && text.includes(rep.pattern)) hits++;
      }
      return hits;
    },
    markerPresent(text, patch) {
      const markers = [];
      if (typeof patch.marker === 'string') markers.push(patch.marker);
      for (const m of patch.markers || []) markers.push(m);
      return markers.length > 0 && markers.every((m) => text.includes(m));
    },
    isRetractionPatch(patch) {
      return Boolean(patch.skipIfMarked || patch.deleteOnly || patch.softSettle);
    },
    ...overrides,
  };
}

function patchOf(over = {}) {
  return {
    id: 900,
    name: 'FIXTURE',
    file: 'target',
    replacements: [{ pattern: 'GATE_LINE', replace: 'OPEN_LINE' }],
    markers: ['M1'],
    ...over,
  };
}

function treeOf(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-matrix-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return { dir, map: Object.fromEntries(Object.keys(files).map((n) => ['target', path.join(dir, n)])) };
}

test('七档判定全部导出且顺序稳定', () => {
  assert.deepEqual([...lib.MATRIX_VERDICT_LIST], ['live', 'stale', 'dead', 'native', 'retraction', 'trace', 'blind']);
  assert.equal(lib.MATRIX_SCHEMA, 1);
});

test('targetKeysOf 接受单键与数组，丢掉空值', () => {
  assert.deepEqual(lib.targetKeysOf({ file: 'a' }), ['a']);
  assert.deepEqual(lib.targetKeysOf({ file: ['a', '', 'b'] }), ['a', 'b']);
  assert.deepEqual(lib.targetKeysOf({}), []);
});

test('resolveTargets 把键解析成文件，解析不到的键直接跳过而不是报错', () => {
  const p = patchOf({ file: ['here', 'gone'] });
  const out = lib.resolveTargets(p, { here: 'D:/x/a.js' });
  assert.deepEqual(out, [{ key: 'here', file: 'D:/x/a.js' }]);
  assert.deepEqual(lib.resolveTargets(patchOf({ file: ['gone'] }), {}), []);
});

test('resolveTargets 展平数组型目标（一个键对多个文件）', () => {
  const out = lib.resolveTargets(patchOf({ file: 'multi' }), { multi: ['D:/a.js', 'D:/b.js'] });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((t) => t.file), ['D:/a.js', 'D:/b.js']);
});

test('readTexts 跳过不存在的文件，不让一个缺文件抹掉整个补丁', () => {
  const t = treeOf({ 'a.js': 'GATE_LINE' });
  const out = lib.readTexts([
    { key: 'target', file: path.join(t.dir, 'a.js') },
    { key: 'target', file: path.join(t.dir, 'nope.js') },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'GATE_LINE');
});

test('anchorHits 汇总跨文件命中并按文件记录', () => {
  const texts = [
    { key: 'target', file: 'a.js', text: 'GATE_LINE' },
    { key: 'target', file: 'b.js', text: 'nothing' },
  ];
  const out = lib.anchorHits(patchOf(), texts, fakeOutcome());
  assert.equal(out.hits, 1);
  assert.equal(out.files, 1);
  assert.equal(out.perFile[0].file, 'a.js');
});

test('anchorPrefix 把首个锚点压成一行短摘要', () => {
  assert.equal(lib.anchorPrefix(patchOf({ replacements: [{ pattern: 'a\n  b\tc', replace: 'x' }] })), 'a b c');
  assert.ok(lib.anchorPrefix(patchOf()).length <= 72);
  assert.equal(lib.anchorPrefix({}), '');
});

test('isInsertPatch / isTraceAnchored 认准两个正交的补丁形状', () => {
  assert.equal(lib.isInsertPatch(patchOf({ skipIfMarked: true })), true);
  assert.equal(lib.isInsertPatch(patchOf()), false);
  assert.equal(lib.isTraceAnchored(patchOf({ replacements: [{ pattern: TRACE + ' x', replace: 'y' }] })), true);
  assert.equal(lib.isTraceAnchored(patchOf()), false);
});

test('verdictOf 的优先级：trace > native > retraction > blind > live/dead', () => {
  const o = fakeOutcome();
  const facts = (over) => ({ resolved: 1, hits: 0, nativePresent: false, outcome: o, ...over });
  assert.equal(lib.verdictOf(patchOf({ replacements: [{ pattern: TRACE, replace: 'y' }] }), facts({ nativePresent: true })), 'trace');
  assert.equal(lib.verdictOf(patchOf({ skipIfMarked: true }), facts({ nativePresent: true })), 'native');
  assert.equal(lib.verdictOf(patchOf({ skipIfMarked: true }), facts({})), 'retraction');
  assert.equal(lib.verdictOf(patchOf(), facts({ resolved: 0 })), 'blind');
  assert.equal(lib.verdictOf(patchOf(), facts({})), 'dead');
  assert.equal(lib.verdictOf(patchOf(), facts({ hits: 2 })), 'live');
  // 闸门还在而锚点死了 = 上游改写了代码但限制还在：要改锚点，不是退役
  assert.equal(lib.verdictOf(patchOf(), facts({ gatePresent: true })), 'stale');
  // 锚点活着时闸门不参与判定：能打就是能打
  assert.equal(lib.verdictOf(patchOf(), facts({ hits: 1, gatePresent: false })), 'live');
});

test('describePatchInTree 把判定需要的每一格都填上', () => {
  const t = treeOf({ 'a.js': 'GATE_LINE' });
  const row = lib.describePatchInTree(patchOf(), t.map, fakeOutcome(), new Map([[900, ['b-900']]]));
  assert.equal(row.id, 900);
  assert.equal(row.resolved, 1);
  assert.equal(row.readable, 1);
  assert.equal(row.hits, 1);
  assert.equal(row.verdict, 'live');
  assert.deepEqual(row.behaviors, ['b-900']);
  assert.equal(row.anchor, 'GATE_LINE');
});

test('describePatchInTree 对解析不到的补丁给 blind，而不是 dead', () => {
  const row = lib.describePatchInTree(patchOf({ file: 'missing' }), {}, fakeOutcome(), new Map());
  assert.equal(row.verdict, 'blind');
  assert.equal(row.resolved, 0);
  assert.deepEqual(row.behaviors, []);
});

test('tallyVerdicts 七档都出现，缺的补 0', () => {
  const tally = lib.tallyVerdicts([{ verdict: 'live' }, { verdict: 'live' }, { verdict: 'dead' }]);
  assert.deepEqual(tally, { live: 2, stale: 0, dead: 1, native: 0, retraction: 0, trace: 0, blind: 0 });
});

test('collectBehaviorsById 做反向索引，一条行为可以覆盖多个补丁', () => {
  const map = lib.collectBehaviorsById([
    { id: 'b1', covers: [13, 14] },
    { id: 'b2', covers: [13] },
    { id: 'ctrl', covers: [] },
  ]);
  assert.deepEqual(map.get(13), ['b1', 'b2']);
  assert.deepEqual(map.get(14), ['b1']);
  assert.equal(map.has(99), false);
});

test('mergeTrees 按补丁 id 对齐多棵树，缺的格子是 null 而不是丢行', () => {
  const merged = lib.mergeTrees([1, 2], {
    rc1: [
      { id: 1, name: 'A', verdict: 'live', hits: 1 },
      { id: 2, name: 'B', verdict: 'dead', hits: 0 },
    ],
    rc2: [{ id: 1, name: 'A', verdict: 'dead', hits: 0 }],
  });
  assert.equal(merged.length, 2);
  assert.equal(merged[0].cells.rc2.verdict, 'dead');
  assert.equal(merged[1].cells.rc2, null);
  assert.equal(merged[1].name, 'B');
});

test('renderMatrix 只打印被选中的档，且带上 behavior 覆盖', () => {
  const merged = lib.mergeTrees([1], {
    rc1: [{ id: 1, name: 'A', verdict: 'dead', hits: 0, behaviors: ['b1'], insert: false, optional: false }],
  });
  assert.equal(lib.renderMatrix(merged, ['rc1'], { verdicts: ['live'] }), '');
  const text = lib.renderMatrix(merged, ['rc1'], { verdicts: ['dead'] });
  assert.ok(text.includes('dead(0)'));
  assert.ok(text.includes('beh:b1'));
});

test('describePatchInTree 会记录闸门并据此把死锚点判成 stale', () => {
  const t = treeOf({ 'a.js': 'CHANGED_LINE\n' });
  const gate = { needle: 'CHANGED_LINE', reason: null };
  const row = lib.describePatchInTree(patchOf(), t.map, fakeOutcome(), new Map(), gate);
  assert.equal(row.hits, 0);
  assert.equal(row.gatePresent, true);
  assert.equal(row.gate, 'CHANGED_LINE');
  assert.equal(row.verdict, 'stale');
});

test('没有闸门时死锚点仍是 dead，并带上不能生成闸门的理由', () => {
  const t = treeOf({ 'a.js': 'CHANGED_LINE\n' });
  const row = lib.describePatchInTree(patchOf(), t.map, fakeOutcome(), new Map(), { reason: 'not-found' });
  assert.equal(row.gatePresent, false);
  assert.equal(row.gateReason, 'not-found');
  assert.equal(row.verdict, 'dead');
});

test('renderDeadList 把「改锚点」与「先读再退役」分成两段打印', () => {
  const merged = lib.mergeTrees([12, 24], {
    rc1: [
      { id: 12, name: 'ASK', verdict: 'stale', hits: 0, behaviors: [], insert: false, optional: false, anchor: 'Approval policy: ask.' },
      { id: 24, name: 'FETCH', verdict: 'dead', hits: 0, behaviors: [], insert: true, optional: true, anchor: '- id: tool-web', gateReason: 'not-found' },
    ],
  });
  const text = lib.renderDeadList(merged, 'rc1');
  const reanchor = text.indexOf('re-anchor');
  const retire = text.indexOf('read before retiring');
  assert.ok(reanchor >= 0 && retire > reanchor, 're-anchor section must come first');
  assert.ok(text.includes('Approval policy: ask.'));
  assert.ok(text.includes('(not-found)'));
});

test('renderDeadList 把锚点文本一起打出来，让人能分辨 retire 与 re-anchor', () => {
  const merged = lib.mergeTrees([12], {
    rc1: [{
      id: 12, name: 'ASK', verdict: 'dead', hits: 0, behaviors: [],
      insert: false, optional: false, anchor: 'Approval policy: ask.',
    }],
  });
  const text = lib.renderDeadList(merged, 'rc1');
  assert.ok(text.includes('#12'));
  assert.ok(text.includes('Approval policy: ask.'));
  assert.equal(lib.renderDeadList(merged, 'rc2'), '');
});