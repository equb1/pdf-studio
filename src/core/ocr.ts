/**
 * OCR stage — turn a raster-only page into positioned text lines.
 *
 * This is the `image` branch of the pipeline in `core/contracts.ts`: a page
 * whose text layer cannot be trusted is rendered to a PNG and read by
 * tesseract, and every recognised line comes back as a normal `TextLine` so
 * everything downstream (edit model, searchable-PDF writer) is identical for
 * scanned and digital pages.
 *
 * Three things here are easy to get wrong and are therefore stated explicitly:
 *
 * 1. **Worker script.** Under Node, tesseract must run
 *    `tesseract.js/src/worker-script/node/index.js`. The browser bundle
 *    (`dist/worker.min.js`) throws `r.g.addEventListener is not a function`
 *    because it assumes a `WorkerGlobalScope`. We pin the node script.
 * 2. **Coordinates.** Tesseract reports `bbox` in canvas pixels with a
 *    TOP-LEFT origin. The contract wants PDF points with a BOTTOM-LEFT
 *    origin. The flip lives in `core/coords.ts` and nowhere else; this module
 *    only ever calls `deviceRectToPdf` / `deviceToPdf`.
 * 3. **Blocks.** `worker.recognize(image)` alone returns a flat string.
 *    Coordinates require the third argument `{ blocks: true }`; without it
 *    tesseract.js leaves `blocks` at its default of `false` (see
 *    `src/worker-script/constants/defaultOutput.js`).
 *
 * @module dsh-pdf-studio/core/ocr
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { deviceRectToPdf, deviceToPdf } from './coords.ts'
import type { OcrPageResult, PdfRect, PixelRect, TextLine, TextRun } from './contracts.ts'

const require = createRequire(import.meta.url)

/** Default language data. Shared, 44 MB, never copied — see `cacheMethod` below. */
const DEFAULT_LANG_PATH = '/Users/Zhuanz/dsh-pdf-maker/assets/tessdata'
/** Render scale. 2× is the measured sweet spot for 300-ish dpi exam scans. */
const DEFAULT_SCALE = 2
const DEFAULT_LANG = 'chi_sim'
/** Page mean confidence below which we warn the user. */
const LOW_CONFIDENCE = 70
/** Fraction of a line box's height used as the font-size estimate (see below). */
const SIZE_FROM_HEIGHT = 0.8

/**
 * Spaces tesseract inserts *inside* a CJK run (`"笔 试 部 分"`).
 *
 * Only spaces with a CJK character on BOTH sides are removed, so latin
 * ("A.stick B.discover"), CJK/latin boundaries ("共 50 分") and punctuation
 * are untouched. The range is deliberately a superset of the requested
 * U+4E00–U+9FFF: CJK Extension A (U+3400–U+4DBF) and CJK Compatibility
 * Ideographs (U+F900–U+FAFF) are CJK too, and a space between two of them is
 * just as certainly tesseract noise.
 */
const CJK_SPACE_RE =
  /(?<=[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])[\u3000 ]+(?=[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])/g

/** Options accepted by every entry point in this module. */
export interface OcrOptions {
  /** Render scale for rasterisation; pixel boxes are divided by this. Default 2. */
  scale?: number
  /** Tesseract language(s), `+`-joined. Default `'chi_sim'`. */
  lang?: string
  /** Directory holding `<lang>.traineddata[.gz]`. Default {@link DEFAULT_LANG_PATH}. */
  langPath?: string
  /**
   * Path to the tesseract core. Defaults to the `tesseract.js-core` package.
   * Under Node the worker picks the wasm build itself and ignores this, but a
   * browser/edge caller can point it somewhere else.
   */
  corePath?: string
  /** Drop lines whose confidence is below this (0..100). Default 0 = keep all. */
  minConfidence?: number
  /** Called once per completed page, in page order. */
  onPage?: (result: OcrPageResult) => void
  /**
   * Extension to the contract, required by `createOcrSession`, which has no
   * document parameter: an already-open pdf.js document that the session
   * reads pages from. The session never destroys a document it did not open.
   */
  doc?: unknown
  /**
   * Extension to the contract: path of a PDF the session opens once and
   * releases on `dispose()`. Use this when the caller has no open document.
   */
  sourcePath?: string
}

/* ------------------------------------------------------------------ *
 * tesseract.js / pdf.js typings (structural — we never import types)
 * ------------------------------------------------------------------ */

