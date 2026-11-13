#!/usr/bin/env node
// Write and compare the gate side table: one short needle per patch that says whether the
// restriction it removes is still in the upstream text.
//
// The matrix already answers 'does the patch's own pattern still match'. That question has a blind
// spot: #12's pattern quoted a whole sentence, upstream reworded both ends, and the pattern went dead
// while the restriction stayed. Reading only the matrix would retire a patch that still has work.
// A gate is that second opinion: short, inside one line, and grown from the located text so it is
// as wide as uniqueness requires and no wider.
//
// Usage:
//   node scripts/patch-gates.mjs                       # derive from .tmp-tree/rc1, print the table
//   node scripts/patch-gates.mjs --write docs/patch-gates.json
//   node scripts/patch-gates.mjs --tree rc2=.tmp-tree/rc2/node_modules/@deepseek-ai --compare
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as gateLib from './patch-gate-lib.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function fail(message) {
  process.stderr.write('error: ' + message + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { trees: [], write: '', compare: false, only: '', limit: 0, reasons: false };
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
    } else if (arg === '--write') opts.write = next();
    else if (arg === '--compare') opts.compare = true;
    else if (arg === '--only') opts.only = next();
    else if (arg === '--limit') opts.limit = Number(next());
    else if (arg === '--reasons') opts.reasons = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'usage: patch-gates.mjs [--tree name=DIR]... [--write FILE] [--compare] [--only NAME|ID] [--limit N] [--reasons]',
        '',
        '  --write FILE   write the side table (docs/patch-gates.json)',
        '  --compare      show gates that differ between trees (needle moved or disappeared)',
        '  --reasons      also list patches that have no gate, with the reason',
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
if (opts.trees.length === 0) fail('no pristine tree: pass --tree name=DIR (an npm install of @deepseek-ai/dsh)');

const core = await import(pathToFileURL(path.join(root, 'lib', 'core.js')).href);
const patches = core.ALL_PATCHES;

const perTree = new Map();
const meta = {};
for (const tree of opts.trees) {
  const dir = path.resolve(tree.dir);
  const table = core.targetFiles(dir);
  const relOf = (file) => path.relative(dir, file).split(path.sep).join('/');
  const gates = gateLib.buildGates(patches, table, gateLib.readFileFrom(dir), undefined, undefined, { relOf });
  perTree.set(tree.name, gates);
  let version = 'unknown';
  try {
    version = JSON.parse(fs.readFileSync(path.join(dir, 'dsh', 'package.json'), 'utf8')).version;
  } catch {
    version = 'unknown';
  }
  meta[tree.name] = { dir, version };
}

const names = opts.trees.map((t) => t.name);
const primary = names[names.length - 1];
const gates = perTree.get(primary);
const tally = gateLib.tallyGates(gates);

process.stdout.write('== gates: ' + names.map((n) => n + ' (' + meta[n].version + ')').join(' vs ') + '\n');
process.stdout.write('-- ' + Object.entries(tally).filter(([, n]) => n > 0).map(([k, n]) => k + ' ' + n).join(' / ') + '\n');

let shown = 0;
const limit = opts.limit > 0 ? opts.limit : Number.MAX_SAFE_INTEGER;
for (const patch of patches) {
  if (opts.only && patch.name !== opts.only && String(patch.id) !== opts.only) continue;
  const gate = gates.get(patch.id);
  if (!gate.needle && !opts.reasons) continue;
  if (shown >= limit) {
    process.stdout.write('... (truncated at ' + limit + ')\n');
    break;
  }
  const where = gate.needle ? (gate.rel || path.basename(String(gate.file || ''))) + ':' + gate.line : '';
  const note = gate.needle ? (gate.hand ? ' hand' : '') : ' (' + gate.reason + ')' + (gate.note ? ' ' + gate.note : '');
  process.stdout.write(String(patch.id).padStart(3) + ' ' + String(patch.name).padEnd(34) + ' ' +
    (gate.needle ? gateLib.renderGate(gate, { width: 60 }) : '-').padEnd(62) + ' ' + where + note + '\n');
  shown++;
}

if (opts.compare && names.length > 1) {
  process.stdout.write('\n-- differences (' + names[0] + ' -> ' + primary + ')\n');
  let diffs = 0;
  for (const patch of patches) {
    const a = perTree.get(names[0]).get(patch.id);
    const b = gates.get(patch.id);
    const aKey = a && a.needle ? a.needle : '(' + (a && a.reason) + ')';
    const bKey = b && b.needle ? b.needle : '(' + (b && b.reason) + ')';
    if (aKey === bKey) continue;
    diffs++;
    process.stdout.write('  #' + String(patch.id).padEnd(3) + ' ' + String(patch.name).padEnd(34) + ' ' +
      aKey.slice(0, 44) + '  ->  ' + bKey.slice(0, 44) + '\n');
  }
  if (diffs === 0) process.stdout.write('  (identical)\n');
}

if (opts.write) {
  const payload = gateLib.serializeGates(gates);
  payload.capturedAt = new Date().toISOString();
  payload.tree = meta[primary];
  const file = path.resolve(opts.write);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  process.stdout.write('-- wrote ' + opts.write + ' (' + payload.rows.length + ' rows)\n');
}