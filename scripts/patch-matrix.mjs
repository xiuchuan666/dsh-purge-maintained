#!/usr/bin/env node
// For every patch, is its anchor still alive in a pristine host tree?
//
// This is the instrument for 'which old patches still have work and which do not'. It runs on an
// npm-installed tree, never on the host we already patched: a hit on a patched tree only means
// the patch has not run yet, which is the opposite of the question.
//
// Four verdicts, deliberately not three:
//   live   the anchor is there; this patch still has work to do on this version.
//   dead   the anchor is gone. Either upstream deleted the code (retire) or upstream reworded
//          it while keeping the restriction (re-anchor). The matrix prints the anchor text so
//          the two can be told apart by reading, not by guessing.
//   trace  the anchor is the plugin's own [dsh-purge] trace, so it can only exist after we run.
//          A dead anchor here is the expected state, not a finding.
//   blind  no target file resolved in this tree (desktop shell, moved package). Says nothing
//          about the patch; says the tree cannot answer for it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as lib from './patch-matrix-lib.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function fail(message) {
  process.stderr.write('error: ' + message + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { trees: [], out: '', only: '', limit: 40, dead: false, live: false, stale: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(arg + ' needs a value');
      return v;
    };
    if (arg === '--tree') {
      const spec = next();
      const eq = spec.indexOf('=');
      if (eq <= 0) fail('--tree takes name=dir, got ' + spec);
      opts.trees.push({ name: spec.slice(0, eq), dir: spec.slice(eq + 1) });
    } else if (arg === '--json') opts.out = next();
    else if (arg === '--only') opts.only = next();
    else if (arg === '--limit') opts.limit = Number(next());
    else if (arg === '--dead') opts.dead = true;
    else if (arg === '--live') opts.live = true;
    else if (arg === '--stale') opts.stale = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'usage: patch-matrix.mjs [--tree name=DIR]... [--only NAME|ID] [--limit N] [--dead] [--live] [--json FILE]',
        '',
        '  --tree name=DIR   add a pristine tree (default: .tmp-tree/rc1/node_modules/@deepseek-ai)',
        '  --live            anchor present in the pristine tree: the patch still has work',
        '  --stale           anchor gone, gate still present: re-anchor the pattern',
        '  --dead            anchor gone, no gate: read before retiring',
        '  --json FILE       write the full matrix (docs/host-matrix.json)',
      ].join('\n') + '\n');
      process.exit(0);
    } else fail('unknown argument ' + arg);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.trees.length === 0) {
  const rc1 = path.join(root, '.tmp-tree', 'rc1', 'node_modules', '@deepseek-ai');
  const rc2 = path.join(root, '.tmp-tree', 'rc2', 'node_modules', '@deepseek-ai');
  for (const [name, dir] of [['rc1', rc1], ['rc2', rc2]]) {
    if (fs.existsSync(path.join(dir, 'dsh', 'package.json'))) opts.trees.push({ name, dir });
  }
}
if (opts.trees.length === 0) fail('no pristine tree found; pass --tree name=DIR pointing at an @deepseek-ai directory');

const core = await import(pathToFileURL(path.join(root, 'lib', 'core.js')).href);
const outcome = await import(pathToFileURL(path.join(root, 'lib', 'patch-outcome.mjs')).href);
const behaviorModule = await import(pathToFileURL(path.join(root, 'scripts', 'patch-behaviors.mjs')).href);
const gateLib = await import(pathToFileURL(path.join(root, 'scripts', 'patch-gate-lib.mjs')).href);
const behaviorsById = lib.collectBehaviorsById(behaviorModule.BEHAVIORS);
const patchIds = core.ALL_PATCHES.map((p) => p.id);

const perTree = {};
const meta = {};
const gateTally = {};
for (const tree of opts.trees) {
  const dir = path.resolve(tree.dir);
  const table = core.targetFiles(dir);
  // Gates are derived per tree: a needle is a fact about this version's text, not about the patch.
  const relOf = (file) => path.relative(dir, file).split(path.sep).join('/');
  const gates = gateLib.buildGates(core.ALL_PATCHES, table, gateLib.readFileFrom(dir), undefined, undefined, { relOf });
  perTree[tree.name] = core.ALL_PATCHES.map((patch) =>
    lib.describePatchInTree(patch, table, outcome, behaviorsById, gates.get(patch.id)));
  gateTally[tree.name] = gateLib.tallyGates(gates);
  let version = 'unknown';
  try {
    version = JSON.parse(fs.readFileSync(path.join(dir, 'dsh', 'package.json'), 'utf8')).version;
  } catch {
    version = 'unknown';
  }
  meta[tree.name] = { dir, version };
}

const treeNames = opts.trees.map((t) => t.name);
const merged = lib.mergeTrees(patchIds, perTree);
const newest = treeNames[treeNames.length - 1];
const rows = merged.map((entry) => entry.cells[newest] || entry.cells[treeNames[0]]).filter(Boolean);
const tally = lib.tallyVerdicts(rows);

let verdicts = null;
if (opts.dead) verdicts = [lib.MATRIX_VERDICTS.dead];
else if (opts.stale) verdicts = [lib.MATRIX_VERDICTS.stale];
else if (opts.live) verdicts = [lib.MATRIX_VERDICTS.live];
const header = treeNames.map((name) => name + ' (' + meta[name].version + ')').join(' vs ');
process.stdout.write('== anchor matrix: ' + header + '\n');
const view = lib.renderMatrix(merged, treeNames, { limit: opts.limit, only: opts.only, verdicts });
process.stdout.write((view || '(nothing matched)') + '\n');
process.stdout.write('-- summary (' + newest + '): ' + lib.MATRIX_VERDICT_LIST.map((k) => k + ' ' + (tally[k] || 0)).join(' / ') + '\n');
process.stdout.write('-- gates (' + newest + '): ' + Object.entries(gateTally[newest] || {})
  .filter(([, n]) => n > 0).map(([k, n]) => k + ' ' + n).join(' / ') + '\n');

if (!verdicts) {
  const dead = lib.renderDeadList(merged, newest, { limit: opts.limit });
  if (dead) process.stdout.write(dead + '\n');
}

const blindCount = rows.filter((r) => r.behaviors.length === 0).length;
process.stdout.write('-- behaviour coverage: ' + (rows.length - blindCount) + '/' + rows.length + ' patch(es) have an executable assertion\n');

if (opts.out) {
  const payload = {
    schema: lib.MATRIX_SCHEMA,
    kind: 'dsh-patch-matrix',
    capturedAt: new Date().toISOString(),
    trees: meta,
    tally,
    gates: gateTally,
    rows: merged.map((entry) => ({
      id: entry.id,
      name: entry.name,
      cells: Object.fromEntries(Object.entries(entry.cells).map(([name, cell]) => [name, cell ? {
        verdict: cell.verdict,
        hits: cell.hits,
        files: cell.files,
        resolved: cell.resolved,
        readable: cell.readable,
        insert: cell.insert,
        optional: cell.optional,
        anchor: cell.anchor,
        gate: cell.gate,
        gateReason: cell.gateReason,
        gatePresent: cell.gatePresent,
        behaviors: cell.behaviors,
      } : null])),
    })),
  };
  const file = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  process.stdout.write('-- wrote ' + opts.out + '\n');
}