/** A pixel box exactly as tesseract's JSON renderer emits it. */
interface TessBbox {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface TessWord {
  text?: string
}

interface TessLine {
  bbox?: TessBbox
  text?: string
  confidence?: number
  /** Ink baseline of the line: `y0` is the baseline row in device pixels. */
  baseline?: TessBbox
  words?: TessWord[]
}

interface TessParagraph {
  lines?: TessLine[]
}

interface TessBlock {
  paragraphs?: TessParagraph[]
}

interface TessResult {
  text?: string | null
  confidence?: number | null
  blocks?: TessBlock[] | null
}

interface TesseractWorker {
  recognize(
    image: unknown,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ): Promise<{ data: TessResult }>
  terminate(): Promise<void>
}

interface PdfViewport {
  width: number
  height: number
}

interface PdfPageLike {
  getViewport(params: { scale: number }): PdfViewport
  render(params: { canvasContext: unknown; viewport: unknown }): { promise: Promise<void> }
  cleanup?(): void
}

interface PdfDocumentLike {
  numPages?: number
  getPage(pageNumber: number): Promise<PdfPageLike>
  destroy?(): Promise<void>
  loadingTask?: { destroy?(): Promise<void> }
}

interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string }
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocumentLike> }
}

/* ------------------------------------------------------------------ *
 * Path resolution
 * ------------------------------------------------------------------ */

/**
 * The tesseract worker script that actually runs under Node.
 *
 * Exported behaviourally only through its use: the browser bundle at
 * `dist/worker.min.js` crashes in Node with
 * `r.g.addEventListener is not a function`, so this path is not a preference.
 */
function nodeWorkerPath(): string {
  const pkg = require.resolve('tesseract.js/package.json')
  return join(dirname(pkg), 'src', 'worker-script', 'node', 'index.js')
}

/** Resolve the tesseract core entry from the installed package. */
function resolvedCorePath(): string | undefined {
  try {
    return join(dirname(require.resolve('tesseract.js-core/package.json')), 'index.js')
  } catch {
    return undefined // Let tesseract.js fall back to its own resolution.
  }
}

/**
 * Whether the language data for `lang` is gzipped in `langPath`.
 *
 * `cacheMethod: 'none'` makes tesseract read straight from disk, and it
 * appends `.gz` when `gzip` is true. Probing avoids a confusing ENOENT when a
 * caller points `langPath` at a directory holding only the raw `.traineddata`.
 */
function detectGzip(langPath: string, lang: string): boolean {
  for (const one of lang.split('+')) {
    if (existsSync(join(langPath, `${one}.traineddata.gz`))) return true
    if (existsSync(join(langPath, `${one}.traineddata`))) return false
  }
  return true // Unprobeable: keep the upstream default and let it error clearly.
}

/* ------------------------------------------------------------------ *
 * pdf.js
 * ------------------------------------------------------------------ */

let pdfjsPromise: Promise<PdfjsModule> | undefined

/**
 * Import the legacy pdf.js build once per process and pin its worker.
 *
 * The legacy build is required under Node (the modern one expects browser
 * globals); `workerSrc` must be set or pdf.js silently refuses to render.
 */
async function loadPdfjs(): Promise<PdfjsModule> {
  if (pdfjsPromise === undefined) {
    pdfjsPromise = (async () => {
      const entry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
      const mod = (await import(pathToFileURL(entry).href)) as unknown as PdfjsModule
      mod.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
      return mod
    })()
  }
  return pdfjsPromise
}

/** A document plus how to release it — `release` is a no-op when we borrowed it. */
interface ResolvedDocument {
  doc: PdfDocumentLike
  release(): Promise<void>
}

/** Destroy a pdf.js document, whatever API shape this version exposes. */
async function releaseDocument(doc: PdfDocumentLike): Promise<void> {
  try {
    if (typeof doc.destroy === 'function') {
      await doc.destroy()
      return
    }
    // pdfjs-dist 6 exposes `loadingTask.destroy()` and no `destroy()` on the
    // document proxy itself; both are tried so either version is released.
    await doc.loadingTask?.destroy?.()
  } catch {
    // Releasing is best-effort: a failure here must not mask a page error.
  }
}

/**
 * Accept the shapes a caller can hand us for "a document":
 * an open pdf.js document (borrowed), a filesystem path, or PDF bytes (owned).
 */
