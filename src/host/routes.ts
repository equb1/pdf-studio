/**
 * Host HTTP surface: the plugin's whole UI is served and driven from here.
 *
 * There is deliberately no client bundle. A `dsh.client` package must be
 * materialised by the GUI's client-module system, and that system's service
 * graph differs between the web shell and the desktop shell — a mismatch the
 * desktop app fails at boot with "waiting for service". Serving the surface
 * ourselves over same-origin HTTP sidesteps that system entirely, which is
 * what makes one implementation run on both.
 *
 * @module dsh-pdf-studio/host/routes
 */

import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { guard, readJsonBody, requireMethod, writeJson } from './http.ts'
import { getPlan, listPlans, setPlanStatus } from '../core/confirmation.ts'
import {
  analyzeDocument,
  applyTextEdits,
  inspectDocument,
  exportSearchable,
  protectPdf,
  readEditableDocument,
  reportWatermarks,
  stampWatermark,
  stripWatermarks,
} from './engine.ts'

export { guard, isLoopback } from './http.ts'

/**
 * The analysis shape the export route consumes.
 *
 * Declared structurally rather than imported so this module carries no runtime
 * edge to the PDF engine: the route layer must stay loadable — and testable —
 * without the native canvas dependency or the OCR worker being present.
 */
interface AnalysisLike {
  sourcePath: string
  pages: number
  elapsedMs: number
  notes: string[]
  triage: Array<{ page: number; kind: string; evidence: Record<string, unknown>; width: number; height: number }>
  content: Array<{
    page: number
    width: number
    height: number
    kind: string
    lines: Array<{ text: string; confidence?: number; rect: unknown; source: string; runs: unknown[] }>
    notes: string[]
  }>
}

/** Browser-facing base path of the plugin API. */
export const PDF_API_PREFIX = '/api/pdf-studio'

/** Browser-facing path of the injected surface script. */
export const PDF_SURFACE_SCRIPT = '/dsh-pdf-studio/app.js'

/** Where an analysis is cached while the user decides what to export. */
const analyses = new Map<string, AnalysisLike>()

/** Minimal structural view of the webserver service this plugin uses. */
export interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The slice of `ctx.webServer` this plugin needs. */
export interface WebServerLike {
  register(route: WebRouteLike): () => void
  tapIndex?(transform: (html: string) => string): () => void
  /**
   * 正在监听的端口与绑定宿主（端口为 0 时由宿主填上 OS 分配的真实值）。
   *
   * 桌面端通过 `file://` 加载页面、fetch 走 IPC 桥接，相对路径在那里没有意义；
   * 注入时给出绝对地址，两端才都能连上同一套 `/api/pdf-studio/*`。
   */
  port?: number
  host?: string
}

/**
 * Walk up from this module to the package root.
 *
 * The package is loaded two ways — compiled (`lib/host/routes.js`) by the host,
 * and straight from source (`src/host/routes.ts`) by the tests — so a fixed
 * `../../` hop points outside the package for one of them. Anchoring on the
 * nearest ancestor holding a `package.json` is correct for both.
 */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Degrade rather than throw: a wrong asset path should answer 404, not stop
  // plugin activation.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/** Directory holding the served browser assets. */
export function publicDir(): string {
  return join(packageRoot(), 'public')
}

/** Serve one file from the public directory by exact name (no traversal). */
async function serveAsset(res: ServerResponse, name: string): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    writeJson(res, 400, { ok: false, error: 'bad-asset-name' })
    return
  }
  const file = join(publicDir(), name)
  if (!existsSync(file)) {
    writeJson(res, 404, { ok: false, error: 'asset-missing', name })
    return
  }
  const body = await readFile(file)
  const type = extname(name) === '.js'
    ? 'application/javascript; charset=utf-8'
    : extname(name) === '.css'
      ? 'text/css; charset=utf-8'
      : 'text/html; charset=utf-8'
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * List PDF files under a directory.
 *
 * `maxDepth` bounds how far the walk descends: 0 means the directory itself.
 * The bound exists because an unbounded walk is unusable in practice — scanning
 * a home directory to depth 4 measured 34 SECONDS and returned 14 files, while
 * depth 2 returned 11 of them in 55ms. Documents live near the top, so the
 * default is shallow and the caller can ask for more.
 *
 * A wall-clock deadline backs up the depth bound: a tree with tens of thousands
 * of entries can be slow even at a shallow depth, and a file picker must never
 * hang. Hitting the deadline returns what was found and says it was cut short.
 */
