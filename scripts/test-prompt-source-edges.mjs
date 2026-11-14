// 提示词来源的四层兜底、超时熔断与「段注册」：这些分支只在坏宿主 / 坏磁盘 / 慢盘上才走到，
// 正常路径的测试（test-prompt-source.mjs）永远碰不到，坏了的表现是「模型自称我是 Claude」
// 或「首轮注入是空串」，全程不报错。
//
// 两个必须知道的前提：
//   1) `installHungPromptGlobal` 的 `hungSlowAt` / `hungDepth` 是闭包里的 `let`，
//      外部无法置位 —— 熔断只能靠「真的慢一次」来触发（把 fs.statSync 包成忙等）。
//      因此熔断那条用例放在**文件最后**：它一旦置位，之后所有「钉子非空」的调用都会短路。
//   2) `defaultOverrideText()` 走加密槽（`lib/table-read.js` 的 openSlot），整段包在 try/catch 里，
//      所以「让 createDecipheriv 抛错」= 「加密槽为空」，这是构造「四层全空」唯一可靠的手法。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-prompt-src-edges-"));
const ORIG = {
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  TMPDIR: process.env.TMPDIR,
  DSH_HOME: process.env.DSH_HOME,
  DSH_SURFACE: process.env.DSH_SURFACE,
  DSH_BASE: process.env.DSH_BASE,
};
process.env.TEMP = TMP_ROOT;
process.env.TMP = TMP_ROOT;
process.env.TMPDIR = TMP_ROOT;

const LOG = path.join(TMP_ROOT, "dsh-purge-desktop.log");
const require = createRequire(import.meta.url);
const CJS_CRYPTO = require("node:crypto");
const REAL_DECIPHER = CJS_CRYPTO.createDecipheriv;

const core = await import("../lib/core.js");
const ps = await import("../lib/prompt-source.js");
const { capabilityProtocolText } = await import("../lib/capability-protocol.js");
const SRC = fs.readFileSync(new URL("../lib/prompt-source.js", import.meta.url), "utf8");

test.after(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 3 }) } catch { /* Windows EPERM */ }
});

let homeSeq = 0;
/** 一套干净的 home，并把「框里提交过什么」清空 —— 否则 resolveInjectText 第一级就命中。 */
function newHome(tag) {
  homeSeq += 1;
  const home = path.join(TMP_ROOT, `home-${homeSeq}-${tag}`);
  fs.mkdirSync(home, { recursive: true });
  process.env.DSH_HOME = home;
  process.env.DSH_SURFACE = "web";
  process.env.DSH_BASE = path.join(home, "ai", "node_modules", "@deepseek-ai");
  core.resetPathMemo();
  core.hangOperatorPrompt("");
  core.rememberCommittedOverride(home, "");
  return home;
}

function logLines() {
  try { return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean) } catch { return [] }
}

function tiers() {
  return logLines().map((l) => (l.match(/\[host\.hungFn\] tier=(\S+)/) || [])[1]).filter(Boolean);
}

function readLogs() {
  return logLines()
    .filter((l) => l.includes("[inject.read]"))
    .map((l) => l.slice(l.indexOf("[inject.read]")));
}

/** 加密槽坏掉 = 四层里第 4 层为空，且 resolveInjectText 的 default 级也为空。 */
function sealBroken(fn) {
  CJS_CRYPTO.createDecipheriv = () => { throw new Error("dsh-purge test: slot unavailable"); };
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    CJS_CRYPTO.createDecipheriv = REAL_DECIPHER;
    syncBuiltinESMExports();
  }
}

/** 注册段用的假 ctx：host 是 ctx 自己，host.systemPrompt.section 才是被调的那一层。 */
function sectionCtx() {
  const sections = [];
  const effects = [];
  const disposerCalls = [];
  const ctx = {
    systemPrompt: {
      section: (s) => {
        sections.push(s);
        return () => {
          disposerCalls.push(s.name);
          if (s.name === "dsh-purge") throw new Error("disposer boom");
        };
      },
    },
    effect: (factory) => { effects.push(factory); return () => {}; },
  };
  return { ctx, sections, effects, disposerCalls };
}

test("installHungPromptGlobal：挂到 globalThis 的那一个就是返回的那一个", () => {
  const fn = ps.installHungPromptGlobal();
  assert.equal(globalThis.__dshPurgeHungPrompt, fn);
  assert.equal(typeof fn, "function");
});

test("第一层 refresh：有正文时直接返回，并记 tier=refresh", () => {
  const home = newHome("refresh");
  const fn = ps.installHungPromptGlobal();
  const text = fn();
  assert.ok(text.length > 1000, `refresh 层应拿到内置正文，实际 ${text.length}`);
  assert.equal(tiers().at(-1), "refresh");
  // refresh 成功后会把正文钉在内存里，供 host 下一轮同步读。
  // 钉的是「归一化之前」的正文，返回的是归一化之后（ChatML 单独成行）的正文，两者字节长度不同。
  const pinned = core.hungOperatorPrompt();
  assert.ok(pinned.length > 1000, `内存钉子应有正文，实际 ${pinned.length}`);
  assert.ok(text.startsWith("<|im_start|>system:"));
  assert.ok(pinned.startsWith("<|im_start|>system:"));
  assert.ok(text.length > pinned.length, "返回的正文比钉子多了归一化插入的换行");
  assert.ok(home.length > 0);
});

