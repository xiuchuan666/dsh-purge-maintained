# 测试地图：哪个能力坏了，该看哪一行

这份表回答一个问题：**改坏了东西或宿主升级后，我从哪条红字知道是哪个能力坏了。**

规则很简单：

- 新增能力必须补一行，否则它没有守卫，坏了只能靠用户发现。
- 标 `❗缺` 的行就是下一步该补测试的待办池，从上往下取最贵的那个先做。
- 这份文件不参与 CI 判定，它是给人看的索引。CI 看的是 `npm run check`。

三列含义：

- **能力**：用户或维护者能感知到的一件事，不是函数名。
- **守卫**：跑哪个测试会红。`—` 表示目前没有任何测试会红。
- **覆盖率**：`npm run test:full` 实测，`行/分支` 百分比，落在具体文件上。

---

## 一、宿主契约与升级

| 能力 | 守卫 | 覆盖率 |
| --- | --- | --- |
| 86 条补丁能打在当前宿主上（文本替换成功） | `npm run host:status` → `docs/host-baseline.json` | — |
| 我们调的宿主 API 还在（`ctx.webServer` 等 8 个服务、9 个成员、7 个事件、`dshHomePath`） | `scripts/host-contract.mjs` / `test-host-contract.mjs` | — |
| 宿主版本兼容判定（major.minor.patch.pre 全等） | `lib/core.js` `hostCompat`，被 `host:status` 间接覆盖 | `lib/core.js` 28% |
| 探测真宿主树、排除 Electron 外壳依赖树 | `test-host-baseline.mjs`（`looksLikeHostTree` / `resolveAiBase`） | —（同上） |
| `.dshpurge.bak` 是官方原文、不是我们的补丁 | `test-host-contract.mjs`（`readHostSource` 优先读 bak） | — |
| 契约缺项时 `host:status` 的 verdict 必须是 `broken` | `test-host-contract.mjs`（`mergeVerdicts` 六种组合） | — |
| 「要不要重打补丁」的判据：戳、版本、rev 三者对齐，空 sha 不算对齐，占位戳只认版本 | `test-reapply-settle.mjs`（9 条） | `lib/reapply.js` 70% |
| 空 sha 的旧戳什么时候允许就地补成非空（密封包不补、缺标记不补） | `test-reapply-settle.mjs`（3 条） | 同上 |
| `installed-rev` 的三个来源与占位戳刷新（显式值 > 已有 rev > 戳里的 sha > `apply:<version>`） | `test-reapply-settle.mjs`（7 条） | 同上 |
| settle 重启冷却：刚标记过就跳过、版本变了不冷却、时间戳坏掉按不冷却处理 | `test-reapply-settle.mjs`（3 条） | 同上 |
| 「补丁丢失」的判定：有戳但宿主标记没了才算，空 sha 的戳不算应用过，找不到宿主不误报 | `test-reapply-settle.mjs`（4 条） | 同上 |
| `hostCleanEnoughToKeep` / `patchesMatchInstall(Strict)`：快路径与逐补丁 pending 实检的组合 | `test-reapply-settle.mjs`（5 条） | 同上 |
| `reapplyInstalled` 的主流程：先定位宿主 → 密封则换包 → 回滚旧补丁 → 重打 86 条 → 打 shim → 静默命令窗，`clean` 必须同时满足「无 failed」与「全宿主已写或清洗标记在」 | `test-reapply-flows.mjs`（39 条） | `lib/reapply.js` 70% |
| 失败时不许留半成品：`freshExtract` 且 `clean` 不成立要 `restoreSealedExtract` 放回旧目录；`reapplied.ok` 不为真时不写戳、不写历史（下次启动仍能发现未完成） | 同上 | 同上 |
| 启动前回收钩子挂到宿主 `bin.js`：import 行必须在 shebang 之后、只挂一次、旧格式行被清掉、sidecar 与 import 指向同一个文件名 | `test-bin-preflight.mjs`（10 条） | `lib/bin-preflight.js` 100% |
| 钩子的还原：逐字节回到原样、sidecar 一起删、重复还原幂等、读不到 `bin.js` 时如实报 `reverted_partial` | `test-bin-preflight.mjs`（6 条） | 同上 |
| 不许改的宿主树：源码 monorepo 的 `apps/cli`（`skipped_source_cli`）与 asar 密封根一律不写 | `test-bin-preflight.mjs`（3 条） | 同上 |
| 归档还在时宿主文件必须走真实磁盘 fs：探针缓存 5 秒 TTL、写操作立刻失效、fd 方法不拿数字当路径探 | `test-extract-asar.mjs`（12 条） | `lib/extract-asar.js` 100% |
| 解开 app.asar：header 结构校验、`../` 穿越与 symlink 越界一律跳过并告警、0 字节文件也要建出来 | `test-extract-asar.mjs`（9 条） | 同上 |
| 换包的两步提交与回滚：旧目录挪成 `.dshpurge-prev`、换不上就放回、两步都失败写 `recover.json` 记 `prevRestored:false` | `test-extract-asar.mjs`（7 条） | 同上 |
| 桌面端升级标记：只认四个官方可执行名、marker 落在 `<exe 目录>/resources/dsh-purge-reapply-asar`、清除幂等 | `test-official-update.mjs`（15 条） | `lib/official-update.js` 100% |
| 清理旧解包目录：**`resources/app` 不存在时一个 `app.dshpurge-prev*` 都不删**（那是唯一救命副本）、junction 绝不碰、先摘 `runtime` 再删整树 | 同上 | 同上 |
| WSH 字面量转义：纯 ASCII 原样、非 ASCII 一律 `\uXXXX`（`isWshAscii` 必须为真，否则 .js 文件按 ANSI 读会乱码） | 同上 | 同上 |
| 宿主 `bin.js` 注入 hide-console 的 import：sidecar 与 facade 先落盘、再改 bin.js，重复注入只返回 `already_injected` | `test-hide-console.mjs`（13 条） | `lib/hide-console.js` 96% |
| 还原：双引号 import 行全清（`/gm`）、源码树的 bin.js 一个字节都不碰、bin.js 读失败时宁可多留一轮 sidecar 也不改它 | `test-hide-console.mjs`（6 条） | 同上 |
| 六个入口的 `windowsHide` 补位：`spawn`/`fork` 的 args-即-options 重载、`execFile` 四种参数形态、非对象 options 原样透传 | `test-hide-console.mjs`（5 条） | 同上 |
| 配置文件原地改写要换 inode：写临时文件 + fsync + rename，失败时原文件与目录都不留垃圾 | `test-small-helpers.mjs`（6 条） | `lib/redteam/atomic-write.js` 100% |
| 宿主 phase-1 白名单要放宽到 `dsh-purge*` 与 `dshpg-*`（漏一个就有注入段在最后一步被丢） | `test-small-helpers.mjs`（6 条） | `lib/phase1-keep.js` 100% |
| 加密槽的封与解：mask 16 字节 / IV 12 字节 / tag 16 字节、每次新随机、TAG 被篡改必抛、解不开返回空串 | `test-small-helpers.mjs`（9 条） | `lib/table-key.js` 100% / `lib/table-read.js` 89% |
| 桌面端不许自愈重启、密封包不许就地重打、点「应用」后该不该重启 | `test-small-helpers.mjs`（10 条） | `lib/settle-policy.js` 100% |

**为什么这一组重要**：补丁是文本替换，宿主把 `ctx.webServer` 改名成 `ctx.httpServer` 时，不含 `webServer` 字样的补丁照样能打上去、`host:status` 照样报 `ok`，但插件运行时崩。所以要有第二层（契约）。

---

## 二、补丁注册表（86 条）

| 能力 | 守卫 | 覆盖率 |
| --- | --- | --- |
| 拆分后 86 条补丁与拆分前逐字节等价（含正则 flags、函数 replace） | `test-patch-registry.mjs` | `lib/patches/*` 六个文件 **100%** |
| 应用顺序不可重排（`#76` 必须早于 `#70`） | `test-patch-registry.mjs` | 同上 |
| 239 个 replacement 在真实引擎上跑出相同结果（690 组 LF/CRLF/YAML 对拍） | `test-patch-registry.mjs` | 同上 |
| 补丁 id 唯一、非空、是整数 | `check-metadata.mjs` / `test-verification.mjs` | — |
| 状态汇总优先级（`pending` > `unmatched` > `drifted` > 全 skip > `applied`） | `test-display-targets.mjs`（6 条，含「漂移压过已完成」「全跳过不报 applied」「未知状态退化 skipped」） | `lib/core.js` 28% |
| 显示分组（九个组、组内 lead 取最小 id、无组补丁自成一行、只适配桌面的补丁不进 web 面、`na` 与缺状态不进行） | `test-display-targets.mjs`（7 条，含「分组 id 必须真实存在且不跨组」） | `lib/core.js` 28% |
| 面板计数（`tallyDisplayPatches`：跳过同时进 skipped 与 ready、漂移不算就绪、`status`/`st` 双字段名） | `test-display-targets.mjs`（4 条） | `lib/core.js` 28% |
| 补丁对宿主文件的落点（`targetFiles`）：只登记真实存在的文件、落空键整个删掉、嵌套布局四个 `-nested` 键、`dshHome` 下用户预设与演练台依赖、不跨宿主面收 profile、不登记用户自己的 `cordis.patch.yml` 层 | `test-display-targets.mjs`（9 条，假 aiBase 树 + 临时 dshHome） | `lib/core.js` 28% / `lib/surface.js` 94% |

---

## 三、提示词注入

