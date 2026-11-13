// lib/core.js 的「静默子进程弹窗」这一簇：
//   silenceLiangshenCustomBashFlash / silenceLiangshenPhase1Strip / silenceOfficialPhase1Strip
//   liangshenPromptFilterText / keepLiangshenOperatorPrompt / silenceMnemonGitFlash
//   silenceSubprocessLocalFlash / silenceDoctorSpawnFlash / silenceDshmarketRestartFlash
//   stubDoctorSupervisor / silenceCmdFlash（聚合）
// 全部在临时 $DSH_HOME + 伪造 aiBase 里跑，不碰真 home、不碰真宿主、不跑 schtasks。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../lib/core.js";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-silence-"));
const ORIG = {
  DSH_HOME: process.env.DSH_HOME,
  DSH_SURFACE: process.env.DSH_SURFACE,
  DSH_BASE: process.env.DSH_BASE,
};
const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");
let seq = 0;

const N = "\n";
const T = "\t";

/** 每例一套全新 home + aiBase，并钉进环境变量（findDshHome / findAiBase 都读它们）。 */
function sandbox(tag = "s") {
  seq += 1;
  const root = path.join(SANDBOX, `${tag}-${seq}`);
  const home = path.join(root, "home");
  const ai = path.join(root, "ai");
  fs.mkdirSync(home, { recursive: true });
  // isAiBase 的判据：<ai>/dsh-agent-instructions/lib 存在。
  fs.mkdirSync(path.join(ai, "dsh-agent-instructions", "lib"), { recursive: true });
  process.env.DSH_HOME = home;
  process.env.DSH_SURFACE = "web";
  process.env.DSH_BASE = ai;
  core.resetPathMemo();
  return { root, home, ai };
}

/** 把 process.platform 临时改成别的值再跑 fn；finally 还原。 */
function asPlatform(value, fn) {
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", REAL_PLATFORM);
  }
}

function put(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
  return fp;
}

const read = (fp) => fs.readFileSync(fp, "utf8");

test.after(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  Object.defineProperty(process, "platform", REAL_PLATFORM);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// ------------------------------------------------------------ 平台闸门（纯早退）

test("五个 silence* 在非 win32 早退 skipped_not_win32，且一个字节都不写", () => {
  const sb = sandbox("plat");
  // 每条都先把目标文件放好：若平台闸门失效就会真的改写，断言能看见。
  const cb = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "custom-bash.mjs"),
    "    try {" + N + "      return await ctx.subprocess.resolveExecutable('bash', undefined, signal)" + N + "    } catch (error) {" + N,
  );
  const sub = put(path.join(sb.ai, "dsh-subprocess-local", "lib", "index.js"), SUB_BODY);
  const mn = put(path.join(sb.home, "profiles", "web", "node_modules", "dsh-mnemon", "lib", "index.js"), MNEMON_BODY);
  const doc = put(path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-doctor", "lib", "cli.mjs"), DOC_BODY);
  const mk = put(path.join(sb.home, "profiles", "web", "node_modules", "dshmarket", "lib", "restart.js"), MARKET_BODY);
  const targets = [cb, sub, mn, doc, mk];
  const before = targets.map(read);

  const out = asPlatform("linux", () => ({
    customBash: core.silenceLiangshenCustomBashFlash(sb.home),
    mnemon: core.silenceMnemonGitFlash(sb.home),
    subprocess: core.silenceSubprocessLocalFlash(sb.home),
    doctor: core.silenceDoctorSpawnFlash(sb.home),
    market: core.silenceDshmarketRestartFlash(sb.home),
    stub: core.stubDoctorSupervisor(),
  }));

  assert.equal(out.customBash, "skipped_not_win32");
  assert.equal(out.mnemon, "skipped_not_win32");
  assert.equal(out.subprocess, "skipped_not_win32");
  assert.equal(out.doctor, "skipped_not_win32");
  assert.equal(out.market, "skipped_not_win32");
  assert.deepEqual(out.stub, { skipped: "not_win32" });
  assert.deepEqual(targets.map(read), before, "有平台闸门的那五个在非 win32 不许写盘");
});

test("phase1 / official / operator 三个没有平台闸门，非 win32 照样改盘（现状锁定）", () => {
  const sb = sandbox("plat-nogate");
  const boot = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "tool-bootstrap.mjs"),
    P1_SET + N + "function f(assembled) {" + N + P1_NEEDLE + N + "}" + N,
  );
  const off = put(path.join(sb.ai, "dsh-agent-instructions", "lib", "index.js"), P1_NEEDLE + N);
  const min = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "minimal-prompt.mjs"),
    KEEP_BARE + N,
  );
  const before = [boot, off, min].map(read);

  const out = asPlatform("linux", () => ({
    phase1: core.silenceLiangshenPhase1Strip(sb.home),
    official: core.silenceOfficialPhase1Strip(sb.home),
    operator: core.keepLiangshenOperatorPrompt(sb.home),
  }));

  assert.equal(out.phase1, "missing");
  assert.equal(out.official, "missing");
  assert.equal(out.operator, "missing");
  const after = [boot, off, min].map(read);
  for (let i = 0; i < after.length; i += 1) {
    assert.notEqual(after[i], before[i], `第 ${i} 个文件应当被改（这三个函数不判平台）`);
  }
});

