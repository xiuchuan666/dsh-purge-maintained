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
4. `npm test`：`node --test "scripts/test-*.mjs"`，离线、默认不含覆盖率，实测约 1 秒。

默认检查不读取或改写 DSH profile，不应用宿主补丁，也不需要安装宿主。补丁数量从 `ALL_PATCHES` 动态读取，不在检查器里固定写死。

新增独立回归测试时，将文件命名为 `scripts/test-<主题>.mjs`，失败时设置非零退出码或抛出异常，成功时正常退出。测试临时数据放在系统临时目录，并在结束时清理。

命令分三层，按「什么时候跑」选：

| 命令 | 用途 | 耗时 | 需要什么 |
| --- | --- | --- | --- |
| `npm test` | 改完就跑。只跑测试 | 约 1 秒 | 无 |
| `npm run check` | 提交前跑。语法 + 元数据 + 前端产物 + 测试 | 约 3 秒 | 无 |
| `npm run test:full` | 想知道「有没有让覆盖率倒退」时跑。测试 + lcov + 与基线比对 | 约 2 秒 | git 工作副本 |

`test:full` 用的是**棘轮基线**（`docs/test-baseline.json`），不是百分比阈值：只要求每个文件的行 / 函数 / 分支覆盖不低于记录值，涨上去之后用 `npm run test:baseline` 手动刷。理由很实际——把阈值定在 17% 等于宣布 `lib/core.js` 烂着也算合格；棘轮只记住「现在是多少」，然后逼它单向往上走。

无 `.git` 的目录（例如 `npm pack` 解包出来的 tgz）跑 `test:full` 会返回退出码 2 并说明原因，不会误报覆盖率下降：`lib/update.js` 里 `gitHead` / `canGit` 的 catch 分支在无 git 时走不到，行数天然少十几行。这是环境差异，不是倒退。

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

## 测试地图：哪个能力坏了，看哪一行

[测试地图](docs/test-map.md) 把每个能力对到具体守卫，按子系统分十节。改东西前先查两件事：

1. 我要动的这块，有没有守卫？表里 `—` 或 `❗缺` 就是没有，改完只能靠手验。
2. 我要加的能力，加完记得补一行，否则它从第一天起就是盲区。

地图里 `❗缺` 的行是待办池。挑活的标准写在文件末尾：优先挑「改坏了没人能发现、且用户能感知」的——提示词注入与 HTTP 路由排在计分口径前面。

补测试时优先抓**跨路径一致性**：同一个数字由三条路径分别算出来（例如演练台的面板 / 报告 / 攻击链），只断言「三处相等」还不够——三处一起错的时候仍然全绿。要么先把其中一处改成错的值验证会红（RED），要么把条目级字段（`counted` / `capped` / `points`）也逐条钉住。

### 写测试的约定（node:test）

所有测试用 `node:test` 的 `test()` 而不是顶层裸 `assert`。理由不是「更现代」，是**一次看到所有失败**：裸 `assert` 第一条红就抛出，同一个文件里后面的断言永不执行，于是「修一条、再跑、又红一条」这样来回。实测对照过——同一个文件里故意坏两处，裸 `assert` 只报第一处，`node:test` 同时报两处并各自带用例名。

```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("缓存命中时不再重建", () => {
  // 每个 test 自带隔离：临时目录、临时 store、临时环境变量
});
```

三条硬约定：

- **每个 test 自带隔离。** 不要依赖同文件里前一个 test 留下的状态，即使 `node:test` 默认按声明顺序串行。将来一旦有人加 `--test-concurrency` 或调整顺序，依赖顺序的测试会变成假红，而假红会训练人忽略红字。
- **`test.after()` 清理临时目录。** Windows 上目录被占用会静默残留，攒多了干扰下一次运行。
- **改环境变量要在 `finally` 里恢复。** 例如 `USERPROFILE` / `HOME`——`os.homedir()` 每次调用都重新读，改了立即生效，忘了恢复会污染同进程后续所有用例。

- **测试要在 Linux 上也能过。** CI 跑在 `ubuntu-latest`，而开发机是 Windows。最容易踩的是 `path.basename`：在 Linux 上它**不把反斜杠当分隔符**，所以 `'C:\\x\\DeepSeek Harness\\DeepSeek Harness.exe'` 整串会被当成一个文件名，断言「官方 exe 走 windows-official 分支」在 CI 上变成 `helper`。写路径常量一律用正斜杠（`C:/x/DeepSeek Harness/DeepSeek Harness.exe`）——被测代码里的 `path.basename` 在 Windows 上同样认正斜杠，两边结果一致。这条是真实事故：`580c273` 本地全绿、CI 红了一条。

还有一个坑值得记：**断言要查值，不只查形状。** 拆 `test-plugin-surface.mjs` 时发现过真实漏洞——把 `DEFAULTS.enabled` 从 `true` 改成 `false`，原来 13 条测试全绿，因为它们只断言「有 18 个键」「布尔键会收敛字符串」，从不查默认值本身。这类改动最该被看见：用户升级后会突然发现功能默认关掉了。

