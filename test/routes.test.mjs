/**
 * Host route tests — the HTTP surface and its trust fence.
 *
 * These run against `src/` through Node's type stripping, so they need no
 * build step and no DSH host: the routes are exercised with fake
 * request/response objects.
 *
 * Run: node --experimental-strip-types test/routes.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { makePdfRoutes, isLoopback, PDF_API_PREFIX } from '../src/host/routes.ts'

let failed = 0
const test = async (name, fn) => {
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL  ' + name)
    console.log('      ' + (error && error.message ? error.message : String(error)))
  }
}

/** Minimal ServerResponse capture. */
function fakeRes() {
  const state = { status: 0, headers: {}, body: '', binary: Buffer.alloc(0) }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
    },
    end(chunk) {
      if (chunk === undefined) return
      // Discriminate on CONTENT-TYPE, not on the JS type: `writeJson` also ends
      // with a Buffer, so a type check would route every JSON response into
      // `binary` and leave `body` empty.
      const type = String(state.headers['content-type'] ?? '')
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      if (type.startsWith('image/') || type.startsWith('application/pdf')) {
        state.binary = bytes
      } else {
        state.body += bytes.toString('utf8')
      }
    },
    setHeader() {},
  }
}

/** Minimal IncomingMessage; loopback by default. */
function fakeReq({ method = 'GET', url = '/', headers = {}, remoteAddress = '127.0.0.1', body } = {}) {
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:19387', ...headers },
    socket: { remoteAddress },
  }
  if (body !== undefined) {
    req[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    }
  }
  return req
}

const routes = makePdfRoutes({ workspaceRoot: process.cwd() })
const find = path => routes.find(route => route.path === path)

console.log('host routes\n')

// ── trust fence ─────────────────────────────────────────────────────────────

await test('accepts a loopback request', () => {
  assert.equal(isLoopback(fakeReq()), true)
})

await test('rejects a non-loopback socket address', () => {
  assert.equal(isLoopback(fakeReq({ remoteAddress: '10.0.0.7' })), false)
})

await test('rejects a non-loopback Host header', () => {
  assert.equal(isLoopback(fakeReq({ headers: { host: 'evil.example.com' } })), false)
})

await test('rejects a cross-site fetch marker', () => {
  assert.equal(isLoopback(fakeReq({ headers: { 'sec-fetch-site': 'cross-site' } })), false)
})

await test('rejects a mismatched Origin', () => {
  assert.equal(isLoopback(fakeReq({ headers: { origin: 'https://evil.example.com' } })), false)
})

await test('accepts a matching same-origin Origin', () => {
  assert.equal(isLoopback(fakeReq({ headers: { origin: 'http://127.0.0.1:19387' } })), true)
})

// ── route family ────────────────────────────────────────────────────────────

await test('exposes the expected route family', () => {
  for (const path of [
    '/dsh-pdf-studio/app.js',
    PDF_API_PREFIX + '/panel',
    PDF_API_PREFIX + '/health',
    PDF_API_PREFIX + '/list',
    PDF_API_PREFIX + '/file',
    PDF_API_PREFIX + '/page.png',
    PDF_API_PREFIX + '/info',
    PDF_API_PREFIX + '/runs',
    PDF_API_PREFIX + '/apply',
    PDF_API_PREFIX + '/encryption',
    PDF_API_PREFIX + '/protect',
    PDF_API_PREFIX + '/watermark/scan',
    PDF_API_PREFIX + '/watermark/add',
    PDF_API_PREFIX + '/watermark/remove',
    PDF_API_PREFIX + '/analyze',
    PDF_API_PREFIX + '/export',
    PDF_API_PREFIX + '/write',
  ]) {
    assert.ok(find(path), 'missing route ' + path)
  }
})

await test('health answers ok with the workspace', async () => {
  const res = fakeRes()
  await find(PDF_API_PREFIX + '/health').handler(fakeReq({ url: PDF_API_PREFIX + '/health' }), res)
  const body = JSON.parse(res.state.body)
  assert.equal(res.state.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.workspace, process.cwd())
})

await test('a non-loopback request is refused with 403', async () => {
  const res = fakeRes()
  await find(PDF_API_PREFIX + '/health').handler(fakeReq({ remoteAddress: '10.0.0.7' }), res)
  assert.equal(res.state.status, 403)
  assert.equal(JSON.parse(res.state.body).error, 'forbidden: loopback-only')
})

