/**
 * 卸载链路的边角守卫。
 *
 * `lib/uninstall.js` 是「卸载」唯一入口，之前只有 self-update 与 exact-routes 拿桩碰过
 * `uninstallPurge`，没有一份测试直接调它。本文件钉四类东西：
 *   1. `wasApplied` 的六条判据（决定「要不要报 reverted」）；
 *   2. 三个纯函数：`shouldDeletePluginTree` / `stripPluginFromPackage` / `listInstalledProfiles`
 *      —— 它们决定「删哪棵树」「从 profile 里摘掉什么」；
 *   3. `uninstallPurge` 的四条早退与六处「失败只记一笔、继续往下走」；
 *   4. `scheduleCleanupRestart` 只是转发，不自己实现。
 *
 * 纪律：`DSH_BASE` 必须指向一个**存在**的假宿主树。指到不存在的路径时 `findAiBase()` 会退到
 * 本仓库自己的 `node_modules/@deepseek-ai`，`revertAll` 会去遍历真实依赖树（本文件第一条
 * 用例就是盯这件事的：报告里不许出现本仓库路径）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = fs.realpathSync.native(path.join(import.meta.dirname, ".."));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-uninstall-purge-"));
const KEEP = [
  "TEMP", "TMP", "TMPDIR",
  "DSH_HOME", "DSH_BASE", "DSH_SURFACE",
  "npm_config_prefix", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "PATH",
];
const ORIG = Object.fromEntries(KEEP.map((k) => [k, process.env[k]]));

const mk = (p) => fs.mkdirSync(p, { recursive: true });
const put = (fp, text) => {
  mk(path.dirname(fp));
  fs.writeFileSync(fp, text);
};
const norm = (p) => path.resolve(String(p)).toLowerCase();
const inside = (list, fp) => list.some((x) => norm(x) === norm(fp));

const core = await import("../lib/core.js");
const un = await import("../lib/uninstall.js");

let seq = 0;
/**
 * 造一棵独立沙箱：假宿主树 + 空 $DSH_HOME + 空 npm 前缀，并把所有会摸到真机的 env 指进来。
 * 返回的 `idx` 是那棵树里的一个宿主文件，用来验证「回退真的动了这个文件」。
 */
function sandbox(tag) {
  const root = path.join(ROOT, `${tag}-${++seq}`);
  const home = path.join(root, "home");
  const ai = path.join(root, "ai-root", "node_modules", "@deepseek-ai");
  const npm = path.join(root, "npm-prefix");
  const up = path.join(root, "userprofile");
  mk(home);
  mk(npm);
  mk(up);
  mk(path.join(root, "appdata"));
  mk(path.join(root, "localappdata"));
  mk(path.join(ai, "dsh-agent-instructions", "lib"));
  const idx = path.join(ai, "dsh-agent-instructions", "lib", "index.js");
  fs.writeFileSync(idx, "// head\nconst a = 1;\n// tail\n");
  Object.assign(process.env, {
    TEMP: root,
    TMP: root,
    TMPDIR: root,
    DSH_HOME: home,
    DSH_BASE: ai,
    DSH_SURFACE: "web",
    npm_config_prefix: npm,
    USERPROFILE: up,
    HOME: up,
    APPDATA: path.join(root, "appdata"),
    LOCALAPPDATA: path.join(root, "localappdata"),
    PATH: `${npm}${path.delimiter}${path.dirname(process.execPath)}`,
  });
  // findAiBase/findDshHome/findShimDir 都有记忆化：不重置的话第二套沙箱会继续用第一套的路径，
  // 于是一个本该 applied 的用例会读到 applied:false。
  core.resetPathMemo();
  return { root, home, ai, npm, up, idx };
}

test.after(() => {
  for (const k of KEEP) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
});

// ── wasApplied ───────────────────────────────────────────────────────────────

test("wasApplied：没有状态、空状态、计数为零都不算「装过」", () => {
  assert.equal(un.wasApplied(null), false);
  assert.equal(un.wasApplied(undefined), false);
  assert.equal(un.wasApplied({}), false);
  assert.equal(un.wasApplied({ patches_applied: 0 }), false);
  assert.equal(un.wasApplied({ shim_cmd: "missing" }), false);
});

