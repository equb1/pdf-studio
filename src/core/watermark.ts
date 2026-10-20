/**
 * Watermarks: adding them, and removing the ones that are removable.
 *
 * ## Why the two halves are not symmetrical
 *
 * Adding is pure addition: paint more content, touch nothing existing. Removal
 * is the hard half, and its difficulty is not a property of the code — it is a
 * property of HOW the watermark was written into the file:
 *
 * | written as | removable? | why |
 * |---|---|---|
 * | a Form XObject the page invokes with `Do` | yes, exactly | the invocation is one operator; deleting it removes the whole mark and nothing else |
 * | operators inline in the page stream | usually, heuristically | the mark is indistinguishable in kind from real content; only its geometry and graphics state set it apart |
 * | rasterised into the page image | no | the pixels are the page; separating them is image inpainting and is inherently lossy |
 * | drawn as real content by the author | no | it is content |
 *
 * So `removeWatermarks` reports candidates with a confidence and a reason, and
 * `removeWatermarks({ apply: true })` removes only the ones it can justify. It
 * never claims "any watermark can be removed" — that claim would be false, and
 * a tool that silently half-removes a mark is worse than one that explains.
 *
 * ## The addition form is chosen for removability
 *
 * `addWatermark` writes the mark as a **single Form XObject invoked by one `Do`
 * operator per page**, and records its identity in the XObject's `/Name`. That
 * is both the most compact representation and the one that makes a later
 * removal exact rather than heuristic — a deliberate design choice, not an
 * accident.
 *
 * @module dsh-pdf-studio/core/watermark
 */

import { deflateSync } from 'node:zlib'
import { loadPdfForWrite } from './pdf.ts'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib'
import {
  locateShowText,
  parseOperations,
  spansOverlap,
  tokenize,
  type Operation,
  type Token,
} from './content-stream.ts'
import { loadFontkitAdapter, resolveFontForText } from './fonts.ts'
import { readPageContentStreams } from './text-editor.ts'

/** Where a watermark sits on the page. */
export type WatermarkPlacement =
  /** Repeated across the page in a diagonal grid — the classic "CONFIDENTIAL". */
  | 'tile'
  /** One large mark centred on the page. */
  | 'center'
  /** Anchored to a corner or edge, given by `corner`. */
  | 'corner'

/** What to draw. Exactly one of `text` / `image` is used. */
export interface WatermarkSpec {
  /** Text to draw. */
  text?: string
  /** Image bytes (PNG/JPEG) to draw instead of text. */
  image?: Uint8Array
  placement?: WatermarkPlacement
  /**
   * How the mark is written into the file.
   *
   * `text` (the default) paints real glyphs: searchable, copyable, and it needs
   * an embedded font. `outline` paints the very same glyph shapes as filled
   * paths: visually identical, but it contributes nothing to the text layer, so
   * the mark cannot be found by search, lifted by copy/paste, or mistaken for
   * document content by an extractor. It also drops the font embedding, which
   * makes the output smaller rather than larger.
   */
  render?: 'text' | 'outline'
  /**
   * Wrap the invocation in an `/Artifact` marked-content block (default true).
   *
   * A watermark is decoration, not content: tagging it as an artifact is what
   * keeps assistive technology and PDF/UA checkers from reading it as body
   * text. This is orthogonal to `render` — `outline` keeps it out of the text
   * layer, `artifact` keeps it out of the document's logical content.
   */
  artifact?: boolean
  /** Corner for `placement: 'corner'`; defaults to `'bottom-right'`. */
  corner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  /** Rotation in degrees, counter-clockwise. Defaults to 45 for tile, 0 otherwise. */
  rotation?: number
  /** Opacity 0..1. Defaults to 0.15 — visible, but not competing with content. */
  opacity?: number
  /** Fill colour as `#rrggbb`. Defaults to a neutral red. */
  color?: string
  /** Font size in points for tiled/centred marks. Defaults to 48. */
  fontSize?: number
  /** Margin in points for corner placement. Defaults to 24. */
  margin?: number
  /** Explicit font file for text that needs glyphs the standard fonts lack. */
  fontPath?: string
  /** Pages to stamp, 1-based. Defaults to every page. */
  pages?: number[]
}

/** Outcome of a stamping run. */
export interface AddWatermarkResult {
  pages: number
  /** The Form XObject name recorded on every stamped page, for later matching. */
  xobjectName: string
  /** Text actually drawn, after any glyph filtering. */
  textDrawn: string
  /** Characters dropped because the chosen font could not encode them. */
  droppedChars: string[]
  /** Which painting mode was used. */
  render: 'text' | 'outline' | 'image'
  /** Whether the invocation was wrapped in an `/Artifact` block. */
  artifact: boolean
  notes: string[]
}

/** Parse `#rrggbb` into 0..1 components. */
function parseColor(value: string | undefined): { r: number; g: number; b: number } {
  const fallback = { r: 0.85, g: 0.15, b: 0.15 }
  if (value === undefined) return fallback
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim())
  if (match === null) return fallback
  const n = parseInt(match[1], 16)
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >> 8) & 0xff) / 255,
    b: (n & 0xff) / 255,
  }
}

