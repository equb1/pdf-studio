/**
 * 页级装配：拆分（2-up）/ 裁剪 / 重排 / 合并的纯逻辑。
 *
 * ## 为什么单独一个模块
 *
 * 这四件事都在动「页面」本身：页面框、页序、文件组合。工具层只该做参数解析与确认门控，
 * 所以几何换算、页树继承、内容流拼接、像素测量这些容易出错、也最值得单测的部分全部放在这里。
 *
 * ## 拆 2-up 为什么不栅格化
 *
 * 把一张 2-up 页面（A3 试卷、或 720×405pt 的「答案版 + 空白版并排」讲义）切成单页，
 * 最省事的做法是渲染成图片再切——但那样文字层、字体、矢量线条全部丢失，
 * 切出来的「试卷」不能搜索、不能复制、打印也发虚。
 *
 * 能不能拆只取决于**版面**：`/Rotate` 为 0、长宽比明显偏离 1（≥1.25）。
 * 与纸张尺寸无关——A3、A4、720×405 都行；正方形/单页版式会被判为不规范并跳过。
 *
 * 正确的做法是**只改页面框 + 在内容流最前面插一条平移**：
 *
 *   - 左半：`/MediaBox` 改成 `[0 0 w/2 h]`，内容一个字节都不动；
 *   - 右半：`/MediaBox` 同样收窄，再在最前面插 `1 0 0 1 -w/2 0 cm`，把整页内容左移半页，
 *     于是原来落在右半的内容刚好落进新的页面框。
 *
 * 上下切同理，只是平移量走 y 轴，且先输出上半、后输出下半。
 * 页面框（`/CropBox`、`/TrimBox`、`/BleedBox`、`/ArtBox`）必须一起改，
 * 否则阅读器会拿旧框去裁，切出来的页面看起来「还是整张」。
 *
 * `/Contents` 可能是单条流，也可能是数组（真实页面常见 4 条）。插入时必须两种都能处理：
 * 数组就 `unshift` 一条新流，单流就变成 `[新流, 原流]`。
 *
 * ## 页面框继承
 *
 * `/MediaBox`、`/CropBox`、`/Rotate`、`/UserUnit` 按 PDF 规范都可从页树父节点继承。
 * 只读页面自身的字典会把「继承来的 A3」看成「没有页面框」，必须沿 `/Parent` 向上找。
 * 可见区域取 **CropBox ∩ MediaBox**（阅读器就是这么算的），宽高按 `/Rotate` 交换，
 * 并乘上 `/UserUnit`（缺省 1）。
 *
 * @module dsh-pdf-studio/core/page-assembly
 */

import { basename } from 'node:path'
import { loadPdfForWrite } from './pdf.ts'
import { readFile } from 'node:fs/promises'
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
} from 'pdf-lib'

/** 一个矩形（PDF 坐标，pt，原点左下）。 */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** 一页的几何信息。 */
export interface PageBoxes {
  /** `/MediaBox`（原始坐标，未旋转、未乘 UserUnit）。 */
  mediaBox: Box
  /** `/CropBox`；页面没有时等于 MediaBox。 */
  cropBox: Box
  /** 归一化到 0 / 90 / 180 / 270。 */
  rotate: number
  /** 可见宽度 = (CropBox ∩ MediaBox) 的宽，按 /Rotate 交换、乘 /UserUnit，与阅读器一致。 */
  width: number
  /** 可见高度，同上。 */
  height: number
  /** `/UserUnit`，缺省 1。 */
  userUnit: number
  /** 可见区域（CropBox ∩ MediaBox），未旋转、未乘 UserUnit 的原始坐标。 */
  visible: Box
}

/** 2-up 的切法。 */
export type TwoUpAxis = 'left-right' | 'top-bottom'

/** 2-up 判定结果。 */
export interface TwoUpClassification {
  ok: boolean
  axis: TwoUpAxis
  /** 不合格时的中文原因。 */
  reason?: string
  /** 切完每一半的展示尺寸（pt，含 /UserUnit）。 */
  halfSize: { width: number; height: number }
}

/** A4 竖放尺寸（pt）与尺寸容差；只用于「切出来是不是 A4」的**提示**，不参与合格判定。 */
export const A4_PORTRAIT = { width: 210, height: 297 } as const
export const SIZE_TOLERANCE_PT = 3

/**
 * 「明显宽版 / 明显竖版」的最小长宽比。
 *
 * 2-up 的前提是页面被分成两条并排或上下的版面：正方形或接近 1:1 的页面既不像左右拼版、
 * 也不像上下拼版，硬切只会切错。1.25 是经验阈值（A4 横放是 1.41，720×405 是 1.78）。
 */
export const MIN_ASPECT_RATIO = 1.25

/** 中缝的最小可接受宽度（pt）：窄于这个宽度的间隔更像字号/边框的缝隙，不足以当切分线。 */
export const MIN_GUTTER_BAND_PT = 8

/**
 * 一条列/行要占到多少比例的暗像素才算「有内容」。
 *
 * 中缝里常有浅灰底、扫描噪点、被打断的细虚线；不设下限的话，内容包围盒会一直顶到中线，
 * 把本来分得很开的两栏误判成「没有缝」。
 */
export const MIN_CONTENT_LINE_RATIO = 0.03

/** …… 页面框读取 ……………………………………………………………………………………… */