| 能力 | 守卫 | 覆盖率 |
| --- | --- | --- |
| 注入决策树（strict / fallback / always 三种工作区策略） | `test-prompt-inject.mjs`（`decideInject` 6 条：strict 无注入也剥 / fallback 有注入才剥 / always 保留 / 停用一律不剥 / 未知策略按 always） | `lib/identity.js` 99% |
| `prompt-inject.md` 非空时优先于工作区 md | `test-prompt-inject.mjs`（5 条：优先级 / cwd 回落 / 纯空白视为空 / 都不拼接 / 都空给空串） | `lib/identity.js` 99% |
| 两种都没有时回落到插件内的加密 slot 默认 | `test-prompt-inject.mjs`（`inject === ""` + `source === "none"`，下游 `rewritePromptAssembly` 的回落另有 3 条） | `lib/identity.js` 99% |
| 装配结果段序（注入在最前、capabilities 其次、persona 收尾、anchor 最后） | `test-prompt-inject.mjs`（8 条，含不原地改写传入对象、`null`/`{}` 原样返回） | `lib/identity.js` 99% |
| `stripChatmlTags` 只剥三种形态（完整 `im_start system:`、`project_instructions`、`im_end`） | `test-prompt-inject.mjs`（含一条现状锁定：裸 `<\|im_start\|>` 不剥） | `lib/identity.js` 99% |
| `anchorMode` 只有 `auto` 与 `off`（不是 strict/fallback/always） | `test-plugin-surface.mjs`（现状锁定：`"bogus"` 原样透传）+ `test-anchor.mjs`（开关只认严格 `false` 与 `"off"`） | `lib/anchor.js` 100% |
| 尾部锚点的顺序夹在宿主 WEB_SURFACE(10100) 与 `lib/identity.js` 的 DEPLOYMENT_PERSONA_SUFFIX(10200) 之间；子锚点排在 delegation(120) 之后 | `test-anchor.mjs`（4 条，含一条读 `lib/identity.js` 源码核对 10200 仍然更大） | `lib/anchor.js` 100% |
| 锚点正文每轮重新求值（写成常量字符串就只出现一次、之后被历史埋掉） | `test-anchor.mjs`（3 条：section/context 的 text 是函数、改配置当场生效） | 同上 |
| 子会话判定（origin=subagent / delegationDepth>0 / 有 parentSession，也认顶层 session，属性抛错不冒泡） | `test-anchor.mjs`（6 条） | 同上 |
| 两个注册各自独立 try（context 撞名抛错不能把 section 一起带走）、宿主去重、disposer 逐条 try | `test-anchor.mjs`（6 条） | 同上 |
| 规则正文与元数据的存取（256KB 上限、id 合法性、非 .md 忽略、名字 64 字符截断） | `test-rules-store.mjs`（11 条） | `lib/rules.js` 94% |
| 激活规则时把原内容备份成 `.dsh-purge-rule.bak`（内容已是规则正文时不备份、已有备份不覆盖、目标不存在不抛） | `test-rules-store.mjs`（5 条，其中一条钉住「备份里绝不能是规则正文」） | `lib/rules.js` 94% |
| 恢复出厂三分支（有备份→写回并删备份 / 无备份且内容等于规则→删文件 / 用户改过→保留计入 skipped） | `test-rules-store.mjs`（4 条） | `lib/rules.js` 94% |
| 保存当前激活的规则会立刻同步到目标文件；保存未激活的规则不碰目标文件 | `test-rules-store.mjs`（2 条） | `lib/rules.js` 94% |
| 激活标记指向已删规则时由 `ensureInitialState` 清掉 | `test-rules-store.mjs`（1 条） | `lib/rules.js` 94% |
| cwd 候选文件的向上扫描（`.git`/`.hg`/`.svn` 停住、cwd/ancestor/root 三层、预览 160 字符、目录同名不算文件） | `test-rules-store.mjs`（4 条） | `lib/rules.js` 94% |
| 工作区策略与 cwd 勾选的持久化（含跨目录穿越防护） | `test-prompt-inject.mjs`（8 条：默认 fallback / 非法值拒绝 / 损坏文件回落 / 跨目录不注入 / `cwd-rule` 头 / lastCwd 空值不覆盖） | `lib/rules.js` 94% |
| `rewriteLiveAssembly` 的缓存签名（11 段） | `test-live-cache.mjs`（13 条签名覆盖面 + 命中规则 + 5 条生产接线） | `lib/live-cache.js` 100% |
| 缓存命中规则（同对象换签名必须落空、非对象不缓存、空对象算有效结果） | `test-live-cache.mjs`（命中/落空/覆盖写入/原始值/非对象结果 共 8 条） | `lib/live-cache.js` 100% |
| 会话签名 `sessionKeyOf`（id → sessionId → 空，cwd 参与，属性抛异常不冒泡） | `test-live-cache.mjs`（5 条） | `lib/live-cache.js` 100% |
| 装配主链路 `rewritePromptAssembly`（段序、置顶注入、persona 折入、红队卡/角色稿、锚点、cwd 清洗、不原地改写） | `test-identity-assembly.mjs`（141 条，含输入对象不被改、`null`/`{}` 原样返回、`contexts` 通道两种形态） | `lib/identity.js` 99% |
| 官方身份覆盖 `overlayOfficialIdentity`（`harness:identity` 整段丢、官方 persona 清空、suffix 换成我们的工作目录句、没有 suffix 就补一段） | `test-identity-assembly.mjs`（同一批 141 条里的第四节与第十三节） | 同上 |
| 身份指纹清洗 `stripHarnessPersona`（DeepSeek 自我指认、旧身份锁、拒答/权限话术改写、连续空格压平） | `test-identity-assembly.mjs`（含一条现状锁定：带空格的「我是 DeepSeek 的 AI 助手」不在指纹里，原样保留） | 同上 |
| 红队操作稿 `redteamProcedure` / `redteamOpsBody`（`## 运行环境前提` 起截、旧标题换硬约束、旧前导说明换新版、无正文补 note） | `test-identity-assembly.mjs`（第五节） | 同上 |
| 预设识别与继承（`isRedteamPresetId` 否定词、`sessionAgentPreset` 六层来源、`isRedteamSession`、`sessionForInject` 沿父链走到主会话） | `test-identity-assembly.mjs`（第六、七节） | 同上 |
| 极简预设改写（`adaptInjectForMinimalPreset` / `stripStrictToolBlock` 摘 STRICT 块、没有「# 全局作业」时从下一条装饰线截断） | `test-identity-assembly.mjs`（第八节） | 同上 |
| `assemble` 守卫 `installAssembleGuard` / `clearAssembleGuard`（五条异常兜底：描述符读不到、读 assemble 抛、已挂 slot、宿主已包过一层、defineProperty 挂不上；dispose 必须是 noop） | `test-identity-assembly.mjs`（第十节 11 条 + 第十三节的 accessor 断言） | 同上 |
| cwd 占位符三态（`interpolate:false` 换字面 / 有 `variables.cwd` 保留 `{{cwd}}` / 都没有换 `the current workspace`） | `test-identity-assembly.mjs`（第三节） | 同上 |
| 注入指纹抠除（`injectNeedles` 的 OWN SERVERS 前缀、`injectMatchers` 超 4096 字符按空行切段、`leadWithInject` 精确+宽松两路抠掉旧副本） | `test-identity-assembly.mjs`（第五节 + 第十三节的单行 5000 字符注入） | 同上 |

**本轮的进展**：注入决策树原来埋在 `rewriteLiveAssembly` 里，只有真正跑起宿主才走得到，改错了没有任何红字。现已抽成 `lib/identity.js` 的 `decideInject`（纯函数，逐行比对过抽取前后行为一致），由 `test-prompt-inject.mjs` 的 31 条用例钉住；缓存签名与命中规则抽成 `lib/live-cache.js`（`liveCacheSignature` / `sessionKeyOf` / `createLiveCache`），由 `test-live-cache.mjs` 的 37 条用例钉住，且拆分前后 2304 组输入的签名逐字对拍一致（`.tmp-exp/sig-parity.mjs`，一次性）。规则集读写（含备份与恢复的三条分支）已由 `test-rules-store.mjs` 的 30 条用例钉住——这组最怕的是「用户手写的 AGENTS.md 被另一条规则的内容悄悄盖掉」，因此备份/恢复的每个分支都单独立了用例。 这一轮补的是 `lib/identity.js`：它原来只有 69% 行覆盖，`installAssembleGuard` 整块（`lib/identity.js:904-1018`）与身份覆盖、红队操作稿、预设继承全都没有守卫，改坏了的表现是「注入没生效但也不报错」。现由 `test-identity-assembly.mjs` 的 141 条用例钉住，行覆盖 69% → 99%（`375-376` 的正则永不抛、`withOwnServers` 的两条因 `lib/net-scope.js` 的 `ownServerNote()` 恒空而不可达、`decideInject` 由 `test-prompt-inject.mjs` 覆盖、`rewritePromptAssembly:1090-1099` 的兜底块在常规输入下不可达）。 这一轮另外两件事：一是把 `lib/redteam/store-core.js` 从 5429 行拆到 3832 行，计分三件套搬进 `lib/redteam/score-report.js`、元数据与阶段口径搬进 `lib/redteam/engagement-meta.js`，类里只留四个一行转发（详见第十节盲区 33 与 `MAINTENANCE.md` 的「巨型文件拆分」）；二是给行尾约定加了常驻守卫 `npm run check:eol` —— 起因是 `lib/redteam/score-report.js` 入库时被 git 的 `autocrlf` 压成 LF 而工作区是 CRLF，本地与 CI 都全绿、仓库里存的却是另一份字节。现在 `.gitattributes` 用 `* -text` 关掉全部转换，`scripts/check-eol.mjs` 查「文件内不许混行尾 / 已入库不许变 / 新文件符合同目录多数派」三件事，外加一条「索引 blob 与工作区只差行尾」的 autocrlf 指纹检测（这条第一版写错了、检测静默失效，靠负向验证才抓出来，见盲区 34）。

---

## 四、插件面（宿主直接读取）

