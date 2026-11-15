// lib/drill-grant.js：演练台授权（$DSH_HOME/dsh-purge/drill-grant.json）的读写与清理。
//
// 这份文件是「用户已确认演练台可写」的唯一凭据，三种坏法全都静默：
//   - 读到坏 JSON 就抛 → 设置页整块打不开，用户以为插件坏了；
//   - 写入时旧文件删不掉却报成功 → 授权没落盘，下次又弹一次确认；
//   - 清授权时删错范围 → 把用户别的数据一起删了。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { drillGrantPath, readDrillGrant, writeDrillGrant, clearDrillGrant } from "../lib/drill-grant.js";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-drill-grant-"));
test.after(() => {
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* Windows 偶发 EPERM，交给系统清理临时目录 */
  }
});

let seq = 0;
function home(tag = "h") {
  seq += 1;
  const dir = path.join(SANDBOX, `${tag}-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("授权路径固定在 $DSH_HOME/dsh-purge/drill-grant.json（不进包目录、不进共享目录）", () => {
  const h = path.join(os.tmpdir(), "fake-home");
  assert.equal(drillGrantPath(h), path.join(h, "dsh-purge", "drill-grant.json"));
});

test("没写过授权就是未授权，且读的时候不建目录", () => {
  const h = home("fresh");
  const r = readDrillGrant(h);
  assert.equal(r.granted, false);
  assert.equal(r.path, drillGrantPath(h));
  assert.equal(fs.existsSync(path.join(h, "dsh-purge")), false);
});

test("写入后能读回 granted=true，at 是 ISO 时间戳", () => {
  const h = home("write");
  const w = writeDrillGrant(h);
  assert.equal(w.granted, true);
  assert.match(String(w.at), /^\d{4}-\d{2}-\d{2}T/);
  const raw = JSON.parse(fs.readFileSync(drillGrantPath(h), "utf8"));
  assert.equal(raw.granted, true);
  assert.equal(typeof raw.at, "string");
  assert.equal(readDrillGrant(h).granted, true);
});

test("granted 只认严格的 true：字符串 true / 1 / 缺字段都不算授权", () => {
  const h = home("strict");
  fs.mkdirSync(path.join(h, "dsh-purge"), { recursive: true });
  for (const bad of ['{"granted":"true"}', '{"granted":1}', "{}", "null"]) {
    fs.writeFileSync(drillGrantPath(h), bad);
    assert.equal(readDrillGrant(h).granted, false, bad);
  }
});

test("授权文件坏成非 JSON 时按未授权处理，不抛错（设置页还能打开）", () => {
  const h = home("corrupt");
  fs.mkdirSync(path.join(h, "dsh-purge"), { recursive: true });
  fs.writeFileSync(drillGrantPath(h), "{ granted: true ");
  const r = readDrillGrant(h);
  assert.equal(r.granted, false);
  assert.equal(r.path, drillGrantPath(h));
});

test("旧授权删不掉时必须抛错，且不留 .tmp 残骸", () => {
  const h = home("blocked");
  // 目标位置被目录占着：unlinkSync 必失败，写入流程要走 catch
  fs.mkdirSync(drillGrantPath(h), { recursive: true });
  assert.throws(() => writeDrillGrant(h), (e) => Boolean(e) && typeof e.code === "string");
  const left = fs.readdirSync(path.join(h, "dsh-purge")).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(left, []);
  assert.equal(readDrillGrant(h).granted, false);
});

test("clearDrillGrant 只删自己那份授权，没授权时返回 false", () => {
  const h = home("clear");
  assert.equal(clearDrillGrant(h), false);
  writeDrillGrant(h);
  const keep = path.join(h, "dsh-purge", "keep.txt");
  fs.writeFileSync(keep, "x");
  assert.equal(clearDrillGrant(h), true);
  assert.equal(fs.existsSync(drillGrantPath(h)), false);
  assert.equal(fs.existsSync(keep), true);
});
