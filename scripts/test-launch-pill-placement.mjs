#!/usr/bin/env node
/**
 * 右下角「dsh-purge」浮标不许压住 comopser 按钮（2026-11-15 用户反馈：主页面上按钮乱飘、挡住别的按钮）
 *
 * 结构锁，不测渲染：
 *   1. 位置不再写死 bottom:16px（那是贴视口底、正好压在输入框发送行上的元凶），改由 --dshp-launch-bottom 驱动；
 *   2. 变量值必须由 purgeComposerTop() 按真实输入元素（textarea / contenteditable）上边界算出来；
 *   3. 入口本身不许被顺手删掉（PurgeLauncher / data-testid 还在，想恢复只改 CSS 变量默认值）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "client.js"), "utf8");

test("浮标：bottom 由 --dshp-launch-bottom 驱动，不再写死 16px", () => {
	assert.match(src, /\.dshp-launch\{position:fixed;right:16px;bottom:var\(--dshp-launch-bottom,132px\)/);
	assert.ok(!/\.dshp-launch\{position:fixed;right:16px;bottom:16px/.test(src), "旧的贴底写法回来了");
});

test("浮标：位置按真实输入元素上边界计算（textarea / contenteditable 优先）", () => {
	assert.match(src, /function purgeComposerTop\(\)/);
	assert.match(src, /textarea, \[contenteditable="true"\]/);
	assert.match(src, /root\.style\.setProperty\("--dshp-launch-bottom", bottom \+ "px"\)/);
	assert.match(src, /const top = purgeComposerTop\(\);/);
});

test("浮标：计算时排除宿主浮标自身，入口与 testid 不许丢", () => {
	assert.match(src, /el\.closest\("\.dshp-dock, \.dshp-launch"\)/);
	assert.match(src, /function PurgeLauncher\(\)/);
	assert.match(src, /"data-testid": "dsh-purge-launch"/);
});
