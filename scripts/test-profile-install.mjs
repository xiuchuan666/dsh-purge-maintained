import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  profileLayout, readInstalledVersion, verifyTgz, findLockEntry, rewriteLockText,
  replaceLockToken, installSpecFor, planProfileInstall, healthReport,
  slotLengthFromAssetTable, readTgzEntries, readTarballPackage, extractTgz, MIN_SLOT,
  applyInstall, backupProfile, layoutFor,
} from "../lib/profile-install.js";
import { beginInstall, loadJournal, pendingJournal } from "../lib/host-install-journal.js";

const SCRIPT = fileURLToPath(new URL("./profile-install.mjs", import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-profile-install-"));
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
function makeTgz(files) {
  const chunks = [];
  for (const file of files) {
    const data = Buffer.from(file.content, "utf8");
    chunks.push(tarHeader(file.name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

function writeTgz(dir, version, name) {
  const files = [
    { name: "package/package.json", content: JSON.stringify({ name: "dsh-purge", version: version, main: "lib/index.js" }, null, 2) },
    { name: "package/lib/index.js", content: "export const version = \"" + version + "\";\n" },
    { name: "package/lib/asset-table.js", content: "const SLOT_ROWS = [\"AAAA\", \"BBBB\"];\nexport const SLOT = SLOT_ROWS.join(\"\");\n" },
    { name: "package/cordis.patch.yml", content: "patch: []\n" },
  ];
  const file = path.join(dir, name || "dsh-purge-" + version + ".tgz");
  fs.writeFileSync(file, makeTgz(files));
  return file;
}

function lockText(options) {
  const opts = options || {};
  const from = opts.from || "1.1.97";
  const purge = opts.purge !== false;
  const tarball = opts.tarball || ("https://example.invalid/dsh-purge-" + from + ".tgz");
  const lines = [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: false",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
  ];
  if (purge) lines.push("      dsh-purge:", "        specifier: " + from, "        version: " + from);
  lines.push("      other-plugin:", "        specifier: 2.0.0", "        version: 2.0.0", "", "packages:", "");
  if (purge) {
    lines.push(
      "  dsh-purge@" + from + ":",
      "    resolution: {integrity: sha512-AAAA, tarball: " + tarball + "}",
      "    version: " + from,
      "",
    );
  }
  lines.push(
    "  other-plugin@2.0.0:",
    "    resolution: {integrity: sha512-BBBB}",
    "    version: 2.0.0",
    "",
    "  other-plugin@1.1.97:",
    "    resolution: {integrity: sha512-CCCC}",
    "    version: 1.1.97",
    "",
    "snapshots:",
    "",
  );
  if (purge) lines.push("  dsh-purge@" + from + ": {}", "");
  lines.push("  other-plugin@2.0.0: {}", "  other-plugin@1.1.97: {}", "");
  return lines.join("\n");
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
  fs.writeFileSync(path.join(pluginDir, "lib", "asset-table.js"), "const SLOT_ROWS = [\"AAAA\", \"BBBB\"];\nexport const SLOT = SLOT_ROWS.join(\"\");\n");
  fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({
    name: "dsh-profile-desktop",
    dependencies: { "dsh-purge": spec, "other-plugin": "2.0.0" },
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(profileDir, "pnpm-lock.yaml"), opts.lock || lockText({ from: opts.lockFrom || spec, purge: opts.purge }));
  return { profileDir: profileDir, pluginDir: pluginDir };
}

test("profileLayout：home 下 profile 的固定路径", () => {
  const home = path.join(os.tmpdir(), "dsh-home-fixture");
  const layout = profileLayout(home);
  assert.equal(layout.profileDir, path.join(home, "profiles", "desktop"));
  assert.equal(layout.nodeModules, path.join(layout.profileDir, "node_modules"));
  assert.equal(layout.pkgJson, path.join(layout.profileDir, "package.json"));
  assert.equal(layout.lockFile, path.join(layout.profileDir, "pnpm-lock.yaml"));
  assert.equal(layout.pluginDir, path.join(layout.nodeModules, "dsh-purge"));
  assert.equal(profileLayout("H", "web").profileDir, path.join(path.resolve("H"), "profiles", "web"));
});

test("readInstalledVersion：已安装返回版本，未安装返回 ok:false", () => {
  const root = tmp();
  const profile = makeProfile(root);
  const installed = readInstalledVersion(profile.profileDir);
  assert.equal(installed.ok, true);
  assert.equal(installed.version, "1.1.97");
  assert.equal(installed.name, "dsh-purge");
  const missing = readInstalledVersion(path.join(root, "nope"));
  assert.equal(missing.ok, false);
  assert.equal(missing.version, null);
  assert.equal(missing.error, "未安装");
});

test("replaceLockToken：相等/peer 后缀/file:/范围会换，近似版本不动", () => {
  assert.equal(replaceLockToken("1.1.97", "1.1.97", "1.1.98"), "1.1.98");
  assert.equal(replaceLockToken("1.1.97(@peer@1.0.0)", "1.1.97", "1.1.98"), "1.1.98(@peer@1.0.0)");
  assert.equal(replaceLockToken("^1.1.97", "1.1.97", "1.1.98"), "^1.1.98");
  assert.equal(replaceLockToken("file:../../plugins/dsh-purge-1.1.97.tgz", "1.1.97", "1.1.98"), "file:../../plugins/dsh-purge-1.1.98.tgz");
  assert.equal(replaceLockToken("1.1.970", "1.1.97", "1.1.98"), "1.1.970");
  assert.equal(replaceLockToken("1.1.97-beta", "1.1.97", "1.1.98"), "1.1.97-beta");
  assert.equal(replaceLockToken("dsh-purge-extra@1.1.97", "1.1.97", "1.1.98"), "dsh-purge-extra@1.1.97");
});

test("rewriteLockText：只改 dsh-purge 段，其它包逐行不动", () => {
  const before = lockText();
  const result = rewriteLockText(before, { from: "1.1.97", to: "1.1.98", integrity: "sha512-NEW", tarball: "file:../../plugins/dsh-purge-1.1.98.tgz" });
  assert.equal(result.found, true);
  assert.ok(result.changes.length >= 4);
  assert.match(result.text, /^  dsh-purge@1\.1\.98:$/m);
  assert.match(result.text, /^  dsh-purge@1\.1\.98: \{\}$/m);
  assert.match(result.text, /integrity: sha512-NEW/);
  assert.match(result.text, /tarball: file:\.\.\/\.\.\/plugins\/dsh-purge-1\.1\.98\.tgz/);
  const pick = (text) => text.split("\n").filter((line) => line.includes("other-plugin"));
  assert.deepEqual(pick(result.text), pick(before));
});

test("rewriteLockText：不传 integrity 时保留原行，传了才替换", () => {
  const before = lockText();
  const kept = rewriteLockText(before, { from: "1.1.97", to: "1.1.98" });
  assert.match(kept.text, /integrity: sha512-AAAA/);
  assert.match(kept.text, /tarball: https:\/\/example\.invalid\/dsh-purge-1\.1\.98\.tgz/);
  assert.ok(kept.changes.some((line) => line.includes("tarball")));
  const swapped = rewriteLockText(before, { from: "1.1.97", to: "1.1.98", integrity: "sha512-BBBB" });
  assert.match(swapped.text, /integrity: sha512-BBBB/);
  assert.ok(swapped.changes.some((line) => line.includes("integrity")));
});

test("rewriteLockText：file: 依赖的 importer/key/version 一起换", () => {
  const from = "file:../../plugins/dsh-purge-1.1.97.tgz";
  const to = "file:../../plugins/dsh-purge-1.1.98.tgz";
  const before = lockText({ from: from, tarball: from });
  const result = rewriteLockText(before, { from: from, to: to, tarball: to, integrity: "sha512-FILE" });
  assert.equal(result.found, true);
  assert.match(result.text, /^      dsh-purge:$/m);
  assert.match(result.text, /specifier: file:\.\.\/\.\.\/plugins\/dsh-purge-1\.1\.98\.tgz/);
  assert.match(result.text, /^  dsh-purge@file:\.\.\/\.\.\/plugins\/dsh-purge-1\.1\.98\.tgz:$/m);
  assert.match(result.text, /^  dsh-purge@file:\.\.\/\.\.\/plugins\/dsh-purge-1\.1\.98\.tgz: \{\}$/m);
  assert.match(result.text, /integrity: sha512-FILE/);
  assert.doesNotMatch(result.text, /dsh-purge-1\.1\.97\.tgz/);
});

test("rewriteLockText：没有 dsh-purge 段时原样返回 found:false", () => {
  const before = lockText({ purge: false });
  const result = rewriteLockText(before, { from: "1.1.97", to: "1.1.98" });
  assert.equal(result.found, false);
  assert.equal(result.changes.length, 0);
  assert.equal(result.text, before);
  assert.equal(findLockEntry(before).found, false);
});

test("rewriteLockText：^1.1.97 range specifier 也会换，其它包 range 不动", () => {
  const before = lockText({ from: "^1.1.97" });
  const result = rewriteLockText(before, { from: "^1.1.97", to: "^1.1.98" });
  assert.match(result.text, /specifier: \^1\.1\.98/);
  assert.match(result.text, /other-plugin@1\.1\.97/);
});

test("verifyTgz：sha256(hex)+size 正确时通过", () => {
  const root = tmp();
  const tgz = writeTgz(root, "1.1.98");
  const buf = fs.readFileSync(tgz);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const result = verifyTgz(tgz, { sha256: sha, size: buf.length });
  assert.equal(result.ok, true);
  assert.equal(result.size, buf.length);
  assert.equal(result.sha256, sha);
});

test("verifyTgz：sha256-base64 形式也认", () => {
  const root = tmp();
  const tgz = writeTgz(root, "1.1.98");
  const b64 = crypto.createHash("sha256").update(fs.readFileSync(tgz)).digest("base64");
  assert.equal(verifyTgz(tgz, { sha256: "sha256-" + b64 }).ok, true);
});

test("verifyTgz：size 不符拒绝", () => {
  const root = tmp();
  const tgz = writeTgz(root, "1.1.98");
  const result = verifyTgz(tgz, { size: fs.statSync(tgz).size + 1 });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" "), /大小不符/);
});

test("verifyTgz：sha 不符拒绝", () => {
  const root = tmp();
  const tgz = writeTgz(root, "1.1.98");
  const result = verifyTgz(tgz, { sha256: "0".repeat(64) });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" "), /sha256 不符/);
});

test("verifyTgz：文件不存在拒绝", () => {
  const result = verifyTgz(path.join(tmp(), "missing.tgz"), {});
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" "), /tgz 不存在/);
});

test("tar 读取/解包往返，路径穿越被跳过", () => {
  const root = tmp();
  const tgz = path.join(root, "fixture.tgz");
  fs.writeFileSync(tgz, makeTgz([
    { name: "package/package.json", content: JSON.stringify({ name: "dsh-purge", version: "1.1.98" }) },
    { name: "package/lib/index.js", content: "export const ok = 1;\n" },
    { name: "../evil.txt", content: "nope\n" },
  ]));
  const entries = readTgzEntries(tgz);
  assert.equal(entries.length, 3);
  assert.equal(readTarballPackage(tgz).version, "1.1.98");
  const dest = path.join(root, "out");
  const result = extractTgz(tgz, dest);
  assert.equal(result.files, 2);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0], /evil/);
  assert.equal(fs.readFileSync(path.join(dest, "package", "lib", "index.js"), "utf8"), "export const ok = 1;\n");
  assert.equal(fs.existsSync(path.join(root, "evil.txt")), false);
});

