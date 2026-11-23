// 补丁幂等 / 回滚安全专项测试（task-13）。
// 所有用例只建最小宿主树（<tmp>/<tag>/dsh/node_modules/@deepseek-ai + dsh/package.json），
// 使用临时 DSH_HOME，不触碰真实用户 profile 与真实宿主安装目录。
// 覆盖：连续两次 apply 的稳定性、多文件部分命中、.bak 唯一回滚点保护、0 字节 bak、
// 只读文件 / 目录缺失 / 符号链接的失败语义、revert→apply 字节级一致、损坏 bak 的契约行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  accessSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../lib/core.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORDIS_YAML = join(REPO_ROOT, "cordis.patch.yml");
const cordisBefore = existsSync(CORDIS_YAML) ? readFileSync(CORDIS_YAML) : null;

const sandbox = mkdtempSync(join(tmpdir(), "dshpurge-idem-"));
const prevDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = join(sandbox, "dsh-home");
mkdirSync(process.env.DSH_HOME, { recursive: true });
core.resetPathMemo();

const AI_REL = join("dsh-agent-instructions", "lib", "index.js");
const BOOT_REL = join("dsh-agent-instructions", "lib", "bootstrap.js");

test.after(() => {
  if (prevDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevDshHome;
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows 只读残留不阻断测试结果 */
  }
  if (cordisBefore) {
    const now = existsSync(CORDIS_YAML) ? readFileSync(CORDIS_YAML) : null;
    if (!now || !now.equals(cordisBefore)) {
      writeFileSync(CORDIS_YAML, cordisBefore);
      assert.fail("测试改动了仓库根 cordis.patch.yml，已回滚；repairPluginCordisYaml 非幂等");
    }
  }
});

function makeTree(tag) {
  const root = join(sandbox, tag);
  const ai = join(root, "dsh", "node_modules", "@deepseek-ai");
  mkdirSync(ai, { recursive: true });
  writeFileSync(join(root, "dsh", "package.json"), JSON.stringify({ name: "dsh", version: "0.0.0-test" }) + "\n");
  return ai;
}

function seed(ai, rel, text) {
  const fp = join(ai, rel);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, text);
  return fp;
}

function readBuf(fp) {
  return readFileSync(fp);
}

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

// 真实补丁的形状：pattern 被 replace 吃掉（不再出现在产物里），markers 写进产物。
function fakePatch(id, over = {}) {
  return {
    id,
    name: "FAKE_IDEM_" + id,
    file: ["agent-instructions"],
    markers: ["[dsh-purge] idem"],
    replacements: [
      { pattern: "const answer = 40 + 2;", replace: "const answer = 42; // [dsh-purge] idem" },
    ],
    ...over,
  };
}

const P1 = fakePatch(9101);

test("连续两次 apply：第二次全 already，文件与 .bak 的字节和 mtime 都不再变化", async () => {
  const ai = makeTree("twice");
  const fp = seed(ai, AI_REL, [
    "const answer = 40 + 2;",
    "function helper(){",
    "  return 1;",
    "}",
    "",
  ].join("\n"));
  // 第二条模拟真实世界的 skipIfMarked + pattern 留在产物里的追加型补丁。
  const p2 = fakePatch(9102, {
    skipIfMarked: true,
    markers: ["[dsh-purge] idem helper"],
    replacements: [
      { pattern: "function helper(){", replace: "function helper(){ // [dsh-purge] idem helper" },
    ],
  });

  const backups1 = await core.backupAll(ai);
  assert.equal(backups1.errors.length, 0);
  const r1 = await core.applyPatches(ai, [P1, p2], {});
  assert.deepEqual(r1.map((x) => x.status), ["applied", "applied"]);

  const bak = fp + ".dshpurge.bak";
  const bytes1 = readBuf(fp);
  const mtime1 = statSync(fp).mtimeMs;
  const bakBytes1 = readBuf(bak);
  const bakMtime1 = statSync(bak).mtimeMs;
  assert.equal(countOf(bytes1.toString("utf8"), "[dsh-purge] idem"), 2);

  const backups2 = await core.backupAll(ai);
  assert.equal(backups2.made.length, 0, "第二次 backupAll 不应新建 .bak");
  // 给文件系统时间戳留出可观测差值：若第二次真的写了盘，mtime 断言会红。
  await new Promise((r) => setTimeout(r, 30));
  const r2 = await core.applyPatches(ai, [P1, p2], {});
  assert.deepEqual(r2.map((x) => x.status), ["already", "already"]);
  assert.deepEqual(readBuf(fp), bytes1, "第二次 apply 后文件字节必须不变");
  assert.equal(statSync(fp).mtimeMs, mtime1, "第二次 apply 不得改文件 mtime");
  assert.deepEqual(readBuf(bak), bakBytes1, "第二次 apply 不得改 .bak 内容");
  assert.equal(statSync(bak).mtimeMs, bakMtime1, "第二次 apply 不得改 .bak mtime");
  const baks = readdirSync(dirname(fp)).filter((n) => n.endsWith(".dshpurge.bak"));
  assert.deepEqual(baks, ["index.js.dshpurge.bak"]);
});

