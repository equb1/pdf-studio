/**
 * Pipeline orchestration — the glue between triage, extraction, OCR and the
 * searchable-PDF writer.
 *
 * Each stage is independently testable and speaks only the contracts in
 * `core/contracts.ts`; this module is the one place that knows the ORDER and
 * the routing rule. Keeping that policy here (rather than inside any stage)
 * is what lets a stage be replaced without re-deciding how pages flow.
 *
 * Routing rule (from `core/triage`):
 *   text  -> text layer, exact, no OCR
 *   mixed -> text layer wins; the page already carries real text
 *   image -> OCR
 *   empty -> nothing
 *
 * @module dsh-pdf-studio/host/engine
 */

import { readFile, writeFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import { openPdf, pageSize, type PdfDoc } from '../core/pdf.ts'
import {
  listReadableRuns,
  readPageContentStreams,
  replacePageText,
  type ReadableRun,
} from '../core/text-editor.ts'
import { readPageFonts } from '../core/font-map.ts'
import {
  addWatermark,
  removeWatermarks,
  scanWatermarks,
  type WatermarkCandidate,
  type WatermarkSpec,
} from '../core/watermark.ts'
import {
  decryptPdf,
  encryptPdf,
  inspectEncryption,
  type EncryptOptions,
} from '../core/qpdf.ts'
import { triageDocument } from '../core/triage.ts'
import { extractPageContent } from '../core/text-layer.ts'
import { createOcrSession } from '../core/ocr.ts'
import { buildSearchablePdf } from '../core/searchable-pdf.ts'
import type {
  ExtractOptions,
  PageContent,
  PageKind,
  PageTriage,
  SearchablePdfResult,
} from '../core/contracts.ts'

/** A finished analysis of one document. */
export interface AnalysisResult {
  sourcePath: string
  pages: number
  kinds: PageKind[]
  triage: PageTriage[]
  content: PageContent[]
  /** Wall-clock milliseconds for the whole analysis. */
  elapsedMs: number
  notes: string[]
}

/** How many lines each page contributed, for a compact UI summary. */
export function lineSummary(content: readonly PageContent[]): Array<{ page: number; kind: PageKind; lines: number }> {
  return content.map(page => ({ page: page.page, kind: page.kind, lines: page.lines.length }))
}

/**
 * Read every page of a document into the unified content model.
 *
 * Pages classified `image` are OCR'd; everything with a trusted text layer is
 * read straight from it. OCR is only paid for where it is actually needed, and
 * `skipTextLayerPages` allows an explicit override for pathological documents.
 */
export async function analyzeDocument(
  sourcePath: string,
  options: ExtractOptions = {},
): Promise<AnalysisResult> {
  const started = Date.now()
  const doc: PdfDoc = await openPdf(sourcePath)
  const notes: string[] = []
  try {
    const triage = await triageDocument(doc)
    const kinds = triage.map(t => t.kind)
    const scanned = triage.filter(t => t.kind === 'image').map(t => t.page)
    if (scanned.length > 0) {
      notes.push(`${scanned.length} 页需要 OCR：${scanned.join(', ')}`)
    }

    const content: PageContent[] = []
    // Text-bearing pages first: they are cheap and they let the caller render
    // something useful while a long OCR run is still going.
    for (const t of triage) {
      if (t.kind === 'image' || t.kind === 'empty') continue
      const page = await extractPageContent(doc, t.page)
      content.push({ ...page, kind: t.kind, width: t.width, height: t.height })
    }

    if (scanned.length > 0 && options.skipTextLayerPages !== false) {
      // The document is already open and borrowed here, so it is handed to the
      // session rather than reopened: one parse, one worker, and `dispose()`
      // below must not release a document this function still owns.
      const session = await createOcrSession({ ...options, doc })
      try {
        let done = 0
        for (const pageNumber of scanned) {
          const ocr = await session.run(pageNumber)
          const t = triage[pageNumber - 1]
          content.push({
            page: pageNumber,
            width: t.width,
            height: t.height,
            kind: 'image',
            lines: ocr.lines,
            notes: ocr.notes,
          })
          done += 1
          options.onProgress?.(done, scanned.length)
        }
      } finally {
        await session.dispose()
      }
    }

    content.sort((a, b) => a.page - b.page)
    return {
      sourcePath,
      pages: doc.numPages,
      kinds,
      triage,
      content,
      elapsedMs: Date.now() - started,
      notes,
    }
  } finally {
    await doc.dispose()
  }
}

/** Build a searchable PDF from an analysis, writing it beside or over the source. */
export async function exportSearchable(
  analysis: AnalysisResult,
  outputPath: string,
  mode: 'invisible' | 'cover' = 'invisible',
): Promise<SearchablePdfResult> {
  return buildSearchablePdf({
    sourcePath: analysis.sourcePath,
    outputPath,
    pages: analysis.content.map(page => ({ page: page.page, lines: page.lines })),
    mode,
  })
}

/* -------------------------------------------------------------------------- */
/* the editable model, as the UI consumes it                                  */
/* -------------------------------------------------------------------------- */

/** One page's editable text runs, decoded. */
export interface EditablePage {
  page: number
  width: number
  height: number
  runs: ReadableRun[]
  /** Fonts whose codes could not be decoded, so the UI can explain gaps. */
  undecodableFonts: string[]
}

/** The whole document's editable model. */
export interface EditableDocument {
  sourcePath: string
  pages: number
  content: EditablePage[]
  notes: string[]
}

/**
 * Build the editable model for a document.
 *
 * This is the read half of "edit like Acrobat": every run carries a stable id,
 * its decoded text, its font and size, its baseline and its measured width.
 * `replacePageText` then addresses the same ids, so the model a canvas renders
 * and the model an edit mutates are the same one.
 *
 * Runs whose font has no usable `ToUnicode` are still listed — with
 * `textUnavailable` set — because they are real content the user may want to
 * see positioned, and silently dropping them would misrepresent the page.
 */
export async function readEditableDocument(sourcePath: string): Promise<EditableDocument> {
  const doc = await openPdf(sourcePath)
  const notes: string[] = []
  const content: EditablePage[] = []
  try {
    const pdfLibDoc = await PDFDocument.load(await readFile(sourcePath))
    const pdfLibPages = pdfLibDoc.getPages()

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const size = await pageSize(doc, pageNumber)
      const pdfLibPage = pdfLibPages[pageNumber - 1]
      if (pdfLibPage === undefined) {
        notes.push(`第 ${pageNumber} 页在 pdf-lib 视图中不存在，已跳过`)
        continue
      }

      const fonts = readPageFonts(pdfLibDoc.context as never, pdfLibPage as never)
      const streams = readPageContentStreams(pdfLibPage as never, pdfLibDoc.context as never)
      const runs = listReadableRuns(streams, fonts)

      const undecodable = [...fonts.values()]
        .filter(info => info.decoder === undefined)
        .map(info => info.resourceName)
      if (undecodable.length > 0) {
        notes.push(`第 ${pageNumber} 页有 ${undecodable.length} 个字体缺少 ToUnicode，这些文字无法解码`)
      }

      content.push({
        page: pageNumber,
        width: size.width,
        height: size.height,
        runs,
        undecodableFonts: undecodable,
      })
    }
  } finally {
    await doc.dispose()
  }

  return { sourcePath, pages: doc.numPages, content, notes }
}

