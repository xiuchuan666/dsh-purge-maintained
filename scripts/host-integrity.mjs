#!/usr/bin/env node
// 宿主树体检：装之前/装之后各跑一次。退出码 1 = 这棵树启动会 fatal。
import path from "node:path";
import fs from "node:fs";
import { inspectHost, formatHostReport } from "../lib/host-integrity.js";

function parse(argv) {
  const out = { resources: null, json: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--resources") out.resources = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const args = parse(process.argv.slice(2));
if (args.help) {
  console.log("usage: node scripts/host-integrity.mjs [--resources <dir>] [--json] [--quiet]");
  process.exit(0);
}
const resources = args.resources
  || process.env.DSH_RESOURCES
  || "C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources";
if (!fs.existsSync(resources)) {
  if (args.quiet) process.exit(0);
  console.log(JSON.stringify({ skipped: true, reason: "resources 不存在", resources }, null, 2));
  process.exit(0);
}
const report = inspectHost(path.resolve(resources));
if (args.json) console.log(JSON.stringify(report, null, 2));
else if (!args.quiet) console.log(formatHostReport(report));
process.exit(report.ok ? 0 : 1);
