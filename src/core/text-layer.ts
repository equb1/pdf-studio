/**
 * Text-layer extraction: pdf.js text items → `TextLine[]` for one page.
 *
 * This is the "born-digital" half of the pipeline. It assumes nothing about
 * trustworthiness — a scan whose only text is an anti-copy fingerprint still
 * yields that one line here, and `triage` decides what to do with it. Keeping
 * the judgement out of this module is what lets the same code serve a real
 * contract page and a 6-page scan with a single 5pt fingerprint string.
 *
 * ## Coordinate space (read this before touching `transform`)
 *
 * The contract's authoritative space is PDF page space: points, origin
 * BOTTOM-LEFT, y growing UP.
 *
 * The task brief assumed pdf.js reports `TextItem.transform` in top-left
 * raster space, so that a device→PDF flip would be required. That is not what
 * the pdf.js build pinned in this repo (pdfjs-dist 6.2.108) does. Verified two
 * ways on `demo/source/contract.pdf`:
 *
 *   1. `PartialEvaluator.getCurrentTextTransform()` builds the item matrix as
 *      `Util.transform(ctm, textMatrix × tsm)` — the raw content stream's
 *      matrix, with no viewport transform applied. The page's `1 0 0 1 244.47
 *      761.89 Tm` comes back byte-identical as `transform[5] === 761.89`.
 *   2. Scoring both readings against the rendered page: treating `f` as a
 *      device (top-down) y hits 0 dark pixels across all 18 items; treating it
 *      as PDF (bottom-up) y hits 8783. The title really is 761.89pt up from
 *      the bottom of an 841.89pt page.
 *
 * So `(e, f)` is used AS the PDF baseline and no flip is applied. Running it
 * through `deviceToPdf()` would mirror the page: the contract title would land
 * at y=80 and the ceshi fingerprint at y=841.89 instead of y=0. This matches
 * `triage.ts`, which also reads `transform[4]/[5]` as PDF coordinates.
 *
 * The same reasoning means `item.height` (from the text state) is already in
 * points and needs no scaling.
 *
 * @module dsh-pdf-studio/core/text-layer
 */

import { unionRect } from './coords.ts'
import type { PageContent, PdfRect, TextLine, TextRun } from './contracts.ts'
import type { PdfDoc } from './pdf.ts'

/** Baseline distance within which two items count as the same visual line. */
const BASELINE_TOLERANCE_PT = 0.5

/**
 * A run's box is this many × its font size tall. pdf.js hands us a baseline,
 * not a box, so the ascent/descent slack has to be assumed; 1.2 keeps the
 * common case (ascender + descender) inside the rect without over-claiming.
 */
const LINE_BOX_FACTOR = 1.2

/**
 * Horizontal gap that justifies inventing a space, as a fraction of the
 * smaller of the two font sizes. pdf.js drops whitespace items from the text
 * stream freely, so the gap is often the only evidence a space was there.
 */
const SPACE_GAP_FACTOR = 0.25

/** Floor for the gap test, so 4pt text does not need a 1pt gap to get a space. */
const SPACE_GAP_MIN_PT = 0.5

/** The bare minimum of a pdf.js TextItem this module reads. */
interface RawTextItem {
  str?: unknown
  width?: unknown
  height?: unknown
  transform?: unknown
  fontName?: unknown
}

/** A text item reduced to numbers we trust. */
interface NormalisedItem {
  text: string
  x: number
  y: number
  size: number
  width?: number
  fontRef?: string
}

/** What one page's items produced. */
interface LinesResult {
  lines: TextLine[]
  /** Items dropped as malformed; surfaced in `PageContent.notes`. */
  skipped: number
}

/** Finite number, or undefined. Everything in this module guards with this. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Whether a char is a CJK ideograph in the contracted range. */
function isCjk(char: string): boolean {
  return char >= '\u4E00' && char <= '\u9FFF'
}

/**
 * Drop spaces that sit strictly between two CJK ideographs.
 *
 * pdf.js frequently emits CJK as one item per glyph and pads the stream with
 * real spaces between them ("服 务 合 同"), which would otherwise leak into
 * every extracted line. The lookahead keeps this idempotent and non-consuming,
 * and the CJK-on-both-sides condition is what stops it from touching latin
 * text, where a space is content rather than noise. NBSP and U+3000 are
 * included because PDF producers use them for the same padding.
 */
function stripCjkInnerSpaces(text: string): string {
  return text.replace(/([\u4E00-\u9FFF])[ \t\u00A0\u3000]+(?=[\u4E00-\u9FFF])/g, '$1')
}

