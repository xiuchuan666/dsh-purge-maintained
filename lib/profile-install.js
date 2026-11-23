import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import {
  beginInstall,
  recordStep,
  finishInstall,
  failInstall,
  pendingJournal,
} from "./host-install-journal.js";

export const PLUGIN_NAME = "dsh-purge";
export const DEFAULT_PROFILE = "desktop";
// SLOT_ROWS 的字符串总长：1.1.94–1.1.100 实测都是 16 980 字符（openSlot() 拼出来的
// 最终文本才是 22 553，两者不是同一个量）。下限取 16 000，留约 6% 余量，只拦
// 「行被删掉一大片」这类事故，不误伤正常裁剪。
export const MIN_SLOT = 16000;
export const EXIT = { ok: 0, failed: 1, precheck: 2, pending: 3 };

/** 宿主 profile 的固定布局；profile-dir 显式指定时绕过 home 推导。 */
export function defaultHome() {
  const fromEnv = String(process.env.DSH_HOME || "").trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".dsh");
}

export function profileLayout(home, profile) {
  const root = path.resolve(String(home || defaultHome()));
  const name = String(profile || DEFAULT_PROFILE);
  const profileDir = path.join(root, "profiles", name);
  const nodeModules = path.join(profileDir, "node_modules");
  return {
    home: root,
    profile: name,
    profileDir: profileDir,
    nodeModules: nodeModules,
    pluginDir: path.join(nodeModules, PLUGIN_NAME),
    pkgJson: path.join(profileDir, "package.json"),
    lockFile: path.join(profileDir, "pnpm-lock.yaml"),
    backupDir: path.join(root, "dsh-purge", "profile-backup", name),
  };
}

/** 显式 profile 目录（--profile-dir）也要给出完整布局。 */
export function layoutFor(profileDir, home, profile) {
  const layout = profileLayout(home, profile);
  const dir = path.resolve(String(profileDir || layout.profileDir));
  const nodeModules = path.join(dir, "node_modules");
  return {
    home: layout.home,
    profile: layout.profile,
    profileDir: dir,
    nodeModules: nodeModules,
    pluginDir: path.join(nodeModules, PLUGIN_NAME),
    pkgJson: path.join(dir, "package.json"),
    lockFile: path.join(dir, "pnpm-lock.yaml"),
    backupDir: layout.backupDir,
  };
}

export function readInstalledVersion(profileDir) {
  const pkgFile = path.join(path.resolve(String(profileDir)), "node_modules", PLUGIN_NAME, "package.json");
  if (!fs.existsSync(pkgFile)) {
    return { ok: false, version: null, name: PLUGIN_NAME, pkgFile: pkgFile, error: "未安装" };
  }
  try {
    const data = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    return { ok: true, version: typeof data.version === "string" ? data.version : null, name: data.name || PLUGIN_NAME, pkgFile: pkgFile, raw: data };
  } catch (error) {
    return { ok: false, version: null, name: PLUGIN_NAME, pkgFile: pkgFile, error: "package.json 解析失败：" + error.message };
  }
}

export function normalizeSha256(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const body = raw.startsWith("sha256-") ? raw.slice(7) : raw.startsWith("sha512-") ? raw.slice(7) : raw;
  if (/^[0-9a-f]{64}$/i.test(body)) return body.toLowerCase();
  try {
    const hex = Buffer.from(body, "base64").toString("hex");
    if (/^[0-9a-f]{64}$/.test(hex)) return hex;
  } catch (error) {
    return null;
  }
  return null;
}

