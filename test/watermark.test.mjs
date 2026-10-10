/**
 * Watermark suite.
 *
 * The suite has two kinds of assertion, reported separately:
 *
 *   - **regression checks** (`ok` / `FAIL`) — behaviour that already works and
 *     must keep working: adding, scanning, removing, and the refusal paths. A
 *     failure here is a real regression and makes the process exit non-zero.
 *   - **defect specifications** (`ok [Dn]` / `DEFECT [Dn]`) — one group per entry
 *     of the confirmed defect list (plus `D9` for the newer `/Artifact` contract).
 *     Each states, in the strictest honest form, what the fix must produce.
 *     A failure prints the defect id, the observation and the expected behaviour.
 *
 * Exit code
 * ---------
 * Unmet defect specifications are printed loudly and counted, but on their own
 * do not make the run fail, so `npm run test:watermark` stays usable while a fix
 * is in flight. Set `WATERMARK_STRICT=1` to make them fail the run as well — that
 * is what a post-fix CI run should use. A failed regression check, or a failure
 * to load the module under test, always exits `1`. Nothing is ever reported as a
 * pass unless its assertion actually held.
 *
 * Rendering
 * ---------
 * Pixel assertions need `@napi-rs/canvas`. On installs where the optional native
 * binding is missing, pdfjs's legacy build cannot polyfill `DOMMatrix` and
 * rendering throws; those checks then print `SKIP` with the reason and are
 * counted as skipped, never as passed. `PDF_STUDIO_FORCE_NO_CANVAS=1` forces that
 * path, which is how the skip behaviour itself is verified. Text-layer and
 * structural assertions need pdfjs but not the native binding, so they still run.
 *
 * Fixtures
 * --------
 * Every input is generated locally with pdf-lib by
 * `test/fixtures/make-fixtures.mjs` (`node test/fixtures/make-fixtures.mjs` to
 * write them by hand). Nothing is downloaded and no developer-machine path is
 * hard-coded.
 *
 * Run:
 *   node --experimental-strip-types test/watermark.test.mjs
 *   WATERMARK_STRICT=1 node --experimental-strip-types test/watermark.test.mjs
 *   PDF_STUDIO_FORCE_NO_CANVAS=1 node --experimental-strip-types test/watermark.test.mjs
 *   PDF_STUDIO_SRC_ROOT=/path/to/other/checkout/src node --experimental-strip-types test/watermark.test.mjs
 */

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} = require('pdf-lib')

// `test/fixtures/make-fixtures.mjs` is a source, not a cache: the generated
// `*.pdf`/`*.png` next to it are gitignored and rebuilt on every run, but the
// script itself must exist. A `git clean -fdx test/fixtures` removes it too
// (it is untracked until committed), so say that plainly instead of dumping an
// ERR_MODULE_NOT_FOUND stack.
let fixturesModule = null
let fixtureLoadError = null
try {
  fixturesModule = await import('./fixtures/make-fixtures.mjs')
} catch (error) {
  fixtureLoadError = error
}

const STRICT = process.env.WATERMARK_STRICT === '1'
const MARKER_TEXT = '内部资料'
const TILE_TEXT = '内部资料 请勿外传'
const TILE_TEXT_FLAT = TILE_TEXT.replace(/\s+/g, '')
const COMPLETE_WORDS = new Set(['内部资料', '请勿外传'])
const OUT_DIR = join(tmpdir(), 'dsh-pdf-studio-watermark')

/* -------------------------------------------------------------------------- */
/* the module under test                                                      */
/* -------------------------------------------------------------------------- */

