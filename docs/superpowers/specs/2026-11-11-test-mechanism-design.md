# 测试机制设计（B+C：node --test 骨架 + 宿主契约）

- 日期：2026-11-11
- 基线提交：`df2d972`
- 状态：待批准（批准后才写产品代码）
- 上游目标（用户）：可维护性五维里的「可测试 + 可观测」——不只是改代码时知道哪里坏了，宿主迭代时也要能立刻知道哪里坏了。

## 1. 现状实测（全部在本机跑过，数字是真的）

| 事实 | 实测值 |
| --- | --- |
| 回归测试 | 12 个 `scripts/test-*.mjs`，`run-tests.mjs` 逐个 `spawnSync` |
| 失败粒度 | 一个文件只有一个退出码。`test-runtime-heal.mjs` 94 行里几十条断言，坏一条只看到一行 FAIL + 堆栈 |
| 全量耗时 | 约 43 秒，其中 `test-update-source.mjs` 占 9.95 秒 |
| 该测试慢的原因 | `checkUpdate()` 自己耗 14502 ms —— 它先跑完 `listRemoteVersions()` 的四个网络端点超时才走到断言 |
| 行覆盖率（全仓） | 33.28%，但含 `docs/origin/` 历史快照与 `scripts/` 自身，数字被稀释 |
| `lib/index.js` | 行覆盖率 **0%**（没有任何测试 import 过它），而它承载 18 个配置键、4 条聊天命令、3 个模型工具、13 条 HTTP 路由 |
| `host:status` 的盲区 | 只比 86 条补丁状态 + 59 个目标文件 sha256。宿主把 `ctx.webServer.register` 改名，它照样 `verdict=ok` |

结论：现在的测试只能回答「我改坏补丁了吗」，不能回答「宿主变了我们还活不活」。

## 2. 目标

1. 失败可定位到**子用例名字**，不是「某个 94 行文件红了」。
2. 默认测试**离线、10 秒内**跑完；需要宿主/网络的放 `test:full`。
3. 覆盖率会**跌破基线才红**，涨上去自动成为新基线。
4. 宿主契约（服务名、事件名、成员方法、模块导出）有**独立校验**，能区分「包没了 / 成员改名了 / 搬家了」。
5. 有一张能力地图，说明「这条能力靠哪个测试守着」，没守着的明写「无」。

## 3. 非目标

- 不追求覆盖率数字好看，不设人为阈值（把阈值定在 17% 等于宣布 `core.js` 烂着也算合格）。
- 不重写现有 12 个测试的断言语义，只换壳（`node:test` 包装）与拆分子用例。
- 不在本阶段拆分巨型文件（`store-core.js` / `index.js` / `desktop.js` 暂缓）。
- 不引入任何第三方依赖（`node:test`、`node:assert` 都是内置）。

## 4. 关键设计决策与实测依据

### D1 用 `node --test` 做骨架，不自己写 runner

已实测可行：

- 现有脚本**不改一行**就能被 `node --test` 跑（`test-bom-guard.mjs` → `ℹ pass 1`）。
- 失败能传播（追加 `process.exit(3)` → `ℹ fail 1`）。
- 自动发现：`node --test` 无参数即找到全部 12 个。
- 子用例粒度：`node:test` 的 `test()` 默认输出 `✔ / ✖` 逐条，失败块给出文件:行:列 + 断言 diff。

**不要加 `--test-concurrency=4`**：实测反而从 1.66 s 掉到 9.09 s（Windows 进程启动开销 + 竞争）。

### D2 覆盖率基线用 lcov，不用百分比阈值

- `--test-reporter=lcov --test-reporter-destination=<仓库相对路径>` 可用，输出含 `LH/LF`（行）、`FNH/FNF`（函数）、`BRH/BRF`（分支）六项计数。
- **两次连续跑结果完全一致**：48 个文件、逐文件 `LH/LF` 差异 0。→ 可以精确比对，不需要容差。
- 必须 `--test-coverage-exclude="docs/**"`：lcov 里 `docs/origin/core-split-baseline-8066985/` 占 13 个 SF 条目，不排除会把基线稀释。
- 必须 `--test-coverage-include="lib/**"`：否则 `scripts/` 自己的 94%~100% 覆盖率会把整体拉高。
- **注意**：`--test-coverage-include` 不会为「从未被 import 的文件」生成 SF 条目。`lib/index.js` 现在不在 lcov 里，所以「给 `lib/index.js` 补第一条测试」是基线守卫能生效的前提，二者必须同批做。
- 坑：reporter 目标路径**必须用仓库相对路径**，写 `/tmp/x.info` 在 MSYS 下会被 Node 解析成 `D:\tmp\x.info`。

### D3 宿主契约静态扫描必须「优先读 `.bak`」