/** Whether a char occupies a full em (CJK, kana, fullwidth forms, ideographic space). */
function isWide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (code >= 0x1100 && code <= 0x115F)
    || (code >= 0x2E80 && code <= 0xA4CF)
    || (code >= 0xAC00 && code <= 0xD7A3)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFE30 && code <= 0xFE6F)
    || (code >= 0xFF00 && code <= 0xFF60)
    || (code >= 0xFFE0 && code <= 0xFFE6)
}

/**
 * Estimate a run's advance when pdf.js gave no `width`. Deliberately crude:
 * it only has to be good enough for the space heuristic and for a fallback
 * rect on the rare item that omits `width`.
 */
function estimateAdvance(text: string, size: number): number {
  let advance = 0
  for (const char of text) advance += isWide(char) ? size : size * 0.5
  return advance
}

/** Normalise one raw pdf.js item, or `undefined` when it is unusable. */
function normaliseItem(entry: unknown): NormalisedItem | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const item = entry as RawTextItem
  if (typeof item.str !== 'string' || item.str === '') return undefined

  const transform = Array.isArray(item.transform) ? item.transform : undefined
  if (transform === undefined || transform.length < 6) return undefined
  const x = num(transform[4])
  const y = num(transform[5])
  // A NaN/absent origin carries no position at all — there is nothing to
  // recover from it, and guessing would place text on the wrong line.
  if (x === undefined || y === undefined) return undefined

  const reportedHeight = num(item.height)
  const scaleY = Math.hypot(num(transform[2]) ?? 0, num(transform[3]) ?? 0)
  let size = reportedHeight !== undefined && reportedHeight > 0 ? reportedHeight : scaleY
  if (!Number.isFinite(size) || size < 0) size = 0

  const width = num(item.width)
  const text = stripCjkInnerSpaces(item.str)
  if (text === '') return undefined

  const fontRef = typeof item.fontName === 'string' && item.fontName !== '' ? item.fontName : undefined
  return {
    text,
    x,
    y,
    size,
    ...(width !== undefined ? { width } : {}),
    ...(fontRef !== undefined ? { fontRef } : {}),
  }
}

/** Whether an item contributes nothing but whitespace. */
function isBlank(text: string): boolean {
  return text.trim() === ''
}

/**
 * Whether a rejected item was merely empty rather than malformed.
 *
 * pdf.js pads its item stream with empty and whitespace-only strings (three of
 * them on the demo contract). Those are normal, so they are dropped silently;
 * only items that are structurally broken deserve a warning in the notes.
 */
function isEmptyItem(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false
  const str = (entry as RawTextItem).str
  return typeof str === 'string' && str.trim() === ''
}

/** Right edge of a run, falling back to an estimated advance. */
function runRight(run: TextRun): number {
  return run.x + (run.width ?? estimateAdvance(run.text, run.size))
}

/**
 * Whether a space belongs between two adjacent runs.
 *
 * A gap wide enough to hold one is normally proof of a space, but CJK runs
 * sit flush against each other and are frequently emitted as separate items,
 * so a gap between two ideographs is layout, not punctuation.
 */
function needsSpace(previous: TextRun | undefined, next: TextRun): boolean {
  if (previous === undefined) return false
  const gap = next.x - runRight(previous)
  const sizes = [previous.size, next.size].filter(value => value > 0)
  const smallest = sizes.length > 0 ? Math.min(...sizes) : 0
  const threshold = Math.max(SPACE_GAP_MIN_PT, smallest * SPACE_GAP_FACTOR)
  if (!(gap > threshold)) return false
  const left = previous.text.slice(-1)
  const right = next.text.slice(0, 1)
  return !(isCjk(left) && isCjk(right))
}

/** Union box of a line's runs, each run contributing a `1.2 × size` tall box. */
function lineRect(runs: readonly TextRun[]): PdfRect {
  let rect: PdfRect | undefined
  for (const run of runs) {
    const width = run.width ?? estimateAdvance(run.text, run.size)
    rect = unionRect(rect, {
      x: run.x,
      y: run.y,
      width: Math.max(0, width),
      height: run.size * LINE_BOX_FACTOR,
    })
  }
  // Unreachable with a non-empty run list; keeps the return type honest.
  return rect ?? { x: 0, y: 0, width: 0, height: 0 }
}