/**
 * Apply text replacements to a document and write the result.
 *
 * Source and destination are separate on purpose: an edit never overwrites the
 * file it read, which is the same guarantee the rest of this pipeline holds.
 */
export async function applyTextEdits(
  sourcePath: string,
  outputPath: string,
  edits: Array<{ page: number; targetId: string; to: string; fontSize?: number }>,
  options: { fonts?: { path?: string } } = {},
): Promise<{ outputPath: string; pages: number; applied: number; notes: string[] }> {
  const doc = await PDFDocument.load(await readFile(sourcePath))
  const pages = doc.getPages()
  const notes: string[] = []
  let applied = 0

  const byPage = new Map<number, typeof edits>()
  for (const edit of edits) {
    const list = byPage.get(edit.page) ?? []
    list.push(edit)
    byPage.set(edit.page, list)
  }

  for (const [pageNumber, pageEdits] of byPage) {
    const page = pages[pageNumber - 1]
    if (page === undefined) {
      notes.push(`第 ${pageNumber} 页不存在，${pageEdits.length} 处编辑已跳过`)
      continue
    }
    const result = await replacePageText(
      doc as never,
      page as never,
      pageEdits.map(edit => ({
        targetId: edit.targetId,
        to: edit.to,
        ...(edit.fontSize === undefined ? {} : { fontSize: edit.fontSize }),
      })),
      { context: doc.context as never, ...(options.fonts === undefined ? {} : { fonts: options.fonts }) },
    )
    applied += result.replacementsApplied
    notes.push(...result.notes.map(note => `第 ${pageNumber} 页：${note}`))
  }

  const bytes = await doc.save()
  await writeFile(outputPath, bytes)
  return { outputPath, pages: doc.getPageCount(), applied, notes }
}


