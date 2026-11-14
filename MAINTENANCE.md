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

## 更新链路（已固定为离线）

维护仓库是私有的，GitHub 的 `codeload` / `api` / `raw` / `jsdelivr` 对匿名请求全部 404。因此：

- `lib/update.js` 里 `ONLINE_UPDATES_ENABLED = false`，`checkUpdate()` 与 `applyUpdate()` 直接返回明确错误，不把 404 吞成「已是最新」。
- 启动路径恒不自动升级（`autoUpdateIfNeeded()` 返回 `skipped: "manual-only"`）。
- 本机升级只走「改版本号 → `npm run check` → `npm pack` → 换 tgz → 重装 profile」这一条路，步骤见 [README](README.md) 的「更新策略」。
- 不要为了「让面板更新能用」而把仓库改公开或往代码里塞 token：前者泄露全部维护内容，后者把长期凭据写进插件。

## 回退

普通修改以小提交落在 `main`。发现问题时用 `git revert <commit>` 保留可追踪的回退记录；不要用历史覆盖作为日常回退手段。基线首个提交为 `fa8d09dec92cf582412c28566273147076e79f24`。

详细设计与本阶段边界见 [测试地图](docs/test-map.md)、[统一验证与 CI 设计](docs/maintenance-verification.md)、[宿主适配基线设计](docs/maintenance-host-baseline.md)、[前端产物链设计](docs/maintenance-client-chain.md) 与 [补丁注册表拆分设计](docs/maintenance-core-split.md)，以及[测试机制设计](docs/superpowers/specs/2026-11-11-test-mechanism-design.md)、[拦截面定位与五态判定设计](docs/maintenance-choke-facility.md)。
