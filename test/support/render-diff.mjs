/**
 * 渲染 + 合成 + 像素比较辅助（**不带 dom-shim** 的子进程脚本）。
 *
 * 为什么单独一个文件：PDF 渲染必须走真实的 `@napi-rs/canvas`（有真正的 `Path2D`），
 * 而测试用的 `test/support/dom-shim.mjs` 会把 `Path2D` 换成简化替身，pdf.js 的
 * `constructPath` 在它上面会抛错。所以渲染与像素比较都放到一个**不加载 dom-shim 的子进程**里跑，
 * 主测试用 `execFileSync` 调它并只解析结果 JSON。
 *
 * 用法：
 *   node --experimental-strip-types test/support/render-diff.mjs '<json>'
 *
 * spec = {
 *   scale: 1,                                  // 渲染倍率，默认 1
 *   left:  side, right: side,                  // 两侧；right 省略时只测量 left
 * }
 * side = {
 *   pages: [{ path, page }],                   // 按顺序渲染并拼成一张图
 *   direction: 'horizontal' | 'vertical',      // 拼接方向，默认 horizontal
 *   cropPt: [x0, y0, x1, y1],                  // 可选：比较前按 PDF 坐标（原点左下）裁出这块
 * }
 *
 * 输出一行 JSON：
 * {
 *   left:  { width, height, inkPt? },          // width/height 是比较图（裁切后）的像素尺寸
 *   right: { width, height, inkPt? },          // inkPt 是**裁切前**整张图里暗像素的包围盒（pt，原点左下）
 *   diffPixels, diffRatio, totalPixels, maxDelta
 * }
 *
 * ink 判定为亮度 < 128 的像素（与 render-ink.mjs 一致）：浅灰水印（约 192）不会计入。
 * 像素差异判定为任一通道相差 > 32。
 */

import { readFile } from 'node:fs/promises'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { renderPagePng } from '../../src/host/render.ts'
import { openPdfBytes, pageSize } from '../../src/core/pdf.ts'

const specJson = process.argv[2]
if (specJson === undefined) {
  console.error('usage: render-diff.mjs <json-spec>')
  process.exit(2)
}
const spec = JSON.parse(specJson)
const scale = typeof spec.scale === 'number' && spec.scale > 0 ? spec.scale : 1
const TOLERANCE = 32
const DARK = 128

/** 渲染一页并把像素画到自建 canvas 上。 */
async function renderInto(path, page) {
  const png = await renderPagePng(path, page, scale)
  const image = await loadImage(Buffer.from(png))
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.fillStyle = 'white'
  context.fillRect(0, 0, image.width, image.height)
  context.drawImage(image, 0, 0)
  return { image, canvas, context }
}

/** 把若干页按方向拼成一张图，返回 canvas 与其像素尺寸。 */
async function compose(side) {
  const pages = side.pages ?? []
  const rendered = []
  for (const entry of pages) {
    rendered.push(await renderInto(entry.path, entry.page))
  }
  const horizontal = side.direction !== 'vertical'
  const totalWidth = horizontal
    ? rendered.reduce((sum, item) => sum + item.image.width, 0)
    : Math.max(...rendered.map(item => item.image.width))
  const totalHeight = horizontal
    ? Math.max(...rendered.map(item => item.image.height))
    : rendered.reduce((sum, item) => sum + item.image.height, 0)

  const canvas = createCanvas(Math.max(1, totalWidth), Math.max(1, totalHeight))
  const context = canvas.getContext('2d')
  context.fillStyle = 'white'
  context.fillRect(0, 0, canvas.width, canvas.height)
  let offset = 0
  for (const item of rendered) {
    if (horizontal) context.drawImage(item.canvas, offset, 0)
    else context.drawImage(item.canvas, 0, offset)
    offset += horizontal ? item.image.width : item.image.height
  }
  return { canvas, width: canvas.width, height: canvas.height }
}

/** 暗像素包围盒（像素坐标，原点左上）。 */
function inkBounds(data, width, height) {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      const luminance = (data[index] + data[index + 1] + data[index + 2]) / 3
      if (luminance >= DARK) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minX)) return undefined
  return { minX, minY, maxX, maxY }
}

/** 按 PDF 坐标（原点左下）裁出一块，返回新的 { canvas, width, height }。 */
function cropCanvas(composed, cropPt) {
  const [x0, y0, x1, y1] = cropPt
  const left = Math.max(0, Math.round(Math.min(x0, x1) * scale))
  const right = Math.min(composed.width, Math.round(Math.max(x0, x1) * scale))
  const top = Math.max(0, Math.round(composed.height - Math.max(y0, y1) * scale))
  const bottom = Math.min(composed.height, Math.round(composed.height - Math.min(y0, y1) * scale))
  const width = Math.max(1, right - left)
  const height = Math.max(1, bottom - top)
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = 'white'
  context.fillRect(0, 0, width, height)
  context.drawImage(composed.canvas, left, top, width, height, 0, 0, width, height)
  return { canvas, width, height }
}

/** 读取一张 canvas 的像素数据。 */
function pixelsOf(canvas) {
  const context = canvas.getContext('2d')
  return context.getImageData(0, 0, canvas.width, canvas.height).data
}

async function measure(side) {
  if (side === undefined) return undefined
  const composed = await compose(side)
  const full = pixelsOf(composed.canvas)
  const bounds = inkBounds(full, composed.width, composed.height)
  const inkPt = bounds === undefined ? undefined : {
    x: bounds.minX / scale,
    y: (composed.height - (bounds.maxY + 1)) / scale,
    width: (bounds.maxX - bounds.minX + 1) / scale,
    height: (bounds.maxY - bounds.minY + 1) / scale,
  }
  const compared = Array.isArray(side.cropPt) ? cropCanvas(composed, side.cropPt) : composed
  return {
    canvas: compared.canvas,
    width: compared.width,
    height: compared.height,
    ...(inkPt === undefined ? {} : { inkPt }),
  }
}

const left = await measure(spec.left)
const right = await measure(spec.right)

let diffPixels = 0
let totalPixels = 0
let maxDelta = 0
if (left !== undefined && right !== undefined) {
  if (left.width === right.width && left.height === right.height) {
    const a = pixelsOf(left.canvas)
    const b = pixelsOf(right.canvas)
    totalPixels = left.width * left.height
    for (let i = 0; i < a.length; i += 4) {
      const delta = Math.max(
        Math.abs(a[i] - b[i]),
        Math.abs(a[i + 1] - b[i + 1]),
        Math.abs(a[i + 2] - b[i + 2]),
      )
      if (delta > maxDelta) maxDelta = delta
      if (delta > TOLERANCE) diffPixels += 1
    }
  } else {
    totalPixels = Math.max(left.width * left.height, right.width * right.height)
    diffPixels = totalPixels
    maxDelta = 255
  }
}

const strip = side => side === undefined ? null : { width: side.width, height: side.height, ...(side.inkPt === undefined ? {} : { inkPt: side.inkPt }) }
console.log(JSON.stringify({
  left: strip(left),
  right: strip(right),
  diffPixels,
  diffRatio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
  totalPixels,
  maxDelta,
}))
