// lib/host-clean-floor.js：重启前那道地板的三个函数。
//
// 为什么这三个值得单独钉：它们只在「用户点重启 / 后台自愈要重启」那一刻跑，
// 坏了全是静默失败 —— 清洗没写完却照常重启（宿主半打状态）、app.asar 还在就重启
// （补丁在 resources/app，重启完等于没打）、自定义安装目录没记下来（下次定位不到 exe）。
//
// 判定全部由注入的 deps 驱动，模块本身不做文件 IO（只有 findDshHome/atomicWriteSync
// 这类由调用方传进来的工具函数会碰盘），所以整批用例纯内存跑完。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as floor from "../lib/host-clean-floor.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CORE_SRC = fs.readFileSync(path.join(ROOT, "lib", "core.js"), "utf8");
const FLOOR_SRC = fs.readFileSync(path.join(ROOT, "lib", "host-clean-floor.js"), "utf8");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-floor-"));
const IS_WINDOWS = process.platform === "win32";

test.after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const AI = "C:/host/@deepseek-ai";

function asPlatform(value, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", desc);
  }
}

// deps 工厂：所有判定点都能从外部拨，调用顺序记在 calls 里。
function deps(over = {}) {
  const calls = [];
  const state = {
    home: path.join(SANDBOX, "home"),
    // status 可以是对象也可以是函数（函数用来表达「打完补丁之后状态变了」）。
    status: {},
    bases: [AI],
    written: true,
    markers: true,
    flash: { ok: true },
    report: { failed: [] },
    located: null,
    handoff: null,
    asarIsFile: true,
    desktopExe: true,
    official: false,
    fileExists: false,
    fileText: "",
  };
  const d = {
    calls,
    state,
    applyRuntimeEnv: () => calls.push(["applyRuntimeEnv"]),
    findAiBase: () => {
      calls.push(["findAiBase"]);
      return AI;
    },
    missingAiBaseMessage: () => "no ai base",
    patchStatus: async (base) => {
      calls.push(["patchStatus", base]);
      return typeof state.status === "function" ? state.status(base) : state.status[base] || {};
    },
    enumeratePatchAiBases: () => {
      calls.push(["enumeratePatchAiBases"]);
      return state.bases.slice();
    },
    allPatchHostsWritten: (hosts) => {
      calls.push(["allPatchHostsWritten", Array.isArray(hosts) ? hosts.map((h) => h.aiBase) : hosts]);
      return state.written;
    },
    hostCleanMarkersPresent: (base) => {
      calls.push(["hostCleanMarkersPresent", base]);
      return state.markers;
    },
    silenceCmdFlash: (base) => {
      calls.push(["silenceCmdFlash", base]);
      return state.flash;
    },
    applyPatchesAllHosts: async (patches, opts) => {
      calls.push(["applyPatchesAllHosts", patches, opts]);
      if (typeof state.onApply === "function") state.onApply();
      // 真实实现每台宿主都带 report/summary/hostWritten/flash（lib/core.js:2035-2041），
      // flash 是「这台机器上弹窗都堵住了吗」的读数，少了它 needsApply 之后的复检永远判不过。
      const hosts = state.appliedHosts
        ? state.appliedHosts.map((aiBase) => ({ aiBase, hostWritten: state.markers, flash: state.flash }))
        : state.bases.map((aiBase) => ({ aiBase, hostWritten: state.markers, flash: state.flash }));
      return { report: state.report, hosts };
    },
    patchAllShims: async () => {
      calls.push(["patchAllShims"]);
    },
    summarizeApplyReport: (report) => {
      calls.push(["summarizeApplyReport", report]);
      return { failed: report.failed || [] };
    },
    resolveOfficialAiBase: async (base) => {
      calls.push(["resolveOfficialAiBase", base]);
      // 工厂在创建时就把 deps 解构走了，所以「换个实现」必须走 state，不能直接改 d.xxx。
      if (typeof state.resolve === "function") return state.resolve(base);
      return state.located || { aiBase: base };
    },
    sealedAsarHandoff: (input) => {
      calls.push(["sealedAsarHandoff", input]);
      return state.handoff;
    },
    asarArchiveIsFile: (p) => {
      calls.push(["asarArchiveIsFile", p]);
      return state.asarIsFile;
    },
    atomicWriteSync: (fp, text, enc) => calls.push(["atomicWriteSync", fp, text, enc]),
    findDshHome: () => state.home,
    ALL_PATCHES: ["patch-a"],
    desktop: {
      isDesktopExecutable: (exe) => {
        calls.push(["isDesktopExecutable", exe]);
        return state.desktopExe;
      },
      isOfficialHarnessExecutable: (exe) => {
        calls.push(["isOfficialHarnessExecutable", exe]);
        return state.official;
      },
      restartOfficialHarness: (arg) => {
        calls.push(["restartOfficialHarness", arg]);
        return { restarted: true };
      },
      scheduleAsarSwapRestart: (arg) => calls.push(["scheduleAsarSwapRestart", arg]),
    },
    hostFs: {
      existsSync: (fp) => {
        calls.push(["existsSync", fp]);
        return state.fileExists;
      },
      readFileSync: (fp) => {
        calls.push(["readFileSync", fp]);
        return state.fileText;
      },
    },
  };
  Object.assign(d, over);
  d.calls = calls;
  d.state = state;
  d.api = floor.createHostCleanFloor(d);
  return d;
}