/** Serialise a number compactly, as content streams conventionally do. */
function n(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/** Escape a string for a PDF literal string operand. */
function pdfLiteral(text: string): string {
  return '(' + text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')'
}

/**
 * Split text into what a standard (Helvetica) font can draw and what it cannot.
 *
 * Exported because the reporting of dropped characters has been wrong once
 * already — the predicate was inverted, so the characters named as lost were the
 * survivors — and a pure function is the only shape of this logic that a test can
 * pin down without a machine that lacks a CJK font.
 */
export function splitDrawableText(text: string): { drawable: string; dropped: string[] } {
  const dropped: string[] = []
  for (const char of text) if (!/[\x20-\x7e]/.test(char)) dropped.push(char)
  return { drawable: text.replace(/[^\x20-\x7e]/g, ''), dropped }
}

/** Identity tag written into the Form XObject so a later scan can recognise it. */
export const WATERMARK_MARKER = 'dsh-pdf-studio-watermark'

/** Resource name of the inner mark inside the watermark XObject. */
const MARK_RESOURCE_NAME = 'WMMark'
/** Resource name of the image inside the inner mark. */
const IMAGE_RESOURCE_NAME = 'WMImg'
/** Resource name of the font inside the inner mark. */
const FONT_RESOURCE_NAME = 'WMFont'

/** The bounding box of a `width` × `height` box turned by `degrees`. */
function rotatedAabb(width: number, height: number, degrees: number): { width: number; height: number } {
  if (degrees === 0) return { width, height }
  const radians = (degrees * Math.PI) / 180
  const absCos = Math.abs(Math.cos(radians))
  const absSin = Math.abs(Math.sin(radians))
  return {
    width: width * absCos + height * absSin,
    height: width * absSin + height * absCos,
  }
}

/** The visible region of a page, in page coordinates. */
function pageRegion(page: {
  getCropBox(): { x: number; y: number; width: number; height: number }
}): { x: number; y: number; width: number; height: number } {
  // `getCropBox` falls back to the MediaBox when no CropBox is declared, so this
  // is the visible area either way. Placement used to be computed from the
  // MediaBox, which puts a "centred" mark off-centre on any page whose CropBox is
  // inset — a common shape for print-ready PDFs.
  const box = page.getCropBox()
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

/** Everything the placement maths needs to know about one page. */
interface MarkGeometry {
  regionX: number
  regionY: number
  regionWidth: number
  regionHeight: number
  placement: WatermarkPlacement
  corner: NonNullable<WatermarkSpec['corner']>
  rotation: number
  fontSize: number
  margin: number
}

/**
 * Centres of every tile, chosen so that no rotated mark crosses a page edge.
 *
 * The grid used to start a full stride OUTSIDE the page and let the Form's BBox
 * cut off whatever hung over, which sliced glyphs in half along all four edges
 * (and left clipped fragments like `部资料` in the text layer). Here the mark's
 * own rotated box is fitted INSIDE the visible region, and the columns and rows
 * are spread evenly across the space that remains: every tile is complete, and
 * the page is still covered edge to edge.
 */
function tileCentres(
  geometry: MarkGeometry,
  markWidth: number,
  markHeight: number,
): Array<[number, number]> {
  const box = rotatedAabb(markWidth, markHeight, geometry.rotation)
  const guard = Math.max(0, geometry.margin)
  const availableWidth = geometry.regionWidth - box.width - guard * 2
  const availableHeight = geometry.regionHeight - box.height - guard * 2

  if (availableWidth < 0 || availableHeight < 0) {
    // The mark does not fit even once (an oversized font on a small page): a
    // single centred mark is the only placement that is not clipped twice over.
    return [[geometry.regionX + geometry.regionWidth / 2, geometry.regionY + geometry.regionHeight / 2]]
  }

  const strideX = Math.max(120, geometry.fontSize * 6)
  const strideY = Math.max(120, geometry.fontSize * 4)
  const columns = Math.max(1, Math.floor(availableWidth / strideX) + 1)
  const rows = Math.max(1, Math.floor(availableHeight / strideY) + 1)
  const stepX = columns > 1 ? availableWidth / (columns - 1) : 0
  const stepY = rows > 1 ? availableHeight / (rows - 1) : 0

  const centres: Array<[number, number]> = []
  for (let row = 0; row < rows; row += 1) {
    const y = geometry.regionY + guard + box.height / 2 + row * stepY
    // Odd rows are offset by half a step for the classic diagonal look; that row
    // then carries one tile fewer, so it still ends inside the page.
    const offset = row % 2 === 1 && columns > 1 ? stepX / 2 : 0
    const count = offset === 0 ? columns : columns - 1
    for (let column = 0; column < count; column += 1) {
      centres.push([geometry.regionX + guard + box.width / 2 + offset + column * stepX, y])
    }
  }
  return centres
}

/** Top-left corner of a single (non-tiled) mark, kept inside the page. */
function anchorFor(geometry: MarkGeometry, width: number, height: number): [number, number] {
  const { regionX, regionY, regionWidth, regionHeight, placement, corner, margin } = geometry
  let x: number
  let y: number
  if (placement === 'center') {
    x = regionX + (regionWidth - width) / 2
    y = regionY + (regionHeight - height) / 2
  } else {
    switch (corner) {
      case 'top-left':
        x = regionX + margin
        y = regionY + regionHeight - height - margin
        break
      case 'top-right':
        x = regionX + regionWidth - width - margin
        y = regionY + regionHeight - height - margin
        break
      case 'bottom-left':
        x = regionX + margin
        y = regionY + margin
        break
      default:
        x = regionX + regionWidth - width - margin
        y = regionY + margin
        break
    }
  }
  // The mark only needs rescuing when it genuinely cannot respect the margin on
  // both sides. In that case centre it (equal overflow on both sides) — clamping
  // it into the margin range instead would silently cancel the centring, i.e.
  // trade the MediaBox bug for an off-centre bug.
  const fits = width + margin * 2 <= regionWidth && height + margin * 2 <= regionHeight
  if (fits) return [x, y]
  return [
    regionX + (regionWidth - width) / 2,
    regionY + (regionHeight - height) / 2,
  ]
}

/**
 * Build the watermark Form XObject's body for one page geometry.
 *
 * The body draws nothing of its own: it invokes the shared inner mark once per
 * placement. That indirection is what keeps an outlined mark cheap — the glyph
 * outlines are stored in the file once and merely transformed per tile, instead
 * of being repeated for every tile.
 */
function buildWatermarkBody(
  geometry: MarkGeometry,
  markWidth: number,
  markHeight: number,
  markResource: string,
): string {
  const ops: string[] = ['q', '/GSW gs']

  const place = (centreX: number, centreY: number): void => {
    ops.push('q')
    ops.push(`1 0 0 1 ${n(centreX - markWidth / 2)} ${n(centreY - markHeight / 2)} cm`)
    if (geometry.rotation !== 0) {
      const radians = (geometry.rotation * Math.PI) / 180
      const cos = Math.cos(radians)
      const sin = Math.sin(radians)
      // Rotate about the mark's own centre, so it stays where it was placed.
      ops.push(`1 0 0 1 ${n(markWidth / 2)} ${n(markHeight / 2)} cm`)
      ops.push(`${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} 0 0 cm`)
      ops.push(`1 0 0 1 ${n(-markWidth / 2)} ${n(-markHeight / 2)} cm`)
    }
    ops.push(`/${markResource} Do`)
    ops.push('Q')
  }

  if (geometry.placement === 'tile') {
    for (const [centreX, centreY] of tileCentres(geometry, markWidth, markHeight)) {
      place(centreX, centreY)
    }
  } else {
    const [x, y] = anchorFor(geometry, markWidth, markHeight)
    place(x + markWidth / 2, y + markHeight / 2)
  }

  ops.push('Q')
  return ops.join('\n')
}

/** A glyph outline command, as fontkit reports it. */
interface OutlineCommand {
  command: string
  args: number[]
}

/** The slice of a fontkit font that outline drawing needs. */
interface OutlineFont {
  unitsPerEm?: number
  layout(text: string): {
    glyphs: Array<{ path?: { commands?: OutlineCommand[] } }>
    positions: Array<{ xAdvance: number; xOffset?: number }>
  }
}

/** Resolve a fontkit font object for outline drawing, or `undefined`. */
function createOutlineFont(adapter: Record<string, unknown>, bytes: Uint8Array): OutlineFont | undefined {
  const create = adapter.create as ((data: Uint8Array) => unknown) | undefined
  if (typeof create !== 'function') return undefined
  try {
    const font = create(bytes) as OutlineFont | undefined
    return font !== undefined && typeof font.layout === 'function' ? font : undefined
  } catch {
    return undefined
  }
}

/**
 * Turn text into filled path operators.
 *
 * This is what makes `render: 'outline'` possible: the glyphs come from the same
 * font `text` mode would embed, but they are written as Bézier curves, so
 * nothing about the mark is text — no search hit, no copy/paste, nothing for an
 * extractor to mistake for content. TrueType outlines are quadratic and PDF has
 * no quadratic operator, so each curve is raised to its exact cubic equivalent.
 */
function outlineOpsFor(
  text: string,
  font: OutlineFont,
  fontSize: number,
  color: { r: number; g: number; b: number },
): { body: string; width: number; height: number } {
  const unitsPerEm = font.unitsPerEm === undefined || font.unitsPerEm === 0 ? 1000 : font.unitsPerEm
  const scale = fontSize / unitsPerEm
  // The same baseline lift `text` mode applies, so switching modes does not move
  // the mark.
  const baseline = fontSize * 0.2
  const parts: string[] = [`${n(color.r)} ${n(color.g)} ${n(color.b)} rg`]
  const run = font.layout(text)
  let pen = 0

  run.glyphs.forEach((glyph, index) => {
    const position = run.positions[index]
    const x0 = pen + (position?.xOffset ?? 0)
    const point = (x: number, y: number): string => `${n((x0 + x) * scale)} ${n(y * scale + baseline)}`
    let currentX = 0
    let currentY = 0
    for (const command of glyph.path?.commands ?? []) {
      const args = command.args
      switch (command.command) {
        case 'moveTo':
          parts.push(`${point(args[0], args[1])} m`)
          currentX = args[0]
          currentY = args[1]
          break
        case 'lineTo':
          parts.push(`${point(args[0], args[1])} l`)
          currentX = args[0]
          currentY = args[1]
          break
        case 'quadraticCurveTo': {
          // p0 + 2/3 (q - p0) and p2 + 2/3 (q - p2) is the exact cubic form of a
          // quadratic from p0 through control q to p2.
          const c1x = currentX + (2 / 3) * (args[0] - currentX)
          const c1y = currentY + (2 / 3) * (args[1] - currentY)
          const c2x = args[2] + (2 / 3) * (args[0] - args[2])
          const c2y = args[3] + (2 / 3) * (args[1] - args[3])
          parts.push(`${point(c1x, c1y)} ${point(c2x, c2y)} ${point(args[2], args[3])} c`)
          currentX = args[2]
          currentY = args[3]
          break
        }
        case 'bezierCurveTo':
          parts.push(`${point(args[0], args[1])} ${point(args[2], args[3])} ${point(args[4], args[5])} c`)
          currentX = args[4]
          currentY = args[5]
          break
        case 'closePath':
          parts.push('h')
          break
        default:
          break
      }
    }
    pen += position?.xAdvance ?? 0
  })

  // One non-zero fill for every contour: TrueType winding is already non-zero.
  parts.push('f')
  return { body: parts.join('\n'), width: pen * scale, height: fontSize }
}

/** Advance width of `text`, falling back to a per-character estimate. */
function drawnWidth(
  font: { widthOfTextAtSize(text: string, size: number): number },
  text: string,
  fontSize: number,
): number {
  try {
    const width = font.widthOfTextAtSize(text, fontSize)
    if (Number.isFinite(width) && width > 0) return width
  } catch {
    // Fall through to the estimate.
  }
  let units = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xff00 && code <= 0xff60)
    units += wide ? 1 : 0.5
  }
  return units * fontSize
}

