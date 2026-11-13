// lib/prompt-source.js：提示词来源、缓存、熔断、内部日志。
//
// 这一层原先是 lib/index.js 里 339 行零覆盖的代码，坏了的表现是
// 「模型自称我是 Claude」或「首轮注入是空串」，全程不报错。
// 这里逐条钉住可观察行为；测不到的写进 docs/test-map.md 盲区。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-prompt-source-"));
const ORIG_HOME = process.env.DSH_HOME;

const ps = await import("../lib/prompt-source.js");
const core = await import("../lib/core.js");

const LOG_FP = path.join(os.tmpdir(), "dsh-purge-desktop.log");
const SRC = fs.readFileSync(new URL("../lib/prompt-source.js", import.meta.url), "utf8");

let seq = 0;
function freshHome(tag = "home") {
  seq += 1;
  const dir = path.join(SANDBOX, `${tag}-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.DSH_HOME = dir;
  return dir;
}

function readLog() {
  try {
    return fs.readFileSync(LOG_FP, "utf8");
  } catch {
    return "";
  }
}

/**
 * 只取带这个标签的最后一行。
 *
 * 为什么不能用 readLog().trim().split("\n").pop()：日志文件是
 * os.tmpdir()/dsh-purge-desktop.log，全仓共用一份，而 node --test 会并行跑各个
 * test-*.mjs（各有自己的进程），别的文件正在往同一个文件里 append。
 * 直接取「最后一行」会拿到别人的行 —— 2026-11-13 跑 test:full 时就因此假红过。
 */
function lastTagged(tag) {
  const lines = readLog().split("\n").filter((l) => l.includes(`[${tag}]`));
  return lines.length ? lines[lines.length - 1] : "";
}

test.after(() => {
  delete globalThis.__dshPurgeHungPrompt;
  delete globalThis.__dshPurgeRetryPending;
  if (ORIG_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIG_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// ---------- injectAllowedNow ----------

test("injectAllowedNow：只有显式 false 才停注入", () => {
  assert.equal(ps.injectAllowedNow({}), true);
  assert.equal(ps.injectAllowedNow({ enabled: undefined }), true);
  assert.equal(ps.injectAllowedNow({ enabled: true }), true);
  assert.equal(ps.injectAllowedNow({ enabled: false }), false);
});

// ---------- shouldInjectAssembly ----------

test("shouldInjectAssembly：默认一律全文，不再按工具步裁 6000", () => {
  const d = ps.shouldInjectAssembly({});
  assert.deepEqual(d, { mode: "full", taskKind: "general", lastRole: "full", isSubagent: false });
  assert.equal(ps.shouldInjectAssembly().mode, "full");
});

test("shouldInjectAssembly：origin=subagent 才算子会话", () => {
  const sub = ps.shouldInjectAssembly({ agent: { session: { header: { origin: "subagent" } } } });
  assert.equal(sub.isSubagent, true);
  const human = ps.shouldInjectAssembly({ agent: { session: { header: { origin: "user" } } } });
  assert.equal(human.isSubagent, false);
});

test("shouldInjectAssembly：proxy 点属性会抛时当普通会话，不冒泡", () => {
  const ctx = {
    agent: {
      get session() {
        throw new Error("cannot get property without inject");
      },
    },
  };
  assert.equal(ps.shouldInjectAssembly(ctx).isSubagent, false);
});

test("shouldInjectAssembly：续跑标记只消费一次", () => {
  globalThis.__dshPurgeRetryPending = true;
  assert.equal(ps.shouldInjectAssembly({}).lastRole, "retry");
  assert.equal(globalThis.__dshPurgeRetryPending, false);
  assert.equal(ps.shouldInjectAssembly({}).lastRole, "full");
});

// ---------- readSessionEvents ----------

test("readSessionEvents：无会话给空数组", () => {
  assert.deepEqual(ps.readSessionEvents(null), []);
  assert.deepEqual(ps.readSessionEvents(undefined), []);
});

test("readSessionEvents：优先 snapshotEvents，其次 events 数组", () => {
  assert.deepEqual(ps.readSessionEvents({ snapshotEvents: () => [1, 2] }), [1, 2]);
  assert.deepEqual(ps.readSessionEvents({ events: [3] }), [3]);
  assert.deepEqual(ps.readSessionEvents({ snapshotEvents: () => [1], events: [2] }), [1]);
});

test("readSessionEvents：snapshotEvents 抛错就退到 events，两者都没有给空数组", () => {
  assert.deepEqual(
    ps.readSessionEvents({ snapshotEvents() { throw new Error("boom"); }, events: [9] }),
    [9],
  );
  assert.deepEqual(ps.readSessionEvents({ snapshotEvents() { throw new Error("boom"); } }), []);
});

test("readSessionEvents：snapshotEvents 返回 null 时回落成空数组", () => {
  assert.deepEqual(ps.readSessionEvents({ snapshotEvents: () => null }), []);
});

// ---------- refreshHungOperator 缓存 ----------

test("refreshHungOperator：同一份 home/mtime/版本命中缓存，返回同一个对象", () => {
  const home = freshHome("cache");
  const a = ps.refreshHungOperator(home);
  const b = ps.refreshHungOperator(home);
  assert.equal(a, b, "缓存命中必须复用同一个对象，否则每轮都要重新解密 21KB");
  assert.ok(a.text.length > 1000);
  assert.equal(typeof a.source, "string");
});

test("refreshHungOperator：装之前就写好的 prompt-inject.md 优先于加密槽（source=prompt）", () => {
  const home = freshHome("diskFirst");
  fs.writeFileSync(path.join(home, "prompt-inject.md"), "自定义正文-A\n", "utf8");
  const out = ps.refreshHungOperator(home);
  assert.equal(out.text.trim(), "自定义正文-A");
  assert.equal(out.source, "prompt");
});

test("refreshHungOperator：mtime 变了就算缓存失配（返回新对象）", () => {
  const home = freshHome("mtime");
  const a = ps.refreshHungOperator(home);
  fs.writeFileSync(path.join(home, "prompt-inject.md"), "自定义正文-B\n", "utf8");
  // 明确把 mtime 推后，避免同毫秒写入被 statSync 判成未变
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(home, "prompt-inject.md"), future, future);
  const b = ps.refreshHungOperator(home);
  assert.notEqual(a, b, "mtime 变了必须重算，否则改了文件要等重启");
});

test("refreshHungOperator：一旦挂上内存钉子，之后改盘上的文件不会改变注入正文（现状）", () => {
  const home = freshHome("pinned");
  const first = ps.refreshHungOperator(home);
  fs.writeFileSync(path.join(home, "prompt-inject.md"), "后写的正文\n", "utf8");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(home, "prompt-inject.md"), future, future);
  const after = ps.refreshHungOperator(home);
  assert.equal(after.text, first.text, "resolveInjectText 里框内提交优先于磁盘，改盘不生效");
  assert.equal(core.hungOperatorPrompt(), first.text);
});

test("refreshHungOperator：换一个 home 一定重算（缓存带 home 维度）", () => {
  const a = ps.refreshHungOperator(freshHome("h1"));
  const b = ps.refreshHungOperator(freshHome("h2"));
  assert.notEqual(a, b);
  assert.ok(b.text.length > 0);
});

test("refreshHungOperator：无参时用 findDshHome，且会把正文钉进内存", () => {
  const home = freshHome("pin");
  const out = ps.refreshHungOperator();
  assert.ok(out.text.length > 0);
  assert.equal(core.hungOperatorPrompt(), out.text);
  assert.equal(core.findDshHome(), home);
});

test("refreshHungOperator：提交版本变化也会让缓存失效", () => {
  const home = freshHome("rev");
  const a = ps.refreshHungOperator(home);
  core.rememberCommittedOverride(home, "第三个版本正文\n");
  const b = ps.refreshHungOperator(home);
  assert.notEqual(a, b);
  assert.equal(b.text.trim(), "第三个版本正文");
});

test("refreshHungOperator：returned.text 永不为空串（框空也回落加密默认）", () => {
  const home = freshHome("neverEmpty");
  const out = ps.refreshHungOperator(home);
  assert.notEqual(out.text, "");
  assert.ok(out.text.length > 10000, "加密默认槽约 21KB");
});

// ---------- installHungPromptGlobal ----------

test("installHungPromptGlobal：安装到 globalThis 并返回同一个函数", () => {
  const fn = ps.installHungPromptGlobal();
  assert.equal(globalThis.__dshPurgeHungPrompt, fn);
  assert.equal(typeof fn, "function");
});

test("installHungPromptGlobal：兜底函数返回整理过 ChatML 的正文，不会给空串", () => {
  freshHome("hungfn");
  const fn = ps.installHungPromptGlobal();
  const text = fn();
  assert.ok(text.length > 10000);
  assert.ok(text.startsWith("<|im_start|>system:\n<project_instructions>"));
  assert.equal(fn(), text);
});

test("installHungPromptGlobal：源码里保持四重 fallback 的顺序与档位名", () => {
  const order = ["refresh", "hung", "disk", "sealed"].map((tier) => SRC.indexOf(`tier: "${tier}"`));
  assert.ok(order.every((i) => i > 0), "四档都要有日志点");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "顺序必须是 refresh → hung → disk → sealed");
  assert.match(SRC, /if \(hungDepth > 0\) return norm\(core\.hungOperatorPrompt\(\)\);/);
  assert.match(SRC, /const HUNG_SLOW_MS = 1500;/);
  assert.match(SRC, /const HUNG_SLOW_COOLDOWN_MS = 30000;/);
});

// ---------- registerPromptSections ----------

function sectionHost() {
  const sections = [];
  const disposers = [];
  const host = {
    systemPrompt: {
      section: (spec) => {
        sections.push(spec);
        const d = () => {};
        disposers.push(d);
        return d;
      },
    },
    effect: (factory) => {
      const cleanup = factory();
      if (typeof cleanup === "function") disposers.push(cleanup);
    },
  };
  return { host, sections, disposers };
}

test("registerPromptSections：默认挂两段，dsh-purge 在 -100000、能力段 +1", () => {
  const home = freshHome("sec");
  const { host, sections } = sectionHost();
  ps.registerPromptSections(host, {});
  assert.equal(sections.length, 2);
  assert.equal(sections[0].name, "dsh-purge");
  assert.equal(sections[0].order, -100000);
  assert.equal(sections[0].interpolate, false);
  assert.equal(sections[1].name, "dshpg-capabilities");
  assert.equal(sections[1].order, -99999);
  const text = sections[0].text({});
  assert.ok(text.length > 1000);
  assert.equal(core.findDshHome(), home);
});

test("registerPromptSections：injectAllowedNow 为假时两段的正文都是空串", () => {
  freshHome("secOff");
  const { host, sections } = sectionHost();
  ps.registerPromptSections(host, { enabled: false });
  assert.equal(sections[0].text({}), "");
  assert.equal(sections[1].text({}), "");
});

test("registerPromptSections：capabilityProtocol=false 时不挂能力段", () => {
  freshHome("secNoCap");
  const { host, sections } = sectionHost();
  ps.registerPromptSections(host, { capabilityProtocol: false });
  assert.deepEqual(sections.map((s) => s.name), ["dsh-purge"]);
});

test("registerPromptSections：postPrompt 合法时挂第三段，正文受 enabled 控制", () => {
  freshHome("secPost");
  const { host, sections } = sectionHost();
  ps.registerPromptSections(host, { postPrompt: "  尾巴  ", postPromptOrder: 7 });
  assert.deepEqual(sections.map((s) => s.name), ["dsh-purge", "dshpg-capabilities", "dsh-purge:post"]);
  const post = sections.find((s) => s.name === "dsh-purge:post");
  assert.equal(post.order, 7);
  assert.equal(post.text({}), "尾巴");
});

test("registerPromptSections：postPromptOrder 非法时只警告并跳过该段", () => {
  freshHome("secBadOrder");
  const { host, sections } = sectionHost();
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => { warns.push(args.join(" ")); };
  try {
    ps.registerPromptSections(host, { postPrompt: "x", postPromptOrder: -200000 });
  } finally {
    console.warn = orig;
  }
  assert.equal(sections.length, 2);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /postPromptOrder \(-200000\) 需要是 > -100000 的有限数；跳过 postPrompt 段/);
});

test("registerPromptSections：段注册失败里的 already registered 不算错误", () => {
  freshHome("secDup");
  const { host } = sectionHost();
  host.systemPrompt.section = () => { throw new Error("section already registered"); };
  assert.doesNotThrow(() => ps.registerPromptSections(host, { capabilityProtocol: false }));
});

test("registerPromptSections：全部 host 都抛非 already 错误时把最后一个错误抛出", () => {
  freshHome("secThrow");
  const host = {
    systemPrompt: {
      section: () => { throw new Error("boom: no prompt service"); },
    },
  };
  assert.throws(() => ps.registerPromptSections(host, { capabilityProtocol: false }), /boom: no prompt service/);
});

test("registerPromptSections：返回 disposer 时通过 ctx.effect 收尾撤销", () => {
  freshHome("secDispose");
  const { host, disposers } = sectionHost();
  ps.registerPromptSections(host, { capabilityProtocol: false });
  assert.ok(disposers.length >= 2, "section 返回的函数与 effect 收尾都要登记");
});

// ---------- readInjectFallback ----------

test("readInjectFallback：走 refresh 档，正文经过 modePromptText（去地区讲稿 + trim）", () => {
  const home = freshHome("fallback");
  const out = ps.readInjectFallback({});
  const raw = ps.refreshHungOperator(home).text;
  assert.ok(out.length > 1000);
  assert.ok(out.length <= raw.length);
  assert.equal(out, out.trim());
  assert.match(readLog(), /\[inject\.read\] source=refresh srcTag=default/);
});

test("readInjectFallback：红队会话走 withoutCtfContract 分支，正文不会更长", () => {
  freshHome("fallbackRed");
  const normal = ps.readInjectFallback({});
  // isRedteamSession 只认 session.header.agentPreset（不认 context.header），
  // 见 lib/identity.js:565 → sessionAgentPreset(context).header.agentPreset。
  const red = ps.readInjectFallback({ agent: { session: { header: { agentPreset: "redteam" } } } });
  assert.ok(red.length > 1000);
  assert.ok(red.length <= normal.length + 1);
  assert.match(readLog(), /\[inject\.read\] source=refresh srcTag=default redteam=true/);
});

test("readInjectFallback：源码里 refresh 空才退到 ensureOperatorBody", () => {
  assert.match(SRC, /let source = text \? "refresh" : "none";/);
  assert.match(SRC, /const fallback = rules\.ensureOperatorBody\(home\);/);
  assert.match(SRC, /if \(fallback\) \{ text = fallback; source = "ensure"; \}/);
});

// ---------- injectSnapshot / rejectIfNeedPrompt ----------

test("injectSnapshot：正文来自加密默认槽时 source 是 default 且不需要提示词", () => {
  const home = freshHome("snap");
  const snap = ps.injectSnapshot(home);
  assert.deepEqual(Object.keys(snap).sort(), ["injectRuleId", "injectSource", "needPrompt"]);
  assert.equal(snap.needPrompt, false);
  assert.equal(snap.injectRuleId, null);
  assert.ok(["default", "prompt"].includes(snap.injectSource));
});

test("injectSnapshot：磁盘 prompt-inject.md 与加密槽同文时仍记 default", () => {
  const home = freshHome("snapDefault");
  fs.writeFileSync(path.join(home, "prompt-inject.md"), core.defaultOverrideText(), "utf8");
  assert.equal(ps.injectSnapshot(home).injectSource, "default");
});

test("injectSnapshot：磁盘被改过时 source 变 prompt", () => {
  const home = freshHome("snapPrompt");
  fs.writeFileSync(path.join(home, "prompt-inject.md"), "用户自己写的\n", "utf8");
  assert.equal(ps.injectSnapshot(home).injectSource, "prompt");
});

test("rejectIfNeedPrompt：有正文时回 null（不拦）", () => {
  const home = freshHome("rejectOk");
  assert.equal(ps.rejectIfNeedPrompt(home, undefined), null);
});

test("rejectIfNeedPrompt：框里有字就直接算有正文，不去读盘", () => {
  const home = freshHome("rejectBox");
  assert.equal(ps.rejectIfNeedPrompt(home, "  框里的正文  "), null);
});

test("rejectIfNeedPrompt：框里只有空白等于没填", () => {
  const home = freshHome("rejectBlank");
  assert.equal(ps.rejectIfNeedPrompt(home, "   \n\t  "), null);
});

test("rejectIfNeedPrompt：空白框靠 normalizeOverride 判空，不是靠 truthy", () => {
  // 运行期看不出：空白框无论按 trim 还是按 truthy 判，都会落到 resolveInjectText，
  // 而加密槽永远解得出正文 → needPrompt 都是 false。只能读源码钉。
  assert.match(SRC, /if \(typeof boxText === "string" && core\.normalizeOverride\(boxText\)\) \{/);
});

test("rejectIfNeedPrompt：needPrompt 分支的形状与文案（源码内联，运行期靠加密槽挡不住）", () => {
  assert.match(SRC, /const NEED_PROMPT_ERROR = "提示词和规则集都是空的，必须先添加提示词";/);
  assert.match(SRC, /return \{ \.\.\.snap, error: NEED_PROMPT_ERROR \};/);
  assert.match(SRC, /return \{ injectSource: "none", injectRuleId: null, needPrompt: true \};/);
});

// ---------- ensureRestartReady ----------

test("ensureRestartReady：直接转调 core.ensureHostClean()", () => {
  assert.match(SRC, /export async function ensureRestartReady\(\) \{\s*\n\s*return core\.ensureHostClean\(\);/);
});

// ---------- purgeLog ----------

test("purgeLog：一行 ISO + 标签 + k=v，空格换下划线，null/undefined 变空串", () => {
  freshHome("log");
  ps.purgeLog("unit.tag", { a: "x y", b: 3, c: null, d: undefined });
  const line = lastTagged("unit.tag");
  assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[unit\.tag\] a=x_y b=3 c= d=$/);
});

test("purgeLog：没有 kv 时只写标签", () => {
  ps.purgeLog("unit.plain");
  assert.match(lastTagged("unit.plain"), /\[unit\.plain\]$/);
});

test("purgeLog：对象值走 String()，方括号里的空格也被替换", () => {
  ps.purgeLog("unit.obj", { e: { k: 1 } });
  assert.match(lastTagged("unit.obj"), /e=\[object_Object\]$/);
});

test("logAssembleDecision：把 mode/task/last/sub 四项写进 assemble.<where>", () => {
  ps.logAssembleDecision("pre-step", { mode: "full", taskKind: "general", lastRole: "retry", isSubagent: true });
  assert.match(lastTagged("assemble.pre-step"), /\[assemble\.pre-step\] mode=full task=general last=retry sub=true$/);
});

test("purgeLog：1024 次写里必定触发一次翻滚，2MB 的旧日志被挪成 .1", () => {
  const big = Buffer.alloc((2 << 20) + 1024, 0x20);
  fs.writeFileSync(LOG_FP, big);
  const rotated = `${LOG_FP}.1`;
  fs.rmSync(rotated, { force: true });
  let hit = false;
  for (let i = 0; i < 1100; i += 1) {
    ps.purgeLog("unit.rotate", { i });
    if (fs.existsSync(rotated)) { hit = true; break; }
  }
  assert.equal(hit, true, "1024 次写内必须翻滚一次，否则长会话会把 tmp 吃爆");
  fs.rmSync(rotated, { force: true });
  fs.rmSync(LOG_FP, { force: true });
});

// ---------- 风暴熔断（会污染模块级状态，放最后） ----------

test("refreshHungOperator：10 秒内超过 120 次重算就熔断并只记一次日志", () => {
  fs.rmSync(LOG_FP, { force: true });
  const home = freshHome("storm");
  // home 由 pinDshHome() 固定成 $DSH_HOME，换参也不会 miss 缓存；
  // 要靠 committedOverrideRevision 逐次变化把缓存打穿，才数得上 120 次。
  for (let i = 0; i < 130; i += 1) {
    core.rememberCommittedOverride(home, `storm-${i}\n`);
    ps.refreshHungOperator(home);
  }
  const log = readLog();
  assert.match(log, /\[host\.hungStorm\]/, "熔断必须留痕");
  assert.equal((log.match(/\[host\.hungStorm\]/g) || []).length, 1, "只记一次，别在熔断里刷屏");
  const out = ps.refreshHungOperator(home);
  assert.ok(out && typeof out.text === "string");
});
