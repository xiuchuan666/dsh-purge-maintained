// lib/preset-default.js 的边角：`configValue` / `configSet` 的那几个 catch，
// 定时器的「再排一次就先撤掉上一份」，以及删遗留目录失败时的返回。
//
// 为什么单独一份：`scripts/test-preset-default.mjs` 管的是「哪些写法算本插件预设、
// 落到文件里是什么样」。这里管的是「节点是怪对象时还能不能改得动」——判错的表现是
// 停用之后宿主的 selectedDefault 还指着 redteam，于是 DSH 下次启动直接硬抛（#108），
// 而停用流程已经「成功」返回了，控制台里没有任何一行提到本插件。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const CJS_FS = require("node:fs");

const {
  clearOwnedSelectedDefault,
  scheduleClearOwnedSelectedDefault,
  cancelClearOwnedSelectedDefault,
  removeStaleAgentPresetDir,
} = await import("../lib/preset-default.js");

const ROOT = mkdtempSync(join(tmpdir(), "dshp-preset-edges-"));
test.after(() => rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }));

const makeHome = (files = {}) => {
  const root = mkdtempSync(join(ROOT, "home-"));
  for (const [rel, text] of Object.entries(files)) {
    const fp = join(root, rel);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, text, "utf8");
  }
  return root;
};

/** settings 侧什么都不给，agentPresets 的 config 里放一个自造的 selectedDefault 节点。 */
const ctxWithBag = (bag) => ({
  get: (key) => (key === "agentPresets" ? { config: bag } : undefined),
});

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ── configValue：get() 抛错后还要看 value ────────────────────────────────

test("configValue：get() 抛错时退回读 value，改得动就照改", () => {
  const node = {
    get() {
      throw new Error("get boom");
    },
    value: "redteam",
  };
  const home = makeHome();
  const report = clearOwnedSelectedDefault({ ctx: ctxWithBag({ selectedDefault: node, default: "standard" }), dshHome: home });
  assert.equal(report.live, true);
  assert.equal(node.value, "standard");
});

test("configValue：value 抛错的节点当作「没有值」，后面的袋子照常修", () => {
  const broken = {
    get() {
      throw new Error("get boom");
    },
    get value() {
      throw new Error("value boom");
    },
  };
  const second = { value: "redteam" };
  const home = makeHome({ "profiles/p1/cordis.patch.yml": "selectedDefault: redteam\n" });
  // 两个袋子：第一家是毒药，第二家能修。value 抛错若漏出去，循环就断在第一家
  const ctx = {
    get: (key) => {
      if (key === "agentPresets") return { config: { selectedDefault: broken } };
      if (key === "settings") return { get: () => ({ config: { selectedDefault: second, default: "standard" } }) };
      return undefined;
    },
  };
  let report = null;
  assert.doesNotThrow(() => {
    report = clearOwnedSelectedDefault({ ctx, dshHome: home });
  });
  assert.equal(report.live, true);
  assert.equal(second.value, "standard");
  // 文件侧也照修
  assert.deepEqual(report.files, [join(home, "profiles", "p1", "cordis.patch.yml")]);
  assert.equal(readFileSync(report.files[0], "utf8"), "selectedDefault: standard\n");
});

// ── configSet：set() 抛错后还要能写 value ───────────────────────────────

test("configSet：set() 抛错时退回属性赋值，仍然算改好了", () => {
  const node = {
    set() {
      throw new Error("set boom");
    },
    value: "redteam",
  };
  const home = makeHome();
  const report = clearOwnedSelectedDefault({ ctx: ctxWithBag({ selectedDefault: node, default: "standard" }), dshHome: home });
  assert.equal(report.live, true);
  assert.equal(node.value, "standard");
});

test("configSet：set() 与属性赋值都失败时回 false，live 侧记成没改好", () => {
  const node = {
    set() {
      throw new Error("set boom");
    },
    get value() {
      return "redteam";
    },
    set value(_v) {
      throw new Error("read only");
    },
  };
  const home = makeHome();
  const report = clearOwnedSelectedDefault({ ctx: ctxWithBag({ selectedDefault: node, default: "standard" }), dshHome: home });
  assert.equal(report.live, false);
});

test("configSet：set() 成功了就不再碰属性（免得两种写法互相打架）", () => {
  let viaSet = 0;
  const node = {
    value: "redteam",
    set(v) {
      viaSet += 1;
      this.value = v;
    },
  };
  const home = makeHome();
  const report = clearOwnedSelectedDefault({ ctx: ctxWithBag({ selectedDefault: node, default: "standard" }), dshHome: home });
  assert.equal(report.live, true);
  assert.equal(node.value, "standard");
  assert.equal(viaSet, 1);
});

// ── 定时器：再排一次就先撤掉上一份 ──────────────────────────────────────

test("scheduleClearOwnedSelectedDefault：连排两次只有最后那份生效，前一份被撤掉", async () => {
  const first = makeHome({ "profiles/p1/cordis.patch.yml": "selectedDefault: redteam\n" });
  const second = makeHome({ "profiles/p2/cordis.patch.yml": "selectedDefault: redteam\n" });
  scheduleClearOwnedSelectedDefault({ dshHome: first });
  scheduleClearOwnedSelectedDefault({ dshHome: second });
  await tick(950);
  // 第一份被 clearTimeout 撤掉 → 它的文件一个字节没动
  assert.equal(readFileSync(join(first, "profiles", "p1", "cordis.patch.yml"), "utf8"), "selectedDefault: redteam\n");
  assert.equal(readFileSync(join(second, "profiles", "p2", "cordis.patch.yml"), "utf8"), "selectedDefault: standard\n");
  cancelClearOwnedSelectedDefault();
});

// ── 删遗留目录：删不掉就回 false ────────────────────────────────────────

test("removeStaleAgentPresetDir：目录在但 rmSync 失败时回 false 而不抛", () => {
  const home = makeHome({ ".agent-presets/redteam/agent.yml": "x: 1\n" });
  const realRm = CJS_FS.rmSync;
  CJS_FS.rmSync = () => {
    throw new Error("rm boom");
  };
  syncBuiltinESMExports();
  try {
    let out = null;
    assert.doesNotThrow(() => {
      out = removeStaleAgentPresetDir(home);
    });
    assert.equal(out, false);
    // 目录还在（失败就是没删）
    assert.equal(fs.existsSync(join(home, ".agent-presets", "redteam", "agent.yml")), true);
  } finally {
    CJS_FS.rmSync = realRm;
    syncBuiltinESMExports();
  }
});

test("removeStaleAgentPresetDir：成功后目录真的没了，第二次调回 false", () => {
  const home = makeHome({ ".agent-presets/redteam/agent.yml": "x: 1\n" });
  assert.equal(removeStaleAgentPresetDir(home), true);
  assert.equal(fs.existsSync(join(home, ".agent-presets", "redteam")), false);
  assert.equal(removeStaleAgentPresetDir(home), false);
});
