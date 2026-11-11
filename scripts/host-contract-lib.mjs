// 宿主契约：我们依赖的宿主服务 / 事件 / 导出，在被改名或删掉时要能立刻发现。
//
// 为什么需要这一层：host-baseline 只看 86 条补丁的 settled/drifted 与 59 个文件的
// sha256。宿主把 ctx.webServer 改名成 ctx.httpServer，补丁照样能打上去、verdict 照样
// 是 ok，但插件在运行时直接崩——因为补丁改的是「文本匹配」，不是「API 调用」。
//
// 三条实测得到的硬约束（都吃过亏）：
//  1. 扫描必须优先读 <file>.dshpurge.bak。宿主树里有 58 个备份、其中 [dsh-purge]
//     标记数为 0，说明备份是官方原文。读当前文件会把我们自己注入的代码当成宿主
//     原生契约，形成自证式假绿。
//  2. 粒度必须到成员，且允许「服务包 ≠ 成员实现包」。实测反例：ctx.subprocess 由
//     dsh-subprocess 提供，但 resolveExecutable 的实现躺在 dsh-subprocess-local。
//     只查服务包会漏判。
//  3. 我们要的成员都是类方法，声明形如 "\tregister(route) {"（单个制表符缩进）。
//     按「行首空格缩进」写正则会一条都匹配不到。

import fs from 'node:fs'
import path from 'node:path'

export const CONTRACT_SCHEMA = 1

const MAX_DEPTH = 3
const SKIP_DIRS = new Set(['node_modules', 'types', 'dist', '.git'])

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 校验契约文件自身的结构。写错字段名比写错内容更常见。 */
export function validateContract(contract) {
  if (!contract || typeof contract !== 'object') throw new Error('host-contract: 不是对象')
  if (contract.schema !== CONTRACT_SCHEMA) {
    throw new Error(`host-contract: schema=${contract.schema} 与当前 ${CONTRACT_SCHEMA} 不同`)
  }
  const services = contract.services
  if (!Array.isArray(services) || services.length === 0) throw new Error('host-contract: services 必须是非空数组')
  for (const s of services) {
    if (!s.name || typeof s.name !== 'string') throw new Error('host-contract: service 缺 name')
    if (!s.package || typeof s.package !== 'string') throw new Error(`host-contract: service ${s.name} 缺 package`)
    if (!Array.isArray(s.members)) throw new Error(`host-contract: service ${s.name} 的 members 必须是数组`)
    for (const m of s.members) {
      if (typeof m !== 'string' || !m) throw new Error(`host-contract: service ${s.name} 的 members 含空值`)
    }
    if (s.memberProviders !== undefined && (typeof s.memberProviders !== 'object' || s.memberProviders === null)) {
      throw new Error(`host-contract: service ${s.name} 的 memberProviders 必须是对象`)
    }
  }
  if (!Array.isArray(contract.events)) throw new Error('host-contract: events 必须是数组')
  for (const e of contract.events) {
    if (!e.name || typeof e.name !== 'string') throw new Error('host-contract: event 缺 name')
  }
  const exportsList = contract.exports ?? []
  if (!Array.isArray(exportsList)) throw new Error('host-contract: exports 必须是数组')
  for (const x of exportsList) {
    if (!x.package || !x.name) throw new Error('host-contract: exports 条目缺 package 或 name')
  }
  return contract
}

export function loadContract(filePath, { read = fs.readFileSync } = {}) {
  return validateContract(JSON.parse(String(read(filePath, 'utf8'))))
}

/**
 * 读一个宿主源文件。优先读官方备份——宿主树里的补丁会把我们的代码混进原文。
 * 返回 { text, from } 便于报告里说清「这条是按原文判的还是按当前文件判的」。
 */
export function readHostSource(filePath, { exists = fs.existsSync, read = fs.readFileSync } = {}) {
  const bak = `${filePath}.dshpurge.bak`
  if (exists(bak)) return { text: String(read(bak, 'utf8')), from: 'bak' }
  return { text: String(read(filePath, 'utf8')), from: 'now' }
}

