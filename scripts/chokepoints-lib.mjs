/**
 * chokepoints-lib —— 拦点（chokepoint）识别与覆盖求交的纯函数层
 *
 * 问题：宿主升级后，新增的限制闸门在哪？现有补丁还管不管用？
 *
 * 关键词扫描在这个规模上等于没扫：全树搜 deny|approval|sandbox 命中 1007 个文件，
 * 因为 reject 这种词在 README、类型定义、错误消息里到处都是。
 *
 * 真正能拦人的只有少数几种「调用形状」。这里把它们定成一小组正则，
 * 再用 --dump-config 给出的「实际加载清单」求交：形状命中 ∩ 已加载 ∩ 未禁用
 * ∩ 没被任何补丁覆盖 = 真缺口。
 *
 * 为什么要求交而不是只扫描：宿主树里有一堆装上了但 profile 没启用的包
 * （实验包、客户端包、桌面外壳依赖）。只看形状会把它们全算成新闸门。
 */

import fs from "node:fs";
import path from "node:path";

export const CHOKE_SCHEMA = 1;

/**
 * 拦点形状。每条都是一个「决策发生地」，不是关键词。
 * noiseLimit：命中数超过它就提示「这一条要人工收敛」——
 * 一个形状如果满树都是，它就不是 chokepoint 而是背景噪声。
 */
