// 备份 / 还原这个底座簇：backupAll、restoreFromBak、revertAll、revertShim、revertAllShims，
// 以及它们依赖的 restoreMissingOriginalsFromBak / refreshStaleBaksForUpgrade / atomicCopyFileSync。
//
// 这一簇是「所有改动可回退」承诺的唯一底座。它坏了的两种表现都不报错：
//   ① bak 建错（把已打补丁的版本当原件存下来）→ 用户永远回不到官方原版；
//   ② 0 字节占位 bak 被当成有效备份 → revert 把宿主文件清空。
// 所以这里的断言全部落在「磁盘上的字节」和「返回数组的条数」上，不看形状。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const core = await import("../lib/core.js");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-bak-"));
const ORIG_ENV = {
  DSH_HOME: process.env.DSH_HOME,
  DSH_SURFACE: process.env.DSH_SURFACE,
  DSH_BASE: process.env.DSH_BASE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  PATH: process.env.PATH,
  npm_config_prefix: process.env.npm_config_prefix,
};

let seq = 0;
function sandbox(tag) {
  seq += 1;
  const root = path.join(SANDBOX, `${tag}-${seq}`);
  const home = path.join(root, "home");
  const ai = path.join(root, "ai");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ai, { recursive: true });
  process.env.DSH_HOME = home;
  process.env.DSH_SURFACE = "web";
  delete process.env.DSH_BASE;
  process.env.APPDATA = path.join(root, "appdata");
  process.env.LOCALAPPDATA = path.join(root, "localapp");
  process.env.PATH = path.join(root, "plainbin");
  // findNpmPrefix() 在 PATH 上没有启动器时会退到 `npm prefix -g`，那会读到本机真实的
  // %APPDATA%\npm —— 于是 revertAllShims/patchAllShims 会去动用户真实的启动器。
  // 这里的 npm_config_prefix 把那条退路也钉死在沙箱里。
  process.env.npm_config_prefix = path.join(root, "npm-prefix");
  core.resetPathMemo();
  return { root, home, ai };
}

function put(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
  return fp;
}
const read = (fp) => fs.readFileSync(fp, "utf8");
const rel = (base, fp) => fp.replace(base, "");

/** 在最小宿主树上建一份文件（相对 aiBase 的 posix 片段）。 */
function seed(ai, relPath, text) {
  return put(path.join(ai, ...relPath.split("/")), text);
}

test.after(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  core.resetPathMemo();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 纯谓词

test("isWatchedClientBundle 只认 node_modules 里两层包的 lib/client.js，反斜杠先归一", () => {
  assert.equal(core.isWatchedClientBundle("/a/node_modules/@s/p/lib/client.js"), true);
  assert.equal(core.isWatchedClientBundle("\\a\\node_modules\\@s\\p\\lib\\client.js"), true);
  assert.equal(core.isWatchedClientBundle("/a/lib/client.js"), false);
  assert.equal(core.isWatchedClientBundle("/a/node_modules/@s/p/lib/client.jsx"), false);
  assert.equal(core.isWatchedClientBundle(""), false);
});

test("isUserProfilePatchFile 只认 profiles/<name>/cordis.patch.yml，大小写不敏感", () => {
  assert.equal(core.isUserProfilePatchFile("/x/profiles/web/cordis.patch.yml"), true);
  assert.equal(core.isUserProfilePatchFile("/x/PROFILES/Web/cordis.patch.yml"), true);
  assert.equal(core.isUserProfilePatchFile("/x/profiles/web/other.yml"), false);
  assert.equal(core.isUserProfilePatchFile("/x/dsh-base/cordis.patch.yml"), false);
});

// ------------------------------------------------------- atomicCopyFileSync

test("atomicCopyFileSync 建好父目录、内容逐字节一致，且不留 .copytmp", () => {
  const sb = sandbox("atomic");
  const src = put(path.join(sb.root, "src.txt"), "copyme\n");
  const dst = path.join(sb.root, "nested", "deep", "dst.txt");
  core.atomicCopyFileSync(src, dst);
  assert.equal(read(dst), "copyme\n");
  assert.deepEqual(fs.readdirSync(path.dirname(dst)).filter((n) => n.endsWith(".copytmp")), []);
});

test("atomicCopyFileSync 在 rename 失败时清掉临时文件并把错误抛出去", () => {
  const sb = sandbox("atomic-fail");
  const src = put(path.join(sb.root, "src.txt"), "copyme\n");
  const dst = path.join(sb.root, "nested2", "dst.txt");
  const orig = fs.renameSync;
  Object.defineProperty(fs, "renameSync", {
    value: () => {
      throw Object.assign(new Error("renboom"), { code: "EXDEV" });
    },
    writable: true,
    configurable: true,
  });
  try {
    assert.throws(() => core.atomicCopyFileSync(src, dst), /renboom/);
  } finally {
    Object.defineProperty(fs, "renameSync", { value: orig, writable: true, configurable: true });
  }
  assert.deepEqual(fs.readdirSync(path.dirname(dst)).filter((n) => n.endsWith(".copytmp")), []);
  assert.equal(fs.existsSync(dst), false);
});

// --------------------------------------------------------------- backupAll

test("backupAll 给每个目标文件建一份 bak，内容就是当时的原文", async () => {
  const sb = sandbox("bak-basic");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "ORIG-A\n");
  const b = seed(sb.ai, "dsh-agent-instructions/lib/bootstrap.js", "ORIG-B\n");
  const c = seed(sb.ai, "dsh-web-app/lib/index.js", "ORIG-C\n");

  const result = await core.backupAll(sb.ai);
  assert.equal(result.made.length, 3);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.skippedUser, []);
  assert.equal(result.dropped.length, 0);

  for (const fp of [a, b, c]) {
    assert.equal(read(fp + ".dshpurge.bak"), read(fp));
  }
});

