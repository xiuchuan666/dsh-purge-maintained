// 「一键应用到所有宿主 / 全部回退」这两条入口的行为锁定。
//
// 为什么要有这份测试：`applyPatchesAllHosts` / `revertAllHosts` 是用户点「应用」「回退」
// 时真正跑的那两条路，它们会遍历 `enumeratePatchAiBases()` 得到的所有宿主树。
// 判错的两种表现都不抛错：
//   ① 只打了第一棵树（状态页全绿，另一棵树其实没打）；
//   ② 把仓库自己的 devDependencies（node_modules/@deepseek-ai）当宿主打了。
// 第二种尤其致命：本项目的 `node_modules/@deepseek-ai` 是真上游包，打上去之后
// 只有 `npm ci` 才会复位，日常没人会去看。
//
// 所以这份测试的第一条纪律是：**DSH_BASE 必须始终指向沙箱里的树**。
// `findAiBaseWeb()` 在 DSH_BASE 可用时会提前返回；一旦 DSH_BASE 为空/不是 AI 根，
// 它会退到「当前进程所在的树」——也就是本仓库的 node_modules。实测过，会真写盘。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = fs.realpathSync.native(path.join(import.meta.dirname, ".."));
const REPO_TREE = path.join(REPO, "node_modules", "@deepseek-ai");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-all-hosts-"));
const HOME = path.join(ROOT, "home");
const TMP = path.join(ROOT, "tmp");
const KEEP = ["TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "DSH_HOME", "DSH_SURFACE", "DSH_BASE", "DSH_DESKTOP_INSTALL", "PATH", "npm_config_prefix"];
const ORIG = {};
for (const k of KEEP) ORIG[k] = process.env[k];
for (const d of [HOME, TMP]) fs.mkdirSync(d, { recursive: true });
for (const k of ["TEMP", "TMP", "TMPDIR"]) process.env[k] = TMP;
Object.assign(process.env, {
  HOME,
  USERPROFILE: HOME,
  APPDATA: path.join(HOME, "AppData", "Roaming"),
  LOCALAPPDATA: path.join(HOME, "AppData", "Local"),
  DSH_HOME: HOME,
  DSH_SURFACE: "web",
  PATH: TMP,
  npm_config_prefix: path.join(ROOT, "npm-prefix"),
});

const core = await import("../lib/core.js");
const hooksDeny = await import("../lib/hooks-deny.js");

const P1 = core.ALL_PATCHES.find((p) => p.id === 1);
const NEEDLE_A = P1.replacements[0].pattern;
const NEEDLE_B = P1.replacements[1].pattern;
const MARK = "ACTIVE and MANDATORY for this session";
// hooks-deny 的 R1b 反向规则：`restoreHookDenyOfficial` 只认这一整行（含两个 tab 缩进）。
const HOOK_REVERSE_FIND = '\t\tif (merged.decision === "__dsh_purge_deny_disabled__") /* [dsh-purge] hooks deny→allow */ return { kind: "reject" };';

function mk(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function put(fp, text) {
  mk(path.dirname(fp));
  fs.writeFileSync(fp, text, "utf8");
}
function read(fp) {
  return fs.readFileSync(fp, "utf8");
}
const norm = (p) => path.normalize(p).toLowerCase();
const indexOf = (base) => path.join(base, "dsh-agent-instructions", "lib", "index.js");

/** 造一棵「补丁 1 打得上去」的宿主树：只放它需要的那个文件。 */
function hostTree(tag) {
  const base = path.join(ROOT, tag, "node_modules", "@deepseek-ai");
  put(indexOf(base), `// head\n${NEEDLE_A};\n${NEEDLE_B};\n// tail\n`);
  return base;
}
/** 造一棵完整桌面安装：exe + resources/app 下的宿主树。 */
function installTree(tag) {
  const inst = path.join(ROOT, tag, "DeepSeek Harness");
  put(path.join(inst, "DeepSeek Harness.exe"), "MZ");
  // 官方安装里带 sealed CLI 运行时；少了它，`findDesktopShimDir()` 会走另一条分支，
  // 覆盖率基线里 lib/desktop.js 的几行就会掉下去（见 MAINTENANCE.md「别让新 fixture 少造东西」）。
  put(path.join(inst, "resources", "runtime", "cli", "bin", "dsh.cmd"), "@ECHO off\r\n");
  const base = path.join(inst, "resources", "app", "dsh", "node_modules", "@deepseek-ai");
  put(indexOf(base), `// head\n${NEEDLE_A};\n${NEEDLE_B};\n// tail\n`);
  put(path.join(base, "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.2-rc.1" }));
  return { inst, base };
}
/** 每条用例自己的两棵树，避免用例之间互相污染。 */
function dual(prefix) {
  const web = hostTree(`${prefix}-web`);
  const { inst, base } = installTree(`${prefix}-inst`);
  process.env.DSH_BASE = web;
  process.env.DSH_DESKTOP_INSTALL = inst;
  process.env.DSH_SURFACE = "web";
  core.resetPathMemo();
  return { web, desk: base, inst };
}

test.after(() => {
  for (const k of KEEP) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
});

// ── allPatchHostsWritten ────────────────────────────────────────────────
test("allPatchHostsWritten：不是数组一律 false", () => {
  assert.equal(core.allPatchHostsWritten(null), false);
  assert.equal(core.allPatchHostsWritten(undefined), false);
  assert.equal(core.allPatchHostsWritten({ hostWritten: true }), false);
});

test("allPatchHostsWritten：空数组 false —— 一棵都没打不能算成功", () => {
  assert.equal(core.allPatchHostsWritten([]), false);
});

test("allPatchHostsWritten：全部 true 才 true", () => {
  assert.equal(core.allPatchHostsWritten([{ hostWritten: true }, { hostWritten: true }]), true);
});

test("allPatchHostsWritten：有一个 false / 缺字段 / 非布尔就 false", () => {
  assert.equal(core.allPatchHostsWritten([{ hostWritten: true }, { hostWritten: false }]), false);
  assert.equal(core.allPatchHostsWritten([{ hostWritten: true }, {}]), false);
  assert.equal(core.allPatchHostsWritten([{ hostWritten: true }, { hostWritten: 1 }]), false);
});

// ── applyPatchesAllHosts ────────────────────────────────────────────────
test("applyPatchesAllHosts：两棵沙箱树各打一次，顺序是 web 在前、桌面在后", async () => {
  const { web, desk } = dual("order");
  const res = await core.applyPatchesAllHosts([P1], {});
  assert.equal(res.hosts.length, 2);
  assert.equal(norm(res.hosts[0].aiBase), norm(web));
  assert.equal(norm(res.hosts[1].aiBase), norm(desk));
  // 每棵树都带一份「弹窗静默」结果：它在 apply 结束后就要跑，决定要不要重启宿主。
  for (const host of res.hosts) {
    assert.equal(typeof host.flash, "object");
    assert.equal(typeof host.flash.entry, "string");
    assert.equal(typeof host.flash.preflight, "string");
    assert.equal(typeof host.flash.live, "object");
  }
});

test("applyPatchesAllHosts：两棵树上的文件都真的被改了（不是只打第一棵）", async () => {
  const { web, desk } = dual("write");
  await core.applyPatchesAllHosts([P1], {});
  assert.ok(read(indexOf(web)).includes(MARK), "web 树没被改");
  assert.ok(read(indexOf(desk)).includes(MARK), "桌面树没被改");
});

test("applyPatchesAllHosts：每棵树各自一份 report，status 都是 applied，path 指自己那棵", async () => {
  const { web, desk } = dual("report");
  const res = await core.applyPatchesAllHosts([P1], {});
  const wantPath = new Map([[norm(web), norm(indexOf(web))], [norm(desk), norm(indexOf(desk))]]);
  for (const host of res.hosts) {
    assert.equal(host.report.length, 1);
    // 单树 report 的键是 patch_id（不是 id），与 mergeApplyReports 的输出同名。
    assert.equal(host.report[0].patch_id, 1);
    assert.equal(host.report[0].status, "applied");
    assert.equal(norm(host.report[0].path), wantPath.get(norm(host.aiBase)), "报告的 path 不是这棵树上的文件");
    assert.deepEqual(host.summary.failed, []);
    assert.equal(host.summary.soft.length, 1);
    assert.equal(host.summary.soft[0].patch_id, 1);
    assert.equal(host.summary.soft[0].status, "applied");
  }
});

test("applyPatchesAllHosts：合并后的 report 一条补丁一行，path 只留第一棵树（现状）", async () => {
  const { web } = dual("merge");
  const res = await core.applyPatchesAllHosts([P1], {});
  assert.equal(res.report.length, 1);
  assert.equal(res.report[0].patch_id, 1);
  assert.equal(res.report[0].status, "applied");
  // 合并按 patch_id 归并，path 字段保留第一次遇到的那棵树 —— 多宿主下不足以定位是哪几棵。
  assert.equal(norm(res.report[0].path), norm(indexOf(web)));
});

test("applyPatchesAllHosts：onHost 按 index 1、2 报进度", async () => {
  const { web, desk } = dual("onhost");
  const seen = [];
  await core.applyPatchesAllHosts([P1], { onHost: (h) => seen.push(h) });
  assert.deepEqual(seen.map((h) => h.index), [1, 2]);
  assert.equal(norm(seen[0].aiBase), norm(web));
  assert.equal(norm(seen[1].aiBase), norm(desk));
});

test("applyPatchesAllHosts：onHost 抛错不能中断清洗", async () => {
  const { web, desk } = dual("onhost-throw");
  const res = await core.applyPatchesAllHosts([P1], {
    onHost: () => {
      throw new Error("进度回调炸了");
    },
  });
  assert.equal(res.hosts.length, 2);
  assert.ok(read(indexOf(web)).includes(MARK));
  assert.ok(read(indexOf(desk)).includes(MARK));
});

test("applyPatchesAllHosts：第二次跑全是 already，且文本不再变", async () => {
  const { web } = dual("second");
  await core.applyPatchesAllHosts([P1], {});
  const afterFirst = read(indexOf(web));
  const res = await core.applyPatchesAllHosts([P1], {});
  assert.deepEqual(res.hosts.map((h) => h.report[0].status), ["already", "already"]);
  assert.equal(read(indexOf(web)), afterFirst);
});

test("applyPatchesAllHosts：把调用方给的 settings 原样交给 selectPatches", async () => {
  const { web } = dual("pick");
  const settings = { hooksDenyBypass: true };
  const calls = [];
  const res = await core.applyPatchesAllHosts([P1], {
    hooksDeny: {
      settings,
      selectPatches: (patches, s) => {
        calls.push([patches, s]);
        return patches;
      },
    },
  });
  assert.equal(calls.length, 1, "每棵树都该选一次补丁");
  assert.equal(calls[0][0].length, 1);
  assert.equal(calls[0][0][0], P1);
  assert.equal(calls[0][1], settings);
  assert.equal(res.hosts.length, 2);
  assert.ok(read(indexOf(web)).includes(MARK));
});

test("applyPatchesAllHosts：hooksDenyBypass:false 才走反向还原，两个数组始终是数组", async () => {
  const bypassOn = dual("hookdeny-on");
  const on = await core.applyPatchesAllHosts([P1], { hooksDeny: { settings: { hooksDenyBypass: true } } });
  assert.deepEqual(on.hookDenyRestoreFailed, []);
  assert.deepEqual(on.hookDenyRestoreChanged, []);

  const off = dual("hookdeny-off");
  const res = await core.applyPatchesAllHosts([P1], {
    hooksDeny: { settings: { hooksDenyBypass: false }, selectPatches: hooksDeny.selectPatches },
  });
  assert.ok(Array.isArray(res.hookDenyRestoreFailed));
  assert.ok(Array.isArray(res.hookDenyRestoreChanged));
  // 沙箱树里没有 hooks 配置文件 → 没有可还原的文件，但补丁照样打上。
  assert.deepEqual(res.hookDenyRestoreChanged, []);
  assert.ok(read(indexOf(off.web)).includes(MARK));
  assert.ok(read(indexOf(bypassOn.web)).includes(MARK));
});

test("applyPatchesAllHosts：空补丁列表时两棵树都进表但 report 为空", async () => {
  // 不能真的造「零宿主」：那会让 findAiBaseWeb() 退到当前进程所在的树（本仓库），
  // 真把我们自己的 node_modules 打上补丁（实测过）。这里钉「没补丁可打」的形状。
  const { web } = dual("no-patches");
  const res = await core.applyPatchesAllHosts([], {});
  assert.equal(res.hosts.length, 2);
  for (const host of res.hosts) assert.deepEqual(host.report, []);
  assert.deepEqual(res.report, []);
  assert.equal(core.allPatchHostsWritten(res.hosts), false);
  assert.ok(read(indexOf(web)).includes(NEEDLE_A), "没补丁可打却改了文件");
});

test("applyPatchesAllHosts：同一棵桌面树写两遍（junction 别名）只打一次", async () => {
  const web = hostTree("alias-web");
  const { inst, base } = installTree("alias-inst");
  const alias = path.join(ROOT, "alias-link");
  fs.symlinkSync(inst, alias, "junction");
  process.env.DSH_BASE = web;
  // 分隔符是 path.delimiter（Windows ';'、POSIX ':'）—— 写死 ';' 在 Linux 上
  // 会把两个安装目录拼成一个不存在的路径，桌面树整棵消失（CI 红过一条）。
  process.env.DSH_DESKTOP_INSTALL = [inst, alias].join(path.delimiter);
  process.env.DSH_SURFACE = "web";
  core.resetPathMemo();
  const bases = core.enumeratePatchAiBases({ discover: false });
  assert.equal(bases.length, 2, "junction 别名没有去重：" + JSON.stringify(bases));
  const res = await core.applyPatchesAllHosts([P1], {});
  assert.equal(res.hosts.length, 2);
  const lowered = res.hosts.map((h) => norm(h.aiBase));
  assert.equal(new Set(lowered).size, 2);
  assert.equal(lowered.filter((b) => b === norm(base)).length, 1);
});

test("applyPatchesAllHosts：hooksDenyBypass:false 会把 hooks 里的旁路痕迹写回官方形态", async () => {
  const { web } = dual("hookdeny-restore");
  const hookFp = path.join(web, "dsh-hooks-claude-code", "lib", "index.js");
  put(hookFp, `// head\n${HOOK_REVERSE_FIND}\n// tail\n`);
  assert.deepEqual(core.hookDenyPaths(web).map(norm), [norm(hookFp)]);

  const on = await core.applyPatchesAllHosts([P1], {
    hooksDeny: { settings: { hooksDenyBypass: true }, selectPatches: hooksDeny.selectPatches },
  });
  assert.deepEqual(on.hookDenyRestoreChanged, []);
  assert.ok(read(hookFp).includes("deny_disabled"), "旁路开着时不该动 hooks 文件");

  const off = await core.applyPatchesAllHosts([P1], {
    hooksDeny: { settings: { hooksDenyBypass: false }, selectPatches: hooksDeny.selectPatches },
  });
  assert.deepEqual(off.hookDenyRestoreChanged.map(norm), [norm(hookFp)]);
  assert.equal(read(hookFp).includes("deny_disabled"), false);
  assert.ok(read(hookFp).includes('if (merged.decision === "deny") return { kind: "reject" };'));
});

test("applyPatchesAllHosts：还原不掉的哨兵进 hookDenyRestoreFailed，不静默吞掉", async () => {
  const { web } = dual("hookdeny-failed");
  const sentinelFp = path.join(web, "dsh-hooks-codex", "lib", "index.js");
  put(sentinelFp, `// keep\nconst stuck = "__dsh_purge_deny_disabled__";\n`);
  const res = await core.applyPatchesAllHosts([P1], {
    hooksDeny: { settings: { hooksDenyBypass: false }, selectPatches: hooksDeny.selectPatches },
  });
  assert.deepEqual(res.hookDenyRestoreFailed.map(norm), [norm(sentinelFp)]);
  assert.deepEqual(res.hookDenyRestoreChanged, []);
  assert.ok(read(sentinelFp).includes("__dsh_purge_deny_disabled__"), "还原不掉的文件必须保持原样");
});

// ── 安全纪律：绝不把仓库自己的 node_modules 当宿主 ──────────────────────
test("沙箱挂好后，宿主表里绝不能出现本仓库的 node_modules", () => {
  const { web, desk } = dual("safety");
  const bases = core.enumeratePatchAiBases({ discover: false }).map(norm);
  assert.deepEqual(bases, [norm(web), norm(desk)]);
  assert.equal(bases.includes(norm(REPO_TREE)), false, "会把仓库 devDependencies 当宿主打");
});

// ── revertAllHosts ──────────────────────────────────────────────────────
test("revertAllHosts：两棵树都回退，reverted 列出两个文件，errors 为空", async () => {
  const { web, desk } = dual("revert");
  await core.applyPatchesAllHosts([P1], {});
  const res = await core.revertAllHosts({ discover: false });
  assert.deepEqual(res.reverted.map(norm).sort(), [norm(indexOf(web)), norm(indexOf(desk))].sort());
  assert.deepEqual(res.errors, []);
});

test("revertAllHosts：回退后文本回到注入前（含 needle，不含标记）", async () => {
  const { web, desk } = dual("revert-text");
  await core.applyPatchesAllHosts([P1], {});
  assert.ok(read(indexOf(desk)).includes(MARK));
  await core.revertAllHosts({ discover: false });
  for (const fp of [indexOf(web), indexOf(desk)]) {
    assert.equal(read(fp).includes(MARK), false, fp + " 里的注入没撤干净");
    assert.ok(read(fp).includes(NEEDLE_A), fp + " 没回到原文");
  }
});

test("revertAllHosts：没打过补丁的树上跑一次，reverted 为空且不报错", async () => {
  const { web } = dual("revert-clean");
  const res = await core.revertAllHosts({ discover: false });
  assert.deepEqual(res.reverted, []);
  assert.deepEqual(res.errors, []);
  assert.ok(read(indexOf(web)).includes(NEEDLE_A));
});

test("revertAllHosts：单棵树的内部错误进 errors，另一棵照样回退", async () => {
  const { web, desk } = dual("revert-error");
  await core.applyPatchesAllHosts([P1], {});
  // 0 字节 bak 是备份中断留下的占位；revertAll 会把它改名成 .bad 并记一条 empty_backup。
  fs.writeFileSync(indexOf(web) + ".dshpurge.bak", "");
  const res = await core.revertAllHosts({ discover: false });
  assert.deepEqual(res.errors.map(([fp, e]) => [norm(fp), e]), [[norm(indexOf(web)), "empty_backup"]]);
  assert.ok(fs.existsSync(indexOf(web) + ".dshpurge.bak.bad"));
  // web 树保留注入（0 字节 bak 不能拿来覆盖），桌面树正常回退。
  assert.ok(read(indexOf(web)).includes(MARK));
  assert.equal(read(indexOf(desk)).includes(MARK), false);
  assert.ok(res.reverted.map(norm).includes(norm(indexOf(desk))));
});

// ── 源码形状：这两条路的「发现范围」开关 ────────────────────────────────
test("源码形状：apply 只在 forApply/discover 明确为 true 时做发现式探测，revert 默认做", () => {
  const src = read(path.join(REPO, "lib", "core.js"));
  const start = src.indexOf("export async function applyPatchesAllHosts(");
  const end = src.indexOf("export async function revertAllHosts(");
  assert.ok(start > 0 && end > start, "函数边界没找到");
  const body = src.slice(start, end);
  assert.ok(
    body.includes("enumeratePatchAiBases({ discover: options.forApply === true || options.discover === true })"),
    "apply 的发现开关被改了",
  );
  assert.ok(body.includes("const key = path.normalize(aiBase).replace(/\\\\/g, \"/\").toLowerCase();"), "去重键没有归一大小写/斜杠");
  assert.ok(body.includes("if (seen.has(key)) continue;"), "去重短路不见了");
  assert.ok(body.includes("if (typeof options.onHost === \"function\") {"), "进度回调的入口没了");

  const rstart = src.indexOf("export async function revertAllHosts(");
  const rbody = src.slice(rstart, src.indexOf("export function dshBaseEnvStatus(", rstart));
  // 回退默认做发现式探测（discover !== false），与 apply 相反 —— 刻意的：
  // 回退要尽量把漏掉的树也收回来；apply 则只在用户明说「应用到所有宿主」时才扫。
  assert.ok(rbody.includes("enumeratePatchAiBases({ discover: options.discover !== false })"), "revert 的发现开关被改了");
  assert.ok(rbody.includes("errors.push([aiBase, String(e && e.message ? e.message : e)])"), "单树异常没有进 errors");
});
