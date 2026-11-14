import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const core = await import("../lib/core.js");

const SRC = readFileSync(new URL("../lib/core.js", import.meta.url), "utf8");
const KEY = "function legacyApplyPath(section, op) {";
const STALE = "=> legacyApplyPath(section, op)";
const FIXED = "=> applyPathOp(section, op)";

function block(body = "  return op;") {
  return `${KEY}\n${body}\n}\n`;
}
function countKey(text) {
  return text.split(KEY).length - 1;
}

test("endOfBalancedBlock：单层块回右花括号之后的下标", () => {
  const text = `head ${KEY.slice(0, 0)}${"{"}return 1;}`;
  assert.equal(core.endOfBalancedBlock(text, text.indexOf("{")), text.length);
  const mid = `abc{def}tail`;
  assert.equal(mid.slice(0, core.endOfBalancedBlock(mid, 3)), "abc{def}");
})

test("endOfBalancedBlock：内层嵌套的花括号算在同一个块里", () => {
  const text = "x{ { } y }z";
  assert.equal(core.endOfBalancedBlock(text, 1), 10);
})

test("endOfBalancedBlock：找不到闭合就回全文长度，不抛", () => {
  const text = "a{ b(c) d";
  assert.equal(core.endOfBalancedBlock(text, 1), text.length);
})

test("endOfBalancedBlock：回的是绝对下标，不是相对 openAt 的偏移", () => {
  const text = "0000{a}";
  assert.equal(core.endOfBalancedBlock(text, 5), 7);
})

test("legacyApplyPathStarts：没有定义时数 0", () => {
  assert.equal(core.legacyApplyPathStarts("nothing here\n"), 0);
  assert.equal(core.legacyApplyPathStarts(""), 0);
})

test("legacyApplyPathStarts：数的是出现次数，签名不同的不算", () => {
  assert.equal(core.legacyApplyPathStarts(block()), 1);
  assert.equal(core.legacyApplyPathStarts(block() + block() + block()), 3);
  assert.equal(core.legacyApplyPathStarts("function legacyApplyPath(section) {"), 0);
})

test("legacyApplyPathStarts：CRLF 文本一样数得出来", () => {
  assert.equal(core.legacyApplyPathStarts((block() + block()).replace(/\n/g, "\r\n")), 2);
})

test("collapseDuplicateLegacyApplyPath：只有一份时原样返回", () => {
  const one = block();
  assert.equal(core.collapseDuplicateLegacyApplyPath(one), one);
  assert.equal(core.collapseDuplicateLegacyApplyPath(""), "");
})

test("collapseDuplicateLegacyApplyPath：两份只留第一份的正文", () => {
  const out = core.collapseDuplicateLegacyApplyPath(block() + "\n" + block("  return 2;"));
  assert.equal(countKey(out), 1);
  assert.equal(out.includes("return 2;"), false);
  assert.equal(out.includes("return op;"), true);
})

test("collapseDuplicateLegacyApplyPath：正文里有嵌套花括号时不会提前截断", () => {
  const body = "  if (a) { b(); }\n  return op;";
  const out = core.collapseDuplicateLegacyApplyPath(block(body) + "\n" + block("  return 2;"));
  assert.equal(out.includes("if (a) { b(); }"), true);
  assert.equal(out.includes("return 2;"), false);
})

test("collapseDuplicateLegacyApplyPath：三份也只剩一份", () => {
  const out = core.collapseDuplicateLegacyApplyPath(block() + block() + block());
  assert.equal(countKey(out), 1);
})

test("collapseDuplicateLegacyApplyPath：行尾跟着原文，CRLF 不被改成 LF", () => {
  const crlf = (block() + block()).replace(/\n/g, "\r\n");
  const out = core.collapseDuplicateLegacyApplyPath(crlf);
  assert.equal(out.includes("\r\n"), true);
  assert.equal(out.replace(/\r\n/g, "").includes("\n"), false);
})

test("collapseDuplicateLegacyApplyPath：第二份没有闭合时，从它到文件末尾整段删掉（现状）", () => {
  const tail = "const keep = 1;\n";
  const broken = `${block()}${KEY}\n  return 2;\n${tail}`;
  const out = core.collapseDuplicateLegacyApplyPath(broken);
  // 现状锁定：endOfBalancedBlock 找不到闭合就回全文长度，于是剩下那半份连同它后面的
  // 内容一起被切掉。那份本来就是语法错的文件（#42 累积产物），留着 dsh 更起不来。
  assert.equal(countKey(out), 1);
  assert.equal(out.includes("return 2;"), false);
  assert.equal(out.includes(tail), false);
  assert.equal(out, `${block()}`);
})

test("collapseDuplicateLegacyApplyPath：三份以上只留一份，且缩进与正文一字不改", () => {
  const body = "  const a = { b: 1 };\n    return op;";
  const out = core.collapseDuplicateLegacyApplyPath(block(body) + block(body) + block(body));
  // 现状：每删一份都会把它前面那段空隙留下来，末尾再用 `\n{3,}` → `\n\n` 收口，
  // 所以留下第一份正文加一个空行。正文与缩进一字未动。
  assert.equal(out, `${block(body)}\n`);
  assert.equal(countKey(out), 1);
})