test("backupAll 第二次跑不覆盖已有 bak（EEXIST 直接跳过，不算失败）", async () => {
  const sb = sandbox("bak-again");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "ORIG-A\n");
  await core.backupAll(sb.ai);
  put(a, "PATCHED-A\n");

  const again = await core.backupAll(sb.ai);
  assert.deepEqual(again.made, []);
  assert.deepEqual(again.errors, []);
  assert.equal(read(a + ".dshpurge.bak"), "ORIG-A\n", "旧 bak 必须留着，它是唯一的原文");
});

test("backupAll 遇到「目录冒充 bak」按已存在跳过，既不报错也不删除", async () => {
  const sb = sandbox("bak-dir");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "ORIG-A\n");
  fs.mkdirSync(a + ".dshpurge.bak", { recursive: true });

  const result = await core.backupAll(sb.ai);
  assert.deepEqual(result.made, []);
  assert.deepEqual(result.errors, []);
  assert.equal(fs.statSync(a + ".dshpurge.bak").isDirectory(), true);
});

test("backupAll 建占位文件失败（非 EEXIST）时记进 errors 且不中断其它文件", async () => {
  const sb = sandbox("bak-openErr");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "ORIG-A\n");
  const b = seed(sb.ai, "dsh-web-app/lib/index.js", "ORIG-B\n");
  const orig = fs.openSync;
  Object.defineProperty(fs, "openSync", {
    value: (target, ...rest) => {
      if (String(target) === a + ".dshpurge.bak") {
        throw Object.assign(new Error("boom"), { code: "EPERM" });
      }
      return orig(target, ...rest);
    },
    writable: true,
    configurable: true,
  });
  let result;
  try {
    result = await core.backupAll(sb.ai);
  } finally {
    Object.defineProperty(fs, "openSync", { value: orig, writable: true, configurable: true });
  }
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0][1], /boom/);
  assert.equal(result.errors[0][0], a);
  assert.equal(fs.existsSync(b + ".dshpurge.bak"), true, "其它文件照常备份");
});

test("backupAll 复制失败时把自己刚建的 0 字节占位删掉，不留假备份", async () => {
  const sb = sandbox("bak-copyErr");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "ORIG-A\n");
  const fsp = fs.promises;
  const orig = fsp.copyFile;
  Object.defineProperty(fsp, "copyFile", {
    value: async () => {
      throw Object.assign(new Error("copyboom"), { code: "EACCES" });
    },
    writable: true,
    configurable: true,
  });
  let result;
  try {
    result = await core.backupAll(sb.ai);
  } finally {
    Object.defineProperty(fsp, "copyFile", { value: orig, writable: true, configurable: true });
  }
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0][1], /copyboom/);
  assert.equal(fs.existsSync(a + ".dshpurge.bak"), false, "0 字节占位必须清掉，否则下次 revert 会把文件清空");
});

test("backupAll 顺手清掉 profiles/<name>/cordis.patch.yml 的陈旧备份", async () => {
  const sb = sandbox("bak-drop");
  seed(sb.ai, "dsh-agent-instructions/lib/index.js", "ORIG\n");
  const stale = put(path.join(sb.home, "profiles", "web", "cordis.patch.yml.dshpurge.bak"), "old\n");
  fs.mkdirSync(path.join(sb.home, "profiles", "desktop"), { recursive: true });

  const result = await core.backupAll(sb.ai);
  assert.deepEqual(result.dropped, [stale]);
  assert.equal(fs.existsSync(stale), false);
});

// ------------------------------------------ dropStaleUserProfilePatchBackups

test("dropStaleUserProfilePatchBackups 没有 profiles 目录时回空数组，不抛错", async () => {
  const sb = sandbox("drop-none");
  assert.deepEqual(await core.dropStaleUserProfilePatchBackups(sb.home), []);
  assert.deepEqual(await core.dropStaleUserProfilePatchBackups(path.join(sb.root, "nope")), []);
});

test("dropStaleUserProfilePatchBackups 只删 bak，用户手写的 cordis.patch.yml 动都不动", async () => {
  const sb = sandbox("drop-keep");
  const user = put(path.join(sb.home, "profiles", "web", "cordis.patch.yml"), "insert!\n");
  const stale = put(path.join(sb.home, "profiles", "web", "cordis.patch.yml.dshpurge.bak"), "old\n");

  assert.deepEqual(await core.dropStaleUserProfilePatchBackups(sb.home), [stale]);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(read(user), "insert!\n");
});

// ------------------------------------- restoreMissingOriginalsFromBak

test("restoreMissingOriginalsFromBak 把被删掉的原文件拷回来，bak 保留", () => {
  const sb = sandbox("restore-deleted");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "ORIG-A\n");
  put(a + ".dshpurge.bak", "ORIG-A\n");
  fs.rmSync(a);

  const restored = core.restoreMissingOriginalsFromBak(sb.ai, { k: a });
  assert.deepEqual(restored, [a]);
  assert.equal(read(a), "ORIG-A\n");
  assert.equal(fs.existsSync(a + ".dshpurge.bak"), true);
});

test("restoreMissingOriginalsFromBak 把 0 字节的原文件也当成缺失", () => {
  const sb = sandbox("restore-zero");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "");
  put(a + ".dshpurge.bak", "ORIG-A\n");

  assert.deepEqual(core.restoreMissingOriginalsFromBak(sb.ai, { k: a }), [a]);
  assert.equal(read(a), "ORIG-A\n");
});

test("restoreMissingOriginalsFromBak 见到非空原文件就住手（那是打过补丁的版本）", () => {
  const sb = sandbox("restore-keep");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "PATCHED\n");
  put(a + ".dshpurge.bak", "ORIG-A\n");

  assert.deepEqual(core.restoreMissingOriginalsFromBak(sb.ai, { k: a }), []);
  assert.equal(read(a), "PATCHED\n");
});

