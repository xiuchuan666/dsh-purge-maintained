import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  beginInstall, pendingJournal, finishInstall, failInstall, loadJournal,
  journalPath, recordStep, rollbackPlan, summarizeJournal,
} from "../lib/host-install-journal.js";
import { installPlan, treeBytes, checkSpace, resolveExe } from "../lib/host-install.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-hostinstall-"));
}

test("journal：begin 落盘、pending 可查、finish 收尾", () => {
  const home = tmp();
  const j = beginInstall(home, { tree: "T", resources: "R", exe: "E.exe", previous: "P", asarBackup: null });
  assert.equal(j.state, "pending");
  assert.ok(fs.existsSync(journalPath(home)));
  assert.equal(pendingJournal(home).tree, "T");
  recordStep(home, "copy-tree", true, "ok");
  assert.equal(loadJournal(home).steps.length, 1);
  finishInstall(home);
  assert.equal(loadJournal(home).state, "done");
  assert.equal(pendingJournal(home), null);
});

test("journal：未收尾的安装拒绝第二次 begin，--force 才放行", () => {
  const home = tmp();
  beginInstall(home, { tree: "A" });
  assert.throws(() => beginInstall(home, { tree: "B" }), (error) => error.code === "PENDING_INSTALL");
  const forced = beginInstall(home, { tree: "B", force: true });
  assert.equal(forced.tree, "B");
  assert.equal(forced.steps.length, 0);
});

test("journal：失败回滚保留原因与 rolled-back 状态", () => {
  const home = tmp();
  beginInstall(home, { tree: "A", previous: "P" });
  const j = failInstall(home, { rolledBack: true, error: "probe 失败" });
  assert.equal(j.state, "rolled-back");
  assert.match(j.error, /probe/);
  assert.match(summarizeJournal(j), /rolled-back/);
});

test("journal：rollbackPlan 没有 previous 时拒绝，有则给出四步", () => {
  assert.equal(rollbackPlan(null).ok, false);
  assert.equal(rollbackPlan({ previous: null }).ok, false);
  const plan = rollbackPlan({ resources: "R", previous: "R/app.prev-x", asarBackup: "R/app.asar.bak-x", exe: "E.exe" });
  assert.equal(plan.ok, true);
  assert.equal(plan.steps.length, 5);
  assert.match(plan.steps.join(" "), /app\.prev-x/);
});

test("installPlan：缺树/缺 app/缺 exe 全部拒绝", () => {
  const root = tmp();
  const plan = installPlan({ resources: path.join(root, "resources"), tree: path.join(root, "tree"), exe: path.join(root, "nope.exe") });
  assert.equal(plan.ok, false);
  assert.equal(plan.errors.length, 4);
});

test("installPlan：目录齐了才给出八步，exe 默认为安装目录同级", () => {
  const root = tmp();
  const resources = path.join(root, "resources");
  const tree = path.join(root, "tree");
  fs.mkdirSync(path.join(resources, "app"), { recursive: true });
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(root, "DeepSeek Harness.exe"), "");
  const plan = installPlan({ resources, tree });
  assert.equal(plan.ok, true, plan.errors.join(";"));
  assert.equal(plan.steps.length, 8);
  assert.equal(plan.exe, resolveExe(resources, null));
  assert.ok(fs.existsSync(plan.exe));
});

test("treeBytes 递归累加文件字节", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "d"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a.txt"), "12345");
  fs.writeFileSync(path.join(dir, "d", "b.txt"), "123");
  assert.equal(treeBytes(dir), 8);
});

test("checkSpace：需求超过余量时拒绝，读不到余量时跳过", () => {
  const dir = tmp();
  assert.equal(checkSpace(dir, 1024).ok, true);
  const huge = checkSpace(dir, Number.MAX_SAFE_INTEGER);
  assert.equal(huge.ok, false);
  assert.ok(huge.need > 0);
});
