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

/** Identity tag written into the Form XObject so a later scan can recognise it. */
export const WATERMARK_MARKER = 'dsh-pdf-studio-watermark'

/**
 * Build the content-stream body of a watermark Form XObject.
 *
 * The XObject's user space is the page's, so the body is written in page
 * coordinates directly. Rotation uses the standard `cm` composition with a
 * translation to the pivot, which is what keeps a rotated mark centred rather
 * than swinging off the page.
 */
function buildMarkBody(spec: {
  /** Pre-encoded glyph operand for the chosen font (NOT the literal text). */
  glyphOperand?: string
  /** Advance width of the drawn text in text units, used for placement only. */
  textWidthUnits?: number
  imageName?: string
  imageWidth?: number
  imageHeight?: number
  pageWidth: number
  pageHeight: number
  placement: WatermarkPlacement
  corner: NonNullable<WatermarkSpec['corner']>
  rotation: number
  opacity: number
  color: { r: number; g: number; b: number }
  fontSize: number
  margin: number
  fontRef: string
}): string {
  const ops: string[] = []
  // A graphics-state block so the mark cannot leak settings into page content.
  ops.push('q')
  // Constant alpha, applied non-stroking (this build's marks are filled text).
  ops.push(`/GSW gs`)

  const place = (
    drawAt: (localWidth: number, localHeight: number) => string,
    localWidth: number,
    localHeight: number,
    tx: number,
    ty: number,
  ): void => {
    ops.push('q')
    ops.push(`1 0 0 1 ${n(tx)} ${n(ty)} cm`)
    if (spec.rotation !== 0) {
      const radians = (spec.rotation * Math.PI) / 180
      const cos = Math.cos(radians)
      const sin = Math.sin(radians)
      // Rotate about the mark's own centre so it stays where it was placed.
      ops.push(`1 0 0 1 ${n(localWidth / 2)} ${n(localHeight / 2)} cm`)
      ops.push(`${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} 0 0 cm`)
      ops.push(`1 0 0 1 ${n(-localWidth / 2)} ${n(-localHeight / 2)} cm`)
    }
    ops.push(drawAt(localWidth, localHeight))
    ops.push('Q')
  }

  if (spec.imageName !== undefined) {
    const imgW = spec.imageWidth ?? 100
    const imgH = spec.imageHeight ?? 100
    const draw = (): string => `/${spec.imageName} Do`
    const [tx, ty] = anchorFor(spec, imgW, imgH)
    place(draw, imgW, imgH, tx, ty)
  } else {
    // The operand MUST be the font's encoded glyph string, not the text. A
    // subset font renumbers its glyphs, so writing the literal characters paints
    // whatever glyphs happen to sit at those codes — which is nothing legible.
    const glyphs = spec.glyphOperand ?? '<>'
    const textWidth = spec.textWidthUnits ?? spec.fontSize
    const textHeight = spec.fontSize
    const draw = (): string =>
      `BT /${spec.fontRef} ${n(spec.fontSize)} Tf ${n(spec.color.r)} ${n(spec.color.g)} ${n(spec.color.b)} rg `
      + `1 0 0 1 0 ${n(textHeight * 0.2)} Tm ${glyphs} Tj ET`
    const [tx, ty] = anchorFor(spec, textWidth, textHeight)
    place(draw, textWidth, textHeight, tx, ty)
  }

  ops.push('Q')
  return ops.join('\n')
}

/**
 * Compute the mark's placement.
 *
 * `tile` is handled by the caller (it repeats this anchor); `center` and
 * `corner` differ only in where the anchor sits.
 */
function anchorFor(
  spec: {
    pageWidth: number
    pageHeight: number
    placement: WatermarkPlacement
    corner: NonNullable<WatermarkSpec['corner']>
    margin: number
  },
  width: number,
  height: number,
  text?: string,
): [number, number] {
  const { pageWidth, pageHeight, placement, corner, margin } = spec
  void text
  if (placement === 'center') {
    return [(pageWidth - width) / 2, (pageHeight - height) / 2]
  }
  if (placement === 'corner') {
    switch (corner) {
      case 'top-left':
        return [margin, pageHeight - height - margin]
      case 'top-right':
        return [pageWidth - width - margin, pageHeight - height - margin]
      case 'bottom-left':
        return [margin, margin]
      default:
        return [pageWidth - width - margin, margin]
    }
  }
  // 'tile' anchors the first tile; the caller repeats with a fixed stride.
  return [margin, margin]
}

