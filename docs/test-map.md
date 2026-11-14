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
| 宿主版本兼容判定（major.minor.patch.pre 全等） | `lib/core.js` `hostCompat`，被 `host:status` 间接覆盖 | `lib/core.js` 49% |
| 探测真宿主树、排除 Electron 外壳依赖树 | `test-host-baseline.mjs`（`looksLikeHostTree` / `resolveAiBase`） | —（同上） |
| 宿主树与本机主目录的定位链（`isAiBase` 判据、10 项候选表、pnpm 布局、profiles、`DSH_HOME` 优先级） | `test-host-locate.mjs`（34 条：判据 6 / pnpm 9 / 候选表 4 / walk 2 / `findAiBaseFromDshHome` 5 / 主目录 4 / 平台 4） | `lib/core.js` 81.7% |
| 判错时不报错：打到 Electron 外壳那份树（全场 `no-file`）、或把 `~/.dsh` 当成桌面版在用的 `dsh-home` | 同上（候选表逐项顺序 + `portableHomeFromLauncher` 顺序 + `desktopDshHomeGuesses` 三平台） | 同上 |
| `.dshpurge.bak` 是官方原文、不是我们的补丁 | `test-host-contract.mjs`（`readHostSource` 优先读 bak） | — |
| 契约缺项时 `host:status` 的 verdict 必须是 `broken` | `test-host-contract.mjs`（`mergeVerdicts` 六种组合） | — |
| 状态戳说「已应用」但宿主树上没有注入标记 → 必须 `broken`，不许报「补丁仍站得住」 | `test-host-baseline.mjs`（`auditStampVsTree` 9 条） | `scripts/` 不计覆盖率 |
| 找不到宿主根时单列 `unknown-base`，绝不判成补丁丢失（#59） | 同上 | 同上 |
| 补丁从 `settled` 掉成 `would-apply`（=没打）必须算失效，79 条全掉要一条不漏 | `test-host-baseline.mjs`（`diffSnapshots` 6 条） | 同上 |
| 两类失效分行显示：「重打即可」与「要改 pattern」，修法不同不能混 | `test-host-baseline.mjs`（`renderDiff` 2 条） | 同上 |
| 旁路副本上重打 86 条补丁，结果与 `docs/host-baseline.json` 逐字节一致（59 个文件） | `npm run host:sandbox`（`scripts/sandbox-apply.mjs`） | `scripts/` 不计覆盖率 |
| 包清单从 `targetFiles()` 推出来，不写死包名 —— 宿主加包/改路径时自动跟上 | `test-sandbox-apply.mjs`（`packagesFromTargetFiles` 7 条） | 同上 |
| 沙盒目录必须在仓库内、且不与真宿主/`$DSH_HOME` 重叠（「旁路」不能是假的） | `test-sandbox-apply.mjs`（`isSafeSandboxDir` 6 条） | 同上 |
| 升级前预演：把目标版本装进隔离目录，逐条试锚点，报出「这次升级会打坏哪几条」 | `npm run host:preview`（`scripts/host-preview.mjs`） | `scripts/` 不计覆盖率 |
| 预演归类：锚点被改掉才算「升级打断」；`no-file`/`na`/`skipped` 单列不适用，不吃掉告警 | `test-host-preview.mjs`（`classifyPreviewRow` 8 条） | 同上 |
| 结论只由「升级打断」触发：本来就坏的不算这次升级的账，空批量报 `no-data` 而不是「兼容」 | `test-host-preview.mjs`（`describePreview` 8 条） | 同上 |
| 预发布版本（rc/alpha/beta/pre/next）必须显式标出来，不许当成「升级就绪」 | `test-host-preview.mjs`（`isPrerelease` 4 条） | 同上 |
| 预演的四种归类各自计数，出现没见过的 kind 也照样累加不静默丢弃 | `test-host-preview.mjs`（`summarizePreview` 3 条） | 同上 |
| 补丁落点按「正在清洗的这棵树」判定，不按进程 surface 猜：桌面树里的 `pi-ai-*` 在 web 面也必须登记 | `test-display-targets.mjs`（`targetFiles` 落点 8 条） | `lib/core.js` 49% |
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
| 86 条补丁与拆分前快照的关系：id 与顺序不变、除 `replacements` 外每个字段逐字段相等 | `test-patch-registry.mjs`（3 条） | `lib/patches/*` 六个文件 **100%** |
| 既有 replacement 一字不改地排在前面，新形态只能追加在末尾；追加条数逐条等于登记值（`APPEND_ALLOWED`，多一条少一条都红） | `test-patch-registry.mjs`（`APPEND_ALLOWED` 6 条 + 形状 1 条） | 同上 |
| 拆分前那 239 个 replacement 在真实引擎上仍跑出相同结果（690 组 LF/CRLF/YAML 对拍，按「前缀裁剪」比，追加条目不参与） | `test-patch-registry.mjs` | 同上 |
| 0.2.2-rc.2 改过的六处锚点（`#13` 错误码 / `#18` 删 block 分支 / `#35` switch 重写 / `#62` `approvalDenial()` 两种排版 / `#56`+`#77` 被压成 minified）在真实 rc.2 窗口上打得动、打完幂等、marker 都在 | `test-patch-upgrade.mjs`（41 条，夹具来自 `patch-upgrade-fixtures.mjs` 的 7 段真实窗口） | `lib/patches/*` 同上 |
| 旧 pattern 打不动 rc.2 窗口（防「新 pattern 其实是照抄旧 pattern」） | `test-patch-upgrade.mjs`（7 条，逐条用拆分前快照的旧补丁跑同一段窗口） | — |
| minified 的 `client.js` 只能用块注释写 marker：单行 70 万字节里 `//` 会把后半行连同类定义一起注掉 | `test-patch-upgrade.mjs`（`#56`/`#77` 追加条目逐条查 `/*` 与 `//`） | — |
| minified 追加条目一律带 `insertProbe`，且 probe 打完必须在、原文必须不在（`skipIfMarked` 只能防「marker 还在」那种重复，marker 被冲掉就得靠它） | `test-patch-upgrade.mjs`（2 条） | — |
| 补丁 id 唯一、非空、是整数 | `check-metadata.mjs` / `test-verification.mjs` | — |
| 状态汇总优先级（`pending` > `unmatched` > `drifted` > 全 skip > `applied`） | `test-display-targets.mjs`（6 条，含「漂移压过已完成」「全跳过不报 applied」「未知状态退化 skipped」） | `lib/core.js` 49% |
| 显示分组（九个组、组内 lead 取最小 id、无组补丁自成一行、只适配桌面的补丁不进 web 面、`na` 与缺状态不进行） | `test-display-targets.mjs`（7 条，含「分组 id 必须真实存在且不跨组」） | `lib/core.js` 49% |
| 面板计数（`tallyDisplayPatches`：跳过同时进 skipped 与 ready、漂移不算就绪、`status`/`st` 双字段名） | `test-display-targets.mjs`（4 条） | `lib/core.js` 49% |
| 补丁对宿主文件的落点（`targetFiles`）：只登记真实存在的文件、落空键整个删掉、嵌套布局四个 `-nested` 键、`dshHome` 下用户预设与演练台依赖、不跨宿主面收 profile、不登记用户自己的 `cordis.patch.yml` 层 | `test-display-targets.mjs`（9 条，假 aiBase 树 + 临时 dshHome） | `lib/core.js` 49% / `lib/surface.js` 94% |
| 补丁状态的汇总口径：写错误 > 严格补丁失配 > **漂移压过「已打上」** > 已打上 > 已落盘 > 全缺 > 跳过（多文件补丁里一个成功一个失效，必须报 `drifted`） | `test-patch-outcomes.mjs`（`rollupPatchStatus` 6 条） | `lib/core.js` 49% |
| 「能不能 Apply」与「显不显示就绪」两套判据一致：`drifted` 恒不阻断 Apply、`skipped` 只对可选/自标记型软成功、`strictFiles` 让 `optional` 失效、`hit_count_mismatch:` 只对可选补丁软成功、`na` 不算就绪 | `test-patch-outcomes.mjs`（`isPatchResultSoftOk` 9 条 + `patchStatusReady` 4 条） | 同上 |
| 多宿主合并取最差状态、`id` 规范成 `patch_id`、未知状态按最差处理、同 rank 保留先出现的行；报告按软/硬分成两组 | `test-patch-outcomes.mjs`（`mergeApplyReports` 3 条 + `summarizeApplyReport` 2 条） | 同上 |
| 写盘分支的四种结局：原文命中→写入、原文不在→漂移、`strictFiles`→`pattern_not_found`、`softFiles` 与自标记型→`self_marked`；`surfaces` 不含当前面→`na` 且不碰文件 | `test-patch-outcomes.mjs`（`applyPatches` 前 6 条） | 同上 |
| `expect` 命中数是硬契约：官方同名代码多一处/少一处时整条拒写、原文一字未改，状态里带实际/期望计数 | `test-patch-outcomes.mjs`（`hit_count_mismatch:#9007:2/1`） | 同上 |
| `deleteOnly` 补丁原文还在→`applied`、原文不在→`already`；多文件键一个命中一个不中→整体 `drifted` | `test-patch-outcomes.mjs`（2 条） | 同上 |
| YAML 落点在写盘时顺带净化折叠块，`replace` 是 no-op 时靠净化也判写入；`preserveClientBundles` 只统计不写 `client.js` | `test-patch-outcomes.mjs`（3 条） | 同上 |
| `patchStatus` 六态（pending / drifted / skipped / na / missing_file / 非普通文件按落空处理），且对全部 86 条真补丁跑一遍不抛 | `test-patch-outcomes.mjs`（5 条） | 同上 |
| 宿主版本比对：三段版本 + 预发布后缀保留原大小写、解析不了返回 null、名字含 purge 的包不当宿主、预发布后缀必须原样相等、空目标回 `known:false/ok:null` | `test-patch-outcomes.mjs`（`parseHostVersion` 3 条 + `readHostVersion`/`hostCompat` 6 条） | 同上 |
| YAML 折叠块净化只碰含样板块的五个键（`personaPrefix`/`prefix`/`persona`/`text`/`suffix`）：整块样板压成空串、混排转字面块、普通折叠块一字不动、五类样板都能认、孤儿空标量的残段被摘掉、CRLF 保持 | `test-patch-outcomes.mjs`（`sanitizeYamlPersonaScalars` 10 条） | 同上 |
| 净化必须幂等：`applyPatches` 会顺手净化仓库自己的 `cordis.patch.yml`，跑一次测试就改掉仓库文件是不可接受的 | `test-patch-outcomes.mjs` 收尾断言（字节比对，不幂等直接抛） | — |

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
| 注入正文的读盘缓存 `refreshHungOperator`（home / mtime / 提交版本四元组命中时返回同一对象、`prompt-inject.md` 先写好则记 `source:"prompt"`、`rememberCommittedOverride` 改版本立刻失效、连续重算超阈值就打日志而不是继续算） | `test-prompt-source.mjs`（6 条） | `lib/prompt-source.js` 89% |
| 进程内注入兜底 `installHungPromptGlobal`（四档 `refresh → hung → disk → sealed` 依次降级、重入深度保护、单次慢调用超 1500ms 进 30 秒冷却，`globalThis.__dshPurgeHungPrompt` 挂的是同一个函数） | `test-prompt-source.mjs`（3 条，含四档顺序与两个阈值的源码断言） | 同上 |
| 提示词分段注册 `registerPromptSections`（默认 `dsh-purge@-100000` + `dshpg-capabilities@-99999`、`interpolate:false`、`capabilityProtocol:false` 只挂一段、`postPrompt` 挂第三段 `dsh-purge:post@7`、非法的 `postPromptOrder` 只警告并跳过、`already registered` 不算失败、多段全抛时抛最后一个） | `test-prompt-source.mjs`（9 条） | 同上 |
| 注入快照与闸门 `injectSnapshot` / `rejectIfNeedPrompt` / `ensureRestartReady`（快照三字段形状、空提示词时回 `needPrompt:true` 与固定文案、重启前先问 `core.ensureHostClean()`） | `test-prompt-source.mjs`（8 条，含文案与形状的源码断言） | 同上 |
| 装配决策输入 `shouldInjectAssembly` / `readSessionEvents`（默认 full/general、只有 `origin:"subagent"` 算子会话、续跑标记只消费一次变 `lastRole:"retry"`、事件优先 `snapshotEvents` 抛错退 `events` 再兜 `[]`） | `test-prompt-source.mjs`（8 条） | 同上 |
| 诊断日志 `purgeLog` / `logAssembleDecision`（`ISO [tag] k=v` 单行、值里的空白换 `_`、`undefined` 写空、对象写 `[object_Object]`、超 2MB 翻滚成 `.1`、装配决策固定四字段） | `test-prompt-source.mjs`（5 条） | 同上 |
| mnemon 插件消息剥离 `installMnemonMessageStrip`（没 `ctx.on` 不落标记、装一次挂一条带 `global+prepend`、重复安装被标记挡住、`mounted` 闸让微任务补挂只补一次且 1500ms 迟到重试不叠第二层、没滤掉返回同一对象、`messages` 不是数组也补成 `[]`、`stripMnemon:false` 一条都不滤） | `test-inject-write.mjs`（12 条） | `lib/inject-write.js` 96% |
| 每轮装配改写 `rewriteLiveAssembly`（默认段序 `dsh-purge`→`dshpg-capabilities`→原段→`deployment:persona-suffix`→`dsh-purge:anchor`、`enabled:false` 只挂 3 段、`stripMnemon:false` 保留 `mnemon-memory`、`anchorMode:"off"` 去掉锚点段） | `test-inject-write.mjs`（4 条） | 同上 |
| 改写缓存的签名覆盖面（`policy` 从 `fallback` 变 `strict` 变 `always` 每次都必须重算、`revision` / `session` 参与签名、命中判定必须比 `undefined` 不能真值判断、换 assembled 对象不复用、cwd 落 `last-cwd.txt`） | `test-inject-write.mjs`（5 条，含 `if (cached !== undefined) return cached;` 的源码断言） | 同上 |
| 装配诊断行 20 个字段（字段顺序固定、`afterCloser` 必须是正数、`anchorApplied` 默认 `true` 关掉锚点时 `false` 且 `injectTail:false`、`chatml` 命中 `<project_instructions>`、`injectBytes` 万级） | `test-inject-write.mjs`（3 条） | 同上 |
| `closerFollowBytes`（闭标记之后还剩多少字：没有段/没有标记一律 `-1`、多段先按空行拼、闭标记出现多次按**最后**一次算、空段被 filter 掉） | `test-inject-write.mjs`（4 条） | 同上 |
| 装配挂载 `installIdentityOverride`（4 类钩子与 `global/prepend` 选项、`__dshPurgeDisabled` 停用立即生效、有 next 用下游结果而下游抛错退回上游、旧签名自己动手、`next` 取最后一个参数不是 `args[2]`、guard 内层抛错给空装配、`prepareAssemble` 幂等且隔离层补分段与锚点、`guard.wrap` 签名不变不刷日志、cleanup 清六个 flag 且能重装、400ms 轮询必须 unref） | `test-inject-write.mjs`（15 条） | 同上 |

**本轮的进展**：注入决策树原来埋在 `rewriteLiveAssembly` 里，只有真正跑起宿主才走得到，改错了没有任何红字。现已抽成 `lib/identity.js` 的 `decideInject`（纯函数，逐行比对过抽取前后行为一致），由 `test-prompt-inject.mjs` 的 31 条用例钉住；缓存签名与命中规则抽成 `lib/live-cache.js`（`liveCacheSignature` / `sessionKeyOf` / `createLiveCache`），由 `test-live-cache.mjs` 的 37 条用例钉住，且拆分前后 2304 组输入的签名逐字对拍一致（`.tmp-exp/sig-parity.mjs`，一次性）。规则集读写（含备份与恢复的三条分支）已由 `test-rules-store.mjs` 的 30 条用例钉住——这组最怕的是「用户手写的 AGENTS.md 被另一条规则的内容悄悄盖掉」，因此备份/恢复的每个分支都单独立了用例。 这一轮补的是 `lib/identity.js`：它原来只有 69% 行覆盖，`installAssembleGuard` 整块（`lib/identity.js:904-1018`）与身份覆盖、红队操作稿、预设继承全都没有守卫，改坏了的表现是「注入没生效但也不报错」。现由 `test-identity-assembly.mjs` 的 141 条用例钉住，行覆盖 69% → 99%（`375-376` 的正则永不抛、`withOwnServers` 的两条因 `lib/net-scope.js` 的 `ownServerNote()` 恒空而不可达、`decideInject` 由 `test-prompt-inject.mjs` 覆盖、`rewritePromptAssembly:1090-1099` 的兜底块在常规输入下不可达）。 这一轮另外两件事：一是把 `lib/redteam/store-core.js` 从 5429 行拆到 3832 行，计分三件套搬进 `lib/redteam/score-report.js`、元数据与阶段口径搬进 `lib/redteam/engagement-meta.js`，类里只留四个一行转发（详见第十节盲区 33 与 `MAINTENANCE.md` 的「巨型文件拆分」）；二是给行尾约定加了常驻守卫 `npm run check:eol` —— 起因是 `lib/redteam/score-report.js` 入库时被 git 的 `autocrlf` 压成 LF 而工作区是 CRLF，本地与 CI 都全绿、仓库里存的却是另一份字节。现在 `.gitattributes` 用 `* -text` 关掉全部转换，`scripts/check-eol.mjs` 查「文件内不许混行尾 / 已入库不许变 / 新文件符合同目录多数派」三件事，外加一条「索引 blob 与工作区只差行尾」的 autocrlf 指纹检测（这条第一版写错了、检测静默失效，靠负向验证才抓出来，见盲区 34）。

---

## 四、插件面（宿主直接读取）

