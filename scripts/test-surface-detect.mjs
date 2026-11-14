import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "dshp-surface-detect-"));
const surface = await import("../lib/surface.js");
const SRC = readFileSync(new URL("../lib/surface.js", import.meta.url), "utf8");

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let seq = 0;
function box(tag) {
  seq += 1;
  const dir = path.join(ROOT, `${tag}-${seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 造一个「像桌面安装」的 resources 目录；kinds 决定里面放什么。 */
function resources(tag, kinds = []) {
  const dir = path.join(box(tag), "resources");
  mkdirSync(dir, { recursive: true });
  for (const kind of kinds) {
    if (kind === "asar") writeFileSync(path.join(dir, "app.asar"), "fake");
    if (kind === "app") mkdirSync(path.join(dir, "app", "dsh"), { recursive: true });
    if (kind === "unpacked") mkdirSync(path.join(dir, "app.asar.unpacked", "dsh"), { recursive: true });
  }
  return dir;
}

const NODE = { env: {}, execPath: "/usr/bin/node", versions: {} };

test("pathLooksDesktop：光有 harness 名字不算桌面安装", () => {
  assert.equal(surface.pathLooksDesktop("/home/u/code/deepseek-harness"), false);
  assert.equal(surface.pathLooksDesktop("/home/u/code/deepseek-harness/resources"), true);
  assert.equal(surface.pathLooksDesktop("C:\\Program Files\\DeepSeek Harness\\resources\\app"), true);
  assert.equal(surface.pathLooksDesktop("/Applications/DeepSeek Harness.app/Contents/Resources"), true);
});

test("pathLooksDesktop：空值与无关路径一律 false", () => {
  assert.equal(surface.pathLooksDesktop(""), false);
  assert.equal(surface.pathLooksDesktop(null), false);
  assert.equal(surface.pathLooksDesktop("/opt/other/x"), false);
});

test("pathLooksDesktop：四个 exe 与两个入口脚本名", () => {
  for (const p of ["/x/DSH Desktop.exe", "/x/DSH Next.exe", "/x/DeepSeek Harness.exe", "/x/deepseek-harness.exe"]) {
    assert.equal(surface.pathLooksDesktop(p), true, p);
  }
  assert.equal(surface.pathLooksDesktop("/opt/x/host-process-entry.js"), true);
  assert.equal(surface.pathLooksDesktop("/opt/x/desktop-cli.js"), true);
});

test("resourcesLookLikeDesktopInstall：不叫 harness 的目录靠 app.asar 判定", () => {
  const withAsar = resources("asar", ["asar"]);
  assert.equal(
    surface.isCommunityElectronHost({ ...NODE, resourcesPath: withAsar, versions: { electron: "30.0.0" } }),
    true,
  );
});

test("resourcesLookLikeDesktopInstall：app/dsh 目录也算桌面安装", () => {
  const withApp = resources("app", ["app"]);
  assert.equal(
    surface.isCommunityElectronHost({ ...NODE, resourcesPath: withApp, versions: { electron: "30.0.0" } }),
    true,
  );
});

test("resourcesLookLikeDesktopInstall：app.asar.unpacked/dsh 也算", () => {
  const withUnpacked = resources("unpacked", ["unpacked"]);
  assert.equal(
    surface.isCommunityElectronHost({ ...NODE, resourcesPath: withUnpacked, versions: { electron: "30.0.0" } }),
    true,
  );
});

test("resourcesLookLikeDesktopInstall：目录名不是以 resources 结尾时，里面的东西一律不看", () => {
  const dir = path.join(box("notres"), "resourcesx");
  mkdirSync(path.join(dir, "app", "dsh"), { recursive: true });
  assert.equal(
    surface.isCommunityElectronHost({ ...NODE, resourcesPath: dir, versions: { electron: "30.0.0" } }),
    false,
  );
});

test("resourcesLookLikeDesktopInstall：空的 resources 目录不算（三条真判据都不成立）", () => {
  const empty = resources("empty");
  assert.equal(
    surface.isCommunityElectronHost({ ...NODE, resourcesPath: empty, versions: { electron: "30.0.0" } }),
    false,
  );
});

test("resourcesLookLikeDesktopInstall：只有 app/ 没有 app/dsh 不算", () => {
  const dir = path.join(box("app-only"), "resources");
  mkdirSync(path.join(dir, "app"), { recursive: true });
  assert.equal(
    surface.isCommunityElectronHost({ ...NODE, resourcesPath: dir, versions: { electron: "30.0.0" } }),
    false,
  );
});

test("resourcesLookLikeDesktopInstall：只有 app.asar.unpacked/ 没有里面的 dsh 不算", () => {
  const dir = path.join(box("unpacked-only"), "resources");
  mkdirSync(path.join(dir, "app.asar.unpacked"), { recursive: true });
  assert.equal(
    surface.isCommunityElectronHost({ ...NODE, resourcesPath: dir, versions: { electron: "30.0.0" } }),
    false,
  );
});

test("resourcesLookLikeDesktopInstall：路径本身像桌面安装就直接认，不看里面有什么", () => {
  const dir = path.join(box("looks-desktop"), "DeepSeek Harness", "resources");
  mkdirSync(dir, { recursive: true });
  assert.equal(
    surface.isCommunityElectronHost({ ...NODE, resourcesPath: dir, versions: { electron: "30.0.0" } }),
    true,
  );
});

test("resourcesLookLikeDesktopInstall：app.asar 是目录不算（要求是文件）", () => {
  const dir = path.join(box("asar-dir"), "resources");
  mkdirSync(path.join(dir, "app.asar"), { recursive: true });
  assert.equal(
    surface.isCommunityElectronHost({ ...NODE, resourcesPath: dir, versions: { electron: "30.0.0" } }),
    false,
  );
});

test("resourcesLookLikeDesktopInstall：statSync 抛错时整段吞掉并回 false", async () => {
  const dir = resources("stat-throws", ["asar"]);
  const { createRequire } = await import("node:module");
  const { syncBuiltinESMExports } = await import("node:module");
  const cjsFs = createRequire(import.meta.url)("node:fs");
  const realStat = cjsFs.statSync;
  cjsFs.statSync = () => {
    throw new Error("stat boom");
  };
  syncBuiltinESMExports();
  try {
    assert.equal(
      surface.isCommunityElectronHost({ ...NODE, resourcesPath: dir, versions: { electron: "30.0.0" } }),
      false,
    );
  } finally {
    cjsFs.statSync = realStat;
    syncBuiltinESMExports();
  }
});

test("isCommunityElectronHost：没有 electron 版本号就不看 resourcesPath", () => {
  const withAsar = resources("noelectron", ["asar"]);
  assert.equal(surface.isCommunityElectronHost({ ...NODE, resourcesPath: withAsar, versions: {} }), false);
  assert.equal(
    surface.isCommunityElectronHost({ ...NODE, resourcesPath: withAsar, versions: { electron: "" } }),
    false,
  );
});

test("isCommunityElectronHost：DSH_PROFILE 六个别名", () => {
  for (const profile of ["ds-bot", "dsbot", "deepseek-bot", "dsh-next", "dshnext", "dsh next", "DSH-NEXT", " ds-bot "]) {
    assert.equal(surface.isCommunityElectronHost({ ...NODE, env: { DSH_PROFILE: profile } }), true, profile);
  }
  for (const profile of ["web", "desktop", "", "ds-bots"]) {
    assert.equal(surface.isCommunityElectronHost({ ...NODE, env: { DSH_PROFILE: profile } }), false, profile);
  }
});

test("isCommunityElectronHost：可执行文件名（含 .exe 与空格/点/下划线变体）", () => {
  for (const name of ["deepseek-bot", "DeepSeek Bot.exe", "deepseek_bot", "deepseek.bot", "ds-bot", "ds.bot.exe", "dsh-next", "dsh next.exe"]) {
    assert.equal(surface.isCommunityElectronHost({ ...NODE, execPath: `/opt/${name}` }), true, name);
  }
  assert.equal(surface.isCommunityElectronHost({ ...NODE, execPath: "/usr/bin/node" }), false);
});

test("isCommunityElectronHost：execPath 里的目录名也算（末尾不带斜杠的 ds-bot 也要认）", () => {
  for (const p of ["/opt/DeepSeek Bot/app.js", "/opt/deepseek-bot/x", "/opt/ds-bot/x", "/opt/ds-bot", "/opt/dsh next/x", "/opt/dsh-next/x"]) {
    assert.equal(surface.isCommunityElectronHost({ ...NODE, execPath: p }), true, p);
  }
  assert.equal(surface.isCommunityElectronHost({ ...NODE, execPath: "/opt/other/x" }), false);
});

test("detectSurface：社区壳优先级高于 DSH_SURFACE=web", () => {
  assert.equal(surface.detectSurface({ ...NODE, env: { DSH_SURFACE: "web" }, execPath: "/opt/ds-bot/x" }), "desktop");
});

test("detectSurface：DSH_SURFACE 四种合法值原样透出（gui / tui 不被改写成 web）", () => {
  for (const value of ["web", "desktop", "gui", "tui"]) {
    assert.equal(surface.detectSurface({ ...NODE, env: { DSH_SURFACE: value } }), value, value);
  }
  assert.equal(surface.detectSurface({ ...NODE, env: { DSH_SURFACE: " DESKTOP " } }), "desktop");
});

test("detectSurface：非法 DSH_SURFACE 当没写，往下走判据", () => {
  assert.equal(surface.detectSurface({ ...NODE, env: { DSH_SURFACE: "nope" } }), "web");
  assert.equal(
    surface.detectSurface({ ...NODE, env: { DSH_SURFACE: "nope" }, execPath: "/x/DSH Desktop.exe" }),
    "desktop",
  );
});

test("isDesktopSurface：exe 名字白名单八条", () => {
  for (const name of ["DSH Desktop.exe", "dsh desktop", "DSH Next.exe", "dsh next", "DeepSeek Harness.exe", "deepseek-harness.exe", "DeepSeek Harness", "deepseek-harness", "Deepseek_Harness", "DEEPSEEK.HARNESS", "Deepseek Harness.exe"]) {
    assert.equal(surface.isDesktopSurface({ ...NODE, execPath: `/x/${name}` }), true, name);
  }
});

test("isDesktopSurface：DSH_SURFACE=web 压得住 exe 名字白名单", () => {
  assert.equal(
    surface.isDesktopSurface({ ...NODE, env: { DSH_SURFACE: "web" }, execPath: "/x/DSH Desktop.exe" }),
    false,
  );
});

test("isDesktopSurface：argv 里任何一个参数像桌面路径就算", () => {
  assert.equal(
    surface.isDesktopSurface({ ...NODE, argv: ["node", "/opt/DSH Desktop/resources/app/x.js"] }),
    true,
  );
  assert.equal(surface.isDesktopSurface({ ...NODE, argv: ["node", "/opt/x/y.js"] }), false);
  assert.equal(surface.isDesktopSurface({ ...NODE, argv: "not-an-array" }), false);
});

test("isDesktopSurface：ELECTRON_RUN_AS_NODE 单独一条不成立（要配上桌面路径）", () => {
  assert.equal(
    surface.isDesktopSurface({ ...NODE, env: { ELECTRON_RUN_AS_NODE: "1" }, execPath: "/opt/DeepSeek Harness/x" }),
    false,
  );
  assert.equal(
    surface.isDesktopSurface({ ...NODE, env: { ELECTRON_RUN_AS_NODE: "1" }, execPath: "/x/DSH Desktop.exe" }),
    true,
  );
});

test("isDesktopSurface：parentPort 同理，得配上桌面路径", () => {
  assert.equal(surface.isDesktopSurface({ ...NODE, parentPort: {} }), false);
  assert.equal(surface.isDesktopSurface({ ...NODE, parentPort: {}, execPath: "/x/dsh desktop.exe" }), true);
});

test("isDesktopSurface：resourcesPath 里真有桌面安装产物也算", () => {
  const withAsar = resources("resources-path", ["asar"]);
  assert.equal(surface.isDesktopSurface({ ...NODE, resourcesPath: withAsar }), true);
});

test("adapterFor：gui / tui 暂时都走 web", () => {
  assert.deepEqual(
    ["desktop", "web", "gui", "tui", "bogus", ""].map((k) => surface.adapterFor(k)),
    ["desktop", "web", "web", "web", "web", "web"],
  );
});

test("源码形状：两处冗余守卫（留着是纵深防御，删了行为不变）", () => {
  // ①`if (!resourcesPath) return false;` 与下面那句 `if (!(n.endsWith("/resources") || …)) return false;`
  //   合起来等价：空值经 slash() 变成空串，一样过不了 /resources 判定。留着是为了让「没传参」这条
  //   路径不必先拼字符串。
  // ②`p.endsWith("/ds-bot")` 永远走不到：能让它成立的路径末段就是 `ds-bot`，那时 basename 已经被
  //   上面那条 `/^ds[\s._-]*bot(\.exe)?$/` 认掉了。
  //   两条都按源码形状钉住，防止有人把它们当成可达分支去「修」。
  const lines = SRC.split(/\r?\n/);
  assert.ok(lines.some((l) => l.trim() === "if (!resourcesPath) return false;"));
  assert.ok(lines.some((l) => l.trim() === "if (!(n.endsWith(\"/resources\") || n.includes(\"/contents/resources\"))) return false;"));
  assert.ok(lines.some((l) => l.includes('p.endsWith("/ds-bot")')));
  const nameRegex = lines.findIndex((l) => l.includes("/^ds[\\s._-]*bot(\\.exe)?$/"));
  const endsWith = lines.findIndex((l) => l.includes('p.endsWith("/ds-bot")'));
  assert.ok(nameRegex > 0 && endsWith > nameRegex, "basename 那一条必须在前");
});

test("源码形状：parentPort 与 ELECTRON_RUN_AS_NODE 那两条判据的前半段早被上面的路径判据挡掉", () => {
  // 走到这两行时，`pathLooksDesktop(execPath)` 与 `resourcesLookLikeDesktopInstall(resourcesPath)`
  // 必然都是 false（第 107 / 110 行已经问过同一件事并返回了），所以这两个 if 的条件永远为假。
  // 保留它们是为了「将来某天有人把上面的早退挪走」时仍能兜住；这里钉住前提，别让它悄悄变得可达。
  assert.match(SRC, /if \(pathLooksDesktop\(execPath\)\) return true;/);
  assert.match(SRC, /if \(resourcesLookLikeDesktopInstall\(resourcesPath\)\) return true;/);
  const lines = SRC.split(/\r?\n/);
  const firstPath = lines.findIndex((l) => l.trim() === "if (pathLooksDesktop(execPath)) return true;");
  const parentPort = lines.findIndex((l) => l.includes("if (parentPort && (pathLooksDesktop(execPath)"));
  const runAsNode = lines.findIndex((l) => l.includes("if (env.ELECTRON_RUN_AS_NODE && (pathLooksDesktop(execPath)"));
  assert.ok(firstPath > 0 && parentPort > firstPath, "pathLooksDesktop 的那次早退必须在前");
  assert.ok(runAsNode > parentPort, "两条兜底保持原有顺序");
});
