// 补丁结果的五态判定：把「文本里有没有这段」换成「和纯净基线比出来的事实」。
//
// 为什么需要这个模块：只要用「marker 在不在」判断，纯净宿主上就会把 #2/#3 报成 applied——
// 因为它们的 marker 就是官方原文（OFFICIAL_REPLACEMENT_BODY / OFFICIAL_SCOPE），
// 而它们要做的正是「把强句改回官方原文」。目标态 == 原生态，marker 无法区分「我打的」与「本来就对」。
//
// 五态的判据全部来自三个可验证事实：
//   1. pattern 是否还命中当前文本（精确到每条 replacement）；
//   2. 本插件痕迹（[dsh-purge]）是否出现——这是唯一能证明「我改过」的证据；
//   3. 当前文件与纯净基线是否逐字节相同、以及 marker 在纯净基线里是否已经成立。
//
// applied  pattern 不命中 + 有痕迹           我打的，已达成
// pending  pattern 命中                      还有活要干
// native   pattern 不命中 + 基线里 marker 已成立  宿主原生就符合目标态，无可打
// stale    pattern 不命中 + 文件 == 基线 + 无痕迹  锚点与产物双双失踪：这条补丁对这一版失效
// drifted  pattern 不命中 + 文件 != 基线 + 无痕迹  有第三方改动，需要人看
//
// 注意 stale 与 native 的区别就是「这条补丁该不该在这个版本存在」的答案：
// stale 是「该退役或改锚点」的候选，native 是「本来就不需要打」的确认。

export const PATCH_STATES = Object.freeze({
  APPLIED: "applied",
  PENDING: "pending",
  NATIVE: "native",
  STALE: "stale",
  DRIFTED: "drifted",
  // 这一版布局里根本没有这个文件（桌面壳 main.js 与 npm 包树的差异等）。
  // 与 unknown 分开：na 是「不适用」，unknown 是「缺信息，别下结论」。
  NA: "na",
});

export const STATE_LIST = Object.freeze([
  PATCH_STATES.APPLIED,
  PATCH_STATES.PENDING,
  PATCH_STATES.NATIVE,
  PATCH_STATES.STALE,
  PATCH_STATES.DRIFTED,
  PATCH_STATES.NA,
]);

export const TRACE_TOKEN = "[dsh-purge]";

// CRLF 归一：宿主文件可能是 CRLF，锚点一律按 LF 写。
export function normalizeText(text) {
  return String(text === undefined || text === null ? "" : text).replace(/\r\n/g, "\n");
}

// 兼容两种注册表写法：replacements[{pattern,replace}] 或 patterns[]+replace。
export function patchReplacements(patch) {
  if (!patch) return [];
  if (Array.isArray(patch.replacements)) return patch.replacements;
  const pats = Array.isArray(patch.patterns) ? patch.patterns : (patch.pattern === undefined ? [] : [patch.pattern]);
  return pats.map(function (p) { return { pattern: p, replace: patch.replace }; });
}

// marker 与 markers 都认，且合并去重：注册表现在只用其中一个，
// 但手写补丁时两个都写是自然的，合并比「后者覆盖前者」更不容易丢证据。
export function patchMarkers(patch) {
  if (!patch) return [];
  const out = [];
  if (typeof patch.marker === "string" && patch.marker.length > 0) out.push(patch.marker);
  if (Array.isArray(patch.markers)) {
    for (const m of patch.markers) if (typeof m === "string" && m.length > 0) out.push(m);
  }
  return [...new Set(out)];
}

// RegExp 要摘掉 g/y，否则重复 test 会因 lastIndex 漂移给出假阴性。
export function matchesPattern(text, pattern) {
  const hay = normalizeText(text);
  if (pattern instanceof RegExp) {
    const flags = String(pattern.flags || "").replace(/[gy]/g, "");
    return new RegExp(pattern.source, flags).test(hay);
  }
  if (typeof pattern !== "string" || pattern.length === 0) return false;
  return hay.includes(normalizeText(pattern));
}

export function countPatternHits(text, patch) {
  const reps = patchReplacements(patch);
  let hits = 0;
  for (const rep of reps) {
    if (rep && rep.pattern && matchesPattern(text, rep.pattern)) hits += 1;
  }
  return hits;
}

// marker 命中：markersAny 用 some，否则 every。
export function markerPresent(text, patch, markers) {
  const list = markers || patchMarkers(patch);
  if (list.length === 0) return false;
  const hay = normalizeText(text);
  const test = function (m) { return hay.includes(normalizeText(m)); };
  return patch && patch.markersAny ? list.some(test) : list.every(test);
}

