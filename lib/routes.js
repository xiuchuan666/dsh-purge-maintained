// 13 条 exact 路由的业务分支。
//
// 这些 handler 原来直接写在 lib/index.js 的 installWebServer 里，只有真正
// 跑起宿主、点开设置页才走得到，因此长期零测试。抽出来的目的不是「分层」，
// 是让每条路由的参数校验与守卫链能在假 request/response 上跑一遍——改错了的
// 表现是「点了没反应」，用户能立刻感知却拿不到任何报错。
//
// 重依赖（core / updater / uninstaller / rewind / hostctl / skills / reapply）
// 全部走注入，默认值就是真实模块，所以 lib/index.js 的调用方式不变。
import * as coreModule from "./core.js";
import * as hostModule from "./host.js";
import * as rewindModule from "./rewind.js";
import * as updaterModule from "./update.js";
import * as uninstallerModule from "./uninstall.js";
import * as skillsModule from "./skills.js";
import * as reapplyModule from "./reapply.js";
import { readDrillGrant, writeDrillGrant } from "./drill-grant.js";
import { readAllowText, writeAllowText } from "./net-scope.js";
import {
  beginApply,
  beginJob,
  endApply,
  getApplyProgress,
  resetApplyProgress,
  setApplyProgress,
} from "./apply-progress.js";
import { applyShouldRestart } from "./settle-policy.js";
import { readJsonBody, sendJson } from "./http.js";

/* P2-6b：安装真相。把 gatherState 里已经算好的结论原样带给面板和 CLI。
   旧字段 host_version / host_supported 保持不动，install_truth 只是新增视图。
   读不到的项一律是 null 或空串，原因留在 reasons 里 —— 绝不为了好看伪造 ok。 */
export function installTruthPayload(state, pluginVersion) {
  const s = state || {};
  const truth = s.installTruth && typeof s.installTruth === "object" ? s.installTruth : {};
  const slot = s.slotLength;
  const openSlot = s.openSlotLength;
  return {
    host_version: s.hostVersion || s.host_version || "",
    host_integrity: s.hostIntegrity || null,
    last_install: s.lastInstall || null,
    slot_length: Number.isFinite(slot) ? slot : null,
    open_slot_length: Number.isFinite(openSlot) ? openSlot : null,
    profile_version: s.profileVersion || "",
    plugin_version: pluginVersion || "",
    reasons: truth.reasons && typeof truth.reasons === "object" ? truth.reasons : {},
    resources: truth.resources || "",
    profile: truth.profile || "",
    profile_dir: truth.profileDir || "",
    plugin_dir: truth.pluginDir || "",
    journal_path: truth.journalPath || "",
  };
}