test("restoreMissingOriginalsFromBak 不拿 0 字节 bak 去填任何东西", () => {
  const sb = sandbox("restore-emptybak");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "");
  put(a + ".dshpurge.bak", "");

  assert.deepEqual(core.restoreMissingOriginalsFromBak(sb.ai, { k: a }), []);
  assert.equal(read(a), "");
});

test("restoreMissingOriginalsFromBak 传了 files 就按 files 走，能覆盖扫描根之外的路径", () => {
  const sb = sandbox("restore-files");
  const original = path.join(sb.ai, "weird", "deep", "thing.js");
  put(original + ".dshpurge.bak", "ORIG\n");

  assert.deepEqual(core.restoreMissingOriginalsFromBak(sb.ai, null), [], "扫描根摸不到它");
  assert.deepEqual(core.restoreMissingOriginalsFromBak(sb.ai, { k: original }), [original]);
  assert.equal(read(original), "ORIG\n");
});

test("restoreMissingOriginalsFromBak 扫 dsh-* 包目录，把缺失的 lib/index.js 找回来", () => {
  const sb = sandbox("restore-scan");
  const a = seed(sb.ai, "dsh-thing/lib/index.js", "");
  put(a + ".dshpurge.bak", "ORIG-SCAN\n");

  assert.deepEqual(core.restoreMissingOriginalsFromBak(sb.ai, null), [a]);
  assert.equal(read(a), "ORIG-SCAN\n");
});

test("restoreMissingOriginalsFromBak 永远不碰 profiles/<name>/cordis.patch.yml（用户配置层）", () => {
  const sb = sandbox("restore-profile");
  const user = path.join(sb.ai, "profiles", "web", "cordis.patch.yml");
  put(user + ".dshpurge.bak", "OLD\n");
  fs.rmSync(user, { force: true });

  assert.deepEqual(core.restoreMissingOriginalsFromBak(sb.ai, { k: user }), []);
  assert.equal(fs.existsSync(user), false, "缺了就是缺了，绝不拿 bak 盖回用户配置层");
});

// ------------------------------------------- refreshStaleBaksForUpgrade

test("refreshStaleBaksForUpgrade 把 bak 刷成新版原文（旧 bak 是上一版的，留着会让升级后回滚到旧代码）", () => {
  const sb = sandbox("refresh-basic");
  const a = seed(sb.ai, "dsh-thing/lib/index.js", "NEW VERSION\n");
  put(a + ".dshpurge.bak", "OLD\n");

  assert.deepEqual(core.refreshStaleBaksForUpgrade(sb.ai, { k: a }), [a]);
  assert.equal(read(a + ".dshpurge.bak"), "NEW VERSION\n");
});

test("refreshStaleBaksForUpgrade 见到字节相同的 bak 不动盘", () => {
  const sb = sandbox("refresh-same");
  const a = seed(sb.ai, "dsh-thing/lib/index.js", "SAME\n");
  put(a + ".dshpurge.bak", "SAME\n");
  const before = fs.statSync(a + ".dshpurge.bak").mtimeMs;

  assert.deepEqual(core.refreshStaleBaksForUpgrade(sb.ai, { k: a }), []);
  assert.equal(fs.statSync(a + ".dshpurge.bak").mtimeMs, before);
});

test("refreshStaleBaksForUpgrade 见到已打补丁的原文就跳过（那说明 bak 才是真原文）", () => {
  const sb = sandbox("refresh-patched");
  const a = seed(sb.ai, "dsh-thing/lib/index.js", "// [dsh-purge] something\nbody\n");
  put(a + ".dshpurge.bak", "ORIG\n");

  assert.deepEqual(core.refreshStaleBaksForUpgrade(sb.ai, { k: a }), []);
  assert.equal(read(a + ".dshpurge.bak"), "ORIG\n");
});

test("refreshStaleBaksForUpgrade 见到 0 字节原文不刷（不能拿空文件覆盖 bak）", () => {
  const sb = sandbox("refresh-zero");
  const a = seed(sb.ai, "dsh-thing/lib/index.js", "");
  put(a + ".dshpurge.bak", "ORIG\n");

  assert.deepEqual(core.refreshStaleBaksForUpgrade(sb.ai, { k: a }), []);
  assert.equal(read(a + ".dshpurge.bak"), "ORIG\n");
});

test("refreshStaleBaksForUpgrade 跳过用户配置层与无效 aiBase", () => {
  const sb = sandbox("refresh-profile");
  const user = path.join(sb.ai, "profiles", "web", "cordis.patch.yml");
  put(user, "user insert\n");
  put(user + ".dshpurge.bak", "OLD\n");

  assert.deepEqual(core.refreshStaleBaksForUpgrade(sb.ai, { k: user }), []);
  assert.equal(read(user + ".dshpurge.bak"), "OLD\n");
  assert.deepEqual(core.refreshStaleBaksForUpgrade(null), []);
  assert.deepEqual(core.refreshStaleBaksForUpgrade(path.join(sb.root, "missing")), []);
});

test("refreshStaleBaksForUpgrade 不扫 .git / node_modules 里面的 bak", () => {
  const sb = sandbox("refresh-skip");
  const inGit = put(path.join(sb.ai, ".git", "x", "f.js"), "NEW\n");
  put(inGit + ".dshpurge.bak", "OLD\n");
  const inModules = put(path.join(sb.ai, "dsh-thing", "node_modules", "y", "f.js"), "NEW\n");
  put(inModules + ".dshpurge.bak", "OLD\n");

  assert.deepEqual(core.refreshStaleBaksForUpgrade(sb.ai, null), []);
  assert.equal(read(inGit + ".dshpurge.bak"), "OLD\n");
  assert.equal(read(inModules + ".dshpurge.bak"), "OLD\n");
});

