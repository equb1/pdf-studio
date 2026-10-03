/**
 * PDF content-stream tokeniser and text-run locator.
 *
 * A PDF page's appearance is a program: a flat sequence of operators with
 * operands (`24 TL`, `1 0 0 1 244 761 Tm`, `<00010002> Tj`). Editing text means
 * rewriting the operands of the show-text operators, and doing that safely
 * needs two things this module provides:
 *
 *   1. a tokeniser that round-trips the stream byte-for-byte when nothing is
 *      rewritten — so an edit provably touches only what it means to; and
 *   2. a locator that reports which operator indices produced which text, at
 *      which position, in which font and size.
 *
 * ## Why glyph ids, not characters
 *
 * In a subset font the shown string is not text: `<00010002>` is a sequence of
 * glyph indices in that font's own encoding. The character a glyph means is
 * whatever the font's `ToUnicode` CMap says. So this module reports the RAW
 * operand, and pairing a run with its real characters is the caller's job
 * (they have the CMap, via the font dictionary). Reporting a "string" here
 * would mean inventing a decoding claim this module cannot make.
 *
 * @module dsh-pdf-studio/core/content-stream
 */

/** A token with its exact source span, so the stream can be rebuilt verbatim. */
export interface Token {
  /** Raw source text of the token, exactly as it appeared. */
  raw: string
  /** Start offset in the decoded stream. */
  start: number
  /** End offset (exclusive). */
  end: number
  kind: 'number' | 'name' | 'string' | 'array' | 'dict' | 'operator' | 'comment'
}

/** One operation: its operator plus the operands preceding it. */
export interface Operation {
  /** Operator name, e.g. `Tj`, `TJ`, `Tm`. */
  op: string
  /** Operand tokens, in source order. */
  operands: Token[]
  /** Source span covering operands and operator. */
  start: number
  end: number
}

/** How a show-text operator carries its glyph data. */
export type ShowKind = 'Tj' | 'TJ' | 'quote' | 'double-quote'

/** One text-showing operation, decoded enough to reason about. */
export interface ShowTextOp {
  /** Index into the parsed operation list. */
  index: number
  kind: ShowKind
  /** The glyph operand token (the string for Tj/'/", the array for TJ). */
  operand: Token
  /**
   * Per-string glyph payloads in order. `TJ` arrays interleave numbers
   * (kerning adjustments) with strings; only the strings carry glyphs, and the
   * numbers are preserved by index so a rewrite can keep the spacing intent.
   */
  strings: Token[]
}

/** A positioned show-text step, with the text state in force at that point. */
export interface PositionedShow extends ShowTextOp {
  /** Active font resource name as written in the stream (e.g. `ArialUnicodeMS-7098480789`). */
  fontName?: string
  /** Active font size in points. */
  fontSize?: number
  /** Text-space origin from the most recent `Tm`/`Td`/`TD`/`T*`, in PDF points. */
  x: number
  y: number
}

const WHITESPACE = new Set([' ', '\t', '\r', '\n', '\f', '\0'])

/** Whether a byte begins a regular (non-delimiter) token. */
function isRegularChar(ch: string): boolean {
  return !WHITESPACE.has(ch) && !'()<>[]{}/%'.includes(ch)
}

/**
 * Tokenise a decoded content stream.
 *
 * The tokeniser is deliberately lossless: every token carries `start`/`end`
 * offsets into the input, and `raw` is copied verbatim. Rebuilding a stream by
 * joining `raw` reproduces the input exactly, which is what makes "only the
 * intended span changed" a checkable property rather than a hope.
 */
/**
 * Advance past a literal string starting at `from`, which must point at `(`.
 *
 * Every branch guarantees forward progress: a backslash escape consumes one
 * byte when it is the last one in the input rather than two. An unterminated
 * string ends at end-of-input instead of running away — an unbounded `i += 2`
 * on a trailing backslash is precisely how a scanner walks off the end and
 * spins forever, which is a crash, not a wrong answer.
 *
 * @returns the index just past the closing paren (or the input end).
 */
