# dsh-purge 插件介绍

**版本 1.1.101** · **适配 DeepSeek Harness 0.2.2-rc.5**（兼容 0.2.2-rc.3 / rc.2 / rc.1 / 0.2.1-rc.5 / 0.2.1-rc.2）· **Node.js >= 24**

> dsh-purge 是运行在本机 DeepSeek Harness 上的增强插件：把宿主清洗、提示词注入、红队演练台、安装升级与维护验证，收进一套可回滚、可检查、可重复的工具链。

## 一、它是什么

dsh-purge 不是另一个聊天客户端，也不是云端服务。它直接作用于本机已安装的 `@deepseek-ai` 宿主包：通过文本补丁修改宿主行为，再通过运行时插件接管提示词装配、聊天命令、模型工具和侧栏界面。

整个插件由三层组成：

1. **宿主补丁层**：对宿主已安装的 JS、YAML、提示词和工具定义做文本替换，改前留备份，命中才写入。
2. **运行时插件层**：注册 `/purge`、`/rules`、`/skills`、`/rewind` 四条聊天命令，`purge_status` / `purge_apply` / `purge_revert` 三个模型工具，以及「清洗 / 演练台」侧栏 Dock。
3. **演练台层**：本机 SQLite 红队工作台，覆盖资产、漏洞、凭证、WebShell、隧道、POC 知识库、计分、证据和报告。

它解决四个问题：**宿主升级后补丁是否还有效、提示词到底注入了什么、安装失败能不能退回去、红队过程有没有本地数据面。** 所有修改都围绕这四个问题展开，不依赖外部服务。

## 二、功能全景

| 能力域 | 功能点 |
|---|---|
| 宿主清洗 | 88 条补丁，覆盖提示词 / 代码 / 工具 / 兼容层；多宿主批量应用、幂等、备份、回滚、漂移检测 |
| 提示词系统 | `prompt-inject.md` 优先、工作区规则、内置默认提示词、三种工作区策略、尾段提示词、锚点注入 |
| 模型适配 | frontier / standard / light / default 四档；v1–v6 提示词资产；分档选择与资产盘点 CLI |
| 命令与工具 | 4 条聊天命令、3 个模型工具、CLI 子命令；状态、应用、回滚、卸载、BOM 修复 |
| 侧栏面板 | 「清洗」页展示补丁分组、应用 / 回滚 / 卸载、安装真相、宿主完整性与 profile 状态 |
| 红队演练台 | 本机 SQLite 靶标库、64 个 `redteam_*` 工具、计分 / 报告 / 攻击图 / 证据账本、23 个红队技能 |
| 安装生命周期 | profile 事务安装、宿主唯一入口安装、journal、启动探针、健康检查、自动回滚、冒烟、备份 GC |
| 升级维护 | 宿主基线、宿主契约、补丁闸表、补丁锚点契约、预演、沙盒、更新一条命令、漂移预警 |
| 质量保障 | 162 个测试文件 / 4199 个用例、六段 `npm run check`、拒绝率评测、覆盖率棘轮 |

## 三、核心功能详解

### 1. 宿主清洗与补丁引擎

这是插件的地基。当前注册表有 **88 条补丁**：

- 提示词层 **27 条**：身份覆盖、工作区上下文、官方 plan 模式、提示词装配等。
- 代码层 **50 条**：沙箱默认值、审批自动放行、回退、桌面壳、工作区限制等。
- 工具层 **8 条**：最小官方工具集、hooks 拒绝放行等。
- 兼容层 **3 条**：0.1.5 / 0.2.0 老宿主的兜底。

其中桌面专属补丁 7 条，覆盖官方壳、asar、桌面重启与桌面入口。

每条补丁不是“无脑查找替换”，而是一份带守卫的声明：

