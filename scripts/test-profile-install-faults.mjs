import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyInstall,
  backupProfile,
  extractTgz,
  layoutFor,
  planProfileInstall,
  readInstalledVersion,
  readTgzEntries,
} from "../lib/profile-install.js";
import { beginInstall, loadJournal, pendingJournal } from "../lib/host-install-journal.js";

const SCRIPT = fileURLToPath(new URL("./profile-install.mjs", import.meta.url));
const STAGING = ".dsh-purge-staging";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-profile-faults-"));
}

function tarHeader(name, size, type) {
  const buf = Buffer.alloc(512, 0);
  buf.write(name, 0, 100, "utf8");
  buf.write("0000644\0", 100, 8, "ascii");
  buf.write("0000000\0", 108, 8, "ascii");
  buf.write("0000000\0", 116, 8, "ascii");
  buf.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  buf.write("00000000000\0", 136, 12, "ascii");
  buf.write("        ", 148, 8, "ascii");
  buf.write(type || "0", 156, 1, "ascii");
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return buf;
}

/** 手写 ustar，测试不依赖系统 tar。 */
function makeTgz(files, options) {
  const opts = options || {};
  const chunks = [];
  for (const file of files) {
    const data = Buffer.from(file.content, "utf8");
    chunks.push(tarHeader(file.name, data.length, file.type), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(chunks);
  return opts.raw ? tar : zlib.gzipSync(tar);
}

function packageFiles(version) {
  return [
    { name: "package/package.json", content: JSON.stringify({ name: "dsh-purge", version: version, main: "lib/index.js" }, null, 2) },
    { name: "package/lib/index.js", content: "export const version = \"" + version + "\";\n" },
    { name: "package/lib/asset-table.js", content: 'const SLOT_ROWS = ["AAAA", "BBBB"];\nexport const SLOT = SLOT_ROWS.join("");\n' },
    { name: "package/cordis.patch.yml", content: "patch: []\n" },
  ];
}

function writeTgz(dir, version, name) {
  const file = path.join(dir, name || "dsh-purge-" + version + ".tgz");
  fs.writeFileSync(file, makeTgz(packageFiles(version)));
  return file;
}

function lockText(options) {
  const opts = options || {};
  const from = opts.from || "1.1.97";
  const tarball = opts.tarball || ("https://example.invalid/dsh-purge-" + from + ".tgz");
  return [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      dsh-purge:",
    "        specifier: " + from,
    "        version: " + from,
    "      other-plugin:",
    "        specifier: 2.0.0",
    "        version: 2.0.0",
    "",
    "packages:",
    "",
    "  dsh-purge@" + from + ":",
    "    resolution: {integrity: sha512-AAAA, tarball: " + tarball + "}",
    "    version: " + from,
    "",
    "  other-plugin@2.0.0:",
    "    resolution: {integrity: sha512-BBBB}",
    "    version: 2.0.0",
    "",
    "snapshots:",
    "",
    "  dsh-purge@" + from + ": {}",
    "  other-plugin@2.0.0: {}",
    "",
  ].join("\n");
}

function makeProfile(root, options) {
  const opts = options || {};
  const version = opts.version || "1.1.97";
  const spec = opts.spec || version;
  const profileDir = path.join(root, "profiles", "desktop");
  const pluginDir = path.join(profileDir, "node_modules", "dsh-purge");
  fs.mkdirSync(path.join(pluginDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "dsh-purge", version: version }));
  fs.writeFileSync(path.join(pluginDir, "lib", "index.js"), "export const ok = true;\n");
  fs.writeFileSync(path.join(pluginDir, "lib", "asset-table.js"), 'const SLOT_ROWS = ["AAAA", "BBBB"];\nexport const SLOT = SLOT_ROWS.join("");\n');
  fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({
    name: "dsh-profile-desktop",
    dependencies: { "dsh-purge": spec, "other-plugin": "2.0.0" },
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(profileDir, "pnpm-lock.yaml"), lockText({ from: spec }));
  return { profileDir: profileDir, pluginDir: pluginDir };
}

/** 递归快照（内容 + 目录），用来断言「profile 一个字节都没动」。 */
function snapshot(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out[rel + "/"] = "<dir>";
        walk(full, rel);
      } else {
        out[rel] = fs.readFileSync(full, "utf8");
      }
    }
  };
  walk(root, "");
  return out;
}

