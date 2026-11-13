# 拦截面定位、五态判定与补丁行为对拍

## 要解决的问题

宿主每升一版都会长出新东西：新的拒绝分支、新的参数校验、新的服务 seam，也可能悄悄删掉旧的。补丁数量只会上涨，所以真正的问题不是「再加一条」，而是三件事：

1. 新宿主上**哪里**需要新补丁，哪些旧补丁已经不必再打；
2. 打过的补丁**还有没有效**（限制是否真的解除）；
3. 从零**造一条新补丁**时，怎么证明它成立。

旧办法只有一条判据：补丁写进文件的 marker 还在不在。marker 在 ≠ 限制解除——把 `throw` 留着、只加一行注释，marker 照样在。旧办法还有第二个坑：marker 可能本来就是官方原文，干净宿主上会假报「已应用」。

本目录的三个命令就是为这三件事建的。它们共同的前提是：**手边要有一棵未打补丁的同版本宿主树**。

## 独立基线：为什么不用 .bak

`.dshpurge.bak` 只在补丁真正写入时才生成，且记录的是「写入前那一瞬」。漂移过的补丁、从没写入成功的补丁、包搬迁后换了文件的补丁，都没有可用的 `.bak`；而它也不覆盖整个宿主，只有补丁目标文件。

正确做法是装一棵干净树当基线：

```
node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" install --no-save --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh@0.2.2-rc.1
```

装到 `.tmp-tree/rcN/`（已在 `.gitignore`）。得到的 `node_modules/@deepseek-ai` 就是「同版本、零补丁」的对照树。它的用途有两个：

- 和真宿主逐文件比对，判断一条补丁是「打了」还是「本来就这样」；
- 判断锚点是不是已经死了（宿主把这段代码删了 = 该退役；宿主只是换了措辞 = 要改锚点）。

## 命令一：`npm run host:snapshot`

宿主树快照。不看补丁，只看宿主本身。

```
npm run host:snapshot                      # 写 docs/host-tree.json
npm run host:snapshot -- --pristine       # 树上有 [dsh-purge] 痕迹则退出码 3
npm run host:snapshot -- --diff a.json b.json
```

快照按包记 `dsh-*` 下每个文件的字节数与 sha256，外加宿主版本号。`--diff` 比较两份快照，输出包增删、版本变化、文件增删改，并给出 `ok / changed / unreliable` 三态——`unreliable` 表示快照里混进了注入痕迹，不能当基线用。

实测：宿主 0.2.2-rc.1，320 个包 / 5728 个文件 / 83.19MB，957ms。

## 命令二：`npm run host:choke`

拦截面扫描。回答「哪里可能有闸门，其中哪些真的会执行」。

关键词扫描在这个规模上等于没扫：全树搜 `deny|approval|sandbox|escalat|policy` 会命中上千个文件，因为 `reject` 出现在 README、类型定义、错误消息里到处都是。这里改成按**调用形状**扫，并按角色三档分流：

- `restriction`（真闸门）：`ctx.approval.*`、`ctx.sandboxPolicy.*`、`ctx.sandbox.confine`、`static inject` 声明这些服务、拒绝类 `throw`、升级调用；
- `signal`（路标）：模式字面量、错误码词汇表——只说明「这附近可能有闸门」，本身不拦人；
- `target`（附着点）：提示词段落、工具注册——是补丁挂载的位置，不是闸门。

扫完之后不是直接给人看，而是先做四道过滤，剩下的才叫人眼审：

1. **求交 `--dump-config`**：`node <aiBase>/dsh/lib/bin.js --profile web --dump-config` 是宿主自己给出的「实际加载哪些插件」清单，比猜包名可靠。不在清单里的包、被 `disabled` 的条目直接排除。
2. **去内联重复**：打包器会把 `lib/types/*.js` 内联进 `lib/index.js` 并留 `//#region lib/types/xxx.js` 标记，同一段代码在树上两份。按 region 标记剔除副本，否则每条命中数翻倍。
3. **上下游短路**：`if (mode === "danger-full-access") return ...` 这类满权早返回守卫，会让下游那一堆 `confine` / `SandboxUnavailableError` 一行都执行不到。上游 `dsh-sandbox-policy` 的模式一旦是满权，下游补丁就是僵尸补丁。
4. **已覆盖**：目标表来自 `core.targetFiles(aiBase)`（apply 时真正写的那张表），不手抄包名。

输出分三段：`!` 真缺口 / `~` 路标 / `·` 附着点，末尾一行聚合所有排除理由与条数。退出码 1 = 有真缺口。

