// 官方 CLI 三件套（resources/runtime/cli/bin 下的 dsh / dsh.cmd / dsh.ps1）的修补与自愈。
//
// 这一簇的价值在「装完就能用」那一步：0.2.2-rc.1 的安装包根本不下发 runtime/cli/bin，
// 而 dsh 命令一启动就依赖它；修不上的表现是「命令行报 not recognized」，不报任何错。
//
// 两个纯函数（patchOfficialCliShimText / patchOfficialCliCmdText）是幂等升级的核心：
// 先铲旧块、再把裸 asar 路径归一成 $entry / %entry%、最后插最新三级回退块。
// 因此这里同时钉「第一次改什么」和「第二次为什么什么都不改」。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-cli-repair-tmp-"));
const ORIG_TMP = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
process.env.TEMP = TMP_ROOT;
process.env.TMP = TMP_ROOT;
process.env.TMPDIR = TMP_ROOT;

const ORIG_HOME = process.env.DSH_HOME;
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-cli-repair-"));
process.env.DSH_HOME = path.join(SANDBOX, "home");

// 模块顶层就要算 INTERNAL_LOG_PATH，所以必须先改 TEMP 再动态 import。
const d = await import("../lib/desktop.js");

const BIN = "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js";
const SH_ASAR_ENTRY = `$resources/app.asar/${BIN}`;
const CMD_ASAR_REL = `%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js`;

function box(tag) {
  const dir = path.join(SANDBOX, tag);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function put(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text);
  return fp;
}

const SH_SRC = [
  "#!/bin/sh",
  'resources=$(dirname "$0")',
  `ELECTRON_RUN_AS_NODE=1 exec "$resources/DeepSeek Harness.exe" "$resources/app.asar/${BIN}" "$@"`,
  "",
].join("\n");

const CMD_SRC = [
  "@ECHO off",
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" "' + CMD_ASAR_REL + '" %*',
  "",
].join("\r\n");