/**
 * 规范化旋转角。
 *
 * PDF 里 /Rotate 规范要求是 90 的倍数，但真实文件什么都有；这里就近取整到 90 的倍数，
 * 再压到 [0,360)。非 0 的页面对拆分来说都属于「不规范」。
 */
export function normalizeRotate(value: number): number {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round(value / 90) * 90
  return ((rounded % 360) + 360) % 360
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (value !== null && typeof value === 'object' && typeof (value as PDFNumber).asNumber === 'function') {
    const number = (value as PDFNumber).asNumber()
    return Number.isFinite(number) ? number : undefined
  }
  return undefined
}

function rectOf(value: unknown): Box | undefined {
  if (!(value instanceof PDFArray) || value.size() < 4) return undefined
  const nums: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const n = asNumber(value.get(i))
    if (n === undefined) return undefined
    nums.push(n)
  }
  const x0 = Math.min(nums[0], nums[2])
  const x1 = Math.max(nums[0], nums[2])
  const y0 = Math.min(nums[1], nums[3])
  const y1 = Math.max(nums[1], nums[3])
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** 两个矩形的交集；不相交时宽高为 0。 */
export function intersectBox(a: Box, b: Box): Box {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.width, b.x + b.width)
  const y1 = Math.min(a.y + a.height, b.y + b.height)
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
}

/** 页树节点（页叶或中间节点）的最小结构面。 */
interface PageTreeNode {
  get(name: unknown): unknown
  Parent?(): PageTreeNode | undefined
}

/**
 * 沿 `/Parent` 向上查找可继承属性。
 *
 * 只看页面自身字典是不够的：页树中间节点上的 `/MediaBox` 是常见写法（尤其是
 * 由排版工具导出的试卷），漏掉它会把整页当成 612×792。
 */
function inheritedValue(node: PageTreeNode, context: { lookup(value: unknown): unknown }, name: string): unknown {
  let current: PageTreeNode | undefined = node
  for (let depth = 0; current !== undefined && depth < 64; depth += 1) {
    const direct = current.get(PDFName.of(name))
    if (direct !== undefined) return context.lookup(direct)
    current = typeof current.Parent === 'function' ? current.Parent() : undefined
  }
  return undefined
}

/**
 * 读取一页的页面框。
 *
 * 不依赖 pdf-lib 的 `page.getMediaBox()` 之类的封装，因为这里需要同时拿到
 * `/UserUnit` 与「未旋转的可见矩形」，而封装只给其中一部分。
 */
export function readPageBoxes(page: unknown): PageBoxes {
  const target = page as {
    node: PageTreeNode
    doc: { context: { lookup(value: unknown): unknown } }
  }
  const context = target.doc.context
  const media = rectOf(inheritedValue(target.node, context, 'MediaBox')) ?? { x: 0, y: 0, width: 612, height: 792 }
  const crop = rectOf(inheritedValue(target.node, context, 'CropBox')) ?? media
  const rotate = normalizeRotate(asNumber(inheritedValue(target.node, context, 'Rotate')) ?? 0)
  const rawUserUnit = asNumber(inheritedValue(target.node, context, 'UserUnit'))
  const userUnit = rawUserUnit !== undefined && rawUserUnit > 0 ? rawUserUnit : 1
  const visible = intersectBox(media, crop)
  const swapped = rotate === 90 || rotate === 270
  return {
    mediaBox: media,
    cropBox: crop,
    rotate,
    width: (swapped ? visible.height : visible.width) * userUnit,
    height: (swapped ? visible.width : visible.height) * userUnit,
    userUnit,
    visible,
  }
}

/** …… 2-up 判定 …………………………………………………………………………………………… */

function withinTolerance(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= SIZE_TOLERANCE_PT
}

/** 一对尺寸是否落在 A4 竖放（210×297）±3pt 内。 */
export function isA4Half(size: { width: number; height: number }): boolean {
  return withinTolerance(size.width, A4_PORTRAIT.width) && withinTolerance(size.height, A4_PORTRAIT.height)
}

/**
 * 判断一页是不是「可以拆的 2-up」。
 *
 * 规则（**与纸张尺寸无关**）：
 *   1. `/Rotate` 必须是 0——旋转页的「左右」在阅读器里根本不是左右，硬切会切错；
 *   2. 必须是明显宽版或明显竖版：长宽比 ≥ 1.25。横向页 → `left-right`，竖向页 → `top-bottom`；
 *      比例接近 1（正方形、单页版式）既不像左右拼版也不像上下拼版，判为不规范。
 *
 * 纸张多大都行：A3 试卷能拆，720×405pt 的「答案版+空白版并排」讲义也能拆。
 * 不合格的页由调用方跳过并逐页报出 `reason`。
 */
export function classifyTwoUp(_page: unknown, boxes: PageBoxes): TwoUpClassification {
  const landscape = boxes.width >= boxes.height
  const axis: TwoUpAxis = landscape ? 'left-right' : 'top-bottom'
  const halfSize = landscape
    ? { width: boxes.width / 2, height: boxes.height }
    : { width: boxes.width, height: boxes.height / 2 }

  if (boxes.rotate % 360 !== 0) {
    return { ok: false, axis, halfSize, reason: `页面带 /Rotate ${boxes.rotate}°，不是规范的 2-up 版面` }
  }

  const width = boxes.width
  const height = boxes.height
  if (!(width > 0) || !(height > 0)) {
    return { ok: false, axis, halfSize, reason: '页面可见区域为空，无法对半切' }
  }
  const ratio = landscape ? width / height : height / width
  if (ratio < MIN_ASPECT_RATIO) {
    return {
      ok: false,
      axis,
      halfSize,
      reason: `页面尺寸 ${width.toFixed(1)}×${height.toFixed(1)}pt 的长宽比是 ${ratio.toFixed(2)}`
        + `（小于 ${MIN_ASPECT_RATIO}），既不像左右拼版也不像上下拼版，无法可靠对半切`,
    }
  }
  return { ok: true, axis, halfSize }
}

