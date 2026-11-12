// 覆盖率棘轮基线的纯函数层（无 IO、无第三方依赖）。
//
// 设计见 docs/superpowers/specs/2026-11-11-test-mechanism-design.md 第 5.3 节。
//
// 为什么用「棘轮基线」而不是百分比阈值：把阈值定在 17%，等于宣布 lib/core.js
// 烂着也算合格。基线只记录「上一版实测到的数」，跌破才红，涨上去也不会自动改
// 文件（要靠人跑 npm run test:baseline 确认）。

export const BASELINE_SCHEMA = 1

const METRICS = ['lh', 'lf', 'fnh', 'fnf', 'brh', 'brf']

// 只有「命中数」算倒退；「总数」是源码体量，删代码让它变小不是覆盖率问题。
//
// 这条是踩出来的：把 lib/index.js 里 3 行冗余判定抽成纯函数后，lf 从 2953
// 掉到 2950，lh 反而 +1，检查器却报 FAIL。总数下降本身无害——真正要拦的是
// 「原来跑到的行/函数/分支现在跑不到了」，那由 lh/fnh/brh 负责。
const HIT_METRICS = new Set(['lh', 'fnh', 'brh'])

// 少数文件的分支命中数取决于**跑测试那台机器的文件系统现状**，同一 commit
// 在不同机器/不同残留状态下会漂几个分支，这种漂移不是「测试变差」。
//
// 实测（2026-11-12，lib/desktop.js）：同一 commit 连跑 4 次稳定在
// fnh 72 / brh 310~311；把 %TEMP% 下遗留的 dsh-purge-*.ps1 与日志移走后
// brh 310→311；换成空 HOME/USERPROFILE 跑则掉到 69/308。原因是这些函数
// 的分支挂在 existsSync/readdir 的结果上（~/.dsh 在不在、TEMP 里有没有
// 上次重启留下的脚本、npm 全局装没装 DSH）。
//
// 所以给这几格留容差：容差内的下跌仍然列进报告（看得见），但不算 FAIL。
// 容差只给「确认过是环境依赖」的文件，加之前必须先在干净 worktree 里
// 复现出同样的下跌，否则就是拿容差掩盖真倒退。
export const ENV_TOLERANCE = {
  'lib/desktop.js': { fnh: 2, brh: 4 },
}

/** 某个文件的某项指标允许的环境漂移量（默认 0）。 */
export function toleranceOf(file, metric) {
  const t = ENV_TOLERANCE[file]
  return t && typeof t[metric] === 'number' ? t[metric] : 0
}

// 把 lcov 文本解析成 { 'lib/core.js': { lh, lf, fnh, fnf, brh, brf } }。
// lcov 用 SF: 起段、end_of_record 收段；路径统一成正斜杠，Windows 反斜杠会
// 让「基线里是 lib/core.js、实测是 lib\core.js」这种纯格式差异被误判成掉文件。
export function parseLcov(text) {
  const out = {}
  let current = null
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('SF:')) {
      const name = line.slice(3).replace(/\\/g, '/').replace(/^\.\//, '')
      current = { lh: 0, lf: 0, fnh: 0, fnf: 0, brh: 0, brf: 0 }
      out[name] = current
      continue
    }
    if (!current) continue
    if (line === 'end_of_record') {
      current = null
      continue
    }
    const m = /^(LH|LF|FNH|FNF|BRH|BRF):(\d+)$/.exec(line)
    if (!m) continue
    current[m[1].toLowerCase()] = Number(m[2])
  }
  return out
}

// 只保留基线关心的文件：lib/ 下、且不是 docs/origin 里的历史快照
// （docs/origin/core-split-baseline-8066985/lib/core.js 是测试参照物，
// 它被覆盖是正常现象，不该混进我们自己的覆盖率账）。
export function selectCovered(coverage, { prefix = 'lib/' } = {}) {
  const out = {}
  for (const [file, stat] of Object.entries(coverage || {})) {
    if (!file.startsWith(prefix)) continue
    if (file.startsWith('docs/')) continue
    out[file] = stat
  }
  return out
}

