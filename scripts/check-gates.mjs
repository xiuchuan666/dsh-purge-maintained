#!/usr/bin/env node
// Keep docs/patch-gates.json honest without a host tree.
//
// CI runs on a bare ubuntu box: no DeepSeek Harness install, so it cannot re-derive a gate and
// cannot ask whether a restriction is still upstream. What it CAN check is the contract between the
// side table and the registry, and that contract is where the table silently rots:
//
//   - a patch is added and nobody records a gate, so the table claims 86 rows while the registry has 87;
//   - a patch is renamed and the table keeps the old name, so a reader matches on the wrong line;
//   - a needle is written as an absolute path or spans a newline, which makes it machine-specific
//     and reflow-fragile respectively - the two things a gate exists to avoid.
//
// All of those are decidable from the two files alone. The things that are NOT decidable here are
// stated as such in the report rather than skipped quietly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// The vocabulary a row may use. Anything else is a typo that would read as a real outcome.
export const REASONS = ['gated', 'no-target', 'no-pattern', 'regex-only', 'ambiguous', 'unreadable', 'not-found', 'trace-anchored', 'native'];

export function checkTable(table, patches) {
  const problems = [];
  const warnings = [];
  const rows = Array.isArray(table && table.rows) ? table.rows : null;
  if (!rows) return { problems: ['side table has no rows array'], warnings, stats: {} };

  const byId = new Map();
  // A gated row carries a needle and no reason; every other row carries a reason and no needle.
  // Normalize once here so the rest of the check reads one field.
  for (const row of rows) {
    if (!row.reason) row.reason = row.needle ? 'gated' : 'unknown';
    if (row.reason === 'unknown') problems.push('row ' + row.patch + ' has neither a needle nor a reason - it records nothing');
    if (!Number.isInteger(row.patch)) { problems.push('row with non-integer patch id: ' + JSON.stringify(row).slice(0, 80)); continue; }
    if (byId.has(row.patch)) problems.push('duplicate row for patch ' + row.patch);
    byId.set(row.patch, row);
  }

  const known = new Map(patches.map((p) => [p.id, p]));
  for (const id of known.keys()) if (!byId.has(id)) problems.push('patch ' + id + ' (' + known.get(id).name + ') has no row - regenerate with npm run host:gates -- --write docs/patch-gates.json');
  for (const id of byId.keys()) if (!known.has(id)) problems.push('row ' + id + ' (' + byId.get(id).name + ') has no patch - the registry dropped it, regenerate the table');

  let gated = 0;
  const reasonCount = {};
  for (const [id, row] of byId) {
    const patch = known.get(id);
    if (patch && row.name && row.name !== patch.name) {
      problems.push('patch ' + id + ' is named ' + patch.name + ' but the table says ' + row.name + ' - regenerate the table');
    }
    if (!REASONS.includes(row.reason)) {
      problems.push('row ' + id + ' has unknown reason ' + JSON.stringify(row.reason));
    }
    reasonCount[row.reason] = (reasonCount[row.reason] || 0) + 1;
    if (row.reason !== 'gated') {
      if (row.needle) warnings.push('row ' + id + ' has a needle but reason ' + row.reason);
      continue;
    }
    gated++;
    if (typeof row.needle !== 'string' || row.needle.length === 0) problems.push('gated row ' + id + ' has no needle');
    else {
      if (row.needle.indexOf('\n') >= 0 || row.needle.indexOf('\r') >= 0) problems.push('gated row ' + id + ' has a needle spanning lines - it will break on the next reflow');
      if (row.needle.length < 8) problems.push('gated row ' + id + ' has a needle of ' + row.needle.length + ' chars - too short to be meaningful');
    }
    if (typeof row.rel !== 'string' || row.rel.length === 0) problems.push('gated row ' + id + ' has no rel');
    else if (/^[A-Za-z]:[\\/]/.test(row.rel) || row.rel.startsWith('/')) problems.push('gated row ' + id + ' stores an absolute path (' + row.rel + ') - the table must be machine-independent');
    if (!Number.isInteger(row.line) || row.line < 1) problems.push('gated row ' + id + ' has no line number');
  }

  return {
    problems,
    warnings,
    stats: { rows: rows.length, patches: patches.length, gated, reasonCount },
  };
}

// What this check cannot say, printed every run so nobody reads PASS as more than it is.
export const NOT_CHECKED = [
  'whether a gate still exists in the current upstream (needs a host tree: npm run host:gates -- --compare)',
  'whether a gated patch still has work to do (needs a host tree: npm run host:matrix)',
  'whether the needle is unique in the live file (it was when written; re-derive on each host bump)',
];

export function renderReport(result) {
  const { problems, warnings, stats } = result;
  const lines = [];
  lines.push('[gates] ' + stats.rows + ' rows for ' + stats.patches + ' patches, ' + stats.gated + ' gated');
  const breakdown = Object.entries(stats.reasonCount || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + n).join(' / ');
  if (breakdown) lines.push('[gates]   ' + breakdown);
  for (const w of warnings) lines.push('[gates] ! ' + w);
  for (const p of problems) lines.push('[gates] x ' + p);
  lines.push(problems.length === 0 ? '[gates] PASS' : '[gates] FAIL ' + problems.length + ' problem(s)');
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const file = path.join(root, 'docs', 'patch-gates.json');
  if (!fs.existsSync(file)) {
    process.stderr.write('[gates] no docs/patch-gates.json - run npm run host:gates -- --write docs/patch-gates.json\n');
    process.exit(1);
  }
  const table = JSON.parse(fs.readFileSync(file, 'utf8'));
  const core = await import(pathToFileURL(path.join(root, 'lib', 'core.js')).href);
  const result = checkTable(table, core.ALL_PATCHES);
  process.stdout.write(renderReport(result) + '\n');
  process.stdout.write('[gates] not checked here: ' + NOT_CHECKED.join('; ') + '\n');
  process.exit(result.problems.length === 0 ? 0 : 1);
}