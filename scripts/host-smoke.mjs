#!/usr/bin/env node
// 装后行为冒烟：bash / read / write / tool 四步，任何一步失败 exit 1。
// 只读宿主：不启动、不重启、不杀桌面进程；write 步骤只写 --workdir（默认临时目录）里的
// .dsh-smoke.tmp，写完即删。绝不写宿主安装目录。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { resolveDsh, smokePlan, evaluate, formatReport } from "../lib/host-smoke.js"

const USAGE = [
  "usage: node scripts/host-smoke.mjs [--resources <dir>] [--dsh <bin.js|dsh.cmd>]",
  "                                       [--workdir <dir>] [--timeout <ms>] [--json] [--keep]",
  "",
  "  --resources  宿主 resources 目录；默认从 DSH_RESOURCES / ~/.dsh 安装 journal / 默认安装目录探测",
  "  --dsh        直接指定 CLI 入口（bin.js 走 node，dsh.cmd 走 cmd.exe），绕过探测",
  "  --workdir    冒烟工作目录（read 步骤读它的 package.json）；默认新建临时目录并写入 fixture",
  "  --timeout    每步超时毫秒，默认 20000",
  "  --json       输出机器可读结果",
  "  --keep       保留临时工作目录（默认跑完删除）",
].join("\n")

function parse(argv) {
  const out = { resources: null, dsh: null, workdir: null, json: false, keep: false, timeout: 20000, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--resources") out.resources = argv[++i] || null
    else if (a === "--dsh") out.dsh = argv[++i] || null
    else if (a === "--workdir") out.workdir = argv[++i] || null
    else if (a === "--timeout") out.timeout = Number(argv[++i])
    else if (a === "--json") out.json = true
    else if (a === "--keep") out.keep = true
    else if (a === "--help" || a === "-h") out.help = true
    else throw new Error("unknown argument: " + a)
  }
  if (out.help) return out
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) throw new Error("--timeout 必须是正整数毫秒")
  return out
}

let args = null
try {
  args = parse(process.argv.slice(2))
} catch (error) {
  console.error("[host-smoke] " + ((error && error.message) || error))
  process.exit(2)
}

if (args.help) {
  console.log(USAGE)
  process.exit(0)
}

let temp = null
let leftover = null

function tail(text, max = 600) {
  const value = String(text || "").trim()
  if (!value) return ""
  return value.length > max ? "…" + value.slice(-max) : value
}

/** 只清理本次自己造的东西：临时目录、以及 write 步骤没来得及删的 .dsh-smoke.tmp。 */
function cleanup() {
  try {
    if (leftover && fs.existsSync(leftover) && !args.keep) fs.unlinkSync(leftover)
  } catch {
    // 删不掉不改变判定，下一次冒烟会在计划阶段拒绝覆盖
  }
  try {
    if (temp && !args.keep) fs.rmSync(temp, { recursive: true, force: true })
  } catch {
    // Windows 偶发 EPERM，临时目录交给系统清理
  }
}

function resolveHost() {
  if (args.dsh) {
    const entry = path.resolve(args.dsh)
    if (!fs.existsSync(entry)) throw new Error("--dsh 不存在: " + entry)
    if (/\.(?:cmd|bat)$/i.test(entry)) {
      return { kind: "cmd", command: process.env.ComSpec || process.env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c"], entry }
    }
    return { kind: "node", command: process.execPath, args: [entry], entry }
  }
  return resolveDsh({ resourcesDir: args.resources, home: process.env.DSH_HOME })
}

function runStep(step, workdir) {
  const started = Date.now()
  const r = spawnSync(step.command, step.args, {
    cwd: step.cwd || workdir,
    encoding: "utf8",
    timeout: args.timeout,
    windowsHide: true,
    windowsVerbatimArguments: !!step.verbatim,
    maxBuffer: 8 * 1024 * 1024,
  })
  const verdict = evaluate(step, {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error,
    timedOut: !!(r.error && r.error.code === "ETIMEDOUT"),
    timeoutMs: args.timeout,
  })
  return {
    id: step.id,
    ok: verdict.ok,
    reason: verdict.reason,
    ms: Date.now() - started,
    status: r.status,
    stdoutTail: tail(r.stdout),
    stderrTail: tail(r.stderr),
  }
}

function main() {
  let workdir = args.workdir ? path.resolve(args.workdir) : null
  if (workdir) {
    if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) throw new Error("--workdir 不存在或不是目录: " + workdir)
  } else {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-smoke-"))
    temp = workdir
  }
  const pkgFile = path.join(workdir, "package.json")
  if (!fs.existsSync(pkgFile)) {
    if (!temp) throw new Error("--workdir 里没有 package.json，read 步骤无法确定已知文件: " + pkgFile)
    fs.writeFileSync(pkgFile, JSON.stringify({ name: "dsh-smoke-fixture" }, null, 2) + "\n")
  }
  leftover = path.join(workdir, ".dsh-smoke.tmp")

  const dsh = resolveHost()
  if (!dsh) throw new Error("找不到 dsh：给 --dsh <bin.js|dsh.cmd> 或 --resources <resources>，或在 DSH_HOME/dsh-purge 安装 journal 里留过记录")
  const steps = smokePlan({ dsh, workdir })
  const results = steps.map((step) => runStep(step, workdir))
  const ok = results.length > 0 && results.every((item) => item.ok)

  if (args.json) {
    console.log(JSON.stringify({ ok, workdir, dsh: { kind: dsh.kind, entry: dsh.entry }, timeout: args.timeout, results }, null, 2))
  } else {
    console.log("[host-smoke] dsh=" + dsh.kind + " " + dsh.entry)
    console.log(formatReport(results))
    if (!ok) {
      for (const item of results) {
        if (item.ok) continue
        if (item.stdoutTail) console.log("\n[" + item.id + " stdout]\n" + item.stdoutTail)
        if (item.stderrTail) console.log("\n[" + item.id + " stderr]\n" + item.stderrTail)
      }
    }
    if (temp && args.keep) console.log("[host-smoke] 工作目录保留: " + workdir)
  }
  return ok ? 0 : 1
}

let code = 1
try {
  code = main()
} catch (error) {
  const message = (error && error.message) || String(error)
  if (args.json) console.log(JSON.stringify({ ok: false, error: message, workdir: temp }, null, 2))
  else console.error("[host-smoke] " + message)
  code = 1
} finally {
  cleanup()
}
process.exit(code)
