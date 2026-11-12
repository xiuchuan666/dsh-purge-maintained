// 锁住 lib/hooks-deny.js：#80 的 hooks deny/ask 旁路开关、反向写回官方形态、状态标注。
//
// 为什么值得单独测：这七件事全部「坏了不报错」。
//   - 反向替换漏一条 → 官方文件里留着 __dsh_purge_deny_disabled__ 死字符串，宿主 hooks 语义永久变形；
//   - 旁路关了但 sentinel 还在 → 下次启动补丁重新打上，hooks 又在拦，用户以为开关没用；
//   - annotateHookDenyStatus 把已 applied 的覆写成 pending → 面板显示「还没打」，用户会去重装；
//   - selectPatches 漏掉某条 id → 关掉旁路后仍有一条在拦，只有实际被拦时才发现。
//
// 注意：REVERSES 里的 find 用的是**真制表符与真换行**（源码里写成 "\t"），
// 所以这里用 TAB/NL 常量拼串，避免手写转义层数出错（本项目已因转义踩过多次坑）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOOK_DENY_PATCH_IDS,
  applyHookDenyReverses,
  hookFileLooksBypassed,
  restoreHookDenyOfficial,
  annotateHookDenyStatus,
  hookDenySettingsPath,
  loadHookDenySettings,
  saveHookDenySettings,
  selectPatches,
} from "../lib/hooks-deny.js";

const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);
const T = TAB + TAB;
const T3 = TAB + TAB + TAB;
const SENTINEL = "__dsh_purge_deny_disabled__";
const MARK_STOP = "[dsh-purge] Stop hook steer disabled";
const MARK_SUBMIT = "[dsh-purge] UserPromptSubmit deny→allow";
const MARK_ALLOW = "[dsh-purge] hooks deny→allow";

/** 本插件写出的八种形态，逐字对应 REVERSES 的 find。 */
const FORMS = {
  R1a:
    T + 'if (merged.decision === "deny") { /* ' + MARK_SUBMIT + " */ }" + NL +
    T + 'else if (merged.decision === "' + SENTINEL + '") { /* [dsh-purge] pre-step reject disabled */ }',
  R1a2:
    T + 'if (merged.decision === "' + SENTINEL + '") /* ' + MARK_ALLOW + " */" +
    " { /* " + MARK_SUBMIT + " */ }" + NL +
    T + 'else if (merged.decision === "' + SENTINEL + '") { /* [dsh-purge] pre-step reject disabled */ }',
  R1b: T + 'if (merged.decision === "' + SENTINEL + '") /* ' + MARK_ALLOW + ' */ return { kind: "reject" };',
  R2a: T + 'if (merged.decision === "' + SENTINEL + '") /* ' + MARK_ALLOW + " */ return {" + NL + T3 + 'kind: "deny",',
  R2b: T + 'if (merged.decision === "' + SENTINEL + '") /* ' + MARK_ALLOW + " */ return {" + NL + T3 + 'kind: "block",',
  R3: T + 'if (merged.decision === "ask") return next(); /* [dsh-purge] hooks ask→allow */',
  R5a:
    T + 'if (merged.decision === "' + SENTINEL + '") /* ' + MARK_ALLOW + " */ {" + NL +
    T3 + "return; // " + MARK_STOP + NL,
  R5b:
    T + 'if (merged.decision === "' + SENTINEL + '") /* ' + MARK_ALLOW + " */ {" + NL +
    T3 + 'const text = merged.reason ?? "continue: blocked by Stop hook";',
};

/** 官方形态（反向替换后应有的样子）。 */
const OFFICIAL = {
  R1a: T + 'if (merged.decision === "deny") return { kind: "reject" };',
  R1a2: T + 'if (merged.decision === "deny") return { kind: "reject" };',
  R1b: T + 'if (merged.decision === "deny") return { kind: "reject" };',
  R2a: T + 'if (merged.decision === "deny") return {' + NL + T3 + 'kind: "deny",',
  R2b: T + 'if (merged.decision === "deny") return {' + NL + T3 + 'kind: "block",',
  R3:
    T + 'if (merged.decision === "ask") return {' + NL +
    T3 + 'kind: "ask",' + NL +
    T3 + "...merged.reason !== void 0 ? { reason: merged.reason } : {}" + NL +
    T + "};",
  R5a: T + 'if (merged.decision === "deny") {' + NL,
  R5b:
    T + 'if (merged.decision === "deny") {' + NL +
    T3 + 'const text = merged.reason ?? "continue: blocked by Stop hook";',
};

