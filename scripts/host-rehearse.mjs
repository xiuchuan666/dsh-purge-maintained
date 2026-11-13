#!/usr/bin/env node
// Rehearsal: run the upgrade before it happens.
//
// A rehearsal takes a PRISTINE install of the next host version, patches a throwaway COPY of it
// with the whole registry, and then asks five independent questions about the result:
//
//   apply      did every anchor still land?            (core.applyPatches + rehearse-lib buckets)
//   outcome    is each patch applied, native, stale?   (lib/patch-outcome.mjs, seven states)
//   behaviour  does the restriction actually go away?  (scripts/behavior-lib.mjs, cross-tree)
//   choke      did the new version grow a gate we do not cover?  (chokepoints-lib gaps)
//   gates      does docs/patch-gates.json still describe this tree?  (gate-verify-lib)
//
// Any one of these alone lies. Markers in files prove the text changed, not that the behaviour did;
// behaviour only covers 12 of 86 patches; the choke scan cannot see what it has no shape for.
// the gate table is an observation of one version's text, so a miss on another version is drift
// (expected, and the count is the re-derive job) while a miss on the pinned version means the
// table and the tree stopped describing each other;
// Together they are the answer to 'can we ship this version'.
//
// Usage:
//   node scripts/host-rehearse.mjs                        # baseline .tmp-tree/rc1/... , patch a copy
//   node scripts/host-rehearse.mjs --version rc2          # baseline .tmp-tree/rc2/node_modules/@deepseek-ai
//   node scripts/host-rehearse.mjs --baseline-tree DIR    # explicit pristine @deepseek-ai tree
//   node scripts/host-rehearse.mjs --work DIR --keep      # where the patched copy goes, and keep it
//   node scripts/host-rehearse.mjs --skip choke,gates   # run a subset
//   node scripts/host-rehearse.mjs --json out.json --limit 10
//
// Exit codes: 0 = all five green / 1 = something blocks the upgrade / 2 = usage or environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ALL_PATCHES } from '../lib/patches/index.mjs';
import * as core from '../lib/core.js';
import { classifyPatch, tallyStates as tallyOutcome, STATE_LIST, UNKNOWN } from '../lib/patch-outcome.mjs';
import { BEHAVIORS } from './patch-behaviors.mjs';
import {
  observe, judge, tallyStates as tallyBehaviour, isFailure, needsHuman, moduleLoader,
} from './behavior-lib.mjs';
import {
  scanShapes, parseDumpConfig, findShortCircuits, correlate, findGaps,
} from './chokepoints-lib.mjs';
import { readHostVersion } from './host-snapshot-lib.mjs';
import { verifyGates } from './gate-verify-lib.mjs';
import * as surfaces from './surface-lib.mjs';
import { findAiBase, resolveAiBase } from './host-baseline-lib.mjs';
import * as lib from './rehearse-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STEP_IDS = ['apply', 'outcome', 'behaviour', 'choke', 'gates', 'surfaces'];

function usage(message) {
  if (message) console.error('[rehearse] ' + message);
  console.error('[rehearse] usage: host-rehearse.mjs [--baseline-tree DIR] [--version rcN] [--work DIR] [--keep] [--skip a,b] [--json FILE] [--limit N]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { skip: [], limit: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const need = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usage(arg + ' needs a value');
      i += 1;
      return value;
    };
    if (arg === '--baseline-tree') args.baseline = need();
    else if (arg === '--version') args.version = need();
    else if (arg === '--work') args.work = need();
    else if (arg === '--skip') args.skip = need().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--json') args.json = need();
    else if (arg === '--limit') args.limit = Number(need());
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--help' || arg === '-h') usage();
    else usage('unknown argument ' + arg);
  }
  for (const id of args.skip) if (!STEP_IDS.includes(id)) usage('unknown step to skip: ' + id);
  return args;
}

function defaultBaseline(version) {
  const name = version ? (String(version).startsWith('rc') ? String(version) : 'rc' + version) : 'rc1';
  return path.join(ROOT, '.tmp-tree', name, 'node_modules', '@deepseek-ai');
}