| 能力 | 守卫 | 覆盖率 |
| --- | --- | --- |
| `name` / `inject` 能装配（写错 `pluginPackages` → 宿主退出码 1） | `test-plugin-surface.mjs` | `lib/index.js` 11% |
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
| 状态页的三个零件：`line()` 的三种记号（`✓` / `✗` / 中性点）与 `undefined` 走默认值、`fsExists()` 的真假/数组/非字符串/含 `\0` 路径、`renderStatus()` 输出末尾不带多余换行 | `test-status-render.mjs`（11 条） | `lib/status-render.js` 98% |
| 状态页每一段的有无：插件根缺失打叉、多落点标 `+N`、桌面 runtime 折叠成一行、`runtime_payload` 四态、`no_resources` 分支、asar 密封显形、宿主未适配时警告、`shim_scope` 三种说明 | `test-status-render.mjs`（18 条） | 同上 |
| 状态页的补丁汇总：`skipped` / `drifted` / `pending` 各自要不要在汇总行点名、明细行 `applied` 打勾而未知状态打中性点、未知 id 用 `patch-N` 兜底、`layer` 取 `提示词/Prompt` | `test-status-render.mjs`（9 条） | 同上 |
| 状态页的列宽与结构：文件清单名字列 22 宽、明细名字列 30 宽 / id 列 2 宽（用字面量空格 + 正则钉，不用 `padEnd` 拼期望值）、段间空行、纯函数不改入参 | `test-status-render.mjs`（2 条） | 同上 |
| 会话权限从哪取：直接挂载的 `permissionPresets` 优先于 `ctx.get`、只有 `set` 是函数才算服务、Cordis 的 Proxy 在两条路上都抛错时返回 null 而不是炸 | `test-session-access.mjs`（4 条） | `lib/session-access.js` 100% |
| 子会话继承哪一档权限：agents 注册表 → sessions 存储 → `header.permissionPreset` 三级回落，父会话找不到就回落空串（不钉全开） | `test-session-access.mjs`（5 条） | 同上 |
| 什么才算「新会话」可以钉全开：已经是 `danger-full-access`/`auto`/`custom` 的不动、`permission/preset` 事件多于一条（用户自己钉过）就不覆盖、非权限事件不挡 | `test-session-access.mjs`（5 条） | 同上 |
| 钉权限的落地：新会话置 `danger-full-access`、子会话置父的预设且不重复 set、`set` 抛错只打一行 `[dsh-purge] full-access pin:` 不炸宿主、装的时候补钉已有会话 | `test-session-access.mjs`（6 条） | 同上 |
| 权限钩子的装与拆：`session/created` 下一个微任务里钉、重复装拦在 `__dshPurgeFullPin` 上、dispose 解绑并清标记（漏清 = 热重载后永久失能）、`ctx.on` 抛错也继续装 | `test-session-access.mjs`（6 条） | 同上 |
| 工作目录捕获：`header.cwd` 去空白后写 `last-cwd.txt`、同值不重复写盘（`session/event` 每事件都触发）、空值不覆盖旧目录、换目录跟着改、装时扫已有会话 | `test-session-access.mjs`（7 条） | 同上 |
| cwd 钩子的装与拆：挂 `session/created` + `session/event` 两个、dispose 两个都摘掉并清 `__dshPurgeCwdCapture`、重复装只装一次 | `test-session-access.mjs`（3 条） | 同上 |
| rewind 派生消息过滤的**现状**：钩子挂得上、dispose 摘得干净，但 `rewind.wrapSessionDeriveMessages` 在 `lib/rewind.js` 里**不存在**，整段是空转（被 try/catch 吞掉）——不顺手补实现，只钉住「加了函数这条会红」 | `test-session-access.mjs`（5 条） | 同上 |
| 模块面与源码形状：8 个 export 名字固定（index.js 按名字 import）、三处 cleanup 都 `delete ctx.__dshPurge*`、cwd 走 `rules.writeLastCwd` 不自己拼路径 | `test-session-access.mjs`（3 条） | 同上 |
| `/rules` 五个子命令的落盘：`create` 建出 `.md` + `.json` 且别名缺省回显成 id、`use` 写进 `AGENTS.md` 并重算注入、`delete` 真删、`reset` 走 restored 路（有备份时还原原文）| `test-chat-rules-skills.mjs`（6 条） | `lib/chat-rules-skills.js` 97% |
| `/rules reset` 的另外两条路：激活前 AGENTS.md 不存在 → 无备份 → 内容与本条规则一致时**删掉文件**并报 `removed`；被人手改过 → 跳过并写进 `⚠ 跳过` 提示 | `test-chat-rules-skills.mjs`（2 条） | 同上 |
| `/rules` 的参数校验与别名：缺 id 只回用法不建目录、非法 target 点名「只能是 AGENTS.md 或 CLAUDE.md」、`ls/s/list`、`use/activate/u`、`create/new/c`、`delete/rm/d`、`reset/restore/还原` 六组别名各自都真的走到对应分支（不是落到 default 的 help） | `test-chat-rules-skills.mjs`（8 条） | 同上 |
| `/rules` 的两处现状锁定：`delete` 一个拼错的 id 也回 `✓ 已删除规则`（`rules.deleteRule` 吞 ENOENT，仍会重算一次注入）、`help`/`h`/未知子命令回同一份帮助 | `test-chat-rules-skills.mjs`（4 条） | 同上 |
| `/rules` 版式：空库给一句「暂无规则」、当前规则打 `▶` 与 `★ 当前`、名字与 id 相同时不重复括号、大小走 `formatSize`、无激活时目标行写 `(无激活)` | `test-chat-rules-skills.mjs`（5 条） | 同上 |
| `/skills` 的五个子命令：`create` 写出 `<id>/SKILL.md` 且描述缺省是 id、`import` 认文件夹并回显导入名、`delete` 删目录并把备份路径写成第二行（`$DSH_HOME` 展示形式，测试换回真目录校验存在性）、`ls/s/list` 与 `rm/d` 别名 | `test-chat-rules-skills.mjs`（10 条） | 同上 |
| `/skills` 的拒绝与报错：非 kebab-case 点名示例、缺 id 回用法、`import` 缺路径/路径不存在、`delete` 不存在的 id 报「删除失败」、`help`/未知子命令回同一份帮助且不碰目录 | `test-chat-rules-skills.mjs`（5 条） | 同上 |
| `/skills` 版式：空目录给一句「暂无用户 Skill」、正常条目带说明/大小/两个通道的调用方式、不可用打 `!` 并把 `error` 抄一行、两个通道都关掉时写「不可 /名称」「模型不可调」 | `test-chat-rules-skills.mjs`（4 条） | 同上 |
| 两条命令共用同一套 deps 约定：家目录走 `(deps.core \|\| core).findDshHome()`（写死会让测试打真宿主）、三处注入重算全走 `callRefreshHungOperator`、缺 `refreshHungOperator` 时静默跳过（行为侧 + 源码形状各一条） | `test-chat-rules-skills.mjs`（4 条） | 同上 |
| `/purge status` 与别名：无参数默认 status，`status` / `s` / `S` 都走同一分支，排版交给 `renderStatus`（不自己拼） | `test-chat-purge.mjs`（3 条） | `lib/chat-purge.js` 100% |
| `/purge apply` 的主线：按 `applyRuntimeEnv → clearDesktopLocateCache → gatherState` 顺序进场、宿主行 + 补丁行 + shim 行 + `cmd-flash=` 一行一行拼出来、`preserveClientBundles:false + forApply:true` 精确 deepEqual（开了 preserve 就等于 client.js 上的补丁只统计不写盘） | `test-chat-purge.mjs`（3 条） | 同上 |
| `/purge apply` 的四种状态记号：`applied`→`✓ 已清洗`、`already`→`- 已是最新`、`missing_file`→`⚠ 文件缺失`、其它→`✗ ${status}` 带原文 | `test-chat-purge.mjs`（1 条） | 同上 |
| `/purge apply` 的三个早退：解析宿主抛错回 `error` 且抄 `message`、拿不到 `aiBase` 回 `missingAiBaseMessage()`、空提示词闸门挡住时既不打补丁也不重算注入 | `test-chat-purge.mjs`（3 条） | 同上 |
| `/purge apply` 的收尾四分支：`planned.clean===false`→「清洗没有写进当前宿主，已取消重启」、`restarting===false && error`→原文、`restarting:true`→「正在重启」、`!complete`→「清洗没有完成」、其余→「补丁已经在宿主里」（漏一支就会把「没重启」说成「已就绪」） | `test-chat-purge.mjs`（1 条，四态顺序断言） | 同上 |
| `/purge apply` 的重启判据：`promptReady` 只认「失败项全是 `pattern_not_found`」（混进 `drifted` 就不算）、`hostWritten` 也认 `hostCleanMarkersPresent`、`hookDenyRestoreFailed` 非空时 `complete` 必须为 false、要重启时先 `markSettleRestart()`、`ctx` 原样透给 `scheduleApplyRestart` | `test-chat-purge.mjs`（5 条） | 同上 |
| `/purge apply` 的两个附带效果：解包出 asar 时写 unpacked 戳、有被 scrub 的 bin bak 时多一段 `Desktop in-bin .bak scrub` | `test-chat-purge.mjs`（2 条） | 同上 |
| `/purge revert` / `uninstall`：还原逐行 `✓ 已还原` + `⚠ 还原失败 p: e`、没有备份时补一句 `no patch backup`、没有 `ai_base` 时整段跳过；卸载的两种开场白（检测到/未检测到）+ override 删除行 + profile 移除行 + `ok:false` 时回 `error` | `test-chat-purge.mjs`（5 条） | 同上 |
| `/purge edit` 与 `/purge help`：注入文件不存在时先 `installOverride` 再打开并说明「新建」、打不开回 `error`（旧实现在这里假报 success）、`editOverride` 的 `error` 原样带出；`help`/`h`/未知子命令同一份帮助且列全六条 + `/rules` `/skills`，子命令大小写不敏感，`config` 参数当前不影响输出 | `test-chat-purge.mjs`（6 条） | 同上 |
| 插件能装配：假宿主提供 `webServer` 时 `apply()` 与全部 effect 工厂都不抛错（`ReferenceError` 会在这里露出来，`node --check` 抓不到） | `test-plugin-boot.mjs`（1 条） | `lib/index.js` 55% |
| 路由总数：16 条（13 条 exact + 3 条 prefix），并点名 `/dsh-purge/status` / `apply` / `revert` / `restart` 与 `/dsh-purge/rules` / `skills` / `skill`；`enabled:false` 时一条都不注册 | `test-plugin-boot.mjs`（2 条） | 同上 |
| 源码形状：`routeSpecs({...})` 的 deps 里每个名字都必须有来处（顶层 import、顶层声明、或函数形参），少一个就报名字 | `test-plugin-boot.mjs`（1 条） | 同上 |
| 装配顺序不被打断：`applyHostHooks` 仍被调用、skills/rules 两条 prefix 路由仍注册、exact 循环仍跑、`enabled:false` 仍提前 `return`（四条都由 boot 测试间接钉住） | `test-plugin-boot.mjs` + RED 演练 7/7 | 同上 |
| 启动自愈的早退：`life` 已 dispose 立刻 `skip:inactive`（连归档都不记）、`seed`/`heal` 抛错只记日志、`autoApplyOnStart` 不是 true 时按「宿主是否被动过」分两支、密封桌面等用户点应用 | `test-boot-settle.mjs`（4 条） | `lib/boot-settle.js` 100% |
| 补丁过期时的三条主分支：宿主已经够干净就只刷戳（`already-clean`）、官方升级后自愈（成功清标记+按面决定是否重启、失败保留标记好让下次再试）、普通自愈（成功强制保戳、失败不刷戳） | `test-boot-settle.mjs`（8 条） | 同上 |
| 普通自愈写完之后的重启判据：`needsFullQuit` 先置标、面不许重启就不重启、冷却期拦一次、已对齐不再重启、仍不对齐才重启且 `openBrowser:false`、抛错回 `restart-failed` | `test-boot-settle.mjs`（7 条） | 同上 |
| ctx 在 await 期间被 dispose 的两次拦截：`reapplyInstalled` 之后一次、`patchesMatchInstallStrict` 之后（重启前）再一次——只留前一次会在已 dispose 的 ctx 上发起重启（命中 `INACTIVE_EFFECT`） | `test-boot-settle.mjs`（2 条） | 同上 |
| `autoApply` 的九条出口：插件根找不到、hooksDeny 还原失败清单、cmd-flash 抛错与不完整、补丁齐了顺手补 shim、关掉时 `disabled`、写完后带 `:cmd_flash_incomplete`、外层 catch 回 `error:` | `test-boot-settle.mjs`（9 条） | 同上 |
| `scheduleApplyRestart`：不需要重启时连宿主都不问、密封包走 `restartSealedDesktopIfNeeded` 且 `asarSwap` 也算 restarting（ctx 必须透传，否则清不掉 Electron）、普通面原样透出、什么都不返回兜成 `restarting:true`、抛错回 `{restarting:false,error}` | `test-boot-settle.mjs`（5 条） | 同上 |
| `apply()` 的停用与重启用：`enabled:false` 清 6 个运行期钩子 + 把两个全局钩子换成空实现 + 置 `__dshPurgeDisabled`（隔离 loopCtx 上的 guard 一起失效）、重新启用时必须把 `__dshPurgeDisabled` 删掉 | `test-plugin-apply.mjs`（2 条） | 同上 |
| 启动时 `$DSH_HOME/.hung-disabled` 必须删掉（否则注入一直关着、状态页不报错） | `test-plugin-apply.mjs`（1 条） | 同上 |
| ctx 已 dispose 的三条早退：`watchContextLife` 报 inactive 立刻 return、登记 settleTimer 回收器失败时 `clearTimeout` 后 return、`applyHostHooks` 抛 inactive 时吞掉且不再注册 web server | `test-plugin-apply.mjs`（3 条，靠第几次 `ctx.effect` 抛错区分） | 同上 |
| `apply()` 一共登记 **12** 个 effect 工厂（少一个就等于泄漏一个定时器或闭包；`applyHostHooks` 内部那 8 个各登记一个） | `test-plugin-apply.mjs`（1 条） | 同上 |
| `watchWebTreeReady` 四条分支的对外读数：没有 connection → `/status` 503（唯一有可观察差异的一条）、服务缺失 → 走 `then` 的**失败回调**也是 mark → 200、非 thenable → 同步 mark → 200、起手必须 `webState.ready = false`（热重载复用旧 ready 会让第二次 inject 之前的 `/status` 说假话） | `test-plugin-apply.mjs`（4 条） | 同上 |
| 桌面自愈只在 `desktop` 面排程（`if (hostctl.currentSurface() === "desktop")` 守卫、整套启动路径只有一处 `setImmediate`、且必须在守卫之后）+ `/purge` 的 deps 里 `scheduleApplyRestart` 必须是 `bootSettle.scheduleApplyRestart`、rules 带 refresh 而 skills 不带 | `test-plugin-apply.mjs`（2 条源码形状） | 同上 |
| override 状态的读写与容错：坏 JSON / `null` / 缺文件都回 `{}`、顶层是数组也原样返回（只判 `typeof === "object"`，不判 `Array.isArray`）、写盘必须是紧凑 JSON 且**不带**结尾换行、`customized` 一律 `Boolean` 化、每次自定义都同时记 `hash` 与 `seedHash` | `test-override-state.mjs`（11 条） | `lib/core.js` 57% |
| 「这份正文算不算用户稿」的四道判据：只有 `PLUGIN_DEFAULT_MARKS` 三个标记**全中**才算插件血统（`<|im_start|>system:` / `<project_instructions>` / `Little Code Sauce`）、当前加密槽的 hash 不算用户稿、`seedHash` 命中的也不算（我们上次自己写的那份）、空稿一律不算 | `test-override-state.mjs`（9 条） | 同上 |
| `installOverride` 的两道闸与 force：第一道判用户自改、第二道是纵深防御（源码形状钉）、`force` 必须能强行刷回加密槽、落盘后必须把 state 一起刷新（`customized:false` + 两个 hash）、第二次调用回 `exists` 且不重写文件 | `test-override-state.mjs`（9 条） | 同上 |
| `commitOverrideOnApply` / `seedPromptInjectAtBoot` / `syncPromptInjectOnDiskSync` 三处的分支与记版本：用户稿必须落盘成 `saved_user`、盘上是用户稿时必须 `kept_user_custom` 不许覆盖、全新 home 走 `seed_default`、**每次提交都必须让 `committedOverrideRevision()` 变**（否则注入了新正文但缓存永不失效）、`refresh_default` 这条映射只能靠源码形状钉 | `test-override-state.mjs`（15 条） | 同上 |
| Windows 上「别弹控制台」这一簇：五个 `silence*` 在非 win32 一律早退 `skipped_not_win32` 且一个字节都不写；`stubDoctorSupervisor` 回 `{skipped:"not_win32"}`；**`silenceLiangshenPhase1Strip` / `silenceOfficialPhase1Strip` / `keepLiangshenOperatorPrompt` 没有平台闸门**（现状锁定，非 win32 也改盘） | `test-silence-flash.mjs`（6 条） | `lib/core.js` 69% |
| `worseLiangshenHit` 的 rank 表就是 `error`(0) < `pattern_miss`(1) < `missing`(2) < `patched`(3) < `already`(4)，逐个数值钉；由此产生的现状怪癖：`hit` 初值 `missing` 让 `patched`/`already` **永远显示不出来**；`patched` 但已改的文件会被保留 | `test-silence-flash.mjs`（5 条） | 同上 |
| custom-bash 的三条防线（marker 行 + `System32\|SysWOW64\|WindowsApps` 的 bash 判据 + `return resolved`）、只认 web 与 web-all 嵌套两处候选、写盘失败回 `error:` 前缀（`String(Error)` 自带 `Error: `） | `test-silence-flash.mjs`（4 条） | 同上 |
| phase1 的人设集合三级替换（10 项，含 `deployment:persona-suffix` / `persona-suffix`）、六选一 pattern 分支、`contexts` 与 `isAllowedMessage` 放行段还原、残留 keepAllMarker 行清理、CRLF 归一、`already` 的七个条件（源码形状） | `test-silence-flash.mjs`（11 条） | 同上 |
| official phase1 只放宽 `filter(section => PERSONA_SECTION_NAMES.has(...))`、`bootstrap.js` 也在候选、没有 `PERSONA_SECTION_NAMES` 时不动、已放宽的不改 | `test-silence-flash.mjs`（4 条） | 同上 |
| `liangshenPromptFilterText` 四支（已是新版 / 旧版换新版 / 裸 filter 换新版 / 其余原样）与 `keepLiangshenOperatorPrompt` 的三态（`marker + dshpg-` 算 already、只有 marker 不算、CRLF 写回保持 CRLF） | `test-silence-flash.mjs`（5 条） | 同上 |
| mnemon / subprocess / doctor / market 四簇的注入结果：`resolveGitBranch` 换成读 `.git` + `for (let i = 0; i < 64; i++)` + `//#region` 保住、**replacement 里没有 marker 所以二次调用必回 `pattern_miss`**、stdio 块后补 `windowsHide: true`、doctor 三处（spawn 包装 / `dshSpawnSpec` 改走 node bin.js / stdio 不 inherit）、market 的 import 补 `existsSync`+`dirname` 与 respawn 改走 node bin.js | `test-silence-flash.mjs`（11 条） | 同上 |
| `silenceCmdFlash` 的返回结构（hide 段摊平 + 九段分项 + `ok`）与 `ok: hideOk && liangshenOk && preflightOk` 三段合成、`liangshenOk` 只容忍四个值（源码形状——空 home 里两个输入恒在容忍清单内，行为用例测不出） | `test-silence-flash.mjs`（3 条） | 同上 |
| market 的 import 段必须**同时**看「缺 `existsSync`」与「有 `importNeedle`」两个条件（源码形状：少了后半段 `String.replace` 本就是无操作，行为等价） | `test-silence-flash.mjs`（1 条） | 同上 |
| `patchShim` 的三个入口守卫：无目录回 `{error:"no_shim_dir"}`（`""` / `null` / `undefined` 三种入参都算）、空目录三个 `missing` 且一个文件都不新建、键顺序固定 `dsh.cmd` → `dsh.ps1` → `dsh`（`SHIM_NAMES` 的顺序就是写盘顺序） | `test-shim-patch.mjs`（3 条） | `lib/core.js` 73.85% |
| 密封桌面目录短路：`DSH Desktop/host-commands/bin` 与 `DeepSeek Harness/runtime-commands/bin` 都回 `{skipped_sealed_desktop:true, scrubbed:[…]}`，**目录内容一字不动、不落 bak**；形状像密封但不是 `bin` 结尾的路径不短路 | `test-shim-patch.mjs`（4 条） | 同上 |
| `isTextShim` 的二进制判定：NUL 出现在偏移 300（超过只读的前 120 字节、仍在前 512 内）也算二进制、零字节文件算二进制、`Write-Host` 开头算二进制；`#` / `REM` / `@echo` / `#!` 四种开头算文本；`openSync` 抛错时按二进制跳过，不冒险往里写 | `test-shim-patch.mjs`（6 条） | 同上 |
| 注入与幂等：sh 启动器插在 shebang 之后、正文一字不动、bak 内容等于原文、二次调用回 `already_patched`（mtime 不变）且**不重建**被删掉的 bak | `test-shim-patch.mjs`（4 条） | 同上 |
| `dsh.cmd` 的两条分支（`isWindows` 是模块级常量，只能按真实平台断言）：Windows 上只剥不注入 —— 没注入回 `skipped_win_cmd`、已注入回 `stripped_win_cmd` 且剥完 `end` 行删掉、`begin` 行留着（现状锁定）；非 Windows 上照常注入并补 `@ECHO off` 兜底行（那条兜底只能源码形状钉，Windows 上走不到） | `test-shim-patch.mjs`（4 条） | 同上 |
| legacy 与剥离：`DSH_PERMISSION_MODE` 让 `shimInjectCurrent` 判假（已注入也重打，`begin` 计数变 2）、旧单行头整段换新块、`stripShimInject` 六形态（闭合块 begin 占位 / 旧头带关键字 / 旧头不带关键字 / 旧头之后不复位 / 未闭合整份原样返回 / 末行无换行只剩 begin）、悬空 begin 再打会变两个 begin（现状锁定，二次才 `already_patched`） | `test-shim-patch.mjs`（8 条） | 同上 |
| 符号链接与 module root：真链接写的是目标文件、链接仍是链接、bak 落在目标旁边；悬空链接先被 `isFile` 判 false 记 `missing`；`dsh-app-boot` 找不到时 **Windows 是「写完才发现」`error:module_root_lost`，非 Windows 是事前拦 `skipped_no_module_root` 且一字节不写、不落 bak** | `test-shim-patch.mjs`（4 条） | 同上 |
| 备份的四种结局：bak 已存在不覆盖（保留旧 bak）、`copyFile` 抛错记 `dsh#bak: "bak_failed:boom"` 但仍 `patched`、只读文件回 `error:…EPERM` 而 bak 已落好、密封目录的 bak 搬到 `$DSH_HOME/dsh-purge/shim-backups/` 且摘要吃路径（两个不同密封目录的同名启动器 bak 名不撞） | `test-shim-patch.mjs`（4 条） | 同上 |
| `listShimDirsForPatch` / `patchAllShims`：`DSH_SURFACE=desktop` 回 `[]` 且 `patchAllShims()` 回 `{}`、PATH 上的密封 `bin` 会被剔掉而普通 `bin` 会留下（前提校验后才断言）、结果里没有密封目录 | `test-shim-patch.mjs`（3 条） | 同上 |
| `shimFileStatus` 比 `shimIsPatched` 多认一个 `dsh-purge cli entry`（两个判据故意不一致，现状锁定）、读失败回 `original` 而不是抛 | `test-shim-patch.mjs`（3 条） | 同上 |
| 密封 bin 的自发现：`sealedRuntimeRoots`(5 产品目录 × APPDATA/LOCALAPPDATA × host-commands/runtime-commands) → `walkBinDirs` 递归 5 层找到 `bin` 就停 → `uniquePaths` → `isSealedRuntimeDir` 要求路径以 `/bin` 结尾且含 `/host-commands/` 或 `/runtime-commands/` 等标记；差一层深度或换一个产品名就整个扫不到 | `test-sanitize-runtimes.mjs`（3 条） | `lib/core.js` 75.5% / `lib/desktop.js` 63% |
| 只碰两类残留：`*.dshpurge.bak` 与名字里含 `.dshpurge.` 的中间产物；`notes.txt` / `dsh.bak` 一律不动（正则要求 `.dshpurge.` 出现在文件名里，写成 `dsh.1234.copytmp` 不会被当成垃圾） | `test-sanitize-runtimes.mjs`（3 条） | 同上 |
| 启动器 bak 的搬迁四态：外部不存在 → 拷到 `$DSH_HOME/dsh-purge/shim-backups/<name>.<20hex>.bak` 再删 in-bin（`relocated_bak` + `removed_in_bin_bak`）；外部已存在且 size 相等 → 直接删 in-bin（`external_bak_exists`）；size 不等 → in-bin 保留、外部不覆盖（`external_bak_stale` + `kept_in_bin_bak`）；拷贝抛错 → 同样保留（`relocate_failed` + `kept_in_bin_bak`） | `test-sanitize-runtimes.mjs`（5 条） | 同上 |
| 非启动器 bak 直接删（`deleted:`）；删不掉记 `delete_failed:`（用「目录冒充 `.dshpurge.bak`」造，Windows 上 `chmod 0o444` 反而不一定失败） | `test-sanitize-runtimes.mjs`（1 条） | 同上 |
| `.dshpurge.*` 中间产物直接删（`deleted_artifact:`）；删不掉记 `error:<name>:<err>`（用「目录冒充」造） | `test-sanitize-runtimes.mjs`（2 条） | 同上 |
| 搬完之后 in-bin 那份删不掉：`remove_failed:` 是**静默**的（只记一笔，不影响外部那份已搬好）—— 用 monkeypatch `fs.unlinkSync` 抛 EBUSY 造，把它改成 throw 会让 `sanitize` 整个中断 | `test-sanitize-runtimes.mjs`（1 条） | 同上 |
| `dsh.cmd` 的注入剥离：已注入才剥（回 `stripped_cmd_inject`）、剥完 `begin` 行留作占位而 `end` 与块体删掉、没注入一字不动；只读文件回 `error_strip_cmd:…EPERM`、文案与 `stripShimInject` 不同步时（首行文案改了）会永久剥不干净 | `test-sanitize-runtimes.mjs`（2 条） | 同上 |
| `readdirSync` 失败必须 `continue` 掉整个目录 —— 少了这行就会「读不到目录却照样改该目录的 `dsh.cmd`」，是把用户启动器改坏而报告里看不出异常的那条路 | `test-sanitize-runtimes.mjs`（1 条） | 同上 |
| 递归深度与去重：`host-commands/a/b/c/bin`（5 层内）能扫到、更深的扫不到；`walkBinDirs` 命中 `bin` 后 `return`，所以 `bin/inner/bin` 不会再被算成另一个目录 | `test-sanitize-runtimes.mjs`（2 条） | `lib/desktop.js` 63% |
| 报告聚合与顺序：每个密封目录一条 `{dir, cleaned}`、干净的目录不进报告、多个目录的顺序**不构成契约**（`readdirSync` 在 NTFS/ext4 上顺序不同，断言必须 `.sort()`）；大写后缀 `DSHPURGE.BAK` 走 `toLowerCase()` 认得出，但 `DSH` 不在 `SHIM_NAMES`（精确匹配）所以走 `deleted:` 而不是 `relocated:` | `test-sanitize-runtimes.mjs`（3 条） | 同上 |
| `patchShim` 遇到密封目录的短路：返回 `{skipped_sealed_desktop:true, scrubbed}`，`scrubbed` 只留 `dir` 与当前 shimDir 相等的那条；目录内容一字不动、不落 bak | `test-sanitize-runtimes.mjs`（1 条） | `lib/core.js` 75.5% |
| 备份的三种跳过与占位清理：目标不存在直接跳（不建空 bak）、用户配置层 `profiles/*/cordis.patch.yml` 记 `skippedUser` 不备份、`openSync(bak,"wx")` 撞 EEXIST 视为已有备份跳过；`atomicCopyFile` 失败时**必须删掉自己刚建的占位**，否则下次 revert 会把 0 字节当有效备份 | `test-backup-revert.mjs`（6 条） | `lib/core.js` 78.1% |
| 重启前的地板：清洗没写完不许重启 | 8 条（目录解析失败/缺目录/仍有 pending/有失败项/flash 回退/标记没写进全部宿主/前两道闸门/成功出口），逐条断文案与字段 | `lib/host-clean-floor.js` 98.6% |
| 密封桌面重启前的目录记忆与 asar 交接 | 6 条（缺 exe/缺 asar/asar 已不在/官方 exe 走官方重启器/其它走换名脚本/两条路都必须先落盘安装目录） | `lib/host-clean-floor.js` 98.6% |
| 重启前的地板：跨平台用例拆分 | 2 条（大小写去重跨平台 / 斜杠方向去重仅 Windows —— `path.normalize` 在 POSIX 上不折反斜杠） | `lib/host-clean-floor.js` 98.6% |
| `revertAll` 的五条判定：先补回缺失原件、`.bad` 残骸先清、`preserveClientBundles` 只跳过 client.js、0 字节 bak 改名 `.bad` 并记 `empty_backup`、**字节相同只 skip 且保留 bak**、没有 bak 时绝不删目标（#41） | `test-backup-revert.mjs`（10 条） | 同上 |
| `restoreFromBak` 的三态：0 字节 → `*_skipped_empty` 并改名 `.bad`、目标是符号链接 → `*_skipped_symlink` 并删 bak（#88：旧 bak 会写穿进新版本）、正常 → 拷回并删 bak | `test-backup-revert.mjs`（4 条） | 同上 |
| `revertShim` 的五态与优先级：外置 bak > bin 里的 legacy bak > 有注入就剥 > 文件不在 `missing` > 否则 `no_backup`；密封目录里遇到真符号链接要按**真身**算摘要名（否则永远找不到外置 bak） | `test-backup-revert.mjs`（8 条） | 同上 |
| `refreshStaleBaksForUpgrade` 的六种跳过（用户配置层 / 字节相同 / 含 `dsh-purge` / 该路径任一补丁 marker 命中 / 原文件 0 字节 / 深度超限）：返回的是**原文件**路径不是 bak 路径；递归到第 8 层还扫、第 9 层停 | `test-backup-revert.mjs`（6 条） | 同上 |
| `restoreMissingOriginalsFromBak` 四态 + 六个位置：只补「原文件缺失或 0 字节」的、`stat` 抛非 ENOENT 时住手（EACCES ≠ 缺失）、`aiBase` 不是目录时连 `files` 都不碰、同一路径只处理一次；扫描位置含 `src/client.js` | `test-backup-revert.mjs`（6 条） | 同上 |
| `sameFileBytes` 比的是**内容**不是大小（`AAAA` / `BBBB` 同为 4 字节必须判不同）；`atomicCopyFileSync` 失败时 `.copytmp` 必须清掉 | `test-backup-revert.mjs`（3 条） | 同上 |
| 沙箱必须钉住 `npm_config_prefix`：只改 `PATH` 时 `findNpmPrefix()` 会退到 `npm prefix -g` 读回本机真实的 `%APPDATA%\npm`，测试就会去改用户的启动器 | `test-backup-revert.mjs`（`sandbox()` 里一行） | 同上 |
| 预演结论的四个纯函数：apply 行分桶（`drifted` 在预演里是 blocking 而在 apply 里是 soft-ok）、七态 outcome 定级、五态 behaviour 定级、卡点缺口计数；只有 warn 时 `ok` 仍为真 | `test-rehearse-lib.mjs`（共 59 条） | `rehearse-lib.mjs` 全绿 |
| 两个词表跨模块对齐：`STATE_LIST` 与 `BEHAVIOR_STATE_LIST` 必须与 `rehearse-lib` 的判定表逐状态一致 —— 上游新增一个状态时判定会静默变绿，靠这两条让改动在 CI 上直接炸 | `test-rehearse-lib.mjs`（2 条） | 同上 |
| 第五步 gates：`docs/patch-gates.json` 还描不描述这棵树。表 pin 在同一版掉针是 **blocking**（表与树互相矛盾），跨版掉针只是 warn（漂移，条数就是 bump `dshTarget` 时的重推量），`unreadable` 单列（这棵树里没那个文件，比如桌面壳） | `test-gate-verify-lib.mjs`（13 条）+ `test-rehearse-lib.mjs`（6 条） | 仅 `scripts/`，不进覆盖率基线 |
| 四步证据各自的定级：apply 只看 blocking、outcome 里 `pending/drifted/unknown` 必须为 0、behaviour 里 `broken/unexpected` 是红而 `inert` 只是黄、gate 的跨版降级；**不认识的枚举值按最坏算**，新状态默认成绿等于默认为安全 | `test-rehearse-lib.mjs`（6 条） | 同上 |
| `verify-target` 的判定层：每条补丁在这棵树上只有一个答案（na / no-file / would-apply / settled / drifted），`hitMismatch`、改完仍不完整、软键搬家、`deleteOnly` 的 self-marked 各走哪一支 | `test-verify-target-lib.mjs`（25 条） | 仅 `scripts/`，不进覆盖率基线 |
| 判定只能有一份：`scripts/verify-target.mjs` 里不许再出现 `patchApplied` / `remainingWork` / `matchesPattern` / `keysOfPatch` 这类平行实现（它们已经因为 #42 的 legacy 守卫而与 core 分叉） | 同上（源码形状） | 同上 |
| `officialRestartScript` 生成的 WSH 脚本文本：头部三行逐字（`var exe` / `var asar` / `var home`）、`taskkill.exe /F /PID` 两次且**没有** `/IM`（按 PID 杀而不是按镜像名）、`n < 80` 换名重试上限、`WScript.Sleep(45000)` 末尾等待（原来是 180s，让面板三分钟无响应） | `test-desktop-relaunch.mjs` | `lib/desktop.js` 71% |
| 现状锁定：脚本自带的中文注释让 `isWshAscii` 恒为 false → `planOfficialRestart` 永远选 `powershell`，`wscript` 那条分支在真机上**走不到**；反过来 `scriptAscii:true` 时必须选 `wscript` | `test-desktop-relaunch.mjs` | 同上 |
| `dshHomeForRelaunch` 六态：`""` / `"   "`（不 trim）/ 尾部分隔符被吃掉 / 已是 `.dsh` 原样 / 下一层有 `.dsh/profiles` 才加一层 / 只有 `.dsh` 没有 `profiles` 也原样 | `test-desktop-relaunch.mjs` | 同上 |
| `helperEnv` 三条：删 `DSH_PERMISSION_MODE`（不动 `process.env` 本身）、runner 名含 `node` 就不设 `ELECTRON_RUN_AS_NODE`（`""` / `null` 也算「不含」）、`DSH_PURGE_RESTART` 是 payload 的 JSON | `test-desktop-relaunch.mjs` | 同上 |
| `officialRestartLogState` 五态与「取最后一条 begin」：`begin` 后无收尾 = running、有 `started` = done、`not starting` / `rename failed` = aborted、日志不存在或 `sinceMs` 比 mtime 大 1s 以上 = none | `test-desktop-relaunch.mjs` | 同上 |
| `unpackedHostIsClean` 五态：identity+任一 inject 标记即干净、没有标记但也没有旧拦截也算干净、有旧 identity 行或 drops 就脏、两处文件一处脏整体脏、读不到（同名目录冒充）也脏 | `test-desktop-relaunch.mjs` | 同上 |
| `systemPromptFiles` 只认 `appDir` 下两条候选（`dsh/node_modules/...` 与 `node_modules/...`），exe 定位不到安装根就回空数组 | `test-desktop-relaunch.mjs` | 同上 |
| `cleanupLegacyRestartScripts` 只删 24h 前的 `dsh-purge-official-restart(?:-[0-9a-f-]+)?\.(js|cmd|log)`，新文件与无关名字一律不动 | `test-desktop-relaunch.mjs` | 同上 |
| 九个原本私有的帮手（`officialRestartScript` / `systemPromptFiles` / `dshHomeForRelaunch` / `officialExeFromProcess` / `helperEnv` / `helperNodePath` / `unpackedHostIsClean` / `officialRestartLogState` / `probeWshJsEngine`）加 `export` 才能被单独验；公开行为零变化 | `test-plugin-surface.mjs` 之外的导出面 | 同上 |
| `patchReplacements` / `matchesPattern` 只在 `lib/patch-outcome.mjs` 里定义一次：`scripts/verify-target-lib.mjs` 只做 `import` + 转出，源码形状断言钉住「这里不许再长出同名函数」（两份实现已经能从单数 `pattern` / `null` patch / 空串 pattern 三处分叉） | `test-verify-target-lib.mjs` | 仅 `scripts/` 与 `lib/patch-outcome.mjs`，后者 100% |
| 演练台报告链路（`hitTrace` / `scoreReport` / `scoreChain` / `representativeShots`）用真 `RedteamStore` + 临时目录播种，钉 `tunnelIsLegit` 与 `buildCurlCommand` 的 headers 两个真 bug；同时锁定五条读源码看不出来的现状（items 与 chain_no 顺序可不同 / scoreChain.stages 五段定长 / representativeShots 分层不影响先后 / 不挂资产不挂凭据 / 纯英文用户名不认领） | `test-score-report.mjs` | `lib/redteam/score-report.js` 行 1192 → **1457/1532**、`report-replay.js` 行 173 → **222/224** |
| 目标宿主声明与宿主版本门禁：`HOST_TARGETS` / `HOST_TARGET` / `hostCompat` 的 known·ok·host 三态、预发布后缀原样相等、`dshTargets` 含 `dshTarget` 且无重复、每一项都能被 `parseHostVersion` 解析 | `test-host-target-decl.mjs`（9 条）/ `test-package-integrity.mjs`（13 条） | `lib/core.js` 宿主门禁段 100% |
| 官方 CLI 三件套（`resources/runtime/cli/bin` 下的 `dsh` / `dsh.cmd` / `dsh.ps1`）：首装现场生成、已有就只打回退块、打完留 `.dsh-purge.bak`、`app/runtime` junction 指向 `../runtime` 且目标非空才回 `already` | `test-desktop-cli-repair.mjs` | `lib/desktop.js` 行 71% → **79.8%**（1624 → 1812 / 2273） |

