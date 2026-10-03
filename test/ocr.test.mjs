#!/usr/bin/env node
/**
 * Verification harness for src/core/ocr.ts — run with plain Node:
 *
 *   node test/ocr.test.mjs
 *
 * Transpile approach: none. Node 26 runs TypeScript directly via built-in
 * type stripping (the `--experimental-strip-types` behaviour, on by default
 * since Node 23.6), so `import '../src/core/ocr.ts'` works as-is. No build
 * step, no loader, no new dependency.
 *
 * What this proves, against the real scanned exam paper:
 *   1. the tesseract worker script actually spawned is the NODE script
 *      (`src/worker-script/node/index.js`), not the browser bundle — captured
 *      by wrapping `worker_threads.Worker`, which is what tesseract spawns;
 *   2. `worker.recognize(img)` returns `blocks: null`, while
 *      `worker.recognize(img, {}, { blocks: true })` returns real blocks;
 *   3. >= 20 lines come back from page 1 with rects in PDF points that all
 *      sit inside the page box, and the y-flip points the right way;
 *   4. CJK spacing is cleaned without touching latin words;
 *   5. a blank page yields the empty, non-throwing result;
 *   6. the low-confidence note fires on the noisy page 4, and `minConfidence`
 *      drops the shaky lines it is supposed to drop.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

const PDF_PATH = '/Users/Zhuanz/dsh-pdf-maker/demo/source/ceshi.pdf'
const LANG_PATH = '/Users/Zhuanz/dsh-pdf-maker/assets/tessdata'
const SCALE = 2
const TESS_PKG = require.resolve('tesseract.js/package.json')
const WORKER_PATH = join(dirname(TESS_PKG), 'src', 'worker-script', 'node', 'index.js')
/** CJK-space-CJK: the pattern the cleanup must leave nowhere behind. */
const CJK_SPACE_CJK =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF][ \u3000][\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

const section = (title) => console.log(`\n=== ${title} ===`)
const check = (label) => console.log(`  ok  ${label}`)

// ---------------------------------------------------------------------------
// Capture the exact worker script tesseract spawns.
// tesseract.js node spawns `new worker_threads.Worker(workerPath)`; wrapping
// the class before anything requires tesseract.js makes the path observable.
// ---------------------------------------------------------------------------
const workerThreads = require('node:worker_threads')
const OriginalWorker = workerThreads.Worker
const spawnedWorkers = []
workerThreads.Worker = class RecordingWorker extends OriginalWorker {
  constructor(filename, options) {
    spawnedWorkers.push(String(filename))
    super(filename, options)
  }
}

section('0. environment')
console.log(`  node           ${process.version}`)
console.log(`  transpile      built-in type stripping (no flag needed on Node 26)`)
console.log(`  workerPath     ${WORKER_PATH}`)
console.log(`  langPath       ${LANG_PATH}`)
assert.equal(WORKER_PATH.endsWith(join('src', 'worker-script', 'node', 'index.js')), true)
assert.equal(WORKER_PATH.includes('worker.min.js'), false)
check('resolved worker script is the node worker, not the browser bundle')

// pdf.js, used to render page 1 and to learn the page box in points.
const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
pdfjsLib.GlobalWorkerOptions.workerSrc =
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
const { createCanvas } = await import('@napi-rs/canvas')

const pdfjs = await pdfjsLib.getDocument({ url: PDF_PATH, verbosity: 0 }).promise
const page1 = await pdfjs.getPage(1)
const pageBox = page1.getViewport({ scale: 1 })
const PAGE_W = pageBox.width
const PAGE_H = pageBox.height
console.log(`  pdf            ${PDF_PATH}`)
console.log(`  page 1 box     ${PAGE_W} x ${PAGE_H} pt (scale 1)`)

// ---------------------------------------------------------------------------
// 1. Contract run through the session API.
// ---------------------------------------------------------------------------
const { createOcrSession, ocrPage } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'core', 'ocr.ts')).href
)

section('1. createOcrSession + run(page 1)')
const session = await createOcrSession({ doc: pdfjs, scale: SCALE, lang: 'chi_sim', langPath: LANG_PATH })
const t0 = Date.now()
const result = await session.run(1)
const totalMs = Date.now() - t0

console.log(`  page           ${result.page}`)
console.log(`  lines          ${result.lines.length}`)
console.log(`  confidence     ${result.confidence}`)
console.log(`  elapsedMs      ${result.elapsedMs} (recognize only; ${totalMs} ms incl. render)`)
console.log(`  notes          ${JSON.stringify(result.notes)}`)

assert.ok(result.lines.length >= 20, `expected >= 20 lines, got ${result.lines.length}`)
assert.equal(result.page, 1)
assert.ok(result.elapsedMs > 0, 'elapsedMs must be positive')
assert.ok(result.confidence > 0 && result.confidence <= 100, 'confidence in (0,100]')
check(`${result.lines.length} lines (>= 20)`)

