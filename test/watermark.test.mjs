/**
 * Watermark tests.
 *
 * Three claims are checked, in the order that matters to a user:
 *
 *   1. **adding** produces a file that actually looks different;
 *   2. **scanning** finds what was added, with a confidence that reflects how
 *      sure the detector can honestly be;
 *   3. **removing** restores the page to what it was — proven by pixels, not by
 *      the absence of an error.
 *
 * The negative cases matter as much as the positive ones: a detector that
 * reports a mark when there is none, or a remover that claims success on an
 * ambiguous candidate, is worse than one that refuses.
 *
 * Run: node --experimental-strip-types test/watermark.test.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { addWatermark, removeWatermarks, scanWatermarks, WATERMARK_MARKER } from '../src/core/watermark.ts'

const require = createRequire(import.meta.url)
const { PDFDocument } = require('pdf-lib')

const SOURCE = '/Users/Zhuanz/dsh-pdf-maker/demo/source/contract.pdf'
const MARKED = '/tmp/pdf-studio-watermarked.pdf'
const CLEANED = '/tmp/pdf-studio-watermark-removed.pdf'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Render page 1 and return its pixels, for before/after comparison. */
async function renderPage1(bytes) {
  const pdfjs = await import('../node_modules/pdfjs-dist/legacy/build/pdf.mjs')
  const { createCanvas } = require('@napi-rs/canvas')
  pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise
  const page = await doc.getPage(1)
  const viewport = page.getViewport({ scale: 2 })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const context = canvas.getContext('2d')
  context.fillStyle = 'white'
  context.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: context, viewport }).promise
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

/** Count pixels that differ beyond a tolerance (rendering noise). */
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

console.log('watermarks\n')

const original = new Uint8Array(await readFile(SOURCE))
const originalHash = sha256(original)

// ── a clean document must have no candidates ────────────────────────────────

{
  const scan = await scanWatermarks(original)
  check('a clean document yields no watermark candidates', scan.candidates.length === 0,
    JSON.stringify(scan.candidates.map(c => c.detail)))
  check('scanning reports the page count', scan.pages === 1, String(scan.pages))
}

// ── add ─────────────────────────────────────────────────────────────────────

const added = await addWatermark(original, {
  text: '内部资料 请勿外传',
  placement: 'tile',
  opacity: 0.18,
  fontSize: 44,
})

check('adding succeeded and returned bytes', added.bytes.length > 0, `${(added.bytes.length / 1024).toFixed(0)}KB`)
check('the add reports which pages were stamped', added.result.pages === 1, String(added.result.pages))
check('the add records the XObject identity for later matching',
  added.result.xobjectName === WATERMARK_MARKER, added.result.xobjectName)
check('the source bytes were not modified', sha256(original) === originalHash)

await writeFile(MARKED, added.bytes)

// The mark must be VISIBLE — a watermark nobody can see is a bug, not a feature.
{
  const before = await renderPage1(original)
  const after = await renderPage1(added.bytes)
  const changed = diffCount(before, after)
  check('the watermark visibly changes the page', changed > 2000, `${changed} pixels differ`)
}

// ── scan finds it, with high confidence ─────────────────────────────────────

const scanMarked = await scanWatermarks(added.bytes)
check('the scan finds the added watermark', scanMarked.candidates.length >= 1,
  `${scanMarked.candidates.length} candidate(s)`)
const named = scanMarked.candidates.find(candidate => candidate.reason === 'named-xobject')
check('it is identified by the recorded XObject name', named !== undefined, JSON.stringify(scanMarked.candidates[0]))
check('a named watermark is reported with full confidence', named?.confidence === 1, String(named?.confidence))
check('the candidate names the XObject to remove', named?.xobjectName === WATERMARK_MARKER, String(named?.xobjectName))

// ── removal must be exact, and must restore the page ────────────────────────

{
  const dry = await removeWatermarks(added.bytes, { dryRun: true })
  check('a dry run reports what it WOULD remove', dry.removed.length >= 1, `${dry.removed.length}`)
  check('a dry run does not change the bytes', dry.bytes === added.bytes || sha256(dry.bytes) === sha256(added.bytes))

  const applied = await removeWatermarks(added.bytes, { minConfidence: 0.9, dryRun: false })
  check('removal reports the marks it removed', applied.removed.length >= 1, `${applied.removed.length}`)
  await writeFile(CLEANED, applied.bytes)

  const scanAfter = await scanWatermarks(applied.bytes)
  check('the watermark is gone from a re-scan', scanAfter.candidates.length === 0,
    JSON.stringify(scanAfter.candidates.map(c => c.reason)))

  const beforePixels = await renderPage1(original)
  const cleanedPixels = await renderPage1(applied.bytes)
  const residual = diffCount(beforePixels, cleanedPixels)
  check('the cleaned page matches the original render', residual < 500,
    `${residual} pixels still differ`)
}

// ── the removed file must still be readable ────────────────────────────────

{
  const pdfjs = await import('../node_modules/pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(CLEANED)) }).promise
  const page = await doc.getPage(1)
  const content = await page.getTextContent()
  const text = content.items.filter(item => typeof item.str === 'string').map(item => item.str).join('')
  check('the contract text survives watermark removal', text.replace(/\s+/g, '').includes('服务合同'),
    JSON.stringify(text.slice(0, 40)))
  check('removal did not add the watermark text to the extractable layer',
    !text.includes('内部资料'), 'watermark text leaked into the text layer')
}

// ── centre placement and image marks ───────────────────────────────────────

{
  const centred = await addWatermark(original, {
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
    JSON.stringify(scanCentred.candidates.map(c => c.reason)))
}

// ── the honest refusal paths ───────────────────────────────────────────────

{
  // A page of ordinary text with no XObject: the detector must offer nothing
  // and must say why, rather than reporting a confident empty result.
  const scan = await scanWatermarks(original)
  check('a document with no removable mark produces a refusal explanation',
    scan.candidates.length === 0 && scan.refused.length >= 1,
    JSON.stringify(scan.refused))

  // A low-confidence candidate must be EXCLUDED by the default threshold, so a
  // caller that does not pass one cannot accidentally delete real content.
  const defaultRun = await removeWatermarks(original, { dryRun: false })
  check('the default threshold removes nothing from a clean document',
    defaultRun.removed.length === 0 && sha256(defaultRun.bytes) === sha256(original))
}

console.log(`\n${failed === 0 ? 'ALL WATERMARK CHECKS PASSED' : failed + ' check(s) FAILED'}`)
if (failed > 0) process.exitCode = 1
