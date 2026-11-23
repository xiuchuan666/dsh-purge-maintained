import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, PLAN_KINDS, findSevenZip, planUpdate, runUpdate } from "../lib/host-update.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || "host-update-"));
}
function tokensOf(plan) {
  return JSON.stringify(plan.map((step) => ({ command: step.command, args: step.args })));
}
function fakeExec(log, hooks) {
  return async (cmd, args, ctx) => {
    log.push({ cmd, args, cwd: ctx && ctx.cwd });
    const reply = hooks ? hooks(cmd, args, ctx) : null;
    return reply || { status: 0, stdout: "", stderr: "" };
  };
}

// ---------- 一、计划形状 ----------

test("planUpdate：五步固定顺序，每步都有 kind/command/args/why", () => {
  const dir = tmpDir();
  const work = path.join(dir, "work dir");
  const zip = path.join(dir, "7z.exe");
  const plan = planUpdate({ workdir: work, installdir: path.join(dir, "host"), sevenZip: zip });
  assert.deepEqual(plan.map((step) => step.kind), PLAN_KINDS);
  plan.forEach((step, index) => {
    assert.equal(step.index, index + 1);
    assert.equal(typeof step.command, "string");
    assert.ok(step.command.length > 0);
    assert.ok(Array.isArray(step.args) && step.args.length >= 2);
    assert.equal(typeof step.why, "string");
    assert.ok(step.why.length >= 8);
  });
  assert.equal(plan[0].args[0], "node");
  assert.match(plan[0].args[1], /host-watch\.mjs$/);
  assert.ok(plan[0].args.includes("--download"));
  assert.equal(plan[1].args[0], zip);
  assert.equal(plan[1].follow.length, 1);
  assert.ok(plan[1].follow[0].args[2].endsWith(path.join("$PLUGINSDIR", "app-64.7z")));
  assert.match(plan[2].command, /extract-asar\.mjs/);
  assert.match(plan[3].command, /host-rehearse\.mjs/);
  assert.match(plan[4].command, /host-install\.mjs/);
  assert.equal(plan.meta.workdir, work);
  assert.equal(plan.meta.app, path.join(work, "app"));
  assert.equal(plan.meta.asar, path.join(work, "asar"));
  assert.equal(plan.meta.dest, path.join(work, PACKAGE_NAME));
  assert.equal(plan.meta.apply, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("planUpdate：默认命令里没有 --apply；apply:true 时只有 install 段带 --apply/--stop", () => {
  const dir = tmpDir();
  const base = { workdir: path.join(dir, "w"), installdir: path.join(dir, "host"), sevenZip: path.join(dir, "7z.exe") };
  const dry = planUpdate(base);
  assert.equal(tokensOf(dry).includes("--apply"), false);

  const live = planUpdate(
    Object.assign({}, base, {
      apply: true,
      stop: true,
      resources: path.join(dir, "res"),
      exe: path.join(dir, "Harness.exe"),
    }),
  );
  assert.equal(live.meta.apply, true);
  assert.ok(live[4].args.includes("--apply"));
  assert.ok(live[4].args.includes("--stop"));
  assert.equal(live.filter((step) => step.args.includes("--apply")).length, 1);
  assert.equal(tokensOf(live.slice(0, 4)).includes("--apply"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("planUpdate：未给 --exe/--resources 用推断值并标记，带空格的路径在命令里被引号包住", () => {
  const dir = tmpDir();
  const work = path.join(dir, "a b");
  const host = path.join(dir, "Host Home");
  const plan = planUpdate({ workdir: work, installdir: host, sevenZip: path.join(dir, "7z.exe") });
  assert.equal(plan.meta.resourcesGiven, false);
  assert.equal(plan.meta.exeGiven, false);
  assert.equal(plan.meta.resources, path.join(host, "resources"));
  assert.equal(plan.meta.exe, path.join(host, "DeepSeek Harness.exe"));
  assert.ok(plan[0].command.includes("\"" + plan.meta.dest + "\""));
  assert.ok(plan[1].command.includes("\"" + "-o" + work + "\""));
  assert.ok(plan[4].command.includes("\"" + path.join(host, "resources") + "\""));
  for (const step of plan) {
    for (const arg of step.args) assert.equal(String(arg).startsWith("\""), false);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("planUpdate：没给 --workdir 时工作目录落在 host-watch 下，dest/app/asar 全在里面", () => {
  const home = tmpDir();
  const plan = planUpdate({ home: home, sevenZip: path.join(home, "7z.exe") });
  const wd = plan.meta.workdir;
  assert.ok(wd.startsWith(path.join(home, ".dsh", "dsh-purge", "host-watch")), wd);
  assert.equal(path.dirname(plan.meta.dest), wd);
  assert.equal(plan.meta.app, path.join(wd, "app"));
  assert.equal(plan.meta.asar, path.join(wd, "asar"));
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------- 二、apply 预检 ----------

test("runUpdate：--apply 缺 --exe / --resources 直接拒，且一个目录都不建", async () => {
  const dir = tmpDir();
  const work = path.join(dir, "w");
  const zip = path.join(dir, "7z.exe");
  const bare = planUpdate({ workdir: work, installdir: path.join(dir, "host"), sevenZip: zip });
  await assert.rejects(() => runUpdate(bare, { apply: true }), /--exe.*--resources/);

  const onlyRes = planUpdate({
    workdir: work,
    installdir: path.join(dir, "host"),
    sevenZip: zip,
    resources: path.join(dir, "res"),
  });
  await assert.rejects(() => runUpdate(onlyRes, { apply: true }), /--exe/);

  const onlyExe = planUpdate({
    workdir: work,
    installdir: path.join(dir, "host"),
    sevenZip: zip,
    exe: path.join(dir, "Harness.exe"),
  });
  await assert.rejects(() => runUpdate(onlyExe, { apply: true }), /--resources/);

  const both = planUpdate({
    workdir: work,
    installdir: path.join(dir, "host"),
    sevenZip: zip,
    resources: path.join(dir, "res"),
    exe: path.join(dir, "Harness.exe"),
  });
  await assert.rejects(() => runUpdate(both, { apply: true }), /resources 不存在/);
  assert.equal(fs.existsSync(work), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 三、dry-run 执行 ----------

test("runUpdate dry-run：假文件树只解包，asar/预演/安装只打印命令，resources 不动", async () => {
  const dir = tmpDir();
  const work = path.join(dir, "work");
  fs.mkdirSync(work, { recursive: true });
  const dest = path.join(work, PACKAGE_NAME);
  fs.writeFileSync(dest, "fake-package", "utf8");
  const resources = path.join(dir, "res");
  fs.mkdirSync(path.join(resources, "app"), { recursive: true });
  fs.writeFileSync(path.join(resources, "app", "sentinel.txt"), "keep", "utf8");
  const hostExe = path.join(dir, "DeepSeek Harness.exe");
  fs.writeFileSync(hostExe, "not-a-real-host", "utf8");

  const plan = planUpdate({
    workdir: work,
    installdir: path.join(dir, "host"),
    resources: resources,
    exe: hostExe,
    sevenZip: path.join(dir, "7z.exe"),
  });
  const calls = [];
  const events = [];
  const result = await runUpdate(plan, {
    apply: false,
    onStep: (event) => events.push(event.action + ":" + event.step.kind),
    exec: fakeExec(calls),
  });

  assert.deepEqual(result.executed.map((entry) => entry.kind), ["extract"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, path.join(dir, "7z.exe"));
  assert.ok(calls[0].args.includes(dest));
  assert.ok(calls[0].args.includes("-o" + work));
  assert.ok(calls[1].args.includes("-o" + path.join(work, "app")));
  assert.deepEqual(result.skipped.map((entry) => entry.kind), ["download", "asar", "rehearse", "install"]);
  assert.match(result.skipped[0].reason, /已存在/);
  const nextText = result.next.map((entry) => entry.command).join("\n");
  assert.match(nextText, /extract-asar\.mjs/);
  assert.match(nextText, /host-rehearse\.mjs/);
  assert.match(nextText, /host-install\.mjs/);
  assert.equal(nextText.includes("--apply"), false);
  assert.deepEqual(events, ["skip:download", "run:extract", "skip:asar", "skip:rehearse", "skip:install"]);
  assert.equal(fs.readFileSync(path.join(resources, "app", "sentinel.txt"), "utf8"), "keep");
  assert.deepEqual(fs.readdirSync(resources), ["app"]);
  assert.equal(fs.existsSync(path.join(work, "app")), false);
  assert.match(result.applyHint, /--apply/);
  assert.equal(result.dryRun, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runUpdate dry-run：dest 不存在时先跑 host-watch --download（注入 exec，不联网）", async () => {
  const dir = tmpDir();
  const work = path.join(dir, "w");
  const plan = planUpdate({ workdir: work, installdir: path.join(dir, "host"), sevenZip: path.join(dir, "7z.exe") });
  const calls = [];
  const result = await runUpdate(plan, {
    exec: fakeExec(calls, (cmd, args) => {
      if (args.includes("--download")) {
        fs.mkdirSync(path.dirname(plan.meta.dest), { recursive: true });
        fs.writeFileSync(plan.meta.dest, "x", "utf8");
        return { status: 0, stdout: "downloaded", stderr: "" };
      }
      return null;
    }),
  });
  assert.equal(result.executed[0].kind, "download");
  assert.equal(calls.length, 3);
  const download = calls[0].args;
  assert.ok(download.includes("--download"));
  assert.ok(download.includes("--dest"));
  assert.ok(download.includes(plan.meta.dest));
  assert.ok(download.includes("--state"));
  assert.equal(calls[0].cmd, "node");
  assert.equal(result.executed[0].stdout, "downloaded");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 四、7z 探测与缺 7z ----------

test("findSevenZip：候选目录与 PATH 都能命中，全缺时给明确理由", () => {
  const missing = findSevenZip({ candidates: [], pathEntries: ["C:\\nope"], exists: () => false, env: {} });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /7-Zip/);
  assert.match(missing.reason, /--sevenzip/);
  assert.ok(missing.tried.length > 0);

  const dirs = ["C:\\Program Files\\7-Zip"];
  const hit = findSevenZip({
    candidates: dirs,
    pathEntries: [],
    exists: (target) => target === path.join(dirs[0], "7z.exe"),
  });
  assert.equal(hit.ok, true);
  assert.equal(hit.path, path.join(dirs[0], "7z.exe"));

  const viaPath = findSevenZip({
    candidates: [],
    pathEntries: ["C:\\tools\\zip"],
    exists: (target) => target.toLowerCase() === path.join("C:\\tools\\zip", "7za.exe").toLowerCase(),
  });
  assert.equal(viaPath.ok, true);
  assert.match(viaPath.path, /7za\.exe$/);
});

test("runUpdate：探不到 7z 时明确报错，一条命令都不执行", async () => {
  const dir = tmpDir();
  const work = path.join(dir, "w");
  const plan = planUpdate({ workdir: work, installdir: path.join(dir, "host"), candidates: [], env: {}, pathEntries: [] });
  assert.equal(plan.meta.sevenZip, "");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(plan.meta.dest, "fake-package", "utf8");
  const calls = [];
  await assert.rejects(() => runUpdate(plan, { exec: fakeExec(calls) }), /7z/);
  assert.equal(calls.length, 0);
  assert.equal(plan[1].args[0], "7z");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 五、CLI ----------

test("CLI --plan --json 离线：五步齐全、命令不含 --apply、一个目录都不建", () => {
  const dir = tmpDir();
  const work = path.join(dir, "w");
  const run = spawnSync(
    process.execPath,
    ["scripts/host-update.mjs", "--plan", "--json", "--workdir", work, "--installdir", path.join(dir, "host")],
    { cwd: REPO, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "plan");
  assert.equal(payload.steps.length, 5);
  assert.deepEqual(payload.steps.map((step) => step.kind), PLAN_KINDS);
  assert.equal(tokensOf(payload.steps).includes("--apply"), false);
  assert.equal(fs.existsSync(work), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI --apply 缺 --exe/--resources：退出码 2，不落盘", () => {
  const dir = tmpDir();
  const work = path.join(dir, "w");
  const run = spawnSync(
    process.execPath,
    ["scripts/host-update.mjs", "--apply", "--json", "--workdir", work, "--installdir", path.join(dir, "host")],
    { cwd: REPO, encoding: "utf8" },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--exe/);
  assert.equal(fs.existsSync(work), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("planUpdate：scripts/*.mjs 一律绝对路径，workdir 已存在也不会被 cwd 带偏", async () => {
  const dir = tmpDir();
  const work = path.join(dir, "existing-work");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, PACKAGE_NAME), "fake-package", "utf8");
  const plan = planUpdate({ workdir: work, installdir: path.join(dir, "host"), sevenZip: path.join(dir, "7z.exe") });

  const planned = [];
  for (const step of plan) {
    for (const arg of step.args) if (String(arg).endsWith(".mjs")) planned.push(String(arg));
    for (const extra of step.follow || []) {
      for (const arg of extra.args) if (String(arg).endsWith(".mjs")) planned.push(String(arg));
    }
  }
  assert.equal(planned.length, 5);
  for (const arg of planned) {
    assert.equal(path.isAbsolute(arg), true, arg);
    assert.equal(fs.existsSync(arg), true, arg);
    assert.ok(arg.startsWith(path.join(REPO, "scripts")), arg);
  }

  const calls = [];
  const result = await runUpdate(plan, { exec: fakeExec(calls) });
  assert.equal(result.executed[0].kind, "extract");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((entry) => entry.cwd === work));

  // 真实 node 在这个已有 workdir 里仍能解析到每个脚本（--check 不执行、不联网）
  for (const arg of planned) {
    const probe = spawnSync(process.execPath, ["--check", arg], { cwd: work, encoding: "utf8" });
    assert.equal(probe.status, 0, arg + "\n" + probe.stderr);
  }
  const help = spawnSync(process.execPath, [path.join(REPO, "scripts", "host-watch.mjs"), "--help"], {
    cwd: work,
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});
