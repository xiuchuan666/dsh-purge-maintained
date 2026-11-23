import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function journalPath(home) {
  return path.join(home || defaultHome(), "dsh-purge", "host-install-journal.json");
}

export function loadJournal(home) {
  try {
    return JSON.parse(fs.readFileSync(journalPath(home), "utf8"));
  } catch {
    return null;
  }
}

export function saveJournal(home, journal) {
  const file = journalPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = Object.assign({}, journal, { updatedAt: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** 未收尾的安装：新的安装必须先 rollback 或显式 --force。 */
export function pendingJournal(home) {
  const j = loadJournal(home);
  return j && j.state === "pending" ? j : null;
}

export function beginInstall(home, input) {
  const opts = input || {};
  const existing = pendingJournal(home);
  if (existing && !opts.force) {
    const err = new Error("上一次安装未收尾（startedAt " + existing.startedAt + "）；先 --rollback，确认无影响再用 --force");
    err.code = "PENDING_INSTALL";
    throw err;
  }
  return saveJournal(home, {
    version: 1,
    state: "pending",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    tree: opts.tree || null,
    resources: opts.resources || null,
    exe: opts.exe || null,
    previous: opts.previous || null,
    asarBackup: opts.asarBackup || null,
    steps: [],
    error: null,
  });
}

export function recordStep(home, name, ok, note) {
  const j = loadJournal(home);
  if (!j) throw new Error("没有安装 journal");
  j.steps = (j.steps || []).concat([{ name: name, ok: !!ok, note: note || "", at: new Date().toISOString() }]);
  return saveJournal(home, j);
}

export function finishInstall(home) {
  const j = loadJournal(home);
  if (!j) throw new Error("没有安装 journal");
  j.state = "done";
  j.finishedAt = new Date().toISOString();
  return saveJournal(home, j);
}

export function failInstall(home, opts) {
  const o = opts || {};
  const j = loadJournal(home);
  if (!j) throw new Error("没有安装 journal");
  j.state = o.rolledBack ? "rolled-back" : "failed";
  j.finishedAt = new Date().toISOString();
  j.error = o.error || "";
  return saveJournal(home, j);
}

export function rollbackPlan(journal) {
  if (!journal || !journal.previous) {
    return { ok: false, reason: "journal 里没有上一棵树（previous）" };
  }
  const steps = ["关闭宿主进程"];
  steps.push("删除当前 " + journal.resources + "/app");
  steps.push("把 " + journal.previous + " rename 回 app");
  if (journal.asarBackup) steps.push("还原 app.asar ← " + journal.asarBackup);
  steps.push("重新启动 " + (journal.exe || "宿主"));
  return { ok: true, steps: steps, previous: journal.previous, asarBackup: journal.asarBackup || null, exe: journal.exe || null };
}

export function summarizeJournal(journal) {
  if (!journal) return "无安装记录";
  const lines = ["state=" + journal.state + " startedAt=" + journal.startedAt + " updatedAt=" + journal.updatedAt];
  if (journal.tree) lines.push("tree=" + journal.tree);
  if (journal.previous) lines.push("previous=" + journal.previous);
  for (const s of journal.steps || []) lines.push((s.ok ? "  ok " : "  FAIL ") + s.name + (s.note ? " — " + s.note : ""));
  if (journal.error) lines.push("error=" + journal.error);
  return lines.join("\n");
}