export function verifyTgz(tgz, expected) {
  const opts = expected || {};
  const reasons = [];
  const file = tgz ? path.resolve(String(tgz)) : "";
  if (!file || !fs.existsSync(file)) {
    return { ok: false, reasons: ["tgz 不存在：" + (file || "(未指定)")], file: file, sha256: null, size: null };
  }
  const stat = fs.statSync(file);
  if (!stat.isFile()) return { ok: false, reasons: ["tgz 不是文件：" + file], file: file, sha256: null, size: null };
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (error) {
    return { ok: false, reasons: ["tgz 读取失败：" + error.message], file: file, sha256: null, size: null };
  }
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const wantedSize = Number(opts.size);
  if (Number.isFinite(wantedSize) && wantedSize > 0 && wantedSize !== stat.size) {
    reasons.push("大小不符：期望 " + wantedSize + " 字节，实际 " + stat.size + " 字节");
  }
  const wantedSha = normalizeSha256(opts.sha256);
  if (wantedSha && wantedSha !== sha256) {
    reasons.push("sha256 不符：期望 " + wantedSha + "，实际 " + sha256);
  }
  return { ok: reasons.length === 0, reasons: reasons, file: file, sha256: sha256, size: stat.size };
}

export function tarballIntegrity(tgz) {
  return "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(tgz)).digest("base64");
}

function readOctal(header, offset, length) {
  const raw = header.toString("ascii", offset, offset + length).replace(/\0.*$/, "").replace(/\s+/g, "").trim();
  if (!raw) return 0;
  const size = parseInt(raw, 8);
  return Number.isFinite(size) ? size : 0;
}

function isZeroBlock(header) {
  for (const byte of header) if (byte !== 0) return false;
  return true;
}

function tarName(header) {
  const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
  const magic = header.toString("ascii", 257, 262);
  if (magic !== "ustar") return name;
  const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
  return prefix ? prefix + "/" + name : name;
}

/** 纯 JS 读取 tgz 条目（gzip 或未压缩 tar 均可），不依赖系统 tar。 */
export function readTgzEntries(tgz) {
  const outer = fs.readFileSync(path.resolve(String(tgz)));
  const isGzip = outer.length >= 2 && outer[0] === 0x1f && outer[1] === 0x8b;
  let raw;
  if (isGzip) {
    try {
      raw = zlib.gunzipSync(outer);
    } catch (error) {
      // 有明显的 gzip magic 就不是「未压缩 tar」，解压失败必须报错，
      // 否则会把压缩字节按 tar 头解析出一堆垃圾条目。
      throw new Error("tgz 解压失败：" + error.message);
    }
  } else {
    raw = outer;
  }
  const entries = [];
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;
    const name = tarName(header);
    const size = readOctal(header, 124, 12);
    const type = header.toString("ascii", 156, 157) || "0";
    const dataStart = offset + 512;
    if (dataStart + size > raw.length) {
      throw new Error("tgz 条目被截断：" + (name || "(未命名)") + " 声明 " + size + " 字节，只剩 " + Math.max(0, raw.length - dataStart));
    }
    entries.push({ name: name, size: size, type: type, content: raw.subarray(dataStart, dataStart + size) });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function readTarballPackage(tgz) {
  let entries;
  try {
    entries = readTgzEntries(tgz);
  } catch (error) {
    return null;
  }
  return pickTarballPackage(entries);
}

function pickTarballPackage(entries) {
  const candidates = entries.filter((entry) => /(^|\/)package\.json$/.test(entry.name) && (entry.type === "0" || entry.type === "\0"));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.name.split("/").length - b.name.split("/").length || a.name.length - b.name.length);
  try {
    return JSON.parse(candidates[0].content.toString("utf8"));
  } catch (error) {
    return null;
  }
}

