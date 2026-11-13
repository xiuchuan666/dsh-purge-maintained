// Version matrix: for one patch, is its anchor still alive in a given pristine host tree?
//
// WHY THIS EXISTS
// 'which old patches can be retired' is not a question about pattern matches on the host we
// already patched -- it is a question about the pristine upstream tree. A patch whose anchor is
// gone upstream has nothing left to do; a patch whose anchor is alive but no longer matches
// needs a NEW ANCHOR, not a new patch. Those are different maintenance actions.
//
// WHY THE VERDICT IS NOT 'RETIRE'
// A dead anchor cannot tell you which of the two it is. #24 PRESET_FETCH_ENABLED points at a
// line upstream deleted (retire it); #12 APPROVAL_ASK_SENTENCE_BYPASS points at a sentence
// upstream REWROTE while keeping the restriction (re-anchor it). Both read 'dead'. So this module
// reports the fact and prints the anchor prefix, and the human decides the action.
//
// HOW THIS BREAKS
// 1. Judging on a patched tree. A hit there only means the patch has not run yet.
// 2. Counting hits per patch and not per file. One patch spans up to five keys; a key that no
//    longer resolves (desktop shell, moved package) says nothing about the others, so the
//    number of resolved keys is carried alongside.
// 3. Owning a second pattern matcher. countPatternHits() is injected from lib/patch-outcome.mjs;
//    two implementations would drift and the matrix would lie.
import fs from 'node:fs';

export const MATRIX_SCHEMA = 1;

export const MATRIX_VERDICTS = Object.freeze({
  live: 'live',
  stale: 'stale',
  dead: 'dead',
  native: 'native',
  retraction: 'retraction',
  trace: 'trace',
  blind: 'blind',
});

export const MATRIX_VERDICT_LIST = Object.freeze([
  MATRIX_VERDICTS.live,
  MATRIX_VERDICTS.stale,
  MATRIX_VERDICTS.dead,
  MATRIX_VERDICTS.native,
  MATRIX_VERDICTS.retraction,
  MATRIX_VERDICTS.trace,
  MATRIX_VERDICTS.blind,
]);

export const TRACE_TOKEN = '[dsh-purge]';

// A patch names its targets by key (or a list of keys) into core.targetFiles().
export function targetKeysOf(patch) {
  const raw = patch && patch.file;
  if (Array.isArray(raw)) return raw.filter((k) => typeof k === 'string' && k.length > 0);
  return typeof raw === 'string' && raw.length > 0 ? [raw] : [];
}

// Resolve keys against a targetFiles() table. Unresolved keys are simply absent: the desktop
// shell and the pre-split package names only exist on an installed app, not in an npm tree.
export function resolveTargets(patch, targetMap) {
  const out = [];
  for (const key of targetKeysOf(patch)) {
    const value = targetMap ? targetMap[key] : undefined;
    if (!value) continue;
    for (const file of Array.isArray(value) ? value : [value]) out.push({ key, file });
  }
  return out;
}

export function readTexts(targets) {
  const out = [];
  for (const target of targets) {
    try {
      out.push({ key: target.key, file: target.file, text: fs.readFileSync(target.file, 'utf8') });
    } catch {
      // named by the table but absent from this tree
    }
  }
  return out;
}

export function anchorHits(patch, texts, outcome) {
  let total = 0;
  const perFile = [];
  for (const entry of texts) {
    const hits = outcome.countPatternHits(entry.text, patch);
    total += hits;
    if (hits > 0) perFile.push({ key: entry.key, file: entry.file, hits });
  }
  return { hits: total, files: perFile.length, perFile };
}

// The first string pattern, trimmed, is enough to see whether upstream deleted or reworded.
export function anchorPrefix(patch) {
  for (const rep of (patch && patch.replacements) || []) {
    if (rep && typeof rep.pattern === 'string' && rep.pattern) {
      return rep.pattern.replace(/\s+/g, ' ').trim().slice(0, 72);
    }
  }
  return '';
}

