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
| 「到底该打哪一棵树」的选择链（`findAiBaseDesktop` / `findAiBaseWeb` / `pathIsUnder` / `enumeratePatchAiBases` 的 realpath 去重） | `test-host-tree-chain.mjs`（27 条：判据 4 / 安装树 3 / 选树 9 / 去重 4 / 坏候选 3 / 源码形状 1） | `lib/core.js` 85.7% |
| 「一键应用到所有宿主 / 全部回退」真的每棵树都走到（`applyPatchesAllHosts` / `revertAllHosts` / `allPatchHostsWritten`） | `test-all-hosts.mjs`（23 条：全部成功判定 4 / 应用 9 / hooks 还原 2 / 回退 4 / 去重与安全 2 / 源码形状 2） | `lib/core.js` 87.6% |
| 所有便宜探测落空后的「深度兜底扫描」不会把错的东西当宿主树（`findAiBaseRecursive` / `scanHomeRootsForAiBase`） | `test-deep-scan.mjs`（18 条：三种 node_modules 落点 3 / 深度边界 2 / 链接与只读 3 / 跨设备 1 / 去重与去环 3 / 根清单 4 / 源码形状 2） | `lib/core.js` 88.8% |
| 红队预设能找到宿主那份 `@deepseek-ai/dsh-tools`（四条候选规则 / 29 条候选表 / 主目录优先级 / 槽位自动释放） | `test-tools-resolve.mjs`（24 条：`addCandidate` 4 / `considerBin` 5 / 候选表 6 / 解析 5 / 槽位释放 3 / 源码形状 1） | `lib/redteam/tools.js` 93.7% |
| 判错时不报错：打到 Electron 外壳那份树（全场 `no-file`）、或把 `~/.dsh` 当成桌面版在用的 `dsh-home` | 同上（候选表逐项顺序 + `portableHomeFromLauncher` 顺序 + `desktopDshHomeGuesses` 三平台） | 同上 |
| 桌面主目录定位的六级回退（`DSH_HOME` trim → 候选里有 harness 数据 → `~/.dsh` 有数据 → 候选全空数据时回 `found[0]` → 什么都没有仍返回 `~/.dsh` 路径 → web 面先看启动器旁 portable） | `test-dsh-home-desktop.mjs`（15 条：`homeHasHarnessData` 1 / `isDshHomeDir` 1 / `desktopDshHomeGuesses` 2 / 桌面回退 6 / `DSH_HOME` 1 / web portable 1 / `portableHomeFromLauncher` 1 / `findWslWindowsDshHome` 1 / 源码形状 1） | `lib/core.js` 行 4671/5205 |
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
| 宿主 `bin.js` 注入 hide-console 的 import：sidecar 与 facade 先落盘、再改 bin.js，重复注入只返回 `already_injected` | `test-hide-console.mjs`（13 条） | `lib/hide-console.js` 行 99.1% |
| 还原：双引号 import 行全清（`/gm`）、源码树的 bin.js 一个字节都不碰、bin.js 读失败时宁可多留一轮 sidecar 也不改它 | `test-hide-console.mjs`（6 条） | 同上 |
| 六个入口的 `windowsHide` 补位：`spawn`/`fork` 的 args-即-options 重载、`execFile` 四种参数形态、非对象 options 原样透传 | `test-hide-console.mjs`（5 条） | 同上 |
| hide-console 的三条兜底：`getBuiltinModule` 抛错退回 `createRequire` / 没有 hint 时用 `process.argv[1]` 的上两级 / sidecar 删不掉算「没改过」 | `test-hide-console.mjs`（批93 +4 条） | `lib/hide-console.js` 行 336/339（99.1%） |
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
| `saveRule` 的三条回滚分支（新规则删文件 / 旧正文退回原字节 / meta 有就写回、没有就删掉），以及激活时读不出来的规则只跳过不拖垮备份 | `test-rules-rollback.mjs`（16 条） | `lib/rules.js` 行 99.8% |
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
| 四档降级的每一档都能单独走到（破密封槽→缓存空→再放行 `hung`/`disk`/`sealed`；四档全空回空串；熔断靠真慢 1700ms 触发、冷却期内只交内存钉子）、空提示词闸门与重启前体检的转发、`capabilityProtocolText` 只认 `enabled` | `test-prompt-source-edges.mjs`（15 条） | `lib/prompt-source.js` 行 363/363 |
| 提示词分段注册 `registerPromptSections`（默认 `dsh-purge@-100000` + `dshpg-capabilities@-99999`、`interpolate:false`、`capabilityProtocol:false` 只挂一段、`postPrompt` 挂第三段 `dsh-purge:post@7`、非法的 `postPromptOrder` 只警告并跳过、`already registered` 不算失败、多段全抛时抛最后一个） | `test-prompt-source.mjs`（9 条） | 同上 |
| 注入快照与闸门 `injectSnapshot` / `rejectIfNeedPrompt` / `ensureRestartReady`（快照三字段形状、空提示词时回 `needPrompt:true` 与固定文案、重启前先问 `core.ensureHostClean()`） | `test-prompt-source.mjs`（8 条，含文案与形状的源码断言） | 同上 |
| 装配决策输入 `shouldInjectAssembly` / `readSessionEvents`（默认 full/general、只有 `origin:"subagent"` 算子会话、续跑标记只消费一次变 `lastRole:"retry"`、事件优先 `snapshotEvents` 抛错退 `events` 再兜 `[]`） | `test-prompt-source.mjs`（8 条） | 同上 |
| 诊断日志 `purgeLog` / `logAssembleDecision`（`ISO [tag] k=v` 单行、值里的空白换 `_`、`undefined` 写空、对象写 `[object_Object]`、超 2MB 翻滚成 `.1`、装配决策固定四字段） | `test-prompt-source.mjs`（5 条） | 同上 |
| mnemon 插件消息剥离 `installMnemonMessageStrip`（没 `ctx.on` 不落标记、装一次挂一条带 `global+prepend`、重复安装被标记挡住、`mounted` 闸让微任务补挂只补一次且 1500ms 迟到重试不叠第二层、没滤掉返回同一对象、`messages` 不是数组也补成 `[]`、`stripMnemon:false` 一条都不滤） | `test-inject-write.mjs`（12 条） | `lib/inject-write.js` 行 363/363 |
| 每轮装配改写 `rewriteLiveAssembly`（默认段序 `dsh-purge`→`dshpg-capabilities`→原段→`deployment:persona-suffix`→`dsh-purge:anchor`、`enabled:false` 只挂 3 段、`stripMnemon:false` 保留 `mnemon-memory`、`anchorMode:"off"` 去掉锚点段） | `test-inject-write.mjs`（4 条） | 同上 |
| 改写缓存的签名覆盖面（`policy` 从 `fallback` 变 `strict` 变 `always` 每次都必须重算、`revision` / `session` 参与签名、命中判定必须比 `undefined` 不能真值判断、换 assembled 对象不复用、cwd 落 `last-cwd.txt`） | `test-inject-write.mjs`（5 条，含 `if (cached !== undefined) return cached;` 的源码断言） | 同上 |
| 装配诊断行 20 个字段（字段顺序固定、`afterCloser` 必须是正数、`anchorApplied` 默认 `true` 关掉锚点时 `false` 且 `injectTail:false`、`chatml` 命中 `<project_instructions>`、`injectBytes` 万级） | `test-inject-write.mjs`（3 条） | 同上 |
| `closerFollowBytes`（闭标记之后还剩多少字：没有段/没有标记一律 `-1`、多段先按空行拼、闭标记出现多次按**最后**一次算、空段被 filter 掉） | `test-inject-write.mjs`（4 条） | 同上 |
| 装配挂载 `installIdentityOverride`（4 类钩子与 `global/prepend` 选项、`__dshPurgeDisabled` 停用立即生效、有 next 用下游结果而下游抛错退回上游、旧签名自己动手、`next` 取最后一个参数不是 `args[2]`、guard 内层抛错给空装配、`prepareAssemble` 幂等且隔离层补分段与锚点、`guard.wrap` 签名不变不刷日志、cleanup 清六个 flag 且能重装、400ms 轮询必须 unref） | `test-inject-write.mjs`（15 条） | 同上 |
| 三条只在非常态下才执行的出路：mnemon 层挂不上时的 1500ms 重试与 effect 回收（不清定时器会多试一次、不摘 disposer 会叠层）、提示词正文读不出来（密封槽坏）时退到用户勾选的本地 cwd 规则、气闸里 `rewriteLiveAssembly` 抛错时原样退回上游装配 + 一行 warn；三条 `ctx.on` 回调被真的调用后必须把新代理补包 | `test-inject-write.mjs`（+6 条） | `lib/inject-write.js` 行 363/363 |

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
| `/rewind` 的五段静默失败：等轮次关闭的读盘次数与超时文案、`sessions.get` 抛错原样冒泡、`cancel:false` 一次都不 cancel、inbox 去重摘除（含日志里待发的）、串行锁的 onRejected 分支 | `test-rewind-edges.mjs`（23 条） | `lib/rewind.js` 行 580 → **618/644（96.0%）** |
| `/rewind` 的第二批兜底：`service` / `getAgent` / `liveSession` 在被调用方自身抛错时一律回空、`observeSession` 句柄的 disposer 一定被调用且抛错被吞、`resetRequestSeries` 三个字段各自独立兜错（含 getter 抛错）、父子指针成环时回到入口会话、`createBlank` 的三级建法、`hideRewoundSource` 的 registry → workspaces → detachSession 三级、草稿与 pending 的到点作废（替换 `Date.now` 模拟，拨回时钟后再查一次） | `test-rewind-edges2.mjs`（24 条） | `lib/rewind.js` 行 618 → **644/644（100%）**、分支 365/365 |
| `/rewind` 的收件箱与子会话：只收最后一次 `turn/end` 之后的 `next-turn` 插入、去重保序；本轮子会话按 catalog/descriptor 去重保序 | `test-rewind.mjs`（5 条） | 同上 |
| 3 个模型工具（`purge_status` / `purge_apply` / `purge_revert`）的名字、空 parameters、output schema | `test-command-surface.mjs` | `lib/tools.js` 100% |
| 三个工具的执行分支（无宿主直接报错、需确认时停手、applied/already/scrub 统计、回滚同时收 shim） | `test-command-surface.mjs` | 同上 |
| 工具目录与配置落盘：`TOOL_CATALOG` 15 条（`names` 与 `adapt` 两份清单互校）、`save` 的增量合并（`platform` 非法保留旧值、`binDirs` 非数组保留旧值、布尔开关只在 `!== undefined` 时改）、落盘 JSON 补齐全键并 trim | `test-platform-config.mjs`（12 条） | `lib/redteam/platform-config.js` 行 612/612 |
| 四条「读不到就看下一条」的出口：Python 判据打不开就回 false、别名对撞时单条 stat 失败只跳过那一条、扫盘时文件夹读不动要说「无法读取」而不是「不存在」、Kali 上 os-release 读不到要退回看标记目录；外加「条目没有 `isDirectory` 时退回 `statSync` 判类型」（子目录要另起一条才分得出来） | `test-platform-config-edges.mjs`（18 条） | `lib/redteam/platform-config.js` 行 612/612 |
| 找工具的六条路：配置的绝对/相对路径（不存在时 `source:'missing'` + `note`）、`toolkitDir`、`binDirs`、`PATH`（`PATH` 与 `Path` 都认）、Linux 回退目录、`bin`/`Bins`/`tools`/`Tools` 四个子目录 | `test-platform-config.mjs`（13 条） | 同上 |
| 扫目录认工具：深度夹在 1–6（`maxDepth:0` 是 falsy → 走默认 4，现状锁定）、文件数夹在 100–20000、跳过点开头/`node_modules`/`.git`、同名多份按 `names` 排名先高后低、顺手认 `nuclei-templates` 目录 | `test-platform-config.mjs`（7 条） | 同上 |
| 环境适配状态：`kali` → `skipped` → 已存路径（`toolkitDir` 或 `binDirs` 或任一 `tools[id]`）→ `found >= 2` → `need-config` 的优先级，以及 `assignToolkitFolder` 把新目录 `unshift` 到最前 | `test-platform-config.mjs`（10 条） | 同上 |
| 宿主面分派：`hostAdapter` 按面挑适配器（桌面端拿到含 `ASAR_SWAP_PS1` 的那份，web/gui/tui 拿同一份），`adapterFor` 只吐 `web`/`desktop` 两个值 | `test-host-restart.mjs`（4 条） | `lib/host.js` 86% |
| 宿主面判定：`pathLooksDesktop` 光有 harness 名字不算（还要带 `/resources` 或 exe）、`resourcesLookLikeDesktopInstall` 三条真判据（`app.asar` 必须是文件 / `app/dsh` / `app.asar.unpacked/dsh`）、`isCommunityElectronHost` 要求 `versions.electron` 才看 `resourcesPath`、`detectSurface` 优先级「社区壳 > `DSH_SURFACE` > 面判据 > web」（社区壳压得住 `DSH_SURFACE=web`，`DSH_SURFACE` 压得住 exe 名）、`gui`/`tui` 原样透出只由 `adapterFor` 折成 web | `test-surface-detect.mjs`（29 条） | `lib/surface.js` 行 139/139 |
| 重启参数怎么算：有 bin.js 时改写成 `[binJs, ...rest]` 并补 `web --port`、`.cmd`/`.bat` 换成 node_modules 里的 bin.js、永远补 `--no-open` 且不重复 | `test-host-restart.mjs`（9 条） | `lib/web.js` 行 117/117 |
| 后台重启的两条路：`spawn` 用当前 node 跑助手、`detached`+`stdio:ignore`+`windowsHide`+`shell:false` 四个选项、`unref` 一次、250ms/400ms 两个延时、payload 八键（`openBrowser` 用 `??` 不用 `||`）、提示语抛错不影响重启、子进程 env 不带 `DSH_PERMISSION_MODE`、清理重启把 `uninstall-restart.js` 逐字节复制到 `os.tmpdir()` 再跑副本 | `test-web-restart.mjs`（13 条） | `lib/web.js` 行 117/117（分支 34/35） |
| 子代理审批接管：两个钩子都必须 `global`（`approval/request` 还要 `prepend`）、只在子会话把 `never` 改回 `ask` 且每会话最多 4 次、子会话审批一律 `allowed-once`、释放时摘钩子 | `test-host-restart.mjs`（13 条） | `lib/subagent-control.js` 100% |
| 三条静默出口：读会话事件两条路都炸时给空数组、`ctx.on` 三参不被认时退回两参（不再传 `global`；两参也不认就一个钩子都不挂，尝试次数 4）、续跑那句 `followup` 抛错时退名额 + 留且只留一行 warn、退款之后同一失败点不再重试（换新 seq 才看得到名额回来） | `test-continue-retry.mjs`（+5 条） | `lib/continue-retry.js` 行 364/364 |
| 自动续跑与自动重试的判据：哪一类结束原因算异常（error / aborted / interrupted / max-tokens）、用户取消不续跑、永久码（鉴权/配额/上下文超限/缺凭据）与 `TRANSPORT`/`RATE_LIMIT` 不续跑、`signal.aborted` 不重试 | `test-continue-retry.mjs`（10 条） | `lib/continue-retry.js` 行 364/364 |
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
| 13 条 `exact` 路由的注册面（路径、顺序、标签唯一、都是 `exact`） | `test-exact-routes.mjs`（1 条） | `lib/routes.js` 99.9% |
| 只读路由的方法白名单与参数：`status` / `last-user` / `rewind/options` / `rewind` GET / `hooks-deny` GET | `test-exact-routes.mjs`（11 条） | `lib/routes.js` 99.9% |
| `/status` 的四种形态：进度期回上次载荷、未就绪 503、就绪全字段、`gatherState` 抛错 500 | `test-exact-routes.mjs`（4 条） | `lib/routes.js` 99.9% |
| `/apply` 的整条链：405、定位失败、无宿主、需提示词、成功时 10 步副作用顺序、`pattern_not_found` 仍可重启、`write_failed` 不重启 | `test-exact-routes.mjs`（8 条） | `lib/routes.js` 99.9% |
| `/revert` / `/uninstall` / `/drill-grant` / `/override` / `/own-servers` 的守卫与副作用 | `test-exact-routes.mjs`（14 条） | `lib/routes.js` 99.9% |
| `/restart` 的三道闸：清洗未完成、`clean:false`、密封包走 `restartSealedDesktopIfNeeded` | `test-exact-routes.mjs`（6 条） | `lib/routes.js` 99.9% |
| 13 条路由的**失败出口**：每个依赖抛错都回 500 且收尾进度、方法不对一律 405、排重启/修 CLI/seed 三类「只告警不拦」的分支、坏 JSON 与超 512KB 请求体 | `test-exact-routes.mjs`（22 条） | `lib/routes.js` 行 689/690 |
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
| 卸载链路：`uninstallPurge` 的三条早退与六处「失败只记一笔」、`collectCleanupDirs` 的去重与 `/resources` 闸门、两份 `rmTree` 的 `OWN_TREE` 判据（npm link 装的插件不许把源码目录放进清理列表） | `test-uninstall-purge.mjs`（33 条） | `lib/uninstall.js` 行 298/316、分支 123/135 |
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
| `apply()` 只在坏宿主上才走到的那几条：`connection` 的 `inject` 抛错也把 `/status` 标成 200（16 条路由照注册）、profile 自愈真写了才记账、settle 定时器两种醒来方式（活着跳过 / 自己睡醒报结论）、桌面面两条自愈分头记账（`[heal-runtime-payload]` 必有、`[heal-office-skills]` 看机器）、anchor/subagent 装配抛错被吞成 `[apply-hooks]` 一行、`/purge` 一次注册四条命令且本体回帮助文本 | `test-plugin-apply-edges.mjs`（15 条） | `lib/index.js` 行 419/429 |
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
| `revertCmdFlash` 的五处逐字节回退：subprocess 的 `windowsHide` 连注释与**注入时补的逗号**一起摘、custom-bash 的三行防线回到 `return await ctx…`、phase1 折回 LF 后还原人设集合与 filter 并摘两条注释、doctor 的 spawn 包装 / `dshSpawnSpec` / stdio 三处各归位、market 的 `respawnInvocation` 与 import 两行；外加「传进来的 aiBase 必须传下去」「七个 key 的顺序」「五个清单函数的候选与去重」 | `test-cmd-flash-revert.mjs`（37 条） | `lib/core.js` 84% |
| `patchShim` 的三个入口守卫：无目录回 `{error:"no_shim_dir"}`（`""` / `null` / `undefined` 三种入参都算）、空目录三个 `missing` 且一个文件都不新建、键顺序固定 `dsh.cmd` → `dsh.ps1` → `dsh`（`SHIM_NAMES` 的顺序就是写盘顺序） | `test-shim-patch.mjs`（3 条） | `lib/core.js` 73.85% |
| 密封桌面目录短路：`DSH Desktop/host-commands/bin` 与 `DeepSeek Harness/runtime-commands/bin` 都回 `{skipped_sealed_desktop:true, scrubbed:[…]}`，**目录内容一字不动、不落 bak**；形状像密封但不是 `bin` 结尾的路径不短路 | `test-shim-patch.mjs`（4 条） | 同上 |
| `isTextShim` 的二进制判定：NUL 出现在偏移 300（超过只读的前 120 字节、仍在前 512 内）也算二进制、零字节文件算二进制、`Write-Host` 开头算二进制；`#` / `REM` / `@echo` / `#!` 四种开头算文本；`openSync` 抛错时按二进制跳过，不冒险往里写 | `test-shim-patch.mjs`（6 条） | 同上 |
| 注入与幂等：sh 启动器插在 shebang 之后、正文一字不动、bak 内容等于原文、二次调用回 `already_patched`（mtime 不变）且**不重建**被删掉的 bak | `test-shim-patch.mjs`（4 条） | 同上 |
| `dsh.cmd` 的两条分支（`isWindows` 是模块级常量，只能按真实平台断言）：Windows 上只剥不注入 —— 没注入回 `skipped_win_cmd`、已注入回 `stripped_win_cmd` 且剥完 `end` 行删掉、`begin` 行留着（现状锁定）；非 Windows 上照常注入并补 `@ECHO off` 兜底行（那条兜底只能源码形状钉，Windows 上走不到） | `test-shim-patch.mjs`（4 条） | 同上 |
| legacy 与剥离：`DSH_PERMISSION_MODE` 让 `shimInjectCurrent` 判假（已注入也重打，`begin` 计数变 2）、旧单行头整段换新块、`stripShimInject` 六形态（闭合块 begin 占位 / 旧头带关键字 / 旧头不带关键字 / 旧头之后不复位 / 未闭合整份原样返回 / 末行无换行只剩 begin）、悬空 begin 再打会变两个 begin（现状锁定，二次才 `already_patched`） | `test-shim-patch.mjs`（8 条） | 同上 |
| 符号链接与 module root：真链接写的是目标文件、链接仍是链接、bak 落在目标旁边；悬空链接先被 `isFile` 判 false 记 `missing`；`dsh-app-boot` 找不到时 **Windows 是「写完才发现」`error:module_root_lost`，非 Windows 是事前拦 `skipped_no_module_root` 且一字节不写、不落 bak** | `test-shim-patch.mjs`（4 条） | 同上 |
| apply 把软链启动器覆盖成 bin.js 拷贝之后的自愈链（#157）：官方入口三个候选位置、向上八层找 `dsh-app-boot`（空目录也算）、相对链接一律正斜杠且 `..` 开头不补 `./`、先 `unlink` 再 `symlink`、`catch` 回空串、win32 与非 `dsh` 名字都不动、两种 `skipped_no_module_root` 出口 | `test-shim-launcher-heal.mjs`（18 条） | `lib/core.js` 行 4714/5205 |
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
| #42 的两步前置改写：`legacyApplyPath` 定义叠了多份要折叠成一份（留第一份正文、末尾收成两个换行、CRLF 原样还原、第二份没闭合则切到文件末尾）、残留的 `=> legacyApplyPath(section, op)` 全部换成 `=> applyPathOp(...)`、没有这个函数时一个字节不动；`patchApplied` 的 #42 两条额外判据排在 markers 之前 | `test-legacy-apply-collapse.mjs`（25 条） | `lib/core.js` 行 4747/5205 |
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
| 报告正文边角（长备注按句子截断 / 档位校正段 / 截图归属指路 / 步骤去重）与一段重复兜底的删除 | `test-report-edges.mjs`（14 条）+ `test-score-report.mjs` | `lib/redteam/score-report.js` 行 1457 → **1496/1510**（删掉 28 行死代码，分母 -22） |
| 报告的「完整性判据」本身：账号类（`web-app` / `db-credential`）没挂凭据、突破类（`boundary-*` 四条）没登记隧道时，必须报缺口而不是让 `complete` 恒为 `true`；外加拿真 `score_point` 表对拍判据里写死的 code、以及报告正文里 WebShell / 凭据 / 通道三行 | `test-report-fidelity.mjs`（9 条）+ `test-score-report.mjs` | `lib/redteam/score-report.js` 行 1516/1523 |
| 报告链路的两处边角：复现命令的「真实 curl」分支（推断来的步骤也要原样给出、标 `real`；多步骤取第一条带 tool 的）与「同阶段同时间」的排序第三级键（最小步骤 seq，没步骤回 `MAX_SAFE_INTEGER` 排最后）；顺带锁定「返回的 items 数组顺序 ≠ chain_no 顺序」 | `test-report-chain-order.mjs`（6 条） | `lib/redteam/score-report.js` 行 **1523/1523（100%）** |
| 目标宿主声明与宿主版本门禁：`HOST_TARGETS` / `HOST_TARGET` / `hostCompat` 的 known·ok·host 三态、预发布后缀原样相等、`dshTargets` 含 `dshTarget` 且无重复、每一项都能被 `parseHostVersion` 解析 | `test-host-target-decl.mjs`（9 条）/ `test-package-integrity.mjs`（13 条） | `lib/core.js` 宿主门禁段 100% |
| 官方 CLI 三件套（`resources/runtime/cli/bin` 下的 `dsh` / `dsh.cmd` / `dsh.ps1`）：首装现场生成、已有就只打回退块、打完留 `.dsh-purge.bak`、`app/runtime` junction 指向 `../runtime` 且目标非空才回 `already` | `test-desktop-cli-repair.mjs` | `lib/desktop.js` 行 71% → **79.8%**（1624 → 1812 / 2273） |
| 桌面面 shim 三件套的来源：先看桌面树的 `resources/runtime/cli/bin`（只看目录存在、不看里面有没有启动器），没有再回落 PATH 并标 `path`，两处都没有才是 `none`；桌面官方 CLI 的补丁是入口回退块不是 shim 注入，`dsh` / `dsh.cmd` / `dsh.ps1` 各判一次（`patched / missing / patched`）；`runtime_payload` 只在 desktop 面探。链式补丁（`#46←#45`、`#84/#92←#83`、`#88←#87`）前驱没 settled 记 `pending` 不记 `drifted`，`after` 里的字符串 id 先归一化成数字、非数字条目丢掉、不是数组就当没有前驱 | `test-desktop-shim-source.mjs`（21 条） | `lib/core.js` 行 4793/5205 |

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
**二十八补**：`lib/core.js` 的「卸载/回退那一侧」—— `revertCmdFlash` 与它的两个私有帮手（`worseRevertHit` / `rewriteFiles`）、五个清单函数，之前**一行都没跑过**。

这一簇是十一补那批 `silence*` 的逆操作：卸载插件、回退补丁、升级后自愈，走的都是它。判错的表现比注入侧更安静 —— 注入错会闪黑框（用户看得见），**回退错只会留下痕迹**：宿主里还躺着 `[dsh-purge]` 标记、`windowsHide: true` 还在、`resolved` 还是被改写的那一段，而 `dsh-purge` 自己已经卸干净了，谁也不会再去看那份文件。更坏的一种是「回退得差一个逗号」：文件还能跑，但和原文不再逐字节相同 —— 下次拿 `.dshpurge.bak` 对拍会以为是别人改的，`verify-target` 也会把它算成另一个状态。

新增 `scripts/test-cmd-flash-revert.mjs`（**37 条**），`lib/core.js` 行覆盖 4241 → **4364/5194（84.0%、+123 行）**、函数 293 → **299**、分支 1406 → 1456。

这一批顺手修掉两个真 bug，形状都是「一处判对、另一处判错」：

- **`revertCmdFlash(aiBase, dshHome)` 的 subprocess 分支不听 `aiBase`**：形参收下了，闭包里却另起一次 `findAiBase()`。平时两者相等，所以看不出来；一旦调用方指定了树（升级后对旧树回退、`host:preview` 里的沙箱回退），回退就打在**另一棵树上**，指定的那棵纹丝不动、返回值还是 `reverted`。修法是把 `aiBase` 一路传给 `listSubprocessLocalFiles(dshHome, aiBase)`。
- **subprocess 的 `windowsHide` 回退不是逐字节的**：注入时会在 `detached:` 那行补一个逗号，而回退用的两条 `String.replace` 里第一条就把「注释 + `windowsHide: true`」整段吃掉了，于是第二条（专门处理前置逗号的那条）永远匹配不到，逗号留了下来。现在合并成一条 `/,?\n\t\t\/\/ …\n\t\twindowsHide: true/`，逗号随注释一起带走。

几条**只能跑出来**的现状：

- `worseRevertHit` 的 rank 是 `missing`(0) < `absent`(1) < `reverted`(2)，`error:` 前缀无论先后都赢 —— 也就是「一次写失败之后，后面的成功不许把它盖掉」。这条只有把「先失败后成功」和「先成功后失败」都跑一遍才立得住。
- `rewriteFiles` 里「读到不存在的文件」是**跳过**，不是失败；同时它**不许提前收工** —— 第一份读不到、第二份还能改，返回值必须是 `reverted`。这两条分别对应「跳过」与「别 return」两个方向，任何一边改错都会让卸载少退一份文件。
- doctor 的 `dshSpawnSpec` 回退有**前置闸门**：文件里必须出现 `[dsh-purge] dsh.cmd → node bin.js (no cmd.exe)` 才会替换。fixture 漏了这行标记，回退就是静默不动，而返回值照样 `reverted`（因为前一段 spawn 包装确实还原了）。
- `listLiangshenBootstrapFiles` 是**按面分两份**的：`DSH_SURFACE=web` 只收 `profiles/web/…` 与 `.agent-presets/…`，`desktop` 只收 `profiles/desktop/…` 与共享那份。写用例时若只造一份 fixture，两个面都会「通过」，改成两份才看得出 `keepSurfaceFile` 到底在筛什么。
- `listSubprocessLocalFiles(dshHome, aiBase)` 的去重是有意义的：`aiBase` 指到 `profiles/web/node_modules/@deepseek-ai` 时，它推的第一条与 profile 循环推的那条是**同一个绝对路径**，出现两次会让 `revertCmdFlash` 对同一文件回退两次（第二次必然 `absent`，把 `reverted` 顶成 `absent` 的旧 rank 规则下就是真的误报）。

RED 演练 **33 条突变 → 33/33 全红**（`{"restored":true,"total":33,"red":33,"green":[],"anchor":[]}`）。第一批跑出来是 19 红 / 12 绿 / 2 ANCHOR，三处处置都写进了纪律：①两条 GREEN 是「突变方向没被用例覆盖」（`?? 0 → ?? 9` 只影响 `next` 是未知词的那一侧；`absent` 那一支只在前一份已 `reverted` 时才有区别）→ 补两条反向用例而不是删突变；②`市场 needle` 那条 GREEN 是因为用例只断言了「marker 没了、import 两行」，没断言**win32 头逐字节回到原文** → 补 `assert.ok(text.includes(MARKET_HEAD))`；③两条 ANCHOR 是 drill 自己的 bug —— 我的 `fix()` 把已经含 `\r\n` 的锚点又按 `\n` 换成 `\r\n`，产出 `\r\r\n`（教训：归一化要 `replace(/\r\n/g,"\n")` 先抹平再补 EOL）。



**二十九补**：`lib/core.js` 的「到底该打哪一棵树」—— `findAiBaseDesktop` / `findAiBaseWeb` / `pathIsUnder` / `enumeratePatchAiBases`。二十七补钉的是「怎么找到候选」，这一补钉的是「候选摆出来后选哪一个、同一棵树会不会被算两次」。判错的表现和上一补一样安静，但后果更直接：补丁全打在 Electron 外壳那份上，`targetFiles()` 返回 0 文件，状态页一片 no-file，看着像「这个版本全不兼容」；或者同一棵真宿主被算成两棵，`applyPatchesAllHosts` 打两遍（第二遍自然全是 already，但报告里的「宿主数」就永远比真实多一）。

关键突破是**真宿主探测链可以在沙箱里跑**：`desktop.findDesktopAppExecutable()` / `listDesktopPackageRoots()` 都吃 `process.env.DSH_DESKTOP_INSTALL`（逗号或分号分隔），所以造一棵 `<dir>/DeepSeek Harness.exe` + `resources/app/dsh/node_modules/@deepseek-ai` + `dsh-agent-instructions/lib` + `dsh/package.json` + `resources/runtime/cli/bin/dsh.cmd` 的树，就能让整条链走到真分支，而全程只碰临时目录。新增 `scripts/test-host-tree-chain.mjs`（**27 条**），`lib/core.js` 行覆盖 4364 → **4454/5198（85.7%、+90 行）**、函数 299 → **305**、分支 1456 → 1509。

这一批修掉一个**从 1.1.94 起就没生效过**的去重：

- `enumeratePatchAiBases` 的 `add()` 里写着 `real = fs.realpathSync.native(n)`（注释还标着 M37「避免 symlink / junction 两条路径打成两套」），但这里的 `fs` 是 `hostFs`（`lib/extract-asar.js:164`）—— 它的同步方法被 `route()` 包成箭头函数，**`hostFs.realpathSync.native` 是 `undefined`**，于是每次都抛 TypeError 被 `catch` 吞掉，去重键退化成路径字符串本身。实测：一个 junction 指向同一棵树时会进两条，`applyPatchesAllHosts` 里第二道 `path.normalize` 去重也救不回来（两条路径字符串不同）。现在先试 `nodeFs.realpathSync.native`（`node:fs` 里那个真 native），失败再退 `hostFs.realpathSync`，最后才保持原样。
- 顺带发现**非 native 的 `realpathSync` 对 junction 会返回 8.3 短名**（`ADMINI~1`）：一条路径解析成长名、另一条解析成短名，键仍然不同。所以这条回退只对「不涉及 junction」的路径有效，真正解决 8.3 与长名归一的只有 native 那条。用例把两种形态都造了出来（`test-host-tree-chain.mjs` 的第 2、3 条去重用例）。

