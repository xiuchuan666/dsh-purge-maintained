// lib/skills.js 的行为锁：技能包（SKILL.md）的解析、落盘、备份、导入。
//
// 这个模块是「导入技能包」与「面板里改技能」的唯一通道，坏法都很安静：
//   - parseSkillDocument 放松了 name 校验 → 面板存进去一个 `Code_Review`，
//     宿主按 kebab-case 查表，技能永远不生效，而面板显示「已保存」；
//   - mergeSkillDocument 丢掉官方 frontmatter 的其它字段 → whenToUse 消失，
//     模型再也想不起来用这个技能；
//   - backupExisting 没备份就删 → 用户改坏一个技能，旧内容找不回来；
//   - importFileTree 的路径校验放松 → 一条 `../..` 就能写到 $DSH_HOME 外面；
//   - listSkills 的 seen 去重丢掉 → 同一个技能在面板里出现两次，删一个还剩一个。
//
// 目录结构有两种形态，都要覆盖：bundle（<skills>/<id>/SKILL.md）与
// flat（<skills>/<id>.md）。readSkill 先查 bundle、再查 flat、最后扫目录名，
// 三段的优先级是用户可见行为（同名时谁赢），不是实现细节。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  validSkillName,
  skillsDir,
  skillBackupDir,
  skillBundleDir,
  skillBundleFile,
  skillFlatFile,
  displayUnderHome,
  toPublicSkill,
  splitFrontmatter,
  parseSkillDocument,
  renderSkillDocument,
  mergeSkillDocument,
  formatSize,
  readSkill,
  listSkills,
  saveSkill,
  deleteSkill,
  findSkillRoots,
  importArchive,
  importFileTree,
  importFromPath,
  skillsStatus,
} from "../lib/skills.js";

const roots = [];
const SRC = fs.readFileSync(new URL("../lib/skills.js", import.meta.url), "utf8");
function home(tag = "h") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-purge-skills-${tag}-`));
  roots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of roots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发 EPERM，交给系统清理临时目录 */
    }
  }
});

/** 写一个 bundle 形态的技能。 */
function writeBundle(dshHome, id, text) {
  const dir = path.join(skillsDir(dshHome), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), text);
  return dir;
}

/** 写一个 flat 形态的技能。 */
function writeFlat(dshHome, filename, text) {
  fs.mkdirSync(skillsDir(dshHome), { recursive: true });
  const fp = path.join(skillsDir(dshHome), filename);
  fs.writeFileSync(fp, text);
  return fp;
}

function doc(name, description, extra = "") {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n正文\n`;
}

