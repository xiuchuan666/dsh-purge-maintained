// 生成 scripts/patch-upgrade-fixtures.mjs：从一棵上游安装树里切出「补丁要改的那几段」。
//
// 用法：
//   node scripts/gen-patch-upgrade-fixtures.mjs --ai-base <path/to/node_modules/@deepseek-ai>
//   node scripts/gen-patch-upgrade-fixtures.mjs --preview        # 用 .tmp-preview 那棵树
//
// 为什么要生成而不是手写：夹具的价值就在「逐字照抄上游原文」。手抄一次就错一次，
// 而且错的那次恰好会把「锚点其实已经不匹配了」这件事掩盖掉。所以夹具一律由真实
// 文件切片产生，测试只负责对拍。
//
// 为什么每条只切一段窗口而不是整个文件：client.js 打完补丁有 68 万字节，塞进仓库
// 既没意义也没法读。切窗口的前提是「pattern 不跨窗口边界」——脚本会验证这一点
// （切片后引擎必须真的改动它），验证不过就直接退出，不写文件。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const core = await import(pathToFileURL(path.join(root, "lib", "core.js")).href);

// 每条：[补丁 id, 文件键, 起始锚点, 结束锚点(含), 说明]
// 结束锚点为 null 表示窗口就是起始锚点本身（minified 里的逐个方法头）。
const SPECS = [
  [
    13,
    "escalation",
    "if (!(WIDER_MODES[effectiveMode]",
    'but the call has no agent to route it through`, "SANDBOX_ESCALATION_UNAVAILABLE");',
    "rc.2 把三处 throw new Error 换成 SandboxEscalationError(msg, 错误码)",
  ],
  [
    18,
    "repeat-tool-reminder",
    'ctx.on("tools/post-execute"',
    'if (messages.some((message) => message.source.kind === "user")) chains.delete(agent);\n\t\treturn next();\n\t});',
    "rc.2 删掉了 post-execute 里的 block 分支",
  ],
  [
    35,
    "escalation",
    "switch (outcome) {",
    'default: return assertNever(outcome, "EscalationOutcome");\n\t}',
    "rc.2 的 switch 分支全部换成 SandboxEscalationError，cancelled 展开成三行",
  ],
  [
    62,
    "dsh-tools-pipeline",
    "if (approval === void 0) return {",
    "approvalCancelled: false\n\t\t};",
    "rc.2 把 decision 内联对象换成 approvalDenial(reason, code) 调用",
  ],
  [
    62,
    "dsh-tools-pipeline-types",
    "if (approval === undefined) {\n            return {",
    "approvalCancelled: false,\n            };",
    "同一份逻辑的 TS 排版：4 空格 + 单引号 + 尾逗号",
  ],
  [
    77,
    "conversation-client",
    "append(record){const event=record.event;if(this.inputs.has(event.seq))return`none`;if(this.revised.size>0)this.revised.clear();",
    null,
    "minified 的 append：命中 rewind 标记时整窗重建，丢掉这条已发出的消息",
  ],
];

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const aiBase = argv.includes("--preview")
  ? path.join(root, ".tmp-preview", "tree", "node_modules", "@deepseek-ai")
  : opt("ai-base", "");

if (!aiBase || !fs.existsSync(aiBase)) {
  console.error("需要 --ai-base <dir> 或 --preview（并且预演树要在场）");
  process.exit(2);
}

const files = core.targetFiles(aiBase);
const byId = new Map(core.ALL_PATCHES.map((p) => [Number(p.id), p]));

