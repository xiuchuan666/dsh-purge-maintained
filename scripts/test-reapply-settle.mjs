/**
 * lib/reapply.js 是「启动时要不要重打补丁」的判据集合。
 *
 * 它坏掉的表现有两种，都很难自己发现：
 *   1. 判成「已对齐」→ 宿主升级后补丁其实没了，面板一直显示已清洗，实际没生效；
 *   2. 判成「未对齐」→ 每次启动都 revert + apply + 重启，打成死循环（#59 / #60 就是这么来的）。
 *
 * 这些判据全靠 `$DSH_HOME` 下的几个小文件（applied.json / installed-rev / settle-restart.guard）
 * 和宿主上的清洗标记，所以测试用临时 home + 临时 aiBase，不去碰真实宿主。
 *
 * 不测 `reapplyInstalled` 本身：它一路调到 patchAllShims / silenceCmdFlash，
 * 会去改本机 npm 全局的 shim，跑一次就把开发机弄脏了。这条写进 docs/test-map.md 第十节。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as core from "../lib/core.js";
import {
  canHealEmptyStamp,
  ensureInstalledRevSeed,
  healEmptyAppliedStamp,
  hostCleanEnoughToKeep,
  hostPatchesStillPending,
  hostStillHasAppliedPatches,
  markPatchesApplied,
  markSettleRestart,
  patchesLostAfterHostReset,
  patchesMatchInstall,
  patchesMatchInstallStrict,
  readAppliedStamp,
  resolveApplySha,
  shouldSkipSettleRestart,
  stampMatches,
} from "../lib/reapply.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-reapply-"));
test.after(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发 EPERM，临时目录留给系统清 */
  }
});

let seq = 0;

