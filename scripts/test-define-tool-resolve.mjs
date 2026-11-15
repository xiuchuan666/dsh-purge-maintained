/**
 * lib/redteam/tools.js 的 defineTool 解析链与 schema 封口（补 test-redteam-tools.mjs 没覆盖的两条出路）。
 *
 * 守卫点：
 *   - loadDefineTool：插件自己的 node_modules 里没有 @deepseek-ai/dsh-tools 时，必须继续按候选
 *     路径扫宿主；全都扫不到要抛错，不许返回 undefined —— 上层会拿 undefined 当 function 调用，
 *     报错信息完全对不上现场。
 *   - sealObjectSchemas：0.2.1 起任何 type=object 都必须显式 additionalProperties，
 *     否则整份红队预设加载失败；递归必须进 properties 每一层。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadDefineTool,
  resolveDefineTool,
  sealObjectSchemas,
} from "../lib/redteam/tools.js";

test("loadDefineTool：拿不到 @deepseek-ai/dsh-tools 时要么给出函数，要么抛错，绝不静默返回 undefined", () => {
  let out;
  let err = null;
  try {
    out = loadDefineTool();
  } catch (e) {
    err = e;
  }
  if (err) {
    assert.match(String(err.message), /cannot resolve @deepseek-ai\/dsh-tools from host/);
  } else {
    assert.equal(typeof out, "function");
  }
});

test("resolveDefineTool：候选路径全都不存在时抛错，空/坏候选不许交给 createRequire", () => {
  assert.throws(() => resolveDefineTool([]), /cannot resolve @deepseek-ai\/dsh-tools from host/);
  assert.throws(
    () => resolveDefineTool([undefined, "", "Z:/definitely/not/here", null]),
    /cannot resolve @deepseek-ai\/dsh-tools from host/,
  );
  assert.throws(() => resolveDefineTool(), /cannot resolve/);
});

test("sealObjectSchemas：非对象原样返回，数组原地逐项递归，object 缺 additionalProperties 时按有无 properties 补", () => {
  assert.equal(sealObjectSchemas(null), null);
  assert.equal(sealObjectSchemas(undefined), undefined);
  assert.equal(sealObjectSchemas("x"), "x");
  assert.equal(sealObjectSchemas(7), 7);

  const arr = [{ type: "object", properties: { a: { type: "string" } } }];
  assert.equal(sealObjectSchemas(arr), arr, "数组返回同一引用（原地改）");
  assert.equal(arr[0].additionalProperties, false, "有 properties → 收口成 false");

  const openBag = { type: "object" };
  sealObjectSchemas(openBag);
  assert.equal(openBag.additionalProperties, true, "没有 properties → 只能是 true（真开放字典）");

  const explicit = { type: "object", additionalProperties: true };
  sealObjectSchemas(explicit);
  assert.equal(explicit.additionalProperties, true, "已经显式声明的绝不覆盖");
});

test("sealObjectSchemas：递归进 properties 的值，嵌套 object 同样要封口", () => {
  const schema = {
    type: "object",
    properties: {
      target: { type: "object", properties: { host: { type: "string" } } },
    },
  };
  sealObjectSchemas(schema);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.target.additionalProperties, false);
});