export function routeSpecs(deps = {}) {
  const core = deps.core || coreModule;
  const hostctl = deps.hostctl || hostModule;
  const rewind = deps.rewind || rewindModule;
  const updater = deps.updater || updaterModule;
  const uninstaller = deps.uninstaller || uninstallerModule;
  const skills = deps.skills || skillsModule;
  const reapply = deps.reapply || reapplyModule;
  // 两个跨请求标志：web 树是否就绪、上一次成功的 /status 载荷（进度期做底）。
  // 插件 ctx：rewind / hostctl / uninstaller 都要它（会话读写、重启排程）。
  const ctx = deps.ctx || null;
  const webState = deps.webState || { ready: false, lastStatusPayload: null };
  const setBootFullQuit = deps.setBootFullQuit || (() => {});
  // 只读回显用：/status 要把「是否需要整包退出」告诉面板，写侧走 setBootFullQuit。
  const getBootFullQuit = deps.getBootFullQuit || (() => false);
  const refreshHungOperator = deps.refreshHungOperator;
  const injectSnapshot = deps.injectSnapshot;
  const rejectIfNeedPrompt = deps.rejectIfNeedPrompt;
  const ensureRestartReady = deps.ensureRestartReady;
  return [
    {
      label: "dsh-purge: status",
      spec: {
        kind: "exact",
        path: "/dsh-purge/status",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            const progress = getApplyProgress();
            if (progress.active) {
              const base = webState.lastStatusPayload || { ok: true };
              sendJson(response, 200, {
                ...base,
                ok: true,
                ready: webState.ready || Boolean(webState.lastStatusPayload),
                apply_progress: progress,
              });
              return;
            }
            if (!webState.ready) {
              sendJson(response, 503, { ok: false, ready: false, apply_progress: progress });
              return;
            }
            const state = await core.gatherState();
            const patch_names = {};
            for (const p of core.ALL_PATCHES) patch_names[String(p.id)] = p.name;
            const payload = {
              ok: true,
              ready: true,
              surface: state.surface || hostctl.currentSurface(),
              ai_base: state.ai_base,
              desktop_install: state.desktop_install || "",
              desktop_exe: state.desktop_exe || "",
              asar_still_sealed: state.asar_still_sealed || false,
              missing_ai_base: state.ai_base ? "" : core.missingAiBaseMessage(),
              patches_applied: state.ai_base ? (state.display_applied ?? state.patches_applied) : 0,
              patches_pending: state.display_pending ?? state.patches_pending,
              patches_skipped: state.display_skipped ?? state.patches_skipped ?? 0,
              patches_drifted: state.display_drifted ?? state.patches_drifted ?? 0,
              patches_ready: state.display_ready ?? state.patches_ready ?? 0,
              patches_na: state.patches_na || 0,
              patches_total: state.ai_base ? (state.display_total ?? state.patches_total ?? 0) : 0,
              host_version: state.host_version || "",
              host_target: state.host_target || "",
              host_supported: state.host_supported !== false,
              patches_lost: reapply.patchesLostAfterHostReset(),
              patch_status: state.patch_status,
              patches: (state.display_patches || []).map((p) => ({
                id: p.id,
                ids: p.ids,
                layer: p.layer || "",
                status: p.status,
              })),
              patch_names,
              shim_cmd: state.shim_cmd,
              shim_ps1: state.shim_ps1,
              shim_bin: state.shim_bin,
              has_backup: state.has_backup,
              override_status: state.override_status,
              override_path: state.override_path,
              dsh_home: state.dsh_home,
              plugin_version: updater.localVersion(),
              install_truth: installTruthPayload(state, updater.localVersion()),
              boot_full_quit: getBootFullQuit(),
              update: updater.lastUpdateResult(),
              ...updater.channelPublic(),
              hooks_deny_bypass: core.getHooksDenySettings().hooksDenyBypass,
              ...(await skills.skillsStatus(core.findDshHome()).catch(() => ({ skills: [] }))),
            };
            webState.lastStatusPayload = payload;
            sendJson(response, 200, { ...payload, apply_progress: progress });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e), apply_progress: getApplyProgress() });
          }
        },
      },
    },
    {
      label: "dsh-purge: hooks-deny",
      spec: {
        kind: "exact",
        path: "/dsh-purge/hooks-deny",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              const settings = core.refreshHooksDenySettings();
              sendJson(response, 200, { ok: true, hooksDenyBypass: settings.hooksDenyBypass });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              if (typeof body?.hooksDenyBypass !== "boolean") {
                sendJson(response, 400, { ok: false, error: "hooksDenyBypass must be boolean" });
                return;
              }
              const saved = core.setHooksDenySettings({ hooksDenyBypass: body.hooksDenyBypass });
              sendJson(response, 200, { ok: true, hooksDenyBypass: saved.hooksDenyBypass });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      },
    },
    {
      label: "dsh-purge: last user",
      spec: {
        kind: "exact",
        path: "/dsh-purge/last-user",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            const url = new URL(request.url, "http://127.0.0.1");
            const sessionId = String(url.searchParams.get("sessionId") || "").trim();
            sendJson(response, 200, await rewind.readLastUserText(ctx, sessionId));
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      },
    },
    {
      label: "dsh-purge: rewind options",
      spec: {
        kind: "exact",
        path: "/dsh-purge/rewind/options",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            const url = new URL(request.url, "http://127.0.0.1");
            const sessionId = String(url.searchParams.get("sessionId") || "").trim();
            sendJson(response, 200, await rewind.analyzeRewind(ctx, sessionId));
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      },
    },
    {
      label: "dsh-purge: rewind",
      spec: {
        kind: "exact",
        path: "/dsh-purge/rewind",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              const url = new URL(request.url, "http://127.0.0.1");
              const sessionId = url.searchParams.get("sessionId");
              if (sessionId) {
                const draft = rewind.takeDraft(sessionId);
                sendJson(response, 200, { ok: true, ...(draft || {}) });
                return;
              }
              const pending = rewind.getPending();
              sendJson(response, 200, { ok: true, ...(pending || {}) });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const sessionId = String(body?.sessionId || "").trim();
              if (!sessionId) {
                sendJson(response, 400, { ok: false, error: "需要 sessionId" });
                return;
              }
              const mode = body?.mode === "round" ? "round" : "once";
              const result = await rewind.applyRewind(ctx, sessionId, mode);
              sendJson(response, result.ok ? 200 : 409, result);
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      },
    },
    {
      label: "dsh-purge: update",
      spec: {
        kind: "exact",
        path: "/dsh-purge/update",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              sendJson(response, 200, await updater.checkUpdate());
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const result = await updater.handleUpdateOp(body || {});
              if (result && result.needsFullQuit) setBootFullQuit(true);
              sendJson(response, 200, result);
              if (result && result.restartAfter) {
                try { hostctl.scheduleRestart(request, ctx); } catch (e) {
                  console.warn("[dsh-purge] update restart failed:", e);
                }
              }
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      },
    },
    {
      label: "dsh-purge: apply",
      spec: {
        kind: "exact",
        path: "/dsh-purge/apply",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          beginApply("home");
          try {
            const body = await readJsonBody(request);
            const incoming = typeof body?.content === "string" ? body.content : null;
            core.applyRuntimeEnv();
            core.clearDesktopLocateCache();
            const home = core.pinDshHome();
            const scrubbed = core.sanitizeDesktopCommandRuntimes();
            const state = await core.gatherState();
            if (home) state.dsh_home = home;
            let located;
            setApplyProgress({ stage: "locate" });
            try {
              located = await core.resolveOfficialAiBase(state.ai_base, { forApply: true });
            } catch (e) {
              endApply({ stage: "locate", error: String(e && e.message ? e.message : e) });
              sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
              return;
            }
            if (!located.aiBase) {
              endApply({ stage: "locate", error: "no_base" });
              sendJson(response, 500, { ok: false, error: core.missingAiBaseMessage() });
              return;
            }
            state.ai_base = located.aiBase;
            if (located.extracted) {
              const arch = located.handoff?.archive;
              if (arch) core.writeUnpackedAsarStamp(arch);
            }
            const handoff = located.handoff && located.handoff.swapAsar ? located.handoff : null;
            const blocked = rejectIfNeedPrompt(state.dsh_home, incoming === null ? undefined : incoming);
            if (blocked) {
              resetApplyProgress();
              const ui = await core.readOverrideForUi(state.dsh_home);
              sendJson(response, 400, {
                ok: false,
                needPrompt: true,
                override_content: incoming || "",
                defaultContent: ui.defaultContent,
                ...blocked,
              });
              return;
            }
            setApplyProgress({ stage: "override" });
            try {
              await core.commitOverrideOnApply(state.dsh_home, incoming);
            } catch (e) {
              console.warn("[dsh-purge] apply override:", String(e && e.message ? e.message : e));
            }
            setApplyProgress({ stage: "patch" });
            const httpMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
              preserveClientBundles: false,
              forApply: true,
              onHost(info) {
                setApplyProgress({
                  stage: "patch",
                  applied: info.index || 0,
                  detail: info.aiBase || "",
                });
              },
            });
            const report = httpMulti.report;
            setApplyProgress({ stage: "shim" });
            const shim = await core.patchAllShims();
            let cliRepair = null;
            try {
              cliRepair = core.repairOfficialCliAfterUnpack();
            } catch (e) {
              cliRepair = { ok: false, error: String(e && e.message ? e.message : e) };
            }
            setApplyProgress({ stage: "flash" });
            const flash = core.silenceCmdFlash(httpMulti.hosts[0]?.aiBase || state.ai_base);
            const summary = core.summarizeApplyReport(report);
            const hostWritten =
              core.allPatchHostsWritten(httpMulti.hosts) || core.hostCleanMarkersPresent(state.ai_base);
            const hookDenyRestoreFailed = (httpMulti.hookDenyRestoreFailed || []).length > 0;
            const complete = summary.failed.length === 0 && flash.ok === true && hostWritten && !hookDenyRestoreFailed;
            const sealedNow = core.desktopAsarStillSealed();
            const promptReady = summary.failed.length > 0 && summary.failed.every((item) => item.status === "pattern_not_found");
            if (flash.ok === true && (complete || promptReady) && hostWritten) {
              reapply.markPatchesApplied();
            }
            // 全部洗完且标记进宿主才弹重启；密封包重启时换走 asar。
            const shouldRestart = applyShouldRestart({
              complete: complete || (promptReady && hostWritten),
              sealed: sealedNow,
              appliedCount: summary.applied,
              promptReady: promptReady && hostWritten,
            });
            if (shouldRestart && handoff && sealedNow) setBootFullQuit(true);
            else setBootFullQuit(false);
            if (shouldRestart) reapply.markSettleRestart();
            let promptInjectInstall = "skipped";
            setApplyProgress({ stage: "seed" });
            if (hostWritten && flash.ok === true) {
              // Apply → cleanup → restart 成功后，默认把加密提示词 seed 进 prompt-inject.md。
              // 用户自改过的内容保留；仅当文件不存在或仍是插件旧默认时才写。
              try {
                const seed = core.seedPromptInjectAtBoot(state.dsh_home);
                promptInjectInstall = seed?.action || "noop";
              } catch (e) {
                promptInjectInstall = `error:${String(e && e.message ? e.message : e)}`;
              }
            }
            const hung = refreshHungOperator(state.dsh_home);
            const override = await core.readOverrideForUi(state.dsh_home);
            endApply({
              stage: "done",
              error: complete || (promptReady && hostWritten) ? "" : "incomplete",
            });
            sendJson(response, 200, {
              ok: true,
              complete,
              restarting: shouldRestart,
              restart_after_apply: shouldRestart,
              unpacked_asar: shouldRestart,
              needs_full_quit: shouldRestart,
              asar_still_sealed: sealedNow,
              asar_swap_started: Boolean(shouldRestart && handoff && sealedNow),
              applied: summary.applied,
              already: summary.already,
              failed: summary.failed.length,
              failed_items: summary.failed.map((r) => ({
                id: r.patch_id,
                name: r.name,
                status: r.status,
              })),
              report: report.map((r) => ({ id: r.patch_id, name: r.name, status: r.status })),
              override_content: hung.text || override.content,
              defaultContent: override.defaultContent,
              ...injectSnapshot(state.dsh_home),
              override_path: override.path,
              override_installed: promptInjectInstall,
              shim,
              desktop_scrubbed: scrubbed,
              cli_repair: cliRepair,
              cmd_flash: flash,
            });
          } catch (e) {
            endApply({ error: String(e && e.message ? e.message : e) });
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      },
    },
    {
      label: "dsh-purge: revert",
      spec: {
        kind: "exact",
        path: "/dsh-purge/revert",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          beginJob("revert", "locate");
          try {
            const state = await core.gatherState();
            const result = {};
            setApplyProgress({ kind: "revert", stage: "revert" });
            if (state.ai_base) {
              const { reverted, errors } = await core.revertAll(state.ai_base);
              result.reverted = reverted.length;
              result.errors = errors.length;
            }
            setApplyProgress({ kind: "revert", stage: "shim" });
            result.shim = await core.revertAllShims();
            endApply({
              kind: "revert",
              stage: "done",
              error: result.errors ? "incomplete" : "",
            });
            sendJson(response, 200, { ok: true, ...result, note: "重启 dsh 恢复; prompt-inject.md 保留" });
          } catch (e) {
            endApply({ kind: "revert", error: String(e && e.message ? e.message : e) });
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      },
    },
    {
      label: "dsh-purge: uninstall",
      spec: {
        kind: "exact",
        path: "/dsh-purge/uninstall",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          beginJob("uninstall", "locate");
          try {
            const result = await uninstaller.uninstallPurge({
              onStage(stage) {
                setApplyProgress({ kind: "uninstall", stage });
              },
            });
            endApply({
              kind: "uninstall",
              stage: "done",
              error: result.ok ? "" : (result.errors && result.errors[0]) || "incomplete",
            });
            sendJson(response, result.ok ? 200 : 500, {
              ...result,
              surface: hostctl.currentSurface(),
              fullApp: hostctl.currentSurface() === "desktop",
              note: result.ok ? hostctl.restartNote() : undefined,
            });
            if (result.ok) {
              uninstaller.scheduleCleanupRestart({
                request,
                cleanup: result.cleanup,
                ctx,
              });
            }
          } catch (e) {
            endApply({ kind: "uninstall", error: String(e && e.message ? e.message : e) });
            sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
          }
        },
      },
    },
    {
      label: "dsh-purge: drill-grant",
      spec: {
        kind: "exact",
        path: "/dsh-purge/drill-grant",
        handler: async (request, response) => {
          const home = core.findDshHome();
          if (request.method === "GET") {
            sendJson(response, 200, { ok: true, ...readDrillGrant(home) });
            return;
          }
          if (request.method === "POST") {
            sendJson(response, 200, { ok: true, ...writeDrillGrant(home) });
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      },
    },
    {
      label: "dsh-purge: override",
      spec: {
        kind: "exact",
        path: "/dsh-purge/override",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              const home = core.findDshHome();
              // 面板打开 override 面板时，确保默认加密提示词已 seed；用户自改保留。
              try { core.seedPromptInjectAtBoot(home); } catch { /* ignore */ }
              refreshHungOperator(home);
              const ui = await core.readOverrideForUi(home);
              sendJson(response, 200, { ok: true, ...ui, ...injectSnapshot(home) });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const content = typeof body?.content === "string" ? body.content : null;
              if (content === null) {
                sendJson(response, 400, { ok: false, error: "content must be a string" });
                return;
              }
              const home = core.findDshHome();
              const blocked = rejectIfNeedPrompt(home, content);
              if (blocked) {
                sendJson(response, 400, {
                  ok: false,
                  content,
                  ...blocked,
                });
                return;
              }
              const saved = await core.saveOverrideContent(home, content);
              const hung = refreshHungOperator(home);
              const ui = await core.readOverrideForUi(home);
              sendJson(response, 200, {
                ok: true,
                content: hung.text,
                defaultContent: saved.defaultContent,
                customized: ui.customized,
                usingDefault: ui.usingDefault,
                path: ui.path,
                ...injectSnapshot(home),
              });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      },
    },
    {
      label: "dsh-purge: own-servers",
      spec: {
        kind: "exact",
        path: "/dsh-purge/own-servers",
        handler: async (request, response) => {
          const home = core.findDshHome();
          if (request.method === "GET") {
            sendJson(response, 200, { ok: true, content: readAllowText(home) });
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const content = typeof body?.content === "string" ? body.content : null;
              if (content === null) {
                sendJson(response, 400, { ok: false, error: "content must be a string" });
                return;
              }
              const saved = await writeAllowText(home, content);
              sendJson(response, 200, { ok: true, content: saved.text, dropped: saved.dropped });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      },
    },
    {
      label: "dsh-purge: restart",
      spec: {
        kind: "exact",
        path: "/dsh-purge/restart",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            const ready = await ensureRestartReady();
            if (!ready.ok) {
              setBootFullQuit(false);
              sendJson(response, 200, {
                ok: false,
                error: ready.error || "清洗没有完成，已取消重启",
                restarting: false,
                pending: ready.pending || [],
              });
              return;
            }
            const surface = hostctl.currentSurface();
            let planned = null;
            if (core.desktopAsarStillSealed()) {
              planned = core.restartSealedDesktopIfNeeded({ ctx });
            } else {
              planned = hostctl.scheduleRestart(request, ctx);
            }
            if (planned && planned.clean === false) {
              setBootFullQuit(false);
              sendJson(response, 200, {
                ok: false,
                error: "清洗没有写进当前宿主，已取消重启",
                restarting: false,
              });
              return;
            }
            // 用户已点重启：清掉粘性标记，避免同进程误刷新/再进面板又弹一次。
            setBootFullQuit(false);
            const restarting = Boolean(planned && (planned.restarting || planned.asarSwap));
            const restartError = planned && planned.error ? String(planned.error) : "";
            sendJson(response, 200, {
              ok: restarting || !restartError,
              surface,
              fullApp: surface === "desktop",
              restarting,
              already: Boolean(planned && planned.already),
              needsFullQuit: Boolean(planned && planned.asarSwap),
              asar_still_sealed: core.desktopAsarStillSealed(),
              error: restartError || undefined,
              note: restarting ? "正在重启。" : restartError,
            });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      },
    },
  ];
}