const only = (d, name) => d.calls.filter((c) => c[0] === name);

test("工厂只交出三个函数，模块只导出工厂", () => {
  assert.deepEqual(Object.keys(floor), ["createHostCleanFloor"]);
  const api = floor.createHostCleanFloor({});
  assert.deepEqual(Object.keys(api), [
    "ensureHostClean",
    "restartSealedDesktopIfNeeded",
    "rememberDesktopInstallForHandoff",
  ]);
  for (const name of Object.keys(api)) assert.equal(typeof api[name], "function");
});

test("ensureHostClean：一切就绪时打补丁、补 shim，回 ok 并把宿主列表摊平", async () => {
  const d = deps();
  // 一开始有 pending，打完就干净了 —— 这是「自愈」那条主线。
  d.state.status = (base) => (only(d, "applyPatchesAllHosts").length ? {} : { 7: "pending" });
  const r = await d.api.ensureHostClean();
  assert.equal(r.ok, true);
  assert.equal(r.aiBase, AI);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.hosts, [AI]);
  // 补丁选项逐字钉：client bundle 必须一起打，且是 apply 语境。
  assert.deepEqual(only(d, "applyPatchesAllHosts")[0][2], { preserveClientBundles: false, forApply: true });
  assert.deepEqual(only(d, "applyPatchesAllHosts")[0][1], ["patch-a"]);
  assert.equal(only(d, "patchAllShims").length, 1);
  assert.equal(only(d, "summarizeApplyReport").length, 1);
  // 顺序：先配环境，再找 aiBase，再决定要不要打。
  assert.deepEqual(
    d.calls.map((c) => c[0]).slice(0, 3),
    ["applyRuntimeEnv", "findAiBase", "resolveOfficialAiBase"],
  );
});

test("ensureHostClean：本来就干净时一次补丁都不打", async () => {
  const d = deps();
  const r = await d.api.ensureHostClean();
  assert.equal(r.ok, true);
  assert.equal(only(d, "applyPatchesAllHosts").length, 0);
  assert.equal(only(d, "patchAllShims").length, 0);
  assert.equal(only(d, "summarizeApplyReport").length, 0);
  // 但「有没有写进全部宿主」这一问仍然要问。
  assert.ok(only(d, "allPatchHostsWritten").length >= 1);
});