test("planProfileInstall：四类拒因分别命中", () => {
  const root = tmp();
  const tgz = writeTgz(root, "1.1.98");
  const profile = makeProfile(root);

  const noProfile = planProfileInstall({ profileDir: path.join(root, "nope"), tgz: tgz, packageVersion: "1.1.98" });
  assert.equal(noProfile.ok, false);
  assert.match(noProfile.reasons.join(" "), /profile 不存在/);

  const noTgz = planProfileInstall({ profileDir: profile.profileDir, tgz: path.join(root, "missing.tgz"), packageVersion: "1.1.98" });
  assert.equal(noTgz.ok, false);
  assert.match(noTgz.reasons.join(" "), /tgz 不存在/);

  const mismatch = planProfileInstall({ profileDir: profile.profileDir, tgz: tgz, packageVersion: "1.1.99" });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reasons.join(" "), /1\.1\.98 与期望 1\.1\.99 不一致/);

  const noLockRoot = tmp();
  const noLock = makeProfile(noLockRoot, { purge: false });
  const noLockPlan = planProfileInstall({ profileDir: noLock.profileDir, tgz: tgz, packageVersion: "1.1.98" });
  assert.equal(noLockPlan.ok, false);
  assert.match(noLockPlan.reasons.join(" "), /找不到 dsh-purge 段/);
});

