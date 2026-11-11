/**
 * lib/redteam/role-section.js 决定「红队子会话拿到哪份角色稿」。
 *
 * 它坏掉的表现是安静的：
 *   - 角色认错 → 子会话拿着侦察的稿子去干利用的活，交回来的东西不对但没人报错；
 *   - 角色丢了 → 系统提示词里少一段，子会话只能靠自己猜该干什么；
 *   - 认了不该认的会话（主会话 / 非红队会话）→ 把红队角色稿塞进普通对话。
 *
 * 这里钉住解析与记忆的行为，不碰真实 engagements 目录以外的状态。
 * `installSubagentRoleCapture` 只测「挂了几次钩子、什么时候不挂」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  installSubagentRoleCapture,
  noteClaimedMessage,
  parseRedteamRole,
  resolveSubagentRoleText,
  textOfMessage,
} from "../lib/redteam/role-section.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-role-"));
const savedHome = process.env.DSH_HOME;
const savedSurface = process.env.DSH_SURFACE;

test.after(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  if (savedSurface === undefined) delete process.env.DSH_SURFACE;
  else process.env.DSH_SURFACE = savedSurface;
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 偶发 EPERM */
  }
});

let seq = 0;
/** 造一个红队子会话：header 同时带 origin 与 redteam 标记。 */
function childSession(extra = {}) {
  seq += 1;
  return {
    id: `kid-${seq}`,
    header: { origin: "subagent", delegationDepth: 1, agentPreset: "redteam", ...extra.header },
    ...extra,
  };
}

function mainSession(extra = {}) {
  seq += 1;
  return { id: `main-${seq}`, header: {}, ...extra };
}

// ---------------------------------------------------------------------------
// 标签解析
// ---------------------------------------------------------------------------

test("parseRedteamRole：只认五个角色码，大小写不敏感，行首可缩进", () => {
  for (const role of ["recon", "assess", "vuln-scan", "exploit", "internal"]) {
    assert.equal(parseRedteamRole(`redteamRole: ${role}`), role, role);
    assert.equal(parseRedteamRole(`  redteamRole:   ${role}   `), role, `${role} 带空白`);
    assert.equal(parseRedteamRole(`redteamRole: ${role.toUpperCase()}`), role, `${role} 大写`);
  }
  assert.equal(parseRedteamRole("redteamRole: hacker"), "", "不认识的码不猜");
  assert.equal(parseRedteamRole("redteamRole:"), "");
  assert.equal(parseRedteamRole("redteamRole: recon extra"), "", "后面还有字就不算");
  assert.equal(parseRedteamRole(""), "");
  assert.equal(parseRedteamRole(null), "");
  assert.equal(parseRedteamRole(undefined), "");
});

test("parseRedteamRole：多行文本里任意一行命中即可", () => {
  const text = "先做信息收集\nredteamRole: recon\n然后按结果推进";
  assert.equal(parseRedteamRole(text), "recon");
});

test("parseRedteamRole：不在行首的写法不算（避免正文里引用模板被误认）", () => {
  assert.equal(parseRedteamRole("请照这个格式写： redteamRole: recon"), "", "同一行前面有别的字");
  assert.equal(parseRedteamRole("> redteamRole: recon"), "");
});

test("textOfMessage：字符串、content 字符串、block 数组、text 字段四种形状都认", () => {
  assert.equal(textOfMessage("直接给字符串"), "直接给字符串");
  assert.equal(textOfMessage({ content: "字符串内容" }), "字符串内容");
  assert.equal(textOfMessage({ text: "text 字段" }), "text 字段");
  assert.equal(
    textOfMessage({
      content: [{ type: "text", text: "第一段" }, { type: "image" }, { type: "text", text: "第二段" }],
    }),
    "第一段\n\n第二段",
    "非 text 块占一个空位（map 后 join），所以中间是两个换行",
  );
  assert.equal(textOfMessage({ content: [{ type: "image" }] }), "");
  assert.equal(
    textOfMessage({ content: [{ text: 123 }, { text: "真的文本" }] }),
    "\n真的文本",
    "text 不是字符串的块按空串占位，不要 String 化成 \"123\"",
  );
  assert.equal(textOfMessage({ content: 42 }), "");
  assert.equal(textOfMessage({}), "");
  assert.equal(textOfMessage(null), "");
});

