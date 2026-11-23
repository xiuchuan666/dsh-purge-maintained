/**
 * 宿主树备份的代际扫描与可审计 GC 计划。
 *
 * 三个入口都只读或纯函数：scanBackups 只 readdir + lstat，planGc 只排代际，
 * summarize 只做算术。真正的删除在 scripts/host-gc.mjs --apply，逐条重做 stat
 * 与 root 边界校验之后才动手。根目录不猜默认值，也永远不写 ~/.dsh。
 */
import fs from "node:fs";
import path from "node:path";

/** 三类备份，顺序即报告顺序。 */
export const GC_KINDS = ["sidecar", "appPrev", "asarBak"];
export const GC_KIND_LABELS = {
  sidecar: "*.dshpurge.bak 清洗前原件",
  appPrev: "app.prev-<ts> 上一代补丁树",
  asarBak: "app.asar.*.bak 官方包备份",
};
export const SIDECAR_SUFFIX = ".dshpurge.bak";

const DEFAULT_MAX_DEPTH = 6;
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", "app.asar.unpacked"]);

/** 文件名 -> 类别；认不出返回 null。sidecar 必须先于 asarBak 判定，两者都含 .bak。 */
export function classifyBackupName(name) {
  const base = String(name === undefined || name === null ? "" : name);
  if (!base) return null;
  if (base.length > SIDECAR_SUFFIX.length && base.toLowerCase().endsWith(SIDECAR_SUFFIX)) return "sidecar";
  if (/^app\.prev-.+$/i.test(base)) return "appPrev";
  if (/^app\.asar\.bak(?:[.\-_].*)?$/i.test(base)) return "asarBak";
  if (/^app\.asar[.\-_][A-Za-z0-9._:-]+\.bak$/i.test(base)) return "asarBak";
  return null;
}

/** 从名字里的时间戳取毫秒；认不出返回 null（调用方按最旧一代处理）。 */
export function parseStamp(token) {
  const raw = String(token === undefined || token === null ? "" : token).trim();
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length === 8 || digits.length === 12 || digits.length === 14) {
    const stamped = dateFromDigits(digits);
    if (stamped !== null) return stamped;
  }
  if (digits.length === 13) {
    const epochMs = Number(digits);
    return Number.isFinite(epochMs) ? epochMs : null;
  }
  if (digits.length === 10) {
    // 10 位有两种可能：YYYYMMDDHH（日期+小时）或 epoch 秒；先按日期解，日期非法才回落。
    const stamped = dateFromDigits(digits);
    if (stamped !== null) return stamped;
    const epochSec = Number(digits);
    return Number.isFinite(epochSec) ? epochSec * 1000 : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateFromDigits(digits) {
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  if (year < 1970 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const hour = digits.length >= 10 ? Number(digits.slice(8, 10)) : 0;
  const minute = digits.length >= 12 ? Number(digits.slice(10, 12)) : 0;
  const second = digits.length >= 14 ? Number(digits.slice(12, 14)) : 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const value = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(value) ? value : null;
}

/** target 必须是 root 的后代（不含 root 本身）；跨盘、..、绝对路径一律 false。 */
export function isInsideRoot(root, target) {
  const base = path.resolve(String(root === undefined || root === null ? "" : root));
  const child = path.resolve(String(target === undefined || target === null ? "" : target));
  if (!base || !child || base === child) return false;
  const rel = path.relative(base, child);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return false;
  return true;
}

/** 新的在前；时间戳缺失的一律沉底，同时间戳时用 mtime、再不行用名字。 */
export function compareEntries(left, right) {
  const leftTs = left && Number.isFinite(left.ts) ? left.ts : Number.NEGATIVE_INFINITY;
  const rightTs = right && Number.isFinite(right.ts) ? right.ts : Number.NEGATIVE_INFINITY;
  if (leftTs !== rightTs) return rightTs - leftTs;
  const leftMtime = left && Number.isFinite(left.mtimeMs) ? left.mtimeMs : 0;
  const rightMtime = right && Number.isFinite(right.mtimeMs) ? right.mtimeMs : 0;
  if (leftMtime !== rightMtime) return rightMtime - leftMtime;
  return String(right && right.name).localeCompare(String(left && left.name));
}

function statSafe(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function dirBytes(dir, depth) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const dirent of entries) {
    const child = path.join(dir, dirent.name);
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      if (depth < 8) total += dirBytes(child, depth + 1);
      continue;
    }
    if (!dirent.isFile()) continue;
    const info = statSafe(child);
    if (info && info.isFile()) total += info.size;
  }
  return total;
}

