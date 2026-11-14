# 维护手册

本仓库是个人长期维护基线。默认开发分支为 `main`，维护环境使用 Node.js 24；不增加第三方运行时或开发依赖。

## 每次修改前后

```bash
npm run check
```

该命令依次完成：

1. `npm run check:syntax`：检查 `bin/`、`lib/`、`scripts/` 与 `client.js` 的 JavaScript 语法，并动态导入 `lib/index.js`。
2. `npm run check:metadata`：检查 `package.json` 版本与 `release-notes.md` 首行一致、`dshTarget` 在 `dshTargets` 内、补丁 ID 唯一且有效。`ALL_PATCHES` 的数组顺序是实际应用顺序，不要求数字 ID 升序，也不为重排而重排。
3. `npm run check:eol`：行尾约定校验（见下节「行尾约定」）。
4. `npm run check:client`：前端产物链校验（见下节「前端产物链」）。
5. `npm run check:gates`：闸门侧表与补丁注册表的对账（见下节「闸门侧表」）。不读宿主，裸 runner 上也能跑。
6. `npm test`：`node --test "scripts/test-*.mjs"`，离线、默认不含覆盖率，实测约 1 秒。

默认检查不读取或改写 DSH profile，不应用宿主补丁，也不需要安装宿主。补丁数量从 `ALL_PATCHES` 动态读取，不在检查器里固定写死。

新增独立回归测试时，将文件命名为 `scripts/test-<主题>.mjs`，失败时设置非零退出码或抛出异常，成功时正常退出。测试临时数据放在系统临时目录，并在结束时清理。

命令分三层，按「什么时候跑」选：

| 命令 | 用途 | 耗时 | 需要什么 |
| --- | --- | --- | --- |
| `npm test` | 改完就跑。只跑测试 | 约 1 秒 | 无 |
| `npm run check` | 提交前跑。语法 + 元数据 + 行尾 + 前端产物 + 闸门侧表 + 测试 | 约 3 秒 | 无 |
| `npm run test:full` | 想知道「有没有让覆盖率倒退」时跑。测试 + lcov + 与基线比对 | 约 2 秒 | git 工作副本 |

`test:full` 用的是**棘轮基线**（`docs/test-baseline.json`），不是百分比阈值：只要求每个文件的行 / 函数 / 分支覆盖不低于记录值，涨上去之后用 `npm run test:baseline` 手动刷。理由很实际——把阈值定在 17% 等于宣布 `lib/core.js` 烂着也算合格；棘轮只记住「现在是多少」，然后逼它单向往上走。

无 `.git` 的目录（例如 `npm pack` 解包出来的 tgz）跑 `test:full` 会返回退出码 2 并说明原因，不会误报覆盖率下降：`lib/update.js` 里 `gitHead` / `canGit` 的 catch 分支在无 git 时走不到，行数天然少十几行。这是环境差异，不是倒退。

### 环境容差（ENV_TOLERANCE）

有极少数文件的分支命中数取决于**跑测试那台机器的文件系统现状**，同一 commit 在不同机器 / 不同残留状态下会漂几个。
这种漂移不是「测试变差」，所以给它们登记容差，而不是每次换机器就刷一遍基线。

当前只登记了一格（`scripts/coverage-baseline-lib.mjs`）：

```js
export const ENV_TOLERANCE = {
  'lib/desktop.js': { fnh: 2, brh: 4 },
}
```

依据（2026-11-12 实测，commit `b18b3f4` 的干净 worktree）：`lib/desktop.js` 连跑 4 次稳定在 `fnh 72 / brh 310~311`；
把 `%TEMP%` 下遗留的 `dsh-purge-asar-rename-when-idle-*.ps1` 与两个日志移走后 brh 从 310 变 311；
换成空 `HOME` / `USERPROFILE` 跑则掉到 `69 / 308`。原因是这些分支挂在 `existsSync` / `readdir` 的结果上：
`~/.dsh` 在不在、TEMP 里有没有上次重启留下的脚本、npm 全局装没装 DSH。

规矩：

- 容差内的下跌**仍然列进报告**，前缀是 `~`，例如 `~ lib/desktop.js 分支 312 → 311 (-1，在环境容差 4 内)`。看不到的容差等于没有。
- 超出容差照样红。`test-coverage-baseline.mjs` 有一条「容差不是免死金牌」专门钉这个。
- 加容差之前必须先在干净 worktree 里复现出同样的下跌，否则就是拿容差掩盖真倒退。
- 容差只针对**命中数**（`lh` / `fnh` / `brh`），行数与总数的比较逻辑不受影响。

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

## 测试地图：哪个能力坏了，看哪一行

[测试地图](docs/test-map.md) 把每个能力对到具体守卫，按子系统分十节。改东西前先查两件事：

1. 我要动的这块，有没有守卫？表里 `—` 或 `❗缺` 就是没有，改完只能靠手验。
2. 我要加的能力，加完记得补一行，否则它从第一天起就是盲区。

地图里 `❗缺` 的行是待办池。挑活的标准写在文件末尾：优先挑「改坏了没人能发现、且用户能感知」的——提示词注入与 HTTP 路由排在计分口径前面。

补测试时优先抓**跨路径一致性**：同一个数字由三条路径分别算出来（例如演练台的面板 / 报告 / 攻击链），只断言「三处相等」还不够——三处一起错的时候仍然全绿。要么先把其中一处改成错的值验证会红（RED），要么把条目级字段（`counted` / `capped` / `points`）也逐条钉住。

### 写测试的约定（node:test）

所有测试用 `node:test` 的 `test()` 而不是顶层裸 `assert`。理由不是「更现代」，是**一次看到所有失败**：裸 `assert` 第一条红就抛出，同一个文件里后面的断言永不执行，于是「修一条、再跑、又红一条」这样来回。实测对照过——同一个文件里故意坏两处，裸 `assert` 只报第一处，`node:test` 同时报两处并各自带用例名。

```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("缓存命中时不再重建", () => {
  // 每个 test 自带隔离：临时目录、临时 store、临时环境变量
});
```

三条硬约定：

- **每个 test 自带隔离。** 不要依赖同文件里前一个 test 留下的状态，即使 `node:test` 默认按声明顺序串行。将来一旦有人加 `--test-concurrency` 或调整顺序，依赖顺序的测试会变成假红，而假红会训练人忽略红字。
- **`test.after()` 清理临时目录。** Windows 上目录被占用会静默残留，攒多了干扰下一次运行。
- **改环境变量要在 `finally` 里恢复。** 例如 `USERPROFILE` / `HOME`——`os.homedir()` 每次调用都重新读，改了立即生效，忘了恢复会污染同进程后续所有用例。

- **测试要在 Linux 上也能过。** CI 跑在 `ubuntu-latest`，而开发机是 Windows。最容易踩的是 `path.basename`：在 Linux 上它**不把反斜杠当分隔符**，所以 `'C:\\x\\DeepSeek Harness\\DeepSeek Harness.exe'` 整串会被当成一个文件名，断言「官方 exe 走 windows-official 分支」在 CI 上变成 `helper`。写路径常量一律用正斜杠（`C:/x/DeepSeek Harness/DeepSeek Harness.exe`）——被测代码里的 `path.basename` 在 Windows 上同样认正斜杠，两边结果一致。这条是真实事故：`580c273` 本地全绿、CI 红了一条。

- **只在一侧成立的代码路径，要在测试里把平台「伪造」出来。** 与上一条同源但更狠：`lib/hide-console.js` 的 `installHideConsoleIntoBin` 第一句就是 `if (process.platform !== "win32") return "skipped_not_win32";`，十条注入/还原用例在 Windows 上全绿，到 `ubuntu-latest` 上集体变成 `actual: 'skipped_not_win32'`（`2fbe512` 就是这么红的）。做法是把它们包一层 `asWin32()`：

  ```js
  function asWin32(fn) {
    if (process.platform === "win32") return fn();
    const desc = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, "platform", desc);
    }
  }
  const testWin = (name, fn) => test(name, () => asWin32(fn));
  ```

  `process.platform` 是 configurable 的，可以临时改、`finally` 里恢复。**反向也要能自测**：在 Windows 上想确认这些用例真的会在 Linux 上过，用 `--import` 预加载一个「把 platform 改成 linux 且不还原」的小文件，再跑同一个测试文件：

  ```js
  // .tmp-linux-preload.mjs —— 用完即删，不进仓库
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true, enumerable: desc.enumerable });
  ```

  ```bash
  node --import ./.tmp-linux-preload.mjs --test scripts/test-hide-console.mjs
  ```

  两个细节：`--import` 必须排在 `--test` 前面；预加载里**不能**在 `finally` 还原，否则 `test()` 的回调执行时平台已经变回 win32，等于没测。别用「先 `await import()` 测试文件、再还原」的写法——那只覆盖模块求值期，回调在还原之后才跑，会得到一堆看不懂的假红。

  **这条要按函数而不是按「我记得」执行。** `e3761ab` 就是漏了：`scripts/test-silence-flash.mjs` 里 18 条用例直接调五个 `silence*` 与 `stubDoctorSupervisor`，只有 3 条显式伪造了平台，其余靠开发机恰好是 Windows 通过；推到 `ubuntu-latest` 上闸门早退、文件一个字节没改，**一次红 17 条**。所以写完一批用例，先把「被测函数里有没有 `if (process.platform !== "win32") return …`」列一遍（`grep -n 'process.platform' lib/<file>.js`），有闸门的函数**每一条**用例都包 `asPlatform("win32", …)`，然后在本地跑一次 `node --import ./.tmp-linux-preload.mjs --test scripts/<file>.mjs` 才算验完。

  注意预加载只能伪造 `process.platform`，**伪造不了文件系统语义**：NTFS 大小写不敏感、`chmod 0o444` 挡不住写入，所以那几个「靠 Linux 才测得到」的用例在本地仍然会红（`adaptInDir` 的小写匹配、只读文件写失败），那是仿真的边界，不是新问题。