/** 把 tar 条目名规整成 root 内的相对路径；穿越/绝对路径/盘符一律返回 null。 */
function normalizeEntryName(name) {
  const clean = String(name || "").replace(/\\/g, "/");
  if (!clean || clean.startsWith("/") || /^[a-zA-Z]:/.test(clean)) return null;
  const parts = [];
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

function resolveInside(root, name) {
  const rel = normalizeEntryName(name);
  if (!rel) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  const back = path.relative(base, target);
  if (!back || back.startsWith("..") || path.isAbsolute(back)) return null;
  return target;
}

/** 列出会写到 root 之外的条目；类型 5 的 "."、"./" 目录条目放行。 */
export function unsafeTgzEntries(entries) {
  const unsafe = [];
  for (const entry of entries || []) {
    if (normalizeEntryName(entry.name)) continue;
    const clean = String(entry.name || "").replace(/\\/g, "/");
    if (entry.type === "5" && /^(\.\/?)*$/.test(clean)) continue;
    unsafe.push(entry.name);
  }
  return unsafe;
}

/**
 * tgz 预检：解压、条目安全、package.json 一次读完。
 * ok=false 时 code ∈ TGZ_MISSING / TGZ_CORRUPT / TGZ_EMPTY / TGZ_UNSAFE。
 */
export function inspectTgz(tgz) {
  const file = tgz ? path.resolve(String(tgz)) : "";
  if (!file || !fs.existsSync(file)) {
    return { ok: false, code: "TGZ_MISSING", reason: "tgz 不存在：" + (file || "(未指定)"), file: file, entries: [], unsafe: [], pkg: null };
  }
  let entries;
  try {
    entries = readTgzEntries(file);
  } catch (error) {
    return { ok: false, code: "TGZ_CORRUPT", reason: "tgz 解析失败：" + error.message, file: file, entries: [], unsafe: [], pkg: null };
  }
  if (entries.length === 0) {
    return { ok: false, code: "TGZ_EMPTY", reason: "tgz 里没有任何条目：" + file, file: file, entries: [], unsafe: [], pkg: null };
  }
  const unsafe = unsafeTgzEntries(entries);
  if (unsafe.length > 0) {
    const sample = unsafe.slice(0, 5).join(", ") + (unsafe.length > 5 ? " 等 " + unsafe.length + " 条" : "");
    return { ok: false, code: "TGZ_UNSAFE", reason: "tgz 含不安全路径（会写到 profile 之外）：" + sample, file: file, entries: entries, unsafe: unsafe, pkg: null };
  }
  return { ok: true, code: null, reason: "", file: file, entries: entries, unsafe: [], pkg: pickTarballPackage(entries) };
}

export function extractTgz(tgz, dest) {
  const root = path.resolve(String(dest));
  fs.mkdirSync(root, { recursive: true });
  const entries = readTgzEntries(tgz);
  const skipped = [];
  let files = 0;
  for (const entry of entries) {
    if (entry.type === "5") continue;
    if (entry.type !== "0" && entry.type !== "\0" && entry.type !== "7") {
      skipped.push(entry.name);
      continue;
    }
    const target = resolveInside(root, entry.name);
    if (!target) {
      skipped.push(entry.name);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.content);
    files += 1;
  }
  return { files: files, skipped: skipped, root: root };
}

/** 把 dsh-purge 的版本 token 换成新版本；其它包/近似版本不碰。 */
export function replaceLockToken(value, from, to) {
  const text = String(value || "");
  const needle = String(from || "");
  const next = String(to || "");
  if (!needle) return text;
  if (text === needle) return next;
  if (/^(file|link|workspace):/.test(text) || /^https?:\/\//.test(text)) return text.split(needle).join(next);
  const range = /^([~^])(.+)$/.exec(text);
  if (range && range[2] === needle) return range[1] + next;
  if (text.startsWith(needle + "(")) return next + text.slice(needle.length);
  return text;
}

function splitLines(text) {
  const source = String(text || "");
  return { eol: source.includes("\r\n") ? "\r\n" : "\n", lines: source.split(/\r?\n/) };
}

export function findLockEntry(text) {
  const lines = splitLines(text).lines;
  const result = { found: false, key: null, spec: null, version: null };
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^importers:/.test(lines[i])) {
      index = i;
      break;
    }
  }
  if (index < 0) return result;
  let packagesIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^packages:/.test(lines[i])) {
      packagesIndex = i;
      break;
    }
  }
  if (packagesIndex >= 0) {
    for (let i = packagesIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\S/.test(line)) break;
      const key = /^ {2}dsh-purge@(.+):\s*$/.exec(line);
      if (key) {
        result.found = true;
        result.key = key[1];
        break;
      }
    }
  }
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    if (/^\s{6}dsh-purge:\s*$/.test(line)) {
      result.found = true;
      continue;
    }
  }
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    if (!/^\s{6}dsh-purge:\s*$/.test(line)) continue;
    for (let j = i + 1; j < lines.length && /^\s{8}\S/.test(lines[j]); j += 1) {
      const field = /^\s{8}(specifier|version):\s*(.+?)\s*$/.exec(lines[j]);
      if (!field) continue;
      if (field[1] === "specifier") result.spec = field[2];
      else result.version = field[2];
    }
    break;
  }
  return result;
}

