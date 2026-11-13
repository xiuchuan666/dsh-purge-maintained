/**
 * `lib/update.js` 的网络层与远端版本查询（docs/test-map.md 第八节的补充）。
 *
 * 这一层在本维护副本里是**死路**：`ONLINE_UPDATES_ENABLED = false`，所以
 * `checkUpdate` / `applyUpdate` 都在第一句就退出，`requestBuffer` 一行都不会跑。
 * 于是它保存着一堆「只在开关打开那天才会执行」的安全护栏 —— https 强制、
 * 跳转白名单、跳数上限、50MB 上限、超时文案。这些护栏坏掉的时候没人会知道，
 * 因为没人再走过这条路；等哪天有人把开关打开，才发现它是坏的。
 *
 * 所以这里用假的 `https.request` 把护栏逐条点起来：不联网、不 spawn，
 * 全部在本进程内完成。假实现只负责按剧本给出 status / headers / body，
 * 真实现里的 Promise、事件与递归跳转逻辑一行不改地跑。
 *
 * `fetchJson` / `fetchText` / `remotePackageVersion` / `remoteHeadSha` /
 * `listGithubTags` 都走同一个 `requestBuffer`，因此一次假装的剧本就能把
 * 「下载 → 解析 → 缓存」整条链串起来测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

// 这个模块的路径常量在模块顶层算（PLUGIN_ROOT），channel/history/stamp 三个路径
// 在调用时算。为了让 readChannelState 之类落到沙箱，必须在 import 之前定 DSH_HOME。
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-updnet-tmp-'))
const ORIG_TMP = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, DSH_HOME: process.env.DSH_HOME }
process.env.TEMP = TMP_ROOT
process.env.TMP = TMP_ROOT
process.env.TMPDIR = TMP_ROOT
process.env.DSH_HOME = path.join(TMP_ROOT, 'home')

const u = await import('../lib/update.js')

const ORIGIN_REQUEST = https.request

test.after(() => {
  https.request = ORIGIN_REQUEST
  for (const [k, v] of Object.entries(ORIG_TMP)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) } catch {}
})

/**
 * 假 https.request。剧本按调用顺序取，用完之后一直返回最后一条
 * （这样「第二次请求又失败」这种断言不用重复写剧本）。
 * 返回的数组按调用顺序记录 URL 与请求头，用来断言「跳到了哪」。
 */
function fakeHttps(script) {
  const seen = []
  let i = 0
  https.request = function fake(parsed, opts, cb) {
    const step = script[Math.min(i, script.length - 1)]
    i += 1
    seen.push({
      url: String(parsed),
      protocol: parsed.protocol,
      host: parsed.hostname,
      method: opts && opts.method,
      headers: (opts && opts.headers) || {},
    })
    const req = new EventEmitter()
    req.destroyed = false
    req.destroy = (err) => {
      req.destroyed = true
      if (err) setImmediate(() => req.emit('error', err))
    }
    req.setTimeout = (ms, fn) => { req.timeoutMs = ms; req.onTimeout = fn }
    req.end = () => {
      if (step.timeout) { req.onTimeout(); return }
      if (step.reqError) { setImmediate(() => req.emit('error', step.reqError)); return }
      const res = new Readable({ read() {} })
      res.statusCode = step.status === undefined ? 200 : step.status
      res.headers = step.headers || {}
      res.resumed = false
      const baseResume = res.resume.bind(res)
      res.resume = () => { res.resumed = true; baseResume() }
      cb(res)
      if (step.resError) { setImmediate(() => res.emit('error', step.resError)); return }
      if (step.chunks) for (const c of step.chunks) res.push(c)
      else if (step.body !== undefined) res.push(Buffer.from(step.body))
      if (!step.noEnd) res.push(null)
    }
    return req
  }
  return seen
}

/** 每个用例跑完都把 https.request 还原，避免一条用例的剧本泄漏到下一条。 */
function withHttp(script, fn) {
  const seen = fakeHttps(script)
  return Promise.resolve()
    .then(() => fn(seen))
    .finally(() => { https.request = ORIGIN_REQUEST })
}

// ---------------------------------------------------------------------------
// requestBuffer 的护栏（经 fetchRes / fetchText 观察）
// ---------------------------------------------------------------------------