- **路径 fixture 一律正斜杠：改成「只在 Windows 上跑」不算修。** `ddfcd58` 就是这么红的：`scripts/test-host-clean-floor.mjs` 里三条 `rememberDesktopInstallForHandoff` 用例拿 `"C:\\Program Files\\Harness\\app\\DeepSeek Harness.exe"` 当输入，本机全绿，到 `ubuntu-latest` 上 `path.dirname` 不认反斜杠、返回 `"."`，于是「写盘内容」断言拿到 `".\n"`。正确的做法是**把 fixture 改成正斜杠**（被测代码在两边都认），只有「反斜杠要归一成正斜杠」本身是测点时，才单列一条 `if (!IS_WINDOWS) return;` 的用例。判据同第 105 条：`grep -n '\\\\' scripts/test-*.mjs`，凡是出现在路径字面量里的反斜杠，都要能说清「为什么这条只能在 Windows 上跑」。
  同一个 bug 还有第二面：`rememberDesktopInstallForHandoff` 写进 `DSH_DESKTOP_INSTALL` 的是**未归一**的 `installDir`（只有落盘那份把 `\\` 换成 `/`），所以 Windows 上这个环境变量是反斜杠形态。断言不能写死正斜杠，要写 `path.dirname(path.normalize(exe))` —— 让期望值按本机算，而不是按记忆算。
  还有第三面，是这条纪律最锋利的地方：**fixture 里出现反斜杠，等于顺手测了 `path.normalize` 的平台差异**。`scripts/test-host-clean-floor.mjs` 里「同一棵宿主只差斜杠方向」那条用例，靠的是被测代码那句 `path.normalize(b).toLowerCase() === path.normalize(aiBase).toLowerCase()` —— 而 `path.normalize` 只在 Windows 上把 `\` 折成 `/`。于是这条用例本机绿、CI 红（`30261f4` run 43395962708，`actual: ['C:/host/@deepseek-ai','c:\host\@deepseek-ai']`）。处理办法与上一条同：**拆成两条** —— 大小写那条跨平台（`C:/HOST/@DeepSeek-AI` vs `C:/host/@deepseek-ai`），斜杠那条 `if (!IS_WINDOWS) return;` 并包一层 `asPlatform("win32", ...)`。判断「这条用例依赖的是分隔符语义还是大小写语义」，比笼统地「加个 Windows 守卫」有用得多。

- **只改 `PATH` 的沙箱不叫沙箱，npm 的全局前缀探测会绕出去。** `findNpmPrefix()` 的退路是 `npmQuery(["prefix", "-g"])`，问的是 npm 自己 —— 也就是说 `PATH` 上没有 `dsh` 启动器时，它会读回本机真实的 `%APPDATA%\npm`。批62 就是这么把用户的启动器改坏的：`scripts/test-backup-revert.mjs` 里一条 `revertAllShims()` 用例，跑一次把 `dsh`（1214B → 834B）和 `dsh.ps1`（1310B → 873B）剥回未注入状态、还删了两份 bak。凡是会遍历 `listShimDirsForPatch()` / `findNpmPrefix()` / `listDesktopCommandRuntimeDirs()` 的测试，沙箱里这四项都要钉：

  ```js
  process.env.PATH = path.join(root, "plainbin");
  process.env.APPDATA = path.join(root, "appdata");
  process.env.LOCALAPPDATA = path.join(root, "localapp");
  process.env.npm_config_prefix = path.join(root, "npm-prefix"); // npm 会听这个变量
  ```

  验法是跑前跑后对本机启动器做 SHA-256 比对，变了就是又漏出去了。这条只在「`PATH` 干净但 npm 全局存在」的机器上暴露 —— CI 的 ubuntu-latest 恰好是这种机器，而开发机常常不是，所以本地全绿不代表没漏。

- **判定的平行实现比没有判定更危险：死代码长得像权威。** `scripts/verify-target.mjs` 里曾经有两份 `patchApplied()` / `remainingWork()`，CLI 后来改成直接问 `lib/core.js` 的 `filePatchOutcome()`，那两份就没人调用了 —— 但它们还在文件里、还在同一个函数名上、还带着完整注释。给 #42 加两条 legacy 守卫（`legacyApplyPathStarts(hay) > 1`、`STALE_LEGACY_APPLY_CALL`）时，core 那份改了，CLI 那两份没改；于是「已经升过级的树上 #42 算不算完成」在同一个仓库里有两个答案，谁照着死代码再抄一遍就当场分叉。判别办法是搜同名函数：`grep -n "function patchApplied" -r lib scripts` 多于一处就该问「哪一份在被调用」。修法是把它收敛成一份（`scripts/verify-target-lib.mjs`），再留一条源码形状断言：这四个名字不许再出现在 CLI 里。

  顺带记两条同批学到的：**多行锚点要用子串替换，不要用整行匹配**（`line()` 是整行精确匹配，把两行源码拼成一个字符串传进去只会得到 ANCHOR 0；演练脚本第一轮 5 条 ANCHOR 全是这个原因）；**断言要写在会被观察的出口上**（`detail 恒开` 那条 GREEN，是因为注入点在 drifted 分支的 `if (detail)`，而真正决定「关掉时给不给证据」的是返回值的 `detail: detail ? notes : undefined`）。
- **工厂注入的模块在创建那一刻就把 deps 解构走了，所以「换个实现」不能改对象属性。** 拆 `lib/host-clean-floor.js` 时第一版测试写 `d.resolveOfficialAiBase = async () => { throw new Error("asar 读不了"); }`，跑出来 `ok: true` —— `createHostCleanFloor(deps)` 里 `const { resolveOfficialAiBase } = deps;` 早就把旧函数拿到手了，改 `d` 上那个属性对闭包没有任何影响。修法是把「可拨的开关」放进闭包看得见的地方（一个 `state` 对象），deps 里放转发函数：`resolveOfficialAiBase: async (base) => state.resolve ? state.resolve(base) : state.located || { aiBase: base }`。同一个坑还让四条用例连着一片假红。凡是用 `Object.assign(d, over)` 造 deps 的地方都要这么看一遍。
- **假实现返回的形状要照抄真实那条路的形状，少一个字段就会造出假红。** 假 `applyPatchesAllHosts` 一开始只回 `{ report, hosts: [{ aiBase }] }`，而真实的每台宿主都带 `report / summary / hostWritten / flash`（`lib/core.js:2035-2041`）。少了 `flash`，`allHosts.every((h) => h.flash?.ok === true)` 恒假，于是「打完就该干净」的用例全报「清洗没有完成，已取消重启」。写假实现之前先读一遍真实现里 `push` 的那个对象字面量，比对着抄。
- **断言要照真实现写，不要照想象写。** `ensureHostClean` 里「当前宿主不在枚举结果里就排到最前面」这条只对第一次 `patchStatus` 生效：`applyPatchesAllHosts` 内部自己又枚举了一遍（`lib/core.js:2022`），不吃外面补的那一份，所以打完之后的宿主清单里不会有它。我按「它会在清单里」写断言，红了一次才发现真实现就是「第一次查得对、后面跟着内部枚举走」。
- **等价突变要删掉，不要为它硬凑一条用例。** 本批 RED 演练里两条突变怎么改都 GREEN，查下去发现它们根本不是「守卫没测到」，而是**改完之后代码行为完全一样**：①`home` 参数传 `null` 与传 `""`，落到 `wshLiteral(s)` 里都被当成空并写成 `var home = "";` —— 想测「入参有没有被用上」，得改成「不管传什么都写空串」；②`sh.Run('\"' + exe + '\"', 1, false);` 这一句在脚本里有三处，按子串改「第二处」改到的是另一个分支的 relaunch。判据很简单：**如果一条突变改完，把实现和测试都读一遍仍说不出「用户会看到什么不同」，那它就是等价突变**。等价突变的正确处理是删掉并在 drill 里留一行注释说明理由，而不是补一条勉强能红、却与真实风险无关的用例 —— 后者会让 drill 的「全红」变成一个不可信的指标。
- **生成文本的函数，钉的是「文本里必须有什么」，不是「这段文本真能跑」。** `officialRestartScript` 返回一份 54 行的 WSH/JScript，测试里断言的是 `taskkill.exe /F /PID` 出现两次、没有 `/IM`、`n < 80`、`WScript.Sleep(45000)`、头部三行的转义。这些都只证明**我们打算让它这么干**。真正跑起来会不会因为某个 `sh.Run` 的参数顺序写错而杀错进程，只有在一台真机器上点一次重启才知道 —— 本批恰好顺带发现一个更根本的问题：**这段脚本里带中文注释，导致它永远不会被 `wscript.exe` 执行**（`isWshAscii` 恒 false）。所以「文本对不对」和「这条路走不走得到」是两个问题，写测试时要把它们分开记：前者能测，后者写成盲区并给出检测办法。
- **「不冲突」按语义判，不按文件名判：同名同注释的两个 helper，即使今天都不可达，也要立刻合并。** 交接单说 `scripts/verify-target-lib.mjs` 与 `lib/patch-outcome.mjs` 不冲突 —— 语义上真不冲突（单树无基线五态 vs 双树有基线七态），但两个文件里各有一份 `patchReplacements()` 与 `matchesPattern()`，注释都写着同一句话「兼容两种注册表写法」「RegExp 要摘掉 g」。批65 抽 `verify-target-lib.mjs` 时是逐字照抄当时的 CLI，于是同一份补丁注册表有了两个解析器。探针实测四处已分叉：单数 `pattern` 只有一边认、`null` patch 一边抛一边回空数组、空串与 `null` pattern 一边 `true` 一边 `false`。今天一条都走不到（86 条里 `singOnly: 0`），**这正是它的危险之处**：它不产生错误答案，只等着下一个人改注册表格式时改错一份。判据不是「现在会不会错」，是 `grep -n "function <name>" -r lib scripts | wc -l` —— 同名函数出现在两个模块里就该问一遍。
- **合并平行实现时，保留更宽的那一份，并让窄的那份只做转出。** `lib/patch-outcome.mjs` 的 `patchReplacements` 认单数 `pattern`、容忍 `null`、空串 pattern 判不命中；`verify-target-lib.mjs` 那份三条都不认。合并方向不是「取交集」也不是「抄一份更好的」，而是**把宽的那份当唯一实现**（宽 = 少一种静默丢证据的路径），窄的那边改成 `import` + `export { ... }`，公开面一行不改、调用点一行不改。等价性要三条独立证据：CLI 的 `--pad` 全文 stdout `diff` 为空、`--json` 的六个数与 86 行 `[id,status,files]` 三元组逐行相等、两平台测试全绿。
- **转出型 helper 的用例要断言「是不是同一份」，不是「算出来对不对」。** 原来那两条用例断言 `patchReplacements({ patterns: ['x'], replace: 'z' })` 返回什么 —— 换成转出之后这种断言仍会绿（因为两份实现碰巧在这条输入上一致），**证明不了「只有一份」**。改成 `assert.equal(lib.patchReplacements, outcome.patchReplacements)` 用引用相等钉住，再补一条源码形状断言（本文件里不许再出现 `function patchReplacements(`，且 `import` 与 `export { ... }` 两行必须都在）。

**两条纪律（批70 补，都是"测试会静默量错东西"这一类）：**

- **模块顶层就算路径常量的模块，必须在改完环境变量之后才 `await import`。** `lib/desktop.js:19` 的 `const INTERNAL_LOG_PATH = path.join(os.tmpdir(), "dsh-purge-desktop.log")` 在**模块求值时**就定了，而 `os.tmpdir()` 读的是 `process.env.TEMP`。测试文件里写成静态 `import` 会被提升到所有赋值之前，日志于是落到全仓共用的那一份上——单跑一个文件时看不出来，`node --test` 并行跑 92 个文件时就会把别人的行算进 `logDelta()`。正确姿势是顶部先 `mkdtempSync` + 三个 `process.env.{TEMP,TMP,TMPDIR} = ...`，再 `const d = await import("../lib/desktop.js")`，`test.after` 里还原。判据：`grep -n "os.tmpdir()" lib/*.js` 出现在模块顶层（不在函数体里）就中招。
- **自带「退读真机」兜底的函数，测试必须把兜底显式堵掉。** `healRuntimePayload(resources, options)` 的 `sources` 缺省时会走 `runtimeHealSources()`，也就是读本机 `~/.dsh/dsh-runtimes/dsh-primary-runtime` —— 于是"空树应当自愈失败"这条用例在有真机的机器上报 `ok:true, healed:true, source:C:\Users\...\.dsh\...`。这不是环境差异，是**测试没断奶**：它测的其实是"这台机器上恰好装过 DSH"。写法是 `healRuntimePayload(res, { sources: [] })` 并自己造源目录；反过来 `runtimeHealSources` 那条用例则要显式验「`DSH_HOME` 打头、空串被过滤」。判据：被测函数的签名里有没有 `= undefined` 的 options、函数体里有没有 `?? detectXxx()` 这类兜底。
- **测「一个分发器往哪条路上走」，用文字方法名数组，不要用 `Proxy`。** `lib/redteam/store-core.js` 的 `dispatch(store, req)` 有 71 个 op，要钉的是「哪个 op 调哪个方法、第几个实参」。第一反应是给 store 套 `Proxy` 把所有方法接住并记录 —— 那样「这个 op 调了一个它根本不该调的方法」也会被悄悄接住，测试照样绿。改成 `RECORDED_METHODS` 显式列出 70 个方法名，`recorder()` 逐个装记录函数：dispatch 一旦调到没登记的方法就 `TypeError`，等于顺手把「多调了一个」也变成红。断言用**实参对象同一性**（`got[i] === want[i]`），「传了 `req` 还是传了 `req.vuln`」这种差别才看得见 —— 换成深比较会因为两者内容高度重叠而漏掉。
- **`node:sqlite` 的 `db.prepare(...).get()` 返回 null 原型对象，`assert.deepEqual` 会因原型不同而红。** `assert.deepEqual(row, { id: 1, ip: '10.0.0.5' })` 报的不是字段差异，而是 `Values have different prototypes: null vs [Object: null prototype] {}` —— 读起来像断言写错了。要么逐字段 `assert.equal`，要么 `Object.assign({}, row)` 先转成普通对象再比。这也提醒：从库里读回来的行不要直接拿去 `deepEqual`，null 原型对象在 `Object.keys` / `for...in` / `JSON.stringify` 之外的场景行为会和普通对象不一样。
- **等价突变的第三种形态：兜底目标值与兜底值恰好相等。** 前两条记的是「改完行为完全一样」与「改到另一个分支」。批74 又碰到一种：`dispatchAsync` 里 `error.message ? error.message : String(error)` 改成 `: error`，看起来是「丢了兜底」，但对 `throw "plain"`（字符串自己 `.message` 是 `undefined`，落到兜底）结果还是那个字符串，测试照样绿。判据是**把兜底分支的目标表达式与输入逐一列举**：只有当某个输入下两者产出不同，这条突变才有意义（改成 `: 'unknown'` 就红了）。凡是「删兜底 / 换兜底」类突变，先算一算兜底前后的值是不是同一个。

**第三条（批70 补）：行为层真的区分不了时，才退到源码形状断言，并把「为什么区分不了」写进注释。**

批70 有三处走了这条路，每一处都是先试过行为断言、拿到 GREEN 之后才改的：

1. **`fs.chmodSync(fp, 0o755)`** —— Windows 上 chmod 是空操作（只翻只读位），删掉它本机行为零变化。断言改成读源码：两处 `chmodSync(fp, 0o755)` 都在，且两处都在 `.cmd` 的 `continue` 之后。
2. **非 win32 的链接目标 `"../runtime"`** —— 把 `process.platform` 伪造成 `linux` 走进 `"dir"` 那条分支后，Windows 的 `fs.symlinkSync` 会把目标里的 `/` **归一成 `\`**，`readlinkSync` 读回来是 `..\runtime`。也就是说在这台机器上，"写 `/`"和"写 `\`"产出的链接完全一样，行为层不可能区分。断言改成源码里两条字面量都在（`"../runtime"` 配 `"dir"`、`"..\\runtime"` 配 `"junction"`）。
3. **`cmdEntryAlreadyGood` 末行的 `return /"%entry%"/.test(text)`** —— 它是**冗余守卫**：前一道"必须含 `if not exist "%entry%" set "entry=..."`"已经把 `"%entry%"` 带进来了，走到最后一句必然为真。这条不为它硬凑 fixture，只在注释里写明"这是冗余守卫，删掉它测试不会红"，因为按判据（改完之后用户会看到什么不同）它根本不算一条契约。

配套的反面纪律照旧：**不要为了让 drill 全红就把断言改成读源码**。先问"这台机器上这两条实现的产出真的一样吗"，一样才写形状断言；不一样就说明有区分力，只是 fixture 还不够毒。

还有一个坑值得记：**断言要查值，不只查形状。** 拆 `test-plugin-surface.mjs` 时发现过真实漏洞——把 `DEFAULTS.enabled` 从 `true` 改成 `false`，原来 13 条测试全绿，因为它们只断言「有 18 个键」「布尔键会收敛字符串」，从不查默认值本身。这类改动最该被看见：用户升级后会突然发现功能默认关掉了。

### RED 演练：反向验证怎么写（一条血教训）

补完测试必须反向验证：把被测代码改坏，确认测试真的红。这一步经常假绿，最贵的坑是**基准取错**。

演练脚本要「改坏 → 跑测试 → 写回原文」，写回的那份原文就是 BASE。**BASE 必须来自 git（`git show HEAD:<file>`），不能读工作区当前文件。** 我踩过一次：演练跑到一半被工具 120 秒上限掐断，`finally` 没执行，文件停在半注入状态（`copyRange` 的短读守卫被换成了 `break`，于是 `read(n) === 0` 时死循环）。之后每个诊断脚本都以「已经被改坏的文件」为 BASE，所谓「还原」只是把坏内容写回去，于是所有测试都超时，我还一度以为是测试写得不对。

三条配套约定：

- **每轮注入前先 `write(BASE)` 复位。** 否则上一条注入的残留会让下一条的锚点命中不到，或者红的原因根本不是这条注入。
- **锚点按「唯一整行」定位，不要手写含反斜杠/引号的多行字面量。** CRLF 文件里带 `\n` 的多行锚点必然 ANCHOR_MISS；正则里的反斜杠层数在 shell、`node -e`、JS 字符串之间会被吃掉。用 `lines.findIndex((l) => l.includes(needle))` 找行、`splice` 换行，需要同一段文字出现多次时显式指定第几处（`nth`）。
- **超时算红。** 删掉短读守卫会变成死循环，`execFileSync` 抛 `signal: SIGTERM` —— 那不是「测试跑不动」，那正说明这道守卫承重。

演练结果里 GREEN 的那几条多半是真盲区，不要当成「实现冗余」放过。处置只有两种：改测试让它有区分力（例如 `existsSync` 跟随链接时改成看目录项、`fsFor` 返回值相同就改成看探针缓存这个副作用），或者承认它不可观测、写进 `docs/test-map.md` 第十节盲区。**不要**为了让演练全红而把断言写成「读源码形状」以外的花样——源码形状断言只在真的没法从外部观测时才用。

### 现状锁定：把「我知道它不对，但现在不改」写进测试

补测试时会遇到一类代码：行为明显不对，但改它属于产品决策，不属于「补测试」这一轮。例如：

- `/own-servers` POST 永远 500（`lib/net-scope.js` 的 `writeAllowText` 引用了未声明的 `allowCache`，且忽略全部入参）；
- `scoreChain` 的 `summary.totalPoints` 恒为 `undefined`（`listScorePoints` 根本没有这个字段）；
- `addWebshell` 重复登记时不传 `status`，会把 `offline` 覆盖回 `online`（`normalizeShellStatus(undefined)` 得到 `"online"`，再被 `COALESCE` 写进去）。

处理方式统一为**现状锁定**：断言当前行为，并在用例名或注释里写明「这是现状，不是期望」。三个要求：

1. 用例名里带「现状锁定」四个字，让人搜得到、看得懂；
2. 注释写清**为什么现在不改**（属产品决策 / 上游刻意留空 / 改了要过锚点对拍）；
3. 断言要精确到具体表现（`status === 500` 且 `error` 含 `allowCache is not defined`，而不是「返回不是 200」）。

这样做的价值：改动无法悄悄发生。将来真要修，会先红一条写着「现状锁定」的用例，而不是在无人察觉的情况下改变用户可见行为。**不要**顺手「修好」这类代码——那不是补测试，是改产品。

## 宿主升级：先跑宿主基线

```bash
npm run host:status     # 与 docs/host-baseline.json 比对，只读
npm run host:capture    # 升级适配完成后，把新状态记为基线
npm run host:preview    # 升级前预演：目标版本装到隔离目录，只读，不动真宿主
```

`host:status` 自动探测本机宿主（也接受 `--ai-base <目录>`，或环境变量 `DSH_HOST_AI_BASE`），把当前状态与 `docs/host-baseline.json` 比对，输出三段：宿主版本变化、目标文件指纹变化、补丁状态迁移。结论分三级：

| verdict | 含义 | 处理 |
| --- | --- | --- |
| `ok` | 与基线完全一致 | 不用管 |
| `review` | 版本或文件变了，但没有补丁从可用跌成失效 | 记下变化，继续用；确认无碍后 `host:capture` 更新基线 |
| `broken` | 有补丁从 `settled`/`would-apply` 跌成 `drifted` | 立即列出失效补丁 ID，按 `verify-target --pad` 定位字面量 |

判定规则不在这里另写一份：`host:status` 调用 `scripts/verify-target.mjs --json`，补丁分类始终只有一处实现。退出码 `0` 表示 ok/review，`1` 表示 broken，`2` 表示探测或用法失败。

### 升级前预演：先知道会坏哪几条

`host:status` 回答的是「现在这棵树对不对」，`host:preview` 回答的是「升到某个版本会怎样」。
后者把目标版本 `npm install` 到 `.tmp-preview/`（完整 rc 树约 1.4GB，已 gitignore），
在那里跑 `patchStatus` 逐条判锚点，**真宿主一个字节都不碰**。

```bash
npm run host:preview                      # 默认预演 0.2.2-rc.2
npm run host:preview -- --version 0.2.3   # 指定版本
npm run host:preview -- --keep --json     # 复用上次装好的树，只出 JSON
```

归类只有四种，判据在 `scripts/host-preview-lib.mjs`：

| kind | 含义 | 要不要管 |
| --- | --- | --- |
| `broken-by-upgrade` | 基线是 `settled`、预演变 `drifted`/`unmatched`/`pattern_not_found` | **要改锚点**，这是这次升级的账 |
| `already-broken` | 基线本来就坏、预演还是坏 | 不是这次升级造成的，另开工单 |
| `not-applicable` | `no-file`/`na`/`skipped`/`missing_file` | 这一版根本没这个文件，不是回归 |
| `ok` | 锚点还在 | 不用管 |

结论词只由 `broken-by-upgrade` 触发：有就是 `breaking` 并列最多 8 条，没有就是 `compatible`。
预发布版本（`rc`/`alpha`/`beta`/`pre`/`next`）会在输出里显式标注 —— 预演通过**不等于**可以升级到预发布。

**它测不到的**（见 [测试地图](docs/test-map.md) 盲区 39）：锚点在但语义已经搬走、
`desktop-shell` 恒 `na`、`hooks-*`/`preset-unrestricted` 恒 `missing_file`、
以及预演树是完整 npm 树而真宿主是 42 包精简布局。方向性上只有「预演判死 = 真宿主必死」成立，反过来不成立。

基线文件 `docs/host-baseline.json` 只存相对路径与 sha256，不含绝对安装路径，入库无害；桌面补丁需要纯净 `main.js` 的验证仍走 `e2e-desktop`。

宿主升级适配、前端重建与巨型模块拆分应分别成为独立维护任务，不与无关业务修改混在同一提交。

### 升级前的三问：拦点、五态、行为

`host:status` / `host:preview` 都建立在 `.dshpurge.bak` 之上 —— 没有备份的文件（补丁从未落过盘、或补丁只是漂移）就没有对照物。针对这个盲区有三条独立命令，全部以「npm 装出来的纯净树」为基线，一个字节都不依赖 `.bak`（设计与判据见 [拦截面定位与五态判定设计](docs/maintenance-choke-facility.md)）：

```bash
npm run host:snapshot   # 宿主全树指纹（包 / 版本 / 文件哈希 / 注入标记），基线存 docs/host-tree.json
npm run host:choke      # 拦点形状扫描 ∩ --dump-config 实际加载清单 → 未覆盖的拦点
npm run host:outcome    # 86 条补丁的七态判定（applied/pending/native/stale/drifted/na/unknown）
npm run test:behavior   # 行为对拍：原版拦 / 补丁版放
npm run host:matrix     # 锚点矩阵：七档分布，dead 是退役候选，stale 是改锚点候选
npm run host:gates      # 闸门侧表：每条补丁一个行内短锚，`--write docs/patch-gates.json`
npm run host:new-patch  # 从一行上游文本长出补丁草稿（锚点由文件算出，不改写内容）
npm run host:rehearse   # 升级预演：在隔离副本上真打 86 条，一次给出六份证据
```

它们回答不同的问题：`host:choke` 说「宿主新加了哪些闸门、我一条都没管」，`host:outcome` 说「哪条该改锚点（`drifted`）、哪条该退役（`stale`）」，`test:behavior` 说「补丁还在文件里，但它真的还起作用吗」，`host:matrix` 说「补丁自己的 pattern 还命中吗」，`host:gates` 说「把 pattern 抛开，那条限制本身还在不在」，`host:rehearse` 说「换个版本打一遍，六份证据里哪一份先红」。

`host:choke` 的判据是「形状 ∩ 实际加载 ∩ 未被覆盖」：先按调用写法（`ctx.approval.*`、`ctx.sandboxPolicy.*`、`static inject`、拒绝类 `throw`、escalation 调用、模式字面量）收缩到人眼可看的量级，再用 `dsh --profile web --dump-config` 剔除没加载和 `disabled` 的，最后减掉已覆盖的包。实测 rc.1 真宿主：42 组未加载 / 26 组 disabled / 22 组已覆盖 / 11 组包内满权早返回 / 2 组上游已覆盖 → **0 个未覆盖拦点**。

`host:outcome` 里 `stale` 与 `drifted` 必须分开：`stale` 是「宿主把这段删了」（退役），`drifted` 是「宿主还留着、只是换了措辞」（改锚点）。判据是锚点在纯净基线里是否还活着，不是文件是否逐字节相同 —— 前者才是「这条还要不要打」的正确答案。

`test:behavior` 观测值只记 `{kind: value|throw, value|error: 类名}`，**绝不比对错误消息正文**：消息随上游漂移，拿它当断言等于把易碎品钉进 CI。自证方式是把它指向基线树本身 —— 两侧同源时必须大量 `broken`，永远全绿的检查等于没检查。

### 闸门侧表：一条限制还在不在，与补丁自己的 pattern 无关

补丁的 `pattern` 必须逐字节命中，因为它是要被编辑的东西。这使它成为「上游那条限制还在不在」的坏仪器：#12 的锚点引用整句，上游把两端都改了，pattern 死了而限制还在 —— 只看矩阵会退役一条仍然需要的补丁。

闸门（gate）是第二意见：取 pattern 曾命中的那一行，缩成全文件唯一的最短子串，宽度只到唯一性所需，两端对齐词边界。它对重排、重新缩进、邻近编辑都免疫，因为它不要求逐字节命中，只要求那行还在。

```bash
npm run host:gates                       # 逐条列出 needle 与 路径:行号
npm run host:gates -- --write docs/patch-gates.json   # 重生成侧表（升级后必跑）
npm run host:gates -- --compare           # 两棵树之间逐条比 needle
npm run host:gates -- --verify docs/patch-gates.json --tree rc2=DIR   # 已入库的表还描不描述这棵树
npm run check:gates                       # CI 侧：只查表与注册表的契约
```

侧表是**独立文件**而不是补丁上的字段。理由有两条：补丁定义是「对任意树的动作」，闸门是「对着某个上游版本的观察」；而且 `scripts/test-patch-registry.mjs` 断言补丁元数据与拆分快照逐字段相同，加字段等于重写那条保证。

实测 rc.1：gated 58 / no-target 14 / trace-anchored 12 / native 2。四个非 gated 的理由都不是失败 —— `no-target` 是桌面壳或 presets 这类解析不到的文件，`trace-anchored` 是锚点本身就是本插件写进去的痕迹（按构造纯净树里不可能有），`native` 是目标态等于官方原文（#2/#3）。

`--write` 之后要提交 `docs/patch-gates.json`：它是升级前后比对「同一行还算不算同一行」的凭据，不跟着进仓库就失去意义。
### 宿主契约：我们调的 API 还在不在

`host:status` 有两层判定，缺一层就会假绿：

| 层 | 看什么 | 数据 | 宿主改名时会怎样 |
| --- | --- | --- | --- |
| 补丁适配 | 86 条补丁的 pattern 还能不能在宿主源码里匹配上 | `docs/host-baseline.json` | 照样 `settled` —— 补丁改的是文本，不是 API |
| 宿主契约 | 我们调的 `ctx.webServer.register` / `settings.update` / 事件名等还在不在 | `docs/host-contract.json` | 立刻 `broken` |

补丁是**文本替换**：宿主把 `ctx.webServer` 改名成 `ctx.httpServer`，一段不含 `webServer` 字样的补丁依然能原样打上去，`verdict` 还是 `ok`，但插件启动时就崩。契约层补的就是这个盲区。

```bash
node scripts/host-contract.mjs                # 只查契约
node scripts/host-contract.mjs --json          # 机器可读
npm run host:status                            # 补丁 + 契约合并判定
```

退出码 `0` = 全部命中，`1` = 有缺失，`2` = 探测或用法失败。只读，不写宿主。

#### 为什么要优先读 `.dshpurge.bak`

宿主树里现在有 58 个 `.dshpurge.bak`，它们里面 `[dsh-purge]` 标记数为 0——**备份是官方原文**。扫描必须优先读备份，否则会读到自己注入的代码，把「我们自己加的东西」当成「宿主承诺的契约」，形成自证式假绿。

这不是理论风险。实测证据：`dsh-settings/lib/index.js` 当前文件比它的 `.dshpurge.bak` 多出 5 个方法——`register` / `get` / `ensureLegacyDocument` / `persistLegacy` / `commitLegacy`，全部来自补丁 **#42 `SETTINGS_LEGACY_API`**（`file: settings`，12 条 replacement，带 `// [dsh-purge] legacy settings api` 标记）。而 `lib/preset-default.js:109` 恰好调了 `settings?.get?.(...)`。也就是说：**这一行依赖的是我们自己注入的方法，不是宿主契约**。如果扫描读当前文件，`settings.get` 就会假通过；读 `.bak` 才会明确告诉我们「宿主没有这个」。

#### 为什么粒度要到成员，还要允许「服务包 ≠ 实现包」

只查「`webServer` 由 `dsh-host-webserver` 提供」不够——宿主保留了服务、删掉某个方法，照样崩。所以契约里每个服务都列 `members`。

但成员不一定长在服务包上。实测反例：`subprocess` 服务由 `dsh-subprocess` 提供，而 `resolveExecutable` 的方法体在 `dsh-subprocess-local/lib/index.js:1523`。只查服务包会一条都找不到。契约用 `memberProviders` 覆盖：

```json
{ "name": "subprocess", "package": "dsh-subprocess",
  "members": ["resolveExecutable"],
  "memberProviders": { "resolveExecutable": "dsh-subprocess-local" } }
```

缺失时报告会顺手告诉你方法现在在哪个包——升级当天最常见的情况不是方法消失，而是「方法还在，搬包了」：

```text
member  subprocess.resolveExecutable  dsh-subprocess 里没有 resolveExecutable() 的声明（但在 dsh-subprocess-local 里有，可能搬包了）
```

#### 契约里刻意不写的东西

- `ctx.__dshPurge*`（SessionHook / RewindDerive / PresetHook 等 10 个）：我们自己在 ctx 上挂的，不是宿主 API。
- `redteam` / `redteamMode`：我们自己 `ctx.provide` 的。
- `desktopRuntime` / `desktopActions`：宿主全树 0 命中，桌面壳的可选服务；调用处（`lib/desktop.js:1015`）已经用 `typeof runtime.requestRestart === "function"` 做了防御，写进契约只会制造噪音。
- `settings.get`：见上，是我们注入的。

这些都在 `docs/host-contract.json` 的 `notChecked` 里写明理由，避免下次有人以为漏了。

#### 判定只有一份

`host:status` 不重算契约，只调 `checkContract()` 拿结果再合并 verdict（`mergeVerdicts`：任一层 broken 就是 broken）。补丁分类同样只有 `verify-target` 一处实现。这条规矩来自补丁 #88 的历史教训——同一件事两处判定，一处改了另一处没改，就会互相打脸。

## 前端产物链（client.js）

`client.js` 由三层构成：

| 层 | 来源 | 状态 |
| --- | --- | --- |
| 主体（设置面板 / 清洗 UI / rewind UI） | 上游手写成品，源码已失传 | 只能哈希锚定，无法从零重建 |
| dock / 授权弹窗补丁 | `scripts/patch-client-dock.mjs` 四步模板，已固化进成品 | 脚本可重放（幂等守卫），「未补丁原版」不存在 |
| 演练台片段（DRILL 标记之间） | `lib/redteam/client.js` → `scripts/build-client.mjs` 抽取嵌入 | 真源码在库，可重建 |

`npm run check:client`（只读）校验三件事：

1. 锚点 `docs/origin/client-1.1.94.js` 与 `client-1.1.94.sha256` 一致（锚点取自 1.1.94 发布包，与 Git 基线 fa8d09d 的工作区版本字节一致）。
2. 当前 `client.js` 结构完整：DRILL 标记存在且顺序正确，dock 补丁锚点在。
3. DRILL 标记之间的片段与从 `lib/redteam/client.js` 现抽片段一致——**改了演练台源码忘跑 build 时这里会报错**。

改前端的正确流程：

```bash
# 1. 改 lib/redteam/client.js（演练台源码）
npm run build:client    # 2. 重嵌片段进 client.js
npm run check           # 3. 全量校验（含片段同步检测）
```

注意：

- 不要手工编辑 `client.js` 里 DRILL 标记之间的内容——那部分由 `build-client.mjs` 生成，手工改动会被下一次 build 覆盖、且 `check:client` 会报片段过期。
- 主体与 dock 补丁层可以改（改的是成品本身），但改前想清楚：这两层没有源码，改坏只能回退 Git 或从锚点对拍。
- `patch-client-dock.mjs` 重放到已补丁文件时会把全文件 CRLF 归一成 LF；`build-client.mjs` 不动主文件换行。两者的片段算法由 `scripts/client-chain-lib.mjs` 单一实现，校验器与测试共用，避免出现「校验器说同步、build 一跑却变」的分叉。
- 换宿主大版本若 client.js 需要成批改锚点，先更新 `docs/origin/` 下的锚点与哈希记录，再动成品，保持「先锚后改」。

## 补丁注册表（lib/patches/）

宿主适配时最常改的是补丁字面量，它们已从 9000 行的 `core.js` 移到短文件：

| 层 | 文件 | 行数 | 职责 |
| --- | --- | --- | --- |
| 模板 | `lib/patches/templates.mjs` | 90 | 提示词字面量、网络模板、替换链 helper |
| 注册表 | `lib/patches/patch-registry.mjs` | 276 | `PATCHES`（10 条） |
| 代码补丁 | `lib/patches/code-patches.mjs` | 42 | `CODE_PATCHES`（3 条） |
| 引擎补丁 | `lib/patches/engine-patches.mjs` | 295 | `ENGINE_PATCHES`（8 条） |
| 新工具补丁 | `lib/patches/new-tool-patches.mjs` | 3111 | `NEW_TOOL_PATCHES`（65 条） |
| 组装 | `lib/patches/index.mjs` | 8 | 按原顺序拼 `ALL_PATCHES`（86 条） |

改补丁只动 `lib/patches/` 里的数组文件；`core.js` 只保留 `import { ALL_PATCHES } from './patches/index.mjs'` 一行再原样导出。

**顺序不可重排**：`PATCHES → CODE_PATCHES → ENGINE_PATCHES → NEW_TOOL_PATCHES` 的拼接顺序就是 apply 顺序，`{id:76}` 必须先于 `{id:70}`；`npm run check:metadata` 与 `scripts/test-patch-registry.mjs` 都会盯住。

补丁内容有回归保护：`scripts/test-patch-registry.mjs` 把 `ALL_PATCHES` 与 `docs/origin/core-split-baseline-8066985/`（拆分前快照）做对象级对拍（含正则 flags、函数 replace、239 个 replacement），再用真实 `applyReplacementsToText` 跑 690 组输入。改错一个字面量这里会立刻失败。

## 巨型文件拆分（先看这一节再动刀）

`lib/redteam/store-core.js` 从 5429 行拆到 3832 行，方法是**只搬不改**：整块剪下来放进新文件，类里留一行转发。已拆出的两个模块：

`lib/redteam/tools.js` 从 2269 行拆到 474 行，方法相同但粒度不同：64 个 `ctx.tools.register(...)` 块按领域切成五组，每组一个 `register<X>Tools(deps)`，`apply(ctx)` 只剩编排（解析 store、挂 `ctx.effect` 自动释放并发名额、五行调用）。工具块本身**一字未改**（2 格缩进原样保留），所以逐行对拍能过。

| 文件 | 行数 | 装什么 |
| --- | --- | --- |
| `lib/redteam/engagement-meta.js` | 155 | 叶子模块：`ROLE_TITLES` / `SEVERITIES` / `VULN_STATUSES` / `SCOPE_SQL` / `readMeta` / `writeMeta` / `POINT_STAGE_OVERRIDE` / `POINT_SHORT_NAME` / `scoreStageOf` / `LEGACY_STAGE_MAP` / `VALID_STAGE_CODES` |
| `lib/redteam/score-report.js` | 1533 | 计分三件套：`hitTrace` / `scoreReport` / `scoreChain` / `representativeShots`，第一参一律是 store 实例 |
| `lib/redteam/tool-specs-recon.js` | 585 | 11 个工具：靶标开关、资产与端口、攻击图谱、preflight |
| `lib/redteam/tool-specs-findings.js` | 461 | 22 个工具：角色稿、漏洞、凭据、权限、webshell、隧道、截图 |
| `lib/redteam/tool-specs-scoring.js` | 393 | 16 个工具：得分点、命中、链路、报告、攻击文件 |
| `lib/redteam/tool-specs-knowledge.js` | 192 | 6 个工具：POC 知识库的增删查用 |
| `lib/redteam/tool-specs-evidence.js` | 234 | 9 个工具：证据账本、未知项、资产时间线 |

`store-core.js` 继续把 `engagement-meta.js` 的 11 个名字再导出一次，所以对外 API 不变（实测导出键从 73 涨到 77，只增不减）。

**为什么第一参传 store 而不是做成类方法**：`#hitTrace` / `#representativeShots` 是 ES private，类外写不出 `this.#x`。做法是把函数体里 `this.#hitTrace(` 换成 `hitTrace(store, `、`this.` 换成 `store.`（顺序不能反，否则 `this.#hitTrace` 先被 `this.` 规则吃掉一半），类里保留同名私有/公开方法做一行转发，调用点一处都不用动。搬运前先扫一遍确认 `bare this` 与 `arguments` 计数都是 0 —— 有任何一个，就不能这么搬。

### 三条必须遵守的操作顺序

1. **先自底向上删除，最后插 import。** 我第一次写反了：先 `splice` 插 18 行 import 块，然后按**原始行号**删 13 个区间 —— 插入点之后的所有索引整体偏移 18 行，删错位置，`node --check` 报的是一个看起来毫不相干的语法错误（把注释块里的中文当成了代码）。要么按行号降序删，要么把所有大于插入点的行号先 +18。
2. **左移缩进时要跳过模板字符串内部的行。** 类方法搬出去要减 2 格缩进，但 SQL 多行模板与 markdown 片段里的缩进是内容的一部分。判据：累计一行里反引号的个数，奇数就翻转 `inTemplate`；`inTemplate` 为真且该行不含反引号时原样照抄。`score-report.js` 里有 9 处跨行模板，漏判一处就会改变生成的 SQL 文本。
3. **搬完立刻做逐行对拍，不要只靠测试绿。** 做法：拿 `git show HEAD:<file>` 的原文，用同一套 splice 算法在内存里重跑一遍，与工作区文件逐行比对（`store-core.js` 得到 DIFF 0 / 3832 行）；新文件里的每个函数按花括号配平取出函数体，归一化（去 2 格缩进、`this.#x(` ↔ `x(store, `）后与旧版逐行比（四个函数 152/1048/178/44 行全部 diff 0）。测试绿只证明「行为没变」，对拍才证明「代码没被顺手改动」。

### 切块脚本本身的三条实测规则

1. **不能假设「第 i 个 start 配第 i 个 end」后中间只有空行。** `tools.js` 的 64 个注册块之间还夹着一条分隔注释（`/* ==== 资产发现时间线 */`）与两个局部工厂（`ledgerOf` / `unknownsOf`）。第一版脚本按 `starts[i]` 到 `ends[i]` 切，第 0 组就报 `head not a register call: "    name: 'redteam_engagement_open',"` —— 因为配对从第一个非注册行开始就错位了。正确做法：先扫 `^ {4}name: '([a-z0-9_]+)',$` 得到 64 个名字，用名字反查每块的 start/end，再把非注册行单独处理。
2. **`deps` 必须逐个核对，少一个就是运行期 `ReferenceError`。** 这一批踩了两次：`ledgerOf` / `unknownsOf`（随证据组搬走的局部工厂）与 `liveRunningChildren`（模块级 async 函数，`tools.js:327`）。做法是把 `apply` 里所有被工具块引用的标识符列出来，减去「组内自己定义的」，剩下的全进 `deps`；`bindings` / `reservations` / `bindingKeyOf` / `sessionInfoOf` / `resolveRootSession` / `capMap` / `BINDINGS_CAP` / `RESERVATIONS_CAP` / `ROLE_HINT` 这些也都要传，它们是模块级的 `Map` 与常量，不传就是 `undefined`。
3. **生成的文件要转成与同目录一致的行尾。** 源文件 `lib/redteam/tools.js` 是 LF（`lib/` 下四个 LF 例外之一），但同目录其余 `.js` 全是 CRLF。生成的五个组文件如果照抄 LF，`npm run check:eol` 会因为「新文件与同目录多数派不一致」直接红。

### 拆分顺手挖出来的两类真 bug

- **引用了没 import 的符号，被 `catch` 吞掉。** `lib/redteam/schema.js` 的 `migrate()` 里 `SCOPE_SQL` 与 `LEGACY_STAGE_MAP` 两处引用从未定义也从未 import，两段回填的 `ReferenceError` 被外层 `try { … } catch { /* 忽略 */ }` 吃掉 —— 老库的 `asset.scope` 内外网与 `attack_step.stage_code` 阶段映射**从上线起就没生效过**，且不报任何错。教训：`catch { }` 空吞的每一段，都值得单独造 fixture 跑一遍看结果。
- **只在「刚补出列」时才跑的迁移，第二次打开会跳过。** `if (ensure('attack_step', 'stage_code', 'TEXT'))` 这个写法是对的（否则每次打开都把用户显式指定的阶段打回自动推导），但它也意味着「补列」与「回填」绑死在一起 —— 补列逻辑一旦因为别的原因早退，回填就永远不跑。`test-schema-migrate.mjs` 里两条用例分别钉住「列不存在时映射」「列已存在时不重跑」。

### 拆完之后还剩下什么没拆

`lib/core.js`（5268 行）仍未拆。它是补丁引擎本身（`ALL_PATCHES` 的 apply 编排、asar 换包、shim 安装），几乎每个函数都要跨文件传一堆宿主上下文，收益不如 `store-core.js` 与 `tools.js` 那么直接，优先级排在补测试之后。真要动，先按本节的三条顺序做，别省对拍。

## 行尾约定

仓库里的行尾**按目录分工**，不是全库统一：

| 位置 | 行尾 | 为什么 |
|---|---|---|
| `lib/**/*.js` | CRLF | 与宿主解包出来的源码一致；补丁锚点按 CRLF 写，换行尾等于全部锚点 MISS |
| `scripts/*.mjs` | LF | Node 工具链习惯；`scripts/test-*.mjs` 必须全 LF |
| `README.md`、`docs/**`、`skills/**` 等文档 | CRLF | 与 `lib/` 一致，编辑器打开不会出现混排 |
| `client.js`、`docs/origin/client-1.1.94.js` | 混合 | 上游产物的逐字节锚点，一个字节都不能动 |

`lib/` 下有四个历史遗留的 LF 文件（`asset-table.js`、`bom-guard.js`、`redteam/bridge.js`、`redteam/tools.js`），`scripts/` 下有八个上游带过来的 CRLF 脚本（`build-client.mjs`、`e2e-apply.mjs`、`e2e-desktop.mjs`、`embed-default-prompt.mjs`、`ensure-profile-bundle.mjs`、`export-engagement-report.mjs`、`patch-client-dock.mjs`、`verify-target.mjs`）。这些现状由 `docs/eol-baseline.json` 记录，不要求改。

### 为什么要有 `.gitattributes`

`.gitattributes` 只有一行有效内容：`* -text`。**不要改成 `text=auto`**。

`text=auto` 的语义是「blob 里存 LF、检出时按平台转」，它会把这个按目录分工抹平，于是同一份文件在两台机器上锚点对不上。更现实的原因是这台机器上有**两个 git**：

- `C:/Program Files/git/bin/git.exe`（v2.54.0），system 级 `C:/Program Files/Git/etc/gitconfig` 里写着 `autocrlf = true`；
- dsh-ops 自带的 niugit（v2.56.0.niugit），没有 `autocrlf`。

两者对同一个文件算出的 blob 不同，**谁最后 `git add` 谁说了算**。2026-11-12 就因此让 `lib/redteam/score-report.js` 以 LF 入库，而工作区是 CRLF —— 本地全绿、CI 全绿，仓库里存的却是另一份字节。`-text` 关掉全部转换，两个 git 算出的 blob 都是工作区原始字节。

### `npm run check:eol` 查三件事

1. **文件内不许混行尾** —— 混了之后任何跨行锚点都会 MISS。`MIXED_ALLOWED` 里的两个上游锚点是唯一例外。
2. **已入库文件的行尾不许悄悄变** —— 基线记着每个文件原来是 `crlf` 还是 `lf`，变了就报错。
3. **新文件要符合同目录多数派** —— 从基线算每个目录的多数派（样本少于 3 个、或平票时不给结论），新文件不一致就报错；推不出多数派时只提示不拦。

另外单独查一次「索引 blob 与工作区只差行尾」。这条是上面那次事故的指纹：`git add` 时 autocrlf 把 CRLF 压成 LF，工作区看着没问题、`check` 也全绿，但仓库里存的不是这份字节。**只在这种「仅差行尾」的形态下报警**，普通未提交改动不报。

### 什么时候用 `--update`

只有在**确认行尾改动是有意的**时候：

```bash
node scripts/check-eol.mjs --update
```

典型场景是新增文件（跑完 `--update` 把它记进基线，之后才受第 2 条约束）。**不要**为了让检查变绿而 `--update` —— 那等于永久放弃这道守卫，跟刷覆盖率基线掩盖倒退是一回事。

### 已经踩过的坑

- **`git add` 不会重算已缓存的 blob。** 索引里已经有 LF 版本时，再 `git add` 同一文件仍然不转换。必须 `git rm --cached <file>` 后重 add，或 `git add --renormalize <file>`。
- **`git cat-file --batch` 的头部不含路径。** 输出是 `<sha> <type> <size>` + 换行 + 内容，按输入顺序逐条对应；用 `parts.slice(3)` 取路径会让所有 blob 落到同一个键下，检测静默失效（第一版就是这么错的，靠负向验证才抓出来）。内容要按声明的 size 切片，不能按行切。
- **逐个 `git cat-file blob` 太慢。** 227 个文件要起 227 次进程、实测 2.7 秒；一次 `--batch` 是 0.18 秒。

## CI 与发布

`.github/workflows/ci.yml` 在 `main` 推送、pull request 和手动触发时运行 `npm run check`。CI 使用 Node.js 24，不需要 `npm install`。

CI 里**不跑** `host:status` 与 `host-contract`：runner 上没有宿主安装，只会得到「全 no-file」的假绿。这两条是本机命令。同理，`host:snapshot` / `host:choke` / `host:outcome` / `host:matrix` / `host:gates` / `host:rehearse` 都需要宿主树或基线树，全部留在本机。

唯一进 CI 的是 `check:gates`：它只查 `docs/patch-gates.json` 与注册表的契约（缺行、孤儿行、名字不一致、跨行或绝对路径的 needle），不查闸门是否还在上游——那需要宿主树。于是它既能裸跑，又会在补丁加进来但没人记闸门的那一刻变红。

`.github/workflows/release.yml` 在发布前运行相同的 `npm run check`，但**不再由 push 触发**：本副本不发 GitHub Release（仓库私有、包标 `private`、分发只走本机 `npm pack` 产物），保留 `workflow_dispatch` 手动入口以便临时出包。仓库条件写成 `xiuchuan666/dsh-purge-maintained`，并有一条测试（`scripts/test-upstream-refs.mjs`）盯着它不要退回上游仓库名。

## 版本声明（dshTarget）与「打得动」是两件事

补丁 registry 打不打得动，看的是 pattern 能不能在宿主源码里命中；状态页报不报「未适配」，看的是 `package.json` 里 `dshTarget` / `dshTargets` 声明的版本。**这两件事互不影响，改一件不会带动另一件**，所以宿主升版时必须分别确认，不能因为 `npm run host:preview` 说 compatible 就以为状态页也会变绿。

- `HOST_TARGETS` 在 `lib/core.js:2937-2946` 现读 `package.json`：先 `dshTargets.slice()`，再把 `dshTarget` **unshift** 到最前，最后 `new Set` 去重。所以 `HOST_TARGETS[0]` 恒等于 `dshTarget`，`dshTargets` 的数组顺序不决定主目标。`HOST_TARGET` 就是 `HOST_TARGETS[0]`。
- `hostCompat()` 的三个字段别混着读：`known` = 读到宿主版本了吗；`ok` = 声明里认这个版本吗；`host` = 读到的原文。没声明过的版本必须 `known:true` + `ok:false`（判成 `known:false` 会让状态页什么都不显示）；读不到宿主 / 版本解析不了必须 `ok:null`，因为 `gatherState()` 用的是 `hostInfo.ok !== false`，也就是 null 算支持。
- `host_supported === false` 只影响状态页那一行（`lib/status-render.js:77-82` 打「← 未适配」），**不阻断 apply**。所以「未适配」不是故障，是提示。
- 预发布后缀必须原样相等：`0.2.2-RC.2` 与 `0.2.2-rc.2` 不相等（`parseHostVersion` 保留原样，比较时不做 lowerCase）。`hostCompat` 里 `Boolean(b) && …` 会把解析不了的目标**静默跳过** —— 等于「声明里写错一个版本」就是「少声明一个版本」，只在升级当天才暴露。`test-host-target-decl.mjs` 因此有一条「每一项都必须能被 `parseHostVersion` 解析」。
- 推 `dshTarget` 时**不要顺手刷 `docs/patch-gates.json`**。那张表的 `tree.version` 记录的是「这批 needle 是在哪一版上取的」，跨版缺失就是 bump 时的返工量；跟着一起 `--write` 会把几十条纯行号漂移也写进去，把「哪几条 needle 真的变了」淹掉。`docs/host-baseline.json` / `docs/host-contract.json` 同理 —— 它们是观测快照，手改等于伪造观测。

包本身已标 `"private": true`，`npm publish` 会直接拒绝。对外发布渠道只有本地 `npm pack` 产物（`$DSH_HOME/plugins/*.tgz`）。

### 假外部依赖：先问「它是不是可写数据属性」

`lib/update.js` 的下载链要在开关关着的情况下测，唯一的办法是把 `https.request` 换掉。能不能换、怎么换，有三条实测规则：

- **`https.request` 是 `{ writable: true, configurable: true }` 的数据属性**，可以直接赋值。`lib/update.js` 里 `import https from "node:https"` 拿到的是同一个模块对象，调用时才读属性，所以「替换后 `await import`」与「import 后替换」都生效。但**测试文件必须自己 `finally` 还原**，否则同进程里后面跑的测试会撞上一个假网络。
- **假的 `res` 不要覆写 `resume`。** 为了观察 302 有没有被消费而写成 `res.resume = () => {}`，会让 `Readable` 永远进不了 flowing 态、`'end'` 不触发，于是 Promise 永挂 —— `node --test` 报的是 `cancelled`（超时）而不是 `fail`，看起来像环境问题。要观察就 `const base = res.resume.bind(res); res.resume = () => { base(); }`。
- **`async` 函数的入参炸出来是 rejected promise。** `overlayFromZip(null)` 里 `dests.filter` 立刻 TypeError，但断言必须 `await assert.rejects(...)`；写 `assert.throws` 会红在「没有同步抛」。
- **改函数签名前先看有没有测试按「签名文本」切函数体。** `scripts/test-update.mjs` 的 `bodyOf(sig, nextSig)` 用 `SRC.indexOf(nextSig, from)` 切片；给下一个函数加上 `export ` 前缀后，`indexOf` 命中位置在 `export ` 之后，上一段的尾巴留下一个 `export `，`body.trimEnd().endsWith('}')` 就变成 false。修法是切之前 `to = SRC.lastIndexOf("\n", to) + 1` 退到行首。

一个提醒：这一层在本副本里是**死路**（`ONLINE_UPDATES_ENABLED = false`），所以它坏掉时用户看不到任何报错 —— 点了更新什么都没下载、或者回退版本时把工作区覆盖了。正因为它平时不跑，才更需要有测试盯着那几条护栏（https 强制、跳转白名单、跳数与自环、50MB 上限、`git` 覆盖前的脏检查）。

### 报告链路的两个「传了但没实现」

`lib/redteam/score-report.js` 是拆分出来的（`d48f3d8`），`lib/redteam/report-replay.js` 是上游原样带过来的。两个文件各有一处「调用方把参数递过去了，被调用方根本没看」的缺陷，而且**都活在 `try { } catch { }` 后面**，2976 条测试全绿也照不出来。

1. **漏 import**：`tunnelIsLegit` 在两个函数里被调用，import 列表里却没有这个名字 → `ReferenceError` 被 `catch` 吞成空数组。修复一行，但发现它的方法值得留：**拿被依赖模块的导出名并集，去比对「本文件正文出现过、import 声明里没有」**，一次就能扫出来（在全仓 `lib/` 上跑出 25 行，只有 1 行是真的；其余全是方法名 `ctx.apply(...)`、对象字面量键 `setActive(rules)`、可选链 `db.exec?.(...)` —— 判据必须排除前导 `.` 与 `?.`，否则误报淹没真问题）。
2. **参数被忽略**：`buildCurlCommand(options)` 不收 `options.headers`，而调用方把筛过的 `authorization|content-type|...` 传进去了 → 合成出来的 curl 缺认证头，复现得 401/415。

判据：**一个函数「接受某参数」不算契约，只有「测试断言了该参数的效果」才是契约。** 这两处的共同点不是写错，而是**没有任何用例问过「登记了隧道之后读出来是什么」「带请求头合成出来的 curl 长什么样」**。所以写完一批之后要问的是：我这批用例里，有几个是断言**效果**的，几个只是断言**形状**？

报告链路另有三条读源码看不出来、只能行为用例钉的现状：`scoreReport().items` 是 SQL 顺序而 `chain_no` 在排序副本上算（两者可以不一致）；`scoreChain().stages` 是五段定长表、`scoreReport().stages` 过滤空阶段，但两者的 `ordinal` 都保留链路真实位置；`representativeShots` 的候选池按关联强度分层 push，`sort` 却只比 `kind → captured_at → id`，**分层不影响先后**。

### 判「补丁打到哪棵树、配置读哪个主目录」时踩到的三件事

`lib/core.js` 的宿主树 / 主目录定位簇（`isAiBase` 那一串十四条）判错时不会抛错，只会让整批补丁落到错的那棵树、或让写进 `prompt-inject.md` 的东西永远不生效。写 `scripts/test-host-locate.mjs` 时踩到的三条，以后凡碰 `os.homedir()` / `process.env` / 目录 fixture 都要先想一遍：

- **`os.homedir()` 读的是 `process.env`，不是你手里的 `options.env`。** `findDshHome` 的兜底分支用 `os.homedir()` 拼 `~/.dsh`，所以只把沙箱环境塞进 `options.env`（甚至只塞进被调函数的参数）完全不够 —— 实测那一支会返回真机的 `C:\Users\Administrator\.dsh`，用例在「四处都没有时仍回 `~/.dsh`」上直接红。修法：`withEnv(sandboxEnv(home), () => core.findDshHome({...}))`，与 `test-shim-patch.mjs` 钉 `TEMP`/`npm_config_prefix` 是同一类处置。
- **fixture 不要落在别的用例已经造过的目录下。** 测 `pnpmProjectRootNear` 的「非 pnpm 往上找不到」时，把 fixture 放在 `<ROOT>/near/plain/node_modules`，而 `<ROOT>/near` 本身是上一个用例造的 pnpm 根 —— 往上第 3 层真命中，判据对、断言错。目录 fixture 一律用**独立顶层目录**（`near-plain`），不要复用父级。
- **判据「要目录」还是「要存在」必须分开造样本。** `isAiBase` 查的是 `<base>/dsh-agent-instructions/lib` 是**目录**，而「同名文件冒充」有两种：冒充 `<base>` 本身（第一版只造了这一种，于是把 `isDir` 换成 `fs.existsSync` 的突变仍是绿的），以及冒充最末一级 `lib`（这一种才有区分力）。**写「文件冒充」类 fixture 时，要问一句「我冒充的是哪一级」**。

另外：给 `lib/core.js` 加 `export` 会撞 `scripts/test-patch-registry.mjs` 的「公开导出名一字不差」——那是拿 `docs/origin/core-split-baseline-8066985` 对拍的。正确做法是把它加进该文件的 `EXPORT_EXTRA` 白名单（同时保留「删导出必红」「白名单过期也红」两条），**不要**把断言放宽成「子集」。

### `hostFs` 不是 `node:fs`：任何 `fs.x.y` 形式的原生扩展属性都是 `undefined`

`lib/core.js` 顶上的 `fs` 是 `hostFs`（`lib/extract-asar.js:164`），它把 `node:fs` 的每个同步方法用 `route()` 包成箭头函数（为了在 Electron 里把 asar 路径路由到 `original-fs`）。箭头函数**没有**原函数的扩展属性，于是：

- `fs.realpathSync.native` → `undefined`（`node:fs` 上那个是函数）；
- 同类还有 `fs.readFileSync` 之外任何带 `.native` / `.x` 的用法（例如 `fs.statSync.native`、`fs.promises` 的扩展）—— 一律先想「`hostFs` 里有没有这个键」。

代价是**代码能跑、异常被吞、功能静默失效**。真实例子：`enumeratePatchAiBases()` 的去重写着 `real = fs.realpathSync.native(n)`，外面一个 `catch { /* 保持 n */ }`，于是每次都抛 `TypeError: fs.realpathSync.native is not a function`、每次都退回原路径 —— 注释标着「M37 避免 symlink/junction 打成两套」，而这条去重**从 1.1.94 起一次都没生效过**。找它的办法只有一个：让两条指向同一棵树的路径同时进候选表，然后数表里有几条。

写这类代码的正确姿势：

- **原生扩展优先用 `node:fs`**（`lib/core.js` 顶上已有 `import nodeFs from "node:fs"`）：`nodeFs.realpathSync.native(n)` 一定存在；只有 asar 内路径才需要 `hostFs`。
- **回退链要写全**：`try { nodeFs 的 native } catch { try { hostFs 的普通版 } catch { 保持原样 } }`。少一层就会出现「在解包布局上对、在 asar 布局上静默失效」。
- **非 native 的 `realpathSync` 对 junction 会返回 8.3 短名**（`C:\Users\ADMINI~1\…`），和长名不是同一个字符串 —— 也就是说它是**不完整的**归一，只能当兜底，不能当唯一实现。
- **写测试时把 `hostFs` 当普通对象用**：它的属性是可写数据属性，`hostFs.writeFileSync = () => { throw ... }` 能直接造出写失败路径（批 76 就靠这个测 `error:` 前缀）。但 `nodeFs` 的不要改，它是真 `node:fs`。

顺带记一条 fixture 事实：`os.tmpdir()` 在 Windows 上返回的常常是 8.3 短路名（`…\Temp\` 里的上层是 `ADMINI~1`），而 `fs.realpathSync.native()` 返回长名。所以「同一路径的两种写法」在临时目录里天天都会出现 —— 这既是批 77 那个 bug 能被看见的原因，也是写路径断言时最容易踩的坑：**断言路径相等前先 `path.normalize` + 统一斜杠 + 小写，或者干脆两边都过一遍 `realpathSync.native`**。

## 更新链路（已固定为离线）

维护仓库是私有的，GitHub 的 `codeload` / `api` / `raw` / `jsdelivr` 对匿名请求全部 404。因此：

- `lib/update.js` 里 `ONLINE_UPDATES_ENABLED = false`，`checkUpdate()` 与 `applyUpdate()` 直接返回明确错误，不把 404 吞成「已是最新」。
- 启动路径恒不自动升级（`autoUpdateIfNeeded()` 返回 `skipped: "manual-only"`）。
- 本机升级只走「改版本号 → `npm run check` → `npm pack` → 换 tgz → 重装 profile」这一条路，步骤见 [README](README.md) 的「更新策略」。
- 不要为了「让面板更新能用」而把仓库改公开或往代码里塞 token：前者泄露全部维护内容，后者把长期凭据写进插件。

## 回退

普通修改以小提交落在 `main`。发现问题时用 `git revert <commit>` 保留可追踪的回退记录；不要用历史覆盖作为日常回退手段。基线首个提交为 `fa8d09dec92cf582412c28566273147076e79f24`。

详细设计与本阶段边界见 [测试地图](docs/test-map.md)、[统一验证与 CI 设计](docs/maintenance-verification.md)、[宿主适配基线设计](docs/maintenance-host-baseline.md)、[前端产物链设计](docs/maintenance-client-chain.md) 与 [补丁注册表拆分设计](docs/maintenance-core-split.md)，以及[测试机制设计](docs/superpowers/specs/2026-11-11-test-mechanism-design.md)、[拦截面定位与五态判定设计](docs/maintenance-choke-facility.md)。


### 回退侧的三条纪律（写测试与被测代码各一条）

**一、回退必须逐字节，不能「功能上等价」。** 注入时为了语法会在相邻行补逗号（`detached: platform !== "win32",`），摘掉注释块之后那个逗号就孤立地留在原地 —— Node 照样跑，只有对拍才发现还差一个字节。所以 `revertCmdFlash` 的 subprocess 回退现在是一条 `/,?\n\t\t\/\/ …\n\t\twindowsHide: true/`：**逗号归它管**。写这类回退时唯一的判据是「把注入前的原文喂进去，回退后必须 `===` 原文」，不是「读起来一样」。

**二、收下形参就要用形参。** `revertCmdFlash(aiBase, dshHome)` 曾经在 subprocess 分支里另起一次 `findAiBase()`。开发机上两者永远相等，所以这个 bug 活了很久，直到「指定树回退」的用例出现。凡函数签名里带宿主树/主目录的，回退侧与被回退侧必须走同一个值；测试要有一条「把 aiBase 指到别处，文件不许动」的用例，否则这类 bug 完全没有观测面。

**三、「跳过」和「收工」是两件事。** `rewriteFiles` 读不到文件是 `continue`，不许 `return`：第一份读不到、第二份还能改，返回值必须是 `reverted`。批 76 的 RED 演练里就有一条 `continue → return "missing"` 的突变，最初是绿的 —— 因为用例只喂了一个读不到的文件。补一条「读不到 + 后面能改」之后才有区分力。

**drill 自己的坑**：做行尾归一化时先 `replace(/\r\n/g, "\n")` 抹平再补 EOL，否则已经含 `\r\n` 的锚点会变成 `\r\r\n`，`indexOf` 永远 0 命中（批 76 有两条 ANCHOR 就是这么来的）。

### 跑「一键应用到所有宿主」相关测试时，`DSH_BASE` 是保命的

`findAiBaseWeb()` 在 `DSH_BASE` 可用时提前返回。一旦它为空、或指向某个桌面安装树内部（会被 `isInsideDesktopInstall` 拒掉），它就会退到「当前进程所在的树」——在开发机上是 `D:\dsh-purge-maintained\node_modules\@deepseek-ai`。于是 `enumeratePatchAiBases()` 会返回 `[仓库树, 桌面树]`，`applyPatchesAllHosts()` 真把补丁写进 devDependencies，还留下 `.dshpurge.bak`。

所以凡是要调用 `applyPatchesAllHosts` / `revertAllHosts` / `enumeratePatchAiBases` 的测试，`DSH_BASE` 必须**始终**指向沙箱树；`test-all-hosts.mjs` 里还额外有一条断言专门盯「宿主表里不得出现仓库树」。踩了之后复原的方法：在被打过的那份备份旁边 `cp index.js.dshpurge.bak index.js && rm -f index.js.dshpurge.bak`，然后 `grep -c "ACTIVE and MANDATORY" index.js` 应为 0。

### fixture 少造一个文件导致覆盖率下降，补 fixture，不要 `--update`

`installTree()` 一开始没造 `resources/runtime/cli/bin/dsh.cmd`，`lib/desktop.js` 的行覆盖立刻从 1818 掉到 1813 —— 基线判定直接 FAIL。这不是「覆盖率噪声」，是这份 fixture 比真宿主少一样东西，于是真宿主会走的分支没被走到。正确处置是把 fixture 补齐（让 `findDesktopShimDir` / `listDesktopCommandRuntimeDirs` 真的能看到那个 sealed 目录），**不是**用 `check-coverage-baseline.mjs --update` 把下降抹平成新基线。判据：下降 5 行以上且集中在某个 fixture 涉及的文件，先怀疑 fixture，再怀疑代码。

### 基线取「本机实测的低值」，不是「某一次跑出来的高值」

补完 fixture 之后，`lib/desktop.js` 的行命中仍然会抖：同一个 commit、连着四次 `npm run test:full`，三次 1813、一次 1818。逐份 lcov 比出来的差集只有四行 —— `857-860`（`listDesktopPackageRoots()` 里「argv 里带 `desktop-cli.js` / `host-process-entry.js` 就走这几步」那一段）。把 `test-all-hosts` / `test-host-tree-chain` / `test-desktop-locate` / `test-desktop-scripts` / `test-desktop-cli-repair` / `test-status-render` 等所有沾到这棵候选表的文件**单独跑一遍，没有一个覆盖到那四行**；不存在任何测试改写 `process.argv`。也就是说触发者还没定位到，只知道它在整套并行跑的时候时有时无。

处置有两条，选后者：

- **不许**用「再跑一次直到它变高」把门禁凑绿 —— 那就等于把门禁交给运气，下一次真倒退 5 行时会被当成噪声忽略。
- **允许**把基线按**观测到的最低值**记（把低值那份 lcov 放回 `.tmp-coverage/lcov.info`，再 `--update`）。这样抖动向上不报红、向下仍然会红（比基线再低 1 行就 FAIL），棘轮方向没变。

判据：先按上一节怀疑 fixture；确认 fixture 已经补齐、且差集是「几行成组、每次都是同一组」之后，才走「按低值记基线」，并在 `docs/test-map.md` 的盲区里留下这一组的行号与观测次数。**别把这条当成通用豁免**：上一节那条「补 fixture，不要 `--update`」仍然是默认规则。

### `DSH_DESKTOP_INSTALL` 的多目录分隔符是 `path.delimiter`，不是写死的 `;`

`lib/desktop.js` 的 `extraInstallsFromEnv()` 用 `String(env.DSH_DESKTOP_INSTALL).split(path.delimiter)` 拆：Windows 是 `;`，POSIX 是 `:`。写死 `;` 在 Linux 上会把两个安装目录拼成一条不存在的路径 —— 桌面树整棵从候选表里消失，而失败信息只是「宿主数比预期少一个」，看起来像去重过度。

写这条纪律的原因是 `test-all-hosts.mjs` 的 junction 去重用例就这么红过一次：本地 Windows 与 `.tmp-linux-preload.mjs` 都绿（preload 只改 `process.platform`，`path.delimiter` 在进程启动时就定了，仍是 `;`），CI 的 ubuntu 才是真 POSIX。所以**凡是「本地怎么跑都不红、CI 红」的环境差异，先怀疑三样**：`path.delimiter`、`path.sep`、`path.basename` 对反斜杠的处理（批24 踩过）、`os.homedir()` 读的是真 `process.env`（批75 踩过）。这三样 preload 都模拟不出来。

### 假实现 `Stats`、`--test-name-pattern`、短名长名：三条会给你假绿的坑

1. **`{ ...st, dev: 999999 }` 会连 `isDirectory()` 一起丢掉**。`fs.Stats` 的方法在原型上，展开只拿到自有可枚举属性。任何「伪造 `Stats` 的一个字段」的假实现都必须写成 `const stub = Object.create(st); stub.dev = 999999;`——否则被测代码里 `statSync(...).isDirectory()` 抛 TypeError 被 catch 吞掉，原实现和它的突变**双双返回同一个值**，用例永远绿。这一坑在批79 造「跨设备跳过」时踩到：整条用例看起来钉得很细，实际上对「比较反了」的突变毫无区分力。
2. **`node --test --test-name-pattern=<没匹配上的串>` 不报错，它把整个文件算成 1 条 pass**。拿它单独验证一条用例时，会得到漂亮的 `pass 1 / fail 0`，而你那条用例根本没跑（批79 的 probe5 第一版就是这么被骗过一轮）。要验证单条，用**能匹配上的中文标题片段**，或者干脆跑整个文件。
3. **`os.tmpdir()` 常给 8.3 短名，`realpathSync.native` 给长名**。`C:\Users\ADMINI~1\...` 与 `C:\Users\Administrator\...` 不是同一个字符串。凡是用路径当键做计数、去重、缓存，两侧都要先过一遍 `realpathSync.native` 再比，否则计数恒 0、缓存永不命中。项目里已经因为这个坑修过两处：`enumeratePatchAiBases` 的 M37 去重（批77）与 `findAiBaseRecursive` 的 `visited`（批79）。

### 深度扫描（`findAiBaseRecursive`）的四条事实，别凭直觉改

- 入口判 `if (depth > 6) return null`，顶层 `depth=0` → **最多下钻 6 层**，差一层就是完全不同的结果。
- `node_modules` 有三个落点：`join(root, needle)` → `join(root, "node_modules", "@deepseek-ai")` → pnpm `firstAiBase(pnpmHoistAiBases(root))`。第二条会兜住「埋得很深的扁平布局」，**因此 needle 参数写错也照样命中**——所以 needle 那句只能靠源码形状断言钉，不要试图用行为用例区分。
- `readdirSync(p, { withFileTypes: true })` 对 junction 报 `isSymbolicLink() === true` 且 `isDirectory() === false`，`if (!e.isDirectory()) continue;` 会把它整个跳过。好处是不会绕圈，代价是**只经链接才够得着的树永远找不到**。
- 跨设备跳过（`childDev !== rootDev`）只在 `process.platform !== "win32"` 或条目本身是符号链接时判；Windows 普通目录一律下钻，这是 `#91` 用 6 万目录 7.2 秒换来的取舍，别「顺手统一」。

