import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPreviewRow,
  summarizePreview,
  describePreview,
  isPrerelease,
} from "./host-preview-lib.mjs";

// ---------- 一、单条补丁的归类 ----------

test("锚点被上游改掉：基线是 settled、预演是 drifted → broken-by-upgrade", () => {
  const row = classifyPreviewRow({ id: 13, name: "X", before: "settled", after: "drifted" });
  assert.equal(row.kind, "broken-by-upgrade");
  assert.equal(row.was, "settled");
  assert.equal(row.now, "drifted");
});

test("基线本来就坏、预演还坏 → already-broken（不算这次升级打坏的）", () => {
  const row = classifyPreviewRow({ id: 1, name: "X", before: "drifted", after: "drifted" });
  assert.equal(row.kind, "already-broken");
});

test("unmatched 与 pattern_not_found 都算打不上", () => {
  assert.equal(classifyPreviewRow({ id: 2, before: "settled", after: "unmatched" }).kind, "broken-by-upgrade");
  assert.equal(
    classifyPreviewRow({ id: 3, before: "settled", after: "pattern_not_found" }).kind,
    "broken-by-upgrade",
  );
});

test("预演里没有这个补丁的状态 → 记 missing_file，归到不适用", () => {
  const row = classifyPreviewRow({ id: 4, before: "settled", after: undefined });
  assert.equal(row.now, "missing_file");
  assert.equal(row.kind, "not-applicable");
});

test("no-file / na / skipped / missing_file 都归不适用，不参与「升级打断」计数", () => {
  for (const st of ["no-file", "na", "skipped", "missing_file"]) {
    assert.equal(classifyPreviewRow({ id: 5, before: "no-file", after: st }).kind, "not-applicable", st);
  }
});

test("预演是 pending → ok（这一版还需要打，但锚点在）", () => {
  const row = classifyPreviewRow({ id: 6, before: "settled", after: "pending" });
  assert.equal(row.kind, "ok");
});

test("预演是 applied / already → ok", () => {
  assert.equal(classifyPreviewRow({ id: 7, before: "settled", after: "applied" }).kind, "ok");
  assert.equal(classifyPreviewRow({ id: 8, before: "settled", after: "already" }).kind, "ok");
});

test("基线里没有这条补丁（was 为空）时，坏掉算 broken-by-upgrade 而不是 already-broken", () => {
  const row = classifyPreviewRow({ id: 9, before: undefined, after: "drifted" });
  assert.equal(row.was, "");
  assert.equal(row.kind, "broken-by-upgrade");
});

// ---------- 二、整批计数 ----------

test("计数把四种归类分开累加", () => {
  const rows = [
    { kind: "ok" },
    { kind: "ok" },
    { kind: "broken-by-upgrade" },
    { kind: "already-broken" },
    { kind: "not-applicable" },
    { kind: "not-applicable" },
    { kind: "not-applicable" },
  ];
  const { counts, total } = summarizePreview(rows);
  assert.deepEqual(counts, { ok: 2, "broken-by-upgrade": 1, "already-broken": 1, "not-applicable": 3 });
  assert.equal(total, 7);
});

test("空输入不抛，计数全 0", () => {
  assert.deepEqual(summarizePreview([]), { counts: { ok: 0, "broken-by-upgrade": 0, "already-broken": 0, "not-applicable": 0 }, total: 0 });
  assert.equal(summarizePreview(undefined).total, 0);
});

test("出现没见过的 kind 也照样累加，不静默丢弃", () => {
  const { counts } = summarizePreview([{ kind: "weird" }]);
  assert.equal(counts.weird, 1);
});

// ---------- 三、结论 ----------

const summaryOf = (rows) => summarizePreview(rows);

test("有升级打断的条目 → breaking，且点名最多 8 条", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, kind: "broken-by-upgrade" }));
  const out = describePreview({ rows, summary: summaryOf(rows), hostVersion: "0.2.2-rc.2", baseVersion: "0.2.2-rc.1" });
  assert.equal(out.verdict, "breaking");
  assert.match(out.detail, /9 条补丁的锚点被上游改掉/);
  assert.match(out.detail, /#1 P1/);
  assert.match(out.detail, /等/);
  assert.doesNotMatch(out.detail, /#9 P9/);
});

test("只有 8 条及以内时不加「等」", () => {
  const rows = [{ id: 1, name: "A", kind: "broken-by-upgrade" }];
  const out = describePreview({ rows, summary: summaryOf(rows), hostVersion: "x", baseVersion: "y" });
  assert.doesNotMatch(out.detail, /等/);
});