/** 类方法声明：`\tregister(route) {`、`\tasync resolveExecutable(...) {`、`X.prototype.m =`。 */
export function hasMemberDecl(text, member) {
  const m = escapeRe(member)
  if (new RegExp(`^\\s{1,12}(?:async\\s+)?(?:static\\s+)?(?:get\\s+|set\\s+)?${m}\\s*\\(`, 'm').test(text)) return true
  return new RegExp(`\\.prototype\\.${m}\\s*=`, 'm').test(text)
}

/** 服务提供：`super(ownerContext, "settings")` 或 `ctx.provide("name", ...)`。 */
export function hasServiceProvider(text, name) {
  const n = escapeRe(name)
  if (new RegExp(`super\\(\\s*[\\w$]+\\s*,\\s*"${n}"\\s*\\)`).test(text)) return true
  return new RegExp(`(?:ctx|this\\.ctx|ownerContext)\\.provide\\(\\s*"${n}"`).test(text)
}

/** 事件名是否出现在源码里（字符串字面量）。 */
export function hasEventName(text, name) {
  return text.includes(`"${name}"`) || text.includes(`'${name}'`)
}

/** 导出声明的三种形态：function / const / export 列表。 */
export function hasExportDecl(text, name) {
  const n = escapeRe(name)
  if (new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${n}\\s*\\(`, 'm').test(text)) return true
  if (new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${n}\\s*=`, 'm').test(text)) return true
  return new RegExp(`export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`).test(text)
}

function listJsFiles(dir, out, depth, readdir) {
  if (depth > MAX_DEPTH) return out
  let entries
  try {
    entries = readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const fp = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) listJsFiles(fp, out, depth + 1, readdir)
    } else if (e.name.endsWith('.js')) {
      out.push(fp)
    }
  }
  return out
}

/**
 * 扫一遍宿主树，把「谁提供什么」全部收集起来。一次遍历，后面所有判定都查这张表。
 * 宿主树有 331 个包、约 1.1 万个 js 文件；实测全扫约 3~4 秒，可接受。
 */
