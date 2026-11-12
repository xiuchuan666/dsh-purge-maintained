import { test } from "node:test";
import assert from "node:assert/strict";
import {
  packagesFromTargetFiles,
  summarizeStatuses,
  compareToBaseline,
  describeOutcome,
  isSafeSandboxDir,
} from "../scripts/sandbox-apply-lib.mjs";

const AI = "C:\\host\\node_modules\\@deepseek-ai";

/* ---------- 包清单推导 ---------- */

test("包清单：反斜杠路径也能推出包名（Windows 上 targetFiles 返回反斜杠、aiBase 是正斜杠）", () => {
  const files = {
    a: "C:\\host\\node_modules\\@deepseek-ai\\dsh-agent-instructions\\lib\\index.js",
    b: ["C:\\host\\node_modules\\@deepseek-ai\\dsh-web-app\\cordis.patch.yml", "C:\\host\\node_modules\\@deepseek-ai\\dsh-web-app\\lib\\index.js"],
  };
  assert.deepEqual(packagesFromTargetFiles(files, "C:/host/node_modules/@deepseek-ai"), ["dsh-agent-instructions", "dsh-web-app"]);
});

test("包清单：同一个包多个文件只算一次，结果排序稳定", () => {
  const files = {
    x: "C:/h/@deepseek-ai/dsh-zeta/lib/a.js",
    y: "C:/h/@deepseek-ai/dsh-alpha/lib/b.js",
    z: "C:/h/@deepseek-ai/dsh-alpha/lib/c.js",
  };
  assert.deepEqual(packagesFromTargetFiles(files, "C:/h/@deepseek-ai"), ["dsh-alpha", "dsh-zeta"]);
});

test("包清单：空值 / 空数组 / 空串都跳过，不产生空包名", () => {
  const files = { a: "", b: null, c: undefined, d: [], e: "C:/h/@deepseek-ai/dsh-ok/lib/x.js" };
  assert.deepEqual(packagesFromTargetFiles(files, "C:/h/@deepseek-ai"), ["dsh-ok"]);
});

test("包清单：不在 aiBase 下面的路径一律不收（防止把 $DSH_HOME 里的文件也复制进来）", () => {
  const files = {
    inside: "C:/h/@deepseek-ai/dsh-inside/lib/x.js",
    outside: "C:/Users/me/.dsh/profiles/web/node_modules/@linxin666/dsh-liangshen/presets/x.mjs",
  };
  assert.deepEqual(packagesFromTargetFiles(files, "C:/h/@deepseek-ai"), ["dsh-inside"]);
});

test("包清单：aiBase 自己不是包目录，不能被切成空串或整段", () => {
  const files = { a: "C:/h/@deepseek-ai" };
  assert.deepEqual(packagesFromTargetFiles(files, "C:/h/@deepseek-ai"), []);
});

test("包清单：大小写不同的盘符/目录仍能匹配（Windows 路径不区分大小写）", () => {
  const files = { a: "c:/HOST/@deepseek-ai/dsh-x/lib/i.js" };
  assert.deepEqual(packagesFromTargetFiles(files, "C:/host/@deepseek-ai"), ["dsh-x"]);
});

test("包清单：aiBase 为空或 files 不是对象时返回空数组，不抛", () => {
  assert.deepEqual(packagesFromTargetFiles({}, ""), []);
  assert.deepEqual(packagesFromTargetFiles(null, AI), []);
  assert.deepEqual(packagesFromTargetFiles(undefined, AI), []);
});

/* ---------- 状态归类 ---------- */

test("状态归类：hit_count_mismatch 这种带冒号的状态只取冒号前", () => {
  const report = [
    { status: "applied" },
    { status: "hit_count_mismatch:3/4" },
    { status: "hit_count_mismatch:1/2" },
    { status: "already" },
  ];
  assert.deepEqual(summarizeStatuses(report), { counts: { applied: 1, hit_count_mismatch: 2, already: 1 }, total: 4 });
});

test("状态归类：缺 status 的行走 unknown，不抛", () => {
  assert.deepEqual(summarizeStatuses([{}, { status: null }]), { counts: { unknown: 2 }, total: 2 });
});

