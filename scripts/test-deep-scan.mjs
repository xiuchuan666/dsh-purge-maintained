// 深度兜底扫描：findAiBaseRecursive + scanHomeRootsForAiBase。
// 这一簇是「所有便宜探测都落空」后的最后一手（容器 / 非标准布局），跑起来是每次启动
// 最大的一次 fs 突发，所以两条判据最要紧：①别被 junction 环拖成指数级；②同一棵真
// 子树别被 readdir 两遍。两条都不会报错，只会在启动时多等几秒。
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ORIG = {
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  TMPDIR: process.env.TMPDIR,
  DSH_HOME: process.env.DSH_HOME,
  DSH_SURFACE: process.env.DSH_SURFACE,
  DSH_DESKTOP_INSTALL: process.env.DSH_DESKTOP_INSTALL,
};
const TMP_ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), "dshp-deep-scan-tmp-"));
process.env.TEMP = TMP_ROOT;
process.env.TMP = TMP_ROOT;
process.env.TMPDIR = TMP_ROOT;
const ROOT = fsSync.mkdtempSync(path.join(TMP_ROOT, "case-"));
process.env.DSH_HOME = path.join(ROOT, "home");
process.env.DSH_SURFACE = "web";
fsSync.mkdirSync(process.env.DSH_HOME, { recursive: true });

const core = await import("../lib/core.js");
const { hostFs } = await import("../lib/extract-asar.js");

const NESTED = path.join("node_modules", path.join("@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"));
const NESTED_DIR = path.join("@deepseek-ai", "dsh", "node_modules", "@deepseek-ai");
const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();
const mk = (p) => fsSync.mkdirSync(p, { recursive: true });
const withAiBase = (base) => {
  mk(path.join(base, "dsh-agent-instructions", "lib"));
  return base;
};
const box = (tag) => {
  const dir = path.join(ROOT, tag);
  mk(dir);
  return dir;
};
const readWith = (fn) => {
  const orig = hostFs.readdirSync;
  hostFs.readdirSync = function (p, ...rest) {
    return fn.call(this, orig, p, ...rest);
  };
  try {
    return undefined;
  } finally {
    hostFs.readdirSync = orig;
  }
};
// 计数工具：包住 readdirSync，按「真实路径」归并计数（alias 与 real 算同一处）。
const countReads = (watchReal) => {
  const orig = hostFs.readdirSync;
  const counts = new Map();
  // 盘的短名（ADMINI~1）与 realpath 的长名不是同一个字符串，两边都得过一遍 native。
  const realKey = (p) => {
    try {
      return norm(fsSync.realpathSync.native(p));
    } catch {
      return norm(p);
    }
  };
  const watch = realKey(watchReal);
  const under = (key) => key === watch || key.startsWith(watch + "/");
  hostFs.readdirSync = function (p, ...rest) {
    const key = realKey(p);
    if (under(key)) counts.set(key, (counts.get(key) || 0) + 1);
    return orig.call(this, p, ...rest);
  };
  return {
    counts,
    // 「这棵子树被 readdir 了几次」：根自己 + 它下面每一层。
    get hits() {
      let n = 0;
      for (const [k, v] of counts) if (under(k)) n += v;
      return n;
    },
    restore() {
      hostFs.readdirSync = orig;
    },
  };
};

test.after(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fsSync.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 3 });
});

// ── findAiBaseRecursive ────────────────────────────────────────────────

test("findAiBaseRecursive：node_modules 下的嵌套布局一步到位（不多下钻）", () => {
  const root = box("nested");
  withAiBase(path.join(root, "x", "y", "node_modules", NESTED_DIR));
  let hit;
  const rec = countReads(root);
  try {
    hit = core.findAiBaseRecursive(root, NESTED, 0);
  } finally {
    rec.restore();
  }
  assert.equal(norm(hit), norm(path.join(root, "x", "y", "node_modules", NESTED_DIR)));
  // root → x → y 三次 readdir 就该收工：y 的 node_modules 上直接拼 needle 命中。
  // 少了这道预判也不是找不到，而是要多下钻 node_modules/@deepseek-ai/dsh/... 四五层才碰到同一个目录。
  assert.equal(rec.hits, 3, `readdir 次数=${rec.hits}`);
});

test("findAiBaseRecursive：node_modules/@deepseek-ai 扁平布局命中", () => {
  const root = box("flat");
  withAiBase(path.join(root, "node_modules", "@deepseek-ai"));
  assert.equal(norm(core.findAiBaseRecursive(root, NESTED, 0)), norm(path.join(root, "node_modules", "@deepseek-ai")));
});