| 能力 | 守卫 | 覆盖率 |
| --- | --- | --- |
| `name` / `inject` 能装配（写错 `pluginPackages` → 宿主退出码 1） | `test-plugin-surface.mjs` | `lib/index.js` 8% |
| 7 个 export 名字不能多不能少 | `test-plugin-surface.mjs` | 同上 |
| `normalizeConfig()` 返回 18 键，且默认值逐项锁定 | `test-plugin-surface.mjs` | 同上 |
| 12 个布尔键收敛 `"false"/"0"/"no"/"off"` | `test-plugin-surface.mjs` | 同上 |
| 4 条聊天命令（`purge` / `rules` / `skills` / `rewind`）注册成功、备用名退让、全撞名不抛 | `test-command-surface.mjs` | `lib/commands.js` 100% |
| 4 条命令各自的入参契约（`purge` 透 rawInput+config+ctx；`rewind` 子代理直接回退、主代理只提示） | `test-command-surface.mjs` | 同上 |
| `/rewind` 切在哪一刀：once 撤最后一步（第一个 step 退到本轮起点）、round 撤整轮（按 `turn/end` 反查本轮起点）、第一行只能新建空白会话、`mode` 只认字面量 `round` | `test-rewind.mjs`（9 条） | `lib/rewind.js` 90% |
| `/rewind` 认哪句话：插件草稿（`[MNEMON]` / `MNEMON RUNTIME MEMORY SNAPSHOT` / `MNEMON VIEW TOOLS`）与 `source.kind` 非 user 一律跳过；`goal` 各轮算「发出去的那句」；多段 block 只拼 text | `test-rewind.mjs`（5 条） | 同上 |
| `/rewind` 的落地四条路：fork + 归档源会话、新建空白会话、round 连带取消并归档本轮子会话、宿主无 rewind API 时明确报错 | `test-rewind.mjs`（5 条） | 同上 |
| `/rewind` 的边界：seq 不连续时官方 fork 边界算不出来（报 Nothing to undo 而不是切错位置）、fork 抛错/返回空值/返回字符串 id、轮次还在跑时先 cancel 再等关闭、同会话并发两次被串行化 | `test-rewind.mjs`（7 条） | 同上 |
| `/rewind` 的草稿：回退后 `getDraft` / `getPending` 都指同一条，`takeDraft` 只能取一次（取走后再取为 null，防重复发送） | `test-rewind.mjs`（2 条） | 同上 |
| `/rewind` 读会话日志的三条路径（live `snapshotEvents` → `controller.inspect` → `sessionQuery.observeSession`），最后一条必须 `[Symbol.dispose]` | `test-rewind.mjs`（4 条） | 同上 |
| `/rewind` 的收件箱与子会话：只收最后一次 `turn/end` 之后的 `next-turn` 插入、去重保序；本轮子会话按 catalog/descriptor 去重保序 | `test-rewind.mjs`（5 条） | 同上 |
| 3 个模型工具（`purge_status` / `purge_apply` / `purge_revert`）的名字、空 parameters、output schema | `test-command-surface.mjs` | `lib/tools.js` 100% |
| 三个工具的执行分支（无宿主直接报错、需确认时停手、applied/already/scrub 统计、回滚同时收 shim） | `test-command-surface.mjs` | 同上 |
| 工具目录与配置落盘：`TOOL_CATALOG` 15 条（`names` 与 `adapt` 两份清单互校）、`save` 的增量合并（`platform` 非法保留旧值、`binDirs` 非数组保留旧值、布尔开关只在 `!== undefined` 时改）、落盘 JSON 补齐全键并 trim | `test-platform-config.mjs`（12 条） | `lib/redteam/platform-config.js` 98% |
| 找工具的六条路：配置的绝对/相对路径（不存在时 `source:'missing'` + `note`）、`toolkitDir`、`binDirs`、`PATH`（`PATH` 与 `Path` 都认）、Linux 回退目录、`bin`/`Bins`/`tools`/`Tools` 四个子目录 | `test-platform-config.mjs`（13 条） | 同上 |
| 扫目录认工具：深度夹在 1–6（`maxDepth:0` 是 falsy → 走默认 4，现状锁定）、文件数夹在 100–20000、跳过点开头/`node_modules`/`.git`、同名多份按 `names` 排名先高后低、顺手认 `nuclei-templates` 目录 | `test-platform-config.mjs`（7 条） | 同上 |
| 环境适配状态：`kali` → `skipped` → 已存路径（`toolkitDir` 或 `binDirs` 或任一 `tools[id]`）→ `found >= 2` → `need-config` 的优先级，以及 `assignToolkitFolder` 把新目录 `unshift` 到最前 | `test-platform-config.mjs`（10 条） | 同上 |
| 宿主面分派：`hostAdapter` 按面挑适配器（桌面端拿到含 `ASAR_SWAP_PS1` 的那份，web/gui/tui 拿同一份），`adapterFor` 只吐 `web`/`desktop` 两个值 | `test-host-restart.mjs`（4 条） | `lib/host.js` 86% |
| 重启参数怎么算：有 bin.js 时改写成 `[binJs, ...rest]` 并补 `web --port`、`.cmd`/`.bat` 换成 node_modules 里的 bin.js、永远补 `--no-open` 且不重复 | `test-host-restart.mjs`（9 条） | `lib/web.js` 53% |
| 子代理审批接管：两个钩子都必须 `global`（`approval/request` 还要 `prepend`）、只在子会话把 `never` 改回 `ask` 且每会话最多 4 次、子会话审批一律 `allowed-once`、释放时摘钩子 | `test-host-restart.mjs`（13 条） | `lib/subagent-control.js` 100% |
| 自动续跑与自动重试的判据：哪一类结束原因算异常（error / aborted / interrupted / max-tokens）、用户取消不续跑、永久码（鉴权/配额/上下文超限/缺凭据）与 `TRANSPORT`/`RATE_LIMIT` 不续跑、`signal.aborted` 不重试 | `test-continue-retry.mjs`（10 条） | `lib/continue-retry.js` 97% |
| 续跑预算与失败连击：每会话 retry/continue 各自计数、同一失败点/同一轮结束点不重复消耗、连续失败 3 次永久停手（#85）、正常结束或 blocked 才清零、会话数超 200 淘汰最早 50 个 | `test-continue-retry.mjs`（10 条） | 同上 |
| 什么时候不许替用户说话：默认 `autoContinue=false`、agent 还在跑、收件箱有货、`turn/end` 之后已有真人消息、`dispose` 之后排着的定时器一律不发 | `test-continue-retry.mjs`（8 条） | 同上 |
| 配置合并：`retryMax` 归零连带关掉 `autoRetry`、`autoContinue` 只认布尔 `true` 且 `continueMax>0`、保存的设置不能偷偷打开 `autoContinue`、`continueText` 去空白并回落「继续」 | `test-continue-retry.mjs`（8 条） | 同上 |
| 跨站准入：`Origin` / `Sec-Fetch-Site` / `Host` 三元组判定（DNS rebinding、sandbox iframe、同机异端口） | `test-http-guards.mjs` | `lib/http.js` 100% |
| 方法白名单：405 + `Allow` 头 | `test-http-guards.mjs` | 同上 |
| JSON 响应头统一（`no-store`，500 也不漏） | `test-http-guards.mjs` | 同上 |
| 请求体上限按累计字节算，超限即抛，非法上限回落 512KB | `test-http-guards.mjs` | 同上 |
| `rules` 的 9 个 op（status / scan / toggle-cwd / set-policy / read / save / activate / delete / reset）参数校验与副作用 | `test-http-routes.mjs` | `lib/http-routes.js` 99% |
| `skills` 的 5 个 op（status / read / save / delete / import）参数校验与 `import` 的服务端路径拒绝 | `test-http-routes.mjs` | 同上 |
| `rules` / `skills` 两个分发器的 op 优先级（forcedOp > body.op > 尾段 > `?op=` > `?id=` 推断 > status）与 OPTIONS/405 | `test-http-routes.mjs` | 同上 |
| `skills` 的 14MB 请求体上限（区别于默认 512KB） | `test-http-routes.mjs` | 同上 |
| `registerRoute` 给 handler 套跨站守卫，注册失败只 warn 不炸 | `test-http-routes.mjs` | 同上 |
| 技能库的读写面：`validSkillName` 的 13 种输入、五个路径函数、`displayUnderHome` 把越界路径压成 `$DSH_HOME`、`toPublicSkill` 只转 `path`/`backup` 且不改原对象、`formatSize` 四档 | `test-skills.mjs`（5 条） | `lib/skills.js` 91% |
| frontmatter 解析：`splitFrontmatter` 的 BOM / CRLF / 结尾无换行 / 非 frontmatter 六种、`parseSkillDocument` 五种报错文案、两个开关 6 种真值与 2 种非法、双引号走 `JSON.parse` 真解开转义、开关后跟行内注释、块标量 `\|2` 缩进指示与 chomp 三态 | `test-skills.mjs`（8 条） | 同上 |
| 渲染与合并：标准 frontmatter 模板、含空格的描述加引号、描述截 500、剥 BOM、`mergeSkillDocument` 保留其它字段且 `name`/`description` 各只一行 | `test-skills.mjs`（6 条） | 同上 |
| 读与列：bundle 优先 flat、按目录名查直接命中（不校验 frontmatter 的 name，现状锁定）、找不到回 null 而非法名抛错、坏文档标 `valid:false`、`.system` 与根 `SKILL.md` 跳过、同 id 去重 bundle 赢、两个目录同名只收第一个、排序靠源码形状钉 | `test-skills.mjs`（9 条） | 同上 |
| 写与删：新建、覆盖 bundle/flat 各自先备份旧内容、拒非法名与 256KB、显式描述优先于 frontmatter、失败回滚、删除找不到抛错 | `test-skills.mjs`（7 条） | 同上 |
| 导入：目录按 frontmatter 名建目录、坏 frontmatter 用目录名兜底且不改写文档、无 frontmatter 补 render、单 `.md` 导入、拒从 `skills` 自己导入、拒软链到 `skills` 里（`realpath` 判重）、`importFileTree` 的 base64/utf8 与空/过多/越界/超大四类拒绝、`importArchive` 的空包/12MB/`..` 条目/超 200 条目/解包后 50MB 上限 | `test-skills.mjs`（12 条） | 同上 |
| 找根与状态：含 `SKILL.md` 的目录当根并停止下钻、最多 4 层、命中后不再往下找、`skillsStatus` 不带正文 | `test-skills.mjs`（5 条） | 同上 |
| 13 条 `exact` 路由的注册面（路径、顺序、标签唯一、都是 `exact`） | `test-exact-routes.mjs`（1 条） | `lib/routes.js` 93% |
| 只读路由的方法白名单与参数：`status` / `last-user` / `rewind/options` / `rewind` GET / `hooks-deny` GET | `test-exact-routes.mjs`（11 条） | `lib/routes.js` 93% |
| `/status` 的四种形态：进度期回上次载荷、未就绪 503、就绪全字段、`gatherState` 抛错 500 | `test-exact-routes.mjs`（4 条） | `lib/routes.js` 93% |
| `/apply` 的整条链：405、定位失败、无宿主、需提示词、成功时 10 步副作用顺序、`pattern_not_found` 仍可重启、`write_failed` 不重启 | `test-exact-routes.mjs`（8 条） | `lib/routes.js` 93% |
| `/revert` / `/uninstall` / `/drill-grant` / `/override` / `/own-servers` 的守卫与副作用 | `test-exact-routes.mjs`（14 条） | `lib/routes.js` 93% |
| `/restart` 的三道闸：清洗未完成、`clean:false`、密封包走 `restartSealedDesktopIfNeeded` | `test-exact-routes.mjs`（6 条） | `lib/routes.js` 93% |
| `/redteam/api` 桥的准入三道闸：只接受 POST（405）、跨站/同站拒（403）、非 JSON 拒（415） | `test-redteam-bridge.mjs`（7 条） | `lib/redteam/bridge.js` 100% |
| 桥的来源判定五种情形：cross-site / same-site 直拒、无 Origin 放行（curl）、`null` 只在本机放行、`app://` 只在本机放行、端口不同算跨源、非法 URL 拒 | `test-redteam-bridge.mjs`（7 条） | `lib/redteam/bridge.js` 100% |
| 桥的 op 路由顺序：平台 → 代理 → 更新 → 技能 → 兜底，每层认领即短路 | `test-redteam-bridge.mjs`（5 条） | `lib/redteam/bridge.js` 100% |
| 技能层的桌面端兜底：`skillCatalog`/`skillRead` 抛错时改读文件、兜底也失败要带原始错误、非技能 op 原样抛 | `test-redteam-bridge.mjs`（4 条） | `lib/redteam/bridge.js` 100% |

**本轮进展**：`rules` / `skills` 两个分发器原来埋在 `lib/index.js` 的 89 + 39 行里，只跑得到「路由注册成功」这一层。现已抽到 `lib/http-routes.js`（243 行，8 个 export），`refreshHungOperator` / `injectSnapshot` 改为依赖注入传入——因为它们依赖 index.js 模块内的读盘状态，硬搬会把整个 index.js 拖进测试。抽取前后做了一次归一化逐字对拍（`PARITY OK identical after normalization; chars 9368`），行为零变化。由 `test-http-routes.mjs` 的 52 条用例钉住，覆盖 99% 行 / 100% 分支。

---

## 五、前端产物链（client.js）

| 能力 | 守卫 | 覆盖率 |
| --- | --- | --- |
| `client.js` 锚点哈希与 `docs/origin/client-1.1.94.js` 一致 | `check-client.mjs` / `test-client-chain.mjs` | —（`scripts/` 不在覆盖率 include 范围） |
| 结构完整（`DRILL_BEGIN`/`END` 标记、dock 锚点） | `check-client.mjs` | 同上 |
| 改了 `lib/redteam/client.js` 忘记 `npm run build:client` 会被发现 | `check-client.mjs`（fragment drift） | 同上 |
| `client.js` 三层（上游成品 / dock 补丁 / 演练台片段）各自的作用 | `❗缺`（三层无法分别验证，只有整体哈希） | `client.js` 不在覆盖率范围 |

---

## 六、演练台（红队子系统）

