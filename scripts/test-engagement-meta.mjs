// lib/redteam/engagement-meta.js：得分阶段（stage）的判定顺序。
//
// 顺序就是用户可见行为：stage_code 优先、类型特判次之、再看资产内外网归属、
// 最后按 target 里的地址猜。任何一环静默失效，报告里「边界突破 / 内网横向」
// 就会被归到错误的阶段，用户按阶段做的补测清单也会跟着错。
import test from "node:test";
import assert from "node:assert/strict";

import { scoreStageOf, LEGACY_STAGE_MAP } from "../lib/redteam/engagement-meta.js";

test("① hit.stage_code 直接说了就用它，不看其它线索", () => {
  assert.equal(scoreStageOf({ stage_code: "boundary", target: "10.0.0.5" }, "internal"), "boundary");
  assert.equal(scoreStageOf({ stage_code: "target", code: "vpn" }, "external"), "target");
  assert.notEqual(scoreStageOf({ stage_code: "" }, "internal"), "");
});

test("③ 有资产归属时按归属判：internal → internal，external → internet", () => {
  assert.equal(scoreStageOf({ code: "unknown-code" }, "internal"), "internal");
  assert.equal(scoreStageOf({ code: "unknown-code" }, "external"), "internet");
});

test("④ 没资产归属时按 target 里的 IP 判内外网", () => {
  assert.equal(scoreStageOf({ code: "unknown-code", target: "10.1.2.3:8080" }, null), "internal");
  assert.equal(scoreStageOf({ code: "unknown-code", target: "192.168.10.1" }, undefined), "internal");
  assert.equal(scoreStageOf({ code: "unknown-code", target: "203.0.113.10" }, null), "internet");
});

test("④ 全无线索（域名 / 空 hit）落到 internet，不能抛错", () => {
  assert.equal(scoreStageOf({ code: "unknown-code", target: "www.example.com" }, null), "internet");
  assert.equal(scoreStageOf({ target: "example.com" }, null), "internet");
  assert.equal(scoreStageOf(null, null), "internet");
  assert.equal(scoreStageOf(undefined, undefined), "internet");
});

test("旧攻击链 stage 的兜底映射表仍在（报告回放要认旧字段）", () => {
  assert.equal(typeof LEGACY_STAGE_MAP, "object");
  assert.deepEqual(Object.keys(LEGACY_STAGE_MAP).length > 0, true);
});
