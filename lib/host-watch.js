// 宿主更新探测（只读）：HEAD 头 → 指纹比较 → 手工计划。
//
// 只回答三个问题：上游变了吗（decide）、上次看到的是什么（state）、
// 变了以后人该按什么顺序动手（buildPlan）。它不下载、不解包、不碰 resources，
// 也不 import core.js —— 探测要在宿主已经坏掉、插件加载不起来的时候也能跑。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_URL =
  "https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-latest-win-x64.exe";
export const WATCH_DIR = "host-watch";
export const STATE_FILE = "host-watch.json";
export const PLAN_KINDS = ["download", "extract", "asar", "rehearse"];

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function toLength(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  const text = String(value == null ? "" : value).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

function headerEntries(headers) {
  if (!headers) return [];
  // 数组也有 .entries()（返回 [index, pair]），必须先按数组认，否则 [[k,v]] 全被当成索引键。
  if (!Array.isArray(headers) && typeof headers.entries === "function") {
    try {
      return Array.from(headers.entries());
    } catch {
      return [];
    }
  }
  if (Array.isArray(headers)) return headers.filter((pair) => Array.isArray(pair) && pair.length >= 2);
  if (typeof headers === "object") return Object.entries(headers);
  return [];
}

function headerValue(headers, name) {
  const want = name.toLowerCase();
  let found = null;
  for (const pair of headerEntries(headers)) {
    if (String(pair[0]).toLowerCase() !== want) continue;
    const value = pair[1];
    const text = Array.isArray(value) ? value.map(String).join(", ") : String(value == null ? "" : value);
    if (text.trim()) found = text.trim();
  }
  return found;
}

/** 头名大小写不敏感；四种输入都吃：node res.headers、fetch Headers、[[k,v]]、已解析的指纹对象。 */
export function parseHead(headers) {
  const plain = asObject(headers);
  // state 文件回灌的是 camelCase 指纹；再解析一次必须得到同一份东西。
  if (
    plain &&
    (Object.prototype.hasOwnProperty.call(plain, "lastModified") ||
      Object.prototype.hasOwnProperty.call(plain, "contentLength"))
  ) {
    return {
      etag: plain.etag == null ? null : String(plain.etag),
      lastModified: plain.lastModified == null ? null : String(plain.lastModified),
      contentLength: toLength(plain.contentLength),
    };
  }
  return {
    etag: headerValue(headers, "etag"),
    lastModified: headerValue(headers, "last-modified"),
    contentLength: toLength(headerValue(headers, "content-length")),
  };
}

/** 比较用的 ETag 规范形：去 W/ 前缀、去引号、去空白。文件名的清洗另有 downloadFileName。 */
export function normalizeEtag(value) {
  let text = String(value == null ? "" : value).trim();
  if (!text) return "";
  text = text.replace(/^W\//i, "").trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  return text.trim();
}

function sameStamp(a, b) {
  const left = String(a == null ? "" : a).trim();
  const right = String(b == null ? "" : b).trim();
  const ta = Date.parse(left);
  const tb = Date.parse(right);
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb;
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * 三态判定，带依据。etag 最硬（同一 build 的强校验），其次 last-modified，
 * 最后 content-length —— 但长度只用来判「变了」，长度相同不能反推「没变」，
 * 所以那条路返回 unknown 而不是 unchanged。
 */
export function decideDetail(prev, next) {
  const before = asObject(prev);
  const after = asObject(next);
  if (!after) return { verdict: "unknown", by: "none", reason: "没有新的响应头可比较" };
  const prevEtag = before ? normalizeEtag(before.etag) : "";
  const nextEtag = normalizeEtag(after.etag);
  if (prevEtag && nextEtag) {
    if (prevEtag !== nextEtag) return { verdict: "new", by: "etag", reason: prevEtag + " → " + nextEtag };
    return { verdict: "unchanged", by: "etag", reason: "ETag 相同（" + nextEtag + "）" };
  }
  const prevMod = before ? String(before.lastModified == null ? "" : before.lastModified).trim() : "";
  const nextMod = String(after.lastModified == null ? "" : after.lastModified).trim();
  if (prevMod && nextMod) {
    if (!sameStamp(prevMod, nextMod)) return { verdict: "new", by: "last-modified", reason: prevMod + " → " + nextMod };
    return { verdict: "unchanged", by: "last-modified", reason: "Last-Modified 相同（" + nextMod + "）" };
  }
  const prevLen = before ? toLength(before.contentLength) : null;
  const nextLen = toLength(after.contentLength);
  if (prevLen !== null && nextLen !== null) {
    if (prevLen !== nextLen) {
      return { verdict: "new", by: "content-length", reason: prevLen + " B → " + nextLen + " B" };
    }
    return { verdict: "unknown", by: "content-length", reason: "长度相同不代表同一构建" };
  }
  return {
    verdict: "unknown",
    by: "none",
    reason: before ? "两侧可用的指纹不重叠，没法比较" : "没有基线状态（首次探测）",
  };
}

export function decide(prev, next) {
  return decideDetail(prev, next).verdict;
}

/** <home>/.dsh/dsh-purge/host-watch.json；home 省略时用 os.homedir()。 */
export function statePath(home) {
  const base = String(home == null ? "" : home).trim() || os.homedir();
  return path.join(base, ".dsh", "dsh-purge", STATE_FILE);
}

/** 坏 JSON / 空文件 / 数组 都只回 null，绝不抛；reason 给人看。 */
export function loadStateInfo(filePath) {
  const file = String(filePath == null ? "" : filePath);
  if (!file) return { state: null, ok: false, reason: "没有状态路径" };
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const missing = error && error.code === "ENOENT";
    return { state: null, ok: false, reason: missing ? "状态文件不存在（首次探测）" : "读取失败：" + error.message };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return { state: null, ok: false, reason: "状态文件是空的" };
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { state: null, ok: false, reason: "状态文件不是合法 JSON：" + error.message };
  }
  const state = asObject(parsed);
  if (!state) return { state: null, ok: false, reason: "状态文件不是 JSON 对象" };
  return { state, ok: true, reason: "" };
}

export function loadState(filePath) {
  return loadStateInfo(filePath).state;
}

/** 先写 .tmp 再 rename；目标被占用（编辑器/杀软）时退化成覆盖写，不让探测因为写 state 挂掉。 */
export function saveState(filePath, state) {
  const file = String(filePath == null ? "" : filePath);
  if (!file) throw new Error("saveState 需要状态文件路径");
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(state == null ? {} : state, null, 2) + "\n";
  const tmp = path.join(dir, "." + path.basename(file) + "." + process.pid + ".tmp");
  fs.writeFileSync(tmp, body, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, body, "utf8");
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件留着无害，下次覆盖 */
    }
  }
  return file;
}

