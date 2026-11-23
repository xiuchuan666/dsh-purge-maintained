import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readInstallTruth } from "../lib/core.js";

const CORE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "core.js");
const JOURNAL_REL = path.join("dsh-purge", "host-install-journal.json");

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function writeJson(file, data) {
  return writeFile(file, JSON.stringify(data, null, 2) + "\n");
}

/** 一棵"能跑"的资源树：宿主版本、asar、配对 unpacked、require_builtin 原生包。 */
function makeResources(root, options) {
  const opts = options || {};
  const resources = path.join(root, "resources");
  const app = path.join(resources, "app");
  fs.mkdirSync(resources, { recursive: true });
  if (opts.noApp) return resources;
  writeJson(path.join(app, "dsh", "package.json"), { name: "dsh", version: opts.dshVersion || "1.2.3" });
  writeJson(path.join(app, "package.json"), { name: "dsh-desktop", version: opts.desktopVersion || "2.0.0" });
  writeFile(path.join(resources, "app.asar"), "stub-asar");
  writeFile(path.join(app, "dsh", "native", "x.node"), "native-x");
  writeFile(path.join(resources, "app.asar.unpacked", "dsh", "native", "x.node"), "native-x");
  if (opts.extraUnpacked) writeFile(path.join(resources, "app.asar.unpacked", "dsh", "native", "extra.node"), "native-extra");
  if (!opts.noAddon) {
    writeFile(
      path.join(app, "dsh", "node_modules", "node-addon-require-builtin-win32-x64-msvc-napi-v9", "win32.node"),
      "addon",
    );
  }
  return resources;
}

/** 宿主 home：profiles/<name>/node_modules/dsh-purge + 可选 journal。 */
function makeHome(root, options) {
  const opts = options || {};
  const home = path.join(root, "home");
  const profileDir = path.join(home, "profiles", opts.profile || "desktop");
  fs.mkdirSync(profileDir, { recursive: true });
  if (opts.installed !== false) {
    const plugin = path.join(profileDir, "node_modules", "dsh-purge");
    writeJson(path.join(plugin, "package.json"), { name: "dsh-purge", version: opts.pluginVersion || "1.1.100" });
    if (opts.slot !== null) {
      writeFile(path.join(plugin, "lib", "asset-table.js"), opts.slot || 'const SLOT_ROWS = ["abc", "defgh"];\n');
    }
  }
  if (opts.journal) {
    const body = typeof opts.journal === "string" ? opts.journal : JSON.stringify(opts.journal, null, 2) + "\n";
    writeFile(path.join(home, JOURNAL_REL), body);
  }
  return home;
}

function doneJournal(version) {
  return {
    version: 1,
    state: "done",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    tree: null,
    resources: null,
    exe: null,
    previous: { version: "1.1.99", spec: "1.1.99", tgz: null },
    asarBackup: null,
    steps: [
      { name: "backup", ok: true, note: "" },
      { name: "extract", ok: true, note: "" },
      { name: "health", ok: true, note: "版本 " + version },
    ],
    error: null,
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-status-truth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root: root,
    resources: (opts) => makeResources(root, opts),
    home: (opts) => makeHome(root, opts),
  };
}

test("正常安装：宿主版本、unpacked 完整性、SLOT、profile 版本、journal 全部落地", (t) => {
  const f = fixture(t);
  const resources = f.resources({});
  const home = f.home({ journal: doneJournal("1.1.100") });
  const truth = readInstallTruth({ dshHome: home, resourcesDir: resources });

  assert.equal(truth.hostVersion, "1.2.3");
  assert.deepEqual(truth.hostIntegrity, {
    ok: true,
    unpackedMissing: [],
    unpackedMissingCount: 0,
    unpackedChecked: true,
    requireBuiltin: ["dsh/node_modules/node-addon-require-builtin-win32-x64-msvc-napi-v9/win32.node"],
    requireBuiltinCount: 1,
    nativeCount: 2,
    problems: [],
    reason: "",
  });
  assert.equal(truth.profileVersion, "1.1.100");
  assert.equal(truth.slotLength, 8);
  assert.equal(typeof truth.openSlotLength, "number");
  assert.ok(truth.openSlotLength > 1000, "内存槽应有内容，实际 " + truth.openSlotLength);
  assert.deepEqual(truth.lastInstall, {
    state: "done",
    version: "1.1.100",
    at: "2026-01-01T00:01:00.000Z",
    previousVersion: "1.1.99",
    kind: "profile",
    note: "",
  });
  assert.equal(truth.installTruth.reason, "");
  assert.equal(truth.installTruth.profile, "desktop");
  assert.equal(truth.installTruth.resources, resources);
  assert.equal(truth.installTruth.profileDir, path.join(home, "profiles", "desktop"));
  assert.equal(truth.installTruth.pluginDir, path.join(home, "profiles", "desktop", "node_modules", "dsh-purge"));
  assert.equal(truth.installTruth.journalPath, path.join(home, JOURNAL_REL));

  // 两次读到的形状必须一致（没有共享可变状态）
  assert.deepEqual(readInstallTruth({ dshHome: home, resourcesDir: resources }), truth);
});

