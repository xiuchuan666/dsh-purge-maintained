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
 *   broken —— 有补丁从「可用/已装」跌成 drifted，或从「已装」跌成 would-apply，
 *             或补丁整条从表里消失
 *   review —— 宿主版本变了、目标文件增删改，但补丁状态还站得住
 *   ok     —— 一切相同
 *
 * 为什么 settled -> would-apply 也算失效：would-apply 的语义是「原文还是原版，
 * 这条 pattern 现在能打上去」——也就是**没打**。基线记的是 settled（打过）。
 * 2026-11-12 实测：宿主树被换回原版后，79 条 settled 全变成 would-apply，
 * 老判定给的是 changed/review，输出「有变化但补丁仍站得住」——语义完全反了。
 * drifted 与 would-apply 的区别只在修法：前者要改 pattern，后者重打即可，
 * 所以单独给一个 severity 名字，但两者都必须让 verdict 非 ok。
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
      : cur.status === "would-apply" && BROKEN_FROM.has(prev.status) ? "unapplied"
        : cur.status === "would-apply" && prev.status === "drifted" ? "still-broken"
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

  const FATAL = new Set(["broken", "still-broken", "unapplied"]);
  const broken = transitions.filter((t) => FATAL.has(t.severity));
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
 * 状态戳与宿主树是否自洽。
 *
 * 为什么需要这一条：`~/.dsh/dsh-purge/applied.json` 只记录「上次 markPatchesApplied 写了什么」，
 * 它不会因为宿主被重装 / asar 被换 / 用户手改而回退。2026-11-12 实测就撞上了：
 * 戳写着 version=1.1.94、sha=apply:1.1.94，而 resources/app/dsh 下 59 个目标文件里
 * 55 个与「打过补丁的基线」不同、`dsh-purge` 标记计数为 0 —— 树是原版，戳说已打。
 *
 * 在此之前 `host:status` 给的是 verdict=review（"有变化但补丁还站得住"），
 * 语义完全反了。所以单独出一条判据，把「戳撒谎」升级成 broken。
 *
 * @param {{stamp?: {version?: string, sha?: string}|null, installedRev?: string,
 *          pluginVersion?: string, markersPresent?: boolean}} input
 * @returns {{state: string, verdict: string, detail: string, claimsApplied: boolean, placeholder: boolean}}
 */
export function auditStampVsTree({
  stamp = null,
  installedRev = "",
  pluginVersion = "",
  markersPresent = false,
  hasAiBase = true,
} = {}) {
  const version = String(pluginVersion || "");
  const stampVersion = String(stamp?.version || "");
  const sha = String(stamp?.sha || "");
  const rev = String(installedRev || "");
  const placeholder = sha.startsWith("apply:") || sha === "applied";
  const sameVersion = !version || stampVersion === version;
  const claimsApplied = Boolean(stampVersion) && Boolean(sha) && sameVersion;

  let state;
  // 找不到插件根时无法核对（#59：web 启动早期、纯 CLI 都可能是这种状态）。
  // 这时判 broken 会让人误以为补丁丢了，所以单列一档。
  if (!hasAiBase) state = "unknown-base";
  else if (claimsApplied && markersPresent) state = "consistent-applied";
  else if (claimsApplied && !markersPresent) state = "stamp-lies";
  else if (stampVersion && !sameVersion) state = "stale-stamp";
  else if (markersPresent) state = "tree-lies";
  else state = "no-stamp";

  // stamp-lies 是唯一「功能已经没了但状态说没事」的组合，必须判 broken。
  // tree-lies 反过来：树上有补丁但戳不知道 —— 功能在，只是记录过期，review 足够。
  const verdict = state === "stamp-lies" ? "broken" : state === "tree-lies" ? "review" : "ok";

  const shaNote = sha ? `sha=${sha}${placeholder ? "（占位，不是真提交号）" : ""}` : "sha 为空";
  const revNote = rev ? `installed-rev=${rev}` : "installed-rev 为空";
  const treeNote = markersPresent ? "树上有注入标记" : "树上没有注入标记";
  const detail = state === "unknown-base"
    ? `找不到宿主插件根，无法核对状态戳（${stampVersion || "无戳"}）与宿主树 —— 这不等于补丁丢失`
    : state === "stamp-lies"
      ? `状态戳说 ${stampVersion} 已应用（${shaNote}），但${treeNote} —— 补丁不在树上，戳在撒谎`
      : state === "consistent-applied"
        ? `状态戳与宿主树一致：${stampVersion} 已应用，${treeNote}`
        : state === "stale-stamp"
          ? `状态戳是旧版本 ${stampVersion}（当前插件 ${version || "未知"}），${revNote}，${treeNote} —— 需要重打`
          : state === "tree-lies"
            ? `宿主树上有注入标记，但没有对应版本的状态戳（${stampVersion || "无"}）—— 记录过期，功能还在`
            : `没有状态戳，${treeNote} —— 干净状态`;

  return { state, verdict, detail, claimsApplied, placeholder };
}

