/**
 * census-lib —— 「限制面普查」的纯函数层
 *
 * 用法 / usage:
 *   import {
 *     CENSUS_SCHEMA, DENIAL_PATTERNS, scanSites, locateNeedle, nearestPatch,
 *     markCovered, rankCandidates, diffCensus, summarize, renderCensusReport,
 *   } from "./census-lib.mjs";
 *
 *   本文件只返回结构，不 console.log、不 process.exit。CLI 侧建议退出码：
 *     0 = 没有未覆盖的限制面；1 = 存在未覆盖站点；2 = 用法或环境失败。
 *
 * 设计：会拦人的不是关键词，而是可判定的「形状」——拒绝类文案、拒绝类错误类、
 * 策略/审批枚举、沙箱包裹调用、升级校验入口。这里把它们收敛成一组单行正则，
 * 只扫 <pkg>/lib 下的 js/mjs/cjs，再与补丁 spans 按最近距离求交，
 * 得到「谁在拦人、还没被任何补丁覆盖」的清单。
 */

import fs from "node:fs";
import path from "node:path";

export const CENSUS_SCHEMA = 1;

/**
 * 拒绝面形状表。每条：{ id, role, label, layer, why, re, noiseLimit }。
 * role:
 *   denial = 拒绝类用户可见文案 / 拒绝类错误（出现就代表这一支会拦人）；
 *   policy = 策略枚举 / 沙箱包裹 / 升级校验（放行档位与闸门的现场）；
 *   signal = 弱信号（只是相关词汇，需要人工收敛，不构成本身拦人的证据）。
 * noiseLimit：命中数超过它就提示人工收敛——满树都是的形状不是闸门而是噪声。
 * 所有正则都是单行、无 g 标志（scanSites 内部按行 test）。
 */
