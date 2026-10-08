/**
 * Watermark test fixtures — generated locally with pdf-lib.
 *
 * Nothing here is downloaded: every fixture is built from pdf-lib primitives so
 * the watermark suite can run in an offline CI container. Generation is
 * deterministic (a seeded PRNG and `updateMetadata: false`) so byte-level and
 * size-growth assertions do not drift between runs.
 *
 * NOTE — 本文件是源码不是缓存，需纳入版本控制。
 * Only `test/fixtures/*.pdf` and `*.png` are caches (gitignored, rebuilt on
 * demand). This script itself has been removed repeatedly by
 * `git clean -fx test/fixtures`; it must be tracked. 仓库外备份：
 * /Users/Zhuanz/Desktop/deaktop-tool/tmp_clean/make-fixtures.mjs.bak
 * （恢复：cp tmp_clean/make-fixtures.mjs.bak pdf-studio/test/fixtures/make-fixtures.mjs）
 *
 * The set deliberately covers the page-tree shapes the watermark writer has to
 * survive:
 *
 * | file | why it exists |
 * |---|---|
 * | `same-size.pdf` | the ordinary case: three same-sized pages with body text |
 * | `mixed-size.pdf` | A4 + A3 + A5, so a per-page-size mark body is exercised |
 * | `cropbox.pdf` | CropBoxes smaller than the MediaBox and not starting at 0,0 |
 * | `rotated.pdf` | a `/Rotate 90` page, whose visible box differs from the MediaBox axes |
 * | `inherited-resources.pdf` | pages with **no own `/Resources`**; the dict (with a `/Font`, without `/XObject`) lives on the page tree |
 * | `no-resources.pdf` | two pages: one with no `/Resources` anywhere, one whose `/Resources` has only a `ProcSet` |
 * | `resources-missing.pdf` | the first shape alone, for a precise failure diagnosis |
 * | `resources-no-xobject.pdf` | the second shape alone, for a precise failure diagnosis |
 * | `bulky.pdf` | several pages of large, barely-compressible content, for duplication/bloat checks |
 * | `watermark-image.png` | a hand-encoded PNG, so the image watermark is testable without a rasteriser |
 *
 * Run directly (`node test/fixtures/make-fixtures.mjs`) or import
 * `ensureFixtures()` from a test; both write into this directory.
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const { PDFDocument, PDFName, PDFRawStream, StandardFonts, degrees } = require('pdf-lib')

export const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url))

const A4 = { width: 595.28, height: 841.89 }
const A3 = { width: 841.89, height: 1190.55 }
const A5 = { width: 419.53, height: 595.28 }
const LETTER = { width: 612, height: 792 }

/** Deterministic PRNG (mulberry32) so fixtures are byte-stable across runs. */
function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NOISE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** A long comment line: valid PDF, ignored by renderers, and hard to compress. */
function noiseComment(seed, length) {
  const random = prng(seed)
  let out = '%'
  for (let i = 0; i < length; i += 1) {
    out += NOISE_ALPHABET[Math.floor(random() * NOISE_ALPHABET.length)]
  }
  return out
}

function rawStream(doc, body) {
  const stream = PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), deflateSync(Buffer.from(body, 'latin1')))
  return doc.context.register(stream)
}

/** Write a page's `/Contents` without leaving the old stream behind as an orphan. */
function setContents(doc, page, body) {
  const previous = page.node.get(PDFName.of('Contents'))
  const ref = rawStream(doc, body)
  page.node.set(PDFName.of('Contents'), ref)
  if (previous !== undefined) doc.context.delete(previous)
  return ref
}

const BODY_LINES = [
  'Service Agreement',
  'Party A (Client): Example Technology Ltd.',
  'Party B (Provider): Example Data Services Ltd.',
  'Clause 1. Scope of services and deliverables.',
  'Clause 2. Fees, invoicing and payment terms.',
  'Clause 3. Confidentiality and data protection.',
]

async function textPage(doc, font, size, label) {
  const page = doc.addPage([size.width, size.height])
  let y = size.height - 90
  page.drawText(`${label}  ${BODY_LINES[0]}`, { x: 60, y, size: 18, font })
  y -= 36
  for (const line of BODY_LINES.slice(1)) {
    page.drawText(line, { x: 60, y, size: 11, font })
    y -= 22
  }
  return page
}

/** 1. Three A4 pages with ordinary body text. */
async function sameSize() {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 3; i += 1) await textPage(doc, font, A4, `Page ${i} of 3`)
  return doc.save()
}

/** 2. A4 + A3 + A5, so per-page-size mark bodies are exercised. */
async function mixedSize() {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  await textPage(doc, font, A4, 'A4 page')
  await textPage(doc, font, A3, 'A3 page')
  await textPage(doc, font, A5, 'A5 page')
  return doc.save()
}

/**
 * 3. CropBox smaller than the MediaBox, with a non-zero origin — one page with a
 * zero-origin MediaBox and one with a shifted MediaBox.
 */
async function cropBox() {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)

  const page1 = doc.addPage([LETTER.width, LETTER.height])
  page1.setCropBox(300, 400, 200, 200)
  page1.drawText('Visible crop region', { x: 320, y: 560, size: 12, font })

  const page2 = doc.addPage([LETTER.width, LETTER.height])
  page2.setMediaBox(50, 60, LETTER.width, LETTER.height)
  page2.setCropBox(100, 120, 400, 500)
  page2.drawText('Shifted media and crop box', { x: 140, y: 560, size: 12, font })

  return doc.save()
}

/** 4. A page that is displayed rotated 90°. */
async function rotated() {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = await textPage(doc, font, A4, 'Rotated page')
  page.setRotation(degrees(90))
  return doc.save()
}

