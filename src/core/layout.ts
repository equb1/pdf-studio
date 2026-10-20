/**
 * 版面重排：统一页面尺寸/缩放、N-up 拼版、小册子。
 *
 * ## 三种做法，各自的技术选择（都是在真文件上试出来的）
 *
 * - **缩放（resize）**：`copyPages` 复制页面 → 改 `/MediaBox`/`/CropBox` → 在内容流**最前面**
 *   插一条 `q s 0 0 s tx ty cm … Q`。不嵌套 XObject、体积小、**文字保持原生可搜索**
 *   （对比 `embedPage` 方案在同一份文件上大 37KB）。
 * - **N-up**：一张纸放 N 个源页只能把每页当 Form XObject 画上去（`embedPage` + `drawPage`）。
 *   代价：**会丢掉源页的注释/表单域**（embedPage 只嵌页面内容），必须在确认单里说清。
 * - **小册子（booklet）**：先算出一张纸正反面该放哪两页（1↔末、2↔倒数第二…），再走 N-up。
 *
 * ## 缩放不会动注释
 *
 * `cm` 只作用于**内容流**；注释的 `/Rect`、`/QuadPoints` 与表单域位置都在页面坐标系里，
 * 不会跟着缩放。所以调用方要先统计注释数量并**在计划里提示**（见 `countAnnots`）。
 */

import { PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { loadPdfForWrite } from './pdf.ts'
import type { PdfRect } from './contracts.ts'

/** 支持的纸张（pt）。 */
export const LAYOUT_PAPER: Readonly<Record<string, [number, number]>> = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
}

/** 把 `a4` / `a4-landscape` / `{width,height}` 解析成 `[宽, 高]`。 */
export function parseTargetSize(spec: string | undefined, fallback: [number, number] = LAYOUT_PAPER.a4): [number, number] {
  if (spec === undefined || spec.trim() === '') return fallback
  const text = spec.trim().toLowerCase()
  const [name, orientation] = text.split('-')
  const paper = LAYOUT_PAPER[name]
  if (paper === undefined) {
    throw new Error(`纸张 "${spec}" 不支持；可用 ${Object.keys(LAYOUT_PAPER).join(' / ')}，或写成 a4-landscape`)
  }
  if (orientation === undefined) return paper
  if (orientation === 'landscape') return [Math.max(...paper), Math.min(...paper)]
  if (orientation === 'portrait') return [Math.min(...paper), Math.max(...paper)]
  throw new Error(`方向 "${orientation}" 不支持；可用 portrait / landscape`)
}

/**
 * 算"等比缩放到目标页内并居中"的缩放与平移。
 *
 * `mode='fit'` 保持长宽比（可能留白）；`mode='stretch'` 两轴各自拉伸（会变形，慎用）。
 */
export function fitTransform(
  source: { width: number; height: number },
  target: [number, number],
  options: { margin?: number; mode?: 'fit' | 'stretch' } = {},
): { scaleX: number; scaleY: number; translateX: number; translateY: number } {
  const margin = options.margin ?? 0
  const [targetWidth, targetHeight] = target
  const usableWidth = Math.max(1, targetWidth - margin * 2)
  const usableHeight = Math.max(1, targetHeight - margin * 2)
  const mode = options.mode ?? 'fit'
  const scaleX = usableWidth / Math.max(1, source.width)
  const scaleY = usableHeight / Math.max(1, source.height)
  const scale = mode === 'stretch' ? undefined : Math.min(scaleX, scaleY)
  const finalX = mode === 'stretch' ? scaleX : (scale as number)
  const finalY = mode === 'stretch' ? scaleY : (scale as number)
  return {
    scaleX: finalX,
    scaleY: finalY,
    translateX: (targetWidth - source.width * finalX) / 2,
    translateY: (targetHeight - source.height * finalY) / 2,
  }
}

/** 统计每页注释数量（缩放/N-up 前用来提示）。 */
export function countAnnotsPerPage(doc: PDFDocument): number {
  let total = 0
  for (const page of doc.getPages()) {
    const annots = page.node.Annots()
    if (annots instanceof PDFArray) total += annots.size()
  }
  return total
}

/** N-up 的网格：每张纸放几页 → 列 × 行。 */
export function nupGrid(perSheet: number): { cols: number; rows: number } {
  switch (perSheet) {
    case 2: return { cols: 2, rows: 1 }
    case 4: return { cols: 2, rows: 2 }
    case 6: return { cols: 3, rows: 2 }
    case 8: return { cols: 4, rows: 2 }
    case 9: return { cols: 3, rows: 3 }
    default: throw new Error(`每张纸放 ${perSheet} 页不支持；可用 2 / 4 / 6 / 8 / 9`)
  }
}

/**
 * 小册子（骑马钉）的页面顺序。
 *
 * 一张纸的正面放「最后一页 + 第 1 页」，反面放「第 2 页 + 倒数第二页」，依此类推；
 * 不足的位置用 `undefined` 占位（留白）。
 */
export function bookletSheets(pageCount: number): Array<[number | undefined, number | undefined]> {
  const sheets: Array<[number | undefined, number | undefined]> = []
  let left = 1
  let right = pageCount
  while (left <= right) {
    // 正面：[右, 左]；反面：[左+1, 右-1]，与"对折后页码顺序正确"一致。
    sheets.push([right, left])
    right -= 1
    left += 1
    if (left <= right) {
      sheets.push([left, right])
      left += 1
      right -= 1
    }
  }
  return sheets
}

