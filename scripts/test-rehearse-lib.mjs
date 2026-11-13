import assert from "node:assert/strict";
import test from "node:test";
import {
  BUCKETS,
  BUCKET_LIST,
  REHEARSE_SCHEMA,
  behaviourVerdict,
  bucketsVerdict,
  chokeVerdict,
  classifyApplyRow,
  classifyBehaviourState,
  classifyGateState,
  classifyOutcomeState,
  coveredPackages,
  escapedTargets,
  gateVerdict,
  isSoftPatch,
  keyFacts,
  outcomeVerdict,
  renderRehearsal,
  summarizeRehearsal,
  tallyBuckets,
} from "./rehearse-lib.mjs";
import { STATE_LIST, UNKNOWN } from "../lib/patch-outcome.mjs";
import { BEHAVIOR_STATE_LIST } from "./behavior-lib.mjs";

// ---------- 一、契约面：四个桶的名字与顺序是 CLI 与测试共同依赖的 ----------

test("schema 与四个桶的名字、顺序都钉死", () => {
  assert.equal(REHEARSE_SCHEMA, 1);
  assert.deepEqual([...BUCKET_LIST], ["ok", "expected", "warn", "blocking"]);
  assert.deepEqual(Object.keys(BUCKETS), ["ok", "expected", "warn", "blocking"]);
  for (const key of BUCKET_LIST) assert.equal(BUCKETS[key], key);
});

test("BUCKETS 与 BUCKET_LIST 都冻结，改不动", () => {
  assert.equal(Object.isFrozen(BUCKETS), true);
  assert.equal(Object.isFrozen(BUCKET_LIST), true);
  assert.throws(() => {
    "use strict";
    BUCKET_LIST.push("extra");
  }, TypeError);
});

// ---------- 二、keyFacts：一个补丁的三个键各自落在树内 / 树外 / 找不到 ----------

const AI = "D:/host/node_modules/@deepseek-ai";

test("keyFacts 把键分成「树内有」「只有树外」「一个都没有」三类", () => {
  const facts = keyFacts(
    { file: ["in", "out", "nowhere"] },
    {
      in: [AI + "/dsh-base/lib/index.js"],
      out: ["C:\\Users\\x\\AppData\\Roaming\\npm\\dsh"],
      nowhere: [],
    },
    AI,
  );
  assert.deepEqual(facts.keys, ["in", "out", "nowhere"]);
  assert.deepEqual(facts.rows, [
    { key: "in", paths: 1, inside: 1, outside: 0 },
    { key: "out", paths: 1, inside: 0, outside: 1 },
    { key: "nowhere", paths: 0, inside: 0, outside: 0 },
  ]);
  assert.equal(facts.inside, 1);
  assert.equal(facts.outside, 1);
  assert.equal(facts.unresolved, 1);
});

test("keyFacts 的树内判定把反斜杠归一，且 aiBase 末尾的斜杠不影响结果", () => {
  const facts = keyFacts(
    { file: "a" },
    { a: ["D:\\host\\node_modules\\@deepseek-ai\\dsh-base\\lib\\index.js"] },
    "D:\\host\\node_modules\\@deepseek-ai\\",
  );
  assert.equal(facts.rows[0].inside, 1);
  assert.equal(facts.rows[0].outside, 0);
});

test("keyFacts 里同一个键既有树内又有树外时算树内（inside 优先）", () => {
  const facts = keyFacts(
    { file: ["both"] },
    { both: [AI + "/dsh-base/lib/index.js", "C:/elsewhere/dsh"] },
    AI,
  );
  assert.deepEqual(facts.rows[0], { key: "both", paths: 2, inside: 1, outside: 1 });
  assert.equal(facts.inside, 1);
  assert.equal(facts.outside, 0);
  assert.equal(facts.unresolved, 0);
});

test("keyFacts 接受单字符串 file，也跳过空串与非字符串", () => {
  const single = keyFacts({ file: "one" }, { one: AI + "/dsh-tools/lib/index.js" }, AI);
  assert.deepEqual(single.keys, ["one"]);
  const messy = keyFacts({ file: ["", 7, null, "two"] }, { two: [] }, AI);
  assert.deepEqual(messy.keys, ["two"]);
});

test("keyFacts 对没有 file 字段或 file 是怪类型的补丁回空表，不抛", () => {
  for (const patch of [undefined, null, {}, { file: 42 }, { file: [] }]) {
    const facts = keyFacts(patch, {}, AI);
    assert.deepEqual(facts.keys, []);
    assert.deepEqual(facts.rows, []);
    assert.equal(facts.inside, 0);
    assert.equal(facts.outside, 0);
    assert.equal(facts.unresolved, 0);
  }
});

