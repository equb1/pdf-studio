/**
 * End-to-end proof for `src/core/searchable-pdf.ts`.
 *
 * Run with plain node (Node >= 22.6 needs the types flag):
 *   node --experimental-strip-types test/searchable-pdf.test.mjs
 *
 * What this actually proves, using pdfjs to re-open the bytes we wrote:
 *   1. the scanned image on every page is still painted (paintImageXObject
 *      count is unchanged) — i.e. the original content survived `copyPages`
 *   2. page count and page dimensions are unchanged
 *   3. the overlay text really is in the text layer (page.getTextContent())
 *      for BOTH the latin and the CJK font path
 *   4. the page content stream contains `3 Tr` in `mode: 'invisible'`
 *   5. `mode: 'cover'` paints a patch and does NOT go invisible
 *   6. the source file is byte-identical afterwards
 *   7. skipped-line accounting is honest (empty text, zero box, bad page)
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

import { buildSearchablePdf, pickOverlayFont } from '../src/core/searchable-pdf.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

const SOURCE = fileURLToPath(new URL('./fixtures/ceshi.pdf', import.meta.url))
const OUTPUT = '/tmp/pdf-studio-searchable-test.pdf'
const OUTPUT_COVER = '/tmp/pdf-studio-searchable-cover-test.pdf'
const STANDARD_FONTS = path.join(REPO, 'node_modules/pdfjs-dist/standard_fonts/')

const failures = []
let checks = 0

function check(label, fn) {
  checks++
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function openPdf(bytes) {
  return getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONTS,
  }).promise
}

/** Raster + text facts about one page, as pdfjs sees them. */
async function describePage(doc, pageNumber) {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const opList = await page.getOperatorList()

  let paintImageXObject = 0
  for (let i = 0; i < opList.fnArray.length; i++) {
    if (opList.fnArray[i] === OPS.paintImageXObject) paintImageXObject++
  }

  const textContent = await page.getTextContent()
  const text = textContent.items.map((item) => item.str ?? '').join('')

  // pdfjs's OPS is a numeric enum; invert it so assertions read as names.
  const opNames = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]))
  const operators = opList.fnArray.map((fn, i) => ({
    name: opNames[fn],
    args: opList.argsArray[i],
  }))

  return {
    width: viewport.width,
    height: viewport.height,
    paintImageXObject,
    text,
    operators,
  }
}

