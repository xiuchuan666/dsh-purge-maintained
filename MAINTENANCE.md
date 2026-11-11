# 维护手册

本仓库是个人长期维护基线。默认开发分支为 `main`，维护环境使用 Node.js 24；不增加第三方运行时或开发依赖。

## 每次修改前后

```bash
npm run check
```

该命令依次完成：

1. `npm run check:syntax`：检查 `bin/`、`lib/`、`scripts/` 与 `client.js` 的 JavaScript 语法，并动态导入 `lib/index.js`。
2. `npm run check:metadata`：检查 `package.json` 版本与 `release-notes.md` 首行一致、`dshTarget` 在 `dshTargets` 内、补丁 ID 唯一且有效。`ALL_PATCHES` 的数组顺序是实际应用顺序，不要求数字 ID 升序，也不为重排而重排。
3. `npm run check:client`：前端产物链校验（见下节「前端产物链」）。
4. `npm test`：自动发现并逐个运行 `scripts/test-*.mjs`，每个测试使用独立 Node 子进程。

默认检查不读取或改写 DSH profile，不应用宿主补丁，也不需要安装宿主。补丁数量从 `ALL_PATCHES` 动态读取，不在检查器里固定写死。

新增独立回归测试时，将文件命名为 `scripts/test-<主题>.mjs`，失败时设置非零退出码或抛出异常，成功时正常退出。测试临时数据放在系统临时目录，并在结束时清理。

## 需要宿主样本的验证

以下命令不属于默认 `check`，必须显式提供目标样本：

```bash
node scripts/verify-target.mjs --ai-base <.../node_modules/@deepseek-ai> --pad
node scripts/e2e-apply.mjs --src <.../node_modules/@deepseek-ai>
node scripts/e2e-desktop.mjs --main <纯净 resources/app/lib/main.js>
```

- `verify-target` 只读分类每个补丁，不做写盘。
- `e2e-apply` 把宿主树复制到临时目录，验证备份、两次应用、状态及逐字节回退。
- `e2e-desktop` 只接受纯净桌面主进程文件；已打补丁的 `main.js` 不作为原始基线。

## 宿主升级：先跑宿主基线

```bash
npm run host:status     # 与 docs/host-baseline.json 比对，只读
npm run host:capture    # 升级适配完成后，把新状态记为基线
```

`host:status` 自动探测本机宿主（也接受 `--ai-base <目录>`，或环境变量 `DSH_HOST_AI_BASE`），把当前状态与 `docs/host-baseline.json` 比对，输出三段：宿主版本变化、目标文件指纹变化、补丁状态迁移。结论分三级：

| verdict | 含义 | 处理 |
| --- | --- | --- |
| `ok` | 与基线完全一致 | 不用管 |
| `review` | 版本或文件变了，但没有补丁从可用跌成失效 | 记下变化，继续用；确认无碍后 `host:capture` 更新基线 |
| `broken` | 有补丁从 `settled`/`would-apply` 跌成 `drifted` | 立即列出失效补丁 ID，按 `verify-target --pad` 定位字面量 |

判定规则不在这里另写一份：`host:status` 调用 `scripts/verify-target.mjs --json`，补丁分类始终只有一处实现。退出码 `0` 表示 ok/review，`1` 表示 broken，`2` 表示探测或用法失败。

基线文件 `docs/host-baseline.json` 只存相对路径与 sha256，不含绝对安装路径，入库无害；桌面补丁需要纯净 `main.js` 的验证仍走 `e2e-desktop`。

宿主升级适配、前端重建与巨型模块拆分应分别成为独立维护任务，不与无关业务修改混在同一提交。

## 前端产物链（client.js）

`client.js` 由三层构成：

| 层 | 来源 | 状态 |
| --- | --- | --- |
| 主体（设置面板 / 清洗 UI / rewind UI） | 上游手写成品，源码已失传 | 只能哈希锚定，无法从零重建 |
| dock / 授权弹窗补丁 | `scripts/patch-client-dock.mjs` 四步模板，已固化进成品 | 脚本可重放（幂等守卫），「未补丁原版」不存在 |
| 演练台片段（DRILL 标记之间） | `lib/redteam/client.js` → `scripts/build-client.mjs` 抽取嵌入 | 真源码在库，可重建 |

`npm run check:client`（只读）校验三件事：

1. 锚点 `docs/origin/client-1.1.94.js` 与 `client-1.1.94.sha256` 一致（锚点取自 1.1.94 发布包，与 Git 基线 fa8d09d 的工作区版本字节一致）。
2. 当前 `client.js` 结构完整：DRILL 标记存在且顺序正确，dock 补丁锚点在。
3. DRILL 标记之间的片段与从 `lib/redteam/client.js` 现抽片段一致——**改了演练台源码忘跑 build 时这里会报错**。

改前端的正确流程：