test("keyFacts 在 targetMap 缺这个键时按「一个候选都没有」处理", () => {
  const facts = keyFacts({ file: ["ghost"] }, undefined, AI);
  assert.deepEqual(facts.rows, [{ key: "ghost", paths: 0, inside: 0, outside: 0 }]);
  assert.equal(facts.unresolved, 1);
});

test("keyFacts 把候选数组里的空串与 null 剔掉，只数真实路径", () => {
  // targetFiles 的数组形态理论上只放路径，但键合并时可能留下空槽；数进 paths 会让
  // 「候选 3 个、一个都不存在」看起来比实际更严重。
  const facts = keyFacts({ file: ["a"] }, { a: ["", null, undefined, AI + "/dsh-base/lib/index.js"] }, AI);
  assert.deepEqual(facts.rows[0], { key: "a", paths: 1, inside: 1, outside: 0 });
});

test("keyFacts 的树内判定必须从 aiBase 开头算起，不能只看「路径里含 aiBase」", () => {
  // 反面例子：把整棵宿主树复制到别处，字符串里仍然含 aiBase，但它已经不在树里了 ——
  // 用 includes 判会把这种「别处的副本」当成树内，于是 missing_file 被误判成 blocking。
  const copy = "C:/some-copy/" + AI + "/dsh-base/lib/index.js";
  const facts = keyFacts({ file: ["a"] }, { a: [copy] }, AI);
  assert.equal(facts.rows[0].outside, 1);
  assert.equal(facts.rows[0].inside, 0);
});

// ---------- 三、isSoftPatch：锚点可以合法缺席的五种写法 ----------

test("isSoftPatch 认 optional / softSettle / deleteOnly / skipIfMarked 四种开关", () => {
  assert.equal(isSoftPatch({ optional: true }), true);
  assert.equal(isSoftPatch({ softSettle: true }), true);
  assert.equal(isSoftPatch({ deleteOnly: true }), true);
  assert.equal(isSoftPatch({ skipIfMarked: true }), true);
});

test("isSoftPatch 认「排在别的补丁之后」这种 after 数组", () => {
  assert.equal(isSoftPatch({ after: [3] }), true);
  assert.equal(isSoftPatch({ after: [] }), false);
  assert.equal(isSoftPatch({ after: "3" }), false);
});

test("isSoftPatch 对没有软标记的普通补丁回 false，对空值也回 false", () => {
  assert.equal(isSoftPatch({ id: 1 }), false);
  assert.equal(isSoftPatch({ optional: false }), false);
  assert.equal(isSoftPatch(null), false);
  assert.equal(isSoftPatch(undefined), false);
});

// ---------- 四、classifyApplyRow：七种 apply 状态怎么落到四个桶 ----------

const NO_FACTS = { keys: [], inside: 0, outside: 0, unresolved: 0 };

test("写盘本身失败（write_error / read_error / hit_count_mismatch）一律 blocking", () => {
  for (const status of ["write_error", "read_error", "hit_count_mismatch", "write_error:EPERM", "hit_count_mismatch:#12:1/2"]) {
    const row = classifyApplyRow({ patch_id: 7, name: "N", status }, {}, NO_FACTS);
    assert.equal(row.bucket, "blocking", status);
    assert.equal(row.why, "the write itself failed: " + status);
    assert.equal(row.id, 7);
    assert.equal(row.status, status);
  }
});

test("写盘失败的判据必须钉在状态开头，不能让路径或补丁名里的同类字串命中", () => {
  // 反面例子：把 HARD_FAILURE 的行首锚定去掉，任何「名字里带 write_error」的普通状态都会被
  // 判成写盘失败；真实世界里补丁名与错误串都可能拼进 status，行首锚定是唯一的边界。
  for (const status of ["drifted:write_error", "note:read_error", "already:hit_count_mismatch"]) {
    const row = classifyApplyRow({ patch_id: 8, name: "N", status }, {}, NO_FACTS);
    assert.notEqual(row.bucket, "blocking", status);
  }
});

test("drifted 在预演里是 blocking：这正是发版前要修的东西", () => {
  const row = classifyApplyRow({ patch_id: 13, name: "N", status: "drifted" }, { optional: true }, NO_FACTS);
  assert.equal(row.bucket, "blocking");
  assert.match(row.why, /re-anchor/);
});

test("pattern_not_found 对软补丁是 warn、对硬补丁是 blocking", () => {
  const soft = classifyApplyRow({ patch_id: 18, name: "N", status: "pattern_not_found" }, { after: [1] }, NO_FACTS);
  assert.equal(soft.bucket, "warn");
  assert.match(soft.why, /allowed/);
  const hard = classifyApplyRow({ patch_id: 19, name: "N", status: "pattern_not_found" }, { id: 19 }, NO_FACTS);
  assert.equal(hard.bucket, "blocking");
  assert.match(hard.why, /required anchor/);
});