这是本轮最重要的发现：

- 本机宿主树 `@deepseek-ai` 下有 **37 个 .js 带 `[dsh-purge]` 标记**（我们自己的补丁写的），另有 **58 个 `.dshpurge.bak`**。
- `.dshpurge.bak` 里 `[dsh-purge]` 标记数 = **0** → 备份就是官方原文。实证：`dsh-settings/lib/index.js.dshpurge.bak` 仍含 `super(ownerContext, "settings")`，说明 `settings` 这个服务名是宿主原生的，不是我们注入的。
- 若直接扫当前文件，会把我们自己插进去的分支（例如 `[dsh-purge] legacy settings api`）当成宿主契约，形成**自证式假绿** —— 我们自己加的东西，当然永远存在。

规则：`<file>.dshpurge.bak` 存在则读它，否则读 `<file>`。

### D4 契约粒度到「成员」，且允许「服务包 ≠ 方法实现包」

实测两个反例：

- `ctx.subprocess` 服务由 `dsh-subprocess` 提供（`dsh-subprocess/lib/index.js:88` `super(ctx, "subprocess")`），但 `resolveExecutable` 的**实现**在 `dsh-subprocess-local/lib/index.js:1523`。只查服务包会漏。
- `ctx.get("desktopRuntime") || ctx.get("desktopActions")` 在宿主全树 **0 命中**，属桌面壳可选服务（`lib/desktop.js:1015-1019` 已有 `typeof runtime.requestRestart === "function"` 防御）。契约里标 `optional: true`，缺失只算 review。

### D5 补丁判定与契约判定不各写一套

`host:status` 现在只调 `verify-target.mjs --json`（历史教训 #88：平行判定会互相打架）。契约检查也照此办理：`scripts/host-contract.mjs --json` 是唯一判定来源，`host-baseline.mjs` 只做 spawn + 合并 verdict，不重算。

## 5. 组成部分

### 5.1 命令分层（`package.json`）

```
test        = node --test scripts/test-*.mjs            # 离线，目标 <10s
test:full   = node scripts/test-full.mjs                # test + 覆盖率 + 基线守卫
check       = check:syntax && check:metadata && check:client && test   # 不变
```

`test:full` 内部：`node --test --experimental-test-coverage --test-coverage-include="lib/**" --test-coverage-exclude="docs/**" --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=.tmp-cov.info scripts/test-*.mjs`，然后 `node scripts/check-coverage-baseline.mjs`。

`.tmp-cov.info` 进 `.gitignore`。

### 5.2 12 个脚本增量迁移（一次一个文件）

不要求一次全改。迁移一个文件的模板：

```js
import test from 'node:test'
test('bom: 三个标记都能被扫到', () => { ... })
test('bom: 覆盖写回后字节不再带 BOM', () => { ... })
```

未迁移的文件继续以「整个文件 = 一个用例」的形式被 `node --test` 跑，结果照样可信。**迁移期间测试数会从 12 涨到 20+，这是预期的**。

顺序（先易后难，先小后大）：`test-verification` → `test-package-integrity` → `test-update-source` → `test-preset-compat` → `test-resource-visibility` → `test-bom-guard` → `test-destructive-guards` → `test-host-baseline` → `test-knowledge-dispatch` → `test-client-chain` → `test-patch-registry` → `test-runtime-heal`。

### 5.3 `docs/test-baseline.json`

```json
{
  "schema": 1,
  "capturedAt": "2026-11-11T...Z",
  "commit": "df2d972",
  "note": "棘轮基线：只许涨。刷新用 npm run test:baseline",
  "files": {
    "lib/core.js": { "lh": 894, "lf": 5268, "fnh": 19, "fnf": 264, "brh": 79, "brf": 108 }
  }
}
```

守卫规则（`scripts/check-coverage-baseline.mjs`）：

- 已记录文件：`lh < baseline.lh` → 红（`lh > baseline.lh` 只打印「↑ +N」，不自动改文件）。
- 基线里有、lcov 里没有的文件 → 红（说明它掉了，或被 exclude 规则误伤）。
- lcov 里有、基线里没有的文件 → 只列出来，不红（新增文件不该卡住开发）。
- 故意降覆盖：手动改 `docs/test-baseline.json` 并在提交信息里写理由。刷新基线：`npm run test:baseline`（`--write`）。

首批纳入 4 个文件：`lib/core.js`、`lib/index.js`（待 5.6 落地后有数）、`lib/desktop.js`、`lib/redteam/store-core.js`。

### 5.4 `docs/host-contract.json` + `scripts/host-contract.mjs`

