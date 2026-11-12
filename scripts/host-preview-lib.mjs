/* 宿主升级预演：把目标版本装到隔离目录里，只看「86 条补丁哪些还能打、哪些已经被上游改掉了」。
 *
 * 为什么要有这个：升级前唯一能回答「升上去之后哪些补丁会失效」的办法，是拿新版本的
 * 原始文件去逐条试锚点。真升级之后再发现，就只能边用边修；而这里全程不碰真宿主。
 *
 * 本文件只放纯函数（不做 IO），IO 在 scripts/host-preview.mjs 里。
 */

/** patchStatus() 的返回值里，哪些字面量代表「这条补丁在这个版本上打不上了」。 */
const BROKEN = new Set(["drifted", "unmatched", "pattern_not_found"]);

/* 这些状态不是「坏」，是「这台机器上本来就没有」：
 *   no-file  —— 目标文件不在这一版里（包被拆走 / 没装）
 *   na       —— 面不同（desktop-shell 之类）
 *   skipped  —— 自标记补丁，本来就没加过
 *   missing_file —— 文件键解析不出来（通常也是包不在）
 * 它们单列，不参与「升级会坏几条」的计数。 */
const NOT_APPLICABLE = new Set(["no-file", "na", "skipped", "missing_file"]);

/** 一条补丁在「旧版本基线」与「新版本预演」之间怎么变的。 */
export function classifyPreviewRow({ id, name, before, after }) {
  const now = String(after || "missing_file");
  const was = String(before || "");
  let kind;
  if (BROKEN.has(now)) kind = was === now ? "already-broken" : "broken-by-upgrade";
  else if (NOT_APPLICABLE.has(now)) kind = "not-applicable";
  else kind = "ok";
  return { id, name, was, now, kind };
}

/** 把整批行归类计数。 */
export function summarizePreview(rows) {
  const counts = { ok: 0, "broken-by-upgrade": 0, "already-broken": 0, "not-applicable": 0 };
  for (const row of rows || []) counts[row.kind] = (counts[row.kind] || 0) + 1;
  return { counts, total: (rows || []).length };
}

/** 升级预演的结论词。 */
export function describePreview({ rows, summary, hostVersion, baseVersion }) {
  const brokenByUpgrade = (rows || []).filter((r) => r.kind === "broken-by-upgrade");
  const head = `目标 ${hostVersion || "?"}（当前记录 ${baseVersion || "?"}）`;
  if (!rows || rows.length === 0) return { verdict: "no-data", detail: `${head}：没有可比对的补丁` };
  if (brokenByUpgrade.length > 0) {
    const names = brokenByUpgrade.slice(0, 8).map((r) => `#${r.id} ${r.name}`).join("、");
    return {
      verdict: "breaking",
      detail: `${head}：${brokenByUpgrade.length} 条补丁的锚点被上游改掉，升级后打不上 —— ${names}${brokenByUpgrade.length > 8 ? " 等" : ""}`,
    };
  }
  const total = summary?.total || rows.length;
  return {
    verdict: "compatible",
    detail: `${head}：${total} 条补丁全部可打（可打 ${summary?.counts?.ok || 0} 条，其余本来就不适用于这一版）`,
  };
}

/** 目标版本号里带 rc/alpha/beta 的一律算预发布 —— 预发布不许当成「升级就绪」。 */
export function isPrerelease(version) {
  return /-(?:rc|alpha|beta|pre|next)\.?/i.test(String(version || ""));
}
