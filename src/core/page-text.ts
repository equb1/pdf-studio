/**
 * 在页面上写字：页码 / 页眉页脚 / Bates 编号 / 任意位置插入文字。
 *
 * ## 为什么这四个能力归一个模块
 *
 * 它们的差别只在"文字怎么来"和"放哪里"：
 *   - 页码：模板里有 `{page}` / `{total}`，逐页不同，位置固定在页边；
 *   - 页眉页脚：模板固定（或含文件名/日期），位置固定在页边；
 *   - Bates 编号：模板是 `前缀 + 补零序号 + 后缀`，序号逐页递增；
 *   - 插入文字：位置由调用方给出（页面坐标），文字固定。
 * 落到 PDF 上都是同一件事：**在页面某个位置、用嵌入字体画一行（或多行）字**。
 * 所以共用"模板求值 + 锚点定位 + 画字"三层，避免四份重复实现。
 *
 * ## 为什么用 `drawText` 直接写内容流，而不是注释
 *
 * 页码/页眉/Bates 属于**文档内容**（打印必须出现、应当可搜索、不希望在批注列表里冒出来），
 * 所以写进页面内容流，而不是注释层（对比 `annotate.ts`：那是"批注"语义）。
 *
 * ## 字体
 *
 * 中文必须用系统 CJK 字体，且 pdf-lib 嵌自定义字体前要 `registerFontkit`（见 fonts.ts）。
 * 文字的**宽度**用 `font.widthOfTextAtSize` 实测，而不是按字符数估算——居中/右对齐才不会偏。
 */

import { StandardFonts, degrees, rgb } from 'pdf-lib'
import type { PdfRect } from './contracts.ts'
import { loadFontkitAdapter, resolveFontForText } from './fonts.ts'

/** 九个常用落点。 */
export type TextAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'center'

/** 页面尺寸。 */
export interface PageBox {
  width: number
  height: number
}

/** `#rrggbb` → pdf-lib 的 rgb()。非法输入抛中文错误。 */
export function colorOf(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (match === null) throw new Error(`颜色 "${hex}" 不是 #rrggbb 形式`)
  const value = Number.parseInt(match[1], 16)
  return { r: ((value >> 16) & 0xff) / 255, g: ((value >> 8) & 0xff) / 255, b: (value & 0xff) / 255 }
}

/**
 * 模板求值：把 `{page}` / `{total}` / `{bates}` / `{date}` / `{filename}` 替换成实际值。
 *
 * 认不出的占位符**原样保留**——静默替换成空串会让人以为写对了，实际少了内容。
 */
export function applyTemplate(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, key: string) => {
    const value = vars[key]
    return value === undefined ? whole : String(value)
  })
}

/** 模板里出现的、我们不认识的占位符（用于在执行前提示，而不是猜）。 */
export function unknownPlaceholders(template: string, known: readonly string[]): string[] {
  const found = new Set<string>()
  // 认任意非花括号内容，这样拼错的占位符（{pages}、{頁}）也能被指出，而不是被当成普通文字。
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    if (!known.includes(match[1])) found.add(match[1])
  }
  return [...found]
}

/** Bates 编号：`前缀 + 补零序号 + 后缀`。 */
export function formatBates(sequence: number, options: { prefix?: string; digits?: number; suffix?: string } = {}): string {
  const digits = Math.max(1, Math.min(12, Math.floor(options.digits ?? 6)))
  return `${options.prefix ?? ''}${String(sequence).padStart(digits, '0')}${options.suffix ?? ''}`
}

/**
 * 算出某行文字的**基线**落点。
 *
 * `pdf-lib` 的 `drawText` 以基线为 y，所以"贴着上边距"要减去一个字高，
 * 否则文字会有一部分跑到页面外。
 */
export function anchorPosition(
  page: PageBox,
  anchor: TextAnchor,
  textSize: { width: number; height: number },
  marginX = 40,
  marginY = 28,
): { x: number; y: number } {
  const left = marginX
  const centerX = (page.width - textSize.width) / 2
  const right = page.width - marginX - textSize.width
  const bottom = marginY
  const top = page.height - marginY - textSize.height
  const middle = (page.height - textSize.height) / 2
  switch (anchor) {
    case 'top-left': return { x: left, y: top }
    case 'top-center': return { x: centerX, y: top }
    case 'top-right': return { x: right, y: top }
    case 'bottom-left': return { x: left, y: bottom }
    case 'bottom-center': return { x: centerX, y: bottom }
    case 'bottom-right': return { x: right, y: bottom }
    case 'center': return { x: centerX, y: middle }
  }
}

/** 把文字画在页面上（含可选的底衬与旋转）。 */
export interface DrawOptions {
  text: string
  size: number
  colorHex: string
  anchor: TextAnchor
  marginX?: number
  marginY?: number
  /** 逆时针旋转角度（0 表示不转）。 */
  rotate?: number
  /** 底衬（不透明色块 + 内边距），用于压在花哨背景上仍然可读。 */
  background?: { colorHex: string; padding: number }
  /** 已确定的页面坐标；给了它就不再按 anchor 算。 */
  at?: { x: number; y: number }
}

