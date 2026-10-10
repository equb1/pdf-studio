/**
 * Shared contract for the PDF Studio pipeline.
 *
 * Every module below operates on ONE page at a time and speaks only in these
 * types, so the stages can be developed, tested, and replaced independently.
 * The whole pipeline is:
 *
 *   loadPdf → triage(page) ─┬─ text  → extractTextLayer → TextLine[]
 *                           └─ image → ocrPage           → TextLine[]
 *                                                             ↓
 *                                             buildSearchablePdf / edit model
 *
 * Coordinate convention (single source of truth — do not deviate):
 *
 *   PDF space  : points, origin BOTTOM-LEFT, y grows upward.   (authoritative)
 *   raster px  : pixels, origin TOP-LEFT, y grows downward, at a given scale.
 *
 * Conversion lives in exactly one place (`core/coords.ts`); every module that
 * needs it imports it from there rather than re-deriving the flip.
 *
 * IMPORTANT — pdf.js text items are ALREADY in PDF space. Their
 * `transform[4]/[5]` is a user-space baseline (bottom-left, y up), verified
 * empirically by pixel-testing a rendered page. Raster conversion applies only
 * to bitmaps and to tesseract `bbox` output. See `core/coords.ts`.
 *
 * ## Library traps this pipeline has already paid for
 *
 * Measured on the pinned versions; each one fails SILENTLY, which is why they
 * are recorded here rather than left to be rediscovered.
 *
 * 1. **pdf-lib 1.17.1 `drawText()` has no `renderingMode` option.** Passing one
 *    is ignored, producing a *visibly black* text layer over the artwork. An
 *    invisible overlay must be emitted by hand
 *    (`page.pushOperators(...setTextRenderingMode(3))`).
 * 2. **`PDFDocumentProxy.destroy()` does not exist in pdfjs-dist 6.2.108.**
 *    Teardown goes through `loadingTask.destroy()`. `openPdf` normalises this
 *    behind `PdfDoc.dispose()` so a `destroy?.()` call cannot silently leak a
 *    worker.
 * 3. **tesseract.js needs its NODE worker path and an explicit `blocks` flag.**
 *    The browser worker script crashes under Node, and `blocks` defaults to
 *    `false` — without it there are no coordinates at all.
 * 4. **fontkit 2.x is not source-compatible with pdf-lib 1.17.1**
 *    (`encodeStream()` → `encode()`), and every macOS CJK face is a `.ttc`
 *    collection that `fontkit.create()` returns as a collection, not a font.
 * 5. **A font's resource key is per PAGE.** Caching it by font alone leaves the
 *    second page's `/Font` dict empty: the text paints, but extracts as raw
 *    glyph bytes, so the "searchable" PDF is not searchable.
 *
 * @module dsh-pdf-studio/core/contracts
 */

/** A closed rectangle in PDF points (bottom-left origin). */
export interface PdfRect {
  /** Left edge, points from the page's left. */
  x: number
  /** BOTTOM edge, points from the page's bottom. */
  y: number
  width: number
  height: number
}

/** A closed rectangle in raster pixels (top-left origin), as OCR reports it. */
export interface PixelRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** How a page's content is stored, decided by `triage`. */
export type PageKind =
  /** Real text content: the text layer is trustworthy and usable directly. */
  | 'text'
  /** Raster only: no usable text layer. Content must be recovered by OCR. */
  | 'image'
  /** Both: a scan background plus a real, trustworthy text layer. */
  | 'mixed'
  /** No text layer and no images — nothing to edit. */
  | 'empty'

/** Why `triage` chose a kind; surfaced in diagnostics and the UI. */
export interface TriageEvidence {
  /** Characters in the extracted text layer. */
  textChars: number
  /** Text items in the extracted text layer. */
  textItems: number
  /** Characters that survive the "trustworthy text" filter. */
  trustedChars: number
  /** Raster images painted on the page. */
  imageCount: number
  /** Summed painted image area as a fraction of the page area (0..1+). */
  imageCoverage: number
  /**
   * Fraction of trusted text that sits inside the normal page body, i.e.
   * outside the fingerprint/margin bands. A watermark or anti-copy
   * fingerprint string sits at the very edge with a tiny font, so a page
   * whose only text is that string reports a near-zero value here.
   */
  bodyTextRatio: number
  /** Human-readable notes explaining the verdict (folded into diagnostics). */
  notes: string[]
}