export function rewriteLockText(text, options) {
  const opts = options || {};
  const from = String(opts.from || "");
  const to = String(opts.to || "");
  if (!from || !to) throw new Error("rewriteLockText 需要 from 与 to");
  const info = findLockEntry(text);
  const split = splitLines(text);
  const out = [];
  const changes = [];
  if (!info.found) return { found: false, text: String(text || ""), changes: changes };
  let section = null;
  let depBlock = false;
  let target = false;
  for (const line of split.lines) {
    if (/^\S/.test(line)) {
      section = /^importers:/.test(line) ? "importers" : /^packages:/.test(line) ? "packages" : /^snapshots:/.test(line) ? "snapshots" : null;
      depBlock = false;
      target = false;
      out.push(line);
      continue;
    }
    if (section === "importers") {
      if (/^\s{6}\S/.test(line)) {
        depBlock = /^\s{6}dsh-purge:\s*$/.test(line);
        out.push(line);
        continue;
      }
      const field = depBlock ? /^(\s{8})(specifier|version):\s*(.+?)\s*$/.exec(line) : null;
      if (field) {
        const next = replaceLockToken(field[3], from, to);
        if (next !== field[3]) {
          out.push(field[1] + field[2] + ": " + next);
          changes.push("importer." + field[2] + ": " + field[3] + " → " + next);
          continue;
        }
      }
      out.push(line);
      continue;
    }
    if (section === "packages" || section === "snapshots") {
      if (/^ {2}\S/.test(line)) {
        target = line.startsWith("  dsh-purge@");
        const key = target ? /^(  dsh-purge@)(.+?)(:(?:\s*\{\})?\s*)$/.exec(line) : null;
        if (key) {
          const next = replaceLockToken(key[2], from, to);
          if (next !== key[2]) {
            out.push(key[1] + next + key[3]);
            changes.push(section + ".key: " + key[2] + " → " + next);
            continue;
          }
        }
        out.push(line);
        continue;
      }
      const resolution = target ? /^( {4}resolution: \{)(.*)(\}\s*)$/.exec(line) : null;
      if (resolution) {
        let changed = false;
        const nextBody = resolution[2].replace(/(integrity|tarball): ([^,}]+)/g, (all, name, value) => {
          const trimmed = value.trim();
          let next = trimmed;
          if (name === "integrity") next = opts.integrity ? String(opts.integrity) : trimmed;
          else next = opts.tarball ? String(opts.tarball) : replaceLockToken(trimmed, from, to);
          if (next === trimmed) return all;
          changes.push(section + "." + name + ": " + trimmed + " → " + next);
          changed = true;
          return name + ": " + next;
        });
        if (changed) {
          out.push(resolution[1] + nextBody + resolution[3]);
          continue;
        }
      }
      const field = target ? /^( {4}(version|integrity|tarball):\s*)(.+?)\s*$/.exec(line) : null;
      if (field) {
        const name = field[2];
        const old = field[3];
        let next = old;
        if (name === "version") next = replaceLockToken(old, from, to);
        else if (name === "integrity" && opts.integrity) next = String(opts.integrity);
        else if (name === "tarball") next = opts.tarball ? String(opts.tarball) : replaceLockToken(old, from, to);
        if (next !== old) {
          out.push(field[1] + next);
          changes.push(section + "." + name + ": " + old + " → " + next);
          continue;
        }
      }
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return { found: true, text: out.join(split.eol), changes: changes };
}

function slotFloor(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function installSpecFor(options) {
  const opts = options || {};
  const current = String(opts.currentSpec || "");
  if (/^(file|link):/.test(current)) {
    const prefix = current.startsWith("link:") ? "link:" : "file:";
    const relative = path.relative(path.resolve(String(opts.profileDir)), path.resolve(String(opts.tgz)));
    const normalized = relative.split(path.sep).join("/");
    if (path.isAbsolute(relative)) return prefix + normalized;
    return prefix + (normalized.startsWith(".") ? normalized : "./" + normalized);
  }
  return String(opts.version || "");
}

export function slotLengthFromAssetTable(source) {
  const match = /SLOT_ROWS\s*=\s*\[([\s\S]*?)\]/.exec(String(source || ""));
  if (!match) return null;
  let total = 0;
  let count = 0;
  const tokens = match[1].match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g) || [];
  for (const token of tokens) {
    total += unescapeJsString(token.slice(1, -1)).length;
    count += 1;
  }
  return count === 0 ? null : total;
}

function unescapeJsString(value) {
  return String(value).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (all, code) => {
    if (code[0] === "u" || code[0] === "x") return String.fromCharCode(parseInt(code.slice(1), 16));
    if (code === "n") return "\n";
    if (code === "t") return "\t";
    if (code === "r") return "\r";
    return code;
  });
}

