/**
 * lib/redteam/role-section.js 的边角：角色表的淘汰、读文件失败、外层兜底。
 *
 * 这份文件只管「红队子会话拿到哪份角色稿」。判错的表现是：长开进程里角色表
 * 一直涨（`roleBySession` 是模块级 Map，跨 install/dispose 不清），或者角色稿
 * 读不出来时把整条系统提示词装配搞崩。三条边角都不报错，只会静默给空串。
 *
 * 与 test-role-section.mjs（23 条）分工：那一份钉解析与「谁算红队子会话」，
 * 这一份钉 400 条上限、读文件失败、以及外层 catch 三条。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "dshp-role-edges-"));
const ORIG_HOME = process.env.DSH_HOME;
const HOME = path.join(ROOT, "home");
process.env.DSH_HOME = HOME;

const mod = await import("../lib/redteam/role-section.js");
const SRC = readFileSync(new URL("../lib/redteam/role-section.js", import.meta.url), "utf8");

test.after(() => {
  if (ORIG_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIG_HOME;
  rmSync(ROOT, { recursive: true, force: true });
});

const FILE_TEXT = "你是侦察手。";
const ENG = "eng-1";
const AGENTS = path.join(HOME, "redteam", "engagements", ENG, "agents");

function writeRole(role, body) {
  mkdirSync(AGENTS, { recursive: true });
  writeFileSync(path.join(AGENTS, `${role}.md`), body, "utf8");
}

mkdirSync(path.join(HOME, "redteam"), { recursive: true });
writeFileSync(path.join(HOME, "redteam", "current"), ENG, { encoding: "utf8" });
writeRole("recon", FILE_TEXT);

const subAgent = (id) => ({
  id,
  session: {
    id,
    header: { origin: "subagent", delegationDepth: 1, agentPreset: "redteam" },
  },
});

const note = (id, role) =>
  mod.noteClaimedMessage({
    agent: subAgent(id),
    message: { content: `redteamRole: ${role}` },
  });

const roleOf = (id) => mod.resolveSubagentRoleText({ agent: subAgent(id) });

// —— 角色表上限：模块级 Map，跨用例共享，所以下面三条必须按顺序跑 ——
const CAP = 400;
const EVICT = 100;

test("补到 399 条时不淘汰：最早那条还在", () => {
  for (let i = 0; i < 399; i += 1) note(`cap-a${i}`, "recon");
  assert.equal(roleOf("cap-a0"), FILE_TEXT);
  assert.equal(roleOf(`cap-a${398}`), FILE_TEXT);
});

test("补到 400 条仍未淘汰（淘汰发生在写入之前）", () => {
  note("cap-a399", "recon");
  assert.equal(roleOf("cap-a0"), FILE_TEXT);
});

test("第 401 条触发淘汰：按插入顺序删掉最早 100 条，第 101 条起保留", () => {
  note("cap-a400", "recon");
  assert.equal(roleOf("cap-a99"), "");
  assert.equal(roleOf(`cap-a${EVICT}`), FILE_TEXT);
  assert.equal(roleOf("cap-a399"), FILE_TEXT);
  assert.equal(roleOf("cap-a400"), FILE_TEXT);
});

test("淘汰后表只剩 301 条（400 - 100 + 1），再补到上限时再淘汰一次", () => {
  for (let i = 401; i <= 499; i += 1) note(`cap-a${i}`, "recon");
  assert.equal(roleOf(`cap-a${EVICT}`), FILE_TEXT);
  note("cap-a500", "recon");
  assert.equal(roleOf(`cap-a${EVICT}`), "");
  assert.equal(roleOf(`cap-a${EVICT + 100}`), FILE_TEXT);
});

test("读得到角色稿时原样返回（trim 掉首尾空白）", () => {
  writeRole("recon", "  你是侦察手。  \n");
  note("read-ok", "recon");
  assert.equal(roleOf("read-ok"), FILE_TEXT);
});

test("角色稿不存在时回空串，不抛", () => {
  note("read-missing", "recon");
  rmSync(path.join(AGENTS, "recon.md"), { force: true });
  assert.equal(roleOf("read-missing"), "");
  writeRole("recon", FILE_TEXT);
});

test("角色稿是目录时读文件抛错被吞掉，回空串（覆盖 readRoleFile 的 catch）", () => {
  mkdirSync(path.join(AGENTS, "vuln-scan.md"), { recursive: true });
  note("read-dir", "vuln-scan");
  assert.equal(roleOf("read-dir"), "");
  rmSync(path.join(AGENTS, "vuln-scan.md"), { recursive: true, force: true });
});

test("agents 目录不在时当前靶标算不出来，回空串", () => {
  writeFileSync(path.join(HOME, "redteam", "current"), "eng-none", { encoding: "utf8" });
  note("no-eng", "recon");
  assert.equal(roleOf("no-eng"), "");
  writeFileSync(path.join(HOME, "redteam", "current"), ENG, { encoding: "utf8" });
});

const DOT_ID = "eng..x";

function seedEngagement(id, role) {
  const dir = path.join(HOME, "redteam", "engagements", id, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${role}.md`), FILE_TEXT, "utf8");
  writeFileSync(path.join(HOME, "redteam", "current"), id, "utf8");
}

function restoreCurrent() {
  writeFileSync(path.join(HOME, "redteam", "current"), ENG, "utf8");
}

test("current 里带 .. 时整条当没有靶标（路径穿越防线）", () => {
  seedEngagement(DOT_ID, "recon");
  note("safe-dot", "recon");
  assert.equal(roleOf("safe-dot"), "");
  restoreCurrent();
});

test("context.agent 读取抛错时外层 catch 兜住，回空串", () => {
  const boom = {};
  Object.defineProperty(boom, "agent", {
    get() {
      throw new Error("agent boom");
    },
  });
  assert.equal(mod.resolveSubagentRoleText(boom), "");
});

test("context.agent.session 读取抛错同样兜住", () => {
  const agent = {};
  Object.defineProperty(agent, "session", {
    get() {
      throw new Error("session boom");
    },
  });
  assert.equal(mod.resolveSubagentRoleText({ agent }), "");
});

test("源码形状：上限 400、每次淘汰 100、淘汰发生在写入之前", () => {
  assert.match(SRC, /const ROLE_SESSION_CAP = 400\r?\n/);
  assert.match(SRC, /const ROLE_SESSION_EVICT = 100\r?\n/);
  assert.match(SRC, /if \(roleBySession\.size < ROLE_SESSION_CAP\) return\r?\n/);
  assert.match(
    SRC,
    /if \(ids\.length\) evictRoleBySessionIfOverflow\(\)\r?\n {2}for \(const id of ids\) roleBySession\.set\(String\(id\), role\)/,
  );
  assert.match(SRC, /if \(i >= ROLE_SESSION_EVICT\) break\r?\n/);
});

test("源码形状：三处「读不出来就回空串」都必须留 catch，不许改成抛", () => {
  const code = SRC.split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.match(code, /return readFileSync\(path, 'utf8'\)\.trim\(\)\r?\n {2}\} catch \{\r?\n {4}return ''/);
  assert.match(code, /if \(!text \|\| text\.length > 200\) return ''/);
  assert.match(code, /if \(!existsSync\(join\(root, 'engagements', id, 'agents'\)\)\) return ''/);
  assert.match(code, /safeEngagementId\(readFileSync\(join\(root, 'current'\), 'utf8'\)\)/);
  assert.doesNotMatch(code, /throw new Error\(/);
});
