// lib/core.js 的「提示词文件 + override-state」这一簇：读写、自改判定、安装、保存、commit。
// 全部在临时 $DSH_HOME 里跑，不碰真 home（process.env.DSH_HOME 每例重设）。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../lib/core.js";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-override-"));
const ORIG_HOME = process.env.DSH_HOME;
const ORIG_EDITOR = process.env.EDITOR;
let seq = 0;

/** 每例一个全新 home，并把它钉成 DSH_HOME（findDshHome 读它）。 */
function home(tag = "h") {
  seq += 1;
  const dir = path.join(SANDBOX, `${tag}-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.DSH_HOME = dir;
  return dir;
}

const overrideFile = (dir) => path.join(dir, "prompt-inject.md");
const stateFile = (dir) => path.join(dir, "dsh-purge", "override-state.json");
const readState = (dir) => JSON.parse(fs.readFileSync(stateFile(dir), "utf8"));

const USER = "You are my own operator prompt.\nKeep it short.\n";
// 插件默认血统：三个标记齐 → looksLikePluginDefault 恒 true（旧槽/旧盘的形态）。
const OLD_DEFAULT = "<|im_start|>system:\n<project_instructions>\nLittle Code Sauce\nold body only\n";

test.after(() => {
  if (ORIG_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIG_HOME;
  if (ORIG_EDITOR === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = ORIG_EDITOR;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// ---------------------------------------------------------------- state 读写

test("overrideStatePath 落在 $DSH_HOME/dsh-purge/override-state.json", () => {
  const h = home("state-path");
  assert.equal(core.overrideStatePath(h), path.join(h, "dsh-purge", "override-state.json"));
});

test("readOverrideStateSync：文件不存在返回 {}", () => {
  assert.deepEqual(core.readOverrideStateSync(home("state-fresh")), {});
});

test("readOverrideStateSync：坏 JSON 返回 {}（不是抛）", () => {
  const h = home("state-bad");
  fs.mkdirSync(path.join(h, "dsh-purge"), { recursive: true });
  fs.writeFileSync(stateFile(h), "{not json", "utf8");
  assert.deepEqual(core.readOverrideStateSync(h), {});
});

test("readOverrideStateSync：JSON null 返回 {}", () => {
  const h = home("state-null");
  fs.mkdirSync(path.join(h, "dsh-purge"), { recursive: true });
  fs.writeFileSync(stateFile(h), "null", "utf8");
  assert.deepEqual(core.readOverrideStateSync(h), {});
});

test("readOverrideStateSync：顶层是数组时原样返回（只判 typeof object）", () => {
  const h = home("state-array");
  fs.mkdirSync(path.join(h, "dsh-purge"), { recursive: true });
  fs.writeFileSync(stateFile(h), "[1,2]", "utf8");
  // 现状锁定：非对象也没有排除数组，调用方各自容忍。
  assert.deepEqual(core.readOverrideStateSync(h), [1, 2]);
});

test("readOverrideState 与 readOverrideStateSync 同源", async () => {
  const h = home("state-async");
  fs.mkdirSync(path.join(h, "dsh-purge"), { recursive: true });
  fs.writeFileSync(stateFile(h), '{"customized":true}', "utf8");
  assert.deepEqual(await core.readOverrideState(h), { customized: true });
  assert.deepEqual(await core.readOverrideState(h), core.readOverrideStateSync(h));
});

test("writeOverrideState：pretty JSON + 结尾换行，目录自动建", async () => {
  const h = home("state-write");
  await core.writeOverrideState(h, { a: 1, nested: { b: 2 } });
  const raw = fs.readFileSync(stateFile(h), "utf8");
  assert.equal(raw, `${JSON.stringify({ a: 1, nested: { b: 2 } }, null, 2)}\n`);
  assert.deepEqual(JSON.parse(raw), { a: 1, nested: { b: 2 } });
});

test("writeOverrideState：覆盖写入不留旧键", async () => {
  const h = home("state-overwrite");
  await core.writeOverrideState(h, { a: 1, b: 2 });
  await core.writeOverrideState(h, { a: 9 });
  assert.deepEqual(readState(h), { a: 9 });
});

test("markOverrideCustomized(true, text)：hash 记这份正文、seedHash 记当前槽", async () => {
  const h = home("mark-true");
  await core.markOverrideCustomized(h, true, USER);
  const st = readState(h);
  assert.equal(st.customized, true);
  assert.equal(st.hash, core.hashOverride(USER));
  assert.equal(st.seedHash, core.defaultOverrideHash());
  assert.match(st.updatedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
});

test("markOverrideCustomized(false)：不给正文时 hash 记当前加密槽", async () => {
  const h = home("mark-false");
  await core.markOverrideCustomized(h, false);
  const st = readState(h);
  assert.equal(st.customized, false);
  assert.equal(st.hash, core.defaultOverrideHash());
  assert.equal(st.seedHash, core.defaultOverrideHash());
});

test("markOverrideCustomized：customized 被 Boolean 化（'x' → true / 0 → false）", async () => {
  const h = home("mark-bool");
  await core.markOverrideCustomized(h, "x", USER);
  assert.equal(readState(h).customized, true);
  await core.markOverrideCustomized(h, 0, USER);
  assert.equal(readState(h).customized, false);
});

// ----------------------------------------------------- 「用户自改」的三层判据

test("looksLikePluginDefault：三个标记齐才算（旧槽/旧盘形态）", () => {
  assert.equal(core.looksLikePluginDefault(OLD_DEFAULT), true);
  assert.equal(core.looksLikePluginDefault(core.defaultOverrideText()), true);
  assert.equal(core.looksLikePluginDefault(USER), false);
  assert.equal(core.looksLikePluginDefault(""), false);
  assert.equal(core.looksLikePluginDefault("<|im_start|>system:\n<project_instructions>\nno marker here\n"), false);
});

test("isKeepableUserOverride：真空稿不算（纯空白也不算）", () => {
  const h = home("keepable-blank");
  assert.equal(core.isKeepableUserOverride(h, ""), false);
  assert.equal(core.isKeepableUserOverride(h, "   \r\n\t "), false);
  assert.equal(core.isKeepableUserOverride(h, null), false);
});

test("isKeepableUserOverride：等于当前加密槽不算", () => {
  const h = home("keepable-default");
  assert.equal(core.isKeepableUserOverride(h, core.defaultOverrideText()), false);
});

test("isKeepableUserOverride：插件默认血统不算（哪怕与当前槽不同）", () => {
  const h = home("keepable-lineage");
  assert.equal(core.isKeepableUserOverride(h, OLD_DEFAULT), false);
});

test("isKeepableUserOverride：用户稿算", () => {
  assert.equal(core.isKeepableUserOverride(home("keepable-user"), USER), true);
});

test("isKeepableUserOverride：等于 state.seedHash 的那份不算（是我们 seed 下去的）", async () => {
  const h = home("keepable-seed");
  await core.markOverrideCustomized(h, false, USER);
  assert.equal(readState(h).seedHash, core.defaultOverrideHash());
  // seedHash 记的是槽，不是 USER；把 seedHash 手工改成 USER 的哈希才命中这条判据。
  fs.writeFileSync(stateFile(h), JSON.stringify({ customized: false, seedHash: core.hashOverride(USER) }), "utf8");
  assert.equal(core.isKeepableUserOverride(h, USER), false);
});

test("isKeepableUserOverride：seedHash 判据独立于 customized（customized 为真也挡）", async () => {
  const h = home("keepable-seed-2");
  fs.mkdirSync(path.join(h, "dsh-purge"), { recursive: true });
  // customized=true 会让 overrideTextIsOurs 那条闸失效，只有独立的 seedHash 判据还挡得住。
  fs.writeFileSync(stateFile(h), JSON.stringify({ customized: true, seedHash: core.hashOverride(USER) }), "utf8");
  assert.equal(core.isKeepableUserOverride(h, USER), false);
});

test("isKeepableUserOverride：customized 未置真时，等于 state.hash 的那份不算（我们上次写的）", async () => {
  const h = home("keepable-ours");
  fs.mkdirSync(path.join(h, "dsh-purge"), { recursive: true });
  fs.writeFileSync(stateFile(h), JSON.stringify({ customized: false, hash: core.hashOverride(USER) }), "utf8");
  assert.equal(core.isKeepableUserOverride(h, USER), false);
  // customized 一旦为真，同一个 hash 就认作用户稿。
  fs.writeFileSync(stateFile(h), JSON.stringify({ customized: true, hash: core.hashOverride(USER) }), "utf8");
  assert.equal(core.isKeepableUserOverride(h, USER), true);
});

// ------------------------------------------------------------- 安装到磁盘

test("installOverride：空 home → wrote，落盘的就是当前槽，state 归零", async () => {
  const h = home("install-fresh");
  assert.equal(await core.installOverride(h), "wrote");
  const disk = fs.readFileSync(overrideFile(h), "utf8");
  assert.equal(disk.length, core.defaultOverrideText().length);
  assert.equal(core.normalizeOverride(disk), core.normalizeOverride(core.defaultOverrideText()));
  const st = readState(h);
  assert.equal(st.customized, false);
  assert.equal(st.hash, core.defaultOverrideHash());
  assert.equal(st.seedHash, core.defaultOverrideHash());
});

test("installOverride：已经是最新 → exists，不重写文件", async () => {
  const h = home("install-again");
  await core.installOverride(h);
  const before = fs.statSync(overrideFile(h)).mtimeMs;
  await new Promise((r) => setTimeout(r, 12));
  assert.equal(await core.installOverride(h), "exists");
  assert.equal(fs.statSync(overrideFile(h)).mtimeMs, before);
});

test("installOverride：盘上是用户稿 → exists，并把 customized 钉成 true", async () => {
  const h = home("install-user");
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(overrideFile(h), USER, "utf8");
  assert.equal(await core.installOverride(h), "exists");
  assert.equal(readState(h).customized, true);
  assert.equal(readState(h).hash, core.hashOverride(USER));
  assert.equal(fs.readFileSync(overrideFile(h), "utf8"), USER);
});

test("installOverride：盘上是旧默认血统 → wrote，刷成当前槽（不被误判成自改）", async () => {
  const h = home("install-lineage");
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(overrideFile(h), OLD_DEFAULT, "utf8");
  assert.equal(await core.installOverride(h), "wrote");
  assert.equal(core.normalizeOverride(fs.readFileSync(overrideFile(h), "utf8")), core.normalizeOverride(core.defaultOverrideText()));
  assert.equal(readState(h).customized, false);
});

test("installOverride：盘上正文与当前槽一致但 state 缺失 → exists 且补写 state", async () => {
  const h = home("install-same");
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(overrideFile(h), core.defaultOverrideText(), "utf8");
  assert.equal(await core.installOverride(h), "exists");
  const st = readState(h);
  assert.equal(st.customized, false);
  assert.equal(st.hash, core.defaultOverrideHash());
});

test("installOverride：force 覆盖用户稿", async () => {
  const h = home("install-force");
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(overrideFile(h), USER, "utf8");
  assert.equal(await core.installOverride(h), "exists");
  assert.equal(await core.installOverride(h, true), "wrote");
  assert.equal(core.normalizeOverride(fs.readFileSync(overrideFile(h), "utf8")), core.normalizeOverride(core.defaultOverrideText()));
  assert.equal(readState(h).customized, false);
});

test("installOverride：第二道『用户自改』闸与第一道等价（源码形状）", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "lib", "core.js"), "utf8").replace(/\r\n/g, "\n");
  // RED 演练实测：删掉第二道闸（isUserCustomizedOverride）没有任何可观察差异 —— 第一道闸
  // 已经覆盖同一批判据（空稿 / 当前槽 / 插件血统 / 我们自己写的）。它是纵深防御，只能读源码钉。
  assert.match(src, /if \(!force && await isUserCustomizedOverride\(dshHome\)\) return "exists";/);
  assert.match(src, /    && !overrideTextIsOurs\(state, disk\)\n    && !looksLikePluginDefault\(disk\)\n/);
});

test("installOverride：正文是我们自己上次写的那份 → wrote 刷回当前槽（不钉死 customized）", async () => {
  const h = home("install-ours");
  fs.mkdirSync(path.join(h, "dsh-purge"), { recursive: true });
  fs.writeFileSync(overrideFile(h), USER, "utf8");
  // hash 命中「我们上次写的」，customized 未置真 → 不该被当成用户稿；重新加密后必须能刷。
  fs.writeFileSync(stateFile(h), JSON.stringify({ customized: false, hash: core.hashOverride(USER) }), "utf8");
  assert.equal(await core.installOverride(h), "wrote");
  assert.equal(core.normalizeOverride(fs.readFileSync(overrideFile(h), "utf8")), core.normalizeOverride(core.defaultOverrideText()));
  assert.equal(readState(h).customized, false);
  assert.equal(core.isUserCustomizedOverrideSync(h), false);
});

// --------------------------------------------------------- 设置框读数

test("readOverrideForUi：没有盘上文件时预览当前槽，exists=false / usingDefault=false", async () => {
  const h = home("ui-fresh");
  const r = await core.readOverrideForUi(h);
  assert.equal(r.path, overrideFile(h));
  assert.equal(r.exists, false);
  assert.equal(r.empty, false);
  assert.equal(r.customized, false);
  assert.equal(r.usingDefault, false);
  assert.equal(r.content.length, core.defaultOverrideText().length);
  assert.equal(r.defaultContent.length, core.defaultOverrideText().length);
});

test("readOverrideForUi：装完之后 exists=true / usingDefault=true", async () => {
  const h = home("ui-installed");
  await core.installOverride(h);
  const r = await core.readOverrideForUi(h);
  assert.equal(r.exists, true);
  assert.equal(r.customized, false);
  assert.equal(r.usingDefault, true);
  assert.equal(r.empty, false);
});

test("readOverrideForUi：用户稿 → customized=true / usingDefault=false / content 就是盘上那份", async () => {
  const h = home("ui-user");
  await core.saveOverrideContent(h, USER);
  const r = await core.readOverrideForUi(h);
  assert.equal(r.customized, true);
  assert.equal(r.usingDefault, false);
  assert.equal(r.content, USER);
});

test("readOverrideForUi：盘上是空文件 → content 回落加密槽", async () => {
  const h = home("ui-empty");
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(overrideFile(h), "  \r\n ", "utf8");
  const r = await core.readOverrideForUi(h);
  assert.equal(r.exists, false, "空正文不算 exists");
  assert.equal(r.content.length, core.defaultOverrideText().length);
});

// --------------------------------------------------------- 保存（设置框点保存）

test("saveOverrideContent：用户稿 → customized=true，正文按原样落盘（不补换行）", async () => {
  const h = home("save-user");
  const r = await core.saveOverrideContent(h, USER);
  assert.equal(r.path, overrideFile(h));
  assert.equal(r.customized, true);
  assert.equal(r.content, USER);
  assert.equal(r.defaultContent.length, core.defaultOverrideText().length);
  assert.equal(fs.readFileSync(overrideFile(h), "utf8"), USER);
  assert.equal(readState(h).customized, true);
  assert.equal(readState(h).hash, core.hashOverride(USER));
});

test("saveOverrideContent：存回加密槽原件 → customized=false", async () => {
  const h = home("save-default");
  const r = await core.saveOverrideContent(h, core.defaultOverrideText());
  assert.equal(r.customized, false);
  assert.equal(readState(h).customized, false);
});

test("saveOverrideContent：非字符串内容按空串处理", async () => {
  const h = home("save-nonstr");
  const r = await core.saveOverrideContent(h, undefined);
  assert.equal(r.content, "");
  assert.equal(r.customized, false);
  assert.equal(fs.readFileSync(overrideFile(h), "utf8"), "");
});

test("saveOverrideContent：DSH_HOME 为空时顺手补上", async () => {
  const h = home("save-pin");
  delete process.env.DSH_HOME;
  await core.saveOverrideContent(h, USER);
  assert.equal(process.env.DSH_HOME, h);
  process.env.DSH_HOME = h;
});

// ------------------------------------------------- 点应用时的那次 commit

test("commitOverrideOnApply：用户另写的稿 → saved_user", async () => {
  const h = home("commit-user");
  const r = await core.commitOverrideOnApply(h, USER);
  assert.equal(r.action, "saved_user");
  assert.equal(r.customized, true);
  assert.equal(fs.readFileSync(overrideFile(h), "utf8"), USER);
});

test("commitOverrideOnApply：框里空、盘上已有用户稿 → kept_user_custom，不覆盖", async () => {
  const h = home("commit-keep");
  await core.saveOverrideContent(h, USER);
  const r = await core.commitOverrideOnApply(h, "");
  assert.equal(r.action, "kept_user_custom");
  assert.equal(r.reason, "user_custom");
  assert.equal(fs.readFileSync(overrideFile(h), "utf8"), USER);
});

test("commitOverrideOnApply：框里空、盘上也空 → seed_default", async () => {
  const h = home("commit-seed");
  const r = await core.commitOverrideOnApply(h, "");
  assert.equal(r.action, "seed_default");
  assert.equal(r.reason, "seed_default");
  assert.equal(core.normalizeOverride(fs.readFileSync(overrideFile(h), "utf8")), core.normalizeOverride(core.defaultOverrideText()));
});

test("commitOverrideOnApply：框里是插件默认血统 → 走 seed，不落那份旧稿", async () => {
  const h = home("commit-lineage");
  const r = await core.commitOverrideOnApply(h, OLD_DEFAULT);
  assert.notEqual(r.action, "saved_user");
  assert.equal(core.normalizeOverride(fs.readFileSync(overrideFile(h), "utf8")), core.normalizeOverride(core.defaultOverrideText()));
});

test("commitOverrideOnApply：commit 之后 commit 版本号必须变（否则注入缓存永不失效）", async () => {
  const h = home("commit-rev");
  await core.commitOverrideOnApply(h, "");
  const first = core.committedOverrideRevision();
  await core.commitOverrideOnApply(h, USER);
  assert.notEqual(core.committedOverrideRevision(), first);
});

test("commitOverrideOnApply：走 seed 分支时也要 remember（否则正文换了缓存不失效）", async () => {
  const h = home("commit-rev-seed");
  const before = core.committedOverrideRevision();
  const r = await core.commitOverrideOnApply(h, "");
  assert.equal(r.action, "seed_default");
  // saveOverrideContent 会 remember，但 seed 分支不走它；这条只钉 seed 分支自己那次 remember。
  assert.notEqual(core.committedOverrideRevision(), before);
  // peek 回来的是「落盘后读回」的正文（CRLF 已归一），与加密槽原文只差行尾，比归一化结果。
  assert.equal(
    core.normalizeOverride(core.peekCommittedOverride(h)),
    core.normalizeOverride(core.defaultOverrideText()),
  );
});

// ---------------------------------------------- 启动 seed（sync 的包装）

test("seedPromptInjectAtBoot：空 home → seed_default", () => {
  const r = core.seedPromptInjectAtBoot(home("seed-fresh"));
  assert.equal(r.action, "seed_default");
  assert.equal(r.reason, "seed_default");
  assert.equal(r.path, overrideFile(process.env.DSH_HOME));
});

test("seedPromptInjectAtBoot：再来一次 → current", () => {
  const h = home("seed-current");
  core.seedPromptInjectAtBoot(h);
  const r = core.seedPromptInjectAtBoot(h);
  assert.equal(r.action, "current");
  assert.equal(r.reason, "current");
});

test("seedPromptInjectAtBoot：盘上是用户稿 → kept_user_custom", () => {
  const h = home("seed-user");
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(overrideFile(h), USER, "utf8");
  const r = core.seedPromptInjectAtBoot(h);
  assert.equal(r.action, "kept_user_custom");
  assert.equal(r.reason, "user_custom");
  assert.equal(fs.readFileSync(overrideFile(h), "utf8"), USER);
});

test("seedPromptInjectAtBoot：盘上是『非默认但不像插件默认』的旧稿 → 也当用户稿留着", () => {
  const h = home("seed-stale");
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(overrideFile(h), "some old hand-written body\n", "utf8");
  // 现状锁定：注释说旧默认会 refresh 成当前槽，实际 isKeepableUserOverride 只认
  // 「非默认、非插件血统、非我们写的」→ 任何手写正文都算用户稿，不会被刷。
  const r = core.seedPromptInjectAtBoot(h);
  assert.equal(r.action, "kept_user_custom");
  assert.equal(fs.readFileSync(overrideFile(h), "utf8"), "some old hand-written body\n");
});

test("syncPromptInjectOnDiskSync：已经是当前槽 → keep/current", () => {
  const h = home("sync-current");
  core.seedPromptInjectAtBoot(h);
  assert.deepEqual(core.syncPromptInjectOnDiskSync(h), { action: "keep", reason: "current" });
});

test("seedPromptInjectAtBoot：refresh_default 这条映射由 source 决定（源码形状）", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "lib", "core.js"), "utf8").replace(/\r\n/g, "\n");
  // RED 演练实测：把 refresh_default 抹成 seed_default 没有任何可观察差异 ——
  // syncPromptInjectOnDiskSync 的 write 分支只会给 seed_default / refresh_default 两个 reason，
  // 而「盘上有旧内容但要刷新」在本机造不出来（任何非默认正文都被判成用户稿而 keep）。
  // 所以这条映射只能读源码钉，它守的是标签语义（状态面板上会显示这两个词）。
  assert.match(src, /action: result\.reason === "refresh_default" \? "refresh_default" : "seed_default"/);
  assert.match(src, /return \{ action: "wrote", reason: diskNorm \? "refresh_default" : "seed_default" \};/);
});

test("syncPromptInjectOnDiskSync：没有 home 时走 findDshHome，不抛", () => {
  const h = home("sync-nohome");
  // 传空串 → 内部 findDshHome() 拿 $DSH_HOME（刚建的空目录）→ 空盘，所以是 wrote。
  const r = core.syncPromptInjectOnDiskSync("");
  assert.equal(r.action, "wrote");
  assert.equal(r.reason, "seed_default");
  assert.equal(fs.existsSync(overrideFile(h)), true);
  // 再跑一次才是 keep/current。
  assert.deepEqual(core.syncPromptInjectOnDiskSync(""), { action: "keep", reason: "current" });
});

// ------------------------------------------------------------------- 编辑器

test("editOverride：文件不存在只报 needCreate，不 spawn", () => {
  const h = home("edit-missing");
  const r = core.editOverride(path.join(h, "not-here"));
  assert.equal(r.ok, false);
  assert.equal(r.needCreate, true);
  assert.equal(r.path, path.join(h, "not-here", "prompt-inject.md"));
});

test("editOverride：EDITOR 的引号段被当一个 token（带空格路径不被切碎）", () => {
  const h = home("edit-editor");
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(overrideFile(h), USER, "utf8");
  process.env.EDITOR = '"C:\\Program Files\\Some Editor\\subl.exe" --wait';
  let r;
  try {
    r = core.editOverride(h);
  } finally {
    process.env.EDITOR = ORIG_EDITOR === undefined ? "" : ORIG_EDITOR;
  }
  assert.equal(r.ok, true);
  assert.equal(r.editor, "C:\\Program Files\\Some Editor\\subl.exe");
  assert.deepEqual(r.args, ["--wait", r.path]);
  assert.equal(r.path, overrideFile(h));
  // 那个 exe 在本机不存在：spawn 会在下一个 tick 抛 ENOENT，吞掉以免污染输出。
  if (r.child && typeof r.child.on === "function") r.child.on("error", () => {});
});

test("editOverride：EDITOR 用引号段 tokenizer，不是裸 split（源码形状）", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "lib", "core.js"), "utf8").replace(/\r\n/g, "\n");
  // 判据写成「必须是 match + 三个候选段（双引号/单引号/裸串）」而不是抄整行：
  // 整行里同时有 " 与 ' ，直接内联进正则会被吃掉。
  assert.match(src, /const tokens = raw\.match\(/);
  assert.match(src, /\/g\) \|\| \[\];/);
  assert.ok(!/const tokens = raw\.split\(/.test(src), "EDITOR 不能按空白 split：带空格的路径会被切碎");
  assert.match(src, /cmd = isWindows \? "notepad" : "vi";/);
});

// --------------------------------------------------------------- 其它读数

test("overrideStatus：槽能解开时恒为 default", async () => {
  assert.equal(await core.overrideStatus(home("status-default")), "default");
});

test("overrideStatus：missing 分支在当前加密槽下不可达（源码形状）", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "lib", "core.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /export async function overrideStatus\(_dshHome\) \{\n  if \(normalizeOverride\(defaultOverrideText\(\)\)\) return "default";\n  return "missing";\n\}/);
});

test("findOverrideFile：$DSH_HOME/prompt-inject.md", () => {
  const h = home("find-file");
  assert.equal(core.findOverrideFile(h), path.join(h, "prompt-inject.md"));
});

test("readPromptInjectFileSync：不存在返回空串，存在则只做 CRLF 归一（不 trim）", () => {
  const h = home("read-inject");
  assert.equal(core.readPromptInjectFileSync(h), "");
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(overrideFile(h), "a\r\nb\r\n", "utf8");
  // 现状锁定：只 .replace(/\r\n/g,"\n")，尾部换行保留（调用方各自 normalizeOverride）。
  assert.equal(core.readPromptInjectFileSync(h), "a\nb\n");
  fs.writeFileSync(overrideFile(h), "   \r\n  ", "utf8");
  assert.equal(core.readPromptInjectFileSync(h), "");
});