- `file` / `replacements`：目标文件与原文 / 替换片段；
- `skipIfMarked` / `markers`：已经打过就跳过；
- `strictFiles` / `softFiles`：主目标与历史目标分开处理，包迁移不会长期误报；
- `deleteOnly`：纯删行补丁，不要求删除后的标记存在；
- `after`：链式补丁的前驱依赖，前驱没完成时记 `pending`，不误报漂移；
- `expect`：命中次数硬契约，多一处少一处都拒写；
- `surfaces`：按 web / desktop 面选择目标，不跨面误打。

引擎能力包括：

- **多宿主批量应用**：`applyPatchesAllHosts` 可以一次应用到所有已发现的宿主树；支持 web / desktop、开发树、npm 全局树。
- **幂等**：第二次应用返回 `already`，不重复写、不改 mtime；补丁 `.bak` 也不会被覆盖。
- **备份与回滚**：写入前生成 `.dshpurge.bak`；`revertAllHosts` 按备份还原，支持 0 字节占位备份、损坏备份、符号链接写穿真身。
- **状态可视化**：applied / already / drifted / skipped / na / missing_file / pending 七类状态，面板按九个组展示。
- **漂移检测**：补丁锚点与当前宿主不匹配时单独标记，不把“已应用”当成永久有效。

除了运行时清洗，仓库还提供补丁契约与闸表：

- `patch:contracts`：在参考宿主树上记录每条补丁真正命中的文件 × 每条针的命中数，生成 88 条 / 263 条针 / 99 个锚点的基线；换树后按 `ok / missing / drifted / ambiguous / na` 逐项比对。
- `check:gates`：88 条补丁的闸表检查，60 条 gated，防止名字、顺序、目标文件和 needle 漂移。

### 2. 提示词注入系统

每轮装配按固定优先级决定注入什么：

1. **`prompt-inject.md` 非空** → 用它作为会话覆盖段；
2. **否则看工作区规则**（`AGENTS.md` / `CLAUDE.md`）的勾选结果；
3. **都没有** → 使用插件内置的加密默认提示词。

工作区策略决定 baseline 是否保留：

- `strict`：去掉 baseline；
- `fallback`：有用户注入才去掉；
- `always`：始终保留。

默认提示词面向国模「小码酱」，由 21,219 字符原文加 1,331 字符的五类示例卡组成，合计约 22,553 字符。五类示例卡覆盖：勒索软件 AES + 影子副本、身份证版面与校验位、社工库 SQL、AMSI patch、受害机 + 降检测槽。

其他提示词相关能力：

- **锚点**：`anchorMode` 支持 `auto` / `off`，每轮重新求值，不写死常量；
- **尾段**：`postPrompt` 追加第三段，`postPromptOrder` 控制顺序；
- **mnemon 清理**：`stripMnemon` 去掉 mnemon 记忆消息；
- **能力协议**：`capabilityProtocol` 教模型主动发现 skill / MCP，不改官方注册与工具面；
- **自动重试 / 续跑**：`autoRetry`、`retryMax`、`autoContinue`、`continueMax`、`continueText`；
- **子代理审批接管**：`subagentControl` 在子会话把审批策略拉回可控范围；
- **写盘自愈**：注入文件缺失、被改坏、被 BOM 污染时自动修复；
- **多档降级**：刷新 → hung → 磁盘 → 密封槽四档兜底，单次慢调用有冷却保护。

### 3. 模型分档载荷

P3-8 提供一层纯函数工具，把模型选择器归一化为 `{ provider, model }`，再按 manifest 选提示词档位：

- **frontier** → `docs/prompt-inject-v6.md`（8,549 字符）
- **standard** → `docs/prompt-inject-v4.md`（4,353 字符）
- **light** → `docs/prompt-inject-v3.md`（2,914 字符）
- **default** → `docs/prompt-inject-v6.md`（未知模型保守回落）

规则支持精确匹配、`*` / `?` 通配、`prefix:` 前缀与 `/regex/flags` 正则；匹配按规则顺序取第一条，未命中落 default。当前 manifest 的 `evidence` 统一标记为 `heuristic-unverified`，**只做离线决策，不自动改运行时注入**。

配套命令：