/** 画字所需的最小 pdf-lib 形状（便于单测注入）。 */
export interface DrawTarget {
  getSize(): { width: number; height: number }
  drawText(text: string, options: Record<string, unknown>): unknown
  drawRectangle?(options: Record<string, unknown>): unknown
}

/** 已解析的字体。 */
export interface ResolvedDrawFont {
  font: { widthOfTextAtSize(text: string, size: number): number; heightAtSize?(size: number): number }
}

/** 解析并嵌入一个能渲染该文字的字体（必要时注册 fontkit）。 */
export async function resolveDrawFont(
  doc: { embedFont(bytes: Uint8Array, options?: { subset?: boolean }): Promise<unknown>; registerFontkit?(adapter: unknown): void },
  text: string,
  explicitPath?: string,
): Promise<ResolvedDrawFont> {
  // 纯 ASCII 时用内置 Helvetica：省一次系统字体嵌入，体积更小。
  if (/^[\x20-\x7e\n]*$/.test(text) && explicitPath === undefined) {
    const font = await doc.embedFont(StandardFonts.Helvetica)
    return { font: font as ResolvedDrawFont['font'] }
  }
  const loaded = await resolveFontForText(text, explicitPath)
  if (loaded === null) throw new Error(`没有可用字体渲染「${text.slice(0, 20)}」`)
  if (typeof doc.registerFontkit === 'function') {
    const fontkit = await loadFontkitAdapter()
    if (fontkit !== null) doc.registerFontkit(fontkit)
  }
  const font = await doc.embedFont(loaded.bytes, { subset: true })
  return { font: font as ResolvedDrawFont['font'] }
}

/** 一行文字的实测尺寸（多行取最宽一行，高度为行数 × 行距）。 */
export function measureText(font: ResolvedDrawFont, text: string, size: number): { width: number; height: number } {
  const lines = text.split('\n')
  const width = Math.max(...lines.map(line => font.font.widthOfTextAtSize(line, size)), 0)
  return { width, height: lines.length * size * 1.2 }
}

/**
 * 在页面上画一段文字，返回实际落点与尺寸（供结果文本汇报）。
 */
export function drawTextOnPage(
  page: DrawTarget,
  font: ResolvedDrawFont,
  options: DrawOptions,
): { x: number; y: number; width: number; height: number; lines: number } {
  const size = page.getSize()
  const measured = measureText(font, options.text, options.size)
  const position = options.at ?? anchorPosition(size, options.anchor, measured, options.marginX, options.marginY)
  const color = colorOf(options.colorHex)
  const padding = options.background?.padding ?? 3
  if (options.background !== undefined && typeof page.drawRectangle === 'function') {
    const bg = colorOf(options.background.colorHex)
    page.drawRectangle({
      x: position.x - padding,
      y: position.y - padding - options.size * 0.25,
      width: measured.width + padding * 2,
      height: measured.height + padding * 1.5,
      color: rgb(bg.r, bg.g, bg.b),
    })
  }
  const leading = options.size * 1.2
  const lines = options.text.split('\n')
  lines.forEach((line, index) => {
    page.drawText(line, {
      x: position.x,
      y: position.y - index * leading,
      size: options.size,
      font: font.font,
      color: rgb(color.r, color.g, color.b),
      ...(options.rotate === undefined || options.rotate === 0 ? {} : { rotate: degrees(options.rotate) }),
    })
  })
  return { x: position.x, y: position.y, width: measured.width, height: measured.height, lines: lines.length }
}

/** 把落点包成矩形（给"越界检查/汇报"用）。 */
export function boxOf(at: { x: number; y: number }, size: { width: number; height: number }): PdfRect {
  return { x: at.x, y: at.y, width: size.width, height: size.height }
}

/** 页面是否需要跳过（`pages` 支持 `1-3,7` 与 `odd`/`even`）。 */
export function pageSelection(spec: string | undefined, pageCount: number): number[] {
  if (spec === undefined || spec.trim() === '') return Array.from({ length: pageCount }, (_, index) => index + 1)
  const wanted = new Set<number>()
  for (const chunk of spec.split(',')) {
    const part = chunk.trim()
    if (part === '') continue
    if (part === 'odd') { for (let n = 1; n <= pageCount; n += 2) wanted.add(n); continue }
    if (part === 'even') { for (let n = 2; n <= pageCount; n += 2) wanted.add(n); continue }
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part)
    if (range !== null) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from < 1 || to < from || to > pageCount) throw new Error(`页范围 "${part}" 不合法（文档共 ${pageCount} 页）`)
      for (let n = from; n <= to; n += 1) wanted.add(n)
      continue
    }
    const single = Number(part)
    if (!Number.isInteger(single) || single < 1 || single > pageCount) {
      throw new Error(`页码 "${part}" 不合法（文档共 ${pageCount} 页）`)
    }
    wanted.add(single)
  }
  return [...wanted].sort((a, b) => a - b)
}