test("宿主 app 目录不存在：hostIntegrity.ok=false 且给出问题，不抛", (t) => {
  const f = fixture(t);
  const resources = f.resources({ noApp: true });
  const truth = readInstallTruth({ dshHome: f.home({}), resourcesDir: resources });

  assert.equal(truth.hostVersion, null);
  assert.equal(truth.hostIntegrity.ok, false);
  assert.equal(truth.hostIntegrity.unpackedChecked, false);
  assert.equal(truth.hostIntegrity.nativeCount, 0);
  assert.deepEqual(truth.hostIntegrity.requireBuiltin, []);
  assert.deepEqual(truth.hostIntegrity.problems, ["app 目录不存在"]);
  assert.match(truth.installTruth.reasons.hostVersion, /读不到宿主 package\.json 的 version/);
  assert.equal(truth.installTruth.resources, resources);
});

test("完全没有安装：字段全 null、原因写入 installTruth.reasons、不抛", (t) => {
  const f = fixture(t);
  const truth = readInstallTruth({
    dshHome: path.join(f.root, "no-home"),
    resourcesDir: path.join(f.root, "no-resources"),
  });

  assert.equal(truth.hostVersion, null);
  assert.equal(truth.hostIntegrity, null);
  assert.equal(truth.lastInstall, null);
  assert.equal(truth.profileVersion, null);
  assert.equal(truth.slotLength, null);
  assert.equal(truth.installTruth.resources, "");
  assert.match(truth.installTruth.reasons.host, /未定位宿主 resources/);
  assert.match(truth.installTruth.reasons.profile, /找不到宿主 profile/);
  assert.match(truth.installTruth.reasons.lastInstall, /没有安装 journal/);
  assert.ok(truth.installTruth.reason.length > 0);

  // DSH_HOME 也没有时，profile 与 journal 都按"未定位"报，不抛
  const noHome = readInstallTruth({ dshHome: "", resourcesDir: "" });
  assert.match(noHome.installTruth.reasons.profile, /DSH_HOME 未定位/);
  assert.match(noHome.installTruth.reasons.lastInstall, /DSH_HOME 未定位/);

  // 无参数调用是 status 的常见路径之一，必须安全
  const bare = readInstallTruth();
  assert.equal(typeof bare, "object");
  assert.ok(Object.prototype.hasOwnProperty.call(bare, "hostIntegrity"));
  assert.ok(Object.prototype.hasOwnProperty.call(bare, "installTruth"));
});

test("journal 处于 pending：state=pending、版本未知、时间取 startedAt、原因点名", (t) => {
  const f = fixture(t);
  const resources = f.resources({});
  const home = f.home({
    journal: {
      version: 1,
      state: "pending",
      startedAt: "2026-02-02T10:00:00.000Z",
      finishedAt: null,
      tree: null,
      resources: null,
      exe: null,
      previous: null,
      asarBackup: null,
      steps: [],
      error: null,
    },
  });
  const truth = readInstallTruth({ dshHome: home, resourcesDir: resources });

  assert.equal(truth.lastInstall.state, "pending");
  assert.equal(truth.lastInstall.version, null);
  assert.equal(truth.lastInstall.at, "2026-02-02T10:00:00.000Z");
  assert.equal(truth.lastInstall.previousVersion, null);
  assert.equal(truth.lastInstall.kind, "");
  assert.match(truth.installTruth.reasons.lastInstall, /state=pending/);
});

test("journal 是宿主安装：kind=host、版本从新树读、previous 是旧树路径", (t) => {
  const f = fixture(t);
  const resources = f.resources({});
  const tree = path.join(f.root, "staging-app");
  writeJson(path.join(tree, "dsh", "package.json"), { name: "dsh", version: "1.3.0" });
  const previousTree = path.join(f.root, "app.prev-20260101");
  const home = f.home({
    journal: {
      version: 1,
      state: "done",
      startedAt: "2026-01-05T00:00:00.000Z",
      finishedAt: "2026-01-05T00:02:00.000Z",
      tree: tree,
      resources: resources,
      exe: null,
      previous: previousTree,
      asarBackup: null,
      steps: [
        { name: "stop-app", ok: true, note: "" },
        { name: "copy-tree", ok: true, note: "" },
        { name: "probe-after", ok: true, note: "" },
        { name: "health", ok: true, note: "stability 1200ms" },
      ],
      error: null,
    },
  });
  const truth = readInstallTruth({ dshHome: home, resourcesDir: resources });

  assert.equal(truth.lastInstall.kind, "host");
  assert.equal(truth.lastInstall.version, "1.3.0");
  assert.equal(truth.lastInstall.previousVersion, "app.prev-20260101");
  assert.equal(truth.lastInstall.at, "2026-01-05T00:02:00.000Z");
  assert.equal(truth.installTruth.reasons.lastInstall, undefined);
});