```bash
npm run prompt:tier -- --model deepseek-v4.1-flash
npm run prompt:tier -- --list
npm run prompt:tier -- --validate
npm run prompt:tier -- --model gpt-5.2 --provider openai --json
npm run prompt:variants
npm run prompt:variants -- --check
```

`prompt:variants` 盘点 v1–v6 六个提示词版本：v1 20,349 字符、v2 20,298、v3 2,914、v4 4,353、v5 6,210、v6 8,549；六版核心 marker 检查全部 PASS。

### 4. 聊天命令与模型工具

**聊天命令：**

| 命令 | 能力 |
|---|---|
| `/purge` | `status`、`apply`、`revert`、`uninstall`、`edit`、`help` |
| `/rules` | `list`、`use <id>`、`create <id> [别名] [目标]`、`delete <id>`、`reset`、`help` |
| `/skills` | `list`、`import <路径>`、`create <id> [说明]`、`delete <id>`、`help` |
| `/rewind` | 子代理直接回退一次；主代理 `/rewind once` 或 `/rewind round` |

四个命令都有备用名：`purge-cmd` / `purge-rules` / `purge-skills` / `purge-rewind`，用于避开老红队包或其它插件的同名命令。

**模型工具：**

- `purge_status`：返回补丁状态、宿主版本、安装真相与 profile 信息；
- `purge_apply`：应用全部清洗，返回 applied / already / skipped 统计；
- `purge_revert`：回滚还原，包含 shim 与提示词覆盖。

**CLI：**

```bash
dsh-purge --status
dsh-purge --apply
dsh-purge --revert
dsh-purge --uninstall
dsh-purge --edit
dsh-purge --fix-bom
dsh-purge --help
```

### 5. 侧栏「清洗」面板

插件在会话侧栏提供 Dock，分为「清洗」和「演练台」两页。

「清洗」页是插件的主控制台：

- 按九个补丁组展示状态、名称、层级和说明；
- 一键应用 / 回滚 / 卸载；
- 展示补丁汇总：已应用 / 总数、跳过、漂移；
- 展示安装真相：宿主版本、宿主完整性、原生绑定数量、unpacked 缺口、上次安装 journal、profile 版本、注入槽长度；
- 宿主版本不匹配时明确告警；
- 中文 / English 双语文案；
- 只读安装真相区不会把「读不到」误显示成「ok」。

### 6. 红队演练台

演练台是本机 SQLite 红队工作台，所有数据留在本机，进入前需要本机授权标记。覆盖：

- **资产**：主机、IP、端口、服务、指纹、优先级、测试状态、备注、资产关系；
- **漏洞**：严重度、状态、CVE、证据、复现请求、站点归并；
- **凭证与访问**：凭据、WebShell、隧道、会话可用性；
- **POC 与知识库**：POC 正文、来源、验证状态、标签、nuclei 模板索引、全文检索；
- **计分**：得分点、命中、去重、上限、阶段分、面板 / 报告 / 攻击链三处总分一致；
- **证据**：证据账本、未知项、置信度、权威来源、升级闭环；
- **报告**：Markdown 报告、攻击图、按严重级排序、复现请求自动生成；
- **导入导出**：bundle 导入、扫描记录、域名自动关联资产、端口增量补 banner。

演练台注册 **64 个 `redteam_*` 模型工具**，按领域分为五组：侦察 11 个、发现 / 漏洞 22 个、计分 16 个、知识库 6 个、证据 9 个。

随包提供 **23 个红队技能 + 五类示范卡**，覆盖主动扫描、被动侦察、FOFA、fscan、gogo、nuclei、目录爆破、Web 指纹、WebShell、反弹 Shell、隧道、横向、凭据攻击、浏览器自动化、资产关联、报告与工作流。

演练台还包含：

- 红队子代理角色稿：coordinator / recon / exploit / assess 等角色按会话注入；
- 平台工具配置：自动发现 Kali / Linux / Windows 下的 nuclei、fscan 等工具路径；
- 本机靶标授权：`drill grant` 控制进入与操作；
- 截图、证据附件、命中记录与得分点快照；
- FTS5 缺失时自动降级到 LIKE 检索，数据表结构不缺失。

