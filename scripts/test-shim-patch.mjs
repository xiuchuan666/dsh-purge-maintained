/**
 * shim 注入簇（lib/core.js:4230-4696）。
 *
 * 这一段决定 `dsh` / `dsh.cmd` / `dsh.ps1` 这三个启动器会不会在启动时把
 * `DSH_HOME` 指到旁边的 `.dsh`。它坏掉的表现有两种，都不报错：
 *   - 没注入：宿主每次启动落到默认 home，用户的会话/规则集全"消失"；
 *   - 注错了：启动器变成语法错误，`dsh` 命令直接起不来。
 *
 * 所以这里钉的是「分派到了哪一支」和「落盘字节长什么样」，不是覆盖率。
 * 两个跨平台易错点写在用例里：
 *   1. `lib/core.js:40` 的 `isWindows` 是**模块级常量**，测试里改 process.platform
 *      影响不到它 —— `dsh.cmd` 那条必须按真实平台分支断言，不能用 asPlatform。
 *   2. `resolveShimWriteTarget` 里的 `process.platform` 是运行时判断，可以伪造；
 *      但它只在 fname === "dsh" 时才起作用。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../lib/core.js";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-shim-"));
const ORIG = {
  DSH_HOME: process.env.DSH_HOME,
  DSH_SURFACE: process.env.DSH_SURFACE,
  DSH_BASE: process.env.DSH_BASE,
};
/** lib/core.js:40 的模块级常量，改 process.platform 不会影响它。 */
const IS_WINDOWS = process.platform === "win32";
let seq = 0;

function sandbox(tag = "s") {
  seq += 1;
  const root = path.join(SANDBOX, `${tag}-${seq}`);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  process.env.DSH_HOME = home;
  process.env.DSH_SURFACE = "web";
  delete process.env.DSH_BASE;
  core.resetPathMemo();
  return { root, home, bin };
}

function put(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
  return fp;
}

const read = (fp) => fs.readFileSync(fp, "utf8");
const SHEBANG_SH = "#!/bin/sh\nexec node ./bin.js \"$@\"\n";
const countOf = (text, needle) => text.split(needle).length - 1;

test.after(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 入口守卫

test("patchShim 没有目录时直接回 no_shim_dir，不试着猜一个", async () => {
  assert.deepEqual(await core.patchShim(""), { error: "no_shim_dir" });
  assert.deepEqual(await core.patchShim(null), { error: "no_shim_dir" });
  assert.deepEqual(await core.patchShim(undefined), { error: "no_shim_dir" });
});

test("空目录里三个启动器都记 missing，且不新建任何文件", async () => {
  const sb = sandbox("empty");
  const result = await core.patchShim(sb.bin);
  assert.deepEqual(result, { "dsh.cmd": "missing", "dsh.ps1": "missing", dsh: "missing" });
  assert.deepEqual(fs.readdirSync(sb.bin), []);
});

test("三个名字的顺序固定是 dsh.cmd / dsh.ps1 / dsh", async () => {
  const sb = sandbox("order");
  const result = await core.patchShim(sb.bin);
  assert.deepEqual(Object.keys(result), ["dsh.cmd", "dsh.ps1", "dsh"]);
});

// ------------------------------------------------------- 文件形态分派

test("带 NUL 字节的二进制记 skipped_binary，一个字节都不读进内存", async () => {
  const sb = sandbox("binary");
  const fp = path.join(sb.bin, "dsh");
  fs.writeFileSync(fp, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]));
  const before = fs.readFileSync(fp);
  const result = await core.patchShim(sb.bin);
  assert.equal(result.dsh, "skipped_binary");
  assert.deepEqual(fs.readFileSync(fp), before);
});

test("零字节文件也判 skipped_binary（读不到任何前缀）", async () => {
  const sb = sandbox("zero");
  put(path.join(sb.bin, "dsh"), "");
  const result = await core.patchShim(sb.bin);
  assert.equal(result.dsh, "skipped_binary");
  assert.equal(read(path.join(sb.bin, "dsh")), "");
});