/** 手拼一个 zip：本地头 + 中央目录 + EOCD，CRC32 必须写对，否则 bsdtar 会拒。 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? "", "utf8");
    // method 8（deflate）用来造「压缩后 < 12MB、解开后 > 50MB」的包：
    // importArchive 先卡压缩包 12MB，解包之后才卡 50MB，两级都要能触发。
    const method = e.method === 8 ? 8 : 0;
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw) >>> 0;
    const name = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

// ---------------------------------------------------------------- 名字与路径

test("validSkillName 只认 kebab-case，其它一律拒", () => {
  assert.equal(validSkillName("code-review"), true);
  assert.equal(validSkillName("a"), true);
  assert.equal(validSkillName("a1-b2-c3"), true);
  assert.equal(validSkillName("Code_Review"), false);
  assert.equal(validSkillName("code_review"), false);
  assert.equal(validSkillName("-lead"), false);
  assert.equal(validSkillName("trail-"), false);
  assert.equal(validSkillName("double--dash"), false);
  assert.equal(validSkillName("has space"), false);
  assert.equal(validSkillName(""), false);
  assert.equal(validSkillName(null), false);
  assert.equal(validSkillName(42), false);
  assert.equal(validSkillName("../escape"), false);
});

test("五个路径函数都挂在 $DSH_HOME 下，bundle 与 flat 是两种形态", () => {
  const h = path.join(os.tmpdir(), "fake-home");
  assert.equal(skillsDir(h), path.join(h, "skills"));
  assert.equal(skillBackupDir(h), path.join(h, "dsh-purge-backups", "skills"));
  assert.equal(skillBundleDir(h, "code-review"), path.join(h, "skills", "code-review"));
  assert.equal(skillBundleFile(h, "code-review"), path.join(h, "skills", "code-review", "SKILL.md"));
  assert.equal(skillFlatFile(h, "code-review"), path.join(h, "skills", "code-review.md"));
});

test("displayUnderHome 把绝对路径压成 $DSH_HOME/...，越界的压成 $DSH_HOME 本身", () => {
  const h = path.join(os.tmpdir(), "disp-home");
  assert.equal(displayUnderHome(h, ""), "");
  assert.equal(displayUnderHome(h, null), "");
  assert.equal(displayUnderHome(h, h), "$DSH_HOME");
  assert.equal(displayUnderHome(h, path.join(h, "skills", "a", "SKILL.md")), "$DSH_HOME/skills/a/SKILL.md");
  // 越界（含 ..）不是报错，而是显示成 home 本身 —— 面板只用来展示，不承担校验
  assert.equal(displayUnderHome(h, path.join(h, "..", "elsewhere")), "$DSH_HOME");
  assert.equal(displayUnderHome(h, path.resolve(h, "..")), "$DSH_HOME");
});

test("toPublicSkill 只转 path 与 backup 两个字段，其它字段原样带出去", () => {
  const h = path.join(os.tmpdir(), "pub-home");
  const item = { id: "a", path: path.join(h, "skills", "a", "SKILL.md"), backup: path.join(h, "bk"), size: 12 };
  const pub = toPublicSkill(h, item);
  assert.equal(pub.path, "$DSH_HOME/skills/a/SKILL.md");
  assert.equal(pub.backup, "$DSH_HOME/bk");
  assert.equal(pub.size, 12);
  assert.equal(pub.id, "a");
  // 原对象不被改
  assert.equal(item.path.startsWith("$DSH_HOME"), false);
  // 非对象原样返回
  assert.equal(toPublicSkill(h, null), null);
  assert.equal(toPublicSkill(h, "x"), "x");
});

test("formatSize 四档：0 B / 字节 / 一位小数 KB / 整数 KB", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(-5), "0 B");
  assert.equal(formatSize(Number.NaN), "0 B");
  assert.equal(formatSize(Number.POSITIVE_INFINITY), "0 B");
  assert.equal(formatSize(1), "1 B");
  assert.equal(formatSize(1023), "1023 B");
  assert.equal(formatSize(1024), "1.0 KB");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(102400), "100 KB");
  assert.equal(formatSize(1024 * 100 + 500), "100 KB");
});

// ---------------------------------------------------------------- frontmatter

test("splitFrontmatter 认 BOM、CRLF、结尾无换行，缺一段就返回 null", () => {
  assert.deepEqual(splitFrontmatter("---\nname: a\n---\n\nbody"), { head: "name: a", body: "\nbody" });
  assert.deepEqual(splitFrontmatter("\uFEFF---\r\nname: a\r\n---\r\n\r\nbody"), { head: "name: a", body: "\r\nbody" });
  // 结尾没有换行也算闭合
  assert.deepEqual(splitFrontmatter("---\nname: a\n---"), { head: "name: a", body: "" });
  assert.equal(splitFrontmatter(""), null);
  assert.equal(splitFrontmatter("no frontmatter"), null);
  assert.equal(splitFrontmatter("---name: a\n---\n"), null);
  assert.equal(splitFrontmatter("---\nname: a\n"), null);
  assert.equal(splitFrontmatter(null), null);
});

test("parseSkillDocument 正常文档：取 name / description / 正文 / 两个开关的默认值", () => {
  const out = parseSkillDocument(doc("code-review", "review code"));
  assert.equal(out.ok, true);
  assert.equal(out.name, "code-review");
  assert.equal(out.description, "review code");
  assert.equal(out.whenToUse, "");
  assert.equal(out.modelInvocable, true);
  assert.equal(out.userInvocable, true);
  assert.equal(out.body, "\n正文\n");
  assert.equal(out.head, "name: code-review\ndescription: review code");
});

test("parseSkillDocument 缺 frontmatter / 名字不是 kebab / 缺描述，各有自己的报错", () => {
  assert.deepEqual(parseSkillDocument("no frontmatter"), {
    ok: false,
    error: "Missing YAML frontmatter (must be wrapped in ---)",
  });
  assert.deepEqual(parseSkillDocument(doc("Code_Review", "x")), {
    ok: false,
    error: "frontmatter.name must be kebab-case, e.g. code-review",
  });
  assert.deepEqual(parseSkillDocument(doc("code-review", "")), {
    ok: false,
    error: "frontmatter.description is required (single line)",
  });
});

test("parseSkillDocument 两个开关认 true/yes/on/1 与 false/no/off/0，其它算非法", () => {
  const on = parseSkillDocument(doc("a", "d", "disable-model-invocation: yes\n"));
  assert.equal(on.modelInvocable, false);
  const off = parseSkillDocument(doc("a", "d", "user-invocable: OFF\n"));
  assert.equal(off.userInvocable, false);
  const one = parseSkillDocument(doc("a", "d", "disable-model-invocation: 1\n"));
  assert.equal(one.modelInvocable, false);
  const zero = parseSkillDocument(doc("a", "d", "user-invocable: 0\n"));
  assert.equal(zero.userInvocable, false);
  // 非法值必须报错，不能静默当 true
  assert.deepEqual(parseSkillDocument(doc("a", "d", "disable-model-invocation: maybe\n")), {
    ok: false,
    error: "disable-model-invocation must be a boolean (true/false)",
  });
  assert.deepEqual(parseSkillDocument(doc("a", "d", "user-invocable: 2\n")), {
    ok: false,
    error: "user-invocable must be a boolean (true/false)",
  });
});

test("description 的四种写法：块标量 |、折叠 >、单双引号、行内注释", () => {
  const pipe = parseSkillDocument("---\nname: a\ndescription: |\n  第一行\n  第二行\n---\n");
  assert.equal(pipe.description, "第一行 第二行");
  const fold = parseSkillDocument("---\nname: a\ndescription: >-\n  第一行\n  第二行\n---\n");
  assert.equal(fold.description, "第一行 第二行");
  const dq = parseSkillDocument('---\nname: a\ndescription: "带: 冒号的描述"\n---\n');
  assert.equal(dq.description, "带: 冒号的描述");
  const sq = parseSkillDocument("---\nname: a\ndescription: 'single quoted'\n---\n");
  assert.equal(sq.description, "single quoted");
  const comment = parseSkillDocument("---\nname: a\ndescription: 真描述 # 这是注释\n---\n");
  assert.equal(comment.description, "真描述");
});

test("双引号描述走 JSON.parse，转义字符要真解开（不能只剥两边的引号）", () => {
  // YAML 双引号串里 `\"` 是引号本身、`\n` 是换行。只 slice(1,-1) 会把反斜杠原样留在描述里，
  // 面板上就显示成 `带 \"引号\" 的描述`。
  const escaped = parseSkillDocument('---\nname: a\ndescription: "带 \\"引号\\" 的描述"\n---\n');
  assert.equal(escaped.description, '带 "引号" 的描述');
  const newline = parseSkillDocument('---\nname: a\ndescription: "第一行\\n第二行"\n---\n');
  assert.equal(newline.description.includes("\\n"), false);
  // 单引号串按 YAML 语义不处理转义，只剥引号
  const single = parseSkillDocument("---\nname: a\ndescription: 'it''s'\n---\n");
  assert.equal(single.description, "it''s");
});

test("两个开关后面跟行内注释也要能读出来", () => {
  // 不剥 ` #` 的话 norm 会变成 `true # 注释`，落进 invalid 分支 → 整篇文档被判非法。
  const model = parseSkillDocument(doc("a", "d", "disable-model-invocation: true # 模型别自动用\n"));
  assert.equal(model.ok, true);
  assert.equal(model.modelInvocable, false);
  const user = parseSkillDocument(doc("a", "d", "user-invocable: no # 只能模型用\n"));
  assert.equal(user.ok, true);
  assert.equal(user.userInvocable, false);
});

test("块标量的缩进指示与 chomp：|2 从第 2 层开始，|- 不补换行，>+ 保留", () => {
  const indented = parseSkillDocument("---\nname: a\ndescription: |2\n    深一层\n---\n");
  assert.equal(indented.description, "深一层");
  const strip = parseSkillDocument("---\nname: a\ndescription: |-\n  keep\n---\n");
  assert.equal(strip.description, "keep");
  const keep = parseSkillDocument("---\nname: a\ndescription: |+\n  keep\n---\n");
  assert.equal(keep.description, "keep");
  // 空块标量 → 空串 → 触发「描述必填」
  const empty = parseSkillDocument("---\nname: a\ndescription: |\n---\n");
  assert.equal(empty.ok, false);
});

test("块标量里 `|` 与 `>` 的差别在本模块里被压平了（现状锁定）", () => {
  // 两种样式只在「压成单行之前」不同：`|` 用换行连、`>` 用空格连。
  // 但 blockScalarValue 最后统一 `replace(/\s+/g, " ").trim()`，换行与空格都变一个空格，
  // 所以同一份正文写成 `|` 还是 `>` 读出来**完全一样**。把 `if (style === "|")`
  // 改成 `if (true)` 在外部观测不到 —— 这不是测试洞，是这个实现的有意结果
  // （上游面板按单行描述渲染）。写成断言是为了让将来想「保留换行」的人先看到这里。
  const body = "第一行\n  第二行";
  const pipe = parseSkillDocument(`---\nname: a\ndescription: |\n  ${body}\n---\n`);
  const fold = parseSkillDocument(`---\nname: a\ndescription: >\n  ${body}\n---\n`);
  assert.equal(pipe.description, "第一行 第二行");
  assert.equal(fold.description, pipe.description);
});

test("块标量的缩进指示真的决定切几层：后续行缩进比首行浅时要留下", () => {
  // 首行缩进 4、第二行缩进 2。写 `|2` 时 blockIndent = 0 + 2，
  // 两行都留下（第二行剩 0 个前导空格）→ "深 浅"。
  // 不认 indentHint 时会拿首行的 4 当 blockIndent，第二行 2 < 4 被截断 → 只剩 "深"。
  const hinted = parseSkillDocument("---\nname: a\ndescription: |2\n    深\n  浅\n---\n");
  assert.equal(hinted.description, "深 浅");
  // 不写指示时以首行为准，第二行更浅就断掉
  const plain = parseSkillDocument("---\nname: a\ndescription: |\n    深\n  浅\n---\n");
  assert.equal(plain.description, "深");
});

// ---------------------------------------------------------------- 渲染与合并

test("renderSkillDocument 生成标准 frontmatter，描述为空时退回 id", () => {
  // 带空格的描述会被 yamlScalar 加双引号（空格不在「安全字符」白名单里），
  // 这是有意的：YAML 里裸的 `a b` 读回来会丢空格或撞上行内注释。
  const out = renderSkillDocument("code-review", "review code", "正文");
  assert.equal(out, '---\nname: code-review\ndescription: "review code"\n---\n\n正文');
  // 纯字母数字的描述不加引号
  const plain = renderSkillDocument("code-review", "review", "正文");
  assert.equal(plain, "---\nname: code-review\ndescription: review\n---\n\n正文");
  const fallback = renderSkillDocument("code-review", "  ", "正文");
  assert.equal(fallback, "---\nname: code-review\ndescription: code-review\n---\n\n正文");
});

test("renderSkillDocument 对需要转义的描述加引号，并把描述截到 500 字", () => {
  const quoted = renderSkillDocument("a", "含: 冒号", "");
  assert.equal(quoted.includes('description: "含: 冒号"'), true);
  const long = renderSkillDocument("a", "字".repeat(600), "");
  const parsed = parseSkillDocument(long);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.description.length, 500);
});

test("renderSkillDocument 剥 BOM，且已有 frontmatter 的输入只取正文", () => {
  const fromFull = renderSkillDocument("a", "d", doc("old", "old desc"));
  assert.equal(fromFull, "---\nname: a\ndescription: d\n---\n\n正文\n");
  // BOM 必须真的被剥掉 —— 只断言 endsWith 抓不到，BOM 在开头，endsWith 永远成立
  const bom = renderSkillDocument("a", "d", "\uFEFF裸正文");
  assert.equal(bom.includes("\uFEFF"), false, "落盘文件不能带 BOM");
  assert.equal(bom.endsWith("裸正文"), true);
  // 非法 id 直接抛，不能生成一个宿主永远查不到的文件
  assert.throws(() => renderSkillDocument("Code_Review", "d", ""), /invalid skill name/);
});

test("mergeSkillDocument 原地替换 name 与 description，不是前插第二份", () => {
  const merged = mergeSkillDocument("code-review", "新的描述", doc("old", "old"));
  const head = merged.slice(4, merged.indexOf("\n---"));
  // 只追加不替换的话这里会有两行 name: / description:
  assert.equal(head.split("\n").filter((l) => l.startsWith("name:")).length, 1);
  assert.equal(head.split("\n").filter((l) => l.startsWith("description:")).length, 1);
});

test("mergeSkillDocument 只改 name 与 description，其余 frontmatter 字段原样保留", () => {
  const raw = "---\nname: old\ndescription: old\nwhenToUse: 当用户要审代码\nuser-invocable: false\n---\n\n正文\n";
  const merged = mergeSkillDocument("code-review", "新的描述", raw);
  const parsed = parseSkillDocument(merged);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.name, "code-review");
  assert.equal(parsed.description, "新的描述");
  assert.equal(parsed.whenToUse, "当用户要审代码");
  assert.equal(parsed.userInvocable, false);
  assert.equal(parsed.body, "\n正文\n");
});

test("mergeSkillDocument 遇到不是合法文档的输入就退化成 render，描述为空时沿用原文的", () => {
  const merged = mergeSkillDocument("a", "d", "完全不是 frontmatter");
  assert.equal(merged, "---\nname: a\ndescription: d\n---\n\n完全不是 frontmatter");
  const keep = mergeSkillDocument("a", "", doc("old", "原文描述"));
  assert.equal(parseSkillDocument(keep).description, "原文描述");
});

// ---------------------------------------------------------------- 读

test("readSkill 先查 bundle、再查 flat，都按 kind 报出来", async () => {
  const h = home("read");
  writeBundle(h, "bundled", doc("bundled", "来自 bundle"));
  const a = await readSkill(h, "bundled");
  assert.equal(a.kind, "bundle");
  assert.equal(a.path, skillBundleFile(h, "bundled"));
  assert.equal(a.description, "来自 bundle");
  assert.equal(a.valid, true);
  assert.equal(a.size, Buffer.byteLength(doc("bundled", "来自 bundle"), "utf8"));

  writeFlat(h, "flatty.md", doc("flatty", "来自 flat"));
  const b = await readSkill(h, "flatty");
  assert.equal(b.kind, "flat");
  assert.equal(b.path, skillFlatFile(h, "flatty"));
});

test("readSkill 的同名优先顺序：bundle 赢 flat（两处都有时）", async () => {
  const h = home("read-prio");
  writeBundle(h, "dup", doc("dup", "bundle 版"));
  writeFlat(h, "dup.md", doc("dup", "flat 版"));
  const found = await readSkill(h, "dup");
  assert.equal(found.kind, "bundle");
  assert.equal(found.description, "bundle 版");
});

test("readSkill 目录名与 frontmatter 名字不同时，两个名字都能查到同一个文件", async () => {
  const h = home("read-scan");
  // 目录叫 dir-name，文档里写的是 real-name
  writeBundle(h, "dir-name", doc("real-name", "扫出来的"));
  // 按文档里的名字查：靠扫目录找到
  const byDoc = await readSkill(h, "real-name");
  assert.equal(byDoc.description, "扫出来的");
  assert.equal(byDoc.path, skillBundleFile(h, "dir-name"));
  // 按目录名查：第一步直接命中 <id>/SKILL.md，**不校验 frontmatter 里的 name**
  // —— 现状锁定：这时返回的 id 是请求的 id，不是文档里的名字。
  const byDir = await readSkill(h, "dir-name");
  assert.equal(byDir.id, "dir-name");
  assert.equal(byDir.path, skillBundleFile(h, "dir-name"));
  assert.equal(byDir.description, "扫出来的");
});

test("readSkill 找不到回 null，非法名字抛错，目录不存在也回 null", async () => {
  const h = home("read-miss");
  assert.equal(await readSkill(h, "nothing"), null);
  // 空名字也走「非法」这条，不是回 null —— 面板传空串要能立刻报错
  await assert.rejects(() => readSkill(h, ""), /invalid skill name: $/);
  await assert.rejects(() => readSkill(h, "Bad_Name"), /invalid skill name: Bad_Name/);
  const empty = home("read-empty");
  fs.mkdirSync(skillsDir(empty), { recursive: true });
  assert.equal(await readSkill(empty, "nothing"), null);
});

test("readSkill 对坏文档如实报 valid:false 与 error，不假装读到了", async () => {
  const h = home("read-bad");
  writeBundle(h, "broken", "---\nname: Broken\ndescription: x\n---\n");
  const found = await readSkill(h, "broken");
  assert.equal(found.valid, false);
  assert.match(found.error, /kebab-case/);
  assert.equal(found.description, "");
  assert.equal(found.modelInvocable, false);
  assert.equal(found.userInvocable, false);
});

// ---------------------------------------------------------------- 列

test("listSkills 按名字排序，bundle 与 flat 混排，.system 与 SKILL.md 跳过", async () => {
  const h = home("list");
  writeBundle(h, "zeta", doc("zeta", "z"));
  writeFlat(h, "alpha.md", doc("alpha", "a"));
  fs.mkdirSync(path.join(skillsDir(h), ".system"), { recursive: true });
  fs.writeFileSync(path.join(skillsDir(h), ".system", "SKILL.md"), doc("hidden", "h"));
  fs.writeFileSync(path.join(skillsDir(h), "SKILL.md"), doc("root", "r"));
  fs.writeFileSync(path.join(skillsDir(h), "notes.txt"), "not a skill");
  const listed = await listSkills(h);
  assert.deepEqual(listed.map((s) => s.id), ["alpha", "zeta"]);
  assert.deepEqual(listed.map((s) => s.kind), ["flat", "bundle"]);
});

test("listSkills 同 id 只出现一次，bundle 排在 flat 前所以 bundle 赢", async () => {
  const h = home("list-dup");
  writeBundle(h, "same", doc("same", "bundle 版"));
  writeFlat(h, "same.md", doc("same", "flat 版"));
  const listed = await listSkills(h);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, "bundle");
  assert.equal(listed[0].description, "bundle 版");
});

test("listSkills 两个目录的 frontmatter 同名时只收第一个（目录分支也要去重）", async () => {
  const h = home("list-dup-dir");
  // 两个不同目录名、文档里写同一个 name —— 面板上必须只出现一条，
  // 否则用户删掉一条，另一条还在，看上去「删不掉」。
  writeBundle(h, "aaa", doc("same-name", "第一个"));
  writeBundle(h, "bbb", doc("same-name", "第二个"));
  const listed = await listSkills(h);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "same-name");
  assert.equal(listed[0].description, "第一个");
});

test("listSkills 的排序靠源码形状钉住（本机 NTFS 的 readdir 本身就是字母序，测不出差别）", () => {
  // 去掉 sort 之后，这台机器上结果一模一样：NTFS 的 readdir 按名字升序返回。
  // 但在 ext4 / APFS 上顺序是目录项哈希顺序，面板列表会随机跳。所以只能读源码钉。
  assert.match(SRC, /for \(const entry of entries\.sort\(\(a, b\) => a\.name\.localeCompare\(b\.name\)\)\) \{/);
});

test("listSkills 对坏文档用目录名 / 文件名兜底当 id，全坏就不列", async () => {
  const h = home("list-bad");
  writeBundle(h, "dir-fallback", "没有 frontmatter");
  writeBundle(h, "Bad_Dir", "没有 frontmatter");
  writeFlat(h, "flat-fallback.md", "也没有 frontmatter");
  const listed = await listSkills(h);
  const ids = listed.map((s) => s.id);
  assert.deepEqual(ids.includes("dir-fallback"), true);
  assert.deepEqual(ids.includes("flat-fallback"), true);
  // 目录名本身不是 kebab-case，又解析不出名字 → 跳过
  assert.deepEqual(ids.includes("Bad_Dir"), false);
  // 兜底出来的条目 valid 仍是 false，面板要能标红
  assert.equal(listed.find((s) => s.id === "dir-fallback").valid, false);
});

test("listSkills 目录不存在回空数组，不抛", async () => {
  assert.deepEqual(await listSkills(home("list-none")), []);
});

// ---------------------------------------------------------------- 写

test("saveSkill 新建 bundle：落盘内容带标准 frontmatter，返回 size 与 backup", async () => {
  const h = home("save");
  const out = await saveSkill(h, "code-review", doc("code-review", "review code"), "");
  assert.equal(out.id, "code-review");
  assert.equal(out.path, skillBundleFile(h, "code-review"));
  assert.equal(out.backup, null);
  assert.equal(out.description, "review code");
  assert.equal(out.size, Buffer.byteLength(out.content, "utf8"));
  assert.equal(fs.readFileSync(out.path, "utf8"), out.content);
  // 落盘形态与 readSkill 读回来的一致
  const read = await readSkill(h, "code-review");
  assert.equal(read.kind, "bundle");
  assert.equal(read.description, "review code");
});

test("saveSkill 覆盖已有 bundle 时先备份，备份里是旧内容", async () => {
  const h = home("save-bk");
  await saveSkill(h, "s", doc("s", "第一版"), "");
  const again = await saveSkill(h, "s", doc("s", "第二版"), "");
  assert.ok(again.backup, "覆盖必须产生备份");
  assert.equal(path.dirname(again.backup), skillBackupDir(h));
  const backedUp = fs.readFileSync(path.join(again.backup, "s", "SKILL.md"), "utf8");
  assert.equal(parseSkillDocument(backedUp).description, "第一版");
  // 新内容生效
  assert.equal((await readSkill(h, "s")).description, "第二版");
});

test("saveSkill 覆盖已有 flat 时，备份里是 <id>.md", async () => {
  const h = home("save-bk-flat");
  writeFlat(h, "s.md", doc("s", "flat 旧版"));
  const out = await saveSkill(h, "s", doc("s", "bundle 新版"), "");
  assert.ok(out.backup);
  assert.equal(fs.readFileSync(path.join(out.backup, "s.md"), "utf8").includes("flat 旧版"), true);
  // flat 已被删掉，只剩 bundle
  assert.equal(fs.existsSync(skillFlatFile(h, "s")), false);
  assert.equal((await readSkill(h, "s")).kind, "bundle");
});

test("saveSkill 拒绝非法名字与超 256KB 的文档", async () => {
  const h = home("save-reject");
  await assert.rejects(() => saveSkill(h, "Bad_Name", doc("Bad_Name", "x"), ""), /invalid skill name/);
  const huge = `---\nname: big\ndescription: d\n---\n\n${"x".repeat(300 * 1024)}`;
  await assert.rejects(() => saveSkill(h, "big", huge, ""), /skill too large \(max 256KB\)/);
  // 拒绝之后不能留下半个文件
  assert.equal(fs.existsSync(skillBundleFile(h, "big")), false);
});

test("saveSkill 的显式描述赢过文档里的，空描述时用文档里的", async () => {
  const h = home("save-desc");
  const a = await saveSkill(h, "s", doc("s", "文档描述"), "面板描述");
  assert.equal(a.description, "面板描述");
  const b = await saveSkill(h, "s", doc("s", "文档描述"), "   ");
  assert.equal(b.description, "文档描述");
});

test("saveSkill 落盘前还要再解析一次成品（源码形状钉住，构造不出失败输入）", () => {
  // mergeSkillDocument 的输出总是合法的：名字由调用方保证 kebab-case、描述走
  // yamlScalar 转义、正文原样保留。所以 `if (!check.ok) throw` 这一层在当前实现下
  // 构造不出能触发的输入 —— 它是「将来有人改 merge 的拼串方式」时的兜底。
  // 唯一能钉的办法是读源码：删掉这一行外部行为不变，但下次改坏拼串就会静默落盘一个
  // 宿主读不懂的 SKILL.md（面板显示已保存，模型永远看不到这个技能）。
  assert.match(SRC, /const check = parseSkillDocument\(document\);\r?\n  if \(!check\.ok\) throw new Error\(check\.error\);/);
});

test("deleteSkill 删掉 bundle 并留下备份，找不到时抛错", async () => {
  const h = home("del");
  await saveSkill(h, "s", doc("s", "要删的"), "");
  const out = await deleteSkill(h, "s");
  assert.equal(out.id, "s");
  assert.ok(out.backup);
  assert.equal(fs.existsSync(skillBundleDir(h, "s")), false);
  assert.equal(fs.readFileSync(path.join(out.backup, "s", "SKILL.md"), "utf8").includes("要删的"), true);
  await assert.rejects(() => deleteSkill(h, "s"), /skill not found: s/);
  await assert.rejects(() => deleteSkill(h, "Bad_Name"), /invalid skill name/);
});

// ---------------------------------------------------------------- 找根

test("findSkillRoots 把含 SKILL.md 的目录当根并停止下钻，扁平文件单独收集", async () => {
  const h = home("roots");
  const top = path.join(h, "pack");
  fs.mkdirSync(path.join(top, "one", "nested"), { recursive: true });
  fs.writeFileSync(path.join(top, "one", "SKILL.md"), doc("one", "d"));
  // one 里还有子目录，但 one 已被当根，不再往下
  fs.writeFileSync(path.join(top, "one", "nested", "SKILL.md"), doc("deep", "d"));
  fs.writeFileSync(path.join(top, "flat.md"), doc("flat", "d"));
  fs.writeFileSync(path.join(top, "bad.md"), "没有 frontmatter");
  const found = await findSkillRoots(top);
  assert.deepEqual(found.dirs.map((d) => path.basename(d)), ["one"]);
  assert.deepEqual(found.flats.map((f) => path.basename(f)), ["flat.md"]);
});

test("importFromPath 拒绝「软链到 skills 里」的源（只用 resolve 挡不住）", async () => {
  const h = home("imp-sym");
  const inner = writeBundle(h, "linked", doc("linked", "d"));
  const link = path.join(h, "outside-link");
  let canLink = true;
  try {
    fs.symlinkSync(inner, link, "dir");
  } catch {
    canLink = false;
  }
  if (!canLink) {
    // 没有建链接权限的机器上只能靠源码形状钉：pathsOverlap 必须先 realpath。
    assert.match(SRC, /fs\.realpathSync\.native \? fs\.realpathSync\.native\(abs\) : fs\.realpathSync\(abs\)/);
    return;
  }
  // link 的 resolve 结果在 skills 外面，但 realpath 落回 skills/linked 里面 ——
  // 只 resolve 的话这里会被放行，随后「先删后拷」把 skills/linked 删空。
  await assert.rejects(
    () => importFromPath(h, link),
    /Cannot import from \$DSH_HOME\/skills itself/,
  );
  assert.equal(fs.existsSync(path.join(inner, "SKILL.md")), true);
});

test("findSkillRoots 最多下钻 4 层，第 5 层的 SKILL.md 不再找", async () => {
  const h = home("roots-depth");
  const top = path.join(h, "deep");
  const at4 = path.join(top, "a", "b", "c", "d");
  const at5 = path.join(at4, "e");
  fs.mkdirSync(at5, { recursive: true });
  fs.writeFileSync(path.join(at5, "SKILL.md"), doc("too-deep", "d"));
  const shallow = await findSkillRoots(top);
  assert.deepEqual(shallow.dirs, []);
  // 把 SKILL.md 挪到第 4 层就能找到
  fs.writeFileSync(path.join(at4, "SKILL.md"), doc("just-right", "d"));
  const found = await findSkillRoots(top);
  assert.deepEqual(found.dirs.map((d) => path.basename(d)), ["d"]);
});

test("findSkillRoots 命中 SKILL.md 后不再往下找，深层同名技能不会被收进来", async () => {
  const h = home("roots-stop");
  const top = path.join(h, "stop");
  fs.mkdirSync(path.join(top, "one", "nested"), { recursive: true });
  fs.writeFileSync(path.join(top, "one", "SKILL.md"), doc("one", "d"));
  fs.writeFileSync(path.join(top, "one", "nested", "SKILL.md"), doc("deep", "d"));
  const found = await findSkillRoots(top);
  assert.equal(found.dirs.length, 1);
  assert.equal(found.dirs[0], path.join(top, "one"));
});

test("findSkillRoots 对不存在的目录回空结果，不抛", async () => {
  const found = await findSkillRoots(path.join(home("roots-none"), "nope"));
  assert.deepEqual(found, { dirs: [], flats: [] });
});

// ---------------------------------------------------------------- 导入

test("importFromPath 从目录导入 bundle，并改写 frontmatter 的名字", async () => {
  const h = home("imp-dir");
  const src = path.join(h, "src", "my-skill");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "SKILL.md"), doc("renamed", "来自目录"));
  fs.writeFileSync(path.join(src, "notes.txt"), "附带文件");
  const out = await importFromPath(h, src);
  assert.equal(out.imported.length, 1);
  assert.equal(out.imported[0].id, "renamed");
  assert.equal(out.imported[0].path, "$DSH_HOME/skills/renamed/SKILL.md");
  // 附带文件一起搬进来
  assert.equal(fs.existsSync(path.join(skillBundleDir(h, "renamed"), "notes.txt")), true);
});

test("importFromPath 从单个 .md 导入 flat→bundle，非法文档直接报错", async () => {
  const h = home("imp-md");
  const fp = path.join(h, "src", "single.md");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, doc("single", "单个文件"));
  const out = await importFromPath(h, fp);
  assert.equal(out.imported[0].id, "single");
  assert.equal((await readSkill(h, "single")).description, "单个文件");

  const bad = path.join(h, "src", "broken.md");
  fs.writeFileSync(bad, "没有 frontmatter");
  await assert.rejects(() => importFromPath(h, bad), /Missing YAML frontmatter/);
});

test("importFromPath 拒绝从 skills 目录自己导入（先删后拷会把自己删空）", async () => {
  const h = home("imp-self");
  const inner = writeBundle(h, "self", doc("self", "d"));
  await assert.rejects(
    () => importFromPath(h, inner),
    /Cannot import from \$DSH_HOME\/skills itself/,
  );
  await assert.rejects(
    () => importFromPath(h, skillsDir(h)),
    /Cannot import from \$DSH_HOME\/skills itself/,
  );
  // 原文件还在
  assert.equal(fs.existsSync(path.join(inner, "SKILL.md")), true);
});

test("importFileTree 落一棵文件树再导入，base64 与 utf8 都认", async () => {
  const h = home("imp-tree");
  const out = await importFileTree(h, [
    { path: "pack/SKILL.md", content: doc("tree-skill", "来自文件树") },
    { path: "pack/extra.bin", content: Buffer.from([1, 2, 3]).toString("base64"), encoding: "base64" },
  ]);
  assert.equal(out.imported.length, 1);
  assert.equal(out.imported[0].id, "tree-skill");
  assert.deepEqual(
    [...fs.readFileSync(path.join(skillBundleDir(h, "tree-skill"), "extra.bin"))],
    [1, 2, 3],
  );
});

test("importFileTree 拒绝空数组、过多文件、越界路径与超大内容", async () => {
  const h = home("imp-tree-bad");
  await assert.rejects(() => importFileTree(h, []), /The folder is empty/);
  await assert.rejects(() => importFileTree(h, null), /The folder is empty/);
  const many = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.md`, content: "x" }));
  await assert.rejects(() => importFileTree(h, many), /Too many files in the folder/);
  await assert.rejects(
    () => importFileTree(h, [{ path: "../escape/SKILL.md", content: doc("x", "d") }]),
    /Invalid folder path/,
  );
  // 盘符绝对路径要被挡（浏览器上传不可能给出这种名字）
  await assert.rejects(
    () => importFileTree(h, [{ path: "C:/Windows/evil.md", content: doc("x", "d") }]),
    /Invalid folder path/,
  );
  await assert.rejects(
    () => importFileTree(h, [{ path: "big.md", content: "x".repeat(13 * 1024 * 1024) }]),
    /File is too large/,
  );
  // 现状锁定：单个前导斜杠会被 `replace(/^\\/+/,"")` 剥成相对路径、**不报错**。
  // 落点仍在临时目录内（assertInside 兜底），所以不构成越界，只是名字被改写。
  const ok = await importFileTree(h, [{ path: "/lead/SKILL.md", content: doc("lead-strip", "d") }]);
  assert.equal(ok.imported[0].id, "lead-strip");
});

test("importArchive 拒绝空包与超过 12MB 的包", async () => {
  const h = home("imp-zip-bad");
  await assert.rejects(() => importArchive(h, Buffer.alloc(0)), /The archive is empty/);
  await assert.rejects(
    () => importArchive(h, Buffer.alloc(13 * 1024 * 1024)),
    /The archive is too large \(max 12MB\)/,
  );
});

test("importArchive 正常 zip：解包、找到 SKILL.md、装成 bundle", async () => {
  const h = home("imp-zip");
  const buf = buildZip([{ name: "pack/SKILL.md", data: doc("zipped", "来自压缩包") }]);
  const out = await importArchive(h, buf, "zipped.zip");
  assert.equal(out.imported.length, 1);
  assert.equal(out.imported[0].id, "zipped");
  assert.equal(out.imported[0].path, "$DSH_HOME/skills/zipped/SKILL.md");
  assert.equal((await readSkill(h, "zipped")).description, "来自压缩包");
});

test("importArchive 拒绝带 .. 的条目，一个文件都不落盘", async () => {
  const h = home("imp-zip-slip");
  const buf = buildZip([
    { name: "pack/SKILL.md", data: doc("ok", "正常") },
    { name: "../escape.txt", data: "evil" },
  ]);
  await assert.rejects(() => importArchive(h, buf, "slip.zip"), /Invalid archive path/);
  assert.equal(fs.existsSync(path.join(h, "escape.txt")), false);
  assert.equal(fs.existsSync(skillBundleDir(h, "ok")), false);
});

test("importFromPath 从目录导入时，目录名与文档名不同就按文档名建目录（名字以 frontmatter 为准）", async () => {
  const h = home("imp-rename");
  const src = path.join(h, "src", "my-skill");
  fs.mkdirSync(src, { recursive: true });
  // 目录叫 my-skill，文档里写 renamed —— 落点是 renamed，不是 my-skill
  fs.writeFileSync(path.join(src, "SKILL.md"), doc("renamed", "来自目录"));
  const out = await importFromPath(h, src);
  assert.equal(out.imported[0].id, "renamed");
  assert.equal(fs.existsSync(skillBundleDir(h, "renamed")), true);
  assert.equal(fs.existsSync(skillBundleDir(h, "my-skill")), false);
  // 落盘文档里的 name 也已经是 renamed（copyDir 搬过来时就是）
  assert.equal(parseSkillDocument(fs.readFileSync(skillBundleFile(h, "renamed"), "utf8")).name, "renamed");
});

test("importFromPath 导入带坏 frontmatter 的目录时，目录名兜底但文档不被改写（现状锁定）", async () => {
  const h = home("imp-badname");
  const src = path.join(h, "src", "bad-name-skill");
  fs.mkdirSync(src, { recursive: true });
  // 名字不是 kebab-case，但确实带 frontmatter
  fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: Bad_Name\ndescription: 坏名字\n---\n\n正文\n");
  const out = await importFromPath(h, src);
  // id 从目录名兜底而来
  assert.equal(out.imported[0].id, "bad-name-skill");
  // 现状锁定：文档以 --- 开头 → 既不改名也不重渲染 → 落盘仍是 name: Bad_Name，
  // 于是 readSkill 报 valid:false。这是刻意的「不猜用户意图」，面板会标红让人改。
  const read = await readSkill(h, "bad-name-skill");
  assert.equal(read.valid, false);
  assert.match(read.error, /kebab-case/);
  assert.equal(read.content.includes("Bad_Name"), true);
});

test("importFromPath 导入没有 frontmatter 的目录时，用 renderSkillDocument 补一份（目录名当 id 与描述）", async () => {
  const h = home("imp-nofm");
  const src = path.join(h, "src", "plain-notes");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "SKILL.md"), "只有正文，没有 frontmatter\n");
  const out = await importFromPath(h, src);
  assert.equal(out.imported[0].id, "plain-notes");
  const read = await readSkill(h, "plain-notes");
  assert.equal(read.valid, true);
  assert.equal(read.description, "plain-notes");
  assert.equal(read.content.includes("只有正文"), true);
});

test("importArchive 卡的是解包后的总大小（50MB），不是压缩包大小", async () => {
  const h = home("imp-zip-bomb");
  // 60MB 的零字节 deflate 后只有几十 KB —— 压缩包这一级（12MB）完全过得去，
  // 必须靠解包之后累计 size 才能拦住。拦不住的话一次导入就能把磁盘写满。
  const big = Buffer.alloc(60 * 1024 * 1024);
  const buf = buildZip([
    { name: "pack/SKILL.md", data: doc("bomb", "d") },
    { name: "pack/blob.bin", data: big.toString("utf8"), method: 8 },
  ]);
  assert.ok(buf.length < 12 * 1024 * 1024, "压缩包本身必须小于 12MB，否则测的是另一道守卫");
  await assert.rejects(() => importArchive(h, buf, "bomb.zip"), /exceeds 50MB/);
  assert.equal(fs.existsSync(skillBundleDir(h, "bomb")), false);
});

test("installBundleDir 的两道守卫在当前实现下走不到（源码形状钉住）", () => {
  // ① `if (pathsOverlap(srcDir, dest))` —— 前面 assertImportSourceOutsideSkills 已经
  //    要求 srcDir 在 skills 之外，而能「覆盖 dest」的 srcDir 只能是 skills 的祖先
  //    （例如整个 $DSH_HOME），那种情况第一道守卫先抛了。所以这条永远进不去。
  // ② `if (parsed.ok && parsed.name !== id)` —— id 就是 `parsed.ok ? parsed.name : ...`，
  //    parsed.ok 为真时 id 恒等于 parsed.name，条件恒假。**这是死分支**。
  // 两条都留着是对的纵深防御，但不能拿它们当「已测试」。删掉任何一条外部行为都不变，
  // 所以只能用源码形状钉住它们还在，免得将来改 assertImportSourceOutsideSkills 时失去兜底。
  assert.match(SRC, /if \(pathsOverlap\(srcDir, dest\)\) \{/);
  assert.match(SRC, /if \(parsed\.ok && parsed\.name !== id\) \{/);
});

test("importArchive 拒绝条目数超过 200 的包（否则一次导入能把面板卡死）", async () => {
  const h = home("imp-zip-many");
  const entries = [{ name: "pack/SKILL.md", data: doc("many", "d") }];
  for (let i = 0; i < 201; i += 1) entries.push({ name: `pack/f${i}.txt`, data: "x" });
  await assert.rejects(() => importArchive(h, buildZip(entries), "many.zip"), /Too many files in the archive/);
  assert.equal(fs.existsSync(skillBundleDir(h, "many")), false);
});

test("importArchive 对没有 SKILL.md 的包报「找不到技能」，不静默成功", async () => {
  const h = home("imp-zip-empty");
  const buf = buildZip([{ name: "readme.txt", data: "没有技能" }]);
  await assert.rejects(() => importArchive(h, buf, "empty.zip"), /No SKILL.md or valid skill file found/);
});

test("skillsStatus 只暴露 $DSH_HOME 下的路径，字段齐但不多带 content", async () => {
  const h = home("status");
  await saveSkill(h, "code-review", doc("code-review", "review code"), "");
  const out = await skillsStatus(h);
  assert.equal(out.skills_dir, "$DSH_HOME/skills");
  assert.equal(out.skills.length, 1);
  const item = out.skills[0];
  assert.equal(item.id, "code-review");
  assert.equal(item.description, "review code");
  assert.equal(item.kind, "bundle");
  assert.equal(item.valid, true);
  assert.equal(item.error, null);
  assert.equal(item.path, "$DSH_HOME/skills/code-review/SKILL.md");
  assert.equal("content" in item, false);
  assert.equal("head" in item, false);
});
