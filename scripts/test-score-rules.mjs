// lib/redteam/score-rules.js：数据量解析与展示。
//
// parseRowCount 决定「大量敏感信息」这条得分项的读数：只认带量词的写法，
// 否则口令里的 123456、端口号都会被当数据量。formatRows 是告警里的千分位读数。
import test from "node:test";
import assert from "node:assert/strict";

import { parseRowCount, formatRows, SENSITIVE_DATA_MIN_ROWS } from "../lib/redteam/score-rules.js";

test("带条/行/记录量词的写法都认", () => {
  assert.equal(parseRowCount("导出 120 万条"), 1200000);
  assert.equal(parseRowCount("1300万行"), 13000000);
  assert.equal(parseRowCount("1,200,000 条记录"), 1200000);
  assert.equal(parseRowCount("1200000 records"), 1200000);
});

test("只写中文量级、没写条/行也认（例如「导出 120 万」）", () => {
  assert.equal(parseRowCount("导出 120 万"), 1200000);
  assert.equal(parseRowCount("约 3 千"), 3000);
  assert.equal(parseRowCount("2.5 亿"), 250000000);
});

test("裸数字不认（口令、端口号不许被当数据量），解析不出返回 null", () => {
  assert.equal(parseRowCount("123456"), null);
  assert.equal(parseRowCount("端口 6379"), null);
  assert.equal(parseRowCount(""), null);
  assert.equal(parseRowCount(null), null);
});

test("formatRows 输出千分位，门槛常量仍是 100 万", () => {
  assert.equal(formatRows(1234567), "1,234,567");
  assert.equal(formatRows(SENSITIVE_DATA_MIN_ROWS), "1,000,000");
  assert.equal(formatRows(0), "0");
});