test("dsh.ps1 只认 #! / @echo / REM / '# ' 四种开头，纯 Write-Host 开头算二进制", async () => {
  const sb = sandbox("ps1bare");
  put(path.join(sb.bin, "dsh.ps1"), "Write-Host hi\n");
  const result = await core.patchShim(sb.bin);
  assert.equal(result["dsh.ps1"], "skipped_binary");
  assert.equal(read(path.join(sb.bin, "dsh.ps1")), "Write-Host hi\n");
});

test("前 512 字节里的 NUL 就足以判二进制（不是只看前 120 字节的开头判据）", async () => {
  // 判据分两段：整段 512 字节里有没有 NUL（判二进制），再拿前 120 字节看开头形态。
  // 把 NUL 放在偏移 300，只读 120 字节的实现会误判成文本并往里写注入块。
  const sb = sandbox("nul300");
  const fp = path.join(sb.bin, "dsh");
  const head = "#!/bin/sh\n" + "x".repeat(289) + "\n";
  const buf = Buffer.concat([Buffer.from(head, "utf8"), Buffer.from([0x00]), Buffer.from("\necho hi\n", "utf8")]);
  assert.ok(buf.indexOf(0) > 120 && buf.indexOf(0) < 512, `NUL 位置 ${buf.indexOf(0)}`);
  fs.writeFileSync(fp, buf);
  const before = fs.readFileSync(fp);
  const result = await core.patchShim(sb.bin);
  assert.equal(result.dsh, "skipped_binary");
  assert.deepEqual(fs.readFileSync(fp), before);
});

test("dsh.ps1 带 '# ' 注释头时按 ps1 注入，块在文件最前（无 shebang 可插）", async () => {
  const sb = sandbox("ps1ok");
  const fp = put(path.join(sb.bin, "dsh.ps1"), "# dsh launcher\nWrite-Host hi\n");
  const result = await core.patchShim(sb.bin);
  assert.equal(result["dsh.ps1"], "patched");
  const text = read(fp);
  assert.ok(text.startsWith("# dsh-purge shim begin\n"));
  assert.ok(text.includes("if (-not $env:DSH_HOME) {"));
  assert.ok(text.includes("$env:DSH_HOME = $cand; break"));
  assert.ok(text.endsWith("# dsh launcher\nWrite-Host hi\n"));
});

// --------------------------------------------------------- 注入与幂等

test("sh 启动器：注入块紧跟在 shebang 之后，原有正文一字不动", async () => {
  const sb = sandbox("sh");
  const fp = put(path.join(sb.bin, "dsh"), SHEBANG_SH);
  const result = await core.patchShim(sb.bin);
  assert.equal(result.dsh, "patched");
  const text = read(fp);
  assert.ok(text.startsWith("#!/bin/sh\n# dsh-purge shim begin\n"));
  assert.ok(text.includes('_dsh_shim_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)'));
  assert.ok(text.includes("export DSH_HOME"));
  assert.ok(text.endsWith("# dsh-purge shim end\nexec node ./bin.js \"$@\"\n"));
});

test("打补丁前先留一份 .dshpurge.bak，内容就是原文", async () => {
  const sb = sandbox("bak");
  const fp = put(path.join(sb.bin, "dsh"), SHEBANG_SH);
  await core.patchShim(sb.bin);
  const bak = `${fp}.dshpurge.bak`;
  assert.ok(fs.existsSync(bak));
  assert.equal(read(bak), SHEBANG_SH);
});

test("已打好且是最新形态时回 already_patched，且不再改文件", async () => {
  const sb = sandbox("again");
  const fp = put(path.join(sb.bin, "dsh"), SHEBANG_SH);
  await core.patchShim(sb.bin);
  const first = read(fp);
  const mtime = fs.statSync(fp).mtimeMs;
  const second = await core.patchShim(sb.bin);
  assert.equal(second.dsh, "already_patched");
  assert.equal(read(fp), first);
  assert.equal(fs.statSync(fp).mtimeMs, mtime);
});

test("already_patched 时不重建被删掉的 bak（已经打好的文件不需要回退路）", async () => {
  const sb = sandbox("nobak");
  const fp = put(path.join(sb.bin, "dsh"), SHEBANG_SH);
  await core.patchShim(sb.bin);
  fs.unlinkSync(`${fp}.dshpurge.bak`);
  const third = await core.patchShim(sb.bin);
  assert.equal(third.dsh, "already_patched");
  assert.equal(fs.existsSync(`${fp}.dshpurge.bak`), false);
});

