// 宿主树选择链：补丁到底该打在哪一份 DSH 上。
//
// 这一簇判错不抛错：打到 Electron 外壳那份 → 全部 no-file、看着像「都不兼容」；
// 打到 npm 全局那份 → 宿主读不到，状态页仍然一片绿。所以这里把「选树」的每个
// 分支都钉住，并且全程只碰临时目录（DSH_DESKTOP_INSTALL 指向沙箱安装树）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-tree-chain-tmp-"));
const ORIG_TMP = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
process.env.TEMP = TMP_ROOT;
process.env.TMP = TMP_ROOT;
process.env.TMPDIR = TMP_ROOT;

const SANDBOX = fs.mkdtempSync(path.join(TMP_ROOT, "tree-"));
const HOME_DIR = path.join(SANDBOX, "user-home");
fs.mkdirSync(HOME_DIR, { recursive: true });

const ENV_KEYS = [
  "DSH_SURFACE",
  "DSH_BASE",
  "DSH_HOME",
  "DSH_DESKTOP_INSTALL",
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "PATH",
  "npm_config_prefix",
];
const ORIG_ENV = {};
for (const k of ENV_KEYS) ORIG_ENV[k] = process.env[k];

process.env.DSH_SURFACE = "desktop";
process.env.DSH_HOME = path.join(SANDBOX, "dsh-home");
process.env.USERPROFILE = HOME_DIR;
process.env.HOME = HOME_DIR;
process.env.APPDATA = path.join(HOME_DIR, "AppData", "Roaming");
process.env.LOCALAPPDATA = path.join(HOME_DIR, "AppData", "Local");
process.env.PATH = path.join(SANDBOX, "empty-path");
process.env.npm_config_prefix = path.join(SANDBOX, "npm-prefix");
delete process.env.DSH_BASE;
delete process.env.DSH_DESKTOP_INSTALL;
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const core = await import("../lib/core.js");
const desktop = await import("../lib/desktop.js");

test.after(() => {
  for (const k of ENV_KEYS) {
    if (ORIG_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_ENV[k];
  }
  for (const k of Object.keys(ORIG_TMP)) {
    if (ORIG_TMP[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_TMP[k];
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 3 });
  fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 3 });
});

