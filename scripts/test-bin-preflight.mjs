/**
 * lib/bin-preflight.js 把「启动前回收残留 web server」挂到宿主 bin.js 顶部。
 *
 * 它坏掉的两种方式都不报错：
 *   - 没挂上（返回 injected 但其实没写进去）→ 上一轮的孤儿 web server 还占着端口，
 *     宿主启动时 webserver 插件绑端口失败，0.2.x 是 fatal，用户看到的是「DSH 打不开」；
 *   - 还原不干净（留下一条指向已删 sidecar 的 import）→ 宿主 bin.js 直接 import 失败，
 *     整个 CLI 起不来，比不打补丁更糟。
 *
 * 这里钉住状态机与文本形状，不碰真实宿主：每个用例自己造一棵 `@deepseek-ai/dsh` 树。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installBinPreflight, revertBinPreflight } from "../lib/bin-preflight.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-binpf-"));
test.after(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 偶发 EPERM */
  }
});

let seq = 0;
/** 造一棵宿主树：<tag>/@deepseek-ai/dsh/lib/{bin.js, ...}。binText 传 null 表示不放 bin.js。 */
function hostTree(binText, { tag } = {}) {
  seq += 1;
  const name = tag || `t${seq}`;
  const ai = path.join(sandbox, name, "@deepseek-ai");
  const root = path.join(ai, "dsh");
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  if (binText !== null) fs.writeFileSync(path.join(root, "lib", "bin.js"), binText);
  return { ai, root, binJs: path.join(root, "lib", "bin.js"), side: path.join(root, "lib", "dsh-purge-web-preflight.js") };
}

const MARK_LINE = 'import "./dsh-purge-web-preflight.js"; // [dsh-purge] web preflight';

test("installBinPreflight：找不到 bin 根就返回 missing_bin，什么都不写", () => {
  assert.equal(installBinPreflight(path.join(sandbox, "does-not-exist")), "missing_bin");
  assert.equal(installBinPreflight(""), "missing_bin");
  assert.equal(installBinPreflight(undefined), "missing_bin");
});

test("installBinPreflight：正常注入把 import 插在 shebang 之后，并落 sidecar", () => {
  const t = hostTree("#!/usr/bin/env node\nconsole.log(1);\n");
  assert.equal(installBinPreflight(t.ai), "injected");
  const text = fs.readFileSync(t.binJs, "utf8");
  assert.equal(text, `#!/usr/bin/env node\n${MARK_LINE}\nconsole.log(1);\n`, "shebang 必须在第一行，否则 bin.js 不可执行");
  assert.ok(fs.existsSync(t.side), "sidecar 必须落在宿主 lib 下");
  assert.ok(fs.readFileSync(t.side, "utf8").length > 0, "sidecar 内容来自 lib/web-preflight-entry.js");
});

test("installBinPreflight：没有 shebang 时插在最前面", () => {
  const t = hostTree("console.log(2);\n");
  assert.equal(installBinPreflight(t.ai), "injected");
  assert.equal(fs.readFileSync(t.binJs, "utf8"), `${MARK_LINE}\nconsole.log(2);\n`);
});

test("installBinPreflight：只有 shebang、后面没有换行时也能插进去", () => {
  const t = hostTree("#!/usr/bin/env node");
  assert.equal(installBinPreflight(t.ai), "injected");
  assert.equal(fs.readFileSync(t.binJs, "utf8"), `#!/usr/bin/env node\n${MARK_LINE}\n`);
});

test("installBinPreflight：已注入过就返回 already_injected，不重复写", () => {
  const t = hostTree("#!/usr/bin/env node\nconsole.log(1);\n");
  assert.equal(installBinPreflight(t.ai), "injected");
  const once = fs.readFileSync(t.binJs, "utf8");
  assert.equal(installBinPreflight(t.ai), "already_injected");
  assert.equal(fs.readFileSync(t.binJs, "utf8"), once, "第二次不能改文件");
});

test("installBinPreflight：旧格式的 import 行（没有尾部注释）会被换掉，不留两条", () => {
  const t = hostTree('import "./dsh-purge-web-preflight.js";\nold\n');
  assert.equal(installBinPreflight(t.ai), "injected");
  const text = fs.readFileSync(t.binJs, "utf8");
  assert.equal(text, `${MARK_LINE}\nold\n`, "旧行必须被清掉，只留新行");
  assert.equal(text.split("dsh-purge-web-preflight").length - 1, 1, "全文只能出现一次");
});

