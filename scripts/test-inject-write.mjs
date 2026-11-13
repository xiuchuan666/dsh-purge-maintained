/**
 * lib/inject-write.js 的行为锁。
 *
 * 这一层是「注入到底有没有生效」的最后一段执行路径，四处判错的表现全是
 * 「AI 行为变了但没有任何报错」：
 *   - installMnemonMessageStrip 决定插件消息是否进上下文
 *   - rewriteLiveAssembly 决定每轮装配长什么样（含缓存命中）
 *   - closerFollowBytes 决定 `</project_instructions>` 之后还剩多少字（诊断指标）
 *   - installIdentityOverride 把 guard 与 waterfall 都挂上
 *
 * 全部用假 ctx / 假 prompt 驱动，不碰真宿主；DSH_HOME 指到临时目录。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 诊断日志 dsh-purge-desktop.log 落在 os.tmpdir() 下，全仓共用一份；node --test
// 默认并行跑各 test-*.mjs，各自往同一个文件追加。logDelta() 靠「文件字节数前后
// 差」切本次新增的行，别的进程刚好在这期间写一行，就会混进本进程的 delta，
// 于是「不该再打 guard.wrap」这类断言偶发红（本地全量跑才复现，单跑这个文件全绿）。
// 根治办法：在 import 任何 lib 之前把 TEMP/TMP/TMPDIR 指到本进程私有的临时目录，
// 这样 lib/prompt-source.js 模块加载时算出的 PURGE_INTERNAL_LOG 就是私有的。
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-inject-write-tmp-"));
const ORIG_TEMP = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
process.env.TEMP = TMP_ROOT;
process.env.TMP = TMP_ROOT;
process.env.TMPDIR = TMP_ROOT;

const iw = await import("../lib/inject-write.js");
const core = await import("../lib/core.js");

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SRC = fs.readFileSync(path.join(ROOT, "lib", "inject-write.js"), "utf8");
const LOG_FP = path.join(os.tmpdir(), "dsh-purge-desktop.log");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-inject-write-"));
const ORIG_HOME = process.env.DSH_HOME;
const ORIG_PREPARE = globalThis.__dshPurgePrepareAssemble;
let homeSeq = 0;

function useHome(tag) {
  homeSeq += 1;
  const home = path.join(SANDBOX, `${tag}-${homeSeq}`);
  fs.mkdirSync(home, { recursive: true });
  process.env.DSH_HOME = home;
  return home;
}

test.after(() => {
  if (ORIG_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIG_HOME;
  if (ORIG_PREPARE === undefined) delete globalThis.__dshPurgePrepareAssemble;
  else globalThis.__dshPurgePrepareAssemble = ORIG_PREPARE;
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const key of ["TEMP", "TMP", "TMPDIR"]) {
    if (ORIG_TEMP[key] === undefined) delete process.env[key];
    else process.env[key] = ORIG_TEMP[key];
  }
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 假 ctx：可选的 systemPrompt getter、记录 hooks 与 effect。 */
function fakeCtx(over = {}) {
  const hooks = new Map();
  const effects = [];
  const ctx = {
    on(name, fn, opts) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push({ fn, opts });
      return () => {
        const list = hooks.get(name) || [];
        const at = list.findIndex((x) => x.fn === fn);
        if (at >= 0) list.splice(at, 1);
      };
    },
    effect(fn) { effects.push(fn); },
    get() { return undefined; },
    ...over,
  };
  return { ctx, hooks, effects };
}

/** 给假 ctx 装一个可换的 systemPrompt。 */
function withPrompt(ctx, prompt) {
  let current = prompt;
  Object.defineProperty(ctx, "systemPrompt", {
    get() { return current; },
    set(next) { current = next; },
    configurable: true,
  });
  return () => current;
}

/** 跑完所有 effect，返回它们的 disposer（按注册顺序）。 */
function runEffects(ctx) {
  const out = [];
  for (const fn of ctx.__effects || []) {
    const d = fn();
    if (typeof d === "function") out.push(d);
  }
  return out;
}

/** 记录假 ctx 的 effects 并暴露给 runEffects。 */
function trackEffects(wrap) {
  const effects = wrap.effects;
  Object.defineProperty(wrap.ctx, "__effects", { get: () => effects, configurable: true });
  return wrap;
}

/** 从日志里捞本次新增的行。 */
function logDelta(fn) {  const before = fs.existsSync(LOG_FP) ? fs.statSync(LOG_FP).size : 0;
  const out = fn();
  const text = fs.existsSync(LOG_FP) ? fs.readFileSync(LOG_FP, "utf8") : "";
  const buf = Buffer.from(text, "utf8");
  return { out, added: buf.subarray(before).toString("utf8") };
}