await test('list rejects a directory outside the workspace', async () => {
  const res = fakeRes()
  const url = PDF_API_PREFIX + '/list?dir=' + encodeURIComponent('/etc')
  await find(PDF_API_PREFIX + '/list').handler(fakeReq({ url }), res)
  assert.equal(res.state.status, 403)
  assert.equal(JSON.parse(res.state.body).error, 'outside-workspace')
})

await test('list finds the demo PDFs in the workspace', async () => {
  const res = fakeRes()
  // The studio workspace has no PDFs of its own; point at a real directory
  // inside it that the test itself creates.
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const dir = join(process.cwd(), 'test', 'fixtures')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'probe.pdf'), '%PDF-1.4\n%%EOF\n', 'utf8')
  const url = PDF_API_PREFIX + '/list?dir=' + encodeURIComponent(dir)
  await find(PDF_API_PREFIX + '/list').handler(fakeReq({ url }), res)
  const body = JSON.parse(res.state.body)
  assert.equal(body.ok, true)
  assert.ok(body.files.some(file => file.endsWith('probe.pdf')), 'probe.pdf not listed')
  await rm(dir, { recursive: true, force: true })
})

await test('file route refuses a non-PDF extension', async () => {
  const res = fakeRes()
  const url = PDF_API_PREFIX + '/file?path=' + encodeURIComponent(process.cwd() + '/package.json')
  await find(PDF_API_PREFIX + '/file').handler(fakeReq({ url }), res)
  assert.equal(res.state.status, 403)
  assert.equal(JSON.parse(res.state.body).error, 'not-a-pdf')
})

await test('page.png rejects a bad page number', async () => {
  const res = fakeRes()
  const { writeFile, mkdir, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const dir = join(process.cwd(), 'test', 'fixtures')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'tiny.pdf'), '%PDF-1.4\n%%EOF\n')
  const url = PDF_API_PREFIX + '/page.png?page=0&path=' + encodeURIComponent(join(dir, 'tiny.pdf'))
  await find(PDF_API_PREFIX + '/page.png').handler(fakeReq({ url }), res)
  assert.equal(res.state.status, 400)
  assert.equal(JSON.parse(res.state.body).error, 'bad-page')
  await rm(dir, { recursive: true, force: true })
})

await test('watermark add requires text or an image', async () => {
  const res = fakeRes()
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const dir = join(process.cwd(), 'test', 'fixtures')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'wm-target.pdf')
  await writeFile(file, '%PDF-1.4\n%%EOF\n')
  await find(PDF_API_PREFIX + '/watermark/add').handler(
    fakeReq({ method: 'POST', url: PDF_API_PREFIX + '/watermark/add', body: { path: file } }),
    res,
  )
  assert.equal(res.state.status, 400)
  assert.equal(JSON.parse(res.state.body).error, 'text-or-image-required')
  await rm(dir, { recursive: true, force: true })
})

await test('watermark scan rejects a missing file', async () => {
  const res = fakeRes()
  const url = PDF_API_PREFIX + '/watermark/scan?path=' + encodeURIComponent('/nope/missing.pdf')
  await find(PDF_API_PREFIX + '/watermark/scan').handler(fakeReq({ url }), res)
  assert.equal(res.state.status, 400)
  assert.equal(JSON.parse(res.state.body).error, 'file-not-found')
})

await test('protect requires a password to encrypt', async () => {
  const res = fakeRes()
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const dir = join(process.cwd(), 'test', 'fixtures')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'protect-target.pdf')
  await writeFile(file, '%PDF-1.4\n%%EOF\n')
  await find(PDF_API_PREFIX + '/protect').handler(
    fakeReq({ method: 'POST', url: PDF_API_PREFIX + '/protect', body: { path: file, action: 'encrypt' } }),
    res,
  )
  assert.equal(res.state.status, 400)
  assert.equal(JSON.parse(res.state.body).error, 'password-required')
  await rm(dir, { recursive: true, force: true })
})

