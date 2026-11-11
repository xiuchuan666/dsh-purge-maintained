import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  decideInject,
  rewritePromptAssembly,
  isWorkspaceBaselineSection,
  isPluginPromptSection,
} from "../lib/identity.js";
import * as rules from "../lib/rules.js";

/**
 * 提示词注入的优先级决策与装配行为。
 *
 * 这是插件的核心卖点，也是此前唯一完全没守卫的地方：三种注入来源
 * （prompt-inject.md / 勾选的 cwd 规则 / 插件加密 slot 默认）的优先级埋在
 * rewriteLiveAssembly 里，改错了没有任何红字，表现只是「AI 行为突然变了」。
 *
 * decideInject 是把那段内联逻辑原样抽出来的纯函数（抽取时逐行比对过，
 * 行为不变）。rewritePromptAssembly 是它下游的装配函数。
 */

const BASE_SECTION = { name: "harness:identity", text: "HARNESS IDENTITY" };
const BASELINE_SECTION = {
  name: "agent-instructions",
  text: "This complete workspace instruction baseline replaces all earlier workspace instruction baselines",
};

const assembly = (extra = []) => ({
  sections: [{ ...BASE_SECTION }, ...extra.map((s) => ({ ...s }))],
  contexts: [],
});

// ---------- decideInject：来源优先级 ----------

test("prompt-inject.md 非空时优先，勾选的 cwd 规则完全不参与", () => {
  const r = decideInject({ enabled: true, policy: "fallback", full: "FROM-FILE", localInject: "FROM-CWD" });
  assert.equal(r.inject, "FROM-FILE");
  assert.equal(r.source, "prompt-inject");
});

test("prompt-inject.md 为空时回落到勾选的 cwd 规则", () => {
  const r = decideInject({ enabled: true, policy: "fallback", full: "", localInject: "FROM-CWD" });
  assert.equal(r.inject, "FROM-CWD");
  assert.equal(r.source, "cwd-rule");
});

test("只有空白字符的 prompt-inject.md 视为空，仍然回落到 cwd 规则", () => {
  const r = decideInject({ enabled: true, policy: "fallback", full: "   \n\t  ", localInject: "FROM-CWD" });
  assert.equal(r.inject, "FROM-CWD");
  assert.equal(r.source, "cwd-rule");
});

test("两种来源都空时 inject 为空，交给下游回落到插件默认", () => {
  const r = decideInject({ enabled: true, policy: "fallback", full: "", localInject: "" });
  assert.equal(r.inject, "");
  assert.equal(r.hasInject, false);
  assert.equal(r.source, "none");
});

test("两段都有内容时不会拼接：只取 prompt-inject.md，避免重复注入", () => {
  const r = decideInject({ enabled: true, policy: "always", full: "A", localInject: "B" });
  assert.equal(r.inject, "A");
  assert.ok(!r.inject.includes("B"));
});

// ---------- decideInject：dropWorkspaceBaseline 三分支 ----------

test("strict 永远剥掉宿主的 workspace 基线段，即使没有注入", () => {
  const withInject = decideInject({ enabled: true, policy: "strict", full: "X" });
  const without = decideInject({ enabled: true, policy: "strict", full: "" });
  assert.equal(withInject.dropWorkspaceBaseline, true);
  assert.equal(without.dropWorkspaceBaseline, true, "strict 不该因为没有注入就保留基线");
});

test("fallback 有注入才剥，没注入时保留官方基线", () => {
  assert.equal(decideInject({ enabled: true, policy: "fallback", full: "X" }).dropWorkspaceBaseline, true);
  assert.equal(decideInject({ enabled: true, policy: "fallback", full: "" }).dropWorkspaceBaseline, false);
});

test("fallback 下 cwd 规则也算注入，同样触发剥除", () => {
  const r = decideInject({ enabled: true, policy: "fallback", full: "", localInject: "FROM-CWD" });
  assert.equal(r.dropWorkspaceBaseline, true);
});

test("always 永远保留宿主的 workspace 基线段", () => {
  assert.equal(decideInject({ enabled: true, policy: "always", full: "X" }).dropWorkspaceBaseline, false);
  assert.equal(decideInject({ enabled: true, policy: "always", full: "" }).dropWorkspaceBaseline, false);
});