function logTags(added) {
  return added.split("\n").filter(Boolean).map((line) => {
    const m = line.match(/\[([^\]]+)\]/);
    return m ? m[1] : "";
  });
}

function logLine(added, tag) {
  return added.split("\n").find((line) => line.includes(`[${tag}]`)) || "";
}

function kvOf(line) {
  const idx = line.indexOf("] ");
  if (idx < 0) return {};
  const obj = {};
  for (const part of line.slice(idx + 2).trim().split(/\s+/)) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    obj[part.slice(0, at)] = part.slice(at + 1);
  }
  return obj;
}

function namesOf(assembled) {
  return (assembled?.sections || []).map((s) => String(s?.name || "")).join("|");
}

// ---------------------------------------------------------------- 文件头与导出

test("模块只导出四个函数，且不带 default", () => {
  assert.deepEqual(Object.keys(iw).sort(), [
    "closerFollowBytes",
    "installIdentityOverride",
    "installMnemonMessageStrip",
    "rewriteLiveAssembly",
  ]);
});

test("文件头写明与 prompt-source.js 的分工（读者不必猜哪边负责什么）", () => {
  assert.match(SRC, /与 lib\/prompt-source\.js 的分工/);
  assert.match(SRC, /那边只负责读盘与缓存出正文，这边负责把正文写进装配/);
});

// ------------------------------------------------- installMnemonMessageStrip

test("mnemon：没有 ctx.on 时直接返回，不留标记", () => {
  const { ctx } = fakeCtx({ on: undefined });
  iw.installMnemonMessageStrip(ctx, {});
  assert.equal(ctx.__dshPurgeMnemonStrip, undefined);
});

test("mnemon：装一次、挂一次 agent/pre-step，并带 global + prepend", () => {
  const wrap = trackEffects(fakeCtx());
  iw.installMnemonMessageStrip(wrap.ctx, {});
  assert.equal(wrap.ctx.__dshPurgeMnemonStrip, true);
  const list = wrap.hooks.get("agent/pre-step") || [];
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].opts, { global: true, prepend: true });
});

test("mnemon：重复安装被标记挡住，listener 不会叠第二层", () => {
  const wrap = trackEffects(fakeCtx());
  iw.installMnemonMessageStrip(wrap.ctx, {});
  iw.installMnemonMessageStrip(wrap.ctx, {});
  iw.installMnemonMessageStrip(wrap.ctx, {});
  assert.equal((wrap.hooks.get("agent/pre-step") || []).length, 1);
});

test("mnemon：strip 默认开启，插件消息被滤掉且返回新对象", async () => {
  const wrap = trackEffects(fakeCtx());
  iw.installMnemonMessageStrip(wrap.ctx, {});
  const call = wrap.hooks.get("agent/pre-step")[0].fn;
  const decision = {
    messages: [
      { source: { kind: "plugin", plugin: "mnemon-memory" }, text: "x" },
      { source: { kind: "user" }, text: "hi" },
    ],
  };
  const out = await call({}, async () => decision);
  assert.notEqual(out, decision);
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].source.kind, "user");
  assert.equal(decision.messages.length, 2, "入参不能被原地改");
});

test("mnemon：插件名大小写不敏感，但 kind 必须是 plugin", async () => {
  const wrap = trackEffects(fakeCtx());
  iw.installMnemonMessageStrip(wrap.ctx, {});
  const call = wrap.hooks.get("agent/pre-step")[0].fn;
  const upper = await call({}, async () => ({ messages: [{ source: { kind: "plugin", plugin: "MNEMON-X" } }] }));
  assert.equal(upper.messages.length, 0);
  const wrongKind = await call({}, async () => ({ messages: [{ source: { kind: "tool", plugin: "mnemon-x" } }] }));
  assert.equal(wrongKind.messages.length, 1);
  const noSource = await call({}, async () => ({ messages: [{ text: "bare" }] }));
  assert.equal(noSource.messages.length, 1);
});

test("mnemon：一个都没滤掉时返回同一个对象（省一次 spread）", async () => {
  const wrap = trackEffects(fakeCtx());
  iw.installMnemonMessageStrip(wrap.ctx, {});
  const call = wrap.hooks.get("agent/pre-step")[0].fn;
  const decision = { messages: [{ source: { kind: "user" } }] };
  const out = await call({}, async () => decision);
  assert.equal(out, decision);
});

test("mnemon：decision 为空时原样返回，不造对象", async () => {
  const wrap = trackEffects(fakeCtx());
  iw.installMnemonMessageStrip(wrap.ctx, {});
  const call = wrap.hooks.get("agent/pre-step")[0].fn;
  assert.equal(await call({}, async () => null), null);
  assert.equal(await call({}, async () => undefined), undefined);
});