test("silenceCmdFlash 在非 win32 汇总成 ok:true，各段都是 skipped_not_win32", () => {
  const sb = sandbox("cmdflash-linux");
  const out = asPlatform("linux", () => core.silenceCmdFlash(sb.ai));
  assert.equal(out.ok, true, "非 win32 上 hideOk 恒真");
  assert.equal(out.entry, "skipped_not_win32");
  assert.equal(out.entryRoot, null);
  assert.deepEqual(out.doctor, { skipped: "not_win32" });
  for (const key of ["doctorSpawn", "market", "subprocess", "customBash", "mnemon"]) {
    assert.equal(out[key], "skipped_not_win32", `${key} 应当跳过`);
  }
  // 三个无平台闸门的段在这个空 home 里都是 missing。
  assert.equal(out.phase1, "missing");
  assert.equal(out.officialPhase1, "missing");
  assert.equal(out.liangshenPrompt, "missing");
});

// -------------------------------------------- worseLiangshenHit 的聚合口径（真怪癖）

test("聚合返回值只可能是 missing / pattern_miss / error:*：patched 永远显示不出来", () => {
  const sb = sandbox("rank-patched");
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "custom-bash.mjs"),
    "    try {" + N + "      return await ctx.subprocess.resolveExecutable('bash', undefined, signal)" + N + "    } catch (error) {" + N,
  );
  const ret = core.silenceLiangshenCustomBashFlash(sb.home);
  assert.equal(ret, "missing", "文件确实改了，聚合值仍是初值 missing");
  assert.match(read(fp), /\[dsh-purge\] never fall back to WSL System32 bash/, "改是改了");
});

test("already 也显示不出来：二次调用仍回 missing，且不再改文件", () => {
  const sb = sandbox("rank-already");
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "custom-bash.mjs"),
    "    try {" + N + "      return await ctx.subprocess.resolveExecutable('bash', undefined, signal)" + N + "    } catch (error) {" + N,
  );
  assert.equal(core.silenceLiangshenCustomBashFlash(sb.home), "missing");
  const once = read(fp);
  const mtime = fs.statSync(fp).mtimeMs;
  assert.equal(core.silenceLiangshenCustomBashFlash(sb.home), "missing");
  assert.equal(read(fp), once, "二次调用不重写");
  assert.equal(fs.statSync(fp).mtimeMs, mtime);
});

test("只有一个文件打不上时 pattern_miss 胜出，但已经改过的文件不回滚", () => {
  const sb = sandbox("rank-miss");
  const a = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "custom-bash.mjs"),
    "    try {" + N + "      return await ctx.subprocess.resolveExecutable('bash', undefined, signal)" + N + "    } catch (error) {" + N,
  );
  const b = put(
    path.join(
      sb.home,
      "profiles",
      "web",
      "node_modules",
      "@linxin666",
      "dsh-web-all",
      "node_modules",
      "@linxin666",
      "dsh-liangshen",
      "presets",
      "liangshen",
      "custom-bash.mjs",
    ),
    "const unrelated = 1" + N,
  );
  assert.equal(core.silenceLiangshenCustomBashFlash(sb.home), "pattern_miss");
  assert.match(read(a), /WSL bash launcher is not Git Bash/, "打上的那条保留");
  assert.equal(read(b), "const unrelated = 1" + N, "打不上的那条一字不动");
});

test("一个候选文件都没有时回 missing，也不新建文件", () => {
  const sb = sandbox("rank-none");
  assert.equal(core.silenceLiangshenCustomBashFlash(sb.home), "missing");
  assert.equal(fs.existsSync(path.join(sb.home, "profiles")), false, "不许顺手建目录");
});

// ------------------------------------------------- silenceLiangshenCustomBashFlash

test("custom-bash 的注入了三条防线：marker、WSL 路径正则、返回 resolved", () => {
  const sb = sandbox("cb-body");
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "custom-bash.mjs"),
    "    try {" + N + "      return await ctx.subprocess.resolveExecutable('bash', undefined, signal)" + N + "    } catch (error) {" + N,
  );
  core.silenceLiangshenCustomBashFlash(sb.home);
  const text = read(fp);
  assert.match(text, /\/\/ \[dsh-purge\] never fall back to WSL System32 bash/);
  assert.match(text, /const resolved = await ctx\.subprocess\.resolveExecutable\('bash', undefined, signal\)/);
  assert.match(text, /\(System32\|SysWOW64\|WindowsApps\)/);
  assert.match(text, /WSL bash launcher is not Git Bash/);
  assert.match(text, /return resolved/);
  assert.equal(text.split("resolveExecutable('bash'").length - 1, 1, "解析调用只留一次（改写成 const resolved = …）");
});

test("custom-bash 只认 web 与 web-all 嵌套两处，.dsh-module-fallback 里的不算", () => {
  const sb = sandbox("cb-paths");
  const fallback = put(
    path.join(
      sb.home,
      "profiles",
      "web",
      ".dsh-module-fallback",
      "node_modules",
      "@linxin666",
      "dsh-liangshen",
      "presets",
      "liangshen",
      "custom-bash.mjs",
    ),
    "    try {" + N + "      return await ctx.subprocess.resolveExecutable('bash', undefined, signal)" + N + "    } catch (error) {" + N,
  );
  assert.equal(core.silenceLiangshenCustomBashFlash(sb.home), "missing");
  assert.doesNotMatch(read(fallback), /dsh-purge/);
});

test("写盘失败回 error: 前缀（本平台不允许写只读文件时才校验）", (t) => {
  const sb = sandbox("cb-error");
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "custom-bash.mjs"),
    "    try {" + N + "      return await ctx.subprocess.resolveExecutable('bash', undefined, signal)" + N + "    } catch (error) {" + N,
  );
  fs.chmodSync(fp, 0o444);
  let writable = true;
  try {
    fs.writeFileSync(fp, "probe", "utf8");
  } catch {
    writable = false;
  }
  if (writable) {
    t.skip("当前账号/文件系统允许写只读文件，这条分支测不出来");
    return;
  }
  const ret = core.silenceLiangshenCustomBashFlash(sb.home);
  assert.match(ret, /^error:/);
  assert.match(ret, /Error: /, "String(Error) 带 Error: 前缀");
});