section('2. first 8 lines — rect in PDF points (bottom-left origin)')
for (const [i, line] of result.lines.slice(0, 8).entries()) {
  const r = line.rect
  const f = (n) => n.toFixed(2).padStart(8)
  console.log(
    `  ${String(i).padStart(2)} conf=${String(line.confidence).padStart(3)}`
    + ` rect=(${f(r.x)}, ${f(r.y)}, ${f(r.width)}, ${f(r.height)})`
    + ` size=${line.runs[0].size.toFixed(1)}`
    + ` baselineY=${line.runs[0].y.toFixed(2)}`
    + ` ${JSON.stringify(line.text)}`,
  )
}

section('3. geometry invariants')
for (const [i, line] of result.lines.entries()) {
  const r = line.rect
  const why = `line ${i} ${JSON.stringify(line.text)}`
  assert.ok(r.x >= 0, `rect.x < 0 on ${why}`)
  assert.ok(r.y >= 0, `rect.y < 0 on ${why}`)
  assert.ok(r.x <= PAGE_W, `rect.x > pageWidth on ${why}`)
  assert.ok(r.y <= PAGE_H, `rect.y > pageHeight on ${why}`)
  assert.ok(r.x + r.width <= PAGE_W + 0.5, `rect right edge off page on ${why}`)
  assert.ok(r.height > 0 && r.width > 0, `non-positive box on ${why}`)
  assert.equal(line.source, 'ocr', `source must be 'ocr' on ${why}`)
  assert.equal(line.runs.length, 1, `expected a single run on ${why}`)
  const run = line.runs[0]
  assert.equal(run.text, line.text, `run text != line text on ${why}`)
  assert.equal(run.x, r.x, `run.x must be the line's left edge on ${why}`)
  assert.ok(
    Math.abs(run.size - r.height * 0.8) < 1e-6,
    `size should be height * 0.8 on ${why}`,
  )
  assert.ok(
    run.y >= r.y - 3 && run.y <= r.y + r.height + 3,
    `baseline y ${run.y} outside box [${r.y}, ${r.y + r.height}] on ${why}`,
  )
}
check(`all ${result.lines.length} rects inside [0, ${PAGE_W}] x [0, ${PAGE_H}]`)

// The y-flip direction check: OCR emits lines top-to-bottom, PDF y grows up,
// so the first line must have a LARGER y than the last, and the header must
// sit in the upper half of the page.
const first = result.lines[0]
const last = result.lines[result.lines.length - 1]
assert.ok(first.rect.y > PAGE_H / 2, `first line should be in the upper half, y=${first.rect.y}`)
assert.ok(last.rect.y < PAGE_H / 2, `last line should be in the lower half, y=${last.rect.y}`)
assert.ok(first.rect.y > last.rect.y, 'y must decrease down the page')
console.log(`  first line y=${first.rect.y.toFixed(2)} > last line y=${last.rect.y.toFixed(2)}  (upper-half header, lower-half footer)`)
check('y-flip orientation: top of page has larger PDF y')

section('4. CJK spacing cleanup vs latin text')
const joined = result.lines.map((l) => l.text).join('\n')
assert.ok(joined.includes('笔试'), 'expected "笔试" with the tesseract spaces removed')
const stillSpaced = result.lines.find((l) => CJK_SPACE_CJK.test(l.text))
assert.equal(stillSpaced, undefined, `CJK still contains inserted spaces: ${stillSpaced?.text}`)
const latinLine = result.lines.find((l) => /A\.stick/.test(l.text))
assert.ok(latinLine, 'expected the "A.stick" option line to survive')
console.log(`  latin line     ${JSON.stringify(latinLine.text)}`)
assert.ok(/A\.stick[B ]/.test(latinLine.text), 'latin word "A.stick" must not be glued to its neighbour')
check('CJK spaces removed, spaces between latin words preserved')

section('5. worker script captured at spawn time')
const tesseractSpawns = spawnedWorkers.filter((p) => p.includes('tesseract.js'))
for (const p of spawnedWorkers) console.log(`  spawned        ${p}`)
assert.ok(tesseractSpawns.length >= 1, 'tesseract never spawned a worker thread')
for (const p of tesseractSpawns) {
  assert.equal(p, WORKER_PATH, `wrong worker script spawned: ${p}`)
  assert.equal(p.includes('worker.min.js'), false)
}
check(`tesseract spawned the node worker (${tesseractSpawns.length} time(s)); no addEventListener crash`)

await session.dispose()
assert.equal(pdfjs.numPages, 6, 'session.dispose() must not destroy a borrowed document')
check('dispose() terminated the worker and left the borrowed document alive')

