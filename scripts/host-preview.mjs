#!/usr/bin/env node
/* 宿主升级预演：把目标版本装进隔离目录，逐条试 86 个补丁的锚点，回答「升上去会坏几条」。
 *
 *   node scripts/host-preview.mjs                     # 预演最新 rc（默认 0.2.2-rc.3）
 *   node scripts/host-preview.mjs --version 0.2.3     # 指定版本
 *   node scripts/host-preview.mjs --json              # 只输出 JSON
 *   node scripts/host-preview.mjs --keep              # 复用上次装好的树
 *
 * 预演目录在 .tmp-preview/（已 gitignore），真宿主一个字节都不碰。
 * 退出码：0 = 全部可打 / 1 = 有补丁会被这次升级打断 / 2 = 环境问题
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  classifyPreviewRow,
  summarizePreview,
  describePreview,
  isPrerelease,
} from "./host-preview-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const PREVIEW = path.join(REPO, ".tmp-preview");
const TREE = path.join(PREVIEW, "tree");
const AI = path.join(TREE, "node_modules", "@deepseek-ai");
const BASELINE = path.join(REPO, "docs", "host-baseline.json");
const NODE = process.execPath;
/* npm 的 CLI 入口按 node 自己所在目录推，不写死盘符：本机是
 * C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js，换机器/换 node 分发也能命中。
 * 直接 spawn npm.cmd 在 Windows 上会 EINVAL，所以必须走 node + npm-cli.js。
 * 找不到时退回 PATH 上的 npm（Linux/CI 那种 npm 与 node 不同前缀的装法）。 */
function npmCliPath() {
  const cands = [
    path.resolve(path.dirname(NODE), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(NODE), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  ];
  for (const c of cands) {
    if (fs.existsSync(c)) return { cli: c, viaNode: true };
  }
  return { cli: process.platform === "win32" ? "npm.cmd" : "npm", viaNode: false };
}
const NPM = npmCliPath();

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d = "") => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const version = opt("--version", "0.2.2-rc.3");

function installTree() {
  fs.mkdirSync(TREE, { recursive: true });
  fs.writeFileSync(
    path.join(TREE, "package.json"),
    `${JSON.stringify({ name: "dsh-host-preview", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  /* --ignore-scripts：预演只读文件，不需要任何 postinstall 产物。 */
  const argv = ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", `@deepseek-ai/dsh@${version}`];
  execFileSync(NPM.viaNode ? NODE : NPM.cli, NPM.viaNode ? [NPM.cli, ...argv] : argv, {
    cwd: TREE,
    stdio: "pipe",
    timeout: 900000,
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(AI, "dsh", "package.json"), "utf8"));
  return pkg.version;
}

async function main() {
  const core = await import(new URL("../lib/core.js", import.meta.url).href);
  const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  const wasById = new Map((baseline.patches || []).map((p) => [p.id, p]));

  if (!flag("--keep") || !fs.existsSync(path.join(AI, "dsh", "package.json"))) {
    fs.rmSync(TREE, { recursive: true, force: true });
    installTree();
  }
  const installed = JSON.parse(fs.readFileSync(path.join(AI, "dsh", "package.json"), "utf8")).version;

  const status = await core.patchStatus(AI);
  const rows = core.ALL_PATCHES.map((p) =>
    classifyPreviewRow({
      id: p.id,
      name: p.name,
      before: wasById.get(p.id)?.status,
      after: status[p.id],
    }),
  );
  const summary = summarizePreview(rows);
  const outcome = describePreview({
    rows,
    summary,
    hostVersion: installed,
    baseVersion: baseline.host?.version,
  });

  const payload = {
    target: version,
    installed,
    prerelease: isPrerelease(installed),
    aiBase: AI,
    patches: core.ALL_PATCHES.length,
    summary,
    outcome,
    broken: rows.filter((r) => r.kind === "broken-by-upgrade"),
  };

  if (flag("--json")) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log(`[preview] 目标 ${version} 实际装到 ${installed}${payload.prerelease ? "（预发布）" : ""}`);
    console.log(`[preview] 树 ${AI}`);
    console.log(`[preview] 补丁 ${payload.patches} 条：可打 ${summary.counts.ok} / 升级打断 ${summary.counts["broken-by-upgrade"]} / 本来就坏 ${summary.counts["already-broken"]} / 不适用 ${summary.counts["not-applicable"]}`);
    for (const row of payload.broken) {
      console.log(`[preview]   升级打断 #${row.id} ${row.name}（原 ${row.was} → 现 ${row.now}）`);
    }
    console.log(`[preview] 结论 ${outcome.verdict}：${outcome.detail}`);
  }

  process.exit(outcome.verdict === "compatible" ? 0 : 1);
}

main().catch((error) => {
  console.error(`[preview] 失败：${error?.stack || error}`);
  process.exit(2);
});
