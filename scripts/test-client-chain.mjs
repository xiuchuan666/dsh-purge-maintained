#!/usr/bin/env node
/**
 * test-client-chain —— 前端产物链（client.js）纯函数层的回归测试
 *
 * 全部用临时目录做 fixture，不碰真实 client.js / 真实锚点：
 *   extractFragment        与 build-client.mjs 同算法的片段抽取
 *   extractEmbeddedFragment / structureProblems
 *   fragmentDrift          片段同步检测（防「改源忘 build」）
 *   校验器脚本路径          锚点缺失 / 哈希不符 / 片段过期 → 退出码 1
 *
 * 拆成独立 test()：这一段原本是若干花括号块，块内第一条失败就抛出去，
 * 后面的块一个都不跑。而这里恰恰是「改源忘 build」的唯一防线 —— 出问题那天
 * 最需要一眼看全：是抽取算法变了、结构检查漏了、还是漂移检测失灵。
 */
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	extractEmbeddedFragment, extractFragment, fragmentDrift, structureProblems,
	DRILL_BEGIN, DRILL_END,
} from "./client-chain-lib.mjs";

const tmpRoots = [];
function tmpDir(tag) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-cc-${tag}-`));
	tmpRoots.push(d);
	return d;
}
function write(fp, text) {
	fs.mkdirSync(path.dirname(fp), { recursive: true });
	fs.writeFileSync(fp, text);
}

after(() => {
	for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

/** 最小可抽取的演练台源码（含 factory 体、apply(ctx)、exports 两行、END 标记）。 */
function fixtureDrillSource(applyBody = "const CSS = 'body{}'\nfunction Panel(){return null}\n") {
	return `/** drill client */
