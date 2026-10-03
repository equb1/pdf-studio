/**
 * Content-stream parser tests.
 *
 * The load-bearing property is losslessness: rebuilding a tokenised stream
 * must reproduce it. If that holds, then a patch that reports "only span X
 * changed" is trustworthy, because everything else came from the original
 * bytes. Without it, every edit silently rewrites the whole page.
 *
 * Run: node --experimental-strip-types test/content-stream.test.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import {
  locateShowText,
  parseOperations,
  replaceSpan,
  serializeOperations,
  showStrings,
  spansOverlap,
  stringBytes,
  tokenize,
  hexFromGlyphIds,
} from '../src/core/content-stream.ts'

const require = createRequire(import.meta.url)
const { PDFDocument, PDFArray, PDFName, PDFRawStream, decodePDFRawStream } = require('pdf-lib')

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

/** Rebuild by emitting only whitespace between tokens (normalises spacing). */
const rebuild = tokens => tokens.map(t => t.raw).join(' ')
const squash = text => text.replace(/\s+/g, ' ').trim()

console.log('content-stream parser\n')

// ── synthetic cases first: cheap and precise ────────────────────────────────

{
  const src = 'q 1 0 0 1 24 36 cm /F1 12 Tf [ (Hi) -250 <0041> ] TJ Q'
  const tokens = tokenize(src)
  check('tokenizes names, numbers, strings, arrays', tokens.length > 0, `${tokens.length} tokens`)
  check('recognises a name token', tokens.some(t => t.kind === 'name' && t.raw === '/F1'))
  // The hex string is nested INSIDE the array, which tokenises as one token,
  // so a top-level scan must not claim to find it.
  check('array contents are not leaked to the top level', !tokens.some(t => t.kind === 'string' && t.raw === '<0041>'))
  check('a top-level hex string is recognised', tokenize('foo <0041> bar').some(t => t.kind === 'string' && t.raw === '<0041>'))
  check('recognises an array as ONE token', tokens.some(t => t.kind === 'array' && t.raw.startsWith('[')))
  check('round-trips the source', squash(rebuild(tokens)) === squash(src), JSON.stringify(rebuild(tokens)))
}

{
  // A literal string containing an escaped paren must not break string
  // scanning, and — the reason this is here — must not let the scanner walk
  // off the end of the input. The earlier implementation advanced `i` by 2 on
  // a backslash without a bounds check, which turned this into an infinite
  // allocating loop rather than a wrong answer.
  const src = '[(a) \\] TJ'
  const tokens = tokenize(src)
  check('an escaped paren inside a literal string tokenises', tokens.length === 2, JSON.stringify(tokens.map(t => t.raw)))
  check('the array token stops at the string boundary', tokens[0]?.raw === '[(a) \\]', JSON.stringify(tokens[0]?.raw))
  check('an escaped paren survives a round trip', rebuild(tokens).replace(/\s+/g, ' ').trim() === src, JSON.stringify(rebuild(tokens)))
}

{
  // Termination is the property under test for malformed input, so it gets an
  // explicit time guard: a regression here hangs the process rather than
  // failing a comparison.
  const cases = [
    '(unterminated',
    '[(a) \\',
    '<0041',
    '[1 [2 [3]] 4',
    '<< /A 1',
    '/Name#20With',
    ')stray',
    ']stray',
    '>stray',
    '(abc\\',
  ]
  let terminated = 0
  for (const sample of cases) {
    const started = Date.now()
    const out = tokenize(sample)
    if (Date.now() - started < 1000 && Array.isArray(out)) terminated += 1
  }
  check('malformed input terminates instead of spinning', terminated === cases.length, `${terminated}/${cases.length}`)

  const trailing = tokenize('(abc\\')
  check('a trailing backslash does not overshoot the input', trailing.length === 1 && trailing[0].end <= 5, JSON.stringify(trailing.map(t => [t.raw, t.end])))
}

{
  const ops = parseOperations(tokenize('BT /F1 12 Tf 1 0 0 1 70 700 Tm <0001> Tj ET'))
  const shows = locateShowText(ops)
  check('locates one show-text op', shows.length === 1, `${shows.length}`)
  check('captures the active font', shows[0]?.fontName === 'F1', String(shows[0]?.fontName))
  check('captures the font size', shows[0]?.fontSize === 12, String(shows[0]?.fontSize))
  check('captures the text origin', shows[0]?.x === 70 && shows[0]?.y === 700, `${shows[0]?.x},${shows[0]?.y}`)
  check('captures the glyph operand', shows[0]?.operand.raw === '<0001>', String(shows[0]?.operand.raw))
}

{
  // T* advances by the leading; Td accumulates. Both are needed to place runs.
  const ops = parseOperations(tokenize('BT 14 TL 1 0 0 1 10 100 Tm (A) Tj T* (B) Tj ET'))
  const shows = locateShowText(ops)
  check('T* advances the origin by -leading', shows[1]?.y === 86, String(shows[1]?.y))
}