// 痕迹：补丁自己的 marker 或 replace 产物里带 [dsh-purge] 注释，且这段确实在文本里。
// 只认「本补丁的痕迹」，不认任何别处出现的 [dsh-purge]，否则会互相串味。
export function patchTracePresent(text, patch) {
  const hay = normalizeText(text);
  const own = [];
  for (const m of patchMarkers(patch)) if (m.indexOf(TRACE_TOKEN) >= 0) own.push(m);
  for (const rep of patchReplacements(patch)) {
    const out = rep && typeof rep.replace === "string" ? rep.replace : "";
    if (out.indexOf(TRACE_TOKEN) < 0) continue;
    for (const line of out.split("\n")) {
      if (line.indexOf(TRACE_TOKEN) >= 0) own.push(line.trim());
    }
  }
  if (own.length === 0) return false;
  return own.some(function (frag) { return frag.length > 0 && hay.indexOf(normalizeText(frag)) >= 0; });
}

// 产物：replace 生成的那段东西在文本里吗。
//
// 为什么需要它：trace 只认带 [dsh-purge] 的行，而有些补丁的 replace 产物本身不带注释
// （例如 #12 把整句措辞换掉，注释在第二个 replacement 里）。只看 trace 会把这些
// 「明明已经打上」的补丁报成 stale，让退役清单不可信。
//
// 取首行前 60 字符，与 lib/core.js:3641 的 patchApplied 同一约定，避免两处判据不同源。
export function patchProducts(patch) {
  const out = [];
  for (const rep of patchReplacements(patch)) {
    const text = rep && typeof rep.replace === "string" ? normalizeText(rep.replace) : "";
    for (const line of text.split("\n")) {
      const probe = line.trim().slice(0, 60);
      if (probe.length >= 8) { out.push(probe); break; }
    }
  }
  return out;
}

export function productPresent(text, patch) {
  const hay = normalizeText(text);
  return patchProducts(patch).some(function (probe) { return hay.indexOf(probe) >= 0; });
}

// 撤销型补丁：它的锚点不是官方代码，而是本插件历史上写进去的痕迹。
// 识别依据有两条，任一成立即可：
//   1. 至少一条 pattern 里含 [dsh-purge]（它要找的就是自己写的注释行）；
//   2. 注册表显式声明 skipIfMarked / deleteOnly / softSettle / after[]（清理、迁移、链式）。
//
// 为什么必须单独识别：这类补丁在纯净宿主上「锚点不存在」是预期结果——本来就没写过，
// 没有东西可撤。若按普通补丁判 stale，退役清单会被自己的清理动作塞满（实测 #21/#80/#88）。
export function isRetractionPatch(patch) {
  if (!patch) return false;
  if (patch.skipIfMarked || patch.deleteOnly || patch.softSettle) return true;
  if (Array.isArray(patch.after) && patch.after.length > 0) return true;
  return patchReplacements(patch).some(function (rep) {
    const pat = rep && rep.pattern;
    return typeof pat === "string" ? pat.indexOf(TRACE_TOKEN) >= 0 : false;
  });
}

// 不传 baseline 时无法区分 native / stale，一律降级为 drifted 之外的中性值 unknown，
// 让调用方明确知道「没有基线就别下结论」，而不是用 marker 蒙一个 applied。
export const UNKNOWN = "unknown";