async function listPdfs(
  root: string,
  maxDepth: number,
  limit = 200,
  deadlineMs = 3000,
): Promise<{ files: string[]; truncated: boolean }> {
  const out: string[] = []
  const startedAt = Date.now()
  let truncated = false
  const expired = (): boolean => Date.now() - startedAt > deadlineMs

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= limit || expired()) {
      truncated = true
      return
    }
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      // An unreadable subdirectory is skipped, not fatal.
      return
    }
    for (const entry of entries) {
      if (out.length >= limit || expired()) {
        truncated = true
        return
      }
      // Hidden directories hold caches and configuration, and node_modules is
      // enormous; neither is where a user keeps documents.
      if (entry.startsWith('.') || entry === 'node_modules') continue
      const full = join(dir, entry)
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(full)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (extname(entry).toLowerCase() === '.pdf') out.push(full)
    }
  }

  await walk(root, 0)
  return { files: out, truncated }
}

/**
 * Build the plugin's route family.
 *
 * @param options.workspaceRoot - directory the file picker browses.
 */
export function makePdfRoutes(options: { workspaceRoot: string }): WebRouteLike[] {
  const workspace = resolve(options.workspaceRoot)

  /** Reject a path that escapes the workspace root (realpath-free check). */
  const insideWorkspace = (candidate: string): boolean => {
    const full = resolve(candidate)
    return full === workspace || full.startsWith(workspace + sep)
  }

  return [
    {
      kind: 'exact',
      path: PDF_SURFACE_SCRIPT,
      handler: (req, res) => {
        if (!guard(req, res)) return
        return serveAsset(res, 'app.js')
      },
    },
    {
      kind: 'exact',
      path: PDF_API_PREFIX + '/panel',
      handler: (req, res) => {
        if (!guard(req, res)) return
        return serveAsset(res, 'panel.html')
      },
    },
    {
      kind: 'exact',
      path: PDF_API_PREFIX + '/health',
      handler: (req, res) => {
        if (!guard(req, res)) return
        writeJson(res, 200, { ok: true, plugin: 'dsh-pdf-studio', workspace })
      },
    },
    {
      // 一个前缀路由覆盖三条接口：
      //   GET  /plans                → 待确认计划列表
      //   POST /plans/{id}/confirm   → 确认（浮层卡片点「确认执行」）
      //   POST /plans/{id}/cancel    → 取消
      kind: 'prefix',
      path: PDF_API_PREFIX + '/plans',
      handler: (req, res) => {
        if (!guard(req, res)) return
        const url = new URL(req.url ?? '/', 'http://local')
        const rest = url.pathname.slice((PDF_API_PREFIX + '/plans').length).replace(/^\/+/, '')
        if (rest === '') {
          if (req.method !== 'GET') {
            writeJson(res, 405, { ok: false, error: '列表只支持 GET' })
            return
          }
          writeJson(res, 200, { ok: true, plans: listPlans() })
          return
        }
        const [planId, verb] = rest.split('/')
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: '确认/取消只支持 POST' })
          return
        }
        if (planId === undefined || (verb !== 'confirm' && verb !== 'cancel')) {
          writeJson(res, 400, { ok: false, error: '用法：POST /plans/{planId}/confirm 或 /cancel' })
          return
        }
        const existing = getPlan(planId)
        if (existing === undefined) {
          writeJson(res, 404, { ok: false, error: `计划 ${planId} 不存在或已过期` })
          return
        }
        const plan = setPlanStatus(planId, verb === 'confirm' ? 'confirmed' : 'cancelled')
        writeJson(res, 200, { ok: true, plan })
      },
    },
    {
      kind: 'exact',
      path: PDF_API_PREFIX + '/list',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const url = new URL(req.url ?? '/', 'http://local')
        const dir = url.searchParams.get('dir') ?? workspace
        if (!insideWorkspace(dir)) {
          writeJson(res, 403, { ok: false, error: 'outside-workspace' })
          return
        }
        // Depth 2 covers the common case (a document folder one level below the
        // workspace) without the multi-second walk that depth 4 costs.
        const requestedDepth = Number(url.searchParams.get('depth') ?? '2')
        const depth = Number.isFinite(requestedDepth)
          ? Math.max(0, Math.min(4, Math.trunc(requestedDepth)))
          : 2
        try {
          const { files, truncated } = await listPdfs(dir, depth)
          writeJson(res, 200, { ok: true, dir, depth, count: files.length, files, truncated })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error as Error).message) })
        }
      },
    },
    {
      kind: 'exact',
      path: PDF_API_PREFIX + '/analyze',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        try {
          const body = (await readJsonBody(req)) as { path?: unknown; lang?: unknown }
          const target = typeof body.path === 'string' ? body.path : ''
          if (target === '' || !existsSync(target)) {
            writeJson(res, 400, { ok: false, error: 'file-not-found', path: target })
            return
          }
          const lang = typeof body.lang === 'string' && body.lang !== '' ? body.lang : undefined
          const analysis = await analyzeDocument(target, lang === undefined ? {} : { lang })
          analyses.set(analysis.sourcePath, analysis)
          writeJson(res, 200, {
            ok: true,
            sourcePath: analysis.sourcePath,
            pages: analysis.pages,
            elapsedMs: analysis.elapsedMs,
            notes: analysis.notes,
            triage: analysis.triage,
            summary: analysis.content.map(page => ({
              page: page.page,
              kind: page.kind,
              lines: page.lines.length,
              sample: page.lines.slice(0, 3).map(line => line.text.slice(0, 80)),
              meanConfidence: page.lines.length === 0
                ? null
                : Math.round(
                    page.lines.reduce((sum, l) => sum + (l.confidence ?? 100), 0) / page.lines.length,
                  ),
            })),
          })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error as Error).message) })
        }
      },
    },
    {
      // Serve a PDF's bytes so the browser canvas can render it. Read-only and
      // workspace-scoped: this is the one route that hands out document content.
      kind: 'exact',
      path: PDF_API_PREFIX + '/file',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const url = new URL(req.url ?? '/', 'http://local')
        const target = url.searchParams.get('path') ?? ''
        if (target === '' || !existsSync(target)) {
          writeJson(res, 400, { ok: false, error: 'file-not-found', path: target })
          return
        }
        if (extname(target).toLowerCase() !== '.pdf') {
          writeJson(res, 403, { ok: false, error: 'not-a-pdf', path: target })
          return
        }
        try {
          const body = await readFile(target)
          res.writeHead(200, {
            'content-type': 'application/pdf',
            'content-length': String(body.byteLength),
            'cache-control': 'no-store',
          })
          res.end(body)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error as Error).message) })
        }
      },
    },
    {
      // Rasterise one page for the canvas backdrop. Rendering on the host keeps
      // the browser side free of pdf.js worker configuration, and reuses the
      // exact render path the OCR stage already proved.
      kind: 'exact',
      path: PDF_API_PREFIX + '/page.png',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const url = new URL(req.url ?? '/', 'http://local')
        const target = url.searchParams.get('path') ?? ''
        const pageNumber = Number(url.searchParams.get('page') ?? '1')
        const scale = Number(url.searchParams.get('scale') ?? '2')
        if (target === '' || !existsSync(target)) {
          writeJson(res, 400, { ok: false, error: 'file-not-found', path: target })
          return
        }
        if (!Number.isFinite(pageNumber) || pageNumber < 1) {
          writeJson(res, 400, { ok: false, error: 'bad-page', page: url.searchParams.get('page') })
          return
        }
        const safeScale = Number.isFinite(scale) && scale > 0 && scale <= 4 ? scale : 2
        try {
          const { renderPagePng } = await import('./render.ts')
          const png = await renderPagePng(target, pageNumber, safeScale)
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-length': String(png.byteLength),
            'cache-control': 'no-store',
          })
          res.end(png)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error as Error).message) })
        }
      },
    },
    {
      // Cheap page geometry for the preview. Must not extract or OCR.
      kind: 'exact',
      path: PDF_API_PREFIX + '/info',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const url = new URL(req.url ?? '/', 'http://local')
        const target = url.searchParams.get('path') ?? ''
        if (target === '' || !existsSync(target)) {
          writeJson(res, 400, { ok: false, error: 'file-not-found', path: target })
          return
        }
        try {
          writeJson(res, 200, { ok: true, ...(await inspectDocument(target)) })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error as Error).message) })
        }
      },
    },
    {
      kind: 'exact',
      path: PDF_API_PREFIX + '/runs',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const url = new URL(req.url ?? '/', 'http://local')
        const target = url.searchParams.get('path') ?? ''
        if (target === '' || !existsSync(target)) {
          writeJson(res, 400, { ok: false, error: 'file-not-found', path: target })
          return
        }
        try {
          const model = await readEditableDocument(target)
          writeJson(res, 200, { ok: true, ...model })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error as Error).message) })
        }
      },
    },
    {
      kind: 'exact',
      path: PDF_API_PREFIX + '/apply',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (!requireMethod(req, res, 'POST')) return
        try {
          const body = (await readJsonBody(req)) as { path?: unknown; output?: unknown; edits?: unknown }
          const source = typeof body.path === 'string' ? body.path : ''
          if (source === '' || !existsSync(source)) {
            writeJson(res, 400, { ok: false, error: 'file-not-found', path: source })
            return
          }
          const edits = Array.isArray(body.edits) ? body.edits : []
          const output = typeof body.output === 'string' && body.output !== ''
            ? body.output
            : join(dirname(source), basename(source, '.pdf') + '-edited.pdf')
          if (!insideWorkspace(output)) {
            writeJson(res, 403, { ok: false, error: 'outside-workspace', output })
            return
          }
          const result = await applyTextEdits(
            source,
            output,
            edits as Array<{ page: number; targetId: string; to: string; fontSize?: number }>,
          )
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error as Error).message) })
        }
      },
    },
    {
      kind: 'exact',
      path: PDF_API_PREFIX + '/watermark/scan',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const url = new URL(req.url ?? '/', 'http://local')
        const target = url.searchParams.get('path') ?? ''
        if (target === '' || !existsSync(target)) {
          writeJson(res, 400, { ok: false, error: 'file-not-found', path: target })
          return
        }
        try {
          writeJson(res, 200, { ok: true, ...(await reportWatermarks(target)) })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error as Error).message) })
        }
      },
    },
    {
      kind: 'exact',
      path: PDF_API_PREFIX + '/watermark/add',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (!requireMethod(req, res, 'POST')) return
        try {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          const source = typeof body.path === 'string' ? body.path : ''
          if (source === '' || !existsSync(source)) {
            writeJson(res, 400, { ok: false, error: 'file-not-found', path: source })
            return
          }
          const text = typeof body.text === 'string' ? body.text : ''
          const imagePath = typeof body.imagePath === 'string' ? body.imagePath : ''
          if (text === '' && imagePath === '') {
            writeJson(res, 400, { ok: false, error: 'text-or-image-required' })
            return
          }
          const output = typeof body.output === 'string' && body.output !== ''
            ? body.output
            : join(dirname(source), basename(source, '.pdf') + '-watermarked.pdf')
          if (!insideWorkspace(output)) {
            writeJson(res, 403, { ok: false, error: 'outside-workspace', output })
            return
          }
          const image = imagePath === '' ? undefined : new Uint8Array(await readFile(imagePath))
          const result = await stampWatermark(source, output, {
            ...(text === '' ? {} : { text }),
            ...(image === undefined ? {} : { image }),
            ...(typeof body.placement === 'string' ? { placement: body.placement as never } : {}),
            ...(typeof body.corner === 'string' ? { corner: body.corner as never } : {}),
            ...(typeof body.rotation === 'number' ? { rotation: body.rotation } : {}),
            ...(typeof body.opacity === 'number' ? { opacity: body.opacity } : {}),
            ...(typeof body.color === 'string' ? { color: body.color } : {}),
            ...(typeof body.fontSize === 'number' ? { fontSize: body.fontSize } : {}),
          })
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error as Error).message) })
        }
      },
    },
    {
      kind: 'exact',
      path: PDF_API_PREFIX + '/watermark/remove',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (!requireMethod(req, res, 'POST')) return
        try {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          const source = typeof body.path === 'string' ? body.path : ''
          if (source === '' || !existsSync(source)) {
            writeJson(res, 400, { ok: false, error: 'file-not-found', path: source })
            return
          }
          const output = typeof body.output === 'string' && body.output !== ''
            ? body.output
            : join(dirname(source), basename(source, '.pdf') + '-clean.pdf')
          if (!insideWorkspace(output)) {
            writeJson(res, 403, { ok: false, error: 'outside-workspace', output })
            return
          }
          const result = await stripWatermarks(source, output, {
            dryRun: body.dryRun === true,
            ...(body.all === true ? { all: true } : {}),
            ...(typeof body.minConfidence === 'number' ? { minConfidence: body.minConfidence } : {}),
          })
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error as Error).message) })
        }
      },
    },
    {
      kind: 'exact',
      path: PDF_API_PREFIX + '/encryption',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const url = new URL(req.url ?? '/', 'http://local')
        const target = url.searchParams.get('path') ?? ''
        if (target === '' || !existsSync(target)) {
          writeJson(res, 400, { ok: false, error: 'file-not-found', path: target })
          return
        }
        try {
          const bytes = new Uint8Array(await readFile(target))
          const { inspectEncryption } = await import('../core/qpdf.ts')
          writeJson(res, 200, { ok: true, path: target, ...(await inspectEncryption(bytes)) })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error as Error).message) })
        }
      },
    },
    {
      kind: 'exact',
      path: PDF_API_PREFIX + '/protect',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (!requireMethod(req, res, 'POST')) return
        try {
          const body = (await readJsonBody(req)) as {
            path?: unknown; output?: unknown; action?: unknown
            userPassword?: unknown; ownerPassword?: unknown; password?: unknown; allow?: unknown
          }
          const source = typeof body.path === 'string' ? body.path : ''
          if (source === '' || !existsSync(source)) {
            writeJson(res, 400, { ok: false, error: 'file-not-found', path: source })
            return
          }
          const action = body.action === 'decrypt' ? 'decrypt' : 'encrypt'
          const output = typeof body.output === 'string' && body.output !== ''
            ? body.output
            : join(dirname(source), basename(source, '.pdf') + (action === 'encrypt' ? '-protected.pdf' : '-unlocked.pdf'))
          if (!insideWorkspace(output)) {
            writeJson(res, 403, { ok: false, error: 'outside-workspace', output })
            return
          }

          if (action === 'encrypt') {
            const userPassword = typeof body.userPassword === 'string' ? body.userPassword : ''
            if (userPassword === '') {
              writeJson(res, 400, { ok: false, error: 'password-required' })
              return
            }
            const result = await protectPdf(source, output, {
              kind: 'encrypt',
              userPassword,
              ...(typeof body.ownerPassword === 'string' ? { ownerPassword: body.ownerPassword } : {}),
              ...(Array.isArray(body.allow) ? { allow: body.allow as never } : {}),
            })
            writeJson(res, 200, { ok: true, ...result })
            return
          }

          const password = typeof body.password === 'string' ? body.password : ''
          const result = await protectPdf(source, output, { kind: 'decrypt', password })
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(res, 400, { ok: false, error: String((error as Error).message) })
        }
      },
    },
    {
      kind: 'exact',
      path: PDF_API_PREFIX + '/export',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        try {
          const body = (await readJsonBody(req)) as { path?: unknown; output?: unknown; mode?: unknown }
          const source = typeof body.path === 'string' ? body.path : ''
          const analysis = analyses.get(source)
          if (analysis === undefined) {
            writeJson(res, 409, { ok: false, error: 'analyze-first', path: source })
            return
          }
          const output = typeof body.output === 'string' && body.output !== ''
            ? body.output
            : join(dirname(source), basename(source, '.pdf') + '-searchable.pdf')
          if (!insideWorkspace(output)) {
            writeJson(res, 403, { ok: false, error: 'outside-workspace', output })
            return
          }
          const mode = body.mode === 'cover' ? 'cover' : 'invisible'
          const result = await exportSearchable(analysis, output, mode)
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error as Error).message) })
        }
      },
    },
    {
      kind: 'exact',
      path: PDF_API_PREFIX + '/write',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        // Reserved for the editing model: accepts a full replacement text
        // model for one page and rebuilds that page. Not wired to the UI yet;
        // it exists so the route family is stable while the model lands.
        try {
          const body = (await readJsonBody(req)) as { path?: unknown }
          writeJson(res, 501, {
            ok: false,
            error: 'not-implemented',
            detail: 'page write-back lands with the edit model',
            path: typeof body.path === 'string' ? body.path : null,
          })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error as Error).message) })
        }
      },
    },
  ]
}

/** Convenience: write a JSON payload to disk (used by tests and tools). */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}
