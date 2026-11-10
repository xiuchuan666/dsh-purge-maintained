/**
 * 前端产物链校验（只读）：
 *   1. 锚点 docs/origin/client-1.1.94.js 与其 .sha256 记录一致；
 *   2. 当前 client.js 结构完整（DRILL 标记 + dock 补丁锚点）；
 *   3. 嵌入的演练台片段与 lib/redteam/client.js 现抽片段一致（防「改源忘 build」）。
 *
 * 用法：node scripts/check-client.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fragmentDrift, structureProblems } from "./client-chain-lib.mjs";

const root = process.env.DSH_CLIENT_CHAIN_ROOT
	|| join(dirname(fileURLToPath(import.meta.url)), "..");
const anchorPath = join(root, "docs", "origin", "client-1.1.94.js");
const anchorSumPath = join(root, "docs", "origin", "client-1.1.94.sha256");
const clientPath = join(root, "client.js");
const drillSrcPath = join(root, "lib", "redteam", "client.js");

let failed = false;

// 1) 锚点哈希
if (!existsSync(anchorPath)) {
	console.error("[client] FAIL missing anchor docs/origin/client-1.1.94.js");
	failed = true;
} else {
	const actual = createHash("sha256").update(readFileSync(anchorPath)).digest("hex");
	const expected = readFileSync(anchorSumPath, "utf8").trim().split(/\s+/)[0];
	if (actual !== expected) {
		console.error(`[client] FAIL anchor hash mismatch: expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…`);
		failed = true;
	} else {
		console.log(`[client] anchor OK ${actual.slice(0, 16)}…`);
	}
}

// 2) 结构完整 + 3) 片段同步
if (!existsSync(clientPath)) {
	console.error("[client] FAIL client.js not found");
	process.exit(1);
}
const problems = structureProblems(readFileSync(clientPath, "utf8"));
if (problems.length > 0) {
	for (const p of problems) console.error(`[client] FAIL structure: ${p}`);
	failed = true;
} else {
	console.log("[client] structure OK (drill markers, dock anchors)");
}

const drift = fragmentDrift(drillSrcPath, clientPath);
if (drift.drifted) {
	console.error("[client] FAIL drill fragment is stale: lib/redteam/client.js changed but client.js was not rebuilt");
	console.error("[client]        run: npm run build:client");
	failed = true;
} else {
	console.log("[client] drill fragment in sync with lib/redteam/client.js");
}

if (failed) process.exit(1);
console.log("[client] PASS");
