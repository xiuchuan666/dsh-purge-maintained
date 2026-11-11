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
| 注入决策树（strict / fallback / always 三种工作区策略） | `test-prompt-inject.mjs`（`decideInject` 6 条：strict 无注入也剥 / fallback 有注入才剥 / always 保留 / 停用一律不剥 / 未知策略按 always） | `lib/identity.js` 69% |
| `prompt-inject.md` 非空时优先于工作区 md | `test-prompt-inject.mjs`（5 条：优先级 / cwd 回落 / 纯空白视为空 / 都不拼接 / 都空给空串） | `lib/identity.js` 69% |
| 两种都没有时回落到插件内的加密 slot 默认 | `test-prompt-inject.mjs`（`inject === ""` + `source === "none"`，下游 `rewritePromptAssembly` 的回落另有 3 条） | `lib/identity.js` 69% |
| 装配结果段序（注入在最前、capabilities 其次、persona 收尾、anchor 最后） | `test-prompt-inject.mjs`（8 条，含不原地改写传入对象、`null`/`{}` 原样返回） | `lib/identity.js` 69% |
| `stripChatmlTags` 只剥三种形态（完整 `im_start system:`、`project_instructions`、`im_end`） | `test-prompt-inject.mjs`（含一条现状锁定：裸 `<\|im_start\|>` 不剥） | `lib/identity.js` 69% |
| `anchorMode` 只有 `auto` 与 `off`（不是 strict/fallback/always） | `test-plugin-surface.mjs`（现状锁定：`"bogus"` 原样透传） | `lib/anchor.js` 55% |
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

**本轮的进展**：注入决策树原来埋在 `rewriteLiveAssembly` 里，只有真正跑起宿主才走得到，改错了没有任何红字。现已抽成 `lib/identity.js` 的 `decideInject`（纯函数，逐行比对过抽取前后行为一致），由 `test-prompt-inject.mjs` 的 31 条用例钉住；缓存签名与命中规则抽成 `lib/live-cache.js`（`liveCacheSignature` / `sessionKeyOf` / `createLiveCache`），由 `test-live-cache.mjs` 的 37 条用例钉住，且拆分前后 2304 组输入的签名逐字对拍一致（`.tmp-exp/sig-parity.mjs`，一次性）。规则集读写（含备份与恢复的三条分支）已由 `test-rules-store.mjs` 的 30 条用例钉住——这组最怕的是「用户手写的 AGENTS.md 被另一条规则的内容悄悄盖掉」，因此备份/恢复的每个分支都单独立了用例。

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
| POC 库增删查（`pocSearch` / `pocSave` / `pocStats`） | `test-knowledge-dispatch.mjs` | `lib/redteam/store-core.js` 66% |
| nuclei 模板索引缓存（首次建、命中、7 天过期、损坏重建） | `test-store-templates.mjs` | 同上 |
| 计分口径三处一致：面板 / 报告 / 攻击链算出同一个总分（普通命中、同服务去重、自建账号、停用得分点、规则上限吃满、命中自带分值、G6 IPv6 ×3、G5 数据规模 ×2、混合 9 种场景） | `test-score-consistency.mjs` | `lib/redteam/store-core.js` 66% |
| `applyScoreCaps` 纯函数：四种 `dedup_scope` + 规则上限的边界（降序累计、`cap<=0` 不封、`self_created` 不占位、无元数据退化） | `test-score-consistency.mjs` | `lib/redteam/score-rules.js` 98% |
| 封顶文案（dedup / cap 两种措辞，含 `+50 分` 与 `+null` 边界） | `test-score-consistency.mjs` | 同上 |
| 目标归并 `targetKey`：URL 截到 scheme+host+port、非 URL 取首段、空值回落资产 IP | `test-redteam-crud.mjs` | `lib/redteam/store-core.js` 66% |
| 写库前的枚举规范化：马类型/马状态认中文别名与大小写、认不出就抛错（不是静默存原文） | `test-redteam-crud.mjs` | `lib/redteam/validate.js` 95% |
| 漏洞登记：非法 severity/status 静默回落、带 cve 与不带 cve 两种幂等键、`gained` 规范成一行、只在挂资产时写 observation | `test-redteam-crud.mjs` | `lib/redteam/store-core.js` 66% |
| 漏洞列表：六种筛选、严重度排序、`limit` 夹 1..1000、证据默认截 8000 字符、`evidenceLimit` 取全文 | `test-redteam-crud.mjs` | 同上 |
| 漏洞更新：缺行返回 `updated:false`、非法值保留旧值、`vulnStats` 按站点归并 | `test-redteam-crud.mjs` | 同上 |
| 凭据与访问会话：`host` 必填、明文四级别名优先级、冲突保留旧值但刷新 `found_at` | `test-redteam-crud.mjs` | 同上 |
| WebShell：`url` 必填、同 `url+pass_key` 幂等、update 与 add 走同一套规范化、缺行报错 | `test-redteam-crud.mjs` | 同上 |
| 隧道：`entry_kind` 是得分凭证（非法值抛错、`self-only` 标 `legit:false`、空值算待确认）、update 校验 status | `test-redteam-crud.mjs` | `lib/redteam/score-rules.js` 98% |
| 资产测试状态与评估：`test`/`notes` 两种写法都追加、`blocked` 累加到第 3 次给转向提示、非法 `priority` 保留原值 | `test-redteam-crud.mjs` | `lib/redteam/store-core.js` 66% |
| 会话总览：webshell 在线数、隧道 active 数、`self-only` 不算突破凭证、未声明 `entry_kind` 算待确认 | `test-redteam-report.mjs` | `lib/redteam/store-core.js` 74% |
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
| 各工具自己的 `execute` 业务分支（写库、检索、导出、POC 知识库） | `❗缺` | 同上 |

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
| 在线更新保持关闭（不指回已删库的 `HunYiSage/dsh-purge`） | `test-update-source.mjs` | `lib/update.js` 45% |
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
| 预设默认值改回 `standard`（停用/卸载后宿主 `resolve()` 不硬抛） | `test-self-update.mjs` | `lib/preset-default.js` 41% |
| 通道状态：坏 `channel.json` 回落 stable、beta pin 清空并回写 | `test-self-update.mjs` | `lib/update.js` 45% |
| 版本比较与筛选：`versionIsNewer`、`latestStableVersion`、`hideListedVersion` | `test-self-update.mjs` | 同上 |
| 更新 ref 白名单（`safeUpdateRef` 挡住路径穿越与命令拼接） | `test-self-update.mjs` | 同上 |