test("ensureHostClean：flash 不 ok 也算没写完，照样要打补丁", async () => {
  const d = deps();
  d.state.flash = { ok: false };
  d.state.status = (base) => (only(d, "applyPatchesAllHosts").length ? {} : {});
  d.state.onApply = () => {
    d.state.flash = { ok: true };
  };
  const r = await d.api.ensureHostClean();
  assert.equal(only(d, "applyPatchesAllHosts").length, 1, "flash 不 ok 时也要重打");
  assert.equal(r.ok, true);
});

test("ensureHostClean：解析宿主目录抛错时原样把原因交出去，不往下走", async () => {
  const d = deps();
  d.state.resolve = () => {
    throw new Error("asar 读不了");
  };
  const r = await d.api.ensureHostClean();
  assert.deepEqual(r, { ok: false, error: "asar 读不了", aiBase: null });
  assert.equal(only(d, "enumeratePatchAiBases").length, 0);
  assert.equal(only(d, "applyPatchesAllHosts").length, 0);
});

test("ensureHostClean：抛出来的不是 Error（没有 message）也要给出可读字符串", async () => {
  const d = deps();
  d.state.resolve = () => {
    throw "plain string";
  };
  const r = await d.api.ensureHostClean();
  assert.deepEqual(r, { ok: false, error: "plain string", aiBase: null });
});

test("ensureHostClean：找不到宿主目录时用统一的缺目录文案，且不枚举宿主", async () => {
  const d = deps();
  d.state.resolve = () => ({ aiBase: null });
  const r = await d.api.ensureHostClean();
  assert.deepEqual(r, { ok: false, error: "no ai base", aiBase: null });
  assert.equal(only(d, "enumeratePatchAiBases").length, 0);
});

test("ensureHostClean：打完还有 pending 就拦住重启，并报出条数与清单", async () => {
  const d = deps();
  d.state.status = () => ({ 3: "pending", 5: "pending" });
  const r = await d.api.ensureHostClean();
  assert.equal(r.ok, false);
  assert.equal(r.error, "清洗没有完成，已取消重启");
  assert.deepEqual(r.pending.sort(), ["3", "5"]);
  assert.equal(r.failed, 0);
  assert.equal(r.aiBase, AI);
  assert.deepEqual(r.hosts, [AI]);
});

test("ensureHostClean：打完仍有失败项就拦住重启，failed 是条数不是布尔", async () => {
  const d = deps();
  d.state.status = (base) => (only(d, "applyPatchesAllHosts").length ? {} : { 2: "pending" });
  d.state.report = { failed: [{ id: 2 }, { id: 9 }] };
  const r = await d.api.ensureHostClean();
  assert.equal(r.ok, false);
  assert.equal(r.error, "清洗没有完成，已取消重启");
  assert.equal(r.failed, 2);
});

test("ensureHostClean：打完 flash 又变回不 ok 也拦住重启", async () => {
  const d = deps();
  d.state.status = (base) => (only(d, "applyPatchesAllHosts").length ? {} : { 1: "pending" });
  d.state.flash = { ok: false };
  d.state.onApply = () => {
    d.state.flash = { ok: false };
  };
  const r = await d.api.ensureHostClean();
  assert.equal(r.ok, false);
  assert.equal(r.error, "清洗没有完成，已取消重启");
});

test("ensureHostClean：没有任何 pending/失败，但标记没写进全部宿主 —— 另一句文案", async () => {
  const d = deps();
  d.state.written = false;
  const r = await d.api.ensureHostClean();
  assert.equal(r.ok, false);
  assert.equal(r.error, "清洗没有写进全部宿主，已取消重启");
  assert.deepEqual(r.hosts, [AI]);
  assert.equal(r.pending, undefined, "这条出口不带 pending 字段");
  assert.equal(r.failed, undefined);
  // 标记没写进宿主本身就是「要重打」的信号，不是只用来在末尾拦一句。
  assert.equal(only(d, "applyPatchesAllHosts").length, 1);
});