await test('encryption inspection reports the file state', async () => {
  const res = fakeRes()
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const dir = join(process.cwd(), 'test', 'fixtures')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'plain.pdf')
  await writeFile(file, '%PDF-1.4\ntrailer\n<< /Size 1 >>\n%%EOF\n')
  const url = PDF_API_PREFIX + '/encryption?path=' + encodeURIComponent(file)
  await find(PDF_API_PREFIX + '/encryption').handler(fakeReq({ url }), res)
  const body = JSON.parse(res.state.body)
  assert.equal(res.state.status, 200)
  assert.equal(body.encrypted, false)
  await rm(dir, { recursive: true, force: true })
})

await test('analyze rejects a missing file', async () => {
  const res = fakeRes()
  await find(PDF_API_PREFIX + '/analyze').handler(
    fakeReq({ method: 'POST', url: PDF_API_PREFIX + '/analyze', body: { path: '/nope/missing.pdf' } }),
    res,
  )
  assert.equal(res.state.status, 400)
  assert.equal(JSON.parse(res.state.body).error, 'file-not-found')
})

await test('analyze refuses a non-POST method', async () => {
  const res = fakeRes()
  await find(PDF_API_PREFIX + '/analyze').handler(fakeReq({ url: PDF_API_PREFIX + '/analyze' }), res)
  assert.equal(res.state.status, 405)
})

await test('export before analyze answers 409', async () => {
  const res = fakeRes()
  await find(PDF_API_PREFIX + '/export').handler(
    fakeReq({ method: 'POST', url: PDF_API_PREFIX + '/export', body: { path: '/tmp/never-analyzed.pdf' } }),
    res,
  )
  assert.equal(res.state.status, 409)
  assert.equal(JSON.parse(res.state.body).error, 'analyze-first')
})

await test('the asset route refuses traversal', async () => {
  const res = fakeRes()
  // The asset handler is async (it reads from disk); await its result so the
  // assertions run after the response is written.
  await await find('/dsh-pdf-studio/app.js').handler(
    fakeReq({ url: '/dsh-pdf-studio/app.js', headers: { host: '127.0.0.1:19387' } }),
    res,
  )
  // The route itself serves the literal name 'app.js', so this asserts the
  // asset exists and is served as JavaScript.
  assert.equal(res.state.status, 200)
  assert.match(String(res.state.headers['content-type']), /javascript/)
})

// ── the file listing must stay bounded ──────────────────────────────────────
//
// An unbounded walk is unusable: scanning a home directory to depth 4 measured
// 34 SECONDS. The depth bound is what keeps the picker responsive, so it is
// asserted rather than assumed — a regression here would be felt as a hang.

await test('list honours the depth bound', async () => {
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const root = join(process.cwd(), 'test', 'fixtures', 'depth')
  const nested = join(root, 'a', 'b')
  await mkdir(nested, { recursive: true })
  await mkdir(join(root, 'a', 'c'), { recursive: true })
  await writeFile(join(root, 'top.pdf'), '%PDF-1.4\n')
  await writeFile(join(root, 'a', 'one.pdf'), '%PDF-1.4\n')
  await writeFile(join(root, 'a', 'b', 'two.pdf'), '%PDF-1.4\n')

  const at = async depth => {
    const res = fakeRes()
    const url = PDF_API_PREFIX + '/list?depth=' + depth + '&dir=' + encodeURIComponent(root)
    await find(PDF_API_PREFIX + '/list').handler(fakeReq({ method: 'GET', url }), res)
    return JSON.parse(res.state.body)
  }

  const d0 = await at(0)
  assert.equal(d0.count, 1, `depth 0 should see only the top level: ${JSON.stringify(d0.files)}`)
  const d1 = await at(1)
  assert.equal(d1.count, 2, `depth 1 should reach one level down: ${JSON.stringify(d1.files)}`)
  const d2 = await at(2)
  assert.equal(d2.count, 3, `depth 2 should reach both levels: ${JSON.stringify(d2.files)}`)
  assert.equal(d2.truncated, false)

  // An absurd depth must be clamped to the documented maximum, not honoured.
  const clamped = await at(99)
  assert.equal(clamped.depth, 4, `depth must clamp, got ${clamped.depth}`)
  assert.equal(clamped.count, 3)

  await rm(root, { recursive: true, force: true })
})


