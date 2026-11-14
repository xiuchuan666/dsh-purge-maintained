/**
 * lib/bom-guard.js 的边角：跳过 / 试运行 / 写盘失败 / 告警文案。
 *
 * `scripts/test-bom-guard.mjs`（5 条）钉的是救砖主路：带 BOM 的清单能被 scan 点出来、
 * fix 之后 JSON 可解析、坏文件不被写得更坏。这一份补的是同一套逻辑里四条「不写盘」的出口，
 * 以及 status 里那一行文案 —— 它们共同的坏法是**安静地什么都不做**：
 *   · 该修的没修（dryRun 分支写漏了 continue）→ 用户以为修好了，重启还是起不来；
 *   · 不该修的修了（skipped / failed 分支少了 continue）→ 把坏文件写成半截；
 *   · 写盘失败当成成功（catch 里忘了 push failed）→ 面板说已修复，实际文件带 BOM；
 *   · 告警文案漏一半（只报 BOM 不报 JSON 坏）→ 用户按提示修完 BOM 仍然起不来。
 */
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import {
  BOM, MANIFEST_FILES, hasBom, stripBom, readTextNoBom,
  scanProfileBom, fixProfileBom, bomWarningLine,
} from "../lib/bom-guard.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bomguard-edges-"));
let seq = 0;

