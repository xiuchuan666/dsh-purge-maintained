#!/usr/bin/env node
// Draft a new patch entry from a line of upstream text.
//
// A patch is two things: an anchor that has to hit the byte exactly, and a replacement that says
// what the text should become. Only the first can be derived from the tree - and it should be, because
// hand-written anchors fail in both directions: too short hits three places, too long dies the next
// time upstream reflows the line. This script takes a line you can point at and grows the shortest
// substring of it that is unique in the file, then prints the entry you would append to the registry.
//
// Usage:
//   node scripts/new-patch.mjs --list-targets
//   node scripts/new-patch.mjs --pkg dsh-user-approval --rel lib/index.js --line 41
//   node scripts/new-patch.mjs --pkg dsh-sandbox --rel lib/index.js --needle switch
//   node scripts/new-patch.mjs --patch 12 --tree rc1=.tmp-tree/rc1/node_modules/@deepseek-ai
//
// What it will not do: guess the replacement, or invent an anchor when the needle is not found.
// A derived anchor that hits nowhere is worse than no draft at all - it looks done.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { anchorForLine, occurrences, renderAnchor, lineOfIndex } from './anchor-lib.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function fail(message) {
  process.stderr.write('error: ' + message + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { trees: [], pkg: '', rel: '', line: 0, needle: '', patch: 0, id: 0, name: '', json: false, listTargets: false };
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
    } else if (arg === '--pkg') opts.pkg = next();
    else if (arg === '--rel') opts.rel = next();
    else if (arg === '--line') opts.line = Number(next());
    else if (arg === '--needle') opts.needle = next();
    else if (arg === '--patch') opts.patch = Number(next());
    else if (arg === '--id') opts.id = Number(next());
    else if (arg === '--name') opts.name = next();
    else if (arg === '--json') opts.json = true;
    else if (arg === '--list-targets') opts.listTargets = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'usage: new-patch.mjs [--pkg PKG --rel REL | --patch ID] [--line N | --needle TEXT]',
        '                     [--tree name=DIR] [--id N] [--name NAME] [--json] [--list-targets]',
        '',
        '  --line N        the 1-based line to anchor on (default: the line the needle lands on)',
        '  --needle TEXT   locate by text instead of line number',
        '  --patch ID      re-anchor an existing patch: read its first target file and pattern',
        '  --list-targets  print the key -> path table targetFiles() resolves on the chosen tree',
      ].join('\n') + '\n');
      process.exit(0);
    } else fail('unknown argument ' + arg);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.trees.length === 0) {
  const rc1 = path.join(root, '.tmp-tree', 'rc1', 'node_modules', '@deepseek-ai');
  if (fs.existsSync(path.join(rc1, 'dsh', 'package.json'))) opts.trees.push({ name: 'rc1', dir: rc1 });
}
if (opts.trees.length === 0) fail('no pristine tree: pass --tree name=DIR (an npm install of @deepseek-ai/dsh)');
const tree = opts.trees[opts.trees.length - 1];
const aiBase = path.resolve(tree.dir);

const core = await import(pathToFileURL(path.join(root, 'lib', 'core.js')).href);
const patches = core.ALL_PATCHES;
const table = core.targetFiles(aiBase);

function valuesOf(entry) {
  return Array.isArray(entry) ? entry : [entry];
}

if (opts.listTargets) {
  const rows = [];
  for (const [key, entry] of Object.entries(table)) {
    for (const file of valuesOf(entry)) {
      if (!file) continue;
      rows.push([key, path.relative(aiBase, file).split(path.sep).join('/')]);
    }
  }
  rows.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  process.stdout.write('== target keys on ' + tree.name + ' (' + rows.length + ' paths)\n');
  for (const [key, rel] of rows) process.stdout.write('  ' + key.padEnd(24) + ' ' + rel + '\n');
  process.exit(0);
}

// Resolve which file to look at. --patch reads the patch's own first target, which is how you
// re-anchor a patch whose pattern has gone dead. --pkg/--rel points at a file directly.
let patch = null;
let file = '';
if (opts.patch) {
  patch = patches.find((p) => p.id === opts.patch);
  if (!patch) fail('no patch with id ' + opts.patch);
  const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
  for (const key of keys) {
    for (const candidate of valuesOf(table[key])) {
      if (candidate && fs.existsSync(candidate)) { file = candidate; break; }
    }
    if (file) break;
  }
  if (!file) fail('patch ' + opts.patch + ' has no readable target on ' + tree.name + ' (keys: ' + keys.join(', ') + ')');
} else {
  if (!opts.pkg) fail('need --pkg PKG --rel REL, or --patch ID');
  const rel = opts.rel || 'lib/index.js';
  file = path.join(aiBase, opts.pkg, rel);
  if (!fs.existsSync(file)) fail('no such file: ' + path.relative(aiBase, file).split(path.sep).join('/'));
}

const text = fs.readFileSync(file, 'utf8');
const relFile = path.relative(aiBase, file).split(path.sep).join('/');

