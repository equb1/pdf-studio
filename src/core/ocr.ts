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
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deviceRectToPdf, deviceToPdf } from './coords.ts'
import type { OcrPageResult, PdfRect, PixelRect, TextLine, TextRun } from './contracts.ts'

const require = createRequire(import.meta.url)

/** The slice of `@napi-rs/canvas` this module uses. */
type CreateCanvas = (width: number, height: number) => {
  getContext(type: '2d'): unknown
  toBuffer(mime: 'image/png'): Buffer
}

let cachedCreateCanvas: CreateCanvas | undefined

/**
 * Load `@napi-rs/canvas` on first use.
 *
 * Deliberately NOT a static import: a module-scope import makes the failure of
 * one optional native binding take down every consumer of this file — including
 * the whole host plugin on a machine where the prebuilt binary cannot be loaded
 * (macOS refuses a binary signed by a different team than the Node process). OCR
 * is the only thing here that needs a rasteriser, so the requirement is enforced
 * where it is actually used.
 */
function loadCreateCanvas(): CreateCanvas {
  if (cachedCreateCanvas !== undefined) return cachedCreateCanvas
  try {
    const module = require('@napi-rs/canvas') as { createCanvas: CreateCanvas }
    cachedCreateCanvas = module.createCanvas
  } catch (error) {
    throw new Error(
      'OCR 需要 @napi-rs/canvas，但本机无法加载它的原生绑定：'
      + `${(error as Error | undefined)?.message ?? String(error)}。`
      + '请安装可用的 canvas 绑定，或不要对扫描页使用 OCR。',
    )
  }
  return cachedCreateCanvas
}

/**
 * Language data directory: **fallback** only.
 *
 * 这个绝对路径指向的是**另一个项目**（dsh-pdf-maker）的资源目录，不是本插件的目录，
 * 别人机器上必然不存在。所以它只是兜底，优先级是：
 *   1. 调用方显式传的 `langPath`（profile 配置 `tessdataPath` 会走到这里）；
 *   2. 环境变量 `DSH_PDF_STUDIO_TESSDATA`；
 *   3. 这个兜底路径。
 */
// 兜底语言数据目录：随【插件自身安装位置】解析，而不是写死某个人的家目录 ✓
// 优先级仍是 配置 tessdataPath > 环境变量 DSH_PDF_STUDIO_TESSDATA > 这个兜底 ✓
export const DEFAULT_LANG_PATH = fileURLToPath(new URL('../../assets/tessdata', import.meta.url))

/** 解析实际要用的语言数据目录（显式 > 环境变量 > 兜底）。 */
export function resolveLangPath(explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()
  const fromEnv = process.env.DSH_PDF_STUDIO_TESSDATA
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : DEFAULT_LANG_PATH
}

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
  /**
   * Directory holding `<lang>.traineddata[.gz]`.
   * Default {@link resolveLangPath}：显式值 > `DSH_PDF_STUDIO_TESSDATA` > {@link DEFAULT_LANG_PATH}。
   */
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

/** 语言文件的两种形式。 */
type LangForm = 'gz' | 'raw'

/** 语言数据检查结果。 */
export interface OcrLanguageStatus {
  /** 请求的语言（按 `+` 拆开）。 */
  requested: string[]
  /** 在选定模式下**确实可用**的语言（这才是能交给 tesseract 的列表）。 */
  available: string[]
  /** 会被丢掉的语言。 */
  missing: string[]
  /**
   * 每个缺失语言缺的是哪种形式，便于排查"为什么退化"。
   * `has` 是它在目录里实际有的形式（可能两种都有）。
   */
  missingForms: Array<{ lang: string; want: LangForm; has: LangForm[] }>
  /**
   * 实际要用的模式：`true` = tesseract 会去找 `<lang>.traineddata.gz`。
   *
   * 注意这是**全局**开关（tesseract 的 `gzip` 参数只有一个），所以必须按同一个模式
   * 逐语言检查存在性——早先的实现在混装目录上只看**第一个**语言就定了全局模式，
   * 结果 `chi_sim` 有 `.gz`、`eng` 只有裸文件时去找 `eng.traineddata.gz`，
   * worker 抛未捕获异常把宿主进程打崩。
   */
  gzip: boolean
  /** 是否为"混装"（不同语言只有不同形式）。 */
  mixed: boolean
  /** 按优先级解析出来的目录（显式 > DSH_PDF_STUDIO_TESSDATA > 兜底）。 */
  langPath: string
}

/** `<lang>.traineddata[.gz]` 在 `langPath` 里的存在情况。 */
function probeLangForm(langPath: string, lang: string): { gz: boolean; raw: boolean } {
  return {
    gz: existsSync(join(langPath, `${lang}.traineddata.gz`)),
    raw: existsSync(join(langPath, `${lang}.traineddata`)),
  }
}