export const DENIAL_PATTERNS = [
  {
    id: "deny-copy-en",
    role: "denial",
    label: "英文拒绝文案",
    layer: "文案",
    why: "not allowed / requires approval / outside the workspace 这类句子就是用户看到的拒绝，出现即说明这一分支会拦人",
    // 只留「权限语义」：exceeds the configured byte limit / cannot be read 这类是配额与 IO 错误，不是限制面。
    re: /(?:not allowed|not permitted|requires approval|approval (?:is )?required|permission denied|access denied|denied by|blocked by (?:the )?(?:policy|sandbox|approval)|outside (?:of )?the workspace|unsupported (?:mode|policy)|not authorized|forbidden|refus(?:ed|ing) to (?:allow|permit|run|execute))/i,
    quoteRequired: true,
    noiseLimit: 120,
  },
  {
    id: "deny-copy-zh",
    role: "denial",
    label: "中文拒绝文案",
    layer: "文案",
    why: "不允许 / 需要审批 / 超出授权范围 这类中文提示，是国模场景下用户实际看到的拒绝",
    re: /(?:不允许|不予(?:以)?(?:通过|执行)|需要审批|需(?:要)?授权|拒绝(?:执行|访问|写入)?|权限不足|无权限|超出(?:允许|授权)范围|不在(?:允许|授权)范围|已被(?:策略|沙箱|审批)(?:阻止|拦截))/,
    quoteRequired: true,
    noiseLimit: 120,
  },
  {
    id: "deny-error-class",
    role: "denial",
    label: "拒绝类错误类",
    layer: "代码",
    why: "抛 SandboxUnavailableError / ApprovalError 等类型就是拦住了；新错误类往往意味着新拒绝路径",
    re: /(?:new|extends)\s+(?:Sandbox|Approval|Permission|Escalat|Refus|Denied)[A-Za-z]*Error\b/,
    noiseLimit: 80,
  },
  {
    id: "policy-enum",
    role: "policy",
    label: "策略枚举",
    layer: "代码",
    why: "模式/审批枚举一旦变长，说明可选的放行档位变了，这是策略面的入口",
    // 只要「放行档位」的枚举。别写 [A-Z][A-Z_]*_CODES —— FS_ERROR_CODES / LLM_FAILURE_CODES 这类错误码表会被一起抓进来。
    re: /(?:APPROVAL_POLICIES|SANDBOX_MODES|WIDER_MODES|APPROVAL_MODES|ESCALATION_TARGETS|PERMISSION_PRESETS?)\s*=\s*(?:\[|Object\.freeze|\{)/,
    noiseLimit: 40,
  },
  {
    id: "escalate-entry",
    role: "policy",
    label: "升级/校验入口",
    layer: "代码",
    why: "approveEscalation / validateEscalationArgs 是把受限模式换成更宽模式的唯一通道，本身是一道独立闸门",
    re: /\b(?:approveEscalation|validateEscalationArgs|requestEscalation)\s*\(/,
    noiseLimit: 40,
  },
  {
    id: "confine-call",
    role: "policy",
    label: "沙箱包裹执行",
    layer: "代码",
    why: "ctx.sandbox.confine/prepare/run/exec 是命令真正被包裹执行的地方，mode 分支在这里决定放不放行",
    re: /\bctx\.sandbox\.(?:confine|prepare|run|exec)\(/,
    noiseLimit: 40,
  },
  {
    id: "weak-signal",
    role: "signal",
    label: "限制类弱信号",
    layer: "代码",
    why: "泛化出现 approval/permission/sandbox/restricted 只说明这里有相关逻辑，需人工收敛，不构成本身能拦人的证据",
    re: /(?:\bapproval\b|\bpermission\b|\bsandbox\b|\brestrict(?:ed|ion)?\b|\bforbidden\b)/i,
    noiseLimit: 400,
  },
];

/**
 * 注释行不算「会拦人」的证据：JSDoc 里写着 "@throws ... outside the workspace" 只是文档。
 * 只按行首判断（`*` / `//` / `/*`），不做 AST —— 宿主是单行压缩产物，AST 得不偿失。
 */
function isCommentLine(line) {
  const t = String(line || "").trim();
  return t.startsWith("*") || t.startsWith("/*") || t.startsWith("//");
}

/** 位置 idx 是否落在引号内（统计其前面未转义的单/双引号是否为奇数个）。 */
function quotedAt(line, idx) {
  const s = String(line || "");
  const n = Math.max(0, Math.min(idx == null ? 0 : idx, s.length));
  let single = 0;
  let dbl = 0;
  for (let i = 0; i < n; i += 1) {
    const ch = s[i];
    if (ch === "\\") { i += 1; continue; }
    if (ch === "'") single += 1;
    else if (ch === '"') dbl += 1;
  }
  return single % 2 === 1 || dbl % 2 === 1;
}

/** 找出 <pkg>/lib/index.js 里内联的源码副本（//#region lib/xxx.js），这些副本不应重复计数。 */
function inlinedRegions(libDir) {
  const out = new Set();
  const entry = path.join(libDir, "index.js");
  let buf;
  try {
    const st = fs.statSync(entry);
    if (st.size > 8 * 1024 * 1024) return out;
    buf = fs.readFileSync(entry, "utf8");
  } catch {
    return out;
  }
  const re = /\/\/#region\s+(lib\/[^\s]+\.(?:js|mjs|cjs))/g;
  let m;
  while ((m = re.exec(buf)) !== null) out.add(m[1]);
  return out;
}

/** 递归列 lib 下的 js/mjs/cjs，忽略 node_modules，剔掉被 index.js 内联的副本。 */
function listJs(dir, out = [], skip = null) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (e.isSymbolicLink()) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") listJs(abs, out, skip);
    } else if (/\.(?:js|mjs|cjs)$/.test(e.name)) {
      if (skip && skip.has(abs)) continue;
      out.push(abs);
    }
  }
  return out;
}

/**
 * 扫一棵宿主树，返回 { patternId: [{ rel, line, text }] }。
 * rel 形如 "dsh-user-approval/lib/index.js"（相对 aiBase）。
 * text 为 trim 后 ≤200 字符。遍历语义对齐 chokepoints-lib.scanShapes：
 * 只扫 <pkg>/lib 下 js/mjs/cjs、跳过 node_modules、单文件 maxBytes 上限、剔除被内联副本。
 * only 可按包名（root 第一段）过滤。
 */
/** 生成物与渲染层不属于「服务端拦人现场」：client.js 是打包后的 UI、typert.* 是 RPC 类型生成器产物。 */
function skipGenerated(name) {
  return name === "client.js" || name.startsWith("typert.") || name.startsWith("client-");
}

export function scanSites(aiBase, { patterns = null, maxBytes = 4 * 1024 * 1024, only = null } = {}) {
  // 默认只扫 denial/policy：弱信号（signal）一句 "sandbox" 就能灌出四位数，必须显式点名才扫。
  const pats = patterns || DENIAL_PATTERNS.filter((p) => p.role !== "signal");
  const hits = {};
  for (const p of pats) hits[p.id] = [];
  let roots = [];
  try {
    roots = fs.readdirSync(aiBase, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("dsh-"))
      .map((e) => e.name)
      .sort();
  } catch {
    return hits;
  }
  const want = only && only.length > 0 ? new Set(only) : null;
  for (const root of roots) {
    if (want && !want.has(root)) continue;
    const libDir = path.join(aiBase, root, "lib");
    const inlined = inlinedRegions(libDir);
    const skip = new Set([...inlined].map((r) => path.join(aiBase, root, r)));
    for (const abs of listJs(libDir, [], skip)) {
      let buf;
      try {
        const st = fs.statSync(abs);
        if (st.size > maxBytes) continue;
        buf = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (skipGenerated(path.basename(abs))) continue;
      const rel = root + "/" + path.relative(path.join(aiBase, root), abs).replace(/\\/g, "/");
      const lines = buf.split(/\r?\n/);
      for (const p of pats) {
        const bucket = hits[p.id];
        var seen = seen || new Set();
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          if (isCommentLine(line)) continue;
          // 单行压缩产物里的命中无法定位也无法阅读；生成物里的 jsDoc 字符串同理。
          if (line.length > 2000 || line.includes("jsDoc")) continue;
          p.re.lastIndex = 0;
          const m = p.re.exec(line);
          if (!m) continue;
          if (p.quoteRequired && !quotedAt(line, m.index) && !/\bthrow\b|Error\(|reject\(/.test(line)) continue;
          // 形如 `landlock: ["permission denied"]` 的失败签名表：是「怎么识别被拒」，不是新的闸门。
          if (p.quoteRequired && /^[A-Za-z_$][\w$]*:\s*\[/.test(line.trim())) continue;
          const key = rel + ":" + (i + 1);
          if (seen.has(key)) continue;
          seen.add(key);
          bucket.push({ rel, line: i + 1, text: line.trim().slice(0, 200) });
        }
      }
    }
  }
  return hits;
}

/**
 * 在文件文本里定位 needle，返回 1-based 行号数组（最多 200 个）。
 * needle 为 string 时按字面 includes 逐行找；为 RegExp 时：
 *   带 g 的用带 g 副本 matchAll（一次性扫全文，按 match.index 折算行号）；
 *   非全局的逐行 test。找不到返回 []。
 */
export function locateNeedle(fileText, needle) {
  const text = String(fileText == null ? "" : fileText);
  const out = [];
  if (typeof needle === "string") {
    if (needle.length === 0) return out;
    // 多行 needle：补丁的 pattern 绝大多数是跨行代码段，逐行 includes 永远匹配不到——必须先整体 indexOf 再折算行号。
    if (needle.indexOf("\n") >= 0) {
      const starts = [0];
      for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
      const lineOf = (idx) => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid] <= idx) lo = mid;
          else hi = mid - 1;
        }
        return lo + 1;
      };
      let from = 0;
      while (out.length < 200) {
        const idx = text.indexOf(needle, from);
        if (idx < 0) break;
        out.push(lineOf(idx));
        from = idx + 1;
      }
      return out;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < 200; i += 1) {
      if (lines[i].includes(needle)) out.push(i + 1);
    }
    return out;
  }
  if (needle instanceof RegExp) {
    if (needle.global) {
      const flags = needle.flags.includes("g") ? needle.flags : needle.flags + "g";
      const re = new RegExp(needle.source, flags);
      const starts = [0];
      for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
      let ptr = 0;
      for (const m of text.matchAll(re)) {
        if (out.length >= 200) break;
        const idx = m.index == null ? 0 : m.index;
        while (ptr + 1 < starts.length && starts[ptr + 1] <= idx) ptr += 1;
        out.push(ptr + 1);
      }
      return out;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < 200; i += 1) {
      needle.lastIndex = 0;
      if (needle.test(lines[i])) out.push(i + 1);
    }
    return out;
  }
  return out;
}

