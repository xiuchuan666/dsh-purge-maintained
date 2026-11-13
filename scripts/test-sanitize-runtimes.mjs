// 密封桌面运行时目录的清理：lib/core.js 的 sanitizeDesktopCommandRuntimes /
// scrubInBinBak / stripCmdInjectSync。
//
// 这一簇只做一件事：把卸载/重装时留在「密封 bin」里的 .dshpurge.bak 搬出安装目录。
// 它坏的后果不是报错，而是**用户永远拿不回启动器原文**（bak 被删）或**安装目录被写脏**
// （下次升级把脏文件一起打包）。所以每条用例都盯字节与去向，不盯返回值形状。
//
// 注意两个陷阱：
// ① sealedRuntimeRoots() 读 APPDATA / LOCALAPPDATA / os.homedir()，listDesktopCommandRuntimeDirs()
//    还会扫 PATH —— 不把这三样指到沙箱里，测试就会去动**真机**的密封 bin。
// ② 只在 name 上做 toLowerCase，Windows 不区分大小写、POSIX 区分，个别用例要按平台分支。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-sanitize-"));
const IS_WINDOWS = process.platform === "win32";
const ORIG_ENV = {
  DSH_HOME: process.env.DSH_HOME,
  DSH_SURFACE: process.env.DSH_SURFACE,
  DSH_BASE: process.env.DSH_BASE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  PATH: process.env.PATH,
};

const core = await import("../lib/core.js");

const M = "dsh-purge shim";