function stampFor(name, kind) {
  const base = String(name);
  let token = base;
  if (kind === "appPrev") token = base.replace(/^app\.prev-/i, "");
  else if (kind === "sidecar") token = base.slice(0, Math.max(0, base.length - SIDECAR_SUFFIX.length));
  const ts = parseStamp(token);
  return { ts, tsSource: ts === null ? "none" : "name" };
}

function walk(dir, depth, maxDepth, visit) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of entries) {
    const abs = path.join(dir, dirent.name);
    let info;
    try {
      info = fs.lstatSync(abs);
    } catch {
      continue;
    }
    const kind = classifyBackupName(dirent.name);
    if (kind) {
      visit(abs, dirent.name, kind, info);
      // 备份内部不再展开：否则 app.prev-* 里夹带的旧 sidecar 会被重复计成一代。
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    if (SKIP_DIRS.has(dirent.name)) continue;
    if (depth + 1 >= maxDepth) continue;
    walk(abs, depth + 1, maxDepth, visit);
  }
}

/**
 * 扫描 root 下的三类备份。返回 { root, sidecar, appPrev, asarBak, total }，
 * 每类按代际从新到旧排好，gen 0 是最新一代。
 */
export function scanBackups(root, options = {}) {
  if (root === undefined || root === null || String(root).trim() === "") {
    throw new Error("scanBackups: root is required");
  }
  const absRoot = path.resolve(String(root));
  let info;
  try {
    info = fs.statSync(absRoot);
  } catch {
    throw new Error("scanBackups: root does not exist: " + absRoot);
  }
  if (!info.isDirectory()) throw new Error("scanBackups: root is not a directory: " + absRoot);
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth > 0 ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const collected = [];
  walk(absRoot, 0, maxDepth, (abs, name, kind, lst) => {
    const isDir = lst.isDirectory();
    const stamp = stampFor(name, kind);
    collected.push({
      name,
      kind,
      absPath: abs,
      relPath: path.relative(absRoot, abs).split(path.sep).join("/"),
      bytes: isDir ? dirBytes(abs, 0) : lst.size,
      isDir,
      mtimeMs: Number.isFinite(lst.mtimeMs) ? lst.mtimeMs : 0,
      ts: stamp.ts,
      tsSource: stamp.tsSource,
      gen: -1,
    });
  });
  const result = { root: absRoot, sidecar: [], appPrev: [], asarBak: [], total: collected.length };
  for (const kind of GC_KINDS) {
    const list = collected.filter((entry) => entry.kind === kind).sort(compareEntries);
    list.forEach((entry, index) => {
      entry.gen = index;
    });
    result[kind] = list;
  }
  return result;
}

function normalizeBuckets(entries) {
  const buckets = { sidecar: [], appPrev: [], asarBak: [] };
  if (!entries) return buckets;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!entry) continue;
      const kind = GC_KINDS.includes(entry.kind)
        ? entry.kind
        : classifyBackupName(entry.name || path.basename(String(entry.absPath || entry.path || "")));
      if (!kind) continue;
      buckets[kind].push(entry);
    }
    return buckets;
  }
  for (const kind of GC_KINDS) {
    for (const entry of entries[kind] || []) buckets[kind].push(entry);
  }
  return buckets;
}

function entryKey(entry) {
  if (!entry) return "";
  return String(entry.absPath || entry.path || entry.relPath || entry.name || "");
}

/**
 * 出清理计划：每类保留最新 keep 个，其余进 remove，并在 reasons 里写清
 * "被哪一代压过"。唯一一个永远不删；没有更新代做依据也不删。
 */
