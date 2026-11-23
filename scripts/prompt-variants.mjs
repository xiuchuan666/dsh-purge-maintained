#!/usr/bin/env node
// 提示词变体资产盘点：扫描 docs/prompt-inject-v*.md，输出统计表、JSON 或核心 marker 检查结果。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORE_MARKERS,
  analyzeVariantText,
  coreMarkersForText,
  listVariantFiles,
  summarizeVariants,
  variantVersion,
} from "../lib/prompt-variants.js";

const SCRIPT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
  }
}

function parseArgs(argv) {
  const options = {
    root: SCRIPT_ROOT,
    json: false,
    baseline: "v1",
    check: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") {
      options.json = true;
    } else if (token === "--check") {
      options.check = true;
    } else if (token === "--help" || token === "-h") {
      options.help = true;
    } else if (token === "--root" || token === "--baseline") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError("参数 " + token + " 缺少值");
      }
      options[token.slice(2)] = value;
      i += 1;
    } else if (token.startsWith("--root=")) {
      options.root = token.slice("--root=".length);
    } else if (token.startsWith("--baseline=")) {
      options.baseline = token.slice("--baseline=".length);
    } else {
      throw new CliError("未知参数: " + token);
    }
  }
  return options;
}

function loadEntries(root) {
  const files = listVariantFiles(root);
  if (files.length === 0) {
    throw new CliError("未找到 docs/prompt-inject-v*.md: " + root);
  }
  return files.map((file) => {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      throw new CliError("读取失败 " + file + ": " + error.message);
    }
    const analysis = analyzeVariantText(text);
    return {
      version: variantVersion(file),
      file,
      path: file,
      ...analysis,
      coreMarkers: coreMarkersForText(text),
    };
  });
}

function printTable(summary) {
  const lines = ["版本\t字节\t字符\t行数\tSHA12\t标题数\t槽位数\t核心marker"];
  for (const row of summary.rows) {
    lines.push([
      row.version,
      row.bytes,
      row.chars,
      row.lines,
      row.sha12,
      row.headings,
      row.slots,
      row.coreMarkersComplete ? "是" : "否",
    ].join("\t"));
  }
  lines.push([
    "合计",
    summary.totals.bytes,
    summary.totals.chars,
    summary.totals.lines,
    "-",
    summary.totals.headings,
    summary.totals.slots,
    summary.totals.coreMarkersComplete ? "是" : "否",
  ].join("\t"));
  console.log(lines.join("\n"));
}

function jsonPayload(root, summary) {
  return {
    root,
    baselineVersion: summary.baselineVersion,
    rows: summary.rows,
    totals: summary.totals,
  };
}

function checkEntries(entries, summary, options) {
  const results = entries.map((entry) => {
    const missing = CORE_MARKERS.filter((name) => !entry.coreMarkers.includes(name));
    return {
      version: entry.version,
      ok: missing.length === 0,
      missing,
    };
  });
  const ok = results.every((result) => result.ok);
  if (options.json) {
    console.log(JSON.stringify({
      root: options.root,
      check: { ok, results },
      rows: summary.rows,
      totals: summary.totals,
    }, null, 2));
  } else {
    for (const result of results) {
      if (result.ok) {
        console.log(result.version + ": OK");
      } else {
        console.log(result.version + ": MISSING " + result.missing.join(", "));
      }
    }
    console.log(ok ? "PASS" : "CHECK FAIL");
  }
  process.exitCode = ok ? 0 : 1;
}

function printHelp() {
  console.log([
    "用法: node scripts/prompt-variants.mjs [选项]",
    "",
    "选项:",
    "  --root <目录>      仓库根目录（默认当前脚本所在仓库）",
    "  --json             输出 JSON 统计",
    "  --baseline <版本>  对比基线，默认 v1",
    "  --check            检查每个变体的核心 marker，缺失时退出码 1",
    "  --help             显示帮助",
  ].join("\n"));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const entries = loadEntries(options.root);
  const summary = summarizeVariants(entries, { baselineVersion: options.baseline });
  if (options.check) {
    checkEntries(entries, summary, options);
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(jsonPayload(options.root, summary), null, 2));
    return;
  }
  printTable(summary);
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 2;
}
