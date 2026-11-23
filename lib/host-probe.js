import path from "node:path";
import { spawnSync } from "node:child_process";
import { inspectAppDir, formatHostReport } from "./host-integrity.js";

/** 在目标树里真加载一次原生绑定；只靠文件存在不够，ABI 不符同样会崩。 */
export function probeTree(appDir) {
  const report = inspectAppDir(path.resolve(appDir));
  const lines = [formatHostReport(report)];
  let loaded = 0;
  for (const file of report.requireBuiltin || []) {
    const r = spawnSync(process.execPath, ["-e", "require(process.argv[1])", file], { encoding: "utf8", timeout: 20000 });
    const ok = r.status === 0;
    if (ok) loaded += 1;
    const first = (r.stderr || "").split("\n")[0];
    lines.push("  load " + path.basename(file) + ": " + (ok ? "ok" : "FAIL " + first));
  }
  return { report, lines, loaded, ok: report.ok && loaded > 0 };
}
