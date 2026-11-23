# 安装规范：每次宿主安装只走一条路

宿主安装（换版本、换补丁树、修崩溃）不是“复制文件”。一次安装要跨四个边界：进程（宿主必须退出）、文件树（`resources/app` 是唯一真相）、全局状态（DNS/hosts/代理/profile lock）、基线（三份 JSON 必须同版本）。任何一步被手工旁路，失败都会延迟到下一次启动才暴露——rc.5 那次 `No usable native binding` 就是这么来的。

## 1. 唯一入口

| 动作 | 命令 |
|---|---|
| 看当前安装是否完整 | `npm run host:integrity` |
| 看安装计划（dry-run，不动文件） | `npm run host:install -- --tree <新 app 树>` |
| 真装（关宿主 + 换树 + 健康检查 + 失败自动回滚） | `npm run host:install -- --tree <新 app 树> --stop --apply` |
| 回到 journal 记录的上一棵树 | `npm run host:install -- --rollback --apply` |
| 重钉三份基线 | `npm run host:adopt -- pin --tree <新 app 树> --apply` |
| 网络异常先诊断 | `npm run net:doctor` |
| 解 asar（唯一入口） | `node scripts/extract-asar.mjs --asar <app.asar> --dest <树> --clean` |
| 离线直装插件 profile（桌面 profile 唯一通道） | `npm run profile:install -- --tgz <tgz> --sha256 <hex> --exe "<exe>" --apply` |
| 装后行为冒烟 | `npm run host:smoke` |
| 备份体检（默认 dry-run，`--apply` 才删） | `npm run host:gc -- --root "<resources>"` |
| 看上游是否出新版 | `npm run host:watch` |

`scripts/host-adopt.mjs swap` 已降为底层步骤：不加 `--low-level` 直接拒绝（退出码 2）。日常安装不允许用它。

## 2. 禁止清单

出现任一条，视为安装事故，按第 6 节回滚并记录：

1. 手工 `robocopy` / `xcopy` / `tar` / 资源管理器直接覆盖 `resources/app`；
2. 宿主进程还在跑就换树（脚本会拒绝；自己 `taskkill` 后手工覆盖同样禁止）；
3. 跳过 probe（原生绑定必须真 `require` 一次，文件存在不算）；
4. 用 `host-adopt swap` 不加 `--low-level`；
5. 安装失败后不读 journal 就连续重试；
6. 没跑过一次成功启动就删 `app.prev-*` / `app.asar.*.bak` / `app.rc*-patched/`。

## 3. 强制检查表

| # | 检查 | 谁执行 | 失败时 |
|---|---|---|---|
| P1 | journal 没有 `pending` | `host:install` | 退出 3；先 `--rollback` |
| P2 | 新树 probe：`require_builtin` ≥ 1 且 `require` 成功 | `lib/host-probe.js` | 退出 2，不动现场 |
| P3 | 磁盘余量 ≥ 新树 1.25 倍 | `checkSpace()` | 退出 2 |
| P4 | 宿主进程状态可确认；在跑必须 `--stop` | `tasklist` | 退出 2 |
| P5 | 旧树 rename 成 `app.prev-<ts>` | 安装事务 | 自动回滚 |
| P6 | `app.asar` 改名 `app.asar.install-bak-<ts>` | 安装事务 | 自动回滚 |
| P7 | 装进 `app` 后再 probe 一次 | 安装事务 | 自动回滚 |
| P8 | 启动健康检查：进程出现 + 15 s 存活 + 无新 `crash-*.log` | `waitHealthy()` | 自动回滚并重启旧树 |
| P9 | journal 写 `done` 并打印回滚命令 | 安装事务 | — |

P8 的观测点：进程名取 exe 文件名；crash 日志目录 `%APPDATA%\@deepseek-ai\dsh-desktop\logs`，只看 `crash-*.log` 且 `mtime >= 启动时刻`。稳定期默认 15 s（`--stability`），等待进程出现的上限默认 90 s（`--timeout`）。

## 4. journal 状态机

