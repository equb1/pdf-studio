/**
 * 手机网页（MVP）用的 HTTP 服务：把"发文件 + 点按钮"变成一个任务。
 *
 * ## 为什么放在桥接器里而不是插件里
 *
 * 桥接器是**宿主侧常驻进程**，它自己就监听着飞书；手机要访问的也是"这台主机"，
 * 所以让桥接器顺手提供一个端口最省事——不用碰插件的 loopback 信任栅栏，
 * 也不用把 DSH 的 web 服务暴露出去。
 *
 * ## 安全边界（fail-closed，和插件那套下载端点同一思路）
 *
 * - **没配 token 就不启动**（默认关闭）；token 短于 16 位直接拒绝启动；
 * - token 用**定时安全比较**；
 * - 请求体有大小上限；JSON 坏了返回 400；队列满返回 429；
 * - 默认只监听 `127.0.0.1`；要给手机用就显式填 Tailscale 地址（**不暴露公网**）；
 * - 产物下载**只允许 outbox 目录内**的文件（`..` 逃逸一律 403）。
 *
 * @module phone-bridge/http
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile, stat } from 'node:fs/promises'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { timingSafeEqual } from 'node:crypto'

/** 定时安全比较（长度不同直接 false）。 */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

/** 路径是否在根目录内（含边界检查）。 */
export function insideRoot(candidate: string, root: string): boolean {
  const full = resolve(candidate)
  const base = resolve(root)
  return full === base || full.startsWith(base + sep)
}