export function readSlotLength(pluginDir) {
  const file = path.join(path.resolve(String(pluginDir)), "lib", "asset-table.js");
  if (!fs.existsSync(file)) return null;
  return slotLengthFromAssetTable(fs.readFileSync(file, "utf8"));
}

export function healthReport(options) {
  const opts = options || {};
  const expected = String(opts.expected || "");
  const actual = opts.actual ? String(opts.actual) : null;
  const minSlot = slotFloor(opts.minSlot, MIN_SLOT);
  const checks = [];
  const versionOk = Boolean(actual) && actual === expected;
  checks.push({
    name: "version",
    ok: versionOk,
    expected: expected,
    actual: actual,
    detail: versionOk ? "版本 " + actual + " 已生效" : "期望 " + expected + "，实际 " + (actual || "未安装"),
  });
  const slot = opts.slotLength === null || opts.slotLength === undefined ? NaN : Number(opts.slotLength);
  if (!Number.isFinite(slot)) {
    checks.push({ name: "slot", ok: true, skipped: true, minSlot: minSlot, detail: "读不到 asset-table.js 的 SLOT_ROWS，跳过长度检查" });
  } else {
    checks.push({ name: "slot", ok: slot >= minSlot, actual: slot, minSlot: minSlot, detail: slot >= minSlot ? "SLOT 长度 " + slot + " ≥ " + minSlot : "SLOT 长度 " + slot + " < " + minSlot });
  }
  return { ok: checks.every((check) => check.ok), checks: checks, versionOk: versionOk };
}

