// lib/hide-console.js 的回归测试。
//
// 这个模块在 Windows 非 Electron 宿主里干两件事：
//   1. 把 builtin 的 child_process 六个入口包一层，给每个子进程加 windowsHide ——
//      否则每次 spawn 都弹一个黑窗；
//   2. 往宿主 lib/bin.js 顶部注入一行 import，落一个 sidecar，让 CLI 自己启动的子进程也不弹窗。
//
// 坏法都是安静的：
//   - 包装漏掉某个入口（比如 execFileSync）→ 只有走那条路的地方弹窗，日志里什么都没有；
//   - forceHideOptions 把调用方显式写的 windowsHide:false 也覆盖成 true → 某些需要窗口的
//     工具起不来；
//   - writeHostFileAtomic 不保留原 mode → POSIX 下 bin.js 丢了 +x，`bin/dsh` 软链执行不了，
//     宿主直接起不来（#213）；
//   - 注入时不认源码树 → 往 tsdown 的构建产物里写 sidecar，缺 bak 时无法自愈（#41）。

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

// installHideConsole() 在模块顶层就被调用，所以要在 import 之前留一份原始引用。
const cp = process.getBuiltinModule("child_process");
const ORIG = {
  spawn: cp.spawn,
  spawnSync: cp.spawnSync,
  exec: cp.exec,
  execSync: cp.execSync,
  execFile: cp.execFile,
  execFileSync: cp.execFileSync,
  fork: cp.fork,
};

const mod = await import("../lib/hide-console.js");
const {
  isElectronHost,
  hideConsoleDecision,
  installChildProcessImportHook,
  installHideConsole,
  hideConsoleEntrySource,
  writeHostFileAtomic,
  looksLikeSourceCliRoot,
  resolveDshBinRoot,
  installHideConsoleIntoBin,
  revertHideConsoleFromBin,
  forceHideOptions,
  wrapSpawn,
  wrapExecLike,
  wrapExecFile,
  wrapFork,
} = mod;

const MARK = "__dshPurgeHideConsole";
const IMPORT_MARK = "dsh-purge-hide-console";
const SHOULD_PATCH = process.platform === "win32" && !process.versions.electron;

// ---------------------------------------------------------------- 假 fs

const norm = (p) => String(p).split("\\").join("/");

/**
 * 造一个只认内存里那些文件的 fs。所有写类调用都记账，
 * 这样「chmod 传了什么 mode」「rename 从哪到哪」都能断言 ——
 * 比看真实磁盘的 mode 更精确（Windows 上 chmod 只有只读位，0o755 落不住）。
 */
function fakeFs(files = {}, options = {}) {
  const calls = { write: [], chmod: [], rename: [], unlink: [], stat: [], read: [] };
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const enoent = () => Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  const fs = {
    existsSync(p) {
      if (options.existsThrows) throw new Error("exists boom");
      return map.has(norm(p));
    },
    readFileSync(p) {
      calls.read.push(norm(p));
      if (options.readThrows) throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
      if (!map.has(norm(p))) throw enoent();
      return map.get(norm(p));
    },
    writeFileSync(p, text) {
      calls.write.push({ p: norm(p), text });
      if (options.writeThrows) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      map.set(norm(p), text);
    },
    statSync(p) {
      calls.stat.push(norm(p));
      if (options.noStat) throw new Error("not supported");
      if (!map.has(norm(p))) throw enoent();
      return { mode: options.mode === undefined ? 0o644 : options.mode };
    },
    chmodSync(p, m) {
      calls.chmod.push({ p: norm(p), mode: m });
      if (options.chmodThrows) throw new Error("chmod not supported");
    },
    renameSync(a, b) {
      calls.rename.push({ a: norm(a), b: norm(b) });
      if (options.renameThrows) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      const v = map.get(norm(a));
      map.delete(norm(a));
      map.set(norm(b), v);
    },
    unlinkSync(p) {
      calls.unlink.push(norm(p));
      map.delete(norm(p));
    },
  };
  return { fs, calls, map };
}

// ---------------------------------------------------------------- 决策

test("isElectronHost 只看 process.versions.electron", () => {
  assert.equal(isElectronHost({ electron: "44.7.0" }), true);
  assert.equal(isElectronHost({ node: "24.22.1" }), false);
  assert.equal(isElectronHost(undefined), false);
  assert.equal(isElectronHost(null), false);
});

test("hideConsoleDecision 三分支：非 win32 / Electron / 其余都包 builtin", () => {
  assert.equal(hideConsoleDecision("darwin", {}), "not_win32");
  assert.equal(hideConsoleDecision("linux", { node: "24" }), "not_win32");
  assert.equal(hideConsoleDecision("win32", { electron: "44" }), "electron_host");
  assert.equal(hideConsoleDecision("win32", { node: "24.22.1" }), "wrap_builtin");
});

