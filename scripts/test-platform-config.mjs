// 红队平台适配配置的测试。
//
// 这个模块决定「哪个工具用哪个可执行文件」与「环境适配算不算就绪」。坏法都很安静：
//   · 解析顺序错了 → 用户明明装了 nmap，面板显示未找到，红队会话直接不给开；
//   · httpx 的 Python 陷阱没挡住 → 把 Kali 的 /usr/bin/httpx（Python 小工具）当成扫描器，
//     扫描类技能全跑空，报错信息里只有「没有输出」；
//   · envAdaptStatus 判宽了 → 一个工具都没有也显示就绪，技能跑到一半才发现缺 nmap；
//   · savePlatformConfig 丢字段 → 用户填的路径下次打开面板就没了。
//
// 全部用真临时目录（findInDir / scanFolderForTools 都是真 fs），不 mock 文件系统。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import platformConfig, {
  TOOL_CATALOG,
  assignToolkitFolder,
  configPathOf,
  defaultToolkitDir,
  detectKali,
  envAdaptStatus,
  loadPlatformConfig,
  markEnvAdaptSkip,
  mergeConfigEnv,
  nucleiTemplatesDirOf,
  platformSummary,
  redteamRoot,
  resolveAllTools,
  resolveTool,
  savePlatformConfig,
  scanFolderForTools,
  toolkitDirOf,
} from "../lib/redteam/platform-config.js";

