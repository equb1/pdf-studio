/**
 * 手机网页（HTTP 入口）测试：**真起服务、真发请求**。
 *
 * 这里钉住的都是"手机那侧能不能用"的关键点：
 *   - 口令太短 → **拒绝启动**（不能拿弱令牌把端口暴露出去）；
 *   - 没口令/口令错 → 401；页面本身不需要口令（手机第一次打开时还没有）；
 *   - 收文件：base64 → 落盘到 `inbox/<taskId>/`，并把路径交给任务流水线；
 *   - 产物下载**只能读 outbox 里的文件**，`..` 逃逸一律 403；
 *   - 请求体过大 413、坏 JSON 400、缺指令 400、未知路径 404。
 *
 * Run: node --experimental-strip-types test/phone-bridge-http.test.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insideRoot, startHttpBridge, tokenMatches } from '../scripts/phone-bridge/http.ts'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

const WORK = mkdtempSync(join(tmpdir(), 'pb-http-'))
const OUTBOX = join(WORK, 'outbox')
const TOKEN = 'k'.repeat(24)
const submitted = []

const base = {
  host: '127.0.0.1',
  port: 0,
  token: TOKEN,
  outboxDir: OUTBOX,
  inboxDir: join(OUTBOX, 'inbox'),
  maxBodyBytes: 2048,
  presets: { 水印: '删水印', 拆分: '拆分' },
  page: '<html><body>PDF 助手 __PRESETS__</body></html>',
  logger: () => {},
  submit: task => { submitted.push(task) },
  status: taskId => (taskId === 't-1-known' ? { status: 'ok', artifacts: ['/x/a.pdf'] } : undefined),
}

let server = null
try {
  // ① 口令太短必须拒绝启动
  {
    let threw = false
    try { await startHttpBridge({ ...base, token: 'short', port: 0 }) } catch { threw = true }
    check('口令短于 16 位 → 拒绝启动（不拿弱令牌暴露端点）', threw)
    check('insideRoot：越界与同前缀兄弟目录都算外面',
      insideRoot('/o/a.pdf', '/o') && !insideRoot('/o2/a.pdf', '/o') && !insideRoot('/o/../etc/passwd', '/o'))
    check('tokenMatches：正确/错误/长度不符', tokenMatches(TOKEN, TOKEN) && !tokenMatches('x'.repeat(24), TOKEN) && !tokenMatches('short', TOKEN))
  }

  server = await startHttpBridge(base)
  const url = server.url

  // ② 页面本身不需要口令（手机第一次打开时还没有 token）
  {
    const res = await fetch(url)
    const html = await res.text()
    check('打开网页：200，且页面里已注入预设名', res.status === 200 && html.includes('PDF 助手') && html.includes('水印'), String(res.status))
  }

  // ③ 鉴权
  {
    const noToken = await fetch(url + 'api/health')
    check('没有口令 → 401', noToken.status === 401, String(noToken.status))
    const badToken = await fetch(url + 'api/health', { headers: { Authorization: 'Bearer ' + 'x'.repeat(24) } })
    check('口令错误 → 401', badToken.status === 401, String(badToken.status))
    const ok = await fetch(url + 'api/health', { headers: { Authorization: 'Bearer ' + TOKEN } })
    const body = await ok.json()
    check('口令正确 → 200 且返回预设列表', ok.status === 200 && body.presets.join(',') === '水印,拆分', JSON.stringify(body).slice(0, 80))
  }

  // ④ 提交任务：坏输入
  {
    const auth = { Authorization: 'Bearer ' + TOKEN }
    const badJson = await fetch(url + 'api/task', { method: 'POST', headers: auth, body: '{不是 JSON' })
    check('坏 JSON → 400', badJson.status === 400, String(badJson.status))
    const noInstr = await fetch(url + 'api/task', { method: 'POST', headers: auth, body: JSON.stringify({}) })
    check('缺少 instruction → 400', noInstr.status === 400, String(noInstr.status))
    const tooBig = await fetch(url + 'api/task', { method: 'POST', headers: auth, body: JSON.stringify({ instruction: 'x'.repeat(4000) }) })
    check('请求体过大 → 413', tooBig.status === 413, String(tooBig.status))
    const notFound = await fetch(url + 'api/nope', { headers: auth })
    check('未知路径 → 404', notFound.status === 404, String(notFound.status))
  }

  // ⑤ 提交任务：正常（带一个 base64 小文件）
  {
    const payload = {
      instruction: '水印',
      files: [{ name: '期末数学.pdf', contentBase64: Buffer.from('%PDF-1.4 fake').toString('base64') }],
    }
    const res = await fetch(url + 'api/task', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    const body = await res.json()
    check('正常提交 → 202 且返回 taskId', res.status === 202 && /^t-\d+-web/u.test(String(body.taskId)), `${res.status} ${JSON.stringify(body).slice(0, 70)}`)
    check('任务被交给流水线（指令原样传下去，由 core 负责展开预设）',
      submitted.length === 1 && submitted[0].text === '水印' && submitted[0].taskId === body.taskId, JSON.stringify(submitted[0] ?? {}).slice(0, 90))
    const saved = submitted[0]?.inputs?.[0] ?? ''
    check('文件落盘到 inbox/<taskId>/ 下', saved.includes(join('inbox', String(body.taskId))) && existsSync(saved), saved)
    check('文件内容字节正确', existsSync(saved) && readFileSync(saved, 'utf8') === '%PDF-1.4 fake', '')
  }

  // ⑥ 状态与产物下载
  {
    const auth = { Authorization: 'Bearer ' + TOKEN }
    const unknown = await fetch(url + 'api/task/t-nope', { headers: auth })
    check('未知任务 → 404', unknown.status === 404, String(unknown.status))
    const known = await fetch(url + 'api/task/t-1-known', { headers: auth })
    const body = await known.json()
    check('已知任务 → 200 + 状态与产物清单', known.status === 200 && body.status === 'ok' && body.artifacts[0] === '/x/a.pdf', JSON.stringify(body).slice(0, 80))

    // 产物下载：先放一个真文件进 outbox
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(OUTBOX, 't-1-known'), { recursive: true })
    writeFileSync(join(OUTBOX, 't-1-known', '结果.pdf'), '%PDF-1.4 result')
    const okDl = await fetch(url + 'api/artifact?taskId=t-1-known&index=0', { headers: auth })
    check('下载 outbox 内的产物 → 200 + application/pdf', okDl.status === 200 && String(okDl.headers.get('content-type')).includes('pdf'), String(okDl.status))
    check('下载内容正确', (await okDl.text()) === '%PDF-1.4 result', '')
    const outside = await fetch(url + 'api/artifact?taskId=../..&index=0', { headers: auth })
    const outsideByPath = await fetch(url + 'api/artifact-by-path?path=' + encodeURIComponent('/etc/hosts'), { headers: auth })
    check('越界的 taskId 拿不到东西（404，不会读到 outbox 之外）', outside.status === 404, String(outside.status))
    check('老式 path= 形式对 outbox 之外的文件 → 403', outsideByPath.status === 403, String(outsideByPath.status))
    const missing = await fetch(url + 'api/artifact?taskId=t-1-known&index=9', { headers: auth })
    check('文件不存在 → 404', missing.status === 404, String(missing.status))
  }
} finally {
  if (server !== null) await server.close().catch(() => {})
  rmSync(WORK, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'ALL PHONE-BRIDGE HTTP CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
