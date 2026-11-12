// /purge 命令的六个分支：status / apply / revert / uninstall / edit / help。
//
// 这一层是唯一一条「一条命令写穿宿主」的入口，所以每条分支都要连输出文案一起钉住：
// apply 的四种收尾（重启 / 取消重启 / 报错 / 已是最新）、revert 的三种行
// （reverted / 失败 / 没有备份）、uninstall 的 applied 与 not-applied 两种开场白。
// 全部依赖按 deps 传入，不碰真宿主、不读写盘。

import test from "node:test";
import assert from "node:assert/strict";
import { handlePurgeCommand } from "../lib/chat-purge.js";

const PATCHES = [{ id: 1, name: "ONE" }];

function stateOf(over = {}) {
  return { dsh_home: "/home/u/.dsh", ai_base: "/ai/base", ...over };
}

function fakeCore(over = {}) {
  const calls = { order: [] };
  const mark = (name) => calls.order.push(name);
  const core = {
    ALL_PATCHES: PATCHES,
    gatherState: async () => {
      mark("gatherState");
      return stateOf();
    },
    applyRuntimeEnv: () => mark("applyRuntimeEnv"),
    clearDesktopLocateCache: () => mark("clearDesktopLocateCache"),
    pinDshHome: () => "/home/u/.dsh",
    sanitizeDesktopCommandRuntimes: () => [],
    resolveOfficialAiBase: async () => ({ aiBase: "/ai/base" }),
    missingAiBaseMessage: () => "找不到宿主目录",
    writeUnpackedAsarStamp: () => mark("writeUnpackedAsarStamp"),
    applyPatchesAllHosts: async () => {
      mark("applyPatchesAllHosts");
      return {
        report: [{ patch_id: 1, name: "ONE", status: "applied" }],
        hosts: [{ aiBase: "/ai/base" }],
      };
    },
    patchAllShims: async () => ({ "npm-global": "ok" }),
    silenceCmdFlash: () => ({ entry: "kept", phase1: "wrote", ok: true }),
    summarizeApplyReport: () => ({ failed: [], soft: [], applied: 1, already: 0 }),
    allPatchHostsWritten: () => true,
    hostCleanMarkersPresent: () => true,
    desktopAsarStillSealed: () => false,
    seedPromptInjectAtBoot: () => ({ action: "seed" }),
    revertAll: async () => ({ reverted: ["lib/a.js"], errors: [] }),
    revertAllShims: async () => ({ "npm-global": "reverted" }),
    editOverride: () => ({ ok: true, path: "/home/u/.dsh/prompt-inject.md", editor: "notepad" }),
    installOverride: async () => ({ ok: true }),
    ...over,
  };
  return { core, calls };
}

function depsOf(over = {}) {
  const { core, calls } = fakeCore(over.core);
  const seen = { restartArgs: [] };
  const deps = {
    core,
    uninstaller: over.uninstaller || { uninstallPurge: async () => ({ ok: true, applied: true }) },
    reapply: over.reapply || { markSettleRestart: () => calls.order.push("markSettleRestart") },
    renderStatus: over.renderStatus || ((s) => `RENDERED:${s.ai_base}`),
    rejectIfNeedPrompt: over.rejectIfNeedPrompt || (() => null),
    refreshHungOperator: over.refreshHungOperator || (() => calls.order.push("refreshHungOperator")),
    applyShouldRestart: over.applyShouldRestart || (() => false),
    scheduleApplyRestart: (should, ctx) => {
      seen.restartArgs.push({ should, ctx });
      return over.plan ? over.plan : { restarting: false };
    },
  };
  return { deps, calls, seen };
}

// ---------- status ----------

test("/purge 无参数默认走 status，用 renderStatus 排版", async () => {
  const { deps } = depsOf();
  const out = await handlePurgeCommand("", {}, null, deps);
  assert.equal(out.kind, "success");
  assert.equal(out.text, "RENDERED:/ai/base");
});

test("/purge status 与别名 s 走同一分支", async () => {
  for (const input of ["status", "s", "  S  "]) {
    const { deps } = depsOf();
    const out = await handlePurgeCommand(input, {}, null, deps);
    assert.equal(out.text, "RENDERED:/ai/base", input);
  }
});

