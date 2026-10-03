/**
 * ToUnicode CMap parsing — turning glyph codes back into characters.
 *
 * A PDF text operand is a sequence of CODES in the current font's encoding, not
 * characters: `<0001670D...>` means nothing on its own. What it means is
 * whatever the font's `ToUnicode` CMap says, which is the only sanctioned way
 * to recover text from a content stream. This module reads that CMap.
 *
 * ## Why the CMap and not the font program
 *
 * `ToUnicode` is authored by whoever made the PDF and is authoritative for
 * extraction, which is exactly why pdf.js uses it too. Reading glyph ids out of
 * the embedded font program instead would disagree with every other viewer on
 * subset fonts, and would fail entirely on fonts whose subset has been
 * renumbered.
 *
 * ## Scope
 *
 * Only the `bfchar` / `bfrange` operators are interpreted, which is what real
 * CMaps use for this purpose. Codespace ranges are honoured so a fixed-width
 * code is cut correctly (2 bytes for the `Identity-H` fonts this pipeline
 * meets). Anything unrecognised is skipped rather than throwing: a partially
 * understood CMap still decodes most of the page, and a hard failure would take
 * the whole document with it.
 *
 * @module dsh-pdf-studio/core/tounicode
 */

/** One contiguous mapping: codes `start..end` map to a run of characters. */
interface BfRange {
  start: number
  end: number
  /** Characters for `start`; consecutive codes advance along this string. */
  chars: number[]
}

/** A parsed CMap: individual mappings plus ranges. */
export interface ToUnicodeMap {
  /** Explicit `bfchar` entries: code -> unicode code points. */
  singles: Map<number, number[]>
  /** `bfrange` entries, in declaration order. */
  ranges: BfRange[]
  /** Code width in bytes, derived from the codespace range (default 2). */
  codeBytes: number
}

/** A parsed CMap plus the decoding entry points. */
export interface ToUnicodeDecoder {
  /** The raw parse result, for diagnostics. */
  map: ToUnicodeMap
  /** Decode one code to a string (empty when unmapped). */
  decodeCode(code: number): string
  /**
   * Decode raw operand bytes into text.
   *
   * Codes are read at `codeBytes` width, so a 2-byte `Identity-H` operand is
   * consumed one code at a time. A trailing partial code is ignored.
   */
  decodeBytes(bytes: Uint8Array): string
  /** How many distinct codes the CMap covers, for diagnostics. */
  size(): number
}

/** Parse a hex token like `<670D>` into its bytes. */
function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '')
  const out: number[] = []
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16))
  return out
}

/** Combine big-endian bytes into a code. */
function bytesToCode(bytes: number[]): number {
  let value = 0
  for (const byte of bytes) value = (value << 8) | (byte & 0xff)
  return value
}

/** Turn a UTF-16BE hex payload into code points. */
function hexToCodePoints(hex: string): number[] {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '')
  const out: number[] = []
  for (let i = 0; i + 3 < clean.length; i += 4) out.push(parseInt(clean.slice(i, i + 4), 16))
  // A lone trailing pair is treated as one code point rather than dropped.
  if (clean.length % 4 === 2) out.push(parseInt(clean.slice(-2), 16))
  return out
}

/**
 * Parse a `ToUnicode` CMap.
 *
 * The parser is line-oriented, which is safe here: the operators are
 * line-structured in every CMap this pipeline has met, and `beginbfchar` /
 * `beginbfrange` blocks state their entry count. Anything between blocks that
 * is not a `def`-terminated header is ignored, so an unknown preamble cannot
 * derail the mapping.
 */