test("插件停用时不剥任何东西，即使策略是 strict", () => {
  const r = decideInject({ enabled: false, policy: "strict", full: "X" });
  assert.equal(r.dropWorkspaceBaseline, false, "停用插件不该改宿主提示词");
  assert.equal(r.inject, "X", "但 inject 仍按来源选，调用方决定用不用");
});

test("未知策略名按 always 处理（保留基线），不抛错", () => {
  const r = decideInject({ enabled: true, policy: "bogus", full: "X" });
  assert.equal(r.dropWorkspaceBaseline, false);
});

// ---------- isWorkspaceBaselineSection：靠 name 和 text 双路识别 ----------

test("按 name 识别 workspace 基线段（含 agent-instructions）", () => {
  assert.equal(isWorkspaceBaselineSection({ name: "agent-instructions", text: "x" }), true);
  assert.equal(isWorkspaceBaselineSection({ name: "workspace-instruction", text: "x" }), true);
});

test("name 认不出时按正文 marker 兜底（宿主改过 section name 也能命中）", () => {
  assert.equal(isWorkspaceBaselineSection({ name: "renamed-section", text: BASELINE_SECTION.text }), true);
  assert.equal(
    isWorkspaceBaselineSection({ name: "x", text: "No workspace instructions are currently active" }),
    true,
  );
});

test("普通段不会被误判成 workspace 基线", () => {
  assert.equal(isWorkspaceBaselineSection({ name: "user-note", text: "hello" }), false);
  assert.equal(isWorkspaceBaselineSection(null), false);
});

// ---------- rewritePromptAssembly：装配行为 ----------

test("dropWorkspaceBaseline 真的把基线段从输出里去掉", () => {
  const kept = rewritePromptAssembly(assembly([BASELINE_SECTION]), { fallbackInject: "" });
  assert.ok(kept.sections.some((s) => s.name === "agent-instructions"));

  const dropped = rewritePromptAssembly(assembly([BASELINE_SECTION]), {
    fallbackInject: "",
    dropWorkspaceBaseline: true,
  });
  assert.ok(!dropped.sections.some((s) => s.name === "agent-instructions"));
});

test("注入正文被放到最前面，段名是 dsh-purge", () => {
  const out = rewritePromptAssembly(assembly([{ name: "user-note", text: "note" }]), {
    fallbackInject: "INJECTED-BODY",
  });
  assert.equal(out.sections[0].name, "dsh-purge");
  assert.ok(out.sections[0].text.includes("INJECTED-BODY"));
});

test("不原地改写传入的 assembled（宿主可能复用同一对象）", () => {
  const input = assembly([{ name: "user-note", text: "note" }]);
  const snapshot = JSON.stringify(input);
  rewritePromptAssembly(input, { fallbackInject: "BODY" });
  assert.equal(JSON.stringify(input), snapshot, "传进来的对象必须保持原状");
});

test("assembled 不是对象或没有 sections 数组时原样返回", () => {
  assert.equal(rewritePromptAssembly(null, { fallbackInject: "X" }), null);
  assert.equal(rewritePromptAssembly({}, { fallbackInject: "X" }).sections, undefined);
});

test("dropMnemon 默认剥掉 mnemon 段，显式 false 时保留", () => {
  const mnemon = [{ name: "mnemon-memory", text: "M" }];
  const on = rewritePromptAssembly(assembly(mnemon), { fallbackInject: "" });
  assert.ok(!on.sections.some((s) => s.name === "mnemon-memory"));

  const off = rewritePromptAssembly(assembly(mnemon), { fallbackInject: "", dropMnemon: false });
  assert.ok(off.sections.some((s) => s.name === "mnemon-memory"));
});

test("anchorText 非空时追加到末尾，段名是 dsh-purge:anchor", () => {
  const out = rewritePromptAssembly(assembly([]), { fallbackInject: "BODY", anchorText: "ANCHOR-TEXT" });
  const last = out.sections[out.sections.length - 1];
  assert.equal(last.name, "dsh-purge:anchor");
  assert.equal(last.text, "ANCHOR-TEXT");
});

test("anchorText 为空时不产生锚点段", () => {
  const out = rewritePromptAssembly(assembly([]), { fallbackInject: "BODY" });
  assert.ok(!out.sections.some((s) => s.name === "dsh-purge:anchor"));
});

