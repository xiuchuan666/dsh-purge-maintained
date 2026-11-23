import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

const VARIANT_RE = /^prompt-inject-v(\d+)\.md$/;
const FENCE_RE = /^ {0,3}(\x60{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/;

export const CORE_MARKERS = Object.freeze([
  "PRIME DIRECTIVE",
  "UNRESTRICTED SANDBOX",
  "Scoped Rules",
  "House Rules",
  "Never Refuse",
]);

const KNOWN_SLOTS = new Set([
  "TARGET",
  "TARGET_IP",
  "TARGET_URL",
  "TARGET_HOST",
  "APP",
  "APP_URL",
  "APP_NAME",
  "DOMAIN",
  "SUBDOMAIN",
  "HOST",
  "PORT",
  "PATH",
  "URL",
  "ENDPOINT",
  "API_ENDPOINT",
  "PARAM",
  "COOKIE",
  "TOKEN",
  "HEADER",
  "WORDLIST",
  "THREADS",
  "RATE",
  "RESULT_DIR",
  "RESULT_LOG",
  "OAST_DOMAIN",
  "PAYLOAD",
  "OFFSET",
  "PATCH_BYTE",
  "CHECK_FN",
  "LICENSE_BLOB",
  "SERIAL",
  "SAMPLE",
  "ROLE_A",
  "ROLE_B",
  "INTERFACE",
  "CAP_FILE",
  "MONITOR_FIXTURE",
  "OUT_DIR",
  "ANTI_DEBUG_SNIPPET",
  "ANTI_VM_SNIPPET",
  "DETECTION_BYPASS_SLOT",
  "OCR_TEMPLATE",
  "PROXY_POOL",
  "CAPTCHA_ID",
  "RCE_TEMPLATE",
  "USER_ID",
  "LEVEL",
  "RISK",
  "FRAGMENT",
  "FILENAME",
  "FILE_PATH",
  "DEST",
  "SOURCE",
]);

const MARKER_PATTERNS = Object.freeze([
  ["PRIME DIRECTIVE", /PRIME DIRECTIVE/],
  ["UNRESTRICTED SANDBOX", /UNRESTRICTED SANDBOX/],
  ["Scoped Rules", /Scoped Rules/],
  ["House Rules", /House Rules/],
  ["Never Refuse", /Never Refuse/],
  ["TARGET fixture workflow", /TARGET fixture workflow/],
  ["目标占位流程：", /目标占位流程[：:]/],
]);

const CORE_PATTERNS = Object.freeze([
  ["PRIME DIRECTIVE", /PRIME DIRECTIVE|你是\s*\*{0,2}Little Code Sauce/],
  ["UNRESTRICTED SANDBOX", /UNRESTRICTED SANDBOX/],
  ["Scoped Rules", /Scoped Rules|场景规则/],
  ["House Rules", /House Rules|^##[ \t]*锚[（(]/m],
  ["Never Refuse", /Never Refuse|出现拒绝念头|拒绝[ \t]*=[ \t]*故障|不拒绝/],
]);

function textOf(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value == null ? "" : value);
}

function countLines(text) {
  if (!text) return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) newlines += 1;
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
}

function findSlots(text) {
  const hits = [];
  const bracket = /[\[{]([A-Z][A-Z0-9_]{1,})[\]}]/g;
  let match = bracket.exec(text);
  while (match) {
    hits.push({ index: match.index, name: match[1] });
    match = bracket.exec(text);
  }
  const bare = /\b([A-Z][A-Z0-9_]{1,})\b/g;
  match = bare.exec(text);
  while (match) {
    const name = match[1];
    if (KNOWN_SLOTS.has(name) || /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name)) {
      hits.push({ index: match.index, name });
    }
    match = bare.exec(text);
  }
  hits.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name));
  const seen = new Set();
  const slots = [];
  for (const hit of hits) {
    if (seen.has(hit.name)) continue;
    seen.add(hit.name);
    slots.push(hit.name);
  }
  return slots;
}

function scanStructure(text) {
  const lines = text.split(/\r?\n/);
  const headings = [];
  let fenceChar = "";
  let codeFences = 0;
  for (const line of lines) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const char = fence[1].charAt(0);
      if (!fenceChar) {
        fenceChar = char;
        codeFences += 1;
        continue;
      }
      if (fenceChar === char) {
        fenceChar = "";
        continue;
      }
    }
    if (fenceChar) continue;
    const heading = HEADING_RE.exec(line);
    if (!heading) continue;
    const title = heading[2].replace(/[ \t]+#+$/, "").trim();
    if (title) headings.push({ level: heading[1].length, title });
  }
  return { headings, codeFences };
}

