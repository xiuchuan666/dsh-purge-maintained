/**
 * verify-target-lib —— 把「这棵宿主树上每条补丁是什么状态」这件事单独拿出来
 *
 * 为什么要有这个文件：
 *   scripts/verify-target.mjs 以前在模块顶层算 files / host / compat，导进来就得有
 *   一棵真的宿主树，于是 262 行一行都进不了测试。判定层本身是纯的（给定补丁表、
 *   给定 key→路径表、给定读写函数，结论就定了），混在 CLI 里只是因为当初写在同一个
 *   文件里。
 *
 * 另一件必须记下来的事：这个文件里曾经有两份「平行的判定」——
 *   patchApplied() 与 remainingWork()，各写了一遍 core 里的 marker / pattern 逻辑。
 *   加了 #42 的两条 legacy 守卫之后，core 的版本与这里的版本结论开始不一致，
 *   而 CLI 里已经改成直接问 core.filePatchOutcome()，于是那两份就成了死代码：
 *   留着只会让下一个人照它再写第三份。本次抽取时一并删掉。
 *
 * 判定口径（与 CLI 原来的循环逐条对齐，不改任何一条）：
 *   na           patchAppliesHere(patch) 说这条补丁不在这张面上
 *   no-file      所有 key 都没有候选路径 / 都读不出
 *   drifted      命中数不符、或改完之后 core 仍说没完成、或原文一条都不中又不是软键
 *   would-apply  原文命中且改完能完成、或 core 说 pending、或被官方搬家的软键
 *   settled      marker/产物已在、或 deleteOnly 之类已完成
 */

// 这两个判定与 lib/patch-outcome.mjs 是同一件事，只保留那一份实现：
// 同一份 registry 被两边各判一次，分开写迟早给出两个答案（见 MAINTENANCE.md）。
import { patchReplacements, matchesPattern } from "../lib/patch-outcome.mjs";

export { patchReplacements, matchesPattern };

export const VERIFY_SCHEMA = 1;

export const VERIFY_STATES = Object.freeze({
  na: "na",
  noFile: "no-file",
  wouldApply: "would-apply",
  settled: "settled",
  drifted: "drifted",
});

export const VERIFY_STATE_LIST = Object.freeze(["na", "no-file", "would-apply", "settled", "drifted"]);

const asLf = (s) => String(s ?? "").replace(/\r\n/g, "\n");

export function fileKeysOf(patch) {
  return Array.isArray(patch.file) ? patch.file : [patch.file];
}

export function keysOfPatch(patch) {
  return fileKeysOf(patch).filter(Boolean);
}

/** 已被官方搬家、允许「文件在但原文不在」的键（包拆分后的旧位置）。 */
export function softKeysOf(patch) {
  return Array.isArray(patch.softFiles) ? patch.softFiles : [];
}