// A baseline we cannot import is not a baseline: every later step loads modules out of it.
function resolveBaseline(args) {
  const raw = args.baseline ? path.resolve(args.baseline) : defaultBaseline(args.version);
  const dir = fs.existsSync(path.join(raw, 'dsh', 'package.json')) ? raw : resolveAiBase(raw);
  if (!fs.existsSync(path.join(dir, 'dsh', 'package.json'))) {
    console.error('[rehearse] baseline tree not found: ' + dir);
    console.error('[rehearse] install one first, e.g. npm install --no-save --ignore-scripts @deepseek-ai/dsh@0.2.2-rc.2 into .tmp-tree/rc2');
    process.exit(2);
  }
  return dir;
}

function versionOf(dir) {
  try {
    const info = readHostVersion(dir);
    return (info && info.version) || 'unknown';
  } catch {
    return 'unknown';
  }
}

// Where the patched copy goes: a root of its own holding @deepseek-ai plus every sibling package the
// registry also writes into (pi-ai lives next to @deepseek-ai, not inside it).
//
// It must be a root of its own for two reasons, both learned the hard way:
//   - a copy placed next to the REAL node_modules makes core.targetFiles() resolve pi-ai to the
//     installed host, so the rehearsal patches the user's own pi-ai instead of the copy;
//   - a copy placed away from those siblings loses the keys entirely, and the rehearsal then
//     'passes' without ever trying to patch them.
function defaultWorkRoot(baseline, version) {
  const slug = version && version !== 'unknown' ? version.split('.').join('-') : 'work';
  return path.join(ROOT, '.tmp-tree', 'rehearse-' + slug, 'work');
}