// Insert-type patches land their product and then KEEP the anchor (the anchor is a code
// location). A dead anchor there means the location itself moved, which is a re-anchor job too.
export function isInsertPatch(patch) {
  return Boolean(patch && patch.skipIfMarked);
}

// The anchor is the plugin's own trace, so it can only exist after we ran.
export function isTraceAnchored(patch) {
  for (const rep of (patch && patch.replacements) || []) {
    const pat = rep && rep.pattern;
    if (typeof pat === 'string' && pat.indexOf(TRACE_TOKEN) >= 0) return true;
  }
  return false;
}

// Six verdicts, because five different maintenance actions hide behind 'the anchor is gone'.
// Order is the decision: a trace anchor can never say anything about upstream; a patch whose
// target state is already true upstream (#2/#3 rewrite restrictions back to official wording)
// has nothing left to do; a retraction patch hunts its own earlier work, not upstream text.
export function verdictOf(patch, facts) {
  if (isTraceAnchored(patch)) return MATRIX_VERDICTS.trace;
  if (facts.nativePresent) return MATRIX_VERDICTS.native;
  if (facts.outcome.isRetractionPatch(patch)) return MATRIX_VERDICTS.retraction;
  if (facts.resolved === 0) return MATRIX_VERDICTS.blind;
  if (facts.hits > 0) return MATRIX_VERDICTS.live;
  // The anchor is gone. Whether that means 'retire' or 're-anchor' is decided by the gate, not by the
  // anchor: a gate that is still present says the restriction upstream kept, so the pattern is what
  // needs updating. No gate (or no tree to check it against) leaves the question open, which is why
  // 'dead' exists as its own verdict instead of being folded into a recommendation.
  if (facts.gatePresent) return MATRIX_VERDICTS.stale;
  return MATRIX_VERDICTS.dead;
}

export function collectBehaviorsById(behaviors) {
  const map = new Map();
  for (const behavior of behaviors || []) {
    for (const id of behavior.covers || []) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(behavior.id);
    }
  }
  return map;
}

// A declared marker can already hold on a pristine tree when the patch's target state IS the
// official wording; that is not 'dead', that is 'nothing left to do here'.
export function nativeStatePresent(patch, texts, outcome) {
  for (const entry of texts) {
    if (outcome.markerPresent(entry.text, patch)) return true;
  }
  return false;
}

export function describePatchInTree(patch, targetMap, outcome, behaviorsById, gate) {
  const targets = resolveTargets(patch, targetMap);
  const texts = readTexts(targets);
  const anchor = anchorHits(patch, texts, outcome);
  const nativePresent = nativeStatePresent(patch, texts, outcome);
  // The gate is what separates 'upstream deleted the restriction' from 'upstream reworded it'. It is
  // checked here rather than in the caller so every verdict in the matrix rests on the same facts.
  const gatePresent = Boolean(
    gate && gate.needle && texts.some((entry) => entry.text.includes(gate.needle)),
  );
  return {
    id: patch.id,
    name: patch.name,
    resolved: targets.length,
    readable: texts.length,
    hits: anchor.hits,
    files: anchor.files,
    native: nativePresent,
    gate: gate && gate.needle ? gate.needle : null,
    gateReason: gate && gate.needle ? null : (gate && gate.reason) || null,
    gatePresent,
    verdict: verdictOf(patch, { resolved: targets.length, hits: anchor.hits, nativePresent, outcome, gatePresent }),
    insert: isInsertPatch(patch),
    optional: Boolean(patch.optional),
    anchor: anchorPrefix(patch),
    behaviors: [...((behaviorsById && behaviorsById.get(patch.id)) || [])],
  };
}

export function tallyVerdicts(rows) {
  const tally = {};
  for (const key of MATRIX_VERDICT_LIST) tally[key] = 0;
  for (const row of rows) tally[row.verdict] = (tally[row.verdict] || 0) + 1;
  return tally;
}