test("planProfileInstall：通过时给出步骤、from 与 spec", () => {
  const root = tmp();
  const profile = makeProfile(root);
  const tgz = writeTgz(root, "1.1.98");
  const plan = planProfileInstall({ profileDir: profile.profileDir, tgz: tgz, packageVersion: "1.1.98" });
  assert.equal(plan.ok, true);
  assert.equal(plan.reasons.length, 0);
  assert.equal(plan.from, "1.1.97");
  assert.equal(plan.expectedVersion, "1.1.98");
  assert.equal(plan.installedVersion, "1.1.97");
  assert.equal(plan.spec, "1.1.98");
  assert.ok(plan.steps.length >= 8);
  assert.match(plan.steps.join(" "), /健康检查/);
});

test("planProfileInstall：原 file: 安装保持 file: 并指向新 tgz", () => {
  const root = tmp();
  const plugins = path.join(root, "plugins");
  fs.mkdirSync(plugins, { recursive: true });
  const oldSpec = "file:../../plugins/dsh-purge-1.1.97.tgz";
  const profile = makeProfile(root, { version: "1.1.97", spec: oldSpec, lockFrom: oldSpec });
  const tgz = writeTgz(plugins, "1.1.98");
  const plan = planProfileInstall({ profileDir: profile.profileDir, tgz: tgz, packageVersion: "1.1.98" });
  assert.equal(plan.ok, true);
  assert.equal(plan.spec, "file:../../plugins/dsh-purge-1.1.98.tgz");
  assert.equal(installSpecFor({ profileDir: profile.profileDir, tgz: tgz, currentSpec: oldSpec, version: "1.1.98" }), "file:../../plugins/dsh-purge-1.1.98.tgz");
  assert.equal(installSpecFor({ profileDir: profile.profileDir, tgz: tgz, currentSpec: "1.1.97", version: "1.1.98" }), "1.1.98");
});

