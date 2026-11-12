// lib/extract-asar.js 的回归测试。
//
// 这个模块决定「宿主文件用哪套 fs」以及「怎么把 app.asar 解开成目录」。
// 它坏掉的方式都很安静：探针缓存没失效 → 解开之后仍然以为归档还在，写文件落到 asar 里（ENOENT
// 或写进归档）；换包链路里路径穿越没防住 → 归档头里一个 "../.." 就能写到 resources 之外；
// 回滚「看起来成功」但磁盘上留的是空壳 → 宿主启动找不到 main.js，且日志说已恢复。
//
// 归档用本地构造函数 makeAsar() 造，不依赖真的 Electron 包：格式就是
// [u32 4][u32 headerSize][u32 jsonSize+4][u32 jsonSize][json][body]，
// dataOffset = 8 + headerSize 正好接在 json 之后。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  diskFs,
  hostFs,
  invalidateAsarProbes,
  withFsProbeCache,
  asarShadowsPath,
  fsFor,
  renameAsarAside,
  asarArchiveIsFile,
  asarFileIdentity,
  sameAsarIdentity,
  shouldExtractAsar,
  overlayAsarUnpacked,
  extractAsarToSide,
  commitExtractedDir,
  newestPreservedDir,
  restoreExtractedDir,
  extractAsar,
} from "../lib/extract-asar.js";

// ---------------------------------------------------------------- 归档构造

/** 把 [{rel, data}] 摊成 asar 的嵌套 header + 顺序正文。link/unpacked 不占正文。 */
function nest(entries) {
  const root = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const e of entries) {
    const parts = e.rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dir = parts[i];
      if (!node.files[dir]) node.files[dir] = { files: {} };
      node = node.files[dir];
    }
    const name = parts[parts.length - 1];
    const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
    if (typeof e.link === "string") {
      node.files[name] = { link: e.link };
      continue;
    }
    const info = { size: data.length, offset: String(offset) };
    if (e.unpacked) info.unpacked = true;
    if (e.executable) info.executable = true;
    node.files[name] = info;
    if (!e.unpacked) {
      chunks.push(data);
      offset += data.length;
    }
  }
  return { header: root, body: Buffer.concat(chunks) };
}