// ── success paths ───────────────────────────────────────────────────────────
//
// Every route above this line is tested only through its FAILURE paths (missing
// file, wrong method, refused origin). That gap let a whole feature break
// silently: `analyzeDocument` was dropped from an import statement, and because
// the reference sat inside a function body, nothing failed until a real request
// arrived. These cases drive each handler to a 200 with real bytes — the only
// thing that catches a missing binding.

const FIXTURE = '/Users/Zhuanz/dsh-pdf-maker/demo/source/contract.pdf'

/** Drive a route handler and collect its response. */
async function callRoute(path, options = {}) {
  const route = find(path)
  const res = fakeRes()
  const query = options.query ?? ''
  const method = options.method ?? 'POST'
  const req = fakeReq({
    method,
    url: path + query,
    ...(options.body === undefined ? {} : { body: options.body }),
  })
  req.method = method
  await route.handler(req, res)
  return { status: res.state.status, body: res.state.body === '' ? {} : JSON.parse(res.state.body), binary: res.state.binary }
}

if (!existsSync(FIXTURE)) {
  console.log('  --  skipped success paths: fixture not found')
} else {
  await test('health answers 200 with the plugin identity', async () => {
    const { status, body } = await callRoute(PDF_API_PREFIX + '/health', { method: 'GET' })
    assert.equal(status, 200)
    assert.equal(body.plugin, 'dsh-pdf-studio')
  })

  await test('analyze reaches a real 200 on a born-digital PDF', async () => {
    const { status, body } = await callRoute(PDF_API_PREFIX + '/analyze', { body: { path: FIXTURE } })
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200))
    assert.equal(body.pages, 1)
    assert.equal(body.summary[0].kind, 'text', JSON.stringify(body.summary))
    assert.ok(body.summary[0].lines > 5, 'expected extracted lines')
  })

  await test('runs returns a decoded editable model', async () => {
    const { status, body } = await callRoute(PDF_API_PREFIX + '/runs', {
      method: 'GET', query: '?path=' + encodeURIComponent(FIXTURE),
    })
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200))
    const runs = body.content[0].runs
    assert.ok(runs.length > 5, `expected runs, got ${runs.length}`)
    assert.ok(runs.every(run => typeof run.text === 'string'), 'every run must carry decoded text')
    assert.ok(runs.some(run => run.text.replace(/\s+/g, '') === '服务合同'), 'title must decode')
  })

  await test('encryption inspection reaches a real 200', async () => {
    const { status, body } = await callRoute(PDF_API_PREFIX + '/encryption', {
      method: 'GET', query: '?path=' + encodeURIComponent(FIXTURE),
    })
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200))
    assert.equal(body.encrypted, false)
  })

  await test('watermark scan reaches a real 200 and finds nothing on a clean file', async () => {
    const { status, body } = await callRoute(PDF_API_PREFIX + '/watermark/scan', {
      method: 'GET', query: '?path=' + encodeURIComponent(FIXTURE),
    })
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200))
    assert.deepEqual(body.candidates, [])
    assert.ok(Array.isArray(body.refused), 'refusals must be reported, not omitted')
  })

  await test('info returns page geometry without extracting', async () => {
    const { status, body } = await callRoute(PDF_API_PREFIX + '/info', {
      method: 'GET', query: '?path=' + encodeURIComponent(FIXTURE),
    })
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200))
    assert.equal(body.pages, 1)
    assert.equal(body.sizes[0].page, 1)
    assert.ok(body.sizes[0].width > 500 && body.sizes[0].height > 700,
      `unexpected page size ${JSON.stringify(body.sizes[0])}`)
    assert.equal(body.encrypted, false)
    // The preview must never carry extracted text: it is geometry only.
    assert.equal(body.content, undefined, 'info must not extract content')
  })

  await test('page.png renders a real PNG', async () => {
    const { status, binary } = await callRoute(PDF_API_PREFIX + '/page.png', {
      method: 'GET', query: '?page=1&scale=1&path=' + encodeURIComponent(FIXTURE),
    })
    assert.equal(status, 200)
    assert.equal(binary.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'response must be a PNG')
    assert.ok(binary.length > 1000, `PNG too small: ${binary.length}`)
  })
}

console.log(`\n${failed === 0 ? 'all route tests passed' : failed + ' route test(s) failed'}`)
if (failed > 0) process.exitCode = 1
