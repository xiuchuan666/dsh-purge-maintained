/**
 * profile 清单 BOM 守卫（0.2.2 适配）。
 *
 * 0.2.2 的 app-boot 里 `readProfileManifest` 直接
 * `JSON.parse(readFileSync(fp, "utf8"))`，**不剥 BOM**。只要有人用
 * `Set-Content -Encoding UTF8`（PowerShell 5.1 会写 EF BB BF）、记事本
 * 另存、或某些编辑器保存过一次，清单首字节变成 BOM，宿主启动就抛
 *   DesktopHostFatalError: Unexpected token '\uFEFF' … is not valid JSON
 * 并弹出「应用无法启动或已意外停止」。整机起不来，插件自己也没机会跑。
 *
 * 这个模块做两件事：
 *   1. 扫描 profile 下的清单文件（package.json / cordis*.yml / pnpm-workspace.yaml），
 *      报告哪些带 BOM、哪些 JSON 解析不过；
 *   2. 剥掉 BOM（只有首字节确实是 BOM 时才写盘，写前写后都校验 JSON 可解析）。
 *
 * 调用点：CLI `--fix-bom`、插件 activate 时自愈、`--status` 报警。
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "./core.js";

export const BOM = "\uFEFF";

export const MANIFEST_FILES = [
  { name: "package.json", kind: "json" },
  { name: "cordis.patch.yml", kind: "yaml" },
  { name: "cordis.patch.yaml", kind: "yaml" },
  { name: "cordis.yml", kind: "yaml" },
  { name: "cordis.yaml", kind: "yaml" },
  { name: "pnpm-workspace.yaml", kind: "yaml" },
];

export function hasBom(text) {
  return String(text ?? "").startsWith(BOM);
}

export function stripBom(text) {
  const s = String(text ?? "");
  return s.startsWith(BOM) ? s.slice(1) : s;
}

/** 读文件并剥 BOM；读不到返回 ""。所有写回 profile 的路径都应经过它，BOM 不会再传播。 */
export function readTextNoBom(fp) {
  try {
    return stripBom(fs.readFileSync(fp, "utf8"));
  } catch {
    return "";
  }
}

function candidateFiles(dshHome) {
  const out = [];
  const home = String(dshHome || "");
  if (!home) return out;
  for (const item of MANIFEST_FILES) {
    out.push({ fp: path.join(home, item.name), kind: item.kind, scope: "home" });
  }
  const profilesDir = path.join(home, "profiles");
  let names = [];
  try { names = fs.readdirSync(profilesDir); } catch { names = []; }
  for (const name of names) {
    const dir = path.join(profilesDir, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch { continue; }
    for (const item of MANIFEST_FILES) {
      out.push({ fp: path.join(dir, item.name), kind: item.kind, scope: name });
    }
  }
  return out;
}

/**
 * 只读扫描。返回 { checked, bom:[...], broken:[...] }：
 *   bom    —— 首字节是 BOM 的清单（宿主 0.2.2 必然启动失败）
 *   broken —— JSON 类清单解析不过（BOM 之外的语法坏，例如半截写入）
 */
export function scanProfileBom(dshHome) {
  const report = { checked: 0, bom: [], broken: [], ok: true };
  for (const { fp, kind, scope } of candidateFiles(dshHome)) {
    let raw = "";
    try {
      raw = fs.readFileSync(fp, "utf8");
    } catch {
      continue; // 文件不存在：正常，profile 清单是可选的
    }
    report.checked += 1;
    const bom = hasBom(raw);
    let jsonError = "";
    if (kind === "json") {
      try {
        JSON.parse(stripBom(raw));
      } catch (err) {
        jsonError = String(err && err.message ? err.message : err);
      }
    }
    if (bom) report.bom.push({ path: fp, scope, kind });
    if (jsonError) report.broken.push({ path: fp, scope, kind, error: jsonError });
  }
  report.ok = report.bom.length === 0 && report.broken.length === 0;
  return report;
}

/** 剥 BOM 并写回。dryRun=true 只报告不写。返回 { fixed, failed, skipped, report }。 */
export function fixProfileBom(dshHome, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const result = { fixed: [], failed: [], skipped: [], report: null };
  for (const { fp, kind, scope } of candidateFiles(dshHome)) {
    let raw = "";
    try {
      raw = fs.readFileSync(fp, "utf8");
    } catch {
      continue;
    }
    if (!hasBom(raw)) {
      if (kind === "json") {
        try {
          JSON.parse(raw);
        } catch (err) {
          result.skipped.push({ path: fp, scope, kind, reason: "json-invalid", error: String(err && err.message ? err.message : err) });
        }
      }
      continue;
    }
    const text = stripBom(raw);
    if (kind === "json") {
      try {
        JSON.parse(text);
      } catch (err) {
        // 剥了 BOM 仍然解析不过：文件本身坏了，别写，交给用户/备份恢复
        result.failed.push({ path: fp, scope, kind, error: String(err && err.message ? err.message : err) });
        continue;
      }
    }
    if (dryRun) {
      result.fixed.push({ path: fp, scope, kind, dryRun: true });
      continue;
    }
    try {
      atomicWriteSync(fp, text, "utf8");
      const after = fs.readFileSync(fp, "utf8");
      if (hasBom(after)) throw new Error("BOM still present after write");
      if (kind === "json") JSON.parse(after);
      result.fixed.push({ path: fp, scope, kind });
    } catch (err) {
      result.failed.push({ path: fp, scope, kind, error: String(err && err.message ? err.message : err) });
    }
  }
  result.report = scanProfileBom(dshHome);
  return result;
}

/** 给 status / 日志用的一行摘要；没问题返回 ""。 */
export function bomWarningLine(dshHome) {
  const report = scanProfileBom(dshHome);
  if (report.ok) return "";
  const bits = [];
  if (report.bom.length) bits.push(`${report.bom.length} 个清单带 BOM（宿主 0.2.2 会起不来）`);
  if (report.broken.length) bits.push(`${report.broken.length} 个清单 JSON 坏`);
  return `清单告警 / manifest: ${bits.join("，")} —— 运行 dsh-purge --fix-bom 修复`;
}