### 现状锁定：把「我知道它不对，但现在不改」写进测试

补测试时会遇到一类代码：行为明显不对，但改它属于产品决策，不属于「补测试」这一轮。例如：

- `/own-servers` POST 永远 500（`lib/net-scope.js` 的 `writeAllowText` 引用了未声明的 `allowCache`，且忽略全部入参）；
- `scoreChain` 的 `summary.totalPoints` 恒为 `undefined`（`listScorePoints` 根本没有这个字段）；
- `addWebshell` 重复登记时不传 `status`，会把 `offline` 覆盖回 `online`（`normalizeShellStatus(undefined)` 得到 `"online"`，再被 `COALESCE` 写进去）。

处理方式统一为**现状锁定**：断言当前行为，并在用例名或注释里写明「这是现状，不是期望」。三个要求：

1. 用例名里带「现状锁定」四个字，让人搜得到、看得懂；
2. 注释写清**为什么现在不改**（属产品决策 / 上游刻意留空 / 改了要过锚点对拍）；
3. 断言要精确到具体表现（`status === 500` 且 `error` 含 `allowCache is not defined`，而不是「返回不是 200」）。

这样做的价值：改动无法悄悄发生。将来真要修，会先红一条写着「现状锁定」的用例，而不是在无人察觉的情况下改变用户可见行为。**不要**顺手「修好」这类代码——那不是补测试，是改产品。

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

### 宿主契约：我们调的 API 还在不在

`host:status` 有两层判定，缺一层就会假绿：

| 层 | 看什么 | 数据 | 宿主改名时会怎样 |
| --- | --- | --- | --- |
| 补丁适配 | 86 条补丁的 pattern 还能不能在宿主源码里匹配上 | `docs/host-baseline.json` | 照样 `settled` —— 补丁改的是文本，不是 API |
| 宿主契约 | 我们调的 `ctx.webServer.register` / `settings.update` / 事件名等还在不在 | `docs/host-contract.json` | 立刻 `broken` |

补丁是**文本替换**：宿主把 `ctx.webServer` 改名成 `ctx.httpServer`，一段不含 `webServer` 字样的补丁依然能原样打上去，`verdict` 还是 `ok`，但插件启动时就崩。契约层补的就是这个盲区。

```bash
node scripts/host-contract.mjs                # 只查契约
node scripts/host-contract.mjs --json          # 机器可读
npm run host:status                            # 补丁 + 契约合并判定
```

退出码 `0` = 全部命中，`1` = 有缺失，`2` = 探测或用法失败。只读，不写宿主。

#### 为什么要优先读 `.dshpurge.bak`

宿主树里现在有 58 个 `.dshpurge.bak`，它们里面 `[dsh-purge]` 标记数为 0——**备份是官方原文**。扫描必须优先读备份，否则会读到自己注入的代码，把「我们自己加的东西」当成「宿主承诺的契约」，形成自证式假绿。

这不是理论风险。实测证据：`dsh-settings/lib/index.js` 当前文件比它的 `.dshpurge.bak` 多出 5 个方法——`register` / `get` / `ensureLegacyDocument` / `persistLegacy` / `commitLegacy`，全部来自补丁 **#42 `SETTINGS_LEGACY_API`**（`file: settings`，12 条 replacement，带 `// [dsh-purge] legacy settings api` 标记）。而 `lib/preset-default.js:109` 恰好调了 `settings?.get?.(...)`。也就是说：**这一行依赖的是我们自己注入的方法，不是宿主契约**。如果扫描读当前文件，`settings.get` 就会假通过；读 `.bak` 才会明确告诉我们「宿主没有这个」。

#### 为什么粒度要到成员，还要允许「服务包 ≠ 实现包」

只查「`webServer` 由 `dsh-host-webserver` 提供」不够——宿主保留了服务、删掉某个方法，照样崩。所以契约里每个服务都列 `members`。

但成员不一定长在服务包上。实测反例：`subprocess` 服务由 `dsh-subprocess` 提供，而 `resolveExecutable` 的方法体在 `dsh-subprocess-local/lib/index.js:1523`。只查服务包会一条都找不到。契约用 `memberProviders` 覆盖：

```json
{ "name": "subprocess", "package": "dsh-subprocess",
  "members": ["resolveExecutable"],
  "memberProviders": { "resolveExecutable": "dsh-subprocess-local" } }
```

缺失时报告会顺手告诉你方法现在在哪个包——升级当天最常见的情况不是方法消失，而是「方法还在，搬包了」：

```text
member  subprocess.resolveExecutable  dsh-subprocess 里没有 resolveExecutable() 的声明（但在 dsh-subprocess-local 里有，可能搬包了）
```

#### 契约里刻意不写的东西