test("multi-file 补丁只有部分文件命中：两次 apply 状态稳定，不重复追加、不把 partial 变 ok", async () => {
  const ai = makeTree("multi");
  const fa = seed(ai, AI_REL, "const a = 1;\n");
  const fb = seed(ai, BOOT_REL, "const b = 2;\n");
  const p = fakePatch(9103, {
    file: ["agent-instructions", "agent-instructions-bootstrap"],
    markers: ["[dsh-purge] idem multi"],
    replacements: [
      { pattern: "const a = 1;", replace: "const a = 2; // [dsh-purge] idem multi" },
      { pattern: "const whole = 3;", replace: "const whole = 4; // [dsh-purge] idem multi" },
    ],
  });

  await core.backupAll(ai);
  const r1 = await core.applyPatches(ai, [p], {});
  assert.equal(r1[0].status, "drifted", "部分命中且有漂移文件时必须如实报 drifted");
  assert.equal(r1[0].applied, 1);
  assert.equal(r1[0].drifted, 1);

  const bytesA1 = readBuf(fa);
  const mtimeA1 = statSync(fa).mtimeMs;
  const bytesB1 = readBuf(fb);
  await new Promise((r) => setTimeout(r, 30));
  const r2 = await core.applyPatches(ai, [p], {});
  assert.equal(r2[0].status, "drifted", "第二次仍必须是 drifted，不能洗成 applied/already");
  assert.equal(r2[0].applied, 0);
  assert.equal(r2[0].already, 1, "已命中的文件第二次应记为 already");
  assert.equal(r2[0].drifted, 1);
  assert.deepEqual(readBuf(fa), bytesA1, "A 文件不得被重复追加");
  assert.equal(statSync(fa).mtimeMs, mtimeA1);
  assert.equal(countOf(bytesA1.toString("utf8"), "[dsh-purge] idem multi"), 1);
  assert.deepEqual(readBuf(fb), bytesB1, "B 文件没命中就必须原样不动");
});

test(".bak 已存在且与当前文件不同：backupAll/apply 都不得覆盖唯一回滚点", async () => {
  const ai = makeTree("bakkeep");
  const pristine = "PRISTINE ORIGINAL\n";
  const fp = seed(ai, AI_REL, "const answer = 42; // [dsh-purge] idem\n");
  const bak = fp + ".dshpurge.bak";
  writeFileSync(bak, pristine);
  const bakMtime = statSync(bak).mtimeMs;

  const b = await core.backupAll(ai);
  assert.equal(b.made.length, 0);
  assert.equal(readFileSync(bak, "utf8"), pristine, "已存在的 .bak 不得被覆盖");

  const r = await core.applyPatches(ai, [P1], {});
  assert.equal(r[0].status, "already");
  assert.equal(readFileSync(bak, "utf8"), pristine, "apply 也不得覆盖旧 .bak");
  assert.equal(statSync(bak).mtimeMs, bakMtime);

  const rv = await core.revertAll(ai);
  assert.ok(rv.reverted.includes(fp));
  assert.equal(readFileSync(fp, "utf8"), pristine, "revert 必须回到那个唯一回滚点");
  assert.equal(existsSync(bak), false);
});

