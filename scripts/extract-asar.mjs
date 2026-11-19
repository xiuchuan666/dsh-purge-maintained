#!/usr/bin/env node
// 解 asar 到目录的唯一入口：解包 + 补 .unpacked 原生文件 + 校验。
// 只调 extractAsar 会得到缺原生绑定（*.node）的空壳树，宿主启动即 fatal：
//   No usable native binding found for node-addon-require-builtin-...
import fs from "node:fs";
import path from "node:path";
import { extractAsar, overlayAsarUnpacked, missingUnpackedFiles } from "../lib/extract-asar.js";

function parseArgs(argv) {
  const out = { clean: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--asar") out.asar = argv[++i];
    else if (a === "--dest") out.dest = argv[++i];
    else if (a === "--clean") out.clean = true;
    else if (a === "--skip-extract") out.skipExtract = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("usage: node scripts/extract-asar.mjs --asar <app.asar> --dest <dir> [--clean] [--skip-extract]");
  process.exit(0);
}
if (!args.asar || !args.dest) {
  console.error("usage: node scripts/extract-asar.mjs --asar <app.asar> --dest <dir> [--clean]");
  process.exit(2);
}
const asarPath = path.resolve(args.asar);
const destDir = path.resolve(args.dest);
if (!fs.existsSync(asarPath)) throw new Error(`asar not found: ${asarPath}`);
if (args.clean && fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });

const extracted = args.skipExtract ? null : extractAsar(asarPath, destDir);
const overlay = overlayAsarUnpacked(asarPath, destDir);
const missing = missingUnpackedFiles(asarPath, destDir);
const unpackedDir = `${asarPath}.unpacked`;
const result = {
  asar: asarPath,
  dest: destDir,
  extracted,
  overlaid: overlay.copied ?? 0,
  unpackedPresent: fs.existsSync(unpackedDir),
  missing,
};
console.log(JSON.stringify(result, null, 2));
if (missing.length > 0) {
  console.error(`[extract-asar] FAIL: ${missing.length} unpacked native file(s) missing in dest`);
  process.exit(1);
}