function sandbox(tag) {
  const root = path.join(SANDBOX, tag);
  const home = path.join(root, "home");
  const appdata = path.join(root, "appdata");
  const localapp = path.join(root, "localapp");
  const sealed = path.join(appdata, "DSH Desktop", "host-commands", "bin");
  const plain = path.join(root, "plainbin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(sealed, { recursive: true });
  fs.mkdirSync(localapp, { recursive: true });
  fs.mkdirSync(plain, { recursive: true });
  process.env.DSH_HOME = home;
  process.env.DSH_SURFACE = "web";
  process.env.APPDATA = appdata;
  process.env.LOCALAPPDATA = localapp;
  // PATH 里只放沙箱目录：否则真机的密封 bin 会被扫进来然后被清掉。
  process.env.PATH = [root, plain, sealed].join(path.delimiter);
  delete process.env.DSH_BASE;
  core.resetPathMemo();
  return { root, home, appdata, localapp, sealed, plain };
}

function put(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
  return fp;
}

const read = (fp) => fs.readFileSync(fp, "utf8");
const cleanedOf = (report, dir) => {
  const hit = report.find((r) => path.normalize(r.dir).toLowerCase() === path.normalize(dir).toLowerCase());
  return hit ? hit.cleaned : null;
};

test.after(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  core.resetPathMemo();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("密封 bin 的自发现：APPDATA 下的 host-commands/bin 会进 listDesktopCommandRuntimeDirs", () => {
  const sb = sandbox("discover");
  const dirs = core.listDesktopCommandRuntimeDirs();
  const found = dirs.some((d) => path.normalize(d).toLowerCase() === path.normalize(sb.sealed).toLowerCase());
  assert.equal(found, true, `期望发现 ${sb.sealed}，实际 ${JSON.stringify(dirs)}`);
  // 普通 bin 不算密封目录，必须留在外面，否则 sanitize 会去动用户的 npm 全局启动器。
  assert.equal(core.isDesktopCommandRuntimeDir(sb.plain), false);
});

test("5 层以内的嵌套 bin 会被 walk 到，超过 5 层的不算（现状锁定）", () => {
  const sb = sandbox("depth");
  const shallow = path.join(sb.appdata, "DSH Desktop", "host-commands", "a", "b", "c", "bin");
  const deep = path.join(sb.appdata, "DSH Desktop", "host-commands", "a", "b", "c", "d", "e", "f", "bin");
  fs.mkdirSync(shallow, { recursive: true });
  fs.mkdirSync(deep, { recursive: true });
  const dirs = core.listDesktopCommandRuntimeDirs().map((d) => path.normalize(d).toLowerCase());
  assert.equal(dirs.includes(path.normalize(shallow).toLowerCase()), true);
  assert.equal(dirs.includes(path.normalize(deep).toLowerCase()), false);
});

test("命中 bin 之后不再往下钻：bin 里面再套的 bin 不算另一个运行时目录", () => {
  const sb = sandbox("nested-bin");
  // sandbox() 已经建了 <appdata>/DSH Desktop/host-commands/bin，这里再套一层。
  const inner = path.join(sb.sealed, "inner", "bin");
  fs.mkdirSync(inner, { recursive: true });
  const dirs = core.listDesktopCommandRuntimeDirs().map((d) => path.normalize(d).toLowerCase());
  assert.equal(dirs.includes(path.normalize(sb.sealed).toLowerCase()), true);
  assert.equal(dirs.includes(path.normalize(inner).toLowerCase()), false, JSON.stringify(dirs));
});

test("干净的密封 bin 不出现在报告里（只有 cleaned 非空才记一条）", () => {
  const sb = sandbox("clean");
  put(path.join(sb.sealed, "dsh"), "#!/bin/sh\n");
  put(path.join(sb.sealed, "dsh.cmd"), "@ECHO off\r\nnode dsh %*\r\n");
  assert.deepEqual(core.sanitizeDesktopCommandRuntimes(), []);
});

test("不认识的残留文件（既不是 .dshpurge.bak 也不是 .dshpurge.*）一律不碰", () => {
  const sb = sandbox("unknown");
  put(path.join(sb.sealed, "notes.txt"), "keep me");
  put(path.join(sb.sealed, "dsh.bak"), "keep me too");
  assert.deepEqual(core.sanitizeDesktopCommandRuntimes(), []);
  assert.equal(read(path.join(sb.sealed, "notes.txt")), "keep me");
  assert.equal(read(path.join(sb.sealed, "dsh.bak")), "keep me too");
});

test("非启动器名的 .dshpurge.bak 直接删掉（原地留着只会被下次升级打包）", () => {
  const sb = sandbox("nonlauncher");
  const fp = put(path.join(sb.sealed, "other.dshpurge.bak"), "dead");
  const report = core.sanitizeDesktopCommandRuntimes();
  assert.deepEqual(cleanedOf(report, sb.sealed), ["deleted:other.dshpurge.bak"]);
  assert.equal(fs.existsSync(fp), false);
});

test("其它 .dshpurge.* 残留（如搬 bak 时写一半的 .copytmp）按 artifact 删掉", () => {
  const sb = sandbox("artifact");
  const fp = put(path.join(sb.sealed, "dsh.dshpurge.1234.copytmp"), "half written");
  const report = core.sanitizeDesktopCommandRuntimes();
  assert.deepEqual(cleanedOf(report, sb.sealed), ["deleted_artifact:dsh.dshpurge.1234.copytmp"]);
  assert.equal(fs.existsSync(fp), false);
});

test("启动器的 bak：外部没有时搬到 $DSH_HOME/dsh-purge/shim-backups 再删 in-bin 的", () => {
  const sb = sandbox("relocate");
  put(path.join(sb.sealed, "dsh"), "#!/bin/sh\n");
  const bak = put(path.join(sb.sealed, "dsh.dshpurge.bak"), "#!/bin/sh\necho original\n");
  const report = core.sanitizeDesktopCommandRuntimes();
  assert.deepEqual(cleanedOf(report, sb.sealed), ["relocated_bak:dsh", "removed_in_bin_bak:dsh"]);
  assert.equal(fs.existsSync(bak), false);

  const external = core.shimBackupPath(path.join(sb.sealed, "dsh"));
  assert.equal(fs.existsSync(external), true);
  // 搬出去的是**原文**，不是被注入过的版本 —— 这是这条链唯一的价值。
  assert.equal(read(external), "#!/bin/sh\necho original\n");
  assert.ok(external.startsWith(sb.home), `外部备份必须落在 DSH_HOME 内，实际 ${external}`);
});

test("三个启动器名各自搬一次，bak 落点互不覆盖（摘要吃路径）", () => {
  const sb = sandbox("three");
  for (const n of ["dsh", "dsh.ps1", "dsh.cmd"]) {
    put(path.join(sb.sealed, n), "# launcher\n");
    put(path.join(sb.sealed, `${n}.dshpurge.bak`), `# original of ${n}\n`);
  }
  const report = core.sanitizeDesktopCommandRuntimes();
  // 顺序是 readdirSync 的顺序（NTFS 上按名序、ext4 上按哈希序），不构成契约 —— 排序后比。
  assert.deepEqual(cleanedOf(report, sb.sealed).slice().sort(), [
    "relocated_bak:dsh",
    "relocated_bak:dsh.cmd",
    "relocated_bak:dsh.ps1",
    "removed_in_bin_bak:dsh",
    "removed_in_bin_bak:dsh.cmd",
    "removed_in_bin_bak:dsh.ps1",
  ]);
  const bodies = ["dsh", "dsh.ps1", "dsh.cmd"].map((n) => read(core.shimBackupPath(path.join(sb.sealed, n))));
  assert.deepEqual(bodies, ["# original of dsh\n", "# original of dsh.ps1\n", "# original of dsh.cmd\n"]);
});

test("外部备份已存在且大小一致 → 视为可信，删掉 in-bin 的那份", () => {
  const sb = sandbox("ext-same");
  put(path.join(sb.sealed, "dsh"), "#!/bin/sh\n");
  const bak = put(path.join(sb.sealed, "dsh.dshpurge.bak"), "#!/bin/sh\necho original\n");
  const external = core.shimBackupPath(path.join(sb.sealed, "dsh"));
  put(external, "#!/bin/sh\necho original\n");
  const report = core.sanitizeDesktopCommandRuntimes();
  assert.deepEqual(cleanedOf(report, sb.sealed), ["external_bak_exists:dsh", "removed_in_bin_bak:dsh"]);
  assert.equal(fs.existsSync(bak), false);
  assert.equal(read(external), "#!/bin/sh\necho original\n");
});

test("外部备份大小不一致 → 判 stale，绝不删 in-bin 的那份（用户的原文只有这一份）", () => {
  const sb = sandbox("ext-stale");
  put(path.join(sb.sealed, "dsh"), "#!/bin/sh\n");
  const bak = put(path.join(sb.sealed, "dsh.dshpurge.bak"), "#!/bin/sh\necho a much longer original\n");
  const external = core.shimBackupPath(path.join(sb.sealed, "dsh"));
  put(external, "short");
  const report = core.sanitizeDesktopCommandRuntimes();
  assert.deepEqual(cleanedOf(report, sb.sealed), ["external_bak_stale:dsh", "kept_in_bin_bak:dsh"]);
  assert.equal(fs.existsSync(bak), true);
  assert.equal(read(bak), "#!/bin/sh\necho a much longer original\n");
  // 外部那份不被这次操作覆盖 —— 它是上一次留下的，改它等于伪造历史。
  assert.equal(read(external), "short");
});

test("外部拷贝失败时也保留 in-bin 的 bak（搬不动就别删）", () => {
  const sb = sandbox("relocate-fail");
  // 把 $DSH_HOME/dsh-purge 做成文件，mkdir / copyFile 都会失败。
  put(path.join(sb.home, "dsh-purge"), "not a directory");
  put(path.join(sb.sealed, "dsh"), "#!/bin/sh\n");
  const bak = put(path.join(sb.sealed, "dsh.dshpurge.bak"), "#!/bin/sh\necho original\n");
  const report = core.sanitizeDesktopCommandRuntimes();
  const cleaned = cleanedOf(report, sb.sealed);
  assert.equal(cleaned.length, 2);
  assert.ok(cleaned[0].startsWith("relocate_failed:dsh:"), cleaned[0]);
  assert.equal(cleaned[1], "kept_in_bin_bak:dsh");
  assert.equal(fs.existsSync(bak), true);
  assert.equal(read(bak), "#!/bin/sh\necho original\n");
});

test("搬出去之后 in-bin 那份删不掉，要记 remove_failed 且文件还在", () => {
  const sb = sandbox("remove-fail");
  put(path.join(sb.sealed, "dsh"), "#!/bin/sh\n");
  const bak = put(path.join(sb.sealed, "dsh.dshpurge.bak"), "#!/bin/sh\necho original\n");
  const orig = fs.unlinkSync;
  fs.unlinkSync = (p) => {
    if (String(p).endsWith("dsh.dshpurge.bak")) throw new Error("EBUSY: held by another process");
    return orig(p);
  };
  try {
    const report = core.sanitizeDesktopCommandRuntimes();
    const cleaned = cleanedOf(report, sb.sealed);
    assert.equal(cleaned.length, 2, JSON.stringify(cleaned));
    assert.equal(cleaned[0], "relocated_bak:dsh");
    assert.ok(cleaned[1].startsWith("remove_failed:dsh:"), cleaned[1]);
    // 搬出去的那份已经落地，所以用户仍拿得回原文 —— 这句是这条链的兜底价值。
    assert.equal(read(core.shimBackupPath(path.join(sb.sealed, "dsh"))), "#!/bin/sh\necho original\n");
    assert.equal(read(bak), "#!/bin/sh\necho original\n");
  } finally {
    fs.unlinkSync = orig;
  }
});

test("删不掉的残留（目录冒充 .dshpurge.bak）记 delete_failed，不是静默跳过", () => {
  const sb = sandbox("delete-fail");
  fs.mkdirSync(path.join(sb.sealed, "other.dshpurge.bak"), { recursive: true });
  const report = core.sanitizeDesktopCommandRuntimes();
  const cleaned = cleanedOf(report, sb.sealed);
  assert.equal(cleaned.length, 1);
  assert.ok(cleaned[0].startsWith("delete_failed:other.dshpurge.bak:"), cleaned[0]);
  assert.equal(fs.existsSync(path.join(sb.sealed, "other.dshpurge.bak")), true);
});

test("删不掉的 artifact 记 error:，文件名带在消息里", () => {
  const sb = sandbox("artifact-fail");
  fs.mkdirSync(path.join(sb.sealed, "junk.dshpurge.tmp"), { recursive: true });
  const report = core.sanitizeDesktopCommandRuntimes();
  const cleaned = cleanedOf(report, sb.sealed);
  assert.equal(cleaned.length, 1);
  assert.ok(cleaned[0].startsWith("error:junk.dshpurge.tmp:"), cleaned[0]);
});

test("dsh.cmd 里已经注入过的块会被剥掉，未注入的一个字节都不动", () => {
  const sb = sandbox("strip-cmd");
  const patched = put(
    path.join(sb.sealed, "dsh.cmd"),
    `@ECHO off\r\nREM ${M} begin\r\nrem body\r\nREM ${M} end\r\nnode "%~dp0dsh" %*\r\n`,
  );
  const clean = put(path.join(sb.sealed, "dsh.ps1"), "# launcher\n");
  const report = core.sanitizeDesktopCommandRuntimes();
  assert.deepEqual(cleanedOf(report, sb.sealed), ["stripped_cmd_inject"]);
  // 现状锁定：begin 那行是占位不是内容，剥完只剩它（与 stripShimInject 的语义一致）。
  assert.equal(read(patched), `@ECHO off\r\nREM ${M} begin\r\nnode "%~dp0dsh" %*\r\n`);
  assert.equal(read(clean), "# launcher\n");
});

test("只读的 dsh.cmd：能剥就剥，剥不动要记 error_strip_cmd（按平台分支）", () => {
  const sb = sandbox("strip-readonly");
  const fp = put(
    path.join(sb.sealed, "dsh.cmd"),
    `@ECHO off\r\nREM ${M} begin\r\nrem body\r\nREM ${M} end\r\nnode dsh %*\r\n`,
  );
  fs.chmodSync(fp, 0o444);
  let directWriteBlocked = true;
  try {
    fs.writeFileSync(fp, "probe");
  } catch {
    directWriteBlocked = false;
  }
  const before = read(fp);
  const report = core.sanitizeDesktopCommandRuntimes();
  const cleaned = cleanedOf(report, sb.sealed) || [];
  const stripped = cleaned.includes("stripped_cmd_inject");
  const failed = cleaned.some((c) => c.startsWith("error_strip_cmd:"));
  if (stripped) {
    // 走得通就说明这台机器的文件系统允许覆盖只读文件（POSIX 上很常见）。
    assert.notEqual(read(fp), before);
    assert.equal(failed, false);
  } else {
    assert.equal(failed, true, JSON.stringify(cleaned));
    assert.equal(read(fp), before, "剥不动时必须一字不动");
  }
  if (IS_WINDOWS && directWriteBlocked) {
    // Windows 上 chmod 0o444 是真拦得住写的 —— 这条分支才是常态。
    assert.equal(failed, true, JSON.stringify(cleaned));
  }
  fs.chmodSync(fp, 0o666);
});

test("readdirSync 抛错时跳过整个目录，连 dsh.cmd 也不碰（不留半份报告）", () => {
  const sb = sandbox("readdir-throws");
  put(path.join(sb.sealed, "other.dshpurge.bak"), "dead");
  // 注入过的 dsh.cmd 也放一份：stripCmdInjectSync 在 readdir 之后无条件跑，
  // 少了那句 continue 就会「读不到目录却照样改这个目录里的文件」。
  const cmd = put(
    path.join(sb.sealed, "dsh.cmd"),
    `@ECHO off\r\nREM ${M} begin\r\nrem body\r\nREM ${M} end\r\nnode dsh %*\r\n`,
  );
  const before = read(cmd);
  const desc = Object.getOwnPropertyDescriptor(fs, "readdirSync");
  assert.equal(desc.writable, true);
  assert.equal(desc.configurable, true);
  const orig = fs.readdirSync;
  fs.readdirSync = () => {
    throw new Error("boom");
  };
  try {
    assert.deepEqual(core.sanitizeDesktopCommandRuntimes(), []);
  } finally {
    fs.readdirSync = orig;
  }
  assert.equal(read(cmd), before, "读不到目录时不许动里面的任何文件");
  // 复原后照样能清 —— 证明刚才只是「读不了就跳过」，没把状态搞坏。
  const after = cleanedOf(core.sanitizeDesktopCommandRuntimes(), sb.sealed);
  assert.deepEqual(after.slice().sort(), ["deleted:other.dshpurge.bak", "stripped_cmd_inject"]);
});

test("普通（非密封）目录里的同款残留完全不参与 —— 那是用户的 npm 全局，不是安装目录", () => {
  const sb = sandbox("plain");
  const fp = put(path.join(sb.plain, "dsh.dshpurge.bak"), "#!/bin/sh\necho keep\n");
  assert.deepEqual(core.sanitizeDesktopCommandRuntimes(), []);
  assert.equal(read(fp), "#!/bin/sh\necho keep\n");
});

test("大写后缀 DSHPURGE.BAK 也认（后缀判断前先 toLowerCase），但文件名仍按精确匹配", () => {
  const sb = sandbox("upper");
  const fp = put(path.join(sb.sealed, "DSH.DSHPURGE.BAK"), "#!/bin/sh\necho o\n");
  const report = core.sanitizeDesktopCommandRuntimes();
  // 后缀靠 toLowerCase 认出来；DSH 不在 SHIM_NAMES（精确匹配）里 → 走 deleted 而不是 relocated。
  const cleaned = cleanedOf(report, sb.sealed);
  assert.equal(cleaned.length, 1, JSON.stringify(cleaned));
  assert.ok(cleaned[0].startsWith("deleted:"), cleaned[0]);
  assert.equal(fs.existsSync(fp), false);
});

test("多个密封目录各有自己的报告条目，互不合并", () => {
  const sb = sandbox("multi");
  const second = path.join(sb.localapp, "DeepSeek Harness", "runtime-commands", "bin");
  fs.mkdirSync(second, { recursive: true });
  put(path.join(sb.sealed, "a.dshpurge.bak"), "x");
  put(path.join(second, "b.dshpurge.bak"), "y");
  const report = core.sanitizeDesktopCommandRuntimes();
  assert.equal(report.length, 2);
  assert.deepEqual(cleanedOf(report, sb.sealed), ["deleted:a.dshpurge.bak"]);
  assert.deepEqual(cleanedOf(report, second), ["deleted:b.dshpurge.bak"]);
});

test("patchShim 撞上密封目录时调用 sanitize，并把这次目录的清理结果回传", async () => {
  const sb = sandbox("patch-touch");
  put(path.join(sb.sealed, "dsh"), "#!/bin/sh\n");
  put(path.join(sb.sealed, "dsh.dshpurge.bak"), "#!/bin/sh\necho original\n");
  const result = await core.patchShim(sb.sealed);
  assert.equal(result.skipped_sealed_desktop, true);
  assert.deepEqual(result.scrubbed, [{ dir: sb.sealed, cleaned: ["relocated_bak:dsh", "removed_in_bin_bak:dsh"] }]);
  // 注入本身绝不能落在密封 bin 里。
  assert.equal(read(path.join(sb.sealed, "dsh")), "#!/bin/sh\n");
  assert.equal(fs.existsSync(`${path.join(sb.sealed, "dsh")}.dshpurge.bak`), false);
});

test("sanitize 自身不写 marker、不改启动器正文 —— 它只搬 bak 与剥 cmd", () => {
  const sb = sandbox("no-inject");
  const sh = put(path.join(sb.sealed, "dsh"), "#!/bin/sh\nexec node ./bin.js\n");
  const ps1 = put(path.join(sb.sealed, "dsh.ps1"), "# launcher\n");
  core.sanitizeDesktopCommandRuntimes();
  assert.equal(read(sh), "#!/bin/sh\nexec node ./bin.js\n");
  assert.equal(read(ps1), "# launcher\n");
  assert.doesNotMatch(read(sh), new RegExp(M));
});
