/**
 * 「手机直下」下载端点测试。
 *
 * 这条路由是**唯一不走 loopback 栅栏**的端点（否则手机在 Tailscale/内网里根本访问不到），
 * 所以它的安全全部压在三个点上，测试也就围绕这三点：
 *   1. **凭据是 token**：没有/错误/长度不符一律 403，且与请求来源地址无关；
 *   2. **可读范围硬限制**：越出 `downloadRoot`（含 `..` 与同前缀兄弟目录）一律 403；
 *   3. **默认关闭**：不配置 token 时这条路由根本不存在。
 *
 * 全部用例用假 req/res，不监听端口、不联网。
 *
 * Run: node --experimental-strip-types test/download-route.test.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDF_API_PREFIX, makePdfRoutes } from '../src/host/routes.ts'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

/** 最小 ServerResponse 捕获（记录状态、头部、文本与二进制体）。 */
function fakeRes() {
  const state = { status: 0, headers: {}, body: '', binary: Buffer.alloc(0) }
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers ?? {} },
    end(chunk) {
      if (chunk === undefined) return
      const type = String(state.headers['content-type'] ?? '')
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      if (!type.startsWith('application/json')) state.binary = bytes
      else state.body += bytes.toString('utf8')
    },
    setHeader() {},
  }
}

/** 最小 IncomingMessage（默认 loopback；可改成 Tailscale 那种非 loopback 地址）。 */
function fakeReq({ method = 'GET', url = '/', remoteAddress = '127.0.0.1' } = {}) {
  return { method, url, headers: { host: '127.0.0.1:19387' }, socket: { remoteAddress } }
}