/**
 * 下次落盘的 state：指纹、判定、首次看到时间，以及被换掉的那一版（previous）。
 * unchanged 时 previous 和 firstSeenAt 原样继承，不会因为多跑一次就打乱「这版第一次见到」。
 */
export function nextState(prev, head, meta) {
  const options = asObject(meta) || {};
  const before = asObject(prev) || {};
  const after = parseHead(head);
  const status = String(options.status || decide(before, after));
  const stamp = String(options.checkedAt || new Date().toISOString());
  const changed = status === "new";
  const prior = asObject(before.previous) || null;
  return {
    url: String(options.url || before.url || ""),
    etag: after.etag,
    lastModified: after.lastModified,
    contentLength: after.contentLength,
    status,
    checkedAt: stamp,
    firstSeenAt: changed ? stamp : String(before.firstSeenAt || stamp),
    previous: changed
      ? {
          etag: before.etag == null ? null : before.etag,
          lastModified: before.lastModified == null ? null : before.lastModified,
          contentLength: toLength(before.contentLength),
          checkedAt: before.checkedAt == null ? null : before.checkedAt,
        }
      : prior,
  };
}

/** ETag → 文件名：去掉 W/ 和引号，非法字符折成 -，空 ETag 退到 latest。 */
export function downloadFileName(etag, fallback) {
  let text = normalizeEtag(etag);
  text = text
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  if (!text) text = String(fallback == null ? "" : fallback).trim() || "latest";
  text = text.replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!text) text = "latest";
  if (text.length > 80) text = text.slice(0, 80).replace(/[-.]+$/, "");
  if (!text) text = "latest";
  return /\.exe$/i.test(text) ? text : text + ".exe";
}