// ---------------------------------------------------------------------------
// 6. The `{ blocks: true }` flag: A/B on the same rendered page.
// ---------------------------------------------------------------------------
section('6. blocks flag A/B (direct tesseract, same PNG)')
const viewport = page1.getViewport({ scale: SCALE })
const canvas = createCanvas(viewport.width, viewport.height)
await page1.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
const png = canvas.toBuffer('image/png')
console.log(`  png            ${png.length} bytes at ${viewport.width.toFixed(0)}x${viewport.height.toFixed(0)} px`)

const Tesseract = require('tesseract.js')
const probe = await Tesseract.createWorker('chi_sim', Tesseract.OEM.LSTM_ONLY, {
  workerPath: WORKER_PATH,
  langPath: LANG_PATH,
  cacheMethod: 'none',
})
const withoutFlag = await probe.recognize(png)
const withFlag = await probe.recognize(png, {}, { blocks: true, text: true })
const flagLines = (withFlag.data.blocks ?? []).flatMap(
  (b) => (b.paragraphs ?? []).flatMap((p) => p.lines ?? []),
)
console.log(`  recognize(png)                        -> blocks=${JSON.stringify(withoutFlag.data.blocks)}, text chars=${withoutFlag.data.text?.length ?? 0}`)
console.log(`  recognize(png, {}, { blocks: true })  -> blocks=${withFlag.data.blocks?.length ?? null}, lines=${flagLines.length}`)
assert.equal(withoutFlag.data.blocks, null, 'without the flag blocks should be null')
assert.ok((withFlag.data.blocks?.length ?? 0) > 0, 'with the flag blocks must be non-zero')
assert.ok(flagLines.length >= 20, 'with the flag the hierarchy must contain lines')
check(`blocks: null without the flag, ${withFlag.data.blocks.length} block(s)/${flagLines.length} lines with it`)
await probe.terminate()

// ---------------------------------------------------------------------------
// 7. A page with no text must not throw.
// ---------------------------------------------------------------------------
section('7. blank page -> no text detected')
const { PDFDocument } = require('pdf-lib')
const blank = await PDFDocument.create()
blank.addPage([PAGE_W, PAGE_H])
const blankBytes = await blank.save()
const blankResult = await ocrPage(blankBytes, 1, { scale: SCALE, langPath: LANG_PATH })
console.log(`  lines=${blankResult.lines.length} confidence=${blankResult.confidence} notes=${JSON.stringify(blankResult.notes)}`)
assert.deepEqual(blankResult.lines, [])
assert.equal(blankResult.confidence, 0)
assert.ok(blankResult.notes.includes('no text detected'))
check('blank page returned an empty result instead of throwing')

// ---------------------------------------------------------------------------
// 8. The low-confidence warning actually fires (page 4 is the noisy one).
// ---------------------------------------------------------------------------
section('8. low-confidence page note')
const lowSession = await createOcrSession({ doc: pdfjs, scale: SCALE, langPath: LANG_PATH })
const page4 = await lowSession.run(4)
await lowSession.dispose()
console.log(`  page 4         lines=${page4.lines.length} confidence=${page4.confidence}`)
console.log(`  notes          ${JSON.stringify(page4.notes)}`)
assert.ok(page4.confidence < 70, `page 4 should be low confidence, got ${page4.confidence}`)
assert.ok(
  page4.notes.some((n) => n.includes('low mean OCR confidence') && n.includes('page 4')),
  'expected a page-4 low-confidence note',
)
check('page 4 flagged with a human-readable low-confidence note naming the page')

// ---------------------------------------------------------------------------
// 9. minConfidence removes lines below the threshold.
// ---------------------------------------------------------------------------
section('9. minConfidence filtering (page 1, threshold 60)')
const strictSession = await createOcrSession({
  doc: pdfjs,
  scale: SCALE,
  langPath: LANG_PATH,
  minConfidence: 60,
})
const strict = await strictSession.run(1)
await strictSession.dispose()
console.log(`  lines          ${strict.lines.length} (was ${result.lines.length} unfiltered)`)
console.log(`  confidence     ${strict.confidence} (was ${result.confidence})`)
assert.ok(strict.lines.length < result.lines.length, 'minConfidence 60 should drop lines')
assert.ok(strict.lines.every((l) => l.confidence >= 60), 'no line below the threshold may survive')
assert.ok(strict.confidence > result.confidence, 'mean over surviving lines should rise')
check(`minConfidence 60 dropped ${result.lines.length - strict.lines.length} shaky lines and raised the mean`)

await pdfjs.loadingTask.destroy()

section('summary')
console.log(`  page 1: ${result.lines.length} lines, mean confidence ${result.confidence}, ${result.elapsedMs} ms recognize`)
console.log(`  notes : ${JSON.stringify(result.notes)}`)
console.log('  ALL CHECKS PASSED')