/**
 * Stamp a watermark onto a document's pages.
 *
 * The mark is built in two layers, and that split is what makes it both cheap
 * and clean:
 *
 *   - an **inner mark** XObject holds the drawable content exactly once — a glyph
 *     run, a set of glyph outlines, or an image;
 *   - an **outer watermark** XObject, one per distinct page geometry, places that
 *     inner mark wherever the placement asks and carries the identity tag a later
 *     removal matches on.
 *
 * Nothing existing is rewritten: each page only gains one `Do` invocation in a
 * new content stream. The page's own streams are referenced, never copied —
 * copying them is what used to double the document's content on every run.
 */
export async function addWatermark(
  sourceBytes: Uint8Array,
  spec: WatermarkSpec,
): Promise<{ bytes: Uint8Array; result: AddWatermarkResult }> {
  let doc: PDFDocument
  try {
    // `updateMetadata: false` keeps the SOURCE's /ModDate and /Producer. pdf-lib
    // otherwise restamps /ModDate with the current time on every save, which makes
    // two runs over the same input produce different bytes — and makes content
    // hashes useless for verifying that a stamping run changed only the mark.
    doc = await loadPdfForWrite(sourceBytes, { updateMetadata: false })
  } catch (error) {
    if (/encrypt/i.test(String((error as Error | undefined)?.message ?? ''))) {
      throw new Error(
        '这份 PDF 已加密，没有密码就无法加水印。请先用 pdf_protect action=decrypt 解除保护，或改用已解密的副本。',
      )
    }
    throw error
  }

  const notes: string[] = []
  const droppedChars: string[] = []
  const placement = spec.placement ?? 'tile'
  const rotation = spec.rotation ?? (placement === 'tile' ? 45 : 0)
  const opacity = Math.min(1, Math.max(0, spec.opacity ?? 0.15))
  const color = parseColor(spec.color)
  const fontSize = spec.fontSize ?? 48
  const margin = spec.margin ?? 24
  const corner = spec.corner ?? 'bottom-right'
  const artifact = spec.artifact ?? true

  // ── the inner mark: what is drawn, independent of page geometry ───────────
  const markOps: string[] = []
  let markFont: { name: string; ref: unknown } | undefined
  let markImage: { name: string; ref: unknown } | undefined
  let markWidth = fontSize
  let markHeight = fontSize * 1.15
  let textDrawn = ''
  let effectiveRender: AddWatermarkResult['render'] = spec.render ?? 'text'

  if (spec.image !== undefined) {
    const isPng = spec.image[0] === 0x89 && spec.image[1] === 0x50
    const embedded = isPng ? await doc.embedPng(spec.image) : await doc.embedJpg(spec.image)
    // NOT `void ref`: the image object has to end up in the inner mark's
    // /XObject resources. Dropping it there — as this code used to — emitted a
    // `/WMImg Do` that resolved to nothing and then reported success for a blank
    // mark, which is the worst possible outcome for a stamping tool.
    markImage = { name: IMAGE_RESOURCE_NAME, ref: embedded.ref }
    markOps.push(
      'q',
      `${n(embedded.width)} 0 0 ${n(embedded.height)} 0 0 cm`,
      `/${IMAGE_RESOURCE_NAME} Do`,
      'Q',
    )
    markWidth = embedded.width
    markHeight = embedded.height
    effectiveRender = 'image'
    notes.push('图片水印：按原始像素尺寸绘制，未做缩放')
  } else {
    const text = spec.text ?? 'WATERMARK'
    let outlined = false

    if (effectiveRender === 'outline') {
      const adapter = await loadFontkitAdapter()
      const loaded = await resolveFontForText(text, spec.fontPath)
      const font = adapter === null || loaded === null ? undefined : createOutlineFont(adapter, loaded.bytes)
      if (font !== undefined) {
        const outline = outlineOpsFor(text, font, fontSize, color)
        markOps.push(outline.body)
        markWidth = outline.width
        textDrawn = text
        outlined = true
      } else {
        notes.push('轮廓模式（render: outline）无法加载字体，已退回文字模式')
      }
    }

    if (!outlined) {
      effectiveRender = 'text'
      const loaded = await resolveFontForText(text, spec.fontPath)
      if (loaded !== null) {
        const fontkit = await loadFontkitAdapter()
        if (fontkit !== null) doc.registerFontkit(fontkit as never)
        const font = await doc.embedFont(loaded.bytes, { subset: true })
        markFont = { name: FONT_RESOURCE_NAME, ref: font.ref }
        // The operand MUST be the font's encoded glyph string, not the text: a
        // subset font renumbers its glyphs, so writing the literal characters
        // paints whatever glyphs happen to sit at those codes.
        markOps.push(
          `BT /${FONT_RESOURCE_NAME} ${n(fontSize)} Tf ${n(color.r)} ${n(color.g)} ${n(color.b)} rg `
          + `1 0 0 1 0 ${n(fontSize * 0.2)} Tm ${font.encodeText(text).toString()} Tj ET`,
        )
        markWidth = drawnWidth(font, text, fontSize)
        textDrawn = text
      } else {
        const standard = await doc.embedFont(StandardFonts.HelveticaBold)
        // The predicate here used to be inverted, so the characters reported as
        // dropped were exactly the ones that had survived.
        const { drawable, dropped } = splitDrawableText(text)
        droppedChars.push(...dropped)
        if (drawable === '') {
          throw new Error(
            `水印文字「${text}」既不能用轮廓模式绘制，系统中也没有可编码它的字体（Helvetica 无法表示非拉丁字符）`,
          )
        }
        markFont = { name: FONT_RESOURCE_NAME, ref: standard.ref }
        markOps.push(
          `BT /${FONT_RESOURCE_NAME} ${n(fontSize)} Tf ${n(color.r)} ${n(color.g)} ${n(color.b)} rg `
          + `1 0 0 1 0 ${n(fontSize * 0.2)} Tm ${standard.encodeText(drawable).toString()} Tj ET`,
        )
        markWidth = drawnWidth(standard, drawable, fontSize)
        textDrawn = drawable
        if (drawable !== text) {
          notes.push('未找到可编码该文字的系统字体，已改用 Helvetica 并丢弃非拉丁字符')
        }
      }
    }
  }

  if (spec.image === undefined && textDrawn === '') {
    throw new Error('水印内容为空：没有可绘制的文字，也没有提供图片')
  }
  if (!(markWidth > 0)) markWidth = fontSize
  // A text block is at least a line high; an image is exactly its own pixels, and
  // inflating that would push the picture off its own centre.
  if (spec.image === undefined) markHeight = Math.max(markHeight, fontSize * 1.15)

  const markStream = PDFRawStream.of(
    doc.context.obj({
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      // Deliberately generous, because the BBox clips: ascenders and descenders
      // reach outside the em box, and cutting them off would be a silent loss.
      BBox: [
        -fontSize * 0.5,
        -fontSize * 0.5,
        markWidth + fontSize * 0.5,
        markHeight + fontSize * 0.5,
      ],
      Name: MARK_RESOURCE_NAME,
      Resources: doc.context.obj({
        ...(markFont === undefined ? {} : { Font: doc.context.obj({ [markFont.name]: markFont.ref } as never) }),
        ...(markImage === undefined ? {} : { XObject: doc.context.obj({ [markImage.name]: markImage.ref } as never) }),
      }),
    }) as never,
    deflateSync(Buffer.from(markOps.join('\n'), 'latin1')),
  )
  ;(markStream as { dict: PDFDict }).dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'))
  const markRef = doc.context.register(markStream)

  // ── the outer watermark: one per distinct page geometry ───────────────────
  const outerCache = new Map<string, PDFRef>()
  const outerFor = (geometry: MarkGeometry): PDFRef => {
    const key = [
      geometry.regionX,
      geometry.regionY,
      geometry.regionWidth,
      geometry.regionHeight,
      geometry.placement,
      geometry.rotation,
      geometry.margin,
    ].join('|')
    const cached = outerCache.get(key)
    if (cached !== undefined) return cached

    const body = buildWatermarkBody(geometry, markWidth, markHeight, MARK_RESOURCE_NAME)
    const stream = PDFRawStream.of(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        // Authored in page coordinates, so the BBox is the page's visible region:
        // the mark is clipped to the page rather than spilling into the bleed,
        // and — because the tile grid is fitted inside it — no glyph is ever cut
        // in half by it.
        BBox: [
          geometry.regionX,
          geometry.regionY,
          geometry.regionX + geometry.regionWidth,
          geometry.regionY + geometry.regionHeight,
        ],
        Name: WATERMARK_MARKER,
        Resources: doc.context.obj({
          XObject: doc.context.obj({ [MARK_RESOURCE_NAME]: markRef }),
          ExtGState: doc.context.obj({ GSW: doc.context.obj({ ca: opacity, CA: opacity }) }),
        }),
      }) as never,
      deflateSync(Buffer.from(body, 'latin1')),
    )
    ;(stream as { dict: PDFDict }).dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'))
    const ref = doc.context.register(stream)
    outerCache.set(key, ref)
    return ref
  }

  // ── pages ─────────────────────────────────────────────────────────────────
  const pages = doc.getPages()
  const requested = spec.pages === undefined ? pages.map((_, index) => index + 1) : spec.pages
  const targets = requested.filter(page => Number.isInteger(page) && page >= 1 && page <= pages.length)
  const outOfRange = requested.filter(page => !targets.includes(page))
  if (targets.length === 0) {
    // Stamping nothing and reporting success is how `pages: 0` used to look like
    // a completed job.
    throw new Error(`pages 里没有有效页号：文档共 ${pages.length} 页，收到 ${JSON.stringify(requested)}`)
  }
  if (outOfRange.length > 0) {
    notes.push(`已忽略超出范围的页号：${outOfRange.join(', ')}（文档共 ${pages.length} 页）`)
  }

  for (const pageNumber of targets) {
    const page = pages[pageNumber - 1]
    if (page === undefined) continue
    const region = pageRegion(page as never)
    const outerRef = outerFor({
      regionX: region.x,
      regionY: region.y,
      regionWidth: region.width,
      regionHeight: region.height,
      placement,
      corner,
      rotation,
      fontSize,
      margin,
    })

    const resources = pageResources(page as never, doc.context as never)
    const xobjects = ensureXObjectDict(resources, doc.context as never)
    xobjects.set(PDFName.of(WATERMARK_MARKER), outerRef)

    // Re-stamping replaces the mark instead of stacking a second one: the
    // resource entry now points at the new XObject, and an existing invocation of
    // the same name already paints it. Appending unconditionally would double the
    // mark's opacity and leave the previous object behind for nothing.
    const alreadyInvoked = readPageContentStreams(page as never, doc.context as never)
      .some(stream => new RegExp(`/${WATERMARK_MARKER}\\s+Do`).test(stream.text))
    if (alreadyInvoked) continue

    const invocation = artifact
      // `/Artifact` says "this is decoration, not content": assistive technology
      // and PDF/UA checkers then skip the mark instead of reading it as body text.
      ? `\n/Artifact <</Type /Pagination /Subtype /Watermark>> BDC\nq /${WATERMARK_MARKER} Do Q\nEMC\n`
      : `\nq /${WATERMARK_MARKER} Do Q\n`
    appendPageContent(page as never, doc.context as never, invocation)
  }

  const bytes = await doc.save()
  return {
    bytes,
    result: {
      pages: targets.length,
      xobjectName: WATERMARK_MARKER,
      textDrawn,
      droppedChars: [...new Set(droppedChars)],
      render: effectiveRender,
      artifact,
      notes,
    },
  }
}