test("findAiBaseRecursive：pnpm 的虚拟存储放在子树外时只有 hoist 分支够得着", () => {
  const root = box("pnpm");
  const proj = path.join(root, "proj");
  const store = path.join(root, "store");
  withAiBase(path.join(store, "node_modules", "@deepseek-ai"));
  mk(path.join(proj, "node_modules"));
  // 相对路径按 pnpm 的口径拼到「项目根」上，不是 node_modules 上。
  fsSync.writeFileSync(path.join(proj, "node_modules", ".modules.yaml"), "virtualStoreDir: ../store\n");
  assert.equal(core.pnpmVirtualStoreDir(proj), store);
  const rec = countReads(root);
  let hit;
  try {
    hit = core.findAiBaseRecursive(root, NESTED, 0);
  } finally {
    rec.restore();
  }
  assert.equal(norm(hit), norm(path.join(store, "node_modules", "@deepseek-ai")));
  // store 在 proj 之外，所以不可能是「一路下钻碰到的」；readdir 只碰 root 与 proj 两层。
  assert.equal(rec.hits, 2, `readdir 次数=${rec.hits}`);
});

test("findAiBaseRecursive：深度 6 还能命中，深度 7 放弃", () => {
  const six = box("depth6");
  let dir = six;
  for (let i = 0; i < 6; i += 1) dir = path.join(dir, `L${i}`);
  withAiBase(path.join(dir, "node_modules", "@deepseek-ai"));
  assert.ok(core.findAiBaseRecursive(six, NESTED, 0), "深度 6 应该还能找到");

  const seven = box("depth7");
  let deep = seven;
  for (let i = 0; i < 7; i += 1) deep = path.join(deep, `L${i}`);
  withAiBase(path.join(deep, "node_modules", "@deepseek-ai"));
  assert.equal(core.findAiBaseRecursive(seven, NESTED, 0), null);
});

test("findAiBaseRecursive：readdir 抛错就当这棵子树没有，不往上抛", () => {
  const root = box("unreadable");
  const orig = hostFs.readdirSync;
  hostFs.readdirSync = function (p, ...rest) {
    if (norm(p) === norm(root)) throw new Error("EACCES");
    return orig.call(this, p, ...rest);
  };
  try {
    assert.equal(core.findAiBaseRecursive(root, NESTED, 0), null);
  } finally {
    hostFs.readdirSync = orig;
  }
});

test("findAiBaseRecursive：只下钻目录，同名文件不当目录", () => {
  const root = box("file-not-dir");
  fsSync.writeFileSync(path.join(root, "node_modules"), "not a dir");
  assert.equal(core.findAiBaseRecursive(root, NESTED, 0), null);
});

test("findAiBaseRecursive：junction / 符号链接目录一律不下钻（环因此只靠 depth 兜）", () => {
  const root = box("cycle");
  mk(path.join(root, "z"));
  const linked = path.join(root, "loop");
  fsSync.symlinkSync(root, linked, "junction");
  const rec = countReads(root);
  try {
    assert.equal(core.findAiBaseRecursive(root, NESTED, 0), null);
  } finally {
    rec.restore();
  }
  // readdir 只发生在 root 与它那个真子目录 z 上：Dirent 对 junction 报的是 isSymbolicLink()、
  // 不是 isDirectory()，所以 `if (!e.isDirectory()) continue;` 先把环入口挡掉了 —— 防环真正靠的是它，
  // 不是 realpath（realpath 那条只把 root 自身的别名归一）。要是跟了环，这一路会撞到 depth 上限。
  assert.equal(rec.hits, 2, `readdir 次数=${rec.hits}`);
});

test("findAiBaseRecursive：只经 junction 才够得着的树找不到（现状，写进盲区）", () => {
  const root = box("only-via-link");
  const real = path.join(ROOT, "outside-mounted");
  withAiBase(path.join(real, "node_modules", "@deepseek-ai"));
  fsSync.symlinkSync(real, path.join(root, "mnt"), "junction");
  assert.equal(core.findAiBaseRecursive(root, NESTED, 0), null, "符号链接目录当前不下钻");
});

test("findAiBaseRecursive：同一棵子树不会被两条字符串路径扫两遍", () => {
  const root = box("alias");
  const real = path.join(root, "real");
  mk(real);
  fsSync.symlinkSync(real, path.join(root, "alias"), "junction");
  mk(path.join(root, "zz"));
  withAiBase(path.join(root, "zz", "node_modules", "@deepseek-ai"));
  const rec = countReads(real);
  try {
    assert.ok(core.findAiBaseRecursive(root, NESTED, 0));
  } finally {
    rec.restore();
  }
  assert.equal(rec.hits, 1, `real 被扫了 ${rec.hits} 遍`);
});

test("findAiBaseRecursive：visited 里已经有这个目录就直接回头", () => {
  const root = box("visited");
  const seen = new Set([norm(root)]);
  assert.equal(core.findAiBaseRecursive(root, NESTED, 0, seen), null);
});