### `path.join()` 会把 `..` 折掉：路径类断言不能假设原串还留着上一级

候选表里那些「退一级」的写法是 `join(dirname(p), '..', 'lib', 'node_modules', ...)`。`join` 会先归一化，所以 `dirname('/r/app') + '..'` 得到的是 `/r`，而不是 `/r/app/..`。两个后果：

1. **断言要照 `join` 的结果写**，别照自己的心算写（`execPath` 在 `/r/app` 时落点是 `/r/lib/node_modules/...` 与 `/r/node_modules/...`）。第一次写这批用例时按「应该退到 `/r/app/lib`」写的两条全红，改的不是实现，是断言。
2. **这种写法在根附近会塌成同一层**。这是刻意的取舍：多试一条只多一次 `existsSync`（微秒级），少猜一种布局就是整份预设消失（要用户手动改配置才发现）。凡是「宁可多试几次也别漏」的探测，都按这个方向写，并把取舍写进注释，免得下一个人当 bug 修掉。

### 断言一组东西时，`filter` + `deepEqual` 不覆盖跨组顺序

`defineToolCandidates` 的候选表分成 argv / execPath / 两个主目录 / 桌面根 / cwd / 历史遗留几组。先按前缀 `filter` 再 `deepEqual`，只钉住「每组内部顺序对」，把两组对调照样绿 —— RED 演练就是这么抓到一条 GREEN 的。补法是再加一条跨组断言（`list.indexOf(A[0]) < list.indexOf(B[0])`）。