function setup(options) {
  const root = tmp();
  const home = path.join(root, "home");
  const profile = makeProfile(root, options);
  const layout = layoutFor(profile.profileDir, home, "desktop");
  const tgz = writeTgz(root, "1.1.98");
  return { root: root, home: home, profile: profile, layout: layout, tgz: tgz };
}

function planOf(bag, extra) {
  return planProfileInstall(Object.assign({
    profileDir: bag.profile.profileDir,
    home: bag.home,
    tgz: bag.tgz,
    packageVersion: "1.1.98",
    minSlot: 4,
  }, extra));
}

// ── 1. tgz 完整性 ───────────────────────────────────────────────────────────

test("readTgzEntries：gzip 尾缺失直接抛错，不把压缩字节当 tar 解析", () => {
  const root = tmp();
  const tgz = writeTgz(root, "1.1.98");
  const buf = fs.readFileSync(tgz);
  const broken = path.join(root, "truncated-gzip.tgz");
  fs.writeFileSync(broken, buf.subarray(0, buf.length - 24));
  assert.throws(() => readTgzEntries(broken), /解压失败|unexpected|incorrect/i);
});

test("gzip 尾缺失：预检拒绝、给出 tarballError，profile 零改动", () => {
  const bag = setup();
  const buf = fs.readFileSync(bag.tgz);
  const broken = path.join(bag.root, "truncated-gzip.tgz");
  fs.writeFileSync(broken, buf.subarray(0, buf.length - 24));
  const before = snapshot(bag.profile.profileDir);
  const plan = planProfileInstall({ profileDir: bag.profile.profileDir, tgz: broken, packageVersion: "1.1.98" });
  assert.equal(plan.ok, false);
  assert.ok(plan.tarballError, "预检应把 tgz 解析错误写进 tarballError");
  assert.match(plan.reasons.join(" "), /解析失败|解压失败/);
  assert.deepEqual(snapshot(bag.profile.profileDir), before);
});

test("tar 条目被截断（无 gzip）：读取阶段就拒绝", () => {
  const root = tmp();
  const raw = makeTgz(packageFiles("1.1.98"), { raw: true });
  const broken = path.join(root, "truncated.tar");
  fs.writeFileSync(broken, raw.subarray(0, 512 + 16));
  assert.throws(() => readTgzEntries(broken), /截断/);
});

test("gzip 有效但内容不是 tar：预检报「没有任何条目」", () => {
  const bag = setup();
  const bogus = path.join(bag.root, "bogus.tgz");
  fs.writeFileSync(bogus, zlib.gzipSync(Buffer.from("hello")));
  const plan = planProfileInstall({ profileDir: bag.profile.profileDir, tgz: bogus, packageVersion: "1.1.98" });
  assert.equal(plan.ok, false);
  assert.match(plan.reasons.join(" "), /没有任何条目/);
  assert.ok(plan.tarballError);
});

test("缺 package/package.json：预检拒绝，applyInstall 不写 profile 且不留 journal", () => {
  const bag = setup();
  const tgz = path.join(bag.root, "no-package-json.tgz");
  fs.writeFileSync(tgz, makeTgz([{ name: "package/lib/index.js", content: "export const ok = 1;\n" }]));
  const before = snapshot(bag.profile.profileDir);
  const plan = planProfileInstall({ profileDir: bag.profile.profileDir, tgz: tgz, packageVersion: "1.1.98" });
  assert.equal(plan.ok, false);
  assert.match(plan.reasons.join(" "), /读不到 package\/package\.json/);
  const result = applyInstall({ home: bag.home, layout: bag.layout, plan: plan, minSlot: 4 });
  assert.equal(result.ok, false);
  assert.deepEqual(snapshot(bag.profile.profileDir), before);
  assert.equal(fs.existsSync(path.join(bag.profile.profileDir, "node_modules", STAGING)), false);
  assert.equal(fs.existsSync(bag.home), false, "预检失败不应创建 journal 目录");
});