test("ensureHostClean：已经打完（settled/native）的宿主不算 pending，不该白白重打一遍", async () => {
  const d = deps();
  // 只有非 pending 状态时 needsApply 必须为假 —— 否则每次启动都全量重写一遍宿主。
  // 注意 status 的对象形态是按 aiBase 索引的，要表达「这台宿主上的补丁状态」得用函数形态。
  d.state.status = () => ({ 1: "settled", 2: "native", 3: "na" });
  const r = await d.api.ensureHostClean();
  assert.equal(r.ok, true);
  assert.equal(only(d, "applyPatchesAllHosts").length, 0);
  assert.equal(only(d, "patchAllShims").length, 0);
});

test("ensureHostClean：当前宿主不在枚举结果里时排到最前面一起处理", async () => {
  const d = deps();
  d.state.bases = ["C:/other/@deepseek-ai", "D:/third/@deepseek-ai"];
  d.state.status = (base) => (only(d, "applyPatchesAllHosts").length ? {} : { 4: "pending" });
  const r = await d.api.ensureHostClean();
  assert.equal(r.ok, true);
  const probed = only(d, "patchStatus").map((c) => c[1]);
  assert.equal(probed[0], AI, "当前宿主必须第一个被查");
  // 打完补丁之后宿主清单来自 applyPatchesAllHosts —— 它自己又会枚举一遍，
  // 所以「本会话的宿主」若不在枚举结果里，最终清单里不会有它（真实现也是如此：
  // lib/core.js:2022 的 for 走的是 enumeratePatchAiBases()，不吃外面补的那一份）。
  assert.deepEqual(r.hosts, ["C:/other/@deepseek-ai", "D:/third/@deepseek-ai"]);
  assert.equal(only(d, "allPatchHostsWritten").at(-1)[1].length, 2, "最后那次复检用打完之后的清单");
});

test("ensureHostClean：同一棵宿主只差大小写时不会重复加一遍", async () => {
  const d = deps();
  d.state.bases = ["C:/HOST/@DeepSeek-AI"];
  const r = await d.api.ensureHostClean();
  assert.deepEqual(r.hosts, ["C:/HOST/@DeepSeek-AI"], "不该变成两个");
  assert.equal(only(d, "patchStatus").length, 1);
});

test("ensureHostClean：同一棵宿主只差斜杠方向时不会重复加一遍", () => {
  // 去重那句是 path.normalize(b).toLowerCase() === path.normalize(aiBase).toLowerCase()，
  // 而 path.normalize 只在 Windows 上把 \ 折成 / —— POSIX 上两者是不同字符串，
  // 这条判据本就只在 Windows 成立，所以只能在真 Windows 上验。
  if (!IS_WINDOWS) return;
  return asPlatform("win32", async () => {
    const d = deps();
    d.state.bases = ["c:\\host\\@deepseek-ai"];
    const r = await d.api.ensureHostClean();
    assert.deepEqual(r.hosts, ["c:\\host\\@deepseek-ai"], "不该变成两个");
    assert.equal(only(d, "patchStatus").length, 1);
  });
});

test("ensureHostClean：applyPatchesAllHosts 没回宿主列表时沿用枚举出来的那批", async () => {
  const d = deps();
  d.state.status = (base) => (only(d, "applyPatchesAllHosts").length ? {} : { 1: "pending" });
  d.state.appliedHosts = [];
  const r = await d.api.ensureHostClean();
  assert.equal(r.ok, true);
  assert.deepEqual(r.hosts, [AI]);
});

test("restartSealedDesktopIfNeeded：没有 handoff / 缺 exe / 缺 asar 一律不动手", () => {
  for (const handoff of [null, undefined, {}, { exe: "C:/app/x.exe" }, { asar: "C:/app/resources/app.asar" }]) {
    const d = deps();
    d.state.handoff = handoff;
    const r = d.api.restartSealedDesktopIfNeeded({});
    assert.deepEqual(r, { needed: false, renamed: true });
    assert.equal(only(d, "isDesktopExecutable").length, 0, "不应顺手去记安装目录");
    assert.equal(only(d, "restartOfficialHarness").length, 0);
    assert.equal(only(d, "scheduleAsarSwapRestart").length, 0);
  }
});