| 能力 | 守卫 | 覆盖率 |
| --- | --- | --- |
| POC 库落盘与净化：`code` 当目录名先净化（`../../x` 落回 `pocs/` 之内）、`filename` 里的分隔符换成 `-`、五种默认文件名、slug 保留中文并把 CVE 归一 | `test-knowledge-store.mjs` | `lib/redteam/store-core.js` 88% |
| POC 正文来源三路：`content` 优先、`path` 拷进 `pocs/` 且源文件留在原地、越界路径被 `assertPathWithin` 挡住、两者都没有时只登记元数据 | `test-knowledge-store.mjs` | 同上 |
| POC 合并语义：同 `code` 再存一次是合并（不是插重复）、正文换新、`verified` / `verified_note` / `tags` 不被空值冲掉、创建时间不动 | `test-knowledge-store.mjs` | 同上 |
| POC 检索：四键排序（已验证 → 复用次数 → 更新时间 → id）、FTS 按词切命中不了时退化成 LIKE、多值归类、`limit` 夹在 1000 以内且负数等于不限 | `test-knowledge-store.mjs` | 同上 |
| POC 单条读写与删除：`getPoc` 认 id / code / 字符串 id、`updatePoc` 只在正文变了才重写文件、`deletePoc` 连落盘目录一起删并报删了几个文件 | `test-knowledge-store.mjs` | 同上 |
| POC 概览口径：14 条内置归类顺序固定且计数为 0 也列出、自定义归类追加在尾部、`total` / `verified` / `withContent` / `reused` 各自怎么数 | `test-knowledge-store.mjs` | 同上 |
| 六个 `redteam_poc_*` 工具的 `execute` 真的读得到 `args`：返回值取自入参（`code` 由标题算出）、`hit_count` 递增、查不到时给出「先检索」的指引 | `test-redteam-tools.mjs` | `lib/redteam/tools.js` 74% |
| nuclei 模板索引缓存（首次建、命中、7 天过期、损坏重建） | `test-store-templates.mjs` | 同上 |
| 计分口径三处一致：面板 / 报告 / 攻击链算出同一个总分（普通命中、同服务去重、自建账号、停用得分点、规则上限吃满、命中自带分值、G6 IPv6 ×3、G5 数据规模 ×2、混合 9 种场景） | `test-score-consistency.mjs` | `lib/redteam/store-core.js` 88% |
| `applyScoreCaps` 纯函数：四种 `dedup_scope` + 规则上限的边界（降序累计、`cap<=0` 不封、`self_created` 不占位、无元数据退化） | `test-score-consistency.mjs` | `lib/redteam/score-rules.js` 98% |
| 封顶文案（dedup / cap 两种措辞，含 `+50 分` 与 `+null` 边界） | `test-score-consistency.mjs` | 同上 |
| 目标归并 `targetKey`：URL 截到 scheme+host+port、非 URL 取首段、空值回落资产 IP | `test-redteam-crud.mjs` | `lib/redteam/store-core.js` 88% |
| 写库前的枚举规范化：马类型/马状态认中文别名与大小写、认不出就抛错（不是静默存原文） | `test-redteam-crud.mjs` | `lib/redteam/validate.js` 95% |
| 漏洞登记：非法 severity/status 静默回落、带 cve 与不带 cve 两种幂等键、`gained` 规范成一行、只在挂资产时写 observation | `test-redteam-crud.mjs` | `lib/redteam/store-core.js` 88% |
| 漏洞列表：六种筛选、严重度排序、`limit` 夹 1..1000、证据默认截 8000 字符、`evidenceLimit` 取全文 | `test-redteam-crud.mjs` | 同上 |
| 漏洞更新：缺行返回 `updated:false`、非法值保留旧值、`vulnStats` 按站点归并 | `test-redteam-crud.mjs` | 同上 |
| 凭据与访问会话：`host` 必填、明文四级别名优先级、冲突保留旧值但刷新 `found_at` | `test-redteam-crud.mjs` | 同上 |
| WebShell：`url` 必填、同 `url+pass_key` 幂等、update 与 add 走同一套规范化、缺行报错 | `test-redteam-crud.mjs` | 同上 |
| 隧道：`entry_kind` 是得分凭证（非法值抛错、`self-only` 标 `legit:false`、空值算待确认）、update 校验 status | `test-redteam-crud.mjs` | `lib/redteam/score-rules.js` 98% |
| 资产测试状态与评估：`test`/`notes` 两种写法都追加、`blocked` 累加到第 3 次给转向提示、非法 `priority` 保留原值 | `test-redteam-crud.mjs` | `lib/redteam/store-core.js` 88% |
| 会话总览：webshell 在线数、隧道 active 数、`self-only` 不算突破凭证、未声明 `entry_kind` 算待确认 | `test-redteam-report.mjs` | `lib/redteam/store-core.js` 88% |
| 攻击图谱：待确认漏洞不画成节点、有 access 才标 `meta.owned`、`summary` 与 `vulnStats` 是同一份口径 | `test-redteam-report.mjs` | 同上 |
| 报告导出：只收「已证实/已利用 + 中危以上」、`all:true` 全收且不写脚注、按严重级排序、四章节标题固定、复现请求去 CR、修复建议序号连续、脚注只写一次 | `test-redteam-report.mjs` | 同上 |
| bundle 导入：逐类计数、扫描记录字段完整、域名自动连资产、端口增量补 banner 且不插重复行、中途失败整体回滚不留孤儿 `scan_run` | `test-redteam-report.mjs` | 同上 |
| 连通性探测：真起 HTTP/TCP 服务验 online/active 并回写库、连不上标 offline/down 且留 `check_note`、空 `listen` 与坏端口如实报错 | `test-redteam-report.mjs` | 同上 |
| FTS5 缺席时的降级：两张虚拟表不建但普通表一张不少、资产六种检索面与 POC 三种检索面都还能命中 | `test-fts-fallback.mjs` | `lib/redteam/schema.js` 93% / `store-core.js` 76% |
| 降级与原生两种模式的差异边界：中间子串 LIKE 能搜到而 FTS 前缀匹配搜不到（现状锁定），其余检索面对齐 | `test-fts-fallback.mjs` | 同上 |
| 64 个 `redteam_*` 工具的参数面：宿主能编译成 JSON Schema、缺必填/类型错/枚举外被拒、数组与对象按元素判 | `test-redteam-tools.mjs` | `lib/redteam/tools.js` 74% |
| 靶标绑定解析：单靶标自动绑定、显式优先、多靶标未绑定报错、全局当前靶标被别的会话占用时挡住 | `test-redteam-tools.mjs` | 同上 |
| 并发闸门：上限读设置、占满拒绝、release 按最早一条释放、无会话上下文时如实说明 | `test-redteam-tools.mjs` | 同上 |
| 工具错误结构化：`ctx.redteam` 缺失回「资产库不可用」、桩库缺方法原文照抄、参数类错误归 `bad_input` | `test-redteam-tools.mjs` | 同上 |
| 红队子会话的角色稿：只认五个角色码且必须行首、多条消息以最后一条为准、`content` 优先于 `text`、非 text 块占空位 | `test-role-section.mjs` | `lib/redteam/role-section.js` 94% |
| 角色稿的落地路径：`current` 里的 id 必须无穿越且 `agents/` 存在、稿件 `trim`、只有红队预设不算子会话 | `test-role-section.mjs` | 同上 |
| 角色捕获钩子：`agent/inbox/claimed` 带 `global`+`prepend`、cordis 环境包在 `effect` 里以便解绑、重复调用只挂一次、坏 payload 不打断领消息 | `test-role-section.mjs` | 同上 |
| 资产面工具的 `execute` 业务分支：`asset_add` 回「刚写入的那一条」+ 发现时间不变、`asset_query` 的 limit 夹 200 而 `total` 不受影响、`asset_graph` 与 `attack_path` 各自的节点上限（1000 / 1500）与超限回分段清单、`asset_timeline` 按天聚合、`asset_link` 回边数、`asset_test` 的测试记录追加而不覆盖 | `test-redteam-tool-branches.mjs` | `lib/redteam/tools.js` 93% |
| 计分与攻击链工具的 `execute` 业务分支：`score_list` 的 `groups`（`items` 是档位数、`points` 是已得分，两者别搞反）、`score_hit` 的旧 code 迁移提示、`score_report` 的 `markdown:false` 精简分支、`attack_chain` 的非法 `stage_code` 回落 recon、`chain_add` 的 hints 三源 | `test-redteam-tool-branches.mjs` | 同上 |
| 会话/证据/报告/知识库工具的 `execute` 业务分支：`sessions` 的边界突破口径、`session_check` 的在线数与可用数、`web_list` 的 URL 协议与端口拼接、`http_evidence_add` 真落库、`evidence_*` 四件套、`unknown_*` 三件套、`report` 与 `report_targets`、`poc_add` 的来源靶标名称补全 | `test-redteam-tool-branches.mjs` | 同上 |
| 计分块的实现位置与转发：`scoreReport` / `scoreChain` / `#hitTrace` / `#representativeShots` 的实现在 `score-report.js`，类里只留一行转发；四个函数的函数体与拆分前逐行一致（152/1048/178/44 行 diff 0） | `test-score-consistency.mjs` / `test-redteam-report.mjs`（转发出错则三处总分不再相等） | `lib/redteam/score-report.js` 78% |
| 靶标元数据的落盘与阶段口径：`readMeta` / `writeMeta` 的容错、`SCOPE_SQL` 的内外网判定、`POINT_SHORT_NAME` / `scoreStageOf` / `LEGACY_STAGE_MAP` 的取值 | `test-schema-migrate.mjs`（末条）+ `test-score-consistency.mjs` | `lib/redteam/engagement-meta.js` 99% |
| 事实库迁移的两处回填真的生效：`asset.scope` 按 IP 归属判内外网（含 172.16–31 与 100.64–127 的边界）、`attack_step.stage_code` 按 `LEGACY_STAGE_MAP` 映射七个老阶段、已有值一律不覆盖、跑两遍结果全等 | `test-schema-migrate.mjs`（23 条） | `lib/redteam/schema.js` 98% |
| 知识库迁移：补出五个新列与两个索引、老条目按关键词推归类（具体压过泛化）、已有归类不被改写、`POC_CATEGORIES` 的 code 唯一且以 `other` 收尾 | `test-schema-migrate.mjs`（7 条） | 同上 |

---

## 七、桌面端（官方壳）

| 能力 | 守卫 | 覆盖率 |
| --- | --- | --- |
| `resources/runtime` 被清空后能原地补齐 | `test-runtime-heal.mjs` | `lib/desktop.js` 61% |
| 官方 CLI 启动器能从零生成 | `test-destructive-guards.mjs` | 同上 |
| `resources/app` 不存在时绝不删掉 `prev`（唯一完整副本） | `test-destructive-guards.mjs` | 同上 |
| 重启脚本 cmd/sh/ps1 三份模板 | `test-destructive-guards.mjs` | 同上 |
| 安装根名只按尾部一段判，祖先目录叫 DeepSeek Harness 不算（npm 前缀 / DSH_HOME 父目录） | `test-desktop-locate.mjs` | 同上 |
| exe 名字分类：社区桌面 / 官方宿主 / DSH NEXT / bot，以及「官方才解 asar」的差别 | `test-desktop-locate.mjs` | 同上 |
| 从 `resources/app`、`app.asar.unpacked`、`Contents/Resources` 反推安装根 | `test-desktop-locate.mjs` | 同上 |
| 从 execPath / resourcesPath / `host-process-entry` argv / 环境变量找安装根与 exe | `test-desktop-locate.mjs` | 同上 |
| aiBase 判定（要求 `dsh-agent-instructions/lib`）与「装了两个客户端只认当前 exe」 | `test-desktop-locate.mjs` | 同上 |
| 常见安装位置展开（LOCALAPPDATA / ProgramFiles / ProgramFiles(x86) / macOS / Linux） | `test-desktop-locate.mjs` | 同上 |
| 封存运行时目录（`host-commands/bin`、五个换过名的产品目录） | `test-desktop-locate.mjs` | 同上 |
| 换包脚本（`ASAR_SWAP_PS1`）的文本约束：先杀 Electron main 再杀整树、不用 `taskkill /IM`、挪不动时留 rename-pending 并拉起原版、重试有上限、CRLF 不混行尾 | `test-desktop-scripts.mjs` | `lib/desktop.js` 61% |
| 官方 CLI 三件套（sh/cmd/ps1）三级回退与退级层数、启动器名字注入、按平台分行的行尾；`patchOfficialCliCmdText` 改写与幂等 | `test-desktop-scripts.mjs` | 同上 |
| 重启路径决策：`planOfficialRestart` 的 45 秒窗口与 wscript/PowerShell 二选一、`desktopRestartChoice` 六条分支、`sealedSwapKind` | `test-desktop-scripts.mjs` | 同上 |
| 「空闲时改名」的排队语义：缺参早返回、30 分钟内算已排队且不动锁、陈旧锁不早返回 | `test-desktop-scripts.mjs` | 同上 |
| 注册表 / 快捷方式 / 进程三条来源的 powershell 脚本本身（只在 `discover: true` 时走到，要真 `powershell.exe`，fixture 造不出来） | `❗缺` | 同上 |

---

## 八、自更新与打包

