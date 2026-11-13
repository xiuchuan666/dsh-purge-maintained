// patch-outcome 的五态判定是这个项目唯一回答「补丁还有效吗 / 该退役吗」的地方。
//
// 这个模块坏掉的方式：
//   1. 纯净树上报 applied —— 等于告诉用户「已经打好了」，而实际一条没打；
//   2. 多文件补丁被某个软文件拖成 stale —— 退役清单塞满噪音，真正的退役信号被淹没；
//   3. 撤销型补丁（自己撤自己）被判 stale —— 清理动作被当成待修；
//   4. 锚点过期（基线还活着）被判 stale —— 该改锚点的被判该退役，两条维护动作搞混。
// 四条都会让「哪些旧补丁不用打了」这个回答失真，所以每一条都在下面钉了用例。
import test from "node:test";
import assert from "node:assert/strict";
import {
  PATCH_STATES,
  STATE_LIST,
  UNKNOWN,
  TRACE_TOKEN,
  classifyFile,
  classifyPatch,
  rollupStates,
  tallyStates,
  needsAttention,
  isRetractionPatch,
  countPatternHits,
  markerPresent,
  productPresent,
  patchTracePresent,
  patchReplacements,
  patchMarkers,
  matchesPattern,
  normalizeText,
} from "../lib/patch-outcome.mjs";

// 造一条最小可判的补丁：一条 pattern 一条 replace，产物首行唯一。
function patchOf(over) {
  return Object.assign(
    {
      id: 900,
      name: "FIXTURE",
      layer: "代码",
      replacements: [{ pattern: "ORIGINAL_LINE", replace: "PATCHED_LINE" }],
      markers: ["[dsh-purge] fixture marker"],
    },
    over || {},
  );
}

test("STATE_LIST 覆盖 PATCH_STATES 全部取值且不重复", function () {
  const fromObject = Object.keys(PATCH_STATES).map(function (k) { return PATCH_STATES[k]; });
  assert.deepEqual([...STATE_LIST].sort(), [...fromObject].sort());
  assert.equal(new Set(STATE_LIST).size, STATE_LIST.length);
});

test("normalizeText 把 CRLF 折成 LF", function () {
  assert.equal(normalizeText("a\r\nb\r\n"), "a\nb\n");
  assert.equal(normalizeText(""), "");
});

test("patchReplacements 同时认 replacements[] 与 patterns[]+replace", function () {
  assert.equal(patchReplacements(patchOf({})).length, 1);
  const legacy = patchOf({ replacements: undefined, patterns: ["A", "B"], replace: "C" });
  const reps = patchReplacements(legacy);
  assert.equal(reps.length, 2);
  assert.equal(reps[0].pattern, "A");
  assert.equal(reps[0].replace, "C");
});

test("patchMarkers 合并 marker 与 markers 两个字段名", function () {
  assert.deepEqual(patchMarkers({ marker: "M1" }), ["M1"]);
  assert.deepEqual(patchMarkers({ markers: ["M1", "M2"] }), ["M1", "M2"]);
  assert.deepEqual(patchMarkers({ marker: "M1", markers: ["M2"] }), ["M1", "M2"]);
  assert.deepEqual(patchMarkers({}), []);
});

test("matchesPattern 吃字符串与正则，且不因全局标志漂移", function () {
  assert.equal(matchesPattern("abc", "b"), true);
  assert.equal(matchesPattern("abc", "z"), false);
  assert.equal(matchesPattern("abc", /B/i), true);
  const global = /b/g;
  assert.equal(matchesPattern("abc", global), true);
  assert.equal(matchesPattern("abc", global), true);
});

test("countPatternHits 数的是命中的 replacement 条数，不是出现次数", function () {
  const p = patchOf({
    replacements: [
      { pattern: "A", replace: "X" },
      { pattern: "B", replace: "Y" },
      { pattern: "ZZZ", replace: "Z" },
    ],
  });
  assert.equal(countPatternHits("A B A B", p), 2);
  assert.equal(countPatternHits("nothing here", p), 0);
});

test("markerPresent：markersAny 用 some，默认用 every", function () {
  const both = patchOf({ markers: ["M1", "M2"] });
  assert.equal(markerPresent("M1 M2", both), true);
  assert.equal(markerPresent("only M1", both), false);
  assert.equal(markerPresent("only M1", patchOf({ markers: ["M1", "M2"], markersAny: true })), true);
});

test("patchTracePresent 只认本补丁自己的痕迹，别处的 [dsh-purge] 不算", function () {
  const p = patchOf({ markers: ["[dsh-purge] mine"] });
  assert.equal(patchTracePresent("xx [dsh-purge] mine yy", p), true);
  assert.equal(patchTracePresent("xx [dsh-purge] someone-else yy", p), false);
  assert.equal(patchTracePresent("no trace at all", p), false);
});

