// lib/status-render.js 的回归测试。
//
// 这几十行是用户排查「补丁到底打上没有」时唯一看到的东西：状态页文案一旦
// 走样（数字对不上、漂移不显形、未适配没有警告），用户会以为一切都好。
// 所以这里逐行钉住，而不是只断言「返回了字符串」。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as core from "../lib/core.js";
import * as hostctl from "../lib/host.js";
import { fsExists, line, renderStatus } from "../lib/status-render.js";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-status-"));
const EXISTING = path.join(SANDBOX, "there.js");
fs.writeFileSync(EXISTING, "1\n", "utf8");
const MISSING = path.join(SANDBOX, "nope.js");

test.after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// 一份「最小可用」的 state：除非用例显式覆盖，渲染结果稳定。
function baseState(overrides = {}) {
  return {
    surface: "web",
    dsh_home: "/home/u/.dsh",
    desktop_install: null,
    ai_base: "/app/node_modules/@deepseek-ai",
    ai_base_scope: "desktop",
    files: { "agent-instructions": EXISTING },
    shim_dir: "/shim",
    desktop_runtimes: [],
    runtime_payload: null,
    has_backup: true,
    override_path: "/home/u/.dsh/prompt-inject.md",
    override_status: "ok",
    asar_still_sealed: false,
    display_patches: null,
    patch_status: {},
    host_version: "0.2.2-rc.1",
    host_supported: true,
    host_target: "0.2.2-rc.1",
    // P2-6b 安装真相：默认给一份「都读到了」的形状，缺口用例单独覆盖。
    hostIntegrity: {
      ok: true,
      unpackedMissing: [],
      unpackedMissingCount: 0,
      unpackedChecked: true,
      requireBuiltin: [],
      requireBuiltinCount: 0,
      nativeCount: 2,
      problems: [],
      reason: "",
    },
    lastInstall: { state: "ok", version: "1.1.101", at: "2026-11-20T10:00:00Z", previousVersion: "1.1.100", kind: "install", note: "" },
    slotLength: 4210,
    openSlotLength: 4096,
    profileVersion: "1.1.101",
    pluginVersion: "1.1.101",
    installTruth: { reasons: {}, resources: "/res", profile: "default" },
    shim_scope: "path",
    shim_cmd: "/shim/dsh.cmd",
    shim_ps1: "/shim/dsh.ps1",
    shim_bin: "/shim/dsh",
    ...overrides,
  };
}

function lines(state) {
  return renderStatus(state).split("\n");
}

function findLines(state, needle) {
  return lines(state).filter((l) => l.includes(needle));
}

// ---------- line() 的三种记号 ----------

test("line：ok 省略时用中性点，true 用勾，false 用叉", () => {
  assert.equal(line("标题", "值"), "· 标题: 值");
  assert.equal(line("标题", "值", true), "✓ 标题: 值");
  assert.equal(line("标题", "值", false), "✗ 标题: 值");
});

test("line：ok 只认 null 为「省略」，undefined 也会被当成假值打叉", () => {
  // ok = null 是默认参数，显式传 undefined 会走默认值 → 中性点。
  assert.equal(line("a", "b", undefined), "· a: b");
  // 0 / "" / NaN 都是假值 → 打叉，这是 status 里 !!state.shim_dir 能工作的原因。
  assert.equal(line("a", "b", 0), "✗ a: b");
  assert.equal(line("a", "b", ""), "✗ a: b");
});

// ---------- fsExists() ----------

test("fsExists：真实存在的文件为真，不存在为假", () => {
  assert.equal(fsExists(EXISTING), true);
  assert.equal(fsExists(MISSING), false);
});

test("fsExists：任一命中即为真（多落点只要求有一个在）", () => {
  assert.equal(fsExists([MISSING, EXISTING]), true);
  assert.equal(fsExists([MISSING, MISSING]), false);
});

test("fsExists：非字符串与空值一律当不存在，不抛", () => {
  assert.equal(fsExists(null), false);
  assert.equal(fsExists(""), false);
  assert.equal(fsExists(123), false);
  assert.equal(fsExists([]), false);
  assert.equal(fsExists([null, "", 0]), false);
});

test("fsExists：路径里有非法字符时被 try 兜住，不把状态页带崩", () => {
  // Windows 上 \0 会让 existsSync 抛，Linux 上返回 false；两种都要活下来。
  assert.equal(fsExists(path.join(SANDBOX, "a\0b")), false);
});

