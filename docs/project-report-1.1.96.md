# dsh-purge 项目报告（1.1.96）

> 记录日期：2026-11-15　｜　插件版本 **1.1.96**　｜　宿主 **DeepSeek Harness 0.2.2-rc.3**（asar 发行物）
> 仓库：`D:/dsh-purge-maintained`　｜　提交 183 次（2026-11-10 → 2026-11-15）　｜　远端 `github.com/xiuchuan666/dsh-purge-maintained`

---

## 摘要

这个项目做一件事：**把 DeepSeek Harness（下称「宿主」）的官方限制面，改造成一个可自用、可验证、可回退、可随宿主升级持续维护的补丁层。**

它不是一个「一键破解脚本」，而是一套**带证据链的补丁工程**。当前形态：

| 维度 | 现状 |
|---|---|
| 补丁 | **88 条**（提示词 27 / 代码 50 / 工具 8 / 版本兼容 3），覆盖 **72 个宿主文件键**；其中 agent 面 81 条、桌面面 7 条 |
| 校验 | **六道闸**（syntax / metadata / eol / client / gates / test）每次提交全跑，任一失败即拒 |
| 测试 | **142 个测试文件 / 3888 个用例**，`node:test`，零第三方运行时依赖 |
| 覆盖率 | 78 个受控文件：行 **35 113 / 36 819（95.4%）**、分支 **11 046 / 12 657（87.3%）**、函数 **2 107 / 2 302（91.5%）**，棘轮只许涨 |
| 行为证据 | 21 个行为剧本覆盖 **18 条补丁**；「行为 + 闸表」双证 18 条，「只有文件标记、没有外部证据」**0 条** |
| 升级能力 | 一条命令回答「哪些补丁还能打 / 哪些失效 / 哪些不用打」；0.2.2-rc.3 真机落地并验证 |
| 限制面盘点 | 静态普查 **134 个限制站点**，收敛出 **33 个未覆盖候选**；逐条裁决后只落地 2 条（#91 / #94）+ 1 个配置键修复，其余 30 条明确进「不打」名单 |

一句话结论：**这套东西的价值不在「打了 88 条补丁」，而在于任何一条补丁坏了、宿主换版了、上游新增限制了，都能在一小时内说出「哪条、为什么、怎么修、修完怎么证明」。**

---

## 一、项目定位与设计目标

### 1.1 它解决什么问题

宿主发行物是一份**压缩 + 打包 + 部分 minified** 的 Electron 应用（0.2.2-rc.3 起用 asar 打包）。它内置的沙箱、审批、文件围栏、子代理路由、遥测等限制，对「本机自用、单人、可控环境」的场景过严。要改，只有三条路：

1. 改配置 —— 能改的只有开关，改不了「写死在代码里的 throw」；
2. 改代码 —— 宿主每次升级都会覆盖，且发行物被压过，人工 diff 不可持续；
3. **做一个可持续重放的补丁层** —— 把「改哪里、改成什么、怎么证明改对了」固化成数据 + 工具，升级时重放。

这个项目走的是第三条。

### 1.2 硬约束（用户定的）

- **首要目标是可维护性**，不是补丁数量；
- 最在意的两件事：**① 宿主升级后能快速确认哪里失效；② 所有改动可回退**；
- 公开行为不变、补丁产物不变、测试结果不变（重构不得改变运行时行为）；
- **零第三方运行时依赖**（宿主环境里只有 Node 24 + ESM，装什么都是负担）；
- 私有仓库、单机自用、长期维护。

### 1.3 边界声明

这套补丁只作用于**本机这一次安装**的宿主发行物。它不做：绕过许可证、联网校验破解、分发他人机器、对抗官方服务端。所有「限制」都是本地行为闸门（沙箱模式、审批策略、文件围栏、子代理路由），不涉及远端鉴权。

---

## 二、宿主与运行形态

### 2.1 宿主结构（0.2.2-rc.3）

```
C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/
└── resources/
    ├── app.asar                 ← 桌面壳（Electron 主进程）
    ├── app.asar.bak             ← 原版备份（换目录方案留下）
    └── app.asar.unpacked/       ← 解包后的运行时
        └── dsh/
            ├── cli/             ← CLI 入口（dsh / dsh.cmd / dsh.ps1）
            └── node_modules/@deepseek-ai/
                ├── dsh/                     ← 主包（cordis.patch.yml 在这里）
                ├── dsh-tool-subagent/       ← 子代理工具
                ├── dsh-sandbox*/            ← 沙箱族
                ├── dsh-user-approval*/      ← 审批族
                ├── dsh-agent-instructions/  ← 提示词注入
                └── … 共 150+ 包
```

0.2.2-rc.3 的关键变化：官方改用 **asar 打包**。这带来三件事：

1. `client.js` 等前端产物被压成**单行 minified**（反引号模板 + `}if(a){` 紧贴写法），任何「按行匹配」的契约扫描都会失效；
2. 补丁目标从「asar 外的散文件」变成「asar 内的文件」，必须先解包；
3. 换目录方案（解包 → 换名 → 让宿主以 unpacked 目录启动）成为唯一可持续路径。