// The source root is overridable only so the pre-fix and post-fix behaviour can
// be compared from one checkout without editing `src/`. Normal runs use `../src`.
const SRC_ROOT = process.env.PDF_STUDIO_SRC_ROOT !== undefined && process.env.PDF_STUDIO_SRC_ROOT !== ''
  ? pathToFileURL(process.env.PDF_STUDIO_SRC_ROOT.replace(/\/*$/, '') + '/').href
  : new URL('../src/', import.meta.url).href

let watermark = null
let contentStream = null
let fonts = null
let loadError = null
try {
  watermark = await import(new URL('core/watermark.ts', SRC_ROOT).href)
  contentStream = await import(new URL('core/content-stream.ts', SRC_ROOT).href)
  fonts = await import(new URL('core/fonts.ts', SRC_ROOT).href)
} catch (error) {
  loadError = error
}

// `qpdf --check` is the one structural verdict that is not our own code judging
// our own output. Optional so a checkout without the wasm dependency skips those
// assertions instead of failing to load the suite.
let runQpdf = null
let qpdfReason = ''
try {
  ({ runQpdf } = await import('../src/core/qpdf.ts'))
} catch (error) {
  qpdfReason = `无法加载 src/core/qpdf.ts：${error.message}`
}

/* -------------------------------------------------------------------------- */
/* reporting                                                                  */
/* -------------------------------------------------------------------------- */

let passed = 0
let failed = 0
let skipped = 0
const openDefects = []
const fixedDefects = new Set()
const skipReasons = new Set()

const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (ok) passed += 1
  else failed += 1
  return ok
}

/** A defect specification; `expectation` is printed on failure. */
const spec = (id, name, ok, detail, expectation) => {
  if (ok) {
    fixedDefects.add(id)
    passed += 1
    console.log(`  ok  [${id}] ${name}${detail === undefined ? '' : ' — ' + detail}`)
    return true
  }
  openDefects.push({ id, name, detail, expectation })
  console.log(`DEFECT [${id}] ${name}${detail === undefined ? '' : ' — ' + detail}`)
  return false
}

const skip = (name, reason) => {
  skipReasons.add(reason)
  skipped += 1
  console.log(`SKIP  ${name} — ${reason}`)
}

/* -------------------------------------------------------------------------- */
/* pdfjs + canvas availability                                                */
/* -------------------------------------------------------------------------- */

let pdfjs = null
let pdfjsReason = ''
try {
  const entry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs = await import(pathToFileURL(entry).href)
} catch (error) {
  pdfjsReason = `无法加载 pdfjs-dist legacy 构建：${error.message}`
}

let standardFontDataUrl
try {
  const entry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
  const candidate = join(dirname(entry), '..', '..', 'standard_fonts') + '/'
  if (existsSync(candidate)) standardFontDataUrl = candidate
} catch {
  // Optional: only silences a pdfjs warning about base-14 fonts.
}

let canvas = { ok: false, reason: '' }
if (process.env.PDF_STUDIO_FORCE_NO_CANVAS === '1') {
  canvas = { ok: false, reason: 'PDF_STUDIO_FORCE_NO_CANVAS=1（强制模拟缺少原生 canvas 的环境）' }
} else {
  try {
    const mod = require('@napi-rs/canvas')
    if (typeof mod.createCanvas !== 'function') {
      canvas = { ok: false, reason: '@napi-rs/canvas 已安装但未导出 createCanvas' }
    } else {
      // Touching the canvas forces the native binding to load: on an install
      // where the optional platform package is missing, `require` can still
      // succeed and only this call throws.
      const probe = mod.createCanvas(2, 2)
      probe.getContext('2d').fillRect(0, 0, 1, 1)
      canvas = { ok: true, createCanvas: mod.createCanvas }
    }
  } catch (error) {
    canvas = { ok: false, reason: `@napi-rs/canvas 原生绑定不可用：${error.message}` }
  }
}

const domMatrixReady = typeof globalThis.DOMMatrix === 'function'
// Text extraction needs pdfjs but not a rasteriser. pdfjs's legacy build
// dereferences `DOMMatrix` at module scope, so on a machine without the native
// canvas binding the *import itself* throws and every text-layer assertion has
// to skip rather than crash.
const TEXT_OK = pdfjs !== null
const TEXT_REASON = pdfjsReason
const RENDER_OK = pdfjs !== null && canvas.ok && domMatrixReady
const RENDER_REASON = pdfjs === null
  ? pdfjsReason
  : !canvas.ok
    ? canvas.reason
    : !domMatrixReady
      ? 'pdfjs legacy 构建未能 polyfill DOMMatrix；渲染会抛 ReferenceError'
      : ''

console.log('watermarks — spec suite\n')
console.log(`  source under test : ${SRC_ROOT}`)
console.log(`  text extraction   : ${TEXT_OK ? 'available' : 'UNAVAILABLE — ' + TEXT_REASON}`)
console.log(`  rendering         : ${RENDER_OK ? 'available' : 'UNAVAILABLE — ' + RENDER_REASON}`)
console.log(`  strict mode       : ${STRICT ? 'on (unmet defect specs fail the run)' : 'off (unmet defect specs are reported, but do not fail the run)'}\n`)

if (loadError !== null) {
  console.error('FATAL  无法加载 src/core/watermark.ts —— 测试无法进行。')
  console.error(`       ${loadError.name}: ${loadError.message}`)
  console.error('       （若同事正在编辑该文件，请等写入完成后再跑。）')
  process.exit(1)
}

const { addWatermark, removeWatermarks, scanWatermarks, WATERMARK_MARKER } = watermark
const splitDrawableText = typeof watermark.splitDrawableText === 'function' ? watermark.splitDrawableText : null

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

if (fixturesModule === null) {
  console.error('FATAL  test/fixtures/make-fixtures.mjs 不存在，无法生成夹具。')
  console.error(`       ${fixtureLoadError?.message ?? 'unknown error'}`)
  console.error('       该脚本是源码而非缓存（生成的 *.pdf/*.png 才是缓存）；')
  console.error('       它被 git clean 删掉过，请恢复并提交：git add test/fixtures/make-fixtures.mjs')
  process.exit(1)
}
const { ensureFixtures, watermarkImage, fixturePath } = fixturesModule

const FIXTURES = await ensureFixtures()
const sameSize = FIXTURES['same-size.pdf']
const cropBox = FIXTURES['cropbox.pdf']
const inheritedResources = FIXTURES['inherited-resources.pdf']
const noResources = FIXTURES['no-resources.pdf']
const resourcesMissing = FIXTURES['resources-missing.pdf']
const resourcesNoXObject = FIXTURES['resources-no-xobject.pdf']
const bulky = FIXTURES['bulky.pdf']
const adobeFixture = FIXTURES['adobe-watermark.pdf']
const artifactIndirectFixture = FIXTURES['artifact-indirect.pdf']
const imageBytes = FIXTURES['watermark-image.png'] ?? watermarkImage()

console.log(`  fixtures          : ${Object.keys(FIXTURES).length} files generated by pdf-lib (no downloads)\n`)

/* -------------------------------------------------------------------------- */
/* helpers: pdf-lib inspection                                                */
/* -------------------------------------------------------------------------- */

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function loadDoc(bytes) {
  return PDFDocument.load(bytes, { updateMetadata: false })
}

function decodeStream(obj) {
  try {
    return Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1')
  } catch {
    return null
  }
}

/** Every decoded content stream of one page, concatenated. */
function pageContentText(doc, pageIndex) {
  const page = doc.getPages()[pageIndex]
  if (page === undefined) return ''
  const raw = page.node.Contents()
  const entries = []
  if (raw instanceof PDFArray) {
    for (let i = 0; i < raw.size(); i += 1) entries.push(raw.get(i))
  } else if (raw !== undefined) {
    entries.push(raw)
  }
  let text = ''
  for (const entry of entries) {
    const obj = doc.context.lookup(entry)
    const decoded = obj instanceof PDFStream ? decodeStream(obj) : null
    if (decoded !== null) text += decoded
  }
  return text
}

/**
 * The watermark Form XObject(s) referenced by a page's own resources, matched by
 * resource name or by the `/Name` marker so the check does not depend on the
 * resource keeping one exact name.
 */
function markBodiesForPage(doc, pageIndex) {
  const page = doc.getPages()[pageIndex]
  const found = []
  if (page === undefined) return found
  const resources = page.node.Resources()
  if (resources === undefined) return found
  const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict)
  if (xobjects === undefined) return found
  for (const key of xobjects.keys()) {
    const name = key.toString().replace(/^\//, '')
    const obj = doc.context.lookup(xobjects.get(key))
    if (!(obj instanceof PDFStream)) continue
    const declared = obj.dict.get(PDFName.of('Name'))
    const declaredText = declared === undefined ? '' : declared.toString()
    if (!name.includes(WATERMARK_MARKER) && !declaredText.includes(WATERMARK_MARKER)) continue
    found.push({ name, obj, dict: obj.dict, body: decodeStream(obj) })
  }
  return found
}

function parseBody(body) {
  if (body === null) return null
  try {
    return contentStream.parseOperations(contentStream.tokenize(body))
  } catch {
    return null
  }
}

/**
 * The mark's placement translations, in page coordinates.
 *
 * Every placement is the first `cm` inside a `q` block — the tile grid and the
 * single centre/corner marks all follow that shape.
 */
function placementAnchors(body) {
  const operations = parseBody(body)
  if (operations === null) return []
  const anchors = []
  const frames = []
  for (const op of operations) {
    if (op.op === 'q') {
      frames.push({ closed: false })
      continue
    }
    if (op.op === 'Q') {
      frames.pop()
      continue
    }
    const frame = frames[frames.length - 1]
    if (frame === undefined || frame.closed) continue
    if (op.op === 'cm') {
      const values = op.operands.filter(token => token.kind === 'number').map(token => Number(token.raw))
      if (values.length >= 6 && values[0] === 1 && values[1] === 0 && values[2] === 0 && values[3] === 1) {
        anchors.push({ x: values[4], y: values[5] })
      }
    }
    frame.closed = true
  }
  return anchors
}

/**
 * The rotated bounding box of every placed mark.
 *
 * A placement is `q 1 0 0 1 tx ty cm [1 0 0 1 w/2 h/2 cm cos sin -sin cos 0 0 cm
 * 1 0 0 1 -w/2 -h/2 cm] /Mark Do Q`, so the frame's matrices give the mark's own
 * size and rotation directly — no assumption about the font metrics is needed.
 */
function placedMarkBoxes(body) {
  const operations = parseBody(body)
  if (operations === null) return []
  const frames = []
  const boxes = []
  const finish = matrices => {
    if (matrices.length < 2) return
    const [anchor, pivot] = matrices
    if (anchor[0] !== 1 || anchor[1] !== 0 || anchor[2] !== 0 || anchor[3] !== 1) return
    if (pivot[0] !== 1 || pivot[1] !== 0 || pivot[2] !== 0 || pivot[3] !== 1) return
    const width = 2 * pivot[4]
    const height = 2 * pivot[5]
    const rotation = matrices.length >= 3 ? Math.atan2(matrices[2][1], matrices[2][0]) : 0
    const centreX = anchor[4] + width / 2
    const centreY = anchor[5] + height / 2
    const absCos = Math.abs(Math.cos(rotation))
    const absSin = Math.abs(Math.sin(rotation))
    const boxWidth = width * absCos + height * absSin
    const boxHeight = width * absSin + height * absCos
    boxes.push({
      x0: centreX - boxWidth / 2,
      y0: centreY - boxHeight / 2,
      x1: centreX + boxWidth / 2,
      y1: centreY + boxHeight / 2,
      width,
      height,
      rotationDegrees: (rotation * 180) / Math.PI,
    })
  }
  for (const op of operations) {
    if (op.op === 'q') {
      frames.push([])
      continue
    }
    if (op.op === 'Q') {
      finish(frames.pop() ?? [])
      continue
    }
    const frame = frames[frames.length - 1]
    if (frame === undefined || op.op !== 'cm') continue
    const values = op.operands.filter(token => token.kind === 'number').map(token => Number(token.raw))
    if (values.length >= 6) frame.push(values)
  }
  return boxes
}

/** Every `Do` resource name invoked by a content stream body. */
function invokedNames(body) {
  const operations = parseBody(body)
  if (operations === null) return []
  const names = []
  for (const op of operations) {
    if (op.op !== 'Do') continue
    const token = op.operands.find(candidate => candidate.kind === 'name')
    if (token !== undefined) names.push(token.raw.replace(/^\//, ''))
  }
  return names
}

/** Every `Do` resource name invoked anywhere in the mark's XObject graph. */
function collectMarkBodies(mark) {
  const bodies = [mark.body]
  const visited = new Set()
  const visit = (body, resources) => {
    const xobjects = resources === undefined || resources === null
      ? undefined
      : resources.lookupMaybe(PDFName.of('XObject'), PDFDict)
    if (xobjects === undefined) return
    for (const name of invokedNames(body)) {
      const entry = xobjects.get(PDFName.of(name))
      if (entry === undefined) continue
      const obj = mark.dict.context.lookup(entry)
      if (!(obj instanceof PDFStream)) continue
      const key = entry.toString()
      if (visited.has(key)) continue
      visited.add(key)
      const subtype = obj.dict.get(PDFName.of('Subtype'))
      if (subtype !== undefined && subtype.toString() === '/Form') {
        const inner = decodeStream(obj)
        bodies.push(inner)
        visit(inner, obj.dict.get(PDFName.of('Resources')))
      }
    }
  }
  visit(mark.body, mark.dict.get(PDFName.of('Resources')))
  return bodies
}

/**
 * Walk the mark's `Do` graph: how many image XObjects are reachable, and which
 * invoked names resolve to nothing (the "reports success but paints nothing"
 * shape).
 */
function inspectMarkGraph(mark) {
  const images = []
  const missing = []
  const visited = new Set()
  const visit = (body, resources) => {
    const xobjects = resources === undefined || resources === null
      ? undefined
      : resources.lookupMaybe(PDFName.of('XObject'), PDFDict)
    for (const name of invokedNames(body)) {
      const entry = xobjects === undefined ? undefined : xobjects.get(PDFName.of(name))
      if (entry === undefined) {
        missing.push(name)
        continue
      }
      const obj = mark.dict.context.lookup(entry)
      if (!(obj instanceof PDFStream)) {
        missing.push(name)
        continue
      }
      const key = entry.toString()
      if (visited.has(key)) continue
      visited.add(key)
      const subtype = obj.dict.get(PDFName.of('Subtype'))
      const subtypeText = subtype === undefined ? '' : subtype.toString()
      if (subtypeText === '/Image') {
        images.push({
          name,
          width: streamDimension(obj, 'Width'),
          height: streamDimension(obj, 'Height'),
        })
        continue
      }
      if (subtypeText === '/Form') visit(decodeStream(obj), obj.dict.get(PDFName.of('Resources')))
    }
  }
  visit(mark.body, mark.dict.get(PDFName.of('Resources')))
  return { images, missing }
}

function streamDimension(stream, key) {
  const value = stream.dict.get(PDFName.of(key))
  return value === undefined ? undefined : Number(value.toString())
}

/** Whether a mark body draws anything at all. */
function bodyPaintsSomething(body) {
  return body !== null && /(Tj|TJ|\bm\b|\bl\b|\bc\b|\bre\b|\bf\b)/.test(body)
}

/* -------------------------------------------------------------------------- */
/* helpers: object-graph hygiene (duplication / orphan detection)             */
/* -------------------------------------------------------------------------- */

/**
 * Objects reachable from the trailer versus objects merely present in the file.
 * An unreachable stream is a duplicated copy: the same content stored twice.
 */
function orphanReport(doc) {
  const context = doc.context
  const seen = new Set()
  const stack = []
  const push = value => {
    if (value instanceof PDFRef) {
      const key = value.toString()
      if (!seen.has(key)) {
        seen.add(key)
        stack.push(value)
      }
    }
  }
  const walk = value => {
    if (value instanceof PDFRef) {
      push(value)
      return
    }
    if (value instanceof PDFDict) {
      for (const [, entry] of value.entries()) walk(entry)
      return
    }
    if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i += 1) walk(value.get(i))
      return
    }
    if (value instanceof PDFStream) walk(value.dict)
  }
  for (const key of Object.keys(context.trailerInfo)) push(context.trailerInfo[key])
  while (stack.length > 0) walk(context.lookup(stack.pop()))

  let orphans = 0
  let orphanStreams = 0
  let orphanStreamBytes = 0
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (seen.has(ref.toString())) continue
    orphans += 1
    if (obj instanceof PDFStream) {
      orphanStreams += 1
      try {
        orphanStreamBytes += obj.getContents().length
      } catch {
        // A stream that cannot be read still counts as an orphan.
      }
    }
  }
  return { orphans, orphanStreams, orphanStreamBytes }
}