test.after(() => {
  for (const key of ["TEMP", "TMP", "TMPDIR"]) {
    if (ORIG_TMP[key] === undefined) delete process.env[key];
    else process.env[key] = ORIG_TMP[key];
  }
  if (ORIG_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIG_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ sh 启动器 */

test("sh 启动器：裸 asar 路径归一成 $entry，并在这行之前插入三级回退块", () => {
  const r = d.patchOfficialCliShimText(SH_SRC);
  assert.equal(r.changed, true);
  assert.equal(r.already, undefined);
  // 原路径只出现一次（就是块里的 entry= 那一行），调用点已经变成 "$entry"
  assert.equal(r.text.split(SH_ASAR_ENTRY).length - 1, 1);
  assert.ok(r.text.includes('exec "$resources/DeepSeek Harness.exe" "$entry" "$@"'));
  // 块必须插在 ELECTRON_RUN_AS_NODE 那一行的行首，而不是把行劈开
  assert.ok(r.text.indexOf("# dsh-purge cli entry begin") < r.text.indexOf("ELECTRON_RUN_AS_NODE=1"));
  assert.ok(r.text.startsWith("#!/bin/sh\nresources=$(dirname \"$0\")\n# dsh-purge cli entry begin\n"));
  assert.ok(r.text.includes("# dsh-purge cli entry end\nELECTRON_RUN_AS_NODE=1"));
});

test("sh 启动器：第二次调用回 already，并且一个字节都不改（幂等的判据）", () => {
  const once = d.patchOfficialCliShimText(SH_SRC);
  const twice = d.patchOfficialCliShimText(once.text);
  assert.equal(twice.changed, false);
  assert.equal(twice.already, true);
  assert.equal(twice.text, once.text);
});

test("sh 启动器：老版本的两级回退块会被升级成三级（不是当成已打好）", () => {
  const twoLevel = [
    "#!/bin/sh",
    'resources=$(dirname "$0")',
    "# dsh-purge cli entry begin",
    `entry="$resources/app.asar/${BIN}"`,
    `if [ ! -f "$entry" ]; then entry="$resources/app.asar.unpacked/${BIN}"; fi`,
    "# dsh-purge cli entry end",
    "",
    'ELECTRON_RUN_AS_NODE=1 exec "$resources/DeepSeek Harness.exe" "$entry" "$@"',
    "",
  ].join("\n");
  const r = d.patchOfficialCliShimText(twoLevel);
  assert.equal(r.changed, true);
  assert.ok(r.text.includes(`$resources/app/${BIN}`), "缺 app/ 那一级回退");
  assert.equal(r.text.split("# dsh-purge cli entry begin").length - 1, 1, "旧块没有铲干净");
});

test("sh 启动器：没有 ELECTRON_RUN_AS_NODE 行时整块前置", () => {
  const src = `#!/bin/sh\nexec "$resources/app.asar/${BIN}"\n`;
  const r = d.patchOfficialCliShimText(src);
  assert.equal(r.changed, true);
  assert.ok(r.text.startsWith("# dsh-purge cli entry begin\n"));
});

test("sh 启动器：空文本与无关脚本都原样返回，且不带 already 键", () => {
  assert.deepEqual(d.patchOfficialCliShimText(""), { changed: false, text: "" });
  const other = "#!/bin/sh\necho hi\n";
  const r = d.patchOfficialCliShimText(other);
  assert.deepEqual(r, { changed: false, text: other });
});

/* ------------------------------------------------------------------ cmd 启动器 */

test("cmd 启动器：块插在 ELECTRON_RUN_AS_NODE 之后，裸路径归一成 %entry%，换行跟随原文", () => {
  const r = d.patchOfficialCliCmdText(CMD_SRC);
  assert.equal(r.changed, true);
  assert.ok(r.text.includes("\r\n"), "应该保持 CRLF");
  assert.ok(r.text.indexOf('set "ELECTRON_RUN_AS_NODE=1"') < r.text.indexOf("REM dsh-purge cli entry begin"));
  assert.ok(r.text.includes('"%entry%" %*'));
  assert.equal(r.text.split(CMD_ASAR_REL).length - 1, 1, "裸路径应该只剩块里那一处");
  assert.equal(d.cmdEntryAlreadyGood(r.text), true);
});

test("cmd 启动器：第二次调用回 already", () => {
  const once = d.patchOfficialCliCmdText(CMD_SRC);
  const twice = d.patchOfficialCliCmdText(once.text);
  assert.equal(twice.changed, false);
  assert.equal(twice.already, true);
  assert.equal(twice.text, once.text);
});

test("cmd 启动器：空文本原样返回", () => {
  assert.deepEqual(d.patchOfficialCliCmdText(""), { changed: false, text: "" });
});

test("cmd 启动器：没有 %~dp0 前缀时宁可什么都不做（绝对路径拼不出相对回退）", () => {
  const abs = [
    "@ECHO off",
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"C:\\Apps\\DeepSeek Harness.exe" "C:\\Apps\\resources\\app.asar\\${BIN.replace(/\//g, "\\")}" %*`,
    "",
  ].join("\r\n");
  const r = d.patchOfficialCliCmdText(abs);
  assert.equal(r.changed, false);
  assert.equal(r.text, abs);
});

test("cmd 启动器：cmdEntryAlreadyGood 见到缺 END 的残块要判否（否则永远不会重打）", () => {
  const once = d.patchOfficialCliCmdText(CMD_SRC);
  const broken = once.text.replace("REM dsh-purge cli entry end\r\n", "");
  assert.equal(d.cmdEntryAlreadyGood(once.text), true);
  assert.equal(d.cmdEntryAlreadyGood(broken), false);
});

/* ------------------------------------------------------- 三件套的生成体与块剥离 */

test("officialCliShimBodies：三件套都从 resources 退三级找入口、退四级找 exe", () => {
  const b = d.officialCliShimBodies("DeepSeek Harness.exe");
  assert.equal(b.sh.split("\n")[0], "#!/bin/sh");
  assert.equal(
    b.sh.split("\n")[7],
    'ELECTRON_RUN_AS_NODE=1 exec "$(dirname "$resources")/DeepSeek Harness.exe" "$entry" "$@"',
  );
  assert.equal(b.cmd.split("\r\n")[0], "@ECHO off");
  // shim 在 resources\runtime\cli\bin\ 下：入口退三级、宿主 exe 退四级（搞错这一级就是 not recognized）
  assert.ok(b.cmd.includes('"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe"'));
  assert.ok(b.cmd.includes('set "entry=%~dp0..\\..\\..\\app.asar\\'));
  const ps1 = b.ps1.split("\r\n");
  assert.equal(ps1[0], "# dsh-purge cli entry begin", "ps1 首行就是 marker，patchOfficialCliShimText 认它做已打过");
  assert.equal(ps1[ps1.length - 2], "exit $LASTEXITCODE");
});

test("officialCliShimBodies：没给 exe 名时兜底成官方默认名", () => {
  assert.ok(d.officialCliShimBodies("").sh.includes('"$(dirname "$resources")/DeepSeek Harness.exe"'));
});

test("stripShimEntryBlock / stripCmdEntryBlock 把整块连同标记行一起删掉", () => {
  assert.equal(
    d.stripShimEntryBlock("# dsh-purge cli entry begin\nx\n# dsh-purge cli entry end\nrest\n"),
    "rest\n",
  );
  assert.equal(
    d.stripCmdEntryBlock("A\r\nREM dsh-purge cli entry begin\r\nB\r\nREM dsh-purge cli entry end\r\nC\r\n"),
    "A\r\nC\r\n",
  );
});

test("replaceQuotedInsensitive：大小写不敏感、全局替换，且只动带引号的形态", () => {
  const out = d.replaceQuotedInsensitive('X "C:\\A\\b.js" Y "c:\\a\\B.JS" Z C:\\A\\b.js', "C:\\A\\b.js", '"$entry"');
  assert.equal(out, 'X "$entry" Y "$entry" Z C:\\A\\b.js');
});

/* ------------------------------------------------------------------ 小 helper */

test("officialRestartFlagPath 落在临时目录的固定名下", () => {
  assert.equal(d.officialRestartFlagPath(), path.join(TMP_ROOT, "dsh-purge-official-restarting"));
});

test("restartUniqSuffix 是 pid-8位十六进制，两次不同", () => {
  const a = d.restartUniqSuffix();
  const b = d.restartUniqSuffix();
  assert.match(a, /^\d+-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test("logInternal 追加到临时目录下的内部日志，不碰 stderr", () => {
  const log = path.join(TMP_ROOT, "dsh-purge-desktop.log");
  const before = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  d.logInternal("cli-repair-probe");
  const after = fs.readFileSync(log, "utf8");
  assert.ok(after.length > before.length);
  assert.ok(after.includes("[dsh-purge] cli-repair-probe"));
  assert.ok(/\d{4}-\d{2}-\d{2}T[\d:.]+Z \[dsh-purge\] cli-repair-probe\n$/.test(after));
});

/* ------------------------------------------------- app/runtime → ../runtime 链接 */

function payloadTree(root, { withPayload = true } = {}) {
  const resources = path.join(root, "resources");
  fs.mkdirSync(path.join(resources, "app"), { recursive: true });
  const runtime = path.join(resources, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  if (withPayload) put(path.join(runtime, "marker.txt"), "x");
  return { resources, runtime };
}

test("ensureAppRuntimeSymlink：缺 app/ 或缺 runtime/ 都回 missing，不建半截链接", () => {
  const onlyApp = path.join(box("sym-a"), "resources");
  fs.mkdirSync(path.join(onlyApp, "app"), { recursive: true });
  assert.deepEqual(d.ensureAppRuntimeSymlink(onlyApp), { ok: false, reason: "missing" });

  const onlyRuntime = path.join(box("sym-b"), "resources");
  fs.mkdirSync(path.join(onlyRuntime, "runtime"), { recursive: true });
  assert.deepEqual(d.ensureAppRuntimeSymlink(onlyRuntime), { ok: false, reason: "missing" });
});

test("ensureAppRuntimeSymlink：第一次建链接，第二次回 already", () => {
  const { resources } = payloadTree(box("sym-c"));
  const first = d.ensureAppRuntimeSymlink(resources);
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.type, process.platform === "win32" ? "junction" : "dir");

  const second = d.ensureAppRuntimeSymlink(resources);
  assert.deepEqual(second, { ok: true, already: true });
});

test("ensureAppRuntimeSymlink：链接还在但目标被掏空时重建（existsSync 会说谎）", () => {
  const { resources, runtime } = payloadTree(box("sym-d"));
  assert.equal(d.ensureAppRuntimeSymlink(resources).created, true);
  fs.rmSync(path.join(runtime, "marker.txt"));
  const again = d.ensureAppRuntimeSymlink(resources);
  assert.equal(again.ok, true);
  assert.equal(again.created, true, "空目标的链接等于没建");
});

/* ------------------------------------------------------------- copySkillTree */

function fakeFs(tree) {
  const calls = [];
  const reader = {
    readdirSync(dir) {
      const rel = dir.replace(/^[A-Za-z]:[\\/]/, "").replace(/\\/g, "/");
      const node = tree[rel];
      if (!node) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return node;
    },
    readFileSync(fp) {
      const rel = fp.replace(/^[A-Za-z]:[\\/]/, "").replace(/\\/g, "/");
      return `content-of-${rel}`;
    },
  };
  const writer = {
    mkdirSync(dir) {
      calls.push(["mkdir", dir.replace(/\\/g, "/")]);
    },
    existsSync() {
      return false;
    },
    writeFileSync(fp) {
      calls.push(["write", fp.replace(/\\/g, "/")]);
    },
  };
  return { reader, writer, calls };
}

function dirent(name, kind = "file") {
  return {
    name,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  };
}

test("copySkillTree：按目录递归复制，跳过符号链接与空名条目", () => {
  const { reader, writer, calls } = fakeFs({
    "src": [dirent("a.txt"), dirent("sub", "dir"), dirent("link", "symlink"), dirent("")],
    "src/sub": [dirent("b.txt")],
  });
  d.copySkillTree("src", "dest", reader, writer);
  const kinds = calls.map((c) => c[0] + ":" + c[1]);
  // 每个文件写之前会再 mkdir 一次 dirname（真实路径拼接下与顶层那次同值），所以 mkdir 成对出现
  assert.deepEqual(kinds, [
    "mkdir:dest",
    "mkdir:dest",
    "write:dest/a.txt",
    "mkdir:dest/sub",
    "mkdir:dest/sub",
    "write:dest/sub/b.txt",
  ]);
  assert.equal(kinds.some((k) => k.includes("link")), false, "符号链接不该被跟进去");
});

test("copySkillTree：mkdri 或 readdir 抛错都被吞掉，不向上冒", () => {
  const { reader, writer } = fakeFs({});
  writer.mkdirSync = () => {
    throw new Error("EACCES");
  };
  assert.doesNotThrow(() => d.copySkillTree("src", "dest", reader, writer));
  const deadReader = {
    readdirSync() {
      throw new Error("ENOENT");
    },
  };
  assert.doesNotThrow(() => d.copySkillTree("src", "dest", deadReader, writer));
});

test("copySkillTree：超过深度上限就停手（防止 office-skills 里的环）", () => {
  const { reader, writer, calls } = fakeFs({});
  reader.readdirSync = () => {
    calls.push(["read"]);
    return [dirent("x", "dir")];
  };
  writer.mkdirSync = () => {};
  d.copySkillTree("src", "dest", reader, writer, 13);
  assert.deepEqual(calls, []);
});

/* ------------------------------------------------------- runtime 负载探测与自愈 */

const NODE_NAME = process.platform === "win32" ? "node.exe" : "node";

function seedPayload(runtime) {
  const big = Buffer.alloc(1 << 20, 0x41);
  put(path.join(runtime, "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.mjs"), "x".repeat(2048));
  put(path.join(runtime, "primary-runtime", "dependencies", "node", "bin", NODE_NAME), big);
  put(path.join(runtime, "bin", NODE_NAME), big);
}

test("inspectRuntimePayload：空树列出三条缺失，齐了就 ok", () => {
  const { resources, runtime } = payloadTree(box("pay-a"), { withPayload: false });
  const empty = d.inspectRuntimePayload(resources);
  assert.equal(empty.ok, false);
  assert.equal(empty.missing.length, 3);
  assert.ok(empty.missing.includes("primary-runtime/dependencies/pnpm/bin/pnpm.mjs"));
  assert.ok(empty.missing.includes(`bin/${NODE_NAME}`));

  seedPayload(runtime);
  const full = d.inspectRuntimePayload(resources);
  assert.deepEqual(full, { ok: true, resources, runtime, missing: [] });
});

test("inspectRuntimePayload：resources 不是目录时回 no_resources，不抛", () => {
  const missingDir = path.join(box("pay-b"), "nope");
  const r = d.inspectRuntimePayload(missingDir);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_resources");
});

test("healRuntimePayload：给了空 sources 就老老实实报 still_missing，不去翻 ~/.dsh", () => {
  const { resources } = payloadTree(box("pay-c"), { withPayload: false });
  const r = d.healRuntimePayload(resources, { sources: [] });
  assert.equal(r.ok, false);
  assert.equal(r.healed, false);
  assert.equal(r.source, null);
  assert.deepEqual(r.copied, []);
  assert.ok(r.errors.includes("still_missing"));
});

test("healRuntimePayload：源目录的探针不带 primary-runtime 前缀（源本身就是 primary-runtime）", () => {
  const { resources, runtime } = payloadTree(box("pay-d"), { withPayload: false });
  const big = Buffer.alloc(1 << 20, 0x42);
  const src = path.join(box("pay-d"), "src-runtime");
  put(path.join(src, "dependencies", "pnpm", "bin", "pnpm.mjs"), "y".repeat(2048));
  put(path.join(src, "dependencies", "node", "bin", NODE_NAME), big);

  const r = d.healRuntimePayload(resources, { sources: [src] });
  assert.equal(r.ok, true);
  assert.equal(r.healed, true);
  assert.equal(r.source, src);
  assert.deepEqual(r.copied, ["primary-runtime", `bin/${NODE_NAME}`]);
  assert.equal(fs.existsSync(path.join(runtime, "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.mjs")), true);
});

test("healRuntimePayload：已经齐了就回 healed:false，不重复拷", () => {
  const { resources, runtime } = payloadTree(box("pay-e"), { withPayload: false });
  seedPayload(runtime);
  const r = d.healRuntimePayload(resources, { sources: [] });
  assert.deepEqual(r, { ok: true, healed: false, resources, missing: [], copied: [] });
});

test("runtimeHealSources：DSH_HOME 打头，空串被过滤", () => {
  const out = d.runtimeHealSources(["/extra/a", "", null, "/extra/b"]);
  assert.equal(out[0], path.join(SANDBOX, "home", "dsh-runtimes", "dsh-primary-runtime"));
  assert.deepEqual(out.slice(1), ["/extra/a", "/extra/b"]);
});

/* --------------------------------------------------- repairOfficialCliAfterUnpack */

function officialTree(tag) {
  const root = box(tag);
  const inst = path.join(root, "app");
  fs.mkdirSync(inst, { recursive: true });
  const exe = path.join(inst, "DeepSeek Harness.exe");
  fs.writeFileSync(exe, "MZ");
  const resources = path.join(inst, "resources");
  fs.mkdirSync(path.join(resources, "app"), { recursive: true });
  seedPayload(path.join(resources, "runtime"));
  return { root, inst, exe, resources };
}

test("repairOfficialCliAfterUnpack：非官方 exe / 缺 resources 都被挡住", () => {
  const { inst } = officialTree("rep-a");
  assert.deepEqual(d.repairOfficialCliAfterUnpack(path.join(inst, "Nope.exe")), {
    ok: false,
    reason: "not_official",
  });
  const bare = path.join(box("rep-b"), "app");
  fs.mkdirSync(bare, { recursive: true });
  const exe = path.join(bare, "DeepSeek Harness.exe");
  fs.writeFileSync(exe, "MZ");
  assert.deepEqual(d.repairOfficialCliAfterUnpack(exe), { ok: false, reason: "no_resources" });
});

test("repairOfficialCliAfterUnpack：首装现场生成三件套，并建好 app/runtime 链接", () => {
  const { exe, resources } = officialTree("rep-c");
  const r = d.repairOfficialCliAfterUnpack(exe);
  assert.equal(r.ok, true);
  assert.equal(r.resources, resources);
  assert.equal(r.runtime.ok, true);
  assert.equal(r.symlink.ok, true);
  assert.equal(r.created.length, 3);
  // 前三条是"现场生成"，后三条是紧接着那轮"再打一遍补丁"的读数
  assert.deepEqual(
    r.shims.map((s) => s.status),
    ["created", "created", "created", "already", "already", "skipped"],
  );

  const bin = path.join(resources, "runtime", "cli", "bin");
  assert.equal(fs.readFileSync(path.join(bin, "dsh"), "utf8").split("\n")[0], "#!/bin/sh");
  assert.equal(fs.readFileSync(path.join(bin, "dsh.cmd"), "utf8").split("\r\n")[0], "@ECHO off");
  assert.ok(fs.readFileSync(path.join(bin, "dsh.ps1"), "utf8").startsWith("# dsh-purge cli entry begin"));
});

test("repairOfficialCliAfterUnpack：第二次什么都不改（链接 already、三件套 already/skipped）", () => {
  const { exe, resources } = officialTree("rep-d");
  d.repairOfficialCliAfterUnpack(exe);
  const again = d.repairOfficialCliAfterUnpack(exe);
  assert.equal(again.ok, true);
  assert.deepEqual(again.symlink, { ok: true, already: true });
  assert.deepEqual(again.created, []);
  assert.deepEqual(
    again.shims.map((s) => s.status),
    ["already", "already", "skipped"],
  );
  // ps1 生成体里本来就带着 $entry，没有可改的地方，所以是 skipped 而不是 already
  assert.equal(fs.existsSync(path.join(resources, "runtime", "cli", "bin", "dsh.ps1")), true);
});

test("repairOfficialCliAfterUnpack：改过的 shim 旁边留一份 .dsh-purge.bak", () => {
  const { exe, resources } = officialTree("rep-e");
  const bin = path.join(resources, "runtime", "cli", "bin");
  put(path.join(bin, "dsh"), SH_SRC);
  const r = d.repairOfficialCliAfterUnpack(exe);
  assert.equal(r.ok, true);
  const status = r.shims.find((s) => s.path.endsWith(`${path.sep}dsh`));
  assert.equal(status.status, "patched");
  const bak = path.join(bin, "dsh.dsh-purge.bak");
  assert.equal(fs.existsSync(bak), true);
  assert.equal(fs.readFileSync(bak, "utf8"), SH_SRC, "bak 必须是改前的原文");
});

test("repairOfficialCliAfterUnpack：runtime 自愈抛错也降级成 ok:true + runtime.ok:false", () => {
  const { exe, resources } = officialTree("rep-f");
  // 把 runtime 目录换成一个文件，heal 会走进错误分支
  fs.rmSync(path.join(resources, "runtime"), { recursive: true, force: true });
  fs.writeFileSync(path.join(resources, "runtime"), "not-a-dir");
  const r = d.repairOfficialCliAfterUnpack(exe);
  assert.equal(r.ok, true, "自愈失败不该让整个修补报失败");
  assert.equal(r.runtime.ok, false);
});

/* --------------------------------------------------------------- restartPlan 早退 */

test("restartPlan：认 DSH_DESKTOP_INSTALL 指的那棵树，cwd 取 exe 所在目录", () => {
  const { inst, exe } = officialTree("plan-a");
  const r = d.restartPlan({ execPath: "/nope/node", resourcesPath: "", argv: [], env: { DSH_DESKTOP_INSTALL: inst } });
  assert.equal(r.kind, "desktop");
  assert.equal(r.execPath, path.normalize(exe));
  assert.deepEqual(r.argv, []);
  assert.equal(r.cwd, path.dirname(path.normalize(exe)));
  assert.equal(r.error, undefined);
});

test("restartPlan：找不到 exe 时给中文原因而不是抛错（本机装了 DSH，只能钉形状）", () => {
  const r = d.restartPlan({ execPath: "/nope/node", resourcesPath: "", argv: [], env: { DSH_DESKTOP_INSTALL: "" } });
  assert.equal(r.kind, "desktop");
  if (r.error) {
    assert.equal(r.execPath, "");
    assert.deepEqual(r.argv, []);
    assert.equal(r.error, "未找到 DSH Desktop.exe，无法重启桌面应用");
  } else {
    // 本机装了官方桌面端：discover 会把它找出来。钉住"找到了就必须是一个真文件"。
    assert.ok(fs.existsSync(r.execPath), `解析出的 exe 不存在：${r.execPath}`);
    assert.equal(r.cwd, path.dirname(r.execPath));
  }
});

/* -------------------------------------------- 判别性用例（RED 演练补出来的） */

test("源码形状：非 win32 分支的相对目标是正斜杠的 \"../runtime\"", () => {
  // 本来想用 readlink 测：把 process.platform 伪造成 linux 走进 "dir" 分支，再读回目标。
  // 但 Windows 上的 fs.symlinkSync 会把目标里的 "/" 归一成 "\"，readlinkSync 读回来仍是
  // "..\\runtime" —— 行为层在这台机器上区分不了两条实现（RED 演练里那条突变是 GREEN）。
  const src = fs.readFileSync(new URL("../lib/desktop.js", import.meta.url), "utf8");
  assert.ok(src.includes('fs.symlinkSync("../runtime", link, "dir");'), "非 win32 要用正斜杠；反斜杠在 POSIX 上不是分隔符");
  assert.ok(src.includes('fs.symlinkSync("..\\\\runtime", link, "junction");'), "win32 的 junction 目标用反斜杠");
});

test("sh 启动器：null 也当空文本，不去解引用（否则调用点拿到 TypeError）", () => {
  assert.deepEqual(d.patchOfficialCliShimText(null), { changed: false, text: null });
  assert.deepEqual(d.patchOfficialCliCmdText(null), { changed: false, text: null });
});

test("sh 启动器：只剩 BEGIN 标记、裸 asar 已被换成 $entry 的旧块，仍要进来升级（认标记不是认路径）", () => {
  const legacy = [
    "#!/bin/sh",
    'resources=$(dirname "$0")',
    "# dsh-purge cli entry begin",
    'entry="$resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"',
    'if [ ! -f "$entry" ]; then entry="$resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"; fi',
    "# dsh-purge cli entry end",
    "",
    'ELECTRON_RUN_AS_NODE=1 exec "$resources/DeepSeek Harness.exe" "$entry" "$@"',
    "",
  ].join("\n");
  // 先把块里的裸 asar 换成 $entry，模拟"上一版已经归一过、但只有两级回退"
  const noBare = legacy.replace(/\$resources\/app\.asar\/dsh\/node_modules\/@deepseek-ai\/dsh-desktop-host\/lib\/cli\.js/, '"$entry"');
  assert.ok(noBare.includes("# dsh-purge cli entry begin"));
  assert.equal(noBare.includes("$resources/app.asar/dsh/"), false, "前提：裸 asar 路径已经不在了");
  const r = d.patchOfficialCliShimText(noBare);
  assert.equal(r.changed, true, "只认裸 asar 路径的实现在这里会直接返回 changed:false");
  assert.ok(r.text.includes('entry="$resources/app/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"'), "缺 app/ 那一级回退");
});

/* ------------------------------- cmdEntryAlreadyGood 的七道判据逐条钉住 */

const CMD_GOOD = [
  "@ECHO off",
  'set "ELECTRON_RUN_AS_NODE=1"',
  "REM dsh-purge cli entry begin",
  'set "entry=%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js"',
  'if not exist "%entry%" set "entry=%~dp0..\\..\\..\\app.asar.unpacked\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js"',
  'if not exist "%entry%" set "entry=%~dp0..\\..\\..\\app\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js"',
  "REM dsh-purge cli entry end",
  '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" "%entry%" %*',
  "",
].join("\r\n");

test("cmdEntryAlreadyGood：三级回退都在、但还留着一行 set \"entry=%entry%\" 时必须判否", () => {
  assert.equal(d.cmdEntryAlreadyGood(CMD_GOOD), true, "前提：这份是好的");
  // 关键：三条正确的 set 行都保留，只额外插一行自指 —— 否则前一道「必须含三级回退」会先挡住它，
  // 测出来的就不是这条判据了。
  const selfRef = CMD_GOOD.replace(
    "REM dsh-purge cli entry end",
    'set "entry=%entry%"\r\nREM dsh-purge cli entry end',
  );
  assert.ok(selfRef.includes('set "entry=%~dp0..\\..\\..\\app.asar\\'), "前提：三级回退还在");
  assert.equal(d.cmdEntryAlreadyGood(selfRef), false);
});

test("cmdEntryAlreadyGood：缺任何一级回退都判否（asar / asar.unpacked / app）", () => {
  const drop = (needle) => CMD_GOOD.split("\r\n").filter((l) => !l.includes(needle)).join("\r\n");
  assert.equal(d.cmdEntryAlreadyGood(drop("app.asar\\dsh\\node_modules")), false, "缺 asar 那一级");
  assert.equal(d.cmdEntryAlreadyGood(drop("app.asar.unpacked")), false, "缺 unpacked 那一级（#94）");
  assert.equal(d.cmdEntryAlreadyGood(drop("..\\..\\..\\app\\dsh\\node_modules")), false, "缺 app/ 那一级");
});

test("cmdEntryAlreadyGood：摘掉 set 行之后还留着裸 asar 路径就判否（调用点没改成 %entry%）", () => {
  const withBare = CMD_GOOD.replace(
    '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" "%entry%" %*',
    '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
  );
  assert.equal(d.cmdEntryAlreadyGood(withBare), false);
});

// 注：`cmdEntryAlreadyGood` 最后那句 `return /"%entry%"/.test(text)` 是**冗余**的 ——
// 前面「必须含 if not exist "%entry%" set "entry=..." 那一级」已经把 `"%entry%"` 带进来了，
// 走到最后一句时它必然为真。这条不补用例，免得为一句永远成立的守卫硬凑 fixture。

test("cmd 启动器：原文里带自指的 set 行时退回原样（三条终检真的在把关）", () => {
  const dirty = CMD_SRC.replace('set "ELECTRON_RUN_AS_NODE=1"', 'set "ELECTRON_RUN_AS_NODE=1"\r\nset "entry=%entry%"');
  const r = d.patchOfficialCliCmdText(dirty);
  assert.equal(r.changed, false, "终检不过就不许写盘");
  assert.equal(r.text, dirty);
});

/* ------------------------------------------------ ensureAppRuntimeSymlink 的指向判定 */

test("ensureAppRuntimeSymlink：链接还在但指向别处时重建（realpath 不等于 ../runtime）", () => {
  const root = box("sym-target");
  const resources = path.join(root, "resources");
  const appDir = path.join(resources, "app");
  const runtime = path.join(resources, "runtime");
  fs.mkdirSync(appDir, { recursive: true });
  seedPayload(runtime);
  // app/runtime 是个真目录（带着内容），不是指向 ../runtime 的链接
  const link = path.join(appDir, "runtime");
  fs.mkdirSync(link, { recursive: true });
  fs.writeFileSync(path.join(link, "stale.txt"), "stale");
  const r = d.ensureAppRuntimeSymlink(resources);
  assert.equal(r.ok, true);
  assert.equal(r.created, true, "指向别处的同名目录不能当成 already");
  assert.equal(fs.existsSync(path.join(link, "stale.txt")), false, "旧目录要被换掉");
});

/* ------------------------------------------------------------ copySkillTree 的两道守卫 */

test("copySkillTree：reader 说它既是链接又是文件时仍然跳过（只跟真目录真文件）", () => {
  const calls = [];
  const reader = {
    readdirSync: () => [
      { name: "loop", isDirectory: () => true, isFile: () => true, isSymbolicLink: () => true },
      { name: "ok.txt", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    ],
    readFileSync: () => Buffer.from("x"),
  };
  const writer = {
    mkdirSync: (dir) => calls.push(["mkdir", dir]),
    existsSync: () => false,
    writeFileSync: (fp) => calls.push(["write", fp]),
  };
  d.copySkillTree("src", "dest", reader, writer);
  assert.equal(calls.some((c) => String(c[1]).includes("loop")), false, "链接不该被跟进去");
  assert.equal(calls.filter((c) => c[0] === "write").length, 1);
});

test("copySkillTree：目标已存在的文件不覆盖（用户的 office-skills 可能改过）", () => {
  const calls = [];
  const reader = {
    readdirSync: () => [{ name: "keep.md", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }],
    readFileSync: () => Buffer.from("new"),
  };
  const writer = {
    mkdirSync: () => {},
    existsSync: () => true,
    writeFileSync: (fp) => calls.push(["write", fp]),
  };
  d.copySkillTree("src", "dest", reader, writer);
  assert.deepEqual(calls, [], "已存在的文件一个字节都不许动");
});

/* ---------------------------------------------------------------- 源码形状守卫 */

test("源码形状：repairOfficialCliAfterUnpack 先补 runtime 再建链接（#195 的顺序）", () => {
  const src = fs.readFileSync(new URL("../lib/desktop.js", import.meta.url), "utf8");
  const head = "export function repairOfficialCliAfterUnpack(exe = findDesktopAppExecutable()) {";
  const at = src.split(/\r?\n/).findIndex((line) => line === head);
  assert.ok(at >= 0, "找不到 repairOfficialCliAfterUnpack");
  const body = src.split(/\r?\n/).slice(at, at + 40).join("\n");
  assert.ok(body.indexOf("report.runtime = healRuntimePayload(resources);") < body.indexOf("report.symlink = ensureAppRuntimeSymlink(resources);"));
  assert.ok(body.includes("if (isFile(fp)) continue;"), "已存在的 shim 不该被覆盖写");
  assert.ok(!/patchOfficialCliShimText\(/.test(body.split("const patched")[0]), "先判存在，再谈打补丁");
});

test("源码形状：两处 chmod 0o755 都在（Windows 上 chmod 是空操作，行为测不出来）", () => {
  const src = fs.readFileSync(new URL("../lib/desktop.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const head = "export function repairOfficialCliAfterUnpack(exe = findDesktopAppExecutable()) {";
  const at = src.split("\n").findIndex((line) => line === head);
  assert.ok(at >= 0, "找不到 repairOfficialCliAfterUnpack");
  const body = src.split("\n").slice(at, at + 75).join("\n");
  // 一处是"现场生成的新 shim"，一处是"改完文本之后补回权限" —— 后者丢过一次就是 dsh 再也起不来
  assert.equal(body.split("fs.chmodSync(fp, 0o755)").length - 1, 2, "两处 chmod 缺一不可");
  assert.equal(
    body.split('if (!name.toLowerCase().endsWith(".cmd")) {').length - 1,
    1,
    "新生成的那处要跳过 .cmd（Windows 上 chmod 对 .cmd 没意义，且会让报告里出现假失败）",
  );
  assert.equal(
    body.split('if (!fp.toLowerCase().endsWith(".cmd")) {').length - 1,
    1,
    "改完补权限那处同样跳过 .cmd",
  );
});