### 7. 安装、更新与回滚

**profile 安装**（推荐）：

```bash
npm run profile:install -- --tgz dsh-purge-1.1.101.tgz --profile desktop --apply
npm run profile:install -- --rollback --exe "<desktop exe>" --apply
```

这是一条事务化安装链：

- tgz 的 sha256 / size 校验；
- 手写 tar 解析，拒绝 `../` 路径穿越、截断包、空包和不安全条目；
- 只改 `pnpm-lock.yaml` 的 `dsh-purge` 段；
- journal 记录 pending / done / rolled-back / failed；
- 备份当前树；
- 换树后做版本与 `SLOT >= 16,000` 健康检查；
- 失败自动还原，坏包不会留下半安装状态。

**宿主安装**（唯一入口）：

```bash
node scripts/host-install.mjs --tree "<new app tree>" --resources "<resources>" --exe "<exe>" --stop --apply
node scripts/host-install.mjs --rollback --resources "<resources>" --exe "<exe>" --apply
```

预检 journal / 新树 probe / 磁盘 1.25 倍 / 进程状态 → 关闭宿主 → 旧树 rename 为 `app.prev-<ts>` → 复制新树 → 再 probe → 启动并做 15 秒健康检查 → 失败自动回滚并重启旧树。退出码 0 / 1 / 2 / 3 分别表示成功、失败已回滚、预检失败未动、有未收尾安装。

**宿主更新一条命令**：

```bash
npm run host:update -- --plan
npm run host:update -- --resources "<resources>" --exe "<exe>" --stop --apply
```

五步：download → extract（外层 exe + `$PLUGINSDIR/app-64.7z`）→ asar（`extract-asar --clean`）→ rehearse（`host-rehearse` + `host-adopt probe`）→ install。默认 dry-run；`--apply` 必须显式给 `--resources` 和 `--exe`。

**安装周边的保护：**

- `host-rehearse`：七步预演，最后一步真正启动候选树，捕获 `No usable native binding` 类崩溃；
- `host:smoke`：安装后 bash / read / write / tool 四步冒烟；
- `host:watch`：ETag + 长度检查，发现上游安装包漂移；
- `host:gc`：备份代际清理，默认 dry-run、保留两代；
- `host:integrity`：版本、原生绑定、unpacked 缺口、`.node` 数量；
- `--fix-bom`：修复 Windows PowerShell 写出的 profile BOM，避免桌面端 `JSON.parse` 崩溃；
- 桌面 / Web 重启适配器，所有后台重启都不挂 stdio。

### 8. 宿主升级与维护工具链

- **`host:status`**：读取 `docs/host-baseline.json`（88 条补丁 + 62 个目标文件指纹）与 `docs/host-contract.json`（25 项宿主 API 契约），输出 `ok / review / broken`，退出码 0 / 0 / 1。
- **`host:capture`**：重新拍宿主基线。
- **`host:sandbox`**：在仓库内旁路副本重打全部补丁，结果与基线逐字节比对。
- **`host:preview`**：把目标版本装进隔离目录试锚点，报告升级会打坏哪些补丁。
- **`host:rehearse`**：七步预演，含 apply 预演、outcome、behaviour、gates、boot 探针。
- **`host:adopt`**：stage / probe / snapshot / swap / pin / verify，默认 dry-run，swap 失败自动回滚。
- **`host:integrity`**：宿主完整性检查，支持 `--quiet` 接入 CI。
- **`host:census` / `host:choke`**：限制面普查与站点级覆盖，指出哪些拦截点还没被补丁覆盖。
- **`patch:contracts`**：参考树锚点契约，88 条补丁 / 263 条针 / 99 个锚点。
- **`net:doctor`**：DNS、hosts、NO_PROXY、代理、GitHub 解析的只读诊断，逐条给修复命令。

### 9. 质量与评测