// Locate the line: by --needle, by --line, or - for --patch - by the patch's own first pattern.
let line = opts.line;
if (!line && opts.needle) {
  const at = text.indexOf(opts.needle);
  if (at < 0) fail('needle not found in ' + relFile + ' - refusing to guess a location');
  line = lineOfIndex(text, at);
}
if (!line && patch) {
  const first = (patch.replacements && patch.replacements[0]) || (patch.patterns && patch.patterns[0]);
  const raw = first && first.pattern !== undefined ? first.pattern : first;
  if (raw) {
    const probe = typeof raw === 'string' ? raw.split('\n').map((s) => s.trim()).filter(Boolean)[0] : '';
    if (probe) {
      const at = text.indexOf(probe);
      if (at >= 0) line = lineOfIndex(text, at);
    }
  }
}
// The patch's own pattern can be dead while the restriction is alive (#12 is the standing case).
// The gate needle is grown from the file itself, so it still points at the line you want to re-anchor.
if (!line && patch) {
  const gateLib = await import('./patch-gate-lib.mjs');
  const gates = gateLib.buildGates(patches, table, gateLib.readFileFrom(aiBase));
  const gate = gates.get(patch.id);
  if (gate && gate.needle && String(gate.rel).split('\\').join('/') === relFile) {
    const at = text.indexOf(gate.needle);
    if (at >= 0) line = lineOfIndex(text, at);
  }
}
if (!line) fail('need --line N or --needle TEXT (could not derive a location for ' + relFile + ')');

const lines = text.split('\n');
if (line < 1 || line > lines.length) fail('line ' + line + ' is outside ' + relFile + ' (1..' + lines.length + ')');
const lineText = lines[line - 1].replace(/\r$/, '');

const anchor = anchorForLine(text, line);
if (!anchor) fail('could not derive an anchor on line ' + line + ' (blank line?)');
// A unique window may have to cross a line break (two identical lines in one file). For a gate that
// is forbidden - it dies on the next reflow - and for a patch pattern it means the anchor is really
// 'this line plus a character of the next', which is unreadable and breaks on rename. Treat the
// in-line window as the unit: if the shortest unique one spills over, say so instead of shipping it.
const spillsOver = anchor.anchor.indexOf('\n') >= 0;
const unique = anchor.unique && !spillsOver;
const hits = occurrences(text, anchor.anchor).length;

// Which registry key points at this file? That is what the patch entry has to name - not a path.
const keys = [];
for (const [key, entry] of Object.entries(table)) {
  for (const candidate of valuesOf(entry)) {
    if (candidate && path.resolve(candidate) === path.resolve(file)) keys.push(key);
  }
}

const nextId = opts.id || (Math.max(...patches.map((p) => p.id)) + 1);
const slugBase = (opts.pkg || String(relFile).split('/')[0]).replace(/^dsh-/, '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
const slug = opts.name || ('TODO_' + slugBase + '_' + line);
const markerSlug = slug.toLowerCase().split('_').filter(Boolean).join('-');
const draft = {
  id: nextId,
  name: slug,
  layer: '代码',
  layer_en: 'code',
  desc: 'TODO: what this patch takes away, in one sentence',
  file: keys[0] || 'TODO_KEY',
  replacements: [{ pattern: anchor.anchor, replace: 'TODO: the text to leave behind' }],
  markers: ['[dsh-purge] ' + markerSlug],
};

if (opts.json) {
  process.stdout.write(JSON.stringify({
    tree: { name: tree.name, aiBase },
    file: relFile,
    line,
    lineText,
    anchor: anchor.anchor,
    anchorUnique: unique,
    occurrences: hits,
    keys,
    draft,
  }, null, 2) + '\n');
  process.exit(unique ? 0 : 1);
}

process.stdout.write('== locate: ' + relFile + ':' + line + '  (' + tree.name + ')\n');
process.stdout.write('   ' + lineText.trim().slice(0, 110) + '\n');
process.stdout.write('   anchor: ' + renderAnchor(anchor.anchor, { width: 96 }) + '\n');
if (!unique && spillsOver) {
  process.stdout.write('   !! not unique within one line - the shortest unique window crosses a line break; pick a needle with more context on the same line\n');
} else if (!unique) {
  process.stdout.write('   !! not unique in this file (' + hits + ' occurrences) - pass a narrower needle\n');
} else {
  process.stdout.write('   unique in file, ' + anchor.anchor.length + ' chars, slack ' + anchor.slack + '\n');
}

// No draft when the anchor is not usable: a pattern that hits twice edits two places, and a
// cross-line pattern breaks on the next reflow. Printing it anyway is how a bad anchor gets pasted.
if (!unique) {
  process.stdout.write('\n-- no draft: the anchor above is not usable as a patch pattern\n');
  process.exit(1);
}

process.stdout.write('\n-- registry key(s) pointing at this file\n');
if (keys.length === 0) process.stdout.write('   (none - this file is not a patch target yet; you would also add a key in lib/core.js targetFiles)\n');
for (const key of keys) process.stdout.write('   ' + key + '\n');

process.stdout.write('\n-- draft entry\n');
process.stdout.write(JSON.stringify(draft, null, 2).split('\n').map((s) => '  ' + s).join('\n') + '\n');

process.stdout.write([
  '',
  '-- next',
  '  1) paste the entry into lib/patches/new-tool-patches.mjs (or engine-patches.mjs) and fill the replace text',
  '  2) npm run host:matrix -- --tree ' + tree.name + '=' + path.relative(root, aiBase).split(path.sep).join('/') + '   # it should read live',
  '  3) npm run host:gates -- --write docs/patch-gates.json                            # the gate should be unique',
  '  4) add a behaviour assertion in scripts/patch-behaviors.mjs if the patch has a callable surface',
  '  5) npm run check',
].join('\n') + '\n');