test("shimIsPatched 只认 'dsh-purge shim' 字样；shimFileStatus 还认 'dsh-purge cli entry'", async () => {
  const sb = sandbox("status");
  const patched = put(path.join(sb.bin, "dsh"), SHEBANG_SH);
  await core.patchShim(sb.bin);
  assert.equal(core.shimIsPatched(patched), true);
  assert.equal(core.shimFileStatus(patched), "patched");

  // 两个判据不一致：cli entry 算 patched，但不算"打过 shim"。
  const cli = put(path.join(sb.bin, "other"), "#!/bin/sh\n// dsh-purge cli entry\necho hi\n");
  assert.equal(core.shimFileStatus(cli), "patched");
  assert.equal(core.shimIsPatched(cli), false);
});

test("shimFileStatus 对不存在的文件回 missing，对二进制回 binary", async () => {
  const sb = sandbox("status2");
  assert.equal(core.shimFileStatus(path.join(sb.bin, "nope")), "missing");
  const bin = path.join(sb.bin, "blob");
  fs.writeFileSync(bin, Buffer.from([0x00, 0x01]));
  assert.equal(core.shimFileStatus(bin), "binary");
});

test("shimFileStatus 读到读不了的文件时回 original，不抛", async () => {  const sb = sandbox("status3");
  const fp = put(path.join(sb.bin, "dsh"), "#!/bin/sh\necho hi\n");
  const desc = Object.getOwnPropertyDescriptor(fs, "readFileSync");
  assert.ok(desc && desc.writable, "readFileSync 必须可替换，否则这条测不出");
  const orig = fs.readFileSync;
  try {
    fs.readFileSync = () => {
      throw new Error("boom");
    };
    assert.equal(core.shimFileStatus(fp), "original");
  } finally {
    fs.readFileSync = orig;
  }
});

// ------------------------------------------------------------ cmd 分支
test("isTextShim 读不了文件时判二进制（跳过），不冒险往里写", async () => {
  // isTextShim 的 catch 分支只有在 openSync / readSync 抛错时才走到。
  // 判 false 的后果是「这个启动器被跳过」，判 true 的后果是「继续往下写一个读不了的文件」。
  const sb = sandbox("textshim-err");
  const fp = put(path.join(sb.bin, "dsh"), "#!/bin/sh\\necho hi\\n");
  const descOpen = Object.getOwnPropertyDescriptor(fs, "openSync");
  assert.ok(descOpen && descOpen.writable, "openSync 必须可替换，否则这条测不出");
  const origOpen = fs.openSync;
  try {
    fs.openSync = () => {
      throw new Error("nope");
    };
    const result = await core.patchShim(sb.bin);
    assert.equal(result.dsh, "skipped_binary");
    assert.equal(read(fp), "#!/bin/sh\\necho hi\\n", "被跳过就不该改文件");
  } finally {
    fs.openSync = origOpen;
  }
});

test("dsh.cmd 的分派看模块级 isWindows：Windows 上只剥不注入，别的平台当成 cmd 注入", async () => {
  const sb = sandbox("cmd");
  const fp = put(path.join(sb.bin, "dsh.cmd"), "@ECHO off\r\nnode bin.js %*\r\n");
  const result = await core.patchShim(sb.bin);
  const text = read(fp);
  if (IS_WINDOWS) {
    // .cmd 启动器会闪控制台，Windows 上永不注入。
    assert.equal(result["dsh.cmd"], "skipped_win_cmd");
    assert.equal(text, "@ECHO off\r\nnode bin.js %*\r\n");
  } else {
    // 非 Windows 走通用注入：cmd 块插在 @echo 行之后。
    assert.equal(result["dsh.cmd"], "patched");
    assert.ok(text.startsWith("@ECHO off\r\nREM dsh-purge shim begin\n"));
    assert.ok(text.includes('IF NOT DEFINED DSH_HOME IF EXIST "%~dp0..\\.dsh\\"'));
  }
});

