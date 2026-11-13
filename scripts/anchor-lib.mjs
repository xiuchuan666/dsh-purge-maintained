// Anchors: the shortest substring of a host file that identifies exactly one place.
//
// The registry's anchors are hand-written today, and a hand-written anchor fails in two opposite
// ways. Too short and it matches several places, so the patch lands on the wrong one. Too long and
// the next upstream reformat kills it: #12 died exactly like that, a whole sentence whose edges
// were reworded while the restriction stayed.
//
// shortestUniqueAnchor grows the smallest window around a target line that occurs exactly once,
// so the length is derived from the file instead of guessed. It also reports how many characters
// of slack the anchor has, which is the number that tells you whether it will survive the next
// release: an anchor that is unique by one character is a trap.

export const ANCHOR_SCHEMA = 1;
export const DEFAULT_MAX_ANCHOR = 240;

// All start offsets of needle in text. Non-overlapping, left to right.
export function occurrences(text, needle) {
  const out = [];
  if (typeof text !== 'string' || typeof needle !== 'string' || needle.length === 0) return out;
  let at = text.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = text.indexOf(needle, at + needle.length);
  }
  return out;
}

export function isUnique(text, needle) {
  return occurrences(text, needle).length === 1;
}

// 1-based line number to a [start, end) range, end excluding the line terminator.
export function lineRangeAt(text, line) {
  if (!Number.isInteger(line) || line < 1) return null;
  const lines = String(text).split('\n');
  if (line > lines.length) return null;
  let start = 0;
  for (let i = 0; i < line - 1; i++) start += lines[i].length + 1;
  const raw = lines[line - 1];
  const body = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  return { start, end: start + body.length, text: body };
}

// 0-based char offset to a 1-based line number.
export function lineOfIndex(text, index) {
  if (!Number.isInteger(index) || index < 0) return 0;
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function tighten(text, start, end) {
  let s = Math.max(0, start);
  let e = Math.min(text.length, end);
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return { start: s, end: e };
}

// Grow [start, end) by k characters total, preferring to grow right first, and return the first
// window that occurs exactly once in text.
//
// Growth order is fixed (left = 0, right = k; left = 1, right = k - 1; ...) so the same input
// always yields the same anchor. A caller that gets unique: false has a target line that is
// duplicated verbatim in the file, which means the patch needs a wider unit than one line.
export function shortestUniqueAnchor(text, start, end, opts = {}) {
  const max = Number.isInteger(opts.maxLength) ? opts.maxLength : DEFAULT_MAX_ANCHOR;
  const src = String(text ?? '');
  const core = tighten(src, start, end);
  if (core.end <= core.start) return { anchor: '', start: core.start, end: core.end, unique: false, slack: 0 };
  // Prefer edges that fall on a word boundary at the same length: a candidate that starts or ends
  // mid-identifier ('switch (outc') is unique but unreadable in a report, and it breaks the moment
  // upstream renames the identifier. Only fall back to a misaligned candidate if no aligned one is
  // unique at this length.
  const wordChar = (c) => /[A-Za-z0-9_$]/.test(c);
  const aligned = (s, e) => (s === 0 || !wordChar(src[s - 1])) && (e === src.length || !wordChar(src[e]));
  for (let k = 0; k <= max; k++) {
    let loose = null;
    for (let left = 0; left <= k; left++) {
      const right = k - left;
      const s = core.start - left;
      const e = core.end + right;
      if (s < 0 || e > src.length) continue;
      const candidate = src.slice(s, e);
      if (candidate.length > max) continue;
      if (!isUnique(src, candidate)) continue;
      if (aligned(s, e)) return { anchor: candidate, start: s, end: e, unique: true, slack: max - candidate.length };
      if (!loose) loose = { anchor: candidate, start: s, end: e, unique: true, slack: max - candidate.length };
    }
    if (loose) return loose;
  }
  const widest = src.slice(Math.max(0, core.start - Math.floor(max / 2)), Math.min(src.length, core.end + Math.floor(max / 2)));
  return { anchor: widest, start: core.start, end: core.end, unique: false, slack: 0 };
}

export function anchorForLine(text, line, opts = {}) {
  const range = lineRangeAt(text, line);
  if (!range) return null;
  return { line, text: range.text, ...shortestUniqueAnchor(text, range.start, range.end, opts) };
}

// How many times the anchor occurs, and on which lines. Used to explain a rejection instead of
// just reporting unique: false.
export function anchorReport(text, anchor) {
  const at = occurrences(text, anchor);
  return { count: at.length, lines: at.map((i) => lineOfIndex(text, i)) };
}

// One-line preview for reports. Keeps the anchor honest about its own whitespace: a tab shows
// as \t so a reader can see the thing that most often breaks these patterns.
export function renderAnchor(anchor, opts = {}) {
  const width = Number.isInteger(opts.width) ? opts.width : 72;
  const shown = String(anchor ?? '').replace(/\r/g, '').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
  return shown.length <= width ? shown : shown.slice(0, width - 1) + '…';
}