test("0 字节 .bak 不是有效备份：apply 前会被补成真备份，revert 还原原文", async () => {
  const ai = makeTree("emptybak");
  const original = "const answer = 40 + 2;\n";
  const fp = seed(ai, AI_REL, original);
  const bak = fp + ".dshpurge.bak";
  writeFileSync(bak, "");
  assert.equal(statSync(bak).size, 0);

  const r = await core.applyPatches(ai, [P1], {});
  assert.equal(r[0].status, "applied");
  assert.ok(statSync(bak).size > 0, "apply 不得把 0 字节 bak 当有效备份");
  assert.equal(readFileSync(bak, "utf8"), original, "apply 应把 bak 修成原始内容");

  const rv = await core.revertAll(ai);
  assert.ok(rv.reverted.includes(fp));
  assert.equal(readFileSync(fp, "utf8"), original);
  assert.equal(existsSync(bak), false);
});

test("只读文件：apply 报可解释的 write_error，原文件不变且不留临时文件", async (t) => {
  const ai = makeTree("readonly");
  const original = "const answer = 40 + 2;\n";
  const fp = seed(ai, AI_REL, original);
  chmodSync(fp, 0o444);
  try {
    try {
      accessSync(fp, fsConstants.W_OK);
      t.skip("当前账号对 chmod 444 文件仍可写，无法制造只读场景");
      return;
    } catch {
      /* 预期：不可写 */
    }
    await core.backupAll(ai);
    const r1 = await core.applyPatches(ai, [P1], {});
    assert.ok(r1[0].status.startsWith("write_error:"), "失败必须带 write_error 前缀，实得 " + r1[0].status);
    assert.equal(readFileSync(fp, "utf8"), original, "写失败不得留下半改内容");
    const leftovers = readdirSync(dirname(fp)).filter((n) => n.includes(".tmp") || n.includes(".copytmp"));
    assert.deepEqual(leftovers, [], "写失败不得留下临时文件");
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await core.applyPatches(ai, [P1], {});
    assert.ok(r2[0].status.startsWith("write_error:"), "第二次仍应如实报 write_error，不能洗成 already");
    assert.equal(readFileSync(fp, "utf8"), original);
  } finally {
    chmodSync(fp, 0o666);
  }
});

test("符号链接目标：apply 写穿真身且保留链接，revert 后链接与真身都复原", async (t) => {
  const ai = makeTree("symlink");
  const original = "const answer = 40 + 2;\n";
  const real = join(sandbox, "symlink-real", "index.js");
  mkdirSync(dirname(real), { recursive: true });
  writeFileSync(real, original);
  const fp = join(ai, AI_REL);
  mkdirSync(dirname(fp), { recursive: true });
  try {
    symlinkSync(real, fp, "file");
  } catch {
    t.skip("当前环境无法创建符号链接");
    return;
  }
  const bak = fp + ".dshpurge.bak";

  await core.backupAll(ai);
  const r = await core.applyPatches(ai, [P1], {});
  assert.equal(r[0].status, "applied");
  assert.equal(lstatSync(fp).isSymbolicLink(), true, "apply 不得把符号链接替换成普通文件");
  assert.match(readFileSync(real, "utf8"), /\[dsh-purge\] idem/);
  assert.equal(readFileSync(bak, "utf8"), original);

  const rv = await core.revertAll(ai);
  assert.ok(rv.reverted.includes(fp));
  assert.equal(lstatSync(fp).isSymbolicLink(), true, "revert 后链接仍必须是链接");
  assert.equal(readFileSync(real, "utf8"), original);
  assert.equal(existsSync(bak), false);
});

test("悬空符号链接：apply 不替换链接、不产生半改文件，状态可解释", async (t) => {
  const ai = makeTree("dangling");
  const fp = join(ai, AI_REL);
  mkdirSync(dirname(fp), { recursive: true });
  try {
    symlinkSync(join(sandbox, "no-such-target", "index.js"), fp, "file");
  } catch {
    t.skip("当前环境无法创建符号链接");
    return;
  }
  const r = await core.applyPatches(ai, [P1], {});
  assert.ok(
    r[0].status === "missing_file" || r[0].status.startsWith("write_error:"),
    "悬空链接必须被解释为 missing_file/write_error，实得 " + r[0].status,
  );
  assert.equal(lstatSync(fp).isSymbolicLink(), true, "悬空链接本身必须保留");
  const leftovers = readdirSync(dirname(fp)).filter((n) => n.includes(".tmp") || n.includes(".copytmp"));
  assert.deepEqual(leftovers, []);
});