test("条目路径 ../、绝对路径、盘符：预检拒绝且绝不落盘", () => {
  const bag = setup();
  const tgz = path.join(bag.root, "unsafe-paths.tgz");
  fs.writeFileSync(tgz, makeTgz(packageFiles("1.1.98").concat([
    { name: "../evil.txt", content: "nope\n" },
    { name: "..\\up.txt", content: "nope\n" },
    { name: "/abs.txt", content: "nope\n" },
    { name: "C:/win.txt", content: "nope\n" },
  ])));
  const before = snapshot(bag.profile.profileDir);
  const plan = planProfileInstall({ profileDir: bag.profile.profileDir, tgz: tgz, packageVersion: "1.1.98" });
  assert.equal(plan.ok, false);
  assert.match(plan.reasons.join(" "), /不安全路径/);
  const result = applyInstall({ home: bag.home, layout: bag.layout, plan: plan, minSlot: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TGZ_UNSAFE");
  assert.deepEqual(snapshot(bag.profile.profileDir), before);
  assert.equal(fs.existsSync(path.join(bag.root, "evil.txt")), false);
  assert.equal(fs.existsSync(path.join(bag.root, "up.txt")), false);
  assert.equal(fs.existsSync(bag.home), false);
});

test("extractTgz：绝对路径/盘符/反斜杠穿越一律跳过，不写到 root 外", () => {
  const root = tmp();
  const tgz = path.join(root, "unsafe-extract.tgz");
  fs.writeFileSync(tgz, makeTgz([
    { name: "package/package.json", content: JSON.stringify({ name: "dsh-purge", version: "1.1.98" }) },
    { name: "/abs.txt", content: "nope\n" },
    { name: "C:/win.txt", content: "nope\n" },
    { name: "..\\up.txt", content: "nope\n" },
  ]));
  const dest = path.join(root, "out");
  const result = extractTgz(tgz, dest);
  assert.equal(result.files, 1);
  assert.equal(result.skipped.length, 3);
  assert.equal(fs.existsSync(path.join(root, "up.txt")), false);
  assert.deepEqual(fs.readdirSync(dest), ["package"]);
});

// ── 2. 解包/替换中途失败不污染 profile ─────────────────────────────────────

test("解包中途写失败：staging 清空，profile 原样，journal 标记 rolled-back", () => {
  const bag = setup();
  const plan = planOf(bag);
  assert.equal(plan.ok, true, plan.reasons.join(" "));
  const before = snapshot(bag.profile.profileDir);
  const realWrite = fs.writeFileSync;
  let staged = 0;
  fs.writeFileSync = function (target, data, options) {
    if (String(target).includes(STAGING)) {
      staged += 1;
      if (staged > 2) throw new Error("模拟解包写入失败");
    }
    return realWrite.call(fs, target, data, options);
  };
  let result;
  try {
    result = applyInstall({ home: bag.home, layout: bag.layout, plan: plan, minSlot: 4 });
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true, result.error);
  assert.match(result.error, /模拟解包写入失败/);
  assert.deepEqual(snapshot(bag.profile.profileDir), before);
  assert.equal(fs.existsSync(path.join(bag.profile.profileDir, "node_modules", STAGING)), false);
  assert.deepEqual(fs.readdirSync(bag.profile.profileDir + path.sep + "node_modules"), ["dsh-purge"]);
  assert.equal(loadJournal(bag.home).state, "rolled-back");
  assert.equal(pendingJournal(bag.home), null);
});

test("替换 node_modules/dsh-purge 中途 rename 失败：restoreProfile 还原原目录", () => {
  const bag = setup();
  const plan = planOf(bag);
  assert.equal(plan.ok, true, plan.reasons.join(" "));
  const before = snapshot(bag.profile.profileDir);
  const realRename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (path.resolve(String(to)) === path.resolve(bag.layout.pluginDir)) throw new Error("模拟替换 dsh-purge 失败");
    return realRename.call(fs, from, to);
  };
  let result;
  try {
    result = applyInstall({ home: bag.home, layout: bag.layout, plan: plan, minSlot: 4 });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true, result.error);
  assert.match(result.error, /模拟替换 dsh-purge 失败/);
  assert.ok(result.restored.includes("plugin"), "还原列表要含 plugin");
  assert.deepEqual(snapshot(bag.profile.profileDir), before);
  assert.equal(readInstalledVersion(bag.profile.profileDir).version, "1.1.97");
  assert.equal(fs.readFileSync(path.join(bag.profile.pluginDir, "lib", "index.js"), "utf8"), "export const ok = true;\n");
  assert.equal(loadJournal(bag.home).state, "rolled-back");
});

// ── 3. 备份目录行为 ─────────────────────────────────────────────────────────

test("备份目录已存在：先清空再备份，旧备份不会被当成回滚源", () => {
  const bag = setup();
  const plan = planOf(bag);
  assert.equal(plan.ok, true, plan.reasons.join(" "));
  fs.mkdirSync(path.join(plan.backupDir, "plugin"), { recursive: true });
  fs.writeFileSync(path.join(plan.backupDir, "stale.txt"), "stale\n");
  fs.writeFileSync(path.join(plan.backupDir, "plugin", "package.json"), JSON.stringify({ name: "dsh-purge", version: "9.9.9" }));
  const realRename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (path.resolve(String(to)) === path.resolve(bag.layout.pluginDir)) throw new Error("模拟替换失败");
    return realRename.call(fs, from, to);
  };
  let result;
  try {
    result = applyInstall({ home: bag.home, layout: bag.layout, plan: plan, minSlot: 4 });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true, result.error);
  assert.equal(readInstalledVersion(bag.profile.profileDir).version, "1.1.97", "回滚源必须是本次备份，不是旧备份");
  assert.equal(fs.existsSync(path.join(plan.backupDir, "stale.txt")), false, "旧备份必须先被清掉");
});