/** One page's classification, with the evidence behind it. */
export interface PageTriage {
  /** 1-based page number. */
  page: number
  kind: PageKind
  evidence: TriageEvidence
  /** Page size in PDF points. */
  width: number
  height: number
}

/** A contiguous run of text sharing one font and one baseline. */
export interface TextRun {
  text: string
  /** Baseline origin in PDF points (bottom-left). */
  x: number
  y: number
  /** Font size in points, derived from the text transform. */
  size: number
  /**
   * Font identifier as pdf.js names it (e.g. `g_d0_f1`). This is pdf.js's
   * internal handle, NOT the content-stream resource name (`/A9`): pdf.js does
   * not expose the latter through `getTextContent()`. Useful for grouping runs
   * that share a face; not resolvable back to the PDF font dictionary.
   */
  fontRef?: string
  /** Advance width in points, when known. */
  width?: number
  /** Fill colour as `#rrggbb`, when the content stream made it recoverable. */
  color?: string
}

/** Runs sharing a visual line, ordered left-to-right. */
export interface TextLine {
  runs: TextRun[]
  /** Union box of the runs, PDF points. */
  rect: PdfRect
  /** Concatenated run text — the line as a user would read it. */
  text: string
  /**
   * Recognition confidence 0..100 when the line came from OCR; `undefined`
   * for text-layer lines (which are exact, not estimated).
   */
  confidence?: number
  /** Where this line's text came from. */
  source: 'text-layer' | 'ocr'
}

/** Everything recovered from one page, ready for the edit model or export. */
export interface PageContent {
  page: number
  width: number
  height: number
  kind: PageKind
  lines: TextLine[]
  /** Warnings worth surfacing (OCRed page with low confidence, etc.). */
  notes: string[]
}

/** Options shared by the extraction stages. */
export interface ExtractOptions {
  /** Render scale for rasterisation; OCR boxes are divided by this. */
  scale?: number
  /** Language(s) for OCR. Defaults to `chi_sim+eng`. */
  lang?: string
  /**
   * OCR 语言数据目录（`<lang>.traineddata[.gz]`）。
   * 省略时由 `src/core/ocr.ts` 的 `resolveLangPath()` 决定（环境变量 > 兜底路径）。
   */
  langPath?: string
  /** Only OCR pages whose text layer is not trustworthy. Default true. */
  skipTextLayerPages?: boolean
  /**
   * 是否对图片页做 OCR。默认 true。
   *
   * `false` 时图片页**不进入** `content`（调用方按 `triage` 的 kind 自己标"未做 OCR"），
   * 这样"只看文字层、不碰 OCR"的只读工具不必为一个开关付出整档 OCR 的代价。
   */
  ocr?: boolean
  /**
   * 只读取这些页（1 基）。省略则整档。
   *
   * 用于"只判定第 6-7 页"这类调用：范围之外的页既不做 OCR 也不读文字层。
   */
  onlyPages?: number[]
  /** Progress sink, called with (done, total) as pages complete. */
  onProgress?: (done: number, total: number) => void
}

/** One page's OCR outcome. */
export interface OcrPageResult {
  page: number
  lines: TextLine[]
  /** Page-wide mean confidence 0..100. */
  confidence: number
  /** Wall-clock time for this page, ms. */
  elapsedMs: number
  notes: string[]
}

/** A build request for the searchable-PDF writer. */
export interface SearchablePdfRequest {
  /** Absolute path of the source PDF (never modified). */
  sourcePath: string
  /** Absolute path to write the result to. */
  outputPath: string
  /** Per-page lines to lay down as an invisible text layer. */
  pages: Array<Pick<PageContent, 'page' | 'lines'>>
  /**
   * Render mode for the overlay:
   * - `invisible` (default): the scan looks untouched; text is selectable and
   *   searchable. This is the "searchable scan" product.
   * - `cover`: draw an opaque patch over the original and paint the new text
   *   visibly — for replacing text in a scan.
   */
  mode?: 'invisible' | 'cover'
  /** Patch fill colour for `cover` mode. Defaults to white. */
  coverColor?: string
  /** Font size multiplier applied to each line's measured height. */
  sizeFactor?: number
}

/** Outcome of a searchable-PDF build. */
export interface SearchablePdfResult {
  outputPath: string
  pages: number
  /** Lines actually written into the text layer. */
  linesWritten: number
  /** Lines skipped (empty text, zero-size box). */
  linesSkipped: number
  bytes: number
}