async function openDocumentSource(source: unknown): Promise<ResolvedDocument> {
  const borrowed = source as PdfDocumentLike | null | undefined
  if (borrowed !== null && borrowed !== undefined && typeof borrowed.getPage === 'function') {
    return { doc: borrowed, release: async () => {} }
  }
  let bytes: Uint8Array | undefined
  if (typeof source === 'string') {
    bytes = new Uint8Array(await readFile(source))
  } else if (source instanceof Uint8Array) {
    bytes = source
  }
  if (bytes === undefined) {
    throw new TypeError(
      'ocr: expected an open pdf.js document, a file path, or PDF bytes',
    )
  }
  const pdfjs = await loadPdfjs()
  // `useSystemFonts:false` + `isEvalSupported:false` keep rendering
  // deterministic and quiet for documents with non-embedded standard fonts.
  const doc = await pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise
  return { doc, release: () => releaseDocument(doc) }
}

/* ------------------------------------------------------------------ *
 * Tesseract worker
 * ------------------------------------------------------------------ */

interface ResolvedOptions {
  scale: number
  lang: string
  langPath: string
  corePath?: string
  minConfidence: number
  onPage?: (result: OcrPageResult) => void
  doc?: unknown
  sourcePath?: string
}

function resolveOptions(options: OcrOptions): ResolvedOptions {
  const scale = options.scale ?? DEFAULT_SCALE
  const resolved: ResolvedOptions = {
    scale: scale > 0 ? scale : DEFAULT_SCALE,
    lang: options.lang ?? DEFAULT_LANG,
    langPath: options.langPath ?? DEFAULT_LANG_PATH,
    minConfidence: options.minConfidence ?? 0,
    onPage: options.onPage,
    doc: options.doc,
    sourcePath: options.sourcePath,
  }
  const corePath = options.corePath ?? resolvedCorePath()
  if (corePath !== undefined) resolved.corePath = corePath
  return resolved
}

/**
 * Build one tesseract worker (one wasm instance + one loaded language).
 *
 * `cacheMethod: 'none'` is deliberate: the default cache path is the process
 * CWD, so a plain run would drop a 44 MB `chi_sim.traineddata` next to the
 * source. The shared read-only `langPath` is always used instead.
 */
async function createTesseractWorker(options: ResolvedOptions): Promise<TesseractWorker> {
  const tesseract = require('tesseract.js') as {
    createWorker: (
      langs: string,
      oem: number,
      opts: Record<string, unknown>,
    ) => Promise<TesseractWorker>
    OEM?: { LSTM_ONLY?: number }
  }
  const workerOptions: Record<string, unknown> = {
    workerPath: nodeWorkerPath(),
    langPath: options.langPath,
    gzip: detectGzip(options.langPath, options.lang),
    cacheMethod: 'none',
  }
  if (options.corePath !== undefined) workerOptions.corePath = options.corePath
  return tesseract.createWorker(
    options.lang,
    tesseract.OEM?.LSTM_ONLY ?? 1,
    workerOptions,
  )
}

/** Terminate without letting a teardown failure mask the real error. */
async function safeTerminate(worker: TesseractWorker | undefined): Promise<void> {
  if (worker === undefined) return
  try {
    await worker.terminate()
  } catch {
    // Already gone — nothing useful to do, and throwing here would replace the
    // original failure with a teardown one.
  }
}

/* ------------------------------------------------------------------ *
 * Page rendering + line conversion
 * ------------------------------------------------------------------ */

interface RenderedPage {
  png: Buffer
  /** Page height in PDF points (scale 1) — the y-flip's missing ingredient. */
  pageHeightPt: number
  pageWidthPt: number
}

/** Rasterise one page to PNG with the same canvas pdf.js draws into. */
async function renderPage(page: PdfPageLike, scale: number): Promise<RenderedPage> {
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(viewport.width, viewport.height)
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  return {
    png: canvas.toBuffer('image/png'),
    pageHeightPt: base.height,
    pageWidthPt: base.width,
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Accept a tesseract bbox only when all four edges are usable numbers. */
function normalizeBbox(bbox: TessBbox | undefined): PixelRect | undefined {
  if (bbox === undefined || bbox === null) return undefined
  const x0 = finiteNumber(bbox.x0)
  const y0 = finiteNumber(bbox.y0)
  const x1 = finiteNumber(bbox.x1)
  const y1 = finiteNumber(bbox.y1)
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) {
    return undefined
  }
  return { x0, y0, x1, y1 }
}

/**
 * Undo tesseract's CJK character spacing and strip the trailing newline it
 * appends to every line.
 *
 * WHY a lookaround: only a space with CJK on BOTH sides is tesseract noise.
 * A blanket `replace(/ /g,'')` would destroy `A.stick B.discover`; keeping
 * spaces at CJK/latin boundaries is what makes `"共 50 分"` readable.
 */
function cleanupCjkSpacing(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CJK_SPACE_RE, '')
    .trim()
}

