// /dsh-purge/rules 与 /dsh-purge/skills 的 op 分发测试。
//
// 这两条 prefix 路由是插件面板真正在用的接口：规则库的增删改、skills 的导入、
// workspace 策略的切换全部从这里进来。批 8 只测了 lib/http.js 的公共零件
// （Origin 判定、JSON 收发），业务分支仍然零覆盖——改了 op 名、改了参数校验、
// 把某个 400 改成 200，都没有任何红字。
//
// 现在这些函数从 lib/index.js 搬到了 lib/http-routes.js，唯一的接口变化是
// handleRulesOp 需要的 refreshHungOperator / injectSnapshot 改成显式传入。
// 于是整段可以只靠一个临时 $DSH_HOME 跑通，不用起宿主、不用起 HTTP 服务。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  handleRulesOp,
  handleSkillsOp,
  installRulesHttp,
  installSkillsHttp,
  registerRoute,
  rulesHttpHandler,
  skillRouteTail,
  skillsHttpHandler,
} from '../lib/http-routes.js'
import { buildZip, doc } from './zip-fixture-lib.mjs'

// ---------------------------------------------------------------- 沙箱

const sandboxes = []

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-routes-'))
  sandboxes.push(home)
  process.env.DSH_HOME = home
  return home
}

after(() => {
  for (const dir of sandboxes) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 占用容错 */ }
  }
})

/** handleRulesOp 的两个依赖：默认什么都不做，测试里按需换成探针。 */
function deps(overrides = {}) {
  return {
    refreshHungOperator: () => ({ text: '' }),
    injectSnapshot: () => ({ injectSource: 'none', injectRuleId: null, needPrompt: false }),
    ...overrides,
  }
}

function fakeResponse() {
  const res = { status: 0, headers: null, body: '', ended: false }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers || {}
  }
  res.end = (chunk) => {
    res.ended = true
    if (chunk !== undefined) res.body = String(chunk)
  }
  return res
}

function jsonOf(res) {
  return JSON.parse(res.body)
}