/**
 * Stamp a watermark onto a document's pages.
 *
 * The mark is ONE Form XObject, registered once and invoked once per page. That
 * keeps the file small, keeps the mark's graphics state isolated by construction
 * (an XObject body is its own `q`/`Q` scope), and — the reason that matters most
 * here — gives a later removal a single operator to delete per page instead of a
 * pattern to guess at.
 */
export async function addWatermark(
  sourceBytes: Uint8Array,
  spec: WatermarkSpec,
): Promise<{ bytes: Uint8Array; result: AddWatermarkResult }> {
  const doc = await PDFDocument.load(sourceBytes)
  const notes: string[] = []
  const droppedChars: string[] = []

  const placement = spec.placement ?? 'tile'
  const rotation = spec.rotation ?? (placement === 'tile' ? 45 : 0)
  const opacity = Math.min(1, Math.max(0, spec.opacity ?? 0.15))
  const color = parseColor(spec.color)
  const fontSize = spec.fontSize ?? 48
  const margin = spec.margin ?? 24
  const corner = spec.corner ?? 'bottom-right'

  // ── the mark's drawable contents ─────────────────────────────────────────
  let textDrawn = ''
  let fontRef = ''
  let glyphOperand: string | undefined
  let fontObjectRef: unknown
  let textWidthUnits: number | undefined
  let imageName: string | undefined
  let imageWidth: number | undefined
  let imageHeight: number | undefined
  let imageObjectRef: unknown

  if (spec.image !== undefined) {
    const isPng = spec.image[0] === 0x89 && spec.image[1] === 0x50
    const embedded = isPng ? await doc.embedPng(spec.image) : await doc.embedJpg(spec.image)
    const ref = doc.context.register(embedded.ref === undefined ? embedded : embedded.ref)
    imageName = 'WMImg'
    imageWidth = embedded.width
    imageHeight = embedded.height
    void ref
  } else {
    const text = spec.text ?? 'WATERMARK'
    const loaded = await resolveFontForText(text, spec.fontPath)
    if (loaded !== null) {
      const fontkit = await loadFontkitAdapter()
      if (fontkit !== null) doc.registerFontkit(fontkit)
      const font = await doc.embedFont(loaded.bytes, { subset: true })
      fontRef = font.name
      fontObjectRef = font.ref
      // `encodeText` returns the font's OWN glyph codes for the string. That is
      // the only usable operand for this subset.
      const encoded = font.encodeText(text).toString()
      glyphOperand = encoded
      textDrawn = text
      // Advance width estimate for placement: CJK is full-width, latin ~0.5em.
      let units = 0
      for (const char of text) {
        const code = char.codePointAt(0) ?? 0
        const wide = (code >= 0x1100 && code <= 0x115f)
          || (code >= 0x2e80 && code <= 0xa4cf)
          || (code >= 0xff00 && code <= 0xff60)
        units += wide ? 1 : 0.5
      }
      textWidthUnits = units * fontSize
    } else {
      const standard = await doc.embedFont(StandardFonts.HelveticaBold)
      fontRef = standard.name
      fontObjectRef = standard.ref
      textDrawn = text.replace(/[^\x20-\x7e]/g, '')
      glyphOperand = standard.encodeText(textDrawn).toString()
      textWidthUnits = textDrawn.length * 0.5 * fontSize
      for (const char of text) if (!/[^\x20-\x7e]/.test(char)) droppedChars.push(char)
      if (textDrawn !== text) {
        notes.push('未找到可编码该文字的系统字体，已改用 Helvetica 并丢弃非拉丁字符')
      }
    }
  }

  const pages = doc.getPages()
  const targets = spec.pages === undefined
    ? pages.map((_, index) => index + 1)
    : spec.pages.filter(page => page >= 1 && page <= pages.length)

  // ── build one Form XObject per distinct page size ────────────────────────
  // A tiled mark needs a per-size body, so documents with mixed page sizes get
  // one XObject per size rather than a stretched or clipped mark.
  const bodyCache = new Map<string, PDFRef>()

  const buildFor = (pageWidth: number, pageHeight: number): { ref: PDFRef; name: string } => {
    const key = `${Math.round(pageWidth)}x${Math.round(pageHeight)}|${placement}`
    const cached = bodyCache.get(key)
    const name = WATERMARK_MARKER
    if (cached !== undefined) return { ref: cached, name }

    const ops: string[] = ['q']
    const inner = buildMarkBody({
      ...(glyphOperand === undefined ? {} : { glyphOperand }),
      ...(textWidthUnits === undefined ? {} : { textWidthUnits }),
      ...(imageName === undefined ? {} : { imageName }),
      ...(imageWidth === undefined ? {} : { imageWidth }),
      ...(imageHeight === undefined ? {} : { imageHeight }),
      pageWidth,
      pageHeight,
      placement,
      corner,
      rotation,
      opacity,
      color,
      fontSize,
      margin,
      fontRef,
    })

    if (placement === 'tile') {
      // Repeat on a strided grid. Two rows of offset tiles is the usual look:
      // it covers the page without the marks stacking on one another.
      const strideX = Math.max(120, fontSize * 6)
      const strideY = Math.max(120, fontSize * 4)
      const half = strideX / 2
      for (let y = -strideY; y < pageHeight + strideY; y += strideY) {
        for (let x = -strideX; x < pageWidth + strideX; x += strideX) {
          const offset = ((Math.round(y / strideY) % 2) + 2) % 2 === 0 ? 0 : half
          ops.push(`q 1 0 0 1 ${n(x + offset)} ${n(y)} cm`, inner, 'Q')
        }
      }
    } else {
      ops.push(inner)
    }
    ops.push('Q')

    const body = ops.join('\n')
    const stream = PDFRawStream.of(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        // The mark is authored in page coordinates, so its own BBox is the page.
        BBox: [0, 0, pageWidth, pageHeight],
        // The `/Name` is what makes a later scan able to identify this mark by
        // construction rather than by guessing at its appearance.
        Name: WATERMARK_MARKER,
        // The inner Resources must reference the REAL objects: a stub dict here
        // means the `Do` and the `Tf` resolve to nothing and the mark paints
        // empty — which is exactly how this failed the first time.
        Resources: doc.context.obj({
          ...(fontObjectRef === undefined ? {} : { Font: doc.context.obj({ [fontRef]: fontObjectRef }) }),
          ...(imageObjectRef === undefined ? {} : { XObject: doc.context.obj({ [imageName ?? 'WMImg']: imageObjectRef }) }),
          ExtGState: doc.context.obj({ GSW: doc.context.obj({ ca: opacity, CA: opacity }) }),
        }),
      }) as never,
      deflateSync(Buffer.from(body, 'latin1')),
    )
    const dict = (stream as { dict: PDFDict }).dict
    // The stream body is already deflated, so say so.
    dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'))
    const ref = doc.context.register(stream)
    bodyCache.set(key, ref)
    return { ref, name }
  }

  for (const pageNumber of targets) {
    const page = pages[pageNumber - 1]
    if (page === undefined) continue
    const { width, height } = page.getSize()
    const { ref, name } = buildFor(width, height)

    // Register the XObject in this page's resources and append its invocation
    // to the page's content, so the mark paints last (on top of content) and
    // the page's own stream is never rewritten.
    const resources = page.node.Resources()
    let xobjects = resources.lookup(PDFName.of('XObject'), PDFDict)
    if (!(xobjects instanceof PDFDict)) {
      xobjects = doc.context.obj({}) as PDFDict
      resources.set(PDFName.of('XObject'), xobjects)
    }
    xobjects.set(PDFName.of(name), ref)

    const invocation = `\nq /${name} Do Q\n`
    const fresh = PDFRawStream.of(
      doc.context.obj({ Filter: 'FlateDecode' }) as never,
      deflateSync(Buffer.from(invocation, 'latin1')),
    )
    const invocationRef = doc.context.register(fresh)

    const contents = page.node.Contents()
    if (contents instanceof PDFArray) {
      contents.push(invocationRef)
    } else {
      // Wrap the existing stream and the invocation into an array so the page
      // keeps its original content untouched.
      const array = doc.context.obj([contents, invocationRef])
      page.node.set(PDFName.of('Contents'), array)
    }
  }

  if (imageName !== undefined) {
    // The image's own object must live in the XObject's resources, which are
    // per-size; registering it on the context is enough for pdf-lib to write it.
    notes.push('图片水印：尺寸按原始像素绘制，未做缩放')
  }

  const bytes = await doc.save()
  return {
    bytes,
    result: {
      pages: targets.length,
      xobjectName: WATERMARK_MARKER,
      textDrawn,
      droppedChars: [...new Set(droppedChars)],
      notes,
    },
  }
}