test("SLOT 表缺失：slotLength=null，原因指向 asset-table.js，其余字段不受影响", (t) => {
  const f = fixture(t);
  const resources = f.resources({});
  const home = f.home({ slot: null, journal: doneJournal("1.1.100") });
  const truth = readInstallTruth({ dshHome: home, resourcesDir: resources });

  assert.equal(truth.slotLength, null);
  assert.match(truth.installTruth.reasons.slot, /asset-table\.js 的 SLOT_ROWS/);
  assert.equal(truth.profileVersion, "1.1.100");
  assert.equal(truth.hostIntegrity.ok, true);
});

test("profile 里没装 dsh-purge：profileVersion=null，原因=未安装", (t) => {
  const f = fixture(t);
  const resources = f.resources({});
  const home = f.home({ installed: false });
  const truth = readInstallTruth({ dshHome: home, resourcesDir: resources });

  assert.equal(truth.profileVersion, null);
  assert.equal(truth.installTruth.reasons.profileVersion, "未安装");
  assert.equal(truth.slotLength, null);
  assert.equal(truth.installTruth.profile, "desktop");
  assert.equal(truth.lastInstall, null);
});

test("unpacked 缺文件 + 缺 require_builtin：ok=false、缺口逐条列出", (t) => {
  const f = fixture(t);
  const resources = f.resources({ extraUnpacked: true, noAddon: true });
  const truth = readInstallTruth({ dshHome: f.home({}), resourcesDir: resources });

  assert.equal(truth.hostIntegrity.ok, false);
  assert.equal(truth.hostIntegrity.unpackedChecked, true);
  assert.deepEqual(truth.hostIntegrity.unpackedMissing, ["dsh/native/extra.node"]);
  assert.equal(truth.hostIntegrity.unpackedMissingCount, 1);
  assert.equal(truth.hostIntegrity.requireBuiltinCount, 0);
  assert.equal(truth.hostIntegrity.nativeCount, 1);
  assert.equal(truth.hostIntegrity.problems.length, 2);
  assert.match(truth.hostIntegrity.problems[0], /app 缺 1 个 unpacked 文件/);
  assert.match(truth.hostIntegrity.problems[1], /node-addon-require-builtin/);
  assert.equal(truth.hostVersion, "1.2.3");
});

test("journal 损坏：lastInstall=null，原因说明没有可用 journal", (t) => {
  const f = fixture(t);
  const resources = f.resources({});
  const home = f.home({ journal: "{ not json" });
  const truth = readInstallTruth({ dshHome: home, resourcesDir: resources });

  assert.equal(truth.lastInstall, null);
  assert.match(truth.installTruth.reasons.lastInstall, /没有安装 journal/);
  assert.equal(truth.profileVersion, "1.1.100");
});

test("gatherState 真的把这批字段接进 status 返回对象", () => {
  const source = fs.readFileSync(CORE_FILE, "utf8");
  assert.match(source, /export function readInstallTruth\(options = \{\}\)/);
  assert.match(source, /const truth = readInstallTruth\(\{ dshHome, aiBase \}\);/);
  for (const field of [
    "hostVersion: truth.hostVersion",
    "hostIntegrity: truth.hostIntegrity",
    "lastInstall: truth.lastInstall",
    "slotLength: truth.slotLength",
    "openSlotLength: truth.openSlotLength",
    "profileVersion: truth.profileVersion",
    "installTruth: truth.installTruth",
  ]) {
    assert.ok(source.includes(field), "status 缺字段：" + field);
  }
  // 只读：这段实现里不允许写盘或起子进程
  const block = source.slice(source.indexOf("export function readInstallTruth"), source.indexOf("export async function gatherState"));
  for (const banned of ["writeFileSync", "mkdirSync", "execFileSync", "spawn("]) {
    assert.equal(block.includes(banned), false, "安装真相块里不允许出现 " + banned);
  }
});

test("缓存：重复读走缓存，安装文件变了立刻重算，noCache 强制重读", (t) => {
  const f = fixture(t);
  const resources = f.resources({});
  const home = f.home({ journal: doneJournal("1.1.100") });
  const pkg = path.join(home, "profiles", "desktop", "node_modules", "dsh-purge", "package.json");

  assert.equal(readInstallTruth({ dshHome: home, resourcesDir: resources }).profileVersion, "1.1.100");
  assert.equal(readInstallTruth({ dshHome: home, resourcesDir: resources }).profileVersion, "1.1.100");

  // 换版本：mtime 必须进缓存键，否则状态页会一直报旧版本
  writeJson(pkg, { name: "dsh-purge", version: "1.1.101" });
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(pkg, future, future);
  assert.equal(readInstallTruth({ dshHome: home, resourcesDir: resources }).profileVersion, "1.1.101");

  // noCache：跳过缓存直接重读
  writeJson(pkg, { name: "dsh-purge", version: "1.1.102" });
  const later = new Date(Date.now() + 10000);
  fs.utimesSync(pkg, later, later);
  assert.equal(readInstallTruth({ dshHome: home, resourcesDir: resources, noCache: true }).profileVersion, "1.1.102");

  // 返回的是副本：调用方改字段不会污染缓存
  const first = readInstallTruth({ dshHome: home, resourcesDir: resources });
  first.hostIntegrity.ok = false;
  assert.equal(readInstallTruth({ dshHome: home, resourcesDir: resources }).hostIntegrity.ok, true);
});
