import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecipheriv } from "node:crypto";
import { inflateSync } from "node:zlib";
import { atomicWriteFileSync } from "../lib/redteam/atomic-write.js";
import { PHASE1_KEEP_EXPR, widenPhase1KeepFilter } from "../lib/phase1-keep.js";
import { mixKey, sealSlot } from "../lib/table-key.js";
import { openSlot } from "../lib/table-read.js";
import {
  DESKTOP_SETTLE_DELAY_MS,
  applyShouldRestart,
  isInactiveContextError,
  settleDelayMs,
  settleMayReapply,
  settleMayRestart,
  watchContextLife,
} from "../lib/settle-policy.js";

/*
 * 这一批是「小到容易被当成不用测」的纯函数，但每一个坏掉都是静默的：
 *
 * - `atomicWriteFileSync` 坏掉 → 写到一半崩溃留下半截 JSON，读侧把解析错吞成默认值，
 *   用户的设置无声消失（这正是它存在的原因：它替换掉了 writeFileSync）。
 * - `widenPhase1KeepFilter` 坏掉 → 宿主 phase-1 白名单没放宽，注入段在最后一步被丢掉，
 *   提示词里少一段，但面板显示「已清洗」。
 * - `mixKey` / `sealSlot` 坏掉 → 加密槽解不开，`openSlot()` 静默返回空串。
 * - `settleMayRestart` / `applyShouldRestart` 坏掉 → 桌面端启动自愈触发 restart，
 *   Cordis 抛 INACTIVE_EFFECT；或者点「应用」后该重启却不重启。
 *
 * 一处**测不到**的性质：`atomicWriteFileSync` 里那次 `fsyncSync` 是耐久性保证，进程内无法
 * 观测（RED 演练里把它改成空操作，31 条用例全绿）。它防的是「rename 成功了但断电后文件是空的」，
 * 只能靠人工读代码守住 —— 写在这里，免得下次以为已经测过了。
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-small-"));
test.after(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发 EPERM，测试结果不受影响 */
  }
});

const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));

/* ---------------- atomic-write ---------------- */

test("atomicWriteFileSync：写入新文件，且不留下临时文件", () => {
  const fp = path.join(sandbox, "fresh.json");
  atomicWriteFileSync(fp, '{"a":1}');
  assert.equal(fs.readFileSync(fp, "utf8"), '{"a":1}');
  assert.deepEqual(tmpLeftovers(sandbox), []);
});

test("atomicWriteFileSync：覆盖已有文件时整份替换，不追加", () => {
  const fp = path.join(sandbox, "over.json");
  fs.writeFileSync(fp, "a-much-longer-original-payload");
  atomicWriteFileSync(fp, "short");
  assert.equal(fs.readFileSync(fp, "utf8"), "short");
});

test("atomicWriteFileSync：目标目录不存在时抛 ENOENT，且不留下临时文件", () => {
  const before = tmpLeftovers(sandbox);
  assert.throws(() => atomicWriteFileSync(path.join(sandbox, "nope", "b.json"), "x"), {
    code: "ENOENT",
  });
  assert.deepEqual(tmpLeftovers(sandbox), before, "失败路径也要清理自己建的临时文件");
});

test("atomicWriteFileSync：rename 失败时原目标不被破坏、临时文件被清掉", () => {
  // 目标是目录 → openSync(tmp) 成功、write 成功、renameSync 失败。这正是「写到一半崩了」
  // 之后最该保证的性质：原目标还在，垃圾被收走。
  const dirAsTarget = path.join(sandbox, "as-dir");
  fs.mkdirSync(dirAsTarget, { recursive: true });
  const before = tmpLeftovers(sandbox);
  assert.throws(() => atomicWriteFileSync(dirAsTarget, "payload"));
  assert.equal(fs.statSync(dirAsTarget).isDirectory(), true, "原目标不能被 rename 掉");
  assert.deepEqual(tmpLeftovers(sandbox), before);
});

