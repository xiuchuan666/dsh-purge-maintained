#!/usr/bin/env node
// 宿主适配事务编排：stage → probe → snapshot → swap → verify → pin。
// 默认 dry-run：只打印计划与校验结果，--apply 才动文件/进程。
// 设计原则：树必须先过 probe（原生绑定可加载）才允许靠近 resources/app；
// 旧树用 rename 保留为 app.prev-<ts>，新树复制失败或 probe 失败立即回滚。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectAppDir, inspectHost, formatHostReport } from "../lib/host-integrity.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parse(argv) {
  const out = { apply: false, json: false };
  const cmd = argv[0];
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--json") out.json = true;
    else if (a === "--asar") out.asar = argv[++i];
    else if (a === "--dest") out.dest = argv[++i];
    else if (a === "--tree") out.tree = argv[++i];
    else if (a === "--resources") out.resources = argv[++i];
    else if (a === "--backup") out.backup = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return { cmd, ...out };
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 退出码 ${r.status}`);
  return r;
}

function defaultResources() {
  return process.env.DSH_RESOURCES
    || "C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources";
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** 在目标树里真加载一次原生绑定；只靠文件存在不够，ABI 不符同样会崩。 */
function probeTree(appDir) {
  const report = inspectAppDir(path.resolve(appDir));
  const lines = [formatHostReport(report)];
  let loaded = 0;
  for (const file of report.requireBuiltin || []) {
    const r = spawnSync(process.execPath, ["-e", "require(process.argv[1])", file], { encoding: "utf8", timeout: 20000 });
    const ok = r.status === 0;
    if (ok) loaded += 1;
    lines.push(`  load ${path.basename(file)}: ${ok ? "ok" : "FAIL " + (r.stderr || "").split("\n")[0]}`);
  }
  return { report, lines, loaded, ok: report.ok && loaded > 0 };
}

function cmdStage(args) {
  const asar = args.asar;
  const dest = args.dest;
  if (!asar || !dest) throw new Error("stage 需要 --asar <app.asar> --dest <tree>");
  if (!args.apply) {
    console.log(`[dry-run] node scripts/extract-asar.mjs --asar ${asar} --dest ${dest} --clean`);
    return 0;
  }
  run(process.execPath, [path.join(ROOT, "scripts", "extract-asar.mjs"), "--asar", asar, "--dest", dest, "--clean"]);
  const p = probeTree(dest);
  console.log(p.lines.join("\n"));
  return p.ok ? 0 : 1;
}

function cmdProbe(args) {
  if (!args.tree) throw new Error("probe 需要 --tree <appDir>");
  const p = probeTree(args.tree);
  console.log(p.lines.join("\n"));
  return p.ok ? 0 : 1;
}

function cmdSnapshot(args) {
  const resources = path.resolve(args.resources || defaultResources());
  const dest = path.resolve(args.backup || path.join(ROOT, ".tmp-host-backup", stamp()));
  if (!args.apply) {
    console.log(`[dry-run] snapshot ${resources} → ${dest}`);
    return 0;
  }
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(resources, dest, { recursive: true, force: true });
  console.log(`snapshot ok: ${dest}`);
  return 0;
}

function cmdSwap(args) {
  const resources = path.resolve(args.resources || defaultResources());
  const tree = path.resolve(args.tree || "");
  const appDir = path.join(resources, "app");
  const asar = path.join(resources, "app.asar");
  if (!args.tree) throw new Error("swap 需要 --tree <newAppDir> --resources <dir>");
  const p = probeTree(tree);
  console.log(p.lines.join("\n"));
  if (!p.ok) return 1;
  const ts = stamp();
  const prev = path.join(resources, `app.prev-${ts}`);
  const asarBak = path.join(resources, `app.asar.adopt-bak-${ts}`);
  const steps = [
    `rename ${appDir} → ${path.basename(prev)}`,
    `cp ${tree} → ${appDir}`,
    asarPresent(resources) ? `rename ${asar} → ${path.basename(asarBak)}` : null,
    "probe 新树（失败则回滚 rename）",
  ].filter(Boolean);
  if (!args.apply) {
    console.log("[dry-run] " + steps.join(" → "));
    return 0;
  }
  let moved = false;
  try {
    if (fs.existsSync(appDir)) { fs.renameSync(appDir, prev); moved = true; }
    fs.cpSync(tree, appDir, { recursive: true, force: true });
    if (asarPresent(resources)) fs.renameSync(asar, asarBak);
    const after = probeTree(appDir);
    console.log(after.lines.join("\n"));
    if (!after.ok) throw new Error("新树 probe 失败");
    console.log(`swap ok: ${appDir}（旧树保留 ${prev}）`);
    return 0;
  } catch (error) {
    try { fs.rmSync(appDir, { recursive: true, force: true }); } catch { /* 半成品清不掉也不覆盖旧树 */ }
    if (moved) fs.renameSync(prev, appDir);
    if (fs.existsSync(asarBak)) fs.renameSync(asarBak, asar);
    console.error(`swap 回滚完成：${error.message}`);
    return 1;
  }
}

function asarPresent(resources) {
  return fs.existsSync(path.join(resources, "app.asar"));
}

function cmdPin(args) {
  const tree = path.resolve(args.tree || "");
  if (!args.tree) throw new Error("pin 需要 --tree <appDir 或 @deepseek-ai 目录>");
  const aiBase = tree.endsWith(path.join("node_modules", "@deepseek-ai")) ? tree : path.join(tree, "dsh", "node_modules", "@deepseek-ai");
  if (!fs.existsSync(aiBase)) throw new Error(`找不到 ${aiBase}`);
  const jobs = [
    [path.join(ROOT, "scripts", "patch-gates.mjs"), ["--tree", `adopt=${aiBase}`, "--write"]],
    [path.join(ROOT, "scripts", "restriction-census.mjs"), ["--ai-base", aiBase, "--write-baseline"]],
    [path.join(ROOT, "scripts", "host-baseline.mjs"), ["--capture"]],
  ];
  for (const [script, argv] of jobs) {
    console.log(`\n$ node ${path.relative(ROOT, script)} ${argv.join(" ")}`);
    if (!args.apply) continue;
    run(process.execPath, [script, ...argv]);
  }
  return 0;
}

function cmdVerify(args) {
  const report = inspectHost(path.resolve(args.resources || defaultResources()));
  console.log(formatHostReport(report));
  return report.ok ? 0 : 1;
}

const args = parse(process.argv.slice(2));
const table = { stage: cmdStage, probe: cmdProbe, snapshot: cmdSnapshot, swap: cmdSwap, pin: cmdPin, verify: cmdVerify };
if (!table[args.cmd] || args.cmd === "--help") {
  console.log("usage: node scripts/host-adopt.mjs <stage|probe|snapshot|swap|pin|verify> [options]");
  console.log("  --apply 真执行（默认 dry-run）；stage: --asar --dest；probe: --tree；");
  console.log("  snapshot: [--resources] [--backup]；swap: --tree [--resources]；pin: --tree");
  process.exit(args.cmd === "--help" ? 0 : 2);
}
try {
  process.exit(table[args.cmd](args));
} catch (error) {
  console.error(`[host-adopt] ${error.message}`);
  process.exit(1);
}
