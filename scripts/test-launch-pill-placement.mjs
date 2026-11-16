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

/* 2026-11-16 用户反馈「悬浮窗有点碍事，只有点应用时才有用」：默认收成一个圆点，hover 或钉住才展开。 */
test("浮标：默认收成圆点，hover / 钉住才展开成完整胶囊", () => {
	assert.match(src, /\.dshp-launch\{position:fixed;right:16px;bottom:var\(--dshp-launch-bottom,132px\)[^}]*max-width:26px/);
	assert.match(src, /\.dshp-launch\[data-hover="1"\],\.dshp-launch\[data-pin="1"\]\{max-width:260px/);
	assert.match(src, /\.dshp-launch \.dshp-launch-label\{display:none/);
	assert.match(src, /\[data-hover="1"\] \.dshp-launch-label,[^{]*\[data-pin="1"\] \.dshp-launch-label\{display:inline\}/);
	/* 只锁 .dshp-launch 自己那条；hero-chip 的 min-width:max-content 是另一回事。 */
	assert.match(src, /\.dshp-launch\{font-size:13px!important;line-height:1!important;font-weight:600!important;min-width:0!important/);
});

test("浮标：钉住状态持久化，并在面板与浮标之间同步", () => {
	assert.match(src, /const LAUNCH_PIN_KEY = "dshp\.launchPin"/);
	assert.match(src, /localStorage\.setItem\(LAUNCH_PIN_KEY/);
	assert.match(src, /new CustomEvent\("dshp:launch-pin"/);
	assert.match(src, /addEventListener\("dshp:launch-pin"/);
	assert.match(src, /useState\(readLaunchPin\)/);
	assert.match(src, /t\("dock\.pinOn"\)/);
});

test("浮标：hover 离开后定时收回，圆点与文字互斥显示", () => {
	assert.match(src, /hoverTimer\.current = setTimeout\(\(\) => \{ hoverTimer\.current = 0; setHover\(false\); \}, 900\)/);
	assert.match(src, /onMouseLeave: onLeave/);
	assert.match(src, /className: "dshp-launch-dot"/);
	assert.match(src, /className: "dshp-launch-label"/);
});