// ---------- apply ----------

test("/purge apply 成功：列出宿主、补丁行、shim 与 cmd-flash", async () => {
  const { deps, calls } = depsOf();
  const out = await handlePurgeCommand("apply", {}, null, deps);
  assert.equal(out.kind, "success");
  assert.match(out.text, /宿主 \/ host → \/ai\/base/);
  assert.match(out.text, /✓ 已清洗 patch #1 {2}ONE/);
  assert.match(out.text, /shim:/);
  assert.match(out.text, /· npm-global → ok/);
  assert.match(out.text, /cmd-flash=kept phase-1=wrote ok=true/);
  assert.match(out.text, /补丁已经在宿主里，不再重启。$/);
  assert.deepEqual(calls.order.slice(0, 3), ["applyRuntimeEnv", "clearDesktopLocateCache", "gatherState"]);
  assert.ok(calls.order.includes("applyPatchesAllHosts"));
  assert.ok(calls.order.includes("refreshHungOperator"));
});

test("/purge apply 的补丁行按状态换记号：already 打 -, missing_file 打 ⚠, 其他打 ✗ 带原文", async () => {
  const { deps } = depsOf({
    core: {
      applyPatchesAllHosts: async () => ({
        report: [
          { patch_id: 1, name: "A", status: "applied" },
          { patch_id: 2, name: "B", status: "already" },
          { patch_id: 3, name: "C", status: "missing_file" },
          { patch_id: 4, name: "D", status: "drifted" },
        ],
        hosts: [{ aiBase: "/ai/base" }],
      }),
      summarizeApplyReport: () => ({ failed: [], soft: [], applied: 1, already: 1 }),
    },
  });
  const out = await handlePurgeCommand("a", {}, null, deps);
  assert.match(out.text, /✓ 已清洗 patch #1 {2}A/);
  assert.match(out.text, /- 已是最新 patch #2 {2}B/);
  assert.match(out.text, /⚠ 文件缺失 patch #3 {2}C/);
  assert.match(out.text, /✗ drifted patch #4 {2}D/);
});

test("/purge apply 解析宿主抛错时直接回 error 并把 message 抄出来", async () => {
  const { deps, calls } = depsOf({
    core: {
      resolveOfficialAiBase: async () => {
        throw new Error("asar 解不开");
      },
    },
  });
  const out = await handlePurgeCommand("apply", {}, null, deps);
  assert.equal(out.kind, "error");
  assert.equal(out.text, "asar 解不开");
  assert.ok(!calls.order.includes("applyPatchesAllHosts"));
});

test("/purge apply 拿不到 aiBase 时回 missingAiBaseMessage", async () => {
  const { deps } = depsOf({ core: { resolveOfficialAiBase: async () => ({ aiBase: null }) } });
  const out = await handlePurgeCommand("apply", {}, null, deps);
  assert.equal(out.kind, "error");
  assert.equal(out.text, "找不到宿主目录");
});

test("/purge apply 解包出 asar 时写 unpacked 戳", async () => {
  const { deps, calls } = depsOf({
    core: {
      resolveOfficialAiBase: async () => ({ aiBase: "/ai/base", extracted: true, handoff: { archive: "/tmp/x.asar" } }),
    },
  });
  await handlePurgeCommand("apply", {}, null, deps);
  assert.ok(calls.order.includes("writeUnpackedAsarStamp"));
});

test("/purge apply 被空提示词闸门挡住时不打补丁", async () => {
  const { deps, calls } = depsOf({ rejectIfNeedPrompt: () => ({ needPrompt: true, error: "提示词和规则集都是空的，必须先添加提示词" }) });
  const out = await handlePurgeCommand("apply", {}, null, deps);
  assert.equal(out.kind, "error");
  assert.equal(out.text, "提示词和规则集都是空的，必须先添加提示词");
  assert.ok(!calls.order.includes("applyPatchesAllHosts"));
  assert.ok(!calls.order.includes("refreshHungOperator"));
});

test("/purge apply 有被 scrub 的 bak 时多一段 Desktop in-bin .bak scrub", async () => {
  const { deps } = depsOf({
    core: { sanitizeDesktopCommandRuntimes: () => [{ dir: "binA", cleaned: [".bak1", ".bak2"] }] },
  });
  const out = await handlePurgeCommand("apply", {}, null, deps);
  assert.match(out.text, /Desktop in-bin \.bak scrub:/);
  assert.match(out.text, /✓ binA → \.bak1, \.bak2/);
});

test("/purge apply 收尾四种：取消重启 / 报错 / 正在重启 / 没有完成", async () => {
  // 1) clean === false
  {
    const { deps } = depsOf({ applyShouldRestart: () => true, plan: { clean: false } });
    const out = await handlePurgeCommand("apply", {}, null, deps);
    assert.match(out.text, /清洗没有写进当前宿主，已取消重启。$/);
  }
  // 2) restarting === false && error
  {
    const { deps } = depsOf({ applyShouldRestart: () => true, plan: { restarting: false, error: "端口被占" } });
    const out = await handlePurgeCommand("apply", {}, null, deps);
    assert.match(out.text, /端口被占$/);
  }
  // 3) 真要重启
  {
    const { deps } = depsOf({ applyShouldRestart: () => true, plan: { restarting: true } });
    const out = await handlePurgeCommand("apply", {}, null, deps);
    assert.match(out.text, /正在重启。$/);
  }
  // 4) 清洗没完成，也没重启
  {
    const { deps } = depsOf({
      core: {
        summarizeApplyReport: () => ({ failed: [{ status: "drifted" }], soft: [], applied: 0, already: 0 }),
        allPatchHostsWritten: () => false,
        hostCleanMarkersPresent: () => false,
      },
    });
    const out = await handlePurgeCommand("apply", {}, null, deps);
    assert.match(out.text, /清洗没有完成，没有重启。$/);
  }
});

test("/purge apply 只有 pattern_not_found 且宿主已写时仍然请求重启（promptReady 分支）", async () => {
  const seen = [];
  const { deps } = depsOf({
    core: {
      summarizeApplyReport: () => ({ failed: [{ status: "pattern_not_found" }], soft: [], applied: 0, already: 0 }),
      allPatchHostsWritten: () => true,
    },
    applyShouldRestart: (args) => {
      seen.push(args);
      return args.complete === true;
    },
    plan: { restarting: true },
  });
  const out = await handlePurgeCommand("apply", {}, null, deps);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].complete, true);
  assert.equal(seen[0].promptReady, true);
  assert.match(out.text, /正在重启。$/);
});

test("/purge apply 需要重启时先 markSettleRestart", async () => {
  const { deps, calls } = depsOf({ applyShouldRestart: () => true, plan: { restarting: true } });
  await handlePurgeCommand("apply", {}, null, deps);
  assert.ok(calls.order.includes("markSettleRestart"));
});

test("/purge apply 的 hookDenyRestoreFailed 非空时不算 complete", async () => {
  const seen = [];
  const { deps } = depsOf({
    core: {
      applyPatchesAllHosts: async () => ({
        report: [{ patch_id: 1, name: "ONE", status: "applied" }],
        hosts: [{ aiBase: "/ai/base" }],
        hookDenyRestoreFailed: ["x"],
      }),
    },
    applyShouldRestart: (args) => {
      seen.push(args);
      return false;
    },
  });
  const out = await handlePurgeCommand("apply", {}, null, deps);
  assert.equal(seen[0].complete, false);
  assert.match(out.text, /清洗没有完成，没有重启。$/);
});

test("/purge apply 打补丁时必须 preserveClientBundles:false 且 forApply:true（否则 client.js 上的补丁只统计不写盘）", async () => {
  let seen = null;
  const { deps } = depsOf({
    core: {
      applyPatchesAllHosts: async (_patches, opts) => {
        seen = opts;
        return { report: [{ patch_id: 1, name: "ONE", status: "applied" }], hosts: [{ aiBase: "/ai/base" }] };
      },
    },
  });
  await handlePurgeCommand("apply", {}, null, deps);
  assert.deepEqual(seen, { preserveClientBundles: false, forApply: true });
});

test("/purge apply 的 promptReady 只认 pattern_not_found，混杂 drifted 时不算就绪", async () => {
  const seen = [];
  const { deps } = depsOf({
    core: {
      summarizeApplyReport: () => ({ failed: [{ status: "drifted" }], soft: [], applied: 0, already: 0 }),
      allPatchHostsWritten: () => true,
      hostCleanMarkersPresent: () => true,
    },
    applyShouldRestart: (args) => {
      seen.push(args);
      return false;
    },
  });
  await handlePurgeCommand("apply", {}, null, deps);
  assert.equal(seen[0].complete, false, "drifted 不是 promptReady，complete 必须为 false");
  assert.equal(seen[0].promptReady, false);
});

test("/purge apply 的 hostWritten 也认 hostCleanMarkersPresent（allPatchHostsWritten 为 false 时仍算写过）", async () => {
  const seen = [];
  const { deps } = depsOf({
    core: {
      allPatchHostsWritten: () => false,
      hostCleanMarkersPresent: () => true,
    },
    applyShouldRestart: (args) => {
      seen.push(args);
      return false;
    },
  });
  const out = await handlePurgeCommand("apply", {}, null, deps);
  assert.equal(seen[0].complete, true);
  assert.match(out.text, /补丁已经在宿主里，不再重启。$/);
});

test("/purge apply 把 ctx 透给 scheduleApplyRestart", async () => {
  const ctx = { id: "ctx-1" };
  const { deps, seen } = depsOf({ applyShouldRestart: () => true, plan: { restarting: true } });
  await handlePurgeCommand("apply", {}, ctx, deps);
  assert.equal(seen.restartArgs.length, 1);
  assert.equal(seen.restartArgs[0].ctx, ctx);
});

test("/purge apply 的 shim 行对对象状态走 JSON.stringify，对字符串原样", async () => {
  const { deps } = depsOf({
    core: { patchAllShims: async () => ({ a: { ok: true, wrote: 2 }, b: "raw", c: 7 }) },
  });
  const out = await handlePurgeCommand("apply", {}, null, deps);
  assert.match(out.text, /· a → \{"ok":true,"wrote":2\}/);
  assert.match(out.text, /· b → raw/);
  assert.match(out.text, /· c → 7/);
});

// ---------- revert ----------

test("/purge revert 列出还原结果与失败行", async () => {
  const { deps } = depsOf({
    core: {
      revertAll: async () => ({ reverted: ["lib/a.js", "lib/b.js"], errors: [["lib/c.js", "EACCES"]] }),
    },
  });
  const out = await handlePurgeCommand("revert", {}, null, deps);
  assert.equal(out.kind, "success");
  assert.match(out.text, /✓ 已还原 \/ Reverted lib\/a\.js/);
  assert.match(out.text, /✓ 已还原 \/ Reverted lib\/b\.js/);
  assert.match(out.text, /⚠ 还原失败 lib\/c\.js: EACCES/);
  assert.match(out.text, /回滚完成 \/ Revert done/);
  assert.match(out.text, /prompt-inject\.md 保留（用户文件）/);
});

test("/purge revert 没有备份时说明一句，shim 行仍照列", async () => {
  const { deps } = depsOf({
    core: {
      revertAll: async () => ({ reverted: [], errors: [] }),
      revertAllShims: async () => ({ "npm-global": { ok: true } }),
    },
  });
  const out = await handlePurgeCommand("r", {}, null, deps);
  assert.match(out.text, /- 没有补丁备份可还原 \/ no patch backup/);
  assert.match(out.text, /shim npm-global: \{"ok":true\}/);
});

test("/purge revert 在没有 ai_base 时跳过还原段", async () => {
  const { deps } = depsOf({
    core: {
      gatherState: async () => stateOf({ ai_base: "" }),
      revertAll: async () => {
        throw new Error("不该被调用");
      },
    },
  });
  const out = await handlePurgeCommand("revert", {}, null, deps);
  assert.equal(out.kind, "success");
  assert.doesNotMatch(out.text, /已还原/);
});

// ---------- uninstall ----------

test("/purge uninstall 已应用：开场白说检测到补丁，并列出还原数、override、profile、错误", async () => {
  const { deps } = depsOf({
    uninstaller: {
      uninstallPurge: async () => ({
        ok: true,
        applied: true,
        patches: { reverted: ["a", "b"] },
        override: { removed: true, path: "/home/u/.dsh/override.json" },
        stripped: ["p1", "p2"],
        errors: ["一个警告"],
      }),
    },
  });
  const out = await handlePurgeCommand("uninstall", {}, null, deps);
  assert.equal(out.kind, "success");
  assert.match(out.text, /已检测到补丁，已还原回原版。/);
  assert.match(out.text, /还原文件 2 个/);
  assert.match(out.text, /已删除 \/home\/u\/\.dsh\/override\.json/);
  assert.match(out.text, /已从 profile 移除: p1, p2/);
  assert.match(out.text, /⚠ 一个警告/);
  assert.match(out.text, /请重启 dsh。重启后插件不再加载。/);
});

test("/purge uninstall 没检测到补丁时换开场白，且 ok=false 时回 error", async () => {
  const { deps } = depsOf({
    uninstaller: { uninstallPurge: async () => ({ ok: false, applied: false }) },
  });
  const out = await handlePurgeCommand("remove", {}, null, deps);
  assert.equal(out.kind, "error");
  assert.match(out.text, /未检测到已应用补丁，仍会清除插件文件。/);
});

// ---------- edit ----------

test("/purge edit 已存在注入文件时只说打开", async () => {
  const { deps } = depsOf();
  const out = await handlePurgeCommand("edit", {}, null, deps);
  assert.equal(out.kind, "success");
  assert.match(out.text, /已打开 notepad 编辑注入文件：\/home\/u\/\.dsh\/prompt-inject\.md/);
  assert.match(out.text, /编辑完成后重启 dsh 生效。/);
});

test("/purge edit 缺文件时先 installOverride 再打开，并说明是新建", async () => {
  let createdCall = 0;
  let opened = false;
  const { deps } = depsOf({
    core: {
      editOverride: () => {
        if (!opened) return { ok: false, needCreate: true };
        return { ok: true, path: "/p", editor: "code" };
      },
      installOverride: async () => {
        createdCall += 1;
        opened = true;
        return { ok: true };
      },
    },
  });
  const out = await handlePurgeCommand("e", {}, null, deps);
  assert.equal(createdCall, 1);
  assert.equal(out.kind, "success");
  assert.match(out.text, /已创建默认注入文件并打开编辑器：\/p/);
  assert.match(out.text, /重启 dsh 生效。/);
});

test("/purge edit 打不开编辑器时回 error（旧实现这里会假报 success）", async () => {
  const { deps } = depsOf({ core: { editOverride: () => ({ ok: false, needCreate: false }) } });
  const out = await handlePurgeCommand("edit", {}, null, deps);
  assert.equal(out.kind, "error");
  assert.equal(out.text, "打开编辑器失败");
});

test("/purge edit 把 editOverride 的 error 原样带出", async () => {
  const { deps } = depsOf({ core: { editOverride: () => ({ ok: false, needCreate: false, error: "不是文件" }) } });
  const out = await handlePurgeCommand("edit", {}, null, deps);
  assert.equal(out.text, "不是文件");
});

// ---------- help ----------

test("/purge help、h 与未知子命令都回同一份帮助，并列全六条", async () => {
  const outs = [];
  for (const input of ["help", "h", "nonsense"]) {
    const { deps } = depsOf();
    const out = await handlePurgeCommand(input, {}, null, deps);
    assert.equal(out.kind, "success", input);
    outs.push(out.text);
  }
  assert.equal(outs[0], outs[1]);
  assert.equal(outs[0], outs[2]);
  for (const piece of ["/purge status", "/purge apply", "/purge revert", "/purge uninstall", "/purge edit", "/purge help", "/rules", "/skills"]) {
    assert.ok(outs[0].includes(piece), piece);
  }
});

test("/purge 子命令大小写不敏感，多空格也能切", async () => {
  const { deps } = depsOf();
  const out = await handlePurgeCommand("   APPLY   ", {}, null, deps);
  assert.equal(out.kind, "success");
  assert.match(out.text, /补丁已经在宿主里/);
});

test("/purge 的 config 参数当前不被使用（保持签名兼容 commands.js 的三参透传）", async () => {
  const { deps } = depsOf();
  const a = await handlePurgeCommand("help", { enabled: true }, null, deps);
  const b = await handlePurgeCommand("help", { enabled: false, cap: 9 }, null, deps);
  assert.equal(a.text, b.text);
});
