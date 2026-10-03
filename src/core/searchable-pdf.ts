/**
 * Searchable-PDF writer.
 *
 * Product framing: take a scan (a PDF whose pages are really just one big
 * image) and add an *invisible* text layer on top of the pixels, so the file
 * looks identical but the words become selectable, copyable and searchable.
 * That is `mode: 'invisible'`, the default and the point of this module.
 *
 * `mode: 'cover'` is the other half of the product: instead of hiding the new
 * text, paint an opaque patch over the old pixels and draw the replacement
 * text visibly — "edit the words in a scan".
 *
 * Hard rules this module obeys:
 *
 *  - The source PDF is opened read-only and never written to. Original pages
 *    are carried over with `copyPages`, so scanned images and annotations keep
 *    their original (already-compressed) streams instead of being re-encoded.
 *  - The text layer is emitted with an explicit `Tr` operator. pdf-lib 1.17.1's
 *    `page.drawText()` has NO `renderingMode` option — it silently ignores one
 *    if you pass it, which would produce a *visible* text layer over the scan.
 *    We therefore build the text operators by hand (see `pushOverlayLine`).
 *
 * @module dsh-pdf-studio/core/searchable-pdf
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'

import {
  PDFDocument,
  StandardFonts,
  TextRenderingMode,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  rotateAndSkewTextRadiansAndTranslate,
  setFillingRgbColor,
  setFontAndSize,
  setTextRenderingMode,
  showText,
} from 'pdf-lib'

import type {
  PdfRect,
  SearchablePdfRequest as ContractSearchablePdfRequest,
  SearchablePdfResult as ContractSearchablePdfResult,
  TextLine,
  TextRun,
} from './contracts.ts'

// `TextRun` and `PdfRect` are part of the public shape this module consumes,
// so they are re-exported for callers that only import from here.
export type { PdfRect, TextLine, TextRun }

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * {@link ContractSearchablePdfRequest} plus one pragmatic escape hatch.
 *
 * The repo ships no CJK font and pdf-lib's standard 14 cannot encode CJK, so
 * the caller may point us at a specific font file to use for CJK lines. This
 * is intentionally an intersection with the contract type rather than an edit
 * to `contracts.ts`: the shared contract stays the single source of truth and
 * a plain `SearchablePdfRequest` is still assignable here.
 */
export type SearchablePdfRequest = ContractSearchablePdfRequest & {
  /**
   * Absolute path to a `.ttf`/`.otf`/`.ttc` font to use for CJK lines.
   * Optional: when omitted, a short list of system CJK fonts is probed.
   * When no usable font is found, CJK lines are counted as skipped and
   * reported — never silently dropped and never allowed to abort the build.
   */
  cjkFontPath?: string
}

/** One line that was dropped, with the reason, so callers can report honestly. */
export interface SkippedLine {
  /** 1-based source page number as given in the request. */
  page: number
  /** Index of the line within that page's `lines` array. */
  lineIndex: number
  /** The line's text, truncated for diagnostics. */
  text: string
  /** Machine-ish reason: `empty-text` | `non-positive-box` | `no-cjk-font` | `unencodable-text`. */
  reason: string
}

/** Description of the CJK font that was actually embedded, if any. */
export interface CjkFontInfo {
  path: string
  /** PostScript name of the face picked out of a `.ttc` collection. */
  postscriptName: string
}

/**
 * {@link ContractSearchablePdfResult} plus the diagnostics the contract has no
 * room for. Still structurally assignable to the contract type, so callers
 * written against `contracts.ts` are unaffected.
 */
export type SearchablePdfResult = ContractSearchablePdfResult & {
  /** Human-readable notes: what was skipped, sanitised, or could not be done. */
  notes: string[]
  /** Every dropped line with its reason. `linesSkipped === skipped.length`. */
  skipped: SkippedLine[]
  /** The CJK font that was embedded, or `null` when none could be found. */
  cjkFont: CjkFontInfo | null
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Clamp band for the computed font size, per the module contract. */
const MIN_FONT_SIZE = 1
const MAX_FONT_SIZE = 200

/** Default patch colour for `cover` mode. */
const DEFAULT_COVER_COLOR = '#ffffff'

/**
 * System CJK candidates, cheapest-to-embed first. macOS-specific paths are
 * fine because this pipeline is host-only (it reads local files and spawns
 * local OCR); the list is deliberately small and probed with `existsSync`.
 */
const CJK_FONT_CANDIDATES: readonly string[] = [
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/System/Library/Fonts/Supplemental/Songti.ttc',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
]

/**
 * Ranges that make a string "CJK" for font-selection purposes:
 * CJK symbols/punctuation, the unified ideograph block, and fullwidth forms.
 */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f],
  [0x4e00, 0x9fff],
  [0xff00, 0xffef],
]

