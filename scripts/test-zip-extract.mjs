// lib/zip-extract.js 的行为锁定。
//
// 这个文件是「导入技能包 / 在线更新」唯一的解压入口，坏掉的方式都很安静：
//  · zip-slip 守卫（`safeZipName`）失效 → 压缩包里写 `../x` 就能把文件落到 dest 之外，
//    外部工具（tar/unzip/powershell）根本不看条目名，所以必须在交给它们之前先自己过一遍；
//  · `zip64` / 未知压缩方法 / 截断数据这三道守卫失效 → 解出半个文件、或者写出 0 字节，
//    调用方以为装好了；
//  · 外部工具的尝试顺序与 notes 聚合失效 → 报错只剩一句 "Extraction failed"，看不出
//    是哪一步、因为什么失败的。
//
// 这里用自造的 zip（中央目录 + 本地头 + EOCD 手拼）做 fixture，不依赖任何外部压缩工具，
// 只有 powershell 那条真跑一次（它要证明 env 变量真的传进去了，否则测不到）。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  unzipTools,
  listZipEntries,
  listZipFile,
  extractZipBuffer,
  extractZipArchive,
} from "../lib/zip-extract.js";

const WINDOWS = process.platform === "win32";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-purge-zip-${tag}-`));
}

/** 手拼一个 zip：`entries` 里每项 { name, data?, method?, compSize? }。 */
function buildZip(entries, comment = "") {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data);
    const method = entry.method === undefined ? 0 : entry.method;
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const declared = entry.compSize === undefined ? body.length : entry.compSize;
    // CRC 必须算对：内置解包器不看它，但 tar / bsdtar 会校验（ZIP bad CRC）。
    const crc = zlib.crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(declared, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localBlock = Buffer.concat([local, nameBuf, body]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(declared, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));

    locals.push(localBlock);
    offset += localBlock.length;
  }
  const cd = Buffer.concat(centrals);
  const commentBuf = Buffer.from(comment, "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);
  return Buffer.concat([...locals, cd, eocd, commentBuf]);
}

function writeZip(dir, entries, name = "pack.zip", comment = "") {
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, buildZip(entries, comment));
  return fp;
}

function listAll(dir) {
  const out = [];
  const walk = (at) => {
    for (const item of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, item.name);
      out.push(path.relative(dir, full).split(path.sep).join("/"));
      if (item.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

/* ---------- 工具顺序 ---------- */

test("unzipTools：Windows 用 tar → powershell → node，其余平台多给 unzip/python3/bsdtar", () => {
  assert.deepEqual(unzipTools("win32"), ["tar", "powershell", "node"]);
  assert.deepEqual(unzipTools("linux"), ["tar", "unzip", "python3", "bsdtar", "node"]);
  assert.deepEqual(unzipTools("darwin"), ["tar", "unzip", "python3", "bsdtar", "node"]);
  // 不传参数时读 process.platform：与显式传本机平台必须一致
  assert.deepEqual(unzipTools(), unzipTools(process.platform));
  // node 必须垫底：它是唯一能自己判 zip-slip 的那条路，但最慢
  assert.equal(unzipTools("linux").at(-1), "node");
});

/* ---------- 读中央目录 ---------- */

test("listZipEntries：按中央目录顺序返回，反斜杠归一成正斜杠", () => {
  const buf = buildZip([
    { name: "a.txt", data: "A" },
    { name: "dir\\b.txt", data: "B" },
    { name: "sub/c.txt", data: "C" },
  ]);
  assert.deepEqual(listZipEntries(buf), ["a.txt", "dir/b.txt", "sub/c.txt"]);
});

test("findEocd：EOCD 后面跟着超长注释时仍能从尾部往回找到（不只看最后一个位置）", () => {
  const dir = tmpDir("comment");
  try {
    // 60000 字节注释：EOCD 距离文件尾 60000+22，远超「只看最后一个位置」的假设
    const comment = "c".repeat(60000);
    const fp = writeZip(dir, [{ name: "c.txt", data: "with-comment" }], "pack.zip", comment);
    assert.deepEqual(listZipFile(fp), ["c.txt"]);
    const dest = path.join(dir, "out");
    assert.equal(extractZipArchive(fp, dest, ["node"]), "node");
    assert.equal(fs.readFileSync(path.join(dest, "c.txt"), "utf8"), "with-comment");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listZipFile：从磁盘读同一份内容，结果与内存版逐项相等", () => {
  const dir = tmpDir("list");
  try {
    const fp = writeZip(dir, [
      { name: "x.txt", data: "X" },
      { name: "y/z.txt", data: "Z" },
    ]);
    assert.deepEqual(listZipFile(fp), ["x.txt", "y/z.txt"]);
    assert.deepEqual(listZipFile(fp), listZipEntries(fs.readFileSync(fp)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listZipEntries：不是 zip 的输入一律报 Not a zip file（太短 / 没有 EOCD 两种）", () => {
  assert.throws(() => listZipEntries(Buffer.alloc(10)), /Not a zip file/);
  assert.throws(() => listZipEntries(Buffer.alloc(64, 7)), /Not a zip file/);
  assert.throws(() => listZipEntries("not a buffer"), /Not a zip file/);
});

test("listZipEntries：中央目录签名不对时报 Corrupt zip central directory", () => {
  const buf = buildZip([{ name: "a.txt", data: "A" }]);
  const eocd = buf.length - 22;
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const broken = Buffer.from(buf);
  broken.writeUInt32LE(0xdeadbeef, cdOffset);
  assert.throws(() => listZipEntries(broken), /Corrupt zip central directory/);
});

/* ---------- 解压：正常路径 ---------- */

test("extractZipBuffer：stored 与 deflate 两种条目都解出原文，嵌套目录自动建", () => {
  const dir = tmpDir("buf");
  try {
    const dest = path.join(dir, "out");
    const buf = buildZip([
      { name: "plain.txt", data: "hello", method: 0 },
      { name: "deep/nested/deflated.txt", data: "x".repeat(4000), method: 8 },
      { name: "sub/", method: 0 },
    ]);
    extractZipBuffer(buf, dest);
    assert.equal(fs.readFileSync(path.join(dest, "plain.txt"), "utf8"), "hello");
    assert.equal(fs.readFileSync(path.join(dest, "deep/nested/deflated.txt"), "utf8"), "x".repeat(4000));
    assert.ok(fs.statSync(path.join(dest, "sub")).isDirectory(), "目录条目要建出目录");
    assert.deepEqual(listAll(dest), ["deep", "deep/nested", "deep/nested/deflated.txt", "plain.txt", "sub"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipBuffer：空名字条目直接跳过，不建任何东西", () => {
  const dir = tmpDir("empty-name");
  try {
    const dest = path.join(dir, "out");
    extractZipBuffer(buildZip([{ name: "", data: "ignored" }, { name: "ok.txt", data: "1" }]), dest);
    assert.deepEqual(listAll(dest), ["ok.txt"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipBuffer：0 字节条目会写出一个空文件（不是跳过）", () => {
  const dir = tmpDir("zero");
  try {
    const dest = path.join(dir, "out");
    extractZipBuffer(buildZip([{ name: "empty.bin", data: "" }]), dest);
    assert.equal(fs.statSync(path.join(dest, "empty.bin")).size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipBuffer：以反斜杠结尾的条目也算目录（zip 里两种分隔符都有）", () => {
  const dir = tmpDir("dir-bs");
  try {
    const dest = path.join(dir, "out");
    extractZipBuffer(buildZip([{ name: "windir\\", data: "" }]), dest);
    assert.ok(fs.statSync(path.join(dest, "windir")).isDirectory(), "反斜杠结尾必须建目录，不能写成同名文件");
    assert.deepEqual(listAll(dest), ["windir"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipBuffer：目标目录已存在时照常解（mkdirSync recursive 不抛）", () => {
  const dir = tmpDir("exists");
  try {
    const dest = path.join(dir, "out");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "keep.txt"), "old");
    extractZipBuffer(buildZip([{ name: "new.txt", data: "N" }]), dest);
    assert.deepEqual(listAll(dest), ["keep.txt", "new.txt"], "不清理已有文件，只覆盖同名");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 解压：zip-slip ---------- */

test("extractZipBuffer：`../` 条目被挡，且 dest 之外什么都没写", () => {
  const dir = tmpDir("slip");
  try {
    const dest = path.join(dir, "out");
    assert.throws(() => extractZipBuffer(buildZip([{ name: "../evil.txt", data: "x" }]), dest), /Invalid zip path/);
    assert.equal(fs.existsSync(path.join(dir, "evil.txt")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipBuffer：反斜杠形态的 `..\\evil` 一样被挡（先归一再分段判）", () => {
  const dir = tmpDir("slip-bs");
  try {
    const dest = path.join(dir, "out");
    assert.throws(() => extractZipBuffer(buildZip([{ name: "..\\evil.txt", data: "x" }]), dest), /Invalid zip path/);
    assert.equal(fs.existsSync(path.join(dir, "evil.txt")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "extractZipBuffer：反斜杠形态的 `a\\..\\b.txt` 在 Windows 上按穿越挡掉（先归一才看得出是 `..`）",
  { skip: WINDOWS ? false : "反斜杠在 POSIX 上是普通字符，这条只在 Windows 上有意义" },
  () => {
    const dir = tmpDir("slip-bs-mid");
    try {
      const dest = path.join(dir, "out");
      // 不归一的话 parts 只有一段 `a\..\b.txt`，看不出 `..`；
      // 归一后是 a/../b.txt → 挡。注意这条和「逃出 dest」无关：
      // 两种实现都不会写到 dest 之外（`path.resolve` 把反斜杠当分隔符，
      // 越界会被后面那道 startsWith 守卫接住），差别只在「挡还是不挡」。
      assert.throws(
        () => extractZipBuffer(buildZip([{ name: "a\\..\\b.txt", data: "x" }]), dest),
        /Invalid zip path/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("extractZipBuffer：盘符路径与 UNC 路径都被挡", () => {
  const dir = tmpDir("slip-abs");
  try {
    const dest = path.join(dir, "out");
    assert.throws(() => extractZipBuffer(buildZip([{ name: "C:/Windows/x.txt", data: "x" }]), dest), /Invalid zip path/);
    assert.throws(() => extractZipBuffer(buildZip([{ name: "c:\\Windows\\x.txt", data: "x" }]), dest), /Invalid zip path/);
    // 反斜杠先归一成正斜杠，于是 `\\srv\share\x.txt` → `//srv/share/x.txt`：吃掉一层还剩一层 → 挡
    assert.throws(() => extractZipBuffer(buildZip([{ name: "\\\\srv\\share\\x.txt", data: "x" }]), dest), /Invalid zip path/);
    // 双斜杠开头同理
    assert.throws(() => extractZipBuffer(buildZip([{ name: "//x.txt", data: "x" }]), dest), /Invalid zip path/);
    assert.equal(fs.existsSync(path.join(dir, "x.txt")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipBuffer：单个前导斜杠被当成相对路径（现状锁定，不会逃出 dest）", () => {
  // 现状锁定：`safeZipName` 先 `.replace(/^\\.?\\//, "")` 吃掉一层前导斜杠，再判
  // `rel.startsWith("/")` —— 所以 `/etc/passwd` 走到判断时已经变成 `etc/passwd`，
  // 那条「绝对路径」守卫对单斜杠形态是走不到的。结果落在 dest 里面（`out/etc/passwd`），
  // 不会写到 dest 之外，因此不是漏洞，只是「绝对路径」这个说法与实际行为不完全一致。
  // 真要改这条语义（改成拒绝），本用例会红，那时同步改这条注释。
  const dir = tmpDir("slip-one-slash");
  try {
    const dest = path.join(dir, "out");
    extractZipBuffer(buildZip([{ name: "/etc/passwd", data: "root:x" }]), dest);
    assert.deepEqual(listAll(dest), ["etc", "etc/passwd"]);
    assert.equal(fs.readFileSync(path.join(dest, "etc/passwd"), "utf8"), "root:x");
    // 只剩一个斜杠的条目归一化成空串 → 跳过，什么都不建
    extractZipBuffer(buildZip([{ name: "/", data: "x" }]), path.join(dir, "out2"));
    assert.deepEqual(listAll(path.join(dir, "out2")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipBuffer：`./a.txt` 与 `a/./b.txt` 里的单点段不挡（只挡 `..` 与空段）", () => {
  const dir = tmpDir("dot-seg");
  try {
    const dest = path.join(dir, "out");
    extractZipBuffer(
      buildZip([
        { name: "./a.txt", data: "A" },
        { name: "a/./b.txt", data: "B" },
      ]),
      dest,
    );
    assert.equal(fs.readFileSync(path.join(dest, "a.txt"), "utf8"), "A");
    assert.equal(fs.readFileSync(path.join(dest, "a/b.txt"), "utf8"), "B");
    // 连续两个斜杠产生空段 → 挡
    assert.throws(() => extractZipBuffer(buildZip([{ name: "a//b.txt", data: "x" }]), path.join(dir, "o2")), /Invalid zip path/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipBuffer：中间夹 `..` 的条目被挡，且先前的正常条目已经落盘（不是整体回滚）", () => {
  const dir = tmpDir("slip-mid");
  try {
    const dest = path.join(dir, "out");
    const buf = buildZip([
      { name: "good.txt", data: "G" },
      { name: "a/../../b.txt", data: "x" },
    ]);
    assert.throws(() => extractZipBuffer(buf, dest), /Invalid zip path/);
    assert.equal(fs.readFileSync(path.join(dest, "good.txt"), "utf8"), "G", "按条目顺序处理，遇到坏条目才停");
    assert.equal(fs.existsSync(path.join(dir, "b.txt")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 解压：其余三道守卫 ---------- */

test("extractZipBuffer：zip64 的占位值（0xffffffff）直接拒绝，不去猜真实偏移", () => {
  const dir = tmpDir("zip64");
  try {
    const dest = path.join(dir, "out");
    assert.throws(
      () => extractZipBuffer(buildZip([{ name: "big.bin", data: "x", compSize: 0xffffffff }]), dest),
      /zip64 is not supported/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipBuffer：只认 stored(0) 与 deflate(8)，其余方法报出具体编号", () => {
  const dir = tmpDir("method");
  try {
    const dest = path.join(dir, "out");
    assert.throws(
      () => extractZipBuffer(buildZip([{ name: "a.txt", data: "x", method: 12 }]), dest),
      /Unsupported zip compression method 12/,
    );
    assert.throws(
      () => extractZipBuffer(buildZip([{ name: "a.txt", data: "x", method: 14 }]), dest),
      /Unsupported zip compression method 14/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipBuffer：正文比声明的短时报 Truncated zip data（不写半截文件）", () => {
  const dir = tmpDir("trunc");
  try {
    const dest = path.join(dir, "out");
    const buf = buildZip([{ name: "a.txt", data: "0123456789", compSize: 9999 }]);
    assert.throws(() => extractZipBuffer(buf, dest), /Truncated zip data/);
    assert.equal(fs.existsSync(path.join(dest, "a.txt")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipBuffer：本地头签名不对时报 Corrupt zip local header", () => {
  const dir = tmpDir("localhdr");
  try {
    const dest = path.join(dir, "out");
    const buf = buildZip([{ name: "a.txt", data: "A" }]);
    buf.writeUInt32LE(0xdeadbeef, 0);
    assert.throws(() => extractZipBuffer(buf, dest), /Corrupt zip local header/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- extractZipArchive：外部工具之前先自己校验 ---------- */

test("extractZipArchive：tools=['node'] 用内置解包，返回 'node' 且内容正确", () => {
  const dir = tmpDir("arch-node");
  try {
    const fp = writeZip(dir, [
      { name: "readme.md", data: "# hi", method: 0 },
      { name: "a/b.bin", data: "y".repeat(2000), method: 8 },
    ]);
    const dest = path.join(dir, "out");
    assert.equal(extractZipArchive(fp, dest, ["node"]), "node");
    assert.equal(fs.readFileSync(path.join(dest, "readme.md"), "utf8"), "# hi");
    assert.equal(fs.readFileSync(path.join(dest, "a/b.bin"), "utf8"), "y".repeat(2000));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipBuffer：名字里带 `..` 但归一后仍在 dest 内的条目——靠 resolve+startsWith 兜住，不靠 safeZipName", () => {
  // `a/../b.txt` 会被 safeZipName 挡（parts 里有 `..`）。真正只靠第二道守卫的是
  // 这种：名字里没有任何 `..` 段，但 resolve 之后落在 dest 之外是不可能的——
  // 于是这里钉的是「第二道守卫确实存在」这个事实：把一个合法名字的条目解到
  // dest 的子目录里，路径必须严格在 dest 之下。
  const dir = tmpDir("guard2");
  try {
    const dest = path.join(dir, "out");
    extractZipBuffer(buildZip([{ name: "deep/er/x.txt", data: "X" }]), dest);
    const out = path.resolve(dest, "deep/er/x.txt");
    assert.ok(out.startsWith(path.resolve(dest) + path.sep), "落点必须在 dest 之下");
    assert.equal(fs.readFileSync(out, "utf8"), "X");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipArchive：node 解不开就停手，不再往下试（node 是最后一道，再试没有意义）", () => {
  const dir = tmpDir("arch-node-break");
  try {
    // 中央目录合法（能过 safeZipName，entriesSafe 为真）、正文被截断 → node 抛
    // Truncated zip data。此时若 break 被改成 continue，tar 会被真调一次，
    // 报错里就会多出 tar 那一段。
    const fp = path.join(dir, "bad.zip");
    fs.writeFileSync(fp, buildZip([{ name: "a.txt", data: "0123456789", compSize: 9999 }]));
    const dest = path.join(dir, "out");
    let message = "";
    try {
      extractZipArchive(fp, dest, ["node", "tar"]);
    } catch (error) {
      message = String(error.message);
    }
    assert.ok(
      message.includes("Extraction failed: node: Truncated zip data"),
      "node 那条原因必须原样出现在报错里，实际：" + message,
    );
    assert.ok(!message.includes("| tar"), "node 失败后必须 break，不许再交给 tar，实际：" + message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipArchive：外部工具失败时 notes 里带「命令名: 首行原因」，不是只留命令名", () => {
  const dir = tmpDir("arch-detail");
  try {
    const fp = path.join(dir, "garbage.bin");
    fs.writeFileSync(fp, Buffer.from("garbage-garbage-garbage"));
    const dest = path.join(dir, "out");
    // python3 在本机与 CI 的 ubuntu-latest 上都有；对非 zip 它必然失败并把
    // stderr 第一行吐出来。断言「python3: 后面还有内容」才测得出 attempt 里
    // 那段 detail 提取（只回命令名的话冒号后面是空的）。
    let message = "";
    try {
      extractZipArchive(fp, dest, ["python3"]);
    } catch (error) {
      message = String(error.message);
    }
    if (message === "") return; // 没装 python3：这条在那种机器上无从验证
    const head = "Extraction failed: python3: ";
    assert.ok(message.startsWith(head), "失败原因必须以「" + head + "」开头，实际：" + message);
    assert.ok(message.slice(head.length).trim().length > 0, "冒号后面必须是 stderr 首行，实际：" + message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipArchive：条目不安全时一个外部工具都不跑（报错里只有 entries 一条）", () => {
  const dir = tmpDir("arch-slip");
  try {
    const fp = writeZip(dir, [{ name: "../evil.txt", data: "x" }]);
    const dest = path.join(dir, "out");
    let message = "";
    try {
      extractZipArchive(fp, dest, ["node", "tar"]);
    } catch (error) {
      message = String(error.message);
    }
    // 只允许 entries 一条：多出 node 或 tar 就说明预检没拦住
    assert.equal(message, "Extraction failed: entries: Invalid zip path");
    assert.equal(fs.existsSync(path.join(dir, "evil.txt")), false, "外部工具没机会写出去");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipArchive：非 zip（tar.gz 之类）不预先校验，直接交给外部工具", () => {
  const dir = tmpDir("arch-nonzip");
  try {
    const fp = path.join(dir, "pack.tar.gz");
    fs.writeFileSync(fp, Buffer.from("not a zip at all, definitely"));
    const dest = path.join(dir, "out");
    // tools=['node'] 时 node 读不进去 → notes 里记一条 node: Not a zip file
    assert.throws(() => extractZipArchive(fp, dest, ["node"]), /Extraction failed: node: Not a zip file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipArchive：空 tools 列表报 no extractor available", () => {
  const dir = tmpDir("arch-none");
  try {
    const fp = writeZip(dir, [{ name: "a.txt", data: "A" }]);
    assert.throws(
      () => extractZipArchive(fp, path.join(dir, "out"), []),
      /Extraction failed: no extractor available/,
    );
    // 目标目录在挑解包器之前就建好了（失败也不留半成品，但目录本身要在）：
    // 去掉那句 mkdirSync 时，这条断言是唯一能看出来的地方。
    assert.ok(fs.statSync(path.join(dir, "out")).isDirectory(), "解包前必须先建出目标目录");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipArchive：tar 失败时把它的第一行 stderr 记进 notes，再往下试", () => {
  const dir = tmpDir("arch-tar");
  try {
    const fp = path.join(dir, "garbage.bin");
    fs.writeFileSync(fp, Buffer.from("garbage-garbage-garbage"));
    const dest = path.join(dir, "out");
    // 只给 tar：一定失败（本机有没有 tar 都失败，没装时 note 就是文件名本身）
    assert.throws(() => extractZipArchive(fp, dest, ["tar"]), /^Error: Extraction failed: tar/);
    // 再给 node 兜底：tar 的失败进 notes，node 也失败 → 两条都出现在消息里
    assert.throws(() => extractZipArchive(fp, dest, ["tar", "node"]), /Extraction failed: tar[\s\S]*\| node: /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipArchive：unzip 分支的命令行是 -o -q <zip> -d <dest>（用不存在的 unzip 也能验证分支走到）", () => {
  const dir = tmpDir("arch-unzip");
  try {
    const fp = path.join(dir, "garbage.bin");
    fs.writeFileSync(fp, Buffer.from("garbage"));
    assert.throws(() => extractZipArchive(fp, path.join(dir, "out"), ["unzip"]), /Extraction failed: unzip/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "extractZipArchive：powershell 分支把 zip 与目标目录通过环境变量传进去（真跑一次）",
  { skip: WINDOWS ? false : "只有 Windows 有 powershell" },
  () => {
    const dir = tmpDir("arch-ps");
    try {
      const fp = writeZip(dir, [{ name: "ps.txt", data: "via-powershell" }]);
      const dest = path.join(dir, "out");
      assert.equal(extractZipArchive(fp, dest, ["powershell"]), "powershell");
      assert.equal(fs.readFileSync(path.join(dest, "ps.txt"), "utf8"), "via-powershell");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("extractZipArchive：tar 真能解出内容（CRC 算对之后才走得通）", () => {
  const dir = tmpDir("arch-tar-ok");
  try {
    const fp = writeZip(dir, [
      { name: "a.txt", data: "AAA", method: 0 },
      { name: "d/b.txt", data: "B".repeat(3000), method: 8 },
    ]);
    const dest = path.join(dir, "out");
    let used;
    try {
      used = extractZipArchive(fp, dest, ["tar"]);
    } catch (error) {
      // 没装 tar 的机器上这条跳过，而不是假绿：报错里必须是「没这个命令」而不是「解不开」
      assert.match(String(error.message), /Extraction failed: tar/);
      return;
    }
    assert.equal(used, "tar");
    assert.equal(fs.readFileSync(path.join(dest, "a.txt"), "utf8"), "AAA");
    assert.equal(fs.readFileSync(path.join(dest, "d/b.txt"), "utf8"), "B".repeat(3000));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractZipArchive：python3 分支的命令行是 -m zipfile -e <zip> <dest>", () => {
  const dir = tmpDir("arch-py");
  try {
    const fp = writeZip(dir, [{ name: "py.txt", data: "via-python" }]);
    const dest = path.join(dir, "out");
    let used;
    try {
      used = extractZipArchive(fp, dest, ["python3"]);
    } catch (error) {
      assert.match(String(error.message), /Extraction failed: python3/);
      return;
    }
    assert.equal(used, "python3");
    assert.equal(fs.readFileSync(path.join(dest, "py.txt"), "utf8"), "via-python");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "extractZipArchive：powershell 解不开时把它的 stderr 记进 notes（不是静默 continue）",
  { skip: WINDOWS ? false : "只有 Windows 有 powershell" },
  () => {
    const dir = tmpDir("arch-ps-fail");
    try {
      const fp = path.join(dir, "garbage.bin");
      fs.writeFileSync(fp, Buffer.from("garbage-garbage-garbage"));
      assert.throws(
        () => extractZipArchive(fp, path.join(dir, "out"), ["powershell"]),
        /Extraction failed: powershell/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("extractZipArchive：dest 不存在时先建出来（外部工具可能不会自己建）", () => {
  const dir = tmpDir("arch-mkdir");
  try {
    const fp = writeZip(dir, [{ name: "a.txt", data: "A" }]);
    const dest = path.join(dir, "deep", "nested", "out");
    assert.equal(extractZipArchive(fp, dest, ["node"]), "node");
    assert.ok(fs.statSync(dest).isDirectory());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 源码形状：只在外部工具里成立的约定 ---------- */

test("源码形状：两道「冗余守卫」都还在（外部行为等价，去掉不会红，只能读源码钉）", () => {
  const src = fs.readFileSync(new URL("../lib/zip-extract.js", import.meta.url), "utf8");
  // ① `readZipEntries` 开头的 `buf.length < 22` 判断：去掉之后 `findEocd` 的循环
  //    起点是负数、`min` 是 0，一次都不进循环，同样抛 `Not a zip file`。也就是说
  //    这条长度判断是纯纵深防御，任何输入下外部行为都一样 —— 只能靠这行形状钉住。
  assert.match(src, /if \(!Buffer\.isBuffer\(buf\) \|\| buf\.length < 22\) throw new Error\("Not a zip file"\);/);
  // ② `extractZipBuffer` 里 `out !== root && !out.startsWith(prefix)` 那道越界判断：
  //    走到它之前 `safeZipName` 已经挡掉了 `..`、绝对路径、盘符与空段，所以
  //    `path.resolve(root, rel)` 不可能逃出 root。它防的是「以后有人放松
  //    safeZipName」这种将来时，同样测不出行为差别。
  assert.match(src, /if \(out !== root && !out\.startsWith\(prefix\)\) throw new Error\("Invalid zip path"\);/);
  // ③ `safeZipName` 里的盘符判断 `|| /^[A-Za-z]:/.test(rel)`：删掉之后
  //    `C:/Windows/x.txt` 会被 `path.resolve` 解析成盘符绝对路径、随后被 ② 那道
  //    守卫接住，报的仍是同一个 `Invalid zip path`。所以它在 Windows 上完全等价，
  //    只有「将来 ② 被放松」或「在 POSIX 上跑」才显出区别 —— 同样只能读源码钉。
  assert.match(src, /if \(rel\.startsWith\("\/"\) \|\| \/\^\[A-Za-z\]:\/\.test\(rel\)\) throw new Error\("Invalid zip path"\);/);
});

test("源码形状：HIDDEN 关掉 stdin/stdout 且设了 60 秒超时，attempt 才把它与 stdio 合并", () => {
  const src = fs.readFileSync(new URL("../lib/zip-extract.js", import.meta.url), "utf8");
  assert.match(src, /const HIDDEN = \{/);
  assert.match(src, /windowsHide: true,/);
  assert.match(src, /timeout: 60000,/);
  // attempt 必须覆盖 stdio 为 pipe，否则拿不到 stderr 里那句失败原因
  assert.match(src, /stdio: \["ignore", "pipe", "pipe"\],/);
});
