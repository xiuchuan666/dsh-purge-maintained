/**
 * client.js 产物链共享逻辑。
 *
 * build-client.mjs 的「从 lib/redteam/client.js 抽 factory 体并改写」算法在这里
 * 以纯函数形式存在一份；校验器（check-client.mjs）用同一份逻辑做同步检测，
 * 保证「校验器说同步」与「build-client 实际会写出什么」不会分叉。
 *
 * 本文件只被校验器和测试引用；build-client.mjs 保持原样不动。
 */
import { readFileSync } from "node:fs";

export const DRILL_BEGIN = "/* __DSH_PURGE_DRILL_BEGIN__ */";
export const DRILL_END = "/* __DSH_PURGE_DRILL_END__ */";

// 与 build-client.mjs 逐字相同的定位标记
const START_MARK = "factory: (require) => {";
const END_MARK = "\n    return module.exports\n  },\n})";

/**
 * 从演练台源码文本抽出「可嵌入片段」。
 * 逐字复刻 scripts/build-client.mjs 的算法：
 *   1. 定位 factory 体（START_MARK 之后到 END_MARK 之前）；
 *   2. 删掉 exports.apply / exports.inject 两行；
 *   3. 把最后一个 function apply(ctx) {…} 整体替换为 applyDrillParts()；
 *   4. 包上 IIFE 外壳与 BEGIN/END 标记，得到最终嵌入文本。
 * 输入先归一 CRLF→LF（与 build-client.mjs 的 readFileSync().replace 一致）。
 */
export function extractFragment(drillSourceText) {
	const raw = drillSourceText.replace(/\r\n/g, "\n");
	const start = raw.indexOf(START_MARK);
	if (start < 0) throw new Error("cannot find ModuleLoader factory in drill client");
	const end = raw.lastIndexOf(END_MARK);
	if (end < 0) throw new Error("cannot find factory end in drill client");
	let body = raw.slice(start + START_MARK.length, end);

	body = body
		.replace(/\n\s*exports\.apply\s*=\s*apply\s*\n/, "\n")
		.replace(/\n\s*exports\.inject\s*=\s*inject\s*\n/, "\n");

	const applyAt = body.lastIndexOf("function apply(ctx) {");
	if (applyAt < 0) throw new Error("apply(ctx) not found in drill client");
	let d = 0;
	let j = body.indexOf("{", applyAt);
	for (; j < body.length; j += 1) {
		const ch = body[j];
		if (ch === "{") d += 1;
		else if (ch === "}") {
			d -= 1;
			if (d === 0) {
				j += 1;
				break;
			}
		}
	}
	const applyParts = `function applyDrillParts() {
      return { CSS: CSS, Panel: Panel, setUI: setUI, useUI: useUI, isFullWindow: isFullWindow, setDockWidth: setDockWidth };
    }
`;
	body = body.slice(0, applyAt) + applyParts + body.slice(j);

	return `${DRILL_BEGIN}
		// 内嵌演练台（源码在 lib/redteam，已并进本插件）
		const __dshPurgeDrill = (() => {
			var module = { exports: {} };
			var exports = module.exports;
${body}
			return applyDrillParts();
		})();
${DRILL_END}`;
}

/** 从 client.js 文本里取 BEGIN/END 标记之间的片段（含标记本身）。 */
export function extractEmbeddedFragment(clientText) {
	const text = clientText.replace(/\r\n/g, "\n");
	const beginAt = text.indexOf(DRILL_BEGIN);
	const endAt = text.indexOf(DRILL_END);
	if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
		throw new Error("client.js missing drill markers");
	}
	return text.slice(beginAt, endAt + DRILL_END.length);
}

/**
 * 结构完整性检查：两个 DRILL 标记存在且顺序正确、dock 补丁锚点在。
 * 返回错误字符串数组；空数组 = 结构完整。
 */
export function structureProblems(clientText) {
	const problems = [];
	const text = clientText.replace(/\r\n/g, "\n");
	const beginAt = text.indexOf(DRILL_BEGIN);
	const endAt = text.indexOf(DRILL_END);
	if (beginAt < 0) problems.push("missing DRILL_BEGIN marker");
	if (endAt < 0) problems.push("missing DRILL_END marker");
	if (beginAt >= 0 && endAt >= 0 && endAt < beginAt) problems.push("drill markers out of order");
	if (!text.includes('id: "dsh-purge-dock"')) problems.push("missing dock patch anchor (id: dsh-purge-dock)");
	if (!text.includes("function PurgeDock()")) problems.push("missing dock patch anchor (PurgeDock)");
	return problems;
}

/** 便捷：读两个文件并返回 {drifted, expected, actual}，片段级比较（已归一 LF）。 */
export function fragmentDrift(drillSourcePath, clientPath) {
	const expected = extractFragment(readFileSync(drillSourcePath, "utf8"));
	const actual = extractEmbeddedFragment(readFileSync(clientPath, "utf8"));
	return { drifted: expected !== actual, expected, actual };
}
