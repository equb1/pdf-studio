/**
 * pdf.js loading seam.
 *
 * pdf.js is a native/CJS-flavoured package whose worker path differs between
 * Node and the browser, and whose Node usage needs an explicit workerSrc or it
 * silently degrades. Centralising the load keeps every caller on one
 * configuration — the alternative is each module inventing its own and
 * disagreeing about what a page looks like.
 *
 * @module dsh-pdf-studio/core/pdf
 */

import { createRequire } from 'node:module'
import { PDFDocument } from 'pdf-lib'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** The subset of a pdf.js document this pipeline relies on. */
export interface PdfDoc {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPage>
  /**
   * Release the document.
   *
   * Verified on pdfjs-dist 6.2.108: `PDFDocumentProxy` has NO `destroy` method
   * — calling it throws `doc.destroy is not a function`. The teardown hook
   * lives on `loadingTask`. `openPdf` therefore normalises both shapes behind
   * this one name so callers cannot get it wrong, and so a caller that writes
   * `doc.destroy?.()` does not silently leak the document and its worker.
   */
  dispose(): Promise<void>
  /** Kept for callers that reach for the raw loader handle. */
  loadingTask?: { destroy?: () => Promise<void> }
}

/** The subset of a pdf.js page this pipeline relies on. */
export interface PdfPage {
  getViewport(params: { scale: number }): { width: number; height: number }
  getTextContent(): Promise<{ items: unknown[] }>
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>
  render(params: { canvasContext: unknown; viewport: unknown }): { promise: Promise<void> }
  objs?: { get(name: string, callback: (value: unknown) => void): void }
  cleanup?(): void
}

/** Diagnostic descriptor for a page's size. */
export interface PageSize {
  width: number
  height: number
}

let pdfjsPromise: Promise<Record<string, unknown>> | undefined

/**
 * Import the legacy pdf.js build once per process and pin its worker to the
 * file that actually runs under Node.
 *
 * The legacy build is required: the modern build assumes browser globals that
 * Node 26 does not provide for rendering.
 */
async function loadPdfjs(): Promise<Record<string, unknown>> {
  if (pdfjsPromise === undefined) {
    pdfjsPromise = (async () => {
      const entry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
      const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
      const worker = join(dirname(entry), 'pdf.worker.mjs')
      if (existsSync(worker)) {
        const options = mod.GlobalWorkerOptions as { workerSrc?: string } | undefined
        if (options !== undefined) options.workerSrc = worker
      }
      // Locate the package's asset directories by walking UP from the build we
      // actually loaded, rather than assuming a fixed depth. `standard_fonts`
      // and `cmaps` sit at the package root while the entry point is nested two
      // levels below it, and hard-coding that offset is how the first attempt
      // silently pointed at a directory that does not exist.
      let dir = dirname(entry)
      for (let up = 0; up < 4; up += 1) {
        if (existsSync(join(dir, 'standard_fonts')) || existsSync(join(dir, 'cmaps'))) break
        const parent = resolve(dir, '..')
        if (parent === dir) break
        dir = parent
      }
      for (const name of ['standard_fonts', 'cmaps']) {
        const candidate = join(dir, name)
        if (existsSync(candidate)) pdfjsAssets[name] = candidate
      }
      return mod
    })()
  }
  return pdfjsPromise
}

/**
 * pdf.js asset directories shipped with the package, resolved on first load.
 *
 * `standard_fonts` supplies the 14 standard faces for documents that do not
 * embed them, and `cmaps` supplies the predefined CJK encodings. Both are
 * needed for correct RENDERING — this pipeline renders pages for the preview and
 * the editor canvas, so a missing face is visible, not merely a metric drift.
 */
const pdfjsAssets: Record<string, string> = {}

/** Open a PDF from a file path. The caller owns `dispose()`. */
export async function openPdf(path: string): Promise<PdfDoc> {
  const bytes = await readFile(path)
  return openPdfBytes(new Uint8Array(bytes))
}

