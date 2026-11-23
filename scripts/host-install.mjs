#!/usr/bin/env node
// 唯一安装入口：预检 → 快照 → 换树 → 启动健康检查 → 失败自动回滚。
// 默认 dry-run；--apply 才动进程和文件。日常换宿主版本只允许走这里。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { probeTree } from "../lib/host-probe.js";
import { readHostVersion } from "../lib/host-integrity.js";
import { installPlan, treeBytes, checkSpace } from "../lib/host-install.js";
import {
  beginInstall, recordStep, finishInstall, failInstall, loadJournal,
  rollbackPlan, summarizeJournal, pendingJournal, defaultHome,
} from "../lib/host-install-journal.js";

function parse(argv) {
  const out = { apply: false, stop: false, force: false, rollback: false, stability: 15000, timeout: 90000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--stop") out.stop = true;
    else if (a === "--force") out.force = true;
    else if (a === "--rollback") out.rollback = true;
    else if (a === "--tree") out.tree = argv[++i];
    else if (a === "--resources") out.resources = argv[++i];
    else if (a === "--exe") out.exe = argv[++i];
    else if (a === "--home") out.home = argv[++i];
    else if (a === "--stability") out.stability = Number(argv[++i]);
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else throw new Error("unknown argument: " + a);
  }
  out.home = out.home || defaultHome();
  out.resources = out.resources || process.env.DSH_RESOURCES || "C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources";
  return out;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** tasklist 只有 Windows 有；返回 null 表示查不了，调用方必须按拒绝处理。 */
function listImages() {
  if (process.platform !== "win32") return null;
  const r = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const set = new Set();
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/);
    if (m) set.add(m[1].toLowerCase());
  }
  return set;
}

function isRunning(exe) {
  const set = listImages();
  if (!set) return null;
  return set.has(path.basename(exe).toLowerCase());
}

function killApp(exe) {
  spawnSync("taskkill", ["/IM", path.basename(exe), "/F"], { encoding: "utf8" });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (isRunning(exe) === false) return true;
    sleep(500);
  }
  return isRunning(exe) === false;
}

function startApp(exe) {
  const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: "ignore" });
  child.unref();
}

function logDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "@deepseek-ai", "dsh-desktop", "logs");
}

function crashFilesSince(dir, since) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const hits = [];
  for (const name of names) {
    if (!/^crash-.*\.log$/.test(name)) continue;
    const full = path.join(dir, name);
    try { if (fs.statSync(full).mtimeMs >= since) hits.push(full); } catch { /* 略过读不到的文件 */ }
  }
  return hits;
}

/** 进程出现 + 稳定观察期内不退出 + 没有新 crash 日志，三件事都满足才算装成功。 */
function waitHealthy(exe, opts) {
  const t0 = Date.now();
  const deadline = t0 + opts.timeout;
  let seen = false;
  while (Date.now() < deadline) {
    const r = isRunning(exe);
    if (r === null) return { ok: false, reason: "无法枚举进程（tasklist 失败）", crash: [] };
    if (r) { seen = true; break; }
    sleep(1000);
  }
  if (!seen) return { ok: false, reason: "启动后进程没有出现", crash: crashFilesSince(logDir(), t0) };
  const stableUntil = Date.now() + opts.stability;
  while (Date.now() < stableUntil) {
    sleep(2000);
    if (isRunning(exe) !== true) {
      return { ok: false, reason: "进程在稳定观察期内退出", crash: crashFilesSince(logDir(), t0) };
    }
    const crash = crashFilesSince(logDir(), t0);
    if (crash.length) return { ok: false, reason: "出现新 crash 日志", crash: crash };
  }
  return { ok: true, crash: crashFilesSince(logDir(), t0) };
}

function describe(raw) {
  return raw ? Math.round(raw / (1024 * 1024)) + " MB" : "?";
}

function doRollback(args) {
  const j = loadJournal(args.home);
  const plan = rollbackPlan(j);
  if (!plan.ok) {
    console.error("[host-install] 回滚计划无效：" + plan.reason);
    return 2;
  }
  console.log(summarizeJournal(j));
  if (!args.apply) {
    console.log("[dry-run] " + plan.steps.join(" → "));
    return 0;
  }
  const exe = path.resolve(args.exe || plan.exe || "DeepSeek Harness.exe");
  const appDir = path.join(path.resolve(j.resources), "app");
  try {
    if (isRunning(exe) === true) killApp(exe);
    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
    fs.renameSync(plan.previous, appDir);
    if (plan.asarBackup && fs.existsSync(plan.asarBackup)) {
      fs.renameSync(plan.asarBackup, path.join(path.resolve(j.resources), "app.asar"));
    }
    startApp(exe);
    failInstall(args.home, { rolledBack: true, error: "manual rollback" });
    console.log("[host-install] 已回滚到 " + plan.previous + " 并重新启动");
    return 0;
  } catch (error) {
    console.error("[host-install] 回滚失败：" + error.message);
    return 1;
  }
}