test("installChildProcessImportHook 恒跳过（#46：不再注册 resolve 钩子）", () => {
  assert.deepEqual(installChildProcessImportHook(), { ok: true, skipped: "no_builtin_short_circuit" });
});

test("installHideConsole：本机形态下真的包了 builtin 六个入口，并打上不可枚举的标记", () => {
  if (!SHOULD_PATCH) {
    assert.deepEqual(installHideConsole(), { ok: true, skipped: hideConsoleDecision() });
    return;
  }
  assert.equal(cp[MARK], true);
  const desc = Object.getOwnPropertyDescriptor(cp, MARK);
  assert.equal(desc.enumerable, false, "标记不能出现在 for...in / Object.keys 里");
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
    assert.notEqual(cp[name], ORIG[name], `${name} 必须被包一层`);
  }
  if (typeof ORIG.fork === "function") assert.notEqual(cp.fork, ORIG.fork, "fork 也必须被包");
});

test("installHideConsole 幂等：第二次直接 already，不重复包", () => {
  if (!SHOULD_PATCH) return;
  const before = cp.spawn;
  const r = installHideConsole();
  assert.equal(r.already, true);
  assert.equal(cp.spawn, before, "重复安装不能套娃包装");
});

test("包装之后真跑子进程仍然正常（execFileSync / spawnSync 都能出结果）", () => {
  const out = cp.execFileSync(process.execPath, ["-e", "process.stdout.write('ok')"], { encoding: "utf8" });
  assert.equal(out, "ok");
  const r = cp.spawnSync(process.execPath, ["-e", "process.stdout.write('ok2')"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(String(r.stdout), "ok2");
});

// ---------------------------------------------------------------- 模块内的 wrapper
//
// 这五个函数是 installHideConsole() 包进 builtin 的那一层。它们被 export 出来是为了可测：
// builtin 上的 MARK 是不可删的（defineProperty 没给 configurable），测试进程里没法「重装」，
// 而装好之后再调 installHideConsole() 只会返回 already，外部看不到 wrapper 收到的 options。
// 导出它们不改任何行为，只是让这一层能被逐条钉住 —— 漏掉一个入口或落错参数位置，
// 表现是「某个工具的子进程弹黑窗」，日志里什么都没有。

test("forceHideOptions：null/undefined 补对象，非对象透传，已 true 的原对象不复制", () => {
  assert.deepEqual(forceHideOptions(undefined), { windowsHide: true });
  assert.deepEqual(forceHideOptions(null), { windowsHide: true });
  assert.equal(forceHideOptions("weird"), "weird", "非对象必须原样透传（调用方可能是别的重载）");
  const mine = { windowsHide: true, cwd: "/x" };
  assert.equal(forceHideOptions(mine), mine, "已经写了 true 就不该再复制一份");
  assert.deepEqual(forceHideOptions({ cwd: "/x" }), { cwd: "/x", windowsHide: true });
});

test("wrapSpawn / wrapFork：args 就是 options 的重载、args 省略、第三参三种形态", () => {
  const calls = [];
  const orig = (...args) => { calls.push(args); return "r"; };
  const spawn = wrapSpawn(orig);
  spawn("a.exe", { cwd: "/m" });
  spawn("a.exe");
  spawn("a.exe", ["x"], { cwd: "/m" });
  const mine = { windowsHide: true };
  spawn("a.exe", ["x"], mine);
  assert.deepEqual(calls[0], ["a.exe", { cwd: "/m", windowsHide: true }]);
  assert.deepEqual(calls[1], ["a.exe", [], { windowsHide: true }], "args 省略时补空数组");
  assert.deepEqual(calls[2], ["a.exe", ["x"], { cwd: "/m", windowsHide: true }]);
  assert.equal(calls[3][2], mine, "已经写了 true 就原对象透传");

  const forkCalls = [];
  const fork = wrapFork((...args) => { forkCalls.push(args); return "r"; });
  fork("m.js", ["y"], { cwd: "/m" });
  assert.deepEqual(forkCalls[0], ["m.js", ["y"], { cwd: "/m", windowsHide: true }]);
});

test("wrapExecLike：callback 当第二参时插一个 options 进去", () => {
  const calls = [];
  const exec = wrapExecLike((...args) => { calls.push(args); return "r"; });
  const cb = () => {};
  exec("a.exe", cb);
  exec("a.exe", { cwd: "/m" }, cb);
  assert.deepEqual(calls[0], ["a.exe", { windowsHide: true }, cb]);
  assert.deepEqual(calls[1], ["a.exe", { cwd: "/m", windowsHide: true }, cb]);
});

test("wrapExecFile：四种参数形态", () => {
  const calls = [];
  const execFile = wrapExecFile((...args) => { calls.push(args); return "r"; });
  const cb = () => {};
  execFile("a.exe", cb);
  execFile("a.exe", { cwd: "/m" });
  execFile("a.exe", ["x"], cb);
  execFile("a.exe", ["x"], { cwd: "/m" }, cb);
  assert.deepEqual(calls[0], ["a.exe", { windowsHide: true }, cb], "(file, callback)");
  // (file, options)：走的是 args-就是-options 那一支，orig 收到三个参数，第三参是 undefined。
  assert.deepEqual(calls[1], ["a.exe", { cwd: "/m", windowsHide: true }, undefined], "(file, options)");
  assert.deepEqual(calls[2], ["a.exe", ["x"], { windowsHide: true }, cb], "(file, args, callback)");
  assert.deepEqual(calls[3], ["a.exe", ["x"], { cwd: "/m", windowsHide: true }, cb], "全参");
});

test("wrapper 保留 this（宿主里有代码依赖 cp 作为 this）", () => {
  const self = { tag: "self" };
  let got = null;
  const spawn = wrapSpawn(function () { got = this; return "r"; });
  spawn.call(self, "a.exe");
  assert.equal(got, self);
});

// ---------------------------------------------------------------- 注入到宿主的入口源码

/**
 * hideConsoleEntrySource() 是真正落到宿主 lib 里的那份代码。
 * 把它求值到假 process 上，就能精确看到每个入口收到什么 options ——
 * 比观察真子进程（看不到 options）直接得多，而且不依赖平台。
 */
function evalEntry(options = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return { name, args };
  };
  const fakeCp = {
    spawn: record("spawn"),
    spawnSync: record("spawnSync"),
    exec: record("exec"),
    execSync: record("execSync"),
    execFile: record("execFile"),
    execFileSync: record("execFileSync"),
    fork: record("fork"),
  };
  const fakeProcess = {
    platform: options.platform || "win32",
    versions: options.versions || {},
    getBuiltinModule: () => fakeCp,
  };
  // eslint-disable-next-line no-new-func
  new Function("process", hideConsoleEntrySource())(fakeProcess);
  return { fakeCp, calls };
}

test("入口源码：Windows 非 Electron 下六个入口全被包，且都补上 windowsHide", () => {
  const { fakeCp, calls } = evalEntry();
  fakeCp.spawn("a.exe", ["x"], { cwd: "/tmp" });
  fakeCp.spawnSync("a.exe", ["x"]);
  fakeCp.exec("a.exe", { cwd: "/tmp" });
  fakeCp.execSync("a.exe");
  fakeCp.execFile("a.exe", ["x"], { cwd: "/tmp" });
  fakeCp.execFileSync("a.exe", ["x"]);
  fakeCp.fork("m.js", [], { cwd: "/tmp" });
  assert.equal(calls.length, 7);
  const spawnCall = calls.find((c) => c.name === "spawn");
  assert.deepEqual(spawnCall.args[2], { cwd: "/tmp", windowsHide: true });
  assert.deepEqual(calls.find((c) => c.name === "spawnSync").args[2], { windowsHide: true });
  assert.deepEqual(calls.find((c) => c.name === "exec").args[1], { cwd: "/tmp", windowsHide: true });
  assert.deepEqual(calls.find((c) => c.name === "execSync").args[1], { windowsHide: true });
  assert.deepEqual(calls.find((c) => c.name === "execFile").args[2], { cwd: "/tmp", windowsHide: true });
  assert.deepEqual(calls.find((c) => c.name === "execFileSync").args[2], { windowsHide: true });
  assert.deepEqual(calls.find((c) => c.name === "fork").args[2], { cwd: "/tmp", windowsHide: true });
});

test("入口源码：调用方已经写了 windowsHide:true 时原对象透传，不复制", () => {
  const { fakeCp, calls } = evalEntry();
  const mine = { windowsHide: true, cwd: "/x" };
  fakeCp.spawn("a.exe", [], mine);
  assert.equal(calls[0].args[2], mine, "已经是 true 就不该再复制一份");
});

test("入口源码：options 是 null / undefined / 非对象时分别怎么处理", () => {
  const { fakeCp, calls } = evalEntry();
  fakeCp.spawn("a.exe", [], undefined);
  fakeCp.spawn("a.exe", [], null);
  fakeCp.spawn("a.exe", [], "weird");
  assert.deepEqual(calls[0].args[2], { windowsHide: true });
  assert.deepEqual(calls[1].args[2], { windowsHide: true });
  assert.equal(calls[2].args[2], "weird", "非对象原样透传，不能强行改成对象");
});

test("入口源码：args 省略 / args 是 options 两种重载都要正确落位", () => {
  const { fakeCp, calls } = evalEntry();
  fakeCp.spawn("a.exe", { cwd: "/y" });          // args 就是 options
  fakeCp.spawn("a.exe");                          // 两个都省略
  assert.deepEqual(calls[0].args[1], { cwd: "/y", windowsHide: true });
  assert.deepEqual(calls[0].args[2], undefined);
  assert.deepEqual(calls[1].args[1], [], "args 省略时要补空数组，不能传 undefined");
  assert.deepEqual(calls[1].args[2], { windowsHide: true });
});

test("入口源码：exec 的 callback 作为第二参时也要落对位置", () => {
  const { fakeCp, calls } = evalEntry();
  const cb = () => {};
  fakeCp.exec("a.exe", cb);
  assert.deepEqual(calls[0].args[1], { windowsHide: true });
  assert.equal(calls[0].args[2], cb);
});

test("入口源码：execFile 的四种参数形态", () => {
  const { fakeCp, calls } = evalEntry();
  const cb = () => {};
  fakeCp.execFile("a.exe", cb);                              // (file, callback)
  fakeCp.execFile("a.exe", ["x"], cb);                       // (file, args, callback)
  fakeCp.execFile("a.exe", { cwd: "/z" });                   // (file, options)
  fakeCp.execFile("a.exe", ["x"], { cwd: "/z" }, cb);        // 全参
  assert.deepEqual(calls[0].args[1], { windowsHide: true });
  assert.equal(calls[0].args[2], cb);
  assert.deepEqual(calls[1].args[2], { windowsHide: true }, "args 数组之后的第三参是 options");
  assert.equal(calls[1].args[3], cb);
  assert.deepEqual(calls[2].args[1], { cwd: "/z", windowsHide: true });
  assert.deepEqual(calls[3].args[2], { cwd: "/z", windowsHide: true });
  assert.equal(calls[3].args[3], cb);
});

test("入口源码：Electron 或非 win32 时整段跳过（调一次也不会经过 wrapper）", () => {
  // 关键：必须真的调一次。只看 calls.length 为 0 抓不到「把 !isElectron 删掉」——
  // 用例不调，包没包都是 0。
  // 注意：不能靠 calls.length 判断包没包 —— 探针就是最终被调的函数，包不包都会记一条。
  // 要看两件事：标记有没有打上、传下去的 options 有没有被补 windowsHide。
  const electron = evalEntry({ versions: { electron: "44" } });
  electron.fakeCp.spawn("a.exe", ["x"], { cwd: "/e" });
  assert.equal(electron.fakeCp[MARK], undefined, "Electron 里连标记都不该打");
  assert.deepEqual(electron.calls[0].args[2], { cwd: "/e" }, "Electron 里 options 必须原样");

  const linux = evalEntry({ platform: "linux" });
  linux.fakeCp.spawn("a.exe", ["x"], { cwd: "/l" });
  assert.equal(linux.fakeCp[MARK], undefined, "非 win32 一律不包");
  assert.deepEqual(linux.calls[0].args[2], { cwd: "/l" }, "非 win32 也要原样");

  // 反面对照：win32 非 Electron 必须包上（否则上面两条恒真）。
  const win = evalEntry();
  win.fakeCp.spawn("a.exe", ["x"], { cwd: "/w" });
  assert.equal(win.fakeCp[MARK], true);
  assert.deepEqual(win.calls[0].args[2], { cwd: "/w", windowsHide: true });
});

test("入口源码：已经打过标记时不重复包（宿主里被 require 两次也安全）", () => {
  const src = hideConsoleEntrySource();
  const fakeCp = { spawn: () => "orig" };
  fakeCp[MARK] = true;
  const fakeProcess = { platform: "win32", versions: {}, getBuiltinModule: () => fakeCp };
  // eslint-disable-next-line no-new-func
  new Function("process", src)(fakeProcess);
  assert.equal(fakeCp.spawn(), "orig", "有标记就原样留着");
});

test("入口源码的字符串形态：带 import 标记头、名字与库里的常量一致", () => {
  const src = hideConsoleEntrySource();
  assert.match(src, new RegExp(`^// ${IMPORT_MARK} — auto-installed by dsh-purge; do not edit`));
  assert.ok(src.includes(`const MARK = ${JSON.stringify(MARK)};`), "标记名必须与 installHideConsole 用的一致");
  assert.match(src, /do not edit/);
});

// ---------------------------------------------------------------- 原子写

test("writeHostFileAtomic：写临时文件再 rename，且把原文件的 mode 带到临时文件上（#213）", () => {
  const { fs, calls } = fakeFs({ "/h/lib/bin.js": "old" }, { mode: 0o755 });
  writeHostFileAtomic(fs, "/h/lib/bin.js", "new");
  const tmp = calls.write[0].p;
  assert.match(tmp, /^\/h\/lib\/bin\.js\.\d+\.tmp$/);
  assert.deepEqual(calls.chmod, [{ p: tmp, mode: 0o755 }], "chmod 必须作用在临时文件上，mode 来自目标");
  assert.deepEqual(calls.rename, [{ a: tmp, b: "/h/lib/bin.js" }], "rename 是最后一步，避免半截文件");
});

test("writeHostFileAtomic：目标不存在时按默认权限新建，不 chmod", () => {
  const { fs, calls } = fakeFs({});
  writeHostFileAtomic(fs, "/h/lib/new.js", "x");
  assert.equal(calls.chmod.length, 0, "没有原 mode 就不该 chmod");
  assert.deepEqual(calls.rename, [{ a: calls.write[0].p, b: "/h/lib/new.js" }]);
});

test("writeHostFileAtomic：抽象 fs 不提供 statSync / chmodSync 时照样能写完", () => {
  const { fs, calls } = fakeFs({}, { noStat: true, chmodThrows: true });
  writeHostFileAtomic(fs, "/h/lib/x.js", "x");
  assert.equal(calls.rename.length, 1);
  assert.equal(calls.write.length, 1);
});

test("writeHostFileAtomic：没有 renameSync 时退化成原地写，并且不把临时文件留在宿主 lib 里", () => {
  const { fs, calls } = fakeFs({ "/h/lib/bin.js": "old" });
  delete fs.renameSync;
  writeHostFileAtomic(fs, "/h/lib/bin.js", "new");
  assert.equal(calls.write.length, 2, "先写临时文件，再原地写目标");
  assert.equal(calls.write[1].p, "/h/lib/bin.js");
  assert.deepEqual(calls.unlink, [calls.write[0].p], "临时文件必须删掉");
});

test("writeHostFileAtomic：rename 失败时收走临时文件再抛（不留垃圾在宿主 lib）", () => {
  const { fs, calls } = fakeFs({ "/h/lib/bin.js": "old" }, { renameThrows: true });
  assert.throws(() => writeHostFileAtomic(fs, "/h/lib/bin.js", "new"), /EPERM/);
  assert.deepEqual(calls.unlink, [calls.write[0].p]);
});

test("writeHostFileAtomic：写入阶段就失败时不走到 rename", () => {
  const { fs, calls } = fakeFs({ "/h/lib/bin.js": "old" }, { writeThrows: true });
  assert.throws(() => writeHostFileAtomic(fs, "/h/lib/bin.js", "new"), /EPERM/);
  assert.equal(calls.rename.length, 0);
});

// ---------------------------------------------------------------- 源码树识别

test("looksLikeSourceCliRoot：/apps/cli 结尾直接判真，不必看磁盘", () => {
  const { fs } = fakeFs({});
  assert.equal(looksLikeSourceCliRoot("C:/repo/apps/cli", { fs, path }), true);
  assert.equal(looksLikeSourceCliRoot("/repo/apps/cli/", { fs, path }), true);
});

test("looksLikeSourceCliRoot：node_modules 里的包一律判假（那是 npm 装出来的，该改）", () => {
  const { fs } = fakeFs({ "/x/node_modules/@deepseek-ai/dsh/lib/tsconfig.tsbuildinfo": "" });
  assert.equal(looksLikeSourceCliRoot("/x/node_modules/@deepseek-ai/dsh", { fs, path }), false);
});

test("looksLikeSourceCliRoot：lib/tsconfig.tsbuildinfo 或 tsdown.config.* 存在就是源码树", () => {
  const a = fakeFs({ [norm(path.join("/r", "lib", "tsconfig.tsbuildinfo"))]: "" });
  assert.equal(looksLikeSourceCliRoot("/r", { fs: a.fs, path }), true);
  const b = fakeFs({ [norm(path.join("/r", "tsdown.config.ts"))]: "" });
  assert.equal(looksLikeSourceCliRoot("/r", { fs: b.fs, path }), true);
  const c = fakeFs({ [norm(path.join("/r", "tsdown.config.mjs"))]: "" });
  assert.equal(looksLikeSourceCliRoot("/r", { fs: c.fs, path }), true);
  const d = fakeFs({});
  assert.equal(looksLikeSourceCliRoot("/r", { fs: d.fs, path }), false);
});

test("looksLikeSourceCliRoot：空值假；fs 抛错也假（不能因为探测失败就当成源码树）", () => {
  const { fs } = fakeFs({});
  assert.equal(looksLikeSourceCliRoot("", { fs, path }), false);
  assert.equal(looksLikeSourceCliRoot(null, { fs, path }), false);
  const boom = fakeFs({}, { existsThrows: true });
  assert.equal(looksLikeSourceCliRoot("/r", { fs: boom.fs, path }), false);
});

// ---------------------------------------------------------------- 找 bin 根

test("resolveDshBinRoot：hint 的四种展开都能找到 lib/bin.js", () => {
  for (const [hint, bin] of [
    ["/pkg", "/pkg/lib/bin.js"],
    ["/pkg/dsh", "/pkg/dsh/lib/bin.js"],
    ["/pkg/@deepseek-ai/dsh", "/pkg/@deepseek-ai/dsh/lib/bin.js"],
    ["/pkg/@deepseek-ai", "/pkg/@deepseek-ai/dsh/lib/bin.js"],
  ]) {
    const { fs } = fakeFs({ [norm(bin)]: "" });
    assert.equal(norm(resolveDshBinRoot(hint, { fs, path }) || ""), norm(path.dirname(path.dirname(bin))));
  }
});

test("resolveDshBinRoot：密封在 asar 里的根一律跳过", () => {
  const { fs } = fakeFs({ [norm(path.join("/a/app.asar", "@deepseek-ai/dsh/lib/bin.js"))]: "" });
  assert.equal(resolveDshBinRoot(path.join("/a/app.asar", "@deepseek-ai/dsh"), { fs, path }), null);
});

test("resolveDshBinRoot：源码树排在候选链最前面时，第一遍必须跳过它", () => {
  // hint "/pkg" 的 tries 顺序是 [/pkg, /pkg/dsh, /pkg/@deepseek-ai/dsh]。
  // 让 /pkg 既是源码树（有 tsdown.config.ts）又有 lib/bin.js，/pkg/dsh 是正常包：
  // 第一遍要跳过 /pkg 落到 /pkg/dsh。去掉那条 continue 就会返回 /pkg，
  // 然后 installHideConsoleIntoBin 会往 tsdown 的构建产物里写 sidecar（#41）。
  const { fs } = fakeFs({
    [norm(path.join("/pkg", "lib", "bin.js"))]: "",
    [norm(path.join("/pkg", "tsdown.config.ts"))]: "",
    [norm(path.join("/pkg", "dsh", "lib", "bin.js"))]: "",
  });
  assert.equal(norm(resolveDshBinRoot("/pkg", { fs, path }) || ""), norm("/pkg/dsh"), "源码树要排到第二遍");
  // 只有源码树时，仍然要能返回它（调用方自己决定不准写）。
  const only = fakeFs({ [norm(path.join("/pkg", "lib", "bin.js"))]: "", [norm(path.join("/pkg", "tsdown.config.ts"))]: "" });
  assert.equal(norm(resolveDshBinRoot("/pkg", { fs: only.fs, path }) || ""), norm("/pkg"), "只剩源码树也得能返回");
});

test("resolveDshBinRoot：什么都没有时返回 null，不抛", () => {
  const { fs } = fakeFs({});
  assert.equal(resolveDshBinRoot("/nowhere", { fs, path }), null);
  assert.equal(resolveDshBinRoot(undefined, { fs, path }), null);
});

// ---------------------------------------------------------------- 注入 / 还原

const BIN_JS = (text) => text;

test("installHideConsoleIntoBin：非 win32 直接 skipped_not_win32（CI 上就走这条）", () => {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    assert.equal(installHideConsoleIntoBin("/pkg"), "skipped_not_win32");
  } finally {
    Object.defineProperty(process, "platform", desc);
  }
});

