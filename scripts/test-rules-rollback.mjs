/**
 * `lib/rules.js` 的失败路径：saveRule 的回滚、激活时读不出来的规则、以及 status 的三态。
 *
 * 这个模块把「规则文件」和「目标文件（AGENTS.md / CLAUDE.md）」两个位置绑在一起改，
 * 任何一半失败都必须把另一半退回去 —— 否则用户看到的是「规则列表里有它、AGENTS.md
 * 里却是半截」。此前 186-201 那整段回滚一行都没跑过：三条分支（新建 rule 写失败、
 * 已有 rule 写失败、meta 已写而激活失败）分别对应三种不同的残留。
 *
 * 造失败的手法都是「让磁盘真实拒绝」而不是 mock 内部函数：
 *   · 把 meta 路径做成目录     → 写 meta 时 rename 失败（EPERM / EISDIR）
 *   · 把 AGENTS.md 做成目录    → 激活时写目标失败
 *   · `fs.promises.stat` 抛错  → listRules 的 size 兜底
 *   · `fs.readFileSync` 抛错   → collectRuleContents 跳过读不出来的规则
 */
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import {
  rulesDir, rulePath, ruleMetaPath, stateFile,
  saveRule, listRules, readRule, readRuleMeta, writeRuleMeta, deleteRule,
  activateRule, readActive, setActive, rulesStatus, ensureOperatorBody,
  targetPath, validRuleId, normalizeMeta,
} from "../lib/rules.js";
import { hungOperatorPrompt } from "../lib/core.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "rules-rollback-"));
let seq = 0;

function mkHome() {
  const h = path.join(ROOT, `h${++seq}`);
  fs.mkdirSync(path.join(h, "rules"), { recursive: true });
  return h;
}
const put = (fp, text) => { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, text, "utf8"); return fp; };
const read = (fp) => fs.readFileSync(fp, "utf8");

after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

/* ── saveRule 的回滚 ─────────────────────────────────────────────────────── */

test("saveRule：meta 写不进去时，刚写下的 rule 文件要被删掉（不留半截）", async () => {
  const h = mkHome();
  fs.mkdirSync(ruleMetaPath(h, "r1")); // 目录占位 → 写 meta 必失败

  let err = null;
  try { await saveRule(h, "r1", "NEW BODY", { name: "n" }); } catch (e) { err = e; }

  assert.ok(err, "写 meta 失败必须抛出去");
  assert.equal(fs.existsSync(rulePath(h, "r1")), false, "回滚要把刚写的 rule 删掉");
  assert.deepEqual(fs.readdirSync(rulesDir(h)).filter((n) => n.endsWith(".tmp")), []);
});

test("saveRule：已有规则 + 已有 meta，激活失败时两者都退回原文（逐字节）", async () => {
  const h = mkHome();
  const prevRule = "OLD BODY\n第二行\n";
  const prevMeta = '{\n  "name": "old",\n  "target": "AGENTS.md"\n}';
  put(rulePath(h, "r1"), prevRule);
  put(ruleMetaPath(h, "r1"), prevMeta);
  put(stateFile(h), JSON.stringify({ active: "r1" }));
  fs.mkdirSync(targetPath(h, "AGENTS.md")); // 激活时写目标必失败

  let err = null;
  try { await saveRule(h, "r1", "NEW BODY", { name: "new" }); } catch (e) { err = e; }

  assert.ok(err);
  assert.equal(read(rulePath(h, "r1")), prevRule, "rule 内容要退回上一版");
  assert.equal(read(ruleMetaPath(h, "r1")), prevMeta, "meta 也要退回上一版（含格式）");
});

test("saveRule：新规则 + active 指向它 + 激活失败 → rule 与 meta 都不留", async () => {
  const h = mkHome();
  put(stateFile(h), JSON.stringify({ active: "r2" }));
  fs.mkdirSync(targetPath(h, "AGENTS.md"));

  await assert.rejects(() => saveRule(h, "r2", "NEW", { name: "n" }));

  assert.equal(fs.existsSync(rulePath(h, "r2")), false);
  assert.equal(fs.existsSync(ruleMetaPath(h, "r2")), false);
  // active 还是原来那句：回滚不负责改 state.json
  assert.equal(read(stateFile(h)), JSON.stringify({ active: "r2" }));
});