test("installSpecFor：跨盘 tgz 退回绝对 file: 路径，不拼出 file:./D:/…", () => {
  const root = tmp();
  const profile = makeProfile(root, { version: "1.1.97", spec: "file:../../plugins/dsh-purge-1.1.97.tgz", lockFrom: "file:../../plugins/dsh-purge-1.1.97.tgz" });
  const spec = installSpecFor({ profileDir: profile.profileDir, tgz: "Z:/elsewhere/dsh-purge-1.1.100.tgz", currentSpec: "file:../../plugins/dsh-purge-1.1.97.tgz", version: "1.1.100" });
  assert.equal(spec, "file:Z:/elsewhere/dsh-purge-1.1.100.tgz");
  assert.equal(/file:\.\//.test(spec), false);
});

test("healthReport：minSlot 为 null/undefined 时回落 MIN_SLOT，不当成 0", () => {
  const loose = healthReport({ expected: "1.1.98", actual: "1.1.98", slotLength: 5000, minSlot: null });
  assert.equal(loose.ok, false);
  assert.equal(loose.checks.find((c) => c.name === "slot").minSlot, MIN_SLOT);
  const missing = healthReport({ expected: "1.1.98", actual: "1.1.98", slotLength: 5000 });
  assert.equal(missing.ok, false);
  const zero = healthReport({ expected: "1.1.98", actual: "1.1.98", slotLength: 0, minSlot: 0 });
  assert.equal(zero.ok, true);
});

test("planProfileInstall：计划文案里的 SLOT 下限是 20000 而不是 0", () => {
  const root = tmp();
  const plugins = path.join(root, "plugins");
  fs.mkdirSync(plugins, { recursive: true });
  const oldSpec = "file:../../plugins/dsh-purge-1.1.97.tgz";
  const profile = makeProfile(root, { version: "1.1.97", spec: oldSpec, lockFrom: oldSpec });
  const tgz = writeTgz(plugins, "1.1.98");
  const plan = planProfileInstall({ profileDir: profile.profileDir, tgz: tgz, packageVersion: "1.1.98", minSlot: null });
  assert.match(plan.steps.join(" "), new RegExp("SLOT 长度 ≥ " + MIN_SLOT));
});

test("healthReport：版本一致 + slot 阈值边界", () => {
  const atLimit = healthReport({ expected: "1.1.98", actual: "1.1.98", slotLength: MIN_SLOT });
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.checks.find((c) => c.name === "slot").ok, true);

  const below = healthReport({ expected: "1.1.98", actual: "1.1.98", slotLength: MIN_SLOT - 1 });
  assert.equal(below.ok, false);
  assert.equal(below.checks.find((c) => c.name === "slot").ok, false);

  const skipped = healthReport({ expected: "1.1.98", actual: "1.1.98", slotLength: null });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.checks.find((c) => c.name === "slot").skipped, true);

  const custom = healthReport({ expected: "1.1.98", actual: "1.1.98", slotLength: 6000, minSlot: 5000 });
  assert.equal(custom.ok, true);
});