test("wasApplied：有备份、补丁数大于零、任一启动器 patched 都算", () => {
  assert.equal(un.wasApplied({ has_backup: true }), true);
  assert.equal(un.wasApplied({ patches_applied: 3 }), true);
  assert.equal(un.wasApplied({ patches_applied: "1" }), true);
  assert.equal(un.wasApplied({ shim_cmd: "patched" }), true);
  assert.equal(un.wasApplied({ shim_ps1: "patched" }), true);
  assert.equal(un.wasApplied({ shim_bin: "patched" }), true);
});

// ── shouldDeletePluginTree ───────────────────────────────────────────────────

test("shouldDeletePluginTree：只认 /node_modules/dsh-purge 这一段，不按末段名字猜", () => {
  const s = sandbox("del-tree");
  assert.equal(un.shouldDeletePluginTree(path.join(s.root, "p", "node_modules", "dsh-purge")), true);
  // 用户源码仓库末段也叫 dsh-purge，但不该被卸载删掉
  assert.equal(un.shouldDeletePluginTree(path.join(s.root, "src", "dsh-purge-maintained")), false);
  assert.equal(un.shouldDeletePluginTree(path.join(s.root, "src", "dsh-purge")), false);
});

test("shouldDeletePluginTree：空值返回 false，反斜杠与大小写都能认出来", () => {
  assert.equal(un.shouldDeletePluginTree(""), false);
  assert.equal(un.shouldDeletePluginTree(null), false);
  assert.equal(un.shouldDeletePluginTree(undefined), false);
  assert.equal(un.shouldDeletePluginTree("C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\DSH-PURGE"), true);
});

test("shouldDeletePluginTree：它自己不拦 resources —— 那道闸在 collectCleanupDirs 里", () => {
  // 写清这个分工：判据只看路径片段，所以 resources 下的同名目录也会返回 true；
  // 真正防止「删掉 resources/runtime」的是 remember() 里那条 /resources 过滤。
  assert.equal(
    un.shouldDeletePluginTree("C:/Program Files/DeepSeek Harness/resources/app/node_modules/dsh-purge"),
    true,
  );
});

// ── stripPluginFromPackage ───────────────────────────────────────────────────

test("stripPluginFromPackage：非对象返回 false，且不抛", () => {
  assert.equal(un.stripPluginFromPackage(null), false);
  assert.equal(un.stripPluginFromPackage(undefined), false);
  assert.equal(un.stripPluginFromPackage("x"), false);
});

test("stripPluginFromPackage：四个依赖字段全部清掉", () => {
  const pkg = {
    dependencies: { "dsh-purge": "1", other: "2" },
    devDependencies: { "dsh-purge": "1" },
    optionalDependencies: { "dsh-purge": "1" },
    peerDependencies: { "dsh-purge": "1" },
  };
  assert.equal(un.stripPluginFromPackage(pkg), true);
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(Object.hasOwn(pkg[key], "dsh-purge"), false, key);
  }
  // 只删目标键，兄弟键留着
  assert.deepEqual(pkg.dependencies, { other: "2" });
});

test("stripPluginFromPackage：bundles/plugins 认字符串、带版本号与 {id|name} 对象三种写法", () => {
  const pkg = {
    bundles: ["dsh-purge@1.0.0", "keep-a", { id: "dsh-purge" }, { name: "dsh-purge" }, { id: "keep-b" }, 42],
  };
  assert.equal(un.stripPluginFromPackage(pkg), true);
  assert.deepEqual(pkg.bundles, ["keep-a", { id: "keep-b" }, 42]);
});

test("stripPluginFromPackage：顶层与 pkg.dsh.profile 嵌套两层都要清", () => {
  const pkg = {
    plugins: ["dsh-purge"],
    dsh: { profile: { bundles: ["dsh-purge@2"], plugins: [{ id: "dsh-purge" }, "keep"] } },
  };
  assert.equal(un.stripPluginFromPackage(pkg), true);
  assert.deepEqual(pkg.plugins, []);
  assert.deepEqual(pkg.dsh.profile.bundles, []);
  assert.deepEqual(pkg.dsh.profile.plugins, ["keep"]);
});

test("stripPluginFromPackage：没有可删的东西返回 false，空数组也不算改动", () => {
  const pkg = { dependencies: { other: "1" }, bundles: ["keep"], plugins: [] };
  const snapshot = JSON.stringify(pkg);
  assert.equal(un.stripPluginFromPackage(pkg), false);
  assert.equal(JSON.stringify(pkg), snapshot);
});

// ── listInstalledProfiles ────────────────────────────────────────────────────

