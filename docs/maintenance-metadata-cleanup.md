# 元数据清债设计（第五轮维护）

日期：2026-11-10 · 状态：已确认（方案 A，最小清债）

## 背景与动机

维护仓库 D:\dsh-purge-maintained 已完成四轮建设（Git 基线 fa8d09d → 统一验证
22263d6 → 宿主适配基线 696912b → 前端可重建 bd0619f）。本轮清掉遗留的元数据
小债，为后续「测试保护下小步拆分」打好地基。用户原则：只有地基打好，上层
建筑才能干得好。

## 债务清单（勘察实测）

| 债 | 现状 | 风险 |
| --- | --- | --- |
| package.json repository | `git+https://github.com/HunYiSage/dsh-purge.git`（上游已 404） | 指向不存在的仓库 |
| package.json homepage | `https://github.com/HunYiSage/dsh-purge#readme` | 同上；且 `lib/redteam/ui.js:358` 的 `githubRepoOf()` 从这里扒 `owner/repo` 给演练台检查更新用 |
| package.json bugs | `https://github.com/HunYiSage/dsh-purge/issues` | 同上 |
| package.json engines.node | `">=18"` | 与维护环境 Node 24 不符，误导向 |
| README.md:20 徽章 | `Node.js-%3E%3D18` | 与 engines 声明不一致（改了 engines 就一起改） |

## 隐藏联动（勘察确认）

1. **homepage → 演练台检查更新**：`lib/redteam/ui.js:358`
   `githubRepoOf(homepage)` 正则扒 `owner/repo`，失败回退默认
   `HunYiSage/dsh-purge`。改成新仓库后它指向私有仓库
   `xiuchuan666/dsh-purge-maintained`，匿名 GitHub API 404。但现状本来也是
   404（上游仓库已删），行为等价：检查更新失败但不崩。**行为不变约束满足**。
2. **lib/update.js 自更新器（`REPO = "HunYiSage/dsh-purge"`，lib/update.js:12）**：
   指向上游已 404 仓库，救活需要塞 token 或改业务行为，超出本轮边界。
   本机自用更新走 git pull。**明确不动**，留作将来独立一轮。
3. **client.js:143,504 两处 `welcome.repo`**：纯展示链接在 545KB 成品里，
   动了要过锚点对拍流程，收益为零。**明确不动**。
4. **release.yml:17 上游条件**：`if: github.repository == 'HunYiSage/dsh-purge'`
   是防误发的保险丝（维护仓库永不发布），两次推送已验证 skipped。**保留**。

## 上游署名（不属于债）

README 首屏写明 "Attribution required"，Apache-2.0 要求保留署名。
README.md / README.zh-CN.md / README.ja.md / release-notes.md /
LICENSE-COMMERCIAL.md 里的上游引用（共 66+8+1 处）是署名与历史记录，
**保留**。这不是没清干净，是本来就不该动。

## 方案对比

- **A 最小清债（选定）**：只改 package.json 四字段 + README 徽章一行。
  改动面 2 个文件、5 行，零业务行为变化。
- B 连自更新器一起改造：改业务行为（update.js 指向/token），超出「清债」
  范畴，风险高收益低，否。
- C 激进抹掉所有上游痕迹：违反署名要求，否。

## 改动内容

```jsonc
// package.json
"repository": { "type": "git", "url": "git+https://github.com/xiuchuan666/dsh-purge-maintained.git" },
"homepage": "https://github.com/xiuchuan666/dsh-purge-maintained#readme",
"bugs": { "url": "https://github.com/xiuchuan666/dsh-purge-maintained/issues" },
"engines": { "node": ">=24" }
```

```html
<!-- README.md:20 -->
Node.js-%3E%3D24   <!-- 原 %3E%3D18 -->
```

## 非目标

- 不改 lib/update.js、client.js、release.yml
- 不动任何上游署名
- 不改任何测试/校验器逻辑

## 验收标准

1. `npm run check` 全绿 10/10
2. 实测演练台「检查更新」按钮不崩（404 静默失败，与改前等价）
3. `node -p "require('./package.json').repository.url"` 输出新仓库
4. 提交推送 → 远端 CI success、Release skipped（保险丝仍生效）