/** The slice of a page node these helpers touch. */
interface PageNodeLike {
  get(name: PDFName): unknown
  set(name: PDFName, value: unknown): void
}

/** The slice of a PDF context these helpers touch. */
interface ContextLike {
  lookup(value: unknown): unknown
  obj(literal: unknown): unknown
  register(value: unknown): PDFRef
}

/** Walk up the page tree looking for an inherited `/Resources`. */
function inheritedResources(node: PageNodeLike, context: ContextLike): PDFDict | undefined {
  let parent = node.get(PDFName.of('Parent'))
  let depth = 0
  while (parent !== undefined && depth < 64) {
    depth += 1
    const resolved = context.lookup(parent)
    if (resolved === undefined || resolved === null) return undefined
    const dict = resolved as PDFDict
    const own = dict.get(PDFName.of('Resources'))
    if (own !== undefined) {
      const found = context.lookup(own)
      if (found instanceof PDFDict) return found
    }
    parent = dict.get(PDFName.of('Parent'))
  }
  return undefined
}

/**
 * The page's own resource dictionary.
 *
 * A page may declare none (relying on the page tree) or borrow an indirect one
 * that sibling pages share. Both cases get a page-private copy: writing into a
 * shared dictionary would list the watermark on pages that were never stamped,
 * and a page with no `/Resources` anywhere used to crash the whole run on
 * `undefined.lookup(...)`.
 */
function pageResources(page: { node: PageNodeLike }, context: ContextLike): PDFDict {
  const own = page.node.get(PDFName.of('Resources'))
  if (own !== undefined && !(own instanceof PDFRef)) {
    const resolved = context.lookup(own)
    if (resolved instanceof PDFDict) return resolved
  }
  const copy = context.obj({}) as PDFDict
  const source = own !== undefined ? context.lookup(own) : inheritedResources(page.node, context)
  if (source instanceof PDFDict) {
    for (const [key, value] of source.entries()) copy.set(key, value)
  }
  page.node.set(PDFName.of('Resources'), copy)
  return copy
}

/**
 * The page's `/XObject` sub-dictionary, or `undefined`.
 *
 * `PDFDict.lookup(key, Type)` THROWS when the key is absent (it does not return
 * `undefined`), so a page whose `/Resources` exists but carries no `/XObject`
 * entry — a shape pdf-lib's own writer produces — took down the whole scan and
 * the whole removal. `get` plus a type check cannot throw.
 */
function readXObjectDict(resources: PDFDict | undefined, context: ContextLike): PDFDict | undefined {
  if (resources === undefined) return undefined
  const entry = resources.get(PDFName.of('XObject'))
  if (entry === undefined) return undefined
  const resolved = context.lookup(entry)
  return resolved instanceof PDFDict ? resolved : undefined
}

/** The page's `/XObject` sub-dictionary, copied when the current one may be shared. */
function ensureXObjectDict(resources: PDFDict, context: ContextLike): PDFDict {
  const current = resources.get(PDFName.of('XObject'))
  if (current !== undefined && !(current instanceof PDFRef)) {
    const resolved = context.lookup(current)
    if (resolved instanceof PDFDict) return resolved
  }
  const copy = context.obj({}) as PDFDict
  if (current !== undefined) {
    const resolved = context.lookup(current)
    if (resolved instanceof PDFDict) {
      for (const [key, value] of resolved.entries()) copy.set(key, value)
    }
  }
  resources.set(PDFName.of('XObject'), copy)
  return copy
}

/**
 * Append operators to a page's content as a NEW stream.
 *
 * `page.node.Contents()` resolves indirect objects, and building the new array
 * out of the resolved value is what inlined a copy of the page's own content
 * into the page dictionary and orphaned the original stream — doubling the
 * document's content on every run. `get` returns the reference, so the array
 * points at the existing streams instead of copying them.
 */
function appendPageContent(page: { node: PageNodeLike }, context: ContextLike, operators: string): void {
  const stream = PDFRawStream.of(
    context.obj({ Filter: 'FlateDecode' }) as never,
    deflateSync(Buffer.from(operators, 'latin1')),
  )
  const ref = context.register(stream)
  const raw = page.node.get(PDFName.of('Contents'))
  if (raw === undefined) {
    page.node.set(PDFName.of('Contents'), ref)
    return
  }
  const resolved = raw instanceof PDFRef ? context.lookup(raw) : raw
  if (resolved instanceof PDFArray) {
    resolved.push(ref)
    return
  }
  page.node.set(PDFName.of('Contents'), context.obj([raw, ref]))
}

/* -------------------------------------------------------------------------- */
/* detection and removal                                                      */
/* -------------------------------------------------------------------------- */