test("textOfMessage：content 优先于 text", () => {
  assert.equal(textOfMessage({ content: "content 赢", text: "text 输" }), "content 赢");
});

// ---------------------------------------------------------------------------
// 记忆：noteClaimedMessage
// ---------------------------------------------------------------------------

test("noteClaimedMessage：子会话领到带角色的消息时记下来，之后能读回来", () => {
  const session = childSession();
  noteClaimedMessage({ agent: { session }, message: { content: "redteamRole: exploit\n去拿 shell" } });
  // 注：真正的读取要有 engagements 目录，这里只验证不抛；下面 resolveSubagentRoleText 那组才是端到端。
  // 直接验证记忆生效：没有 engagement 目录时读到的是空串，但至少不抛
  assert.equal(typeof resolveSubagentRoleText({ agent: { session } }), "string");
});

test("noteClaimedMessage：主会话 / 非红队会话不记", () => {
  // 主会话（header 没有 subagent 标记）
  noteClaimedMessage({ agent: { session: mainSession() }, message: { content: "redteamRole: recon" } });
  // 有 subagent 标记但不是红队会话（identity.isRedteamSession 会判否）
  const nonRedteam = { id: "kid-plain", header: { origin: "subagent", agentPreset: "standard" } };
  noteClaimedMessage({ agent: { session: nonRedteam }, message: { content: "redteamRole: recon" } });
  // 没有角色标签
  noteClaimedMessage({ agent: { session: childSession() }, message: { content: "普通任务" } });
  // 缺 agent / 缺 message 都不抛
  noteClaimedMessage({});
  noteClaimedMessage(null);
  noteClaimedMessage({ agent: { session: childSession() } });
});

// ---------------------------------------------------------------------------
// 角色稿落地：resolveSubagentRoleText
// ---------------------------------------------------------------------------

function withEngagement(fn) {
  const home = path.join(sandbox, `home-${++seq}`);
  const root = path.join(home, "redteam");
  fs.mkdirSync(path.join(root, "engagements", "eng-1", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "current"), "eng-1\n");
  fs.writeFileSync(path.join(root, "engagements", "eng-1", "agents", "recon.md"), "侦察稿正文\n");
  fs.writeFileSync(path.join(root, "engagements", "eng-1", "agents", "exploit.md"), "利用稿正文\n");
  process.env.DSH_HOME = home;
  process.env.DSH_SURFACE = "web";
  try {
    return fn({ home, root });
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
  }
}

test("resolveSubagentRoleText：从会话事件里认出角色并读出对应稿件", () => {
  withEngagement(() => {
    const session = childSession({
      snapshotEvents: () => [
        { type: "user/message", data: { message: { content: "redteamRole: recon\n先扫端口" } } },
      ],
    });
    assert.equal(resolveSubagentRoleText({ agent: { session } }), "侦察稿正文");
  });
});

test("resolveSubagentRoleText：多条带角色的消息以最后一条为准", () => {
  withEngagement(() => {
    const session = childSession({
      snapshotEvents: () => [
        { type: "user/message", data: { message: { content: "redteamRole: recon" } } },
        { type: "user/message", data: { message: { content: "redteamRole: exploit" } } },
      ],
    });
    assert.equal(resolveSubagentRoleText({ agent: { session } }), "利用稿正文");
  });
});

test("resolveSubagentRoleText：稿件不存在、角色未知、没有 current 都返回空串", () => {
  withEngagement(({ root }) => {
    const noFile = childSession({
      snapshotEvents: () => [{ type: "user/message", data: { message: { content: "redteamRole: internal" } } }],
    });
    assert.equal(resolveSubagentRoleText({ agent: { session: noFile } }), "", "没有 internal.md");

    const noRole = childSession({ snapshotEvents: () => [{ type: "user/message", data: { content: "普通任务" } }] });
    assert.equal(resolveSubagentRoleText({ agent: { session: noRole } }), "", "认不出角色就不猜");

    fs.writeFileSync(path.join(root, "current"), "eng-missing\n");
    const hasRole = childSession({
      snapshotEvents: () => [{ type: "user/message", data: { message: { content: "redteamRole: recon" } } }],
    });
    assert.equal(resolveSubagentRoleText({ agent: { session: hasRole } }), "", "current 指向的靶标不存在");
  });
});