/**
 * 5. Two pages with **no own `/Resources`**: the dict lives on the page-tree
 * node, which is how many real generators write files. Crucially the inherited
 * dict has a `/Font` but **no `/XObject`** — the shape that makes a
 * `resources.lookup(PDFName.of('XObject'), PDFDict)` call throw.
 */
async function inheritedResources() {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 2; i += 1) await textPage(doc, font, A4, `Inherited resources, page ${i}`)

  const pagesNode = doc.catalog.Pages()
  // `drawText` normalised each page's own resources; keep only the font mapping
  // on the tree so the content streams still resolve but `/XObject` is gone.
  const fontDict = doc.getPages()[0].node.Resources().get(PDFName.of('Font'))
  pagesNode.set(PDFName.of('Resources'), doc.context.obj({ Font: fontDict }))
  for (const page of doc.getPages()) page.node.delete(PDFName.of('Resources'))
  return doc.save()
}

/** A page whose content needs no resources and which has none anywhere. */
function appendBarePage(doc) {
  const page = doc.addPage([A4.width, A4.height])
  page.node.delete(PDFName.of('Resources'))
  setContents(doc, page, 'q 0.1 0.1 0.6 rg 60 600 300 120 re f Q\n% no resources at all\n')
  return page
}

/** A page whose own `/Resources` holds only a `ProcSet` — no `/XObject` key. */
function appendProcSetPage(doc) {
  const page = doc.addPage([A4.width, A4.height])
  page.node.set(PDFName.of('Resources'), doc.context.obj({ ProcSet: ['PDF'] }))
  setContents(doc, page, 'q 0.6 0.1 0.1 rg 60 400 300 120 re f Q\n% resources without /XObject\n')
  return page
}

/** 6. Both resource shapes in one document. */
async function noResources() {
  const doc = await PDFDocument.create({ updateMetadata: false })
  appendBarePage(doc)
  appendProcSetPage(doc)
  doc.catalog.Pages().delete(PDFName.of('Resources'))
  return doc.save()
}

/** 7. The bare-page shape alone, so a failure can be attributed precisely. */
async function resourcesMissing() {
  const doc = await PDFDocument.create({ updateMetadata: false })
  appendBarePage(doc)
  doc.catalog.Pages().delete(PDFName.of('Resources'))
  return doc.save()
}

/** 8. The resources-without-`/XObject` shape alone. */
async function resourcesNoXObject() {
  const doc = await PDFDocument.create({ updateMetadata: false })
  appendProcSetPage(doc)
  doc.catalog.Pages().delete(PDFName.of('Resources'))
  return doc.save()
}

/**
 * 9. Several pages of large, barely-compressible content. The payload here is
 * ~55KB per page, so any inline-and-orphan behaviour shows up as ~55KB of growth
 * per page. Each page gets its own complete `/Resources` (including `/XObject`),
 * which isolates the duplication defect from the missing-`/XObject` one.
 */
async function bulky() {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = 8
  for (let i = 1; i <= pages; i += 1) {
    const page = doc.addPage([A4.width, A4.height])
    page.node.set(PDFName.of('Resources'), doc.context.obj({
      Font: doc.context.obj({ Helv: font.ref }),
      XObject: doc.context.obj({}),
      ExtGState: doc.context.obj({}),
      ProcSet: ['PDF', 'Text'],
    }))
    const body = [
      'q 0.2 0.2 0.2 rg 40 40 100 60 re f Q',
      `BT /Helv 12 Tf 1 0 0 1 60 780 Tm (Bulky fixture page ${i}) Tj ET`,
      noiseComment(1000 + i, 55000),
      '',
    ].join('\n')
    setContents(doc, page, body)
  }
  return doc.save()
}

export const FIXTURES = {
  'same-size.pdf': sameSize,
  'mixed-size.pdf': mixedSize,
  'cropbox.pdf': cropBox,
  'rotated.pdf': rotated,
  'inherited-resources.pdf': inheritedResources,
  'no-resources.pdf': noResources,
  'resources-missing.pdf': resourcesMissing,
  'resources-no-xobject.pdf': resourcesNoXObject,
  'bulky.pdf': bulky,
  'watermark-image.png': async () => watermarkImage(),
}

/** Generate every fixture into this directory (idempotent, deterministic). */
export async function ensureFixtures() {
  await mkdir(FIXTURE_DIR, { recursive: true })
  const written = {}
  for (const [name, build] of Object.entries(FIXTURES)) {
    const bytes = await build()
    await writeFile(join(FIXTURE_DIR, name), bytes)
    written[name] = bytes
  }
  return written
}

export function fixturePath(name) {
  if (!(name in FIXTURES)) throw new Error(`unknown fixture: ${name}`)
  return join(FIXTURE_DIR, name)
}

/* -------------------------------------------------------------------------- */
/* image fixture                                                              */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * Encode an 8-bit RGB PNG by hand.
 *
 * Hand-rolled so the watermark suite can build an image without `@napi-rs/canvas`
 * — the image-watermark assertions must not be skippable on a machine where the
 * native canvas binding is unusable.
 */
export function makePng(width, height, pixel) {
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3)
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y)
      const offset = rowStart + 1 + x * 3
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]))
}

/** A 64×64 red/blue checkerboard — unmistakable against any page content. */
export function watermarkImage() {
  return makePng(64, 64, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [220, 20, 20] : [20, 20, 220]))
}

const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1]

if (invokedDirectly) {
  const written = await ensureFixtures()
  for (const [name, bytes] of Object.entries(written)) {
    console.log(`${String(bytes.length).padStart(9)}  ${name}`)
  }
  if (!existsSync(fixturePath('same-size.pdf'))) process.exitCode = 1
}