test("installBinPreflight：多条旧格式 import 一起清掉", () => {
  const t = hostTree('import "./dsh-purge-web-preflight.js";\nA\nimport "./dsh-purge-web-preflight.js";\nB\n');
  assert.equal(installBinPreflight(t.ai), "injected");
  const text = fs.readFileSync(t.binJs, "utf8");
  assert.equal(text, `${MARK_LINE}\nA\nB\n`);
  assert.equal(text.split("dsh-purge-web-preflight").length - 1, 1);
});

test("installBinPreflight：源码 monorepo 的 apps/cli 只读不改（#41）", () => {
  const t = hostTree("#!/usr/bin/env node\noriginal\n");
  fs.writeFileSync(path.join(t.root, "lib", "tsconfig.tsbuildinfo"), "{}");
  assert.equal(installBinPreflight(t.ai), "skipped_source_cli");
  assert.equal(fs.readFileSync(t.binJs, "utf8"), "#!/usr/bin/env node\noriginal\n", "文件必须一字未动");
  assert.equal(fs.existsSync(t.side), false, "也不能留下 sidecar");
});

test("installBinPreflight：asar 密封路径不碰", () => {
  const t = hostTree("#!/usr/bin/env node\nx\n");
  const sealedHint = path.join(sandbox, "sealed", "app.asar", "@deepseek-ai");
  // 密封路径解析不到可写的 bin 根 → missing_bin，且不能顺手改到同名的解包树
  assert.equal(installBinPreflight(sealedHint), "missing_bin");
  assert.equal(fs.readFileSync(t.binJs, "utf8"), "#!/usr/bin/env node\nx\n");
});
test("密封根绝不会被写：install 里那道 isAsarSealedPath 是纵深防御", () => {
  // installBinPreflight 里 `if (isAsarSealedPath(root) || isAsarSealedPath(binJs)) return "sealed_asar"`
  // 在实际调用路径上走不到 —— resolveDshBinRoot 遇到密封根会 continue，最后返回 null，
  // 于是更早的 `if (!root) return "missing_bin"` 就返回了。留着是对的（resolveDshBinRoot
  // 将来若放宽），但别指望测试能守住它；这里钉的是「密封根绝不会被写」这个结果。
  const sealedAi = path.join(sandbox, "sealedtree2", "app.asar", "@deepseek-ai");
  const sealedBin = path.join(sealedAi, "dsh", "lib", "bin.js");
  fs.mkdirSync(path.dirname(sealedBin), { recursive: true });
  fs.writeFileSync(sealedBin, "#!/usr/bin/env node\nsealed\n");
  assert.equal(installBinPreflight(sealedAi), "missing_bin");
  assert.equal(fs.readFileSync(sealedBin, "utf8"), "#!/usr/bin/env node\nsealed\n");
  assert.equal(fs.existsSync(path.join(path.dirname(sealedBin), "dsh-purge-web-preflight.js")), false);
});

test("installBinPreflight：bin.js 读不出来时返回 error: 前缀（调用方靠这个前缀判断失败）", () => {
  const t = hostTree(null);
  fs.mkdirSync(t.binJs); // bin.js 是个目录
  const status = installBinPreflight(t.ai);
  assert.match(status, /^error:/, `status = ${status}`);
  assert.match(status, /EISDIR|illegal operation/, "要带上原始错误信息，否则用户不知道为什么没挂上");
});

test("installBinPreflight：读 bin.js 失败时 sidecar 已经写下去了（现状锁定）", () => {
  // 顺序是「先写 sidecar、再读 bin.js」，所以读失败会留下一个没人引用的 sidecar。
  // 后果不重（bin.js 里没有 import 指向它，等于一个孤儿文件），但回滚会把它算成
  // 「改过东西」（revert 返回 reverted_partial 而不是 absent）。要改顺序属产品决策。
  const t = hostTree(null);
  fs.mkdirSync(t.binJs);
  assert.match(installBinPreflight(t.ai), /^error:/);
  assert.equal(fs.existsSync(t.side), true, "现状：sidecar 留在宿主 lib 里");
});

test("revertBinPreflight：注入后能完整还原成原始字节", () => {
  const original = "#!/usr/bin/env node\nconsole.log(1);\n";
  const t = hostTree(original);
  assert.equal(installBinPreflight(t.ai), "injected");
  assert.equal(revertBinPreflight(t.ai), "reverted");
  assert.equal(fs.readFileSync(t.binJs, "utf8"), original, "必须逐字节回到原样");
  assert.equal(fs.existsSync(t.side), false, "sidecar 必须删掉");
});