/** Join a line's runs left-to-right, inserting the spaces pdf.js dropped. */
function joinRuns(runs: readonly TextRun[]): string {
  let text = ''
  let previous: TextRun | undefined
  for (const run of runs) {
    if (needsSpace(previous, run)) text += ' '
    text += run.text
    previous = run
  }
  // Bare whitespace items are skipped above, but a run may still carry its own
  // padding; a line that reads naturally should not start or end with it.
  return stripCjkInnerSpaces(text).trim()
}

/**
 * Turn raw pdf.js text items into visual lines.
 *
 * Items are sorted top-to-bottom (PDF y descending) and grouped while the
 * baseline stays within {@link BASELINE_TOLERANCE_PT}; sorting first means a
 * group is never split by a bucket boundary, which a naive `round(y / 0.5)`
 * map does whenever two items straddle a half-point edge.
 */
function buildLines(rawItems: readonly unknown[]): LinesResult {
  const items: NormalisedItem[] = []
  let skipped = 0
  for (const entry of rawItems) {
    const item = normaliseItem(entry)
    if (item !== undefined) items.push(item)
    else if (!isEmptyItem(entry)) skipped += 1
  }
  if (items.length === 0) return { lines: [], skipped }

  items.sort((a, b) => (b.y - a.y) || (a.x - b.x))

  const groups: NormalisedItem[][] = []
  let current: NormalisedItem[] = []
  let baseline = items[0]!.y
  for (const item of items) {
    if (current.length > 0 && Math.abs(item.y - baseline) > BASELINE_TOLERANCE_PT) {
      groups.push(current)
      current = []
      baseline = item.y
    }
    current.push(item)
  }
  if (current.length > 0) groups.push(current)

  const lines: TextLine[] = []
  for (const group of groups) {
    const runs: TextRun[] = []
    for (const item of group) {
      if (isBlank(item.text)) continue
      runs.push({
        text: item.text,
        x: item.x,
        y: item.y,
        size: item.size,
        ...(item.width !== undefined ? { width: item.width } : {}),
        ...(item.fontRef !== undefined ? { fontRef: item.fontRef } : {}),
      })
    }
    if (runs.length === 0) continue
    runs.sort((a, b) => a.x - b.x)
    // No `confidence`: text-layer text is exact, and the contract reserves the
    // field for OCR estimates. Leaving it undefined is the signal.
    lines.push({ runs, rect: lineRect(runs), text: joinRuns(runs), source: 'text-layer' })
  }
  return { lines, skipped }
}

/** Read page size and raw text items for one page, tolerating a broken layer. */
async function readPageText(
  doc: PdfDoc,
  pageNumber: number,
): Promise<{ width: number; height: number; rawItems: unknown[] }> {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent() as { items?: unknown } | undefined
  const rawItems = Array.isArray(content?.items) ? content.items : []
  return {
    width: num(viewport?.width) ?? 0,
    height: num(viewport?.height) ?? 0,
    rawItems,
  }
}

/**
 * Extract one page's text layer as visual lines in PDF coordinates.
 *
 * Reads only; the caller owns the document. A page with no text layer (a plain
 * scan) returns `[]` rather than throwing, because "no text here" is a normal
 * answer that routes the page to OCR. Individual malformed items are skipped
 * for the same reason — one bad item must not cost the page its other lines.
 *
 * @param doc - An open pdf.js document (see `PdfDoc`).
 * @param pageNumber - 1-based page number.
 * @returns Lines in reading order (top to bottom), runs left to right.
 */
export async function extractTextLayer(doc: PdfDoc, pageNumber: number): Promise<TextLine[]> {
  const { rawItems } = await readPageText(doc, pageNumber)
  return buildLines(rawItems).lines
}

/**
 * Extract everything later stages need from one page.
 *
 * `kind` is reported as `'text'` unconditionally: this module cannot know
 * whether a page is really digital, and triage — which also weighs images and
 * fingerprint-shaped text — is expected to overwrite it.
 *
 * @param doc - An open pdf.js document (see `PdfDoc`).
 * @param pageNumber - 1-based page number.
 * @returns Page size in points at scale 1, the extracted lines, and notes.
 */
export async function extractPageContent(doc: PdfDoc, pageNumber: number): Promise<PageContent> {
  const { width, height, rawItems } = await readPageText(doc, pageNumber)
  const { lines, skipped } = buildLines(rawItems)

  const notes: string[] = []
  if (lines.length === 0) {
    notes.push(`第 ${pageNumber} 页没有文本层内容（可能是纯扫描页，需走 OCR）`)
  }
  if (skipped > 0) {
    notes.push(`第 ${pageNumber} 页有 ${skipped} 个文本项格式异常，已跳过`)
  }

  return { page: pageNumber, width, height, kind: 'text', lines, notes }
}
