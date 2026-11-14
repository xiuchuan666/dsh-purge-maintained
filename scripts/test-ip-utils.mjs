/**
 * lib/redteam/ip-utils.js 的守卫。
 *
 * 这一组函数的坏法都不报错，只让面板显示错东西：
 *   · cidrOf 判错 → 资产测绘左侧多出一个假网段、资产归属到错的段；
 *   · scopeOfIp 判错 → 内网目标被当外网（或反过来），扫描范围与报告口径一起偏；
 *   · ipToInt 判错 → ORDER BY ip_int 的自然排序乱掉（NULL 会退到文本序）；
 *   · slugTarget / slugPoc 判错 → 同一个目标的攻击文件散到两个目录、知识库条目引用不上。
 * 所以这里钉的是「现在到底算什么」，包括几处明显不严谨但被依赖的现状。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ipToInt, isIpv6, expandIpv6, cidrOf, scopeOfIp,
  slugify, slugTarget, slugPoc, defaultPocFilename, nowIso,
} from "../lib/redteam/ip-utils.js";

const EIGHT_ZEROS = ["0", "0", "0", "0", "0", "0", "0", "0"];

/* ── expandIpv6 ───────────────────────────────────────────────────────────── */

test("expandIpv6：完整八组原样保留，不去前导零，但统一小写", () => {
  assert.deepEqual(expandIpv6("2001:0db8:0000:0000:0000:0000:0000:0001"),
    ["2001", "0db8", "0000", "0000", "0000", "0000", "0000", "0001"]);
  assert.deepEqual(expandIpv6("2001:DB8::1"),
    ["2001", "db8", "0", "0", "0", "0", "0", "1"]);
});

test("expandIpv6：:: 缩写按缺几组补几个 0，中间补齐", () => {
  assert.deepEqual(expandIpv6("2001:db8::1"),
    ["2001", "db8", "0", "0", "0", "0", "0", "1"]);
  assert.deepEqual(expandIpv6("2001:db8:1:2:3:4::5"),
    ["2001", "db8", "1", "2", "3", "4", "0", "5"]);
});

test("expandIpv6：前后端省略都补：::1 补七个、fe80:: 补七个", () => {
  assert.deepEqual(expandIpv6("::1"), [...EIGHT_ZEROS.slice(0, 7), "1"]);
  assert.deepEqual(expandIpv6("fe80::"), ["fe80", ...EIGHT_ZEROS.slice(1)]);
  assert.deepEqual(expandIpv6("::"), EIGHT_ZEROS);
});

test("expandIpv6：方括号剥掉（带端口的 URL 里常见）", () => {
  assert.deepEqual(expandIpv6("[2001:db8::1]"),
    ["2001", "db8", "0", "0", "0", "0", "0", "1"]);
});

test("expandIpv6：IPv4-mapped 把最后一段当一组字符串，不拆成四段", () => {
  assert.deepEqual(expandIpv6("::ffff:192.168.1.1"),
    ["0", "0", "0", "0", "0", "0", "ffff", "192.168.1.1"]);
});