顺序在这里是行为：`loadDefineTool` 是逐条 `createRequire`、第一条能解析的就赢了。所以「哪组在前」等于「哪个包被当成宿主的那份」。凡是「首个命中即返回」的列表，都要有一条跨组顺序断言。

### 等价突变的一种常见形态：早退读的是不可能存在的键

`if (rootId === undefined) return` 这种守卫，删掉后行为不变 —— 因为紧接着的 `reservations.get(undefined)` 本来就返回 `undefined`，而 `addReservation` 只会收到解析出来的根会话 id，表里不可能存在 `undefined` 这个键。判据是「能不能举出一条让它与不删它表现不同的路径」：举不出来就删掉这条突变，并在用例里写一行说明「这是防御性早退、不是可测行为」。早退守卫多半属于这一类，别为它们硬造 fixture。

### 依赖「本机装了什么」的用例要拆出可注入的那一层，而不是加 skip

第一版这么写：`test('loadDefineTool：本仓库里能直接解析到宿主包，返回一个函数')`。开发机上绿（桌面安装把 `@deepseek-ai/dsh-tools` 摆在了可解析的位置），`ubuntu-latest` 上红（`Error: cannot resolve @deepseek-ai/dsh-tools from host`）。**这种用例在错误的一端永远是假红或假绿，而且它挡住的是整条 CI。**