/** …… 内容流拼接 ………………………………………………………………………………………… */

function trimNumber(value: number): string {
  const rounded = Math.round(value * 10000) / 10000
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

/** 生成一条「只做平移」的内容流，插入到页面内容最前面。 */
function makeTranslateStream(context: { obj(value: unknown): unknown; register(value: unknown): unknown }, tx: number, ty: number): unknown {
  const text = `1 0 0 1 ${trimNumber(tx)} ${trimNumber(ty)} cm\n`
  const bytes = new Uint8Array(Buffer.from(text, 'latin1'))
  const dict = context.obj({ Length: bytes.length })
  return context.register(PDFRawStream.of(dict as never, bytes))
}

/** 读出页面已有的内容流引用列表（`/Contents` 单流或数组都能处理）。 */
function contentRefsOf(page: { node: PageTreeNode }, context: { lookup(value: unknown): unknown }): unknown[] {
  const raw = page.node.get(PDFName.of('Contents'))
  if (raw === undefined) return []
  const looked = context.lookup(raw)
  if (looked instanceof PDFArray) {
    const refs: unknown[] = []
    for (let i = 0; i < looked.size(); i += 1) refs.push(looked.get(i))
    return refs
  }
  return [raw]
}

/** 把新内容流放到原有内容前面，并写回 `/Contents`。 */
function setContentRefs(
  page: { node: PageTreeNode & { set(key: unknown, value: unknown): void } },
  context: { obj(value: unknown): unknown; register(value: unknown): unknown },
  refs: unknown[],
): void {
  if (refs.length === 0) return
  if (refs.length === 1) {
    page.node.set(PDFName.of('Contents'), refs[0])
    return
  }
  const array = PDFArray.withContext(context as never)
  for (const ref of refs) array.push(ref as never)
  page.node.set(PDFName.of('Contents'), array)
}

/** …… 拆分 2-up …………………………………………………………………………………………… */

/** 切完保留哪一半：`both` 两半都留，其余只留对应的一半。 */
export type SplitKeep = 'both' | 'left' | 'right' | 'top' | 'bottom'

/** `splitPageIntoHalves` 的选项。 */
export interface SplitOptions {
  axis: TwoUpAxis
  /** 切分线到「可见区域左边缘（左右切）/ 下边缘（上下切）」的距离，缺省半页。 */
  gutterPt?: number
}

/** `splitPageKeepingHalf` 的选项。 */
export interface KeepHalfOptions {
  axis: TwoUpAxis
  gutterPt?: number
  /** 只留哪一半；`both` 请改用 `splitPageIntoHalves`。 */
  keep: Exclude<SplitKeep, 'both'>
}

/** 保留的一半与切法是否匹配。 */
export function keepMatchesAxis(axis: TwoUpAxis, keep: SplitKeep): boolean {
  if (keep === 'both') return true
  return axis === 'left-right' ? keep === 'left' || keep === 'right' : keep === 'top' || keep === 'bottom'
}

/** 切法的中文说法。 */
export function axisLabel(axis: TwoUpAxis): string {
  return axis === 'left-right' ? '左右' : '上下'
}

/** 该切法下 `keep` 可以取的值，用于错误提示。 */
export function keepOptionsFor(axis: TwoUpAxis): string {
  return axis === 'left-right' ? 'keep=left|right' : 'keep=top|bottom'
}

/** `keep` 的中文说法。 */
export function keepLabel(keep: SplitKeep): string {
  if (keep === 'left') return '左半'
  if (keep === 'right') return '右半'
  if (keep === 'top') return '上半'
  if (keep === 'bottom') return '下半'
  return '两半'
}

/** 第一半 / 第二半的页面框尺寸与内容平移量。 */
interface HalfGeometry {
  size: { width: number; height: number }
  shift: { x: number; y: number }
}

/**
 * 算出两半各自的页面框与内容平移量。
 *
 * 输出顺序固定是「先左后右 / 先上后下」：`first` 是左半（左右切）或上半（上下切），
 * `second` 是右半或下半。平移按**可见区域**（CropBox ∩ MediaBox）计算，页面框原点不在 (0,0)
 * 时也能切对；规范页（原点 0）得到 `shift = 0`，即「只改框」。
 */
function halfGeometry(visible: Box, axis: TwoUpAxis, gutter: number): [HalfGeometry, HalfGeometry] {
  if (axis === 'left-right') {
    return [
      { size: { width: gutter, height: visible.height }, shift: { x: -visible.x, y: -visible.y } },
      { size: { width: visible.width - gutter, height: visible.height }, shift: { x: -(visible.x + gutter), y: -visible.y } },
    ]
  }
  return [
    { size: { width: visible.width, height: visible.height - gutter }, shift: { x: -visible.x, y: -(visible.y + gutter) } },
    { size: { width: visible.width, height: gutter }, shift: { x: -visible.x, y: -visible.y } },
  ]
}

/** 校验切分线并算出两半几何。 */
function planSplit(page: PDFPage, axis: TwoUpAxis, gutterPt?: number): {
  visible: Box
  gutter: number
  halves: [HalfGeometry, HalfGeometry]
} {
  const boxes = readPageBoxes(page)
  if (boxes.rotate % 360 !== 0) {
    throw new Error(`拆分要求页面 /Rotate 为 0，当前是 ${boxes.rotate}°`)
  }
  const visible = boxes.visible
  const extent = axis === 'left-right' ? visible.width : visible.height
  const gutter = gutterPt ?? extent / 2
  if (!Number.isFinite(gutter) || gutter <= 0 || gutter >= extent) {
    throw new Error(`切分线 ${gutter}pt 超出页面可见范围（0..${extent.toFixed(1)}pt）`)
  }
  return { visible, gutter, halves: halfGeometry(visible, axis, gutter) }
}

/** 把一页改成「两半中的某一半」：改页面框 + 在内容流最前面插一条平移。 */
function applyHalf(
  page: PDFPage,
  context: { obj(value: unknown): unknown; register(value: unknown): unknown },
  size: { width: number; height: number },
  shift: { x: number; y: number },
  originalRefs: unknown[],
): void {
  page.setMediaBox(0, 0, size.width, size.height)
  // 阅读器会用 /CropBox 覆盖 /MediaBox，旧框不动的话切了等于没切。
  page.setCropBox(0, 0, size.width, size.height)
  page.setTrimBox(0, 0, size.width, size.height)
  page.setBleedBox(0, 0, size.width, size.height)
  page.setArtBox(0, 0, size.width, size.height)
  page.node.set(PDFName.of('Rotate'), PDFNumber.of(0))

  const prefix: unknown[] = []
  if (shift.x !== 0 || shift.y !== 0) prefix.push(makeTranslateStream(context, shift.x, shift.y))
  setContentRefs(page as never, context, [...prefix, ...originalRefs])
}

function pageIndexOf(doc: PDFDocument, page: PDFPage): number {
  const pages = doc.getPages()
  for (let i = 0; i < pages.length; i += 1) {
    if (pages[i].ref === page.ref) return i
  }
  return -1
}

/**
 * 把 `page` 切成两半：**不栅格化**，只改页面框 + 在内容流最前面插一条平移。
 *
 * `page` 必须已经在 `doc` 的页树里；返回的第一半就是 `page` 本身（已改），
 * 第二半是新插入的页对象，位置紧跟在第一半之后，因此调用方可以直接按
 * 「先左后右 / 先上后下」的顺序得到结果。
 */
export function splitPageIntoHalves(doc: PDFDocument, page: PDFPage, options: SplitOptions): [PDFPage, PDFPage] {
  const context = doc.context as unknown as { obj(value: unknown): unknown; register(value: unknown): unknown; lookup(value: unknown): unknown }
  const { halves } = planSplit(page, options.axis, options.gutterPt)

  const originalRefs = contentRefsOf(page as never, context)
  // 先克隆一份字典；内容流引用在下面两半里各自重写，避免两页共享同一个 /Contents 数组。
  const leafB = (page.node as unknown as { clone(context: unknown): unknown }).clone(context) as never

  applyHalf(page, context, halves[0].size, halves[0].shift, originalRefs)

  const refB = context.register(leafB)
  const pageB = PDFPage.of(leafB as never, refB as never, doc)
  const index = pageIndexOf(doc, page)
  doc.insertPage(index < 0 ? doc.getPageCount() : index + 1, pageB)
  applyHalf(pageB, context, halves[1].size, halves[1].shift, originalRefs)

  return [page, pageB]
}

/**
 * 只保留一页的一半（左/右/上/下），原地改 `page` 并返回它。
 *
 * 与 `splitPageIntoHalves` 共用同一套几何与平移逻辑，所以「先拆两半再删一半」与
 * 「直接只留一半」得到的页面完全一致——前者是 20 页再丢 10 页，后者直接 10 页。
 *
 * `keep` 与切法不匹配时抛中文错误（左右排列不能保留「上半」）。
 */
export function splitPageKeepingHalf(doc: PDFDocument, page: PDFPage, options: KeepHalfOptions): PDFPage {
  if (!keepMatchesAxis(options.axis, options.keep)) {
    throw new Error(`这一页是${axisLabel(options.axis)}排列，keep=${options.keep} 不适用；${axisLabel(options.axis)}排列请用 ${keepOptionsFor(options.axis)}`)
  }
  const context = doc.context as unknown as { obj(value: unknown): unknown; register(value: unknown): unknown; lookup(value: unknown): unknown }
  const { halves } = planSplit(page, options.axis, options.gutterPt)
  const originalRefs = contentRefsOf(page as never, context)
  const index = options.axis === 'left-right'
    ? (options.keep === 'left' ? 0 : 1)
    : (options.keep === 'top' ? 0 : 1)
  applyHalf(page, context, halves[index].size, halves[index].shift, originalRefs)
  return page
}

/** …… 渲染与像素测量 …………………………………………………………………………………… */

interface Raster {
  width: number
  height: number
  data: Uint8ClampedArray
  scale: number
}

/** 用真实 canvas（`@napi-rs/canvas`）低倍渲染一页，拿回像素。 */
async function rasterize(sourcePath: string, pageNumber: number, scale: number): Promise<Raster> {
  const { renderPagePng } = await import('../host/render.ts')
  const canvasModule = await import('@napi-rs/canvas')
  const png = await renderPagePng(sourcePath, pageNumber, scale)
  const image = await canvasModule.loadImage(Buffer.from(png))
  const canvas = canvasModule.createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const data = context.getImageData(0, 0, image.width, image.height).data
  return { width: image.width, height: image.height, data, scale }
}

const DARK_THRESHOLD = 128

function isDark(data: Uint8ClampedArray, index: number): boolean {
  return (data[index] + data[index + 1] + data[index + 2]) / 3 < DARK_THRESHOLD
}

/** 墨迹（暗像素）包围盒，像素坐标（原点左上）。没有墨迹时返回 undefined。 */
function inkBoundsInRegion(
  raster: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  const left = Math.max(0, Math.floor(x0))
  const top = Math.max(0, Math.floor(y0))
  const right = Math.min(raster.width, Math.ceil(x1))
  const bottom = Math.min(raster.height, Math.ceil(y1))
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (!isDark(raster.data, (y * raster.width + x) * 4)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minX)) return undefined
  return { minX, minY, maxX, maxY }
}