test("productPresent 用 replace 首行前 60 字符，与 core.patchApplied 同源", function () {
  const p = patchOf({ replacements: [{ pattern: "OLD", replace: "NEW_PRODUCT_LINE\nsecond" }] });
  assert.equal(productPresent("xx NEW_PRODUCT_LINE yy", p), true);
  assert.equal(productPresent("xx OLD yy", p), false);
});

// —— 下面开始钉四条不变量 ——

test("不变量：纯净树（文件与基线逐字节相同）绝不允许判 applied", function () {
  const p = patchOf({});
  const text = "ORIGINAL_LINE\n";
  const got = classifyFile(p, { fileText: text, baselineText: text });
  assert.notEqual(got.state, PATCH_STATES.APPLIED);
  assert.equal(got.state, PATCH_STATES.PENDING);
});

test("不变量：marker 是官方原文自带时判 native，不是 applied", function () {
  // #2/#3 的形状：补丁要做的正是「把强句改回官方原文」，目标态 == 原生态。
  const p = patchOf({ replacements: [{ pattern: "STRONG_SENTENCE", replace: "OFFICIAL_SENTENCE" }], markers: ["OFFICIAL_SENTENCE"] });
  const text = "OFFICIAL_SENTENCE\n";
  const got = classifyFile(p, { fileText: text, baselineText: text });
  assert.equal(got.state, PATCH_STATES.NATIVE);
});

test("不变量：多文件补丁里一个软文件变空，不得把整条拖成 stale", function () {
  assert.equal(rollupStates([PATCH_STATES.APPLIED, PATCH_STATES.STALE]), PATCH_STATES.APPLIED);
  assert.equal(rollupStates([PATCH_STATES.APPLIED, PATCH_STATES.NA]), PATCH_STATES.APPLIED);
  assert.equal(rollupStates([PATCH_STATES.NATIVE, PATCH_STATES.STALE]), PATCH_STATES.NATIVE);
});

test("不变量：撤销型补丁在纯净树上判 na，不进退役清单", function () {
  const p = patchOf({
    replacements: [{ pattern: "// [dsh-purge] bash timeout raised\nX", replace: "Y" }],
    markers: [],
  });
  assert.equal(isRetractionPatch(p), true);
  const got = classifyFile(p, { fileText: "clean\n", baselineText: "clean\n" });
  assert.equal(got.state, PATCH_STATES.NA);
});

test("isRetractionPatch 认注册表声明的四种撤销语义", function () {
  assert.equal(isRetractionPatch({ skipIfMarked: true }), true);
  assert.equal(isRetractionPatch({ deleteOnly: true }), true);
  assert.equal(isRetractionPatch({ softSettle: true }), true);
  assert.equal(isRetractionPatch({ after: [87] }), true);
  assert.equal(isRetractionPatch({ replacements: [{ pattern: "plain", replace: "x" }] }), false);
  assert.equal(isRetractionPatch(null), false);
});

test("不变量：锚点在基线里还活着 → drifted（改锚点），不是 stale（退役）", function () {
  const p = patchOf({});
  // 基线里锚点活着，宿主里被上游改了措辞 → 锚点过期。
  const got = classifyFile(p, { fileText: "upstream rewrote this\n", baselineText: "ORIGINAL_LINE\n" });
  assert.equal(got.state, PATCH_STATES.DRIFTED);
  assert.match(got.reasons.join(" "), /re-anchoring/);
});

test("两棵树里锚点都死了且非撤销型 → stale（该退役）", function () {
  const p = patchOf({});
  const got = classifyFile(p, { fileText: "gone\n", baselineText: "gone\n" });
  assert.equal(got.state, PATCH_STATES.STALE);
});

test("撤销型补丁：锚点还活着时仍报 pending（真的有清理活要干）", function () {
  const p = patchOf({ skipIfMarked: true });
  const got = classifyFile(p, { fileText: "ORIGINAL_LINE\n", baselineText: "ORIGINAL_LINE\n" });
  assert.equal(got.state, PATCH_STATES.PENDING);
});

test("skipIfMarked 型：marker 现在有、基线没有 → applied（插入型已结算）", function () {
  const p = patchOf({ skipIfMarked: true });
  const got = classifyFile(p, {
    fileText: "ORIGINAL_LINE\n[dsh-purge] fixture marker\n",
    baselineText: "ORIGINAL_LINE\n",
  });
  assert.equal(got.state, PATCH_STATES.APPLIED);
});

