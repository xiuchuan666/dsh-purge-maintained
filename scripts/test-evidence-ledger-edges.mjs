/**
 * `lib/redteam/evidence-ledger.mjs` 的失败路径与「只能跑出来」的口径。
 *
 * 这个模块是红队演练的记录层：子智能体报「我拿到了」（claimed）、指挥智能体
 * 实测后升级成 observed。判错不会崩，它只会静默记账 —— 所以每一条 catch 背后
 * 都对应一种「看起来记上了、其实丢了」的现场：
 *
 *   · record 的 catch        → 写库失败时返回 { ok:false }，调用方必须看 ok
 *   · get 的 catch           → 读失败返回 undefined，与「没有这条」区分不开
 *   · list 的 catch          → 返回 { error } 对象而不是数组（形状变了）
 *   · countUnverified 的 catch → 返回 0，与「真的没有待核实」区分不开
 *   · countUnresolvedClaims 的 catch → 同上
 *   · residual_unknown 三个 catch   → 同上
 *
 * 另有两处「广告词与 schema 对不上」的现状：
 *   · resolve() 曾经认 'withdrawn'，而建表语句的 status CHECK 里没有它 →
 *     「撤回」从来没有成功过一次（本批修掉了，只保留 resolved|contradicted）
 *   · 去重键把空白折叠（`question.replace(/\s+/gu,' ').trim()`），但**存进库的是
 *     原始 `question.trim()`** → 两条「只差多个空格」的问题合成一条时，留下的是
 *     先写进去的那份版式
 *
 * 造失败的手法：把实例的 `db` 换成一个 prepare/exec 必抛的对象（模块只通过
 * `this.db` 摸库，换掉它等价于「库被别处关掉了」），`finally` 换回来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  EvidenceLedger,
  UnknownRegistry,
  EVIDENCE_LEDGER_DDL,
  EVIDENCE_CONFIDENCE,
  EVIDENCE_AUTHORITY,
  CONFIDENCE_REQUIRES_VERIFICATION,
  RESOLVE_DISPOSITIONS,
  evidenceId,
} from "../lib/redteam/evidence-ledger.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const LEDGER_SRC = fs.readFileSync(path.join(REPO, "lib/redteam/evidence-ledger.mjs"), "utf8");

const mkLedger = () => new EvidenceLedger(new DatabaseSync(":memory:"));
const mkUnknowns = () => new UnknownRegistry(new DatabaseSync(":memory:"));

/** 把实例的库句柄换成「一摸就炸」的假句柄，跑完换回来 */
function withBrokenDb(inst, fn, message = "prepare boom") {
  const keep = inst.db;
  const boom = () => {
    throw new Error(message);
  };
  inst.db = { prepare: boom, exec: boom };
  try {
    return fn();
  } finally {
    inst.db = keep;
  }
}

/* ── record 的四道前置校验 ───────────────────────────────────────────── */

test("record: 没有 operation、或 operation 不是字符串，都拒绝并给同一句提示", () => {
  const l = mkLedger();
  const msg = "operation is required and must be a string";
  assert.deepEqual(l.record({ result: 1 }), { ok: false, error: msg });
  assert.deepEqual(l.record({ operation: 42, result: 1 }), { ok: false, error: msg });
  assert.deepEqual(l.record({ operation: "", result: 1 }), { ok: false, error: msg });
  // 一条都没写进去
  assert.deepEqual(l.list(), []);
});

test("record: result 缺失或为 null 都拒绝（空字符串 / 0 / false 是合法结果）", () => {
  const l = mkLedger();
  assert.deepEqual(l.record({ operation: "id" }), { ok: false, error: "result is required" });
  assert.deepEqual(l.record({ operation: "id", result: null }), { ok: false, error: "result is required" });
  assert.equal(l.record({ operation: "id", result: "" }).ok, true);
  assert.equal(l.record({ operation: "id", result: 0 }).ok, true);
  assert.equal(l.record({ operation: "id", result: false }).ok, true);
});