/**
 * Extra non-ASCII punctuation worth keeping for Helvetica. Everything below
 * U+0250 is allowed by the rule in `sanitiseLine`; these are the common
 * Latin typographic characters that live above it and are present in WinAnsi.
 */
const LATIN_PUNCTUATION = new Set<number>([
  0x2013, // –
  0x2014, // —
  0x2018, // ‘
  0x2019, // ’
  0x201a, // ‚
  0x201c, // “
  0x201d, // ”
  0x201e, // „
  0x2020, // †
  0x2021, // ‡
  0x2022, // •
  0x2026, // …
  0x2030, // ‰
  0x2039, // ‹
  0x203a, // ›
  0x20ac, // €
  0x2122, // ™
])

/* -------------------------------------------------------------------------- */
/* Font selection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Decide which overlay font a string needs.
 *
 * Returns `'cjk'` as soon as the text contains any character in U+4E00–U+9FFF
 * (unified ideographs), U+3000–U+303F (CJK symbols and punctuation) or
 * U+FF00–U+FFEF (halfwidth/fullwidth forms); otherwise `'helvetica'`.
 *
 * This is a *repertoire* test, not a language test: a single fullwidth comma
 * is enough to route a line to the CJK font, because Helvetica/WinAnsi simply
 * cannot encode it.
 *
 * @param text The line's text.
 */
export function pickOverlayFont(text: string): 'helvetica' | 'cjk' {
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    for (const [lo, hi] of CJK_RANGES) {
      if (cp >= lo && cp <= hi) return 'cjk'
    }
  }
  return 'helvetica'
}

/* -------------------------------------------------------------------------- */
/* Font geometry                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the overlay font size for a line.
 *
 * Base rule: `rect.height * sizeFactor`. But when the line carries runs with a
 * meaningful measured `size` (the real, typographically-measured point size
 * from the text layer / OCR), that is a better estimate of the glyph size than
 * the box height, which includes ascender/descender slack — so we prefer the
 * largest meaningful run size and apply `sizeFactor` to it.
 *
 * The result is always clamped to [1, 200] pt: a zero-height box must not
 * produce a zero font size (some viewers then hide the text entirely) and a
 * garbage box must not produce a 10 000 pt glyph dump.
 */
function resolveFontSize(line: TextLine, sizeFactor: number): number {
  const runSizes = (line.runs ?? [])
    .map((run) => run.size)
    .filter((size) => Number.isFinite(size) && size > 0)

  const base = runSizes.length > 0 ? Math.max(...runSizes) : line.rect.height
  const scaled = base * sizeFactor
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, scaled))
}

/* -------------------------------------------------------------------------- */
/* Text sanitisation                                                          */
/* -------------------------------------------------------------------------- */

/** True when a code point is in the "Latin" repertoire Helvetica can attempt. */
function isLatinRepertoire(codePoint: number): boolean {
  return codePoint < 0x0250 || LATIN_PUNCTUATION.has(codePoint)
}

/**
 * Build a per-code-point encodability predicate for an already-embedded font.
 *
 * Two strategies, because the two font kinds fail differently:
 *
 *  - Standard fonts THROW from `encodeText` on an unencodable code point, so a
 *    try/catch probe is exact and uses only pdf-lib's public API.
 *  - Embedded (fontkit) fonts never throw — fontkit maps unknown code points
 *    to `.notdef`, i.e. a blank box. We therefore ask fontkit the direct
 *    question via `hasGlyphForCodePoint`.
 *
 * Results are memoised: a full page of OCR text hits the same codepoints a lot.
 */
function makeEncodabilityTest(
  encodeWith: (text: string) => unknown,
  fontkitFont: { hasGlyphForCodePoint?: (cp: number) => boolean } | null,
): (codePoint: number) => boolean {
  const cache = new Map<number, boolean>()

  return (codePoint: number): boolean => {
    const cached = cache.get(codePoint)
    if (cached !== undefined) return cached

    let ok: boolean
    if (fontkitFont?.hasGlyphForCodePoint) {
      ok = fontkitFont.hasGlyphForCodePoint(codePoint)
    } else {
      try {
        encodeWith(String.fromCodePoint(codePoint))
        ok = true
      } catch {
        ok = false
      }
    }

    cache.set(codePoint, ok)
    return ok
  }
}