修法是把它拆成两层：

- `resolveDefineTool(candidates)`：只做「逐条试、第一条能解析的就赢、一条都没有就抛文档里那句错误」。候选表由调用方给，所以模块只依赖文件系统 —— 用例造一棵假宿主树（`node_modules/@deepseek-ai/dsh-tools/package.json` + `index.js` 导出返回 `{fake:true}` 的 `defineTool`）就能确定地覆盖命中、跳过、抛错三件事。
- `loadDefineTool()`：自解析一半 + 交给候选表一半。用例改成**两态容忍**（拿到函数就断言 `typeof === 'function'`，抛错就断言抛的正是那句文案），并在用例里写明「这条随环境两态」。

判据：一条用例如果在两台上机器给出不同结果，它就不是在测行为，是在测环境。把它拆到「纯函数 + 注入参数」那一层，剩下的壳用两态容忍 + 源码形状钉住。**别用 `skip` 搪塞**：跳过之后那一层永远没人测，而 CI 绿的假象会一直留着。

### 破坏性操作的用例怎么写：「先存档、存档失败不删」要把失败路径也做出来

清理旧得分项（`lib/redteam/store-core.js` 的 `seedScorePoints`）是整个演练台里为数不多的**不可逆**操作：删的是用户库里的得分点与命中。它的核心纪律是「没存下来就不删」，而这句话只有在**存档真的失败**时才有内容 —— 所以用例不能只跑顺利路径。

**做法：把存档目录挡成一个文件。** 存档落在 `<靶标>/runs/legacy-score-<时间>.json`，先 `mkdirSync(dir, { recursive: true })`。把 `runs` 先建成**普通文件**，`mkdirSync` 就必然抛 `ENOTDIR`/`EEXIST`，整段被内层 `catch` 吞掉 → `archived` 保持 false → 守卫 `if (!archived) throw` 生效 → 外层 `catch` 再吞掉 → 播种继续。于是可以断言三件事同时成立：`purged: false`、得分点还在、命中还在。

为什么不用 `chmod 0o444` 或「把目录设成只读」：Windows 上 `chmod` 只设只读属性、对目录基本无效，POSIX 上 `rename`/`unlink` 只要求**父目录**可写 —— 两个平台对「只读」的理解不一致，写出来的用例在本地绿、放到 CI 就红（`MAINTENANCE.md` 里「跨平台断言」那几节反复踩过）。**「用一个同名文件占住本该是目录的位置」是跨平台一致的注入方式**，代价只是不许让被测代码自己去 `rm` 掉它 —— 这里恰好不会（`mkdirSync(recursive)` 不会删东西）。

同一招在别的「必须落盘才算成功」的地方都能用：导出报告、写 `.dshpurge.bak`、落 `legacy-score-*.json`、写 `runs/` 下的其它证据。