/* -------------------------------------------------------------------------- */
/* password protection                                                        */
/* -------------------------------------------------------------------------- */

/** Result of a protection change, written to disk. */
export interface ProtectResult {
  outputPath: string
  encrypted: boolean
  opensWithoutPassword: boolean
  bytes: number
  notes: string[]
}

/**
 * Encrypt a document or remove its encryption.
 *
 * The encryption itself is qpdf's job (see `core/qpdf`); this function owns the
 * file handling and the honesty requirements around it: it never overwrites the
 * source, it refuses to report success when the password was wrong, and it
 * re-inspects the produced file so the caller is told the state that actually
 * resulted rather than the state that was requested.
 */
export async function protectPdf(
  sourcePath: string,
  outputPath: string,
  action:
    | { kind: 'encrypt'; userPassword: string; ownerPassword?: string; allow?: EncryptOptions['allow'] }
    | { kind: 'decrypt'; password: string },
): Promise<ProtectResult> {
  const input = new Uint8Array(await readFile(sourcePath))
  const notes: string[] = []

  const run = action.kind === 'encrypt'
    ? await encryptPdf(input, {
        userPassword: action.userPassword,
        ...(action.ownerPassword === undefined ? {} : { ownerPassword: action.ownerPassword }),
        ...(action.allow === undefined ? {} : { allow: action.allow }),
      })
    : await decryptPdf(input, action.password)

  if (run.output !== '') notes.push(run.output)
  if (run.exit !== 0 || run.bytes === undefined) {
    // A failure must not leave a partial file behind for the user to open.
    throw new Error(
      action.kind === 'encrypt'
        ? `加密失败（qpdf 退出码 ${run.exit}）：${run.output || '无诊断信息'}`
        : `解密失败（qpdf 退出码 ${run.exit}）。密码不正确或文件未加密。`,
    )
  }

  await writeFile(outputPath, run.bytes)
  const state = await inspectEncryption(run.bytes)

  return {
    outputPath,
    encrypted: state.encrypted,
    opensWithoutPassword: state.opensWithoutPassword,
    bytes: run.bytes.byteLength,
    notes,
  }
}


/* -------------------------------------------------------------------------- */
/* watermarks                                                                 */
/* -------------------------------------------------------------------------- */

/** A page's watermark scan result, for the UI to display before acting. */
export interface WatermarkReport {
  sourcePath: string
  pages: number
  candidates: WatermarkCandidate[]
  refused: Array<{ page: number; detail: string }>
}

/** Scan a document for removable watermarks. */
export async function reportWatermarks(sourcePath: string): Promise<WatermarkReport> {
  const bytes = new Uint8Array(await readFile(sourcePath))
  const scan = await scanWatermarks(bytes)
  return {
    sourcePath,
    pages: scan.pages,
    candidates: scan.candidates,
    refused: scan.refused,
  }
}

