import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 「apply 把软链启动器覆盖成 bin.js 拷贝」这条自愈链只在 POSIX 上生效
// （`resolveShimWriteTarget` 里 `process.platform === "win32"` 直接早退），
// 大部分用例因此用 asPlatform("linux") 驱动。文件系统操作用真盘，全部落在 ROOT 下。
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-shim-heal-"));
const KEEP = ["TEMP", "TMP", "TMPDIR", "DSH_HOME", "DSH_SURFACE"];
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
function box(tag) {
  seq += 1;
  const dir = path.join(ROOT, `${String(seq).padStart(2, "0")}-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

/** 造一份「官方 dsh 入口」：node_modules/@deepseek-ai/dsh/lib/bin.js + 同级的 dsh-app-boot。 */
function officialEntry(root, rel = "node_modules") {
  const base = path.join(root, rel, "@deepseek-ai");
  put(base, {
    "dsh/lib/bin.js": "// official entry\nrequire('@deepseek-ai/dsh-app-boot');\n",
    "dsh-app-boot/package.json": JSON.stringify({ name: "@deepseek-ai/dsh-app-boot", version: "0.0.0" }),
  });
  return path.join(base, "dsh", "lib", "bin.js");
}

test("looksLikeCopiedBinJs：只认 dsh-app-boot 这个引用", () => {
  assert.equal(core.looksLikeCopiedBinJs("require('@deepseek-ai/dsh-app-boot')\n"), true);
  assert.equal(core.looksLikeCopiedBinJs("#!/usr/bin/env node\nrequire('other')\n"), false);
  assert.equal(core.looksLikeCopiedBinJs(""), false);
  assert.equal(core.looksLikeCopiedBinJs(null), false);
  assert.equal(core.looksLikeCopiedBinJs(undefined), false);
});

test("canResolveAppBoot：向上八层找 node_modules/@deepseek-ai/dsh-app-boot，包目录或 package.json 都算", () => {
  const root = box("appboot");
  const deep = path.join(root, "a", "b", "c");
  put(deep, {});
  assert.equal(core.canResolveAppBoot(path.join(deep, "x.js")), false, "都没有时 false");
  put(path.join(root, "node_modules", "@deepseek-ai", "dsh-app-boot"), { "package.json": "{}" });
  assert.equal(core.canResolveAppBoot(path.join(deep, "x.js")), true, "三层之上命中");
  const solo = box("appboot-dir");
  const here = path.join(solo, "p");
  put(here, { "x.js": "//" });
  put(path.join(solo, "node_modules", "@deepseek-ai", "dsh-app-boot"), {}); // 只有空目录
  assert.equal(core.canResolveAppBoot(path.join(here, "x.js")), true, "空目录也算（isDir 分支）");
  const far = box("appboot-far");
  const deepFar = path.join(far, ...Array.from({ length: 9 }, (_, i) => `d${i}`));
  put(deepFar, { "x.js": "//" });
  put(path.join(far, "node_modules", "@deepseek-ai", "dsh-app-boot"), { "package.json": "{}" });
  assert.equal(core.canResolveAppBoot(path.join(deepFar, "x.js")), false, "超过八层就不找了");
});

test("officialBinJsNearLauncher：三个候选位置按顺序命中，都没有返回空串", () => {
  const root = box("near");
  const binDir = put(path.join(root, "bin"), {});
  assert.equal(core.officialBinJsNearLauncher(path.join(binDir, "dsh")), "");
  // <dir>/../lib/node_modules/...
  const a = officialEntry(path.join(root, "one"), path.join("lib", "node_modules"));
  assert.equal(core.officialBinJsNearLauncher(path.join(root, "one", "bin", "dsh")), a);
  // <dir>/../node_modules/...
  const root2 = box("near2");
  const b = officialEntry(root2);
  assert.equal(core.officialBinJsNearLauncher(path.join(root2, "bin", "dsh")), b);
  // <dir>/../../lib/node_modules/...
  const root3 = box("near3");
  const c = officialEntry(path.join(root3, "deep"), path.join("lib", "node_modules"));
  assert.equal(core.officialBinJsNearLauncher(path.join(root3, "deep", "bin", "dsh")), c);
});

test("officialBinJsNearLauncher：文件在但没有 dsh-app-boot 时不算官方入口", () => {
  const root = box("near-noboot");
  put(path.join(root, "node_modules", "@deepseek-ai", "dsh", "lib"), { "bin.js": "//\n" });
  assert.equal(core.officialBinJsNearLauncher(path.join(root, "bin", "dsh")), "");
});

test("posixRelLink：相对路径一律正斜杠，且补 ./ 前缀", () => {
  assert.equal(core.posixRelLink("/a/b", "/a/b/c.js"), "./c.js");
  assert.equal(core.posixRelLink("/a/b", "/a/d/e.js"), "../d/e.js", "以 .. 开头的不补 ./");
  assert.equal(core.posixRelLink("/a/b", "/a/b"), "/a/b", "同一个文件原样返回");
});

test("healCopiedLauncher：找到官方入口就把拷贝换回软链", () => {
  const root = box("heal");
  const official = officialEntry(root);
  const fp = path.join(root, "bin", "dsh");
  put(path.dirname(fp), { dsh: "// copied bin.js\nrequire('@deepseek-ai/dsh-app-boot');\n" });
  const healed = core.healCopiedLauncher(fp);
  assert.equal(healed, official);
  assert.equal(fs.lstatSync(fp).isSymbolicLink(), true, "换成了软链");
  assert.equal(fs.readFileSync(fp, "utf8"), fs.readFileSync(official, "utf8"), "内容跟官方入口一致");
});

test("healCopiedLauncher：找不到官方入口就什么都不动", () => {
  const root = box("heal-none");
  const fp = path.join(root, "bin", "dsh");
  put(path.dirname(fp), { dsh: "// copied\n" });
  assert.equal(core.healCopiedLauncher(fp), "");
  assert.equal(fs.lstatSync(fp).isSymbolicLink(), false, "原文还在原处");
  assert.equal(fs.readFileSync(fp, "utf8"), "// copied\n");
});

test("resolveShimWriteTarget 非 POSIX：win32 与 .cmd/.ps1 都直接写原文件", async () => {
  const root = box("target-win");
  const fp = path.join(root, "bin", "dsh");
  put(path.dirname(fp), { dsh: "#!/bin/sh\n" });
  const onWin = await asPlatform("win32", () => core.resolveShimWriteTarget(fp, "dsh", "TEXT"));
  assert.deepEqual(onWin, { writeFp: fp, text: "TEXT", healed: false });
  const cmd = await asPlatform("linux", () => core.resolveShimWriteTarget(path.join(root, "bin", "dsh.cmd"), "dsh.cmd", "TEXT"));
  assert.deepEqual(cmd, { writeFp: path.join(root, "bin", "dsh.cmd"), text: "TEXT", healed: false });
});

test("resolveShimWriteTarget POSIX：本来就是软链时写真实目标", async () => {
  const root = box("target-link");
  const real = put(path.join(root, "real"), { "bin.js": "// real\n" });
  const fp = path.join(root, "bin", "dsh");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.symlinkSync(path.join(real, "bin.js"), fp);
  const out = await asPlatform("linux", () => core.resolveShimWriteTarget(fp, "dsh", "TEXT"));
  assert.equal(out.writeFp, fs.realpathSync(fp));
  assert.equal(out.healed, false);
  assert.equal(out.text, "TEXT");
});

test("resolveShimWriteTarget POSIX：断链（realpath 抛错）回 symlink: 前缀而不是崩", async () => {
  const root = box("target-broken");
  const fp = path.join(root, "bin", "dsh");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.symlinkSync(path.join(root, "missing-target.js"), fp);
  const out = await asPlatform("linux", () => core.resolveShimWriteTarget(fp, "dsh", "TEXT"));
  assert.ok(out.error && out.error.startsWith("symlink:"), JSON.stringify(out));
  assert.equal(out.writeFp, undefined);
});

test("resolveShimWriteTarget POSIX：拷贝来的 bin.js 且旁边没有模块根 → 跳过", async () => {
  const root = box("target-copy");
  const fp = path.join(root, "bin", "dsh");
  put(path.dirname(fp), { dsh: "// copied\nrequire('@deepseek-ai/dsh-app-boot');\n" });
  const out = await asPlatform("linux", () => core.resolveShimWriteTarget(fp, "dsh", "// copied\nrequire('@deepseek-ai/dsh-app-boot');\n"));
  assert.deepEqual(out, { skip: "skipped_no_module_root" });
});

test("resolveShimWriteTarget POSIX：拷贝来的 bin.js 且能自愈 → 改成写官方入口", async () => {
  // 官方入口必须是「向上走查不到」的位置：放在 <dir>/../lib/node_modules，
  // 否则 canResolveAppBoot(fp) 已经为真，自愈分支根本进不去。
  const root = box("target-heal");
  const official = officialEntry(root, path.join("lib", "node_modules"));
  const fp = path.join(root, "bin", "dsh");
  put(path.dirname(fp), { dsh: "// copied\nrequire('@deepseek-ai/dsh-app-boot');\n" });
  const out = await asPlatform("linux", () => core.resolveShimWriteTarget(fp, "dsh", "// copied\nrequire('@deepseek-ai/dsh-app-boot');\n"));
  assert.equal(out.healed, true);
  assert.equal(out.writeFp, official);
  assert.match(out.text, /official entry/);
});

test("resolveShimWriteTarget POSIX：node 类型启动器但解析不到 app-boot 也跳过", async () => {
  const root = box("target-node");
  const fp = path.join(root, "bin", "dsh");
  put(path.dirname(fp), { dsh: "#!/usr/bin/env node\nconsole.log(1)\n" });
  const out = await asPlatform("linux", () => core.resolveShimWriteTarget(fp, "dsh", "#!/usr/bin/env node\n"));
  assert.deepEqual(out, { skip: "skipped_no_module_root" });
  assert.equal(core.shimKindOf(fp), "node");
});

test("resolveShimWriteTarget POSIX：普通 shell 启动器照原样写", async () => {
  const root = box("target-plain");
  const fp = path.join(root, "bin", "dsh");
  put(path.dirname(fp), { dsh: "#!/bin/sh\nexec dsh \"$@\"\n" });
  const out = await asPlatform("linux", () => core.resolveShimWriteTarget(fp, "dsh", "#!/bin/sh\nexec dsh \"$@\"\n"));
  assert.deepEqual(out, { writeFp: fp, text: "#!/bin/sh\nexec dsh \"$@\"\n", healed: false });
});

test("shimKindOf / isSymlinkPath：扩展名与 shebang 两套判据", () => {
  const root = box("kind");
  const sh = put(root, { dsh: "#!/bin/sh\n" });
  const pw = put(path.join(root, "p"), { "dsh.ps1": "Write-Host 1\n" });
  const nodeish = put(path.join(root, "n"), { "dsh.js": "//\n" });
  const noShebang = put(path.join(root, "x"), { dsh: "echo hi\n" });
  assert.equal(core.shimKindOf(sh), "sh");
  assert.equal(core.shimKindOf(path.join(pw, "dsh.ps1")), "ps1");
  assert.equal(core.shimKindOf(path.join(nodeish, "dsh.js")), "node");
  assert.equal(core.shimKindOf(path.join(noShebang, "dsh")), "sh", "没有 shebang 一律按 sh");
  assert.equal(core.isSymlinkPath(sh), false);
  assert.equal(core.isSymlinkPath(path.join(root, "nope")), false, "读不到就是 false，不抛");
});


test("resolveShimWriteTarget：win32 上即使能自愈也不动启动器", async () => {
  const root = box("target-win-noheal");
  officialEntry(root, path.join("lib", "node_modules"));
  const fp = path.join(root, "bin", "dsh");
  const copied = "// copied\nrequire('@deepseek-ai/dsh-app-boot');\n";
  put(path.dirname(fp), { dsh: copied });
  const out = await asPlatform("win32", () => core.resolveShimWriteTarget(fp, "dsh", copied));
  assert.deepEqual(out, { writeFp: fp, text: copied, healed: false });
  assert.equal(fs.lstatSync(fp).isSymbolicLink(), false, "Windows 上不走软链自愈");
});
test("resolveShimWriteTarget：名字不是 dsh 的启动器不碰（哪怕内容像拷贝来的 bin.js）", async () => {
  const root = box("target-other-name");
  officialEntry(root, path.join("lib", "node_modules"));
  const fp = path.join(root, "bin", "dsh-cli");
  const copied = "// copied\nrequire('@deepseek-ai/dsh-app-boot');\n";
  put(path.dirname(fp), { "dsh-cli": copied });
  const out = await asPlatform("linux", () => core.resolveShimWriteTarget(fp, "dsh-cli", copied));
  assert.deepEqual(out, { writeFp: fp, text: copied, healed: false });
  assert.equal(fs.lstatSync(fp).isSymbolicLink(), false);
});
test("源码形状：先 unlink 再 symlink，且链接目标是相对路径", () => {
  const body = SRC.slice(SRC.indexOf("function healCopiedLauncher("), SRC.indexOf("async function resolveShimWriteTarget("));
  const unlinkAt = body.indexOf("fs.unlinkSync(fp);");
  const symlinkAt = body.indexOf("fs.symlinkSync(rel, fp);");
  assert.ok(unlinkAt > 0 && symlinkAt > unlinkAt, "顺序反了会在 Windows 上留下半个文件");
  assert.match(body, /const rel = posixRelLink\(path\.dirname\(fp\), official\);/);
  assert.match(body, /\} catch \{\r?\n\s*return "";/);
});