// ---------------------------------------------------------------- revertAll

test("revertAll 把打补丁的文件还原成 bak 里的原文，并删掉 bak", async () => {
  const sb = sandbox("rev-basic");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "PATCHED\n");
  put(a + ".dshpurge.bak", "ORIG\n");
  const untouched = seed(sb.ai, "dsh-web-app/lib/index.js", "NEVER-TOUCHED\n");

  const result = await core.revertAll(sb.ai, {});
  assert.deepEqual(result.reverted, [a]);
  assert.deepEqual(result.skipped, [untouched]);
  assert.deepEqual(result.errors, []);
  assert.equal(read(a), "ORIG\n");
  assert.equal(fs.existsSync(a + ".dshpurge.bak"), false);
});

test("revertAll 见到 0 字节 bak 就把备份改名 .bad 并报 empty_backup，绝不拿它盖回原文", async () => {
  const sb = sandbox("rev-emptybak");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "PATCHED\n");
  put(a + ".dshpurge.bak", "");

  const result = await core.revertAll(sb.ai, {});
  assert.deepEqual(result.errors, [[a, "empty_backup"]]);
  assert.deepEqual(result.reverted, []);
  assert.equal(read(a), "PATCHED\n", "宁可不还原，也不能把宿主文件清空");
  assert.equal(fs.existsSync(a + ".dshpurge.bak"), false);
  assert.equal(read(a + ".dshpurge.bak.bad"), "");
});

test("revertAll 顺手清掉上一轮留下的 .bad 残骸", async () => {
  const sb = sandbox("rev-badclean");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "PATCHED\n");
  put(a + ".dshpurge.bak", "ORIG\n");
  put(a + ".dshpurge.bak.bad", "junk\n");

  await core.revertAll(sb.ai, {});
  assert.equal(fs.existsSync(a + ".dshpurge.bak.bad"), false);
  assert.equal(read(a), "ORIG\n");
});

test("revertAll 在 bak 与原文件字节相同时跳过（不白改 mtime，前端 HMR 靠它判断）", async () => {
  const sb = sandbox("rev-same");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "SAME\n");
  put(a + ".dshpurge.bak", "SAME\n");
  const before = fs.statSync(a).mtimeMs;

  const result = await core.revertAll(sb.ai, {});
  assert.deepEqual(result.skipped, [a]);
  assert.equal(fs.statSync(a).mtimeMs, before);
  assert.equal(fs.existsSync(a + ".dshpurge.bak"), true, "跳过时不删 bak —— 下次还得靠它");
});

test("revertAll 对没有 bak 的现存文件只跳过，绝不删除（源码部署的构建产物缺备份时删了就再也回不来）", async () => {
  const sb = sandbox("rev-nobak");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "BUILD-OUTPUT\n");

  const result = await core.revertAll(sb.ai, {});
  assert.deepEqual(result.skipped, [a]);
  assert.equal(read(a), "BUILD-OUTPUT\n");
});

test("revertAll 带 preserveClientBundles 时不动前端 client.js，只有显式 false 才还原", async () => {
  const sb = sandbox("rev-preserve");
  // isWatchedClientBundle 只认 <...>/node_modules/@scope/pkg/lib/client.js，
  // 所以这份 fixture 必须放在宿主真实的嵌套位置上。
  const cj = seed(sb.ai, "dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js", "patched client\n");
  put(cj + ".dshpurge.bak", "original client\n");

  const kept = await core.revertAll(sb.ai, { preserveClientBundles: true });
  assert.deepEqual(kept.skipped, [cj]);
  assert.equal(read(cj), "patched client\n");
  assert.equal(fs.existsSync(cj + ".dshpurge.bak"), true, "被跳过时 bak 必须留着");

  const done = await core.revertAll(sb.ai, { preserveClientBundles: false });
  assert.deepEqual(done.reverted, [cj]);
  assert.equal(read(cj), "original client\n");
});

test("revertAll 遇到符号链接时写穿到真身，链接本身还在", async () => {
  const sb = sandbox("rev-symlink");
  const real = put(path.join(sb.root, "real.js"), "PATCHED\n");
  const fp = path.join(sb.ai, "dsh-agent-instructions", "lib", "index.js");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp + ".dshpurge.bak", "ORIG\n", "utf8");
  try {
    fs.symlinkSync(real, fp, "file");
  } catch (e) {
    test.skip(`当前账号建不了符号链接：${String(e).slice(0, 60)}`);
    return;
  }

  const result = await core.revertAll(sb.ai, {});
  assert.deepEqual(result.reverted, [fp]);
  assert.equal(read(real), "ORIG\n");
  assert.equal(fs.lstatSync(fp).isSymbolicLink(), true);
});

test("revertAll 在比不了字节时（读失败）照样往下走，把 bak 拷回去", async () => {
  const sb = sandbox("rev-readfail");
  const a = seed(sb.ai, "dsh-agent-instructions/lib/index.js", "PATCHED\n");
  put(a + ".dshpurge.bak", "ORIG\n");
  const fsp = fs.promises;
  const orig = fsp.readFile;
  Object.defineProperty(fsp, "readFile", {
    value: async (target, ...rest) => {
      if (String(target).endsWith(".dshpurge.bak")) throw new Error("boom");
      return orig.call(fsp, target, ...rest);
    },
    writable: true,
    configurable: true,
  });
  let result;
  try {
    result = await core.revertAll(sb.ai, {});
  } finally {
    Object.defineProperty(fsp, "readFile", { value: orig, writable: true, configurable: true });
  }
  assert.deepEqual(result.reverted, [a], "比不了字节就当不同，照常还原");
  assert.equal(read(a), "ORIG\n");
});