test("源码形状：fsExists 保留了「非字符串直接判否」这道冗余守卫", () => {
  // 这道守卫在外部行为上与 try/catch 等价（任何非字符串喂进 existsSync 都会抛，
  // 抛了就被 catch 成 false），删掉不会让任何用例变红 —— 只能读源码钉。
  // 留着它的理由是省一次异常构造：状态页每行最多 3 个落点，异常路径不便宜。
  const src = fs.readFileSync(path.resolve("lib/status-render.js"), "utf8");
  assert.match(src, /if \(!p \|\| typeof p !== "string"\) return false;/);
});

// ---------- renderStatus 的骨架 ----------

test("首行是固定标题，第二行是宿主面", () => {
  const out = lines(baseState());
  assert.equal(out[0], "dsh-purge 状态 / Status");
  assert.equal(out[1], "· 宿主 / surface: web");
});

test("surface 为空时回落到当前宿主面，而不是留空", () => {
  const out = lines(baseState({ surface: "" }));
  assert.equal(out[1], `· 宿主 / surface: ${hostctl.currentSurface()}`);
});

test("desktop_install 只在存在时出现", () => {
  assert.equal(findLines(baseState(), "桌面安装 / desktop").length, 0);
  assert.deepEqual(findLines(baseState({ desktop_install: "C:/Program Files/DeepSeek" }), "桌面安装 / desktop"), [
    "· 桌面安装 / desktop: C:/Program Files/DeepSeek",
  ]);
});

// ---------- 插件根 ----------

test("插件根有值：正常打印，且不给 foreign 警告", () => {
  const out = findLines(baseState(), "插件根 / plugin root");
  assert.deepEqual(out, ["· 插件根 / plugin root: /app/node_modules/@deepseek-ai"]);
  assert.equal(findLines(baseState(), "这份补丁根不在桌面安装目录里").length, 0);
});

test("插件根是 foreign 时必须警告桌面端改了不生效", () => {
  const out = findLines(baseState({ ai_base_scope: "foreign" }), "不在桌面安装目录里");
  assert.equal(out.length, 1);
  assert.match(out[0], /桌面端改了不会生效/);
});

test("插件根缺失：改说「找不到」，并且打叉", () => {
  const out = findLines(baseState({ ai_base: "" }), "插件根 / plugin root");
  assert.equal(out.length, 1);
  assert.ok(out[0].startsWith("✗ 插件根 / plugin root: "));
  // 文案来自 core.missingAiBaseMessage()，这里不重复断言它的内容，只确认接到了。
  assert.ok(out[0].includes(core.missingAiBaseMessage()));
});

test("文件清单：存在打勾、不存在打叉，键名补空格对齐", () => {
  // 列宽 22 是状态页对齐的唯一来源，这里写死空格数而不是拼 padEnd(22)——
  // 拼出来的期望值会跟着实现一起变，改窄了也测不出错位。
  const out = findLines(baseState({ files: { "agent-instructions": EXISTING, "dsh-tools": MISSING } }), "agent-instructions");
  assert.equal(out.length, 1);
  assert.match(out[0], /^ {4}✓ agent-instructions {5}\S/);
  assert.ok(out[0].endsWith(EXISTING));
  const miss = findLines(baseState({ files: { "dsh-tools": MISSING } }), "dsh-tools");
  assert.match(miss[0], /^ {4}✗ dsh-tools {14}\S/);
  assert.ok(miss[0].endsWith(MISSING));
});

test("文件清单：一个键有多个落点时只显示第一个并标注 +N", () => {
  const out = findLines(baseState({ files: { tools: [EXISTING, MISSING, MISSING] } }), "tools");
  assert.match(out[0], /^ {4}✓ tools {18}\S/);
  assert.ok(out[0].endsWith(`(+2)`));
});

test("文件清单：落点为空串时显示空，不显示 undefined", () => {
  const out = findLines(baseState({ files: { solo: "" } }), "solo");
  assert.equal(out[0].endsWith(" solo                     ".trimEnd()), false);
  assert.ok(out[0].includes("✗ solo"));
  assert.ok(!out[0].includes("undefined"));
});

// ---------- shim 与桌面 runtime ----------

test("shim 目录缺失时打叉并写明未定位", () => {
  assert.deepEqual(findLines(baseState({ shim_dir: "" }), "shim 目录"), ["✗ shim 目录: 未定位 / not found"]);
});

test("桌面 runtime 目录逐个列出，不折叠", () => {
  const out = lines(baseState({ desktop_runtimes: ["/r1", "/r2"] }));
  assert.ok(out.includes("✓ Desktop runtime: 2 sealed (shim OK; bak external)"));
  assert.ok(out.includes("    · /r1"));
  assert.ok(out.includes("    · /r2"));
});