test("正好 8 条时仍然不加「等」—— 边界就在 8 与 9 之间", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, kind: "broken-by-upgrade" }));
  const out = describePreview({ rows, summary: summaryOf(rows), hostVersion: "x", baseVersion: "y" });
  assert.match(out.detail, /#8 P8/);
  assert.doesNotMatch(out.detail, /等/);
});

test("第 9 条开始才加「等」，且被截掉的是第 9 条", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, kind: "broken-by-upgrade" }));
  const out = describePreview({ rows, summary: summaryOf(rows), hostVersion: "x", baseVersion: "y" });
  assert.match(out.detail, /#8 P8/);
  assert.doesNotMatch(out.detail, /#9 P9/);
  assert.match(out.detail, /等/);
});

test("没有任何升级打断 → compatible，并报可打条数", () => {
  const rows = [
    { id: 1, name: "A", kind: "ok" },
    { id: 2, name: "B", kind: "ok" },
    { id: 3, name: "C", kind: "not-applicable" },
  ];
  const out = describePreview({ rows, summary: summaryOf(rows), hostVersion: "0.2.3", baseVersion: "0.2.2-rc.1" });
  assert.equal(out.verdict, "compatible");
  assert.match(out.detail, /3 条补丁全部可打/);
  assert.match(out.detail, /可打 2 条/);
});

test("already-broken 不把结论压成 breaking", () => {
  const rows = [{ id: 1, name: "A", kind: "already-broken" }, { id: 2, name: "B", kind: "ok" }];
  const out = describePreview({ rows, summary: summaryOf(rows), hostVersion: "x", baseVersion: "y" });
  assert.equal(out.verdict, "compatible");
});

test("空批量 → no-data", () => {
  const out = describePreview({ rows: [], summary: summaryOf([]), hostVersion: "x", baseVersion: "y" });
  assert.equal(out.verdict, "no-data");
});

test("结论里带上目标版本与当前记录版本，缺省显示问号", () => {
  const out = describePreview({ rows: [{ id: 1, name: "A", kind: "ok" }], summary: summaryOf([{ id: 1, kind: "ok" }]) });
  assert.match(out.detail, /目标 \?（当前记录 \?）/);
});

// ---------- 四、预发布识别 ----------

test("rc / alpha / beta / pre / next 都是预发布", () => {
  for (const v of ["0.2.2-rc.1", "0.2.2-rc.2", "0.2.2-alpha.3", "1.0.0-beta.1", "2.0.0-pre.4", "3.0.0-next.2"]) {
    assert.equal(isPrerelease(v), true, v);
  }
});

test("正式版本不是预发布", () => {
  for (const v of ["0.2.2", "1.1.94", "0.2.1", "0.2.2-patch.1"]) {
    assert.equal(isPrerelease(v), false, v);
  }
});

test("空值与 undefined 不算预发布", () => {
  assert.equal(isPrerelease(""), false);
  assert.equal(isPrerelease(undefined), false);
  assert.equal(isPrerelease(null), false);
});

test("大小写不敏感", () => {
  assert.equal(isPrerelease("0.2.2-RC.2"), true);
  assert.equal(isPrerelease("0.2.2-Beta.1"), true);
});

// ---------- 五、真实形状回归（rc.2 那次预演的实际数据） ----------

test("rc.2 实测的那 6 条都能被识别成 broken-by-upgrade", () => {
  const broken = [
    [13, "ESCALATION_WIDENING_EXEMPT"],
    [18, "REPEAT_TOOL_REMINDER_DISABLED"],
    [35, "ESCALATION_NEVER_REJECT"],
    [56, "REWIND_HIDE_CUT_ONLY"],
    [77, "REWIND_DROP_SENT_ON_APPEND"],
    [62, "OFFICIAL_TOOL_ASK_FAILOPEN"],
  ];
  const rows = broken.map(([id, name]) => classifyPreviewRow({ id, name, before: "settled", after: "drifted" }));
  assert.equal(rows.filter((r) => r.kind === "broken-by-upgrade").length, 6);
  const out = describePreview({ rows, summary: summarizePreview(rows), hostVersion: "0.2.2-rc.2", baseVersion: "0.2.2-rc.1" });
  assert.equal(out.verdict, "breaking");
  assert.match(out.detail, /ESCALATION_WIDENING_EXEMPT/);
});