/** Text of a line, falling back to its words when tesseract omitted `text`. */
function lineText(line: TessLine): string {
  if (typeof line.text === 'string') return line.text
  return asArray<TessWord>(line.words).map(word => word.text ?? '').join(' ')
}

/**
 * Convert one tesseract line into a contract `TextLine`, or `undefined` when
 * it carries no usable text or no usable box.
 *
 * Font size: the tesseract line box is an *ink + leading* box, slightly taller
 * than the glyph em. `height × 0.8` approximates ascender-to-descender
 * coverage; it matches pdf.js text-layer sizes on the sample scans within
 * ~10 %, and the writer's `sizeFactor` exists precisely to tune the residue.
 */
function toTextLine(
  line: TessLine,
  scale: number,
  pageHeightPt: number,
  minConfidence: number,
): TextLine | undefined {
  const bbox = normalizeBbox(line.bbox)
  if (bbox === undefined) return undefined

  const text = cleanupCjkSpacing(lineText(line))
  if (text.length === 0) return undefined

  const rect: PdfRect = deviceRectToPdf(bbox, scale, pageHeightPt)
  if (!(rect.width > 0) || !(rect.height > 0)) return undefined

  const confidence = finiteNumber(line.confidence) ?? 0
  if (confidence < minConfidence) return undefined

  // Baseline: tesseract's `baseline.y0` is the ink baseline row in device
  // pixels. Fall back to the box's device BOTTOM edge (y1), which is where a
  // baseline sits when the renderer gave us nothing better.
  const baseline = normalizeBbox(line.baseline)
  const useBaseline = baseline !== undefined && baseline.y0 > 0
  const anchor = useBaseline
    ? deviceToPdf(baseline.x0, baseline.y0, pageHeightPt, scale)
    : deviceToPdf(bbox.x0, Math.max(bbox.y0, bbox.y1), pageHeightPt, scale)

  const run: TextRun = {
    text,
    x: rect.x, // The line's left edge, per the contract; not the ink start.
    y: anchor.y,
    size: Math.max(1, rect.height * SIZE_FROM_HEIGHT),
    width: rect.width,
  }
  return {
    runs: [run],
    rect,
    text,
    confidence,
    source: 'ocr',
  }
}

/* ------------------------------------------------------------------ *
 * Page recognition
 * ------------------------------------------------------------------ */

/** Walk `blocks → paragraphs → lines` and assemble one page's result. */
function buildPageResult(
  pageNumber: number,
  data: TessResult,
  elapsedMs: number,
  scale: number,
  pageHeightPt: number,
  minConfidence: number,
): OcrPageResult {
  const blocks = asArray<TessBlock>(data.blocks)
  const lines: TextLine[] = []
  let rawLines = 0
  for (const block of blocks) {
    for (const paragraph of asArray<TessParagraph>(block.paragraphs)) {
      for (const line of asArray<TessLine>(paragraph.lines)) {
        rawLines += 1
        const converted = toTextLine(line, scale, pageHeightPt, minConfidence)
        if (converted !== undefined) lines.push(converted)
      }
    }
  }

  const notes: string[] = []
  // Mean of the *returned* lines: once `minConfidence` has removed garbage,
  // averaging the garbage back in would understate the page.
  const confidence = lines.length === 0
    ? 0
    : Math.round(
      (lines.reduce((sum, line) => sum + (line.confidence ?? 0), 0) / lines.length) * 100,
    ) / 100

  if (lines.length === 0) {
    notes.push('no text detected')
    if (rawLines > 0) {
      notes.push(
        `page ${pageNumber}: all ${rawLines} detected lines were dropped `
        + `(empty text, zero-size box, or confidence below ${minConfidence})`,
      )
    }
  } else if (confidence < LOW_CONFIDENCE) {
    notes.push(
      `page ${pageNumber}: low mean OCR confidence ${confidence.toFixed(1)} `
      + `(below ${LOW_CONFIDENCE}) — text may contain recognition errors`,
    )
  }

  return { page: pageNumber, lines, confidence, elapsedMs, notes }
}

/**
 * Render + recognise one page with an existing worker.
 *
 * `elapsedMs` measures the recognise call only (rendering is pdf.js work, not
 * OCR work and would otherwise hide the OCR cost). The page proxy is always
 * cleaned up, worker ownership stays with the caller.
 */
