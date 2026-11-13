// Rehearsal verdicts: turn four raw evidence streams into one answer.
//
// WHY THIS IS A SEPARATE MODULE
// A rehearsal applies the whole registry to a COPY of the next host version and then asks four
// independent questions. Each question has its own vocabulary (apply statuses, seven outcome
// states, five behaviour states, choke gap counts), and each one has its own idea of "fine".
// If the CLI decided inline, the thresholds would live in the middle of 200 lines of file IO and
// nobody could test them. Everything here is pure: rows in, verdict out.
//
// WHY THE THRESHOLDS ARE STRICTER THAN APPLY ITSELF
// lib/core.js::isPatchResultSoftOk() deliberately lets "drifted" pass: on a user machine a stale
// marker must not block a restart. A rehearsal is the opposite situation - it runs BEFORE shipping
// the upgrade, when a drifted anchor is exactly the thing to fix. So drifted is red here even
// though it is soft there. Same facts, different question, so a separate policy.

export const REHEARSE_SCHEMA = 1;

export const BUCKETS = Object.freeze({
  ok: 'ok',
  expected: 'expected',
  warn: 'warn',
  blocking: 'blocking',
});

export const BUCKET_LIST = Object.freeze(['ok', 'expected', 'warn', 'blocking']);

function flatten(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

// Which target files of one patch live inside the package tree, which outside, which nowhere.
// The distinction is the whole reason missing_file is not automatically red: a package-tree copy of
// the host can never contain the Electron shell entry or the per-user preset files, so those keys
// are unresolved by construction, not by breakage.
export function keyFacts(patch, targetMap, aiBase) {
  const base = String(aiBase).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  const raw = patch && patch.file;
  const keys = Array.isArray(raw) ? raw.filter((k) => typeof k === 'string' && k.length > 0)
    : (typeof raw === 'string' && raw.length > 0 ? [raw] : []);
  const rows = [];
  for (const key of keys) {
    const paths = flatten(targetMap ? targetMap[key] : undefined);
    let inside = 0;
    let outside = 0;
    for (const file of paths) {
      if (String(file).replace(/\\/g, '/').startsWith(base)) inside += 1;
      else outside += 1;
    }
    rows.push({ key: key, paths: paths.length, inside: inside, outside: outside });
  }
  let inCount = 0;
  let outCount = 0;
  let unresolved = 0;
  for (const row of rows) {
    if (row.inside > 0) inCount += 1;
    else if (row.outside > 0) outCount += 1;
    else unresolved += 1;
  }
  return { keys: keys, rows: rows, inside: inCount, outside: outCount, unresolved: unresolved };
}

// A patch is "soft" when its anchor may legitimately be absent: optional patches, retractions that
// hunt their own earlier trace, and insert-type patches that keep their anchor.
export function isSoftPatch(patch) {
  if (!patch) return false;
  if (patch.optional === true) return true;
  if (patch.softSettle === true) return true;
  if (patch.deleteOnly === true) return true;
  if (patch.skipIfMarked === true) return true;
  return Array.isArray(patch.after) && patch.after.length > 0;
}

// Where would the registry write, if we let it? Every resolved target must live under the rehearsal
// root; one path outside it means the copy would patch the real install (or another copy's files).
// This is checked BEFORE applyPatches runs, because afterwards the damage is already done.
export function escapedTargets(targetMap, root) {
  const base = String(root).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  const out = [];
  for (const [key, value] of Object.entries(targetMap || {})) {
    for (const file of flatten(value)) {
      const norm = String(file).replace(/\\/g, '/');
      if (!norm.startsWith(base)) out.push({ key: key, file: file });
    }
  }
  return out;
}

const HARD_FAILURE = /^(write_error|read_error|hit_count_mismatch)/;

export function classifyApplyRow(row, patch, facts) {
  const status = String((row && row.status) || '');
  const id = row ? row.patch_id : null;
  if (HARD_FAILURE.test(status)) {
    return { id: id, name: row.name, status: status, bucket: BUCKETS.blocking, why: 'the write itself failed: ' + status };
  }
  if (status === 'drifted') {
    return { id: id, name: row.name, status: status, bucket: BUCKETS.blocking, why: 'anchor gone, no trace: re-anchor before shipping this version' };
  }
  if (status === 'pattern_not_found') {
    return isSoftPatch(patch)
      ? { id: id, name: row.name, status: status, bucket: BUCKETS.warn, why: 'optional or retraction patch, anchor absent is allowed' }
      : { id: id, name: row.name, status: status, bucket: BUCKETS.blocking, why: 'required anchor not found in this version' };
  }
  if (status === 'missing_file') {
    const f = facts || { keys: [], inside: 0, outside: 0, unresolved: 0 };
    if (f.inside === 0 && f.outside > 0) {
      return { id: id, name: row.name, status: status, bucket: BUCKETS.expected, why: 'targets outside the package tree: ' + f.keys.join(',') };
    }
    if (f.inside === 0) {
      return { id: id, name: row.name, status: status, bucket: BUCKETS.warn, why: 'no candidate path in this layout: ' + f.keys.join(',') };
    }
    return { id: id, name: row.name, status: status, bucket: BUCKETS.blocking, why: 'keys resolve inside the tree but no file was found: ' + f.keys.join(',') };
  }
  return { id: id, name: row.name, status: status, bucket: BUCKETS.ok, why: status };
}

export function tallyBuckets(rows) {
  const tally = {};
  for (const key of BUCKET_LIST) tally[key] = 0;
  for (const row of rows || []) tally[row.bucket] = (tally[row.bucket] || 0) + 1;
  return tally;
}

// Apply rows bucket into ok/expected/warn/blocking. Only blocking fails a rehearsal:
// expected means the target lives outside the package tree (shell entry, per-user presets) and
// its absence here says nothing about the next version.
export function bucketsVerdict(tally) {
  const blocking = [];
  const warn = [];
  const red = (tally && tally.blocking) || 0;
  const yellow = (tally && tally.warn) || 0;
  if (red > 0) blocking.push(red + ' blocking row(s)');
  if (yellow > 0) warn.push(yellow + ' warn row(s)');
  return { ok: blocking.length === 0, blocking: blocking, warn: warn };
}

// The seven outcome states of lib/patch-outcome.mjs, read as a pre-ship question:
//   applied/done and native are fine, stale means this patch no longer has anything to do on this
//   version (retire it), pending means the copy was not actually patched, drifted means re-anchor,
//   unknown means we could not tell - and "could not tell" must never be green.
export function classifyOutcomeState(state) {
  if (state === 'applied' || state === 'native' || state === 'na') return BUCKETS.ok;
  if (state === 'stale') return BUCKETS.warn;
  return BUCKETS.blocking;
}

export function outcomeVerdict(tally) {
  const blocking = [];
  for (const state of ['pending', 'drifted', 'unknown']) {
    const n = (tally && tally[state]) || 0;
    if (n > 0) blocking.push(n + ' ' + state);
  }
  const stale = (tally && tally.stale) || 0;
  return { ok: blocking.length === 0, blocking: blocking, warn: stale > 0 ? [stale + ' stale (retire or re-anchor)'] : [] };
}

// Behaviour states of scripts/behavior-lib.mjs. broken is the worst one: the patch is in the file
// and the restriction is still there. inert only means the observation point moved.
export function classifyBehaviourState(state) {
  if (state === 'ok' || state === 'already') return BUCKETS.ok;
  if (state === 'inert') return BUCKETS.warn;
  return BUCKETS.blocking;
}

// A behaviour that is broken means the patch applied but no longer removes the restriction - the
// single worst outcome, and the one no marker check can see.
export function behaviourVerdict(tally) {
  const blocking = [];
  for (const state of ['broken', 'unexpected']) {
    const n = (tally && tally[state]) || 0;
    if (n > 0) blocking.push(n + ' ' + state);
  }
  const inert = (tally && tally.inert) || 0;
  return { ok: blocking.length === 0, blocking: blocking, warn: inert > 0 ? [inert + ' inert (observation point moved)'] : [] };
}

export function chokeVerdict(gaps) {
  const n = Array.isArray(gaps) ? gaps.length : 0;
  return n === 0
    ? { ok: true, blocking: [], warn: [] }
    : { ok: false, blocking: [n + ' uncovered chokepoint group(s)'] , warn: [] };
}

// The gate table is pinned to the version its needles were read from (docs/patch-gates.json
// carries that version). One needle gone on a DIFFERENT version is drift: expected, and the count
// is exactly the re-derive job when dshTarget moves. The same needle gone on the SAME version means
// the table and the tree stopped describing each other, which is a real problem - one is stale.
// A row whose file is not in this tree at all (desktop shell) says nothing either way.
export function classifyGateState(row, drift) {
  const state = row && row.state;
  if (state === 'present' || state === 'skipped') return BUCKETS.ok;
  if (state === 'missing') return drift ? BUCKETS.warn : BUCKETS.blocking;
  return BUCKETS.warn;
}

export function gateVerdict(result) {
  const tally = (result && result.tally) || {};
  const drift = Boolean(result && result.drift);
  const missing = tally.missing || 0;
  const unreadable = tally.unreadable || 0;
  const blocking = [];
  const warn = [];
  if (missing > 0) {
    if (drift) warn.push(missing + ' needle(s) moved between ' + result.tableVersion + ' and ' + result.version + ': re-derive when you bump dshTarget');
    else blocking.push(missing + ' needle(s) missing on the pinned version: the table and the tree disagree');
  }
  if (unreadable > 0) warn.push(unreadable + ' gate row(s) point at a file this tree does not contain');
  return { ok: blocking.length === 0, blocking: blocking, warn: warn };
}

// The invariant the whole project rests on: a patch rewrites text, it does not reshape what a module
// exports. One declared exception exists (#42 restores the legacy settings API). Any other difference
// between a pristine tree and the patched copy of the SAME version is an accident: it means the
// assertions and the docs describe an API that no longer exists.
export function surfaceVerdict(invariant) {
  const unexpected = (invariant && invariant.unexpected) || [];
  const expected = (invariant && invariant.expected) || [];
  const blocking = unexpected.map((item) => item.pkg + ' ' + item.name + ' ' + item.change + ' ' + item.detail + ' (patches ' + ((item.patches || []).join(',') || '-') + ')');
  return { ok: blocking.length === 0, blocking: blocking, warn: [] };
}

// One rehearsal report: six steps, each with a verdict and the rows behind it.
export function summarizeRehearsal(steps) {
  const reds = [];
  const warns = [];
  for (const step of steps || []) {
    for (const reason of (step.verdict && step.verdict.blocking) || []) reds.push(step.id + ': ' + reason);
    for (const reason of (step.verdict && step.verdict.warn) || []) warns.push(step.id + ': ' + reason);
  }
  return { ok: reds.length === 0, reds: reds, warns: warns };
}

// Packages a patch registry actually writes into, relative to an @deepseek-ai directory.
// Same rule as scan-chokepoints: derive from targetFiles(), never hand-copy package names.
export function coveredPackages(targetMap, aiBase) {
  const set = new Set();
  const base = String(aiBase).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  for (const value of Object.values(targetMap || {})) {
    for (const file of flatten(value)) {
      const abs = String(file).replace(/\\/g, '/');
      if (!abs.startsWith(base)) continue;
      const pkg = abs.slice(base.length).split('/')[0];
      if (pkg.indexOf('dsh-') === 0) set.add(pkg);
    }
  }
  return set;
}

export function renderRehearsal(report, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 20;
  const lines = [];
  for (const step of report.steps || []) {
    const mark = step.verdict.ok ? (step.verdict.warn.length ? 'warn' : 'ok') : 'FAIL';
    lines.push('[' + mark + '] ' + step.id + '  ' + step.label);
    lines.push('       ' + step.summary);
    for (const reason of (step.verdict.blocking || []).slice(0, limit)) lines.push('       ! ' + reason);
    for (const reason of (step.verdict.warn || []).slice(0, limit)) lines.push('       ~ ' + reason);
    for (const row of (step.rows || []).slice(0, limit)) {
      if (row.bucket === 'blocking' || row.bucket === 'warn') lines.push('       ' + row.bucket + ' #' + row.id + ' ' + row.name + ' - ' + row.why);
    }
  }
  const summary = report.verdict;
  lines.push('');
  // Count what actually ran. With --skip the report must not claim the evidence it did not gather -
  // 'five green' after skipping two steps is the exact kind of sentence this tool exists to avoid.
  const ran = (report.steps || []).length;
  const skipped = (report.skipped || []).length;
  const scope = ran + ' 步' + (skipped > 0 ? '（跳过 ' + skipped + ' 步）' : '');
  lines.push(summary.ok ? '[rehearse] PASS  ' + scope + '证据全绿' : '[rehearse] FAIL  ' + summary.reds.length + ' 处要先处理  ' + scope);
  for (const red of summary.reds) lines.push('[rehearse]   ! ' + red);
  for (const warn of summary.warns) lines.push('[rehearse]   ~ ' + warn);
  return lines;
}

export default {
  REHEARSE_SCHEMA, BUCKETS, BUCKET_LIST, keyFacts, isSoftPatch, classifyApplyRow, tallyBuckets, bucketsVerdict,
  classifyOutcomeState, outcomeVerdict, classifyBehaviourState, behaviourVerdict, chokeVerdict, surfaceVerdict, summarizeRehearsal,
  coveredPackages, escapedTargets, renderRehearsal,
  classifyGateState, gateVerdict,
};
