// 上游 0.2.2-rc.2 的锚点回归：夹具来自真实 rc.2 文件窗口，逐字对拍。
//
// 为什么单独一个文件而不是塞进 test-patch-registry：那个文件对的是「拆分前后补丁一字不差」，
// 这个文件对的是「升级之后补丁还能把新形态改对」。两件事的失败含义完全不同——前者说我们
// 弄丢了自己的历史，后者说我们跟不上上游。
//
// 第三组用例拿 docs/origin/core-split-baseline-8066985 的旧补丁当对照：旧 pattern 打在
// rc.2 窗口上必须一无所获。少了这条，「新 pattern 其实是照抄旧 pattern」这种错就抓不到。
import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { UPGRADE_FIXTURES } from "./patch-upgrade-fixtures.mjs";
import { ALL_PATCHES, applyReplacementsToText } from "../lib/core.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const before = await import(
  pathToFileURL(join(root, "docs", "origin", "core-split-baseline-8066985", "lib", "core.js")).href
);

const PATCH_BY_ID = new Map(ALL_PATCHES.map((p) => [Number(p.id), p]));
const OLD_BY_ID = new Map(before.ALL_PATCHES.map((p) => [Number(p.id), p]));

function patchOf(id) {
  const patch = PATCH_BY_ID.get(Number(id));
  assert.ok(patch, `补丁 #${id} 必须存在`);
  return patch;
}

// ---------- 一、夹具自身的完整性 ----------

test("夹具覆盖这次升级打断的全部 6 条补丁", () => {
  const ids = new Set(UPGRADE_FIXTURES.map((f) => Number(f.id)));
  assert.deepEqual([...ids].sort((a, b) => a - b), [13, 18, 35, 56, 62, 77]);
});

test("每条夹具都带 id / key / file / before / after，且 before 与 after 真的不同", () => {
  for (const f of UPGRADE_FIXTURES) {
    assert.equal(typeof f.id, "number", "fixture id");
    assert.ok(f.key && typeof f.key === "string", `#${f.id} key`);
    assert.ok(f.file && typeof f.file === "string", `#${f.id} file`);
    assert.ok(f.note && f.note.length > 8, `#${f.id} note`);
    assert.ok(f.before.length > 40, `#${f.id} before too short`);
    assert.ok(f.after.length > 20, `#${f.id} after too short`);
    assert.notEqual(f.before, f.after, `#${f.id} before/after must differ`);
  }
});

test("夹具的 key 落在这条补丁声明的文件键里，file 与 key 对得上", () => {
  for (const f of UPGRADE_FIXTURES) {
    const patch = patchOf(f.id);
    const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
    assert.ok(keys.includes(f.key), `#${f.id} 声明的键 ${keys.join(",")} 里没有 ${f.key}`);
    if (patch.rel) {
      const rel = patch.rel.join("/");
      assert.ok(f.file.endsWith(rel), `#${f.id} file ${f.file} 应以 ${rel} 结尾`);
    }
  }
});

// ---------- 二、rc.2 窗口 → 打完补丁 ----------

for (const f of UPGRADE_FIXTURES) {
  test(`#${f.id} ${f.key}：rc.2 原文被改成打完补丁的形态`, () => {
    const patch = patchOf(f.id);
    const once = applyReplacementsToText(f.before, patch, f.file);
    assert.equal(once.hitMismatch, undefined, `#${f.id} 不应出现命中数不符`);
    assert.equal(once.changed, true, `#${f.id} 必须改动这段窗口`);
    assert.equal(once.text, f.after, `#${f.id} 输出必须与夹具逐字一致`);
  });

  test(`#${f.id} ${f.key}：同一段窗口再打一次不再变化`, () => {
    const patch = patchOf(f.id);
    const twice = applyReplacementsToText(f.after, patch, f.file);
    assert.equal(twice.changed, false, `#${f.id} 第二遍必须无事可做`);
    assert.equal(twice.text, f.after, `#${f.id} 第二遍不得改动文本`);
  });

  test(`#${f.id} ${f.key}：打完补丁后，这段窗口里带上了本插件标记`, () => {
    const patch = patchOf(f.id);
    // 一条补丁可以按分支声明多条 replace，每条各带自己的标记（#62 就是四个分支四个标记）。
    // 夹具只切其中一段窗口，所以这里查「本补丁任一 replace 里的标记出现在窗口里」，
    // 而不是查 patch.markers —— 后者是整文件级别的（markersAny），单窗口看不全。
    const own = new Set();
    for (const rep of patch.replacements || []) {
      if (typeof rep.replace !== "string") continue;
      for (const hit of rep.replace.match(/\[dsh-purge\][^\n]*/g) || []) own.add(hit.replace(/\s+$/, ""));
    }
    assert.ok(own.size > 0, `#${f.id} 的 replace 里应带 [dsh-purge] 标记`);
    assert.ok(
      [...own].some((marker) => f.after.includes(marker)),
      `#${f.id} 窗口里应出现本补丁的某个标记，实际候选：${[...own].slice(0, 3).join(" / ")}`,
    );
  });
}

