/**
 * profile-insert 的边角：`cordis.patch.yml` 的 insert 段状态机、allowBuilds 段的三处
 * 结束判据，以及「写前校验不过就不动用户的文件」这条出口。
 *
 * 为什么单独一份：`scripts/test-self-update.mjs` 只跑正常路径（空文件追加、已是
 * block-seq 就不动）。这里钉的是「段什么时候算结束」「什么时候整段放弃」——
 * 判错的表现是 patched 用户的 pnpm-workspace.yaml 被改坏，或者同一条 insert 被写两遍。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as P from "../lib/profile-insert.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-profile-insert-"));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }));

const box = (tag) => {
  const dir = path.join(ROOT, tag);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const put = (fp, text) => {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
};

// ── profileHasPurgeBodyInsert：段关闭与重开 ─────────────────────────────

test("profileHasPurgeBodyInsert：兄弟键结束 insert 段，段外的 id 不算", () => {
  // `- next-key:` 与 `- insert:` 同缩进 → 段结束；后面那条 id 在段外，不能算命中
  const text = "- insert:\n    - id: other\n- next-key: 1\n    - id: dsh-purge\n";
  assert.equal(P.profileHasPurgeBodyInsert(text), false);
});

test("profileHasPurgeBodyInsert：段关闭后遇到另一个 - insert: 会重新打开", () => {
  const text = "- insert:\n    - id: other\n- insert:\n    - id: dsh-purge\n";
  assert.equal(P.profileHasPurgeBodyInsert(text), true);
});

test("profileHasPurgeBodyInsert：关闭后缩进更深的 id 也不算（段是真的关了）", () => {
  const text = "- insert:\n    - id: other\n- another:\n  - id: dsh-purge\n";
  assert.equal(P.profileHasPurgeBodyInsert(text), false);
});

test("profileHasPurgeBodyInsert：内层缩进的 - insert: 也认（用户手写的 plugins: 包一层）", () => {
  assert.equal(P.profileHasPurgeBodyInsert("- plugins:\n  - insert:\n    - id: dsh-purge\n"), true);
});

test("profileHasPurgeBodyInsert：内层 insert 段的结束判据要比本行缩进，不是比顶层 0", () => {
  // `  - other:` 与内层 `- insert:` 同缩进（2）→ 段结束；后面那条 id 缩进 4 在段外
  const text = "- plugins:\n  - insert:\n    - id: other\n  - other:\n    - id: dsh-purge\n";
  assert.equal(P.profileHasPurgeBodyInsert(text), false);
});

test("profileHasPurgeBodyInsert：#159 的两个绕过写法都认", () => {
  assert.equal(P.profileHasPurgeBodyInsert("- insert:\n    - id: dsh-purge-main\n"), true);
  assert.equal(P.profileHasPurgeBodyInsert("- insert:\n    - name: dsh-purge\n"), true);
});

test("profileHasPurgeBodyInsert：INSERT_BLOCK 自己当然认", () => {
  assert.equal(P.profileHasPurgeBodyInsert(P.INSERT_BLOCK), true);
});

// ── classifyPatchBody：五形态 ─────────────────────────────────────────

test("classifyPatchBody：空文件与只有注释都算 empty", () => {
  assert.equal(P.classifyPatchBody("").kind, "empty");
  assert.equal(P.classifyPatchBody("# 只有注释\n\n").kind, "empty");
});

test("classifyPatchBody：空 flow 序列（可带 --- 与行尾注释）单独一档", () => {
  assert.equal(P.classifyPatchBody("[]\n").kind, "empty-flow");
  assert.equal(P.classifyPatchBody("[] # 宿主生成\n").kind, "empty-flow");
  assert.equal(P.classifyPatchBody("---\n[]\n").kind, "empty-flow");
});

test("classifyPatchBody：非空 flow 序列是用户内容，不写", () => {
  assert.equal(P.classifyPatchBody("[a, b]\n").kind, "flow-seq");
});

test("classifyPatchBody：块序列正常，块里混进顶层 flow 就认不准", () => {
  assert.equal(P.classifyPatchBody("- insert:\n    - id: x\n").kind, "block-seq");
  assert.equal(P.classifyPatchBody("- a\n[a]\n").kind, "unknown");
});

test("classifyPatchBody：顶层映射 unknown；多文档只看最后一个", () => {
  assert.equal(P.classifyPatchBody("foo: 1\n").kind, "unknown");
  assert.equal(P.classifyPatchBody("- a\n---\n- b\n").kind, "block-seq");
});

// ── validateAllowBuildRewrite：段结束与重复键 ────────────────────────

test("validateAllowBuildRewrite：缩进回退即段结束，之后的同名键不再算重复", () => {
  assert.equal(P.validateAllowBuildRewrite("allowBuilds:\n    a: true\n  b: true\n"), true);
  assert.equal(P.validateAllowBuildRewrite("allowBuilds:\n    a: true\n  a: true\n"), true);
});

test("validateAllowBuildRewrite：段结束后再出现深缩进行也不再校验（不是「只跳过那一行」）", () => {
  // 回退那一行本身被 continue 跳过，段标记若没清掉，下面这行深缩进的垃圾就会被判不过
  assert.equal(P.validateAllowBuildRewrite("allowBuilds:\n    a: true\n  b: true\n    notakey\n"), true);
});

test("validateAllowBuildRewrite：同一段里的重复键、重复顶层键都判不过", () => {
  assert.equal(P.validateAllowBuildRewrite("allowBuilds:\n  a: true\n  a: false\n"), false);
  assert.equal(P.validateAllowBuildRewrite("a: 1\na: 2\n"), false);
});

test("validateAllowBuildRewrite：段里解析不出键就判不过；空文本与注释行放过", () => {
  assert.equal(P.validateAllowBuildRewrite("allowBuilds:\n  notakey\n"), false);
  assert.equal(P.validateAllowBuildRewrite(""), true);
  assert.equal(P.validateAllowBuildRewrite("# hi\nallowBuilds:\n  a: true\n"), true);
});

// ── rewritePnpmAllowBuilds：四处段结束与行保留 ───────────────────────

test("rewritePnpmAllowBuilds：空行结束 allowBuilds 段，后面的内容原样留在段外", () => {
  const out = P.rewritePnpmAllowBuilds("allowBuilds:\n  other: true\n\nnext: 1\n", "NOPE");
  assert.equal(out, "allowBuilds:\n  other: true\n  dsh-purge: true\n\nnext: 1\n");
});

test("rewritePnpmAllowBuilds：顶格行（/^\\S/）也结束段", () => {
  const out = P.rewritePnpmAllowBuilds("allowBuilds:\n  other: true\nnext: 1\n", "NOPE");
  assert.equal(out, "allowBuilds:\n  other: true\n  dsh-purge: true\nnext: 1\n");
});

test("rewritePnpmAllowBuilds：段内注释行与解析不出的行都原样保留", () => {
  const withComment = P.rewritePnpmAllowBuilds("allowBuilds:\n  # keep me\n  other: true\n", "NOPE");
  assert.equal(withComment, "allowBuilds:\n  # keep me\n  other: true\n  dsh-purge: true\n");
  const withBad = P.rewritePnpmAllowBuilds("allowBuilds:\n  =weird\n  other: true\n", "NOPE");
  assert.equal(withBad, "allowBuilds:\n  =weird\n  other: true\n  dsh-purge: true\n");
});

test("rewritePnpmAllowBuilds：空文本与「根本没有 allowBuilds」是两套写法", () => {
  assert.equal(P.rewritePnpmAllowBuilds("", "NOPE"), "allowBuilds:\n  dsh-purge: true\n");
  assert.equal(
    P.rewritePnpmAllowBuilds("packages:\n  - .\n", "NOPE"),
    "packages:\n  - .\n\nallowBuilds:\n  dsh-purge: true\n",
  );
});

test("rewritePnpmAllowBuilds：判断不出版本时保留来源键，并补一条裸包名", () => {
  const out = P.rewritePnpmAllowBuilds('allowBuilds:\n  "dsh-purge@git+https://x/y": true\n', "NOPE");
  assert.equal(out, 'allowBuilds:\n  "dsh-purge@git+https://x/y": true\n  dsh-purge: true\n');
});

// ── parseAllowBuildLine / formatAllowBuildLine ───────────────────────

test("parseAllowBuildLine：顶层键与「冒号后没空白」都不算键值行", () => {
  assert.equal(P.parseAllowBuildLine("a: true"), null);
  assert.equal(P.parseAllowBuildLine("  a:true"), null);
  assert.equal(P.parseAllowBuildLine("  :  true"), null);
});

test("parseAllowBuildLine：引号键里的冒号不会切碎键；加引号的格式能无损回读", () => {
  assert.deepEqual(P.parseAllowBuildLine('  "a://b": true'), { key: "a://b", value: "true" });
  assert.equal(P.formatAllowBuildLine("a://b"), '  "a://b": true');
  assert.equal(P.parseAllowBuildLine(P.formatAllowBuildLine("a://b")).key, "a://b");
});

// ── ensurePnpmAllowBuild：写前校验不过就不动文件 ─────────────────────

test("ensurePnpmAllowBuild：空 profile 写一份；第二次不再写", () => {
  const dir = box("allow-fresh");
  const first = P.ensurePnpmAllowBuild(dir);
  assert.deepEqual({ ok: first.ok, wrote: first.wrote }, { ok: true, wrote: true });
  assert.equal(fs.readFileSync(path.join(dir, "pnpm-workspace.yaml"), "utf8"), "allowBuilds:\n  dsh-purge: true\n");
  const second = P.ensurePnpmAllowBuild(dir);
  assert.deepEqual({ ok: second.ok, wrote: second.wrote }, { ok: true, wrote: false });
});

test("ensurePnpmAllowBuild：重写结果过不了校验就报 allowBuilds-invalid 且原文一字不动", () => {
  const dir = box("allow-invalid");
  const fp = path.join(dir, "pnpm-workspace.yaml");
  const before = "packages:\npackages:\nallowBuilds:\n  other: true\n";
  put(fp, before);
  const r = P.ensurePnpmAllowBuild(dir);
  assert.deepEqual({ ok: r.ok, wrote: r.wrote, reason: r.reason }, { ok: false, wrote: false, reason: "allowBuilds-invalid" });
  assert.equal(fs.readFileSync(fp, "utf8"), before);
});

// ── ensureProfileBodyInsert：五形态各自的写与不写 ────────────────────

test("ensureProfileBodyInsert：empty 与 empty-flow 都写整段（不留 `[]`）", () => {
  const cases = [["pi-empty", ""], ["pi-flow", "[]\n"]];
  for (const [tag, text] of cases) {
    const dir = box(tag);
    const fp = path.join(dir, "cordis.patch.yml");
    put(fp, text);
    const r = P.ensureProfileBodyInsert(dir);
    assert.equal(r.wrote, true, tag);
    assert.equal(fs.readFileSync(fp, "utf8"), P.INSERT_BLOCK, tag);
  }
});

test("ensureProfileBodyInsert：用户自己的 flow-seq / 顶层映射一律不碰", () => {
  for (const [tag, text] of [["pi-user-flow", "[a]\n"], ["pi-map", "foo: 1\n"]]) {
    const dir = box(tag);
    const fp = path.join(dir, "cordis.patch.yml");
    put(fp, text);
    const r = P.ensureProfileBodyInsert(dir);
    assert.deepEqual({ ok: r.ok, wrote: r.wrote }, { ok: false, wrote: false }, tag);
    assert.equal(fs.readFileSync(fp, "utf8"), text, tag);
  }
});

test("ensureProfileBodyInsert：已经有本体行就一个字都不改", () => {
  const dir = box("pi-already");
  const fp = path.join(dir, "cordis.patch.yml");
  const text = "- insert:\n    - id: dsh-purge\n";
  put(fp, text);
  const r = P.ensureProfileBodyInsert(dir);
  assert.equal(r.wrote, false);
  assert.equal(fs.readFileSync(fp, "utf8"), text);
});

// ── profileOwnsPurge 的 existsSync 兜底 ─────────────────────────────

test("profileOwnsPurge：探测 node_modules 时 fs.existsSync 抛错就当「没有」，整个 profile 被跳过", () => {
  const home = path.join(ROOT, "home-boom");
  const dir = path.join(home, "profiles", "p1");
  put(path.join(dir, "package.json"), JSON.stringify({ name: "p1" }));
  const target = path.join(dir, "node_modules", "dsh-purge", "package.json");
  const orig = fs.existsSync;
  fs.existsSync = (p) => {
    if (String(p) === target) throw new Error("exists boom");
    return orig(p);
  };
  try {
    // 不抛、也不把它当自己的 profile —— 于是什么也不写
    assert.deepEqual(P.ensureAllProfileBodyInserts(home), []);
    assert.equal(fs.existsSync(path.join(dir, "cordis.patch.yml")), false);
  } finally {
    fs.existsSync = orig;
  }
});

// ── 源码形状 ─────────────────────────────────────────────────────────

test("源码形状：insert 段关闭要靠缩进比较，不许改成「见到下一个 - xx: 就停」", () => {
  const src = fs.readFileSync(new URL("../lib/profile-insert.js", import.meta.url), "utf8").split(/\r?\n/);
  const code = src.filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"));
  const hits = code.filter((l) => l.includes("if (trimmed && indent <= insertIndent && /^-\\s/.test(trimmed)) {"));
  assert.equal(hits.length, 1, "insert 段的关闭判据被改过？");
  assert.equal(code.some((l) => l.includes("if (insertIndent < 0) continue;")), true);
});
