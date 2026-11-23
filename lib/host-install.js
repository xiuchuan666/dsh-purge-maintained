import fs from "node:fs";
import path from "node:path";

export const FREE_SPACE_FACTOR = 1.25;

export function treeBytes(dir) {
  let total = 0;
  const walk = (d, depth) => {
    if (depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile()) { try { total += fs.statSync(full).size; } catch { /* 扫描中消失，略过 */ } }
    }
  };
  walk(dir, 0);
  return total;
}

export function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bsize * st.bavail;
  } catch {
    return null;
  }
}

export function checkSpace(resources, needBytes) {
  const free = freeBytes(resources);
  const need = Math.ceil(needBytes * FREE_SPACE_FACTOR);
  if (free === null) return { ok: true, free: null, need: need, note: "读不到磁盘余量（跳过该项）" };
  return { ok: free >= need, free: free, need: need, note: "" };
}

export function resolveExe(resources, explicit) {
  if (explicit) return path.resolve(explicit);
  return path.join(path.dirname(path.resolve(resources)), "DeepSeek Harness.exe");
}

/** 安装计划：所有能离线判定的拒绝条件都收在这里，脚本只负责执行与回滚。 */
export function installPlan(input) {
  const resources = path.resolve(input.resources);
  const tree = path.resolve(input.tree);
  const exe = resolveExe(resources, input.exe);
  const errors = [];
  if (!fs.existsSync(tree)) errors.push("新树不存在: " + tree);
  if (!fs.existsSync(resources)) errors.push("resources 不存在: " + resources);
  if (!fs.existsSync(path.join(resources, "app"))) errors.push("当前没有 resources/app，安装目录可能不对");
  if (!fs.existsSync(exe)) errors.push("找不到宿主可执行文件: " + exe);
  const steps = [
    "预检：journal / 新树 probe / 磁盘余量 / 宿主进程",
    "关闭宿主（--stop）",
    "app → app.prev-<ts>（rename，保留可回滚旧树）",
    "app.asar → app.asar.install-bak-<ts>（若存在）",
    "新树 → app（复制）",
    "装进 app 后再 probe 一次",
    "启动宿主并做启动健康检查（进程存活 + 无新 crash 日志）",
    "成功写 journal=done；任一步失败自动回滚并重启旧树",
  ];
  return { ok: errors.length === 0, errors: errors, resources: resources, tree: tree, exe: exe, steps: steps };
}