| 能力 | 守卫 | 覆盖率 |
| --- | --- | --- |
| 并发上限的读写：`clampMaxAgents` 夹到 1..10、`null` 夹成 1（不是回落默认 3）、文件值盖环境变量、落盘两空格缩进且不冲掉其它键 | `test-redteam-settings.mjs`（11 条） | `lib/redteam/settings.js` 100% |
| 技能体检的路径展开：`$DSH_HOME` / `${DSH_HOME}` / `~/` 三种写法、候选 home 全遍历、Windows 上不认 `.sh` 与 `/.local/` | `test-skill-availability.mjs`（36 条） | `lib/redteam/skill-availability.js` 100% |
| 缺什么才算不可用：`process.env.X` 与 `${X:?}` 算必需、`os.environ.get` 不算；说明文件（`.md`/`.txt`/`.json`）与跨系统二进制不计入「路径缺失」 | 同上 | 同上 |
| 官方技能库的扫描：跳过 `.system` 与点开头、扁平 `.md` 不收 `SKILL.md`、同名去重且 redteam 优先 | 同上 | 同上 |
| `checkSkill` 的判定：正文在手但文件不在只记 `file-stale`（仍算 available）、正文与文件都读不到才 broken、VPS 占位符在 `REDTEAM_VPS_HOST` 已配时不算缺 | 同上 | 同上 |
| 在线更新保持关闭（不指回已删库的 `HunYiSage/dsh-purge`） | `test-update-source.mjs` | `lib/update.js` 55% |
| 出厂面里没有残留的上游地址与渠道（含成品 `client.js` 的欢迎页链接、演练台兜底仓库、Release 工作流） | `test-upstream-refs.mjs` | — |
| `package.json` 的 `files` / `dsh.install` / `private` 不回退 | `test-package-integrity.mjs` | — |
| `npm pack` 产物里不含 `.bak`、`default-prompt-inject.md` | `test-package-integrity.mjs` | — |
| 发版前 `release-notes.md` 首行版本号与 `package.json` 一致 | `check-metadata.mjs` | — |
| BOM 守卫（profile 清单带 BOM 会让桌面端起不来） | `test-bom-guard.mjs` | `lib/bom-guard.js` 86% |
| profile 的 `cordis.patch.yml` 按形态补齐（空文件 / `[]` / 块序列 / flow-seq 不动） | `test-self-update.mjs` | `lib/profile-insert.js` 93% |
| profile 的 `dsh.profile.bundles` 被补上且幂等 | `test-self-update.mjs` | 同上 |
| `pnpm-workspace.yaml` 的 `allowBuilds`：pnpm 11 删来源键、pnpm 12 保留、坏原文不写盘 | `test-self-update.mjs` | 同上 |
| postinstall 只碰真的装了本插件的 profile | `test-self-update.mjs` | 同上 |
| 卸载先还原再删：`revertAll` 出错就停手、不进入清理 | `test-self-update.mjs` | `lib/uninstall.js` 83% |
| 卸载只删安装树（`node_modules/dsh-purge`），npm link 的源码目录不动 | `test-self-update.mjs` | 同上 |
| 卸载摘干净四个依赖段 + 顶层与嵌套 `bundles`/`plugins` | `test-self-update.mjs` | 同上 |
| 预设默认值改回 `standard`：7 种写法（裸值 / 单双引号 / 命名空间前缀 / 大小写 / 无空格 / 块内缩进）都落盘，`standard`/`other`/无键不动 | `test-preset-default.mjs` | `lib/preset-default.js` 94% |
| profile 扫描只认 `cordis.patch.yml` 与 `cordis.yml`，跳过 `node_modules`；空文件不进报告、不重写 | `test-preset-default.mjs` | 同上 |
| live 侧（`settings.update`）认命名空间前缀 / 大小写 / 两侧空白，吞 Promise 拒绝，fallback 本身是本插件时不写 | `test-preset-default.mjs` | 同上 |
| live 侧 bag：`{value}` 包装能改、有 `set()` 的优先走 `set()`、裸字符串改不动（现状锁定）、读属性抛错不炸文件侧 | `test-preset-default.mjs` | 同上 |
| profile 只读（`chmod 0444`）或路径是目录（EISDIR）时跳过，能修的照修，整条不抛 | `test-preset-default.mjs` | 同上 |
| `removeStaleAgentPresetDir` 删遗留目录 / 已不存在回 false / 空 id 不删整个 `.agent-presets` | `test-preset-default.mjs` | 同上 |
| 热重载延迟清理：取消后**等过 800ms 窗口**仍不写盘；到点则改文件 + 清遗留目录；定时器 `unref` 过 | `test-preset-default.mjs` | 同上 |
| 8 条反向替换各自命中并逐字写回官方写法；已官方形态命中为空且一字不改；同一形态出现多次全部还原、`hits` 只记一次 id；跑第二遍幂等 | `test-hooks-deny.mjs`（13 条） | `lib/hooks-deny.js` 100% |
| 旁路痕迹三标记（sentinel / Stop 标记 / Submit 标记）任一出现即判脏 | `test-hooks-deny.mjs`（2 条） | 同上 |
| 还原官方文件的四路结局：读失败进 `misses` 且不影响后面的文件、写失败进 `misses` 但保留 `hitsByFile`、`saveText` 返回 false 不算 changed、认不出的形态绝不写盘 | `test-hooks-deny.mjs`（8 条） | 同上 |
| 面板状态标注：旁路开着（含 `undefined`/`{}`）一律不动、已 `applied` 不被覆写、`na`/`missing_file` 跳过、脏了立刻停手（只读一次盘）、只碰四条 id | `test-hooks-deny.mjs`（9 条） | 同上 |
| 设置读写：文件值赢过配置值、非布尔被忽略、坏 JSON/数组/`"false"` 三种回落、写盘两空格+结尾换行、patch 非布尔保留旧值、目录自建且不留 `.tmp` | `test-hooks-deny.mjs`（8 条） | 同上 |
| 原子写失败要往上抛且收走 `.tmp`（落点被目录占住 → rename EPERM） | `test-hooks-deny.mjs`（1 条） | 同上 |
| `selectPatches`：旁路开着照常、关掉四条一个不留且顺序不变、四条 id 与常量一致、只认数字 id | `test-hooks-deny.mjs`（4 条） | 同上 |
| 通道状态：坏 `channel.json` 回落 stable、beta pin 清空并回写 | `test-self-update.mjs` | `lib/update.js` 55% |
| 版本比较与筛选：`versionIsNewer`、`latestStableVersion`、`hideListedVersion` | `test-self-update.mjs` | 同上 |
| 更新 ref 白名单（`safeUpdateRef` 挡住路径穿越与命令拼接） | `test-self-update.mjs` | 同上 |
| 更新地址改写：`archiveZipUrl` / `archiveTarballUrl` 认 40 位 sha 走裸路径、`v?数字` 走 `refs/tags`、其余走 `refs/heads` 且 ref 要编码；`rewriteDownloadUrl` 只把 `github.com/.../archive/...` 改写到 `codeload`（源码形状钉，含 `{7,40}` 与 `decodeURIComponent`） | `test-update.mjs`（6 条） | `lib/update.js` 55% |
| 通道与历史落盘：无文件回 stable **且不写盘**、坏 pin（beta 名 / `beta` 分支）清掉**并回写**、`switchChannel apply:false` 的落盘是两空格缩进 + 结尾换行、`channelPublic` 未知通道回落 stable、`pushHistory` 上限 20 条且同 ref 去重、`writeStamp` 空值不写 | `test-update.mjs`（9 条） | 同上 |
| profile 扫描与钉版本：`findPurgeProfiles` 只认 `dependencies`/`devDependencies`（**不认 optional**）、`profilePluginDir` 判存在、`pinInstalledSpec` 只改三个依赖段里已存在的 `dsh-purge` 键、注释里留着「不手改 `pnpm-lock.yaml`」的原因与当年报错 | `test-update.mjs`（6 条） | 同上 |
| `checkUpdate` 的两条短路：beta 通道没有远端时回「还没有测试版」而不是抛错；stable 没有远端时抛 `UPDATES_DISABLED_MESSAGE`，且**抛错不覆盖** `lastUpdateResult()` | `test-update.mjs`（4 条） | 同上 |
| `checkUpdate` 的正常路径（历史里有一条更新的标签）：`hasUpdate` / `lanes.stable.version` / `updateTarget` / `remoteVersion` / `via` / 本地版本补的 `kind:"local"` 行，以及 `lanes.*.sha` 在在线更新关闭时**恒空**（现状锁定） | `test-update.mjs`（7 条） | 同上 |
| 分派与回绝：`switchChannel` 默认会真 apply（关闭时抛错且不改通道）、`switchVersion` 的「已下线 / 空 ref / 非法 ref / 未知 ref」四条与按 id、按 sha 前缀两种认出方式、`handleUpdateOp` 的 `auto`/`channel`/`switch`/`rollback` 分派与「该测试标签已不再提供」「未知版本」两种回绝 | `test-update.mjs`（12 条） | 同上 |
| 更新闸门：`applyUpdate()` 与 `applyUpdate([])` 都抛 `UPDATES_DISABLED_MESSAGE`，且都不改 `channel.json`、不创建 `version-history.json`；`applyUpdateInflight` 复用同一 Promise（源码形状） | `test-update.mjs`（3 条） | 同上 |
| `autoUpdateIfNeeded` 恒回 `{auto:true, skipped:"manual-only"}` 且不写 `channel.json` | `test-update.mjs`（2 条） | 同上 |
| 解压包条目校验：`..` / 盘符 / UNC / 前导斜杠 / 空段都被 `safeZipName` 归一或挡掉，反斜杠先归一成斜杠（`a\..\b.txt` 才看得出是穿越） | `test-zip-extract.mjs`（6 条） | `lib/zip-extract.js` 98% |
| zip 结构解析：中央目录顺序与签名、EOCD 后面跟 60000 字节注释仍能找到、zip64 占位值 / 未知压缩方法 / 正文截断 / 本地头签名四种拒绝 | `test-zip-extract.mjs`（9 条） | 同上 |
| 解包落点：`stored` 与 `deflate` 都解出原文、嵌套目录自动建、0 字节写空文件、反斜杠结尾算目录、已存在的目标不清空、单前导斜杠当相对路径（现状锁定，不逃出 dest） | `test-zip-extract.mjs`（7 条） | 同上 |
| 挑解包器：`node` 自己判 zip-slip 且失败后**停手不再往下试**；`tar`/`unzip`/`python3`/`powershell` 各自的 argv 与 powershell 的环境变量传参；条目预检不过时一个外部工具都不跑，报错里只有 `entries:` 一条 | `test-zip-extract.mjs`（9 条） | 同上 |
| 外部工具失败要带「命令名: 首行 stderr」进 notes，最终报错拼成 `Extraction failed: a \| b`；空 tools 列表报 `no extractor available` 且目标目录已建出 | `test-zip-extract.mjs`（3 条） | 同上 |
| 源码形状：`buf.length < 22`、`out !== root && !out.startsWith(prefix)`、盘符判断三道冗余守卫（外部行为等价，去掉不会红） | `test-zip-extract.mjs`（2 条） | 同上 |

---

## 九、测试机制自身

| 能力 | 守卫 | 覆盖率 |
| --- | --- | --- |
| 测试发现规则（`scripts/test-*.mjs`，忽略子目录） | `test-verification.mjs` | —（`scripts/` 不在覆盖率 include 范围） |
| 元数据校验规则（版本、发布说明、`dshTargets`、id 唯一） | `test-verification.mjs` | —（同上） |
| 覆盖率基线不跌破（棘轮；`lib/desktop.js` 登记了环境容差 `fnh ±2 / brh ±4`，容差内的下跌只提示不判红） | `npm run test:full` + `test-coverage-baseline.mjs` | —（同上） |
| 基线守卫的路径三处不错配 | `test-coverage-baseline.mjs` | —（同上） |
| 宿主契约扫描语义（.bak 优先、成员搬家提示） | `test-host-contract.mjs` | —（同上） |
| 补丁注册表拆分等价 | `test-patch-registry.mjs` | — |
| 行尾分类与目录多数派（混行尾、单行文件、平票、样本门槛） | `test-eol.mjs` | —（`scripts/` 不在覆盖率 include 范围） |
| 行尾审计三条规则（混行尾 / 已入库不许变 / 新文件符合同目录多数派） | `test-eol.mjs` | —（同上） |
| 索引 blob 与工作区只差行尾（git autocrlf 指纹） | `test-eol.mjs` + `npm run check:eol` | —（同上） |

