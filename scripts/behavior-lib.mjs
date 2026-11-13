// Behavioural judging for dsh-purge patches.
//
// WHY THIS FILE EXISTS
// check-metadata only proves a pattern still matches; verify-target only proves a marker
// landed in a file. Neither answers whether the patch still removes the restriction.
// This module turns patch effect into executable assertions: run the same exported
// function with the same inputs on a pristine upstream tree (npm install) and on the
// live host (already patched), and assert 'blocked before, released after'.
//
// HOW IT BREAKS
// 1. Comparing error message bodies: upstream rewording turns the suite red while the
//    restriction is unchanged. Observations therefore carry only a kind plus the error
//    class name, and each scenario is isolated so only one gate can produce it.
// 2. Copying the current patch product into the expectation: one wording tweak turns
//    the assertion into a self-test. Expectations are semantic only (throw/value/
//    contains/absent), never a whole sentence.
// 3. Counting control cases as coverage: a control only proves the instrument is not
//    blind, it covers no patch. coveredPatchIds ignores nothing but covers[] must stay
//    empty on control behaviours.
import { pathToFileURL } from 'node:url';

export const BEHAVIOR_SCHEMA = 1;

export const BEHAVIOR_STATES = Object.freeze({
  ok: 'ok',
  broken: 'broken',
  already: 'already',
  inert: 'inert',
  unexpected: 'unexpected',
});

export const BEHAVIOR_STATE_LIST = Object.freeze(['ok', 'broken', 'already', 'inert', 'unexpected']);

export const MISSING_CODE = 'BEHAVIOR_UNREACHABLE';

/** Raised when the observation point itself is gone (module or export missing). */
export function missingError(message) {
  const error = new Error(message);
  error.code = MISSING_CODE;
  return error;
}

export function isMissingError(error) {
  return Boolean(error) && error.code === MISSING_CODE;
}

/** Error class name only: upstream may reword a message, it almost never renames a class. */
export function errorName(error) {
  if (!(error instanceof Error)) return 'non-error-throw';
  // The constructor name is the specific one: a subclass that never assigns this.name
  // still inherits Error.prototype.name === 'Error', which would collapse every class.
  const ctor = error.constructor;
  if (ctor && typeof ctor.name === 'string' && ctor.name.length > 0 && ctor.name !== 'Object') return ctor.name;
  if (typeof error.name === 'string' && error.name.length > 0) return error.name;
  return 'Error';
}