function skipLiteralString(input: string, from: number): number {
  const n = input.length
  let i = from
  let depth = 0
  while (i < n) {
    const c = input[i]
    if (c === '\\') {
      i += i + 1 < n ? 2 : 1
      continue
    }
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return n
}

/** Bounded hex-string scan starting at `<`; returns the index past `>`. */
function skipHexString(input: string, from: number): number {
  const n = input.length
  let i = from + 1
  while (i < n && input[i] !== '>') i += 1
  return i < n ? i + 1 : n
}

/** Bounded dictionary scan starting at `<<`; returns the index past `>>`. */
function skipDictionary(input: string, from: number): number {
  const n = input.length
  let i = from
  let depth = 0
  while (i < n) {
    if (input[i] === '<' && input[i + 1] === '<') {
      depth += 1
      i += 2
      continue
    }
    if (input[i] === '>' && input[i + 1] === '>') {
      depth -= 1
      i += 2
      if (depth === 0) return i
      continue
    }
    i += 1
  }
  return n
}

/** Bounded array scan starting at `[`; returns the index past `]`. */
function skipArray(input: string, from: number): number {
  const n = input.length
  let i = from
  let depth = 0
  while (i < n) {
    const c = input[i]
    if (c === '(') {
      // A literal string inside an array is skipped wholesale, so brackets or
      // parens inside it cannot affect the nesting count.
      const next = skipLiteralString(input, i)
      i = next > i ? next : i + 1
      continue
    }
    if (c === '[') depth += 1
    else if (c === ']') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return n
}

/**
 * Tokenise a decoded content stream.
 *
 * The tokeniser is deliberately lossless: every token carries `start`/`end`
 * offsets into the input, and `raw` is copied verbatim. Rebuilding a stream by
 * joining `raw` reproduces the input exactly, which is what makes "only the
 * intended span changed" a checkable property rather than a hope.
 *
 * The one hard invariant is termination: every iteration of the outer loop
 * advances `i` by at least one, so a malformed stream (unterminated string,
 * stray delimiter) yields tokens and stops, rather than hanging.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = input.length

  while (i < n) {
    const ch = input[i]

    if (WHITESPACE.has(ch)) {
      i += 1
      continue
    }

    // Comment: runs to end of line.
    if (ch === '%') {
      const start = i
      while (i < n && input[i] !== '\n' && input[i] !== '\r') i += 1
      tokens.push({ raw: input.slice(start, i), start, end: i, kind: 'comment' })
      continue
    }

    // Literal string.
    if (ch === '(') {
      const start = i
      const end = skipLiteralString(input, i)
      tokens.push({ raw: input.slice(start, end), start, end, kind: 'string' })
      i = end > i ? end : i + 1
      continue
    }

    // Dictionary must be tested before the hex-string branch: `<<` is not a
    // hex string opener.
    if (ch === '<' && input[i + 1] === '<') {
      const start = i
      const end = skipDictionary(input, i)
      tokens.push({ raw: input.slice(start, end), start, end, kind: 'dict' })
      i = end > i ? end : i + 1
      continue
    }

    // Hex string.
    if (ch === '<') {
      const start = i
      const end = skipHexString(input, i)
      tokens.push({ raw: input.slice(start, end), start, end, kind: 'string' })
      i = end > i ? end : i + 1
      continue
    }

    // Array.
    if (ch === '[') {
      const start = i
      const end = skipArray(input, i)
      tokens.push({ raw: input.slice(start, end), start, end, kind: 'array' })
      i = end > i ? end : i + 1
      continue
    }

    // Name: /Foo, with #xx escapes kept verbatim.
    if (ch === '/') {
      const start = i
      i += 1
      while (i < n && isRegularChar(input[i])) i += 1
      tokens.push({ raw: input.slice(start, i), start, end: i, kind: 'name' })
      if (i === start) i += 1
      continue
    }

    // Number or operator: consume a regular run, then classify.
    const start = i
    while (i < n && isRegularChar(input[i])) i += 1
    if (i === start) {
      // A stray delimiter the branches above did not claim. Emit it as its own
      // token so nothing is lost, and advance so the loop cannot spin.
      i += 1
      tokens.push({ raw: input.slice(start, i), start, end: i, kind: 'operator' })
      continue
    }
    const raw = input.slice(start, i)
    tokens.push({
      raw,
      start,
      end: i,
      kind: /^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw) ? 'number' : 'operator',
    })
  }

  return tokens
}

/** Operators that take no operands but are still operators, for grouping. */
const ALWAYS_OPERATOR = new Set([
  'BT', 'ET', 'q', 'Q', 'W', 'W*', 'n', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'S', 's',
  'T*', 'cm', 're', 'Do', 'EI', 'BI', 'ID', 'gs', 'sh', 'CS', 'cs', 'SC', 'sc', 'SCN',
  'scn', 'G', 'g', 'RG', 'rg', 'K', 'k', 'Tr', 'Ts', 'Tz', 'TL', 'Tc', 'Tw', 'Tf', 'Tm',
  'Td', 'TD', 'Tj', 'TJ', "'", '"', 'd', 'w', 'J', 'j', 'M', 'i', 'ri', 'gs', 'BX', 'EX',
  'MP', 'DP', 'BMC', 'BDC', 'EMC', 'd0', 'd1',
])

/**
 * Group tokens into operations.
 *
 * An operator ends the run of operands that preceded it. Unknown names are
 * treated as operators too (a content stream may use operators this module has
 * no opinion about), so an unrecognised construct degrades to "one operation
 * whose operands we do not interpret" rather than corrupting the grouping.
 */
export function parseOperations(tokens: Token[]): Operation[] {
  const operations: Operation[] = []
  let operands: Token[] = []

  for (const token of tokens) {
    if (token.kind === 'operator') {
      const start = operands.length > 0 ? operands[0].start : token.start
      operations.push({ op: token.raw, operands, start, end: token.end })
      operands = []
      continue
    }
    operands.push(token)
  }

  // Trailing operands with no operator: preserve them rather than dropping
  // data, so a round-trip stays exact even on a malformed tail.
  if (operands.length > 0) {
    operations.push({ op: '', operands, start: operands[0].start, end: operands[operands.length - 1].end })
  }

  return operations
}

/** Rebuild a stream from operations, reproducing untouched spans verbatim. */
export function serializeOperations(operations: Operation[]): string {
  const parts: string[] = []
  for (const operation of operations) {
    for (const operand of operation.operands) parts.push(operand.raw)
    if (operation.op !== '') parts.push(operation.op)
  }
  // Operators are conventionally space-separated; a single space per token is
  // valid and keeps the output stable and diffable.
  return parts.join(' ')
}

/** Whether an operator shows text. */
export function showKindOf(op: string): ShowKind | undefined {
  if (op === 'Tj') return 'Tj'
  if (op === 'TJ') return 'TJ'
  if (op === "'") return 'quote'
  if (op === '"') return 'double-quote'
  return undefined
}

/**
 * Extract the glyph-bearing strings from one show-text operation.
 *
 * `TJ` alternates numbers (kerning) and strings (glyphs). The numbers are not
 * returned but their positions are implied by `strings` order, so a rewrite
 * can reconstruct the array keeping the original spacing values.
 */
export function showStrings(operation: Operation): Token[] {
  const kind = showKindOf(operation.op)
  if (kind === undefined) return []
  if (kind === 'TJ') {
    const arrayToken = operation.operands.find(t => t.kind === 'array')
    if (arrayToken === undefined) return []
    return tokenize(arrayToken.raw.slice(1, -1)).filter(t => t.kind === 'string')
  }
  // Tj and ' take one string; " takes two numbers then the string.
  const strings = operation.operands.filter(t => t.kind === 'string')
  return strings.length > 0 ? [strings[strings.length - 1]] : []
}

/** Decode a hex or literal string token into raw bytes. */
export function stringBytes(token: Token): Uint8Array | undefined {
  const raw = token.raw
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/\s+/g, '')
    const padded = hex.length % 2 === 1 ? hex + '0' : hex
    const out = new Uint8Array(padded.length / 2)
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16)
    return out
  }
  if (raw.startsWith('(')) {
    // Literal strings escape with backslash; decode the common escapes.
    const body = raw.slice(1, -1)
    const out: number[] = []
    for (let i = 0; i < body.length; i += 1) {
      const c = body[i]
      if (c !== '\\') {
        out.push(c.charCodeAt(0) & 0xff)
        continue
      }
      const next = body[i + 1]
      const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }
      if (next in simple) {
        out.push(simple[next])
        i += 1
        continue
      }
      if (next >= '0' && next <= '7') {
        let octal = ''
        let j = i + 1
        while (j < body.length && octal.length < 3 && body[j] >= '0' && body[j] <= '7') {
          octal += body[j]
          j += 1
        }
        out.push(parseInt(octal, 8) & 0xff)
        i = j - 1
        continue
      }
      i += 1
    }
    return new Uint8Array(out)
  }
  return undefined
}

