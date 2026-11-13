// Guard rails for the behavioural cross-check layer.
//
// HOW THIS MODULE BREAKS
// 1. Matching error message bodies: upstream rewordings would turn the suite red while
//    the restriction is unchanged, so expectations only see a kind and an error class.
// 2. Treating a missing observation point as a pass: 'inert' exists so an unreachable
//    export never reads as 'patch still works'.
// 3. Counting a control as coverage: controls prove the instrument is not blind and must
//    carry covers: [] or the coverage number lies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BEHAVIOR_SCHEMA,
  BEHAVIOR_STATES,
  BEHAVIOR_STATE_LIST,
  MISSING_CODE,
  missingError,
  isMissingError,
  errorName,
  plainValue,
  describeObservation,
  observe,
  matchesExpectation,
  judge,
  tallyStates,
  isFailure,
  isRetireCandidate,
  needsHuman,
  coveredPatchIds,
  uncoveredPatchIds,
  describeBehaviors,
  renderBehaviorReport,
  moduleLoader,
} from './behavior-lib.mjs';
import { BEHAVIORS } from './patch-behaviors.mjs';
import { ALL_PATCHES } from '../lib/patches/index.mjs';

function fixtureTree(pkg, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-behaviour-'));
  const dir = path.join(root, pkg, 'lib');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), source);
  return root;
}

const value = (v) => ({ kind: 'value', value: v });
const thrown = (name) => ({ kind: 'throw', error: name, message: 'whatever' });
const missing = () => ({ kind: 'missing', note: 'gone' });

test('schema and state vocabulary stay stable', () => {
  assert.equal(BEHAVIOR_SCHEMA, 1);
  assert.deepEqual([...BEHAVIOR_STATE_LIST], ['ok', 'broken', 'already', 'inert', 'unexpected']);
  assert.deepEqual(Object.keys(BEHAVIOR_STATES).sort(), [...BEHAVIOR_STATE_LIST].sort());
});

test('missing errors carry their own code so observe can tell them from real throws', () => {
  const error = missingError('export gone');
  assert.equal(error.code, MISSING_CODE);
  assert.equal(isMissingError(error), true);
  assert.equal(isMissingError(new Error('boom')), false);
  assert.equal(isMissingError(null), false);
});

test('errorName falls back to the constructor name and never to the message', () => {
  class ValidationError extends Error {}
  assert.equal(errorName(new ValidationError('x')), 'ValidationError');
  assert.equal(errorName(new TypeError('y')), 'TypeError');
  assert.equal(errorName('a string'), 'non-error-throw');
  assert.equal(errorName(undefined), 'non-error-throw');
});

test('plainValue keeps JSON-able shapes and stringifies the rest', () => {
  assert.equal(plainValue('s'), 's');
  assert.equal(plainValue(3), 3);
  assert.equal(plainValue(null), null);
  assert.equal(plainValue(undefined), 'undefined');
  assert.equal(plainValue({ a: 1 }), '{"a":1}');
});

test('describeObservation names the observation kind', () => {
  assert.match(describeObservation(value('danger-full-access')), /^value "danger-full-access"$/);
  assert.match(describeObservation(thrown('Error')), /^throw Error$/);
  assert.match(describeObservation(missing()), /^unreachable/);
  assert.equal(describeObservation(null), 'no observation');
});

test('observe records a value, a throw, and an unreachable point separately', async () => {
  const load = async () => ({});
  assert.deepEqual(await observe({ run: async () => 'v' }, load), value('v'));
  const thrownResult = await observe({ run: async () => { throw new TypeError('not callable'); } }, load);
  assert.equal(thrownResult.kind, 'throw');
  assert.equal(thrownResult.error, 'TypeError');
  const missingResult = await observe({ run: async () => { throw missingError('x is gone'); } }, load);
  assert.equal(missingResult.kind, 'missing');
  assert.equal((await observe({}, load)).kind, 'missing');
});

test('observe turns a missing function into an unreachable point, not a failure', async () => {
  // 'x.y is not a function' is how a removed export actually shows up at runtime.
  const result = await observe({ run: async () => { const y = {}; y.approveEscalation(); } }, async () => ({}));
  assert.equal(result.kind, 'missing');
});

test('matchesExpectation is semantic and ignores message bodies', () => {
  assert.equal(matchesExpectation(thrown('Error'), { kind: 'throw', error: 'Error' }), true);
  assert.equal(matchesExpectation(thrown('RangeError'), { kind: 'throw', error: 'Error' }), false);
  assert.equal(matchesExpectation(thrown('Error'), { kind: 'throw' }), true);
  assert.equal(matchesExpectation(value('abc def'), { kind: 'contains', text: ['abc', 'def'] }), true);
  assert.equal(matchesExpectation(value('abc def'), { kind: 'absent', text: ['zzz'] }), true);
  assert.equal(matchesExpectation(value(2000), { kind: 'value', value: 2000 }), true);
  assert.equal(matchesExpectation(value(2000), { kind: 'value', value: '2000' }), false);
  assert.equal(matchesExpectation(missing(), { kind: 'missing' }), true);
  assert.equal(matchesExpectation(value('x'), { kind: 'missing' }), false);
  assert.equal(matchesExpectation(value('x'), { kind: 'nonsense' }), false);
});

const behaviour = (over) => ({ id: 'b', title: 't', module: 'm', covers: [1], orig: { kind: 'throw', error: 'Error' }, patched: { kind: 'value', value: 'ok' }, run: async () => 'ok', ...over });