// Which packages does the registry reach by walking out of @deepseek-ai? Ask the baseline, where every
// path resolves, instead of hardcoding a list that rots on the next upstream move.
function outsidePackages(baseline) {
  const parent = path.dirname(baseline);
  const inside = path.resolve(baseline) + path.sep;
  const out = new Set();
  const map = core.targetFiles(baseline);
  for (const value of Object.values(map)) {
    for (const file of (Array.isArray(value) ? value : [value]).filter(Boolean)) {
      const resolved = path.resolve(file);
      if (resolved.startsWith(inside)) continue;
      const rel = path.relative(parent, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const parts = rel.split(path.sep);
      out.add(parts[0].charAt(0) === '@' ? path.join(parts[0], parts[1]) : parts[0]);
    }
  }
  return Array.from(out);
}

// The patched copy: never patch the baseline in place, or the second run has nothing to prove.
function prepareWorkRoot(baseline, root) {
  if (path.resolve(root) === path.resolve(baseline)) usage('--work must not be the baseline tree');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const workBase = path.join(root, path.basename(baseline));
  fs.cpSync(baseline, workBase, { recursive: true });
  const mirrored = outsidePackages(baseline).map((rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.cpSync(path.join(path.dirname(baseline), rel), path.join(root, rel), { recursive: true });
    return rel.split(path.sep).join('/');
  });
  return { workBase: workBase, mirrored: mirrored };
}

function readMaybe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

async function stepApply(baseline, work, root) {
  const byId = new Map(ALL_PATCHES.map((patch) => [patch.id, patch]));
  // Refuse before writing, not after: one target outside the rehearsal root means this run would
  // patch somebody else's files (the installed host, or another copy). targetFiles() is what
  // applyPatches() itself will use, so what it resolves here is exactly what would be written.
  const planned = core.targetFiles(work);
  const escaped = lib.escapedTargets(planned, root);
  if (escaped.length) {
    const rows = escaped.slice(0, 20).map((hit) => ({ id: hit.key, name: hit.key, status: 'escaped', bucket: 'blocking', why: 'target outside the rehearsal root: ' + hit.file }));
    return {
      id: 'apply',
      label: 'refused to patch: ' + escaped.length + ' target(s) resolve outside the rehearsal root',
      summary: 'nothing was written; the copy would have patched files outside ' + root,
      verdict: { ok: false, blocking: [escaped.length + ' escaped target(s)'], warn: [] },
      rows: rows,
      tally: { ok: 0, expected: 0, warn: 0, blocking: escaped.length },
    };
  }
  const report = await core.applyPatches(work, ALL_PATCHES);
  const targetMap = planned;
  const rows = report.map((row) => lib.classifyApplyRow(row, byId.get(row.patch_id), lib.keyFacts(byId.get(row.patch_id), targetMap, work)));
  const tally = lib.tallyBuckets(rows);
  // A copy of a package tree is not a full install: hooks, pi-ai and per-user preset packages live
  // outside it, so their keys resolve to nothing here. Say that once, instead of ten identical rows
  // that look like breakage.
  const noPath = rows.filter((row) => row.why.indexOf('no candidate path') === 0).length;
  const note = noPath > 0 ? '  (' + noPath + ' of them are packages a package tree does not contain: hooks/pi-ai/presets)' : '';
  return {
    id: 'apply',
    label: 'apply ' + rows.length + ' patch(es) to a copy of ' + versionOf(baseline),
    summary: 'ok ' + tally.ok + ' / expected ' + tally.expected + ' / warn ' + tally.warn + ' / blocking ' + tally.blocking + note,
    verdict: lib.bucketsVerdict(tally),
    rows: rows,
    tally: tally,
  };
}

// Same inputs as scripts/patch-outcome-report.mjs: target files on both trees, read both, classify.
function stepOutcome(baseline, work) {
  const workFiles = core.targetFiles(work);
  const baseFiles = core.targetFiles(baseline);
  const rows = [];
  const results = [];
  for (const patch of ALL_PATCHES) {
    const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
    const inputs = [];
    for (const key of keys) {
      const value = workFiles[key];
      const arr = (Array.isArray(value) ? value : [value]).filter(Boolean);
      if (arr.length === 0) {
        inputs.push({ key: key, file: key + '(unresolved)', fileText: null, baselineText: null });
        continue;
      }
      for (const file of arr) {
        const rel = path.relative(work, file);
        inputs.push({
          key: key,
          file: rel,
          fileText: readMaybe(file),
          baselineText: readMaybe(path.join(baseline, rel)),
        });
      }
    }
    const result = classifyPatch(patch, inputs);
    results.push(result);
    const bucket = lib.classifyOutcomeState(result.state);
    rows.push({ id: result.id, name: result.name, status: result.state, bucket: bucket, why: result.state });
  }
  const tally = tallyOutcome(results);
  const parts = STATE_LIST.concat([UNKNOWN]).map((state) => state + ' ' + (tally[state] || 0));
  return {
    id: 'outcome',
    label: 'classify every patch against the pristine baseline',
    summary: parts.join(' / '),
    verdict: lib.outcomeVerdict(tally),
    rows: rows,
    tally: tally,
  };
}

// Behaviour is the only step that runs code: it loads each module twice, on both trees.
async function stepBehaviour(baseline, work) {
  const loadOrig = moduleLoader(baseline);
  const loadPatched = moduleLoader(work);
  const results = [];
  for (const behaviour of BEHAVIORS) {
    const orig = await observe(behaviour, loadOrig);
    const patched = await observe(behaviour, loadPatched);
    const verdict = judge(behaviour, orig, patched);
    results.push({ id: behaviour.id, title: behaviour.title, kind: behaviour.kind || 'behaviour', state: verdict.state, reasons: verdict.reasons, observed: { orig: orig, patched: patched } });
  }
  const tally = tallyBehaviour(results);
  const rows = results.map((row) => ({
    id: row.id,
    name: row.title,
    status: row.state,
    bucket: lib.classifyBehaviourState(row.state),
    why: row.state + (row.reasons && row.reasons.length ? ' (' + row.reasons[0] + ')' : ''),
  }));
  const failing = results.filter((row) => isFailure(row) || needsHuman(row));
  return {
    id: 'behaviour',
    label: 'run ' + results.length + ' behaviour assertion(s) on both trees',
    summary: Object.keys(tally).map((state) => state + ' ' + tally[state]).join(' / ') + (failing.length ? '  needs attention: ' + failing.map((r) => r.id).join(',') : ''),
    verdict: lib.behaviourVerdict(tally),
    rows: rows,
    tally: tally,
  };
}

// Chokepoints are scanned on the PRISTINE baseline: the question is what the NEXT version added,
// not what our copy still has. dump-config has to run on that tree's own dsh bin.
function dumpConfig(aiBase, profile) {
  const bin = path.join(aiBase, 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(bin)) return { ok: false, why: 'no ' + bin };
  const res = spawnSync(process.execPath, [bin, '--profile', profile, '--dump-config'], {
    encoding: 'utf8',
    timeout: 180000,
    env: Object.assign({}, process.env, { DSH_HOME: process.env.DSH_HOME || path.join(os.homedir(), '.dsh') }),
  });
  if (res.status !== 0 || !res.stdout) return { ok: false, why: 'dump-config exit ' + res.status + ': ' + String(res.stderr || '').slice(0, 300) };
  return { ok: true, text: res.stdout };
}

async function stepChoke(baseline, profile) {
  const hits = scanShapes(baseline);
  const dump = dumpConfig(baseline, profile);
  const covered = lib.coveredPackages(core.targetFiles(baseline), baseline);
  const shortCircuits = findShortCircuits(baseline);
  const rows = correlate(hits, dump.ok ? parseDumpConfig(dump.text) : { entries: [] }, covered, shortCircuits);
  const split = findGaps(rows);
  const out = split.gaps.map((gap) => ({
    id: gap.shape + '|' + gap.pkg,
    name: gap.pkg,
    status: String(gap.hits),
    bucket: lib.BUCKETS.blocking,
    why: gap.shape + ' x' + gap.hits + ' in ' + gap.pkg,
  }));
  const counts = 'gaps ' + split.gaps.length + ' / watch ' + split.watch.length + ' / targets ' + split.targets.length + ' / ignored ' + split.ignored.length;
  return {
    id: 'choke',
    label: 'look for restriction shapes the next version added and we do not cover',
    summary: counts + (dump.ok ? '' : '  (no dump-config: ' + dump.why + ')'),
    verdict: lib.chokeVerdict(split.gaps),
    rows: out,
    tally: { gaps: split.gaps.length, watch: split.watch.length, targets: split.targets.length, ignored: split.ignored.length },
  };
}

// The gate table is pinned to one version's text. On a different version a missing needle is
// drift (the count is the re-derive job when dshTarget moves); on the SAME version it means the
// table and the tree stopped describing each other. Reading files is all this step needs, so it
// never looks at the patched copy.
function stepGates(baseline, version) {
  const file = path.join(ROOT, 'docs', 'patch-gates.json');
  const label = 'check the gate table against this tree';
  if (!fs.existsSync(file)) {
    return {
      id: 'gates',
      label: label,
      summary: 'no docs/patch-gates.json - run npm run host:gates -- --write docs/patch-gates.json',
      verdict: { ok: false, blocking: ['docs/patch-gates.json is missing: the rehearsal has no gate evidence'], warn: [] },
      rows: [],
      tally: {},
    };
  }
  let table = null;
  try {
    table = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      id: 'gates',
      label: label,
      summary: 'docs/patch-gates.json is not readable JSON',
      verdict: { ok: false, blocking: ['docs/patch-gates.json: ' + error.message], warn: [] },
      rows: [],
      tally: {},
    };
  }
  const result = verifyGates(table, {
    dir: baseline,
    version: version,
    readFile: (rel) => readMaybe(path.join(baseline, rel)),
  });
  const rows = result.rows
    .map((row) => ({
      id: row.patch,
      name: row.name || '',
      status: row.state,
      bucket: lib.classifyGateState(row, result.drift),
      why: row.state + (row.reason ? ' (' + row.reason + ')' : '') + (row.rel ? ' ' + row.rel + ':' + row.line : ''),
    }))
    .filter((row) => row.bucket !== lib.BUCKETS.ok);
  const t = result.tally;
  return {
    id: 'gates',
    label: label,
    summary: 'pinned to ' + result.tableVersion + ' / tree ' + result.version + ' / present ' + t.present + ' / missing ' + t.missing + ' / unreadable ' + t.unreadable + ' / skipped ' + t.skipped,
    verdict: lib.gateVerdict(result),
    rows: rows,
    tally: t,
    drift: result.drift,
  };
}