/** Why a candidate is believed to be a watermark. */
export type WatermarkReason =
  /** Invoked through a Form XObject named as a watermarking tool would name it. */
  | 'named-xobject'
  /**
   * The Form XObject carries Acrobat's own watermark identity:
   * `/PieceInfo << /ADBE_CompoundType << /Private /Watermark >> >>`.
   */
  | 'adobe-watermark'
  /**
   * The page content stream draws it inside an
   * `/Artifact << … /Subtype /Watermark … >> BDC … EMC` block.
   */
  | 'artifact-wrapper'
  /**
   * The page content stream draws it inside a page-decoration artifact
   * (`/Artifact << … /Subtype /Header|/Footer|/Pagination … >> BDC … EMC`)
   * instead of a `/Watermark` one, and the object itself carries all three
   * mark-shaped traits: a text-only body, a `/BBox` covering a sliver of the
   * page, and the same resource invoked on several pages.
   */
  | 'pagination-artifact'
  /** Invoked through a Form XObject with no name, but a mark-like body. */
  | 'invisible-xobject'
  /** Drawn inline with a non-trivial rotation. */
  | 'rotated-text'

/** One removable candidate. */
export interface WatermarkCandidate {
  page: number
  kind: 'xobject' | 'inline'
  reason: WatermarkReason
  /** 0..1; the caller decides whether to act. */
  confidence: number
  /** XObject resource name, for `kind: 'xobject'`. */
  xobjectName?: string
  /** Content-stream index, for `kind: 'inline'`. */
  streamIndex?: number
  /** Operator span covering the suspected mark, for `kind: 'inline'`. */
  span?: { start: number; end: number }
  /** Human-readable explanation, shown to the user before acting. */
  detail: string
}

/** What a scan found. */
export interface WatermarkScan {
  candidates: WatermarkCandidate[]
  /** Pages examined. */
  pages: number
  /** Things that looked watermark-ish but were deliberately NOT offered. */
  refused: Array<{ page: number; detail: string }>
}

/**
 * Whether a `PieceInfo` dictionary carries Acrobat's watermark identity.
 *
 * Acrobat writes `/PieceInfo << /ADBE_CompoundType << /Private /Watermark >> >>`
 * on the Form XObject it uses for a mark. The compound entry may name further
 * dictionaries (`/DocSettings`, `/LastModified`) and the key order is not
 * guaranteed, so this walks the dictionary recursively instead of requiring
 * `ADBE_CompoundType` and `Private` to be adjacent, or even on the first level.
 */
function pieceInfoMarksWatermark(pieceInfo: PDFDict, context: ContextLike, depth = 0): boolean {
  if (depth > 8) return false
  const compoundRaw = pieceInfo.get(PDFName.of('ADBE_CompoundType'))
  if (compoundRaw !== undefined) {
    const compound = context.lookup(compoundRaw)
    if (compound instanceof PDFDict) {
      const privateValue = context.lookup(compound.get(PDFName.of('Private')))
      if (privateValue instanceof PDFName && privateValue.asString() === '/Watermark') return true
    }
  }
  for (const [, value] of pieceInfo.entries()) {
    if (value === compoundRaw) continue
    const nested = context.lookup(value)
    if (nested instanceof PDFDict && pieceInfoMarksWatermark(nested, context, depth + 1)) return true
  }
  return false
}

/** Whether a Form XObject's dictionary declares itself an Acrobat watermark. */
function hasAdobeWatermarkPieceInfo(dict: PDFDict, context: ContextLike): boolean {
  const pieceInfoRaw = dict.get(PDFName.of('PieceInfo'))
  if (pieceInfoRaw === undefined) return false
  const pieceInfo = context.lookup(pieceInfoRaw)
  return pieceInfo instanceof PDFDict && pieceInfoMarksWatermark(pieceInfo, context)
}

/**
 * `/Artifact` subtypes that tag **page decoration** rather than body copy.
 *
 * A mark that a publishing site stamps on every page is often written as a
 * `Header` artifact rather than a `Watermark` one (the tool that produced it
 * treats the line as running furniture). `/Watermark` is deliberately absent:
 * it is conclusive on its own and handled before this set is consulted.
 */
const PAGE_DECORATION_SUBTYPES = new Set(['/Header', '/Footer', '/Pagination'])

/**
 * Confidence for a page-decoration artifact that also looks like a mark.
 *
 * Below the `0.9` removal threshold on purpose: a real running header is a
 * `Header` artifact with a text-only body, so repetition and a small `/BBox`
 * narrow the field without ever proving the case. The candidate is reported so
 * the user can say "yes, those are the watermark"; it is never removed silently.
 */
const PAGINATION_ARTIFACT_CONFIDENCE = 0.7

/** A mark must repeat on at least this many pages to be judged page furniture. */
const PAGINATION_MARK_MIN_PAGES = 2

/** Above this share of the visible page area, the object is furniture, not a mark. */
const PAGINATION_MARK_MAX_AREA_RATIO = 0.05

/**
 * The `/Subtype` of the artifact one `BDC` operand run opens, or `undefined`.
 *
 * The properties dictionary may be written inline
 * (`/Artifact<</Subtype/Watermark/Type/Pagination>> BDC`) or as an indirect
 * reference (`/Artifact 12 0 R BDC`). The indirect form is resolved through the
 * document context; if it cannot be resolved the answer is `undefined`, never a
 * guess.
 */
function artifactSubtypeOf(operands: readonly Token[], context: ContextLike): string | undefined {
  const tag = operands.find(token => token.kind === 'name' && token.raw === '/Artifact')
  if (tag === undefined) return undefined

  const dictToken = operands.find(token => token.kind === 'dict')
  if (dictToken !== undefined) {
    // `tokenize` returns a whole `<< … >>` as ONE dict token, so the braces are
    // stripped before reading the keys. `/Subtype` and its value may be
    // separated by any whitespace and either may sit next to other keys, so
    // match the adjacent name TOKENS.
    const inner = dictToken.raw.startsWith('<<') && dictToken.raw.endsWith('>>')
      ? dictToken.raw.slice(2, -2)
      : dictToken.raw
    const names = tokenize(inner).filter(token => token.kind === 'name')
    for (let i = 0; i < names.length - 1; i += 1) {
      if (names[i].raw === '/Subtype') return names[i + 1].raw
    }
    return undefined
  }

  // Indirect form. The tokeniser classifies `R` as an unknown operator, which is
  // why `artifactWrappedInvocations` keeps it in the operand run.
  const refIndex = operands.findIndex(token => token.kind === 'operator' && token.raw === 'R')
  if (refIndex < 2) return undefined
  const objectNumber = operands[refIndex - 2]
  const generationNumber = operands[refIndex - 1]
  if (objectNumber.kind !== 'number' || generationNumber.kind !== 'number') return undefined
  const target = context.lookup(PDFRef.of(Number(objectNumber.raw), Number(generationNumber.raw)))
  if (!(target instanceof PDFDict)) return undefined
  const subtype = context.lookup(target.get(PDFName.of('Subtype')))
  return subtype instanceof PDFName ? subtype.asString() : undefined
}

/**
 * Whether one `BDC` operand run opens an `/Artifact` whose `/Subtype` is
 * `/Watermark`.
 */
function artifactWatermarkOperands(operands: readonly Token[], context: ContextLike): boolean {
  return artifactSubtypeOf(operands, context) === '/Watermark'
}

/**
 * Every `Do` that sits inside a *named-subtype* `/Artifact … BDC … EMC` block,
 * as resource name → the artifact subtypes it was drawn under.
 *
 * This is a generic signal — the page itself declares the invocation to be an
 * artifact — and it is what makes an Adobe mark detectable even when its XObject
 * carries no name of ours and its body is a single `Tj`. Returning the subtype
 * (rather than a boolean) is what lets the caller separate the conclusive
 * `/Watermark` case from the merely suggestive page-decoration one.
 */
function artifactWrappedInvocations(text: string, context: ContextLike): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const open: Array<string | undefined> = []
  let operands: Token[] = []
  for (const token of tokenize(text)) {
    // `R` is the indirect-reference operator, not a content operator: leaving it
    // in the operand run is what makes `/Artifact 12 0 R BDC` resolvable.
    if (token.kind !== 'operator' || token.raw === 'R') {
      operands.push(token)
      continue
    }
    if (token.raw === 'BDC' || token.raw === 'BMC') {
      // `BMC` carries a tag but no properties dictionary, so it names no subtype.
      open.push(token.raw === 'BDC' ? artifactSubtypeOf(operands, context) : undefined)
    } else if (token.raw === 'EMC') {
      open.pop()
    } else if (token.raw === 'Do') {
      const subtype = open[open.length - 1]
      if (subtype !== undefined) {
        const name = operands.filter(token2 => token2.kind === 'name').pop()
        if (name !== undefined) {
          const key = name.raw.replace(/^\//, '')
          const subtypes = found.get(key) ?? []
          subtypes.push(subtype)
          found.set(key, subtypes)
        }
      }
    }
    operands = []
  }
  return found
}