const created = [];
function tmp(tag = "x") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-purge-pcfg-${tag}-`));
  created.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略：Windows 上目录被占用时静默残留，不影响后续断言 */
    }
  }
});

/** 造文件，返回绝对路径。 */
function w(root, rel, content = "") {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/** 临时把 DSH_HOME 指到空目录。 */
function withDshHome(fn) {
  const prev = process.env.DSH_HOME;
  const home = tmp("home");
  process.env.DSH_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
}

/**
 * 临时改 process.platform。os.platform() 内部读的就是它，所以 detectKali 也会跟着变。
 * CI 跑 ubuntu-latest、开发机是 Windows，两侧都要能过。
 */
function withPlatform(value, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true, enumerable: desc.enumerable });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", desc);
  }
}

/** 临时把 PATH 换成一个目录（envAdaptStatus 不接受注入 env，只能动 process.env）。 */
function withPath(dir, fn) {
  // 注意：Windows 上 process.env 是大小写不敏感的，PATH 与 Path 是同一个变量。
  // 设完 PATH 再 delete Path 会把 PATH 自己删掉（envAdaptStatus 那两条曾因此假红）。
  const prev = process.env.PATH;
  process.env.PATH = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  }
}

// ---------------------------------------------------------------- 路径与根

test("configPathOf 用 root，redteamRoot 用 DSH_HOME", () => {
  assert.equal(configPathOf("/x/rt"), path.join("/x/rt", "config.json"));
  withDshHome((home) => {
    assert.equal(redteamRoot(), path.join(home, "redteam"));
    assert.equal(configPathOf(), path.join(home, "redteam", "config.json"));
    assert.equal(defaultToolkitDir(), path.join(home, "redteam", "toolkit"));
  });
});

test("没有 DSH_HOME 时 redteamRoot 退到 ~/.dsh/redteam", () => {
  const prev = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  try {
    assert.equal(redteamRoot(), path.join(os.homedir(), ".dsh", "redteam"));
  } finally {
    if (prev !== undefined) process.env.DSH_HOME = prev;
  }
});

test("TOOL_CATALOG 的 id 唯一，默认导出把 15 个入口都列了", () => {
  const ids = TOOL_CATALOG.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(platformConfig.TOOL_CATALOG, TOOL_CATALOG);
  for (const key of [
    "configPathOf",
    "redteamRoot",
    "loadPlatformConfig",
    "savePlatformConfig",
    "resolveTool",
    "resolveAllTools",
    "platformSummary",
    "mergeConfigEnv",
    "toolkitDirOf",
    "nucleiTemplatesDirOf",
    "detectKali",
    "scanFolderForTools",
    "assignToolkitFolder",
    "envAdaptStatus",
    "markEnvAdaptSkip",
  ]) {
    assert.equal(typeof platformConfig[key], "function", `默认导出缺 ${key}`);
  }
});

test("httpx 的 Python 陷阱配置还在（rejectPython + 两条发行版别名）", () => {
  const httpx = TOOL_CATALOG.find((t) => t.id === "httpx");
  assert.equal(httpx.rejectPython, true);
  assert.deepEqual(
    httpx.adapt.map((r) => String(r)),
    ["/^httpx-toolkit$/", "/^pd-httpx$/", "/^httpx$/"],
  );
  const impacket = TOOL_CATALOG.find((t) => t.id === "impacket");
  assert.equal(impacket.adapt.length, 2);
});

// ---------------------------------------------------------------- load

test("配置文件不存在时返回默认值并标 exists:false", () => {
  const root = tmp("load1");
  const cfg = loadPlatformConfig(root);
  assert.equal(cfg.exists, false);
  assert.equal(cfg.path, path.join(root, "config.json"));
  assert.equal(cfg.platform, "auto");
  assert.equal(cfg.toolkitDir, "");
  assert.deepEqual(cfg.binDirs, []);
  assert.equal(cfg.envAdaptSkip, false);
  assert.equal(cfg.envAdaptConfigured, false);
  assert.equal(cfg.updated_at, null);
  for (const t of TOOL_CATALOG) assert.equal(cfg.tools[t.id], "", `${t.id} 默认应为空串`);
  assert.deepEqual(Object.keys(cfg.env).sort(), ["FOFA_KEY", "REDTEAM_VPS_HOST", "REDTEAM_VPS_KEY"]);
});

test("坏 JSON 不抛，返回默认值 + exists:true + error", () => {
  const root = tmp("load2");
  fs.writeFileSync(path.join(root, "config.json"), "{ 这不是 json");
  const cfg = loadPlatformConfig(root);
  assert.equal(cfg.exists, true);
  assert.equal(cfg.platform, "auto");
  assert.match(cfg.error, /JSON/);
});

test("load 会校验字段：非法 platform 回落 auto，binDirs 去空、字符串 trim", () => {
  const root = tmp("load3");
  fs.writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({
      version: "7",
      platform: "solaris",
      toolkitDir: "  /opt/tools  ",
      nucleiTemplatesDir: "  /opt/nuclei  ",
      binDirs: ["  /a  ", "", null, 3, "   "],
      tools: { nmap: "  /usr/bin/nmap  " },
      env: { FOFA_KEY: "k" },
      notes: 42,
      envAdaptSkip: 1,
      updated_at: "2020-01-01T00:00:00.000Z",
    }),
  );
  const cfg = loadPlatformConfig(root);
  assert.equal(cfg.version, 7);
  assert.equal(cfg.platform, "auto");
  assert.equal(cfg.toolkitDir, "/opt/tools");
  assert.equal(cfg.nucleiTemplatesDir, "/opt/nuclei");
  assert.deepEqual(cfg.binDirs, ["/a", "3"]);
  assert.equal(cfg.tools.nmap, "  /usr/bin/nmap  ", "load 不 trim tools 值，交给 save/使用时处理");
  // 没在文件里出现的 id 必须被 base.tools 补齐成空串，否则面板会渲染出 undefined。
  for (const t of TOOL_CATALOG) {
    if (t.id === "nmap") continue;
    assert.equal(cfg.tools[t.id], "", `${t.id} 应被补成空串`);
  }
  assert.equal(cfg.env.FOFA_KEY, "k");
  assert.equal(cfg.notes, "", "非字符串 notes 回落空串");
  assert.equal(cfg.envAdaptSkip, true);
  assert.equal(cfg.updated_at, "2020-01-01T00:00:00.000Z");
});

test("load 保留三个合法 platform 值", () => {
  const root = tmp("load4");
  for (const value of ["auto", "windows", "linux"]) {
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ platform: value }));
    assert.equal(loadPlatformConfig(root).platform, value);
  }
});

// ---------------------------------------------------------------- save

test("save 会建目录、补齐 catalog 全部键、trim 工具路径", () => {
  const root = path.join(tmp("save1"), "redteam");
  const cfg = savePlatformConfig({ tools: { nmap: "  /usr/bin/nmap  " } }, root);
  assert.equal(cfg.exists, true);
  assert.equal(cfg.tools.nmap, "/usr/bin/nmap");
  for (const t of TOOL_CATALOG) assert.equal(typeof cfg.tools[t.id], "string", `${t.id} 应补成字符串`);
  assert.match(fs.readFileSync(path.join(root, "config.json"), "utf8"), /^\{\n  "version": 1,/);
});

test("save 是增量合并：没给的字段保留旧值", () => {
  const root = tmp("save2");
  savePlatformConfig({ platform: "windows", toolkitDir: "/opt/tk", binDirs: ["/a"], notes: "第一版" }, root);
  const cfg = savePlatformConfig({ notes: "第二版" }, root);
  assert.equal(cfg.platform, "windows");
  assert.equal(cfg.toolkitDir, "/opt/tk");
  assert.deepEqual(cfg.binDirs, ["/a"]);
  assert.equal(cfg.notes, "第二版");
});

test("save 的 platform 非法值时保留旧值，不回落 auto", () => {
  const root = tmp("save3");
  savePlatformConfig({ platform: "linux" }, root);
  const cfg = savePlatformConfig({ platform: "beos" }, root);
  assert.equal(cfg.platform, "linux");
});

test("save 的 binDirs 传非数组时保留旧值，传数组时空项被丢掉", () => {
  const root = tmp("save4");
  savePlatformConfig({ binDirs: ["/a", "/b"] }, root);
  assert.deepEqual(savePlatformConfig({ binDirs: "不是数组" }, root).binDirs, ["/a", "/b"]);
  assert.deepEqual(savePlatformConfig({ binDirs: ["  /c  ", "", null] }, root).binDirs, ["/c"]);
  // 落盘那份才是真相：返回值的 binDirs 会被 save 末尾的 loadPlatformConfig 再过滤一遍，
  // 只断言返回值的话「save 自己不去空」这个改动测不出来。
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  assert.deepEqual(onDisk.binDirs, ["/c"]);
});

test("save 的两个布尔开关只在显式给出时改", () => {
  const root = tmp("save5");
  savePlatformConfig({ envAdaptSkip: true, envAdaptConfigured: true }, root);
  const kept = savePlatformConfig({ notes: "x" }, root);
  assert.equal(kept.envAdaptSkip, true);
  assert.equal(kept.envAdaptConfigured, true);
  const off = savePlatformConfig({ envAdaptSkip: false }, root);
  assert.equal(off.envAdaptSkip, false);
  assert.equal(off.envAdaptConfigured, true);
});

test("save 每次刷新 updated_at", () => {
  const root = tmp("save6");
  savePlatformConfig({ notes: "a" }, root);
  const fp = path.join(root, "config.json");
  const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
  raw.updated_at = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(fp, JSON.stringify(raw));
  const cfg = savePlatformConfig({ notes: "b" }, root);
  assert.notEqual(cfg.updated_at, "2000-01-01T00:00:00.000Z");
  assert.match(cfg.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("save 的 env 也是增量合并，空串不覆盖已有值", () => {
  const root = tmp("save7");
  savePlatformConfig({ env: { FOFA_KEY: "k1", REDTEAM_VPS_HOST: "h" } }, root);
  const cfg = savePlatformConfig({ env: { FOFA_KEY: "" } }, root);
  assert.equal(cfg.env.FOFA_KEY, "");
  assert.equal(cfg.env.REDTEAM_VPS_HOST, "h");
});

// ---------------------------------------------------------------- 目录解析

test("toolkitDirOf 用配置值，没有就用默认 toolkit", () => {
  const root = tmp("tk1");
  assert.equal(toolkitDirOf({ toolkitDir: "" }, root), path.join(root, "toolkit"));
  assert.equal(toolkitDirOf({ toolkitDir: "/opt/mytk" }, root), path.resolve("/opt/mytk"));
});

test("nucleiTemplatesDirOf 只在目录真的存在时返回", () => {
  const root = tmp("nt1");
  assert.equal(nucleiTemplatesDirOf({ nucleiTemplatesDir: path.join(root, "没有") }, root), null);
  const real = path.join(root, "tpl");
  fs.mkdirSync(real);
  assert.equal(nucleiTemplatesDirOf({ nucleiTemplatesDir: real }, root), path.resolve(real));
  assert.equal(nucleiTemplatesDirOf({ nucleiTemplatesDir: "" }, root), null);
});

// ---------------------------------------------------------------- mergeConfigEnv

test("mergeConfigEnv 不覆盖已有非空值，空串会被配置值填上", () => {
  const out = mergeConfigEnv({ A: "进程值", B: "", C: undefined }, { env: { A: "配置值", B: "配置B", C: "配置C", D: "配置D" } });
  assert.equal(out.A, "进程值");
  assert.equal(out.B, "配置B");
  assert.equal(out.C, "配置C");
  assert.equal(out.D, "配置D");
});

test("mergeConfigEnv 忽略非字符串与空白配置值，且不修改入参", () => {
  const base = { A: "1" };
  const out = mergeConfigEnv(base, { env: { B: 42, C: "   ", D: "ok" } });
  assert.deepEqual(base, { A: "1" });
  assert.equal(out.B, undefined);
  assert.equal(out.C, undefined);
  assert.equal(out.D, "ok");
});

test("mergeConfigEnv 容忍 cfg 为空", () => {
  assert.deepEqual(mergeConfigEnv({ A: "1" }), { A: "1" });
  assert.deepEqual(mergeConfigEnv(undefined, null), {});
});

// ---------------------------------------------------------------- resolveTool

test("resolveTool 认不出的 id 直接 missing，label 就是 id", () => {
  const r = resolveTool("no-such-tool", { root: tmp("rt1"), config: loadPlatformConfig(tmp("rt1b")) });
  assert.deepEqual(r, { id: "no-such-tool", label: "no-such-tool", path: null, source: "missing", names: [] });
});

test("resolveTool 优先用配置里的绝对路径", () => {
  const root = tmp("rt2");
  const bin = w(root, "bin/nmap.exe", "MZ");
  const cfg = loadPlatformConfig(root);
  cfg.tools.nmap = bin;
  const r = resolveTool("nmap", { root, config: cfg });
  assert.equal(r.source, "config");
  assert.equal(r.path, bin);
  assert.equal(r.label, "Nmap");
});

test("resolveTool 配置了但文件不存在时 missing，并说明是哪个路径", () => {
  const root = tmp("rt3");
  const cfg = loadPlatformConfig(root);
  const missingPath = path.join(root, "bin", "nmap.exe");
  cfg.tools.nmap = missingPath;
  const r = resolveTool("nmap", { root, config: cfg });
  assert.equal(r.source, "missing");
  assert.equal(r.path, null);
  assert.equal(r.configured, missingPath);
  assert.equal(r.note, "已配置的路径不存在： " + missingPath);
});

test("resolveTool 配置里是相对路径时按 cwd 解析", () => {
  const root = tmp("rt4");
  const cfg = loadPlatformConfig(root);
  cfg.tools.nmap = "no-such-relative-nmap";
  const r = resolveTool("nmap", { root, config: cfg });
  assert.equal(r.source, "missing");
  assert.equal(r.configured, path.resolve("no-such-relative-nmap"));
});

test("resolveTool 依次试 toolkit → binDirs → PATH", () => {
  const root = tmp("rt5");
  const tk = path.join(root, "toolkit");
  w(tk, "ffuf.exe", "MZ");
  const binDir = path.join(root, "extra");
  w(binDir, "masscan", "#!/bin/sh");
  const pathDir = path.join(root, "onpath");
  w(pathDir, "chisel", "#!/bin/sh");
  const cfg = loadPlatformConfig(root);
  cfg.toolkitDir = tk;
  cfg.binDirs = [binDir];
  const env = { PATH: pathDir };

  assert.deepEqual(
    [resolveTool("ffuf", { root, config: cfg, env }).source, resolveTool("masscan", { root, config: cfg, env }).source, resolveTool("chisel", { root, config: cfg, env }).source],
    ["toolkit", "binDir", "path"],
  );
  assert.equal(resolveTool("masscan", { root, config: cfg, env }).binDir, binDir);
  assert.equal(resolveTool("nmap", { root, config: cfg, env }).source, "missing");
});

test("resolveTool 会往 bin/Bins/tools/Tools 子目录里再找一层", () => {
  const root = tmp("rt6");
  const tk = path.join(root, "toolkit");
  w(tk, "bin/gogo.exe", "MZ");
  const cfg = loadPlatformConfig(root);
  cfg.toolkitDir = tk;
  const r = resolveTool("gogo", { root, config: cfg, env: { PATH: "" } });
  assert.equal(r.source, "toolkit");
  assert.equal(r.path, path.join(tk, "bin", "gogo.exe"));
});

test("resolveTool 在 Windows 模式下不走 Linux 兜底目录", () => {
  const root = tmp("rt7");
  const home = tmp("rt7home");
  w(home, "go/bin/nmap", "#!/bin/sh");
  const cfg = loadPlatformConfig(root);
  cfg.platform = "windows";
  const r = resolveTool("nmap", { root, config: cfg, env: { HOME: home, PATH: "" } });
  assert.equal(r.source, "missing");
});

test("resolveTool 在 Linux 模式下会补 ~/go/bin、~/.local/bin、~/.pdtm/go/bin", () => {
  const root = tmp("rt8");
  const home = tmp("rt8home");
  w(home, "go/bin/nmap", "#!/bin/sh");
  w(home, ".local/bin/ffuf", "#!/bin/sh");
  w(home, ".pdtm/go/bin/subfinder", "#!/bin/sh");
  const cfg = loadPlatformConfig(root);
  cfg.platform = "linux";
  const env = { HOME: home, PATH: "" };
  assert.equal(resolveTool("nmap", { root, config: cfg, env }).source, "path");
  assert.equal(resolveTool("ffuf", { root, config: cfg, env }).path, path.join(home, ".local", "bin", "ffuf"));
  assert.equal(resolveTool("subfinder", { root, config: cfg, env }).path, path.join(home, ".pdtm", "go", "bin", "subfinder"));
});

test("resolveTool 跳过多层目录里的同名目录（只认文件）", () => {
  const root = tmp("rt9");
  const tk = path.join(root, "toolkit");
  fs.mkdirSync(path.join(tk, "nmap.exe"), { recursive: true });
  const cfg = loadPlatformConfig(root);
  cfg.toolkitDir = tk;
  assert.equal(resolveTool("nmap", { root, config: cfg, env: { PATH: "" } }).source, "missing");
});

test("resolveTool 挡住 Python 版 httpx，但认得发行版别名 httpx-toolkit", () => {
  const root = tmp("rt10");
  const tk = path.join(root, "toolkit");
  w(tk, "httpx", "#!/usr/bin/env python3\nprint(1)\n");
  const cfg = loadPlatformConfig(root);
  cfg.toolkitDir = tk;
  const env = { PATH: "" };
  assert.equal(resolveTool("httpx", { root, config: cfg, env }).source, "missing", "Python 版必须被跳过");

  w(tk, "httpx-toolkit", "#!/bin/sh\n");
  const hit = resolveTool("httpx", { root, config: cfg, env });
  assert.equal(hit.source, "toolkit");
  assert.equal(path.basename(hit.path), "httpx-toolkit");
});

test("adapt 里的发行版别名都在 names 里登记过（两条清单不许各说各话）", () => {
  // adapt 是「发行版常见别名」的兜底：findInDir 先按 names 精确找，找不到才用 adapt
  // 在这一层目录里按小写名对。若 adapt 里出现 names 没登记的名字，就是两份清单漂了。
  for (const def of TOOL_CATALOG) {
    if (!def.adapt) continue;
    const lower = def.names.map((n) => String(n).toLowerCase());
    for (const pattern of def.adapt) {
      assert.equal(pattern.source.startsWith("^"), true, `${def.id} 的 adapt 必须锚定开头`);
      const sample = pattern.source.replace(/^\^/, "").replace(/\$/, "").replace(/\\\./g, ".");
      assert.ok(
        lower.some((n) => pattern.test(n)),
        `${def.id} 的 adapt ${pattern} 匹配不到任何登记过的名字（样例 ${sample}）`,
      );
    }
  }
});

test("resolveAllTools 覆盖整个 catalog，顺序与 TOOL_CATALOG 一致", () => {
  const root = tmp("rt12");
  const all = resolveAllTools({ root, config: loadPlatformConfig(root), env: { PATH: "" } });
  assert.equal(all.length, TOOL_CATALOG.length);
  assert.deepEqual(all.map((t) => t.id), TOOL_CATALOG.map((t) => t.id));
});

// ---------------------------------------------------------------- scanFolderForTools

test("scanFolderForTools：目录不存在、不是目录都有明确错误", () => {
  const root = tmp("sc1");
  const missing = scanFolderForTools(path.join(root, "没有这个目录"));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /^文件夹不存在： /);
  assert.deepEqual(missing.assigned, {});

  const file = w(root, "single.txt", "x");
  const notDir = scanFolderForTools(file);
  assert.equal(notDir.ok, false);
  assert.match(notDir.error, /^Not a folder: /);
});

test("scanFolderForTools 递归找到工具，跳过隐藏目录 / node_modules / .git", () => {
  const root = tmp("sc2");
  w(root, "nmap.exe", "MZ");
  w(root, "linux/ffuf", "#!/bin/sh");
  w(root, "linux/deep/chisel.exe", "MZ");
  w(root, ".git/nuclei", "x");
  w(root, "node_modules/fscan.exe", "x");
  w(root, ".hidden/subfinder", "x");
  const scan = scanFolderForTools(root);
  assert.equal(scan.ok, true);
  assert.equal(scan.assigned.nmap, path.join(root, "nmap.exe"));
  assert.equal(scan.assigned.ffuf, path.join(root, "linux", "ffuf"));
  assert.equal(scan.assigned.chisel, path.join(root, "linux", "deep", "chisel.exe"));
  assert.equal(scan.assigned.nuclei, undefined);
  assert.equal(scan.assigned.fscan, undefined);
  assert.equal(scan.assigned.subfinder, undefined);
  assert.equal(scan.assignedCount, 3);
});

test("scanFolderForTools 同名多份时按 catalog 的 names 顺序取排名靠前的", () => {
  // 先扫到排名低的，后扫到排名高的 → 后者覆盖前者，hits 记两次。
  const root = tmp("sc3");
  w(root, "a/nmap", "#!/bin/sh");
  w(root, "b/nmap.exe", "MZ");
  const scan = scanFolderForTools(root);
  assert.equal(path.basename(scan.assigned.nmap), "nmap.exe", "names 里 nmap.exe 排在 nmap 前面");
  assert.equal(scan.hits.filter((h) => h.id === "nmap").length, 2);

  // 反过来（先高后低）不再覆盖，hits 只记一次 —— 少记一次不是 bug，是「没改写就不报」。
  const root2 = tmp("sc3b");
  w(root2, "a/nmap.exe", "MZ");
  w(root2, "b/nmap", "#!/bin/sh");
  const scan2 = scanFolderForTools(root2);
  assert.equal(path.basename(scan2.assigned.nmap), "nmap.exe");
  assert.equal(scan2.hits.filter((h) => h.id === "nmap").length, 1);
});

test("scanFolderForTools 的 maxDepth 默认 4；传 0 也是 4（现状锁定），传 1 才真的只扫一层", () => {
  const root = tmp("sc4");
  w(root, "a/b/c/d/nmap.exe", "MZ");
  w(root, "a/ffuf", "#!/bin/sh");
  assert.equal(scanFolderForTools(root).assigned.nmap, path.join(root, "a", "b", "c", "d", "nmap.exe"));
  // 现状锁定：Math.max(Number(options.maxDepth) || 4, 1) —— 0 是 falsy，走默认 4，不是被夹到 1。
  assert.equal(
    scanFolderForTools(root, { maxDepth: 0 }).assigned.nmap,
    path.join(root, "a", "b", "c", "d", "nmap.exe"),
  );
  const shallow = scanFolderForTools(root, { maxDepth: 1 });
  assert.equal(shallow.assigned.nmap, undefined, "depth 1 只扫到 a/，第 4 层进不去");
  assert.equal(shallow.assigned.ffuf, path.join(root, "a", "ffuf"));
});

test("scanFolderForTools 的 maxFiles 默认 8000，传 1 被夹到 100", () => {
  const root = tmp("sc5");
  for (let i = 0; i < 130; i += 1) w(root, `f/${String(i).padStart(3, "0")}.txt`, "x");
  w(root, "f/zzz-nmap-placeholder.txt", "x");
  const scan = scanFolderForTools(root, { maxFiles: 1 });
  assert.equal(scan.scanned, 100);
});

test("scanFolderForTools 顺手认 nuclei-templates（两种布局）", () => {
  const a = tmp("sc6a");
  fs.mkdirSync(path.join(a, "nuclei-templates"));
  assert.equal(scanFolderForTools(a).nucleiTemplatesDir, path.join(a, "nuclei-templates"));

  const b = tmp("sc6b");
  fs.mkdirSync(path.join(b, "nuclei", "templates"), { recursive: true });
  assert.equal(scanFolderForTools(b).nucleiTemplatesDir, path.join(b, "nuclei", "templates"));

  const c = tmp("sc6c");
  w(c, "nuclei-templates", "这是文件不是目录");
  assert.equal(scanFolderForTools(c).nucleiTemplatesDir, "");
});

test(
  "adaptInDir 匹配时把文件名转小写（Windows 上测不到，靠 CI 的 Linux 跑）",
  { skip: process.platform === "win32" ? "Windows 文件系统大小写不敏感，names 的精确匹配先命中" : false },
  () => {
    const root = tmp("rt11");
    const tk = path.join(root, "toolkit");
    w(tk, "HTTPX-ToolKit", "#!/bin/sh\n");
    const cfg = loadPlatformConfig(root);
    cfg.toolkitDir = tk;
    const r = resolveTool("httpx", { root, config: cfg, env: { PATH: "" } });
    assert.equal(r.source, "toolkit");
    assert.equal(path.basename(r.path), "HTTPX-ToolKit");
  },
);

test("adaptInDir 的小写归一化在源码里还在（Windows 上只能这么钉）", () => {
  // 上面那条用例在 Windows 上被跳过，所以本地 RED 演练抓不到「删掉 toLowerCase」。
  // 这里钉住那一行的形状：删掉 .toLowerCase() 会让这条立刻红。
  const src = fs.readFileSync(new URL("../lib/redteam/platform-config.js", import.meta.url), "utf8");
  assert.match(src, /if \(!pattern\.test\(String\(name\)\.toLowerCase\(\)\)\) continue/);
});

test("adaptInDir 只认文件：同名目录不会被当成工具", () => {
  const root = tmp("rt13");
  const tk = path.join(root, "toolkit");
  fs.mkdirSync(path.join(tk, "httpx-toolkit"), { recursive: true });
  const cfg = loadPlatformConfig(root);
  cfg.toolkitDir = tk;
  const r = resolveTool("httpx", { root, config: cfg, env: { PATH: "" } });
  assert.equal(r.source, "missing", "目录不是可执行文件");
  assert.equal(r.path, null);
});

test("scanFolderForTools 跳过 Python 版 httpx", () => {
  const root = tmp("sc7");
  w(root, "httpx", "#!/usr/bin/env python3\n");
  w(root, "httpx-toolkit", "#!/bin/sh\n");
  const scan = scanFolderForTools(root);
  assert.equal(path.basename(scan.assigned.httpx), "httpx-toolkit");
});

// ---------------------------------------------------------------- assignToolkitFolder

test("assignToolkitFolder 写 toolkitDir、binDirs 头插、tools 路径，并标记已配置", () => {
  const root = tmp("as1");
  const tk = path.join(root, "pack");
  w(tk, "nmap.exe", "MZ");
  w(tk, "nuclei-templates/http/cve.yaml", "id: cve");
  const out = assignToolkitFolder(tk, root);
  assert.equal(out.ok, true);
  assert.equal(out.assignedCount, 1);
  assert.equal(out.config.toolkitDir, path.resolve(tk));
  assert.deepEqual(out.config.binDirs, [path.resolve(tk)]);
  assert.equal(out.config.tools.nmap, path.join(tk, "nmap.exe"));
  assert.equal(out.config.envAdaptConfigured, true);
  assert.equal(out.config.envAdaptSkip, false);
  assert.equal(out.nucleiTemplatesDir, path.join(tk, "nuclei-templates"));
  assert.equal(out.config.nucleiTemplatesDir, path.join(tk, "nuclei-templates"));
});

test("assignToolkitFolder 新目录排在 binDirs 最前面（unshift 而不是 push）", () => {
  const root = tmp("as2b");
  const a = path.join(root, "pack-a");
  const b = path.join(root, "pack-b");
  w(a, "nmap.exe", "MZ");
  w(b, "ffuf.exe", "MZ");
  assignToolkitFolder(a, root);
  const out = assignToolkitFolder(b, root);
  assert.deepEqual(
    out.config.binDirs,
    [path.resolve(b), path.resolve(a)],
    "刚分配的目录必须排最前：查找时先看用户刚选的那份",
  );
  assert.equal(out.config.toolkitDir, path.resolve(b));
});

test("assignToolkitFolder 重复分配同一个目录时 binDirs 不重复", () => {
  const root = tmp("as2");
  const tk = path.join(root, "pack");
  w(tk, "nmap.exe", "MZ");
  assignToolkitFolder(tk, root);
  const out = assignToolkitFolder(tk, root);
  assert.equal(out.config.binDirs.length, 1);
});

test("assignToolkitFolder 扫描失败时原样透传 ok:false", () => {
  const root = tmp("as3");
  const out = assignToolkitFolder(path.join(root, "没有"), root);
  assert.equal(out.ok, false);
  assert.match(out.error, /^文件夹不存在： /);
});

// ---------------------------------------------------------------- envAdaptStatus

test("envAdaptStatus：什么都没有时 need-config，并给出下一步", () => {
  const root = tmp("ea1");
  const empty = path.join(root, "empty-path");
  fs.mkdirSync(empty);
  withPath(empty, () => {
    const st = envAdaptStatus(root);
    assert.equal(st.ready, false);
    assert.equal(st.reason, "need-config");
    assert.match(st.message, /环境适配/);
    assert.equal(st.total, TOOL_CATALOG.length);
    assert.deepEqual(st.foundIds, []);
    assert.equal(st.missingIds.length, TOOL_CATALOG.length);
    assert.equal(st.configured, false);
    assert.equal(st.skipped, false);
  });
});

test("envAdaptStatus：PATH 上找到两个以上工具就算就绪（tools-found）", () => {
  const root = tmp("ea2");
  const dir = path.join(root, "bin");
  w(dir, "nmap", "#!/bin/sh");
  w(dir, "ffuf", "#!/bin/sh");
  withPath(dir, () => {
    const st = envAdaptStatus(root);
    assert.equal(st.ready, true);
    assert.equal(st.reason, "tools-found");
    assert.equal(st.found, 2);
    assert.match(st.message, /本机已能找到 2 个工具/);
  });
});

test("envAdaptStatus：只找到一个工具还不算就绪", () => {
  const root = tmp("ea3");
  const dir = path.join(root, "bin");
  w(dir, "nmap", "#!/bin/sh");
  withPath(dir, () => {
    const st = envAdaptStatus(root);
    assert.equal(st.ready, false);
    assert.equal(st.reason, "need-config");
    assert.equal(st.found, 1);
  });
});

test("envAdaptStatus：记过路径就算 configured（工具一个都找不到也一样）", () => {
  const root = tmp("ea4");
  savePlatformConfig({ toolkitDir: path.join(root, "tk-not-there") }, root);
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  withPath(empty, () => {
    const st = envAdaptStatus(root);
    assert.equal(st.ready, true);
    assert.equal(st.reason, "configured");
    assert.equal(st.configured, true);
    assert.match(st.message, /更新插件不会要求重新配置/);
  });
});

test("envAdaptStatus：只有 binDirs 或只有单个工具路径也算 configured", () => {
  const empty = (root) => {
    const dir = path.join(root, "empty");
    fs.mkdirSync(dir);
    return dir;
  };
  const byBinDir = tmp("ea4b");
  savePlatformConfig({ binDirs: [path.join(byBinDir, "tk-not-there")] }, byBinDir);
  withPath(empty(byBinDir), () => {
    const st = envAdaptStatus(byBinDir);
    assert.equal(st.configured, true, "binDirs 非空应算已配置");
    assert.equal(st.reason, "configured");
  });

  const byTool = tmp("ea4c");
  savePlatformConfig({ tools: { nmap: path.join(byTool, "nmap.exe") } }, byTool);
  withPath(empty(byTool), () => {
    const st = envAdaptStatus(byTool);
    assert.equal(st.configured, true, "单个工具路径非空应算已配置");
    assert.equal(st.reason, "configured");
  });
});

test("envAdaptStatus：markEnvAdaptSkip 之后 skipped 就绪，可撤销", () => {
  const root = tmp("ea5");
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  withPath(empty, () => {
    const on = markEnvAdaptSkip(root);
    assert.equal(on.ready, true);
    assert.equal(on.reason, "skipped");
    assert.equal(on.skipped, true);
    const off = markEnvAdaptSkip(root, false);
    assert.equal(off.ready, false);
    assert.equal(off.reason, "need-config");
  });
});

test("envAdaptStatus：kali 分支与 detectKali 的结论一致", () => {
  const root = tmp("ea6");
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  withPath(empty, () => {
    const st = envAdaptStatus(root);
    const kali = detectKali();
    assert.equal(st.kali, kali.kali);
    assert.equal(st.reason === "kali", kali.kali);
    assert.equal(st.kaliSource, kali.source);
  });
});

// ---------------------------------------------------------------- detectKali

test("detectKali 在非 Linux 上直接说「非 Linux 宿主」", () => {
  const r = withPlatform("win32", () => detectKali());
  assert.deepEqual(r, { kali: false, source: null, detail: "非 Linux 宿主" });
});

test("detectKali 在 Linux 上要么给出依据，要么干净地说没有", () => {
  const r = withPlatform("linux", () => detectKali());
  assert.equal(typeof r.kali, "boolean");
  if (r.kali) {
    assert.ok(["os-release", "paths"].includes(r.source));
    assert.ok(r.detail);
  } else {
    assert.equal(r.source, null);
    assert.equal(r.detail, null);
  }
});

// ---------------------------------------------------------------- platformSummary

test("platformSummary 的形状：runtime / tools / adapt / egress", () => {
  const root = tmp("ps1");
  const pf = platformSummary(root);
  assert.equal(pf.ok, true);
  assert.equal(pf.runtime.nodePlatform, os.platform());
  assert.equal(pf.runtime.sep, path.sep);
  assert.equal(typeof pf.runtime.windows, "boolean");
  assert.equal(pf.runtime.effective, pf.runtime.windows ? "windows" : "linux");
  assert.equal(pf.tools.total, TOOL_CATALOG.length);
  assert.equal(pf.tools.found + pf.tools.missing, pf.tools.total);
  assert.equal(pf.tools.items.length, TOOL_CATALOG.length);
  assert.equal(pf.toolkitDir, path.join(root, "toolkit"));
  assert.equal(pf.toolkitExists, false);
  for (const key of ["http_proxy", "https_proxy", "all_proxy", "no_proxy", "note"]) {
    assert.equal(typeof pf.egress[key], "string", `egress.${key} 应为字符串`);
  }
  assert.equal(typeof pf.adapt.ready, "boolean");
});

test("platformSummary：nuclei 模板目录会从 toolkit/nuclei-templates 兜底", () => {
  const root = tmp("ps2");
  const tk = path.join(root, "toolkit");
  fs.mkdirSync(path.join(tk, "nuclei-templates"), { recursive: true });
  const pf = platformSummary(root);
  assert.equal(pf.nucleiTemplatesDir, path.join(tk, "nuclei-templates"));
  assert.equal(pf.toolkitExists, true);
});

test("platformSummary：hint 按 platform 配置分岔", () => {
  const root = tmp("ps3");
  savePlatformConfig({ platform: "windows" }, root);
  assert.match(platformSummary(root).hint, /(当前按 Windows 适配|已检测到 Kali)/);
  savePlatformConfig({ platform: "linux" }, root);
  assert.match(platformSummary(root).hint, /(当前按 Linux 适配|已检测到 Kali)/);
});