const HEADER = "// fake official hook file" + NL;
const FOOTER = T + "return next();" + NL;

// ---------------------------------------------------------------- 反向替换

for (const id of Object.keys(FORMS)) {
  test(`反向替换 ${id}：命中本插件写出的形态并逐字写回官方写法`, () => {
    const src = HEADER + FORMS[id] + NL + FOOTER;
    const out = applyHookDenyReverses(src);
    assert.deepEqual(out.hits, [id], `${id} 必须命中且只命中这一条`);
    assert.equal(out.text, HEADER + OFFICIAL[id] + NL + FOOTER);
    // 官方形态里不该再有本插件的痕迹（R3 的官方写法本身不含 marker）
    assert.ok(!out.text.includes(SENTINEL));
    assert.ok(!out.text.includes(MARK_ALLOW));
    assert.ok(!out.text.includes(MARK_STOP));
  });
}

test("反向替换：已经是官方形态的文件命中为空且一个字节都不改", () => {
  const src = HEADER + OFFICIAL.R1a + NL + OFFICIAL.R3 + NL + FOOTER;
  const out = applyHookDenyReverses(src);
  assert.deepEqual(out.hits, []);
  assert.equal(out.text, src);
});

test("反向替换：同一份文件里多条形态一次全清（除 R1a/R1a2 共享尾行的情况外）", () => {
  // R1b / R2a / R2b / R3 / R5a / R5b 互不包含，可以同处一份文件
  const src =
    HEADER + FORMS.R1b + NL + FORMS.R2a + NL + FORMS.R2b + NL + FORMS.R3 + NL + FORMS.R5a + FORMS.R5b + FOOTER;
  const out = applyHookDenyReverses(src);
  assert.deepEqual(out.hits, ["R1b", "R2a", "R2b", "R3", "R5a", "R5b"]);
  assert.ok(!out.text.includes(SENTINEL));
  assert.ok(!out.text.includes(MARK_STOP));
});

test("反向替换：跑第二遍是幂等的（第一遍已还原，第二遍必须无命中）", () => {
  const once = applyHookDenyReverses(HEADER + FORMS.R1a + NL + FOOTER);
  const twice = applyHookDenyReverses(once.text);
  assert.deepEqual(twice.hits, []);
  assert.equal(twice.text, once.text);
});

test("反向替换：空值与非字符串输入不抛，返回空文本与空命中", () => {
  for (const v of [undefined, null, "", 0]) {
    const out = applyHookDenyReverses(v);
    assert.deepEqual(out.hits, []);
    assert.equal(typeof out.text, "string");
  }
});

test("反向替换：同一形态在文件里出现多次时全部还原（split/join 而非 replace 一次）", () => {
  // 真机上 30/65 会跨多个 hook 文件与多段代码重复写同一形态；
  // 只替第一个会让第二处留下 sentinel，下次启动补丁又打回去。
  const src = HEADER + FORMS.R1b + NL + FORMS.R1b + NL + FORMS.R3 + NL + FORMS.R3 + NL + FOOTER;
  const out = applyHookDenyReverses(src);
  assert.deepEqual(out.hits, ["R1b", "R3"], "同一规则多次命中只记一次 id");
  assert.equal(out.text.split(OFFICIAL.R1b).length - 1, 2, "两处 R1b 都要还原");
  assert.equal(out.text.split(OFFICIAL.R3).length - 1, 2, "两处 R3 都要还原");
  assert.ok(!out.text.includes(SENTINEL));
});