// ------------------------------------------------------- silenceLiangshenPhase1Strip

const P1_SET = "const PERSONA_SECTION_NAMES = new Set(['deployment:persona', 'persona'])";
const P1_MARKER = "[dsh-purge] phase-1 keep persona+inject sections";
const P1_KEEP_ALL = "[dsh-purge] phase-1 keep full system-prompt sections";
const P1_UNFILTERED = "    const sections = Array.isArray(assembled.sections)" + N + "      ? assembled.sections" + N + "      : undefined";
const P1_NEEDLE =
  "    const sections = Array.isArray(assembled.sections)" +
  N +
  "      ? assembled.sections.filter(section => PERSONA_SECTION_NAMES.has(section?.name))" +
  N +
  "      : undefined";
const P1_WIDE_OLD =
  "    const sections = Array.isArray(assembled.sections)" +
  N +
  '      ? assembled.sections.filter(section => PERSONA_SECTION_NAMES.has(section?.name) || String(section?.name || "").startsWith("dsh-purge"))' +
  N +
  "      : undefined";

function p1file(sb, mid) {
  return put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "tool-bootstrap.mjs"),
    P1_SET + N + "function f(assembled) {" + N + mid + N + "}" + N,
  );
}

test("phase1：窄 filter 被换成放宽版，人设集合补到 10 项", () => {
  const sb = sandbox("p1-needle");
  const fp = p1file(sb, P1_NEEDLE);
  core.silenceLiangshenPhase1Strip(sb.home);
  const text = read(fp);
  assert.match(text, /\/\/ \[dsh-purge\] phase-1 keep persona\+inject sections/);
  assert.match(text, /startsWith\("dsh-purge"\).*startsWith\("dshpg-"\)/);
  for (const name of ["deployment:persona-prefix", "persona-prefix", "deployment:persona-suffix", "persona-suffix"]) {
    assert.match(text, new RegExp(`'${name.replace(/[.]/g, "\\.")}'`), `集合里应有 ${name}`);
  }
  assert.doesNotMatch(text, /assembled\.sections\?/, "不该出现别的形态");
});

test("phase1：已经是裸 sections（unfiltered）也会被加上 marker", () => {
  const sb = sandbox("p1-unfiltered");
  const fp = p1file(sb, P1_UNFILTERED);
  core.silenceLiangshenPhase1Strip(sb.home);
  const text = read(fp);
  assert.match(text, /\[dsh-purge\] phase-1 keep persona\+inject sections/);
  assert.match(text, /startsWith\("dshpg-"\)/);
});

