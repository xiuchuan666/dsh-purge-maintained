/* 旁路沙盒重打：把宿主树里「补丁会碰到的那些包」复制一份，在副本上重打，
 * 再与 docs/host-baseline.json 逐文件对拍。
 *
 * 为什么要有这个：宿主升级/被换回原版时，86 条补丁里哪几条还能打、打出来是不是
 * 与上次记录的字节完全一致，光看测试和状态戳都答不了。副本上重打能把这件事变成
 * 一个可重复的事实，而且完全不碰真宿主。
 *
 * 本文件只放纯函数（不做 IO），IO 在 scripts/sandbox-apply.mjs 里。
 */

/** 从 targetFiles() 的返回值里推出「要复制的包目录名」。 */
export function packagesFromTargetFiles(files, aiBase) {
  /* Windows 上 aiBase 可能是正斜杠、targetFiles 返回的是反斜杠，必须先归一化再比前缀。 */
  const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const prefix = norm(aiBase);
  const out = new Set();
  for (const value of Object.values(files || {})) {
    const list = value == null || value === "" ? [] : Array.isArray(value) ? value : [value];
    for (const fp of list) {
      const s = norm(fp);
      if (!s || !prefix) continue;
      /* aiBase 自身不是包目录：它不会以 `aiBase/` 开头，所以下面这条前缀判断天然把它排除，
         不需要单独判等。 */
      if (!s.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) continue;
      const rest = s.slice(prefix.length).replace(/^\/+/, "");
      const pkg = rest.split("/")[0];
      if (pkg) out.add(pkg);
    }
  }
  return [...out].sort();
}

/** 补丁 report 按状态归类（`hit_count_mismatch:3/4` 这种只取冒号前）。 */
export function summarizeStatuses(report) {
  const counts = {};
  for (const row of report || []) {
    const key = String(row?.status ?? "unknown").split(":")[0];
    counts[key] = (counts[key] || 0) + 1;
  }
  return { counts, total: (report || []).length };
}

/** 把「基线记的 sha」与「沙盒里现在的 sha」逐文件对拍。digests: Map<rel, sha|null>。 */
export function compareToBaseline(baselineFiles, digests) {
  const rows = [];
  let same = 0;
  let diff = 0;
  let missing = 0;
  for (const [key, meta] of Object.entries(baselineFiles || {})) {
    const rel = String(meta?.rel || "");
    const want = String(meta?.sha256 || "");
    const got = digests instanceof Map ? digests.get(rel) ?? null : digests?.[rel] ?? null;
    if (!got) {
      missing += 1;
      rows.push({ key, rel, state: "missing", want: want.slice(0, 12), got: "" });
      continue;
    }
    if (got === want) {
      same += 1;
      rows.push({ key, rel, state: "same", want: want.slice(0, 12), got: got.slice(0, 12) });
      continue;
    }
    diff += 1;
    rows.push({ key, rel, state: "diff", want: want.slice(0, 12), got: got.slice(0, 12) });  }
  return { total: rows.length, same, diff, missing, rows };
}

/** 给整件事一个结论词，供脚本打印与测试断言。 */
export function describeOutcome({ compare, markersPresent, firstCounts, secondCounts }) {
  if (!compare || compare.total === 0) return { verdict: "no-baseline", detail: "基线里没有可比的文件" };
  if (compare.missing > 0) {
    return { verdict: "missing", detail: `${compare.missing} 个基线文件在副本里不存在 —— 复制不全，先查包清单` };
  }
  if (compare.diff > 0) {
    const sample = compare.rows.filter((r) => r.state === "diff").slice(0, 5).map((r) => r.rel).join("、");
    return { verdict: "drift", detail: `${compare.diff} 个文件重打后与基线不一致：${sample}` };
  }
  if (!markersPresent) {
    return { verdict: "no-marker", detail: "字节对上了但宿主注入标记没出现 —— 标记探针失效" };
  }
  const first = firstCounts || {};
  const second = secondCounts || {};
  const secondApplied = Number(second.applied || 0);
  if (secondApplied > 0) {
    return { verdict: "not-idempotent", detail: `第二次重打仍有 ${secondApplied} 条标成 applied —— 打了两遍会变` };
  }
  const firstOk = Number(first.applied || 0) + Number(first.already || 0);
  return {
    verdict: "reproduced",
    detail: `首次 applied ${first.applied || 0} / already ${first.already || 0}，第二次全 already；${compare.same} 个文件与基线逐字节一致`,
  };
}

/** 沙盒目录绝不能落在真宿主里，否则「旁路」两个字就是假的。 */
export function isSafeSandboxDir(sandboxDir, { repoRoot, protectedRoots = [] } = {}) {
  const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const s = norm(sandboxDir);
  if (!s) return { ok: false, reason: "沙盒目录为空" };
  const repo = norm(repoRoot);
  if (repo && !s.startsWith(`${repo}/`)) {
    return { ok: false, reason: `沙盒目录必须在仓库内（${repoRoot}），实际是 ${sandboxDir}` };
  }
  for (const root of protectedRoots) {
    const r = norm(root);
    if (!r) continue;
    if (s === r || s.startsWith(`${r}/`) || r.startsWith(`${s}/`)) {
      return { ok: false, reason: `沙盒目录与受保护路径重叠：${root}` };
    }
  }
  return { ok: true, reason: "" };
}