**本轮进展**：`rules` / `skills` 两个分发器原来埋在 `lib/index.js` 的 89 + 39 行里，只跑得到「路由注册成功」这一层。现已抽到 `lib/http-routes.js`（243 行，8 个 export），`refreshHungOperator` / `injectSnapshot` 改为依赖注入传入——因为它们依赖 index.js 模块内的读盘状态，硬搬会把整个 index.js 拖进测试。抽取前后做了一次归一化逐字对拍（`PARITY OK identical after normalization; chars 9368`），行为零变化。由 `test-http-routes.mjs` 的 52 条用例钉住，覆盖 99% 行 / 100% 分支。

**2026-11-13 补**：状态页渲染（`fsExists` / `line` / `renderStatus`，92 行）也从 `lib/index.js` 抽到了 `lib/status-render.js`（99 行，3 个 export）。理由是它属于「改坏了用户立刻看得见但不会报错」的那一类：列宽错位、`skipped` 不点名、asar 密封不显形，全都只在人眼看状态页时才发现。抽取前后用 18 个 state 变体 + 11 个探针函数逐字节对拍（`renderStatus variants: checked 18, identical 18` / `fsExists/line probes identical: 11/11`），行为零变化。`lib/index.js` 1902 → 1809 行，被 40 条用例钉住，覆盖 98% 行。它那 206 → 203 的行命中下降已用 hunk 行号映射逐行证明是「搬走的行 + 删掉的 import」，幸存行零丢失（`mapped & verified 202, mismatches 0`）。

**2026-11-13 再补**：会话权限钉死 + cwd 捕获 + rewind 派生过滤这 148 行从 `lib/index.js` 抽到了 `lib/session-access.js`（8 个 export）。挑它的理由是「坏了不报错」——权限芯片从完全访问掉成 workspace-write、工作目录没被记住，都只在用户手感里出现。抽取用锚点定位整段搬运，去掉 `export ` 前缀后与备份逐字比对 `diffs 0`，`lib/index.js` 1809 → 1665 行。新增 47 条用例（假 ctx + 临时 `DSH_HOME`，不碰真宿主），RED 演练 21 条注入 **21/21 全红**。`lib/index.js` 的行命中 203 → 198 已精确记账：被删掉的命中行 10 条、新 import 命中 5 条、幸存行命中 193→193 零丢失，`203 - 10 + 5 = 198`。

**2026-11-13 三补**：`/rules` 与 `/skills` 两条聊天命令（211 行）从 `lib/index.js` 抽到了 `lib/chat-rules-skills.js`（230 行，5 个 export）。这两条命令会直接改 `AGENTS.md` / `CLAUDE.md` 与 `$DSH_HOME/skills`，判错的表现是「回了 success 但目标文件没变」「删错了同名规则」——都不报错。只动三处接线（家目录来源、三处 `refreshHungOperator` 改走 `callRefreshHungOperator(deps, dshHome)`、注入回调加函数类型守卫），其余逐行照抄（`block lines 211, diffs 0`），`lib/index.js` 1665 → 1459 行。新增 52 条用例（真 `lib/rules.js` + 真 `lib/skills.js`，只把 `DSH_HOME` 指到临时目录，测的是「命令 → 落盘」整条链），RED 演练 36 条注入 **36/36 全红**。`lib/index.js` 的行命中 198 → 196 已精确记账：被删掉的命中行 3 条（`1216` / `1308` / `1335`）、新 import 命中 1 条、幸存行零丢失（`mapped & verified 1453, mismatches 0`），`198 - 3 + 1 = 196`。

**2026-11-13 四补**：`/purge` 的六个分支（155 行）从 `lib/index.js` 抽到了 `lib/chat-purge.js`（169 行，1 个 export）。这是唯一一条「一条命令写穿宿主」的入口：apply 会改宿主包、打 shim、写 override 并请求重启，判错的表现是「回了 ✓ 已清洗但宿主没变」或者「清洗没完成却重启了」——两种都不报错，只在用户下次启动时才发现。八个依赖（`core` / `uninstaller` / `reapply` / `renderStatus` / `rejectIfNeedPrompt` / `refreshHungOperator` / `applyShouldRestart` / `scheduleApplyRestart`）全部按 deps 传入，其中 `scheduleApplyRestart` 是 `lib/index.js` 的模块私有函数（自己又依赖 `hostctl` 与 `core.restartSealedDesktopIfNeeded`），硬搬会把整个 index.js 拖进测试。函数体 154 行逐字照抄（`old body lines 154 / new body lines 154 / diffs 0`），`lib/index.js` 1459 → 1307 行。新增 30 条用例（假 `core` + 假 deps，纯内存、不碰宿主机），RED 演练 32 条注入 **32/32 全红**。这次 `lib/index.js` 的行命中 196 → 196 **完全没动**——被搬走的 155 行原本就是零命中段，所以不需要 hunk 记账。

**2026-11-13 五补**：注入正文本体的读盘/缓存/日志这一层（339 行，从 `injectAllowedNow` 到 `readInjectFallback`）从 `lib/index.js` 抽到了 `lib/prompt-source.js`（363 行，12 个 export）。挑它而不是先抽 `installIdentityOverride`，是因为后者依赖这 8 个函数——先把底座搬出来，下一步拆上层就不用把整个 index.js 拖进测试。这一层唯一碰宿主的地方是 `globalThis.__dshPurgeHungPrompt`，最容易测，但改坏了的表现是「注入正文变成旧的或空的」且不报错。函数体逐字照抄（`old block lines 339 / new block lines 339 / diffs 0`），`lib/index.js` 1307 → 974 行。新增 45 条用例（临时 `DSH_HOME` + 真 `lib/core.js` / `lib/rules.js`，不碰宿主），RED 演练 22 条注入 **22/22 全红**。`lib/index.js` 的行命中 196 → 166 已精确记账：被删掉的命中行 44 条、存活 152/152 零丢失、新 import 命中 14 条（`196 - 44 + 14 = 166`）。

**2026-11-13 六补**：注入到底有没有生效的最后一段执行路径（329 行）从 `lib/index.js` 抽到了 `lib/inject-write.js`（363 行，4 个 export）：mnemon 插件消息剥离、每轮装配改写（含缓存命中）、`closerFollowBytes` 诊断指标、`installIdentityOverride` 的四类钩子挂载。挑它的理由是这三处判错的表现全是「AI 行为变了但没有任何报错」——插件消息进了上下文、缓存把上一轮的注入套到这一轮、guard 挂不上导致注入真空。上一批先把它的 8 个私有依赖搬进了 `lib/prompt-source.js`，所以这次可以直接整段搬。函数体逐字照抄（`old body lines 329 / new body lines 329 / PARITY OK`），`lib/index.js` 974 → 631 行。新增 50 条用例（假 ctx + 假 prompt + 临时 `DSH_HOME`，不碰宿主），RED 演练 34 条注入 **34/34 全红**（第一轮 23/36，补了 9 条区分用例 + 修 2 条锚点后才全红，详见盲区 52）。`lib/index.js` 的行命中 166 → 145 已精确记账：被删掉的命中行 24 条、幸存 142/142 全中零丢失、新增命中 3 条（`166 - 24 + 3 = 145`，`lost: []`）。

**2026-11-13 七补**：上一批（六补）收窄 `lib/index.js` 对 `./prompt-source.js` 的具名 import 时，把 `ensureRestartReady` 误删了——`lib/index.js` 的 `routeSpecs({...})` deps 里还留着一个裸引用。后果不是「某条路由报错」，而是**宿主只要提供 `webServer`，`installWebServer` 的 effect 一跑就 `ReferenceError`**，整块插件面装不上。`node --check` 通过、2171 条测试全绿都抓不到，因为没有一条测试走到 `installWebServer`。

修法是把名字补回 import（`lib/index.js` 632 → 633 行），真正的价值在新增的 `scripts/test-plugin-boot.mjs`（4 条）：假 ctx 提供 `webServer` → 调 `plugin.apply(ctx, {})` → **同步跑一遍所有 effect 工厂并把返回的 disposer 立刻执行掉**（`apply()` 里有 `setTimeout(settleInstalledPatches, settleDelayMs(surface))`，同步 dispose 才能在定时器触发前撤掉，否则会真去读本机宿主包）→ 断言无抛错、16 条路由都注册上、`enabled:false` 时一条都不注册。另加一条源码形状断言：从 `routeSpecs({` 截到 `}))`，收集顶层 import 名、顶层声明名**与所有函数形参名**（第一版漏了形参，`ctx` 被误报），断言无缺失——它比 boot 测试失败得更早，也直接指出缺哪个名字。

实证（修前 vs 修后，同一份假 ctx）：`effectErrors: ["ReferenceError: ensureRestartReady is not defined"]` / `registeredRoutes: 0` → `effectErrors: []` / `registeredRoutes: 16`。RED 演练 7 条注入 **7/7 全红**（`ensureRestartReady` 再消失、`refreshHungOperator` 消失、deps 塞不存在的名字、`applyHostHooks` 不再被调用、skills prefix 路由不注册、exact 循环被跳过、`enabled:false` 不再提前 return）。

**教训**：抽取脚本收窄 import 时必须逐个 grep 被搬走的每个名字，确认「要么已 import、要么块外零引用」——`node --check` 只验语法，不验名字解析。

**2026-11-13 八补**：启动自愈这棵决策树（215 行，`shimNeedsPatch` / `currentSettleScope` / `settleInstalledPatches` / `autoApply` / `scheduleApplyRestart`）从 `lib/index.js` 抽到了 `lib/boot-settle.js`（246 行）。`lib/index.js` 633 → 429 行。

**2026-11-13 九补**：`apply()` 主体这 115 行（`lib/index.js` 188-302）在批53 之前一条测试都没有——它唯一的守卫是 `test-plugin-boot.mjs` 的「装得上不抛」，而「每个 if 走哪边」全是空的。这一批补了 `scripts/test-plugin-apply.mjs`（**18 条**），并把 `lib/index.js` 的行覆盖从 352 推到 **403/429（93.9%）**、函数 20→30、分支 44→67。

**这一批最有价值的两条不是行为断言，而是读数断言**：`watchWebTreeReady` 的四条分支里只有「没有 connection」会留在 503，其余三条在运行期全都等价于 200（`settled.then(onOk, mark)` 的**第二个参数就是 mark**，服务不齐也放行；非 thenable 会同步 mark；连 `42.then(...)` 抛出的 `TypeError` 都被外层 `catch { mark(); }` 接住）。所以「删掉非 thenable 的早退」不会让任何行为测试变红，只能靠 `/status` 的 503/200 读数 + 源码形状两条一起钉。

**RED 演练 18/18 全红**（第一轮 16 条里 11 红 / 4 绿 / 1 ANCHOR 0，改完断言后全红）。三处第一轮漏掉的都是同一个毛病——**断言写的是「不抛就算过」**：①「服务缺失也能 mark」原来只 `assert.ok(ctx.registered.length >= 0)`，永远真；②「非 thenable 要 mark」与「失败回调要 mark」在行为上不可区分，只能读源码；③「桌面面才自愈」在本机 `healOfficeSkillsRuntimeOnDisk()` 直接回 `{ok:true,healed:false}`，没有可观察差异。

**顺带确认的两个事实**：`ctx.specs` 在 effect 工厂跑之前是 0（路由是 effect 里注册的，所以必须先 `runEffects` 再断言）；`apply()` 之后 `ai_base` 落在 npm 全局那份 `AppData\Roaming\npm\...\@deepseek-ai`，与真实桌面宿主不是同一棵，但 `/status` 只回显、不影响本测试。

这一段是**唯一一段不能靠 import 兄弟模块来测的**：它每一步都要摸真宿主目录（`gatherState` / `purgeStateDir` 里的戳 / `desktopAsarStillSealed`），14 个 return 分支各只在真主机上出现几分之一秒。所以 `lib/boot-settle.js` 不 import 任何本项目模块，全部依赖由 `createBootSettle(deps)` 注入（`core` / `hostctl` / `reapply` / `officialUpdate` / `updater` 五个命名空间 + `settleMayReapply` / `settleMayRestart` 两个纯函数 + `log` + `setBootFullQuit`），五个函数作为返回值交出。这是本项目第一次用工厂注入而不是直接 import。

逐字对拍 `old 215 lines / new 215 lines` / `PARITY OK`（去块缩进 2 格 + `setBootFullQuit(true)` 还原成 `bootFullQuit = true`）。`scripts/test-boot-settle.mjs` **46 条**，RED 演练 **29/29 全红**。覆盖：`lib/boot-settle.js` 行 246/246、函数 9/9、分支 90/106（85%）。

写这一段时被现实纠正的五处：①`over` 覆盖的函数**不会进 base 的 `calls`**（`Object.assign` 只换属性，覆盖后调的是新函数），所以「官方升级清标记」只能断言 `filter(n => n.startsWith("clear"))`；②`String(new Error("no cmd"))` 是 `"Error: no cmd"`，日志断言要么写全要么用 `startsWith`；③自动更新那组必须让 `patchesMatchInstallStrict` 一开始就 true 才能走到 `autoApply` 分支（主分支末尾是 `restarting`）；④`scheduleApplyRestart` 密封包那条要闭包记 `seen` 才能验 ctx 透传；⑤「ctx 在对齐复核期间被 dispose」必须**计数到第二次** `patchesMatchInstallStrict` 才真的踩到重启前那道检查——第一次就置 dead 会停在 `reapplyInstalled` 之后那次早退，测出来的是另一条分支。

**2026-11-13 十补**：`lib/core.js` 的 override 簇（`lib/core.js:4779-5080`）原本**全部零命中** —— `overrideStatus` / `readOverrideStateSync` / `writeOverrideState` / `markOverrideCustomized` / `isUserCustomizedOverride*` / `readOverrideForUi` / `installOverride` / `commitOverrideOnApply` / `saveOverrideContent` / `editOverride` 一个都没被测过。这一簇是「提示词到底有没有被覆盖、Apply 会不会把用户稿冲掉」的唯一判据，改坏了只表现为「改了提示词但注入不变」，全程不报错。新增 `scripts/test-override-state.mjs`（**55 条**），把 `lib/core.js` 的行命中从 2887 推到 **3010/5274（57.1%）**、函数 231/327、分支 870/1181。全仓行覆盖 **83.60% → 83.93%**（`30532/36376`）。

RED 演练 `.tmp57-red.mjs` 用 `git show HEAD:lib/core.js` 当 BASE、29 条注入逐条跑，最终 **29/29 全红**、`restored byte-identical: true`。第一轮 24/29，四条 GREEN 的处置分两类：①「不认 `seedHash`」与「跳过第二道闸」是真的行为等价（另一道闸挡得住）→ 改成**源码形状断言**并在注释里写明「这是纵深防御，不是可观察行为」；②「commit 后不记版本」与「seed 分支不 remember」是真的漏了断言 → 补「`committedOverrideRevision()` 必须变」的用例。另修一条 `ANCHOR 2`：`markOverrideCustomized` 与 `syncPromptInjectOnDiskSync` 里各有一处 `seedHash:`，锚点必须带上前三行才唯一。

**这一批顺带修掉一个真 bug（在测试侧，不在生产代码里）**：`scripts/test-prompt-source.mjs` 的三条日志断言原先是 `readLog().trim().split("\n").pop()` —— 而日志文件是 `os.tmpdir()/dsh-purge-desktop.log`，全仓共用一份，`node --test` 又是并行跑各个 `test-*.mjs` 进程，于是「最后一行」经常是别的测试刚写进去的。跑 `npm run test:full` 时因此假红过三条（实际拿到 `[inject.read]` 与 `[guard.wrap]`）。修法是加 `lastTagged(tag)`：先按 `[tag]` 过滤再取最后一条。`scripts/test-inject-write.mjs` 用的是按文件 size 切片的 `logDelta(fn)`，不受影响。**教训：任何跨测试共享的旁路文件（日志、临时目录、端口）都不能用「最后一条」这种全局读法。**

**2026-11-13 十一补**：`lib/core.js` 的「静默子进程弹窗」簇（`silenceSubprocessLocalFlash` / `silenceLiangshenCustomBashFlash` / `silenceLiangshenPhase1Strip` / `silenceOfficialPhase1Strip` / `silenceMnemonGitFlash` / `silenceDoctorSpawnFlash` / `silenceDshmarketRestartFlash` / `stubDoctorSupervisor` / `liangshenPromptFilterText` / `keepLiangshenOperatorPrompt` / `worseLiangshenHit` / `listLiangshen*Files` / `listOfficialPhase1Files` / `listMnemonIndexFiles` / `listSubprocessLocalFiles` / `silenceCmdFlash`）原本**全部零命中**。这一簇的职责是「Windows 上别让子进程弹控制台、别落到 WSL 的 System32 bash、别让 dsh.cmd 经 cmd.exe 起进程」，改坏了的表现是**每轮对话闪一个黑框**（Windows 专属，CI 的 ubuntu 上根本看不见），或者干脆静默地什么都不做。新增 `scripts/test-silence-flash.mjs`（**51 条**），把 `lib/core.js` 的行命中从 3010 推到 **3653/5274（69.3%）**、函数 231→255（共 334）、分支 870→1034（共 1379）。全仓行覆盖 **83.93% → 85.70%**。

