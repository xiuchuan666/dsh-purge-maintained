# 宿主适配基线设计

## 目标

宿主（DeepSeek Harness 桌面端）升级后，用一条命令回答一个问题：**86 条补丁里哪一条废了、废在哪个文件、哪个字面量。**

在引入本机制之前，这个问题只能靠 `verify-target` 的输出与上一轮的记忆人工比对：补丁状态是同一批名字的清单，没有「之前是什么样」的参照，版本一变就无从判断哪几行是这次升级造成的。本阶段把「参照」固化成入库的 JSON 基线。

## 边界（本阶段不做）

- 不改任何补丁的 pattern / marker / replace（`lib/core.js` 一行未动）。
- 不写宿主目录：`host:status` 全程只读，唯一写出的是仓库里的 `docs/host-baseline.json`（且只在 `--capture` 时）。
- 不接管前端产物链、不拆 `lib/core.js`。
- 不把宿主检查塞进 CI：GitHub runner 上没有宿主安装，硬塞只会得到一份「全部 no-file」的假绿。

## 组成

| 文件 | 职责 |
| --- | --- |
| `scripts/host-baseline-lib.mjs` | 纯函数：路径收敛、指纹、快照构造、快照比对、文本渲染 |
| `scripts/host-baseline.mjs` | CLI：`--capture` / 默认比对 / `--ai-base` / `--baseline` / `--json` / `--pad` |
| `docs/host-baseline.json` | 入库基线快照（相对路径 + sha256） |
| `scripts/test-host-baseline.mjs` | 纯函数回归测试，全部用临时目录 fixture |

## 判定只有一个来源

补丁状态（`settled` / `would-apply` / `drifted` / `no-file` / `na`）**不在** 基线代码里重算，而是 `spawnSync` 调用 `scripts/verify-target.mjs --json`，读它的结果。

原因有历史证据：`verify-target.mjs:157` 起用 `core.filePatchOutcome()` 判定「pattern 全中但产物不完整」的 `partial` 情形，`softFiles`/`deleteOnly`/`after` 链式关系也都在 `lib/core.js` 里。任何第三次抄写这套判定都会分叉——上一轮 #88 就曾因为平行判定被误报成 drifted，而按顺序 apply 时它是好的。

## 快照结构

```json
{
  "schema": 1,
  "capturedAt": "2026-11-10T08:34:00.000Z",
  "pluginVersion": "1.1.94",
  "host": { "version": "0.2.2-rc.1", "name": "@deepseek-ai/dsh", "packagePath": "..." },
  "aiBase": "C:/.../resources/app/dsh/node_modules/@deepseek-ai",
  "files": { "agent-instructions": { "rel": "dsh-agent-instructions/lib/index.js", "bytes": 63970, "sha256": "..." } },
  "patches": [{ "id": 1, "name": "...", "status": "settled", "files": { "agent-instructions": "settled" } }],
  "summary": { "patches": 86, "settled": 79, "wouldApply": 0, "drifted": 0, "noFile": 7, "na": 0 }
}
```

- `files` 只存 `rel` + `bytes` + `sha256`，不存绝对路径，换机器可读、入库无泄漏。
- `targetFiles()` 的值可能是数组（例如某些键有多个候选副本），数组按下标摊平成 `key#0`、`key#1`。
- 当前基线（宿主 0.2.2-rc.1，已完全打好补丁）：86 补丁 / 79 settled / 7 no-file / 0 drifted，59 个目标文件指纹。

## 比对规则

**文件层**：逐键比较 `sha256`，输出 `added` / `removed` / `changed`。

**补丁层**：逐 `id` 比较状态，迁移带 severity：

| 迁移 | severity | 含义 |
| --- | --- | --- |
| `settled` 或 `would-apply` → `drifted` | `broken` | 升级把补丁打断了，必须改字面量 |
| `drifted` → `drifted` | 不产生迁移 | 上一轮就坏着 |
| `no-file` → `would-apply` | `changed` + 进 `gained` | 官方把文件放回来了，这里可以打了 |
| `drifted` → `settled` | `recovered` | 官方改回原样或已手工修复 |
| 补丁 ID 消失 | `broken` | `ALL_PATCHES` 与基线不匹配 |

**总判定**：任一 `broken` → `broken`；否则版本变/文件变/任意迁移 → `review`；全同 → `ok`。

## 退出码

- `0`：`ok` 或 `review`。日常 `host:status` 不该因为「版本号变了」就红。
- `1`：`broken`。脚本化拦截用这个。
- `2`：用法错误或找不到宿主（含 `--ai-base` 给错）。

## 探测路径

`findAiBase()` 顺序：`DSH_HOST_AI_BASE` / `DSH_AI_BASE` / `DSH_HOST_DIR` → `%LOCALAPPDATA%/Programs` → `%ProgramFiles%` → `%ProgramFiles(x86)%`；每个 `Programs` 下按 `/deepseek|dsh/i` 匹配目录名，再找 `resources/app`。

`resolveAiBase()` 只接受**真宿主树**——目录下直接有 `dsh/package.json` 且包名以 `@deepseek-ai/` 开头。这条约束是实测逼出来的：桌面安装的 `resources/app/node_modules/@deepseek-ai` 里也有一堆 `dsh-*` 包（Electron 外壳依赖），把它喂给 `core.targetFiles()` 会返回 **0 个文件**，体检结果变成全场 `no-file`，看上去像「宿主完全不适配」。

## 本机实测

```
$ npm run host:status
[host] host 0.2.2-rc.1 (未变)  verdict=ok
[host] 与基线一致，无需处理
```

`npm run check` 后测试数从 8 增至 9（新增 `test-host-baseline.mjs`）。

## 升级当天的操作顺序

1. 升级宿主，重启。
2. `npm run host:status` —— 看 verdict。
3. `broken`：从输出的 `#id name` 列表定位，`node scripts/verify-target.mjs --ai-base <目录> --pad` 看每条 pattern 的命中情况，改 `lib/core.js` 对应补丁。
4. 修完实机 apply，确认 `drifted: 0`。
5. `npm run host:capture` 写新基线，连同补丁修改一起提交。
6. `npm run check` 后推送，CI 兜底语法与元数据。