### 2.2 运行面（surface）

插件按 surface 分派补丁目标：

| surface | 位置 | 补丁数 | 说明 |
|---|---|---|---|
| `agent` | `resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai` | 81 | CLI / 插件 / 工具 / 提示词 |
| `desktop` | `resources/app`（asar 根 = `@deepseek-ai/dsh-desktop`） | 7 | Electron 主进程（更新接管、关闭行为、退出追踪） |

`desktop` 面在纯 Node/CLI 环境下**不放行**（`allowTargetForPatch` 会拒），因此 `host:baseline` 在这类环境报「补丁不在树上」，属预期，不是漂移。

### 2.3 插件自身的落地位置

```
~/.dsh/profiles/
├── desktop/     ← Electron 应用独占（CLI 改不了，装插件需应用内操作或关掉 app）
├── headless/
├── market/
└── web/
```

客户端产物 `client.js`（545 864 B）随插件安装到 `profiles/desktop/node_modules/dsh-purge/`，宿主前端直接读取；**改它必须重新打包 tgz 并重装 + 重启**，只重启不重装不会变。

---

## 三、总体架构

```
                    ┌──────────────────────────────────────────┐
                    │            宿主（Electron + CLI）          │
                    │  cordis 插件总线 / 工具注册 / 会话运行时     │
                    └───────────────▲──────────────────────────┘
                                    │ apply(ctx) / 工具注册
        ┌───────────────────────────┴───────────────────────────┐
        │                     dsh-purge 插件                     │
        │                                                        │
        │  lib/index.js        入口：apply / 工具 / 命令 / 路由     │
        │  lib/core.js         补丁引擎：发现宿主、重放、回退、记录   │
        │  lib/patches/        88 条补丁的数据层（4 个分册 + 装配）  │
        │  lib/desktop.js      桌面面：更新接管 / 关闭 / 退出追踪    │
        │  lib/update.js       自更新与打包                         │
        │  lib/rewind.js       回退会话（/rewind 命令 + 前端联动）   │
        │  lib/redteam/        红队子系统（工具面 / 剧本 / 报告）     │
        │  client.js           前端产物（单文件，无构建步骤）        │
        └───────────────┬───────────────────────────┬────────────┘
                        │ 写入（带 marker）           │ 只读校验
        ┌───────────────▼──────────────┐   ┌────────▼─────────────┐
        │  宿主文件（asar 解包副本）      │   │  scripts/ 工具链      │
        │  72 个文件键 / 62 个指纹文件    │   │  六道闸 + 9 个 host:* │
        └──────────────────────────────┘   └────────┬─────────────┘
                                                    │ 生成
                                       ┌────────────▼─────────────┐
                                       │ docs/ 基线 + 证据 + 地图   │
                                       │ 7 个 JSON 基线 / 10 份文档 │
                                       └──────────────────────────┘
```

三条贯穿全局的设计原则：

1. **数据与引擎分离**：补丁是纯数据（pattern / replace / marker / 依赖），引擎只在 `core.js` 一处实现；改补丁不动引擎，改引擎不动补丁。
2. **每个结论都有落盘的证据**：闸表、基线、指纹、行为剧本、覆盖率棘轮，全部是仓库里的 JSON/Markdown，不靠记忆。
3. **一切可回退**：补丁写入前留 `.bak`，写入时留 marker，回退按 marker 反查；连「换 asar 目录」都保留 `app.asar.bak`。

## 四、补丁体系

### 4.1 一条补丁长什么样

```js
{
  id: 91, name: 'SUBAGENT_ROUTE_POLICY_BYPASS',
  layer: '代码', layer_en: 'Code',
  desc: '子代理显式路由不再受 Session 策略限制 / allow explicit child LLM routes',
  file: ['tool-subagent'],        // 逻辑文件键 → core.js 的 TARGETS 表映射到真实路径
  rel: ['lib','index.js'],        // 相对 aiBase 的路径片段
  replacements: [
    { pattern: 'throw new Error(`child LLM route …`);',
      replace: 'return; // [dsh-purge] child route policy bypassed' },
  ],
  markers: ['[dsh-purge] child route policy bypassed'],
  surfaces: ['agent'],            // 可选：默认 agent；桌面面显式声明
  after: [45],                    // 可选：硬依赖（#46 的 needle 是 #45 插入的代码）
  skipIfMarked: true,             // 可选：已打则跳过（幂等）
}
```

### 4.2 分层与分布（88 条）

| 层 | 条数 | 说明 |
|---|---|---|
| 代码（Code） | 50 | 改逻辑：策略默认值、沙箱直通、审批自动放行、路由放开 |
| 提示词（Prompt） | 27 | 改注入文案：品牌词、权限锁、审批措辞、队列语义 |
| 工具（Tool） | 8 | 工具参数面：读上限、超时、深度、fetch |
| 0.1.5 / 0.2.0 兼容 | 3 | 只为旧版宿主保留的兼容分支，当前宿主下 na |