test("revertAll 的 dropped 来自 profiles 清扫，第二次跑就是空", async () => {
  const sb = sandbox("rev-dropped");
  seed(sb.ai, "dsh-agent-instructions/lib/index.js", "PATCHED\n");
  put(path.join(sb.home, "profiles", "web", "cordis.patch.yml.dshpurge.bak"), "old\n");

  const first = await core.revertAll(sb.ai, {});
  assert.equal(first.dropped.length, 1);
  const second = await core.revertAll(sb.ai, {});
  assert.deepEqual(second.dropped, []);
});

// ---------------------------------------------------------------- revertShim

test("revertShim 先认密封目录之外的 bak，把启动器逐字节还原", async () => {
  const sb = sandbox("revshim-bak");
  const bin = path.join(sb.root, "bin");
  const sh = put(path.join(bin, "dsh"), "patched body\n");
  put(sh + ".dshpurge.bak", "original body\n");

  const result = await core.revertShim(bin, { scrubDesktop: false });
  assert.equal(result.dsh, "reverted");
  assert.equal(result["dsh.cmd"], "missing");
  assert.equal(read(sh), "original body\n");
  assert.equal(fs.existsSync(sh + ".dshpurge.bak"), false);
});

test("revertShim 三个名字各自独立判定，不因为一个缺 bak 就放弃别的", async () => {
  const sb = sandbox("revshim-each");
  const bin = path.join(sb.root, "bin");
  const sh = put(path.join(bin, "dsh"), "patched body\n");
  put(sh + ".dshpurge.bak", "original body\n");
  put(path.join(bin, "dsh.ps1"), "patched ps1\n");
  put(path.join(bin, "dsh.ps1") + ".dshpurge.bak", "original ps1\n");

  const result = await core.revertShim(bin, { scrubDesktop: false });
  assert.equal(result.dsh, "reverted");
  assert.equal(result["dsh.ps1"], "reverted");
  assert.equal(read(sh), "original body\n");
  assert.equal(read(path.join(bin, "dsh.ps1")), "original ps1\n");
});

test("revertShim 在密封目录里只认改名后的外置 bak，bin 里那份算旧版（reverted_legacy_in_bin）", async () => {
  const sb = sandbox("revshim-legacy");
  const sealed = path.join(sb.root, "appdata", "DSH Desktop", "host-commands", "bin");
  fs.mkdirSync(sealed, { recursive: true });
  const sh = put(path.join(sealed, "dsh"), "patched body\n");
  put(sh + ".dshpurge.bak", "ORIGINAL\n");
  core.resetPathMemo();
  assert.equal(core.isDesktopCommandRuntimeDir(sealed), true, "前提：这确实是密封目录");

  const inBin = core.shimBackupPath(sh);
  assert.notEqual(inBin, sh + ".dshpurge.bak", "密封目录的 bak 要搬到 $DSH_HOME 下，不是留在 bin 里");

  const legacy = await core.revertShim(sealed, { scrubDesktop: false });
  assert.equal(legacy.dsh, "reverted_legacy_in_bin");
  assert.equal(read(sh), "ORIGINAL\n");
  assert.equal(fs.existsSync(sh + ".dshpurge.bak"), false);
});

test("revertShim 在密封目录里优先认外置 bak（reverted），还原完外置那份也删掉", async () => {
  const sb = sandbox("revshim-external");
  const sealed = path.join(sb.root, "appdata", "DSH Desktop", "host-commands", "bin");
  fs.mkdirSync(sealed, { recursive: true });
  const sh = put(path.join(sealed, "dsh"), "patched body\n");
  core.resetPathMemo();
  const external = core.shimBackupPath(sh);
  put(external, "EXTERNAL-ORIGINAL\n");

  const result = await core.revertShim(sealed, { scrubDesktop: false });
  assert.equal(result.dsh, "reverted");
  assert.equal(read(sh), "EXTERNAL-ORIGINAL\n");
  assert.equal(fs.existsSync(external), false);
});

test("revertShim 没有 bak 但有注入块时只剥注入（stripped_inject），不碰别的", async () => {
  const sb = sandbox("revshim-strip");
  const bin = path.join(sb.root, "bin");
  put(path.join(bin, "dsh"), "#!/bin/sh\n# dsh-purge shim begin\nif [ -z \"${DSH_HOME:-}\" ]; then :; fi\n# dsh-purge shim end\nexec node ./bin.js\n");

  const result = await core.revertShim(bin, { scrubDesktop: false });
  assert.equal(result.dsh, "stripped_inject");
  assert.doesNotMatch(read(path.join(bin, "dsh")), /DSH_HOME/);
  assert.equal(fs.existsSync(path.join(bin, "dsh")), true);
});

test("revertShim 既没 bak 也没注入时回 no_backup，文件不存在时回 missing", async () => {
  const sb = sandbox("revshim-none");
  const bin = path.join(sb.root, "bin");
  put(path.join(bin, "dsh"), "plain body\n");

  const result = await core.revertShim(bin, { scrubDesktop: false });
  assert.equal(result.dsh, "no_backup");
  assert.equal(result["dsh.ps1"], "missing");
  assert.equal(read(path.join(bin, "dsh")), "plain body\n");
  assert.deepEqual(await core.revertShim(""), {});
});

test("revertShim 的 0 字节 bak 走 reverted_skipped_empty 并把 bak 改名 .bad", async () => {
  const sb = sandbox("revshim-empty");
  const bin = path.join(sb.root, "bin");
  const sh = put(path.join(bin, "dsh"), "patched body\n");
  put(sh + ".dshpurge.bak", "");

  const result = await core.revertShim(bin, { scrubDesktop: false });
  assert.equal(result.dsh, "reverted_skipped_empty");
  assert.equal(read(sh), "patched body\n");
  assert.equal(fs.existsSync(sh + ".dshpurge.bak"), false);
  assert.equal(fs.existsSync(sh + ".dshpurge.bak.bad"), true);
});