/** Outcome of {@link sanitiseLine}. */
interface SanitisedText {
  text: string
  /** The characters that were dropped, de-duplicated, for the notes. */
  removed: string[]
}

/**
 * Drop everything the chosen font cannot encode instead of letting pdf-lib
 * throw (standard fonts) or quietly emit `.notdef` boxes (embedded fonts).
 *
 * Order matters: normalise line-breaking whitespace to spaces first (a `TextLine`
 * is one visual line, so a stray `\n` is noise), then apply the repertoire
 * filter, then the font's own encodability test.
 */
function sanitiseLine(
  text: string,
  kind: 'helvetica' | 'cjk',
  canEncode: (codePoint: number) => boolean,
): SanitisedText {
  // Collapse control whitespace so multi-line junk cannot corrupt the text
  // matrix (a literal newline inside a `Tj` string would break the operator).
  const normalised = text.replace(/[\r\n\t\f\v]+/g, ' ')

  let out = ''
  const removed: string[] = []

  for (const ch of normalised) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue

    // Control characters are never meaningful in a text layer.
    if (cp < 0x20 || cp === 0x7f) {
      removed.push(ch)
      continue
    }
    // Helvetica is routed to WinAnsi; anything outside the Latin repertoire is
    // dropped here rather than discovered later as a thrown encoding error.
    if (kind === 'helvetica' && !isLatinRepertoire(cp)) {
      removed.push(ch)
      continue
    }
    if (!canEncode(cp)) {
      removed.push(ch)
      continue
    }
    out += ch
  }

  return { text: out, removed: [...new Set(removed)] }
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                     */
/* -------------------------------------------------------------------------- */

/** Parse `#rgb`/`#rrggbb` into a pdf-lib colour, falling back to white. */
function parseHexColor(hex: string | undefined): ReturnType<typeof rgb> {
  const value = (hex ?? DEFAULT_COVER_COLOR).trim()
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
  if (!match) return rgb(1, 1, 1)

  let digits = match[1]!
  if (digits.length === 3) {
    digits = digits
      .split('')
      .map((d) => d + d)
      .join('')
  }

  const int = Number.parseInt(digits, 16)
  return rgb(((int >> 16) & 0xff) / 255, ((int >> 8) & 0xff) / 255, (int & 0xff) / 255)
}

/* -------------------------------------------------------------------------- */
/* fontkit loading + compatibility shim                                       */
/* -------------------------------------------------------------------------- */

/** Minimal EventEmitter shape pdf-lib's subset serializer listens on. */
interface ByteStream {
  on(event: string, listener: (arg?: unknown) => void): ByteStream
}

/**
 * Wrap a `Uint8Array` in the tiny streaming interface pdf-lib expects from
 * `subset.encodeStream()`.
 *
 * Deliberately hand-rolled rather than `node:stream`: it keeps this module free
 * of stream imports and matches the exact `on('data'|'end'|'error')` contract.
 * Delivery is deferred to a microtask so listeners attached after the call are
 * still invoked, mirroring real stream semantics.
 */
function bytesToByteStream(bytes: Uint8Array): ByteStream {
  const handlers: Record<string, Array<(arg?: unknown) => void>> = {}

  const stream: ByteStream = {
    on(event, listener) {
      ;(handlers[event] ??= []).push(listener)
      return stream
    },
  }

  queueMicrotask(() => {
    try {
      for (const listener of handlers.data ?? []) listener(bytes)
      for (const listener of handlers.end ?? []) listener()
    } catch (error) {
      for (const listener of handlers.error ?? []) listener(error)
    }
  })

  return stream
}

/** Marker so a fontkit font object is only shimmed once. */
const SHIMMED = Symbol.for('dsh-pdf-studio.fontkit-subset-shimmed')

/**
 * Reconcile the fontkit generation pdf-lib expects with the one installed.
 *
 * pdf-lib 1.17.1 was written against fontkit 1.x, where a subset exposes
 * `encodeStream()` returning a readable stream. fontkit 2.x renamed that to
 * `encode()` and made it return a `Uint8Array` synchronously, so pdf-lib dies
 * with `subset.encodeStream is not a function`. We bridge the two.
 *
 * We also restore `subset.cff`: pdf-lib uses its truthiness to choose
 * `CIDFontType0`/`FontFile3` over `CIDFontType2`/`FontFile2`, and fontkit 2's
 * subsets no longer expose it.
 */