test("restartSealedDesktopIfNeeded：asar 已经不在了就当无需处理，不记目录不重启", () => {
  const d = deps();
  d.state.handoff = { exe: "C:/app/DeepSeek Harness.exe", asar: "C:/app/resources/app.asar" };
  d.state.asarIsFile = false;
  const r = d.api.restartSealedDesktopIfNeeded({});
  assert.deepEqual(r, { needed: false, renamed: true });
  assert.equal(only(d, "asarArchiveIsFile").length, 1);
  assert.equal(only(d, "isDesktopExecutable").length, 0);
});

test("restartSealedDesktopIfNeeded：官方桌面在 win32 上先记目录，再交给官方重启器（ctx 必须透传）", () => {
  const d = deps();
  const ctx = { id: "route-1" };
  d.state.handoff = { exe: "C:/app/DeepSeek Harness.exe", asar: "C:/app/resources/app.asar" };
  d.state.official = true;
  const r = asPlatform("win32", () => d.api.restartSealedDesktopIfNeeded({ ctx }));
  assert.equal(r.needed, true);
  assert.equal(r.renamed, false);
  assert.equal(r.asarSwap, true);
  assert.equal(r.restarted, true, "官方重启器的返回值要摊进来");
  assert.deepEqual(only(d, "restartOfficialHarness")[0][1], {
    exe: "C:/app/DeepSeek Harness.exe",
    asar: "C:/app/resources/app.asar",
    ctx,
  });
  assert.equal(only(d, "scheduleAsarSwapRestart").length, 0);
  // 「先记目录」是可观察的：这条路必须在重启之前把安装目录落盘一次
  // （少了它，用户下次换安装目录就再也定位不到 exe）。
  assert.equal(only(d, "atomicWriteSync").length, 1, "重启前必须记一次安装目录");
  // 记目录发生在重启之前。
  const order = d.calls.map((c) => c[0]);
  assert.ok(order.indexOf("atomicWriteSync") < order.indexOf("restartOfficialHarness"));
});

test("restartSealedDesktopIfNeeded：走 asar 换名脚本那条路也要先记安装目录", () => {
  const d = deps();
  d.state.handoff = { exe: "C:/app/Other.exe", asar: "C:/app/resources/app.asar" };
  d.state.official = false;
  asPlatform("linux", () => d.api.restartSealedDesktopIfNeeded({}));
  assert.equal(only(d, "atomicWriteSync").length, 1);
  const order = d.calls.map((c) => c[0]);
  assert.ok(order.indexOf("atomicWriteSync") < order.indexOf("scheduleAsarSwapRestart"));
});

test("restartSealedDesktopIfNeeded：不是官方桌面（或不在 win32）就走 asar 换名脚本，waitPid 是自己的 pid", () => {
  for (const platform of ["win32", "linux"]) {
    const d = deps();
    const ctx = { id: "route-2" };
    d.state.handoff = { exe: "C:/app/Other.exe", asar: "C:/app/resources/app.asar" };
    d.state.official = false;
    const r = asPlatform(platform, () => d.api.restartSealedDesktopIfNeeded({ ctx }));
    assert.deepEqual(r, { needed: true, renamed: false, asarSwap: true });
    assert.equal(only(d, "restartOfficialHarness").length, 0);
    assert.deepEqual(only(d, "scheduleAsarSwapRestart")[0][1], {
      exe: "C:/app/Other.exe",
      asar: "C:/app/resources/app.asar",
      waitPid: process.pid,
      exit: true,
      ctx,
    });
  }
});

test("restartSealedDesktopIfNeeded：win32 上是官方 exe 但平台不是 win32 时也不许走官方重启器", () => {
  const d = deps();
  d.state.handoff = { exe: "C:/app/DeepSeek Harness.exe", asar: "C:/app/resources/app.asar" };
  d.state.official = true;
  const r = asPlatform("linux", () => d.api.restartSealedDesktopIfNeeded({}));
  assert.deepEqual(r, { needed: true, renamed: false, asarSwap: true });
  assert.equal(only(d, "restartOfficialHarness").length, 0);
  assert.equal(only(d, "scheduleAsarSwapRestart").length, 1);
});