test("dsh.cmd 已带注入时，Windows 上剥成 stripped_win_cmd", async () => {
  const sb = sandbox("cmd2");
  const fp = put(
    path.join(sb.bin, "dsh.cmd"),
    '@ECHO off\nREM dsh-purge shim begin\nIF NOT DEFINED DSH_HOME SET "DSH_HOME=x"\nREM dsh-purge shim end\nnode bin.js %*\n',
  );
  const result = await core.patchShim(sb.bin);
  if (!IS_WINDOWS) {
    // 非 Windows 上走通用注入，已 patched 就是 already_patched。
    assert.equal(result["dsh.cmd"], "already_patched");
    return;
  }
  assert.equal(result["dsh.cmd"], "stripped_win_cmd");
  const text = read(fp);
  assert.equal(countOf(text, "dsh-purge shim end"), 0);
  // 现状锁定：begin 行是"占位"，剥完还留着。
  assert.equal(countOf(text, "dsh-purge shim begin"), 1);
  assert.ok(text.includes("node bin.js %*"));
});

test("cmd 里没有 @echo 行时，注入块前面补一条 @ECHO off", async () => {
  const sb = sandbox("cmdnoecho");
  const fp = put(path.join(sb.bin, "dsh.cmd"), "REM hello\nnode bin.js %*\n");
  const result = await core.patchShim(sb.bin);
  if (IS_WINDOWS) {
    assert.equal(result["dsh.cmd"], "skipped_win_cmd");
    return;
  }
  assert.equal(result["dsh.cmd"], "patched");
  assert.ok(read(fp).startsWith("@ECHO off\nREM dsh-purge shim begin\n"));
});

// ------------------------------------------------------ legacy 与剥离

test("带 legacy DSH_PERMISSION_MODE 的启动器先剥旧注入、再按新形态打一遍", async () => {
  const sb = sandbox("legacy");
  const fp = put(
    path.join(sb.bin, "dsh"),
    "#!/bin/sh\nDSH_PERMISSION_MODE=3\n// dsh-purge shim begin\nx\n",
  );
  const result = await core.patchShim(sb.bin);
  assert.equal(result.dsh, "patched");
  const text = read(fp);
  assert.ok(text.startsWith("#!/bin/sh\n# dsh-purge shim begin\n"));
  assert.equal(countOf(text, "DSH_PERMISSION_MODE"), 1);
  assert.ok(text.includes("DSH_PERMISSION_MODE=3"));
});

test("legacy pin 让 shimInjectCurrent 判假：即便已经注入过也会重打一遍", async () => {
  // shimInjectCurrent 第一句就是 `if (hasLegacyPermissionPin(text)) return false;`。
  // 删掉那句，这个文件会被判 already_patched 而留着旧的 DSH_PERMISSION_MODE 权限钉。
  const sb = sandbox("legacypin");
  const fp = put(
    path.join(sb.bin, "dsh"),
    "#!/bin/sh\nDSH_PERMISSION_MODE=3\nDSH_HOME=/x\n# dsh-purge shim begin\nDSH_HOME=y\n# dsh-purge shim end\necho hi\n",
  );
  const result = await core.patchShim(sb.bin);
  assert.equal(result.dsh, "patched");
  const text = read(fp);
  // 旧块体必须真的被剥掉 —— 只叠不打的话 DSH_HOME=y 会留在文件里。
  assert.equal(countOf(text, "DSH_HOME=y"), 0);
  // 现状锁定：剥离只删块体、保留 begin 占位行，所以再插一遍就成了两个 begin。
  assert.equal(countOf(text, "dsh-purge shim begin"), 2);
});

test("旧格式单行头（# dsh-purge shim + DSH_HOME 行）会被整段换成新块", async () => {
  const sb = sandbox("oldheader");
  const fp = put(path.join(sb.bin, "dsh"), "#!/bin/sh\n# dsh-purge shim\nDSH_HOME=/x\necho hi\n");
  const result = await core.patchShim(sb.bin);
  assert.equal(result.dsh, "patched");
  const text = read(fp);
  assert.equal(countOf(text, "# dsh-purge shim\n"), 0);
  assert.equal(countOf(text, "dsh-purge shim begin"), 1);
  assert.ok(text.endsWith("# dsh-purge shim end\necho hi\n"));
});