test("atomicWriteFileSync：写入阶段就失败时，已经建出来的临时文件也要收走", () => {
  // 目标目录存在、临时文件能建、但 writeSync 抛（Symbol 不能写进 fd）。
  // 这条专门盯「写入失败的清理」：如果只清理 rename 失败那一支，这里会留下垃圾。
  const fp = path.join(sandbox, "write-fails.txt");
  const before = tmpLeftovers(sandbox);
  assert.throws(() => atomicWriteFileSync(fp, Symbol("nope")));
  assert.deepEqual(tmpLeftovers(sandbox), before, "写入失败也要删掉自己建的临时文件");
  assert.equal(fs.existsSync(fp), false, "失败时不能留下半个目标文件");
});

test("atomicWriteFileSync：替换是 rename，不是就地覆盖（inode 必须换）", () => {
  // 这是「原子」二字的可观测含义：读侧要么看到完整旧内容、要么看到完整新内容。
  // 就地覆盖时 inode 不变，正在读的一方会读到半截。
  const fp = path.join(sandbox, "ino.txt");
  fs.writeFileSync(fp, "old");
  const before = fs.statSync(fp).ino;
  atomicWriteFileSync(fp, "new-content");
  const after = fs.statSync(fp).ino;
  assert.notEqual(after, before, "必须换 inode（rename 语义），不能就地 truncate + write");
  assert.equal(fs.readFileSync(fp, "utf8"), "new-content");
});

test("atomicWriteFileSync：写入内容按字节原样落盘（含 CRLF 与多字节字符）", () => {
  const fp = path.join(sandbox, "bytes.txt");
  const payload = "第一行\r\n第二行 ✓\n第三行";
  atomicWriteFileSync(fp, payload);
  assert.equal(fs.readFileSync(fp, "utf8"), payload);
});

/* ---------------- phase1-keep ---------------- */

const SHAPE_PURGE_ONLY =
  'const keep = (section) => PERSONA_SECTION_NAMES.has(section?.name) || String(section?.name || "").startsWith("dsh-purge");\n';
const SHAPE_BARE = "const keep = section => PERSONA_SECTION_NAMES.has(section?.name);\n";

test("widenPhase1KeepFilter：把只放行 dsh-purge 的旧形状放宽到 dshpg-", () => {
  const out = widenPhase1KeepFilter(SHAPE_PURGE_ONLY);
  assert.ok(out.includes(PHASE1_KEEP_EXPR), "整段换成 PHASE1_KEEP_EXPR");
  assert.ok(out.includes('startsWith("dshpg-")'));
  assert.ok(out.includes('startsWith("dsh-purge")'), "原有的 dsh-purge 放行不能丢");
});

test("widenPhase1KeepFilter：幂等，第二遍不再改动", () => {
  const once = widenPhase1KeepFilter(SHAPE_PURGE_ONLY);
  assert.equal(widenPhase1KeepFilter(once), once);
});

test("widenPhase1KeepFilter：裸 `section =>` 形状也能放宽", () => {
  const out = widenPhase1KeepFilter(SHAPE_BARE);
  assert.equal(out, `const keep = section => ${PHASE1_KEEP_EXPR};\n`);
});

test("widenPhase1KeepFilter：CRLF 输入保持 CRLF", () => {
  const out = widenPhase1KeepFilter(SHAPE_PURGE_ONLY.replace(/\n/g, "\r\n"));
  assert.ok(out.includes("\r\n"));
  assert.equal(out.split("\n").filter((line) => line.endsWith("\r") === false).length, 1, "只有末尾空串没有 \\r");
});

test("widenPhase1KeepFilter：空值、无匹配的文本原样返回", () => {
  assert.equal(widenPhase1KeepFilter(""), "");
  assert.equal(widenPhase1KeepFilter(null), "");
  assert.equal(widenPhase1KeepFilter(undefined), "");
  const unrelated = "const x = 1;\n";
  assert.equal(widenPhase1KeepFilter(unrelated), unrelated);
});