test("pattern_not_found 在没有补丁对象时按硬补丁处理（不知道就是不许过）", () => {
  const row = classifyApplyRow({ patch_id: 20, name: "N", status: "pattern_not_found" }, undefined, NO_FACTS);
  assert.equal(row.bucket, "blocking");
});

test("missing_file：只在树外有候选是 expected（包树里本来就没有 Electron 壳）", () => {
  const facts = { keys: ["desktop-shell"], inside: 0, outside: 1, unresolved: 0 };
  const row = classifyApplyRow({ patch_id: 45, name: "N", status: "missing_file" }, {}, facts);
  assert.equal(row.bucket, "expected");
  assert.equal(row.why, "targets outside the package tree: desktop-shell");
});

test("missing_file：树内树外都没有候选是 warn（这个布局里根本没这文件）", () => {
  const facts = { keys: ["a", "b"], inside: 0, outside: 0, unresolved: 2 };
  const row = classifyApplyRow({ patch_id: 46, name: "N", status: "missing_file" }, {}, facts);
  assert.equal(row.bucket, "warn");
  assert.equal(row.why, "no candidate path in this layout: a,b");
});

test("missing_file：键在树内能解析却找不到文件是 blocking（真的缺了）", () => {
  const facts = { keys: ["a", "base"], inside: 1, outside: 0, unresolved: 1 };
  const row = classifyApplyRow({ patch_id: 47, name: "N", status: "missing_file" }, {}, facts);
  assert.equal(row.bucket, "blocking");
  assert.equal(row.why, "keys resolve inside the tree but no file was found: a,base");
});

test("missing_file 不传 facts 时退回全零事实，结果落在 warn 而不是 blocking", () => {
  const row = classifyApplyRow({ patch_id: 48, name: "N", status: "missing_file" });
  assert.equal(row.bucket, "warn");
  assert.equal(row.why, "no candidate path in this layout: ");
});

test("missing_file 时 inside 与 outside 都有仍然是 blocking（inside 优先）", () => {
  const facts = { keys: ["mix"], inside: 1, outside: 2, unresolved: 0 };
  const row = classifyApplyRow({ patch_id: 49, name: "N", status: "missing_file" }, {}, facts);
  assert.equal(row.bucket, "blocking");
});

test("其余状态（applied / already / na / skipped）都算 ok，why 就写状态本身", () => {
  for (const status of ["applied", "already", "already_patched", "no-file", "na", "skipped"]) {
    const row = classifyApplyRow({ patch_id: 1, name: "N", status }, {}, NO_FACTS);
    assert.equal(row.bucket, "ok", status);
    assert.equal(row.why, status);
  }
});

test("行里没有 patch_id 时 id 是 undefined；整行是空值时会抛（row.name 没兜底，现状锁定）", () => {
  // 源码是 row ? row.patch_id : null，但同一行里 name: row.name 没有兜底 ——
  // 所以 id 的 null 分支在运行时走不到：row 为空会先在 row.name 处 TypeError。
  // 生产里 row 永远来自 applyPatches 的结果数组，这条只是记录现状，不是该修的行为。
  const row = classifyApplyRow({}, undefined, NO_FACTS);
  assert.equal(row.id, undefined);
  assert.equal(row.status, "");
  assert.equal(row.bucket, "ok");
  assert.equal(row.why, "");
  assert.throws(() => classifyApplyRow(undefined, undefined, NO_FACTS), TypeError);
  assert.throws(() => classifyApplyRow(null, undefined, NO_FACTS), TypeError);
});

// ---------- 五、tallyBuckets：四个桶永远四个键 ----------

test("tallyBuckets 预置四个零，再按行累加", () => {
  const tally = tallyBuckets([
    { bucket: "ok" },
    { bucket: "ok" },
    { bucket: "blocking" },
  ]);
  assert.deepEqual(tally, { ok: 2, expected: 0, warn: 0, blocking: 1 });
});

test("tallyBuckets 对空输入与 null 都回四个零", () => {
  assert.deepEqual(tallyBuckets([]), { ok: 0, expected: 0, warn: 0, blocking: 0 });
  assert.deepEqual(tallyBuckets(null), { ok: 0, expected: 0, warn: 0, blocking: 0 });
});

test("tallyBuckets 遇到没见过的桶名自己开键，不静默丢行", () => {
  const tally = tallyBuckets([{ bucket: "weird" }]);
  assert.equal(tally.weird, 1);
  assert.equal(tally.ok, 0);
});

// ---------- 六、七态 outcome 的读法 ----------

test("applied / native / na 三种是绿的", () => {
  for (const state of ["applied", "native", "na"]) {
    assert.equal(classifyOutcomeState(state), "ok", state);
  }
});

test("stale 是 warn：补丁在这个版本上已经无事可做，该退役", () => {
  assert.equal(classifyOutcomeState("stale"), "warn");
});

