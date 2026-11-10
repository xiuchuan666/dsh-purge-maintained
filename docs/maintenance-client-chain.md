# 前端产物链治理设计（client.js 可重建）

## 意图与背景

`client.js`（9381 行，约 545KB）是 dsh-purge 的前端注入脚本，由 `package.json` 的 `exports["./client"]` 暴露给宿主的 `client-hmr` 机制加载。勘察确认它由三层构成：

| 层 | 位置 | 来源 | 状态 |
| --- | --- | --- | --- |
| ① 主体 | 行 1 起，含 `PURGE_CSS`、`SettingsRoot`、`REWIND_CSS`、rewind UI | 上游手写成品 | 源码已失传（上游仓库 HunYiSage/dsh-purge 已不可访问），只能锚定 |
| ② dock/授权补丁 | `AUTH_KEY` 起，约 500 行 | `scripts/patch-client-dock.mjs` 四步模板（locale / dock CSS / dockBlock / apply 替换） | 已固化进成品；脚本带幂等守卫可重放，但「未补丁原版」不存在 |
| ③ 演练台片段 | `/* __DSH_PURGE_DRILL_BEGIN__ */` .. `/* __DSH_PURGE_DRILL_END__ */` 之间，约 263KB | `lib/redteam/client.js`（4396 行，在库）→ `scripts/build-client.mjs` 抽取嵌入 | 活层：真源码在库里，可重建 |

生成链（现状，不改动）：

1. `scripts/patch-client-dock.mjs`：四步模板补丁 + 幂等守卫；末尾 spawn 调 `build-client.mjs`。
2. `scripts/build-client.mjs`：从 `lib/redteam/client.js` 抽 factory 体（定位 `factory: (require) => {` 到 `\n    return module.exports\n  },\n})`），改写 `apply()` 为 `applyDrillParts()`，替换 BEGIN/END 标记之间的内容。

实测行为（2026-11-10）：

- `npm run build:client` 幂等：重跑字节不变。
- `patch-client-dock.mjs` 对已补丁文件重放内容等价，但会全文件 CRLF→LF（删 5017 个 CR），连续重放两脚本后收敛稳定（sha256 `adb58114...`）。
- 桌面副本的 `dsh-purge-1.1.94.tgz` 内 `package/client.js` 与工作区 client.js 字节一致（sha256 `6de9c8dae636ad5e98fc...`）——tgz 是「已知正确产物」的现成锚点。

## 目标

1. 锚定：client.js 的已知正确产物入库，哈希可校验。
2. 防过期：改了 `lib/redteam/client.js` 忘跑 `build:client` 时，`npm run check` 必须报错。
3. 防损坏：DRILL 标记、dock 补丁锚点丢失或错序时必须报错。
4. 文档化：三层结构、正确改前端流程、换行行为，写进 MAINTENANCE.md。

## 非目标

- 不改 client.js 本身。
- 不改 `build-client.mjs` / `patch-client-dock.mjs` 的行为。
- 不为已失传的主体①重写源码（拆解属过度工程；本阶段让它从「说不清来源」变成「哈希锚定 + 来源有据」）。
- 不做产物与宿主实机端的比对（宿主端状态属宿主基线阶段管）。

## 方案（已选定）

备选考虑过：a) 只文档化不自动化（防过期靠人记，违背本轮目的）；b) 重构生成链为先构建后补丁的干净管线（需重写主体①的源，源已失传，做不成）。选定：**锚点 + 只读校验器**。

新增/改动：

| 文件 | 内容 |
| --- | --- |
| `docs/origin/client-1.1.94.js` | 从 tgz 提取的锚点产物（与基线提交 fa8d09d 的工作区版本字节一致） |
| `docs/origin/client-1.1.94.sha256` | 锚点哈希记录（`<sha256>  client-1.1.94.js` 格式，sha256sum 可验） |
| `scripts/check-client.mjs` | 只读校验器，三步：① 锚点存在且哈希匹配记录；② 当前 client.js 结构完整（两个 DRILL 标记存在且顺序正确、`id: "dsh-purge-dock"` dock 补丁锚在）；③ 同步检测——按 build-client.mjs 同样算法从 `lib/redteam/client.js` 现抽片段，与 client.js 中 BEGIN/END 之间内容一致。任何一步失败退出码 1。 |
| `scripts/test-client-chain.mjs` | fixture 回归测试：临时目录构造假锚点/假 client，覆盖同步检测能抓「片段过期」（改 redteam 源不重嵌→必须检出）、锚点缺失、哈希不符、标记缺失/错序、健康路径通过。 |
| `package.json` | `check` 链插入 `check:client`（顺序：syntax → metadata → client → tests）。 |
| `MAINTENANCE.md` | 新增「前端产物链（client.js）」：三层构成表、改前端正确流程、换行行为说明、锚点用途。 |
| `docs/maintenance-client-chain.md` | 本文档。 |

关键实现约束：

- check-client.mjs 抽取片段的算法必须逐字复用 `build-client.mjs` 的定位逻辑（同样的 startMark/endMark/apply 改写/exports 删除），否则会出现「校验器说同步、build 一跑却变」的假一致。实现为共享：把抽取函数放进 `scripts/client-chain-lib.mjs`，两个脚本（现在只有校验器用；build-client.mjs 不动）引用同一份逻辑，测试对两处算法做一致性断言（对当前仓库实际跑 build-client 前后哈希不变）。
- 片段比较在字符串级（归一 LF 后），避免 CRLF 噪声；锚点哈希比较在字节级。
- 校验器对仓库当前状态必须通过（当前 client.js 恰好是「redteam 源 → build 后」的同步态）。

## 验收标准

1. `npm run check` 全绿（测试从 9 增至 10）。
2. 人为把 `lib/redteam/client.js` 末尾加一行注释（模拟改源忘 build），`npm run check` 在 check:client 步失败；还原后恢复全绿。
3. 锚点哈希手动篡改后 check 失败；还原恢复。
4. 演练后工作区干净，提交推送，远端 CI success。

## 遗留边界

- 主体①的 8000 行手写源码上游已删库，找不回来；本方案只能锚定。
- `patch-client-dock.mjs` 重放会 CRLF→LF 的行为记录在案，不在本轮修（修它要动补丁产物，违背本阶段边界）。