test("listInstalledProfiles：三条识别路径（bundles 数组、嵌套 plugins、只有 node_modules/dsh-purge）都算", () => {
  const s = sandbox("list-profiles");
  const prof = path.join(s.home, "profiles");
  put(path.join(prof, "p-bundles", "package.json"), JSON.stringify({ bundles: ["dsh-purge@1.2.3"] }));
  put(path.join(prof, "p-nested", "package.json"), JSON.stringify({ dsh: { profile: { plugins: [{ id: "dsh-purge" }] } } }));
  mk(path.join(prof, "p-module", "node_modules", "dsh-purge"));
  put(path.join(prof, "p-devmode", "package.json"), JSON.stringify({ devDependencies: { "dsh-purge": "file:../x" } }));
  put(path.join(prof, "p-none", "package.json"), JSON.stringify({ dependencies: { other: "1" } }));

  const rows = un.listInstalledProfiles(s.home);
  assert.deepEqual(rows.map((r) => r.name), ["p-bundles", "p-devmode", "p-module", "p-nested"]);
  assert.equal(rows.find((r) => r.name === "p-module").hasModule, true);
  assert.equal(rows.find((r) => r.name === "p-module").spec, "");
  assert.equal(rows.find((r) => r.name === "p-devmode").spec, "file:../x");
});

test("listInstalledProfiles：坏 JSON 当没写，profiles 根本不是目录时返回空表", () => {
  const s = sandbox("list-broken");
  put(path.join(s.home, "profiles", "p-bad", "package.json"), "{oops");
  assert.deepEqual(un.listInstalledProfiles(s.home), []);

  const s2 = sandbox("list-notdir");
  put(path.join(s2.home, "profiles"), "not a dir");
  assert.deepEqual(un.listInstalledProfiles(s2.home), []);
  // 目录根本不存在
  assert.deepEqual(un.listInstalledProfiles(path.join(s2.root, "nope")), []);
});

// ── uninstallPurge：正常路径 ─────────────────────────────────────────────────

test("uninstallPurge：六个阶段按序回调，done 一定排在最后", async () => {
  const s = sandbox("stages");
  const stages = [];
  const report = await un.uninstallPurge({ onStage: (x) => stages.push(x) });
  assert.deepEqual(stages, ["locate", "revert", "shim", "flash", "cleanup", "done"]);
  assert.equal(report.ok, true);
  assert.equal(report.needRestart, true);
  // 沙箱里没装过：applied 只可能因为宿主树的 patchStatus 认出来的补丁数
  assert.equal(typeof report.applied, "boolean");
  assert.ok(Array.isArray(report.patches.reverted));
});

test("uninstallPurge：绝不去遍历本仓库自己的 node_modules", async () => {
  const s = sandbox("no-repo-bleed");
  const report = await un.uninstallPurge({});
  const all = [
    ...(report.patches?.reverted || []),
    ...(report.patches?.skipped || []),
    ...(report.patches?.preservedUser || []),
  ];
  const leaked = all.filter((fp) => norm(fp).startsWith(`${norm(REPO)}${path.sep}`));
  assert.deepEqual(leaked, [], "DSH_BASE 失效时会退到本仓库依赖树，这行会红");
  assert.equal(norm(report.patches.skipped[0] || "").startsWith(norm(s.ai)), true);
});

test("uninstallPurge：有 .dshpurge.bak 时真的回退，且备份用完就删", async () => {
  const s = sandbox("revert-ok");
  put(`${s.idx}.dshpurge.bak`, "// ORIGINAL\n");
  put(s.idx, "// head\nconst a = 1; /* [dsh-purge] */\n// tail\n");
  const report = await un.uninstallPurge({});
  assert.equal(report.ok, true);
  assert.equal(report.reverted, true);
  assert.equal(fs.readFileSync(s.idx, "utf8"), "// ORIGINAL\n");
  assert.equal(fs.existsSync(`${s.idx}.dshpurge.bak`), false);
  assert.equal(inside(report.patches.reverted, s.idx), true);
});

test("uninstallPurge：启动器被改过时 shim 段真的回退，并把 reverted 置 true", async () => {
  const s = sandbox("shim-revert");
  put(path.join(s.npm, "dsh.cmd"), "@ECHO off\nrem [dsh-purge] cli entry begin\nrem [dsh-purge] cli entry end\n");
  put(path.join(s.npm, "dsh.cmd.dshpurge.bak"), "@ECHO off\n");
  const report = await un.uninstallPurge({});
  assert.equal(report.ok, true);
  assert.deepEqual(report.shim[s.npm], { "dsh.cmd": "reverted", "dsh.ps1": "missing", dsh: "missing" });
  assert.equal(fs.readFileSync(path.join(s.npm, "dsh.cmd"), "utf8"), "@ECHO off\n");
});