/**
 * Walk a parsed stream and report every show-text step with its text state.
 *
 * Text state is tracked across operators because the stream is stateful: the
 * font comes from `Tf`, the origin from `Tm`/`Td`/`TD`/`T*`, and `BT` resets
 * the matrix to the identity. Only the operators that matter are interpreted;
 * everything else is ignored, so an unusual stream still yields the shows it
 * contains rather than failing.
 *
 * @param operations - parsed operations for ONE content stream.
 * @returns positioned shows in stream order.
 */
export function locateShowText(operations: Operation[]): PositionedShow[] {
  const out: PositionedShow[] = []
  let fontName: string | undefined
  let fontSize: number | undefined
  let textX = 0
  let textY = 0
  let leading = 0

  const asNumber = (token: Token | undefined): number | undefined => {
    if (token === undefined) return undefined
    const value = Number(token.raw)
    return Number.isFinite(value) ? value : undefined
  }

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]

    switch (operation.op) {
      case 'BT':
        textX = 0
        textY = 0
        break
      case 'Tf': {
        const name = operation.operands.find(t => t.kind === 'name')
        const size = asNumber(operation.operands.find(t => t.kind === 'number'))
        fontName = name === undefined ? fontName : name.raw.replace(/^\//, '')
        fontSize = size ?? fontSize
        break
      }
      case 'TL':
        leading = asNumber(operation.operands[0]) ?? leading
        break
      case 'Tm': {
        const numbers = operation.operands.filter(t => t.kind === 'number').map(t => Number(t.raw))
        if (numbers.length >= 6) {
          // Text matrix is [a b c d e f]; e/f are the origin in text space.
          textX = numbers[4]
          textY = numbers[5]
        }
        break
      }
      case 'Td':
      case 'TD': {
        const dx = asNumber(operation.operands[0]) ?? 0
        const dy = asNumber(operation.operands[1]) ?? 0
        if (operation.op === 'TD') leading = -dy
        textX += dx
        textY += dy
        break
      }
      case 'T*':
        textY -= leading
        break
      default:
        break
    }

    const kind = showKindOf(operation.op)
    if (kind === undefined) continue

    out.push({
      index,
      kind,
      operand: operation.operands[operation.operands.length - 1],
      strings: showStrings(operation),
      ...(fontName === undefined ? {} : { fontName }),
      ...(fontSize === undefined ? {} : { fontSize }),
      x: textX,
      y: textY,
    })
  }

  return out
}