export function planGc(entries, options = {}) {
  const requested = options && options.keep !== undefined ? options.keep : 2;
  const keep = Number(requested);
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error("planGc: keep must be an integer >= 1, got " + String(requested));
  }
  const buckets = normalizeBuckets(entries);
  const plan = { keep: [], remove: [], reasons: {}, keepCount: keep, classes: {} };
  for (const kind of GC_KINDS) {
    const list = buckets[kind].map((entry) => Object.assign({}, entry)).sort(compareEntries);
    if (!list.length) {
      plan.classes[kind] = { total: 0, keep: 0, remove: 0 };
      continue;
    }
    list.forEach((entry, index) => {
      entry.gen = index;
    });
    // 只有一个时 survive 也是 1：唯一一代天然受保护。
    const survive = Math.min(keep, list.length);
    let kept = 0;
    let dropped = 0;
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      const key = entryKey(entry);
      if (index < survive) {
        plan.keep.push(entry);
        kept += 1;
        plan.reasons[key] = {
          action: "keep",
          kind,
          gen: index,
          reason: index === 0 ? "newest generation" : "within newest " + survive + " of " + list.length,
        };
        continue;
      }
      const newer = list[0];
      if (!newer || entryKey(newer) === key) {
        plan.keep.push(entry);
        kept += 1;
        plan.reasons[key] = { action: "keep", kind, gen: index, reason: "no newer generation evidence" };
        continue;
      }
      plan.remove.push(entry);
      dropped += 1;
      plan.reasons[key] = {
        action: "remove",
        kind,
        gen: index,
        newer: newer.absPath || newer.name,
        newerGen: Number.isInteger(newer.gen) ? newer.gen : 0,
        ts: Number.isFinite(entry.ts) ? entry.ts : null,
        newerTs: Number.isFinite(newer.ts) ? newer.ts : null,
        reason: "older generation than " + String(newer.name),
      };
    }
    plan.classes[kind] = { total: list.length, keep: kept, remove: dropped };
  }
  return plan;
}

/** 释放字节数、条数、按类拆分，外加删除风险提示。 */
export function summarize(plan) {
  const keepList = plan && Array.isArray(plan.keep) ? plan.keep : [];
  const removeList = plan && Array.isArray(plan.remove) ? plan.remove : [];
  const byKind = {};
  for (const kind of GC_KINDS) byKind[kind] = { keep: 0, remove: 0, freedBytes: 0 };
  let freedBytes = 0;
  for (const entry of removeList) {
    const bytes = Number(entry && entry.bytes) || 0;
    freedBytes += bytes;
    const kind = entry && GC_KINDS.includes(entry.kind) ? entry.kind : "sidecar";
    byKind[kind].remove += 1;
    byKind[kind].freedBytes += bytes;
  }
  for (const entry of keepList) {
    const kind = entry && GC_KINDS.includes(entry.kind) ? entry.kind : "sidecar";
    byKind[kind].keep += 1;
  }
  const risks = [];
  const unparsed = removeList.filter((entry) => !Number.isFinite(entry && entry.ts)).length;
  if (unparsed > 0) {
    risks.push(unparsed + " 个待删条目时间戳无法解析，按最旧一代处理，删除前建议人工核对路径");
  }
  if (byKind.asarBak.remove > 0) risks.push("app.asar.*.bak 是官方包备份，删掉后这一层只能靠官方安装包回滚");
  if (byKind.appPrev.remove > 0) risks.push("app.prev-* 是上一代补丁树，删掉后回滚要重跑 host-install");
  if (byKind.sidecar.remove > 0) risks.push("*.dshpurge.bak 是清洗前原件，删掉后无法逐文件还原");
  if (!keepList.length) risks.push("没有任何备份可保留，这棵树里可能本来就没有备份");
  const structural = byKind.appPrev.remove + byKind.asarBak.remove;
  return {
    keepCount: keepList.length,
    removeCount: removeList.length,
    freedBytes,
    freedHuman: formatBytes(freedBytes),
    byKind,
    risks,
    level: removeList.length === 0 ? "none" : structural > 0 ? "medium" : "low",
  };
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return value + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return Math.round(scaled * 10) / 10 + " " + units[unit];
}