window.__ModuleLoader__.load({
  id: 'dsh-purge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    ${applyBody}
    function apply(ctx) {
      ctx.slots.inject('x', () => {})
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
`;
}

/** 包着健康片段的最小 client.js 文本。 */
function fixtureClient(fragment) {
	return `window.__ModuleLoader__.load({ id: "dsh-purge", factory: (require) => {
\t\tconst SettingsRoot = () => null;
\t\t${fragment}
\t\tfunction PurgeDock() { return null }
\t\tctx.slots.register({ id: "dsh-purge-dock" }, () => null);
\t\treturn module.exports
},
})`;
}

// ---------------------------------------------------------- extractFragment

test("extractFragment：抽出 factory 体、改写 apply、删掉 exports.apply", () => {
	const frag = extractFragment(fixtureDrillSource());
	assert.ok(frag.startsWith(DRILL_BEGIN), "片段以 BEGIN 标记开头");
	assert.ok(frag.endsWith(DRILL_END), "片段以 END 标记结尾");
	assert.ok(frag.includes("applyDrillParts()"), "apply 被改写为 applyDrillParts");
	assert.ok(!frag.includes("exports.apply"), "exports.apply 行被删除");
	assert.ok(frag.includes("const CSS = 'body{}'"), "factory 体被保留");
});

test("extractFragment：CRLF 输入与 LF 输入结果一致", () => {
	const frag = extractFragment(fixtureDrillSource());
	assert.equal(extractFragment(fixtureDrillSource().replace(/\n/g, "\r\n")), frag, "CRLF 归一后等价");
});

test("extractFragment：缺 factory 标记要抛错", () => {
	assert.throws(() => extractFragment("no factory here"), /ModuleLoader factory/, "缺 factory 标记抛错");
});

test("extractFragment：缺结束标记要抛错", () => {
	assert.throws(
		() => extractFragment(fixtureDrillSource().replace("\n    return module.exports\n  },\n})", "")),
		/factory end/,
		"缺结束标记抛错",
	);
});

test("extractFragment：缺 apply(ctx) 要抛错", () => {
	// 从模板里整段去掉 function apply(ctx) 定义
	assert.throws(
		() => extractFragment(fixtureDrillSource().replace("    function apply(ctx) {\n      ctx.slots.inject('x', () => {})\n    }\n", "")),
		/apply\(ctx\) not found/,
		"缺 apply(ctx) 抛错",
	);
});

// --------------------------------------------------------- structureProblems

test("structureProblems：健康结构零问题", () => {
	assert.deepEqual(structureProblems(fixtureClient(extractFragment(fixtureDrillSource()))), [], "健康结构零问题");
});

test("structureProblems：BEGIN 标记丢失被检出", () => {
	const noMarker = fixtureClient(extractFragment(fixtureDrillSource())).replace(DRILL_BEGIN, "/* removed */");
	assert.ok(structureProblems(noMarker).some((p) => p.includes("BEGIN")), "BEGIN 丢失被检出");
});

test("structureProblems：标记错序被检出", () => {
	const outOfOrder = fixtureClient("x").replace(
		'ctx.slots.register',
		`${DRILL_END} ${DRILL_BEGIN} ctx.slots.register`,
	);
	assert.ok(structureProblems(outOfOrder).some((p) => p.includes("out of order")), "标记错序被检出");
});

test("structureProblems：dock 锚点 id 丢失被检出", () => {
	const noDock = fixtureClient(extractFragment(fixtureDrillSource())).replace('id: "dsh-purge-dock"', 'id: "other"');
	assert.ok(structureProblems(noDock).some((p) => p.includes("dsh-purge-dock")), "dock 锚点丢失被检出");
});

// ------------------------------------------------------------ fragmentDrift

test("fragmentDrift：同源片段判同步", () => {
	const dir = tmpDir("drift");
	const drillPath = path.join(dir, "drill.js");
	const clientPath = path.join(dir, "client.js");
	fs.writeFileSync(drillPath, fixtureDrillSource());
	fs.writeFileSync(clientPath, fixtureClient(extractFragment(fixtureDrillSource())));
	assert.equal(fragmentDrift(drillPath, clientPath).drifted, false, "同源片段判同步");
});

test("fragmentDrift：改源忘 build 判过期，且期望片段来自新源", () => {
	const dir = tmpDir("drift2");
	const drillPath = path.join(dir, "drill.js");
	const clientPath = path.join(dir, "client.js");
	fs.writeFileSync(drillPath, fixtureDrillSource());
	fs.writeFileSync(clientPath, fixtureClient(extractFragment(fixtureDrillSource())));

	fs.writeFileSync(drillPath, fixtureDrillSource("const CSS = 'changed'\n"));
	const r = fragmentDrift(drillPath, clientPath);
	assert.equal(r.drifted, true, "源变后未重嵌判过期");
	assert.ok(!r.expected.includes("body{}") || r.expected.includes("changed"), "期望片段来自新源");
});

test("fragmentDrift：重嵌之后恢复同步", () => {
	const dir = tmpDir("drift3");
	const drillPath = path.join(dir, "drill.js");
	const clientPath = path.join(dir, "client.js");
	fs.writeFileSync(drillPath, fixtureDrillSource("const CSS = 'changed'\n"));
	fs.writeFileSync(clientPath, fixtureClient(extractFragment(fs.readFileSync(drillPath, "utf8"))));
	assert.equal(fragmentDrift(drillPath, clientPath).drifted, false, "重嵌后恢复同步");
});

// ------------------------------------------------------- 校验器脚本

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const checkPath = path.join(repoRoot, "scripts", "check-client.mjs");

test("check-client：真实仓库必须通过（兼验两个抽取算法一致）", () => {
	// 对真实仓库跑一次必须 PASS（这也是对 extractFragment 与 build-client.mjs 算法一致的实仓断言）
	const ok = spawnSync(process.execPath, [checkPath], { cwd: repoRoot, encoding: "utf8" });
	assert.equal(ok.status, 0, `实仓校验必须通过: ${ok.stderr}`);
});

/** 造一个假仓库布局（锚点/记录/客户端/演练台源），返回 { dir, envRoot, anchor }。 */
function fakeRepo(tag) {
	const dir = tmpDir(tag);
	const anchor = fixtureClient(extractFragment(fixtureDrillSource()));
	write(path.join(dir, "docs", "origin", "client-1.1.94.js"), anchor);
	// 篡改一个字符的哈希 → 哈希不符
	write(
		path.join(dir, "docs", "origin", "client-1.1.94.sha256"),
		"0000000000000000000000000000000000000000000000000000000000000000  client-1.1.94.js\n",
	);
	write(path.join(dir, "client.js"), anchor);
	write(path.join(dir, "lib", "redteam", "client.js"), fixtureDrillSource());
	return { dir, envRoot: { ...process.env, DSH_CLIENT_CHAIN_ROOT: dir }, anchor };
}

test("check-client：锚点哈希不符必须退出 1", () => {
	const { dir, envRoot } = fakeRepo("cli-hash");
	const bad = spawnSync(process.execPath, [checkPath], { cwd: dir, env: envRoot, encoding: "utf8" });
	assert.equal(bad.status, 1, "哈希不符必须退出 1");
	assert.ok(bad.stderr.includes("anchor hash mismatch"), "报锚点哈希不符");
});

test("check-client：结构破坏（BEGIN 标记被删）必须退出 1", () => {
	const { dir, envRoot, anchor } = fakeRepo("cli-struct");
	const sum = createHash("sha256").update(anchor).digest("hex");
	write(path.join(dir, "docs", "origin", "client-1.1.94.sha256"), `${sum}  client-1.1.94.js\n`);
	write(path.join(dir, "client.js"), anchor.replace(DRILL_BEGIN, "/* gone */"));
	const bad2 = spawnSync(process.execPath, [checkPath], { cwd: dir, env: envRoot, encoding: "utf8" });
	assert.equal(bad2.status, 1, "结构破坏必须退出 1");
	assert.ok(bad2.stderr.includes("structure"), "报结构问题");
});

test("check-client：片段过期必须退出 1，并提示 build:client", () => {
	const { dir, envRoot, anchor } = fakeRepo("cli-stale");
	const sum = createHash("sha256").update(anchor).digest("hex");
	write(path.join(dir, "docs", "origin", "client-1.1.94.sha256"), `${sum}  client-1.1.94.js\n`);
	write(path.join(dir, "client.js"), anchor);
	// drill 源在 factory 体内部改动且不重嵌 → 片段过期
	// （factory 体外的注释不参与抽取，这正是「只抽 factory 体」语义的一部分）
	write(
		path.join(dir, "lib", "redteam", "client.js"),
		fixtureDrillSource().replace("    function apply(ctx) {", "    /* touched */\n    function apply(ctx) {"),
	);
	const bad3 = spawnSync(process.execPath, [checkPath], { cwd: dir, env: envRoot, encoding: "utf8" });
	assert.equal(bad3.status, 1, "片段过期必须退出 1");
	assert.ok(bad3.stderr.includes("stale"), "报片段过期");
	assert.ok(bad3.stderr.includes("build:client"), "提示运行 build:client");
});

test("extractEmbeddedFragment 能取回嵌进 client 的那一段", () => {
	const anchor = fixtureClient(extractFragment(fixtureDrillSource()));
	const embedded = extractEmbeddedFragment(anchor);
	assert.ok(embedded.startsWith(DRILL_BEGIN));
	assert.ok(embedded.endsWith(DRILL_END));
});

console.log("client chain helpers PASS");