test("skipIfMarked 型：marker 与锚点都是基线自带时，绝不算 applied", function () {
  // 纯净树上「文件 == 基线」，无论 marker 多像我们的，都不可能是我们打的。
  const p = patchOf({ skipIfMarked: true });
  const text = "ORIGINAL_LINE\n[dsh-purge] fixture marker\n";
  const got = classifyFile(p, { fileText: text, baselineText: text });
  assert.notEqual(got.state, PATCH_STATES.APPLIED);
  assert.equal(got.state, PATCH_STATES.PENDING);
});

test("产物片段在基线里也有时，不得当成「我打的」", function () {
  // 产物探测取首行前 60 字符，判别力天然弱（#42 就这么踩过）。
  // 只有在基线里找不到这段产物时，它才算证据。
  const p = patchOf({ skipIfMarked: true, markers: ["never-appears"] });
  const text = "PATCHED_LINE\n";
  const got = classifyFile(p, { fileText: text, baselineText: text });
  assert.notEqual(got.state, PATCH_STATES.APPLIED);
});

test("deleteOnly：目标还在 → pending；目标消失 → applied", function () {
  const p = patchOf({ deleteOnly: true });
  assert.equal(classifyFile(p, { fileText: "ORIGINAL_LINE", baselineText: "x" }).state, PATCH_STATES.PENDING);
  assert.equal(classifyFile(p, { fileText: "clean", baselineText: "x" }).state, PATCH_STATES.APPLIED);
});

test("文件缺失：两边都缺 → na；只在宿主缺 → unknown", function () {
  const p = patchOf({});
  assert.equal(classifyFile(p, { fileText: null, baselineText: null }).state, PATCH_STATES.NA);
  assert.equal(classifyFile(p, { fileText: null, baselineText: "ORIGINAL_LINE" }).state, UNKNOWN);
});

test("没有基线且证据全无 → unknown，不允许蒙一个 applied", function () {
  const p = patchOf({});
  assert.equal(classifyFile(p, { fileText: "something", baselineText: null }).state, UNKNOWN);
});

test("rollupStates 优先级：pending > drifted > unknown > applied > native > stale", function () {
  assert.equal(rollupStates([]), UNKNOWN);
  assert.deepEqual(rollupStates([PATCH_STATES.NA, PATCH_STATES.NA]), PATCH_STATES.NA);
  assert.equal(rollupStates([PATCH_STATES.DRIFTED, PATCH_STATES.PENDING]), PATCH_STATES.PENDING);
  assert.equal(rollupStates([UNKNOWN, PATCH_STATES.DRIFTED]), PATCH_STATES.DRIFTED);
  assert.equal(rollupStates([PATCH_STATES.APPLIED, UNKNOWN]), UNKNOWN);
  assert.equal(rollupStates([PATCH_STATES.STALE, PATCH_STATES.NATIVE]), PATCH_STATES.NATIVE);
  assert.equal(rollupStates([PATCH_STATES.STALE]), PATCH_STATES.STALE);
});

test("classifyPatch 汇总多文件并标出软文件与空置键", function () {
  const p = patchOf({ file: ["a", "b"], softFiles: ["b"] });
  const got = classifyPatch(p, [
    { key: "a", file: "a", fileText: "PATCHED_LINE\n", baselineText: "ORIGINAL_LINE\n" },
    { key: "b", file: "b", fileText: "gone\n", baselineText: "gone\n" },
  ]);
  assert.equal(got.state, PATCH_STATES.APPLIED);
  assert.deepEqual(got.vacantKeys, ["b"]);
  assert.equal(got.files.find(function (f) { return f.key === "b"; }).soft, true);
  assert.equal(got.files.find(function (f) { return f.key === "a"; }).soft, false);
});

test("tallyStates 给每个状态都留位置，缺省为 0", function () {
  const t = tallyStates([{ state: PATCH_STATES.APPLIED }, { state: PATCH_STATES.APPLIED }, { state: PATCH_STATES.STALE }]);
  for (const s of STATE_LIST) assert.equal(typeof t[s], "number");
  assert.equal(t.applied, 2);
  assert.equal(t.stale, 1);
  assert.equal(t.pending, 0);
});

test("needsAttention 只对 drifted 与 unknown 为真", function () {
  assert.equal(needsAttention(PATCH_STATES.DRIFTED), true);
  assert.equal(needsAttention(UNKNOWN), true);
  for (const s of [PATCH_STATES.APPLIED, PATCH_STATES.PENDING, PATCH_STATES.NATIVE, PATCH_STATES.STALE, PATCH_STATES.NA]) {
    assert.equal(needsAttention(s), false, s);
  }
});