function shimSubsetCompatibility(font: any): any {
  if (!font || font[SHIMMED]) return font
  const originalCreateSubset = font.createSubset
  if (typeof originalCreateSubset !== 'function') return font

  const hasCff = Boolean(font.directory?.tables?.['CFF '])
  const cffTable = hasCff ? font.directory.tables['CFF '] : undefined

  font.createSubset = function createSubset(this: unknown) {
    const subset = originalCreateSubset.call(this)

    if (typeof subset.encodeStream !== 'function' && typeof subset.encode === 'function') {
      subset.encodeStream = () => bytesToByteStream(subset.encode())
    }
    if (subset.cff === undefined && cffTable) subset.cff = cffTable

    return subset
  }

  font[SHIMMED] = true
  return font
}

/**
 * Wrap a fontkit module so pdf-lib can embed `.ttc` collections.
 *
 * pdf-lib calls `fontkit.create(bytes)` with no face name. For a TrueType
 * Collection that returns a *collection*, not a font — it has no `.layout` and
 * embedding blows up. Every CJK font macOS ships is a `.ttc`, so the adapter
 * picks one face up front and always returns it.
 */
function makeFontkitAdapter(raw: any, pickFace: (faces: any[]) => any): any {
  const adapter: any = {}
  for (const key of Object.keys(raw)) adapter[key] = raw[key]

  adapter.create = (data: Uint8Array, postscriptName?: string) => {
    const created = raw.create(data, postscriptName)
    const font = created && Array.isArray(created.fonts) ? pickFace(created.fonts) : created
    return shimSubsetCompatibility(font)
  }

  return adapter
}

/**
 * Import a fontkit implementation, preferring the package name the brief
 * names and falling back to the fork pdf-lib documents.
 */
async function loadFontkitModule(): Promise<any | null> {
  for (const specifier of ['fontkit', '@pdf-lib/fontkit']) {
    try {
      const namespace: any = await import(specifier)
      const candidates = [namespace?.default, namespace]
      for (const candidate of candidates) {
        if (candidate && typeof candidate.create === 'function') return candidate
      }
    } catch {
      // Not installed — try the next candidate.
    }
  }
  return null
}

/** Prefer a Simplified-Chinese face out of a collection, else the first face. */
function pickPreferredFace(faces: any[]): any {
  return (
    faces.find((face) => /SC|GB/i.test(String(face?.postscriptName ?? ''))) ?? faces[0]
  )
}

/** A CJK font resolved from disk, ready to hand to `PDFDocument.embedFont`. */
interface LoadedCjkFont {
  info: CjkFontInfo
  bytes: Uint8Array
  /** The fontkit module that parsed it, so it can also be registered with pdf-lib. */
  fontkit: any
  /** The fontkit face, kept so we can ask it about glyph coverage. */
  face: any
}

/**
 * Look for a usable CJK font, honouring `req.cjkFontPath` first.
 *
 * Returns `null` (never throws) when nothing is available, so the caller can
 * report the loss instead of crashing the whole build.
 */
async function loadCjkFont(requestedPath: string | undefined): Promise<LoadedCjkFont | null> {
  const candidates = requestedPath ? [requestedPath] : []
  for (const candidate of CJK_FONT_CANDIDATES) {
    if (!candidates.includes(candidate)) candidates.push(candidate)
  }

  const fontkit = await loadFontkitModule()
  if (!fontkit) return null

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue
      const bytes = readFileSync(path)
      const opened = fontkit.create(bytes)
      const face =
        opened && Array.isArray(opened.fonts) ? pickPreferredFace(opened.fonts) : opened
      if (!face) continue
      return {
        info: { path, postscriptName: String(face.postscriptName ?? '') },
        bytes,
        fontkit,
        face,
      }
    } catch {
      // Unreadable / unparsable candidate — keep probing.
    }
  }

  return null
}