test("状态归类：空报告返回 total 0", () => {
  assert.deepEqual(summarizeStatuses([]), { counts: {}, total: 0 });
  assert.deepEqual(summarizeStatuses(null), { counts: {}, total: 0 });
});

/* ---------- 与基线对拍 ---------- */

const baseline = {
  a: { rel: "dsh-a/lib/index.js", sha256: "aaaa1111bbbb2222" },
  b: { rel: "dsh-b/lib/index.js", sha256: "cccc3333dddd4444" },
  c: { rel: "dsh-c/lib/index.js", sha256: "eeee5555ffff6666" },
};

test("对拍：三个文件全一致时 diff 与 missing 都是 0", () => {
  const digests = new Map([
    ["dsh-a/lib/index.js", "aaaa1111bbbb2222"],
    ["dsh-b/lib/index.js", "cccc3333dddd4444"],
    ["dsh-c/lib/index.js", "eeee5555ffff6666"],
  ]);
  const out = compareToBaseline(baseline, digests);
  assert.equal(out.total, 3);
  assert.equal(out.same, 3);
  assert.equal(out.diff, 0);
  assert.equal(out.missing, 0);
});

test("对拍：读不到的文件记 missing（不是 diff），这样结论能区分「复制不全」与「打歪了」", () => {
  const digests = new Map([
    ["dsh-a/lib/index.js", "aaaa1111bbbb2222"],
    ["dsh-b/lib/index.js", null],
  ]);
  const out = compareToBaseline(baseline, digests);
  /* b 的 sha 是 null、c 干脆没给 —— 两个都算 missing，绝不能算成 diff。 */
  assert.equal(out.missing, 2);
  assert.equal(out.diff, 0);
  assert.equal(out.rows.find((r) => r.rel === "dsh-b/lib/index.js").state, "missing");
  assert.equal(out.rows.find((r) => r.rel === "dsh-c/lib/index.js").state, "missing");
});

test("对拍：sha 不同记 diff，并把两边的短 sha 都带出来（便于人肉比对）", () => {
  const digests = new Map([
    ["dsh-a/lib/index.js", "aaaa1111bbbb2222"],
    ["dsh-b/lib/index.js", "9999888877776666"],
    ["dsh-c/lib/index.js", "eeee5555ffff6666"],
  ]);
  const out = compareToBaseline(baseline, digests);
  const row = out.rows.find((r) => r.rel === "dsh-b/lib/index.js");
  assert.equal(row.state, "diff");
  assert.equal(row.want, "cccc3333dddd");
  assert.equal(row.got, "999988887777");
  assert.equal(out.diff, 1);
});

test("对拍：每一行都带 12 位短 sha（missing 行也要带基线侧，否则看不出该文件原来长什么样）", () => {
  const digests = new Map([["dsh-a/lib/index.js", "aaaa1111bbbb2222"]]);
  const out = compareToBaseline(baseline, digests);
  for (const row of out.rows) {
    assert.equal(row.want.length, 12, `${row.rel} 的基线短 sha 长度不对`);
    assert.equal(row.want, String(baseline[row.key].sha256).slice(0, 12));
  }
  const missingRow = out.rows.find((r) => r.state === "missing");
  assert.equal(missingRow.want, "cccc3333dddd");
  assert.equal(missingRow.got, "");
});

test("对拍：普通对象形式的 digests 也能用（脚本里两种都支持）", () => {
  const out = compareToBaseline({ a: baseline.a }, { "dsh-a/lib/index.js": "aaaa1111bbbb2222" });
  assert.equal(out.same, 1);
});

test("对拍：基线为空时 total 0，不抛", () => {
  assert.deepEqual(compareToBaseline({}, new Map()), { total: 0, same: 0, diff: 0, missing: 0, rows: [] });
  assert.equal(compareToBaseline(null, new Map()).total, 0);
});

/* ---------- 结论词 ---------- */

const reproduced = {
  compare: { total: 59, same: 59, diff: 0, missing: 0, rows: [] },
  markersPresent: true,
  firstCounts: { applied: 63, already: 5, missing_file: 10, skipped: 1, na: 7 },
  secondCounts: { already: 68, missing_file: 10, skipped: 1, na: 7 },
};