test("反向替换：R1a 与 R1a2 共享尾行，但两条互不吞并——同时出现时各命中一次", () => {
  // R1a 的 find 前缀是 `decision === "deny"`，R1a2 的前缀是 sentinel 形态；
  // 两者只共享「pre-step reject disabled」尾行，所以 R1a 先跑不会吃掉 R1a2 的前半段。
  // 这条钉的是「两条规则都必须保留」：删掉任意一条，同时出现时就会有形态漏还原。
  const order1 = applyHookDenyReverses(HEADER + FORMS.R1a2 + NL + FORMS.R1a + NL + FOOTER);
  const order2 = applyHookDenyReverses(HEADER + FORMS.R1a + NL + FORMS.R1a2 + NL + FOOTER);
  for (const out of [order1, order2]) {
    assert.deepEqual(out.hits, ["R1a", "R1a2"]);
    assert.ok(!out.text.includes(SENTINEL), "sentinel 必须被清干净");
    assert.ok(!out.text.includes(MARK_SUBMIT), "marker 必须被清干净");
  }
  // 两种顺序结果一致（replace 不依赖先后）
  assert.equal(order1.text, order2.text);
});

// ---------------------------------------------------------------- 旁路痕迹判定

test("hookFileLooksBypassed：三个标记任一出现即算脏，干净文本与空值都算干净", () => {
  assert.equal(hookFileLooksBypassed("x" + SENTINEL + "x"), true);
  assert.equal(hookFileLooksBypassed("x " + MARK_STOP + " x"), true);
  assert.equal(hookFileLooksBypassed("x " + MARK_SUBMIT + " x"), true);
  assert.equal(hookFileLooksBypassed('if (merged.decision === "deny") return { kind: "reject" };'), false);
  assert.equal(hookFileLooksBypassed(""), false);
  assert.equal(hookFileLooksBypassed(undefined), false);
  assert.equal(hookFileLooksBypassed(null), false);
});

test("hookFileLooksBypassed：还原后的官方文件必须被判为干净", () => {
  const restored = applyHookDenyReverses(HEADER + FORMS.R1a + NL + FOOTER).text;
  assert.equal(hookFileLooksBypassed(restored), false);
});

// ---------------------------------------------------------------- restoreHookDenyOfficial

function ioOf(files, options = {}) {
  return {
    hookDenyPaths: () => Object.keys(files),
    loadText: async (fp) => {
      if (!(fp in files)) throw new Error("ENOENT " + fp);
      return files[fp];
    },
    saveText: async (fp, text) => {
      if (options.throwSave === fp) throw new Error("EACCES " + fp);
      if (options.refuseSave === fp) return false;
      files[fp] = text;
      return true;
    },
  };
}

const emptyResult = { files: [], changed: [], misses: [], sentinelLeft: [], hitsByFile: {} };

test("restoreHookDenyOfficial：缺 aiBase 或 io 时返回空结果，不去碰文件", async () => {
  const files = { "/a.js": FORMS.R1a };
  const io = ioOf(files);
  assert.deepEqual(await restoreHookDenyOfficial("", io), emptyResult);
  assert.deepEqual(await restoreHookDenyOfficial("/base", null), emptyResult);
  assert.deepEqual(await restoreHookDenyOfficial(null, io), emptyResult);
  assert.equal(files["/a.js"], FORMS.R1a, "没动文件");
});

test("restoreHookDenyOfficial：命中的文件被写回官方形态并计入 changed", async () => {
  const files = { "/a.js": HEADER + FORMS.R1a + NL + FOOTER };
  const out = await restoreHookDenyOfficial("/base", ioOf(files));
  assert.deepEqual(out.files, ["/a.js"]);
  assert.deepEqual(out.changed, ["/a.js"]);
  assert.deepEqual(out.hitsByFile["/a.js"], ["R1a"]);
  assert.deepEqual(out.misses, []);
  assert.deepEqual(out.sentinelLeft, []);
  assert.equal(files["/a.js"], HEADER + OFFICIAL.R1a + NL + FOOTER);
});