/** Keep observations JSON-able: primitives as-is, everything else stringified once. */
export function plainValue(value) {
  const type = typeof value;
  if (value === null || type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'undefined') return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function describeObservation(observation) {
  if (!observation) return 'no observation';
  if (observation.kind === 'value') return 'value ' + JSON.stringify(observation.value);
  if (observation.kind === 'throw') return 'throw ' + observation.error;
  return 'unreachable (' + String(observation.note || '').slice(0, 160) + ')';
}

/**
 * Run one behaviour. Two failure classes are separated: an unreachable observation
 * point (missing module/export/bad arity) becomes kind 'missing', while a real throw is
 * recorded as kind 'throw'. Meaning is decided later by judge(), never here.
 */
export async function observe(behavior, load) {
  if (!behavior || typeof behavior.run !== 'function') {
    return { kind: 'missing', note: 'behaviour has no run()' };
  }
  try {
    const result = await behavior.run(load);
    return { kind: 'value', value: plainValue(result) };
  } catch (error) {
    if (isMissingError(error)) return { kind: 'missing', note: String(error.message).slice(0, 200) };
    const message = String(error && error.message);
    if (error instanceof TypeError && message.indexOf('is not a function') !== -1) {
      return { kind: 'missing', note: message.slice(0, 200) };
    }
    return { kind: 'throw', error: errorName(error), message: message.slice(0, 200) };
  }
}

/**
 * Expectations are semantic: 'throw' (optionally narrowed to one error class), 'value',
 * 'contains' / 'absent' over substrings, or 'missing' for a control that proves the
 * observation point is absent. Message bodies are never matched.
 */
export function matchesExpectation(observation, expect) {
  if (!observation || !expect) return false;
  if (expect.kind === 'missing') return observation.kind === 'missing';
  if (expect.kind === 'throw') {
    if (observation.kind !== 'throw') return false;
    return expect.error === undefined || observation.error === expect.error;
  }
  if (observation.kind !== 'value') return false;
  if (expect.kind === 'value') return observation.value === expect.value;
  const text = String(observation.value);
  if (expect.kind === 'contains') return expect.text.every((needle) => text.indexOf(needle) !== -1);
  if (expect.kind === 'absent') return expect.text.every((needle) => text.indexOf(needle) === -1);
  return false;
}

/**
 * Five states, three of them meaning something:
 *   ok         baseline blocked, patched released  -> the patch still works
 *   broken     baseline blocked, patched still blocked -> patch lost effect
 *   already    baseline no longer blocks -> the patch may be retired
 *   inert      observation point unreachable on one tree -> needs a human, never a pass
 *   unexpected anything neither side declared -> needs a human
 */
export function judge(behavior, orig, patched) {
  if (behavior.kind === 'control') {
    const left = matchesExpectation(orig, behavior.orig);
    const right = matchesExpectation(patched, behavior.patched);
    if (left && right) return { state: 'ok', reasons: ['control: both trees match the expected observation'] };
    return { state: 'unexpected', reasons: ['control mismatch: baseline ' + left + ', patched ' + right + ' — ' + describeObservation(orig) + ' / ' + describeObservation(patched)] };
  }
  if (orig.kind === 'missing' || patched.kind === 'missing') {
    const side = orig.kind === 'missing' ? 'baseline' : 'patched';
    const seen = orig.kind === 'missing' ? orig : patched;
    return { state: 'inert', reasons: ['observation unreachable on the ' + side + ' tree: ' + describeObservation(seen)] };
  }
  const restricted = matchesExpectation(orig, behavior.orig);
  const released = matchesExpectation(patched, behavior.patched);
  if (restricted && released) return { state: 'ok', reasons: ['baseline blocked as expected, patched released'] };
  if (restricted) return { state: 'broken', reasons: ['baseline blocked as expected, patched now observes ' + describeObservation(patched)] };
  if (orig.kind === 'throw') {
    return { state: 'unexpected', reasons: ['baseline threw ' + orig.error + ' (' + String(orig.message || '').slice(0, 120) + '), which no expectation of this behaviour covers'] };
  }
  return { state: 'already', reasons: ['baseline no longer restricted (' + describeObservation(orig) + '), so this patch may be unnecessary'] };
}

export function tallyStates(results) {
  const tally = {};
  for (const state of BEHAVIOR_STATE_LIST) tally[state] = 0;
  for (const result of results) {
    if (tally[result.state] === undefined) tally[result.state] = 0;
    tally[result.state] += 1;
  }
  return tally;
}

export function isFailure(result) { return result.state === 'broken' || result.state === 'unexpected'; }
export function isRetireCandidate(result) { return result.state === 'already'; }
export function needsHuman(result) { return result.state === 'inert' || result.state === 'unexpected'; }

/** Patch ids actually covered by a behaviour assertion. Controls must carry covers: []. */
export function coveredPatchIds(behaviors) {
  const ids = new Set();
  for (const behavior of behaviors) {
    for (const id of behavior.covers || []) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

export function uncoveredPatchIds(behaviors, allIds) {
  const covered = new Set(coveredPatchIds(behaviors));
  return allIds.filter((id) => !covered.has(id)).sort((a, b) => a - b);
}

/** Strip functions so the registry can be written to docs/patch-behaviors.json. */
export function describeBehaviors(behaviors) {
  return behaviors.map((behavior) => ({
    id: behavior.id,
    title: behavior.title,
    module: behavior.module,
    kind: behavior.kind || 'behaviour',
    covers: [...(behavior.covers || [])],
    note: behavior.note,
    orig: behavior.orig,
    patched: behavior.patched,
  }));
}

export function renderBehaviorReport(results, options = {}) {
  const limit = options.limit === undefined ? 60 : options.limit;
  const tally = tallyStates(results);
  const mark = { ok: 'PASS', broken: 'FAIL', already: 'RETIRE', inert: 'INERT', unexpected: 'ODD' };
  const out = [];
  out.push('[behaviour] schema ' + BEHAVIOR_SCHEMA + ' — ' + results.length + ' behaviours');
  for (const state of BEHAVIOR_STATE_LIST) {
    const rows = results.filter((result) => result.state === state);
    if (rows.length === 0) continue;
    out.push('');
    out.push('  ' + (mark[state] || '?') + ' (' + rows.length + ')');
    for (const row of rows.slice(0, limit)) {
      out.push('    ' + row.id + ' [patches ' + row.covers.join(',') + '] ' + row.title);
      for (const reason of row.reasons || []) out.push('      ' + reason);
    }
    if (rows.length > limit) out.push('    ... ' + (rows.length - limit) + ' more');
  }
  out.push('');
  out.push('[behaviour] tally ' + BEHAVIOR_STATE_LIST.map((state) => state + '=' + tally[state]).join(' '));
  return out.join(String.fromCharCode(10));
}

/** Convenience loader: import <aiBase>/<pkg>/lib/<entry> once per tree. */
export function moduleLoader(aiBase) {
  const cache = new Map();
  return async function load(pkg, entry) {
    const rel = entry === undefined ? 'lib/index.js' : 'lib/' + entry;
    const file = aiBase + '/' + pkg + '/' + rel;
    if (cache.has(file)) return cache.get(file);
    const mod = await import(pathToFileURL(file).href);
    cache.set(file, mod);
    return mod;
  };
}

export function requireExport(mod, name, where) {
  const value = mod ? mod[name] : undefined;
  if (value === undefined) throw missingError(where + ' does not export ' + name);
  return value;
}