/** 每例一套独立的 home / aiBase，避免 applied.json 之类的状态互相污染。 */
function fresh() {
  seq += 1;
  const home = path.join(sandbox, `home-${seq}`);
  const ai = path.join(sandbox, `ai-${seq}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(ai, "dsh-agent-instructions", "lib"), { recursive: true });
  fs.writeFileSync(path.join(ai, "dsh-agent-instructions", "lib", "index.js"), "module.exports = {}\n");
  process.env.DSH_HOME = home;
  process.env.DSH_BASE = ai;
  process.env.DSH_SURFACE = "web";
  core.clearDesktopLocateCache();
  return { home, ai };
}

function statePath(home, name) {
  return path.join(home, "dsh-purge", name);
}

function writeState(home, name, text) {
  const fp = statePath(home, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text);
  return fp;
}

function writeStamp(home, obj) {
  return writeState(home, "applied.json", JSON.stringify(obj));
}

/** 让 hostCleanMarkersPresent(ai) 为 true：两个标记都写上。 */
function markHostClean(ai) {
  const fp = path.join(ai, "dsh-system-prompt", "lib", "index.js");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(
    fp,
    [
      "// [dsh-purge] identity stripped",
      "// [dsh-purge] complete prompt keeps waterfall inject",
      "export function assemble() {}",
      "",
    ].join("\n"),
  );
}

/** 上游原样文件：含身份句 → 视为「还没清洗」。 */
function writeUpstreamPrompt(ai) {
  const fp = path.join(ai, "dsh-system-prompt", "lib", "index.js");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(
    fp,
    [
      "// system-prompt/assemble",
      'const identity = "You are an AI agent powered by DeepSeek Harness.";',
      "",
    ].join("\n"),
  );
}

test.beforeEach(() => {
  fresh();
});

test.afterEach(() => {
  core.clearDesktopLocateCache();
});

// ---------------------------------------------------------------------------
// stampMatches：戳、版本、rev 三者对不对齐
// ---------------------------------------------------------------------------

test("stampMatches：没有戳、版本不同、sha 为空都算没对齐", () => {
  assert.equal(stampMatches(null, VERSION, ""), false);
  assert.equal(stampMatches(undefined, VERSION, ""), false);
  assert.equal(stampMatches({ version: "0.0.1", sha: "abc" }, VERSION, ""), false);
  // #56：空 sha 曾让 settle 永远判未对齐，不能算对上
  assert.equal(stampMatches({ version: VERSION, sha: "" }, VERSION, ""), false);
});

test("stampMatches：rev 为空时只认版本与 sha，不必等 git rev", () => {
  assert.equal(stampMatches({ version: VERSION, sha: "abcdef1" }, VERSION, ""), true);
});

test("stampMatches：rev 与 sha 互为前缀都算同一个提交", () => {
  assert.equal(stampMatches({ version: VERSION, sha: "abcdef1234" }, VERSION, "abcdef"), true);
  assert.equal(stampMatches({ version: VERSION, sha: "abcdef" }, VERSION, "abcdef1234"), true);
  assert.equal(stampMatches({ version: VERSION, sha: "abcdef" }, VERSION, "abcdef"), true);
});

test("stampMatches：rev 与 sha 不同提交时不算对齐", () => {
  assert.equal(stampMatches({ version: VERSION, sha: "abcdef" }, VERSION, "123456"), false);
});

test("stampMatches：任意一侧是 apply: 占位戳时只认版本（避免空转重启）", () => {
  assert.equal(stampMatches({ version: VERSION, sha: `apply:${VERSION}` }, VERSION, "deadbeef"), true);
  assert.equal(stampMatches({ version: VERSION, sha: "deadbeef" }, VERSION, "applied"), true);
  assert.equal(stampMatches({ version: VERSION, sha: "deadbeef" }, VERSION, `apply:${VERSION}`), true);
});

// ---------------------------------------------------------------------------
// canHealEmptyStamp：什么情况下允许把空 sha 就地补成非空
// ---------------------------------------------------------------------------

test("canHealEmptyStamp：密封包一律不补，缺标记也不补", () => {
  assert.equal(canHealEmptyStamp({ sealed: true }), false);
  assert.equal(canHealEmptyStamp({ sealed: true, hasAiBase: true, markersPresent: true }), false);
  assert.equal(canHealEmptyStamp({ hasAiBase: true, markersPresent: false }), false);
});

test("canHealEmptyStamp：有标记、或根本找不到宿主时才允许补", () => {
  assert.equal(canHealEmptyStamp({ hasAiBase: true, markersPresent: true }), true);
  assert.equal(canHealEmptyStamp({}), true);
  assert.equal(canHealEmptyStamp(), true);
});

// ---------------------------------------------------------------------------
// resolveApplySha / ensureInstalledRevSeed：rev 从哪来
// ---------------------------------------------------------------------------

test("resolveApplySha：显式值原样用，旧版本占位戳刷成当前版本", () => {
  fresh();
  assert.equal(resolveApplySha("abc123"), "abc123");
  assert.equal(resolveApplySha(`apply:0.0.1`), `apply:${VERSION}`);
  assert.equal(resolveApplySha(`apply:${VERSION}`), `apply:${VERSION}`);
  assert.equal(resolveApplySha("  abc123  "), "abc123");
});

test("resolveApplySha：没有显式值也没有 rev 时落 apply:<version> 占位", () => {
  fresh();
  assert.equal(resolveApplySha(), `apply:${VERSION}`);
  assert.equal(resolveApplySha(null), `apply:${VERSION}`);
  assert.equal(resolveApplySha(""), `apply:${VERSION}`);
});

test("resolveApplySha：已有 installed-rev 时用它，占位戳旧了要刷", () => {
  const { home } = fresh();
  writeState(home, "installed-rev", "feedface\n");
  assert.equal(resolveApplySha(), "feedface");
  writeState(home, "installed-rev", "apply:0.0.1\n");
  assert.equal(resolveApplySha(), `apply:${VERSION}`);
});

test("readAppliedStamp：缺文件、坏 JSON 都返回 null，字段一律转字符串", () => {
  const { home } = fresh();
  assert.equal(readAppliedStamp(), null);
  writeStamp(home, null);
  fs.writeFileSync(statePath(home, "applied.json"), "{not json");
  assert.equal(readAppliedStamp(), null);
  writeStamp(home, { version: 123, sha: 456 });
  assert.deepEqual(readAppliedStamp(), { version: "123", sha: "456" });
  writeStamp(home, {});
  assert.deepEqual(readAppliedStamp(), { version: "", sha: "" });
});

test("markPatchesApplied：没有 rev 时落占位戳，同时写 applied.json", () => {
  const { home } = fresh();
  const sha = markPatchesApplied();
  assert.equal(sha, `apply:${VERSION}`);
  assert.equal(fs.readFileSync(statePath(home, "installed-rev"), "utf8").trim(), `apply:${VERSION}`);
  const stamp = readAppliedStamp();
  assert.equal(stamp.version, VERSION);
  assert.equal(stamp.sha, `apply:${VERSION}`);
});

test("markPatchesApplied：已有 git rev 时沿用 rev，不把占位戳盖上去", () => {
  const { home } = fresh();
  writeState(home, "installed-rev", "cafebabe\n");
  assert.equal(markPatchesApplied("ignored"), "cafebabe");
  assert.equal(readAppliedStamp().sha, "cafebabe");
  assert.equal(fs.readFileSync(statePath(home, "installed-rev"), "utf8").trim(), "cafebabe");
});

test("markPatchesApplied：已有占位 rev 时改用本次解析出来的值", () => {
  const { home } = fresh();
  writeState(home, "installed-rev", "apply:0.0.1\n");
  assert.equal(markPatchesApplied("realrev"), "realrev");
  assert.equal(readAppliedStamp().sha, "realrev");
});

test("ensureInstalledRevSeed：三种来源依次尝试，落盘后可重复调用", () => {
  const { home } = fresh();
  assert.equal(ensureInstalledRevSeed(), `apply:${VERSION}`);
  assert.equal(ensureInstalledRevSeed(), `apply:${VERSION}`);
  assert.equal(fs.readFileSync(statePath(home, "installed-rev"), "utf8").trim(), `apply:${VERSION}`);
});

test("ensureInstalledRevSeed：缺 rev 但有带 sha 的戳时沿用戳里的 sha", () => {
  const { home } = fresh();
  writeStamp(home, { version: VERSION, sha: "abc1234" });
  assert.equal(ensureInstalledRevSeed(), "abc1234");
  assert.equal(fs.readFileSync(statePath(home, "installed-rev"), "utf8").trim(), "abc1234");
});

test("ensureInstalledRevSeed：占位 rev 旧了要刷成当前版本", () => {
  const { home } = fresh();
  writeState(home, "installed-rev", "apply:0.0.1\n");
  assert.equal(ensureInstalledRevSeed(), `apply:${VERSION}`);
});

// ---------------------------------------------------------------------------
// healEmptyAppliedStamp：把「版本对但 sha 空」的旧戳修好
// ---------------------------------------------------------------------------

test("healEmptyAppliedStamp：没有戳、或版本对不上时什么都不做", () => {
  const { home } = fresh();
  assert.equal(healEmptyAppliedStamp(), false);
  writeStamp(home, { version: "0.0.1", sha: "" });
  assert.equal(healEmptyAppliedStamp(), false);
  assert.equal(fs.existsSync(statePath(home, "installed-rev")), false);
});

test("healEmptyAppliedStamp：戳里有 sha 但缺 rev 时补 rev，并报「没补戳」", () => {
  const { home } = fresh();
  writeStamp(home, { version: VERSION, sha: "abc1234" });
  assert.equal(healEmptyAppliedStamp(), false);
  assert.equal(fs.readFileSync(statePath(home, "installed-rev"), "utf8").trim(), "abc1234");
  assert.equal(readAppliedStamp().sha, "abc1234");
});

test("healEmptyAppliedStamp：戳和 rev 都齐时不动", () => {
  const { home } = fresh();
  writeStamp(home, { version: VERSION, sha: "abc1234" });
  writeState(home, "installed-rev", "abc1234\n");
  assert.equal(healEmptyAppliedStamp(), false);
  assert.equal(fs.readFileSync(statePath(home, "installed-rev"), "utf8").trim(), "abc1234");
});

test("healEmptyAppliedStamp：空 sha 且宿主已清洗 → 补戳，返回 true", () => {
  const { home, ai } = fresh();
  markHostClean(ai);
  writeStamp(home, { version: VERSION, sha: "" });
  assert.equal(healEmptyAppliedStamp(), true);
  const stamp = readAppliedStamp();
  assert.equal(stamp.version, VERSION);
  assert.notEqual(stamp.sha, "");
});

test("healEmptyAppliedStamp：空 sha 但宿主没清洗 → 不补戳（#57 自愈不能被打断）", () => {
  const { home, ai } = fresh();
  writeUpstreamPrompt(ai);
  writeStamp(home, { version: VERSION, sha: "" });
  assert.equal(healEmptyAppliedStamp(), false);
  assert.equal(readAppliedStamp().sha, "");
});

test("healEmptyAppliedStamp：空 sha 且宿主文件缺失（等于没标记）→ 不补戳", () => {
  const { home } = fresh();
  writeStamp(home, { version: VERSION, sha: "" });
  // fresh() 只造了 dsh-agent-instructions，没有 dsh-system-prompt/lib/index.js：
  // hostCleanMarkersPresent 读不到文件即 false，等同于「没清洗」。
  assert.equal(healEmptyAppliedStamp(), false);
  assert.equal(readAppliedStamp().sha, "");
});

// ---------------------------------------------------------------------------
// settle 冷却：防止「重打→重启→再重打」死循环
// ---------------------------------------------------------------------------

test("shouldSkipSettleRestart：没写过守卫文件时不冷却", () => {
  fresh();
  assert.equal(shouldSkipSettleRestart(), false);
});

test("shouldSkipSettleRestart：刚标记过就冷却，窗口给 0 时不冷却", () => {
  fresh();
  markSettleRestart();
  assert.equal(shouldSkipSettleRestart(), true);
  // 窗口 0 表示「不设冷却」：`Date.now() - at < 0` 恒假。
  // 注意不能拿 1ms 试：同一毫秒内 elapsed 为 0，`0 < 1` 仍然成立，会误以为冷却失效。
  assert.equal(shouldSkipSettleRestart(0), false);
});

test("shouldSkipSettleRestart：守卫文件版本不同（升级过）时不算冷却", () => {
  const { home } = fresh();
  writeState(home, "settle-restart.guard", JSON.stringify({ version: "0.0.1", at: new Date().toISOString() }));
  assert.equal(shouldSkipSettleRestart(), false);
});

test("shouldSkipSettleRestart：时间戳坏掉时按「不冷却」处理", () => {
  const { home } = fresh();
  writeState(home, "settle-restart.guard", JSON.stringify({ version: VERSION, at: "not a date" }));
  assert.equal(shouldSkipSettleRestart(), false);
  writeState(home, "settle-restart.guard", "{broken");
  assert.equal(shouldSkipSettleRestart(), false);
});

// ---------------------------------------------------------------------------
// 宿主标记与 pending 实检
// ---------------------------------------------------------------------------

test("hostStillHasAppliedPatches：宿主文件缺失时算没打上（不是「还在」）", () => {
  fresh();
  // fresh() 没有 dsh-system-prompt/lib/index.js，hostCleanMarkersPresent 读不到即 false。
  //
  // 注意这里测不到「findAiBase() 返回空 → 当作还在」那条分支：本机装了 DSH，
  // 就算把 DSH_BASE 指到不存在的目录，findAiBaseWeb() 也会回落到 npm 全局根。
  // 那条分支只在「根本没装宿主」的机器上走，CI 上不可复现，故留作已知未覆盖分支。
  assert.equal(hostStillHasAppliedPatches(), false);
});

test("hostStillHasAppliedPatches：有清洗标记为 true，上游原文为 false", () => {
  const { ai } = fresh();
  markHostClean(ai);
  assert.equal(hostStillHasAppliedPatches(), true);
  writeUpstreamPrompt(ai);
  assert.equal(hostStillHasAppliedPatches(), false);
});

test("hostStillHasAppliedPatches：宿主文件整个不在时算没打上", () => {
  fresh();
  assert.equal(hostStillHasAppliedPatches(), false);
});

test("hostPatchesStillPending：空宿主目录里没有 pending（全是 no-file）", async () => {
  fresh();
  assert.equal(await hostPatchesStillPending(), false);
});

test("hostPatchesStillPending：宿主文件是垃圾内容时也不抛，按「没有 pending」处理", async () => {
  const { ai } = fresh();
  const fp = path.join(ai, "dsh-system-prompt", "lib", "index.js");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, "\u0000\u0001 not javascript at all");
  assert.equal(await hostPatchesStillPending(), false);
});

test("patchesMatchInstall：戳、rev、清洗标记三者齐了才算对齐", () => {
  const { home, ai } = fresh();
  writeState(home, "installed-rev", "abc1234\n");
  writeStamp(home, { version: VERSION, sha: "abc1234" });
  assert.equal(patchesMatchInstall(), false, "标记没写，不算对齐");
  markHostClean(ai);
  assert.equal(patchesMatchInstall(), true);
});

test("patchesMatchInstallStrict：快路径不过就 false，过了再查 pending", async () => {
  const { home, ai } = fresh();
  assert.equal(await patchesMatchInstallStrict(), false);
  writeState(home, "installed-rev", "abc1234\n");
  writeStamp(home, { version: VERSION, sha: "abc1234" });
  markHostClean(ai);
  assert.equal(await patchesMatchInstallStrict(), true);
});

test("patchesLostAfterHostReset：没有戳就不算丢失，有戳但标记没了才算", () => {
  const { home, ai } = fresh();
  assert.equal(patchesLostAfterHostReset(), false);
  writeStamp(home, { version: VERSION, sha: "" });
  assert.equal(patchesLostAfterHostReset(), false, "空 sha 的戳不算「应用过」");
  writeStamp(home, { version: VERSION, sha: "abc1234" });
  assert.equal(patchesLostAfterHostReset(), true);
  markHostClean(ai);
  assert.equal(patchesLostAfterHostReset(), false);
});

test("hostCleanEnoughToKeep：没有标记为 false，有标记且无 pending 为 true", async () => {
  const { ai } = fresh();
  assert.equal(await hostCleanEnoughToKeep(), false, "没有标记时不算「够干净」");
  markHostClean(ai);
  assert.equal(await hostCleanEnoughToKeep(), true);
});