---

## 十、明确没有守卫的地方（已知盲区）

不是遗漏，是当前接受的风险，写出来免得下次以为是「测过了」：

1. **17 条路由的公共面都已钉住，剩下的是各路由背后的业务实现。** 13 条 `exact` 在 `lib/routes.js`（49 条用例，含 `/apply` 的 10 步副作用顺序）、`rules`/`skills` 分发器在 `lib/http-routes.js`（52 条）、公共零件在 `lib/http.js`（32 条）、演练台桥在 `lib/redteam/bridge.js`（23 条）。桥之外那部分（`handlePlatformOp` / `handleAgentsOp` / `handleUpdateOp` / `handleSkillOp` / `dispatchAsync` 的实际实现）仍无守卫。
2. **提示词注入的读盘侧仍无测试。** 决策树（`decideInject`）与缓存签名（`liveCacheSignature`）已由 31 + 37 条用例钉住，但真正决定「注入什么正文」的 `readInjectFallback` / `refreshHungOperator` / `ensureOperatorBody` 需要 `$DSH_HOME` 下的磁盘状态，目前只有间接覆盖：加密槽落盘、`prompt-inject.md` 与内存提交版合并、mtime 与版本号双判失效。改坏了的表现是「注入正文变成旧的或空的」，且不会报错。
3. **演练台的计分口径已被钉住，但计分之外的演练台逻辑仍是空的。** `listScorePoints` / `scoreReport` / `scoreChain` 三处「必须算出同一个总分」的契约由 25 条用例守着（含条目级 `counted` / `capped`，因为总分一致抓不到条目级漂移）；`applyScoreCaps` 本身 98% 行覆盖。FTS5 降级由 7 条用例钉住（`test-fts-fallback.mjs`：子进程带 `REDTEAM_NO_FTS5=1` 跑一遍，对照两种模式的建表与检索面）；资产/漏洞/凭据/隧道/webshell 的 CRUD 已由 46 条用例钉住（含「非法值是静默回落还是抛错」这三种处理方式的区分，以及重复登记必须 UPDATE 不能插第二条的幂等）；会话摘要、攻击图、报告导出、bundle 导入、连通性探测已由 27 条用例钉住（`test-redteam-report.mjs`，`store-core.js` 行覆盖 66% → 74%），其中报告与 `reportTargets` 是同一套筛选口径的两份拷贝，用例按函数区间分别验证；64 个工具的入口面（参数校验、绑定解析、并发闸门、错误结构化）已由 24 条用例钉住，各工具自己的写库分支仍缺。
4. **`client.js` 主体（上游成品，源码已失传）无法验证。** 只有整体哈希锚点，锚点一变就说明有人动过，但动得对不对无从判断。
5. **桌面端的探测、脚本文本与重启决策都已钉住，真跑那一层没有。** 安装根名判定、exe 分类、结构反推、aiBase、常见位置展开、封存目录由 33 条用例守着（`test-desktop-locate.mjs`）；换包脚本必须满足的约束、三件套的三级回退与退级层数、`planOfficialRestart` / `desktopRestartChoice` 的决策表、空闲改名的排队语义由 24 条用例守着（`test-desktop-scripts.mjs`），合计把 `lib/desktop.js` 行覆盖推到 61%。仍未测的是注册表（`REGISTRY_INSTALL_SCRIPT`）、进程（`PROCESS_EXE_SCRIPT`）、快捷方式（`SHORTCUT_EXE_SCRIPT`）这三段 powershell 本身：它们只在 `discover: true` 时走到，要真的调 `powershell.exe`、要有真安装树与真进程，fixture 造不出来。改坏的表现是「装了但探测不到」。
6. **64 个工具的「入口」已被钉住，但每个工具自己的业务分支没有。** `lib/redteam/tools.js` 之前模块顶层就调 `loadDefineTool()`，没有宿主包的进程连 `import` 都抛错，2256 行一条测试都没有。改成 `apply(ctx)` 里按 `ctx.defineTool` 注入的本地工厂后，24 条用例把参数面（宿主 `parameterSchemaSpecToJsonSchema` 编译 64/64、`validateArgs` 拒缺必填/类型错/枚举外）、绑定解析、并发闸门、错误结构化全钉住了，行覆盖 74%。但真正写库的 `execute` 分支（`addVuln` 的幂等键、`searchPocs` 的两层检索、`scoreReport` 的条目筛选）仍只有间接覆盖 —— 它们要一个完整的靶标库 fixture，属下一批。
7. **自更新与打包的纯函数已钉住，真跑安装/卸载的那一层没有。** `test-self-update.mjs` 的 28 条用例覆盖 profile 补齐、`allowBuilds` 的 pnpm 11/12 分支、卸载顺序与摘引用、通道状态与版本比较（`profile-insert.js` 93%、`uninstall.js` 83%、`update.js` 55%）。但没覆盖：真的跑 `pnpm install` / `npm pack` 装一遍、`scheduleCleanupRestart` 真的重启宿主、`version-history.json` 的写入与 `checkUpdate()` 的网络路径（在线更新已关闭，只能走本地 tgz 手工验证）。
8. **`/rewind` 的规划与落地已钉住，但「回退之后界面填对了吗」没有。** `test-rewind.mjs` 的 45 条用例覆盖切点、认哪句话、四条落地路径、异常边界、草稿一次性取用、读盘三路、收件箱与子会话，`lib/rewind.js` 行覆盖从 10% 推到 90%。没覆盖的是：`waitTurnClosed` 的 8 秒超时（要真等）、草稿 10 分钟过期的清理（要真等）、以及前端拿到草稿之后往输入框里填的那一段（在 `client.js`，源码已失传，只有锚点哈希）。改坏的表现是「回退了，但输入框里是空的或者还是原来那句」。
9. **`scheduleRestart` / `scheduleCleanupRestart` 本身不测。** 它们会 `spawn` 一个 detached helper，然后 `setTimeout(() => process.exit(0), 250)` —— 直接调用会把跑测试的进程杀掉，所以 `test-host-restart.mjs` 只钉住了它们依赖的 `restartArgv` 与 `hostAdapter`。真跑的那一层只能靠实机点一次「重启」验证：改坏的表现是「点了重启，窗口关了但服务没起来」，用户以为插件把 dsh 弄坏了。
10. **子代理审批只在钩子层测，真宿主里 policy 翻转后的实际审批结果没有。** `test-host-restart.mjs` 用假 `ctx.on` 抓到了两个钩子的注册参数、触发条件、翻转上限与释放语义，但「宿主收到 `approval/policy: ask` 之后下一次审批真的弹出来了」这段在宿主内部，本仓看不到。
11. **两条休眠判据彼此不一致，已写成现状锁定。** `isHumanUserEvent` 不查 `rewind-` 前缀的回退标记（`isRoundPromptEvent` 查），`pendingInboxInserts` 会把「新一轮已经起来之前插入的」也算作待发。两者目前都走不到（仓库里没有任何地方真的造回退标记），但真要启用标记注入或收紧窗口，得先决定这两处的语义。
12. **`reapplyInstalled` 的流程层已钉住，真宿主那一层没有（详见盲区 30）。** `test-reapply-settle.mjs` 的 36 条把它的全部判据（戳/版本/rev 对齐、空 sha 补戳条件、`installed-rev` 来源、settle 冷却、补丁丢失判定、`hostCleanEnoughToKeep` 与 pending 实检）钉住了；`test-reapply-flows.mjs` 的 39 条把**主流程**也钉住了 —— 它把 `lib/reapply.js` 逐字节复制到临时包、旁边放一份桩 `core.js`，于是调用顺序、`clean` 判定、失败回滚、四处 `catch` 全都能断言，而不用真去调 `patchAllShims` / `silenceCmdFlash`（那会把本机 npm 全局的 shim 与宿主文件弄脏）。`lib/reapply.js` 行覆盖 20% → 70%。仍未覆盖的是**真实的宿主探测与真实副作用**：`sealedAsarHandoff()` 要求 `detectSurface()` 判成 desktop 且能找到官方 exe 与 `app.asar`（本机是解包布局，没有 `app.asar`），所以那条路只能用桩模拟；`openSealedDesktopHost` 的真解包、`patchAllShims` 的真写、`silenceCmdFlash` 的真改注册表都只验证了「被调到了、参数对不对」。另有一条在 CI 上不可复现：`hostStillHasAppliedPatches` 的「`findAiBase()` 返回空 → 当作还在」，只有根本没装宿主的机器才走得到（本机装了 DSH，把 `DSH_BASE` 指到不存在的目录，`findAiBaseWeb()` 仍会回落到 npm 全局根）。改坏的表现是「启动时该重打的不重打 / 不该重打的反复重打重启」。
13. **自动续跑的判据已钉住，真跑一轮 agent 的那一层没有。** `test-continue-retry.mjs` 的 44 条用例覆盖失败分类、预算与失败连击、配置合并、以及「什么时候不许替用户说话」（agent 还在跑 / 收件箱有货 / 刚有真人说话 / dispose 之后），`lib/continue-retry.js` 行覆盖 23% → 97%。没覆盖的是：`agent/request-error` 真的由宿主抛出来、`agent/status: idle` 真的在 280ms 后到、`followup` 真的把消息塞进队列。另有一处内部实现不可观测：`resetIfCompleted` 里 `cur.failStreak = 0; cur.failedSeqs = undefined;` 这两行是冗余的（紧接着 `this.reset(sessionId)` 会整条删掉会话记录），单独改掉它们对外部行为没有影响，RED 演练里这一改是 GREEN，用例里已写明，钉的是对外语义而不是这两行。改坏的表现是「一次网络抖动就把任务停在那里」或「用户还在打字，插件先替他发了一条」。
14. **角色稿的解析与落地已钉住，真宿主里的领消息事件没有。** `test-role-section.mjs` 的 23 条用例覆盖标签解析、文本抽取、`current` 的路径校验、稿件读取与钩子安装（`lib/redteam/role-section.js` 行覆盖 21% → 94%）。没覆盖的是宿主真的派发 `agent/inbox/claimed`、以及 `setTimeout(800)` 那次补装（用来兜住 effect 晚于首次领消息的情况）。另有两处防御在公开 API 上不可达、删掉外部行为也不变：`currentEngagementId()` 里「`agents/` 必须存在」与 `readRoleFile()` 里对 role 的二次校验——RED 演练里这两条是 GREEN，用例里已写明，不当成守卫。改坏的表现是「子会话拿着别人的角色稿干活」或「提示词里少一段角色说明」。

15. **启动前回收钩子的状态机已钉住，真起宿主的验证没有。** `test-bin-preflight.mjs` 的 22 条用例覆盖注入位置（shebang 之后 / 无 shebang 时最前 / 只有 shebang 无换行）、幂等（`already_injected`）、旧格式行清理、还原的三种结局（`reverted` / `absent` / `reverted_partial`）、以及两条「不许改」的树（源码 `apps/cli`、asar 密封根）。没覆盖的是「挂上之后真的能在宿主启动前把孤儿 web server 回收」——那要真起一个 `dsh web` 进程并让它残留，CI 里做不到。另有两处实现细节是纵深防御、在公开调用路径上不可达：`installBinPreflight` 里 `isAsarSealedPath` 那道判定（`resolveDshBinRoot` 已经先 `continue` 掉了密封根）、以及读 `bin.js` 失败时 sidecar 已经写下去（顺序是「先写 sidecar 再读 bin.js」，于是回滚会算成 `reverted_partial`）。两者都在用例注释里写明，不当成守卫。改坏的表现是「上一轮的孤儿 server 还占着端口，宿主启动时绑端口失败直接退出」。

