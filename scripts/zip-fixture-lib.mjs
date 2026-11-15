/**
 * 测试共用的最小 zip 打包器（store/deflate 两种都支持）。
 *
 * 为什么要有这个文件：技能包导入（lib/skills.js importArchive）与压缩包解析
 * （lib/zip-extract.js）都只吃真 zip，而 Node 没有内置打包器。以前每个测试各抄一份
 * 三十多行手拼 zip 的代码，抄错 CRC32 就会得到「bsdtar 拒绝」这种与测试意图无关的红。
 * 这里只留一份，fixture 形状（method/注释）也都由参数表达。
 */
import zlib from "node:zlib";

/** 造一份合法的技能文档（frontmatter + 正文）。 */
export function doc(name, description, extra = "") {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n正文\n`;
}

/**
 * 手拼 zip：本地头 + 中央目录 + EOCD，CRC32 必须写对。
 * @param entries - `[{ name, data, method? }]`，method 8 = deflate（用来造「压缩后小、解开后大」的包）。
 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? "", "utf8");
    const method = e.method === 8 ? 8 : 0;
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw) >>> 0;
    const name = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}