test("saveRule：超过 256KB 在动手之前就拒绝，一个文件都不写", async () => {
  const h = mkHome();
  await assert.rejects(() => saveRule(h, "big", "x".repeat(256 * 1024 + 1), { name: "b" }), /rule too large/);
  assert.deepEqual(fs.readdirSync(rulesDir(h)), []);
});

test("saveRule / readRule / writeRuleMeta / deleteRule：非法 id 一律拒绝", async () => {
  const h = mkHome();
  for (const bad of ["", "-x", ".x", "x".repeat(65), "a/b", null, 42]) {
    await assert.rejects(() => saveRule(h, bad, "x", {}), /invalid rule id/, String(bad));
    await assert.rejects(() => readRule(h, bad), /invalid rule id/, String(bad));
    await assert.rejects(() => writeRuleMeta(h, bad, {}), /invalid rule id/, String(bad));
    await assert.rejects(() => deleteRule(h, bad), /invalid rule id/, String(bad));
    assert.equal(validRuleId(bad), false, String(bad));
  }
  // 合法的边界：1 个字符与 64 个字符
  assert.equal(validRuleId("a"), true);
  assert.equal(validRuleId("a".repeat(64)), true);
});

test("normalizeMeta：name 去空白并截 64、非法 target 回落到 AGENTS.md", () => {
  assert.deepEqual(normalizeMeta("id", undefined), { name: "id", target: "AGENTS.md" });
  assert.deepEqual(normalizeMeta("id", { name: "   ", target: "nope.md" }), { name: "id", target: "AGENTS.md" });
  assert.deepEqual(normalizeMeta("id", { name: "  长".repeat(80).trim(), target: "CLAUDE.md" }).name.length, 64);
});

/* ── listRules / collectRuleContents 的兜底 ──────────────────────────────── */

test("listRules：stat 失败时该条仍然列出来，size 记 0", async () => {
  const h = mkHome();
  put(rulePath(h, "r1"), "abc");

  const orig = fs.promises.stat;
  fs.promises.stat = async () => { throw new Error("stat boom"); };
  let listed;
  try { listed = await listRules(h); } finally { fs.promises.stat = orig; }

  assert.deepEqual(listed.map((r) => [r.id, r.size]), [["r1", 0]]);
});

test("listRules：只收 .md 文件，非法 id 与子目录都不进列表", async () => {
  const h = mkHome();
  put(rulePath(h, "ok"), "x");
  put(path.join(rulesDir(h), "note.txt"), "x");
  put(path.join(rulesDir(h), "_bad.md"), "x");    // 下划线开头不符合 RULE_ID_RE
  fs.mkdirSync(path.join(rulesDir(h), "dir.md")); // 目录冒充规则
  const listed = await listRules(h);
  assert.deepEqual(listed.map((r) => r.id), ["ok"]);
});

test("activateRule：某条规则读不出来时跳过它，不打断备份", async () => {
  const h = mkHome();
  put(rulePath(h, "r1"), "RULE ONE");
  put(rulePath(h, "r2"), "RULE TWO");
  put(targetPath(h, "AGENTS.md"), "USER CONTENT");

  const orig = fs.readFileSync;
  fs.readFileSync = (fp, ...rest) => {
    if (String(fp) === rulePath(h, "r2")) throw new Error("read boom");
    return orig.call(fs, fp, ...rest);
  };
  let meta;
  try { meta = await activateRule(h, "r1"); } finally { fs.readFileSync = orig; }

  assert.deepEqual(meta, { name: "r1", target: "AGENTS.md" });
  assert.equal(read(targetPath(h, "AGENTS.md")), "RULE ONE");
  assert.equal(read(`${targetPath(h, "AGENTS.md")}.dsh-purge-rule.bak`), "USER CONTENT", "读不出来的那条不该拖垮备份");
});