export function defaultDownloadDest(home, etag) {
  const base = String(home == null ? "" : home).trim() || os.homedir();
  return path.join(base, ".dsh", "dsh-purge", WATCH_DIR, downloadFileName(etag));
}

export function defaultInstalldir(env) {
  const source = env || process.env;
  const local = String(source.LOCALAPPDATA || "").trim() || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "Programs", "DeepSeek Harness");
}

/** 安装包 → 解包工作区：与安装包同目录的 <name>-extract/。 */
export function extractDirFor(destFile) {
  const dest = String(destFile == null ? "" : destFile);
  if (!dest) throw new Error("extractDirFor 需要下载落点");
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);
  return path.join(path.dirname(dest), base + "-extract");
}

function quote(value) {
  return '"' + String(value) + '"';
}

/**
 * 下一步的步骤数据（只生成命令，不执行）。四步固定顺序：
 * download → extract(7z) → asar → rehearse。安装永远走 scripts/host-install.mjs 的 dry-run，
 * 这里连 --apply 都不拼，避免有人整段复制时顺手把宿主换掉。
 */
export function buildPlan(options) {
  const opts = asObject(options) || {};
  const url = String(opts.url || DEFAULT_URL);
  const dest = String(opts.destFile || "");
  if (!dest) throw new Error("buildPlan 需要 destFile（下载落点）");
  const installdir =
    String(opts.installdir || process.env.DSH_RESOURCES || "").trim() || defaultInstalldir();
  const root = extractDirFor(dest);
  const appDir = path.join(root, "app");
  const asarDir = path.join(root, "asar");
  const workDir = String(opts.workdir || "").trim() || path.join(root, "work");
  const inner = path.join(root, "$PLUGINSDIR", "app-64.7z");
  const resources = /[\\/]resources$/i.test(installdir) ? installdir : path.join(installdir, "resources");
  const steps = [
    {
      kind: "download",
      title: "下载安装包（只落盘）",
      tool: "node",
      command: "node scripts/host-watch.mjs --download --url " + quote(url) + " --dest " + quote(dest),
      extra: [],
      notes: ["不运行 exe；校验 Content-Length，失败删 .part"],
    },
    {
      kind: "extract",
      title: "7z 抽安装包 → $PLUGINSDIR/app-64.7z → app/",
      tool: "7z",
      command: "7z x " + quote(dest) + " -o" + quote(root) + " -y",
      extra: ["7z x " + quote(inner) + " -o" + quote(appDir) + " -y"],
      notes: ["第二条把内层 app-64.7z 抽成 app/；本工具只生成命令，不解包"],
    },
    {
      kind: "asar",
      title: "app.asar 解包（含 unpacked 补齐与校验）",
      tool: "node",
      command:
        "node scripts/extract-asar.mjs --asar " +
        quote(path.join(appDir, "resources", "app.asar")) +
        " --dest " +
        quote(asarDir) +
        " --clean",
      extra: [],
      notes: ["缺 app.asar.unpacked 会 exit 1；不许手工 copy 顶过去"],
    },
    {
      kind: "rehearse",
      title: "原生绑定试加载 + 离线预演 + 安装 dry-run",
      tool: "node",
      command:
        "node scripts/host-rehearse.mjs --baseline-tree " +
        quote(path.join(asarDir, "dsh", "node_modules", "@deepseek-ai")) +
        " --work " +
        quote(workDir) +
        " --keep --json " +
        quote(path.join(root, "outcome.json")),
      extra: [
        "node scripts/host-adopt.mjs probe --tree " + quote(asarDir),
        "node scripts/host-install.mjs --tree " + quote(asarDir) + " --resources " + quote(resources),
      ],
      hint: "node scripts/host-watch.mjs --plan --rehearse",
      notes: [
        "host-install 默认 dry-run；--stop --apply 只能由人决定",
        "本工具永远不会安装、替换 resources 或启动宿主",
      ],
    },
  ];
  return steps.map((step, index) => Object.assign({ index: index + 1, manualOnly: true }, step));
}
