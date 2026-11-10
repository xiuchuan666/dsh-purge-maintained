# 维护手册

本仓库是个人长期维护基线。默认开发分支为 `main`，维护环境使用 Node.js 24；不增加第三方运行时或开发依赖。

## 每次修改前后

```bash
npm run check
```

该命令依次完成：

1. `npm run check:syntax`：检查 `bin/`、`lib/`、`scripts/` 与 `client.js` 的 JavaScript 语法，并动态导入 `lib/index.js`。
2. `npm run check:metadata`：检查 `package.json` 版本与 `release-notes.md` 首行一致、`dshTarget` 在 `dshTargets` 内、补丁 ID 唯一且有效。`ALL_PATCHES` 的数组顺序是实际应用顺序，不要求数字 ID 升序，也不为重排而重排。
3. `npm test`：自动发现并逐个运行 `scripts/test-*.mjs`，每个测试使用独立 Node 子进程。

默认检查不读取或改写 DSH profile，不应用宿主补丁，也不需要安装宿主。补丁数量从 `ALL_PATCHES` 动态读取，不在检查器里固定写死。

新增独立回归测试时，将文件命名为 `scripts/test-<主题>.mjs`，失败时设置非零退出码或抛出异常，成功时正常退出。测试临时数据放在系统临时目录，并在结束时清理。

## 需要宿主样本的验证

以下命令不属于默认 `check`，必须显式提供目标样本：

```bash
node scripts/verify-target.mjs --ai-base <.../node_modules/@deepseek-ai> --pad
node scripts/e2e-apply.mjs --src <.../node_modules/@deepseek-ai>
node scripts/e2e-desktop.mjs --main <纯净 resources/app/lib/main.js>
```

- `verify-target` 只读分类每个补丁，不做写盘。
- `e2e-apply` 把宿主树复制到临时目录，验证备份、两次应用、状态及逐字节回退。
- `e2e-desktop` 只接受纯净桌面主进程文件；已打补丁的 `main.js` 不作为原始基线。

宿主升级适配、前端重建与巨型模块拆分应分别成为独立维护任务，不与无关业务修改混在同一提交。

## CI 与发布

`.github/workflows/ci.yml` 在 `main` 推送、pull request 和手动触发时运行 `npm run check`。CI 使用 Node.js 24，不需要 `npm install`。

`.github/workflows/release.yml` 也在发布前运行相同检查。现有上游仓库条件保持不变，因此维护仓库的提交不会触发上游 Release 发布。

## 回退

普通修改以小提交落在 `main`。发现问题时用 `git revert <commit>` 保留可追踪的回退记录；不要用历史覆盖作为日常回退手段。基线首个提交为 `fa8d09dec92cf582412c28566273147076e79f24`。

详细设计与本阶段边界见 [统一验证与 CI 设计](docs/maintenance-verification.md)。
