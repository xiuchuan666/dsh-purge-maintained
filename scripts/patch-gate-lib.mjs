// Gates: for each patch, one short needle that says whether the restriction it removes is still
// there. This is a second, independent probe, and the independence is the whole point.
//
// A patch's own pattern has to match byte-for-byte, because it is what gets edited. That makes it
// a bad instrument for the question 'is the gate still here': #12's anchor was a whole sentence
// and upstream reworded both ends, so the pattern went dead while the restriction stayed. Reading
// the matrix alone would have retired a patch that is still needed.
//
// A gate needle is derived differently: take the line the pattern used to hit, and shrink it to the
// shortest substring that occurs exactly once in the file, then align both edges to word boundaries.
// It survives reindentation, reflow and nearby edits, which is what an upgrade actually does.
//
// Gates live in a side table keyed by patch id, not inside the patch objects. Two reasons: the
// patch definition is an action against any tree, while a gate is an observation about one specific
// upstream version; and scripts/test-patch-registry.mjs asserts patch metadata is byte-identical to
// the split snapshot, so adding a field there would mean rewriting that guarantee.
import fs from 'node:fs';
import path from 'node:path';
import * as anchor from './anchor-lib.mjs';
// Pattern reading is not re-implemented here. lib/patch-outcome.mjs already normalises the two
// registry shapes (replacements[] and the older patterns[]+replace) and the regexp flags; a second
// copy would drift and the gate table would then disagree with the applier about what a patch is.
import { patchReplacements } from '../lib/patch-outcome.mjs';

export const GATE_SCHEMA = 1;

// Same token the applier writes; kept as a literal so this module does not need the whole outcome
// layer just to recognise its own trace.
const TRACE_TOKEN = '[dsh-purge]';

// A RegExp's source escapes the brackets around the trace token, so a raw includes() check misses
// every regexp-anchored retraction patch -- #21 among them, which then looked like a dead anchor
// instead of what it is: our own cleanup, by construction absent from a pristine tree.
function unescapePattern(pattern) {
  if (typeof pattern === 'string') return pattern;
  if (!(pattern instanceof RegExp)) return '';
  return pattern.source.split('\\').join('');
}

// A regexp pattern whose first line is pure syntax has no literal seed to locate it with. That is not
// a dead anchor, it is a pattern that cannot be anchored -- a different maintenance action (read the
// regex, decide what still needs to be true).
function hasLiteralSeed(pattern) {
  const line = anchorLineOf(pattern);
  return /[A-Za-z]{4,}/.test(line);
}

// Where in the target table a patch's text can be found. Kept here rather than imported so this
// module stays a pure function of (patch, table, reader).
function targetFilesOf(patch, table) {
  const raw = patch && patch.file;
  const keys = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? [raw] : [];
  const out = [];
  for (const key of keys) {
    const value = table ? table[key] : undefined;
    if (Array.isArray(value)) out.push(...value.filter((v) => typeof v === 'string'));
    else if (typeof value === 'string') out.push(value);
  }
  return out;
}

// First non-empty line of a replacement's pattern, which is the line the anchor lives on.
function anchorLineOf(pattern) {
  if (typeof pattern === 'string') {
    for (const line of pattern.split('\n')) if (line.trim()) return line;
    return '';
  }
  if (pattern instanceof RegExp) {
    // Split on the source's line-continuation escapes and take the first segment that has anything in
    // it. Taking [0] unconditionally returns '' whenever the regexp starts with a newline escape, and
    // an empty probe silently turns a locatable patch into a not-found one.
    for (const segment of pattern.source.split('\\n')) if (segment.trim()) return segment;
    return '';
  }
  return '';
}

// Where the pattern's first line sits in this file, or -1.
//
// The probe is the pattern text itself, so it matches only when upstream is still byte-identical.
// A template literal that upstream re-wrapped in source, or a line whose tail changed, defeats it even
// though the restriction is untouched. So when the full probe misses we retry with shorter prefixes,
// cut at a word boundary. Prefixes are used for *locating* only; the needle is still grown by
// anchor-lib from the located line, so this adds no new way to build a bad anchor.
// The probe is matched exactly. An earlier version retried with progressively shorter prefixes to
// survive re-wrapping, and it produced false gates: #2's pattern names REPLACEMENT_WORKSPACE_
// CONTEXT_INTRO, upstream renamed it to REPLACEMENT_AGENT_INSTRUCTIONS_INTRO, and a prefix hit on
// the rename put a gate on a neighbouring constant -- a gate that would report 'restriction still
// present' forever. A miss here is information; a fabricated hit is a lie that never expires.
function locateLine(text, probe) {
  return text.indexOf(probe);
}