实测（真宿主 rc.1）：`!` 0 组，`~` 4 组，`·` 9 组；排除 42 组未加载 / 26 组 disabled / 22 组已覆盖 / 11 组包内满权早返回 / 2 组上游已覆盖。**结论：这一版没有未覆盖的拦点。** 这是本项目第一次把「哪里需要新补丁」压到人眼能判断的量级。

两版对比用 `--write-baseline` 存形状计数（只存 `(形状, 包) → 条数`，不存行号——行号每次升级都变，存了会制造伪差异），下次带 `--baseline` 跑就给出「新增 / 变多 / 消失」。

## 命令三：`npm run host:outcome`

补丁结果五态。回答「这条补丁现在算什么状态」。

```
npm run host:outcome -- --baseline-tree .tmp-tree/rc1/node_modules/@deepseek-ai
```

判据全部来自可核对的事实：pattern 是否还命中当前文本、本插件痕迹 `[dsh-purge]` 是否出现、当前文件与纯净基线是否一致、marker 在纯净基线里是否已经成立。

| 态 | 含义 |
| --- | --- |
| `applied` | pattern 不再命中，且有本插件痕迹：打上了，且达成 |
| `pending` | pattern 仍命中：还有活要干 |
| `native` | marker 在纯净基线里就成立：宿主原生符合目标态，本来不需要打 |
| `stale` | 锚点与产物双双失踪，且基线里锚点也不在：这条对这一版失效，该退役或改锚点 |
| `drifted` | 当前 pattern 不命中但**基线里还命中**：宿主还留着这段，是我的锚点过期了 |
| `na` | 两棵树里都没有这个文件（桌面壳 `lib/main.js` 在 npm 包树外等） |
| `unknown` | 只在宿主缺、基线有：缺信息，不下结论 |

`stale` 与 `drifted` 的区分是这套判定的核心：前者是「宿主把这段删了」，后者是「宿主换了措辞」。前者退役，后者改锚点。

### 四条不变量

1. **纯净树自比必须全是 `pending` / `native` / `na`**，绝不允许出现 `applied`。旧判定（`core.patchStatus`）在干净树上假报 5 条 applied，因为 #2/#3 的 marker 就是官方原文常量（`OFFICIAL_REPLACEMENT_BODY` / `OFFICIAL_SCOPE`），而这两条要做的恰恰是「把强句改回官方原文」——目标态 == 原生态。
2. **任何「已应用」的证据都必须在基线里不存在**。只判「产物在不在」会在干净树上把官方原文当成自己的产物。
3. **多文件补丁不被单个软文件拖成 `stale`**。`softFiles` 是包搬迁后的历史落点，`na`/`stale` 的软文件不参与 rollup，`applied` 优先于 `stale`。
4. **撤销型补丁（`skipIfMarked` / `deleteOnly` / `softSettle` / `after[]` / 锚点自带 `[dsh-purge]`）在干净树上不存在锚点是预期结果**，判 `na` 而不是 `stale`，否则退役清单会被插件自己的清理动作塞满。

### 实测

```
纯净树自比 (rc1 vs rc1)   applied 0  pending 65  native 3  stale 1  na 17  drifted 0  unknown 0
真宿主 vs rc1 基线        applied 67 pending 0   native 3  stale 0  na 16  drifted 0  unknown 0
旧 core.patchStatus(真宿主)  applied 71  na 13  missing_file 1  skipped 1
旧 core.patchStatus(纯净树)  pending 66 applied 5  ← 5 条假 applied
```

纯净树上剩的那 1 条 `stale` 是 #12 `APPROVAL_ASK_SENTENCE_BYPASS`：上游把 `Approval policy: ask. Operations that require approval may ask...` 整句改写成 `Approval prompts are enabled in this session: ...`，锚点已死，判定正确——这条需要改锚点，不是判定出 bug。

## 行为对拍（npm run test:behavior）

五态判定回答的是「补丁还在不在文件里」，回答不了「限制是不是真的解除了」。marker 在 ≠ 行为变了：有人只补了 marker、没删掉那个 throw，五态照样报 applied。行为对拍补上这一层。

做法是同一份代码的两个版本、同一组输入、断言结果必须不同：

```
.tmp-tree/rc1/node_modules/@deepseek-ai          纯净上游树（npm 装，基线）
宿主 <resources>/app/dsh/node_modules/@deepseek-ai   已打补丁
        ↓ 各自 import 同一个模块，调同一个导出函数
     原版拦 / 补丁版放  → ok
```

判据收在 scripts/behavior-lib.mjs 的五态里：