test('下载只走 https：http: 与 file: 在发出请求之前就被拒', async () => {
  const seen = fakeHttps([{ body: 'x' }])
  try {
    await assert.rejects(() => u.fetchText('http://example.com/a.zip'), /unsupported protocol http:/)
    await assert.rejects(() => u.fetchText('file:///etc/passwd'), /unsupported protocol file:/)
    assert.equal(seen.length, 0, '不该发出任何请求')
  } finally {
    https.request = ORIGIN_REQUEST
  }
})

test('URL 解析不了时抛 SyntaxError，而不是发请求', async () => {
  const seen = fakeHttps([{ body: 'x' }])
  try {
    await assert.rejects(() => u.fetchText('not a url at all'))
    assert.equal(seen.length, 0)
  } finally {
    https.request = ORIGIN_REQUEST
  }
})

test('请求头固定带 user-agent 与 accept，额外头能覆盖默认值', async () => {
  await withHttp([{ body: 'ok' }], async (seen) => {
    await u.fetchText('https://example.com/a.txt')
    assert.equal(seen[0].method, 'GET')
    assert.equal(seen[0].headers['user-agent'], 'dsh-purge-update')
    assert.equal(seen[0].headers.accept, '*/*')
  })
  await withHttp([{ body: '{}' }], async (seen) => {
    await u.fetchJson('https://example.com/a.json', 20000, { accept: 'application/vnd.github.raw' })
    assert.equal(seen[0].headers.accept, 'application/vnd.github.raw')
  })
})

test('302 跟到白名单里的主机，并且用的是新 URL', async () => {
  await withHttp(
    [
      { status: 302, headers: { location: 'https://codeload.github.com/a/b/zip/main' } },
      { status: 200, body: 'payload' },
    ],
    async (seen) => {
      assert.equal(await u.fetchText('https://github.com/a/b/archive/refs/heads/main.zip'), 'payload')
      assert.equal(seen.length, 2)
      assert.equal(seen[1].url, 'https://codeload.github.com/a/b/zip/main')
    },
  )
})

test('302 跳到不在白名单的主机直接被拒（中间人改写落点的唯一防线）', async () => {
  await withHttp([{ status: 302, headers: { location: 'https://evil.example.com/x.zip' } }], async (seen) => {
    await assert.rejects(() => u.fetchText('https://example.com/a.zip'), /host not allowed: evil\.example\.com/)
    assert.equal(seen.length, 1, '不该跟随')
  })
})

test('302 跳到 http: 也被拒（降级成明文同样算中间人）', async () => {
  await withHttp([{ status: 302, headers: { location: 'http://codeload.github.com/a/b/zip/main' } }], async () => {
    await assert.rejects(() => u.fetchText('https://example.com/a.zip'), /non-https: http:/)
  })
})

test('302 落到 jsdelivr 也放行（白名单不止 codeload 一家）', async () => {
  // 白名单里七个主机都得能落地：只测 codeload 的话，把 jsdelivr 那条删掉测试照样全绿，
  // 而 remotePackageVersion 的第一优先源正是 cdn.jsdelivr.net。
  await withHttp(
    [
      { status: 302, headers: { location: 'https://cdn.jsdelivr.net/gh/a/b@main/package.json' } },
      { status: 200, body: '{"version":"9.9.9"}' },
    ],
    async (seen) => {
      assert.equal(await u.fetchText('https://example.com/a.json'), '{"version":"9.9.9"}')
      assert.equal(seen.length, 2)
      assert.equal(seen[1].url, 'https://cdn.jsdelivr.net/gh/a/b@main/package.json')
    },
  )
})

test('302 又把落点指回自己时回 http 302，不当成新一跳', async () => {
  // 自环检查与跳数上限是两道不同的闸：同一 location 连给六次，先撞的一定是自环。
  const self = { status: 302, headers: { location: 'https://example.com/a.zip' } }
  await withHttp([self, self, self], async (seen) => {
    await assert.rejects(() => u.fetchText('https://example.com/a.zip'), /^Error: http 302$/)
    assert.equal(seen.length, 1, '自环当场停手，不该再发第二跳')
  })
})