export function planProfileInstall(options) {
  const opts = options || {};
  const layout = layoutFor(opts.profileDir, opts.home, opts.profile);
  const tgz = opts.tgz ? path.resolve(String(opts.tgz)) : "";
  const expectedVersion = String(opts.packageVersion || "");
  const reasons = [];
  if (!fs.existsSync(layout.profileDir) || !fs.statSync(layout.profileDir).isDirectory()) {
    reasons.push("profile 不存在：" + layout.profileDir);
  } else {
    if (!fs.existsSync(layout.pkgJson)) reasons.push("profile package.json 不存在：" + layout.pkgJson);
    if (!fs.existsSync(layout.lockFile)) reasons.push("profile pnpm-lock.yaml 不存在：" + layout.lockFile);
  }
  if (!tgz || !fs.existsSync(tgz)) reasons.push("tgz 不存在：" + (tgz || "(未指定)"));
  if (!expectedVersion) reasons.push("没有给出期望版本（--version）");
  let tarball = null;
  let tarballError = null;
  if (tgz && fs.existsSync(tgz)) {
    const inspected = inspectTgz(tgz);
    if (!inspected.ok) {
      tarballError = inspected.reason;
      reasons.push(inspected.reason);
    } else if (!inspected.pkg) {
      tarballError = "tgz 里读不到 package/package.json";
      reasons.push(tarballError);
    } else {
      tarball = inspected.pkg;
      if (tarball.name !== PLUGIN_NAME) reasons.push("tgz 的包名是 " + tarball.name + "，期望 " + PLUGIN_NAME);
      else if (String(tarball.version) !== expectedVersion) reasons.push("tgz 版本 " + tarball.version + " 与期望 " + expectedVersion + " 不一致");
    }
  }
  const installed = readInstalledVersion(layout.profileDir);
  const from = installed.version || "";
  let lock = { found: false, key: null, spec: null, version: null };
  if (fs.existsSync(layout.lockFile)) {
    lock = findLockEntry(fs.readFileSync(layout.lockFile, "utf8"));
    if (!lock.found) reasons.push("pnpm-lock.yaml 里找不到 dsh-purge 段：" + layout.lockFile);
  }
  let currentSpec = "";
  if (fs.existsSync(layout.pkgJson)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(layout.pkgJson, "utf8"));
      currentSpec = String((pkg.dependencies && pkg.dependencies[PLUGIN_NAME]) || (pkg.optionalDependencies && pkg.optionalDependencies[PLUGIN_NAME]) || "");
      if (!currentSpec) reasons.push("profile package.json 的 dependencies 里没有 " + PLUGIN_NAME);
    } catch (error) {
      reasons.push("profile package.json 解析失败：" + error.message);
    }
  }
  const spec = currentSpec ? installSpecFor({ profileDir: layout.profileDir, tgz: tgz, currentSpec: currentSpec, version: expectedVersion }) : "";
  const steps = [
    "确认宿主进程（" + (opts.exe ? path.basename(String(opts.exe)) : "dsh") + "）已退出",
    "备份 profile 现状到 " + layout.backupDir,
    "解包 " + (tgz || "(未指定 tgz)") + " → " + layout.pluginDir,
    "写入 package.json 的 dependencies[" + PLUGIN_NAME + "] = " + (spec || "(未知)"),
    "改写 pnpm-lock.yaml：dsh-purge " + (lock.key || from || "(未安装)") + " → " + (expectedVersion || "(未知)"),
    "健康检查：版本 " + (expectedVersion || "(未知)") + " + SLOT 长度 ≥ " + slotFloor(opts.minSlot, MIN_SLOT),
    "任一步失败：还原 node_modules/" + PLUGIN_NAME + "、package.json、pnpm-lock.yaml",
    "成功后清理备份目录",
  ];
  return {
    ok: reasons.length === 0,
    reasons: reasons,
    steps: steps,
    profileDir: layout.profileDir,
    backupDir: layout.backupDir,
    tgz: tgz,
    from: from,
    installedVersion: from,
    expectedVersion: expectedVersion,
    currentSpec: currentSpec,
    spec: spec,
    lockKey: lock.key,
    lockFound: lock.found,
    tarball: tarball,
    tarballError: tarballError,
    integrity: tgz && fs.existsSync(tgz) ? tarballIntegrity(tgz) : null,
  };
}

export function rewriteProfilePackage(text, spec) {
  const data = JSON.parse(String(text || "{}"));
  data.dependencies = data.dependencies || {};
  data.dependencies[PLUGIN_NAME] = String(spec);
  return JSON.stringify(data, null, 2) + "\n";
}

export function writeFileAtomic(file, text) {
  const target = path.resolve(String(file));
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "." + path.basename(target) + ".dsh-" + process.pid + ".tmp");
  try {
    fs.writeFileSync(tmp, String(text));
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (inner) {
      /* 清理临时文件失败时不掩盖原始错误 */
    }
    throw error;
  }
  return target;
}

