/**
 * Page text editing by rewriting the content stream.
 *
 * ## What "editing" means here
 *
 * A page is a program of drawing operators. Text is painted by a show-text
 * operator whose operand is a sequence of GLYPH IDS in the current font's own
 * encoding — `<0001000200030004000500060007000800050009...>` is "服务合同", and
 * only the font's `ToUnicode` CMap knows that. So editing text is not string
 * surgery; it is:
 *
 *   1. find the show-text operation whose painted text you mean to change;
 *   2. get a font that can encode the replacement;
 *   3. rewrite THAT operation's operands, leaving every other byte alone.
 *
 * ## Why a fresh font, not the original subset
 *
 * The scan of a real contract showed 13 separate font resources on one page,
 * each a subset holding only the glyphs its own run needed. A subset has no
 * room for a character it never used, so replacing text cannot reuse it. A new
 * subset is embedded for the replacement and assigned its own resource name;
 * the original fonts are left untouched so the rest of the page renders
 * byte-identically.
 *
 * ## Surgical, and provable
 *
 * Every edit is expressed as a span replacement over the *decoded* stream, and
 * `content-stream` guarantees the untouched spans re-serialise verbatim. The
 * test for this module asserts that property directly, and the accompanying
 * render check compares the untouched region pixel-for-pixel.
 *
 * @module dsh-pdf-studio/core/text-editor
 */

import { deflateSync } from 'node:zlib'
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib'
import {
  locateShowText,
  parseOperations,
  replaceSpan,
  serializeOperations,
  spansOverlap,
  stringBytes,
  tokenize,
} from './content-stream.ts'
import type { PositionedShow } from './content-stream.ts'
import { loadFontkitAdapter, resolveFontForText } from './fonts.ts'
import { readPageFonts, widthOfCode, type FontInfo } from './font-map.ts'

/** One text replacement to apply to a page. */
export interface TextReplacement {
  /**
   * Text as currently painted, used to locate the target operation. Matched
   * against the caller's own extraction (which has the CMap): the value is
   * compared using the run's id, so supply the run's `id` when you have it.
   */
  from?: string
  /** Text to paint instead. */
  to: string
  /** Exact id of the span to replace, when known. Takes precedence over `from`. */
  targetId?: string
  /**
   * Optional override for the font size. Defaults to the size already in
   * effect, which is what keeps the replacement on the same baseline.
   */
  fontSize?: number
  /**
   * When the replacement is narrower than the original, the leftover space can
   * be covered so the old glyphs stop showing. Only meaningful with a raster
   * cover pass, so it is recorded rather than acted on here.
   */
  cover?: boolean
}

/** A decoded content stream, with the reference that owns it. */
export interface ContentStream {
  /** Index in the page's `/Contents` array, or 0 for a single stream. */
  index: number
  /** The stream object's reference, for in-place replacement. */
  ref: unknown
  /** Decoded operator text. */
  text: string
  /** The raw stream object (a `PDFRawStream` in practice). */
  stream: unknown
}

/** One located run, ready to be picked as an edit target. */
export interface EditableRun {
  /** Stable id: `<streamIndex>:<operationIndex>`. */
  id: string
  streamIndex: number
  operationIndex: number
  /** Font resource name as the stream writes it. */
  fontName?: string
  fontSize?: number
  /** Baseline origin in PDF points. */
  x: number
  y: number
  /** Raw glyph operand, exactly as the stream carries it. */
  glyphs: string
  /** Number of glyphs, when the operand is a hex string. */
  glyphCount: number
}

/** Result of one page edit. */
export interface EditResult {
  page: number
  replacementsApplied: number
  /** Ids of the runs that were rewritten. */
  targetIds: string[]
  /** Non-fatal problems worth surfacing. */
  notes: string[]
}