export function buildBaseline(coverage, { commit = '', note = '', now = new Date() } = {}) {
  const files = {}
  for (const file of Object.keys(coverage).sort()) {
    const stat = coverage[file]
    files[file] = {}
    for (const key of METRICS) files[file][key] = Number(stat[key] || 0)
  }
  return {
    schema: BASELINE_SCHEMA,
    capturedAt: now.toISOString(),
    commit,
    note,
    files,
  }
}

// 比对。返回 { ok, rows, missing, added, dropped }
//   rows    = [{ file, metric, before, after }]，只列变化的（↑ 或 ↓ 都列）
//   missing = 基线里有、实测没有的文件（掉文件，红）
//   added   = 实测有、基线没有的文件（新文件，只提示，不红）
//   dropped = 命中类指标（lh/fnh/brh）after < before（红）；总数变小不算
export function diffBaseline(baseline, coverage) {
  const before = (baseline && baseline.files) || {}
  const rows = []
  const missing = []
  const added = []
  const dropped = []
  const tolerated = []

  for (const file of Object.keys(before).sort()) {
    const after = coverage[file]
    if (!after) {
      missing.push(file)
      continue
    }
    for (const metric of METRICS) {
      const b = Number(before[file][metric] || 0)
      const a = Number(after[metric] || 0)
      if (a === b) continue
      rows.push({ file, metric, before: b, after: a })
      if (!HIT_METRICS.has(metric)) continue
      if (a >= b) continue
      const tol = toleranceOf(file, metric)
      // 容差内：不算倒退，但 tolerated 里留痕，报告照列。
      if (b - a <= tol) tolerated.push({ file, metric, before: b, after: a, tolerance: tol })
      else dropped.push({ file, metric, before: b, after: a })
    }
  }
  for (const file of Object.keys(coverage).sort()) {
    if (!before[file]) added.push(file)
  }

  return { ok: dropped.length === 0 && missing.length === 0, rows, missing, added, dropped, tolerated }
}

const METRIC_LABEL = {
  lh: '行',
  lf: '行总数',
  fnh: '函数',
  fnf: '函数总数',
  brh: '分支',
  brf: '分支总数',
}

// 人读报告。只画变化项，没有任何变化时给一行绿。
export function renderReport(diff, { baselinePath = 'docs/test-baseline.json' } = {}) {
  const lines = []
  for (const row of diff.rows) {
    const arrow = row.after > row.before ? '↑' : '↓'
    const delta = row.after - row.before
    const sign = delta > 0 ? `+${delta}` : String(delta)
    lines.push(`  ${arrow} ${row.file} ${METRIC_LABEL[row.metric] || row.metric} ${row.before} → ${row.after} (${sign})`)
  }
  // 容差内的环境漂移：不算 FAIL，但要看得见——否则哪天真掉了 4 个分支
  // 也会被容差吞掉，而没人知道曾经有这一行提示。
  for (const row of diff.tolerated || []) {
    lines.push(
      `  ~ ${row.file} ${METRIC_LABEL[row.metric] || row.metric} ${row.before} → ${row.after} ` +
        `(-${row.before - row.after}，在环境容差 ${row.tolerance} 内)`,
    )
  }
  for (const file of diff.missing) {
    lines.push(`  ✖ ${file} 在基线里但本次没有覆盖率记录（文件被删或被 exclude 误伤）`)
  }
  for (const file of diff.added) {
    lines.push(`  ＋ ${file} 本次新增，基线里还没有（跑 npm run test:baseline 纳入）`)
  }
  if (!lines.length) lines.push('  覆盖率与基线完全一致')
  const head = diff.ok
    ? '[coverage] PASS 未跌破基线'
    : `[coverage] FAIL 覆盖率下降（基线 ${baselinePath}）`
  return [`${head}`, ...lines].join('\n')
}
