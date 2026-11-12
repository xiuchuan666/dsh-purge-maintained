// 启动自愈：补丁装上之后、用户还没动之前跑的那一次决策树。
//
// 为什么单独成文件：这一段只在宿主启动后几秒内跑一次，跑坏了的表现是
// 「补丁没打上但状态页全绿」「每次启动都重启一次」「官方升级后自愈没生效」，
// 三种都不报错、也没有任何日志能一眼看出来。抽出来才能用假 deps 把 14 个
// return 分支逐条钉住 —— 之前这一段留在 lib/index.js 里时零覆盖。
//
// 设计：这里 **不 import 任何本项目模块**，全部依赖由 createBootSettle(deps) 传入，
// 函数作为返回值交出（模块级只 export 这个工厂）。好处是每个分支都能纯内存触发；
// 代价是 lib/index.js 要多写一段装配代码。
//
// deps：
//   core / hostctl / reapply / officialUpdate / updater —— 对应模块的命名空间；
//   settleMayReapply / settleMayRestart —— lib/settle-policy.js 的两个纯函数；
//   log(config, ...args) —— 跟着 verbose 开关走；
//   setBootFullQuit(true) —— 把「要完整退出」写回 lib/index.js 的模块级变量，
//     /status 的 boot_full_quit 字段读的就是它。