/** Operators that paint geometry; a mark made of text has none of them. */
const PATH_OPERATORS = new Set([
  'm', 'l', 'c', 'v', 'y', 'h', 're',
  'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n',
  'W', 'W*', 'sh', 'BI', 'ID', 'EI',
])

/**
 * Whether an artifact-wrapped Form XObject is shaped like a mark.
 *
 * Three conditions, all required, none of them sufficient on its own — which is
 * exactly why the verdict is a medium-confidence candidate and not a silent
 * deletion:
 *
 *   1. **Text only.** The body shows glyphs and paints no geometry and invokes
 *      no nested object. A page header assembled from rules and logos fails here.
 *   2. **A sliver of the page.** The `/BBox` covers at most
 *      `PAGINATION_MARK_MAX_AREA_RATIO` of the visible page.
 *   3. **Substance.** The body actually draws something; an empty artifact
 *      wrapper is debris, not a watermark.
 *
 * Repetition across pages is the third trait, and it is decided by the caller
 * because it is a property of the document rather than of one page.
 */
function paginationMarkVerdict(
  page: { getCropBox(): { width: number; height: number } },
  dict: PDFDict,
  body: string,
  context: ContextLike,
): { ok: boolean; why: string } {
  const operations = parseOperations(tokenize(body))
  const paints = operations.filter(op => PATH_OPERATORS.has(op.op))
  if (paints.length > 0) {
    return { ok: false, why: `它的内容流里有 ${paints.length} 个绘制几何图形的算子（${paints[0].op}），不是纯文字对象` }
  }
  if (operations.some(op => op.op === 'Do')) {
    return { ok: false, why: '它会调用别的 XObject，不是纯文字对象' }
  }
  const draws = operations.some(op => op.op === 'Tj' || op.op === 'TJ' || op.op === "'" || op.op === '"')
  if (!draws) return { ok: false, why: '它没有画出任何文字' }

  const bboxRaw = dict.get(PDFName.of('BBox'))
  const bbox = bboxRaw === undefined ? undefined : context.lookup(bboxRaw)
  if (!(bbox instanceof PDFArray) || bbox.size() < 4) {
    return { ok: false, why: '它没有 /BBox，无法判断它占多大' }
  }
  const numbers = [0, 1, 2, 3].map(i => {
    const value = context.lookup(bbox.get(i))
    return value instanceof PDFNumber ? value.asNumber() : Number.NaN
  })
  if (numbers.some(value => !Number.isFinite(value))) {
    return { ok: false, why: '它的 /BBox 不是四个数字' }
  }
  const area = Math.abs(numbers[2] - numbers[0]) * Math.abs(numbers[3] - numbers[1])
  const pageBox = page.getCropBox()
  const pageArea = Math.abs(pageBox.width * pageBox.height)
  if (!(pageArea > 0)) return { ok: false, why: '页面可见区域面积为零，无法比较' }
  const ratio = area / pageArea
  if (ratio > PAGINATION_MARK_MAX_AREA_RATIO) {
    const percent = (ratio * 100).toFixed(1)
    return {
      ok: false,
      why: `它占了页面 ${percent}%，超过 ${PAGINATION_MARK_MAX_AREA_RATIO * 100}% 上限，更像版面元素而不是水印`,
    }
  }
  return { ok: true, why: '' }
}

/**
 * Locate likely watermarks.
 *
 * ## Detection strategy, and its honest limits
 *
 * Five signals are used, in decreasing order of reliability:
 *
 * 1. **A Form XObject invocation with a self-declared identity.** A name of ours
 *    (`/Name` containing `WATERMARK_MARKER`) is conclusive, and so is Acrobat's
 *    own `/PieceInfo << /ADBE_CompoundType << /Private /Watermark >> >>`, which
 *    is how Adobe-style marks identify themselves.
 * 2. **A `/Watermark` artifact wrapper in the page content stream.** A `Do`
 *    inside `/Artifact << … /Subtype /Watermark … >> BDC … EMC` is declared
 *    decoration by the file itself — a structural signal that does not depend on
 *    how many operators the target happens to contain.
 * 3. **A page-decoration artifact that looks like a mark.** The same wrapper
 *    with `/Subtype /Header` (or `/Footer`, `/Pagination`): how publishing sites
 *    stamp a "search us on WeChat" line, and how this signal was found missing.
 *    It is reported at `PAGINATION_ARTIFACT_CONFIDENCE` — below the default
 *    removal threshold — because a genuine running header has the same shape.
 * 4. **An unnamed XObject with a mark-like body.** Judged by constant alpha plus
 *    at least one drawing operator, at a low confidence only, because an
 *    ordinary illustration can have the same shape.
 * 5. **Rotated inline text.** A rotation is rare in body copy and near-universal
 *    in diagonal watermarks, so a text block drawn under a non-trivial `cm`
 *    rotation is reported — at a lower confidence, because a rotated heading is
 *    also a legitimate design.
 *
 * What is NOT detected, deliberately: a mark rasterised into the page image, and
 * one drawn as ordinary unrotated content. Both are indistinguishable from the
 * page by these signals, and reporting them would produce either no candidates
 * or false positives that damage real content. They are surfaced in `refused`
 * with the reason, so the UI can tell the user the truth instead of showing an
 * empty list — and so is every artifact-wrapped object that was seen and judged
 * *not* to be a watermark, which used to be dropped in silence.
 */
