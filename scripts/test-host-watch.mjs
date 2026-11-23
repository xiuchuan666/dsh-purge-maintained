import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_URL,
  buildPlan,
  decide,
  decideDetail,
  defaultDownloadDest,
  downloadFileName,
  extractDirFor,
  loadState,
  loadStateInfo,
  nextState,
  normalizeEtag,
  parseHead,
  saveState,
  statePath,
} from "../lib/host-watch.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "host-watch-"));
}

// ---------- 一、响应头 ----------

test("parseHead：头名大小写不敏感，长度转成数字", () => {
  const head = parseHead({ ETag: '"abc123"', "Last-Modified": "Tue, 18 Nov 2025 19:34:00 GMT", "Content-Length": "299593552" });
  assert.equal(head.etag, '"abc123"');
  assert.equal(head.lastModified, "Tue, 18 Nov 2025 19:34:00 GMT");
  assert.equal(head.contentLength, 299593552);
  const lower = parseHead({ etag: '"abc123"', "last-modified": "Tue, 18 Nov 2025 19:34:00 GMT", "content-length": "299593552" });
  assert.deepEqual(lower, head);
});

test("parseHead：缺字段回 null，非数字长度不吃，Headers/数组输入也认", () => {
  assert.deepEqual(parseHead({}), { etag: null, lastModified: null, contentLength: null });
  assert.equal(parseHead({ "content-length": "12abc" }).contentLength, null);
  const fakeHeaders = { entries: () => [["ETAG", 'W/"x"'], ["Content-Length", "7"]] };
  const fromHeaders = parseHead(fakeHeaders);
  assert.equal(fromHeaders.etag, 'W/"x"');
  assert.equal(fromHeaders.contentLength, 7);
  assert.equal(parseHead([["ETag", '"y"'], ["Last-Modified", "x"]]).etag, '"y"');
  assert.deepEqual(parseHead(null), { etag: null, lastModified: null, contentLength: null });
});

// ---------- 二、三态判定 ----------

test("decide：ETag 变了是 new，ETag 相同就算 Last-Modified 变了也 unchanged", () => {
  assert.equal(decide({ etag: '"a"' }, { etag: '"b"' }), "new");
  assert.equal(
    decide({ etag: '"a"', lastModified: "Mon, 01 Jan 2024 00:00:00 GMT" }, { etag: '"a"', lastModified: "Tue, 02 Jan 2024 00:00:00 GMT" }),
    "unchanged",
  );
  assert.equal(decideDetail({ etag: '"a"' }, { etag: '"b"' }).by, "etag");
});

test("decide：没有 ETag 时 Last-Modified 变化 → new，不变 → unchanged", () => {
  assert.equal(decide({ lastModified: "Mon, 01 Jan 2024 00:00:00 GMT" }, { lastModified: "Tue, 02 Jan 2024 00:00:00 GMT" }), "new");
  assert.equal(decide({ lastModified: "Mon, 01 Jan 2024 00:00:00 GMT" }, { lastModified: "Mon, 01 Jan 2024 00:00:00 GMT" }), "unchanged");
  assert.equal(decideDetail({ lastModified: "Mon, 01 Jan 2024 00:00:00 GMT" }, { lastModified: "Tue, 02 Jan 2024 00:00:00 GMT" }).by, "last-modified");
});

test("decide：只剩 Content-Length，变了 → new，相同 → unknown（长度不是身份）", () => {
  assert.equal(decide({ contentLength: 100 }, { contentLength: 120 }), "new");
  const same = decideDetail({ contentLength: 100 }, { contentLength: 100 });
  assert.equal(same.verdict, "unknown");
  assert.equal(same.by, "content-length");
  assert.equal(decide({ contentLength: "100" }, { contentLength: 120 }), "new");
});

test("decide：两侧全缺 / 没有基线 / 指纹不重叠都是 unknown", () => {
  assert.equal(decide({}, {}), "unknown");
  assert.equal(decide(null, { etag: '"a"' }), "unknown");
  assert.equal(decide(null, {}), "unknown");
  assert.equal(decide({ etag: '"a"' }, {}), "unknown");
  assert.equal(decide({ contentLength: 100 }, { etag: '"a"' }), "unknown");
  assert.equal(decide({ etag: '"a"' }, null), "unknown");
});

// ---------- 三、state ----------

test("statePath：固定落在 <home>/.dsh/dsh-purge/host-watch.json", () => {
  const home = path.join(path.sep + "tmp", "someone");
  assert.equal(statePath(home), path.join(home, ".dsh", "dsh-purge", "host-watch.json"));
  assert.equal(statePath(""), path.join(os.homedir(), ".dsh", "dsh-purge", "host-watch.json"));
});

test("state roundtrip：saveState 建目录，loadState 原样读回，BOM 也吃", () => {
  const dir = tmpDir();
  const file = path.join(dir, "nested", "host-watch.json");
  const state = { url: DEFAULT_URL, etag: '"v1"', lastModified: null, contentLength: 12, status: "new", checkedAt: "T1" };
  assert.equal(saveState(file, state), file);
  assert.deepEqual(loadState(file), state);
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));

  const bomFile = path.join(dir, "bom.json");
  fs.writeFileSync(bomFile, "\uFEFF" + JSON.stringify({ etag: '"bom"' }), "utf8");
  assert.equal(loadState(bomFile).etag, '"bom"');
  fs.rmSync(dir, { recursive: true, force: true });
});