按面：`agent` 81 / `desktop` 7。按目标文件键：72 个（一条补丁可挂多个文件，例如 #23 同时打 `subagent` 与 `tool-subagent`）。

### 4.3 五类补丁形状（决定了怎么验证）

| 形状 | 典型 | 验证手段 |
|---|---|---|
| 常量替换 | `default(3)` → `default(10)` | 闸表 needle + 行为剧本 |
| 抛错删除 / 短路 | `throw …` → `return;` | 行为剧本（构造会触发的调用） |
| 提示词改写 | 整句英文替换 | 文案快照 + 注入后可见性 |
| schema 放宽 | `z.boolean().default(false)` → `true` | 配置加载后读回 |
| 结构注入 | 在函数体插入一整个 helper（桌面更新接管） | 注入点前后断言 + 真机演练 |

### 4.4 顺序、依赖、幂等

- **顺序即语义**：`ALL_PATCHES` 的顺序 = apply 顺序，回归测试锁死了「#76 必须先于 #70」这类优先级；
- **显式依赖**：`after: [45]` 表示 needle 来自另一条补丁插入的代码，乱序会变 `missing_file`；
- **幂等**：`skipIfMarked` + marker 扫描，重复 apply 不会叠加；
- **回退**：`revertAll` 按 marker 反查并还原 `.bak`，`revertCmdFlash` / `revertAllShims` 各自管一段。

### 4.5 状态语义（五档，不混用）

| 状态 | 含义 | 处置 |
|---|---|---|
| `settled` | 补丁已打上，且树上能找到 marker | 无需动作 |
| `would-apply` | 锚点还在，但还没打 | 重打即可 |
| `drifted` | 锚点变了（上游改代码） | 需要改 needle |
| `no-file` | 目标文件不在当前 surface（桌面面在 CLI 下就是这种） | 预期，不是故障 |
| `na` | 该宿主版本不适用（旧版兼容分支） | 无需动作 |

**判据纪律**：状态戳说 `applied` 但树上找不到 marker → 直接判 `broken`；`review` 只是指纹过期（重记即可），`drifted` 才需要修补丁。

---

## 五、六道闸（每次 `npm run check`）

| 闸 | 检查什么 | 当前结果 |
|---|---|---|
| `check:syntax` | 288 个 JS 文件的语法 + `lib/index.js` 能否 import | PASS 288 files |
| `check:metadata` | 版本一致、补丁数 = 注册表、测试文件数 | PASS version=1.1.96 patches=88 tests=142 |
| `check:eol` | 361 个文本文件的行尾一致性（CRLF/LF 混用会让跨行锚点全对不上） | PASS 361 files |
| `check:client` | 前端产物锚点哈希 + 结构（drill markers / dock anchors）+ 生成片段同步 | PASS |
| `check:gates` | 闸表与补丁注册表一一对应（新增补丁没登记闸 → 红） | PASS 88 行 60 gated |
| `check:test` | 全量 `node:test` | 3888 例 / pass 3886 / fail 0 / skip 2 |

### 5.1 为什么是这六道

每一道都对应一次真实事故：

- **syntax**：改动 `lib/core.js` 时误删一个括号，宿主启动时才炸；
- **metadata**：版本号改了但 `docs/patch-gates.json` 没重生成 → 发布包里闸表描述旧版本；
- **eol**：`ops_edit_file` 在 CRLF 文件里插入一行 LF，跨行锚点从此对不上（本轮踩了 3 次）；
- **client**：`client.js` 没有构建步骤，手改一处就会与 `docs/origin/client-1.1.94.js` 锚点漂移；
- **gates**：新增补丁忘了登记闸，闸表就永远少一条，等于「这条补丁没有任何独立证据」；
- **test**：所有上面五道闸都通过，也可能行为是错的 —— 只有用例能证伪。

---

## 六、测试体系

### 6.1 规模与结构

- **142 个测试文件**，全部 `node:test` + `node:assert`，零依赖；
- **3888 个用例**（本机 pass 3886 / skip 2）；
- 分层：单元（纯函数）→ 集成（补丁引擎 + 假宿主树）→ 真机（`.tmp-rehearse` 解包副本）→ 契约（宿主发行物结构）。

### 6.2 覆盖率棘轮

| 指标 | 覆盖 / 总数 | 比例 |
|---|---|---|
| 行 | 35 113 / 36 819 | **95.4%** |
| 分支 | 11 046 / 12 657 | **87.3%** |
| 函数 | 2 107 / 2 302 | **91.5%** |

基线存 `docs/test-baseline.json`（78 个文件），规则是**只许涨**。允许一处例外：`ENV_TOLERANCE`（目前只有 `lib/desktop.js` 的 `lh: 7`）—— 因为它的覆盖率依赖 `%TEMP%` 重启脚本残留、`$DSH_HOME`、npm 全局 DSH 等**本机文件系统现状**，同一份代码在干净 worktree 上是 1837 行、在当前树上是 1835 行，基线 1842 根本复现不出来。容差内下跌仍进 `tolerated` 报告留痕，超出照样红。