**另一条：破坏性操作的判据列要单独造反例。** 「这条得分点是不是内置的」在注释里写得很清楚（必须用 `builtin` 列），但代码长得像「code 在不在默认名单里」。用例造一个 `code='web-account-mine'`、`builtin=0`、`legacy=0` 的自建点 —— 它与旧点**只有列值不同、长相一模一样**。不造这个反例，两种实现都会绿；造了之后，「拿名单判」的突变立刻红，而且这条红正好对应注释里写的那个真实事故（用户自建点被静默删掉，界面还弹「已保存」）。


### 一份「重复的兜底分支」要先证明它走得到，否则删掉

`lib/redteam/score-report.js` 里曾有同一件事的两份实现：`else if (confirm !== null && confirm.script)` 填模板，以及下面 `if (replayCmd === null && confirm && confirm.script)` 再填一次。看起来是「第二道保险」，实际是**死代码**。判据只要两条：

1. **条件是否一字不差**。两处的真值条件完全一样（`confirm && confirm.script`）。字面不同（一个写 `!== null`、一个写裸真值）会让人误以为「兜底能接住某些情况」，但这两种写法对同一批输入的真假完全相同。
2. **唯一能把变量留成 null 的那条路径，在现实输入下是否可能**。这里唯一的候选是 ①（有真抓包 → 合成 curl）：`buildCurlCommand` 只在 `parseTarget(url) === null` 时返回 `null`，而传进去的 `url` 一定是 `scheme + '://' + host + path` 形态，`parseTarget` 的最后一段兜底（`report-replay.js:60-63`）连「带路径的裸主机」都会取第一段当主机返回对象 —— 所以那里不会返回 `null`。把 `parseTarget` 的畸形输入挨个试过（空串、缺 Host、`[::1` 未闭合、全角冒号），**没有一种能让它返回 null**。

两条都成立就可以删。删除的同时做三件事，缺一不可：

- **原地留注释**写清「为什么它曾是这里的一部分、为什么走不到」，否则下一个人看到「少了一道保险」会想加回来；
- **跑满该模块的全部测试文件**（这里 43 + 14 + 25 条），确认行为零变化；
- **在 `docs/test-map.md` 的盲区里写一条**：删除本身没有守卫，只有记录 —— 因为「某段代码不存在」这件事写成测试只会变成源码形状断言，而形状断言在重排代码时会假红。

反过来说：**如果一条兜底走得到，就必须有能区分两条实现的用例**。上一批（`test-store-evidence-rules.mjs`）的「存档失败不许删」就是这种：把 `runs` 做成文件让 `mkdir` 抛错，突变「存档失败也删」立刻红。判据永远是同一个 —— 改完之后说不出「用户会看到什么不同」，这条突变就是等价突变，删掉它、别为它硬凑用例。

### 死代码的判据：私有 helper 在全仓只有定义处一个名字

`lib/bom-guard.js` 里的 `readJsonNoBom(fp)` 活了很久：七行、看起来像「读 JSON 时顺手剥 BOM」的正规入口，实际上**没有任何调用点** —— `grep -rn "readJsonNoBom" lib scripts` 的唯一命中就是它自己的 `function` 行。它之所以没人发现，是因为它长得像基础设施：有注释、有 try/catch、名字合理，删不删都不影响任何测试。

判据只有一条：**私有 helper（不带 `export`）在全仓只在自己定义处出现一次标识符，就是死代码**。带 `export` 的要另判 —— 它可能是给宿主或外部脚本用的 API，删之前先 `grep` 整个仓库（含 `docs/`、`scripts/`、`test-*`）与宿主安装树。

删除前后各做一次：`node --check <file>`；跑**该模块的全部测试文件**（这里 5 + 19 条，不是只跑新增那一份）；在 `docs/test-map.md` 的「N补」与盲区里记一笔（下一个人会再问一遍「这个能不能用」）。删掉之后覆盖率分母会小 7 行 —— 这是**分母变小**，不是覆盖率下降，`check-coverage-baseline.mjs` 会同时打印 `↑ 行 148 → 161 (+13)` 与 `↓ 行总数 169 → 161 (-8)`，看到后者不要以为是退步。

### 「写完之后再读回来验一遍」这类代码，要用「让写成功、让读说谎」来测

`fixProfileBom` 写盘后会 `readFileSync` 复查一次（还带 BOM 就抛错、JSON 类再 `JSON.parse` 一次）。正常跑的时候这两个条件永远为假 —— 任何实现都能过，等于没测。这类「事后校验」的测法是**拆开它的两个前提**：让「写」成功，让「读」说谎。

```js
const origRename = fs.renameSync;
const origRead = fs.readFileSync;
let written = false;
fs.renameSync = (...args) => { const out = origRename.apply(fs, args); written = true; return out; };
fs.readFileSync = (target, ...rest) => (written && String(target) === fp ? LIE : origRead.call(fs, target, ...rest));
```

`LIE` 换成 `BOM + body` 就走到「BOM 仍在」那条分支，换成 `"{"` 就走到「JSON 解析不过」那条分支。这套手法成立的前提是**双方共用同一个 `node:fs` 默认导出对象** —— `lib/bom-guard.js` 直接 `import fs from "node:fs"`，`lib/core.js` 的 `atomicWriteSync` 也是，所以 monkeypatch 一次就同时生效（跨平台，不依赖文件权限）。

同一个注入点还能可靠地造「写盘失败」：`fs.renameSync = () => { throw new Error("rename boom") }`。比 `chmod 0o444` 可靠得多 —— POSIX 上 `rename` 只要求**目录**可写，改目标文件的 mode 拦不住它（批59 踩过这个坑，CI 上红了一条）。写盘失败的三件事要一起断言：`failed` 里有那条错误、**原文件字节不变**、目录里**不留 `.tmp`**（`atomicWriteSync` 的 catch 会 unlink）。

与之相对，`fsyncSync` 是这条路上唯一测不到的一环：它没返回值、没可观察副作用，换成空函数测试全绿。这类只能退到源码形状断言（「写盘必须经过 `atomicWriteSync`」），并写进盲区。

### 造「写一半失败」要用手法让磁盘真的拒绝，不要 mock 内部函数

测回滚（「A 写成功、B 失败 → A 要退回去」）时，最省事的写法是把 B 换成 mock 让它抛错。但那样测的是 mock：真实失败来自 `rename` 被拒、目录被占、磁盘满，错误码与发生时机都不一样。这一批用的三种手法都**不碰模块内部**，只让磁盘说「不行」：

- **目录占位**：想让 `rules/<id>.json` 写不进去，就把这个路径造成**目录**。`atomicWriteFile` 是「写 tmp → rename」，rename 到目录上必然失败（Windows `EPERM`、POSIX `EISDIR`）。同理把 `$DSH_HOME/AGENTS.md` 造成目录，就能让「元数据已写成功、接下来激活目标文件」这一步失败 —— 那正是回滚段里最难走到的一条分支（`wroteRule && wroteMeta` 都为真）。
- **`fs.promises.stat` 抛错**：`fs.promises` 是个普通对象，属性可写，`import { promises as fsp }` 拿到的就是同一个对象，所以 `fsp.stat = async () => { throw }` 对被测模块立刻生效。用完在 `finally` 里还原。
- **`fs.readFileSync` 定向抛错**：按路径判断（`if (fp === 某条规则) throw`），只打断一处同步读，其它读照常。用来验证「某条规则读不出来时应当**跳过**它，而不是让整次操作失败」。

写这类用例的三条纪律：

1. **断言两件事，不只一件**：回滚是否发生（新规则文件在不在 / 旧正文回来了没）+ **原错误是否照旧抛出去**（回滚不能把错误吞掉）。只断言前者，会让「吞掉错误、假装成功」的实现过关。
2. **逐字节比较**，不要比 `JSON.parse` 之后的对象。上一版 meta 的缩进、键顺序、结尾换行都算「用户的东西」；用对象比较会把「重新序列化覆盖了原格式」判成通过。
3. **持续性失败造不出「第一次成功、回滚失败」**。monkeypatch 让磁盘拒绝是持续性的，它会同时打断第一次写入。所以「回滚本身也失败」那两层内层 `catch` 只能靠源码形状断言（「回滚段在 `throw e` 之前」），要写进盲区，别硬凑 fixture。

### 一个函数认的值比表约束多一个，那个值就从来没成功过

`lib/redteam/evidence-ledger.mjs` 的 `resolve()` 原话是「认 `resolved` / `contradicted` / `withdrawn`」，而同一文件里的建表语句写的是
`status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','investigating','blocked','contradicted','resolved'))` —— 没有 `withdrawn`。
传 `withdrawn` 时校验放行，一路走到 SQLite，拿回一句 `CHECK constraint failed: status IN (...)`。工具说明书也照着宣传这三个值，
于是模型选了一项、收到一句数据库内部错误。**这条路一次都没成功过，而且没人报过 bug**：它长得像一个合法的功能。

两条判据，任何一条成立就该去比对「代码认的集合」与「schema 认的集合」：

1. **同一个语义在两处各写了一遍字面量**：一处是入口校验（`Array.includes` / `Set.has` / 正则），一处是 DDL 的 `CHECK`、枚举表、或宿主层的 `enum`。`grep` 一下那个值的名字，出现两次以上就要问「这两处是同一个集合吗」。
2. **错误文本里带着用户可见的选项清单**：`disposition must be resolved|contradicted|withdrawn` 这种把可选值拼进提示的写法，等于把集合又抄了第三份。

修哪一头，看**改完之后用户机器上会发生什么**：

- **收回广告词（本项目的选择）**：把 `resolve()` 的取值表抽成 `export const RESOLVE_DISPOSITIONS = [...]`，同步工具说明书的 `description` 与参数说明，并把旧断言一起改。零 schema 改动、零迁移、零数据风险，代价是少一个从来没有工作过的选项。
- **补 schema**：要改 `EVIDENCE_LEDGER_DDL` —— 但 `CREATE TABLE IF NOT EXISTS` 对**已经建过表的用户库不生效**，必须再写一次「建新表 → 拷数据 → 删旧表 → 改名」的迁移，事务里做，还得考虑迁移中途断电。这是另一个风险等级的动作，别混在一批「补测试」里顺手做。

配套的守卫：**从 DDL 里把 `CHECK(... IN (...))` 的取值解析出来，断言入口校验的集合是它的子集**。这样下一回有人只改数组，测试先红，不用等到用户点下去才发现。
（`docs/test-map.md` 的「四十一补」第 4 条与盲区 89 记着这次的完整经过。）

### 一行里有十几处同样的 `sendJson(response, 500, …)`：演练按行号改，不按子串改

`lib/routes.js` 里 `sendJson(response, 500, { ok: false, error: String(e) });` 这种行出现十几次，`response.writeHead(405, { allow: "GET" });` 也有两处一字不差。做 RED 演练时用子串当锚点必然撞，`nth` 又会在下次插行后失效。

这一批改成**按行号单行替换**，每条突变写成四元组：

```js
// [label, 1-based 行号, 该行必须包含的片段, 替换后的整行]
["/hooks-deny GET 500→200", 141, "sendJson(response, 500", '              sendJson(response, 200, { ok: false, error: String(e) });'],
```

第二项是「这一行现在长什么样」的断言 —— 行号会随着将来的插入而漂，但只要那一行不再包含该片段就把这条记成 ANCHOR 而不是当作有效突变，所以漂了会立刻看得见，不会静默测错地方。第三项写成替换后的**整行**（连缩进），避免拼接出零缩进的非法 JS。

三条纪律：

1. **BASE 必须来自 `git show HEAD:<file>`，并在开始前与工作区比对**（`norm(head) !== orig` 就直接退出码 2）。工作区若带未提交改动，drill 的「还原」只会把半注入的内容写回去 —— 这个坑本项目踩过一次（`lib/extract-asar.js` 停在半注入状态后所有测试 `SIGTERM`）。
2. **每轮 `finally` 写回原文，结束后再读一遍比对**，把结果并进 `{"restored": true, …}` 一起输出。只看 RED/GREEN 数量而不看 `restored`，等于相信一个可能已经把文件改坏的过程。
3. **分片跑**（`node .tmp87-drill.mjs 0 10` / `10 19`）：单次命令超过约两分钟会被外层掐断，掐断时 `finally` 未必跑完。

### 纯函数模块：先跑探针把「现状」抄成一张表，再决定哪几条是该钉的现状

`lib/redteam/ip-utils.js` 这批没有 fixture（不碰库、不碰文件、不读环境），所以写法跟前面的批次完全不同。有效的顺序是三段：

1. **一个探针把所有导出 × 十几个输入跑一遍，打印成 JSON。** 文件在 `.tmp84-probe.mjs`，输出直接当断言表用。这一步不是可选的：这一批我凭「应该是什么」写错了三处断言，全靠首跑变红才发现 —— `isIpv6("2001:db8::1::2")` 实为 true、`scopeOfIp("10.0.0")` 实为 internal（四条 IPv4 判据是**前缀匹配**不是整串校验）、`slugTarget("A.Example.COM/x")` 实为 `A.Example.COM_x`（只有 `^https?://` 命中时才取 host，裸串整段当 host）。
2. **把「明显不严谨」的现状分成两类：能改的改，不能改的钉住并写明理由。** 判据只有一条：**改完会不会动到用户机器上已经存在的东西**。动得到（目录名、库里存着的 `cidr`、报告里已经出过的文字）→ 只钉不改，并在 `test-map.md` 的盲区里写清「以后想改会付出什么代价」；动不到（返回值、纯计算）→ 可以改，但要单独一批、单独一个提交。
   这条判据把 ip-utils 的六个怪癖全判成「只钉」：`slugTarget` 的产物是已建靶标目录名，`cidrOf` 的产物是库里存着的段。
3. **等价突变要认出「两条判据互为补偿」这一种。** 前几批遇到的是「删掉判据行为不变」（冗余守卫）与「改完用户看不到差别」；这次是第三种：`head === '' ? []`、`tail === '' ? []`、`g === '' ? '0'` 三条里删任一条，另外两条都能把结果补回同一个值。所以三条突变全绿是**正确结论**，不是漏测 —— 代价是 `expandIpv6` 的那个三元分支永远走不到 true，覆盖率 `brh` 停在 73/74。碰到这种就如实写进盲区，别为了把分数凑满去造一个人造分支。

### CRLF 文件改一处，写回时不许再 `replace(/\n/g, "\r\n")`

`lib/*.js` 全是 CRLF。用脚本改一行时的正确写法：

```js
const raw = readFileSync(fp, "utf8");
if (raw.includes("\r\r\n")) throw new Error("already broken");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);
// ...改 lines...
writeFileSync(fp, lines.join(eol), "utf8");
```

错误写法（我踩过）：`raw.split("\n")` → 改 → `join("\n")` → **再** `replace(/\n/g, "\r\n")`。因为每行原本已经带 `\r`，结果是 `\r\r\n`。这个错误**不会**被任何门禁发现：

- `node --check` 照样通过（CR 也是合法空白）；
- `check:eol` 数出来的是「CRLF 行数」仍然对（`\r\r\n` 里第一个 `\r` 被当行内字符）；
- 但 V8 把 CR 与 LF **都**当行终止符，于是**报错行号翻倍**：`lib/rewind.js:384` 的异常显示成 `:767`（`384*2-1=767`，精确吻合）。我第一次遇到时照行号去读源码，读的是完全无关的一段，白花十几分钟。

判据：`git diff --stat` 显示「整个文件都是改动」（644 insertions / 644 deletions）就是踩了；恢复用 `git checkout -- <file>` 重来，别在坏文件上继续改。

### 路径判据要要求「完整路径段」，子串判据会把邻居一起吃进去

`n.includes("/dsh-purge")` 看起来够用，实际上把 `…/dsh-purge-maintained`、`…/dsh-purge-old`、`…/my-dsh-purge-fork` 全算成了插件树。这个判据出现在两个删除助手里（`lib/uninstall-restart.js`、`lib/restart-desktop.js`），而它们拿到的是**清理列表**，也就是一串要递归删掉的路径 —— 判宽了的代价是删掉用户的东西，判窄了的代价只是留下一堆垃圾。两边的赔率完全不对等，所以路径判据一律要求完整路径段：

```js
const OWN_TREE = /\/(?:node_modules\/)?dsh-purge(?:\/|$)/;
const n = path.normalize(String(dir)).replace(/[\\/]+/g, "/").toLowerCase();
if (!OWN_TREE.test(n)) return;
```

规矩有三条：

1. **先归一再看**：`path.normalize` + 反斜杠折成正斜杠 + `toLowerCase()`，然后才匹配。少了归一，Windows 上 `D:\dsh-purge` 与 `d:/dsh-purge` 是两个结论。
2. **末段要用 `(?:\/|$)` 收口**，不能只写 `\/dsh-purge`。少了它，`…/dsh-purge-maintained` 又回来了。
3. **可信度分级**：`includes` 这种子串判据只能用在「误判代价为零」的地方（比如列出候选、打日志）。凡是它的返回值会喂给 `rmSync` / `unlinkSync` / `renameSync`，都必须改成完整段匹配，并且**必须有源码形状用例**钉住那句正则 —— 这类代码在独立进程脚本里，`import` 就会把进程跑起来，行为层根本测不到。

同一个道理在 `collectCleanupDirs` 里还有一层：`remember()` 做 `fs.realpathSync` 会把链接解析成它的目标。如果那个目标是用户的源码目录，记进清理列表就等于让重启助手去递归删源码 —— 这是 1.1.94 起的真缺陷。所以「要记链接本身」与「要记链接指向的树」是**两个不同的决定**，不能都塞进 `remember`：入表用 `push`（不做 realpath），需要真实路径的地方才用 `remember`，两者共用一个去重集合。

