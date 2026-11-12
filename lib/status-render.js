// 状态页的纯渲染层：只把 state 摊成文本，不读盘、不改文件。
// 从 lib/index.js 搬出来，是为了能在不启宿主的情况下逐行钉住状态页文案——
// 用户排查「补丁有没有打上」时看的就是这几十行字。
import { fsFor } from "./extract-asar.js";
import * as core from "./core.js";
import * as hostctl from "./host.js";

export function fsExists(fp) {
  const list = Array.isArray(fp) ? fp : [fp];
  return list.some((p) => {
    if (!p || typeof p !== "string") return false;
    try {
      return fsFor(p).existsSync(p);
    } catch {
      return false;
    }
  });
}

export function line(title, value, ok = null) {
  const mark = ok === null ? "·" : ok ? "✓" : "✗";
  return `${mark} ${title}: ${value}`;
}

export function renderStatus(state) {
  const out = [];
  out.push("dsh-purge 状态 / Status");
  out.push(line("宿主 / surface", state.surface || hostctl.currentSurface()));
  out.push(line("DSH_HOME", state.dsh_home));
  if (state.desktop_install) out.push(line("桌面安装 / desktop", state.desktop_install));
  if (state.ai_base) {
    out.push(line("插件根 / plugin root", state.ai_base));
    if (state.ai_base_scope === "foreign") {
      out.push("    ! 这份补丁根不在桌面安装目录里（npm 全局 / 别的副本），桌面端改了不会生效");
    }
    for (const [key, fp] of Object.entries(state.files)) {
      const list = Array.isArray(fp) ? fp : [fp];
      const shown = list.length <= 1 ? String(list[0] || "") : `${list[0]} (+${list.length - 1})`;
      out.push(`    ${fsExists(fp) ? "✓" : "✗"} ${key.padEnd(22)} ${shown}`);
    }
  } else {
    out.push(line("插件根 / plugin root", core.missingAiBaseMessage(), false));
  }
  out.push(line("shim 目录", state.shim_dir || "未定位 / not found", !!state.shim_dir));
  if (state.desktop_runtimes?.length) {
    out.push(line("Desktop runtime", `${state.desktop_runtimes.length} sealed (shim OK; bak external)`, true));
    for (const d of state.desktop_runtimes) out.push(`    · ${d}`);
  }
  if (state.runtime_payload) {
    const rp = state.runtime_payload;
    if (rp.ok) {
      out.push(line("runtime 负载 / payload", "node + pnpm 就位（插件市场可用）", true));
    } else if (rp.reason === "no_resources") {
      out.push(line("runtime 负载 / payload", "无法定位 resources 目录", null));
    } else {
      const miss = Array.isArray(rp.missing) && rp.missing.length ? rp.missing.join(", ") : (rp.error || "unknown");
      out.push(line("runtime 负载 / payload", `缺失 → 插件安装会 MODULE_NOT_FOUND：${miss}`, false));
      out.push(`    修复：点「应用」或重启一次，插件会从 ~/.dsh/dsh-runtimes 原地补齐`);
    }
  }
  out.push(line("备份 / backup", state.has_backup ? "有 / yes" : "无 / no", state.has_backup));
  out.push(line("注入文件 / inject", state.override_path));
  out.push(line("注入状态 / override", state.override_status));
  if (state.asar_still_sealed) {
    out.push(line("app.asar", "还在。补丁写在解开目录，当前进程读不到", false));
  }
  out.push("");
  const displayRows = Array.isArray(state.display_patches)
    ? state.display_patches
    : core.groupPatchesForDisplay(core.ALL_PATCHES, state.patch_status || {});
  const displayTally = core.tallyDisplayPatches(displayRows);
  out.push(`补丁 / patches: ${displayTally.applied}/${displayTally.total || 0} applied`
    + (displayTally.skipped ? `, ${displayTally.skipped} skipped（不适用/自标记，不计入 applied）` : "")
    + `, ${displayTally.pending} pending`
    + (displayTally.drifted ? `, ${displayTally.drifted} drifted（官方原文已改，需更新 pattern）` : ""));
  if (state.host_version) {
    const supported = state.host_supported !== false;
    const compat = supported
      ? ""
      : `  ← 未适配：插件声明 ${state.host_target || "?"}`;
    out.push(`宿主 / host: ${state.host_version}${compat}`);
  }
  for (const row of displayRows) {
    const s = row.status || "n/a";
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : s === "drifted" ? "!" : "·";
    const patch = core.ALL_PATCHES.find((item) => item.id === row.id);
    const label = patch ? patch.name : `patch-${row.id}`;
    const layer = patch ? `${patch.layer}/${patch.layer_en}` : row.layer || "";
    out.push(`  ${mark} [#${String(row.id).padEnd(2)}] ${label.padEnd(30)} ${layer} — ${s}`);
  }
  out.push("");
  const shimScope = state.shim_scope === "desktop-cli"
    ? "（桌面自带 runtime\\cli\\bin）"
    : state.shim_scope === "path"
      ? "（PATH 上的 dsh 启动器；本版安装包不再下发 runtime\\cli\\bin）"
      : "";
  out.push(`shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}${shimScope}`);
  return out.join("\n");
}