test("pending / drifted / unknown 以及任何没见过的状态都是 blocking", () => {
  for (const state of ["pending", "drifted", "unknown", "whatever", ""]) {
    assert.equal(classifyOutcomeState(state), "blocking", state);
  }
});

test("outcomeVerdict 按 pending → drifted → unknown 的固定顺序列红，stale 单独进 warn", () => {
  const verdict = outcomeVerdict({ pending: 2, drifted: 1, unknown: 3, stale: 4 });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.blocking, ["2 pending", "1 drifted", "3 unknown"]);
  assert.deepEqual(verdict.warn, ["4 stale (retire or re-anchor)"]);
});

test("outcomeVerdict 全零时是绿的且没有 warn", () => {
  assert.deepEqual(outcomeVerdict({ applied: 86 }), { ok: true, blocking: [], warn: [] });
  assert.deepEqual(outcomeVerdict(null), { ok: true, blocking: [], warn: [] });
});

test("outcomeVerdict 只有 stale 时 ok 仍为真（可以批量退役，不算拦路）", () => {
  const verdict = outcomeVerdict({ stale: 2 });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.warn, ["2 stale (retire or re-anchor)"]);
});

// ---------- 七、五态 behaviour 的读法 ----------

test("behaviourVerdict 把 broken 与 unexpected 都算拦路", () => {
  const verdict = behaviourVerdict({ broken: 2, unexpected: 1 });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.blocking, ["2 broken", "1 unexpected"]);
});

test("behaviourVerdict 的 inert 是 warn：观测点挪了，但不算补丁失效", () => {
  const verdict = behaviourVerdict({ inert: 3 });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.warn, ["3 inert (observation point moved)"]);
});

test("behaviourVerdict 全零与 null 都是绿的", () => {
  assert.deepEqual(behaviourVerdict({ ok: 5 }), { ok: true, blocking: [], warn: [] });
  assert.deepEqual(behaviourVerdict(undefined), { ok: true, blocking: [], warn: [] });
});

// ---------- 八、chokeVerdict：有缺口就是拦路 ----------

test("chokeVerdict 的空数组与非数组都算绿（没扫就是没问题）", () => {
  assert.deepEqual(chokeVerdict([]), { ok: true, blocking: [], warn: [] });
  assert.deepEqual(chokeVerdict(null), { ok: true, blocking: [], warn: [] });
  assert.deepEqual(chokeVerdict(undefined), { ok: true, blocking: [], warn: [] });
});

test("chokeVerdict 按缺口数组长度出一个拦路理由", () => {
  const verdict = chokeVerdict([{}, {}, {}]);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.blocking, ["3 uncovered chokepoint group(s)"]);
  assert.deepEqual(verdict.warn, []);
});

// ---------- 九、summarizeRehearsal：四步合成一个结论 ----------

test("summarizeRehearsal 把每一步的理由前缀上 step.id", () => {
  const summary = summarizeRehearsal([
    { id: "apply", verdict: { ok: false, blocking: ["2 drifted"], warn: [] } },
    { id: "outcome", verdict: { ok: true, blocking: [], warn: ["1 stale"] } },
    { id: "behaviour", verdict: { ok: false, blocking: ["1 broken"], warn: ["1 inert"] } },
    { id: "choke", verdict: { ok: true, blocking: [], warn: [] } },
  ]);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.reds, ["apply: 2 drifted", "behaviour: 1 broken"]);
  assert.deepEqual(summary.warns, ["outcome: 1 stale", "behaviour: 1 inert"]);
});

test("summarizeRehearsal 只有 warn 时仍算通过", () => {
  const summary = summarizeRehearsal([{ id: "apply", verdict: { ok: true, blocking: [], warn: ["1 stale"] } }]);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.reds, []);
  assert.deepEqual(summary.warns, ["apply: 1 stale"]);
});

test("summarizeRehearsal 对缺 verdict / 缺 steps 的输入不抛", () => {
  assert.deepEqual(summarizeRehearsal([]), { ok: true, reds: [], warns: [] });
  assert.deepEqual(summarizeRehearsal(null), { ok: true, reds: [], warns: [] });
  assert.deepEqual(summarizeRehearsal([{ id: "x" }]), { ok: true, reds: [], warns: [] });
});

// ---------- 十、escapedTargets：写盘前唯一一道硬闸门 ----------

