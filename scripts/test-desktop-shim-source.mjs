import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "dshp-shim-source-"));
const ORIG = {};
const ENVS = [
  "TEMP", "TMP", "TMPDIR",
  "DSH_HOME", "DSH_BASE", "DSH_DESKTOP_INSTALL", "DSH_SURFACE",
  "npm_config_prefix", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "PATH",
];
for (const k of ENVS) ORIG[k] = process.env[k];
const EMPTY_PATH = path.join(ROOT, "empty-path");
mkdirSync(EMPTY_PATH, { recursive: true });
for (const k of ["TEMP", "TMP", "TMPDIR"]) process.env[k] = ROOT;

const core = await import("../lib/core.js");
const desktop = await import("../lib/desktop.js");
const SRC = readFileSync(new URL("../lib/core.js", import.meta.url), "utf8");

test.after(() => {
  for (const k of ENVS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  rmSync(ROOT, { recursive: true, force: true });
});

let seq = 0;
function put(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSync(fp, body);
  }
}

/** 一套干净的现场：桌面面 + 沙箱 env，返回各处路径。 */
function stage(opts = {}) {
  seq += 1;
  const root = path.join(ROOT, `c${seq}`);
  const env = {
    home: path.join(root, "home"),
    base: path.join(root, "ai", "node_modules", "@deepseek-ai"),
    prefix: path.join(root, "npm-prefix"),
    user: path.join(root, "userprofile"),
    appdata: path.join(root, "appdata"),
    local: path.join(root, "localappdata"),
    path: opts.path || EMPTY_PATH,
  };
  process.env.DSH_HOME = env.home;
  process.env.DSH_BASE = env.base;
  process.env.DSH_SURFACE = opts.surface || "desktop";
  process.env.npm_config_prefix = env.prefix;
  process.env.USERPROFILE = env.user;
  process.env.HOME = env.user;
  process.env.APPDATA = env.appdata;
  process.env.LOCALAPPDATA = env.local;
  process.env.PATH = env.path;
  if (opts.install === false) delete process.env.DSH_DESKTOP_INSTALL;
  else {
    const inst = path.join(root, "inst");
    put(inst, opts.installFiles || {
      "DeepSeek Harness.exe": "MZ",
      "resources/runtime/cli/bin/dsh": "#!/bin/sh\necho original\n",
      "resources/runtime/cli/bin/dsh.cmd": "@ECHO off\r\n",
    });
    process.env.DSH_DESKTOP_INSTALL = inst;
  }
  core.resetPathMemo();
  return env;
}

const CLI_REL = path.join("resources", "runtime", "cli", "bin");

function cliBinOf(env) {
  return path.join(process.env.DSH_DESKTOP_INSTALL, CLI_REL);
}

// ── 桌面面 shim 三件套的来源 ─────────────────────────────

test("桌面面：桌面树里有 runtime/cli/bin 时，三件套就从那里读", async () => {
  const env = stage();
  assert.equal(core.findDesktopShimDir(), path.normalize(cliBinOf(env)));
  const st = await core.gatherState();
  assert.equal(st.shim_scope, "desktop-cli");
  assert.equal(st.shim_cmd, "original");
  assert.equal(st.shim_ps1, "missing");
  assert.equal(st.shim_bin, "original");
});

test("桌面面：入口块打上之后 dsh 与 dsh.cmd 报 patched，ps1 仍报 missing", async () => {
  const env = stage();
  const bin = cliBinOf(env);
  const sh = desktop.patchOfficialCliShimText(
    "#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec \"$resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js\" \"$@\"\n",
  );
  writeFileSync(path.join(bin, "dsh"), sh.text);
  const cmd = desktop.patchOfficialCliCmdText(
    "@ECHO off\r\nset \"ELECTRON_RUN_AS_NODE=1\"\r\n\"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe\" \"%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js\" %*\r\n",
  );
  writeFileSync(path.join(bin, "dsh.cmd"), cmd.text);
  core.resetPathMemo();
  const st = await core.gatherState();
  assert.equal(st.shim_scope, "desktop-cli");
  assert.equal(st.shim_cmd, "patched");
  assert.equal(st.shim_ps1, "missing");
  assert.equal(st.shim_bin, "patched");
});

