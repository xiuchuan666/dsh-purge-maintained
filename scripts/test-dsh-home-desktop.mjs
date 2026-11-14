import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `lib/core.js` 在模块顶层就把若干路径常量算好了（日志、缓存），所以 TEMP 必须
// 在 import 之前指到本进程私有目录；`findDshHome` 本身不缓存，但 `findAiBase` /
// `findNpmPrefix` 走 remember()，每次改现场都要 resetPathMemo()。
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-home-desktop-"));
const KEEP = [
  "TEMP", "TMP", "TMPDIR", "DSH_HOME", "DSH_SURFACE", "DSH_BASE", "DSH_DESKTOP_INSTALL",
  "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "PATH", "npm_config_prefix",
];
const ORIG = Object.fromEntries(KEEP.map((k) => [k, process.env[k]]));
for (const k of ["TEMP", "TMP", "TMPDIR"]) process.env[k] = ROOT;

const core = await import("../lib/core.js");
const SRC = fs.readFileSync(new URL("../lib/core.js", import.meta.url), "utf8");

test.after(() => {
  for (const k of KEEP) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
});

let seq = 0;

/** 一套完整沙箱：home / appdata / localappdata / 桌面安装树 / npm 前缀。 */
function box(tag) {
  seq += 1;
  const root = path.join(ROOT, `${String(seq).padStart(2, "0")}-${tag}`);
  const out = {
    root,
    home: path.join(root, "home"),
    appdata: path.join(root, "appdata"),
    localapp: path.join(root, "localapp"),
    inst: path.join(root, "inst"),
    npm: path.join(root, "npm-prefix"),
  };
  for (const dir of [out.home, out.appdata, out.localapp, out.inst, out.npm]) fs.mkdirSync(dir, { recursive: true });
  // 安装树必须真的像「桌面安装」：不然 listDesktopInstallRoots() 根本不会把它算成候选根。
  fs.writeFileSync(path.join(out.inst, "DeepSeek Harness.exe"), "MZ");
  process.env.USERPROFILE = out.home;
  process.env.HOME = out.home;
  process.env.APPDATA = out.appdata;
  process.env.LOCALAPPDATA = out.localapp;
  process.env.DSH_DESKTOP_INSTALL = out.inst;
  process.env.DSH_SURFACE = "desktop";
  process.env.npm_config_prefix = out.npm;
  process.env.PATH = out.npm;
  delete process.env.DSH_HOME;
  delete process.env.DSH_BASE;
  core.resetPathMemo();
  return out;
}

function put(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files || {})) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, body);
  }
  return dir;
}