// One line per patch across trees, so a version bump reads as a diff of the whole registry:
//   94 ESCALATION_ARGS_UNVALIDATED  rc1 live(1)  rc2 live(1)
export function mergeTrees(patchIds, perTree) {
  return patchIds.map((id) => {
    const cells = {};
    let base = null;
    for (const [name, rows] of Object.entries(perTree)) {
      const row = rows.find((r) => r.id === id) || null;
      cells[name] = row;
      if (!base && row) base = row;
    }
    return { id, name: base ? base.name : '', base, cells };
  });
}

function cellText(cell) {
  if (!cell) return '?';
  const bare = [MATRIX_VERDICTS.blind, MATRIX_VERDICTS.native, MATRIX_VERDICTS.trace];
  // stale/dead both mean 'zero pattern hits'; the number adds nothing, the word is the finding.
  if (bare.indexOf(cell.verdict) >= 0) return cell.verdict;
  return cell.verdict + '(' + cell.hits + ')';
}

export function renderMatrix(merged, treeNames, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 40;
  const only = options.only ? String(options.only) : '';
  const lines = [];
  let shown = 0;
  for (const entry of merged) {
    if (only && !(entry.name === only || String(entry.id) === only)) continue;
    if (entry.base && options.verdicts && options.verdicts.indexOf(entry.base.verdict) < 0) continue;
    if (shown >= limit) {
      lines.push('... (' + (merged.length - shown) + ' total)');
      break;
    }
    const cells = treeNames.map((name) => name + ' ' + cellText(entry.cells[name]));
    const flags = [];
    if (entry.base && entry.base.insert) flags.push('insert');
    if (entry.base && entry.base.optional) flags.push('optional');
    const covered = entry.base && entry.base.behaviors.length ? entry.base.behaviors.join(',') : '-';
    lines.push(
      String(entry.id).padStart(3) + ' ' + String(entry.name).padEnd(34) + ' ' +
      cells.join('  ') + '  ' + (flags.length ? flags.join('+') : '-').padEnd(16) + ' beh:' + covered,
    );
    shown++;
  }
  return lines.join('\n');
}

// Two different actions, printed apart, because a reader who sees one list will treat them alike:
//   re-anchor  the gate is still in the tree -- upstream reworded the code, the restriction survives.
//   retire     no gate present -- either upstream removed the code or nobody has written a gate yet;
//              both want a human to read the anchor text and the upstream file before deleting.
export function renderDeadList(merged, treeName, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 20;
  const pick = (verdict) => merged
    .filter((e) => e.cells[treeName] && e.cells[treeName].verdict === verdict)
    .slice(0, limit);
  const reanchor = pick(MATRIX_VERDICTS.stale);
  const dead = pick(MATRIX_VERDICTS.dead);
  if (reanchor.length === 0 && dead.length === 0) return '';
  const lines = [];
  if (reanchor.length) {
    lines.push('-- gate still present, anchor dead: re-anchor (' + reanchor.length + ')');
    for (const entry of reanchor) {
      const cell = entry.cells[treeName];
      lines.push('  #' + String(entry.id).padEnd(3) + ' ' + String(entry.name).padEnd(34) + '  ' + cell.anchor);
    }
  }
  if (dead.length) {
    lines.push('-- no gate, anchor dead: read before retiring (' + dead.length + ')');
    for (const entry of dead) {
      const cell = entry.cells[treeName];
      const why = cell.gateReason ? '(' + cell.gateReason + ')' : '(no gate)';
      lines.push('  #' + String(entry.id).padEnd(3) + ' ' + String(entry.name).padEnd(34) +
        ' ' + (cell.insert ? 'insert' : 'plain ').padEnd(7) + '  ' + cell.anchor + '  ' + why);
    }
  }
  return lines.join('\n');
}