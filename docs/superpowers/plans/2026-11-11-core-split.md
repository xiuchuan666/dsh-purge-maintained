# 补丁注册表拆分实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把补丁模板及四个数组迁出巨型 core.js，并保留真实产物等价与持续回归保护。

**Architecture:** `lib/patches/` 内按原数组职责分文件，模板 helper 单独导出；`index.mjs` 固定原展开顺序；core.js 只保留原公开 `ALL_PATCHES` 接口。回归通过随包基线快照的真实模块及真实补丁引擎做对象级对拍。

**Tech Stack:** Node.js 24、原生 ESM、node:assert/strict、无第三方依赖。

**Spec:** `docs/maintenance-core-split.md`

## Global Constraints

- 公开行为、补丁内容、补丁顺序与 `ALL_PATCHES` 消费方式均不改变。
- 不为整洁重排补丁 ID；只拆补丁注册表，不拆 core 尾段、index.js 或 desktop.js。
- 测试不得引入第二份补丁清单；以 `docs/origin/core-split-baseline-8066985/`（提交 `8066985` 的 core 及其 13 个相对依赖）作为本轮对拍参照，不依赖 Git 历史或 tar。
- 运行 `npm run check`、真实宿主 `verify-target --json` 和 `npm run host:status`；不写宿主。
- 用户授权本轮直接执行、提交并推送 main。

## Review Focus

- 正则的 source/flags 和函数 replace 在拆分后是否丢失；对象级对拍覆盖。
- 非 replacement 字段（patterns、marker、skipIfMarked 等）及数组元素属性是否一致；对象级对拍覆盖。
- 新模块是否被 package files 包含、打包后是否能独立导入；打包冒烟覆盖。
- core 的 CRLF 与补丁模块的 LF 是否保持原样；差异审查覆盖。
- 默认 check 没有宿主时不得依赖本机宿主状态；CI 的独立 check 覆盖。

### Task 1: 锁定拆分行为并完成维护记录

**Files:**
- Modify: `lib/core.js` 原 2541–6336 区域
- Create: `lib/patches/{templates,patch-registry,code-patches,engine-patches,new-tool-patches,index}.mjs`
- Create: `docs/origin/core-split-baseline-8066985/`（对拍快照，14 文件）
- Test: `scripts/test-patch-registry.mjs`
- Modify: `MAINTENANCE.md`
- Create: `docs/maintenance-core-split.md`, `docs/superpowers/plans/2026-11-11-core-split.md`

**Interfaces:**
- Consumes: `docs/origin/core-split-baseline-8066985/lib/core.js` 的 144 个导出及真实 `applyReplacementsToText(text, patch, fp = '')`。
- Produces: 当前 core.js 的同名导出；`lib/patches/index.mjs` 导出 `ALL_PATCHES`。

- [x] **Step 1: 写真实拆分回归测试。** 测试导入随包快照的 144 个 core 导出，比较 `util.isDeepStrictEqual` 的 86 补丁对象及实际引擎在原始文本和 CRLF/YAML 输入下的输出。
- [x] **Step 2: 验证测试能失败。** 把某个补丁对象改一位后 `isDeepStrictEqual` 必须立即报错（已手工验证）；早期「指向空 `ALL_PATCHES` 临时入口」的写法已弃用，它把模块解析错误当成了有效 RED。
- [x] **Step 3: 完成拆分与文档。** 维持既定迁移；在维护手册记录 patch 文件职责与「顺序不可重排」。
- [x] **Step 4: 全量验收。** `npm run check` 11/11；`verify-target --json` 拆分前后 86 行逐行一致；`npm run host:status` 为 ok；`npm pack` 后解压运行测试通过。
- [x] **Step 5: 独立审查并处理 Critical/Important。** 审查发现 CI 浅克隆与打包无 `.git` 两个可移植性缺陷，已改为随包快照；`core.js` 换行误改为 LF 已恢复 CRLF；提交后跑最终 check、推送 main 并确认远端 CI。
