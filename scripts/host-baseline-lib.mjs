/**
 * host-baseline-lib —— 宿主适配基线的纯函数层
 *
 * 设计约束：
 *   - 只读：本文件不写宿主目录，只读文件内容算哈希。
 *   - 可测：全部函数不碰真实安装，路径由调用方给，测试用临时目录。
 *   - 不含补丁判定：补丁状态一律来自 scripts/verify-target.mjs 的输出，
 *     避免这里长成第二份平行判定（历史上 #88 就是这么被误报的）。
 *
 * 基线快照里只存「相对 aiBase 的 posix 路径 + sha256 + 字节数」，
 * 不存绝对路径，仓库换机器也能读。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const SNAPSHOT_SCHEMA = 1;

const AI_DIR = "@deepseek-ai";

function isDir(fp) {
  try {
    return fs.statSync(fp).isDirectory();
  } catch {
    return false;
  }
}

function isFile(fp) {
  try {
    return fs.statSync(fp).isFile();
  } catch {
    return false;
  }
}

/** aiBase 至少得有一个 dsh-* 包目录，否则不是 npm 布局的 host 树。 */
export function looksLikeAiBase(dir) {
  if (!dir || !isDir(dir)) return false;
  try {
    return fs.readdirSync(dir).some((n) => n.startsWith("dsh-") && isDir(path.join(dir, n)));
  } catch {
    return false;
  }
}

/**
 * 真宿主树：目录下直接有 dsh/package.json，且包名是 @deepseek-ai/<...>。
 * 桌面安装的 resources/app/node_modules/@deepseek-ai 里也有 dsh-* 目录，
 * 但那是 Electron 外壳的依赖，不是宿主本体（喂给 targetFiles 会得到 0 个文件）。
 */
export function looksLikeHostTree(dir) {
  if (!looksLikeAiBase(dir)) return false;
  const pkgFile = path.join(dir, "dsh", "package.json");
  if (!isFile(pkgFile)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    return String(pkg.name || "").startsWith("@deepseek-ai/");
  } catch {
    return false;
  }
}

/**
 * 把「用户随手给的路径」收敛成 @deepseek-ai 目录。
 * 认得出：exe 安装根、resources、resources/app、app/dsh、@deepseek-ai 本身。
 * 只认「真宿主树」（含 dsh/package.json），否则 resources/app/node_modules/@deepseek-ai
 * 这种外壳依赖会被误当成宿主。
 */
export function resolveAiBase(input) {
  if (!input) return null;
  const p = path.resolve(String(input));
  const candidates = [
    p,
    path.join(p, AI_DIR),
    path.join(p, "node_modules", AI_DIR),
    path.join(p, "dsh", "node_modules", AI_DIR),
    path.join(p, "resources", "app", "dsh", "node_modules", AI_DIR),
    path.join(p, "resources", "app", "node_modules", AI_DIR),
  ];
  for (const cand of candidates) {
    if (looksLikeHostTree(cand)) return cand.replace(/\\/g, "/");
  }
  return null;
}

/**
 * 扫本机已知安装位置（只读，不改任何东西）。
 * 顺序：显式 env → LOCALAPPDATA/Programs 下每个候选。
 */
export function findAiBase({ env = process.env, programsDir } = {}) {
  const explicit = env.DSH_HOST_AI_BASE || env.DSH_AI_BASE || env.DSH_HOST_DIR;
  if (explicit) {
    const hit = resolveAiBase(explicit);
    if (hit) return hit;
  }
  const roots = [];
  if (programsDir) roots.push(programsDir);
  if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, "Programs"));
  if (env.ProgramFiles) roots.push(env.ProgramFiles);
  if (env["ProgramFiles(x86)"]) roots.push(env["ProgramFiles(x86)"]);
  for (const root of roots) {
    if (!isDir(root)) continue;
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/deepseek|dsh/i.test(name)) continue;
      const appDir = path.join(root, name, "resources", "app");
      if (!isDir(appDir)) continue;
      const hit = resolveAiBase(appDir);
      if (hit) return hit;
    }
  }
  return null;
}

export function sha256File(fp) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
  } catch {
    return "";
  }
}