/** 整页的墨迹包围盒。 */
function inkBounds(raster: Raster): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  return inkBoundsInRegion(raster, 0, 0, raster.width, raster.height)
}

/** 把像素包围盒换算成页面坐标（未旋转的可见区域坐标，pt）。 */
function pixelBoxToPageBox(
  raster: Raster,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  visible: Box,
): Box {
  const x0 = visible.x + bounds.minX / raster.scale
  const x1 = visible.x + (bounds.maxX + 1) / raster.scale
  // 像素 y 向下，PDF y 向上：整页高度减去行号。
  const y1 = visible.y + visible.height - bounds.minY / raster.scale
  const y0 = visible.y + visible.height - (bounds.maxY + 1) / raster.scale
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
}

/** …… 自动测缝 …………………………………………………………………………………………… */

export interface GutterOptions {
  axis: TwoUpAxis
  /** 渲染倍率，默认 1（低倍即可，测的是空白带不是细节）。 */
  scale?: number
}

export interface GutterDetection {
  /** 切分线到可见区域「左边缘（左右切）/ 下边缘（上下切）」的距离，pt。 */
  gutterPt: number
  /** 检出的空白带宽度，pt。 */
  bandWidthPt: number
  confidence: 'high' | 'low'
  /** 是否回退到中线。 */
  fellBack: boolean
  /** 回退原因（中文）。 */
  reason?: string
}

