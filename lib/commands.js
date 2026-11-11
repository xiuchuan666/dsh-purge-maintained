// 聊天命令注册：/purge /rules /skills /rewind 四条，撞名时退到备用名。
//
// 为什么单独成文件：这段逻辑以前埋在 lib/index.js 的 apply() 里，只有
// 「apply 能跑完」这一层被间接覆盖。命令名写错、备用名被删、description
// 改坏、handler 接错参数，全都不会有人发现。抽出来之后用一个假的 commands
// 对象就能直接跑，不需要宿主。
//
// 历史背景（#162）：宿主里别的插件可能已经占了 /purge 这类短名，注册会抛
// 「already registered」。逐条 try/catch 是为了只丢撞名那一条，而不是让
// 整个 apply 失败——否则一个插件就能让 dsh-purge 完全不上班。

export function isDuplicateCommandError(error) {
  return /is already registered|already registered/i.test(String(error && error.message || error));
}

/** 逐命令注册：撞名只丢那一条，可退到备用名（#162）。 */
export function tryRegisterCommand(commands, spec, fallbacks = []) {
  const names = [spec.name, ...fallbacks];
  for (const name of names) {
    try {
      commands.register({ ...spec, name });
      if (name !== spec.name) {
        console.warn(`[dsh-purge] /${spec.name} taken, registered /${name}`);
      }
      return name;
    } catch (error) {
      if (isDuplicateCommandError(error)) continue;
      throw error;
    }
  }
  console.warn(`[dsh-purge] skip /${spec.name}: already registered`);
  return null;
}

/**
 * 四条命令的 spec 表，顺序即注册顺序。
 *
 * 抽成函数而不是常量：handler 需要 config / ctx / rewind，这些每次 apply
 * 都会变，写成常量就只能靠模块级可变状态，反而更难测。
 */
export function commandSpecs({ config, ctx, handlers, rewind }) {
  const specs = []
  const reg = (spec, fallbacks) => specs.push({ spec, fallbacks: fallbacks || [] })
  reg({
    name: "purge",
    description: "dsh 指令权威性清洗（status/apply/revert/uninstall/edit/help）",
    input: { hint: "status | apply | revert | uninstall | edit | help" },
    handler: async (invocation) => handlers.purge(invocation.rawInput ?? "", config, ctx),
  }, ["purge-cmd"]);
  reg({
    name: "rules",
    description: "规则集切换（写入 AGENTS.md/CLAUDE.md）: list | use <id> | create <id> [别名] [目标] | delete <id> | reset | help",
    input: { hint: "list | use <id> | create <id> [别名] [目标] | delete <id> | reset | help" },
    handler: async (invocation) => handlers.rules(invocation.rawInput ?? ""),
  }, ["purge-rules"]);
  reg({
    name: "skills",
    description: "官方用户 Skill（$DSH_HOME/skills）：list | import <路径> | create <id> [说明] | delete <id> | help",
    input: { hint: "list | import <路径> | create <id> [说明] | delete <id> | help" },
    handler: async (invocation) => handlers.skills(invocation.rawInput ?? ""),
  }, ["purge-skills"]);
  reg({
    name: "rewind",
    description: "回退：子代理直接回退一次；主代理 /rewind once 或 /rewind round",
    input: { hint: "once | round" },
    handler: async (invocation) => {
      const sessionId = rewind.invocationSessionId(invocation);
      const arg = String(invocation.rawInput || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
      const info = await rewind.analyzeRewind(ctx, sessionId);
      if (info.ok && info.kind === "main" && arg !== "once" && arg !== "round") {
        return {
          kind: "success",
          text: "主代理请选择：/rewind once 回退一次，/rewind round 回退上一轮（含本轮子代理）。",
        };
      }
      const mode = arg === "round" ? "round" : "once";
      const result = await rewind.applyRewind(ctx, sessionId, mode);
      if (!result.ok) return { kind: "error", text: result.error };
      return {
        kind: "success",
        text: mode === "round"
          ? "已回退上一轮。还在这条对话里，上一句已放回输入框。再发送时，之前的回复不会带上。"
          : "已回退一次。还在这条对话里，上一句已放回输入框。再发送时，之前的回复不会带上。",
      };
    },
  }, ["purge-rewind"]);
  return specs
}

/**
 * 注册全部四条命令，返回实际生效的名字。
 *
 * 撞名退到备用名时返回备用名，全部撞名返回 null——调用方不看返回值也能工作，
 * 返回值只给测试和日志用。
 */
export function registerChatCommands(commands, deps) {
  if (!commands) return []
  return commandSpecs(deps).map(({ spec, fallbacks }) => tryRegisterCommand(commands, spec, fallbacks))
}