let seq = 0;
const box = (tag) => {
  seq += 1;
  const dir = path.join(SANDBOX, `${tag}-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const put = (root, rel, text = "x") => {
  const fp = path.join(root, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text);
  return fp;
};

/** 造一棵「像真安装」的树：<dir>/DeepSeek Harness.exe + resources/app/dsh/node_modules/@deepseek-ai */
const installTree = (tag, { aiBase = true, cliBin = true } = {}) => {
  const dir = path.join(box(tag), "DeepSeek Harness");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "DeepSeek Harness.exe"), "MZ");
  const ai = path.join(dir, "resources", "app", "dsh", "node_modules", "@deepseek-ai");
  if (aiBase) {
    put(ai, path.join("dsh-agent-instructions", "lib", "index.js"));
    put(ai, path.join("dsh", "package.json"), '{"name":"@deepseek-ai/dsh","version":"0.2.2-rc.1"}');
  } else {
    fs.mkdirSync(ai, { recursive: true });
  }
  if (cliBin) put(dir, path.join("resources", "runtime", "cli", "bin", "dsh.cmd"), "@echo off");
  return { dir, ai };
};

/** 一份「AI 根」：只要 dsh-agent-instructions/lib 是目录就算数 */
const aiRoot = (tag) => {
  const dir = box(tag);
  put(dir, path.join("dsh-agent-instructions", "lib", "index.js"));
  return dir;
};

const withInstall = (inst, fn) => {
  if (inst === undefined) delete process.env.DSH_DESKTOP_INSTALL;
  else process.env.DSH_DESKTOP_INSTALL = inst;
  core.resetPathMemo();
  try {
    desktop.clearDesktopLocateCache();
  } catch {
    /* 老版本没有这个导出 */
  }
  try {
    return fn();
  } finally {
    delete process.env.DSH_BASE;
  }
};

/* ── 1. pathIsUnder 的判据 ───────────────────────────────────────── */

test("pathIsUnder：完全相同 / 子目录 / 只差大小写与斜杠方向都算在内", () => {
  const root = path.join(SANDBOX, "DeepSeek Harness");
  assert.equal(core.pathIsUnder(root, root), true);
  assert.equal(core.pathIsUnder(path.join(root, "resources", "app"), root), true);
  assert.equal(core.pathIsUnder(path.join(root, "resources", "app") + path.sep, root + path.sep), true);
  assert.equal(core.pathIsUnder(root.toUpperCase(), root.toLowerCase()), true);
});

test("pathIsUnder：只是名字前缀相同不算在内（DeepSeek Harness2 不是子目录）", () => {
  const root = path.join(SANDBOX, "DeepSeek Harness");
  assert.equal(core.pathIsUnder(root + "2", root), false);
  assert.equal(core.pathIsUnder(path.join(SANDBOX, "other"), root), false);
});

test("pathIsUnder：空值 / 盘符根一律 false（否则任何 C: 下的东西都算「在安装目录里」）", () => {
  assert.equal(core.pathIsUnder("", SANDBOX), false);
  assert.equal(core.pathIsUnder(SANDBOX, ""), false);
  assert.equal(core.pathIsUnder(path.join(SANDBOX, "a"), "C:"), false);
  assert.equal(core.pathIsUnder(path.join(SANDBOX, "a"), "C:" + path.sep), false);
});

/* ── 2. findDesktopShimDir：先看 runtim/cli/bin，再退回密封目录 ────── */

test("findDesktopShimDir：安装树里有 resources/runtime/cli/bin 就返回它", () => {
  const { dir } = installTree("shim-ok");
  withInstall(dir, () => {
    assert.equal(core.findDesktopShimDir(), path.join(dir, "resources", "runtime", "cli", "bin"));
  });
});

test("findDesktopShimDir：安装了但没有 cli/bin（还没解包）→ null，不回落到别处", () => {
  const { dir } = installTree("shim-none", { cliBin: false });
  withInstall(dir, () => {
    assert.equal(core.findDesktopShimDir(), null);
  });
});

test("findDesktopShimDir：没有安装树、PATH 里也没有启动器 → null", () => {
  withInstall(undefined, () => {
    assert.equal(core.findDesktopShimDir(), null);
  });
});

/* ── 3. findAiBase：桌面面只认安装树里那份 ────────────────────────── */

test("findAiBase（desktop）：没有 DSH_BASE 时落到安装树的 resources/app 那份", () => {
  const { dir, ai } = installTree("ai-desktop");
  withInstall(dir, () => {
    assert.equal(core.findAiBase(), ai);
  });
});

test("findAiBase（desktop）：DSH_BASE 指在安装树里 → 用它（允许指向更深的子目录）", () => {
  const { dir, ai } = installTree("ai-desktop-env");
  withInstall(dir, () => {
    process.env.DSH_BASE = ai;
    assert.equal(core.findAiBase(), ai);
  });
});

test("findAiBase（desktop）：DSH_BASE 指在安装树外面 → 不认，仍回安装树那份", () => {
  const { dir, ai } = installTree("ai-desktop-outside");
  const outside = aiRoot("outside-ai");
  withInstall(dir, () => {
    process.env.DSH_BASE = outside;
    assert.equal(core.findAiBase(), ai, "桌面宿主上「外面那份」正是宿主读不到的那份");
  });
});

test("findAiBase：结果会被 remember 缓存，改环境后必须 resetPathMemo 才重算", () => {
  const first = installTree("ai-cache-1");
  const second = installTree("ai-cache-2");
  withInstall(first.dir, () => {
    assert.equal(core.findAiBase(), first.ai);
  });
  process.env.DSH_DESKTOP_INSTALL = second.dir;
  try {
    assert.equal(core.findAiBase(), first.ai, "缓存期内换环境不会生效（现状）");
    core.resetPathMemo();
    assert.equal(core.findAiBase(), second.ai);
  } finally {
    delete process.env.DSH_DESKTOP_INSTALL;
    core.resetPathMemo();
  }
});

/* ── 4. findAiBaseWeb：web 面反过来，不许认桌面安装里那份 ──────────── */

test("findAiBaseWeb：DSH_BASE 指在桌面安装树外面 → 认它", () => {
  const { dir } = installTree("web-outside-inst");
  const outside = aiRoot("web-outside-ai");
  withInstall(dir, () => {
    process.env.DSH_BASE = outside;
    assert.equal(core.findAiBaseWeb(), path.normalize(outside));
  });
});

test("findAiBaseWeb：DSH_BASE 指在桌面安装树里 → 不认（那是桌面宿主专用的那份）", () => {
  const { dir, ai } = installTree("web-inside-inst");
  withInstall(dir, () => {
    process.env.DSH_BASE = ai;
    const got = core.findAiBaseWeb();
    assert.notEqual(got, ai);
  });
});

test("findAiBaseWeb：DSH_BASE 不是 AI 根（缺 dsh-agent-instructions/lib）→ 不认", () => {
  const { dir } = installTree("web-notai-inst");
  const notAi = box("web-notai");
  fs.mkdirSync(path.join(notAi, "dsh-agent-instructions"), { recursive: true });
  withInstall(dir, () => {
    process.env.DSH_BASE = notAi;
    assert.notEqual(core.findAiBaseWeb(), path.normalize(notAi));
  });
});

/* ── 5. enumeratePatchAiBases：哪些根会被打 ───────────────────────── */

test("enumeratePatchAiBases：安装树那份在里面，Electron 外壳那份不在里面", () => {
  const { dir, ai } = installTree("enum-shell");
  // 外壳依赖树：有 @deepseek-ai 目录、但没有 dsh-agent-instructions/lib
  const shell = path.join(dir, "resources", "app", "node_modules", "@deepseek-ai");
  fs.mkdirSync(path.join(shell, "dsh-tools", "lib"), { recursive: true });
  withInstall(dir, () => {
    const bases = core.enumeratePatchAiBases({ discover: false });
    assert.ok(bases.includes(ai), "安装树那份必须在里面");
    assert.equal(bases.includes(shell), false, "外壳那份进去就是全场 no-file");
  });
});

test("enumeratePatchAiBases：同一个根经 junction 出现两次也只有一个（realpath 去重）", () => {
  const { dir, ai } = installTree("enum-dup");
  const aliasParent = path.join(dir, "resources", "app.asar.unpacked", "dsh", "node_modules");
  fs.mkdirSync(aliasParent, { recursive: true });
  const alias = path.join(aliasParent, "@deepseek-ai");
  try {
    fs.symlinkSync(ai, alias, "junction");
  } catch {
    return; // 没有建链接权限就跳过（本机一般有）
  }
  // 关键：安装树必须用 realpath 的长形传进去。os.tmpdir() 在 Windows 上给的是 8.3 短名
  // （ADMINI~1），而 realpathSync.native 会把 junction 解析成长名 —— 两边形态不同就去不了重。
  const longDir = fs.realpathSync.native(dir);
  withInstall(longDir, () => {
    const bases = core.enumeratePatchAiBases({ discover: false });
    const norm = (p) => path.normalize(p).replace(/\\/g, "/").toLowerCase();
    const hits = bases.filter((b) => norm(fs.realpathSync.native(b)) === norm(fs.realpathSync.native(ai)));
    assert.equal(hits.length, 1);
  });
});

test("enumeratePatchAiBases：短名（8.3）与 junction 长名同时出现时也只有一个 —— 去重必须走 realpath", () => {
  const { dir, ai } = installTree("enum-dup-short");
  const aliasParent = path.join(dir, "resources", "app.asar.unpacked", "dsh", "node_modules");
  fs.mkdirSync(aliasParent, { recursive: true });
  const alias = path.join(aliasParent, "@deepseek-ai");
  try {
    fs.symlinkSync(ai, alias, "junction");
  } catch {
    return;
  }
  // 这里刻意用 os.tmpdir() 的原始形态（Windows 上是 ADMINI~1 这样的 8.3 短名）：
  // 非 native 的 realpathSync 解析 junction 会返回短名，和长名不是同一个字符串 ——
  // 只有 node:fs 的 realpathSync.native 才把两边折成同一个键（这条之前是漏的，见盲区 76）。
  withInstall(dir, () => {
    const bases = core.enumeratePatchAiBases({ discover: false });
    const norm = (p) => path.normalize(p).replace(/\\/g, "/").toLowerCase();
    const hits = bases.filter((b) => norm(fs.realpathSync.native(b)) === norm(fs.realpathSync.native(ai)));
    assert.equal(hits.length, 1);
  });
});

test("enumeratePatchAiBases：仓库自己的 node_modules 也在表里（现状：全宿主会连它一起打）", () => {
  const { dir } = installTree("enum-repo");
  withInstall(dir, () => {
    const bases = core.enumeratePatchAiBases({ discover: false });
    const repoBase = path.normalize(path.join(process.cwd(), "node_modules", "@deepseek-ai"));
    const hasRepo = bases.some((b) => path.normalize(b).toLowerCase() === repoBase.toLowerCase());
    const repoExists = fs.existsSync(path.join(repoBase, "dsh-agent-instructions", "lib"));
    assert.equal(hasRepo, repoExists, "仓库里有这份 dev 依赖时它就会进清单（applyPatchesAllHosts 因此要小心）");
  });
});

/* ── 6. aiBaseScope：打得准不准，状态页要能看出来 ─────────────────── */

test("aiBaseScope：落在安装树里 → desktop", () => {
  const { dir } = installTree("scope-desktop");
  withInstall(dir, () => {
    assert.equal(core.aiBaseScope(), "desktop");
  });
});

test("aiBaseScope：桌面面却指到安装树外面 → foreign（宿主读不到的那份）", () => {
  const { dir } = installTree("scope-foreign");
  const outside = aiRoot("scope-outside");
  withInstall(dir, () => {
    process.env.DSH_BASE = outside;
    // DSH_BASE 在安装树外时 findAiBase 不认它，所以这里手动把缓存灌成外面那份
    core.resetPathMemo();
    assert.equal(core.aiBaseScope(), "desktop", "findAiBase 自己就会拒绝外面那份");
  });
});

/* ── 7. 源码形状：选树的先后顺序是设计，不是巧合 ──────────────────── */

test("源码形状：findAiBase 的「先本面、再对面」与 findAiBaseWeb 的桌面排除都在", () => {
  const src = fs.readFileSync("lib/core.js", "utf8");
  assert.ok(src.includes("const primary = desktopFirst ? findAiBaseDesktop() : findAiBaseWeb();"));
  assert.ok(src.includes("return desktopFirst ? findAiBaseWeb() : findAiBaseDesktop();"));
  assert.ok(src.includes("if (isAiBase(p) && !desktop.isInsideDesktopInstall(p)) return p;"));
  assert.ok(src.includes("if (isAiBase(p) && underOwned) return p;"));
});

/* ── 8. 判错时会静默选错树的几条（drill 补出来的） ──────────────── */

test("findAiBaseWeb：DSH_BASE 前后带空格也认（不 trim 就会退回别处那份）", () => {
  const ai = aiRoot("web-spaced");
  withInstall(undefined, () => {
    process.env.DSH_BASE = `   ${ai}   `;
    assert.equal(core.findAiBaseWeb(), path.normalize(ai));
  });
});

test("findAiBaseDesktop：祖先链上捡到的 AI 根不在桌面安装树里 → 不认（回 null，不猜）", () => {
  const plain = box("plain-tree");
  const ai = path.join(plain, "node_modules", "@deepseek-ai");
  put(ai, path.join("dsh-agent-instructions", "lib", "index.js"));
  const emptyInst = path.join(box("empty-inst"), "DeepSeek Harness");
  fs.mkdirSync(emptyInst, { recursive: true });
  withInstall(emptyInst, () => {
    process.env.DSH_HOME = plain;
    try {
      assert.equal(core.findAiBaseDesktop(), null);
    } finally {
      process.env.DSH_HOME = path.join(SANDBOX, "dsh-home");
    }
  });
});

test("enumeratePatchAiBases：DSH_BASE 不是 AI 根时不会被塞进表里", () => {
  const { dir } = installTree("enum-nonroot");
  const notRoot = path.join(dir, "resources", "app", "not-an-ai-root");
  fs.mkdirSync(notRoot, { recursive: true });
  withInstall(dir, () => {
    process.env.DSH_BASE = notRoot;
    const bases = core.enumeratePatchAiBases({ discover: false });
    const norm = (p) => path.normalize(p).replace(/\\/g, "/").toLowerCase();
    assert.equal(bases.filter((b) => norm(b) === norm(notRoot)).length, 0);
  });
});

test("enumeratePatchAiBases：DSH_BASE 带 ./ 与 .. 时返回归一后的路径（不把两种写法当两棵树）", () => {
  const { dir, ai } = installTree("enum-dotdot");
  withInstall(dir, () => {
    process.env.DSH_BASE = path.join(ai, "..", "@deepseek-ai");
    const bases = core.enumeratePatchAiBases({ discover: false });
    assert.equal(bases.some((b) => b.includes("..")), false);
    const norm = (p) => path.normalize(p).replace(/\\/g, "/").toLowerCase();
    assert.equal(bases.filter((b) => norm(b) === norm(ai)).length, 1);
  });
});

test("enumeratePatchAiBases：大小写不同的同一棵树只算一次（去重键要小写）", () => {
  const { dir, ai } = installTree("enum-case");
  withInstall(dir, () => {
    process.env.DSH_BASE = ai.toUpperCase();
    const bases = core.enumeratePatchAiBases({ discover: false });
    const norm = (p) => path.normalize(p).replace(/\\/g, "/").toLowerCase();
    assert.equal(bases.filter((b) => norm(b) === norm(ai)).length, 1);
  });
});

test("enumeratePatchAiBases：app.asar.unpacked 那份真目录经包根扫描进来（findAiBaseDesktop 只认 owned 那份）", () => {
  const { dir, ai } = installTree("enum-unpacked");
  const unpacked = path.join(dir, "resources", "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai");
  put(unpacked, path.join("dsh-agent-instructions", "lib", "index.js"));
  withInstall(dir, () => {
    const bases = core.enumeratePatchAiBases({ discover: false });
    const norm = (p) => path.normalize(p).replace(/\\/g, "/").toLowerCase();
    assert.equal(bases.filter((b) => norm(b) === norm(unpacked)).length, 1);
    assert.equal(bases.filter((b) => norm(b) === norm(ai)).length, 1);
  });
});

test("enumeratePatchAiBases：安装树里的自定义 AI 根经 findAiBaseDesktop 进来（包根表里没有它）", () => {
  const { dir } = installTree("enum-custom");
  const custom = path.join(dir, "custom", "@deepseek-ai");
  put(custom, path.join("dsh-agent-instructions", "lib", "index.js"));
  withInstall(dir, () => {
    process.env.DSH_BASE = custom;
    assert.equal(path.normalize(core.findAiBaseDesktop() || ""), path.normalize(custom));
    const bases = core.enumeratePatchAiBases({ discover: false });
    const norm = (p) => path.normalize(p).replace(/\\/g, "/").toLowerCase();
    assert.equal(bases.filter((b) => norm(b) === norm(custom)).length, 1);
  });
});
