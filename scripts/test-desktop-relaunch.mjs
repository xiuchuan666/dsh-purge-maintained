/**
 * 重启路径上的纯函数：lib/desktop.js。
 *
 * 这一簇只做两件事 —— 拼一份 WSH 脚本文本、算几个「往哪写 / 用哪个 node」的小判定。
 * 它们坏掉的后果都不报错：
 *   - officialRestartScript 少一条 taskkill / 少一次重试 → 用户点重启，应用没了但不回来；
 *   - 脚本里把中文路径写成裸字节 → WSH 按 ANSI 读，路径变乱码，exe 永远找不到；
 *   - dshHomeForRelaunch 少算 .dsh 那一层 → 重起来之后配置全丢，看起来像「重置了」；
 *   - helperEnv 漏删 ELECTRON_RUN_AS_NODE → helper 被当成 Node 跑，Electron 起不来。
 *
 * 不测 restartOfficialHarness / scheduleRestart / scheduleAsarSwapRestart / spawnHelper：
 * 它们会真 spawn detached 子进程、真杀 Electron、真挪 app.asar，或者 setTimeout 里
 * process.exit(0) —— 直接调用会把跑测试的进程带走。这几条盲区写在 docs/test-map.md 第十节。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cleanupLegacyRestartScripts,
  planOfficialRestart,
  dshHomeForRelaunch,
  helperEnv,
  helperNodePath,
  officialExeFromProcess,
  officialRestartLogState,
  officialRestartScript,
  probeWshJsEngine,
  systemPromptFiles,
  unpackedHostIsClean,
} from "../lib/desktop.js";
import { HOST_CLEAN_MARKERS } from "../lib/host-clean.js";
import { isWshAscii } from "../lib/official-update.js";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-relaunch-"));
const RESTART_LOG = path.join(os.tmpdir(), "dsh-purge-official-restart.log");
const ORIG_HOME = process.env.DSH_HOME;
const ORIG_LOG = fs.existsSync(RESTART_LOG) ? fs.readFileSync(RESTART_LOG, "utf8") : null;

test.after(() => {
  if (ORIG_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIG_HOME;
  try {
    if (ORIG_LOG === null) fs.rmSync(RESTART_LOG, { force: true });
    else fs.writeFileSync(RESTART_LOG, ORIG_LOG, "utf8");
  } catch {
    /* 真机日志还原不了也不影响结论 */
  }
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发 EPERM */
  }
});