test("桌面 runtime 为空时不出现这一节", () => {
  assert.equal(findLines(baseState(), "Desktop runtime").length, 0);
});

// ---------- runtime 负载三分支 ----------

test("runtime 负载就位：报可用", () => {
  assert.deepEqual(
    findLines(baseState({ runtime_payload: { ok: true } }), "runtime 负载 / payload"),
    ["✓ runtime 负载 / payload: node + pnpm 就位（插件市场可用）"],
  );
});

test("runtime 负载定位不到 resources 时是中性的「不知道」，不是失败", () => {
  assert.deepEqual(
    findLines(baseState({ runtime_payload: { ok: false, reason: "no_resources" } }), "runtime 负载 / payload"),
    ["· runtime 负载 / payload: 无法定位 resources 目录"],
  );
});

test("runtime 负载缺失：列出缺什么并给修复指引", () => {
  const out = lines(baseState({ runtime_payload: { ok: false, missing: ["node", "pnpm"] } }));
  assert.ok(out.includes("✗ runtime 负载 / payload: 缺失 → 插件安装会 MODULE_NOT_FOUND：node, pnpm"));
  assert.ok(out.some((l) => l.includes("修复：点「应用」或重启一次")));
});

test("runtime 负载没有 missing 列表时退回 error 文案，再退回 unknown", () => {
  assert.ok(lines(baseState({ runtime_payload: { ok: false, error: "boom" } }))
    .includes("✗ runtime 负载 / payload: 缺失 → 插件安装会 MODULE_NOT_FOUND：boom"));
  assert.ok(lines(baseState({ runtime_payload: { ok: false } }))
    .includes("✗ runtime 负载 / payload: 缺失 → 插件安装会 MODULE_NOT_FOUND：unknown"));
});

test("runtime 负载为空数组时按 error/unknown 走，不是「就位」", () => {
  assert.ok(lines(baseState({ runtime_payload: { ok: false, missing: [] } }))
    .includes("✗ runtime 负载 / payload: 缺失 → 插件安装会 MODULE_NOT_FOUND：unknown"));
});

// ---------- 备份 / 注入 / asar ----------

test("备份有无直接写汉字与记号", () => {
  assert.ok(lines(baseState()).includes("✓ 备份 / backup: 有 / yes"));
  assert.ok(lines(baseState({ has_backup: false })).includes("✗ 备份 / backup: 无 / no"));
});

test("注入文件与状态各占一行", () => {
  const out = lines(baseState());
  assert.ok(out.includes("· 注入文件 / inject: /home/u/.dsh/prompt-inject.md"));
  assert.ok(out.includes("· 注入状态 / override: ok"));
});

test("app.asar 仍密封时必须显形（否则用户以为补丁生效了）", () => {
  assert.ok(lines(baseState({ asar_still_sealed: true }))
    .includes("✗ app.asar: 还在。补丁写在解开目录，当前进程读不到"));
  assert.equal(findLines(baseState(), "app.asar").length, 0);
});

// ---------- 补丁汇总 ----------

test("补丁汇总行：applied/total，且只在有值时才附 skipped 与 drifted 说明", () => {
  const rows = [
    { id: 1, status: "applied" },
    { id: 2, status: "already" },
    { id: 3, status: "pending" },
  ];
  assert.ok(lines(baseState({ display_patches: rows })).includes("补丁 / patches: 2/3 applied, 1 pending"));

  const withSkip = rows.concat([{ id: 4, status: "skipped" }]);
  assert.ok(lines(baseState({ display_patches: withSkip }))
    .includes("补丁 / patches: 2/4 applied, 1 skipped（不适用/自标记，不计入 applied）, 1 pending"));

  const withDrift = rows.concat([{ id: 5, status: "drifted" }]);
  assert.ok(lines(baseState({ display_patches: withDrift }))
    .includes("补丁 / patches: 2/4 applied, 1 pending, 1 drifted（官方原文已改，需更新 pattern）"));
});

test("补丁汇总：空列表报 0/0，不是 NaN", () => {
  assert.ok(lines(baseState({ display_patches: [] })).includes("补丁 / patches: 0/0 applied, 0 pending"));
});

