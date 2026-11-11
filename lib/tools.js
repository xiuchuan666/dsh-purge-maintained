// 三个模型工具的注册：purge_status / purge_apply / purge_revert。
//
// 为什么单独成文件：与 commands.js 同理——以前只有「apply 跑完」这一层
// 覆盖，工具名、parameters schema、output schema 全是盲区。schema 写错的
// 后果很具体：additionalProperties 忘了写 false，模型就开始编参数，宿主
// 在调用前拦掉，用户看到的是「工具用不了」而不是「schema 错」。
//
// deps 里注入 core 与两个 index.js 内的函数（renderStatus / rejectIfNeedPrompt），
// 是为了让测试用假实现跑通所有分支，不必真去改宿主文件。

/**
 * 三个工具的 spec 表，顺序即注册顺序。
 *
 * execute 里的分支（没有宿主目录、需要提示词确认、成功）全靠 deps 注入，
 * 因此在没有装 dsh 的机器上也能跑。
 */
export function toolSpecs(deps) {
  const { core, renderStatus, rejectIfNeedPrompt } = deps
  const specs = []
  const reg = (spec) => specs.push(spec)
  reg({
    name: "purge_status",
    description: `查看 dsh 指令权威性清洗状态（${core.ALL_PATCHES.length} patch 清洗进度、shim 注入、override 文件）。`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    async execute() {
      const state = await core.gatherState();
      return { text: renderStatus(state) };
    },
  });
  reg({
    name: "purge_apply",
    description: `应用 dsh 指令权威性清洗：${core.ALL_PATCHES.length} patch（提示词层+代码默认+引擎级审批/沙箱绕过）+ shim 注入 + override 文件。需重启 dsh 完全生效。`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    async execute() {
      core.applyRuntimeEnv();
      const scrubbed = core.sanitizeDesktopCommandRuntimes();
      const state = await core.gatherState();
      if (!state.ai_base) return { text: "ERROR: " + core.missingAiBaseMessage() };
      const blocked = rejectIfNeedPrompt(state.dsh_home);
      if (blocked) return { text: "ERROR: " + blocked.error };
      const toolMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
        preserveClientBundles: false,
        forApply: true,
      });
      await core.patchAllShims();
      const flash = core.silenceCmdFlash(toolMulti.hosts[0]?.aiBase || state.ai_base);
      const report = toolMulti.report;
      const applied = report.filter((r) => r.status === "applied").length;
      const already = report.filter((r) => r.status === "already").length;
      const scrubNote = scrubbed.length ? ` desktop_scrub=${scrubbed.length}` : "";
      return { text: `清洗完成 / applied=${applied}, already=${already}.${scrubNote} phase-1=${flash.phase1} 重启 dsh 生效.` };
    },
  });
  reg({
    name: "purge_revert",
    description: "回滚 dsh 指令权威性清洗到备份原件（保留 prompt-inject.md 用户文件）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    async execute() {
      const state = await core.gatherState();
      const lines = [];
      if (state.ai_base) {
        const { reverted, errors } = await core.revertAll(state.ai_base);
        lines.push(`reverted=${reverted.length}${errors.length ? ` errors=${errors.length}` : ""}`);
      }
      const shimRevert = await core.revertAllShims();
      lines.push(`shim_dirs=${Object.keys(shimRevert).length}`);
      return { text: `回滚完成 / ${lines.join(", ")}. 重启 dsh 恢复.` };
    },
  });
  return specs
}

/**
 * 把三个工具注册到宿主，返回注册结果数组。
 *
 * ctx.tools 不存在时返回空数组：老宿主没有 tools 服务，插件要能降级成
 * 「只有命令没有工具」，而不是整个 apply 抛错。
 */
export function registerModelTools(ctx, deps) {
  if (!ctx?.tools) return []
  return toolSpecs(deps).map((spec) => ctx.tools.register(spec))
}