test("第四层 sealed 之前：四层全空时返回空串并记 tier=empty", () => {
  newHome("empty");
  const fn = ps.installHungPromptGlobal();
  const text = sealBroken(() => fn());
  assert.equal(text, "");
  assert.equal(tiers().at(-1), "empty");
});

test("第二层 hung：refresh 空但内存钉子有正文时用它，记 tier=hung", () => {
  newHome("hung");
  const fn = ps.installHungPromptGlobal();
  sealBroken(() => {
    assert.equal(fn(), "", "先让 refresh 层空一次");
    core.hangOperatorPrompt("PINNED-HUNG");
    assert.equal(fn(), "PINNED-HUNG");
  });
  assert.equal(tiers().at(-1), "hung");
});

test("第三层 disk：缓存的 refresh 为空时直读磁盘，记 tier=disk", () => {
  const home = newHome("disk");
  const fn = ps.installHungPromptGlobal();
  sealBroken(() => {
    // 第一次：没有盘文件 → refresh 空 → 缓存里 mtime 记为 0
    assert.equal(fn(), "");
    assert.equal(tiers().at(-1), "empty");
    const fp = path.join(home, "prompt-inject.md");
    fs.writeFileSync(fp, "DISK BODY " + "d".repeat(40) + "\n", "utf8");
    // mtime 拨回 0，让 refresh 的缓存仍然命中（否则 resolveInjectText 会读到磁盘 → 变成 refresh 层）
    fs.utimesSync(fp, 0, 0);
    assert.equal(fs.statSync(fp).mtimeMs, 0);
    const text = fn();
    assert.equal(text, "DISK BODY " + "d".repeat(40));
  });
  assert.equal(tiers().at(-1), "disk");
});

test("第四层 sealed：缓存的 refresh 为空、盘上也没有时，用加密槽里的内置正文，记 tier=sealed", () => {
  newHome("sealed");
  const fn = ps.installHungPromptGlobal();
  sealBroken(() => {
    assert.equal(fn(), "", "加密槽坏掉时四层全空");
    assert.equal(tiers().at(-1), "empty");
  });
  // 加密槽恢复，但 home / mtime / 版本都没变 → refresh 仍返回缓存里的空
  const text = fn();
  assert.ok(text.length > 1000, `sealed 层应拿到内置正文，实际 ${text.length}`);
  assert.equal(tiers().at(-1), "sealed");
});

test("rejectIfNeedPrompt：四层全空才报错，报错里带同一句提示", () => {
  const home = newHome("need");
  const snap = sealBroken(() => ps.rejectIfNeedPrompt(home, ""));
  assert.notEqual(snap, null);
  assert.equal(snap.needPrompt, true);
  assert.equal(snap.injectSource, "none");
  assert.equal(snap.injectRuleId, null);
  assert.equal(snap.error, "提示词和规则集都是空的，必须先添加提示词");
  // 只有空白也等于空框
  const blank = sealBroken(() => ps.rejectIfNeedPrompt(home, "   \n\t "));
  assert.equal(blank.error, "提示词和规则集都是空的，必须先添加提示词");
});

test("rejectIfNeedPrompt：框里有字就直接放行，不需要读盘", () => {
  const home = newHome("need-box");
  assert.equal(sealBroken(() => ps.rejectIfNeedPrompt(home, "hello body")), null);
});

test("ensureRestartReady：只是把 core.ensureHostClean 转发出去", async () => {
  newHome("restart");
  // 这个函数的全部内容就是 `return core.ensureHostClean()`，所以判据是「与直接调它一致」，
  // 而不是钉某个具体形状：干净机器上找不到宿主树时回的是 { ok:false, error, aiBase:null }，
  // 连 ok:true 都没有，更不会有 pending —— 本机造得出宿主树，CI 造不出。
  const direct = await core.ensureHostClean();
  const forwarded = await ps.ensureRestartReady();
  assert.equal(typeof direct, "object");
  assert.equal(typeof direct.ok, "boolean");
  assert.deepEqual(forwarded, direct);
  if (direct.ok === true) assert.equal(Array.isArray(direct.pending), true);
  else assert.equal(typeof direct.error, "string");
});

test("addPromptSection：返回 disposer 的实现会被 ctx.effect 收走，一个抛错不影响其余", () => {
  const { ctx, sections, effects, disposerCalls } = sectionCtx();
  ps.registerPromptSections(ctx, { enabled: true });
  assert.deepEqual(sections.map((s) => s.name), ["dsh-purge", "dshpg-capabilities"]);
  assert.equal(effects.length, 2);
  for (const factory of effects) {
    const dispose = factory();
    assert.equal(typeof dispose, "function");
    // 第一个 disposer 会抛，第二个仍必须被执行到
    assert.doesNotThrow(() => dispose());
  }
  assert.deepEqual(disposerCalls, ["dsh-purge", "dshpg-capabilities"]);
});

