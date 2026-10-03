/**
 * The single coordinate authority for the whole pipeline.
 *
 * Two spaces meet here and nowhere else:
 *
 *   raster / device : pixels, origin TOP-LEFT, y grows DOWN. Produced by
 *                     RENDERING a page (a `@napi-rs/canvas` bitmap), and the
 *                     space tesseract reports `bbox` in.
 *   PDF page space  : points, origin BOTTOM-LEFT, y grows UP. What `pdf-lib`
 *                     draws in, what every contract type uses — and, verified
 *                     empirically, what pdf.js already reports text items in.
 *
 * ## pdf.js text transforms are ALREADY PDF space — do not flip them
 *
 * This looks wrong and is worth stating loudly, because the natural assumption
 * ("the transform must be device coordinates, like everything else visual") is
 * false and produces a subtly broken overlay rather than an obvious failure.
 *
 * Measured on pdfjs-dist 6.2.108 with a real 13-item page: reading a text
 * item's `transform[4]/[5]` as PDF space lands on ink for 397 sampled pixels;
 * reading it as device space (i.e. applying the flip below) lands on 0.
 * The worker composes `ctm × textMatrix` with no viewport flip, so `(e, f)` is
 * the baseline in user space already.
 *
 * So: `deviceToPdf` / `deviceRectToPdf` are for RASTER boxes only — tesseract
 * output, and coordinates you took off a rendered bitmap. Text items from
 * `getTextContent()` go straight into a `TextLine` untouched.
 *
 * Everything else is a scale divide plus a y flip. Keeping it in one module is
 * what stops the render path and the overlay path from disagreeing by a few
 * points — a failure that presents as "the text is slightly off" and is
 * miserable to debug.
 *
 * @module dsh-pdf-studio/core/coords
 */

import type { PdfRect, PixelRect } from './contracts.ts'

/** Clamp a value into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Map one point from raster/device space to PDF space.
 *
 * For rendered-bitmap coordinates and tesseract boxes. NEVER apply this to a
 * pdf.js text item's transform — see the module header.
 *
 * @param x - device x, pixels from the left edge.
 * @param y - device y, pixels from the TOP edge.
 * @param pageHeightPt - page height in PDF points.
 * @param scale - the scale the device image was rendered at (default 1).
 */
export function deviceToPdf(
  x: number,
  y: number,
  pageHeightPt: number,
  scale = 1,
): { x: number; y: number } {
  const s = scale === 0 ? 1 : scale
  return { x: x / s, y: pageHeightPt - y / s }
}

/**
 * Map a device-space box (top-left origin, as tesseract reports) to a PDF
 * rect (bottom-left origin).
 *
 * The device `y0` is the TOP edge, which becomes the PDF rect's UPPER bound;
 * the returned `y` is therefore the rect's bottom. Getting this backwards is
 * the classic bug, so the mapping is stated explicitly rather than inferred.
 */
export function deviceRectToPdf(bbox: PixelRect, scale: number, pageHeightPt: number): PdfRect {
  const s = scale === 0 ? 1 : scale
  const x = Math.min(bbox.x0, bbox.x1) / s
  const topDevice = Math.min(bbox.y0, bbox.y1)
  const bottomDevice = Math.max(bbox.y0, bbox.y1)
  const width = Math.abs(bbox.x1 - bbox.x0) / s
  const height = (bottomDevice - topDevice) / s
  // The device BOTTOM edge is the PDF rect's bottom.
  const y = pageHeightPt - bottomDevice / s
  return { x, y, width, height }
}

/** Union of two rects in PDF space; `undefined` acts as the identity. */
export function unionRect(a: PdfRect | undefined, b: PdfRect): PdfRect {
  if (a === undefined) return { ...b }
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const top = Math.max(a.y + a.height, b.y + b.height)
  return { x, y, width: right - x, height: top - y }
}

/** Union of many rects; `undefined` when the list is empty. */
export function unionRects(rects: readonly PdfRect[]): PdfRect | undefined {
  let out: PdfRect | undefined
  for (const rect of rects) out = unionRect(out, rect)
  return out
}

/** Whether two rects overlap (touching edges count). */
export function rectsIntersect(a: PdfRect, b: PdfRect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width
    && a.y <= b.y + b.height && b.y <= a.y + a.height
}

/** Area of a rect, guarding negative extents. */
export function rectArea(rect: PdfRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height)
}

/**
 * Intersect a rect with the page box and return the clamped rect, or
 * `undefined` when nothing remains. Used to reject nonsense boxes from OCR
 * instead of writing text outside the page.
 */
export function clampRectToPage(rect: PdfRect, pageWidth: number, pageHeight: number): PdfRect | undefined {
  const x = Math.max(0, rect.x)
  const y = Math.max(0, rect.y)
  const right = Math.min(pageWidth, rect.x + rect.width)
  const top = Math.min(pageHeight, rect.y + rect.height)
  if (right <= x || top <= y) return undefined
  return { x, y, width: right - x, height: top - y }
}