test("stripShimInject：闭合块整段剥掉，begin 行作为占位保留", () => {
  assert.equal(
    core.stripShimInject("A\n# dsh-purge shim begin\nX\n# dsh-purge shim end\nB\n"),
    "A\n# dsh-purge shim begin\nB\n",
  );
});

test("stripShimInject：旧格式单行头之后紧跟的 DSH_HOME / DSH_PERMISSION_MODE 行一起删", () => {
  assert.equal(
    core.stripShimInject("A\n# dsh-purge shim\nDSH_HOME=x\nDSH_PERMISSION_MODE=3\nKEEP\nB\n"),
    "A\nKEEP\nB\n",
  );
});

test("stripShimInject：旧头之后第一条不是注入行的，就复位、后面不再删", () => {
  assert.equal(
    core.stripShimInject("A\nREM dsh-purge shim\nKEEP\nDSH_HOME=x\nB\n"),
    "A\nKEEP\nDSH_HOME=x\nB\n",
  );
});

test("stripShimInject：begin 没有配对 end 时整份原文返回，绝不删用户正文", () => {
  const text = "#!/bin/sh\n# dsh-purge shim begin\nX\necho hi\n";
  assert.equal(core.stripShimInject(text), text);
});

test("stripShimInject：没有任何注入痕迹时原样返回", () => {
  assert.equal(core.stripShimInject("echo hi\n"), "echo hi\n");
});

test("stripShimInject：末行没有换行时，只留下 begin 占位行", () => {
  assert.equal(
    core.stripShimInject("# dsh-purge shim begin\nX\n# dsh-purge shim end"),
    "# dsh-purge shim begin\n",
  );
});

test("现状锁定：悬空 begin 的文件会被再注入一次，变成两个 begin", async () => {
  // 因为 stripShimInject 拒绝剥离未闭合的块，而 shimInjectCurrent 只要求
  // "有 begin 字样 + 有 DSH_HOME"，悬空 begin 的文件被当成"没打过"。
  const sb = sandbox("dangling");
  const fp = put(path.join(sb.bin, "dsh"), "#!/bin/sh\n# dsh-purge shim begin\necho hi\n");
  const result = await core.patchShim(sb.bin);
  assert.equal(result.dsh, "patched");
  assert.equal(countOf(read(fp), "dsh-purge shim begin"), 2);

  // 二次调用就稳了（两个 begin 都在，shimInjectCurrent 满足）。
  const again = await core.patchShim(sb.bin);
  assert.equal(again.dsh, "already_patched");
  assert.equal(countOf(read(fp), "dsh-purge shim begin"), 2);
});

// ------------------------------------------------------- symlink 分支

test("指向真实文件的符号链接：写的是目标文件，链接本身保持不变", async () => {
  const sb = sandbox("link");
  const target = put(path.join(sb.root, "pkg", "bin.js"), "#!/usr/bin/env node\nconsole.log('real')\n");
  const link = path.join(sb.bin, "dsh");
  try {
    fs.symlinkSync(target, link, "file");
  } catch (e) {
    if (process.platform === "win32") {
      // Windows 上非管理员默认不能建符号链接，跳过但说清楚。
      assert.ok(String(e).length > 0);
      return;
    }
    throw e;
  }
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  const result = await core.patchShim(sb.bin);
  // node shebang 但没有 app-boot 可解析 → 写完记 module_root_lost。
  assert.equal(result.dsh, "error:module_root_lost");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.ok(read(target).includes("dsh-purge shim begin"));
  assert.ok(fs.existsSync(`${target}.dshpurge.bak`));
});

test("悬空符号链接：resolveShimWriteTarget 拿不到真实路径就记 error:symlink:", async () => {
  const sb = sandbox("deadlink");
  const link = path.join(sb.bin, "dsh");
  try {
    fs.symlinkSync(path.join(sb.root, "not-there.js"), link, "file");
  } catch {
    return; // Windows 非管理员建不了链接
  }
  const result = await core.patchShim(sb.bin);
  // isFile 先判一次：悬空链接 isFile 为 false → missing。
  assert.ok(result.dsh === "missing" || String(result.dsh).startsWith("error:"), result.dsh);
});