test("uninstallPurge：prompt-inject.md 与 rules 目录一起被清掉", async () => {
  const s = sandbox("override-rules");
  put(path.join(s.home, "prompt-inject.md"), "MY PROMPT\n");
  put(path.join(s.home, "rules", "r1.md"), "RULE\n");
  const report = await un.uninstallPurge({});
  assert.deepEqual(report.override, { path: path.join(s.home, "prompt-inject.md"), removed: true });
  assert.equal(fs.existsSync(path.join(s.home, "prompt-inject.md")), false);
  assert.equal(report.rules.rules_dir_removed, true);
  assert.equal(fs.existsSync(path.join(s.home, "rules")), false);
});

// ── uninstallPurge：四条早退 ─────────────────────────────────────────────────

test("uninstallPurge：0 字节备份是上次中断的占位 → ok:false 且不再清理，备份改名留证", async () => {
  const s = sandbox("empty-bak");
  put(`${s.idx}.dshpurge.bak`, "");
  const report = await un.uninstallPurge({});
  assert.equal(report.ok, false);
  assert.equal(report.needRestart, false);
  assert.deepEqual(report.cleanup, []);
  // 注意 errors 是空的：这条早退靠 patches.errors 触发，不是靠 errors
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.patches.errors, [[s.idx, "empty_backup"]]);
  assert.equal(fs.existsSync(`${s.idx}.dshpurge.bak.bad`), true);
});

test("uninstallPurge：profile 写盘失败 → ok:false、不排重启、不清理、不算清过演练授权", async () => {
  const s = sandbox("profile-write-fail");
  const prof = path.join(s.home, "profiles", "p1");
  put(path.join(prof, "package.json"), JSON.stringify({ dependencies: { "dsh-purge": "1.0.0" } }));
  const origRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("rename boom");
  };
  let report;
  try {
    report = await un.uninstallPurge({});
  } finally {
    fs.renameSync = origRename;
  }
  assert.equal(report.ok, false);
  assert.equal(report.needRestart, false);
  assert.deepEqual(report.cleanup, []);
  assert.equal(report.drillGrantCleared, false);
  assert.deepEqual(report.profiles, ["p1"]);
  assert.deepEqual(report.stripped, []);
  assert.deepEqual(report.errors, ["p1: rename boom"]);
  // 写失败时用户的 package.json 一个字节都不能动
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(prof, "package.json"), "utf8")), {
    dependencies: { "dsh-purge": "1.0.0" },
  });
});

test("uninstallPurge：清演练授权失败 → ok:false 且 cleanup 清空", async () => {
  const s = sandbox("drill-fail");
  // 把授权文件做成目录：unlinkSync 对目录在 Windows 是 EPERM、POSIX 是 EISDIR，两边都抛，
  // 正好走 clearDrillGrant 的「删不掉就往上抛」这条路。
  mk(path.join(s.home, "dsh-purge", "drill-grant.json"));
  const report = await un.uninstallPurge({});
  assert.equal(report.ok, false);
  assert.equal(report.needRestart, false);
  assert.deepEqual(report.cleanup, []);
  assert.equal(report.drillGrantCleared, undefined);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /^clear drill grant: /);
});

test("uninstallPurge：清演练授权成功 → drillGrantCleared 为 true", async () => {
  const s = sandbox("drill-ok");
  put(path.join(s.home, "dsh-purge", "drill-grant.json"), JSON.stringify({ granted: true }));
  const report = await un.uninstallPurge({});
  assert.equal(report.ok, true);
  assert.equal(report.drillGrantCleared, true);
  assert.equal(fs.existsSync(path.join(s.home, "dsh-purge", "drill-grant.json")), false);
});

// ── uninstallPurge：六处「失败只记一笔」 ──────────────────────────────────────

test("uninstallPurge：删 override 失败只记一笔，卸载照常往下走（ok 仍为 true）", async () => {
  const s = sandbox("override-dir");
  mk(path.join(s.home, "prompt-inject.md"));
  const report = await un.uninstallPurge({});
  assert.equal(report.override, null);
  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /^remove override: /);
});

