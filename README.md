# dsh-purge · 本机维护副本

**Version 1.1.94** · Node.js >= 24 · 适配 dsh `0.2.2-rc.1`

这是 `dsh-purge` 的**私有维护基线**，不是面向公众分发的仓库。

上游 `HunYiSage/dsh-purge` 已永久删库，本仓库接管其后续维护：只服务本机自用，目标是**可维护、可回退、宿主升级后能立刻知道哪些补丁失效**。

| 事实 | 值 |
|---|---|
| 版本 | 1.1.94 |
| 运行时依赖 | 零（只用 Node 内置模块） |
| 目标宿主 | `@deepseek-ai/dsh` 0.2.2-rc.1（另兼容 0.2.1-rc.5 / 0.2.1-rc.2） |
| 补丁条数 | 86 条（提示词 27 / 代码 48 / 工具 8 / 兼容层 3） |
| 回归测试 | 42 个文件 / 971 个用例，`npm run check` 一条命令跑完 |
| 维护仓库 | `xiuchuan666/dsh-purge-maintained`（私有） |

---

## 目录

- [它做什么](#它做什么)
- [安装（本机）](#安装本机)
- [日常使用](#日常使用)
- [配置项](#配置项)
- [目录结构](#目录结构)
- [维护：改完必须先跑这一条](#维护改完必须先跑这一条)
- [宿主升级当天怎么走](#宿主升级当天怎么走)
- [更新策略](#更新策略)
- [排障](#排障)
- [许可证与署名](#许可证与署名)
- [使用边界](#使用边界)

---

## 它做什么

dsh-purge 是本机 `@deepseek-ai` 安装目录的补丁工具，加一份演练台 UI。它**不扫描公网**，只对本机已安装的宿主包做文本替换和运行时装配。

三个子系统：

1. **宿主补丁**（`lib/patches/`）
   86 条补丁，按 `ALL_PATCHES` 数组顺序应用到宿主的 JS/提示词/YAML/工具定义上。每条补丁声明目标文件、原文片段、替换片段、`skipIfMarked` 之类守卫，命中才改，改前写 `.dshpurge.bak`。

2. **运行时插件**（`lib/index.js` + `client.js`）
   注册 `purge` / `rules` / `skills` / `rewind` 四个聊天命令、三个模型工具、一个侧栏 Dock（「清洗」「演练台」两页），并在每轮装配时重写系统提示词。

3. **演练台**（`lib/redteam/`）
   本机 SQLite 存资产、漏洞、凭证、POC、知识库；随包 23 个红队技能；需要本机授权才能进。

**补丁分层**（写文档或排查时按这个分）：

| 层 | 条数 | 例子 |
|---|---|---|
| 提示词 | 27 | `WORKSPACE_CONTEXT_INTRO`、`HARNESS_IDENTITY_STRIP`、`OFFICIAL_PLAN_MODE_NEUTRAL` |
| 代码 | 48 | `SANDBOX_MODE_DEFAULT`、`APPROVAL_AUTO_GRANT`、`REWIND_*`、桌面 7 条 |
| 工具 | 8 | `MINIMAL_OFFICIAL_TOOLSET`、`HOOKS_CLAUDE_DENY_ALLOW` |
| 兼容 | 3 | `0.1.5` / `0.2.0` 老宿主的兜底 |

桌面专属补丁 7 条：`45 46 82 83 84 92 93`。

---

## 安装（本机）

**不要走插件市场**：`dsh-plugin.org` 或设置里的「插件市场」会报 `already queued: dsh-purge`。npm 上也没有这个包名。

本机链路是「打 tgz → 装 tgz」，不是从 GitHub 拉（仓库私有，匿名取包必然 404）。

### 1. 打包

```sh
cd /d/dsh-purge-maintained
npm pack
# 产出 dsh-purge-1.1.94.tgz，约 2.4 MB / 170 个文件
mv dsh-purge-1.1.94.tgz "$DSH_HOME/plugins/"
```

当前依赖指向 `file:../../plugins/dsh-purge-1.1.94.tgz`，版本号变了就要同步改 profile 的 `package.json`。

### 2. 装进 profile

```sh
dsh plugin --profile desktop add "file:$DSH_HOME/plugins/dsh-purge-1.1.94.tgz"
```

`dsh plugin --profile <name> add <spec>` 只是把参数转发给 profile 目录里的 pnpm，所以本地路径、tgz、目录都合法。

### 3. pnpm 12 的构建许可（关键）

pnpm 11/12 默认拦 `postinstall`，会以 `ERR_PNPM_IGNORED_BUILDS` 退出。**`--allow-build=` 和 `onlyBuiltDependencies` 在 pnpm 12 上都不起作用**（已实测五种写法，只有下面两条路能通）：

**路 A：profile 里放行全部构建脚本**（本机 desktop profile 就是这么配的，`pnpm-workspace.yaml`）：

```yaml
dangerouslyAllowAllBuilds: true
```

**路 B：装完之后补跑一次**（不改 pnpm 配置）：

```sh
node node_modules/dsh-purge/scripts/ensure-profile-bundle.mjs
```

或者带完整 specifier 批准：

```sh
pnpm approve-builds "dsh-purge@file:../../plugins/dsh-purge-1.1.94.tgz"
```

注意 `pnpm rebuild dsh-purge` **补不回来**，它自己也会报 `ERR_PNPM_IGNORED_BUILDS`。

### 4. 完成标志（三条都要）

- `node_modules/dsh-purge/package.json` 存在
- 该 profile 的 `package.json` 里 `dsh.profile.bundles` 含 `"dsh-purge"`
- profile 的 `cordis.patch.yml` 里有 `id: dsh-purge` 的 insert（缺这一行宿主不加载插件，界面也没按钮）

### 5. 重启 → 应用 → 验证

完全退出宿主（桌面连托盘一起退）再开 → 会话标题旁点 **dsh-purge** →「清洗」→「应用」→ 自动重启一次 → 聊天里 `/purge status`。

Web 的按钮只动 Web，桌面的只动桌面，不要在一个里面点另一个的应用。

### 卸载

面板卸载会先还原再重启。停用或卸载会把预设默认值改回 `standard`。

---

## 日常使用

### CLI（`bin/dsh-purge.js`）

```sh
dsh-purge --status      # 显示状态
dsh-purge --apply       # 应用全部清洗（提示词 + 代码 + shim + override）
dsh-purge --revert      # 回滚还原
dsh-purge --uninstall   # 卸载插件（已应用则先还原）
dsh-purge --edit        # 编辑注入文件 prompt-inject.md
dsh-purge --fix-bom     # 修复 profile 清单 BOM（0.2.2 起带 BOM 会导致桌面端起不来）
dsh-purge --help
```

### 聊天命令

| 命令 | 子命令 |
|---|---|
| `/purge` | `status` `apply` `revert` `uninstall` `edit` `help` |
| `/rules` | `list` `use <id>` `create <id> [别名] [目标]` `delete <id>` `reset` `help` |
| `/skills` | `list` `import <路径>` `create <id> [说明]` `delete <id>` `help` |
| `/rewind` | 子代理直接回退一次；主代理 `/rewind once` 或 `/rewind round` |

四个命令都有备用名：`purge-cmd` / `purge-rules` / `purge-skills` / `purge-rewind`（给装过老红队包的宿主用，避免命令名冲突）。

### 模型工具

`purge_status` / `purge_apply` / `purge_revert`，描述里带实时补丁条数。

### 回退

- **回退一次**：撤掉最近一次写入。
- **回退上一轮**：1.1.61 起按「当前这一轮」定位，不是按时间戳。
- 底层是 `.dshpurge.bak`：还原用备份覆盖并删掉备份；没备份就去掉 shim 行。`prompt-inject.md` 一律保留。重复应用是幂等的。

### 注入决策

每轮装配时按顺序判断：

1. `prompt-inject.md` 非空 → 用它作会话覆盖段
2. 否则看本地规则勾选（`AGENTS.md` / `CLAUDE.md`）
3. 都没有 → 用插件里的默认提示词
4. 工作区策略决定要不要保留 baseline：`strict` 去掉 / `fallback` 有用户注入才去 / `always` 保留

`anchorMode` 是另一个开关，只有 `auto` 和 `off` 两值（`off` 立即关锚点，不用改代码），别和上面的 `strict/fallback/always` 混写。

---

## 配置项

`lib/index.js:67` 的 `DEFAULTS`，共 18 键，可在 profile 的 `cordis.patch.yml` 里覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `autoApplyOnStart` | `false` | 启动时自动应用 |
| `autoUpdateOnStart` | `false` | 启动时检查更新（实际恒 manual-only） |
| `autoRevertOnMissing` | `false` | 宿主缺失时自动还原 |
| `injectOnce` | `false` | 只注入一次 |
| `stripMnemon` | `true` | 去掉 mnemon 消息 |
| `postPrompt` | `""` | 追加的尾段提示词 |
| `postPromptOrder` | `5100` | 尾段顺序 |
| `verbose` | `false` | 详细日志 |
| `autoRetry` | `true` | 重试 |
| `retryMax` | `3` | 重试次数 |
| `autoContinue` | `false` | 自动续跑 |
| `continueMax` | `3` | 续跑次数 |
| `continueText` | `"继续"` | 续跑指令 |
| `capabilityProtocol` | `true` | Codex 风格：教模型主动发现 skill / MCP，不改官方注册与工具面 |
| `hooksDenyBypass` | `true` | 放行 hooks 拒绝 |
| `anchorMode` | `"auto"` | `"auto"` \| `"off"` |
| `subagentControl` | `true` | `false` 立即回滚子代理审批接管 |

---

## 目录结构

```
bin/                 命令行入口
lib/                 补丁引擎、宿主探测、运行时插件
  patches/           86 条补丁（模板 / 四个注册表 / 合成入口）
  redteam/           演练台（store-core、dispatch、UI、工具）
presets/redteam/     红队预设
skills/redteam/      随包 23 个技能
client.js            侧栏 Dock（成品文件，见下）
cordis.patch.yml     插件声明
scripts/             17 个测试 + 校验/构建/探测脚本
docs/                设计文档、宿主基线快照、预览图
```

运行时文件在 `$DSH_HOME`：`prompt-inject.md`、`rules/`、`skills/`、`redteam/`。
未设 `DSH_HOME` 时先找 dsh 安装目录旁的 `.dsh`，再退 `~/.dsh`。Web 与桌面各用自己那份主目录。

**`client.js` 是产物**，9381 行、约 545 KB，三层：上游手写主体（源码已失传）+ dock/授权补丁 + 演练台片段。只有第三层能从 `lib/redteam/client.js` 重新生成，所以改了 `lib/redteam/client.js` 必须跑 `npm run build:client`，否则 `check:client` 会报 stale。

---

## 维护：改完必须先跑这一条

```sh
npm run check
```

四步串起来，任何一步红就停：

| 步骤 | 做什么 |
|---|---|
| `check:syntax` | 递归 `node --check` 全部 `bin/ lib/ scripts/ *.js`，最后 `import lib/index.js` 验模块图 |
| `check:metadata` | 版本号是语义化版本、`release-notes.md` 首行等于 `# <version>`、`dshTargets` 含 `dshTarget`、86 条补丁 id 唯一 |
| `check:client` | `client.js` 与 `docs/origin/client-1.1.94.js` 锚点哈希一致、DRILL 标记结构完整、演练台片段与 `lib/redteam/client.js` 同步 |
| `test` | 42 个 `scripts/test-*.mjs`（971 个用例），`node --test` 跑，失败能定位到具体用例名 |

当前基线：`[syntax] 138 files` / `[metadata] patches=86 tests=42` / `[client] anchor OK` / `[test] PASS 971/971`（约 10.0 秒）。

三条命令分三层：`npm test`（离线，约 1 秒）→ `npm run check`（加语法/元数据/产物链，约 3 秒）→ `npm run test:full`（加覆盖率棘轮基线，约 2 秒，需要 git 工作副本）。

**新增测试的命名规范**：`scripts/test-<主题>.mjs`，会被 `discoverTests` 自动收进 `npm run check`，不需要改任何清单。CI 在 `.github/workflows/ci.yml`，push `main` 和 PR 都跑 `npm run check`。

**改东西之前先查 [测试地图](docs/test-map.md)**：每个能力对到具体守卫，`❗缺` 的行就是当前盲区。测试用 `node:test` 的 `test()` 而不是顶层裸 `assert` —— 裸 `assert` 第一条红就抛出，同文件后面永不执行；约定细节在 [维护手册](MAINTENANCE.md) 的「测试地图」一节。

**三个需要宿主样本的脚本**（不进默认 check，因为 CI 上没有宿主）：

```sh
node scripts/verify-target.mjs --ai-base "<宿主>/@deepseek-ai"
node scripts/e2e-apply.mjs --src "<宿主>/@deepseek-ai"
node scripts/e2e-desktop.mjs --main "<纯净 main.js>"
```

**补丁注册表**（`lib/patches/`，6 个文件）：

| 文件 | 行数 | 内容 |
|---|---|---|
| `templates.mjs` | 90 | 模板常量与 helper |
| `patch-registry.mjs` | 276 | `PATCHES`（10 条） |
| `code-patches.mjs` | 42 | `CODE_PATCHES`（3 条） |
| `engine-patches.mjs` | 295 | `ENGINE_PATCHES`（8 条） |
| `new-tool-patches.mjs` | 3111 | `NEW_TOOL_PATCHES`（65 条） |
| `index.mjs` | 8 | 按 `PATCHES → CODE → ENGINE → NEW_TOOL` 合成 86 条 |

**`ALL_PATCHES` 的数组顺序就是 apply 顺序，不要重排。** 它不是按 id 升序：#76 排在 #70 前面，这是有意为之，测试里锁死了这条。`scripts/test-patch-registry.mjs` 会把 86 条补丁对象（含正则 flags 和函数型 replace）与基线快照逐字节比对，再对 239 个 replacement 跑 690 组真实引擎对拍。

**回退**：`git revert <commit>`。首个基线提交是 `fa8d09d`，之后每一步都是独立可回退的提交。

更细的流程见 [MAINTENANCE.md](MAINTENANCE.md)。

---

## 宿主升级当天怎么走

宿主升级后，先看「哪些补丁废了」：

```sh
npm run host:status
```

读 `docs/host-baseline.json`（86 条补丁状态 + 59 个目标文件指纹），跟当前宿主对比，**同时**扫一遍 `docs/host-contract.json`（我们调用的宿主服务/事件/导出），合并成三级判定：

| verdict | 含义 | 退出码 |
|---|---|---|
| `ok` | 补丁与契约都没变 | 0 |
| `review` | 宿主版本变了，或文件指纹变了，但补丁与契约都还站得住 | 0 |
| `broken` | 有补丁从「能打」变成「漂移」/消失，**或**我们调的宿主 API 不见了 | 1 |

两层是分开的，因为它们的盲区正好互补：补丁是文本替换，宿主把 `ctx.webServer` 改名成 `ctx.httpServer`，一段不含 `webServer` 字样的补丁照样能打上去、`verdict` 照样是 `ok`，插件却在启动时崩。所以只查补丁不够。

单独查契约：

```sh
node scripts/host-contract.mjs --ai-base "<宿主>/@deepseek-ai"
```

扫描优先读 `<文件>.dshpurge.bak`（那是官方原文），否则读当前文件——否则会读到自己注入的代码，把「我们加的东西」当成「宿主承诺的契约」。这不是理论风险：`dsh-settings/lib/index.js` 比它的备份多出 5 个方法（`register` / `get` / `ensureLegacyDocument` / `persistLegacy` / `commitLegacy`，全部来自补丁 #42），而 `lib/preset-default.js:109` 恰好调了 `settings?.get?.()`。读备份才会明确告诉我们「宿主没有这个方法」。

定位某条为什么废了：

```sh
node scripts/verify-target.mjs --ai-base "<宿主>/@deepseek-ai" --pad
```

`--pad` 会打印原文片段和宿主实际文本的差异位置，直接告诉你该改哪个字面量。

修完字面量后，实机 `--apply`，再重新拍基线：

```sh
npm run host:capture
npm run check
git commit -am "host: adapt to <新版本>"
```

判定逻辑**只有一份**（`scripts/verify-target.mjs` 走真实 `applyReplacementsToText`），`host:status` 只是调用它，不另写一套平行判断。补丁分类不许在别处重算。

---

## 更新策略

**本机更新走本地 tgz，不走面板。**

面板的「检测更新」读的是 GitHub。本仓库是私有的，`api.github.com` / `codeload` 匿名一律 404，所以：

- `checkUpdate()` 恒失败，错误文本：`本维护仓库为私有，在线更新不可用；请用本地 tgz 更新（见 README 更新策略）`。不是靠「拿不到远端条目」才触发，`ONLINE_UPDATES_ENABLED = false` 直接堵在门口。
- 不会静默显示「已是最新」骗人。
- 启动路径恒不自动升级（`autoUpdateIfNeeded()` 直接 `skipped: "manual-only"`）。

真实更新步骤：

```sh
cd /d/dsh-purge-maintained
git pull
# 改版本号 → 改 release-notes.md 首行 → npm run check
npm pack
cp dsh-purge-<新版本>.tgz "$DSH_HOME/plugins/"
# 改 profile package.json 的依赖指向 → 重装 → 重启 → 应用
```

`package.json` 里的 `dsh.install` 三个 URL 指向本维护仓库的 `main`，只是**留给将来仓库公开时用**。当前没有任何宿主代码读这个字段（已实测：`@deepseek-ai` 全树无消费点，市场也只读安装命令文本），所以它不影响安装行为。包已标 `"private": true`，`npm publish` 直接拒绝。

---

## 排障

**会话标题旁没有按钮。** 在对应 profile 跑 `dsh --dump-config`，找本体行 `id: dsh-purge`（不是 `dsh-purge-redteam`）。没有就补跑 `node node_modules/dsh-purge/scripts/ensure-profile-bundle.mjs`，然后完全退出重开。开头那几条 `entry "redteam-store" not found` 是旧红队包不在，可以忽略。

**市场报 `already queued: dsh-purge`。** 不要点市场，回安装章用 `dsh plugin add` 或 pnpm。装过了就先卸再装。

**`check:client` 报 stale。** 改了 `lib/redteam/client.js` 却没重新生成产物，跑 `npm run build:client`。

**`check:client` 报 anchor hash mismatch。** `client.js` 被手工改过。要么用 `docs/origin/client-1.1.94.js` 还原，要么确认改动合理后更新锚点文件。

**`check:metadata` 报发布说明版本不符。** `release-notes.md` 首行必须是 `# <package.json 的 version>`，这是发布门禁，不允许跳过。

**应用后行为没变。** 极简/PTC 模式与标准不一致时：完全退出 → 应用 → 重启 → **新开一轮**（旧会话不会重新装配）。

**补丁显示「跳过」不是失败。** 宿主升级后原文对不上时，那条补丁会显示跳过；只要不是「漂移」，就不算安装失败。

---

## 许可证与署名

- 代码：Apache-2.0，见 [LICENSE](LICENSE)。
- 保留声明：见 [NOTICE](NOTICE)。Copyright 2026 HunYiSage；`skills/redteam` 源自 `YuJunZhiXue/dsh-purge`（经 `mmparko` 镜像）。上游仓库已删库，本副本自 1.1.94 起由 [xiuchuan666/dsh-purge-maintained](https://github.com/xiuchuan666/dsh-purge-maintained) 维护。
- Apache-2.0 要求保留署名：二次分发或二次开发必须保留 `NOTICE` 与来源说明，不得移除原作者标识。
- 禁止倒卖：本项目不授权任何形式的商业售卖、付费倒卖或灰产牟利。
- 商业授权：见 [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md)。

## 使用边界

- 只作用于**本机**已安装的 `@deepseek-ai` 包，不扫描、不连接任何外部目标。
- 不修改非 `@deepseek-ai` 的源仓库。
- 演练台里的「本地靶场」只允许打自己搭的环境。禁止对中国大陆、香港、澳门，以及银行与金融站点、政府与军事站点做渗透、攻击或扫描。
- 使用者对自身行为独立承担全部责任。作者与本维护副本不承担任何连带责任。