### 沙箱用例里，凡是被记忆化的路径解析，每造一套新现场都要 `resetPathMemo()`

`lib/core.js` 的 `findAiBase` / `findDshHome` / `findShimDir` 都走同一个 memo（`resetPathMemo()` 把 `memo[slot] = { ready: false, value: null }`）。这本来是为了「一次进程内别重复扫盘」，代价是：**测试里换 env 不代表换路径**。第一套沙箱跑完，第二套沙箱即使把 `DSH_HOME` / `DSH_BASE` / `npm_config_prefix` 全指到新目录，`gatherState()` 还是会用第一套的读数。

症状很有欺骗性：五条依赖 `applied:true` 的用例同时红，报的是业务断言（`expected true, actual false`），一个字都不提路径。第一次遇到会往「是不是补丁没打上」的方向查半小时。

规矩：任何造沙箱的 helper（本项目里统一叫 `sandbox(tag)`）末尾必须调 `core.resetPathMemo()`，而且要在**挂完 env 之后**调 —— 它清的是缓存，不是配置。判据很简单：如果两条用例单独跑都绿、合起来跑就红，且它们用的是不同的临时目录，那九成是 memo 没清。

### 给 `agent.cancel` 这类宿主方法造「抛错」时，要分清同步抛与 rejected promise

`try { ignoreSettled(agent.cancel(...)); } catch { /* ignore */ }` 这一句里两层保护各自兜一类错误：

- `ignoreSettled()` 兜的是**返回 rejected promise**（`async` 方法抛错）；
- 外层 `try` 兜的是**参数求值阶段就 throw**（同步方法抛错）。

只造 `async` 方法抛错的话，把外层 `try` 删掉测试全绿（等价突变），因为 `agent.cancel(...)` 在求值阶段不会抛。写法：另起一个 fixture，`cancel: () => { throw new Error(...) }`（**不带 `async`**），断言「调用发生了，异常没冒出去」。

### 私有成员「看起来在用」：同一个名字在隔壁模块确实在用，删之前要按接收者数

`lib/redteam/store-core.js` 里有个 `#hitTrace(db, hit, engagementId)`，函数体只有一行 `return hitTrace(this, db, hit, engagementId)`。`grep -rn hitTrace lib/` 会给你一堆命中（`lib/redteam/score-report.js` 里 `scoreReport` 和 `reportTargets` 都直接 import 它），看起来「当然在用」。但 `#hitTrace` 这个方法本身一次都没被调用过 —— 名字相同不等于同一个东西。

判据按接收者数，不按名字数：

```bash
grep -rn "this\.#hitTrace" lib/            # 空 → 这个私有方法没人调
grep -n "isCappedPoint" lib/redteam/store-core.js   # 只有定义行 → 死代码
grep -rn "hitTrace" lib/redteam/score-report.js     # 有命中 → 函数本身活着，别删函数
```

三条纪律：

1. **私有成员用 `this.#name` 数，公共函数用「定义处以外还有没有出现」数。** 前者能一次判死，后者在同名函数活在别的文件时会骗人。
2. **删方法顺手删 import 名单里那个名字**（本例删 `#hitTrace` 之后 `import { scoreReport, scoreChain, representativeShots } from './score-report.js'` 里的 `hitTrace` 也要一起摘）。漏摘不会报错，因为 ESM 允许 import 未使用的绑定 —— 但下次有人搜「谁在用 hitTrace」时会被这个名字骗到。
3. **删完要有一条源码形状守卫**，把「这个私有成员不许回来」钉住（判据：`assert.equal(SRC.includes('this.#hitTrace('), false)`），否则下一轮合并别人的分支时它可能被一起带回来。

### 等价突变的第四种：事务型守卫在「还没成功写过任何东西」时，COMMIT 与 ROLLBACK 分不出来

前三种等价突变是「两条判据互为补偿」「无可观测差异」「平台归一化吃掉差异」。第四种是事务：`deleteScorePoint` 的顺序是 `BEGIN` → `DELETE FROM score_hit` → `DELETE FROM score_point` → `COMMIT`，`catch` 里 `ROLLBACK` 再 `throw`。我把 `ROLLBACK` 改成 `COMMIT`，26 条用例**全绿** —— 因为这条测试路径上 `DELETE FROM score_hit` 就失败了，事务里没有任何脏数据，`COMMIT` 与 `ROLLBACK` 的可见效果完全一样。

判据与写法：

1. **要区分「有没有回滚」，就把回滚整句删掉**（`db.exec('ROLLBACK')` → `void 0`），这时连接会停在「事务未结束」状态 —— 可观测的现象是下一次 `BEGIN` 抛 `cannot start a transaction within a transaction`。
2. **测试里补一条「事务确实收掉了」的断言**，而不是只看「数据还在不在」：

   ```js
   assert.throws(() => store.deleteScorePoint({ id: pid }), /no such table: score_hit/);
   assert.doesNotThrow(() => {
     store.db(eng).exec('BEGIN');
     store.db(eng).exec('COMMIT');
   });
   ```

3. **想真让 COMMIT / ROLLBACK 分出差异，就得让失败发生在「已经写成功一部分」之后**（例如让第二个 `DELETE` 失败），而这通常要改生产代码加注入点 —— 收益不足时，按「整句去掉」写突变、并把这层限制写进盲区（本例已写进盲区 90 第 4 条）。

### 「拿不到服务就退回去」的每个 catch 都是可测的：把服务做成抛错的那一个

`lib/rewind.js` 里有一层约定：任何宿主服务都用 `service(ctx, name)` 取，取不到、取的时候抛错，一律回 `undefined` 继续走。这一层以前一条测试都没有，理由是「`ctx.get` 抛错造不出来」—— 其实只要给的 ctx 自己抛就行：

```js
const ctx = { get() { throw new Error("service boom"); } };
assert.equal(rw.service(ctx, "sessions"), undefined);
```

同一套写法把这一簇全部覆盖到了：`getAgent` 的 `agents.get` 抛错、`liveSession` 的 `sessions.get` 抛错、`readSessionLog` 的 `observeSession` 返回的句柄 `[Symbol.dispose]` 抛错、`resetRequestSeries` 的三个字段各自抛错。要点有三条：

1. **一个字段一个 `try` 的函数，要单独造「只有第一个抛」的输入**。`resetRequestSeries` 是三段独立 `try`，如果只造「全都抛」的 agent，写成一句大 `try` 也能全绿 —— 必须断言「第一个抛之后，后两个仍然被写到」（`[['gen', -1], ['clear']]`）。
2. **getter 抛错与 setter 抛错是两条路**。`Object.defineProperty(agent, "frozenMessages", { get() { throw } })` 才能打到第三句，只写 `{ set() { throw } }` 打不到。
3. **`[Symbol.dispose]` 抛错只影响清理，不影响返回值**。所以断言要分两条：一条断「正文照常返回」，一条断「disposer 被调用过」（用一个数组记次数）。只断前者的话，把 `finally { disposeObservation(observed) }` 整段删掉也是绿的。

### 模块级常量造成的「等不起」，用替换 `Date.now` 来测，不要改常量

`DRAFT_TTL_MS` 是 `10 * 60 * 1000` 的模块常量。想测「草稿过期」，既不能等 10 分钟，也不能改常量（改了就是在测另一份代码）。可行且不污染的做法只有一条：**在一个用例里把全局 `Date.now` 换成「真实时间 + 11 分钟」，`finally` 里还原**。

```js
const realNow = Date.now;
try {
  Date.now = () => realNow() + 11 * 60 * 1000;
  assert.equal(rw.getDraft(id), null);
  assert.equal(rw.getPending(), null);
} finally {
  Date.now = realNow;
}
// 时钟拨回来之后再问一次 —— 这一句才是「记录被真的删掉」的证据
assert.equal(rw.getDraft(id), null);
assert.equal(rw.getPending(), null);
```

三条纪律：

1. **只换 `Date.now`**，别去动 `performance.now` / 定时器（模块里所有过期判据都走 `Date.now`，换别的既无效又会牵连 `node --test` 的超时统计）。
2. **`finally` 必须还原**，否则同文件后续用例全部处于「未来」，`getDraft` 会一律回 null，看起来像「草稿功能坏了」。
3. **必须有「拨回来再问一次」的断言**。只断拨快之后是 null 的话，「`lastPending = null` 换成 `void 0`」这种突变是绿的（因为函数紧接着 `return null`）—— 拨回来再问才能把「记录真的被删掉」与「每次靠时间判据回 null」分开。

### 等价突变的第五种：同一函数里前后两道判据互相兜底

前四种是「两条判据互为补偿」「无可观测差异」「平台归一化吃掉差异」「事务在无脏写时分不出 COMMIT/ROLLBACK」。第五种是**同一个函数里，前一道守卫与后一道兜底给出同一个值**：

```js
function service(ctx, name) {
  if (!ctx || typeof ctx.get !== "function") return undefined;   // 这道
  try { return ctx.get(name); } catch { return undefined; }       // 与这道
}
```

把第一道删掉，`{}` 会抛 `ctx.get is not a function`，被第二道吃掉，返回同样 `undefined`。判据：**把守卫删掉之后，是否存在一个输入能让两个版本的返回值（或副作用）不同** —— 找不到就是等价，直接删掉那条突变，不要为它硬凑用例；但要留一行注释说明「这道守卫目前是冗余的，一旦下面的 catch 改成别的值它就重新必要」。

### 上一道 `if` 已经把这类行全收走了，下面那个「重开 / 再判一次」分支就永远走不到

`lib/profile-insert.js` 的 `profileHasPurgeBodyInsert` 原本长这样：先一句 `if (/^-\s*insert:\s*$/.test(line) || /^\s+-\s*insert:\s*$/.test(line))` 把 insert 行收走，再在结束段的分支里写「如果这一行本身又是 `- insert:`，就重新开段」。**后一个分支恒假** —— 两个正则合起来覆盖「0 个空白」与「至少 1 个空白」，没有第三种行能走到那里。它从 1.1.94 起就没执行过一次，单文件 lcov 里那两行命中数一直是 0。

判据（三步，都不需要读模板以外的知识）：

1. **把「能被前面判据吃掉的行的形状」和「后面那个分支假设的形状」列出来看交集。** 在这里：`^\s*-\s*insert:` 覆盖所有缩进，交集就是全集，所以分母为空。
2. **跑单文件覆盖率确认命中数为 0**，而不是靠阅读判断：`node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=.tmp-lcov.info scripts/<该模块的测试>.mjs`，再从 `DA:` 行里挑出那几行。
3. **删掉之后，drill 里对应的那条突变必须一起删。** 留着它就会变成「改一行注释」的假突变 —— 它当然还红（测试文件里那条源码形状断言会撞上），但它测的已经不是行为。

同类处置参考：`isCappedPoint` / `#hitTrace`（批90）、`readJsonNoBom`（批85）。三条的共同点是**判据不在代码里、在调用点集合里**，所以复核手段统一是「数调用点」而不是「读实现」。

### 段标记清不清，往往不在当前这一行显形，而在再下一行

`validateAllowBuildRewrite` 里「缩进回退 → 段结束」的那句 `inAllow = false;` 后面紧跟 `continue;`。这意味着**回退那一行本身**无论如何都会被跳过：把 `inAllow = false;` 换成 `void 0;`，那一行的处理结果一模一样，用例照样绿（我第一次就是这么被坑的，突变得了 GREEN）。

差别在**再下一行又缩回段内层级**时才出现：段标记没清，那行会被当成段内键去校验，一个解析不出的垃圾键就足以把整个文件判成 `false`（于是 `ensurePnpmAllowBuild` 拒绝写盘）。所以 fixture 必须写成「回退行 + 再深缩进的垃圾行」两行：

```js
assert.equal(P.validateAllowBuildRewrite("allowBuilds:\n    a: true\n  b: true\n    notakey\n"), true);
```

推广：**`try {…} finally`、`continue`、`return` 这些「跳过后半段」的语句，会让它前面的状态清理变成不可观测**；造 fixture 时要往后多看一步，找那条「清理没做 → 状态泄漏到下一次循环」的输入。

### 要观测「走了哪条通道」，就数调用次数；只看返回值分不清

`lib/hide-console.js` 的 `builtinChildProcess()` 有两条通道：`process.getBuiltinModule("child_process")` 与 `createRequire(import.meta.url)("node:child_process")`。第一层抛错会静默退到第二层，而**两层都能拿到同一个对象** —— 于是「第一层炸了」和「第一层根本没被摸」在返回值上完全一样（都装上，都返回 `{ ok: true }`）。

解法是把第一层换成一个**会抛错且计数**的函数：

```js
process.getBuiltinModule = () => { touched += 1; throw new Error("sandbox"); };
// …调用之后：
assert.equal(touched, 1, "内置模块通道被摸过一次才走 catch");
```

同理，凡是「首选实现 + 兜底实现」结构（读两处配置、试两个解析器、先 native 再 polyfill），用例都应该至少在一次断言里**数首选实现被调用了几次**，否则兜底写得再对也证明不了首选还在跑。配套的突变也简单：把首选那一行改成 `if (false)`，计数变 0，立刻红。

### 把 `process.argv[1]` 当输入的函数，用例里必须临时改它并 `finally` 还原

`resolveDshBinRoot(undefined, …)` 会读 `process.argv[1]`：匹配 `/[\\/]bin\.js$/i` 就把上两级目录塞进候选链。这是**进程级全局状态**，改完不还原，同文件后面所有用例都会看到一条假路径（而且症状很怪：某条「什么都没有时返回 null」的用例突然返回了值）。写法固定成：

```js
const orig = process.argv[1];
process.argv[1] = binJs;
try { … } finally { process.argv[1] = orig; }
```

同类的全局量还有 `TEMP/TMP/TMPDIR`、`DSH_*`、`npm_config_prefix`、`process.platform`（后两个分别会喂给 `path.delimiter` 与模块级常量，见前面两节）。
### 用 getter 的「第 n 次读取」定位 catch：同一个属性被十几次读取，只有其中几次不在 try 里

`applyHostHooks` 里 `ctx.systemPrompt` 被读了十几次，只有 `registerAnchor` 里那次 `ctx?.systemPrompt?.ctx` 会落进那个 `catch`。做法：给 `systemPrompt` 装一个 **getter**，计数到第 n 次就抛，然后跑一串 n 看行为谱。

判据表（实测）：n = 1 / 3 → apply 直接挂、`specs` 变 0；**n = 6 → 异常被吞、日志出现 `[apply-hooks] name=anchor/subagent`、16 条路由照注册**；n = 9 / 12 → 落在后面那层 `ctx.effect` 的 try 里，什么都不记。选 n 的依据是「哪一档还能把 apply 走完但把目标 catch 打通」，不是「最小的 n」。

### 有 setImmediate / 定时器的分支，用例里要「只跑那一个 effect」，不要 runEffects 全跑

`apply()` 登记的 effect 里，第 3 个是 `clearTimeout(settleTimer)`。要测「定时器醒来发现 ctx 已经没了」，如果按常规 `runEffects` 全跑一遍，第 3 个 effect 会把定时器清掉 —— 于是用例变成「定时器没响」，看上去永远是绿的，却什么都没测。

正确姿势：`apply()` 收齐 `ctx.effects` 后，**只挑出 `String(f).includes("alive")` 那一个**（`watchContextLife` 注册的）调用其 disposer，其余一律不跑，再等 30ms 读日志。要测「正常醒来」那一支就**一个 effect 都不跑**。

### 依赖真机资产的用例，断言写成「最多一行 + 有一行就必须有文件 + 真机 mtime 不变」

`officeSkillAssetSources()` 读的是真实安装树。开发机上它存在 → `[heal-office-skills] healed=true` 会打；CI 的干净机器上不存在 → `reason:"no-source"`、一行都不打。写成「必须恰好一行」在 CI 上必红，写成「必须 0 行」在开发机上必红。

可移植写法：断言 **≤ 1 行**；如果有一行，则必须 `healed=true` 且目标文件真的落盘（`existsSync`）；如果 0 行，则目标文件不许存在。**无论哪种都要加一条「真机那份 `SKILL.md` 的 mtime 前后不变」** —— 那是「测试没摸真机」的唯一证据。

### 「私有函数一行没覆盖」先问：线上真的有输入走进去吗

红队工具那八个函数此前一行都没覆盖，原因不是「没人写测试」，而是**真实参数面里根本
没有它们的目标形状**：把 `apply()` 收到的 64 个 `parameters` 全树遍历，
`type:'object'` 的嵌套节点一个都没有，所以 `sealObjectSchemas` 的对象分支从来没有输入。
三步判据：

1. **先看这个分支的输入从哪来。** 如果它的输入只由注册表（工具定义、补丁表、清单文件）
   产生，就把注册表**整个跑一遍**并把命中计数打出来 —— 计数为 0 就说明这是纯保险分支，
   不要拿「写了用例覆盖率就上去了」自我安慰，要直接调函数造样例。
2. **再看这个函数该不该在 `export` 里。** 判据是「有没有别的地方需要它」：本仓库
   `scripts/test-patch-registry.mjs:46` 的导出名单断言只针对 `lib/core.js`，
   `scripts/surface-lib.mjs` 的 `Object.keys()` 只用于 `host:rehearse` 的 surface 对拍，
   其余文件加 `export` 不会让任何门禁变红 —— 但加之前要 `grep -rn "<file>.js" scripts/*.mjs`
   确认没有「导出名单一字不差」的暗桩。
3. **最后判等价突变。** 这一批 25 条突变全红、没有等价项，是因为每条都对应一个
   「用户会看到什么不同」（绑定键分叉 / 名额超卖 / 工具消失）。

