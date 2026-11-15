/**
 * 宿主面分派与重启参数：lib/web.js、lib/host.js、lib/subagent-control.js。
 *
 * 这三个文件加起来不到 220 行，但坏了的后果都是「用户按了重启，什么都没发生」或者
 * 「子代理的审批被无声拒绝」——两种都不报错：
 *   - restartArgv 算错 → 重启后起的是另一个端口、或者干脆没带 --no-open，用户以为卡住；
 *   - hostAdapter 分派错 → 桌面端拿到 web 的 scheduleRestart，asar 交换永远不触发；
 *   - installSubagentControl 的注册少一个 global → 子会话的审批永远 rejected，
 *     模型只能说「受限制」，而宿主日志里一个字都没有。
 *
 * 不测 scheduleRestart / scheduleCleanupRestart 本身：它们 spawn 一个 detached helper，
 * 然后 setTimeout(() => process.exit(0), 250) —— 直接调用会把跑测试的进程杀掉。
 * 这条盲区写在 docs/test-map.md 第十节。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as web from "../lib/web.js";
import * as host from "../lib/host.js";
import * as surface from "../lib/surface.js";
import * as subagentControl from "../lib/subagent-control.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-hostrestart-"));

test.after(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发 EPERM，交给系统清理临时目录 */
  }
});

/** 造一个带 lib/bin.js 的假 dsh 包根。 */
function fakeBinRoot(tag) {
  const root = path.join(sandbox, tag);
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib", "bin.js"), "// fake entry\n");
  return root;
}

test("restartNote 是给用户看的那句话，换成英文以外的文案会让人以为命令没跑", () => {
  assert.equal(web.restartNote(), "Restarting dsh web…");
});

test("portFromRequest 从 Host 头取端口，取不到就回落 3080", () => {
  assert.equal(web.portFromRequest({ headers: { host: "127.0.0.1:43120" } }), 43120);
  assert.equal(web.portFromRequest({ headers: { host: "localhost:8080" } }), 8080);
  // 没有端口段 → 环境变量 → 默认值
  assert.equal(web.portFromRequest({ headers: { host: "127.0.0.1" } }), Number(process.env.PORT) || 3080);
  assert.equal(web.portFromRequest({}), Number(process.env.PORT) || 3080);
  assert.equal(web.portFromRequest(null), Number(process.env.PORT) || 3080);
  assert.equal(web.portFromRequest(undefined), Number(process.env.PORT) || 3080);
});

test("portFromRequest 只认结尾的 :数字，IPv6 字面量不会被误读成端口", () => {
  // [::1]:43120 结尾仍是 :43120，能取到；纯 IPv6 没有结尾数字段
  assert.equal(web.portFromRequest({ headers: { host: "[::1]:43120" } }), 43120);
  assert.equal(web.portFromRequest({ headers: { host: "[::1]" } }), Number(process.env.PORT) || 3080);
  // 端口后面还有字符就不算
  assert.equal(web.portFromRequest({ headers: { host: "127.0.0.1:43120/x" } }), Number(process.env.PORT) || 3080);
});

test("hostFromRequest 去掉端口，缺 Host 头时回落 127.0.0.1", () => {
  assert.equal(web.hostFromRequest({ headers: { host: "127.0.0.1:43120" } }), "127.0.0.1");
  assert.equal(web.hostFromRequest({ headers: { host: "localhost" } }), "localhost");
  assert.equal(web.hostFromRequest({ headers: {} }), "127.0.0.1");
  assert.equal(web.hostFromRequest({}), "127.0.0.1");
  assert.equal(web.hostFromRequest(undefined), "127.0.0.1");
  // 空字符串也要回落，否则会拼出 http://:43120 这种地址
  assert.equal(web.hostFromRequest({ headers: { host: "" } }), "127.0.0.1");
  // 只有端口没有主机名：剥掉端口后是空串，必须回落（这条走的是 replace 之后的兜底，
  // 与上面 `host: ""` 走的是 header 读取处的兜底，两道都要在）
  assert.equal(web.hostFromRequest({ headers: { host: ":43120" } }), "127.0.0.1");
});

