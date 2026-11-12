// /rules 与 /skills 两条聊天命令的守卫。
//
// 为什么值得单独测：这两条命令会直接改 AGENTS.md / CLAUDE.md 与 $DSH_HOME/skills 目录。
// 判错的表现是「回了 success 但目标文件没变」「把别的规则内容覆盖掉」「删错了 id」，
// 全都不会抛错，只看状态页也看不出来。
//
// 这里用的是真的 lib/rules.js 与 lib/skills.js，只把 DSH_HOME 指到临时目录，
// 这样测的是「命令 → 落盘」这条完整链路，而不是一堆假对象互相对账。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  callRefreshHungOperator,
  renderRulesStatus,
  handleRulesCommand,
  renderSkillsStatus,
  handleSkillsCommand,
} from "../lib/chat-rules-skills.js";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-chat-cmd-"));
const ORIGINAL_HOME = process.env.DSH_HOME;
let seq = 0;

/** 每个用例一个干净的 DSH_HOME，避免互相污染。 */
function freshHome(tag = "case") {
  seq += 1;
  const home = path.join(SANDBOX, `${tag}-${seq}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/** 命令只依赖这两个东西：家目录与「改完重算注入」。 */
function depsFor(home, extra = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      core: { findDshHome: () => home },
      refreshHungOperator: (dir) => calls.push(dir),
      ...extra,
    },
  };
}

test.after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIGINAL_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 注入回调

test("callRefreshHungOperator：没有实现时什么也不做", () => {
  assert.equal(callRefreshHungOperator({}, "/tmp/x"), undefined);
});

test("callRefreshHungOperator：实现抛错不影响命令结果", () => {
  const deps = {
    refreshHungOperator: () => {
      throw new Error("宿主还没起来");
    },
  };
  assert.equal(callRefreshHungOperator(deps, "/tmp/x"), undefined);
});

test("callRefreshHungOperator：正常实现拿到的是同一个家目录", () => {
  const seen = [];
  callRefreshHungOperator({ refreshHungOperator: (dir) => seen.push(dir) }, "/tmp/home-a");
  assert.deepEqual(seen, ["/tmp/home-a"]);
});

// ---------------------------------------------------------------- /rules list 排版

test("renderRulesStatus：没有激活时目标行写「(无激活)」", () => {
  const text = renderRulesStatus({
    rules_dir: "/h/dsh-purge/rules",
    active: null,
    active_target: null,
    agents_path: "/h/AGENTS.md",
    agents_exists: false,
    agents_synced: false,
    rules: [],
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "规则集 / Rule Sets");
  assert.equal(lines[1], "  存储目录 / store  /h/dsh-purge/rules");
  assert.match(lines[2], /^ {2}目标文件 \/ target \(无激活\) — exists=false, synced=false$/);
  assert.equal(lines[3], "");
  assert.equal(lines[4], "  (暂无规则 / no rules — 用 /rules create <id> 或设置页新建)");
});

test("renderRulesStatus：激活时目标行带路径与目标名", () => {
  const text = renderRulesStatus({
    rules_dir: "/h/rules",
    active: "mine",
    active_target: "CLAUDE.md",
    agents_path: "/h/CLAUDE.md",
    agents_exists: true,
    agents_synced: true,
    rules: [],
  });
  assert.match(text.split("\n")[2], /^ {2}目标文件 \/ target \/h\/CLAUDE\.md \(CLAUDE\.md\) — exists=true, synced=true$/);
});

test("renderRulesStatus：当前规则打 ▶ 与 ★，其余打 ·", () => {
  const text = renderRulesStatus({
    rules_dir: "/h/rules",
    active: "a",
    active_target: "AGENTS.md",
    agents_path: "/h/AGENTS.md",
    agents_exists: true,
    agents_synced: true,
    rules: [
      { id: "a", name: "甲", target: "AGENTS.md", size: 12 },
      { id: "b", name: "b", target: "CLAUDE.md", size: 2048 },
    ],
  });
  const lines = text.split("\n");
  assert.equal(lines[4], "  ▶ 甲 (a) ★ 当前 [AGENTS.md] (12 B)");
  assert.equal(lines[5], "  · b [CLAUDE.md] (2.0 KB)");
});

test("renderRulesStatus：名字与 id 相同时不重复括号", () => {
  const text = renderRulesStatus({
    rules_dir: "/h/rules",
    active: null,
    active_target: null,
    agents_path: "/h/AGENTS.md",
    agents_exists: false,
    agents_synced: false,
    rules: [{ id: "same", name: "same", target: "AGENTS.md", size: 0 }],
  });
  assert.match(text, /\n {2}· same \[AGENTS\.md\] \(0 B\)$/);
});

// ---------------------------------------------------------------- /rules 六条分支

test("handleRulesCommand：空输入等于 list", async () => {
  const home = freshHome("list");
  const { deps } = depsFor(home);
  const r = await handleRulesCommand("", deps);
  assert.equal(r.kind, "success");
  assert.match(r.text, /暂无规则/);
});

test("handleRulesCommand：别名 ls / s 都走 list", async () => {
  const home = freshHome("list-alias");
  const { deps } = depsFor(home);
  for (const arg of ["list", "ls", "s", "  LS  "]) {
    const r = await handleRulesCommand(arg, deps);
    assert.equal(r.kind, "success", arg);
    assert.match(r.text, /规则集 \/ Rule Sets/, arg);
  }
});

test("handleRulesCommand：create 建出规则文件与元数据并回显目标", async () => {
  const home = freshHome("create");
  const { deps } = depsFor(home);
  const r = await handleRulesCommand("create abc 别名 CLAUDE.md", deps);
  assert.equal(r.kind, "success");
  assert.match(r.text, /✓ 已创建规则 别名（abc → CLAUDE\.md）/);
  const dir = path.join(home, "rules");
  assert.equal(fs.readFileSync(path.join(dir, "abc.md"), "utf8"), "");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "abc.json"), "utf8")), {
    name: "别名",
    target: "CLAUDE.md",
  });
});

test("handleRulesCommand：create 缺 id 只回用法，不建目录", async () => {
  const home = freshHome("create-noid");
  const { deps } = depsFor(home);
  const r = await handleRulesCommand("create", deps);
  assert.equal(r.kind, "error");
  assert.equal(r.text, "用法: /rules create <id> [别名] [AGENTS.md|CLAUDE.md]");
  assert.equal(fs.existsSync(path.join(home, "rules")), false);
});

test("handleRulesCommand：create 给非法目标时点名两个合法值", async () => {
  const home = freshHome("create-badtarget");
  const { deps } = depsFor(home);
  const r = await handleRulesCommand("create abc 别名 README.md", deps);
  assert.equal(r.kind, "error");
  assert.equal(r.text, "无效目标: README.md（只能是 AGENTS.md 或 CLAUDE.md）");
});

test("handleRulesCommand：create 的别名缺省就是 id", async () => {
  const home = freshHome("create-defaultname");
  const { deps } = depsFor(home);
  const r = await handleRulesCommand("create soloid", deps);
  const meta = JSON.parse(fs.readFileSync(path.join(home, "rules", "soloid.json"), "utf8"));
  assert.deepEqual(meta, { name: "soloid", target: "AGENTS.md" });
  // 落盘侧看不出区别（normalizeMeta 会把空 name 回落成 id），只有回显能区分：
  // 若把 `args[2] || id` 写成 `args[2] || ""`，这里就会变成「✓ 已创建规则 （soloid → …）」。
  assert.equal(r.text, "✓ 已创建规则 soloid（soloid → AGENTS.md）。在设置页「规则设定」编辑内容后保存。");
});

test("handleRulesCommand：use 把规则正文写进 AGENTS.md 并重算注入", async () => {
  const home = freshHome("use");
  const rulesDir = path.join(home, "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, "abc.md"), "指令正文\n");
  fs.writeFileSync(path.join(rulesDir, "abc.json"), JSON.stringify({ name: "别名", target: "AGENTS.md" }));
  const { deps, calls } = depsFor(home);

  const r = await handleRulesCommand("use abc", deps);
  assert.equal(r.kind, "success");
  assert.match(r.text, /✓ 已激活规则 别名（abc）→ 写入 .*AGENTS\.md/);
  assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), "指令正文\n");
  assert.deepEqual(calls, [home]);

  const state = JSON.parse(fs.readFileSync(path.join(rulesDir, "state.json"), "utf8"));
  assert.deepEqual(state, { active: "abc" });
});

test("handleRulesCommand：activate / u 也是 use", async () => {
  const home = freshHome("use-alias");
  const rulesDir = path.join(home, "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, "abc.md"), "x");
  const { deps } = depsFor(home);
  for (const arg of ["activate abc", "u abc"]) {
    const r = await handleRulesCommand(arg, deps);
    assert.equal(r.kind, "success", arg);
    // 必须断言正文：alias 被删掉时会落到 default: 的 help，kind 也是 success。
    assert.match(r.text, /^✓ 已激活规则 /, arg);
  }
});

test("handleRulesCommand：use 缺 id 回用法", async () => {
  const { deps } = depsFor(freshHome("use-noid"));
  const r = await handleRulesCommand("use", deps);
  assert.equal(r.kind, "error");
  assert.equal(r.text, "用法: /rules use <id>");
});

test("handleRulesCommand：use 一个不存在的规则报「激活失败」且不写目标文件", async () => {
  const home = freshHome("use-missing");
  const { deps, calls } = depsFor(home);
  const r = await handleRulesCommand("use ghost", deps);
  assert.equal(r.kind, "error");
  assert.equal(r.text, "激活失败: rule not found: ghost");
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(home, "AGENTS.md")), false);
});

test("handleRulesCommand：delete 删掉规则并重算注入", async () => {
  const home = freshHome("delete");
  const { deps, calls } = depsFor(home);
  await handleRulesCommand("create abc 别名 AGENTS.md", deps);
  calls.length = 0;
  const r = await handleRulesCommand("delete abc", deps);
  assert.equal(r.kind, "success");
  assert.equal(r.text, "✓ 已删除规则 abc。");
  assert.equal(fs.existsSync(path.join(home, "rules", "abc.md")), false);
  assert.deepEqual(calls, [home]);
});

test("handleRulesCommand：rm / d 也是 delete", async () => {
  const home = freshHome("delete-alias");
  const { deps } = depsFor(home);
  for (const arg of ["rm", "d"]) {
    await handleRulesCommand("create abc", deps);
    const r = await handleRulesCommand(`${arg} abc`, deps);
    assert.equal(r.kind, "success", arg);
  }
});

test("handleRulesCommand：delete 缺 id 回用法", async () => {
  const { deps } = depsFor(freshHome("delete-noid"));
  const r = await handleRulesCommand("delete", deps);
  assert.equal(r.kind, "error");
  assert.equal(r.text, "用法: /rules delete <id>");
});

test("handleRulesCommand：delete 一个不存在的 id 也回 success（rules.deleteRule 吞 ENOENT）", async () => {
  // 现状锁定：deleteRule 对缺失的 .md / .json 都只吞 ENOENT，不抛错。
  // 后果是 /rules delete 拼错 id 也回「✓ 已删除规则」——用户以为删了。
  const home = freshHome("delete-missing");
  const { deps, calls } = depsFor(home);
  const r = await handleRulesCommand("delete ghost", deps);
  assert.equal(r.kind, "success");
  assert.equal(r.text, "✓ 已删除规则 ghost。");
  // 仍然会重算一次注入（命令无条件调用），即使什么也没删掉。
  assert.deepEqual(calls, [home]);
  assert.equal(fs.existsSync(path.join(home, "rules")), false);
});

test("handleRulesCommand：delete 一个非法 id 才会抛（validRuleId 拦住）", async () => {
  const { deps, calls } = depsFor(freshHome("delete-badid"));
  const r = await handleRulesCommand("delete Bad_Id!", deps);
  assert.equal(r.kind, "error");
  assert.equal(r.text, "删除失败: invalid rule id: Bad_Id!");
  assert.deepEqual(calls, []);
});

test("handleRulesCommand：reset 把激活时改的 AGENTS.md 还原回去", async () => {
  const home = freshHome("reset");
  const rulesDir = path.join(home, "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, "abc.md"), "新内容\n");
  fs.writeFileSync(path.join(rulesDir, "abc.json"), JSON.stringify({ name: "abc", target: "AGENTS.md" }));
  fs.writeFileSync(path.join(home, "AGENTS.md"), "原有内容\n");
  const { deps, calls } = depsFor(home);
  await handleRulesCommand("use abc", deps);
  assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), "新内容\n");
  calls.length = 0;

  const r = await handleRulesCommand("reset", deps);
  assert.equal(r.kind, "success");
  assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), "原有内容\n");
  assert.match(r.text, /已清空激活状态/);
  assert.deepEqual(calls, [home]);
  assert.equal(fs.existsSync(path.join(rulesDir, "state.json")), false);
});

test("handleRulesCommand：reset 别名 restore 与「还原」", async () => {
  const home = freshHome("reset-alias");
  const { deps } = depsFor(home);
  for (const arg of ["restore", "还原"]) {
    const r = await handleRulesCommand(arg, deps);
    assert.equal(r.kind, "success", arg);
    assert.match(r.text, /已清空激活状态/, arg);
  }
});

test("handleRulesCommand：reset 在没有原文件时删掉插件写入的 AGENTS.md 并报 removed", async () => {
  // 与下一条的区别：这里激活前 AGENTS.md 不存在，所以 activateRule 不会留 .dsh-purge-rule.bak，
  // reset 走的是 removed（内容与本条规则一致 → 删掉），不是 restored。
  const home = freshHome("reset-removed");
  const rulesDir = path.join(home, "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, "abc.md"), "规则正文\n");
  fs.writeFileSync(path.join(rulesDir, "abc.json"), JSON.stringify({ name: "abc", target: "AGENTS.md" }));
  const { deps } = depsFor(home);
  await handleRulesCommand("use abc", deps);
  assert.equal(fs.existsSync(path.join(home, "AGENTS.md.dsh-purge-rule.bak")), false);
  assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), "规则正文\n");

  const r = await handleRulesCommand("reset", deps);
  assert.equal(r.kind, "success");
  assert.match(r.text, /^✓ 已删除插件写入的目标文件: .*AGENTS\.md$/m);
  assert.doesNotMatch(r.text, /⚠ 跳过/);
  assert.equal(fs.existsSync(path.join(home, "AGENTS.md")), false);
});

test("handleRulesCommand：reset 遇到被手改过的目标文件会跳过并写进提示", async () => {
  const home = freshHome("reset-skip");
  const rulesDir = path.join(home, "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, "abc.md"), "规则\n");
  fs.writeFileSync(path.join(rulesDir, "abc.json"), JSON.stringify({ name: "abc", target: "AGENTS.md" }));
  const { deps } = depsFor(home);
  await handleRulesCommand("use abc", deps);
  fs.writeFileSync(path.join(home, "AGENTS.md"), "被人手改了\n");
  const r = await handleRulesCommand("reset", deps);
  assert.equal(r.kind, "success");
  assert.match(r.text, /⚠ 跳过（文件内容与规则不一致，可能被手动修改）: .*AGENTS\.md/);
  assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), "被人手改了\n");
});

test("handleRulesCommand：help / 未知子命令 / 空都回同一份帮助", async () => {
  const home = freshHome("help");
  const { deps } = depsFor(home);
  const seen = new Set();
  for (const arg of ["help", "h", "nonsense"]) {
    const r = await handleRulesCommand(arg, deps);
    assert.equal(r.kind, "success", arg);
    seen.add(r.text);
  }
  assert.equal(seen.size, 1);
  assert.match([...seen][0], /\/rules use <id>/);
});

test("handleRulesCommand：子命令大小写不敏感", async () => {
  const home = freshHome("case");
  const { deps } = depsFor(home);
  const r = await handleRulesCommand("  CREATE Abc 名字  ", deps);
  assert.equal(r.kind, "success");
  assert.equal(fs.existsSync(path.join(home, "rules", "Abc.md")), true);
});

test("handleRulesCommand：deps 缺省时用 process.env.DSH_HOME 定位家目录", async () => {
  const home = freshHome("env-home");
  process.env.DSH_HOME = home;
  try {
    await handleRulesCommand("create envrule");
    assert.equal(fs.existsSync(path.join(home, "rules", "envrule.md")), true);
  } finally {
    process.env.DSH_HOME = ORIGINAL_HOME;
  }
});

// ---------------------------------------------------------------- /skills list 排版

test("renderSkillsStatus：空目录给一句「暂无用户 Skill」", () => {
  const lines = renderSkillsStatus({ skills_dir: "$DSH_HOME/skills", skills: [] }).split("\n");
  assert.equal(lines[0], "官方用户 Skill / $DSH_HOME/skills");
  assert.equal(lines[1], "  $DSH_HOME/skills");
  assert.equal(lines[4], "");
  assert.equal(lines[5], "  (暂无用户 Skill — 用 /skills import <压缩包或文件夹> 或设置页导入)");
});

test("renderSkillsStatus：正常条目带说明、大小与调用方式", () => {
  const text = renderSkillsStatus({
    skills_dir: "$DSH_HOME/skills",
    skills: [
      { id: "code-review", description: "审查", valid: true, userInvocable: true, modelInvocable: true, size: 300 },
    ],
  });
  assert.match(text, /\n {2}· code-review {2}审查 {2}\(300 B\)\n {6}\/code-review · 模型可调$/);
});

test("renderSkillsStatus：不可用条目打 ! 并把 error 抄一行", () => {
  const text = renderSkillsStatus({
    skills_dir: "$DSH_HOME/skills",
    skills: [{ id: "broken", description: "", valid: false, error: "缺少 SKILL.md", size: 0 }],
  });
  assert.match(text, /\n {2}! broken {2}\(无说明\) {2}\(0 B\)\n/);
  assert.match(text, /\n {6}缺少 SKILL\.md$/);
});

test("renderSkillsStatus：两个通道都关掉时写「不可 /名称」「模型不可调」", () => {
  const text = renderSkillsStatus({
    skills_dir: "$DSH_HOME/skills",
    skills: [{ id: "quiet", description: "d", valid: true, userInvocable: false, modelInvocable: false, size: 1 }],
  });
  assert.match(text, /\n {6}不可 \/名称 · 模型不可调$/);
});

// ---------------------------------------------------------------- /skills 五条分支

test("handleSkillsCommand：空输入等于 list", async () => {
  const home = freshHome("sk-list");
  const { deps } = depsFor(home);
  const r = await handleSkillsCommand("", deps);
  assert.equal(r.kind, "success");
  assert.match(r.text, /暂无用户 Skill/);
});

test("handleSkillsCommand：create 写出 <id>/SKILL.md 并回显路径", async () => {
  const home = freshHome("sk-create");
  const { deps } = depsFor(home);
  const r = await handleSkillsCommand("create code-review 审查代码", deps);
  assert.equal(r.kind, "success");
  assert.match(r.text, /✓ 已写入官方目录 \$DSH_HOME\/skills\/code-review\/SKILL\.md/);
  const doc = fs.readFileSync(path.join(home, "skills", "code-review", "SKILL.md"), "utf8");
  assert.match(doc, /^---\n/);
  assert.match(doc, /name: code-review/);
  assert.match(doc, /description: "审查代码"/);
});

test("handleSkillsCommand：create 的描述缺省就是 id", async () => {
  const home = freshHome("sk-create-nodesc");
  const { deps } = depsFor(home);
  await handleSkillsCommand("create solo", deps);
  const doc = fs.readFileSync(path.join(home, "skills", "solo", "SKILL.md"), "utf8");
  assert.match(doc, /description: solo/);
});

test("handleSkillsCommand：create 缺 id 回用法", async () => {
  const { deps } = depsFor(freshHome("sk-create-noid"));
  const r = await handleSkillsCommand("create", deps);
  assert.equal(r.kind, "error");
  assert.equal(r.text, "用法: /skills create <id> [说明]");
});

test("handleSkillsCommand：create 非 kebab-case 时点名示例", async () => {
  const { deps } = depsFor(freshHome("sk-create-badname"));
  for (const id of ["Code", "code_review", "-lead", "a--b"]) {
    const r = await handleSkillsCommand(`create ${id}`, deps);
    assert.equal(r.kind, "error", id);
    assert.equal(r.text, "id 必须是 kebab-case，例如 code-review", id);
  }
});

test("handleSkillsCommand：create 别名 new / c", async () => {
  const home = freshHome("sk-create-alias");
  const { deps } = depsFor(home);
  assert.equal((await handleSkillsCommand("new one", deps)).kind, "success");
  assert.equal((await handleSkillsCommand("c two", deps)).kind, "success");
  assert.equal(fs.existsSync(path.join(home, "skills", "one", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(home, "skills", "two", "SKILL.md")), true);
});

test("handleSkillsCommand：import 一个文件夹会把 SKILL.md 装进官方目录", async () => {
  const home = freshHome("sk-import");
  const src = path.join(SANDBOX, "import-src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, "SKILL.md"),
    "---\nname: imported-skill\ndescription: 导入的\n---\n\n正文\n",
  );
  const { deps } = depsFor(home);
  const r = await handleSkillsCommand(`import ${src}`, deps);
  assert.equal(r.kind, "success");
  assert.match(r.text, /✓ 已导入到官方 \$DSH_HOME\/skills：imported-skill/);
  assert.equal(fs.existsSync(path.join(home, "skills", "imported-skill", "SKILL.md")), true);
});

test("handleSkillsCommand：import 缺路径回用法", async () => {
  const { deps } = depsFor(freshHome("sk-import-nopath"));
  const r = await handleSkillsCommand("import", deps);
  assert.equal(r.kind, "error");
  assert.equal(r.text, "用法: /skills import <压缩包或文件夹>");
});

test("handleSkillsCommand：import 不存在的路径报「导入失败」", async () => {
  const { deps } = depsFor(freshHome("sk-import-missing"));
  const r = await handleSkillsCommand("import Z:/nowhere/at/all", deps);
  assert.equal(r.kind, "error");
  assert.match(r.text, /^导入失败: /);
});

test("handleSkillsCommand：import 别名 i", async () => {
  const home = freshHome("sk-import-alias");
  const src = path.join(SANDBOX, "import-src-i");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: via-i\ndescription: d\n---\n");
  const { deps } = depsFor(home);
  const r = await handleSkillsCommand(`i ${src}`, deps);
  assert.equal(r.kind, "success");
  assert.match(r.text, /via-i/);
});

test("handleSkillsCommand：delete 删目录，有备份时把备份路径也写出来", async () => {
  const home = freshHome("sk-delete");
  const { deps } = depsFor(home);
  await handleSkillsCommand("create code-review 审查", deps);
  const r = await handleSkillsCommand("delete code-review", deps);
  assert.equal(r.kind, "success");
  // 两行：第一行说删了，第二行必须给备份路径（用户要能找回被删的 SKILL.md）。
  const lines = r.text.split("\n");
  assert.equal(lines[0], "✓ 已从官方目录删除 code-review");
  // 回显里的家目录是「$DSH_HOME」这种展示形式（不是绝对路径），校验存在性要换回真目录。
  assert.match(lines[1], /^备份：\$DSH_HOME\/dsh-purge-backups\/skills\/code-review_/);
  assert.equal(lines.length, 2);
  const realBak = lines[1].replace(/^备份：/, "").replace("$DSH_HOME", home);
  assert.equal(fs.existsSync(realBak), true);
  assert.equal(fs.existsSync(path.join(realBak, "code-review", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(home, "skills", "code-review")), false);
});

test("handleSkillsCommand：delete 缺 id 回用法", async () => {
  const { deps } = depsFor(freshHome("sk-delete-noid"));
  const r = await handleSkillsCommand("delete", deps);
  assert.equal(r.kind, "error");
  assert.equal(r.text, "用法: /skills delete <id>");
});

test("handleSkillsCommand：delete 不存在的 id 报「删除失败」", async () => {
  const { deps } = depsFor(freshHome("sk-delete-missing"));
  const r = await handleSkillsCommand("delete ghost", deps);
  assert.equal(r.kind, "error");
  assert.match(r.text, /^删除失败: /);
});

test("handleSkillsCommand：rm / d 也是 delete", async () => {
  const home = freshHome("sk-delete-alias");
  const { deps } = depsFor(home);
  for (const arg of ["rm", "d"]) {
    await handleSkillsCommand("create abc", deps);
    const r = await handleSkillsCommand(`${arg} abc`, deps);
    assert.equal(r.kind, "success", arg);
  }
});

test("handleSkillsCommand：help / 未知子命令回同一份帮助，且不碰目录", async () => {
  const home = freshHome("sk-help");
  const { deps } = depsFor(home);
  const seen = new Set();
  for (const arg of ["help", "h", "nonsense"]) {
    const r = await handleSkillsCommand(arg, deps);
    assert.equal(r.kind, "success", arg);
    seen.add(r.text);
  }
  assert.equal(seen.size, 1);
  assert.match([...seen][0], /\/skills import <路径>/);
  assert.equal(fs.existsSync(path.join(home, "skills")), false);
});

test("handleSkillsCommand：list 别名 ls / s", async () => {
  const home = freshHome("sk-list-alias");
  const { deps } = depsFor(home);
  for (const arg of ["list", "ls", "s"]) {
    const r = await handleSkillsCommand(arg, deps);
    assert.equal(r.kind, "success", arg);
    assert.match(r.text, /官方用户 Skill/, arg);
  }
});

test("deps 里没有 refreshHungOperator 时 rules / skills 命令都不受影响", async () => {
  // 行为侧：即使 \`typeof\` 守卫被删掉，裸调用也会抛 TypeError 再被 catch 吞掉，
  // 所以这条只防「抛到命令外」，真正的守卫形状见下一条源码断言。
  const home = freshHome("deps-missing");
  const deps = { core: { findDshHome: () => home } };
  const a = await handleRulesCommand("create abc", deps);
  assert.equal(a.kind, "success");
  const b = await handleRulesCommand("use abc", deps);
  assert.equal(b.kind, "success");
  const c = await handleRulesCommand("delete abc", deps);
  assert.equal(c.kind, "success");
  const d = await handleSkillsCommand("list", deps);
  assert.equal(d.kind, "success");
});

// ---------------------------------------------------------------- 源码形状（不可观察的守卫）

test("两条命令共用同一套 deps 约定：家目录与重算注入都从 deps 拿", async () => {
  const src = fs.readFileSync(new URL("../lib/chat-rules-skills.js", import.meta.url), "utf8");
  // 家目录必须允许注入：写死 core.findDshHome() 会让测试打真宿主。
  assert.match(src, /const dshHome = \(deps\.core \|\| core\)\.findDshHome\(\);/);
  // 三处 refreshHungOperator 全部走注入，缺实现时静默跳过。
  assert.equal((src.match(/callRefreshHungOperator\(deps, dshHome\);/g) || []).length, 3);
  assert.equal((src.match(/^\s*try \{ deps\.refreshHungOperator\(dshHome\); \} catch/gm) || []).length, 1);
  // 业务路径上不许再出现裸调用（那会绕过注入、直接读 index.js 的模块状态）。
  assert.equal((src.match(/^\s+refreshHungOperator\(dshHome\);/gm) || []).length, 0);
  // 函数类型守卫：没有它也会被 catch 兜住，所以只能读源码钉（省一次异常构造）。
  assert.match(src, /if \(typeof deps\.refreshHungOperator !== "function"\) return;/);
});

test("skills create 的 description 缺省表达式与 saveSkill 的回落是两层", async () => {
  const src = fs.readFileSync(new URL("../lib/chat-rules-skills.js", import.meta.url), "utf8");
  // chat 层 `|| id` 与 saveSkill 内部的回落叠在一起，落盘看不出区别；
  // 谁哪天把 `|| id` 删掉，SKILL.md 里的 description 仍然会变回 id —— 这条只钉住写法。
  assert.match(src, /const description = args\.slice\(2\)\.join\(" "\)\.trim\(\) \|\| id;/);
});
