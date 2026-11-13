// Surfaces: what a module exposes, described the same way on two trees, so the difference can be
// read instead of guessed.
//
// Behaviour assertions cover 12 of 86 patches because somebody had to think of an observation point
// for each one. Most of them ARE observable - the patch changed a schema default, added a prototype
// method, renamed an export - we just never looked. This module makes the looking mechanical:
// describe an export surface as data, describe it again on the patched copy, and print the diff.
//
// What it cannot see: anything a patch only changes inside a function body (a rewording, a raised
// constant, an early return). Those still need a hand-written behaviour or the text-level five-state
// judgement; this is a way to find the candidates, not a replacement for the evidence.
//
// HOW THIS MODULE BREAKS
// 1. Describing values by identity instead of by shape: two Config schemas are never ===, so every
//    export would look changed and the report would be noise.
// 2. Describing functions by toString(): every patch that reworded a string inside a body would show
//    up as a surface change, and the real ones would be lost in the crowd.
// 3. Throwing on the first value that does not describe cleanly (a getter, a proxy): one hostile
//    export would blank the whole package.
export const SURFACE_SCHEMA = 1;

const SKIP_NAME = new Set(['length', 'name', 'prototype', 'arguments', 'caller']);

function isClass(value) {
  try {
    return /^class[\s{]/.test(Function.prototype.toString.call(value));
  } catch {
    return false;
  }
}

// Values are described by shape, never by identity. A schema function and a plain object both get a
// stable one-line descriptor; anything weird degrades to its typeof rather than throwing.
export function describeValue(value, depth = 0) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'function') {
    const arity = Number.isInteger(value.length) ? value.length : 0;
    return (isClass(value) ? 'class' : 'function') + '/' + arity;
  }
  if (type !== 'object') return type;
  if (Array.isArray(value)) return 'array/' + value.length;
  if (depth >= 1) return 'object';
  let keys = [];
  try {
    keys = Object.keys(value).sort();
  } catch {
    return 'object';
  }
  if (keys.length === 0) return 'object';
  const head = keys.slice(0, 6).join(',');
  return 'object{' + head + (keys.length > 6 ? ',+' + (keys.length - 6) : '') + '}';
}

function ownNames(value, extraSkip) {
  try {
    return Object.getOwnPropertyNames(value)
      .filter((name) => !SKIP_NAME.has(name) && !(extraSkip && extraSkip.has(name)))
      .sort();
  } catch {
    return [];
  }
}

// A class is described by what you can actually call on it: statics, and the prototype surface.
// This is how '#42 added five methods' becomes visible without anyone writing that expectation.
export function describeExport(value) {
  const base = { kind: describeValue(value) };
  if (typeof value !== 'function') {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      base.keys = ownNames(value).slice(0, 40);
    }
    return base;
  }
  base.statics = ownNames(value).slice(0, 40);
  if (isClass(value) && value.prototype) base.proto = ownNames(value.prototype, new Set(['constructor'])).slice(0, 60);
  return base;
}

export function describeModule(mod) {
  const out = {};
  let names = [];
  try {
    names = Object.keys(mod).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'default') continue;
    try {
      out[name] = describeExport(mod[name]);
    } catch {
      out[name] = { kind: 'unreadable' };
    }
  }
  return out;
}

function listDelta(before, after) {
  const a = new Set(before || []);
  const b = new Set(after || []);
  const added = [...b].filter((x) => !a.has(x));
  const removed = [...a].filter((x) => !b.has(x));
  return { added: added, removed: removed };
}

function sameList(x, y) {
  const a = JSON.stringify(x || []);
  const b = JSON.stringify(y || []);
  return a === b;
}

// The diff only reports things a caller could notice: an export that appeared or vanished, an arity
// change, added or removed statics/prototype methods, or a different object key set.
export function diffSurface(before, after) {
  const rows = [];
  const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const name of [...names].sort()) {
    const a = (before || {})[name];
    const b = (after || {})[name];
    if (!a) {
      rows.push({ name: name, change: 'added', detail: b.kind || '' });
      continue;
    }
    if (!b) {
      rows.push({ name: name, change: 'removed', detail: a.kind || '' });
      continue;
    }
    if (a.kind !== b.kind) {
      rows.push({ name: name, change: 'kind', detail: a.kind + ' -> ' + b.kind });
      continue;
    }
    const statics = listDelta(a.statics, b.statics);
    if (statics.added.length || statics.removed.length) {
      rows.push({ name: name, change: 'statics', detail: sign(statics) });
    }
    const proto = listDelta(a.proto, b.proto);
    if (proto.added.length || proto.removed.length) {
      rows.push({ name: name, change: 'proto', detail: sign(proto) });
    }
    const keys = listDelta(a.keys, b.keys);
    if (keys.added.length || keys.removed.length) {
      rows.push({ name: name, change: 'keys', detail: sign(keys) });
    }
  }
  return rows;
}

function sign(delta) {
  const parts = [];
  if (delta.added.length) parts.push('+' + delta.added.slice(0, 8).join(',') + (delta.added.length > 8 ? ',+' + (delta.added.length - 8) : ''));
  if (delta.removed.length) parts.push('-' + delta.removed.slice(0, 8).join(',') + (delta.removed.length > 8 ? ',-' + (delta.removed.length - 8) : ''));
  return parts.join(' ');
}