// 一次预演曾经真的写到了真装好的 pi-ai：副本放在 node_modules 旁边，targetFiles 顺着往上
// 找到了真实安装的那份。所以判据不是「补丁报告说 ok」，而是「每个要写的路径都在 root 之下」。
test("escapedTargets 放过 root 内的路径，抓出 root 外的每一条", () => {
  const root = "D:/work/rehearse-1";
  const map = {
    inside: root + "/@deepseek-ai/dsh-sandbox/lib/index.js",
    outside: "D:/dsh-purge-maintained/node_modules/@earendil-works/pi-ai/dist/api/x.js",
    mixed: [root + "/@deepseek-ai/a.js", "D:/elsewhere/b.js"],
  };
  const escaped = escapedTargets(map, root);
  assert.deepEqual(escaped.map((hit) => hit.key).sort(), ["mixed", "outside"]);
  assert.equal(escaped.find((hit) => hit.key === "mixed").file, "D:/elsewhere/b.js");
});

test("escapedTargets 认得出反斜杠路径，且不把 rehearse-20 当成 rehearse-2", () => {
  const root = "D:/work/rehearse-2";
  const win = ["D:", "work", "rehearse-2", "@deepseek-ai", "x.js"].join(String.fromCharCode(92));
  const map = { a: win, b: "D:/work/rehearse-20/x.js" };
  assert.deepEqual(escapedTargets(map, root).map((hit) => hit.key), ["b"]);
  assert.deepEqual(escapedTargets(map, root + "/"), escapedTargets(map, root));
});

test("escapedTargets 对空表、null 值、空数组都不吭声", () => {
  assert.deepEqual(escapedTargets({}, "D:/r"), []);
  assert.deepEqual(escapedTargets(undefined, "D:/r"), []);
  assert.deepEqual(escapedTargets({ a: null, b: [] }, "D:/r"), []);
});

// ---------- 十一、coveredPackages：从 targetFiles 反推写过哪些包 ----------

test("coveredPackages 只收 @deepseek-ai 下以 dsh- 开头的包名，且去重", () => {
  const covered = coveredPackages(
    {
      a: [AI + "/dsh-base/lib/index.js", AI + "/dsh-base/cordis.patch.yml"],
      b: AI + "/dsh-tools/lib/index.js",
      c: AI + "/dsh-base/lib/types/index.js",
    },
    AI,
  );
  assert.equal(covered instanceof Set, true);
  assert.deepEqual([...covered].sort(), ["dsh-base", "dsh-tools"]);
});

