// dsh-purge：pnpm store 里 dsh-purge 条目的诊断与清理。
// 背景：profile 里 dsh-purge 是 file:tarball 依赖，pnpm 以 integrity + tarball 路径作 key
// 把包内容写进全局 store。旧版本条目一旦被写穿（硬链接原地改写）或不再被 lockfile
// 引用，后续任何 pnpm add/update 都会在 strictStorePkgContentCheck 上报
// “Expected package: dsh-purge@X. Actual package in the store: dsh-purge@Y.”。
// 这里只做一件事：以当前 pnpm-lock.yaml 为准，清掉不再被引用的 dsh-purge store 条目。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const STORE_REPAIR_KIND = "dsh-store-repair";
export const STORE_REPAIR_SCHEMA = 1;

export function storeRepairError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 从 pnpm-lock.yaml 里读 dsh-purge 的 spec / version / integrity。 */
export function parsePurgeLock(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = { specifier: "", version: "", integrity: "", found: false, packageVersion: "" };
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s{6}dsh-purge:\s*$/.test(lines[i])) continue;
    out.found = true;
    for (let j = i + 1; j < lines.length && j < i + 8; j += 1) {
      const line = lines[j];
      if (/^\s{6}\S/.test(line)) break;
      let m = /^\s+specifier:\s*(.+?)\s*$/.exec(line);
      if (m) out.specifier = m[1];
      m = /^\s+version:\s*(.+?)\s*$/.exec(line);
      if (m) out.version = m[1];
    }
  }
  for (const line of lines) {
    if (!line.includes("dsh-purge")) continue;
    const m = /^\s{2}dsh-purge@(.+?):\s*$/.exec(line);
    if (m && !out.version) out.version = m[1];
  }
  const linesAfter = lines.join("\n");
  const block = /\n  dsh-purge@[^\n]*:\n(?:    [^\n]*\n?)+/.exec(linesAfter);
  if (block) {
    const m = /integrity:\s*(sha512-\S+)/.exec(block[0]);
    if (m) out.integrity = m[1].replace(/[",;]+$/, "");
  }
  const tar = /dsh-purge-([0-9][^\s/]*?)\.tgz/.exec(out.version || out.specifier);
  out.packageVersion = tar ? tar[1] : out.version;
  return out;
}

export function isPurgeStoreKey(key) {
  const text = String(key || "");
  return text.includes("dsh-purge@") || /dsh-purge-[^\s/]+\.tgz/.test(text);
}

export function purgeKeyVersion(key) {
  const m = /dsh-purge-([0-9][^\s/]*?)\.tgz/.exec(String(key || ""));
  if (m) return m[1];
  const at = /dsh-purge@([^\s]+)/.exec(String(key || ""));
  return at ? at[1] : "";
}

/** 以 lockfile 为唯一事实来源，列出应当保留 / 删除的 store key。 */
export function planStoreRepair(keys, current, options = {}) {
  const keepCurrent = options.keepCurrent !== false;
  const keep = [];
  const stale = [];
  for (const key of Array.isArray(keys) ? keys : []) {
    if (!isPurgeStoreKey(key)) continue;
    const isCurrent = keepCurrent && current && current.found && (
      (current.integrity && String(key).startsWith(current.integrity + "\t")) ||
      (current.version && String(key).includes("dsh-purge-" + current.version + ".tgz")) ||
      (current.specifier && String(key).endsWith("\t" + current.specifier))
    );
    if (isCurrent) keep.push(key); else stale.push(key);
  }
  return { kind: STORE_REPAIR_KIND, schema: STORE_REPAIR_SCHEMA, keep, stale, current: current || null };
}

export function defaultStorePath(env = process.env, platform = process.platform) {
  const home = env.USERPROFILE || env.HOME || "";
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "pnpm", "store", "v11");
  }
  return path.join(home, ".local", "share", "pnpm", "store", "v11");
}

export function storeIndexPath(storeDir) {
  return path.join(String(storeDir || ""), "index.db");
}

function openDatabase(dbPath, readonly) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw storeRepairError("node:sqlite 不可用：需要 Node.js >= 22.5（dsh-purge 要求 >=24）", "SQLITE_UNAVAILABLE");
  }
  return new DatabaseSync(dbPath, readonly ? { readOnly: true } : {});
}

export function listPurgeStoreKeys(dbPath) {
  if (!fs.existsSync(dbPath)) return { exists: false, keys: [] };
  const db = openDatabase(dbPath, true);
  try {
    const rows = db.prepare("select key from package_index").all();
    return { exists: true, keys: rows.map((row) => String(row.key)).filter(isPurgeStoreKey) };
  } finally {
    db.close();
  }
}

/** 诊断：不碰任何文件。 */
export function diagnoseStore(options = {}) {
  const profileDir = path.resolve(String(options.profileDir || "."));
  const lockFile = options.lockFile || path.join(profileDir, "pnpm-lock.yaml");
  const dbPath = options.dbPath || storeIndexPath(options.storeDir || defaultStorePath());
  const lockText = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, "utf8") : "";
  const current = parsePurgeLock(lockText);
  const listed = listPurgeStoreKeys(dbPath);
  const plan = planStoreRepair(listed.keys, current);
  return {
    profileDir, lockFile, dbPath,
    lockExists: fs.existsSync(lockFile),
    storeExists: listed.exists,
    current, plan,
    installedVersion: readInstalledPurgeVersion(profileDir),
  };
}

export function readInstalledPurgeVersion(profileDir) {
  const pkg = path.join(path.resolve(String(profileDir || ".")), "node_modules", "dsh-purge", "package.json");
  try {
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version || "";
  } catch {
    return "";
  }
}

/** 应用清理：先备份 index.db，再删 stale key。返回实际删除数。 */
export function applyStoreRepair(diagnosis, options = {}) {
  if (!diagnosis || !diagnosis.storeExists) {
    return { ok: true, removed: 0, backup: "", skipped: "store-missing" };
  }
  const stale = diagnosis.plan ? diagnosis.plan.stale : [];
  if (stale.length === 0) return { ok: true, removed: 0, backup: "", skipped: "nothing-stale" };
  if (options.dryRun) return { ok: true, removed: 0, wouldRemove: stale.length, backup: "", dryRun: true };
  const dbPath = diagnosis.dbPath;
  const backup = dbPath + ".dsh-purge-backup-" + new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(dbPath, backup);
  const db = openDatabase(dbPath, false);
  try {
    const del = db.prepare("delete from package_index where key = ?");
    let removed = 0;
    db.exec("begin");
    try {
      for (const key of stale) {
        const result = del.run(key);
        removed += Number(result.changes || 0);
      }
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
    return { ok: true, removed, backup, stale };
  } finally {
    db.close();
  }
}

/** 被清掉的 tarball 指针目录（只含 tarball-integrity），删了不影响其它包。 */
export function staleTarballDirs(storeDir, staleKeys) {
  const root = path.resolve(String(storeDir || ""));
  const out = [];
  for (const key of staleKeys || []) {
    const m = /\t(file:[^\s]+)$/.exec(String(key));
    if (!m) continue;
    const dirName = m[1].replace(/[:/]/g, (ch) => (ch === ":" ? "+" : "+"));
    const dir = path.join(root, dirName);
    if (fs.existsSync(dir)) out.push(dir);
  }
  return out;
}