test("补丁明细行：四种状态四种记号，名字与层级取自补丁注册表", () => {
  const rows = [
    { id: 1, status: "applied" },
    { id: 3, status: "pending" },
    { id: 2, status: "drifted" },
    { id: 4, status: "skipped" },
  ];
  const out = lines(baseState({ display_patches: rows }));
  // 列宽（id 2、名字 30）写字面量，不用 padEnd 拼期望值。
  assert.ok(out.includes("  ✓ [#1 ] WORKSPACE_CONTEXT_INTRO        提示词/Prompt — applied"));
  assert.ok(out.includes("  ✗ [#3 ] SCOPE_INTRO                    提示词/Prompt — pending"));
  assert.ok(out.includes("  ! [#2 ] REPLACEMENT_WORKSPACE_CONTEXT_INTRO 提示词/Prompt — drifted"));
  assert.ok(out.includes("  · [#4 ] SYSTEM_PROMPT_PERSONA          提示词/Prompt — skipped"));
});

test("补丁明细行：注册表里没有的 id 用 patch-N 与行自带的 layer 兜底", () => {
  const out = lines(baseState({ display_patches: [{ id: 9999, status: "applied", layer: "自定义" }] }));
  assert.ok(out.some((l) => l.includes("patch-9999") && l.includes("自定义") && l.includes("— applied")));
});

test("补丁明细行：没有 status 时显示 n/a 并用中性记号", () => {
  assert.ok(lines(baseState({ display_patches: [{ id: 1 }] })).some((l) => l.endsWith("— n/a") && l.includes("  · [#1 ]")));
});

test("没给 display_patches 时按 patch_status 现算分组，且不显示未适配的补丁", () => {
  // 只给 #1 一个 applied：分组后只剩一条，且 total 是 1 而不是 86。
  const out = lines(baseState({ patch_status: { 1: "applied" } }));
  const tally = out.find((l) => l.startsWith("补丁 / patches: "));
  assert.equal(tally, "补丁 / patches: 1/1 applied, 0 pending");
});

// ---------- 宿主版本 ----------

test("宿主版本已适配：不加任何警告", () => {
  assert.ok(lines(baseState()).includes("宿主 / host: 0.2.2-rc.1"));
});

test("宿主版本未适配：点名插件声明的是哪个版本", () => {
  assert.ok(lines(baseState({ host_supported: false, host_target: "0.2.1-rc.5" }))
    .includes("宿主 / host: 0.2.2-rc.1  ← 未适配：插件声明 0.2.1-rc.5"));
});

test("宿主版本未适配且没有声明版本：用问号占位，不留空", () => {
  assert.ok(lines(baseState({ host_supported: false, host_target: "" }))
    .includes("宿主 / host: 0.2.2-rc.1  ← 未适配：插件声明 ?"));
});

test("拿不到宿主版本时整行不出现（不写「未知版本」这种噪音）", () => {
  assert.equal(findLines(baseState({ host_version: "" }), "宿主 / host").length, 0);
});


// ---------- 安装真相（P2-6b） ----------

test("安装真相：宿主行之后紧跟宿主体检、最近安装、profile 版本与 SLOT 长度", () => {
  const out = lines(baseState());
  const hostAt = out.findIndex((l) => l.startsWith("宿主 / host: "));
  assert.ok(hostAt > 0, "宿主行必须存在");
  assert.equal(out[hostAt + 1], "✓ 宿主体检 / host integrity: ok（unpacked 已校验，原生绑定 2 个）");
  assert.ok(out[hostAt + 2].startsWith("✓ 最近安装 / last install: ok install 1.1.101（此前 1.1.100）"));
  assert.equal(out[hostAt + 3], "✓ profile 版本 / profile vs plugin: 1.1.101（一致）");
  assert.equal(out[hostAt + 4], "✓ SLOT 长度 / slot length: 4210（未打补丁侧 4096）");
});

test("安装真相：宿主体检 ok=false 时打叉、写明缺口原因，并列出缺失项", () => {
  const out = lines(baseState({
    hostIntegrity: {
      ok: false,
      unpackedMissing: ["client.js"],
      unpackedMissingCount: 1,
      unpackedChecked: false,
      requireBuiltin: ["electron"],
      requireBuiltinCount: 1,
      nativeCount: 0,
      problems: ["unpacked 缺 1 个"],
      reason: "unpacked_missing",
    },
  }));
  const head = out.find((l) => l.includes("宿主体检 / host integrity"));
  assert.ok(head.startsWith("✗ "), head);
  assert.match(head, /有缺口 → unpacked 缺 1 个/);
  assert.ok(out.includes("    缺 unpacked: 1 项"));
  assert.ok(out.includes("    缺 unpacked 明细: client.js"));
  assert.ok(out.includes("    缺 require 内建: electron"));
});