export function sha256Text(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function relOf(aiBase, fp) {
  return path.relative(aiBase, fp).replace(/\\/g, "/");
}

/**
 * 目标文件指纹表：{ key: { rel, bytes, sha256 } }。
 * targetFiles() 的键值可能是数组，这里统一摊平成 `<key>` 与 `<key>#<i>`。
 */
export function fingerprintTargets(aiBase, files) {
  const out = {};
  for (const [key, val] of Object.entries(files || {})) {
    const list = Array.isArray(val) ? val : [val];
    const kept = list.filter((fp) => fp && isFile(fp));
    kept.forEach((fp, i) => {
      const name = kept.length > 1 ? `${key}#${i}` : key;
      out[name] = { rel: relOf(aiBase, fp), bytes: fs.statSync(fp).size, sha256: sha256File(fp) };
    });
  }
  return out;
}

/** 从 verify-target 的 --json 输出抽出补丁状态行。 */
export function normalizePatchRows(rows) {
  return (rows || []).map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    files: r.files || {},
  }));
}

export function buildSnapshot({ host, aiBase, files, rows, capturedAt, packageVersion }) {
  const patchRows = normalizePatchRows(rows);
  const count = (s) => patchRows.filter((r) => r.status === s).length;
  return {
    schema: SNAPSHOT_SCHEMA,
    capturedAt: capturedAt || new Date().toISOString(),
    pluginVersion: packageVersion || "",
    host: {
      version: host?.version ?? "unknown",
      name: host?.name ?? "",
      packagePath: host?.path ?? "",
    },
    aiBase: String(aiBase || "").replace(/\\/g, "/"),
    files: fingerprintTargets(aiBase, files),
    patches: patchRows,
    summary: {
      patches: patchRows.length,
      settled: count("settled"),
      wouldApply: count("would-apply"),
      drifted: count("drifted"),
      noFile: count("no-file"),
      na: count("na"),
    },
  };
}

const BROKEN_FROM = new Set(["settled", "would-apply"]);

/**
 * 比对两份快照。verdict:
 *   broken —— 有补丁从「可用/已装」跌成 drifted，或新出现 drifted
 *   review —— 宿主版本变了、目标文件增删改，但补丁状态还站得住
 *   ok     —— 一切相同
 */
export function diffSnapshots(baseline, current) {
  if (!baseline || !current) throw new Error("diffSnapshots: both snapshots are required");

  const fromVersion = baseline.host?.version ?? "unknown";
  const toVersion = current.host?.version ?? "unknown";
  const versionChanged = fromVersion !== toVersion;

  const baseFiles = baseline.files || {};
  const curFiles = current.files || {};
  const files = [];
  for (const key of new Set([...Object.keys(baseFiles), ...Object.keys(curFiles)])) {
    const a = baseFiles[key];
    const b = curFiles[key];
    if (a && !b) files.push({ key, state: "removed", was: a.rel });
    else if (!a && b) files.push({ key, state: "added", now: b.rel });
    else if (a.sha256 !== b.sha256) files.push({ key, state: "changed", rel: b.rel, wasBytes: a.bytes, nowBytes: b.bytes });
  }

  const basePatches = new Map((baseline.patches || []).map((p) => [p.id, p]));
  const curPatches = new Map((current.patches || []).map((p) => [p.id, p]));
  const transitions = [];
  const gained = [];
  for (const [id, cur] of curPatches) {
    const prev = basePatches.get(id);
    if (!prev) {
      transitions.push({ id, name: cur.name, from: "(new)", to: cur.status, severity: "info" });
      continue;
    }
    if (prev.status === cur.status) continue;
    const severity = cur.status === "drifted"
      ? (BROKEN_FROM.has(prev.status) ? "broken" : "still-broken")
      : prev.status === "drifted" ? "recovered"
        : "changed";
    transitions.push({ id, name: cur.name, from: prev.status, to: cur.status, severity });
    if ((prev.status === "no-file" || prev.status === "(new)") && cur.status === "would-apply") {
      gained.push({ id, name: cur.name });
    }
  }
  for (const [id, prev] of basePatches) {
    if (!curPatches.has(id)) transitions.push({ id, name: prev.name, from: prev.status, to: "(gone)", severity: "broken" });
  }

  const broken = transitions.filter((t) => t.severity === "broken" || t.severity === "still-broken");
  const verdict = broken.length > 0 ? "broken" : (versionChanged || files.length > 0 || transitions.length > 0) ? "review" : "ok";

  return {
    fromVersion,
    toVersion,
    versionChanged,
    files,
    transitions,
    gained,
    broken,
    verdict,
  };
}