| 态 | 含义 | 意味着什么 |
| --- | --- | --- |
| `ok` | 原版拦、补丁版放 | 这条补丁有行为证据 |
| `broken` | 原版拦、补丁版仍拦 | 补丁失效，或被上游闸门绕过 |
| `already` | 原版就不拦 | 这条该退役了（对应五态的 `stale`） |
| `inert` | 观测点在一侧不可达 | 补丁改了导出面 / 函数被删，得人工看 |
| `unexpected` | 两侧都没命中声明值 | 观测配方过期 |

观测值只记 `{kind: value|throw, value|error: 类名}`，**绝不比对错误消息正文**——消息随上游漂移（#12 就是这么坏的），拿它当断言等于把易碎品钉进 CI。

### 实测（真宿主 vs rc1 基线）

```
15 behaviours, ok=15 broken=0 already=0 inert=0 unexpected=0
covers 12/86 patch id(s): 9,10,13,14,22,23,34,35,36,38,42,51
no behaviour assertion yet: 74 patch(es)
```

自证实验（这套东西不能永远绿）：把 `--ai-base` 指到基线树本身，两侧同源 → `ok=2 broken=13`，只剩两条 `control` 通过。`control` 断言的是「两棵树在这里本来就应该一致」（`WIDER_MODES`、`SANDBOX_MODES` 这类词汇表），`covers` 必须为空——它证明观测手段没瞎，不是补丁证据。

三个出口证据：

- #13 / #14 / #35 三条叠在同一个 `approveEscalation` 上，一次 `rejected` 调用从 THROW 变 RET `danger-full-access`。
- #9 的 `ApprovalService.prototype.decide` 用假 this（`{effectivePolicy:()=>'ask', ctx:{waterfall:()=>'unavailable'}}`）就能调：rc1 返 `unavailable`，宿主返 `allowed-once`。
- #10 的 `Config({})` 从 `{policy:'ask'}` 变 `{policy:'never'}`。

### 为什么只覆盖 12/86

能轻量对拍的只有两类：可 await 调用的 Config schema、纯函数与类原型。只导出 `apply`/`inject`/`name` 的插件（dsh-skill-badge、dsh-harness-dev-context、dsh-sandbox-local）需要真 cordis ctx；提示词类补丁的「行为」是最终 prompt 文本，得先起一个 SystemPrompt 实例。这 74 条不是不做，是还没找到便宜的观测点——`--json` 输出里逐条列着 `uncovered`，下一步按收益排。
## 命令四：`npm run host:matrix` 与 `npm run host:gates`（锚点矩阵与闸门侧表）

矩阵回答「补丁自己的 pattern 还命中吗」。这个问题有盲点：#12 的 pattern 引用了一整句，上游把两端都改写了，pattern 死了而限制还在——只看矩阵就会把一条仍需要的补丁退役。

闸门（gate）是第二意见：短、限在一行内、从定位到的文本长出来，宽度只到唯一性所需。它对重新缩进、重排、邻近编辑免疫，因为不带前后文。

七档判定（`scripts/patch-matrix-lib.mjs` 的 `verdictOf`，顺序即决策）：

| 档 | 含义 | 该做什么 |
| --- | --- | --- |
| `trace` | 锚点本身就是本插件写进去的痕迹 | 不是对上游的判断，跳过 |
| `native` | 目标态已经是官方原文（#2/#3） | 无需补丁 |
| `retraction` | 撤销型（`skipIfMarked`/`deleteOnly`/`softSettle`/`after`） | 找的是自己的痕迹 |
| `blind` | 树里没有这个文件（桌面壳、包搬迁） | 说不了话，别当死 |
| `live` | 锚点命中 | 正常 |
| `stale` | 锚点死了但闸门还在 | **改锚点**，不是退役 |
| `dead` | 闸门也不在 | 先读再退役 |

`host:matrix` 打七档分布 + dead/stale 清单（带锚点文本）；`host:gates` 打 86 个闸门、`--write docs/patch-gates.json` 落盘侧表、`--compare` 对比两棵树看闸门是否漂移。

实测（rc.1 纯净树 `.tmp-tree/rc1/node_modules/@deepseek-ai`）：

```
host:matrix  live 39 / stale 1 / dead 0 / native 3 / retraction 27 / trace 11 / blind 5
host:gates   gated 58 / no-target 14 / trace-anchored 12 / native 2
```

唯一 `stale` 是 #12 `APPROVAL_ASK_SENTENCE_BYPASS`，`dead` 为 0——rc.1 上没有「限制真被删掉」的补丁。这就是「哪些旧补丁不用打了」的答案：现在一条都不用退役，只有一条要改锚点。

### 写侧表时不能做的两件事（都是踩过的）