### 6.3 RED 演练方法论

每条新用例都要先证明它**会红**：

1. 写用例 → 绿；
2. 把实现改坏（`return` 改 `throw`、`slice` 改 `throw`、删一行转发）；
3. 用例必须立刻变红；
4. 改回实现，`git diff` 必须为空。

本轮实例：

- `lib/chat-rules-skills.js` 的 `还原失败:` 分支：改成 `throw e` 后用例红；
- `lib/skills.js` 的 `slice(1,-1)` YAML 兜底：改成 `throw` 后红；
- 三条「不可达」结论（`lib/index.js` 10 行、`lib/uninstall.js` 18 行、`lib/skills.js` 44 行）都是先试 RED、发现「RED 里也绿」才判定为真盲区，而不是懒。

### 6.4 已知盲区（明确写进文档，不当成 100%）

| 位置 | 行数 | 为什么测不到 |
|---|---|---|
| `lib/index.js` | 10 | `installWebServer` 无条件 `ctx.inject`；`seedPromptInjectAtBoot` 按契约只返回 `action:"error"` 不抛；需 `settleInstalledPatches` 的 promise 拒绝 |
| `lib/uninstall.js` | 18 | 全是 `catch (e) { report.errors.push(...) }`，而 `core.revertAll` / `revertAllShims` / `revertCmdFlash` 是 ESM 命名空间导出，不可 stub |
| `lib/skills.js` | 44 | `restoreSkillFromBackup` / `installBundleDir` 失败回滚需注入 fs 故障；`extractArchive` 的 tar 分支依赖外部 tar |
| `lib/host.js` | 2 | `scheduleCleanupRestart` 会 `copyFileSync` + spawn helper，直接调用会拉起后台进程 |
| `client.js` 三层上游源码 | — | 上游只发压缩产物，源码失传；只能做锚点 + 结构校验，不能单测 |
| 桌面三条 powershell | — | 需真 Windows 桌面环境与真实安装器 |

## 七、宿主升级可维护性：四个问题与九个工具

这是整个项目最重要的部分。宿主一升级，必须能在一小时内回答四个问题。

### 7.1 问题一：旧补丁还需要吗？

`npm run host:status` —— 五档判定（settled / would-apply / drifted / no-file / na）+ 指纹核对。

输出示例（本轮真机）：

```
[host] host 0.2.2-rc.3 (未变)  verdict=review
[host] 补丁状态变化 2 条
     91 SUBAGENT_ROUTE_POLICY_BYPASS   would-apply -> settled
     94 SUBAGENT_MODEL_DISCOVERY_BYPASS would-apply -> settled
```

### 7.2 问题二：打上去了，效果对吗？

`npm run test:behavior` —— 21 个剧本，覆盖 18 条补丁，断言**可观测行为**（拒绝还是放行、审批弹没弹、文件落没落盘、退出码与 stderr 关键行），不看 marker。

### 7.3 问题三：新宿主多了哪些限制点？

`npm run host:census` —— 静态普查（下一节详述）；`npm run host:choke -- --sites` —— 站点级覆盖（再下一节）。

### 7.4 问题四：从零造一条补丁？

`npm run host:new-patch` —— 给一段上游文本，自动生长**最短唯一锚点**，并拒绝猜 replacement（replacement 必须人来写，因为那是「改成什么」的语义决定）。

### 7.5 工具全景

| 命令 | 回答的问题 | 产物 |
|---|---|---|
| `host:status` | 现在这棵树是什么状态 | 五档 + 指纹偏差 |
| `host:capture` | 把当前状态记成基线 | `docs/host-baseline.json` |
| `host:snapshot` | 树上每条补丁的 marker 快照 | 快照文件 |
| `host:preview --version X` | 升到 X 会坏几条（隔离安装，不碰真机） | 预演报告 |
| `host:matrix` | 每条补丁在新树上还「有事可做」吗 | 矩阵 |
| `host:gates` | 闸表在新树上还成立吗（`--compare` / `--verify`） | 闸表差异 |
| `host:new-patch` | 自动生长唯一锚点 | 补丁草稿 |
| `host:rehearse` | 端到端升级排练（预演 + 判定 + 报告） | 演练记录 |
| `host:census` | 还有哪些限制点没被覆盖（静态） | `docs/restriction-census.json` |
| `host:choke --sites` | 站点级覆盖：包内每个决策点打没打 | `docs/choke-baseline.json` |
| `host:contract` | 宿主契约（服务 / 成员 / 事件 / 导出）还在不在 | `docs/host-contract.json` |
| `host:sandbox` | 旁路副本重打全部补丁，与基线逐字节对拍 | 差异报告 |

### 7.6 真机升级的两次实战

**第一次（rc.1 → rc.3，asar 化）**：结果 incompatible → 定位到「asar 打包导致目标路径消失」，写下换目录方案；第二次执行成功。

**换目录方案**（`swap-rc3.cmd` + `repair-cli.mjs`）：