test('跳数用尽后回「http redirect loop」，不再无限递归', async () => {
  // redirectsLeft 初值 5：第 6 次请求（redirectsLeft 已经是 0）再收到 302 就停手。
  // 每跳必须给不同的落点，否则先撞上的是「location 指向自己」那道自环检查，
  // 测出来会是 http 302 而不是跳数上限。
  const hop = (n) => ({ status: 302, headers: { location: `https://codeload.github.com/a/b/zip/m${n}` } })
  await withHttp([hop(1), hop(2), hop(3), hop(4), hop(5), hop(6), { body: 'never' }], async (seen) => {
    await assert.rejects(() => u.fetchText('https://example.com/a.zip'), /http redirect loop/)
    assert.equal(seen.length, 6)
  })
})

test('302 没给 location 但 URL 能被改写成 codeload 时，顺着改写走', async () => {
  // 必须直接调 requestBuffer：fetchText/fetchRes 会在发请求之前就把
  // github.com/archive 改写成 codeload，改写分支就再也不会被走到。
  await withHttp(
    [{ status: 302, headers: {} }, { status: 200, body: 'rewritten' }],
    async (seen) => {
      const res = await u.requestBuffer('https://github.com/a/b/archive/refs/heads/main.zip', 20000, {})
      assert.equal(res.body.toString('utf8'), 'rewritten')
      assert.equal(seen[1].url, 'https://codeload.github.com/a/b/zip/refs/heads/main')
    },
  )
})

test('302 没 location 也没法改写时回 http 302', async () => {
  await withHttp([{ status: 302, headers: {} }], async () => {
    await assert.rejects(() => u.fetchText('https://example.com/a.zip'), /^Error: http 302$/)
  })
})

test('302 的 location 是一整个非法 URL 时抛解析错误', async () => {
  await withHttp([{ status: 302, headers: { location: 'https://' } }], async () => {
    await assert.rejects(() => u.fetchText('https://example.com/a.zip'))
  })
})

test('404 且 URL 可改写时先试 codeload，改写的也失败才回 http 404', async () => {
  // 同样必须绕开 fetchRes 的预改写，才能走进 requestBuffer 里的 404 分支。
  await withHttp([{ status: 404 }, { status: 200, body: 'from codeload' }], async (seen) => {
    const res = await u.requestBuffer('https://github.com/a/b/archive/refs/heads/main.zip', 20000, {})
    assert.equal(res.body.toString('utf8'), 'from codeload')
    assert.equal(seen[1].url, 'https://codeload.github.com/a/b/zip/refs/heads/main')
  })
  await withHttp([{ status: 404 }, { status: 404 }], async () => {
    await assert.rejects(
      () => u.requestBuffer('https://github.com/a/b/archive/refs/heads/main.zip', 20000, {}),
      /http 404/,
    )
  })
  await withHttp([{ status: 500 }], async () => {
    await assert.rejects(() => u.fetchText('https://example.com/a.zip'), /http 500/)
  })
})

test('超过 50MB 的响应被掐断，不会把整包读进内存', async () => {
  const tooBig = Buffer.alloc(50 * 1024 * 1024 + 1, 0x61)
  await withHttp([{ chunks: [tooBig] }], async () => {
    await assert.rejects(() => u.fetchText('https://example.com/a.zip'), /response exceeds 52428800 bytes/)
  })
})

test('响应流报错直接穿透到调用者', async () => {
  await withHttp([{ resError: new Error('socket hang up') }], async () => {
    await assert.rejects(() => u.fetchText('https://example.com/a.zip'), /socket hang up/)
  })
})

test('请求本身报错也穿透', async () => {
  await withHttp([{ reqError: new Error('ECONNRESET') }], async () => {
    await assert.rejects(() => u.fetchText('https://example.com/a.zip'), /ECONNRESET/)
  })
})

test('超时被统一成「GitHub 超时」文案，原始 destroy 错误不外泄', async () => {
  await withHttp([{ timeout: true }], async () => {
    await assert.rejects(() => u.fetchText('https://example.com/a.zip'), /^Error: GitHub 超时$/)
  })
})