1. **前缀阶梯**：想让闸门在换行重排后仍能定位，按 120/80/60/… 逐级截断前缀去 `indexOf`。实测 #2 的 pattern 指名 `REPLACEMENT_WORKSPACE_CONTEXT_INTRO`，上游改名为 `REPLACEMENT_AGENT_INSTRUCTIONS_INTRO`，前缀命中了**改名后的相邻常量**，闸门被挂在错误的常量上，永远报「限制还在」。已删除。
2. **正则字面回退**：`exec` 不匹配时取最长字面串再定位，同一个病。已删除，`exec` 不匹配一律返回 `null`，交给手写闸门表。

一句话：**定位失败是信息，编造的命中是不会过期的谎。**

## 命令五：`npm run host:new-patch`（从一行文本长出一条补丁草稿）

补丁是两件事：一个必须逐字节命中的锚点，和一句「应该变成什么」。只有前者能从树里算出来——而它就应该被算出来，因为手写锚点会两头失败：太短命中三处，太长下次上游重排就死。

```bash
npm run host:new-patch -- --list-targets                       # 键 -> 相对路径对照表
npm run host:new-patch -- --pkg dsh-sandbox --line 151          # 按行号
npm run host:new-patch -- --pkg dsh-sandbox --needle 'switch (outcome) {'
npm run host:new-patch -- --patch 12 --json                     # 改已有补丁的锚点
```

输出：定位到的行、行内最短且唯一的锚点（长度与 slack）、该文件对应的注册表键名、一条填好的草稿条目（`replace` 与 `desc` 留 `TODO:`，绝不编造改写内容）、以及后续五步。

`--patch` 的回退链是「补丁自己的 pattern → gate needle」：pattern 已死时（#12 的情形）仍能靠闸门找回该行，这正是改锚点的起点。

**不唯一就不产草稿**：跨行才唯一（两行完全重复）或行内有多处时，脚本打印原因并退出 1。放它过去，等于让人把一条会编辑三处的 pattern 粘进注册表。

## CI 里查什么：`npm run check:gates`

`host:gates` 需要一棵宿主树，CI 上没有。所以 CI 查的不是「限制还在不在」，而是**侧表和注册表有没有走散**——表会悄悄腐烂的地方恰好全在这里：

```
[gates] 86 rows for 86 patches, 58 gated
[gates]   gated 58 / no-target 14 / trace-anchored 12 / native 2
[gates] PASS
[gates] not checked here: whether a gate still exists in the current upstream …
```

六条断言：

| 情形 | 为什么算失败 |
| --- | --- |
| 注册表有条目、侧表没行 | 新补丁没留闸门，等下次升级才知道它靠哪句话定位 |
| 侧表有行、注册表没条目 | 补丁删了，表还留着，读者会去找一个不存在的东西 |
| 名字不一致 | 按旧名 grep 会找错行 |
| needle 跨行 | 下次重排必死，而重排正是升级干的第二件事 |
| needle 是绝对路径 | 表和机器绑死，换台机器就废 |
| reason 不在词表 / 既无 needle 也无 reason | 记了一条什么也没记录的行 |

最后永远打印一行 `not checked here`——它把「这里没查」说清楚，免得一条绿色 PASS 被读成「限制都还在」。真正的闸门存在性只有 `npm run host:gates -- --compare`（两棵树对 needle）与 `npm run host:matrix`（七档判定）能回答。

`npm run check` 已包含它，而且因为不需要宿主树，裸跑在 ubuntu-latest 上也成立。
## 已知盲区

- `--dump-config` 只描述 profile 配置层加载的插件。运行时动态注册、或由用户 profile 另行 `cordis.patch.yml` 加进来的，扫不到。
- 形状扫描是正则级的，认的是调用写法。宿主换一套 API（比如把 `ctx.approval.request` 换成事件总线）就得补形状，否则会静默漏掉。
- 五态判定依赖基线树。没有基线树时 `native` / `stale` / `drifted` 都无从区分，脚本返回 `unknown` 而不是猜。
- 行为对拍只覆盖能 import 的 12 条。剩余 74 条（提示词改写、需要真 ctx 的插件、桌面壳）目前仍只有文本级证据。
- `check:gates` 只查表的自洽，不查闸门是否真的还在上游——那需要宿主树。表写对而 needle 已被上游改写的情况，CI 是绿的。
- 行为观测点写死在 scripts/patch-behaviors.mjs 里。上游一旦重命名导出函数，这条会掉成 `inert` 而不是 `broken`——`inert` 是「要看一眼」，不是「没事」。

## 相关设计

- [`docs/maintenance-host-baseline.md`](maintenance-host-baseline.md)：宿主适配基线（`host:status` / `host:capture` / `host:preview`）
- [`docs/maintenance-verification.md`](maintenance-verification.md)：统一验证与 CI
- [`docs/test-map.md`](test-map.md)：测试地图，第十节为盲区清单