// 单文件判定。
// input.fileText      当前文件文本（null 表示文件不存在）
// input.baselineText  纯净基线文本（null 表示没有基线或文件不存在）
export function classifyFile(patch, input) {
  const fileText = input.fileText === null || input.fileText === undefined ? null : normalizeText(input.fileText);
  const baseText = input.baselineText === null || input.baselineText === undefined ? null : normalizeText(input.baselineText);
  const reasons = [];

  if (fileText === null) {
    // 基线里也没有 → 这一版宿主就没有这个文件，补丁在这里天然不适用。
    if (baseText === null) return { state: PATCH_STATES.NA, reasons: ["file absent in host and baseline"] };
    return { state: UNKNOWN, reasons: ["file missing from host but present in baseline"] };
  }

  // deleteOnly：目标就是让这段消失，pattern 不命中 = 达成。
  if (patch && patch.deleteOnly) {
    const hits = countPatternHits(fileText, patch);
    if (hits > 0) return { state: PATCH_STATES.PENDING, reasons: ["deleteOnly:" + hits + " pattern still present"] };
    return { state: PATCH_STATES.APPLIED, reasons: ["deleteOnly target absent"] };
  }

  // 先把「基线里本来是什么样」算清楚，再判当前态。顺序很重要：
  // 所有「现在存在的东西」都必须先问一句「它是不是基线自带的」。
  const trace = patchTracePresent(fileText, patch);
  const markerNow = markerPresent(fileText, patch);
  const productNow = productPresent(fileText, patch);
  const hits = countPatternHits(fileText, patch);
  const sameAsBaseline = baseText !== null && fileText === baseText;
  const markerInBaseline = baseText === null ? false : markerPresent(baseText, patch);
  const productInBaseline = baseText === null ? false : productPresent(baseText, patch);
  const hitsInBaseline = baseText === null ? 0 : countPatternHits(baseText, patch);

  // skipIfMarked 型（插入型）补丁：pattern 是「插入位置」，补丁产物落地后这段锚点仍然保留，
  // 所以「产物已在 + 锚点还在」是正常已结算态，不是还有活要干。
  // 与 lib/core.js:3834 的 `if (patch.skipIfMarked && patchApplied(source, patch)) return {...}` 同源：
  // core 一旦认 markApplied 就不再重跑 replacement，本模块若判 pending 就是与 core 自相矛盾。
  // 但证据必须「基线里没有、现在有」才算我们打的——否则纯净树会把官方原文当自己的产物（#2/#3 的教训）。
  // 只认 marker 这一条证据：skipIfMarked 型补丁的 marker 全是本插件自己写的注释（如 #42 的
  // "#89 ?? {} 兜 over=undefined 丢 base"），官方基线里不可能有，判别力最强；
  // 产物片段太短太泛（#42 的产物片段在基线里也能撞上），拿它当证据会在纯净树上误判。
  if (patch && patch.skipIfMarked && markerNow && !markerInBaseline) {
    return { state: PATCH_STATES.APPLIED, reasons: ["skipIfMarked: plugin marker present (absent from baseline), replacement intentionally skipped"] };
  }

  if (hits > 0) {
    return { state: PATCH_STATES.PENDING, reasons: [hits + " pattern hit(s) in host"] };
  }

  // native 必须排在 applied 之前。
  // #2/#3 这类补丁的目标态就是官方原文，它们的 marker 在纯净基线里本来就成立；
  // 先判 applied 会把「宿主本来就对」错报成「我打上了」，纯净树上出现假 applied。
  if (markerInBaseline) {
    return {
      state: PATCH_STATES.NATIVE,
      reasons: [
        "target state already true in pristine baseline" + (markerNow ? "" : ", but no longer true now"),
        "file " + (sameAsBaseline ? "identical to" : "differs from") + " baseline",
      ],
    };
  }

  // 达成证据三条：本插件痕迹（[dsh-purge]）、补丁产物、声明的 marker。
  // 只看痕迹会漏掉「产物本身不带注释」的补丁（#12 就是），把它们误判成 stale；
  // 但产物与 marker 都必须「基线里没有」才算证据——否则纯净树会把官方原文当自己的产物，
  // 让「干净宿主上绝不允许出现 applied」这条不变量失效（实测 #2/#3、#42 都踩过）。
  //
  // 没有基线时（baseText === null）这两条一律不算证据：无法回答「它是不是官方自带的」，
  // 而 60 字符的产物前缀判别力本就弱（实测 #12 的产物前缀能撞上真宿主的 NEVER_SENTENCE，
  // 一度让缺基线的那一轮把 #12 报成 applied）。剩下只有 trace 可用——它认的是 [dsh-purge]，
  // 官方不可能写。缺基线的其余情形如实落到下面的 UNKNOWN，而不是蒙一个 applied。
  const productIsEvidence = baseText !== null && productNow && !productInBaseline;
  const markerIsEvidence = baseText !== null && markerNow && !markerInBaseline;
  if (trace || productIsEvidence || markerIsEvidence) {
    return {
      state: PATCH_STATES.APPLIED,
      reasons: [
        trace ? "[dsh-purge] trace present" : "",
        productIsEvidence ? "patch product present (absent from baseline)" : "",
        markerIsEvidence ? "declared marker present (absent from baseline)" : "",
      ].filter(Boolean),
    };
  }

  if (baseText === null) {
    return { state: UNKNOWN, reasons: ["pattern gone, no product, no trace, no baseline to compare"] };
  }

  // 关键判据：锚点在这一版官方代码里是否还活着（hitsInBaseline 上面已算）。
  // 活着 = 宿主仍然有这段东西可打，只是我的锚点对不上 → 要改锚点。
  // 死了 = 宿主自己把这段删了/改了 → 这条补丁该退役，不是修锚点。
  if (hitsInBaseline > 0) {
    return {
      state: PATCH_STATES.DRIFTED,
      reasons: ["anchor alive in pristine baseline (" + hitsInBaseline + "), gone in host — pattern needs re-anchoring"],
    };
  }

  // 撤销型补丁在纯净宿主上找不到锚点是正常的：它要找的是本插件自己留下的痕迹。
  // 报 na 而不是 stale，否则退役清单会被「本来就没写过」的清理补丁塞满。
  if (isRetractionPatch(patch)) {
    return {
      state: PATCH_STATES.NA,
      reasons: ["retraction patch: anchor is plugin-own trace, absent from pristine baseline = nothing to undo"],
    };
  }

  // 两棵树里锚点与产物都不存在：这处官方代码已经不存在了。
  return {
    state: PATCH_STATES.STALE,
    reasons: [
      "anchor and product both absent from pristine baseline — official target code no longer exists",
      "file " + (sameAsBaseline ? "identical to" : "differs from") + " baseline",
    ],
  };
}

