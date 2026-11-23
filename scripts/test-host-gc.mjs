// lib/host-gc.js + scripts/host-gc.mjs：备份代际扫描、清理计划、删除边界。
//
// 为什么这些用例值得钉：GC 是唯一会真删用户文件的路径。三条底线 —— 分类不能串
// （app.asar.dshpurge.bak 是清洗前原件，不是官方包备份）、代际不能乱（坏时间戳
// 必须沉到最旧代，否则会被当成最新保留）、删除不能越界（root 之外一律拒绝）。
// 全部用例只碰 os.tmpdir 下的假树，不联网、不碰 ~/.dsh、不读真实 resources。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyBackupName,
  formatBytes,
  isInsideRoot,
  parseStamp,
  planGc,
  scanBackups,
  summarize,
} from "../lib/host-gc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CLI = path.join(ROOT, "scripts", "host-gc.mjs");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-gc-"));

test.after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

let seq = 0;
function tree(name) {
  seq += 1;
  const dir = path.join(SANDBOX, name + "-" + seq);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function touch(dir, rel, bytes, mtime) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(bytes || 16, 0x41));
  if (mtime) fs.utimesSync(target, mtime, mtime);
  return target;
}
function mkdir(dir, rel) {
  const target = path.join(dir, rel);
  fs.mkdirSync(target, { recursive: true });
  return target;
}
function run(args) {
  return spawnSync(process.execPath, [CLI].concat(args), { encoding: "utf8", cwd: ROOT, timeout: 60000 });
}

test("三类识别：sidecar / app.prev / app.asar 备份分桶，app.asar.dshpurge.bak 不算官方包备份", () => {
  const dir = tree("classify");
  touch(dir, "resources/app/app.asar.dshpurge.bak", 32);
  touch(dir, "resources/app/index.js.dshpurge.bak", 8);
  touch(dir, "resources/app.asar.bak", 64);
  touch(dir, "resources/app.asar.20240201.bak", 64);
  mkdir(dir, "resources/app.prev-20240101T101010");
  touch(dir, "resources/app.prev-20240101T101010/app.asar", 40);
  fs.writeFileSync(path.join(dir, "resources/readme.txt"), "x");

  const scan = scanBackups(dir);
  assert.equal(scan.sidecar.length, 2);
  assert.equal(scan.appPrev.length, 1);
  assert.equal(scan.asarBak.length, 2);
  assert.equal(scan.total, 5);
  assert.deepEqual(
    scan.sidecar.map((entry) => entry.name).sort(),
    ["app.asar.dshpurge.bak", "index.js.dshpurge.bak"],
  );
  assert.equal(classifyBackupName("app.asar.dshpurge.bak"), "sidecar");
  assert.equal(classifyBackupName("app.asar.bak"), "asarBak");
  assert.equal(classifyBackupName("app.asar.bak.1"), "asarBak");
  assert.equal(classifyBackupName("app.prev-20240101T101010"), "appPrev");
  assert.equal(classifyBackupName("readme.txt"), null);
  assert.equal(scan.appPrev[0].bytes, 40);
  assert.equal(scan.sidecar[0].kind, "sidecar");
});

test("按代际排序：8 位日期、12 位、14 位时间戳混排，最新在 gen 0", () => {
  const dir = tree("order");
  for (const stamp of ["20231201", "20240101T101010", "20240201", "20231101"]) {
    mkdir(dir, "app.prev-" + stamp);
  }
  const scan = scanBackups(dir);
  assert.deepEqual(
    scan.appPrev.map((entry) => entry.name),
    ["app.prev-20240201", "app.prev-20240101T101010", "app.prev-20231201", "app.prev-20231101"],
  );
  assert.deepEqual(scan.appPrev.map((entry) => entry.gen), [0, 1, 2, 3]);
  assert.ok(scan.appPrev[0].ts > scan.appPrev[1].ts);
});