test("expandIpv6：超过八组不截断（missing 负数被 max(…,0) 挡掉）——现状", () => {
  assert.deepEqual(expandIpv6("1:2:3:4:5:6:7:8:9:10"),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
});

test("expandIpv6：非 IPv6 输入不报错，IPv4 当第一组、空串当全零", () => {
  assert.deepEqual(expandIpv6("10.0.0.1"), ["10.0.0.1", ...EIGHT_ZEROS.slice(1)]);
  assert.deepEqual(expandIpv6(""), EIGHT_ZEROS);
  assert.deepEqual(expandIpv6(null), EIGHT_ZEROS);
});

/* ── isIpv6 ───────────────────────────────────────────────────────────────── */

test("isIpv6：正常写法、:: 缩写、IPv4-mapped 都认", () => {
  for (const ip of ["::1", "2001:db8::1", "::ffff:192.168.1.1", "1:2:3:4:5:6:7:8", " 2001:db8::1 "]) {
    assert.equal(isIpv6(ip), true, ip);
  }
});

test("isIpv6：IPv4、空值、非十六进制段、没有冒号的裸十六进制串都不算", () => {
  // 没有冒号那几条是「isIpv6 先看有没有 :，而不是先跑正则」这条早退的唯一可见证据：
  // "abcdef" 全在字符表里、split(':').length 也是 1，一旦去掉 includes(':') 判据就会被认成 IPv6。
  for (const ip of ["10.0.0.1", "", null, undefined, "g::h", "2001:db8::1z", "abcdef", "2001db8"]) {
    assert.equal(isIpv6(ip), false, String(ip));
  }
});

test("isIpv6：大写十六进制也算（字符表里有 A-F）", () => {
  assert.equal(isIpv6("2001:DB8::1"), true);
  assert.equal(isIpv6("FE80::1"), true);
});

test("isIpv6：两个 :: 也不拦（只看字符表与段数）——现状", () => {
  // 真正的 IPv6 只允许一处 ::；这里没校验，expandIpv6 会按第一个 :: 切开、后面那段当右半。
  assert.equal(isIpv6("2001:db8::1::2"), true);
});

test("isIpv6：只看字符与段数，所以 : / ::: / 九组也都算 ——现状", () => {
  // 正则只要求 [0-9a-fA-F:]+ 且 split(':').length <= 9，没有「至少两个段」的校验。
  assert.equal(isIpv6(":"), true);
  assert.equal(isIpv6(":::"), true);
  assert.equal(isIpv6("1:2:3:4:5:6:7:8:9"), true);
});

/* ── cidrOf ───────────────────────────────────────────────────────────────── */

test("cidrOf：IPv4 取前三段补 .0/24，两侧空白被 trim", () => {
  assert.equal(cidrOf("10.1.2.3"), "10.1.2.0/24");
  assert.equal(cidrOf("  192.168.1.1  "), "192.168.1.0/24");
});

test("cidrOf：IPv6 取前四组补 ::/64（IPv6 的「一个网段」）", () => {
  assert.equal(cidrOf("2001:db8:1234:5678:9abc::1"), "2001:db8:1234:5678::/64");
  assert.equal(cidrOf("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(cidrOf("::1"), "0:0:0:0::/64");
  assert.equal(cidrOf("fe80::1"), "fe80:0:0:0::/64");
});

test("cidrOf：IPv4-mapped 按 IPv6 走，得到 0:0:0:0::/64（不剥壳）——现状", () => {
  // scopeOfIp 会把 ::ffff:a.b.c.d 剥壳按 IPv4 判，cidrOf 不剥，两边口径不同。
  assert.equal(cidrOf("::ffff:10.0.0.1"), "0:0:0:0::/64");
});

test("cidrOf：认不出来就原样返回，绝不拼出四不像的假 CIDR", () => {
  for (const raw of ["not-an-ip", "", "10.0.0.0/24", "a.example.com"]) {
    assert.equal(cidrOf(raw), raw);
  }
});

test("cidrOf：带端口的 IP 不认（原样返回）——现状", () => {
  // 资产表里 ip 列本来就不该带端口，这里不额外兜底，保持原样便于肉眼发现脏数据。
  assert.equal(cidrOf("10.1.2.3:8080"), "10.1.2.3:8080");
});

test("cidrOf：超长 IPv6 仍按前四组切，不做合法性复查", () => {
  assert.equal(cidrOf("1:2:3:4:5:6:7:8:9"), "1:2:3:4::/64");
});

/* ── scopeOfIp ────────────────────────────────────────────────────────────── */

test("scopeOfIp：RFC1918 三段 + 回环 + 链路本地 都是 internal", () => {
  for (const ip of ["10.0.0.1", "192.168.1.1", "127.0.0.1", "169.254.1.1"]) {
    assert.equal(scopeOfIp(ip), "internal", ip);
  }
});

test("scopeOfIp：172.16-31 的上下边界，31 之外算外网", () => {
  assert.equal(scopeOfIp("172.15.0.1"), "external");
  assert.equal(scopeOfIp("172.16.0.1"), "internal");
  assert.equal(scopeOfIp("172.31.255.255"), "internal");
  assert.equal(scopeOfIp("172.32.0.1"), "external");
});

test("scopeOfIp：100.64-127（CGNAT）的上下边界", () => {
  assert.equal(scopeOfIp("100.63.0.1"), "external");
  assert.equal(scopeOfIp("100.64.0.1"), "internal");
  assert.equal(scopeOfIp("100.127.255.255"), "internal");
  assert.equal(scopeOfIp("100.128.0.1"), "external");
});

test("scopeOfIp：172 / 100 只有出现在第一段才算，出现在后面不算", () => {
  assert.equal(scopeOfIp("192.172.16.1"), "external");
  assert.equal(scopeOfIp("8.100.64.1"), "external");
});

test("scopeOfIp：fc00::/7（ULA）算内网", () => {
  for (const ip of ["fc00::1", "fd12:3456::1", "FD00::1"]) {
    assert.equal(scopeOfIp(ip), "internal", ip);
  }
});

test("scopeOfIp：fe80::/10 整段算内网（fe80/fe88/fe90/fea0/feb0 都在内）", () => {
  for (const ip of ["fe80::1", "fe88::1", "fe90::1", "fea0::1", "feb0::1"]) {
    assert.equal(scopeOfIp(ip), "internal", ip);
  }
  // fe c0 起就出了 /10
  assert.equal(scopeOfIp("fec0::1"), "external");
});

test("scopeOfIp：公网 IPv6 算外网", () => {
  assert.equal(scopeOfIp("2001:db8::1"), "external");
  assert.equal(scopeOfIp("2400:3200::1"), "external");
});

test("scopeOfIp：IPv4-mapped 剥壳后按 IPv4 判", () => {
  assert.equal(scopeOfIp("::ffff:10.0.0.1"), "internal");
  assert.equal(scopeOfIp("::ffff:192.168.1.1"), "internal");
  assert.equal(scopeOfIp("::ffff:8.8.8.8"), "external");
});

test("scopeOfIp：纯回环 ::1 判成外网 ——现状（不是遗漏的 IPv4 回环）", () => {
  // 现实现只认 127. 开头的 IPv4 回环；::1 落到 external。
  // 钉住它是为了让「以后想改」的人看见这条会影响报告口径。
  assert.equal(scopeOfIp("::1"), "external");
});

test("scopeOfIp：空值与无法解析的串一律 external", () => {
  for (const raw of ["", null, undefined, "garbage"]) {
    assert.equal(scopeOfIp(raw), "external", String(raw));
  }
});

test("scopeOfIp：前缀匹配不看段数，10.0.0 这种残缺地址也算内网 ——现状", () => {
  // 四条 IPv4 判据都是「以 xx. 开头」，不是完整地址校验：Asset.ip 脏了会照样归内网。
  assert.equal(scopeOfIp("10.0.0"), "internal");
  assert.equal(scopeOfIp("192.168."), "internal");
});

/* ── ipToInt ──────────────────────────────────────────────────────────────── */

test("ipToInt：正常 IPv4 转 32 位无符号整数（不出现负数）", () => {
  assert.equal(ipToInt("0.0.0.0"), 0);
  assert.equal(ipToInt("1.2.3.4"), 16909060);
  assert.equal(ipToInt("255.255.255.255"), 4294967295);
  assert.ok(ipToInt("255.255.255.255") > 0, "必须是无符号结果");
});

test("ipToInt：两侧空白被 trim", () => {
  assert.equal(ipToInt(" 10.0.0.1 "), 167772161);
});

test("ipToInt：段数不足/过多、IPv6、空值、非数字一律 null（让 ip_int 留 NULL）", () => {
  for (const raw of ["1.2.3", "1.2.3.4.5", "2001:db8::1", "", null, "a.b.c.d"]) {
    assert.equal(ipToInt(raw), null, String(raw));
  }
});

test("ipToInt：每段只校验位数不校验范围，256.1.1.1 也算 ——现状", () => {
  // 正则只要求 \d{1,3}；256 溢出进下一段，得到 65793（= 1 * 65536 + 1*256 + 1）。
  assert.equal(ipToInt("256.1.1.1"), 65793);
});

/* ── slugTarget ───────────────────────────────────────────────────────────── */

test("slugTarget：空值退回 unknown", () => {
  for (const raw of ["", "   ", null, undefined]) {
    assert.equal(slugTarget(raw), "unknown", String(raw));
  }
});

test("slugTarget：IP 与 ip:port 都只取 IP（同一 IP 的端口归一个目录）", () => {
  assert.equal(slugTarget("10.1.2.3"), "10.1.2.3");
  assert.equal(slugTarget("10.1.2.3:8080"), "10.1.2.3");
});

test("slugTarget：URL 只取 host（去协议、端口、路径、查询串）", () => {
  assert.equal(slugTarget("https://a.example.com/path?q=1"), "a.example.com");
  assert.equal(slugTarget("http://a.example.com:8443/x"), "a.example.com");
  assert.equal(slugTarget("HTTPS://A.Example.COM/x"), "A.Example.COM");
});

test("slugTarget：没有协议头的串整段当 host，路径不会被剥掉 ——现状", () => {
  // urlMatch 只在 ^https?:// 命中时取 host；裸串走 hostPort = raw，斜杠变成下划线。
  assert.equal(slugTarget("A.Example.COM/x"), "A.Example.COM_x");
});

test("slugTarget：裸 host:port 也把端口摘掉", () => {
  assert.equal(slugTarget("a.example.com:443"), "a.example.com");
});

test("slugTarget：非 ASCII 目标整段被替换掉，只剩 unknown ——现状", () => {
  // 替换用的是 [^\w.\-]（没有 u 标志），中文与空格都变 _，再被尾部 _+ 清空。
  assert.equal(slugTarget("中文 目标"), "unknown");
});

test("slugTarget：只有协议没有 host 时把协议名当目录名 ——现状", () => {
  assert.equal(slugTarget("https://"), "https");
});

test("slugTarget：IPv6 URL 的方括号/冒号都变下划线 ——现状（不适合当目录名的脏名）", () => {
  assert.equal(slugTarget("http://[2001:db8::1]:80/x"), "_2001_db8__1");
});

/* ── slugPoc ──────────────────────────────────────────────────────────────── */

test("slugPoc：只给 CVE 得到 cve-年-号", () => {
  assert.equal(slugPoc("CVE-2023-21839", "CVE-2023-21839"), "cve-2023-21839");
  assert.equal(slugPoc("", "CVE-2023-21839"), "cve-2023-21839");
});

test("slugPoc：标题里已经写了 CVE 就不再拼一遍", () => {
  assert.equal(slugPoc("Weblogic CVE-2023-21839 RCE", "CVE-2023-21839"),
    "weblogic-cve-2023-21839-rce");
  // 用「去掉非字母数字后是否包含」判断，所以大小写/分隔符差异也算「已包含」。
  assert.equal(slugPoc("weblogic cve_2023_21839 rce", "CVE-2023-21839"),
    "weblogic-cve-2023-21839-rce");
});

test("slugPoc：CVE 与标题无关时把 CVE 放前面", () => {
  assert.equal(slugPoc("Some Title", "CVE-2020-1234"), "cve-2020-1234-some-title");
});

test("slugPoc：中文标题保留（\\u4e00-\\u9fa5 在白名单里）", () => {
  assert.equal(slugPoc("某系统 反序列化 漏洞", ""), "某系统-反序列化-漏洞");
});

test("slugPoc：结果不超过 80 字符且不以短横线结尾", () => {
  const slug = slugPoc("a".repeat(200), "");
  assert.equal(slug.length, 80);
  assert.ok(!slug.endsWith("-"), slug);
});

test("slugPoc：标题与 CVE 都空时退回 poc-<时间戳>", () => {
  assert.match(slugPoc("", ""), /^poc-\d+$/);
  assert.match(slugPoc(" - ", ""), /^poc-\d+$/);
});

/* ── defaultPocFilename ───────────────────────────────────────────────────── */

test("defaultPocFilename：语言名与常见别名都映射到扩展名（大小写不敏感）", () => {
  const table = {
    python: "poc.py", py: "poc.py", go: "poc.go", java: "poc.java",
    bash: "poc.sh", sh: "poc.sh", shell: "poc.sh", js: "poc.js", node: "poc.js",
    php: "poc.php", ruby: "poc.rb", powershell: "poc.ps1", http: "poc.http",
    nuclei: "poc.yaml", yaml: "poc.yaml",
  };
  for (const [lang, want] of Object.entries(table)) {
    assert.equal(defaultPocFilename("t", "script", lang), want, lang);
  }
  assert.equal(defaultPocFilename("t", "script", "Python"), "poc.py");
  assert.equal(defaultPocFilename("t", "script", "SHELL"), "poc.sh");
});

test("defaultPocFilename：语言不认识时按 kind 兜底（template → yaml，其他 → txt）", () => {
  assert.equal(defaultPocFilename("t", "template", "brainfuck"), "poc.yaml");
  assert.equal(defaultPocFilename("t", "script", "brainfuck"), "poc.txt");
  assert.equal(defaultPocFilename("t", "template", null), "poc.yaml");
  assert.equal(defaultPocFilename("t", undefined, undefined), "poc.txt");
});

/* ── slugify ──────────────────────────────────────────────────────────────── */

test("slugify：小写、非字母数字转短横线、首尾短横线剪掉", () => {
  assert.equal(slugify("  ACME  Inc.  "), "acme-inc");
  assert.equal(slugify("a/b\\c"), "a-b-c");
});

test("slugify：中文属于 \\p{L}，保留在 slug 里", () => {
  assert.equal(slugify("ACME 科技"), "acme-科技");
});

test("slugify：清洗后为空时退回 engagement-<时间戳>（防重名/防空目录）", () => {
  assert.match(slugify("---"), /^engagement-\d+$/);
  assert.match(slugify(""), /^engagement-\d+$/);
  assert.match(slugify(null), /^engagement-\d+$/);
});

/* ── nowIso ───────────────────────────────────────────────────────────────── */

test("nowIso：ISO-8601 UTC 形状且单调不减", () => {
  const a = nowIso();
  assert.match(a, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(!Number.isNaN(Date.parse(a)), a);
  const b = nowIso();
  assert.ok(b >= a, `${b} >= ${a}`);
});