export function scanHost(aiBase, {
  readdir = fs.readdirSync,
  exists = fs.existsSync,
  read = fs.readFileSync,
} = {}) {
  const dirs = readdir(aiBase, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)

  const services = new Map() // name -> [pkg]
  const members = new Map() // `${pkg}::${member}` -> [rel]
  const events = new Map() // name -> Set(pkg)
  const files = new Map() // rel -> { pkg, from }
  const sources = new Map() // rel -> text（导出判定要读全文）

  for (const pkg of dirs) {
    for (const fp of listJsFiles(path.join(aiBase, pkg), [], 0, readdir)) {
      const { text, from } = readHostSource(fp, { exists, read })
      const relInPkg = path.relative(path.join(aiBase, pkg), fp).replace(/\\/g, '/')
      const rel = `${pkg}/${relInPkg}`
      files.set(rel, { pkg, from })
      sources.set(rel, text)

      for (const m of text.matchAll(/super\(\s*[\w$]+\s*,\s*"([^"]+)"\s*\)/g)) {
        if (!services.has(m[1])) services.set(m[1], [])
        const arr = services.get(m[1])
        if (!arr.includes(pkg)) arr.push(pkg)
      }
      for (const m of text.matchAll(/(?:ctx|this\.ctx|ownerContext)\.provide\(\s*"([^"]+)"/g)) {
        if (!services.has(m[1])) services.set(m[1], [])
        const arr = services.get(m[1])
        if (!arr.includes(pkg)) arr.push(pkg)
      }
      for (const m of text.matchAll(/["']([a-z][a-z0-9-]*(?:\/[a-z0-9-]+)+)["']/g)) {
        const n = m[1]
        if (!events.has(n)) events.set(n, new Set())
        events.get(n).add(pkg)
      }
      for (const m of text.matchAll(/^\s{1,12}(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
        const key = `${pkg}::${m[1]}`
        if (!members.has(key)) members.set(key, [])
        if (!members.get(key).includes(rel)) members.get(key).push(rel)
      }
      for (const m of text.matchAll(/\.prototype\.([A-Za-z_$][\w$]*)\s*=/g)) {
        const key = `${pkg}::${m[1]}`
        if (!members.has(key)) members.set(key, [])
        if (!members.get(key).includes(rel)) members.get(key).push(rel)
      }
    }
  }

  return { aiBase, services, members, events, files, sources }
}

/**
 * 按契约逐条判定。每行都带「凭什么这么说」，缺什么一眼能看。
 * verdict: ok = 全部在；broken = 有缺失。
 */
export function checkContract(contract, scan) {
  const rows = []

  for (const svc of contract.services) {
    const providers = scan.services.get(svc.name) ?? []
    const provided = providers.includes(svc.package)
    rows.push({
      kind: 'service',
      name: svc.name,
      package: svc.package,
      ok: provided,
      detail: provided
        ? `由 ${svc.package} 提供`
        : `未在 ${svc.package} 里找到 super(ctx,"${svc.name}")${providers.length ? `（别处提供: ${providers.join(', ')}）` : ''}`,
    })
    for (const member of svc.members) {
      const owner = svc.memberProviders?.[member] ?? svc.package
      const hits = scan.members.get(`${owner}::${member}`) ?? []
      let detail = hits.length ? hits[0] : `${owner} 里没有 ${member}() 的声明`
      if (!hits.length) {
        if (owner !== svc.package) detail += `（服务在 ${svc.package}，成员实现在 ${owner}）`
        else {
          // 找不到时顺手查它在别的包里有没有——升级当天最常见的情况就是「方法还在，但搬包了」
          const elsewhere = [...scan.members.keys()]
            .filter((k) => k.endsWith(`::${member}`))
            .map((k) => k.slice(0, -member.length - 2))
          if (elsewhere.length) detail += `（但在 ${elsewhere.slice(0, 3).join(', ')} 里有，可能搬包了）`
        }
      }
      rows.push({
        kind: 'member',
        name: `${svc.name}.${member}`,
        package: owner,
        ok: hits.length > 0,
        detail,
      })
    }
  }

  for (const ev of contract.events) {
    const providers = [...(scan.events.get(ev.name) ?? [])]
    rows.push({
      kind: 'event',
      name: ev.name,
      package: providers[0] ?? '',
      ok: providers.length > 0,
      detail: providers.length
        ? `${providers.slice(0, 3).join(', ')}${providers.length > 3 ? ` 等 ${providers.length} 个包` : ''}`
        : '没有任何宿主包提到这个事件名',
    })
  }

  for (const x of contract.exports ?? []) {
    let ok = false
    let where = ''
    for (const [rel, text] of scan.sources) {
      if (!rel.startsWith(`${x.package}/`)) continue
      if (hasExportDecl(text, x.name)) {
        ok = true
        where = rel
        break
      }
    }
    rows.push({
      kind: 'export',
      name: `${x.package}#${x.name}`,
      package: x.package,
      ok,
      detail: ok ? where : `${x.package} 没有导出 ${x.name}`,
    })
  }

  const missing = rows.filter((r) => !r.ok)
  const count = (kind) => rows.filter((r) => r.kind === kind).length
  return {
    ok: missing.length === 0,
    rows,
    missing,
    total: rows.length,
    counts: { service: count('service'), member: count('member'), event: count('event'), export: count('export') },
  }
}

/** 人读渲染。刻意短：升级当天要看得出「哪个宿主 API 没了」。 */
export function renderContract(result, { limit = 20 } = {}) {
  const lines = []
  if (result.ok) {
    const c = result.counts
    lines.push(`[contract] PASS ${result.total} 项全部命中（服务 ${c.service} / 成员 ${c.member} / 事件 ${c.event} / 导出 ${c.export}）`)
    return lines.join('\n')
  }
  lines.push(`[contract] FAIL ${result.missing.length}/${result.total} 项缺失`)
  for (const m of result.missing.slice(0, limit)) {
    lines.push(`    ${m.kind.padEnd(8)}${m.name.padEnd(30)}${m.detail}`)
  }
  if (result.missing.length > limit) lines.push(`    ... 还有 ${result.missing.length - limit} 项`)
  lines.push('[contract] 宿主改了 API：先确认是改名还是删除，再决定改代码还是改契约')
  return lines.join('\n')
}