test('req.setTimeout 收到的是调用方给的毫秒数，默认 20000', async () => {
  // 这条只能从源码形状看：假 req 记下的 timeoutMs 在请求结束前拿不到，
  // 而真实现是 req.setTimeout(ms, ...)。所以直接读源码钉默认值。
  const src = fs.readFileSync(new URL('../lib/update.js', import.meta.url), 'utf8')
  assert.match(src, /async function fetchRes\(url, ms = 20000, headers = \{\}\)/)
  assert.match(src, /async function fetchText\(url, ms = 20000, headers = \{\}\)/)
  assert.match(src, /async function fetchJson\(url, ms = 20000, headers = \{\}\)/)
  assert.match(src, /function requestBuffer\(url, ms, headers, redirectsLeft = 5\)/)
})

// ---------------------------------------------------------------------------
// fetchRes 的返回值形状
// ---------------------------------------------------------------------------

test('fetchRes 回 {ok, status, text(), arrayBuffer()}，arrayBuffer 按字节切', async () => {
  const bytes = Buffer.from([0x00, 0xff, 0x10, 0x41])
  await withHttp([{ status: 200, chunks: [bytes] }], async () => {
    const res = await u.fetchRes('https://example.com/a.bin')
    assert.equal(res.ok, true)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), bytes.toString('utf8'))
    const ab = await res.arrayBuffer()
    assert.ok(ab instanceof ArrayBuffer)
    assert.deepEqual([...new Uint8Array(ab)], [...bytes])
  })
})

test('fetchRes 会先把 github.com/archive 改写成 codeload 再发', async () => {
  await withHttp([{ body: 'x' }], async (seen) => {
    await u.fetchRes('https://github.com/a/b/archive/refs/tags/v1.0.0.tar.gz')
    assert.equal(seen[0].url, 'https://codeload.github.com/a/b/tar.gz/refs/tags/v1.0.0')
  })
})

test('fetchRes 把 AbortError 与「超时」都翻译成 GitHub 超时', async () => {
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  await withHttp([{ reqError: abort }], async () => {
    await assert.rejects(() => u.fetchRes('https://example.com/a.zip'), /^Error: GitHub 超时$/)
  })
  await withHttp([{ reqError: new Error('the operation was aborted') }], async () => {
    await assert.rejects(() => u.fetchRes('https://example.com/a.zip'), /^Error: GitHub 超时$/)
  })
})

// ---------------------------------------------------------------------------
// 版本号解析与标签
// ---------------------------------------------------------------------------

test('versionFromPackageText 只认 version，坏 JSON 会抛', () => {
  assert.equal(u.versionFromPackageText('{"version":"1.2.3"}'), '1.2.3')
  assert.equal(u.versionFromPackageText('{"version":1}'), '1')
  assert.equal(u.versionFromPackageText('{"name":"x"}'), '')
  assert.equal(u.versionFromPackageText('{"version":"","name":"x"}'), '')
  // 0 / false 这类假值不能变成 "0" / "false" —— 版本号无效时宁可当没读到。
  assert.equal(u.versionFromPackageText('{"version":0}'), '')
  assert.equal(u.versionFromPackageText('{"version":false}'), '')
  assert.throws(() => u.versionFromPackageText('not json'))
})

test('versionLabel：beta 标「测试」，其余标「正式」，没版本号就只留标记', () => {
  assert.equal(u.versionLabel('1.1.94', 'stable'), '1.1.94（正式）')
  assert.equal(u.versionLabel('1.1.94', 'beta'), '1.1.94（测试）')
  assert.equal(u.versionLabel('v1.1.94', 'stable'), '1.1.94（正式）')
  assert.equal(u.versionLabel('', 'stable'), '正式')
  assert.equal(u.versionLabel('', 'stable', 'abcdef1234567'), 'abcdef1（正式）')
  assert.equal(u.versionLabel(null, 'beta', '0123456789abcdef'), '0123456（测试）')
})

test('rememberVersion 按 sha|ref 去重，缺 ref 的条目直接丢', () => {
  const seen = new Set()
  assert.equal(u.rememberVersion(null, seen), null)
  assert.equal(u.rememberVersion({ sha: 'a' }, seen), null)
  assert.equal(u.rememberVersion({ ref: 'main' }, seen).ref, 'main')
  assert.equal(u.rememberVersion({ ref: 'MAIN' }, seen), null, '大小写不敏感去重')
  assert.equal(u.rememberVersion({ ref: 'main', sha: 'abc' }, seen).ref, 'main', 'sha 不同算不同条目')
  assert.equal(u.rememberVersion({ ref: 'main', sha: 'abc' }, seen), null)
})