16. **加密槽里那张表的内容没人能验证，只有「解得开、不是空串」。** `test-small-helpers.mjs` 钉住了 `mixKey` 的 32 字节与稳定性、`sealSlot` 的 mask/IV/tag 长度与每次新随机、往返一致、TAG 篡改必抛，以及 `openSlot()` 解得开且长度 > 1000。但表里那 21219 个字符写的是什么、对不对，本仓库无法判断——`lib/asset-table.js` 是上游产物，`SLOT_ROWS` 的明文没有第二份参照。改坏（或故意改）那张表时，测试只会告诉你「还能解开」，不会告诉你「内容变了」。同理 `openSlot()` 的 catch 分支在仓库内走不到（表是好的），所以那条 `return ""` 是用源码形状断言钉的，不是行为断言。

17. **知识库的六个 POC 工具此前一直报 `args is not defined`，现在修了；但「模型真的会用它」这一层没有。** `redteam_poc_search` / `_get` / `_add` / `_list` / `_update` / `_use` 六个 `execute()` 声明时漏了 `args` 形参，函数体却在读 `args.q` / `args.id` / `args.patch`，每次调用都被 `withStructuredErrors` 收成 `{ok:false,error:"args is not defined"}` —— 知识库整块功能在 1.1.94 副本里从来没工作过，而 `description` 里写着「先检索知识库」，模型照着调只会拿到失败。现在签名补齐，`test-redteam-tools.mjs` 用「返回值必须取自入参」的断言钉住（只断言 `ok:true` 抓不到这个 bug：`code` 要等于按标题算出的 slug、`hit_count` 要真的从 1 变 2）。没有守卫的是「模型在多轮里什么时候想得起来查库」——那是提示词与调度行为，不是代码。

18. **`lib/desktop.js` 的覆盖率不适合当硬棘轮，已登记环境容差。** 这个文件的分支命中挂在「跑测试那台机器的文件系统现状」上：`~/.dsh` 在不在、`%TEMP%` 里有没有上次重启留下的 `dsh-purge-asar-rename-when-idle-*.ps1`、npm 全局装没装 DSH。实测同一 commit（`b18b3f4`，干净 worktree）连跑 4 次稳定在 `fnh 72 / brh 310~311`；把 TEMP 残留移走后 brh 从 310 变 311，换成空 `HOME`/`USERPROFILE` 跑则掉到 `69 / 308` ——基线里那几个数（`fnh 73 / brh 312 / brf 420`）在采集它的那次运行之后再也复现不出来。处置：`scripts/coverage-baseline-lib.mjs` 里加了 `ENV_TOLERANCE = { 'lib/desktop.js': { fnh: 2, brh: 4 } }`，容差内的下跌**仍然列进报告**（`~ lib/desktop.js 分支 312 → 311 (-1，在环境容差 4 内)`）但不判 FAIL；超出容差照样红（`test-coverage-baseline.mjs` 有「容差不是免死金牌」那条钉住）。没有守卫的是 `lib/desktop.js` 里 31 个具名零命中函数（`restartPlan` / `spawnHelper` / `scheduleAsarSwapRestart` /`restartOfficialHarness` / `repairOfficialCliAfterUnpack` 等，全是真起进程、真换 asar 的桌面动作）——它们要真调 `powershell.exe` + 真安装树 + 真进程，这台机器造不出可靠 fixture。改坏的表现是「桌面端重启卡住 / asar 换不回来 / 重启后 CLI 起不来」，且不会有任何报错。

19. **`redteam_preflight` 的「桌面端没有 skills 服务」早退支在本仓库不可达，只用源码形状钉住。** 那条分支的条件是 `skillsMissing && bundledSkills.length === 0`，而 `lib/redteam/skill-availability.js` 的 `bundledSkillSummaries()` 恒扫 `skills/redteam`（本仓 23 个 `.md`）以及每个 `dshHomeCandidates()` 下的 `<home>/redteam/skills` —— 任何安装形态下都不为空，所以 `test-redteam-tool-branches.mjs` 里那条用例读源码断言 `if (skillsMissing && bundledSkills.length === 0) {`、`skills_root_hint` 的固定文案、以及 `ok: missing.length === 0 && toolMissing.length === 0` 三处形状。真要走到它，得把 `skills/redteam` 整个删掉再跑，那样其余 40 条用例的兜底体检也一起变了，得不偿失。同一文件里 `redteam_attack_path` 的 15 行与 `redteam_poc_add` 的名称补全 5 行已补齐；仍空着的是模块级辅助的 101 行冷分支（`bindingKeyOf` / `compactAsset` / `liveRunningChildren` 的异常路径等），它们只在宿主内部状态畸形时才走到。改坏的表现是「桌面端首次打开演练台时体检整条报废」或「并发闸门读不到会话 id 就静默放行」。

20. **`redteam_webshell_add` 的 `status: 'online'` 是显式意图表达，与 store 层默认值等价，改坏了不可观测。** `lib/redteam/validate.js` 的 `normalizeShellStatus('')` 在空串时本身就 `return 'online'`，所以把工具里那个 `status: 'online'` 删掉，落库结果完全一样 —— RED 演练里这一改是 GREEN，用例注释里已写明。留着它是为了让「新增的 shell 默认算在线」这件事在工具层可读；真要改这条语义，得同时改 `normalizeShellStatus` 的默认值，那时 `test-redteam-tool-branches.mjs` 的 `webshell_add` 用例会红。

21. **`lib/preset-default.js` 里定时器的 `unref()` 在进程内不可观测，只能读源码形状。** `scheduleClearOwnedSelectedDefault` 那 800ms 定时器挂了 `unref()`，防的是「宿主退出被这个空定时器拖住」——桌面端表现为关窗口后进程残留、下次启动端口还被占。但在测试进程里，`unref` 过与不过，定时器都照常触发、进程都照常退出，任何断言都看不出差别（同 `atomic-write.js` 的 `fsyncSync`）。处置：`test-preset-default.mjs` 用 `assert.match` 读 `lib/preset-default.js` 原文钉住那一行。同一文件里「裸字符串改不动」与「`redteam-extra` 被改成 `standard-extra`」两条也是**现状锁定**，不是期望行为：前者是因为 `node.value = x` 在严格模式抛 TypeError 被 `configSet` 吞掉，后者是因为正则没有锚定词尾（`redteamish` 同理会被改成 `standardish`）。

22. **`lib/hooks-deny.js` 只认 8 条已知的旁路形态，第 9 种形态不会报错、只会留下死字符串。** 反向替换是按 `REVERSES` 里 8 条 `{find, replace}` 逐条 `split/join` 做的，宿主若把 hooks 的代码结构改掉（升级换了缩进、换了 `decision` 的写法、把同步改成 `await`），`find` 就命中不到：此时 `restoreHookDenyOfficial` 会走「命中为空」那一路——如果文件里还留着 `__dsh_purge_deny_disabled__` 就只记进 `sentinelLeft` 不写盘，于是**卸载之后官方 hooks 文件里仍然留着这个死字符串**，宿主 hooks 语义永久变形且没有任何报错。这正是「宿主升级后快速定位失效点」要盯的地方：`npm run host:status` 看不出这一层，得看 `restoreHookDenyOfficial` 返回的 `sentinelLeft`。反过来，8 条形态本身有测试逐字钉住（含「同一形态出现多次全部还原」「R1a 与 R1a2 共享尾行但互不吞并」），所以宿主一改结构，`test-hooks-deny.mjs` 会红在那 13 条上。另有一处同类不可观测：`atomicWriteFileSync` 的 `fsyncSync` 在进程内测不出（同 `atomic-write.js`），能测的只有「rename 失败要抛错且收走 `.tmp`」。

23. **`lib/extract-asar.js` 的 `original-fs` 分支在非 Electron 环境里不可观测，`readHeader` 的 256MB 上限也造不出来。** 前者的表现是：`diskFs()` 会先试 `require("original-fs")`，拿不到才退回 `node:fs`。本机跑测试时（真 node）永远拿不到 `original-fs`，于是 `diskFs() === nodeFs` 两个引用相等 —— 把 `fsFor()` 改成恒返回 `node:fs`，返回值一模一样，任何断言都看不出差别。这条只能靠间接观测：`fsFor()` 必须留下「探测过」的痕迹（写进探针缓存），所以测试先清缓存、调 `fsFor()`、绕过 `hostFs` 删掉归档、再问 `asarShadowsPath()` —— 只有真走了探测才会命中缓存说「仍被映射」。后者是 `jsonSize > 256 * 1024 * 1024` 那道守卫，要真造一份 256MB+ 的 header 才能触发，测试改成手拼 16 字节 pre 把 `jsonSize` 写成 300MB（不分配正文），断言报 `asar header size invalid` 且目标目录没被建出来。另有两条同类不可观测已在上文记过：漏关 fd（Windows 允许删除仍打开的文件）与 `fsyncSync`。

24. **`lib/anchor.js` 的锚点正文有没有真的进到模型上下文，本仓库验证不了。** 这里能钉住的是「注册参数对不对」（名字、order、`interpolate:false`、`required:true`、text 是函数且受开关控制），钉不住的是宿主有没有按 order 排序、有没有因为 `suppress` 把 context 丢掉、`refreshContext` 有没有真的把 `required` 的捞回来 —— 那要真起宿主看渲染出来的 system prompt。坏掉的表现是**身份漂移**（模型开始写「作为 AI」、开始拒绝），没有任何报错、没有任何红字。同理，锚点正文里那 9 条规则的**措辞**本身也只能靠人读：`test-anchor.mjs` 只断言「9 条编号都在」「关键句还在」，改一句同义但更弱的措辞不会红。

25. **`lib/hide-console.js` 的 `MARK` 一旦打上就删不掉，装好之后这一层只能靠导出函数来测；`installHideConsoleIntoBin` 里那段「清理旧 import 行」的正则在 install 路径上走不到。** 两处都是结构性的、不是疏忽：`Object.defineProperty(cp, MARK, { value: true, enumerable: false })` 没给 `configurable`，所以测试进程里没法「重装」builtin 来观察 wrapper —— 这也是把 `forceHideOptions`/`wrapSpawn`/`wrapExecLike`/`wrapExecFile`/`wrapFork` 导出成 public 的唯一理由（`fd47647`）。真正测不到的是「宿主真跑起来时这层有没有生效」：Windows 上子进程弹不弹黑窗，本仓库只能靠真开一次宿主目视。第二处：`already_injected` 的判据是「含 `IMPORT_MARK`」且「含 `import "./dsh-purge-hide-console.js";`」，任何双引号旧行两条都满足 → 直接早退，后面那条 `/m` 的清理正则永远走不到（只有 `revertHideConsoleFromBin` 的 `/gm` 才会真清）。单引号形态（`import './dsh-purge-hide-console.js';`）会漏过去，结果是多插一行 —— ESM 按 specifier 去重，无害，测试里已按现状锁定。另：`writeHostFileAtomic` 在 POSIX 下把原 mode 带到临时文件（#213）这条，Windows 上只有只读位、`chmod 0444` 与 `0644` 的差别测不全，真正的 `+x` 丢失只能在 Linux/macOS 上验证。

26. **`lib/redteam/platform-config.js` 的「文件名转小写再匹配」在 Windows 上测不到，只能靠 CI 的 Linux 跑 + 源码形状钉。** `adaptInDir` 的判据是 `pattern.test(String(name).toLowerCase())`，为的是认出 `HTTPX-ToolKit` 这种大小写被改过的分发名。但 Windows 文件系统大小写不敏感，`names` 里的精确匹配（`httpx-toolkit`）会先命中，`adaptInDir` 那条路根本走不到 —— 本地把 `.toLowerCase()` 删掉，行为完全一样。处置：`test-platform-config.mjs` 里拆成两条，一条在非 Windows 上真跑（断言 `basename` 是 `HTTPX-ToolKit`，CI 的 ubuntu-latest 覆盖），一条读源码断言 `if (!pattern.test(String(name).toLowerCase())) continue` 这一行的形状，本地也能红。同类还有两处**现状锁定**：`scanFolderForTools` 的 `maxDepth: 0` 因为 `Number(0) || 4` 是 falsy 会走默认 4（不是被夹到 1）；`TOOL_CATALOG` 的 `names` 与 `adapt` 是两份手写清单，只有用例互校能发现不一致（例如给 `httpx` 加了个 `adapt` 却没进 `names`）。另有一条只能手写 fixture 的：`resolveTool` 的 `looksLikePythonCli`（读前 96 字节看 `#!` 里有没有 `python`）只在 `httpx` 的 `rejectPython` 上生效，要造一个「名叫 `httpx` 但其实是 Python 脚本」的文件才触发，本仓库没有这样的分发样本，用例里手写了一份 `#!/usr/bin/env python3` 的假工具。