/** Page `/Contents` entries that hold a stream object directly instead of a ref. */
function inlineContentStreams(doc) {
  const inline = []
  for (const [index, page] of doc.getPages().entries()) {
    const raw = page.node.get(PDFName.of('Contents'))
    if (raw === undefined) continue
    const entries = raw instanceof PDFArray
      ? Array.from({ length: raw.size() }, (_, i) => raw.get(i))
      : [raw]
    for (const entry of entries) if (entry instanceof PDFStream) inline.push(index + 1)
  }
  return inline
}

function totalPageContentBytes(doc) {
  let total = 0
  for (const [index] of doc.getPages().entries()) total += pageContentText(doc, index).length
  return total
}

/* -------------------------------------------------------------------------- */
/* helpers: rendering and text extraction                                     */
/* -------------------------------------------------------------------------- */

async function openPdf(bytes) {
  if (pdfjs === null) throw new Error(pdfjsReason)
  return pdfjs.getDocument({
    data: new Uint8Array(bytes),
    ...(standardFontDataUrl === undefined ? {} : { standardFontDataUrl }),
  }).promise
}

/** Extract the text layer of one page, as a search or copy would see it. */
async function extractItems(bytes, pageNumber = 1) {
  const doc = await openPdf(bytes)
  const page = await doc.getPage(pageNumber)
  const content = await page.getTextContent()
  return content.items.filter(item => typeof item.str === 'string').map(item => item.str)
}

/** Render one page and return its pixels plus the viewport used. */
async function renderPage(bytes, pageNumber = 1, scale = 2) {
  if (!RENDER_OK) throw new Error(RENDER_REASON)
  pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  const doc = await openPdf(bytes)
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale })
  const target = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const context = target.getContext('2d')
  context.fillStyle = 'white'
  context.fillRect(0, 0, target.width, target.height)
  await page.render({ canvasContext: context, viewport }).promise
  return { image: context.getImageData(0, 0, target.width, target.height), viewport }
}

/** Mark-coloured ink: red-dominant pixels. Page content in the fixtures is grey. */
const isMarkInk = (data, index) => data[index] > data[index + 1] + 12 && data[index] > data[index + 2] + 12

function markInkStats(image) {
  const { data, width, height } = image
  let count = 0
  let sumX = 0
  let sumY = 0
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      if (!isMarkInk(data, index)) continue
      count += 1
      sumX += x
      sumY += y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return {
    count,
    width,
    height,
    centroidX: count === 0 ? 0 : sumX / count,
    centroidY: count === 0 ? 0 : sumY / count,
    minX,
    minY,
    maxX,
    maxY,
  }
}

/** Mark ink inside a `band`-pixel frame around the page edge. */
function markInkOnBorder(image, band) {
  const { data, width, height } = image
  let count = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= band && x < width - band && y >= band && y < height - band) continue
      if (isMarkInk(data, (y * width + x) * 4)) count += 1
    }
  }
  return count
}

function diffCount(a, b, tolerance = 24) {
  let changed = 0
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    )
    if (delta > tolerance) changed += 1
  }
  return changed
}

/** Extract text from the mark only: the watermark's own text layer contribution. */
async function watermarkTextItems(bytes, pageNumber = 1) {
  const items = await extractItems(bytes, pageNumber)
  return items.filter(item => TILE_TEXT_FLAT.includes(item.replace(/\s+/g, '')) && item.replace(/\s+/g, '').length > 0)
}

/* -------------------------------------------------------------------------- */
/* section 1 — regression: add / scan / remove keep working                    */
/* -------------------------------------------------------------------------- */

console.log('regression — add / scan / remove\n')

const originalHash = sha256(sameSize)

{
  const scan = await scanWatermarks(sameSize)
  check('a clean document yields no watermark candidates', scan.candidates.length === 0,
    JSON.stringify(scan.candidates.map(candidate => candidate.detail)))
  check('scanning reports the page count', scan.pages === 3, String(scan.pages))
}

const added = await addWatermark(sameSize, {
  text: TILE_TEXT,
  placement: 'tile',
  opacity: 0.18,
  fontSize: 44,
})

check('adding succeeded and returned bytes', added.bytes.length > 0, `${(added.bytes.length / 1024).toFixed(0)}KB`)
check('the add reports which pages were stamped', added.result.pages === 3, String(added.result.pages))
check('the add records the XObject identity for later matching',
  added.result.xobjectName === WATERMARK_MARKER, String(added.result.xobjectName))
check('the source bytes were not modified', sha256(sameSize) === originalHash)
check('the default render mode is reported as text',
  added.result.render === 'text', String(added.result.render))
check('the invocation is reported as an /Artifact by default',
  added.result.artifact === true, String(added.result.artifact))

{
  const scan = await scanWatermarks(added.bytes)
  const named = scan.candidates.find(candidate => candidate.reason === 'named-xobject')
  check('the scan finds the added watermark', scan.candidates.length >= 1, `${scan.candidates.length} candidate(s)`)
  check('it is identified by the recorded XObject name', named !== undefined, JSON.stringify(scan.candidates[0]))
  check('a named watermark is reported with full confidence', named?.confidence === 1, String(named?.confidence))
  check('the candidate names the XObject to remove', named?.xobjectName === WATERMARK_MARKER, String(named?.xobjectName))
}

await mkdir(OUT_DIR, { recursive: true })
await writeFile(join(OUT_DIR, 'watermarked.pdf'), added.bytes)

{
  const dry = await removeWatermarks(added.bytes, { dryRun: true })
  check('a dry run reports what it WOULD remove', dry.removed.length >= 1, `${dry.removed.length}`)
  check('a dry run does not change the bytes', sha256(dry.bytes) === sha256(added.bytes))

  const applied = await removeWatermarks(added.bytes, { minConfidence: 0.9, dryRun: false })
  check('removal reports the marks it removed', applied.removed.length >= 1, `${applied.removed.length}`)
  await writeFile(join(OUT_DIR, 'cleaned.pdf'), applied.bytes)

  const scanAfter = await scanWatermarks(applied.bytes)
  check('the watermark is gone from a re-scan', scanAfter.candidates.length === 0,
    JSON.stringify(scanAfter.candidates.map(candidate => candidate.reason)))

  const doc = await loadDoc(applied.bytes)
  const leftoverContent = pageContentText(doc, 0)
  check('removal also removes the /Artifact wrapper it added',
    !leftoverContent.includes('/Artifact') && !leftoverContent.includes(`/${WATERMARK_MARKER} Do`),
    JSON.stringify(leftoverContent.slice(0, 80)))

  if (TEXT_OK) {
    const items = await extractItems(applied.bytes, 1)
    const text = items.join('')
    check('the page body text survives watermark removal', text.replace(/\s+/g, '').includes('ServiceAgreement'),
      JSON.stringify(text.slice(0, 40)))
    check('removal did not add the watermark text to the extractable layer',
      !text.replace(/\s+/g, '').includes(MARKER_TEXT), 'watermark text leaked into the text layer')
  } else {
    skip('the page body text survives watermark removal', TEXT_REASON)
    skip('removal did not add the watermark text to the extractable layer', TEXT_REASON)
  }

  if (RENDER_OK) {
    const before = await renderPage(sameSize, 1)
    const cleaned = await renderPage(applied.bytes, 1)
    const residual = diffCount(before.image, cleaned.image)
    check('the cleaned page matches the original render', residual < 500, `${residual} pixels still differ`)
  } else {
    skip('the cleaned page matches the original render', RENDER_REASON)
  }
}

