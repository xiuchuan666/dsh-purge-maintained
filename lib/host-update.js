// 宿主更新一条命令（P1-3b）：把 下载 → 抽包 → 解 asar → 预演 → 安装 dry-run 串成一次执行。
//
// 边界（别在这里长出新职责）：
//   - 落点、文件名、兜底顺序沿用 lib/host-watch.js；下载仍由 scripts/host-watch.mjs --download 做；
//   - 换树仍只走 scripts/host-install.mjs，本文件永远不启动宿主 exe；
//   - apply=false 只 download + extract 到工作目录，其余步骤只回命令给人复制。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_URL,
  defaultDownloadDest,
  defaultInstalldir,
  extractDirFor,
  statePath,
} from "./host-watch.js";
import { resolveExe } from "./host-install.js";

export const PLAN_KINDS = ["download", "extract", "asar", "rehearse", "install"];
export const SEVEN_ZIP_NAMES = ["7z.exe", "7za.exe", "7zz.exe"];
export const PACKAGE_NAME = "dsh-latest-win-x64.exe";
// 本模块在仓库 lib/ 下：scripts/*.mjs 一律用绝对路径，runUpdate 的 cwd 是 workdir 也不会找错。
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function scriptPath(name) {
  return path.join(REPO_ROOT, "scripts", String(name));
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function quote(value) {
  return "\"" + String(value) + "\"";
}

function displayArg(value) {
  const text = String(value);
  if (!text) return "\"\"";
  return /[\s"]/.test(text) ? quote(text) : text;
}

/** 人看的命令行（就是步骤里的 command）；args 才是执行时的权威值，不含引号。 */
export function commandLine(command, args) {
  const head = [String(command)];
  for (const arg of Array.isArray(args) ? args : []) head.push(displayArg(arg));
  return head.join(" ");
}

function fileSize(file) {
  const target = String(file == null ? "" : file);
  if (!target) return 0;
  try {
    const st = fs.statSync(target);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

function tail(text, max) {
  const limit = typeof max === "number" && max > 0 ? max : 800;
  const value = String(text == null ? "" : text).trim();
  return value.length > limit ? "…" + value.slice(-limit) : value;
}

/**
 * 7z 探测：候选目录（默认取 Program Files 系与 LOCALAPPDATA）→ PATH。
 * exists / env / pathEntries / candidates 都可注入，测试不碰真实磁盘；
 * 传了 candidates 就只认这几个目录（外加 extraDir），便于确定性测试。
 */
export function findSevenZip(options) {
  const opts = asObject(options) || {};
  const env = asObject(opts.env) || process.env;
  const exists = typeof opts.exists === "function" ? opts.exists : (target) => fs.existsSync(target);
  const dirs = [];
  const push = (dir) => {
    const text = String(dir == null ? "" : dir).trim();
    if (text && !dirs.includes(text)) dirs.push(text);
  };
  push(opts.extraDir);
  if (Array.isArray(opts.candidates)) {
    for (const dir of opts.candidates) push(dir);
  } else {
    for (const key of ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]) {
      const base = String(env[key] || "").trim();
      if (base) push(path.join(base, "7-Zip"));
    }
    const local = String(env.LOCALAPPDATA || "").trim();
    if (local) push(path.join(local, "Programs", "7-Zip"));
    push("C:\\Program Files\\7-Zip");
    push("C:\\Program Files (x86)\\7-Zip");
  }

  const tried = [];
  for (const dir of dirs) {
    for (const name of SEVEN_ZIP_NAMES) {
      const full = path.join(dir, name);
      tried.push(full);
      if (exists(full)) return { ok: true, path: full, tried: tried, reason: "" };
    }
  }

  const raw = opts.pathEntries != null ? opts.pathEntries : String(env.PATH || env.Path || "");
  const entries = Array.isArray(raw) ? raw : String(raw).split(path.delimiter);
  for (const entry of entries) {
    const dir = String(entry || "").trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    for (const name of SEVEN_ZIP_NAMES) {
      const full = path.join(dir, name);
      tried.push(full);
      if (exists(full)) return { ok: true, path: full, tried: tried, reason: "" };
    }
  }

  return {
    ok: false,
    path: "",
    tried: tried,
    reason:
      "找不到 7z（试过 " + tried.length + " 个位置：常见安装目录与 PATH 都没有）；装 7-Zip，或用 --sevenzip 指定 7z.exe",
  };
}

/**
 * 五步计划（只生成命令，不执行）。每一步 {index, kind, command, args, why}，
 * 复合步骤把第二条命令放进 follow（同样带 command/args/why）。
 * 返回的数组上挂一个不可枚举的 meta（runUpdate 靠它知道 workdir/dest/resources/exe/7z）。
 */
export function planUpdate(options) {
  const opts = asObject(options) || {};
  const home = String(opts.home == null ? "" : opts.home).trim() || os.homedir();
  const url = String(opts.url || DEFAULT_URL);
  const installdir = String(opts.installdir || "").trim() || defaultInstalldir();
  const resourcesGiven = String(opts.resources || "").trim();
  const resources =
    resourcesGiven || (/[\\/]resources$/i.test(installdir) ? installdir : path.join(installdir, "resources"));
  const exeGiven = String(opts.exe || "").trim();
  const exe = resolveExe(resources, exeGiven);

  const workdirGiven = String(opts.workdir || "").trim();
  const workdir = workdirGiven
    ? path.resolve(workdirGiven)
    : path.resolve(extractDirFor(defaultDownloadDest(home, "")));
  const dest = String(opts.dest || "").trim()
    ? path.resolve(String(opts.dest).trim())
    : path.join(workdir, PACKAGE_NAME);
  const app = path.join(workdir, "app");
  const asar = path.join(workdir, "asar");
  const inner = path.join(workdir, "$PLUGINSDIR", "app-64.7z");
  const appAsar = path.join(app, "resources", "app.asar");
  const rehearseWork = path.join(workdir, "rehearse-work");
  const outcome = path.join(workdir, "outcome.json");
  const stateFile = String(opts.state || "").trim() || statePath(home);

  const explicitZip = String(opts.sevenZip || "").trim();
  const probe = explicitZip
    ? { ok: true, path: path.resolve(explicitZip), tried: [], reason: "" }
    : findSevenZip({ env: opts.env, candidates: opts.candidates, pathEntries: opts.pathEntries, extraDir: opts.extraDir });
  const zip = probe.path || "7z";
  const stop = opts.stop === true;
  const apply = opts.apply === true;
  const force = opts.force === true;

  const downloadArgs = ["node", scriptPath("host-watch.mjs"), "--download", "--url", url, "--dest", dest, "--state", stateFile];
  const extractArgs = [zip, "x", dest, "-o" + workdir, "-y"];
  const innerArgs = [zip, "x", inner, "-o" + app, "-y"];
  const asarArgs = ["node", scriptPath("extract-asar.mjs"), "--asar", appAsar, "--dest", asar, "--clean"];
  const rehearseArgs = [
    "node",
    scriptPath("host-rehearse.mjs"),
    "--baseline-tree",
    path.join(asar, "dsh", "node_modules", "@deepseek-ai"),
    "--work",
    rehearseWork,
    "--keep",
    "--json",
    outcome,
  ];
  const adoptArgs = ["node", scriptPath("host-adopt.mjs"), "probe", "--tree", asar];
  const installArgs = ["node", scriptPath("host-install.mjs"), "--tree", asar, "--resources", resources, "--exe", exe];
  if (stop) installArgs.push("--stop");
  if (apply) installArgs.push("--apply");

  const steps = [
    {
      index: 1,
      kind: "download",
      command: commandLine("node", downloadArgs.slice(1)),
      args: downloadArgs,
      why: "只把安装包落到工作目录；host-watch 校验 Content-Length，不符删 .part，不运行 exe",
    },
    {
      index: 2,
      kind: "extract",
      command: commandLine(zip, extractArgs.slice(1)),
      args: extractArgs,
      follow: [
        {
          command: commandLine(zip, innerArgs.slice(1)),
          args: innerArgs,
          why: "内层 app-64.7z 才是 app 树；外层 exe 只解出 $PLUGINSDIR",
        },
      ],
      why: "两步 7z：外层 exe 抽到工作目录，再抽内层得到 app/；探不到 7z 会先报错，不会静默跳过",
    },
    {
      index: 3,
      kind: "asar",
      command: commandLine("node", asarArgs.slice(1)),
      args: asarArgs,
      why: "必须走 extract-asar（会补 app.asar.unpacked 里的 *.node）；手工 copy 只会得到缺原生绑定的空壳树",
    },
    {
      index: 4,
      kind: "rehearse",
      command: commandLine("node", rehearseArgs.slice(1)),
      args: rehearseArgs,
      follow: [
        {
          command: commandLine("node", adoptArgs.slice(1)),
          args: adoptArgs,
          why: "adopt probe 只读探测新树能否被宿主认出来",
        },
      ],
      why: "原生绑定试加载 + 离线预演；不启动宿主，也不碰 resources",
    },
    {
      index: 5,
      kind: "install",
      command: commandLine("node", installArgs.slice(1)),
      args: installArgs,
      why: "唯一换树入口，默认 dry-run；只有 planUpdate 显式 apply:true 时才带安装开关，--stop 才允许关宿主",
    },
  ];

  const meta = {
    url: url,
    home: home,
    installdir: installdir,
    resources: resources,
    resourcesGiven: Boolean(resourcesGiven),
    exe: exe,
    exeGiven: Boolean(exeGiven),
    workdir: workdir,
    dest: dest,
    app: app,
    asar: asar,
    inner: inner,
    rehearseWork: rehearseWork,
    outcome: outcome,
    stateFile: stateFile,
    sevenZip: probe.path || "",
    sevenZipError: probe.reason || "",
    sevenZipTried: probe.tried || [],
    apply: apply,
    stop: stop,
    force: force,
  };
  Object.defineProperty(steps, "meta", { value: meta, enumerable: false, configurable: true });
  return steps;
}

function planSteps(plan) {
  if (Array.isArray(plan)) return plan;
  const holder = asObject(plan);
  return holder && Array.isArray(holder.steps) ? holder.steps : null;
}

/** 计划元数据；数组或 {steps, meta} 两种入参都认，读不到回 null。 */
export function planMeta(plan) {
  if (Array.isArray(plan) && asObject(plan.meta)) return plan.meta;
  const holder = asObject(plan);
  return holder && asObject(holder.meta) ? holder.meta : null;
}

function stepCalls(step) {
  const calls = [];
  const first = { command: String(step.command || ""), args: Array.isArray(step.args) ? step.args.slice() : [] };
  calls.push(first);
  for (const extra of Array.isArray(step.follow) ? step.follow : []) {
    calls.push({
      command: String(extra.command || ""),
      args: Array.isArray(extra.args) ? extra.args.slice() : [],
      why: String(extra.why || ""),
    });
  }
  return calls;
}

function refuseHostExec(args, hostExe) {
  const target = String((args && args[0]) || "");
  const exe = String(hostExe || "");
  if (!target || !exe || target === "node") return;
  if (path.resolve(target).toLowerCase() === path.resolve(exe).toLowerCase()) {
    throw new Error("拒绝直接执行宿主 exe：" + exe + "（换树只能走 scripts/host-install.mjs）");
  }
}

function runCommand(command, args, context) {
  const target = String(command) === "node" ? process.execPath : String(command);
  const cwd = context && context.cwd && fs.existsSync(context.cwd) ? context.cwd : undefined;
  const result = spawnSync(target, args, { cwd: cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const status = typeof result.status === "number" ? result.status : result.error ? 1 : 0;
  return {
    status: status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error.message) : "",
  };
}

/**
 * 顺序执行计划。
 *   apply=false：只 download（落点已存在且非空则跳过）+ extract；asar/rehearse/install 只进 next。
 *   apply=true ：五步全跑；但 install 段要求 planUpdate 也拿到 apply:true，
 *               且 --exe / --resources 必须是显式给的（推断值直接拒）。
 * exec 可注入（cmd, args, ctx) => {status, stdout, stderr, error}，测试不联网、不碰真 7z。
 */
export async function runUpdate(plan, options) {
  const opts = asObject(options) || {};
  const steps = planSteps(plan);
  if (!steps || steps.length === 0) throw new Error("runUpdate 需要 planUpdate() 返回的步骤数组");
  const meta = planMeta(plan) || {};
  const apply = opts.apply === true;
  const exec = typeof opts.exec === "function" ? opts.exec : runCommand;
  const onStep = typeof opts.onStep === "function" ? opts.onStep : null;
  const workdir = String(meta.workdir || "").trim();

  if (apply) {
    const missing = [];
    if (!meta.exeGiven) missing.push("--exe");
    if (!meta.resourcesGiven) missing.push("--resources");
    if (missing.length) {
      throw new Error("--apply 拒跑：缺 " + missing.join(" / ") + "（不会拿推断出来的路径去换宿主）");
    }
    if (!fs.existsSync(String(meta.resources || ""))) throw new Error("resources 不存在：" + meta.resources);
    if (!fs.existsSync(String(meta.exe || ""))) throw new Error("找不到宿主可执行文件：" + meta.exe);
  }

  const executed = [];
  const skipped = [];
  const next = [];

  for (const step of steps) {
    const kind = String(step.kind || "unknown");
    const calls = stepCalls(step);
    const allowed = apply ? kind !== "install" || meta.apply === true : kind === "download" || kind === "extract";
    if (!allowed) {
      const reason = apply ? "计划没带安装开关（planUpdate 需要 apply:true）" : "dry-run 只做 download + extract";
      skipped.push({ kind: kind, command: calls[0].command, reason: reason });
      for (const call of calls) next.push({ kind: kind, command: call.command });
      if (onStep) onStep({ step: step, action: "skip", reason: reason });
      continue;
    }

    if (kind === "download" && !meta.force && fileSize(meta.dest) > 0) {
      const reason = "安装包已存在（" + fileSize(meta.dest) + " B），要重下加 --force";
      skipped.push({ kind: kind, command: calls[0].command, reason: reason });
      if (onStep) onStep({ step: step, action: "skip", reason: reason });
      continue;
    }

    if (kind === "extract" && !meta.sevenZip) {
      throw new Error(
        "找不到 7z：" + (meta.sevenZipError || "未探测到 7-Zip") + "；解包与后续步骤没有继续，工作目录未被改动",
      );
    }

    const records = [];
    if (onStep) onStep({ step: step, action: "run", command: calls[0].command });
    for (const call of calls) {
      refuseHostExec(call.args, meta.exe);
      const result = await exec(call.args[0], call.args.slice(1), { cwd: workdir, kind: kind, index: step.index });
      const status = result && typeof result.status === "number" ? result.status : 0;
      const stdout = String((result && result.stdout) || "");
      const stderr = String((result && result.stderr) || "");
      const error = String((result && result.error) || "");
      records.push({ command: call.command, status: status, stdout: tail(stdout), stderr: tail(stderr), error: error });
      if (error || status !== 0) {
        const detail = tail(error || stderr || stdout || "exit " + status, 400);
        const failure = new Error("步骤 " + kind + " 失败：" + detail);
        failure.kind = kind;
        failure.records = records;
        failure.executed = executed;
        throw failure;
      }
    }
    executed.push({
      kind: kind,
      command: calls[0].command,
      calls: records,
      stdout: tail(records.map((item) => item.stdout).filter(Boolean).join("\n")),
      stderr: tail(records.map((item) => item.stderr).filter(Boolean).join("\n")),
    });
  }

  const hint = apply
    ? "已按要求执行到底；失败会自动回滚，回滚命令在 host-install 输出里"
    : "确认无误后：node scripts/host-update.mjs --resources \"" +
      String(meta.resources || "") +
      "\" --exe \"" +
      String(meta.exe || "") +
      "\" --apply";

  return {
    ok: true,
    apply: apply,
    dryRun: !apply,
    workdir: workdir,
    dest: String(meta.dest || ""),
    sevenZip: String(meta.sevenZip || "") || null,
    executed: executed,
    skipped: skipped,
    next: next,
    applyHint: hint,
  };
}