test('archiveZipUrl / archiveTarballUrl：40 位 sha、标签、分支三种形态', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567'
  const base = 'https://codeload.github.com/xiuchuan666/dsh-purge-maintained'
  assert.equal(u.archiveZipUrl(sha), `${base}/zip/${sha}`)
  assert.equal(u.archiveZipUrl('v1.1.94'), `${base}/zip/refs/tags/v1.1.94`)
  assert.equal(u.archiveZipUrl('1.1.94'), `${base}/zip/refs/tags/1.1.94`)
  assert.equal(u.archiveZipUrl('main'), `${base}/zip/refs/heads/main`)
  assert.equal(u.archiveZipUrl(''), `${base}/zip/refs/heads/main`, '空值回落 stable ref')
  assert.equal(u.archiveZipUrl('feature/x y'), `${base}/zip/refs/heads/feature%2Fx%20y`)
  // 标签分支也要编码：`/` 不转义会多出两级路径，下载地址直接 404。
  assert.equal(u.archiveZipUrl('v1.1.9/fix'), `${base}/zip/refs/tags/v1.1.9%2Ffix`)
  assert.equal(u.archiveTarballUrl(sha), `${base}/tar.gz/${sha}`)
  assert.equal(u.archiveTarballUrl('v1.1.94'), `${base}/tar.gz/refs/tags/v1.1.94`)
  assert.equal(u.archiveTarballUrl('beta'), `${base}/tar.gz/refs/heads/beta`)
  assert.equal(u.archiveTarballUrl(''), `${base}/tar.gz/refs/heads/main`)
})

test('rewriteDownloadUrl 只认 github.com 的 archive 两种形态，其余回空串', () => {
  assert.equal(
    u.rewriteDownloadUrl('https://github.com/a/b/archive/refs/heads/main.zip'),
    'https://codeload.github.com/a/b/zip/refs/heads/main',
  )
  assert.equal(
    u.rewriteDownloadUrl('https://github.com/a/b/archive/refs/tags/v1.0.0.tar.gz'),
    'https://codeload.github.com/a/b/tar.gz/refs/tags/v1.0.0',
  )
  assert.equal(
    u.rewriteDownloadUrl('https://github.com/a/b/archive/deadbeef.zip'),
    'https://codeload.github.com/a/b/zip/deadbeef',
  )
  assert.equal(
    u.rewriteDownloadUrl('https://github.com/a/b/archive/refs/heads/v1%2Fmain.zip'),
    'https://codeload.github.com/a/b/zip/refs/heads/v1/main',
    '标签里的百分号编码会被还原',
  )
  assert.equal(u.rewriteDownloadUrl('https://codeload.github.com/a/b/zip/main'), '')
  assert.equal(u.rewriteDownloadUrl('https://gitlab.com/a/b/archive/refs/heads/main.zip'), '')
  assert.equal(u.rewriteDownloadUrl(''), '')
  assert.equal(u.rewriteDownloadUrl(null), '')
})

test('isAbortError 认三个名字，也认 message 里的 aborted / 超时', () => {
  const named = (name) => { const e = new Error('x'); e.name = name; return e }
  assert.equal(u.isAbortError(named('AbortError')), true)
  assert.equal(u.isAbortError(named('TimeoutError')), true)
  assert.equal(u.isAbortError(named('Error')), false)
  assert.equal(u.isAbortError(new Error('aborted')), true)
  assert.equal(u.isAbortError(new Error('request ABORTED by peer')), true)
  assert.equal(u.isAbortError(new Error('GitHub 超时')), true)
  assert.equal(u.isAbortError(new Error('ECONNRESET')), false)
  assert.equal(u.isAbortError(null), false)
  assert.equal(u.isAbortError('超时'), true, '字符串入参按 message 处理')
})

