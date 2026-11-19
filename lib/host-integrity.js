import fs from "node:fs";
import path from "node:path";

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** 安装布局：resources/app 是要跑的树，resources/app.asar.unpacked 是 asar 里被跳过的原生文件。 */
export function hostLayout(resourcesDir) {
  const resources = path.resolve(resourcesDir);
  const appDir = path.join(resources, "app");
  return {
    resources,
    appDir,
    asar: path.join(resources, "app.asar"),
    unpacked: path.join(resources, "app.asar.unpacked"),
    runtimePkg: path.join(appDir, "dsh", "package.json"),
    appPkg: path.join(appDir, "package.json"),
  };
}

export function readHostVersion(appDir) {
  const dshPkg = readJson(path.join(appDir, "dsh", "package.json"));
  const appPkg = readJson(path.join(appDir, "package.json"));
  return {
    dsh: dshPkg?.version || null,
    desktop: appPkg?.version || null,
    name: appPkg?.name || null,
  };
}

function walkFiles(dir, base = dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, base, out);
    else if (ent.isFile()) out.push({ rel: path.relative(base, full).split(path.sep).join("/"), size: fs.statSync(full).size });
  }
  return out;
}

/** app 树里缺了哪些 unpacked 里的文件（按相对路径与字节数比对）。 */
export function missingFromUnpacked(layout) {
  if (!fs.existsSync(layout.unpacked)) return { checked: false, missing: [] };
  const missing = [];
  for (const f of walkFiles(layout.unpacked)) {
    let size = -1;
    try { size = fs.statSync(path.join(layout.appDir, f.rel)).size; } catch { size = -1; }
    if (size !== f.size) missing.push(f.rel);
  }
  return { checked: true, missing };
}

/** 原生绑定是否落地。崩溃信息里的两种路径都要认：optional 包 或 local build/nodeabi。 */
export function findRequireBuiltin(appDir) {
  // 两个候选位置：optional 包 node-addon-require-builtin-<平台>/prebuilt/*.node，
  // 以及 local-build 的 node-addon-require-builtin/build/nodeabi/*/require_builtin.node。
  // 文件名本身不一定叫 require_builtin（optional 包是 win32-x64-msvc-napi-v9.node），
  // 所以按「包目录名 + .node」判定，不能只匹配文件名。
  const mods = path.join(appDir, "dsh", "node_modules");
  const hits = [];
  const collect = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) collect(full, depth + 1);
      else if (ent.isFile() && ent.name.endsWith(".node")) hits.push(full);
    }
  };
  let entries;
  try { entries = fs.readdirSync(mods, { withFileTypes: true }); } catch { return hits; }
  for (const ent of entries) {
    if (!ent.isDirectory() || !/^node-addon-require-builtin/.test(ent.name)) continue;
    collect(path.join(mods, ent.name), 0);
  }
  return hits;
}

export function nativeCount(appDir) {
  let n = 0;
  const scan = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) scan(full, depth + 1);
      else if (ent.isFile() && ent.name.endsWith(".node")) n += 1;
    }
  };
  scan(appDir, 0);
  return n;
}

/**
 * 体检任意一棵 app 树（安装目录里的 app，或刚解包出来的 staging 树）。
 * resourceHint 给了才比对 app.asar.unpacked；staging 树没有配对的 unpacked 时该项跳过。
 */
export function inspectAppDir(appDir, resourceHint) {
  const resolved = path.resolve(appDir);
  const resources = resourceHint ? path.resolve(resourceHint) : path.dirname(resolved);
  const layout = {
    resources,
    appDir: resolved,
    asar: path.join(resources, "app.asar"),
    unpacked: path.join(resources, "app.asar.unpacked"),
  };
  const problems = [];
  if (!fs.existsSync(resolved)) {
    return { ...layout, ok: false, problems: ["app 目录不存在"], version: null, natives: 0, requireBuiltin: [], unpackedChecked: false, missing: [], asarPresent: false };
  }
  const version = readHostVersion(resolved);
  const { checked, missing } = missingFromUnpacked(layout);
  if (checked && missing.length > 0) problems.push(`app 缺 ${missing.length} 个 unpacked 文件（首个：${missing[0]}）`);
  const requireBuiltin = findRequireBuiltin(resolved);
  if (requireBuiltin.length === 0) problems.push("找不到 node-addon-require-builtin 的 .node（宿主会在 host preparation 阶段 fatal）");
  const natives = nativeCount(resolved);
  return {
    resources,
    appDir: resolved,
    asar: layout.asar,
    asarPresent: fs.existsSync(layout.asar),
    unpackedPresent: fs.existsSync(layout.unpacked),
    unpackedChecked: checked,
    missing,
    version,
    natives,
    requireBuiltin,
    ok: problems.length === 0,
    problems,
  };
}

/** 体检安装目录：resources 下必须有 app/。 */
export function inspectHost(resourcesDir) {
  const layout = hostLayout(resourcesDir);
  return inspectAppDir(layout.appDir, layout.resources);
}

export function formatHostReport(report) {
  const v = report.version || {};
  const lines = [
    `resources: ${report.resources}`,
    `版本: dsh=${v.dsh || "?"} desktop=${v.desktop || "?"}`,
    `原生 .node: ${report.natives} 个；require_builtin: ${report.requireBuiltin?.length || 0} 个`,
    `unpacked 校验: ${report.unpackedChecked ? (report.missing?.length ? `缺 ${report.missing.length}` : "齐全") : "无配对 app.asar.unpacked（跳过）"}`,
    `结论: ${report.ok ? "OK" : "FAIL"}`,
  ];
  for (const p of report.problems || []) lines.push(`  - ${p}`);
  return lines.join("\n");
}