/**
 * 在中线附近找 2-up 的中缝，用作切分线。
 *
 * ## 为什么按「左右内容框的间隔」找，而不是找「全空列」
 *
 * 真实讲义的中缝常常垫了一层浅灰底，或有扫描噪点、页眉页脚的细线横跨中线。按「整列一个暗像素
 * 都没有」去找，会把本来分得很开的两栏判成「无中缝」。所以这里改成：
 *
 *   1. 低倍渲染整页；
 *   2. 以中线为界分左右（上下切则分上下）两半，各取**内容包围盒**；
 *   3. 缝 = 左半内容框的右边界 ↔ 右半内容框的左边界之间的间隔，缝的位置取间隔中点。
 *
 * 「有内容」的下限是 `MIN_CONTENT_LINE_RATIO`（一条列/行至少 3% 的暗像素），
 * 否则中缝里的浅灰底、噪点、断虚线会把包围盒顶到中线，把分得很开的两栏误判成没有缝。
 *
 * 间隔 < 8pt、某一半没有内容、或缝偏离中线 > 15% → **回退中线**，并在返回值里说明
 * `fellBack: true` 与原因——「猜一个缝」比明确回退更危险。
 */
export async function detectGutter(
  sourcePath: string,
  pageNumber: number,
  options: GutterOptions,
): Promise<GutterDetection> {
  const scale = options.scale !== undefined && options.scale > 0 ? options.scale : 1
  const bytes = new Uint8Array(await readFile(sourcePath))
  const doc = await loadPdfForWrite(bytes, { updateMetadata: false } as never)
  const page = doc.getPages()[pageNumber - 1]
  if (page === undefined) throw new Error(`第 ${pageNumber} 页不存在`)
  const boxes = readPageBoxes(page)

  const horizontal = options.axis === 'left-right'
  const extent = horizontal ? boxes.visible.width : boxes.visible.height
  const middle = extent / 2
  const fallback = (reason: string, bandWidthPt = 0): GutterDetection => ({
    gutterPt: middle,
    bandWidthPt,
    confidence: 'low',
    fellBack: true,
    reason,
  })
  if (!(extent > 0)) return fallback('页面可见区域为空，无法测缝')
  if (boxes.rotate % 360 !== 0) {
    return fallback(`页面带 /Rotate ${boxes.rotate}°，无法按页宽/页高方向测缝，已回退中线`)
  }

  const raster = await rasterize(sourcePath, pageNumber, scale)
  const length = horizontal ? raster.width : raster.height
  const cross = horizontal ? raster.height : raster.width
  const half = Math.floor(length / 2)

  // 每条列/线上的暗像素数。
  const counts = new Int32Array(length)
  for (let along = 0; along < length; along += 1) {
    let count = 0
    for (let other = 0; other < cross; other += 1) {
      const x = horizontal ? along : other
      const y = horizontal ? other : along
      if (isDark(raster.data, (y * raster.width + x) * 4)) count += 1
    }
    counts[along] = count
  }
  // 一条线至少有 3% 的暗像素才算「有内容」。中缝里常见浅灰底、扫描噪点、被打断的细虚线，
  // 它们会让内容包围盒一直顶到中线，从而把本来分得很开的两栏误判成「没有缝」。
  const contentFloor = Math.max(1, Math.ceil(cross * MIN_CONTENT_LINE_RATIO))
  const hasContent = (index: number): boolean => counts[index] >= contentFloor

  // 左右切：左半是 [0, half)，取其中最靠中线的有内容列；右半是 [half, length)，取最靠中线的列。
  // 上下切：下半是 [half, length)（靠近「到可见区域」的那条边），上半是 [0, half)。
  let nearEdge = -1
  let farEdge = -1
  if (horizontal) {
    for (let x = half - 1; x >= 0; x -= 1) if (hasContent(x)) { nearEdge = x; break }
    for (let x = half; x < length; x += 1) if (hasContent(x)) { farEdge = x; break }
  } else {
    for (let y = half; y < length; y += 1) if (hasContent(y)) { nearEdge = y; break }
    for (let y = half - 1; y >= 0; y -= 1) if (hasContent(y)) { farEdge = y; break }
  }

  if (nearEdge < 0 || farEdge < 0) {
    return fallback('中线一侧没有检测到内容，无法判断中缝，已回退中线')
  }

  const gapPx = Math.abs(nearEdge - farEdge) - 1
  const bandWidthPt = gapPx / scale
  if (bandWidthPt < MIN_GUTTER_BAND_PT) {
    return fallback(
      `未找到可靠中缝：两栏内容之间的间隔只有 ${Math.max(0, bandWidthPt).toFixed(1)}pt`
      + `（小于 ${MIN_GUTTER_BAND_PT}pt），按中线对半`,
      Math.max(0, bandWidthPt),
    )
  }

  const midAlong = ((nearEdge + farEdge) / 2) / scale
  const offset = Math.abs(midAlong - middle)
  if (offset > extent * 0.15) {
    return fallback(
      `未找到可靠中缝：检出的间隔中点偏离中线 ${offset.toFixed(1)}pt（超过 15%），按中线对半`,
      bandWidthPt,
    )
  }

  // 竖向时「到可见区域的距离」从下边缘算起，而像素行号从上往下。
  const gutterPt = horizontal ? midAlong : extent - midAlong
  return {
    gutterPt,
    bandWidthPt,
    confidence: bandWidthPt >= extent * 0.04 ? 'high' : 'low',
    fellBack: false,
  }
}

