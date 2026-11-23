/**
 * lib/host-smoke.js：装后冒烟的入口探测、四步计划、判定与报告。
 *
 * 这里钉住三件容易悄悄坏掉的事：
 *  1. dsh 入口只认两种形态（bin.js 直跑 / dsh.cmd 经 cmd.exe），探测顺序不能反；
 *  2. write 步骤的目标必须落在 workdir 里，否则一次冒烟就会往宿主目录写垃圾；
 *  3. evaluate 的四类失败（超时、spawn、退出码、缺 expect）必须各给各的原因，
 *     否则真出问题时只剩一句「失败」，装机现场没法定位。
 *
 * 不碰真实 dsh：所有可执行入口都是 node -e 假命令或临时目录里的空 dsh.cmd。
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import { resolveDsh, smokePlan, evaluate, formatReport, SMOKE_MARK, WRITE_MARK, TOOL_MARK } from "../lib/host-smoke.js"

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-smoke-"))
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

function pkgDir(name) {
  const d = dir("work")
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name }))
  return d
}

/** node -e 假 dsh：只打印 tool 步的 expect，证明命令行拼对了。 */
function fakeDsh() {
  return { kind: "node", command: process.execPath, args: ["-e", 'process.stdout.write("' + TOOL_MARK + '")'], entry: "fake-bin.js" }
}

test("resolveDsh：resources/app/dsh/bin.js 存在时走 node 直跑", () => {
  const res = dir("res-node")
  const bin = path.join(res, "app", "dsh", "bin.js")
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, "console.log(1)\n")
  const dsh = resolveDsh({ resourcesDir: res, home: dir("home-node") })
  assert.equal(dsh.kind, "node")
  assert.equal(dsh.command, process.execPath)
  assert.deepEqual(dsh.args, [bin])
  assert.equal(dsh.entry, bin)
})

test("resolveDsh：没有 bin.js 时退回官方 CLI shim（cmd.exe 形态）", () => {
  const res = dir("res-cmd")
  const cmd = path.join(res, "runtime", "cli", "bin", "dsh.cmd")
  fs.mkdirSync(path.dirname(cmd), { recursive: true })
  fs.writeFileSync(cmd, "@echo off\r\n")
  const dsh = resolveDsh({ resourcesDir: res, home: dir("home-cmd") })
  assert.equal(dsh.kind, "cmd")
  assert.match(dsh.command, /cmd\.exe$/i)
  assert.deepEqual(dsh.args, ["/d", "/s", "/c"])
  assert.equal(dsh.entry, cmd)
})

test("resolveDsh：dsh.cmd 与 DeepSeek Harness.exe 同级时也能找到", () => {
  // 独立的安装根目录：别把 dsh.cmd 丢进共享 sandbox，否则别的用例会探测到它
  const root = dir("install-sibling")
  const res = path.join(root, "resources")
  fs.mkdirSync(res)
  const cmd = path.join(root, "dsh.cmd")
  fs.writeFileSync(cmd, "@echo off\r\n")
  const dsh = resolveDsh({ resourcesDir: res, home: dir("home-sibling") })
  assert.equal(dsh.kind, "cmd")
  assert.equal(dsh.entry, cmd)
})

test("resolveDsh：两样都没有返回 null", () => {
  const res = path.join(dir("res-empty"), "resources")
  fs.mkdirSync(res)
  assert.equal(resolveDsh({ resourcesDir: res, home: dir("home-empty") }), null)
  assert.equal(resolveDsh({ resourcesDir: path.join(sandbox, "missing-root"), home: dir("home-missing") }), null)
})

test("resolveDsh：没有 resourcesDir 时用 ~/.dsh 安装 journal 里的路径", () => {
  const home = dir("home-journal")
  const res = dir("res-journal")
  const bin = path.join(res, "app", "dsh", "bin.js")
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, "console.log(1)\n")
  fs.mkdirSync(path.join(home, "dsh-purge"), { recursive: true })
  fs.writeFileSync(path.join(home, "dsh-purge", "host-install-journal.json"), JSON.stringify({ version: 1, state: "done", resources: res }))
  const saved = process.env.DSH_RESOURCES
  delete process.env.DSH_RESOURCES
  try {
    const dsh = resolveDsh({ home })
    assert.equal(dsh.kind, "node")
    assert.equal(dsh.entry, bin)
  } finally {
    if (saved !== undefined) process.env.DSH_RESOURCES = saved
  }
})

test("smokePlan：四步的 id / command / args / expect 都钉死", () => {
  const workdir = pkgDir("smoke-fixture")
  const steps = smokePlan({ dsh: fakeDsh(), workdir })
  assert.deepEqual(steps.map((s) => s.id), ["bash", "read", "write", "tool"])
  assert.equal(steps[0].expect, SMOKE_MARK)
  assert.deepEqual(steps[0].args, ["-c", "echo " + SMOKE_MARK])
  assert.equal(steps[1].expect, "smoke-fixture")
  assert.equal(steps[1].args[steps[1].args.length - 1], path.join(workdir, "package.json"))
  assert.equal(steps[2].expect, WRITE_MARK)
  assert.equal(steps[3].expect, TOOL_MARK)
  assert.equal(steps[3].args[steps[3].args.length - 2], "headless")
  assert.equal(steps[3].args[steps[3].args.length - 1], "--dump-config")
  for (const step of steps) assert.equal(step.cwd, workdir)
})