test("activateRule：目标内容本来就是某条规则时不做备份", async () => {
  const h = mkHome();
  put(rulePath(h, "r1"), "SAME");
  put(rulePath(h, "r2"), "SAME");
  put(targetPath(h, "AGENTS.md"), "SAME");
  await activateRule(h, "r2");
  assert.equal(fs.existsSync(`${targetPath(h, "AGENTS.md")}.dsh-purge-rule.bak`), false);
});

test("activateRule：备份已存在时不覆盖它（用户原件只留第一份）", async () => {
  const h = mkHome();
  put(rulePath(h, "r1"), "RULE");
  put(targetPath(h, "AGENTS.md"), "CURRENT");
  put(`${targetPath(h, "AGENTS.md")}.dsh-purge-rule.bak`, "ORIGINAL");
  await activateRule(h, "r1");
  assert.equal(read(`${targetPath(h, "AGENTS.md")}.dsh-purge-rule.bak`), "ORIGINAL");
});

/* ── rulesStatus 的三态 ─────────────────────────────────────────────────── */

test("rulesStatus：active 指向的规则在、但目标文件不在 → exists/synced 都是 false 且不抛", async () => {
  const h = mkHome();
  put(rulePath(h, "r1"), "BODY");
  put(ruleMetaPath(h, "r1"), JSON.stringify({ name: "n", target: "AGENTS.md" }));
  await setActive(h, "r1");

  const st = await rulesStatus(h, "");
  assert.equal(st.active, "r1");
  assert.equal(st.active_target, "AGENTS.md");
  assert.equal(st.agents_exists, false);
  assert.equal(st.agents_synced, false);
});

test("rulesStatus：目标文件内容与规则一致时 synced 为 true，换一行就 false", async () => {
  const h = mkHome();
  put(rulePath(h, "r1"), "BODY\n");
  put(ruleMetaPath(h, "r1"), JSON.stringify({ name: "n", target: "AGENTS.md" }));
  await setActive(h, "r1");
  put(targetPath(h, "AGENTS.md"), "BODY\n");
  assert.equal((await rulesStatus(h, "")).agents_synced, true);

  put(targetPath(h, "AGENTS.md"), "BODY\n\n");
  const st = await rulesStatus(h, "");
  assert.equal(st.agents_exists, true);
  assert.equal(st.agents_synced, false);
});

/* ── ensureOperatorBody ─────────────────────────────────────────────────── */

test("ensureOperatorBody：没有 prompt-inject.md 时用内置默认正文，并挂到全局", async () => {
  const h = mkHome();
  const first = ensureOperatorBody(h);
  assert.ok(first.length > 1000, "内置默认正文是一长篇，不是空串");
  assert.equal(ensureOperatorBody(h), first, "同一个 home 两次结果一致");
  assert.equal(hungOperatorPrompt(), first, "挂上全局后，注入链读的是同一份");
});

test("ensureOperatorBody：prompt-inject.md 在手时用磁盘那份（不是内置默认）", async () => {
  const h = mkHome();
  const builtin = ensureOperatorBody(h);
  put(path.join(h, "prompt-inject.md"), "CUSTOM BODY");
  const body = ensureOperatorBody(h);
  assert.equal(body, "CUSTOM BODY");
  assert.notEqual(body, builtin);
});

/* ── 源码形状 ───────────────────────────────────────────────────────────── */

test("源码形状：回滚必须在重新抛错之前做完，且写盘只走 atomicWriteFile", () => {
  const src = fs.readFileSync(new URL("../lib/rules.js", import.meta.url), "utf8");
  // 回滚段与 throw e 的相对位置：先 if (wroteRule) … 再 throw e
  const rollback = src.indexOf("if (wroteRule) {");
  const rethrow = src.indexOf("throw e;", rollback);
  assert.ok(rollback > 0 && rethrow > rollback, "回滚要在 throw 之前");
  assert.ok(src.includes("if (wroteMeta && prevMeta !== null)"));
  assert.ok(src.includes("} else if (wroteMeta && prevMeta === null) {"));
  // 直接 writeFileSync 会绕过 atomicWriteFile（写 tmp + rename），半截文件正是回滚要处理的场景
  assert.ok(!/\bfsp\.writeFile\(rulePathStr/.test(src));
  assert.ok(!/\bfs\.writeFileSync\(rulePath/.test(src));
});