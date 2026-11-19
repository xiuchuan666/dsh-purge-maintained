# 宿主适配 Runbook：把换树当成事务

宿主适配（换版本、换 asar、打补丁树）不是"复制文件"，而是跨越四个不可逆边界的事务：

1. **进程边界**：宿主在跑，换树前必须退出；
2. **文件树边界**：`resources/app` 是唯一真相，半成品装进去就是启动崩溃；
3. **全局环境边界**：hosts / DNS / 代理 / profile lock 属于机器状态，随手改会留下"第二真相"；
4. **基线数据边界**：`patch-gates.json` / `restriction-census.json` / `host-baseline.json` 必须与新宿主原子对齐。

任何一步绕过事务，失败都会延迟到"下一次启动"才暴露，而且暴露点离根因很远（例：漏解 unpacked → `No usable native binding`）。

## 不变式（每次换树必须全满足）

| # | 不变式 | 现在的强制点 |
|---|---|---|
| I1 | asar 解出的树必须补齐 `app.asar.unpacked`，缺一个文件就不许提交 | `scripts/extract-asar.mjs`、`ensureUnpackedOverlay()`（`lib/core.js:2198/2217` 的更新链也走它） |
| I2 | 新树必须先证明能加载原生绑定，才允许靠近安装目录 | `scripts/host-adopt.mjs probe --tree <appDir>`（文件存在 + 真 `require` 一次） |
| I3 | 旧树用 rename 保留，新树失败必须自动回滚 | `scripts/host-adopt.mjs swap --tree <appDir> --apply` |
| I4 | 三份基线一次重钉、一个 commit | `scripts/host-adopt.mjs pin --tree <appDir>` |
| I5 | 全局环境变更必须留 journal + 可回滚命令；网络问题先诊断再动手 | `scripts/net-doctor.mjs`、`.tmp-dns-rollback.txt` 的格式约定 |

## 标准流程

```bash
# 0. 准备：从安装包/更新包拿到 app.asar
#    7z 抽 $PLUGINSDIR/app-64.7z → app/resources/app.asar

# 1. 解包（自带 unpacked 补齐 + 校验，缺文件 exit 1）
node scripts/extract-asar.mjs --asar <app.asar> --dest .tmp-rehearse/app-<ver> --clean

# 2. 体检 + 原生绑定试加载
node scripts/host-adopt.mjs probe --tree .tmp-rehearse/app-<ver>

# 3. 离线预演（补丁/行为/choke/gates 全绿才继续）
node scripts/host-rehearse.mjs --baseline-tree .tmp-rehearse/app-<ver>/dsh/node_modules/@deepseek-ai \
  --work .tmp-rehearse/work-<ver> --keep --json .tmp-rehearse/outcome-<ver>.json

# 4. 基线一次重钉（dry-run 先看命令；--apply 才写）
node scripts/host-adopt.mjs pin --tree .tmp-rehearse/app-<ver>

# 5. 快照 + 换树（先 dry-run，确认步骤后再 --apply；旧树保留为 app.prev-<ts>）
node scripts/host-adopt.mjs snapshot --apply
node scripts/host-adopt.mjs swap --tree .tmp-rehearse/app-<ver> --resources "<安装目录>/resources" --apply

# 6. 装后核对
node scripts/host-integrity.mjs --resources "<安装目录>/resources"
node scripts/host-adopt.mjs verify --resources "<安装目录>/resources"
npm run check
```

## 回滚

- `swap` 失败会自动：删掉半成品 → `app.prev-<ts>` rename 回 `app` → 还原被改名的 `app.asar`。
- 手工回滚：`resources/app` 改名，`app.prev-<ts>` 改回 `app`；asar 同理。
- 完整退路仍应保留：`app.asar.bak`（上一版原包）、`app.rc3-patched/`（上一次可启动的补丁树）。

## 环境变更（DNS / hosts / 代理）

- 改之前把原值写进 `.tmp-<topic>-rollback.txt`（含一条可粘贴的回滚命令）。
- 改完立刻验证：`node scripts/net-doctor.mjs`。
- 诊断顺序固定：**解析（DNS）→ 覆盖（hosts）→ 绕行（NO_PROXY/代理）→ 证书**；不要一上来改代理。
- 任何会话都不得把临时 hosts 记录留到下一轮；`net-doctor` 会把残留标成 error。

## 一次性脚本的归置

- 同一操作第二次出现，就必须变成 `scripts/` 下的正式脚本 + `scripts/test-*.mjs`，带 `--dry-run` 与退出码。
- repo 根只允许 `.tmp-*` 临时物，且已被 `.gitignore` 忽略；不许把一次性脚本塞进 `scripts/` 冒充测试。