test("坏 JSON 容错：不回抛，返回 null 并给出原因；数组/空文件同样", () => {
  const dir = tmpDir();
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, '{"etag": "a", ', "utf8");
  assert.equal(loadState(broken), null);
  const info = loadStateInfo(broken);
  assert.equal(info.ok, false);
  assert.match(info.reason, /JSON/);

  const arr = path.join(dir, "array.json");
  fs.writeFileSync(arr, "[1,2,3]", "utf8");
  assert.equal(loadState(arr), null);
  assert.equal(loadStateInfo(arr).ok, false);

  const empty = path.join(dir, "empty.json");
  fs.writeFileSync(empty, "   \n", "utf8");
  assert.equal(loadState(empty), null);

  assert.equal(loadState(path.join(dir, "missing.json")), null);
  assert.match(loadStateInfo(path.join(dir, "missing.json")).reason, /不存在/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("nextState：new 记住上一版与 firstSeenAt，unchanged 不改首次时间", () => {
  const prev = { etag: '"a"', lastModified: "Mon, 01 Jan 2024 00:00:00 GMT", contentLength: 10, checkedAt: "T1", firstSeenAt: "T0" };
  const changed = nextState(prev, { etag: '"b"', contentLength: 11 }, { checkedAt: "T2", url: DEFAULT_URL });
  assert.equal(changed.status, "new");
  assert.equal(changed.firstSeenAt, "T2");
  assert.equal(changed.previous.etag, '"a"');
  assert.equal(changed.previous.checkedAt, "T1");

  const same = nextState(changed, { etag: '"b"', contentLength: 11 }, { checkedAt: "T3" });
  assert.equal(same.status, "unchanged");
  assert.equal(same.firstSeenAt, "T2");
  assert.equal(same.previous.etag, '"a"');
});

// ---------- 四、下载文件名与计划 ----------

test("downloadFileName：非法字符清洗、空 ETag 退 latest、超长截断", () => {
  assert.equal(downloadFileName('W/"a/b:c*d?e"'), "a-b-c-d-e.exe");
  assert.equal(downloadFileName('"abc123"'), "abc123.exe");
  assert.equal(downloadFileName('""'), "latest.exe");
  assert.equal(downloadFileName(""), "latest.exe");
  assert.equal(downloadFileName(null, "fallback"), "fallback.exe");
  assert.equal(downloadFileName("../.."), "latest.exe");
  assert.equal(downloadFileName("x".repeat(200)).length, 84);
  assert.equal(normalizeEtag('W/"abc"'), "abc");
  assert.match(defaultDownloadDest("C:\\home", '"e1"'), /host-watch[\\/]e1\.exe$/);
});

test("buildPlan：四步顺序固定，7z 只在 extract，命令含 --tree 与 --rehearse，不落盘", () => {
  const dir = tmpDir();
  const dest = path.join(dir, "pkg.exe");
  const plan = buildPlan({ url: "https://example.invalid/pkg.exe", destFile: dest, installdir: "C:\\Host Home" });
  assert.deepEqual(plan.map((step) => step.kind), ["download", "extract", "asar", "rehearse"]);
  assert.ok(plan.every((step) => step.manualOnly === true));
  assert.ok(plan.every((step) => step.index >= 1));
  assert.equal(plan[1].tool, "7z");
  assert.match(plan[1].command, /^7z x /);
  assert.equal(plan.filter((step) => step.tool === "7z").length, 1);
  const all = JSON.stringify(plan);
  assert.match(all, /--tree/);
  assert.match(all, /--rehearse/);
  assert.match(plan[0].command, /--download/);
  assert.match(plan[2].command, /extract-asar\.mjs/);
  assert.match(plan[3].command, /host-rehearse\.mjs/);
  assert.ok(plan[3].extra.some((cmd) => /host-install\.mjs --tree/.test(cmd) && !/--apply/.test(cmd)));
  assert.equal(extractDirFor("C:\\tmp\\package.exe"), path.join("C:\\tmp", "package-extract"));
  assert.equal(fs.existsSync(dest), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildPlan：缺 destFile 直接报错，不会悄悄用默认值", () => {
  assert.throws(() => buildPlan({ url: DEFAULT_URL }), /destFile/);
  assert.throws(() => buildPlan(), /destFile/);
});

test("CLI --plan --json 离线可用：四步、含 --tree/--rehearse、状态文件一个都没建", () => {
  const dir = tmpDir();
  const run = spawnSync(
    process.execPath,
    ["scripts/host-watch.mjs", "--plan", "--json", "--home", dir, "--installdir", path.join(dir, "host")],
    { cwd: REPO, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "plan");
  assert.equal(payload.manualOnly, true);
  assert.equal(payload.steps.length, 4);
  const text = JSON.stringify(payload);
  assert.match(text, /--tree/);
  assert.match(text, /--rehearse/);
  assert.equal(fs.existsSync(path.join(dir, ".dsh")), false);

  const narrow = spawnSync(
    process.execPath,
    ["scripts/host-watch.mjs", "--plan", "--rehearse", "--json", "--home", dir, "--installdir", path.join(dir, "host")],
    { cwd: REPO, encoding: "utf8" },
  );
  assert.equal(narrow.status, 0, narrow.stderr);
  const only = JSON.parse(narrow.stdout);
  assert.equal(only.steps.length, 1);
  assert.equal(only.steps[0].kind, "rehearse");
  fs.rmSync(dir, { recursive: true, force: true });
});