/** …… 裁剪 ……………………………………………………………………………………………… */

/** 用户给的裁切矩形（pt，页面绝对坐标，原点左下）。 */
export interface CropBoxInput {
  left: number
  bottom: number
  right: number
  top: number
}

export interface CropOptions {
  mode: 'fixed' | 'trim'
  /** fixed 模式必填。 */
  box?: CropBoxInput
  /** trim 模式留白，默认 6pt。 */
  margin?: number
  /** trim 模式是否取所有页的并集，默认 true。 */
  uniform?: boolean
  /** 只改 /CropBox、不动 /MediaBox，默认 false。 */
  setCropBoxOnly?: boolean
  /** trim 模式渲染找内容边界用；fixed 模式不需要。 */
  sourcePath?: string
  /** trim 模式渲染倍率，默认 1.5。 */
  scale?: number
}

export interface CropPageOutcome {
  /** 1-based 页号。 */
  page: number
  /** 实际使用的裁切框（页面绝对坐标）。 */
  box: Box
  /** 被裁掉的面积占原可见区域的比例（0..1）。 */
  croppedRatio: number
  /** 请求的框越界、被收拢过。 */
  clamped: boolean
  notes: string[]
}

function toBox(input: CropBoxInput): Box {
  const left = Number(input.left)
  const bottom = Number(input.bottom)
  const right = Number(input.right)
  const top = Number(input.top)
  if (![left, bottom, right, top].every(Number.isFinite)) {
    throw new Error('裁切框 left/bottom/right/top 必须都是数字（单位 pt）')
  }
  if (right <= left) throw new Error(`裁切框无效：right（${right}）必须大于 left（${left}）`)
  if (top <= bottom) throw new Error(`裁切框无效：top（${top}）必须大于 bottom（${bottom}）`)
  return { x: left, y: bottom, width: right - left, height: top - bottom }
}

function inflate(box: Box, margin: number): Box {
  return {
    x: box.x - margin,
    y: box.y - margin,
    width: box.width + margin * 2,
    height: box.height + margin * 2,
  }
}

function formatBox(box: Box): string {
  return `[${box.x.toFixed(1)}, ${box.y.toFixed(1)}, ${(box.x + box.width).toFixed(1)}, ${(box.y + box.height).toFixed(1)}]`
}

/**
 * 批量裁剪：只改页面框，**绝不缩放**。
 *
 * - `fixed`：所有页用同一个矩形（页面绝对坐标），越界收拢到可见区域并记一条中文提示；
 * - `trim`：逐页渲染找内容边界（暗像素包围盒）再加 margin；`uniform` 时取所有页的并集，
 *   保证裁完每页尺寸一致。
 *
 * 返回每页的实际裁切框与被裁掉的比例，供结果文本使用。
 */