```json
{
  "schema": 1,
  "capturedAt": "2026-11-11T...Z",
  "host": "0.2.2-rc.1",
  "services": [
    { "service": "webServer", "provider": "dsh-host-webserver", "members": ["register", "registerUpgrade", "port"] },
    { "service": "systemPrompt", "provider": "dsh-system-prompt", "members": ["section"] },
    { "service": "tools", "provider": "dsh-tools", "members": ["register"] },
    { "service": "agents", "provider": "dsh-agent", "members": [] },
    { "service": "settings", "provider": "dsh-settings", "members": [] },
    { "service": "agentPresets", "provider": "dsh-agent-preset-registry", "members": ["register"] },
    { "service": "subprocess", "provider": "dsh-subprocess", "members": ["resolveExecutable"],
      "memberProviders": { "resolveExecutable": "dsh-subprocess-local" } },
    { "service": "slots", "provider": "dsh-client-ui-renderer", "members": ["register", "inject"] },
    { "service": "desktopRuntime", "provider": null, "optional": true, "members": ["requestRestart"] }
  ],
  "events": [
    { "event": "system-prompt/assemble", "provider": "dsh-system-prompt" },
    { "event": "agent/pre-step", "provider": "dsh-agent" },
    { "event": "session/created", "provider": "dsh-session" },
    { "event": "session/event", "provider": "dsh-session" },
    { "event": "tools/pre-execute", "provider": "dsh-tools" },
    { "event": "approval/request", "provider": "dsh-user-approval" },
    { "event": "agent-preset/selected", "provider": "dsh-agent-preset-registry" }
  ],
  "modules": [
    { "specifier": "@deepseek-ai/dsh-home-paths", "members": ["dshHomePath", "resolveDshHome", "defaultDshHome"] }
  ]
}
```

扫描器（静态、只读、不 import 宿主代码）：

- 输入：`--ai-base`（默认复用 `host-baseline-lib.mjs` 的 `findAiBase()`）、`--contract`、`--json`、`--pad`。
- 每个服务：在 `<pkg>/lib/**/*.js`（优先 `.bak`）里找 `super(<任意标识符>, "<service>")`；命中 ⇒ 服务存在。
- 每个成员：在同一文件里找 `\b<member>\s*\(` 或 `\b<member>\s*=`；`memberProviders` 指定的一律去那个包找。
- 每个事件：在 provider 包里找 `"<event>"` 字面量出现。
- 每个模块：`<pkg>/package.json` 能读 + 在 `lib/index.js` 的 `export {...}` 或 `export const <member>` 里能找到成员名。
- 结果分级：`missing`（包没有）`/ renamed`（包在、成员不在）`/ `moved`（成员在别的包被找到，给出猜测）`/ `ok`。
- verdict：任一非 optional 的 `missing`/`renamed` → `broken`；只有 `moved` 或 optional 缺失 → `review`。
- 退出码：0 ok/review，1 broken，2 探测/用法失败（与 `host-baseline.mjs` 保持一致）。

接入 `host:status`：`host-baseline.mjs` 在拿到补丁 verdict 后再 spawn `host-contract.mjs --json`，取两者较差的一级作为最终 verdict，输出两段摘要。`--capture` 时同时刷新 `docs/host-contract.json`（顺带把 `host` 版本写进去）。

### 5.5 `docs/test-map.md`

一张表，每行「能力 → 守着它的测试 → 状态」。示例行：

```
| 提示词注入决策（strict/fallback/always） | 无 | ❗缺 |
| 补丁注册表 86 条与拆分前逐字节等价 | test-patch-registry | ✅ |
| 宿主服务 webServer/systemPrompt/... 仍在 | host:contract | ✅（新增） |
```

规则：新增能力必须补一行；标 ❗缺 的行就是下一批测试的待办池。这份文件是给人看的，不参与 CI 判定。

### 5.6 `scripts/test-plugin-surface.mjs`（给 `lib/index.js` 的第一条测试）

实测 `lib/index.js` 可以安全 import（41 ms，无副作用）：
`export keys = BOOLEAN_CONFIG_KEYS,apply,default,inject,name,normalizeConfig,registerPromptSections`。

用例：

1. 7 个 export 存在且类型正确。
2. `inject` 严格等于 `["systemPrompt","tools"]`（历史坑：把 `pluginPackages` 写进 inject 会让宿主 pending 并退出码 1）。
3. `normalizeConfig()` 返回 18 个键，且键集合与 `BOOLEAN_CONFIG_KEYS`（12 键）的关系正确 —— `BOOLEAN_CONFIG_KEYS` 的每一项都必须出现在 `normalizeConfig()` 结果里。
4. `normalizeConfig` 的字符串布尔转换：`{ verbose: "no" }` → `false`；`{ enabled: "false" }` → `false`；`{ stripMnemon: "1" }` → `true`。
5. **如实锁定现状**（不美化）：`retryMax: "9"` 保持字符串不转数字；`anchorMode: "bogus"` 原样透传不做枚举校验；`continueText: "   "` 不 trim。这三个是当前真实行为，测试注释里标明「现状锁定，非期望行为」。