{
  const centred = await addWatermark(sameSize, {
    text: 'CONFIDENTIAL',
    placement: 'center',
    rotation: 0,
    opacity: 0.25,
    fontSize: 60,
  })
  check('a centred mark is produced', centred.bytes.length > 0)
  const scanCentred = await scanWatermarks(centred.bytes)
  check('a centred mark is still identified by name',
    scanCentred.candidates.some(candidate => candidate.reason === 'named-xobject'),
    JSON.stringify(scanCentred.candidates.map(candidate => candidate.reason)))
}

{
  const scan = await scanWatermarks(sameSize)
  check('a document with no removable mark produces a refusal explanation',
    scan.candidates.length === 0 && scan.refused.length >= 1,
    JSON.stringify(scan.refused))

  const defaultRun = await removeWatermarks(sameSize, { dryRun: false })
  check('the default threshold removes nothing from a clean document',
    defaultRun.removed.length === 0 && sha256(defaultRun.bytes) === sha256(sameSize))
}

/* -------------------------------------------------------------------------- */
/* section 2 — defect specifications                                          */
/* -------------------------------------------------------------------------- */

console.log('\ndefect specifications — expected behaviour after the fix\n')

/* ── D1: the mark must not be readable from the text layer ────────────────── */

if (!TEXT_OK) {
  skip('D1 水印文字不出现在页面文字层（默认模式，或提供并验证非提取模式）', TEXT_REASON)
} else {
  const MARK_SPEC = {
    text: TILE_TEXT,
    placement: 'tile',
    opacity: 0.18,
    fontSize: 44,
    pages: [1],
  }
  // The non-extractable mode is the documented escape hatch when the default
  // (`render: 'text'`) keeps the mark in the text layer. Options are tried in
  // order; the first that yields a clean text layer and still paints wins.
  const NON_EXTRACTABLE_OPTIONS = [
    { render: 'outline' },
    { mode: 'outline' },
    { extractable: false },
    { textLayer: false },
    { asPath: true },
    { vector: true },
  ]

  let defaultLeak = false
  let defaultItems = []
  let defaultNote = ''
  try {
    const result = await addWatermark(sameSize, MARK_SPEC)
    defaultItems = await extractItems(result.bytes, 1)
    defaultLeak = defaultItems.join('').replace(/\s+/g, '').includes(MARKER_TEXT)
  } catch (error) {
    defaultNote = `默认模式抛错 ${error.name}: ${error.message}`
  }

  let verifiedOption = null
  let optionDetail = ''
  const tried = []
  if (defaultLeak) {
    for (const option of NON_EXTRACTABLE_OPTIONS) {
      if (verifiedOption !== null) break
      const label = JSON.stringify(option)
      try {
        const result = await addWatermark(sameSize, { ...MARK_SPEC, ...option })
        const items = await extractItems(result.bytes, 1)
        const leaked = items.join('').replace(/\s+/g, '').includes(MARKER_TEXT)
        const doc = await loadDoc(result.bytes)
        const mark = markBodiesForPage(doc, 0)[0]
        const painted = mark !== undefined && collectMarkBodies(mark).some(bodyPaintsSomething)
        tried.push(`${label}:${leaked ? '仍可提取' : '不可提取'}/${painted ? '有绘制' : '空白'}`)
        if (!leaked && painted) verifiedOption = label
      } catch (error) {
        tried.push(`${label}:抛错 ${error.name}`)
      }
    }
    optionDetail = tried.length === 0 ? '（未尝试任何选项）' : `；已尝试 ${tried.join('，')}`
  }

  const ok = !defaultLeak || verifiedOption !== null
  const detail = defaultLeak
    ? `默认（render: text）文字层含 “${MARKER_TEXT}”，命中项 ${JSON.stringify(watermarkItemsOf(defaultItems))}`
      + (verifiedOption === null
        ? `；没有可用的非提取模式${optionDetail}`
        : `；${verifiedOption} 提供了可验证的非提取模式（文字层干净且确实有绘制）`)
    : `默认模式文字层已不含水印文字${defaultNote === '' ? '' : `（${defaultNote}）`}`
  spec('D1', '水印文字不出现在页面文字层（默认模式，或提供并验证非提取模式）',
    ok, detail,
    '默认 addWatermark 的产物用文本提取读不到 “内部资料”；或者存在一个非提取模式（如 render: "outline"）'
    + '且验证它确实把水印画了出来、又不进入文字层。旧实现把完整水印文字（及其被裁断的片段）写进了文字层。')
}

function watermarkItemsOf(items) {
  return items.filter(item => TILE_TEXT_FLAT.includes(item.replace(/\s+/g, '')) && item.replace(/\s+/g, '') !== '')
}

/* ── D2: tiled marks must not be clipped at the page edges ────────────────── */

const TILE_SPEC = {
  text: TILE_TEXT,
  placement: 'tile',
  opacity: 0.5,
  color: '#cc0000',
  fontSize: 44,
  pages: [1],
}

if (!TEXT_OK) {
  skip('D2a 平铺水印不在页面边缘留下被裁断的文字片段', TEXT_REASON)
} else {
  // D2a — clipped fragments in the text layer.
  let fragments = []
  let itemCount = 0
  try {
    const result = await addWatermark(sameSize, TILE_SPEC)
    const items = await extractItems(result.bytes, 1)
    itemCount = items.length
    for (const item of items) {
      for (const token of item.split(/\s+/)) {
        if (token.length === 0) continue
        if (!TILE_TEXT_FLAT.includes(token)) continue
        if (token === TILE_TEXT_FLAT || COMPLETE_WORDS.has(token)) continue
        fragments.push({ item, token })
      }
    }
  } catch (error) {
    fragments = [{ item: `addWatermark 抛错 ${error.name}: ${error.message}`, token: '' }]
  }
  spec('D2a', '平铺水印不在页面边缘留下被裁断的文字片段',
    fragments.length === 0,
    fragments.length === 0
      ? `文字层 ${itemCount} 个文本项，没有 “部资料 / 内部资” 这类被裁断的片段`
      : `文字层出现被裁断的片段：${JSON.stringify(fragments.slice(0, 4))}`,
    '平铺的每个水印都是完整的：文字层里出现的每个片段要么是完整水印，要么是完整词语，'
    + '不应出现 “部资料”“内部资” 等被页面边界切出来的片段。')
}

{
  // D2b — every tile's rotated bounding box must sit inside the mark's /BBox,
  // and the /BBox must be the page's visible region (CropBox).
  let ok = false
  let detail = ''
  let checked = false
  try {
    const result = await addWatermark(sameSize, TILE_SPEC)
    const doc = await loadDoc(result.bytes)
    const mark = markBodiesForPage(doc, 0)[0]
    const boxes = placedMarkBoxes(mark?.body ?? null)
    const bboxValue = mark?.dict.get(PDFName.of('BBox'))
    const bbox = bboxValue instanceof PDFArray
      ? Array.from({ length: bboxValue.size() }, (_, i) => Number(bboxValue.get(i).toString()))
      : null
    const region = doc.getPages()[0].getCropBox()
    const tolerance = 0.5

    if (mark !== undefined && boxes.length > 0 && bbox !== null && bbox.length === 4) {
      checked = true
      const outside = boxes.filter(box =>
        box.x0 < bbox[0] - tolerance
        || box.y0 < bbox[1] - tolerance
        || box.x1 > bbox[2] + tolerance
        || box.y1 > bbox[3] + tolerance)
      const bboxMatchesRegion = Math.abs(bbox[0] - region.x) < tolerance
        && Math.abs(bbox[1] - region.y) < tolerance
        && Math.abs(bbox[2] - (region.x + region.width)) < tolerance
        && Math.abs(bbox[3] - (region.y + region.height)) < tolerance
      const worst = outside.length === 0 ? 0 : Math.max(...outside.map(box => Math.max(
        bbox[0] - box.x0,
        bbox[1] - box.y0,
        box.x1 - bbox[2],
        box.y1 - bbox[3],
      )))
      ok = outside.length === 0 && bboxMatchesRegion
      detail = `${boxes.length} 个 tile（旋转 ${boxes[0].rotationDegrees.toFixed(0)}°，`
        + `尺寸 ${boxes[0].width.toFixed(1)}×${boxes[0].height.toFixed(1)}），`
        + `越出 /BBox 的 tile：${outside.length} 个，最大越界 ${worst.toFixed(2)}pt；`
        + `/BBox=[${bbox.map(v => v.toFixed(1)).join(', ')}]，页面 CropBox=`
        + `[${region.x}, ${region.y}, ${region.x + region.width}, ${region.y + region.height}]，`
        + `一致：${bboxMatchesRegion}`
    } else {
      detail = `无法解析水印几何（XObject ${mark === undefined ? '缺失' : '存在'}，`
        + `tile ${boxes.length} 个，/BBox ${JSON.stringify(bbox)}）`
    }
  } catch (error) {
    detail = `检查时抛错 ${error.name}: ${error.message}`
  }
  if (checked) {
    spec('D2b', '每个 tile 的旋转后包围盒完全落在 /BBox 内，且 /BBox 就是页面 CropBox',
      ok, detail,
      '平铺网格内接于页面可见区域：每个 tile 的旋转后包围盒都在外层 XObject 的 /BBox 之内，'
      + '且 /BBox 等于页面 CropBox。旧实现从 −stride 起铺，四边各切掉半个字。')
  } else {
    skip('D2b 每个 tile 的旋转后包围盒完全落在 /BBox 内', detail)
  }
}