写这一段时被现实纠正的五处：①五个 `silence*` 有平台闸门、`silenceLiangshenPhase1Strip` / `silenceOfficialPhase1Strip` / `keepLiangshenOperatorPrompt` **没有**——「非 win32 一律不动盘」这个直觉只在五个上有，另三个在 Linux 上照样改文件（现状锁定，不是 bug）；②`silenceMnemonGitFlash` 的 `replacement` 里**没有** `marker`（只在判断里用），所以它打完一次后再跑永远回 `pattern_miss` 而不是 `already`；③`worseLiangshenHit` 的 rank 把 `missing`(2) 排在 `patched`(3) 之前，而 `hit` 初值就是 `missing`——**打上补丁的返回值永远显示不出来**，线上没影响只因为 `silenceCmdFlash` 的 `ok` 判据不看这个值；④`listLiangshenMinimalPromptFiles` 的候选一律用 `keepSurfaceFile`，所以 `keepLiangshenOperatorPrompt(nowhere)` 回的是 `pattern_miss` 不是 `missing`（七条候选路径都拼得出来，只是 `isFile` 全 false）；⑤`silenceSubprocessLocalFlash` 的 needle 在源码里是**字面 `\t`/`\n` 两字符转义**，fixture 必须逐字按源码拼，写「真 tab + 真换行」会被判 `missing`（不是 `pattern_miss`，因为 `listSubprocessLocalFiles` 先返回空）。

**RED 演练从 23 条里只红 13 条推到 23/23 全红**，靠的是三件事：①把锚点从「手写转义字符串」改成**按行定位**（`fnRange(name)` 只在目标函数区间内 `indexOf` 且要求恰好 1 处）—— 之前三条 ANCHOR MISS 全是转义层数写错，而且 `lib/core.js:549` 与 `:1294` 有**完全同字面**的 `spawnNeedle`，字符串锚点必错；②给 6 条「两条实现行为等价」的守卫补**源码形状断言**（phase1 的 7 个 already 条件、market 的 `&& next.includes(importNeedle)`、`silenceCmdFlash` 的 `ok: hideOk && liangshenOk && preflightOk` 与 `liangshenOk` 的四值清单）—— 空 home 里 `liangshenPrompt` 恒 `missing`、`preflight` 恒 `missing_bin`，两个都在容忍清单里，行为用例永远测不出；③补 5 条能真正区分两条实现的用例（phase1 别处残留的 keepAllMarker 行、keepOperator 的「只有 marker 没有 dshpg-」、keepOperator 的 CRLF 写回、`worseLiangshenHit` 的 rank 数值逐个钉）。

**两条测试自己写错、被现实纠正的地方值得单独记**：①`worseLiangshenHit` 的用例原来只钉「五个 `if` 的文本顺序」，把 `missing` 与 `patched` 的返回值互换（2↔3）文本顺序一点没变 → 改成 `deepEqual` 逐行钉数值；②CRLF 那条原来写 `KEEP_BARE + "\\r\\n"`，那会往文件里塞**反斜杠**而不是回车换行，`text.includes("\r\n")` 恒假、写回永远走 LF 那侧，等于什么都没测 → 改成真 `"\r\n"`。

**这一批还踩了一脚跨平台地雷，值得写进纪律**：推到 CI 后 **一次红 17 条**（`e3761ab`，run 43360375646，`ℹ fail 17`）。原因不在产品代码——`scripts/test-silence-flash.mjs` 里 18 条用例直接调五个 `silence*` 与 `stubDoctorSupervisor`，其中只有 3 条显式伪造了平台，剩下 15 条靠「开发机恰好是 Windows」通过。到 `ubuntu-latest` 上闸门早退 `skipped_not_win32`，目标文件一个字节没改，断言集体失败。绿的那批恰好就是**没有平台闸门**的三组（phase1 9 条、official 4 条、`liangshenPromptFilterText` 2 条、`keepLiangshenOperatorPrompt` 4 条），这直接指认了病因。修法：把这 15 条统一包 `asPlatform("win32", () => { … })`（外加带 `(t)` 形参的「写盘失败」那条改写成 `(t) => asPlatform(...)`），然后在本地跑 `node --import ./.tmp-linux-preload.mjs --test scripts/test-silence-flash.mjs` 确认 **51/51 依然全绿**。真 CI 上仍会有 2 条红是仿真边界造不出来的（NTFS 大小写不敏感、`chmod 0o444` 挡不住写入），属于预加载伪造不了文件系统语义，不是新问题。

**2026-11-13 十二补**：`lib/core.js` 的 shim 注入簇（`patchShim` / `patchAllShims` / `resolveShimWriteTarget` / `stripShimInject` / `insertShimInject` / `shimIsPatched` / `shimFileStatus` / `shimInjectCurrent` / `shimKindOf` / `shimInjectFor` / `shimBackupPath` / `stripWinCmdShim` / `isTextShim` / `listShimDirsForPatch`）原本**全部零命中**。这一簇改的是 `npm` 全局与各启动器目录里的 `dsh` / `dsh.ps1` / `dsh.cmd` —— 用户点开 DSH 走的就是这三个文件，改坏了的表现是「命令行起不来」「每次启动闪黑框」「升级后 shim 被覆盖成原版而插件静默失效」，三种都不报错。新增 `scripts/test-shim-patch.mjs`（**46 条**），把 `lib/core.js` 的行命中从 3653 推到 **3895/5274（73.85%）**、函数 255→268（共 335）、分支 1034→1146（共 1501）。全仓行覆盖 **85.70% → 86.37%**。

写这一段时被现实纠正的六处，都是「本机是 Windows 就以为能直接跑」：①**`lib/core.js:40` 的 `isWindows` 是模块级常量**，`asPlatform()` 改 `process.platform` 对它无效 —— `dsh.cmd` 的两条分支只能按真实平台写双分支断言（`IS_WINDOWS` 在测试顶层算一次），伪造平台反会把 `dsh.cmd` 走到 Linux 侧的注入路径上；②`isTextShim` 里 `if (slice.includes(0)) return false;`、`head.startsWith("# ")`、`head.startsWith("REM ")` **各出现两次**（`openSync` 兜底分支 + 正常分支），锚点必须传 `nth:1` 才打得到正常分支；③零字节文件不是「空文本」而是 `skipped_binary` —— `readSync` 读 0 字节，`head` 是空串，四个前缀一个都不满足；④`dsh.ps1` 里写 `Write-Host hi` 会被判成二进制（`isTextShim` 只认 `#` / `REM` / `@echo` / `#!` 四种开头，PowerShell 的自然写法不在内），要 `# ` 开头才会被注入；⑤悬空符号链接走不到 `error:symlink:` —— `patchShim` 先用 `isFile` 判，`isFile` 跟随后失败就直接 `missing`，`resolveShimWriteTarget` 里那个 `catch` 只有「链接能解析但 realpath 抛」才到得了；⑥只读文件那条在 NTFS 上是 **`rename` 报 EPERM**（不是 `write` 报），而且 **bak 已经落好**（备份在写之前），所以「写失败 = 什么都没发生」这个直觉是错的。

**RED 演练从 27 条里红 27 条推到 34/34 全红**（`{"restored":true,"total":34,"red":34,"green":0,"anchor":0}`），靠的是两件事：①把锚点全部改成**行定位**（`fnRange(name)` + `replaceLine(name, fromLine, toLine)` 整行替换）—— 之前三条 ANCHOR 全是缩进写错（`if (isDesktopCommandRuntimeDir(shimDir)) {` 是 2 格、`if (shimIsPatched(writeFp) || …)` 是 4 格），而 `lib/core.js:549` 与 `:1294` 有**完全同字面**的 `spawnNeedle`，字符串锚点必错；②三条「两条实现行为等价」的守卫补**源码形状断言**——「关块时不清 `blockStart`」（关块后 `inBlock` 已 false，末尾 `if (inBlock && blockStart >= 0)` 根本不看它）、「不再补 `@ECHO off`」（Windows 上走不到）、「不再过滤密封目录」（本机 PATH 上没有密封 bin，改成自己往 PATH 里塞一个再断言它被剔掉）。

**顺手修掉一个真 bug（在测试侧，不在生产代码里），和上一批同一个病根**：`npm run test:full` 首轮红了一条 `test-inject-write.mjs` 的 `guard.wrap` 计数（`1 !== 0`），单跑却全绿。根因仍是诊断日志 `os.tmpdir()/dsh-purge-desktop.log` **全仓共用一份** —— `logDelta()` 按「文件字节数前后差」切片，别的测试进程恰好在这期间写一行就混进本进程的 delta。上一批只修了「取最后一行」的写法，这一批发现按字节切片同样不安全。修法：在 **import 任何 lib 之前**把 `TEMP` / `TMP` / `TMPDIR` 指到本进程私有临时目录（`os.tmpdir()` 运行时会读 `process.env.TEMP`，实测改完立刻生效），于是 `lib/prompt-source.js` 模块加载时算出的 `PURGE_INTERNAL_LOG` 就是私有的；`scripts/test-inject-write.mjs` 与 `scripts/test-prompt-source.mjs` 两个文件都照此改，并把 `import` 语句改成 `await import()`（`import` 会被提升，必须先设 env）。**结论：任何跨进程共享的旁路文件（日志、临时目录、端口），要么给每个测试进程一个私有目录，要么别用它当断言依据 —— 只改读法是不够的。**

**还有一条本来会改真机的用例被删掉了**：`patchAllShims()` 会遍历 `listShimDirsForPatch()` 里每个真实目录（本机是 `%APPDATA%\npm`）逐个 `patchShim`，跑一次测试就等于重写用户的启动器。第一版写了这条「目录 → 结果映射」的用例，发现后删掉，原位留注释说明取舍：幂等不等于无副作用 —— 将来 `shimInjectFor` 的块文本一变，这条测试会静默重写用户启动器而测试仍绿。同一取舍也适用 `scripts/test-reapply-flows.mjs`。真机启动器另做了核对：摘掉注入块后正文与 `.dshpurge.bak` **逐字节相同**（`834 = 834` / `873 = 873`，`begin`/`end` 各 1 次），说明它处于「原文 + 一个标准注入块」的健康状态。

**2026-11-13 十三补**：`lib/core.js` 的密封 bin 清理簇（`scrubInBinBak` / `sanitizeDesktopCommandRuntimes` / `stripCmdInjectSync` / `listDesktopCommandRuntimeDirs` / `pathEnvDirs` / `collectDirs`，55 + 28 + 9 行）原本**几乎全部零命中**。这一簇只在卸载与重装时被调起，做一件事：把留在**桌面版密封安装目录**（`…/DSH Desktop/host-commands/bin`、`…/DeepSeek Harness/runtime-commands/bin`）里的 `.dshpurge.bak` 搬出安装目录。判错的两种表现都不报错 —— ①搬家失败时把 in-bin 那份删了，用户**永久失去启动器原文**（下次 `revert` 拿不回来）；②把 `.dshpurge.*` 中间产物当成普通文件漏删，安装目录被写脏，下次官方升级把脏文件一起打包进去。新增 `scripts/test-sanitize-runtimes.mjs`（**23 条**），把 `lib/core.js` 的行命中从 3895 推到 **3982/5274（75.5%）**、函数 268→271（共 335）、分支 1146→1180（共 1535）；`lib/desktop.js` 的行命中 1417 → **1431/2272（63%）**、分支 318→327（共 435）。全仓行覆盖 **86.37% → 86.65%**。

写这一段时被现实纠正的三处：①`dsh.1234.copytmp` 这种名字里没有 `.dshpurge.`，`sanitize` 的准入正则根本不看它 —— 中间产物必须写成 `dsh.dshpurge.1234.copytmp` 才进得了删除分支；②多个密封目录各出一条报告，**顺序按 `readdirSync` 返回顺序**（NTFS 名序 / ext4 哈希序），把它当作契约写 `deepEqual` 会在换一台机器时假红，必须 `.sort()` 后再比；③`test(...)` 的回调里写 `await` 却没加 `async` 会 `SyntaxError: Unexpected reserved word`，而 `node --check` 只在整文件层报，混在一堆用例里很难一眼看到。

**这一簇最难造的两个 fixture 都不是文件权限**：①`remove_failed:`（搬好之后 in-bin 那份删不掉）—— 用 `chmod 0o444` 造不出来（Windows 上目录项的删除权限来自父目录，`unlink` 照样成功；POSIX 上同理），用「目录冒充」也走不到这条分支，唯一稳定办法是 monkeypatch `fs.unlinkSync` 让它对特定文件名抛 `EBUSY`；②`delete_failed:` / `error:<name>` —— 用「目录冒充 `.dshpurge.bak`」最稳（`unlink` 对目录必 EPERM），因为「打开句柄占用文件」在 Windows 上**也拦不住 `unlink`**（实测：`fs.openSync(f,"r")` 后照样 `deleted:held.dshpurge.bak`）。

**RED 演练**：`.tmp61-drill.mjs` 同时改 `lib/core.js` 与 `lib/desktop.js` 两个文件（`ORIG[f] = git show HEAD:<f>` 分别取），18 条注入 → **18/18 全红**（`{"restored":true,"total":18,"red":18,"green":0,"anchor":0}`）。第一轮 14 红 / 2 绿 / 2 ANCHOR：两条 ANCHOR 都是缩进抄错（`delete_failed` 那行是 **6 格**；`} catch {` / `continue` / `}` 三行必须用 `replaceIn` 整段替换而不是 `replaceLine` 单行）；两条 GREEN 靠补用例转红 —— `walkBinDirs` 命中 `bin` 后不 `return` → 补「`bin/inner/bin` 不算另一个目录」；`readdirSync` 失败不 `continue` → 把 `dsh.cmd` 也放进 fixture，断言「读不到目录时里面任何文件都不许动」。另有一条 `scrub: 删 in-bin bak 失败时静默` 起初也是绿的，补 monkeypatch `unlinkSync` 抛 `EBUSY` 之后才红。

**顺手记一个跨目录协作的纪律**：这一簇的测试必须把 `APPDATA` / `LOCALAPPDATA` / `PATH` / `DSH_HOME` / `DSH_SURFACE` 五个环境变量**全部**指到沙箱再调 `core.resetPathMemo()` —— 只要漏一个，`sealedRuntimeRoots()` 就会扫到**真机**的密封安装目录，测试会把用户桌面上真正的 `.dshpurge.bak` 搬走或删掉。这不是理论风险：探针第一版只改了 `DSH_HOME`，`APPDATA` 还是真值，`listDesktopCommandRuntimeDirs()` 直接返回了本机那两条真路径。

**2026-11-13 十四补 / 十五补**：`lib/core.js` 的备份还原簇（`backupAll` / `revertAll` / `restoreFromBak` / `revertShim` / `revertAllShims` / `refreshStaleBaksForUpgrade` / `restoreMissingOriginalsFromBak`）与发版前的预演结论层（`scripts/rehearse-lib.mjs`）。补之前这一簇是全仓最空的地带：`backupAll` 36 行只命中 1 行、`restoreFromBak` 34 行零命中 —— 而它是「所有改动都能回退」这个承诺的唯一底座。它坏了的两种表现都不报错：①按已打补丁的版本建 bak，用户永远回不到官方原版；②把 0 字节占位当成有效备份，revert 直接把宿主文件清空。

写这一段时被现实纠正的六处，全是「把返回值的语义记反了」：①`restoreMissingOriginalsFromBak(aiBase, files)` 的 `files` 收的是**原文件**路径，不是 `.dshpurge.bak` 路径；②`refreshStaleBaksForUpgrade` 返回的也是**原文件**路径，不是它刷新的那个 bak；③「字节相同就跳过」时 **bak 保留不删** —— 只有真的拷回去才删；④`preserveClientBundles` 的 fixture 必须放在 `dsh/node_modules/@deepseek-ai/<pkg>/lib/client.js`，裸 `dsh-client-ui-conversation/lib/client.js` 会被 `isWatchedClientBundle` 判 false；⑤`backupAll` 用 `openSync` monkeypatch 造错时，锚点要精确到 `target === a + ".dshpurge.bak"`，用 `includes("index.js")` 会同时命中两个 fixture；⑥`revertShim` 的「三个启动器名字」不能塞进一条用例 —— 缺 bak 的那个自然回 `no_backup`，会把另外两个的断言带偏。

**RED 演练 63 条突变，最终 62 红 / 1 绿**（`{"restored":true,"total":63,"RED":62,"GREEN":1,"ANCHOR":0}`）。唯一那条绿是**等价突变**：`isUserProfilePatchFile` 的 `toLowerCase()` 冗余，因为正则本来就带 `/i`，已在 drill 里标成「已知等价项」。第一轮 41 红 / 16 绿 / 6 ANCHOR，16 条绿里有 10 条是靠补「带区分性的 fixture」转红的（深度 8 层 vs 9 层、`AAAA` vs `BBBB` 同为 4 字节、真 marker 命中的补丁路径、`src/client.js` 这个第六位置、重复路径去重、EACCES 与 ENOENT 的区别 ……），另外 5 条确认是**行为上不可区分**，改成源码形状断言（`!out.includes(p)` 去重、`readdirSync` 前的 `isDir` 前置、`revertAllShims` 里 `scrubDesktop:false` + 末尾统一扫一遍）。

**这一批最贵的一课不是测试写错，是测试改坏了真机**：`npm run test:full` 红在 `revertAllShims 在没有任何可回滚目录时回空对象`，实际拿到的是 `%APPDATA%\npm` 那一行 —— 因为沙箱只改了 `PATH`，而 `findNpmPrefix()` 在 PATH 上找不到启动器时会退到 `npmQuery(["prefix","-g"])` 去问 npm 自己，于是 `revertAllShims()` 遍历到了本机真实目录，把用户的 `dsh`（1214B → 834B）与 `dsh.ps1`（1310B → 873B）剥回未注入状态、还删掉了两份 bak。**修法是在 `sandbox()` 里把 `npm_config_prefix` 也指到沙箱**（实测 `npm_config_prefix=X npm prefix -g` 会听这个变量），改完跑前跑后真机五个文件的 SHA-256 一字不变。纪律已写进 `MAINTENANCE.md`：凡是要遍历 `listShimDirsForPatch()` / `findNpmPrefix()` / `listDesktopCommandRuntimeDirs()` 的测试，`PATH` / `APPDATA` / `LOCALAPPDATA` / `npm_config_prefix` 四个都得钉。

**十五补**补的是预演结论层（`scripts/rehearse-lib.mjs`，198 行纯函数，59 条）。它跟 `lib/core.js::isPatchResultSoftOk()` 的阈值**故意不同**：apply 在用户机器上让 `drifted` 通过（陈旧 marker 不该挡重启），而预演是发版前，`drifted` 正是要修的东西，所以这里判 blocking。三处判定表（apply 四桶 / outcome 七态 / behaviour 五态）各自都有「只有 warn 时整体仍算绿」的语义，容易被写成「有 warn 就红」。RED 演练 55 条突变 **55/55 全红**；第一轮 51 红 4 绿，四条绿全靠补「正向命名之外的输入」转红（候选数组里混空串/null、AI 的别处副本必须判 outside、`drifted:write_error` 不得被 HARD_FAILURE 行首锚定误伤、Windows 反斜杠路径）。

**两个词表的跨模块契约**值得单说：`classifyOutcomeState` 对不认识的 state 一律判 blocking（偏保守，不会漏红），但这意味着上游新增第七个状态时，名字会从 tally 里静默消失、没人读。所以 `test-rehearse-lib.mjs` 里有两条断言把 `STATE_LIST` / `BEHAVIOR_STATE_LIST` 与判定表**逐状态**对上 —— 那种改动应该在 CI 上直接炸，而不是等发版预演时才发现。

**十六补**：`scripts/gate-verify-lib.mjs`（104 行）给预演加了第五步 —— 「`docs/patch-gates.json` 还描不描述这棵树」。这一步的存在理由是前四步各自的盲点：apply 只证明「文本被改了」，outcome 只证明「七态里没有坏的」，behaviour 只覆盖 12 条能观测的，choke 只看得见它有形状的那些闸门。而闸门表是**对某一版上游文本的观测**，它自己不带着「还能不能对上」的答案。

判定分三档，关键在版本关系：**同一版**掉针 = 表与树互相矛盾（其中一个旧了）→ blocking；**跨版**掉针 = 漂移，条数恰好是 bump `dshTarget` 时要重推几条 needle → warn，摘要里带上「from X to Y」；**任一侧版本未知** = 无法判断 → 按同版算，偏保守。第三档 `unreadable`（表里有这行、这棵树没这文件，典型是桌面壳 `lib/main.js`）单列不并进 `missing` —— 否则每次预演都会因为桌面壳凭空多出十条「漂移」，那条证据就废了。

把这套写进测试时，`test-rehearse-lib.mjs` 从 59 条补到 70 条，补的 6 条正好是原来一个都没覆盖的四个判定（`bucketsVerdict` / `classifyBehaviourState` / `classifyGateState` / `gateVerdict`）：它们各自都是「上游改了枚举值就静默变绿」的那一类，其中 `classifyBehaviourState` 对不认识的态返回 blocking 这一条最该钉死 —— 新状态默认为绿等于默认为安全。drill 注入 8 条，8/8 全红。

**顺手逮到一个行尾问题**：`scripts/rehearse-lib.mjs` 里有一行被写成了 CRLF（其余 265 行都是 LF）—— 是上一次编辑时混进去的。`check:eol` 没报，因为那个文件当时还没入库；`git add` 之后它就变成了「新文件里混行尾」。真正让它暴露的是 drill：按 `split("\n")` 取行时，那一行带着 `\r`，`line()` 的精确匹配直接 miss。修掉之后 8/8 一次全红。

**十七补**：`scripts/surface-lib.mjs`（269 行 / 32 用例）与预演的第六步 `surfaces`。前五步都只看文本与行为，中间漏掉一整块：补丁会不会顺手改掉某个模块的**导出面**（多一个方法、少一个常量、函数从 1 参变 2 参）。这一步把纯净基线与打过补丁的副本逐包 `import`，把导出面描述成数据（`function/<arity>`、`class/<arity>`、`array/<len>`、`object{keys}`，绝不按 identity 比）再逐项对比。rc.2 实测 42 个包 / `changed 1` / `known 1` / `unexpected 0`，唯一变化是 `#42` 有意装回去的五个 `SettingsForms` 原型方法。

它的边界必须写在那里：**只看得见导出面**。只改函数体内部的补丁（改写措辞、抬高常量、提前返回）完全隐形，`arity` 相同的换实现也看不见。所以它不是行为对拍的替代品，而是补上「有人根本没给这条补丁想观测点」那个洞 —— 行为对拍覆盖 12/86，这一步一次看 42 个包，不需要任何人手写期望。

**这里又逮到一次「两条守卫互为备份」**：变异演练 32 条注入，首轮 30 RED / 2 GREEN，两条都出在 `packageTargets`。`不挡兄弟目录` 一条尤其值得记 —— 原有 fixture 是 `D:/host-extra/dsh-sandbox/...`，把它按 base 长度切掉后剩下 `-extra/dsh-sandbox/...`，名字不以 `dsh-` 开头，于是它在下一道 `dsh-` 前缀过滤就被拦了。两条守卫在这条 fixture 上互为备份，删掉任何一条测试都还是绿的。换成 `D:/hostXdsh-zzz/lib/index.js`（切片后正好对齐成 `dsh-zzz/lib/index.js`）才真正钉住尾随分隔符这一条。重跑 32/32 全红。

另一条 GREEN 是 `不合并重复键`，它的解释完全不同，而且更值得记：那条注入删掉去重之后，今天重跑**立刻红**（`fail=1`，用例 `packageTargets lists each registry key once even when two of its files land in one package`）。也就是说首轮 drill 跑的时候，测试文件里还没有这条 fixture —— 首轮 drill 与后来的补测本来就是两次不同的实验，把它们的结果并列读会得出错误结论。