test('judge calls a released restriction ok', () => {
  const verdict = judge(behaviour(), thrown('Error'), value('ok'));
  assert.equal(verdict.state, 'ok');
});

test('judge calls a still-blocked patch broken', () => {
  const verdict = judge(behaviour(), thrown('Error'), thrown('Error'));
  assert.equal(verdict.state, 'broken');
});

test('judge calls an unrestricted baseline already, so the patch can retire', () => {
  const verdict = judge(behaviour(), value('ok'), value('ok'));
  assert.equal(verdict.state, 'already');
});

test('judge never reads an unreachable observation point as a pass', () => {
  assert.equal(judge(behaviour(), missing(), value('ok')).state, 'inert');
  assert.equal(judge(behaviour(), thrown('Error'), missing()).state, 'inert');
});

test('judge flags a baseline throw that no expectation covers', () => {
  const verdict = judge(behaviour({ orig: { kind: 'value', value: 'x' } }), thrown('RangeError'), value('x'));
  assert.equal(verdict.state, 'unexpected');
});

test('a control must match on both trees and covers nothing', () => {
  const control = behaviour({ kind: 'control', covers: [], orig: { kind: 'contains', text: ['a'] }, patched: { kind: 'contains', text: ['a'] } });
  assert.equal(judge(control, value('abc'), value('abc')).state, 'ok');
  assert.equal(judge(control, value('abc'), value('zzz')).state, 'unexpected');
});

test('tally, failure and human-attention predicates agree with the states', () => {
  const results = [{ state: 'ok' }, { state: 'broken' }, { state: 'already' }, { state: 'inert' }, { state: 'unexpected' }];
  const tally = tallyStates(results);
  assert.equal(tally.ok, 1);
  assert.equal(tally.broken, 1);
  assert.equal(isFailure({ state: 'broken' }), true);
  assert.equal(isFailure({ state: 'inert' }), false);
  assert.equal(needsHuman({ state: 'inert' }), true);
  assert.equal(needsHuman({ state: 'unexpected' }), true);
  assert.equal(isRetireCandidate({ state: 'already' }), true);
  assert.equal(isRetireCandidate({ state: 'ok' }), false);
});

test('coverage counts patch ids once and skips controls', () => {
  const ids = coveredPatchIds([
    { covers: [13, 14, 35] },
    { covers: [35, 9] },
    { covers: [] },
  ]);
  assert.deepEqual(ids, [9, 13, 14, 35]);
  assert.deepEqual(uncoveredPatchIds([{ covers: [2] }], [1, 2, 3]), [1, 3]);
});

test('describeBehaviors strips functions so the registry can be written as JSON', () => {
  const described = describeBehaviors([behaviour({ note: 'n' })]);
  assert.equal(typeof described[0].run, 'undefined');
  assert.deepEqual(described[0].covers, [1]);
  assert.equal(described[0].note, 'n');
  assert.doesNotThrow(() => JSON.stringify(described));
});

test('renderBehaviorReport prints one section per state that has rows', () => {
  const text = renderBehaviorReport([
    { id: 'a', title: 'A', covers: [1], state: 'ok', reasons: ['r1'] },
    { id: 'b', title: 'B', covers: [2], state: 'broken', reasons: ['r2'] },
  ]);
  assert.match(text, /schema 1/);
  assert.match(text, /PASS \(1\)/);
  assert.match(text, /FAIL \(1\)/);
  assert.doesNotMatch(text, /RETIRE/);
  assert.match(text, /tally ok=1 broken=1/);
});

test('moduleLoader imports each package once and caches by file', async () => {
  const root = fixtureTree('dsh-fixture', 'export const marker = 7;');
  const load = moduleLoader(root);
  const first = await load('dsh-fixture');
  const second = await load('dsh-fixture');
  assert.equal(first.marker, 7);
  assert.equal(first, second);
  await assert.rejects(() => load('dsh-absent'));
});

test('every registered behaviour is well formed and names real patches', () => {
  const ids = new Set();
  const patchIds = new Set(ALL_PATCHES.map((patch) => patch.id));
  for (const entry of BEHAVIORS) {
    assert.equal(typeof entry.id, 'string', 'id must be a string');
    assert.equal(ids.has(entry.id), false, 'duplicate behaviour id ' + entry.id);
    ids.add(entry.id);
    assert.equal(typeof entry.run, 'function', entry.id + ' has no run()');
    assert.equal(typeof entry.module, 'string', entry.id + ' has no module');
    assert.ok(entry.orig && entry.patched, entry.id + ' must declare both expectations');
    for (const patchId of entry.covers) {
      assert.ok(patchIds.has(patchId), entry.id + ' covers unknown patch ' + patchId);
    }
    if (entry.kind === 'control') {
      assert.deepEqual(entry.covers, [], entry.id + ' is a control and must cover no patch');
    } else {
      assert.ok(entry.covers.length > 0, entry.id + ' covers no patch');
    }
  }
});

test('the registry covers every patch that a behaviour can reach today', () => {
  const covered = coveredPatchIds(BEHAVIORS);
  // A floor, not a target: it only fails when an assertion is deleted by accident.
  assert.ok(covered.length >= 12, 'covered only ' + covered.length + ' patches');
  for (const id of [9, 10, 13, 14, 22, 23, 34, 35, 36, 38, 42, 51]) {
    assert.ok(covered.includes(id), 'patch ' + id + ' lost its behaviour assertion');
  }
});