{
  // D2c — pixel proof: no mark ink in the outermost band of the page.
  if (RENDER_OK) {
    const BAND = 8
    let ok = false
    let detail = ''
    try {
      const result = await addWatermark(sameSize, TILE_SPEC)
      const rendered = await renderPage(result.bytes, 1, 2)
      const borderInk = markInkOnBorder(rendered.image, BAND)
      ok = borderInk === 0
      detail = `页面渲染 ${rendered.image.width}×${rendered.image.height}，边缘 ${BAND}px 内的水印墨迹像素：${borderInk}`
    } catch (error) {
      detail = `渲染/检查抛错 ${error.name}: ${error.message}`
    }
    spec('D2c', `平铺水印在页面最外侧 ${BAND}px 内没有墨迹（渲染验证）`,
      ok, detail,
      '平铺水印整体位于页面可见区域之内，渲染后四边不会出现被裁掉一半的字。')
  } else {
    skip('D2c 平铺水印在页面最外侧 8px 内没有墨迹（渲染验证）', RENDER_REASON)
  }
}

/* ── D3: an image watermark must either be painted or fail loudly ─────────── */

{
  let outcome = null
  try {
    outcome = await addWatermark(sameSize, { image: imageBytes, placement: 'center', pages: [1] })
  } catch (error) {
    outcome = { error }
  }

  if (outcome.error !== undefined) {
    spec('D3a', '图片水印：要么画出图片 XObject，要么明确报错',
      true, `明确报错 ${outcome.error.name}: ${outcome.error.message}`, '——')
    spec('D3b', '图片水印真的被画出来（渲染验证）', true, '直接报错，没有谎报成功', '——')
  } else {
    const doc = await loadDoc(outcome.bytes)
    const mark = markBodiesForPage(doc, 0)[0]
    let images = []
    let missing = []
    if (mark !== undefined) {
      const graph = inspectMarkGraph(mark)
      images = graph.images
      missing = graph.missing
    }
    const drawn = images.length > 0 && missing.length === 0
    spec('D3a', '图片水印：内容流引用的图片 XObject 在资源里真实存在',
      drawn,
      mark === undefined
        ? '页面上找不到水印 XObject'
        : `可达图片 XObject ${images.length} 个（${JSON.stringify(images)}）；`
          + `内容流调用但资源里解析不到的名字：${JSON.stringify(missing)}`
          + `；result.render=${String(outcome.result.render)}`,
      '水印内容流用 /WMImg Do 之类的名字调用图片时，该名字必须在水印 XObject 的 /Resources/XObject 里'
      + '解析到一个 /Subtype /Image 的对象。旧实现的 imageObjectRef 从未赋值，Do 解析不到任何东西，'
      + '画面空白却报成功。')

    if (RENDER_OK) {
      let ok = false
      let changed = 0
      let detail = ''
      try {
        const before = await renderPage(sameSize, 1, 1)
        const after = await renderPage(outcome.bytes, 1, 1)
        changed = diffCount(before.image, after.image)
        ok = changed > 500
        detail = `${changed} 像素不同（共 ${before.image.width * before.image.height}）`
      } catch (error) {
        detail = `渲染抛错 ${error.name}: ${error.message}`
      }
      spec('D3b', '图片水印真的被画出来（渲染验证）',
        ok, detail,
        '加了图片水印的页面渲染后必须与原始页面明显不同；旧实现渲染结果逐像素相同。')
    } else {
      skip('D3b 图片水印真的被画出来（渲染验证）', RENDER_REASON)
    }
  }
}

/* ── D4: pages without their own /Resources ──────────────────────────────── */

{
  const cases = [
    { label: '页面没有 /Resources，页树上也没有', bytes: noResources },
    { label: '资源从页树继承，且继承来的字典没有 /XObject 键', bytes: inheritedResources },
  ]
  for (const [index, testCase] of cases.entries()) {
    let error = null
    let detail = '正常返回'
    try {
      const result = await addWatermark(testCase.bytes, {
        text: MARKER_TEXT,
        placement: 'center',
        rotation: 0,
      })
      detail = `正常返回，盖章 ${result.result.pages} 页`
    } catch (caught) {
      error = caught
      detail = `${caught.name}: ${caught.message}`
    }
    spec(`D4${'abc'[index]}`, `没有页级 /XObject 时不抛错：${testCase.label}`,
      error === null, detail,
      '页面自己没有 /Resources（或继承来的 /Resources 没有 /XObject 键）时，加水印必须照常工作：'
      + '为页面建立（必要时复制一份）自己的资源字典即可。旧实现对这两种形状都抛 TypeError。')
  }

  {
    // Two distinct shapes, checked separately so the diagnosis names the exact
    // page shape: a page with no /Resources at all, and a page whose /Resources
    // exists but has no /XObject key. `PDFPageLeaf.Resources()` resolves
    // inheritance, so the second shape is the one a bare
    // `resources.lookup('XObject', PDFDict)` still throws on.
    const shapes = [
      { id: 'D4d', label: '页面完全没有 /Resources（页树上也没有）', bytes: resourcesMissing },
      { id: 'D4e', label: '/Resources 存在但没有 /XObject 键（如只有 ProcSet）', bytes: resourcesNoXObject },
    ]
    for (const shape of shapes) {
      let error = null
      let detail = ''
      try {
        const scan = await scanWatermarks(shape.bytes)
        detail = `正常返回，扫描 ${scan.pages} 页，候选 ${scan.candidates.length} 个`
      } catch (caught) {
        error = caught
        detail = `${caught.name}: ${caught.message}`
      }
      spec(shape.id, `scanWatermarks 不抛错：${shape.label}`,
        error === null, detail,
        '扫描要容忍没有 /XObject 键、甚至没有 /Resources 的页面：这类页面出不来候选是正常的，'
        + '但不应崩。removeWatermarks 也先调用同一个扫描，因此同样会崩。')
    }
  }

  {
    let ok = false
    let detail = ''
    try {
      const beforeDoc = await loadDoc(inheritedResources)
      const beforePage2 = pageContentText(beforeDoc, 1)
      const result = await addWatermark(inheritedResources, {
        text: MARKER_TEXT,
        placement: 'center',
        rotation: 0,
        pages: [1],
      })
      const afterDoc = await loadDoc(result.bytes)
      const afterPage2 = pageContentText(afterDoc, 1)
      const page1Content = pageContentText(afterDoc, 0)
      const page1Invokes = invokedNames(page1Content).includes(WATERMARK_MARKER)
      const page2Invokes = invokedNames(afterPage2).includes(WATERMARK_MARKER)
      ok = beforePage2 === afterPage2 && !page2Invokes && page1Invokes && result.result.pages === 1
      detail = `第 2 页内容流逐字节不变：${beforePage2 === afterPage2}；`
        + `第 1 页调用水印：${page1Invokes}；第 2 页调用水印：${page2Invokes}；`
        + `报告盖章页数：${result.result.pages}`
    } catch (error) {
      detail = `抛错 ${error.name}: ${error.message}`
    }
    spec('D4f', '继承资源的文档只给指定页盖章，其他页内容流不变',
      ok, detail,
      'pages: [1] 时只有第 1 页被盖章，其他页面的内容流逐字节保持不变'
      + '（共享的页树资源字典不能被就地修改）。')
  }
}

/* ── D5: the reported dropped characters must be the ones actually dropped ── */