/* -------------------------------------------------------------------------- */
/* Overlay drawing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Append one absolutely-positioned line of text to a page's content stream.
 *
 * Written by hand rather than with `page.drawText()` for one decisive reason:
 * pdf-lib 1.17.1 has no `renderingMode` option, so `drawText` can only fill —
 * which would stamp visibly black text all over the scan. Emitting
 * `setTextRenderingMode(...)` ourselves is the only way to get `3 Tr`.
 *
 * The coordinate values are used verbatim: `TextLine.rect` is already in
 * bottom-left-origin PDF space, so there is no flip here.
 */
function pushOverlayLine(
  page: { pushOperators: (...ops: any[]) => void },
  fontKey: unknown,
  font: { encodeText: (text: string) => any },
  text: string,
  size: number,
  x: number,
  y: number,
  renderingMode: TextRenderingMode,
): void {
  page.pushOperators(
    pushGraphicsState(),
    beginText(),
    setFillingRgbColor(0, 0, 0),
    setFontAndSize(fontKey as any, size),
    setTextRenderingMode(renderingMode),
    rotateAndSkewTextRadiansAndTranslate(0, 0, 0, x, y),
    showText(font.encodeText(text)),
    endText(),
    popGraphicsState(),
  )
}

/* -------------------------------------------------------------------------- */
/* Main entry point                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build a searchable (or text-replacing) PDF from OCR'd / extracted lines.
 *
 * Reads `req.sourcePath` and writes `req.outputPath`; the source is opened
 * read-only and is never modified. All original pages are carried across with
 * `copyPages` so scanned images and annotations keep their existing streams.
 *
 * For each requested page the lines are laid down at their own `rect` origin
 * (`x = rect.x`, `y = rect.y`) as an invisible text layer — or, in
 * `mode: 'cover'`, behind an opaque rectangle as visible text.
 *
 * Robustness contract: nothing about a bad *input* aborts the build. Unknown
 * pages, empty lines, zero-size boxes and CJK lines with no available font are
 * all recorded in `skipped` / `notes` and counted in `linesSkipped`.
 *
 * @param req Source path, output path, per-page lines, and display options.
 * @returns The written file's path and size plus a full account of what was
 *          and was not drawn.
 */
