import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadJournal } from "./host-install-journal.js";

/**
 * 装后行为冒烟：不重启、不安装、不碰桌面进程，只验证「工具真能用」的四件事。
 *
 * 为什么是这四步：
 *  - bash：宿主工具的 bash 后端最终就是本机 shell，这一步起不来后面全是空谈；
 *  - read：读一个已知文件（workdir/package.json 的 name）。expect 在计划阶段直接从文件里取，
 *    所以「读到的内容对不对」不需要模型参与就能判；
 *  - write：只在 workdir 里写 .dsh-smoke.tmp、读回、删掉。计划阶段就把目标钉死在 workdir 下，
 *    任何情况下都不写宿主目录；
 *  - tool：dsh 可用时跑 --dump-config。这是唯一「不挂载、不启动 app」的只读清单命令，
 *    输出里能看到每个 tool/skill 插件是否组装进 profile；expect 用 tool-bash 包名。
 *
 * 不跑 headless 提示词：那要模型、要网络、要几十秒；装后冒烟要的是确定性。
 */

export const SMOKE_MARK = "dsh-smoke-ok";
export const WRITE_MARK = "dsh-smoke-write-ok";
export const TOOL_MARK = "@deepseek-ai/dsh-tool-bash";
export const TOOL_PROFILE = "headless";

// node -e 的脚本体：单行、不带模板字符串，免得外层再套一层转义。
const READ_SCRIPT = 'const fs=require("node:fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.name||""));}catch(e){process.stderr.write(String((e&&e.message)||e));process.exit(1);}';
const WRITE_SCRIPT = 'const fs=require("node:fs");const p=process.argv[1];fs.writeFileSync(p,"dsh-smoke"+String.fromCharCode(10));const back=fs.readFileSync(p,"utf8").trim();fs.unlinkSync(p);process.stdout.write(back==="dsh-smoke"?"dsh-smoke-write-ok":"write-mismatch");';

function defaultHome(home) {
  return home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** 安装路径探测顺序：env DSH_RESOURCES → ~/.dsh 安装 journal → 默认安装目录。 */
export function discoverResources(home) {
  const candidates = [];
  if (process.env.DSH_RESOURCES) candidates.push(process.env.DSH_RESOURCES);
  let journal = null;
  try {
    journal = loadJournal(defaultHome(home));
  } catch {
    journal = null;
  }
  if (journal && journal.resources) candidates.push(journal.resources);
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources"));
  candidates.push(path.join(os.homedir(), "AppData", "Local", "Programs", "DeepSeek Harness", "resources"));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return path.resolve(candidate);
    } catch {
      // 上一版安装目录已不存在，看下一个
    }
  }
  return null;
}

/**
 * 优先 resources/app/dsh/bin.js（node 直跑），其次官方 CLI shim dsh.cmd（cmd.exe 跑）。
 * 都不存在返回 null。cmd 型返回的 args 是 cmd.exe 的前缀，payload 由 smokePlan 拼完整命令行。
 */
