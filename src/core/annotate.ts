/**
 * 注释标注：把"批改/标注"这类操作写进 PDF 的注释层。
 *
 * ## 为什么用注释而不是直接画在页面上
 *
 * 直接把高亮/文字画进页面内容流也能"看起来对"，但那样：
 *   - 用户无法在阅读器里选中/编辑/删除它；
 *   - 打印/导出行为取决于内容流，而不是注释的 Print 标志；
 *   - 页面上多了无法区分的内容对象。
 *
 * 写进注释层（`/Annots`）才是 Acrobat 意义上的"批注"：可选中、可编辑、可导出、可汇总。
 *
 * ## 文本标记用 `/QuadPoints`，不自画矩形
 *
 * 高亮/下划线/删除线属于"文本标记注释"，PDF 用四边形的相对位置描述被标记的文字，
 * 由阅读器按自己的风格渲染（颜色、透明、形状）。我们只给几何 + 颜色 + 透明度，
 * 不去画一个矩形——自画会在不同阅读器里与文字错位，也无法随文字重排。
 *
 * ## `/F 4` 是必须的
 *
 * `F` 是注释标志位，`4` = Print。**没有它，注释在打印/打印预览里不会出现**——
 * 这是"批改完打印出来发现批注没了"这类问题的根因。
 *
 * ## 外观流（`/AP`）
 *
 * 文本标记注释（highlight/underline/strikeout）交给阅读器画；而 `FreeText`、`Stamp`、
 * `Text`（便签图标）需要**我们提供外观流**，否则阅读器只能显示空白或自己的兜底样式。
 * 外观流是一个 Form XObject：里面用我们已嵌入的字体画出文字（含中文，见 fonts.ts）。
 */

import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRawStream, PDFString } from 'pdf-lib'
import type { PdfRect } from './contracts.ts'
import { loadFontkitAdapter, resolveFontForText } from './fonts.ts'

/** 支持的标注动作。 */
export type AnnotationAction =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'box'
  | 'ellipse'
  | 'freetext'
  | 'note'
  | 'stamp'

/** 文本标记类：用 `/QuadPoints` 描述，不需要外观流。 */
export const MARKUP_ACTIONS: readonly AnnotationAction[] = ['highlight', 'underline', 'strikeout']

/** 需要外观流（`/AP`）的动作。 */
export const APPEARANCE_ACTIONS: readonly AnnotationAction[] = ['freetext', 'note', 'stamp']

/** 动作 → PDF 注释子类型。 */
export const ACTION_SUBTYPES: Readonly<Record<AnnotationAction, string>> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  box: 'Square',
  ellipse: 'Circle',
  freetext: 'FreeText',
  note: 'Text',
  stamp: 'Stamp',
}

/** 各动作的默认颜色（十六进制）。取 Acrobat 的常见观感。 */
export const DEFAULT_COLORS: Readonly<Record<AnnotationAction, string>> = {
  highlight: '#ffd400',
  underline: '#e53935',
  strikeout: '#e53935',
  box: '#e53935',
  ellipse: '#e53935',
  freetext: '#000000',
  note: '#ffd400',
  stamp: '#1565c0',
}

/** 各动作的默认不透明度。 */
export const DEFAULT_OPACITY: Readonly<Record<AnnotationAction, number>> = {
  highlight: 0.4,
  underline: 1,
  strikeout: 1,
  box: 1,
  ellipse: 1,
  freetext: 1,
  note: 1,
  stamp: 1,
}

/** 便签可选图标名（PDF 标准 `/Name` 取值）。 */
export const NOTE_ICONS: readonly string[] = [
  'Comment',
  'Note',
  'Key',
  'Help',
  'NewParagraph',
  'Paragraph',
]

/** `#rrggbb` → `[r, g, b]`（0..1）。非法输入抛中文错误。 */
export function hexToRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (match === null) throw new Error(`颜色 "${hex}" 不是 #rrggbb 形式`)
  const value = Number.parseInt(match[1], 16)
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255]
}