// Sixth question: did applying the patches change what any module exports? The project assumes it
// never does, and that assumption is what lets a behaviour assertion survive a version bump. This
// step compares the PRISTINE baseline with the PATCHED copy - both the same upstream version - so
// every difference is the patches' doing, not upstream drift.
async function stepSurfaces(baseline, work) {
  const label = 'compare the export surface of the patched copy with the pristine tree';
  const targets = core.targetFiles(baseline);
  const idsByKey = new Map();
  for (const patch of ALL_PATCHES) {
    for (const key of (Array.isArray(patch.file) ? patch.file : [patch.file])) {
      if (!idsByKey.has(key)) idsByKey.set(key, new Set());
      idsByKey.get(key).add(patch.id);
    }
  }
  const rows = [];
  for (const [pkg, entry] of surfaces.packageTargets(targets, baseline)) {
    const ids = new Set();
    for (const key of entry.keys) for (const id of (idsByKey.get(key) || [])) ids.add(id);
    const left = path.join(baseline, pkg, 'lib', 'index.js');
    const right = path.join(work, pkg, 'lib', 'index.js');
    const item = { pkg: pkg, patches: [...ids].sort((a, b) => a - b), rows: [] };
    if (!fs.existsSync(left) || !fs.existsSync(right)) {
      item.error = fs.existsSync(left) ? 'not in the patched copy' : 'not in the pristine tree';
      rows.push(item);
      continue;
    }
    try {
      const before = surfaces.describeModule(await import(pathToFileURL(left).href));
      const after = surfaces.describeModule(await import(pathToFileURL(right).href));
      item.rows = surfaces.diffSurface(before, after);
    } catch (error) {
      item.error = String(error && error.message ? error.message : error).slice(0, 120);
    }
    rows.push(item);
  }
  const invariant = surfaces.checkInvariant(rows);
  const tally = surfaces.tallySurfaces(rows);
  const flat = invariantsToRows(invariant, rows);
  return {
    id: 'surfaces',
    label: label,
    summary: tally.packages + ' package(s) / changed ' + tally.changed + ' / unchanged ' + tally.unchanged + ' / unreadable ' + tally.unreadable + ' / known ' + invariant.expected.length + ' / unexpected ' + invariant.unexpected.length,
    verdict: lib.surfaceVerdict(invariant),
    rows: flat,
    tally: tally,
  };
}