test("smokePlan：write 目标只在 workdir 里，删完不留文件", () => {
  const workdir = pkgDir("write-scope")
  const write = smokePlan({ dsh: fakeDsh(), workdir }).find((s) => s.id === "write")
  const target = write.args[write.args.length - 1]
  assert.equal(target, path.join(workdir, ".dsh-smoke.tmp"))
  assert.equal(path.dirname(target), workdir)
})

test("smokePlan：cmd 型 dsh 的 tool 步给 cmd.exe 一条 verbatim 命令行", () => {
  const workdir = pkgDir("cmd-tool")
  const entry = path.join(sandbox, "with space", "dsh.cmd")
  const dsh = { kind: "cmd", command: "cmd.exe", args: ["/d", "/s", "/c"], entry }
  const tool = smokePlan({ dsh, workdir }).find((s) => s.id === "tool")
  assert.equal(tool.verbatim, true)
  assert.equal(tool.args[0], "/d")
  assert.deepEqual(tool.args.slice(0, 3), ["/d", "/s", "/c"])
  assert.equal(tool.args[tool.args.length - 1], '"' + '"' + entry + '" headless --dump-config' + '"')
})

test("smokePlan：workdir 不存在时计划直接报错", () => {
  assert.throws(() => smokePlan({ dsh: fakeDsh(), workdir: path.join(sandbox, "no-such-workdir") }), /workdir 不存在/)
})

test("smokePlan：workdir 里没有已知文件时报错，不去猜 expect", () => {
  const workdir = dir("no-pkg")
  assert.throws(() => smokePlan({ dsh: fakeDsh(), workdir }), /package\.json/)
})

test("smokePlan：dsh 缺失时只给三步，不伪造 tool 步", () => {
  const workdir = pkgDir("no-dsh")
  assert.deepEqual(smokePlan({ dsh: null, workdir }).map((s) => s.id), ["bash", "read", "write"])
})

test("evaluate：退出码 0 且 stdout 含 expect 才算过", () => {
  const verdict = evaluate({ id: "bash", expect: SMOKE_MARK }, { status: 0, stdout: "noise\r\n" + SMOKE_MARK + "\r\n", stderr: "" })
  assert.equal(verdict.ok, true)
})

test("evaluate：非零退出码给出 code 和 stderr 首行", () => {
  const verdict = evaluate({ id: "read", expect: "x" }, { status: 2, stdout: "", stderr: "boom\nsecond line" })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /退出码 2/)
  assert.match(verdict.reason, /boom/)
  assert.ok(!verdict.reason.includes("second line"), "原因只取第一行，不糊一整段 stderr")
})

test("evaluate：超时优先于退出码，原因里带 timeout", () => {
  const verdict = evaluate({ id: "tool", expect: TOOL_MARK }, {
    status: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    error: { code: "ETIMEDOUT", message: "spawnSync cmd.exe ETIMEDOUT" },
    timedOut: true,
    timeoutMs: 20000,
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /超时/)
  assert.match(verdict.reason, /20000/)
})

test("evaluate：spawn 错误（命令不存在）单独给原因", () => {
  const verdict = evaluate({ id: "bash", expect: SMOKE_MARK }, { status: null, stdout: "", stderr: "", error: new Error("spawn bash ENOENT") })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /spawn 失败/)
  assert.match(verdict.reason, /ENOENT/)
})

test("evaluate：退出码 0 但 stdout 缺 expect / 完全没有 stdout 都判失败", () => {
  const missing = evaluate({ id: "read", expect: "smoke-fixture" }, { status: 0, stdout: "other" })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /没有 expect/)
  assert.match(missing.reason, /smoke-fixture/)
  const empty = evaluate({ id: "read", expect: "smoke-fixture" }, { status: 0 })
  assert.equal(empty.ok, false)
  assert.match(empty.reason, /stdout 为空/)
})

test("formatReport：全绿给 PASS n/n", () => {
  const text = formatReport([{ id: "bash", ok: true, ms: 12 }, { id: "read", ok: true, ms: 30 }])
  assert.match(text, /PASS 2\/2/)
  assert.ok(text.includes("bash"))
  assert.ok(text.includes("read"))
})

test("formatReport：任一失败给 FAIL 并带该步原因", () => {
  const text = formatReport([{ id: "bash", ok: true }, { id: "write", ok: false, reason: "退出码 1：EPERM" }])
  assert.match(text, /FAIL 1\/2/)
  assert.ok(text.includes("write"))
  assert.ok(text.includes("EPERM"))
})

test("计划里的 read / write / tool 真能跑：node 假命令下三步全绿且不留临时文件", () => {
  const workdir = pkgDir("integration")
  const steps = smokePlan({ dsh: fakeDsh(), workdir })
  const results = []
  for (const step of steps) {
    if (step.id === "bash") continue // bash 依赖开发机环境，留给 scripts/host-smoke.mjs 真跑
    const r = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: !!step.verbatim })
    results.push(Object.assign({ id: step.id }, evaluate(step, r)))
  }
  assert.deepEqual(results.map((r) => r.id), ["read", "write", "tool"])
  assert.ok(results.every((r) => r.ok), JSON.stringify(results))
  assert.ok(!fs.existsSync(path.join(workdir, ".dsh-smoke.tmp")), "write 步骤必须自己收尾")
})