test("restoreHookDenyOfficial：读失败进 misses 并跳过，不影响后面的文件", async () => {
  // /gone.js 在 paths 里但读不到（真机上表现为文件已被宿主升级删掉）
  const files = { "/ok.js": HEADER + FORMS.R1b + NL + FOOTER };
  const io = ioOf(files);
  io.hookDenyPaths = () => ["/gone.js", "/ok.js"];
  const out = await restoreHookDenyOfficial("/base", io);
  assert.deepEqual(out.files, ["/gone.js", "/ok.js"]);
  assert.deepEqual(out.misses, ["/gone.js"]);
  assert.deepEqual(out.changed, ["/ok.js"]);
  assert.equal(out.hitsByFile["/gone.js"], undefined, "读失败的文件不进 hitsByFile");
});

test("restoreHookDenyOfficial：写失败进 misses，但命中记录保留（便于排查）", async () => {
  const files = { "/ro.js": HEADER + FORMS.R1b + NL + FOOTER };
  const out = await restoreHookDenyOfficial("/base", ioOf(files, { throwSave: "/ro.js" }));
  assert.deepEqual(out.misses, ["/ro.js"]);
  assert.deepEqual(out.changed, []);
  assert.deepEqual(out.hitsByFile["/ro.js"], ["R1b"]);
  assert.equal(files["/ro.js"], HEADER + FORMS.R1b + NL + FOOTER, "写失败时文件保持原样");
});

test("restoreHookDenyOfficial：saveText 返回 false 不算 changed（视为没写成功）", async () => {
  const files = { "/skip.js": HEADER + FORMS.R1b + NL + FOOTER };
  const out = await restoreHookDenyOfficial("/base", ioOf(files, { refuseSave: "/skip.js" }));
  assert.deepEqual(out.changed, []);
  assert.deepEqual(out.misses, []);
  assert.deepEqual(out.hitsByFile["/skip.js"], ["R1b"]);
});

test("restoreHookDenyOfficial：没有任何形态命中但文件里还有 sentinel → 记 sentinelLeft 且不写盘", async () => {
  const dirty = HEADER + "const X = '" + SENTINEL + "';" + NL + FOOTER;
  const files = { "/stale.js": dirty };
  const out = await restoreHookDenyOfficial("/base", ioOf(files));
  assert.deepEqual(out.hitsByFile["/stale.js"], []);
  assert.deepEqual(out.sentinelLeft, ["/stale.js"]);
  assert.deepEqual(out.changed, []);
  assert.equal(files["/stale.js"], dirty, "认不出的形态不能乱写");
});

test("restoreHookDenyOfficial：命中了但还原后仍留 sentinel（形态演化）→ 同时进 changed 与 sentinelLeft", async () => {
  const src = HEADER + FORMS.R1b + NL + "const X = '" + SENTINEL + "';" + NL + FOOTER;
  const files = { "/mixed.js": src };
  const out = await restoreHookDenyOfficial("/base", ioOf(files));
  assert.deepEqual(out.changed, ["/mixed.js"]);
  assert.deepEqual(out.sentinelLeft, ["/mixed.js"]);
});

test("restoreHookDenyOfficial：官方文件原样不动（不写盘、不进任何名单）", async () => {
  const official = HEADER + OFFICIAL.R1a + NL + FOOTER;
  const files = { "/clean.js": official };
  const out = await restoreHookDenyOfficial("/base", ioOf(files));
  assert.deepEqual(out.files, ["/clean.js"]);
  assert.deepEqual(out.changed, []);
  assert.deepEqual(out.misses, []);
  assert.deepEqual(out.sentinelLeft, []);
  assert.deepEqual(out.hitsByFile["/clean.js"], []);
  assert.equal(files["/clean.js"], official);
});

// ---------------------------------------------------------------- annotateHookDenyStatus

function statusOf(extra = {}) {
  const status = {};
  for (const id of HOOK_DENY_PATCH_IDS) status[id] = "pending";
  return Object.assign(status, extra);
}

test("annotateHookDenyStatus：旁路还开着（settings 未关）时原样返回同一个对象", async () => {
  // 初始状态故意都不是 pending/skipped，文件故意是脏的：
  // 若把 `!== false` 写成 `=== true`，undefined / {} 两种入参会走到下面把状态改掉。
  const status = statusOf({ 30: "unmatched", 31: "unmatched", 64: "unmatched", 65: "unmatched" });
  const snapshot = JSON.stringify(status);
  const files = { "/a.js": HEADER + FORMS.R1b + NL + FOOTER };
  assert.equal(await annotateHookDenyStatus(status, { hooksDenyBypass: true }, "/base", ioOf(files)), status);
  assert.equal(await annotateHookDenyStatus(status, undefined, "/base", ioOf(files)), status);
  assert.equal(await annotateHookDenyStatus(status, {}, "/base", ioOf(files)), status);
  assert.equal(JSON.stringify(status), snapshot, "旁路开着时不能改状态");
});

