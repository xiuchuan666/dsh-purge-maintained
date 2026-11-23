#!/usr/bin/env node
import path from "node:path";
import {
  DEFAULT_PROFILE,
  MIN_SLOT,
  EXIT,
  applyInstall,
  defaultHome,
  layoutFor,
  planProfileInstall,
  processRunning,
  readTarballPackage,
  rollbackInstall,
  startProcess,
  stopProcess,
  verifyTgz,
  waitProcessGone,
} from "../lib/profile-install.js";
import { pendingJournal } from "../lib/host-install-journal.js";

const USAGE = [
  "用法：node scripts/profile-install.mjs [选项]",
  "",
  "  --tgz <path>        要安装的 dsh-purge tarball（必填，--rollback 时忽略）",
  "  --version <ver>     期望版本；缺省从 tgz 的 package.json 读取",
  "  --sha256 <hex|b64>  校验 tgz 的 sha256（可带 sha256- 前缀）",
  "  --size <bytes>      校验 tgz 的字节数",
  "  --home <dir>        DSH_HOME，默认 ~/.dsh 或 $DSH_HOME",
  "  --profile <name>    profile 名，默认 desktop",
  "  --profile-dir <dir> 直接指定 profile 目录（覆盖 home/profile 推导）",
  "  --exe <path>        宿主可执行文件，用于退出检测与安装后重启",
  "  --min-slot <n>      健康检查的 SLOT 长度下限，默认 " + MIN_SLOT,
  "  --apply             真正写入；缺省只打印计划",
  "  --rollback          按 journal 还原上一次安装",
  "  --force             有未收尾 journal 或宿主仍在运行时继续",
  "  --json              以 JSON 输出结果",
  "  --help              显示本说明",
  "",
  "退出码：0 成功 / 1 失败已回滚 / 2 预检失败 / 3 有未收尾安装",
].join("\n");

function parse(argv) {
  const options = {
    home: "",
    profile: DEFAULT_PROFILE,
    profileDir: "",
    tgz: "",
    exe: "",
    version: "",
    sha256: "",
    size: null,
    minSlot: null,
    apply: false,
    rollback: false,
    force: false,
    json: false,
    help: false,
    unknown: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      if (i + 1 >= argv.length) throw new Error(arg + " 需要一个值");
      i += 1;
      return argv[i];
    };
    if (arg === "--home") options.home = take();
    else if (arg === "--profile") options.profile = take();
    else if (arg === "--profile-dir") options.profileDir = take();
    else if (arg === "--tgz") options.tgz = take();
    else if (arg === "--exe") options.exe = take();
    else if (arg === "--version") options.version = take();
    else if (arg === "--sha256") options.sha256 = take();
    else if (arg === "--size") options.size = Number(take());
    else if (arg === "--min-slot") options.minSlot = Number(take());
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--rollback") options.rollback = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else options.unknown.push(arg);
  }
  return options;
}

function printPlan(plan) {
  console.log("[dry-run] 计划：dsh-purge " + (plan.from || "(未安装)") + " → " + plan.expectedVersion);
  console.log("  profile：" + plan.profileDir);
  console.log("  tgz：" + plan.tgz);
  console.log("  依赖 specifier：" + (plan.currentSpec || "(无)") + " → " + plan.spec);
  console.log("  锁文件 key：" + (plan.lockKey || "(无)"));
  plan.steps.forEach((step, index) => console.log("  " + (index + 1) + ". " + step));
}

function printResult(result) {
  const checks = (result.health && result.health.checks) || [];
  const versionCheck = checks.find((check) => check.name === "version");
  const label = versionCheck ? versionCheck.expected : checks[0] ? checks[0].detail : "(未知)";
  console.log("安装完成：dsh-purge " + label);
  for (const check of checks) {
    console.log("  [" + (check.ok ? "ok" : "FAIL") + "] " + check.name + "：" + check.detail);
  }
  console.log("  pnpm-lock.yaml 改动 " + result.lockChanges + " 行");
  for (const warning of result.warnings || []) console.log("  警告：" + warning);
}