test("keep=2：每类保留最新两代，remove 逐条写明被哪一代压过", () => {
  const dir = tree("keep2");
  for (const stamp of ["20231101", "20231201", "20240101", "20240201"]) {
    mkdir(dir, "app.prev-" + stamp);
  }
  const scan = scanBackups(dir);
  const plan = planGc(scan, { keep: 2 });
  assert.equal(plan.keep.length, 2);
  assert.equal(plan.remove.length, 2);
  assert.deepEqual(plan.keep.map((entry) => entry.name), ["app.prev-20240201", "app.prev-20240101"]);
  assert.deepEqual(plan.remove.map((entry) => entry.name), ["app.prev-20231201", "app.prev-20231101"]);
  for (const entry of plan.remove) {
    const why = plan.reasons[entry.absPath];
    assert.equal(why.action, "remove");
    assert.equal(why.newer, plan.keep[0].absPath);
    assert.match(why.reason, /older generation than/);
  }
  assert.equal(plan.classes.appPrev.total, 4);
  assert.equal(plan.classes.appPrev.remove, 2);
});

test("唯一备份不删：单条三类在 keep=1/2/9 下都不进 remove，空树也不炸", () => {
  const dir = tree("only");
  touch(dir, "app.asar.dshpurge.bak", 24);
  touch(dir, "app.asar.bak", 32);
  mkdir(dir, "app.prev-20240101");
  const scan = scanBackups(dir);
  for (const keep of [1, 2, 9]) {
    const plan = planGc(scan, { keep });
    assert.equal(plan.remove.length, 0, "keep=" + keep);
    assert.equal(plan.keep.length, 3);
  }
  const empty = tree("empty");
  const emptyPlan = planGc(scanBackups(empty), { keep: 2 });
  assert.equal(emptyPlan.remove.length, 0);
  assert.equal(emptyPlan.keep.length, 0);
  assert.equal(summarize(emptyPlan).removeCount, 0);
});

test("root 外路径拒绝：isInsideRoot 只认 root 的后代，root 自己和 .. 都不算", () => {
  const dir = tree("bounds");
  assert.equal(isInsideRoot(dir, path.join(dir, "sub", "app.asar.bak")), true);
  assert.equal(isInsideRoot(dir, dir), false);
  assert.equal(isInsideRoot(dir, path.resolve(dir, "..", "escape.bak")), false);
  assert.equal(isInsideRoot(dir, path.resolve(dir, "..", "..", "x")), false);
  if (process.platform === "win32") {
    assert.equal(isInsideRoot("C:/one", "D:/two/x"), false);
  }
});

test("simulate apply：dry-run 不动盘，--apply 只删 plan.remove，再跑一次不误删", () => {
  const dir = tree("apply");
  const oldest = touch(dir, "app.asar.20231101.bak", 10);
  const middle = touch(dir, "app.asar.20231201.bak", 20);
  const newest = touch(dir, "app.asar.20240201.bak", 30);
  const plan = planGc(scanBackups(dir), { keep: 1 });
  assert.equal(plan.remove.length, 2);

  const dry = run(["--root", dir, "--keep", "1", "--json"]);
  assert.equal(dry.status, 0, dry.stderr);
  const dryReport = JSON.parse(dry.stdout);
  assert.equal(dryReport.mode, "dry-run");
  assert.equal(dryReport.summary.removeCount, 2);
  assert.deepEqual(dryReport.removed, []);
  assert.ok(fs.existsSync(oldest) && fs.existsSync(middle) && fs.existsSync(newest));

  const applied = run(["--root", dir, "--keep", "1", "--apply", "--json"]);
  assert.equal(applied.status, 0, applied.stderr);
  const report = JSON.parse(applied.stdout);
  assert.equal(report.mode, "apply");
  assert.equal(report.removed.length, 2);
  assert.deepEqual(report.removed.map((item) => item.path).sort(), [oldest, middle].sort());
  assert.equal(fs.existsSync(oldest), false);
  assert.equal(fs.existsSync(middle), false);
  assert.equal(fs.existsSync(newest), true);

  const again = run(["--root", dir, "--keep", "1", "--apply", "--json"]);
  assert.equal(again.status, 0);
  assert.equal(JSON.parse(again.stdout).removed.length, 0);
  assert.ok(fs.existsSync(newest));
});