test("PHASE1_KEEP_EXPR：三个分支一个都不能少（漏一个就有注入段被丢）", () => {
  assert.equal(
    PHASE1_KEEP_EXPR,
    'PERSONA_SECTION_NAMES.has(section?.name) || String(section?.name || "").startsWith("dsh-purge") || String(section?.name || "").startsWith("dshpg-")',
  );
});

/* ---------------- table-key / table-read ---------------- */

const openWith = (sealed) => {
  const decipher = createDecipheriv("aes-256-gcm", mixKey(sealed.MASK), Buffer.from(sealed.IV, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.TAG, "base64"));
  return inflateSync(
    Buffer.concat([decipher.update(Buffer.from(sealed.SLOT, "base64")), decipher.final()]),
  ).toString("utf8");
};

test("mixKey：32 字节、同输入稳定、换输入就变", () => {
  const a = mixKey("mask-1");
  assert.equal(a.length, 32, "AES-256 要 32 字节");
  assert.ok(mixKey("mask-1").equals(a));
  assert.equal(mixKey("mask-2").equals(a), false);
  assert.equal(mixKey().length, 32, "不传参也要给足长度");
});

test("sealSlot：四段齐全、长度符合算法参数", () => {
  const sealed = sealSlot("payload");
  assert.deepEqual(Object.keys(sealed).sort(), ["IV", "MASK", "SLOT", "TAG"]);
  assert.equal(Buffer.from(sealed.MASK, "base64").length, 16, "mask 是 16 字节随机串");
  assert.equal(Buffer.from(sealed.IV, "base64").length, 12, "GCM 推荐 12 字节 IV");
  assert.equal(Buffer.from(sealed.TAG, "base64").length, 16, "GCM tag 16 字节");
  assert.ok(sealed.SLOT.length > 0);
});

test("sealSlot：同一个明文两次封出来不一样（每次新 mask + IV）", () => {
  const a = sealSlot("same");
  const b = sealSlot("same");
  assert.notEqual(a.SLOT, b.SLOT);
  assert.notEqual(a.MASK, b.MASK);
  assert.notEqual(a.IV, b.IV);
});

test("sealSlot → 解回：往返一致（含中文与多字节）", () => {
  const text = "验证槽内容 with unicode ✓\n第二行";
  assert.equal(openWith(sealSlot(text)), text);
});

test("sealSlot：null / undefined 封成空串并能解回空串", () => {
  assert.equal(openWith(sealSlot(null)), "");
  assert.equal(openWith(sealSlot(undefined)), "");
});

test("sealSlot：TAG 被篡改时解密抛错，不会静默给出错误内容", () => {
  const sealed = sealSlot("x");
  const decipher = createDecipheriv("aes-256-gcm", mixKey(sealed.MASK), Buffer.from(sealed.IV, "base64"));
  decipher.setAuthTag(Buffer.from(sealSlot("y").TAG, "base64"));
  assert.throws(() =>
    Buffer.concat([decipher.update(Buffer.from(sealed.SLOT, "base64")), decipher.final()]),
  );
});

test("openSlot：内嵌的表能解开，且内容不是空串", () => {
  const text = openSlot();
  assert.equal(typeof text, "string");
  assert.ok(text.length > 1000, `解出来的正文太短（${text.length}），表或密钥坏了`);
});

test("openSlot：解不开时返回空串而不是抛错（面板不该因为一张表崩）", () => {
  // 仓库内嵌的表是好的，所以 catch 那一支在测试里走不到 —— 它只在 asset-table.js
  // 被换坏/密钥不匹配时生效。既然造不出这种状态，就钉源码形状：catch 必须 return ""。
  // 不钉的话，某次重构把 catch 改成 throw，面板会在打开时直接崩，而所有测试全绿。
  const src = fs.readFileSync(new URL("../lib/table-read.js", import.meta.url), "utf8");
  assert.match(src, /\} catch \{\s*return "";\s*\}/, "openSlot 的 catch 必须吞掉异常并返回空串");
  assert.doesNotThrow(() => openSlot());
});