test("revertShim 遇到悬空符号链接只删 bak，不去写那个链接（reverted_skipped_symlink）", async () => {
  const sb = sandbox("revshim-dangling");
  const bin = path.join(sb.root, "bin");
  const link = path.join(bin, "dsh");
  fs.mkdirSync(bin, { recursive: true });
  try {
    fs.symlinkSync(path.join(sb.root, "missing-target.js"), link, "file");
  } catch (e) {
    test.skip(`当前账号建不了符号链接：${String(e).slice(0, 60)}`);
    return;
  }
  put(link + ".dshpurge.bak", "ORIG\n");

  const result = await core.revertShim(bin, { scrubDesktop: false });
  assert.equal(result.dsh, "reverted_skipped_symlink");
  assert.equal(fs.existsSync(link + ".dshpurge.bak"), false, "bak 留着只会下次再踩一次");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test("revertShim 在密封目录里遇到真符号链接时按真身找外置 bak（否则永远报 no_backup）", async () => {
  const sb = sandbox("revshim-sealed-link");
  const sealed = path.join(sb.root, "appdata", "DSH Desktop", "host-commands", "bin");
  fs.mkdirSync(sealed, { recursive: true });
  const real = path.join(sb.root, "real-dsh.js");
  put(real, "PATCHED\n");
  const link = path.join(sealed, "dsh");
  try {
    fs.symlinkSync(real, link, "file");
  } catch (e) {
    test.skip(`当前账号建不了符号链接：${String(e).slice(0, 60)}`);
    return;
  }
  core.resetPathMemo();
  // 外置 bak 是按「真身路径」算摘要的，和按链接算出来的名字不一样。
  assert.notEqual(core.shimBackupPath(real), core.shimBackupPath(link), "前提：两个路径算出的 bak 名必须不同");
  const external = core.shimBackupPath(real);
  fs.mkdirSync(path.dirname(external), { recursive: true });
  fs.writeFileSync(external, "ORIGINAL\n");

  const result = await core.revertShim(sealed, { scrubDesktop: false });
  assert.equal(result.dsh, "reverted");
  assert.equal(read(real), "ORIGINAL\n", "写的必须是真身");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, "链接本身不能被替换成普通文件");
});

test("revertShim 对密封目录顺带清理残留（in_bin_scrub），scrubDesktop:false 时不清", async () => {
  const sb = sandbox("revshim-sealed");
  const sealed = path.join(sb.root, "appdata", "DSH Desktop", "host-commands", "bin");
  fs.mkdirSync(sealed, { recursive: true });
  put(path.join(sealed, "dsh"), "plain body\n");
  put(path.join(sealed, "junk.dshpurge.tmp"), "x\n");
  core.resetPathMemo();

  const noScrub = await core.revertShim(sealed, { scrubDesktop: false });
  assert.equal(noScrub.in_bin_scrub, undefined);
  assert.equal(fs.existsSync(path.join(sealed, "junk.dshpurge.tmp")), true);

  const scrubbed = await core.revertShim(sealed, {});
  assert.equal(scrubbed.dsh, "no_backup");
  assert.equal(scrubbed.in_bin_scrub.length, 1);
  assert.deepEqual(scrubbed.in_bin_scrub[0].cleaned, ["deleted_artifact:junk.dshpurge.tmp"]);
  assert.equal(fs.existsSync(path.join(sealed, "junk.dshpurge.tmp")), false);
});

// ------------------------------------------------------------ revertAllShims

test("revertAllShims 按目录聚合，并把密封目录的清理单独挂在 _desktop_scrub", async () => {
  const sb = sandbox("revall");
  const plain = path.join(sb.root, "plainbin");
  put(path.join(plain, "dsh"), "#!/bin/sh\n# dsh-purge shim begin\nx\n# dsh-purge shim end\nexec node\n");
  process.env.PATH = plain;
  const sealed = path.join(sb.root, "appdata", "DSH Desktop", "host-commands", "bin");
  fs.mkdirSync(sealed, { recursive: true });
  put(path.join(sealed, "dsh"), "plain\n");
  put(path.join(sealed, "junk.dshpurge.tmp"), "x\n");
  core.resetPathMemo();

  const result = await core.revertAllShims();
  assert.equal(result[plain].dsh, "stripped_inject");
  assert.equal(result._desktop_scrub.length, 1);
  assert.deepEqual(result._desktop_scrub[0].cleaned, ["deleted_artifact:junk.dshpurge.tmp"]);
  assert.equal(Object.keys(result).includes(sealed), false, "密封目录不进明细表，只在 _desktop_scrub 里");
});

test("revertAllShims 在没有任何可回滚目录时回空对象，不抛错", async () => {
  const sb = sandbox("revall-empty");
  process.env.PATH = path.join(sb.root, "nothing-here");
  core.resetPathMemo();
  assert.deepEqual(await core.revertAllShims(), {});
});

// ------------------------------------------------ 这批 drill 逼出来的判别性用例
//
// 每一条都对应一个「把守卫改坏、但原有用例照样绿」的变异。写它们时只认一个标准：
// 换回原实现必须绿，改成坏实现必须红。

test("refreshStaleBaksForUpgrade 递归到第 8 层还在扫，第 9 层就停（深度上限 10 的边界）", () => {
  const sb = sandbox("depth-bound");
  const mk = (n) => {
    let d = sb.ai;
    for (let i = 0; i < n; i += 1) d = path.join(d, `l${i}`);
    const fp = put(path.join(d, "dsh-y", "lib", "index.js"), "NEWV");
    put(fp + ".dshpurge.bak", "OLDV");
    return fp;
  };
  const at8 = mk(8);
  const at9 = mk(9);
  const refreshed = core.refreshStaleBaksForUpgrade(sb.ai);
  assert.equal(refreshed.length, 1, "第 8 层必须被扫到，第 9 层必须被深度上限挡住");
  assert.equal(read(at8 + ".dshpurge.bak"), "NEWV", "扫到的那份 bak 要刷成新版原文");
  assert.equal(read(at9 + ".dshpurge.bak"), "OLDV", "被挡住的第 9 层一个字节都不许动");
});

test("refreshStaleBaksForUpgrade 见到该文件补丁的单数 marker 就住手（否则会把我们打过的版本写回 bak）", () => {
  const sb = sandbox("marker-guard");
  // 这个 key 的补丁 marker 就是这行常量（本文件所有补丁的 marker 都收进 markersByPath）。
  const fp = put(
    path.join(sb.ai, "dsh-agent-instructions", "lib", "index.js"),
    'const WORKSPACE_CONTEXT_INTRO = "The following instructions are ACTIVE"\nTAIL\n',
  );
  put(fp + ".dshpurge.bak", "OLD");
  assert.deepEqual(Object.keys(core.targetFiles(sb.ai)), ["agent-instructions"], "前提：这份文件必须是 targetFiles 里的键");
  assert.deepEqual(core.refreshStaleBaksForUpgrade(sb.ai), [], "原文里带着补丁 marker，说明它才是打过的版本，bak 才是原件");
  assert.equal(read(fp + ".dshpurge.bak"), "OLD", "bak 必须原封不动");
});

test("revertAll 在字节数相同但内容不同时照样还原（不能只比 size）", async () => {
  const sb = sandbox("same-size");
  const fp = put(path.join(sb.ai, "dsh-agent-instructions", "lib", "index.js"), "AAAA");
  put(fp + ".dshpurge.bak", "BBBB");
  const r = await core.revertAll(sb.ai, {});
  assert.equal(r.reverted.length, 1, "同样 4 字节也必须当成不同内容");
  assert.equal(read(fp), "BBBB");
  assert.equal(fs.existsSync(fp + ".dshpurge.bak"), false, "还原完 bak 要删掉");
});

test("backupAll 对 existsSync 说不存在的目标直接跳过，不制造假 errors、不建空 bak", async () => {
  const sb = sandbox("exists-guard");
  const fp = put(path.join(sb.ai, "dsh-agent-instructions", "lib", "index.js"), "X");
  const real = fs.existsSync;
  fs.existsSync = function (p) {
    if (String(p) === fp) return false;
    return real.call(this, p);
  };
  try {
    const r = await core.backupAll(sb.ai);
    assert.deepEqual(r.made, []);
    assert.deepEqual(r.errors, [], "跳过不等于失败，errors 必须是空的");
  } finally {
    fs.existsSync = real;
  }
  assert.equal(fs.existsSync(fp + ".dshpurge.bak"), false, "跳过时连占位文件都不该留下");
});

test("dropStaleUserProfilePatchBackups 在 readdir 抛错时安静返回空数组，不把异常抛给调用方", async () => {
  const sb = sandbox("drop-throw");
  const profiles = path.join(sb.home, "profiles");
  const bak = put(path.join(profiles, "web", "cordis.patch.yml.dshpurge.bak"), "O");
  const real = fs.readdirSync;
  fs.readdirSync = function (p, ...rest) {
    if (String(p) === profiles) {
      const e = new Error("boom");
      e.code = "EPERM";
      throw e;
    }
    return real.call(this, p, ...rest);
  };
  try {
    assert.deepEqual(await core.dropStaleUserProfilePatchBackups(sb.home), [], "读不到目录就当没有，不能抛");
  } finally {
    fs.readdirSync = real;
  }
  assert.equal(fs.existsSync(bak), true, "没读到目录就不该删任何东西");
});

test("restoreMissingOriginalsFromBak 在原文件 stat 抛非 ENOENT 时住手（EACCES 不等于文件缺失）", () => {
  const sb = sandbox("stat-eacces");
  const orig = put(path.join(sb.ai, "dsh-x", "lib", "index.js"), "");
  put(orig + ".dshpurge.bak", "BAK");
  const real = fs.statSync;
  fs.statSync = function (p, ...rest) {
    if (String(p) === orig) {
      const e = new Error("nope");
      e.code = "EACCES";
      throw e;
    }
    return real.call(this, p, ...rest);
  };
  try {
    assert.deepEqual(core.restoreMissingOriginalsFromBak(sb.ai, [orig]), [], "只有 ENOENT 才算「文件不见了」");
  } finally {
    fs.statSync = real;
  }
  assert.equal(read(orig), "", "原文件不该被填");
});

test("restoreMissingOriginalsFromBak 在 aiBase 不是目录时也直接放弃，连 files 里的路径都不碰", () => {
  const sb = sandbox("base-not-dir");
  const notADir = put(path.join(sb.root, "notadir.txt"), "x");
  const orig = put(path.join(sb.root, "elsewhere", "dsh-y", "lib", "index.js"), "");
  put(orig + ".dshpurge.bak", "BAK");
  assert.deepEqual(core.restoreMissingOriginalsFromBak(notADir, [orig]), [], "宿主树不成立时不做任何还原");
  assert.equal(read(orig), "", "files 里的路径也不能被填");
});

test("restoreMissingOriginalsFromBak 也认 src/client.js 这个位置（前端包的源码入口）", () => {
  const sb = sandbox("src-client");
  const orig = put(path.join(sb.ai, "dsh-x", "src", "client.js"), "");
  put(orig + ".dshpurge.bak", "BAKCLIENT");
  const restored = core.restoreMissingOriginalsFromBak(sb.ai);
  assert.equal(restored.length, 1);
  assert.equal(read(orig), "BAKCLIENT");
});

test("restoreMissingOriginalsFromBak 对重复传进来的同一路径只处理一次", () => {
  const sb = sandbox("dedupe-seen");
  const orig = path.join(sb.ai, "dsh-agent-instructions", "lib", "index.js");
  fs.mkdirSync(path.dirname(orig), { recursive: true });
  put(orig + ".dshpurge.bak", "ORIG");
  assert.equal(core.restoreMissingOriginalsFromBak(sb.ai, [orig, orig]).length, 1, "seen 集合必须挡住第二次");
});

test("revertAll 先补回缺失原件，所以那一份只算 skipped、bak 留着（不是 reverted）", async () => {
  const sb = sandbox("missing-first");
  const orig = path.join(sb.ai, "dsh-agent-instructions", "lib", "index.js");
  fs.mkdirSync(path.dirname(orig), { recursive: true });
  put(orig + ".dshpurge.bak", "ORIGINAL");
  const r = await core.revertAll(sb.ai, {});
  assert.equal(read(orig), "ORIGINAL", "缺失的原文件要先被补回来");
  assert.deepEqual(r.reverted, [], "补回来之后字节就相等了，轮到 sameFileBytes 判跳过");
  assert.equal(r.skipped.length, 1);
  assert.equal(fs.existsSync(orig + ".dshpurge.bak"), true, "跳过时 bak 必须保留");
});

// ------------------------------------------------------- 不可达分支的形状钉

test("backupAll / revertAll 里的用户配置层分支现在走不到（targetFiles 从不登记 profiles/*/cordis.patch.yml）", () => {
  const src = fs.readFileSync(new URL("../lib/core.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const at = lines.findIndex((l) => l === "export async function backupAll(aiBase) {");
  assert.notEqual(at, -1);
  const tail = lines.slice(at, at + 45).join("\n");
  assert.match(tail, /skippedUser\.push\(fp\)/, "backupAll 的用户配置层守卫必须还在");
  const at2 = lines.findIndex((l) => l === "export async function revertAll(aiBase, options = {}) {");
  assert.notEqual(at2, -1);
  const tail2 = lines.slice(at2, at2 + 60).join("\n");
  assert.match(tail2, /preservedUser\.push\(fp\)/, "revertAll 的用户配置层守卫必须还在");
  assert.match(tail2, /isUserProfilePatchFile\(fp\)/, "判据必须是 isUserProfilePatchFile");
});

test("四处「改坏了行为也一样」的守卫只能按形状钉（行为上不可区分，靠这一条防静默退化）", () => {
  const src = fs.readFileSync(new URL("../lib/core.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const body = (head, span) => {
    const at = lines.findIndex((l) => l === head);
    assert.notEqual(at, -1, `找不到函数头：${head}`);
    return lines.slice(at, at + span).join("\n");
  };

  // ① flatten 的去重：targetFiles 本身已经去过重，重复 push 在公开 API 上看不出差别；
  //    真正坏掉的是「同一个文件被备份两次 / 被回滚两次」，只能在源头挡。
  assert.match(
    body("function flattenTargetPaths(files) {", 10),
    /if \(p && typeof p === "string" && !out\.includes\(p\)\) out\.push\(p\);/,
    "flattenTargetPaths 必须自己去重",
  );

  // ② dropStale 的 isDir 前置：没有 profiles 目录时 readdirSync 会抛，被同一个 catch 兜住，
  //    结果完全一样；但少了这道判断，每次启动都要吃一次异常。
  assert.match(
    body("export async function dropStaleUserProfilePatchBackups(dshHome = findDshHome()) {", 22),
    /if \(!isDir\(profilesRoot\)\) return dropped;/,
    "dropStale 必须先判 profiles 是不是目录",
  );

  // ③ refresh 的 isDir 前置：aiBase 是文件时 readdirSync 抛错被 visit 的 catch 兜住，结果一样。
  assert.match(
    body("export function refreshStaleBaksForUpgrade(aiBase, files = null) {", 5),
    /if \(!aiBase \|\| !isDir\(aiBase\)\) return refreshed;/,
    "refresh 必须先判 aiBase 是目录",
  );

  // ⑤〜⑦ 三条守卫在真实树里走不到（targetFiles 只登记存在的文件、从不登记 profile patch），
  //    但少了它们，代价是「删掉文件后下次备份凭空多一条 errors」或「把用户配置层备份走」。
  assert.match(
    body("export async function backupAll(aiBase) {", 20),
    /if \(!fs\.existsSync\(fp\)\) continue;/,
    "backupAll 必须先判目标还在（targetFiles 之后到备份之间文件可能被删）",
  );
  assert.match(
    body("export async function backupAll(aiBase) {", 20),
    /if \(isUserProfilePatchFile\(fp\)\) \{/,
    "backupAll 必须显式跳过用户配置层",
  );
  assert.match(
    body("export function restoreMissingOriginalsFromBak(aiBase, files = null) {", 20),
    /if \(!original \|\| seen\.has\(original\)\) return;/,
    "restore 必须自己去重（files 与目录扫描可能给出同一条路径）",
  );

  // ④ revertAllShims 必须给每个目录传 scrubDesktop:false —— 传 true 也会在末尾那次全量清扫里
  //    得到同样的 in_bin_scrub 结果，所以行为测不出来；但那样每个目录都要多扫一遍密封 bin。
  const tail = body("export async function revertAllShims() {", 12);
  assert.match(tail, /revertShim\(dir, \{ scrubDesktop: false \}\)/, "每个目录都要显式关掉单目录清扫");
  assert.match(tail, /const scrubbed = sanitizeDesktopCommandRuntimes\(\);/, "末尾必须还有一次全量清扫");
  assert.match(tail, /results\._desktop_scrub = scrubbed;/, "全量清扫的产物要挂在 _desktop_scrub");
});