/** 每个用例一个子目录，避免互相看见对方造的文件。 */
function box(tag) {
  const root = path.join(SANDBOX, tag);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function withHome(value, fn) {
  if (value === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = value;
  try {
    return fn();
  } finally {
    if (ORIG_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = ORIG_HOME;
  }
}

/** 造一棵最小安装树：<root>/install/DeepSeek Harness.exe + resources/app/... */
function installTree(tag, opts = {}) {
  const root = box(tag);
  const installDir = path.join(root, "install");
  const appDir = path.join(installDir, "resources", "app");
  fs.mkdirSync(appDir, { recursive: true });
  const exe = path.join(installDir, "DeepSeek Harness.exe");
  fs.writeFileSync(exe, "MZ", "utf8");
  if (opts.primary) {
    const fp = path.join(appDir, "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js");
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, opts.primary, "utf8");
  }
  if (opts.alt) {
    const fp = path.join(appDir, "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js");
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, opts.alt, "utf8");
  }
  return { root, installDir, appDir, exe };
}

const EXE = "C:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe";
const ASAR = "C:\\Apps\\DeepSeek Harness\\resources\\app.asar";

/* ------------------------------------------------------------ officialRestartScript */

test("重启脚本整份用 CRLF 拼行：WSH 拿到混行尾的文件会在奇怪的位置报语法错", () => {
  const text = officialRestartScript(EXE, ASAR, "C:\\Users\\x\\.dsh");
  assert.ok(text.length > 3000, `脚本不该这么短：${text.length}`);
  assert.equal(text.replace(/\r\n/g, "").includes("\n"), false, "不允许出现裸 LF");
  assert.equal(text.replace(/\r\n/g, "").includes("\r"), false, "不允许出现裸 CR");
  assert.ok(text.split("\r\n").length > 40, `行数太少：${text.split("\r\n").length}`);
});

test("重启脚本把 exe / asar / home 三个路径都写进头部，且顺序固定", () => {
  const head = officialRestartScript(EXE, ASAR, "C:\\Users\\x\\.dsh").split("\r\n").slice(0, 3);
  assert.deepEqual(head, [
    'var exe = "C:\\\\Apps\\\\DeepSeek Harness\\\\DeepSeek Harness.exe";',
    'var asar = "C:\\\\Apps\\\\DeepSeek Harness\\\\resources\\\\app.asar";',
    'var home = "C:\\\\Users\\\\x\\\\.dsh";',
  ]);
});

test("重启脚本的空 home 写成空字符串，不是 null 也不是 undefined 字面量", () => {
  for (const value of ["", undefined, null]) {
    const line = officialRestartScript(EXE, ASAR, value).split("\r\n")[2];
    assert.equal(line, 'var home = "";', `home=${String(value)} 时写成了 ${line}`);
  }
});

test("重启脚本按 PID 杀进程，绝不按镜像名 /IM 全名杀", () => {
  const text = officialRestartScript(EXE, ASAR, "");
  assert.ok(text.includes("taskkill.exe /F /PID "), "必须按 PID 杀");
  assert.equal(/taskkill[^\r\n]*\/IM/.test(text), false, "按 /IM 全名杀会误伤同名第三方进程");
  assert.ok(text.includes("for (var i = 0; i < list.length; i++)"), "要逐个 PID 杀，不是一次拼一个长命令行");
});

test("重启脚本的换名重试有上限（n < 80），不是无限循环", () => {
  const text = officialRestartScript(EXE, ASAR, "");
  assert.ok(text.includes("n < 80"), "换名重试次数上限丢了就可能在占用时卡死");
  assert.equal(/while \(true\)/.test(text), false, "不允许无界循环");
});

test("重启脚本等 800ms 再杀、杀完最多等 20 秒，末尾只占用 45 秒而不是 180 秒", () => {
  const text = officialRestartScript(EXE, ASAR, "");
  assert.ok(
    text.includes("log('clean markers ok');\r\nWScript.Sleep(800);\r\nvar list = pids();"),
    "要看的是「确认干净之后、开始杀进程之前」那一次等待",
  );
  assert.ok(text.includes("20000"), "等进程退出的窗口丢了");
  assert.ok(text.includes("WScript.Sleep(45000)"), "面板无响应的时长就是这一句");
  assert.equal(text.includes("180000"), false, "180 秒是把面板挂死的旧值");
});

test("重启脚本换包失败也要把原版拉起来：用户看到的是应用消失，不是重启失败", () => {
  const text = officialRestartScript(EXE, ASAR, "");
  const failLine = text.split("\r\n").find((line) => line.includes("rename failed"));
  assert.ok(failLine, "找不到换名失败那一支");
  assert.ok(failLine.includes("relaunching original"), "这一支必须写日志");
  assert.ok(/sh\.Run\('"' \+ exe/.test(failLine) || failLine.includes("sh.Run"), "这一支必须把 exe 拉起来");
});

test("重启脚本起进程前清掉 ELECTRON_RUN_AS_NODE 与 DSH_BASE，并把 home 设回去", () => {
  const text = officialRestartScript(EXE, ASAR, "C:\\Users\\x\\.dsh");
  assert.ok(text.includes("Remove('ELECTRON_RUN_AS_NODE')"), "不清掉的话重起来是纯 Node，没有窗口");
  assert.ok(text.includes("Remove('DSH_BASE')"), "DSH_BASE 指向旧树会让新进程加载旧代码");
  assert.ok(text.includes("Item('DSH_HOME') = home"), "home 必须带过去，否则等于重置配置");
});

test("重启脚本里内嵌的 hostClean 与 lib/host-clean.js 共用同一份标记表", () => {
  const text = officialRestartScript(EXE, ASAR, "");
  assert.ok(text.includes(JSON.stringify(HOST_CLEAN_MARKERS.identity).slice(1, -1)), "identity 标记没同步");
  for (const marker of HOST_CLEAN_MARKERS.inject) {
    assert.ok(text.includes(JSON.stringify(marker).slice(1, -1)), `inject 标记没同步：${marker}`);
  }
  for (const marker of HOST_CLEAN_MARKERS.drops) {
    assert.ok(text.includes(JSON.stringify(marker).slice(1, -1)), `drops 标记没同步：${marker}`);
  }
  assert.ok(text.includes("'system-prompt/assemble'"), "旧拦截点没同步");
  assert.ok(text.includes("'You are an AI agent powered by DeepSeek Harness.'"), "旧身份行没同步");
});

test("重启脚本的 clean 判定容忍「判断不了」（null），只有明确 false 才拦住启动", () => {
  const text = officialRestartScript(EXE, ASAR, "");
  assert.ok(text.includes("if (!body) return null;"), "读不到文件必须回 null，不是 false");
  assert.ok(text.includes("clean = primary != false && alt != false;"), "首装时两侧都可能不存在，用 !== false 才是本意");
  assert.equal(/clean = primary === true/.test(text), false, "要求两侧都 true 会让首装永远起不来");
});

test("重启脚本的日志固定落在系统临时目录，不写进安装目录", () => {
  const text = officialRestartScript(EXE, ASAR, "");
  assert.ok(text.includes("dsh-purge-official-restart.log"), "日志名是重启判定的读数来源，不能改名");
  assert.ok(text.includes(JSON.stringify(os.tmpdir()).slice(1, -1)) || text.includes("dsh-purge-official-restart.log"));
  assert.equal(/var logPath = "C:\\\\Apps/.test(text), false, "日志不能落在安装目录里（会被下次升级打包）");
});

test("重启脚本把路径里的非 ASCII 写成 \\uXXXX 转义：WSH 无 BOM 时按 ANSI 读，裸中文会变乱码", () => {
  const text = officialRestartScript("C:\\程序\\深度求索.exe", "C:\\程序\\resources\\app.asar", "C:\\用户\\.dsh");
  const first = text.split("\r\n")[0];
  assert.equal(first, 'var exe = "C:\\\\\\u7a0b\\u5e8f\\\\\\u6df1\\u5ea6\\u6c42\\u7d22.exe";');
  assert.equal(text.split("\r\n")[1], 'var asar = "C:\\\\\\u7a0b\\u5e8f\\\\resources\\\\app.asar";');
});

test("现状锁定：脚本自带的中文注释让 isWshAscii 恒为 false，wscript 那条分支永远走不到", () => {
  // 这不是测试的期望值，是当下的实况：行内注释是中文，isWshAscii 逐字符查 >0x7f，
  // 所以 planOfficialRestart 永远拿到 scriptAscii=false → kind 恒为 powershell。
  // 后果：restartOfficialHarness 里 plan.writeInflight / spawn("wscript.exe") 那一段
  // （lib/desktop.js:1745-1775）在真机上不可达，重启实际总走 PowerShell 或 unpacked helper。
  const text = officialRestartScript(EXE, ASAR, "");
  const nonAscii = [...text].filter((ch) => ch.charCodeAt(0) > 0x7f).length;
  assert.ok(nonAscii > 0, "中文注释被删掉的话，这条现状锁定要跟着改");
  assert.equal(isWshAscii(text), false);
  assert.equal(planOfficialRestart({ wshJs: true, scriptAscii: isWshAscii(text), inflightAgeMs: -1 }).kind, "powershell");
  // 只有在纯 ASCII 脚本下 wscript 才会被选中 —— 这一支目前没有真实调用点。
  assert.equal(planOfficialRestart({ wshJs: true, scriptAscii: true, inflightAgeMs: -1 }).kind, "wscript");
});

test("重启脚本把单引号与反斜杠都转义掉，路径里有引号也不会提前结束字符串", () => {
  const line = officialRestartScript("C:\\a'b\\x.exe", "C:\\b\\app.asar", "").split("\r\n")[0];
  assert.equal(line, 'var exe = "C:\\\\a\'b\\\\x.exe";');
});

test("重启脚本是纯函数：同一组入参两次调用逐字节相同", () => {
  assert.equal(
    officialRestartScript(EXE, ASAR, "\\\\.\\dsh"),
    officialRestartScript(EXE, ASAR, "\\\\.\\dsh"),
  );
});

/* ------------------------------------------------------------- systemPromptFiles */

test("systemPromptFiles 在 exe 定位不到安装根时回空数组，不猜路径", () => {
  const root = box("spf-none");
  assert.deepEqual(systemPromptFiles(path.join(root, "nope", "DeepSeek Harness.exe")), []);
  assert.deepEqual(systemPromptFiles(""), []);
});

test("systemPromptFiles 只回真正存在的系统提示词文件", () => {
  const none = installTree("spf-empty");
  assert.deepEqual(systemPromptFiles(none.exe), []);

  const primary = installTree("spf-primary", { primary: "// assembled\n" });
  const one = systemPromptFiles(primary.exe);
  assert.equal(one.length, 1);
  assert.ok(one[0].endsWith(path.join("dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js")));

  const both = installTree("spf-both", { primary: "// a\n", alt: "// b\n" });
  const two = systemPromptFiles(both.exe);
  assert.equal(two.length, 2, "app/dsh 与 app 两处都要认（不同版本落在不同层级）");
  assert.notEqual(two[0], two[1]);
});

/* ----------------------------------------------------------- dshHomeForRelaunch */

test("dshHomeForRelaunch 在 DSH_HOME 没设或为空时回空串（restart 脚本据此不设 Item）", () => {
  assert.equal(withHome(undefined, () => dshHomeForRelaunch()), "");
  assert.equal(withHome("", () => dshHomeForRelaunch()), "");
  assert.equal(withHome("   ", () => dshHomeForRelaunch()), "   ", "只有空白也照原样带过去，不 trim");
});

test("dshHomeForRelaunch 去掉末尾的分隔符，正反斜杠都去", () => {
  assert.equal(withHome("C:\\a\\b\\", () => dshHomeForRelaunch()), "C:\\a\\b");
  assert.equal(withHome("C:/a/b///", () => dshHomeForRelaunch()), "C:/a/b");
});

test("dshHomeForRelaunch 认已经以 .dsh 结尾的路径（大小写不敏感），不再多套一层", () => {
  const root = box("home-dsdh");
  fs.mkdirSync(path.join(root, ".dsh", "profiles"), { recursive: true });
  assert.equal(withHome(path.join(root, ".dsh"), () => dshHomeForRelaunch()), path.join(root, ".dsh"));
  assert.equal(withHome(path.join(root, ".DSH"), () => dshHomeForRelaunch()), path.join(root, ".DSH"));

  // 关键形状：.dsh 里还嵌着一层 .dsh/profiles。少了「已以 .dsh 结尾就早返回」这道闸，
  // 这里会多钻一层，重起来之后读的是另一套配置 —— 看起来像被重置。
  const deep = box("home-deep");
  fs.mkdirSync(path.join(deep, ".dsh", ".dsh", "profiles"), { recursive: true });
  assert.equal(withHome(path.join(deep, ".dsh"), () => dshHomeForRelaunch()), path.join(deep, ".dsh"));
});

test("dshHomeForRelaunch 在下一层有 .dsh/profiles 时才钻进去，没有就留在原地", () => {
  const flat = box("home-flat");
  assert.equal(withHome(flat, () => dshHomeForRelaunch()), flat);

  const nested = box("home-nested");
  fs.mkdirSync(path.join(nested, ".dsh", "profiles"), { recursive: true });
  assert.equal(withHome(nested, () => dshHomeForRelaunch()), path.join(nested, ".dsh"));

  const half = box("home-half");
  fs.mkdirSync(path.join(half, ".dsh"), { recursive: true });
  assert.equal(withHome(half, () => dshHomeForRelaunch()), half, "只有 .dsh 没有 profiles 不算");
});

/* -------------------------------------------------------------------- helperEnv */

test("helperEnv 删掉 DSH_PERMISSION_MODE：helper 不能继承宿主的权限模式", () => {
  const saved = process.env.DSH_PERMISSION_MODE;
  process.env.DSH_PERMISSION_MODE = "ro";
  try {
    const env = helperEnv({ a: 1 }, "C:/node/node.exe");
    assert.equal("DSH_PERMISSION_MODE" in env, false);
    assert.equal("DSH_PERMISSION_MODE" in process.env, true, "不能顺手改掉调用方的 env");
  } finally {
    if (saved === undefined) delete process.env.DSH_PERMISSION_MODE;
    else process.env.DSH_PERMISSION_MODE = saved;
  }
});

test("helperEnv 的 ELECTRON_RUN_AS_NODE 取决于 runner：node 要删掉，Electron 本体要设成 1", () => {
  assert.equal(helperEnv({}, "C:/Program Files/nodejs/node.exe").ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(helperEnv({}, "/usr/local/bin/node").ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(helperEnv({}, "C:/Apps/DeepSeek Harness.exe").ELECTRON_RUN_AS_NODE, "1");
  assert.equal(helperEnv({}, "").ELECTRON_RUN_AS_NODE, "1");
  assert.equal(helperEnv({}, null).ELECTRON_RUN_AS_NODE, "1");
});

test("helperEnv 把 payload 序列化进 DSH_PURGE_RESTART，helper 靠它取回启动参数", () => {
  const payload = { kind: "desktop", execPath: "C:/a.exe", pid: 42, argv: [] };
  assert.equal(helperEnv(payload, "node").DSH_PURGE_RESTART, JSON.stringify(payload));
  assert.equal(helperEnv({}, "node").DSH_PURGE_RESTART, "{}");
});

test("helperEnv 返回的是一份新 env，不改 process.env 本身", () => {
  const before = Object.keys(process.env).length;
  const env = helperEnv({ x: 1 }, "node");
  env.DSH_PURGE_PROBE = "1";
  assert.equal("DSH_PURGE_PROBE" in process.env, false);
  assert.equal(Object.keys(process.env).length, before);
});

/* --------------------------------------------------------------- helperNodePath */

test("helperNodePath 在没有 Electron 时直接回 process.execPath（测试进程就是这种情况）", () => {
  if (process.versions.electron) return;
  assert.equal(helperNodePath(), process.execPath);
});

/* ---------------------------------------------------------------- officialExeFromProcess */

test("officialExeFromProcess 在普通 node 进程里回空串，不把 process.execPath 当桌面 exe", () => {
  const out = officialExeFromProcess();
  assert.equal(typeof out, "string");
  assert.equal(out, "", "node.exe 不是官方桌面端，认错了就会去重启一个不存在的应用");
});

/* ------------------------------------------------------------ officialRestartLogState */

test("officialRestartLogState 认三种状态：begin 之后没结束=运行中、started=完成、not starting=中止", () => {
  try {
    fs.writeFileSync(RESTART_LOG, "2026-01-01T00:00:00 begin\r\n", "utf8");
    assert.equal(officialRestartLogState(0), "running");

    fs.writeFileSync(RESTART_LOG, "begin\r\nstarted\r\n", "utf8");
    assert.equal(officialRestartLogState(0), "done");

    fs.writeFileSync(RESTART_LOG, "begin\r\nnot starting\r\n", "utf8");
    assert.equal(officialRestartLogState(0), "aborted");

    fs.writeFileSync(RESTART_LOG, "begin\r\nrename failed\r\n", "utf8");
    assert.equal(officialRestartLogState(0), "aborted");
  } finally {
    try { fs.rmSync(RESTART_LOG, { force: true }); } catch { /* ignore */ }
  }
});

test("officialRestartLogState 没有 begin 行就回 none：上一轮的 started 不能吃掉这次点击", () => {
  try {
    fs.writeFileSync(RESTART_LOG, "started\r\n", "utf8");
    assert.equal(officialRestartLogState(0), "none");

    fs.writeFileSync(RESTART_LOG, "", "utf8");
    assert.equal(officialRestartLogState(0), "none");
  } finally {
    try { fs.rmSync(RESTART_LOG, { force: true }); } catch { /* ignore */ }
  }
});

test("officialRestartLogState 以最后一条 begin 为界：多次重启只看向最后一次", () => {
  try {
    fs.writeFileSync(RESTART_LOG, "begin\r\nstarted\r\nbegin\r\n", "utf8");
    assert.equal(officialRestartLogState(0), "running", "最后一次 begin 之后没有 started");

    fs.writeFileSync(RESTART_LOG, "begin\r\nnot starting\r\nbegin\r\nstarted\r\n", "utf8");
    assert.equal(officialRestartLogState(0), "done", "前面那次的 aborted 不该粘到这次");
  } finally {
    try { fs.rmSync(RESTART_LOG, { force: true }); } catch { /* ignore */ }
  }
});

test("officialRestartLogState 的 mtime 早于开始时刻就回 none：陈旧日志不能把进程判成正在重启", () => {
  try {
    fs.writeFileSync(RESTART_LOG, "begin\r\n", "utf8");
    const st = fs.statSync(RESTART_LOG);
    assert.equal(officialRestartLogState(0), "running");
    assert.equal(officialRestartLogState(st.mtimeMs + 5000), "none");
    assert.equal(officialRestartLogState(st.mtimeMs - 5000), "running");
  } finally {
    try { fs.rmSync(RESTART_LOG, { force: true }); } catch { /* ignore */ }
  }
});

test("officialRestartLogState 在日志不存在时回 none，不抛", () => {
  try {
    fs.rmSync(RESTART_LOG, { force: true });
    assert.equal(officialRestartLogState(0), "none");
    assert.equal(officialRestartLogState(undefined), "none");
  } finally {
    try { fs.rmSync(RESTART_LOG, { force: true }); } catch { /* ignore */ }
  }
});

/* ------------------------------------------------------------- unpackedHostIsClean */

test("unpackedHostIsClean 找不到系统提示词文件时回 false（不能当成已清洗）", () => {
  const root = box("clean-none");
  assert.equal(unpackedHostIsClean(path.join(root, "nope", "DeepSeek Harness.exe")), false);
});

test("unpackedHostIsClean 认标记表：identity + 任一条 inject 同时出现才算干净", () => {
  const clean = `${HOST_CLEAN_MARKERS.identity}\n${HOST_CLEAN_MARKERS.inject[0]}\n`;
  assert.equal(unpackedHostIsClean(installTree("clean-marked", { primary: clean }).exe), true);
});

test("unpackedHostIsClean 没有标记但也没了那两处旧拦截，同样算干净", () => {
  const text = "export const name = 'system-prompt/assemble';\n// no identity line, no drops\n";
  assert.equal(unpackedHostIsClean(installTree("clean-natural", { primary: text }).exe), true);
});

test("unpackedHostIsClean 见到旧身份行或旧 drops 就回 false", () => {
  const identity = "const x = 1; // system-prompt/assemble\nconst y = 'You are an AI agent powered by DeepSeek Harness.';\n";
  assert.equal(unpackedHostIsClean(installTree("clean-identity", { primary: identity }).exe), false);

  const drops = `system-prompt/assemble\n${HOST_CLEAN_MARKERS.drops[0]}\n`;
  assert.equal(unpackedHostIsClean(installTree("clean-drops", { primary: drops }).exe), false);
});

test("unpackedHostIsClean 要求每一处系统提示词都干净，一处脏就整体 false", () => {
  const clean = `${HOST_CLEAN_MARKERS.identity}\n${HOST_CLEAN_MARKERS.inject[0]}\n`;
  const dirty = "system-prompt/assemble\n'You are an AI agent powered by DeepSeek Harness.'\n";
  assert.equal(unpackedHostIsClean(installTree("clean-mixed", { primary: clean, alt: dirty }).exe), false);
});

test("unpackedHostIsClean 读不到文件时回 false，不把异常抛给重启路径", () => {
  const tree = installTree("clean-eisdir", { primary: "x" });
  const fp = path.join(tree.appDir, "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js");
  fs.rmSync(fp, { force: true });
  fs.mkdirSync(fp, { recursive: true });
  assert.equal(unpackedHostIsClean(tree.exe), false);
});

/* --------------------------------------------------------------- probeWshJsEngine */

test("probeWshJsEngine 回布尔值，且不把探针脚本留在临时目录里", () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("dsh-purge-wsh-probe-"));
  const out = probeWshJsEngine();
  assert.equal(typeof out, "boolean");
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("dsh-purge-wsh-probe-"));
  assert.deepEqual(after, before, "探针用完即删");
  // 不钉 out 的具体值：这台机器上有没有 cscript.exe 与 process.platform 是两件事
  // （伪造 linux 的预加载跑在 Windows 上时，cscript 照样存在）。
});

/* ------------------------------------------------------ cleanupLegacyRestartScripts */

test("cleanupLegacyRestartScripts 只删 24 小时前的重启脚本/日志，新文件与别的文件一律不动", () => {
  const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  const names = {
    oldJs: `dsh-purge-official-restart-${process.pid}-a1b2.js`,
    oldLog: `dsh-purge-official-restart-${process.pid}-a1b2.log`,
    freshJs: `dsh-purge-official-restart-${process.pid}-c3d4.js`,
    other: `dsh-purge-unrelated-${process.pid}.txt`,
  };
  const files = Object.fromEntries(
    Object.entries(names).map(([key, name]) => [key, path.join(os.tmpdir(), name)]),
  );
  try {
    const midName = `dsh-purge-official-restart-${process.pid}-e5f6.js`;
    const mid = path.join(os.tmpdir(), midName);
    fs.writeFileSync(mid, "x", "utf8");
    files.mid = mid;
    for (const fp of Object.values(files)) fs.writeFileSync(fp, "x", "utf8");
    for (const key of ["oldJs", "oldLog"]) fs.utimesSync(files[key], old, old);
    const twoHours = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(files.mid, twoHours, twoHours);

    cleanupLegacyRestartScripts();

    assert.equal(fs.existsSync(files.oldJs), false, "超过 24h 的旧脚本要清掉");
    assert.equal(fs.existsSync(files.oldLog), false, "旧日志也要清掉");
    assert.equal(fs.existsSync(files.mid), true, "两小时前的那份还在有效期内，不能删（门槛是 24h 不是 1h）");
    assert.equal(fs.existsSync(files.freshJs), true, "新的不能删");
    assert.equal(fs.existsSync(files.other), true, "名字不匹配的一律不碰");
  } finally {
    for (const fp of Object.values(files)) {
      try { fs.rmSync(fp, { force: true }); } catch { /* ignore */ }
    }
  }
});