/**
 * 合并三份判定：补丁还能不能打上去（host-baseline） + 我们调的宿主 API 还在不在
 * （host-contract） + 状态戳与宿主树是否自洽（auditStampVsTree）。
 * 三者不重叠，verdict 取更严重的那一个。
 *
 * 为什么不合算成一个分数：这三件事的修法完全不同——补丁 drifted 要改 pattern，契约
 * missing 要改代码或改契约，戳撒谎要重打或回滚。混成一个数字只会把这个信息丢掉。
 */
export function mergeVerdicts(patchVerdict, contractResult, stampAudit = null) {
  if (stampAudit && stampAudit.verdict === "broken") return "broken";
  if (contractResult && contractResult.ok === false) return "broken";
  if (stampAudit && stampAudit.verdict === "review" && patchVerdict === "ok") return "review";
  return patchVerdict;
}

/** 人读渲染。刻意短：升级当天要能一眼看出「哪个补丁废了」或「哪个宿主 API 没了」。 */
export function renderDiff(diff, { limit = 40, contract = null, stampAudit = null } = {}) {
  const lines = [];
  const contractFailed = Boolean(contract && contract.ok === false);
  const verdict = mergeVerdicts(diff.verdict, contract, stampAudit);
  const head = diff.versionChanged
    ? `host ${diff.fromVersion} -> ${diff.toVersion}`
    : `host ${diff.toVersion} (未变)`;
  lines.push(`[host] ${head}  verdict=${verdict}`);

  // 状态戳与树的自洽性放最前面：它一旦是 stamp-lies，下面「补丁状态变化」的解读都会偏。
  if (stampAudit) {
    const tag = stampAudit.state === "stamp-lies" ? "✖" : stampAudit.state === "consistent-applied" ? "✓" : "!";
    lines.push(`[host] ${tag} 状态戳核对 ${stampAudit.state}：${stampAudit.detail}`);
  }

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
    // 两类失效的修法不同，必须分开列：unapplied 重打就行，broken 要改 pattern。
    const unapplied = diff.broken.filter((b) => b.severity === "unapplied");
    const patternGone = diff.broken.filter((b) => b.severity !== "unapplied");
    if (unapplied.length) {
      lines.push(`[host] 补丁不在树上（重打即可）: ${unapplied.map((b) => `#${b.id} ${b.name}`).join(", ")}`);
    }
    if (patternGone.length) {
      lines.push(`[host] 失效补丁（要改 pattern）: ${patternGone.map((b) => `#${b.id} ${b.name}`).join(", ")}`);
      lines.push("[host] 定位用: node scripts/verify-target.mjs --ai-base <aiBase> --pad");
    }
  }
  if (contractFailed) {
    lines.push("[host] 契约详情: node scripts/host-contract.mjs --ai-base <aiBase>");
  }
  if (verdict === "ok") lines.push("[host] 补丁与契约都与基线一致，无需处理");
  if (verdict === "review") lines.push("[host] 有变化但补丁与契约仍站得住：记录后继续观察");
  if (verdict === "broken") lines.push("[host] 有失效项，按上面的分类处理后再跑一次");
  return lines.join("\n");
}
