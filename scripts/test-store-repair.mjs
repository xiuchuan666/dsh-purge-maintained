import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  parsePurgeLock, isPurgeStoreKey, purgeKeyVersion, planStoreRepair,
  diagnoseStore, applyStoreRepair, listPurgeStoreKeys, staleTarballDirs,
  defaultStorePath, storeIndexPath,
} from "../lib/store-repair.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const LOCK = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      dsh-context:
        specifier: 0.87.1
        version: 0.87.1
      dsh-purge:
        specifier: file:../../plugins/dsh-purge-1.1.100.tgz
        version: file:../../plugins/dsh-purge-1.1.100.tgz
packages:
  dsh-purge@file:../../plugins/dsh-purge-1.1.100.tgz:
    resolution: {integrity: sha512-CURRENT==, tarball: file:../../plugins/dsh-purge-1.1.100.tgz}
    version: 1.1.100
`;
const CUR = "sha512-CURRENT==\tfile:../../plugins/dsh-purge-1.1.100.tgz";
const OLD97 = "sha512-OLD97==\tfile:../../plugins/dsh-purge-1.1.97.tgz";
const OLD83 = "sha512-OLD83==\tfile:../../plugins/dsh-purge-1.1.83.tgz";
const OTHER = "sha512-XYZ==\tfile:../../plugins/other-plugin-1.0.0.tgz";

function fixture(t, keys = [CUR, OLD97, OLD83, OTHER]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-store-repair-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = path.join(dir, "profile");
  fs.mkdirSync(path.join(profile, "node_modules", "dsh-purge"), { recursive: true });
  fs.writeFileSync(path.join(profile, "pnpm-lock.yaml"), LOCK);
  fs.writeFileSync(path.join(profile, "node_modules", "dsh-purge", "package.json"), JSON.stringify({ name: "dsh-purge", version: "1.1.100" }));
  const store = path.join(dir, "store");
  fs.mkdirSync(store, { recursive: true });
  const dbPath = storeIndexPath(store);
  const db = new DatabaseSync(dbPath);
  db.exec("create table package_index (key text primary key, data blob not null)");
  const ins = db.prepare("insert into package_index values (?, ?)");
  for (const key of keys) ins.run(key, Buffer.from("x"));
  db.close();
  return { dir, profile, store, dbPath };
}

test("parsePurgeLock 读出 specifier/version/integrity/packageVersion", () => {
  const cur = parsePurgeLock(LOCK);
  assert.equal(cur.found, true);
  assert.equal(cur.specifier, "file:../../plugins/dsh-purge-1.1.100.tgz");
  assert.equal(cur.integrity, "sha512-CURRENT==");
  assert.equal(cur.packageVersion, "1.1.100");
});

test("parsePurgeLock 空文本与缺失段落安全", () => {
  assert.equal(parsePurgeLock("").found, false);
  assert.equal(parsePurgeLock("importers:\n").packageVersion, "");
});

test("isPurgeStoreKey 只认 dsh-purge，不误伤其它插件", () => {
  assert.equal(isPurgeStoreKey(CUR), true);
  assert.equal(isPurgeStoreKey(OLD97), true);
  assert.equal(isPurgeStoreKey(OTHER), false);
  assert.equal(isPurgeStoreKey("sha512-A==\tfile:../dsh-purge-tools-1.0.0.tgz"), true);
});

test("purgeKeyVersion 从 key 里取版本", () => {
  assert.equal(purgeKeyVersion(OLD97), "1.1.97");
  assert.equal(purgeKeyVersion("dsh-purge@1.1.100"), "1.1.100");
});

test("planStoreRepair 保留当前 lockfile 条目，旧版本全部 stale", () => {
  const plan = planStoreRepair([CUR, OLD97, OLD83, OTHER], parsePurgeLock(LOCK));
  assert.deepEqual(plan.keep, [CUR]);
  assert.deepEqual(plan.stale, [OLD97, OLD83]);
});

test("planStoreRepair 没有 lockfile 时仍按 integrity 缺失判 stale，但不崩溃", () => {
  const plan = planStoreRepair([CUR, OLD97], { found: false });
  assert.equal(plan.stale.length, 2);
});

test("diagnoseStore 读取 installedVersion 与当前 lock", (t) => {
  const f = fixture(t);
  const d = diagnoseStore({ profileDir: f.profile, storeDir: f.store });
  assert.equal(d.installedVersion, "1.1.100");
  assert.equal(d.current.packageVersion, "1.1.100");
  assert.equal(d.plan.stale.length, 2);
  assert.equal(d.storeExists, true);
});

test("applyStoreRepair dry-run 不改库", (t) => {
  const f = fixture(t);
  const d = diagnoseStore({ profileDir: f.profile, storeDir: f.store });
  const r = applyStoreRepair(d, { dryRun: true });
  assert.equal(r.wouldRemove, 2);
  assert.equal(listPurgeStoreKeys(f.dbPath).keys.length, 3);
});

test("applyStoreRepair 删除旧条目、保留当前与其它包，并留备份", (t) => {
  const f = fixture(t);
  const d = diagnoseStore({ profileDir: f.profile, storeDir: f.store });
  const r = applyStoreRepair(d, {});
  assert.equal(r.removed, 2);
  assert.ok(fs.existsSync(r.backup));
  const left = listPurgeStoreKeys(f.dbPath).keys;
  assert.deepEqual(left, [CUR]);
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  assert.equal(db.prepare("select count(*) c from package_index").get().c, 2);
  db.close();
});

test("applyStoreRepair 幂等：第二次没有 stale", (t) => {
  const f = fixture(t);
  const d1 = diagnoseStore({ profileDir: f.profile, storeDir: f.store });
  applyStoreRepair(d1, {});
  const d2 = diagnoseStore({ profileDir: f.profile, storeDir: f.store });
  assert.equal(d2.plan.stale.length, 0);
  const r2 = applyStoreRepair(d2, {});
  assert.equal(r2.skipped, "nothing-stale");
});

test("store 不存在时 diagnose/apply 都安全跳过", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-store-none-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const d = diagnoseStore({ profileDir: dir, storeDir: path.join(dir, "nope") });
  assert.equal(d.storeExists, false);
  assert.equal(applyStoreRepair(d, {}).skipped, "store-missing");
});

test("staleTarballDirs 只列存在的 file: 指针目录", (t) => {
  const f = fixture(t);
  const dirName = "file+..+..+plugins+dsh-purge-1.1.97.tgz";
  fs.mkdirSync(path.join(f.store, dirName));
  const dirs = staleTarballDirs(f.store, [OLD97, OLD83]);
  assert.equal(dirs.length, 1);
  assert.ok(dirs[0].endsWith(dirName));
});

test("defaultStorePath / storeIndexPath 形状正确", () => {
  const p = defaultStorePath({ LOCALAPPDATA: "C:\\L" }, "win32");
  assert.ok(p.includes("pnpm"));
  assert.ok(storeIndexPath(p).endsWith("index.db"));
});