function pathsOf(key) {
  const v = files[key];
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function readLf(fp) {
  return fs.readFileSync(fp, "utf8").replace(/\r\n/g, "\n");
}

const fixtures = [];

for (const [id, key, startNeedle, endNeedle, note] of SPECS) {
  const patch = byId.get(Number(id));
  if (!patch) throw new Error(`补丁 #${id} 不存在`);
  const fps = pathsOf(key);
  if (!fps.length) throw new Error(`#${id} 在 ${key} 上找不到目标文件`);
  const fp = fps[0];
  const text = readLf(fp);
  const s = text.indexOf(startNeedle);
  if (s < 0) throw new Error(`#${id} 起始锚点不在这棵树里：${startNeedle.slice(0, 60)}`);
  const e = endNeedle === null ? s + startNeedle.length : text.indexOf(endNeedle, s);
  if (e < 0) throw new Error(`#${id} 结束锚点不在这棵树里：${String(endNeedle).slice(0, 60)}`);
  const before = text.slice(s, endNeedle === null ? e : e + endNeedle.length);

  const once = core.applyReplacementsToText(before, patch, fp);
  if (!once.changed) throw new Error(`#${id} 切出来的窗口引擎改不动，说明 pattern 跨出了窗口边界`);
  if (core.applyReplacementsToText(once.text, patch, fp).changed) {
    throw new Error(`#${id} 窗口打完补丁不幂等`);
  }
  if (fixtures.some((f) => f.id === Number(id) && f.key === key)) {
    throw new Error(`#${id} ${key} 重复登记`);
  }
  fixtures.push({
    id: Number(id),
    key,
    file: path.relative(aiBase, fp).replace(/\\/g, "/"),
    note,
    before,
    after: once.text,
  });
}

// #56：窗口要同时盖住类头、replaceWindow 与 append，才能验证 #56 → #77 的连打。
{
  const fps = pathsOf("conversation-client");
  if (!fps.length) throw new Error("#56 在 conversation-client 上找不到目标文件");
  const fp = fps[0];
  const text = readLf(fp);
  const start = text.indexOf("var ConversationNodeAssembler=class{");
  if (start < 0) throw new Error("#56 找不到类头锚点");
  const appendAt = text.indexOf("append(record){const event=record.event;", start);
  if (appendAt < 0) throw new Error("#56 窗口里找不到 append");
  const tailNeedle = "this.inputs.set(event.seq,record);";
  const tailAt = text.indexOf(tailNeedle, appendAt);
  if (tailAt < 0) throw new Error("#56 找不到 append 尾部锚点");
  const before = text.slice(start, tailAt + tailNeedle.length);

  const p56 = byId.get(56);
  const p77 = byId.get(77);
  const r56 = core.applyReplacementsToText(before, p56, fp);
  if (!r56.changed) throw new Error("#56 切出来的窗口引擎改不动");
  if (core.applyReplacementsToText(r56.text, p56, fp).changed) throw new Error("#56 窗口打完不幂等");
  const r77 = core.applyReplacementsToText(r56.text, p77, fp);
  if (!r77.changed) throw new Error("#56 → #77 连打没有发生");
  if (core.applyReplacementsToText(r77.text, p77, fp).changed) throw new Error("#77 连打不幂等");

  fixtures.push({
    id: 56,
    key: "conversation-client",
    file: path.relative(aiBase, fp).replace(/\\/g, "/"),
    note: "rc.2 的 client.js 被压成单行 minified：锚点仍在，但多行 pattern 全部失配",
    before,
    after: r56.text,
    chain: [77, r77.text],
  });
}

fixtures.sort((a, b) => a.id - b.id || String(a.key).localeCompare(String(b.key)));

const out = path.join(root, "scripts", "patch-upgrade-fixtures.mjs");
const jstr = (s) => JSON.stringify(s);
const lines = [
  "// 上游 0.2.2-rc.2 的补丁锚点回归夹具（自动生成，请勿手改）。",
  "//",
  "// 每条夹具是「从 rc.2 真实文件里切下来的一段窗口」的逐字副本，before 是升级后的",
  "// 上游原文，after 是应用本插件补丁之后应有的样子。测试只做三件事：引擎把 before",
  "// 变成 after、两条窗口确实不同、再打一次不再变化。这样一旦有人改 pattern/replace",
  "// 的字面量，或者上游又改了这段代码，这里都会立刻失败。",
  "//",
  "// 生成来源：.tmp-preview/tree/node_modules/@deepseek-ai（0.2.2-rc.2 全新安装树）。",
  "// 重新生成：node scripts/gen-patch-upgrade-fixtures.mjs --preview",
  "",
  "export const UPGRADE_FIXTURES = [",
];
for (const f of fixtures) {
  lines.push("  {");
  lines.push(`    id: ${f.id},`);
  lines.push(`    key: ${jstr(f.key)},`);
  lines.push(`    file: ${jstr(f.file)},`);
  lines.push(`    note: ${jstr(f.note)},`);
  lines.push(`    before: ${jstr(f.before)},`);
  lines.push(`    after: ${jstr(f.after)},`);
  if (f.chain) lines.push(`    chain: [${f.chain[0]}, ${jstr(f.chain[1])}],`);
  lines.push("  },");
}
lines.push("];", "");

fs.writeFileSync(out, lines.join("\n"), "utf8");
console.log(`wrote ${path.relative(root, out)} (${fixtures.length} fixtures, ${Buffer.byteLength(lines.join("\n"))} bytes)`);
for (const f of fixtures) {
  console.log(`  #${f.id} ${f.key.padEnd(24)} before=${String(f.before.length).padStart(5)} after=${String(f.after.length).padStart(5)}${f.chain ? " chain" : ""}`);
}