export async function scanWatermarks(bytes: Uint8Array): Promise<WatermarkScan> {
  const doc = await loadPdfForWrite(bytes, { updateMetadata: false })
  const candidates: WatermarkCandidate[] = []
  const refused: WatermarkScan['refused'] = []
  const pages = doc.getPages()

  /**
   * Mark-shaped page-decoration artifacts, held back until the whole document
   * has been read: "repeats across pages" is a property of the file, not of one
   * page, so a single-page sighting cannot be judged while walking pages.
   */
  const deferred: Array<{ key: string; page: number; subtype: string; candidate: WatermarkCandidate }> = []
  /** Objects that were seen and judged not to be watermarks, per page. */
  const nearMiss = new Map<number, string[]>()
  /** Per-page facts needed for the honest "nothing found here" note. */
  const pageFacts: Array<{ page: number; hasText: boolean }> = []

  const noteNearMiss = (page: number, detail: string): void => {
    const list = nearMiss.get(page) ?? []
    list.push(detail)
    nearMiss.set(page, list)
  }

  for (const [index, page] of pages.entries()) {
    const pageNumber = index + 1
    // `Resources()` walks the page tree, so an inherited dictionary is found
    // too; it is `undefined` only for a page that declares none anywhere, which
    // used to be a hard crash here.
    const resources = page.node.Resources()
    const xobjects = readXObjectDict(resources, doc.context as never)
    const streams = readPageContentStreams(page as never, doc.context as never)

    // ── 1. XObject invocations ─────────────────────────────────────────────
    const invoked = new Map<string, number>()
    const artifactWrapped = new Map<string, string[]>()
    for (const stream of streams) {
      const operations = parseOperations(tokenize(stream.text))
      for (const op of operations) {
        if (op.op !== 'Do') continue
        const name = op.operands.find(token => token.kind === 'name')
        if (name === undefined) continue
        const key = name.raw.replace(/^\//, '')
        invoked.set(key, (invoked.get(key) ?? 0) + 1)
      }
      for (const [name, subtypes] of artifactWrappedInvocations(stream.text, doc.context as never)) {
        artifactWrapped.set(name, [...(artifactWrapped.get(name) ?? []), ...subtypes])
      }
    }

    for (const [name, count] of invoked) {
      const ref = xobjects instanceof PDFDict ? xobjects.get(PDFName.of(name)) : undefined
      const obj = ref === undefined ? undefined : doc.context.lookup(ref)
      if (!(obj instanceof PDFRawStream)) continue
      const dict = obj.dict
      const declaredName = dict.get(PDFName.of('Name'))
      const declared = declaredName === undefined ? '' : declaredName.toString()

      let body = ''
      try {
        body = Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1')
      } catch {
        continue
      }

      if (declared.includes(WATERMARK_MARKER)) {
        candidates.push({
          page: pageNumber,
          kind: 'xobject',
          reason: 'named-xobject',
          confidence: 1,
          xobjectName: name,
          detail: `页面通过 /${name} 调用了一个带水印标识的 Form XObject（出现 ${count} 次）`,
        })
        continue
      }

      if (hasAdobeWatermarkPieceInfo(dict, doc.context as never)) {
        candidates.push({
          page: pageNumber,
          kind: 'xobject',
          reason: 'adobe-watermark',
          confidence: 1,
          xobjectName: name,
          detail: `该 Form XObject 的 /PieceInfo 带 ADBE_CompoundType /Private /Watermark 标识，`
            + `属于 Acrobat 系水印对象（页面通过 /${name} 调用，出现 ${count} 次）`,
        })
        continue
      }

      if (artifactWrapped.get(name)?.includes('/Watermark') === true) {
        candidates.push({
          page: pageNumber,
          kind: 'xobject',
          reason: 'artifact-wrapper',
          confidence: 1,
          xobjectName: name,
          detail: `该 XObject 由 /Artifact<</Subtype/Watermark>> … BDC … EMC 包裹绘制，`
            + `是文件自述的装饰对象（页面通过 /${name} 调用，出现 ${count} 次）`,
        })
        continue
      }

      // A page-decoration artifact (`/Header`, `/Footer`, `/Pagination`) is how
      // a publishing site stamps its own line onto every page, and it is NOT
      // conclusive: a genuine running header carries the very same tag. It only
      // becomes a candidate when the object itself is mark-shaped, and even then
      // at a confidence below the default removal threshold.
      const decoration = (artifactWrapped.get(name) ?? []).find(subtype => PAGE_DECORATION_SUBTYPES.has(subtype))
      if (decoration !== undefined) {
        const verdict = paginationMarkVerdict(page as never, dict, body, doc.context as never)
        if (verdict.ok) {
          deferred.push({
            key: name,
            page: pageNumber,
            subtype: decoration,
            candidate: {
              page: pageNumber,
              kind: 'xobject',
              reason: 'pagination-artifact',
              confidence: PAGINATION_ARTIFACT_CONFIDENCE,
              xobjectName: name,
              detail: `该 XObject 由 /Artifact<</Subtype${decoration}>> … BDC … EMC 包裹绘制，`
                + `且是纯文字的零碎小对象（页面通过 /${name} 调用，出现 ${count} 次）`,
            },
          })
        } else {
          noteNearMiss(pageNumber, `第 ${pageNumber} 页有一个 /Artifact<</Subtype${decoration}>> 包裹的 XObject /${name}，`
            + `但${verdict.why}，未列为水印候选`)
        }
        continue
      }

      // An unnamed XObject is judged on its body. A mark is small, uses a
      // constant alpha, and draws at least one operator (a single short `Tj` is
      // quite enough — Acrobat writes exactly that).
      const hasAlpha = /\/[A-Za-z0-9]+ gs/.test(body)
      const textOps = (body.match(/Tj|TJ/g) ?? []).length
      const pathOps = (body.match(/\bre\b|\bf\b|\bS\b/g) ?? []).length

      const looksLikeMark = hasAlpha && textOps + pathOps >= 1 && body.length < 20000
      if (looksLikeMark) {
        candidates.push({
          page: pageNumber,
          kind: 'xobject',
          reason: 'invisible-xobject',
          confidence: 0.45,
          xobjectName: name,
          detail: `页面调用了未命名的 Form XObject /${name}，其内容含常透明度与至少一个绘制算子，可能是水印（需人工确认）`,
        })
      }
    }

    // ── 2. rotated inline text ─────────────────────────────────────────────
    for (const stream of streams) {
      const operations = parseOperations(tokenize(stream.text))
      let rotation: number | undefined
      let ctmStack: number[] = []
      let alpha: number | undefined

      for (const op of operations) {
        if (op.op === 'q') {
          ctmStack.push(rotation ?? 0)
          continue
        }
        if (op.op === 'Q') {
          rotation = ctmStack.pop()
          continue
        }
        if (op.op === 'cm') {
          const values = op.operands.filter(token => token.kind === 'number').map(token => Number(token.raw))
          if (values.length >= 6) {
            const angle = (Math.atan2(values[1], values[0]) * 180) / Math.PI
            const magnitude = Math.abs(angle)
            // Only a pronounced rotation is interesting; sub-degree values are
            // rounding noise from ordinary matrices.
            rotation = magnitude > 5 && magnitude < 355 ? angle : 0
          }
          continue
        }
        if (op.op === 'gs') {
          alpha = undefined
          continue
        }
        if (op.op === 'ca') {
          const value = op.operands.find(token => token.kind === 'number')
          if (value !== undefined) alpha = Number(value.raw)
        }
      }

      const rotatedShows = locateShowText(operations).filter((show) => {
        // Re-derive per-show rotation by replaying the stream's `cm` operators
        // up to that point; a single rotation variable cannot describe a stream
        // with several graphics-state blocks.
        return rotationOfAt(operations, show.index) !== 0
      })

      for (const show of rotatedShows) {
        const angle = rotationOfAt(operations, show.index)
        const text = show.strings.map(part => part.raw).join(' ')
        const operationsSpan = spanForShow(operations, show.index)
        candidates.push({
          page: pageNumber,
          kind: 'inline',
          reason: 'rotated-text',
          confidence: Math.abs(angle) > 15 ? 0.6 : 0.35,
          streamIndex: stream.index,
          ...(operationsSpan === undefined ? {} : { span: operationsSpan }),
          detail: `第 ${stream.index} 号内容流中有一段被旋转 ${angle.toFixed(0)}° 的文字（字形 ${text.slice(0, 24)}），`
            + '斜向文字常见于水印，但也可能是版式设计',
        })
      }
      void alpha
    }

    pageFacts.push({ page: pageNumber, hasText: streams.some(stream => /Tj|TJ/.test(stream.text)) })
  }

  // ── 3. repetition, the trait that needs the whole document ───────────────
  const pagesByName = new Map<string, number[]>()
  for (const item of deferred) {
    pagesByName.set(item.key, [...(pagesByName.get(item.key) ?? []), item.page])
  }
  for (const item of deferred) {
    const seen = pagesByName.get(item.key) ?? []
    if (seen.length >= PAGINATION_MARK_MIN_PAGES) {
      candidates.push({
        ...item.candidate,
        detail: `${item.candidate.detail}；同一对象在 ${seen.length} 页上重复出现，符合跨页重复的水印特征。`
          + `置信度 ${PAGINATION_ARTIFACT_CONFIDENCE} 低于默认删除门槛 0.9，`
          + `确认为水印后请用 minConfidence=${PAGINATION_ARTIFACT_CONFIDENCE} 显式移除`,
      })
    } else {
      noteNearMiss(item.page, `第 ${item.page} 页的 /Artifact<</Subtype${item.subtype}>> 对象 /${item.key} 只出现 ${seen.length} 页，`
        + `未达到跨页重复（≥ ${PAGINATION_MARK_MIN_PAGES} 页）的水印判据，未列为候选`)
    }
  }

  // Nothing structural stood out on a page: say so rather than implying clean,
  // and when an artifact-wrapped object WAS seen and rejected, say that instead —
  // "found nothing" and "found something I will not act on" are different facts,
  // and only the second one lets a user tell the tool it was wrong.
  for (const facts of pageFacts) {
    if (candidates.some(candidate => candidate.page === facts.page)) continue
    const notes = nearMiss.get(facts.page)
    if (notes !== undefined) {
      for (const detail of notes) refused.push({ page: facts.page, detail })
      continue
    }
    refused.push({
      page: facts.page,
      detail: facts.hasText
        ? '未发现独立水印对象或斜向文字；若水印是栅格化进页面图片的，或作为普通正文绘制的，则无法可靠区分，本工具不做处理'
        : '本页没有文字层，也没有独立水印对象；若水印已栅格化进页面图片，结构上无法与正文区分，本工具不做处理',
    })
  }

  candidates.sort((a, b) => a.page - b.page)
  refused.sort((a, b) => a.page - b.page)
  return { candidates, pages: pages.length, refused }
}

/** Rotation in force at one operation, replayed from the stream start. */
function rotationOfAt(operations: readonly Operation[], index: number): number {
  let rotation = 0
  const stack: number[] = []
  for (let i = 0; i <= index && i < operations.length; i += 1) {
    const op = operations[i]
    if (op.op === 'q') {
      stack.push(rotation)
      continue
    }
    if (op.op === 'Q') {
      rotation = stack.pop() ?? 0
      continue
    }
    if (op.op === 'cm') {
      const values = op.operands.filter(token => token.kind === 'number').map(token => Number(token.raw))
      if (values.length >= 6) {
        const angle = (Math.atan2(values[1], values[0]) * 180) / Math.PI
        const magnitude = Math.abs(angle)
        rotation = magnitude > 5 && magnitude < 355 ? angle : 0
      }
    }
  }
  return rotation
}

/** The operator window a show-text operation occupies, plus its `Tf` selection. */
function spanForShow(
  operations: readonly Operation[],
  index: number,
): { start: number; end: number } | undefined {
  const show = operations[index]
  if (show === undefined) return undefined
  let start = show.start
  for (let i = index - 1; i >= 0; i -= 1) {
    if (operations[i].op === 'Tf') {
      start = operations[i].operands[0].start
      break
    }
  }
  return { start, end: show.end }
}

/** How a removal went. */
export interface RemoveWatermarkResult {
  bytes: Uint8Array
  removed: WatermarkCandidate[]
  skipped: WatermarkCandidate[]
  notes: string[]
}

/** Stable identity of a candidate, used to confirm it describes this document. */
function candidateKeyOf(candidate: WatermarkCandidate): string {
  return [
    candidate.page,
    candidate.kind,
    candidate.xobjectName ?? '',
    candidate.streamIndex ?? '',
    candidate.span?.start ?? '',
    candidate.span?.end ?? '',
  ].join('|')
}

/**
 * The `/Artifact … BDC` … `EMC` block that directly wraps one watermark `Do`.
 *
 * Returns `undefined` unless the block holds nothing but whitespace and
 * graphics-state operators besides that invocation: a wrapper with real content
 * inside it is not ours to delete.
 */
function artifactWrapperSpan(
  text: string,
  doStart: number,
  doEnd: number,
): { start: number; end: number } | undefined {
  const before = text.slice(0, doStart)
  const bdcIndex = before.lastIndexOf('BDC')
  if (bdcIndex < 0) return undefined
  const artifactIndex = before.lastIndexOf('/Artifact', bdcIndex)
  if (artifactIndex < 0) return undefined
  const betweenBefore = text
    .slice(bdcIndex + 3, doStart)
    .replace(/\bq\b|\bQ\b|\bgs\b|\bcm\b/g, '')
    .replace(/[-\d.\s/]+/g, '')
  if (betweenBefore !== '') return undefined
  const after = text.slice(doEnd)
  const emcIndex = after.indexOf('EMC')
  if (emcIndex < 0) return undefined
  const betweenAfter = after
    .slice(0, emcIndex)
    .replace(/\bq\b|\bQ\b/g, '')
    .replace(/[-\d.\s]+/g, '')
  if (betweenAfter !== '') return undefined
  return { start: artifactIndex, end: doEnd + emcIndex + 3 }
}

/**
 * Remove the candidates that can be removed.
 *
 * Only `dryRun: false` writes changes. The default is a dry run precisely
 * because removal is destructive and the candidate list contains guesses: a
 * caller should look at what would go before it goes.
 *
 * An XObject candidate is removed by deleting the `Do` invocation and its
 * resource entry — exact, because the mark is one operator. An inline candidate
 * is removed by blanking the operator span, which is why its confidence matters:
 * blanking the wrong span deletes real text.
 */
export async function removeWatermarks(
  bytes: Uint8Array,
  options: { candidates?: WatermarkCandidate[]; minConfidence?: number; dryRun?: boolean } = {},
): Promise<RemoveWatermarkResult> {
  const dryRun = options.dryRun ?? true
  const minConfidence = options.minConfidence ?? 0.9
  const scan = await scanWatermarks(bytes)
  const notes: string[] = []
  const pool = options.candidates ?? scan.candidates

  // A caller-supplied list is only trustworthy if it describes THIS document.
  // A candidate is little more than a resource name, so acting on a stale or
  // foreign list would delete whatever happens to carry that name here.
  const inThisDocument = new Set(scan.candidates.map(candidateKeyOf))
  const usable = options.candidates === undefined
    ? pool
    : pool.filter(candidate => inThisDocument.has(candidateKeyOf(candidate)))
  const foreign = pool.length - usable.length
  if (foreign > 0) {
    notes.push(`收到 ${foreign} 个与当前文档不匹配（或已过期）的候选，已忽略：它们描述的水印在这次扫描里不存在。`)
  }

  const removed = usable.filter(candidate => candidate.confidence >= minConfidence)
  const skipped = usable.filter(candidate => candidate.confidence < minConfidence)

  if (dryRun || removed.length === 0) {
    if (skipped.length > 0) {
      notes.push(`有 ${skipped.length} 个候选置信度低于 ${minConfidence}，未处理；`
        + '这些需要人工判断，自动删除可能损伤正文。')
    }
    return { bytes, removed, skipped, notes }
  }

  const doc = await loadPdfForWrite(bytes, { updateMetadata: false })
  const pages = doc.getPages()

  for (const candidate of removed) {
    const page = pages[candidate.page - 1]
    if (page === undefined) continue

    if (candidate.kind === 'xobject' && candidate.xobjectName !== undefined) {
      // Delete the invocation from whichever content stream holds it.
      const streams = readPageContentStreams(page as never, doc.context as never)
      for (const stream of streams) {
        const operations = parseOperations(tokenize(stream.text))
        const spans: Array<{ start: number; end: number; text: string }> = []
        for (const op of operations) {
          if (op.op !== 'Do') continue
          const name = op.operands.find(token => token.kind === 'name')
          if (name === undefined || name.raw.replace(/^\//, '') !== candidate.xobjectName) continue
          // Take the surrounding `/Artifact … BDC` … `EMC` wrapper with it. The
          // tool writes that wrapper, so leaving it behind would leave an empty
          // artifact block per page — debris that a later scan reports as
          // "marked content" and a human has to wonder about.
          const wrapper = artifactWrapperSpan(stream.text, op.start, op.end)
          spans.push({ start: wrapper?.start ?? op.start, end: wrapper?.end ?? op.end, text: '' })
        }
        if (spans.length === 0) continue
        if (spansOverlap(spans)) continue
        const { replaceSpan } = await import('./content-stream.ts')
        const rebuilt = replaceSpan(stream.text, spans)
        const fresh = PDFRawStream.of(
          doc.context.obj({ Filter: 'FlateDecode' }) as never,
          deflateSync(Buffer.from(rebuilt, 'latin1')),
        )
        const ref = doc.context.register(fresh)
        const contents = page.node.Contents()
        if (contents instanceof PDFArray) {
          for (let i = 0; i < contents.size(); i += 1) {
            if (contents.get(i) === stream.ref) contents.set(i, ref as never)
          }
        } else {
          page.node.set(PDFName.of('Contents'), ref as never)
        }
      }

      const resources = page.node.Resources()
      const xobjects = readXObjectDict(resources, doc.context as never)
      if (xobjects instanceof PDFDict) xobjects.delete(PDFName.of(candidate.xobjectName))
      notes.push(`第 ${candidate.page} 页：已移除水印 XObject /${candidate.xobjectName}`)
      continue
    }

    if (candidate.kind === 'inline' && candidate.span !== undefined && candidate.streamIndex !== undefined) {
      const streams = readPageContentStreams(page as never, doc.context as never)
      const stream = streams.find(candidate2 => candidate2.index === candidate.streamIndex)
      if (stream === undefined) continue
      const { replaceSpan } = await import('./content-stream.ts')
      const rebuilt = replaceSpan(stream.text, [{ ...candidate.span, text: '' }])
      const fresh = PDFRawStream.of(
        doc.context.obj({ Filter: 'FlateDecode' }) as never,
        deflateSync(Buffer.from(rebuilt, 'latin1')),
      )
      const ref = doc.context.register(fresh)
      const contents = page.node.Contents()
      if (contents instanceof PDFArray) {
        for (let i = 0; i < contents.size(); i += 1) {
          if (contents.get(i) === stream.ref) contents.set(i, ref as never)
        }
      } else {
        page.node.set(PDFName.of('Contents'), ref as never)
      }
      notes.push(`第 ${candidate.page} 页：已清空斜向文字算子`)
    }
  }

  if (skipped.length > 0) {
    notes.push(`有 ${skipped.length} 个候选置信度不足，已保留。`)
  }

  const out = await doc.save()
  return { bytes: out, removed, skipped, notes }
}

export { PDFNumber }