/* -------------------------------------------------------------------------- */
/* detection and removal                                                      */
/* -------------------------------------------------------------------------- */

/** Why a candidate is believed to be a watermark. */
export type WatermarkReason =
  /** Invoked through a Form XObject named as a watermarking tool would name it. */
  | 'named-xobject'
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
 * Locate likely watermarks.
 *
 * ## Detection strategy, and its honest limits
 *
 * Two signals are used, in decreasing order of reliability:
 *
 * 1. **A Form XObject invocation.** A page that paints an XObject is worth
 *    inspecting, and a name that says "watermark" is conclusive. An unnamed
 *    XObject is judged by its body: a mark typically contains no `TJ` text of
 *    its own beyond a short string, and is invoked with low constant alpha.
 * 2. **Rotated inline text.** A rotation is rare in body copy and near-universal
 *    in diagonal watermarks, so a text block drawn under a non-trivial `cm`
 *    rotation is reported — at a lower confidence, because a rotated heading is
 *    also a legitimate design.
 *
 * What is NOT detected, deliberately: a mark rasterised into the page image, and
 * one drawn as ordinary unrotated content. Both are indistinguishable from the
 * page by these signals, and reporting them would produce either no candidates
 * or false positives that damage real content. They are surfaced in `refused`
 * with the reason, so the UI can tell the user the truth instead of showing an
 * empty list.
 */
