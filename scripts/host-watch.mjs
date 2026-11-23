#!/usr/bin/env node
/* 宿主更新探测（只读）：HEAD 上游安装包，与 state 比，给下一步手动命令；绝不安装。
 *
 *   node scripts/host-watch.mjs                     # = --check（默认）
 *   node scripts/host-watch.mjs --check --json
 *   node scripts/host-watch.mjs --download [--dest <exe>] [--force]
 *   node scripts/host-watch.mjs --plan [--json]
 *   node scripts/host-watch.mjs --plan --rehearse    # 只看 rehearse 段
 *   node scripts/host-watch.mjs --state <path> --home <dir> --url <url> --installdir <dir>
 *
 * 只写两处：state 文件（--no-save 可关）和下载目录。安装/换树永远走 scripts/host-install.mjs。
 * 退出码：0 探测/下载/计划完成（new/unchanged/unknown 都算完成）；1 网络或写盘失败；2 用法。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import {
  DEFAULT_URL,
  buildPlan,
  decideDetail,
  defaultDownloadDest,
  defaultInstalldir,
  loadStateInfo,
  nextState,
  parseHead,
  saveState,
  statePath,
} from "../lib/host-watch.js";

const USER_AGENT = "dsh-purge-host-watch/1 (read-only probe)";
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
function opt(name, fallback) {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : "";
  if (value && !value.startsWith("--")) return value;
  return fallback === undefined ? "" : fallback;
}

function usage() {
  console.log("usage: node scripts/host-watch.mjs [--check] [--json] [--state <path>] [--url <url>] [--home <dir>]");
  console.log("       node scripts/host-watch.mjs --download [--dest <exe>] [--force] [--state <path>]");
  console.log("       node scripts/host-watch.mjs --plan [--rehearse] [--json] [--installdir <dir>]");
  console.log("  只读探测：只写 state 与下载目录，不安装、不替换 resources、不启动宿主。");
  console.log("  --check 是默认动作；--rehearse 只列 rehearse 段。退出码 0 成功 / 1 网络或写盘失败 / 2 用法。");
}

if (has("--help") || has("-h")) {
  usage();
  process.exit(0);
}

const json = has("--json");
const url = opt("--url", DEFAULT_URL);
const home = opt("--home", os.homedir());
const stateFile = opt("--state", statePath(home));
const destOpt = opt("--dest", "");
const installdir = opt("--installdir", defaultInstalldir());
const timeout = Number(opt("--timeout", "15000")) || 15000;
const force = has("--force");
const noSave = has("--no-save");
const onlyRehearse = has("--rehearse");
const mode = has("--download") ? "download" : has("--plan") || onlyRehearse ? "plan" : "check";

function bytesLabel(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value < 0) return "?";
  if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(2) + " GiB";
  if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MiB";
  if (value >= 1024) return (value / 1024).toFixed(1) + " KiB";
  return value + " B";
}

function withCode(error, target) {
  const code = error && error.code ? String(error.code) + ": " : "";
  const message = error && error.message ? error.message : String(error);
  const wrapped = new Error(code + message + "（" + target + "）");
  if (error && error.code) wrapped.code = error.code;
  return wrapped;
}

function requestOnce(target, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(target);
    const client = parsed.protocol === "http:" ? http : https;
    const headers = Object.assign({ "user-agent": USER_AGENT, accept: "*/*" }, options.headers || {});
    const req = client.request(parsed, { method: options.method, headers }, (res) => resolve(res));
    req.setTimeout(options.timeout, () => {
      const error = new Error("超时 " + options.timeout + "ms 没有响应");
      error.code = "ETIMEDOUT";
      req.destroy(error);
    });
    req.on("error", reject);
    req.end();
  });
}

async function request(target, options) {
  const opts = options || {};
  let method = opts.method || "HEAD";
  let current = target;
  for (let hop = 0; hop <= 5; hop += 1) {
    let res = null;
    try {
      res = await requestOnce(current, { method, headers: opts.headers, timeout: opts.timeout || timeout });
    } catch (error) {
      throw withCode(error, current);
    }
    const status = res.statusCode || 0;
    if (REDIRECT_CODES.has(status) && res.headers.location) {
      res.resume();
      current = new URL(String(res.headers.location), current).href;
      if (status === 303) method = "GET";
      continue;
    }
    return { res, url: current, status };
  }
  throw new Error("重定向超过 5 次（" + target + "）");
}

function contentRangeTotal(headers) {
  const raw = headers && (headers["content-range"] || headers["Content-Range"]);
  const match = raw ? /\/(\d+)\s*$/.exec(String(raw)) : null;
  return match ? Number(match[1]) : null;
}