> 注意：`DEFAULTS` 不是 export（`Object.keys(plugin.DEFAULTS)` 长度 0），所以「18 键」要通过 `normalizeConfig()` 的返回值断言，不能直接读 `DEFAULTS`。

## 6. 交付批次（每批独立可回退）

| 批 | 内容 | 产出 | 风险 |
| --- | --- | --- | --- |
| 1 | `test` / `test:full` / `test:baseline` 三个 script + `.gitignore` 加 `.tmp-coverage/`；删 `scripts/run-tests.mjs`（`node --test` 已取代它，单文件一个退出码的粒度丢失问题一并解决）；顺带把 `checkUpdate` 的门挪到网路之前 | `package.json`、`.gitignore`、`lib/update.js`、删 1 文件 | 极低 |
| 2 | `docs/test-baseline.json` + `scripts/check-coverage-baseline.mjs` + 其测试 | 3 新文件 | 低 |
| 3 | `docs/host-contract.json` + `scripts/host-contract.mjs` + 接入 `host-baseline.mjs` + 其测试 | 4 文件（1 改动） | 中（首次跑要对齐真实宿主） |
| 4 | `scripts/test-plugin-surface.mjs`（`lib/index.js` 第一条测试），并把 `lib/index.js` 纳入覆盖率基线 | 1 新文件 + 基线刷新 | 低 |
| 5 | 12 个脚本逐个迁 `node:test`（一次一个提交） | 12 次改动 | 低（每次只动一个文件） |
| 6 | `docs/test-map.md` + `MAINTENANCE.md` 补「怎么加测试/怎么刷基线/怎么读 host:contract」 | 2 文件 | 极低 |

第 1 批附带的产品侧优化说明：`checkUpdate()` 现在先打四个网络端点（14.5 秒）再判断「在线更新已关闭」。既然 `ONLINE_UPDATES_ENABLED = false` 是常量，让 `listRemoteVersions()` 在离线时直接返回 `["", "", []]`，**可观察结果完全一致**，但面板点「检测更新」从等 14 秒变成瞬时。

实施时推翻了两个最初设想，理由都是实测：

1. **不能在 `checkUpdate()` 开头就抛。** 我最初把门插在函数第一行，结果 `handleUpdateOp({op:'channel',channel:'beta',apply:false})` 从返回 `{ok:true,error:"还没有测试版"}` 变成抛错——`beta` 分支的语义被改掉了，不是行为等价。最终把门放进 `listRemoteVersions()` 里那句 `Promise.all`：`remoteHeadSha` 失败本来就返回 `""`、`listGithubTags` 失败本来就返回 `[]`，用空值短路与原路径逐字等价。
2. **`.gitignore` 用目录 `.tmp-coverage/` 而不是单文件 `.tmp-cov.info`。** spec 与 lcov 目标同库，单独一个文件容易和别的临时产物混在一个平铺目录里。

实测（改后）：`checkUpdate` 138 ms 抛错、`applyUpdate` 26 ms、`handleUpdateOp({op:'versions'})` 105 ms、`handleUpdateOp({op:'channel',channel:'beta',apply:false})` 127 ms 仍返回 `{ok:true,error:"还没有测试版"}`、`switchVersion('1.1.93')` 49 ms 抛「未知版本」、`autoUpdateIfNeeded()` 0 ms 返回 `{auto:true,skipped:"manual-only"}`。`test-update-source` 从 9.95 s 降到 0.17 s，全量 `npm test` 从 5.0 s 降到 0.54 s。

## 7. 验收标准

- `npm run test`：全绿，墙钟 < 10 s（实测目标：0.6 s 级别）。
- `npm run test:full`：全绿，输出 lcov 并显示覆盖率对比表（↑/=/↓）。
- 人为删掉 `lib/core.js` 里任意一个被覆盖的函数 → `test:full` 因行覆盖下降而红。
- 人为把 `docs/host-contract.json` 里某服务名改成不存在的名字 → `host:status` verdict 变 `broken` 并指出是哪个服务。
- `npm run check` 全绿（含新增测试）。
- 远端 CI 绿。

## 8. 明确不做

- 不装 `c8`/`nyc`/`vitest`/`jest`（零依赖是硬约束）。
- 不为了覆盖率去写「调用一下就算覆盖」的空测试。
- 不在 CI 里跑 `test:full` 的宿主契约部分（runner 没有宿主，会全 `missing` 假红）。契约只在开发者机器与本机 `host:status` 里跑。
- 不动 `scripts/client-chain-lib.mjs`、`scripts/host-baseline-lib.mjs` 的现有算法。
