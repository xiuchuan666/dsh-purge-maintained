// 官方客户端升级后的补丁回写标记。wscript 字面量给重启脚本用。
import path from "node:path";
import { hostFs as fs } from "./extract-asar.js";

const MARKER_NAME = "dsh-purge-reapply-asar";

function harnessExeName(exe) {
  const base = path.basename(String(exe || "")).toLowerCase();
  return (
    base === "deepseek harness.exe" ||
    base === "deepseek-harness.exe" ||
    base === "dsh next.exe" ||
    base === "dsh-next.exe"
  );
}

export function upgradeMarkerPath(exe) {
  if (!harnessExeName(exe)) return "";
  return path.join(path.dirname(exe), "resources", MARKER_NAME);
}

export function upgradeMarkerExists(exe) {
  const marker = upgradeMarkerPath(exe);
  return Boolean(marker && fs.existsSync(marker));
}

export function clearUpgradeMarker(exe) {
  const marker = upgradeMarkerPath(exe);
  if (!marker) return;
  try { fs.rmSync(marker, { force: true }); } catch { /* 下次启动再试 */ }
}

export function clearStaleExtractedApps(exe) {
  if (!harnessExeName(exe)) return;
  const resources = path.join(path.dirname(exe), "resources");
  let names = [];
  try { names = fs.readdirSync(resources); } catch { return; }
  // 没有 resources\app 的时候，prev 就是唯一的完整副本（wscript 正把它搬回来，或上次崩在 rename 窗口里）。
  // 启动期抢先把"救命副本"删掉，等于把可回滚点清零。
  let hasLiveApp = false;
  try { hasLiveApp = fs.existsSync(path.join(resources, "app")); } catch { return; }
  if (!hasLiveApp) return;
  for (const name of names) {
    if (!/^app\.dshpurge-prev(?:[-._][\w.-]+)?$/.test(name)) continue;
    const fp = path.join(resources, name);
    let st = null;
    try { st = fs.lstatSync(fp); } catch { continue; }
    // 只删真目录。junction/符号链接一律不碰：它可能正指向 resources\runtime。
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    // 旧树里可能还挂着 app\runtime 这条活链接。Node 不跟 junction，但同一目录以后
    // 被资源管理器 / robocopy / FSO 删一次，目标（resources\runtime）就会被清空。
    try { fs.rmSync(path.join(fp, "runtime"), { recursive: true, force: true }); } catch { /* 不是链接就算了 */ }
    try { fs.rmSync(fp, { recursive: true, force: true }); } catch { /* 旧目录删不掉不影响新版本 */ }
  }
}

/** Windows Script Host 无 BOM 时按系统 ANSI 读文件。中文路径写成 \uXXXX，整份脚本保持 ASCII。 */
export function wshLiteral(value) {
  return JSON.stringify(String(value ?? "")).replace(/[\u007f-\uffff]/g, (ch) => {
    return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
  });
}

export function isWshAscii(source) {
  const text = String(source || "");
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}