// --------------------------------------------------- module_root_lost

test("node shebang 但找不到 dsh-app-boot：Windows 上是**写完**才发现（module_root_lost），别的平台事前就拦下", async () => {
  // 两条路的先后不一样，是 resolveShimWriteTarget 里平台判断的位置造成的：
  //   Windows：第 ② 步 `process.platform === "win32"` 直接返回，第 ④ 步的
  //            "node 但没有 module root" 守卫根本没机会跑 → 先写，写完再报错；
  //   其它平台：第 ④ 步先拦 → 一个字节都不写，返回 skipped_no_module_root。
  const sb = sandbox("mrl");
  const fp = put(path.join(sb.bin, "dsh"), "#!/usr/bin/env node\nconsole.log(1)\n");
  const result = await core.patchShim(sb.bin);
  if (IS_WINDOWS) {
    assert.equal(result.dsh, "error:module_root_lost");
    assert.ok(read(fp).includes("dsh-purge shim begin"));
    assert.ok(fs.existsSync(`${fp}.dshpurge.bak`));
  } else {
    assert.equal(result.dsh, "skipped_no_module_root");
    assert.equal(read(fp), "#!/usr/bin/env node\nconsole.log(1)\n");
    assert.equal(fs.existsSync(`${fp}.dshpurge.bak`), false);
  }
});

test("有 dsh-app-boot 可解析时不报 module_root_lost", async () => {
  const sb = sandbox("mrl-ok");
  fs.mkdirSync(path.join(sb.bin, "node_modules", "@deepseek-ai", "dsh-app-boot"), { recursive: true });
  put(path.join(sb.bin, "dsh"), "#!/usr/bin/env node\nconsole.log(1)\n");
  const result = await core.patchShim(sb.bin);
  assert.equal(result.dsh, "patched");
});

// -------------------------------------------------------------- 备份

test("bak 已存在时绝不覆盖（旧备份宁可留旧，也不能盖掉真原文）", async () => {
  const sb = sandbox("bakstale");
  const fp = put(path.join(sb.bin, "dsh"), "#!/bin/sh\necho new\n");
  put(`${fp}.dshpurge.bak`, "#!/bin/sh\necho OLD\n");
  const result = await core.patchShim(sb.bin);
  assert.equal(result.dsh, "patched");
  assert.equal(read(`${fp}.dshpurge.bak`), "#!/bin/sh\necho OLD\n");
});

test("复制备份失败时记 bak_failed:…，但仍然照写（不阻断打补丁）", async () => {
  const sb = sandbox("bakfail");
  const fp = put(path.join(sb.bin, "dsh"), SHEBANG_SH);
  const desc = Object.getOwnPropertyDescriptor(fs.promises, "copyFile");
  if (!desc || !desc.writable) {
    assert.fail("fs.promises.copyFile 必须可替换，否则这条测不出");
  }
  const orig = fs.promises.copyFile;
  let result;
  try {
    fs.promises.copyFile = async () => {
      throw new Error("boom");
    };
    result = await core.patchShim(sb.bin);
  } finally {
    fs.promises.copyFile = orig;
  }
  assert.equal(result["dsh#bak"], "bak_failed:boom");
  assert.equal(result.dsh, "patched");
  assert.ok(read(fp).includes("dsh-purge shim begin"));
  assert.equal(fs.existsSync(`${fp}.dshpurge.bak`), false);
});

test("写盘失败回 error: 前缀（本平台不允许写只读文件时才校验）", async (t) => {
  const sb = sandbox("readonly");
  const fp = put(path.join(sb.bin, "dsh"), SHEBANG_SH);
  try {
    fs.chmodSync(fp, 0o444);
  } catch {
    t.skip("当前文件系统不支持 chmod");
    return;
  }
  try {
    fs.writeFileSync(fp, "probe");
    t.skip("当前账号/文件系统允许写只读文件，这条分支测不出来");
    return;
  } catch {
    // 期望：写不进去
  }
  const result = await core.patchShim(sb.bin);
  assert.ok(String(result.dsh).startsWith("error:"), String(result.dsh));
  assert.ok(String(result.dsh).includes("EPERM"), String(result.dsh));
  // bak 在写入之前就落好了，所以失败也有回退路。
  assert.ok(fs.existsSync(`${fp}.dshpurge.bak`));
  fs.chmodSync(fp, 0o666);
});