/** 在页面内容流最前面插一条变换（`q a b c d e f cm … Q`）。 */
function prependTransform(doc: PDFDocument, page: { node: { get(key: unknown): unknown; set(key: unknown, value: unknown): void } }, transform: number[]): void {
  const context = doc.context
  const prefix = context.register(PDFRawStream.of(context.obj({}), Buffer.from(`q ${transform.join(' ')} cm\n`, 'latin1')))
  const suffix = context.register(PDFRawStream.of(context.obj({}), Buffer.from('\nQ', 'latin1')))
  const contents = page.node.get(PDFName.of('Contents'))
  const existing = contents instanceof PDFArray ? contents.asArray().map(item => item) : [contents]
  page.node.set(PDFName.of('Contents'), context.obj([prefix, ...existing, suffix] as never))
}

/**
 * 统一页面尺寸：把每页内容等比缩放到目标纸张并居中。
 *
 * 只改页面框 + 前插缩放矩阵，**不栅格化**，文字仍可搜索。
 * 注意：注释/表单域的位置不会跟着缩放（调用方负责提示）。
 */
export async function resizePages(
  bytes: Uint8Array,
  options: { target: [number, number]; margin?: number; mode?: 'fit' | 'stretch'; pages?: number[] },
): Promise<{ bytes: Uint8Array; resized: number[]; scales: Record<number, number> }> {
  const source = await loadPdfForWrite(bytes, { updateMetadata: false })
  const output = await PDFDocument.create()
  const wanted = options.pages ?? source.getPages().map((_, index) => index + 1)
  const [targetWidth, targetHeight] = options.target
  const scales: Record<number, number> = {}
  for (const pageNumber of wanted) {
    const [copied] = await output.copyPages(source, [pageNumber - 1])
    if (copied === undefined) continue
    output.addPage(copied)
    const size = copied.getSize()
    const transform = fitTransform(size, options.target, { margin: options.margin ?? 0, mode: options.mode })
    scales[pageNumber] = transform.scaleX
    copied.setMediaBox(0, 0, targetWidth, targetHeight)
    copied.setCropBox(0, 0, targetWidth, targetHeight)
    prependTransform(output, copied as never, [
      transform.scaleX, 0, 0, transform.scaleY, transform.translateX, transform.translateY,
    ])
  }
  return { bytes: detachedSafeCopy(await output.save()), resized: wanted, scales }
}

/**
 * N-up 拼版：每张纸放 `perSheet` 个源页（可给自定义的"每张纸放哪些页"顺序，小册子用它）。
 *
 * 走 `embedPage`，因此**源页的注释/表单域不会带过去**。
 */
export async function nupPages(
  bytes: Uint8Array,
  options: {
    perSheet: number
    target: [number, number]
    margin?: number
    gap?: number
    sheets?: Array<Array<number | undefined>>
  },
): Promise<{ bytes: Uint8Array; sheets: number }> {
  const source = await loadPdfForWrite(bytes, { updateMetadata: false })
  const output = await PDFDocument.create()
  const { cols, rows } = nupGrid(options.perSheet)
  const margin = options.margin ?? 0
  const gap = options.gap ?? 0
  const pageCount = source.getPageCount()
  const plan: Array<Array<number | undefined>> = options.sheets ?? (() => {
    const groups: Array<Array<number | undefined>> = []
    for (let start = 1; start <= pageCount; start += options.perSheet) {
      const group: Array<number | undefined> = []
      for (let offset = 0; offset < options.perSheet; offset += 1) {
        const pageNumber = start + offset
        group.push(pageNumber <= pageCount ? pageNumber : undefined)
      }
      groups.push(group)
    }
    return groups
  })()

  const cellWidth = (options.target[0] - margin * 2 - gap * (cols - 1)) / cols
  const cellHeight = (options.target[1] - margin * 2 - gap * (rows - 1)) / rows
  const embedded = new Map<number, Awaited<ReturnType<typeof output.embedPage>>>()
  for (const group of plan) {
    const sheet = output.addPage(options.target)
    for (const [index, pageNumber] of group.entries()) {
      if (pageNumber === undefined || pageNumber < 1 || pageNumber > pageCount) continue
      let image = embedded.get(pageNumber)
      if (image === undefined) {
        image = await output.embedPage(source.getPages()[pageNumber - 1])
        embedded.set(pageNumber, image)
      }
      const column = index % cols
      const row = Math.floor(index / cols)
      const size = source.getPages()[pageNumber - 1].getSize()
      const scale = Math.min(cellWidth / size.width, cellHeight / size.height)
      const width = size.width * scale
      const height = size.height * scale
      const cellX = margin + column * (cellWidth + gap)
      // 行从**上往下**排：第一行在纸面上方
      const cellY = options.target[1] - margin - (row + 1) * cellHeight - row * gap
      sheet.drawPage(image, {
        x: cellX + (cellWidth - width) / 2,
        y: cellY + (cellHeight - height) / 2,
        xScale: scale,
        yScale: scale,
      })
    }
  }
  return { bytes: detachedSafeCopy(await output.save()), sheets: plan.length }
}

/** 目标纸张的矩形（给"越界/居中断言"用）。 */
export function targetRect(target: [number, number]): PdfRect {
  return { x: 0, y: 0, width: target[0], height: target[1] }
}

/**
 * 把字节拷到**独立 ArrayBuffer**里。
 *
 * Node 的 `Buffer`/小 `Uint8Array` 分配来自共享池，别处一旦 `transfer` 就会把整段池分离，
 * 于是写出时抛 `Cannot perform Construct on a detached ArrayBuffer`（本机 Node 26 实测）。
 * `new ArrayBuffer()` 不走池，能彻底避开。
 */
export function detachedSafeCopy(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length))
  copy.set(bytes)
  return copy
}
