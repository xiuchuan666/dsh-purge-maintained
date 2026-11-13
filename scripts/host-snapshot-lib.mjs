/**
 * host-snapshot-lib —— 全宿主树快照的纯函数层
 *
 * 为什么要有它：现有的宿主基线（docs/host-baseline.json）只记「补丁目标文件」的
 * 指纹，而且原文要靠 <file>.dshpurge.bak —— 只有补丁真的写进去过才有 bak。
 * 上游删了文件、换了包、加了新闸门，这套东西全看不见。
 *
 * 这里换另一条路：把整个 @deepseek-ai 树按「包 / 文件 / 字节数 / sha256」拍成一份
 * 快照。两份快照做 diff，就是一次升级的真实变更集，完全不依赖 .bak。
 *
 * 设计约束：
 *   - 只读：不写宿主、不建 bak、不改一个字节。
 *   - 纯函数：路径由调用方给，测试全走临时目录。
 *   - 快照是普通 JSON：能进 git、能人眼 diff、能当作下一版补丁的输入。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const TREE_SNAPSHOT_SCHEMA = 1;

/** 打补丁时写进宿主文件的标记；快照顺带数一遍，用来判断这棵树干净不干净。 */
export const PURGE_MARKER = Buffer.from("[dsh-purge]");

/** 遍历时永远跳过的目录名：依赖、git、npm 的 bin 软链目录。 */
export const DEFAULT_SKIP_DIRS = new Set(["node_modules", ".git", ".bin"]);

/**
 * 单个文件是否跳过。
 * .bak 是我们自己的备份，不是上游内容；.map 是浏览器 sourcemap，几 MB 且与判定无关。
 * 两个都可以用开关打开（排查「bak 里到底是什么」时用得上）。
 */
export function isSkippedFile(name, { includeMaps = false, includeBaks = false } = {}) {
  if (name === ".DS_Store" || name === "Thumbs.db") return true;
  if (!includeMaps && name.endsWith(".map")) return true;
  if (!includeBaks && (name.endsWith(".bak") || name.endsWith(".orig"))) return true;
  return false;
}

/** 宿主版本：<aiBase>/dsh/package.json 的 version。读不到就给 unknown，不抛。 */
export function readHostVersion(aiBase) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(aiBase, "dsh", "package.json"), "utf8"));
    return { version: String(pkg.version || "unknown"), name: String(pkg.name || "") };
  } catch {
    return { version: "unknown", name: "" };
  }
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * 递归遍历一个包目录，把每个文件塞进 out，同时累计包级统计。
 * 符号链接直接跳过：宿主树是解包产物，出现软链只可能是用户环境的手脚，
 * 跟着走既可能绕圈，也会把树外的内容混进基线。
 */