export function pathsOf(files, key) {
  const value = files ? files[key] : undefined;
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function detailOf(patch, key, file, extra) {
  // 命中数不符那条原来只截 120 字（一行就能看完），其余截 200；保持逐字一致。
  const head = extra.hitMismatch ? 120 : 200;
  const { text, ...rest } = extra;
  return {
    key,
    file,
    ...rest,
    patterns: patchReplacements(patch).map((entry) => ({
      hit: matchesPattern(asLf(text), entry.pattern),
      head: asLf(String(entry.pattern?.source ?? entry.pattern)).slice(0, head),
    })),
  };
}

/**
 * 把一条补丁在这棵树上的结论算出来。
 * deps 全部注入，所以整张矩阵可以用 Map 造出来，不需要真的宿主。
 */
export function judgePatch(patch, deps) {
  const { files, readText, applyReplacementsToText, filePatchOutcome, patchAppliesHere, detail } = deps;
  if (typeof patchAppliesHere === "function" && !patchAppliesHere(patch)) {
    return { id: patch.id, name: patch.name, status: VERIFY_STATES.na, files: {}, detail: undefined, na: true };
  }
  const stat = {};
  const notes = [];
  let status = VERIFY_STATES.noFile;
  for (const key of keysOfPatch(patch)) {
    const paths = pathsOf(files, key);
    if (paths.length === 0) {
      stat[key] = VERIFY_STATES.noFile;
      continue;
    }
    for (const file of paths) {
      const text = readText(file);
      if (text == null) {
        stat[key] = VERIFY_STATES.noFile;
        continue;
      }
      const res = applyReplacementsToText(text, patch, file);
      if (res.hitMismatch) {
        stat[key] = "hit-mismatch";
        status = VERIFY_STATES.drifted;
        if (detail) notes.push(detailOf(patch, key, file, { text, hitMismatch: res.hitMismatch }));
        continue;
      }
      if (res.changed) {
        // 全部 pattern 都命中也可能是「只打了一半」：补丁声明了 markers（every），
        // 产物里凑不齐就是部分应用 —— 首轮 e2e 就是这么抓出 #17 的。
        // 用引擎自己的判定：apply 完之后这处文件到底算不算完成。
        if (filePatchOutcome(res.text, patch, file) !== "applied") {
          stat[key] = "partial";
          status = VERIFY_STATES.drifted;
          if (detail) notes.push(detailOf(patch, key, file, { text, partial: true }));
          continue;
        }
        stat[key] = VERIFY_STATES.wouldApply;
        if (status !== VERIFY_STATES.drifted) status = VERIFY_STATES.wouldApply;
        continue;
      }
      // 一条 pattern 都没中：直接问引擎，别再维护第二份平行判定。
      // softFiles / deleteOnly / after 链式关系全在 core 里，抄一遍必然分叉
      // （#88 就曾在这里单独被记成 drifted，而顺序 apply 时它是好的）。
      const outcome = filePatchOutcome(text, patch, file);
      if (outcome === "applied") {
        stat[key] = VERIFY_STATES.settled;
        if (status === VERIFY_STATES.noFile) status = VERIFY_STATES.settled;
        continue;
      }
      if (outcome === "pending") {
        stat[key] = "pending";
        if (status !== VERIFY_STATES.drifted) status = VERIFY_STATES.wouldApply;
        continue;
      }
      if (outcome === "skipped") {
        stat[key] = "self-marked";
        if (status === VERIFY_STATES.noFile) status = VERIFY_STATES.settled;
        continue;
      }
      if (softKeysOf(patch).includes(key)) {
        // 旧文件键被官方搬家：文件在、原文不在，不算漂移。
        stat[key] = "soft-moved";
        if (status === VERIFY_STATES.noFile) status = VERIFY_STATES.wouldApply;
        continue;
      }
      stat[key] = VERIFY_STATES.drifted;
      status = VERIFY_STATES.drifted;
      if (detail) notes.push(detailOf(patch, key, file, { text }));
      continue;
    }
  }
  return { id: patch.id, name: patch.name, status, files: stat, detail: detail ? notes : undefined, na: false };
}

export function judgePatches(patches, deps) {
  const rows = [];
  const tally = { wouldApply: 0, settled: 0, drifted: 0, noFile: 0, na: 0 };
  for (const patch of patches || []) {
    const row = judgePatch(patch, deps);
    if (row.na) tally.na += 1;
    else if (row.status === VERIFY_STATES.wouldApply) tally.wouldApply += 1;
    else if (row.status === VERIFY_STATES.settled) tally.settled += 1;
    else if (row.status === VERIFY_STATES.drifted) tally.drifted += 1;
    else tally.noFile += 1;
    rows.push({ id: row.id, name: row.name, status: row.status, files: row.files, detail: row.detail });
  }
  return { schema: VERIFY_SCHEMA, patches: rows.length, tally, rows };
}

export default {
  VERIFY_SCHEMA,
  VERIFY_STATES,
  VERIFY_STATE_LIST,
  fileKeysOf,
  patchReplacements,
  keysOfPatch,
  softKeysOf,
  pathsOf,
  matchesPattern,
  judgePatch,
  judgePatches,
};