export function parseToUnicodeCMap(text: string): ToUnicodeMap {
  const map: ToUnicodeMap = { singles: new Map(), ranges: [], codeBytes: 2 }

  // Codespace ranges give the code width. Take the FIRST one: a CMap may
  // declare several for variable-width encodings, and the first is the primary.
  const codespace = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text)
  if (codespace) {
    const first = /<([0-9A-Fa-f]+)>/.exec(codespace[1])
    if (first) {
      const bytes = Math.ceil(first[1].length / 2)
      if (bytes === 1 || bytes === 2 || bytes === 4) map.codeBytes = bytes
    }
  }

  // bfchar blocks: `<src> <dst>` pairs.
  const bfcharBlocks = text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)
  for (const block of bfcharBlocks) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const code = bytesToCode(hexToBytes(pair[1]))
      map.singles.set(code, hexToCodePoints(pair[2]))
    }
  }

  // bfrange blocks, in two forms:
  //   <lo> <hi> <dstStart>          consecutive codes advance along dstStart
  //   <lo> <hi> [<d0> <d1> ...]     explicit destination per code
  const bfrangeBlocks = text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)
  for (const block of bfrangeBlocks) {
    const body = block[1]
    const arrayForm = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g
    for (const entry of body.matchAll(arrayForm)) {
      const start = bytesToCode(hexToBytes(entry[1]))
      const destinations = [...entry[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map(m => hexToCodePoints(m[1]))
      destinations.forEach((chars, offset) => {
        map.ranges.push({ start: start + offset, end: start + offset, chars })
      })
    }

    // The array form must be removed before scanning the simple form, or its
    // destination array would be mistaken for a string destination.
    const withoutArrays = body.replace(arrayForm, ' ')
    const simpleForm = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g
    for (const entry of withoutArrays.matchAll(simpleForm)) {
      const start = bytesToCode(hexToBytes(entry[1]))
      const end = bytesToCode(hexToBytes(entry[2]))
      const chars = hexToCodePoints(entry[3])
      map.ranges.push({ start, end: Math.max(start, end), chars })
    }
  }

  return map
}

/** Build a decoder over a parsed CMap. */
export function makeDecoder(map: ToUnicodeMap): ToUnicodeDecoder {
  const cache = new Map<number, string>()

  const decodeCode = (code: number): string => {
    const cached = cache.get(code)
    if (cached !== undefined) return cached

    let out = ''
    const single = map.singles.get(code)
    if (single !== undefined) {
      out = String.fromCodePoint(...single)
    } else {
      for (const range of map.ranges) {
        if (code < range.start || code > range.end) continue
        const offset = code - range.start
        if (range.chars.length === 0) break
        if (range.chars.length === 1) {
          // A single-code-point destination is a STARTING point: every further
          // code in the range increments it. `<43> <45> <0043>` therefore means
          // C, D, E — not "C" three times, which is the easy mistake here.
          out = String.fromCodePoint(range.chars[0] + offset)
        } else if (offset < range.chars.length) {
          // An explicit per-code destination (array form).
          out = String.fromCodePoint(range.chars[offset])
        } else {
          // A multi-code-point destination that ran out: continue from its last
          // code point, which covers a ligature-style mapping.
          out = String.fromCodePoint(
            range.chars[range.chars.length - 1] + offset - (range.chars.length - 1),
          )
        }
        break
      }
    }
    cache.set(code, out)
    return out
  }

  const decodeBytes = (bytes: Uint8Array): string => {
    const width = map.codeBytes
    let out = ''
    for (let i = 0; i + width <= bytes.length; i += width) {
      let code = 0
      for (let b = 0; b < width; b += 1) code = (code << 8) | bytes[i + b]
      out += decodeCode(code)
    }
    return out
  }

  return {
    map,
    decodeCode,
    decodeBytes,
    size: () => map.singles.size + map.ranges.length,
  }
}

/**
 * Decode a content-stream glyph operand (a hex or literal string token).
 *
 * @param operand - the raw operand text, e.g. `<0001670D>`.
 * @param decoder - the decoder for the font the operand was shown in.
 */
export function decodeGlyphOperand(operand: string, decoder: ToUnicodeDecoder): string {
  const inner = operand.startsWith('<')
    ? operand.slice(1, -1)
    : operand.startsWith('(')
      ? operand.slice(1, -1)
      : operand
  const clean = inner.replace(/[^0-9A-Fa-f]/g, '')
  const bytes = new Uint8Array(Math.floor(clean.length / 2))
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return decoder.decodeBytes(bytes)
}