27. **`lib/zip-extract.js` 的真解压路径按本机装了什么外部工具而变：`tar` 与 `python3` 在本机与 CI 上恰好都在，`unzip` / `powershell` / `bsdtar` 都不在。** 于是 `test-zip-extract.mjs` 里「tar 真能解」「python3 真能解」两条只在装了对应工具的机器上有效（对非 zip 输入的那条已经写成「没装就 return」，避免在别的机器上假绿）。另有三处**现状锁定**：①手拼 zip 必须写对 CRC32，否则内置解包器不看 CRC 能过、`tar` 会报 `ZIP bad CRC` —— 这是 fixture 的坑，不是产品的坑；②单前导斜杠（`/etc/passwd`）被 `safeZipName` 的开头斜杠剥离剥掉后当相对路径，落在 `dest/etc/passwd`，不逃出目标目录但也不是拒绝；③`extractZipArchive` 的 `entriesSafe` 预检只看「是不是 zip + 名字安不安全」，看不了外部工具解出来的**符号链接与硬链接**（`tar` 会照原样建），真正的越界只有 `node` 这条自己写的解包路径挡得住。

28. **`lib/skills.js` 里有四处只能靠源码形状或 CI 的 Linux 兜住。** ①`blockScalarValue` 最后统一 `replace(/\s+/g, " ").trim()` 把正文压成单行（上游面板按单行描述渲染），于是 YAML 的 `|` 字面量与 `>` 折叠两种样式在输出上完全等价 —— 把 `|` 分支改成折叠逻辑，RED 演练是 GREEN，用例里写成现状锁定。②`listSkills` 的 `entries.sort((a, b) => a.name.localeCompare(b.name))` 在 NTFS 上测不出：`readdir` 本身就按字母序返回，删掉 sort 结果一样，只能用源码形状断言钉。③`installBundleDir` 里 `parsed.ok && parsed.name !== id` 是死分支（`id` 就是取 `parsed.name`），`walkFiles` 的 `depth > 6` 与 `findSkillRoots` 的 `depth > 4` 只能造深层目录真跑、造不出就靠形状；`pathsOverlap` 的 `realpath` 判重在没链接权限的机器上要退回源码形状（本机 `symlinkSync` 可用，真跑）。④`saveSkill` 里 `const check = parseSkillDocument(document); if (!check.ok) throw` 构造不出输入（模板自己刚拼的文档必然合法），同样是源码形状。改坏的表现是「导入技能包后名字变成目录名」「覆盖已有技能时把旧正文冲掉且备份里也没有」或「软链指向 `skills` 时把自己整个删穿」——都没有报错。

29. **`lib/update.js` 的下载与 git 那一层在当前配置下不可测。** ①`ONLINE_UPDATES_ENABLED = false`，`listRemoteVersions()` 直接短路成 `["", "", []]`，于是 `requestBuffer` / `fetchRes` / `fetchText` / `fetchJson` / `remotePackageVersion` / `remoteHeadSha` / `listGithubTags` 一个都跑不到；真打网络也不行（私有仓库返回 404，而重定向白名单与 50MB 上限都要真流量才触发）。②`runGit` / `gitResetTo` / `gitTrackedDirty` / `overlayFromZip` / `runReapplyChild` 会改本机安装或起子进程，只能在真机上手工验一遍。③`gitTrackedDirty` 的 `catch { return true; }` 是**保守**选择：git 不存在时宁可当作「有改动、不覆盖」，所以「删掉 catch 改成 false」这种改法在装了 git 的机器上测不出——已用源码形状钉住那行的存在。④`lanes.*.sha` 在开关关闭时恒空，`describeLane` 里比 sha 的两支只有在打开在线更新后才有意义。改坏的表现是「点了更新但什么都没下载」「回退到某个版本后 git 工作区被覆盖」或「升级失败后通道状态已经写成了新版本」——都没有报错。

30. **`lib/reapply.js` 的 `reapplyInstalled` 用「临时副本 + 桩 core」测，真宿主那一层没有。** `test-reapply-flows.mjs` 把 `lib/reapply.js` 逐字节复制到临时包、旁边放一份桩 `core.js`，于是调用顺序、`clean` 判定、失败回滚、四处 `catch` 全都能钉住（原文一改立刻跟着测新的）。测不到的是**真实的宿主探测**：`sealedAsarHandoff()` 要求 `detectSurface()` 判成 desktop 且能找到官方 exe 与 `app.asar`，本机是解包布局（`resources/app`，没有 `app.asar`），所以那条路只能用桩返回 `{asar: true}` 模拟；同理 `openSealedDesktopHost` 的真解包、`patchAllShims` 的真写 npm 全局、`silenceCmdFlash` 的真改注册表都只验证了「被调到了、参数对不对」。改坏的表现是「桌面端升级后插件静默失效」或「每次启动都 revert+apply 打成死循环」——都不报错。另有一条 CI 不可复现：`hostStillHasAppliedPatches` 的「`findAiBase()` 返回空 → 当作还在」，只有根本没装宿主的机器才走得到。
31. **`lib/redteam/settings.js` 与 `lib/redteam/skill-availability.js` 各有几处现状锁定。** ①`readSettings` 用 `parsed && typeof parsed === "object"` 判，数组也会原样返回（`typeof [] === "object"`），只是上层读 `maxAgents` 读不到所以无影响 —— 用例里按现状锁定。②`clampMaxAgents(null)` 是 `Math.floor(Number(null)) === 0` 再夹成 **1**，不是回落默认 3；`maxAgentsOf` 的文件值要求 `> 0` 才认，所以写进去的 0 等于没写。③`expandSkillPath` 是纯字符串拼接、**不做 `path.normalize`**，Windows 上结果会混 `/` 与 `\`（`existsSync` 能认，比较字符串时不能），用例断言必须包一层 `path.normalize`。④`existsUnderAnyHome` 遍历全部候选 home 这件事只能读源码钉：真实场景要求文件在 `~/.dsh` 下而 `DSH_HOME` 指向别处，那要动真实家目录。⑤`bundledSkillSummaries` 恒扫仓库里的 `skills/redteam`（23 个 `.md`），所以 `redteam_preflight` 的「桌面端无 skills 服务」早退支在本仓不可达（见盲区 19）。

32. **`lib/identity.js` 里有五处只能靠源码形状或「不可达」认定。** ①`injectMatchers` 里 `new RegExp` 的 `catch`（`:375-376`）走不到——每个字符都过 `replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` 转义了，构造永不抛；②`withOwnServers` 的两条（`:852`、`:856-857`）依赖 `lib/net-scope.js:407` 的 `ownServerNote()`，它现在是 `return "";`（上游刻意留空），note 恒空所以永远走 `return text`；③`rewritePromptAssembly` 的「注入前 80 字符一段都不含 → 再前置一段 `dsh-purge`」兜底块（`:1090-1099`）在五种常规组合下都触发不到，因为 `leadWithInject` 总会先放一个 head，只能用源码形状断言钉住；④`foldInjectIntoPersona` 新造的 `deployment:persona-prefix` 会被随后的 `leadWithInject` 用全文精确匹配清空丢弃，对外不可见；⑤`insertNamedSection` 的落点（`capAt+1` / `purgeAt+1` / `0`）在 13 种组合下产出完全相同——card/role 段名固定、排序后落点一致，改了不会红。

33. **`lib/redteam/store-core.js` 已拆出两个模块，但拆分的「等价性」只有一次性的对拍，没有常驻守卫。** 5429 行拆成 3832 行 + `score-report.js`（1533 行，计分三件套）+ `engagement-meta.js`（155 行，元数据与阶段口径），类里对四个方法只留一行转发，所以 `store.scoreReport(...)` 的调用点一处都没动。拆分当时用「`git show HEAD:` 取原文 → 同一套 splice 算法重跑一遍 → 与工作区逐行比对」证明 `store-core.js` 除搬走四块、换四个转发、插 import/再导出块之外零改动（DIFF 0 / 3832 行），`score-report.js` 里四个函数也逐行对拍过（152/1048/178/44 行 diff 0）。但这份对拍脚本在 `.tmp45/`，提交前就删了 —— 将来谁再动这三个文件，没有任何东西会告诉他「你把实现挪了却没改转发」。能兜住的是行为：`test-score-consistency.mjs` 的 25 条要求面板/报告/攻击链算出同一个总分，转发写错立刻红。**顺带修掉两处上游漏定义**：`schema.js` 的 `migrate()` 引用了 `SCOPE_SQL` 与 `LEGACY_STAGE_MAP` 却从未 import，两处回填的 `ReferenceError` 被外层 `try { … } catch { /* 忽略 */ }` 吞掉 —— 老库的 `asset.scope` 内外网与 `attack_step.stage_code` 阶段映射**从 1.1.94 上线起就没生效过**，且不报任何错。修法是从新的叶子模块 import，`test-schema-migrate.mjs` 用「造老库形状 → 跑 migrate → 断言回填结果」钉住，RED 演练 16 条注入全红。另有一条只能钉源码形状：`port` 回填里 `if (port !== null)` 这个守卫，因为 SELECT 已经过滤了 `port IS NULL`，写 NULL 与跳过在库里结果相同，行为断言区分不了。

34. **行尾约定只能靠 `docs/eol-baseline.json` 现状锁定，没有「应该是什么」的独立判据。** `check:eol` 的三条规则全部相对基线判断：第 2 条要求「已入库文件的行尾不许变」，而基线本身就是 `--update` 从当前工作区生成的 —— 所以**只要有人跑一次 `--update`，任何行尾改动都会被当成新的正确状态**。这道守卫挡的是「无意中被 git 转换」，不是「故意改行尾」。能兜住的只有第 3 条（新文件必须符合同目录多数派）与第 1 条（文件内不许混行尾），这两条不依赖基线。另外：①`client.js` 与 `docs/origin/client-1.1.94.js` 是 5017 CRLF / 9381 LF 的混合文件，它们是上游产物的逐字节锚点（`check:client` 校验哈希），所以进 `MIXED_ALLOWED` 白名单、永远不报 —— 这意味着**这两份文件的行尾无法用任何自动手段保护**，只能靠「别手改 `docs/origin/`」这条约定。②`readBlobs` 用 `git cat-file --batch`，头部 `<sha> <type> <size>` **不含路径**，必须按输入顺序对上；第一版用 `parts.slice(3)` 取路径导致所有 blob 落到同一个键、检测静默失效（`check` 永远 PASS），是靠负向验证（临时开 `core.autocrlf=true` 造出「工作区 2 CRLF、blob 2 LF」）才抓出来的。③`--batch` 的缺失对象只输出两段 `<输入> missing`，要跳过，且内容必须按声明的 size 切、不能按行切。④`git ls-files` 只列已跟踪文件，未跟踪的新文件不在审计范围 —— 新增文件要先 `git add` 才会被查，所以「刚写完还没 add 的文件行尾不对」这件事要到下一轮才暴露。

---

## 维护约定

- 补一行时，`守卫` 列必须写**能跑的东西**（脚本名或 npm 命令），不要写「已测试」。
- 覆盖率列用 `npm run test:full` 的实测值，别抄上次的。
- 从 `❗缺` 里挑活时，优先挑「改坏了没人能发现且用户能感知」的：第三节（提示词注入）与第四节的 HTTP 路由，排在计分口径前面——因为前者影响每一轮对话，后者只在打开演练台时影响。