export async function cropPages(
  doc: PDFDocument,
  pageIndices: readonly number[],
  options: CropOptions,
): Promise<CropPageOutcome[]> {
  const pages = doc.getPages()
  const margin = options.margin !== undefined && Number.isFinite(options.margin) ? options.margin : 6
  const uniform = options.uniform !== false
  const setCropBoxOnly = options.setCropBoxOnly === true
  const scaleDefault = options.scale !== undefined && options.scale > 0 ? options.scale : 1.5

  const boxesOf = pageIndices.map(index => {
    const page = pages[index]
    if (page === undefined) throw new Error(`第 ${index + 1} 页不存在`)
    return readPageBoxes(page)
  })

  /** 每页「请求的」裁切框（可能越界，用于判断是否收拢过）。 */
  const requestedBoxes: Box[] = []

  if (options.mode === 'fixed') {
    if (options.box === undefined) throw new Error('mode=fixed 需要提供 box（left/bottom/right/top，单位 pt）')
    const requested = toBox(options.box)
    for (let i = 0; i < boxesOf.length; i += 1) requestedBoxes.push(requested)
  } else if (options.mode === 'trim') {
    if (options.sourcePath === undefined) {
      throw new Error('mode=trim 需要 sourcePath 才能渲染页面找内容边界')
    }
    const bounds: Array<Box | undefined> = []
    for (const [i, index] of pageIndices.entries()) {
      const boxes = boxesOf[i]
      if (boxes.rotate % 360 !== 0) {
        bounds.push(undefined)
        continue
      }
      const raster = await rasterize(options.sourcePath, index + 1, scaleDefault)
      const ink = inkBounds(raster)
      bounds.push(ink === undefined ? undefined : pixelBoxToPageBox(raster, ink, boxes.visible))
    }
    // uniform：取所有页 bbox 的并集，保证裁完页尺寸一致。
    let shared: Box | undefined
    if (uniform) {
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      for (const box of bounds) {
        if (box === undefined) continue
        minX = Math.min(minX, box.x)
        minY = Math.min(minY, box.y)
        maxX = Math.max(maxX, box.x + box.width)
        maxY = Math.max(maxY, box.y + box.height)
      }
      if (Number.isFinite(minX)) shared = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    }
    for (const [i] of pageIndices.entries()) {
      const pageBox = bounds[i] ?? boxesOf[i].visible
      const base = uniform ? (shared ?? pageBox) : pageBox
      requestedBoxes.push(inflate(base, margin))
    }
  } else {
    throw new Error(`未知的裁剪模式：${String(options.mode)}`)
  }

  const outcomes: CropPageOutcome[] = []
  for (const [i, index] of pageIndices.entries()) {
    const page = pages[index]
    const boxes = boxesOf[i]
    const requested = requestedBoxes[i]
    const final = intersectBox(requested, boxes.visible)
    const notes: string[] = []

    if (final.width <= 0 || final.height <= 0) {
      throw new Error(`第 ${index + 1} 页：裁切框与页面可见区域没有交集，请检查 box 或 margin`)
    }
    const clamped = Math.abs(final.x - requested.x) > 0.01
      || Math.abs(final.y - requested.y) > 0.01
      || Math.abs(final.width - requested.width) > 0.01
      || Math.abs(final.height - requested.height) > 0.01
    if (clamped) {
      notes.push(`第 ${index + 1} 页：裁切框超出页面可见区域，已收拢为 ${formatBox(final)}`)
    }
    if (options.mode === 'trim' && boxes.rotate % 360 !== 0) {
      notes.push(`第 ${index + 1} 页：带 /Rotate ${boxes.rotate}°，trim 无法确定内容方向，保留原页面框`)
    }

    if (!setCropBoxOnly) page.setMediaBox(final.x, final.y, final.width, final.height)
    page.setCropBox(final.x, final.y, final.width, final.height)

    const visibleArea = boxes.visible.width * boxes.visible.height
    const kept = final.width * final.height
    outcomes.push({
      page: index + 1,
      box: final,
      croppedRatio: visibleArea > 0 ? Math.max(0, Math.min(1, 1 - kept / visibleArea)) : 0,
      clamped,
      notes,
    })
  }
  return outcomes
}

/** …… 页序 ……………………………………………………………………………………………… */

/**
 * 解析显式页范围串：`1,3,5`、`1-3,7`、`4-6`。返回 0 基页号。
 *
 * 越界与无法解析都给中文错误（例：`顺序里的第 9 页超出文档页数 6`）。
 * 允许重复（重排时「把第 1 页放两次」是合理诉求）。
 */
export function parsePageSelection(spec: string, pageCount: number): number[] {
  const text = String(spec ?? '').trim()
  if (text === '') throw new Error('页码范围不能为空')
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('文档页数无效')
  const parts = text.split(/[,，;；\s]+/).filter(part => part !== '')
  const out: number[] = []
  for (const part of parts) {
    const range = /^(\d+)\s*[-–—~]\s*(\d+)$/.exec(part)
    if (range !== null) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start < 1 || end < 1 || end > pageCount) {
        throw new Error(`顺序里的第 ${end > pageCount ? end : start} 页超出文档页数 ${pageCount}`)
      }
      if (start > end) throw new Error(`顺序里的区间「${part}」起点大于终点`)
      for (let n = start; n <= end; n += 1) out.push(n - 1)
      continue
    }
    if (!/^\d+$/.test(part)) {
      throw new Error(`无法解析的页序片段「${part}」（支持 1、1-3、1,3,5，或预设 odd-even / reverse / swap-pairs）`)
    }
    const n = Number(part)
    if (n < 1 || n > pageCount) throw new Error(`顺序里的第 ${n} 页超出文档页数 ${pageCount}`)
    out.push(n - 1)
  }
  if (out.length === 0) throw new Error('页序里没有解析出任何页')
  return out
}