export async function scanWatermarks(bytes: Uint8Array): Promise<WatermarkScan> {
  const doc = await PDFDocument.load(bytes)
  const candidates: WatermarkCandidate[] = []
  const refused: WatermarkScan['refused'] = []
  const pages = doc.getPages()

  for (const [index, page] of pages.entries()) {
    const pageNumber = index + 1
    const resources = page.node.Resources()
    const xobjects = resources.lookup(PDFName.of('XObject'), PDFDict)
    const streams = readPageContentStreams(page as never, doc.context as never)

    // ── 1. XObject invocations ─────────────────────────────────────────────
    const invoked = new Map<string, number>()
    for (const stream of streams) {
      const operations = parseOperations(tokenize(stream.text))
      for (const op of operations) {
        if (op.op !== 'Do') continue
        const name = op.operands.find(token => token.kind === 'name')
        if (name === undefined) continue
        const key = name.raw.replace(/^\//, '')
        invoked.set(key, (invoked.get(key) ?? 0) + 1)
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

      // An unnamed XObject is judged on its body. A mark is small, uses a
      // constant alpha, and holds little or no text of its own.
      const hasAlpha = /\/[A-Za-z0-9]+ gs/.test(body)
      const textOps = (body.match(/Tj|TJ/g) ?? []).length
      const pathOps = (body.match(/\bre\b|\bf\b|\bS\b/g) ?? []).length
      const looksLikeMark = hasAlpha && textOps + pathOps > 1 && body.length < 20000
      if (looksLikeMark) {
        candidates.push({
          page: pageNumber,
          kind: 'xobject',
          reason: 'invisible-xobject',
          confidence: 0.45,
          xobjectName: name,
          detail: `页面调用了未命名的 Form XObject /${name}，其内容含常透明度与少量绘制算子，可能是水印（需人工确认）`,
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

    if (invoked.size === 0 && candidates.every(candidate => candidate.page !== pageNumber)) {
      // Nothing structural stood out. Say so rather than implying clean.
      const hasText = streams.some(stream => /Tj|TJ/.test(stream.text))
      if (hasText) {
        refused.push({
          page: pageNumber,
          detail: '未发现独立水印对象或斜向文字；若水印是栅格化进页面图片的，或作为普通正文绘制的，则无法可靠区分，本工具不做处理',
        })
      }
    }
  }

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
  const pool = options.candidates ?? scan.candidates

  const removed = pool.filter(candidate => candidate.confidence >= minConfidence)
  const skipped = pool.filter(candidate => candidate.confidence < minConfidence)
  const notes: string[] = []

  if (dryRun || removed.length === 0) {
    if (skipped.length > 0) {
      notes.push(`有 ${skipped.length} 个候选置信度低于 ${minConfidence}，未处理；`
        + '这些需要人工判断，自动删除可能损伤正文。')
    }
    return { bytes, removed, skipped, notes }
  }

  const doc = await PDFDocument.load(bytes)
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
          // Include the surrounding `q`/`Q` if they are the immediate neighbours,
          // so no unbalanced graphics state is left behind.
          spans.push({ start: op.start, end: op.end, text: '' })
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
      const xobjects = resources.lookup(PDFName.of('XObject'), PDFDict)
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