1. 用 `wmic process call create` 把脚本从宿主进程树里摘出去（否则 `taskkill` 会连脚本自己一起收掉 —— 第一版就死在这里，安装器从未执行）；
2. kill 宿主（9 个进程）→ `repair-cli` 重建 runtime junction 与 `dsh` / `dsh.cmd` / `dsh.ps1`；
3. `move /Y app.asar app.asar.bak` → 以 `app.asar.unpacked/dsh` 为根启动；
4. 校验：`host:baseline` 自动定位宿主、`host:contract` PASS 25/25、`host:status` verdict=ok。

**顺带修的真缺陷**：契约扫描器不认 rc.3 的单行 minified 写法（`var SlotRegistry=class extends …{…constructor(ctx){super(ctx,`slots`)…}}`）→ 给 `hasServiceProvider` / `hasMemberDecl` / `hasEventName` 加反引号与压缩分支，`host:contract` 从 24/25 回到 25/25。

---

## 八、限制面普查（`host:census`）

### 8.1 它解决什么

`host:baseline` 只知道「我打过的地方还在不在」，不知道「上游新加了哪些限制」。census 从原件里**反向找限制点**，再与补丁的 needle 位置对齐，回答「哪些限制点我们从未覆盖」。

### 8.2 三层收敛（1615 → 33）

| 层 | 手段 | 剩余 |
|---|---|---|
| 形状匹配 | 6 类正则：`deny-copy-en` / `deny-copy-zh` / `deny-error-class` / `escalate-entry` / `confine-call` / `policy-enum` | 1615 命中 |
| 噪声过滤 | 注释行、`key: [` 失败签名表、`*_ERROR_CODES`、生成物（`client.js` / `typert.*`）、单行 > 2000 字符 | 134 站点 |
| 归属判定 | `scopeOf` 只留 `agent` 面；`protocol` / `renderer` / `vendor` 归传输与前端语义 | 80 站点 |
| 覆盖对齐 | 补丁 needle 定位（多行 needle 用整体 `indexOf` + 二分折行号，406 处定位 154 处） | 未覆盖 116 |
| 上游短路 | 5 个包已被 `#15` / `#16` 等整段打穿，其内部限制点属「死代码」 | 候选 **33** |

### 8.3 当前数字（基线 `docs/restriction-census.json`）

| 维度 | 数值 |
|---|---|
| 限制站点 | **134** |
| 已覆盖 | 18 |
| 未覆盖 | 116（严格 87 / 弱信号 29） |
| 按范围 | agent 80 / vendor 42 / protocol 11 / renderer 1 |
| **候选（agent 面 · 未覆盖 · 未被上游短路）** | **33**（行为闸门 24 / 策略结构 9） |
| 上游短路忽略 | 29 |

按形状：`deny-copy-en` 95（未覆盖 89）、`deny-error-class` 18（12）、`escalate-entry` 11（6）、`confine-call` 5（5）、`policy-enum` 4（3）、`deny-copy-zh` 1（1）。

### 8.4 33 条的裁决结论

> 分五组逐条读原件裁决，结论先行：**33 条里没有一条是「我们 agent 的真闸门还没打」**；真正的收获是两条条件项 + 一个配置键 bug。

| 组 | 条目 | 裁决 |
|---|---|---|
| 沙箱核心 13 | #6 #7 #8 #9 #10 #11 #12 #13 #14 #15 #26 #27 #28 | **全不打**：10 条已被 #15 / #16 变成死代码；#7/#8 needle 不唯一；#12 无 patch target；#26–#28 是纯枚举（#28 还被 5 个工具 schema 共享） |
| 审批提权 8 | #17 #19 #25 #29 #30 #31 #32 #33 | #25/#29/#30/#32/#33 全不打（内核已被 #13/#14/#35 打穿，再打零变化）；#17/#19 是当前不可达的组合守卫（要打就 `return void 0`，bash/pwsh 同进同退）；#31 需 1964-1966 联合补丁，单删只把「明确报错」变「静默不升级」 |
| 文件/参数 4 | #4 #5 #20 #24 | 全不打：#4/#5 是 OS 错误转发（改了会把真实 ACL 误配置藏起来）；#20 是参数纠正提示；#24（URL 带 `user:pass`）唯一有真价值但属加功能 |
| 子代理路由 3 | #21 #22 #23 | **#21 + #23 打**（唯一真能力闸门 + 配套发现面）；#22 不打（单删会 `firstRoute.model` 未定义崩） |
| 实验/基建 5 | #1 #2 #3 #16 #18 | 全不打：#1 与 #59 重复；#2 会把「明确失败」降级成「未知」；#3 另有 3 处一致性检查；#16 配置枚举；#18 纯描述文本 |

### 8.5 落地结果（1.1.96）