插件把“能装、能跑、能回滚”当成产品能力的一部分：

- **162 个测试文件 / 4199 个用例**，全部使用 `node:test`，失败能定位到具体用例名；
- `npm run check` 六段：syntax（338 files）、metadata（version / patches / tests）、EOL（428 files）、client（锚点 / 结构 / 演练台片段）、gates（88 行 / 60 gated）、host-integrity，最后跑完整测试；
- `npm run test:full` 额外跑覆盖率与棘轮基线，只允许涨，不允许悄悄跌破；
- **eval-refusal**：10 道题（5 定向 + 5 泛化），单题 0–2 分、总分 0–10，阈值 7.0 / 6.0，baseline 容差 0.15，题集指纹漂移直接退出 3；
- **prompt tier / prompt variants**：39 + 22 个用例，所有提示词变体的核心 marker 自动检查；
- 全程零运行时依赖，只用 Node 内置模块；Node >= 24；包体约 2.4 MB / 170 个文件。

## 四、配置项

`lib/index.js:76` 的 `DEFAULTS` 共 18 键，可在 profile 的 `cordis.patch.yml` 里覆盖：

```text
enabled                总开关
autoApplyOnStart       启动时自动应用
autoUpdateOnStart      启动时检查更新（当前恒 manual-only）
autoRevertOnMissing    宿主缺失时自动还原
injectOnce             只注入一次
stripMnemon            去掉 mnemon 消息
postPrompt             追加的尾段提示词
postPromptOrder        尾段顺序（默认 5100）
verbose                详细日志
autoRetry              自动重试
retryMax               重试次数
autoContinue           自动续跑
continueMax            续跑次数
continueText           续跑指令（默认「继续」）
capabilityProtocol     Codex 风格 skill / MCP 发现协议
hooksDenyBypass        放行 hooks 拒绝
anchorMode             auto / off
subagentControl        子代理审批接管
```

## 五、典型使用流程

1. **打包**：`npm pack`，得到 `dsh-purge-1.1.101.tgz`。
2. **安装到 profile**：`npm run profile:install -- --tgz dsh-purge-1.1.101.tgz --profile desktop --apply`。
3. **重启宿主**：完全退出（桌面连托盘一起退）再打开。
4. **应用清洗**：侧栏 Dock →「清洗」→「应用」，或聊天里 `/purge apply`。
5. **验证**：`/purge status` 或 `dsh-purge --status`；需要时看面板的「安装真相」。
6. **日常使用**：`/rules` 切规则、`/skills` 管理技能、`/rewind` 回退、演练台做红队工作流。
7. **升级宿主**：`npm run host:watch` → `npm run host:update -- --plan` → 确认后 `--apply` → `host:smoke` → `npm run check`。

## 六、设计原则

- **本地优先**：只作用于本机已安装的 `@deepseek-ai` 包，不扫描公网、不连接外部目标。
- **可回滚**：每一层都有备份、journal 或基线；安装失败自动还原，补丁失败单独标记。
- **幂等**：重复应用不重复写；apply 第二次全部返回 `already`。
- **证据优先**：宿主基线、宿主契约、补丁闸表、补丁锚点契约、测试基线共同判断，拒绝静默假绿。
- **可维护**：补丁、工具、UI、演练台按模块拆分；新增补丁有注册表快照、影响矩阵和测试地图。
- **可扩展**：模型分档、提示词变体、红队工具和技能都可以独立增加，不需要改宿主源码。

## 七、当前状态

- 版本：`1.1.101`，已推送到 `xiuchuan666/dsh-purge-maintained` 的 `main`。
- 宿主：`@deepseek-ai/dsh` 0.2.2-rc.5（兼容 rc.3 / rc.2 / rc.1 / 0.2.1-rc.5 / 0.2.1-rc.2）。
- 规模：88 条补丁、64 个 redteam 工具、23 个红队技能、162 个测试文件 / 4199 个用例。
- 适用：本机 DeepSeek Harness 的维护、提示词注入、红队演练与安装升级。