// ---------- 三、旧 pattern 必须打不动 rc.2 窗口 ----------

for (const f of UPGRADE_FIXTURES) {
  test(`#${f.id} ${f.key}：拆分前的旧补丁打在 rc.2 窗口上打不动`, () => {
    const oldPatch = OLD_BY_ID.get(Number(f.id));
    assert.ok(oldPatch, `基线里必须有 #${f.id}`);
    const res = applyReplacementsToText(f.before, oldPatch, f.file);
    assert.equal(res.changed, false, `#${f.id} 旧 pattern 不该命中 rc.2 形态`);
    assert.equal(res.text, f.before, `#${f.id} 旧 pattern 不得改动窗口`);
  });
}

// ---------- 四、语义断言（不止「变了」，还要「变对了」） ----------

test("#62 放行分支：打完补丁不再走 approvalDenial，而是 decision.kind 为 allow", () => {
  const rows = UPGRADE_FIXTURES.filter((f) => Number(f.id) === 62);
  assert.equal(rows.length, 2, "#62 应覆盖 pipeline.js 与 types/pipeline.js 两种排版");
  for (const f of rows) {
    assert.ok(f.before.includes("approvalDenial("), `${f.file} 原文应含 approvalDenial`);
    assert.ok(!f.after.includes("approvalDenial("), `${f.file} 打完不该再有 approvalDenial`);
    assert.match(f.after, /decision: \{ kind: ['"]allow['"] \}/, `${f.file} 应改成放行`);
    assert.ok(f.after.includes("approvalCancelled: false"), `${f.file} 放行时必须写 approved=false 的取消标志`);
  }
});

test("#35 升级分支：打完只剩 allowed-once 与 default 两条路，没有 reject/cancel 分支", () => {
  const f = UPGRADE_FIXTURES.find((x) => Number(x.id) === 35);
  // 查形状而不是查「有没有某个词」：marker 注释本身就叫 never rejected，
  // 光查 "rejected" 连正确实现都会被判红。
  assert.match(
    f.after,
    /switch \(outcome\) \{\n\t\tcase "allowed-once":\n\t\tdefault:\n\t\t\treturn mode; \/\/ \[dsh-purge\] escalation never rejected\n\t\}/,
    "#35 应恰好是 allowed-once → default → return mode 这一条路",
  );
  for (const word of ['case "rejected"', 'case "cancelled"', 'case "unavailable"', "SandboxEscalationError", "throw "]) {
    assert.ok(!f.after.includes(word), `#35 打完不该再有 ${word}`);
  }
});

test("#13 扩权闸门：打完是三行注释，不再抛任何错误", () => {
  const f = UPGRADE_FIXTURES.find((x) => Number(x.id) === 13);
  assert.ok(!f.after.includes("throw new"), "#13 打完不该再 throw");
  assert.ok(!f.after.includes("SandboxEscalationError"), "#13 打完不该再构造错误");
  const commentLines = f.after.split("\n").filter((line) => line.trim().startsWith("//"));
  assert.equal(commentLines.length, 3, "#13 三处抛错应各变成一行注释");
});

test("#18 重复提醒：打完这段钩子被整段注掉，没有再调 prependContext", () => {
  const f = UPGRADE_FIXTURES.find((x) => Number(x.id) === 18);
  assert.ok(!f.after.includes("prependContext("), "#18 打完不该再拼提醒上下文");
  assert.ok(!f.after.includes("chains.delete("), "#18 打完不该再维护链计数");
  assert.ok(f.after.trim().startsWith("//"), "#18 整段应被注释覆盖");
});

test("#56 rewind 隐藏：注入的两个函数与块注释都在，且用的是块注释不是行注释", () => {
  const f = UPGRADE_FIXTURES.find((x) => Number(x.id) === 56);
  assert.ok(f.after.includes("function isRewindMarker("), "#56 注入 isRewindMarker");
  assert.ok(f.after.includes("function rewindVisibleEntries("), "#56 注入 rewindVisibleEntries");
  assert.ok(f.after.includes("/* [dsh-purge] rewind hides the cut turn */"), "#56 marker 必须是块注释");
  // 单行 minified 文件里行注释会把后半行全注掉，这条是硬约束。
  assert.ok(!/\/\/ \[dsh-purge\] rewind hides/.test(f.after), "#56 不许用行注释写 marker");
  assert.ok(f.after.includes("replaceWindow(entries,hasMore){entries=rewindVisibleEntries(entries);"), "#56 改的是 replaceWindow");
});

test("#56 + #77 按真实顺序连打：append 里接上 rewind 判定", () => {
  const f = UPGRADE_FIXTURES.find((x) => Number(x.id) === 56);
  assert.ok(Array.isArray(f.chain) && f.chain.length === 2, "#56 夹具应带 #77 的连打结果");
  const [nextId, expected] = f.chain;
  assert.equal(Number(nextId), 77);
  const chained = applyReplacementsToText(f.after, patchOf(77), f.file);
  assert.equal(chained.changed, true, "#77 在 #56 之后必须还能改动");
  assert.equal(chained.text, expected, "#77 连打结果必须与夹具逐字一致");
  assert.ok(chained.text.includes("if(isRewindMarker(event)){"), "#77 在 append 里插判定");
  assert.ok(chained.text.includes("return this.replaceWindow(entries,this.hasMore)"), "#77 命中后走 replaceWindow");
  assert.ok(!/\/\/ \[dsh-purge\] rewind drops sent/.test(chained.text), "#77 marker 也不许用行注释");
});

test("夹具里不含 CRLF：上游这两个文件在 rc.2 都是 LF，混进来会掩盖换行处理", () => {
  for (const f of UPGRADE_FIXTURES) {
    assert.ok(!f.before.includes("\r"), `#${f.id} before 含 CRLF`);
    assert.ok(!f.after.includes("\r"), `#${f.id} after 含 CRLF`);
  }
});

// ---------- 五、minified 追加条目的防重入 ----------

test("minified 追加的每一条都带 insertProbe，且 probe 就是它自己插进去的那段", () => {
  // 上一个用例（「再打一次不再变化」）证明不了这件事：#56/#77 都开了 skipIfMarked，
  // 只要文件里出现 marker，第二遍本来就整条跳过。真正防止「marker 被上游冲掉后又插一遍」
  // 的是 insertProbe，所以这里单独钉它。
  for (const f of UPGRADE_FIXTURES.filter((x) => x.key === "conversation-client")) {
    const patch = patchOf(f.id);
    const was = OLD_BY_ID.get(Number(f.id));
    const appended = (patch.replacements || []).slice((was.replacements || []).length);
    assert.ok(appended.length > 0, `#${f.id} 应有追加条目`);
    for (const rep of appended) {
      assert.ok(
        typeof rep.insertProbe === "string" && rep.insertProbe.length >= 8,
        `#${f.id} 追加条目必须带 insertProbe，否则 marker 一丢就会重复插入`,
      );
      assert.ok(f.after.includes(rep.insertProbe), `#${f.id} insertProbe 应真的出现在打完的文本里`);
      assert.ok(!f.before.includes(rep.insertProbe), `#${f.id} insertProbe 不该在原文里（否则第一遍就被跳过）`);
    }
  }
});

test("minified 追加条目里的 marker 一律写成块注释，不许出现行注释", () => {
  // 单行 minified 文件里 `//` 会把该行剩下的 20 万字符全部注掉——包括紧随其后的类定义。
  // 只管追加的条目：旧条目打的是 rc.1 那种正常多行文件，行注释在那里没问题。
  // 也不是每条追加都要带 marker：#56 分成「注入函数+marker」与「改写 replaceWindow」两步，
  // 后者不需要重复写 marker。
  for (const f of UPGRADE_FIXTURES.filter((x) => x.key === "conversation-client")) {
    const patch = patchOf(f.id);
    const was = OLD_BY_ID.get(Number(f.id));
    const appended = (patch.replacements || []).slice((was.replacements || []).length);
    assert.ok(appended.length > 0, `#${f.id} 应有追加条目`);
    for (const rep of appended) {
      if (typeof rep.replace !== "string") continue;
      assert.ok(!/\/\/\s*\[dsh-purge\]/.test(rep.replace), `#${f.id} 的追加条目里出现了行注释形态的 marker`);
    }
    assert.ok(
      appended.some((rep) => typeof rep.replace === "string" && /\/\*\s*\[dsh-purge\]/.test(rep.replace)),
      `#${f.id} 的追加条目里至少要有一条块注释 marker（skipIfMarked 靠它）`,
    );
  }
});