| 改动 | 内容 |
|---|---|
| #91 `SUBAGENT_ROUTE_POLICY_BYPASS` | `dsh-tool-subagent/lib/index.js:88` 的 `assertAllowedModelSelection` 抛错 → `return;` |
| #94 `SUBAGENT_MODEL_DISCOVERY_BYPASS` | 同文件 `:197` 的策略过滤 `throw` → `void 0;` |
| 配置键修复 | `presets/redteam/agent.cordis.yml` 的 `modelSelectionSettings: true` → `modelSelection: true` + `modelDiscovery: true`（原键名宿主不认，schemastery 静默剥掉，红队预设「开了模型选择」从未生效） |

真机验证：两条补丁 would-apply → **settled**，目标文件 28 458 → 28 169 字节；闸表 86 → 88 行（60 gated）；基线重记 88 条。

---

## 九、站点级限制面（`host:choke --sites`）

包级覆盖只能回答「这个包有没有补丁」，站点级才能回答「包内 17 个决策点里打了几个」。

| 指标（rc.3 已打补丁树） | 数值 |
|---|---|
| 站点 | **237** |
| 已覆盖 | 25 |
| 未覆盖 | 212 |
| 真缺口（gaps） | **24** |
| 待观察（watch） | 151 |

gaps 前五：`dsh-sandbox` 4 / `dsh-permission-presets` 3 / `dsh-fs-sandbox` 2 / `dsh-sandbox-local` 2 / `dsh-sandbox-policy` 2。

典型结论：`dsh-sandbox` 有 17 个决策点，只有 5 个被补丁覆盖 —— 这句话包级扫描永远说不出来。

---

## 十、前端产物链与「回退」按钮下线

### 10.1 client.js 的特殊性

`client.js`（545 864 B）是**无构建步骤的单文件产物**：上游只发压缩后的成品，源码失传。因此它的维护方式是：

- 锚点：`docs/origin/client-1.1.94.js` 的 hash 由 `check:client` 校验（当前 `6de9c8dae636ad5e…`）；
- 结构：DRILL 标记、dock 锚点逐项断言；
- 生成片段：`lib/redteam/client.js` 那一段由 `build:client` 生成，`check:client` 校验同步。

### 10.2 下线「回退」按钮

工具栏里那个「回退」按钮不是宿主功能，是本插件自己用 `createPortal` 做的 DOM 手术：在 `body` 上建 fixed 宿主，按 `[class*="standardControls"]` 的矩形定位，还给输入框预留 64 px padding。

处置方式是**关挂载不加菜单**：

```js
const REWIND_BUTTON_ENABLED = false;   // client.js:9136
… REWIND_BUTTON_ENABLED ? h(RewindDockMount) : null   // overlay 子节点
```

刻意保留：`RewindDockMount` / `RewindButton` / `RewindSafe` / `RewindFallback` / `REWIND_CSS` / i18n / `installRewindWatch`（`/rewind` 命令仍可用，回退后仍靠 watch 拉起新会话、把上一句塞回输入框）。

结构性锁：`scripts/test-rewind-button-off.mjs` 断言开关为 false、挂载点被挡住、且上述东西都还在 —— 防止有人「清理死代码」时把 `/rewind` 一起带走。

---

## 十一、红队子系统、桌面端与自更新

### 11.1 红队子系统

- 预设：`presets/redteam/agent.cordis.yml` —— 子代理 `maxDepth: 1`（叶子节点，不允许多层委派）、`toolFilter` 已废弃（0.2.1-rc.2 起写在预设里会让整份预设注册失败）；
- 工具面：`lib/redteam/tools.js`（2 257 行 → 474 行拆分）+ 剧本 / 报告 / 回放；六个 `redteam_poc_*` 曾漏 `args`，已修；
- 报告链：`score-report.js` 曾漏 import `tunnelIsLegit`，`report-replay` 的 `buildCurlCommand` 曾忽略 `headers`，均已修；
- 模型选择：本轮修好预设键名后，红队才能真正按模型切子代理路由（配合 #91 / #94）。

### 11.2 桌面端 7 条补丁

| 补丁 | 作用 |
|---|---|
| #45 `OFFICIAL_DESKTOP_UPDATE_HANDOFF` | 接管官方自动更新（改为本地脚本，避免静默升级） |
| #46 `OFFICIAL_DESKTOP_UPDATE_ASCII` | 接管脚本改纯 ASCII，中文 Windows 不再吞换行 |
| #82 `DESKTOP_SHELL_PROFILE_FALLBACK` | profile 找不到时回退 shell |
| #83 / #84 | 关闭与退出码：不再 fatal、非零也当正常 |
| #92 / #93 | host / main 退出追踪，用于定位「退出没日志」 |

### 11.3 自更新与打包

`npm pack` 产出 `dsh-purge-<version>.tgz`（当前 1.1.96：3 445 871 B / 373 files）。安装到桌面 profile 时会被宿主挡（Electron 独占），必须应用内装或关掉 app 后 `dsh plugin --profile desktop add`。

## 十二、数据总览