/**
 * Rebuild a content stream with a span replaced.
 *
 * @param input - the decoded stream text.
 * @param replacements - `{ start, end, text }` spans, in ANY order; they must
 *   not overlap. Replacement is done right-to-left so earlier offsets stay
 *   valid while later ones are rewritten.
 * @returns the rebuilt stream.
 */
export function replaceSpan(
  input: string,
  replacements: Array<{ start: number; end: number; text: string }>,
): string {
  const ordered = [...replacements].sort((a, b) => b.start - a.start)
  let out = input
  for (const span of ordered) {
    out = out.slice(0, span.start) + span.text + out.slice(span.end)
  }
  return out
}

/** Whether the supplied spans overlap (which makes a patch ill-defined). */
export function spansOverlap(spans: Array<{ start: number; end: number }>): boolean {
  const ordered = [...spans].sort((a, b) => a.start - b.start)
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end) return true
  }
  return false
}

/** Encode glyph ids as a hex string token, as the content stream expects. */
export function hexFromGlyphIds(glyphIds: readonly number[], bytesPerGlyph = 2): string {
  const parts: string[] = []
  for (const id of glyphIds) {
    parts.push(id.toString(16).toUpperCase().padStart(bytesPerGlyph * 2, '0'))
  }
  return '<' + parts.join('') + '>'
}