**十八补**：`scripts/verify-target-lib.mjs`（186 行 / 25 条）把 `verify-target` 的判定层从 CLI 里拆出来。拆的理由不是行数，是**这个文件里曾经有三份判定**：`scripts/verify-target.mjs` 自己的 `patchApplied()` 与 `remainingWork()`，加上 `lib/core.js` 的 `patchApplied()`。CLI 后来改成直接问 `core.filePatchOutcome()`，那两份就没人调用了 —— 但它们仍在文件里、仍长得像权威。加 #42 的两条 legacy 守卫（`legacyApplyPathStarts(hay) > 1` 与 `STALE_LEGACY_APPLY_CALL`）时，core 那份被改了，CLI 那两份没有；如果哪天有人照着 CLI 那份再抄一遍，「#42 在已经升过级的树上算不算完成」立刻分叉。所以这一批把判定收敛成一份，并留了一条源码形状断言：这四个函数名不许再出现在 `verify-target.mjs` 里。

**RED 演练 24 条突变 → 24/24 全红**（`{"restored":true,"total":24,"red":24,"green":0,"anchor":0}`）。两轮才收敛，留下的教训有两条：

1. **多行锚点必须用 `sub` 不用 `line`**。第一轮 5 条 ANCHOR 全是把两行源码写成一行字符串塞给 `line()`（它是整行精确匹配）。改成 `sub()` 之后立刻命中。
2. **两条 GREEN 都是「断言写在了不会被观察的地方」**：
   - `detail 恒开`：注入点原本选在 drifted 那一句的 `if (detail)`，而那一条用例的所有分支都走不到这里 —— 真正的出口是返回值的 `detail: detail ? notes : undefined`：关掉时到底给不给证据，只有那里说了算。改锚点后立刻红。
   - `drifted 被 would-apply 覆盖`：pending 分支里那句 `if (status !== VERIFY_STATES.drifted)` 只在「先一条 drifted、再一条 pending」的顺序下才起作用，而原用例里每一条补丁最多一个 key。补了「坏文件 + 没打完的文件」这条 fixture 才转红。

另外顺手补了 `pathsOf` 的一条真空白：原用例只测「键不存在」，没测「值是 `null` / 空串」——少了 `if (!value) return []` 会返回 `[null]`，再往下 `readText(null)` 直接抛。这条不是从 drill 里来的，是加 mutation 时发现 `!value` 这句没有对应的 fixture。

于是本轮有两条纪律，都来自同一个地方：**RED 演练的结果只对「跑那一刻的测试文件」有效**。① 报 GREEN 时先怀疑 fixture 不够毒（兄弟目录那条就靠一个对齐后正好成 `dsh-` 的路径戳穿了两条互为备份的守卫），再怀疑守卫真没用；② 测试文件改过之后必须重跑 drill，否则手上那份 55 红 / 32 红是上一版文件的历史成绩，不证明现在这套判定还钉得住。

判定口径**逐条对齐、一条不改**：`na` → `no-file` → `hit-mismatch` 记 drifted → `changed` 之后复查 `filePatchOutcome`（不完全就记 `partial`，仍算 drifted）→ 一条 pattern 都不中时问引擎（`applied`/`pending`/`skipped` 三支）→ 软键 `soft-moved` → 其余 drifted。合并前先用同一棵真宿主树跑过新旧两版对拍：`would-apply=67 / settled=5 / drifted=0 / no-file=7 / na=7`，86 行逐行 `[id, status, files]` **完全一致**；再造一棵含 drifted 的 fixture 树（缺 needle、缺 marker、`#42` 只留 marker）跑 `--pad`，两版 stdout **逐字节相同**（diff 为空）。`detail` 的截断长度也保留了原样：`hitMismatch` 那条只截 120 字，其余截 200。

**十九补**：把 `lib/core.js` 的「重启地板」三个函数搬进 `lib/host-clean-floor.js`（142 行 / 30 条）。`ensureHostClean()`、`restartSealedDesktopIfNeeded()`、`rememberDesktopInstallForHandoff()` 原来零覆盖（1/65、1/20、1/18），坏法全是静默的：清洗没写完却照常重启（用户看到宿主半打状态）、`app.asar` 还在就重启（补丁在 `resources/app`，重启完等于没打）、自定义安装目录没记下来（下次再也定位不到 exe，只能重装）。三个函数只在「用户点重启 / 后台自愈要重启」那一刻跑，平时跑测试一条都不会经过，所以必须靠注入把每个出口拨开。做法照 `lib/boot-settle.js` 的工厂范式：新模块**只 import `node:path`**，其余 19 个依赖（含 `hostCleanMarkersPresent` 这种容易漏的）由 `createHostCleanFloor(deps)` 传入，`lib/core.js` 留三个同名薄包装，导出面与调用方一行不改。逐行对拍结果是 **3 条 diff，全是签名行少了 `export ` 前缀**（body 65/20/18 行逐字相同），`lib/core.js` 144 个导出数量不变。

三条被现实纠正的地方值得单独记。第一，**工厂在创建时就把 deps 解构走了**，所以测试里想「换个实现」不能写 `d.resolveOfficialAiBase = async () => {...}` —— 那改的是对象属性，工厂手里仍是旧的那份；必须把可拨的开关放进工厂闭包能看见的 `state` 里，由 deps 里的转发函数去读。第二，**假实现返回的形状要照抄真实那条路的形状**：`applyPatchesAllHosts` 每台宿主都带 `report/summary/hostWritten/flash`（`lib/core.js:2035-2041`），少造 `flash` 会让打完之后的 flash 复检永远判不过，四条用例接连假红。第三，**「当前宿主不在枚举结果里就排到最前」这条只对第一次 `patchStatus` 生效**：`applyPatchesAllHosts` 内部自己又枚举了一遍（`lib/core.js:2022`），不吃外面补的那一份，所以打完之后的宿主清单里不会有它 —— 真实现就是这样，断言要照着真实现写，别照着想象写。

RED 演练 46 条突变跑完 **46/46 全红**，`restored byte-identical: true`。第一轮 47 条里 4 条 GREEN，处置：①`pending 统计把任何状态都算` —— `status` 的对象形态是按 aiBase 索引的，我写 `{1:'settled'}` 得到的其实是「这台宿主上没有任何状态」，改成函数形态才真的喂到 `settled/native/na`（补了一条用例，现在红）。②`needsApply 不看 hostWritten` —— 原用例只查了两句文案，没查「标记没写进宿主本身就该触发重打」，补断言 `applyPatchesAllHosts` 被调 1 次。③`不记安装目录` —— 原来靠 `isDesktopExecutable` 的调用顺序间接看，改成直接断言 `atomicWriteSync` 被调 1 次且早于重启（两条路各一条）。④`成功时把 pending 也带出去` —— 相等价突变（走到那个出口时 `pending` 必然已是 `[]`），写在 drill 里注明，不留成永远 GREEN 的条目。

**二十补**：`lib/desktop.js` 的「重启与交接」这一段。挑它的理由不是覆盖率数字，而是**这一簇坏掉之后用户看到的是「点了重启，什么也没发生」或「窗口关了再没起来」** —— 全是静默失败，宿主进程不会留下任何错误。挑完之后发现这一段有 841 行零命中，其中真正能在这台机器上测的只有九类纯判定与纯文本：

`officialRestartScript`（74 行，生成一份 WSH/JScript 文本，不落盘不启动）、`systemPromptFiles`（10 行）、`dshHomeForRelaunch`（12 行）、`officialExeFromProcess`（10 行）、`helperEnv`（19 行）、`helperNodePath`（17 行）、`unpackedHostIsClean`（20 行）、`officialRestartLogState`（21 行）、`probeWshJsEngine`（24 行）。这九个函数原本都是**模块私有**，测试无从入手；本批照批38 对 `lib/hide-console.js` 的做法，只给它们加 `export`，一行行为都没改（`lib/desktop.js` 的 `^export function` 从 42 条变 51 条，模块导出从 44 个变 52 个，`node --check` 与 `[client]` 全绿）。

新增 `scripts/test-desktop-relaunch.mjs`（**40 条**），把 `lib/desktop.js` 的行命中从 1431 推到 **1624/2272（71%）**、函数 75→93（共 116）、分支 329→378（共 506）。全仓行覆盖 **87.39% → 87.92%**。

本批最值得记的不是数字，而是**发现 wscript 那条分支在真机上根本走不到**：`officialRestartScript` 生成的脚本文本里自带中文注释（`// null = 文件不存在或暂无法判断…` 等），实测非 ASCII 字符 **69 个**，而 `planOfficialRestart` 用 `isWshAscii(script)` 决定走 `wscript.exe` 还是 PowerShell —— 于是 `planOfficialRestart({wshJs:true, ...})` 永远回 `kind:"powershell"`，`restartOfficialHarness` 里那段 `spawn("wscript.exe", ...)` 是死代码。这不是本批引入的，是「脚本里写中文注释」和「用 ASCII 判据选引擎」两件各自合理的事撞在一起。测试里写成了**现状锁定**（断言 `isWshAscii(script) === false` 且 `planOfficialRestart` 回 `powershell`），同时另立一条断言 `planOfficialRestart({wshJs:true, scriptAscii:true, inflightAgeMs:-1}).kind === "wscript"`，把「纯 ASCII 时才会选中」这条判据钉住 —— 哪天有人把注释改成英文，第一条会红，提醒他补回 `wscript` 分支的真实测试。

RED 演练 33 条突变跑完全红（`restored byte-identical: true`），过程里踩了三个坑：①`applySub` 的锚点是在**源码里带 `\r\n`** 的多行串，drill 里写的是 `\n`，四条全 MISS —— 修法是 `applySub` 内部先做 `\n → EOL` 归一；②`python - <<'PY'` 里写含 `\n` 的替换串会把一行中文注释打断成两行，`node --check` 立刻 `SyntaxError: Invalid or unexpected token`（长中文注释一律写成单行，或用 `lines[i] = ...` 按行号 splice）；③两条突变原本是**等价突变**（`home` 传 `null` 与传 `""` 落到 `wshLiteral` 之后完全一样；`sh.Run('\"' + exe + '\"', ...)` 在文件里出现三处，按子串改第二处改到的是别条分支）—— 都换成了「把入参丢掉，恒写空串」和「按行号定位 `!renamed` 那一行再行内替换」。

**教训**：一条突变能活下来，先怀疑**它本身是不是等价突变**，再怀疑测试漏了。等价突变写进 drill 只会留下一条永远 GREEN 的噪音，把它删掉比补一条勉强能红的用例更诚实。

**二十一补**：交接单（`D:\零散对话1\交接单-choke-facility.md`）第六节说「`verify-target` 与 `patch-outcome` 不冲突」。语义上确实不重叠 —— 一个是单树无基线的五态，一个是双树有基线的七态 —— 但两个文件里各有一份**同名同注释**的 `patchReplacements()` 与 `matchesPattern()`。批65 抽 `verify-target-lib.mjs` 时是逐字照抄当时的 CLI，于是同一份补丁注册表有两个解析器。

探针实测四处已分叉：`patchReplacements({ pattern: 'A', replace: 'B' })` → 这边 `[]`、`patch-outcome` 那份 `[{pattern:'A',replace:'B'}]`；`patchReplacements(null)` → 这边抛 TypeError、那边 `[]`；`matchesPattern('A\r\nA', '')` 与 `matchesPattern(..., null)` → 这边 `true`、那边 `false`。今天的危害是零：`core.ALL_PATCHES` 的 86 条里 `pluralOnly: 7`、`singOnly: 0`、`both: 0`，单数 `pattern` 那条分支一条都走不到；`matchesPattern` 的差异只在空串与 null pattern，而那 7 条都有真 pattern。所以这是一处**不可达的平行实现** —— 正是 `MAINTENANCE.md` 那节「判定的平行实现比没有判定更危险」说的东西：它现在不产生错误答案，只等着下一个人在改注册表格式时改错一份。

做法：`scripts/verify-target-lib.mjs` 删掉两个函数体，改成 `import { patchReplacements, matchesPattern } from "../lib/patch-outcome.mjs";` 加一行 `export { patchReplacements, matchesPattern };`（公开面一行不改，`judgePatch` 里两处调用不动）。`lib/patch-outcome.mjs` 一行未改 —— 它那份更宽（认单数 `pattern`、容忍 `null`、空串 pattern 判不命中），宽的那份当唯一实现是安全方向。

等价性用三条独立证据：①`node scripts/verify-target.mjs --pad` 的 93 行 stdout 与改前**逐字节相同**（`diff` 无输出）；②`--json` 的 `86 would-apply=67 settled=5 drifted=0 no-file=7 na=7` 相同，且 `rows` 的 `[id, status, files]` 三元组 86 行逐行相等；③两平台测试 —— `node --test scripts/test-verify-target-lib.mjs` 26/26（Windows）与 `node --import ./.tmp-linux-preload.mjs --test` 同样 26/26。

用例改写：原来那两条 helper 用例断言的是「这份实现怎么算」，现在改成「转出的是不是同一份实现」—— `assert.equal(lib.patchReplacements, outcome.patchReplacements)` 直接用引用相等钉住，比逐条比行为更能防住「又抄一份」。新增一条源码形状断言：`scripts/verify-target-lib.mjs` 里不许再出现 `function patchReplacements(` / `function matchesPattern(`，且 `import` 与 `export { ... }` 两行必须都在。

RED 演练 6 条突变全红（`restored: true`）：又长出一份 `patchReplacements` / 又长出一份 `matchesPattern` / `import` 少一个名字 / 转出语句被删 / `import` 指向不存在的模块 / 把 `matchesPattern` 换成自己的薄包装。**这一批的六条都不是等价突变**，与上一批「等价突变要删掉」正好成对照：判据是「改完之后用户会看到什么不同」—— 这六条都会让某个调用点拿到另一个答案或直接起不来。

**二十二补**：`lib/desktop.js` 剩下的那 648 行里，真正能在这台机器上测的是**官方 CLI 三件套的修补与自愈**这一簇（`patchOfficialCliShimText` / `patchOfficialCliCmdText` / `officialCliShimBodies` / `ensureAppRuntimeSymlink` / `copySkillTree` / `repairOfficialCliAfterUnpack` / `healRuntimePayload` / `inspectRuntimePayload` / `runtimeHealSources` / `restartPlan`）。挑它的理由是**坏了之后用户看到的是一句「不是内部或外部命令」**：0.2.2-rc.1 的安装包根本不下发 `resources/runtime/cli/bin`，而 `dsh` 命令一启动就依赖它；修不上时宿主不报任何错，只是命令行起不来。

做法照批38 / 批67：先给十个原本私有的函数加 `export`（`^export function` 51 → 61，公开行为一行没改），再写 `scripts/test-desktop-cli-repair.mjs`（**48 条**）。这一簇有两个坑必须写进纪律：

1. **`lib/desktop.js` 在模块顶层就算 `INTERNAL_LOG_PATH`**（`path.join(os.tmpdir(), "dsh-purge-desktop.log")`），而 `os.tmpdir()` 运行时读 `process.env.TEMP`。所以测试文件必须**先改 `TEMP`/`TMP`/`TMPDIR` 再动态 `await import`** —— 写成静态 `import` 会被提升到赋值之前，日志就落到全仓共用的那份上（批59 踩过同一条）。
2. **`healRuntimePayload(resources)` 不给 `sources` 时会退读本机 `~/.dsh/dsh-runtimes/dsh-primary-runtime`**。测试里一律传 `{ sources: [] }` 并自己造源目录，否则用例会随本机现状红绿（`runtimeHealSources` 那条则相反：它就是要验「`DSH_HOME` 打头、空串被过滤」）。