test("目标目录缺失（web-app）：只报 missing，不创建目录/文件，重复 apply 状态不变", async () => {
  const ai = makeTree("missingdir");
  const fp = seed(ai, AI_REL, "const answer = 40 + 2;\n");
  const p = fakePatch(9104, {
    file: ["agent-instructions", "web-app"],
    markers: ["[dsh-purge] idem web"],
    replacements: [{ pattern: "const answer = 40 + 2;", replace: "const answer = 42; // [dsh-purge] idem web" }],
  });
  const webPath = join(ai, "dsh-web-app", "cordis.patch.yml");

  const r1 = await core.applyPatches(ai, [p], {});
  assert.equal(r1[0].status, "applied");
  assert.equal(r1[0].applied, 1);
  assert.equal(r1[0].missing, 1);
  assert.equal(existsSync(join(ai, "dsh-web-app")), false, "不得为缺失目标创建目录");
  assert.equal(existsSync(webPath), false);

  const r2 = await core.applyPatches(ai, [p], {});
  assert.equal(r2[0].status, "already");
  assert.equal(r2[0].missing, 1);
  assert.equal(existsSync(join(ai, "dsh-web-app")), false, "第二次也不得创建目录");
  assert.match(readFileSync(fp, "utf8"), /\[dsh-purge\] idem web/);
});

test("revert 后再次 apply：CRLF 原文字节级复原，重打结果与第一次完全一致", async () => {
  const ai = makeTree("crlf");
  const original = "const answer = 40 + 2;\r\nconst tail = true;\r\n";
  const fp = seed(ai, AI_REL, original);
  const origBuf = Buffer.from(original);

  await core.backupAll(ai);
  await core.applyPatches(ai, [P1], {});
  const patched1 = readBuf(fp);
  assert.ok(patched1.includes(Buffer.from("\r\n")), "CRLF 必须保留");
  assert.equal(patched1.toString("utf8").replace(/\r\n/g, "").includes("\n"), false, "不得混入裸 LF");

  const rv = await core.revertAll(ai);
  assert.ok(rv.reverted.includes(fp));
  assert.deepEqual(readBuf(fp), origBuf, "revert 必须字节级等于原文");

  await core.backupAll(ai);
  const r2 = await core.applyPatches(ai, [P1], {});
  assert.equal(r2[0].status, "applied");
  assert.deepEqual(readBuf(fp), patched1, "revert 后重打必须与第一次结果字节级一致");
});

test("损坏的 .bak：垃圾字节按字节还原；目录 .bak 报 empty_backup 且目标不变", async (t) => {
  const ai = makeTree("badbak");
  const fp = seed(ai, AI_REL, "const answer = 42; // [dsh-purge] idem\n");
  const bak = fp + ".dshpurge.bak";
  const garbage = Buffer.from([0x00, 0xff, 0x10, 0x0a]);
  writeFileSync(bak, garbage);
  const rv = await core.revertAll(ai);
  assert.ok(rv.reverted.includes(fp));
  assert.deepEqual(readBuf(fp), garbage, "revert 契约是按字节还原，不校验 bak 内容");
  assert.equal(existsSync(bak), false);
  const rvAgain = await core.revertAll(ai);
  assert.deepEqual(rvAgain.skipped, [fp], "缺 .bak 时只跳过，绝不删除现存文件");
  assert.deepEqual(readBuf(fp), garbage, "缺 .bak 的 revert 不得改动文件");

  if (process.platform !== "win32") {
    t.diagnostic("目录 .bak 的 stat.size 在非 Windows 上非 0，跳过该分支");
    return;
  }
  const ai2 = makeTree("dirbak");
  const fp2 = seed(ai2, AI_REL, "const answer = 42; // [dsh-purge] idem\n");
  const before = readBuf(fp2);
  mkdirSync(fp2 + ".dshpurge.bak");
  const rv2 = await core.revertAll(ai2);
  assert.deepEqual(rv2.errors, [[fp2, "empty_backup"]], "目录 .bak 必须按空备份如实报错");
  assert.deepEqual(readBuf(fp2), before, "报错时目标文件必须原样不动");
  assert.equal(existsSync(fp2 + ".dshpurge.bak.bad"), true, "坏备份应改名留痕");
});
