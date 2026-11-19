#!/usr/bin/env node
// 只读网络体检：DNS 服务器可达性 / hosts 里的 github 覆盖 / NO_PROXY 与代理 / 系统解析结果。
// 不改任何全局状态；每条问题都给出可直接粘贴的修复命令。
import fs from "node:fs";
import net from "node:net";
import dns from "node:dns/promises";
import { execFileSync } from "node:child_process";

const HOSTS = process.platform === "win32" ? "C:/Windows/System32/drivers/etc/hosts" : "/etc/hosts";
const PROXY_PORT = Number(process.env.DSH_PROXY_PORT || 10808);

function ps(script) {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 15000 });
  } catch { return ""; }
}

function dnsServers() {
  const out = ps("Get-DnsClientServerAddress | Where-Object { $_.ServerAddresses.Count -gt 0 } | ForEach-Object { \"$($_.InterfaceAlias)|$($_.AddressFamily)|$($_.ServerAddresses -join ',')\" }");
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [iface, family, servers] = line.split("|");
    // Get-DnsClientServerAddress 的 AddressFamily：2 = IPv4，23 = IPv6。
    const fam = family === "2" ? "IPv4" : family === "23" ? "IPv6" : `AF${family}`;
    return { iface, family: fam, servers: (servers || "").split(",").filter(Boolean) };
  });
}

function hostsGithub() {
  let text = "";
  try { text = fs.readFileSync(HOSTS, "utf8"); } catch { return []; }
  return text.split(/\r?\n/).filter((l) => /github/i.test(l) && !/^\s*#/.test(l));
}

function tcpProbe(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.setTimeout(timeout);
    s.once("connect", () => finish(true));
    s.once("timeout", () => finish(false));
    s.once("error", () => finish(false));
    s.connect(port, host);
  });
}

const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || "");
const findings = [];

const servers = dnsServers();
for (const s of servers) {
  for (const ip of s.servers) {
    if (s.family === "IPv6" && /^(2400:3200|2402:4e00)/.test(ip)) {
      findings.push({ level: "warn", what: `${s.iface} 的 IPv6 DNS ${ip} 是常见不可达地址`, fix: `netsh interface ipv6 set dnsservers name="${s.iface}" source=dhcp` });
    }
  }
}

const gh = hostsGithub();
if (gh.length) findings.push({ level: "error", what: `hosts 里有 github 覆盖：${gh.join(" / ")}`, fix: "删掉这些行后 ipconfig /flushdns" });

if (/github\.com/i.test(noProxy)) findings.push({ level: "warn", what: "NO_PROXY 含 github.com，git 会绕过代理直连", fix: "临时推送用：NO_PROXY= no_proxy= git push" });

let proxyOpen = false;
try {
  const gitProxy = execFileSync("git", ["config", "--get", "http.proxy"], { encoding: "utf8" }).trim();
  if (gitProxy) findings.push({ level: "info", what: `git http.proxy=${gitProxy}`, fix: "如要统一走代理，确保 NO_PROXY 不含 github.com" });
} catch { /* 没配置就是直连 */ }

const resolved = await Promise.race([
  dns.resolve4("github.com").catch((e) => ({ error: e.code || e.message })),
  new Promise((r) => setTimeout(() => r({ error: "timeout" }), 5000)),
]);
const addrs = Array.isArray(resolved) ? resolved : [];
if (addrs.length === 0) findings.push({ level: "error", what: `系统解析 github.com 失败（${resolved.error || "空结果"}）`, fix: "netsh interface ipv4 set dnsservers name=\"WLAN\" static 223.5.5.5 primary" });

const proxyReachable = await tcpProbe("127.0.0.1", PROXY_PORT);
if (!proxyReachable) findings.push({ level: "warn", what: `本机代理 127.0.0.1:${PROXY_PORT} 连不上`, fix: "先启动代理，或确认 git/curl 的直连路径可用" });

const report = {
  hosts: HOSTS,
  dnsServers: servers,
  hostsGithub: gh,
  noProxyHasGithub: /github\.com/i.test(noProxy),
  githubResolved: addrs,
  proxy: { port: PROXY_PORT, reachable: proxyReachable },
  findings,
  ok: findings.every((f) => f.level !== "error"),
};
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`DNS: ${servers.map((s) => `${s.iface}/${s.family}=${s.servers.join(",")}`).join("  ") || "无"}`);
  console.log(`github.com 解析: ${addrs.join(", ") || "失败"}`);
  console.log(`代理 127.0.0.1:${PROXY_PORT}: ${proxyReachable ? "可达" : "不可达"}`);
  console.log(`hosts github 行: ${gh.length ? gh.join(" / ") : "无"}`);
  console.log("\n结论: " + (report.ok ? "OK" : "FAIL"));
  for (const f of findings) console.log(`[${f.level}] ${f.what}\n    fix: ${f.fix}`);
}
process.exit(report.ok ? 0 : 1);
