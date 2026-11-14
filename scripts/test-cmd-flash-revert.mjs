import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/* 回退那半：revertCmdFlash 与它的两个帮手、五个文件清单。
   这一簇只在卸载 / 回退时跑，坏了的表现是「宿主还留着我们注入的代码」——
   桌面继续闪黑窗、启动还是被改过 —— 一句日志都不报。
   所以这里钉两件事：①逐字节还原（注入形态 → 原文形态）；②打到哪棵树。 */

// 模块顶层就会算一堆路径常量，先把它引用的临时目录搬走再 import。
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dshp76-tmp-"));
const ORIG_TMP = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
process.env.TEMP = TMP_ROOT;
process.env.TMP = TMP_ROOT;
process.env.TMPDIR = TMP_ROOT;

const core = await import("../lib/core.js");
const { hostFs } = await import("../lib/extract-asar.js");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dshp76-"));
let boxSeq = 0;

const box = (tag = "box") => {
  const dir = path.join(ROOT, `${tag}-${++boxSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const put = (root, rel, text) => {
  const fp = path.join(root, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
  return fp;
};
const read = (fp) => fs.readFileSync(fp, "utf8");

/* 每个 aiBase 都是一棵最小的宿主树：isAiBase 只看 dsh-agent-instructions/lib 是不是目录。 */
const aiBase = (tag) => {
  const dir = box("ai-" + tag);
  fs.mkdirSync(path.join(dir, "dsh-agent-instructions", "lib"), { recursive: true });
  return dir;
};

const withPlatform = (value, fn) => {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", desc);
  }
};

test.after(() => {
  for (const [k, v] of Object.entries(ORIG_TMP)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 3 });
});

/* ── 注入形态的 fixture ──────────────────────────────────────────────
   每对 needle/patched 都是从 lib/core.js 里抄下来的字面量：回退侧靠这些字面量
   定位，字面量一变就退不动，所以它们是契约的一部分，不是测试的巧合。 */

const SP_MARKER = "[dsh-purge] subprocess-local windowsHide";
const SP_PLAIN =
  "\tconst child = spawn(program, args, {\n" +
  "\t\tcwd: spec.cwd,\n" +
  "\t\tenv,\n" +
  "\t\tstdio: [\n" +
  '\t\t\tstdinMode === "ignore" ? "ignore" : "pipe",\n' +
  '\t\t\toutMode === "inherit" ? "inherit" : "pipe",\n' +
  '\t\t\terrMode === "inherit" ? "inherit" : "pipe"\n' +
  "\t\t],\n" +
  '\t\tdetached: platform !== "win32"\n' +
  "\t});";
const SP_PATCHED =
  "\tconst child = spawn(program, args, {\n" +
  "\t\tcwd: spec.cwd,\n" +
  "\t\tenv,\n" +
  "\t\tstdio: [\n" +
  '\t\t\tstdinMode === "ignore" ? "ignore" : "pipe",\n' +
  '\t\t\toutMode === "inherit" ? "inherit" : "pipe",\n' +
  '\t\t\terrMode === "inherit" ? "inherit" : "pipe"\n' +
  "\t\t],\n" +
  '\t\tdetached: platform !== "win32",\n' +
  "\t\t// " +
  SP_MARKER +
  "\n" +
  "\t\twindowsHide: true\n" +
  "\t});";

const CB_MARKER = "[dsh-purge] never fall back to WSL System32 bash";
const CB_PLAIN =
  "    try {\n" +
  "      return await ctx.subprocess.resolveExecutable('bash', undefined, signal)\n" +
  "    } catch (error) {\n";
const CB_PATCHED =
  "    // " +
  CB_MARKER +
  "\n" +
  "    try {\n" +
  "      const resolved = await ctx.subprocess.resolveExecutable('bash', undefined, signal)\n" +
  "      if (/[\\\\/](System32|SysWOW64|WindowsApps)[\\\\/]bash\\.exe$/i.test(resolved)) {\n" +
  "        throw new Error('WSL bash launcher is not Git Bash')\n" +
  "      }\n" +
  "      return resolved\n" +
  "    } catch (error) {\n";

const P1_ORIG_SET = "const PERSONA_SECTION_NAMES = new Set(['deployment:persona', 'persona'])";
const P1_FILTER =
  "assembled.sections.filter(section => PERSONA_SECTION_NAMES.has(section?.name))";

const DOCTOR_SPAWN_BLOCK =
  'import { spawn as __dshPurgeSpawnOrig } from "node:child_process";\n' +
  "// [dsh-purge] doctor spawn windowsHide\n" +
  "function spawn(file, args, options) {\n" +
  "\treturn __dshPurgeSpawnOrig(file, args, { ...options, windowsHide: true })\n" +
  "}\n";

const MARKET_HEAD =
  "export function respawnInvocation(launch, platform = process.platform) {\n" +
  "    if (platform !== 'win32') {\n" +
  "        return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true };\n" +
  "    }\n";
const MARKET_MARKER = "[dsh-purge] market restart → node bin.js (no powershell/dsh.cmd)";

const paths = {
  subprocess: (home) =>
    path.join(home, "profiles", "web", "node_modules", "@deepseek-ai", "dsh-subprocess-local", "lib", "index.js"),
  customBash: (home) =>
    path.join(home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "custom-bash.mjs"),
  phase1: (home) =>
    path.join(home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "tool-bootstrap.mjs"),
  doctor: (home) =>
    path.join(home, "profiles", "web", "node_modules", "@linxin666", "dsh-doctor", "lib", "cli.mjs"),
  market: (home) => path.join(home, "profiles", "web", "node_modules", "dshmarket", "lib", "restart.js"),
};

/* ── 1. worseRevertHit 的 rank：error:X > reverted > absent > missing ── */

test("worseRevertHit：absent 比 missing 好，且不会被后来的 missing 盖掉", () => {
  assert.equal(core.worseRevertHit("missing", "absent"), "absent");
  assert.equal(core.worseRevertHit("absent", "missing"), "absent");
  assert.equal(core.worseRevertHit("missing", "missing"), "missing");
});

test("worseRevertHit：reverted 比 absent 好，且不会被后来的 absent 盖掉", () => {
  assert.equal(core.worseRevertHit("absent", "reverted"), "reverted");
  assert.equal(core.worseRevertHit("reverted", "absent"), "reverted");
  assert.equal(core.worseRevertHit("reverted", "missing"), "reverted");
});

test("worseRevertHit：error 无论先后都赢过 reverted（坏结果不被成功覆盖）", () => {
  assert.equal(core.worseRevertHit("reverted", "error:EPERM"), "error:EPERM");
  assert.equal(core.worseRevertHit("error:EPERM", "reverted"), "error:EPERM");
});

test("worseRevertHit：两个 error 保留先出现的那个", () => {
  assert.equal(core.worseRevertHit("error:first", "error:second"), "error:first");
});

test("worseRevertHit：不认识的词按 rank 0（等同 missing）算，不抛错", () => {
  assert.equal(core.worseRevertHit("weird", "absent"), "absent");
  assert.equal(core.worseRevertHit("weird", "missing"), "missing");
  // 反向：已经 reverted 之后来了一个不认识的词，不能被它顶掉
  assert.equal(core.worseRevertHit("reverted", "weird"), "reverted");
  assert.equal(core.worseRevertHit("absent", "weird"), "absent");
  assert.equal(core.worseRevertHit(undefined, "reverted"), "reverted");
  assert.equal(core.worseRevertHit("reverted", undefined), "reverted");
});

/* ── 2. rewriteFiles：读、改、写的聚合口径 ─────────────────────────── */

test("rewriteFiles：没有文件 → missing", () => {
  assert.equal(core.rewriteFiles([], () => "x"), "missing");
});

test("rewriteFiles：读不到的文件跳过，不算失败 → missing", () => {
  const dir = box("rw-read");
  const missing = path.join(dir, "nope.js");
  assert.equal(core.rewriteFiles([missing], () => "x"), "missing");
  assert.equal(fs.existsSync(missing), false);
});

test("rewriteFiles：读不到的文件只跳过这一份，后面能改的仍然改（不提前收工）", () => {
  const dir = box("rw-read2");
  const missing = path.join(dir, "nope.js");
  const later = put(dir, "later.js", "AAA\n");
  assert.equal(core.rewriteFiles([missing, later], (t) => t.replace("AAA", "BBB")), "reverted");
  assert.equal(read(later), "BBB\n");
});

test("rewriteFiles：改写返回同一份文本 → absent，文件没动", () => {
  const dir = box("rw-same");
  const fp = put(dir, "a.js", "keep me\n");
  assert.equal(core.rewriteFiles([fp], (t) => t), "absent");
  assert.equal(read(fp), "keep me\n");
});

test("rewriteFiles：改写返回 null → absent（当作「这里没东西可退」）", () => {
  const dir = box("rw-null");
  const fp = put(dir, "a.js", "keep me\n");
  assert.equal(core.rewriteFiles([fp], () => null), "absent");
  assert.equal(read(fp), "keep me\n");
});

test("rewriteFiles：真的改了 → reverted，且写回的是改写结果", () => {
  const dir = box("rw-ok");
  const fp = put(dir, "a.js", "AAA\n");
  assert.equal(core.rewriteFiles([fp], (t) => t.replace("AAA", "BBB")), "reverted");
  assert.equal(read(fp), "BBB\n");
});

test("rewriteFiles：多文件时取最坏的那个（absent + reverted → reverted）", () => {
  const dir = box("rw-multi");
  const a = put(dir, "a.js", "same\n");
  const b = put(dir, "b.js", "AAA\n");
  assert.equal(core.rewriteFiles([a, b], (t) => (t.includes("AAA") ? "CCC\n" : t)), "reverted");
  assert.equal(core.rewriteFiles([b, a], (t) => (t.includes("CCC") ? t : t)), "absent");
});

test("rewriteFiles：先 reverted 后再遇到 absent，结果仍是 reverted（后者不许顶掉前者）", () => {
  const dir = box("rw-order");
  const changed = put(dir, "changed.js", "AAA\n");
  const untouched = put(dir, "untouched.js", "same\n");
  assert.equal(core.rewriteFiles([changed, untouched], (t) => (t.includes("AAA") ? "BBB\n" : t)), "reverted");
  assert.equal(read(changed), "BBB\n");
  assert.equal(read(untouched), "same\n");
});

test("rewriteFiles：写盘抛错 → error: 前缀，且原文不动", () => {
  const dir = box("rw-err");
  const fp = put(dir, "a.js", "AAA\n");
  const orig = hostFs.writeFileSync;
  hostFs.writeFileSync = () => {
    const e = new Error("EPERM: 假的写失败");
    e.code = "EPERM";
    throw e;
  };
  try {
    const hit = core.rewriteFiles([fp], () => "BBB\n");
    assert.match(hit, /^error:/);
    assert.match(hit, /EPERM/);
  } finally {
    hostFs.writeFileSync = orig;
  }
  assert.equal(read(fp), "AAA\n");
});

test("rewriteFiles：一个写失败 + 后面写成功，仍然是 error（坏结果不被成功覆盖）", () => {
  const dir = box("rw-err2");
  const bad = put(dir, "bad.js", "AAA\n");
  const good = put(dir, "good.js", "AAA\n");
  const orig = hostFs.writeFileSync;
  hostFs.writeFileSync = (fp, ...rest) => {
    if (String(fp).endsWith("bad.js")) throw new Error("mock EPERM");
    return orig.call(hostFs, fp, ...rest);
  };
  try {
    assert.match(core.rewriteFiles([bad, good], () => "BBB\n"), /^error:/);
  } finally {
    hostFs.writeFileSync = orig;
  }
  assert.equal(read(good), "BBB\n", "后面的文件照样要改");
});

/* ── 3. revertCmdFlash：五处注入形态逐字节还原 ─────────────────────── */

const seedAll = (tag) => {
  const home = box("home-" + tag);
  const ai = aiBase(tag);
  const fp = {
    subprocess: put(home, path.relative(home, paths.subprocess(home)), "const x = 1;\n" + SP_PATCHED + "\n"),
    customBash: put(home, path.relative(home, paths.customBash(home)), "async function run(ctx) {\n" + CB_PATCHED + "      throw error\n    }\n}\n"),
    phase1: put(
      home,
      path.relative(home, paths.phase1(home)),
      [
        "const PERSONA_SECTION_NAMES = new Set(['deployment:persona', 'persona', 'dsh-purge', 'dshpg-extra'])",
        "    const sections = Array.isArray(assembled.sections)",
        '      ? assembled.sections.filter(section => PERSONA_SECTION_NAMES.has(section?.name) || String(section?.name || "").startsWith("dsh-purge"))',
        "      : undefined",
        "    // [dsh-purge] phase-1 keep persona+inject sections",
        "    // [dsh-purge] phase-1 keep full system-prompt sections",
        "",
      ].join("\n"),
    ),
    doctor: put(home, path.relative(home, paths.doctor(home)), DOCTOR_SPAWN_BLOCK + "const tail = 1;\n"),
    market: put(home, path.relative(home, paths.market(home)), "import { existsSync } from 'node:fs';\n" + MARKET_HEAD + "    // " + MARKET_MARKER + "\n    {\n        const a = 1;\n    }\n}\n"),
  };
  return { home, ai, fp };
};

test("revertCmdFlash：subprocess-local 的 windowsHide 注入被整段摘掉，回到原文形态", () => {
  const { home, ai, fp } = seedAll("sp");
  const res = core.revertCmdFlash(ai, home);
  assert.equal(res.subprocess, "reverted");
  assert.equal(read(fp.subprocess), "const x = 1;\n" + SP_PLAIN + "\n");
  assert.equal(read(fp.subprocess).includes(SP_MARKER), false);
});

test("revertCmdFlash：已经回退过的文件再来一次 → absent，字节不动（幂等）", () => {
  const { home, ai, fp } = seedAll("sp2");
  assert.equal(core.revertCmdFlash(ai, home).subprocess, "reverted");
  const once = read(fp.subprocess);
  assert.equal(core.revertCmdFlash(ai, home).subprocess, "absent");
  assert.equal(read(fp.subprocess), once);
});

test("revertCmdFlash：只剩 marker、注入形态已被别人改坏 → absent，不许动文件", () => {
  const home = box("home-sp3");
  const ai = aiBase("sp3");
  const fp = put(
    home,
    path.relative(home, paths.subprocess(home)),
    "const x = 1;\n" +
      "\tconst child = spawn(program, args, {\n" +
      "\t\t// " +
      SP_MARKER +
      "\n" +
      "\t\twindowsHide: false\n" +
      "\t});\n",
  );
  const before = read(fp);
  assert.equal(core.revertCmdFlash(ai, home).subprocess, "absent");
  assert.equal(read(fp), before);
});

test("revertCmdFlash：custom-bash 的 System32 拦截块被还原成原来那句", () => {
  const { home, ai, fp } = seedAll("cb");
  assert.equal(core.revertCmdFlash(ai, home).customBash, "reverted");
  assert.equal(read(fp.customBash), "async function run(ctx) {\n" + CB_PLAIN + "      throw error\n    }\n}\n");
});

test("revertCmdFlash：custom-bash 只有 marker → absent", () => {
  const home = box("home-cb2");
  const ai = aiBase("cb2");
  const fp = put(home, path.relative(home, paths.customBash(home)), "// " + CB_MARKER + "\nconst a = 1;\n");
  const before = read(fp);
  assert.equal(core.revertCmdFlash(ai, home).customBash, "absent");
  assert.equal(read(fp), before);
});

test("revertCmdFlash：phase-1 的三处改动全部还原（PERSONA_SECTION_NAMES / filter / 两条注释）", () => {
  const { home, ai, fp } = seedAll("p1");
  assert.equal(core.revertCmdFlash(ai, home).phase1, "reverted");
  const text = read(fp.phase1);
  assert.equal(text.includes("'dsh-purge', 'dshpg-extra'"), false);
  assert.ok(text.includes(P1_ORIG_SET), "PERSONA_SECTION_NAMES 必须回到原始两项");
  assert.ok(text.includes(P1_FILTER), "filter 必须回到只认 PERSONA_SECTION_NAMES");
  assert.equal(text.includes("[dsh-purge] phase-1 keep"), false);
  assert.equal(text.includes("\r\n"), false);
});

test("revertCmdFlash：带 CRLF 的 phase-1 文件回退后整篇变 LF（现状：回退侧不做行尾还原）", () => {
  const home = box("home-p1crlf");
  const ai = aiBase("p1crlf");
  const fp = put(
    home,
    path.relative(home, paths.phase1(home)),
    [
      "const PERSONA_SECTION_NAMES = new Set(['deployment:persona', 'persona', 'dsh-purge'])",
      "    const sections = Array.isArray(assembled.sections)",
      '      ? assembled.sections.filter(section => PERSONA_SECTION_NAMES.has(section?.name) || String(section?.name || "").startsWith("dsh-purge"))',
      "      : undefined",
      "    // [dsh-purge] phase-1 keep persona+inject sections",
      "",
    ].join("\r\n"),
  );
  assert.equal(core.revertCmdFlash(ai, home).phase1, "reverted");
  const text = read(fp);
  assert.equal(text.includes("\r\n"), false);
  assert.ok(text.includes(P1_ORIG_SET));
});

test("revertCmdFlash：doctor 的 spawn 包装被换回一行 import，stdio 恢复 inherit", () => {
  const home = box("home-doc");
  const ai = aiBase("doc");
  const fp = put(
    home,
    path.relative(home, paths.doctor(home)),
    [
      DOCTOR_SPAWN_BLOCK +
        "// [dsh-purge] dsh.cmd → node bin.js (no cmd.exe)\n" +
        'function dshSpawnSpec(binary, args, platform = process.platform) {\n\tif (platform === "win32") {\n\t\tif (binary.toLowerCase().endsWith(".cmd") || binary.toLowerCase().endsWith(".bat")) {\n\t\t\treturn nodeSpec(binary, args);\n\t\t}',
      "",
      '\tconst child = spawnDsh(realDsh, options.argv, {',
      "\t\t// [dsh-purge] doctor launch stdio no-inherit",
      "\t\tstdio: [",
      '\t\t\t"ignore",',
      '\t\t\t"ignore",',
      '\t\t\t"pipe"',
      "\t\t],",
      "\t\twindowsHide: true,",
      "",
    ].join("\n"),
  );
  assert.equal(core.revertCmdFlash(ai, home).doctorSpawn, "reverted");
  const text = read(fp);
  assert.ok(text.startsWith('import { spawn } from "node:child_process";\n'), "包装函数换成裸 import");
  assert.equal(text.includes("__dshPurgeSpawnOrig"), false);
  assert.equal(text.includes("[dsh-purge] doctor"), false);
  assert.equal(text.includes("nodeSpec(binary, args)"), false, ".cmd 分支必须回到 cmd.exe 那版");
  assert.ok(text.includes('command: "cmd.exe"'));
  assert.ok(text.includes('"inherit",\n\t\t\t"inherit",\n\t\t\t"pipe"\n\t\t],'));
  assert.equal(text.includes('"ignore",'), false);
});

test("revertCmdFlash：market 的 respawnInvocation 恢复 win32 头，restart.js 的 import 也回到两行", () => {
  const home = box("home-mk");
  const ai = aiBase("mk");
  const fp = put(
    home,
    path.relative(home, paths.market(home)),
    "import { existsSync } from 'node:fs';\n" +
      "import { tmpdir } from 'node:os';\n" +
      "import { dirname, join } from 'node:path';\n" +
      MARKET_HEAD +
      "    // " +
      MARKET_MARKER +
      "\n" +
      "    {\n        const a = 1;\n    }\n}\n",
  );
  assert.equal(core.revertCmdFlash(ai, home).market, "reverted");
  const text = read(fp);
  assert.ok(text.includes("const a = 1;") === false, "注入的 win32 分支必须摘掉");
  assert.equal(text.includes(MARKET_MARKER), false);
  assert.ok(text.includes("import { existsSync } from 'node:fs';") === false);
  assert.ok(text.includes("import { tmpdir } from 'node:os';\nimport { join } from 'node:path';"));
  assert.ok(text.includes(MARKET_HEAD), "win32 头必须逐字节回到原文（含 !== 'win32' 与四空格缩进）");
});

test("revertCmdFlash：五个文件都没有 marker 时一个字节都不动，五个 key 全是 absent", () => {
  const home = box("home-plain");
  const ai = aiBase("plain");
  const plain = "// upstream\nconst a = 1;\n";
  const fp = {
    subprocess: put(home, path.relative(home, paths.subprocess(home)), plain),
    customBash: put(home, path.relative(home, paths.customBash(home)), plain),
    phase1: put(home, path.relative(home, paths.phase1(home)), plain),
    doctor: put(home, path.relative(home, paths.doctor(home)), plain),
    market: put(home, path.relative(home, paths.market(home)), plain),
  };
  const res = core.revertCmdFlash(ai, home);
  const keys = {
    subprocess: "subprocess",
    customBash: "customBash",
    phase1: "phase1",
    doctor: "doctorSpawn",
    market: "market",
  };
  for (const [k, resKey] of Object.entries(keys)) assert.equal(res[resKey], "absent", k);
  for (const p of Object.values(fp)) assert.equal(read(p), plain);
});

/* ── 4. 打到哪棵树：subprocess 分支必须听显式 aiBase ───────────────── */

test("revertCmdFlash：subprocess-local 打的是传进来的 aiBase，不是 findAiBase() 那棵", () => {
  const home = box("home-tree");
  const mine = aiBase("tree-mine");
  const other = aiBase("tree-other");
  const rel = path.join("dsh-subprocess-local", "lib", "index.js");
  const mineFp = put(mine, rel, SP_PATCHED + "\n");
  const otherFp = put(other, rel, SP_PATCHED + "\n");
  const res = core.revertCmdFlash(mine, home);
  assert.equal(res.subprocess, "reverted");
  assert.equal(read(mineFp).includes(SP_MARKER), false, "指定那棵树要退干净");
  assert.equal(read(otherFp).includes(SP_MARKER), true, "别的树不许动");
});

test("revertCmdFlash：aiBase 下的嵌套副本（dsh/node_modules/@deepseek-ai/...）也一起退", () => {
  const home = box("home-nest");
  const ai = aiBase("nest");
  const fp = put(
    ai,
    path.join("dsh", "node_modules", "@deepseek-ai", "dsh-subprocess-local", "lib", "index.js"),
    SP_PATCHED + "\n",
  );
  assert.equal(core.revertCmdFlash(ai, home).subprocess, "reverted");
  assert.equal(read(fp).includes(SP_MARKER), false);
});

test("revertCmdFlash：返回值的七个 key 与顺序固定，hide/preflight 来自另外两个模块", () => {
  const home = box("home-keys");
  const ai = aiBase("keys");
  const res = core.revertCmdFlash(ai, home);
  assert.deepEqual(Object.keys(res), [
    "hide",
    "preflight",
    "subprocess",
    "customBash",
    "phase1",
    "doctorSpawn",
    "market",
  ]);
  assert.equal(res.hide, "missing_bin");
  assert.equal(res.preflight, "missing_bin");
});

/* ── 5. 五个文件清单 ───────────────────────────────────────────────── */

test("listSubprocessLocalFiles：aiBase 指到 profile 里那份时，同一路径不会出现两次（去重）", () => {
  const home = box("list-sp2");
  const rel = path.join("node_modules", "@deepseek-ai", "dsh-subprocess-local", "lib", "index.js");
  const fp = put(home, path.join("profiles", "web", rel), "a");
  const ai = path.join(home, "profiles", "web", "node_modules", "@deepseek-ai");
  const got = core.listSubprocessLocalFiles(home, ai);
  assert.deepEqual(got, [fp]);
});

test("listSubprocessLocalFiles：profile 逐个扫，重复路径只出现一次，非文件不算", () => {
  const home = box("list-sp");
  const ai = aiBase("list-sp");
  const rel = path.join("node_modules", "@deepseek-ai", "dsh-subprocess-local", "lib", "index.js");
  const a = put(home, path.join("profiles", "web", rel), "a");
  const b = put(home, path.join("profiles", "desktop", rel), "b");
  put(ai, path.join("dsh-subprocess-local", "lib", "index.js"), "c");
  fs.mkdirSync(path.join(home, "profiles", "empty", "node_modules"), { recursive: true });
  const got = core.listSubprocessLocalFiles(home, ai);
  assert.equal(got.length, 3);
  assert.ok(got.includes(a) && got.includes(b));
  assert.ok(got.every((p) => fs.existsSync(p)));
  assert.equal(new Set(got).size, got.length);
});

test("listLiangshenCustomBashFiles：两条固定路径，只收存在的", () => {
  const home = box("list-cb");
  const one = put(
    home,
    path.join("profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "custom-bash.mjs"),
    "x",
  );
  assert.deepEqual(core.listLiangshenCustomBashFiles(home), [one]);
  put(
    home,
    path.join("profiles", "web", "node_modules", "@linxin666", "dsh-web-all", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "custom-bash.mjs"),
    "y",
  );
  assert.equal(core.listLiangshenCustomBashFiles(home).length, 2);
});

test("listLiangshenBootstrapFiles：web 面只收 web 档与共享档（profiles/desktop 的那份被挡掉）", () => {
  const home = box("list-p1web");
  const rel = path.join("node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "tool-bootstrap.mjs");
  const web = put(home, path.join("profiles", "web", rel), "x");
  const fallback = put(
    home,
    path.join("profiles", "web", ".dsh-module-fallback", rel),
    "y",
  );
  const nested = put(home, path.join("profiles", "web", "node_modules", "@linxin666", "dsh-web-all", rel), "z");
  const desktopCopy = put(home, path.join("profiles", "desktop", rel), "d");
  const shared = put(home, path.join(".agent-presets", "liangshen", "tool-bootstrap.mjs"), "s");
  const orig = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "web";
  try {
    const got = core.listLiangshenBootstrapFiles(home);
    assert.deepEqual(got, [web, fallback, nested, shared]);
    assert.equal(got.includes(desktopCopy), false, "surface=web 时桌面档不进清单");
  } finally {
    if (orig === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = orig;
  }
});

test("listLiangshenBootstrapFiles：desktop 面反过来只收桌面档与共享档（同一个函数，两份清单）", () => {
  const home = box("list-p1desk");
  const rel = path.join("node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "tool-bootstrap.mjs");
  put(home, path.join("profiles", "web", rel), "x");
  const desktopCopy = put(home, path.join("profiles", "desktop", rel), "d");
  const shared = put(home, path.join(".agent-presets", "liangshen", "tool-bootstrap.mjs"), "s");
  const orig = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "desktop";
  try {
    assert.deepEqual(core.listLiangshenBootstrapFiles(home), [desktopCopy, shared]);
  } finally {
    if (orig === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = orig;
  }
});

test("listDoctorCliFiles：web/desktop 两条 + 嵌套副本 + profiles 逐个扫，去重", () => {
  const home = box("list-doc");
  const rel = path.join("node_modules", "@linxin666", "dsh-doctor", "lib", "cli.mjs");
  const web = put(home, path.join("profiles", "web", rel), "x");
  const nested = put(
    home,
    path.join("profiles", "web", "node_modules", "@linxin666", "dsh-web-all", "node_modules", "@linxin666", "dsh-doctor", "lib", "cli.mjs"),
    "y",
  );
  const third = put(home, path.join("profiles", "other", rel), "z");
  const got = core.listDoctorCliFiles(home);
  assert.equal(got.length, 3);
  assert.ok(got.includes(web) && got.includes(nested) && got.includes(third));
  assert.equal(new Set(got).size, 3);
});

test("listDshmarketRestartFiles：web/desktop + profiles 逐个扫，去重", () => {
  const home = box("list-mk");
  const rel = path.join("node_modules", "dshmarket", "lib", "restart.js");
  const web = put(home, path.join("profiles", "web", rel), "x");
  const third = put(home, path.join("profiles", "third", rel), "y");
  const got = core.listDshmarketRestartFiles(home);
  assert.equal(got.length, 2);
  assert.ok(got.includes(web) && got.includes(third));
});

test("五个清单函数：dshHome 不存在时全部返回空数组，不抛", () => {
  const ghost = path.join(ROOT, "no-such-home");
  const ai = aiBase("ghost");
  for (const fn of [
    core.listLiangshenCustomBashFiles,
    core.listLiangshenBootstrapFiles,
    core.listDoctorCliFiles,
    core.listDshmarketRestartFiles,
  ]) {
    assert.deepEqual(fn(ghost), []);
  }
  assert.deepEqual(core.listSubprocessLocalFiles(ghost, null), []);
});

/* ── 6. 源码形状：回退侧不许自己再找一个 aiBase ───────────────────── */

test("revertCmdFlash 的 subprocess 分支把显式 aiBase 传下去（不许内部调 findAiBase）", () => {
  const src = fs.readFileSync(new URL("../lib/core.js", import.meta.url), "utf8");
  assert.ok(src.includes("rewriteFiles(listSubprocessLocalFiles(dshHome, aiBase)"));
  const start = src.indexOf("export function listSubprocessLocalFiles(");
  const body = src.slice(start, start + 1400);
  assert.equal(/const aiBase = findAiBase\(\)/.test(body), false);
  assert.ok(body.includes("aiBase = findAiBase()"), "默认值仍然要兜底");
});