test("annotateHookDenyStatus：缺 status 或缺 aiBase 时原样返回，不去读盘", async () => {
  const files = { "/a.js": FORMS.R1a };
  const io = ioOf(files);
  assert.equal(await annotateHookDenyStatus(null, { hooksDenyBypass: false }, "/base", io), null);
  assert.equal(await annotateHookDenyStatus(undefined, { hooksDenyBypass: false }, "/base", io), undefined);
  const status = statusOf();
  assert.equal(await annotateHookDenyStatus(status, { hooksDenyBypass: false }, "", io), status);
  assert.deepEqual(status, statusOf(), "没 aiBase 时状态不变");
});

test("annotateHookDenyStatus：旁路已关 + 文件里还有痕迹 → 未 applied 的四条标成 pending", async () => {
  const status = statusOf({ 30: "pending", 31: "skipped", 64: "unmatched", 65: "drifted" });
  const files = { "/a.js": HEADER + FORMS.R1b + NL + FOOTER };
  await annotateHookDenyStatus(status, { hooksDenyBypass: false }, "/base", ioOf(files));
  assert.equal(status[30], "pending");
  assert.equal(status[31], "pending");
  assert.equal(status[64], "pending");
  assert.equal(status[65], "pending");
});

test("annotateHookDenyStatus：旁路已关 + 文件干净 → 未 applied 的四条标成 skipped", async () => {
  const status = statusOf({ 30: "pending", 31: "unmatched", 64: "drifted", 65: "pending" });
  const files = { "/a.js": HEADER + OFFICIAL.R1a + NL + FOOTER };
  await annotateHookDenyStatus(status, { hooksDenyBypass: false }, "/base", ioOf(files));
  for (const id of HOOK_DENY_PATCH_IDS) assert.equal(status[id], "skipped", `#${id} 应标 skipped`);
});

test("annotateHookDenyStatus：已经 applied 的补丁绝不被覆写（#M12）", async () => {
  const status = statusOf({ 30: "applied", 31: "pending", 64: "pending", 65: "pending" });
  const files = { "/a.js": HEADER + FORMS.R1b + NL + FOOTER };
  await annotateHookDenyStatus(status, { hooksDenyBypass: false }, "/base", ioOf(files));
  assert.equal(status[30], "applied");
  assert.equal(status[31], "pending");
  assert.equal(status[64], "pending");
  assert.equal(status[65], "pending");
});

test("annotateHookDenyStatus：na 与 missing_file 一律跳过（不是本机能判的状态）", async () => {
  const status = statusOf({ 30: "na", 31: "missing_file", 64: "pending", 65: "pending" });
  const files = { "/a.js": HEADER + OFFICIAL.R1a + NL + FOOTER };
  await annotateHookDenyStatus(status, { hooksDenyBypass: false }, "/base", ioOf(files));
  assert.equal(status[30], "na");
  assert.equal(status[31], "missing_file");
  assert.equal(status[64], "skipped");
  assert.equal(status[65], "skipped");
});

test("annotateHookDenyStatus：第一个文件就脏时立刻停手，不再读后面的文件", async () => {
  // 宿主 hooks 目录里可能有几十个文件；脏了还继续读完，每次打开面板都要白读一遍盘。
  const status = statusOf({ 30: "unmatched" });
  const files = {
    "/dirty.js": HEADER + FORMS.R1b + NL + FOOTER,
    "/clean1.js": HEADER + OFFICIAL.R1a + NL + FOOTER,
    "/clean2.js": HEADER + OFFICIAL.R1a + NL + FOOTER,
  };
  let reads = 0;
  const io = {
    hookDenyPaths: () => Object.keys(files),
    loadText: async (fp) => {
      reads += 1;
      return files[fp];
    },
    saveText: async () => true,
  };
  await annotateHookDenyStatus(status, { hooksDenyBypass: false }, "/base", io);
  assert.equal(reads, 1, "第一个文件已判脏，只应读一次");
  assert.equal(status[30], "pending");
});