```bash
# 1. 改 lib/redteam/client.js（演练台源码）
npm run build:client    # 2. 重嵌片段进 client.js
npm run check           # 3. 全量校验（含片段同步检测）
```

注意：

- 不要手工编辑 `client.js` 里 DRILL 标记之间的内容——那部分由 `build-client.mjs` 生成，手工改动会被下一次 build 覆盖、且 `check:client` 会报片段过期。
- 主体与 dock 补丁层可以改（改的是成品本身），但改前想清楚：这两层没有源码，改坏只能回退 Git 或从锚点对拍。
- `patch-client-dock.mjs` 重放到已补丁文件时会把全文件 CRLF 归一成 LF；`build-client.mjs` 不动主文件换行。两者的片段算法由 `scripts/client-chain-lib.mjs` 单一实现，校验器与测试共用，避免出现「校验器说同步、build 一跑却变」的分叉。
- 换宿主大版本若 client.js 需要成批改锚点，先更新 `docs/origin/` 下的锚点与哈希记录，再动成品，保持「先锚后改」。

## 补丁注册表（lib/patches/）

宿主适配时最常改的是补丁字面量，它们已从 9000 行的 `core.js` 移到短文件：

| 层 | 文件 | 行数 | 职责 |
| --- | --- | --- | --- |
| 模板 | `lib/patches/templates.mjs` | 91 | 提示词字面量、网络模板、替换链 helper |
| 注册表 | `lib/patches/patch-registry.mjs` | 277 | `PATCHES`（10 条） |
| 代码补丁 | `lib/patches/code-patches.mjs` | 43 | `CODE_PATCHES`（3 条） |
| 引擎补丁 | `lib/patches/engine-patches.mjs` | 296 | `ENGINE_PATCHES`（8 条） |
| 新工具补丁 | `lib/patches/new-tool-patches.mjs` | 3112 | `NEW_TOOL_PATCHES`（65 条） |
| 组装 | `lib/patches/index.mjs` | 9 | 按原顺序拼 `ALL_PATCHES`（86 条） |

改补丁只动 `lib/patches/` 里的数组文件；`core.js` 只保留 `import { ALL_PATCHES } from './patches/index.mjs'` 一行再原样导出。

**顺序不可重排**：`PATCHES → CODE_PATCHES → ENGINE_PATCHES → NEW_TOOL_PATCHES` 的拼接顺序就是 apply 顺序，`{id:76}` 必须先于 `{id:70}`；`npm run check:metadata` 与 `scripts/test-patch-registry.mjs` 都会盯住。

补丁内容有回归保护：`scripts/test-patch-registry.mjs` 把 `ALL_PATCHES` 与 `docs/origin/core-split-baseline-8066985/`（拆分前快照）做对象级对拍（含正则 flags、函数 replace、239 个 replacement），再用真实 `applyReplacementsToText` 跑 690 组输入。改错一个字面量这里会立刻失败。

## CI 与发布

`.github/workflows/ci.yml` 在 `main` 推送、pull request 和手动触发时运行 `npm run check`。CI 使用 Node.js 24，不需要 `npm install`。

`.github/workflows/release.yml` 也在发布前运行相同检查。现有上游仓库条件保持不变，因此维护仓库的提交不会触发上游 Release 发布。

包本身已标 `"private": true`，`npm publish` 会直接拒绝。对外发布渠道只有本地 `npm pack` 产物（`$DSH_HOME/plugins/*.tgz`）。

## 更新链路（已固定为离线）

维护仓库是私有的，GitHub 的 `codeload` / `api` / `raw` / `jsdelivr` 对匿名请求全部 404。因此：

- `lib/update.js` 里 `ONLINE_UPDATES_ENABLED = false`，`checkUpdate()` 与 `applyUpdate()` 直接返回明确错误，不把 404 吞成「已是最新」。
- 启动路径恒不自动升级（`autoUpdateIfNeeded()` 返回 `skipped: "manual-only"`）。
- 本机升级只走「改版本号 → `npm run check` → `npm pack` → 换 tgz → 重装 profile」这一条路，步骤见 [README](README.md) 的「更新策略」。
- 不要为了「让面板更新能用」而把仓库改公开或往代码里塞 token：前者泄露全部维护内容，后者把长期凭据写进插件。

## 回退

普通修改以小提交落在 `main`。发现问题时用 `git revert <commit>` 保留可追踪的回退记录；不要用历史覆盖作为日常回退手段。基线首个提交为 `fa8d09dec92cf582412c28566273147076e79f24`。

详细设计与本阶段边界见 [统一验证与 CI 设计](docs/maintenance-verification.md)、[宿主适配基线设计](docs/maintenance-host-baseline.md)、[前端产物链设计](docs/maintenance-client-chain.md) 与 [补丁注册表拆分设计](docs/maintenance-core-split.md)。
