/**
 * 渲染 + ink 高度测量辅助（**不带 dom-shim** 运行）。
 *
 * 为什么单独一个文件：PDF 渲染必须走真实的 `@napi-rs/canvas`（有真正的 `Path2D`），
 * 而测试用的 `test/support/dom-shim.mjs` 会把 `Path2D` 换成一个简化替身，pdf.js 的
 * `constructPath` 在它上面会抛 `Value is none of these types String, Path`。所以渲染要放到
 * 一个**不加载 dom-shim 的子进程**里跑，主测试用 `execFileSync` 调它。
 *
 * 用法：
 *   node --experimental-strip-types test/support/render-ink.mjs <pdf> '<json>'
 *   json = { page, scale, band: [yBottomPt, yTopPt], columns: [{ name, x0, x1 }] }
 * 输出（一行 JSON）：
 *   [{ name, darkPixels, inkTopPt?, inkBottomPt?, inkHeightPt? }]
 *
 * `band` 与列的 x 都是 PDF 坐标（pt，原点左下）。ink 判定为亮度 < 128 的像素：
 * 浅灰的水印（约 0.75 → 192）不会计入。
 */

import { readFile } from 'node:fs/promises'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { renderPagePng } from '../../src/host/render.ts'
import { openPdfBytes, pageSize } from '../../src/core/pdf.ts'

const [pdfPath, specJson] = process.argv.slice(2)
if (pdfPath === undefined || specJson === undefined) {
  console.error('usage: render-ink.mjs <pdf> <json-spec>')
  process.exit(2)
}
const spec = JSON.parse(specJson)

const doc = await openPdfBytes(new Uint8Array(await readFile(pdfPath)))
const size = await pageSize(doc, spec.page)
await doc.dispose()

const png = await renderPagePng(pdfPath, spec.page, spec.scale)
const image = await loadImage(Buffer.from(png))
const canvas = createCanvas(image.width, image.height)
const context = canvas.getContext('2d')
context.drawImage(image, 0, 0)
const pixels = context.getImageData(0, 0, image.width, image.height).data

const toRow = (yPt) => Math.round((size.height - yPt) * spec.scale)
const rowTop = Math.max(0, toRow(spec.band[1]))
const rowBottom = Math.min(image.height - 1, toRow(spec.band[0]))

const results = []
for (const column of spec.columns) {
  const x0 = Math.max(0, Math.round(column.x0 * spec.scale))
  const x1 = Math.min(image.width - 1, Math.round(column.x1 * spec.scale))
  let minRow = Number.POSITIVE_INFINITY
  let maxRow = Number.NEGATIVE_INFINITY
  let darkPixels = 0
  for (let y = rowTop; y <= rowBottom; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const index = (y * image.width + x) * 4
      const luminance = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3
      if (luminance >= 128) continue
      darkPixels += 1
      if (y < minRow) minRow = y
      if (y > maxRow) maxRow = y
    }
  }
  results.push(darkPixels === 0
    ? { name: column.name, darkPixels }
    : {
        name: column.name,
        darkPixels,
        inkTopPt: size.height - minRow / spec.scale,
        inkBottomPt: size.height - (maxRow + 1) / spec.scale,
        inkHeightPt: (maxRow - minRow + 1) / spec.scale,
      })
}
console.log(JSON.stringify(results))