/** 按扩展名给 content-type（未知给 octet-stream，不猜）。 */
export function contentTypeOf(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.pdf': return 'application/pdf'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.txt': return 'text/plain; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

export interface HttpBridgeOptions {
  host: string
  port: number
  token: string
  /** 额外口令（每人一个）：各自独立计限流与每日配额；token 字段仍作为主口令保留。 */
  tokens?: Array<{ token: string; label: string }>
  /** 每分钟请求上限（按口令），默认 60。 */
  rateLimitPerMinute?: number
  /** 每个口令每天最多提交多少任务，默认 30。 */
  maxTasksPerDay?: number
  outboxDir: string
  inboxDir: string
  /** 单次请求体上限（字节）。 */
  maxBodyBytes: number
  /** 页面上显示的预设按钮（名字 → 指令）。 */
  presets: Record<string, string>
  /** 产物扩展名白名单（必须与状态接口一致，否则两处列出的顺序会不同）。 */
  allowedExtensions?: string[]
  /** 给了证书就用 HTTPS；自签也行，手机上点一次「继续访问」即可。浏览器只在安全上下文里提供分享文件的能力。 */
  tls?: { key: Buffer; cert: Buffer }
  /** 预设 → 名称输入框（页面据此弹窗）。 */
  presetFields?: Record<string, Array<{ key: string; label: string; suffix?: string }>>
  /** 预设按钮"名字"，页面只显示名字。 */
  page: string
  /** 页面文件路径：给了就**每次请求都读**（改完页面刷新即生效，不用重启服务）。 */
  pagePath?: string
  logger: (line: string) => void
  /** 提交任务：返回 taskId。`inputs` 是已落盘的文件绝对路径。 */
  submit: (task: { text: string; inputs: string[]; taskId: string }) => void
  /** 查任务状态。 */
  status: (taskId: string) => { status: string; artifacts: string[] } | undefined
  /** 查最近一个任务（用于网页刷新或重新打开时恢复状态）。 */
  latestTask?: () => { taskId: string; status: string; artifacts: string[] } | undefined
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  res.end(text)
}

const readBody = async (req: IncomingMessage, max: number): Promise<string> => {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks: Buffer[] = []
    let overflow = false
    req.on('data', chunk => {
      if (overflow) return                       // 已经超限：继续把数据读完，但不再累积
      size += chunk.length
      if (size > max) {
        // **不要立刻 destroy**：那会让客户端看到"连接被关"而不是 413（实测踩过）。
        // 先把 413 回出去，剩下的数据读完丢掉即可。
        overflow = true
        rejectPromise(new Error('body-too-large'))
        return
      }
      chunks.push(chunk as Buffer)
    })
    req.on('end', () => { if (!overflow) resolvePromise(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', error => rejectPromise(error))
  })
}

/** 从 `Authorization: Bearer x` 或 `?token=` 里取 token。 */
function tokenOf(req: IncomingMessage, url: URL): string {
  const header = req.headers.authorization ?? ''
  const match = /^Bearer\s+(.+)$/iu.exec(header)
  if (match !== null) return match[1].trim()
  return url.searchParams.get('token') ?? ''
}

/** 生成一个可读的 taskId（沿用 outbox 目录命名，方便清理逻辑一起管）。 */
function newTaskId(): string {
  return `t-${Date.now()}-web${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 启动手机网页服务。返回 `{ close, url }`。
 *
 * token 太短会**抛错**而不是降级启动——宁可起不来，也不要拿弱令牌把端点暴露出去。
 */
export async function startHttpBridge(options: HttpBridgeOptions): Promise<{ close: () => Promise<void>; url: string }> {
  const token = options.token.trim()
  if (token.length < 16) throw new Error('httpToken 长度不足 16，拒绝启动（避免用弱令牌暴露端点）')

  // handler 只做转发：真正的逻辑在下面定义的 handle（运行时才调用，所以顺序没问题）
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res).catch(error => {
      options.logger(`HTTP 处理失败：${String(error)}`)
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal' })
    })
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    // 页面本身不需要 token（手机第一次打开时还没有；token 由页面索取后存本地）
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      // 每次请求都读页面文件：改前端不用重启服务（实测忘了这点，改完页面刷新还是旧的 ✗）
      let template = options.page
      if (options.pagePath !== undefined) {
        try { template = await readFile(options.pagePath, 'utf8') } catch { /* 读不到就用启动时那份 */ }
      }
      const html = template.replace('__PRESETS__', JSON.stringify(Object.keys(options.presets)))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' })
      res.end(html)
      return
    }

    // 多口令鉴权：主口令 + tokens 列表；命中哪个口令就按它的 label 记账（每人一个 token ✓）
    const accepted = [{ token, label: '主人' }].concat(options.tokens ?? [])
    const provided = tokenOf(req, url)
    const hit = accepted.find(entry => tokenMatches(provided, entry.token))
    if (hit === undefined) {
      json(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    // 限流（按口令、60 秒滑动窗口）：公网服务必须防住扫描与刷次数
    const nowMs = Date.now()
    const limit = options.rateLimitPerMinute ?? 60
    const recent = (rateBuckets.get(hit.label) ?? []).filter(at => nowMs - at < 60_000)
    if (recent.length >= limit) {
      json(res, 429, { ok: false, error: 'rate-limited', limit, note: '请求太频繁，请稍后再试' })
      return
    }
    recent.push(nowMs)
    rateBuckets.set(hit.label, recent)

    if (req.method === 'GET' && path === '/api/health') {
      const lastTask = options.latestTask?.()
      json(res, 200, {
        ok: true,
        presets: Object.keys(options.presets),
        presetFields: options.presetFields ?? {},
        outbox: options.outboxDir,
        ...(lastTask !== undefined && lastTask.status !== undefined ? { lastTask } : {}),
      })
      return
    }

    // 产物下载：**优先按文件名**取，序号只做兜底。
    //
    // 踩过的坑：显示用状态接口列出的顺序、下载用这里重新列一遍的顺序，
    // 两处只要白名单或目录内容有一点差异，序号就整体错位——
    // 表现是"标签写着试卷、下载下来是答案"✗。按名字取就彻底避免了这类错位。
    if (req.method === 'GET' && path === '/api/artifact') {
      const taskId = url.searchParams.get('taskId') ?? ''
      const index = Number(url.searchParams.get('index') ?? '0')
      const wanted = url.searchParams.get('name') ?? ''
      if (taskId === '' || !Number.isInteger(index) || index < 0) { json(res, 400, { ok: false, error: 'missing-taskId' }); return }
      const allowed = options.allowedExtensions ?? ['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.md']
      const listed = listArtifacts(options.outboxDir, taskId, allowed)
      let picked: string | undefined
      if (wanted !== '') {
        const wantNorm = wanted.normalize('NFC')
        picked = listed.find(candidate => basename(candidate).normalize('NFC') === wantNorm)
        if (picked === undefined) {
          const stem = wantNorm.replace(/\.[^.]+$/u, '')
          const hits = listed.filter(candidate => basename(candidate).normalize('NFC').startsWith(stem))
          if (hits.length === 1) picked = hits[0]
        }
      }
      if (picked === undefined) picked = listed[index]
      if (picked === undefined) { json(res, 404, { ok: false, error: 'not-found' }); return }
      const body = await readFile(picked)
      const isInline = url.searchParams.get('inline') === '1'
      const dispositionType = isInline ? 'inline' : 'attachment'
      res.writeHead(200, {
        'content-type': contentTypeOf(picked),
        'content-length': body.length,
        'content-disposition': `${dispositionType}; filename="${encodeURIComponent(basename(picked))}"`,
        'cache-control': 'no-store',
      })
      res.end(body)
      return
    }

    // 老式 `?path=` 形式仍支持（**仅 ASCII 路径可靠**，中文名请用 taskId+index）
    if (req.method === 'GET' && path === '/api/artifact-by-path') {
      const target = url.searchParams.get('path') ?? ''
      if (target === '') { json(res, 400, { ok: false, error: 'missing-path' }); return }
      if (!insideRoot(target, options.outboxDir)) { json(res, 403, { ok: false, error: 'outside-outbox' }); return }
      // macOS 会把中文文件名存成 **NFD** 规范化形式，而拼出来的路径是 **NFC** —— 直接 stat 会 ENOENT
      // （实测：本机 404，文件明明在）。所以先试原路径，不行就按目录列出来做归一化匹配。
      const statWithNormalization = async (candidate: string) => {
        try { return { path: candidate, info: await stat(candidate) } } catch { /* 继续做归一化匹配 */ }
        try {
          const want = basename(candidate).normalize('NFC')
          const hit = readdirSync(dirname(candidate)).find(name => name.normalize('NFC') === want)
          if (hit !== undefined) return { path: join(dirname(candidate), hit), info: await stat(join(dirname(candidate), hit)) }
        } catch { /* 目录不存在等 */ }
        return undefined
      }
      const found = await statWithNormalization(target)
      try {
        if (found === undefined) { json(res, 404, { ok: false, error: 'not-found' }); return }
        if (!found.info.isFile()) { json(res, 404, { ok: false, error: 'not-a-file' }); return }
        const body = await readFile(found.path)
        res.writeHead(200, {
          'content-type': contentTypeOf(found.path),
          'content-length': body.length,
          'content-disposition': `attachment; filename="${basename(found.path).replace(/[\r\n"]/gu, '_')}"`,
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch {
        json(res, 404, { ok: false, error: 'not-found' })
      }
      return
    }

    if (req.method === 'GET' && path.startsWith('/api/task/')) {
      const taskId = decodeURIComponent(path.slice('/api/task/'.length))
      const info = options.status(taskId)
      if (info === undefined) { json(res, 404, { ok: false, error: 'unknown-task' }); return }
      json(res, 200, { ok: true, taskId, status: info.status, artifacts: info.artifacts })
      return
    }

    if (req.method === 'POST' && path === '/api/task') {
      let raw = ''
      try {
        raw = await readBody(req, options.maxBodyBytes)
      } catch (error) {
        const tooLarge = String(error).includes('body-too-large')
        json(res, tooLarge ? 413 : 400, { ok: false, error: tooLarge ? 'body-too-large' : 'bad-body' })
        return
      }
      let parsed: { instruction?: unknown; files?: unknown }
      try {
        parsed = JSON.parse(raw) as { instruction?: unknown; files?: unknown }
      } catch {
        json(res, 400, { ok: false, error: 'bad-json' })
        return
      }
      const instruction = typeof parsed.instruction === 'string' ? parsed.instruction.trim() : ''
      if (instruction === '') { json(res, 400, { ok: false, error: 'missing-instruction' }); return }

      // 每日配额：每个口令每天最多提交 maxTasksPerDay 个任务
      const day = new Date().toISOString().slice(0, 10)
      const quotaKey = hit.label + '@' + day
      const usedToday = dailyCounts.get(quotaKey) ?? 0
      const maxPerDay = options.maxTasksPerDay ?? 30
      if (usedToday >= maxPerDay) {
        json(res, 429, { ok: false, error: 'daily-quota', limit: maxPerDay, note: '今天的次数已用完（' + hit.label + '），明天再来' })
        return
      }
      dailyCounts.set(quotaKey, usedToday + 1)
      options.logger(`[${hit.label}] 今日第 ${usedToday + 1}/${maxPerDay} 个任务`)

      const taskId = newTaskId()
      const taskDir = join(options.inboxDir, taskId)
      const savedPaths: string[] = []
      const files = Array.isArray(parsed.files) ? parsed.files : []
      if (files.length > 0) {
        mkdirSync(taskDir, { recursive: true })
        for (const entry of files.slice(0, 10)) {
          const name = typeof (entry as { name?: unknown }).name === 'string' ? basename(String((entry as { name: string }).name)) : `file-${savedPaths.length}`
          const base64 = typeof (entry as { contentBase64?: unknown }).contentBase64 === 'string' ? String((entry as { contentBase64: string }).contentBase64) : ''
          if (base64 === '') continue
          const safe = name.replace(/[\r\n"]/gu, '_').replace(/^\.+/u, '').slice(0, 160) || `file-${savedPaths.length}.bin`
          const target = join(taskDir, safe)
          try {
            writeFileSync(target, Buffer.from(base64, 'base64'))
            savedPaths.push(target)
          } catch (error) {
            options.logger(`保存上传文件失败（${safe}）：${String(error)}`)
          }
        }
      }

      try {
        options.submit({ text: instruction, inputs: savedPaths, taskId })
      } catch (error) {
        if (savedPaths.length > 0) rmSync(taskDir, { recursive: true, force: true })
        json(res, 429, { ok: false, error: 'queue-full', detail: String(error) })
        return
      }
      options.logger(`网页任务已提交：${taskId}（文件 ${savedPaths.length} 个，指令 ${instruction.slice(0, 60)}）`)
      json(res, 202, { ok: true, taskId, files: savedPaths.length, note: '完成后产物会发到飞书；本页也可下载' })
      return
    }

    json(res, 404, { ok: false, error: 'not-found' })
  }

  // 配了证书就走 HTTPS：浏览器只在安全上下文里允许「分享文件给微信」这一能力
  // 按口令记账：分钟窗口用于限流，每日计数用于配额（内存即可，重启清零可接受）
  const rateBuckets = new Map<string, number[]>()
  const dailyCounts = new Map<string, number>()

  const server = options.tls === undefined
    ? createServer(handler)
    : createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, handler)

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(options.port, options.host, () => resolvePromise())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port
  const scheme = options.tls === undefined ? 'http' : 'https'
  const url = `${scheme}://${options.host}:${port}/`
  options.logger(`手机网页已启动：${url}（预设 ${Object.keys(options.presets).join('、')}）`)

  return {
    url,
    close: async () => {
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
    },
  }
}

/** 列出某个任务目录里的产物（给状态接口用）。 */
export function listArtifacts(outboxDir: string, taskId: string, allowedExtensions: readonly string[]): string[] {
  const dir = join(outboxDir, taskId)
  try {
    const allowed = allowedExtensions.map(extension => extension.toLowerCase())
    return readdirSync(dir)
      .map(name => join(dir, name))
      .filter(path => allowed.includes(extname(path).toLowerCase()))
      .filter(path => { try { return statSync(path).isFile() } catch { return false } })
      .sort()
  } catch {
    return []
  }
}