/* ---------------- settle-policy ---------------- */

test("isInactiveContextError：认 code，也认 message 里的 inactive context", () => {
  assert.equal(isInactiveContextError({ code: "INACTIVE_EFFECT" }), true);
  assert.equal(isInactiveContextError(new Error("Inactive context detected")), true);
  assert.equal(isInactiveContextError(new Error("boom")), false);
  assert.equal(isInactiveContextError(null), false);
  assert.equal(isInactiveContextError(undefined), false);
});

test("watchContextLife：没有 ctx.effect 时默认存活", () => {
  assert.equal(watchContextLife(null).alive, true);
  assert.equal(watchContextLife({}).alive, true);
});

test("watchContextLife：effect 的 dispose 跑过之后 alive 变 false", () => {
  const disposers = [];
  const life = watchContextLife({ effect: (fn) => disposers.push(fn()) });
  assert.equal(life.alive, true);
  assert.equal(disposers.length, 1);
  disposers[0]();
  assert.equal(life.alive, false);
});

test("watchContextLife：装 effect 就抛 INACTIVE_EFFECT 时当作已死，不往上抛", () => {
  const life = watchContextLife({
    effect: () => {
      throw Object.assign(new Error("Inactive context"), { code: "INACTIVE_EFFECT" });
    },
  });
  assert.equal(life.alive, false);
});

test("watchContextLife：其它异常原样抛（不要吞掉真 bug）", () => {
  assert.throws(
    () =>
      watchContextLife({
        effect: () => {
          throw new Error("other");
        },
      }),
    { message: "other" },
  );
});

test("settleDelayMs：桌面端等 4 秒给 Fiber._reload 收尾，其余面不等", () => {
  assert.equal(settleDelayMs("desktop"), 4000);
  assert.equal(DESKTOP_SETTLE_DELAY_MS, 4000);
  assert.equal(settleDelayMs("web"), 0);
  assert.equal(settleDelayMs(undefined), 0);
});

test("settleMayRestart：桌面端与密封包一律不许重启", () => {
  assert.equal(settleMayRestart({ surface: "web" }), true);
  assert.equal(settleMayRestart({ surface: "desktop" }), false);
  assert.equal(settleMayRestart({ surface: "web", sealed: true }), false);
  assert.equal(settleMayRestart({ surface: "desktop", sealed: true }), false);
  assert.equal(settleMayRestart(), true, "不传参按非桌面处理");
});

test("settleMayReapply：只有「桌面端 + 密封」这一种组合不许就地重打", () => {
  assert.equal(settleMayReapply({ surface: "web" }), true);
  assert.equal(settleMayReapply({ surface: "desktop" }), true, "解包布局的桌面端可以重打");
  assert.equal(settleMayReapply({ surface: "web", sealed: true }), true);
  assert.equal(settleMayReapply({ surface: "desktop", sealed: true }), false);
  assert.equal(settleMayReapply(), true);
});

test("applyShouldRestart：密封包永远重启（与补丁是否标 applied 无关）", () => {
  assert.equal(applyShouldRestart({ sealed: true }), true);
  assert.equal(applyShouldRestart({ sealed: true, appliedCount: 0 }), true);
});

test("applyShouldRestart：写全了、提示词就绪、或确实打了补丁，三者任一即重启", () => {
  assert.equal(applyShouldRestart(), false);
  assert.equal(applyShouldRestart({ complete: true }), true);
  assert.equal(applyShouldRestart({ promptReady: true }), true);
  assert.equal(applyShouldRestart({ appliedCount: 1 }), true);
  assert.equal(applyShouldRestart({ appliedCount: 0 }), false);
  assert.equal(applyShouldRestart({ appliedCount: "2" }), true, "字符串数字也算");
  assert.equal(applyShouldRestart({ appliedCount: Number.NaN }), false, "NaN 不算打了补丁");
});
