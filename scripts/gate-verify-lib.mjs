// Does the committed gate table still land on this tree?
//
// scripts/check-gates.mjs runs in CI and checks that the table and the registry agree with each
// other. It cannot check whether a needle still exists in the upstream text, because CI has no host
// tree. That gap is written down in the docs as a known blind spot; this module is what closes it,
// locally, where a tree is available.
//
// The table records the version it was derived from (table.tree.version). A needle that is missing
// on a DIFFERENT version is expected drift - it is the size of the re-derive job when dshTarget is
// bumped, and the count is the number you want. A needle missing on the SAME version is a warning:
// the table and the tree are supposed to describe each other, so one of them is stale.

export const VERIFY_SCHEMA = 1;

export const VERIFY_STATES = Object.freeze({
  present: 'present',
  missing: 'missing',
  unreadable: 'unreadable',
  skipped: 'skipped',
});

// The version the table says it was derived from, or 'unknown' when the table predates the field.
export function tableVersion(table) {
  const tree = table && table.tree;
  const version = tree && tree.version;
  return typeof version === 'string' && version.length > 0 ? version : 'unknown';
}

// Rows that carry a needle are the only ones with anything to verify; the rest record a reason.
export function rowsToVerify(table) {
  const rows = table && Array.isArray(table.rows) ? table.rows : [];
  return rows.filter((row) => row && typeof row.needle === 'string' && row.needle.length > 0);
}

// readFile(rel) must return the file text, or null when the path does not exist on this tree.
// Injecting it keeps this module free of file IO, so the whole matrix is testable with a Map.
export function verifyGates(table, options = {}) {
  const readFile = typeof options.readFile === 'function' ? options.readFile : () => null;
  const dir = options.dir ? String(options.dir) : '';
  const version = options.version ? String(options.version) : 'unknown';
  const from = tableVersion(table);
  const rows = [];
  const tally = { present: 0, missing: 0, unreadable: 0, skipped: 0 };
  const all = table && Array.isArray(table.rows) ? table.rows : [];
  for (const row of all) {
    if (!row) continue;
    if (typeof row.needle !== 'string' || row.needle.length === 0) {
      tally.skipped += 1;
      rows.push({ patch: row.patch, name: row.name, rel: row.rel || '', line: row.line || 0, state: VERIFY_STATES.skipped, reason: row.reason || 'unknown' });
      continue;
    }
    const rel = String(row.rel || '');
    const text = rel ? readFile(rel) : null;
    if (typeof text !== 'string') {
      tally.unreadable += 1;
      rows.push({ patch: row.patch, name: row.name, rel: rel, line: row.line || 0, state: VERIFY_STATES.unreadable, reason: 'not in this tree' });
      continue;
    }
    if (text.indexOf(row.needle) >= 0) {
      tally.present += 1;
      rows.push({ patch: row.patch, name: row.name, rel: rel, line: row.line || 0, state: VERIFY_STATES.present, reason: '' });
      continue;
    }
    tally.missing += 1;
    rows.push({ patch: row.patch, name: row.name, rel: rel, line: row.line || 0, state: VERIFY_STATES.missing, reason: 'needle gone' });
  }
  return {
    schema: VERIFY_SCHEMA,
    dir: dir,
    version: version,
    tableVersion: from,
    drift: from !== 'unknown' && version !== 'unknown' && from !== version,
    rows: rows,
    tally: tally,
  };
}

// Rows worth printing: anything that is not present and not a plain reason row.
export function notableRows(result, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 20;
  const rows = (result && result.rows) || [];
  return rows.filter((row) => row.state === VERIFY_STATES.missing || row.state === VERIFY_STATES.unreadable).slice(0, limit);
}

export function renderGateVerify(result, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 20;
  const tally = (result && result.tally) || { present: 0, missing: 0, unreadable: 0, skipped: 0 };
  const total = tally.present + tally.missing + tally.unreadable;
  const pin = result.tableVersion === 'unknown' ? 'version unrecorded' : 'pinned to ' + result.tableVersion;
  const lines = [];
  lines.push('== gate table: ' + total + ' gated row(s), ' + pin + ', tree ' + (result.version || 'unknown'));
  lines.push('-- present ' + tally.present + ' / missing ' + tally.missing + ' / unreadable ' + tally.unreadable + ' / skipped ' + tally.skipped);
  if (result.drift && tally.missing > 0) {
    lines.push('-- ' + tally.missing + ' needle(s) moved between ' + result.tableVersion + ' and ' + result.version + ': re-derive when you bump dshTarget');
  }
  for (const row of notableRows(result, { limit: limit })) {
    lines.push('   #' + String(row.patch).padEnd(3) + ' ' + String(row.name).padEnd(34) + ' ' + row.rel + ':' + row.line + '  ' + row.state + ' (' + row.reason + ')');
  }
  return lines;
}

export default {
  VERIFY_SCHEMA, VERIFY_STATES, tableVersion, rowsToVerify, verifyGates, notableRows, renderGateVerify,
};