# 提示词变体资产盘点（P3-8b）

数据源：`docs/prompt-inject-v1.md` 至 `docs/prompt-inject-v6.md`（真实仓库文件）。统计由 `node scripts/prompt-variants.mjs --json` 生成，基线为 v1。

| 版本 | 字节 | 字符 | 行数 | SHA-256（前12） | 标题数 | 槽位数 | 核心 marker 是否齐全 |
| --- | ---: | ---: | ---: | --- | ---: | ---: | :---: |
| v1 | 23035 | 20349 | 206 | 713aa3968549 | 0 | 51 | 是 |
| v2 | 22984 | 20298 | 176 | 50064a540e84 | 0 | 51 | 是 |
| v3 | 5158 | 2914 | 60 | 23773fb1c33a | 6 | 27 | 是 |
| v4 | 8085 | 4353 | 66 | c9fb7756a0d0 | 7 | 32 | 是 |
| v5 | 12297 | 6210 | 105 | f6251e0204e7 | 10 | 33 | 是 |
| v6 | 16918 | 8549 | 125 | 8eceb38c8f16 | 17 | 33 | 是 |
| 合计 | 88477 | 62673 | 738 | — | 40 | 227 | 是 |

说明：

- 行数为逻辑行数（末尾无换行时最后一行仍计入）；字符数按 Unicode code point 统计，字节数为 UTF-8 字节数。
- 标题数按 Markdown ATX 标题（`#` 至 `######`）统计；v1、v2 为纯文本章节标签，没有 Markdown 标题，因此为 0。
- 槽位数按去重后的占位符名统计，覆盖 `[TARGET_IP]`、`[DOMAIN]`、`[PATH]`、`PAYLOAD`、`TARGET`、`OFFSET`、`PATCH_BYTE`、`CHECK_FN`、`LICENSE_BLOB`、`SAMPLE` 等形态。
- 核心 marker 是否齐全按语义等价识别（例如 v3 的“场景规则”“锚”分别对应 Scoped Rules、House Rules），六版均由 `node scripts/prompt-variants.mjs --check` 复核为 PASS。
- 此表只描述资产，不代表模型效果。

复核命令：

- 表格：`node scripts/prompt-variants.mjs`
- JSON：`node scripts/prompt-variants.mjs --json`
- 核心 marker：`node scripts/prompt-variants.mjs --check`