test("安装真相：读不到时不许写 ok —— 体检、最近安装、profile 版本、SLOT 长度各自显形", () => {
  const out = lines(baseState({
    hostIntegrity: null,
    lastInstall: null,
    slotLength: null,
    openSlotLength: null,
    profileVersion: "",
    installTruth: { reasons: { host: "宿主目录没找到", lastInstall: "无 journal", slot: "SLOT 段没找到", profileVersion: "profile 未生成" } },
  }));
  for (const needle of ["宿主体检 / host integrity", "最近安装 / last install", "profile 版本 / profile vs plugin", "SLOT 长度 / slot length"]) {
    const row = out.find((l) => l.includes(needle));
    assert.ok(row, needle + " 必须出现");
    assert.ok(row.startsWith("✗ "), needle + " 读不到时必须打叉：" + row);
    assert.match(row, /读不到/, needle + " 必须说读不到：" + row);
  }
  assert.match(out.find((l) => l.includes("宿主体检 / host integrity")), /宿主目录没找到/);
  assert.match(out.find((l) => l.includes("最近安装 / last install")), /无 journal/);
  assert.match(out.find((l) => l.includes("SLOT 长度 / slot length")), /SLOT 段没找到/);
  // null 不许被渲染成 0
  assert.ok(!out.some((l) => l.startsWith("✓ SLOT 长度 / slot length")));
});

test("安装真相：profile 版本与插件版本不一致时两个值都写出来", () => {
  const row = lines(baseState({ profileVersion: "1.1.99" })).find((l) => l.includes("profile 版本 / profile vs plugin"));
  assert.equal(row, "✗ profile 版本 / profile vs plugin: 1.1.99 ≠ 插件 1.1.101 ← 不一致，重跑一次「应用」");
});

test("安装真相：最近安装失败时打叉，state 未知时用中性点", () => {
  const failed = lines(baseState({ lastInstall: { state: "failed", version: "1.1.101", at: "", previousVersion: "", kind: "install", note: "copy 失败" } }))
    .find((l) => l.includes("最近安装 / last install"));
  assert.ok(failed.startsWith("✗ "), failed);
  assert.match(failed, /copy 失败/);
  const odd = lines(baseState({ lastInstall: { state: "pending", version: "1.1.101", at: "", previousVersion: "1.1.101", kind: "", note: "" } }))
    .find((l) => l.includes("最近安装 / last install"));
  assert.ok(odd.startsWith("· "), odd);
  // previousVersion 与 version 相同不写「此前」
  assert.ok(!odd.includes("此前"));
});

test("安装真相：lastInstall state=done 算成功、rolled-back 算失败，pending 保持中性", () => {
  const done = lines(baseState({ lastInstall: { state: "done", version: "1.1.101", at: "", previousVersion: "", kind: "install", note: "" } }))
    .find((l) => l.includes("最近安装 / last install"));
  assert.ok(done.startsWith("✓ "), done);
  const rolled = lines(baseState({ lastInstall: { state: "rolled-back", version: "1.1.101", at: "", previousVersion: "", kind: "install", note: "回滚完成" } }))
    .find((l) => l.includes("最近安装 / last install"));
  assert.ok(rolled.startsWith("✗ "), rolled);
  assert.match(rolled, /回滚完成/);
});

// ---------- 尾部 shim 行 ----------

test("shim 行按 scope 附不同说明：desktop-cli / path / 其他", () => {
  assert.ok(lines(baseState({ shim_scope: "desktop-cli" }))
    .some((l) => l.startsWith("shim: dsh.cmd=/shim/dsh.cmd") && l.includes("（桌面自带 runtime\\cli\\bin）")));
  assert.ok(lines(baseState({ shim_scope: "path" }))
    .some((l) => l.includes("（PATH 上的 dsh 启动器；本版安装包不再下发 runtime\\cli\\bin）")));
  assert.ok(lines(baseState({ shim_scope: "other" }))
    .some((l) => l === "shim: dsh.cmd=/shim/dsh.cmd  dsh.ps1=/shim/dsh.ps1  dsh=/shim/dsh"));
});

// ---------- 结构 ----------

test("补丁段与 shim 段各有一个空行分隔，末尾没有多余空行", () => {
  const out = lines(baseState());
  const patchAt = out.findIndex((l) => l.startsWith("补丁 / patches: "));
  assert.equal(out[patchAt - 1], "");
  const shimAt = out.findIndex((l) => l.startsWith("shim: dsh.cmd="));
  assert.equal(out[shimAt - 1], "");
  assert.equal(out[out.length - 1], out[shimAt]);
});

test("渲染是纯函数：同一 state 连调两次结果一致，且不修改传入对象", () => {
  const state = baseState();
  const snapshot = JSON.stringify(state);
  assert.equal(renderStatus(state), renderStatus(state));
  assert.equal(JSON.stringify(state), snapshot);
});