/* 有的 CDN 拒绝 HEAD（405/501/403）。退回一次 Range: bytes=0-0，从 Content-Range 拿总长度，
 * 拿到头就 destroy，不把 300 MB 真正拉下来。 */
async function headOf(target, idleTimeout) {
  const first = await request(target, { method: "HEAD", timeout: idleTimeout });
  if (first.status === 405 || first.status === 501 || first.status === 403) {
    first.res.destroy();
    const second = await request(target, {
      method: "GET",
      timeout: idleTimeout,
      headers: { range: "bytes=0-0" },
    });
    if (second.status >= 400) {
      const status = second.status;
      const text = second.res.statusMessage || "";
      second.res.destroy();
      throw new Error("HTTP " + status + (text ? " " + text : "") + "（" + second.url + "）");
    }
    const head = parseHead(second.res.headers);
    const total = contentRangeTotal(second.res.headers);
    if (total !== null) head.contentLength = total;
    second.res.destroy();
    return { head, url: second.url, status: second.status, via: "range" };
  }
  if (first.status >= 400) {
    const status = first.status;
    const text = first.res.statusMessage || "";
    first.res.destroy();
    throw new Error("HTTP " + status + (text ? " " + text : "") + "（" + first.url + "）");
  }
  const head = parseHead(first.res.headers);
  first.res.resume();
  return { head, url: first.url, status: first.status, via: "head" };
}

async function runCheck() {
  const stateInfo = loadStateInfo(stateFile);
  const prev = stateInfo.state;
  const hit = await headOf(url, timeout);
  const detail = decideDetail(prev, hit.head);
  const merged = nextState(prev, hit.head, { url: hit.url, status: detail.verdict });
  let saved = "";
  let saveError = "";
  if (!noSave) {
    try {
      saved = saveState(stateFile, merged);
    } catch (error) {
      saveError = error.message;
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "check",
          url: hit.url,
          status: hit.status,
          via: hit.via,
          verdict: detail.verdict,
          by: detail.by,
          reason: detail.reason,
          head: hit.head,
          previous: prev
            ? {
                etag: prev.etag == null ? null : prev.etag,
                lastModified: prev.lastModified == null ? null : prev.lastModified,
                contentLength: prev.contentLength == null ? null : prev.contentLength,
              }
            : null,
          statePath: stateFile,
          stateStatus: stateInfo.reason || "",
          stateSaved: Boolean(saved),
          stateError: saveError || null,
          firstSeenAt: merged.firstSeenAt,
        },
        null,
        2,
      ),
    );
    return;
  }

  const head = hit.head;
  console.log("[watch] HEAD " + hit.url + " → HTTP " + hit.status + "（" + hit.via + "）");
  console.log("[watch] ETag: " + (head.etag || "（响应没给）") + "   上次: " + (prev && prev.etag ? prev.etag : "（无基线）"));
  if (head.lastModified || (prev && prev.lastModified)) {
    console.log("[watch] Last-Modified: " + (head.lastModified || "（没给）") + "   上次: " + ((prev && prev.lastModified) || "（无）"));
  }
  if (head.contentLength !== null) {
    console.log("[watch] Content-Length: " + head.contentLength + " B（" + bytesLabel(head.contentLength) + "）");
  }
  const verdictText =
    detail.verdict === "new"
      ? "new（上游换了新 build）"
      : detail.verdict === "unchanged"
        ? "unchanged（与上次相同）"
        : "unknown（指纹不足，不能判断）";
  console.log("[watch] 判定: " + verdictText + "；依据 " + detail.by + "：" + detail.reason);
  if (saved) console.log("[watch] state 已写 " + saved);
  else if (saveError) console.log("[watch] state 没写成（不影响本次判定）：" + saveError);
  else console.log("[watch] state 未写（--no-save）");
  if (detail.verdict === "unchanged") {
    console.log("[watch] 不用动：没有新 build。");
    return;
  }
  console.log("[watch] 下一步（手动；本工具只生成命令，不执行）：");
  console.log("         node scripts/host-watch.mjs --download");
  console.log("         node scripts/host-watch.mjs --plan");
}