test("mnemon：decision 里没有 messages 数组时补成空数组（agent-loop 读 length）", async () => {
  const wrap = trackEffects(fakeCtx());
  iw.installMnemonMessageStrip(wrap.ctx, {});
  const call = wrap.hooks.get("agent/pre-step")[0].fn;
  const out = await call({}, async () => ({ other: 1 }));
  assert.deepEqual(out, { other: 1, messages: [] });
  // messages 是真值但不是数组时也必须换成数组：agent-loop 会直接读 length，
  // 字符串的 length 是字符数，下游按条数遍历就错位了。
  const odd = await call({}, async () => ({ messages: "not-an-array" }));
  assert.deepEqual(odd, { messages: [] });
});

test("mnemon：stripMnemon:false 时一条都不滤", async () => {
  const wrap = trackEffects(fakeCtx());
  iw.installMnemonMessageStrip(wrap.ctx, { stripMnemon: false });
  const call = wrap.hooks.get("agent/pre-step")[0].fn;
  const decision = { messages: [{ source: { kind: "plugin", plugin: "mnemon" } }] };
  const out = await call({}, async () => decision);
  assert.equal(out, decision);
});

test("mnemon：mounted 闸——第一次抛错后由微任务补挂，且只补一次", async () => {
  let attempts = 0;
  const hooks = new Map();
  const wrap = trackEffects(fakeCtx({
    on(name, fn, opts) {
      attempts += 1;
      if (attempts <= 1) throw new Error("not ready");
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push({ fn, opts });
      return () => {};
    },
  }));
  iw.installMnemonMessageStrip(wrap.ctx, {});
  assert.equal(attempts, 1, "同步阶段只试一次");
  assert.equal(wrap.ctx.__dshPurgeMnemonStrip, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(attempts, 2);
  assert.equal((hooks.get("agent/pre-step") || []).length, 1);
});

test("mnemon：mounted 之后 1500ms 的迟到重试不再叠第二层", async () => {
  let attempts = 0;
  const hooks = new Map();
  const wrap = trackEffects(fakeCtx({
    on(name, fn, opts) {
      attempts += 1;
      if (attempts <= 1) throw new Error("not ready");
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push({ fn, opts });
      return () => {};
    },
  }));
  iw.installMnemonMessageStrip(wrap.ctx, {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((hooks.get("agent/pre-step") || []).length, 1, "微任务补挂成功");
  // 计时器在同步阶段就排上了，1500ms 到点会再调一次 late；mounted 闸必须把它挡掉，
  // 否则同一个 wrap 会在 agent/pre-step 瀑布上叠第二层，每轮多滤一遍。
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal((hooks.get("agent/pre-step") || []).length, 1);
  assert.match(SRC, /^    if \(mounted\) return;$/m);
});

test("mnemon：重试计时器 unref，且 effect cleanup 会清掉它", () => {
  const wrap = trackEffects(fakeCtx({ on() { throw new Error("never"); } }));
  iw.installMnemonMessageStrip(wrap.ctx, {});
  assert.match(SRC, /retryTimer = setTimeout\(late, 1500\);/);
  assert.match(SRC, /if \(typeof retryTimer\.unref === "function"\) retryTimer\.unref\(\);/);
  assert.equal(wrap.effects.length, 1);
  const dispose = wrap.effects[0]();
  assert.equal(typeof dispose, "function");
  assert.match(SRC, /if \(retryTimer\) clearTimeout\(retryTimer\);/);
});

// ------------------------------------------------------- rewriteLiveAssembly

test("rewrite：默认把注入头、能力段、锚点都挂上", () => {
  useHome("rw-default");
  const out = iw.rewriteLiveAssembly(
    { enabled: true, stripMnemon: true, capabilityProtocol: true },
    { sections: [{ name: "base", text: "hello" }] },
    {},
    { mode: "full", taskKind: "general" },
  );
  assert.equal(namesOf(out), "dsh-purge|dshpg-capabilities|base|deployment:persona-suffix|dsh-purge:anchor");
});

test("rewrite：不入参原地改写（宿主复用同一对象，下一轮会被污染）", () => {
  useHome("rw-pure");
  const assembled = { sections: [{ name: "base", text: "hello" }] };
  const out = iw.rewriteLiveAssembly({ enabled: true }, assembled, {}, { mode: "full" });
  assert.notEqual(out, assembled);
  assert.equal(namesOf(assembled), "base");
});

test("rewrite：stripMnemon:false 时 mnemon 段留在装配里", () => {
  useHome("rw-strip");
  const asm = () => ({ sections: [{ name: "base", text: "hello" }, { name: "mnemon-memory", text: "MEM" }] });
  const kept = iw.rewriteLiveAssembly({ enabled: true, stripMnemon: false }, asm(), {}, { mode: "full" });
  assert.match(namesOf(kept), /mnemon-memory/);
  const stripped = iw.rewriteLiveAssembly({ enabled: true, stripMnemon: true }, asm(), {}, { mode: "full" });
  assert.doesNotMatch(namesOf(stripped), /mnemon-memory/);
});

test("rewrite：anchorMode:off 时锚点段不挂", () => {
  useHome("rw-anchor");
  const out = iw.rewriteLiveAssembly({ enabled: true, anchorMode: "off" }, { sections: [] }, {}, { mode: "full" });
  assert.doesNotMatch(namesOf(out), /dsh-purge:anchor/);
});

test("rewrite：enabled:false 时不挂注入头，只剩能力段与 persona", () => {
  useHome("rw-disabled");
  const out = iw.rewriteLiveAssembly({ enabled: false }, { sections: [{ name: "base", text: "hello" }] }, {}, { mode: "full" });
  assert.equal(namesOf(out), "dshpg-capabilities|base|deployment:persona-suffix");
});

test("rewrite：空装配对象不会炸", () => {
  useHome("rw-empty");
  assert.doesNotThrow(() => iw.rewriteLiveAssembly({ enabled: true }, {}, {}, { mode: "full" }));
  assert.equal(iw.rewriteLiveAssembly({ enabled: true }, null, {}, { mode: "full" }), null);
});

test("rewrite：同签名第二次起命中缓存，返回同一对象", () => {
  useHome("rw-cache");
  const cfg = { enabled: true, stripMnemon: true, capabilityProtocol: true };
  const assembled = { sections: [{ name: "base", text: "hello" }] };
  const a = iw.rewriteLiveAssembly(cfg, assembled, {}, { mode: "full", taskKind: "general" });
  const b = iw.rewriteLiveAssembly(cfg, assembled, {}, { mode: "full", taskKind: "general" });
  const c = iw.rewriteLiveAssembly(cfg, assembled, {}, { mode: "full", taskKind: "general" });
  // 第一次进来会把 prompt-inject.md seed 到磁盘，committedOverrideRevision 从 0 推到 1，
  // 所以 a 算出来的签名与 b 不同；从 b 起签名稳定，必须命中同一个对象。
  assert.notEqual(a, b);
  assert.equal(b, c);
});

test("rewrite：换配置 / 换装配对象都不复用上次结果", () => {
  useHome("rw-cache-miss");
  const base = { enabled: true, stripMnemon: true, capabilityProtocol: true };
  const assembled = { sections: [{ name: "base", text: "hello" }] };
  const hit = iw.rewriteLiveAssembly(base, assembled, {}, { mode: "full" });
  const otherCfg = iw.rewriteLiveAssembly({ ...base, capabilityProtocol: false }, assembled, {}, { mode: "full" });
  assert.notEqual(otherCfg, hit);
  assert.doesNotMatch(namesOf(otherCfg), /dshpg-capabilities/);
  const otherAsm = iw.rewriteLiveAssembly(base, { sections: [{ name: "base", text: "other" }] }, {}, { mode: "full" });
  assert.notEqual(otherAsm, hit);
});

test("rewrite：会话签名来自 sessionKeyOf，不是就地读 header", () => {
  assert.match(SRC, /session: sessionKeyOf\(context\),/);
  assert.match(SRC, /const sigHome = config\.enabled !== false \? core\.findDshHome\(\) : "";/);
  assert.match(SRC, /const sigRevision = config\.enabled !== false \? core\.committedOverrideRevision\(\) : "";/);
  // 缓存值可能是空对象 {}，真值判断会把有效结果当未命中而重算。
  assert.match(SRC, /if \(cached !== undefined\) return cached;/);
});

test("rewrite：诊断行字段齐全且顺序固定（20 个字段）", () => {
  useHome("rw-log");
  const { added } = logDelta(() => {
    iw.rewriteLiveAssembly({ enabled: true, anchorMode: "off" }, { sections: [{ name: "base", text: "hello" }] }, {}, { mode: "full", taskKind: "general" });
  });
  const line = logLine(added, "assemble.rewrite");
  assert.ok(line, "必须打出 assemble.rewrite 行");
  assert.deepEqual(Object.keys(kvOf(line)), [
    "enabled", "redteam", "mode", "task", "last", "fullBytes", "localBytes",
    "injectBytes", "anchorApplied", "roleBytes", "cap", "strip", "policy",
    "approval", "dropWorkspaceBaseline", "injectHead", "injectTail", "chatml",
    "afterCloser", "cwd",
  ]);
  const kv = kvOf(line);
  assert.equal(kv.enabled, "true");
  assert.equal(kv.anchorApplied, "false");
  assert.equal(kv.injectHead, "true");
  assert.equal(kv.injectTail, "false", "锚点关掉时最后一段不是 dsh-purge*");
  assert.equal(kv.chatml, "true");
  assert.ok(Number(kv.injectBytes) > 10000, "注入正文应有万级字节");
  // afterCloser 是「</project_instructions> 之后还剩多少字」的诊断指标；
  // 只钉字段存在会被 afterCloser: 0 蒙过去，必须钉它是正数。
  assert.ok(Number(kv.afterCloser) > 0, "注入头之后应当还有正文");
});

test("rewrite：锚点默认开着时 anchorApplied 记 true", () => {
  useHome("rw-anchor-true");
  const { added } = logDelta(() => {
    iw.rewriteLiveAssembly({ enabled: true }, { sections: [{ name: "base", text: "hello" }] }, {}, { mode: "full" });
  });
  assert.equal(kvOf(logLine(added, "assemble.rewrite")).anchorApplied, "true");
});

test("rewrite：workspace 策略变了就必须换缓存键（不许沿用上一轮结果）", () => {
  const home = useHome("rw-policy");
  const assembled = { sections: [{ name: "base", text: "hello" }] };
  const cfg = { enabled: true, anchorMode: "off" };
  // 第一轮热身：这一轮会把 prompt-inject.md seed 到磁盘、committedOverrideRevision 从 0 推到 1。
  const warm = iw.rewriteLiveAssembly(cfg, assembled, {}, { mode: "full" });
  fs.writeFileSync(
    path.join(home, "dsh-purge", "workspace-policy.json"),
    JSON.stringify({ policy: "strict" }),
    "utf8",
  );
  const strict = iw.rewriteLiveAssembly(cfg, assembled, {}, { mode: "full" });
  assert.notEqual(strict, warm, "策略从 fallback 变 strict 后必须重算");
  // 换一个新对象读日志：上面那个已被 strict 签名缓存，再打一次不会重算、也就不会写日志。
  const strictLog = logDelta(() => {
    iw.rewriteLiveAssembly(cfg, { sections: [{ name: "base", text: "hello" }] }, {}, { mode: "full" });
  });
  assert.equal(kvOf(logLine(strictLog.added, "assemble.rewrite")).policy, "strict");
  fs.writeFileSync(
    path.join(home, "dsh-purge", "workspace-policy.json"),
    JSON.stringify({ policy: "always" }),
    "utf8",
  );
  const always = iw.rewriteLiveAssembly(cfg, assembled, {}, { mode: "full" });
  assert.notEqual(always, strict, "strict 变 always 也必须重算（签名缺 policy 时这里会命中）");
});

test("rewrite：cwd 从 context 取出来并落到 last-cwd.txt", () => {
  const home = useHome("rw-cwd");
  const ctx = { agent: { session: { header: { cwd: " D:/work/x " } } } };
  const { added } = logDelta(() => {
    iw.rewriteLiveAssembly({ enabled: true }, { sections: [] }, ctx, { mode: "full" });
  });
  assert.equal(kvOf(logLine(added, "assemble.rewrite")).cwd, "D:/work/x");
  const fp = path.join(home, "dsh-purge", "last-cwd.txt");
  assert.equal(fs.readFileSync(fp, "utf8"), "D:/work/x");
});

// --------------------------------------------------------- closerFollowBytes

test("closerFollowBytes：没有段 / 没有标记一律 -1", () => {
  assert.equal(iw.closerFollowBytes(null), -1);
  assert.equal(iw.closerFollowBytes(undefined), -1);
  assert.equal(iw.closerFollowBytes([]), -1);
  assert.equal(iw.closerFollowBytes([{ text: "abc" }]), -1);
  assert.equal(iw.closerFollowBytes([{ text: 42 }]), -1);
});

test("closerFollowBytes：算的是闭标记之后的字节数", () => {
  assert.equal(iw.closerFollowBytes([{ text: "</project_instructions>" }]), 0);
  assert.equal(iw.closerFollowBytes([{ text: "a</project_instructions>bcd" }]), 3);
});

test("closerFollowBytes：多段先按空行拼再取最后一次出现", () => {
  // "a</project_instructions>" + "\n\n" + "xy" → 闭标记之后 "\n\nxy" 共 4 字节
  assert.equal(iw.closerFollowBytes([{ text: "a</project_instructions>" }, { text: "xy" }]), 4);
});

test("closerFollowBytes：闭标记出现多次时按最后一次算，不是第一次", () => {
  // 只按第一次算会得到 26（"a</project_instructions>b" 的长度），按最后一次才是 1。
  assert.equal(iw.closerFollowBytes([{ text: "</project_instructions>a</project_instructions>b" }]), 1);
});

test("closerFollowBytes：空段被 filter 掉，不影响偏移", () => {
  assert.equal(iw.closerFollowBytes([{ text: "</project_instructions>z" }, { text: "" }, {}]), 1);
});

// ------------------------------------------------------ installIdentityOverride

test("identity：没有 ctx.on 时直接返回，一个钩子都不挂", () => {
  useHome("id-no-on");
  const ctx = { on: undefined };
  iw.installIdentityOverride(ctx, {});
  assert.equal(ctx.__dshPurgeAssembleHook, undefined);
  assert.equal(ctx.__dshPurgeSessionHook, undefined);
});

test("identity：把 400ms 轮询、session/preset/pre-step、assemble 瀑布四类钩子都挂上", () => {
  useHome("id-hooks");
  const wrap = trackEffects(fakeCtx());
  withPrompt(wrap.ctx, { assemble: async () => ({ sections: [{ name: "base", text: "x" }] }) });
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  assert.deepEqual([...wrap.hooks.keys()].sort(), [
    "agent-preset/selected",
    "agent/pre-step",
    "session/created",
    "system-prompt/assemble",
  ]);
  assert.equal(wrap.ctx.__dshPurgeAssembleHook, true);
  assert.equal(wrap.ctx.__dshPurgeSessionHook, true);
  assert.equal(wrap.ctx.__dshPurgePresetHook, true);
  assert.equal(wrap.ctx.__dshPurgePreStepHook, true);
  assert.equal(typeof globalThis.__dshPurgePrepareAssemble, "function");
  assert.match(SRC, /const timer = setInterval\(\(\) => wrapAssemble\("interval"\), 400\);/);
  assert.match(SRC, /if \(typeof timer\.unref === "function"\) timer\.unref\(\);/);
});

test("identity：system-prompt/assemble 与 pre-step 都带 global + prepend", () => {
  useHome("id-opts");
  const wrap = trackEffects(fakeCtx());
  withPrompt(wrap.ctx, { assemble: async () => ({ sections: [] }) });
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  assert.deepEqual((wrap.hooks.get("system-prompt/assemble") || [])[0].opts, { global: true, prepend: true });
  assert.deepEqual((wrap.hooks.get("agent/pre-step") || [])[0].opts, { global: true, prepend: true });
  assert.deepEqual((wrap.hooks.get("agent-preset/selected") || [])[0].opts, { global: true });
  assert.equal((wrap.hooks.get("session/created") || [])[0].opts, undefined);
});

test("identity：先把 slot.rewrite 包到 systemPrompt.assemble 上，返回值已经带注入", async () => {
  useHome("id-guard");
  const wrap = trackEffects(fakeCtx());
  const prompt = { assemble: async () => ({ sections: [{ name: "base", text: "x" }] }) };
  withPrompt(wrap.ctx, prompt);
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  assert.equal(prompt.assemble._dshPurgeWrapped, true);
  const out = await prompt.assemble({ probe: 1 });
  assert.match(namesOf(out), /^dsh-purge\|/);
  assert.match(namesOf(out), /dsh-purge:anchor$/);
});

test("identity：__dshPurgeDisabled 置位后 rewriteFn 原样返回（停用立即生效）", async () => {
  useHome("id-disabled");
  const wrap = trackEffects(fakeCtx());
  const prompt = { assemble: async () => ({ sections: [{ name: "base", text: "x" }] }) };
  withPrompt(wrap.ctx, prompt);
  iw.installIdentityOverride(wrap.ctx, { enabled: true, anchorMode: "off" });
  const before = await prompt.assemble({});
  assert.doesNotMatch(namesOf(before), /dsh-purge:anchor/);
  wrap.ctx.__dshPurgeDisabled = true;
  const after = await prompt.assemble({});
  assert.equal(namesOf(after), "base");
  assert.match(SRC, /if \(ctx\.__dshPurgeDisabled === true\) return assembled;/);
});

test("identity：assemble 瀑布接到 next、下游抛错时退回上游装配", async () => {
  useHome("id-waterfall");
  const wrap = trackEffects(fakeCtx());
  withPrompt(wrap.ctx, { assemble: async () => ({ sections: [] }) });
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  const entry = (wrap.hooks.get("system-prompt/assemble") || [])[0].fn;
  const upstream = { sections: [{ name: "base", text: "y" }] };
  const ok = await entry(upstream, {}, async () => ({ sections: [{ name: "down", text: "z" }] }));
  assert.match(namesOf(ok), /\|down\|/);
  const fallback = await entry(upstream, {}, async () => { throw new Error("boom"); });
  assert.match(namesOf(fallback), /\|base\|/);
  assert.doesNotMatch(namesOf(fallback), /\|down\|/);
});

test("identity：没有 next 时（旧签名）用入参装配自己动手", async () => {
  useHome("id-no-next");
  const wrap = trackEffects(fakeCtx());
  withPrompt(wrap.ctx, { assemble: async () => ({ sections: [] }) });
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  const entry = (wrap.hooks.get("system-prompt/assemble") || [])[0].fn;
  const out = await entry({ sections: [{ name: "base", text: "y" }] }, {});
  assert.match(namesOf(out), /^dsh-purge\|/);
  assert.match(SRC, /hasNext: typeof next === "function"/);
});

test("identity：四参调用时 next 取最后一个参数，不是 args[2]", async () => {
  useHome("id-next-last");
  const wrap = trackEffects(fakeCtx());
  withPrompt(wrap.ctx, { assemble: async () => ({ sections: [] }) });
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  const entry = (wrap.hooks.get("system-prompt/assemble") || [])[0].fn;
  const upstream = { sections: [{ name: "base", text: "y" }] };
  // cordis 某些版本会多塞参数；next 只认最后一个。写成 args[2] 就会把中间层当 next，
  // 结果 typeof next !== "function"，既不 await 下游也不报错，注入直接跑在旧装配上。
  const out = await entry(upstream, {}, "middle", async () => ({ sections: [{ name: "down", text: "z" }] }));
  assert.match(namesOf(out), /\|down\|/);
});

test("identity：assemble 装配为 null 时不炸，原样返回", async () => {
  useHome("id-null");
  const wrap = trackEffects(fakeCtx());
  withPrompt(wrap.ctx, { assemble: async () => ({ sections: [] }) });
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  const entry = (wrap.hooks.get("system-prompt/assemble") || [])[0].fn;
  assert.equal(await entry(null, {}), null);
});

test("identity：guard 内层抛错时第一次给空装配，不把整条 waterfall 弄死", async () => {
  useHome("id-guard-throw");
  const wrap = trackEffects(fakeCtx());
  const prompt = { assemble: async () => { throw new Error("inner boom"); } };
  withPrompt(wrap.ctx, prompt);
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  const out = await prompt.assemble();
  assert.deepEqual(out, { sections: [], contexts: [], tools: [] });
});

test("identity：prepareAssemble 幂等——装好之后重复调用不再刷 guard.wrap", () => {
  useHome("id-guard-dedupe");
  const wrap = trackEffects(fakeCtx());
  const prompt = { assemble: async () => ({ sections: [] }) };
  withPrompt(wrap.ctx, prompt);
  // 安装阶段本来就会打一条（caller=init）。
  const install = logDelta(() => { iw.installIdentityOverride(wrap.ctx, { enabled: true }); });
  assert.equal(logTags(install.added).filter((t) => t === "guard.wrap").length, 1);
  // 之后 400ms 心跳每轮都调 prepareAssemble，签名不变就不许再写日志。
  const prep = globalThis.__dshPurgePrepareAssemble;
  const repeat = logDelta(() => { prep(wrap.ctx); prep(wrap.ctx); prep(wrap.ctx); });
  assert.equal(logTags(repeat.added).filter((t) => t === "guard.wrap").length, 0);
  assert.match(SRC, /if \(sig !== lastGuardSig\) \{/);
});

test("identity：guard.wrap 的签名只看「有没有 prompt / 挂没挂上」，换代理对象不重复打", () => {
  useHome("id-guard-remount");
  const wrap = trackEffects(fakeCtx());
  withPrompt(wrap.ctx, { assemble: async () => ({ sections: [] }) });
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  const prep = globalThis.__dshPurgePrepareAssemble;
  const swap = logDelta(() => {
    wrap.ctx.systemPrompt = { assemble: async () => ({ sections: [] }) };
    prep(wrap.ctx);
  });
  // 状态没翻转（还是 true|true）就不写日志——这正是避免每天刷百万条的关键。
  assert.equal(logTags(swap.added).filter((t) => t === "guard.wrap").length, 0);
  assert.match(SRC, /const sig = `\$\{!!prompt\}\|\$\{mounted\}`;/);
  // 状态翻转（prompt 变成拿不到）时必须补一条。
  const gone = logDelta(() => {
    wrap.ctx.systemPrompt = null;
    prep(wrap.ctx);
  });
  assert.equal(logTags(gone.added).filter((t) => t === "guard.wrap").length, 1);
});

test("identity：systemPrompt 的 getter 抛错时 prepareAssemble 返回 null 而不冒泡", () => {
  useHome("id-proxy-throw");
  const wrap = trackEffects(fakeCtx());
  Object.defineProperty(wrap.ctx, "systemPrompt", { get() { throw new Error("proxy not injected"); }, configurable: true });
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  assert.equal(globalThis.__dshPurgePrepareAssemble(wrap.ctx), null);
});

test("identity：隔离 loopCtx 上补挂分段与锚点（切预设后锚点不消失）", () => {
  useHome("id-isolated");
  const wrap = trackEffects(fakeCtx());
  withPrompt(wrap.ctx, { assemble: async () => ({ sections: [] }) });
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  const sections = [];
  const isoPrompt = {
    section(spec) { sections.push(spec.name); return () => {}; },
    assemble: async () => ({ sections: [] }),
  };
  const iso = { systemPrompt: isoPrompt, effect() {} };
  globalThis.__dshPurgePrepareAssemble({ ctx: iso });
  // 隔离层的 systemPrompt 上必须补挂两段核心注入 + 锚点段，否则切预设后锚点消失。
  assert.ok(sections.includes("dsh-purge"), `实际注册：${sections.join(",")}`);
  assert.ok(sections.includes("dshpg-capabilities"), `实际注册：${sections.join(",")}`);
  // 隔离层自己不挂 assemble 钩子（那是主 ctx 的事），断言它保持干净。
  assert.equal(iso.__dshPurgeAssembleHook, undefined);
  assert.match(SRC, /registerPromptSections\(iso, config\);/);
  assert.match(SRC, /registerAnchor\(iso, config\);/);
});

test("identity：隔离 loopCtx 的 systemPrompt 拿不到 section 时静默跳过，不冒泡", () => {
  useHome("id-isolated-throw");
  const wrap = trackEffects(fakeCtx());
  withPrompt(wrap.ctx, { assemble: async () => ({ sections: [] }) });
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  const iso = { systemPrompt: {}, effect() {} };
  assert.doesNotThrow(() => globalThis.__dshPurgePrepareAssemble({ ctx: iso }));
  assert.match(SRC, /catch \{ \/\* 隔离层还没有 systemPrompt \*\/ \}/);
});

test("identity：effect cleanup 清掉六个 flag，允许下次 apply 重新挂", () => {
  useHome("id-cleanup");
  const wrap = trackEffects(fakeCtx());
  withPrompt(wrap.ctx, { assemble: async () => ({ sections: [] }) });
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  const disposers = runEffects(wrap.ctx);
  assert.ok(disposers.length >= 1);
  // 这两个 flag 由别的模块（mnemon 剥离 / 地域闸门）置位，installIdentityOverride 只是
  // 替它们做统一回收；先手动置上，否则删掉 delete 那两行测试照样绿。
  wrap.ctx.__dshPurgeMnemonStrip = true;
  wrap.ctx.__dshPurgeRegionGate = true;
  // 最后一个 effect 是 installIdentityOverride 自己登记的（前面的来自 role capture 等）。
  disposers[disposers.length - 1]();
  for (const flag of [
    "__dshPurgeAssembleHook",
    "__dshPurgeSessionHook",
    "__dshPurgePresetHook",
    "__dshPurgePreStepHook",
    "__dshPurgeMnemonStrip",
    "__dshPurgeRegionGate",
  ]) {
    assert.equal(wrap.ctx[flag], undefined, `${flag} 必须被清掉，否则热重载后沉默无响应`);
  }
});

test("identity：cleanup 之后再次 apply 能重新装回钩子", () => {
  useHome("id-reinstall");
  const wrap = trackEffects(fakeCtx());
  withPrompt(wrap.ctx, { assemble: async () => ({ sections: [] }) });
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  const disposers = runEffects(wrap.ctx);
  disposers[disposers.length - 1]();
  iw.installIdentityOverride(wrap.ctx, { enabled: true });
  assert.equal(wrap.ctx.__dshPurgeAssembleHook, true);
  assert.equal((wrap.hooks.get("system-prompt/assemble") || []).length, 2, "新 listener 会再挂一条");
});

test("identity：源码钉住 wrapDisposers / wrappedPrompts 的回收口径", () => {
  assert.match(SRC, /const wrapDisposers = new Set\(\);/);
  assert.match(SRC, /const wrappedPrompts = new WeakSet\(\);/);
  assert.match(SRC, /if \(wrappedPrompts\.has\(prompt\)\) return d;/);
  assert.match(SRC, /for \(const d of wrapDisposers\) \{/);
  assert.match(SRC, /installSubagentRoleCapture\(ctx\);/);
});
