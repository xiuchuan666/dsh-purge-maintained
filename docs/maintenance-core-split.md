# 补丁注册表拆分设计

## 目标与边界

本轮只拆 `lib/core.js` 的补丁模板与四个补丁数组，使宿主适配时能从短文件定位补丁，而不是在 9000 行文件中搜索。属于纯结构重构：不新增、修改、删除或重排任何补丁，不改变公开 API、补丁产物或运行行为；不在本轮拆 `core.js` 尾段、`lib/index.js` 或 `lib/desktop.js`。

## 方案与决策

采用已确认的 A 方案：把自包含的第 2541–6334 行迁到 `lib/patches/`，core 通过 `ALL_PATCHES` 单一入口聚合。A 的切面依赖最少；B（尾段分区）牵扯引擎、宿主探针、shim 和 yaml 的横向依赖，留作独立维护任务；C（先拆 index/desktop）收益小于核心补丁区，不在本轮。

实测依赖闭包：数组区只依赖 `COMPLETE_PROMPT_WATERFALL_INJECT` 等模板常量；模板区（原 2541–2627）不被 core 其它区段引用，因此完整随数组迁走。`fs`、`ensureHostClean` 等 grep 命中位于字符串或注释，不是代码依赖。

## 文件结构

| 文件 | 内容 | 原 core.js 行号 |
| --- | --- | --- |
| `lib/patches/templates.mjs` | 字符串模板、网络模板、替换链 helper | 2541–2627 |
| `lib/patches/patch-registry.mjs` | `PATCHES` | 2629–2890 |
| `lib/patches/code-patches.mjs` | `CODE_PATCHES` | 2892–2931 |
| `lib/patches/engine-patches.mjs` | `ENGINE_PATCHES` | 2933–3225 |
| `lib/patches/new-tool-patches.mjs` | `NEW_TOOL_PATCHES` | 3227–6334 |
| `lib/patches/index.mjs` | 以既定顺序组合并导出 `ALL_PATCHES` | 原 6336 表达式 |

`PATCHES → CODE_PATCHES → ENGINE_PATCHES → NEW_TOOL_PATCHES` 的展开顺序是行为，不允许按数字 ID 或名称重新排序。core.js 保持 144 个导出名称，其中 `ALL_PATCHES` 重新导出聚合结果；不额外暴露原先非导出的模板常量或四数组。

## 验收标准

1. 新旧 core 的导出名称集合、86 条补丁对象（含正则及函数值）一致。
2. 239 个 replacement 的匹配、替换、防重入及 YAML 行为经真实引擎对拍一致；不能只比较 `JSON.stringify` 的结果。
3. 当前宿主的 86 条 verify-target 状态逐行一致（基线 79 settled、7 no-file、0 drifted），`host:status` 为 `ok`。
4. `npm run check` 全绿；新增测试能证明数组搬出后仍由原 core 路径消费，不引入平行补丁清单。
5. 回退只还原本轮提交；临时对拍目录 `/.tmp-split/` 不进 Git。

## 测试参照物

`scripts/test-patch-registry.mjs` 需要一份「拆分前的 core」才能做对象级对拍。参照物是 `docs/origin/core-split-baseline-8066985/`：`core.js` 加它 import 闭包里的 13 个相对模块，以及 `package.json`，全部取自提交 `8066985`。

不使用 `git archive` 的四个理由：

1. CI 的 `actions/checkout@v4` 默认浅克隆，拿不到历史提交，测试会以 `Not a valid object name` 失败。
2. 发布包（`npm pack` 产物）没有 `.git`，解压后无法运行测试。
3. Windows Git Bash 的 `tar` 不支持 `--one-top-level`，解包步骤需要额外分支。
4. 整棵 152 文件归档约 4 MB，而实际只需 596 KB。

快照只作对拍参照，不是第二份补丁清单：它不参与任何 apply 路径，只有测试导入它；日常改补丁只需改 `lib/patches/`。

## 换行

`core.js` 保留区维持原 CRLF（5269 行），`lib/patches/*.mjs` 为新文件、用 LF。审查据此确认 `git diff --ignore-space-at-eol lib/core.js` 只剩 4 行替换，没有夹带其它内容改动。

## 实施记录

2026-11-10 已完成迁移并做临时对拍。2026-11-11 续接审查时发现：临时 JSON 对拍把正则、函数及 `undefined` 丢失或变形，不足以证明补丁产物不变。因此收尾把对拍升级为真实 JavaScript 对象与真实补丁引擎的测试；临时快照只作辅助证据。

2026-11-11 收尾实测：

| 验收项 | 结果 |
| --- | --- |
| `scripts/test-patch-registry.mjs` | 86 补丁对象 `isDeepStrictEqual`、239 replacements、690 组引擎对拍通过 |
| `verify-target --json` 拆分前后 | 86 行逐行一致（79 settled / 7 no-file / 0 drifted） |
| `npm run check` | 11/11 通过（syntax 96 文件、metadata 86 补丁、client 锚点、测试 11 项） |
| `npm run host:status` | `verdict=ok` |
| `npm pack` 后解压运行测试 | 通过（172 条目，其中基线快照 14 个文件 576 KB） |

