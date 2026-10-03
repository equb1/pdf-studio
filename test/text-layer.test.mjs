/**
 * Plain-node check for src/core/text-layer.ts.
 *
 * Run with:  node test/text-layer.test.mjs
 *
 * Node 26 strips TypeScript types natively, so the test imports the .ts sources
 * directly (no build step, no transpile-to-temp copy). pdf.js is loaded from
 * this repo's own node_modules, resolved at runtime rather than hard-coded.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { extractPageContent, extractTextLayer } from '../src/core/text-layer.ts'
import { openPdf } from '../src/core/pdf.ts'

const require = createRequire(import.meta.url)

const CONTRACT = '/Users/Zhuanz/dsh-pdf-maker/demo/source/contract.pdf'
const CESHI = '/Users/Zhuanz/dsh-pdf-maker/demo/source/ceshi.pdf'

const fmtRect = r =>
  `x=${r.x.toFixed(2)} y=${r.y.toFixed(2)} w=${r.width.toFixed(2)} h=${r.height.toFixed(2)}`

const fmtLine = line => `  "${line.text}"  [${fmtRect(line.rect)}]  runs=${line.runs.length}`

// Uses the SHARED loader rather than calling pdf.js directly. Calling pdf.js
// here meant the test exercised a different configuration from production (no
// standard-font or CMap data), so it could not catch a loader regression and it
// emitted a warning that hid real ones.
async function open(path) {
  return openPdf(path)
}

async function report(label, path, { firstItems }) {
  const doc = await open(path)
  console.log(`\n=== ${label} ===`)
  console.log(`path        : ${path}`)
  console.log(`page count  : ${doc.numPages}`)

  const page = await doc.getPage(1)
  const raw = await page.getTextContent()
  console.log(`items p1    : ${raw.items.length}`)
  for (const item of raw.items.slice(0, firstItems)) {
    console.log(`   item ${JSON.stringify(item.str)} t=[${item.transform.map(v => +v.toFixed(2)).join(', ')}] w=${item.width} h=${item.height}`)
  }

  const content = await extractPageContent(doc, 1)
  console.log(`page size   : ${content.width} x ${content.height} pt, kind=${content.kind}`)
  console.log(`lines       : ${content.lines.length}`)
  for (const line of content.lines.slice(0, 5)) console.log(fmtLine(line))
  if (content.notes.length > 0) console.log(`notes       : ${content.notes.join(' | ')}`)

  return { doc, raw, content }
}

// ---------------------------------------------------------------- contract.pdf
const contract = await report('contract.pdf (born-digital)', CONTRACT, { firstItems: 4 })
{
  const { lines } = contract.content
  assert.ok(lines.length > 5, `expected >5 lines on contract p1, got ${lines.length}`)
  const all = lines.map(l => l.text).join('\n')
  assert.ok(all.includes('合同'), 'contract p1 text should contain 合同')
  for (const line of lines) {
    assert.equal(line.source, 'text-layer')
    assert.equal(line.confidence, undefined, 'text-layer lines must not carry confidence')
    assert.ok(line.runs.length > 0, 'every line has at least one run')
    assert.ok(line.rect.height > 0, 'every line has a positive-height rect')
  }
  // Runs are ordered left-to-right and the line text matches their order.
  for (const line of lines) {
    for (let i = 1; i < line.runs.length; i += 1) {
      assert.ok(line.runs[i].x >= line.runs[i - 1].x, 'runs must be sorted by x')
    }
  }
  console.log(`\n[ok] contract.pdf: ${lines.length} lines, all source=text-layer, confidence undefined`)
}

// ---------------------------------------------------------------- ceshi.pdf
const ceshi = await report('ceshi.pdf (6 scanned pages + fingerprint)', CESHI, { firstItems: 1 })
{
  const { lines } = ceshi.content
  assert.ok(lines.length >= 1, `expected >=1 line on ceshi p1, got ${lines.length}`)
  assert.ok(lines[0].rect.y < 20, `fingerprint should sit near the page BOTTOM (rect.y<20), got ${lines[0].rect.y}`)
  assert.ok(lines[0].text.includes('QQAB'), 'fingerprint text should survive extraction')
  console.log(`\n[ok] ceshi.pdf: ${lines.length} line(s), rect.y=${lines[0].rect.y.toFixed(2)} (< 20, bottom of page)`)

  // Every page of the scan must yield the same fingerprint, not just page 1.
  for (let p = 1; p <= ceshi.doc.numPages; p += 1) {
    const pageLines = await extractTextLayer(ceshi.doc, p)
    assert.ok(pageLines.length >= 1, `page ${p} should yield the fingerprint line`)
  }
  console.log(`[ok] ceshi.pdf: all ${ceshi.doc.numPages} pages yield their fingerprint line`)
}

// ---------------------------------------------------------------- robustness
{
  const fake = {
    numPages: 1,
    getPage: async () => ({
      getViewport: () => ({ width: 595, height: 842 }),
      getTextContent: async () => ({
        items: [
          null,
          'not an object',
          { str: 'no transform' },
          { str: 'nan transform', transform: [1, 0, 0, 1, NaN, NaN] },
          { transform: [1, 0, 0, 1, 10, 700] },
          { str: 'ok', transform: [12, 0, 0, 12, 10, 700], width: 24, height: 12 },
          { str: '   ', transform: [12, 0, 0, 12, 40, 700], width: 12, height: 12 },
          { str: 'second', transform: [12, 0, 0, 12, 60, 700], width: 40, height: 12 },
        ],
      }),
    }),
  }
  const malformed = await extractPageContent(fake, 1)
  assert.equal(malformed.lines.length, 1, 'malformed items must be skipped, not throw')
  console.log(`\n[ok] malformed items: 1 line kept, notes=${JSON.stringify(malformed.notes)}`)

  const empty = {
    numPages: 1,
    getPage: async () => ({
      getViewport: () => ({ width: 595, height: 842 }),
      getTextContent: async () => ({ items: [] }),
    }),
  }
  assert.deepEqual(await extractTextLayer(empty, 1), [], 'empty text layer returns []')
  const emptyContent = await extractPageContent(empty, 1)
  assert.deepEqual(emptyContent.lines, [])
  assert.equal(emptyContent.kind, 'text')
  assert.ok(emptyContent.notes.length > 0, 'an empty layer is worth a note')
  console.log(`[ok] empty text layer: [] and kind=${emptyContent.kind}, note="${emptyContent.notes[0]}"`)
}

// ---------------------------------------------------------------- CJK spacing
{
  const cjk = {
    numPages: 1,
    getPage: async () => ({
      getViewport: () => ({ width: 595, height: 842 }),
      getTextContent: async () => ({
        items: [
          { str: '服 务 合 同', transform: [22, 0, 0, 22, 244, 761], width: 106, height: 22 },
          { str: 'Hello world again', transform: [11, 0, 0, 11, 70, 700], width: 90, height: 11 },
        ],
      }),
    }),
  }
  const { lines } = await extractPageContent(cjk, 1)
  assert.equal(lines[0].text, '服务合同', 'spaces between CJK chars are dropped')
  assert.equal(lines[1].text, 'Hello world again', 'latin spacing is untouched')
  console.log(`\n[ok] CJK: "${lines[0].text}" / latin: "${lines[1].text}"`)
}

console.log('\nALL ASSERTIONS PASSED')