test("installHideConsoleIntoBin：找不到 bin 时 missing_bin，什么都不写", () => {
  const { fs, calls } = fakeFs({});
  assert.equal(installHideConsoleIntoBin("/pkg", { fs, path }), "missing_bin");
  assert.equal(calls.write.length, 0);
});

test("installHideConsoleIntoBin：源码树 skipped_source_cli，一个字节都不写（#41）", () => {
  const root = "/repo/apps/cli";
  const { fs, calls } = fakeFs({ [norm(path.join(root, "lib", "bin.js"))]: "src" });
  assert.equal(installHideConsoleIntoBin(root, { fs, path }), "skipped_source_cli");
  assert.equal(calls.write.length, 0, "源码树的构建产物绝不能写");
});

test("installHideConsoleIntoBin：密封 asar 里的根连候选都进不去，一个字节都不写", () => {
  const root = path.join("/a/app.asar", "dsh");
  const { fs, calls } = fakeFs({ [norm(path.join(root, "lib", "bin.js"))]: "" });
  // 现状锁定：resolveDshBinRoot 已经先 continue 掉密封根，所以走不到函数里那道
  // sealed_asar 判定，返回的是 missing_bin。那道判定是纵深防御，留着对，但公开路径上不可达。
  assert.equal(installHideConsoleIntoBin(root, { fs, path }), "missing_bin");
  assert.equal(calls.write.length, 0, "密封根绝不能被写");
});