async function recognizePage(
  worker: TesseractWorker,
  doc: PdfDocumentLike,
  pageNumber: number,
  options: ResolvedOptions,
): Promise<OcrPageResult> {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError(`ocr: page number must be a positive integer, got ${pageNumber}`)
  }
  if (typeof doc.numPages === 'number' && pageNumber > doc.numPages) {
    throw new RangeError(`ocr: page ${pageNumber} is out of range (document has ${doc.numPages})`)
  }

  const page = await doc.getPage(pageNumber)
  try {
    const rendered = await renderPage(page, options.scale)
    const started = Date.now()
    // The third argument is load-bearing: without `{ blocks: true }`
    // tesseract.js returns a flat string and `data.blocks` stays null.
    const { data } = await worker.recognize(
      rendered.png,
      {},
      { text: true, blocks: true },
    )
    const elapsedMs = Date.now() - started
    const result = buildPageResult(
      pageNumber,
      data,
      elapsedMs,
      options.scale,
      rendered.pageHeightPt,
      options.minConfidence,
    )
    options.onPage?.(result)
    return result
  } finally {
    page.cleanup?.()
  }
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * OCR a single page with a private, short-lived worker.
 *
 * Convenient for one page; for two or more pages use {@link createOcrSession},
 * which pays the ~300 ms worker + language startup once instead of per page.
 *
 * @param doc - An open pdf.js document (borrowed, not destroyed), a filesystem
 *   path, or PDF bytes. Paths/bytes are opened and released here.
 * @param pageNumber - 1-based page number.
 * @param options - See {@link OcrOptions}.
 * @returns The page's lines in PDF points, its mean confidence and timing.
 *   A page with no detected text resolves with `lines: []`,
 *   `confidence: 0`, `notes: ['no text detected']` — it never throws for that.
 */
export async function ocrPage(
  doc: unknown,
  pageNumber: number,
  options: OcrOptions = {},
): Promise<OcrPageResult> {
  const resolved = resolveOptions(options)
  const source = await openDocumentSource(doc)
  let worker: TesseractWorker | undefined
  try {
    worker = await createTesseractWorker(resolved)
    return await recognizePage(worker, source.doc, pageNumber, resolved)
  } finally {
    // try/finally on both resources: a recognise failure (or a throwing
    // `onPage`) must not leave a wasm worker or a document behind.
    await safeTerminate(worker)
    await source.release()
  }
}

/**
 * Create a reusable OCR session: one tesseract worker, many pages.
 *
 * The worker is built exactly once, so per-page cost is recognition only. The
 * document is supplied either here (`options.doc` / `options.sourcePath`) or
 * per call (`run(page, doc)`); a document passed as a path is opened once and
 * released by `dispose()`, while a caller-owned document is never destroyed.
 * Always call `dispose()` — it terminates the worker thread.
 *
 * @param options - See {@link OcrOptions}.
 * @returns `run` (one page), `runAll` (pages in order), `dispose` (teardown).
 */
export async function createOcrSession(options: OcrOptions = {}): Promise<{
  run(pageNumber: number, doc?: unknown): Promise<OcrPageResult>
  runAll(pages: number[]): Promise<OcrPageResult[]>
  dispose(): Promise<void>
}> {
  const resolved = resolveOptions(options)

  let owned: ResolvedDocument | undefined
  const initialSource = resolved.doc ?? resolved.sourcePath
  if (initialSource !== undefined) owned = await openDocumentSource(initialSource)

  let worker: TesseractWorker
  try {
    worker = await createTesseractWorker(resolved)
  } catch (error) {
    // The worker never came up; release anything we opened before rethrowing.
    await owned?.release()
    throw error
  }

  let disposed = false

  const run = async (pageNumber: number, doc?: unknown): Promise<OcrPageResult> => {
    if (disposed) throw new Error('createOcrSession: session already disposed')
    let perCall: ResolvedDocument | undefined
    try {
      perCall = doc !== undefined ? await openDocumentSource(doc) : undefined
      const target = perCall ?? owned
      if (target === undefined) {
        throw new Error(
          'createOcrSession: no document — pass one via options.doc, '
          + 'options.sourcePath, or run(pageNumber, doc)',
        )
      }
      return await recognizePage(worker, target.doc, pageNumber, resolved)
    } finally {
      // Only a document opened *for this call* is released here; the session's
      // own document lives until dispose().
      if (perCall !== undefined) await perCall.release()
    }
  }

  const runAll = async (pages: number[]): Promise<OcrPageResult[]> => {
    const out: OcrPageResult[] = []
    for (const pageNumber of pages) out.push(await run(pageNumber))
    return out
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await safeTerminate(worker)
    await owned?.release()
    owned = undefined
  }

  return { run, runAll, dispose }
}
