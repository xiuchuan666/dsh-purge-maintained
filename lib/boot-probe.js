import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * 预演启动探针：补丁全绿只证明文本对得上，不证明这棵树能启动。
 *
 * rc.5 换树后的真实事故是启动即崩：
 *   No usable native binding found for node-addon-require-builtin-win32-x64-msvc
 * 而 host-rehearse 六步全绿——因为六步里没有一步真的去拉起候选树。这里补的那一步只做一件事：
 * 在候选树里找到运行时入口，隔离环境跑一次只读命令，崩了就把崩溃原因（尤其是原生绑定缺失）
 * 原样报出来。
 *
 * 入口优先级（任务约定，不能反）：
 *   1. <tree>/dsh/node_modules/@deepseek-ai/dsh-desktop-runtime 的 bin —— 真正会崩的桌面运行时；
 *   2. <resources>/runtime/cli/bin/dsh.cmd —— 官方 CLI shim（桌面包同级布局）。
 * 两个都没有 → skipped：CI 没有宿主树，这不是失败。
 *
 * 为什么是 --dump-config 而不是启动 GUI：它不挂载、不开窗口、不连网，只把组装好的 profile
 * 打出来；但「能不能回答」这件事已经要加载完整运行时（含原生绑定）。失败时用 --version 兜底，
 * 因为版本号只要求入口能被 require 到。原生绑定缺失时不再兜底：换个参数不会把 .node 变出来。
 */

export const BOOT_TIMEOUT_MS = 60000;

/** 单次输出最多留这么多字符：dump-config 可能很大，报告里只要崩溃现场。 */
export const OUTPUT_LIMIT = 20000;

/**
 * 原生绑定缺失的特征串。第一条就是 rc.5 的原文；其余是同一件事在不同包版本里的说法。
 * 只认「原生 + 绑定/模块」的组合，避免把普通的 Cannot find module 误判成绑定问题。
 */
export const NATIVE_BINDING_PATTERNS = Object.freeze([
  /No usable native binding found[^\r\n]*/i,
  /require[_-]builtin[^\r\n]{0,200}(?:native binding|\.node|NODE_MODULE_VERSION|ABI)/i,
  /Cannot find module[^\r\n]*require[_-]builtin[^\r\n]*/i,
  /was compiled against a different Node\.js version[^\r\n]*/i,
]);

/** 从 stdout+stderr 里认原生绑定缺失。返回 {detected, id, detail}，detected=false 时其余字段为空。 */
export function detectNativeBinding(text) {
  const hay = String(text == null ? "" : text);
  if (!hay) return { detected: false, id: null, detail: "" };
  for (let i = 0; i < NATIVE_BINDING_PATTERNS.length; i += 1) {
    const match = hay.match(NATIVE_BINDING_PATTERNS[i]);
    if (match) {
      return { detected: true, id: "native-binding-" + (i + 1), detail: clip(match[0].replace(/\s+/g, " ").trim(), 300) };
    }
  }
  return { detected: false, id: null, detail: "" };
}

function clip(text, limit) {
  const s = String(text == null ? "" : text);
  return s.length > limit ? s.slice(0, limit) : s;
}

function asText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function firstLine(text) {
  const line = String(text || "").split(/\r?\n/).find((item) => item.trim().length > 0);
  return line ? line.trim() : "";
}

function messageOf(error) {
  return error && error.message ? String(error.message) : String(error);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function comspec() {
  return process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
}

/**
 * 隔离环境：只留「起一个进程」必需的系统变量，DSH_* 一个都不继承。
 * 宿主自己的 DSH_HOME / DSH_RESOURCES / DSH_PROFILE 会把探测带偏（探到用户已装的那棵树，
 * 或者读到用户 profile），所以宁可给子进程一个全新的临时 home（见 probeBoot）。
 */
const ENV_KEEP = Object.freeze([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "COMSPEC", "ComSpec",
  "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "LC_ALL",
]);

export function isolatedEnv(extra, baseEnv) {
  const base = baseEnv || process.env;
  const env = {};
  for (const key of ENV_KEEP) {
    if (typeof base[key] === "string") env[key] = base[key];
  }
  return Object.assign(env, extra || {});
}

/** 入口怎么跑：.cmd 交给 cmd.exe，.exe 直跑，其余（.js/.mjs/无后缀脚本）交给当前 node。 */
function describeEntry(entry, runner) {
  const ext = path.extname(entry).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    return { kind: "cmd", runner: runner, entry: entry, command: comspec(), args: ["/d", "/s", "/c"], verbatim: true };
  }
  if (ext === ".exe" || ext === ".com") {
    return { kind: "exe", runner: runner, entry: entry, command: entry, args: [], verbatim: false };
  }
  return { kind: "node", runner: runner, entry: entry, command: process.execPath, args: [entry], verbatim: false };
}

