#!/usr/bin/env node
// Surface diff: for every package a patch writes into, describe the export surface on both trees and
// show what changed.
//
// Behaviour assertions cover 12 of 86 because each one needed a hand-picked observation point. This
// finds the ones that are mechanical: a raised schema default, five added prototype methods, a renamed
// export. A package with a surface difference is a candidate for a behaviour assertion; a package with
// none is not broken (the patch may only reword a sentence) but it will never get behavioural evidence.
//
// Usage:
//   node scripts/surface-diff.mjs
//   node scripts/surface-diff.mjs --baseline-tree DIR --ai-base DIR --json FILE --only PKG --limit 8
//   node scripts/surface-diff.mjs --baseline-tree PATCHED --ai-base PRISTINE --all
//
// With both trees on the same upstream version, every difference is something a patch did, and the
// run also checks the invariant the whole project rests on: a patch rewrites text, it does not reshape
// what a module exports. Known exceptions live in KNOWN_SURFACE_CHANGES with a reason.
//
// Exit codes: 0 = ran / 1 = a package failed to load, or an undeclared export reshape / 2 = usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as core from '../lib/core.js';
import * as lib from './surface-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function usage(message) {
  if (message) console.error('[surfaces] ' + message);
  console.error('[surfaces] usage: surface-diff.mjs [--baseline-tree DIR] [--ai-base DIR] [--json FILE] [--only PKG] [--limit N] [--all]');
  console.error('[surfaces] --all  skip the export-surface invariant (it only means something on one version)');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { baseline: '', host: '', json: '', only: '', limit: 8, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const need = () => {
      const value = argv[i + 1];
      if (value === undefined) usage(arg + ' needs a value');
      i += 1;
      return value;
    };
    if (arg === '--baseline-tree') args.baseline = need();
    else if (arg === '--ai-base') args.host = need();
    else if (arg === '--json') args.json = need();
    else if (arg === '--only') args.only = need();
    else if (arg === '--limit') args.limit = Number(need());
    else if (arg === '--all') args.all = true;
    else if (arg === '--help' || arg === '-h') usage();
    else usage('unknown argument ' + arg);
  }
  return args;
}

function versionOf(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'dsh', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function defaultBaseline() {
  return path.join(ROOT, '.tmp-tree', 'rc1', 'node_modules', '@deepseek-ai');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseline = path.resolve(args.baseline || defaultBaseline());
  const host = path.resolve(args.host || core.findAiBase({}) || '');
  if (!fs.existsSync(path.join(baseline, 'dsh', 'package.json'))) usage('no baseline tree at ' + baseline);
  if (!host || !fs.existsSync(path.join(host, 'dsh', 'package.json'))) usage('no host tree; pass --ai-base DIR');

  // Packages come from the registry's own target table, never from a hand-copied list: that table is
  // what apply actually writes.
  const targets = core.targetFiles(host);
  const byKey = new Map();
  for (const patch of core.ALL_PATCHES) {
    for (const key of (Array.isArray(patch.file) ? patch.file : [patch.file])) {
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(patch.id);
    }
  }
  const patchesByPkg = new Map();
  for (const [pkg, entry] of lib.packageTargets(targets, host)) {
    const ids = new Set();
    for (const key of entry.keys) for (const id of (byKey.get(key) || [])) ids.add(id);
    patchesByPkg.set(pkg, ids);
  }

  const rows = [];
  for (const [pkg, ids] of [...patchesByPkg.entries()].sort()) {
    if (args.only && pkg !== args.only) continue;
    const entry = { pkg: pkg, patches: [...ids].sort((a, b) => a - b), rows: [] };
    const left = path.join(baseline, pkg, 'lib', 'index.js');
    const right = path.join(host, pkg, 'lib', 'index.js');
    if (!fs.existsSync(left) || !fs.existsSync(right)) {
      entry.error = fs.existsSync(left) ? 'not in host' : 'not in baseline';
      rows.push(entry);
      continue;
    }
    try {
      const before = lib.describeModule(await import(pathToFileURL(left).href));
      const after = lib.describeModule(await import(pathToFileURL(right).href));
      entry.rows = lib.diffSurface(before, after);
    } catch (error) {
      entry.error = String(error && error.message ? error.message : error).slice(0, 120);
    }
    rows.push(entry);
  }

  console.log('== surfaces: baseline ' + versionOf(baseline) + ' / host ' + versionOf(host) + ' / ' + rows.length + ' package(s)');
  for (const line of lib.renderSurfaces(rows, { limit: args.limit })) {
    if (line.indexOf('== surfaces:') === 0) continue;
    console.log(line);
  }
  const candidates = lib.behaviourCandidates(rows);
  console.log('');
  console.log('-- ' + candidates.length + ' package(s) have a callable surface change: ' + candidates.map((c) => c.pkg).join(' '));
  console.log('-- ' + (rows.length - candidates.length) + ' package(s) changed only text: their evidence stays the five-state judgement');

  // The invariant only means something when both sides are the same upstream version: then every row
  // is something a patch did. Comparing rc.1 to rc.2 describes upstream drift, and calling that
  // unexpected would be wrong every time the host is bumped.
  const sameVersion = versionOf(baseline) === versionOf(host) && versionOf(baseline) !== 'unknown';
  let invariant = null;
  if (sameVersion && !args.all) {
    invariant = lib.checkInvariant(rows);
    console.log('');
    for (const line of lib.renderInvariant(invariant, { limit: args.limit })) console.log(line);
    if (invariant.unexpected.length === 0) {
      console.log('[surfaces] PASS  every export-surface change is a written-down one');
    } else {
      console.log('[surfaces] FAIL  ' + invariant.unexpected.length + ' export-surface change(s) nobody declared: a patch reshaped an API');
    }
  } else if (!sameVersion) {
    console.log('');
    console.log('-- export-surface invariant not checked: ' + versionOf(baseline) + ' vs ' + versionOf(host) + ' is upstream drift, not a patch effect');
  }

  if (args.json) {
    const file = path.resolve(args.json);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: lib.SURFACE_SCHEMA, kind: 'dsh-surface-diff', capturedAt: new Date().toISOString(), baseline: baseline, host: host, sameVersion: sameVersion, invariant: invariant, packages: rows }, null, 2) + '\n');
    console.log('-- wrote ' + file);
  }
  const failed = rows.some((row) => row.error) || Boolean(invariant && invariant.unexpected.length > 0);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('[surfaces] ' + (error && error.stack ? error.stack : error));
  process.exit(2);
});