/** 多个矩形取并集；空数组抛中文错误。 */
export function unionRect(rects: readonly PdfRect[]): PdfRect {
  if (rects.length === 0) throw new Error('没有可标注的矩形')
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    x0 = Math.min(x0, rect.x)
    y0 = Math.min(y0, rect.y)
    x1 = Math.max(x1, rect.x + rect.width)
    y1 = Math.max(y1, rect.y + rect.height)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/**
 * 把矩形列表转成 `/QuadPoints`。
 *
 * 每个四边形按 PDF 惯例给出四个角，顺序为**左上、右上、左下、右下**（阅读器按此理解
 * 上下边，顺序写错会得到"倒过来的高亮"）。多个矩形按顺序拼成一个平坦数组。
 */
export function quadPointsForRects(rects: readonly PdfRect[]): number[] {
  const points: number[] = []
  for (const rect of rects) {
    const left = rect.x
    const right = rect.x + rect.width
    const bottom = rect.y
    const top = rect.y + rect.height
    points.push(left, top, right, top, left, bottom, right, bottom)
  }
  return points
}

/** PDF 日期串（`D:YYYYMMDDHHmmSS+HH'mm'`）。 */
export function pdfDate(now: Date = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `D:${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}'${pad(abs % 60)}'`
}

/** 在一行文字里按字符位置**按比例**算出子串的矩形。 */
export function locateInLine(line: { rect: PdfRect; text: string }, needle: string, occurrence = 1): PdfRect | undefined {
  const haystack = line.text
  const target = needle.trim()
  if (target === '') return undefined
  let from = 0
  let seen = 0
  for (;;) {
    const at = haystack.indexOf(target, from)
    if (at < 0) return undefined
    seen += 1
    if (seen === occurrence) {
      // 按字符占比在整行宽度内插值。中英混排不是等宽字体，所以这是近似；
      // 对高亮/下划线这种"覆盖一行中的一段"足够，误差 << 一个字宽时看不出来。
      const ratio0 = at / Math.max(1, haystack.length)
      const ratio1 = (at + target.length) / Math.max(1, haystack.length)
      const x0 = line.rect.x + line.rect.width * ratio0
      const x1 = line.rect.x + line.rect.width * ratio1
      return { x: x0, y: line.rect.y, width: Math.max(1, x1 - x0), height: line.rect.height }
    }
    from = at + target.length
  }
}

/**
 * 统计注释数量与子类型分布（只读，给 `pdf_inspect` 用）。
 *
 * 注意：注释数组里的元素是**间接引用**，而 pdf-lib 的 `PDFRef.lookup()` **不带 context 时
 * 返回 undefined**——必须显式用 `context.lookup(ref)` 解引用，否则会把"有注释"报成 0 个。
 */
export function countAnnotations(
  page: { node: { Annots?(): unknown } },
  context?: { lookup(ref: unknown): unknown },
): { total: number; bySubtype: Record<string, number> } {
  const bySubtype: Record<string, number> = {}
  let total = 0
  const annots = page.node.Annots?.()
  if (!(annots instanceof PDFArray)) return { total, bySubtype }
  for (const entry of annots.asArray()) {
    const resolved = entry instanceof PDFDict ? entry : context?.lookup(entry)
    const dict = resolved instanceof PDFDict ? resolved : entry
    if (!(dict instanceof PDFDict)) continue
    total += 1
    const subtype = dict.get(PDFName.of('Subtype'))
    const key = subtype === undefined ? '未知' : String(subtype).replace(/^\//, '')
    bySubtype[key] = (bySubtype[key] ?? 0) + 1
  }
  return { total, bySubtype }
}

/** 一个待写入的注释。 */
export interface AnnotationSpec {
  action: AnnotationAction
  /** 注释矩形（页面坐标，原点左下）。文本标记动作由 `quads` 决定。 */
  rect: PdfRect
  /** 文本标记动作的四边形来源（可多个，例如跨行）。 */
  quads?: readonly PdfRect[]
  color?: string
  opacity?: number
  borderWidth?: number
  contents?: string
  author?: string
  fontSize?: number
  icon?: string
  subject?: string
}

/** 创建注释所需的最小 pdf-lib 上下文（便于单测注入）。 */
export interface AnnotateContext {
  obj(value: unknown): unknown
  register(value: unknown): unknown
}

/** 建外观流：一个 Form XObject，里面用嵌入字体画出文字（可多行）。 */
export async function buildAppearanceStream(
  doc: {
    embedFont(bytes: Uint8Array, options?: { subset?: boolean }): Promise<{ ref: unknown; name: string; encodeText(text: string): { toString(): string } }>
    registerFontkit?(adapter: unknown): void
  },
  context: AnnotateContext,
  options: {
    text: string
    width: number
    height: number
    fontSize: number
    rgb: [number, number, number]
    kind: 'text' | 'boxed' | 'icon'
    borderWidth?: number
  },
): Promise<{ ref: unknown; fontName: string }> {
  const fontBytes = (await resolveFontForText(options.text))?.bytes
  if (fontBytes === undefined) throw new Error(`没有可用字体渲染「${options.text.slice(0, 20)}」`)
  // pdf-lib 嵌**自定义字体**（这里是我们从系统里取的 CJK 字体）之前必须注册 fontkit，
  // 否则报 "no fontkit instance was found"。
  if (typeof doc.registerFontkit === 'function') {
    const fontkit = await loadFontkitAdapter()
    if (fontkit !== null) doc.registerFontkit(fontkit)
  }
  const font = await doc.embedFont(fontBytes, { subset: true })
  const key = 'F1'
  const lines = options.text.split('\n')
  const leading = options.fontSize * 1.25
  const top = options.height - options.fontSize
  const parts: string[] = ['q']
  if (options.kind !== 'text') {
    const border = options.borderWidth ?? 1
    parts.push(`${border} w`)
    parts.push('0.9 0.9 0.9 RG')
    parts.push(`0.5 0.5 ${Math.max(1, options.width - 1)} ${Math.max(1, options.height - 1)} re S`)
  }
  for (const [index, line] of lines.entries()) {
    const y = Math.max(2, top - index * leading)
    parts.push('BT')
    parts.push(`${options.rgb[0]} ${options.rgb[1]} ${options.rgb[2]} rg`)
    parts.push(`/${key} ${options.fontSize} Tf`)
    parts.push(`2 ${y} Td`)
    parts.push(`${font.encodeText(line).toString()} Tj`)
    parts.push('ET')
  }
  if (options.kind === 'icon') {
    // 便签图标：小方块 + "!"，保证在没有注释图标的阅读器里也能看见。
    parts.push('0 0 0 RG 1 w')
    parts.push(`1 1 ${Math.max(1, options.width - 2)} ${Math.max(1, options.height - 2)} re S`)
  }
  parts.push('Q')
  const dict = context.obj({
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, options.width, options.height],
    Resources: context.obj({ Font: context.obj({ [key]: font.ref }) }),
  }) as PDFDict
  const bytes = Buffer.from(parts.join('\n'), 'latin1')
  return { ref: context.register(PDFRawStream.of(dict, bytes)), fontName: key }
}

/**
 * 文本标记类（高亮/下划线/删除线）的**外观流**。
 *
 * 为什么必须有：PDF 规范允许文本标记注释不带 `/AP`，由阅读器按 `/QuadPoints` 自己画——
 * Acrobat 会，但 **macOS 的 PDFKit（QuickLook/预览）不会**：实测不带 `/AP` 的高亮在
 * QuickLook 渲染里**0 像素差异**（等于看不见）。所以这里显式给出外观，保证任何阅读器
 * 与打印都稳定。
 */
function buildMarkupAppearance(
  context: AnnotateContext,
  options: { width: number; height: number; rgb: [number, number, number]; opacity: number; style: 'highlight' | 'underline' | 'strikeout' },
): { ref: unknown } {
  const width = Math.max(1, options.width)
  const height = Math.max(1, options.height)
  const parts: string[] = ['q', '/GS0 gs', `${options.rgb[0]} ${options.rgb[1]} ${options.rgb[2]} rg`]
  if (options.style === 'highlight') {
    parts.push(`0 0 ${width} ${height} re f`)
  } else {
    const thickness = Math.max(1, height * 0.08)
    const y = options.style === 'underline' ? 0 : (height - thickness) / 2
    parts.push(`0 ${y} ${width} ${thickness} re f`)
  }
  parts.push('Q')
  const dict = context.obj({
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, width, height],
    Resources: context.obj({
      ExtGState: context.obj({ GS0: context.obj({ Type: 'ExtGState', ca: options.opacity, CA: 1 }) }),
    }),
  }) as PDFDict
  return { ref: context.register(PDFRawStream.of(dict, Buffer.from(parts.join('\n'), 'latin1'))) }
}