test("桌面面：目录在但一个启动器都没有，仍然认这个目录（只看目录存在）", async () => {
  const env = stage({ installFiles: { "DeepSeek Harness.exe": "MZ", "resources/runtime/cli/bin/readme.txt": "x" } });
  assert.equal(core.findDesktopShimDir(), path.normalize(cliBinOf(env)));
  const st = await core.gatherState();
  assert.equal(st.shim_scope, "desktop-cli");
  assert.equal(st.shim_cmd, "missing");
  assert.equal(st.shim_ps1, "missing");
  assert.equal(st.shim_bin, "missing");
  assert.equal(env.home.length > 0, true);
});

test("桌面面：没有桌面树时回落到 PATH 上真正被调用的那套 shim", async () => {
  seq += 1;
  const plain = path.join(ROOT, `pathshim${seq}`);
  put(plain, { dsh: "#!/bin/sh\necho hi\n", "dsh.cmd": "@ECHO off\r\n", "dsh.ps1": "# hi\n" });
  stage({ install: false, path: plain });
  assert.equal(core.findDesktopShimDir(), null);
  const st = await core.gatherState();
  assert.equal(st.shim_scope, "path");
  assert.equal(st.shim_cmd, "original");
  assert.equal(st.shim_ps1, "original");
  assert.equal(st.shim_bin, "original");
});

test("桌面面：桌面树与 PATH 都没有启动器时，三件套全 missing、scope 为 none", async () => {
  stage({ install: false, path: EMPTY_PATH });
  assert.equal(core.findShimDir(), null);
  const st = await core.gatherState();
  assert.equal(st.shim_scope, "none");
  assert.equal(st.shim_cmd, "missing");
  assert.equal(st.shim_ps1, "missing");
  assert.equal(st.shim_bin, "missing");
});

test("desktop 面才去探 runtime 负载，web 面这一项是 null", async () => {
  stage();
  const desktopState = await core.gatherState();
  assert.notEqual(desktopState.runtime_payload, null);
  assert.deepEqual(
    Object.keys(desktopState.runtime_payload).sort(),
    ["missing", "ok", "resources", "runtime"],
  );
  stage({ surface: "web", install: false });
  const webState = await core.gatherState();
  assert.equal(webState.runtime_payload, null);
  assert.equal(webState.shim_scope, "none");
});

test("web 面：不看桌面树，直接从 PATH 上那套 shim 读三件套", async () => {
  seq += 1;
  const plain = path.join(ROOT, `webshim${seq}`);
  put(plain, { dsh: "#!/bin/sh\necho hi\n", "dsh.cmd": "@ECHO off\r\n", "dsh.ps1": "# hi\n" });
  stage({ surface: "web", install: false, path: plain });
  const st = await core.gatherState();
  assert.equal(st.shim_scope, "path");
  assert.equal(st.shim_cmd, "original");
  assert.equal(st.shim_ps1, "original");
  assert.equal(st.shim_bin, "original");
});

// ── 链式补丁：前驱没打上算待办，不算漂移 ───────────────────

const NOTHING = "// 一个什么都不包含的文件\n";
const own = (extra) => ({ id: 999, patterns: ["@@never-in-this-file@@"], replace: "R", ...extra });

test("链式补丁：没有 after 且一条 pattern 都不中 → drifted", () => {
  assert.equal(core.filePatchOutcome(NOTHING, own(), "lib/x.js"), "drifted");
});

test("链式补丁：前驱（#87）没打上 → pending 而不是 drifted", () => {
  assert.equal(core.filePatchOutcome(NOTHING, own({ after: [87] }), "lib/x.js"), "pending");
});

test("链式补丁：after 里混进非数字，只要还有一个合法 id 就照样算 pending", () => {
  const patch = own({ after: ["87", "x", null, 88] });
  assert.equal(core.filePatchOutcome(NOTHING, patch, "lib/x.js"), "pending");
});