{
  let ok = false
  let detail = ''
  let checked = false

  if (splitDrawableText !== null) {
    checked = true
    const source = '内部资料AB'
    const first = splitDrawableText(source)
    const second = splitDrawableText('A b1~')
    const expectedDropped = ['内', '部', '资', '料']
    const droppedSet = new Set(first.dropped)
    const wrongReported = first.dropped.filter(char => first.drawable.includes(char))
    const missing = expectedDropped.filter(char => !droppedSet.has(char))
    ok = first.drawable === 'AB'
      && wrongReported.length === 0
      && missing.length === 0
      && droppedSet.size === expectedDropped.length
      && second.drawable === 'A b1~'
      && second.dropped.length === 0
    detail = `splitDrawableText('${source}') = { drawable: ${JSON.stringify(first.drawable)}, `
      + `dropped: ${JSON.stringify(first.dropped)} }；`
      + `splitDrawableText('A b1~') = { drawable: ${JSON.stringify(second.drawable)}, `
      + `dropped: ${JSON.stringify(second.dropped)} }；`
      + `漏报 ${JSON.stringify(missing)}，误报（实际画出了却算丢失）${JSON.stringify(wrongReported)}`
  }

  // End-to-end: force the "machine has no usable font file" fallback and check
  // the characters the result reports as dropped.
  let e2e = null
  let e2eDetail = ''
  const saved = Array.isArray(fonts?.CJK_FONT_CANDIDATES) ? fonts.CJK_FONT_CANDIDATES.slice() : null
  if (saved === null) {
    e2eDetail = '无法导入 fonts.ts 的 CJK_FONT_CANDIDATES，无法制造“机器上没有系统字体”的回退场景'
  } else {
    const text = '内部资料 ABC 123'
    try {
      fonts.CJK_FONT_CANDIDATES.length = 0
      e2e = await addWatermark(sameSize, { text, placement: 'center', rotation: 0, pages: [1] })
      e2eDetail = `textDrawn=${JSON.stringify(e2e.result.textDrawn)} droppedChars=${JSON.stringify(e2e.result.droppedChars)}`
      e2e.text = text
    } catch (error) {
      e2eDetail = `制造回退场景时抛错 ${error.name}: ${error.message}`
    } finally {
      fonts.CJK_FONT_CANDIDATES.push(...saved)
    }
  }

  if (e2e !== null && e2e.result.textDrawn !== e2e.text) {
    const drawn = new Set([...e2e.result.textDrawn])
    const expected = [...new Set([...e2e.text].filter(char => !drawn.has(char)))]
    const dropped = new Set(e2e.result.droppedChars)
    const wrong = [...dropped].filter(char => drawn.has(char))
    const missing = expected.filter(char => !dropped.has(char))
    const e2eOk = wrong.length === 0 && missing.length === 0
    checked = true
    ok = ok && e2eOk
    detail += `；端到端（Helvetica 回退）：${e2eDetail}；真正丢失 ${JSON.stringify(expected)}；`
      + `误报 ${JSON.stringify(wrong)}；漏报 ${JSON.stringify(missing)}`
  } else {
    e2eDetail += '（未进入回退分支，端到端部分不计入）'
    detail += `；端到端部分跳过：${e2eDetail}`
  }

  if (checked) {
    spec('D5', 'droppedChars 报告的是真正没有画出来的字符',
      ok, detail,
      'droppedChars 必须恰好是“请求的文字里没有画出来”的那些字符：'
      + 'splitDrawableText("内部资料AB") 应为 drawable "AB" / dropped ["内","部","资","料"]。'
      + '旧实现条件写反，把成功画出的 ASCII 字符报成丢失，真正的 CJK 字符反而没报。')
  } else {
    skip('D5 droppedChars 报告的是真正没有画出来的字符', detail)
  }
}

/* ── D6: centre/corner placement must use the CropBox, not the MediaBox ───── */

{
  const SPEC_6 = {
    text: MARKER_TEXT,
    placement: 'center',
    rotation: 0,
    fontSize: 44,
    opacity: 0.6,
    color: '#cc0000',
    pages: [1],
  }
  // A smaller font keeps the mark comfortably inside the CropBox *with* its
  // margin, so the geometry tests below isolate "MediaBox versus CropBox" from
  // the separate question of what happens when the mark barely fits.
  const SMALL = { ...SPEC_6, fontSize: 20 }

  if (RENDER_OK) {
    let ok = false
    let detail = ''
    try {
      const result = await addWatermark(cropBox, SMALL)
      const rendered = await renderPage(result.bytes, 1, 2)
      const stats = markInkStats(rendered.image)
      const centreX = stats.width / 2
      const centreY = stats.height / 2
      const dx = Math.abs(stats.centroidX - centreX)
      const dy = Math.abs(stats.centroidY - centreY)
      const tolerance = 0.06 * Math.max(stats.width, stats.height)
      ok = stats.count > 0 && dx <= tolerance && dy <= tolerance
      detail = `可见区域渲染 ${stats.width}×${stats.height}；水印墨迹 ${stats.count}px，`
        + `质心 (${stats.centroidX.toFixed(1)}, ${stats.centroidY.toFixed(1)})，`
        + `画面中心 (${centreX}, ${centreY})，偏移 (${dx.toFixed(1)}, ${dy.toFixed(1)})，容差 ${tolerance.toFixed(1)}`
    } catch (error) {
      detail = `抛错 ${error.name}: ${error.message}`
    }
    spec('D6a', '居中水印落在 CropBox 的中心（渲染验证）',
      ok, detail,
      '页面 MediaBox 为 612×792、CropBox 为 [300,400,200,200] 时，居中水印必须出现在 CropBox 的中心。'
      + '旧实现按 MediaBox 居中，水印被挤到可见区域的左下角（甚至完全看不见）。')
  } else {
    skip('D6a 居中水印落在 CropBox 的中心（渲染验证）', RENDER_REASON)
  }

  if (RENDER_OK) {
    let ok = false
    let detail = ''
    try {
      const result = await addWatermark(cropBox, {
        ...SMALL,
        placement: 'corner',
        corner: 'bottom-right',
        margin: 24,
      })
      const rendered = await renderPage(result.bytes, 1, 2)
      const stats = markInkStats(rendered.image)
      // The mark must sit at the CropBox's bottom-right corner, a margin (plus
      // the text's own side bearings) away from the edge — never flush against
      // it and never outside the visible region.
      const rightEdge = stats.maxX / stats.width
      const bottomEdge = stats.maxY / stats.height
      ok = stats.count > 0
        && rightEdge > 0.75 && rightEdge < 0.98
        && bottomEdge > 0.75 && bottomEdge < 0.98
        && stats.centroidX > stats.width * 0.55
        && stats.centroidY > stats.height * 0.55
      detail = `水印墨迹 ${stats.count}px，质心 (${stats.centroidX.toFixed(1)}, ${stats.centroidY.toFixed(1)})，`
        + `包围盒 x[${stats.minX},${stats.maxX}] y[${stats.minY},${stats.maxY}]，画面 ${stats.width}×${stats.height}`
        + `（右缘 ${(rightEdge * 100).toFixed(1)}%、下缘 ${(bottomEdge * 100).toFixed(1)}%）`
    } catch (error) {
      detail = `抛错 ${error.name}: ${error.message}`
    }
    spec('D6b', 'bottom-right 角标落在 CropBox 的右下角（渲染验证）',
      ok, detail,
      'corner: "bottom-right" 时水印必须出现在 CropBox 的右下角、距边一个 margin，'
      + '既不出现在可见区域之外，也不贴死在边界上。旧实现锚在 MediaBox 的右下角，'
      + '对 CropBox 偏移过的页面来说整个落在可见区域之外（渲染为空白）。')
  } else {
    skip('D6b bottom-right 角标落在 CropBox 的右下角（渲染验证）', RENDER_REASON)
  }

  /**
   * Structural CropBox check.
   *
   * A4 has no CropBox, so its visible region *is* the MediaBox and a centre mark
   * there reveals the mark's own size — no assumption about font metrics.
   */
  // `pageIndexes` are 0-based page indexes into `cropbox.pdf`; `pages` in the
  // spec is 1-based, hence the map.
  const checkCentreAgainstCropBox = async (spec_, pageIndexes) => {
    const result = await addWatermark(cropBox, { ...spec_, pages: pageIndexes.map(index => index + 1) })
    const doc = await loadDoc(result.bytes)
    const reference = await addWatermark(sameSize, { ...spec_, pages: [1] })
    const referenceDoc = await loadDoc(reference.bytes)
    const referenceRegion = referenceDoc.getPages()[0].getCropBox()
    const referenceAnchor = placementAnchors(markBodiesForPage(referenceDoc, 0)[0]?.body ?? null)[0]
    if (referenceAnchor === undefined) return { checked: false, detail: '无法从参考文档读出居中锚点' }
    const markWidth = referenceRegion.width - 2 * (referenceAnchor.x - referenceRegion.x)
    const markHeight = referenceRegion.height - 2 * (referenceAnchor.y - referenceRegion.y)
    const failures = []
    for (const index of pageIndexes) {
      const region = doc.getPages()[index].getCropBox()
      const anchor = placementAnchors(markBodiesForPage(doc, index)[0]?.body ?? null)[0]
      const expectedX = region.x + (region.width - markWidth) / 2
      const expectedY = region.y + (region.height - markHeight) / 2
      const matches = anchor !== undefined
        && Math.abs(anchor.x - expectedX) < 1.5
        && Math.abs(anchor.y - expectedY) < 1.5
      if (!matches) {
        failures.push(`第 ${index + 1} 页 CropBox=[${region.x},${region.y},${region.width},${region.height}]`
          + ` 期望锚点 (${expectedX.toFixed(1)}, ${expectedY.toFixed(1)})，`
          + `实际 ${anchor === undefined ? '读不到' : `(${anchor.x.toFixed(1)}, ${anchor.y.toFixed(1)})`}`)
      }
    }
    return {
      checked: true,
      ok: failures.length === 0,
      detail: failures.length === 0
        ? `锚点按各自 CropBox 计算（水印 ${markWidth.toFixed(1)}×${markHeight.toFixed(1)}pt）`
        : failures.join('；'),
    }
  }

  {
    // CropBox comfortably larger than the mark plus its margins: this is the
    // plain "use the CropBox, not the MediaBox" contract, and it also catches a
    // per-page-size body cache that ignores the CropBox (page 2 has the same
    // MediaBox as page 1 but a different CropBox).
    let outcome = { checked: false, detail: '' }
    try {
      outcome = await checkCentreAgainstCropBox(SMALL, [0, 1])
    } catch (error) {
      outcome = { checked: false, detail: `检查时抛错 ${error.name}: ${error.message}` }
    }
    if (outcome.checked) {
      spec('D6c', '居中定位按 CropBox 计算（结构验证，含两页 CropBox 不同的情形）',
        outcome.ok, outcome.detail,
        '居中锚点 = CropBox 原点 + (CropBox 尺寸 − 水印尺寸)/2。两个 MediaBox 相同但 CropBox 不同的页面'
        + '必须得到各自的锚点，因此按页面几何缓存水印体时也要把 CropBox 计入 key。')
    } else {
      skip('D6c 居中定位按 CropBox 计算（结构验证）', outcome.detail)
    }
  }

  {
    // The mark fits the CropBox (176pt mark in a 200pt box) but not the CropBox
    // plus a 24pt margin on both sides. Centring is still the right placement;
    // clamping to the margin instead pushes the mark flush against the opposite
    // edge. Kept separate from D6c so the two failures cannot mask each other.
    let outcome = { checked: false, detail: '' }
    try {
      outcome = await checkCentreAgainstCropBox(SPEC_6, [0])
    } catch (error) {
      outcome = { checked: false, detail: `检查时抛错 ${error.name}: ${error.message}` }
    }
    if (outcome.checked) {
      spec('D6e', '水印放得下但放不下两侧边距时，居中定位仍然真正居中',
        outcome.ok, outcome.detail,
        'CropBox 宽 200pt、水印宽 176pt：水印放得下，因此“居中”就是在两边各留 12pt。'
        + '如果为了实现“别超出页面”而把锚点 clamp 到 margin 上，水印会被推到右边缘（实测锚点 324 而非 312），'
        + '等于用另一个 bug 换掉了 MediaBox 那个 bug。')
    } else {
      skip('D6e 水印放得下但放不下两侧边距时，居中定位仍然真正居中', outcome.detail)
    }
  }
}