export function backupProfile(layout, backupDir) {
  const dir = path.resolve(String(backupDir));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["package.json", "pnpm-lock.yaml"]) {
    const src = path.join(layout.profileDir, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
  }
  if (fs.existsSync(layout.pluginDir)) fs.cpSync(layout.pluginDir, path.join(dir, "plugin"), { recursive: true });
  return { backupDir: dir, entries: fs.readdirSync(dir) };
}

export function restoreProfile(layout, backupDir) {
  const dir = path.resolve(String(backupDir || ""));
  if (!dir || !fs.existsSync(dir)) return { ok: false, restored: [], reason: "备份目录不存在：" + (dir || "(未记录)") };
  const restored = [];
  for (const name of ["package.json", "pnpm-lock.yaml"]) {
    const src = path.join(dir, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(layout.profileDir, name));
    restored.push(name);
  }
  fs.rmSync(layout.pluginDir, { recursive: true, force: true });
  const pluginBackup = path.join(dir, "plugin");
  if (fs.existsSync(pluginBackup)) {
    fs.cpSync(pluginBackup, layout.pluginDir, { recursive: true });
    restored.push("plugin");
  }
  return { ok: true, restored: restored };
}

/** 同步执行安装：journal 打点 + 备份 + 解包 + 改写 + 健康检查 + 失败还原。 */
export function applyInstall(options) {
  const opts = options || {};
  const layout = opts.layout;
  const plan = opts.plan;
  const home = opts.home;
  const staging = path.join(layout.nodeModules, ".dsh-purge-staging");
  let started = false;
  let health = { ok: false, checks: [] };
  let lockChanges = 0;
  const warnings = [];
  // 预检：tgz 解析不了/含穿越条目时直接拒绝，不建 journal、不碰 profile。
  const inspected = inspectTgz(plan.tgz);
  if (!inspected.ok) {
    return { ok: false, code: inspected.code, rolledBack: false, restored: [], error: inspected.reason, health: health, warnings: warnings };
  }
  if (!inspected.pkg) {
    return { ok: false, code: "TGZ_NO_PACKAGE", rolledBack: false, restored: [], error: "tgz 里读不到 package/package.json", health: health, warnings: warnings };
  }
  try {
    beginInstall(home, {
      tree: plan.backupDir,
      resources: layout.profileDir,
      exe: opts.exe || null,
      previous: { version: plan.from, spec: plan.currentSpec, tgz: plan.tgz },
      force: Boolean(opts.force),
    });
    started = true;
    backupProfile(layout, plan.backupDir);
    recordStep(home, "backup", true, plan.backupDir);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const extracted = extractTgz(plan.tgz, staging);
    recordStep(home, "extract", true, extracted.files + " 个文件 → " + staging);
    const stagedPkg = path.join(staging, "package", "package.json");
    if (!fs.existsSync(stagedPkg)) throw new Error("解包后找不到 package/package.json");
    const staged = JSON.parse(fs.readFileSync(stagedPkg, "utf8"));
    if (staged.name !== PLUGIN_NAME) throw new Error("解包后的包名是 " + staged.name + "，期望 " + PLUGIN_NAME);
    if (String(staged.version) !== plan.expectedVersion) throw new Error("解包后的版本是 " + staged.version + "，期望 " + plan.expectedVersion);
    fs.rmSync(layout.pluginDir, { recursive: true, force: true });
    fs.mkdirSync(layout.nodeModules, { recursive: true });
    fs.renameSync(path.join(staging, "package"), layout.pluginDir);
    fs.rmSync(staging, { recursive: true, force: true });
    recordStep(home, "swap", true, layout.pluginDir);
    writeFileAtomic(layout.pkgJson, rewriteProfilePackage(fs.readFileSync(layout.pkgJson, "utf8"), plan.spec));
    recordStep(home, "package-json", true, plan.spec);
    const isFileSpec = /^(file|link):/.test(String(plan.lockKey || "")) || /^(file|link):/.test(plan.spec);
    const lockTo = isFileSpec ? plan.spec : plan.expectedVersion;
    const lock = rewriteLockText(fs.readFileSync(layout.lockFile, "utf8"), {
      from: plan.lockKey || plan.from,
      to: lockTo,
      integrity: plan.integrity || undefined,
      tarball: isFileSpec ? plan.spec : undefined,
    });
    if (!lock.found) throw new Error("pnpm-lock.yaml 里找不到 dsh-purge 段：" + layout.lockFile);
    writeFileAtomic(layout.lockFile, lock.text);
    lockChanges = lock.changes.length;
    recordStep(home, "pnpm-lock", true, lock.changes.join("; "));
    health = healthReport({ expected: plan.expectedVersion, actual: readInstalledVersion(layout.profileDir).version, slotLength: readSlotLength(layout.pluginDir), minSlot: opts.minSlot });
    if (!health.ok) {
      throw new Error("健康检查未通过：" + health.checks.filter((check) => !check.ok).map((check) => check.name + " " + check.detail).join("；"));
    }
    recordStep(home, "health", true, "版本 " + plan.expectedVersion);
    finishInstall(home);
    try {
      fs.rmSync(plan.backupDir, { recursive: true, force: true });
      recordStep(home, "cleanup", true, plan.backupDir);
    } catch (error) {
      warnings.push("清理备份失败（安装已生效，journal 已收尾）：" + error.message);
      try {
        recordStep(home, "cleanup", false, error.message);
      } catch (inner) {
        warnings.push("记录 cleanup 失败：" + inner.message);
      }
    }
    return { ok: true, health: health, lockChanges: lockChanges, warnings: warnings };
  } catch (error) {
    let restore = { ok: false, restored: [], reason: "未开始安装" };
    if (started) {
      try {
        restore = restoreProfile(layout, plan.backupDir);
      } catch (inner) {
        restore = { ok: false, restored: [], reason: inner.message };
      }
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch (inner) {
        warnings.push("清理 staging 失败：" + inner.message);
      }
      try {
        recordStep(home, "rollback", restore.ok, restore.ok ? "已还原：" + restore.restored.join(",") : "还原失败：" + restore.reason);
      } catch (inner) {
        /* journal 已被清掉时不再阻塞退出 */
      }
      try {
        failInstall(home, { rolledBack: restore.ok, error: error.message });
      } catch (inner) {
        /* 同上 */
      }
    }
    return { ok: false, code: error.code || null, rolledBack: restore.ok, restored: restore.restored, error: error.message, health: health, warnings: warnings };
  }
}