三处**行为层测不出、只能源码形状断言**的地方，都写进了注释：①`fs.chmodSync(fp, 0o755)` 两处，Windows 上 chmod 是空操作 → 断「两处都在」且两处都跳过 `.cmd`；②非 win32 的 `fs.symlinkSync("../runtime", link, "dir")` —— 把 `process.platform` 伪造成 linux 走进那条分支后，Windows 的 `symlinkSync` 会把目标里的 `/` 归一成 `\`，`readlinkSync` 读回来仍是 `..\runtime`，行为层区分不了两条实现；③`cmdEntryAlreadyGood` 末行 `return /"%entry%"/.test(text)` 是**冗余守卫** —— 前面「必须含 `if not exist "%entry%" set "entry=..."` 那一级」已经把 `"%entry%"` 带进来了，走到最后一句必然为真。这条不为它硬凑 fixture，只留注释（判据仍是「改完之后用户会看到什么不同」）。

判定口径里有两条**现状怪癖**，测试按现状锁定而不是「顺手修好」：①`repairOfficialCliAfterUnpack` 首轮 `shims` 是 **6 条** —— 前三条是「现场生成三件套」，后三条是同一函数里紧接着「再打一遍补丁」的读数（`already` / `already` / `skipped`）；②`copySkillTree` 每写一个文件之前会**再 `mkdirSync` 一次 dirname**（`lib/desktop.js:286`），所以调用序列里 `mkdir` 是成对出现的 —— 这是真实路径拼接下的必然结果，不是重复劳动。

RED 演练 **41 条突变 → 41/41 全红**（`{"restored":true,"total":41,"red":41,"green":0,"anchor":0}`）。首轮是 42 条里 16 条 GREEN，处置分三类：①**补能区分两条实现的用例**（「只剩 BEGIN 标记、裸 asar 已被换成 `$entry` 的旧块仍要升级」「三级回退都在但多一行自指的 `set "entry=%entry%"`」「`copySkillTree` 目标已存在不覆盖」「`ensureAppRuntimeSymlink` 链接指向别处要重建」）；②**改成源码形状断言**（两处 chmod、非 win32 的链接目标）；③**删掉等价突变**（`cmdEntryAlreadyGood` 末行那条冗余守卫）。第 ①类里「自指 set 行」那条第一版写错了：把一条正确的 `set "entry=%~dp0..\..\..\app.asar\..."` 换成 `set "entry=%entry%"`，于是前一道「必须含三级 asar 回退」先把它挡住，测出来的根本不是那条判据；改成「三条正确 set 行都保留，再额外插一行自指」才真的红。

覆盖率：`lib/desktop.js` 行 1624 → **1812/2273（79.8%）**、函数 93 → 103、分支 378 → 466（共 601）；全仓行 **87.92% → 88.43%**、函数 79.78% → **79.95%**、分支 83.20% → **83.64%**。全量 **2864 条用例 / 2862 过 / 0 失败 / 2 跳过**（Windows 与伪装 linux 各跑一遍）。

仍然测不到的（写进第十节）：`restartOfficialHarness`（125 行）、`scheduleAsarSwapRestart`（78）、`scheduleRestart`（53）、`spawnHelper`（24）—— 都会真 spawn 进程或改 `app.asar`，在这台机器上跑一次就等于重启一次宿主。

**二十三补**：`dshTarget` 从 `0.2.2-rc.1` 推到 `0.2.2-rc.2`。这件事看起来只是改一处字符串，实际是「声明」与「产物」两条独立的线：补丁 registry 的 rc.2 锚点在更早的那一批里已经补齐（六条 drifted 逐条加了 replacement，minified 的 client.js 用整块注释绕开 225984 字符的超长行），所以**打得动**这件事已经成立；但 `hostCompat()` 比的是 `package.json` 里声明的版本，声明停在 rc.1 的话，桌面版真升到 rc.2 之后状态页会一直喊「← 未适配：插件声明 0.2.2-rc.1 / …」，而补丁其实全都打上了。反过来说，声明推到 rc.2 而本机装的是 rc.1，`ok` 仍然为真 —— 因为比较对象是整张 `dshTargets` 列表，不是单个目标。

只动四处：`package.json` 的 `dshTarget`（rc.2）与 `dshTargets`（首位插 rc.2，rc.1 / rc.5 / rc.2 三条历史一个不删）、`README.md` 的第 3 行与版本表那一行、`scripts/test-package-integrity.mjs` 那条用例，加上新增的 `scripts/test-host-target-decl.mjs`。**`docs/patch-gates.json` 与 `docs/host-baseline.json` 都不动**：前者继续 pin 在 rc.1，`npm run host:gates -- --verify` 对着 rc.2 树会报「3 needle(s) moved between 0.2.2-rc.1 and 0.2.2-rc.2」，那正是这张表的语义 —— 它记录的是「这批 needle 是在哪一版上取的」，跨版缺失就是 bump `dshTarget` 时的返工量；跟着一起刷会把 26 条纯行号漂移也写进去，反而把「哪三条真变了」淹掉。后者是观测快照（capturedAt 2026-11-11，本机安装确实还是 rc.1），手改它就等于伪造观测。

`HOST_TARGETS` 的「谁在最前」这件事以前没有任何文档写过，只存在于 `lib/core.js:2937-2946` 那五行 IIFE 里：`dshTargets.slice()` 之后 `dshTarget` 会被 **unshift** 到最前，所以 `dshTargets[0]` 写的是谁都不影响 `HOST_TARGETS[0]`。`scripts/test-host-target-decl.mjs` 第一条就把这条钉住（`HOST_TARGETS[0] === manifest.dshTarget`），否则以后有人以为「改数组顺序就能换主目标」，会在真机上得到一个永远对不上的声明。

`hostCompat` 有三个字段容易被混着读，这一批各钉一条：`known` 说的是「读到了宿主版本」，`ok` 说的是「声明里认它」，`host` 是读到的原文。没声明过的版本必须 `known: true` + `ok: false`（判成 `known: false` 会让状态页什么都不显示，比报警更糟）；读不到宿主或版本解析不了必须 `ok: null`（`gatherState` 用的是 `ok !== false`，也就是 null 算支持 —— 没有 aiBase 的机器不该满天报警）；预发布后缀必须原样相等，`0.2.2-RC.2` 与 `0.2.2-rc.2` 也**不**相等（`parseHostVersion` 保留原样，比较时不做 lowerCase）。

用例共 9 条（另 `test-package-integrity.mjs` 从 12 条变 13 条）。其中一条是 `HOST_TARGETS` 每一项都必须能被 `parseHostVersion` 解析 —— `hostCompat` 里的 `Boolean(b)` 会把解析不了的目标静默跳过，等于「声明了一个打错的版本」就是「少声明一个版本」，只在升级当天才暴露。另加一条 `dshTargets` 无重复项：`HOST_TARGETS` 侧有 `new Set` 兜着，重复在那边是静默的，得在 `package.json` 侧先拦。

RED 演练 22 条突变全红（`restored: true`，`{"total":22,"red":22,"green":[],"anchor":[]}`）：`unshift` 改 `push` / 去掉 `new Set` / 去掉字符串过滤 / `HOST_TARGET` 取末位 / `parseHostVersion` 不收 `v` 前缀 / `pre` 不按点拆 / 接受四段版本 / `looksLikeHostPackage` 不再排除本插件 / 接受空版本 / `readHostVersion` 空 aiBase 不早退 / `hostCompat` 用 `every` / 不比预发布后缀 / 读不到宿主也回 `known:true` / 空目标列表也给结论 / 解析不了版本时 `ok:true` / `target` 标签只放首个 / `dshTarget` 退回 rc.1 / `dshTargets` 首位改写 / 删掉 rc.1 / 删掉 rc.5 / 写入重复项 / 写一个不能解析的版本。跨两平台各 21/21 全绿（`node --test` 与 `node --import ./.tmp-linux-preload.mjs --test`）。

`npm run check` 六道闸：`[syntax] 234 files` / `[metadata] patches=86 tests=93` / `[eol] 304 文件（CRLF 140 / LF 162 / 混合 2）` / `[client] PASS` / `[gates] 86 rows, 58 gated` / `[test] 2874 / 2872 过 / 0 失败 / 2 跳过`。覆盖率 `[coverage] PASS 未跌破基线`，全仓行 88.43% / 函数 79.89% / 分支 83.64%（分支总数在 `core.js` +2、`preset-default.js` +3、`store-core.js` +4，都是执行路径变化带来的 `BRF` 波动，`HIT_METRICS` 只对 `lh/fnh/brh` 判红）。

---

---

**二十四补**：`lib/update.js` 的下载与 git 那一层，从「只能读源码钉形状」变成**真跑**。这一层在本维护副本里是死路（`ONLINE_UPDATES_ENABLED = false`，`_applyUpdateImpl` 第一句就抛），恰恰因此，它保存着**只在开关打开那天才会执行的安全护栏**：https 强制、跳转白名单、跳数与自环、50MB 上限、超时文案、`git` 覆盖前的脏检查。这些护栏坏掉时用户看不到任何报错 —— 点了更新但什么都没下载、或者回退版本时把工作区覆盖了。批44 之前这里只有 4 条源码形状断言，现在两个文件 **102 条**：`test-update-net.mjs`（47 条，假 `https.request` 驱动整条请求链）+ `test-update-state.mjs`（55 条，真磁盘 / 真 git / 真 zip）。`lib/update.js` 行覆盖 **55% → 87.46%**（1011/1156），函数 109/120，分支 465/542。

做法一：**给 26 个原本私有的函数加 `export`**（`^export function|^export async function` 22 → 48，公开面一行没改），否则整层没法从外面驱动。

做法二：**假 `https.request`**。`https.request` 是可写可配置的数据属性，`lib/update.js` 里 `import https from "node:https"` 拿到的是同一个模块对象、调用时才读属性，所以「先替换 `https.request` 再 `await import`」就能整条链跑起来。假的 `req` 要有 `EventEmitter` 的 `on`、`destroy(err)`（内部 `setImmediate(() => req.emit("error", err))`）、`setTimeout(ms, fn)` 记下超时回调、`end()` 里造 `Readable` 当 `res`。四个坑：

1. **`res.resume()` 不能覆成空函数。** 第一版为了观察 302 有没有被消费写成 `res.resume = () => {}`，结果 `Readable` 永远进不了 flowing 态、`'end'` 不触发，`requestBuffer` 的 Promise 永挂 —— 表现为四条 `cancelled`（每条 15 秒超时），而不是失败。正确形态是 `const base = res.resume.bind(res); res.resume = () => { base(); }`。
2. **302 分支的剧本每跳必须给不同 `location`。** 六次都回同一个 URL 时，第二次请求 `candidate === url` 会先撞上自环闸 `if (!candidate || candidate === url) reject(http ${status})`，于是「跳数用尽」那条用例测到的是自环而不是跳数上限。
3. **`fetchRes` 会预改写下载地址**（`const started = rewriteDownloadUrl(url) || url`），所以 `requestBuffer` 里「失败后退回改写 URL」的分支经 `fetchText`/`fetchRes` 永远走不到 —— 那两条必须直接调 `requestBuffer`。
4. **`async` 函数的入参炸出来是 rejected promise，不是同步 throw。** `overlayFromZip(null)` 里 `dests.filter` 立刻 TypeError，但断言必须写 `await assert.rejects(...)`。

做法三：**真 git + 真 zip**。`gitTrackedDirty` / `gitResetTo` 用 `git init -q -b main` + `git clone --bare` 当 origin 的真仓库测；`overlayFromZip` 用手拼的 store-方法 zip（本地头 30 字节 + 中央目录 46 字节 + EOCD 22 字节，`zlib.crc32` 必须写对）喂给假 `https.request`。三条实测结论：①`gitTrackedDirty` 只 `--untracked-files=no` 加 COPY_NAMES 白名单，**未跟踪文件不算脏**（连 `client.js` 这种刚解压出来的新文件也不算），少了这个开关每次更新都会以为自己有未提交改动；②`gitResetTo(dir, '')` 不报「未知版本」—— 源码是 `safeUpdateRef(ref || STABLE_REF)`，空串先回落 `main`，于是只有真去 fetch 时才炸 `fatal: 'origin' does not appear to be a git repository`（**这条是现状，别当 bug 改掉**）；③`overlayFromZip([])` / `['']` / `[null]` 都早退，只有 `null` / `undefined` 才炸。

RED 演练 **39 条突变 → 39/39 全红**（`restored: true`）。首轮 38 条里 5 GREEN / 7 ANCHOR 的处置值得记：GREEN 的「删掉 jsdelivr 白名单」「不再拦自环」「archiveZipUrl 不再编码斜杠」「markCurrent 丢掉第一档同提交」「gitTrackedDirty 把未跟踪文件算脏」都是**测试漏了某条路径**，补用例后转红（不是等价突变）；7 条 ANCHOR 全是**锚点抄错**——`isAbortError` 只有一条 `return` 行、`rewriteDownloadUrl` 没有 codeload 特判、`versionFromPackageText` 没有 BOM 处理、`listRemoteVersions` 是跨行三元、`describeLane` 的 pin 判断带 `onLane &&`、`hasRemote` 用的是 `versions.some(...)`。教训：**锚点必须从源码真实行抄，凭记忆写必 MIS**。

`npm run check` 六道闸：`[syntax] 236 files` / `[metadata] patches=86 tests=95` / `[eol] 306 文件` / `[client] PASS` / `[gates] 86 rows, 58 gated` / `[test] 2976 / 2974 过 / 0 失败 / 2 跳过`（两平台各 102/102）。覆盖率 `[coverage] PASS`，全仓行 **89.44%** / 函数 80.45% / 分支 84.74%。

顺带修掉一条**老测试的隐藏缺陷**：`scripts/test-update.mjs` 的 `bodyOf(signature, nextSignature)` 用 `SRC.indexOf(nextSignature, from)` 切函数体，而下一个签名现在带 `export ` 前缀 —— `indexOf` 命中的位置在 `export ` 之后，于是上一段的尾巴留着 `export `，`body.trimEnd().endsWith('}')` 变成 false。修法是在切之前 `to = SRC.lastIndexOf('\n', to) + 1` 退到行首。**加 `export` 之前没人踩到，因为当时所有函数都没有前缀。**

**二十五补**：`lib/redteam/score-report.js` 的四个导出一行没测过 —— 而它们决定**交付物长什么样**：报告里"这一步是怎么做到的"、"凭据/通道挂在哪条成果上"、"复现命令是什么"、"哪些命中不算数"。这一批 43 条（`scripts/test-score-report.mjs`）用真 `RedteamStore` + 临时目录播种，`lib/redteam/score-report.js` 行覆盖 **1192 → 1457/1532（95.1%）**、函数 101 → 156、分支 221 → 559。

顺手抓到**两个真 bug，形状完全一样：参数传了，被调用方没实现**。

第一个是**漏 import**：`:157` 与 `:1413` 都调 `tunnelIsLegit(t.entry_kind)`，而 import 块里没有这个名字。`lib/redteam/score-rules.js:38` 有实现，基线 `store-core.js:40` 也一起 import + 再导出 —— 是拆分提交 `d48f3d8`（"修掉两处迁移漏定义"）漏掉的**第三处**。危害被两处 `try { } catch { }` 全吞掉：`hitTrace().tunnels` 恒 `[]` → 报告「1.1 通道」每条都空、`needs_channel` 恒 false、`summary.tunnels` 恒 0；`scoreChain().summary.tunnelsLegit` / `tunnelsSelfOnly` 恒 0 → 攻击链页「真实隧道 = 边界突破实锤」整块失效。**2976 条测试全绿，因为这个功能从来没被断言过「登记了隧道之后读出来是什么」。**

第二个是**传了但没用**：`lib/redteam/report-replay.js:144` 的 `buildCurlCommand(options)` 完全不看 `options.headers`，而 `score-report.js:419-424` 明确把从真抓包报文里筛出的 `capturedCurl.headers`（只留 `authorization|content-type|accept|x-requested-with|referer`）传了进去。后果是：有真抓包时合成的 curl 缺 `Authorization` → 455/401，缺 `Content-Type` → 415，照着手册复现不出来。基线 `fa8d09d` 也没有这段 —— **上游原样缺陷，不是拆分丢的**。

**这一批最值钱的一条教训**：漏 import 这类问题可以扫出来。做法是拿被依赖模块（这里 `score-rules.js` / `engagement-meta.js` / `report-replay.js`）的**导出名并集**，逐个看本文件正文是否出现、以及是否在 import 声明里 —— 一次就抓到 `MISSING [["tunnelIsLegit", 2]]`。在全仓 `lib/` 上跑同样的扫描出 25 行，只有这 1 行是真的，其余全是正则误报，三类：方法名（`ctx.apply(...)` / `ctx.inject(...)`）、对象字面量键（`setActive(rules)`）、可选链（`db.exec?.(...)`）—— **判据要排除前导 `.` 与 `?.`**。

几条**只能靠行为用例钉住、读源码看不出来**的现状：①`scoreReport().items` 是 SQL 顺序（按 `recorded_at`），`chain_no` 是在**排序副本**上算的 —— 两者可以不一致，"阶段顺序压过时间顺序"必须用「时间与阶段相反」的 fixture 才测得出；②`scoreChain().stages` 是**五段定长表**（不过滤空阶段），`scoreReport().stages` 是过滤过的（`.filter(st => st.items.length > 0)`），两者 `ordinal` 都保留链路真实位置；③`representativeShots` 的候选池虽然按「命中级 → 目标/资产级 → 点级」push，但 `sort` 只比 `kind === 'card' ? 1 : 0` → `captured_at` → `id`，**分层不影响最终先后**（真要"先自家图"得给 rank 加层级维度）；④`targetMatchesAsset()` 在 `asset === undefined` 时直接 `false`，而 `host LIKE '%<ip>%'` 那条凭据匹配包在 `if (sameAsset)` 里 —— 所以**没挂资产时一条凭据都挂不上**，想按主机模糊匹配先登记资产；⑤`ownsCred` 只用「本条自己写出来的文字」认领凭据，用户名还要求"像账号"（`/[\d\\@]/` 或长度 ≥10），纯英文单词（`default`）会撞车。

RED 演练 **25 条突变 → 25/25 全红**（`{"restored":true,"total":25,"red":25,"green":[],"anchor":[]}`）。首轮是 19 RED / 5 GREEN / 1 ANCHOR：5 条 GREEN 全部靠**补能区分两条实现的用例**转红（internet 阶段的通道反例 / 纯英文用户名不认领 / 阶段与时间逆序 / 未验证凭据不展示 / 阶段小节标题必须带分），1 条 ANCHOR 是锚点凭记忆写了 8 空格缩进，真源码是 `.map((t) => Object.assign({}, t, { legit: ...`）的**内联一行**。

顺便确认两处**不会去修**的上游现状：`ACCOUNT_POINT_CODES`（`score-rules.js:48`，6 项）与 `hitTrace` 里硬编码的三个 code（`web-account-user` / `web-account-admin` / `db-access`）不一致，而 `hitTrace` 那两条 `gaps`（账号类无凭据、突破类无隧道）里的 code 集合**全是已作废的旧 code，永不命中** —— 后者已在批73 里被 `tunnelIsLegit` 修复顺带暴露，但改判定要动 25 项得分表，收益零实证，按现状锁定。

**二十六补**：`lib/redteam/store-core.js` 的 `dispatch(store, req)` —— 127 行，**71 个 op 的唯一分发路径**，命令面板、HTTP 桥（`/redteam/api`）、64 个智能体工具全部从这里过。补之前它只有 `pocSearch` / `pocList` / `pocSave` 三个 op 被 `test-knowledge-dispatch.mjs` 碰过，其余 68 个连一次调用都没有。这一层的坏法特别静默：op 名拼错就落到「未知操作」、别名漏一个就写进另一条记录、`id`/`code` 判成真值就把 id=0 当成没传 —— 三条都不会抛错，只会让面板上少一条数据。

新增 `scripts/test-redteam-dispatch.mjs`（**25 条**）分三段：**记录型假 store 钉接线**（谁被调、第几个实参）、**真 store 钉行为**（落库后读回来对不对）、`dispatchAsync` 与 `pngSize` 单独钉。`lib/redteam/store-core.js` 行覆盖 **3377 → 3687/3831（96.2%）**、函数 233 → 246/261、分支 960 → 1254/1520；全仓行 **90.30% → 91.18%**。

接线测试用的是文字方法名数组，不是 `Proxy`：`recorder({methods: RECORDED_METHODS})` 给 70 个方法各装一个记录函数，dispatch 一旦调到没登记的方法就 `TypeError`，而不是被万能 `Proxy` 悄悄接住、把「这个 op 根本不该调这个方法」变成一条绿。`expectCalls` 逐个比**实参的对象同一性**（`got[i] === want[i]`），这样「传了 req 还是传了 req.vuln」这种差别才看得见。

几条**只能跑出来、读源码想不到**的现状：①**无靶标时九个读 op 共用同一个信封** `{ok:true, items:[], total:0, stats:null, segments:[], stages:[], roles:[]}` —— `stats` 与 `sessions` 连自己的形状都不给，模板上少一个键就是契约变了；②`openEngagement` 在靶标解析**之前**就返回，所以无靶标也能建靶标（写闸门管不到它）；③`vulns` 在同一个信封里拼两次调用 `Object.assign({ok:true}, store.vulnStats(id), store.listVulns(id, req))`；④`addChainStep` 的回落看的是老字段 `s.stage`，不是那个非法的 `stage_code`；⑤`pngSize` 的 PNG 门槛是 `buf.length > 24`，24 字节的合法 PNG 头读出来宽高全是 `null`（fixture 必须 `Buffer.alloc(32)`）；⑥`db.prepare(...).get()` 返回的是 **null 原型对象**，`assert.deepEqual(row, {...})` 会因为原型不同而红，只能逐字段比。

RED 演练 **31 条突变 → 31/31 全红**（`{"restored":true,"total":31,"red":31,"green":[],"miss":[],"restored":true}`）。锚点按**行号取真实行再做行内替换**，不手抄缩进（批73 那条 ANCHOR 事故的对策）。首轮 30 红 / 1 绿，绿的是等价突变：把 `error.message : String(error)` 改成 `: error`，对 `throw "plain"` 结果完全相同 —— 字符串自己 `.message` 是 `undefined`，落到兜底分支还是那个字符串。改成 `: 'unknown'` 才有区分力。**判据：「丢兜底」类突变要检查兜底目标值与兜底值是否恰好相等。**

**二十七补**：`lib/core.js` 的「宿主树 / 主目录定位」簇 —— 十四个纯路径判定（`isAiBase` / `firstAiBase` / `aiBaseGuessesAround` / `aiBaseGuessesFor` / `nestedAiPath` / `isPnpmNodeModules` / `pnpmVirtualStoreDir` / `pnpmProjectRootNear` / `pnpmHoistAiBases` / `walkAncestorsForAiBase` / `findAiBaseFromDshHome` / `homeHasHarnessData` / `desktopDshHomeGuesses` / `findWslWindowsDshHome`）。这一簇回答的是整个插件最要紧的一个问题：**补丁该打到哪棵树上、配置该读哪个主目录** —— 而它判错时一声不响。

判错只有两种表现，都不会抛错：①打到 Electron 外壳那份 `resources/app/node_modules/@deepseek-ai`，`targetFiles()` 返回 0 文件，全场 `no-file`，看着像「这批补丁都不兼容」；②把用户 `~/.dsh` 认成桌面版真正在用的 `dsh-home`，写进去的 `prompt-inject.md` 永远不生效，而状态页仍是绿的。两条都不是「会不会崩」的问题，是「会不会白忙」的问题。

新增 `scripts/test-host-locate.mjs`（**34 条**），全部在临时目录里造树，`lib/core.js` 行覆盖 4241/5191（81.7%、+113 行）。几条**读源码想不到、只能跑出来**的现状：

- `pnpmVirtualStoreDir` 把 `.modules.yaml` 里的相对 `virtualStoreDir` **拼到项目根上，不是拼到 `node_modules` 上**（pnpm 的语义就是这样）；写错这一处，store 会指到一个永远不存在的目录，于是所有 pnpm 安装都被判成「没有宿主树」。
- `walkAncestorsForAiBase(start, maxUp)` 的每一轮 `i` 覆盖的是**两层**（自己 + 父级 的 `node_modules`），所以 `maxUp=2` 只到祖父级；用例把 `start` 放在 `<root>/walk/A/B/C/lib`、宿主树放在 `<root>/walk/`，实测 `maxUp=2 → null`、`maxUp=3 → 命中`。参数名里的 "up" 不是「往上几层」而是「跑几轮」。
- `findDshHome` 的兜底用的是 `os.homedir()`，而它读的是 **`process.env.USERPROFILE` / `HOME`**，不是 `options.env`。只把沙箱环境塞进 `options.env` 而没写回 `process.env`，兜底分支会返回真机的 `C:\Users\Administrator\.dsh` —— 第一版用例就这么踩了，红的是「四处都没有时仍回 `~/.dsh`」那一条。
- `desktopDshHomeGuesses()` 的 linux 分支**返回空数组**（官方没有 linux 桌面壳），darwin 只给 `Library/Application Support/...` 一条 —— 三个平台的分支必须分别钉，用 `Object.defineProperty(process, "platform", ...)` 伪平台跑。
- `findWslWindowsDshHome` 在非 linux 恒空串；linux 下 `/mnt/c/Users` 不存在也是空串（本机没有 WSL，所以「找到并返回」那一支测不到，写在盲区 74）。

RED 演练 **30 条突变 → 30/30 全红**（`{"total":30,"red":30,"green":[],"miss":[],"restored":true}`）。三条被换掉的等价突变值得记下来，因为都是「改完用户看不出区别」：①`firstAiBase` 去掉 `path.normalize`（`path.join` 早就折平了）；②`isPnpmNodeModules` 去掉 `isDir(nmDir)`（对文件路径来说后面两个判据本来也都是 false）；③`firstAiBase` 遇空白候选就放弃 —— 这条最初是绿的，因为用例只喂了「全是空」的数组，补一条 `['', null, good]` 才有区分力。

顺带**一处必须登记的地方**：`scripts/test-patch-registry.mjs` 的「core 的公开导出名一字不差」是拿拆分母树 `docs/origin/core-split-baseline-8066985` 对拍的，加 14 个 `export` 会让它红。改法是加 `EXPORT_EXTRA` 白名单（只放开这些名字、别的一律红、白名单里出现过期的名字也红）—— 不是为了让它变绿，是为了让「下一次悄悄多导出一个」仍然是红的。


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
| 六个 `redteam_poc_*` 工具的 `execute` 真的读得到 `args`：返回值取自入参（`code` 由标题算出）、`hit_count` 递增、查不到时给出「先检索」的指引 | `test-redteam-tools.mjs` | `lib/redteam/tools.js` 79% |
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
| 64 个 `redteam_*` 工具的参数面：宿主能编译成 JSON Schema、缺必填/类型错/枚举外被拒、数组与对象按元素判 | `test-redteam-tools.mjs` | `lib/redteam/tools.js` 79% |
| 靶标绑定解析：单靶标自动绑定、显式优先、多靶标未绑定报错、全局当前靶标被别的会话占用时挡住 | `test-redteam-tools.mjs` | 同上 |
| 并发闸门：上限读设置、占满拒绝、release 按最早一条释放、无会话上下文时如实说明 | `test-redteam-tools.mjs` | 同上 |
| 工具错误结构化：`ctx.redteam` 缺失回「资产库不可用」、桩库缺方法原文照抄、参数类错误归 `bad_input` | `test-redteam-tools.mjs` | 同上 |
| 红队子会话的角色稿：只认五个角色码且必须行首、多条消息以最后一条为准、`content` 优先于 `text`、非 text 块占空位 | `test-role-section.mjs` | `lib/redteam/role-section.js` 94% |
| 角色稿的落地路径：`current` 里的 id 必须无穿越且 `agents/` 存在、稿件 `trim`、只有红队预设不算子会话 | `test-role-section.mjs` | 同上 |
| 角色捕获钩子：`agent/inbox/claimed` 带 `global`+`prepend`、cordis 环境包在 `effect` 里以便解绑、重复调用只挂一次、坏 payload 不打断领消息 | `test-role-section.mjs` | 同上 |
| 资产面工具的 `execute` 业务分支：`asset_add` 回「刚写入的那一条」+ 发现时间不变、`asset_query` 的 limit 夹 200 而 `total` 不受影响、`asset_graph` 与 `attack_path` 各自的节点上限（1000 / 1500）与超限回分段清单、`asset_timeline` 按天聚合、`asset_link` 回边数、`asset_test` 的测试记录追加而不覆盖 | `test-redteam-tool-branches.mjs` | `lib/redteam/tools.js` 93% |
| 计分与攻击链工具的 `execute` 业务分支：`score_list` 的 `groups`（`items` 是档位数、`points` 是已得分，两者别搞反）、`score_hit` 的旧 code 迁移提示、`score_report` 的 `markdown:false` 精简分支、`attack_chain` 的非法 `stage_code` 回落 recon、`chain_add` 的 hints 三源 | `test-redteam-tool-branches.mjs` | 同上 |
| 会话/证据/报告/知识库工具的 `execute` 业务分支：`sessions` 的边界突破口径、`session_check` 的在线数与可用数、`web_list` 的 URL 协议与端口拼接、`http_evidence_add` 真落库、`evidence_*` 四件套、`unknown_*` 三件套、`report` 与 `report_targets`、`poc_add` 的来源靶标名称补全 | `test-redteam-tool-branches.mjs` | 同上 |
| 工具定义按领域拆成五个组文件后仍注册满 64 个：`registerReconTools` 11 / `registerFindingTools` 22 / `registerScoringTools` 16 / `registerKnowledgeTools` 6 / `registerEvidenceTools` 9，`apply` 只剩编排（store 解析 + `ctx.effect` 自动释放 + 五行调用） | `test-redteam-tools.mjs` | `lib/redteam/tool-specs-*.js` 91–100% / `tools.js` 79% |
| 组文件的 `deps` 不漏符号：`ledgerOf` / `unknownsOf` 两个工厂随证据组搬走后不再从 deps 注入（组内自带），`liveRunningChildren` 与 `bindings` / `reservations` / `bindingKeyOf` / `sessionInfoOf` / `resolveRootSession` / `capMap` / `BINDINGS_CAP` / `RESERVATIONS_CAP` / `ROLE_HINT` 必须逐个传进去，少一个就是 `ReferenceError` | `test-redteam-tools.mjs` | 同上 |
| `poc_search` 的 `by_category` 只列有条目的归类：底层 `pocStats().byCategory` 恒是内置 14 项（含 n=0），工具层必须过滤，否则模型误判「库里有一堆分类」 | `test-redteam-tools.mjs` | `lib/redteam/tool-specs-knowledge.js` 100% |
| 两个吃 `role` 的工具枚举都派生自 `ROLE_ORDER`（写死四值那次漏掉 `assess`，资产梳理子智能体永远拿不到角色稿）；`redteam_roles` 自己不吃参数 | `test-redteam-tools.mjs` | `lib/redteam/tool-specs-findings.js` 100% |
| `score_report` 的 `limit` 真的传下去：造两条成果时 `limit:1` 只回一条，`summary` 与 `items` 同口径（现状：summary 也按截断后的 items 算） | `test-redteam-tool-branches.mjs` | `lib/redteam/tool-specs-scoring.js` 100% |
| `unknown_resolve` 的 `disposition` 与 `unk_id` 都是宿主层必填；`evidence_*` 四件套在 `store.db` 缺失时抛「红队资产库不可用」而不是静默返回空账本 | `test-redteam-tools.mjs` | `lib/redteam/tool-specs-evidence.js` 100% |
| 计分块的实现位置与转发：`scoreReport` / `scoreChain` / `#hitTrace` / `#representativeShots` 的实现在 `score-report.js`，类里只留一行转发；四个函数的函数体与拆分前逐行一致（152/1048/178/44 行 diff 0） | `test-score-consistency.mjs` / `test-redteam-report.mjs`（转发出错则三处总分不再相等） | `lib/redteam/score-report.js` 78% |
| 靶标元数据的落盘与阶段口径：`readMeta` / `writeMeta` 的容错、`SCOPE_SQL` 的内外网判定、`POINT_SHORT_NAME` / `scoreStageOf` / `LEGACY_STAGE_MAP` 的取值 | `test-schema-migrate.mjs`（末条）+ `test-score-consistency.mjs` | `lib/redteam/engagement-meta.js` 99% |
| 事实库迁移的两处回填真的生效：`asset.scope` 按 IP 归属判内外网（含 172.16–31 与 100.64–127 的边界）、`attack_step.stage_code` 按 `LEGACY_STAGE_MAP` 映射七个老阶段、已有值一律不覆盖、跑两遍结果全等 | `test-schema-migrate.mjs`（23 条） | `lib/redteam/schema.js` 98% |
| 知识库迁移：补出五个新列与两个索引、老条目按关键词推归类（具体压过泛化）、已有归类不被改写、`POC_CATEGORIES` 的 code 唯一且以 `other` 收尾 | `test-schema-migrate.mjs`（7 条） | 同上 |
| `dispatch` 的 op 表：71 个 op 各自调哪个方法、第几个实参、别名怎么退（`req.poc` / `req.id ?? req.code` / `req.id ?? req.shot_id` / 十二个 `xxx || req`）、`limit` 夹取、写操作闸门、未知 op 与异常的错误信封；无靶标时九个读 op 共用一个信封、`openEngagement` 不受闸门管；`pngSize` 的五种容器宽高（经 `addShot` 间接测） | `test-redteam-dispatch.mjs`（25 条） | `lib/redteam/store-core.js` 96.2% |

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
| 在线更新的下载链与 git 落版：https 强制、七个主机白名单、跳数与自环、50MB 上限、超时统一成「GitHub 超时」、302 消费与不消费、`archiveZipUrl`/`archiveTarballUrl`/`rewriteDownloadUrl`/`versionFromPackageText`/`isAbortError` 全形态、`describeLane` 的 hasUpdate/hasRemote/sha 三支、`markCurrent` 四档、`gitTrackedDirty`/`gitResetTo` 真仓库、`overlayFromZip` 真 zip | `test-update-net.mjs`（47 条）+ `test-update-state.mjs`（55 条） | `lib/update.js` 87% |
| 在线更新保持关闭（不指回已删库的 `HunYiSage/dsh-purge`） | `test-update-source.mjs` | `lib/update.js` 87% |
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
| 通道状态：坏 `channel.json` 回落 stable、beta pin 清空并回写 | `test-self-update.mjs` | `lib/update.js` 87% |
| 版本比较与筛选：`versionIsNewer`、`latestStableVersion`、`hideListedVersion` | `test-self-update.mjs` | 同上 |
| 更新 ref 白名单（`safeUpdateRef` 挡住路径穿越与命令拼接） | `test-self-update.mjs` | 同上 |
| 更新地址改写：`archiveZipUrl` / `archiveTarballUrl` 认 40 位 sha 走裸路径、`v?数字` 走 `refs/tags`、其余走 `refs/heads` 且 ref 要编码；`rewriteDownloadUrl` 只把 `github.com/.../archive/...` 改写到 `codeload`（源码形状钉，含 `{7,40}` 与 `decodeURIComponent`） | `test-update.mjs`（6 条） | `lib/update.js` 87% |
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

35. **`lib/redteam/tools.js` 按领域拆成五个 `tool-specs-*.js` 之后，「拆分等价性」同样只有一次性对拍。** 2269 → 474 行（`apply` 只剩编排），五个组文件共 1865 行；64 个工具块的原文逐行对拍过（recon 569 / findings 448 / scoring 380 / knowledge 180 / evidence 212，全部 diff 0），但这份对拍脚本没进仓库，下次再搬只能重写。守行为的是原有测试（注册面 64 个、参数面宿主编译、业务分支 41 条），它们只能证明「搬完行为没变」，不能证明「搬的时候一个字都没改」。 另外三处只能现状锁定：①`tool-specs-evidence.js` 里的 `ledgerOf` / `unknownsOf` 两个工厂是**组内自带**（只闭包 `store`），不从 `deps` 注入，所以「deps 漏传」这类错误在证据组不会暴露，只在 recon/findings/scoring/knowledge 组暴露；②`score_report` 的 `summary` 与 `items` 同口径（`limit:1` 时 `count` 也是 1），要改成全量口径得另算一遍，属产品决策；③`redteam_roles` 的 `parameters` 是空对象，它的角色列表来自 `ROLE_TITLES` 而非 `ROLE_ORDER`，两个来源顺序不同（`ROLE_TITLES` 含 `plan` 在首位）。

36. **状态戳只能说明「上次谁写了它」，不能说明「宿主树上现在有什么」。**
    `applied.json` 是插件自己写的文件，宿主被官方升级/换回原版时它不会被改动；
    2026-11-12 实测就撞上过：戳写着 1.1.94 已应用，59 个目标文件里 55 个是原版、`dsh-purge` 标记计数 0。
    现在 `host:status` 会用 `hostCleanMarkersPresent` 反查树上标记并给出 `stamp-lies`，
    但**标记本身只有一个探针**（`dsh-system-prompt/lib/index.js` 里那几行注释）；
    如果哪天这个文件的补丁被单独回滚、其它 58 个文件仍是打过补丁的，
    这里会误报成 `stamp-lies`。要根治得让 86 条补丁各自留标记，代价是补丁正文变长，暂不做。
    `reapply.js` 的 `patchesMatchInstallStrict()` 走的是同一套标记，所以两处会一起误报、不会互相矛盾。

37. **旁路沙盒证明的是「补丁引擎在干净树上能打出与基线一致的字节」，不是「真宿主现在是对的」。**
    `scripts/sandbox-apply.mjs` 只复制 42 个包 / 709 个文件 / 6.4MB 到 `.tmp-sandbox/`，
    在副本上跑 `applyPatches` 再与 `docs/host-baseline.json` 逐文件对拍；
    2026-11-12 实测首次 `applied 63 / already 5 / missing_file 10 / skipped 1 / na 7`，
    59 个文件全部一致、第二次重打全 `already` —— 这同时说明真宿主那份树确实是被换回原版了。
    它测不到的三件事：①真宿主上 `allowTargetPathForAiBase` 的 zone 判定（副本落在仓库里，
    走的是 `shared` 分支，与 `resources/app` 的 `desktop-install` 分支不是同一条）；
    ②`silenceCmdFlash` / `patchAllShims` 这些会改 npm 全局的步骤（脚本里没调）；
    ③桌面壳文件（`desktop-shell` 那 7 条 patch 在副本里恒 `na`，因为副本没有 Electron 外壳）。
    另外 `missing_file` 的 10 条在副本与真宿主上都会出现，是「目标文件本来就不在这台机器上」
    （`pi-ai-*`、`hooks-*`、`preset-unrestricted` 等），不是回归。

38. **补丁落点的「面」判定有两套口径，一套按进程、一套按正在清洗的树；后者才是对的。**
    `allowTargetPath(fp)` 看 `detectSurface()`（进程级：exe / argv / `DSH_SURFACE`），`allowTargetPathForAiBase(fp, aiBase)` 看这棵宿主树在不在桌面安装目录里。
    `targetFiles(aiBase)` 期间会设 `_patchTargetAiBase`，`firstExisting` / `allExisting` 都走 `allowTargetForPatch`（aiBase 感知），但五个 list 函数内部的 `push` 曾经走 `keepSurfaceFile`（surface 感知）——
    结果桌面树里真实存在的 `pi-ai-anthropic-messages` / `pi-ai-completions` / `pi-ai-responses-shared` 在 CLI（surface 推成 web）下被判成 `desktop-install` 而丢掉，
    `applyPatches` 报 `missing_file`、`verify-target` 按 argv 推成 desktop 又报 `would-apply`，两处口径分叉，用户看到的是「补丁全丢了」。
    2026-11-12 把 `keepSurfaceFile` 改成走 `allowTargetForPatch`（`_patchTargetAiBase` 为空时原样退回 `allowTargetPath`，`targetFiles` 之外行为不变），三个键在 web 面也能登记。
    **仍然测不到的**：真宿主上「哪一套 surface 才是用户视角」这件事没有独立判据 —— `DSH_SURFACE` 不设时 CLI 一律推成 web，只有带 argv 的 `verify-target` 才推成 desktop。
    所以 `host:status` 与 `verify-target` 对同一棵树可能给出不同结论，这是设计上的已知分叉，不是 bug，但读输出时必须先看它用的是哪套口径。

39. **升级预演只回答「锚点还在不在」，不回答「打上去之后跑起来对不对」。**
    `scripts/host-preview.mjs` 把目标版本 `npm install` 到 `.tmp-preview/`（1.4GB，已 gitignore），
    跑 `patchStatus` 逐条判锚点，报出「这次升级会打坏哪几条」。2026-11-12 对 0.2.2-rc.2 实测：
    86 条里可打 65 / 升级打断 6（#13 #18 #35 #56 #77 #62）/ 不适用 15；
    2026-11-13 补上 rc.2 形态锚点后复测变成可打 71 / 升级打断 0 / 不适用 15。
    它测不到的四件事：①补丁打上去之后**语义**对不对 —— 锚点在、替换也做了，但上游把那句逻辑搬去了别处，
    补丁就变成一条写在死代码里的注释；②`desktop-shell` 那 7 条恒 `na`（预演树里没有 Electron 外壳）；
    ③`hooks-*` / `preset-unrestricted` / `liangshen-*` 那 7 条恒 `missing_file`（包不在 npm 里）；
    ④预演装的是**完整 rc 树**（668 个包），而真宿主是 42 个包的精简布局，
    所以「预演可打」不等于「真宿主可打」—— 反过来的方向才成立（预演判死 = 真宿主必死）。
    另有一条实现上的取舍：预演用 `--ignore-scripts` 装，不跑任何 postinstall，
    所以它只验证文件层面的锚点，不验证构建产物（比如 `lib/bin-*.js` 那种带 hash 的 chunk 名）。

---


40. **rc.2 之后的新形态只能靠夹具守，不能靠「推理」守**。`test-patch-upgrade.mjs` 的 7 段窗口是从一棵真实的 0.2.2-rc.2 安装树里切出来的，用 `scripts/gen-patch-upgrade-fixtures.mjs --preview` 重新生成。上游再升版本时，这七段会全部失配——这是设计意图（说明锚点又变了），不是测试坏了。重新切片之前不要为了让测试变绿去改 `before` 字段：那等于把「上游改了什么」这个事实抹掉。
41. **`APPEND_ALLOWED` 是手写登记表，不是自动推导的**。给某条补丁追加 replacement 后忘了登记，`test-patch-registry.mjs` 会红（这是对的）；反过来，把 `APPEND_ALLOWED` 的值改大来「修好」测试，就绕过了「追加条数」这道唯一的数量守卫。真需要多追加时，连同一句说明一起改。
42. **两套 minified 断言都只看形状，不看运行**。`isRewindMarker` / `rewindVisibleEntries` 的语义等价性是拿 rc.1 已打版与 rc.2 注入版各 `new Function` 装载、喂 14 组事件序列比出来的（临时脚本做过，未入库）。仓库里只有窗口级对拍：能证明「注入的代码就是我们写的那段」，不能证明「这段代码的行为和 rc.1 一致」。要补这一层，得把那段对拍脚本正式收进 `scripts/`，并准备一份 rc.1 已打版作为参照——那需要真宿主在场，CI 上跑不了。

43. **`#62` 的 fail-open 只覆盖「失败」，不覆盖「用户主动取消」。**
    审批的三个失败分支（没有 approval 服务 / 没有 agent / 没有审批通道）都改成放行，
    但 `case "cancelled"` 保持原样：那是用户在审批框里明确点了取消，放行等于把拒绝变成执行。
    2026-11-13 修过一次自己引入的回归 —— 加 rc.2 锚点时顺手把 `cancelled` 也改成了 allow，
    在 rc.1 上打不中（rc.1 的分支是内联对象，没有 `approvalDenial(`），所以本地全绿，
    但 rc.2 上会生效。守卫是 `test-patch-upgrade.mjs` 的「#62 不该有 replacement 命中 cancelled 分支」，
    判据必须是 `case ["']cancelled["']` 这种分支形状，不能用 `/cancelled/i` ——
    `approvalCancelled` 这个字段名本身含 cancelled，十六条 replacement 会被全部误判。
    **仍然测不到的**：rc.2 上真跑一次「用户点取消」，需要交互式审批界面，CI 里没有。

44. **`markers` 命中就算 `applied`，理论上会掩盖「只打上一半」的补丁，但当前真宿主上零实例。**
    `patchApplied`（`lib/core.js:3641`）在补丁有 `markers` 时只看标记在不在（`markersAny` 决定「任一」还是「全部」），
    根本不看 `replacements` 里还剩几条 pattern 没打。实测 #62 在 rc.1 原文上：只打 `if (exec.agent === void 0) return {` 那一条，
    文件里就出现了 `[dsh-purge] no agent → allow`，判定立刻变 `applied`，而另外两条分支还没动；把 `markers` 去掉再判同一份文本是 `pending`。
    量过影响面：真宿主桌面树判 `applied` 的文件条目 106 个，其中「pattern 还有剩却已 applied」只有 1 个（`#42 settings`），
    而那 4 条 pattern 是**插入型幂等锚点**（`replace` 原样包含 `pattern`，打完 pattern 仍在原位，只是旁边多了新代码），单独打它们 `changed=false` —— 是假阳性。
    换硬判据复核：把每个文件上的全部补丁从 `.dshpurge.bak` 按 `ALL_PATCHES` 顺序重放，60 个可比文件里「重放 ≠ 当前文件」为 0，即真宿主没有任何文件停在中途。
    **结论是刻意不改判定层**：改它要同时动 `rollupPatchStatus` / `patchStatusReady` / `isPatchResultSoftOk` / `applyPatches` / `verify-target.mjs` / `host-preview-lib.mjs` 六处，
    而收益是零实证问题；这个取舍写在这里，避免以后重新发现同一点又去动它。真要加固，先把 `#42` 那种插入型锚点在测试里写清楚，而不是改判定。


45. **判定层的「读失败」分支在 CI 上造不出来。**
    `patchStatus` 与 `applyPatches` 都有 `loadText` 抛错 → 记 `pending` / `lastError = "read_error"` 的分支，
    但 `targetFiles` 用 `isFile()` 过滤候选：把文件换成目录后这个键直接落空，走的是 `missing_file` / `na`，
    根本到不了读失败那一行（`test-patch-outcomes.mjs` 已把这条现状钉住，别当成覆盖缺口去「修」）。
    真正的读失败（权限不足、被独占锁、盘掉线）在 Linux CI 上难以稳定复现，Windows 上又依赖 ACL 现状。
    **仍然测不到的**：`write_error:` 分支同理 —— 需要让 `saveText` 抛 EACCES，得先把目标文件设成只读再触发写，
    这在 NTFS 上与 Linux 上行为不一致，写进 CI 会变成一台机器绿一台机器红。

46. **`sanitizeYamlPersonaScalars` 的「五类样板段」是硬编码清单，不是语义判断。**
    官方改一句样板文案（例如把 `You are a coding agent powered by` 改掉），净化就不再认得它，
    于是折叠块原样留下、`personaPrefix` 与官方身份文案一起生效，用户会看到两套身份并存。
    表现为「注入看起来没生效」而不是报错。守卫只看这五类各自还能被认出来，测不出「官方又多了一类」。
    **检测办法**：升级后跑 `npm run host:status`，若 `cordis.patch.yml` 的 `personaPrefix` 没被清空，就是这一类。

47. **状态页的列宽是「数字常量 + 空格」，不是按终端宽度算的。**
    `renderStatus()` 里 22 / 30 / 2 三个宽度写死，中文字符按 UTF-16 长度算，所以 `layer` 是中文时
    列会对不齐（`提示词/Prompt` 是 11 个码元，比英文长）。测试只钉住「当前这些输入排出来是什么样」，
    一旦有人加中文名字的补丁，明细行会错位而测试仍是绿的。
    **检测办法**：改完补丁名之后扫一眼状态页，看 `[#NN]` 后面的名字列是否还齐。
48. **会话权限与 cwd 捕获只钉住了「装了什么钩子、钩子里判什么」。**
    这一层真正的外部效果是「权限芯片的表情」和「下次开新会话落在哪个目录」，两者都要真宿主、
    真人操作才看得见。测试用假 ctx 能证明的是：父会话预设读得到、`permission/preset` 多于一条就不覆盖、
    `header.cwd` 去空白后落了盘、dispose 把钩子和标记都清了。测不到的是：宿主改了 `permissionPresets`
    的服务名或 `set` 的签名（那时整组静默失效 —— `permissionPresetsOf` 返回 null 就直接 return）、
    宿主改了会话事件名（`session/created` / `session/event` 都不再触发）。
    **检测办法**：升级后手验两条 —— 发完第一条消息权限芯片还在不在「完全访问」；
    切目录后 `$DSH_HOME/dsh-purge/last-cwd.txt` 有没有跟着变。
49. **`/rules` 与 `/skills` 的聊天层只钉住了「命令 → 落盘」，命令文本进不了真会话。** 52 条用例直接调 `handleRulesCommand(rawInput, deps)`，覆盖的是参数解析、id 校验与落到 `lib/rules.js` / `lib/skills.js` 的副作用；没覆盖的是宿主把 `/rules use abc` 从聊天框里切分出来交给注册器的那一步（`lib/commands.js` 只钉了注册面）。同理三处只能源码形状钉、不能行为钉：①`callRefreshHungOperator` 的 `typeof deps.refreshHungOperator !== "function"` 守卫——删掉后裸调用抛 TypeError 再被同一个 `catch` 吞掉，命令照样回 success；②`/skills create` 的 `|| id`——`saveSkill` 内部的 `|| (parsed.ok ? … : "")` 会再回落一次，落盘看不出差别；③`normalizeMeta` 对空 `name` 回落成 id，所以 `/rules create` 的 `args[2] || id` 只有回显能区分。另有一处**现状锁定**：`/rules delete` 拼错 id 也回 `✓ 已删除规则`（`deleteRule` 吞 ENOENT）——用户以为删了，实际什么都没发生，改坏的表现就是这一条。

50. **`/purge apply` 只钉了「怎么报告」，没钉「真写进宿主」**。`test-chat-purge.mjs` 用假 `core` 断言调用顺序、四种补丁记号、五种收尾文案与重启判据，但 `applyPatchesAllHosts` / `patchAllShims` / `silenceCmdFlash` 本身一行都没执行。也就是说：把 apply 的报告写错会被测试抓住，把宿主机真的改坏不会。这一层的真实守卫只有「跑一次 `npm run host:status` 看 verdict」和「升级前跑 `npm run host:preview`」，两条都要对着真安装目录。检测办法：改了 apply 分支之后必须实跑一次 `/purge apply` 再看状态页的补丁明细，不能只看测试绿。
51. **注入读盘层的四档降级只钉了形状，没钉真实降级路径**：`installHungPromptGlobal` 的 `refresh → hung → disk → sealed` 是「上一档抛错才走下一档」，测试里是用假 `core` 让第一档抛来模拟的；真实情形是加密槽解不开（`openSlot()` 返回空串）或 `prompt-inject.md` 被独占锁住，这两条在这台机器上造不出来。还有个连带效应：`refreshHungOperator` 一旦成功过一次就把结果钉进 `hungCache` 与 `core.hungOperatorPrompt()`，之后改盘上的 `prompt-inject.md` 不会再生效（要等 mtime 或提交版本变化）——这条已在用例里如实钉住，但**升级后如果官方改了 `committedOverrideRevision` 的语义，缓存会变成永久命中**，表现就是「改了提示词但注入不变」。检测办法：改一次 `prompt-inject.md` 保存，看下一轮对话的注入是否跟着变；不变就是这一层卡住了。

52. **注入写盘层的 34 条 RED 演练里，第一轮有 9 条是绿的**——不是代码问题，是断言不够区分。记下来免得下次重犯：
    ①`incoming = decision.messages || []` 与 `Array.isArray(...)` 在「字段缺失」上等价，只有 `messages` 是**非数组真值**（如字符串）时才分得开；
    ②去掉 `if (mounted) return;` 之后微任务补挂仍然只挂一次，必须等 1500ms 的迟到重试到点才看得出叠层；
    ③缓存签名里的 `policy` 默认就是 `fallback`，换成常量 `"always"` 时同一 home 下无差别——必须先写一份 `workspace-policy.json` 造出非默认值；
    ④`if (cached)` 与 `!== undefined` 只在缓存值是空对象时才分开，实际路径里缓存值永远非空——只能源码形状钉；
    ⑤`afterCloser` / `anchorApplied` 第一版只钉了「字段存在 + 顺序」，没钉值，于是 `afterCloser: 0` 与 `anchorApplied: false` 蒙过去；
    ⑥`closerFollowBytes` 的 `lastIndexOf` 与 `indexOf` 只在闭标记出现多次时才分开；
    ⑦`next = args.length >= 3 ? args[args.length-1] : null` 与 `args[2] || null` 只在「四参调用」时才分开（三参时两者都是同一个函数）；
    ⑧cleanup 里 `delete ctx.__dshPurgeMnemonStrip` / `__dshPurgeRegionGate` 只在该 ctx 曾装过这两个模块时才分得开，必须在 cleanup 前手动置位；
    ⑨`rewriteLiveAssembly` 命中缓存后不再写日志，所以「读日志验 policy」必须换一个 assembled 对象。
    另外两条锚点第一次写错：`isMnemonPluginMessage` 的两行在 `lib/identity.js:724-729`（不在 `lib/inject-write.js`），`chatml` 那行的正则字面量里是三个反斜杠。
    **仍然测不到的**：真宿主上「切预设后锚点会不会消失」「400ms 轮询能否在第一次 assemble 之前挂上 guard」都只在真会话里分晓，测试只能证明钩子挂上了。

53. **「测试全绿但插件装不上」这一类，只有 boot 测试能挡住**——`lib/index.js` 里的 `apply()` 是全插件唯一入口，但它的 11 个 effect 工厂与 `installWebServer` 直到 2026-11-13 之前一条测试都没跑过，所以批53 收窄 import 时漏掉 `ensureRestartReady` 谁都没发现。现在 `test-plugin-boot.mjs` 用「假 ctx + 同步 dispose 所有 effect」覆盖住了，但它**仍然测不到的**：
    ① 真宿主上 `webServer.register` 的返回值形状（假 ctx 收下就算成功）；
    ② `setTimeout(settleInstalledPatches, settleDelayMs(surface))` 这条定时器路径被同步 dispose 立刻撤掉，等于没跑——自愈决策树目前仍是盲区（`settleInstalledPatches` 125 行、14 个 return 分支）；
    ③ 桌面面（`DSH_SURFACE=desktop`）会走 `healOfficeSkills` / `inspectRuntimePayload` 真碰安装目录，测试里固定成 `web`；
    ④ 名字缺失的源码断言只覆盖 `routeSpecs` 这一处 deps 对象，其它 deps 面（`installWebServer` 内部、`applyHostHooks`）还是靠 boot 测试「跑起来不抛」。
54. **启动自愈能注出来，但「真读宿主」那一步仍然没有守卫**。`lib/boot-settle.js` 的全部 14 个 return 分支现在都能用假 deps 精确走到，可五个注入点本身（`core.gatherState` 返回什么、`reapply.patchesMatchInstallStrict` 怎么判、`hostctl.scheduleRestart` 真起来是什么形状）一行都没被执行。判坏的典型表现仍要人工确认：①启动后补丁过期却没自愈（`gatherState` 的 `patches_pending` 口径变了）；②自愈写完重启了但重启是空转（`scheduleRestart` 返回的 `restarting` 语义变了）；③密封桌面卡在「等 Apply」永远不动（`desktopAsarStillSealed` 判反）。检测办法：改一次宿主包里的某个 `[dsh-purge]` 标记，重启宿主看它是否自己修回来；`npm run host:status` 与 `npm run host:preview` 只验「补丁在不在」，验不到「自愈有没有跑」。另外 `apply()` 里那行 `setTimeout(settleInstalledPatches, settleDelayMs(surface))` 在 boot 测试里被同步 dispose 撤掉了，桌面面 4000ms 的真实时序也没进过测试。

55. **`apply()` 的 12 个 effect 里，只有总数被钉住，顺序与相互依赖没钉**。`test-plugin-apply.mjs` 断言了「登记 12 个」，但谁先谁后、谁的 disposer 依赖谁的初始化，一条都没测——真实宿主里 `installWebServer` 必然最后（它要 `routeSpecs` 的 deps 全部就位），`installCwdCapture` 必须在 `installFreshFullAccess` 之后（否则第一条消息的 cwd 抓不到）。**仍然测不到的**：①`ctx.effect` 在真 Cordis 里是异步注册，同步跑工厂只是近似；②`enabled:false` 路径里 `clearOwnedSelectedDefault` / `removeStaleAgentPresetDir` 在本机都走 `catch`（`$DSH_HOME` 是临时目录），真实清默认有没有清干净只能手验；③`apply()` 之后 `ai_base` 的实测落点是 npm 全局那份，与桌面真实生效的那棵不是同一个——`/status` 会把它显示出来，这是已知的两棵树问题，不属于本批。
56. **override 的「用户稿」判据只有四道闸被钉住，「哪些正文算用户稿」这条语义本身没有守卫**。`test-override-state.mjs` 钉住了 `PLUGIN_DEFAULT_MARKS` 三标记全中才算插件血统、当前槽 hash 与 `seedHash` 都不算用户稿、空稿不算——但它是**白名单式判据**，上游哪天改了 persona 开头那段（`<|im_start|>system:` 或 `<project_instructions>` 的写法变了），所有旧稿会瞬间从「插件默认」翻成「用户稿」，表现是「升级后注入还是旧的、状态页却说一切正常」，而四道闸全都判对。**仍然测不到的**：①`editOverride` 真的 spawn 一个编辑器并等待它退出（本机只验了 tokenizer 与 `needCreate`，`.on("error")` 的 ENOENT 是同步吞掉的）；②`writeOverrideState` 在 `<home>/dsh-purge` 目录不存在时的竞态（实测是 `rename` 报 ENOENT，正常路径先 `markOverrideCustomized` 就会先建目录，所以只在「同一 home 反复 rm -rf」的探针里出现）；③`refresh_default` 分支在本机不可达（任何非默认正文都被判成用户稿而走 `kept_user_custom`）。检测办法：改一次 `prompt-inject.md` 再跑 `npm run check` 看 `overrideStatus` 是否仍为 `default`；升级宿主后第一次启动看状态页的注入来源是 `prompt` 还是 `default`。

57. **`silence*` 这一簇的「在 Windows 上真不弹控制台」本身没有守卫**。`test-silence-flash.mjs` 的 51 条全在假 `platform` 与假文件树上跑，钉住的是「哪些函数有平台闸门」「替换文本长什么样」「返回值怎么聚合」——**没有一条真的让子进程起来**。所以这三类失效仍是盲区：①`windowsHide` / `windowsVerbatimArguments` 这类选项在 Node 里拼错（写成 `windowshide`）时，测试照样本绿，只有真在 Windows 上跑一次才知道有没有闪框；②`silenceMnemonGitFlash` 把 `execFileSync('git', [...])` 换成读 `.git` 文件后，逻辑正确性依赖仓库形态（worktree / submodule / `.git` 是文件而非目录），假 fixture 只有最普通的一种；③`stubDoctorSupervisor` 的 `schtasks /Query /Delete /TN "DSH Doctor Supervisor"` 在任何测试里都没真跑过（`execFileSync` 被假 deps 挡住），计划任务名写错也测不出。检测办法：在真 Windows 上跑一次 `/purge` 全流程，观察有没有黑框；再用 `schtasks /Query /TN "DSH Doctor Supervisor"` 手工确认残留。
58. **`silenceLiangshenPhase1Strip` / `silenceOfficialPhase1Strip` / `keepLiangshenOperatorPrompt` 三个没有平台闸门，这是现状而非疏忽，但也意味着它们的行为在任何平台都会改盘**。测试里对这三条写的是「现状锁定」断言（非 win32 下也照样改文件），RED 演练证明改坏了会红——但**这三条真正的风险不是「改不改」，而是「改对没改对」**：phase1 的十项人设集合与六个 pattern 分支是为上游 `@linxin666/dsh-liangshen` 的具体源码形态量身写的，上游哪天改了缩进、换了引号、或者把 `PERSONA_SECTION_NAMES` 挪进另一个文件，正确行为就退化成「只改集合、不加 marker、不撤放行段」——而这在测试里正好是「first round missing + 集合被放宽」这条**已被允许**的形态。检测办法：升级 `dsh-liangshen` 后跑 `npm run check` 看 `test-silence-flash.mjs` 的 phase1 那 11 条是否仍绿；红了就说明锚点形态变了。另外这三条函数的返回值同样被 `worseLiangshenHit` 的 rank 压住，**永远看不到 `patched`**，只能靠「文件内容变了没」判断。
59. **shim 注入这一簇，钉住的是「写进去的字节对不对」，不是「写完之后还能不能启动」。** `test-shim-patch.mjs` 的 46 条全在临时目录里跑，三种 shim 形态（`#!` 脚本 / `#` 开头的 ps1 / `@echo` 的 cmd）都是手写的 20 行 fixture —— 真实的 `dsh` 是 npm 生成的两百多行包装、真的 `dsh.ps1` 里有 `$MyInvocation` 与 `$PSScriptRoot`。所以这三类失效仍是盲区：①注入块插错位置时（比如插在 `#!/usr/bin/env node` 之前）文件语法上仍然合法、`node --check` 也过，只有真敲一次 `dsh` 才会报 `SyntaxError` 或 `command not found`；②`shimInjectFor("sh")` 那段 `_dsh_shim_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)` 依赖 `$0` 的语义，被 `source` 进来时 `$0` 是父 shell，注入块会导出一个错的 `DSH_HOME`，而测试里只断言了字符串在不在；③`patchShim` 写盘走 `atomicWriteFile`，在 Windows 上如果目标文件正被另一个终端占用，`rename` 会 EPERM —— 测试里用 `chmod 0o444` 造过一次，那造的是「权限不许写」，不是「文件被占用」。**检测办法**：改完 `shimInjectFor` 之后，在一个干净 shell 里敲 `dsh --version`、`pwsh -File (Get-Command dsh.ps1).Source --version`、`cmd /c dsh.cmd --version` 三条，任一报错就是插错位置了；再 `echo $env:DSH_HOME` 确认注入块没把变量指错。

60. **`dsh.cmd` 的「只剥不注入」这条分支在本机是有意为之，但它意味着 Windows 上的 cmd 启动器永远拿不到 `DSH_HOME`。** `patchShim` 里 `if (fname === "dsh.cmd" && isWindows)` 直接 `stripWinCmdShim` 后 `continue`，理由是 cmd 每起一次都闪黑框，宁可让 `dsh.cmd` 保持原版。测试里对这条写的是**双分支现状锁定**：Windows 上断言 `skipped_win_cmd` / `stripped_win_cmd`，非 Windows 上断言正常注入 —— 也就是说「Windows 上的 `dsh.cmd` 到底该不该注入」这个产品决策没有任何守卫，只有一行注释。改坏了的表现是：用户在 cmd 里敲 `dsh.cmd`（而不是 `dsh`）时，插件读到的 `DSH_HOME` 是默认家目录，于是**同一台机器上 cmd 与 powershell 走的是两套状态**（`dsh-purge/override-state.json` 分叉），而两边都不会报错。**检测办法**：在 cmd 与 powershell 里各跑一次 `/status`，对比 `DSH_HOME` 那一行；不一致就是走了两条路。另有一处**下游耦合**没守卫：`stripWinCmdShim` 的判据是 `shimIsPatched(fp) || hasLegacyPermissionPin(text)`，而 `shimIsPatched` 只认 `dsh-purge shim` —— 如果哪天注入块的首行文案改了（比如换成 `[dsh-purge] shim begin`），Windows 上的 `dsh.cmd` 就再也剥不干净，旧注入永久留在文件里，且 `stripWinCmdShim` 会一直回 `skipped_win_cmd`。

61. **密封 bin 清理这一簇，钉住的是「报告里写了什么」，不是「真机上那两个目录有没有被清干净」。** `test-sanitize-runtimes.mjs` 的 23 条全部在沙箱里跑：`APPDATA` / `LOCALAPPDATA` / `PATH` / `DSH_HOME` 五个变量都被指到临时目录，密封目录是用 `mkdir -p` 手工铺出来的三级结构。**仍然测不到的**：①真实的 `…/DSH Desktop/host-commands/bin` 里除了三个启动器还有 Electron 的原生模块与 `.asar` 目录，`readdirSync` 出来的名单与 fixture 差两个数量级，「只匹配 `.dshpurge.` 开头」这条准入规则在真实名单上是否漏项没人验过；②`walkBinDirs` 的 5 层深度上限是照「`host-commands/<product>/<version>/<arch>/bin`」估的，官方哪天再嵌一层（比如 `host-commands/<product>/<channel>/<version>/<arch>/bin`）就整个扫不到，表现是「卸载后安装目录里还留着 bak」，而这在沙箱里永远造不出来；③`remove_failed` 这条分支在真机上到底有多常见不知道 —— 沙箱里只能靠 monkeypatch `fs.unlinkSync` 抛 `EBUSY` 模拟，真实的 `EBUSY` 需要另一个进程正持有那个文件，本机这台 Windows 上实测「打开句柄也拦不住 unlink」，所以这条路径可能在生产里根本不发生，也可能是「只在被 Defender 扫描时发生」而我们永远复现不出来。**检测办法**：卸载一次后手工 `ls` 那两个密封 `bin` 目录，确认里面只剩 `dsh` / `dsh.cmd` / `dsh.ps1` 三个文件与官方自带的东西；`$DSH_HOME/dsh-purge/shim-backups/` 里应该恰好出现 `dsh.<20hex>.bak` 与 `dsh.ps1.<20hex>.bak` 两份。

62. **`sanitizeDesktopCommandRuntimes` 的调用时机只在卸载/重装路径上，平时一次都不跑 —— 也就是说它坏上几个月也看不出来。** 目前能触发它的只有三条路：`patchShim` 遇到密封目录时的短路回传、`uninstall.js` 的清理阶段、以及 `sanitize` 的手工调用。测试是直接调函数，跳过了「谁在什么时候调它」这一层；`scripts/test-uninstall.mjs` 用的是假 `core`，所以「卸载流程里到底有没有真的调 sanitize」在测试里是零守卫。**仍然测不到的**：①卸载流程真的走到这一步时，`findDshHome()` 是否已经指向一个被删一半的家目录（那时 `shimBackupPath` 会算到别处去）；②`patchShim` 的 `scrubbed` 回传在 `/purge revert` 的报告里怎么被渲染 —— `lib/chat-purge.js` 的 revert 分支只拼 `reverted` 与 `errors` 两个数组，`scrubbed` 那一段目前没有消费方，等于**搬走了但没人告诉用户**。**检测办法**：做一次真实的卸载再重装，看 `/purge revert` 的输出里有没有提「已把 N 份启动器备份搬出安装目录」；没有就是这一层断了，且不会有任何报错。

63. **备份还原这一簇钉住的是「给定输入时返回什么」，不是「真升级一次之后还能不能回退」。** `test-backup-revert.mjs` 的 58 条全在临时目录里跑，`targetFiles()` 走的是最小假树（三个文件 + 一个 client.js），`backupAll` / `revertAll` 的每一次调用都发生在「这棵树从没被真宿主写过」的前提上。**仍然测不到的**：①真宿主上 `.dshpurge.bak` 的编写时机是「`applyPatches` 写完文件之后、重启之前」，如果那个窗口里进程被强杀，bak 是完整的而宿主文件是半截的 —— 这个「半截状态」在测试里造不出来，而它正是 `restoreMissingOriginalsFromBak` 唯一想救的场景；②`refreshStaleBaksForUpgrade` 的六种跳过都靠「读两份 buffer 后比对」，真宿主上 `client.js` 有 545KB、`dsh-tools/lib/index.js` 有 27KB，八棵树同时刷新时的耗时与内存没进过测试；③`revertAll` 对符号链接是**写穿到真身**，而真宿主里 `profiles/web/node_modules/@deepseek-ai/*` 常常是 pnpm 的链接林，一次 revert 可能同时改到多个 profile 共享的同一份物理文件 —— 测试里只有一个符号链接、一个真身。检测办法：升级宿主前先 `npm run host:status` 记下 `applied` 数量，升级后跑一次 `/purge revert` 再 `npm run host:status`，两次的 `noFile` 与 `drifted` 数应当一致；不一致就说明有 bak 在升级窗口里被写脏了。
64. **`npm_config_prefix` 这条退路只在我这台机器上验过。** 沙箱化 `findNpmPrefix()` 靠的是「把 `npm_config_prefix` 指到临时目录，npm 自己会听这个环境变量」，实测 `npm_config_prefix=C:/tmp npm prefix -g` 会回 `C:\tmp`。但这条路有三处没验：①npm 大版本升级后是否仍读这个变量（v11 已经开始弃用部分 `npm_config_*` 环境变量映射）；②pnpm / yarn 的全局前缀探测完全不看它，`findNpmPrefix()` 若哪天改成先问 pnpm，沙箱会再次漏出去；③本机之所以会漏，是因为 `PATH` 上没有 `dsh` 启动器 —— 在装过 `npm i -g` 的机器上 `findShimDir()` 会先命中，这条退路根本不触发，**也就是说这个 bug 只在「PATH 干净但 npm 全局存在」的机器上出现，CI 的 ubuntu-latest 恰好是这种机器**。检测办法：跑任何会遍历 `listShimDirsForPatch()` 的测试前后，对 `%APPDATA%\npm` 下五个文件做一次 SHA-256 比对；变了就是又漏出去了。

65. **`lib/desktop.js` 里真正「会动手」的那一半里，还有四个函数一行都没测：`restartOfficialHarness`（125 行）、`scheduleAsarSwapRestart`（78 行）、`scheduleRestart`（53 行）、`spawnHelper`（24 行）。**（`repairOfficialCliAfterUnpack` / `ensureAppRuntimeSymlink` / `patchOfficialCliShimText` 三个已在批70 里补上，见盲区 67。） 这一批测的全是它们的**判据与文本**（`officialRestartScript` 生成什么、`officialRestartLogState` 怎么判、`unpackedHostIsClean` 何时算脏），而这些函数本体要做的事是「结束一个正在运行的 Electron 进程」「把 `app.asar` 改名」「把 `resources/app` 拷出去再 robocopy 回来」「起一个 detached 的 node helper」。在本机跑一次就等于把用户桌面上正在用的 DSH 关掉再打开 —— 所以测试里一律绕开，只钉它们读的那几个纯函数。**仍然测不到的**：①`restartOfficialHarness` 里 `planOfficialRestart` 的三个 kind 各自的分支（`powershell` 会真的 `spawn` 一个 `powershell.exe`、`wscript` 会写 `.js` + `.cmd` 再 `spawn("wscript.exe")`、`helper` 会 `spawn(process.execPath, [helper])` 且 `detached:true`）；②`ensureAppRuntimeSymlink` 在 `app.asar` 与 `resources/app` 之间做的那次链接切换是否真的让下次启动读到新代码（沙箱里没有 Electron 可启动）；③`repairOfficialCliAfterUnpack` 恢复 `lib/bin.js` 的那段 —— 它只在「官方升级把 bin.js 换成半截」时才有意义，而那个状态在沙箱里造不出来。**检测办法**：装一个 DSH 的副本到另一个目录，在副本上跑 `node scripts/host-rehearse.mjs`，然后手工点一次重启；看 `%TEMP%\dsh-purge-official-restart.log` 里是否有 `begin` / `started` 两行 —— 有就说明脚本真的跑过，没有就说明 `restartOfficialHarness` 这一层断了。 （批70 之后：②里「链接指向 `../runtime`」与「目标非空才算 already」已被行为用例钉住，但「下次启动是否真读到新代码」仍要靠 Electron 才能验；③仍完全没测。）
66. **`wscript` 那条重启分支在真机上永远走不到，而我们把它「锁定」成了正常状态。** `officialRestartScript` 生成的文本里带中文注释（`// null = 文件不存在或暂无法判断（首装、读失败）` 等 69 个非 ASCII 字符），`planOfficialRestart` 用 `isWshAscii(script)` 决定引擎 —— 于是永远选 `powershell`，`restartOfficialHarness` 里 `spawn("wscript.exe", ...)` 那 30 行是死代码。测试写的是**现状锁定**（断言恒为 `false` + 另立一条断言 `scriptAscii:true` 时才选 `wscript`），也就是**把 bug 写成了契约**。这不是无风险：如果哪天有人把注释翻成英文（很正常的做法），`wscript` 分支会突然活过来，而它从头到尾没被真跑过一次。**仍然测不到的**：`wscript` 分支里写 `.js` / `.cmd` 两个临时文件的路径拼接、`WScript.Shell` 的 `Environment("PROCESS")` 是否真的能改父进程环境（这是 WSH 的已知怪癖）、以及 `intWindowStyle=1` 在不同 Windows 版本上的最小化行为。**检测办法**：`grep -c '[^\x00-\x7F]' <(node -e "import('./lib/desktop.js').then(m=>process.stdout.write(m.officialRestartScript('x','y','z')))")` 只要不是 0，就说明这条分支仍是死的；真要用它，先补一条 `planOfficialRestart` 的端到端真跑（在副本安装目录上）。

67. **官方 CLI 三件套这一簇，钉住的是「写进 `resources/runtime/cli/bin` 的字节对不对」，不是「敲 `dsh` 真能起来」。** `test-desktop-cli-repair.mjs` 的 48 条全在 `mkdtemp` 造出来的假安装树上跑：`<root>/app/DeepSeek Harness.exe` 是写着 `MZ` 两字节的假 exe，`resources/runtime` 里的负载是按 `RUNTIME_MIN_BYTES` 手填的，`app.asar` 只是一个目录名。**仍然测不到的**：
    ① `officialCliShimBodies` 生成的三件套在真 shell 里可不可执行 —— 尤其 `.ps1` 首行就是 `# dsh-purge cli entry begin`（不是 `#requires` 也不是注释头），Windows PowerShell 与 pwsh 7 对「首行就是注释」的处理一致，但 `-File` 与 `-Command` 两种调用方式下 `$PSScriptRoot` 的语义不同，本机只验了文本；
    ② `repairOfficialCliAfterUnpack` 里 `atomicWriteSync` 写 shim 之后立刻 `chmodSync(0o755)`，真机上是否真让 `dsh` 可执行（Windows 上 chmod 是空操作，NTFS 的 ACL 才是真正的权限来源）；
    ③ `app/runtime` 那条 junction 是否真的让 Electron 从 `resources/runtime` 读到负载 —— 沙箱里建完链接只 `realpathSync` 比对了一下，没有 Electron 去消费它；
    ④ `healRuntimePayload` 从 `~/.dsh/dsh-runtimes/dsh-primary-runtime` 拷 1MB 级的 `node.exe` 时，真机上 `atomicCopyFileSync` 的耗时与中断恢复（测试里只有 2048 字节的 pnpm.mjs 与 1 字节符号占位的 node）。
    **检测办法**：`dsh --version` / `cmd /c dsh.cmd --version` / `pwsh -NoProfile -File <resources>\runtime\cli\bin\dsh.ps1 --version` 三条各敲一次；再 `node -e "console.log(require('fs').realpathSync(process.argv[1]))"` 确认 `app/runtime` 解析到 `resources/runtime`。任一条报「不是内部或外部命令」就是三件套没生成或入口退错级。
72. **报告链路的「交付物质量」还只测到「推得对不对」，没测到「读起来对不对」。** 这一批把四个导出的判定全钉住了（归因四档、gaps 五条、复现五级降级、分组众数、排序三键、依赖推导、代表截图分层、markdown 章节顺序），但三类东西仍在射程外：①**排版细节**（表格列宽、长文本 `clipText` 在哪个分隔符处断、`block()` 生成的代码围栏是否闭合）—— 只能靠人眼看一遍导出的 md；②**模板的「能不能真跑」**（`SCORE_CONFIRM` 里 25 条 script，本批只断言了 `boundary-logical` 与 `terminal-access` 两条的填值与 `unfilled` 判定，其余 23 条的占位符写法没有任何用例；真要验得在靶标上跑）；③**五级降级的「优先级」只用组合覆盖**（有抓包 / 有显式步骤命令 / 有隧道模板 / 只有普通命令 / 什么都没有，五种各一条；两两组合的先后只在 `capturedRequest + linkedTool` 和 `tunnel0 + confirm.script` 这两处被钉，其余组合没有）。**检测办法**：对一个真实靶标生成一次 `scoreReport().markdown`，把 §3 的每一条复现命令粘到 Burp/终端里跑一遍；跑不通的记下来，就是在射程外的那一类。

73. **`dispatch` 的 op 表钉住了「哪个 op 调哪个方法、第几个实参」，钉不住「那个方法本身算得对不对」。**
    `scripts/test-redteam-dispatch.mjs` 的接线段用记录型假 store，能抓住丢 `req`、别名失效、形参错位、`limit` 不夹、写闸门漏项；行为段用真 store 跑 20 个写 op 与 20 个读 op。但**真 store 只走了我播种过的那几条路径**：一台资产、一份凭据、一张截图、一个漏洞。`dispatch` 之后的库内实现（`listVulns` 的六种筛选组合、`attackGraph` 的跨靶标归并、`importBundle` 的部分失败回滚）仍然只有它们各自的测试文件在管，`dispatch` 这层对它们是透明的。
    **仍然测不到的**：①`dispatchAsync` 的 `probeSessions` 分支会在调用时真的**发 HTTP 请求**（连 `10.1.1.1:80` 要等 6 秒超时），所以整条异步探测路径只能用假 store 钉「转发对不对」，真连网的行为一次都没跑过；②`platformConfigSave` 写的是本机 `~/.dsh` 下的平台配置，测试只断言「回显的 config 里有什么键」，没有真落盘再读回；③`templateSearch` / `templateStats` 读 `~/.local/nuclei-templates`，本机没装模板库，所以 `total` 恒 0 —— 命中排序与去重那段没被执行。
    **检测办法**：改完 `dispatch` 之后，别只看 `node --test scripts/test-redteam-dispatch.mjs`，还要跑 `node scripts/test-redteam-report.mjs` 与 `node scripts/test-redteam-tool-branches.mjs`（它们才管 op 背后的算得对不对）；再在真机上开一次演练台面板，看九个读 op 是否都能出数。



74. **宿主树 / 主目录定位里「真的要去看一眼外部世界」的那几段还是空的。**
    `test-host-locate.mjs` 把判据与候选表钉死了（34 条，`lib/core.js` 81.7%），但那十四条判定之外仍有四处必须真的碰系统：
    **①`findDshHome` 的桌面分支**（`lib/core.js:1738-1747`）：`desktopHomeCandidates()` 要调 `desktop.findDesktopAppExecutable()` / `desktop.listDesktopInstallRoots()` 去扫真安装树，还要读 `process.resourcesPath`（只有 Electron 里有）。本机可以跑通，但结果依赖「这台机器装了哪些桌面版本」，写进用例就是在测环境，所以只钉了 web 面与 `desktopDshHomeGuesses` 这两段纯的部分。
    **②`findWslWindowsDshHome` 的命中分支**：本机没有 WSL，`/mnt/c/Users` 不存在，所以「扫到一个带 `.dsh` 的 Windows 用户目录并返回」那一段一次都没跑过 —— 只钉了「非 linux 恒空」与「linux 下没有 `/mnt/c/Users` 也空」。
    **③`findAiBaseFromDshHome` 的第四条路**（`findAiBaseFromRequire` 走 `createRequire` 解析 `@deepseek-ai/dsh/package.json`）：要一份能被 Node 解析器认的 `node_modules` 布局（含 `package.json` 的 `exports`），本机 fixture 造得出来但成本远高于收益，目前只有前三条路有用例。
    **④`requireFrom` / `findAiBaseFromRequire` 本身**：它们靠 `createRequire` 的解析顺序，改坏的表现是「装了但找不到」，而不是抛错。
    **检测办法**：改完这一簇，除了 `node --test scripts/test-host-locate.mjs`，还要在真机上跑 `npm run host:status`（看 `ai_base` 指的是不是 `resources/app/dsh/node_modules/@deepseek-ai` 那一份、`patches_applied` 是不是 79 左右）与 `node scripts/verify-target.mjs`（看 `would-apply` 是不是 0 附近）。
## 维护约定

- 补一行时，`守卫` 列必须写**能跑的东西**（脚本名或 npm 命令），不要写「已测试」。
- 覆盖率列用 `npm run test:full` 的实测值，别抄上次的。
- 从 `❗缺` 里挑活时，优先挑「改坏了没人能发现且用户能感知」的：第三节（提示词注入）与第四节的 HTTP 路由，排在计分口径前面——因为前者影响每一轮对话，后者只在打开演练台时影响。