test("uninstallPurge：rules 是文件时也算清干净（rm 的 force+recursive 对文件成立）", async () => {
  const s = sandbox("rules-file");
  put(path.join(s.home, "rules"), "not a dir");
  const report = await un.uninstallPurge({});
  assert.equal(report.ok, true);
  assert.equal(report.rules.rules_dir_removed, true);
  assert.deepEqual(report.errors, []);
  assert.equal(fs.existsSync(path.join(s.home, "rules")), false);
});

test("uninstallPurge：profiles 不是目录时当作没装 profile，不报错", async () => {
  const s = sandbox("profiles-file");
  put(path.join(s.home, "profiles"), "not a dir");
  const report = await un.uninstallPurge({});
  assert.equal(report.ok, true);
  assert.deepEqual(report.profiles, []);
  assert.deepEqual(report.stripped, []);
  assert.deepEqual(report.errors, []);
});

test("uninstallPurge：npm link 装的插件，清单只记链接本身，源码目录永不进清理列表", async () => {
  const s = sandbox("npm-link");
  const src = path.join(s.root, "src", "dsh-purge-maintained");
  put(path.join(src, "package.json"), '{"name":"dsh-purge"}');
  const prof = path.join(s.home, "profiles", "p-link");
  put(path.join(prof, "package.json"), JSON.stringify({ dependencies: { "dsh-purge": "link:../../src/dsh-purge-maintained" } }));
  mk(path.join(prof, "node_modules"));
  const link = path.join(prof, "node_modules", "dsh-purge");
  fs.symlinkSync(src, link, "junction");

  const report = await un.uninstallPurge({});
  assert.equal(report.ok, true);
  assert.deepEqual(report.stripped, ["p-link"]);
  // 1.1.94 的老毛病：这一步记的是链接的 realpath，也就是用户的源码目录，
  // 重启助手再递归删一次就把源码整棵吃掉。现在只记链接本身。
  assert.equal(inside(report.cleanup, link), true);
  assert.equal(inside(report.cleanup, src), false, report.cleanup.join(" | "));
  assert.equal(inside(report.cleanup, path.join(s.home, "dsh-purge")), true);
  assert.equal(fs.existsSync(path.join(src, "package.json")), true);
});

test("源码形状：两份 rmTree 的「插件树」判据都必须要求 dsh-purge 是完整路径段", () => {
  // 两个重启助手都是顶层 await 的独立进程脚本，无法 import；这里钉死那句正则与它的用法。
  for (const rel of ["lib/uninstall-restart.js", "lib/restart-desktop.js"]) {
    const raw = fs.readFileSync(path.join(REPO, rel), "utf8").split("\r\n").join("\n");
    // 只看代码行：解释老写法的注释里本来就会出现那句子串。
    const src = raw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.equal(
      src.includes("const OWN_TREE = /\\/(?:node_modules\\/)?dsh-purge(?:\\/|$)/;"),
      true,
      `${rel} 缺 OWN_TREE 判据`,
    );
    // 老写法会把 …/src/dsh-purge-maintained 当成插件树
    assert.equal(src.includes('n.includes("/dsh-purge")'), false, `${rel} 还留着过宽的子串判据`);
    assert.equal(src.includes('n.includes("/node_modules/dsh-purge")'), false, `${rel} 还留着过宽的子串判据`);
    assert.match(src, /OWN_TREE\.test\(n\)/);
  }
});

// ── 三条只有造出特定 fixture 才看得见的判据 ─────────────────────────────────

test("stripPluginFromPackage：bundles 是标量时原样留着，不当数组去过滤", () => {
  // `bundles: "dsh-purge"` 是坏清单（本该是数组）。原实现走「不是数组就原样返回」那条，
  // 如果改成只判 null/undefined，接下来会对字符串调 .filter 直接抛。
  const pkg = { bundles: "dsh-purge" };
  assert.equal(un.stripPluginFromPackage(pkg), false);
  assert.equal(pkg.bundles, "dsh-purge");
});

test("listInstalledProfiles：profiles 目录读不出来时返回空表而不是抛", () => {
  const s = sandbox("readdir-throw");
  mk(path.join(s.home, "profiles"));
  const orig = fs.readdirSync;
  fs.readdirSync = (target, ...rest) => {
    if (norm(target) === norm(path.join(s.home, "profiles"))) throw new Error("readdir boom");
    return orig(target, ...rest);
  };
  try {
    assert.deepEqual(un.listInstalledProfiles(s.home), []);
  } finally {
    fs.readdirSync = orig;
  }
});