同类先例：`lib/bom-guard.js` 的 `readJsonNoBom`（全仓只有定义处一个名字 → 删）、
`lib/profile-insert.js` 的重开段三行（上一道 `if` 已把行全收走 → 删）。

### 想测「闭包里的一次性状态」，要么让它真的发生一次，要么就别测

`installHungPromptGlobal` 把 `hungSlowAt` / `hungDepth` 放在闭包里，外部既读不到也写不进。
这类「只能由函数自己触发一次」的状态，有三种走法，按优先级：

1. **让它真的发生一次**（首选）。熔断的触发条件是「单次调用耗时 ≥ 1500ms」，
   于是把 `fs.statSync` 包一层忙等 1700ms 再调 `fn()`，`finally` 里就会置上冷却时间；
   紧接着第二次调用自然走 `tier=breaker`。代价是这一条用例要 6.8 秒，
   **所以它必须单独放在文件最后**，否则会连带拖超时别的用例。
2. **用「第 n 次」定位**（当状态由调用次数决定）。见前面 `spThrowAt` 那条：
   同一个属性被十几次读取，只有其中几次不在 `try` 里，靠计数把异常打到那一次。
3. **只钉源码形状**（当上面两条都要付出不成比例的代价）。风暴窗（10 秒 120 次）
   与重入保护（`hungDepth > 0`）属于这类：要造 121 次重算得每轮写盘，
   而重入在进程内根本没有第二次进入的路径。写进 test-map 盲区，附一条 `grep` 检测办法。

判据：**能不能说清「用户会看到什么不同」**。熔断说得出（正文变成内存里那份旧的），
所以值得花 6.8 秒；风暴窗说不出（只是重算次数），就只留常量断言。

### 想 monkeypatch 内置模块，必须走 `createRequire` + `syncBuiltinESMExports`

`await import("node:crypto")` 拿到的是**只读命名空间**，赋值会抛
`Cannot assign to read only property 'createDecipheriv'`。可行的写法：

```js
import { createRequire } from "node:module";
import { syncBuiltinESMExports } from "node:module";
const cjs = createRequire(import.meta.url)("node:crypto");
const REAL = cjs.createDecipheriv;      // 一定要先存原引用
cjs.createDecipheriv = () => { throw new Error("sealed slot unavailable"); };
syncBuiltinESMExports();                 // ESM 侧同引用立刻生效
// ...用例...
cjs.createDecipheriv = REAL;            // 恢复，不能 delete
syncBuiltinESMExports();
```

两个坑：**不能 `delete`**——`delete` 之后 CJS 对象上没有 own property，ESM 绑定仍指向坏实现，
`defaultOverrideText()` 会一直是 0（探针 8 就栽在这）；**必须 `finally` 恢复**，
否则同进程后续用例全都读不到内置正文。


### 平台相关的分支，用配置把平台钉住，不要拿 `process.platform` 去凑

同一个函数里既有「按真实平台分叉」也有「按可配置的平台分叉」两种情况，判据是**它读的是什么**：

- 读 `process.platform` / `os.platform()`（常见写法是模块级常量 `const isWindows = process.platform === "win32"`）→ 只能用 `asWin32(fn)` 或在伪装 linux 的 preload 下跑，而且**模块级常量连 `asPlatform` 都改不动**（`lib/core.js:40`）。
- 读一份可配置的平台（`lib/redteam/platform-config.js` 的 `isWinLike(cfg)`：先看 `cfg.platform === "windows" | "linux"`，都没有才回落 `osPlatform() === "win32"`）→ **写一份 `platform: "linux"` 的 config.json 就能在 Windows 上跑 linux 分支**，两平台跑出来的期望值完全一致，不用在用例里写 `if (process.platform === ...)` 分叉。

`test-recon-preflight-edges.mjs` 就是第二种：`withPreflight` 每次都写 `<home>/redteam/config.json` 里 `platform: "linux"`，于是「首次无 setup.sh / 有脚本没跑 / 有缺口 / 有坏技能 / 全干净」五条 `next` 分支在 CI 的 ubuntu 与本机 win32 上是同一份断言。反过来说，凡是**行为层区分不了**的（`chmod 0o755` 在 Windows 是空操作、`fs.symlinkSync` 会把 `/` 归一成 `\`），不要去伪造平台，直接退到源码形状断言。

### 断言「某函数返回的形状」之前，先问一句：CI 上没有这套外部状态时它还回这个形状吗

`ensureRestartReady()` 只是转发 `core.ensureHostClean()`：

- 本机（有宿主安装树、补丁齐全）回 `{ ok: true, aiBase: "…", pending: [], hosts: [仓库树, 桌面安装树] }`；
- CI 上（没有宿主树）回 `{ ok: false, error: "…", aiBase: null }` —— **连 `pending` 这个键都没有**。

于是 `assert.ok(Array.isArray(out.pending))` 在本机永远绿、在 CI 永远红，而这条用例本身是对的（它测的是「有没有转发」）。正确写法是**先与直接调用底层函数的结果 `deepEqual`**（证明转发），再按 `ok` 分两支各断言各的字段。同类还有：`inspectRuntimePayload("")` 会去 discovery 本机安装树、`gatherState()` 的 `ai_base` 会落到 npm 全局树、`officeSkillAssetSources()` 读真安装树（CI 上走 `reason:"no-source"`）。

判据很简单：**这个函数有没有「外部状态不存在时的早退形状」**。有，就必须写成「两种情况都成立」的断言，或者把外部状态也钉住（沙箱 `DSH_BASE` / `DSH_DESKTOP_INSTALL`）。


## 拦下 `import { spawn }` 这种具名导入，必须 `syncBuiltinESMExports()`

`lib/web.js` 里写的是 `import { spawn } from "node:child_process"`。这种具名导入在模块求值那一刻就把绑定指到了内置模块的属性上，之后：

- 改 `require("node:child_process").spawn = fake` —— **没用的**，ESM 侧还是原函数；
- 改 `globalThis.spawn` —— 更没用，模块从来没查过 `globalThis`；
- 只有在赋值之后调一次 `syncBuiltinESMExports()`（`node:module` 导出），ESM 的具名绑定才会重新指向 CJS 对象上的当前值。

所以「拦 spawn / 拦 `fs.renameSync` / 拦 `process.exit` 之外的任何内置模块函数」都是同一套三步：

```js
const require = createRequire(import.meta.url)
const CJS = require('node:child_process')      // CJS 对象，属性可写
const REAL = CJS.spawn                          // 必须先存引用，否则还原不回去
CJS.spawn = (cmd, args, opts) => { /* 记录 */ return { unref() {}, pid: 1 } }
syncBuiltinESMExports()                        // ← 少了这句全白干
try {
  await 被测函数()
} finally {
  CJS.spawn = REAL
  syncBuiltinESMExports()                      // ← 还原也要 sync，否则后面几个测试文件还看到假的
}
```

三个配套注意：

1. **`process.exit` 不在这套机制里** —— 它是 `process` 对象的 own property，直接赋值就生效，但同样要在 `finally` 里还原（同进程里 `node --test` 还要跑别的文件）。
2. **假 `setTimeout` 只记不跑**。`setTimeout(() => process.exit(0), 250)` 这种「延时退出」如果让假实现真去回调，测试进程当场死掉；只收下毫秒数、返回 `{ unref() {} }`，就能把「延时是 250 还是 400」钉住。代价是**「回调真的执行了」这件事没被验**，要写进盲区。
3. **`delete` 之后不可恢复，永远存引用。** 置坏一个内置函数再 `delete CJS.xxx`，ESM 绑定还指着坏实现、CJS 对象又没了 own property，两边都对不上（`prompt-source` 那批踩过：`delete` 完 `defaultOverrideText()` 仍是 0）。存 `const REAL = CJS.xxx`、最后 `CJS.xxx = REAL` 才是唯一可靠写法。

**判断依据**：只要打算 monkeypatch 的东西是**从内置模块具名导入**的（`import { spawn }`、`import { rename }`、`import { createDecipheriv }`），就一定要 `syncBuiltinESMExports()`；如果是模块自己导出的对象属性（`agent.cancel`、`ctx.effect`）或者 `process.env` 这类全局，就不需要。


## 「本机造不出 fixture」这句话，先算一遍判定要什么，再说造不出来

盲区 74 那条写着「`findDshHome` 的桌面分支要扫真安装树、要读 `process.resourcesPath`，写进用例就是在测环境」，挂了十几批。真正动手时发现它只要三件东西：一棵**过判据**的假安装树（目录里有 `DeepSeek Harness.exe`）、一个把 `USERPROFILE` 指进沙箱的 `process.env`、以及每次改现场后的一次 `resetPathMemo()`。三件都做到，28 + 10 行一次全绿。

所以写「造不出来」之前，按这三步过一遍：

1. **把判定链抄出来，逐项问「这一项读的是磁盘、环境变量、还是进程状态」。** 磁盘能造、环境变量能改、`process.*` 能临时替换；只有「另一台机器上才有的东西」（`/mnt/c/Users`、`process.resourcesPath`）才是真的造不出来。这条链里 `process.resourcesPath` 只有 Electron 进程里有值（Node 下是 `undefined`），于是那一项确实落进盲区；其余全在射程内。
2. **「结果依赖这台机器装了什么」通常是 fixture 没造对。** 候选列表为空、`~/.dsh` 拿走、`found[0]` 是空数组 —— 三种症状都会表现成「走了兜底」，看上去像环境依赖。先验证 fixture 本身：把候选表打印出来，看 `found` 到底有没有进东西。
3. **兜底分支必须靠改 `process.env` 才能沙箱化。** `findDshHome` 的 `const unix = path.join(os.homedir(), ".dsh")` 读的是 `USERPROFILE` / `HOME`，**不是** `options.env`；只把沙箱塞进 `options.env` 会返回真机主目录。同类还有 `os.tmpdir()`（读 `TEMP`）、`os.homedir()` 在 macOS 上读 `HOME`。

配套两条 fixture 纪律：

- **`put(dir, {})` 这种「只建目录」的调用不能省 mkdir。** 把 mkdir 写在 `Object.entries(files)` 循环体里，空对象就一次都不建，后面所有 `isDir` 判断全 false，症状是「我明明造了目录」。
- **回退阶梯要逐级断言，不只断言「最后拿到了对的那个」。** 桌面主目录定位有六级（`DSH_HOME` → 候选里有数据 → `~/.dsh` 有数据 → 候选里没数据就回第一个 → 什么都没有仍回 `~/.dsh` 路径 → web 面先看启动器旁），少一级也只会在特定机器上表现成「写进去的提示词不生效」。

## 「向上逐级查」的自愈，fixture 要放在查不到的位置

软链启动器自愈那条链（`lib/core.js:4456-4539`）里有两个函数是一对：

- `officialBinJsNearLauncher(fp)` 只看三个**指定**位置：`<dir>/../lib/node_modules/…`、
  `<dir>/../node_modules/…`、`<dir>/../../lib/node_modules/…`；
- `canResolveAppBoot(fp)` 从 `dirname(fp)` 开始**逐级向上**，每层查
  `node_modules/@deepseek-ai/dsh-app-boot`，最多八层。

自愈分支的判据是 `looksLikeCopiedBinJs(text) && !canResolveAppBoot(fp)`。把官方入口放在
`root/node_modules/@deepseek-ai/` 时，`canResolveAppBoot` 已经为真，自愈根本不会发生 ——
我第一次就是这么写的，用例红在 `healed === false`，而实现完全正确。

规矩：**要测「找不到所以去别处找」这一类分支，fixture 必须放在逐级查找看不到、只有指定
候选看得到的那一格**（这里是 `<dir>/../lib/node_modules`），并且另用一条用例钉住
「按层数上限确实停下来了」（第九层才命中要判 false）。

## 给模块加 `export` 之后，跑一遍全量再写文档

`lib/core.js` 的导出名被 `scripts/test-patch-registry.mjs:46` 的 `EXPORT_EXTRA` 白名单钉着：
新名字不在名单里 → `unexpected new core export`；名单里的名字不再导出 → `stale EXPORT_EXTRA entry`。
这条断言只在全量跑时才会命中（`node --test scripts/test-new-file.mjs` 永远绿），而它又是
「补丁注册表没被动过」的唯一守卫。所以顺序固定为：改 `lib/` → 跑新文件 → **跑
`npm run check`** → 才去写 `docs/test-map.md` 与提交信息。

## 依赖 `import * as core` 抛错的 catch，是测不到的

`lib/reapply.js` 里十六处 `catch` 的触发条件都是「`core.*` 抛了」，而这个模块用
`import * as core from "./core.js"` —— 命名空间对象的属性只读，`core.findAiBase = …` 会抛
`TypeError: Cannot assign to read only property`，`monkeypatch` 这条路直接封死。

不要因为「把 `fs.*` 全换成抛错」看着像能造，就去写：实测 `core.findAiBase()` 在这种环境下
仍然回 `null`（内部层层 try/catch 吞掉），`core.patchStatus(<不存在路径>)` 照样回 86 行，
`desktopAsarStillSealed()` 在沙箱假树里回 `false`。**判据是「这条 catch 的触发条件能不能由
磁盘状态造成」**：能（`pluginVersion` 自己的 `fs.readFileSync`）就写用例；不能就写进
`docs/test-map.md` 的盲区，附一句怎么在真机上验。

## 「只对某一条补丁生效的前置改写」，要连「一条 replacement 都不命中」一起测

`applyReplacementsToText` 里有这么一段：

```js
if (patch?.id === 42) {
  const collapsed = collapseDuplicateLegacyApplyPath(source);
  if (collapsed !== source) { source = collapsed; preChanged = true; }
  const rewritten = rewriteStaleLegacyApplyCall(source);
  if (rewritten !== source) { source = rewritten; preChanged = true; }
}
```

它跟 replacements 完全无关，`preChanged` 会独立把 `changed` 顶成 `true`。所以测它必须分两路：
**replacements 为空数组时 `changed` 仍为 `true`**、以及 **别的补丁 id 面对同一段重复定义时
`changed` 为 `false` 且正文一字节未改**。只测「有 replacement、最后也命中了」那一半，会把
「折叠了没算改动」和「没折叠却算了改动」两种错一起放过。

配套的规矩：全量替换用 `split().join()` 而不是 `replace()`，用例就得放**两处**旧调用；
收口空行的地方要用「三连空行」的正文去钉；早退守卫（`if (starts.length < 2) return text;`）
要用「有花括号但没有目标函数」的正文去钉 —— 删掉早退之后 `indexOf("{")` 会从任意花括号起算，
把后面的内容切走，这种错在正常 fixture 上完全看不出来。

## 同一个状态有两个来源时，要有一条「第一个来源不完整」的用例

`findDesktopShimDir()` 先看桌面树的 `resources/runtime/cli/bin`，再看 PATH。第二个来源不是
「第一个失败时」才走，而是「第一个**连目录都不在**」时才走 —— 因为第一个来源的判据是 `isDir`，
目录在就算数。所以用例至少要三条：①只有第一个来源；②第一个来源在、但里面什么都没有；
③第一个来源完全不在、第二个来源在。少第三条，「第一个来源的判据被写严了」看不出来；
少第二条，「判据被写宽了（比如要求启动器存在）」也看不出来。

配套的两条：
- **`path` / `desktop-cli` 这类来源标记要单独断言**，不能只断言三件套状态。状态一样、来源不同，
  在界面上是两种提示（该去哪打补丁 / 该去 PATH 上找）。
- **同一份状态的两个消费者要各测一次**：`gatherState()` 在 web 面根本不看桌面树，桌面树的用例
  全绿也不代表 web 面没被带偏。

## `after` 这种「软引用」要按「归一化之后能不能对上真实注册表」来测

链式补丁的 `after: [87]` 是软引用：id 写在注册表里，比对时 `ALL_PATCHES.find(p => p.id === depId)`
是**严格相等**。所以字符串 `"87"` 归一化漏掉一步，就静默变成「前驱不存在 → 跳过 → drifted」——
界面上从「有活没干」变成「上游漂移」，两种红字含义完全不同。四条用例缺一不可：
数组里混字符串、数组里只有字符串、写成单个数字（不是数组）、写成字符串（不是数组）。
判定标准是「用户会看到哪一行字」，不是「函数返回了什么东西」。

## 判据写在同一行里的「或」链，每一条都要有能单独成立的输入

`pathLooksDesktop` 里那一长串 `||` 有二十来项，其中「最大多数项其实被前面的项吃掉」是常态：
`p.endsWith("/ds-bot")` 永远走不到，因为路径末段是 `ds-bot` 时 basename 早被正则认掉了。
同样 `if (!resourcesPath) return false;` 被下面的 `/resources` 结尾判定完全覆盖。

这类冗余不是错，是纵深防御；但**突变演练会把它暴露成 GREEN**，而 GREEN 的第一反应不该是
「补一条用例」——先问一句「有没有任何输入能让这两条给出不同答案」。没有就是等价突变，删掉，
然后在源码形状断言里钉住它还在，免得下一个人把它当可达逻辑去改。

有输入能区分的时候，判据是「用户会看到什么不同」：
- `app.asar` 是目录还是文件 → 半截安装包会不会被判成可用；
- `versions.electron` 有没有 → 普通 Node 进程会不会被误判成社区桌面壳；
- `DSH_SURFACE` 与 exe 名字谁优先 → 用户显式指定错了还按不按他说的跑。

这三条各自都对应一句用户能看见的差别，所以各写一条用例；`endsWith("/ds-bot")` 没有，所以不写。
