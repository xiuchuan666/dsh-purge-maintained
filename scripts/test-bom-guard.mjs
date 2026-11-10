/**
 * BOM 守卫单测 / BOM guard test.
 *
 * 覆盖 0.2.2 桌面端「Unexpected token '\uFEFF' … is not valid JSON」这一类救砖场景：
 *   1. 带 BOM 的 profiles/<x>/package.json → scan 报 bom，fix 后首字节不是 BOM 且 JSON 可解析
 *   2. 不带 BOM 的正常清单 → scan 干净，fix 不动文件（mtime 不变）
 *   3. 剥了 BOM 仍解析不过的 JSON → 报 broken，fix 不写盘（不把坏文件写得更坏）
 *   4. cordis.patch.yml 的 BOM 也一并剥掉，且 YAML 内容原样
 *
 * 跑法：node scripts/test-bom-guard.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { scanProfileBom, fixProfileBom, readTextNoBom, hasBom } from "../lib/bom-guard.js";

const BOM = "\uFEFF";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bomguard-"));
const home = path.join(root, "dshhome");
const good = path.join(home, "profiles", "good");
const broken = path.join(home, "profiles", "broken");
const clean = path.join(home, "profiles", "clean");
for (const dir of [good, broken, clean]) fs.mkdirSync(dir, { recursive: true });

// 1) 带 BOM 的合法清单
const goodPkg = { name: "dsh-profile-good", dsh: { profile: { bundles: ["dsh-purge"] } } };
fs.writeFileSync(path.join(good, "package.json"), BOM + JSON.stringify(goodPkg, null, 2) + "\n", "utf8");
fs.writeFileSync(path.join(good, "cordis.patch.yml"), BOM + "- insert:\n    - id: dsh-purge\n", "utf8");

// 2) 正常清单
const cleanPkg = { name: "dsh-profile-clean" };
fs.writeFileSync(path.join(clean, "package.json"), JSON.stringify(cleanPkg, null, 2) + "\n", "utf8");
const cleanStatBefore = fs.statSync(path.join(clean, "package.json")).mtimeMs;

// 3) 剥 BOM 后仍然坏的 JSON
fs.writeFileSync(path.join(broken, "package.json"), BOM + '{ "name": "x", ', "utf8");

const before = scanProfileBom(home);
assert.equal(before.bom.length, 3, `expected 3 BOM manifests, got ${before.bom.length}`);
assert.equal(before.broken.length, 1, `expected 1 broken manifest, got ${before.broken.length}`);
assert.equal(before.ok, false);
console.log("✓ scan: bom=%d broken=%d", before.bom.length, before.broken.length);

const fixed = fixProfileBom(home);
assert.equal(fixed.fixed.length, 2, `expected 2 fixed, got ${fixed.fixed.length}`);
assert.equal(fixed.failed.length, 1, `expected 1 refused, got ${fixed.failed.length}`);
const goodPkgRaw = fs.readFileSync(path.join(good, "package.json"), "utf8");
assert.equal(hasBom(goodPkgRaw), false, "package.json still has BOM");
assert.deepEqual(JSON.parse(goodPkgRaw), goodPkg);
const goodYml = fs.readFileSync(path.join(good, "cordis.patch.yml"), "utf8");
assert.equal(hasBom(goodYml), false, "cordis.patch.yml still has BOM");
assert.equal(goodYml, "- insert:\n    - id: dsh-purge\n");
assert.equal(readTextNoBom(path.join(broken, "package.json")).startsWith("{"), true);
const brokenRaw = fs.readFileSync(path.join(broken, "package.json"), "utf8");
assert.equal(hasBom(brokenRaw), true, "broken manifest must be left untouched");
console.log("✓ fix: fixed=%d refused=%d", fixed.fixed.length, fixed.failed.length);

const after = fixed.report || scanProfileBom(home);
assert.equal(after.bom.length, 1, "only the unrepairable BOM should remain");
assert.equal(after.broken.length, 1);
const cleanStatAfter = fs.statSync(path.join(clean, "package.json")).mtimeMs;
assert.equal(cleanStatAfter, cleanStatBefore, "clean manifest must not be rewritten");
console.log("✓ idempotent: clean manifest untouched, unrepairable one still reported");

fs.rmSync(root, { recursive: true, force: true });
console.log("ALL PASS");