test("record: confidence 不在四档里，提示把四档全列出来", () => {
  const l = mkLedger();
  const r = l.record({ operation: "id", result: 1, confidence: "maybe" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "confidence must be one of claimed,observed,derived,inferred");
  assert.equal(r.error, "confidence must be one of " + EVIDENCE_CONFIDENCE.join(","));
});

test("record: authority 不在六种里，提示把六种全列出来", () => {
  const l = mkLedger();
  const r = l.record({ operation: "id", result: 1, authority: "vibes" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "authority must be one of " + EVIDENCE_AUTHORITY.join(","));
  assert.match(r.error, /^authority must be one of tool-output,database-record,screenshot,request-replay,subagent-report,operator-input$/);
});

/* ── record 的真值：语义哈希与落库字段 ───────────────────────────────── */

test("evidenceId: 键序不影响哈希，改一个字节就换一个 ev_id", () => {
  assert.equal(evidenceId({ b: 1, a: 2 }), evidenceId({ a: 2, b: 1 }));
  assert.notEqual(evidenceId({ a: 1 }), evidenceId({ a: 2 }));
  assert.match(evidenceId({ a: 1 }), /^ev_[0-9a-f]{64}$/);
  // 数组顺序参与语义（不是集合）
  assert.notEqual(evidenceId([1, 2]), evidenceId([2, 1]));
});

test("record: 同内容第二次进库返回 duplicate:true，且 ev_id 一字不差", () => {
  const l = mkLedger();
  const args = { operation: "id", result: { out: "uid=0" }, engagement_id: "e1" };
  const first = l.record(args);
  const again = l.record(args);
  assert.deepEqual(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.ev_id, first.ev_id);
  assert.equal(l.list().length, 1);
});

test("record: 可选字段缺省时落成 null / 空数组，不是 undefined", () => {
  const l = mkLedger();
  const r = l.record({ operation: "id", result: 1 });
  const row = l.get(r.ev_id);
  assert.equal(row.raw_ref, null);
  assert.equal(row.recorded_by, null);
  assert.equal(row.source_agent, null);
  assert.equal(row.engagement_id, null);
  assert.deepEqual(row.limitations, []);
  assert.deepEqual(row.supporting_ev_ids, []);
  assert.equal(typeof row.recorded_at, "string");
  assert.match(row.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("record: 写库失败返回 ok:false，错误文本取 err.message（不是整个 Error）", () => {
  const l = mkLedger();
  const r = withBrokenDb(l, () => l.record({ operation: "id", result: 1 }));
  assert.deepEqual(r, { ok: false, error: "prepare boom" });
});

/* ── get ─────────────────────────────────────────────────────────────── */

test("get: 没有这条就返回 undefined（与「读盘失败」同一个返回值）", () => {
  const l = mkLedger();
  assert.equal(l.get("ev_none"), undefined);
  assert.equal(withBrokenDb(l, () => l.get("ev_none")), undefined);
});

test("get: 库里的 JSON 列坏了也不抛，四个字段各自回落到默认值", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(EVIDENCE_LEDGER_DDL);
  db.prepare(
    `INSERT INTO evidence (ev_id, confidence, authority, operation, parameters, result, limitations, supporting_ev_ids, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run("ev_bad", "observed", "tool-output", "id", "not-json", "also{", "nope", "", "2026-01-01T00:00:00.000Z");
  const l = new EvidenceLedger(db);
  const row = l.get("ev_bad");
  assert.deepEqual(row.parameters, {});
  assert.equal(row.result, null);
  assert.deepEqual(row.limitations, []);
  assert.deepEqual(row.supporting_ev_ids, []);
  assert.equal(row.operation, "id", "非 JSON 的列照原样给出");
  // list 走同一条解析路径
  assert.deepEqual(l.list().map((r) => [r.ev_id, r.parameters, r.result]), [["ev_bad", {}, null]]);
});

/* ── upgrade ─────────────────────────────────────────────────────────── */

test("upgrade: 四档里只有 claimed / inferred 需要升级", () => {
  assert.deepEqual([...CONFIDENCE_REQUIRES_VERIFICATION], ["claimed", "inferred"]);
  const l = mkLedger();
  assert.deepEqual(l.upgrade({ claimed_ev_id: "ev_none" }), { ok: false, error: "evidence not found: ev_none" });

  const derived = l.record({ operation: "d", result: 9, confidence: "derived" });
  assert.deepEqual(l.upgrade({ claimed_ev_id: derived.ev_id }), {
    ok: false,
    error: "confidence 'derived' does not require upgrade",
  });

  const observed = l.record({ operation: "o", result: 10, confidence: "observed" });
  assert.deepEqual(l.upgrade({ claimed_ev_id: observed.ev_id }), { ok: true, ev_id: observed.ev_id });
});

test("upgrade: claimed 升成 observed 时写一条新证据，用 supporting_ev_ids 链回原件", () => {
  const l = mkLedger();
  const claimed = l.record({ operation: "suo5", result: { ok: true }, confidence: "claimed", authority: "subagent-report", engagement_id: "e1" });
  const up = l.upgrade({ claimed_ev_id: claimed.ev_id, verified_by: "op", verified_result: { out: "uid=0 NOW" } });
  assert.equal(up.ok, true);
  assert.notEqual(up.ev_id, claimed.ev_id, "升级不是原地改，是一条新记录");
  const row = l.get(up.ev_id);
  assert.equal(row.confidence, "observed");
  assert.equal(row.authority, "tool-output", "subagent-report 进库前被换成 tool-output");
  assert.equal(row.recorded_by, "op");
  assert.deepEqual(row.supporting_ev_ids, [claimed.ev_id]);
  assert.deepEqual(row.result, { out: "uid=0 NOW" });
  // 原件仍在（审计纪律：claimed 永久保留）
  assert.equal(l.get(claimed.ev_id).confidence, "claimed");
});

test("upgrade: 不给 verified_by / verified_result 时，记成 coordinator 并沿用原件的结果", () => {
  const l = mkLedger();
  const claimed = l.record({ operation: "x", result: 11, confidence: "claimed", authority: "subagent-report", source_agent: "s1", engagement_id: "e2" });
  const up = l.upgrade({ claimed_ev_id: claimed.ev_id });
  const row = l.get(up.ev_id);
  assert.equal(row.recorded_by, "coordinator");
  assert.equal(row.result, 11);
  assert.equal(row.source_agent, "s1", "source_agent / engagement_id 一路带过来");
  assert.equal(row.engagement_id, "e2");
});

/* ── list ────────────────────────────────────────────────────────────── */

test("list: 三个过滤条件可叠加，并按 recorded_at 倒序（时间戳拉得开时）", () => {
  const l = mkLedger();
  const a1 = l.record({ operation: "a", result: 1, confidence: "observed", engagement_id: "e1" });
  const b2 = l.record({ operation: "b", result: 2, confidence: "claimed", engagement_id: "e1" });
  const a3 = l.record({ operation: "a", result: 3, confidence: "claimed", engagement_id: "e2" });
  // 三条常常落在同一毫秒里，先手动把时间戳拉开，才能验证 ORDER BY
  const setAt = l.db.prepare("UPDATE evidence SET recorded_at = ? WHERE ev_id = ?");
  setAt.run("2026-01-01T00:00:01.000Z", a1.ev_id);
  setAt.run("2026-01-01T00:00:03.000Z", a3.ev_id);
  setAt.run("2026-01-01T00:00:02.000Z", b2.ev_id);

  assert.deepEqual(l.list().map((r) => r.result), [3, 2, 1]);
  assert.deepEqual(l.list({ operation: "a" }).map((r) => r.result), [3, 1]);
  assert.deepEqual(l.list({ confidence: "claimed" }).map((r) => r.result), [3, 2]);
  assert.deepEqual(l.list({ operation: "a", engagement_id: "e2" }).map((r) => r.result), [3]);
  assert.deepEqual(l.list({ engagement_id: "nope" }), []);
  assert.equal(l.list({ limit: 1 }).length, 1);
  assert.deepEqual(l.list({ limit: 1, offset: 2 }).map((r) => r.result), [1]);
});

test("list: 同一毫秒内写入的多条之间，先后顺序不保证（不要依赖它做「最新一条」）", () => {
  // recorded_at 是 `new Date().toISOString()`（毫秒精度）。连续写三条常常落在同一
  // 毫秒里，此时 ORDER BY recorded_at DESC 之间没有稳定次序 —— 所以这里只断言集合，
  // 不断言顺序，也不断言「三条时间戳必然相同」（机器慢一点就会跨毫秒，那是假红）。
  const l = mkLedger();
  for (const n of [1, 2, 3]) l.record({ operation: "same", result: n });
  const rows = l.list({ operation: "same" });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.result).sort(), [1, 2, 3], "只保证集合");
  assert.equal(l.list({ operation: "same", limit: 2 }).length, 2);
  assert.equal(new Set(rows.map((r) => r.recorded_at)).size <= 2, true, "毫秒精度：最多跨两个值");
});

test("list: 读库失败返回的是 { error } 对象，不是数组（现状：调用方拿不到 length）", () => {
  const l = mkLedger();
  const r = withBrokenDb(l, () => l.list());
  assert.equal(Array.isArray(r), false);
  assert.deepEqual(r, { error: "prepare boom" });
});

/* ── 两个计数 ────────────────────────────────────────────────────────── */

test("countUnverified: 数 claimed + inferred 的裸条数，observed / derived 不算", () => {
  const l = mkLedger();
  assert.equal(l.countUnverified("e2"), 0);
  l.record({ operation: "a", result: 1, confidence: "claimed", engagement_id: "e2" });
  l.record({ operation: "b", result: 2, confidence: "inferred", engagement_id: "e2" });
  l.record({ operation: "c", result: 3, confidence: "observed", engagement_id: "e2" });
  l.record({ operation: "d", result: 4, confidence: "derived", engagement_id: "e2" });
  l.record({ operation: "e", result: 5, confidence: "claimed", engagement_id: "other" });
  assert.equal(l.countUnverified("e2"), 2);
});

test("countUnverified: 不传靶标、或读库失败，都回 0（与「真的没有待核实」不可区分）", () => {
  const l = mkLedger();
  l.record({ operation: "a", result: 1, confidence: "claimed", engagement_id: "e2" });
  assert.equal(l.countUnverified(), 0);
  assert.equal(withBrokenDb(l, () => l.countUnverified("e2")), 0);
});

test("countUnresolvedClaims: 有条目被任何一条 observed 引用过就算闭环", () => {
  const l = mkLedger();
  const c1 = l.record({ operation: "a", result: 1, confidence: "claimed", engagement_id: "e2" });
  l.record({ operation: "b", result: 2, confidence: "inferred", engagement_id: "e2" });
  assert.equal(l.countUnresolvedClaims("e2"), 2);
  l.record({ operation: "verify-a", result: 1, confidence: "observed", supporting_ev_ids: [c1.ev_id], engagement_id: "e2" });
  assert.equal(l.countUnresolvedClaims("e2"), 1, "c1 已闭环，只剩 inferred 那条");
  // 裸条数不会跟着降：审计纪律要求 claimed 永久保留
  assert.equal(l.countUnverified("e2"), 2);
});

test("countUnresolvedClaims: 不传靶标、或读库失败，都回 0", () => {
  const l = mkLedger();
  l.record({ operation: "a", result: 1, confidence: "claimed", engagement_id: "e2" });
  assert.equal(l.countUnresolvedClaims(), 0);
  assert.equal(withBrokenDb(l, () => l.countUnresolvedClaims("e2")), 0);
});

/* ── UnknownRegistry ─────────────────────────────────────────────────── */

test("unknown.record: question 必填且必须是字符串", () => {
  const u = mkUnknowns();
  const msg = "question is required";
  assert.deepEqual(u.record({}), { ok: false, error: msg });
  assert.deepEqual(u.record({ question: 7 }), { ok: false, error: msg });
  assert.deepEqual(u.record({ question: "   " }).ok, true, "只有空白的字符串照样进库（现状）");
});

test("unknown.record: severity 只认 low|medium|high|critical，默认 medium", () => {
  const u = mkUnknowns();
  assert.deepEqual(u.record({ question: "q", severity: "urgent" }), {
    ok: false,
    error: "severity must be low|medium|high|critical",
  });
  const def = u.record({ question: "默认档" });
  const row = u.list().find((r) => r.unk_id === def.unk_id);
  assert.equal(row.severity, "medium");
  assert.equal(row.domain, "general");
  assert.equal(row.status, "open");
  assert.equal(row.revision, 1);
  assert.equal(row.recorded_by, "coordinator");
});

test("unknown.record: 去重键折叠空白，但存进去的是 trim 后的原文（两处口径不同）", () => {
  const u = mkUnknowns();
  const first = u.record({ question: "10.0.3.7:22  的 SSH 凭据是什么？", domain: "internal-recon", severity: "high" });
  const second = u.record({ question: "10.0.3.7:22 的 SSH 凭据是什么？", domain: "internal-recon" });
  assert.equal(second.duplicate, true, "只差空白 → 判为同一条");
  assert.equal(second.unk_id, first.unk_id);
  assert.equal(u.list().length, 1);
  assert.equal(u.list()[0].question, "10.0.3.7:22  的 SSH 凭据是什么？", "留下的是先写进去的那份版式（内部双空格还在）");
});

test("unknown.record: 写库失败返回 ok:false", () => {
  const u = mkUnknowns();
  assert.deepEqual(withBrokenDb(u, () => u.record({ question: "q2" })), { ok: false, error: "prepare boom" });
});

test("unknown.resolve: disposition 只认 resolved|contradicted，'withdrawn' 现在给的是干净校验错", () => {
  assert.deepEqual(RESOLVE_DISPOSITIONS, ["resolved", "contradicted"]);
  const u = mkUnknowns();
  const rec = u.record({ question: "q" });
  const msg = "disposition must be resolved|contradicted";
  assert.deepEqual(u.resolve(rec.unk_id, "done", "x"), { ok: false, error: msg });
  // 1.1.94 这里会一路走到 SQLite，返回 CHECK constraint failed
  assert.deepEqual(u.resolve(rec.unk_id, "withdrawn", "x"), { ok: false, error: msg });
  assert.equal(u.list().find((r) => r.unk_id === rec.unk_id).status, "open", "被拒的那次没有改库");
});

test("unknown.resolve: 标 resolved 后写 status / resolution / resolved_at", () => {
  const u = mkUnknowns();
  const rec = u.record({ question: "q" });
  assert.deepEqual(u.resolve(rec.unk_id, "resolved", "实测 root/root"), { ok: true, unk_id: rec.unk_id });
  const row = u.list({ status: "resolved" })[0];
  assert.equal(row.status, "resolved");
  assert.equal(row.resolution, "实测 root/root");
  assert.match(row.resolved_at, /^\d{4}-\d{2}-\d{2}T/);
  // resolution 可省 → 落成 null
  const rec2 = u.record({ question: "q2" });
  u.resolve(rec2.unk_id, "contradicted");
  assert.equal(u.list({ status: "contradicted" })[0].resolution, null);
});

test("unknown.resolve: 写库失败返回 ok:false", () => {
  const u = mkUnknowns();
  const rec = u.record({ question: "q" });
  assert.deepEqual(withBrokenDb(u, () => u.resolve(rec.unk_id, "resolved", "x")), {
    ok: false,
    error: "prepare boom",
  });
});

test("unknown.list: 不传 status 时列出全部（含已解决的），失败返回 { error }", () => {
  const u = mkUnknowns();
  const a = u.record({ question: "q1", engagement_id: "e3" });
  u.record({ question: "q2", engagement_id: "e3" });
  u.resolve(a.unk_id, "resolved", "done");
  assert.equal(u.list().length, 2);
  assert.equal(u.list({ status: "open" }).length, 1);
  assert.equal(u.list({ engagement_id: "e3" }).length, 2);
  assert.deepEqual(u.list({ severity: "critical" }), []);
  const broken = withBrokenDb(u, () => u.list());
  assert.equal(Array.isArray(broken), false);
  assert.deepEqual(broken, { error: "prepare boom" });
});

/* ── 源码形状：广告词必须与表约束一致 ────────────────────────────────── */

test("源码形状: resolve 的取值表必须是 DDL 里 status CHECK 的子集，且两边都不再出现 withdrawn", () => {
  const check = LEDGER_SRC.match(/status TEXT NOT NULL DEFAULT 'open'\s*\r?\n\s*CHECK\(status IN \(([^)]*)\)\)/);
  assert.ok(check, "找不到 residual_unknown 的 status CHECK");
  const allowed = check[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
  assert.deepEqual(allowed, ["open", "investigating", "blocked", "contradicted", "resolved"]);
  for (const d of RESOLVE_DISPOSITIONS) {
    assert.ok(allowed.includes(d), `resolve 认的 ${d} 必须在 status CHECK 里`);
  }
  assert.equal(allowed.includes("withdrawn"), false);
  assert.equal(RESOLVE_DISPOSITIONS.includes("withdrawn"), false);
  // 整个文件不再把这个词写进任何字符串（注释里允许出现，作为历史说明）
  const code = LEDGER_SRC.split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
    .join("\n");
  assert.equal(code.includes("'withdrawn'"), false, "代码里不该再出现 'withdrawn'");
});

test("源码形状: 工具说明书不再宣传 withdrawn（说明与实际写库能力一致）", () => {
  const spec = fs.readFileSync(path.join(REPO, "lib/redteam/tool-specs-evidence.js"), "utf8");
  const block = spec.slice(spec.indexOf("name: 'redteam_unknown_resolve'"), spec.indexOf("name: 'redteam_unknown_list'"));
  assert.ok(block.length > 200, "找不到 redteam_unknown_resolve 的定义");
  assert.equal(block.includes("withdrawn"), false);
  assert.ok(block.includes("resolved | contradicted"));
});