test("healthReport：版本不一致失败并列出 detail", () => {
  const report = healthReport({ expected: "1.1.98", actual: "1.1.97", slotLength: 90000 });
  assert.equal(report.ok, false);
  const version = report.checks.find((c) => c.name === "version");
  assert.equal(version.ok, false);
  assert.match(version.detail, /1\.1\.98/);
});

test("slotLengthFromAssetTable：只数 SLOT_ROWS 里的字符串", () => {
  const source = "const X = [\"nope\"];\nconst SLOT_ROWS = [\n  \"AAAA\",\n  \"BBBBBB\"\n];\nexport const SLOT = SLOT_ROWS.join(\"\");\n";
  assert.equal(slotLengthFromAssetTable(source), 10);
  assert.equal(slotLengthFromAssetTable("export const SLOT = 1;"), null);
});

test("CLI：默认 dry-run 只打印计划，不动文件", () => {
  const root = tmp();
  const profile = makeProfile(root);
  const tgz = writeTgz(root, "1.1.98");
  const pkgBefore = fs.readFileSync(path.join(profile.profileDir, "package.json"), "utf8");
  const lockBefore = fs.readFileSync(path.join(profile.profileDir, "pnpm-lock.yaml"), "utf8");
  const home = path.join(root, "home");
  const run = spawnSync(process.execPath, [SCRIPT, "--tgz", tgz, "--home", home, "--profile-dir", profile.profileDir, "--exe", path.join(root, "no-such-host.exe")], { encoding: "utf8" });
  assert.ok(run.status === 0 || run.status === 2, "unexpected exit " + run.status + ": " + run.stderr);
  if (run.status === 0) {
    assert.match(run.stdout, /\[dry-run\] 计划/);
    assert.match(run.stdout, /1\.1\.97 → 1\.1\.98/);
  }
  assert.equal(fs.readFileSync(path.join(profile.profileDir, "package.json"), "utf8"), pkgBefore);
  assert.equal(fs.readFileSync(path.join(profile.profileDir, "pnpm-lock.yaml"), "utf8"), lockBefore);
  assert.equal(fs.existsSync(home), false);
});

test("CLI：没有 journal 时 --rollback 预检失败退出 2", () => {
  const home = tmp();
  const run = spawnSync(process.execPath, [SCRIPT, "--rollback", "--home", home, "--exe", path.join(home, "no-such-host.exe")], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /没有可回滚/);
});

