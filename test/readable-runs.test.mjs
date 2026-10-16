/**
 * Readable-run model tests: decode a page's runs into text.
 *
 * The load-bearing assertion is a CROSS-CHECK: the text decoded through the
 * fonts' own `ToUnicode` CMaps must match what pdf.js extracts from the same
 * page. Decoding glyph ids is exactly the kind of thing that can look right on
 * a hand-picked example while being wrong for the other fonts on the page, so
 * the whole page is compared, not one run.
 *
 * Run: node --experimental-strip-types test/readable-runs.test.mjs
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { listReadableRuns, readPageContentStreams } from '../src/core/text-editor.ts'
import { readPageFonts, widthOfCode } from '../src/core/font-map.ts'
import { makeDecoder, parseToUnicodeCMap, decodeGlyphOperand } from '../src/core/tounicode.ts'

const require = createRequire(import.meta.url)
const { PDFDocument } = require('pdf-lib')

const SOURCE = fileURLToPath(new URL('./fixtures/contract.pdf', import.meta.url))

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

/** Normalise whitespace so CJK spacing differences do not hide real mismatches. */
const squash = text => text.replace(/\s+/g, '')

console.log('readable runs\n')

// ── CMap parser on synthetic input ──────────────────────────────────────────

{
  // Both bfrange forms, plus bfchar, plus a 1-byte codespace.
  const cmap = `
/CIDInit /ProcSet findresource begin
begincmap
1 begincodespacerange
<00><FF>
endcodespacerange
2 beginbfchar
<41> <0041>
<42> <0042>
endbfchar
2 beginbfrange
<43> <45> <0043>
<50> <51> [<0058> <0059>]
endbfrange
endcmap
`
  const decoder = makeDecoder(parseToUnicodeCMap(cmap))
  check('bfchar entries decode', decoder.decodeCode(0x41) === 'A' && decoder.decodeCode(0x42) === 'B')
  check('a bfrange advances along its destination', decoder.decodeCode(0x43) === 'C' && decoder.decodeCode(0x45) === 'E')
  check('an array-form bfrange maps each code', decoder.decodeCode(0x50) === 'X' && decoder.decodeCode(0x51) === 'Y')
  check('a 1-byte codespace range is honoured', decoder.map.codeBytes === 1, String(decoder.map.codeBytes))
  check('an unmapped code decodes to nothing rather than throwing', decoder.decodeCode(0x99) === '')
}

{
  // A 2-byte codespace (the Identity-H case) must consume two bytes per code.
  const cmap = `1 begincodespacerange
<0000><FFFF>
endcodespacerange
1 beginbfchar
<0001> <4E2D>
endbfchar`
  const decoder = makeDecoder(parseToUnicodeCMap(cmap))
  check('a 2-byte codespace is honoured', decoder.map.codeBytes === 2, String(decoder.map.codeBytes))
  check('decodeGlyphOperand reads a hex operand', decodeGlyphOperand('<0001>', decoder) === '中',
    decodeGlyphOperand('<0001>', decoder))
  const two = new Uint8Array([0x00, 0x01, 0x00, 0x01])
  check('decodeBytes walks the operand at code width', decoder.decodeBytes(two) === '中中', decoder.decodeBytes(two))
}

// ── the real page ───────────────────────────────────────────────────────────

const doc = await PDFDocument.load(await readFile(SOURCE))
const page = doc.getPages()[0]
const fonts = readPageFonts(doc.context, page)
const streams = readPageContentStreams(page, doc.context)
const runs = listReadableRuns(streams, fonts)

check('every font on the page was read', fonts.size === 13, String(fonts.size))
check(
  'every font carries a usable ToUnicode decoder',
  [...fonts.values()].every(info => info.decoder !== undefined),
  [...fonts.values()].filter(info => info.decoder === undefined).map(info => info.resourceName).join(',') || 'all ok',
)
check('the page yielded its runs', runs.length === 13, `${runs.length} runs`)
check('every run decoded to text', runs.every(run => run.text !== undefined && run.text !== ''),
  runs.filter(run => run.text === undefined).map(run => `${run.id}:${run.textUnavailable}`).join(',') || 'all ok')

const byId = new Map(runs.map(run => [run.id, run]))
const title = byId.get('1:6')
check('the title decodes to the contract heading', squash(title?.text ?? '') === '服务合同', JSON.stringify(title?.text))
check('the title carries its measured width', (title?.widthPt ?? 0) > 50 && (title?.widthPt ?? 0) < 200,
  `${title?.widthPt?.toFixed(1)}pt`)

const footer = byId.get('3:6')
check('the footer decodes across both of its glyph strings',
  squash(footer?.text ?? '').includes('法务终审') && squash(footer?.text ?? '').includes('同意盖章签署'),
  JSON.stringify(footer?.text))

// Widths must be self-consistent: a longer run should not measure narrower than
// a clearly smaller one at the same size.
const clause = byId.get('1:96')
check('a long clause measures wider than the title at the same scale',
  (clause?.widthPt ?? 0) > (title?.widthPt ?? 0) * 2,
  `clause ${clause?.widthPt?.toFixed(1)}pt vs title ${title?.widthPt?.toFixed(1)}pt`)

// ── cross-check against pdf.js ──────────────────────────────────────────────

{
  const pdfjs = await import('../node_modules/pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(SOURCE))
  const pdfjsDoc = await pdfjs.getDocument({ data }).promise
  const pdfjsPage = await pdfjsDoc.getPage(1)
  const content = await pdfjsPage.getTextContent()
  const reference = content.items
    .filter(item => typeof item.str === 'string')
    .map(item => item.str)
    .join('')

  const ours = runs.map(run => run.text ?? '').join('')

  // Compare as multisets of non-space characters: reading order can differ
  // between a content-stream walk and pdf.js's own ordering, but the CHARACTER
  // INVENTORY must agree exactly. A wrong CMap would show up immediately as
  // missing or extra characters.
  const inventory = text => {
    const counts = new Map()
    for (const char of squash(text)) counts.set(char, (counts.get(char) ?? 0) + 1)
    return counts
  }
  const oursCounts = inventory(ours)
  const referenceCounts = inventory(reference)

  const missing = []
  for (const [char, count] of referenceCounts) {
    const have = oursCounts.get(char) ?? 0
    if (have !== count) missing.push(`${char}: ours=${have} pdfjs=${count}`)
  }
  const extra = []
  for (const [char, count] of oursCounts) {
    if (!referenceCounts.has(char)) extra.push(`${char} x${count}`)
  }

  check('decoded character inventory matches pdf.js exactly',
    missing.length === 0 && extra.length === 0,
    (missing.length + extra.length) === 0
      ? `${referenceCounts.size} distinct characters agree`
      : `missing/differing: ${missing.join(', ')} | extra: ${extra.join(', ')}`)

  check('decoded character count matches pdf.js',
    squash(ours).length === squash(reference).length,
    `ours=${squash(ours).length} pdfjs=${squash(reference).length}`)
}

// ── width helper ────────────────────────────────────────────────────────────

{
  const info = [...fonts.values()][0]
  check('widthOfCode returns a positive width', widthOfCode(info, 1) > 0, String(widthOfCode(info, 1)))
  check('widthOfCode falls back for an unknown code', widthOfCode(info, 65000) === info.defaultWidth)
}

console.log(`\n${failed === 0 ? 'ALL READABLE-RUN CHECKS PASSED' : failed + ' check(s) FAILED'}`)
if (failed > 0) process.exitCode = 1