/** Read a PDF string or name operand as plain text. */
function nameText(token: { raw: string }): string {
  return token.raw.replace(/^\//, '')
}

/** Count glyphs in a hex operand (2 bytes per glyph for these CID fonts). */
function glyphCountOf(glyphs: string): number {
  if (!glyphs.startsWith('<')) return 0
  const hex = glyphs.slice(1, -1).replace(/\s+/g, '')
  return Math.floor(hex.length / 4)
}

/**
 * Decode every content stream of a page.
 *
 * `/Contents` may be a single stream or an array of them; a real page used
 * four. Both shapes are normalised to an ordered list so a caller never has to
 * care, and the index is preserved because a patch must target the right one.
 */
export function readPageContentStreams(page: {
  node: { Contents(): unknown }
}, context: { lookup(ref: unknown): unknown }): ContentStream[] {
  const contents = page.node.Contents()
  const refs: unknown[] = []
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) refs.push(contents.get(i))
  } else if (contents !== undefined) {
    refs.push(contents)
  }

  const out: ContentStream[] = []
  for (const [index, ref] of refs.entries()) {
    const stream = context.lookup(ref)
    if (stream === undefined || stream === null) continue
    let decoded: Uint8Array
    try {
      decoded = decodePDFRawStream(stream as never).decode()
    } catch {
      // A stream this build cannot decode is skipped rather than aborting the
      // page: the remaining streams may still be editable.
      continue
    }
    out.push({
      index,
      ref,
      stream,
      text: Buffer.from(decoded).toString('latin1'),
    })
  }
  return out
}

/**
 * List every text run on a page with a stable id.
 *
 * Ids are `<streamIndex>:<operationIndex>`, which is enough to address a run
 * later without carrying object references around the UI.
 */
export function listEditableRuns(streams: readonly ContentStream[]): EditableRun[] {
  const runs: EditableRun[] = []
  for (const stream of streams) {
    const operations = parseOperations(tokenize(stream.text))
    for (const show of locateShowText(operations)) {
      const glyphs = show.strings.map(s => s.raw).join(' ')
      // A show operator may split its glyphs across several strings; the run's
      // true length is the sum, not the first string's.
      const glyphCount = show.strings.reduce((total, part) => total + glyphCountOf(part.raw), 0)
      runs.push({
        id: `${stream.index}:${show.index}`,
        streamIndex: stream.index,
        operationIndex: show.index,
        ...(show.fontName === undefined ? {} : { fontName: show.fontName }),
        ...(show.fontSize === undefined ? {} : { fontSize: show.fontSize }),
        x: show.x,
        y: show.y,
        glyphs,
        glyphCount,
      })
    }
  }
  return runs
}

/** Locate one run by id, with the stream and operation it lives in. */
function findRun(
  streams: readonly ContentStream[],
  targetId: string,
): { stream: ContentStream; operations: ReturnType<typeof parseOperations>; show: PositionedShow } | undefined {
  const [streamIndexText, operationIndexText] = targetId.split(':')
  const streamIndex = Number(streamIndexText)
  const operationIndex = Number(operationIndexText)
  if (!Number.isFinite(streamIndex) || !Number.isFinite(operationIndex)) return undefined

  const stream = streams.find(s => s.index === streamIndex)
  if (stream === undefined) return undefined
  const operations = parseOperations(tokenize(stream.text))
  const shows = locateShowText(operations)
  const show = shows.find(s => s.index === operationIndex)
  if (show === undefined) return undefined
  return { stream, operations, show }
}

/**
 * Rewrite show-text runs on a page.
 *
 * The replacement is an operand swap on the located operation: the font
 * resource is re-selected with `Tf` and the new glyph string is shown at the
 * text matrix already in force, so the baseline and every surrounding operator
 * are untouched. A new subset is embedded only for the text that changed.
 *
 * A rewritten stream is registered as a NEW object and the page's `/Contents`
 * array is rebuilt to point at it. Replacing the entry (rather than mutating
 * the existing stream's internals) keeps the swap within pdf-lib's public
 * model: `PDFRawStream.of` plus `context.register`.
 *
 * @returns a summary of what was rewritten, plus notes worth reporting.
 */