// Gates that cannot be derived mechanically, with the reason recorded next to each.
//
// Derivation needs the pattern to still hit the pristine tree. These patches are past that point:
// upstream reworded the thing the pattern quoted. That is exactly the case a gate exists for -- say
// the restriction is still here -- so the needle is written by hand against the current upstream text.
// A hand gate ages out like any other: when upstream rewords again it reports not-found and wants a
// human look, which is the honest outcome rather than a silent pass.
export const HAND_GATES = {
  // #12 quotes 'Approval policy: ask. ...', upstream replaced the sentence with the ASK_SENTENCE
  // constant below. The restriction (this sentence is what the model reads about approval) remains.
  12: {
    rel: 'dsh-user-approval/lib/index.js',
    needle: 'const ASK_SENTENCE = "Approval prompts are enabled in this session',
    note: 'upstream reworded the quoted sentence; gate tracks the ASK_SENTENCE constant instead',
  },
};

// Where this pattern lands in this text, as {at, probe}, or null.
//
// String patterns are located by their own first line, shortened by the prefix ladder when upstream
// re-wrapped it. Regexp patterns are run as a regexp: the match span is both the location and the
// seed, which is the only way to anchor something like #77, whose source is almost entirely escapes
// and whose literal text exists only as what the regexp matches.
function seedFor(text, pattern) {
  if (pattern instanceof RegExp) {
    const flags = String(pattern.flags || '').split('g').join('').split('y').join('');
    const m = new RegExp(pattern.source, flags).exec(text);
    if (m && m[0].length > 0) {
      // A regexp that starts with a newline escape matches *at* the line break, whose line is the
      // previous one. Skip the lead so the located line is the one the text lives on.
      const lead = m[0].length - m[0].trimStart().length;
      return { at: m.index + lead, probe: m[0].slice(lead) };
    }
    // The regexp no longer matches. Refusing to guess is the honest answer: a fabricated location
    // would produce a gate that reports 'still present' forever, and this layer exists precisely to
    // tell retirement from re-anchoring. Cases that matter get a hand gate instead.
    return null;
  }
  const probe = anchorLineOf(pattern).trim();
  if (!probe) return null;
  const at = locateLine(text, probe);
  if (at < 0) return null;
  return { at, probe };
}


// Patches whose target state is what upstream already ships, so there is no restriction left to
// watch. #2 and #3 rewrite an 'ACTIVE and MANDATORY' sentence into the milder official wording;
// rc.1's agent-instructions already ships the milder wording under a renamed constant, so the phrase
// they hunt for is gone for good -- a gate here would be a permanent not-found, which reads as a dead
// anchor and invites someone to re-anchor a patch that has nothing left to do.
export const NATIVE_PATCHES = {
  2: 'upstream renamed the constant and already ships the milder intro text',
  3: 'upstream no longer emits the ACTIVE-and-MANDATORY scope sentence',
};

// A gate for one patch, or a reason why this patch cannot have one.
//
// readFile is injected so tests never touch the disk, and so a caller can read from a tree other
// than the one on disk (a tarball, a cached snapshot).
export function gateForPatch(patch, table, readFile, options = {}) {
  const limit = Number.isInteger(options.maxLength) ? options.maxLength : 400;
  const files = targetFilesOf(patch, table);
  if (files.length === 0) return { patch: patch.id, name: patch.name, reason: 'no-target' };
  const patterns = patchReplacements(patch).map((r) => r && r.pattern).filter((p) => p !== undefined);
  if (patterns.length === 0) return { patch: patch.id, name: patch.name, reason: 'no-pattern' };
  // A trace-anchored patch points at the plugin's own [dsh-purge] text, which by construction
  // cannot exist in a pristine tree. Reporting that as 'not-found' would look like a dead anchor;
  // it is a category error, so it gets its own reason.
  const traceAnchored = patterns.some((p) => unescapePattern(p).includes(TRACE_TOKEN));
  if (traceAnchored) return { patch: patch.id, name: patch.name, reason: 'trace-anchored' };
  let unreadable = 0;
  let ambiguous = 0;
  const tried = [];
  for (const file of files) {
    let text;
    try {
      text = readFile(file);
    } catch {
      unreadable++;
      continue;
    }
    if (typeof text !== 'string') {
      unreadable++;
      continue;
    }
    for (const pattern of patterns) {
      const seed = seedFor(text, pattern);
      if (!seed) continue;
      const { at, probe } = seed;
      tried.push({ file, probe: String(probe).slice(0, 60) });
      const lineNumber = anchor.lineOfIndex(text, at);
      // The seed is the matched span inside the line, not the whole line. A pattern that quotes one
      // clause of an 800-character template literal cannot be anchored by its line at any length --
      // every window that contains the line is longer than maxLength. Growing from the matched span
      // keeps the needle as short as uniqueness allows, which is also what makes it survive edits.
      // Keep the seed inside one line. A cross-line needle breaks on reflow, which is the very edit
      // an upgrade makes; inside a line only the anchoring words have to survive.
      const lineEnd = text.indexOf('\n', at);
      const capped = lineEnd < 0 ? text.length : lineEnd;
      const seedEnd = Math.min(capped, at + probe.length);
      const grown = anchor.shortestUniqueAnchor(text, at, seedEnd, { maxLength: limit });
      if (!grown || !grown.unique) {
        ambiguous++;
        continue;
      }
      return {
        patch: patch.id,
        name: patch.name,
        file,
        rel: options.relOf ? options.relOf(file) : '',
        line: lineNumber,
        needle: grown.anchor,
        slack: grown.slack,
      };
    }
  }
  if (tried.length === 0 && patterns.every((x) => x instanceof RegExp) && !patterns.some(hasLiteralSeed)) {
    return { patch: patch.id, name: patch.name, reason: 'regex-only' };
  }
  if (ambiguous > 0) return { patch: patch.id, name: patch.name, reason: 'ambiguous', tried };
  if (tried.length === 0 && unreadable === files.length) return { patch: patch.id, name: patch.name, reason: 'unreadable' };
  return { patch: patch.id, name: patch.name, reason: 'not-found', tried };
}

