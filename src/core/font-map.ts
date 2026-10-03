/**
 * Load the per-font decoders a page's runs need.
 *
 * A page's text is spread across many subset fonts, each with its own
 * `ToUnicode` CMap. Decoding a run therefore means: work out which font
 * resource the stream selected, then use THAT font's CMap. Getting this wrong
 * is the quiet failure mode — the glyphs still decode, they just decode to
 * nonsense from a neighbouring subset.
 *
 * @module dsh-pdf-studio/core/font-map
 */

import { PDFArray, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { makeDecoder, parseToUnicodeCMap, type ToUnicodeDecoder } from './tounicode.ts'

/** Minimal structural view of a pdf-lib document context. */
export interface PdfContext {
  lookup(ref: unknown): unknown
}

/** One font resource with everything needed to decode its codes as text. */
export interface FontInfo {
  /** Resource name as the content stream writes it, without the leading slash. */
  resourceName: string
  /** Base font name, for diagnostics. */
  baseFont?: string
  /** Encoding name (mostly `Identity-H` in this pipeline). */
  encoding?: string
  /** Default glyph width in 1/1000 text units. */
  defaultWidth: number
  /** `ToUnicode` decoder, when the font carries a usable CMap. */
  decoder?: ToUnicodeDecoder
  /** Per-code widths from `/W`, when present. */
  widths: Map<number, number>
}

/** Look up a name entry of a dictionary as a plain string. */
function nameOf(dict: unknown, key: string): string | undefined {
  if (!(dict instanceof PDFDict)) return undefined
  const value = dict.get(PDFName.of(key))
  return value === undefined ? undefined : value.toString().replace(/^\//, '')
}

/**
 * Read one font resource.
 *
 * Returns a `FontInfo` even when the font is unusable for decoding, so callers
 * can report "this font has no ToUnicode" instead of a silent empty string.
 */
export function readFontInfo(
  context: PdfContext,
  resourceName: string,
  fontObject: unknown,
): FontInfo {
  const info: FontInfo = {
    resourceName,
    defaultWidth: 1000,
    widths: new Map(),
  }

  const font = fontObject instanceof PDFDict ? fontObject : undefined
  if (font === undefined) return info

  info.baseFont = nameOf(font, 'BaseFont')
  info.encoding = nameOf(font, 'Encoding')

  // The descendant CIDFont carries the width metrics.
  const descendants = font.get(PDFName.of('DescendantFonts'))
  if (descendants instanceof PDFArray && descendants.size() > 0) {
    const cid = context.lookup(descendants.get(0))
    if (cid instanceof PDFDict) {
      const dw = cid.get(PDFName.of('DW'))
      if (dw !== undefined) {
        const parsed = Number(dw.toString())
        if (Number.isFinite(parsed) && parsed > 0) info.defaultWidth = parsed
      }
      info.widths = readWidths(context, cid.get(PDFName.of('W')))
    }
  }

  // ToUnicode is authoritative for extraction; without it there is no honest
  // way to map codes back to characters.
  const toUnicode = font.get(PDFName.of('ToUnicode'))
  if (toUnicode !== undefined) {
    const stream = context.lookup(toUnicode)
    if (stream instanceof PDFRawStream) {
      try {
        const text = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')
        info.decoder = makeDecoder(parseToUnicodeCMap(text))
      } catch {
        // A malformed CMap leaves `decoder` undefined, which callers surface.
      }
    }
  }

  return info
}

/**
 * Read a `/W` array into per-code widths.
 *
 * `/W` has two interleaved forms: `c [w1 w2 ...]` gives widths for consecutive
 * codes from `c`, and `cFirst cLast w` gives one width for a range. Both appear
 * in real files, sometimes in the same array.
 */
function readWidths(context: PdfContext, w: unknown): Map<number, number> {
  const widths = new Map<number, number>()
  const array = w instanceof PDFArray ? w : undefined
  if (array === undefined) return widths

  let index = 0
  while (index < array.size()) {
    const first = Number(array.get(index).toString())
    index += 1
    if (!Number.isFinite(first) || index >= array.size()) break
    const second = array.get(index)

    if (second instanceof PDFArray) {
      for (let offset = 0; offset < second.size(); offset += 1) {
        const width = Number(second.get(offset).toString())
        if (Number.isFinite(width)) widths.set(first + offset, width)
      }
      index += 1
      continue
    }

    const secondNumber = Number(second.toString())
    index += 1
    if (!Number.isFinite(secondNumber) || index >= array.size()) break
    const width = Number(array.get(index).toString())
    index += 1
    if (!Number.isFinite(width)) continue
    for (let code = first; code <= secondNumber; code += 1) widths.set(code, width)
  }

  return widths
}

/** Every font resource declared by a page's `/Resources /Font` dictionary. */
export function readPageFonts(
  context: PdfContext,
  page: { node: { Resources(): { lookup(key: unknown, type?: unknown): unknown } } },
): Map<string, FontInfo> {
  const out = new Map<string, FontInfo>()
  const resources = page.node.Resources()
  if (resources === undefined || resources === null) return out

  const fontDict = (resources as { lookup(key: unknown, type?: unknown): unknown })
    .lookup(PDFName.of('Font'), PDFDict)
  if (!(fontDict instanceof PDFDict)) return out

  for (const [key, ref] of fontDict.entries()) {
    const name = key.toString().replace(/^\//, '')
    out.set(name, readFontInfo(context, name, context.lookup(ref)))
  }
  return out
}

/** Width of one code in text units, falling back to the font default. */
export function widthOfCode(info: FontInfo | undefined, code: number): number {
  if (info === undefined) return 1000
  return info.widths.get(code) ?? info.defaultWidth
}