export function resolveDsh(input) {
  const opts = input || {};
  const resources = opts.resourcesDir ? path.resolve(opts.resourcesDir) : discoverResources(opts.home);
  if (!resources || !fs.existsSync(resources)) return null;
  const nodeBin = path.join(resources, "app", "dsh", "bin.js");
  if (fs.existsSync(nodeBin)) {
    return { kind: "node", command: process.execPath, args: [nodeBin], entry: nodeBin, resources };
  }
  const installRoot = path.dirname(resources);
  const entry = [
    path.join(resources, "runtime", "cli", "bin", "dsh.cmd"),
    path.join(installRoot, "dsh.cmd"),
    path.join(resources, "dsh.cmd"),
  ].find((file) => fs.existsSync(file));
  if (!entry) return null;
  return { kind: "cmd", command: process.env.ComSpec || process.env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c"], entry, resources };
}

/**
 * .cmd 只能由 cmd.exe 执行。路径含空格时，整行要包成 ""path" args" 再配
 * windowsVerbatimArguments 原样交给 cmd；否则 Node 会给内层引号加反斜杠，cmd 不认。
 */
function cmdStep(dsh, extra) {
  const list = dsh.args || [];
  const entry = dsh.entry || list[list.length - 1];
  if (!entry) throw new Error("cmd 型 dsh 缺 entry: " + JSON.stringify(dsh));
  const line = '"' + entry + '"' + (extra.length > 0 ? " " + extra.join(" ") : "");
  return { command: dsh.command, args: [...list, '"' + line + '"'], verbatim: true };
}

/** 四步计划。dsh 缺失时只给前三步——tool 步骤没有可跑的命令，不伪造一条。 */
export function smokePlan(input) {
  const opts = input || {};
  const workdir = path.resolve(opts.workdir || process.cwd());
  let stat = null;
  try {
    stat = fs.statSync(workdir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) throw new Error("workdir 不存在或不是目录: " + workdir);

  const pkgFile = path.join(workdir, "package.json");
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  } catch {
    pkg = null;
  }
  if (!pkg || typeof pkg.name !== "string" || pkg.name.length === 0) {
    throw new Error("read 步骤缺少已知文件：读不到 " + pkgFile + " 的 name");
  }

  const target = path.join(workdir, ".dsh-smoke.tmp");
  if (path.dirname(target) !== workdir) throw new Error("write 步骤的目标跑出了 workdir: " + target);
  if (fs.existsSync(target)) throw new Error("workdir 里已有 .dsh-smoke.tmp，不覆盖: " + target);

  const bashPath = process.env.DSH_SMOKE_BASH || (process.platform === "win32" ? "bash" : "/bin/sh");
  const steps = [
    { id: "bash", command: bashPath, args: ["-c", "echo " + SMOKE_MARK], expect: SMOKE_MARK, cwd: workdir },
    { id: "read", command: process.execPath, args: ["-e", READ_SCRIPT, pkgFile], expect: pkg.name, cwd: workdir },
    { id: "write", command: process.execPath, args: ["-e", WRITE_SCRIPT, target], expect: WRITE_MARK, cwd: workdir },
  ];
  if (opts.dsh) {
    const extra = [TOOL_PROFILE, "--dump-config"];
    const tool = opts.dsh.kind === "cmd"
      ? cmdStep(opts.dsh, extra)
      : { command: opts.dsh.command, args: [...(opts.dsh.args || []), ...extra] };
    steps.push({ id: "tool", command: tool.command, args: tool.args, expect: TOOL_MARK, cwd: workdir, verbatim: !!tool.verbatim });
  }
  return steps;
}

function asText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function firstLine(text) {
  const line = String(text || "").split(/\r?\n/).find((item) => item.trim().length > 0);
  return line ? line.trim() : "";
}

/** 判定顺序：超时 → spawn 错误 → 退出码 → stdout/expect。每类都给具体原因，不合并成「失败」。 */
export function evaluate(step, result) {
  const r = result || {};
  const expect = step && step.expect != null ? String(step.expect) : "";
  const stdout = asText(r.stdout);
  const stderr = asText(r.stderr);
  if (r.timedOut || (r.error && r.error.code === "ETIMEDOUT")) {
    return { ok: false, reason: "超时" + (r.timeoutMs ? "（" + r.timeoutMs + " ms）" : "") };
  }
  if (r.error) return { ok: false, reason: "spawn 失败: " + (r.error.message || String(r.error)) };
  if (r.status !== 0) {
    const code = r.status === null || r.status === undefined ? "无（signal " + (r.signal || "unknown") + "）" : String(r.status);
    const detail = firstLine(stderr) || firstLine(stdout);
    return { ok: false, reason: "退出码 " + code + (detail ? "：" + detail : "") };
  }
  if (expect && !stdout.includes(expect)) {
    const got = stdout.trim().replace(/\s+/g, " ").slice(0, 120);
    return { ok: false, reason: 'stdout 里没有 expect "' + expect + '"' + (got ? "（实际：" + got + "）" : "（stdout 为空）") };
  }
  return { ok: true, reason: "ok" };
}

/** 文本摘要 + 总判定。results 里每项至少 {id, ok, reason}，可选 ms。 */
export function formatReport(results) {
  const list = Array.isArray(results) ? results : [];
  const lines = ["[host-smoke] " + list.length + " 步"];
  let passed = 0;
  for (const item of list) {
    const ok = !!(item && item.ok);
    if (ok) passed += 1;
    const id = String((item && item.id) || "?");
    const ms = item && item.ms != null ? " " + item.ms + "ms" : "";
    lines.push("  " + (ok ? "ok  " : "FAIL") + " " + id.padEnd(7) + ms + (ok ? "" : " — " + ((item && item.reason) || "失败")));
  }
  const verdict = list.length > 0 && passed === list.length ? "PASS" : "FAIL";
  lines.push("总判定：" + verdict + " " + passed + "/" + list.length);
  return lines.join("\n");
}
