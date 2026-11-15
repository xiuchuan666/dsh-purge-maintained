# 补丁影响矩阵（哪个补丁坏了，谁替它作证）

> 生成：`npm run impact:patches`；基线 `docs/host-baseline.json`（86 条）、闸表 `docs/patch-gates.json`（86 行）、行为验证 `scripts/patch-behaviors.mjs`（15 个场景）。
> rc 预演判定来自 `.tmp-rehearse/rc3.json`（86 条有判定）。

合计：**86** 条补丁；行为级验证 **12** 条；进闸表 **86** 条；行为+闸表双证 **12** 条；只有文件标记、无外部证据 **0** 条。

| # | 补丁 | 层 | 宿主文件（rel） | 基线 | 行为 | 闸表 | 预演 |
|---|---|---|---|---|---|---|---|
| 1 | WORKSPACE_CONTEXT_INTRO | 提示词 | agent-instructions （lib/index.js） | settled |  | ✓ | applied |
| 2 | REPLACEMENT_WORKSPACE_CONTEXT_INTRO | 提示词 | agent-instructions （lib/index.js） | settled |  | ✓ | native |
| 3 | SCOPE_INTRO | 提示词 | agent-instructions （lib/index.js） | settled |  | ✓ | native |
| 4 | SYSTEM_PROMPT_PERSONA | 提示词 | agent-preset + web-app + headless + preset-acp-app + preset-sdk-app （.agent-presets/unrestricted/agent.cordis.yml） | settled |  | ✓ | applied |
| 5 | APPROVAL_NEVER_SENTENCE | 提示词 | user-approval + user-approval-invariant （lib/types/index.js） | settled |  | ✓ | applied |
| 6 | SANDBOX_DENY_FILE_WRITE | 代码 | sandbox-local （lib/index.js） | settled |  | ✓ | applied |
| 7 | SANDBOX_MODE_DEFAULT | 代码 | base （cordis.patch.yml） | settled |  | ✓ | applied |
| 8 | APPROVAL_POLICY_DEFAULT | 代码 | base （cordis.patch.yml） | settled |  | ✓ | applied |
| 9 | APPROVAL_AUTO_GRANT | 代码 | user-approval-code + user-approval-invariant + user-approval （lib/index.js） | settled | ✓ | ✓ | applied |
| 10 | APPROVAL_CONFIG_DEFAULT_NEVER | 代码 | user-approval-code （lib/index.js） | settled | ✓ | ✓ | applied |
| 11 | APPROVAL_NEVER_SENTENCE_BYPASS | 提示词 | user-approval-code （lib/index.js） | settled |  | ✓ | applied |
| 12 | APPROVAL_ASK_SENTENCE_BYPASS | 提示词 | user-approval-code + user-approval + user-approval-invariant （lib/index.js） | settled |  | ✓ | applied |
| 13 | ESCALATION_WIDENING_EXEMPT | 代码 | escalation （lib/index.js） | settled | ✓ | ✓ | applied |
| 14 | ESCALATION_GRANT_UNCONDITIONAL | 代码 | escalation （lib/index.js） | settled | ✓ | ✓ | applied |
| 15 | SANDBOX_CONFINE_PASSTHROUGH | 代码 | sandbox-local （lib/index.js） | settled |  | ✓ | applied |
| 16 | FS_FENCE_DISABLED | 代码 | fs-sandbox （lib/index.js） | settled |  | ✓ | applied |
| 17 | FS_OBSERVATION_INTENT_FREE | 代码 | fs-observation-policy （lib/index.js） | settled |  | ✓ | applied |
| 18 | REPEAT_TOOL_REMINDER_DISABLED | 代码 | repeat-tool-reminder （lib/index.js） | settled |  | ✓ | applied |
| 19 | TOOL_RESULT_PRUNER_DISABLED | 代码 | compaction-tool-result-pruner （lib/index.js） | settled |  | ✓ | applied |
| 21 | BASH_TIMEOUT_RESTORE | 代码 | base （cordis.patch.yml） | settled |  | ✓ | na |
| 22 | READ_CAPS_RAISED | 代码 | tool-fs （lib/index.js） | settled | ✓ | ✓ | applied |
| 23 | SUBAGENT_MAXDEPTH_RAISED | 代码 | subagent + tool-subagent （lib/index.js） | settled | ✓ | ✓ | applied |
| 24 | PRESET_FETCH_ENABLED | 代码 | preset-unrestricted + preset-standard + preset-cordis + preset-ptc + preset-liangshen + preset-liangshen-pkg （agent.cordis.yml） | settled |  | ✓ | native |
| 25 | HARNESS_IDENTITY_STRIP | 提示词 | system-prompt | settled |  | ✓ | applied |
| 26 | MINIMAL_PERSONA_PURGE | 提示词 | preset-minimal + preset-sdk-minimal | settled |  | ✓ | applied |
| 28 | LIANGSHEN_PHASE1_KEEP_INJECT | 提示词 | liangshen-tool-bootstrap | no-file |  | ✓ | na |
| 29 | TOOL_WEB_UNTRUSTED_NEUTRAL | 工具 | tool-web + tool-web-nested | settled |  | ✓ | applied |
| 30 | HOOKS_CLAUDE_DENY_ALLOW | 工具 | hooks-claude-code + hooks-claude-code-nested | no-file |  | ✓ | na |
| 31 | HOOKS_CODEX_DENY_ALLOW | 工具 | hooks-codex + hooks-codex-nested | no-file |  | ✓ | na |
| 32 | WEB_SURFACE_IDENTITY_NEUTRAL | 提示词 | web-app-lib + harness-dev-context | settled |  | ✓ | applied |
| 33 | TOOL_SHELL_DENIAL_PROMPT | 提示词 | tool-bash + tool-pwsh | settled |  | ✓ | applied |
| 34 | SANDBOX_HINT_NEUTRAL | 提示词 | escalation | settled | ✓ | ✓ | applied |
| 35 | ESCALATION_NEVER_REJECT | 代码 | escalation | settled | ✓ | ✓ | applied |
| 36 | TOOL_FS_ESCALATION_SCHEMA | 提示词 | tool-fs + escalation + tool-bash + tool-pwsh | settled | ✓ | ✓ | applied |
| 37 | SUBAGENT_SCOPE_LOCK_NEUTRAL | 提示词 | subagent + subagent-types | settled |  | ✓ | applied |
| 38 | PERSONA_TEXT_PREFIX_ALIAS | 代码 | persona | settled | ✓ | ✓ | applied |
| 39 | SESSION_V0_PLUGIN_SUMMARY_ALIAS | 代码 | session-format-v0 | settled |  | ✓ | applied |
| 40 | COMPLETE_PROMPT_KEEP_INJECT | 0.1.5 兼容 | system-prompt + system-prompt-nested | settled |  | ✓ | applied |
| 42 | SETTINGS_LEGACY_API | 代码 | settings （lib/index.js） | settled | ✓ | ✓ | applied |
| 43 | WEB_PRESET_IDENTITY_STRIP | 提示词 | preset-standard + preset-ptc + preset-cordis + preset-minimal | settled |  | ✓ | applied |
| 45 | OFFICIAL_DESKTOP_UPDATE_HANDOFF | 代码 | desktop-shell | settled |  | ✓ | na |
| 46 | OFFICIAL_DESKTOP_UPDATE_ASCII | 代码 | desktop-shell | settled |  | ✓ | na |
| 47 | ANTHROPIC_OAUTH_NO_CLAUDE_IDENTITY | 0.2.0 兼容 | pi-ai-anthropic-messages | settled |  | ✓ | applied |
| 48 | TOOL_SHELL_DELETE_MOVE_NEUTRAL | 工具 | tool-bash + tool-pwsh | settled |  | ✓ | applied |
| 49 | ANTHROPIC_OAUTH_CLI_NEUTRAL | 0.2.0 兼容 | pi-ai-anthropic-messages | settled |  | ✓ | applied |
| 50 | SESSION_REFERENCE_FRAMING_NEUTRAL | 提示词 | session-reference | settled |  | ✓ | applied |
| 51 | FRESH_SESSION_FULL_ACCESS | 代码 | permission-presets + permission-presets-types | settled | ✓ | ✓ | applied |
| 52 | SESSION_LOG_UPLOAD_DEFAULT_OFF | 代码 | session-log-deepseek + session-log-deepseek-types | settled |  | ✓ | applied |
| 53 | WEB_SURFACE_PROHIBITION | 提示词 | web-app-lib + harness-dev-context | settled |  | ✓ | applied |
| 54 | DELIVERABLE_DO_NOT | 提示词 | deliverables-prompt-v2 + deliverables-prompt | settled |  | ✓ | applied |
| 55 | SYSTEM_PROMPT_REPLACE_HEAD | 代码 | agent-loop | settled |  | ✓ | applied |
| 56 | REWIND_HIDE_CUT_ONLY | 代码 | conversation-client | settled |  | ✓ | applied |
| 57 | DEEPSEEK_SYSTEM_ROLE | 代码 | pi-ai-completions + pi-ai-responses-shared | settled |  | ✓ | applied |
| 58 | REWIND_SKIP_DERIVE | 代码 | session | settled |  | ✓ | applied |
| 59 | OFFICIAL_AUTO_REVIEW_PASSTHROUGH | 代码 | auto-review | settled |  | ✓ | applied |
| 60 | OFFICIAL_RUN_CODE_APPROVAL_NEUTRAL | 工具 | tool-executor-ptc + tool-executor-ptc-types + dsh-tools + dsh-tools-ptc | settled |  | ✓ | applied |
| 61 | OFFICIAL_SANDBOX_POLICY_NEUTRAL | 提示词 | sandbox-policy | settled |  | ✓ | applied |
| 62 | OFFICIAL_TOOL_ASK_FAILOPEN | 代码 | dsh-tools-pipeline + dsh-tools-pipeline-types + dsh-tools + dsh-tools-types | settled |  | ✓ | applied |
| 63 | OFFICIAL_PLAN_MODE_NEUTRAL | 提示词 | base + preset-ptc + preset-standard + preset-cordis | settled |  | ✓ | applied |
| 64 | HOOKS_STOP_STEER_NEUTRAL | 工具 | hooks-claude-code + hooks-claude-code-nested + hooks-codex + hooks-codex-nested | no-file |  | ✓ | na |
| 65 | HOOKS_PRESTEP_REJECT_NEUTRAL | 工具 | hooks-claude-code + hooks-claude-code-nested + hooks-codex + hooks-codex-nested | no-file |  | ✓ | na |
| 66 | SYSTEM_PROMPT_RENDER_GUARD | 代码 | system-prompt + system-prompt-nested | settled |  | ✓ | applied |
| 67 | AGENT_LOOP_MESSAGES_GUARD | 代码 | agent-loop | settled |  | ✓ | applied |
| 68 | SYSTEM_NODES_CONTENT_GUARD | 代码 | agent-loop + session | settled |  | ✓ | applied |
| 69 | MODEL_STREAM_RELEASE | 代码 | llm-deepseek | settled |  | ✓ | applied |
| 70 | PRESET_SHELL_NETWORK | 提示词 | preset-minimal + preset-sdk-minimal | settled |  | ✓ | applied |
| 71 | LIANGSHEN_IDENTITY_LINE | 提示词 | preset-liangshen + preset-liangshen-pkg | no-file |  | ✓ | na |
| 72 | MESSAGES_SYSTEM_CURRENT | 代码 | llm-deepseek | settled |  | ✓ | applied |
| 73 | PRESET_BASH_MIRROR_LINE | 提示词 | preset-minimal + preset-sdk-minimal | settled |  | ✓ | applied |
| 74 | ASSEMBLE_BEFORE_PRESTEP | 代码 | agent-loop | settled |  | ✓ | applied |
| 75 | REWIND_RESET_TODOS | 代码 | tool-todo | settled |  | ✓ | applied |
| 76 | PRESET_UNRESTRICTED_IDENTITY_STRIP | 提示词 | preset-unrestricted | no-file |  | ✓ | na |
| 77 | REWIND_DROP_SENT_ON_APPEND | 代码 | conversation-client | settled |  | ✓ | applied |
| 78 | OVERLAY_RESTORE_FROM_BAK | 代码 | app-boot | settled |  | ✓ | applied |
| 80 | MINIMAL_OFFICIAL_TOOLSET | 工具 | preset-minimal + preset-sdk-minimal | settled |  | ✓ | na |
| 82 | DESKTOP_SHELL_PROFILE_FALLBACK | 代码 | desktop-shell | settled |  | ✓ | na |
| 83 | DESKTOP_HOST_CLOSE_NO_FATAL | 代码 | desktop-shell | settled |  | ✓ | na |
| 84 | DESKTOP_HOST_CLOSE_CODE0_NO_FAIL | 代码 | desktop-shell | settled |  | ✓ | na |
| 85 | SESSION_PROMPT_ALWAYS_FOLLOWUP | 代码 | api-session-controller | settled |  | ✓ | applied |
| 86 | SESSION_QUEUE_STEER_INTERRUPT | 代码 | api-session-controller + agent-loop | settled |  | ✓ | applied |
| 87 | HUNG_PROMPT_LF_NEEDLE | 代码 | agent-loop | settled |  | ✓ | applied |
| 88 | HUNG_PROMPT_STRICT_NEEDLE | 代码 | agent-loop | settled |  | ✓ | applied |
| 89 | SANDBOX_POLICY_BRAND_NEUTRAL | 提示词 | sandbox-policy | settled |  | ✓ | applied |
| 90 | SKILL_BADGE_DESCRIPTION_NEUTRAL | 提示词 | skill-badge | settled |  | ✓ | applied |
| 92 | DESKTOP_HOST_EXIT_TRACE | 代码 | desktop-shell | settled |  | ✓ | na |
| 93 | DESKTOP_MAIN_EXIT_TRACE | 代码 | desktop-shell | settled |  | ✓ | na |

