import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectHost, missingFromUnpacked, findRequireBuiltin, hostLayout } from "../lib/host-integrity.js";

function fixture({ native = true, unpackedFile = true, appHasFile = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-host-"));
  const resources = path.join(root, "resources");
  const app = path.join(resources, "app");
  fs.mkdirSync(path.join(app, "dsh", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: "0.2.2-rc.5" }));
  fs.writeFileSync(path.join(app, "dsh", "package.json"), JSON.stringify({ version: "0.2.2-rc.5" }));
  fs.writeFileSync(path.join(resources, "app.asar"), "x");
  if (native) {
    const dir = path.join(app, "dsh", "node_modules", "node-addon-require-builtin", "build", "nodeabi", "node-v149-win32-x64-msvc");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "require_builtin.node"), Buffer.from([1, 2, 3]));
  }
  if (unpackedFile) {
    const dir = path.join(resources, "app.asar.unpacked", "dsh", "node_modules", "native");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([4, 5]));
    if (appHasFile) {
      const dest = path.join(app, "dsh", "node_modules", "native");
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "blob.bin"), Buffer.from([4, 5]));
    }
  }
  return { root, resources, app };
}

test("inspectHost：齐全的树 ok，版本与原生绑定都读到", () => {
  const f = fixture();
  try {
    const r = inspectHost(f.resources);
    assert.equal(r.ok, true);
    assert.equal(r.version.dsh, "0.2.2-rc.5");
    assert.equal(r.requireBuiltin.length, 1);
    assert.deepEqual(r.problems, []);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("inspectHost：缺 unpacked 文件时报 FAIL 并给出首个路径", () => {
  const f = fixture({ appHasFile: false });
  try {
    const r = inspectHost(f.resources);
    assert.equal(r.ok, false);
    assert.equal(r.missing.length, 1);
    assert.match(r.problems[0], /缺 1 个 unpacked 文件/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("inspectHost：没有 require_builtin 的 .node 时报 FAIL（崩溃同款）", () => {
  const f = fixture({ native: false });
  try {
    const r = inspectHost(f.resources);
    assert.equal(r.ok, false);
    assert.match(r.problems.join("\n"), /node-addon-require-builtin/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("inspectHost：没有 app 目录直接 FAIL，不抛", () => {
  const f = fixture();
  try {
    fs.rmSync(path.join(f.resources, "app"), { recursive: true, force: true });
    const r = inspectHost(f.resources);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /app 目录不存在/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("hostLayout / missingFromUnpacked：相对路径统一正斜杠且尺寸不符也算缺", () => {
  const f = fixture();
  try {
    const layout = hostLayout(f.resources);
    assert.equal(layout.appDir, path.join(f.resources, "app"));
    fs.writeFileSync(path.join(f.app, "dsh", "node_modules", "native", "blob.bin"), Buffer.from([9]));
    const r = missingFromUnpacked(layout);
    assert.deepEqual(r.missing, ["dsh/node_modules/native/blob.bin"]);
    assert.equal(findRequireBuiltin(f.app).length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