/*
 * 两处防御在公开 API 上不可达，这里不硬凑假用例（诚实记录）：
 *   1. currentEngagementId() 里「engagements/<id>/agents 必须存在」—— 只要 agents 目录不存在，
 *      底下的 <role>.md 也不可能存在，readRoleFile 照样返回空串。它是防御性复查，不是唯一闸门。
 *   2. readRoleFile() 里对 role 再跑一次 parseRedteamRole —— role 只可能来自上面同一套解析，
 *      进来时必然合法。同样属防御性复查。
 * 换句话说：删掉这两行，外部行为不变（RED 演练里它们确实 GREEN）。留着是对的，但别指望测试能守住。
 */

test("resolveSubagentRoleText：current 里带路径穿越的 id 一律当无效", () => {
  withEngagement(({ root }) => {
    // "eng-1/../../eng-1" 拼进 engagements 之后会解析回 engagements/eng-1 —— 真的能读到稿子，
    // 所以这条才是「路径穿越」的真检验；单写 "../etc" 只是碰不到文件而已。
    for (const bad of ["../etc", "a/b", "a\\b", "x".repeat(201), "eng-1/../../eng-1", "eng-1\\..\\eng-1"]) {
      fs.writeFileSync(path.join(root, "current"), bad);
      const session = childSession({
        snapshotEvents: () => [{ type: "user/message", data: { message: { content: "redteamRole: recon" } } }],
      });
      assert.equal(resolveSubagentRoleText({ agent: { session } }), "", `非法 id: ${bad}`);
    }
  });
});

test("resolveSubagentRoleText：只有红队预设、没有 subagent 标记的会话不算子会话", () => {
  withEngagement(() => {
    const notChild = {
      id: `kid-nosub-${++seq}`,
      header: { agentPreset: "redteam" },
      snapshotEvents: () => [{ type: "user/message", data: { message: { content: "redteamRole: recon" } } }],
    };
    assert.equal(resolveSubagentRoleText({ agent: { session: notChild } }), "", "红队预设不等于子会话");
  });
});

test("resolveSubagentRoleText：主会话与非红队子会话一律空串", () => {
  withEngagement(() => {
    const main = mainSession({
      snapshotEvents: () => [{ type: "user/message", data: { message: { content: "redteamRole: recon" } } }],
    });
    assert.equal(resolveSubagentRoleText({ agent: { session: main } }), "");
    const plain = {
      id: "kid-plain-2",
      header: { origin: "subagent", agentPreset: "standard" },
      snapshotEvents: () => [{ type: "user/message", data: { message: { content: "redteamRole: recon" } } }],
    };
    assert.equal(resolveSubagentRoleText({ agent: { session: plain } }), "");
  });
});

test("resolveSubagentRoleText：先看已记下的角色，事件里没有也能读到", () => {
  withEngagement(() => {
    const session = childSession({ snapshotEvents: () => [] });
    noteClaimedMessage({ agent: { session }, message: { content: "redteamRole: exploit" } });
    assert.equal(resolveSubagentRoleText({ agent: { session } }), "利用稿正文");
  });
});

test("resolveSubagentRoleText：snapshotEvents 抛错时退回 events 数组", () => {
  withEngagement(() => {
    const session = childSession({
      snapshotEvents: () => {
        throw new Error("boom");
      },
      events: [{ type: "user/message", data: { message: { content: "redteamRole: recon" } } }],
    });
    assert.equal(resolveSubagentRoleText({ agent: { session } }), "侦察稿正文");
  });
});