test("uninstallPurge：插件目录的 realpath 落进安装树的 resources 里 → 那条不进清理列表", async () => {
  const s = sandbox("resources-gate");
  // 造一个「插件目录其实是 junction，指向安装树里那个同名目录」的现场：
  // remember() 记的是 realpath，也就是 resources 下面的路径，必须被 /resources 那道闸拦住。
  const res = path.join(s.root, "desktop", "resources", "app", "node_modules", "dsh-purge");
  put(path.join(res, "package.json"), '{"name":"dsh-purge"}');
  const prof = path.join(s.home, "profiles", "p-res");
  put(path.join(prof, "package.json"), JSON.stringify({ dependencies: { "dsh-purge": "1.0.0" } }));
  mk(path.join(prof, "node_modules"));
  const link = path.join(prof, "node_modules", "dsh-purge");
  fs.symlinkSync(res, link, "junction");

  const report = await un.uninstallPurge({});
  assert.equal(report.ok, true);
  assert.equal(inside(report.cleanup, res), false, report.cleanup.join(" | "));
  // 链接本身可以记（rmTree 见符号链接只 unlink 自己），安装树里的目标必须留着
  assert.equal(inside(report.cleanup, link), true, report.cleanup.join(" | "));
  assert.equal(fs.existsSync(path.join(res, "package.json")), true);
});

test("uninstallPurge：两棵 profile 链到同一个目标时，清理列表里那条只出现一次", async () => {
  const s = sandbox("dedupe");
  const target = path.join(s.home, "profiles", "b", "node_modules", "dsh-purge");
  put(path.join(target, "package.json"), '{"name":"dsh-purge"}');
  const profA = path.join(s.home, "profiles", "a");
  put(path.join(profA, "package.json"), JSON.stringify({ dependencies: { "dsh-purge": "1.0.0" } }));
  mk(path.join(profA, "node_modules"));
  fs.symlinkSync(target, path.join(profA, "node_modules", "dsh-purge"), "junction");
  put(path.join(s.home, "profiles", "b", "package.json"), JSON.stringify({ dependencies: { "dsh-purge": "1.0.0" } }));

  const report = await un.uninstallPurge({});
  assert.equal(report.ok, true);
  const hits = report.cleanup.filter((x) => norm(x) === norm(target));
  assert.equal(hits.length, 1, report.cleanup.join(" | "));
});

test("uninstallPurge：数据目录本身是链接时，清理列表记的是它指向的那棵树", async () => {
  const s = sandbox("data-realpath");
  const realData = path.join(s.root, "realdata", "purge");
  put(path.join(realData, "channel.json"), "{}");
  fs.symlinkSync(realData, path.join(s.home, "dsh-purge"), "junction");

  const report = await un.uninstallPurge({});
  assert.equal(report.ok, true);
  assert.equal(inside(report.cleanup, realData), true, report.cleanup.join(" | "));
  assert.equal(inside(report.cleanup, path.join(s.home, "dsh-purge")), false, report.cleanup.join(" | "));
});

test("uninstallPurge：清理列表永不含本仓库，也不含整个 DSH_HOME", async () => {
  const s = sandbox("plugin-root");
  const report = await un.uninstallPurge({});
  assert.equal(inside(report.cleanup, REPO), false, report.cleanup.join(" | "));
  assert.equal(inside(report.cleanup, s.home), false, "清理列表只该有具体目录，不该是整个 DSH_HOME");
});

// ── 源码形状 ─────────────────────────────────────────────────────────────────

test("源码形状：四道早退都设了 ok/needRestart/cleanup 三个字段，scheduleCleanupRestart 只是转发", () => {
  const src = fs.readFileSync(path.join(REPO, "lib", "uninstall.js"), "utf8");
  // 三条早退（revert / unregister / drill grant）：都要把「别排重启、别清理」说全
  assert.equal(src.split("report.needRestart = false;").length - 1 >= 3, true);
  assert.equal(src.split("report.cleanup = [];").length - 1 >= 3, true);
  // drill grant 那条是唯一会写 drillGrantCleared 的早退
  assert.equal(src.includes("report.drillGrantCleared = false;"), true);
  // 转发而不是自己实现
  assert.match(fs.readFileSync(path.join(REPO, "lib", "uninstall.js"), "utf8"), /hostctl\.scheduleCleanupRestart\(opts\);/);
});