test("annotateHookDenyStatus：所有文件都读不到时视为干净（不因缺文件把状态标成 pending）", async () => {
  const status = statusOf({ 30: "unmatched" });
  const io = ioOf({});
  io.hookDenyPaths = () => ["/gone-a.js", "/gone-b.js"];
  await annotateHookDenyStatus(status, { hooksDenyBypass: false }, "/base", io);
  assert.equal(status[30], "skipped");
});

test("annotateHookDenyStatus：paths 为空（宿主没有这四条的文件）时也标 skipped", async () => {
  const status = statusOf({ 30: "unmatched" });
  await annotateHookDenyStatus(status, { hooksDenyBypass: false }, "/base", ioOf({}));
  assert.equal(status[30], "skipped");
});

test("annotateHookDenyStatus：只看四个 id，其它补丁的状态一个都不碰", async () => {
  const status = Object.assign(statusOf(), { 1: "applied", 70: "pending", 76: "drifted" });
  const files = { "/a.js": HEADER + FORMS.R1b + NL + FOOTER };
  await annotateHookDenyStatus(status, { hooksDenyBypass: false }, "/base", ioOf(files));
  assert.equal(status[1], "applied");
  assert.equal(status[70], "pending");
  assert.equal(status[76], "drifted");
});

// ---------------------------------------------------------------- 设置读写

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-hd-"));
}

test("hookDenySettingsPath：落在 <home>/dsh-purge/hooks-deny.json", () => {
  const home = path.join("C:", "fake-home");
  assert.equal(hookDenySettingsPath(home), path.join(home, "dsh-purge", "hooks-deny.json"));
});