- `ctx.__dshPurge*`（SessionHook / RewindDerive / PresetHook 等 10 个）：我们自己在 ctx 上挂的，不是宿主 API。
- `redteam` / `redteamMode`：我们自己 `ctx.provide` 的。
- `desktopRuntime` / `desktopActions`：宿主全树 0 命中，桌面壳的可选服务；调用处（`lib/desktop.js:1015`）已经用 `typeof runtime.requestRestart === "function"` 做了防御，写进契约只会制造噪音。
- `settings.get`：见上，是我们注入的。

这些都在 `docs/host-contract.json` 的 `notChecked` 里写明理由，避免下次有人以为漏了。

#### 判定只有一份

`host:status` 不重算契约，只调 `checkContract()` 拿结果再合并 verdict（`mergeVerdicts`：任一层 broken 就是 broken）。补丁分类同样只有 `verify-target` 一处实现。这条规矩来自补丁 #88 的历史教训——同一件事两处判定，一处改了另一处没改，就会互相打脸。

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
| 模板 | `lib/patches/templates.mjs` | 90 | 提示词字面量、网络模板、替换链 helper |
| 注册表 | `lib/patches/patch-registry.mjs` | 276 | `PATCHES`（10 条） |
| 代码补丁 | `lib/patches/code-patches.mjs` | 42 | `CODE_PATCHES`（3 条） |
| 引擎补丁 | `lib/patches/engine-patches.mjs` | 295 | `ENGINE_PATCHES`（8 条） |
| 新工具补丁 | `lib/patches/new-tool-patches.mjs` | 3111 | `NEW_TOOL_PATCHES`（65 条） |
| 组装 | `lib/patches/index.mjs` | 8 | 按原顺序拼 `ALL_PATCHES`（86 条） |

改补丁只动 `lib/patches/` 里的数组文件；`core.js` 只保留 `import { ALL_PATCHES } from './patches/index.mjs'` 一行再原样导出。

**顺序不可重排**：`PATCHES → CODE_PATCHES → ENGINE_PATCHES → NEW_TOOL_PATCHES` 的拼接顺序就是 apply 顺序，`{id:76}` 必须先于 `{id:70}`；`npm run check:metadata` 与 `scripts/test-patch-registry.mjs` 都会盯住。

补丁内容有回归保护：`scripts/test-patch-registry.mjs` 把 `ALL_PATCHES` 与 `docs/origin/core-split-baseline-8066985/`（拆分前快照）做对象级对拍（含正则 flags、函数 replace、239 个 replacement），再用真实 `applyReplacementsToText` 跑 690 组输入。改错一个字面量这里会立刻失败。

## CI 与发布

`.github/workflows/ci.yml` 在 `main` 推送、pull request 和手动触发时运行 `npm run check`。CI 使用 Node.js 24，不需要 `npm install`。

CI 里**不跑** `host:status` 与 `host-contract`：runner 上没有宿主安装，只会得到「全 no-file」的假绿。这两条是本机命令。

`.github/workflows/release.yml` 在发布前运行相同的 `npm run check`，但**不再由 push 触发**：本副本不发 GitHub Release（仓库私有、包标 `private`、分发只走本机 `npm pack` 产物），保留 `workflow_dispatch` 手动入口以便临时出包。仓库条件写成 `xiuchuan666/dsh-purge-maintained`，并有一条测试（`scripts/test-upstream-refs.mjs`）盯着它不要退回上游仓库名。

包本身已标 `"private": true`，`npm publish` 会直接拒绝。对外发布渠道只有本地 `npm pack` 产物（`$DSH_HOME/plugins/*.tgz`）。

## 更新链路（已固定为离线）

维护仓库是私有的，GitHub 的 `codeload` / `api` / `raw` / `jsdelivr` 对匿名请求全部 404。因此：

- `lib/update.js` 里 `ONLINE_UPDATES_ENABLED = false`，`checkUpdate()` 与 `applyUpdate()` 直接返回明确错误，不把 404 吞成「已是最新」。
- 启动路径恒不自动升级（`autoUpdateIfNeeded()` 返回 `skipped: "manual-only"`）。
- 本机升级只走「改版本号 → `npm run check` → `npm pack` → 换 tgz → 重装 profile」这一条路，步骤见 [README](README.md) 的「更新策略」。
- 不要为了「让面板更新能用」而把仓库改公开或往代码里塞 token：前者泄露全部维护内容，后者把长期凭据写进插件。

## 回退

普通修改以小提交落在 `main`。发现问题时用 `git revert <commit>` 保留可追踪的回退记录；不要用历史覆盖作为日常回退手段。基线首个提交为 `fa8d09dec92cf582412c28566273147076e79f24`。

详细设计与本阶段边界见 [测试地图](docs/test-map.md)、[统一验证与 CI 设计](docs/maintenance-verification.md)、[宿主适配基线设计](docs/maintenance-host-baseline.md)、[前端产物链设计](docs/maintenance-client-chain.md) 与 [补丁注册表拆分设计](docs/maintenance-core-split.md)，以及[测试机制设计](docs/superpowers/specs/2026-11-11-test-mechanism-design.md)。