/* ── D7: out-of-range page numbers must not be ignored silently ───────────── */

{
  const KNOWN_RESULT_KEYS = new Set(['pages', 'xobjectName', 'textDrawn', 'droppedChars', 'render', 'artifact', 'notes'])

  const rejected = (outcome, numbers) => {
    if (outcome.error !== undefined) {
      const message = `${outcome.error.name}: ${outcome.error.message}`
      return {
        ok: numbers.every(number => new RegExp(`(^|[^0-9-])${number}([^0-9]|$)`).test(message)),
        where: `抛错 ${message}`,
      }
    }
    const result = outcome.result ?? {}
    const extra = Object.fromEntries(Object.entries(result).filter(([key]) => !KNOWN_RESULT_KEYS.has(key)))
    const haystack = `${(result.notes ?? []).join(' ')} ${JSON.stringify(extra)}`
    return {
      ok: numbers.every(number => new RegExp(`(^|[^0-9-])${number}([^0-9]|$)`).test(haystack)),
      where: `notes=${JSON.stringify(result.notes ?? [])}；其他字段=${JSON.stringify(extra)}`,
    }
  }

  const run = async pages => {
    try {
      return await addWatermark(sameSize, { text: MARKER_TEXT, placement: 'center', rotation: 0, pages })
    } catch (error) {
      return { error }
    }
  }

  {
    const outcome = await run([99])
    const report = rejected(outcome, [99])
    spec('D7a', '指定不存在的页号时不再静默成功',
      report.ok,
      `${report.where}${outcome.error === undefined ? `；result.pages=${outcome.result.pages}` : ''}`,
      '指定一个不存在的页号时，要么抛出明确错误，要么在结果里显式报告被忽略的页号'
      + '（notes 或专门字段）。旧实现静默返回 pages: 0。')
  }

  {
    const outcome = await run([1, 99])
    const report = rejected(outcome, [99])
    const pagesOk = outcome.error === undefined && outcome.result.pages === 1
    spec('D7b', '有效页与无效页混排：有效页照常盖章，无效页被报告',
      report.ok && pagesOk,
      `${report.where}；result.pages=${outcome.error === undefined ? outcome.result.pages : '（抛错）'}`,
      'pages: [1, 99] 应给第 1 页盖章（pages === 1）并报告第 99 页无效。')
  }

  {
    const outcome = await run([0, -1])
    const report = rejected(outcome, [0, -1])
    spec('D7c', '页号 0 与负数被视为无效并报告',
      report.ok, report.where,
      '页号是 1-based：0 和负数必须被当作无效页号报告（抛错，或在 notes/字段中列出）。')
  }

  {
    const outcome = await run([])
    spec('D7d', '空 pages 数组不被当作“成功但什么都没做”',
      outcome.error !== undefined,
      outcome.error !== undefined
        ? `抛错 ${outcome.error.name}: ${outcome.error.message}`
        : `静默返回 pages=${outcome.result.pages}`,
      'pages: [] 时没有任何页可盖章，必须明确报错（旧行为是静默返回 pages: 0）。')
  }
}

/* ── D8: stamping must not duplicate page content ─────────────────────────── */

{
  const originalDoc = await loadDoc(bulky)
  const baseline = orphanReport(originalDoc)
  const baselineInline = inlineContentStreams(originalDoc)
  const contentBytes = totalPageContentBytes(originalDoc)

  let doc = null
  let growth = 0
  let stamps = 0
  let failure = ''
  try {
    const result = await addWatermark(bulky, { text: MARKER_TEXT, placement: 'tile', opacity: 0.18, fontSize: 44 })
    growth = result.bytes.length - bulky.length
    stamps = result.result.pages
    doc = await loadDoc(result.bytes)
  } catch (error) {
    failure = `${error.name}: ${error.message}`
  }

  if (doc === null) {
    for (const id of ['D8a', 'D8b', 'D8c']) {
      spec(id, '加水印不重复存储页面内容', false, `addWatermark 抛错：${failure}`,
        '加水印后页面内容不应被内联进页字典、也不应留下孤立的内容流对象，文件不应接近翻倍。')
    }
  } else {
    const after = orphanReport(doc)
    const inline = inlineContentStreams(doc)
    const newOrphanStreams = after.orphanStreams - baseline.orphanStreams
    const newOrphanBytes = after.orphanStreamBytes - baseline.orphanStreamBytes
    const growthBudget = Math.max(64 * 1024, Math.round(contentBytes * 0.25))

    spec('D8a', '页面 /Contents 只引用间接对象，不内联内容流',
      inline.length === 0,
      `内联内容流的页：${JSON.stringify(inline)}（原始文档：${JSON.stringify(baselineInline)}）；`
      + `共 ${doc.getPages().length} 页`,
      '页面 /Contents 数组的每一项都必须是间接引用（PDFRef）。旧实现把已解析的流对象直接放进数组，'
      + '于是流被写进页字典、原对象变成孤立对象——正文存了两份。')

    spec('D8b', '加水印不产生新的孤立流对象',
      newOrphanStreams <= 0 && newOrphanBytes <= 2048,
      `孤立流：原始 ${baseline.orphanStreams} 个/${baseline.orphanStreamBytes}B`
      + ` → 加水印后 ${after.orphanStreams} 个/${after.orphanStreamBytes}B`
      + `（新增 ${newOrphanStreams} 个/${newOrphanBytes}B）`,
      '加水印后从 trailer 可达的对象应覆盖文件里的全部流对象；旧实现每页留下一个 41KB 量级的孤立内容流。')

    spec('D8c', '文件体积增长与水印净载荷同量级（不重复存储正文）',
      growth < growthBudget,
      `原始 ${bulky.length}B → 加水印 ${bulky.length + growth}B（+${growth}B）；`
      + `页面内容合计 ${contentBytes}B，预算 ${growthBudget}B；共盖 ${stamps} 页`,
      '加水印只应新增水印对象与每页一次调用的开销（数 KB 量级），不应接近正文本身的大小。'
      + '旧实现每页把正文复制一份，体积几乎翻倍。')
  }
}

/* ── D9: the new /Artifact contract ───────────────────────────────────────── */

{
  const doc = await loadDoc(added.bytes)
  const pages = doc.getPages()
  const problems = []
  for (const [index] of pages.entries()) {
    const content = pageContentText(doc, index)
    const occurrences = content.split(WATERMARK_MARKER).length - 1
    const artefacts = (content.match(/\/Artifact\b/g) ?? []).length
    const balanced = (content.match(/\bBDC\b/g) ?? []).length === (content.match(/\bEMC\b/g) ?? []).length
    if (occurrences !== 1 || artefacts !== 1 || !balanced) {
      problems.push(`第 ${index + 1} 页：调用 ${occurrences} 次，/Artifact ${artefacts} 处，BDC/EMC 平衡 ${balanced}`)
    }
  }
  spec('D9a', '每页只有一次水印调用，并被 /Artifact … BDC … EMC 包裹',
    problems.length === 0,
    problems.length === 0
      ? `${pages.length} 页均为 1 次调用 + 1 个 /Artifact 块（Type /Pagination、Subtype /Watermark）`
      : problems.join('；'),
    '每个被盖章的页面只新增一条水印调用，且包在 /Artifact <</Type /Pagination /Subtype /Watermark>> BDC … EMC 里，'
    + '让辅助技术与 PDF/UA 检查器把水印当作装饰而不是正文。')

  const imageOutcome = await addWatermark(sameSize, { image: imageBytes, placement: 'center', pages: [1] })
  spec('D9b', '结果里的 render 字段与实际模式一致',
    added.result.render === 'text'
    && imageOutcome.result.render === 'image',
    `文字/平铺：${String(added.result.render)}；图片：${String(imageOutcome.result.render)}`,
    'result.render 如实报告本次使用的绘制模式（text / outline / image），artifact 报告是否用了 /Artifact 包裹。')
}