/**
 * 方框 / 椭圆的**描边外观流**。
 *
 * 与文本标记同理：Square/Circle 注释不带 `/AP` 时，PDFKit（QuickLook/预览）什么都不画
 * （实测 0 像素差异）。这里显式描边；椭圆用四段贝塞尔（k = 0.5523）近似。
 */
function buildShapeAppearance(
  context: AnnotateContext,
  options: { width: number; height: number; rgb: [number, number, number]; borderWidth: number; opacity: number; shape: 'box' | 'ellipse' },
): { ref: unknown } {
  const width = Math.max(2, options.width)
  const height = Math.max(2, options.height)
  const inset = Math.min(options.borderWidth, Math.min(width, height) / 2)
  const x0 = inset / 2
  const y0 = inset / 2
  const x1 = width - inset / 2
  const y1 = height - inset / 2
  const parts: string[] = [
    'q',
    '/GS0 gs',
    `${options.rgb[0]} ${options.rgb[1]} ${options.rgb[2]} RG`,
    `${options.borderWidth} w`,
  ]
  if (options.shape === 'box') {
    parts.push(`${x0} ${y0} ${Math.max(1, x1 - x0)} ${Math.max(1, y1 - y0)} re S`)
  } else {
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const rx = Math.max(1, (x1 - x0) / 2)
    const ry = Math.max(1, (y1 - y0) / 2)
    const k = 0.5523
    parts.push(`${cx + rx} ${cy} m`)
    parts.push(`${cx + rx} ${cy + k * ry} ${cx + k * rx} ${cy + ry} ${cx} ${cy + ry} c`)
    parts.push(`${cx - k * rx} ${cy + ry} ${cx - rx} ${cy + k * ry} ${cx - rx} ${cy} c`)
    parts.push(`${cx - rx} ${cy - k * ry} ${cx - k * rx} ${cy - ry} ${cx} ${cy - ry} c`)
    parts.push(`${cx + k * rx} ${cy - ry} ${cx + rx} ${cy - k * ry} ${cx + rx} ${cy} c`)
    parts.push('S')
  }
  parts.push('Q')
  const dict = context.obj({
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, width, height],
    Resources: context.obj({
      ExtGState: context.obj({ GS0: context.obj({ Type: 'ExtGState', ca: options.opacity, CA: options.opacity }) }),
    }),
  }) as PDFDict
  return { ref: context.register(PDFRawStream.of(dict, Buffer.from(parts.join('\n'), 'latin1'))) }
}

