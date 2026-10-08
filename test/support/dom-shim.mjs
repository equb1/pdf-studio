/**
 * Minimal DOM shims for pdfjs-dist in a plain Node process.
 *
 * `pdfjs-dist`'s legacy build constructs a `DOMMatrix` at module scope, so
 * importing it in Node throws `ReferenceError: DOMMatrix is not defined` unless
 * a canvas implementation is installed — and on macOS the `@napi-rs/canvas`
 * native binding is refused by the dynamic loader when the Node binary and the
 * prebuilt binary are signed by different teams:
 *
 *   dlopen(...skia.darwin-arm64.node...): code signature ... not valid for use in
 *   process: mapping process and mapped file (non-platform) have different Team IDs
 *
 * Text extraction and content-stream analysis do not need a real rasteriser, only
 * a `DOMMatrix` that exists and can be multiplied/translated. This module supplies
 * exactly that, and is imported (via `--import`) by the suites that read text or
 * structure. Suites that RENDER still need real canvas and skip explicitly.
 *
 * Load with:  node --import ./test/support/dom-shim.mjs test/<suite>.test.mjs
 */

class DOMMatrixShim {
  constructor(init) {
    const values = Array.isArray(init) || ArrayBuffer.isView(init) ? [...init] : []
    this.a = values[0] ?? 1
    this.b = values[1] ?? 0
    this.c = values[2] ?? 0
    this.d = values[3] ?? 1
    this.e = values[4] ?? 0
    this.f = values[5] ?? 0
    this.m11 = this.a
    this.m12 = this.b
    this.m21 = this.c
    this.m22 = this.d
    this.m41 = this.e
    this.m42 = this.f
  }

  // pdfjs only chains these for viewport maths; identity-preserving stubs are
  // enough for text extraction, and a wrong transform there is still visible in
  // the extracted coordinates rather than silently corrupting the file.
  multiplySelf() { return this }
  preMultiplySelf() { return this }
  translateSelf() { return this }
  scaleSelf() { return this }
  rotateSelf() { return this }
  skewXSelf() { return this }
  skewYSelf() { return this }
  invertSelf() { return this }
  static fromMatrix() { return new DOMMatrixShim() }
  static fromFloat32Array(values) { return new DOMMatrixShim(values) }
  static fromFloat64Array(values) { return new DOMMatrixShim(values) }
}

class Path2DShim {
  addPath() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
  rect() {}
  arc() {}
}

class ImageDataShim {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.data = new Uint8ClampedArray(Math.max(0, width * height * 4))
  }
}

const target = globalThis
target.DOMMatrix ??= DOMMatrixShim
target.Path2D ??= Path2DShim
target.ImageData ??= ImageDataShim