test("结论：字节全一致 + 标记在 + 第二次全 already → reproduced", () => {
  const out = describeOutcome(reproduced);
  assert.equal(out.verdict, "reproduced");
  assert.match(out.detail, /59 个文件与基线逐字节一致/);
});

test("结论：基线为空 → no-baseline，不能当成 reproduced", () => {
  const out = describeOutcome({ ...reproduced, compare: { total: 0, same: 0, diff: 0, missing: 0, rows: [] } });
  assert.equal(out.verdict, "no-baseline");
});

test("结论：有文件缺失 → missing，优先于 drift（先查复制，别急着改补丁）", () => {
  const out = describeOutcome({ ...reproduced, compare: { total: 59, same: 40, diff: 2, missing: 17, rows: [] } });
  assert.equal(out.verdict, "missing");
  assert.match(out.detail, /17 个基线文件在副本里不存在/);
});

test("结论：字节不一致 → drift，detail 里点名前 5 个文件", () => {
  const rows = [
    { rel: "a.js", state: "diff" },
    { rel: "b.js", state: "diff" },
    { rel: "c.js", state: "same" },
  ];
  const out = describeOutcome({ ...reproduced, compare: { total: 3, same: 1, diff: 2, missing: 0, rows } });
  assert.equal(out.verdict, "drift");
  assert.match(out.detail, /2 个文件重打后与基线不一致：a\.js、b\.js/);
});

test("结论：字节全对但标记不在 → no-marker（说明标记探针本身失效了）", () => {
  const out = describeOutcome({ ...reproduced, markersPresent: false });
  assert.equal(out.verdict, "no-marker");
});

test("结论：第二次重打仍有 applied → not-idempotent（打两遍会变，不能重打）", () => {
  const out = describeOutcome({ ...reproduced, secondCounts: { applied: 3, already: 65 } });
  assert.equal(out.verdict, "not-idempotent");
  assert.match(out.detail, /仍有 3 条标成 applied/);
});

test("结论：只有 already、没有 applied 的首次重打也算 reproduced（幂等重跑）", () => {
  const out = describeOutcome({ ...reproduced, firstCounts: { already: 68 }, secondCounts: { already: 68 } });
  assert.equal(out.verdict, "reproduced");
});

/* ---------- 沙盒目录安全性 ---------- */

const REPO = "D:\\dsh-purge-maintained";
const HOST = "C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness";
const HOME = "C:\\Users\\Administrator\\.dsh";

test("安全：仓库内的 .tmp-sandbox 通过", () => {
  assert.equal(isSafeSandboxDir("D:\\dsh-purge-maintained\\.tmp-sandbox", { repoRoot: REPO, protectedRoots: [HOST, HOME] }).ok, true);
});

test("安全：空目录被拒", () => {
  const out = isSafeSandboxDir("", { repoRoot: REPO });
  assert.equal(out.ok, false);
  assert.match(out.reason, /为空/);
});

test("安全：仓库外的目录被拒（「旁路」不能落在别处）", () => {
  const out = isSafeSandboxDir("D:\\somewhere\\else", { repoRoot: REPO });
  assert.equal(out.ok, false);
  assert.match(out.reason, /必须在仓库内/);
});

test("安全：正好等于受保护根、或在其内部、或是它的父目录，三种都拒", () => {
  for (const bad of [HOST, `${HOST}\\resources\\app`, "C:\\Users\\Administrator"]) {
    const out = isSafeSandboxDir(bad, { repoRoot: "C:\\", protectedRoots: [HOST] });
    assert.equal(out.ok, false, `应当拒绝 ${bad}`);
    assert.match(out.reason, /与受保护路径重叠/);
  }
});

test("安全：大小写与正反斜杠差异不影响判定", () => {
  const out = isSafeSandboxDir("c:/users/administrator/appdata/local/programs/deepseek harness/x", {
    repoRoot: "C:/",
    protectedRoots: [HOST],
  });
  assert.equal(out.ok, false);
});

test("安全：受保护根为空串时跳过，不误伤", () => {
  const out = isSafeSandboxDir("D:\\dsh-purge-maintained\\.tmp-sandbox", { repoRoot: REPO, protectedRoots: ["", null, undefined] });
  assert.equal(out.ok, true);
});