test("phase1：keepAll 与 keepAllStacked 两种旧形态都被收成一条 marker", () => {
  for (const [tag, mid] of [
    ["keepall", "    // " + P1_KEEP_ALL + N + P1_UNFILTERED],
    ["stacked", "    // " + P1_MARKER + N + "    // " + P1_KEEP_ALL + N + P1_UNFILTERED],
  ]) {
    const sb = sandbox("p1-" + tag);
    const fp = p1file(sb, mid);
    core.silenceLiangshenPhase1Strip(sb.home);
    const text = read(fp);
    assert.doesNotMatch(text, new RegExp(P1_KEEP_ALL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${tag}：keepAll marker 必须删掉`);
    assert.equal(text.split(P1_MARKER).length - 1, 1, `${tag}：只剩一条 marker`);
  }
});

test("phase1：needleWideOld 形态（只有 dsh-purge 没有 dshpg-）被换成放宽版", () => {
  const sb = sandbox("p1-wideold");
  const fp = p1file(sb, P1_WIDE_OLD);
  core.silenceLiangshenPhase1Strip(sb.home);
  const text = read(fp);
  assert.match(text, /startsWith\("dshpg-"\)/);
  assert.match(text, /\[dsh-purge\] phase-1 keep persona\+inject sections/);
});

test("phase1：没有 sections 三行也照样把人设集合放宽（现状）", () => {
  const sb = sandbox("p1-setonly");
  const fp = p1file(sb, "    const x = 1");
  core.silenceLiangshenPhase1Strip(sb.home);
  const text = read(fp);
  assert.match(text, /'deployment:persona-suffix'/);
  assert.doesNotMatch(text, /\[dsh-purge\] phase-1 keep persona\+inject sections/, "没有可替换的块就不加 marker");
});

test("phase1：CRLF 文件读进来会被归一成 LF 写回", () => {
  const sb = sandbox("p1-crlf");
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "tool-bootstrap.mjs"),
    (P1_SET + N + "function f(assembled) {" + N + P1_NEEDLE + N + "}" + N).replace(/\n/g, "\r\n"),
  );
  core.silenceLiangshenPhase1Strip(sb.home);
  const text = read(fp);
  assert.equal(text.includes("\r"), false, "写回的是纯 LF");
  assert.match(text, /startsWith\("dshpg-"\)/);
});

test("phase1：已经完全打好时不再改文件（already 分支）", () => {
  const sb = sandbox("p1-already");
  const done =
    "const PERSONA_SECTION_NAMES = new Set(['deployment:persona', 'persona', 'deployment:persona-prefix', 'persona-prefix', 'deployment:persona-suffix', 'persona-suffix', 'dsh-purge:identity', 'dsh-purge', 'dsh-purge:rules', 'dsh-purge:post'])" +
    N +
    "function f(assembled) {" +
    N +
    "    // " +
    P1_MARKER +
    N +
    '    const sections = Array.isArray(assembled.sections)' +
    N +
    '      ? assembled.sections.filter(section => PERSONA_SECTION_NAMES.has(section?.name) || String(section?.name || "").startsWith("dsh-purge") || String(section?.name || "").startsWith("dshpg-"))' +
    N +
    "      : undefined" +
    N +
    "}" +
    N;
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "tool-bootstrap.mjs"),
    done,
  );
  const mtime = fs.statSync(fp).mtimeMs;
  assert.equal(core.silenceLiangshenPhase1Strip(sb.home), "missing", "already 被 rank 吃掉，聚合值仍是 missing");
  assert.equal(read(fp), done);
  assert.equal(fs.statSync(fp).mtimeMs, mtime);
});

test("phase1：contexts 与 isAllowedMessage 的放行段会被还原", () => {
  const sb = sandbox("p1-context");
  const ctxMarker = "[dsh-purge] phase-1 keep runtime context";
  const body =
    P1_SET +
    N +
    "function f(assembled) {" +
    N +
    P1_NEEDLE +
    N +
    "    const contexts = [" +
    N +
    "      // " +
    ctxMarker +
    N +
    "    ];" +
    N +
    "}" +
    N +
    "function isAllowedMessage(message, allowedSources) {" +
    N +
    "  const kind = message.source?.kind" +
    N +
    "  // " +
    ctxMarker +
    N +
    '  if (message?.source?.plugin === "@deepseek-ai/dsh-system-prompt") return true' +
    N +
    "  return kind !== undefined && allowedSources.has(kind)" +
    N +
    "}" +
    N;
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "tool-bootstrap.mjs"),
    body,
  );
  core.silenceLiangshenPhase1Strip(sb.home);
  const text = read(fp);
  assert.equal(text.includes(ctxMarker), false, "runtime context 的 marker 必须清掉");
  assert.match(text, /contexts: \[\],/);
  assert.equal(text.includes('plugin === "@deepseek-ai/dsh-system-prompt"'), false, "官方放行必须撤掉");
});

test("phase1：没有可替换块时第一轮只改人设集合，第二轮回 pattern_miss", () => {
  const sb = sandbox("p1-miss");
  const fp = p1file(sb, "    const x = 1");
  assert.equal(core.silenceLiangshenPhase1Strip(sb.home), "missing", "第一轮改了集合，但聚合值仍是初值");
  const afterFirst = read(fp);
  assert.match(afterFirst, /'deployment:persona-suffix'/, "集合被放宽");
  assert.equal(afterFirst.includes(P1_MARKER), false, "没有可替换的块就不加 marker");
  assert.equal(core.silenceLiangshenPhase1Strip(sb.home), "pattern_miss", "第二轮没有任何可改的就报 pattern_miss");
  assert.equal(read(fp), afterFirst);
});

// ------------------------------------------------------ silenceOfficialPhase1Strip

test("official phase1：窄 filter 被放宽", () => {
  const sb = sandbox("off-patch");
  const fp = put(path.join(sb.ai, "dsh-agent-instructions", "lib", "index.js"), "function f(assembled) {" + N + P1_NEEDLE + N + "}" + N);
  assert.equal(core.silenceOfficialPhase1Strip(sb.home), "missing");
  const text = read(fp);
  assert.match(text, /startsWith\("dshpg-"\)/);
  assert.doesNotMatch(text, /startsWith\("dsh-purge"\)\s*\)/, "旧的窄形态必须被替换掉");
});

test("official phase1：bootstrap.js 与 index.js 都在候选里", () => {
  const sb = sandbox("off-boot");
  const fp = put(path.join(sb.ai, "dsh-agent-instructions", "lib", "bootstrap.js"), "function f() {" + N + P1_NEEDLE + N + "}" + N);
  core.silenceOfficialPhase1Strip(sb.home);
  assert.match(read(fp), /startsWith\("dshpg-"\)/);
});

test("official phase1：文件里没有 PERSONA_SECTION_NAMES 时不动它", () => {
  const sb = sandbox("off-noset");
  const fp = put(path.join(sb.ai, "dsh-agent-instructions", "lib", "index.js"), "const x = 1" + N);
  assert.equal(core.silenceOfficialPhase1Strip(sb.home), "missing");
  assert.equal(read(fp), "const x = 1" + N);
});

test("official phase1：已经放宽过的不再改（already 分支），聚合值仍 missing", () => {
  const sb = sandbox("off-already");
  const done =
    'x.filter(section => PERSONA_SECTION_NAMES.has(section?.name) || String(section?.name || "").startsWith("dsh-purge") || String(section?.name || "").startsWith("dshpg-"))' +
    N;
  const fp = put(path.join(sb.ai, "dsh-agent-instructions", "lib", "index.js"), done);
  assert.equal(core.silenceOfficialPhase1Strip(sb.home), "missing");
  assert.equal(read(fp), done);
});

// ------------------------------------- liangshenPromptFilterText / keepLiangshenOperatorPrompt

const KEEP_OPERATOR =
  'const sections = assembled.sections.filter(section => keep.has(section?.name) || String(section?.name || "").startsWith("dsh-purge") || String(section?.name || "").startsWith("dshpg-")) // [dsh-purge] liangshen keep operator';
const KEEP_OPERATOR_OLD =
  'const sections = assembled.sections.filter(section => keep.has(section?.name) || String(section?.name || "").startsWith("dsh-purge")) // [dsh-purge] liangshen keep operator';
const KEEP_BARE = "const sections = assembled.sections.filter(section => keep.has(section?.name))";

test("liangshenPromptFilterText：四种输入四种结果", () => {
  assert.equal(core.liangshenPromptFilterText(KEEP_OPERATOR), KEEP_OPERATOR, "已是新版原样返回");
  assert.equal(core.liangshenPromptFilterText(KEEP_OPERATOR_OLD), KEEP_OPERATOR, "旧版升级成新版");
  assert.equal(core.liangshenPromptFilterText(KEEP_BARE), KEEP_OPERATOR, "裸 filter 换成保留操作者段");
  assert.equal(core.liangshenPromptFilterText("nothing here"), "nothing here", "无关正文原样返回");
});

test("liangshenPromptFilterText：CRLF 输入先归一成 LF", () => {
  const crlf = (KEEP_BARE + N).replace(/\n/g, "\r\n");
  const out = core.liangshenPromptFilterText(crlf);
  assert.equal(out.includes("\r"), false);
  assert.equal(out, KEEP_OPERATOR + N);
});

test("keepLiangshenOperatorPrompt：minimal-prompt 与 .agent-presets 两处都改", () => {
  const sb = sandbox("keep-operator");
  const a = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "minimal-prompt.mjs"),
    KEEP_BARE + N,
  );
  const b = put(path.join(sb.home, ".agent-presets", "liangshen", "minimal-prompt.mjs"), KEEP_BARE + N);
  assert.equal(core.keepLiangshenOperatorPrompt(sb.home), "missing");
  assert.equal(read(a), KEEP_OPERATOR + N);
  assert.equal(read(b), KEEP_OPERATOR + N);
});

test("keepLiangshenOperatorPrompt：已经是新版就不重写", () => {
  const sb = sandbox("keep-already");
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "minimal-prompt.mjs"),
    KEEP_OPERATOR + N,
  );
  const mtime = fs.statSync(fp).mtimeMs;
  core.keepLiangshenOperatorPrompt(sb.home);
  assert.equal(read(fp), KEEP_OPERATOR + N);
  assert.equal(fs.statSync(fp).mtimeMs, mtime);
});

test("keepLiangshenOperatorPrompt：无关正文不动", () => {
  const sb = sandbox("keep-other");
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "minimal-prompt.mjs"),
    "const other = 1" + N,
  );
  assert.equal(core.keepLiangshenOperatorPrompt(sb.home), "pattern_miss", "文件在但形态对不上 → pattern_miss，不是 missing");
  assert.equal(read(fp), "const other = 1" + N);
});

test("keepLiangshenOperatorPrompt：一个候选文件都没有时回 missing", () => {
  const sb = sandbox("keep-none");
  assert.equal(core.keepLiangshenOperatorPrompt(path.join(sb.root, "nowhere")), "missing");
});

// ------------------------------------------------------------ silenceMnemonGitFlash

const MNEMON_BODY =
  "function resolveGitBranch(cwd) {" +
  N +
  T +
  'const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" })' +
  N +
  T +
  "return out.trim()" +
  N +
  "}" +
  N +
  "//#endregion" +
  N +
  "//#region src/memory-view.ts" +
  N +
  "const tail = 1" +
  N;

test("mnemon：resolveGitBranch 被换成读 .git 的实现，不再 spawn git", () => {
  const sb = sandbox("mnemon");
  const fp = put(path.join(sb.home, "profiles", "web", "node_modules", "dsh-mnemon", "lib", "index.js"), MNEMON_BODY);
  assert.equal(core.silenceMnemonGitFlash(sb.home), "missing");
  const text = read(fp);
  assert.equal(text.includes('execFileSync("git", ['), false);
  assert.match(text, /不在这里 spawn git\.exe/);
  assert.match(text, /for \(let i = 0; i < 64; i\+\+\)/);
  assert.match(text, /\/\/#region src\/memory-view\.ts/, "region 注释要保住");
});

test("mnemon：replacement 里没有 marker，所以二次调用报 pattern_miss（现状锁定）", () => {
  const sb = sandbox("mnemon-twice");
  const fp = put(path.join(sb.home, "profiles", "web", "node_modules", "dsh-mnemon", "lib", "index.js"), MNEMON_BODY);
  core.silenceMnemonGitFlash(sb.home);
  assert.equal(read(fp).includes("dsh-purge: never spawn git.exe here"), false, "replacement 里确实没有 marker");
  assert.equal(core.silenceMnemonGitFlash(sb.home), "pattern_miss");
});

test("mnemon：dsh-web-all 嵌套副本也在候选里", () => {
  const sb = sandbox("mnemon-nested");
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "dsh-web-all", "node_modules", "dsh-mnemon", "lib", "index.js"),
    MNEMON_BODY,
  );
  core.silenceMnemonGitFlash(sb.home);
  assert.equal(read(fp).includes('execFileSync("git", ['), false);
});

// ------------------------------------------------- silenceSubprocessLocalFlash

const SUB_BODY = [
  "function run(program, args, spec) {",
  T + "const child = spawn(program, args, {",
  T + T + "cwd: spec.cwd,",
  T + T + "env,",
  T + T + "stdio: [",
  T + T + T + 'stdinMode === "ignore" ? "ignore" : "pipe",',
  T + T + T + 'outMode === "inherit" ? "inherit" : "pipe",',
  T + T + T + 'errMode === "inherit" ? "inherit" : "pipe"',
  T + T + "],",
  T + T + 'detached: platform !== "win32"',
  T + "});",
  "}",
  "",
].join(N);

test("subprocess-local：stdio 块后面补 windowsHide: true", () => {
  const sb = sandbox("subprocess");
  const fp = put(path.join(sb.ai, "dsh-subprocess-local", "lib", "index.js"), SUB_BODY);
  assert.equal(core.silenceSubprocessLocalFlash(sb.home), "missing");
  const text = read(fp);
  assert.match(text, /\/\/ \[dsh-purge\] subprocess-local windowsHide/);
  assert.match(text, /windowsHide: true/);
  assert.match(text, /detached: platform !== "win32",/);
});

test("subprocess-local：形态对不上时一字不动", () => {
  const sb = sandbox("subprocess-miss");
  const fp = put(path.join(sb.ai, "dsh-subprocess-local", "lib", "index.js"), "const child = spawn(x)" + N);
  core.silenceSubprocessLocalFlash(sb.home);
  assert.equal(read(fp), "const child = spawn(x)" + N);
});

// ------------------------------------------------- silenceDoctorSpawnFlash（三处）

const DOC_BODY = [
  'import { spawn } from "node:child_process";',
  "function dshSpawnSpec(binary, args, platform = process.platform) {",
  T + 'if (platform === "win32") {',
  T + T + 'if (binary.toLowerCase().endsWith(".cmd") || binary.toLowerCase().endsWith(".bat")) return {',
  T + T + T + 'command: "cmd.exe",',
  T + T + T + "args: windowsCmdShimArgs(binary, args),",
  T + T + T + "windowsVerbatimArguments: true",
  T + T + "};",
  "const child = spawnDsh(realDsh, options.argv, {",
  T + T + "stdio: [",
  T + T + T + '"inherit",',
  T + T + T + '"inherit",',
  T + T + T + '"pipe"',
  T + T + "],",
  "",
].join(N);

test("doctor：spawn / dshSpawnSpec / stdio 三处都能注入", () => {
  const sb = sandbox("doctor");
  const fp = put(path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-doctor", "lib", "cli.mjs"), DOC_BODY);
  core.silenceDoctorSpawnFlash(sb.home);
  const text = read(fp);
  assert.match(text, /\[dsh-purge\] doctor spawn windowsHide/);
  assert.match(text, /\[dsh-purge\] dsh\.cmd → node bin\.js \(no cmd\.exe\)/);
  assert.match(text, /\[dsh-purge\] doctor launch stdio no-inherit/);
  assert.match(text, /windowsHide: true,/);
  assert.match(text, /"ignore",/);
});

test("doctor：三处都已打好时不再改文件（already 分支）", () => {
  const sb = sandbox("doctor-already");
  const done = [
    'import { spawn as __dshPurgeSpawnOrig } from "node:child_process";',
    "// [dsh-purge] doctor spawn windowsHide",
    "// [dsh-purge] dsh.cmd → node bin.js (no cmd.exe)",
    "// [dsh-purge] doctor launch stdio no-inherit",
    "",
  ].join(N);
  const fp = put(path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-doctor", "lib", "cli.mjs"), done);
  const mtime = fs.statSync(fp).mtimeMs;
  assert.equal(core.silenceDoctorSpawnFlash(sb.home), "missing");
  assert.equal(read(fp), done);
  assert.equal(fs.statSync(fp).mtimeMs, mtime);
});

test("doctor：什么都不匹配时回 pattern_miss", () => {
  const sb = sandbox("doctor-miss");
  const fp = put(path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-doctor", "lib", "cli.mjs"), "const x = 1" + N);
  assert.equal(core.silenceDoctorSpawnFlash(sb.home), "pattern_miss");
  assert.equal(read(fp), "const x = 1" + N);
});

// ------------------------------------------------ silenceDshmarketRestartFlash（两处）

const MARKET_BODY = [
  "import { tmpdir } from 'node:os';",
  "import { join } from 'node:path';",
  "export function respawnInvocation(launch, platform = process.platform) {",
  "    if (platform !== 'win32') {",
  "        return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true };",
  "    }",
  "",
].join(N);

test("market：import 补 existsSync/dirname，respawn 改走 node bin.js", () => {
  const sb = sandbox("market");
  const fp = put(path.join(sb.home, "profiles", "web", "node_modules", "dshmarket", "lib", "restart.js"), MARKET_BODY);
  core.silenceDshmarketRestartFlash(sb.home);
  const text = read(fp);
  assert.match(text, /import \{ existsSync \} from 'node:fs';/);
  assert.match(text, /import \{ dirname, join \} from 'node:path';/);
  assert.match(text, /\[dsh-purge\] market restart → node bin\.js/);
  assert.match(text, /resolveBin/);
});

test("market：缺 importNeedle 时 import 段不改，但 respawn 段照样打", () => {
  const sb = sandbox("market-noimport");
  const body = MARKET_BODY.split(N).slice(2).join(N);
  const fp = put(path.join(sb.home, "profiles", "web", "node_modules", "dshmarket", "lib", "restart.js"), body);
  core.silenceDshmarketRestartFlash(sb.home);
  const text = read(fp);
  assert.equal(text.includes("import { existsSync }"), false);
  assert.match(text, /\[dsh-purge\] market restart → node bin\.js/);
});

test("market：respawnInvocation 形态对不上时回 pattern_miss", () => {
  const sb = sandbox("market-miss");
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "dshmarket", "lib", "restart.js"),
    "export function other() {" + N + "}" + N,
  );
  assert.equal(core.silenceDshmarketRestartFlash(sb.home), "pattern_miss");
});

// ------------------------------------------------------------------ silenceCmdFlash

test("silenceCmdFlash 的返回结构：hide 段摊平 + 九段分项 + ok 汇总", () => {
  const sb = sandbox("cmdflash");
  // 在真 win32 上这一步只写临时目录里的假文件，不会碰真宿主 / schtasks。
  const out = core.silenceCmdFlash(sb.ai);
  for (const key of [
    "doctor",
    "doctorSpawn",
    "market",
    "subprocess",
    "customBash",
    "phase1",
    "officialPhase1",
    "liangshenPrompt",
    "mnemon",
    "ok",
  ]) {
    assert.ok(key in out, `缺字段 ${key}`);
  }
  // hide 段是被展开的，所以顶层同时有 entry / preflight / entryRoot。
  assert.ok("entry" in out);
  assert.ok("preflight" in out);
  assert.equal(typeof out.ok, "boolean");
});

test("silenceCmdFlash 的 ok 只由 hide / liangshenPrompt / preflight 三段决定", () => {
  const sb = sandbox("cmdflash-ok");
  const out = core.silenceCmdFlash(sb.ai);
  const allowed = ["missing", "already", "patched", "pattern_miss"];
  assert.ok(allowed.includes(out.liangshenPrompt), `liangshenPrompt=${out.liangshenPrompt} 不在容忍清单里`);
  // 这个空 home 里没有 minimal-prompt，所以必然是 missing；ok 不因其它段报错而变。
  assert.equal(out.liangshenPrompt, "missing");
});

// ------------------------------------------------------------- 源码形状（不可行为化）

test("这簇函数一律先判平台再干活（平台闸门必须在函数体第一行）", () => {
  // lib/core.js 是 CRLF，先归一成 LF 再用行号定位（正则不能跨参数里的括号）。
  const lines = fs.readFileSync(new URL("../lib/core.js", import.meta.url), "utf8").replace(/\r\n/g, "\n").split("\n");
  const bodyStart = (name) => {
    const at = lines.findIndex((l) => l.startsWith(`export function ${name}(`));
    assert.ok(at >= 0, `找不到 ${name}`);
    for (let i = at; i < at + 6; i += 1) {
      if (lines[i].endsWith(") {")) return i + 1;
    }
    throw new Error(`${name} 的函数体起始行找不到`);
  };
  for (const name of [
    "silenceLiangshenCustomBashFlash",
    "silenceMnemonGitFlash",
    "silenceSubprocessLocalFlash",
    "silenceDoctorSpawnFlash",
    "silenceDshmarketRestartFlash",
  ]) {
    assert.equal(
      lines[bodyStart(name)],
      '  if (process.platform !== "win32") return "skipped_not_win32";',
      `${name} 的平台闸门不在函数体第一行`,
    );
  }
  // 反过来：三个「文件层面判定」的函数必须没有这道闸门，否则非 win32 上永远打不上。
  for (const name of ["silenceLiangshenPhase1Strip", "silenceOfficialPhase1Strip", "keepLiangshenOperatorPrompt"]) {
    assert.notEqual(
      lines[bodyStart(name)],
      '  if (process.platform !== "win32") return "skipped_not_win32";',
      `${name} 不该有平台闸门`,
    );
  }
});

test("worseLiangshenHit 的 rank 表就是「error < pattern_miss < missing < patched < already」", () => {
  // 必须逐个钉数值：只钉「判断顺序」的话，把 missing 与 patched 的返回值互换
  // （2↔3）文本顺序一点没变，行为却在「已打上补丁」这一路上彻底反过来。
  const lines = fs.readFileSync(new URL("../lib/core.js", import.meta.url), "utf8").replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => l === "function worseLiangshenHit(current, next) {");
  assert.ok(at > 0, "找不到 worseLiangshenHit");
  assert.deepEqual(lines.slice(at + 2, at + 9), [
    '    if (String(hit).startsWith("error:")) return 0;',
    '    if (hit === "pattern_miss") return 1;',
    '    if (hit === "missing") return 2;',
    '    if (hit === "patched") return 3;',
    '    if (hit === "already") return 4;',
    "    return 2;",
    "  };",
  ]);
  assert.equal(lines[at + 9], "  return rank(next) < rank(current) ? next : current;");
});

// ------------------------------------------- 补：能区分「两条实现」的用例（RED 演练逼出来的）
// 下面这批是 RED 演练发现「改坏了测试照样绿」之后补的。每一条都对应一个具体注入：
// 少了它，对应的那行源码随便改都测不出来。

test("phase1：别处残留的 keepAllMarker 行也会被清掉（不只有紧跟 unfiltered 的那种）", () => {
  // keepAllStacked / keepAll 两条分支只吃掉「marker 行 + unfiltered」连着的形态；
  // 单独一行 keepAllMarker（后面跟别的代码）靠的是 :842 那条清理正则。
  const sb = sandbox("p1-stray-keepall");
  const body =
    P1_SET +
    N +
    "function f(assembled) {" +
    N +
    P1_NEEDLE +
    N +
    "    const other = 1" +
    N +
    "    // " +
    P1_KEEP_ALL +
    N +
    "}" +
    N;
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "tool-bootstrap.mjs"),
    body,
  );
  core.silenceLiangshenPhase1Strip(sb.home);
  const text = read(fp);
  assert.equal(text.includes(P1_KEEP_ALL), false, "残留的 keepAllMarker 行必须被清掉");
  assert.match(text, /\[dsh-purge\] phase-1 keep persona\+inject sections/, "正常替换也要发生");
});

test("phase1 的 already 判据必须同时满足七个条件（源码形状）", () => {
  // 这七个条件只要少一个，行为上就只剩「其它条件仍挡着」，造不出能区分的 fixture：
  //   already 只有在 next 与原文完全一致时才参与判定，而原文一致就意味着别的条件也都成立。
  const lines = fs.readFileSync(new URL("../lib/core.js", import.meta.url), "utf8").replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => l === "    const already =");
  assert.ok(at > 0, "找不到 phase1 的 already 判据");
  const block = lines.slice(at, at + 8).join("\n");
  for (const frag of [
    "next.includes(marker)",
    "!next.includes(keepAllMarker)",
    'next.includes(\'startsWith("dsh-purge")\')',
    'next.includes(\'startsWith("dshpg-")\')',
    "!next.includes(unfiltered)",
    "!next.includes(contextMarker)",
    '!next.includes(\'plugin === "@deepseek-ai/dsh-system-prompt"\')',
  ]) {
    assert.ok(block.includes(frag), `already 判据缺一项：${frag}`);
  }
  assert.equal(lines[at + 2], "      !next.includes(keepAllMarker) &&", "第二个条件必须是「没有残留 keepAllMarker」");
  assert.equal(
    lines[at + 7],
    '      !next.includes(\'plugin === "@deepseek-ai/dsh-system-prompt"\');',
    "最后一个条件必须是「官方放行段已经被撤掉」",
  );
});

test("keepOperator：marker 与 dshpg- 同时在就算 already（不要求整条常量一字不差）", () => {
  // 聚合口径：already 的 rank(4) 打不过初值 missing(2) → 返回值是 missing；
  // 一旦第二判据丢了就变成 pattern_miss，两者能区分。
  const sb = sandbox("keep-partial");
  const body =
    'const x = String(n || "").startsWith("dshpg-")' + N + "// [dsh-purge] liangshen keep operator" + N;
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "minimal-prompt.mjs"),
    body,
  );
  assert.equal(core.keepLiangshenOperatorPrompt(sb.home), "missing", "判成 already（被 rank 吃掉）→ missing；判成 pattern_miss 说明第二判据丢了");
  assert.equal(read(fp), body, "already 分支不该改文件");
});

test("keepOperator：只有 marker 没有 dshpg- 时不算 already（回 pattern_miss）", () => {
  // 这条是唯一能把「already 只认 marker」与「marker + dshpg- 双判据」分开的形态：
  //   marker 在、dshpg- 不在 → 完整实现判 pattern_miss（rank 1，压过初值 missing 的 2）；
  //   只认 marker 的实现会判 already（rank 4，压不过 2）→ 返回 missing。
  const sb = sandbox("keep-marker-only");
  const body = "// [dsh-purge] liangshen keep operator" + N + "const q = 1;" + N;
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "minimal-prompt.mjs"),
    body,
  );
  assert.equal(core.keepLiangshenOperatorPrompt(sb.home), "pattern_miss", "只有 marker 不算 already");
  assert.equal(read(fp), body, "pattern_miss 分支不该改文件");
});

test("keepOperator：CRLF 文件写回后仍然保持 CRLF", () => {
  // 注意这里必须是真 CRLF（"\r\n" 两字符），写 "\\r\\n" 只会往文件里塞反斜杠 ——
  // 那样 text.includes("\r\n") 恒假，写回分支永远走 LF 那一侧，测不出任何东西。
  const sb = sandbox("keep-crlf");
  const crlf = KEEP_BARE + "\r\n";
  const fp = put(
    path.join(sb.home, "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "minimal-prompt.mjs"),
    crlf,
  );
  assert.equal(core.keepLiangshenOperatorPrompt(sb.home), "missing");
  const text = read(fp);
  assert.equal(text, KEEP_OPERATOR + "\r\n", "写回时按原文行尾写");
  assert.equal(text.includes("\r\n"), true, "不许把 CRLF 文件改成 LF");
  assert.equal(text.includes("\n\n"), false, "不许出现 CRLF 与 LF 混排");
});

test("market 的 import 段必须同时看「缺 existsSync」与「有 importNeedle」两个条件（源码形状）", () => {
  // 少了后半段，String.replace 找不到 needle 本来就是无操作 —— 行为完全一样，只能钉形状。
  const lines = fs.readFileSync(new URL("../lib/core.js", import.meta.url), "utf8").replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => l === '    if (!next.includes("existsSync") && next.includes(importNeedle)) {');
  assert.ok(at > 0, "market 的 import 段双条件不见了");
});

test("silenceCmdFlash 的 ok 由三段合成，liangshenOk 只容忍四个值（源码形状）", () => {
  // 空 home 里 liangshenPrompt 恒为 missing、preflight 恒为 missing_bin，两个都在容忍清单里，
  // 所以把 liangshenOk 改成恒真、把 ok 里的 preflightOk 删掉，行为用例都不会红。
  const lines = fs.readFileSync(new URL("../lib/core.js", import.meta.url), "utf8").replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => l === "  const liangshenOk =");
  assert.ok(at > 0, "找不到 liangshenOk");
  assert.deepEqual(lines.slice(at, at + 5), [
    "  const liangshenOk =",
    '    liangshenPrompt === "missing" ||',
    '    liangshenPrompt === "already" ||',
    '    liangshenPrompt === "patched" ||',
    '    liangshenPrompt === "pattern_miss";',
  ]);
  const okAt = lines.findIndex((l) => l === "    ok: hideOk && liangshenOk && preflightOk,");
  assert.ok(okAt > 0, "ok 必须同时看 hide / liangshen / preflight 三段");
});