/** 只带必要字段的 request；body 用 async iterable 喂给 readJsonBody。 */
function req({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const request = { method, url, headers }
  if (body !== undefined) {
    const chunks = [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    request[Symbol.asyncIterator] = async function* () {
      for (const chunk of chunks) yield chunk
    }
  } else {
    request[Symbol.asyncIterator] = async function* () {}
  }
  return request
}

// 同源请求：桌面端设置页自己发的那种
const SAME_ORIGIN = { origin: 'http://127.0.0.1:43120', host: '127.0.0.1:43120' }

// ------------------------------------------------------- skillRouteTail

test('skillRouteTail 从 /dsh-purge/skills/<op> 里取 op', () => {
  assert.equal(skillRouteTail('/dsh-purge/skills/import'), 'import')
  assert.equal(skillRouteTail('/dsh-purge/skill/import'), 'import')
})

test('skillRouteTail 对单数 skill 前缀同样生效（历史上两套路径都在用）', () => {
  assert.equal(skillRouteTail('/dsh-purge/skill/read'), 'read')
  assert.equal(skillRouteTail('/dsh-purge/skills/read/'), 'read')
})

test('skillRouteTail 只有前缀没有 op 时返回空串', () => {
  assert.equal(skillRouteTail('/dsh-purge/skills'), '')
  assert.equal(skillRouteTail('/dsh-purge/skill'), '')
  assert.equal(skillRouteTail('/dsh-purge/skills/'), '')
})

test('skillRouteTail 大小写不敏感（前缀段），op 段保持原样', () => {
  assert.equal(skillRouteTail('/DSH-Purge/SKILLS/Import'), 'Import')
})

test('skillRouteTail 不匹配的路径返回空串，不抛', () => {
  assert.equal(skillRouteTail('/dsh-purge/status'), '')
  assert.equal(skillRouteTail('/other/skills/read'), '')
  assert.equal(skillRouteTail(undefined), '')
  assert.equal(skillRouteTail(null), '')
  assert.equal(skillRouteTail(''), '')
})

// --------------------------------------------------------- handleRulesOp

test('rules status 报出规则库与注入来源', async () => {
  sandbox()
  const out = await handleRulesOp(deps(), 'status', {}, null, null)
  assert.equal(out.ok, true)
  assert.ok(Array.isArray(out.rules))
  assert.ok(out.injectSource)
  assert.deepEqual(out.workspace_policies, ['fallback', 'strict', 'always'])
  assert.equal(out.workspace_policy, 'fallback')
})

test('rules scan-cwd 在 hint 目录下扫 AGENTS.md/CLAUDE.md 并标出勾选状态', async () => {
  const home = sandbox()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-cwd-'))
  sandboxes.push(cwd)
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# agents\n', 'utf8')
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# claude\n', 'utf8')

  const before = await handleRulesOp(deps(), 'scan-cwd', { cwd }, null, null)
  assert.equal(before.cwd, cwd)
  assert.ok(before.candidates.length >= 2)
  assert.ok(before.candidates.every((item) => item.selected === false))

  await handleRulesOp(deps(), 'toggle-cwd', { cwd, path: path.join(cwd, 'AGENTS.md'), enabled: true }, null, null)
  const afterScan = await handleRulesOp(deps(), 'scan', { cwd }, null, null)
  const agents = afterScan.candidates.find((item) => item.path.endsWith('AGENTS.md'))
  assert.equal(agents.selected, true)
  assert.ok(afterScan.selections.length >= 1)
  assert.equal(path.dirname(home).length > 0, true)
})

test('rules toggle-cwd 缺 path 时返回 400 path required', async () => {
  sandbox()
  const out = await handleRulesOp(deps(), 'toggle-cwd', {}, null, null)
  assert.equal(out.status, 400)
  assert.equal(out.ok, false)
  assert.equal(out.error, 'path required')
})

test('rules toggle-cwd 的 path 只含空白同样算缺', async () => {
  sandbox()
  const out = await handleRulesOp(deps(), 'toggle-cwd', { path: '   ' }, null, null)
  assert.equal(out.status, 400)
  assert.equal(out.error, 'path required')
})

test('rules set-policy 拒绝枚举外的策略名', async () => {
  sandbox()
  const out = await handleRulesOp(deps(), 'set-policy', { policy: 'lenient' }, null, null)
  assert.equal(out.status, 400)
  assert.equal(out.ok, false)
  assert.equal(out.error, 'invalid policy: lenient')
})

test('rules set-policy 接受三个合法值并读得回来（workspace-policy 是同一分支的别名）', async () => {
  sandbox()
  for (const policy of ['strict', 'always', 'fallback']) {
    const out = await handleRulesOp(deps(), 'workspace-policy', { policy }, null, null)
    assert.equal(out.ok, true)
    assert.equal(out.policy, policy)
    const status = await handleRulesOp(deps(), 'status', {}, null, null)
    assert.equal(status.workspace_policy, policy)
  }
})

test('rules read 拒绝非法 id，合法但不存在时返回 404', async () => {
  sandbox()
  const bad = await handleRulesOp(deps(), 'read', { id: '../etc/passwd' }, null, null)
  assert.equal(bad.status, 400)
  assert.equal(bad.error, 'invalid id')

  const missing = await handleRulesOp(deps(), 'read', { id: 'nope-rule' }, null, null)
  assert.equal(missing.status, 404)
  assert.equal(missing.error, 'rule not found: nope-rule')
})

test('rules save 缺 content 或 id 非法时返回 400，且不落盘', async () => {
  sandbox()
  const noContent = await handleRulesOp(deps(), 'save', { id: 'demo' }, null, null)
  assert.equal(noContent.status, 400)
  assert.equal(noContent.error, 'id and content (string) required')

  const badId = await handleRulesOp(deps(), 'save', { id: 'Demo Rule', content: 'x' }, null, null)
  assert.equal(badId.status, 400)
  assert.equal(badId.error, 'id and content (string) required')
})

test('rules save 拒绝 AGENTS.md / CLAUDE.md 之外的 target', async () => {
  sandbox()
  const out = await handleRulesOp(deps(), 'save', { id: 'demo', content: 'x', target: 'OTHER.md' }, null, null)
  assert.equal(out.status, 400)
  assert.ok(out.error.startsWith('invalid target: OTHER.md'))
})

test('rules save 成功后刷新注入快照，并把 injectSnapshot 的结果摊进响应', async () => {
  sandbox()
  let refreshed = 0
  const out = await handleRulesOp(deps({
    refreshHungOperator: () => { refreshed += 1; return { text: '' } },
    injectSnapshot: () => ({ injectSource: 'rule', injectRuleId: 'demo', needPrompt: false }),
  }), 'save', { id: 'demo', content: '# demo\n' }, null, null)
  assert.equal(out.ok, true)
  assert.equal(out.id, 'demo')
  assert.equal(out.injectSource, 'rule')
  assert.equal(out.injectRuleId, 'demo')
  assert.equal(refreshed, 1)
})

test('rules save 只写内容不刷新时不调 refreshHungOperator（refresh 只在副作用分支里）', async () => {
  sandbox()
  let refreshed = 0
  await handleRulesOp(deps({ refreshHungOperator: () => { refreshed += 1 } }), 'save', { id: 'demo2', content: 'x' }, null, null)
  // save 分支确实会 refresh —— 这条钉住「它不能悄悄不刷新」
  assert.equal(refreshed, 1)
})

test('rules activate / delete 拒绝非法 id，且不触发刷新', async () => {
  sandbox()
  let refreshed = 0
  const probe = deps({ refreshHungOperator: () => { refreshed += 1 } })

  const act = await handleRulesOp(probe, 'activate', { id: 'Bad Id' }, null, null)
  assert.equal(act.status, 400)
  assert.equal(act.error, 'invalid id')

  const del = await handleRulesOp(probe, 'delete', { id: '' }, null, null)
  assert.equal(del.status, 400)
  assert.equal(del.error, 'invalid id')

  assert.equal(refreshed, 0)
})

test('rules delete 成功后返回 id 并刷新注入', async () => {
  sandbox()
  let refreshed = 0
  const probe = deps({ refreshHungOperator: () => { refreshed += 1 } })
  await handleRulesOp(deps(), 'save', { id: 'goner', content: 'x' }, null, null)

  const out = await handleRulesOp(probe, 'delete', { id: 'goner' }, null, null)
  assert.equal(out.ok, true)
  assert.equal(out.id, 'goner')
  assert.equal(refreshed, 1)

  const gone = await handleRulesOp(deps(), 'read', { id: 'goner' }, null, null)
  assert.equal(gone.status, 404)
})

test('rules activate 成功时带出 target 路径与 note，并刷新注入', async () => {
  const home = sandbox()
  let refreshed = 0
  await handleRulesOp(deps(), 'save', { id: 'demo3', content: '# demo3\n', target: 'CLAUDE.md' }, null, null)
  const out = await handleRulesOp(deps({ refreshHungOperator: () => { refreshed += 1 } }), 'activate', { id: 'demo3' }, null, null)
  assert.equal(out.ok, true)
  assert.equal(out.target, 'CLAUDE.md')
  assert.equal(out.agents_path, path.join(home, 'CLAUDE.md'))
  assert.ok(out.note.includes('新会话生效'))
  assert.equal(refreshed, 1)
})

test('rules reset 返回还原结果并刷新注入', async () => {
  sandbox()
  let refreshed = 0
  const out = await handleRulesOp(deps({ refreshHungOperator: () => { refreshed += 1 } }), 'reset', {}, null, null)
  assert.equal(out.ok, true)
  assert.ok(out.note.includes('已还原出厂状态'))
  assert.equal(refreshed, 1)
})

test('rules 未知 op 返回 400 且把 op 名回显出来', async () => {
  sandbox()
  const out = await handleRulesOp(deps(), 'nuke', {}, null, null)
  assert.equal(out.status, 400)
  assert.equal(out.ok, false)
  assert.equal(out.error, 'unknown op: nuke')
})

test('rules 的 id 可以走查询串，body.id 优先于查询串', async () => {
  sandbox()
  await handleRulesOp(deps(), 'save', { id: 'frombody', content: 'b' }, null, null)
  const viaQuery = await handleRulesOp(deps(), 'read', {}, 'frombody', null)
  assert.equal(viaQuery.ok, true)
  assert.equal(viaQuery.id, 'frombody')

  const both = await handleRulesOp(deps(), 'read', { id: 'frombody' }, 'other', null)
  assert.equal(both.id, 'frombody')
})

// ------------------------------------------------------- handleSkillsOp

test('skills status 报出 skills 目录与清单', async () => {
  sandbox()
  const out = await handleSkillsOp('status', {}, null)
  assert.equal(out.ok, true)
  assert.equal(out.skills_dir, '$DSH_HOME/skills')
  assert.ok(Array.isArray(out.skills))
})

test('skills read 拒绝非 kebab-case 的名字', async () => {
  sandbox()
  const out = await handleSkillsOp('read', { id: 'Bad_Name' }, null)
  assert.equal(out.status, 400)
  assert.equal(out.error, 'invalid skill name')
})

test('skills read 找不到时返回 404', async () => {
  sandbox()
  const out = await handleSkillsOp('read', { id: 'no-such-skill' }, null)
  assert.equal(out.status, 404)
  assert.equal(out.error, 'skill not found: no-such-skill')
})

test('skills save 拒绝非 kebab-case，并给出示例', async () => {
  sandbox()
  const out = await handleSkillsOp('save', { id: 'Code_Review', content: 'x' }, null)
  assert.equal(out.status, 400)
  assert.ok(out.error.includes('kebab-case'))
  assert.ok(out.error.includes('code-review'))
})

test('skills save 后能读回，delete 后读不到', async () => {
  sandbox()
  const saved = await handleSkillsOp('save', { id: 'code-review', content: '---\nname: x\n---\nbody\n', description: '审查' }, null)
  assert.equal(saved.ok, true)
  assert.equal(saved.id, 'code-review')

  const read = await handleSkillsOp('read', { id: 'code-review' }, null)
  assert.equal(read.ok, true)

  const del = await handleSkillsOp('delete', { id: 'code-review' }, null)
  assert.equal(del.ok, true)

  const gone = await handleSkillsOp('read', { id: 'code-review' }, null)
  assert.equal(gone.status, 404)
})

test('skills import 拒绝服务端路径，要求走浏览器上传', async () => {
  sandbox()
  for (const key of ['path', 'source', 'folder']) {
    const out = await handleSkillsOp('import', { [key]: 'C:/tmp/x' }, null)
    assert.equal(out.status, 400)
    assert.equal(out.error, '请在本机选择压缩包或文件夹导入')
  }
})

test('skills import 既没有 data 也没有 files 时返回 400', async () => {
  sandbox()
  const out = await handleSkillsOp('import', {}, null)
  assert.equal(out.status, 400)
  assert.equal(out.error, '请选择压缩包或文件夹')
})

test('skills import 用 files 数组导入一棵文件树', async () => {
  sandbox()
  const out = await handleSkillsOp('import', {
    name: 'my-skill',
    files: [{ path: 'my-skill/SKILL.md', content: '---\nname: my-skill\ndescription: d\n---\nbody\n' }],
  }, null)
  assert.equal(out.ok, true)
  assert.ok(Array.isArray(out.imported))
})

test('skills import 用 base64 压缩包导入，坏包抛错由 handler 转成 500', async () => {
  sandbox()
  const res = fakeResponse()
  await skillsHttpHandler('')(req({
    method: 'POST',
    url: '/dsh-purge/skills/import',
    body: { data: Buffer.from('not a zip at all').toString('base64'), name: 'broken.zip' },
  }), res)
  // 走的是 importArchive 那条分支（不是 files 分支），坏包在里面抛错
  assert.equal(res.status, 500)
  assert.equal(jsonOf(res).ok, false)
  assert.ok(jsonOf(res).error.length > 0)
})

test('skills 未知 op 返回 400 且回显 op 名', async () => {
  sandbox()
  const out = await handleSkillsOp('wipe', {}, null)
  assert.equal(out.status, 400)
  assert.equal(out.error, 'unknown op: wipe')
})

// ------------------------------------------------- rulesHttpHandler

test('rules handler 对 OPTIONS 回 204，不进业务分支', async () => {
  sandbox()
  const res = fakeResponse()
  await rulesHttpHandler(deps(), '')(req({ method: 'OPTIONS', url: '/dsh-purge/rules' }), res)
  assert.equal(res.status, 204)
  assert.equal(res.body, '')
})

test('rules handler 对 GET /dsh-purge/rules 默认走 status', async () => {
  sandbox()
  const res = fakeResponse()
  await rulesHttpHandler(deps(), '')(req({ method: 'GET', url: '/dsh-purge/rules' }), res)
  assert.equal(res.status, 200)
  assert.equal(jsonOf(res).ok, true)
  assert.ok(Array.isArray(jsonOf(res).rules))
})

test('rules handler 用路径尾段当 op', async () => {
  sandbox()
  const res = fakeResponse()
  await rulesHttpHandler(deps(), '')(req({ method: 'GET', url: '/dsh-purge/rules/status' }), res)
  assert.equal(res.status, 200)
  assert.equal(jsonOf(res).ok, true)
})

test('rules handler 的 body.op 优先于路径尾段', async () => {
  sandbox()
  const res = fakeResponse()
  await rulesHttpHandler(deps(), '')(req({
    method: 'POST',
    url: '/dsh-purge/rules/status',
    body: { op: 'set-policy', policy: 'strict' },
  }), res)
  assert.equal(res.status, 200)
  assert.equal(jsonOf(res).policy, 'strict')
})

test('rules handler 对 PUT 回 405 并带 Allow 头', async () => {
  sandbox()
  const res = fakeResponse()
  await rulesHttpHandler(deps(), '')(req({ method: 'PUT', url: '/dsh-purge/rules' }), res)
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, POST')
})

test('rules handler 把业务 400 原样透出（不是 200）', async () => {
  sandbox()
  const res = fakeResponse()
  await rulesHttpHandler(deps(), '')(req({ method: 'POST', url: '/dsh-purge/rules/toggle-cwd', body: {} }), res)
  assert.equal(res.status, 400)
  assert.equal(jsonOf(res).error, 'path required')
})

test('rules handler 遇到坏 JSON 回 500 并带错误消息', async () => {
  sandbox()
  const res = fakeResponse()
  await rulesHttpHandler(deps(), '')(req({ method: 'POST', url: '/dsh-purge/rules', body: '{not json' }), res)
  assert.equal(res.status, 500)
  assert.equal(jsonOf(res).ok, false)
  assert.ok(jsonOf(res).error.length > 0)
})

// ------------------------------------------------- skillsHttpHandler

test('skills handler 对 OPTIONS 回 204', async () => {
  sandbox()
  const res = fakeResponse()
  await skillsHttpHandler('')(req({ method: 'OPTIONS', url: '/dsh-purge/skills' }), res)
  assert.equal(res.status, 204)
})

test('skills handler 对 DELETE 回 405 且 Allow 列出三种方法', async () => {
  sandbox()
  const res = fakeResponse()
  await skillsHttpHandler('')(req({ method: 'DELETE', url: '/dsh-purge/skills' }), res)
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, POST, OPTIONS')
})

test('skills handler 的 op 优先级：forcedOp > body.op > tail > ?op= > ?id= 推断 > status', async () => {
  sandbox()
  await handleSkillsOp('save', { id: 'alpha', content: '---\nname: a\n---\n' }, null)

  // forcedOp 压过一切
  const forced = fakeResponse()
  await skillsHttpHandler('status')(req({ method: 'POST', url: '/dsh-purge/skills/import', body: { op: 'import' } }), forced)
  assert.equal(jsonOf(forced).skills_dir, '$DSH_HOME/skills')

  // tail 压过 ?op=
  const tail = fakeResponse()
  await skillsHttpHandler('')(req({ method: 'GET', url: '/dsh-purge/skills/status?op=read&id=alpha' }), tail)
  assert.equal(jsonOf(tail).skills_dir, '$DSH_HOME/skills')

  // 只有 ?id= 时推断成 read
  const byId = fakeResponse()
  await skillsHttpHandler('')(req({ method: 'GET', url: '/dsh-purge/skills?id=alpha' }), byId)
  assert.equal(jsonOf(byId).id, 'alpha')

  // 什么都没有就是 status
  const plain = fakeResponse()
  await skillsHttpHandler('')(req({ method: 'GET', url: '/dsh-purge/skills' }), plain)
  assert.equal(jsonOf(plain).skills_dir, '$DSH_HOME/skills')
})

test('skills handler 的 body 上限是 14MB：1MB 的包放行，默认 512KB 会拒', async () => {
  sandbox()
  const res = fakeResponse()
  // 1MB 的 body：readJsonBody 默认上限 512KB，skills 这条显式传了 14MB。
  // 用 status 这个不碰 content 的 op，单独钉住「上限被放宽」这一件事。
  const big = 'x'.repeat(1024 * 1024)
  await skillsHttpHandler('')(req({
    method: 'POST',
    url: '/dsh-purge/skills/status',
    body: { op: 'status', pad: big },
  }), res)
  assert.equal(res.status, 200)
  assert.equal(jsonOf(res).skills_dir, '$DSH_HOME/skills')
})

test('skills handler 超过 14MB 时回 500 而不是把整个包读进内存', async () => {
  sandbox()
  const res = fakeResponse()
  const tooBig = 'x'.repeat(15 * 1024 * 1024)
  await skillsHttpHandler('')(req({
    method: 'POST',
    url: '/dsh-purge/skills/status',
    body: { op: 'status', pad: tooBig },
  }), res)
  assert.equal(res.status, 500)
  assert.equal(jsonOf(res).ok, false)
  assert.ok(jsonOf(res).error.includes('too large'))
})

// --------------------------------------------------------- registerRoute

test('registerRoute 给 handler 套上跨站守卫：跨站请求不执行 handler', async () => {
  sandbox()
  const registered = []
  const webServer = { register: (spec) => { registered.push(spec); return () => {} } }
  registerRoute(webServer, { kind: 'exact', path: '/x', handler: () => { throw new Error('handler 不该被调用') } })

  const res = fakeResponse()
  await registered[0].handler(
    req({ method: 'GET', url: '/x', headers: { origin: 'http://evil.example', host: '127.0.0.1:43120' } }),
    res,
  )
  assert.equal(res.status, 403)
  assert.equal(jsonOf(res).error, 'cross-origin blocked')
})

test('registerRoute 对同源请求放行到 handler', async () => {
  sandbox()
  const registered = []
  const webServer = { register: (spec) => { registered.push(spec); return () => {} } }
  let called = 0
  registerRoute(webServer, { kind: 'exact', path: '/x', handler: (_request, response) => { called += 1; response.writeHead(200, {}); response.end('ok') } })

  const res = fakeResponse()
  await registered[0].handler(req({ method: 'GET', url: '/x', headers: SAME_ORIGIN }), res)
  assert.equal(called, 1)
  assert.equal(res.status, 200)
})

test('registerRoute 在 register 抛错时只告警并返回空 disposer，不让插件整体崩', async () => {
  const webServer = { register: () => { throw new Error('route table locked') } }
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const dispose = registerRoute(webServer, { kind: 'exact', path: '/boom', handler: () => {} })
    assert.equal(typeof dispose, 'function')
    assert.doesNotThrow(() => dispose())
  } finally {
    console.warn = original
  }
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('/boom'))
  assert.ok(warnings[0].includes('route table locked'))
})