/**
 * 检查请求的 OCR 语言在 `langPath` 里有没有装，并**定下 gzip 模式**。
 *
 * 为什么需要它（不是多余的检查）：tesseract.js 在语言文件缺失时**不是**抛一个可以捕获的 rejection，
 * 而是通过 worker 的 `error` 事件抛出**未捕获异常**——直接把宿主进程打崩。实测两种踩法：
 *
 *     # ① 语言完全没装
 *     Error: ENOENT: no such file or directory, open '…/tessdata/eng.traineddata.gz'
 *     # ② 混装目录（chi_sim 有 .gz、eng 只有裸文件），全局 gzip 由第一个语言决定
 *     Error: ENOENT: no such file or directory, open '…/tessdata/eng.traineddata.gz'
 *         at Worker.<anonymous> (tesseract.js/src/createWorker.js:217:15)
 *     node:internal/event_target:1118
 *         process.nextTick(() => { throw err; });
 *
 * 连 `try/catch` 都接不住（异常抛在 worker 线程的事件回调里）。所以必须在创建 worker **之前**
 * 按选定的 gzip 模式**逐语言**核对：不匹配的语言退化为 missing（由调用方写明并降级），
 * 一个都不剩时给中文错误。
 *
 * 模式选择：所有请求语言都有 `.gz` → gzip；否则所有都有裸文件 → 非 gzip；
 * 都不满足（真混装）→ 取覆盖面更大的那一种（并列时按 tesseract 上游默认选 gzip），
 * 缺该形式的语言进 `missing`。
 */
export function inspectLanguageData(requested: string, langPath: string = resolveLangPath()): OcrLanguageStatus {
  const dir = resolveLangPath(langPath)
  const wanted = String(requested ?? '')
    .split('+')
    .map(item => item.trim())
    .filter(item => item !== '')
  const forms = new Map<string, { gz: boolean; raw: boolean }>(
    wanted.map(one => [one, probeLangForm(dir, one)]),
  )
  const gzCount = wanted.filter(one => forms.get(one)?.gz === true).length
  const rawCount = wanted.filter(one => forms.get(one)?.raw === true).length
  const allGz = wanted.length > 0 && gzCount === wanted.length
  const allRaw = wanted.length > 0 && rawCount === wanted.length
  const gzip = allGz ? true : allRaw ? false : gzCount >= rawCount
  const want: LangForm = gzip ? 'gz' : 'raw'
  const available = wanted.filter(one => forms.get(one)?.[want] === true)
  const missing = wanted.filter(one => !available.includes(one))
  const missingForms = missing.map(one => {
    const form = forms.get(one) ?? { gz: false, raw: false }
    const has: LangForm[] = []
    if (form.gz) has.push('gz')
    if (form.raw) has.push('raw')
    return { lang: one, want, has }
  })
  return {
    requested: wanted,
    available,
    missing,
    missingForms,
    gzip,
    mixed: !allGz && !allRaw && wanted.length > 1,
    langPath: dir,
  }
}

/** 中文描述某个语言为什么不可用（给用户看的排查信息）。 */
export function describeMissingLanguage(entry: { lang: string; want: LangForm; has: LangForm[] }): string {
  if (entry.has.length === 0) return `${entry.lang} 未安装`
  if (entry.want === 'gz' && entry.has.includes('raw')) return `${entry.lang} 只有裸文件 .traineddata、当前需要 .gz`
  if (entry.want === 'raw' && entry.has.includes('gz')) return `${entry.lang} 只有 .gz、当前需要裸文件 .traineddata`
  return `${entry.lang} 的 language data 形式不匹配（需要 ${entry.want}）`
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
  /** tesseract 的 `gzip` 开关：由 {@link inspectLanguageData} 按目录内容定下，不在这里现猜。 */
  gzip: boolean
  corePath?: string
  minConfidence: number
  onPage?: (result: OcrPageResult) => void
  doc?: unknown
  sourcePath?: string
}

function resolveOptions(options: OcrOptions): ResolvedOptions {
  const scale = options.scale ?? DEFAULT_SCALE
  const langPath = resolveLangPath(options.langPath)
  const requestedLang = options.lang ?? DEFAULT_LANG
  // 兜底一层：即使调用方没做预检，这里也按选定模式逐语言降级，绝不把目录里不存在的
  // `<lang>.traineddata[.gz]` 交给 tesseract（那样是 worker 未捕获异常 → 打崩进程）。
  const status = inspectLanguageData(requestedLang, langPath)
  const lang = status.available.length > 0 ? status.available.join('+') : requestedLang
  const resolved: ResolvedOptions = {
    scale: scale > 0 ? scale : DEFAULT_SCALE,
    lang,
    langPath,
    gzip: status.gzip,
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
    // 用预检定下的模式（`options.gzip`），绝不在这里按"第一个语言"现猜：
    // 混装目录上现猜会让 tesseract 去找不存在的 `<lang>.traineddata.gz` → worker 未捕获异常 → 进程崩。
    gzip: options.gzip,
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
  const canvas = loadCreateCanvas()(viewport.width, viewport.height)
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