test("summarize：释放字节按 remove 累加，按类拆分，结构性备份给中风险", () => {
  const dir = tree("bytes");
  mkdir(dir, "app.prev-20231101");
  mkdir(dir, "app.prev-20240101");
  fs.writeFileSync(path.join(dir, "app.prev-20231101", "a.bin"), Buffer.alloc(1000));
  fs.writeFileSync(path.join(dir, "app.prev-20231101", "b.bin"), Buffer.alloc(24));
  fs.writeFileSync(path.join(dir, "app.prev-20240101", "c.bin"), Buffer.alloc(7));
  touch(dir, "app.asar.dshpurge.bak", 128);
  touch(dir, "app.asar.20230101.bak", 256);
  touch(dir, "app.asar.20240101.bak", 512);

  const plan = planGc(scanBackups(dir), { keep: 1 });
  const summary = summarize(plan);
  assert.equal(summary.removeCount, 2);
  assert.equal(summary.keepCount, 3);
  assert.equal(summary.freedBytes, 1024 + 256);
  assert.equal(summary.byKind.appPrev.freedBytes, 1024);
  assert.equal(summary.byKind.asarBak.freedBytes, 256);
  assert.equal(summary.byKind.sidecar.remove, 0);
  assert.equal(summary.freedHuman, formatBytes(1280));
  assert.equal(summary.level, "medium");
  assert.ok(summary.risks.some((risk) => risk.includes("app.prev")));
});

test("坏时间戳归到最旧代：解析失败的排在 gen 末位并被优先清理", () => {
  const dir = tree("badstamp");
  for (const stamp of ["20240101", "20240201", "garbage-token", "20241399"]) {
    mkdir(dir, "app.prev-" + stamp);
  }
  const scan = scanBackups(dir);
  assert.deepEqual(
    scan.appPrev.map((entry) => entry.name).sort(),
    ["app.prev-20240101", "app.prev-20240201", "app.prev-20241399", "app.prev-garbage-token"].sort(),
  );
  assert.equal(scan.appPrev[0].name, "app.prev-20240201");
  assert.equal(scan.appPrev[1].name, "app.prev-20240101");
  const bad = scan.appPrev.filter((entry) => !Number.isFinite(entry.ts));
  assert.equal(bad.length, 2);
  assert.deepEqual(bad.map((entry) => entry.gen).sort(), [2, 3]);
  assert.equal(scan.appPrev.find((entry) => entry.name === "app.prev-garbage-token").tsSource, "none");

  const plan = planGc(scan, { keep: 2 });
  assert.equal(plan.remove.length, 2);
  assert.deepEqual(plan.remove.map((entry) => entry.name).sort(), ["app.prev-20241399", "app.prev-garbage-token"]);
  const summary = summarize(plan);
  assert.ok(summary.risks.some((risk) => risk.includes("时间戳")));
});

test("CLI 守卫：缺 --root / 根不存在 / ~/.dsh 一律 exit 2，且 --json 仍给可解析错误", () => {
  const missing = run([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--root is required/);

  const ghost = path.join(SANDBOX, "nope-does-not-exist");
  const notDir = run(["--root", ghost, "--json"]);
  assert.equal(notDir.status, 2);
  const payload = JSON.parse(notDir.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /not a directory/);

  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const dsh = run(["--root", path.join(home, ".dsh"), "--json"]);
  assert.equal(dsh.status, 2);

  const badKeep = run(["--root", ghost, "--keep", "0"]);
  assert.equal(badKeep.status, 2);
});

test("parseStamp / planGc 入参：epoch 与紧凑日期都能解析，keep<1 直接抛错", () => {
  assert.equal(parseStamp("20240201"), Date.UTC(2024, 1, 1));
  assert.equal(parseStamp("2024-02-01"), Date.UTC(2024, 1, 1));
  assert.equal(parseStamp("1699999999"), 1699999999000);
  // 10 位歧义收口：日期+小时优先，日期非法才回落 epoch 秒
  assert.equal(parseStamp("2024010110"), Date.UTC(2024, 0, 1, 10));
  assert.equal(parseStamp("1750000000"), 1750000000000);
  assert.equal(parseStamp("app.prev-20240101T101010"), Date.UTC(2024, 0, 1, 10, 10, 10));
  assert.equal(parseStamp("garbage-token"), null);

  const scan = scanBackups(tree("guard"));
  assert.throws(() => planGc(scan, { keep: 0 }), /keep must be an integer >= 1/);
  assert.throws(() => planGc(scan, { keep: 1.5 }), /keep must be an integer >= 1/);
  assert.throws(() => scanBackups(""), /root is required/);
});