---

## 九、测试机制自身

| 能力 | 守卫 | 覆盖率 |
| --- | --- | --- |
| 测试发现规则（`scripts/test-*.mjs`，忽略子目录） | `test-verification.mjs` | —（`scripts/` 不在覆盖率 include 范围） |
| 元数据校验规则（版本、发布说明、`dshTargets`、id 唯一） | `test-verification.mjs` | —（同上） |
| 覆盖率基线不跌破（棘轮） | `npm run test:full` | —（同上） |
| 基线守卫的路径三处不错配 | `test-coverage-baseline.mjs` | —（同上） |
| 宿主契约扫描语义（.bak 优先、成员搬家提示） | `test-host-contract.mjs` | —（同上） |
| 补丁注册表拆分等价 | `test-patch-registry.mjs` | — |

---

## 十、明确没有守卫的地方（已知盲区）

不是遗漏，是当前接受的风险，写出来免得下次以为是「测过了」：

1. **17 条路由的公共面都已钉住，剩下的是各路由背后的业务实现。** 13 条 `exact` 在 `lib/routes.js`（49 条用例，含 `/apply` 的 10 步副作用顺序）、`rules`/`skills` 分发器在 `lib/http-routes.js`（52 条）、公共零件在 `lib/http.js`（32 条）、演练台桥在 `lib/redteam/bridge.js`（23 条）。桥之外那部分（`handlePlatformOp` / `handleAgentsOp` / `handleUpdateOp` / `handleSkillOp` / `dispatchAsync` 的实际实现）仍无守卫。
2. **提示词注入的读盘侧仍无测试。** 决策树（`decideInject`）与缓存签名（`liveCacheSignature`）已由 31 + 37 条用例钉住，但真正决定「注入什么正文」的 `readInjectFallback` / `refreshHungOperator` / `ensureOperatorBody` 需要 `$DSH_HOME` 下的磁盘状态，目前只有间接覆盖：加密槽落盘、`prompt-inject.md` 与内存提交版合并、mtime 与版本号双判失效。改坏了的表现是「注入正文变成旧的或空的」，且不会报错。
3. **演练台的计分口径已被钉住，但计分之外的演练台逻辑仍是空的。** `listScorePoints` / `scoreReport` / `scoreChain` 三处「必须算出同一个总分」的契约由 25 条用例守着（含条目级 `counted` / `capped`，因为总分一致抓不到条目级漂移）；`applyScoreCaps` 本身 98% 行覆盖。FTS5 降级由 7 条用例钉住（`test-fts-fallback.mjs`：子进程带 `REDTEAM_NO_FTS5=1` 跑一遍，对照两种模式的建表与检索面）；资产/漏洞/凭据/隧道/webshell 的 CRUD 已由 46 条用例钉住（含「非法值是静默回落还是抛错」这三种处理方式的区分，以及重复登记必须 UPDATE 不能插第二条的幂等）；会话摘要、攻击图、报告导出、bundle 导入、连通性探测已由 27 条用例钉住（`test-redteam-report.mjs`，`store-core.js` 行覆盖 66% → 74%），其中报告与 `reportTargets` 是同一套筛选口径的两份拷贝，用例按函数区间分别验证；64 个工具的入口面（参数校验、绑定解析、并发闸门、错误结构化）已由 24 条用例钉住，各工具自己的写库分支仍缺。
4. **`client.js` 主体（上游成品，源码已失传）无法验证。** 只有整体哈希锚点，锚点一变就说明有人动过，但动得对不对无从判断。
5. **桌面端的探测、脚本文本与重启决策都已钉住，真跑那一层没有。** 安装根名判定、exe 分类、结构反推、aiBase、常见位置展开、封存目录由 33 条用例守着（`test-desktop-locate.mjs`）；换包脚本必须满足的约束、三件套的三级回退与退级层数、`planOfficialRestart` / `desktopRestartChoice` 的决策表、空闲改名的排队语义由 24 条用例守着（`test-desktop-scripts.mjs`），合计把 `lib/desktop.js` 行覆盖推到 61%。仍未测的是注册表（`REGISTRY_INSTALL_SCRIPT`）、进程（`PROCESS_EXE_SCRIPT`）、快捷方式（`SHORTCUT_EXE_SCRIPT`）这三段 powershell 本身：它们只在 `discover: true` 时走到，要真的调 `powershell.exe`、要有真安装树与真进程，fixture 造不出来。改坏的表现是「装了但探测不到」。
6. **64 个工具的「入口」已被钉住，但每个工具自己的业务分支没有。** `lib/redteam/tools.js` 之前模块顶层就调 `loadDefineTool()`，没有宿主包的进程连 `import` 都抛错，2256 行一条测试都没有。改成 `apply(ctx)` 里按 `ctx.defineTool` 注入的本地工厂后，24 条用例把参数面（宿主 `parameterSchemaSpecToJsonSchema` 编译 64/64、`validateArgs` 拒缺必填/类型错/枚举外）、绑定解析、并发闸门、错误结构化全钉住了，行覆盖 74%。但真正写库的 `execute` 分支（`addVuln` 的幂等键、`searchPocs` 的两层检索、`scoreReport` 的条目筛选）仍只有间接覆盖 —— 它们要一个完整的靶标库 fixture，属下一批。
7. **自更新与打包的纯函数已钉住，真跑安装/卸载的那一层没有。** `test-self-update.mjs` 的 28 条用例覆盖 profile 补齐、`allowBuilds` 的 pnpm 11/12 分支、卸载顺序与摘引用、通道状态与版本比较（`profile-insert.js` 93%、`uninstall.js` 83%、`update.js` 45%）。但没覆盖：真的跑 `pnpm install` / `npm pack` 装一遍、`scheduleCleanupRestart` 真的重启宿主、`version-history.json` 的写入与 `checkUpdate()` 的网络路径（在线更新已关闭，只能走本地 tgz 手工验证）。
8. **`/rewind` 的规划与落地已钉住，但「回退之后界面填对了吗」没有。** `test-rewind.mjs` 的 45 条用例覆盖切点、认哪句话、四条落地路径、异常边界、草稿一次性取用、读盘三路、收件箱与子会话，`lib/rewind.js` 行覆盖从 10% 推到 90%。没覆盖的是：`waitTurnClosed` 的 8 秒超时（要真等）、草稿 10 分钟过期的清理（要真等）、以及前端拿到草稿之后往输入框里填的那一段（在 `client.js`，源码已失传，只有锚点哈希）。改坏的表现是「回退了，但输入框里是空的或者还是原来那句」。
9. **`scheduleRestart` / `scheduleCleanupRestart` 本身不测。** 它们会 `spawn` 一个 detached helper，然后 `setTimeout(() => process.exit(0), 250)` —— 直接调用会把跑测试的进程杀掉，所以 `test-host-restart.mjs` 只钉住了它们依赖的 `restartArgv` 与 `hostAdapter`。真跑的那一层只能靠实机点一次「重启」验证：改坏的表现是「点了重启，窗口关了但服务没起来」，用户以为插件把 dsh 弄坏了。
10. **子代理审批只在钩子层测，真宿主里 policy 翻转后的实际审批结果没有。** `test-host-restart.mjs` 用假 `ctx.on` 抓到了两个钩子的注册参数、触发条件、翻转上限与释放语义，但「宿主收到 `approval/policy: ask` 之后下一次审批真的弹出来了」这段在宿主内部，本仓看不到。
11. **两条休眠判据彼此不一致，已写成现状锁定。** `isHumanUserEvent` 不查 `rewind-` 前缀的回退标记（`isRoundPromptEvent` 查），`pendingInboxInserts` 会把「新一轮已经起来之前插入的」也算作待发。两者目前都走不到（仓库里没有任何地方真的造回退标记），但真要启用标记注入或收紧窗口，得先决定这两处的语义。
12. **`reapplyInstalled` 本身不测。** `test-reapply-settle.mjs` 的 36 条用例把它的全部判据（戳/版本/rev 对齐、空 sha 补戳条件、`installed-rev` 来源、settle 冷却、补丁丢失判定、`hostCleanEnoughToKeep` 与 pending 实检）都钉住了，`lib/reapply.js` 行覆盖 20% → 70%，但没测 `reapplyInstalled` 这条主流程：它一路调到 `revertAll` / `applyPatchesAllHosts` / `patchAllShims` / `silenceCmdFlash`，跑一次就会改本机 npm 全局的 shim 与宿主文件，等于把开发机弄脏。另有一条分支在 CI 上不可复现：`hostStillHasAppliedPatches` 的「`findAiBase()` 返回空 → 当作还在」，只有根本没装宿主的机器才走得到（本机装了 DSH，把 `DSH_BASE` 指到不存在的目录，`findAiBaseWeb()` 仍会回落到 npm 全局根）。改坏的表现是「启动时该重打的不重打 / 不该重打的反复重打重启」。
13. **自动续跑的判据已钉住，真跑一轮 agent 的那一层没有。** `test-continue-retry.mjs` 的 44 条用例覆盖失败分类、预算与失败连击、配置合并、以及「什么时候不许替用户说话」（agent 还在跑 / 收件箱有货 / 刚有真人说话 / dispose 之后），`lib/continue-retry.js` 行覆盖 23% → 97%。没覆盖的是：`agent/request-error` 真的由宿主抛出来、`agent/status: idle` 真的在 280ms 后到、`followup` 真的把消息塞进队列。另有一处内部实现不可观测：`resetIfCompleted` 里 `cur.failStreak = 0; cur.failedSeqs = undefined;` 这两行是冗余的（紧接着 `this.reset(sessionId)` 会整条删掉会话记录），单独改掉它们对外部行为没有影响，RED 演练里这一改是 GREEN，用例里已写明，钉的是对外语义而不是这两行。改坏的表现是「一次网络抖动就把任务停在那里」或「用户还在打字，插件先替他发了一条」。
14. **角色稿的解析与落地已钉住，真宿主里的领消息事件没有。** `test-role-section.mjs` 的 23 条用例覆盖标签解析、文本抽取、`current` 的路径校验、稿件读取与钩子安装（`lib/redteam/role-section.js` 行覆盖 21% → 94%）。没覆盖的是宿主真的派发 `agent/inbox/claimed`、以及 `setTimeout(800)` 那次补装（用来兜住 effect 晚于首次领消息的情况）。另有两处防御在公开 API 上不可达、删掉外部行为也不变：`currentEngagementId()` 里「`agents/` 必须存在」与 `readRoleFile()` 里对 role 的二次校验——RED 演练里这两条是 GREEN，用例里已写明，不当成守卫。改坏的表现是「子会话拿着别人的角色稿干活」或「提示词里少一段角色说明」。

---

## 维护约定

- 补一行时，`守卫` 列必须写**能跑的东西**（脚本名或 npm 命令），不要写「已测试」。
- 覆盖率列用 `npm run test:full` 的实测值，别抄上次的。
- 从 `❗缺` 里挑活时，优先挑「改坏了没人能发现且用户能感知」的：第三节（提示词注入）与第四节的 HTTP 路由，排在计分口径前面——因为前者影响每一轮对话，后者只在打开演练台时影响。
