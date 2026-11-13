// 重启前的地板：宿主到底清没清干净，以及密封桌面要不要先换 asar。
//
// 为什么单独成文件：这三个函数只在「用户点重启 / 后台自愈要重启」那一刻跑，
// 坏了的表现全是静默的 —— 「清洗没写完却照常重启」（用户看到宿主半打状态）、
// 「app.asar 还在就重启」（补丁在 resources/app，重启完等于没打）、
// 「自定义安装目录没记下来」（下次再也定位不到 exe，只能重装）。
// 留在 lib/core.js 里时它们零覆盖：每个分支都要摸真宿主目录才能触发。
//
// 设计同 lib/boot-settle.js：本文件 **不 import 任何本项目模块**，全部依赖由
// createHostCleanFloor(deps) 传入，函数作为返回值交出（模块级只 export 这个工厂）。
// lib/core.js 留三个同名薄包装，导出面与调用方一行不改。
//
// deps：
//   applyRuntimeEnv / findAiBase / missingAiBaseMessage / patchStatus /
//   enumeratePatchAiBases / allPatchHostsWritten / silenceCmdFlash /
//   applyPatchesAllHosts / patchAllShims / summarizeApplyReport /
//   resolveOfficialAiBase / sealedAsarHandoff / asarArchiveIsFile /
//   atomicWriteSync / findDshHome —— lib/core.js 与 lib/extract-asar.js 的现有函数；
//   ALL_PATCHES —— lib/patches/index.mjs 的注册表（顺序即 apply 顺序）；
//   desktop —— lib/desktop.js 的命名空间；
//   hostFs —— 可能被换成 app.asar 里的真实 fs。

import path from "node:path";

export function createHostCleanFloor(deps = {}) {
  const {
    applyRuntimeEnv, findAiBase, missingAiBaseMessage, patchStatus,
    enumeratePatchAiBases, allPatchHostsWritten, hostCleanMarkersPresent, silenceCmdFlash,
    applyPatchesAllHosts, patchAllShims, summarizeApplyReport,
    resolveOfficialAiBase, sealedAsarHandoff, asarArchiveIsFile,
    atomicWriteSync, findDshHome, ALL_PATCHES, desktop, hostFs,
  } = deps;

  async function ensureHostClean() {
    applyRuntimeEnv();
    let aiBase = null;
    try {
      const located = await resolveOfficialAiBase(findAiBase());
      aiBase = located.aiBase || null;
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e), aiBase: null };
    }
    if (!aiBase) return { ok: false, error: missingAiBaseMessage(), aiBase: null };

    const pendingAcross = async (bases) => {
      const ids = new Set();
      for (const base of bases) {
        const status = await patchStatus(base);
        for (const [id, state] of Object.entries(status)) {
          if (state === "pending") ids.add(id);
        }
      }
      return [...ids];
    };
    const snapshotHosts = (bases) => bases.map((b) => ({
      aiBase: b,
      hostWritten: hostCleanMarkersPresent(b),
      flash: silenceCmdFlash(b),
    }));

    const patchOpts = { preserveClientBundles: false, forApply: true };
    let bases = enumeratePatchAiBases({ discover: true });
    if (!bases.some((b) => path.normalize(b).toLowerCase() === path.normalize(aiBase).toLowerCase())) {
      bases = [aiBase, ...bases];
    }
    let allHosts = snapshotHosts(bases);
    let pending = await pendingAcross(bases);
    const needsApply =
      pending.length > 0 ||
      !allPatchHostsWritten(allHosts) ||
      !allHosts.every((h) => h.flash?.ok === true);

    if (needsApply) {
      const multi = await applyPatchesAllHosts(ALL_PATCHES, patchOpts);
      allHosts = multi.hosts.length ? multi.hosts : allHosts;
      await patchAllShims();
      const summary = summarizeApplyReport(multi.report);
      pending = await pendingAcross(allHosts.map((h) => h.aiBase));
      // 失败就是失败：pattern_not_found 同样是"没打上"，以前被过滤掉，
      // 于是宿主半打状态照样重启，用户只看到一片绿。现在一律当阻断项。
      const blocking = summary.failed;
      const flashOk = allHosts.every((h) => h.flash?.ok === true);
      if (pending.length || blocking.length || !flashOk) {
        return {
          ok: false,
          error: "清洗没有完成，已取消重启",
          pending,
          failed: blocking.length,
          aiBase,
          hosts: allHosts.map((h) => h.aiBase),
        };
      }
    }
    if (!allPatchHostsWritten(allHosts)) {
      return { ok: false, error: "清洗没有写进全部宿主，已取消重启", aiBase, hosts: allHosts.map((h) => h.aiBase) };
    }
    return { ok: true, aiBase, pending: [], hosts: allHosts.map((h) => h.aiBase) };
  }

  function restartSealedDesktopIfNeeded(input = {}) {
    const handoff = sealedAsarHandoff(input);
    if (!handoff?.exe || !handoff?.asar) return { needed: false, renamed: true };
    if (!asarArchiveIsFile(handoff.asar)) return { needed: false, renamed: true };
    rememberDesktopInstallForHandoff(handoff);
    // input.ctx 透传给桌面层:restartOfficialHarness 内部 desktopRuntimeOf(ctx) 拿到 runtime
    // 用于 gracefulExit 优雅握手重启,降低宿主"host 退出 = crash"弹窗概率(#64)。
    if (process.platform === "win32" && desktop.isOfficialHarnessExecutable(handoff.exe)) {
      const restarted = desktop.restartOfficialHarness({ exe: handoff.exe, asar: handoff.asar, ctx: input.ctx });
      return { needed: true, renamed: false, asarSwap: true, ...restarted };
    }
    desktop.scheduleAsarSwapRestart({
      exe: handoff.exe,
      asar: handoff.asar,
      waitPid: process.pid,
      exit: true,
      ctx: input.ctx,
    });
    return { needed: true, renamed: false, asarSwap: true };
  }

  function rememberDesktopInstallForHandoff(handoff) {
    if (!handoff?.exe) return;
    const installDir = path.dirname(path.normalize(handoff.exe));
    if (!installDir || !desktop.isDesktopExecutable(handoff.exe)) return;
    try {
      const home = findDshHome();
      const fp = path.join(home, "dsh-purge", "desktop-install.txt");
      // M30:atomic write 一步到位。原来的 existsSync+read+write 存在 race,并发可能半写坏。
      const prev = hostFs.existsSync(fp) ? hostFs.readFileSync(fp, "utf8").trim() : "";
      const next = installDir.replace(/\\/g, "/");
      if (prev.replace(/\\/g, "/").toLowerCase() !== next.toLowerCase()) {
        atomicWriteSync(fp, `${next}\n`, "utf8");
      }
      if (!process.env.DSH_DESKTOP_INSTALL) process.env.DSH_DESKTOP_INSTALL = installDir;
    } catch {
      // 非致命
    }
  }

  return { ensureHostClean, restartSealedDesktopIfNeeded, rememberDesktopInstallForHandoff };
}