/**
 * Open a PDF already held in memory. The caller owns `dispose()`.
 *
 * The returned object is a thin wrapper, not the raw pdf.js proxy: it adds a
 * uniform `dispose()` so callers never have to know whether this pdf.js build
 * tears down through the proxy or the loading task.
 */
export async function openPdfBytes(bytes: Uint8Array): Promise<PdfDoc> {
  const pdfjs = await loadPdfjs()
  const getDocument = pdfjs.getDocument as (params: Record<string, unknown>) => {
    promise: Promise<Omit<PdfDoc, 'dispose'> & { destroy?: () => Promise<void> }>
  }
  // Supply pdf.js's own font and CMap data. Without `standardFontDataUrl` a
  // document using a non-embedded standard font still renders, but through a
  // substitute face, and pdf.js logs an UnknownError for every such font;
  // without `cMapUrl` a CJK document relying on a predefined CMap can lose
  // glyphs entirely. Both directories ship with the package, so pointing at
  // them costs nothing and removes a whole class of quiet rendering drift.
  const standardFontDataUrl = pdfjsAssets.standard_fonts
  const cMapUrl = pdfjsAssets.cmaps
  const task = getDocument({
    data: bytes,
    useSystemFonts: false,
    isEvalSupported: false,
    ...(standardFontDataUrl === undefined ? {} : { standardFontDataUrl: standardFontDataUrl + sep }),
    ...(cMapUrl === undefined ? {} : { cMapUrl: cMapUrl + sep, cMapPacked: true }),
  })
  const raw = await task.promise
  return {
    get numPages() {
      return raw.numPages
    },
    getPage: (pageNumber: number) => raw.getPage(pageNumber),
    loadingTask: task as unknown as { destroy?: () => Promise<void> },
    async dispose() {
      // Prefer the proxy's own teardown when a build provides one, else fall
      // back to the loading task, which is what 6.2.108 actually offers.
      const direct = (raw as { destroy?: () => Promise<void> }).destroy
      if (typeof direct === 'function') {
        await direct.call(raw)
        return
      }
      const viaTask = (task as unknown as { destroy?: () => Promise<void> }).destroy
      if (typeof viaTask === 'function') await viaTask.call(task)
    },
  }
}

/** Page size in PDF points at scale 1. */
export async function pageSize(doc: PdfDoc, pageNumber: number): Promise<PageSize> {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  return { width: viewport.width, height: viewport.height }
}

/** Every page's size, in order. */
export async function allPageSizes(doc: PdfDoc): Promise<PageSize[]> {
  const out: PageSize[] = []
  for (let page = 1; page <= doc.numPages; page += 1) out.push(await pageSize(doc, page))
  return out
}

/** pdf.js operator name for an opcode, or the opcode itself when unknown. */
export async function opNames(fnArray: readonly number[]): Promise<string[]> {
  const pdfjs = await loadPdfjs()
  const ops = pdfjs.OPS as Record<string, number>
  const byCode = new Map<number, string>()
  for (const [name, code] of Object.entries(ops)) {
    if (!byCode.has(code)) byCode.set(code, name)
  }
  return fnArray.map(code => byCode.get(code) ?? 'op:' + String(code))
}

/** 为写盘而载入：把"文件带 /Encrypt"翻译成可执行的中文提示（所有写盘路径统一走这里）。 */
export async function loadPdfForWrite(
  bytes: Uint8Array,
  options: { updateMetadata?: boolean } = {},
): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, options as never)
  } catch (error) {
    if (/encrypt/i.test(String((error as Error | undefined)?.message ?? ''))) {
      throw new Error(
        '这份 PDF 带加密（/Encrypt），pdf-lib 无法直接改写它。请先 `pdf_protect action=decrypt` 解除保护'
        + '（对"无需密码即可打开、仅权限受限"的文件，password 留空即可），或改用已解密的副本。')
    }
    throw error
  }
}