// How many of the patch's own patterns still hit, used to label a gate as 'the patch would still
// apply here' rather than leaving the reader to guess.
export function countGateHits(patch, text) {
  let hits = 0;
  for (const rep of patchReplacements(patch)) {
    const p = rep && rep.pattern;
    if (typeof p === 'string' && p && text.includes(p)) hits++;
    else if (p instanceof RegExp && p.test(text)) hits++;
  }
  return hits;
}

// Is the gate still present in this text? This is the question the matrix asks when an anchor is
// dead: gate present means the restriction is still there and the pattern needs updating.
export function gatePresent(gate, text) {
  if (!gate || !gate.needle || typeof text !== 'string') return false;
  return text.includes(gate.needle);
}

// A hand gate, resolved against the same target table as a derived one.
//
// The rel path is matched as a suffix so the table can move (npm layout, nested layout, a snapshot)
// without editing the gate. If no target ends with it the gate reports not-found, which is a signal
// that the package was renamed and the gate needs a human, not that the restriction is gone.
function handGateFor(patch, table, hand, readFile) {
  // Compare on forward slashes on both sides. The target table mixes separators depending on how the
  // tree was produced (npm install vs a snapshot copied on Windows), and a suffix test that assumes
  // one of them silently reports no-target for every hand gate on the other layout.
  const norm = (value) => String(value).split('\\').join('/');
  const rel = norm(hand.rel || '');
  const files = targetFilesOf(patch, table);
  const file = files.find((f) => norm(f).endsWith(rel));
  if (!file) return { patch: patch.id, name: patch.name, reason: 'no-target', hand: true, note: hand.note };
  let text;
  try {
    text = readFile(file);
  } catch {
    return { patch: patch.id, name: patch.name, reason: 'unreadable', hand: true, note: hand.note };
  }
  const at = typeof text === 'string' ? text.indexOf(hand.needle) : -1;
  if (at < 0) return { patch: patch.id, name: patch.name, file, reason: 'not-found', hand: true, note: hand.note };
  return {
    patch: patch.id,
    name: patch.name,
    file,
    rel: hand.rel,
    line: anchor.lineOfIndex(text, at),
    needle: hand.needle,
    slack: 0,
    hand: true,
    note: hand.note,
  };
}

// Build the whole table. Patches without a usable gate keep a reason instead of a needle, so the
// side table never silently loses a patch.
export function buildGates(patches, table, readFile, handGates = HAND_GATES, nativePatches = NATIVE_PATCHES) {
  const gates = new Map();
  for (const patch of patches || []) {
    if (nativePatches && nativePatches[patch.id]) {
      gates.set(patch.id, { patch: patch.id, name: patch.name, reason: 'native', note: nativePatches[patch.id] });
      continue;
    }
    const hand = handGates && handGates[patch.id];
    gates.set(patch.id, hand ? handGateFor(patch, table, hand, readFile) : gateForPatch(patch, table, readFile));
  }
  return gates;
}

export function readFileFrom(aiBase) {
  return (file) => fs.readFileSync(path.resolve(aiBase, file), 'utf8');
}

export function tallyGates(gates) {
  const tally = { gated: 0, 'no-target': 0, 'no-pattern': 0, 'regex-only': 0, ambiguous: 0, unreadable: 0, 'not-found': 0, 'trace-anchored': 0, native: 0 };
  for (const gate of gates.values()) {
    const key = gate.needle ? 'gated' : gate.reason;
    tally[key] = (tally[key] || 0) + 1;
  }
  return tally;
}

// Compact one-liner for reports: the needle, or the reason there is none.
export function renderGate(gate, opts = {}) {
  if (!gate) return '-';
  if (!gate.needle) return '(' + gate.reason + ')';
  return anchor.renderAnchor(gate.needle, opts);
}

// The side table as it is written to disk: needles only, no absolute paths, so the file is stable
// across machines and can be reviewed in a diff.
export function serializeGates(gates) {
  const rows = [];
  for (const id of [...gates.keys()].sort((a, b) => a - b)) {
    const gate = gates.get(id);
    rows.push(gate.needle
      ? { patch: id, name: gate.name, rel: gate.rel, line: gate.line, needle: gate.needle }
      : { patch: id, name: gate.name, reason: gate.reason });
  }
  return { schema: GATE_SCHEMA, kind: 'dsh-patch-gates', rows };
}