// Both 'this is the one reshape we mean' and 'nobody declared this' are worth printing; only the
// second one blocks, but hiding the first would make the declared exception invisible in the report.
function invariantsToRows(invariant, packages) {
  const patchesOf = new Map((packages || []).map((pkg) => [pkg.pkg, pkg.patches || []]));
  const rows = [];
  for (const item of invariant.expected) {
    rows.push({ id: (patchesOf.get(item.pkg) || [])[0], name: item.pkg + ' ' + item.name, status: item.change, bucket: lib.BUCKETS.ok, why: item.detail + ' (declared)' });
  }
  for (const item of invariant.unexpected) {
    rows.push({ id: (item.patches || [])[0], name: item.pkg + ' ' + item.name, status: item.change, bucket: lib.BUCKETS.blocking, why: item.detail });
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseline = resolveBaseline(args);
  const version = versionOf(baseline);
  const root = path.resolve(args.work || defaultWorkRoot(baseline, version));
  const profile = 'web';
  console.log('[rehearse] baseline ' + baseline + '  (' + version + ')');
  console.log('[rehearse] work     ' + root);
  const prepared = prepareWorkRoot(baseline, root);
  const work = prepared.workBase;
  if (prepared.mirrored.length) console.log('[rehearse] mirrored ' + prepared.mirrored.join(', '));
  const steps = [];
  const wanted = (id) => !args.skip.includes(id);
  if (wanted('apply')) steps.push(await stepApply(baseline, work, root));
  if (wanted('outcome')) steps.push(stepOutcome(baseline, work));
  if (wanted('behaviour')) steps.push(await stepBehaviour(baseline, work));
  if (wanted('choke')) steps.push(await stepChoke(baseline, profile));
  if (wanted('gates')) steps.push(stepGates(baseline, version));
  if (wanted('surfaces')) steps.push(await stepSurfaces(baseline, work));
  const verdict = lib.summarizeRehearsal(steps);
  const report = { schema: lib.REHEARSE_SCHEMA, kind: 'dsh-rehearse', capturedAt: new Date().toISOString(), baseline: baseline, baselineVersion: version, work: work, mirrored: prepared.mirrored, skipped: args.skip, steps: steps, verdict: verdict };
  console.log('');
  for (const line of lib.renderRehearsal(report, { limit: args.limit })) console.log(line);
  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(report, null, 2) + String.fromCharCode(10));
    console.log('[rehearse] wrote ' + path.resolve(args.json));
  }
  if (!args.keep) fs.rmSync(root, { recursive: true, force: true });
  process.exit(verdict.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('[rehearse] crashed: ' + (error && error.stack ? error.stack : String(error)));
  process.exit(2);
});