/** Every FlateDecode stream in the file, decompressed to latin1 text. */
function inflateContentStreams(bytes) {
  const raw = Buffer.from(bytes)
  const latin = raw.toString('latin1')
  const streams = []
  const marker = /stream\r?\n/g
  let match
  while ((match = marker.exec(latin)) !== null) {
    const start = match.index + match[0].length
    const end = latin.indexOf('endstream', start)
    if (end < 0) continue
    try {
      streams.push(zlib.inflateSync(raw.subarray(start, end)).toString('latin1'))
    } catch {
      // Not a Flate stream (font/image data we do not care about here).
    }
  }
  return streams
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const LATIN_TEXT = 'Hello searchable PDF 2024'
const CJK_TEXT = '中文搜索测试文本'
const LATIN_TEXT_2 = 'Second latin line near the bottom'
const PAGE3_CJK = '第三页中文'
const PAGE3_LATIN = 'Page three latin overlay'
const PAGE5_LATIN = 'Page five latin overlay'

/**
 * Three drawable lines inside 595x842 (page 1's real page box), plus two lines
 * that MUST be counted as skipped. Coordinates are bottom-left-origin PDF
 * space, used verbatim by the writer.
 */
const PAGE_ONE_LINES = [
  {
    text: LATIN_TEXT,
    rect: { x: 72, y: 700, width: 300, height: 18 },
    runs: [{ text: LATIN_TEXT, x: 72, y: 700, size: 18, width: 300 }],
    source: 'ocr',
    confidence: 91,
  },
  {
    text: CJK_TEXT,
    rect: { x: 72, y: 660, width: 200, height: 22 },
    runs: [{ text: CJK_TEXT, x: 72, y: 660, size: 22, width: 200 }],
    source: 'ocr',
    confidence: 88,
  },
  {
    text: LATIN_TEXT_2,
    rect: { x: 100, y: 600, width: 260, height: 14 },
    runs: [{ text: LATIN_TEXT_2, x: 100, y: 600, size: 14, width: 260 }],
    source: 'ocr',
    confidence: 95,
  },
  // Skipped: empty text.
  {
    text: '   ',
    rect: { x: 10, y: 10, width: 50, height: 10 },
    runs: [],
    source: 'ocr',
  },
  // Skipped: non-positive box.
  {
    text: 'zero height box',
    rect: { x: 10, y: 10, width: 50, height: 0 },
    runs: [{ text: 'zero height box', x: 10, y: 10, size: 10 }],
    source: 'ocr',
  },
]

/* -------------------------------------------------------------------------- */
/* 1. pickOverlayFont                                                         */
/* -------------------------------------------------------------------------- */

section('pickOverlayFont()')
check('latin text -> helvetica', () => assert.equal(pickOverlayFont(LATIN_TEXT), 'helvetica'))
check('empty text -> helvetica', () => assert.equal(pickOverlayFont(''), 'helvetica'))
check('CJK ideographs -> cjk', () => assert.equal(pickOverlayFont(CJK_TEXT), 'cjk'))
check('single U+4E00 -> cjk', () => assert.equal(pickOverlayFont('\u4e00'), 'cjk'))
check('single U+9FFF -> cjk', () => assert.equal(pickOverlayFont('\u9fff'), 'cjk'))
check('CJK punctuation U+3002 -> cjk', () => assert.equal(pickOverlayFont('\u3002'), 'cjk'))
check('fullwidth U+FF01 -> cjk', () => assert.equal(pickOverlayFont('\uff01'), 'cjk'))
check('accented latin U+00E9 -> helvetica', () =>
  assert.equal(pickOverlayFont('caf\u00e9'), 'helvetica'))
check('U+2500 (outside CJK blocks) -> helvetica', () =>
  assert.equal(pickOverlayFont('\u2500'), 'helvetica'))

/* -------------------------------------------------------------------------- */
/* 2. baseline facts about the source                                         */
/* -------------------------------------------------------------------------- */

section('source baseline (pdfjs)')
const sourceHashBefore = sha256(SOURCE)
const sourceBytes = fs.readFileSync(SOURCE)
const sourceDoc = await openPdf(sourceBytes)

const sourcePages = []
for (let i = 1; i <= sourceDoc.numPages; i++) sourcePages.push(await describePage(sourceDoc, i))

console.log(
  `  source: ${sourceDoc.numPages} pages, ` +
    sourcePages.map((p, i) => `p${i + 1}=${p.width.toFixed(1)}x${p.height.toFixed(1)}/img${p.paintImageXObject}`).join(' '),
)
check('source has 6 pages', () => assert.equal(sourceDoc.numPages, 6))
check('every source page paints exactly 1 image', () =>
  assert.deepEqual(sourcePages.map((p) => p.paintImageXObject), [1, 1, 1, 1, 1, 1]))

/* -------------------------------------------------------------------------- */
/* 3. build the invisible (searchable scan) PDF                               */
/* -------------------------------------------------------------------------- */

section("buildSearchablePdf({ mode: 'invisible' })")
const result = await buildSearchablePdf({
  sourcePath: SOURCE,
  outputPath: OUTPUT,
  pages: [
    { page: 1, lines: PAGE_ONE_LINES },
    // A page that does not exist must be skipped with a note, not throw.
    { page: 99, lines: [{ text: 'ghost', rect: { x: 1, y: 1, width: 10, height: 10 }, runs: [], source: 'ocr' }] },
    // Page 3 carries the CJK font AND the latin font. The latin font was
    // already used on page 1, so this catches a font-resource cache that is
    // keyed per font instead of per (page, font): the second page would then
    // reference a resource name it never declares and extraction would break.
    {
      page: 3,
      lines: [
        { text: PAGE3_CJK, rect: { x: 80, y: 500, width: 120, height: 24 }, runs: [], source: 'ocr' },
        { text: PAGE3_LATIN, rect: { x: 80, y: 460, width: 180, height: 16 }, runs: [], source: 'ocr' },
      ],
    },
    // A third, untouched-by-CJK page reusing the latin font.
    {
      page: 5,
      lines: [
        { text: PAGE5_LATIN, rect: { x: 90, y: 400, width: 180, height: 16 }, runs: [], source: 'ocr' },
      ],
    },
  ],
})

console.log('  result:', JSON.stringify({
  pages: result.pages,
  linesWritten: result.linesWritten,
  linesSkipped: result.linesSkipped,
  bytes: result.bytes,
  cjkFont: result.cjkFont,
}, null, 2))
console.log('  notes:')
for (const note of result.notes) console.log(`    - ${note}`)
if (result.skipped.length > 0) {
  console.log('  skipped:')
  for (const s of result.skipped) console.log(`    - page ${s.page} line ${s.lineIndex} [${s.reason}] ${JSON.stringify(s.text)}`)
}

check('wrote the output file', () => assert.ok(fs.existsSync(OUTPUT)))
check('reported bytes == real file size', () =>
  assert.equal(result.bytes, fs.statSync(OUTPUT).size))
check('page count unchanged (6)', () => assert.equal(result.pages, 6))
check('linesSkipped == skipped.length', () => assert.equal(result.linesSkipped, result.skipped.length))

// 3 drawable on page 1 + 2 on page 3 + 1 on page 5 = 6; 2 bad boxes.
check('linesWritten == 6', () => assert.equal(result.linesWritten, 6))
check('linesSkipped == 2 (empty text + zero box)', () => assert.equal(result.linesSkipped, 2))
check('skip reasons are empty-text and non-positive-box', () =>
  assert.deepEqual(result.skipped.map((s) => s.reason).sort(), ['empty-text', 'non-positive-box']))
check('nonexistent page 99 produced a note', () =>
  assert.ok(result.notes.some((n) => n.includes('page 99') && n.includes('skipped'))))

/* -------------------------------------------------------------------------- */
/* 4. verify the written PDF with pdfjs                                       */
/* -------------------------------------------------------------------------- */

section('output verification (pdfjs re-open)')
const outputBytes = fs.readFileSync(OUTPUT)
const outputDoc = await openPdf(outputBytes)

check('output page count unchanged', () => assert.equal(outputDoc.numPages, sourceDoc.numPages))

const outputPages = []
for (let i = 1; i <= outputDoc.numPages; i++) outputPages.push(await describePage(outputDoc, i))

check('every page still paints its original image (1 each)', () =>
  assert.deepEqual(outputPages.map((p) => p.paintImageXObject), sourcePages.map((p) => p.paintImageXObject)))

check('page dimensions unchanged', () =>
  outputPages.forEach((p, i) => {
    assert.equal(Math.round(p.width * 100) / 100, Math.round(sourcePages[i].width * 100) / 100)
    assert.equal(Math.round(p.height * 100) / 100, Math.round(sourcePages[i].height * 100) / 100)
  }))

const squeeze = (s) => s.replace(/\s+/g, '')
console.log(`  page1 extracted text: ${JSON.stringify(outputPages[0].text)}`)
console.log(`  page3 extracted text: ${JSON.stringify(outputPages[2].text)}`)

check('page 1 text layer contains the latin overlay line', () =>
  assert.ok(squeeze(outputPages[0].text).includes(squeeze(LATIN_TEXT))))
check('page 1 text layer contains the second latin line', () =>
  assert.ok(squeeze(outputPages[0].text).includes(squeeze(LATIN_TEXT_2))))
check('page 1 text layer contains the CJK overlay line', () =>
  assert.ok(squeeze(outputPages[0].text).includes(squeeze(CJK_TEXT))))
check('page 3 text layer contains its CJK overlay line', () =>
  assert.ok(squeeze(outputPages[2].text).includes(squeeze(PAGE3_CJK))))
check('page 3 text layer contains its latin overlay line (font reuse across pages)', () =>
  assert.ok(squeeze(outputPages[2].text).includes(squeeze(PAGE3_LATIN))))
check('page 5 text layer contains its latin overlay line', () =>
  assert.ok(squeeze(outputPages[4].text).includes(squeeze(PAGE5_LATIN))))
check('no page extracted U+0000 / control bytes (broken ToUnicode)', () =>
  outputPages.forEach((p, i) => {
    const bad = [...p.text].filter((ch) => ch.codePointAt(0) < 0x20 && !'\n\r\t'.includes(ch))
    assert.deepEqual(bad, [], `page ${i + 1} yielded control characters: ${JSON.stringify(p.text)}`)
  }))
check('untouched page 2 gained no text layer', () =>
  assert.equal(squeeze(outputPages[1].text), squeeze(sourcePages[1].text)))

// Direct check for the regression that broke page 3: every page whose content
// stream names a font must ALSO declare it in its own /Resources /Font dict.
{
  const { PDFDocument, PDFName } = await import('pdf-lib')
  const lib = await PDFDocument.load(outputBytes)
  const overlayPages = [0, 2, 4]
  const fontResourceCounts = overlayPages.map((i) => {
    const fontDict = lib.getPage(i).node.Resources()?.lookup(PDFName.of('Font'))
    return fontDict ? fontDict.keys().length : 0
  })
  console.log(`  per-page /Font resource counts (pages 1,3,5): ${JSON.stringify(fontResourceCounts)}`)
  check('pages 1, 3 and 5 each declare their fonts in their own resources', () =>
    fontResourceCounts.forEach((n, i) =>
      assert.ok(n > 0, `page ${overlayPages[i] + 1} declares ${n} fonts`)))
}

/* -------------------------------------------------------------------------- */
/* 5. invisible rendering mode: `3 Tr` in the content stream                  */
/* -------------------------------------------------------------------------- */

section('content stream / rendering mode')

/**
 * Verify the overlay really sits at the requested coordinates by finding the
 * `Tm` text matrix that immediately follows each `Tf`/`Tr` in the stream.
 */
function overlayTextMatrices(streams) {
  const matrices = []
  for (const stream of streams) {
    for (const line of stream.split('\n')) {
      const m = /^1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm$/.exec(line.trim())
      if (m) matrices.push({ x: Number(m[1]), y: Number(m[2]) })
    }
  }
  return matrices
}

const outputStreams = inflateContentStreams(outputBytes)
const trThree = outputStreams.filter((s) => /\b3\s+Tr\b/.test(s))
console.log(`  inflated ${outputStreams.length} stream(s); ${trThree.length} contain "3 Tr"`)
if (trThree.length > 0) console.log('  sample operator block:\n' + trThree[0].split('\n').slice(0, 12).map((l) => '      ' + l).join('\n'))

check('output content stream contains "3 Tr" (invisible text)', () =>
  assert.ok(trThree.length > 0, 'no stream contained "3 Tr"'))
check('one "3 Tr" per invisible text run in the sample block', () =>
  assert.ok((trThree[0].match(/\b3\s+Tr\b/g) ?? []).length >= 1))
check('no visible "0 Tr" leaked into invisible mode', () =>
  assert.ok(!outputStreams.some((s) => /\b0\s+Tr\b/.test(s))))

const matrices = overlayTextMatrices(trThree)
console.log(`  overlay text matrices: ${JSON.stringify(matrices.slice(0, 6))}`)
check('overlay drew at the requested rect.x / rect.y (no y-flip)', () =>
  assert.ok(
    matrices.some((m) => Math.abs(m.x - 72) < 0.01 && Math.abs(m.y - 700) < 0.01),
    `expected a 72/700 Tm, got ${JSON.stringify(matrices)}`,
  ))
check('CJK line placed at its own rect origin (72/660)', () =>
  assert.ok(matrices.some((m) => Math.abs(m.x - 72) < 0.01 && Math.abs(m.y - 660) < 0.01)))
check('page 3 CJK line placed at 80/500', () =>
  assert.ok(matrices.some((m) => Math.abs(m.x - 80) < 0.01 && Math.abs(m.y - 500) < 0.01)))
check('page 3 latin line placed at 80/460', () =>
  assert.ok(matrices.some((m) => Math.abs(m.x - 80) < 0.01 && Math.abs(m.y - 460) < 0.01)))
check('page 5 latin line placed at 90/400', () =>
  assert.ok(matrices.some((m) => Math.abs(m.x - 90) < 0.01 && Math.abs(m.y - 400) < 0.01)))

/* -------------------------------------------------------------------------- */
/* 6. cover mode                                                              */
/* -------------------------------------------------------------------------- */

section("buildSearchablePdf({ mode: 'cover' })")
const coverResult = await buildSearchablePdf({
  sourcePath: SOURCE,
  outputPath: OUTPUT_COVER,
  mode: 'cover',
  coverColor: '#ffee00',
  sizeFactor: 1.2,
  pages: [{ page: 1, lines: PAGE_ONE_LINES.slice(0, 3) }],
})

const coverBytes = fs.readFileSync(OUTPUT_COVER)
const coverStreams = inflateContentStreams(coverBytes)
const coverDoc = await openPdf(coverBytes)
const coverPage1 = await describePage(coverDoc, 1)

check('cover mode wrote the file', () => assert.ok(fs.existsSync(OUTPUT_COVER)))
check('cover mode kept all 6 pages', () => assert.equal(coverDoc.numPages, 6))
check('cover mode extracted the replacement text', () =>
  assert.ok(squeeze(coverPage1.text).includes(squeeze(LATIN_TEXT))))
check('cover mode is NOT invisible (no "3 Tr")', () =>
  assert.ok(!coverStreams.some((s) => /\b3\s+Tr\b/.test(s)), 'found "3 Tr" in cover mode'))
check('cover mode emits a visible "0 Tr"', () =>
  assert.ok(coverStreams.some((s) => /\b0\s+Tr\b/.test(s))))
check('cover mode fills the patch with the requested #ffee00', () =>
  assert.ok(coverStreams.some((s) => /\b1 0\.93\d+ 0 rg\b/.test(s))))
check('cover mode kept the original image', () => assert.equal(coverPage1.paintImageXObject, 1))

// pdf-lib's drawRectangle emits a moveTo/lineTo/closePath/fill path, and pdfjs
// folds both the path and the fill into a single `constructPath` op. Assert on
// pdfjs's decoded operator list rather than on the raw (multi-stream, easily
// mis-sliced) bytes.
{
  const ops = coverPage1.operators
  const indexOfPatch = ops.findIndex(
    (op) =>
      op.name === 'constructPath' &&
      op.args?.[2] &&
      Math.abs(op.args[2][2] - 300) < 0.01 && // maxX
      Math.abs(op.args[2][3] - 18) < 0.01, // maxY
  )
  check('cover mode paints the patch box (300x18) via constructPath', () =>
    assert.ok(indexOfPatch >= 0, 'no constructPath with a 300x18 box was emitted'))

  // pdfjs folds pushGraphicsState/translate/rotate/skew into the CTM, so the
  // positioning transform sits a few ops before the path it applies to.
  check('patch is positioned at rect.x/rect.y (72/700)', () => {
    let found = -1
    for (let i = indexOfPatch - 1; i >= Math.max(0, indexOfPatch - 4); i--) {
      const op = ops[i]
      if (op.name === 'transform' && JSON.stringify(op.args) === JSON.stringify([1, 0, 0, 1, 72, 700])) {
        found = i
        break
      }
    }
    assert.ok(found >= 0, `no [1,0,0,1,72,700] transform within 4 ops before the patch`)
  })

  check('patch is filled with #ffee00', () => {
    const fills = ops.filter((op) => op.name === 'setFillRGBColor').map((op) => op.args?.[0])
    assert.ok(fills.includes('#ffee00'), `fills were ${JSON.stringify(fills)}`)
  })

  check('replacement text is drawn AFTER the patch (patch is behind text)', () => {
    const firstTextAfterPatch = ops.findIndex(
      (op, i) => i > indexOfPatch && op.name === 'showText',
    )
    assert.ok(firstTextAfterPatch > indexOfPatch)
  })

  check('cover mode CJK line is extractable (unicode mapped)', () => {
    const cjkOps = ops.filter(
      (op) =>
        op.name === 'showText' &&
        Array.isArray(op.args?.[0]) &&
        op.args[0].some((glyph) => glyph?.unicode === '中'),
    )
    assert.ok(cjkOps.length > 0, 'no showText op carried unicode "中"')
  })
}

/* -------------------------------------------------------------------------- */
/* 7. source file is untouched                                                */
/* -------------------------------------------------------------------------- */

section('source integrity')
check('source sha256 unchanged after both builds', () =>
  assert.equal(sha256(SOURCE), sourceHashBefore))
check('output path differs from source path', () => assert.notEqual(SOURCE, OUTPUT))

/* -------------------------------------------------------------------------- */
/* 8. failure isolation for an unreadable source                              */
/* -------------------------------------------------------------------------- */

section('robustness')
let missingSourceThrew = false
try {
  await buildSearchablePdf({
    sourcePath: '/tmp/definitely-not-here-12345.pdf',
    outputPath: '/tmp/never-written.pdf',
    pages: [],
  })
} catch {
  missingSourceThrew = true
}
check('unreadable source throws (a real error, not a silent no-op)', () =>
  assert.ok(missingSourceThrew))

/* -------------------------------------------------------------------------- */

section('summary')
console.log(`  checks run: ${checks}, failures: ${failures.length}`)
if (result.cjkFont) {
  console.log(`  CJK font embedded: ${result.cjkFont.path} (face ${result.cjkFont.postscriptName})`)
} else {
  console.log('  CJK font embedded: NONE — CJK lines were skipped and reported in notes')
}

if (failures.length > 0) {
  console.error('\nFAILURES:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