test("collapseDuplicateLegacyApplyPath：一份都没有时永远原样返回，哪怕正文里有花括号", () => {
  const text = "const o = { a: 1 };\nif (x) { y(); }\n";
  assert.equal(core.collapseDuplicateLegacyApplyPath(text), text);
  // 空行也不许被顺手收口：没有 legacyApplyPath 的文件一个字节都不该动。
  const blank = "a\n\n\n\nb\n";
  assert.equal(core.collapseDuplicateLegacyApplyPath(blank), blank);
})

test("rewriteStaleLegacyApplyCall：每一处旧调用都换成新调用", () => {
  const text = `a ${STALE} b ${STALE}\n`;
  const out = core.rewriteStaleLegacyApplyCall(text);
  assert.equal(out.includes(STALE), false);
  assert.equal(out.split(FIXED).length - 1, 2);
})

test("rewriteStaleLegacyApplyCall：没有旧调用时原样返回", () => {
  const text = `${KEY}\n  return op;\n}\n`;
  assert.equal(core.rewriteStaleLegacyApplyCall(text), text);
})

test("rewriteStaleLegacyApplyCall：CRLF 保持 CRLF", () => {
  const text = `x ${STALE}\r\n`;
  const out = core.rewriteStaleLegacyApplyCall(text);
  assert.equal(out, `x ${FIXED}\r\n`);
})

test("patchApplied：#42 定义叠了两份时一律判没打上", () => {
  const text = `${block()}${block()}${KEY}\n`;
  const patch = { id: 42, markers: [KEY] };
  assert.equal(core.patchApplied(block(), patch), true);
  assert.equal(core.patchApplied(text, patch), false);
})

test("patchApplied：#42 还留着删除后的旧调用时也判没打上", () => {
  const text = `${block()}const f = (s, o) ${STALE};\n`;
  assert.equal(core.patchApplied(text, { id: 42, markers: [KEY] }), false);
  assert.equal(core.patchApplied(text, { id: 43, markers: [KEY] }), true);
})

test("patchApplied：markers 里有一个不在就判没打上，replace 只看首行前 60 字", () => {
  const text = `${block()}const AAA = 1;\n`;
  assert.equal(core.patchApplied(text, { id: 43, markers: [KEY, "NOT-THERE"] }), false);
  assert.equal(core.patchApplied(text, { id: 43, markers: [KEY, "const AAA = 1;"] }), true);
  assert.equal(core.patchApplied(text, { id: 43, replace: "const AAA = 1;\nconst BBB = 2;\n" }), true);
  assert.equal(core.patchApplied(text, { id: 43, replace: "const ZZ = 1;\n" }), false);
  assert.equal(core.patchApplied(text, { id: 43, replace: "" }), false);
  assert.equal(core.patchApplied(text, { id: 43 }), false);
})

test("applyReplacementsToText：id 42 会先把重复定义折叠掉，再算改动过", () => {
  const text = `${block()}${block()}`;
  const out = core.applyReplacementsToText(text, { id: 42, replacements: [] }, "settings.js");
  assert.equal(out.changed, true);
  assert.equal(countKey(out.text), 1);
})

test("applyReplacementsToText：别的补丁不动这段重复定义", () => {
  const text = `${block()}${block()}`;
  const out = core.applyReplacementsToText(text, { id: 41, replacements: [] }, "settings.js");
  assert.equal(out.changed, false);
  assert.equal(out.text, text);
})

test("applyReplacementsToText：折叠之后仍继续按 replacement 处理", () => {
  const text = `${block()}${block()}const marker = "OLD";\n`;
  const patch = { id: 42, replacements: [{ pattern: 'const marker = "OLD";', replace: 'const marker = "NEW";' }] };
  const out = core.applyReplacementsToText(text, patch, "settings.js");
  assert.equal(out.changed, true);
  assert.equal(out.text.includes('const marker = "NEW";'), true);
  assert.equal(countKey(out.text), 1);
})

test("源码形状：折叠在换调用之前，两处都只在 id 42 分支里", () => {
  const at = SRC.indexOf("export function applyReplacementsToText(");
  assert.ok(at > 0);
  const body = SRC.slice(at, at + 900);
  const collapse = body.indexOf("collapseDuplicateLegacyApplyPath(source)");
  const rewrite = body.indexOf("rewriteStaleLegacyApplyCall(source)");
  assert.ok(collapse > 0 && rewrite > collapse, "collapse before rewrite");
  assert.equal(body.split("if (patch?.id === 42) {").length - 1, 1);
  // postReceivedExtractors
  assert.equal(SRC.split("export function collapseDuplicateLegacyApplyPath(").length - 1, 1);
  assert.ok(SRC.includes("const key = \"function legacyApplyPath(section, op) {\";"));
})
