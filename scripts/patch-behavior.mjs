#!/usr/bin/env node
// Behavioural cross-check for dsh-purge patches.
//
// Loads the same module twice — once from a pristine upstream tree (npm-installed rc.N)
// and once from the live host — runs every registered behaviour on both, and asserts
// 'blocked before, released after'. A marker in a file proves nothing about behaviour;
// this is the only check that fails when a patch silently stops removing a restriction.
//
// Usage:
//   node scripts/patch-behavior.mjs
//       --baseline-tree DIR   pristine upstream tree (…/node_modules/@deepseek-ai)
//       --ai-base DIR         live host (default: auto-detected)
//       --only NAME[,NAME]    run a subset
//       --json FILE           write the machine-readable result
//       --limit N             rows per state in the report (default 60)
//
// Exit codes: 0 = every behaviour ok or already / 1 = broken, inert or unexpected / 2 = usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BEHAVIOR_SCHEMA,
  observe,
  judge,
  tallyStates,
  isFailure,
  needsHuman,
  coveredPatchIds,
  uncoveredPatchIds,
  describeBehaviors,
  renderBehaviorReport,
  moduleLoader,
} from './behavior-lib.mjs';
import { BEHAVIORS } from './patch-behaviors.mjs';
import { ALL_PATCHES } from '../lib/patches/index.mjs';
import { findAiBase } from './host-baseline-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_BASELINE = path.join(ROOT, '.tmp-tree', 'rc1', 'node_modules', '@deepseek-ai');

function usage(message) {
  if (message) console.error('[behaviour] ' + message);
  console.error('[behaviour] usage: patch-behavior.mjs [--ai-base DIR] [--baseline-tree DIR] [--only NAME] [--json FILE] [--limit N]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { only: [], limit: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const need = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usage(arg + ' needs a value');
      i += 1;
      return value;
    };
    if (arg === '--ai-base') args.aiBase = need();
    else if (arg === '--baseline-tree') args.baseline = need();
    else if (arg === '--only') args.only = need().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--json') args.json = need();
    else if (arg === '--limit') args.limit = Number(need());
    else if (arg === '--help' || arg === '-h') usage();
    else usage('unknown argument ' + arg);
  }
  return args;
}

function resolveBaseline(explicit) {
  const dir = explicit ? path.resolve(explicit) : DEFAULT_BASELINE;
  if (!fs.existsSync(path.join(dir, 'dsh', 'package.json'))) {
    console.error('[behaviour] baseline tree not found: ' + dir);
    console.error('[behaviour] install one first, e.g. npm install --no-save --ignore-scripts @deepseek-ai/dsh@0.2.2-rc.1 into .tmp-tree/rc1');
    process.exit(1);
  }
  return dir;
}

function resolveHost(explicit, baseline) {
  if (explicit) return path.resolve(explicit);
  const found = findAiBase({});
  if (found) return found;
  return baseline;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseline = resolveBaseline(args.baseline);
  const host = resolveHost(args.aiBase, baseline);
  const sameTree = path.resolve(baseline) === path.resolve(host);

  const selected = args.only.length === 0
    ? BEHAVIORS
    : BEHAVIORS.filter((b) => args.only.includes(b.id) || args.only.includes(String(b.module)));
  if (selected.length === 0) usage('no behaviour matched --only ' + args.only.join(','));

  const loadOrig = moduleLoader(baseline);
  const loadPatched = moduleLoader(host);

  const results = [];
  for (const behavior of selected) {
    // Isolate: a throw inside one tree must not stop the other tree from being observed.
    const orig = await observe(behavior, loadOrig);
    const patched = await observe(behavior, loadPatched);
    const verdict = judge(behavior, orig, patched);
    results.push({
      id: behavior.id,
      title: behavior.title,
      module: behavior.module,
      kind: behavior.kind || 'behaviour',
      covers: [...(behavior.covers || [])],
      state: verdict.state,
      reasons: verdict.reasons,
      expected: { orig: behavior.orig, patched: behavior.patched },
      observed: { orig, patched },
    });
  }

  console.log('[behaviour] baseline ' + baseline);
  console.log('[behaviour] host     ' + host + (sameTree ? '  (SAME TREE: only a smoke test)' : ''));
  console.log(renderBehaviorReport(results, { limit: args.limit }));

  const covered = coveredPatchIds(selected);
  const allIds = ALL_PATCHES.map((patch) => patch.id);
  const uncovered = uncoveredPatchIds(selected, allIds);
  console.log('[behaviour] covers ' + covered.length + '/' + allIds.length + ' patch id(s): ' + covered.join(','));
  console.log('[behaviour] no behaviour assertion yet: ' + uncovered.length + ' patch(es)');

  const tally = tallyStates(results);
  const failing = results.filter((r) => isFailure(r) || needsHuman(r));
  if (failing.length > 0) {
    console.log('');
    console.log('[behaviour] needs attention: ' + failing.map((r) => r.id).join(', '));
  }

  if (args.json) {
    const payload = {
      schema: BEHAVIOR_SCHEMA,
      kind: 'dsh-behaviour-report',
      capturedAt: new Date().toISOString(),
      baseline,
      host,
      sameTree,
      tally,
      covered,
      uncovered,
      behaviours: describeBehaviors(selected),
      results,
    };
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(payload, null, 2) + String.fromCharCode(10));
    console.log('[behaviour] wrote ' + path.resolve(args.json));
  }

  const bad = results.some((r) => isFailure(r) || needsHuman(r));
  process.exit(bad ? 1 : 0);
}

main().catch((error) => {
  console.error('[behaviour] crashed: ' + (error && error.stack ? error.stack : String(error)));
  process.exit(1);
});