| 指标 | 数值 |
|---|---|
| 插件版本 | 1.1.96 |
| 宿主版本 | 0.2.2-rc.3（`dshTarget`；兼容窗口还含 rc.2 / rc.1 / 0.2.1-rc.5 / 0.2.1-rc.2） |
| 补丁 | 88（agent 81 / desktop 7） |
| 宿主目标文件键 | 72 |
| 已记录指纹的宿主文件 | 62 |
| 补丁状态（真机） | settled 79 / would-apply 2 / drifted 0 / no-file 7 |
| 闸表 | 88 行 / 60 gated / native 2 |
| 行为剧本 | 21 个，覆盖 18 条补丁；双证 18；无外部证据 0 |
| 限制站点 / 候选 | 134 / 33（落地 2） |
| 站点级 choke | 237 站点 / 已覆盖 25 / 真缺口 24 |
| 测试文件 / 用例 | 142 / 3888 |
| 覆盖率（行/分支/函数） | 95.4% / 87.3% / 91.5% |
| `lib/` 规模 | 91 文件 / 44 760 行（最大 `core.js` 5 206 行，原 9 061 行） |
| `scripts/` | 196 个 `.mjs`，27 个 npm 脚本 |
| 前端产物 | `client.js` 545 864 B |
| 文档 | 10 份 Markdown + 7 个 JSON 基线 |
| Git | 183 次提交，2026-11-10 → 2026-11-15 |

---

## 十三、已知风险与盲区

### 13.1 结构性风险

| 风险 | 触发条件 | 影响 | 现有缓解 |
|---|---|---|---|
| 宿主再换打包方式（asar → 其它） | 下次大版本 | 换目录方案失效，需重新设计 | `host:preview` 预演 + `rehearsal-*.md` 记录方法 |
| 上游把限制写得更隐蔽（运行期拼接文案） | 上游重构 | 静态普查看不见，候选漏报 | 行为剧本 + `host:differential`（未开工） |
| minified 发行物再变形 | 上游换压缩器 | 契约扫描 / needle 全失效 | `hasMemberDecl` 已加压缩分支；`host:new-patch` 可重长锚点 |
| 桌面面在 CLI 环境不可测 | 一直存在 | 7 条桌面补丁只有真机验证 | 演练脚本 + 真机 `host:status` |
| 本机文件系统现状影响覆盖率 | 换机器 / 清理 %TEMP% | 覆盖率抖动 | `ENV_TOLERANCE` 仅 1 处 7 行，超差仍红 |

### 13.2 明确不修的东西（有意为之）

- `lib/net-scope.js` 的 `writeAllowText`：上游空壳，引用未声明变量，`POST /own-servers` 恒 500 —— 属上游缺陷，修了会掩盖；
- `lib/web.js` 的 `spawnRestartHelper`：会 `process.exit`，不可在测试里跑；
- `lib/skills.js` 的 `removeOfficialSkill`：已永久放弃；
- 30 条普查候选：逐条写了「为什么不打」，避免下次升级重复讨论。

---

## 十四、运维手册

### 14.1 日常三件事

```bash
npm run check          # 提交前必跑：六道闸
npm run host:status    # 怀疑补丁没生效时
npm run test:behavior  # 改了补丁语义后
```

### 14.2 宿主升级 playbook

```bash
# 1) 预演：隔离安装目标版本，只看「会坏几条」，不碰真机
npm run host:preview -- --version 0.2.2-rc.4

# 2) 真机升级（换目录方案）：解包 → 备份 → 换名 → 重启 → 修复 CLI
node scripts/repair-cli.mjs

# 3) 升级后三连
npm run host:contract      # 契约还在不在
npm run host:status        # 五档 + 指纹
npm run host:capture       # 记新基线

# 4) 若 drifted：重长锚点
npm run host:new-patch

# 5) 若出现新限制点
npm run host:census && npm run host:choke -- --sites
```

### 14.3 回退

| 场景 | 动作 |
|---|---|
| 某条补丁打错 | `purge_revert` / `revertAll`：按 marker 反查并还原 `.bak` |
| 整个插件失效 | 卸载插件 + `app.asar.bak` 换回原名重启 |
| 宿主升级后不可用 | 同上，回到上一版 asar 备份 |

### 14.4 发布流程

```bash
npm run check                 # 六道闸全绿
npm version patch             # 或手改 package.json + release-notes
npm run host:capture          # 基线记到新版本
npm run impact:patches        # 影响矩阵重生成
npm pack                      # 出 tgz
git add -A && git commit && git push   # CI 自动跑同一套闸
```

---

## 十五、演进史