function asPlatform(name, fn) {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: name, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

test("homeHasHarnessData：三个标记任一即可，目录本身不算", () => {
  const b = box("harness-data");
  assert.equal(core.homeHasHarnessData(""), false);
  assert.equal(core.homeHasHarnessData(null), false);
  assert.equal(core.homeHasHarnessData(b.home), false, "空目录不算 harness home");
  put(b.home, { "prompt-inject.md": "x" });
  assert.equal(core.homeHasHarnessData(b.home), true);
  const withProfiles = put(path.join(b.root, "h2"), { "profiles/p1/package.json": "{}" });
  assert.equal(core.homeHasHarnessData(withProfiles), true);
  const withCordis = put(path.join(b.root, "h3"), { "cordis.patch.yml": "[]\n" });
  assert.equal(core.homeHasHarnessData(withCordis), true);
  assert.equal(core.homeHasHarnessData(path.join(b.home, "prompt-inject.md")), false, "文件不是目录");
});

test("isDshHomeDir：只认末段名字是 .dsh 或 dsh-home", () => {
  const b = box("isdshhome");
  const a = put(path.join(b.root, "x", ".dsh"), {});
  const c = put(path.join(b.root, "y", "dsh-home"), {});
  const d = put(path.join(b.root, "z", "home"), {});
  assert.equal(core.isDshHomeDir(a), true);
  assert.equal(core.isDshHomeDir(c), true);
  assert.equal(core.isDshHomeDir(d), false, "同结构的 home 不算");
  assert.equal(core.isDshHomeDir(path.join(b.root, "nope")), false);
  assert.equal(core.isDshHomeDir(""), false);
});

test("desktopDshHomeGuesses：win32 用 APPDATA 与 LOCALAPPDATA 两条", () => {
  const b = box("guesses-win");
  const out = asPlatform("win32", () => core.desktopDshHomeGuesses());
  assert.deepEqual(out, [
    path.join(b.appdata, "DeepSeek Harness", "dsh-home"),
    path.join(b.localapp, "DeepSeek Harness", "dsh-home"),
  ]);
});

test("desktopDshHomeGuesses：darwin 只出 Library 那条，linux 出空数组", () => {
  const b = box("guesses-other");
  const mac = asPlatform("darwin", () => core.desktopDshHomeGuesses());
  assert.deepEqual(mac, [path.join(b.home, "Library", "Application Support", "DeepSeek Harness", "dsh-home")]);
  const win = asPlatform("linux", () => core.desktopDshHomeGuesses());
  assert.deepEqual(win, [], "linux 官方没有桌面壳，不能凭空给 Windows 路径");
});

test("findDshHome 桌面面：安装树旁的 .dsh 有数据就选它", () => {
  const b = box("desk-dotdsh");
  put(path.join(b.inst, ".dsh"), { "prompt-inject.md": "body" });
  core.resetPathMemo();
  assert.equal(core.findDshHome(), path.join(b.inst, ".dsh"));
});

test("findDshHome 桌面面：dsh-home 有 profiles 也算，且排在 .dsh 之后", () => {
  const b = box("desk-dshhome");
  put(path.join(b.inst, "dsh-home"), { "profiles/p/package.json": "{}" });
  core.resetPathMemo();
  assert.equal(core.findDshHome(), path.join(b.inst, "dsh-home"));
});

test("findDshHome 桌面面：候选目录都在但都没数据时回退第一个候选", () => {
  const b = box("desk-empty");
  // `<inst>` 自己不是 isDshHomeDir（末段是 inst），所以只有 .dsh / dsh-home 会进 found。
  put(path.join(b.inst, ".dsh"), {}); // 存在但没 harness 数据
  put(path.join(b.inst, "dsh-home"), {});
  core.resetPathMemo();
  const out = core.findDshHome();
  assert.equal(out, path.join(b.inst, ".dsh"), "found[0] 是 .dsh（push 顺序：root/.dsh/dsh-home 里只有后两个过 isDshHomeDir）");
});

test("findDshHome 桌面面：安装树空时退到 ~/.dsh（存在且有数据）", () => {
  const b = box("desk-unix");
  put(path.join(b.home, ".dsh"), { "prompt-inject.md": "x" });
  core.resetPathMemo();
  assert.equal(core.findDshHome(), path.join(b.home, ".dsh"));
});

test("findDshHome 桌面面：~/.dsh 存在但没有 harness 数据时，仍优先安装树旁的候选", () => {
  const b = box("desk-unix-empty");
  put(path.join(b.home, ".dsh"), {}); // 存在，但空
  put(path.join(b.home, ".dsh", "other.txt"), "x");
  put(path.join(b.inst, ".dsh"), {});
  core.resetPathMemo();
  assert.equal(core.findDshHome(), path.join(b.inst, ".dsh"), "有候选就不该用一个空目录冒充主目录");
});

test("findDshHome 桌面面：什么都没有时仍返回 ~/.dsh 路径（不返回空）", () => {
  const b = box("desk-none");
  core.resetPathMemo();
  const out = core.findDshHome();
  assert.equal(out, path.join(b.home, ".dsh"), "路径可以不存在，但必须是稳定答案");
});

test("findDshHome：DSH_HOME 带空白时 trim 后直接用，不再去猜", () => {
  const b = box("env-home");
  process.env.DSH_HOME = `  ${path.join(b.root, "custom")}  `;
  core.resetPathMemo();
  assert.equal(core.findDshHome(), path.join(b.root, "custom"));
  process.env.DSH_HOME = "   ";
  core.resetPathMemo();
  assert.notEqual(core.findDshHome(), "   ", "只有空白等于没设");
});

test("findDshHome web 面：启动器旁 .dsh 命中就走 portable，不看桌面候选", () => {
  const b = box("web-portable");
  process.env.DSH_SURFACE = "web";
  const shimDir = path.join(b.root, "bin");
  put(path.join(shimDir, ".dsh"), { "cordis.patch.yml": "[]\n" });
  core.resetPathMemo();
  assert.equal(core.findDshHome({ shimDir, prefix: b.npm }), path.join(shimDir, ".dsh"));
});

test("portableHomeFromLauncher：shimDir 三级 + prefix 两级，按顺序取第一个命中的", () => {
  const b = box("portable");
  const shimDir = path.join(b.root, "bin");
  const prefix = path.join(b.root, "npm-prefix");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(prefix, { recursive: true });
  assert.equal(core.portableHomeFromLauncher(shimDir, prefix), null, "都没 .dsh 时回 null");
  put(path.join(prefix, ".dsh"), {});
  assert.equal(core.portableHomeFromLauncher(shimDir, prefix), path.join(prefix, ".dsh"));
  put(path.join(shimDir, "..", ".dsh"), {});
  assert.equal(core.portableHomeFromLauncher(shimDir, prefix), path.join(b.root, ".dsh"), "shimDir 的上一级优先于 prefix");
  assert.equal(core.portableHomeFromLauncher("", ""), null);
  // 去重：同一个目录当 shimDir 与 prefix 传两次时只算一次（bases 里会出现同一个候选三次）。
  // 用一套干净沙箱，避免上一段的 `.dsh` 从 `..` 那一级漏进来。
  const clean = box("portable-clean");
  const bare = put(path.join(clean.root, "deep", "bare"), {});
  assert.equal(core.portableHomeFromLauncher(bare, bare), null, "没有 .dsh 就没有答案，重复传也不会凭空多出来");
  put(path.join(bare, ".dsh"), {});
  assert.equal(core.portableHomeFromLauncher(bare, bare), path.join(bare, ".dsh"));
});

test("findWslWindowsDshHome：非 linux 直接空，linux 上 /mnt/c/Users 不存在也空", () => {
  assert.equal(asPlatform("win32", () => core.findWslWindowsDshHome({})), "");
  assert.equal(asPlatform("linux", () => core.findWslWindowsDshHome({})), "");
  assert.equal(asPlatform("linux", () => core.findWslWindowsDshHome({ WSL_DISTRO_NAME: "Ubuntu" })), "");
});

test("源码形状：桌面候选的三个探测各自包 try/catch，去重键归一大小写与斜杠", () => {
  assert.match(SRC, /function desktopHomeCandidates\(\) \{/);
  assert.match(SRC, /const exe = desktop\.findDesktopAppExecutable\(\);\s*\r?\n\s*if \(exe\) push\(path\.dirname\(exe\)\);/);
  assert.match(SRC, /for \(const root of desktop\.listDesktopInstallRoots\(\)\) push\(root\);/);
  assert.match(SRC, /const key = path\.normalize\(item\)\.replace\(\/\\\\\/g, "\/"\)\.toLowerCase\(\);/);
  const body = SRC.slice(SRC.indexOf("function desktopHomeCandidates()"), SRC.indexOf("export function portableHomeFromLauncher"));
  assert.equal(body.split("} catch { /* ignore */ }").length - 1, 3, "三个探测各一个吞错");
  assert.match(SRC, /if \(usable\) return usable;[\s\S]{0,80}if \(isDir\(unix\) && homeHasHarnessData\(unix\)\) return unix;[\s\S]{0,40}if \(found\.length\) return found\[0\];/);
});
