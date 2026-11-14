// 环境适配层的「读不到就看下一条」出口：Python 判据、发行版别名对撞、Kali 探测、扫盘兜底。
//
// 这几条的共同点是**平时都不响**：机器上有 os-release、文件夹读得动、条目带 isDirectory 的时候，
// 那些 catch 一次都不会执行。判错的表现也不是报错，而是
//   · 把 python 脚本当成可执行工具指给用户（`rejectPython` 白设）
//   · Kali 上明明有一整套工具却让用户去手填路径
//   · 文件夹读不动时回一个「文件夹不存在」，用户照着提示删了又建还是不行
//
// 手法：`lib/redteam/platform-config.js` 里 `import fs from "node:fs"`（默认导出），
// 所以要换实现必须拿 CJS 的同一个对象 `createRequire("node:fs")` 改属性，再
// `syncBuiltinESMExports()` 让 ESM 侧看到；`finally` 先还原再 sync 一次。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";

const CJS_FS = createRequire(import.meta.url)("node:fs");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-platform-edges-"));
const ORIG_HOME = process.env.DSH_HOME;
process.env.DSH_HOME = path.join(ROOT, "home");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const pc = await import("../lib/redteam/platform-config.js");
const SRC = fs.readFileSync(new URL("../lib/redteam/platform-config.js", import.meta.url), "utf8");