test('parseReapplyOutput 只认最后一条 JSON 行，坏行回 null', () => {
  assert.deepEqual(u.parseReapplyOutput('log\n{"ok":true}\n{"ok":false,"error":"x"}\n'), { ok: false, error: 'x' })
  assert.deepEqual(u.parseReapplyOutput('{"ok":true}'), { ok: true })
  assert.equal(u.parseReapplyOutput(''), null)
  assert.equal(u.parseReapplyOutput('no json here'), null)
  assert.equal(u.parseReapplyOutput('{"ok":true}\n{broken'), null, '最后一条是坏 JSON 就回 null，不往前找')
  assert.equal(u.parseReapplyOutput(null), null)
  assert.deepEqual(u.parseReapplyOutput('  {"ok":true}  \r\n'), { ok: true }, '行首尾空白要 trim')
})

// ---------------------------------------------------------------------------
// remotePackageVersion：四个源依次退让，5 分钟 memo，失败记 30 秒
// ---------------------------------------------------------------------------

test('remotePackageVersion：给 sha 时先打 jsdelivr 的 @sha，命中就不再打其他源', async () => {
  await withHttp([{ body: '{"version":"9.9.1"}' }], async (seen) => {
    assert.equal(await u.remotePackageVersion('aaa1111'), '9.9.1')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, 'https://cdn.jsdelivr.net/gh/xiuchuan666/dsh-purge-maintained@aaa1111/package.json')
  })
})

test('remotePackageVersion：给空 sha 时从 raw.githubusercontent 的 ref 开始', async () => {
  await withHttp([{ body: '{"version":"9.9.2"}' }], async (seen) => {
    assert.equal(await u.remotePackageVersion('', 'main'), '9.9.2')
    assert.equal(seen[0].url, 'https://raw.githubusercontent.com/xiuchuan666/dsh-purge-maintained/main/package.json')
  })
})

test('remotePackageVersion：某个源回空版本号时继续试下一个源', async () => {
  await withHttp(
    [{ body: '{"name":"x"}' }, { body: '{"version":"9.9.3"}' }],
    async (seen) => {
      assert.equal(await u.remotePackageVersion('bbb2222'), '9.9.3')
      assert.equal(seen.length, 2)
      assert.match(seen[1].url, /raw\.githubusercontent\.com/)
    },
  )
})