几条**读源码想不到、只能跑出来**的现状：

- `findAiBaseDesktop` 的 `owned`（从 `process.execPath` 推出来的那份）**永远优先于**「当前进程是官方 exe 就返回 null」那道闸门 —— 也就是说，只要机器上能 discover 到安装树，官方 exe 闸门就走不到。用例里只钉了「`owned` 为空时才轮到它」，以及它的兄弟分支「祖先链上捡到的 AI 根必须在桌面安装树里，否则回 null」。
- `enumeratePatchAiBases` 的第一条永远是**仓库自己的** `node_modules/@deepseek-ai`（`findAiBaseWeb()`），所以在开发机上跑 `applyPatchesAllHosts` 会连 devDependencies 那份一起打。这是现状，写进了用例（`仓库自己的 node_modules 也在表里`）与盲区。
- 候选表里 `DSH_BASE` 那一条（`if (env) add(path.normalize(env))`）在真实调用序列里是**冗余**的：指到桌面安装树里会被 `findAiBaseDesktop` 先收走，指到树外会被 `findAiBaseWeb` 先收走。它唯一的作用是「两处都拒了的坏候选也别塞进来」，所以只能钉「不是 AI 根就不进表」这一面。
- `pathIsUnder` 的 `!c` 守卫是**冗余**的（空 child 既不等也不前缀于任何 root）；`findAiBaseWeb` 的 `if (env && env.trim())` 条件里的 `trim` 也是冗余的（函数体里那句 `path.normalize(env.trim())` 才是真归一）。这两处都按「改完说不出用户会看到什么不同」从 RED 演练里删掉，而不是硬凑用例。

RED 演练 **15 条突变 → 15/15 全红**（`{"total":15,"red":15,"green":[],"anchor":[]}`）。第一批是 24 条 / 11 红 / 13 绿，处置分三类：①**补用例** 6 条（空格 DSH_BASE、`./..` 归一、非 AI 根不进表、`app.asar.unpacked` 真目录经包根进来、安装树里的自定义 AI 根、祖先链捡到的根不在安装树里）；②**删等价突变** 6 条（上面列的冗余守卫 + `resolveDesktopAiBase` 自己会从 execPath 推 resources，喂空 `resourcesPath` 无差别）；③**写进盲区** 1 条（官方 exe 那道闸门在能 discover 到安装树的机器上不可达）。

**三十补**：`lib/core.js` 的「一键应用到所有宿主 / 全部回退」—— `applyPatchesAllHosts` / `revertAllHosts` / `allPatchHostsWritten`。二十九补钉到「从一堆候选里选哪一棵树」，这一补钉的是**选完之后有没有每一棵都真的打上、撤回时有没有每一棵都撤干净**。这是用户点「应用」「回退」时唯一走的那条路，而它此前只有单树的 `applyPatches` 有测试。

判错的表现比前两补更安静：状态页是绿的（它读第一棵树）、`host:status` 的 verdict 也是 ok，可第二棵树压根没打；回退时同理，剩下一棵树带着注入继续跑。第三种失败更难发现 —— 遍历表里混进了**仓库自己的 `node_modules/@deepseek-ai`**，于是「应用」把本项目的 devDependencies 也打了补丁，只有 `npm ci` 才会复位。

几条**读源码想不到、只能跑出来**的事实：

- **`DSH_BASE` 必须始终指向沙箱里的树，否则会真打仓库**。`findAiBaseWeb()` 在 `DSH_BASE` 可用时提前返回；一旦它为空、或指向桌面安装树内部（会被 `isInsideDesktopInstall` 拒掉），就会退到「当前进程所在的树」——也就是 `D:\dsh-purge-maintained\node_modules\@deepseek-ai`。我第一次探针就踩了：`enumeratePatchAiBases()` 返回 `[仓库树, 桌面树]`，`applyPatchesAllHosts()` 把补丁 1 真写进了 devDependencies，还留了 `.dshpurge.bak`。所以这份测试的每条用例都先挂 `DSH_BASE`，并且有一条专门钉「宿主表里绝不能出现仓库树」。
- **单树 report 的键是 `patch_id`，不是 `id`**。`applyPatches` 返回的行与 `mergeApplyReports` 合并后的行同名，用 `.id` 断言会拿到 `undefined`。
- **合并后的 `report` 一条补丁只有一行，`path` 只保留第一次遇到的那棵树**。多宿主下它不足以回答「哪些树打了」，要看 `hosts[].report`。
- **`hooksDenyBypass === false` 那条分支本来不可观测**：沙箱树里没有 hooks 配置文件时，`changed` / `failed` 恒为空数组，把判定改成恒假也测不出来。只有在树里造出 `dsh-hooks-claude-code/lib/index.js`（含 R1b 那条反向规则）与 `dsh-hooks-codex/lib/index.js`（含残留哨兵）之后，`changed` 与 `failed` 才各有内容，分支才有区分力。
- **junction 别名确实会被去重掉**：`DSH_DESKTOP_INSTALL` 写成 `install;junction-alias` 时，宿主表仍是两项（web + 桌面各一），这是批77 那个 `realpathSync.native` 修复的直接效果 —— 修之前这里会返回三项。
- **回退侧的 `errors` 有一个可稳定造出来的来源**：0 字节的 `.dshpurge.bak`（备份中断留下的占位）会被改名成 `.bak.bad` 并记一条 `empty_backup`，那棵树保留注入、另一棵正常回退。这比 monkeypatch 可靠。
- **「零宿主」这条用例故意不写**：真造出来就会退到仓库树、真写盘。空补丁列表只用来钉「两棵树都进表但 report 为空」的形状。

RED 演练 **22 条突变 → 22/22 全红**（`{"total":22,"red":22,"green":[],"anchor":[]}`）。牺牲掉一条突变：`discover` 表达式的花式改写会**改变行为**（真去做发现式扫描，命中本机安装树），没法安全演练，只能靠源码形状断言钉住 `options.forApply === true || options.discover === true` 与 `options.discover !== false` 这两句。

顺带一条 fixture 纪律：`installTree()` 少造 `resources/runtime/cli/bin/dsh.cmd` 时，`lib/desktop.js` 的行覆盖会掉 5 行、基线直接判 FAIL。**这种情况要补造 fixture，不许 `--update` 把下降抹平**。
**三十一补**：`lib/core.js` 的「深度兜底扫描」—— `findAiBaseRecursive` / `scanHomeRootsForAiBase`。三十补钉到「用户点应用/回退时每一棵树都走到」，这一补钉的是**所有便宜探测都落空之后的那一手**：容器里没有 npm 全局前缀、主目录布局非标准、pnpm 把包装在虚拟存储里。它每启动跑一次，是整条定位链里唯一一次真正的全盘 `readdir`，判错时的表现既不是报错也不是空表，而是「多扫几遍 / 卡几秒」，所以只能靠计数与深度边界钉。

七条只能跑出来的事实：

1. **深度语义是「最多下钻 6 层」**：`if (depth > 6) return null` 在函数入口判，顶层调用 `depth=0`，所以第 7 层就放弃。测法是把 `@deepseek-ai` 逐层埋深，depth=6 命中、depth=7 回 null —— 这条不是「读一眼代码就知道」，因为入口判 > 而不是 >=，差一层。
2. **`node_modules` 有三个落点，顺序固定**：`path.join(root, needle)` → `path.join(root, "node_modules", "@deepseek-ai")` → pnpm `firstAiBase(pnpmHoistAiBases(root))`。第二条是为「扁平布局但藏得很深」准备的：正因为有它，`@deepseek-ai` 埋在任意深度都能被撞到，**所以 needle 参数写错也照样命中**（见下）。
3. **junction 与符号链接永不下钻**：`readdirSync(p, { withFileTypes: true })` 对 junction 返回 `isSymbolicLink() === true` 而 `isDirectory() === false`，第 2376 行的 `if (!e.isDirectory()) continue;` 把它挡在门外。正面后果是不会绕圈，反面后果是**只经链接才够得着的树，深度扫描永远找不到**（写进盲区，接 `findDesktopPackageRoots` 那条便宜路径兜着）。
4. **跨设备跳过只在非 Windows 分支生效**：`if (rootDev !== null && (process.platform !== "win32" || e.isSymbolicLink()))`。Windows 上只有 reparse point 才 stat，普通目录一律下钻 —— 因为 `#91` 注释写明了 6 万个目录 7.2 秒的实测。这条只能靠伪装 linux + 伪造 `dev` 才测得到。
5. **同一个根写成两条字符串路径只扫一遍**：`scannedRoots` 去重在 `scanHomeRootsForAiBase` 里，`[findDshHome(), path.join(findDshHome(), ".."), os.homedir()]` 常常互相覆盖。用例用**空目录**造（第一个根不命中才会走到后两个），`readdir` 计数恰好 2。
6. **命中落在桌面安装树里要丢掉、继续下一个根**：否则容器里的 `~/.dsh` 一旦把桌面版目录软链进来，就会把「桌面安装树」当成「web 的宿主树」报上去，接着一整轮补丁全打在错的地方。
7. **`realpathSync.native` 那个坑这里也有一份**（第三处）：`fs.realpathSync.native` 在 `hostFs` 上恒 `undefined`，原写法每次都抛 TypeError 被 catch → 去重键退化成路径字符串。修法与批77 的 `enumeratePatchAiBases` 一致：先 `nodeFs.realpathSync.native`，失败再退 `fs.realpathSync`，最后才保持原路径。

**RED 演练**：18 条突变 → 18/18 全红（nest/扁平/pnpm 三种落点各一条、深度 +1、readdir 抛错改返回值、文件当目录、junction 判定反、visited 不查、跨设备比较反、跨设备判定恒真删、键不归一、`roots` 去重去掉、null 根不跳过、桌面树不排除、realpath 兜底退化成单层、needle 写死 "nope"、`scanHomeRootsForAiBase` 不接 roots 参数、闸门挪进扫描体）。
**一条等价突变删掉**：把 `path.join("node_modules", nestedAiPath())` 换成 `"node_modules"` —— 因为事实 2 的第二落点会在更深处撞到同一个目录，行为完全一致。它只由源码形状断言钉住，不为它硬凑 fixture。
**两条用例的写法值得记**：①「跨设备跳过」的 `statSync` 假实现**不能**用 `{ ...st, dev: 999999 }` —— 展开会丢掉 `Stats` 原型上的 `isDirectory()`，`isAiBase` 一律 false，于是原实现和「判定反了」的突变都回 null，用例永远绿。正确做法是 `const stub = Object.create(st); stub.dev = 999999;`。②`readdir` 计数要先把两侧都过一遍 `realpathSync.native`，否则 `os.tmpdir()` 给的 8.3 短名（`ADMINI~1`）与长名不是同一个字符串，计数恒 0。


**三十二补**：`lib/redteam/tools.js` 的**宿主包解析链**与**子智能体槽位自动释放**。前三十一补都在补丁链 / 定位链上，这一补第一次动红队子系统里「不报错但会整块消失」的两处：解析链错 → 整份红队预设被下拉过滤掉（日志只有一行 `cannot resolve`）；释放错 → 并发名额只增不减，第三次派活直接被「并发已满」拒。两处都零命中，且都从 1.1.94 起没变过形态。

**解析链的四条规则**（`considerBin`，输入一个 `bin` 路径，输出若干「可能是 `@deepseek-ai/dsh/package.json` 的路径」）：
① 命中 `/node_modules/@deepseek-ai/dsh/` 就截到那里；② 从最后一个 `/node_modules/` 往上拼；③ `dirname/../lib/node_modules/...`（npm 全局前缀布局）；④ `dirname/../node_modules/...`（包自己装了嵌套依赖）。①②对同一个包根会给出同一条路径，靠 `addCandidate` 的分隔符归一去重。
**`addCandidate` 的去重只归一 `\` → `/`，不归一大小写** —— `C:/x` 与 `c:/x` 会各留一条。Windows 上那是同一个目录，代价只是多一次 `existsSync`；反过来若加 `toLowerCase()`，POSIX 上大小写敏感的两个不同路径就会被误合并。这是刻意的，已用「大小写不同算两条」的用例锁定。

**候选表 29 条的固定顺序**（`defineToolCandidates`，第一条能被 `createRequire` 解析的就赢了）：argv 三条 → `execPath` 退一级两条 → `DSH_HOME` 七条 → `<home>/.dsh` 七条 → 桌面根八条 → `cwd/package.json` → 本机历史遗留的 `D:/DeepSeek Harness/npm-global/...` 一条。每个主目录七条 = 顶层 1 + `profiles/{web,desktop,default}` 各 2。
顺序有意义，不只是列表内容：`DSH_HOME` 必须排在那条「猜出来的 `<home>/.dsh`」前面，否则旧主目录会把当前主目录的包压掉。**RED 演练抓到过这个盲点** —— 只断言两组各自七条时，把两组顺序对调是绿的；补了 `indexOf('/r/dshhome/package.json') < indexOf('/r/home/.dsh/package.json')` 才红。

**`join()` 会把 `..` 折掉，所以「退一级」在根附近会塌**：`execPath = /r/app/x.js` 时两条「退一级」候选落到 `/r/lib/node_modules/...` 与 `/r/node_modules/...`，而不是 `/r/app/...`。现状刻意保留：多试一条只多一次 `existsSync`，少猜一种布局就整份预设消失。写用例时不能假设候选串里还留着 `..`。

**槽位自动释放**（`apply()` 里的 `ctx.effect`）：`subagent/end` 到达时先 `bindingKeyOf` 沿 `parentSession` 找到根会话，再 `dropReservation(rootId, childId)` 按 id 精确释放；**对不上就按时间兜底释放最早一条**。预留键是 `<label>#<Date.now()>`，宿主的 runId 永远不可能等于它，所以**线上恒走兜底那条**——精确释放是给未来的（如果哪天真把 runId 塞进 key）。用 `ctx.effect` 包住是为了 dispose 时解绑，否则热重载会让同一个事件挂两遍、释放速度翻倍。

**RED 演练**：24 条突变 → **24/24 全红**。首轮 23 条里 1 条等价（删掉 `if (rootId === undefined) return` 这个早退 —— `reservations.get(undefined)` 本来就是 undefined，`addReservation` 也只会收到解析出来的根 id，所以表里不可能存在 `undefined` 键），已删并在用例里写明理由；另 1 条（主目录顺序）靠补断言才转红。
**用例分布**（24 条）：`addCandidate` 4 / `considerBin` 5 / `defineToolCandidates` 6 / `resolveDefineTool` + `loadDefineTool` 5 / 槽位自动释放 3 / 源码形状 1。

**这条用例被 CI 抓过一次，值得记**：第一版写的是「本仓库里能直接解析到宿主包，返回一个函数」。本机（有桌面安装）绿，`ubuntu-latest` 红 —— `Error: cannot resolve @deepseek-ai/dsh-tools from host`。同一个函数在两台机器上给出两个结果，这种用例在错误的一端永远是假红或假绿。修法不是加 `skip`，而是把「逐条试候选表」抽成 `resolveDefineTool(candidates)`：它只依赖文件系统，用例可以自己造一棵假宿主树（`node_modules/@deepseek-ai/dsh-tools` + 一个返回 `{fake:true}` 的 `defineTool`），于是「第一条能解析的就赢」「不存在的路径跳过」「一条都没有就抛同一条文案」三件事都变成确定的。`loadDefineTool()` 只剩「先试插件自己的解析，再交给候选表」，那条用例改成两态容忍（拿到函数就断言是函数，抛错就断言抛的是那一句文案）。

RED 演练 `.tmp80-drill.mjs` 复跑：**24 条突变 → 24/24 全红**（新增的「`candidates` 为 `null` 时不抛错」「只认第一个候选」两条也红）。

**三十三补**：`lib/redteam/store-core.js` 里三件「写错了也不报错」的事 —— **旧得分项清理**（`:1401-1438`）、**多值 `test_status` 筛选**（`:1187-1197`）、**步骤连带记分**（`:2681-2699`）。这一批第一次把「不可逆的破坏性操作」和「筛出来的队列不对」这两类问题搬进守卫：前者的错法是用户自建的得分点连同命中被静默删掉（`saveScorePoint` 照样返回 ok、界面照样弹「已保存」），后者的错法是「被封的资产又进了队列」—— 两者都不抛错、都不留日志。

**三条只能跑出来、读代码看不出来的现状**：

1. **清理前必须存档，存档失败就一条都不删。** 有命中时先写 `<靶标>/runs/legacy-score-<ISO 时间戳>.json`（`archived_at` / `reason` / `points[]` / `hits[]` 全带 evidence 原文），写成功才 `DELETE`。把 `runs` 做成**文件**挡住 `mkdirSync` 后：`purged:false`、得分点与命中**都还在**、函数不抛（外层 `catch` 吞掉，播种继续）—— 这就是「宁可旧点再多留一轮，也不能静默丢证据」的可执行版本。没有命中时直删，**不建空存档文件**。
2. **`builtin` 列才是「是不是内置点」的判据，不是「code 在不在默认名单里」。** 用例造了一个 `code='web-account-mine'`、`builtin=0`、`legacy=0` 的自建点（长相与旧点一模一样）：清理必须一条不动、也不产生存档；反过来 `legacy=1 && builtin=0` 的老库点（迁移时打过标记）要清。用名单判会把用户自建点当旧体系残留删掉，而 `saveScorePoint` 的返回值与界面提示都正常。
3. **多值 `test_status` 走的是 `IN`，而且两个分支都要 `COALESCE`。** `'abandoned,blocked'` 两条都出来；`' blocked ,, abandoned '` 里空格与空段被 `trim`/`filter(Boolean)` 掉；`''` 等于不筛（不是筛「状态为空」）；`'untested'` 靠 `COALESCE(a.test_status,'untested')` 也能命中 `NULL` 的老资产 —— 这条在 `=` 分支与 `IN` 分支**各有一份 COALESCE**，只守单值分支的话，把 `IN` 那份删掉不会有任何测试红。还有一处现状锁定：`'tested,'`（只多一个尾逗号）会被当成字面量去查，一条都出不来 —— 因为单值分支压的是**原始字符串**而不是 `list[0]`；哪天有人改这里，用例会立刻红。

**步骤连带记分**（`addChainStep`）钉了五条：带 `point_code` + `evidence` 时同一次调用完成「动作 + 得分」，`step.point_id` 与 `score_hit.step_id` 双向挂上；给了 `point_code` 但 `evidence` 为空（含纯空白）→ 步骤照常入库、不记分、提示里明说「**没有记分**」要补 `evidence`（**不能**闯进 `addScoreHit` 再被它的 evidence 校验打回来 —— 那样模型看到的提示是「记分失败」，会以为计分逻辑坏了）；两者都不给 → 只写步骤、连提示都不出；`seq` 连续递增；最后一条现状锁定：`point_id` 指向不存在的得分点（`999999`）**不报错**，照写一条 `point:null` / `points:0` 的命中（`addScoreHit` 只在 `pointId === null` 时才报 not found）。

**RED 演练**：`.tmp81-drill.mjs` 16 条突变 → **16/16 全红**（`restored: true`）：多值不走 `IN` / 多值不 `trim` / 不滤空段 / `IN` 分支去 `COALESCE` / 存档守卫失效 / 不写存档也当已存档 / 没命中也建空存档 / 判据丢掉 `builtin`+`legacy` 列 / 存档不写 `reason` / 存档文件名换前缀 / 命中不挂 `step_id` / `evidence` 不 `trim` 就当给了 / 缺 `evidence` 时不提示 / 显式 `point_id` 被忽略 / 步骤行不写 `point_id` / `purged` 恒 `true`。首轮两条 GREEN 靠**补用例**转红，不是靠改断言：`IN` 分支的 `COALESCE` 需要「逗号串里带 `untested` + 一个 `NULL` 老资产」，`evidence` 是否 `trim` 需要区分提示文案（「没有记分」vs「记分失败」）。

**用例分布**（21 条）：多值筛选 6 / 旧得分项清理 8 / 连带记分 7。`lib/redteam/store-core.js` 行覆盖 3687 → **3740/3831（97.6%）**、函数 246 → 250、分支 1254 → 1290。


**三十四补**：`lib/redteam/score-report.js` 的**报告正文边角** —— 长备注怎么截（`:878-887`）、档位校正段（`:924-941`）、截图归属指路（`:1148-1160`）、步骤去重（`:45-49`）。这一批 14 条（`scripts/test-report-edges.mjs`）只断言 markdown 文本与条目字段，顺带**删掉了一段 28 行的死代码**。