/** 把一条注释写进页面的 `/Annots`，返回注释字典。 */
export async function addAnnotation(
  doc: {
    embedFont(bytes: Uint8Array, options?: { subset?: boolean }): Promise<{ ref: unknown; name: string; encodeText(text: string): { toString(): string } }>
  },
  page: { node: { Annots?(): PDFArray | undefined; set(key: unknown, value: unknown): void } },
  context: AnnotateContext,
  spec: AnnotationSpec,
): Promise<{ dict: PDFDict; subtype: string; rect: PdfRect; appearance: boolean }> {
  const action = spec.action
  const subtype = ACTION_SUBTYPES[action]
  const isMarkup = MARKUP_ACTIONS.includes(action)
  const rects = isMarkup ? (spec.quads ?? [spec.rect]) : [spec.rect]
  const rect = unionRect(rects)
  const rgb = hexToRgb(spec.color ?? DEFAULT_COLORS[action])
  const opacity = spec.opacity ?? DEFAULT_OPACITY[action]
  const borderWidth = spec.borderWidth ?? 1.5
  const fontSize = spec.fontSize ?? (action === 'stamp' ? 24 : 12)

  // 用户文字（作者/正文/主题）必须用 **PDFHexString.fromText**：pdf-lib 1.17 的
  // `PDFString.of('中文')` 会按单字节存，读回来是乱码（实测 `复核这里` → `\r8ÙÌ`）；
  // `PDFString.fromText` 在这个版本根本不存在。`/M`（ASCII 日期）与 `/DA`（外观串）
  // 仍用 PDFString.of：它们必须是单字节，转成 UTF-16 反而会破坏格式。
  const fields: Record<string, unknown> = {
    Type: 'Annot',
    Subtype: subtype,
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    C: rgb,
    CA: opacity,
    Border: [0, 0, borderWidth],
    // Print 标志：没有它，打印/打印预览里看不到注释。
    F: 4,
    T: PDFHexString.fromText(spec.author ?? 'dsh-pdf-studio'),
    // /M 是 ASCII 日期串，必须单字节（fromText 会加 UTF-16 BOM，日期就废了）。
    M: PDFString.of(pdfDate()),
  }
  if (spec.contents !== undefined) fields.Contents = PDFHexString.fromText(spec.contents)
  if (spec.subject !== undefined) fields.Subject = PDFHexString.fromText(spec.subject)
  if (isMarkup) fields.QuadPoints = quadPointsForRects(rects)
  // 便签图标名（/Name）只对 /Text 注释有意义。
  if (action === 'note') fields.Name = spec.icon ?? 'Comment'

  let appearance = false
  if (action === 'box' || action === 'ellipse') {
    // 方形/椭圆注释也要外观流：阅读器不会自己描边（实测 0 像素差异）。
    const built = buildShapeAppearance(context, {
      width: rect.width,
      height: rect.height,
      rgb,
      borderWidth,
      opacity,
      shape: action,
    })
    fields.AP = context.obj({ N: built.ref })
    appearance = true
  }
  if (isMarkup) {
    // 文本标记也要外观流：否则 PDFKit/预览这类阅读器什么都不画（实测 0 像素差异）。
    const built = buildMarkupAppearance(context, {
      width: rect.width,
      height: rect.height,
      rgb,
      opacity,
      style: action as 'highlight' | 'underline' | 'strikeout',
    })
    fields.AP = context.obj({ N: built.ref })
    appearance = true
  }
  if (APPEARANCE_ACTIONS.includes(action)) {
    const text = spec.contents !== undefined && spec.contents.trim() !== ''
      ? spec.contents
      : action === 'note' ? '!' : ''
    const built = await buildAppearanceStream(doc, context, {
      text,
      width: Math.max(4, rect.width),
      height: Math.max(4, rect.height),
      fontSize: action === 'freetext' ? Math.min(fontSize, Math.max(4, rect.height - 2)) : fontSize,
      rgb,
      kind: action === 'freetext' ? 'text' : action === 'note' ? 'icon' : 'boxed',
      borderWidth,
    })
    fields.AP = context.obj({ N: built.ref })
    appearance = true
    if (action === 'freetext') fields.DA = PDFString.of(`/${built.fontName} ${fontSize} Tf 0 g`)
  }

  const dict = context.obj(fields) as PDFDict
  const existing = page.node.Annots?.()
  let annots: PDFArray
  if (existing instanceof PDFArray) {
    annots = existing
  } else {
    annots = context.obj([]) as PDFArray
    page.node.set(PDFName.of('Annots'), annots)
  }
  annots.push(context.register(dict) as never)
  return { dict, subtype, rect, appearance }
}
