/**
 * 靶标元数据与阶段口径（零依赖，只用 node: 内置模块）。
 *
 * 从 store-core.js 抽出来的第二层叶子模块。抽它的原因很具体：
 * `scoreReport` / `scoreChain` 要算"这条得分落在哪个阶段""报告里这个得分点叫什么"，
 * 而这两个口径原本和 RedteamStore 挤在同一个文件里 —— 一旦把计分块搬走，
 * 新文件就得反过来 import store-core.js，形成循环依赖。
 *
 * 这里只放**纯函数与常量**：不碰数据库、不碰文件系统（readMeta/writeMeta 是例外，
 * 它们是靶标目录里那份 key: value 元数据的唯一读写实现，schema.js 的迁移也要用 SCOPE_SQL）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { scopeOfIp } from './ip-utils.js'

/**
 * 作战角色（六个）。角色 code 同时用于：
 *   · 角色提示词文件 `engagements/<靶标>/agents/<code>.md`
 *   · 攻击步骤/漏洞/凭据上的 `agent` 列（报告要写清"这条是谁做的"）
 *   · 主会话派活时的角色选择
 * `plan` 是主会话（指挥）自己，不派出去，只用于提示词面板里查看/微调人设。
 */
const ROLE_TITLES = {
  plan: '主会话（指挥）',
  recon: '信息收集',
  assess: '资产梳理',
  'vuln-scan': '漏洞发现',
  exploit: '漏洞利用',
  internal: '内网渗透',
}

/** 漏洞严重级（按展示优先级排列）。 */
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

/** 漏洞处置状态。 */
const VULN_STATUSES = ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed']

export { ROLE_TITLES, SEVERITIES, VULN_STATUSES }

/**
 * 内外网判定（SQL 片段，作用于 asset.ip）：
 * RFC1918 私网 + 回环 + 链路本地 + CGNAT 视为内网，其余为外网。
 */
export const SCOPE_SQL = `CASE
  WHEN ip LIKE '10.%' OR ip LIKE '192.168.%' OR ip LIKE '127.%' OR ip LIKE '169.254.%'
    OR (ip LIKE '172.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 16 AND 31)
    OR (ip LIKE '100.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 64 AND 127)
  THEN 'internal' ELSE 'external' END`

export function readMeta(path) {
  if (!existsSync(path)) return undefined
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const v = m[2].trim()
    if (v.startsWith('[') && v.endsWith(']')) {
      out[m[1]] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      out[m[1]] = v.replace(/^["']|["']$/g, '')
    }
  }
  return out
}

export function writeMeta(path, meta) {
  const lines = []
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`)
    else if (v !== undefined && v !== null) lines.push(`${k}: ${v}`)
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
}

/** 特殊得分点 → 固定阶段（优先级高于按资产内外网推导）。 */
export const POINT_STAGE_OVERRIDE = {
  /* 旧 code 的兜底（老数据仍可能有） */
  'core-system': 'target',
  boundary: 'boundary',
  /* 新口径：按《突破入侵类得分规则》的规则号判阶段。
     规则 5/6/7 = 邮箱系统 / 办公业务系统 / 集权系统 —— 这些就是演练的"靶标"，
     拿到它们即算打到核心目标，归入 ⑤ 靶标权限；
     规则 22-25 = 突破网络边界，归入 ③ 边界突破（§二 明确规定是"进入内网"）。 */
  'mail-admin': 'target', 'mail-user': 'target',
  'biz-admin': 'target', 'biz-user': 'target',
  'central-admin': 'target', 'central-user': 'target', 'central-managed': 'target',
  /* 合并版 code：邮箱/业务系统、集权系统 = 演练的靶标 → ⑤ 靶标权限 */
  'web-app': 'target', 'central-system': 'target',
  'boundary-logical': 'boundary', 'boundary-strong': 'boundary',
  'boundary-physical': 'boundary', 'boundary-supply': 'boundary',
}

/**
 * 得分点的短名：报告正文、索引表、链路表用它。
 * 合并后的得分点全名太长，放不进表头；全名仍写在每条明细的「得分点」一行。
 */
export const POINT_SHORT_NAME = {
  'domain-control': '域名控制',
  'terminal-access': '终端权限',
  'server-host': '服务器主机',
  'db-credential': '数据库凭据',
  'web-app': 'Web 应用',
  'central-system': '集权系统',
  'bigdata-system': '大数据系统',
  'netdev': '网络设备',
  'netdev-redirect': '网络重定向',
  'netdev-implant': '网络设备植入',
  'iiot': '工业互联网',
  'cloud-platform': '云管理平台',
  'iot-platform': '物联网平台',
  'secdev': '安全设备',
  'file-storage': '文件存储',
  'ai-agent': '模型智能体',
  'model-compute': '算力 / 知识库系统',
  'model-data': '模型数据系统',
  'computepower-admin': '算力基础设施',
  'computepower-cards': '算力卡资源',
  'boundary-logical': '进入逻辑隔离内网',
  'boundary-strong': '进入强隔离内网',
  'boundary-physical': '进入物理隔离内网',
  'boundary-supply': '供应链 / 云服务通道',
  'iot-corenet': '物联网打入核心网',
  'core-system': '核心系统（旧口径）',
}

/**
 * 自动推导一条得分属于哪个阶段（用户已确认：自动推导，允许显式覆盖）：
 *   ① 显式 stage_code 优先
 *   ② 类型特判（POINT_STAGE_OVERRIDE：集权/邮箱/业务系统 → target，突破网络边界 → boundary）
 *   ③ 按命中资产的内外网归属（asset.scope）
 *   ④ 没有 asset_id 时按 target 里的地址判断（私有 IP → 内网，公网/域名 → 互联网）
 */
export function scoreStageOf(hit, assetScope) {
  if (hit && typeof hit.stage_code === 'string' && hit.stage_code !== '') return hit.stage_code
  const override = POINT_STAGE_OVERRIDE[hit && hit.code]
  if (override !== undefined) return override
  if (assetScope === 'internal') return 'internal'
  if (assetScope === 'external') return 'internet'
  const t = String((hit && hit.target) || '')
  const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(t)
  if (m !== null) return scopeOfIp(m[1]) === 'internal' ? 'internal' : 'internet'
  return 'internet'
}

/** 旧攻击链 stage → 新阶段 code 的兜底映射。 */
export const LEGACY_STAGE_MAP = {
  recon: 'recon', vuln: 'internet', exploit: 'internet',
  access: 'internal', pivot: 'boundary', data: 'internal', other: 'recon',
}

/**
 * 攻击链步骤允许的作战阶段 code —— 只有这 5 个会被攻击链页面分桶。
 * 写入其它值（尤其外部工具常见的 external / foothold / tunnel / privilege）会被忽略
 * 并退回按 stage 兜底，步骤就不落在任何阶段，所以服务端显式校验并回告警。
 */
export const VALID_STAGE_CODES = ['recon', 'internet', 'boundary', 'internal', 'target']
