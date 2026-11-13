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

## 已知盲区

- `--dump-config` 只描述 profile 配置层加载的插件。运行时动态注册、或由用户 profile 另行 `cordis.patch.yml` 加进来的，扫不到。
- 形状扫描是正则级的，认的是调用写法。宿主换一套 API（比如把 `ctx.approval.request` 换成事件总线）就得补形状，否则会静默漏掉。
- 五态判定依赖基线树。没有基线树时 `native` / `stale` / `drifted` 都无从区分，脚本返回 `unknown` 而不是猜。
- 行为证据（真的会放行 / 真的会拦）不在本阶段范围内，见后续行为对拍阶段。

## 相关设计

- [`docs/maintenance-host-baseline.md`](maintenance-host-baseline.md)：宿主适配基线（`host:status` / `host:capture` / `host:preview`）
- [`docs/maintenance-verification.md`](maintenance-verification.md)：统一验证与 CI
- [`docs/test-map.md`](test-map.md)：测试地图，第十节为盲区清单