export function createBootSettle(deps = {}) {
  const {
    core, hostctl, reapply, officialUpdate, updater,
    settleMayReapply, settleMayRestart, log, setBootFullQuit,
  } = deps;
  function shimNeedsPatch(state) {
    if (hostctl.currentSurface() === "desktop") return false;
    return (
      state.shim_cmd === "original" ||
      state.shim_ps1 === "original" ||
      state.shim_bin === "original"
    );
  }

  function currentSettleScope() {
    let sealed = false;
    try { sealed = core.desktopAsarStillSealed(); } catch { /* 非桌面或还没定位安装目录 */ }
    return { surface: hostctl.currentSurface(), sealed };
  }

  async function settleInstalledPatches(config, ctx, life) {
    if (life && !life.alive) return "skip:inactive";
    try { core.rememberUnpackedArchive(); } catch { /* 没有官方安装目录时不必记归档 */ }
    try {
      reapply.ensureInstalledRevSeed();
    } catch (e) {
      log(config, "seed installed-rev failed:", String(e && e.message ? e.message : e));
    }
    try {
      if (reapply.healEmptyAppliedStamp()) log(config, "healed empty applied stamp");
    } catch (e) {
      log(config, "heal applied stamp failed:", String(e && e.message ? e.message : e));
    }

    if (config.autoApplyOnStart !== true) {
      try {
        if (await reapply.patchesMatchInstallStrict() || await reapply.hostCleanEnoughToKeep()) {
          reapply.markPatchesApplied();
          log(config, "boot: host files left untouched; stamp kept");
          return "boot:host-untouched";
        }
      } catch { /* 没戳也没关系，等用户点应用 */ }
      log(config, "boot: skip host writes (Apply once)");
      return "skip:boot-no-host-write";
    }

    const scope = currentSettleScope();
    if (!(await reapply.patchesMatchInstallStrict())) {
      if (!settleMayReapply(scope)) {
        log(config, "sealed desktop: skip startup reapply (wait for Apply)");
        return "skip:sealed-wait-apply";
      }
      if (await reapply.hostCleanEnoughToKeep()) {
        reapply.markPatchesApplied();
        log(config, "host already clean; kept patches and refreshed stamp");
        return "already-clean";
      }
      if (officialUpdate.upgradeMarkerExists(process.execPath)) {
        const upgraded = await reapply.reapplyInstalled({ scheduleSwap: false, upgrade: true });
        if (life && !life.alive) return "skip:inactive";
        if (!upgraded.ok) {
          log(config, "official upgrade reapply failed:", upgraded.error || "");
          return "reapply-failed";
        }
        officialUpdate.clearUpgradeMarker(process.execPath);
        officialUpdate.clearStaleExtractedApps(process.execPath);
        if (!settleMayRestart(currentSettleScope()) || reapply.shouldSkipSettleRestart()) {
          if (upgraded.needsFullQuit) setBootFullQuit(true);
          log(config, "official upgrade reapplied; skip settle restart");
          return "reapplied-no-restart";
        }
        reapply.markSettleRestart();
        log(config, "official upgrade reapplied; restarting onto the new build");
        // ctx 可能在 reapply.reapplyInstalled 的 await 中被 dispose；重启前再查一次。
        if (life && !life.alive) return "skip:inactive";
        try {
          hostctl.scheduleRestart(null, ctx, { openBrowser: false });
        } catch (e) {
          log(config, "restart after official upgrade failed:", String(e && e.message ? e.message : e));
          return "restart-failed";
        }
        return "restarting";
      }

      // 启动自愈只写盘，不 swap asar / 不杀进程，避免官方 Host Fiber._reload 撞 INACTIVE_EFFECT。
      const result = await reapply.reapplyInstalled({ scheduleSwap: false });
      if (life && !life.alive) return "skip:inactive";
      if (!result.ok) {
        log(config, "reapply failed:", result.error || "");
        return "reapply-failed";
      }
      // reapply 成功后强制保证非空戳，避免 clean 路径漏写又空转（#59/#60）。
      try { reapply.markPatchesApplied(); } catch { /* ignore */ }
      if (result.needsFullQuit) {
        setBootFullQuit(true);
        log(config, "reapply wrote patches; official host needs a full quit");
        return "full-quit";
      }
      if (!settleMayRestart(currentSettleScope())) {
        log(config, "reapply wrote patches; desktop settle does not restart");
        return "reapplied-no-restart";
      }
      if (reapply.shouldSkipSettleRestart()) {
        log(config, "reapply wrote patches; skip settle restart (cooldown)");
        return "reapplied-no-restart";
      }
      // 已对齐则不必再重启；只在 stamp/宿主仍不一致时重启一次。
      if (await reapply.patchesMatchInstallStrict()) {
        log(config, "reapply wrote patches; already aligned, no restart");
        return "reapplied";
      }
      reapply.markSettleRestart();
      log(config, "reapply wrote patches; restarting");
      // reapplyInstalled 自带 await；重启前再查一次 life，避免对 disposed ctx 发起 scheduleRestart。
      if (life && !life.alive) return "skip:inactive";
      try {
        // web：自愈重启不弹浏览器，关窗后不应再被反复拉起新窗口（#59/#61）。
        hostctl.scheduleRestart(null, ctx, { openBrowser: false });
      } catch (e) {
        log(config, "restart after reapply failed:", String(e && e.message ? e.message : e));
        return "restart-failed";
      }
      return "restarting";
    }

    const applied = await autoApply(config);
    if (config.autoUpdateOnStart === true) {
      updater.autoUpdateIfNeeded()
        .then((r) => {
          // ctx 可能在 autoUpdate 等待网络的过程中被 dispose（热重载 / 卸载）。
          // 回调里再碰 ctx.scheduleRestart 会命中 INACTIVE_EFFECT。
          if (life && !life.alive) return;
          log(config, "auto-update:", JSON.stringify(r));
          if (r && r.needsFullQuit) setBootFullQuit(true);
          if (r && r.restartAfter && settleMayRestart(currentSettleScope())) {
            if (life && !life.alive) return;
            try { hostctl.scheduleRestart(null, ctx, { openBrowser: false }); } catch (e) {
              console.warn("[dsh-purge] auto-update restart failed:", e);
            }
          }
        })
        .catch((e) => console.warn("[dsh-purge] auto-update error:", String(e)));
    }
    return applied;
  }

  async function autoApply(config) {
    try {
      core.applyRuntimeEnv();
      const sanitized = core.sanitizeDesktopCommandRuntimes();
      if (sanitized.length) log(config, "desktop runtime sanitized:", JSON.stringify(sanitized));

      core.refreshHooksDenySettings();
      if (core.getHooksDenySettings().hooksDenyBypass === false) {
        const restored = await core.restoreHookDenyForBases(core.enumeratePatchAiBases());
        if (restored.failed.length) {
          log(config, "hooks-deny restore leftover:", restored.failed.join(","));
        }
      }

      const state = await core.gatherState();
      if (!state.ai_base) {
        log(config, "skip auto-apply: plugin root not found");
        return "skip:plugin_root_not_found";
      }
      try {
        const flash = core.silenceCmdFlash(state.ai_base);
        log(config, "cmd-flash:", JSON.stringify(flash));
        if (!flash.ok) log(config, "cmd-flash incomplete:", flash.entry);
      } catch (e) {
        log(config, "cmd-flash failed:", String(e));
      }

      if (state.patches_pending === 0) {
        if (config.autoApplyOnStart && shimNeedsPatch(state)) {
          await core.patchAllShims();
          core.silenceCmdFlash(state.ai_base);
          log(config, "auto-apply: patches clean, shim refreshed");
          return "already_clean:shim_patched";
        }
        log(config, "auto-apply: already clean");
        return "already_clean";
      }
      if (!config.autoApplyOnStart) {
        log(config, "auto-apply disabled");
        return "disabled";
      }
      const autoMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, { preserveClientBundles: true });
      await core.patchAllShims();
      const report = autoMulti.report;
      const flash = core.silenceCmdFlash(autoMulti.hosts[0]?.aiBase || state.ai_base);
      const applied = report.filter((r) => r.status === "applied").length;
      log(config, `auto-apply done: ${applied} applied; cmd-flash=${flash.entry} ok=${flash.ok}`);
      return flash.ok ? `applied:${applied}` : `applied:${applied}:cmd_flash_incomplete`;
    } catch (e) {
      console.warn("[dsh-purge] auto-apply error:", String(e));
      return `error:${e}`;
    }
  }

  /** 应用之后的那一次重启。密封包退出再打开，不再干等用户自己退出。 */
  function scheduleApplyRestart(shouldRestart, ctx = null) {
    if (!shouldRestart) return { restarting: false };
    if (core.desktopAsarStillSealed()) {
      // 透传 ctx 给核心层,让密封包重启也能走 PowerShell 立即 kill Electron + requestRestart
      // 双保险路径,不再弹"host stopped"崩溃对话框 (#64)。
      const planned = core.restartSealedDesktopIfNeeded({ ctx });
      return {
        ...(planned || {}),
        restarting: Boolean(planned && (planned.restarting || planned.asarSwap)),
      };
    }
    try {
      const planned = hostctl.scheduleRestart(null, ctx);
      if (planned && (planned.restarting === false || planned.clean === false)) return planned;
      return planned || { restarting: true };
    } catch (error) {
      return { restarting: false, error: String(error && error.message ? error.message : error) };
    }
  }
  return {
    shimNeedsPatch,
    currentSettleScope,
    settleInstalledPatches,
    autoApply,
    scheduleApplyRestart,
  };
}