/* -------------------------------------------------------------------------- */
/* section 3 — Adobe-style marks: the false negative this suite now pins down  */
/* -------------------------------------------------------------------------- */

console.log('\nAdobe-style watermarks — /PieceInfo and /Artifact wrapper\n')

/**
 * The Acrobat shape used to scan as `candidates: []`: the XObject's own name is
 * not ours, its body is ONE upright red `Tj` with no paths, and there is no
 * rotation. Every old signal refused it. The two new structural signals are the
 * `/PieceInfo /ADBE_CompoundType /Private /Watermark` identity and the
 * `/Artifact << /Subtype /Watermark >> BDC … EMC` wrapper.
 */
{
  const sourceHash = sha256(adobeFixture)
  const scan = await scanWatermarks(adobeFixture)
  const confident = scan.candidates.filter(candidate => candidate.confidence === 1)
  const listed = scan.candidates.map(candidate => `${candidate.page}:${candidate.reason}:${candidate.confidence}:${candidate.xobjectName}`)

  check('Adobe 水印：扫描给出至少一个置信度 1 的候选', confident.length >= 1,
    `${scan.candidates.length} 个候选：${JSON.stringify(listed)}`)
  check('Adobe 水印：置信度 1 的理由是 adobe-watermark 或 artifact-wrapper',
    confident.length > 0
    && confident.every(candidate => candidate.reason === 'adobe-watermark' || candidate.reason === 'artifact-wrapper'),
    JSON.stringify(confident.map(candidate => candidate.reason)))
  check('Adobe 水印：候选指向真正的 Form XObject /Fm0',
    confident.length > 0 && confident.every(candidate => candidate.xobjectName === 'Fm0'),
    JSON.stringify(confident.map(candidate => candidate.xobjectName)))
  check('Adobe 水印：/Artifact 包裹的普通插图 XObject 不被误报为高置信度候选',
    scan.candidates.every(candidate => candidate.xobjectName !== 'Fig1' || candidate.confidence < 0.9),
    JSON.stringify(listed))
  check('Adobe 水印：对照 XObject /Fig1 完全不出现在候选里（无 /PieceInfo、无 /gs）',
    scan.candidates.every(candidate => candidate.xobjectName !== 'Fig1'),
    JSON.stringify(listed))

  // The fixture must genuinely be the case that used to be missed — otherwise
  // the assertions above could pass for the wrong reason.
  const shapeDoc = await loadDoc(adobeFixture)
  const shapeXObjects = shapeDoc.context.lookup(shapeDoc.getPages()[0].node.Resources().get(PDFName.of('XObject')))
  const markObject = shapeDoc.context.lookup(shapeXObjects.get(PDFName.of('Fm0')))
  const controlObject = shapeDoc.context.lookup(shapeXObjects.get(PDFName.of('Fig1')))
  const markBody = decodeStream(markObject) ?? ''
  const controlBody = decodeStream(controlObject) ?? ''
  check('夹具确实是旧启发式会漏掉的形状：水印体只有 1 个 Tj、0 个路径算子、无旋转',
    (markBody.match(/Tj|TJ/g) ?? []).length === 1
    && (markBody.match(/\bre\b|\bf\b|\bS\b/g) ?? []).length === 0
    && !/[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+cm/.test(markBody),
    JSON.stringify(markBody))
  check('对照 XObject 真实存在，且没有 /PieceInfo、没有常透明度',
    controlObject instanceof PDFStream
    && controlObject.dict.get(PDFName.of('PieceInfo')) === undefined
    && !/\/[A-Za-z0-9]+ gs/.test(controlBody),
    JSON.stringify(controlBody))

  // The same document with `/PieceInfo` deleted: only the `/Artifact` wrapper
  // remains, and it must still be enough on its own.
  const mutated = await loadDoc(adobeFixture)
  const mutatedPage = mutated.getPages()[0]
  const mutatedXObjects = mutated.context.lookup(mutatedPage.node.Resources().get(PDFName.of('XObject')))
  const mutatedMark = mutated.context.lookup(mutatedXObjects.get(PDFName.of('Fm0')))
  mutatedMark.dict.delete(PDFName.of('PieceInfo'))
  const inlineOnly = await scanWatermarks(await mutated.save())
  check('仅 /Artifact 包裹（删掉 /PieceInfo）仍判为 artifact-wrapper 置信度 1',
    inlineOnly.candidates.length === 1
    && inlineOnly.candidates[0].reason === 'artifact-wrapper'
    && inlineOnly.candidates[0].confidence === 1,
    JSON.stringify(inlineOnly.candidates.map(candidate => `${candidate.reason}:${candidate.confidence}`)))

  const indirectOnly = await scanWatermarks(artifactIndirectFixture)
  check('间接引用形式的 /Artifact 12 0 R BDC 也能解析并判为 artifact-wrapper',
    indirectOnly.candidates.length === 1
    && indirectOnly.candidates[0].reason === 'artifact-wrapper'
    && indirectOnly.candidates[0].confidence === 1,
    JSON.stringify(indirectOnly.candidates.map(candidate => `${candidate.reason}:${candidate.confidence}`)))

  // ── removal, the part a user actually cares about ─────────────────────────
  let inkBefore = null
  let inkAfter = null
  if (RENDER_OK) {
    inkBefore = markInkStats((await renderPage(adobeFixture, 1, 2)).image).count
  } else {
    skip('Adobe 水印移除前有红字墨迹（渲染验证）', RENDER_REASON)
  }

  const applied = await removeWatermarks(adobeFixture, { dryRun: false })
  check('Adobe 水印：removeWatermarks 移除了该候选', applied.removed.length >= 1,
    JSON.stringify(applied.removed.map(candidate => candidate.reason)))
  const onDisk = new Uint8Array(await readFile(fixturePath('adobe-watermark.pdf')))
  check('Adobe 水印：移除不改动源文件字节',
    sha256(adobeFixture) === sourceHash && sha256(onDisk) === sourceHash,
    `内存 ${sha256(adobeFixture).slice(0, 12)} / 磁盘 ${sha256(onDisk).slice(0, 12)} / 原始 ${sourceHash.slice(0, 12)}`)

  if (RENDER_OK) {
    inkAfter = markInkStats((await renderPage(applied.bytes, 1, 2)).image).count
    // Measured on this fixture: 2276 red-dominant pixels before, 0 after.
    check('Adobe 水印：移除后渲染像素里红字消失（前 > 1000，后 = 0）',
      inkBefore > 1000 && inkAfter === 0,
      `红色墨迹像素：移除前 ${inkBefore} → 移除后 ${inkAfter}`)
  } else {
    skip('Adobe 水印移除后红字消失（渲染验证）', RENDER_REASON)
  }

  const cleanedDoc = await loadDoc(applied.bytes)
  check('Adobe 水印：移除后页数不变', cleanedDoc.getPages().length === (await loadDoc(adobeFixture)).getPages().length,
    `${cleanedDoc.getPages().length} 页`)
  const rescan = await scanWatermarks(applied.bytes)
  check('Adobe 水印：移除后重扫为 0 个候选', rescan.candidates.length === 0,
    JSON.stringify(rescan.candidates.map(candidate => candidate.reason)))

  if (runQpdf !== null) {
    const verdict = await runQpdf(['--check'], applied.bytes, 'read-only')
    check('Adobe 水印：移除后的文件 qpdf --check 通过', verdict.exit === 0,
      `exit=${verdict.exit} ${verdict.output.split('\n')[0] ?? ''}`)
  } else {
    skip('Adobe 水印：移除后的文件 qpdf --check 通过', qpdfReason)
  }
}

/* -------------------------------------------------------------------------- */
/* summary                                                                    */
/* -------------------------------------------------------------------------- */

console.log('\n────────────────────────────────────────────────────────────')
console.log(`passed ${passed}   regressions failed ${failed}   defects open ${openDefects.length}   skipped ${skipped}`)

if (skipped > 0) {
  console.log('\nskipped (explicitly, never counted as passes):')
  for (const reason of skipReasons) console.log(`  - ${reason}`)
}

if (openDefects.length > 0) {
  console.log('\nKNOWN DEFECTS still open — strict assertions that are not met yet:')
  for (const defect of openDefects) {
    console.log(`  [${defect.id}] ${defect.name}`)
    console.log(`        观察：${defect.detail ?? '（无细节）'}`)
    console.log(`        期望：${defect.expectation}`)
  }
  console.log(`\n这些断言是“修复前失败、修复后通过”的规格。本次运行退出码`
    + `${STRICT ? '为 1（WATERMARK_STRICT=1）' : '仍为 0（设置 WATERMARK_STRICT=1 可让其失败）'}。`)
}

if (fixedDefects.size > 0) {
  console.log(`\ndefect specs satisfied in this run: ${[...fixedDefects].sort().join(', ')}`)
}

console.log(`\nartifacts: ${join(OUT_DIR, 'watermarked.pdf')} , ${join(OUT_DIR, 'cleaned.pdf')}`)

if (failed > 0) {
  console.log('\nRESULT: 有回归断言失败。')
  process.exitCode = 1
} else if (STRICT && openDefects.length > 0) {
  console.log('\nRESULT: 严格模式下仍有未满足的缺陷断言。')
  process.exitCode = 1
} else {
  console.log('\nRESULT: 无回归失败。')
  process.exitCode = 0
}