test("备份目录不可写：安装中止、profile 零改动、journal 落 failed", () => {
  const bag = setup();
  const plan = planOf(bag);
  assert.equal(plan.ok, true, plan.reasons.join(" "));
  const before = snapshot(bag.profile.profileDir);
  const realMkdir = fs.mkdirSync;
  fs.mkdirSync = function (target, options) {
    if (path.resolve(String(target)) === path.resolve(plan.backupDir)) throw new Error("模拟备份目录创建失败");
    return realMkdir.call(fs, target, options);
  };
  let result;
  try {
    result = applyInstall({ home: bag.home, layout: bag.layout, plan: plan, minSlot: 4 });
  } finally {
    fs.mkdirSync = realMkdir;
  }
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false);
  assert.match(result.error, /模拟备份目录创建失败/);
  assert.deepEqual(snapshot(bag.profile.profileDir), before);
  assert.equal(loadJournal(bag.home).state, "failed");
  assert.equal(pendingJournal(bag.home), null);
});

// ── 4. journal pending 与 --force ───────────────────────────────────────────

test("journal 处于 pending：第二次 applyInstall 拒绝 code=PENDING_INSTALL，--force 放行", () => {
  const bag = setup();
  const plan = planOf(bag);
  assert.equal(plan.ok, true, plan.reasons.join(" "));
  const first = beginInstall(bag.home, { tree: plan.backupDir, resources: bag.profile.profileDir, exe: null, previous: null });
  const blocked = applyInstall({ home: bag.home, layout: bag.layout, plan: plan, minSlot: 4 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "PENDING_INSTALL");
  assert.match(blocked.error, /未收尾/);
  assert.equal(readInstalledVersion(bag.profile.profileDir).version, "1.1.97");
  assert.equal(loadJournal(bag.home).startedAt, first.startedAt, "拒绝时不能覆盖已有 journal");
  assert.equal(pendingJournal(bag.home).startedAt, first.startedAt);
  const forced = applyInstall({ home: bag.home, layout: bag.layout, plan: plan, minSlot: 4, force: true });
  assert.equal(forced.ok, true, forced.error);
  assert.equal(readInstalledVersion(bag.profile.profileDir).version, "1.1.98");
  assert.equal(loadJournal(bag.home).state, "done");
});

// ── 5. package.json 成功、lock 写失败必须整体回滚 ──────────────────────────

test("写 package.json 成功、写 pnpm-lock.yaml 失败：两者与原 node_modules 一起回滚，临时文件不残留", () => {
  const bag = setup();
  const plan = planOf(bag);
  assert.equal(plan.ok, true, plan.reasons.join(" "));
  const pkgBefore = fs.readFileSync(path.join(bag.profile.profileDir, "package.json"), "utf8");
  const lockBefore = fs.readFileSync(path.join(bag.profile.profileDir, "pnpm-lock.yaml"), "utf8");
  const realRename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (path.resolve(String(to)) === path.resolve(bag.layout.lockFile)) throw new Error("模拟 lock 写失败");
    return realRename.call(fs, from, to);
  };
  let result;
  try {
    result = applyInstall({ home: bag.home, layout: bag.layout, plan: plan, minSlot: 4 });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true, result.error);
  assert.match(result.error, /模拟 lock 写失败/);
  assert.equal(fs.readFileSync(path.join(bag.profile.profileDir, "package.json"), "utf8"), pkgBefore, "package.json 必须回到原字节");
  assert.equal(fs.readFileSync(path.join(bag.profile.profileDir, "pnpm-lock.yaml"), "utf8"), lockBefore, "pnpm-lock.yaml 必须回到原字节");
  assert.equal(readInstalledVersion(bag.profile.profileDir).version, "1.1.97");
  assert.equal(fs.readFileSync(path.join(bag.profile.pluginDir, "lib", "index.js"), "utf8"), "export const ok = true;\n");
  const leftovers = fs.readdirSync(bag.profile.profileDir).filter((name) => /\.dsh-\d+\.tmp$/.test(name));
  assert.deepEqual(leftovers, [], "写入失败后不能残留 .dsh-<pid>.tmp");
  assert.equal(loadJournal(bag.home).state, "rolled-back");
});