// ------------------------------------------------------- 密封桌面目录

test("密封运行时目录（…/host-commands/bin）直接短路，不注入也不写 bak", async () => {
  const sb = sandbox("sealed");
  const sealed = path.join(sb.root, "AppData", "Roaming", "DSH Desktop", "host-commands", "bin");
  const fp = put(path.join(sealed, "dsh"), "#!/bin/sh\n# dsh-purge shim begin\n# dsh-purge shim end\necho hi\n");
  const before = read(fp);
  assert.equal(core.isDesktopCommandRuntimeDir(sealed), true);
  const result = await core.patchShim(sealed);
  assert.equal(result.skipped_sealed_desktop, true);
  assert.ok(Array.isArray(result.scrubbed));
  assert.equal(read(fp), before);
  assert.deepEqual(fs.readdirSync(sealed), ["dsh"]);
});

test("DeepSeek Harness 的 runtime-commands/bin 也算密封目录", async () => {
  const sb = sandbox("sealed2");
  const sealed = path.join(sb.root, "AppData", "Local", "DeepSeek Harness", "runtime-commands", "bin");
  put(path.join(sealed, "dsh"), "#!/bin/sh\necho x\n");
  assert.equal(core.isDesktopCommandRuntimeDir(sealed), true);
  const result = await core.patchShim(sealed);
  assert.equal(result.skipped_sealed_desktop, true);
  assert.deepEqual(fs.readdirSync(sealed), ["dsh"]);
});

test("名字像桌面但不是 bin 结尾的目录不算密封", () => {
  assert.equal(core.isDesktopCommandRuntimeDir("C:/AppData/Roaming/DSH Desktop/host-commands/lib"), false);
  assert.equal(core.isDesktopCommandRuntimeDir(""), false);
  assert.equal(core.isDesktopCommandRuntimeDir(null), false);
});

test("shimBackupPath 对普通目录用同目录 .bak，对密封目录搬到 $DSH_HOME/dsh-purge/shim-backups", () => {
  const sb = sandbox("bakpath");
  const plain = path.join(sb.bin, "dsh");
  assert.equal(core.shimBackupPath(plain), `${plain}.dshpurge.bak`);

  const sealed = path.join(sb.root, "AppData", "Roaming", "DSH Desktop", "host-commands", "bin", "dsh");
  const bak = core.shimBackupPath(sealed);
  assert.ok(bak.startsWith(path.join(sb.home, "dsh-purge", "shim-backups")));
  assert.match(path.basename(bak), /^dsh\.[0-9a-f]{20}\.bak$/);
  // 备份绝不落在密封 bin 里面。
  assert.notEqual(path.dirname(bak), path.dirname(sealed));
});

test("shimBackupPath 的摘要吃整个路径：两个不同密封目录的同名启动器不会撞备份名", () => {
  // 摘要若不算路径（比如固定成常量），两台宿主装在同一台机器上就会互相覆盖备份。
  const sb = sandbox("baknames");
  const a = path.join(sb.root, "A", "DSH Desktop", "host-commands", "bin", "dsh");
  const b = path.join(sb.root, "B", "DSH Desktop", "host-commands", "bin", "dsh");
  const bakA = core.shimBackupPath(a);
  const bakB = core.shimBackupPath(b);
  assert.notEqual(bakA, bakB);
  assert.equal(path.dirname(bakA), path.dirname(bakB));
});

// --------------------------------------------------------- patchAllShims

test("patchAllShims 在 desktop 面一个目录都不扫（listShimDirsForPatch 返回空）", async () => {
  const sb = sandbox("alldesktop");
  process.env.DSH_SURFACE = "desktop";
  core.resetPathMemo();
  assert.deepEqual(core.listShimDirsForPatch(), []);
  assert.deepEqual(await core.patchAllShims(), {});
  process.env.DSH_SURFACE = "web";
  core.resetPathMemo();
});