function doInstall(args) {
  if (!args.tree) {
    console.error("[host-install] 需要 --tree <新 app 树>");
    return 2;
  }
  const plan = installPlan(args);
  if (!plan.ok) {
    for (const e of plan.errors) console.error("[host-install] 预检失败：" + e);
    return 2;
  }

  const probe = probeTree(plan.tree);
  console.log(probe.lines.join("\n"));
  if (!probe.ok) {
    console.error("[host-install] 新树 probe 未通过，拒绝安装");
    return 2;
  }

  const need = treeBytes(plan.tree);
  const space = checkSpace(plan.resources, need);
  console.log("[host-install] 新树 " + describe(need) + "，需要余量 " + describe(space.need) + "，可用 " + describe(space.free) + (space.note ? "（" + space.note + "）" : ""));
  if (!space.ok) {
    console.error("[host-install] 磁盘余量不足，拒绝安装");
    return 2;
  }

  const pending = pendingJournal(args.home);
  if (pending && !args.force) {
    console.error("[host-install] 存在未收尾的安装：\n" + summarizeJournal(pending));
    console.error("[host-install] 先 --rollback，确认无影响后再用 --force");
    return 3;
  }

  const runningNow = isRunning(plan.exe);
  if (runningNow === null) {
    console.error("[host-install] 无法确认宿主是否在运行（tasklist 不可用），拒绝安装");
    return 2;
  }
  if (runningNow && !args.stop) {
    console.error("[host-install] 宿主正在运行；加 --stop 让脚本关闭它（不要自己 taskkill 后手工覆盖）");
    return 2;
  }

  const cur = readHostVersion(path.join(plan.resources, "app"));
  const next = readHostVersion(plan.tree);
  console.log("[host-install] 版本：" + (cur.dsh || "?") + " → " + (next.dsh || "?"));

  if (!args.apply) {
    console.log("[dry-run] 计划：");
    plan.steps.forEach((s, i) => console.log("  " + (i + 1) + ". " + s));
    console.log("[dry-run] 未改动任何文件；确认后加 --apply" + (runningNow ? "（需要 --stop）" : ""));
    return 0;
  }

  const ts = stamp();
  const appDir = path.join(plan.resources, "app");
  const prev = path.join(plan.resources, "app.prev-" + ts);
  const asar = path.join(plan.resources, "app.asar");
  const asarBak = path.join(plan.resources, "app.asar.install-bak-" + ts);

  beginInstall(args.home, {
    tree: plan.tree, resources: plan.resources, exe: plan.exe,
    previous: prev, asarBackup: fs.existsSync(asar) ? asarBak : null, force: args.force,
  });

  let moved = false;
  let copied = false;
  let started = false;

  const rollback = (reason) => {
    try { if (started) killApp(plan.exe); } catch { /* 已退出 */ }
    try { if (copied) fs.rmSync(appDir, { recursive: true, force: true }); } catch { /* 半成品 */ }
    try { if (moved) fs.renameSync(prev, appDir); } catch { /* 旧树仍在 prev */ }
    try { if (fs.existsSync(asarBak)) fs.renameSync(asarBak, asar); } catch { /* asar 没改名 */ }
    try { startApp(plan.exe); } catch { /* 起不来只能人工介入 */ }
    recordStep(args.home, "rollback", true, reason);
    failInstall(args.home, { rolledBack: true, error: reason });
    console.error("[host-install] 已自动回滚并重启旧树：" + reason);
    console.error("[host-install] journal: " + summarizeJournal(loadJournal(args.home)).split("\n")[0]);
  };

  try {
    if (runningNow) {
      if (!killApp(plan.exe)) throw new Error("关不掉宿主进程");
      recordStep(args.home, "stop-app", true);
    }
    if (fs.existsSync(appDir)) {
      fs.renameSync(appDir, prev);
      moved = true;
      recordStep(args.home, "snapshot", true, prev);
    }
    if (fs.existsSync(asar)) {
      fs.renameSync(asar, asarBak);
      recordStep(args.home, "asar-aside", true, asarBak);
    }
    fs.cpSync(plan.tree, appDir, { recursive: true, force: true });
    copied = true;
    recordStep(args.home, "copy-tree", true);

    const after = probeTree(appDir);
    console.log(after.lines.join("\n"));
    if (!after.ok) throw new Error("装进 app 后 probe 失败");
    recordStep(args.home, "probe-after", true);

    startApp(plan.exe);
    started = true;
    recordStep(args.home, "start-app", true);

    const health = waitHealthy(plan.exe, { timeout: args.timeout, stability: args.stability });
    const crashNote = (health.crash || []).map((p) => path.basename(p)).join(",");
    if (!health.ok) throw new Error(health.reason + (crashNote ? "：" + crashNote : ""));
    recordStep(args.home, "health", true, "stability " + args.stability + "ms");

    finishInstall(args.home);
    console.log("[host-install] 安装成功：app = " + next.dsh + "；旧树保留 " + prev);
    console.log("[host-install] 回滚命令：node scripts/host-install.mjs --rollback --resources \"" + plan.resources + "\" --exe \"" + plan.exe + "\" --apply");
    return 0;
  } catch (error) {
    rollback(error.message);
    return 1;
  }
}

const args = parse(process.argv.slice(2));
if (process.argv.includes("--help") || process.argv.length === 2) {
  console.log("usage: node scripts/host-install.mjs --tree <新 app 树> [--resources <resources>] [--exe <exe>] [--stop] [--apply]");
  console.log("       node scripts/host-install.mjs --rollback [--apply]");
  console.log("  默认 dry-run；--apply 才动文件/进程。退出码：0 成功，1 失败已回滚，2 预检失败未动，3 有未收尾安装。");
  process.exit(0);
}
try {
  process.exit(args.rollback ? doRollback(args) : doInstall(args));
} catch (error) {
  console.error("[host-install] " + error.message);
  process.exit(2);
}