/** id 数值化（字符串 id 也能比较），非数值按无穷大排在后面。 */
function idNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * 找覆盖 site 的最近 span：只认 rel 完全相同且 |site.line - span.line| <= window（闭区间）。
 * 同距取 id 数值小的，保证确定性。返回 { id, distance } | null。
 */
export function nearestPatch(site, spans, { window = 15 } = {}) {
  if (!site || !Array.isArray(spans)) return null;
  let best = null;
  for (const sp of spans) {
    if (!sp || sp.rel !== site.rel) continue;
    const distance = Math.abs(site.line - sp.line);
    if (!(distance <= window)) continue;
    if (best === null || distance < best.distance || (distance === best.distance && idNum(sp.id) < idNum(best.id))) {
      best = { id: sp.id, distance };
    }
  }
  return best;
}

/** 给每个 site 标注覆盖来源：coveredBy = 最近的 span id 或 null，distance = 距离或 null。返回新数组，不改入参。 */
export function markCovered(sites, spans, { window = 15 } = {}) {
  const arr = Array.isArray(sites) ? sites : [];
  return arr.map((site) => {
    const hit = nearestPatch(site, spans, { window });
    return Object.assign({}, site, {
      coveredBy: hit ? hit.id : null,
      distance: hit ? hit.distance : null,
    });
  });
}