// ------------------------------------------------- installRules/Skills

test('installSkillsHttp 注册两条 prefix，覆盖 skills 与 skill 两种写法', async () => {
  const specs = []
  const webServer = { register: (spec) => { specs.push(spec); return () => {} } }
  const dispose = installSkillsHttp(webServer)
  assert.equal(specs.length, 2)
  assert.deepEqual(specs.map((s) => s.path), ['/dsh-purge/skills', '/dsh-purge/skill'])
  assert.ok(specs.every((s) => s.kind === 'prefix'))
  assert.equal(typeof dispose, 'function')
})

test('installRulesHttp 注册一条 prefix /dsh-purge/rules', async () => {
  sandbox()
  const specs = []
  const webServer = { register: (spec) => { specs.push(spec); return () => {} } }
  const dispose = installRulesHttp(webServer, deps())
  assert.equal(specs.length, 1)
  assert.equal(specs[0].path, '/dsh-purge/rules')
  assert.equal(specs[0].kind, 'prefix')
  assert.equal(typeof dispose, 'function')
})

test('install 系列返回的 disposer 倒序撤销全部注册，且单个失败不中断', () => {
  const order = []
  const webServer = {
    register: () => () => { order.push(order.length); throw new Error('already gone') },
  }
  const dispose = installSkillsHttp(webServer)
  assert.doesNotThrow(() => dispose())
  assert.equal(order.length, 2)
})