test("applyInstall：成功写入并收尾 journal", () => {
  const root = tmp();
  const home = path.join(root, "home");
  const profile = makeProfile(root);
  const tgz = writeTgz(root, "1.1.98");
  const layout = layoutFor(profile.profileDir, home, "desktop");
  const plan = planProfileInstall({ profileDir: profile.profileDir, home: home, tgz: tgz, packageVersion: "1.1.98", minSlot: 4 });
  assert.equal(plan.ok, true);
  const result = applyInstall({ home: home, layout: layout, plan: plan, minSlot: 4 });
  assert.equal(result.ok, true, result.error);
  assert.equal(readInstalledVersion(profile.profileDir).version, "1.1.98");
  const pkg = JSON.parse(fs.readFileSync(path.join(profile.profileDir, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["dsh-purge"], "1.1.98");
  const lock = fs.readFileSync(path.join(profile.profileDir, "pnpm-lock.yaml"), "utf8");
  assert.match(lock, /^  dsh-purge@1\.1\.98:$/m);
  assert.doesNotMatch(lock, /integrity: sha512-AAAA/);
  assert.equal(fs.existsSync(plan.backupDir), false);
  assert.equal(loadJournal(home).state, "done");
  assert.equal(pendingJournal(home), null);
});

test("applyInstall：写入失败时还原上一版并标记 rolled-back", () => {
  const root = tmp();
  const home = path.join(root, "home");
  const profile = makeProfile(root);
  const tgz = writeTgz(root, "1.1.98");
  const layout = layoutFor(profile.profileDir, home, "desktop");
  const plan = planProfileInstall({ profileDir: profile.profileDir, home: home, tgz: tgz, packageVersion: "1.1.98", minSlot: 4 });
  assert.equal(plan.ok, true);
  fs.rmSync(path.join(profile.profileDir, "pnpm-lock.yaml"));
  const result = applyInstall({ home: home, layout: layout, plan: plan, minSlot: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(readInstalledVersion(profile.profileDir).version, "1.1.97");
  const journal = loadJournal(home);
  assert.equal(journal.state, "rolled-back");
  assert.match(journal.error, /pnpm-lock/);
});

test("CLI：有未收尾 journal 时 --apply 退出 3", () => {
  const root = tmp();
  const home = path.join(root, "home");
  const profile = makeProfile(root);
  const tgz = writeTgz(root, "1.1.98");
  beginInstall(home, { tree: path.join(root, "backup"), resources: profile.profileDir, exe: null, previous: null });
  const run = spawnSync(process.execPath, [SCRIPT, "--apply", "--tgz", tgz, "--home", home, "--profile-dir", profile.profileDir, "--exe", path.join(root, "no-such-host.exe")], { encoding: "utf8" });
  assert.equal(run.status, 3, run.stderr);
  assert.match(run.stderr, /未收尾/);
});

test("CLI：--rollback 未给 --exe 且未加 --force 时预检失败退出 2", () => {
  const home = tmp();
  const run = spawnSync(process.execPath, [SCRIPT, "--rollback", "--home", home], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--exe/);
});

test("CLI：--rollback --force 无 --exe 时照旧还原并提示手动重启", () => {
  const root = tmp();
  const home = path.join(root, "home");
  const profile = makeProfile(root, { version: "1.1.97" });
  const layout = layoutFor(profile.profileDir, home, "desktop");
  backupProfile(layout, layout.backupDir);
  fs.writeFileSync(path.join(profile.pluginDir, "package.json"), JSON.stringify({ name: "dsh-purge", version: "1.1.98" }));
  beginInstall(home, { tree: layout.backupDir, resources: profile.profileDir, exe: null, previous: { version: "1.1.97" } });
  const run = spawnSync(process.execPath, [SCRIPT, "--rollback", "--force", "--home", home, "--profile-dir", profile.profileDir], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /未关闭宿主，请手动重启应用/);
  assert.equal(readInstalledVersion(profile.profileDir).version, "1.1.97");
  assert.equal(loadJournal(home).state, "done");
});

test("applyInstall：清理备份失败只进 warnings，不把成功安装报成失败", () => {
  const root = tmp();
  const home = path.join(root, "home");
  const profile = makeProfile(root);
  const tgz = writeTgz(root, "1.1.98");
  const layout = layoutFor(profile.profileDir, home, "desktop");
  const plan = planProfileInstall({ profileDir: profile.profileDir, home: home, tgz: tgz, packageVersion: "1.1.98", minSlot: 4 });
  assert.equal(plan.ok, true);
  const realRm = fs.rmSync;
  let seen = 0;
  fs.rmSync = function (target, options) {
    if (path.resolve(String(target)) === path.resolve(plan.backupDir)) {
      seen += 1;
      if (seen > 1) throw new Error("模拟删除失败");
    }
    return realRm.call(fs, target, options);
  };
  let result;
  try {
    result = applyInstall({ home: home, layout: layout, plan: plan, minSlot: 4 });
  } finally {
    fs.rmSync = realRm;
  }
  assert.equal(result.ok, true, result.error);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /模拟删除失败/);
  assert.equal(readInstalledVersion(profile.profileDir).version, "1.1.98");
  assert.equal(loadJournal(home).state, "done");
  assert.equal(fs.existsSync(plan.backupDir), true);
});