test("coveredPackages 把反斜杠路径也认出来（Windows 上 targetFiles 给的是反斜杠）", () => {
  // 不归一的话，Windows 树上每个包都变成「不在树内」，覆盖表会是空的，
  // 而空覆盖表会让卡点扫描把所有拦点都当成没人管。
  const win = AI.replace(/\//g, "\\");
  const covered = coveredPackages({ a: win + "\\dsh-base\\lib\\index.js" }, win);
  assert.deepEqual([...covered], ["dsh-base"]);
});

test("coveredPackages 丢掉树外路径与非 dsh- 开头的一级目录", () => {
  const covered = coveredPackages(
    {
      out: ["C:\\Users\\x\\npm\\dsh"],
      other: [AI + "/@deepseek-ai-something/lib/index.js", AI + "/notdsh/file.js"],
      dot: [AI + "/.bin/dsh"],
    },
    AI,
  );
  assert.deepEqual([...covered], []);
});

test("coveredPackages 接受数组与单值混合，空表回空 Set", () => {
  const mixed = coveredPackages({ a: [AI + "/dsh-a/x.js"], b: AI + "/dsh-b/y.js" }, AI + "/");
  assert.deepEqual([...mixed].sort(), ["dsh-a", "dsh-b"]);
  assert.deepEqual([...coveredPackages({}, AI)], []);
  assert.deepEqual([...coveredPackages(undefined, AI)], []);
});

// ---------- 十一、renderRehearsal：人读的七行格式 ----------

function reportOf(steps) {
  return { steps, verdict: summarizeRehearsal(steps) };
}

test("renderRehearsal 每步两行：状态 + 标题、缩进的摘要，末尾一个空行加总结论", () => {
  const lines = renderRehearsal(
    reportOf([{ id: "apply", label: "重打", summary: "86 条", verdict: { ok: true, blocking: [], warn: [] }, rows: [] }]),
  );
  assert.equal(lines[0], "[ok] apply  重打");
  assert.equal(lines[1], "       86 条");
  assert.equal(lines[2], "");
  assert.match(lines[3], /\[rehearse\] PASS  1 步证据全绿/);
});

test("renderRehearsal 有拦路时状态写 FAIL，末尾列出条数与每一条", () => {
  const lines = renderRehearsal(
    reportOf([{ id: "apply", label: "重打", summary: "86 条", verdict: { ok: false, blocking: ["1 drifted"], warn: [] }, rows: [] }]),
  );
  assert.equal(lines[0], "[FAIL] apply  重打");
  assert.match(lines[lines.length - 2], /\[rehearse\] FAIL  1 处要先处理/);
  assert.equal(lines[lines.length - 1], "[rehearse]   ! apply: 1 drifted");
});

test("renderRehearsal 只有 warn 时状态写 warn 而不是 ok 也不是 FAIL", () => {
  const lines = renderRehearsal(
    reportOf([{ id: "outcome", label: "七态", summary: "s", verdict: { ok: true, blocking: [], warn: ["2 stale"] }, rows: [] }]),
  );
  assert.equal(lines[0], "[warn] outcome  七态");
  assert.match(lines[lines.length - 1], /^\[rehearse\] {3}~ outcome: 2 stale$/);
});

test("renderRehearsal 只把 blocking / warn 的行印出来，ok 行不刷屏", () => {
  const lines = renderRehearsal(
    reportOf([
      {
        id: "apply",
        label: "重打",
        summary: "s",
        verdict: { ok: false, blocking: ["1 drifted"], warn: [] },
        rows: [
          { bucket: "ok", id: 1, name: "fine", why: "applied" },
          { bucket: "blocking", id: 13, name: "bad", why: "anchor gone" },
          { bucket: "warn", id: 18, name: "soft", why: "optional" },
        ],
      },
    ]),
  );
  const rowLines = lines.filter((l) => /^ {7}(blocking|warn|ok) #/.test(l));
  assert.deepEqual(rowLines, [
    "       blocking #13 bad - anchor gone",
    "       warn #18 soft - optional",
  ]);
});

test("renderRehearsal 的 limit 同时截断理由与行，默认 20", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ bucket: "blocking", id: i, name: "N" + i, why: "w" }));
  const blocking = Array.from({ length: 25 }, (_, i) => i + " drifted");
  const limited = renderRehearsal(
    reportOf([{ id: "apply", label: "L", summary: "s", verdict: { ok: false, blocking, warn: [] }, rows: many }]),
  );
  assert.equal(limited.filter((l) => /^ {7}! /.test(l)).length, 20);
  assert.equal(limited.filter((l) => /^ {7}blocking #/.test(l)).length, 20);

  const capped = renderRehearsal(
    reportOf([{ id: "apply", label: "L", summary: "s", verdict: { ok: false, blocking, warn: [] }, rows: many }]),
    { limit: 3 },
  );
  assert.equal(capped.filter((l) => /^ {7}! /.test(l)).length, 3);
  assert.equal(capped.filter((l) => /^ {7}blocking #/.test(l)).length, 3);
});

test("renderRehearsal 的 limit 非整数时退回 20", () => {
  const blocking = Array.from({ length: 25 }, (_, i) => i + " drifted");
  const lines = renderRehearsal(
    reportOf([{ id: "a", label: "L", summary: "s", verdict: { ok: false, blocking, warn: [] }, rows: [] }]),
    { limit: "3" },
  );
  assert.equal(lines.filter((l) => /^ {7}! /.test(l)).length, 20);
});

test("renderRehearsal 对空报告只给一句 PASS，不抛", () => {
  const lines = renderRehearsal({ steps: [], verdict: { ok: true, reds: [], warns: [] } });
  assert.deepEqual(lines, ["", "[rehearse] PASS  0 步证据全绿"]);
});

test("renderRehearsal 缺 rows / warn 也不抛（步骤只做了半套证据）", () => {
  const lines = renderRehearsal({
    steps: [{ id: "choke", label: "卡点", summary: "无缺口", verdict: { ok: true, blocking: [], warn: [] } }],
    verdict: { ok: true, reds: [], warns: [] },
  });
  assert.equal(lines[0], "[ok] choke  卡点");
});

// ---------- 十三、闸门侧表：跨版缺失是漂移，同版缺失是矛盾 ----------

test("闸门行四态到桶的映射：present/skipped 绿，unreadable 只是看一眼，missing 看版本", () => {
  // 这条映射的好坏决定了 host:rehearse 的第五步是可信信号还是永久的红。跨版把 missing 判红，
  // 每次 dshTarget 一动命令就红一遍，然后所有人都学会忽略它。
  assert.equal(classifyGateState({ state: "present" }, false), BUCKETS.ok);
  assert.equal(classifyGateState({ state: "skipped" }, false), BUCKETS.ok);
  assert.equal(classifyGateState({ state: "unreadable" }, false), BUCKETS.warn);
  assert.equal(classifyGateState({ state: "missing" }, false), BUCKETS.blocking);
  assert.equal(classifyGateState({ state: "missing" }, true), BUCKETS.warn);
  assert.equal(classifyGateState(null, false), BUCKETS.warn);
});

test("跨版缺失只出 warn，且说清这是 bump dshTarget 时的返工量", () => {
  const verdict = gateVerdict({ drift: true, tableVersion: "0.2.2-rc.1", version: "0.2.2-rc.2", tally: { present: 55, missing: 3, unreadable: 0, skipped: 28 } });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.blocking, []);
  assert.equal(verdict.warn.length, 1);
  assert.match(verdict.warn[0], /3 needle\(s\) moved between 0\.2\.2-rc\.1 and 0\.2\.2-rc\.2/);
  assert.match(verdict.warn[0], /re-derive when you bump dshTarget/);
});

test("同版缺失是 blocking：表与树不再互相描述，其中一个旧了", () => {
  const verdict = gateVerdict({ drift: false, tableVersion: "0.2.2-rc.2", version: "0.2.2-rc.2", tally: { present: 57, missing: 1, unreadable: 0, skipped: 28 } });
  assert.equal(verdict.ok, false);
  assert.match(verdict.blocking[0], /the table and the tree disagree/);
});

test("一条都没掉就完全绿，unreadable 单独计数不混进 missing", () => {
  const clean = gateVerdict({ drift: true, tableVersion: "a", version: "b", tally: { present: 58, missing: 0, unreadable: 0, skipped: 28 } });
  assert.deepEqual(clean, { ok: true, blocking: [], warn: [] });
  const blind = gateVerdict({ drift: true, tableVersion: "a", version: "b", tally: { present: 44, missing: 0, unreadable: 14, skipped: 28 } });
  assert.equal(blind.ok, true);
  assert.match(blind.warn[0], /14 gate row\(s\) point at a file this tree does not contain/);
});

test("缺 tally 或空结果不抛，按全绿处理（预演被 --skip 掉时也走这条）", () => {
  assert.deepEqual(gateVerdict(null), { ok: true, blocking: [], warn: [] });
  assert.deepEqual(gateVerdict({}), { ok: true, blocking: [], warn: [] });
});
// ---------- 十二、跨模块契约：词表不能与产生它的模块走散 ----------

test("七态词表与 lib/patch-outcome.mjs 的 STATE_LIST 完全对齐（多一个少一个都要先改这里）", () => {
  // rehearse-lib 只认得六个命名状态 + unknown。上游新增第七个状态时，classifyOutcomeState
  // 会把它判成 blocking（偏保守，不会漏红），但 state 名字会从 tally 里消失；
  // 这条断言的意义是让那种改动在 CI 上直接炸，而不是等预演时才发现某个状态没人读。
  assert.deepEqual(STATE_LIST, ["applied", "pending", "native", "stale", "drifted", "na"]);
  assert.equal(UNKNOWN, "unknown");
  const known = [...STATE_LIST, UNKNOWN];
  for (const state of known) {
    assert.ok(["ok", "warn", "blocking"].includes(classifyOutcomeState(state)), state);
  }
  // 六个命名状态里只有 stale 是 warn，其余按「能不能证明它没事」分绿/红。
  assert.deepEqual(
    known.map((state) => [state, classifyOutcomeState(state)]),
    [
      ["applied", "ok"],
      ["pending", "blocking"],
      ["native", "ok"],
      ["stale", "warn"],
      ["drifted", "blocking"],
      ["na", "ok"],
      ["unknown", "blocking"],
    ],
  );
});


test("PASS 文案按实际跑了几步说，--skip 之后不许自称五条证据全绿", () => {
  // 这条是给 tool 自己立的规矩：跳过两步还印「五条证据全绿」，就是本工具存在的理由的反面。
  const full = renderRehearsal({
    steps: [
      { id: "apply", label: "a", summary: "s", verdict: { ok: true, blocking: [], warn: [] } },
      { id: "gates", label: "g", summary: "s", verdict: { ok: true, blocking: [], warn: [] } },
    ],
    skipped: [],
    verdict: { ok: true, reds: [], warns: [] },
  });
  assert.match(full[full.length - 1], /PASS  2 步证据全绿/);
  const partial = renderRehearsal({
    steps: [{ id: "apply", label: "a", summary: "s", verdict: { ok: true, blocking: [], warn: [] } }],
    skipped: ["choke", "gates", "behaviour", "outcome"],
    verdict: { ok: true, reds: [], warns: [] },
  });
  assert.match(partial[partial.length - 1], /PASS  1 步（跳过 4 步）证据全绿/);
  assert.ok(!partial[partial.length - 1].includes("五条"));
});

test("五态词表与 scripts/behavior-lib.mjs 的 BEHAVIOR_STATE_LIST 完全对齐", () => {
  // behaviourVerdict 只显式看 broken 与 unexpected，其余默认不算红 —— 这正是危险之处：
  // 上游新增一个失败态时它会静默变绿。对齐断言把「新增态」变成一次必须的评审。
  assert.deepEqual(BEHAVIOR_STATE_LIST, ["ok", "broken", "already", "inert", "unexpected"]);
  const verdictFor = {
    ok: { ok: true, blocking: [], warn: [] },
    broken: { ok: false, blocking: ["1 broken"], warn: [] },
    already: { ok: true, blocking: [], warn: [] },
    inert: { ok: true, blocking: [], warn: ["1 inert (observation point moved)"] },
    unexpected: { ok: false, blocking: ["1 unexpected"], warn: [] },
  };
  for (const state of BEHAVIOR_STATE_LIST) {
    assert.deepEqual(behaviourVerdict({ [state]: 1 }), verdictFor[state], state);
  }
});

// ---------- 十三、五步报告里另外四个判定：只有 blocking 才拦发版 ----------
// bucketsVerdict / classifyBehaviourState / classifyGateState / gateVerdict 原来一条都没有，
// 而它们各自都是「上游改了枚举值就会静默变绿」的那一类。

test("bucketsVerdict 只认 blocking 拦路，warn 与 expected 都不拦", () => {
  assert.deepEqual(bucketsVerdict({ ok: 80, expected: 3, warn: 2, blocking: 0 }), {
    ok: true,
    blocking: [],
    warn: ["2 warn row(s)"],
  });
  assert.deepEqual(bucketsVerdict({ ok: 80, expected: 3, warn: 0, blocking: 1 }), {
    ok: false,
    blocking: ["1 blocking row(s)"],
    warn: [],
  });
});

test("bucketsVerdict 对空表、缺字段、null 都给绿灯（一行都没跑不等于红）", () => {
  const green = { ok: true, blocking: [], warn: [] };
  assert.deepEqual(bucketsVerdict(null), green);
  assert.deepEqual(bucketsVerdict({}), green);
  assert.deepEqual(bucketsVerdict({ expected: 5 }), green);
});

test("classifyBehaviourState：broken 与 unexpected 是红，inert 只是黄", () => {
  assert.equal(classifyBehaviourState("ok"), "ok");
  assert.equal(classifyBehaviourState("already"), "ok");
  assert.equal(classifyBehaviourState("inert"), "warn");
  assert.equal(classifyBehaviourState("broken"), "blocking");
  assert.equal(classifyBehaviourState("unexpected"), "blocking");
  // 不认识的态按最坏算 —— 这条比什么都重要：新状态默认为绿就等于默认为安全。
  assert.equal(classifyBehaviourState("something-new"), "blocking");
  assert.equal(classifyBehaviourState(""), "blocking");
});

test("classifyGateState：同一版本掉针是红，跨版本掉针只是黄", () => {
  assert.equal(classifyGateState({ state: "present" }, false), "ok");
  assert.equal(classifyGateState({ state: "skipped" }, false), "ok");
  assert.equal(classifyGateState({ state: "missing" }, false), "blocking");
  // drift=true 意思是「表钉的版本与这棵树不同」，掉针是预期内的重算工作量。
  assert.equal(classifyGateState({ state: "missing" }, true), "warn");
  // unreadable（这棵树里没有那个文件，比如桌面壳）什么都不能说明。
  assert.equal(classifyGateState({ state: "unreadable" }, false), "warn");
  assert.equal(classifyGateState(null, false), "warn");
});

test("gateVerdict：同版本掉针拦路，跨版本掉针给重算提示", () => {
  const pinned = gateVerdict({
    version: "0.2.2-rc.1",
    tableVersion: "0.2.2-rc.1",
    drift: false,
    tally: { present: 50, missing: 3, unreadable: 0, skipped: 0 },
  });
  assert.equal(pinned.ok, false);
  assert.deepEqual(pinned.blocking, ["3 needle(s) missing on the pinned version: the table and the tree disagree"]);
  assert.deepEqual(pinned.warn, []);

  const drifted = gateVerdict({
    version: "0.2.2-rc.2",
    tableVersion: "0.2.2-rc.1",
    drift: true,
    tally: { present: 50, missing: 3, unreadable: 0, skipped: 0 },
  });
  assert.equal(drifted.ok, true);
  assert.deepEqual(drifted.blocking, []);
  assert.equal(drifted.warn.length, 1);
  assert.match(drifted.warn[0], /3 needle\(s\) moved between 0\.2\.2-rc\.1 and 0\.2\.2-rc\.2/);
});

test("gateVerdict：读不到的文件只算提醒，不拦；全绿时两个数组都空", () => {
  const partial = gateVerdict({ version: "x", tableVersion: "x", drift: false, tally: { present: 40, missing: 0, unreadable: 7, skipped: 2 } });
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.blocking, []);
  assert.deepEqual(partial.warn, ["7 gate row(s) point at a file this tree does not contain"]);

  const clean = gateVerdict({ version: "x", tableVersion: "x", drift: false, tally: { present: 58, missing: 0, unreadable: 0, skipped: 0 } });
  assert.deepEqual(clean, { ok: true, blocking: [], warn: [] });

  assert.deepEqual(gateVerdict(null), { ok: true, blocking: [], warn: [] });
});