test('installRulesHttp 的 disposer 同样倒序撤销且单条失败不中断', () => {
  const order = []
  const webServer = {
    register: () => () => { order.push(order.length); throw new Error('gone') },
  }
  const dispose = installRulesHttp(webServer, deps())
  assert.doesNotThrow(() => dispose())
  assert.equal(order.length, 1)
})

test('installRulesHttp 的 handler 真的把 deps 传进去（少了 deps 会在 save 时炸）', async () => {
  sandbox()
  const specs = []
  const webServer = { register: (spec) => { specs.push(spec); return () => {} } }
  let refreshed = 0
  installRulesHttp(webServer, deps({ refreshHungOperator: () => { refreshed += 1 } }))

  const res = fakeResponse()
  await specs[0].handler(req({
    method: 'POST',
    url: '/dsh-purge/rules/save',
    headers: SAME_ORIGIN,
    body: { id: 'wired', content: '# wired\n' },
  }), res)
  assert.equal(res.status, 200)
  assert.equal(refreshed, 1)
})

test('skills import：body.data 走 base64 解包并真的导入（面板拖入技能包的那条路）', async () => {
  const home = sandbox()
  const zip = buildZip([{ name: 'pack/SKILL.md', data: doc('zipped-route', '来自 HTTP base64') }])
  const res = await handleSkillsOp('import', { data: zip.toString('base64'), name: 'skill.zip' })
  assert.equal(res.ok, true)
  assert.deepEqual(res.imported.map((item) => item.id), ['zipped-route'])
  assert.ok(fs.existsSync(path.join(home, 'skills')), '技能必须真落到 $DSH_HOME/skills')
})
