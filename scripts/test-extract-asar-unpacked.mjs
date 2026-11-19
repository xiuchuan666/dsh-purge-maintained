import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { overlayAsarUnpacked, missingUnpackedFiles, ensureUnpackedOverlay } from "../lib/extract-asar.js";

function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-unpacked-"));
  const resources = path.join(root, "resources");
  fs.mkdirSync(resources, { recursive: true });
  const asar = path.join(resources, "app.asar");
  fs.writeFileSync(asar, "fake-asar");
  const unpacked = path.join(resources, "app.asar.unpacked", "dsh", "node_modules", "native");
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(unpacked, "require_builtin.node"), Buffer.from([1, 2, 3, 4]));
  const dest = path.join(root, "app");
  fs.mkdirSync(dest, { recursive: true });
  return { root, asar, dest };
}

test("missingUnpackedFiles：解包目录缺原生文件时按相对路径列出", () => {
  const l = layout();
  try {
    assert.deepEqual(missingUnpackedFiles(l.asar, l.dest), ["dsh/node_modules/native/require_builtin.node"]);
  } finally {
    fs.rmSync(l.root, { recursive: true, force: true });
  }
});

test("missingUnpackedFiles：overlayAsarUnpacked 补齐后为空，且不改写已有同尺寸文件", () => {
  const l = layout();
  try {
    const r = overlayAsarUnpacked(l.asar, l.dest);
    assert.equal(r.copied, 1);
    assert.deepEqual(missingUnpackedFiles(l.asar, l.dest), []);
    assert.equal(overlayAsarUnpacked(l.asar, l.dest).copied, 0);
  } finally {
    fs.rmSync(l.root, { recursive: true, force: true });
  }
});

test("ensureUnpackedOverlay：补齐不了就抛（目标位置被目录占住）", () => {
  const l = layout();
  try {
    const blocked = path.join(l.dest, "dsh", "node_modules", "native", "require_builtin.node");
    fs.mkdirSync(blocked, { recursive: true });
    assert.throws(() => ensureUnpackedOverlay(l.asar, l.dest), /unpacked 原生文件/);
  } finally {
    fs.rmSync(l.root, { recursive: true, force: true });
  }
});

test("missingUnpackedFiles：目标文件尺寸不符也算缺失（防截断/空壳）", () => {
  const l = layout();
  try {
    overlayAsarUnpacked(l.asar, l.dest);
    const target = path.join(l.dest, "dsh", "node_modules", "native", "require_builtin.node");
    fs.writeFileSync(target, Buffer.from([9]));
    assert.deepEqual(missingUnpackedFiles(l.asar, l.dest), ["dsh/node_modules/native/require_builtin.node"]);
  } finally {
    fs.rmSync(l.root, { recursive: true, force: true });
  }
});