1. **长备注按句子边界截断**：隧道备注上限 320、WebShell 备注上限 200，切点必须在后半段（`i > n * 0.5`）的 `。；）)，` 之一，找不到就整段截到上限。三条用例分别钉住「句号在 200 → 切在 208 字符」「一个分隔符都没有 → 原样 327 字符」「句号在 100（不到一半）不算切点、继续找 300 处的逗号 → 308 字符」。**为什么值钱**：直接 `slice` 会切出「…后端是 3 台 LB 轮询(」这种半截句子，验收人读不懂；而改成「永远用找到的第一个分隔符」的突变，在只看长度的断言下照样绿 —— 必须钉住「前半段的分隔符不许用」。
2. **档位校正段**：命中备注里出现「校正」就单起一段（`> **档位校正**：以下 N 条…` + 逐条目标与**校正后**分值），没有就完全不出现。两条用例一正一反：正面钉「列出的是 50 分而不是原始 60 分」、「备注原文带上」；反面钉「没有校正字样时 md 里不许出现『档位校正』」。**为什么值钱**：报告的分与面板的分对不上时，这段是唯一的解释；漏掉它不会报错，只会让验收人以为正文数字是抄错的。
3. **截图归属**：同一得分点的图只做「代表图」展示，没分到图的那条要写明「本条的证据截图已在该得分点的代表图中展示（该得分点共 N 张）」。三件事一起钉：`shots.length` 0/1 的分布、`shot_total` 仍然是全量、指路文案里的总数。反面对照是「本得分点一张图都没有时不许出现指路」—— 突变把条件从 `> 0` 放宽到 `>= 0` 就会红。
4. **步骤去重**：同一步骤被多条归因路径捡到时只出现一次，且**显式关联的那条不标推断**、兄弟步骤才标 `inferred: true`。归因顺序是 `linked → vuln → point(推断) → asset(推断)`，所以「先压进来的永远是实锤」。
5. **删掉的死代码**：`:451-478` 那段「`replayCmd` 仍是 null 就用 `confirm.script` 填模板」的兜底与上面 ③ 分支逐字重复，且**永远走不到**——③ 的条件（`confirm && confirm.script`）与它一字不差，唯一可能把 `replayCmd` 留成 null 的路径是 ①（合成 curl 失败），而 ① 的 `url` 一定是 `scheme://host+path`，`parseTarget` 认不出也会退到「取第一段当主机」（`report-replay.js:60-63`），所以 `buildCurlCommand` 在那里不会返回 `null`。演练时试图为它造用例：把 `parseTarget` 的各种畸形输入都试了一遍，`url` 始终可解析 → 判定为死代码后删除，原地留 6 行注释说明理由。
6. **覆盖率**：`lib/redteam/score-report.js` 行 1457 → **1496/1510**（分母少了 22 行，是删死代码的结果）、函数 157 → 159、分支 560 → 584；全仓行 **93.01%**。RED 演练 **13 条突变 → 13/13 全红**（另有一条 `existing.inferred` 覆盖突变判为等价并删掉，理由见下一节盲区 81）。

**三十五补**：`lib/rewind.js` 的五段「静默失败」路径 —— 等轮次关闭（`waitTurnClosed`，`/:379-390`）、清 inbox（`disarmRewoundSession`，`/:410-445`）、同会话串行锁（`rewindOneSession`，`/:576-595`）、可迭代日志归一（`asEventList`，`/:19-29`）。上一批（`test-rewind.mjs`，45 条）在文件头写着这两件事「要真等，不适合放进每次提交都跑的套件」——`waitTurnClosed` 的 8 秒超时与草稿 10 分钟过期。这一批把超时改成**参数注入**（`timeoutMs` 已是形参，只是没被单独测过）之后就不再需要真等，于是把三条路径都搬进守卫，共 **23 条**（`scripts/test-rewind-edges.mjs`）。

1. **`waitTurnClosed` 超时到底抛什么、期间读了几次盘**。文案是 `The turn is still running. Click Stop first, then undo.`；`timeoutMs=120` 时 `elapsed≈182ms`（睡 80ms 的粒度）、`reads>=2`。三条用例分别钉「一直开着 → 抛固定文案且真的在读盘（不是干等）」「睡一觉后关了 → 只读两次、返回的那份日志末条是 `turn/end`」「一开始就没开 → 只读一次、不睡」。**为什么值钱**：把它改成「只判一次就收工」（`while (false)`）在只看「抛没抛」的断言下照样绿，必须同时钉读盘次数。
2. **`sessions.get` 抛错时原样冒泡，不被兜底文案吃掉**。「Cannot find the current session」只在三条读盘路（`sessions` / `controller.inspect` / `sessionQuery.observeSession`）**全都落空**时才出现。两条用例一正一反：服务自己抛 `sessions boom` → 冒泡 `sessions boom`；三个服务一个都没有 → 才报 `Cannot find the current session`。**这条一开始写错了**：先只写「抛 sessions 就报 Cannot find…」，跑出来 `actual: Error: sessions boom` —— 说明 `readSessionLog` 里 `store?.get?.(sessionId)` 的异常根本没被 catch，兜底文案属于「服务不存在」而不是「服务报错」。
3. **`disarmRewoundSession` 到底 cancel 了没有**。默认（`options.cancel !== false`）且 `phase.kind !== "idle"` 时调 `agent.cancel({kind:"user"},{keepInbox:true})`；`{cancel:false}` **一次都不 cancel**（`doRewindOneSession` 的生产路径用的就是这个）；`idle` 也不 cancel。**为什么值钱**：fork 出来的新会话 abort 之后用户一发消息就走官方的 `wakingAfterAbort`，等于把「我刚回退、还没说话」变成「它自己又开始答了」——用户完全无法归因。
4. **inbox 逐条摘除**：`nextTurn` + `nextStep` 合并、按 id 去重、跳过空 id、日志里 `agent/inbox/spliced`（`target: "next-turn"`）插进去那几条也要摘。四条用例分别钉「去重后只发 a、b」「不看 `nextStep` 就少摘一条 → 红」「不摘日志插入 → 红」「某一条摘不掉不影响后面几条（每条各自 try）」。**为什么值钱**：漏摘的表现是「回退之后新会话自己往下跑」，用户看到的是「我什么都没发，它自己又答了」。
5. **三层 try/catch 都要**：`cancel` 同步抛错（真服务可能不是 async）、`cancel` 异步抛错（靠 `ignoreSettled`）、读日志抛错、读 `agent.inbox` 的 getter 抛错、`updateQueue` 抛错 —— 五处全吞。其中「同步抛」单独一条：`ignoreSettled(agent.cancel(...))` 只兜得掉 rejected promise，同步 throw 发生在**参数求值阶段**，只能靠外面那层 `try`。**这条是演练逼出来的**：最初的 fixture 用 `async` 方法抛错（= rejected promise），把外层 `try` 删掉照样全绿（等价突变），换成同步 thrower 之后才红。
6. **同会话串行锁的两条分支**。`rewindLocks.get(key)` 为前驱链，`prev.then(onOk, onRejected)` 两条分支各跑一次 `doRewindOneSession` 并在 `finally` 里 `if (rewindLocks.get(key) === next) rewindLocks.delete(key)`。实测：并发两次 → `fork:start1 / fork:end1 / fork:start2 / fork:end2`（严格串行，各自拿到 `child-1` / `child-2`）；第一次 fork 抛错 → 第二次**仍然要跑**（`settled` = `rejected` + `fulfilled`），把 onRejected 分支删掉之后第二次会被前一次的失败永远拖着；`sessionId=''` 时不进锁直接执行。**为什么值钱**：删掉 onRejected 的表现是「一次回退失败之后，这个会话的 `/rewind` 就再也不响应了」——不报错、不日志，只有重开窗口才好。
7. **覆盖率**：`lib/rewind.js` 行 580 → **618/644（96.0%）**、函数 52 → 56、分支 258 → 312；全仓行 **93.11%**。RED 演练 **17 条突变 → 17/17 全红**（另删掉两条等价突变：`!id` 那半个判据从 `ids` 的两个来源就已经过滤掉、`if (!key)` 早退在串行语义上不可观测，理由见盲区 83）。

**三十六补**：`lib/redteam/ip-utils.js` 的十个纯函数 —— `cidrOf`（资产按哪个网段分组）、`scopeOfIp`（内网 / 外网）、`ipToInt`（`ORDER BY ip_int` 的自然排序）、`expandIpv6` / `isIpv6`、以及四个 slug / 文件名函数。这是整份 `test-map.md` 里第一个**纯函数模块**（不碰数据库、不碰文件、不读环境），所以写起来没有 fixture，全部靠一张「输入 → 实测输出」的表；也正因为纯，它此前一条测试都没有 —— 全仓 `grep -rln 'ip-utils' scripts/*.mjs` 为空，25 行未覆盖全部落在 IPv6 与 CGNAT 上。

坏法全都不报错，只让面板显示错东西：`cidrOf` 判错 → 资产测绘左侧多出一个假网段、资产归到错的段（IPv6 资产被拼成 `2001:db8::1.0/24` 这种四不像就是这么来的）；`scopeOfIp` 判错 → 内网目标被当外网（或反过来），扫描范围与报告口径一起偏；`ipToInt` 判错 → `ip_int` 变成负数或 NULL，资产列表的自然排序乱掉；`slugTarget` / `slugPoc` 判错 → 同一个目标的攻击文件散到两个目录、知识库条目引用不上。

六处「明显不严谨但已被依赖」的现状，逐条钉住并写明为什么不改：

1. `isIpv6(":")` / `isIpv6(":::")` / `isIpv6("1:2:3:4:5:6:7:8:9")` / `isIpv6("2001:db8::1::2")` 全是 **true**。它只校验「字符都在 `[0-9a-fA-F:]` 里」且 `split(':').length <= 9`，不校验真语法。**不改**：调用方只用它决定「要不要走 IPv6 分支」，改严会让脏输入从 `external` 掉回 `internal`，把扫描范围放大。
2. `ipToInt("256.1.1.1") === 65793`：正则只要求 `\d{1,3}`，不校验 ≤255，256 溢出进下一段。**不改**：这是给 `ORDER BY ip_int` 用的排序键，脏 IP 有个大致有序的键比 NULL 更好。
3. `cidrOf("10.1.2.3:8080")` 原样返回 `10.1.2.3:8080`，不认端口。**不改**：`asset.ip` 本来就不该带端口，原样返回便于肉眼发现脏数据（宁可显示难看，也不要静默归到一个错的段）。
4. `cidrOf("::ffff:10.0.0.1")` → `0:0:0:0::/64`（不剥壳），而 `scopeOfIp` 同一个地址剥壳后算 `internal`。两边口径不同。**不改**：`cidrOf` 剥壳会把 IPv4-mapped 资产并进 `10.0.0.0/24`，和真正的 IPv4 资产混成一个段，比现在更糟。
5. `scopeOfIp("::1") === "external"`：纯回环不是内网。**不改**：现实现只认 `127.` 开头的 IPv4 回环；把它改内网会让「用 ::1 做本地靶标」的演练目标整体挪到内网分组，影响报告口径。
6. `slugTarget("中文 目标") === "unknown"`、`slugTarget("https://") === "https"`、`slugTarget("http://[2001:db8::1]:80/x") === "_2001_db8__1"`。**不改**：`slugTarget` 的结果是**已存在的靶标目录名**，改一次就把用户已建的攻击文件留在旧目录里；这一条只能钉、不能改。

测试侧的四条纪律：

1. **先跑探针再写断言**。这一批我凭「应该是什么」写错了三处 —— `isIpv6("2001:db8::1::2")` 以为是 false（实为 true）、`scopeOfIp("10.0.0")` 以为是 external（实为 internal，四条 IPv4 判据都是前缀匹配而非整串校验）、`slugTarget("A.Example.COM/x")` 以为是 `A.Example.COM`（实为 `A.Example.COM_x`，只有 `^https?://` 命中时才取 host）。三处全部靠 `scripts/test-ip-utils.mjs` 首跑变红后按实测值改正。
2. **断言要钉到「用户看到的那一行」**。例如 `ipToInt` 那条不只断言数值，还断言 `> 0`（`>>> 0` 掉了会让 `255.255.255.255` 变 -1）；`defaultPocFilename` 那张 14 行的映射表逐项断言，而不是「返回以 poc. 开头」。
3. **等价突变有三种形态，第三种最容易漏**：这次删掉的三条属于「两条判据互为补偿」—— `head === '' ? []` / `tail === '' ? []` 与 `g === '' ? '0'` 三者删任一条，另外两条都能把结果补回同一个值。所以 `expandIpv6` 的 37 行那个三元分支**永远走不到 true**（空组进不来），`brh` 上限就是 73/74。
4. **`slugPoc` / `slugify` 的空结果要钉成时间戳形状**（`/^poc-\d+$/`、`/^engagement-\d+$/`），不能断言具体值。

**覆盖率**：`lib/redteam/ip-utils.js` 行 116/182 → **140/140（100%）**、函数 11/12 → **13/13**、分支 25/42 → **73/74（98.6%，差的正是上面那个不可达分支）**；全仓行 **93.18%** / 函数 83.60% / 分支 89.55%。RED 演练 **36 条突变 → 36/36 全红**（另删掉三条互为补偿的等价突变，理由见上）。测试文件 `scripts/test-ip-utils.mjs` **53 条**，两平台各 53/53。

**三十七补**：`lib/bom-guard.js` 的四条「不写盘」出口与那一行告警文案。这个模块只干一件事 —— 把 profile 清单开头的 BOM 剥掉（`\uFEFF` 在 `package.json` 开头会让宿主 0.2.2 **直接起不来**，用户看到的是桌面端闪一下就没了）。`test-bom-guard.mjs`（5 条）早就钉住了救砖主路：带 BOM 的清单能被点出来、修完 JSON 可解析、本来就坏的文件不会被写得更坏、修干净的文件 mtime 不变。这一批补的是同一套逻辑里**四条「决定不写」的出口**，以及 status 里那一行文案。

这些出口的坏法全都是**安静地什么都不做**，用户不会看到任何报错：

- 该修的没修（`dryRun` 分支写真漏了 `continue`）→ 面板说「已修复」，重启还是起不来；
- 不该修的修了（`skipped` / `failed` 分支少了 `continue`）→ 把坏文件写成半截，把「等用户拿备份恢复」变成「备份也没用了」；
- 写盘失败当成成功（`catch` 里忘了 `push failed`）→ 磁盘满 / 文件被占用时面板仍报成功；
- 告警文案漏一半（只报 BOM 不报 JSON 坏）→ 用户照着提示修完 BOM，仍然起不来。

`scripts/test-bom-guard-edges.mjs`（19 条）分成五组：常量与纯函数 3、`scanProfileBom` 4、`fixProfileBom` 6、写后复查 2、`bomWarningLine` 3，外加 1 条源码形状。

跑出来的六条事实（都写进了断言，改代码前先看一眼）：

1. **`result.report` 是「修完再扫一遍」的结果，不是修复过程的复述**。`dryRun` 时它照样报 `ok:false` 且 `bom.length === 1` —— 这样调用方只要看 `report.ok` 一个字段就能决定要不要提示用户，不必区分「这是试运行还是真修」。
2. **`skipped` 与 `failed` 是两个不同的出口**：没有 BOM 但 JSON 本来就坏 → `skipped(reason:"json-invalid")`，一个字节都不写（这文件不是 BOM 的锅，不该由这里动它）；有 BOM 但剥掉之后仍然解析不过 → `failed`，**原文连带 BOM 原样留在盘上**（此刻用户最需要的是那唯一的副本，而不是一个「干净」的半截文件）。
3. **`checked` 只数真实存在的清单**。`profiles/` 下每个目录都会展开六个候选名，但只有读得到文件的才 `+1`；`profiles/` 下不是目录的条目（比如一个 `pkg.json` 文件）直接跳过，一个候选都不产生。
4. **yaml 只判 BOM，不判语法**。`cordis.patch.yml` / `pnpm-workspace.yaml` 带 BOM 会进 `bom`，但**不会**进 `broken` —— 这个模块没有 YAML 解析器，把「读不懂 YAML」当坏文件处理就等于把整类文件都判死。
5. **`bomWarningLine` 的两段是拼起来的**：都有问题时是 `1 个清单带 BOM（宿主 0.2.2 会起不来），1 个清单 JSON 坏`（BOM 在前，用全角逗号）。只报一半，用户就会在修完那一半之后以为好了。
6. **写盘只走 `atomicWriteSync`**（`lib/core.js:68-96`：写 `.<pid>.<ts>.tmp` → `fsyncSync` → `renameSync`）。直接 `fs.writeFileSync` 会丢掉这层保护，断电时清单可能变成半截 —— 那正是这个模块要救的砖。

**这两条「写后复查」原本是测不到的，靠伪造读回来测**。`fixProfileBom` 写完之后会 `readFileSync` 再验一遍（还带 BOM → 抛 `BOM still present after write`；JSON 类还要再 `JSON.parse` 一次）。正常跑的时候这两行永远为假，任何实现都能过 —— 直到你让 `renameSync` 真的成功、却让**读回来说谎**：

```js
fs.renameSync = (...args) => { const out = origRename.apply(fs, args); written = true; return out; };
fs.readFileSync = (target, ...rest) => (written && String(target) === fp ? BOM + body : origRead.call(fs, target, ...rest));
```

真实场景是另一进程在同一毫秒把 BOM 写回去、或者磁盘缓存骗了我们 —— 复现不了，但「读回来是坏的就一定不能报成功」这条不变式必须钉住。同一手法（`export` 出去的是 `node:fs` 默认导出对象，`lib/bom-guard.js` 与 `lib/core.js` 里的 `atomicWriteSync` 共用同一个对象）也用来造写盘失败：`fs.renameSync = () => { throw new Error("rename boom") }` → `failed` 里 `error === "rename boom"`、原字节不变、目录里**不留 `.tmp`**（`atomicWriteSync` 的 catch 会 unlink）。这比 `chmod` 可靠：POSIX 上 `rename` 只要求目录可写，改目标文件的 mode 拦不住它（批59 踩过）。

**顺手删掉 7 行死代码**：`readJsonNoBom(fp)`（原 `lib/bom-guard.js:51-57`）全仓只有定义处一个名字 —— `grep -rn "readJsonNoBom" lib scripts` 的唯一命中就是它自己。它是这个模块早期「顺便读一下 JSON」的遗留，BOM 判定早就不经过它了。判据很简单：**私有 helper 在全仓只有定义处一个标识符出现，就是死代码**；删除后 `node --check` + 该模块全部测试文件（5 + 19 条）通过即可。文件 169 → 161 行，`lib/bom-guard.js` 行覆盖 **148/161 → 161/161（100%）**、分支 34/44 → 58/61。

**覆盖率**：`lib/bom-guard.js` 行 **100%**、函数 7/7、分支 **58/61（95.1%）**；全仓行 **93.23%**。RED 演练 **20 条突变 → 20/20 全红**（唯一一条 ANCHOR 是我把 `if (!home) return out;` 的缩进写成 4 格，真行是 2 格 —— 锚点必须从源码印刷行抄）。没有等价突变：那 20 条每一条都能说清「用户会看到什么不同」（该修没修 / 不该修却修了 / 失败报成功 / 告警少一半）。

**三十八补**：`lib/rules.js` 的 `saveRule` 回滚段（原 `186-201`，一行都没跑过）。这一批没有新增能力，只补**已经写在代码里、却从没被验证过的失败路径**。

`saveRule` 要同时改两个位置：规则正文 `rules/<id>.md` 与元数据 `rules/<id>.json`，改完还可能顺手把规则同步到目标文件（`AGENTS.md` / `CLAUDE.md`）。三者只要有一处失败，前面写下的就必须退回去 —— 否则用户看到的是「规则列表里有它、`AGENTS.md` 里却是半截」，或者更糟：**上一次的规则正文被新内容覆盖后回不去**。回滚段的三条分支对应三种不同的残留：

1. 原来是新规则 → 把刚写的 `.md` 删掉（`unlink`，不是写空串）；
2. 原来有旧正文 → 把上一版**原样**写回（不是写 `""`、也不是写新内容）；
3. 元数据已经写成功 → 有旧 meta 就写回，原来没有就删掉那个新 meta。

这三条以前是「凭代码看起来正确」，现在三条各有独立用例。老 `test-rules-store.mjs`（30 条）管的是正常路径（256KB 上限、id 合法性、备份三分支、激活同步），这一份 `test-rules-rollback` 管失败路径，两份不重叠。

造失败一律用**让磁盘真实拒绝**，不 mock 模块内部函数（否则测的是 mock）：

- 把 `rules/<id>.json` 做成**目录** → 写 meta 时 `atomicWriteFile` 的 rename 失败（Windows `EPERM`、POSIX `EISDIR`）；
- 把 `$DSH_HOME/AGENTS.md` 做成**目录** → 激活时写目标失败，正好落在 `wroteRule && wroteMeta` 都已为真的时刻；
- `fs.promises.stat = async () => { throw }` → `listRules` 的 `size` 兜底（该条仍然列出、`size` 记 0）；
- `fs.readFileSync = (fp) => { if (fp === <某条规则>) throw }` → `collectRuleContents` 跳过读不出来的那一条，**不拖垮备份**（这一条最容易写错：抛出去会让整个激活失败，而正确的行为是「这条内容算不进集合，于是目标文件照常备份」）。

另外补上 `rulesStatus` 的三态（active 有、目标文件不在 → `agents_exists` / `agents_synced` 都是 false 且不抛；内容一致 → synced true；多一个换行 → false）与 `ensureOperatorBody`（无 `prompt-inject.md` 时返回内置默认正文并 `hangOperatorPrompt` 挂全局，两次一致；有磁盘稿时用磁盘稿）。

一条**实现细节**值得记：`ensureOperatorBody` 返回的内置默认正文实测 **20994 字符**（不是 `defaultOverrideText()` 的原始长度 —— 中间过了 `normalizeOverride`）。用例只断言「> 1000 且两次相同」，不钉具体长度：那是提示词正文，会被上游改写。

**覆盖率**：`lib/rules.js` 行 **535/560 → 559/560（99.82%）**、函数 45/48 → 46/48、分支 179/208 → 201/228（88.2%）；全仓行 **93.30%**。唯一剩下的那条是 `resolveInjectText` 的 `return { text: "", source: "none", ruleId: null }` —— 它要求 `normalizeOverride(defaultOverrideText())` 为空，而内置默认正文恒非空，**走不到**（写进盲区 86）。

RED 演练 **18 条突变 → 18/18 全红**（`restored: true`，无等价突变、无锚点 MISS）。每条都能说清「用户会看到什么不同」：规则文件该删没删 / 该退回旧版却留了新版 / meta 残留 / 用户原件被规则正文覆盖 / 规则列表里混进 `_bad.md` 与目录 / 读不出来的规则把整次激活搞死。

**三十九补**：13 条 `exact` 路由的**失败出口**（`lib/routes.js` 行 93% → **99.86%**）。上一批把每条路由的正常路径与参数校验跑通了，这一批补另一半：把依赖调用换成抛错，确认 handler 回的是 500 而不是 200，方法不对的一律 405 且 `Allow` 头说清楚。

七条只能跑出来的事实：

1. **`/apply` 的五个失败点各自处理方式不同，不是一律 500**。`commitOverrideOnApply` 抛错只 `console.warn` 继续打补丁（正文提交失败不该拦住建补丁）；`repairOfficialCliAfterUnpack` 抛错要收进响应体的 `cli_repair = { ok: false, error }`；`seedPromptInjectAtBoot` 抛错只把 `override_installed` 写成 `error:<msg>`；`resolveOfficialAiBase` 抛错才是 500 并 `endApply`。三个「不拦」的分支如果误写成 500，用户看到的是「补丁全打上了但面板报错」，比真失败更难判断。
2. **`/update` POST 排重启抛错被吞掉，更新结果照常 200**。`hostctl.scheduleRestart` 在 `try` 里单独包一层，失败只打日志 —— 因为「下载安装成功了、只是没排上重启」不能回滚成一次失败。
3. **`readJsonBody` 在坏 JSON 与超 512KB 时都抛异常 → 路由回 500，不是 400**。面板发坏请求得到的是 `ok:false` + `request body too large` / `Unexpected token`，而进度条会被 `endApply` 收尾（`getApplyProgress().active === false`）。
4. **`/hooks-deny` 读盘失败回 500，不会用上一次的值冒充成功**。GET 走 `refreshHooksDenySettings()`（先读盘再回），读失败就得让用户知道开关状态未知。
5. **`/rewind` POST 抛错回 500 而不是 409**。409 留给「回退被拒」（`result.ok === false`），异常一律 500 —— 面板据此区分「这次不许退」与「退的过程炸了」。
6. **`/uninstall` 抛错时不排清理重启**。`scheduleCleanupRestart` 只在成功分支里调，否则会在卸载失败后照样重启宿主，把用户刚看到一半的错误抹掉。
7. **`/own-servers` 的成功分支仍然走不到**：`lib/net-scope.js` 的 `writeAllowText()` 引用未声明的 `allowCache`（上游 1.1.94 刻意留空），所以 `sendJson(response, 200, ...)` 那一行是死代码。这是本批唯一剩下的未覆盖行（`lib/routes.js:618`），属现状锁定，不修。

RED 演练按行号定位（19 条突变，19/19 全红）：把每个 `sendJson(response, 500, ...)` 改成 200、把两个 `writeHead(405, ...)` 改成 200、把三处「只告警」改回 `throw e`、把 `if (arch) core.writeUnpackedAsarStamp(arch)` 置空、把 `onHost` 里的 `applied: info.index || 0` 改成 `0`。全部按 `MUTS = [label, 行号, 该行必须包含的片段, 替换后的整行]` 形式做单行替换，比锚点子串稳：`sendJson(response, 500, { ok: false, error: String(e) });` 在文件里出现十几次，靠子串必撞。

**四十补**：`lib/uninstall.js` 的卸载链路 —— 而这个文件本身就是**一个真缺陷的现场**。用户点「卸载」时走的就是 `uninstallPurge`（`lib/uninstall.js:205`），它一路做七件事：回退补丁、回退启动器、清 override/rules、摘掉 profile 清单里的引用、清演练授权、算清理列表、排清理重启。判错的表现全都不报错：少回退一个文件表现为「卸载完了宿主还是改过的样子」，清理列表算错表现为「卸载完留下一堆垃圾」或者更糟 —— **把用户的源码目录递归删掉**。

那个缺陷在 1.1.94 里已经存在：`collectCleanupDirs` 把 profile 里的 `node_modules/dsh-purge` 交给 `remember()` 记进清理列表，而 `remember()` 内部做 `fs.realpathSync(dir)`。npm link / `file:` 安装时这个链接的 realpath 就是**用户的源码目录**，于是清理列表里出现了 `…/src/dsh-purge-maintained`，而两个重启助手的 `rmTree` 判据是 `n.includes("/dsh-purge")` —— 子串命中，**照删**。本机刚好因为源码目录叫 `D:\dsh-purge-maintained`（不走 `pluginRoot()` 那条）而没事，任何把源码放在 `…/dsh-purge*` 下面的人都会中招。

修法是三处，都能单独解释：

1. `collectCleanupDirs` 拆成 `push(dir)` 与 `remember(dir)` 两个 helper。`push` **不做 realpath**，只按 `path.resolve(dir).toLowerCase()` 去重后入表；`remember` 保留 realpath 与 `/resources` 那道闸，末尾调 `push(real)`。profile 那条改成 `push(nm)` —— 记**链接本身**，因为 `rmTree` 见到符号链接只 `unlinkSync`，「摘掉插件」的正确粒度就是这个。
2. `lib/uninstall-restart.js` 与 `lib/restart-desktop.js` 两份 `rmTree` 各自新增 `const OWN_TREE = /\/(?:node_modules\/)?dsh-purge(?:\/|$)/;`，把 `n.includes("/dsh-purge")` 换成 `OWN_TREE.test(n)` —— 要求 `dsh-purge` 是**完整路径段**，`…-maintained`、`…-old` 都不再算插件树。探针实测九个路径：`.dsh/dsh-purge` ✓、`profiles/desktop/node_modules/dsh-purge` ✓、`D:/dsh-purge-maintained` ✗、`D:/src/dsh-purge-maintained` ✗、`resources/app` ✗、`resources/runtime` ✗、`node_modules/@deepseek-ai/dsh` ✗、`x/dsh-purge-old` ✗、`x/dsh-purge/` ✓。
3. `scripts/test-uninstall-purge.mjs`（**33 条**）第一次直接调 `uninstallPurge`，沙箱造一棵假宿主树 + 空 `$DSH_HOME` + 空 npm 前缀，`test.after` 还原十二个 env，末尾 `sha256sum` 对拍真机三个启动器一字未变。

七条只能跑出来的事实：

1. **`core.resetPathMemo()` 是沙箱用例的生命线**。`findAiBase` / `findDshHome` / `findShimDir` 全都记忆化；第一套沙箱跑完再造第二套，`gatherState()` 会继续用第一套的路径 —— 症状是五条本该 `applied:true` 的用例同时读成 `false`，而错误信息里一个字都不提路径。`sandbox()` 末尾必须调它。
2. **把 `package.json` 做成目录不是可靠的抛错手法**。`atomicWriteSync` 的 `existingMode(fp)` 有 catch，目录也能被 rename 覆盖，于是「profile 写盘失败 → 早退②」根本没触发（`ok:true`、`errors:[]`）。可靠写法是 monkeypatch `fs.renameSync` 抛错，`try/finally` 还原 → `errors === ["p1: rename boom"]`，且 `package.json` 逐字节未变。
3. **三条早退的字段不是一套**。早退①（补丁回退失败）与早退②（profile 写失败）都设 `ok:false / needRestart:false / cleanup:[]`；只有早退② 额外设 `drillGrantCleared:false`；早退③（清演练授权失败）**不设** `drillGrantCleared`（读数 `undefined`）。早退① 的判据看 `report.patches.errors` 而不是 `report.errors`，所以它触发时 `errors` 数组是空的。
4. **「失败只记一笔」和「早退」是两种处理**。删 override 失败（`prompt-inject.md` 做成目录 → `unlinkSync` EPERM）只往 `errors` 推一行 `remove override: …`，`ok` 仍 true，卸载继续往下走；`rules` 做成**文件**反而算清干净（`fsp.rm` 的 `force+recursive` 对文件成立），`rules_dir_removed:true` 且 `errors` 为空。
5. **`shouldDeletePluginTree` 自己不拦 `resources`**，那道闸在 `collectCleanupDirs` 的 `remember()` 里。所以 `…/resources/app/node_modules/dsh-purge` 对它返回 **true** —— 分工必须写进注释，否则下一个人会以为这里漏了防护。
6. **`updater.pluginRoot()` 走的是 `shouldDeletePluginTree`**，本机返回 `D:\dsh-purge-maintained` 所以不进表；换成 `…/node_modules/dsh-purge` 那种安装布局才进。这条判据决定了「卸载会不会删掉插件自己」，两边的用例都得有。
7. **`scheduleCleanupRestart` 只是转发** `hostctl.scheduleCleanupRestart(opts)`（`lib/host.js:22-24` 再转给 `hostAdapter()`），自己一行实现都没有 —— 源码形状钉住，别让它长成第二个实现。

RED 演练 **30 条注入 → 30/30 全红**（按行号单行替换，`MUTS` 每条四元组 `[label, 文件键, 1-based 行号, 该行必须含的片段, 替换后的整行]`，`finally` 写回，末尾校验字节还原）。首轮有 3 条 GREEN，处置分别是：①`bundles` 是标量时的新用例；②`readdirSync` 抛错写成 monkeypatch（把 catch 体改成 `throw`），原实现返回 `[]`；③`remember` 的 `/resources` 闸门 —— 造一条「插件目录是 junction，指向 `resources/app/node_modules/dsh-purge`」的现场，那条进不了清理列表。演练后补的这两条（去重、数据目录本身是链接）也各红一条：`push` 不去重会让同一条出现两次，`remember(realData)` 被跳过会把链接路径记成数据目录。

`lib/uninstall.js` 行命中 258/310 → **298/316**（分母 +6 是新增的两个 helper）、函数 19/23 → 22/24、分支 71/103 → 123/135；全仓行 **93.23% → 93.51%**（函数 83.80% → 84.00%、分支 89.55% → 89.85%）。全量 **3408 tests / 3406 pass / 0 fail / 2 skipped**。两平台各 33/33。

**四十一补：证据账本的十四条失败出口、两个计数的口径，以及一条「从来没成功过」的撤回**（`test-evidence-ledger-edges.mjs`，30 条）

这一批只加了一个测试文件、改了 3 处生产代码（少一处校验表、两处广告词），把 `lib/redteam/evidence-ledger.mjs` 从行 467/507 推到 **516/516（函数 20/20、分支 92.2%）**。十四条 catch 里有九条此前一行没跑过 —— 它们全都「不崩、只静默」，所以每一条都对应一种「看起来记上了、其实丢了」的现场。

七条只能跑出来的事实：

1. **三个方法的失败返回值形状各不相同。** `record` 抛 `{ ok:false, error }`；`get` 返回 `undefined`（与「库里没有这条」**完全无法区分**）；`list` 返回的是 **`{ error: 'prepare boom' }` 这个对象，不是数组** —— 调用方写 `list().map(...)` 会直接 TypeError，写 `list().length` 得到 `undefined`。`countUnverified` / `countUnresolvedClaims` / `unknown.list` 的失败一律回 `0` / `0` / `{ error }`，也就是「读不出来」被压成「真的没有」。这些都是现状，钉住不改：改返回值形状等于改公开 API。

2. **`countUnverified` 在全仓没有任何调用方。** 它是 `EvidenceLedger` 的公开方法（注释写着「审计与调试用」），只有 `countUnresolvedClaims` 被 `tool-specs-evidence.js:161` 用着。所以本批不是「补一条已有路径」，而是给一个只有外部调用者才会碰的方法钉口径：数的是 `claimed`+`inferred` 的**裸条数**，升级成 observed 之后**不降**（审计纪律要求 claimed 永久保留），要「还有几条没核实」得用 `countUnresolvedClaims`（按 `supporting_ev_ids` 反查闭环）。实测：两条 claimed/inferred + 一条 observed 引用掉其中一条 → 裸数仍是 2，未闭环数从 2 降到 1。

3. **库里 JSON 列坏了不抛，四列各自回落。** `parameters` → `{}`、`result` → `null`、`limitations` / `supporting_ev_ids` → `[]`，非 JSON 的列（`operation` 等）照原样给出；`list()` 走同一条解析路径。这是 `safeJsonParse` 的 catch 唯一能被触发的地方：**只有直接改库（或老数据）才造得出来**，走正常 `record` 永远写的是合法 JSON。

4. **「撤回」这条路从来没有成功过一次。** `resolve()` 原来认三个值 `resolved|contradicted|withdrawn`，而建表语句的 `status CHECK` 只允许 `open|investigating|blocked|contradicted|resolved` —— 传 `withdrawn` 会一路走到 SQLite，返回 `CHECK constraint failed: status IN (...)`。工具说明书也照着宣传 `resolved | contradicted | withdrawn`，于是模型照着说明选一项，拿到一句 SQL 报错。**修法选的是「把广告词收回」而不是「改表」**：加 `withdrawn` 要改 DDL，而 `CREATE TABLE IF NOT EXISTS` 对用户已有的库不生效，得再补一次重建表的迁移 —— 那是另一个风险等级的动作，不该混在一批测试里做。现在抽了 `export const RESOLVE_DISPOSITIONS = ['resolved','contradicted']`，`resolve()` 的校验与提示、`tool-specs-evidence.js` 的描述、`test-redteam-tool-branches.mjs` 里那句旧文案一起改齐，并加了一条**源码形状**守卫：从 `EVIDENCE_LEDGER_DDL` 里解析出 `status CHECK` 的取值集合，断言「`RESOLVE_DISPOSITIONS` 是它的子集」且两边都不含 `withdrawn`。以后再想加回 `withdrawn`，这条守卫会先拦住 —— 那时必须先改 DDL、再想迁移，不能只改那个数组。

5. **去重键折叠空白，存进去的是原文。** `unk_id` 用 `question.replace(/\s+/gu,' ').trim()` 算（所以「只差多个空格」的两条合成一条），但入库的是 `question.trim()`（内部双空格保留）。留下的是**先写进去的那份版式**。现状锁定：改它会让同一句话在库里出现第二种写法。

6. **`list()` 不传 `status` 时列出全部，含已解决的。** 工具层默认传 `open`，类本身没有默认过滤 —— 直接调类的人会看到 resolved 的行。另外 `ORDER BY recorded_at DESC` 的精度是**毫秒**：同一毫秒内写的多条之间没有稳定次序，任何「取最新一条」的写法都不能靠它（本批为这条专门写了一个只断言集合、不断言顺序的用例，因为在慢机器上「三条同一毫秒」本身就不成立，断言它会变成假红）。

7. **`residual_unknown` 的 `investigating` / `blocked` 两个状态没有任何入口。** `status CHECK` 允许它们，`resolve()` 只写 `resolved` / `contradicted`，也没有别的更新方法 —— 想改状态只能直连库。已写进盲区。

**RED 演练**：`.tmp89-drill.mjs` **23 条突变 → 23/23 全红**（`restored: true`，分两片 `0 12` / `12 23`）：四道校验各拿掉 / `result` 放过 null / `canonicalize` 不排序键 / `record` 的错误文本改用 `String(err)`（带 `Error: ` 前缀）/ `get` 读失败回 `null` / `upgrade` 的拒绝文案改写 / `list` 失败回空数组 / `countUnverified` 只数 claimed 或恒回 0 或 catch 回 -1 / 闭环不看 observed 引用 / `countUnresolvedClaims` 的 catch 回 -1 / question 与 severity 的校验文案与判据 / 去重键不折叠空白 / `unknown.record` 与 `resolve` 与 `unknown.list` 三个出口 / `safeJsonParse` 回 undefined / `RESOLVE_DISPOSITIONS` 加回 withdrawn / `status CHECK` 也加 withdrawn。**没有等价突变，也没有 ANCHOR** —— 行号取自改完之后的文件（这次改动插了 8 行常量注释，行号整体下移，写死在脚本里之前先 `grep -n` 对了六处）。

**为什么这十四条值得一测**：丢的是一条证据，不是一条日志。`record` 失败但调用方没看 `ok`，账面就少了「谁在什么时候用什么工具拿到了什么」；`get` 与 `countUnverified` 的失败被压成 `undefined` / `0`，指挥智能体看到的是「没有待核实项」，然后就派下一轮活去了。判错形态是**安静地少一条**，不会报错、不会崩、面板也照常显示。
**四十二补**：演练台库的「筛选面 / 报告面 / 死代码」—— `listAssets` 的五个筛选（service / fingerprint / provenance / priority / scope）、`sort=todo` 与 `sort=ports` 两条排序串、`listShots` 的四个过滤、`deleteScorePoint` 的内置点拒绝与事务回滚、`saveScorePoint` 的名称必填、`addScoreHit` 的 `point_name` 解析与「顶掉旧命中 / 被旧命中顶掉」两种警告、报告里的「复现请求」段、`searchPocs` 的来源筛选、`listEngagements({stats:true})` 的坏库兜底、`refreshDefaultPrompts` 的 `.bak`、`readAttackFile` 的越界拒绝。测试文件 `scripts/test-store-core-facets.mjs` **26 条**，两平台各 26/26；生产改动是**删掉两处从来没有人调用过的私有成员**（`isCappedPoint` 与 `#hitTrace`，`lib/redteam/store-core.js` 3832 → 3822 行）。

七条只能跑出来的事实（写断言前先跑探针，逐条实测）：

1. **`priority` 只能靠 `assessAsset` 写进去**。`importBundle` 的资产对象里带 `priority` 会被丢掉 —— 所以「按 priority 筛」的用例如果只用 `importBundle` 造数据，筛出来永远是空表，看起来像「SQL 写错了」。实测三种写入路径：`importBundle`（不认）、`assessAsset`（认，且 `medium`/`low` 之外的非法值一律回落 `medium`）、直接 UPDATE（认）。**未评估的资产 `priority` 是 `NULL`，不是 `medium`** —— 筛 `priority: 'medium'` 出空表是正确行为。
2. **`sort=todo` 的第一键是 `test_status`（`untested` 0 / `testing` 1 / `tested` 2 / `blocked` 3 / `abandoned` 4 / `no_surface` 5 / 其他 6），第二键才是 `priority`**，第三键是开放端口数、最后是 `ip_int`。实测 `[high 未测, low 未测, NULL 未测]` → `[high, low, NULL]`；把 high 那条标成 `tested` 之后它掉到队尾。`updateAssetTest` 的参数名是 **`status`**（不是 `test_status`），传错名字会静默不生效（`status` 回落成原值），用例会「什么都没改但看着绿」。
3. **`sort=ports` 用的是「开放端口数」而不是「端口总数」**，`state='open'` 之外的不算。`sort=ip`（默认以外的第四条分支）走的是 `a.ip_int`，而 `ip_int` 是写入时算好的整数列。
4. **`listShots` 返回的是 `{ok, items, total}`**（不是数组，也不是 `{items}` 加别的东西），`total === items.length`（没有分页）；三个 id 列（`hit_id` / `asset_id` / `vuln_id`）是「且」，而 `point_code` 走 `s.point_id = (SELECT id FROM score_point WHERE code = ?)` —— **`point_code` 拼错的时候整段 WHERE 恒假，出空表而不是全表**，这正好是想要的（`point_code=''` 才是「不筛」）。
5. **`deleteScorePoint` 的回滚只在这条路上才有意义**：`BEGIN` → `DELETE FROM score_hit` → `DELETE FROM score_point` → `COMMIT`，`catch` 里 `ROLLBACK` 再抛。实测把 `score_hit` 表 `DROP` 掉再调 → 抛 `no such table: score_hit`，得分点**仍在**，并且**事务确实被收掉了**（紧接着 `BEGIN`/`COMMIT` 不报错）。少一句 `ROLLBACK` 时，`BEGIN` 会抛 `cannot start a transaction within a transaction` —— 这才是能区分「有没有回滚」的读数。
6. **`addScoreHit` 的两种警告互斥且方向相反**：打**更高**的一档时 `counted:true` + `demoted_hits` 列出被顶掉的旧命中 + 警告「这条把同服务上分值更低的 N 条旧命中顶掉了……本次记分不会让总分增加」；打**更低**的一档时 `counted:false` + `capped_by_service:true` + `demoted_hits` 为空 + 警告「这条按规则不再计分，只作过程留痕……计分的是同服务的另一条：<证据前 120 字>」。两条都只对 `dedup_scope === 'service'` 的得分点生效，`none` 类的点是累加的、永远不进这两个分支。
7. **报告里「复现请求」段有两条独立实现**（`reportTargets` 一处、`report` 一处，行号相差约 120 行）。`report()` 用的是自己那份 —— 所以 `test-store-core-facets.mjs` 的断言只对 `report()` 生效，改 `reportTargets` 那一份不会变红（`lib/redteam/store-core.js` 里 `3369-3375` 至今仍是未覆盖，已登记为盲区）。段内：请求**去掉全部 CR**（粘进 Burp 才是合法的 HTTP 文本）、响应 `slice(0, 2000)`（2500 个 `x` 进来，报告里只留 1983 个 —— 前 17 个字符是 `HTTP/1.1 200 OK\n\n`）、整份报告里一个 `\r` 都不剩。

**删掉的两处死代码**（这是本批唯一的 `lib/` 改动）：

- `isCappedPoint`（`scorePoints` 里的局部箭头函数，4 行）：全仓唯一出现位置就是定义本身。它在算「这个得分点参不参与同口径去重」，而真正的判断在下面 `meta.dedup_scope` 那几行里直接做了。
- `#hitTrace`（私有方法，3 行）：只 `return hitTrace(this, db, hit, engagementId)`，转发的同名函数在 `lib/redteam/score-report.js` 里确实在用（`scoreReport` / `reportTargets` 直接 import 它），所以**它看起来像在用**。删掉方法后 `store-core.js` 的 import 名单里也去掉了 `hitTrace`。
- 判据是 `grep -n "isCappedPoint\|#hitTrace" lib/redteam/store-core.js` 只命中定义行；`hitTrace` 名字本身在别的文件里出现不影响这个判断（要按**接收者**看：`this.#hitTrace` 一次都没有）。

**一个等价突变的判据**：把 `catch` 里的 `db.exec('ROLLBACK')` 换成 `db.exec('COMMIT')` 时，测试**仍然全绿** —— 因为这条路上「还没成功写过任何东西」（`DELETE FROM score_hit` 就失败了，事务里没有脏数据），`COMMIT` 与 `ROLLBACK` 的可见效果相同。能区分的是把回滚整句**去掉**（`BEGIN` 会报「事务未结束」）。所以演练里那一条突变写成「不回滚」，并在测试里补了 `assert.doesNotThrow(BEGIN/COMMIT)` 这条断言。

**覆盖率**：`lib/redteam/store-core.js` 行 3741/3831 → **3794/3822**（分母 −9 是删掉的两处死代码）、函数 250 → **251/259**、分支 1290 → **1368/1584**；全仓行 **93.81%** / 函数 84.66% / 分支 90.02%。RED 演练 **26 条突变 → 26/26 全红**（无 ANCHOR、无等价突变留在里面）。
**四十三补**：`/rewind` 的第二批兜底 —— 服务查找失败、草稿到点作废、回退后原会话怎么藏、空白会话怎么建。测试文件 `scripts/test-rewind-edges2.mjs` **24 条**（两平台各 24/24），生产改动只有**十二个私有函数加 `export`**（公开行为零变化），`lib/rewind.js` 行覆盖 **644/644（100%）**、分支 365/365（100%）。这一批把 `lib/rewind.js` 从「96% 但有十二段小兜底没跑过」推到「一行不剩」，做法是把「拿不到服务时退回去」的每一个 `catch` 都做成可观测输入。

七条只能跑出来的事实：

1. **`service(ctx, name)` 的 `typeof ctx.get !== "function"` 守卫是冗余的** —— 它后面紧跟 `try { return ctx.get(name); } catch { return undefined; }`，把守卫删掉之后 `{}` 只会抛 `ctx.get is not a function` 被同一个 catch 吃掉，返回同样 `undefined`。这是**第五种等价突变**（同一函数里前后两道判据互相兜底），演练里直接删掉这条突变，不为它造用例。
2. **`isRoundPromptEvent` 对不认识的 `source.kind` 一律 `false`**：`{kind:'system'}`、`{kind:'tool'}`、`{kind:'goal'}` 缺 `round` 都是 false；只有 `user` / 空 kind 才是 true。这条决定了「round 模式撤到哪一句话」——认错了会把系统提示当成用户那句话带进草稿。
3. **`planRewindStep` 的 `blank` 模式只在「整段最开头」出现**：`step/start` 的 seq 是最小值（没有更早的 seq 可比）且有正文时返回 `{ok:true, mode:'blank', text, fromSeq:0}`；同样位置但没有正文时返回 `{ok:false, error:'Nothing to undo'}`。这两种都跟「fork 出一个子会话」是完全不同的落地路径（一个是新建空白会话、一个是直接拒绝）。
4. **`readSessionLog` 走 `observeSession` 这条路时，disposer 一定被调用**（`finally { disposeObservation(observed) }`），而且 **disposer 自己抛错会被吞掉、正文照常返回**。实测：`[Symbol.dispose](){ throw }` 时函数仍然返回 `{events:[]}`。这两条一起意味着「宿主的观察句柄漏 dispose」不会表现为报错，只会表现为句柄泄漏 —— 所以必须把「dispose 被调过几次」当断言，不能只看「函数没抛」。
5. **`resetRequestSeries` 是三个独立 try**：`requestHeaderLogged` / `requestSurfaceGeneration` / `frozenMessages.clear()` 各包一层。实测把第一个的 setter 做成抛错，后两个照常执行（`[['gen',-1],['clear']]`）；`frozenMessages` 的 **getter** 抛错也被吞。写成一句大 try 的话，第一个抛了后面两个就都不执行 —— 而这三个字段各自对应「回退后重发要按新请求开」的一层假设，漏一层会出现「用上一轮的 header series」。
6. **`resolveMainSession` 的父子指针互指成环时不会死循环**：`seen` 集合挡住重复 id，循环退出后**重读入口会话**返回（实测读取序列 `a → b → a`）。这一条如果用「循环退出就直接返回入参」的写法，会把 `log` 丢掉，`round` 回退就退不动。
7. **`hideRewoundSource` 的三级优先**：`workspaceRegistry.archiveSession`（有就用它）→ 否则 `workspaces.archiveSession` → 都不行再去 `workspaceRegistry.get(id).detachSession`。三条里 **`detachSession` 与 `archiveSession` 是两件事**：前者把会话从工作区列表里摘掉（`hidden=true`），后者是归档。两者都失败时返回 `false` 而不是抛 —— 因为「旧会话没藏住」不该挡住新会话重发。

**草稿过期怎么测**：`DRAFT_TTL_MS` 是模块常量（10 分钟），硬等不可行。做法是**在单个用例里把 `Date.now` 换成「真实时间 + 11 分钟」并在 `finally` 里还原** —— 这是全局对象的替换，`import * as rw from "../lib/rewind.js"` 的命名空间只读不影响的唯一一条路。两条纪律：

- 只能替换 `Date.now`（模块里所有过期判据都走它），别去 `Object.defineProperty(global, ...)` 别的计时器；
- **`finally` 必须还原**，否则同文件后续用例全部「时间在未来」，`getDraft` 立刻返回 null。

**两个等价突变的判据**：①「`service` 去掉 `typeof ctx.get` 守卫」等价（见第 1 条）；②「过期时 `lastPending = null;` 换成 `void 0`」在第一版测试里也是等价的 —— 因为 `getPending` 紧接着 `return null`，看上去一样。真正能区分的是**把时钟拨回来之后再问一次**：清空了就是 null，没清空就会把那条过期记录当成新鲜草稿交出去。判据写成 `assert.equal(rw.getPending(), null)`（在 `finally` 还原时钟之后）之后，这条突变才红。

**覆盖率**：`lib/rewind.js` 行 618/644 → **644/644（100%）**、函数 56 → 57/57、分支 312 → **365/365（100%）**；全仓行 **93.88%** / 函数 85.01% / 分支 90.06%。RED 演练 **19 条突变 → 19/19 全红**（一次分片跑，无 ANCHOR）。



**四十四补**（`lib/profile-insert.js` 的边角：insert 段状态机 / `classifyPatchBody` 五形态 / allowBuilds 的两处段结束）：

1. **`profileHasPurgeBodyInsert` 里「关闭后遇到另一个 `- insert:` 就重开」那三行永远走不到。** 上面第一条 `if (/^-\s*insert:\s*$/.test(line) || /^\s+-\s*insert:\s*$/.test(line))` 已经把**任意缩进**的 `- insert:` 全收走了（两个分支合起来覆盖「0 个空白」与「至少 1 个空白」），所以走到下面那句 `if (/^-\s*insert:\s*$/.test(trimmed))` 的行必然不是 `- insert:`。用单文件 lcov 验证：新用例跑完后 `46` `47` 两行命中数仍为 0，`45` 那句 `if` 只执行了判断侧。**处置：删掉这三行，原地留两行注释**（和 `isCappedPoint` / `#hitTrace` / `readJsonNoBom` 同类：判据是「一条测试都打不到 + 说得清为什么打不到」）。
2. **内层 insert 段的结束判据必须比本行缩进，不是比顶层 0。** 用户手写的 `- plugins:` 里嵌一层 `  - insert:` 时，只有「兄弟键缩进 2 <= 本行缩进 2」才算段结束；写死成 0 会让 `  - other:` 关不掉段，于是后面 `    - id: dsh-purge` 被误判成命中（结果就是同一条 insert 被写两遍）。
3. **`classifyPatchBody` 的五形态边界**：空文件与「只有注释和空行」都是 `empty`；`[]`（可带 `---` 前缀、可带行尾注释）单独一档 `empty-flow`；非空 flow 序列 `[a, b]` 是用户内容 `flow-seq`；块序列里**混进一条顶层 `[`** 判 `unknown`（认不准就不写）；多文档用 `---` 切开后**只看最后一个**（追加内容会落在最后一个文档里）。
4. **`validateAllowBuildRewrite` 的段结束不是「跳过那一行」，而是清掉段标记。** 回退那一行本身由后面的 `continue` 跳过，所以「`inAllow = false` 留着」与「改成 `void 0`」在**这一行**上完全等价 —— 差别只在**再下一行又深缩进回来**时显形：段标记没清，那行会被当成段内键去校验（垃圾键就判不过）。造 fixture 必须把「回退行 + 再深缩进行」两行一起放进去。
5. **`rewritePnpmAllowBuilds` 的两处段结束 + 两类原样保留**：空行结束段、顶格行（`/^\S/`）结束段；段内注释行与解析不出的行**连缩进一起原样保留**（`kept.push(line)` 不是 `line.trim()`）。后者是「不认识的用户内容一个字都不动」这条纪律的具体形态。
6. **`ensurePnpmAllowBuild` 只有一个拒绝出口**：重写结果过不了校验就 `{ ok: false, wrote: false, reason: "allowBuilds-invalid" }`，**原文一字不动**。用「`packages:` 顶层键重复」就能造出来（重写只换 `allowBuilds:` 段，重复的顶层键会原样留在 next 里）。
7. **`profileOwnsPurge` 探测 `node_modules/dsh-purge/package.json` 时 `fs.existsSync` 抛错就当「没有」**（`return false`）→ 整个 profile 被跳过，`ensureAllProfileBodyInserts` 返回 `[]`、一个字都不写。这是「探测失败时宁可不动用户的 profile」的兜底。

**RED 演练**：23 条突变 → **23/23 全红**（分两片 `0 12` / `12 23`，两片都 `restored:true`、无 ANCHOR）。其中「上一道 if 已收走」那条在整段删除前是 GREEN —— 删掉那三行之后该突变一并从清单里删掉（否则会变成「改注释」的假突变）。

**覆盖率**：`lib/profile-insert.js` 行 392 → **412/412（100%）**、分支 149 → 168/188（89.4%）；全仓行 **93.88% → 93.93%** / 函数 84.95% / 分支 90.06%。行总数 413 → 412 是删掉那三行的结果。

**四十五补**（`lib/hide-console.js` 还剩下的三条兜底：退回 `createRequire`、没有 hint 时的 `process.argv[1]`、sidecar 删不掉）：

1. **`builtinChildProcess()` 是两层通道，第一层炸了会静默退到第二层。** `process.getBuiltinModule` 在 Electron 沙箱里可能直接抛，catch 之后走 `createRequire(import.meta.url)("node:child_process")`；两层都拿不到才返回 `null`（`installHideConsole` 于是报 `skipped: "builtin_unavailable"`）。测第一层炸的方式是**把 `process.getBuiltinModule` 换成抛错函数**，并且断言它「被摸过一次」——只看 `installHideConsole()` 的返回值区分不了「走了第一层」还是「直接走了第二层」，因为两条路都能装上。
2. **`resolveDshBinRoot(undefined, …)` 会用 `process.argv[1]`**：只要它匹配 `/[\\/]bin\.js$/i`，就把它的上两级目录塞进候选链（`node <pkg>/lib/bin.js` 起的进程就是这种形态）。这条用例必须临时改 `process.argv[1]` 并在 `finally` 还原 —— 它是全局状态，漏还原会让同文件后面的用例看到一条假路径。
3. **`revertHideConsoleFromBin` 删 sidecar 的 `catch` 是「重启后再删」，不是「算改过」。** 删不掉时 `changed` 保持 `false`，函数返回 `"absent"` 而不是 `"reverted"` —— 外部（安装/卸载流程）靠这个返回值决定要不要再排一次重启，谎报成 `"reverted"` 就等于把一次失败吞掉。造法是把假 fs 的 `unlinkSync` 换成抛 `EBUSY`。

**RED 演练**：4 条突变 → **4/4 全红**（单进程跑，`restored:true`、无 ANCHOR）。四条分别是：`fork` 的 args-即-options 分支去掉、内置模块通道改成不走（`getBuiltinModule` 一次都不被摸）、不认 `argv[1]` 是 `lib/bin.js`、删 sidecar 失败也置 `changed = true`。

**覆盖率**：`lib/hide-console.js` 行 326 → **336/339（99.1%）**、分支 122 → 128/134（95.5%）、函数 100%；全仓行 **93.93% → 93.95%** / 函数 85.21% / 分支 90.06%。

**四十六补**（`apply()` 剩下的十行：注入失败也照样起、装配失败被吞、`/purge` 本体、桌面自愈两条记账）：

`lib/index.js` 批94 之前是 403/429。剩下那 26 行按「能不能造出现场」分成三堆，最后只有 16 行拿到了用例，另外 10 行的结论是「本机造不出来，只能钉源码 + 留检测办法」。

1. **`inject(["connection"])` 抛错时 `catch` 里也 mark**：`/status` 必须回 200 而不是 503。造法是假 ctx 的 `inject` 对 `connection` 抛，但对 `webServer` 照常回调。**不能**用「压根没有 `ctx.inject`」来造 `:139-142` 那三行——`installWebServer` 无条件调 `ctx.inject`，所以经 `apply()` 永远走不到那一支（写进盲区 94）。
2. **`seedPromptInjectAtBoot` 从不抛**：三种坏现场（`DSH_HOME` 是文件、`DSH_HOME` 不存在、`prompt-inject.md` 是目录）全都只返回 `action:"error"` + `reason`，因为 `syncPromptInjectOnDiskSync` 内部已经把 `atomicWriteSync` 整个包进 try/catch。所以 `:229-230` 那个 `catch` 唯一能兜的是「真异常」，本机造不出来。`DSH_HOME` 里塞 NUL 也没用——`process.env` 会把它吞掉。检测办法：`grep -n "seed prompt-inject failed:" lib/index.js` 必须命中一行。
3. **profile 自愈「真写了才记账」**：造 `profiles/p1/node_modules/dsh-purge/package.json` + 清单里 `dependencies.dsh-purge` → `ensureAllProfileInstall` 真的补出 `cordis.patch.yml`，日志里恰好一行 `profile heal: <…>/profiles/p1`；干净的 home 一行都不许有。这条钉的是「日志与落盘一致」，不是「日志打得好不好看」。
4. **settle 定时器两种醒来方式**：先 `apply()` 收齐 effect，**只跑 `String(f).includes('alive')` 那一个**并 dispose（跑全部会把第 3 个「清 timer」也跑掉，变成「定时器没响」），等 30ms → 日志出现 `settle skipped: inactive context`；反过来一个 effect 都不跑 → 0ms 后自己醒来，日志里恰好一行 `settle: boot:host-untouched`（或 `skip:boot-no-host-write`）。
5. **桌面面两条记账分头走**：`DSH_DESKTOP_INSTALL` 指假安装树 + `DSH_SURFACE=desktop` → `[heal-runtime-payload] ok=false` 必有一行（假树里的 `runtime/` 是空的）；`[heal-office-skills]` 则取决于这台机器上有没有官方 office 资产——有就恰好一行 `healed=true` 且文件真落盘，没有就一行都没有。web 面两条都没有。**这两条用例都核对真机 `resources/runtime/office-skills/office/SKILL.md` 的 mtime 前后不变**，因为 `officeSkillAssetSources()` 读的是真安装树。
6. **anchor/subagent 装配抛错被吞**：`systemPrompt` 用 getter 计数，**第 6 次读取**抛错正好落进 `:344-346` 的 catch——第 1、3 次抛得更早（`specs` 变 0，说明整条 apply 挂了），第 9、12 次落在后面那层 `ctx.effect` 的 try 里。日志里恰好一行 `[apply-hooks] name=anchor/subagent err=sp_getter_boom`，且 16 条路由仍然注册完。
7. **`/purge` 一次注册四条命令**（`purge` / `rules` / `skills` / `rewind`，按 name 取而不是取 `cmds[0]`）：无子命令回 `{kind:"success", text:"dsh-purge 命令：…"}`，`/purge status` 走状态渲染且不抛。命令对象的键恰好是 `description` / `handler` / `input` / `name`。

**RED 演练**：13 条突变 → **13/13 全红**（单进程跑完，`restored:true`、无 ANCHOR）。十三条分别是：inject 抛错后不 mark、seed 日志不打、profile 自愈结果不接、profile heal 条件恒假、profile heal 日志不打、settle 不判活着、settle 跳过文案改写、settle 结论不入日志、桌面面整段不跑、office 自愈不记账、runtime 探测恒真、anchor 失败不记账、不取 commands 服务。

**覆盖率**：`lib/index.js` 行 403 → **419/429（97.7%）**、函数 30 → 31/39、分支 67 → 74/108；`lib/desktop.js` 行 1813 → **1837/2272**、函数 103 → 105/116（那两条用例顺带把 `healOfficeSkillsRuntimeOnDisk` 与 `inspectRuntimePayload` 的调用链跑到了）。全仓行 **93.95% → 94.07%** / 函数 85.31% / 分支 90.24%。

## 四十七补：红队工具注册面的边角（参数封口 / FIFO 上限 / 根会话上溯 / 实时并发 / 桩库）

`scripts/test-tools-edges.mjs`（27 条）。这一批没有改动生产行为，只给 `lib/redteam/tools.js` 里
八个私有函数加 `export`（`sealObjectSchemas` / `makeDefineTool` / `capMap` / `sessionInfoOf` /
`resolveRootSession` / `bindingKeyOf` / `liveRunningChildren` / `reservationList`），
把 `test-redteam-tools.mjs`（36 条，走 64 个工具的对外行为）与 `test-tools-resolve.mjs`
（26 条，走定义器解析与 `subagent/end`）都没碰的 21 行补上。

只有在这台机器上跑一遍才知道的七件事：

1. **真实参数面里没有一个 `type:'object'` 的嵌套节点。** 把 `apply()` 收到的 64 个
   `parameters` 全树遍历，`objSealed` / `objClosed` / `shouldNotExist` / `props` / `apObj`
   五个标记一个都没置位（只有 5 个参数带数组）。所以 `sealObjectSchemas` 的对象分支
   在线上是**纯保险**，只能直接调函数造样例来测 —— 这也解释了为什么它此前一行都没覆盖。
2. **封口的两个默认值方向相反且都合理**：`{ type:'object' }`（没有 properties）→
   `additionalProperties = true`；`{ type:'object', properties:{…} }` → `false`。
   反过来封会把「自由形状的对象」写成合法空对象，或把「已知字段的对象」写成可塞任意键。
3. **`capMap` 只劫持 `set`，同键重设不淘汰。** `!m.has(k) && m.size >= cap` 才删最早键 ——
   长会话里同一个 session id 反复绑定不应该把自己挤掉。突变「满员不淘汰」与「淘汰那步不做」
   都会让 `bindings` / `reservations` 无限涨。
4. **`resolveRootSession` 的父不在内存 ≠ 找不到根。** `store.get(parentId)` 返回 `undefined`
   或抛错时，**父 id 本身就是稳定根键**（`{rootId: info.parentId, chain: [..., parentId]}`）——
   冷启动 / 父会话被回收时若回落到「自己」，同一家族的绑定键就会在重启后分叉。
5. **父子互指的死环靠 `guard < 64` 停下**，不是靠「见过就停」：`chain` 长度恒为 64、
   首尾分别是起点与第二层。这条上限也是唯一能防住 `while` 死循环的东西。
6. **`liveRunningChildren` 的三态要用三个不同返回值区分**：注册表不可用 →
   `{available:false, error:'subagents 注册表不可用…'}`；`listChildren` 抛错 →
   `{available:false, error:'列子会话失败：…'}`；返回非数组 → `{available:true, running:0}`。
   把非数组当空表而不是当错误，是因为宿主在「还没有子会话」时可能回 `null`。
7. **`apply()` 拿不到 store 时仍然注册满 64 个工具。** `ctx.redteam` 的 getter 抛错 →
   退到 `ctx.get('redteam')` → 都没有就 warn 一条
   `redteam-tools: host ctx.redteam unavailable — tools will report store_missing`
   并塞一个三件套桩库（`openEngagement` 抛「红队资产库不可用」、`listEngagements` 回 `[]`、
   `stats` 回 `{}`）。桩库的意义是让工具**存在但报错**，而不是让插件装不上。

RED 演练 25 条突变 → **25/25 全红**（分两片 `0 13` / `13 25`，`restored:true`，无 ANCHOR、
无等价突变）。行号口径就是改完后文件的真实行号（`138 / 141 / 142 / 144 / 147 / 148 / 164 /
166 / 167 / 168 / 191 / 193 / 219 / 232 / 242 / 244 / 361 / 362 / 366 / 367 / 370 / 377 /
459 / 465 / 467`）。

覆盖率：`lib/redteam/tools.js` 行 479 → **500/501**（唯一剩下的 `:131` 是
`loadDefineTool()` 的 `return resolveDefineTool(...)` 兜底 —— 本机能直接解析到宿主
`@deepseek-ai/dsh-tools`，所以走不到，CI 上才走）、函数 36 → **39/42**、分支 142 → 194。
全仓行 94.07% → **94.12%** / 函数 85.36% / 分支 90.37%。

## 四十八补：注入兜底的四档每一档都单独走到（含熔断的真慢触发）

**2026-11-14 四十八补**：`lib/prompt-source.js` 剩下的 39 行（`114-119` 熔断档、`129-142` 后三档降级与全空、`237`/`245` 空提示词闸门、`249-250` 重启前体检的转发、`280-282` disposer 回收循环、`309-314` 能力纪律段的取文、`342-348` 读盘兜底的 `ensure` 与 `empty` 两支）此前被当作「要真等 30 秒冷却 / 要四层同时为空」而挂着。这一批全部补上（`scripts/test-prompt-source-edges.mjs`，**15 条**），该文件行覆盖 **363/363 = 100%**，分支 81 → 114/133。下面七条只有真跑过才知道：

1. **「让密封槽为空」= 让 `createDecipheriv` 抛错**。`lib/table-read.js:6` 的 `openSlot()` 整段包在 try/catch，失败就回 `""`，于是 `core.defaultOverrideText()` 从 21219 变 0。但必须用 `createRequire(import.meta.url)("node:crypto")` 拿到 CJS 对象再赋值——`await import("node:crypto")` 的命名空间只读，会直接报 `Cannot assign to read only property 'createDecipheriv'`；改完还要 `syncBuiltinESMExports()` 让 ESM 侧同引用生效。**恢复时不能 `delete`**——`delete` 之后 CJS 对象上再没有 own property，ESM 绑定仍指向坏实现，`defaultOverrideText()` 会一直是 0（这是探针 8 的失败原因）；必须把模块加载时捕获的 `REAL_DECIPHER` 赋回去再 sync 一次。
2. **「让 refresh 返回空」比想象中难**。只写一个空白 `prompt-inject.md` 不行：`rules.resolveInjectText` 的四级兜底会落到 `default` 档（内置正文 20994），而且 `syncPromptInjectOnDiskSync` 会把空白文件补成完整正文。正确顺序是 **先破密封槽 → 调一次 `fn()`（这一轮缓存里存的是空、`mtime=0`）→ 恢复密封槽或写盘（不动 `mtime`/版本号）→ 再调 `fn()`**，这样 refresh 仍命中缓存里那份空，才会往下掉。
3. **`disk` 档要求「缓存空 且 mtime 没变」**。写盘之后 `fs.utimesSync(fp, 0, 0)` 把 mtime 拨回 0 才走 `disk`；只拨回原来的值不算——`statSync` 精度是秒级，会算成不同值，refresh 直接读到磁盘正文，日志记的是 `tier=refresh`（探针 5 的失败原因）。
4. **熔断只能靠「真慢一次」**。`hungSlowAt` / `hungDepth` 是 `installHungPromptGlobal` 的闭包 `let`，外部无法置位；把 `fs.statSync` 包一层忙等 1700ms 再调一次 `fn()`，`finally` 里 `cost >= HUNG_SLOW_MS` 才会置上冷却时间，紧接着的第二次调用才走 `tier=breaker`。这条用例单跑要 6.8 秒（`refreshHungOperator` 内部多次 `statSync` 全被拖慢），必须放文件最后，否则把别的用例的超时也拖起来。
5. **`capabilityProtocolText` 只认 `enabled`**（`lib/capability-protocol.js:29-31`），`redteam` / `redteamChild` 两个入参目前不影响输出——普通会话、`{header:{agentPreset:"redteam"}}`、`{agentPreset:"redteam"}` 三种上下文取到的正文都是同一份 1050 字节。这一条只能断言「三者相等且等于 `capabilityProtocolText({enabled:true})`」，不能凭空断言红队版多了什么。
6. **`addPromptSection` 的第二个 host 是 `ctx` 自己**，所以假 ctx 的 `systemPrompt` 自身必须有 `.section`；只给 `ctx.systemPrompt = { ctx: sp }` 会抛 `TypeError: host.systemPrompt.section is not a function`。而回收 disposer 的循环（`280-282`）只有让 `section()` 真的返回函数才执行——原来那条用例只断言 `doesNotThrow`，drill 里「把循环改成空数组」是 GREEN，改成收集 `disposerCalls` 并断言 `["dsh-purge","dshpg-capabilities"]` 后才红。
7. **`ensureRestartReady` 真的会摸本机安装树**（实测 1.5 秒、返回 `hosts: [仓库树, 桌面安装树]`），所以用例必须给沙箱 `DSH_BASE`；否则在 CI 上会去 stat 不存在的路径，耗时也不稳。

RED 演练 `.tmp96-drill.mjs` **18 条突变 → 18/18 全红**（首轮 17 红 1 绿，绿的正是上面第 6 条，补断言后复跑转红）。顺带修掉一个**已有测试的假红**：`scripts/test-plugin-apply-edges.mjs` 的 `settle 正常返回结论字符串并写进日志` 原来固定等 60ms，而本机 settle 结论要 174ms 才出现（`rules init` 131ms），三连跑必红；改成轮询最多 200×20ms 后稳定 15/15。

---

## 四十九补：preflight 的「下一步该做什么」五条分支各自单独走到

`redteam_preflight` 返回的 `next` 是模型决定「先去问用户什么」的唯一依据，而它原来**一条都没跑到过**：
`test-redteam-tool-branches.mjs` 那 5 条用例全跑在本机真实平台（win32）上，第一个分支
`plat.runtime.windows && (!hasMarker || missing.length > 0 || allBroken.length > 0)` 在这里恒真，
后面四条（首次无脚本 / 有脚本没跑 / 有缺口 / 有坏技能 / 全干净）一次也走不到。所以「缺什么、能不能开工、
要不要让用户自己跑 setup.sh」这些话从来没被验证过。

`test-recon-preflight-edges.mjs`（9 条）用 `$DSH_HOME/redteam/config.json` 的 `platform: "linux"` 把平台钉死
（`isWinLike` 先看显式配置再回落 `osPlatform()`），于是同一份期望值在 Windows 与 ubuntu 上都成立。

1. **五条分支的触发条件与文案要点**（全部实测）：①linux、无 `.setup-complete`、无 `setup.sh` →
   「首次使用，且本机没有安装脚本 ……（这是正常情况，不是故障）」+ `crt.sh` 降级方案；②有 `setup.sh` 没跑过 →
   「让用户自己执行 `bash … --check`」+「不要由智能体执行 `--yes`」；③marker 在但缺 `FOFA_KEY` →
   「有缺口」+ 指向 `onboarding.missing` +「不要替用户下载工具」，且此时 `ok` 必须是 `false`；④配齐但技能坏 →
   `ok:false`、`onboarding.complete:false`、`next` 指向 `broken` 的 `needs_user`；⑤全干净 →
   `next === '全部可用，可以开工。'`。
2. **`runtime_hint` 的 linux 文案是两行拼起来的**：第一行说「建议在专供演练的 Kali 虚拟机里运行」，
   第二行说「本机落私钥与马、流量从常用出口 IP 出去、演练完虚拟机可直接丢弃」。第二行被删掉时，
   第一轮 drill 是 **GREEN**（断言只钉了第一行），补 `演练完虚拟机可直接丢弃` 后才红 —— 这句才是
   「敢不敢在这台机器上落私钥」的依据，不能只留前半句。
3. **坏技能的 `fixes` 就是 `issues[].fix` 的数组**（`(s.issues || []).map(i => i && i.fix).filter(Boolean)`），
   文件不存在这条 issue 能给出修复步骤；`issues` 为空时 `fixes` 是 `[]` 而 `fix_note` 照常打印 ——
   所以「有没有 fixes」与「有没有 fix_note」是两件事，不能互相替代断言。
4. **`fromBundle` 翻假的两条路**：`skills.list` 给的条目缺 `content` → `every(...)` 为假 →
   逐条 `skills.get` 取正文；`skills.get` 抛错 → `def = undefined` → 按 summary 自带的 `path`/`content`
   继续体检，不整条报废。注意 `include` 必须点名要查的技能：不点名时 `summaries` 会并进随包的 23 个技能，
   `checked` 直接变 24，「有没有问 `skills.get` 要正文」这件事就被稀释掉了。
5. **占位符只算 issue，不算 broken**：正文里写着 `<你的VPS_IP>` 的技能 `status` 仍是 `available`，
   而返回体只有 `broken` 会带 `needs_user` / `problems` —— 于是「技能里还有占位符」在 preflight 输出里
   **看不见**。这是现状，用例 `assert.deepEqual(pf.needs_user_flat, [])` 把它钉住（见盲区 97）。
6. **`skills.get` 抛错时也得出一条结论**：`checked` 为 1、`available.length + broken.length` 为 1。
   注意 `all_checked` 只有 `registry_total` / `checked` / `broken` / `available` 四个键，**没有 `unknown`**，
   想按三类求和会得到 `NaN`。

RED 演练 `.tmp97-drill.mjs` **12 条突变 → 12/12 全红**（首轮 11 红 1 绿，绿的正是上面第 2 条的续行，
补断言后复跑转红）。`lib/redteam/tool-specs-recon.js` 行覆盖 532 → **551/585**，唯一剩下的 `171-204`
是「宿主没有 skills 服务且内置技能也为空」的早退支（`bundledSkillSummaries()` 恒非空 → 本仓库不可达）。

**2026-11-15 五十补**：`lib/web.js` 剩下三块（`spawnRestartHelper` 整段、`scheduleRestart`、`scheduleCleanupRestart`）此前一直挂着，理由写在 `scripts/test-host-restart.mjs` 的注释里 —— 直接调用会把跑测试的进程杀掉（`setTimeout(() => process.exit(0), 250)`）。这一批把它补上（`scripts/test-web-restart.mjs`，**13 条**），该文件行覆盖 **62/117 → 117/117 = 100%**、分支 26 → 34/35。做法是把四件事逐个拦下来，而不是绕开：

1. **拦 `spawn` 的难点不是 `spawn`，是具名导入。** `lib/web.js` 写的是 `import { spawn } from "node:child_process"`，改 `require("node:child_process").spawn` 对 ESM 侧**没有影响** —— 必须 `createRequire(import.meta.url)` 拿到 CJS 对象、赋新值、再 `syncBuiltinESMExports()`，ESM 绑定才会跟着变。还原时同样要再 sync 一次。
2. **`setTimeout` 只记不跑。** 假 `globalThis.setTimeout` 收下 `ms` 就返回 `{ unref() {} }`，绝不调回调 —— 回调里就是 `process.exit(0)`。于是断言能精确钉到「250ms」与「400ms」两个值，而不是「反正会退出」。
3. **四个 spawn 选项各管一件事，缺一个用户就中招。** `detached: true`（前台退出不带走子进程）/ `stdio: "ignore"`（子进程不占着父进程的管道，否则父进程退了终端还挂着）/ `windowsHide: true`（不弹黑框）/ `shell: false`（带空格的安装路径不会被拆开）。这四条各改一个，13 条测试全数变红。
4. **`openBrowser` 用的是 `??` 不是 `||`。** `options.openBrowser ?? (request != null)` —— 调用方显式传 `false` 时必须压过「有 request 就弹窗」的默认推断（settle / 自愈重启走 `request=null`，面板点重启才带 request）。改成 `||` 或把 `openBrowser !== false` 改成 `!== true`，都有用例接住。
5. **那句「关掉窗口不会停」只有一个作用：防止用户再开一个撞 EADDRINUSE。** 所以它必须打（三条正则钉原文），但它抛错（管道断了）时也不能把重启一起带崩 —— 有一条用例专门让 `console.log` 抛 `log boom`，断言 `spawn` 照样发生。
6. **清理重启的助手是「复制出来再跑」。** `uninstall-restart.js` 先 `fs.copyFileSync` 到 `<os.tmpdir()>/dsh-purge-uninst-<pid>.mjs` 再 spawn 那份副本 —— 因为原文件马上要跟着安装目录一起被删。用例按 `sha256` 逐字节比对副本，并断言 `payload.helper` 指向副本（不是仓库源码）。改成 `writeFileSync(dest, "")` 立即红。
7. **子进程 env 只带 `envForDetachedSpawn()` 加本次的 `DSH_PURGE_RESTART`。** 用例先把 `DSH_PERMISSION_MODE=danger-full-access` 塞进 `process.env`，断言它**没有**进子进程 —— 否则「这一轮用户点的 full-access」会被带进下一轮重启后的会话。

RED 演练 **17 条突变 → 17/17 全红**（`detached`/`stdio`/`windowsHide`/`shell` 逐个改、删 `unref()`、`exitAfter` 默认值 250→300、`??`→`||`、`!== false`→`!== true`、去掉 `console.log` 的 try/catch、`kind` 改成别的字符串、`argv` 不给 `restartArgv()`、清理重启丢掉 `helper`、丢掉 `cleanup`、`}, 400)`→`250`、`copyFileSync` 换成写空文件、`openBrowser` 恒 `true`、不认调用方给的 `argv`）。

**2026-11-15 五十一补**：盲区 74 的第 ① 项（「`findDshHome` 的桌面分支本机可以跑通，但结果依赖这台机器装了哪些桌面版本，写进用例就是在测环境」）在这批被推翻了 —— 只要把**桌面安装树造成一棵真的能过判据的假树**，那条分支完全可以在沙箱里跑：`scripts/test-dsh-home-desktop.mjs`，**15 条**，`lib/core.js` 行 4633 → 4671/5205（+38 行，正好是 `desktopHomeCandidates` 28 行与 `findDshHome` 桌面分支 10 行）。

关键是三个 fixture 事实：

1. **候选根必须像桌面安装**。`desktopHomeCandidates()` 里 `desktop.listDesktopInstallRoots()` 只收「看起来是桌面安装」的目录，而它的判据要求目录里真有 `DeepSeek Harness.exe`。只造一个空目录 + `.dsh` 子目录，`found` 会一直是空数组，然后一路掉到 `~/.dsh` —— 那看起来像「桌面分支没生效」，实际是 fixture 没造对（第一版五条用例全红在这个点上，报错信息里只有路径，没有一个字提 exe）。
2. **`put(dir, {})` 不会建目录**。我那个 `put` 辅助是把 mkdir 写在 `Object.entries(files)` 的循环体里的，空对象 ⇒ 循环体一次都不跑 ⇒ 目录根本没建出来 ⇒ `isDshHomeDir` 全 false。凡是「我造了一个空目录」的 fixture，必须显式 `mkdirSync`。
3. **`os.homedir()` 读的是 `USERPROFILE` / `HOME` 环境变量，不是 `options.env`**。桌面分支的兜底 `const unix = path.join(os.homedir(), ".dsh")` 因此必须靠改 `process.env` 才能沙箱化 —— 只把沙箱塞进 `findDshHome({ env })` 会让兜底返回真机的 `C:\Users\Administrator\.dsh`，这正是盲区 74 那句「写进用例就是在测环境」的真实原因（测的其实是 `USERPROFILE`）。

15 条用例把**回退阶梯**逐级钉住（这比「有数据就返回它」重要得多）：`DSH_HOME`（trim 后直接用，只有空白算没设）→ 桌面候选里**有 harness 数据**的那个（`prompt-inject.md` / `profiles` / `cordis.patch.yml` 任一）→ `~/.dsh` 有数据就用它 → 有候选但都没数据就回 `found[0]` → 什么都没有仍返回 `~/.dsh` 路径（**允许不存在**，但不许返回空）。另外 `~/.dsh` 存在却是空目录时，**必须让位给安装树旁的候选**（这条专治「用一个空目录冒充主目录」），三平台的 `desktopDshHomeGuesses`（darwin 的 Library 那条、win32 的 APPDATA+LOCALAPPDATA 两条且顺序固定、linux 恒空）也各有用例。

RED 演练 **20 条突变 → 20/20 全红**（`isDshHomeDir` 不判空 / 不认 `dsh-home`、三个 harness 标记各删一个、候选只推 `.dsh2` 或 `.dsh-home`、不推 exe 目录、darwin 分支关掉、win32 读错环境变量、两条猜测顺序颠倒、linux 也给一条、`DSH_HOME` 不 trim、桌面判据写反、候选不筛 `isDshHomeDir`、`~/.dsh` 有目录就认、不回退 `found[0]`、portable 不看命中、portable 结果不用）。

**仍然测不到的**：`findWslWindowsDshHome` 的命中分支（`/mnt/c/Users` 在 Windows 上不存在，只能在真 WSL 里跑）与 `desktopHomeCandidates` 里 `process.resourcesPath` 那一项（只有 Electron 进程里有值），见盲区 74。

### 五十二补：软链启动器自愈链（#157）

`apply` 早期版本会把 npm 全局的 `dsh` 软链启动器覆盖成一份 `bin.js` 拷贝 —— 那份拷贝
在别的目录下找不到 `@deepseek-ai/dsh-app-boot`，于是 `dsh` 一跑就报模块不存在。
`lib/core.js:4456-4539` 这八个函数就是收拾这件事的：认得出来、找得到官方入口、把拷贝
换回软链。它们原来一行都没测过，因为「写盘那一侧」看着像要真改用户启动器。

这一批 18 条只看这八个函数本身（写盘目标全落在 `mkdtemp` 里），下面七条是只能跑出来的：

1. **整条自愈链的触发前提是「非 win32 且文件名正好是 `dsh`」**。`resolveShimWriteTarget`
   第一段 `if (process.platform === "win32" || fname !== "dsh") return { writeFp: fp, … }`
   把两件事一起挡了，且挡在自愈之前。所以用例必须用 `asPlatform("linux", …)` 驱动，
   并且要专门钉住「win32 上即使内容像拷贝来的 bin.js 也一字节不动」和「名字是 `dsh-cli`
   的启动器不碰」—— 这两条判据各自能被单独删掉而不影响其余用例。
2. **官方入口必须放在「向上走查不到」的位置**。`officialBinJsNearLauncher` 的候选里有
   `<dir>/../lib/node_modules/…` 与 `<dir>/../node_modules/…`，而 `canResolveAppBoot(fp)`
   是从 `dirname(fp)` 逐级向上找 `node_modules/@deepseek-ai/dsh-app-boot`。把官方入口放在
   `root/node_modules` 时，`canResolveAppBoot` 已经为真，自愈分支（要求 `!canResolveAppBoot`）
   根本进不去 —— 这不是实现的问题，是用例造错了位置。写自愈用例一律放
   `<dir>/../lib/node_modules`。
3. `canResolveAppBoot` 最多向上 **8 层**，且 `dsh-app-boot` **空目录也算**（`isDir(hit)`
   那一半）。第九层才命中的 fixture 必须判 false，否则「层数上限」这条判据没有守卫。
4. `posixRelLink` 三条独立规矩：同一个文件回原路径；`..` 开头的**不补** `./`（补了就是
   `.//../x`，软链会指错）；`path.sep` 全转 `/`（Windows 上建软链要正斜杠才跨平台可用）。
5. `healCopiedLauncher` 的顺序是 **先 `unlinkSync` 再 `symlinkSync`**，`catch` 里回 `""`。
   反过来写在 Windows 上会留下半个文件；`catch` 改成回 `fp` 则调用方会拿一个「已经不存在
   的文件」去写。
6. `shimKindOf` 的兜底是 **`"sh"` 不是 `"unknown"`**；而且 `dsh.js` 这种名字在
   `resolveShimWriteTarget` 里根本进不到自愈链（`fname !== "dsh"` 早退）。要测「node 类型
   但解析不到 app-boot 就跳过」这一支，必须让文件叫 `dsh`、靠 shebang 判成 node。
7. **给 `lib/core.js` 加 `export` 会撞上注册表测试**：`scripts/test-patch-registry.mjs` 的
   `EXPORT_EXTRA` 名单是「只许放开、不许新增」的白名单，本轮加八个名字漏同步，单文件跑绿、
   全量跑红一条。加 `export` 之后先跑一遍 `npm run check` 再写文档。

### 五十三补：#42 的两步前置改写

`applyReplacementsToText` 里有一段只对 `patch.id === 42` 生效的前置改写：
先把重复的 `function legacyApplyPath(section, op) {` 折叠成一份，再把残留的
`=> legacyApplyPath(section, op)` 换成 `=> applyPathOp(section, op)`。
1.1.17 之前的 #42 会叠多份定义，settings 整文件语法错、提供商目录起不来。

这一段原来只跑到过「没有重复、也没有旧调用」那条路径：`legacyApplyPathStarts` 的 `count += 1`
一次都没执行、`collapseDuplicateLegacyApplyPath` 的折叠循环一次都没进、`rewriteStaleLegacyApplyCall`
的替换一次都没发生。这一批 25 条把它补满，六条只能跑出来的：

1. **`preChanged` 与 replacements 无关**。折叠或换调用任一发生，`changed` 就是 `true`，
   哪怕 `replacements` 是空数组。反之没有 #42 身份时，同一段重复定义一个字都不动、
   `changed` 为 `false`。两条要分开钉，否则「折叠了但没算改动」和「没折叠却算了改动」都测不出来。
2. 折叠的算法是「先找第一份的闭合位置，再逐份把中间的空隙拼上去」，末尾用 `\n{3,}` → `\n\n`
   收口，最后按原文行尾还原 CRLF。所以**三份折叠完留下的是第一份正文加一个空行**，不是零空行。
3. **第二份没闭合时，从它到文件末尾整段被删**（`endOfBalancedBlock` 找不到闭合就回 `text.length`）。
   现状锁定：那份本来就是语法错的产物，留着 dsh 更起不来；但如果遇到的是「文件被截断」，
   这一段会连带丢掉后面的内容。这条写进了盲区。
4. **没有 `legacyApplyPath` 的文件一个字节都不动**，连空行都不收口 —— 唯一防线就是
   `if (starts.length < 2) return text;`。要守住它，用例里得放一份「有花括号、有三连空行、
   但没有这个函数」的正文：删掉早退之后 `indexOf("{")` 会从任意花括号起算，把后面的内容切走。
5. `patchApplied` 对 #42 的两条额外判据排在 markers **之前**：定义叠了两份、或还留着旧调用，
   一律判「没打上」，哪怕 markers 全中。这正是 #42 静默失效的根因，顺序反了就永远报已完成。
6. 换旧调用用的是 `split().join()`（全量），不是 `replace()`（只换第一处）。第二处没换的后果
   同样是「文件里还留着一个调用已删除函数的地方」，所以用例要放两处旧调用。

### 五十四补：桌面面 shim 三件套的来源、链式补丁的漂移分类

`gatherState()` 报的 `shim_scope` / `shim_cmd` / `shim_ps1` / `shim_bin` 在桌面面有两个来源。
0.2.2-rc.1 起安装包不再下发 `resources/runtime/cli/bin`，桌面端以前因此把三个 shim 全报成
`missing` —— 那不是「文件不存在」，是「没去看」。这一批 21 条把两条来源、四种状态组合、
以及链式补丁的漂移分类补齐。七条只能跑出来的：

1. **第一个来源只看目录在不在，不看里面有没有启动器**。`findDesktopShimDir()` 里
   `if (cliBin && isDir(cliBin)) return path.normalize(cliBin);` —— 目录在就认，于是三件套
   状态全是 `missing` 而不是「换第二个来源」。要测到这一点，fixture 必须是「cli/bin 目录存在、
   但里面只有一个 readme」。改成要求 `dirHasDshLauncher` 会让这条用例红。
2. **第二个来源才有 `path` 标记**。桌面树完全没有（`DSH_DESKTOP_INSTALL` 不存在）时回落到
   PATH 上那套并写 `shim_scope = "path"`；两处都没有才是 `none`。web 面直接用第二个来源，
   不看桌面树。
3. **桌面官方 CLI 的补丁是入口回退块，不是 shim 注入**，所以状态要从 `original` 升级成
   `patched`，而且 `dsh`、`dsh.cmd`、`dsh.ps1` 三行各判一次（`dsh.ps1` 常常根本没有）。
   打完入口块之后读数是 `patched / missing / patched`，不是三个都 `patched`。
4. **`runtime_payload` 只在 desktop 面探**（`adapterFor(detectSurface()) === "desktop"`），
   web 面这一项是 `null` 而不是「空对象」—— 两者在界面上不一样（「这项不适用」vs「探测了但没内容」）。
5. **链式补丁的前驱没打上时记 `pending`，不是 `drifted`**（`#46←#45`、`#84/#92←#83`、
   `#88←#87`）。判据在 `filePatchOutcome` 里：自己的 pattern 一条都不中之后，先逐个问
   `after` 里的前驱有没有 settled，没 settled 就 `pending`。少了这一步，刚装上的干净宿主会满屏
   报漂移，用户以为版本不适配。
6. **`after` 是「软引用」，要先归一化再比对**：允许字符串 id（`["87"]` 必须归一成 `87` 才
   对得上 `ALL_PATCHES` 里的数字 id），非数字条目直接丢掉，写成单个数字或字符串（不是数组）
   就当没有前驱。这四种形态各有一条用例，因为归一化漏掉任何一步的结果都是「静默变成 drifted」。
7. **折叠块重排时段落之间的空行必须原样保留**。`yamlReindentBody` 对空行 `out.push("")`，
   改成 `out.push(pad)` 就把空行变成一串空格 —— YAML 折叠块里那等于把两段并成一段。

**盲区**：`gatherState()` 里 `runtime_payload` 那个 `catch`（`{ok:false, error, missing:[]}`）
需要 `lib/desktop.js` 的导出函数抛错才走得到，而 `core.js` 是 `import * as desktop`，命名空间
只读、无法 monkeypatch；磁盘状态也造不出来（探测的是纯读）。检测办法：
`grep -n 'runtime_payload = { ok: false, error' lib/core.js` 确认它还在，真机上把
`resources/runtime` 删掉后刷新状态页，看是不是 `ok:false` 而不是整页报错。

### 五十五补：宿主面判定（`lib/surface.js` 从 94% 到 100%）

`detectSurface()` 决定后面所有分派（`adapterFor`、`gatherState` 探不探桌面树、
`listLiangshenBootstrapFiles` 收哪一份）。判错的形态是「桌面端按 web 跑」，界面上少了一整块，
不报错。这一批 29 条把它从「碰巧对」变成「钉住」，六条只能跑出来的：

1. **光有 harness 名字不算桌面安装**。`pathLooksDesktop` 里 `harnessDir` 单独为真不行，还得配
   `/resources/`、`/contents/resources/`、`/resources` 结尾、或 `.exe`。源码仓库常叫
   `deepseek-harness`，不这么写就会把开发机判成桌面端。`/home/u/code/deepseek-harness` → false。
2. **`resourcesLookLikeDesktopInstall` 有三条真判据**：`app.asar` **必须是文件**、
   `app/dsh` 目录、`app.asar.unpacked/dsh` 目录。写成「`app.asar` 存在就算」会把空目录当安装产物
   （Electron 解包后常留一个空目录）；少一级（只看 `app/`、只看 `app.asar.unpacked/`）会在
   半截安装包里误判。四条用例各一条。
3. **`isCommunityElectronHost` 要求 `versions.electron` 为真才看 `resourcesPath`** ——
   宿主里 `process.versions.electron` 是 Electron 的版本号，普通 Node 下没有这个键。去掉这个守卫，
   任何在 `/xxx/resources` 下跑的 Node 进程都会被判成社区桌面壳。
4. **`detectSurface` 的优先级是「社区壳 > DSH_SURFACE > 面判据 > web」**。社区壳压得住
   `DSH_SURFACE=web`（DS Bot 的 profile 常被封成 web）；`DSH_SURFACE` 又压得住 exe 名字白名单
   （显式指定错了就该按指定跑）。两条都要用例，因为反过来写「看起来也对」。
5. **`DSH_SURFACE= gui / tui` 原样透出 `gui` / `tui`**，不会被 `detectSurface` 改写成 web；
   只有 `adapterFor` 才把两者折成 web（gui/tui 还没适配）。这是两件事，合并起来测会漏掉
   「`detectSurface` 把未知值也当合法值透出去」这种错。
6. **`parentPort` 与 `ELECTRON_RUN_AS_NODE` 那两条兜底永远为假**：走到第 116 / 118 行时，
   `pathLooksDesktop(execPath)` 与 `resourcesLookLikeDesktopInstall(resourcesPath)` 已经被
   第 107 / 110 行问过并返回了。留着是纵深防御（将来有人把上面那次早退挪走），按源码形状钉住
   顺序即可，不要为它们硬造 fixture。

**两处等价突变（记录在案，删掉不加用例）**：
- `if (!resourcesPath) return false;` 与下一句 `/resources` 结尾判定合起来等价 —— 空值经
  `slash()` 变空串，一样过不了。留着只是省一次字符串拼接。
- `p.endsWith("/ds-bot")` 永远走不到：能让它成立的路径末段就是 `ds-bot`，那时 basename 已被
  `/^ds[\s._-]*bot(\.exe)?$/` 认掉。两者都用源码形状断言钉住，防止有人当成可达分支去「修」。

### 五十六补：角色表上限与三条「读不出来就回空串」（`lib/redteam/role-section.js` 到 100%）

`roleBySession` 是模块级 `Map`，跨 install/dispose 都不清 —— 长开进程里 session id 会一直堆积。
第 400 条之后每来一条就淘汰最早的 100 条，这套逻辑一行没跑过时，坏了的表现是「进程越用越胖」
或者反过来「刚记的角色被无故清掉」。这一批 13 条把 21% 推到 100%，四件只能跑出来的事：

1. **淘汰发生在写入之前**，所以「补到第 400 条时最早那条还在，来第 401 条才掉」。
   把 `evictRoleBySessionIfOverflow()` 挪到 `set` 之后，边界就整体前移一位，
   表现是「刚记的第 400 条立刻把自己淘汰掉」。
2. **每次正好淘汰 100 条**（`ROLE_SESSION_EVICT`），且是按插入顺序（`Map` 的键序）。
   第二轮淘汰后仍然从「当前最老的 100 条」开始 —— 第二次之后最早存活的是第 200 条，
   不是第 101 条。断言写成 `EVICT + 100` 才是对的。
3. **`current` 里的 id 超过 200 字、或带 `..`/`/`/`\`/`\0` 时整条当「没有靶标」**。
   这条闸门的可测性受 Windows `MAX_PATH` 限制：`engagements/<201 字 id>/agents` 这个目录
   本身建不出来（`mkdir` 直接 `ENOENT`），所以长度闸只能用源码形状断言钉，
   穿越闸可以用 `eng-..-x` 这种短 id 真跑（目录建得出来、判定回空串）。
4. **`agents/` 目录存在性检查是冗余守卫**：`readRoleFile` 拼的是
   `<engagements>/<id>/agents/<role>.md`，目录不存在时那个文件必然也不存在，
   `existsSync` 一样回空串 —— 公开 API 上造不出「目录不存在但文件存在」的输入。
   RED 演练里它是 GREEN，删掉改成源码形状断言，并在注释里写明原因，免得后人当 bug 去修。

**顺带钉住的两处**：`readRoleFile` 的 `catch` 用「把角色稿路径做成目录」造（`existsSync` 为真、
`readFileSync` 抛 `EISDIR`/`EPERM`）；外层的 `catch` 用「`context.agent` 装一个抛错的 getter」造
（`resolveSubagentRoleText` 第一句就是读 `context?.agent`）。

### 五十七补：三列老字段一次全删，以及「读不到表结构」该回哪个值

`migrate()` 尾部有一段「把 1.1.94 之前留下的三列老字段删掉」：`stage.attck`、`stage.blue_team`、
`score_point.stage_code`。这三列留着不会立刻坏事，但会让 `SELECT *` 的列数对不上、让
「按列位置读行」的老代码读到隔壁字段。删列本身只在启动时跑一次，一行没跑过的风险是
「老库升上来之后一直带着三列」，用户看到的是导出报告里多出两列空值。

这一批 9 条（`scripts/test-schema-legacy-drops.mjs`）把 `lib/redteam/schema.js` 推到 **632/634**，
四件只能跑出来的事：

1. **三列是一次性全删，不是「删到某一列为止」**。只带一列的老库也要把那一列删掉，三列齐全的
   老库要三列都不在。断言按 `PRAGMA table_info` 逐列查，不能只看「跑完不抛」。
2. **删列失败必须保留且不抛**。`ALTER TABLE ... DROP COLUMN` 在 SQLite 上会失败（列被视图或
   索引引用），失败时保留老列是正确取舍：启动不能被一列拦住。把 `catch` 去掉，一条老库直接
   起不来。
3. **`has(table, column)` 读不到表结构时必须回 `false`。** 这个方向不是「保守不保守」的问题，
   而是故障点会漂到哪里：回 `false` 的后果是「多跑一次 `ALTER TABLE ADD COLUMN`」，SQLite 报
   `duplicate column name` 并被外层吞掉，功能照常；回 `true` 的后果是「迁移静默跳过」，之后
   每一次读都会在「列不存在」上炸，而且炸在业务路径里、离根因很远。用例用「只对
   `table_info(asset)` 抛、其余表正常」造缺口：正确实现会把 `asset.test_notes` 补回来，把
   `return false` 改成 `return true` 就补不回来。
4. **表不存在也不抛、跑两遍结果全等**。空库（还没建表）与重复执行都要能过，否则「第一次装」
   与「升级」两条路只有一条能走通。

顺带补掉一处覆盖率回落：`ensureAllProfileBodyInserts` 的「单条 profile 写失败只记一笔」出口
（`lib/profile-insert.js:403-409`）。它的存在意义是「一个 profile 的
`cordis.patch.yml` 被占着，不能连带其它 profile 都不打补丁」。用例造两个 profile，其中一个把
`cordis.patch.yml` 做成目录 → 写回时 `rename` 失败 → 返回 `{dir, ok:false, error}`，另一个照常
写出 `- id: dsh-purge`；三条突变（整段抛出 / 丢掉 `dir` / 丢掉 `error`）都红。

### 五十八补：`configValue` / `configSet` 的四个 catch，与「再排一次就先撤上一份」

停用插件时要把宿主的 `selectedDefault` 从 `redteam` 改回 `standard`。这个值在宿主里可能是
裸字符串、`{value}` 包装、带 `set()` 的节点、带 `get()` 的节点 —— 四种写法都得改得动，而且
**任何一种写法抛错都不能把整条停用流程带走**（宿主 resolve() 对未知预设是硬抛，见 #108；
停用「成功」返回而值没改，下次启动就起不来，控制台里没有任何一行提到本插件）。

这一批 8 条（`scripts/test-preset-default-edges.mjs`）把 `lib/preset-default.js` 推到
**行 205/205（100%）**，三件只能跑出来的事：

1. **`get()` 抛错之后还要看 `value`。** 两层兜底是有顺序的：先 `node.get()`（可调用），再
   `node.value`（可读属性）。只保留第一层时，`{ get(){throw}, value:"redteam" }` 这种节点会
   被判成「没有值」而整条跳过 —— 宿主里正好有这种 getter 抛错的配置代理。用例断言节点真的
   被改成了 `standard`，不是只看 `report.live`。
2. **`value` 抛错的节点必须当「没有值」，而不是把异常漏出循环。** `clearLiveSelectedDefault`
   会依次试多个「袋子」（`agentPresets.config` 与 `settings` 里那行的 `config`），前一家是
   毒药不能连累后一家。用例造两家袋子：第一家 `value` getter 抛错、第二家能改 —— 漏出异常时
   第二家改不到，`live` 会是 `false`。这是唯一能区分「catch 住了」和「反正外层还有一层 catch」
   的输入（外层 catch 会把 `live` 记成 `false`，恰好和「跳过」同形）。
3. **`set()` 抛错之后要退回属性赋值；属性也写不进去才回 `false`。** 三种节点的处置各一条：
   `set()` 成功就不再碰属性（免得两种写法互相打架）、`set()` 抛错但属性可写算成功、两边都不行
   记 `live:false`（此时文件那一半照修，所以 `live` 必须是单独可观测的一个字段）。

另外两条与定时器/目录有关：

- `scheduleClearOwnedSelectedDefault` 连排两次时，**前一份必须被 `clearTimeout` 撤掉**。热重载
  的形态是「dispose 排队写盘 → 立刻 apply 再排一次」，不撤上一份就会在 apply 之后 800ms 把
  用户的红队默认冲掉。用例造两棵不同的 home，只断言第二棵被动过、第一棵逐字节没动。
- `removeStaleAgentPresetDir` 在目录存在但删不掉时回 `false` **而不是抛**（`catch { return false }`）。
  造法是把 `node:fs` 的 `rmSync` 换掉：`createRequire` 拿 CJS 对象 → 赋值 → `syncBuiltinESMExports()`，
  这样 `lib/preset-default.js` 的 `import fs from "node:fs"` 才看得到替换；`finally` 里还原再 sync。

### 五十九补：`continue-retry` 的三条静默出口（读事件 / 注册钩子 / 发不出去）

自动续跑与自动重试整块只有 364 行，但三条出口都是「宁可什么都不做，也不把异常漏给宿主」：
读会话事件、挂 `ctx.on`、还有把续跑那句真的塞进队列。这三条平时不响，响了就是「一次网络抖动
把任务停在那里」或者「用户还在打字，插件先替他发了一条」。

这一批 5 条（追加进 `scripts/test-continue-retry.mjs`，44 → **49 条**）把
`lib/continue-retry.js` 推到 **行 364/364（100%）**，四件只能跑出来的事：

1. **读事件有两条路，两条都炸时给空数组。** `session.snapshotEvents()` 抛错会退到
   `session.events`；`events` 这个属性本身用 getter 抛错时，再往里退都没有了 —— 只能返回
   `[]`。少了这个出口，一个坏 session 就让整条 `agent/status` 钩子抛出去，宿主那边的 idle
   处理跟着断。原用例只覆盖了第一层。
2. **`ctx.on` 有三参 / 两参两种签名。** 三参不被认时退回两参注册（此时**不再传 `global`**，
   所以子会话看不到续跑 —— 这是可观测的差别，不是「顺手容错」）；两参也不认就一个钩子都不
   挂，而不是让 `apply` 失败。注册尝试次数恰好是 4（两个事件 × 两种签名），这条数字本身就是
   契约。
3. **续跑那句发不出去要退还名额，并且留且只留一行 warn。** `followup` 抛错时
   `sendContinue` 返回 `{ok:false, error}`，`maybeAutoContinue` 必须 `refundContinue` 再
   `console.warn`（带 session 与 seq）。不退款 —— 下一个失败点就干看着；不退且不 warn ——
   用户永远不会知道插件替他试过一次。
4. **退款之后同一个失败点不会再试第二次。** `refundContinue` 故意**不清 `lastContinueSeq`**
   （源码注释写着「同一 seq 的失败不再重复消耗 continue 预算」），所以第二轮必须换一个新的
   `turn/end` seq 才能看到「名额回来了」。写这条用例时第一版用了同一个 seq，断言「名额回来」
   是红的 —— 那不是 bug，是契约；两条用例合起来才把「退款」和「不重复」分得开。

两条纪律（写进 `MAINTENANCE.md`）：

- `refundContinue` 的语义是「名额回来 + 这个点别再试」，两件事必须各有一条用例；
- 造「发不出去」不要 mock `sendContinue`，直接让 `agent.followup` 抛错 —— 真实调用链是
  `followup → makeContinueMessage → source.kind: "dsh-purge"`，mock 掉就漏了「续跑消息本身
  必须带 `dsh-purge` 标记」这件事（`hasFreshHumanTurn` 靠它不把插件的消息当真人说话）。

### 六十补：`inject-write` 到 100% —— 三条只在非常态下才会执行的出路

`lib/inject-write.js` 是「注入到底有没有生效」的最后一段执行路径，363 行里剩下的 12 行全是
**平时不响、响了就说明环境已经不对** 的那种代码：

1. **mnemon 剥离层挂不上时的 1500ms 重试与 effect 回收**（`lib/inject-write.js:64-74`）。
   `late()` 在 `ctx.on` 抛错的宿主机上第一次必然失败 → `queueMicrotask` 再试 → 还失败就
   `setTimeout(late, 1500)`。这段的回收器要做两件事：清掉那个定时器、把已经挂上的 disposer
   摘掉。两条各一条用例：一条让 `ctx.on` 一直抛，回收之后**再等 1600ms 断言调用次数不再涨**
   （不清定时器就会多试一次）；另一条让 `ctx.on` 成功、断言回收之后**disposer 恰好被调用一次**
   （不摘就会在热重载时叠层，中间插件返回的 `decision` 每轮被过滤 N 次）。
2. **提示词正文读不出来时退到用户勾选的本地 cwd 规则**（`:111-113`）。`readInjectFallback`
   正常永远非空（内置正文在密封槽里），只有「安装被搬动/解包后加密槽坏了」才会给空串；
   这时 `rules.readSelectedCwdInject(dshHome, cwd)` 是用户唯一还剩的一层身份信息。造法：
   `createRequire` 拿 CJS 的 `node:crypto` → 让 `createDecipheriv` 抛错 → `syncBuiltinESMExports()`，
   先断言 `core.defaultOverrideText() === ""`（前提），再让 `rewriteLiveAssembly` 跑一次，
   断言产物里出现 `AGENTS.md` 的正文。
   **两个前置条件**：`useHome()` 换一个新的 `DSH_HOME`（否则 `hungCache` 命中上一个用例的正文），
   并且 `core.hangOperatorPrompt("")` + `core.rememberCommittedOverride(home, "")` 先把
   「钉子正文 / 已提交正文」清掉 —— 不清的话 `refreshHungOperator` 直接返回缓存，`full` 不为空，
   这条兜底根本走不到（第一版就是这么红的）。
3. **气闸里 `rewriteLiveAssembly` 抛错时退回上游装配**（`:267-271`）。造法不是 mock：把
   `installIdentityOverride` 的 `config` 换成一个 `get enabled() { throw }` 的对象——
   `rewriteLiveAssembly` 第一行就读 `config.enabled`。断言三件事：返回值**是上游那个对象本身**
   （不是 `undefined`，否则宿主拿到空装配）、`console.warn` 恰好一行、`assemble.rewriteFail`
   那条日志还在。

另有三条 `ctx.on` 回调（`session/created` / `agent-preset/selected` / `agent/pre-step`）原来只
测了「注册了」，本批改成**真的调用一次**：换掉 `ctx.systemPrompt` 之后调回调，断言新代理被
`installAssembleGuard` 补包（`assemble._dshPurgeWrapped === true`）。这是这三条回调存在的
唯一理由 —— 宿主换掉 assemble 之后如果不补包，第二轮注入就走原生路径被 token 预算裁掉。

`lib/inject-write.js` 行 **351 → 363/363（100%）**，分支 79.75%。RED 演练 3 条突变全红
（回收不摘 disposer / 回收不清定时器 / cwd 兜底闸门恒假）。

### 六十一补：环境适配层的四条「读不到就看下一条」

`lib/redteam/platform-config.js` 这个文件的性质是「猜本机有什么工具」——每条判据都有两层：
先看能不能读，读不到就退一步。退的那一步平时一次都不走，而且退错的表现全都不是报错：

| 出口 | 退错的后果 |
| --- | --- |
| `looksLikePythonCli` 的 catch（`:178-180`） | 读不动就当成工具 → `rejectPython` 白设，把 python 脚本指给用户当 `httpx` |
| `adaptInDir` 的 `catch { continue }`（`:226`） | 一个条目 stat 失败就整层放弃 → 明明有可用的分发名也报「没找到」 |
| `scanFolderForTools` 的 stat 失败（`:413-415`） | 回「文件夹不存在」，用户照着删了又建还是不行 |
| `detectKali` 的 `readFileSync` catch（`:376`） | 有 Kali 但没读成 os-release 时直接判否 → 让用户手填 15 个工具路径 |

本批 18 条把它们各钉一条，外加「条目没有 `isDirectory` 时退回 `statSync` 判类型」
（`:439-442`，TypeScript/自定义 dirent 形态）。**一条不够**：子目录要另起一条 —— 只写
「顶层有个文件」时把 `isDir = s.isDirectory()` 改成 `isDir = false` 仍然绿（文件本来就按
file 处理），必须是「顶层有个子目录、工具在子目录里」才分得出来。

Kali 三条必须 `asPlatform("linux")` 才走得到（`detectKali` 第一行就是
`osPlatform() !== 'linux'` 直接返回「非 Linux 宿主」）。反过来，「非 Linux 宿主」那条在伪
linux 复跑时又会走错分支 —— 所以它自己要把平台钉回 `win32`：**两条相反的平台判据放在同一个
文件里时，各自都要显式钉平台，不能靠运行环境的默认值。**

`lib/redteam/platform-config.js` 行 **612/612（100%）**，分支 253/287。
RED 演练 11 条突变全红（11/11）。

**六十二补**：`lib/redteam/score-report.js` 的**完整性判据失效** —— 两条「这条成果说不清怎么做到的」提示，从 v0.11.1 起一次都没出过。

判据写的是旧得分点 code：`['web-account-user','web-account-admin','db-access']`（账号类要挂凭据）、
`['boundary','internal-pivot']`（突破类要挂隧道）。而 v0.11.1 把得分项重构成《突破入侵类得分规则
（合并版）》25 项之后，这些 code 全部作废 —— `score_point` 表里已经没有它们。后果不是报错，是
`hit.code` 永远不等于这些值 → 两条 gap 永不 push → `complete` 恒为 `true`：**报告自称复现完整，
而实际上既没有账号凭据也没有通道记录**。这正是「一个函数认的值比表约束多一个，那个值就从来没成功过」
的第二种形态 —— 这次是"判据认的值比表里少一批"。

修法：把两组值提成导出常量（`GAP_CREDENTIAL_POINT_CODES = ['web-app','db-credential']`、
`GAP_TUNNEL_POINT_PREFIXES = ['boundary-']`），突破类改按前缀认（`boundary-logical` /
`boundary-supply` / `boundary-strong` / `boundary-physical` 四条都算）。**不改文案、不改返回结构**，
只让判据重新对得上真表。

本批 9 条（`scripts/test-report-fidelity.mjs`）三件事各钉一遍：

1. **业务面**：`db-credential` / `web-app` 没挂凭据要报缺口、挂了凭据缺口消失；`boundary-*` 没登记
   隧道要报缺口、登记后消失；`terminal-access`（既不是账号类也不是突破类）两条都不许出现 —— 最后这条
   防的是"把它们写成恒真"。
2. **结构面**：拿 `store.listScorePoints()` 的**真表**对拍那两组常量（每个 code 必须在表里、
   每个前缀至少命中一条真实 code）。以后规则表再改名，这里先红，而不是再静默失效一次。
3. **回归面**：`score-report.js` 里不许再出现 `'web-account-user'` / `'web-account-admin'` /
   `'db-access'` / `'internal-pivot'` 字面量，也不许再拿阶段名 `'boundary'` 当得分点 code 比
   （`includes(['boundary'])` —— 阶段 code 里确实有 `boundary`，混用最难发现）。

顺带补了报告正文里「WebShell / 凭据 / 通道」三行（`:1200-1206`）—— 之前只测到小节标题存在，
没测条目下那三行，等于"小节能出来、明细不一定"。现在断言到 `` `http://10.0.0.5/s.jsp` behinder · 密钥 `k1` ``
这一级。

**一处已有用例跟着改**：`test-score-report.mjs` 的「没有任何步骤与资产时报两条缺口」改成三条 ——
`web-app` 现在会额外报一条账号缺口。**这个改动是修复的目的本身**，不是测试迁就实现：报告少报一条
就是在骗人。RED 演练 **10 条突变 → 10/10 全红**（两组常量各砍一项 / 前缀丢弃连字符 / 突破类改回精确相等 /
凭据判据方向写反 / 隧道判据恒假 / 两条文案改掉 / WebShell 行不写密钥 / WebShell 行整段不写）。

**六十三补**：`lib/redteam/score-report.js` 的**最后 7 行** —— 复现命令的「真实 curl」分支（`:445-448`）与「同阶段同时间」的稳定排序（`:697-700`、`:708`）。补完这个文件 **1523/1523 行（100%）**。

两处都属于「判错了不报错，只是报告开始误导人」：

1. **复现命令挑错**。报告里的 `replay_cmd` 有四个来源，先后顺序是硬编码的：
   ① 有真实抓获报文 → 合成等价 curl；①′ 本条**显式关联**的攻击步骤里记过命令 → 原样给出；
   ② 只有推断出来的步骤里是 curl → 原样给出；③ 得分点自带的动作模板 → 填值。
   ②这一支过去没人测，意味着「步骤是推断来的」这条路上的命令可能被换成 ③ 的通用模板
   （模板长这样：`id; whoami; hostname`），读者照着跑什么也复现不出来 —— 报告里最误导的一处。
   本批两条用例分别钉「推断步骤里的 curl 原样给出、标 `real`」与「同一资产多条步骤时取第一条**带 tool 的**，
   不是第一条」（后者靠 `test-report-chain-order.mjs` 里那条只有标题没命令的前置步骤区分）。

2. **并列时的顺序**。`ordered` 的排序键是「阶段顺序 → `order_at`/`recorded_at` → 最小步骤 seq」。
   `stepSeqOf` 的兜底是 `Number.MAX_SAFE_INTEGER`：没有步骤的条目**永远排在有步骤的后面**，
   哪怕它记得更早。这个兜底原来是 0 就会反过来（"没证据的先讲"），而两种都不报错。
   三条用例：一条有步骤 / 一条没有、两条都有步骤比最小 seq、两条都没有则保持查询顺序。

**现状锁定（写进用例文档串）**：返回的 `items` **数组顺序保持查询顺序**（`recorded_at, id`），
链路位置只写在 `chain_no` 上。所以想"按链路顺序读 items"的人必须自己按 `chain_no` 排 ——
报告正文用的是 `chain_no`，两者不会互相矛盾，但这件事必须写下来，否则下一个人会以为数组是排好的。
本批的排序断言因此一律写成 `noOf(hitId)`，不去断言数组下标。

**造并列现场的手法**：`recorded_at` 是 `addScoreHit` 里 `new Date().toISOString()` 生成的，
同一毫秒内两条才可能并列 —— 靠"连调两次"碰运气不行。用 `UPDATE score_hit SET recorded_at = ?`
把两条钉到同一字符串，再给其中一条挂攻击步骤（`addChainStep`，`asset_id` + `point_id` 都要给，
否则 `hitTrace` 的 `attack_step WHERE asset_id = ? AND point_id = ?` 查不到）。

**另一个坑**：同资产同得分点的第二条命中会被「服务已拿满」判成重复而**排除出报告**
（`summary.serviceCappedExcluded`）。第一版用例两条都用 `10.0.0.5`，报告里只剩一条，
排序断言自然对不上。要两条都留在报告里，必须**换资产**（同一得分点、不同 IP）。

RED 演练 **7 条突变 → 7/7 全红**：②分支不返回命令 / 改标 `template` / 闸门恒假 /
不跳过没记命令的步骤（`trace.steps[0]`）/ `seqs` 恒空 / 兜底改成 0 / 并列时不再比 seq。

**六十四补**：`lib/redteam/store-core.js` 的**最后 27 行** —— 配置落盘的分发口（`:672-675`）、截图计数的两级回填（`:1605-1610`）、`shotBrief` 的六个兜底（`:1612-1616`）、目标分组里的 `assetIpOf` 回查（`:3341-3344`、`:3352-3355`）、以及「复现请求」段落（`:3369-3375`）。补完这个文件 **3822/3822 行（100%）**。

五处都属于「算错了不报错，只是界面/报告少一点东西」：

1. **`platformConfigSave` 少落一次盘** → 返回的还是内存里那份摘要，面板看着"保存成功"，下次打开却是旧平台。用例不能只断言返回值的 `ok`，必须**写完再读一次**（`platformConfigGet`）才算钉住落盘。顺带钉住它的返回是 `platformSummary` **平铺对象**（`runtime` / `config` / `tools.items` 都在顶层），不是 `{ platform: … }`。
2. **截图计数分两级回填**：点级 `it.shot_total` 按 `point_id` 求和，命中级 `h.shot_count` 只数挂在它自己身上的那张。少一级的表现是"代表图有了，但命中行上不显示张数"。两个 `|| 0` 缺一不可 —— 去掉之后无截图的得分点 `shot_total` 变 `undefined`，界面会渲染出 `NaN`。
3. **`shotBrief` 的六个兜底**（`kind` → `screenshot`、`mime` → `image/png`、`label`/`note`/`target`/`source_ref` → `''`）。**正常写入的行这几列一定有值**，所以只靠 `addShot()` 造的数据永远测不到兜底 —— 必须 `UPDATE shot SET … = NULL` 把可空列置空，那才是老库里真实存在的行。这也是本批唯一一条"要先想清楚这行代码为谁存在"的用例。
4. **`assetIpOf(undefined)` 必须早退**：凭据/权限/清单三条线都用 `assetIpOf(asset_id) || slugTarget(host)` 求分组键。`assetId === null || undefined` 不早退的话 `getAsset(id, null)` 会把整份报告炸掉；早退之后键回落成 `slugTarget(host)`（`http://loose.example:8080/x` → `loose.example`），不会多出一个没有名字的分组。
5. **「复现请求」段**是报告里唯一"能直接粘进 Burp / Yakit"的东西。三条细节：`request` 与 `response` 都要去掉 CR（留着粘进 Burp 会多出空行）、`response` 截到 2000 字（否则报告能有几十兆）、`label` 缺省时用 `method + ' ' + url`。截断那条断言要落在 **x 的个数 = 2000 − 状态行长度**（`HTTP/1.1 200 OK\n\n` 去掉 CR 后是 17 字符 → 1983），写 `2000` 会红。

**造现场的两个前提**（踩过才知道）：`addScoreHit` 必须有 `evidence`（否则 `score hit evidence required`）；`addVuln` 要 `status: 'confirmed'` 且 `severity` 中危以上才会进 `reportTargets` 的收录口径（默认 `open` 会整条被过滤掉，报告里什么都看不到，容易误判成"这段代码没跑"）。

RED 演练 **13 条突变 → 13/13 全红**：配置不落盘 / 只回 `ok` 不回摘要 / 点级计数恒 0 / 点级计数去掉兜底 / 命中级计数恒 0 / `label`、`kind`、`mime` 三个兜底各去掉一个 / `assetId` 不设防 / 凭据分组不回落 `host` / 不写复现请求标题 / `label` 不回落 `method+url` / 响应不截断。

**六十五补**：`dshTarget` 从 `0.2.2-rc.2` 推到 **`0.2.2-rc.3`**（2026-11-15）。这次只动「声明」，不动任何补丁：

1. `package.json` 的 `dshTarget` 改 rc.3，`dshTargets` 首位插 rc.3 —— **历史四条（rc.2 / rc.1 / 0.2.1-rc.5 / 0.2.1-rc.2）一条不删**。删了会让「用户降级回旧版」变成状态页报未适配。
2. `scripts/test-package-integrity.mjs` 的三处跟着改：用例名（rc.3）、`assert.equal(manifest.dshTarget, '0.2.2-rc.3')`、「老版本仍列着」的清单补上 rc.2。这条用例的价值不在于钉版本号，而在于**它同时钉住「首项 = dshTarget」**（`check-lib.mjs` 的硬约束），所以推版本时它会红一次，提醒你两处一起改。
3. `README.md` 两处字面量、`MAINTENANCE.md` 的 `host:preview` 示例、`scripts/host-preview.mjs` 的默认版本与注释 —— 都是「读的人会照着做」的地方，跟着改。

**升级前的判据（按顺序，不要跳）**：

```bash
npm run host:preview -- --version 0.2.2-rc.3
```

实测（2026-11-15）：`目标 0.2.2-rc.3 实际装到 0.2.2-rc.3（预发布）`、`补丁 86 条：可打 71 / 升级打断 0 / 本来就坏 0 / 不适用 15`、`结论 compatible`。
**这一版不需要追加任何 replacement** —— 与 rc.1→rc.2 那次（13/18/35/56/62/77 六条要追加）不同，rc.3 没有改动任何补丁锚点所在的代码形态。

**注意「当前记录」与「目标」是两个东西**：`host:preview` 的输出里 `当前记录 0.2.2-rc.1` 来自 `docs/host-baseline.json`（那是**本机桌面实际装着的宿主**里逐条打补丁的实测记录），它不会因为 `dshTarget` 变了而自动更新。要让「当前记录」变成 rc.3，得先在桌面装 rc.3、再跑 `npm run host:capture`（会逐条打补丁并写回 79 settled / 7 no-file 的实测表）——**那是另一件事，别和改声明混在一起做**。

**回归**：`test-package-integrity` / `test-host-target-decl` / `test-host-preview` 三个文件 45 条全绿；`npm run check` 六道闸全绿（`[syntax] 272` / `patches=86 tests=131` / `[eol] 343` / `[client]` / `[gates] 58 gated` / `3794 tests 3792 过`）。

**六十四补**：小文件的「最后一层」—— 七个文件补到 100%，顺带挖出一条真缺陷与两条假绿用例

这一批挑的是 `docs/test-baseline.json` 里未覆盖行最少的几个文件（每个只差 1~7 行）。它们的共同点是
**差的那几行不是边角，而是某条出路一次都没走过** —— 平时不报错，改坏了也不报错。

| 文件 | 补前未覆盖 | 本批新守卫 | 结果 |
| --- | --- | --- | --- |
| `lib/redteam/report-replay.js` | 2 行（`:54-55`） | `test-report-replay.mjs`（7 条） | 行 **100%**，分支 74.26% |
| `lib/redteam/engagement-meta.js` | 1 行（`:141`） | `test-engagement-meta.mjs`（5 条） | 行 **100%**，分支 100% |
| `lib/redteam/validate.js` | 1 行（`:28`） | `test-redteam-validate.mjs`（4 条） | 行 **100%**，分支 95.45% |
| `lib/redteam/score-rules.js` | 7 行（`:521-525` `:531-532`） | `test-score-rules.mjs`（4 条） | 行 **100%**，分支 86.94% |
| `lib/redteam/skill-fixes.js` | 6 行（`:424-428` `:451`） | `test-skill-fixes.mjs`（5 条） | 行 **100%**，分支 83.87% |
| `lib/drill-grant.js` | 5 行（`:24-25` `:38-40`） | `test-drill-grant.mjs`（7 条） | 行 **100%**，分支 100%→上涨 |
| `lib/redteam/tools.js` | 1 行（`:131`） | `test-define-tool-resolve.mjs`（4 条） | 行 99.80%（`:131` 见下） |

**真缺陷（合成请求从来没带过 Host 头）**：`report-replay.js` 的 `buildHttpRequest` 里明明算了
`const lines = [\`${method} ${path} HTTP/1.1\`, 'Host: ' + hostHeader]`，`:113-118` 还专门处理了
IPv6 的方括号，但 `return` 只拼了 `lines[0]` —— 生成的报文永远缺 `Host:`，那段 hostHeader 计算是
**整段死代码**。红队报告里「复现这条成果」的 HTTP 报文因此不完整，粘贴到 Burp 里打不出原请求。
修法只改拼接：`return [lines[0], lines[1], ...headers, '', body].join('\r\n')`。用例按三层钉：
普通域名、带端口、`[::1]` 形式的 IPv6 —— 只有 IPv6 那条才分得出「有没有拼 lines[1]」和「方括号在不在」。

**两条假绿用例（override 打在工厂之后，什么都没改）**：`test-host-clean-floor.mjs` 里原有用例写的是
`const d = deps(); d.atomicWriteSync = () => { throw ... }`。而 `createHostCleanFloor(deps)` 在**创建时**
就把 `deps` 解构走了，事后改 `d` 上的属性与它内部闭包无关 —— 这两条「写盘抛错也不冒泡」的用例一直是绿的，
但抛错压根没造出来。改成 `deps({ atomicWriteSync: () => { throw ... } })`（`deps()` 内部 `Object.assign`
之后才创建工厂）才真的走到 catch。新增一条：**写盘失败时不许补 `DSH_DESKTOP_INSTALL`** —— 半套状态比
没记录更危险（下次重启会拿一个不存在的目录去换包）。

**共用 fixture**：`scripts/zip-fixture-lib.mjs` 导出 `doc(name, description, extra)` 与 `buildZip(entries)`
（手拼本地头 + 中央目录 + EOCD，method 0/8，`zlib.deflateRawSync` + `zlib.crc32`）。之前技能包导入、
zip 解析各抄一份打包器，改一处漏一处；现在 `test-http-routes.mjs` 的「面板拖入技能包」那条也走它。

**一处签名踩坑记下来**：`handleSkillsOp(op, body, queryId)` **没有 deps 形参**（`handleRulesOp` 才有）。
按 `handleRulesOp` 的形状去调，第三个参数会被当成 queryId，import 静默落回默认 home。

> **踩坑（2026-11-15，CI 红过一次）**：`test-redteam-validate.mjs` 最初把 `Z:\\no-such-drive\\sub` 当成
> 「盘符不存在」的固定输入，POSIX 分支断言 `doesNotThrow`。但 POSIX 上它只是相对路径，按 cwd 解析后落在
> `/tmp` 之外，`assertPathWithin` 照样拒绝 —— Linux CI 当场红。**教训**：凡是拿盘符/反斜杠当道路径的用例，
> 两种平台都要断言「真实判决」，不能用「我们这边跑得通」当跨平台契约；允许根之内但整条路径不存在的用例，
> 用 `path.join(root, ...)` 造，别用字面量。

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
| 旧得分项清理（先存档到 `<靶标>/runs/legacy-score-*.json` 再删、存档失败一条不删、用户自建点不动）、多值 `test_status` 筛选、步骤连带记分 | `test-store-evidence-rules.mjs`（21 条：多值 6 / 清理 8 / 连带记分 7） | `lib/redteam/store-core.js` 行 3687 → **3740/3831** |
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
| FTS5 缺席时的降级：两张虚拟表不建但普通表一张不少、资产六种检索面与 POC 三种检索面都还能命中 | `test-fts-fallback.mjs` | `lib/redteam/schema.js` 行 632/634 / `store-core.js` 76% |
| 降级与原生两种模式的差异边界：中间子串 LIKE 能搜到而 FTS 前缀匹配搜不到（现状锁定），其余检索面对齐 | `test-fts-fallback.mjs` | 同上 |
| 64 个 `redteam_*` 工具的参数面：宿主能编译成 JSON Schema、缺必填/类型错/枚举外被拒、数组与对象按元素判 | `test-redteam-tools.mjs` | `lib/redteam/tools.js` 79% |
| 靶标绑定解析：单靶标自动绑定、显式优先、多靶标未绑定报错、全局当前靶标被别的会话占用时挡住 | `test-redteam-tools.mjs` | 同上 |
| 并发闸门：上限读设置、占满拒绝、release 按最早一条释放、无会话上下文时如实说明 | `test-redteam-tools.mjs` | 同上 |
| 工具错误结构化：`ctx.redteam` 缺失回「资产库不可用」、桩库缺方法原文照抄、参数类错误归 `bad_input` | `test-redteam-tools.mjs` | 同上 |
| 红队子会话的角色稿：只认五个角色码且必须行首、多条消息以最后一条为准、`content` 优先于 `text`、非 text 块占空位 | `test-role-section.mjs` | `lib/redteam/role-section.js` 行 100% |
| 角色稿的落地路径：`current` 里的 id 必须无穿越且 `agents/` 存在、稿件 `trim`、只有红队预设不算子会话 | `test-role-section.mjs` | 同上 |
| 角色捕获钩子：`agent/inbox/claimed` 带 `global`+`prepend`、cordis 环境包在 `effect` 里以便解绑、重复调用只挂一次、坏 payload 不打断领消息 | `test-role-section.mjs` | 同上 |
| 角色表的成长与淘汰：`roleBySession` 400 条上限、每次淘汰最早 100 条、淘汰发生在写入之前（399 条不淘汰、400 条仍不淘汰、第 401 条才掉 100 条、第二轮后最早存活的是第 200 条）、`current` 的 id 长度 200 上限与路径穿越闸门、`readRoleFile` 读失败与 `resolveSubagentRoleText` 外层两处「回空串」 | `test-role-section-edges.mjs`（13 条，沙箱 `$DSH_HOME`） | `lib/redteam/role-section.js` 行 178/178 |
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
| 事实库迁移的两处回填真的生效：`asset.scope` 按 IP 归属判内外网（含 172.16–31 与 100.64–127 的边界）、`attack_step.stage_code` 按 `LEGACY_STAGE_MAP` 映射七个老阶段、已有值一律不覆盖、跑两遍结果全等 | `test-schema-migrate.mjs`（23 条） | `lib/redteam/schema.js` 行 632/634 |
| 三列老字段（`stage.attck` / `stage.blue_team` / `score_point.stage_code`）一次全删、删列失败保留且不抛、`has()` 读不到表结构回 `false`（复跑一次由 `ALTER TABLE ADD COLUMN` 兜回）、表不存在也不抛、跑两遍全等 | `test-schema-legacy-drops.mjs`（9 条） | `lib/redteam/schema.js` 行 632/634 |
| 知识库迁移：补出五个新列与两个索引、老条目按关键词推归类（具体压过泛化）、已有归类不被改写、`POC_CATEGORIES` 的 code 唯一且以 `other` 收尾 | `test-schema-migrate.mjs`（7 条） | 同上 |
| `dispatch` 的 op 表：71 个 op 各自调哪个方法、第几个实参、别名怎么退（`req.poc` / `req.id ?? req.code` / `req.id ?? req.shot_id` / 十二个 `xxx || req`）、`limit` 夹取、写操作闸门、未知 op 与异常的错误信封；无靶标时九个读 op 共用一个信封、`openEngagement` 不受闸门管；`pngSize` 的五种容器宽高（经 `addShot` 间接测） | `test-redteam-dispatch.mjs`（25 条） | `lib/redteam/store-core.js` 96.2% |
| IP / 网段 / slug 的十个纯函数：`cidrOf` 的 IPv4 取前三段与 IPv6 取前四组（带端口的 IP、IPv4-mapped 都原样返回）、`scopeOfIp` 的 172.16–31 与 100.64–127 边界 + fe80::/10 + IPv4-mapped 剥壳、`ipToInt` 的 32 位无符号与「只看位数不看范围」、`isIpv6` 的字符表与段数上限、`expandIpv6` 的 `::` 补齐、`slugTarget` / `slugPoc` / `defaultPocFilename` / `slugify` 的六处现状怪癖 | `test-ip-utils.mjs`（53 条） | `lib/redteam/ip-utils.js` 行 116 → **140/140**（分支 73/74） |
| 演练台库的筛选面与报告面：`listAssets` 的五个筛选（service / fingerprint / provenance / priority / scope）、`sort=todo` 与 `sort=ports` 两条排序串、`listShots` 的四个过滤、`deleteScorePoint` 的内置点拒绝与事务回滚、`saveScorePoint` 名称必填、`addScoreHit` 的 `point_name` 解析与两种警告、报告的「复现请求」段、`searchPocs` 的来源筛选、`listEngagements({stats:true})` 的坏库兜底、`refreshDefaultPrompts` 的 `.bak`、`readAttackFile` 的越界拒绝 | `test-store-core-facets.mjs`（26 条） | `lib/redteam/store-core.js` 行 3741 → **3794/3822**（分支 1368/1584） |
| 证据账本的十四条失败出口与两个计数：`record` 四道前置校验（`operation` 必填、`result` 不可为 null 但可为 `""`/`0`/`false`、`confidence` 四档、`authority` 六种）、`record` / `get` / `list` 三个 catch 的返回值各不相同（`{ok:false}` / `undefined` / **`{error}` 对象而不是数组**）、`countUnverified` 数裸条数而 `countUnresolvedClaims` 按 `supporting_ev_ids` 反查闭环（升级后前者不降、后者降）、坏 JSON 的四列各自回落到默认值、`upgrade` 四分支（未找到 / `derived` 拒绝 / 已 observed 原样 / claimed→observed 写新记录并用 `supporting_ev_ids` 链回原件、`subagent-report` 换成 `tool-output`、`recorded_by` 默认 `coordinator`）、`residual_unknown` 的 question/severity 校验、去重键折叠空白而存的是原文、`resolve` 只认 `resolved\|contradicted`（`withdrawn` 给干净校验错，不再走到 SQLite 的 CHECK） | `test-evidence-ledger-edges.mjs`（30 条） | `lib/redteam/evidence-ledger.mjs` 行 **516/516**、函数 20/20、分支 92.2% |
| 演练台库的最后几处回填：`platformConfigSave` 写盘后要**再读一次**才算钉住、截图按得分点与按命中两级计数（`shot_total` / `shot_count` 的 `\|\| 0`）、`shotBrief` 六个兜底（必须把可空列 `UPDATE … = NULL` 才是老库那行）、`assetIpOf(undefined)` 早退与 `assetIpOf(asset_id) \|\| slugTarget(host)` 的键回落、报告里「复现请求」段（去 CR / 截 2000 字 / `label` 回落 `method + url`） | `test-store-core-remainder.mjs`（10 条） | `lib/redteam/store-core.js` 行 **3822/3822（100%）** |
| 红队工具注册面的边角：参数封口（`{type:'object'}` 无 properties 封 `true`、有 properties 封 `false`、已封的不覆盖、`properties`/`items`/`additionalProperties` 三层递归）、`makeDefineTool` 四处都封、`capMap` 满员淘汰最早而同键重设不淘汰、`sessionInfoOf` 读 `header` 抛错时只丢父 id、`resolveRootSession` 父不在内存时用父 id 当根键 + 父子互指在 64 层停下、`bindingKeyOf` 的 rootId/sessionId/chain、`liveRunningChildren` 三态（注册表不可用 / 列失败 / 非数组当空表）、`reservationList` 无预留回空数组、`apply` 的 `ctx.redteam` getter 抛错时 warn 一条并注册满 64 个工具（桩库 `openEngagement` 报「红队资产库不可用」） | `test-tools-edges.mjs`（27 条：`sealObjectSchemas` 6 / `makeDefineTool` 2 / `capMap` 2 / `sessionInfoOf` 2 / `resolveRootSession` 5 / `bindingKeyOf` 2 / `reservationList` 1 / `liveRunningChildren` 4 / `apply` 2 / 源码形状 1） | `lib/redteam/tools.js` 行 479 → **500/501**（唯一剩下的 `:131` 是 `loadDefineTool()` 兜底，本机解析得到宿主所以走不到） |
| 演练台体检的「下一步该做什么」五条分支各自单独走到：linux 首次无 `setup.sh`（「这是正常情况，不是故障」+ `crt.sh` 降级）、有脚本没跑过（只让用户自己 `--check`，不许智能体 `--yes`）、有 marker 缺 `FOFA_KEY`（「有缺口」，`ok:false`）、配齐但技能坏（`ok:false`、`onboarding.complete:false`、`broken[].fixes` 来自 `issues[].fix`、`fix_note` 是另一件事）、全干净（`next === '全部可用，可以开工。'`）；外加 `runtime_hint` 的 linux 两行文案、`fromBundle` 翻假后逐条 `skills.get` 取正文、`skills.get` 抛错仍出结论、`include` 点名时才不并进随包技能 | `test-recon-preflight-edges.mjs`（9 条） | `lib/redteam/tool-specs-recon.js` 行 532 → **551/585**（唯一剩下的 `171-204` 不可达） |

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
| BOM 守卫（profile 清单带 BOM 会让桌面端起不来）：扫描口径 / 试运行 / 四条「决定不写」的出口 / status 文案 / 写后复查 | `test-bom-guard.mjs`（5 条）+ `test-bom-guard-edges.mjs`（19 条） | `lib/bom-guard.js` 行 100% |
| profile 的 `cordis.patch.yml` 按形态补齐（空文件 / `[]` / 块序列 / flow-seq 不动） | `test-self-update.mjs` | `lib/profile-insert.js` 行 100% |
| profile 的 `dsh.profile.bundles` 被补上且幂等 | `test-self-update.mjs` | 同上 |
| `pnpm-workspace.yaml` 的 `allowBuilds`：pnpm 11 删来源键、pnpm 12 保留、坏原文不写盘 | `test-self-update.mjs` | 同上 |
| profile-insert 的边角：insert 段的结束判据（内层缩进要按本行比）/ `classifyPatchBody` 五形态 / allowBuilds 的两处段结束 + 两类原样保留 / 写前校验不过一个字都不写 / 探测抛错就跳过整个 profile | `test-profile-insert-edges.mjs`（30 条） | `lib/profile-insert.js` 行 412/412（100%） |
| postinstall 只碰真的装了本插件的 profile | `test-self-update.mjs` | 同上 |
| 卸载先还原再删：`revertAll` 出错就停手、不进入清理 | `test-self-update.mjs` | `lib/uninstall.js` 94.3% |
| 卸载只删安装树（`node_modules/dsh-purge`），npm link 的源码目录不动 | `test-self-update.mjs` | 同上 |
| 卸载摘干净四个依赖段 + 顶层与嵌套 `bundles`/`plugins` | `test-self-update.mjs` | 同上 |
| 预设默认值改回 `standard`：7 种写法（裸值 / 单双引号 / 命名空间前缀 / 大小写 / 无空格 / 块内缩进）都落盘，`standard`/`other`/无键不动 | `test-preset-default.mjs` | `lib/preset-default.js` 行 205/205 |
| profile 扫描只认 `cordis.patch.yml` 与 `cordis.yml`，跳过 `node_modules`；空文件不进报告、不重写 | `test-preset-default.mjs` | 同上 |
| live 侧（`settings.update`）认命名空间前缀 / 大小写 / 两侧空白，吞 Promise 拒绝，fallback 本身是本插件时不写 | `test-preset-default.mjs` | 同上 |
| live 侧 bag：`{value}` 包装能改、有 `set()` 的优先走 `set()`、裸字符串改不动（现状锁定）、读属性抛错不炸文件侧 | `test-preset-default.mjs` | 同上 |
| profile 只读（`chmod 0444`）或路径是目录（EISDIR）时跳过，能修的照修，整条不抛 | `test-preset-default.mjs` | 同上 |
| 停用清理的边角：`get()` 抛错退回读 `value`、`value` 抛错只当「没有值」而不连累下一家袋子、`set()` 抛错退回属性赋值、两边都失败记 `live:false`、连排两次只留最后一份（第一棵 home 逐字节不动）、`removeStaleAgentPresetDir` 删不掉回 `false` 不抛 | `test-preset-default-edges.mjs`（8 条） | `lib/preset-default.js` 行 205/205 |
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
14. **角色稿的解析与落地已钉住，真宿主里的领消息事件没有。** `test-role-section.mjs` 的 23 条用例覆盖标签解析、文本抽取、`current` 的路径校验、稿件读取与钩子安装（`lib/redteam/role-section.js` 行覆盖 21% → 94%）。没覆盖的是宿主真的派发 `agent/inbox/claimed`、以及 `setTimeout(800)` 那次补装（用来兜住 effect 晚于首次领消息的情况）。另有两处防御在公开 API 上不可达、删掉外部行为也不变：`currentEngagementId()` 里「`agents/` 必须存在」与 `readRoleFile()` 里对 role 的二次校验——RED 演练里这两条是 GREEN，用例里已写明，不当成守卫。（现在 `test-role-section-edges.mjs` 把「`agents/` 必须存在」改成源码形状断言，长度上限 200 那条也是——Windows `MAX_PATH` 造不出 201 字的 `engagements/<id>/agents` 目录。）改坏的表现是「子会话拿着别人的角色稿干活」或「提示词里少一段角色说明」。

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
    `test-host-locate.mjs` 把判据与候选表钉死了（34 条，`lib/core.js` 当时 81.7%），之后的 `test-dsh-home-desktop.mjs` 又把桌面主目录那一段补齐（现有 4671/5205 = 89.7%）；但十四条判定之外仍有四处必须真的碰系统：
    **①`findDshHome` 的桌面分支里 `process.resourcesPath` 那一项**：`desktopHomeCandidates()` 现在已被 `test-dsh-home-desktop.mjs`（15 条）整段钉住 —— 造一棵过判据的假安装树（目录里真有 `DeepSeek Harness.exe`）+ 把 `USERPROFILE` 指进沙箱，六级回退全可测，`lib/core.js` 行 4633 → 4671。**剩下唯一空着的是 `if (process.resourcesPath) push(path.dirname(...))`**：这个属性只有 Electron 进程里有值，Node 下恒 `undefined`，用例里给它赋值也只会测到自己。
    **②`findWslWindowsDshHome` 的命中分支**：本机没有 WSL，`/mnt/c/Users` 不存在，所以「扫到一个带 `.dsh` 的 Windows 用户目录并返回」那一段一次都没跑过 —— 只钉了「非 linux 恒空」与「linux 下没有 `/mnt/c/Users` 也空」。
    **③`findAiBaseFromDshHome` 的第四条路**（`findAiBaseFromRequire` 走 `createRequire` 解析 `@deepseek-ai/dsh/package.json`）：要一份能被 Node 解析器认的 `node_modules` 布局（含 `package.json` 的 `exports`），本机 fixture 造得出来但成本远高于收益，目前只有前三条路有用例。
    **④`requireFrom` / `findAiBaseFromRequire` 本身**：它们靠 `createRequire` 的解析顺序，改坏的表现是「装了但找不到」，而不是抛错。
    **检测办法**：改完这一簇，除了 `node --test scripts/test-host-locate.mjs`，还要在真机上跑 `npm run host:status`（看 `ai_base` 指的是不是 `resources/app/dsh/node_modules/@deepseek-ai` 那一份、`patches_applied` 是不是 79 左右）与 `node scripts/verify-target.mjs`（看 `would-apply` 是不是 0 附近）。
75. **「回退到原文」这件事只测到了「我喂的那几个 fixture 能回到我写的那份原文」。**
    `test-cmd-flash-revert.mjs`（37 条）把五个回退分支、rank 规则、清单函数都钉住了，但三类东西仍在射程外：
    **① 真实的宿主原文**：fixture 里的 needle/patched 是我照着 `lib/core.js` 的字面量手写回来的，真实宿主文件被注入之前的形态（缩进、行尾、周边注释）只靠「两处字面量一致」间接保证。真正的判据是「拿 `.dshpurge.bak` 与回退结果逐字节比」—— 那需要一台装过插件、又被卸载过的机器，本机可以手动验，但写进用例就是在测历史。
    **② 五个 `revert*` 的写盘失败路径**：只对 `rewriteFiles` 做了 `hostFs.writeFileSync` 抛错的 monkeypatch，`revertHideConsoleFromBin` / `revertBinPreflight` 内部各自的写盘失败没有分别造（它们会回 `error:` 前缀，但错误文案依 `String(Error)` 而定，钉了也是钉 Node 的措辞）。
    **③ `revertCmdFlash` 与 `silenceCmdFlash` 的往返**：本批只在「固定 patched 文本 → 回退成固定 plain 文本」一个方向上验证；真正要紧的往返（silence → revert → silence，看是否回到第一次的结果、以及是否留下重复注释）没有端到端用例，因为那要把 11 补那簇的参数再造一遍。
    **检测办法**：在真机上跑一次「装 → 卸」，然后 `git diff --no-index` 或 `cmp` 比对宿主文件与 `.dshpurge.bak`；再跑一次「装 → 卸 → 装」，看 `windowsHide` 那段注释是不是只剩一份。

76. **「同一棵树只打一次」与「官方 exe 那条闸门」在真机上仍有射程外。**
    `test-host-tree-chain.mjs`（27 条）把选树与去重的判据钉住了，但三类情形只能靠真机验：
    **①** `findAiBaseDesktop` 里「当前进程就是官方 exe → 返回 null」这条闸门，在能 discover 到安装树的机器上**走不到**（`owned` 先返回）。要造出它的现场，需要一台进程真是 `DeepSeek Harness.exe`、且没有可发现安装树的机器 —— 本机做不到，所以只钉了「`owned` 为空时轮到它」这个前提。
    **②** 去重依赖 `nodeFs.realpathSync.native`：在真桌面（Electron）里，路径可能落在 `app.asar` 内部，native realpath 对 asar 路径会失败 → 退到 `hostFs.realpathSync`，而它对 junction 会返回 8.3 短名。也就是说「asar 内路径 + junction 别名」同时出现时，去重仍可能漏一次。本机是解包布局，造不出 asar 内的 junction。
    **③** `enumeratePatchAiBases` 的第一条永远是仓库自己的 `node_modules/@deepseek-ai`：在开发机上跑 `applyPatchesAllHosts` 会连 devDependencies 那份一起打。用例锁的是现状，没有断言「不该打」，因为要改它得动 `findAiBaseWeb` 的语义。
    **检测办法**：改完这一簇，除了 `node --test scripts/test-host-tree-chain.mjs`，还要在真机上跑 `npm run host:status`（看 `ai_base` 与 `patches_applied`）与 `node scripts/verify-target.mjs --pad`（看 `would-apply` 是否仍 ≈0）；再手动看一眼安装目录里有没有 junction，确认 `host:preview` 报的宿主数没有翻倍。
77. **「每棵宿主都走到」这条链在真机上仍有射程外。**
    `test-all-hosts.mjs`（23 条）把「遍历 → 去重 → 逐棵备份 → 逐棵打 → 汇总」的顺序与形状钉住了，但四类情形只能靠真机验：
    **①** `revertAllHosts` 里单树抛错那条 `catch`（`errors.push([aiBase, String(...)])`）造不出来 —— 沙箱里 `revertAll` 的两条失败路径（bak 为空、bak 缺失）都被它自己的 `errors` 接住了，不会抛到外层。所以只做了源码形状断言。
    **②** `discover` 表达式不能真改成 `discover: true` 演练：那会真的去扫本机安装树、命中真实宿主。这条只靠源码形状断言钉住 `options.forApply === true || options.discover === true` 与 `options.discover !== false`。
    **③** 「零宿主」造不出来：`enumeratePatchAiBases()` 至少会返回仓库自己的 `node_modules/@deepseek-ai`。用例锁的是现状（宿主表不得含仓库树那条安全断言），没有断言「零宿主时的返回形状」。
    **④** 真机多宿主下 `res.report` 一条补丁只有一行、`path` 只留第一棵树（`mergeApplyReports` 按 `patch_id` 归并）。沙箱里两棵树的路径都在临时目录，看不出「路径被丢掉」这件事的信息损失；真机上第二棵树在另一个盘符时才有感知。
    **检测办法**：改完这一簇，除了 `node --test scripts/test-all-hosts.mjs`，还要在真机上跑一次 `npm run apply`（看状态页报的宿主数与 `host:status` 的 `ai_base` 是否一致），再 `npm run revert` 后 `cmp` 每棵树的宿主文件与 `.dshpurge.bak`；开发机额外跑 `cd node_modules/@deepseek-ai/dsh-agent-instructions/lib && grep -c "ACTIVE and MANDATORY" index.js`，确认那条不该被改动过的路径仍是原文。

78. **改 `findAiBaseRecursive` / 深度扫描时验不到的三件事**：
    - **只经 junction 或符号链接才够得着的树扫不到**：`lib/core.js` 第 2376 行的 `if (!e.isDirectory()) continue;` 把 `Dirent` 报 `isSymbolicLink()` 的条目全挡在门外（junction 在 Windows 上就是这种）。沙箱里造得出来、也钉了用例，但「真机上因此漏掉哪些布局」验不到——真机的 `resources/app/...` 与 pnpm 链接树是不是走过这条兜底，只能看 `npm run host:status` 的 `ai_base` 是不是那条便宜路径给的。
    - **跨设备跳过在 Windows 上不生效**：条件里 `process.platform !== "win32" || e.isSymbolicLink()`，Windows 普通目录永远下钻。用例只能伪装 linux + 伪造 `dev` 覆盖；Windows 真机行为（`#91` 记录的 6 万目录 7.2 秒）无法在沙箱复现。
    - **桌面安装树排除依赖真安装**：`scanHomeRootsForAiBase` 命中的根若在 `desktop.listDesktopInstallRoots()` 里就被丢掉、继续下一个根。沙箱靠 `DSH_DESKTOP_INSTALL` 指假安装树验通了，但「真机上 `~/.dsh` 里那条软链指向哪」还是得跑一次 `npm run host:status` 比对 `ai_base` 与 `node scripts/verify-target.mjs` 的 `would-apply`。

    **检测办法**：改完这一簇，跑 `node --test scripts/test-deep-scan.mjs`，再假装容器布局跑一次 `DSH_SURFACE=web DSH_HOME=<空目录> node -e "import('./lib/core.js').then(m=>console.log(m.findAiBase()))"`，确认它没有把桌面安装树报上来。
79. **红队预设的解析链与槽位释放，在真宿主上仍有射程外。**
    `test-tools-resolve.mjs`（22 条）把「四条候选规则 → 29 条候选表 → 第一条能解析的就赢」与「`subagent/end` 到达时精确释放、对不上按时间兜底」都钉住了，但四类情形只能真机验：
    **①** `loadDefineTool()` 自己那半条路（`createRequire(import.meta.url)` 直接解析）是**环境两态**的：开发机上有桌面安装 → 解析成功；`ubuntu-latest` 上没有 → 抛错。用例只能写成「两态都算过」，于是这条分支真坏了也看不出来（拿到函数时不会去问「这个函数是从哪棵树来的」）。真正能确定的是后半个 `resolveDefineTool(candidates)` —— 它由人造宿主树覆盖，包括抛错文案。
    **②** 「解析失败 → 整份红队预设被下拉过滤」的真实表现验不到：沙箱里 `createRequire` 一定成功，看到的是「返回 function」。真机上要验这一层，只能把 `node_modules/@deepseek-ai/dsh-tools` 临时改名后重启宿主，看工具下拉里 `redteam_*` 是否整组消失、插件日志是否只有一行 `cannot resolve`。
    **③** 候选表里 `execPath` 那两条「退一级」在真桌面壳上的实际落点没验过：本机 `process.execPath` 是 `resources/app/.../DeepSeek Harness.exe`，`join(dirname,'..',...)` 折完会落到 `resources/`，而真能用的那条是列表后段的 `resources/app/dsh/node_modules/...`。也就是说这两条在真机上大概率是空跑 —— 但「空跑」和「落错地方把别人的包当成宿主的」在沙箱里长得一样，只能靠 `npm run host:status` 的 `ai_base` 与工具是否可用间接判断。
    **④** 槽位释放只挂在 `subagent/end` 上：宿主不发这个事件、或 handler 抛错被 `try` 吞掉时，名额只增不减。沙箱用假 `ctx.on` 验了注册与解绑，真机上要确认「派三次子智能体后 `redteam_agent_slot status` 的 `used` 回到 0」——这一步没有自动化，属于每次升级后手点一次的项目。

    **检测办法**：改完这一簇，跑 `node --test scripts/test-tools-resolve.mjs`；再在真机上打开演练台派一个子智能体、等它结束后调 `redteam_agent_slot`（`action: "status"`），确认 `used` 掉回 0 且 `reservations` 为空数组；若工具整组不在下拉里，先看插件日志有没有 `cannot resolve @deepseek-ai/dsh-tools`。


80. **旧得分项清理的「存档成功」只有一条路，步骤记分的失败分支只有一条路进不去。**
    `test-store-evidence-rules.mjs`（21 条）把「先存档再删 / 存档失败一条不删 / 自建点不动 / 多值筛选 / 步骤连带记分」都钉住了，但三件事只能在真机上才算数：
    **①** 存档成功的前提是 `<靶标>/runs` 可写。沙箱里用「把 `runs` 做成文件」造失败路径，真机上更常见的是**磁盘满 / 目录被安全软件锁住 / 靶标目录被设成只读**，这三种在沙箱里造不出来（`chmod` 在 Windows 上是空操作，`mkfifo` 之类更不行）。它们的共同后果是「清理一直不生效」——`purged` 永远 false、旧点一直挂在面板上，但**不报错**，只能靠面板上肉眼发现旧 code 还在。
    **②** `addChainStep` 的 `catch`（`:2693-2696`，「步骤已保存，但记分失败：…」）在正常实现下**走不到**：`evidence` 已非空、`points` 不传、`#servicePortOf` 自己带 `try`、`score_hit` 表没有 FK 约束（`PRAGMA foreign_keys=1` 但没定义外键），连 `point_id=999999` 都能安静地插成一条 0 分命中。它只有「`evidence` 不 `trim` 就去判空」这类**突变**才会被触发（演练里就是这么红的）。所以这条提示文案在真机上是否合理，没有守卫。
    **③** `seedScorePoints` 的 `{ seeded: 0 }` 早退分支（`missing===0 && purgedPoints===0 && synced===0`）在常规库上走不到：内置点还在时，同步循环每条都算一次 `changes`，`synced` 恒 > 0，于是返回的是完整对象（全零字段）。真要走到，得让表里一条默认 code 都不存在且又没有要补的 —— 与「缺哪条补哪条」互斥。这里锁的是**实际返回值**（逐字段断言），不是那条早退分支。

    **检测办法**：改完这一簇，跑 `node --test scripts/test-store-evidence-rules.mjs`；再在真机上打开演练台读一次得分面板，确认面板里没有 `web-account-*` / `webshell` / `rce` 这类旧 code（有就说明清理一直没生效，去看 `<靶标>/runs` 是否可写、有没有 `legacy-score-*.json` 落下）。


81. **报告正文的四条边角只能锁文本，锁不到「真机上读起来对不对」；另有一段重复兜底已删。**
    `test-report-edges.mjs`（14 条）钉住的是 **markdown 文本与条目字段**，不是渲染结果：
    **①** 长备注的切点在「后半段的句号/逗号」上，但**中文标点之外的边界**（英文句号后跟空格、代码块内的换行）没有覆盖：`oneLine` 先把换行压成空格，正文里就没有换行可切了。真机上如果备注是粘贴进来的多行命令，读到的会是压平后的长串 —— 这条行为是刻意的（表格里不能有换行），但「压平后还能不能读」没人判。
    **②** 档位校正段只认备注里的「校正」两个字。真实复核时若有人写成「下调」「复核后取 50」，这段就不出现，而分照样是下调后的 —— 于是报告里出现一个**没有解释的差值**。这是文案约定，不是代码能判的。
    **③** 截图归属：`shot_total` 精确等于「该得分点的全部截图」，指路文案写死「最多展示 3 张」。代表图的挑选规则（`representativeShots`）改了以后，这段文案不会自动跟着改 —— 只有 `test-score-report.mjs` 的 limit 用例会红。
    **④** `pushStep` 里「已有的是推断、这次来的是实锤 → 撤掉推断标记」那半句**在现有归因顺序下永远不触发**：顺序固定 `linked → vuln → point(推断) → asset(推断)`，推断项总在实锤之后进来。演练时把这一整句删掉，测试全绿（等价突变），于是把它降级成源码注释里的说明，不为它硬凑用例；保留它是为了将来若有人调换查询顺序时不静默把实锤降级成推断。
    **⑤** 已删除的 `:451-478` 那段重复兜底：删除前后 `test-score-report.mjs`（43 条）+ `test-report-edges.mjs`（14 条）+ `test-score-consistency.mjs`（25 条）全绿，行为零变化。**它的「删除」没有守卫**——只能靠这条盲区记录与源码注释，任何回归（有人把 ③ 的条件改窄、让兜底重新变得可达）都不会红。

    **检测办法**：改完这一簇，跑 `node --test scripts/test-report-edges.mjs scripts/test-score-report.mjs`；再在真机上跑 `node scripts/export-engagement-report.mjs <靶标 id>` 导一份真报告，肉眼确认三处：长备注末尾是不是完整句子、下调过的条目下面有没有「档位校正」段、同得分点多图时第二条有没有一句「去看代表图」。

82. **`lib/desktop.js` 的行命中会在 1813/1818 之间抖，抖动是同一组四行。**
    差集固定是 `lib/desktop.js:857-860`（`listDesktopPackageRoots()` 里 argv 带 `desktop-cli.js` / `host-process-entry.js` 的那个分支）。观测：同一 commit 连跑四次 `npm run test:full`，三次 1813、一次 1818；把沾到候选表的所有测试文件逐个单跑，没有一个覆盖到那四行；没有任何测试改写 `process.argv`。**触发者未定位**。
    后果被门禁兜住了：基线按低值（1813）记，向上 +5 不报红、向下仍会红（`MAINTENANCE.md` 的「基线取本机实测的低值」一节）。真机上这一支的价值只有「桌面壳以 `desktop-cli.js` 形态启进程时能不能定位到包根」，本机进程是 `resources/app/lib/main.js` 形态，走不到那里 —— 所以它属于「测得到但用不上」的分支。

83. **`lib/rewind.js` 还有三处「改坏了也测不出来」的地方。**
    **①** 草稿的 10 分钟过期（`DRAFT_TTL_MS`）：`Date.now` 在模块里直接调用，要测只能改全局计时器，而那会把同一进程里其他用例的时间判断一起改掉（`node --test` 是同进程跑一个文件）。所以过期分支仍然零命中；真出现「回退后草稿取不出来」时，先看是不是 10 分钟这条线。
    **②** `disarmRewoundSession` 里 `if (!id || seen.has(id)) continue;` 的 `!id` 那半个判据不可观测：`ids` 的两个来源（`pendingInboxInserts()` 与 `agent.inbox` 循环）都各自先判过 `message?.id`，空 id 进不了数组。演练时把 `!id` 删掉测试全绿（等价突变），保留它只为「将来有人加第三个 id 来源」。
    **③** `rewindOneSession` 的 `if (!key) return doRewindOneSession(...)` 早退只有性能意义：进锁也能跑通（`''` 这个键谁都不会并发），行为断言区分不开。演练时把它删掉测试全绿，于是只钉「sessionId 为空时只 fork 一次」这个结果，不钉「有没有进锁」。
    **④** `waitTurnClosed` 的默认 8000ms 与 80ms 睡眠粒度：测试一律显式传 `timeoutMs`，所以「默认值被人改成 800 / 80000」不会红。真机上这条线决定「点了回退要干等多久」，改动时请连带看一眼 `lib/rewind.js:379` 的形参默认值。

    **检测办法**：改完这一簇，跑 `node --test scripts/test-rewind-edges.mjs scripts/test-rewind.mjs`；再在真宿主机上手工走一遍「轮次还在跑时点回退」（应提示先 Stop）、「连着点两次回退」（应一次成功一次跟进而不是卡死）、「回退后什么都不发」（应安静，不该自己冒出回答）。

84. **`lib/redteam/ip-utils.js` 有一条分支永远走不到，另有三处「脏输入也算合法」的现状没有被改。**
    **①** `expandIpv6` 的 `return groups.map((g) => (g === '' ? '0' : g.toLowerCase()))` 里 `g === ''` 的 true 分支是死分支：`head === '' ? []` 与 `tail === '' ? []` 两道守卫保证空段进不了 `groups`，`new Array(...).fill('0')` 也只产出 `'0'`。`node --test` 的 lcov 里它就是 `BRDA:37,72,0,0`，`brh` 上限 73/74。用三条互为补偿的等价突变验过（删任一条另两条都能把结果补回同一个值），所以不为它造用例。
    **②** `isIpv6` 只校验字符表与段数上限，不校验真语法：`":"`、`":::"`、九组的 `"1:2:3:4:5:6:7:8:9"`、两个 `::` 的 `"2001:db8::1::2"` 全部返回 true。当前故意不收严 —— 它唯一的调用方是 `cidrOf` 与 `score-rules.js` 的 `targetHasIpv6Host`，两边都只用它决定「要不要走 IPv6 分支」。收严的后果是脏输入掉回 IPv4 分支、被前缀判据当内网，扫描范围反而放大。
    **③** `cidrOf` 不剥 IPv4-mapped 的壳（`::ffff:10.0.0.1` → `0:0:0:0::/64`），`scopeOfIp` 剥（算 `internal`）。两处口径故意不同：剥壳会把 IPv4-mapped 资产并进真的 `10.0.0.0/24` 段，跟 IPv4 资产混成一组，比现在更难查。
    **④** `slugTarget` 的结果是**已经落盘的靶标目录名**，所以它的怪癖只能钉不能改：非 ASCII 目标整段被 `[^\w.\-]` 洗成 `unknown`（中文靶标全部挤进 `unknown/`）、`https://` 只剩协议名 `https`、IPv6 URL 变成 `_2001_db8__1`。改任何一条都会把用户已建的攻击文件留在旧目录里，因此这一批只锁现状。

    **检测办法**：改完这一簇，跑 `node --test scripts/test-ip-utils.mjs`（53 条应全绿）；再在演练台里手工确认三处：资产测绘左侧按段分组里 IPv6 目标只出现一个 `xxxx:xxxx:xxxx:xxxx::/64` 段（不是每个地址一段）、`172.16`/`100.64` 那两个边界地址落在「内网」侧、给同一个 IP 补一个 `:8080` 之后攻击文件仍落在同一个目录。

85. **`lib/bom-guard.js` 里 `atomicWriteSync` 的 `fsyncSync` 与几条「实现等价」的判据，进程内测不到。**

    **①** 「写 tmp → fsync → rename」里的 `fsyncSync` 没法在同一个进程里验证：它没有返回值、没有可观察副作用，把 `fsyncSync` 换成空函数测试全绿（批31 的同一个结论）。当前只能靠源码形状断言「写盘必须经过 `atomicWriteSync`」（`test-bom-guard-edges.mjs` 的最后一条），不能断言「真的把数据刷到了盘上」。

    **②** 写后复查的两条（`hasBom(after)` 抛错、`kind === "json"` 时再 `JSON.parse(after)`）只能靠**让读回来说谎**来测（`fs.renameSync` 记标记 + `fs.readFileSync` 返回坏内容）。真实时序 —— 另一进程在同一毫秒把 BOM 写回去、或磁盘缓存返回旧内容 —— 复现不了，所以「读回来的确实是盘上的字节」这一层没有守卫。

    **③** `hasBom(0)` / `stripBom(0)` 这两类非字符串入参只钉了结果（`false` / `""`），区分不了「先 `String(text ?? "")` 再判」与「`typeof text === "string"` 早退」两种实现 —— 对 `null` / `undefined` 之外的值两者同答案。`hasBom` 的 `String(text ?? "")` 目前只有一条源码形状之外的间接证据（`hasBom("x" + BOM) === false` 说明它只看开头）。

    **④** `candidateFiles` 里 `statSync` 抛错与非目录两种 `continue` 无法区分：两者都只是「不产生候选」，`checked` 与三个数组全都不变。要区分只能把 `fs.statSync` 换成抛错版本，但那与「`profiles/` 不存在」的路径完全重合。

    **检测办法**：改完这一簇，跑 `node --test scripts/test-bom-guard.mjs scripts/test-bom-guard-edges.mjs`（5 + 19 条应全绿）；再在真机上手工验一次救砖主路 —— 拿一个 `profiles/<name>/package.json` 用记事本存成「UTF-8 with BOM」，跑 `dsh-purge --status` 应出现 `清单告警 / manifest: 1 个清单带 BOM（宿主 0.2.2 会起不来） —— 运行 dsh-purge --fix-bom 修复`，跑 `--fix-bom` 后该行消失、桌面端能正常启动。

86. **`lib/rules.js` 的 `resolveInjectText` 有最后一条兜底返回永远走不到；另有两条语义差异无法从外部区分。**

    **①** `resolveInjectText` 的末行 `return { text: "", source: "none", ruleId: null };` 需要「框内提交、磁盘稿、内置默认正文」三者都归一成空串。内置默认来自 `defaultOverrideText()`（一整篇提示词，实测 `normalizeOverride` 之后仍有 20994 字符），它永远非空 —— 所以 `source: "none"` 这个取值在正常安装里不可达。反过来，如果哪天内置正文真的被清空，这一支会变成「注入为空但 UI 显示 none」，届时才有意义。

    **②** `ensureOperatorBody` 的最后一句 `return resolved.text || normalizeOverride(hungOperatorPrompt()) || "";` 里，`|| normalizeOverride(hungOperatorPrompt())` 只在 `resolved.text` 为空时生效 —— 同上，这条路也不可达。三条 `||` 的实际可观察行为只有第一条。

    **③** `saveRule` 回滚段里的两个内层 `try { … } catch { /* 回滚失败,原错继续抛 */ }`：要触发「回滚本身也失败」，需要在回滚写入的那一刻再让磁盘拒绝一次，而 monkeypatch 出来的失败是**持续性**的（会同时打断第一次写入），所以造不出「第一次写成功、回滚写失败」。这两层 catch 只有源码形状断言（「回滚在 `throw e` 之前」），没有行为用例。

    **检测办法**：改完这一簇，跑 `node --test scripts/test-rules-rollback.mjs scripts/test-rules-store.mjs`（16 + 30 条应全绿）；再在真机上手工走一次回滚 —— 停掉桌面端、`chmod 0o444`（或把目录设只读）让 `$DSH_HOME/AGENTS.md` 写不进去，然后在面板里保存并激活一条规则：应看到保存失败，并且 `rules/<id>.md` 与 `rules/<id>.json` 都还是**动手之前**的内容。

87. **`lib/routes.js` 只剩一行没跑到；另外 `lib/rewind.js` 的分支命中数会在 311/312 之间抖。**

- `lib/routes.js:618`（`/own-servers` POST 成功时的 `sendJson(response, 200, …)`）走不到：`lib/net-scope.js` 的 `writeAllowText()` 引用未声明的 `allowCache`，任何 POST 都在下一行前抛错。属上游 1.1.94 刻意留空，测试里已现状钉住「当前回 500」。
- `lib/rewind.js` 的 `brh` 同一 commit 同一台机器连跑 5 次：4 次 312、1 次 311（`brf` 恒 373）。差的那一个是 `waitTurnClosed` / `rewindLocks` 里「先被拒还是先被兑现」的顺序分支，取决于两个 Promise 的 settle 先后，测试无法钉顺序。处置：**不**给 `lib/rewind.js` 加 `ENV_TOLERANCE`（该文件的容差按 `scripts/coverage-baseline-lib.mjs` 的规矩要先在干净 worktree 里复现同一下跌，本机复现不出来）；若 `npm run test:full` 报 `↓ lib/rewind.js 分支 312 → 311 (-1)`，重跑一次即可，**连续两次 311 才算真倒退**。

88. **卸载的两份 `rmTree` 是独立进程脚本，闸门只能靠源码形状钉；另有四条分支这台机器上造不出来。**

   - `lib/uninstall-restart.js` 与 `lib/restart-desktop.js` 都是顶层 await 的独立进程脚本，`import` 会把进程跑起来，所以 `OWN_TREE` 那句只能用「读源码 + 剥注释后断言」钉。**没有守卫的是**：这两个脚本真的被那个隐藏 PowerShell 宿主拉起来时的行为（`spawn` 参数、`detached`、日志落点）。
   - `uninstallPurge` 的早退① 还有一条旁路：`report.errors.some((e) => /^revert patches:/.test(e))`。目前只有「`revertAll` 直接抛错」能命中，而 `revertAll` 的抛错路径要宿主文件被独占锁住 —— 本机造不出来，因此这条旁路只测了 `patches.errors` 那一半。
   - `unregisterProfiles` 的 catch（`lib/uninstall.js:199-200`）在「读完能写、写到一半抛」的现场才触发；`fs.renameSync` 抛错那条已经覆盖同一条早退，但**这条 catch 本身**（`readJson` 抛而不是 `writeJson` 抛）没有独立用例。
   - `collectCleanupDirs` 里 `fs.realpathSync` 的两个 catch（`:160`、`:175`）在 Windows 上要造「路径存在但 realpath 失败」的现场（通常是权限位导致的拒绝访问）。沙箱里造不出，所以「链接解析失败时退回 `path.resolve`」这条只有源码可读。
   - **检测办法**：做一次真实卸载（`/uninstall`），看它报告的 `cleanup` 里有没有出现你自己的源码目录；出现在那就是 `OWN_TREE` 又被放宽了。另外看一眼 `%TEMP%\dsh-purge-cleanup.log`（重启助手的日志），里面每一条被跳过的路径都会写 `skip cleanup <path>` —— 这个文件里出现源码路径说明它被正确拦下了，什么都不写说明闸门在更早的地方就把它挡了。

89. **证据账本（`lib/redteam/evidence-ledger.mjs`）的五处口径缝隙。** 行已 100%（516/516），但下面这些「不报错、只少东西」的地方只能在真机上认：
    **①** `residual_unknown` 的 `status` 允许五个值（`open` / `investigating` / `blocked` / `contradicted` / `resolved`），而写状态的入口只有 `resolve()`，它只写 `resolved` / `contradicted`。`investigating` 与 `blocked` **没有任何 API 能设**，想改只能直连 SQLite —— 也就是说「这个问题正在查」这个状态在工具层不可达，模型只能靠再记一条 question 来表达进度。
    **②** 失败返回值把「读不出来」压成「真的没有」：`get()` 读盘失败回 `undefined`（与「库里没这条」同一个值）、`countUnverified` / `countUnresolvedClaims` 回 `0`、`list()` 回 `{ error }` 对象而不是数组。测试只能钉住现状形状，钉不住调用方有没有看返回值。
    **③** `record()` 的 `parameters` 走 `JSON.stringify(parameters)` 原样入库，而参与哈希的那份先过了 `sanitizeForHash`（BigInt → 字符串、function/symbol → 占位）。所以 `parameters` 里塞一个 BigInt，`JSON.stringify` 会抛，`record` 回 `{ok:false, error:'Do not know how to serialize a BigInt'}` —— 哈希算得出来、库写不进去。这条没有被专门钉（本批的 catch 用例覆盖的是「prepare 抛」这一条路）。
    **④** `recorded_at` 是 `new Date().toISOString()`，**毫秒精度**。同一毫秒内写的多条之间 `ORDER BY recorded_at DESC` 没有稳定次序，任何「取最新一条」的写法（包括 `list({limit:1})`）都不能当成「最后写入的那条」。
    **⑤** 两处 `unknown` 的兜底只在「库句柄整个坏掉」时被覆盖：`prepare` 必抛的假句柄能把三条 catch 全打红，但「prepare 成功、`run` 因为约束/磁盘满失败」是另一条路（`resolve` 那条走到过：`withdrawn` 当年就是撞的 CHECK），没有专门的用例。
    **检测办法**：`node --test scripts/test-evidence-ledger-edges.mjs`（30 条）应全绿；要看真库里的缝隙，对一个真实靶标库跑
    `SELECT status, COUNT(*) FROM residual_unknown GROUP BY status` —— 只有 `open` / `resolved` / `contradicted` 说明 ① 成立（没有 investigating/blocked 的行）；
    `SELECT COUNT(*) FROM evidence WHERE json_valid(parameters)=0 OR json_valid(result)=0` —— 非 0 说明库里有老数据或直连写过坏 JSON，`get()` 那边会静默回落成 `{}` / `null`。
90. **演练台库的筛选面 `lib/redteam/store-core.js` 仍有六段未覆盖，而且「复现请求」段有两份平行实现。**

    1. `reportTargets` 里的「复现请求」段（`lib/redteam/store-core.js:3369-3375`）一行都没跑过 —— `report()` 用的是它自己那一份（约 `:3491`），两份实现同时在用、也同时在改，改错一份没有任何信号。**检测办法**：`grep -n "复现请求" lib/redteam/store-core.js` 会命中两处；改任一处之后跑 `node --test scripts/test-score-report.mjs scripts/test-store-core-facets.mjs`，只有 `report()` 那份会让 `test-store-core-facets.mjs` 变红。
    2. `listEngagements({stats:true})` 的 `catch`（`:899-902`）里「库损坏也照样列出靶标」只在 `stats === null` 时可观测 —— 而坏库的造法是往 `assets.db` 写一段非 SQLite 字节。**检测办法**：造一个靶标，把 `engagements/<id>/assets.db` 覆写成 `not a sqlite file at all`，面板里靶标必须仍然列出来（统计列显示空）。
    3. `dispatch` 的 `platformConfigSave` op（`:673-675`）没有专门用例 —— 它只是 `savePlatformConfig(req.config || {}, store.root)` 再回一份摘要，`scripts/test-platform-config.mjs` 测的是函数本身而不是这条 op。
    4. `scorePoints()` 的截图回填（`:1606-1616`）里「一条得分点下多张截图、分属不同命中」的聚合只在 `shotBrief` 的字段表上体现；现有用例只覆盖「一条命中一张图」。
    5. `attackGraph()` 的 `access` 分组（`:3341-3356`）在没有任何已被利用的漏洞时走不到 —— `seedAssets` 一造漏洞就会同时造出 `exploited`，所以「空 access 组」只能靠删表造（而删表会让 `attackGraph` 直接抛，见下一条）。
    6. **删掉两处死代码之后，`#hitTrace` 这个名字在 `lib/redteam/store-core.js` 里已经不存在**，但 `hitTrace` 函数本身在 `lib/redteam/score-report.js` 里仍在用。**检测办法**：`grep -rn "this.#hitTrace" lib/` 必须为空；`grep -rn "hitTrace" lib/redteam/score-report.js` 必须有命中。
91. **`lib/rewind.js` 已经 100% 行覆盖，但有三件事仍然只能靠源码形状钉。**

    1. **`service` 里 `typeof ctx.get !== "function"` 那道守卫是冗余的**（后面紧跟同样返回 `undefined` 的 catch），所以「删掉守卫」与「留着守卫」在行为上不可区分。**检测办法**：`grep -n "typeof ctx.get" lib/rewind.js` 必须命中一行；如果哪天有人把那条 catch 改成别的值，这条守卫就重新变成必要的了 —— 那时应该补一条「没有 get 的 ctx 返回 undefined」的用例，而不是删守卫。
    2. **`lib/rewind.js:337` 的 `/* ignore */` 与 `:406` 的 `/* ignore */` 里的注释长度**没有断言（只断言了两侧 try/catch 的数量）。**检测办法**：`grep -c "\} catch { /\* ignore \*/" lib/rewind.js` 的数应与「独立 try 段数」一致。
    3. **`getPending` / `getDraft` 的过期判定依赖真实时钟**：用例里把 `Date.now` 往后拨 11 分钟来模拟，这意味着**没有覆盖「时钟回拨」**（用户手动改系统时间到过去）这一种情况 —— 那种情况下 `Date.now() - rec.at` 是负数，判据 `> DRAFT_TTL_MS` 为假，草稿会一直被当成新鲜。**检测办法**：`grep -n "Date.now() - rec.at > DRAFT_TTL_MS" lib/rewind.js` 有两处（`getDraft` / `getPending`），两处都只判上限；真要处理回拨得改成绝对差值比较，那属于行为改动，当前按现状锁定。



**92. `lib/profile-insert.js` 的 insert 段状态机只剩「关闭」这一半，另外三处判断靠别的测试文件。** 本批删掉了 `profileHasPurgeBodyInsert` 里永远走不到的 reopen 三行（判据见「四十四补」第 1 条），剩下的段状态机只有一个 `insertIndent` 变量、两种转移：进段、关段；**没有「同段内出现第二条 `- insert:`」这种情况的用例**（因为那时已经在段里，先命中的是本体行匹配）。另外 `164-174`（`ensureProfileBundles`）与 `385-409`（`ensureAllProfileInstall` 尾部）不在本批测试的覆盖范围内 —— 单跑 `scripts/test-profile-insert-edges.mjs` 时 lcov 会报这些行未命中，它们是 `test-self-update.mjs` 的地盘。`pnpmMajor` 三个来源里「`.modules.yaml` 读得到但没有 `packageManager` 字段」这一支没有专门用例；`keepSources === false`（pnpm 11）那一侧也仍由 `test-self-update.mjs` 覆盖，本批只用 `dir = "NOPE"`（major 判不出 → null → 保留来源键）跑过保留侧。**检测办法**：`grep -n "keepSources = major === null || major >= 12" lib/profile-insert.js` 必须命中一行，且 `grep -c "inAllow = false;" lib/profile-insert.js` 为 1（多了说明段标记在别处也被清）。
**93. `lib/hide-console.js` 的 `95-97` 三行（`createRequire` 也失败时返回 `null`）在本机造不出来。** 要走到那三行，得让 `createRequire(import.meta.url)("node:child_process")` 抛错 —— 内置模块在本机永远拿得到，而 `createRequire` 是模块级导入的绑定，换成假的是改源码而不是造现场。`installHideConsole()` 的 `skipped: "builtin_unavailable"` 出口因此只能靠阅读确认。**检测办法**：`grep -n 'skipped: "builtin_unavailable"' lib/hide-console.js` 必须命中一行；如果哪天 Node 出了「禁用内置模块」的开关，这条就该补用例。
**94. `lib/index.js` 剩下的 10 行在本机造不出来。**

    1. **`140-142`（`watchWebTreeReady` 的 no-inject 早退）经 `apply()` 永远走不到**：`installWebServer` 无条件调用 `ctx.inject`，所以「没有 inject 的宿主」在进 `watchWebTreeReady` 之前就已经 TypeError 了。**检测办法**：`grep -n 'typeof ctx?.inject !== "function"' lib/index.js` 必须命中一行且紧随 `mark();` 与 `return;`；如果哪天 `installWebServer` 改成先探测再 inject，这条就该补用例。
    2. **`229-230`（seed 的 catch）**：`syncPromptInjectOnDiskSync` 内部已把 `atomicWriteSync` 整段包进 try/catch 并转成 `{action:"error", reason}`，所以 `seedPromptInjectAtBoot` 在三种坏现场（home 是文件、home 不存在、`prompt-inject.md` 是目录）下都只返回 error 而不抛；`DSH_HOME` 里塞 NUL 也会被 `process.env` 吞掉。**检测办法**：`grep -n "seed prompt-inject failed:" lib/index.js` 必须命中一行；真机上把 `$DSH_HOME` 换成只读卷再启动，日志里应出现这一行。
    3. **`271-275`（settle 的 `isInactiveContextError` catch）**：`settleInstalledPatches` 在沙箱里从不 reject（它自己把每一步都 try 住了），所以「异步阶段才发现 ctx 没了」这一支只能用源码形状确认。**检测办法**：`grep -n "isInactiveContextError(e)" lib/index.js` 必须命中；真机上在 settle 期间发一次 `/revert` 让 ctx 被 dispose，日志里应出现 `settle skipped: inactive context`。

**95. `lib/redteam/tools.js:131` 的 `loadDefineTool()` 兜底**

`loadDefineTool()` 先试 `createRequire(import.meta.url)('@deepseek-ai/dsh-tools')`，
失败才 `return resolveDefineTool(defineToolCandidates())`。本机（开发机）第一条就解析成功
（插件自己的 `node_modules` 里有宿主包），所以 `:131` 恒不走；CI 上那条走得到，但 CI 不统计
覆盖率。判据：`grep -n "return resolveDefineTool(defineToolCandidates())" lib/redteam/tools.js`
只有一处，且其上一行是 `} catch { /* 插件自己的 node_modules 里没有，再扫宿主 */ }`。
检测办法：在干净机器上跑 `node --test --experimental-test-coverage scripts/test-tools-resolve.mjs`
，`resolveDefineTool` 的调用次数应 ≥1；本机会是 0。

此外这一批有两个「只能源码形状钉」的点，都写在 `test-tools-edges.mjs` 的最后一条里：
桩库三件套（`openEngagement` 抛 / `listEngagements` 回 `[]` / `stats` 回 `{}`）与
`loadDefineTool` 的兜底句。它们的行为分支已分别有直接用例，形状断言只是防有人顺手删掉。

96. **`lib/prompt-source.js` 里仍然测不到的四处**：(a) `refreshHungOperator` 的风暴窗（10 秒内重算超 120 次才进入 `tripped` 状态）—— 要在进程内造出 121 次重算，得让 mtime 每次都变，也就是每轮都写盘，测试成本远高于收益，只由源码形状钉住阈值常量；(b) `hungDepth > 0` 的重入保护（`112`）—— `purgeLog` 与四档降级都不会回调 `fn()`，进程内没有第二次进入的路径，只能靠源码形状；(c) `readInjectFallback` 的 `subagent` 分支（`context.agent.session.header.origin === "subagent"`）已在 `test-prompt-source.mjs` 里覆盖，(d) `injectSnapshotFromBox` 的「框里有字但归一化后为空」分支需要构造只含空白字符、且四级兜底全空的现场，与 (a) 共用同一套成本。检测办法：`grep -n 'HUNG_STORM_LIMIT\|hungDepth > 0' lib/prompt-source.js` 确认阈值与重入保护仍在；`grep -rn 'origin.*subagent' scripts/test-prompt-source*.mjs` 确认 (c) 有守卫。

97. **`redteam_preflight` 的「下一步」五条分支都有守卫了，但仍有两处空白。** (a) `171-204` 那 34 行只在 `skillsMissing && bundledSkills.length === 0` 时执行，而 `bundledSkillSummaries()` 恒扫随包 `skills/redteam`（23 个 `.md`）与 `<home>/redteam/skills` —— 任何安装形态下都不为空，所以只能源码形状钉（`test-recon-preflight-edges.mjs` 最后一条断言 `if (bundledSkills.length === 0) {`、`error: '读取技能目录失败：'`、`summaries = bundledSkills` 三处原文）。(b) 占位符提示对**可用**技能不可见：`checkSkill` 把 `<你的VPS_IP>` 这类占位符记成 issue（`status` 仍是 `available`），而返回体只给 `broken` 带 `needs_user`/`problems`，于是「技能正文里还有占位符」在 preflight 输出里查不到 —— 现状锁定，用例用 `assert.deepEqual(pf.needs_user_flat, [])` 钉着；要把这条暴露出来得给 `available` 也带 issues，属产品决策。检测办法：`grep -n "skillsMissing && bundledSkills.length === 0" lib/redteam/tool-specs-recon.js`；`grep -n "needsUser = Array.from" lib/redteam/tool-specs-recon.js` 确认 `needs_user` 仍只从 `broken` 收集。改坏的表现是「桌面端首次打开演练台时体检整条报废」，或者「模型看不见技能里还留着 `<你的VPS_IP>`，直接拿占位符去连 VPS」。

98. **后台重启真的能跑起来这件事，本机一条都没验过。** `scripts/test-web-restart.mjs` 的 13 条全在**假 `spawn`** 上跑：它证明的是「调用了谁、带了什么参数、延时多少、env 里有什么」，不证明 `lib/restart-web.js` 与 `lib/uninstall-restart.js` 真的能把 server 从旧 pid 手里接过来。真跑一次需要：一个真的监听端口的 server、一次真的 detached spawn、一个真的会退出的父进程 —— 三件事凑一起就会把跑测试的进程杀掉，所以这台机器造不出可靠 fixture。同理 `process.exit` 被替换后，`setTimeout` 的回调**一次都没执行过**（只钉了延时值），「250ms 之后真的退出」不在守卫范围内。**检测办法**：手工 `dsh web` 起一个会话，在面板上点一次「重启」与一次「卸载后清理」，用 `netstat -ano | findstr :<port>` 看端口是否换到新 pid、旧 pid 是否消失、临时目录里的 `dsh-purge-uninst-<pid>.mjs` 是否在清理结束后被删掉。
99. **`spawnRestartHelper` 里那句 `core.silenceCmdFlash()` 会去改宿主的 `bin.js`，而且没法重定向。** 它内部走 `findAiBase()`，而 `findAiBase()` 的候选里有一条锚在 `lib/core.js` **自己所在的位置**（不是 `cwd`、也不是 `DSH_BASE`）—— 于是本机会恒定落到 `D:\dsh-purge-maintained\node_modules\@deepseek-ai`。本机现状是 `entry: "already_injected"`（幂等，SHA-256 跑前跑后不变，测试结尾专门断言了这一点）；但如果哪天那份 `bin.js` 被 `npm ci` 换成未注入版，这条测试就会**真的去改 node_modules 里的文件**。CI 上没有这棵树时它是早退，所以不会红。**检测办法**：`git status --porcelain node_modules` 无用（被 gitignore），改用 `sha256sum node_modules/@deepseek-ai/dsh/lib/bin.js` 在跑 `node --test scripts/test-web-restart.mjs` 前后比对；不一致就说明那份 `bin.js` 已经不是注入版了。

100. **`canResolveAppBoot` 里 `isFile(hit/package.json) || isDir(hit)` 的左半永远不决定结果。**
    要让 `isFile` 为真，`dsh-app-boot` 必须存在且里有 `package.json` —— 那时它必然是目录，
    `isDir(hit)` 已经为真；反过来若 `dsh-app-boot` 是个文件，`path.join(hit, "package.json")`
    也不存在。所以这个 `||` 的左操作数是纯保险。删掉它没有任何用例会红（本批演练里唯一
    一条等价突变），按「等价突变要删掉、不为它硬凑 fixture」的规矩保留原样、记在这里。
    检测办法：`grep -n 'isFile(path.join(hit, "package.json")) || isDir(hit)' lib/core.js`。

101. **`lib/reapply.js` 的十六处 catch 与 `lib/core.js:1908-1933`（web 面 ai-base 兜底）
     在这台机器上构造不出来。**
    前者（`13 14 120 121 127 128 155 156 175 176 189 190 195 196 232 233`）的触发条件是
    「`core.*` 命名空间抛出」，而模块用 `import * as core` 引入 —— 命名空间对象只读，
    属性不可 monkeypatch；磁盘层面的坏法（`existsSync` / `statSync` / `readdirSync` /
    `realpathSync` / `lstatSync` 全换抛错）实测都只让这些函数回 `null` / `false`，不抛。
    唯一能测的是 `:13-14`（`pluginVersion` 自己的 `fs.readFileSync`），已由
    `test-reapply-flows.mjs` 覆盖。
    后者要走到，得让 `findAiBaseFromRunningProcess()` 先落空 —— 它拿 `process.argv[1]`
    向上走，而测试文件在插件仓库里，仓库自身的 `node_modules/@deepseek-ai` 必先命中。
    只有插件仓库不含这棵树时才会往下走，本机造不出来。
    检测办法：`grep -n 'catch' lib/reapply.js | head -20` 与
    `grep -n 'findAiBaseWeb\\|npmQuery' lib/core.js`；真机上若要验，把插件仓库临时移到
    不含 `node_modules/@deepseek-ai` 的目录再跑 `npm run host:status`。

102. **`collapseDuplicateLegacyApplyPath` 在「第二份定义没有闭合」时会把从它到文件末尾整段删掉。**
    `endOfBalancedBlock` 扫不到配对的 `}` 就回 `text.length`，调用方据此把 `cursor` 推到末尾、
    再拼上 `src.slice(cursor)`（空串）。所以一个被截断的 settings 文件（第二份 `legacyApplyPath`
    只写了一半、后面还有别的代码）会被切成「第一份定义 + 一个空行」。
    现状锁定：这种文件本来就是 #42 累积产物造成的语法错，留着 dsh 起不来；真实场景里也不会出现
    「重复定义只写了半份而后面还有重要内容」。要改的话判据是「找不到闭合就别动」（把
    `endOfBalancedBlock` 的返回值与 `text.length` 比较后整段放弃），但那要先有实证说有人在
    settings 被截断时丢过内容。检测办法：
    `grep -n 'return text.length;' lib/core.js`（在 `endOfBalancedBlock` 里）。

103. **`rewriteStaleLegacyApplyCall` 只认字面 `=> legacyApplyPath(section, op)`。**
    参数名不同、箭头前后空格不同（`=>legacyApplyPath(...)`）、或者写法是
    `function f() { return legacyApplyPath(section, op); }` 都换不到。1.1.17 之前 #42 写进去的
    就是这一种形态，所以线上够用；但如果哪天上游改了生成器的排版，这条守卫会静默失效
    （`patchApplied` 也跟着判「已打上」，因为那条判据用的是同一个常量）。
    检测办法：`grep -n 'STALE_LEGACY_APPLY_CALL =' lib/core.js`，再在真宿主 settings 文件里
    `grep -c 'legacyApplyPath'`；两者数目不符就说明形态变了。

104. **`gatherState()` 里 `runtime_payload` 的 `catch` 造不出来。**
    `try { … } catch (e) { runtime_payload = { ok:false, error: String(…), missing: [] } }` 要走到
    catch，必须让 `desktop.findDesktopAppExecutable()` 或 `desktop.inspectRuntimePayload()` 抛错；
    而 `lib/core.js` 用的是 `import * as desktop from "./desktop.js"`，命名空间属性只读
    （`Cannot assign to read only property`），磁盘状态也造不出来（这一段只读不写）。
    判坏的典型表现：桌面装了一个半截的安装包，状态页整块 500 而不是「runtime 缺件」。
    检测办法：`grep -n "runtime_payload = { ok: false, error" lib/core.js` 确认兜底还在；
    真机上把 `resources/runtime` 整个删掉再刷新状态页，应当是 `ok:false` 加 `missing` 名单。

105. **`findWslWindowsDshHome()` 的整段（`lib/core.js:1764-1782`）在本机造不出来。**
    它第一句就是 `if (process.platform !== "linux") return ""`，而伪造成 linux 之后，`/mnt/c/Users`
    在 Windows 上是「当前盘符下的 `\mnt\c\Users`」——要造就得往盘根写 `D:\mnt\c\Users`，那是
    污染整台机器，不做。判坏的典型表现：WSL 里跑 dsh 时找不到 Windows 侧的 `~/.dsh`，配置与
    会话全丢。检测办法：在真 WSL 里跑 `node -e 'import("./lib/core.js").then(m=>console.log(m.findWslWindowsDshHome()))'`，
    应当打印 `/mnt/c/Users/<你>/.dsh`。

106. **`HAS_FTS5` 的探测 `catch`（`lib/redteam/schema.js:46-47`）在本机走不到。**
    它是模块顶层常量，`try { new DatabaseSync(":memory:").exec("CREATE VIRTUAL TABLE … USING fts5") }
    catch { HAS_FTS5 = false }`。本机的 Node 24 内置 SQLite 带 FTS5，构造永远成功；而 `REDTEAM_NO_FTS5=1`
    在更前面的 `:36` 就早退成 `false` 了，走的是另一条路。要真走到这个 `catch`，得换一个不带
    FTS5 的 Node 构建（发行版编译开关），这台机器上造不出来。判坏的典型表现：降级判定靠 env 而
    不靠能力探测时，用户没设 `REDTEAM_NO_FTS5` 但引擎不支持 FTS5，建表直接抛、整个演练台起不来。
    检测办法：`grep -n "REDTEAM_NO_FTS5" lib/redteam/schema.js` 确认 env 早退仍在 `try` 之前；
    再 `node -e 'new (require("node:sqlite").DatabaseSync)(":memory:").exec("CREATE VIRTUAL TABLE t USING fts5(x)")'`
    在本机应当成功（说明本机走的是能力探测成功那一支）。

107. **`configSet` 的「两种写法都失败」只能靠只读访问器造，跨平台行为一致但错误码不同。**
    `set()` 抛错且 `set value()` 抛错的节点是纯 JS 对象，本机能造；但真实宿主里更常见的是
    `Object.freeze()` 过的配置节点 —— 那种情况下 `node.value = v` 在**严格模式**（ESM 默认）抛
    `TypeError: Cannot assign to read only property`，非严格模式下静默失败并让 `configSet` 误报
    `true`。本仓库是 ESM，所以永远走严格模式，这条差异在本机无法验证；如果以后有人把
    `lib/preset-default.js` 改成 CJS 或包一层非严格函数，这条用例就失去意义。
    检测办法：`grep -n '"type"' package.json` 确认仍是 `module`；`grep -n 'node.value = value' lib/preset-default.js`
    确认赋值仍在 `try` 里。

108. **`maxFailStreak` 的「连续失败 3 次永久停手」只在 tracker 单测里钉过，钩子链路没跑。**
    `maybeAutoContinue` 只有在 `takeContinue` 返回 true 时才发消息，`failStreak` 到达
    `cfg.continueMax`（默认 3）之后 `takeContinue` 恒 false。要在这条链路上端到端验证，需要
    连续三次 `followup` 抛错 + 三次不同的 `turn/end` seq，本机能跑（每条 350ms 定时器），但
    那会让这个文件再慢 1 秒；目前的锚点是 tracker 层的 3 条用例（`#85`）加这里的一条
    「同一 seq 不重复」。改坏的表现是「三次失败之后插件还在每轮补一句」。
    检测办法：`grep -n "maxFailStreak" lib/continue-retry.js` 确认 `takeContinue` 里仍在判
    `(cur.failStreak || 0) >= maxFailStreak`。

109. **`installMnemonMessageStrip` 的 1500ms 迟到重试只在「一直挂不上」的路径上验证过。**
    真实世界里更常见的形态是「第一次挂不上、1500ms 后宿主就绪、第二次挂上」，也就是
    `retryTimer` 触发的那次 `late()` 成功。这条路径要等 1500ms 真实时间（用例会慢一倍），
    而且成功之后 `mounted` 变 true，与「一开始就成功」在外部几乎同形（差别只有一次
    `ctx.on` 调用与 `retryTimer` 是否已被清）。目前钉的是「不清理就会多试一次」这个反向证据。
    改坏的表现是「热重载之后 pre-step 瀑布上叠了两层过滤」。
    检测办法：`grep -n "let mounted = false" lib/inject-write.js` 确认闸门仍在；真机上连续
    热重载 3 次后用 `grep -c "\[mnemon\]"` 看日志有没有重复。

110. **`detectKali` 的「标记目录」兜底（`/usr/share/kali-menu` 等五条）只能靠源码形状钉。**
    本机是 Windows，`asPlatform("linux")` 之后这些绝对路径仍然不存在，只能把 `existsSync`
    换掉 —— 但那会让同一次调用里其他 `existsSync` 一起变，测出来的东西说不清。
    真跑得通的只有 `/etc/os-release` 那一条。改坏的表现是「Kali 上工具已经能用却提示需要配置」，
    检测办法：在有 `kali-menu` 的机器上跑 `node -e "import('./lib/redteam/platform-config.js')
    .then(m=>console.log(m.detectKali()))"`，`source` 应该是 `markers`。

111. **`score-report.js` 还剩 7 行没覆盖：`:446-448`（真实 curl 作为本条动作的分支）与 `:698-700` `:708`（同阶段同时间的稳定排序）。**
    `:446-448` 要求「得分点的动作模板是 curl 且这条命中不是靠隧道成立」，而当前的 25 条规则里
    动作模板本身就带完整命令的得分点不多，用真数据凑到这个组合要连着改得分点模板 + 隧道的
    `entry_kind`，改完还得解释"为什么这条命中不算隧道成立" —— 收益不如直接读判据。
    `:698-700` 是 `stepSeqOf` 的兜底（同一阶段、同一 `order_at`、两条都有 `steps.seq` 时按最小 seq 排），
    要构造它得把两条命中的 `order_at` 手工改成同一字符串，再给它们挂不同 seq 的步骤；
    本机可做，本批没做（留作下一批候选）。
    检测办法：`node --test --experimental-test-coverage --test-reporter=lcov
    --test-reporter-destination=.tmp-x.info scripts/test-score-report.mjs` 后
    `awk '/SF:.*score-report\.js/{f=1} f&&/^DA:/{split(substr($0,4),a,","); if(a[2]=="0") print a[1]}'`。

112. **`lib/status-render.js:15-16` 的 `fsExists` catch 不可达。** Node 的 `existsSync` 对任何输入都只回
     true/false，连 NUL 字节路径也只回 false，不抛错。探针实测确认（`existsSync('a\0b')` === false），
     于是那条 `catch { return false }` 是纯防御。改坏也看不出差别，因为上游永远拿不到抛错。
113. **`lib/hide-console.js:95-97` 的 `createRequire` 兜底 return null 不可达。** `createRequire('node:child_process')`
     不会抛，且返回的模块必带 `spawn`；要让它抛错得先让 Node 自己的内建模块解析失败。
114. **`lib/routes.js:618`（`POST /dsh-purge/own-servers` 的成功回包）不可达。** 它依赖 `lib/net-scope.js` 的
     `writeAllowText`，而后者是**上游空壳**：函数体引用了未声明的变量，一调用就 ReferenceError，
     这个 POST 恒回 500。`routes.js` 是静态 `import`，没有注入点，所以成功分支在本仓库永远走不到。
     不该为了覆盖率去修上游的空壳（见第十节第 3 条的 FTS5 同款判断）。
115. **`lib/chat-rules-skills.js:113-114` 的 catch 不可达。** `resetToOriginal` 内部逐段 try/catch 之后继续，
     对外不抛；给它一个 ENOTDIR 的家目录，返回的仍是「逐段失败」而不是异常，所以外层 catch 是防御性分支。
116. **`lib/redteam/schema.js:45-47` 的 `HAS_FTS5` catch 不可达。** 它是模块顶层 IIFE：`REDTEAM_NO_FTS5=1`
     先短路返回 false，否则真建一张 `fts5` 虚表；要走到 catch 得让 `DatabaseSync` 或 `exec` 抛错，
     而进程内没有注入点（`node:sqlite` 是内建模块）。降级路径本身已由 `test-fts-fallback.mjs` 用
     `REDTEAM_NO_FTS5=1` 的子进程钉住，**这条 catch 只是最后的兜底**。
117. **`lib/host.js:19` `:23`（`scheduleRestart` / `scheduleCleanupRestart` 的转发）不可调用。** 它们直接
     调 `web.scheduleRestart`，后者 spawn 一个 detached helper 然后 `setTimeout(() => process.exit(0), 250)` ——
     在测试进程里调用等于把测试杀掉。已由 `test-host-restart.mjs` 的注释与本条共同记录。
118. **`lib/identity.js:1090-1099`（`rewritePromptAssembly` 的「注入没进任何 section 时补一份置顶」）不可达。**
     探针按三种形态试过（普通 / redteam / `capabilityProtocol:false`）+ 三种注入长度（313 / 5000 / 20000B），
     `outSections` 里始终能找到 `injectText` 的前 80 字符 —— `leadWithInject` 一定先把它塞进 `dsh-purge` 段，
     `overlayOfficialIdentity` 也不会丢它。保留代码是对的（防 overlay 未来改行为），但别指望用例能覆盖。

119. **`lib/identity.js:852-857`（`withOwnServers` 的正文）不可达，根因在 `lib/net-scope.js`。**
     `ownServerNote()` 与 `writeAllowText()` 一样是**上游空壳**：`ownServerNote` 恒返回 `""`，
     于是 `if (!note) return text` 每次都命中，下面拼 `OWN SERVERS — EXACT LIST ONLY` 的三行永远走不到。
     与第十节第 114 条（`routes.js:618`）是同一个根因，一并记在这里：**本仓库不替上游补功能**，
     真要修得先确认宿主那侧是否已经实现；宿主一旦实现，这两处会自动变成死代码再变活，届时补测。
120. **`lib/redteam/tool-specs-recon.js:171-204`（宿主没有 skills 服务且仓库没有随包技能时的回退）在本机不可达。**
     条件是 `skills` 未注入 **且** `bundledSkillSummaries()` 为空；后者扫的是仓库里的
     `skills/redteam`（经 `lib/redteam/skill-availability.js:111` 的两个候选 home），本仓库始终非空。
     它只在「打包成桌面壳、把 skills 目录漏掉」的发行物里才会走到 —— 换句话说，这段代码的正确性只能靠
     读，靠到真机上跑一次 `redteam_preflight` 才验证得到。改坏的表现是：桌面端第一次预检直接报废，
     而不是回一句「已跳过技能正文体检」。
121. **`lib/identity.js:375-376`（`injectMatchers` 里 `new RegExp` 的 catch）不可达。**
     构造正则前已经把 `.*+?^${}()|[]\\` 全部转义、把连续空白换成 `\\s+`，再限定在 4096 字符以内，
     拼出来的 pattern 不会抛 `SyntaxError`。（`:377` 之后的 `loose = null` 是有意义的兜底，
     但触发不了；真正要防的是「整段 prompt-inject 做 loose 匹配」把 V8 的源码长度上限打爆，
     那一层已经由 `INJECT_LOOSE_REGEXP_MAX` 挡在构造之前。）

122. **`lib/uninstall.js` 里剩下的 18 行全是「失败只记一笔、继续往下走」的 catch，不建议硬凑。**
     逐条看过可达性：`:129-130` `rmIfExists`（`fsp.rm({recursive:true,force:true})` 只有在删到被占用的句柄或只读目录这类
     Windows 独占状态时才抛，测试里造得出来但造出来靠的是抢句柄，CI 上是 POSIX，跑不出同一套行为）；
     `:176-177` `realpathSync` 兜底（`existsSync(nm)` 为真时 `realpathSync` 只在 ACL 拒绝时才抛）；
     `:239-240/255-256/262-263/274-275/282-283` 是 `revertAll` / `revertAllShims` / `revertCmdFlash` /
     `removeOverride` / `resetRules` / `clearOwnedSelectedDefault` 六处抛错兜底 —— `core` 是静态 import，
     没有注入点，只能靠真让宿主树进入坏状态（例如 bak 文件被换成目录）才进得去；
     `:252-253` `shim.reverted` 标记要求 `state.shim_*` 是 `patched` **且** `revertAllShims` 成功返回，
     现有夹具能造前半段，后半段要真改 `$DSH_HOME` 外的东西。
     **结论**：这 18 行不作为待补项；真要补，先在 `uninstall.js` 里把 `core` 变成可注入参数（那是一次结构改动，不是补测试）。
123. **`lib/index.js:140-142` 可达但外部不可观测。** `watchWebTreeReady` 在 `typeof ctx?.inject !== "function"` 时
     先 `mark()`（`webState.ready = true`）再 return；紧接着的 `installWebServer` 自己会 `ctx.inject([...])` 抛
     `TypeError`。也就是说这条路径的产出是「`/status` 说就绪 + apply 抛错」，`webState` 是模块私有的，
     测试唯一能断言的是「抛的是 `ctx.inject is not a function`」，对可维护性没有信息量，写出来就是凑数。
     `:229-230`（seed 抛错只 warn）与 `:271-275`（settle 拒绝且错误属于 inactive-context）同理：
     两者都要求 `core.seedPromptInjectAtBoot` / `bootSettle.settleInstalledPatches` 抛特定错误，
     而这两个都是模块级静态装配，没有注入点。
124. **`lib/redteam/tools.js:131` 是 `loadDefineTool` 里 `import` 失败的那一支**，本机永远走不到（宿主一定装了
     `@deepseek-ai/dsh-tools`）；CI 上也只在宿主包被裁掉的发行物里才可达。`scripts/test-define-tool-resolve.mjs`
     已经把「返回函数」和「候选全坏时抛 cannot resolve」两侧都钉住了，这 1 行按盲区记账即可。

## 反查：改一个文件，谁会响

```bash
npm run impact -- lib/skills.js          # 单文件
npm run impact -- lib/skills.js lib/uninstall.js
npm run impact -- --all                  # 全量清单
```

输出四段：① **直接 import 它的测试**（改了必跑）② **经共享 lib 间接覆盖的测试**（例如 `scripts/behavior-lib.mjs` 中转）
③ **能力地图里相关的记账行**（来自本文件表格）④ **lcov 里当前未覆盖的行**（需先跑 `npm run test:full`）。

用途：宿主升级后先在目标文件上跑一遍，就知道「这处行为归哪几个测试守、哪些分支本来就没人守」，
不用靠 grep 猜。它只读，不改任何状态。

## 补丁影响矩阵：哪条补丁坏了，谁替它作证

```bash
npm run impact:patches
npm run impact:patches -- --rehearsal .tmp-rehearse/rc3.json   # 带上预演判定列
```

输出 `docs/patch-impact.md`：86 条补丁各一行，列出宿主文件与其 `rel`、基线状态（`settled`/`no-file`/…）、
**行为**（`scripts/patch-behaviors.mjs` 的 `covers` 里是否有它）、**闸表**（`docs/patch-gates.json` 是否有观测行）、
**预演**（`host:rehearse --json` 落盘的判定；没给 `--rehearsal` 时整列为 `—`）。

行为断言覆盖 18/86（2026-11-15 新增 6 条：pruner、session-log 默认值、renderPrompt 兜底、fs 观察闸、repeat-reminder 接线、fs 沙箱 checkedTarget）；提示词层与 yml 默认值类补丁不可由模块导出观测，只能靠闸针+标记。

最近一次 rc.3 预演的证据与当天待办见 [rehearsal-0.2.2-rc.3.md](rehearsal-0.2.2-rc.3.md)。

怎么用：升级后先看「预演」列（`stale`/`drifted` 要改锚点、`native` 可退场）；「行为」列空的补丁只有文件标记作证，
改它的代码前先补一条 `patch-behaviors` 场景，比为它刷行覆盖率更值。改补丁代码前先 `npm run impact -- lib/patches/index.mjs`。

## 维护约定

- 补一行时，`守卫` 列必须写**能跑的东西**（脚本名或 npm 命令），不要写「已测试」。
- 覆盖率列用 `npm run test:full` 的实测值，别抄上次的。
- 从 `❗缺` 里挑活时，优先挑「改坏了没人能发现且用户能感知」的：第三节（提示词注入）与第四节的 HTTP 路由，排在计分口径前面——因为前者影响每一轮对话，后者只在打开演练台时影响。
