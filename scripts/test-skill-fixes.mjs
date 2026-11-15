// lib/redteam/skill-fixes.js：从报错路径里认出「缺哪个工具」，并给出修法。
//
// 认错了的后果不是报错，而是给出一条对不上号的建议（用户照着装了个没用的东西）。
// 这里的判据是路径形状：toolkit/<工具>/<平台产物>、/bin/ 与 .local/ 的末段、裸文件名。
import test from "node:test";
import assert from "node:assert/strict";

import { toolNameOfPath, fixesForIssue } from "../lib/redteam/skill-fixes.js";

test("toolkit/ 之后的第一段目录名就是工具名（平台产物名要剥掉后缀）", () => {
  assert.equal(toolNameOfPath("/opt/redteam/toolkit/suo5-linux-amd64/suo5"), "suo5");
  assert.equal(toolNameOfPath("C:\\Users\\Administrator\\.dsh\\redteam\\toolkit\\fscan_windows_x64\\fscan.exe"), "fscan");
});

test("/bin/ 与 .local/ 这种标准落点取末段文件名", () => {
  assert.equal(toolNameOfPath("/usr/local/bin/nmap"), "nmap");
  assert.equal(toolNameOfPath("/usr/bin/hydra"), "hydra");
  assert.equal(toolNameOfPath("~/.local/bin/ffuf"), "ffuf");
  assert.equal(toolNameOfPath("~/.local/tools/gogo"), "gogo");
});

test("裸文件名（带平台后缀）剥成工具名，路径里的引号与标点先清掉", () => {
  assert.equal(toolNameOfPath("fscan_windows_x64.exe"), "fscan");
  assert.equal(toolNameOfPath("gogo_linux_arm64"), "gogo");
  assert.equal(toolNameOfPath("\"nuclei\""), "nuclei");
  assert.equal(toolNameOfPath("nmap，"), "nmap");
});

test("认不出的路径给 null（字典、技能文档不算工具），非字符串也是 null", () => {
  assert.equal(toolNameOfPath("/usr/share/wordlists/rockyou.txt"), null);
  assert.equal(toolNameOfPath("skills/some-skill.md"), null);
  assert.equal(toolNameOfPath(""), null);
  assert.equal(toolNameOfPath(42), null);
  assert.equal(toolNameOfPath(null), null);
});

test("issue 的字段类型宽松：paths/env 不是数组/字符串时按空处理，仍给通用建议", () => {
  const noPaths = fixesForIssue({ kind: "path-missing", paths: 42 });
  assert.equal(typeof noPaths, "string");
  assert.equal(noPaths.includes("缺 1 个工具"), false);
  const noEnv = fixesForIssue({ kind: "env-missing", env: { FOFA_KEY: 1 } });
  assert.equal(typeof noEnv, "string");
  assert.equal(noEnv.includes("缺环境变量"), false);
  // 正常形态仍然照常给建议（回归锁）
  assert.match(fixesForIssue({ kind: "env-missing", env: ["FOFA_KEY"] }), /FOFA_KEY/);
  assert.match(fixesForIssue({ kind: "path-missing", paths: ["/usr/local/bin/nmap"] }), /nmap/);
});
