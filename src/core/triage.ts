/**
 * Per-page triage: decide how a page's content is stored before touching it.
 *
 * The naive rule — "the text layer is non-empty, so the page is digital" — is
 * wrong on real documents. A scanned page frequently carries an anti-copy
 * fingerprint or a watermark string: a handful of tiny characters parked at
 * the very edge of the page. Measured on a real 6-page scan (`ceshi.pdf`),
 * every page reported a text layer holding exactly one item,
 * `{#{QQAB...=}#}`, at y≈0 with a 5pt font — and nothing else. A chars>0 test
 * classifies that entire document as digital and then hands the user an empty
 * editor.
 *
 * So trust is judged on three signals together:
 *
 *   1. how MUCH usable text there is (characters, not items);
 *   2. WHERE it sits — text in the margin bands with a tiny font is
 *      fingerprint/watermark material, not body copy;
 *   3. how much of the page is painted with raster images.
 *
 * The verdict is advisory-but-authoritative: later stages obey it, and the
 * evidence is carried along so the UI can explain WHY a page went to OCR.
 *
 * @module dsh-pdf-studio/core/triage
 */

import { opNames, type PdfDoc } from './pdf.ts'
import type { PageKind, PageTriage, TriageEvidence } from './contracts.ts'

/** Tunables, exported so tests and callers can reason about the thresholds. */
export const TRIAGE_THRESHOLDS = {
  /**
   * Text sitting within this many points of an edge is treated as marginal.
   * Real body copy almost never starts inside a 24pt band.
   */
  marginBandPt: 24,
  /**
   * A run at or below this size, inside the margin band, is fingerprint-sized.
   * Body text is overwhelmingly ≥8pt.
   */
  fingerprintSizePt: 7,
  /** Characters of trusted body text needed to call a page `text`. */
  minTrustedChars: 40,
  /** Painted image area / page area above which the page counts as scanned. */
  scanCoverage: 0.5,
} as const

/** Minimal shape of a pdf.js text item this module reads. */
interface RawTextItem {
  str?: unknown
  width?: unknown
  height?: unknown
  transform?: unknown
}

/** One text item normalised for triage. */
interface TriageItem {
  text: string
  x: number
  y: number
  size: number
}

/** Read a finite number, else undefined. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Normalise raw pdf.js items, dropping anything malformed. */
function normaliseItems(raw: readonly unknown[]): TriageItem[] {
  const out: TriageItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as RawTextItem
    if (typeof item.str !== 'string' || item.str === '') continue
    const transform = Array.isArray(item.transform) ? item.transform : undefined
    if (transform === undefined || transform.length < 6) continue
    const x = num(transform[4])
    const y = num(transform[5])
    if (x === undefined || y === undefined) continue
    const height = num(item.height)
    const scaleY = Math.hypot(num(transform[2]) ?? 0, num(transform[3]) ?? 0)
    const size = height !== undefined && height > 0 ? height : scaleY
    out.push({ text: item.str, x, y, size: size > 0 ? size : 0 })
  }
  return out
}

/** Character count that ignores whitespace-only content. */
function meaningfulChars(text: string): number {
  let n = 0
  for (const char of text) if (!/\s/.test(char)) n += 1
  return n
}

/**
 * Classify one page.
 *
 * Pure with respect to the document: it only reads. Callers may run it across
 * every page to build a routing plan before any expensive work.
 */
export async function triagePage(doc: PdfDoc, pageNumber: number): Promise<PageTriage> {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const width = viewport.width
  const height = viewport.height

  const content = await page.getTextContent()
  const items = normaliseItems(content.items)
  const operators = await page.getOperatorList()
  const names = await opNames(operators.fnArray)

  let imageCount = 0
  for (const name of names) {
    if (name === 'paintImageXObject' || name === 'paintInlineImageXObject') imageCount += 1
  }
  // pdf.js does not hand out image dimensions synchronously, so an image
  // painted anywhere on an A4-ish page is treated as covering it. Scanned
  // pages are full-page images in practice; a small logo would only ever push
  // the page toward `mixed`, which is a safe verdict either way.
  const imageCoverage = imageCount > 0 ? 1 : 0

  const notes: string[] = []
  const band = TRIAGE_THRESHOLDS.marginBandPt
  let textChars = 0
  let trustedChars = 0
  let inBandChars = 0
  let tinyInBandChars = 0

  for (const item of items) {
    textChars += meaningfulChars(item.text)
    const chars = meaningfulChars(item.text)
    const nearEdge = item.y <= band || item.y >= height - band - item.size
      || item.x <= band || item.x >= width - band
    if (nearEdge) {
      inBandChars += chars
      if (item.size > 0 && item.size <= TRIAGE_THRESHOLDS.fingerprintSizePt) {
        tinyInBandChars += chars
        continue
      }
    }
    trustedChars += chars
  }

  const bodyTextRatio = textChars === 0 ? 0 : trustedChars / textChars
  if (tinyInBandChars > 0 && tinyInBandChars === inBandChars) {
    notes.push(
      `只检测到 ${tinyInBandChars} 个位于页边、字号极小的字符（防伪指纹或水印），不计入正文`,
    )
  }

  const hasTrustedText = trustedChars >= TRIAGE_THRESHOLDS.minTrustedChars
  const looksScanned = imageCount > 0 && imageCoverage >= TRIAGE_THRESHOLDS.scanCoverage

  let kind: PageKind
  if (hasTrustedText && looksScanned) {
    kind = 'mixed'
    notes.push('页面同时包含可信文本层与整页图像')
  } else if (hasTrustedText) {
    kind = 'text'
  } else if (imageCount > 0) {
    kind = 'image'
    if (textChars > 0) notes.push('仅有的文字层内容不可信，已改走 OCR')
  } else if (textChars > 0) {
    // Text exists but never passed the trust bar and there is no image to
    // OCR against. Reporting `text` here would promise an editable page that
    // has almost nothing on it, so it is surfaced as `empty` with the reason.
    kind = 'empty'
    notes.push(`文本层只有 ${textChars} 个不可信字符，且没有图像可识别`)
  } else {
    kind = 'empty'
    notes.push('页面既没有文本层也没有图像')
  }

  const evidence: TriageEvidence = {
    textChars,
    textItems: items.length,
    trustedChars,
    imageCount,
    imageCoverage,
    bodyTextRatio,
    notes,
  }

  return { page: pageNumber, kind, evidence, width, height }
}

/** Triage every page of a document, in order. */
export async function triageDocument(doc: PdfDoc): Promise<PageTriage[]> {
  const out: PageTriage[] = []
  for (let page = 1; page <= doc.numPages; page += 1) out.push(await triagePage(doc, page))
  return out
}

/** One-line human summary of a triage verdict, for logs and the UI. */
export function describeTriage(triage: PageTriage): string {
  const e = triage.evidence
  const kindLabel: Record<PageKind, string> = {
    text: '文本型',
    image: '图片型',
    mixed: '混合',
    empty: '空白',
  }
  return `第 ${triage.page} 页 ${kindLabel[triage.kind]}`
    + ` (可信文字 ${e.trustedChars}/${e.textChars}, 图像 ${e.imageCount}, 正文占比 ${(e.bodyTextRatio * 100).toFixed(0)}%)`
}