test("revertBinPreflight：没注入过就返回 absent，不动文件", () => {
  const original = "#!/usr/bin/env node\nkeep\n";
  const t = hostTree(original);
  assert.equal(revertBinPreflight(t.ai), "absent");
  assert.equal(fs.readFileSync(t.binJs, "utf8"), original);
});

test("revertBinPreflight：重复还原是幂等的（第二次 absent）", () => {
  const t = hostTree("#!/usr/bin/env node\nx\n");
  installBinPreflight(t.ai);
  assert.equal(revertBinPreflight(t.ai), "reverted");
  assert.equal(revertBinPreflight(t.ai), "absent");
});

test("revertBinPreflight：旧格式的 import 行也能清掉", () => {
  const t = hostTree('import "./dsh-purge-web-preflight.js";\nold\n');
  assert.equal(revertBinPreflight(t.ai), "reverted");
  assert.equal(fs.readFileSync(t.binJs, "utf8"), "old\n");
});

test("revertBinPreflight：找不到 bin 根返回 missing_bin", () => {
  assert.equal(revertBinPreflight(path.join(sandbox, "nope")), "missing_bin");
});

test("revertBinPreflight：bin.js 读不出来但删掉了 sidecar → reverted_partial", () => {
  const t = hostTree(null);
  fs.mkdirSync(t.binJs);
  installBinPreflight(t.ai); // 先造出孤儿 sidecar
  const status = revertBinPreflight(t.ai);
  assert.equal(status, "reverted_partial", "半残要如实报告，不能报 reverted");
  assert.equal(fs.existsSync(t.side), false, "读不到 bin.js 也要把 sidecar 删掉");
});

test("revertBinPreflight：源码树不动 bin.js，只清 sidecar", () => {
  // bin.js 里**真的**带着标记行：如果 revert 不认源码树，就会把这行摘掉。
  const original = "#!/usr/bin/env node\n" + MARK_LINE + "\nsrc\n";
  const t = hostTree(original);
  fs.writeFileSync(path.join(t.root, "lib", "tsconfig.tsbuildinfo"), "{}");
  fs.writeFileSync(t.side, "stale sidecar");
  assert.equal(revertBinPreflight(t.ai), "reverted", "sidecar 删掉了就算 reverted");
  assert.equal(fs.readFileSync(t.binJs, "utf8"), original, "源码树的 bin.js 一个字节都不能动（#41）");
  assert.equal(fs.existsSync(t.side), false);
});

test("installBinPreflight：注入后 bin.js 仍是合法 JS（import 行带分号、独占一行）", () => {
  const t = hostTree("#!/usr/bin/env node\nexport const x = 1;\n");
  installBinPreflight(t.ai);
  const lines = fs.readFileSync(t.binJs, "utf8").split("\n");
  assert.equal(lines[0], "#!/usr/bin/env node");
  assert.equal(lines[1], MARK_LINE);
  assert.match(lines[1], /^import "\.\/[^"]+";\s*\/\//, "分号必须在行尾注释之前，否则会和下一行粘连");
  assert.ok(lines[1].startsWith("import "), "必须是静态 import，不能是动态 import()");
});

test("installBinPreflight：sidecar 名字与 import 路径必须一致", () => {
  // 两处各写一遍文件名，改一处不改另一处就会 import 到不存在的模块 —— 宿主直接起不来。
  const t = hostTree("#!/usr/bin/env node\nx\n");
  installBinPreflight(t.ai);
  const text = fs.readFileSync(t.binJs, "utf8");
  const target = text.match(/^import "\.\/([^"]+)";/m)[1];
  assert.equal(target, path.basename(t.side));
  assert.ok(fs.existsSync(path.join(path.dirname(t.binJs), target)));
});

test("installBinPreflight：revert 之后再 install 能重新挂上（不是一次性状态）", () => {
  const t = hostTree("#!/usr/bin/env node\nx\n");
  assert.equal(installBinPreflight(t.ai), "injected");
  assert.equal(revertBinPreflight(t.ai), "reverted");
  assert.equal(installBinPreflight(t.ai), "injected");
  assert.equal(fs.readFileSync(t.binJs, "utf8"), `#!/usr/bin/env node\n${MARK_LINE}\nx\n`);
});
