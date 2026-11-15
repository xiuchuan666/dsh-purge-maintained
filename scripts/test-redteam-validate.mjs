// lib/redteam/validate.js 的路径守卫：数据库里的 path 列是不可信输入。
//
// 判松了 = 面板点一下就把 /etc/passwd 读到浏览器；判紧了 = 正常靶标文件读不到。
// 这里钉住「祖先不存在时也不再假装规范化成功」这条兜底（realish 的 40 次上限）。
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { assertPathWithin, normalizeShellType, normalizeShellStatus } from "../lib/redteam/validate.js";

test("祖先全都不存在、40 次上探用完时退回原字符串，不抛错也不假装已 realpath", () => {
  // 45 层不存在的目录：realish 每层都 realpath 失败，走满 40 次仍到不了根
  const deep = path.resolve(os.tmpdir(), ...Array.from({ length: 45 }, (_, i) => `nx-${i}`));
  assert.equal(assertPathWithin(deep, [deep]), deep);
});

test("路径在允许根内时放行，越界时抛错（不许静默返回内容）", () => {
  const root = path.resolve(os.tmpdir(), "target-root");
  const inside = path.join(root, "loot", "shells.txt");
  assert.equal(assertPathWithin(inside, [root]), inside);
  assert.throws(
    () => assertPathWithin(path.resolve(os.tmpdir(), "elsewhere", "x.txt"), [root]),
    /path outside allowed roots/,
  );
});

test("根本不存在的祖先（Windows 盘符 / POSIX 相对路径）也能给出确定结论", () => {
  const tmp = path.resolve(os.tmpdir());
  if (process.platform !== "win32") {
    // POSIX 上 "Z:\\..." 只是相对路径，按 cwd 解析后落在 /tmp 之外 —— 必须照样拒绝，
    // 不能因为「这串看着像盘符」就放行（早期写成 doesNotThrow，Linux CI 直接红）。
    assert.throws(() => assertPathWithin("Z:\\no-such-drive\\sub", [tmp]), /path outside allowed roots/);
    // 允许根之内、哪怕整条路径都不存在，仍要放行并原样返回
    const inside = path.join(tmp, "no-such-drive", "sub");
    assert.equal(assertPathWithin(inside, [tmp]), inside);
    return;
  }
  const target = "Z:\\no-such-drive\\sub";
  assert.equal(assertPathWithin(target, ["Z:\\no-such-drive"]), target);
});

test("马类型/状态规范化：认得出就归一，认不出就抛错（拼错不许静默存原文）", () => {
  assert.equal(normalizeShellType("冰蝎"), "behinder");
  assert.equal(normalizeShellType("GODZILLA4"), "godzilla");
  assert.equal(normalizeShellType("自定义"), "custom");
  assert.equal(normalizeShellType(""), null);
  assert.throws(() => normalizeShellType("webshell-unknown"), /非法/);
  assert.equal(normalizeShellStatus("UP"), "online");
  assert.equal(normalizeShellStatus(""), "online");
  assert.throws(() => normalizeShellStatus("half-up"), /非法/);
});
