#!/usr/bin/env node
// 宿主更新一条命令（P1-3b）：下载 → 抽包 → 解 asar → 预演 → 安装 dry-run。
//
//   node scripts/host-update.mjs --plan                  # 只出五步计划，一个目录都不建
//   node scripts/host-update.mjs --workdir DIR           # 默认 dry-run：只下 + 抽，其余命令打印
//   node scripts/host-update.mjs --resources DIR --exe EXE --apply [--stop]
//
// 永不启动宿主 exe；安装永远由 scripts/host-install.mjs 做。
// 退出码：0 成功（含 dry-run）；1 执行失败；2 用法或 apply 预检不通过。
import { planUpdate, runUpdate } from "../lib/host-update.js";

function usage() {
  console.log("usage: node scripts/host-update.mjs [--plan] [--workdir DIR] [--installdir DIR] [--json]");
  console.log("       node scripts/host-update.mjs --resources DIR --exe EXE [--stop] [--apply] [--json]");
  console.log("  默认 dry-run：只下载并解包到 --workdir，其余步骤只打印命令；--apply 才跑完整链。");
  console.log("  --plan 只出计划（不下载、不建目录）。--sevenzip / --url / --dest / --home / --force 可选。");
}

function parse(argv) {
  const out = { apply: false, stop: false, json: false, plan: false, force: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const need = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(item + " 需要一个值");
      return value;
    };
    if (item === "--installdir") out.installdir = need();
    else if (item === "--resources") out.resources = need();
    else if (item === "--exe") out.exe = need();
    else if (item === "--workdir") out.workdir = need();
    else if (item === "--url") out.url = need();
    else if (item === "--dest") out.dest = need();
    else if (item === "--state") out.state = need();
    else if (item === "--home") out.home = need();
    else if (item === "--sevenzip") out.sevenZip = need();
    else if (item === "--apply") out.apply = true;
    else if (item === "--stop") out.stop = true;
    else if (item === "--json") out.json = true;
    else if (item === "--plan") out.plan = true;
    else if (item === "--force") out.force = true;
    else if (item === "--help" || item === "-h") out.help = true;
    else throw new Error("unknown argument: " + item);
  }
  return out;
}

function indent(text) {
  return text
    .split(/\r?\n/)
    .map((line) => "    " + line)
    .join("\n");
}

function printPlan(steps, meta, title) {
  console.log("[" + title + "] 工作目录 " + meta.workdir);
  console.log("[" + title + "] 安装包落点 " + meta.dest);
  console.log(
    "[" + title + "] 7z " + (meta.sevenZip || "（没探到：" + (meta.sevenZipError || "未知") + "）"),
  );
  console.log("[" + title + "] resources " + meta.resources + (meta.resourcesGiven ? "" : "（推断值，--apply 前请核对）"));
  console.log("[" + title + "] exe " + meta.exe + (meta.exeGiven ? "" : "（推断值，--apply 前请核对）"));
  for (const step of steps) {
    console.log("");
    console.log("[" + step.index + "/" + steps.length + "] " + step.kind + " — " + step.why);
    console.log("    " + step.command);
    for (const extra of step.follow || []) console.log("    " + extra.command);
  }
}

async function main() {
  let args;
  try {
    args = parse(process.argv.slice(2));
  } catch (error) {
    console.error("[update] " + error.message);
    usage();
    return 2;
  }
  if (args.help) {
    usage();
    return 0;
  }
  if (args.apply && (!args.resources || !args.exe)) {
    console.error("[update] --apply 需要 --exe 与 --resources（不会拿推断出来的路径去换宿主）");
    return 2;
  }

  const steps = planUpdate(args);
  const meta = steps.meta;

  if (args.plan) {
    if (args.json) {
      console.log(JSON.stringify({ ok: true, mode: "plan", workdir: meta.workdir, dest: meta.dest, sevenZip: meta.sevenZip || null, steps: steps }, null, 2));
    } else {
      printPlan(steps, meta, "plan");
      console.log("");
      console.log("[plan] 只出计划：没有下载、没有建目录、没有启动宿主。");
    }
    return 0;
  }

  if (!args.json) {
    printPlan(steps, meta, args.apply ? "apply" : "dry-run");
    console.log("");
  }

  let result;
  try {
    result = await runUpdate(steps, {
      apply: args.apply,
      stop: args.stop,
      onStep: args.json
        ? null
        : (event) => {
            if (event.action === "run") console.log("[run ] " + event.step.kind + "  " + event.command);
            else console.log("[skip] " + event.step.kind + "  " + event.reason);
          },
    });
  } catch (error) {
    if (args.json) console.log(JSON.stringify({ ok: false, mode: args.apply ? "apply" : "dry-run", error: error.message }, null, 2));
    console.error("[update] " + error.message);
    console.error("[update] 宿主没有被本工具替换：换树只发生在 scripts/host-install.mjs 的 --apply 里。");
    return 1;
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        { ok: true, mode: args.apply ? "apply" : "dry-run", workdir: result.workdir, dest: result.dest, sevenZip: result.sevenZip, result: result },
        null,
        2,
      ),
    );
    return 0;
  }

  for (const entry of result.executed) {
    for (const call of entry.calls) {
      if (call.stdout) console.log(indent(call.stdout));
      if (call.stderr) console.log(indent(call.stderr));
    }
  }
  if (result.next.length) {
    console.log("");
    console.log("[next] 剩下的命令（本工具不会替你按安装键）：");
    for (const item of result.next) console.log("    " + item.command);
  }
  console.log("");
  console.log("[update] " + (result.dryRun ? "dry-run 结束：装好的只有工作目录里的解包产物。" : "apply 结束。"));
  console.log("[update] " + result.applyHint);
  return 0;
}

const code = await main();
process.exit(code);