/** Stamp a watermark and write the result to `outputPath`. */
export async function stampWatermark(
  sourcePath: string,
  outputPath: string,
  spec: WatermarkSpec,
): Promise<{ outputPath: string; pages: number; textDrawn: string; droppedChars: string[]; notes: string[] }> {
  const bytes = new Uint8Array(await readFile(sourcePath))
  const { bytes: out, result } = await addWatermark(bytes, spec)
  await writeFile(outputPath, out)
  return {
    outputPath,
    pages: result.pages,
    textDrawn: result.textDrawn,
    droppedChars: result.droppedChars,
    notes: result.notes,
  }
}

/**
 * Remove watermarks, optionally writing the result.
 *
 * The return type is a discriminated union on `dryRun`, so a caller cannot read
 * `outputPath` from a dry run at all. An earlier version made the path optional
 * in both cases, which let a caller compile against a field that was not there
 * and fail at runtime — the type should have made that impossible.
 *
 * `dryRun` defaults to TRUE: removal is destructive and the candidate list
 * contains guesses, so the safe direction is the default and a caller must ask
 * explicitly before anything is written.
 */
export async function stripWatermarks(
  sourcePath: string,
  outputPath: string,
  options: { minConfidence?: number; dryRun?: boolean; all?: boolean } = {},
): Promise<
  | { dryRun: true; removed: WatermarkCandidate[]; skipped: WatermarkCandidate[]; notes: string[] }
  | { dryRun: false; outputPath: string; removed: WatermarkCandidate[]; skipped: WatermarkCandidate[]; notes: string[] }
> {
  const bytes = new Uint8Array(await readFile(sourcePath))
  const dryRun = options.dryRun ?? true
  // `all` is the caller explicitly accepting heuristic removal; without it only
  // candidates the detector is sure about are touched.
  const minConfidence = options.all === true ? 0 : (options.minConfidence ?? 0.9)
  const result = await removeWatermarks(bytes, { minConfidence, dryRun })

  if (dryRun || result.removed.length === 0) {
    return { dryRun: true, removed: result.removed, skipped: result.skipped, notes: result.notes }
  }
  await writeFile(outputPath, result.bytes)
  return {
    dryRun: false,
    outputPath,
    removed: result.removed,
    skipped: result.skipped,
    notes: result.notes,
  }
}


/* -------------------------------------------------------------------------- */
/* document inspection (for the preview)                                      */
/* -------------------------------------------------------------------------- */

/** One page's geometry, as the preview needs it. */
export interface PageInfo {
  page: number
  width: number
  height: number
}

/** What the preview needs to lay out a document, computed cheaply. */
export interface DocumentInfo {
  sourcePath: string
  pages: number
  sizes: PageInfo[]
  /** Whether the document carries an /Encrypt dictionary. */
  encrypted: boolean
}

/**
 * Describe a document's pages without extracting anything.
 *
 * Deliberately NOT `analyzeDocument`: rendering a preview must not trigger OCR.
 * Analysis of a scanned document takes seconds per page, and a file picker that
 * makes you wait for OCR before showing page one is unusable. This reads page
 * geometry only.
 */
export async function inspectDocument(sourcePath: string): Promise<DocumentInfo> {
  const bytes = new Uint8Array(await readFile(sourcePath))
  // `ignoreEncryption` is required, not an optimisation: this function's job
  // includes REPORTING that a file is encrypted, and pdf-lib refuses to parse an
  // encrypted document otherwise. Without it, inspecting a protected file threw
  // instead of describing it — the one case the caller most needs an answer for.
  // Nothing here decrypts anything; it reads page geometry and the /Encrypt flag.
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const pages = doc.getPages()
  const sizes: PageInfo[] = pages.map((page, index) => {
    const { width, height } = page.getSize()
    return { page: index + 1, width, height }
  })
  const { hasEncryptDictionary } = await import('../core/qpdf.ts')
  return {
    sourcePath,
    pages: pages.length,
    sizes,
    encrypted: hasEncryptDictionary(bytes),
  }
}