/**
 * 解析顺序串 → 0 基页号数组。
 *
 * 支持显式列表 / 区间 / 混合，以及三个预设：
 *   - `odd-even`   先所有奇数页、再所有偶数页（1,3,5,…,2,4,6,…）；
 *   - `reverse`    逆序；
 *   - `swap-pairs` 两两互换（2,1,4,3,…）。
 */
export function parsePageOrder(spec: string, pageCount: number): number[] {
  const key = String(spec ?? '').trim().toLowerCase()
  if (key === '') throw new Error('页序不能为空')
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('文档页数无效')

  if (key === 'odd-even') {
    const odds: number[] = []
    const evens: number[] = []
    for (let n = 1; n <= pageCount; n += 1) (n % 2 === 1 ? odds : evens).push(n - 1)
    return [...odds, ...evens]
  }
  if (key === 'reverse') {
    const all: number[] = []
    for (let n = pageCount; n >= 1; n -= 1) all.push(n - 1)
    return all
  }
  if (key === 'swap-pairs') {
    const all: number[] = []
    for (let n = 0; n < pageCount; n += 2) {
      all.push(n)
      if (n + 1 < pageCount) all.push(n + 1)
    }
    // 上面是 [0,1,2,3…]，把它两两互换。
    const swapped: number[] = []
    for (let i = 0; i < all.length; i += 2) {
      if (i + 1 < all.length) swapped.push(all[i + 1])
      swapped.push(all[i])
    }
    return swapped
  }
  return parsePageSelection(spec, pageCount)
}

/** …… 合并 ……………………………………………………………………………………………… */

export interface MergedPageInfo {
  /** 来源文件名（不含目录）。 */
  file: string
  /** 来源文件完整路径。 */
  path: string
  /** 在来源文件里的原页号（1 基）。 */
  sourcePage: number
}

export interface MergeResult {
  doc: PDFDocument
  pages: MergedPageInfo[]
  pageCount: number
  notes: string[]
}

/** 打开一个 PDF；加密或损坏时给中文错误。 */
export async function loadPdfDocument(path: string): Promise<PDFDocument> {
  const bytes = new Uint8Array(await readFile(path))
  try {
    return await loadPdfForWrite(bytes, { updateMetadata: false } as never)
  } catch (error) {
    const name = (error as Error)?.name ?? ''
    if (name.includes('Encrypted')) {
      throw new Error(`${basename(path)} 已加密，无法读写页面结构。请先用 pdf_protect action=decrypt 解除保护。`)
    }
    throw new Error(`${basename(path)} 无法作为 PDF 打开：${(error as Error)?.message ?? String(error)}`)
  }
}

/**
 * 按文件顺序拼接多个 PDF，每个文件可选页范围。
 *
 * 页数、每页来源（文件名 + 原页号）通过返回值回报，供结果文本逐条列出。
 */
export async function mergeDocuments(
  paths: readonly string[],
  ranges?: ReadonlyArray<string | undefined>,
): Promise<MergeResult> {
  if (paths.length < 2) {
    throw new Error(`合并至少需要 2 个文件，当前只给了 ${paths.length} 个`)
  }
  const doc = await PDFDocument.create()
  const pages: MergedPageInfo[] = []
  const notes: string[] = []

  for (const [i, path] of paths.entries()) {
    const source = await loadPdfDocument(path)
    const count = source.getPageCount()
    if (count < 1) throw new Error(`${basename(path)} 没有可用的页面`)
    const spec = ranges?.[i]
    const wanted = spec === undefined || String(spec).trim() === ''
      ? Array.from({ length: count }, (_, n) => n)
      : parsePageSelection(String(spec), count)
    const copied = await doc.copyPages(source, wanted)
    for (const [j, page] of copied.entries()) {
      doc.addPage(page)
      pages.push({ file: basename(path), path, sourcePage: wanted[j] + 1 })
    }
    notes.push(`${basename(path)}：取 ${wanted.length} 页（原 ${count} 页）`)
  }

  return { doc, pages, pageCount: pages.length, notes }
}

/** …… 旋转 ……………………………………………………………………………………………… */

export interface RotateOutcome {
  /** 1-based 页号（在传入的 doc 里）。 */
  page: number
  from: number
  to: number
}

/**
 * 只改 `/Rotate`（归一化到 0/90/180/270），不动内容。
 *
 * 这是「把横放的页面转正」这类诉求的正确做法：旋转页面的绘制内容会牵动坐标系，
 * 改 `/Rotate` 让阅读器去转，代价最低、也最容易撤销。
 */
export function rotatePages(doc: PDFDocument, pageIndices: readonly number[], angle: number): RotateOutcome[] {
  if (!Number.isFinite(angle) || angle % 90 !== 0) {
    throw new Error(`旋转角度必须是 90 的倍数，收到 ${String(angle)}`)
  }
  const delta = normalizeRotate(angle)
  const pages = doc.getPages()
  const out: RotateOutcome[] = []
  for (const index of pageIndices) {
    const page = pages[index]
    if (page === undefined) throw new Error(`第 ${index + 1} 页不存在`)
    const from = readPageBoxes(page).rotate
    const to = normalizeRotate(from + delta)
    page.node.set(PDFName.of('Rotate'), PDFNumber.of(to))
    out.push({ page: index + 1, from, to })
  }
  return out
}

/** 模块标识，便于测试 grep。 */
export const PAGE_ASSEMBLY_MODULE = 'dsh-pdf-studio/core/page-assembly'