test("rememberDesktopInstallForHandoff：缺 exe / 不是桌面壳可执行文件时一个字都不写", () => {
  for (const [handoff, desktopExe] of [
    [null, true],
    [{}, true],
    [{ exe: "C:/app/Other.exe" }, false],
  ]) {
    const d = deps();
    d.state.desktopExe = desktopExe;
    d.api.rememberDesktopInstallForHandoff(handoff);
    assert.equal(only(d, "atomicWriteSync").length, 0);
    assert.equal(only(d, "existsSync").length, 0, "连盘都不该碰");
  }
});

test("rememberDesktopInstallForHandoff：把安装目录写进 DSH_HOME，末尾留一个换行", () => {
  const d = deps();
  d.state.fileExists = false;
  // 路径一律用正斜杠：这个文件在 Windows 与 ubuntu-latest 上都要跑，
  // 而 path.dirname 在 Linux 上不把反斜杠当分隔符（会得到 "."），
  // 反斜杠归一那一格另有 Windows 专属用例。
  d.api.rememberDesktopInstallForHandoff({ exe: "C:/Program Files/Harness/app/DeepSeek Harness.exe" });
  const write = only(d, "atomicWriteSync")[0];
  assert.equal(write[1], path.join(d.state.home, "dsh-purge", "desktop-install.txt"));
  assert.equal(write[2], "C:/Program Files/Harness/app\n");
  assert.equal(write[3], "utf8");
});

test("rememberDesktopInstallForHandoff：Windows 盘符路径里的反斜杠要归一成正斜杠", () => {
  if (!IS_WINDOWS) return; // path.dirname 在 POSIX 上不认反斜杠，这条只能在 Windows 上验
  const d = deps();
  d.state.fileExists = false;
  d.api.rememberDesktopInstallForHandoff({ exe: "C:\\Program Files\\Harness\\app\\DeepSeek Harness.exe" });
  assert.equal(only(d, "atomicWriteSync")[0][2], "C:/Program Files/Harness/app\n");
});

test("rememberDesktopInstallForHandoff：内容没变（大小写不同也算没变）就不重写", () => {
  const d = deps();
  d.state.fileExists = true;
  d.state.fileText = "c:/program files/harness/app\n";
  d.api.rememberDesktopInstallForHandoff({ exe: "C:/Program Files/Harness/app/DeepSeek Harness.exe" });
  assert.equal(only(d, "atomicWriteSync").length, 0);
});

test("rememberDesktopInstallForHandoff：只在本机没设 DSH_DESKTOP_INSTALL 时才补环境变量", () => {
  const saved = process.env.DSH_DESKTOP_INSTALL;
  // 写进环境变量的是 path.dirname(path.normalize(exe)) 的原样结果 ——
  // 它在 Windows 上仍是反斜杠（只有落盘那一份归一再写），所以断言要按本机算。
  const exe = "C:/Apps/H/DeepSeek Harness.exe";
  const expected = path.dirname(path.normalize(exe));
  try {
    delete process.env.DSH_DESKTOP_INSTALL;
    const d1 = deps();
    d1.api.rememberDesktopInstallForHandoff({ exe });
    assert.equal(process.env.DSH_DESKTOP_INSTALL, expected);

    process.env.DSH_DESKTOP_INSTALL = "already-set";
    const d2 = deps();
    d2.api.rememberDesktopInstallForHandoff({ exe });
    assert.equal(process.env.DSH_DESKTOP_INSTALL, "already-set", "已经设过就不许覆盖");
  } finally {
    if (saved === undefined) delete process.env.DSH_DESKTOP_INSTALL;
    else process.env.DSH_DESKTOP_INSTALL = saved;
  }
});