/** 造一份能真的被 readHeader() 读进来的 asar 字节。 */
function makeAsar(entries) {
  const { header, body } = nest(entries);
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const jsonSize = json.length;
  const headerSize = jsonSize + 8;
  const pre = Buffer.alloc(16);
  pre.writeUInt32LE(4, 0);
  pre.writeUInt32LE(headerSize, 4);
  pre.writeUInt32LE(jsonSize + 4, 8);
  pre.writeUInt32LE(jsonSize, 12);
  return Buffer.concat([pre, json, body]);
}

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-purge-asar-${tag}-`));
}

function writeAsar(dir, entries) {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, "app.asar");
  fs.writeFileSync(fp, makeAsar(entries));
  return fp;
}

/** 造「归档还在、Electron 会把 resources/app 映进 app.asar」的布局。 */
function shadowLayout(tag) {
  const root = tmpRoot(tag);
  const res = path.join(root, "resources");
  const asar = writeAsar(res, [{ rel: "app/main.js", data: "console.log(1)" }]);
  return { root, res, asar, app: path.join(res, "app") };
}

const withTmp = (tag, fn) => {
  const root = tmpRoot(tag);
  try {
    return fn(root);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
};

const read = (fp) => fs.readFileSync(fp, "utf8");
const exists = (fp) => fs.existsSync(fp);

/** 临时接管 fs.renameSync，用来造「第二步 rename 失败」这种真实磁盘上很难凑出来的分支。 */
function withRenameFault(predicate, fn) {
  const original = fs.renameSync;
  fs.renameSync = function patched(from, to, ...rest) {
    if (predicate(String(from), String(to))) {
      const err = new Error(`EPERM: injected rename failure ${from} -> ${to}`);
      err.code = "EPERM";
      throw err;
    }
    return original.call(this, from, to, ...rest);
  };
  try {
    return fn();
  } finally {
    fs.renameSync = original;
  }
}

// ---------------------------------------------------------------- diskFs / hostFs

test("diskFs：非 Electron 环境退回 node:fs，并且只解析一次", () => {
  const first = diskFs();
  const second = diskFs();
  assert.equal(first, second, "第二次必须拿缓存，不能每次重新 createRequire");
  assert.equal(typeof first.existsSync, "function");
  assert.equal(typeof first.readFileSync, "function");
});

test("hostFs：按路径分流的同步方法都在，且 fd 方法单独走（不把数字 fd 当路径探测）", () => {
  for (const name of ["existsSync", "readFileSync", "writeFileSync", "mkdirSync", "readdirSync", "statSync"]) {
    assert.equal(typeof hostFs[name], "function", `hostFs.${name} 必须存在`);
  }
  for (const name of ["closeSync", "readSync", "writeSync", "fsyncSync", "fstatSync"]) {
    assert.equal(typeof hostFs[name], "function", `hostFs.${name} 必须存在`);
  }
  // fd 方法拿真 fd 调用不能抛（走 route() 会把数字当路径去探测 asar）。
  withTmp("fd", (root) => {
    const fp = path.join(root, "x.txt");
    fs.writeFileSync(fp, "abc");
    const fd = hostFs.openSync(fp, "r");
    try {
      const st = hostFs.fstatSync(fd);
      assert.equal(st.size, 3);
      const buf = Buffer.alloc(3);
      assert.equal(hostFs.readSync(fd, buf, 0, 3, 0), 3);
      assert.equal(buf.toString(), "abc");
    } finally {
      hostFs.closeSync(fd);
    }
  });
});

test("hostFs.promises：写类方法先让 asar 探针失效，读类不动缓存", async () => {
  const layout = shadowLayout("promises");
  try {
    const target = path.join(layout.app, "x.js");
    assert.equal(asarShadowsPath(target), true, "前置：归档还在时应判为会被映射");
    fs.rmSync(layout.asar);
    assert.equal(asarShadowsPath(target), true, "缓存期内仍认为被映射");

    // 读类不失效：仍然命中缓存。
    await hostFs.promises.readFile(layout.asar).catch(() => {});
    assert.equal(asarShadowsPath(target), true);

    // 写类必须失效，于是重新探测到归档已不在。
    await hostFs.promises.writeFile(path.join(layout.root, "y.txt"), "1");
    assert.equal(asarShadowsPath(target), false, "写操作后必须重新探测");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("hostFs 的写方法清单里包含 copyFileSync，而 openSync 故意不在写清单里", () => {
  // openSync 多数时候是只读打开；把它算成写会让每次读都冲掉探针缓存（启动性能）。
  const layout = shadowLayout("write-set");
  try {
    const target = path.join(layout.app, "x.js");
    assert.equal(asarShadowsPath(target), true);
    fs.rmSync(layout.asar);

    // openSync 不失效 → 缓存仍然说 true。
    const fp = path.join(layout.root, "z.txt");
    fs.writeFileSync(fp, "z");
    const fd = hostFs.openSync(fp, "r");
    hostFs.closeSync(fd);
    assert.equal(asarShadowsPath(target), true, "openSync 不该冲掉探针缓存");

    // copyFileSync 在写清单里 → 失效。
    const src = path.join(layout.root, "s.txt");
    fs.writeFileSync(src, "s");
    hostFs.copyFileSync(src, path.join(layout.root, "d.txt"));
    assert.equal(asarShadowsPath(target), false, "copyFileSync 必须冲掉探针缓存");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 探针缓存

test("asarShadowsPath：空值与纯空白一律假，不抛", () => {
  for (const v of ["", "   ", null, undefined, 0, false]) {
    assert.equal(asarShadowsPath(v), false, `入参 ${JSON.stringify(v)} 应为假`);
  }
});

test("asarShadowsPath：直接含 app.asar 的目录本身也算被映射，隔一层的不算", () => {
  const layout = shadowLayout("shadow");
  try {
    assert.equal(asarShadowsPath(path.join(layout.app, "main.js")), true);
    assert.equal(asarShadowsPath(layout.app), true);
    // resources 直接含 app.asar，往里写同样会落进归档，所以它自己也算被映射。
    assert.equal(asarShadowsPath(layout.res), true);
    // 再上一层（临时根）不含 app.asar，也不是 app / *.asar 目录 → 不算。
    assert.equal(asarShadowsPath(layout.root), false);
    assert.equal(asarShadowsPath(path.join(layout.root, "elsewhere")), false);
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("asarShadowsPath：名字以 .asar 结尾的目录，旁边有归档时算被映射", () => {
  const layout = shadowLayout("asar-dir");
  try {
    const asarDir = path.join(layout.res, "other.asar");
    fs.mkdirSync(asarDir, { recursive: true });
    assert.equal(asarShadowsPath(path.join(asarDir, "nested")), true);
    // 归档挪走之后，同一路径重新探测就是干净的。
    fs.rmSync(layout.asar);
    invalidateAsarProbes();
    assert.equal(asarShadowsPath(path.join(asarDir, "nested")), false);
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("asarShadowsPath：向上最多探 12 层，再深就不再认", () => {
  const layout = shadowLayout("depth");
  try {
    const deep = (n) => path.join(layout.app, ...Array.from({ length: n }, (_, i) => `d${i}`));
    // app 本身是第 1 层，再往下 10 层仍在 12 层预算内。
    assert.equal(asarShadowsPath(deep(10)), true, "12 层内应命中");
    // 13 层以上超出预算：不再向上找到 resources。
    assert.equal(asarShadowsPath(deep(13)), false, "超出 12 层预算应放弃");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("asarShadowsPath：键做归一化（反斜杠 / 尾斜杠 / 大小写都算同一条）", () => {
  const layout = shadowLayout("key");
  try {
    const target = path.join(layout.app, "main.js");
    assert.equal(asarShadowsPath(target), true);
    fs.rmSync(layout.asar);
    // 同一路径的三种写法都应命中同一条缓存（否则等于没缓存）。
    assert.equal(asarShadowsPath(target.replace(/\\/g, "/")), true);
    assert.equal(asarShadowsPath(`${target}${path.sep}`), true);
    assert.equal(asarShadowsPath(target.toUpperCase()), true);
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("invalidateAsarProbes：立刻让缓存归零", () => {
  const layout = shadowLayout("invalidate");
  try {
    const target = path.join(layout.app, "main.js");
    assert.equal(asarShadowsPath(target), true);
    fs.rmSync(layout.asar);
    assert.equal(asarShadowsPath(target), true, "缓存期内仍是旧结论");
    invalidateAsarProbes();
    assert.equal(asarShadowsPath(target), false, "失效后必须重新探测");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("activeProbes：持久缓存 5 秒后自动过期重建", () => {
  const layout = shadowLayout("ttl");
  const realNow = Date.now;
  try {
    const target = path.join(layout.app, "main.js");
    let clock = realNow();
    Date.now = () => clock;
    try {
      assert.equal(asarShadowsPath(target), true);
      fs.rmSync(layout.asar);
      clock += 4000;
      assert.equal(asarShadowsPath(target), true, "4 秒内仍是缓存");
      clock += 1500;
      assert.equal(asarShadowsPath(target), false, "超过 5 秒必须重建");
    } finally {
      Date.now = realNow;
    }
  } finally {
    Date.now = realNow;
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("withFsProbeCache：作用域内强缓存、可重入、异常也会收尾", () => {
  const layout = shadowLayout("scope");
  try {
    const target = path.join(layout.app, "main.js");
    invalidateAsarProbes();
    const seen = withFsProbeCache(() => {
      const a = asarShadowsPath(target);
      fs.rmSync(layout.asar);
      const b = asarShadowsPath(target);
      const nested = withFsProbeCache(() => asarShadowsPath(target));
      return { a, b, nested };
    });
    assert.deepEqual(seen, { a: true, b: true, nested: true }, "作用域内不重探，且可重入");
    assert.equal(asarShadowsPath(target), false, "出作用域后必须重新探测");

    assert.throws(() => withFsProbeCache(() => { throw new Error("boom"); }), /boom/);
    assert.equal(asarShadowsPath(target), false, "抛异常后作用域必须收尾");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("fsFor：会被映射时给真实磁盘 fs，不会时给 node:fs", () => {
  const layout = shadowLayout("fsfor");
  try {
    assert.equal(fsFor(path.join(layout.app, "main.js")), diskFs());
    assert.equal(fsFor(layout.root), fs);
    assert.equal(fsFor(""), fs);
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("renameAsarAside：归档挪成 .bak，已有 .bak 先删，探针缓存立刻失效", () => {
  const layout = shadowLayout("aside");
  try {
    const target = path.join(layout.app, "main.js");
    assert.equal(asarShadowsPath(target), true, "前置：归档在");
    fs.writeFileSync(`${layout.asar}.bak`, "stale");

    const r = renameAsarAside(layout.asar);
    assert.deepEqual(r, { renamed: true, bak: `${layout.asar}.bak` });
    assert.equal(exists(layout.asar), false);
    assert.equal(read(`${layout.asar}.bak`).length > 0, true);
    assert.notEqual(read(`${layout.asar}.bak`), "stale", "旧 .bak 必须被删掉重写");
    assert.equal(asarShadowsPath(target), false, "挪走后必须重新探测成干净");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("renameAsarAside：归档本来就不在时如实回 renamed:false", () => {
  withTmp("aside-missing", (root) => {
    assert.deepEqual(renameAsarAside(path.join(root, "app.asar")), { renamed: false });
    assert.deepEqual(renameAsarAside(""), { renamed: false });
    assert.deepEqual(renameAsarAside(null), { renamed: false });
  });
});

test("renameAsarAside：被占用（EBUSY/EPERM/EACCES）时回 busy 而不是抛", () => {
  const layout = shadowLayout("aside-busy");
  const realRename = fs.renameSync;
  try {
    for (const code of ["EBUSY", "EPERM", "EACCES"]) {
      fs.renameSync = () => {
        const err = new Error(code);
        err.code = code;
        throw err;
      };
      const r = renameAsarAside(layout.asar);
      assert.equal(r.renamed, false, `${code} 不该算成功`);
      assert.equal(r.busy, true, `${code} 应标 busy`);
      assert.equal(r.bak, `${layout.asar}.bak`);
    }
    // 其它错误码必须往上抛：那是真问题，不能当「文件正忙」糊过去。
    fs.renameSync = () => {
      const err = new Error("EIO");
      err.code = "EIO";
      throw err;
    };
    assert.throws(() => renameAsarAside(layout.asar), /EIO/);
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("asarArchiveIsFile：只认真的文件，目录与不存在都算假", () => {
  const layout = shadowLayout("isfile");
  try {
    assert.equal(asarArchiveIsFile(layout.asar), true);
    assert.equal(asarArchiveIsFile(layout.res), false, "目录不算归档");
    assert.equal(asarArchiveIsFile(path.join(layout.res, "nope.asar")), false);
    assert.equal(asarArchiveIsFile(""), false);
    assert.equal(asarArchiveIsFile(null), false);
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("asarFileIdentity：给 size 与取整后的 mtime；目录或不存在回 null", () => {
  const layout = shadowLayout("identity");
  try {
    const id = asarFileIdentity(layout.asar);
    const st = fs.statSync(layout.asar);
    assert.equal(id.size, st.size);
    assert.equal(id.mtimeMs, Math.round(st.mtimeMs));
    assert.equal(Number.isInteger(id.mtimeMs), true, "mtime 必须取整，否则浮点抖动会被当成换了归档");
    assert.equal(asarFileIdentity(layout.res), null);
    assert.equal(asarFileIdentity(path.join(layout.res, "nope.asar")), null);
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("sameAsarIdentity：两边都齐且 size/mtime 一致才算同一份", () => {
  const a = { size: 10, mtimeMs: 100 };
  assert.equal(sameAsarIdentity(a, { size: 10, mtimeMs: 100 }), true);
  assert.equal(sameAsarIdentity(a, { size: 10, mtimeMs: 101 }), false);
  assert.equal(sameAsarIdentity(a, { size: 11, mtimeMs: 100 }), false);
  assert.equal(sameAsarIdentity(null, a), false);
  assert.equal(sameAsarIdentity(a, null), false);
  assert.equal(sameAsarIdentity(null, null), false);
});

test("shouldExtractAsar：没有归档就不解；目录不在必解；升级或记录不一致也解", () => {
  const id = { size: 10, mtimeMs: 100 };
  const same = { size: 10, mtimeMs: 100 };
  const other = { size: 11, mtimeMs: 100 };
  // 没有归档：什么都不做。
  assert.equal(shouldExtractAsar({ usable: true, identity: null, recorded: null, upgrade: false }), false);
  assert.equal(shouldExtractAsar({ usable: false, identity: null, recorded: null, upgrade: true }), false);
  // 目录不在：必解。
  assert.equal(shouldExtractAsar({ usable: false, identity: id, recorded: same, upgrade: false }), true);
  // 目录在、记录一致、不是升级：不解。
  assert.equal(shouldExtractAsar({ usable: true, identity: id, recorded: same, upgrade: false }), false);
  // 升级标记碰上另一份归档：解（记录的是同一份就不解）。
  assert.equal(shouldExtractAsar({ usable: true, identity: id, recorded: other, upgrade: true }), true);
  assert.equal(shouldExtractAsar({ usable: true, identity: id, recorded: same, upgrade: true }), false);
  // 记录过但归档变了：解。
  assert.equal(shouldExtractAsar({ usable: true, identity: id, recorded: other, upgrade: false }), true);
  // 目录在、没记录过、也不是升级：先认这份归档，不解。
  assert.equal(shouldExtractAsar({ usable: true, identity: id, recorded: null, upgrade: false }), false);
});

test("overlayAsarUnpacked：把 .unpacked 里的原生文件补进解开的目录，已存在的不覆盖", () => {
  const layout = shadowLayout("overlay");
  try {
    const unpacked = `${layout.asar}.unpacked`;
    fs.mkdirSync(path.join(unpacked, "native", "deep"), { recursive: true });
    fs.writeFileSync(path.join(unpacked, "native", "a.node"), "AAA");
    fs.writeFileSync(path.join(unpacked, "native", "deep", "b.node"), "BBB");

    fs.mkdirSync(layout.app, { recursive: true });
    fs.writeFileSync(path.join(layout.app, "keep.node"), "KEEP");

    const r = overlayAsarUnpacked(layout.asar, layout.app);
    assert.equal(r.copied, 2);
    assert.equal(read(path.join(layout.app, "native", "a.node")), "AAA");
    assert.equal(read(path.join(layout.app, "native", "deep", "b.node")), "BBB");

    // 已存在的目标不覆盖，第二次复制 0 个。
    fs.writeFileSync(path.join(layout.app, "native", "a.node"), "LOCAL");
    assert.equal(overlayAsarUnpacked(layout.asar, layout.app).copied, 0);
    assert.equal(read(path.join(layout.app, "native", "a.node")), "LOCAL");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("overlayAsarUnpacked：没有 .unpacked 或没有目标目录时回 missing", () => {
  const layout = shadowLayout("overlay-missing");
  try {
    assert.deepEqual(overlayAsarUnpacked(layout.asar, layout.app), { copied: 0, missing: true });
    fs.mkdirSync(`${layout.asar}.unpacked`, { recursive: true });
    assert.deepEqual(overlayAsarUnpacked(layout.asar, ""), { copied: 0, missing: true });
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("extractAsar：按 header 写出正文，返回文件数，目录结构正确", () => {
  const root = tmpRoot("extract");
  try {
    const asar = writeAsar(path.join(root, "resources"), [
      { rel: "app/main.js", data: "console.log(1)" },
      { rel: "app/lib/util.js", data: "export const x = 1;" },
    ]);
    const dest = path.join(root, "out");
    const count = extractAsar(asar, dest);
    assert.equal(count, 2);
    assert.equal(read(path.join(dest, "app", "main.js")), "console.log(1)");
    assert.equal(read(path.join(dest, "app", "lib", "util.js")), "export const x = 1;");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractAsar：0 字节文件也要建出来（不能漏）", () => {
  const root = tmpRoot("extract-empty");
  try {
    const asar = writeAsar(path.join(root, "resources"), [
      { rel: "app/empty.txt", data: "" },
      { rel: "app/one.txt", data: "1" },
    ]);
    const dest = path.join(root, "out");
    assert.equal(extractAsar(asar, dest), 2);
    assert.equal(exists(path.join(dest, "app", "empty.txt")), true);
    assert.equal(fs.statSync(path.join(dest, "app", "empty.txt")).size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractAsar：header 里的 ../ 穿越被挡下，一个字节都不写到 destDir 外", () => {
  const root = tmpRoot("extract-escape");
  try {
    const res = path.join(root, "resources");
    const asar = writeAsar(res, [{ rel: "app/main.js", data: "ok" }]);
    // 手工改 header：塞进一条 "../escape.txt"。
    const raw = fs.readFileSync(asar);
    const headerSize = raw.readUInt32LE(4);
    const jsonSize = raw.readUInt32LE(12);
    const header = JSON.parse(raw.subarray(16, 16 + jsonSize).toString("utf8"));
    header.files[".."] = { files: { "escape.txt": { size: 4, offset: "0" } } };
    const json = Buffer.from(JSON.stringify(header), "utf8");
    const pre = Buffer.alloc(16);
    pre.writeUInt32LE(4, 0);
    pre.writeUInt32LE(json.length + 8, 4);
    pre.writeUInt32LE(json.length + 4, 8);
    pre.writeUInt32LE(json.length, 12);
    fs.writeFileSync(asar, Buffer.concat([pre, json, Buffer.from("evil")]));

    const dest = path.join(root, "out");
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (m) => warnings.push(String(m));
    let count;
    try {
      count = extractAsar(asar, dest);
    } finally {
      console.warn = realWarn;
    }
    assert.equal(exists(path.join(root, "escape.txt")), false, "不能写到 destDir 之外");
    assert.equal(exists(path.join(dest, "..", "escape.txt")), false);
    assert.equal(count, 1, "只解出正常那一条");
    assert.equal(warnings.some((w) => /skipped 1 entry outside/.test(w)), true, "要 warn 出来，不能静默");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractAsar：symlink 目标逃出 destDir 时跳过，不建链接", () => {
  const root = tmpRoot("extract-link");
  try {
    const res = path.join(root, "resources");
    const asar = writeAsar(res, [
      { rel: "app/ok.txt", data: "ok" },
      { rel: "app/evil.lnk", link: "../../../../etc/passwd" },
    ]);
    const dest = path.join(root, "out");
    const count = extractAsar(asar, dest);
    assert.equal(count, 1, "越界链接不算解出的文件");
    // 不能用 existsSync 判：它跟随链接，越界目标不存在时同样是 false，
    // 于是「链接建出来了」和「链接被跳过」看起来一样。必须看目录项。
    assert.deepEqual(fs.readdirSync(path.join(dest, "app")), ["ok.txt"], "越界链接连目录项都不该出现");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractAsar：unpacked 标记的条目只建目录、不写正文（正文在 .unpacked 里）", () => {
  const root = tmpRoot("extract-unpacked");
  try {
    const res = path.join(root, "resources");
    const asar = writeAsar(res, [
      { rel: "app/main.js", data: "m" },
      { rel: "app/native.node", unpacked: true },
    ]);
    const dest = path.join(root, "out");
    const count = extractAsar(asar, dest);
    assert.equal(count, 1, "unpacked 条目不计数");
    assert.equal(exists(path.join(dest, "app", "native.node")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractAsar：坏归档三种形态各自报错，且不留下半个目录", () => {
  const root = tmpRoot("extract-bad");
  try {
    const dest = path.join(root, "out");
    const bad = (buf, tag) => {
      const fp = path.join(root, tag, "app.asar");
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, buf);
      return fp;
    };
    // 太短。
    assert.throws(() => extractAsar(bad(Buffer.alloc(8), "short"), dest), /asar header truncated/);
    // 魔数不对。
    const wrongMagic = Buffer.alloc(32);
    wrongMagic.writeUInt32LE(9, 0);
    assert.throws(() => extractAsar(bad(wrongMagic, "magic"), dest), /not an asar archive/);
    // headerSize / jsonSize 为 0。
    const zero = Buffer.alloc(32);
    zero.writeUInt32LE(4, 0);
    assert.throws(() => extractAsar(bad(zero, "zero"), dest), /asar header size invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractAsarToSide：解到 .dshpurge-next，成功回 next 与文件数", () => {
  const root = tmpRoot("side");
  try {
    const asar = writeAsar(path.join(root, "resources"), [
      { rel: "app/main.js", data: "console.log(1)" },
      { rel: "app/lib/util.js", data: "u" },
    ]);
    const dest = path.join(root, "app");
    const r = extractAsarToSide(asar, dest);
    assert.equal(r.next, `${dest}.dshpurge-next`);
    assert.equal(r.count, 2);
    assert.equal(read(path.join(r.next, "app", "main.js")), "console.log(1)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractAsarToSide：解包失败时删掉半成品、不碰在用的那一份", () => {
  const layout = shadowLayout("side-fail");
  try {
    const dest = path.join(layout.root, "app");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "live.txt"), "LIVE");
    const next = `${dest}.dshpurge-next`;
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(path.join(next, "stale.txt"), "STALE");

    assert.throws(() => extractAsarToSide(path.join(layout.root, "nope.asar"), dest));
    assert.equal(exists(next), false, "半成品必须清掉");
    assert.equal(read(path.join(dest, "live.txt")), "LIVE", "在用的那一份不能动");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("commitExtractedDir：旧目录挪成 .dshpurge-prev，新目录换上", () => {
  const layout = shadowLayout("commit");
  try {
    const dest = path.join(layout.root, "app");
    const next = `${dest}.dshpurge-next`;
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "old.txt"), "OLD");
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(path.join(next, "new.txt"), "NEW");

    const r = commitExtractedDir(dest, next);
    assert.equal(r.prev, `${dest}.dshpurge-prev`);
    assert.equal(read(path.join(dest, "new.txt")), "NEW");
    assert.equal(read(path.join(r.prev, "old.txt")), "OLD");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("commitExtractedDir：prev 已存在时改名带时间戳，不覆盖上一轮的备份", () => {
  const layout = shadowLayout("commit-twice");
  try {
    const dest = path.join(layout.root, "app");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "v1.txt"), "V1");
    const first = commitExtractedDir(dest, (() => {
      const n = `${dest}.dshpurge-next`;
      fs.mkdirSync(n, { recursive: true });
      fs.writeFileSync(path.join(n, "v2.txt"), "V2");
      return n;
    })());
    assert.equal(first.prev, `${dest}.dshpurge-prev`);

    const second = commitExtractedDir(dest, (() => {
      const n = `${dest}.dshpurge-next`;
      fs.mkdirSync(n, { recursive: true });
      fs.writeFileSync(path.join(n, "v3.txt"), "V3");
      return n;
    })());
    assert.match(second.prev, /\.dshpurge-prev-\d+$/, "第二轮必须换名，不能盖掉上一轮备份");
    assert.equal(read(path.join(first.prev, "v1.txt")), "V1", "上一轮备份还在");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("commitExtractedDir：nextDir 不在时直接报错", () => {
  const layout = shadowLayout("commit-missing");
  try {
    assert.throws(() => commitExtractedDir(path.join(layout.root, "app"), ""), /解包目录不存在/);
    assert.throws(() => commitExtractedDir(path.join(layout.root, "app"), path.join(layout.root, "nope")), /解包目录不存在/);
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("commitExtractedDir：第二步 rename 失败时把旧目录放回去，并写 recover.json 保留 nextDir", () => {
  const layout = shadowLayout("commit-fail");
  try {
    const dest = path.join(layout.root, "app");
    const next = `${dest}.dshpurge-next`;
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "old.txt"), "OLD");
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(path.join(next, "new.txt"), "NEW");

    let err = null;
    withRenameFault((from, to) => from === next && to === dest, () => {
      try {
        commitExtractedDir(dest, next);
      } catch (e) {
        err = e;
      }
    });
    assert.notEqual(err, null, "换不上必须抛");
    assert.match(err.message, /commitExtractedDir failed; nextDir kept at/);
    assert.equal(exists(err.recover), true, "要留下救援文件");
    const rec = JSON.parse(read(err.recover));
    assert.equal(rec.destDir, dest);
    assert.equal(rec.nextDir, next);
    assert.equal(rec.prevRestored, true, "旧目录应已放回");
    assert.equal(read(path.join(dest, "old.txt")), "OLD", "回滚后旧内容必须还在");
    assert.equal(exists(next), true, "nextDir 保留给下次重试");
    assert.equal(err.cause && err.cause.code, "EPERM");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("newestPreservedDir：挑 mtime 最新的那份 .dshpurge-prev", () => {
  const layout = shadowLayout("preserved");
  try {
    const dest = path.join(layout.root, "app");
    const parent = path.dirname(dest);
    const base = path.basename(dest);
    fs.mkdirSync(dest, { recursive: true });
    const older = path.join(parent, `${base}.dshpurge-prev`);
    const newer = path.join(parent, `${base}.dshpurge-prev-123`);
    const unrelated = path.join(parent, `${base}-other`);
    for (const d of [older, newer, unrelated]) fs.mkdirSync(d, { recursive: true });
    fs.utimesSync(older, new Date(1000), new Date(1000));
    fs.utimesSync(newer, new Date(5000), new Date(5000));

    assert.equal(newestPreservedDir(dest), newer, "取最新的那份");
    fs.rmSync(newer, { recursive: true, force: true });
    assert.equal(newestPreservedDir(dest), older);
    fs.rmSync(older, { recursive: true, force: true });
    assert.equal(newestPreservedDir(dest), "", "一份都没有时回空串");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("newestPreservedDir：父目录读不到时回空串，不抛", () => {
  withTmp("preserved-missing", (root) => {
    assert.equal(newestPreservedDir(path.join(root, "no", "such", "app")), "");
  });
});

test("restoreExtractedDir：把 prev 放回 dest，dest 上已有的挪成 .dshpurge-failed 后删掉", () => {
  const layout = shadowLayout("restore");
  try {
    const dest = path.join(layout.root, "app");
    const prev = `${dest}.dshpurge-prev`;
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "half.txt"), "HALF");
    fs.mkdirSync(prev, { recursive: true });
    fs.writeFileSync(path.join(prev, "full.txt"), "FULL");

    assert.equal(restoreExtractedDir(dest, prev), true);
    assert.equal(read(path.join(dest, "full.txt")), "FULL");
    assert.equal(exists(path.join(dest, "half.txt")), false, "半成品要让位");
    const leftovers = fs.readdirSync(path.dirname(dest)).filter((n) => n.includes(".dshpurge-failed-"));
    assert.deepEqual(leftovers, [], "换下来的坏目录要删掉");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("restoreExtractedDir：prev 不在时如实回 false", () => {
  withTmp("restore-missing", (root) => {
    const dest = path.join(root, "app");
    assert.equal(restoreExtractedDir(dest, ""), false);
    assert.equal(restoreExtractedDir(dest, path.join(root, "nope")), false);
  });
});

test("restoreExtractedDir：第二步失败时把坏目录换回去并抛，不谎报成功", () => {
  const layout = shadowLayout("restore-fail");
  try {
    const dest = path.join(layout.root, "app");
    const prev = `${dest}.dshpurge-prev`;
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "half.txt"), "HALF");
    fs.mkdirSync(prev, { recursive: true });
    fs.writeFileSync(path.join(prev, "full.txt"), "FULL");

    let err = null;
    withRenameFault((from) => from === prev, () => {
      try {
        restoreExtractedDir(dest, prev);
      } catch (e) {
        err = e;
      }
    });
    assert.notEqual(err, null, "放不回去必须抛");
    assert.equal(read(path.join(prev, "full.txt")), "FULL", "完整副本必须留在 prev");
    assert.equal(read(path.join(dest, "half.txt")), "HALF", "坏目录要换回 dest，不能让 dest 空着");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("restoreExtractedDir：dest 是并发 mkdir 出来的空目录时，让位给完整副本", () => {
  const layout = shadowLayout("restore-empty");
  try {
    const dest = path.join(layout.root, "app");
    const prev = `${dest}.dshpurge-prev`;
    fs.mkdirSync(dest, { recursive: true }); // 空目录
    fs.mkdirSync(prev, { recursive: true });
    fs.writeFileSync(path.join(prev, "full.txt"), "FULL");
    assert.equal(restoreExtractedDir(dest, prev), true);
    assert.equal(read(path.join(dest, "full.txt")), "FULL");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- drill 补强

test("hostFs：fd 方法直接走 node:fs，绝不拿数字 fd 去探 asar 缓存", () => {
  withTmp("fd-noprobe", (root) => {
    const fp = path.join(root, "x.txt");
    fs.writeFileSync(fp, "abc");
    const fd = fs.openSync(fp, "r");
    const original = fs.existsSync;
    let probes = 0;
    fs.existsSync = function counted(...args) {
      probes += 1;
      return original.apply(fs, args);
    };
    try {
      invalidateAsarProbes();
      const st = hostFs.fstatSync(fd);
      assert.equal(st.size, 3);
      hostFs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
      assert.equal(hostFs.fstatSync(fd).size, 3);
    } finally {
      fs.existsSync = original;
      fs.closeSync(fd);
    }
    // 走 route() 的话 fsFor(数字) → computeAsarShadows("5") → asarFileIn → existsSync，探测计数必涨。
    assert.equal(probes, 0, "fd 方法不许触发 asar 探测（#150）");
  });
});

test("asarShadowsPath：名字以 .asar 结尾的目录，在 12 层预算的最后一跳仍然算被映射", () => {
  const layout = shadowLayout("asar-name-tail");
  try {
    const asarDir = path.join(layout.res, "other.asar");
    const hops = (n) => path.join(asarDir, ...Array.from({ length: n }, (_, i) => `d${i}`));
    // 11 跳：第 12 步正好落在 other.asar 自己身上。父目录判定（base 以 .asar 结尾）就是为这一步存在的。
    const nearEdge = hops(11);
    fs.mkdirSync(nearEdge, { recursive: true });
    assert.equal(asarShadowsPath(nearEdge), true, "预算最后一跳必须认 .asar 目录名");
    // 12 跳：第 12 步落在 d0，够不到 other.asar，于是干净。
    const pastEdge = hops(12);
    fs.mkdirSync(pastEdge, { recursive: true });
    assert.equal(asarShadowsPath(pastEdge), false, "再深一跳就出预算");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("extractAsar：header 声明的 jsonSize 超过 256MB 时直接拒绝，不去分配", () => {
  withTmp("huge-json", (root) => {
    const res = path.join(root, "resources");
    fs.mkdirSync(res, { recursive: true });
    const fp = path.join(res, "app.asar");
    const huge = 300 * 1024 * 1024;
    const pre = Buffer.alloc(16);
    pre.writeUInt32LE(4, 0);
    pre.writeUInt32LE(huge + 8, 4);
    pre.writeUInt32LE(huge + 4, 8);
    pre.writeUInt32LE(huge, 12);
    fs.writeFileSync(fp, pre);
    // 没有上限校验的话会先 Buffer.alloc(300MB) 再短读，报的是 asar header short。
    assert.throws(() => extractAsar(fp, path.join(root, "out")), /asar header size invalid/);
    assert.equal(exists(path.join(root, "out")), false, "拒绝之后不许建出目标目录");
  });
});

test("extractAsar：正文比 header 声明的短时报 asar short read，不静默写半截", () => {
  withTmp("short-body", (root) => {
    const res = path.join(root, "resources");
    fs.mkdirSync(res, { recursive: true });
    const fp = path.join(res, "app.asar");
    const header = { files: { app: { files: { "big.bin": { size: 100, offset: "0" } } } } };
    const json = Buffer.from(JSON.stringify(header), "utf8");
    const pre = Buffer.alloc(16);
    pre.writeUInt32LE(4, 0);
    pre.writeUInt32LE(json.length + 8, 4);
    pre.writeUInt32LE(json.length + 4, 8);
    pre.writeUInt32LE(json.length, 12);
    fs.writeFileSync(fp, Buffer.concat([pre, json, Buffer.alloc(10)]));
    // 去掉 n <= 0 这道守卫会变成死循环（left 永不减少），所以这里必须钉住具体报错文案。
    assert.throws(() => extractAsar(fp, path.join(root, "out")), /asar short read at/);
  });
});

test("extractAsarToSide：已经写出部分文件之后才失败，也要把 .dshpurge-next 清干净", () => {
  withTmp("side-partial", (root) => {
    const res = path.join(root, "resources");
    fs.mkdirSync(res, { recursive: true });
    const fp = path.join(res, "app.asar");
    const header = {
      files: {
        app: {
          files: {
            "ok.txt": { size: 2, offset: "0" },
            "big.bin": { size: 100, offset: "2" },
          },
        },
      },
    };
    const json = Buffer.from(JSON.stringify(header), "utf8");
    const pre = Buffer.alloc(16);
    pre.writeUInt32LE(4, 0);
    pre.writeUInt32LE(json.length + 8, 4);
    pre.writeUInt32LE(json.length + 4, 8);
    pre.writeUInt32LE(json.length, 12);
    fs.writeFileSync(fp, Buffer.concat([pre, json, Buffer.from("ok")]));

    const dest = path.join(root, "app");
    const next = `${dest}.dshpurge-next`;
    assert.throws(() => extractAsarToSide(fp, dest), /asar short read at/);
    // 解包过程里 ok.txt 已经落盘了，失败分支必须把整个 next 收走，否则下次启动会拿半成品当解包结果。
    assert.equal(exists(next), false, "半成品目录必须清掉");
  });
});

test("extractAsarToSide：残留的 next 是个文件时先清掉，再正常解包", () => {
  withTmp("side-stale-file", (root) => {
    const res = path.join(root, "resources");
    const asar = writeAsar(res, [
      { rel: "app/main.js", data: "console.log(1)" },
      { rel: "app/lib/util.js", data: "u" },
    ]);
    const dest = path.join(root, "app");
    const next = `${dest}.dshpurge-next`;
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(next, "junk"); // 上一轮中断留下的同名文件，不是目录
    const r = extractAsarToSide(asar, dest);
    assert.equal(r.count, 2);
    assert.equal(read(path.join(next, "app", "main.js")), "console.log(1)");
  });
});

test("restoreExtractedDir：第二步失败时若 dest 被并发建成空目录，先删空目录再把旧目录换回", () => {
  const layout = shadowLayout("restore-empty-race");
  try {
    const dest = path.join(layout.root, "app");
    const prev = `${dest}.dshpurge-prev`;
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "half.txt"), "HALF");
    fs.mkdirSync(prev, { recursive: true });
    fs.writeFileSync(path.join(prev, "full.txt"), "FULL");

    let err = null;
    withRenameFault((from, to) => {
      if (from !== prev) return false;
      fs.mkdirSync(to, { recursive: true }); // 另一个实例刚 mkdir 出来的空目录
      return true;
    }, () => {
      try {
        restoreExtractedDir(dest, prev);
      } catch (e) {
        err = e;
      }
    });
    assert.notEqual(err, null, "放不回去必须抛");
    assert.equal(read(path.join(dest, "half.txt")), "HALF", "空目录要让位，坏目录换回 dest");
    assert.equal(read(path.join(prev, "full.txt")), "FULL", "完整副本仍在 prev");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("extractAsar：symlink 目标在 destDir 内时真的建出链接（建不出就跳过）", (t) => {
  const root = tmpRoot("extract-link-inside");
  try {
    // 某些 Windows 没开开发者模式时 symlinkSync 会 EPERM，实现会静默跳过；那种机器上这条测不了。
    let canLink = true;
    try {
      fs.symlinkSync("target.txt", path.join(root, "probe.lnk"));
    } catch {
      canLink = false;
    }
    if (!canLink) {
      t.skip("本机不允许创建符号链接");
      return;
    }
    const res = path.join(root, "resources");
    const asar = writeAsar(res, [
      { rel: "app/ok.txt", data: "ok" },
      { rel: "app/sub/link.txt", link: "../ok.txt" },
    ]);
    const dest = path.join(root, "out");
    extractAsar(asar, dest);
    const st = fs.lstatSync(path.join(dest, "app", "sub", "link.txt"));
    assert.equal(st.isSymbolicLink(), true, "指向 destDir 内的链接必须建出来");
    const raw = fs.readlinkSync(path.join(dest, "app", "sub", "link.txt"));
    // Windows 建链接时会把 / 写成 \\，两种分隔符都算同一个目标。
    assert.equal(raw.split(path.sep).join("/"), "../ok.txt", "链接内容必须指向归档里写的那个目标");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shouldExtractAsar：升级且没有历史记录时必须解包，不能靠记录比对蒙过去", () => {
  const id = { size: 10, mtimeMs: 100 };
  // 升级了、但记录丢了（recorded 为空）：没有可比对的依据，只能解。
  assert.equal(shouldExtractAsar({ usable: true, identity: id, recorded: null, upgrade: true }), true);
  // 同样的形状但不是在升级：先认这份归档，不解。
  assert.equal(shouldExtractAsar({ usable: true, identity: id, recorded: null, upgrade: false }), false);
});

test("renameAsarAside：旧 .bak 是个目录时先把删掉，删不掉就抛，不把归档挪到一个坏位置上", () => {
  // 这条钉的是「先删旧 .bak」那一行：少了它，renameSync 会撞上目录，
  // 归档留在原地但调用方以为失败原因是 busy，于是换包流程会一直重试。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-bakdir-"));
  try {
    const asar = path.join(root, "app.asar");
    fs.writeFileSync(asar, "ARCHIVE");
    const bak = `${asar}.bak`;
    fs.mkdirSync(bak);
    assert.throws(() => renameAsarAside(asar), /EISDIR|directory/, "删不掉旧 .bak 时必须抛，不能谎报成功");
    assert.equal(fs.existsSync(asar), true, "抛错时归档必须还在原地");
    assert.equal(fs.statSync(bak).isDirectory(), true, "坏掉的 .bak 不被改成文件");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fsFor：判断走的是 asarShadowsPath（靠探针缓存被写入来观测）", () => {
  // 非 Electron 下 diskFs() 与 node:fs 是同一个引用，返回值本身分不出「探测过」与「没探测」。
  // 但 asarShadowsPath 会把结果写进探针缓存，这就是可观测的副作用：
  // 先让缓存空着 → 调 fsFor → 绕过 hostFs 删掉归档（缓存不失效）→ 再问一次。
  // 只有 fsFor 真走了 asarShadowsPath，第二次才会命中缓存说「仍被映射」。
  const layout = shadowLayout("fsfor-probe");
  try {
    const target = path.join(layout.app, "main.js");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "x");
    invalidateAsarProbes();
    fsFor(target);
    fs.rmSync(layout.asar);
    assert.equal(asarShadowsPath(target), true, "fsFor 必须留下探测痕迹（否则每次写文件都要重新 stat）");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

/** 临时接管 fs 上的某个方法（造「系统调用出意外」）。 */
function withFsFault(method, impl, fn) {
  const original = fs[method];
  fs[method] = function patched(...args) {
    const r = impl.apply(this, args);
    if (r && r.__throw) throw r.__throw;
    return r === undefined ? original.apply(this, args) : r;
  };
  try {
    return fn();
  } finally {
    fs[method] = original;
  }
}

test("asarShadowsPath：探测归档时 stat/exists 抛错一律当「没归档」，不把异常抛给调用方", () => {
  // 典型场景：网络盘掉线、权限被改、路径里有非法字符。探测失败必须回 false，
  // 否则每一次 fsFor() 都会把异常带到业务代码里。
  const layout = shadowLayout("probe-throw");
  try {
    const target = path.join(layout.app, "x.js");
    const boom = Object.assign(new Error("EIO: injected"), { code: "EIO" });
    const r = withFsFault("existsSync", (p) => (String(p).endsWith("app.asar") ? { __throw: boom } : undefined), () => {
      invalidateAsarProbes();
      return asarShadowsPath(target);
    });
    assert.equal(r, false, "探测抛错时必须当成没被映射");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("asarArchiveIsFile：stat 抛错时回 false，不当成「归档在」", () => {
  const root = tmpRoot("archive-throw");
  try {
    const fp = path.join(root, "app.asar");
    fs.writeFileSync(fp, "X");
    const boom = Object.assign(new Error("EPERM: injected"), { code: "EPERM" });
    const r = withFsFault("statSync", (p) => (String(p) === fp ? { __throw: boom } : undefined), () => asarArchiveIsFile(fp));
    assert.equal(r, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("commitExtractedDir：换新目录失败、把旧目录放回也失败时，recover.json 要记 prevRestored:false", () => {
  // 两步都失败是换包最坏的结局：新目录没换上、旧目录也没回去。
  // 这时唯一能救场的就是 recover.json —— 它必须如实写 prevRestored:false，
  // 否则下次启动会以为旧目录已经就位，实际 resources/app 是空的。
  const root = tmpRoot("commit-both-fail");
  try {
    const dest = path.join(root, "app");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "old.txt"), "old");
    const next = path.join(root, "next");
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(path.join(next, "new.txt"), "new");

    let err = null;
    try {
      withRenameFault(
        (from) => from === next || from.endsWith(".dshpurge-prev"),
        () => commitExtractedDir(dest, next),
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err, "两步都失败必须抛");
    assert.match(String(err.message), /commitExtractedDir failed/);
    assert.ok(err.recover, "必须带 recover 路径");
    const rec = JSON.parse(fs.readFileSync(err.recover, "utf8"));
    assert.equal(rec.prevRestored, false, "旧目录没放回去就必须如实写 false");
    assert.equal(rec.prev, `${dest}.dshpurge-prev`, "recover.json 里要写明旧目录在哪");
    assert.equal(rec.nextDir, next, "nextDir 也要留着给下次重试");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractAsar：建不出符号链接时跳过那一条，其余条目照常写出", () => {
  // Windows 上建链接需要权限（未开开发者模式 / 非管理员）。
  // 建不出来不能中断解包：主程序文件还在归档里，跳过链接至少能起来。
  const root = tmpRoot("symlink-fail");
  try {
    const asar = path.join(root, "app.asar");
    fs.writeFileSync(asar, makeAsar([
      { rel: "app/ok.txt", data: "OK" },
      { rel: "app/link.txt", link: "./ok.txt" },
      { rel: "app/after.txt", data: "AFTER" },
    ]));
    const dest = path.join(root, "out");
    const boom = Object.assign(new Error("EPERM: injected symlink"), { code: "EPERM" });
    const count = withFsFault("symlinkSync", () => ({ __throw: boom }), () => extractAsar(asar, dest));
    // 现状锁定：链接条目在 count += 1 之前 continue，所以不计入返回的文件数。
    assert.equal(count, 2, "只有写出正文的条目才计数（链接不算）");
    assert.deepEqual(fs.readdirSync(path.join(dest, "app")).sort(), ["after.txt", "ok.txt"], "链接不出现，其它文件都在");
    assert.equal(read(path.join(dest, "app", "after.txt")), "AFTER", "链接之后的条目必须继续写");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("源码形状：extractAsar 的归档句柄在 finally 里关，异常路径也不漏", () => {
  const src = fs.readFileSync(new URL("../lib/extract-asar.js", import.meta.url), "utf8");
  // 本机 Windows 允许删除仍被打开的文件，漏关 fd 从外部观测不到，只能钉源码形状。
  assert.match(src, /\} finally \{\r?\n    afs\.closeSync\(fd\);/, "closeSync 必须在 finally 里");
  assert.match(src, /const fd = afs\.openSync\(asarPath, "r"\);/, "fd 由 archiveFs 打开");
});