test("链式补丁：after 里全是非数字 → 过滤后为空，回到 drifted", () => {
  const patch = own({ after: ["x", null, "not-a-number"] });
  assert.equal(core.filePatchOutcome(NOTHING, patch, "lib/x.js"), "drifted");
});

test("链式补丁：after 指向注册表里不存在的 id → 跳过它，回到 drifted", () => {
  assert.equal(core.filePatchOutcome(NOTHING, own({ after: [999999] }), "lib/x.js"), "drifted");
});

test("链式补丁：after 写成字符串而不是数组 → 当作没有前驱", () => {
  assert.equal(core.filePatchOutcome(NOTHING, own({ after: "87" }), "lib/x.js"), "drifted");
});

test("链式补丁：前驱已经打上时，不再拦成 pending", () => {
  const dep = core.ALL_PATCHES.find((p) => p.id === 88);
  assert.ok(dep && Array.isArray(dep.markers) && dep.markers.length > 0);
  const settledDep = dep.markers.map((m) => String(m)).join("\n");
  assert.equal(core.filePatchOutcome(settledDep, own({ after: [88] }), "lib/x.js"), "drifted");
});

test("链式补丁：after 写成单个数字而不是数组 → 当作没有前驱", () => {
  assert.equal(core.filePatchOutcome(NOTHING, own({ after: 87 }), "lib/x.js"), "drifted");
});

test("链式补丁：after 里写了字符串 id，也要归一成数字再比对", () => {
  assert.equal(core.filePatchOutcome(NOTHING, own({ after: ["87"] }), "lib/x.js"), "pending");
});

test("链式补丁：重复值不影响判定（去重后仍 pending）", () => {
  assert.equal(core.filePatchOutcome(NOTHING, own({ after: [87, 87] }), "lib/x.js"), "pending");
});

// ── 折叠块重排：段落之间的空行必须留着 ───────────────────

test("折叠块：丢掉可丢弃段落后，保留下来的两段之间仍是空行", () => {
  const yaml = [
    "systemPrompt:",
    "  persona: >",
    "    Keep A line one.",
    "",
    "    You are a coding agent powered by DeepSeek.",
    "",
    "    Keep B line one.",
    "  other: 1",
  ].join("\n");
  assert.equal(
    core.sanitizeYamlPersonaScalars(yaml),
    [
      "systemPrompt:",
      "  persona: |-",
      "    Keep A line one.",
      "",
      "    Keep B line one.",
      "  other: 1",
    ].join("\n"),
  );
});

test("折叠块：没有可丢弃段落时一个字节都不动（`>` 不会被改成 `|-`）", () => {
  const yaml = ["systemPrompt:", "  persona: >", "    Keep A.", "", "    Keep B."].join("\n");
  assert.equal(core.sanitizeYamlPersonaScalars(yaml), yaml);
});

test("折叠块：全都可丢弃时收成一个空字符串标量", () => {
  const yaml = ["systemPrompt:", "  text: >", "    You are a coding agent powered by DeepSeek.", "  next: 1"].join("\n");
  assert.equal(
    core.sanitizeYamlPersonaScalars(yaml),
    ["systemPrompt:", '  text: ""', "  next: 1"].join("\n"),
  );
});

test("源码形状：桌面 shim 只在 desktop 面解析，且两种来源各自带 scope 标记", () => {
  assert.match(SRC, /if \(adapterFor\(detectSurface\(\)\) === "desktop"\) \{\r?\n {4}const desktopShim = findDesktopShimDir\(\);/);
  assert.ok(SRC.includes('shim_scope = "desktop-cli";'));
  assert.match(SRC, /shim_scope = "path";\r?\n {6}shim_cmd = shimFileStatus\(path\.join\(shimDir, "dsh\.cmd"\)\);/);
  assert.ok(SRC.includes('if (shim_bin === "original" && desktop.desktopCliEntryPatched(path.join(desktopShim, "dsh"))) shim_bin = "patched";'));
});