function walkDir(absDir, relDir, out, opts, pkg) {
  let ents;
  try {
    ents = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  ents.sort(byName);
  for (const e of ents) {
    if (e.isSymbolicLink()) continue;
    const abs = path.join(absDir, e.name);
    const rel = relDir ? relDir + "/" + e.name : e.name;
    if (e.isDirectory()) {
      if (opts.skipDirs.has(e.name)) continue;
      walkDir(abs, rel, out, opts, pkg);
      continue;
    }
    if (!e.isFile()) continue;
    if (isSkippedFile(e.name, opts)) continue;
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    const purge = buf.includes(PURGE_MARKER);
    out.push({
      rel,
      bytes: buf.length,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      purge,
    });
    pkg.files += 1;
    pkg.bytes += buf.length;
    if (purge) pkg.purge += 1;
  }
}

/**
 * 拍一遍宿主树。
 *
 * @param {string} aiBase 形如 <...>/node_modules/@deepseek-ai
 * @returns {{roots: string[], packages: object, files: object[], stats: object}}
 */
export function walkHostTree(aiBase, { includeMaps = false, includeBaks = false, skipDirs = DEFAULT_SKIP_DIRS, only = null } = {}) {
  const opts = { includeMaps, includeBaks, skipDirs };
  let roots = fs.readdirSync(aiBase, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("dsh-"))
    .map((e) => e.name)
    .sort();
  if (only && only.length > 0) {
    const want = new Set(only);
    roots = roots.filter((r) => want.has(r));
  }
  const files = [];
  const packages = {};
  for (const root of roots) {
    const pkg = { version: "unknown", files: 0, bytes: 0, purge: 0 };
    try {
      pkg.version = String(JSON.parse(fs.readFileSync(path.join(aiBase, root, "package.json"), "utf8")).version || "unknown");
    } catch {
      /* 没有 package.json 的目录照样拍，版本记 unknown */
    }
    walkDir(path.join(aiBase, root), root, files, opts, pkg);
    packages[root] = pkg;
  }
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  const purgeFiles = files.filter((f) => f.purge).length;
  return {
    roots,
    packages,
    files,
    stats: { packages: roots.length, files: files.length, bytes, purgeFiles },
  };
}

/**
 * 把 walk 结果定成可入库的快照对象。
 * files 存成 rel → {bytes, sha256} 的字典：diff 时按 key 求交比两次线性扫快得多，
 * 人眼 diff 时也是「一行一个文件」，不会因为数组换序产生噪声。
 */
export function buildTreeSnapshot({ aiBase, walked, capturedAt, host }) {
  const hostInfo = host || readHostVersion(aiBase);
  const files = {};
  for (const f of walked.files) files[f.rel] = { bytes: f.bytes, sha256: f.sha256 };
  return {
    schema: TREE_SNAPSHOT_SCHEMA,
    kind: "dsh-host-tree",
    capturedAt: capturedAt || new Date().toISOString(),
    host: { version: hostInfo.version, name: hostInfo.name || "" },
    aiBase: String(aiBase || "").replace(/\\/g, "/"),
    stats: {
      packages: walked.stats.packages,
      files: walked.stats.files,
      bytes: walked.stats.bytes,
      purgeFiles: walked.stats.purgeFiles,
    },
    packages: walked.packages,
    files,
  };
}

/** 快照里的树是否干净（没有我们自己的注入标记）。 */
export function isCleanSnapshot(snap) {
  return (snap && snap.stats ? snap.stats.purgeFiles || 0 : 0) === 0;
}

/**
 * 两份快照的差异。
 *
 * 刻意分级：
 *   packages.added   —— 新包 = 新的攻击面，最需要人看
 *   packages.removed —— 包没了，指过去的补丁全部作废
 *   files.changed    —— 同一个文件内容变了，闸门可能搬了家
 *   files.added/removed —— 文件级增删
 * 四类分开列，因为修法完全不同：加包要重新侦察，删包要退役补丁，
 * 改文件要重对锚点，增删文件要重定位。
 */
export function diffTreeSnapshots(baseline, current) {
  if (!baseline || !current) throw new Error("diffTreeSnapshots: two snapshots are required");
  const fromVersion = (baseline.host && baseline.host.version) || "unknown";
  const toVersion = (current.host && current.host.version) || "unknown";

  const basePkgs = baseline.packages || {};
  const curPkgs = current.packages || {};
  const packages = { added: [], removed: [], versionChanged: [] };
  for (const name of Object.keys(curPkgs)) {
    const cur = curPkgs[name];
    const prev = basePkgs[name];
    if (!prev) {
      packages.added.push({ name, version: cur.version, files: cur.files, bytes: cur.bytes });
      continue;
    }
    if (prev.version !== cur.version) {
      packages.versionChanged.push({ name, from: prev.version, to: cur.version });
    }
  }
  for (const name of Object.keys(basePkgs)) {
    if (!curPkgs[name]) packages.removed.push({ name, version: basePkgs[name].version, files: basePkgs[name].files });
  }

  const baseFiles = baseline.files || {};
  const curFiles = current.files || {};
  const added = [];
  const removed = [];
  const changed = [];
  for (const rel of Object.keys(curFiles)) {
    const b = baseFiles[rel];
    if (!b) added.push({ rel, bytes: curFiles[rel].bytes });
    else if (b.sha256 !== curFiles[rel].sha256) changed.push({ rel, wasBytes: b.bytes, nowBytes: curFiles[rel].bytes });
  }
  for (const rel of Object.keys(baseFiles)) {
    if (!curFiles[rel]) removed.push({ rel, wasBytes: baseFiles[rel].bytes });
  }

  const clean = isCleanSnapshot(baseline) && isCleanSnapshot(current);
  const dirtyNote = clean
    ? ""
    : "快照里有我们自己的注入标记（base " + ((baseline.stats && baseline.stats.purgeFiles) || 0)
      + " 个文件 / cur " + ((current.stats && current.stats.purgeFiles) || 0)
      + " 个文件），差异里混了补丁本身的改动";

  const versionChanged = fromVersion !== toVersion;
  const anyChange = versionChanged
    || packages.added.length + packages.removed.length + packages.versionChanged.length > 0
    || added.length + removed.length + changed.length > 0;

  return {
    fromVersion,
    toVersion,
    versionChanged,
    clean,
    dirtyNote,
    packages,
    files: { added, removed, changed },
    counts: {
      packagesAdded: packages.added.length,
      packagesRemoved: packages.removed.length,
      packagesVersionChanged: packages.versionChanged.length,
      filesAdded: added.length,
      filesRemoved: removed.length,
      filesChanged: changed.length,
    },
    verdict: !anyChange ? "ok" : clean ? "changed" : "unreliable",
  };
}

/** 人看的输出；返回行数组，由 CLI 决定往 stdout 还是往日志。 */
export function renderTreeDiff(diff, { limit = 40 } = {}) {
  const c = diff.counts;
  const lines = [];
  lines.push("[tree] 版本 " + diff.fromVersion + " → " + diff.toVersion + (diff.versionChanged ? "" : "（未变）"));
  lines.push("[tree] 包 +" + c.packagesAdded + " / -" + c.packagesRemoved + " / 版本变 " + c.packagesVersionChanged);
  lines.push("[tree] 文件 +" + c.filesAdded + " / -" + c.filesRemoved + " / 改 " + c.filesChanged);
  if (!diff.clean) lines.push("[tree] 警告：" + diff.dirtyNote);
  const p = diff.packages;
  if (p.added.length > 0) {
    const head = p.added.slice(0, limit).map((x) => x.name + "@" + x.version).join(", ");
    lines.push("[tree] 新增包：" + head + (p.added.length > limit ? " … 共 " + p.added.length : ""));
  }
  if (p.removed.length > 0) {
    const head = p.removed.slice(0, limit).map((x) => x.name).join(", ");
    lines.push("[tree] 消失包：" + head + (p.removed.length > limit ? " … 共 " + p.removed.length : ""));
  }
  if (p.versionChanged.length > 0) {
    lines.push("[tree] 版本变化：" + p.versionChanged.slice(0, limit).map((x) => x.name + " " + x.from + "→" + x.to).join(", "));
  }
  const list = (tag, rows, fmt) => {
    if (rows.length === 0) return;
    lines.push("[tree] " + tag + " " + rows.length + (rows.length > limit ? "（只列前 " + limit + "）" : ""));
    for (const r of rows.slice(0, limit)) lines.push("[tree]   " + fmt(r));
  };
  list("新增文件", diff.files.added, (r) => "+ " + r.rel + " (" + r.bytes + "B)");
  list("消失文件", diff.files.removed, (r) => "- " + r.rel + " (" + r.wasBytes + "B)");
  list("改动文件", diff.files.changed, (r) => "~ " + r.rel + " (" + r.wasBytes + "→" + r.nowBytes + "B)");
  return lines;
}