| 日期 | 里程碑 |
|---|---|
| 2026-11-10 | 建立维护仓库基线（Git + 远端 + CI），确定「可维护性优先」 |
| 11-10 ~ 11-11 | 六道闸成型；宿主适配基线 `docs/host-baseline.json`（86 补丁 / 三级 verdict）；前端锚点 + `check:client` |
| 11-11 ~ 11-12 | 元数据清债；测试机制（`node:test` + 覆盖率棘轮 + `docs/test-map.md` 能力地图与盲区清单） |
| 11-12 ~ 11-13 | 巨型文件拆分：`core.js` 9 061 → 5 194、`index.js` 2 954 → 429、`redteam/tools.js` 2 257 → 474、`store-core.js` 5 430 → 3 822 |
| 11-13 | 行为级验证体系（`patch-behaviors.mjs`，18 条双证）；`docs/patch-impact.md` 生成 |
| 11-14 | rc.3 预演：71 条可打 / 0 打断 / 15 不适用；发现 asar 打包 |
| 11-15 上午 | rc.3 真机落地：换目录方案 + `repair-cli`；修 minified 契约扫描；基线重记 72 / 62 文件 |
| 11-15 中午 | `host:census` 限制面普查（134 站点 → 33 候选）；`host:choke --sites` 站点级覆盖（237 站点 / 24 缺口） |
| 11-15 下午 | 33 条逐条裁决 → 只打 2 条（#91 / #94）+ 修预设键名 bug；1.1.95 → **1.1.96**；88 条补丁 / 60 gated / 3888 用例 |

---

## 十六、还能往哪走

| 方向 | 价值 | 代价 |
|---|---|---|
| **`host:differential` 端到端差分** | 补上「文本在、行号对，但效果没发生」的盲区：12 个剧本 × pristine vs patched 双跑，diff 退出码 / stdout / stderr / 拒绝或放行 / 审批 / 落盘 | 两套完整运行时 + 12 个剧本断言 |
| 覆盖率尾巴 | `skills` 44 行失败回滚、`uninstall` 18 行 catch、`index` 10 行不可达 | 需注入 fs 故障或改契约，收益低 |
| #24 basic-auth 抓取 | 唯一有真价值但属**加功能**：剥离 URL 凭据 + 注入 Authorization + 跨源重定向清头 | 中 |
| #17/#19 防御性补丁 | 当前不可达的组合守卫，防将来配置变化 | 低（要 bash/pwsh 同进同退） |
| rc.4 预演 | 继续验证「升级不打断」 | 低（一条命令） |

---

## 附录 A：文件地图

```
dsh-purge-maintained/
├── lib/
│   ├── index.js            插件入口（apply / 工具 / 命令 / 路由）
│   ├── core.js             补丁引擎（发现宿主 / 重放 / 回退 / 记录）
│   ├── patches/            88 条补丁的数据层
│   │   ├── patch-registry.mjs     （提示词族）
│   │   ├── code-patches.mjs       （代码族）
│   │   ├── engine-patches.mjs     （引擎族）
│   │   ├── new-tool-patches.mjs   （工具族，含 #91 / #94）
│   │   └── index.mjs              （装配：顺序 = apply 顺序）
│   ├── desktop.js          桌面面（更新接管 / 关闭 / 退出）
│   ├── update.js           自更新与打包
│   ├── rewind.js           回退会话
│   ├── skills.js           技能安装 / 导入 / 归档
│   ├── redteam/            红队子系统
│   └── … 共 91 个文件
├── scripts/                196 个工具/测试脚本
│   ├── check-*.mjs         六道闸
│   ├── host-*.mjs          宿主适配（status/capture/preview/matrix/gates/rehearse）
│   ├── restriction-census.mjs  限制面普查
│   ├── scan-chokepoints.mjs    站点级覆盖
│   ├── patch-behaviors.mjs     行为剧本
│   └── test-*.mjs          142 个测试文件
├── docs/
│   ├── test-map.md         能力地图 + 盲区清单（16 节）
│   ├── patch-impact.md     补丁影响矩阵
│   ├── host-baseline.json  宿主补丁基线（88 条 / 62 文件）
│   ├── patch-gates.json    闸表（88 行）
│   ├── restriction-census.json  普查基线
│   ├── choke-baseline.json 站点级基线
│   ├── host-contract.json  契约快照
│   ├── test-baseline.json  覆盖率棘轮基线
│   └── rehearsal-0.2.2-rc.3.md  升级演练记录
├── presets/                预设（redteam 等）
├── client.js               前端产物（545 KB，无构建）
└── .github/workflows/      CI（与本地同一套 check）
```

## 附录 B：术语表

| 术语 | 含义 |
|---|---|
| aiBase | 宿主 `@deepseek-ai` 包根目录 |
| surface | 补丁作用面：`agent`（CLI/插件）或 `desktop`（Electron 主进程） |
| needle / pattern | 补丁用来定位的原文片段 |
| marker | 补丁写入后留在文件里的标记，用于幂等与回退 |
| gate（闸表） | 每条补丁一句「上游限制还在不在」的短锚点 |
| settled / would-apply / drifted / no-file / na | 补丁五档状态 |
| census | 静态限制面普查 |
| choke site | 包内一个具体决策点（相对于「整包有没有补丁」） |
| 双证 | 行为剧本 + 闸表同时为一条补丁作证 |
| 棘轮 | 覆盖率基线只许涨 |

---

*本报告由仓库内实测数据生成（`docs/host-baseline.json`、`docs/patch-gates.json`、`docs/restriction-census.json`、`docs/choke-baseline.json`、`docs/test-baseline.json`、`docs/patch-impact.md`），数字与 1.1.96 提交 `769308a` 一致。*