## 行为验证缺口（按层）

- **提示词** 25 条无行为断言：#1 WORKSPACE_CONTEXT_INTRO、#2 REPLACEMENT_WORKSPACE_CONTEXT_INTRO、#3 SCOPE_INTRO、#4 SYSTEM_PROMPT_PERSONA、#5 APPROVAL_NEVER_SENTENCE、#11 APPROVAL_NEVER_SENTENCE_BYPASS、#12 APPROVAL_ASK_SENTENCE_BYPASS、#25 HARNESS_IDENTITY_STRIP、#26 MINIMAL_PERSONA_PURGE、#28 LIANGSHEN_PHASE1_KEEP_INJECT、#32 WEB_SURFACE_IDENTITY_NEUTRAL、#33 TOOL_SHELL_DENIAL_PROMPT、#37 SUBAGENT_SCOPE_LOCK_NEUTRAL、#43 WEB_PRESET_IDENTITY_STRIP、#50 SESSION_REFERENCE_FRAMING_NEUTRAL、#53 WEB_SURFACE_PROHIBITION、#54 DELIVERABLE_DO_NOT、#61 OFFICIAL_SANDBOX_POLICY_NEUTRAL、#63 OFFICIAL_PLAN_MODE_NEUTRAL、#70 PRESET_SHELL_NETWORK、#71 LIANGSHEN_IDENTITY_LINE、#73 PRESET_BASH_MIRROR_LINE、#76 PRESET_UNRESTRICTED_IDENTITY_STRIP、#89 SANDBOX_POLICY_BRAND_NEUTRAL、#90 SKILL_BADGE_DESCRIPTION_NEUTRAL
- **代码** 38 条无行为断言：#6 SANDBOX_DENY_FILE_WRITE、#7 SANDBOX_MODE_DEFAULT、#8 APPROVAL_POLICY_DEFAULT、#15 SANDBOX_CONFINE_PASSTHROUGH、#16 FS_FENCE_DISABLED、#17 FS_OBSERVATION_INTENT_FREE、#18 REPEAT_TOOL_REMINDER_DISABLED、#19 TOOL_RESULT_PRUNER_DISABLED、#21 BASH_TIMEOUT_RESTORE、#24 PRESET_FETCH_ENABLED、#39 SESSION_V0_PLUGIN_SUMMARY_ALIAS、#45 OFFICIAL_DESKTOP_UPDATE_HANDOFF、#46 OFFICIAL_DESKTOP_UPDATE_ASCII、#52 SESSION_LOG_UPLOAD_DEFAULT_OFF、#55 SYSTEM_PROMPT_REPLACE_HEAD、#56 REWIND_HIDE_CUT_ONLY、#57 DEEPSEEK_SYSTEM_ROLE、#58 REWIND_SKIP_DERIVE、#59 OFFICIAL_AUTO_REVIEW_PASSTHROUGH、#62 OFFICIAL_TOOL_ASK_FAILOPEN、#66 SYSTEM_PROMPT_RENDER_GUARD、#67 AGENT_LOOP_MESSAGES_GUARD、#68 SYSTEM_NODES_CONTENT_GUARD、#69 MODEL_STREAM_RELEASE、#72 MESSAGES_SYSTEM_CURRENT、#74 ASSEMBLE_BEFORE_PRESTEP、#75 REWIND_RESET_TODOS、#77 REWIND_DROP_SENT_ON_APPEND、#78 OVERLAY_RESTORE_FROM_BAK、#82 DESKTOP_SHELL_PROFILE_FALLBACK、#83 DESKTOP_HOST_CLOSE_NO_FATAL、#84 DESKTOP_HOST_CLOSE_CODE0_NO_FAIL、#85 SESSION_PROMPT_ALWAYS_FOLLOWUP、#86 SESSION_QUEUE_STEER_INTERRUPT、#87 HUNG_PROMPT_LF_NEEDLE、#88 HUNG_PROMPT_STRICT_NEEDLE、#92 DESKTOP_HOST_EXIT_TRACE、#93 DESKTOP_MAIN_EXIT_TRACE
- **工具** 8 条无行为断言：#29 TOOL_WEB_UNTRUSTED_NEUTRAL、#30 HOOKS_CLAUDE_DENY_ALLOW、#31 HOOKS_CODEX_DENY_ALLOW、#48 TOOL_SHELL_DELETE_MOVE_NEUTRAL、#60 OFFICIAL_RUN_CODE_APPROVAL_NEUTRAL、#64 HOOKS_STOP_STEER_NEUTRAL、#65 HOOKS_PRESTEP_REJECT_NEUTRAL、#80 MINIMAL_OFFICIAL_TOOLSET
- **0.1.5 兼容** 1 条无行为断言：#40 COMPLETE_PROMPT_KEEP_INJECT
- **0.2.0 兼容** 2 条无行为断言：#47 ANTHROPIC_OAUTH_NO_CLAUDE_IDENTITY、#49 ANTHROPIC_OAUTH_CLI_NEUTRAL

代码层没有行为断言 = 升级后只有文件标记能替它作证；提示词层大多是整句替换，标记就够，属正常。

## 怎么用

- **升级后先看「预演」列**：`stale`/`drifted` → 该补丁的锚点在新版本里变了；`native` → 上游自己改了，可以退场；`applied` → 照旧。
- **行为列为空**的补丁只有文件标记作证——标记在、行为未必在。改这些补丁的代码时，配一条 `scripts/patch-behaviors.mjs` 场景比补覆盖率更值。
- **闸表列为空**说明 `docs/patch-gates.json` 没有它的观测行；跑 `npm run host:gates` 看是不是被判成 `nativ*`/`no-file`。
- 改动任何补丁前，先 `npm run impact -- lib/patches/index.mjs` 看哪些测试会跟着响。