test("restartArgv 找到 bin.js 时改写成 node 入口，且强制带 --no-open", () => {
  const root = fakeBinRoot("bin-a");
  const argv = web.restartArgv({ argv: ["node", "dsh", "web"], findBinRoot: () => root });
  assert.equal(argv[0], path.join(root, "lib", "bin.js"));
  assert.deepEqual(argv.slice(1), ["web", "--no-open"]);
});

test("restartArgv 保留 desktop 子命令，不硬塞 web", () => {
  const root = fakeBinRoot("bin-b");
  const argv = web.restartArgv({ argv: ["node", "dsh", "desktop"], findBinRoot: () => root });
  assert.deepEqual(argv.slice(1), ["desktop", "--no-open"]);
});

test("restartArgv 没有任何子命令时补 web 与端口，且端口来自环境变量", () => {
  const root = fakeBinRoot("bin-c");
  const old = process.env.PORT;
  process.env.PORT = "4555";
  try {
    const argv = web.restartArgv({ argv: ["node", "dsh"], findBinRoot: () => root });
    assert.deepEqual(argv.slice(1), ["web", "--port", "4555", "--no-open"]);
  } finally {
    if (old === undefined) delete process.env.PORT;
    else process.env.PORT = old;
  }
});

test("restartArgv 不会重复塞 --no-open，也不会重复塞 --port", () => {
  const root = fakeBinRoot("bin-d");
  const argv = web.restartArgv({ argv: ["node", "dsh", "web", "--no-open"], findBinRoot: () => root });
  assert.equal(argv.filter((a) => a === "--no-open").length, 1);
  const argv2 = web.restartArgv({ argv: ["node", "dsh", "web", "--port", "4000"], findBinRoot: () => root });
  assert.deepEqual(argv2.slice(1), ["web", "--port", "4000", "--no-open"]);
});