test("findAiBaseRecursive：跨设备（非 win32 分支）跳过整个挂载点子树", () => {
  const root = box("crossdev");
  const mnt = path.join(root, "mnt");
  withAiBase(path.join(mnt, "node_modules", "@deepseek-ai"));
  const origStat = hostFs.statSync;
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const statted = [];
  hostFs.statSync = function (p, ...rest) {
    const st = origStat.call(this, p, ...rest);
    const key = norm(p);
    // 整个 mnt 子树都算「另一个设备」：只改入口那一层的话，内层 node_modules 仍是本盘，
    // 判定反了也照样被跳过，测不出区别。
    if (key === norm(mnt) || key.startsWith(norm(mnt) + "/")) {
      statted.push(key);
      // 只改 dev、保留 Stats 的方法：`{ ...st }` 会丢掉原型上的 isDirectory()，
      // 于是 isAiBase 一律返回 false，判定反了也照样回 null —— 那样这条用例就永远绿。
      const stub = Object.create(st);
      stub.dev = 999999;
      return stub;
    }
    return st;
  };
  try {
    assert.equal(core.findAiBaseRecursive(root, NESTED, 0), null, "跨设备子树应当被跳过");
    assert.ok(statted.includes(norm(mnt)), "非 win32 分支每个子目录都要 stat 一次");
  } finally {
    hostFs.statSync = origStat;
    Object.defineProperty(process, "platform", origPlatform);
  }
});

// ── scanHomeRootsForAiBase ─────────────────────────────────────────────

test("scanHomeRootsForAiBase：同一个根写三遍只扫一遍", () => {
  const empty = box("roots-dup-empty");
  mk(path.join(empty, "a"));
  const rec = countReads(empty);
  let hit;
  try {
    hit = core.scanHomeRootsForAiBase([empty, empty, path.join(empty, ".")]);
  } finally {
    rec.restore();
  }
  assert.equal(hit, null);
  // 第一个根没命中才会走到第二、第三个；去重失效时这里会是 5 次
  // （empty + a 各扫一遍，乘三份根）。
  assert.equal(rec.hits, 2, `readdir 次数=${rec.hits}`);
});

test("scanHomeRootsForAiBase：null / 空串 / 不存在的根都跳过", () => {
  assert.equal(core.scanHomeRootsForAiBase([null, undefined, "", path.join(ROOT, "nowhere")]), null);
});

test("scanHomeRootsForAiBase：命中的根落在桌面安装树里就不算，继续找下一个根", () => {
  const inst = path.join(ROOT, "inst");
  const inside = path.join(inst, "resources", "app", "dsh", "node_modules", "@deepseek-ai");
  withAiBase(inside);
  const outside = box("outside");
  withAiBase(path.join(outside, "node_modules", "@deepseek-ai"));
  process.env.DSH_DESKTOP_INSTALL = inst;
  try {
    const hit = core.scanHomeRootsForAiBase([path.join(inst, "resources", "app", "dsh"), outside]);
    assert.equal(norm(hit), norm(path.join(outside, "node_modules", "@deepseek-ai")));
    assert.equal(core.scanHomeRootsForAiBase([path.join(inst, "resources", "app", "dsh")]), null);
  } finally {
    if (ORIG.DSH_DESKTOP_INSTALL === undefined) delete process.env.DSH_DESKTOP_INSTALL;
    else process.env.DSH_DESKTOP_INSTALL = ORIG.DSH_DESKTOP_INSTALL;
  }
});

test("scanHomeRootsForAiBase：全都不命中时回 null，不抛", () => {
  const empty = box("all-empty");
  assert.equal(core.scanHomeRootsForAiBase([empty]), null);
});

// ── 源码形状（行为层到不了，或到了也看不出差别） ───────────────────────

test("源码形状：realpath 去环走 node:fs 的 native，而不是 hostFs 那份不存在的 .native", () => {
  const src = fsSync.readFileSync(path.join(import.meta.dirname, "..", "lib", "core.js"), "utf8");
  assert.ok(
    src.includes("try { real = nodeFs.realpathSync.native(root); } catch { try { real = fs.realpathSync(root); } catch { real = root; } }"),
    "findAiBaseRecursive 的 realpath 回退链被改了",
  );
  const bad = src
    .split("\n")
    .filter((l) => /[^.\w]fs\.realpathSync\.native/.test(l) && !/nodeFs\.realpathSync\.native/.test(l))
    .filter((l) => !/^\s*\/\//.test(l));
  assert.deepEqual(bad.map((l) => l.trim()), [], "还有地方直接用了 hostFs 的 realpathSync.native");
});

test("源码形状：深度兜底的闸门与三个根留在 findAiBaseWeb，扫描体在独立函数里", () => {
  const src = fsSync.readFileSync(path.join(import.meta.dirname, "..", "lib", "core.js"), "utf8");
  assert.ok(src.includes('if (detectSurface() === "desktop" && String(process.env.DSH_PURGE_DEEP_AIBASE_SCAN || "").trim() !== "1") {'));
  assert.ok(src.includes('return scanHomeRootsForAiBase([findDshHome(), path.join(findDshHome(), ".."), os.homedir()]);'));
  assert.ok(src.includes("export function scanHomeRootsForAiBase(roots) {"));
  assert.ok(src.includes("return withFsProbeCache(() => {"), "扫描必须在 asar 判定缓存的作用域里");
});

test("源码形状：visit 键做了斜杠归一 + 小写（Windows 上大小写与反斜杠都不该算两个目录）", () => {
  const src = fsSync.readFileSync(path.join(import.meta.dirname, "..", "lib", "core.js"), "utf8");
  assert.ok(src.includes('const key = String(real).replace(/\\\\/g, "/").toLowerCase();'));
});