/** 从包自己的 package.json 里读 bin；bin 是字符串或映射都要认，映射优先本包同名的键。 */
function binFromPackage(pkgDir, pkg) {
  const bin = pkg && pkg.bin;
  const rels = [];
  if (typeof bin === "string") rels.push(bin);
  else if (bin && typeof bin === "object") {
    const keys = Object.keys(bin).filter((key) => typeof bin[key] === "string");
    const preferred = keys.find((key) => key === pkg.name || key === "dsh-desktop-runtime" || key === "dsh");
    if (preferred) rels.push(bin[preferred]);
    for (const key of keys) rels.push(bin[key]);
  }
  for (const rel of ["bin/dsh.js", "bin/cli.js", "dist/bin.js", "bin/dsh.cmd"]) rels.push(rel);
  for (const rel of rels) {
    const file = path.resolve(pkgDir, rel);
    if (isFile(file)) return file;
  }
  return null;
}

/**
 * 在候选树里找运行时入口。treeDir 可以是 @deepseek-ai 目录、resources 目录、install 根或
 * app 目录；exe 是桌面可执行文件的路径（可选，用来定位同级的 resources/runtime）。
 * opts.entry 可直接指定一个入口（调试用，仍然走同一套探测与判定）。
 */
export function resolveRuntime(input) {
  const opts = input || {};
  if (!opts.treeDir) return null;
  const treeDir = path.resolve(opts.treeDir);
  if (opts.entry) {
    const entry = path.resolve(opts.entry);
    return isFile(entry) ? describeEntry(entry, "entry") : null;
  }
  for (const base of [treeDir, path.join(treeDir, "app")]) {
    const pkgDir = path.join(base, "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-runtime");
    const pkg = readJson(path.join(pkgDir, "package.json"));
    if (!pkg) continue;
    const bin = binFromPackage(pkgDir, pkg);
    if (bin) return describeEntry(bin, "desktop-runtime");
  }
  const shims = [];
  if (opts.exe) shims.push(path.join(path.dirname(path.resolve(opts.exe)), "resources", "runtime", "cli", "bin", "dsh.cmd"));
  let dir = treeDir;
  for (let i = 0; i < 4; i += 1) {
    shims.push(path.join(dir, "resources", "runtime", "cli", "bin", "dsh.cmd"));
    shims.push(path.join(dir, "runtime", "cli", "bin", "dsh.cmd"));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const shim of shims) {
    if (isFile(shim)) return describeEntry(shim, "cli-shim");
  }
  return null;
}

function invocation(target, extra) {
  if (target.kind === "cmd") {
    const line = '"' + target.entry + '"' + (extra.length > 0 ? " " + extra.join(" ") : "");
    return { command: target.command, args: target.args.concat(['"' + line + '"']), verbatim: true };
  }
  return { command: target.command, args: target.args.concat(extra), verbatim: false };
}

function displayCommand(inv) {
  const parts = [inv.command].concat(inv.args).map((part) => {
    const s = String(part);
    return s.indexOf(" ") >= 0 && !/^".*"$/.test(s) ? '"' + s + '"' : s;
  });
  return clip(parts.join(" "), 400);
}