async function main() {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    return EXIT.precheck;
  }
  if (options.help) {
    console.log(USAGE);
    return EXIT.ok;
  }
  if (options.unknown.length > 0) {
    console.error("未知参数：" + options.unknown.join(" "));
    console.error(USAGE);
    return EXIT.precheck;
  }
  const home = path.resolve(options.home || defaultHome());
  const profileDir = options.profileDir ? path.resolve(options.profileDir) : "";
  const layout = layoutFor(profileDir, home, options.profile);

  if (options.rollback) {
    if (!options.exe && !options.force) {
      console.error("--rollback 需要 --exe 用于确认并关闭宿主；宿主已退出时可加 --force 跳过检测");
      return EXIT.precheck;
    }
    const state = processRunning(options.exe);
    let stopped = false;
    if (state === null) console.error("提示：无法确认宿主进程状态（tasklist 不可用），继续按 journal 还原");
    if (state === true && options.exe) {
      stopped = stopProcess(options.exe);
      const gone = await waitProcessGone(options.exe, 15000);
      if (!gone) {
        console.error("宿主进程仍在运行（" + path.basename(options.exe) + "），先手动退出再 --rollback");
        return EXIT.precheck;
      }
    }
    if (!options.exe) console.error("提示：未提供 --exe，无法关闭宿主，仍有文件占用的风险");
    const result = rollbackInstall({ home, layout });
    if (!result.ok) {
      console.error("回滚失败：" + result.reason);
      return result.code === "NO_JOURNAL" ? EXIT.precheck : EXIT.failed;
    }
    if (stopped && options.exe) startProcess(options.exe);
    console.log("已回滚：" + result.restored.join("、") + "；journal 状态 " + result.journal.state + " → done");
    if (!options.exe) console.log("未关闭宿主，请手动重启应用");
    return EXIT.ok;
  }

  let version = options.version;
  if (!version && options.tgz) {
    try {
      const meta = readTarballPackage(path.resolve(options.tgz));
      if (meta && meta.version) version = String(meta.version);
    } catch (error) {
      /* 读不到交给 planProfileInstall 报预检失败 */
    }
  }
  if (options.sha256 || (options.size !== null && Number.isFinite(options.size))) {
    const verify = verifyTgz(options.tgz, { sha256: options.sha256, size: options.size });
    if (!verify.ok) {
      console.error("tgz 校验失败：" + verify.reasons.join("；"));
      return EXIT.precheck;
    }
  }
  const plan = planProfileInstall({
    profileDir: layout.profileDir,
    home: home,
    profile: options.profile,
    tgz: options.tgz,
    packageVersion: version,
    exe: options.exe,
    minSlot: options.minSlot,
  });
  if (!plan.ok) {
    console.error("预检失败：");
    for (const reason of plan.reasons) console.error("  - " + reason);
    return EXIT.precheck;
  }
  const pending = pendingJournal(home);
  if (!options.apply) {
    printPlan(plan);
    if (pending) console.error("注意：journal 里有未收尾的安装（startedAt " + pending.startedAt + "），--apply 前先 --rollback 或加 --force");
    if (options.json) console.log(JSON.stringify({ ok: true, dryRun: true, plan: plan }, null, 2));
    return EXIT.ok;
  }
  if (pending && !options.force) {
    console.error("有未收尾的安装（startedAt " + pending.startedAt + "）：先 --rollback，确认无影响后再 --force");
    return EXIT.pending;
  }
  const state = processRunning(options.exe);
  if (state === null) {
    console.error("无法确认宿主进程状态（tasklist 不可用），先手动退出宿主再 --apply");
    return EXIT.precheck;
  }
  let stopped = false;
  if (state === true) {
    if (!options.force) {
      console.error("宿主还在运行（" + path.basename(options.exe) + "），先退出，或加 --force 由安装器强制关闭");
      return EXIT.precheck;
    }
    stopped = stopProcess(options.exe);
    const gone = await waitProcessGone(options.exe, 15000);
    if (!gone) {
      console.error("宿主进程无法关闭（" + path.basename(options.exe) + "）");
      return EXIT.precheck;
    }
    console.log("已强制关闭宿主：" + path.basename(options.exe));
  }
  const result = applyInstall({ home: home, layout: layout, plan: plan, exe: options.exe, force: options.force, minSlot: options.minSlot });
  if (!result.ok) {
    console.error("安装失败：" + result.error);
    if (result.rolledBack) console.error("已还原上一版：" + (result.restored || []).join("、"));
    else console.error("警告：还原未完成，journal 保留为可回滚状态，处理后用 --rollback");
    if (stopped && options.exe) startProcess(options.exe);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    return EXIT.failed;
  }
  if (stopped && options.exe) {
    const pid = startProcess(options.exe);
    console.log("已重启宿主：" + path.basename(options.exe) + (pid ? "（pid " + pid + "）" : ""));
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  return EXIT.ok;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("未处理的错误：" + (error && error.stack ? error.stack : error));
    process.exitCode = EXIT.failed;
  });
