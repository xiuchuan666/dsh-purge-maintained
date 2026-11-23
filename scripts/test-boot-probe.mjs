/**
 * lib/boot-probe.js：预演启动探针。
 *
 * 这里钉住四件容易悄悄坏掉的事：
 *  1. 入口顺序不能反：桌面运行时包优先，CLI shim 兜底；都没有就是 skipped，不是失败；
 *  2. --dump-config 失败要退到 --version，但原生绑定缺失不许退（换参数不会把 .node 变出来）；
 *  3. 原生绑定错误串必须被认出来并单独命名，否则报告里只剩一句「退出码 1」；
 *  4. 子进程环境不继承 DSH_*：继承来的 DSH_HOME 会把探测带到用户已装的那棵树上。
 *
 * 不碰真实 dsh：所有入口都是临时树里的假 bin（node 脚本或 dsh.cmd）。
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  probeBoot,
  probeStep,
  resolveRuntime,
  detectNativeBinding,
  isolatedEnv,
  BOOT_TIMEOUT_MS,
} from "../lib/boot-probe.js"

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-boot-"))
test.after(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* Windows 偶发 EPERM */
  }
})

let seq = 0
function dir(tag) {
  seq += 1
  const d = path.join(sandbox, tag + "-" + seq)
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** 造一棵带 desktop-runtime 包的树；script 是这个包的 bin 的 node 脚本内容。 */
function runtimeTree(tag, script) {
  const tree = dir(tag)
  const pkgDir = path.join(tree, "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-runtime")
  fs.mkdirSync(path.join(pkgDir, "bin"), { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-desktop-runtime", version: "0.0.1", bin: { "dsh-desktop-runtime": "./bin/dsh.js" } }),
  )
  fs.writeFileSync(path.join(pkgDir, "bin", "dsh.js"), script)
  return tree
}

/** 假 bin：把模式、DSH_HOME、是否泄漏环境变量打成一行 JSON。 */
const OK_SCRIPT = [
  'const mode = process.argv.includes("--dump-config") ? "dump-config" : "version";',
  "process.stdout.write(JSON.stringify({ mode, home: process.env.DSH_HOME || null, leak: process.env.DSH_BOOT_LEAK || null, nodeOptions: process.env.NODE_OPTIONS || null }) + String.fromCharCode(10));",
].join("\n")

const NATIVE_SCRIPT = [
  'process.stderr.write("No usable native binding found for node-addon-require-builtin-win32-x64-msvc" + String.fromCharCode(10));',
  "process.exit(1);",
].join("\n")

const FAIL_SCRIPT = [
  'process.stderr.write("boom: cannot start" + String.fromCharCode(10));',
  "process.exit(3);",
].join("\n")

const FALLBACK_SCRIPT = [
  'if (process.argv.includes("--dump-config")) { process.stderr.write("config broken" + String.fromCharCode(10)); process.exit(4); }',
  'process.stdout.write("9.9.9" + String.fromCharCode(10));',
].join("\n")

const SILENT_SCRIPT = "process.exit(0);\n"

const SLOW_SCRIPT = "setTimeout(() => { process.stdout.write(\"late\\n\"); }, 5000);\n"

test("resolveRuntime：桌面运行时包的 bin 优先，路径从 package.json 里读", () => {
  const tree = runtimeTree("pkg-bin", OK_SCRIPT)
  const target = resolveRuntime({ treeDir: tree })
  assert.equal(target.runner, "desktop-runtime")
  assert.equal(target.kind, "node")
  assert.equal(target.command, process.execPath)
  assert.deepEqual(target.args, [target.entry])
  assert.match(target.entry, /dsh-desktop-runtime[\\/]bin[\\/]dsh\.js$/)
})

test("resolveRuntime：没有运行时包时退回 runtime/cli/bin/dsh.cmd", () => {
  const tree = dir("shim-only")
  const shim = path.join(tree, "resources", "runtime", "cli", "bin", "dsh.cmd")
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.writeFileSync(shim, "@echo off\r\n")
  const target = resolveRuntime({ treeDir: tree })
  assert.equal(target.runner, "cli-shim")
  assert.equal(target.kind, "cmd")
  assert.match(target.command, /cmd(\.exe)?$/i)
  assert.deepEqual(target.args, ["/d", "/s", "/c"])
  assert.equal(target.entry, shim)
})

test("resolveRuntime：两个入口都在时仍然是运行时包优先", () => {
  const tree = runtimeTree("both", OK_SCRIPT)
  const shim = path.join(tree, "resources", "runtime", "cli", "bin", "dsh.cmd")
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.writeFileSync(shim, "@echo off\r\n")
  assert.equal(resolveRuntime({ treeDir: tree }).runner, "desktop-runtime")
})

test("resolveRuntime：exe 同级 resources/runtime 也能找到 shim", () => {
  const root = dir("exe-hint")
  const exe = path.join(root, "DeepSeek Harness.exe")
  fs.writeFileSync(exe, "MZ")
  const shim = path.join(root, "resources", "runtime", "cli", "bin", "dsh.cmd")
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.writeFileSync(shim, "@echo off\r\n")
  const target = resolveRuntime({ treeDir: dir("exe-tree-empty"), exe })
  assert.equal(target.runner, "cli-shim")
  assert.equal(target.entry, shim)
})

test("resolveRuntime：空树返回 null", () => {
  assert.equal(resolveRuntime({ treeDir: dir("empty") }), null)
})

test("probeBoot：没有运行时入口 → skipped，不是失败", () => {
  const res = probeBoot({ treeDir: dir("no-entry") })
  assert.equal(res.ok, false)
  assert.equal(res.skipped, true)
  assert.match(res.reason, /没有运行时入口/)
  assert.deepEqual(res.attempts, [])
  assert.equal(res.command, null)
  assert.equal(probeStep(res).skipped, true)
  assert.equal(probeStep(res).verdict.ok, true)
})

test("probeBoot：候选树不存在 → 不 skip，原因点名路径", () => {
  const missing = path.join(sandbox, "definitely-not-here")
  const res = probeBoot({ treeDir: missing })
  assert.equal(res.skipped, false)
  assert.equal(res.ok, false)
  assert.match(res.reason, /候选树不存在/)
  assert.ok(res.reason.includes(missing))
})

test("probeBoot：成功一次 → ok，dump-config，带 stdout 与命令", () => {
  const tree = runtimeTree("ok", OK_SCRIPT)
  const res = probeBoot({ treeDir: tree, timeoutMs: 20000 })
  assert.equal(res.ok, true)
  assert.equal(res.skipped, false)
  assert.equal(res.mode, "dump-config")
  assert.equal(res.exitCode, 0)
  assert.equal(res.runner, "desktop-runtime")
  assert.equal(res.attempts.length, 1)
  assert.match(res.stdout, /"mode":"dump-config"/)
  assert.match(res.command, /--dump-config/)
  assert.equal(res.reason, "ok")
  assert.ok(res.durationMs >= 0)
  assert.equal(BOOT_TIMEOUT_MS >= 1000, true)
})

test("probeBoot：dump-config 失败 → 退到 --version 并成功", () => {
  const tree = runtimeTree("fallback", FALLBACK_SCRIPT)
  const res = probeBoot({ treeDir: tree, timeoutMs: 20000 })
  assert.equal(res.ok, true)
  assert.equal(res.mode, "version")
  assert.equal(res.attempts.length, 2)
  assert.equal(res.attempts[0].ok, false)
  assert.match(res.attempts[0].reason, /退出码 4/)
  assert.match(res.stdout, /9\.9\.9/)
  assert.match(res.command, /--version/)
})

test("probeBoot：原生绑定缺失 → 单独命名，且不再试 --version", () => {
  const tree = runtimeTree("native", NATIVE_SCRIPT)
  const res = probeBoot({ treeDir: tree, timeoutMs: 20000 })
  assert.equal(res.ok, false)
  assert.equal(res.skipped, false)
  assert.equal(res.native.detected, true)
  assert.match(res.native.detail, /No usable native binding found/)
  assert.match(res.reason, /原生绑定缺失/)
  assert.equal(res.exitCode, 1)
  assert.equal(res.attempts.length, 1)
  assert.match(res.stderr, /node-addon-require-builtin/)
  const step = probeStep(res)
  assert.equal(step.verdict.ok, false)
  assert.equal(step.rows[0].status, "native-binding")
  assert.equal(step.rows[0].bucket, "blocking")
})

test("probeBoot：普通失败 → 两个模式都试，原因是退出码加首行 stderr", () => {
  const tree = runtimeTree("fail", FAIL_SCRIPT)
  const res = probeBoot({ treeDir: tree, timeoutMs: 20000 })
  assert.equal(res.ok, false)
  assert.equal(res.attempts.length, 2)
  assert.equal(res.exitCode, 3)
  assert.match(res.reason, /退出码 3/)
  assert.match(res.reason, /boom/)
})

test("probeBoot：退出码 0 但 stdout 为空 → 不算成功", () => {
  const tree = runtimeTree("silent", SILENT_SCRIPT)
  const res = probeBoot({ treeDir: tree, timeoutMs: 20000 })
  assert.equal(res.ok, false)
  assert.equal(res.attempts.length, 2)
  assert.match(res.reason, /stdout 为空/)
})

test("probeBoot：超时 → timedOut，原因写清预算", () => {
  const tree = runtimeTree("slow", SLOW_SCRIPT)
  const res = probeBoot({ treeDir: tree, timeoutMs: 300 })
  assert.equal(res.ok, false)
  assert.equal(res.attempts[0].timedOut, true)
  assert.match(res.reason, /超时（300 ms）/)
  assert.equal(probeStep(res).rows[0].status, "timeout")
})

test("isolatedEnv：只留系统变量，DSH_* 与 NODE_OPTIONS 一个都不继承", () => {
  const env = isolatedEnv(undefined, { PATH: "/usr/bin", DSH_HOME: "/home/x/.dsh", DSH_RESOURCES: "/r", NODE_OPTIONS: "--max-old-space-size=64" })
  assert.equal(env.PATH, "/usr/bin")
  assert.equal(env.DSH_HOME, undefined)
  assert.equal(env.DSH_RESOURCES, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
})

test("probeBoot：子进程拿到的是全新临时 DSH_HOME，且探完就删", () => {
  const tree = runtimeTree("env", OK_SCRIPT)
  const res = probeBoot({ treeDir: tree, timeoutMs: 20000, baseEnv: { PATH: process.env.PATH, DSH_BOOT_LEAK: "leaked", NODE_OPTIONS: "--max-old-space-size=64" } })
  assert.equal(res.ok, true)
  const info = JSON.parse(res.stdout.trim())
  assert.equal(info.leak, null)
  assert.equal(info.nodeOptions, null)
  assert.match(info.home, /dsh-boot-probe-/)
  assert.notEqual(info.home, process.env.DSH_HOME)
  assert.equal(fs.existsSync(info.home), false)
})

test("probeBoot：home 选项可指定 DSH_HOME", () => {
  const home = dir("fixed-home")
  const tree = runtimeTree("home-opt", OK_SCRIPT)
  const res = probeBoot({ treeDir: tree, timeoutMs: 20000, home })
  assert.equal(res.ok, true)
  assert.equal(JSON.parse(res.stdout.trim()).home, home)
  assert.equal(fs.existsSync(home), true)
})

test("probeBoot：entry 覆盖直接跑指定入口", () => {
  const entry = path.join(dir("entry"), "fake-dsh.js")
  fs.writeFileSync(entry, OK_SCRIPT)
  const res = probeBoot({ treeDir: dir("entry-tree"), entry, timeoutMs: 20000 })
  assert.equal(res.ok, true)
  assert.equal(res.runner, "entry")
  assert.equal(res.entry, entry)
  const missing = probeBoot({ treeDir: dir("entry-tree2"), entry: path.join(sandbox, "nope.js") })
  assert.equal(missing.skipped, false)
  assert.match(missing.reason, /指定的运行时入口不存在/)
})

test("detectNativeBinding：认三种说法，不误伤普通缺模块", () => {
  assert.equal(detectNativeBinding("No usable native binding found for node-addon-require-builtin-win32-x64-msvc").detected, true)
  assert.equal(detectNativeBinding("Error: Cannot find module '/app/node_modules/node-addon-require-builtin/prebuilt/x.node'").detected, true)
  assert.equal(detectNativeBinding("Error: The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127").detected, true)
  assert.equal(detectNativeBinding("Cannot find module 'left-pad'").detected, false)
  assert.equal(detectNativeBinding("").detected, false)
  assert.equal(detectNativeBinding(null).detected, false)
})

test("probeStep：跳过 → 绿且标记 skipped", () => {
  const step = probeStep({ skipped: true, reason: "no runtime" })
  assert.equal(step.id, "boot")
  assert.equal(step.verdict.ok, true)
  assert.deepEqual(step.verdict.blocking, [])
  assert.equal(step.tally.skipped, 1)
})

test("probeStep：CLI shim 的非绑定失败只算黄，桌面运行时失败算红", () => {
  const shim = probeStep({ skipped: false, ok: false, runner: "cli-shim", mode: "version", exitCode: 1, reason: "退出码 1：no profile", attempts: [{ timedOut: false }] })
  assert.equal(shim.verdict.ok, true)
  assert.equal(shim.rows[0].bucket, "warn")
  const desktop = probeStep({ skipped: false, ok: false, runner: "desktop-runtime", mode: "dump-config", exitCode: 1, reason: "退出码 1：crash", attempts: [{ timedOut: false }] })
  assert.equal(desktop.verdict.ok, false)
  assert.equal(desktop.rows[0].bucket, "blocking")
})

test("probeBoot：真实 dsh.cmd 形态（cmd.exe 包装）也能跑", { skip: process.platform !== "win32" }, () => {
  const tree = dir("shim-run")
  const shim = path.join(tree, "resources", "runtime", "cli", "bin", "dsh.cmd")
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.writeFileSync(shim, "@echo off\r\necho shim-boot-ok\r\nexit /b 0\r\n")
  const res = probeBoot({ treeDir: tree, timeoutMs: 20000 })
  assert.equal(res.ok, true)
  assert.equal(res.runner, "cli-shim")
  assert.match(res.stdout, /shim-boot-ok/)
})