test("loadHookDenySettings：没有文件也没有配置值时默认开（true）", () => {
  const home = makeHome();
  try {
    assert.deepEqual(loadHookDenySettings(home), { hooksDenyBypass: true });
    assert.deepEqual(loadHookDenySettings(home, undefined), { hooksDenyBypass: true });
    assert.deepEqual(loadHookDenySettings(home, "yes"), { hooksDenyBypass: true }, "非布尔配置值被忽略");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("loadHookDenySettings：配置值优先于默认值，文件值优先于配置值", () => {
  const home = makeHome();
  try {
    assert.deepEqual(loadHookDenySettings(home, false), { hooksDenyBypass: false });
    assert.deepEqual(loadHookDenySettings(home, true), { hooksDenyBypass: true });
    const fp = hookDenySettingsPath(home);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify({ hooksDenyBypass: false }), "utf8");
    assert.deepEqual(loadHookDenySettings(home, true), { hooksDenyBypass: false }, "文件值赢过配置值");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("loadHookDenySettings：坏 JSON、非对象、非布尔字段一律回落，不抛", () => {
  const home = makeHome();
  const fp = hookDenySettingsPath(home);
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, "{not json", "utf8");
    assert.deepEqual(loadHookDenySettings(home, false), { hooksDenyBypass: false }, "坏 JSON 退回配置值");
    fs.writeFileSync(fp, "[1,2,3]", "utf8");
    assert.deepEqual(loadHookDenySettings(home), { hooksDenyBypass: true }, "数组不算对象");
    fs.writeFileSync(fp, JSON.stringify({ hooksDenyBypass: "false" }), "utf8");
    assert.deepEqual(loadHookDenySettings(home), { hooksDenyBypass: true }, "字符串 false 不算布尔");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("saveHookDenySettings：写出两空格缩进 + 结尾换行，并回 ok 与落点", () => {
  const home = makeHome();
  try {
    const out = saveHookDenySettings(home, { hooksDenyBypass: false });
    assert.equal(out.ok, true);
    assert.equal(out.hooksDenyBypass, false);
    assert.equal(out.path, hookDenySettingsPath(home));
    const text = fs.readFileSync(hookDenySettingsPath(home), "utf8");
    assert.equal(text, JSON.stringify({ hooksDenyBypass: false }, null, 2) + NL);
    assert.deepEqual(loadHookDenySettings(home), { hooksDenyBypass: false }, "写完能读回来");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("saveHookDenySettings：patch 没给布尔值时保留旧值，不把开关意外打开", () => {
  const home = makeHome();
  try {
    saveHookDenySettings(home, { hooksDenyBypass: false });
    const out = saveHookDenySettings(home, {});
    assert.equal(out.hooksDenyBypass, false);
    assert.equal(saveHookDenySettings(home, null).hooksDenyBypass, false);
    assert.equal(saveHookDenySettings(home, { hooksDenyBypass: "true" }).hooksDenyBypass, false);
    assert.equal(saveHookDenySettings(home, { hooksDenyBypass: true }).hooksDenyBypass, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("saveHookDenySettings：目录不存在时自己建出来（原子写的 mkdir 分支）", () => {
  const home = makeHome();
  try {
    const nested = path.join(home, "deep", "nested");
    saveHookDenySettings(nested, { hooksDenyBypass: true });
    assert.equal(fs.existsSync(hookDenySettingsPath(nested)), true);
    const leftovers = fs.readdirSync(path.dirname(hookDenySettingsPath(nested))).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "写完不能留 .tmp 残片");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("saveHookDenySettings：落点被目录占住时抛错，且不留下 .tmp 残片", () => {
  // 原子写的 rename 失败分支：Windows 上 rename 到已存在的目录抛 EPERM。
  // 这条分支要保证两件事：异常要往上抛（调用方得知道没写成功），临时文件要收走。
  const home = makeHome();
  try {
    const fp = hookDenySettingsPath(home);
    fs.mkdirSync(fp, { recursive: true });
    let err = null;
    try {
      saveHookDenySettings(home, { hooksDenyBypass: false });
    } catch (e) {
      err = e;
    }
    assert.notEqual(err, null, "写不进去必须抛错，不能静默成功");
    assert.match(String(err.code || ""), /^(EPERM|EISDIR|EACCES|ENOTEMPTY)$/);
    const leftovers = fs.readdirSync(path.dirname(fp)).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "rename 失败后不能留下 .tmp 残片");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- selectPatches

test("selectPatches：旁路开着（或设置缺失）时四条补丁照常进队", () => {
  const patches = [{ id: 1 }, { id: 30 }, { id: 31 }, { id: 64 }, { id: 65 }, { id: 70 }];
  assert.deepEqual(selectPatches(patches, { hooksDenyBypass: true }).map((p) => p.id), [1, 30, 31, 64, 65, 70]);
  assert.deepEqual(selectPatches(patches, undefined).map((p) => p.id), [1, 30, 31, 64, 65, 70]);
  assert.deepEqual(selectPatches(patches, {}).map((p) => p.id), [1, 30, 31, 64, 65, 70]);
});

test("selectPatches：旁路关掉时四条一个不留，其余补丁顺序不变", () => {
  const patches = [{ id: 1 }, { id: 30 }, { id: 31 }, { id: 64 }, { id: 65 }, { id: 70 }];
  assert.deepEqual(selectPatches(patches, { hooksDenyBypass: false }).map((p) => p.id), [1, 70]);
  assert.deepEqual(selectPatches([], { hooksDenyBypass: false }), []);
});

test("selectPatches：四条 id 与 HOOK_DENY_PATCH_IDS 完全一致（产品语义：永远同开关）", () => {
  assert.deepEqual([...HOOK_DENY_PATCH_IDS], [30, 31, 64, 65]);
  const patches = HOOK_DENY_PATCH_IDS.map((id) => ({ id }));
  assert.deepEqual(selectPatches(patches, { hooksDenyBypass: false }), []);
  assert.equal(selectPatches(patches, { hooksDenyBypass: true }).length, 4);
});

test("selectPatches：只认 id，不误伤 id 相同但类型不同的项之外的东西", () => {
  const patches = [{ id: "30" }, { id: 30 }, { id: 300 }];
  assert.deepEqual(selectPatches(patches, { hooksDenyBypass: false }).map((p) => p.id), ["30", 300]);
});