/** 拉一次只读命令。任何失败都返回结果对象，不抛。 */
function runAttempt(target, mode, ctx) {
  const extra = mode === "dump-config" ? ["--dump-config"] : ["--version"];
  const inv = invocation(target, extra);
  const started = Date.now();
  let res;
  try {
    res = spawnSync(inv.command, inv.args, {
      encoding: "utf8",
      timeout: ctx.timeoutMs,
      env: ctx.env,
      cwd: ctx.cwd,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      windowsVerbatimArguments: inv.verbatim,
    });
  } catch (error) {
    return {
      mode: mode,
      ok: false,
      exitCode: null,
      command: displayCommand(inv),
      stdout: "",
      stderr: "",
      native: { detected: false, id: null, detail: "" },
      timedOut: false,
      reason: "spawn 抛错: " + messageOf(error),
      durationMs: Date.now() - started,
    };
  }
  const stdout = clip(asText(res.stdout), OUTPUT_LIMIT);
  const stderr = clip(asText(res.stderr), OUTPUT_LIMIT);
  const native = detectNativeBinding(stdout + "\n" + stderr);
  const timedOut = Boolean(res.error && (res.error.code === "ETIMEDOUT" || String(res.error.code || "").indexOf("ETIMEDOUT") >= 0));
  const exitCode = typeof res.status === "number" ? res.status : null;
  let ok = false;
  let reason;
  if (timedOut) {
    reason = "超时（" + ctx.timeoutMs + " ms）：树起来了但没在预算内回答";
  } else if (native.detected) {
    reason = "原生绑定缺失：" + native.detail;
  } else if (res.error) {
    reason = "spawn 失败: " + messageOf(res.error);
  } else if (exitCode !== 0) {
    const detail = firstLine(stderr) || firstLine(stdout);
    reason = "退出码 " + (exitCode === null ? "无（signal " + (res.signal || "unknown") + "）" : exitCode) + (detail ? "：" + detail : "");
  } else if (!stdout.trim()) {
    reason = "退出码 0 但 stdout 为空：入口没真正回答";
  } else {
    ok = true;
    reason = "ok";
  }
  return {
    mode: mode,
    ok: ok,
    exitCode: exitCode,
    command: displayCommand(inv),
    stdout: stdout,
    stderr: stderr,
    native: native,
    timedOut: timedOut,
    reason: reason,
    durationMs: Date.now() - started,
  };
}

/**
 * 预演一棵树的启动。永远返回对象，不抛：
 *   {ok, skipped, reason, command, exitCode, stdout, stderr,
 *    native:{detected,id,detail}, mode, entry, runner, attempts, timeoutMs, durationMs}
 * skipped=true 只表示「没有可探的入口」，不代表失败。
 */