export function rollbackInstall(options) {
  const opts = options || {};
  const journal = pendingJournal(opts.home);
  if (!journal) return { ok: false, code: "NO_JOURNAL", reason: "没有可回滚的安装记录" };
  const restore = restoreProfile(opts.layout, journal.tree);
  if (!restore.ok) return { ok: false, code: "NO_BACKUP", reason: restore.reason, journal: journal };
  recordStep(opts.home, "rollback", true, "已还原：" + restore.restored.join(","));
  finishInstall(opts.home);
  return { ok: true, restored: restore.restored, journal: journal };
}

export function processRunning(exe) {
  if (!exe) return false;
  if (process.platform !== "win32") return null;
  const result = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !result.stdout) return null;
  const names = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^"([^"]+)"/.exec(line);
    if (match) names.add(match[1].toLowerCase());
  }
  return names.has(path.basename(String(exe)).toLowerCase());
}

export function stopProcess(exe) {
  const name = path.basename(String(exe || ""));
  if (!name || process.platform !== "win32") return false;
  const result = spawnSync("taskkill", ["/IM", name, "/F"], { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

export function startProcess(exe) {
  if (!exe) return null;
  const child = spawn(String(exe), [], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid || null;
}

export async function waitProcessGone(exe, timeoutMs) {
  const deadline = Date.now() + (Number(timeoutMs) || 15000);
  while (Date.now() < deadline) {
    const state = processRunning(exe);
    if (state === false) return true;
    if (state === null) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return processRunning(exe) === false;
}
