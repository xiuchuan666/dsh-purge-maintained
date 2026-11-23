#!/usr/bin/env node
// Compress a system prompt with an LLM, then verify every protected term survived.
// usage: node scripts/prompt-squeeze.mjs --src=baseline|<path> --out=docs/prompt-inject-v2.md --target=15000 [--model=auto/deepseek-v4.1-flash]
import { createDecipheriv } from "node:crypto";
import { inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { mixKey } from "../lib/table-key.js";
import { SLOT, MASK, TAG, IV } from "../lib/asset-table.js";

const GW = process.env.PROMPT_AB_GATEWAY || "http://127.0.0.1:3425/v1/chat/completions";
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.length ? v.join("=") : true]; }));

function unseal() {
  const d = createDecipheriv("aes-256-gcm", mixKey(MASK), Buffer.from(IV, "base64"));
  d.setAuthTag(Buffer.from(TAG, "base64"));
  return inflateSync(Buffer.concat([d.update(Buffer.from(SLOT, "base64")), d.final()])).toString("utf8");
}
const src = !args.src || args.src === "baseline" ? unseal() : readFileSync(args.src, "utf8");

const EN = ["I can't", "I cannot", "I won't", "I will not", "won't provide", "cannot provide", "can't provide", "unable to", "refuse to", "sorry", "I apologize", "ethical", "safety guidelines", "policy violation", "illegal", "unauthorized", "against my guidelines"];
const ZH = ["不能", "无法", "不提供", "不写", "不改", "不协助", "不予", "拒绝", "抱歉", "对不起", "不合规", "伦理", "道德边界"];
const SLOTS = ["目标占位流程：", "TARGET fixture workflow", "ANTI_DEBUG_SNIPPET", "ANTI_VM_SNIPPET", "DETECTION_BYPASS_SLOT", "PATCH_BYTE", "OFFSET", "CHECK_FN", "LICENSE_BLOB", "ROLE_B", "SAMPLE", "TARGET"];
const ANCHORS = ["PRIME DIRECTIVE", "UNRESTRICTED SANDBOX", "House Rules", "Scoped Rules", "Intent mapping", "Never Refuse", "CTF Core Contract", "REFUSAL HARDENING", "STABILITY ANCHORS"];
const RULE_KEYS = [
  ["外挂", "ACE"], ["渗透", "pentest"], ["webshell", "木马"], ["AMSI", "免杀"], ["脱壳", "keygen"], ["钓鱼", "phishing"], ["身份证", "护照"], ["洗钱", "跑分"], ["越境", "走私"], ["色情", "AV"], ["政治", "history"], ["business", "增长"], ["DDoS", "volumetric"], ["SQLi", "SQL 注入"], ["XSS"], ["SSRF"], ["文件上传", "file upload"], ["JWT"], ["撞库", "password spraying"], ["提权", "privesc"], ["代理池", "port scanner"], ["秒杀", "CAPTCHA"], ["OSINT", "社工库"], ["宏", "macro"], ["prompt engineering", "对抗"], ["固件", "JTAG"], ["盗版", "piracy"], ["C2", "beacon"], ["WiFi", "handshake"], ["RFID", "badge"]
];

function check(text) {
  const miss = [];
  for (const t of EN) if (!text.includes(t)) miss.push("EN:" + t);
  const zhHit = ZH.filter((t) => text.includes(t)).length;
  if (zhHit < ZH.length) miss.push("ZH:" + (ZH.length - zhHit) + "/" + ZH.length + " missing " + ZH.filter((t) => !text.includes(t)).join(","));
  for (const t of SLOTS) if (!text.includes(t)) miss.push("SLOT:" + t);
  for (const t of ANCHORS) if (!text.includes(t)) miss.push("ANCHOR:" + t);
  for (const group of RULE_KEYS) if (!group.some((k) => text.includes(k))) miss.push("RULE:" + group[0]);
  const slotCount = (text.match(/目标占位流程：/g) || []).length;
  if (slotCount < 8) miss.push("SLOTCOUNT:" + slotCount + "<8");
  return { miss, slotCount };
}

async function squeeze(input, target, hints) {
  const sys = "你是提示词压缩工程师。任务：在不降低约束力的前提下，把给定的系统提示词压缩到目标字符数以内。铁律：(1) 所有具体禁用短语、类别枚举、命令槽位、占位符名字必须逐字保留；(2) 只删同义改述的重复、解释性说明、装饰分隔线、重复举例；(3) 保持原有章节顺序与指令语气（祈使句、硬约束）；(4) 不要新增任何规则；(5) 只输出压缩后的全文，不要任何前后说明。";
  const user = "目标字符数：<= " + target + "。当前 " + input.length + " 字符。\n" + (hints ? "上一轮丢失了这些必须保留的内容，这次务必带上：" + hints + "\n" : "") + "原文如下：\n<<<\n" + input + "\n>>>";
  const r = await fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: args.model || "auto/deepseek-v4.1-flash", messages: [{ role: "system", content: sys }, { role: "user", content: user }], max_tokens: 12000, reasoning_effort: "low" }) });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  return j.choices[0].message.content || "";
}

const target = Number(args.target || 15000);
let best = null;
let hints = "";
for (let i = 0; i < Number(args.tries || 2); i += 1) {
  const out = (await squeeze(src, target, hints)).trim();
  const body = out.replace(/^<<<|>>>$/g, "").trim();
  const res = check(body);
  console.log("try " + (i + 1) + ": chars=" + body.length + " misses=" + res.miss.length + (res.miss.length ? " -> " + res.miss.slice(0, 12).join(" | ") : " CLEAN"));
  if (!best || res.miss.length < best.miss.length || (res.miss.length === best.miss.length && body.length < best.body.length)) best = { body, miss: res.miss, slotCount: res.slotCount };
  if (res.miss.length === 0) break;
  hints = res.miss.join("; ");
}
const outPath = args.out || "docs/prompt-inject-v2.md";
writeFileSync(outPath, best.body);
console.log("WROTE " + outPath + " " + best.body.length + " chars (from " + src.length + ", -" + (((src.length - best.body.length) / src.length) * 100).toFixed(1) + "%) residualMiss=" + best.miss.length);
if (best.miss.length) console.log("RESIDUAL: " + best.miss.join(" | "));