/**
 * 合并两份判定：补丁还能不能打上去（host-baseline） + 我们调的宿主 API 还在不在
 * （host-contract）。两者不重叠，verdict 取更严重的那一个。
 *
 * 为什么不合算成一个分数：这两件事的修法完全不同——补丁 drifted 要改 pattern，契约
 * missing 要改代码或改契约。混成一个数字只会把这个信息丢掉。
 */
export function mergeVerdicts(patchVerdict, contractResult) {
  if (!contractResult || contractResult.ok !== false) return patchVerdict;
  return "broken";
}

/** 人读渲染。刻意短：升级当天要能一眼看出「哪个补丁废了」或「哪个宿主 API 没了」。 */
export function renderDiff(diff, { limit = 40, contract = null } = {}) {
  const lines = [];
  const contractFailed = Boolean(contract && contract.ok === false);
  const verdict = mergeVerdicts(diff.verdict, contract);
  const head = diff.versionChanged
    ? `host ${diff.fromVersion} -> ${diff.toVersion}`
    : `host ${diff.toVersion} (未变)`;
  lines.push(`[host] ${head}  verdict=${verdict}`);

  if (diff.files.length) {
    lines.push(`[host] 目标文件变化 ${diff.files.length} 个`);
    for (const f of diff.files.slice(0, limit)) {
      const detail = f.state === "changed" ? `${f.rel}  ${f.wasBytes}->${f.nowBytes}B`
        : f.state === "removed" ? `移出 ${f.was}`
          : `新增 ${f.now}`;
      lines.push(`    ${f.state.padEnd(8)}${f.key.padEnd(28)}${detail}`);
    }
    if (diff.files.length > limit) lines.push(`    ... 还有 ${diff.files.length - limit} 个`);
  }

  if (diff.transitions.length) {
    lines.push(`[host] 补丁状态变化 ${diff.transitions.length} 条`);
    for (const t of diff.transitions.slice(0, limit)) {
      lines.push(`    ${String(t.id).padStart(3)} ${t.name.padEnd(40)}${t.from} -> ${t.to}  (${t.severity})`);
    }
    if (diff.transitions.length > limit) lines.push(`    ... 还有 ${diff.transitions.length - limit} 条`);
  }

  if (diff.gained.length) {
    lines.push(`[host] 新增可打位置 ${diff.gained.length} 个: ${diff.gained.map((g) => `#${g.id}`).join(", ")}`);
  }

  if (contractFailed) {
    lines.push(`[host] 宿主契约缺失 ${contract.missing.length}/${contract.total} 项（补丁能打上去，但代码调的 API 没了）`);
    for (const m of contract.missing.slice(0, 12)) {
      lines.push(`    ${m.kind.padEnd(8)}${m.name.padEnd(30)}${m.detail}`);
    }
    if (contract.missing.length > 12) lines.push(`    ... 还有 ${contract.missing.length - 12} 项`);
  }

  if (diff.verdict === "broken") {
    lines.push(`[host] 失效补丁: ${diff.broken.map((b) => `#${b.id} ${b.name}`).join(", ")}`);
    lines.push("[host] 定位用: node scripts/verify-target.mjs --ai-base <aiBase> --pad");
  }
  if (contractFailed) {
    lines.push("[host] 契约详情: node scripts/host-contract.mjs --ai-base <aiBase>");
  }
  if (verdict === "ok") lines.push("[host] 补丁与契约都与基线一致，无需处理");
  if (verdict === "review") lines.push("[host] 有变化但补丁与契约仍站得住：记录后继续观察");
  return lines.join("\n");
}