const ROLE_PRIORITY = { denial: 0, policy: 1, signal: 2 };

/** site 的 role：优先用自带 role，其次按 pattern 反查 DENIAL_PATTERNS，兜底 signal。 */
function roleOfSite(site) {
  if (site && typeof site.role === "string" && site.role in ROLE_PRIORITY) return site.role;
  if (site && typeof site.pattern === "string") {
    const p = DENIAL_PATTERNS.find((x) => x.id === site.pattern);
    if (p && p.role in ROLE_PRIORITY) return p.role;
  }
  return "signal";
}

/**
 * 排序候选：未覆盖在前；同覆盖状态按 role 优先级 denial > policy > signal；
 * 再按 rel、line 升序。纯函数，不改入参。
 */
export function rankCandidates(sites) {
  const arr = Array.isArray(sites) ? sites.slice() : [];
  return arr.sort((a, b) => {
    const ca = a && a.coveredBy != null ? 1 : 0;
    const cb = b && b.coveredBy != null ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const ra = ROLE_PRIORITY[roleOfSite(a)];
    const rb = ROLE_PRIORITY[roleOfSite(b)];
    if (ra !== rb) return ra - rb;
    const la = String((a && a.rel) || "");
    const lb = String((b && b.rel) || "");
    if (la !== lb) return la < lb ? -1 : 1;
    return ((a && a.line) || 0) - ((b && b.line) || 0);
  });
}

/** 把连续空白折叠成单空格并去首尾。 */
function normalizeText(t) {
  return String(t == null ? "" : t).replace(/\s+/g, " ").trim();
}

/** 比对键：rel|pattern|normalize(text)。line 变化与空白差异都不算变更。 */
function censusKey(x) {
  return x.rel + "|" + x.pattern + "|" + normalizeText(x.text);
}