export function tallySurfaces(packages) {
  const tally = { packages: 0, changed: 0, unchanged: 0, unreadable: 0, rows: 0 };
  for (const pkg of packages || []) {
    tally.packages += 1;
    tally.rows += (pkg.rows || []).length;
    if (pkg.error) tally.unreadable += 1;
    else if ((pkg.rows || []).length > 0) tally.changed += 1;
    else tally.unchanged += 1;
  }
  return tally;
}

// Packages with a surface difference are the candidates for a behaviour assertion. Packages with
// none are not broken - the patch may only reword a sentence - but they will never get behavioural
// evidence, so their five-state text judgement is the final word.
export function behaviourCandidates(packages) {
  return (packages || [])
    .filter((pkg) => !pkg.error && (pkg.rows || []).length > 0)
    .map((pkg) => ({ pkg: pkg.pkg, patches: pkg.patches || [], rows: pkg.rows }));
}

export function renderSurfaces(packages, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 20;
  const lines = [];
  const tally = tallySurfaces(packages);
  lines.push('== surfaces: ' + tally.packages + ' package(s) / changed ' + tally.changed + ' / unchanged ' + tally.unchanged + ' / unreadable ' + tally.unreadable);
  for (const pkg of packages || []) {
    if (pkg.error) {
      lines.push('   ' + pkg.pkg + '  unreadable (' + pkg.error + ')');
      continue;
    }
    if ((pkg.rows || []).length === 0) continue;
    lines.push('   ' + pkg.pkg + '  patches:' + ((pkg.patches || []).join(',') || '-') + '  ' + pkg.rows.length + ' change(s)');
    for (const row of pkg.rows.slice(0, limit)) {
      lines.push('     ' + row.name + '  ' + row.change + '  ' + row.detail);
    }
    if (pkg.rows.length > limit) lines.push('     ... ' + (pkg.rows.length - limit) + ' more');
  }
  return lines;
}

// Which packages do the patches actually write into? Answered from the registry's own target table,
// never from a hand-copied list: that table is what apply writes. Two callers need the same answer
// (the CLI and the rehearsal), so it lives here once.
export function packageTargets(targetMap, aiBase) {
  const out = new Map();
  const base = String(aiBase || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  for (const [key, value] of Object.entries(targetMap || {})) {
    for (const file of (Array.isArray(value) ? value : [value])) {
      if (!file) continue;
      const full = String(file).replace(/\\/g, '/');
      if (!full.startsWith(base)) continue;
      const rel = full.slice(base.length);
      const pkg = rel.split('/')[0];
      if (!pkg || pkg.indexOf('dsh-') !== 0) continue;
      if (!out.has(pkg)) out.set(pkg, { pkg: pkg, keys: [] });
      const entry = out.get(pkg);
      if (entry.keys.indexOf(key) === -1) entry.keys.push(key);
    }
  }
  return out;
}

// The project leans on one premise everywhere: a patch rewrites text, it does not reshape what a
// module exports. That premise is what makes a behaviour assertion portable across versions, and
// what keeps 'the API is the same, only the wording changed' honest. Until now it was checked by
// hand twice. These are the changes that are deliberate - there is exactly one - and everything
// else is treated as an accident until somebody writes it down here with a reason.
export const KNOWN_SURFACE_CHANGES = [
  {
    patch: 42,
    pkg: 'dsh-settings',
    name: 'SettingsForms',
    change: 'proto',
    detail: '+commitLegacy,ensureLegacyDocument,get,persistLegacy,register',
    why: '#42 SETTINGS_LEGACY_API puts back the legacy document API: five prototype methods the official build dropped',
  },
];

// before = pristine tree, after = patched copy, so a '+' in the detail really is something the patch
// added. Callers that swap the two get a report full of minus signs and no expected matches.
export function checkInvariant(packages, known = KNOWN_SURFACE_CHANGES) {
  const allowed = new Set((known || []).map((entry) => [entry.pkg, entry.name, entry.change, entry.detail].join('|')));
  const expected = [];
  const unexpected = [];
  for (const pkg of packages || []) {
    for (const row of pkg.rows || []) {
      const item = { pkg: pkg.pkg, patches: pkg.patches || [], name: row.name, change: row.change, detail: row.detail };
      const key = [pkg.pkg, row.name, row.change, row.detail].join('|');
      if (allowed.has(key)) expected.push(item);
      else unexpected.push(item);
    }
  }
  return { expected: expected, unexpected: unexpected };
}

export function renderInvariant(result, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 20;
  const lines = [];
  lines.push('== surface invariant: ' + result.expected.length + ' known / ' + result.unexpected.length + ' unexpected');
  for (const item of result.expected.slice(0, limit)) {
    lines.push('   ok   ' + item.pkg + ' ' + item.name + ' ' + item.change + ' ' + item.detail);
  }
  for (const item of result.unexpected.slice(0, limit)) {
    lines.push('   NEW  ' + item.pkg + ' ' + item.name + ' ' + item.change + ' ' + item.detail + '  (patches ' + (item.patches.join(',') || '-') + ')');
  }
  if (result.unexpected.length > limit) lines.push('   ... ' + (result.unexpected.length - limit) + ' more');
  return lines;
}

export default {
  SURFACE_SCHEMA, KNOWN_SURFACE_CHANGES, packageTargets, describeValue, describeExport, describeModule,
  diffSurface, tallySurfaces, behaviourCandidates, renderSurfaces, checkInvariant, renderInvariant,
};