export async function buildSearchablePdf(req: SearchablePdfRequest): Promise<SearchablePdfResult> {
  const notes: string[] = []
  const skipped: SkippedLine[] = []

  const mode = req.mode ?? 'invisible'
  const sizeFactor = req.sizeFactor ?? 1
  const coverColor = parseHexColor(req.coverColor)

  // --- open the source and clone every page --------------------------------
  // `updateMetadata: false` keeps the original document info untouched at load
  // time; we are readers of this file, not editors.
  const sourceBytes = readFileSync(req.sourcePath)
  const source = await PDFDocument.load(sourceBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  })

  const output = await PDFDocument.create()
  const pageIndices = source.getPageIndices()
  const copiedPages = await output.copyPages(source, pageIndices)
  const outputPages = copiedPages.map((page) => output.addPage(page))

  notes.push(
    `copied ${outputPages.length} of ${pageIndices.length} source page(s) verbatim via copyPages`,
  )

  // --- fonts, embedded lazily ---------------------------------------------
  let helveticaFont: any = null
  let cjkFont: any = null
  let cjkLoaded: LoadedCjkFont | null = null
  let cjkLookupDone = false

  // pdf-lib needs a font dictionary entry on the page before an operator can
  // name it. The cache MUST be per page: a font's resource name is declared in
  // each page's own /Resources /Font dict, so caching the key globally would
  // make page 3's content stream reference a name only page 1 declares — the
  // text then renders but extractors cannot map it back to Unicode.
  const fontKeys = new WeakMap<any, Map<any, any>>()
  const fontKeyFor = (page: any, font: any) => {
    let pageKeys = fontKeys.get(page)
    if (!pageKeys) {
      pageKeys = new Map()
      fontKeys.set(page, pageKeys)
    }
    let key = pageKeys.get(font)
    if (!key) {
      key = page.node.newFontDictionary(font.name, font.ref)
      pageKeys.set(font, key)
    }
    return key
  }

  let linesWritten = 0
  let sanitisedCharCount = 0
  const sanitisedSamples = new Set<string>()

  // --- lay down the overlay ------------------------------------------------
  for (const entry of req.pages) {
    const pageIndex = Number(entry.page) - 1
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= outputPages.length) {
      notes.push(
        `page ${entry.page}: not present in source (source has ${outputPages.length} page(s)) — skipped`,
      )
      continue
    }

    const page = outputPages[pageIndex]!
    const lines: TextLine[] = entry.lines ?? []

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]!
      const record = (reason: string, text: string) => {
        skipped.push({
          page: entry.page,
          lineIndex,
          text: text.slice(0, 80),
          reason,
        })
      }

      // The line's own `text` is authoritative; runs are only a fallback for
      // callers that populated the runs but not the convenience field.
      const rawText = line.text ?? ''
      const text =
        rawText.trim().length > 0 ? rawText : (line.runs ?? []).map((r) => r.text).join('')

      if (text.trim().length === 0) {
        record('empty-text', text)
        continue
      }

      const rect: PdfRect | undefined = line.rect
      if (
        !rect ||
        !Number.isFinite(rect.x) ||
        !Number.isFinite(rect.y) ||
        !Number.isFinite(rect.width) ||
        !Number.isFinite(rect.height) ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        record('non-positive-box', text)
        continue
      }

      const kind = pickOverlayFont(text)

      // --- resolve the font for this line ---------------------------------
      if (kind === 'helvetica') {
        if (!helveticaFont) {
          helveticaFont = await output.embedFont(StandardFonts.Helvetica, { subset: false })
        }
      } else {
        if (!cjkLookupDone) {
          cjkLookupDone = true
          cjkLoaded = await loadCjkFont(req.cjkFontPath)

          if (cjkLoaded) {
            try {
              output.registerFontkit(
                makeFontkitAdapter(cjkLoaded.fontkit, pickPreferredFace),
              )
              cjkFont = await output.embedFont(cjkLoaded.bytes, { subset: true })
              notes.push(
                `CJK font embedded: ${cjkLoaded.info.path} (face ${cjkLoaded.info.postscriptName || 'unknown'})`,
              )
            } catch (error) {
              cjkFont = null
              cjkLoaded = null
              notes.push(
                `CJK font at ${req.cjkFontPath ?? 'system path'} could not be embedded: ${
                  error instanceof Error ? error.message : String(error)
                } — CJK lines will be skipped`,
              )
            }
          } else {
            notes.push(
              `no CJK font found (probed ${req.cjkFontPath ? `${req.cjkFontPath} plus ` : ''}${
                CJK_FONT_CANDIDATES.length
              } system path(s)) — CJK lines will be skipped`,
            )
          }
        }

        if (!cjkFont) {
          record('no-cjk-font', text)
          continue
        }
      }

      // --- drop what the font cannot encode -------------------------------
      const activeFont = kind === 'helvetica' ? helveticaFont : cjkFont
      const canEncode = makeEncodabilityTest(
        (probe) => activeFont.encodeText(probe),
        kind === 'cjk' ? (cjkLoaded?.face ?? null) : null,
      )
      const { text: drawable, removed } = sanitiseLine(text, kind, canEncode)

      if (removed.length > 0) {
        sanitisedCharCount += removed.length
        for (const ch of removed) sanitisedSamples.add(ch)
      }
      if (drawable.trim().length === 0) {
        record('unencodable-text', text)
        continue
      }

      // --- draw ------------------------------------------------------------
      const size = resolveFontSize(line, sizeFactor)

      if (mode === 'cover') {
        page.drawRectangle({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          color: coverColor,
        })
      }

      pushOverlayLine(
        page,
        fontKeyFor(page, activeFont),
        activeFont,
        drawable,
        size,
        rect.x,
        rect.y,
        mode === 'cover' ? TextRenderingMode.Fill : TextRenderingMode.Invisible,
      )

      linesWritten++
    }
  }

  if (sanitisedCharCount > 0) {
    const sample = [...sanitisedSamples].slice(0, 12).join('')
    notes.push(
      `dropped ${sanitisedCharCount} character(s) the chosen font cannot encode${
        sample ? ` (e.g. ${sample})` : ''
      }`,
    )
  }
  if (skipped.length > 0) {
    const byReason = new Map<string, number>()
    for (const item of skipped) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1)
    notes.push(
      `skipped ${skipped.length} line(s): ${[...byReason]
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ')}`,
    )
  }

  const bytes = await output.save()
  writeFileSync(req.outputPath, bytes)

  return {
    outputPath: req.outputPath,
    pages: outputPages.length,
    linesWritten,
    linesSkipped: skipped.length,
    bytes: statSync(req.outputPath).size,
    notes,
    skipped,
    cjkFont: cjkLoaded ? cjkLoaded.info : null,
  }
}