test('remotePackageVersion：源报错也继续退让，四个都失败回空串', async () => {
  const boom = { reqError: new Error('ENOTFOUND') }
  await withHttp([boom, boom, boom, boom], async (seen) => {
    assert.equal(await u.remotePackageVersion('ccc3333'), '')
    assert.equal(seen.length, 4, '四个源都试过')
    assert.match(seen[3].url, /^https:\/\/api\.github\.com\/repos\//)
  })
})

test('remotePackageVersion：api.github.com 的三种响应形态都能取出版本', async () => {
  // 形态 1：accept: raw 直接回 package.json 正文
  await withHttp([{ body: '{"version":"9.9.4"}' }], async () => {
    assert.equal(await u.remotePackageVersion('ddd4444'), '9.9.4')
  })
  // 形态 2：回对象里带 version
  await withHttp([{ body: '{"version":"9.9.5"}' }], async () => {
    assert.equal(await u.remotePackageVersion('eee5555'), '9.9.5')
  })
  // 形态 3：回 contents API 的 base64
  const inner = Buffer.from('{"version":"9.9.6"}').toString('base64')
  await withHttp([{ body: JSON.stringify({ content: inner, encoding: 'base64', type: 'file' }) }], async () => {
    assert.equal(await u.remotePackageVersion('fff6666'), '9.9.6')
  })
})

test('remotePackageVersion：成功结果被 memo，第二次不再发请求', async () => {
  await withHttp([{ body: '{"version":"9.9.7"}' }], async (seen) => {
    assert.equal(await u.remotePackageVersion('ggg7777'), '9.9.7')
    assert.equal(await u.remotePackageVersion('ggg7777'), '9.9.7')
    assert.equal(seen.length, 1, '第二次该走缓存')
  })
})

test('remotePackageVersion：失败也记短缓存，避免反复打空请求', async () => {
  const boom = { reqError: new Error('ENOTFOUND') }
  await withHttp([boom, boom, boom, boom], async (seen) => {
    assert.equal(await u.remotePackageVersion('hhh8888'), '')
    assert.equal(seen.length, 4)
    assert.equal(await u.remotePackageVersion('hhh8888'), '', '第二次仍回空')
    assert.equal(seen.length, 4, '第二次一次请求都不该发')
  })
})

// ---------------------------------------------------------------------------
// remoteHeadSha / listGithubTags
// ---------------------------------------------------------------------------

test('remoteHeadSha：api 的 sha 优先，即使 atom 也有值', async () => {
  const sha = 'a'.repeat(40)
  await withHttp(
    [{ body: JSON.stringify({ sha }) }, { body: `<id>tag:github.com,2008:Grit::Commit/${'b'.repeat(40)}</id>` }],
    async (seen) => {
      assert.equal(await u.remoteHeadSha('main'), sha)
      assert.equal(seen.length, 2)
      assert.match(seen[0].url, /api\.github\.com\/repos\/.*\/commits\/main$/)
      assert.match(seen[1].url, /github\.com\/.*\/commits\/main\.atom$/)
    },
  )
})

test('remoteHeadSha：api 失败时退回 atom 里的 40 位 sha', async () => {
  const sha = 'c'.repeat(40)
  await withHttp(
    [{ reqError: new Error('403') }, { body: `<entry><id>tag:github.com,2008:Grit::Commit/${sha}</id></entry>` }],
    async () => {
      assert.equal(await u.remoteHeadSha('main'), sha)
    },
  )
})

test('remoteHeadSha：两边都失败回空串，不抛', async () => {
  await withHttp([{ reqError: new Error('403') }, { reqError: new Error('404') }], async () => {
    assert.equal(await u.remoteHeadSha('main'), '')
  })
  await withHttp([{ body: '{}' }, { body: '<no id here>' }], async () => {
    assert.equal(await u.remoteHeadSha('main'), '')
  })
})

test('remoteHeadSha：ref 会被 URL 编码，空值回落 stable ref', async () => {
  await withHttp([{ body: '{}' }, { body: '' }], async (seen) => {
    await u.remoteHeadSha('')
    assert.match(seen[0].url, /commits\/main$/)
  })
  await withHttp([{ body: '{}' }, { body: '' }], async (seen) => {
    await u.remoteHeadSha('beta')
    assert.match(seen[0].url, /commits\/beta$/)
  })
})

test('listGithubTags：只留版本名，beta/rc/pre 标测试通道，其余标正式', async () => {
  const rows = [
    { name: 'v1.1.94', commit: { sha: 'a'.repeat(40) } },
    { name: '1.1.93', commit: { sha: 'b'.repeat(40) } },
    { name: 'v1.1.95-beta.1', commit: { sha: 'c'.repeat(40) } },
    { name: 'nightly', commit: { sha: 'd'.repeat(40) } },
    { name: '', commit: { sha: 'e'.repeat(40) } },
    { name: 'v2', commit: {} },
  ]
  await withHttp([{ body: JSON.stringify(rows) }], async () => {
    const tags = await u.listGithubTags()
    assert.deepEqual(tags.map((t) => t.ref), ['v1.1.94', '1.1.93', 'v1.1.95-beta.1'])
    assert.deepEqual(tags.map((t) => t.channel), ['stable', 'stable', 'beta'])
    assert.deepEqual(tags.map((t) => t.version), ['1.1.94', '1.1.93', '1.1.95-beta.1'])
    assert.equal(tags[0].kind, 'tag')
    assert.equal(tags[0].sha, 'a'.repeat(40))
    assert.equal(tags[0].label, '1.1.94（正式）')
    assert.equal(tags[2].label, '1.1.95-beta.1（测试）')
    assert.equal(tags[2].id, 'v1.1.95-beta.1')
  })
})

test('listGithubTags：非数组响应、网络失败都安静回空数组', async () => {
  await withHttp([{ body: '{"message":"Not Found"}' }], async () => {
    assert.deepEqual(await u.listGithubTags(), [])
  })
  await withHttp([{ reqError: new Error('ENOTFOUND') }], async () => {
    assert.deepEqual(await u.listGithubTags(), [])
  })
})

// ---------------------------------------------------------------------------
// describeLane / lanesOf：车道判断的四条分支
// ---------------------------------------------------------------------------

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function listed(over) {
  return {
    versions: [],
    hasBeta: false,
    stableSha: '',
    betaSha: '',
    ...over,
  }
}

test('describeLane：pin 住时只比提交号，不比版本号', () => {
  const lanes = u.lanesOf(
    listed({ stableSha: SHA_B, versions: [{ channel: 'stable', version: '9.9.9', ref: 'main', latest: true }] }),
    { channel: 'stable', pin: 'main' },
    '1.1.94',
    SHA_A,
  )
  assert.equal(lanes.stable.hasUpdate, true, 'pin + 提交号不同 = 有更新')
  assert.equal(lanes.stable.current, false)
  const same = u.lanesOf(
    listed({ stableSha: SHA_A, versions: [] }),
    { channel: 'stable', pin: 'main' },
    '1.1.94',
    SHA_A,
  )
  assert.equal(same.stable.hasUpdate, false)
  assert.equal(same.stable.current, true, '提交号相同就算当前')
  // 提交号相同、版本号却更旧/更新时也不能报更新：pin 之后只认提交号，
  // 退回版本号判断会在「main 已前进但 pin 没动」时无限重启。
  const newerVersion = u.lanesOf(
    listed({ stableSha: SHA_A, versions: [{ channel: 'stable', version: '9.9.9', ref: 'main', latest: true }] }),
    { channel: 'stable', pin: 'main' },
    '1.1.94',
    SHA_A,
  )
  assert.equal(newerVersion.stable.hasUpdate, false, 'pin 且提交号相同时，版本号再新也不算更新')
})

test('describeLane：没 pin 时比版本号，版本相同就不报更新', () => {
  const lanes = u.lanesOf(
    listed({ stableSha: SHA_B, versions: [{ channel: 'stable', version: '1.1.94', ref: 'main', latest: true }] }),
    { channel: 'stable', pin: '' },
    '1.1.94',
    SHA_A,
  )
  assert.equal(lanes.stable.hasUpdate, false, '提交号不同但版本号相同 → 不算更新（避免无限重启）')
  assert.equal(lanes.stable.version, '1.1.94')
})

test('describeLane：只在当前车道上才谈更新', () => {
  const lanes = u.lanesOf(
    listed({ stableSha: SHA_B, versions: [{ channel: 'stable', version: '9.9.9', ref: 'main', latest: true }] }),
    { channel: 'beta', pin: '' },
    '1.1.94',
    SHA_A,
  )
  assert.equal(lanes.stable.hasUpdate, false, 'stable 不是当前车道')
  assert.equal(lanes.beta.hasUpdate, false)
})

test('describeLane：本地版本号为空时才用提交号兜底判更新', () => {
  const lanes = u.lanesOf(
    listed({ stableSha: SHA_B, versions: [] }),
    { channel: 'stable', pin: '' },
    '',
    SHA_A,
  )
  assert.equal(lanes.stable.hasUpdate, true)
})

test('describeLane：hasRemote 只认远端条目，不认插进来的本地行', () => {
  const local = u.lanesOf(
    listed({ stableSha: '', versions: [{ channel: 'stable', version: '1.1.94', ref: 'main', kind: 'local', latest: true }] }),
    { channel: 'stable', pin: '' },
    '1.1.94',
    '',
  )
  assert.equal(local.stable.hasRemote, false, 'kind:local 不算远端')
  const head = u.lanesOf(
    listed({ stableSha: '', versions: [{ channel: 'stable', version: '1.1.94', ref: 'main', kind: 'head' }] }),
    { channel: 'stable', pin: '' },
    '1.1.94',
    '',
  )
  assert.equal(head.stable.hasRemote, true, 'kind:head 算远端')
  const tag = u.lanesOf(
    listed({ stableSha: '', versions: [{ channel: 'stable', version: '1.1.94', ref: 'v1.1.94', kind: 'tag' }] }),
    { channel: 'stable', pin: '' },
    '1.1.94',
    '',
  )
  assert.equal(tag.stable.hasRemote, true, 'kind:tag 算远端')
})

test('describeLane：sha 只吐 7 位短号，ref 走 CHANNELS', () => {
  const lanes = u.lanesOf(listed({ stableSha: SHA_A, betaSha: SHA_B }), { channel: 'stable', pin: '' }, '1.1.94', '')
  assert.equal(lanes.stable.sha, 'aaaaaaa')
  assert.equal(lanes.stable.ref, 'main')
  assert.equal(lanes.beta.sha, 'bbbbbbb')
  assert.equal(lanes.beta.ref, 'beta')
  assert.equal(lanes.stable.id, 'stable')
})
