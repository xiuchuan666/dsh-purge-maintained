// lib/redteam/report-replay.js：把报告里的 target 解析成可重放的报文。
//
// 解析错的后果是「离线也能复现」这句话变成假话：Host 头拼错、端口丢进 path、
// IPv6 不加方括号 —— 用户照着粘进 Repeater 只会得到 400。
import test from "node:test";
import assert from "node:assert/strict";

import { parseTarget, commandKind, parseCurl, buildHttpRequest } from "../lib/redteam/report-replay.js";

test("带协议的 IPv6 带端口：方括号剥掉，端口单独取", () => {
  assert.deepEqual(parseTarget("http://[::1]:8080/x"), {
    scheme: "http", host: "::1", port: 8080, path: "/x", authority: "[::1]:8080", ipv6: true,
  });
});

test("不带协议的 IPv6（[::1]:22）也要认，否则冒号会被当成端口分隔切错", () => {
  assert.deepEqual(parseTarget("[::1]:22"), {
    scheme: null, host: "::1", port: 22, path: null, authority: "[::1]:22", ipv6: true,
  });
  assert.deepEqual(parseTarget("[2001:db8::1]"), {
    scheme: null, host: "2001:db8::1", port: null, path: null, authority: "[2001:db8::1]", ipv6: true,
  });
});

test("裸 host[:port] 与带路径的裸主机：端口只认纯数字尾巴", () => {
  assert.deepEqual(parseTarget("10.0.0.5:6379"), {
    scheme: null, host: "10.0.0.5", port: 6379, path: null, authority: "10.0.0.5:6379", ipv6: false,
  });
  assert.deepEqual(parseTarget("example.com"), {
    scheme: null, host: "example.com", port: null, path: null, authority: "example.com", ipv6: false,
  });
  const withPath = parseTarget("example.com/a/b");
  assert.equal(withPath.host, "example.com");
  assert.equal(withPath.port, null);
});

test("空串解析成 null（调用方据此不出报文，而不是拼一条假的）", () => {
  assert.equal(parseTarget(""), null);
  assert.equal(parseTarget(null), null);
  assert.equal(parseTarget("   "), null);
});

test("合成的报文里 Host 头对 IPv6 必须带方括号，非默认端口要带上", () => {
  const text = buildHttpRequest({ url: "[::1]:22" });
  assert.match(text, /^GET \/ HTTP\/1\.1/);
  assert.match(text, /Host: \[::1\]:22/);
});

test("命令类型识别：curl / 扫描器 / msf / 脚本 / 其它，空串给 null", () => {
  assert.equal(commandKind("curl -s http://x"), "curl");
  assert.equal(commandKind("nmap -sV 10.0.0.5"), "scanner");
  assert.equal(commandKind("ffuf -u http://x/FUZZ -w w"), "scanner");
  assert.equal(commandKind("python3 poc.py"), "script");
  assert.equal(commandKind(""), null);
});

test("curl 解析抽不出 URL 就返回 null，不做猜测", () => {
  assert.equal(parseCurl("ls -la"), null);
  const one = parseCurl("curl -X POST http://x/api -d 'a=1'");
  assert.equal(one.url, "http://x/api");
  assert.equal(one.method, "POST");
});
