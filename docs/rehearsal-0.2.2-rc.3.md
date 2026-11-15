# 0.2.2-rc.3 影子预演（真机未动）

结论：**兼容**。86 条补丁在 rc.3 的隔离树上跑完六步证据，全绿、无 blocking；真机与本仓库工作区都没有被修改。

## 怎么跑的

```bash
# 1) 只装树，不装宿主（--ignore-scripts 不跑任何 postinstall）
cd .tmp-preview/tree && npm install --no-save --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh@0.2.2-rc.3
# → added 670 packages in 1m，树 1.4G，版本确认 0.2.2-rc.3

# 2) 六步预演（apply/outcome/behaviour/choke/gates/surfaces），产物落在 .tmp-rehearse/
node scripts/host-rehearse.mjs \
  --baseline-tree .tmp-preview/tree/node_modules/@deepseek-ai \
  --version 0.2.2-rc.3 --work .tmp-rehearse/work \
  --json .tmp-rehearse/rc3.json --keep
```

注意 `--baseline-tree` 要指到 **`node_modules/@deepseek-ai`**（该目录下有 `dsh/`），不是 `.../@deepseek-ai/dsh`；指错了会以 `TypeError: The "path" argument must be of type string. Received null` 崩在 `resolveBaseline`。

## 六步证据

| 步 | 结果 | 数字 |
|---|---|---|
| apply | warn | ok **79** / warn 7 / blocking **0**（7 条都是包树里没有的 hooks/pi-ai/presets，安装版才有，属预期） |
| outcome | ok | applied **67** / pending 0 / native **3** / stale **0** / drifted **0** / na 16 / unknown 0 |
| behaviour | ok | 15 个行为断言两棵树都跑：ok **15** / broken 0 / already 0 / inert 0 |
| choke | ok | gaps **0** / watch 4 / targets 10 / ignored 115 |
| gates | warn | present 55 / missing **3** / skipped 28（表钉的是 rc.1 的针） |
| surfaces | ok | 42 个包对比：changed 1 / known 1 / unexpected **0** |

汇总 `verdict = { ok: true, reds: [], warns: ["apply: 7 warn row(s)", "gates: 3 needle(s) moved between 0.2.2-rc.1 and 0.2.2-rc.3"] }`。

## 升级当天要做的三件事

1. **重钉三条闸针**（表还钉着 rc.1，rc.3 里针文本变了）：

   | # | 补丁 | rc.1 位置 | rc.3 位置 |
   |---|---|---|---|
   | 13 | ESCALATION_WIDENING_EXEMPT | `dsh-sandbox/lib/index.js:140` | `dsh-sandbox/lib/index.js:171` |
   | 56 | REWIND_HIDE_CUT_ONLY | `dsh-client-ui-conversation/lib/client.js:2575` | `…/client.js:4` |
   | 77 | REWIND_DROP_SENT_ON_APPEND | `dsh-client-ui-conversation/lib/client.js:2602` | `…/client.js:4` |

   ```bash
   npm run host:gates -- --tree rc3=.tmp-preview/tree/node_modules/@deepseek-ai --write docs/patch-gates.json
   ```

   本次**没有**改写 `docs/patch-gates.json`：真机还是 rc.1，表必须能对得上已装的树。等装 rc.3 那天再重钉，一次成形。

2. **人眼确认 #56/#77 的新针**：rc.3 的 `dsh-client-ui-conversation/lib/client.js` 被压成单行，重取出来的针是 `var ConversationNodeAssembler=class{` 和 `append(record){const event=record.event;…}`，行号都塌到 4——针变弱了，重钉之后手动确认它钉的仍是「隐藏切割点」那段，别让一条泛锚点混过去。

3. **choke 的 4 条 watch 过一眼**（都是信号形状，不阻断）：
   - `dsh-client-ui-permission-presets/lib/client.js:571` `mode-literal`：`id === "danger-full-access" || id === "auto"` ×3 命中
   - `dsh-api-workspace-controller/lib/index.js:537` `BROWSE_FAILURE_CODES`
   - `dsh-llm/lib/index.js:251` / `dsh-session-persistence-jsonl/lib/worker.cjs:4550` `DEFAULT_RETRYABLE_CODES`

## 回退与清理

真机、`docs/host-baseline.json`、`docs/patch-gates.json` 都没动过；预演只产生两个临时目录：

```bash
rm -rf .tmp-preview .tmp-rehearse      # 1.4G 的树 + 打补丁的工作副本，删掉即完全回退
```

## 与影响矩阵的关系

`npm run impact:patches -- --rehearsal .tmp-rehearse/rc3.json` 会把这次的 per-patch 判定写进
[`docs/patch-impact.md`](patch-impact.md) 的「预演」列（applied 67 / native 3 / na 16）。