{
  const ops = parseOperations(tokenize('BT [ (A) -100 (B) ] TJ ET'))
  const shows = locateShowText(ops)
  check('TJ reports both glyph strings, skipping the kerning number', shows[0]?.strings.length === 2, String(shows[0]?.strings.length))
}

{
  check('stringBytes decodes hex', Buffer.from(stringBytes({ raw: '<00410042>', start: 0, end: 0, kind: 'string' })).toString('hex') === '00410042')
  check('hexFromGlyphIds encodes back', hexFromGlyphIds([0x41, 0x42]) === '<00410042>', hexFromGlyphIds([0x41, 0x42]))

  const overlapping = spansOverlap([{ start: 0, end: 10 }, { start: 5, end: 15 }])
  check('overlap detection works', overlapping === true)
  const disjoint = spansOverlap([{ start: 0, end: 4 }, { start: 5, end: 9 }])
  check('disjoint spans pass', disjoint === false)

  const patched = replaceSpan('abcdefghij', [
    { start: 0, end: 2, text: 'XX' },
    { start: 8, end: 10, text: 'YY' },
  ])
  check('replaceSpan applies multiple disjoint spans', patched === 'XXcdefghYY', patched)
}

// ── the real document ───────────────────────────────────────────────────────

const source = '/Users/Zhuanz/dsh-pdf-maker/demo/source/contract.pdf'
const doc = await PDFDocument.load(await readFile(source))
const page = doc.getPages()[0]
const contents = page.node.Contents()

const streams = []
if (contents instanceof PDFArray) {
  for (let i = 0; i < contents.size(); i += 1) {
    streams.push(doc.context.lookup(contents.get(i)))
  }
} else {
  streams.push(doc.context.lookup(contents))
}

const decoded = streams
  .filter(stream => stream instanceof PDFRawStream)
  .map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))

check('read the real page content streams', decoded.length === 4, `${decoded.length} streams`)

let totalShows = 0
let losslessStreams = 0
const positioned = []

for (const [index, text] of decoded.entries()) {
  const tokens = tokenize(text)
  const rebuilt = rebuild(tokens)
  if (squash(rebuilt) === squash(text)) losslessStreams += 1
  else console.log(`      stream ${index} round-trip differs:\n        in : ${JSON.stringify(text.slice(0, 120))}\n        out: ${JSON.stringify(rebuilt.slice(0, 120))}`)

  const ops = parseOperations(tokens)
  const shows = locateShowText(ops)
  totalShows += shows.length
  for (const show of shows) positioned.push({ stream: index, ...show })
}

check('every real stream round-trips losslessly', losslessStreams === decoded.length, `${losslessStreams}/${decoded.length}`)
check('found the show-text operators', totalShows === 13, `${totalShows} shows`)

check(
  'the first show carries its per-run subset font and size',
  positioned[0]?.fontName?.startsWith('ArialUnicodeMS-') === true && positioned[0]?.fontSize === 22,
  `${positioned[0]?.fontName} @ ${positioned[0]?.fontSize}`,
)
check(
  'the title sits where the content stream says',
  Math.round(positioned[0]?.x) === 244 && Math.round(positioned[0]?.y) === 762,
  `${positioned[0]?.x?.toFixed(1)},${positioned[0]?.y?.toFixed(1)}`,
)
check(
  'the last show is the low footer at y=120',
  Math.round(positioned[positioned.length - 1]?.y) === 120,
  String(positioned[positioned.length - 1]?.y),
)
check(
  'the title glyph payload is 5 CJK glyphs (10 bytes)',
  positioned[0]?.strings[0]?.raw === '<0001000200030002000400020005>',
  String(positioned[0]?.strings[0]?.raw),
)
check(
  'shows are spread across more than one stream',
  new Set(positioned.map(s => s.stream)).size > 1,
  [...new Set(positioned.map(s => s.stream))].join(','),
)

// Each show must resolve to a font that the page actually declares. This is
// the invariant whose violation produced unextractable text in the overlay
// writer, so it is asserted here for the edit path too.
const fontDict = page.node.Resources().lookup(PDFName.of('Font'))
const declared = new Set(fontDict.keys().map(key => key.toString().replace(/^\//, '')))
const unknownFonts = positioned.filter(show => show.fontName !== undefined && !declared.has(show.fontName))
check('every show references a font the page declares', unknownFonts.length === 0,
  unknownFonts.map(s => s.fontName).join(',') || `${declared.size} declared`)

console.log(`\n${failed === 0 ? 'ALL PARSER CHECKS PASSED' : failed + ' check(s) FAILED'}`)
if (failed > 0) process.exitCode = 1