/** 每个用例一套干净的 home，避免用例之间靠执行顺序互相影响。 */
function mkHome() {
  const home = path.join(ROOT, `home-${++seq}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function put(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
  return fp;
}

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/* ── 常量与纯函数 ─────────────────────────────────────────────────────────── */

test("BOM 是单个 U+FEFF，hasBom / stripBom 对空值按空文本处理", () => {
  assert.equal(BOM, "\uFEFF");
  assert.equal(BOM.length, 1);

  assert.equal(hasBom(BOM + "x"), true);
  assert.equal(hasBom("x"), false);
  assert.equal(hasBom(""), false);
  // 只有「首字节」算：BOM 出现在中间不算
  assert.equal(hasBom("x" + BOM), false);
  for (const empty of [null, undefined, 0]) assert.equal(hasBom(empty), false, String(empty));

  assert.equal(stripBom(BOM + "ab"), "ab");
  assert.equal(stripBom("ab"), "ab");
  assert.equal(stripBom(BOM), "");
  // 只剥一个：两个 BOM 只去掉开头那个
  assert.equal(stripBom(BOM + BOM + "a"), BOM + "a");
  for (const empty of [null, undefined]) assert.equal(stripBom(empty), "", String(empty));
});

test("readTextNoBom：读不到就返回空串（不抛），读到就把 BOM 剥掉", () => {
  const home = mkHome();
  assert.equal(readTextNoBom(path.join(home, "nope.json")), "");
  const fp = put(path.join(home, "a.json"), BOM + '{"a":1}');
  assert.equal(readTextNoBom(fp), '{"a":1}');
});

test("MANIFEST_FILES：六个清单的名字与 kind 固定，不重复", () => {
  // 顺序即扫描顺序；kind 只有 json 与 yaml 两种，json 只有 package.json 一个 ——
  // 多一个 json 就多一条「剥了 BOM 仍要能解析」的约束，改这张表要连带看 fix 分支。
  assert.deepEqual(MANIFEST_FILES, [
    { name: "package.json", kind: "json" },
    { name: "cordis.patch.yml", kind: "yaml" },
    { name: "cordis.patch.yaml", kind: "yaml" },
    { name: "cordis.yml", kind: "yaml" },
    { name: "cordis.yaml", kind: "yaml" },
    { name: "pnpm-workspace.yaml", kind: "yaml" },
  ]);
  const names = MANIFEST_FILES.map((m) => m.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(MANIFEST_FILES.filter((m) => m.kind === "json").length, 1);
});

/* ── scanProfileBom ──────────────────────────────────────────────────────── */

test("scanProfileBom：空 home / 不存在的 home 都是「零个清单、没问题」", () => {
  for (const home of ["", null, undefined, path.join(ROOT, "does-not-exist")]) {
    const r = scanProfileBom(home);
    assert.deepEqual(r, { checked: 0, bom: [], broken: [], ok: true }, String(home));
  }
});

test("scanProfileBom：profiles 下不是目录的条目直接跳过", () => {
  const home = mkHome();
  put(path.join(home, "profiles", "pkg.json"), "x"); // 一个文件冒充 profile 目录
  put(path.join(home, "profiles", "real", "package.json"), '{"a":1}');

  const r = scanProfileBom(home);
  assert.equal(r.checked, 1);
  assert.equal(r.bom.length, 0);
  assert.equal(r.ok, true);
});

test("scanProfileBom：scope 是 home 或 profile 目录名，checked 只数存在的文件", () => {
  const home = mkHome();
  put(path.join(home, "pnpm-workspace.yaml"), BOM + "a: 1\n");
  put(path.join(home, "profiles", "alpha", "cordis.yml"), BOM + "b: 2\n");
  // 一个 profile 里什么都没写 → 六个候选全部落空，一条都不进 checked
  fs.mkdirSync(path.join(home, "profiles", "empty"), { recursive: true });

  const r = scanProfileBom(home);
  assert.equal(r.checked, 2);
  assert.deepEqual(r.bom.map((x) => [x.scope, x.kind]).sort(), [["alpha", "yaml"], ["home", "yaml"]]);
});

test("scanProfileBom：yaml 只报 BOM 不报 broken，坏 JSON 两条都报", () => {
  const home = mkHome();
  const prof = path.join(home, "profiles", "x");
  put(path.join(prof, "cordis.patch.yml"), BOM + "- insert:\n");
  put(path.join(prof, "package.json"), BOM + '{ "name": ');

  const r = scanProfileBom(home);
  assert.deepEqual(r.bom.map((x) => x.kind).sort(), ["json", "yaml"]);
  assert.equal(r.broken.length, 1);
  assert.equal(r.broken[0].kind, "json");
  assert.match(r.broken[0].error, /JSON/);
  assert.equal(r.ok, false);
});

/* ── fixProfileBom：四条不写盘的出口 ─────────────────────────────────────── */

test("fixProfileBom：dryRun 只报告不写盘，report 仍然报 BOM", () => {
  const home = mkHome();
  const fp = put(path.join(home, "profiles", "x", "package.json"), BOM + '{"a":1}\n');
  const before = fs.readFileSync(fp, "utf8");

  const r = fixProfileBom(home, { dryRun: true });
  assert.equal(r.fixed.length, 1);
  assert.equal(r.fixed[0].dryRun, true);
  assert.equal(r.failed.length, 0);
  assert.equal(fs.readFileSync(fp, "utf8"), before, "dryRun 一个字节都不能动");
  assert.equal(r.report.ok, false);
  assert.equal(r.report.bom.length, 1);
});

test("fixProfileBom：真的写回时只去掉 BOM，其余字节原样", () => {
  const home = mkHome();
  const body = '{\n  "name": "x",\n  "dsh": { "profile": { "bundles": ["dsh-purge"] } }\n}\n';
  const fp = put(path.join(home, "profiles", "x", "package.json"), BOM + body);

  const r = fixProfileBom(home);
  assert.equal(r.fixed.length, 1);
  assert.equal(r.fixed[0].dryRun, undefined);
  assert.equal(fs.readFileSync(fp, "utf8"), body);
  assert.equal(r.report.ok, true, "report 是修完再扫一遍的结果");
});

test("fixProfileBom：yaml 带 BOM 也剥，但不做 JSON 校验", () => {
  const home = mkHome();
  const body = "- insert:\n    - id: dsh-purge\n";
  const fp = put(path.join(home, "profiles", "x", "cordis.patch.yaml"), BOM + body);

  const r = fixProfileBom(home);
  assert.equal(r.fixed.length, 1);
  assert.equal(fs.readFileSync(fp, "utf8"), body);
});

test("fixProfileBom：没有 BOM 但 JSON 坏的清单进 skipped，且一个字节都不写", () => {
  const home = mkHome();
  const broken = '{ "name": ';
  const fp = put(path.join(home, "profiles", "x", "package.json"), broken);

  const r = fixProfileBom(home);
  assert.equal(r.fixed.length, 0);
  assert.equal(r.failed.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].reason, "json-invalid");
  assert.match(r.skipped[0].error, /JSON/);
  assert.equal(fs.readFileSync(fp, "utf8"), broken);
  // 这种坏法 fix 修不了，所以修完再扫仍然是 broken
  assert.equal(r.report.broken.length, 1);
});

test("fixProfileBom：剥了 BOM 仍坏的 JSON 进 failed（不写），原文连带 BOM 留着", () => {
  const home = mkHome();
  const raw = BOM + '{ "name": ';
  const fp = put(path.join(home, "profiles", "x", "package.json"), raw);

  const r = fixProfileBom(home);
  assert.equal(r.fixed.length, 0);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /JSON/);
  assert.equal(fs.readFileSync(fp, "utf8"), raw, "修不了就别动它");
});

test("fixProfileBom：写盘失败（rename 抛错）进 failed，原文件不变且不留临时文件", () => {
  const home = mkHome();
  const raw = BOM + '{"a":1}\n';
  const fp = put(path.join(home, "profiles", "x", "package.json"), raw);

  // atomicWriteSync 是「写 tmp → rename」；把 rename 弄挂就等于磁盘满 / 文件被占用。
  const orig = fs.renameSync;
  fs.renameSync = () => { throw new Error("rename boom"); };
  let r;
  try {
    r = fixProfileBom(home);
  } finally {
    fs.renameSync = orig;
  }

  assert.equal(r.fixed.length, 0);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].error, "rename boom");
  assert.equal(fs.readFileSync(fp, "utf8"), raw, "失败时原文件必须原样");
  assert.deepEqual(fs.readdirSync(path.dirname(fp)).filter((n) => n.includes(".tmp")), []);
});

/* ── bomWarningLine ──────────────────────────────────────────────────────── */

test("bomWarningLine：干净的 home 返回空串（status 里不该多出一行）", () => {
  const home = mkHome();
  put(path.join(home, "profiles", "x", "package.json"), '{"a":1}');
  assert.equal(bomWarningLine(home), "");
  assert.equal(bomWarningLine(""), "");
});

test("bomWarningLine：只有 BOM 时只说 BOM，并给出修复命令", () => {
  const home = mkHome();
  put(path.join(home, "profiles", "x", "package.json"), BOM + '{"a":1}');

  const line = bomWarningLine(home);
  assert.match(line, /^清单告警 \/ manifest: /);
  assert.match(line, /1 个清单带 BOM（宿主 0\.2\.2 会起不来）/);
  assert.match(line, /运行 dsh-purge --fix-bom 修复$/);
  assert.ok(!line.includes("JSON 坏"), line);
});

test("bomWarningLine：只有坏 JSON 时只说坏，BOM 在前、坏 JSON 在后", () => {
  const home = mkHome();
  put(path.join(home, "profiles", "x", "package.json"), '{ "name": ');
  const onlyBroken = bomWarningLine(home);
  assert.match(onlyBroken, /1 个清单 JSON 坏/);
  assert.ok(!onlyBroken.includes("带 BOM"), onlyBroken);

  put(path.join(home, "profiles", "y", "package.json"), BOM + '{"b":2}');
  const both = bomWarningLine(home);
  assert.ok(both.includes("1 个清单带 BOM（宿主 0.2.2 会起不来），1 个清单 JSON 坏"), both);
});

/* ── 写后复查（atomicWriteSync 之外的第二道闸） ───────────────────────────── */

/**
 * 写完之后要把文件读回来再验一遍。这两条只能靠「让 rename 成功、但读回时给出坏内容」来测：
 * 真实场景是另一进程在同一毫秒把 BOM 写回去，或者磁盘缓存骗了我们。
 */
function withLyingReader(fp, lie) {
  const origRename = fs.renameSync;
  const origRead = fs.readFileSync;
  let written = false;
  fs.renameSync = (...args) => {
    const out = origRename.apply(fs, args);
    written = true;
    return out;
  };
  fs.readFileSync = (target, ...rest) => {
    if (written && String(target) === fp) return lie;
    return origRead.call(fs, target, ...rest);
  };
  return () => {
    fs.renameSync = origRename;
    fs.readFileSync = origRead;
  };
}

test("写后复查：读回来还带 BOM 就记 failed，不能算修好", () => {
  const home = mkHome();
  const body = '{"a":1}\n';
  const fp = put(path.join(home, "profiles", "x", "package.json"), BOM + body);

  const restore = withLyingReader(fp, BOM + body);
  let r;
  try {
    r = fixProfileBom(home);
  } finally {
    restore();
  }

  assert.equal(r.fixed.length, 0);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /BOM still present after write/);
});

test("写后复查：读回来 JSON 解析不过也记 failed", () => {
  const home = mkHome();
  const fp = put(path.join(home, "profiles", "x", "package.json"), BOM + '{"a":1}\n');

  const restore = withLyingReader(fp, "{");
  let r;
  try {
    r = fixProfileBom(home);
  } finally {
    restore();
  }

  assert.equal(r.fixed.length, 0);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /JSON/);
  assert.ok(!/BOM still present/.test(r.failed[0].error), r.failed[0].error);
});

/* ── 源码形状 ─────────────────────────────────────────────────────────────── */

test("源码形状：写盘只走 atomicWriteSync，且已删掉从未被调用的 readJsonNoBom", () => {
  const src = fs.readFileSync(new URL("../lib/bom-guard.js", import.meta.url), "utf8");
  // 直接 writeFileSync 会丢掉 atomicWriteSync 的「写 tmp + fsync + rename」，
  // 断电时清单可能变成半截（那正是这个模块要救的砖）。
  assert.ok(!/\bfs\.writeFileSync\(/.test(src), "不许绕过 atomicWriteSync 直接写盘");
  assert.ok(src.includes("atomicWriteSync(fp, text, \"utf8\")"));
  // readJsonNoBom 全仓只有定义处一个名字，属死代码，已删除；别再加回来。
  assert.ok(!src.includes("readJsonNoBom"));
});