async function runDownload() {
  const stateInfo = loadStateInfo(stateFile);
  const prev = stateInfo.state || null;
  let etag = prev && prev.etag ? String(prev.etag) : "";
  let expected = prev ? prev.contentLength : null;
  let source = url;
  if (!etag) {
    const probe = await headOf(url, timeout);
    etag = probe.head.etag || "";
    expected = probe.head.contentLength;
    source = probe.url;
    console.log("[watch] state 里没有 ETag，已用 HEAD 取到：" + (etag || "（上游没给，文件名用 latest）"));
  }
  const dest = destOpt || defaultDownloadDest(home, etag);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const expectFromState = typeof expected === "number" ? expected : null;
  if (fs.existsSync(dest) && !force) {
    const size = fs.statSync(dest).size;
    if (expectFromState === null || size === expectFromState) {
      if (json) {
        console.log(JSON.stringify({ ok: true, mode: "download", skipped: true, dest, bytes: size }, null, 2));
      } else {
        console.log("[watch] 已存在 " + dest + "（" + size + " B），跳过；要重下加 --force");
      }
      return;
    }
    console.log("[watch] 现有文件 " + size + " B 与预期 " + expectFromState + " B 不符，重下");
  }

  const part = dest + ".part";
  fs.rmSync(part, { force: true });
  let bytes = 0;
  let responseUrl = source;
  let headerLength = null;
  let responseEtag = null;
  try {
    const hit = await request(source, { method: "GET", timeout: Math.max(timeout, 30000) });
    if (hit.status >= 400) {
      const status = hit.status;
      const text = hit.res.statusMessage || "";
      hit.res.destroy();
      throw new Error("HTTP " + status + (text ? " " + text : "") + "（" + hit.url + "）");
    }
    responseUrl = hit.url;
    const head = parseHead(hit.res.headers);
    headerLength = head.contentLength;
    responseEtag = head.etag;
    const expect = headerLength !== null ? headerLength : expectFromState;
    hit.res.on("data", (chunk) => {
      bytes += chunk.length;
    });
    await pipeline(hit.res, fs.createWriteStream(part));
    if (expect !== null && bytes !== expect) {
      throw new Error("Content-Length " + expect + " 与实际写入 " + bytes + " 不符(.part 已删除)");
    }
    if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    fs.renameSync(part, dest);
    if (responseEtag && etag && responseEtag !== etag) {
      console.log("[watch] 注意：下载响应的 ETag " + responseEtag + " 与 state 的 " + etag + " 不同，上游可能刚换代");
    }
    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: "download",
            skipped: false,
            url: responseUrl,
            dest,
            bytes,
            contentLength: headerLength,
            etag: responseEtag || etag || null,
            verified: expect === null ? "unknown" : bytes === expect,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log("[watch] 已下载 " + dest);
    console.log("[watch] 大小 " + bytes + " B（" + bytesLabel(bytes) + "）" + (expect === null ? "；上游没给长度，未校验" : "；Content-Length 校验通过"));
    console.log("[watch] 没有运行它。下一步：node scripts/host-watch.mjs --plan");
  } catch (error) {
    try {
      fs.rmSync(part, { force: true });
    } catch {
      /* 已经没了 */
    }
    throw error;
  }
}

function runPlan() {
  const stateInfo = loadStateInfo(stateFile);
  const etag = stateInfo.state && stateInfo.state.etag ? stateInfo.state.etag : "";
  const dest = destOpt || defaultDownloadDest(home, etag);
  const steps = buildPlan({ url, destFile: dest, installdir });
  const shown = onlyRehearse ? steps.filter((step) => step.kind === "rehearse") : steps;

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "plan",
          url,
          dest,
          installdir,
          statePath: stateFile,
          manualOnly: true,
          steps: shown,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("[plan] 只生成命令，不执行；宿主安装永远走 scripts/host-install.mjs（默认 dry-run）。");
  console.log("[plan] 下载落点 " + dest);
  for (const step of shown) {
    console.log("");
    console.log("[" + step.index + "/" + steps.length + "] " + step.kind + "  " + step.title);
    console.log("    " + step.command);
    for (const extra of step.extra || []) console.log("    " + extra);
    for (const note of step.notes || []) console.log("    # " + note);
  }
  console.log("");
  if (onlyRehearse) {
    console.log("[plan] 这是 rehearse 段；完整四步：node scripts/host-watch.mjs --plan");
  } else {
    console.log("[plan] 只看预演段：node scripts/host-watch.mjs --plan --rehearse");
  }
}

async function main() {
  if (mode === "plan") {
    runPlan();
    return;
  }
  if (mode === "download") {
    await runDownload();
    return;
  }
  await runCheck();
}

main().catch((error) => {
  const code = error && error.code ? String(error.code) + ": " : "";
  const message = error && error.message ? error.message : String(error);
  if (json) console.log(JSON.stringify({ ok: false, mode, error: code + message }, null, 2));
  console.error("[watch] 失败：" + code + message);
  const proxy = PROXY_VARS.filter((key) => process.env[key]);
  if (proxy.length) {
    console.error("[watch] 环境里有代理变量 " + proxy.join(", ") + "；Node 原生请求不会自动走代理，请确认本机代理是透明的，或改用浏览器手动下载。");
  }
  console.error("[watch] 宿主没有被改动：本工具只写 state 与下载目录。");
  process.exit(1);
});
