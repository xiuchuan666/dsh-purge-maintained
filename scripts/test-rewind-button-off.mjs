#!/usr/bin/env node
/**
 * 「回退」按钮下线（2026-11-15 用户要求）
 *
 * 这条测试不测行为，只锁结构：按钮的挂载点必须处于 REWIND_BUTTON_ENABLED=false 的关闭态，
 * 同时 RewindDockMount / i18n 文案 / 后端 /rewind 一条都不许被顺手删掉——
 * 前者是「想恢复只改一个常量」，后者是「/rewind 命令与补丁 #56/#58/#75/#77 还在用」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "client.js"), "utf8");

test("回退按钮：开关常量为 false，挂载点被它挡住", () => {
	assert.match(src, /const REWIND_BUTTON_ENABLED = false;/);
	assert.match(src, /REWIND_BUTTON_ENABLED \? h\(RewindDockMount\) : null/);
});

test("回退按钮：拿掉挂载点但不许连坐删掉别的", () => {
	// 组件本体留着，方便把常量改回 true 就复活
	assert.match(src, /function RewindDockMount\(\)/);
	assert.match(src, /class RewindSafe extends Component/);
	// i18n 文案留着：/rewind 命令的提示与回填仍在用同一套 key
	assert.match(src, /"rewind\.label": "回退"/);
	assert.match(src, /"rewind\.round\.hint"/);
	// 监听仍在：/rewind 命令回退后靠它把新会话拉起来、把上一句塞回输入框
	assert.match(src, /installRewindWatch\(ctx\)/);
});