const WORK = mkdtempSync(join(tmpdir(), 'dl-route-'))
try {
  const root = join(WORK, 'outbox')
  const sibling = join(WORK, 'outbox-other')
  mkdirSync(join(root, 't-1'), { recursive: true })
  mkdirSync(sibling, { recursive: true })
  const pdfBody = '%PDF-1.4\n假的但足够长的内容\n%%EOF'
  const pdfPath = join(root, 't-1', '结果.pdf')
  writeFileSync(pdfPath, pdfBody)
  writeFileSync(join(sibling, 'outside.pdf'), 'x')
  writeFileSync(join(WORK, 'secret.txt'), '不该被读到')
  const bigPath = join(root, 'big.pdf')
  writeFileSync(bigPath, 'x'.repeat(200))

  const TOKEN = 'k'.repeat(24)
  const routes = makePdfRoutes({ workspaceRoot: WORK, download: { token: TOKEN, root, maxBytes: 50 } })
  const route = routes.find(item => item.path === PDF_API_PREFIX + '/download')
  const plainRoutes = makePdfRoutes({ workspaceRoot: WORK })

  const call = async (query, options = {}) => {
    const res = fakeRes()
    await route.handler(fakeReq({ url: PDF_API_PREFIX + '/download' + query, ...options }), res)
    return { status: res.state.status, headers: res.state.headers, body: res.state.body, binary: res.state.binary }
  }

  // ── 1. 默认关闭 ─────────────────────────────────────────────────────────
  check('不配置 token 时**不注册**下载路由（默认关闭）',
    plainRoutes.every(item => item.path !== PDF_API_PREFIX + '/download'),
    plainRoutes.map(item => item.path).filter(path => path.includes('download')).join(','))

  // ── 2. 凭据：token ──────────────────────────────────────────────────────
  {
    const none = await call(`?path=${encodeURIComponent(pdfPath)}`)
    check('没有 token → 403', none.status === 403 && none.body.includes('bad-token'), `${none.status} ${none.body}`)
    const wrong = await call(`?path=${encodeURIComponent(pdfPath)}&token=${'w'.repeat(24)}`)
    check('token 错误 → 403', wrong.status === 403)
    const short = await call(`?path=${encodeURIComponent(pdfPath)}&token=${'k'.repeat(8)}`)
    check('token 长度不符 → 403（定时安全比较不泄露更多信息）', short.status === 403)
    const post = await call(`?path=${encodeURIComponent(pdfPath)}&token=${TOKEN}`, { method: 'POST' })
    check('非 GET → 405', post.status === 405 && post.body.includes('method-not-allowed'), `${post.status}`)
  }

  // ── 3. 正常下载（含手机/Tailscale 那种非 loopback 来源） ────────────────
  {
    const ok = await call(`?path=${encodeURIComponent(pdfPath)}&token=${TOKEN}`)
    check('正确 token + 正确路径 → 200', ok.status === 200, `${ok.status} ${ok.body}`)
    check('返回的字节与文件完全一致', ok.binary.toString('utf8') === pdfBody, `${ok.binary.length} 字节`)
    check('content-type 按扩展名给 application/pdf', ok.headers['content-type'] === 'application/pdf', String(ok.headers['content-type']))
    check('content-length 与文件大小一致', ok.headers['content-length'] === Buffer.byteLength(pdfBody), String(ok.headers['content-length']))
    check('content-disposition 是附件且文件名已清洗', String(ok.headers['content-disposition']).startsWith('attachment; filename="') && String(ok.headers['content-disposition']).endsWith('.pdf"'), String(ok.headers['content-disposition']))
    check('cache-control: no-store（产物不该被中间层缓存）', ok.headers['cache-control'] === 'no-store')

    const fromTailnet = await call(`?path=${encodeURIComponent(pdfPath)}&token=${TOKEN}`, { remoteAddress: '100.101.102.103' })
    check('**非 loopback 来源（Tailscale 地址）带正确 token 也能下**（这正是加这条路由的原因）', fromTailnet.status === 200, String(fromTailnet.status))
    const tailnetNoToken = await call(`?path=${encodeURIComponent(pdfPath)}`, { remoteAddress: '100.101.102.103' })
    check('非 loopback 且没 token → 403', tailnetNoToken.status === 403)
  }

  // ── 4. 可读范围：越界一律 403 ───────────────────────────────────────────
  {
    const outside = await call(`?path=${encodeURIComponent(join(WORK, 'secret.txt'))}&token=${TOKEN}`)
    check('根目录之外的文件 → 403（不泄露其是否存在）', outside.status === 403 && outside.body.includes('outside-download-root'), `${outside.status} ${outside.body}`)
    const siblingFile = await call(`?path=${encodeURIComponent(join(sibling, 'outside.pdf'))}&token=${TOKEN}`)
    check('同前缀兄弟目录（outbox-other）不算在内 → 403', siblingFile.status === 403)
    const traversal = await call(`?path=${encodeURIComponent(join(root, '..', 'secret.txt'))}&token=${TOKEN}`)
    check('用 .. 逃逸 → 403', traversal.status === 403)
    const missingPath = await call(`?token=${TOKEN}`)
    check('缺少 path 参数 → 400', missingPath.status === 400 && missingPath.body.includes('missing-path'), `${missingPath.status}`)
  }

  // ── 5. 文件层面的边界 ───────────────────────────────────────────────────
  {
    const notFound = await call(`?path=${encodeURIComponent(join(root, '不存在.pdf'))}&token=${TOKEN}`)
    check('文件不存在 → 404', notFound.status === 404 && notFound.body.includes('not-found'))
    const dir = await call(`?path=${encodeURIComponent(root)}&token=${TOKEN}`)
    check('目录（不是文件）→ 404 not-a-file（不列目录）', dir.status === 404 && dir.body.includes('not-a-file'), `${dir.status} ${dir.body}`)
    const tooBig = await call(`?path=${encodeURIComponent(bigPath)}&token=${TOKEN}`)
    check('超过 maxBytes → 413 并给出大小上限', tooBig.status === 413 && tooBig.body.includes('file-too-large') && tooBig.body.includes('maxBytes'), `${tooBig.status} ${tooBig.body}`)
  }
} finally {
  rmSync(WORK, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'ALL DOWNLOAD-ROUTE CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