文件：`~/.dsh/dsh-purge/host-install-journal.json`

```
pending ──成功──> done
   ├──自动回滚──> rolled-back
   ├──回滚也失败──> failed
   └──手工 --rollback ──> rolled-back
```

- `pending` 期间新的安装一律拒绝（退出码 3），`--force` 只用于“确认上一次安装没有副作用”的场景；
- 每一步（stop-app / snapshot / asar-aside / copy-tree / probe-after / start-app / health / rollback）都记 `{name, ok, note, at}`；
- `previous` 与 `asarBackup` 是回滚的唯一依据，写在 `beginInstall` 里，不靠临时变量。

## 5. 退出码

| 码 | 含义 | 现场状态 |
|---|---|---|
| 0 | 成功（或 dry-run 通过） | 已换树并启动，journal=done |
| 1 | 安装失败，已自动回滚 | 旧树已 rename 回来并重启 |
| 2 | 预检失败 | 什么都没动 |
| 3 | 有未收尾安装 | 需先 `--rollback` |

## 6. 失败处置

1. `exit 2`：按输出补条件（树路径、`--stop`、磁盘、tasklist），不要改脚本绕。
2. `exit 1`：现场已回滚。读 journal 的 `steps` 找第一个 `ok:false` 或 `error`；崩溃原因看 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`。
3. 回滚本身失败：journal 里有 `previous` 绝对路径，手工执行
   ```
   taskkill /IM "DeepSeek Harness.exe" /F
   rmdir /s /q "<resources>\app"
   move "<resources>\app.prev-<ts>" "<resources>\app"
   move "<resources>\app.asar.install-bak-<ts>" "<resources>\app.asar"
   start "" "<exe>"
   ```
   然后 `node scripts/host-integrity.mjs --resources "<resources>"` 复核。
4. 失败后 24 小时内不要删任何 `app.prev-*`；确认新树稳定启动过一次再清理。

## 7. 与既有守卫的关系

- I1 解包补齐 unpacked：`lib/extract-asar.js` 的 `ensureUnpackedOverlay()` + `scripts/extract-asar.mjs`；
- I2 原生绑定可加载：`lib/host-probe.js`（`host-adopt probe` 与 `host:install` 共用）；
- I3 换树可回滚：`scripts/host-install.mjs`（本文件）；
- I4 基线原子重钉：`host-adopt pin`；
- I5 全局环境留证：`scripts/net-doctor.mjs` + `.tmp-<topic>-rollback.txt`。

## 8. 尚未闭环（诚实记录）

- 真实 `--apply` 全流程还没在换版本时跑过一次（下次宿主升级是首跑）；当前只验证了 dry-run 的预检与拒绝路径。
- 健康检查依赖 `tasklist` 和 crash 日志命名；官方改日志格式就要同步改 `crashFilesSince()`。
- exe 本身的替换不在事务内（由安装包负责），本流程只管 `resources` 下的树与 asar；换 exe 时仍需先备份整个 `resources`。
- 插件状态页还没有“宿主完整性”字段，安装完整性只能看 `host:integrity`。

## 9. 装后四件事（顺序固定）

1. `npm run host:integrity`：版本、unpacked 缺口、`require_builtin`、`.node` 数量。任何一项不绿，不要往下走。
2. `npm run host:smoke`：bash / read / write / tool 四步。它只证明“装出来的树能跑工具”，不证明宿主 UI 正常。
3. `npm run host:gc -- --root "<resources>"`：默认 dry-run，先看会删哪些代；确认新树稳定启动过一次再 `--apply`。
4. `npm run host:watch`：看上游是否又出新版；它只报 ETag/Last-Modified 判定，不下载也不安装。

插件 profile 的安装同理：只走 `npm run profile:install`，不要 `robocopy node_modules/dsh-purge`、不要手改 `pnpm-lock.yaml`。profile 安装与宿主安装共用 `~/.dsh/dsh-purge/host-install-journal.json`：任一方处于 `pending`，另一方会被直接拒绝（退出码 3），这是有意的互斥，不要用 `--force` 绕。