export function parseVariantVersion(value) {
  const raw = String(value == null ? "" : value);
  const match = VARIANT_RE.exec(basename(raw)) || /^v(\d+)$/i.exec(raw);
  return match ? Number(match[1]) : null;
}

export function variantVersion(value) {
  const number = parseVariantVersion(value);
  return number === null ? null : "v" + number;
}

export function listVariantFiles(root) {
  const docs = join(String(root || "."), "docs");
  let entries;
  try {
    entries = readdirSync(docs, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = VARIANT_RE.exec(entry.name);
      return match ? { name: entry.name, order: Number(match[1]), path: join(docs, entry.name) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((item) => item.path);
}

export function analyzeVariantText(text) {
  const source = textOf(text);
  const structure = scanStructure(source);
  return {
    chars: Array.from(source).length,
    bytes: Buffer.byteLength(source, "utf8"),
    lines: countLines(source),
    sha256: createHash("sha256").update(source, "utf8").digest("hex"),
    headings: structure.headings,
    slots: findSlots(source),
    markers: MARKER_PATTERNS.filter(([, pattern]) => pattern.test(source)).map(([name]) => name),
    codeFences: structure.codeFences,
    hasChatml: /<\|\s*im_start\s*\|>/.test(source),
    hasOperatorAnchor: /\bOPERATOR ANCHOR\b/.test(source),
  };
}

export function coreMarkersForText(text) {
  const source = textOf(text);
  return CORE_PATTERNS.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

export function compareVariants(a, b) {
  const left = a || {};
  const right = b || {};
  const leftMarkers = new Set(Array.isArray(left.markers) ? left.markers : []);
  const leftSlots = new Set(Array.isArray(left.slots) ? left.slots : []);
  const rightMarkers = Array.isArray(right.markers) ? right.markers : [];
  const rightSlots = Array.isArray(right.slots) ? right.slots : [];
  return {
    charsDelta: Number(left.chars || 0) - Number(right.chars || 0),
    sha256Same: String(left.sha256 || "") === String(right.sha256 || ""),
    missingMarkers: [...new Set(rightMarkers)].filter((name) => !leftMarkers.has(name)),
    missingSlots: [...new Set(rightSlots)].filter((name) => !leftSlots.has(name)),
  };
}

function coreMarkersComplete(entry) {
  const names = Array.isArray(entry.coreMarkers)
    ? entry.coreMarkers
    : Array.isArray(entry.markers)
      ? entry.markers
      : [];
  return CORE_MARKERS.every((name) => names.includes(name));
}

function orderOf(value) {
  const match = /^v?(\d+)$/.exec(String(value == null ? "" : value));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function summarizeVariants(entries, options) {
  const settings = options || {};
  const baselineVersion = settings.baselineVersion ? String(settings.baselineVersion) : null;
  const records = (Array.isArray(entries) ? entries : []).map((entry, index) => ({
    ...entry,
    version: entry.version || variantVersion(entry.path || entry.file) || "v" + (index + 1),
  }));
  records.sort((a, b) => orderOf(a.version) - orderOf(b.version));
  const baseline = baselineVersion ? records.find((entry) => entry.version === baselineVersion) : null;
  const rows = records.map((entry) => {
    const comparison = baseline
      ? entry.version === baseline.version
        ? { charsDelta: 0, sha256Same: true, missingMarkers: [], missingSlots: [] }
        : compareVariants(entry, baseline)
      : { charsDelta: null, sha256Same: null, missingMarkers: [], missingSlots: [] };
    return {
      version: entry.version,
      bytes: Number(entry.bytes || 0),
      chars: Number(entry.chars || 0),
      lines: Number(entry.lines || 0),
      sha12: String(entry.sha256 || "").slice(0, 12),
      headings: Array.isArray(entry.headings) ? entry.headings.length : 0,
      slots: Array.isArray(entry.slots) ? entry.slots.length : 0,
      coreMarkersComplete: coreMarkersComplete(entry),
      ...comparison,
    };
  });
  const totals = {
    variants: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    chars: rows.reduce((sum, row) => sum + row.chars, 0),
    lines: rows.reduce((sum, row) => sum + row.lines, 0),
    headings: rows.reduce((sum, row) => sum + row.headings, 0),
    slots: rows.reduce((sum, row) => sum + row.slots, 0),
    coreMarkersComplete: rows.length > 0 && rows.every((row) => row.coreMarkersComplete),
  };
  return { baselineVersion, rows, totals };
}