test("tgz 在 plan 之后损坏：applyInstall 预检拒绝，不建 journal、不碰 profile", () => {
  const bag = setup();
  const plan = planOf(bag);
  assert.equal(plan.ok, true, plan.reasons.join(" "));
  const buf = fs.readFileSync(bag.tgz);
  fs.writeFileSync(bag.tgz, buf.subarray(0, buf.length - 24));
  const before = snapshot(bag.profile.profileDir);
  const result = applyInstall({ home: bag.home, layout: bag.layout, plan: plan, minSlot: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TGZ_CORRUPT");
  assert.deepEqual(snapshot(bag.profile.profileDir), before);
  assert.equal(loadJournal(bag.home), null);
  assert.equal(fs.existsSync(plan.backupDir), false);
});

test("applyInstall 成功路径：遗留旧备份目录被清掉", () => {
  const bag = setup();
  const plan = planOf(bag);
  assert.equal(plan.ok, true, plan.reasons.join(" "));
  fs.mkdirSync(path.join(plan.backupDir, "plugin"), { recursive: true });
  fs.writeFileSync(path.join(plan.backupDir, "stale.txt"), "stale\n");
  const result = applyInstall({ home: bag.home, layout: bag.layout, plan: plan, minSlot: 4 });
  assert.equal(result.ok, true, result.error);
  assert.equal(readInstalledVersion(bag.profile.profileDir).version, "1.1.98");
  assert.equal(fs.existsSync(plan.backupDir), false);
  assert.equal(loadJournal(bag.home).state, "done");
});

// ── 6. CLI 预检：宿主仍在跑 / 坏 tgz ───────────────────────────────────────

test("CLI：--rollback 有 journal 但没 --exe/--force 时退出 2，且不还原任何文件", () => {
  const bag = setup();
  const layout = bag.layout;
  backupProfile(layout, layout.backupDir);
  fs.writeFileSync(path.join(bag.profile.pluginDir, "package.json"), JSON.stringify({ name: "dsh-purge", version: "1.1.98" }));
  beginInstall(bag.home, { tree: layout.backupDir, resources: bag.profile.profileDir, exe: null, previous: { version: "1.1.97" } });
  const run = spawnSync(process.execPath, [SCRIPT, "--rollback", "--home", bag.home, "--profile-dir", bag.profile.profileDir], { encoding: "utf8" });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /--exe/);
  assert.match(run.stderr, /宿主已退出时可加 --force/);
  assert.equal(readInstalledVersion(bag.profile.profileDir).version, "1.1.98", "预检失败不能动文件");
  assert.equal(loadJournal(bag.home).state, "pending");
});

test("CLI：--apply 时宿主仍在跑且没 --force：退出 2 并提示先退出", () => {
  const bag = setup();
  const before = snapshot(bag.profile.profileDir);
  const run = spawnSync(process.execPath, [SCRIPT, "--apply", "--tgz", bag.tgz, "--home", bag.home, "--profile-dir", bag.profile.profileDir, "--exe", process.execPath], { encoding: "utf8" });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /宿主还在运行|无法确认宿主进程状态/);
  assert.deepEqual(snapshot(bag.profile.profileDir), before);
  assert.equal(fs.existsSync(path.join(bag.home, "dsh-purge", "host-install-journal.json")), false);
});

test("CLI：tgz 损坏时预检退出 2，不创建 journal", () => {
  const bag = setup();
  const buf = fs.readFileSync(bag.tgz);
  const broken = path.join(bag.root, "broken-cli.tgz");
  fs.writeFileSync(broken, buf.subarray(0, buf.length - 24));
  const before = snapshot(bag.profile.profileDir);
  const run = spawnSync(process.execPath, [SCRIPT, "--apply", "--tgz", broken, "--home", bag.home, "--profile-dir", bag.profile.profileDir, "--version", "1.1.98", "--exe", path.join(bag.root, "no-such-host.exe")], { encoding: "utf8" });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /预检失败/);
  assert.deepEqual(snapshot(bag.profile.profileDir), before);
  assert.equal(fs.existsSync(path.join(bag.home, "dsh-purge", "host-install-journal.json")), false);
});