// 多文件补丁汇总。判据分两级：
//   1. 「还有没有活」优先：有文件 pending 就是 pending，与其它文件无关。
//   2. 「有没有坏」其次：drifted / unknown 需要人看，压过其它结论。
//   3. 只有在「没有活也没有坏」时，才轮到 applied / native / stale 三选一，
//      且 applied 优先级高于 stale —— 否则一条补丁只要有一个词条随包搬迁变空，
//      整条就被打成 stale，把「已经生效」这个事实盖掉（实测 #54/#60/#62）。
// 全 na / 全 stale 才算 na / stale：前者这一版没有落点，后者这一版没有可打的东西。
export function rollupStates(states) {
  const list = states.filter(Boolean);
  if (list.length === 0) return UNKNOWN;
  if (list.every(function (s) { return s === PATCH_STATES.NA; })) return PATCH_STATES.NA;
  if (list.indexOf(PATCH_STATES.PENDING) >= 0) return PATCH_STATES.PENDING;
  if (list.indexOf(PATCH_STATES.DRIFTED) >= 0) return PATCH_STATES.DRIFTED;
  if (list.indexOf(UNKNOWN) >= 0) return UNKNOWN;
  if (list.indexOf(PATCH_STATES.APPLIED) >= 0) return PATCH_STATES.APPLIED;
  if (list.indexOf(PATCH_STATES.NATIVE) >= 0) return PATCH_STATES.NATIVE;
  if (list.indexOf(PATCH_STATES.STALE) >= 0) return PATCH_STATES.STALE;
  return PATCH_STATES.NA;
}

// 一条补丁 → 汇总状态 + 每文件明细 + 该清理的键。
//
// softFiles 是注册表里显式声明的「历史落点」：包搬迁后这些键指向的文件不再包含锚点，
// 它们 stale 是正常的，不能把整条补丁拉成 stale。但即使声明了，也要在报告里列出来，
// 因为「这个键可以删了」本身就是维护信息。没声明却变空的键同样列出来，那是要人判断的。
export function classifyPatch(patch, inputs) {
  const soft = new Set(Array.isArray(patch && patch.softFiles) ? patch.softFiles : []);
  const per = [];
  for (const item of inputs) {
    const r = classifyFile(patch, item);
    per.push({ key: item.key, file: item.file, state: r.state, reasons: r.reasons, soft: soft.has(item.key) });
  }
  const vacantKeys = per
    .filter(function (x) { return x.state === PATCH_STATES.STALE || x.state === PATCH_STATES.NA; })
    .map(function (x) { return x.file; });
  return {
    id: patch && patch.id,
    name: patch && patch.name,
    state: rollupStates(per.map(function (x) { return x.state; })),
    files: per,
    vacantKeys: vacantKeys,
  };
}

// 分布统计，给报告和 CI 门禁用。
export function tallyStates(results) {
  const out = {};
  for (const s of STATE_LIST.concat([UNKNOWN])) out[s] = 0;
  for (const r of results) out[r.state] = (out[r.state] || 0) + 1;
  return out;
}

// 需要人看的状态：drifted 与 unknown。stale 是「该退役」候选，单独计数不报警。
export function needsAttention(state) {
  return state === PATCH_STATES.DRIFTED || state === UNKNOWN;
}