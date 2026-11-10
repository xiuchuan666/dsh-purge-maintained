# 元数据清债 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 package.json 的上游元数据（repository/homepage/bugs/engines）与 README Node 徽章改为维护仓库/Node 24，零业务行为变化。

**Architecture:** 纯元数据修改，2 文件 5 行。行为等价性依据：`lib/redteam/ui.js:358 githubRepoOf(homepage)` 改前改后都是匿名 404（上游仓库已删），演练台检查更新失败方式不变。

**Tech Stack:** 无（JSON/HTML 单行编辑 + 既有 npm run check）。

**Spec:** docs/maintenance-metadata-cleanup.md

## Global Constraints

- 不改 lib/update.js、client.js、release.yml、任何上游署名文件（README 三语正文/release-notes/LICENSE）
- Node 24、零第三方依赖、ESM 不变
- 公开行为不变、补丁产物不变、测试结果不变
- 提交落 main，回退用 git revert

## Review Focus

- homepage 被演练台 `githubRepoOf()` 消费（lib/redteam/ui.js:358）——期望改后仍解析出 `owner/repo`，只是指向私有仓库 → Task 3 实测
- engines 改 >=24 后 npm install 在本机 Node v24.22.1 不警告/不报错 → Task 3 实测
- release.yml 保险丝 `if: github.repository == 'HunYiSage/dsh-purge'` 仍让 Release skipped → Task 3 确认
- check:metadata 校验的是 version/release-notes/dshTarget/补丁 ID，与 repository/engines 无交集，改后必须仍 PASS → Task 2

---

### Task 1: 改 package.json 四字段与 README 徽章

**Files:**
- Modify: `package.json:66-73`（repository/homepage/bugs）、`package.json` engines 行（同文件，约 75 行附近）
- Modify: `README.md:20`

**Interfaces:**
- Consumes: 无
- Produces: `package.json` repository.url = `git+https://github.com/xiuchuan666/dsh-purge-maintained.git`；homepage = `https://github.com/xiuchuan666/dsh-purge-maintained#readme`；bugs.url = `https://github.com/xiuchuan666/dsh-purge-maintained/issues`；engines.node = `">=24"`；README.md:20 徽章含 `Node.js-%3E%3D24`

- [ ] **Step 1: 编辑 package.json**

repository、homepage、bugs 三个 URL 指向 xiuchuan666/dsh-purge-maintained，engines.node 改 `>=24`。其余字段一律不动。

- [ ] **Step 2: 编辑 README.md:20 徽章**

`Node.js-%3E%3D18` → `Node.js-%3E%3D24`（alt 文本 `Node.js` 不变）。

- [ ] **Step 3: 验证 JSON 与目标行**

Run: `node -e "const p=require('./package.json'); console.log(p.repository.url, p.homepage, p.bugs.url, p.engines.node)" && grep -n "%3E%3D24" README.md`
Expected: 四个新值 + README.md:20 匹配一行

### Task 2: 全量回归

**Files:** 无新改动。

**Interfaces:**
- Consumes: Task 1 产物
- Produces: 全绿证明

- [ ] **Step 1: npm run check**

Run: `npm run check`
Expected: [syntax]/[metadata]/[client]/[test] 全 PASS，10/10

### Task 3: 行为等价实测 + 提交推送

**Files:** 无新改动（验证 + 提交）。

**Interfaces:**
- Consumes: Task 1/2 产物
- Produces: 提交 bd0619f 之后的一个提交，推送 origin main

- [ ] **Step 1: 实测 githubRepoOf 联动**

Run: `node -e "const h=require('./package.json').homepage; const m=String(h).match(/github\.com[/:]+([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?].*)?$/i); console.log(m[1]+'/'+m[2])"`
Expected: `xiuchuan666/dsh-purge-maintained`（与 ui.js 正则同源，证明扒取仍成功）

- [ ] **Step 2: 实测检查更新按钮不崩（可直接 node 调 ui.js 的检查入口或手动在演练台点一次，取实际可行方式）**

Expected: 404 静默失败，无未捕获异常。（上游 404 与私有 404 等价；若手动验证不可行，以 Step 1 + 匿名 API curl 404 佐证等价性。）

- [ ] **Step 3: 提交**

```bash
git add package.json README.md docs/maintenance-metadata-cleanup.md docs/superpowers/plans/2026-11-10-metadata-cleanup.md
git commit -m "chore: point package metadata to maintenance repo, engines >=24"
```

- [ ] **Step 4: 推送并确认 CI**

```bash
'/c/Program Files/Git/cmd/git.exe' -c http.schannelCheckRevoke=false push origin main
gh run list --repo xiuchuan666/dsh-purge-maintained --limit 2
```

Expected: CI success；Release skipped（保险丝生效）