export async function replacePageText(
  pdf: {
    embedFont(bytes: Uint8Array, options?: { subset?: boolean }): Promise<{
      ref: unknown
      name: string
      encodeText(text: string): { toString(): string }
    }>
    registerFontkit(adapter: unknown): void
  },
  page: { node: { Contents(): unknown; Resources(): { lookup(key: unknown, type?: unknown): unknown } } },
  replacements: readonly TextReplacement[],
  options: {
    fonts?: { path?: string }
    context: {
      lookup(ref: unknown): unknown
      register(value: unknown): unknown
      obj(value: unknown): unknown
    }
  },
): Promise<EditResult> {
  const context = options.context
  const streams = readPageContentStreams(page as never, context)
  // Metrics are needed to warn when a replacement will not fit the space the
  // original occupied, so the page's fonts are read here rather than left to
  // the caller.
  const fonts = readPageFonts(context as never, page as never)
  const result: EditResult = { page: 0, replacementsApplied: 0, targetIds: [], notes: [] }

  if (replacements.length === 0) return result

  const targets: Array<{ targetId: string; replacement: TextReplacement }> = []
  for (const replacement of replacements) {
    if (replacement.targetId === undefined) {
      result.notes.push('缺少 targetId：请先用 listEditableRuns() 取到 run.id 再改写')
      continue
    }
    if (findRun(streams, replacement.targetId) === undefined) {
      result.notes.push(`找不到目标 ${replacement.targetId}，已跳过`)
      continue
    }
    targets.push({ targetId: replacement.targetId, replacement })
  }
  if (targets.length === 0) return result

  // Embed one subset per distinct font file, so several edits on a page do not
  // embed the same face repeatedly.
  const fontkit = await loadFontkitAdapter()
  if (fontkit !== null) pdf.registerFontkit(fontkit)

  // 页面可能没有自己的 /Resources（继承自页树），也可能有 /Resources 但没有 /Font —— 
  // 前者要建一份**页面私有**的副本（否则会把子集字体名写进兄弟页面共享的字典），
  // 后者不能用会抛异常的 lookup。这两条以前都会让编辑一页无字体的页面直接失败。
  const node = (page as unknown as {
    node: { get(key: unknown): unknown; set(key: unknown, value: unknown): void }
  }).node
  const ownResources = node.get(PDFName.of('Resources'))
  let resources = page.node.Resources() as unknown as {
    lookupMaybe?(key: unknown, type?: unknown): unknown
    set?(key: unknown, value: unknown): void
    entries?(): Iterable<[unknown, unknown]>
  } | undefined
  if (resources === undefined || ownResources === undefined) {
    const copy = (context as unknown as { obj(value: unknown): unknown }).obj({}) as {
      set(key: unknown, value: unknown): void
    }
    for (const [key, value] of resources?.entries?.() ?? []) copy.set(key, value)
    node.set(PDFName.of('Resources'), copy)
    resources = copy as never
  }
  const existingFonts = resources?.lookupMaybe?.(PDFName.of('Font'), PDFDict)
  const fontDict = existingFonts instanceof PDFDict
    ? existingFonts
    : PDFDict.withContext((context as unknown as { obj(value: unknown): unknown }).obj({}) as never)

  const embeddedByPath = new Map<string, { font: Awaited<ReturnType<typeof pdf.embedFont>>; key: string }>()
  const editsByStream = new Map<number, Array<{ start: number; end: number; text: string }>>()
  /**
   * Font-name and size operands, keyed by their offset so a shared `Tf` is
   * rewritten once no matter how many runs are shown under it.
   */
  const fontSpans = new Map<number, { start: number; end: number; text: string }>()
  const sizeSpans = new Map<number, { start: number; end: number; text: string }>()

  for (const { targetId, replacement } of targets) {
    const found = findRun(streams, targetId)
    if (found === undefined) continue
    const { stream, operations, show } = found

    const loaded = await resolveFontForText(replacement.to, options.fonts?.path)
    if (loaded === null) {
      result.notes.push(`没有可用字体渲染「${replacement.to}」，已跳过`)
      continue
    }

    let entry = embeddedByPath.get(loaded.path)
    if (entry === undefined) {
      const font = await pdf.embedFont(loaded.bytes, { subset: true })

      // pdf-lib wires a font into /Resources only when it draws text itself.
      // This module writes the operators by hand, so the resource entry is
      // established here under a name guaranteed not to collide.
      const taken = new Set(fontDict.keys().map(key => key.toString().replace(/^\//, '')))
      let key = font.name
      let suffix = 0
      while (taken.has(key)) {
        suffix += 1
        key = `${font.name}-E${suffix}`
      }
      fontDict.set(PDFName.of(key), font.ref as never)
      entry = { font, key }
      embeddedByPath.set(loaded.path, entry)
    }

    const encoded = entry.font.encodeText(replacement.to).toString()
    // Size: prefer the caller's override, else the `Tf` size already in force.
    // A show operator carries only glyph strings, so the size lives on the
    // preceding `Tf` and must be looked up by scanning back.
    const size = replacement.fontSize ?? show.fontSize ?? 12
    const sizeText = Number.isInteger(size) ? String(size) : size.toFixed(2)

    const strings = show.strings
    if (strings.length === 0) {
      result.notes.push(`${targetId} 没有可替换的字形串，已跳过`)
      continue
    }

    // Replace the whole text-state window as ONE span: from the `Tf` name
    // operand through the last glyph string. Two separate spans (font name,
    // glyph operand) proved fragile: when the font-name span is dropped, the
    // stream selects the OLD font but shows the NEW subset's glyph ids, so the
    // text paints as garbage and extracts as nothing. A single contiguous
    // rewrite cannot desynchronise font from glyphs.
    //
    // `Tm` sits before `Tf` in the streams this pipeline handles, so it stays
    // outside the replaced window and the baseline is preserved exactly.
    // `Tf` is its own operator, emitted before the show operator — its operands
    // are NOT on the show op. Scan back for the nearest `Tf`, which is the one
    // in force for this run (a stream may set several across blocks).
    let fontToken: { start: number; end: number; raw: string; kind: string } | undefined
    let sizeToken: { start: number; end: number; raw: string; kind: string } | undefined
    for (let index = show.index - 1; index >= 0; index -= 1) {
      const candidate = operations[index]
      if (candidate.op !== 'Tf') continue
      fontToken = candidate.operands.find(token => token.kind === 'name') as typeof fontToken
      sizeToken = candidate.operands.find(token => token.kind === 'number') as typeof sizeToken
      break
    }
    if (fontToken === undefined) {
      result.notes.push(`${targetId} 之前找不到 Tf 字体选择，已跳过`)
      continue
    }
    const sizeInWindow = sizeToken !== undefined && replacement.fontSize === undefined
      ? sizeToken.raw
      : sizeText

    const lastString = strings[strings.length - 1]
    const spans = editsByStream.get(stream.index) ?? []

    // Warn about overflow before it becomes a visual surprise. Measured with
    // each font's OWN metrics, which is the only honest way: the replacement
    // face rarely matches the original's advance widths, so "same character
    // count" is not "same width".
    const originalSize = replacement.fontSize ?? show.fontSize ?? 0
    const originalInfo = show.fontName === undefined ? undefined : fonts.get(show.fontName)
    if (originalInfo !== undefined && originalSize > 0) {
      let originalUnits = 0
      const codeWidth = originalInfo.decoder?.map.codeBytes ?? 2
      for (const part of strings) {
        const bytes = stringBytes(part)
        if (bytes === undefined) continue
        for (let i = 0; i + codeWidth <= bytes.length; i += codeWidth) {
          let code = 0
          for (let b = 0; b < codeWidth; b += 1) code = (code << 8) | bytes[i + b]
          originalUnits += widthOfCode(originalInfo, code)
        }
      }
      // The freshly embedded subset has no `/W` yet, so its glyphs measure at
      // the font's default width. That is an estimate, and it is labelled as
      // one in the note.
      const newUnits = replacement.to.length * 1000
      const originalPt = (originalUnits / 1000) * originalSize
      const newPt = (newUnits / 1000) * originalSize
      if (newPt > originalPt * 1.02) {
        result.notes.push(
          `${targetId} 替换后预计宽约 ${newPt.toFixed(1)}pt（估算），超过原 ${originalPt.toFixed(1)}pt，可能向右溢出`,
        )
      }
    }

    // Replace the GLYPH OPERANDS and the FONT NAME as separate spans, and
    // deduplicate the font name by position.
    //
    // The obvious alternative — one span from the `Tf` name through the last
    // glyph string — cannot express a multi-run edit: consecutive runs normally
    // SHARE a single `Tf` (a stream sets the font once and then shows many
    // strings), so every run's window would start at the same `Tf` and the spans
    // would overlap. The whole stream is then skipped as unsafe, which is
    // exactly what happened when deleting 23 page-number characters at once:
    // "改写区间重叠，已跳过", 0 applied.
    //
    // Glyph operands sit at distinct offsets by construction, so per-operand
    // spans can never overlap. The font name is emitted once per token.
    spans.push({ start: strings[0].start, end: strings[0].end, text: encoded })
    for (const extra of strings.slice(1)) {
      // An empty hex string is a valid operand that paints nothing.
      spans.push({ start: extra.start, end: extra.end, text: '<>' })
    }

    if (show.fontName !== entry.key) {
      fontSpans.set(fontToken.start, {
        start: fontToken.start,
        end: fontToken.end,
        text: `/${entry.key}`,
      })
    }
    if (replacement.fontSize !== undefined && sizeToken !== undefined) {
      sizeSpans.set(sizeToken.start, {
        start: sizeToken.start,
        end: sizeToken.end,
        text: sizeInWindow,
      })
    }

    editsByStream.set(stream.index, spans)
    result.targetIds.push(targetId)
  }

  // Fold the deduplicated font and size spans into each stream's edit list.
  for (const [streamIndex, spans] of editsByStream) {
    for (const span of [...fontSpans.values(), ...sizeSpans.values()]) {
      spans.push(span)
    }
    editsByStream.set(streamIndex, spans)
  }

  // Rebuild each edited stream, register it, and repoint /Contents.
  const contents = page.node.Contents()
  const replaceInArray = contents instanceof PDFArray
  const newRefs = new Map<number, unknown>()

  for (const [streamIndex, spans] of editsByStream) {
    if (spansOverlap(spans)) {
      result.notes.push(`第 ${streamIndex} 号内容流的改写区间重叠，已跳过以避免流损坏`)
      continue
    }
    const stream = streams.find(candidate => candidate.index === streamIndex)
    if (stream === undefined) continue

    const rebuilt = replaceSpan(stream.text, spans)
    const deflated = new Uint8Array(deflateSync(Buffer.from(rebuilt, 'latin1')))
    const dict = context.obj({ Filter: 'FlateDecode', Length: deflated.length })
    const fresh = PDFRawStream.of(dict as never, deflated)
    const ref = context.register(fresh)
    newRefs.set(streamIndex, ref)

  }

  if (replaceInArray && newRefs.size > 0) {
    const array = contents as PDFArray
    for (let i = 0; i < array.size(); i += 1) {
      const entry = array.get(i)
      for (const [streamIndex, ref] of newRefs) {
        const original = streams.find(candidate => candidate.index === streamIndex)
        if (original !== undefined && entry === original.ref) array.set(i, ref as never)
      }
    }
  } else if (!replaceInArray && newRefs.size > 0) {
    const only = [...newRefs.values()][0]
    ;(page.node as unknown as { set(key: unknown, value: unknown): void }).set(PDFName.of('Contents'), only)
  }

  // If this page had no /Font dict at all, install the one we populated.
  if (!(existingFonts instanceof PDFDict)) {
    resources?.set?.(PDFName.of('Font'), fontDict)
  }

  // `replacementsApplied` counts TARGETS, not spans and not streams. A single
  // edit can emit several spans (its glyph operands plus a shared font or size
  // token) and many edits share one stream, so neither of those is the number a
  // caller means by "how many changes were applied". `targetIds` is exactly the
  // set of edits that were turned into spans.
  result.replacementsApplied = result.targetIds.length
  return result
}

/** Marker export so the module's intent is greppable from a test. */
export const TEXT_EDITOR_MODULE = 'dsh-pdf-studio/core/text-editor'

/* -------------------------------------------------------------------------- */
/* readable runs: the editable model a canvas needs                           */
/* -------------------------------------------------------------------------- */

/** An editable run with its decoded text, i.e. what a user can actually read. */
export interface ReadableRun extends EditableRun {
  /** Decoded text, or `undefined` when the font carries no usable ToUnicode. */
  text?: string
  /** Why `text` is missing, when it is. */
  textUnavailable?: 'no-font' | 'no-tounicode' | 'decode-empty'
  /** Advance width of the run in points, from the font metrics. */
  widthPt?: number
  /** Text-space advance computed from `/W`, for overflow checks after an edit. */
  advanceUnits?: number
}

/**
 * List every text run on a page together with its decoded text.
 *
 * This is the read side of the editable model: a canvas shows `text`, the user
 * edits it, and `replacePageText` addresses the same run by `id`. Font metrics
 * are attached so an editor can warn that a replacement will not fit the space
 * the original occupied.
 *
 * @param fonts - the page's font map, from `readPageFonts`.
 */
export function listReadableRuns(
  streams: readonly ContentStream[],
  fonts: Map<string, FontInfo>,
): ReadableRun[] {
  const runs: ReadableRun[] = []
  for (const stream of streams) {
    const operations = parseOperations(tokenize(stream.text))
    for (const show of locateShowText(operations)) {
      const glyphs = show.strings.map(part => part.raw).join(' ')
      const glyphCount = show.strings.reduce((total, part) => total + glyphCountOf(part.raw), 0)

      const info = show.fontName === undefined ? undefined : fonts.get(show.fontName)
      let text: string | undefined
      let textUnavailable: ReadableRun['textUnavailable']
      let advanceUnits: number | undefined

      if (show.fontName === undefined || info === undefined) {
        textUnavailable = 'no-font'
      } else if (info.decoder === undefined) {
        textUnavailable = 'no-tounicode'
      } else {
        // Decode each string, then join. A run may be split across several
        // strings purely to break up long hex, so joining is the right thing.
        const parts: string[] = []
        for (const part of show.strings) {
          const bytes = stringBytes(part)
          if (bytes === undefined) continue
          parts.push(info.decoder.decodeBytes(bytes))
          if (advanceUnits === undefined) advanceUnits = 0
          for (let i = 0; i + info.decoder.map.codeBytes <= bytes.length; i += info.decoder.map.codeBytes) {
            let code = 0
            for (let b = 0; b < info.decoder.map.codeBytes; b += 1) {
              code = (code << 8) | bytes[i + b]
            }
            advanceUnits += widthOfCode(info, code)
          }
        }
        const decoded = parts.join('')
        if (decoded === '' && glyphCount > 0) textUnavailable = 'decode-empty'
        else text = decoded
      }

      const size = show.fontSize ?? 0
      runs.push({
        id: `${stream.index}:${show.index}`,
        streamIndex: stream.index,
        operationIndex: show.index,
        ...(show.fontName === undefined ? {} : { fontName: show.fontName }),
        ...(show.fontSize === undefined ? {} : { fontSize: show.fontSize }),
        x: show.x,
        y: show.y,
        glyphs,
        glyphCount,
        ...(text === undefined ? {} : { text }),
        ...(textUnavailable === undefined ? {} : { textUnavailable }),
        ...(advanceUnits === undefined || size === 0
          ? {}
          : { advanceUnits, widthPt: (advanceUnits / 1000) * size }),
      })
    }
  }
  return runs
}