/** 两份扁平普查结果对比：{ added, removed }。 */
export function diffCensus(prev, next) {
  const P = Array.isArray(prev) ? prev : [];
  const N = Array.isArray(next) ? next : [];
  const prevKeys = new Set(P.map(censusKey));
  const nextKeys = new Set(N.map(censusKey));
  const added = N.filter((x) => !prevKeys.has(censusKey(x)));
  const removed = P.filter((x) => !nextKeys.has(censusKey(x)));
  return { added, removed };
}

/**
 * 站点归属：不是所有命中都值得补丁。
 *   agent    = 真正约束「我们自己这个 agent 能干什么」的现场（沙箱、审批、文件围栏、工具、钩子、权限预设）
 *   protocol = 宿主内部 RPC/HTTP 管道（api-gateway、typert、连接准入），401/403 是传输语义，不是给 agent 的闸门
 *   renderer = 客户端渲染层（client.js / client-ui-*），跑在浏览器里，改它不影响服务端放不放行
 *   vendor   = 打包进来的第三方（devtools chunk / acorn / parser），改了也是给别人打补丁
 * 只有 agent 范围的未覆盖站点才算「候选新补丁」。其余三类单列，避免用数字吓人。
 */
export function scopeOf(rel) {
  const s = String(rel || "");
  const pkg = s.split("/")[0];
  if (/\/devtools\/|acorn|\/chunks\//.test(s) || /inspector/.test(pkg)) return "vendor";
  if (/\.client\.js$|\/client\//.test(s) || /^dsh-client-ui/.test(pkg) || /\.client\./.test(s)) return "renderer";
  if (/^dsh-api-/.test(pkg) || /^dsh-typert/.test(pkg) || pkg === "dsh-client-connection" || pkg === "dsh-api-gateway") return "protocol";
  return "agent";
}

/** 汇总：总数、未覆盖数、按 pattern / 按包（rel 第一段）/ 按范围。 */
export function summarize(sites) {
  const arr = Array.isArray(sites) ? sites : [];
  const pat = new Map();
  const pkg = new Map();
  const scope = new Map();
  let uncovered = 0;
  for (const s of arr) {
    const isUncovered = !(s && s.coveredBy != null);
    if (isUncovered) uncovered += 1;
    const pid = s && s.pattern != null ? s.pattern : "(unknown)";
    const pkgName = String((s && s.rel) || "").split("/")[0] || "(unknown)";
    const p = pat.get(pid) || { pattern: pid, total: 0, uncovered: 0 };
    p.total += 1;
    if (isUncovered) p.uncovered += 1;
    pat.set(pid, p);
    const k = pkg.get(pkgName) || { pkg: pkgName, total: 0, uncovered: 0 };
    k.total += 1;
    if (isUncovered) k.uncovered += 1;
    pkg.set(pkgName, k);
    const sc = scopeOf(s && s.rel);
    const row = scope.get(sc) || { scope: sc, total: 0, uncovered: 0, candidates: 0 };
    row.total += 1;
    if (isUncovered) row.uncovered += 1;
    // 有满权早返回守卫的包：站点存在但运行时走不到，不算候选（同 chokepoints 的短路语义）
    if (isUncovered && !s.shortCircuited) row.candidates += 1;
    scope.set(sc, row);
  }
  const cmp = (a, b) => b.total - a.total || (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0);
  const cmpPkg = (a, b) => b.total - a.total || (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0);
  // 真候选只算 denial / policy；弱信号（signal）单列，不能进 headline，否则一句 "sandbox" 就把数字灌到四位数。
  let uncoveredStrict = 0;
  for (const s of arr) {
    if (s && (s.coveredBy != null || s.shortCircuited)) continue;
    if (roleOfSite(s) !== "signal") uncoveredStrict += 1;
  }
  return {
    total: arr.length,
    uncovered,
    uncoveredStrict,
    uncoveredSignal: uncovered - uncoveredStrict,
    byPattern: [...pat.values()].sort(cmp),
    byPkg: [...pkg.values()].sort(cmpPkg),
    byScope: [...scope.values()].sort((a, b) => b.total - a.total || (a.scope < b.scope ? -1 : 1)),
    candidates: [...scope.values()].reduce((n, r) => n + (r.scope === "agent" ? r.candidates || 0 : 0), 0),
    shortCircuited: arr.filter((s) => s && s.shortCircuited).length,
  };
}

/**
 * 中文报告：总览行 → 按 pattern 表 → 未覆盖站点前 limit 条 → 与基线 added/removed 各前 10 条。
 * 风格对齐 chokepoints-lib.renderChokeReport（但返回单个字符串）。
 */
export function renderCensusReport({ sites, summary, diff, limit = 30 } = {}) {
  const arr = Array.isArray(sites) ? sites : [];
  const sum = summary || summarize(arr);
  const lines = [];
  const covered = sum.total - sum.uncovered;
  lines.push("[census] 总览：站点 " + sum.total + " / 未覆盖 " + sum.uncovered + " / 已覆盖 " + covered);
  if (sum.uncoveredStrict != null) {
    lines.push("[census] 分类：真候选（denial+policy）未覆盖 " + sum.uncoveredStrict + " / 弱信号未覆盖 " + sum.uncoveredSignal + "（弱信号需人工收敛，不进候选）");
  }
  if (sum.byScope) {
    lines.push("[census] 按范围（只有 agent 范围算候选）：");
    for (const row of sum.byScope) lines.push("[census]   " + row.scope + "  总 " + row.total + "  未覆盖 " + row.uncovered);
    lines.push("[census] 候选（agent 范围、未覆盖、未被上游短路）：" + sum.candidates + "；上游短路忽略 " + (sum.shortCircuited || 0) + " 条");
  }
  lines.push("[census] 按 pattern：");
  if (!sum.byPattern || sum.byPattern.length === 0) lines.push("[census]   （无）");
  else for (const row of sum.byPattern) lines.push("[census]   " + row.pattern + "  总 " + row.total + "  未覆盖 " + row.uncovered);
  const SCOPE_ORDER = { agent: 0, protocol: 1, renderer: 2, vendor: 3 };
  const uncoveredSites = arr
    .filter((s) => !(s && s.coveredBy != null) && !(s && s.shortCircuited) && scopeOf(s && s.rel) === "agent")
    .sort((a, b) => {
      const ra = roleOfSite(a) === "signal" ? 1 : 0;
      const rb = roleOfSite(b) === "signal" ? 1 : 0;
      if (ra !== rb) return ra - rb;
      return String(a.rel) < String(b.rel) ? -1 : String(a.rel) > String(b.rel) ? 1 : (a.line || 0) - (b.line || 0);
    });
  const denialCount = arr.filter((s) => !(s && (s.coveredBy != null || s.shortCircuited)) && scopeOf(s && s.rel) === "agent" && roleOfSite(s) === "denial").length;
  const policyCount = arr.filter((s) => !(s && (s.coveredBy != null || s.shortCircuited)) && scopeOf(s && s.rel) === "agent" && roleOfSite(s) === "policy").length;
  lines.push("[census] 候选构成：denial（行为闸门）" + denialCount + " / policy（策略结构）" + policyCount + " —— 先补 denial");
  lines.push("[census] 未覆盖站点（前 " + limit + " 条）：");
  if (uncoveredSites.length === 0) lines.push("[census]   （无）");
  else for (const s of uncoveredSites.slice(0, limit)) lines.push("[census]   " + s.rel + ":" + s.line + "  " + String(s.text || "").slice(0, 120));
  if (diff) {
    const added = Array.isArray(diff.added) ? diff.added : [];
    const removed = Array.isArray(diff.removed) ? diff.removed : [];
    lines.push("[census] 与基线相比：新增 " + added.length + " 条 / 消失 " + removed.length + " 条");
    for (const s of added.slice(0, 10)) lines.push("[census]   + " + s.rel + ":" + s.line + " " + s.pattern + " " + String(s.text || "").slice(0, 120));
    for (const s of removed.slice(0, 10)) lines.push("[census]   - " + s.rel + ":" + s.line + " " + s.pattern + " " + String(s.text || "").slice(0, 120));
  }
  return lines.join("\n");
}