test.after(() => {
  if (ORIG_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIG_HOME;
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
});

let seq = 0;
const box = (tag) => {
  const dir = path.join(ROOT, `${tag}-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const put = (dir, name, body) => {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, body);
  return fp;
};
const asPlatform = (name, fn) => {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: name, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", desc);
  }
};
/** 临时换掉某个 fs 方法；`fn` 里同步跑完，出来一律还原。 */
const withFs = (name, impl, fn) => {
  const original = CJS_FS[name];
  CJS_FS[name] = impl(original);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    CJS_FS[name] = original;
    syncBuiltinESMExports();
  }
};
const KALI = 'NAME="Kali GNU/Linux"\nID=kali\nID_LIKE=debian\n';

// ── Python 判据 ────────────────────────────────────────────────
test("looksLikePythonCli：python 开头的脚本算，别的 shebang 不算", () => {
  const dir = box("py");
  const py = put(dir, "tool", "#!/usr/bin/env python3\nprint(1)\n");
  const sh = put(dir, "tool2", "#!/bin/sh\necho hi\n");
  const plain = put(dir, "tool3", "just text\n");
  assert.equal(pc.looksLikePythonCli(py), true);
  assert.equal(pc.looksLikePythonCli(sh), false);
  assert.equal(pc.looksLikePythonCli(plain), false);
});

test("looksLikePythonCli：文件打不开时回 false（这是唯一能挡住误判的死角）", () => {
  const missing = path.join(box("py-missing"), "gone.py");
  assert.equal(pc.looksLikePythonCli(missing), false);
});

test("looksLikePythonCli：空文件与只有 shebang 没有 python 的都不算", () => {
  const dir = box("py-empty");
  assert.equal(pc.looksLikePythonCli(put(dir, "empty", "")), false);
  assert.equal(pc.looksLikePythonCli(put(dir, "shebang", "#!")), false);
});

test("looksLikePythonCli：打开成功但读失败也回 false", () => {
  const dir = box("py-read");
  const fp = put(dir, "tool", "#!/usr/bin/env python3\n");
  const got = withFs(
    "readSync",
    () => () => {
      throw Object.assign(new Error("read boom"), { code: "EIO" });
    },
    () => pc.looksLikePythonCli(fp),
  );
  assert.equal(got, false);
});

// ── 发行版别名对撞 ─────────────────────────────────────────────
test("adaptInDir：别名对上就返回真路径", () => {
  const dir = box("adapt");
  const fp = put(dir, "nmap-kali-wrapper", "#!/bin/sh\n");
  const got = pc.adaptInDir(dir, { adapt: [/^nmap/] });
  assert.equal(got, fp);
});

test("adaptInDir：rejectPython 会把 python 脚本跳过，继续找下一个", () => {
  const dir = box("adapt-py");
  put(dir, "nmap-py", "#!/usr/bin/env python3\n");
  const ok = put(dir, "nmap-real", "#!/bin/sh\n");
  const got = pc.adaptInDir(dir, { adapt: [/^nmap/], rejectPython: true });
  assert.equal(got, ok);
});

test("adaptInDir：statSync 抛错只跳过这一条，不连累后面的", () => {
  const dir = box("adapt-stat");
  put(dir, "nmap-bad", "#!/bin/sh\n");
  const ok = put(dir, "nmap-good", "#!/bin/sh\n");
  const got = withFs(
    "statSync",
    (original) => (p, o) => {
      if (String(p).endsWith("nmap-bad")) throw new Error("stat boom");
      return original(p, o);
    },
    () => pc.adaptInDir(dir, { adapt: [/^nmap/] }),
  );
  assert.equal(got, ok);
});

test("adaptInDir：目录里一个都对不上时回 null，且目录不存在也回 null", () => {
  const dir = box("adapt-none");
  put(dir, "not-a-tool", "x");
  assert.equal(pc.adaptInDir(dir, { adapt: [/^nmap/] }), null);
  assert.equal(pc.adaptInDir(path.join(dir, "nope"), { adapt: [/^nmap/] }), null);
  assert.equal(pc.adaptInDir(dir, {}), null);
});

// ── Kali 探测 ─────────────────────────────────────────────────
test("detectKali：非 Linux 宿主直接判否，连 os-release 都不读", () => {
  // 伪 linux 复跑时这一条必须自己把平台钉回 win32，否则走的是另一条分支。
  const got = asPlatform("win32", () =>
    withFs(
      "readFileSync",
      (original) => (p, e) => {
        if (String(p) === "/etc/os-release") throw new Error("不该被读到");
        return original(p, e);
      },
      () => pc.detectKali(),
    ),
  );
  assert.deepEqual(got, { kali: false, source: null, detail: "非 Linux 宿主" });
});

test("detectKali：os-release 写着 kali 就认，来源标成 os-release", () => {
  const got = asPlatform("linux", () =>
    withFs(
      "readFileSync",
      (original) => (p, e) => (String(p) === "/etc/os-release" ? KALI : original(p, e)),
      () => pc.detectKali(),
    ),
  );
  assert.deepEqual(got, { kali: true, source: "os-release", detail: "os-release 标明 Kali" });
});

test("detectKali：os-release 读不到时退回看标记目录，都没有就是 null（不是 false）", () => {
  const got = asPlatform("linux", () =>
    withFs(
      "readFileSync",
      (original) => (p, e) => {
        if (String(p) === "/etc/os-release") throw new Error("enoent");
        return original(p, e);
      },
      () => pc.detectKali(),
    ),
  );
  assert.equal(got.kali, false);
  assert.equal(got.source, null);
  assert.equal(got.detail, null);
});

test("envAdaptStatus：Kali 上 ready 为真、reason 是 kali", () => {
  const got = asPlatform("linux", () =>
    withFs(
      "readFileSync",
      (original) => (p, e) => (String(p) === "/etc/os-release" ? KALI : original(p, e)),
      () => pc.envAdaptStatus(process.env.DSH_HOME),
    ),
  );
  assert.equal(got.ready, true);
  assert.equal(got.reason, "kali");
  assert.match(got.message, /已检测到 Kali/);
  assert.equal(got.kaliSource, "os-release");
});

// ── 扫盘兜底 ─────────────────────────────────────────────────
test("scanFolderForTools：statSync 抛错回「无法读取文件夹」，与「文件夹不存在」分开", () => {
  const dir = box("scan-stat");
  const got = withFs(
    "statSync",
    (original) => (p, o) => {
      if (String(p) === dir) throw new Error("stat boom");
      return original(p, o);
    },
    () => pc.scanFolderForTools(dir),
  );
  assert.equal(got.ok, false);
  assert.match(got.error, /无法读取文件夹/);
  assert.deepEqual(got.hits, []);
});

test("scanFolderForTools：条目没有 isDirectory 时退回 statSync 判类型", () => {
  const dir = box("scan-dirent");
  put(dir, "nmap", "#!/bin/sh\n");
  const got = withFs(
    "readdirSync",
    (original) => (p, o) => {
      if (String(p) === dir) return [{ name: "nmap" }, { name: "nuclei" }];
      return original(p, o);
    },
    () => pc.scanFolderForTools(dir),
  );
  assert.equal(got.ok, true);
  assert.deepEqual(Object.keys(got.assigned), ["nmap"]);
  assert.equal(got.assigned.nmap, path.join(dir, "nmap"));
});

test("scanFolderForTools：条目没有 isDirectory 时，子目录还要继续往下走（不能当成文件）", () => {
  const dir = box("scan-dirent-sub");
  put(path.join(dir, "sub"), "nmap", "#!/bin/sh\n");
  const got = withFs(
    "readdirSync",
    (original) => (p, o) => {
      if (String(p) === dir) return [{ name: "sub" }, { name: "not-a-tool" }];
      return original(p, o);
    },
    () => pc.scanFolderForTools(dir),
  );
  assert.equal(got.ok, true);
  assert.equal(got.assigned.nmap, path.join(dir, "sub", "nmap"));
});

test("scanFolderForTools：条目 statSync 抛错就跳过那一条，其余照常", () => {
  const dir = box("scan-skip");
  put(dir, "nmap", "#!/bin/sh\n");
  const got = withFs(
    "statSync",
    (original) => (p, o) => {
      if (String(p).endsWith("nuclei")) throw new Error("stat boom");
      return original(p, o);
    },
    () => pc.scanFolderForTools(dir),
  );
  assert.equal(got.ok, true);
  assert.deepEqual(Object.keys(got.assigned), ["nmap"]);
});

test("scanFolderForTools：路径是文件不是文件夹时回 Not a folder", () => {
  const dir = box("scan-file");
  const fp = put(dir, "plain.txt", "x");
  const got = pc.scanFolderForTools(fp);
  assert.equal(got.ok, false);
  assert.match(got.error, /Not a folder/);
});

// ── 源码形状 ──────────────────────────────────────────────────
test("源码形状：四处 catch 都还在，且 Python 判据在 rejectPython 分支上", () => {
  const code = SRC.split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
  assert.match(code, /if \(options\.rejectPython && looksLikePythonCli\(file\)\) continue/);
  assert.match(code, /if \(options\.rejectPython && looksLikePythonCli\(p\)\) continue/);
  assert.match(code, /return head\.startsWith\('#!'\) && \/python\/i\.test\(head\)/);
  assert.match(code, /catch \{\s*\n\s*return false;?\s*\n\s*\}/);
  assert.match(code, /readFileSync\('\/etc\/os-release', 'utf8'\)/);
  assert.match(code, /if \(!st\.isDirectory\(\)\) \{\s*\n\s*return \{ ok: false, error: "Not a folder: "/);
  assert.match(code, /} else \{\s*\n\s*const s = statSync\(full\)/);
});