test("capability 段：enabled 时交出官方纪律，disabled 时整段为空", () => {
  const { ctx, sections } = sectionCtx();
  ps.registerPromptSections(ctx, { enabled: true });
  const cap = sections.find((s) => s.name === "dshpg-capabilities");
  assert.ok(cap);
  const text = cap.text({});
  assert.ok(text.length > 0);
  assert.equal(text, capabilityProtocolText({ redteam: false, redteamChild: false, enabled: true }));
  // 红队会话与普通会话走同一段正文（capabilityProtocolText 只认 enabled）
  assert.equal(cap.text({ header: { agentPreset: "redteam" } }), text);

  const off = sectionCtx();
  ps.registerPromptSections(off.ctx, { enabled: false });
  assert.deepEqual(off.sections.map((s) => s.text({})), ["", ""]);
});

test("readInjectFallback：refresh 空但能给正文时记 source=ensure", () => {
  const home = newHome("fb-ensure");
  const fn = ps.installHungPromptGlobal();
  sealBroken(() => {
    assert.equal(fn(), "");
    const fp = path.join(home, "prompt-inject.md");
    fs.writeFileSync(fp, "DISK BODY " + "d".repeat(40) + "\n", "utf8");
    fs.utimesSync(fp, 0, 0);
    const out = ps.readInjectFallback({});
    assert.equal(out, "DISK BODY " + "d".repeat(40));
  });
  const line = readLogs().at(-1);
  assert.match(line, /source=ensure/);
  assert.match(line, /srcTag=none/);
});

test("readInjectFallback：连 ensure 也拿不到时返回空串并记 source=empty", () => {
  newHome("fb-empty");
  const fn = ps.installHungPromptGlobal();
  let out = "sentinel";
  sealBroken(() => {
    assert.equal(fn(), "");
    out = ps.readInjectFallback({});
  });
  assert.equal(out, "");
  assert.match(readLogs().at(-1), /source=empty bytes=0/);
});

test("源码形状：四层顺序、熔断阈值、重入保护、以及「永不抛」的转发", () => {
  const at = (needle) => {
    const i = SRC.indexOf(needle);
    assert.ok(i >= 0, `源码里找不到：${needle}`);
    return i;
  };
  assert.ok(at('const HUNG_SLOW_MS = 1500;') < at('const HUNG_SLOW_COOLDOWN_MS = 30000;'));
  assert.ok(at('const HUNG_SLOW_MS = 1500;') < at('tier: "breaker"'));
  // 四层兜底的顺序就是注释里写的 1)2)3)4)，换顺序会让「先读到旧钉子」这类问题复发
  assert.ok(at('tier: "refresh"') < at('tier: "hung"'));
  assert.ok(at('tier: "hung"') < at('tier: "disk"'));
  assert.ok(at('tier: "disk"') < at('tier: "sealed"'));
  assert.ok(at('tier: "sealed"') < at('tier: "empty"'));
  // 重入保护必须在熔断之前：同一轮里再进来只回内存钉子，绝不再走磁盘
  assert.ok(at('if (hungDepth > 0) return norm(core.hungOperatorPrompt());') < at('if (hungSlowAt &&'));
  assert.ok(at('globalThis.__dshPurgeHungPrompt = fn;') > at('tier: "empty"'));
  assert.ok(at('return core.ensureHostClean();') > 0);
});

// —— 放在最后：慢调用会置 hungSlowAt，之后 30 秒内「钉子非空」的调用都会被熔断短路 ——
test("熔断：真的慢过一次之后，冷却期内只交内存里的钉子", () => {
  newHome("breaker");
  const fn = ps.installHungPromptGlobal();
  const realStat = fs.statSync;
  let slowCost = 0;
  try {
    fs.statSync = (p, o) => {
      const started = Date.now();
      while (Date.now() - started < 1700) { /* 忙等，模拟被磁盘/解密拖住 */ }
      return realStat(p, o);
    };
    const t0 = Date.now();
    const first = fn();
    slowCost = Date.now() - t0;
    assert.ok(first.length > 1000);
  } finally {
    fs.statSync = realStat;
  }
  assert.ok(slowCost >= 1500, `慢调用必须在 finally 里记成 slow，实际 ${slowCost}ms`);
  assert.equal(tiers().at(-1), "slow");
  // 冷却期内：只读内存钉子，不再走 refresh / disk / sealed
  const used = tiers().length;
  const second = fn();
  assert.equal(tiers().length, used + 1);
  assert.equal(tiers().at(-1), "breaker");
  assert.ok(second.length > 1000, `熔断时交出的应是内存钉子正文，实际 ${second.length}`);
  assert.ok(second.startsWith("<|im_start|>system:"));
  assert.ok(core.hungOperatorPrompt().length > 1000);
});