export function probeBoot(input) {
  const opts = input || {};
  const started = Date.now();
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Math.floor(opts.timeoutMs) : BOOT_TIMEOUT_MS;
  const treeDir = opts.treeDir ? path.resolve(opts.treeDir) : null;
  const base = {
    ok: false,
    skipped: true,
    reason: "",
    command: null,
    exitCode: null,
    stdout: "",
    stderr: "",
    native: { detected: false, id: null, detail: "" },
    mode: null,
    entry: null,
    runner: null,
    attempts: [],
    timeoutMs: timeoutMs,
    durationMs: 0,
  };
  if (!treeDir) return Object.assign({}, base, { reason: "缺少 treeDir：不知道要预演哪棵树", durationMs: Date.now() - started });
  if (!fs.existsSync(treeDir)) {
    return Object.assign({}, base, { skipped: false, reason: "候选树不存在: " + treeDir, durationMs: Date.now() - started });
  }
  if (opts.entry && !isFile(path.resolve(opts.entry))) {
    return Object.assign({}, base, { skipped: false, reason: "指定的运行时入口不存在: " + path.resolve(opts.entry), durationMs: Date.now() - started });
  }
  const target = resolveRuntime({ treeDir: treeDir, exe: opts.exe, entry: opts.entry });
  if (!target) {
    return Object.assign({}, base, {
      reason: "候选树里没有运行时入口（无 @deepseek-ai/dsh-desktop-runtime，也无 runtime/cli/bin/dsh.cmd）：没有宿主树可预演，跳过",
      durationMs: Date.now() - started,
    });
  }

  const env = isolatedEnv(opts.env, opts.baseEnv);
  let tempHome = null;
  if (opts.home === null) {
    // 明确不要 home 覆盖：只在调试时用，子进程会退回 ~/.dsh
  } else if (typeof opts.home === "string" && opts.home.length > 0) {
    env.DSH_HOME = path.resolve(opts.home);
  } else {
    try {
      tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-boot-probe-"));
      env.DSH_HOME = tempHome;
    } catch {
      tempHome = null;
    }
  }

  const attempts = [];
  let chosen = null;
  try {
    for (const mode of ["dump-config", "version"]) {
      const attempt = runAttempt(target, mode, { timeoutMs: timeoutMs, env: env, cwd: opts.cwd });
      attempts.push(attempt);
      chosen = attempt;
      if (attempt.ok) break;
      // 换参数不会把缺失的 .node 变出来，别再多花一个超时预算
      if (attempt.native.detected) break;
    }
  } finally {
    if (tempHome) {
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch {
        // Windows 偶发 EPERM：临时目录留在 %TEMP% 里无害
      }
    }
  }

  const success = attempts.find((attempt) => attempt.ok) || null;
  const native = attempts.map((attempt) => attempt.native).find((item) => item && item.detected) || { detected: false, id: null, detail: "" };
  const shown = success || chosen || attempts[attempts.length - 1];
  return {
    ok: Boolean(success),
    skipped: false,
    reason: shown.reason,
    command: shown.command,
    exitCode: shown.exitCode,
    stdout: shown.stdout,
    stderr: shown.stderr,
    native: native,
    mode: shown.mode,
    entry: target.entry,
    runner: target.runner,
    attempts: attempts,
    timeoutMs: timeoutMs,
    durationMs: Date.now() - started,
  };
}

/**
 * 把一次探测折成 host-rehearse 的一步（和 rehearse-lib 的 step 形状一致，纯函数，不读盘）。
 * 判定：ok → 绿；原生绑定缺失 → 红（无论哪个入口）；
 * 桌面运行时/显式入口起不来 → 红；CLI shim 这类兜底入口的非绑定失败 → 黄（可能只是 profile 缺失）。
 */
export function probeStep(probe) {
  const p = probe || {};
  const id = "boot";
  const label = "start the candidate tree once and see if it comes up";
  if (p.skipped) {
    return {
      id: id,
      label: label,
      summary: "skipped - " + (p.reason || "no runtime entry"),
      verdict: { ok: true, blocking: [], warn: [] },
      rows: [],
      tally: { ok: 0, warn: 0, blocking: 0, skipped: 1 },
      skipped: true,
    };
  }
  const native = Boolean(p.native && p.native.detected);
  const strict = native || p.runner === "desktop-runtime" || p.runner === "entry";
  const bucket = p.ok ? "ok" : strict ? "blocking" : "warn";
  const status = p.ok ? "ok" : native ? "native-binding" : p.attempts && p.attempts.some((attempt) => attempt.timedOut) ? "timeout" : "failed";
  const why = p.ok
    ? (p.runner || "?") + " " + (p.mode || "?") + " exit 0 (" + (p.durationMs || 0) + " ms)"
    : (p.reason || "boot failed");
  const summary = [
    p.runner || "?",
    p.mode || "-",
    p.ok ? "exit 0" : "exit " + (p.exitCode === null || p.exitCode === undefined ? "?" : p.exitCode),
    p.entry || "",
  ].join(" / ").replace(/ \/ $/, "") + (p.ok ? "" : "  " + why);
  return {
    id: id,
    label: label,
    summary: summary,
    verdict: {
      ok: bucket !== "blocking",
      blocking: bucket === "blocking" ? ["candidate tree does not boot: " + why] : [],
      warn: bucket === "warn" ? ["fallback entry failed: " + why] : [],
    },
    rows: [{ id: p.runner || "boot", name: p.entry || "", status: status, bucket: bucket, why: why }],
    tally: { ok: p.ok ? 1 : 0, warn: bucket === "warn" ? 1 : 0, blocking: bucket === "blocking" ? 1 : 0, skipped: 0 },
    skipped: false,
  };
}
