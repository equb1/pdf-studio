/**
 * Host-side page rasterisation.
 *
 * The canvas needs a bitmap backdrop to lay editable regions over. Rendering it
 * here (rather than in the browser) keeps the browser side free of pdf.js worker
 * configuration — one less environment-specific failure mode — and reuses the
 * render path the OCR stage already exercises on real scans.
 *
 * @module dsh-pdf-studio/host/render
 */

import { createRequire } from 'node:module'
import { openPdf } from '../core/pdf.ts'

const require = createRequire(import.meta.url)

/** Render one page to PNG bytes at `scale`. */
export async function renderPagePng(
  sourcePath: string,
  pageNumber: number,
  scale = 2,
): Promise<Uint8Array> {
  const { createCanvas } = require('@napi-rs/canvas') as {
    createCanvas(width: number, height: number): {
      getContext(type: '2d'): unknown
      toBuffer(mime: 'image/png'): Buffer
    }
  }

  const doc = await openPdf(sourcePath)
  try {
    if (pageNumber < 1 || pageNumber > doc.numPages) {
      throw new Error(`page ${pageNumber} out of range (1..${doc.numPages})`)
    }
    const page = await doc.getPage(pageNumber)
    const viewport = page.getViewport({ scale })
    const width = Math.max(1, Math.ceil(viewport.width))
    const height = Math.max(1, Math.ceil(viewport.height))
    const canvas = createCanvas(width, height)

    // PDF pages have no background of their own; without an explicit fill a
    // transparent PNG renders as black in most viewers, which looks broken.
    const context = canvas.getContext('2d') as {
      fillStyle: string
      fillRect(x: number, y: number, w: number, h: number): void
    }
    context.fillStyle = 'white'
    context.fillRect(0, 0, width, height)

    await page.render({ canvasContext: context, viewport }).promise
    return canvas.toBuffer('image/png')
  } finally {
    await doc.dispose()
  }
}

/**
 * 把某一页渲染成 JPEG。
 *
 * 先走 `renderPagePng`（pdf.js + 真实 canvas），再用 canvas 以指定质量转码成 JPEG。
 * 放在这里而不是工具层：工具层是 ESM，裸 `require` 会触发
 * "Cannot determine intended module format"；渲染相关的 native 加载统一在本模块做。
 */
export async function renderPageJpeg(
  sourcePath: string,
  pageNumber: number,
  scale = 2,
  quality = 0.9,
): Promise<Uint8Array> {
  const png = await renderPagePng(sourcePath, pageNumber, scale)
  const { createCanvas, loadImage } = require('@napi-rs/canvas') as {
    createCanvas(width: number, height: number): {
      getContext(type: '2d'): { drawImage(image: unknown, x: number, y: number): void }
      toBuffer(mime: string, quality?: number): Buffer
    }
    loadImage(input: Buffer): Promise<{ width: number; height: number }>
  }
  const image = await loadImage(Buffer.from(png))
  const canvas = createCanvas(image.width, image.height)
  canvas.getContext('2d').drawImage(image, 0, 0)
  return new Uint8Array(canvas.toBuffer('image/jpeg', quality))
}