// 注意：这里**故意不测** web 面上 patchAllShims 的聚合循环。
// 它会把 listShimDirsForPatch() 里每个真实目录（本机就是 %APPDATA%\npm）
// 依次 patchShim 一遍 —— 也就是说跑一次测试就改掉本机真实的 dsh 启动器。
// 内容幂等不等于没有副作用：将来 once shimInjectFor 的块文本变了，这条测试
// 就会静默把用户的启动器重写成新形态，而测试本身还是绿的。
// 同样的取舍见 scripts/test-reapply-flows.mjs 里的 reapplyInstalled。

test("listShimDirsForPatch 一定过滤掉密封目录", () => {
  for (const dir of core.listShimDirsForPatch()) {
    assert.equal(core.isDesktopCommandRuntimeDir(dir), false, dir);
  }
});

test("PATH 上的密封 bin 会被 listShimDirsForPatch 剔掉，普通 bin 会留下", () => {
  // 光跑「结果里没有密封目录」这条，在真机上永远满足（本机 PATH 上没有密封 bin）。
  // 所以这里自己把一个密封形状的目录塞进 PATH：不过滤的实现会把它收进来。
  const sb = sandbox("pathsealed");
  const origPath = process.env.PATH || "";
  const sealedBin = path.join(sb.root, "DSH Desktop", "host-commands", "bin");
  const plainBin = path.join(sb.root, "plainbin");
  put(path.join(sealedBin, "dsh"), "#!/bin/sh\necho x\n");
  put(path.join(plainBin, "dsh"), "#!/bin/sh\necho y\n");
  assert.equal(core.isDesktopCommandRuntimeDir(sealedBin), true);
  try {
    process.env.PATH = `${origPath}${path.delimiter}${sealedBin}`;
    core.resetPathMemo();
    const sealedOnPath = core.listShimDirsForPatch();
    assert.equal(sealedOnPath.includes(sealedBin), false, "密封 bin 不该被扫");

    process.env.PATH = `${origPath}${path.delimiter}${plainBin}`;
    core.resetPathMemo();
    const plainOnPath = core.listShimDirsForPatch();
    // 前提校验：PATH 扫描本身是生效的，否则上面那条「不含密封目录」毫无意义。
    assert.equal(plainOnPath.includes(plainBin), true, "普通 bin 应该被扫进来");
  } finally {
    process.env.PATH = origPath;
    core.resetPathMemo();
  }
});

test("stripShimInject：遇到 end 就把 blockStart 清回 -1（源码形状）", () => {
  // 行为上测不出：关块之后 inBlock 已是 false，末尾那道
  // `if (inBlock && blockStart >= 0) return text;` 根本不会看 blockStart；
  // 下一块 begin 又会把 blockStart 重新赋值。留着这条断言是为了防止有人
  // 把「未闭合探测」改成依赖残留的 blockStart。
  const src = fs.readFileSync(new URL("../lib/core.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l === "export function stripShimInject(text) {");
  assert.ok(start > 0, "stripShimInject 必须还在");
  const body = lines.slice(start, start + 40);
  const closeAt = body.findIndex((l) => l === '      if (ln.includes("dsh-purge shim end")) {');
  assert.ok(closeAt > 0, "关块分支必须还在");
  assert.equal(body[closeAt + 1], "        inBlock = false;");
  assert.equal(body[closeAt + 2], "        blockStart = -1;");
});

// ------------------------------------------------------------ 只在 Linux 上生效的分支

// .cmd 的注入形态（@ECHO off 兜底）在 Windows 上走不到：模块级 isWindows 为真时
// .cmd 一律只剥不注入。这条分支由 CI 的 ubuntu-latest 覆盖，本机 drill 里会显示 GREEN。
// 这是「一台机器测不全」的既有取舍，不是漏测，记在 docs/test-map.md 的盲区里。
// 为了让本机 drill 也能抓住「有人把兜底删了」，加一条源码形状断言。
test("@ECHO off 兜底那一行必须还在（Windows 上走不到，靠 Linux CI 跑行为）", () => {
  const src = fs.readFileSync(new URL("../lib/core.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(src.includes('    return "@ECHO off\\n" + inject.text + text;'), "cmd 兜底行必须保留");
});