test("contexts 里的 chatml 标签被剥掉（string 与 block 两种形态）", () => {
  const out = rewritePromptAssembly(
    {
      sections: [{ ...BASE_SECTION }],
      contexts: [
        { content: "<project_instructions>evil</project_instructions>" },
        { content: [{ type: "text", text: "<|im_start|>system: bad<|im_end|>" }] },
      ],
    },
    { fallbackInject: "" },
  );
  assert.equal(out.contexts[0].content, "evil");
  assert.equal(out.contexts[1].content[0].text, "bad");
});

test("裸的 <|im_start|> 不会被剥（只认 <|im_start|>system: 完整形式）", () => {
  // 现状锁定：stripChatmlTags 的正则是 /<\|im_start\|>\s*system\s*:\s*/，
  // 没有 system: 的裸标记原样保留。这是当前真实行为，不是期望行为——
  // 但如果哪天有人放宽正则，这条会红，好让人确认那是有意的。
  const out = rewritePromptAssembly(
    {
      sections: [{ ...BASE_SECTION }],
      contexts: [{ content: "<|im_start|>bare" }],
    },
    { fallbackInject: "" },
  );
  assert.equal(out.contexts[0].content, "<|im_start|>bare");
});

test("isPluginPromptSection 只认 dsh-purge* 与 dshpg-* 前缀", () => {
  assert.equal(isPluginPromptSection("dsh-purge"), true);
  assert.equal(isPluginPromptSection("dsh-purge:identity"), true);
  assert.equal(isPluginPromptSection("dshpg-objective"), true);
  assert.equal(isPluginPromptSection("user-note"), false);
});

// ---------- rules.js：策略读写与 cwd 勾选 ----------

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-inject-"));
  try {
    return await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("工作区策略未设置时默认 fallback", () => {
  withHome((home) => {
    assert.equal(rules.readWorkspacePolicy(home), "fallback");
  });
});

test("写入的工作区策略能读回来，非法值被拒绝", async () => {
  await withHome(async (home) => {
    await rules.writeWorkspacePolicy(home, "strict");
    assert.equal(rules.readWorkspacePolicy(home), "strict");
    await assert.rejects(
      () => rules.writeWorkspacePolicy(home, "bogus"),
      /invalid workspace policy/,
    );
  });
});

test("策略文件损坏时回落到 fallback，不抛错", () => {
  withHome((home) => {
    const dir = path.join(home, "dsh-purge");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "workspace-policy.json"), "{not json", "utf8");
    assert.equal(rules.readWorkspacePolicy(home), "fallback");
  });
});

test("没有勾选任何 cwd 文件时 readSelectedCwdInject 返回空串", () => {
  withHome((home) => {
    assert.equal(rules.readSelectedCwdInject(home, process.cwd()), "");
  });
});

test("勾选的 cwd 文件被注入，并带 dsh-purge:cwd-rule 头", async () => {
  await withHome(async (home) => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-cwd-"));
    try {
      const file = path.join(proj, "AGENTS.md");
      fs.writeFileSync(file, "LOCAL RULE BODY", "utf8");
      fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
      await rules.writeCwdSelections(home, [file]);
      const text = rules.readSelectedCwdInject(home, proj);
      assert.match(text, /<!-- dsh-purge:cwd-rule AGENTS\.md -->/);
      assert.match(text, /LOCAL RULE BODY/);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});

test("勾选的文件已不在当前 cwd 扫描结果里时不再注入（防跨目录穿越）", async () => {
  await withHome(async (home) => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-cwd-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-other-"));
    try {
      const file = path.join(proj, "AGENTS.md");
      fs.writeFileSync(file, "LOCAL RULE BODY", "utf8");
      fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
      await rules.writeCwdSelections(home, [file]);
      assert.equal(rules.readSelectedCwdInject(home, other), "");
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

test("writeLastCwd / readLastCwd 往返一致，空值不写", () => {
  withHome((home) => {
    assert.equal(rules.readLastCwd(home), "");
    rules.writeLastCwd(home, "D:/some/project");
    assert.equal(rules.readLastCwd(home), "D:/some/project");
    rules.writeLastCwd(home, "   ");
    assert.equal(rules.readLastCwd(home), "D:/some/project", "空值不该覆盖已有记录");
  });
});