test("installHideConsoleIntoBin：正常注入 —— 两份 sidecar + bin.js 顶部那一行，顺序是先 sidecar 后 bin.js", () => {
  const root = "/pkg/@deepseek-ai/dsh";
  const binJs = path.join(root, "lib", "bin.js");
  const { fs, calls } = fakeFs({ [norm(binJs)]: "#!/usr/bin/env node\nconsole.log(1);\n" });
  assert.equal(installHideConsoleIntoBin(root, { fs, path }), "injected");
  // writeFileSync 落的是 .tmp，最终路径要经 rename 才出现 —— 所以看 rename 的目标。
  const renamed = calls.rename.map((r) => r.b);
  assert.equal(renamed.length, 3, "facade、sidecar、bin.js 各一次原子写");
  assert.equal(renamed[0], norm(path.join(root, "lib", "dsh-purge-child-process-hide.mjs")), "facade 必须第一个落盘");
  assert.equal(renamed[1], norm(path.join(root, "lib", `${IMPORT_MARK}.js`)), "sidecar 第二");
  assert.equal(renamed[2], norm(binJs), "bin.js 最后写 —— 否则中途崩溃会留下「有 import 没 sidecar」的宿主");
  assert.match(fs.readFileSync(binJs), /^#!\/usr\/bin\/env node\nimport "\.\/dsh-purge-hide-console\.js"; \/\/ \[dsh-purge\] hide-console\n/);
});

test("installHideConsoleIntoBin：bin.js 没有 shebang 时 import 行放在最前面", () => {
  const root = "/pkg/dsh";
  const binJs = path.join(root, "lib", "bin.js");
  const { fs, calls } = fakeFs({ [norm(binJs)]: "console.log(1);\n" });
  assert.equal(installHideConsoleIntoBin(root, { fs, path }), "injected");
  assert.match(fs.readFileSync(binJs), /^import "\.\/dsh-purge-hide-console\.js"; \/\/ \[dsh-purge\] hide-console\nconsole\.log/);
});

test("installHideConsoleIntoBin：只有 shebang 没有换行时也能插进去", () => {
  const root = "/pkg/dsh";
  const binJs = path.join(root, "lib", "bin.js");
  const { fs, calls } = fakeFs({ [norm(binJs)]: "#!/usr/bin/env node" });
  assert.equal(installHideConsoleIntoBin(root, { fs, path }), "injected");
  assert.equal(fs.readFileSync(binJs), `#!/usr/bin/env node\nimport "./dsh-purge-hide-console.js"; // [dsh-purge] hide-console\n`);
});

test("installHideConsoleIntoBin：已经注入过就 already_injected，不改 bin.js", () => {
  const root = "/pkg/dsh";
  const binJs = path.join(root, "lib", "bin.js");
  const injected = `#!/usr/bin/env node\nimport "./dsh-purge-hide-console.js"; // [dsh-purge] hide-console\nx\n`;
  const { fs, calls } = fakeFs({ [norm(binJs)]: injected });
  assert.equal(installHideConsoleIntoBin(root, { fs, path }), "already_injected");
  assert.equal(calls.write.filter((c) => c.p === norm(binJs)).length, 0, "已经在了就不要重写 bin.js");
});

test("installHideConsoleIntoBin：双引号旧行（无行尾注释）也算已注入，install 路径上的清理正则走不到（现状锁定）", () => {
  const root = "/pkg/dsh";
  const binJs = path.join(root, "lib", "bin.js");
  // already_injected 的判据是「含 IMPORT_MARK」且「含 import "./dsh-purge-hide-console.js";」，
  // 双引号旧行两条都满足 → 直接返回 already_injected，后面那条 `text.replace(/^import "...".*\r?\n/m, "")`
  // 永远走不到（只有 revertHideConsoleFromBin 的 /gm 版本才会真清）。
  // 留着那段清理是纵深防御：单引号形态会漏过去，见下一条。
  const stale = `#!/usr/bin/env node\nimport "./dsh-purge-hide-console.js";\nimport "./dsh-purge-hide-console.js";\nx\n`;
  const { fs, calls } = fakeFs({ [norm(binJs)]: stale });
  assert.equal(installHideConsoleIntoBin(root, { fs, path }), "already_injected");
  assert.equal(calls.rename.some((r) => r.b === norm(binJs)), false, "已注入就不该再写 bin.js");
  assert.equal(fs.readFileSync(binJs), stale, "一个字节都不动");
});

test("installHideConsoleIntoBin：单引号形态的旧行既不算已注入、也不被清理正则匹配（现状锁定）", () => {
  const root = "/pkg/dsh";
  const binJs = path.join(root, "lib", "bin.js");
  // 清理正则写死了双引号（`^import "\.\/dsh-purge-hide-console\.js";`），单引号形态匹配不到。
  // 同时 already_injected 的判据要求「含双引号那半截」，所以它也不算已注入 —— 结果会再插一行。
  // ESM 按 specifier 去重，多这一行无害（同一个模块只求值一次），所以这是现状锁定而不是要修的 bug。
  const single = `#!/usr/bin/env node\nimport './dsh-purge-hide-console.js';\nx\n`;
  const { fs } = fakeFs({ [norm(binJs)]: single });
  assert.equal(installHideConsoleIntoBin(root, { fs, path }), "injected");
  const text = fs.readFileSync(binJs);
  assert.equal((text.match(/dsh-purge-hide-console/g) || []).length, 2, "单引号旧行留着，新的一行加在上面");
  assert.match(text, /^#!\/usr\/bin\/env node\nimport "\.\/dsh-purge-hide-console\.js"; \/\/ \[dsh-purge\] hide-console\nimport '\.\/dsh-purge-hide-console\.js';/);
});

test("revertHideConsoleFromBin：找不到 bin 时 missing_bin", () => {
  const { fs } = fakeFs({});
  assert.equal(revertHideConsoleFromBin("/pkg", { fs, path }), "missing_bin");
});

test("revertHideConsoleFromBin：正常还原 bin.js 并删掉两份 sidecar", () => {
  const root = "/pkg/dsh";
  const binJs = path.join(root, "lib", "bin.js");
  const side = path.join(root, "lib", `${IMPORT_MARK}.js`);
  const facade = path.join(root, "lib", "dsh-purge-child-process-hide.mjs");
  const { fs, calls } = fakeFs({
    [norm(binJs)]: `#!/usr/bin/env node\nimport "./dsh-purge-hide-console.js"; // [dsh-purge] hide-console\nimport "./dsh-purge-hide-console.js"; // [dsh-purge] hide-console\nx\n`,
    [norm(side)]: "side",
    [norm(facade)]: "facade",
  });
  assert.equal(revertHideConsoleFromBin(root, { fs, path }), "reverted");
  assert.ok(calls.rename.some((r) => r.b === norm(binJs)), "bin.js 要经原子写回");
  assert.doesNotMatch(fs.readFileSync(binJs), /dsh-purge-hide-console/);
  // 两条 import 都要清（正则用的是 /gm）。只清第一条会让宿主里留着一条指向已删 sidecar 的
  // import —— 下次启动 CLI 直接 MODULE_NOT_FOUND。
  assert.equal(fs.readFileSync(binJs), "#!/usr/bin/env node\nx\n");
  assert.deepEqual(calls.unlink.sort(), [norm(facade), norm(side)].sort());
});

test("revertHideConsoleFromBin：已经干净时返回 absent", () => {
  const root = "/pkg/dsh";
  const binJs = path.join(root, "lib", "bin.js");
  const { fs } = fakeFs({ [norm(binJs)]: "#!/usr/bin/env node\nx\n" });
  assert.equal(revertHideConsoleFromBin(root, { fs, path }), "absent");
});

test("revertHideConsoleFromBin：源码树只清 sidecar，绝不改 bin.js（#41）", () => {
  const root = "/repo/apps/cli";
  const binJs = path.join(root, "lib", "bin.js");
  const side = path.join(root, "lib", `${IMPORT_MARK}.js`);
  const { fs, calls } = fakeFs({
    [norm(binJs)]: `import "./dsh-purge-hide-console.js"; // [dsh-purge] hide-console\nsrc\n`,
    [norm(side)]: "side",
  });
  assert.equal(revertHideConsoleFromBin(root, { fs, path }), "reverted");
  assert.equal(calls.write.length, 0, "源码树的 bin.js 一个字节都不能动");
  assert.deepEqual(calls.unlink, [norm(side)], "但本插件留下的 sidecar 要清掉");
});

test("revertHideConsoleFromBin：bin.js 读不出来时返回 error: 前缀，sidecar 仍然删", () => {
  const root = "/pkg/dsh";
  const binJs = path.join(root, "lib", "bin.js");
  const side = path.join(root, "lib", `${IMPORT_MARK}.js`);
  const { fs, calls } = fakeFs({ [norm(binJs)]: "x", [norm(side)]: "s" }, { readThrows: true });
  const r = revertHideConsoleFromBin(root, { fs, path });
  assert.match(r, /^error:/);
  // 现状锁定：bin.js 读不出来时函数立刻返回 error:，两份 sidecar 这一轮不删
  // （下次启动会再试一次）。不改它是因为「bin.js 坏了」比「sidecar 多留一轮」严重得多，
  // 先让人看到 error: 更重要。
  assert.deepEqual(calls.unlink, [], "读失败时这一轮不删 sidecar");
});

test("注入 → 还原 是逐字节可逆的", () => {
  const root = "/pkg/dsh";
  const binJs = path.join(root, "lib", "bin.js");
  const original = "#!/usr/bin/env node\nimport x from 'y';\nmain();\n";
  const { fs, map } = fakeFs({ [norm(binJs)]: original });
  // fakeFs 的 map 以归一化路径为键；rename 会把值搬到目标键上，所以断言读的是最终文件。
  assert.equal(installHideConsoleIntoBin(root, { fs, path }), "injected");
  assert.notEqual(map.get(norm(binJs)), original);
  assert.equal(revertHideConsoleFromBin(root, { fs, path }), "reverted");
  assert.equal(map.get(norm(binJs)), original, "还原之后必须与原文逐字相同");
});