test("resolveSubagentRoleText：context 只给 session 不给 agent 也能走", () => {
  withEngagement(() => {
    const session = childSession({
      snapshotEvents: () => [{ type: "user/message", data: { message: { content: "redteamRole: recon" } } }],
    });
    assert.equal(resolveSubagentRoleText({ session }), "侦察稿正文");
  });
});

test("resolveSubagentRoleText：坏入参不抛，一律空串", () => {
  withEngagement(() => {
    assert.equal(resolveSubagentRoleText(null), "");
    assert.equal(resolveSubagentRoleText({}), "");
    assert.equal(resolveSubagentRoleText({ agent: {} }), "");
  });
});

// ---------------------------------------------------------------------------
// 钩子安装
// ---------------------------------------------------------------------------

function fakeCtx({ withEffect = true } = {}) {
  const regs = [];
  const ctx = {
    __flags: [],
    on(name, handler, opts) {
      const rec = { name, handler, opts, off: false };
      regs.push(rec);
      return () => {
        rec.off = true;
      };
    },
  };
  if (withEffect) {
    ctx.effect = function effect(fn) {
      this.__flags.push(fn);
    };
  }
  return { ctx, regs };
}

test("installSubagentRoleCapture：无 ctx 或无 on 时直接返回，不抛", () => {
  installSubagentRoleCapture(null);
  installSubagentRoleCapture({});
  installSubagentRoleCapture({ effect: () => {} });
});

test("installSubagentRoleCapture：cordis 环境走 effect，钩子带 global 与 prepend", () => {
  const { ctx, regs } = fakeCtx();
  installSubagentRoleCapture(ctx);
  assert.equal(ctx.__flags.length, 1, "必须包在 effect 里，dispose 才能解绑");
  const dispose = ctx.__flags[0]();
  assert.equal(regs.length, 1, "effect 内同步装一次");
  assert.equal(regs[0].name, "agent/inbox/claimed");
  assert.equal(regs[0].opts.global, true);
  assert.equal(regs[0].opts.prepend, true);
  dispose();
  assert.equal(regs[0].off, true, "dispose 要摘钩子");
  assert.equal(ctx.__dshPurgeRoleCapture, undefined, "dispose 后清掉安装标记，允许下次重装");
});

test("installSubagentRoleCapture：重复调用只挂一次（installed flag + __dshPurgeRoleCapture）", () => {
  const { ctx, regs } = fakeCtx();
  installSubagentRoleCapture(ctx);
  installSubagentRoleCapture(ctx);
  assert.equal(ctx.__flags.length, 1, "第二次直接返回，不再包 effect");
  ctx.__flags[0]();
  assert.equal(regs.length, 1);
});

test("installSubagentRoleCapture：ctx.on 抛错时不影响其余流程", () => {
  const ctx = {
    effect(fn) {
      this.fn = fn;
    },
    on() {
      throw new Error("host says no");
    },
  };
  installSubagentRoleCapture(ctx);
  assert.doesNotThrow(() => ctx.fn());
  assert.equal(ctx.__dshPurgeRoleCapture, true, "装不上也留着标记，避免反复重试");
});

test("installSubagentRoleCapture：没有 effect 时退回直接注册", () => {
  const { ctx, regs } = fakeCtx({ withEffect: false });
  installSubagentRoleCapture(ctx);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].opts.global, true);
  assert.equal(ctx.__dshPurgeRoleCapture, true);
});

test("installSubagentRoleCapture：钩子收到坏 payload 时不抛（记角色失败不阻断领消息）", () => {
  const { ctx, regs } = fakeCtx();
  installSubagentRoleCapture(ctx);
  ctx.__flags[0]();
  const hook = regs[0].handler;
  assert.doesNotThrow(() => hook(null));
  assert.doesNotThrow(() => hook({ agent: null }));
  assert.doesNotThrow(() => hook({ agent: { session: { header: { origin: "subagent", agentPreset: "redteam" } } }, message: 42 }));
  const exploding = {
    get header() {
      throw new Error("header blew up");
    },
  };
  assert.doesNotThrow(() => hook({ agent: { session: exploding }, message: { content: "redteamRole: recon" } }));
});