test("restartArgv 找不到 bin.js 时退到 argv 平移，并把 .cmd 换成真实 bin.js", () => {
  // 没有 bin.js：只平移一格（丢掉 node 本身）
  const plain = web.restartArgv({ argv: ["node", "dsh", "web"], findBinRoot: () => null });
  assert.deepEqual(plain, ["dsh", "web", "--no-open"]);

  // .cmd 在 argv[1]（node 的入口脚本位置）旁边有 node_modules/@deepseek-ai/dsh/lib/bin.js → 换成它
  const dir = path.join(sandbox, "cmd-root");
  fs.mkdirSync(path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  const real = path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  fs.writeFileSync(real, "// real\n");
  const cmd = path.join(dir, "dsh.cmd");
  fs.writeFileSync(cmd, "@ECHO off\n");
  const rewritten = web.restartArgv({ argv: ["node.exe", cmd, "web"], findBinRoot: () => null });
  assert.equal(rewritten[0], real);
  assert.deepEqual(rewritten.slice(1), ["web", "--no-open"]);
});

test("restartArgv 的 .cmd 回退还认上一级 node_modules（全局安装布局）", () => {
  const dir = path.join(sandbox, "cmd-root-2", "bin");
  fs.mkdirSync(path.join(dir, "..", "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const real = path.resolve(dir, "..", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  fs.writeFileSync(real, "// real\n");
  const cmd = path.join(dir, "dsh.cmd");
  fs.writeFileSync(cmd, "@ECHO off\n");
  const rewritten = web.restartArgv({ argv: ["node.exe", cmd], findBinRoot: () => null });
  assert.equal(rewritten[0], real);
});

test("restartArgv 对 .bat 与大小写混写的后缀同样处理", () => {
  const dir = path.join(sandbox, "cmd-root-3");
  fs.mkdirSync(path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  const real = path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  fs.writeFileSync(real, "// real\n");
  const bat = path.join(dir, "dsh.BAT");
  fs.writeFileSync(bat, "@ECHO off\n");
  const rewritten = web.restartArgv({ argv: ["node.exe", bat], findBinRoot: () => null });
  assert.equal(rewritten[0], real);
});

test("restartArgv 只在 argv[1] 是 .cmd/.bat 时改写（现状锁定）", () => {
  // argv[0] 是 .cmd 时，slice(1) 把 .cmd 本身丢掉了，剩下的第一项是子命令 → 不改写。
  // 真实进程里 argv[0] 永远是 node/exe，所以这条分支实际只在 argv[1] 命中；
  // 写成断言是为了让将来「顺手改成 argv[0] 也认」的人先看到这里。
  const dir = path.join(sandbox, "cmd-root-4");
  fs.mkdirSync(path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "// real\n");
  const cmd = path.join(dir, "dsh.cmd");
  fs.writeFileSync(cmd, "@ECHO off\n");
  const rewritten = web.restartArgv({ argv: [cmd, "web"], findBinRoot: () => null });
  assert.deepEqual(rewritten, ["web", "--no-open"]);
});

test("hostAdapter 按 surface 分派，gui / tui / 未知一律回落 web", () => {
  assert.equal(host.hostAdapter("desktop"), host.hostAdapter("desktop"));
  // web 面拿到的是 web.js 的导出面
  const webFace = host.hostAdapter("web");
  assert.equal(typeof webFace.restartArgv, "function");
  assert.equal(typeof webFace.portFromRequest, "function");
  // desktop 面拿到的是 desktop.js 的导出面（含 asar 交换脚本）
  const deskFace = host.hostAdapter("desktop");
  assert.equal(typeof deskFace.ASAR_SWAP_PS1, "string");
  assert.equal(typeof deskFace.scheduleRestart, "function");
  // gui / tui / 拼错的 surface 都走 web
  assert.equal(host.hostAdapter("gui"), webFace);
  assert.equal(host.hostAdapter("tui"), webFace);
  assert.equal(host.hostAdapter("bogus"), webFace);
});

test("adapterFor 只会吐 web / desktop —— hostAdapter 里的 `|| web` 是不可达兜底（现状锁定）", () => {
  // adapterFor 现在只有两个返回值，ADAPTERS 两个键都有，所以 hostAdapter 的
  // `ADAPTERS[adapterFor(kind)] || web` 里那个 `|| web` 永远不会生效。
  // 保留它是对的（将来 adapterFor 真能吐 gui 时兜底就活了），但必须钉住前提：
  // 一旦 adapterFor 开始返回第三种值，这条会先红，提醒去看 hostAdapter 的分派表。
  const outputs = new Set(
    ["web", "desktop", "gui", "tui", "bogus", "", null, undefined].map((k) => surface.adapterFor(k)),
  );
  assert.deepEqual([...outputs].sort(), ["desktop", "web"]);
  // 每一种输入都能拿到一个带 scheduleRestart 的面，不会 undefined
  for (const kind of ["web", "desktop", "gui", "tui", "bogus"]) {
    assert.equal(typeof host.hostAdapter(kind).scheduleRestart, "function", `surface=${kind}`);
  }
});

test("host.currentSurface 认 DSH_SURFACE 强制值", () => {
  assert.equal(host.currentSurface({ env: { DSH_SURFACE: "desktop" } }), "desktop");
  assert.equal(host.currentSurface({ env: { DSH_SURFACE: "WEB" } }), "web");
  assert.equal(host.currentSurface({ env: {} }), "web");
});

test("host.restartNote 透传当前面的文案，desktop 面与 web 面不同", () => {
  const old = process.env.DSH_SURFACE;
  try {
    process.env.DSH_SURFACE = "web";
    assert.equal(host.restartNote(), web.restartNote());
    process.env.DSH_SURFACE = "desktop";
    assert.notEqual(host.restartNote(), web.restartNote());
  } finally {
    if (old === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = old;
  }
});

/** 造一个记录注册的假 ctx。 */
function fakeCtx() {
  const regs = [];
  return {
    regs,
    ctx: {
      on(name, fn, opts) {
        regs.push({ name, fn, opts, off: false });
        return () => {
          const hit = regs.find((r) => r.name === name && r.fn === fn);
          if (hit) hit.off = true;
        };
      },
    },
  };
}

const childSession = (sink) => ({
  header: { origin: "subagent" },
  append: (type, data) => sink.push({ type, data }),
});
const mainSession = (sink) => ({
  header: {},
  append: (type, data) => sink.push({ type, data }),
});

test("installSubagentControl 在关闭配置或宿主没有事件总线时什么都不注册", () => {
  assert.equal(typeof subagentControl.installSubagentControl({}, { subagentControl: false }), "function");
  const a = fakeCtx();
  const off = subagentControl.installSubagentControl(a.ctx, { subagentControl: false });
  assert.equal(a.regs.length, 0);
  off();

  const b = fakeCtx();
  subagentControl.installSubagentControl({}, {});
  assert.equal(b.regs.length, 0);
});

test("installSubagentControl 注册两个钩子，且都必须 global", () => {
  const a = fakeCtx();
  subagentControl.installSubagentControl(a.ctx, {});
  assert.deepEqual(a.regs.map((r) => r.name), ["session/event", "approval/request"]);
  // session/event 只写了 global；approval/request 还要 prepend
  assert.equal(a.regs[0].opts.global, true);
  assert.equal(a.regs[1].opts.global, true);
  assert.equal(a.regs[1].opts.prepend, true);
});

test("看到宿主写的 never 才补 ask，子会话以外一律不动", async () => {
  const a = fakeCtx();
  subagentControl.installSubagentControl(a.ctx, {});
  const onEvent = a.regs[0].fn;
  const sink = [];
  const child = childSession(sink);
  const main = mainSession(sink);

  // 主会话写 never：不补
  onEvent(main, { type: "approval/policy", data: { policy: "never" } });
  // 子会话写 ask：本来就不用补
  onEvent(child, { type: "approval/policy", data: { policy: "ask" } });
  // 子会话但事件类型不对：不补
  onEvent(child, { type: "approval/request", data: { policy: "never" } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sink, []);

  // 子会话写 never：补一条 ask
  onEvent(child, { type: "approval/policy", data: { policy: "never" } });
  // 不能在 append 的处理链里再 append，所以这一步是同步空的
  assert.deepEqual(sink, []);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sink, [{ type: "approval/policy", data: { policy: "ask" } }]);
});

test("同一会话最多补 4 次 ask，防止异常会话里反复触发", async () => {
  const a = fakeCtx();
  subagentControl.installSubagentControl(a.ctx, {});
  const onEvent = a.regs[0].fn;
  const sink = [];
  const child = childSession(sink);
  for (let i = 0; i < 8; i += 1) onEvent(child, { type: "approval/policy", data: { policy: "never" } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sink.length, 4);
});

test("append 失败时名额退还：会话一直写不进去也不会被永久烧掉额度", async () => {
  const a = fakeCtx();
  subagentControl.installSubagentControl(a.ctx, {});
  const onEvent = a.regs[0].fn;

  // 会话已关：append 抛错。每 tick 都还会再试，不会一次失败就彻底放弃。
  let attempts = 0;
  const closed = { header: { origin: "subagent" }, append: () => { attempts += 1; throw new Error("closed"); } };
  const tick = async () => {
    for (let i = 0; i < 6; i += 1) onEvent(closed, { type: "approval/policy", data: { policy: "never" } });
    await new Promise((r) => setTimeout(r, 0));
    return attempts;
  };
  assert.equal(await tick(), 4);
  assert.equal(await tick(), 5);
  assert.equal(await tick(), 6);

  // 换成能写的会话，仍然拿到完整的 4 次额度
  const sink = [];
  const child = childSession(sink);
  for (let i = 0; i < 6; i += 1) onEvent(child, { type: "approval/policy", data: { policy: "never" } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sink.length, 4);
});

test("现状锁定：同一 tick 的多条 never 共享同一个计数，退还时把计数写回旧值", async () => {
  // 注释里写的是「先同步占位，append 失败再退回」，但退还写回的是事件读到的那份 n，
  // 同一 tick 里 4 条事件读到的 n 各不相同（0/1/2/3），退还按队列顺序写回，
  // 最后落成 3 —— 于是下一个 tick 又能再补 1 次。效果是「写不进去的会话每 tick 漏 1 个名额」，
  // 不是注释期望的「完全退还」。后果很轻（最多多写几次失败的 append），
  // 但断言必须钉住它，否则将来有人把 MAX_FLIPS 调到 1 或改成 Set 计数时，
  // 会以为这里已经严格了。
  const a = fakeCtx();
  subagentControl.installSubagentControl(a.ctx, {});
  const onEvent = a.regs[0].fn;
  let attempts = 0;
  const closed = { header: { origin: "subagent" }, append: () => { attempts += 1; throw new Error("closed"); } };
  const tick = async () => {
    const before = attempts;
    for (let i = 0; i < 6; i += 1) onEvent(closed, { type: "approval/policy", data: { policy: "never" } });
    await new Promise((r) => setTimeout(r, 0));
    return attempts - before;
  };
  assert.equal(await tick(), 4);
  // 严格退还的话这里应该是 4（额度全部还回来）；实际是 1
  assert.equal(await tick(), 1);
  assert.equal(await tick(), 1);
});

test("观察者自己抛错也不会把宿主的 append 链带崩", async () => {
  const a = fakeCtx();
  subagentControl.installSubagentControl(a.ctx, {});
  const onEvent = a.regs[0].fn;
  // event 是 null / data 缺失 / session 没有 header —— 全部不能抛
  assert.doesNotThrow(() => onEvent(null, null));
  assert.doesNotThrow(() => onEvent({}, { type: "approval/policy" }));
  assert.doesNotThrow(() => onEvent({ header: { origin: "subagent" } }, { type: "approval/policy", data: { policy: "never" } }));
  await new Promise((r) => setTimeout(r, 0));
});

test("approval/request 对子会话放行一次，其余交给 next", () => {
  const a = fakeCtx();
  subagentControl.installSubagentControl(a.ctx, {});
  const onApproval = a.regs[1].fn;
  const child = childSession([]);
  const main = mainSession([]);

  assert.equal(onApproval({ agent: { session: child } }, () => "NEXT"), "allowed-once");
  assert.equal(onApproval({ agent: { session: main } }, () => "NEXT"), "NEXT");
  // 没有 next 也要给宿主一个合法返回值，不能 undefined
  assert.equal(onApproval({ agent: { session: main } }), "unavailable");
  // request 形状不对：走 next，不抛
  assert.equal(onApproval(null, () => "NEXT"), "NEXT");
});

test("释放函数把两个钩子都摘掉", () => {
  const a = fakeCtx();
  const off = subagentControl.installSubagentControl(a.ctx, {});
  off();
  assert.deepEqual(a.regs.map((r) => r.off), [true, true]);
  // 重复调用不抛
  assert.doesNotThrow(() => off());
});

test("子会话判定的三条依据都认：origin / delegationDepth / parentSession", async () => {
  const a = fakeCtx();
  subagentControl.installSubagentControl(a.ctx, {});
  const onEvent = a.regs[0].fn;
  const sink = [];
  const mk = (header) => ({ header, append: (t, d) => sink.push(d.policy) });

  onEvent(mk({ delegationDepth: 2 }), { type: "approval/policy", data: { policy: "never" } });
  onEvent(mk({ parentSession: "p1" }), { type: "approval/policy", data: { policy: "never" } });
  onEvent(mk({ origin: "subagent" }), { type: "approval/policy", data: { policy: "never" } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sink, ["ask", "ask", "ask"]);
});

test("host.scheduleRestart 真的分派到桌面面：openBrowser:false 的自检请求必须被当成跳过", () => {
  // 这层 wrapper 少一行转发，桌面端按重启就什么都不会发生（拿到的是 web 的 scheduleRestart）。
  // 用 openBrowser:false 走桌面适配器里唯一不 spawn 的分支，既验证分派又不会把测试进程杀掉。
  const old = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "desktop";
  try {
    assert.deepEqual(host.scheduleRestart({}, {}, { openBrowser: false }), { restarting: false, skipped: true });
  } finally {
    if (old === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = old;
  }
});