test("rememberDesktopInstallForHandoff：写盘抛错也不能冒出来（这条是「非致命」的承诺）", () => {
  const d = deps();
  d.atomicWriteSync = () => {
    throw new Error("EPERM");
  };
  assert.doesNotThrow(() => d.api.rememberDesktopInstallForHandoff({ exe: "C:/Apps/H/DeepSeek Harness.exe" }));
});

test("rememberDesktopInstallForHandoff：读旧值抛错也照样吞掉，不阻断重启流程", () => {
  const d = deps();
  d.hostFs = {
    existsSync: () => true,
    readFileSync: () => {
      throw new Error("EACCES");
    },
  };
  assert.doesNotThrow(() => d.api.rememberDesktopInstallForHandoff({ exe: "C:/Apps/H/DeepSeek Harness.exe" }));
});

test("源码形状：三个函数体只在 lib/host-clean-floor.js 里，core.js 只留薄包装", () => {
  // core.js 不许再出现这些函数体特征。
  assert.equal(CORE_SRC.includes("清洗没有完成，已取消重启"), false, "函数体已经搬走");
  assert.equal(CORE_SRC.includes("cleanup 没有写完"), false);
  for (const call of [
    "hostCleanFloor.ensureHostClean()",
    "hostCleanFloor.restartSealedDesktopIfNeeded(input)",
    "hostCleanFloor.rememberDesktopInstallForHandoff(handoff)",
  ]) {
    assert.ok(CORE_SRC.includes(call), "缺少包装调用：" + call);
  }
  assert.ok(CORE_SRC.includes('import { createHostCleanFloor } from "./host-clean-floor.js";'));
  assert.ok(CORE_SRC.includes("const hostCleanFloor = createHostCleanFloor({"));
  // 装配里少一个 dep 就会在运行期变成 undefined，症状是「重启前什么都没检查就重启了」。
  for (const dep of [
    "applyRuntimeEnv",
    "findAiBase",
    "missingAiBaseMessage",
    "patchStatus",
    "enumeratePatchAiBases",
    "allPatchHostsWritten",
    "hostCleanMarkersPresent",
    "silenceCmdFlash",
    "applyPatchesAllHosts",
    "patchAllShims",
    "summarizeApplyReport",
    "resolveOfficialAiBase",
    "sealedAsarHandoff",
    "asarArchiveIsFile",
    "atomicWriteSync",
    "findDshHome",
    "ALL_PATCHES",
    "desktop",
    "hostFs",
  ]) {
    const wiring = CORE_SRC.slice(CORE_SRC.indexOf("const hostCleanFloor = createHostCleanFloor({"));
    const block = wiring.slice(0, wiring.indexOf("});"));
    assert.ok(block.includes(dep), "装配块缺 dep：" + dep);
  }
  // 工厂体里不许再出现 export（只能是工厂自身）。
  const inner = FLOOR_SRC.slice(FLOOR_SRC.indexOf("export function createHostCleanFloor"));
  assert.equal(/^\s+export /m.test(inner), false, "工厂体里不能有 export");
  assert.ok(FLOOR_SRC.includes("清洗没有完成，已取消重启"));
  assert.ok(FLOOR_SRC.includes("清洗没有写进全部宿主，已取消重启"));
});

test("源码形状：门板函数仍然是 async/同步，调用方 await 的写法才不会变", () => {
  assert.equal(/export async function ensureHostClean\(\)/.test(CORE_SRC), true);
  assert.equal(/export function restartSealedDesktopIfNeeded\(input = \{\}\)/.test(CORE_SRC), true);
  assert.equal(/export function rememberDesktopInstallForHandoff\(handoff\)/.test(CORE_SRC), true);
  assert.equal(/async function ensureHostClean\(\)/.test(FLOOR_SRC), true);
  assert.equal(/function restartSealedDesktopIfNeeded\(input = \{\}\)/.test(FLOOR_SRC), true);
});