export const SHAPES = [
  {
    id: "approval-call",
    role: "restriction",
    label: "审批服务调用",
    layer: "代码",
    why: "审批决策的实际发生地：谁问、问什么、答案怎么被消费",
    re: /\b(?:this\.)?ctx\.approval\.(?:request|decide|ask|overrideOf|setPolicy|config)\b|\.approval\.(?:request|decide|ask|overrideOf|setPolicy)\(/,
    noiseLimit: 60,
  },
  {
    id: "sandbox-policy",
    role: "restriction",
    label: "沙箱策略读取",
    layer: "代码",
    why: "模式从哪来：resolve() 折叠出的 policy 决定了后面所有 confine 的松紧",
    re: /\b(?:this\.)?ctx\.sandboxPolicy\.(?:resolve|defaultMode|workspaceRoot)\b/,
    noiseLimit: 60,
  },
  {
    id: "sandbox-confine",
    role: "restriction",
    label: "沙箱包裹执行",
    layer: "代码",
    why: "命令真正被 confine 的那一步；mode 分支在这里决定放不放行",
    re: /\b(?:this\.)?ctx\.sandbox\.(?:confine|prepare|run|exec)\(/,
    noiseLimit: 40,
  },
  {
    id: "inject-decl",
    role: "restriction",
    label: "服务依赖声明",
    layer: "代码",
    why: "static inject 里点名 approval/sandbox 的插件，天生带拦人能力",
    re: /static\s+inject\s*=\s*\[[^\]]*\b(?:approval|sandboxPolicy|sandbox|permission)\b/,
    noiseLimit: 40,
  },
  {
    id: "deny-throw",
    role: "restriction",
    label: "拒绝类错误",
    layer: "代码",
    why: "抛出去就是拦住了；错误类型新增往往意味着新的拒绝路径",
    re: /throw new (?:Sandbox|Approval|Permission|Escalat|Refus)[A-Za-z]*Error\(/,
    noiseLimit: 60,
  },
  {
    id: "vocab",
    role: "signal",
    label: "策略词汇表",
    layer: "代码",
    why: "模式枚举一旦变长，说明可选的放行档位变了",
    re: /(?:APPROVAL_POLICIES|SANDBOX_MODES|WIDER_MODES|ESCALATION_TARGETS|[A-Z][A-Z_]*_CODES)\s*=\s*(?:\[|Object\.freeze|\{)/,
    noiseLimit: 40,
  },
  {
    id: "escalation-call",
    role: "restriction",
    label: "升级/校验入口",
    layer: "代码",
    why: "把受限模式换成更宽模式的唯一通道；这里的校验是一道独立闸门",
    re: /\b(?:approveEscalation|validateEscalationArgs|requestEscalation)\s*\(/,
    noiseLimit: 40,
  },
  {
    id: "mode-literal",
    role: "signal",
    label: "模式字面量比较",
    layer: "代码",
    why: "danger-full-access 这类字面量被反复比较的地方，就是松紧判断的现场",
    // 两种写法都算：字面量在右（mode === "danger-full-access"）与在左（"danger-full-access" ? ...）。
    // 只认字面量一侧，是因为 `const M = "danger-full-access"` 只是定义，不构成判断点。
    re: /(?:===|!==)\s*["\'](?:read-only|workspace-write|danger-full-access)["\']|["\'](?:read-only|workspace-write|danger-full-access)["\']\s*(?:===|!==|\?|:)/,
    noiseLimit: 80,
  },
  {
    id: "prompt-section",
    role: "target",
    label: "提示词段落注入",
    layer: "提示词",
    why: "提示词层补丁全靠改这些段落；段落被搬家，提示词补丁一起废",
    re: /\bsystemPrompt\.(?:section|replace|append|parts)\s*\(/,
    noiseLimit: 60,
  },
  {
    id: "tool-register",
    role: "target",
    label: "工具注册点",
    layer: "工具",
    why: "工具层补丁的做法是改注册参数或删工具；注册点搬家就失效",
    re: /\bctx\.tools\.(?:register|remove|list)\s*\(|\btools\.register\(/,
    noiseLimit: 80,
  },
];

/**
 * 扫一棵树，返回 {shapeId → [{rel, line, text}]}。
 * 只读 lib/ 下的 .js/.mjs/.cjs：宿主的功能实现全在这里，dist、测试、类型声明都不算决策点。
 * 单文件 4MB 上限：正常模块都在 2MB 内，超大文件基本是打包产物。
 */
export function scanShapes(aiBase, { shapes = SHAPES, only = null, maxBytes = 4 * 1024 * 1024 } = {}) {
  const hits = {};
  for (const s of shapes) hits[s.id] = [];
  const roots = fs.readdirSync(aiBase, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("dsh-"))
    .map((e) => e.name)
    .sort();
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
      const rel = root + "/" + path.relative(path.join(aiBase, root), abs).replace(/\\/g, "/");
      const lines = buf.split(/\r?\n/);
      for (const s of shapes) {
        for (let i = 0; i < lines.length; i += 1) {
          s.re.lastIndex = 0;
          if (!s.re.test(lines[i])) continue;
          hits[s.id].push({ rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
    }
  }
  return hits;
}

/**
 * 找出某个包 lib/index.js 里「内联了几份源码副本」。
 *
 * 宿主用打包器把 lib/types/*.js 直接内联进 lib/index.js，并留下
 * `//#region lib/types/retry-policy.js` 标记。于是同一段代码在树上有两份：
 * 真正被 import 的 index.js，和可能根本不在 exports 里的 types 副本。
 * 两份都扫会把每个命中数翻倍，缺口清单里出现成对的假阳性
 * （实测 dsh-llm 的 DEFAULT_RETRYABLE_CODES 就是 ×2）。
 *
 * 所以：包内 index.js 声明了 region 的类型文件，从扫描里剔除。
 * 判断依据是宿主自己的标记，不是猜的文件名。
 */
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

/** 把 scanShapes 的明细收成「每个形状有多少条、落在几个包」。 */
export function summarizeHits(hits, { limit = 60 } = {}) {
  const rows = [];
  for (const [shape, list] of Object.entries(hits)) {
    const byPkg = new Map();
    for (const h of list) {
      const pkg = h.rel.split("/")[0];
      byPkg.set(pkg, (byPkg.get(pkg) || 0) + 1);
    }
    const packages = [...byPkg.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    rows.push({ shape, total: list.length, files: new Set(list.map((h) => h.rel)).size, packages });
  }
  return rows.sort((a, b) => b.total - a.total);
}

/**
 * 解析 `dsh --profile <p> --dump-config` 的 YAML 输出。
 *
 * 不能用 YAML 库：值里有 !!js 自定义标签与多行 config 块，宿主自己也是按块读的。
 * 按「行首 - id:」切块，每块取 name / disabled 就够用了。
 * 段落头（# == ...）单独记：能看出这个 id 是宿主自带还是 profile 打的补丁。
 */
export function parseDumpConfig(text) {
  const lines = String(text || "").split(/\r?\n/);
  const sections = [];
  const entries = [];
  let cur = null;
  let section = "";
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const head = line.match(/^#\s*==\s*(.+)$/);
    if (head) {
      section = head[1].trim();
      if (!sections.includes(section)) sections.push(section);
      continue;
    }
    const idm = line.match(/^-\s+id:\s*(.+)$/);
    if (idm) {
      cur = { id: idm[1].trim(), section, name: "", disabled: false, disabledExpr: "" };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    const nm = line.match(/^\s+name:\s*[\x27"]?([^\x27"]+?)[\x27"]?\s*$/);
    if (nm && !cur.name) {
      cur.name = nm[1].trim();
      continue;
    }
    const dis = line.match(/^\s+disabled:\s*(.+)$/);
    if (dis) {
      const v = dis[1].trim();
      if (v === "true") cur.disabled = true;
      if (v.startsWith("!!js")) cur.disabledExpr = v;
    }
  }
  return { sections, entries };
}

/**
 * 从 dump-config 条目里取出包名。
 * name 形如 @deepseek-ai/dsh-sandbox 或 @deepseek-ai/dsh/tools：
 * 前者是包，后者是包内子入口，两者都要能对回树上的包目录。
 */
export function packageOfEntry(entry) {
  const n = String(entry && entry.name ? entry.name : "");
  const m = n.match(/^@[^/]+\/([^/]+)/);
  return m ? m[1] : "";
}

/** 条目是否真的会被加载。!!js 表达式无法静态求值，按「可能加载」算。 */
export function isLoaded(entry) {
  return !entry.disabled;
}

/**
 * 求交：形状命中 ∩ 该包真的被加载 = 有效拦点。
 * 再标出「没有任何补丁指向」的那些 = 真缺口候选。
 */
/**
 * 上下游短路表：下游包在「上游把 mode 设成 danger-full-access」时根本不执行限制逻辑。
 *
 * 实测证据（rc.1）：
 *   dsh-bash-sandbox/lib/index.js:68
 *   `if (mode === "danger-full-access") return SandboxBashExecutor.decorateResult(await super.execute(spec), ...)`
 * 这一行在 confine() 之前返回。也就是说：只要 dsh-sandbox-policy 的 defaultMode 被补丁改成
 * danger-full-access，dsh-bash-sandbox 里的 SandboxUnavailableError、ctx.sandbox.confine、
 * sandboxPolicy.resolve 全都走不到。给它们再写补丁是重复劳动，而且会在上游行为变化时
 * 变成"看起来必要其实无效"的僵尸补丁 —— 正是第 2 步要清理的那一类。
 *
 * 所以这类命中不当缺口，进 ignored 并写明短路依据。
 */
const UPSTREAM = {
  "dsh-bash-sandbox": { via: "dsh-sandbox-policy", why: "mode 由上游 policy 决定；满权时 execute() 在第 68 行就返回" },
  "dsh-pwsh-sandbox": { via: "dsh-sandbox-policy", why: "同上（pwsh 版第 154 行同形守卫）" },
  "dsh-ptc-runtime-node": { via: "dsh-sandbox-policy", why: "第 1110 行 policy.mode === danger-full-access ? void 0 : confine(...)" },
  "dsh-experimental-worktree": { via: "dsh-sandbox-policy", why: "第 147 行同形三元守卫" },
  "dsh-experimental-client-ui-forge": { via: "dsh-sandbox-policy", why: "第 372 行同形三元守卫" },
  "dsh-plugin-manager": { via: "dsh-user-approval", why: "唯一闸门是 approveEscalation 那次审批；审批服务已被补丁改成 never/自动放行" },
};

/** 这些形状会因上游短路而失效；throw / inject-decl / approval-call 不受影响。 */
const SHORT_CIRCUITABLE = new Set(["sandbox-policy", "sandbox-confine", "mode-literal", "deny-throw", "escalation-call"]);

/** 只有 mode 相关的形状会被「满权早返回」短路；审批类不会。 */
const MODE_GATED = new Set(["sandbox-policy", "sandbox-confine", "mode-literal", "deny-throw"]);

/**
 * 探测「满权早返回」守卫：这个包里有没有一行 `if (mode === "danger-full-access") return ...`
 *
 * 这是把 UPSTREAM 表从猜测变成证据。表里只写"谁可能被上游短路"，
 * 真正决定降不降级的是这一行在不在——上游升级把这个守卫删掉，
 * 短路立即失效，那些命中会自动重新变回缺口。反过来，只要守卫在，
 * 下游那堆 SandboxUnavailableError / confine / resolve 就一行都执行不到。
 *
 * 返回 pkg → {rel, line, text}。找不到返回空 Map。
 */
export function findShortCircuits(aiBase) {
  const out = new Map();
  // 两种写法都算：if (mode === "danger-full-access") return ... 与
  // policy.mode === "danger-full-access" ? void 0 : await ctx.sandbox.confine(...)
  const re = /(?:\bmode\s*===\s*["']danger-full-access["']|["']danger-full-access["']\s*===\s*\w*\.?mode\b)/;
  let roots = [];
  try {
    roots = fs.readdirSync(aiBase, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("dsh-"))
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const root of roots) {
    const libDir = path.join(aiBase, root, "lib");
    for (const abs of listJs(libDir)) {
      let buf;
      try {
        if (fs.statSync(abs).size > 4 * 1024 * 1024) continue;
        buf = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (!re.test(buf)) continue;
      const lines = buf.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (!re.test(lines[i])) continue;
        out.set(root, {
          rel: root + "/" + path.relative(path.join(aiBase, root), abs).replace(/\\/g, "/"),
          line: i + 1,
          text: lines[i].trim().slice(0, 180),
        });
        break;
      }
      if (out.has(root)) break;
    }
  }
  return out;
}

/** 形状 id → role。找不到就按 restriction 算（宁可多报，不要漏）。 */
function roleOf(shapeId) {
  const s = SHAPES.find((x) => x.id === shapeId);
  return s && s.role ? s.role : "restriction";
}

export function correlate(hits, dump, covered, shortCircuits = new Map()) {
  const loadedPkgs = new Set();
  const entryByPkg = new Map();
  for (const e of (dump && dump.entries) || []) {
    const pkg = packageOfEntry(e);
    if (!pkg) continue;
    if (!entryByPkg.has(pkg)) entryByPkg.set(pkg, []);
    entryByPkg.get(pkg).push(e);
    if (isLoaded(e)) loadedPkgs.add(pkg);
  }
  const rows = [];
  for (const [shape, list] of Object.entries(hits)) {
    const byPkg = new Map();
    for (const h of list) {
      const pkg = h.rel.split("/")[0];
      if (!byPkg.has(pkg)) byPkg.set(pkg, []);
      byPkg.get(pkg).push(h);
    }
    for (const [pkg, arr] of byPkg) {
      const known = entryByPkg.has(pkg);
      rows.push({
        shape,
        role: roleOf(shape),
        pkg,
        hits: arr.length,
        inDump: known,
        loaded: loadedPkgs.has(pkg),
        disabled: known && !loadedPkgs.has(pkg),
        covered: covered.has(pkg),
        shortCircuit: shortCircuits.get(pkg) || null,
        // 上游是否已被补丁覆盖，就在这一处算完。
        // 以前这件事由 findGaps 用第二个参数做，测试只把 covered 传给了 correlate，
        // 于是「上游已覆盖」这条规则在测试里静默失效——规则只能有一个计算点。
        upstream: UPSTREAM[pkg]
          ? { via: UPSTREAM[pkg].via, why: UPSTREAM[pkg].why, covered: covered.has(UPSTREAM[pkg].via) }
          : null,
        sample: arr.slice(0, 3).map((h) => h.rel + ":" + h.line + "  " + h.text),
      });
    }
  }
  return rows;
}

/**
 * 三道过滤后剩下的才是候选：
 *   1) 在 dump-config 里 → 真的会被加载（不在里面的是死代码/被 profile 裁掉的）
 *   2) 没被 disabled → 运行时确实执行
 *   3) 没有任何补丁覆盖 → 我们一条都没管
 * 其余全部进 ignored 并给出理由，因为「为什么不算缺口」和「算缺口」一样重要。
 */
export function findGaps(rows) {
  const gaps = [];
  const watch = [];
  const targets = [];
  const ignored = [];
  for (const r of rows) {
    let reason = "";
    if (!r.inDump) reason = "不在 dump-config 里（profile 不加载这个包）";
    else if (r.disabled) reason = "dump-config 里 disabled";
    if (reason) {
      ignored.push(Object.assign({}, r, { reason }));
      continue;
    }
    if (r.covered) {
      ignored.push(Object.assign({}, r, { reason: "已有补丁覆盖" }));
      continue;
    }
    if (SHORT_CIRCUITABLE.has(r.shape)) {
      if (r.shortCircuit && MODE_GATED.has(r.shape)) {
        ignored.push(Object.assign({}, r, {
          reason: "包内有满权早返回守卫（" + r.shortCircuit.rel + ":" + r.shortCircuit.line + "），此分支不执行",
        }));
        continue;
      }
      const up = r.upstream;
      if (up && up.covered) {
        ignored.push(Object.assign({}, r, { reason: up.via + " 已覆盖：" + up.why }));
        continue;
      }
    }
    // 未被覆盖、且真的会加载：按 role 分流。
    // restriction = 它自己就在拦人，没补丁 = 真缺口；
    // signal    = 策略词汇/模式字面量，是「这里可能有闸门」的路标，不是闸门本身；
    // target    = 补丁的附着点（提示词段落、工具注册），没人碰它不构成漏洞。
    if (r.role === "signal") watch.push(r);
    else if (r.role === "target") targets.push(r);
    else gaps.push(r);
  }
  const rank = (a, b) => b.hits - a.hits;
  return { gaps: gaps.sort(rank), watch: watch.sort(rank), targets: targets.sort(rank), ignored: ignored.sort(rank) };
}

/**
 * 两份 shape 扫描的对比：新增 / 变多 / 消失。
 * 这是回答「升级后哪里需要新补丁」的直接材料。
 * 按 (shape, pkg) 建键：同一个包同一个形状从 1 条涨到 7 条，也是新闸门的信号。
 */
export function diffShapes(beforeHits, afterHits) {
  const flatten = (hits) => {
    const m = new Map();
    for (const [shape, list] of Object.entries(hits || {})) {
      for (const h of list) {
        const pkg = h.rel.split("/")[0];
        const k = shape + "|" + pkg;
        const cur = m.get(k) || { shape, pkg, n: 0, samples: [] };
        cur.n += 1;
        if (cur.samples.length < 3) cur.samples.push(h.rel + ":" + h.line + "  " + h.text);
        m.set(k, cur);
      }
    }
    return m;
  };
  const a = flatten(beforeHits);
  const b = flatten(afterHits);
  const added = [];
  const removed = [];
  const grown = [];
  for (const [k, cur] of b) {
    const prev = a.get(k);
    if (!prev) added.push(cur);
    else if (cur.n > prev.n) grown.push(Object.assign({ was: prev.n }, cur));
  }
  for (const [k, prev] of a) {
    if (!b.has(k)) removed.push(prev);
  }
  const rank = (x, y) => y.n - x.n;
  return { added: added.sort(rank), grown: grown.sort(rank), removed: removed.sort(rank) };
}

// ---------------------------------------------------------------- 站点级（sites）
//
// 包级覆盖只回答「这个包有没有补丁」，回答不了「这个包里的 5 个决策点改了几个」。
// 下面这组函数把一条形状的命中展开成「站点」（每个决策行一个），再按补丁 needle
// 的行号（±window）求交，得到「这个站点到底被哪条补丁盖住、还是漏着」。

/**
 * 把 scanShapes 的 hits 展开成扁平站点数组。每个站点：
 *   { shape, role, pkg, rel, line, text }
 * role 由形状表给出；pkg 取 rel 第一段。按 rel → line → shape 升序，保证确定性。
 * 返回新数组，不改入参。
 */
export function sitesOf(hits) {
  const out = [];
  for (const [shape, list] of Object.entries(hits || {})) {
    const role = roleOf(shape);
    for (const h of Array.isArray(list) ? list : []) {
      if (!h) continue;
      const rel = String(h.rel || "");
      if (!rel) continue;
      out.push({
        shape,
        role,
        pkg: rel.split("/")[0],
        rel,
        line: Number(h.line) || 0,
        text: String(h.text == null ? "" : h.text),
      });
    }
  }
  out.sort((a, b) => {
    if (a.rel !== b.rel) return a.rel < b.rel ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.shape < b.shape ? -1 : a.shape > b.shape ? 1 : 0;
  });
  return out;
}

/** id 数值化：数值 id 按大小比，非数值当无穷大（同距时保留先到的）。 */
function siteIdNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * 给每个站点标注覆盖来源。spans 为 [{ id, rel, line }]。
 * 规则：rel 全等且 |site.line - span.line| <= window（闭区间），取最近；
 * 同距取 id 数值小的。返回新数组（每项加 coveredBy / distance），不改入参。
 */
export function coverageOf(sites, spans, { window = 15 } = {}) {
  const arr = Array.isArray(sites) ? sites : [];
  const spanList = Array.isArray(spans) ? spans : [];
  const win = Number.isFinite(window) ? window : 15;
  return arr.map((site) => {
    let best = null;
    if (site && typeof site.rel === "string") {
      const line = Number(site.line) || 0;
      for (const sp of spanList) {
        if (!sp || sp.rel !== site.rel) continue;
        const dist = Math.abs(line - (Number(sp.line) || 0));
        if (!(dist <= win)) continue;
        if (best === null || dist < best.distance
          || (dist === best.distance && siteIdNum(sp.id) < siteIdNum(best.id))) {
          best = { id: sp.id, distance: dist };
        }
      }
    }
    return Object.assign({}, site, {
      coveredBy: best ? best.id : null,
      distance: best ? best.distance : null,
    });
  });
}

/**
 * 站点级缺口分流，语义对齐 findGaps 但以「单个站点」为单位：
 *   - 已覆盖 → ignored（reason 写明覆盖来源与距离）
 *   - 未覆盖 + 形状可短路 + 包内有满权守卫（且形状受 mode 门控）→ ignored
 *   - 未覆盖 + 形状可短路 + 上游包已覆盖 → ignored
 *   - 未覆盖 + role 是 target / signal → watch（挂载点与路标，不构成缺口）
 *   - 其余未覆盖（role=restriction）→ gaps
 * shortCircuits: Map<pkg,{rel,line,text}>；upstream: { [pkg]: truthy } 表示该（上游）包已被补丁覆盖。
 * UPSTREAM / SHORT_CIRCUITABLE / MODE_GATED 直接复用模块常量，不另抄一份表。
 */
export function findSiteGaps(coveredSites, { shapes = SHAPES, shortCircuits = new Map(), upstream = {} } = {}) {
  const list = Array.isArray(coveredSites) ? coveredSites : [];
  const roleById = new Map();
  for (const s of Array.isArray(shapes) ? shapes : []) {
    if (s && s.id) roleById.set(s.id, s.role || "restriction");
  }
  const guardMap = shortCircuits instanceof Map ? shortCircuits : new Map(Object.entries(shortCircuits || {}));
  const upMap = upstream && typeof upstream === "object" ? upstream : {};
  const gaps = [];
  const watch = [];
  const ignored = [];
  for (const site of list) {
    if (!site) continue;
    const shape = site.shape;
    const pkg = site.pkg || String(site.rel || "").split("/")[0];
    const role = roleById.get(shape) || roleOf(shape);
    if (site.coveredBy != null) {
      ignored.push(Object.assign({}, site, {
        reason: "已被 " + site.coveredBy + " 覆盖（Δ" + site.distance + "）",
      }));
      continue;
    }
    if (SHORT_CIRCUITABLE.has(shape)) {
      const guard = guardMap.get(pkg);
      if (guard && MODE_GATED.has(shape)) {
        ignored.push(Object.assign({}, site, {
          reason: "包内有满权早返回守卫（" + guard.rel + ":" + guard.line + "），此站点不执行",
        }));
        continue;
      }
      const up = UPSTREAM[pkg];
      if (up && (upMap[up.via] || upMap[pkg])) {
        ignored.push(Object.assign({}, site, { reason: up.via + " 已覆盖：" + up.why }));
        continue;
      }
    }
    if (role === "target" || role === "signal") watch.push(site);
    else gaps.push(site);
  }
  const rank = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0) || (a.line - b.line);
  return { gaps: gaps.sort(rank), watch: watch.sort(rank), ignored: ignored.sort(rank) };
}

/**
 * 中文站点级报告串：总览 → 未覆盖站点列表（rel:line 形状 文本）→ 按包汇总
 * （包内站点数 / 已覆盖 / 未覆盖）。summary 由 CLI 计算后传入，字段：
 *   { total, covered, uncovered, byPkg: [{ pkg, sites, covered, uncovered }] }
 */
export function renderSiteReport({ gaps, watch = [], ignored = [], summary, limit = 30 } = {}) {
  const gapList = Array.isArray(gaps) ? gaps : [];
  const watchList = Array.isArray(watch) ? watch : [];
  const sum = summary && typeof summary === "object" ? summary : {};
  const uncoveredList = gapList.concat(watchList);
  const total = Number.isFinite(sum.total) ? sum.total : uncoveredList.length;
  const covered = Number.isFinite(sum.covered) ? sum.covered : null;
  const uncovered = Number.isFinite(sum.uncovered) ? sum.uncovered : uncoveredList.length;
  const lines = [];
  lines.push("[choke:sites] 总览：站点 " + total + " / 未覆盖 " + uncovered
    + (covered == null ? "" : " / 已覆盖 " + covered));
  lines.push("[choke:sites] 未覆盖站点（前 " + limit + " 条）：");
  if (uncoveredList.length === 0) {
    lines.push("[choke:sites]   （无）");
  } else {
    for (const s of uncoveredList.slice(0, limit)) {
      lines.push("[choke:sites]   " + s.rel + ":" + s.line + "  " + s.shape + "  " + String(s.text || "").slice(0, 100));
    }
  }
  lines.push("[choke:sites] 按包汇总（站点 / 已覆盖 / 未覆盖）：");
  const byPkg = Array.isArray(sum.byPkg) ? sum.byPkg : [];
  if (byPkg.length === 0) {
    lines.push("[choke:sites]   （无）");
  } else {
    for (const row of byPkg) {
      const sites = row.sites != null ? row.sites : (row.total || 0);
      lines.push("[choke:sites]   " + row.pkg + "  " + sites + " / " + (row.covered || 0) + " / " + (row.uncovered || 0));
    }
  }
  return lines.join("\n");
}

// ANCHOR_END

/** 人看的报告行：形状汇总 → 与基线对比 → 真缺口 → 排除理由。 */
export function renderChokeReport({ gaps, watch = [], targets = [], ignored, summary, diff, limit = 30 }) {
  const lines = [];
  lines.push("[choke] 形状命中：" + summary.map((s) => s.shape + " " + s.total).join(" / "));
  if (diff) {
    lines.push("[choke] 与基线相比：新增 " + diff.added.length + " 组 / 变多 " + diff.grown.length + " 组 / 消失 " + diff.removed.length + " 组");
    for (const g of diff.added.slice(0, limit)) lines.push("[choke]   + " + g.shape + " @ " + g.pkg + " ×" + g.n);
    for (const g of diff.grown.slice(0, limit)) lines.push("[choke]   ↑ " + g.shape + " @ " + g.pkg + " " + g.was + "→" + g.n);
    for (const g of diff.removed.slice(0, limit)) lines.push("[choke]   - " + g.shape + " @ " + g.pkg + " （原 ×" + g.n + "）");
  }
  const block = (title, rows, mark) => {
    if (rows.length === 0) return;
    lines.push("[choke] " + title + "：" + rows.length + " 组");
    for (const g of rows.slice(0, limit)) {
      lines.push("[choke]   " + mark + " " + g.shape + " @ " + g.pkg + " ×" + g.hits);
      for (const s of (g.sample || []).slice(0, 2)) lines.push("[choke]       " + s);
    }
  };
  block("真缺口（自己就在拦人、会加载、无补丁）", gaps, "!");
  block("路标（策略词汇/模式字面量，指向闸门不构成闸门）", watch, "~");
  block("附着点（提示词段落/工具注册，补丁的挂载位置）", targets, "·");
  const reasons = new Map();
  for (const r of ignored) reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1);
  lines.push("[choke] 已排除：" + [...reasons.entries()].map((kv) => kv[1] + " 组（" + kv[0] + "）").join(" / "));
  return lines;
}
