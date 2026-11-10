# 统一验证与 CI 设计

## 目标与边界

本阶段只建立可重复的验证入口和 GitHub Actions。补丁定义、宿主写入、前端产物构建和业务行为保持不变；需要宿主样本的 E2E 不放进默认检查。

基线：Node.js 24；ESM；不增加运行时或开发依赖。仓库维护分支为 `main`。

## 命令分层

- `npm test`：按文件名顺序发现并运行 `scripts/test-*.mjs`。每个测试由独立 Node 子进程执行，沿用原有退出码；新增同规则测试自动纳入。
- `npm run check:syntax`：对 Git 跟踪的全部 `.js` / `.mjs` 执行 `node --check`，并动态导入 `lib/index.js`。
- `npm run check:metadata`：检查 package 版本、发布说明首行版本、宿主主目标包含关系、补丁 ID 唯一性、有效性和测试发现结果。数组应用顺序原样保留，不要求数字 ID 升序。补丁数量从 `ALL_PATCHES` 动态读取，不硬编码 86。
- `npm run check`：依次运行以上三项。默认验证不需要 DSH 安装，不写入 profile，也不应用或回退补丁。

## 测试发现

发现器只接受 `scripts/` 直接子级中符合 `test-*.mjs` 的文件，并检查至少发现一个测试。它不递归搜索归档、运行时目录或临时目录。执行器用 `process.execPath` 启动子进程，标准输入输出直接继承；首个失败即返回非零退出码。

## CI

新增 `.github/workflows/ci.yml`：

- `push` 到 `main`、所有 pull request 以及 `workflow_dispatch` 时运行。
- 使用 `actions/checkout@v4`、`actions/setup-node@v4` 和 Node 24。
- 不执行依赖安装；项目没有第三方开发依赖。
- `contents: read`，单个验证任务执行 `npm run check`。
- 同名分支的重复运行使用 concurrency 取消旧任务。

## 发布门禁

在现有 release 工作流中，将触发分支改为 `main`，发布前运行同一个 `npm run check`。保留只在上游仓库发布 Release 的条件；本维护仓库的 push 会跑 CI，但不会创建上游 Release。发布说明版本在打包前核对，避免生成不一致的 Release。

## 当前债务的处理

`package.json` 当前为 1.1.94，而 `release-notes.md` 首段为 1.1.93。原包中已存在该差异。本阶段在发布说明顶部补充 1.1.94 的维护性条目，并明确本阶段未改补丁逻辑；不编造 1.1.94 的业务变化。

## 验收

1. 新测试先证明：测试发现器能识别新增测试，元数据检查能拦截版本/宿主声明/重复补丁 ID 问题。
2. 本仓库执行 `npm run check`，确认语法、元数据和全部回归测试通过。
3. 检查 Git diff，确认 `lib/`、`client.js` 和补丁定义未改。
4. 提交并推送 `main`，读取实际 GitHub Actions 运行结果，确认远端 CI 为成功。
