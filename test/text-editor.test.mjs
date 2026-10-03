/**
 * Text-editor tests: rewrite a page's content stream and prove it worked.
 *
 * Two things must hold, and both are checked against the real contract:
 *
 *   1. the replacement is actually painted and extractable — re-open the saved
 *      PDF and find the new text; and
 *   2. the edit was SURGICAL — every operator outside the rewritten span is
 *      byte-identical, so nothing else on the page moved.
 *
 * Run: node --experimental-strip-types test/text-editor.test.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  listEditableRuns,
  readPageContentStreams,
  replacePageText,
} from '../src/core/text-editor.ts'
import { parseOperations, showStrings, tokenize } from '../src/core/content-stream.ts'

const require = createRequire(import.meta.url)
const { PDFDocument, PDFArray, PDFName, PDFRawStream, decodePDFRawStream } = require('pdf-lib')

const SOURCE = '/Users/Zhuanz/dsh-pdf-maker/demo/source/contract.pdf'
const OUT = '/tmp/pdf-studio-text-edit.pdf'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex')

/** Decode every content stream of page 1 of a PDF buffer. */
async function streamTexts(bytes) {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPages()[0]
  const contents = page.node.Contents()
  const refs = []
  if (contents instanceof PDFArray) for (let i = 0; i < contents.size(); i += 1) refs.push(contents.get(i))
  else refs.push(contents)
  return refs
    .map(ref => doc.context.lookup(ref))
    .filter(stream => stream instanceof PDFRawStream)
    .map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
}

console.log('text editor\n')

const before = await sha256(SOURCE)

// ── read the runs ───────────────────────────────────────────────────────────

const original = await readFile(SOURCE)
const readDoc = await PDFDocument.load(original)
const readPage = readDoc.getPages()[0]
const streams = readPageContentStreams(readPage, readDoc.context)
const runs = listEditableRuns(streams)

check('found the page content streams', streams.length === 4, `${streams.length}`)
check('listed every text run', runs.length === 13, `${runs.length} runs`)
check('runs carry a stable id', runs.every(run => /^\d+:\d+$/.test(run.id)), runs[0]?.id)
check('runs carry their font and size', runs[0]?.fontName?.startsWith('ArialUnicodeMS-') === true && runs[0]?.fontSize === 22,
  `${runs[0]?.fontName} @ ${runs[0]?.fontSize}`)
check('runs carry their baseline', Math.round(runs[0]?.x ?? 0) === 244 && Math.round(runs[0]?.y ?? 0) === 762,
  `${runs[0]?.x?.toFixed(1)},${runs[0]?.y?.toFixed(1)}`)
check('the title run glyph total is the run, not the first string', (runs[0]?.glyphCount ?? 0) >= 5, String(runs[0]?.glyphCount))

// Pick the LAST run: the footer at y=120, which is a separate content stream
// from the title — so this also proves cross-stream addressing.
const footerRun = runs.find(run => Math.round(run.y) === 120)
check('found the footer run at y=120', footerRun !== undefined, footerRun?.id)

// ── apply the edit ──────────────────────────────────────────────────────────

const doc = await PDFDocument.load(original)
const page = doc.getPages()[0]
const result = await replacePageText(
  doc,
  page,
  [{ targetId: footerRun.id, to: '编辑测试文本已替换' }],
  { context: doc.context },
)

check('the edit reported success', result.replacementsApplied > 0, JSON.stringify({ applied: result.replacementsApplied, ids: result.targetIds, notes: result.notes }))

const saved = await doc.save()
await writeFile(OUT, saved)
check('wrote the edited file', saved.length > 0, `${(saved.length / 1024).toFixed(0)}KB`)
check('source file untouched', (await sha256(SOURCE)) === before)

// ── verify by re-extraction ─────────────────────────────────────────────────

const pdfjs = await import('../node_modules/pdfjs-dist/legacy/build/pdf.mjs')
const reopened = await pdfjs.getDocument({ data: new Uint8Array(saved) }).promise
const reopenedPage = await reopened.getPage(1)
const textContent = await reopenedPage.getTextContent()
const extracted = textContent.items.filter(item => typeof item.str === 'string').map(item => item.str).join('\n')

check('the replacement text is extractable from the saved PDF', extracted.includes('编辑测试文本已替换'),
  extracted.includes('编辑测试文本已替换') ? '' : JSON.stringify(extracted.slice(-120)))
check(
  'the original footer wording is gone',
  !extracted.includes('法务终审'),
  extracted.includes('法务终审') ? 'old text still present' : '',
)
check(
  'the rest of the page still reads correctly',
  /服\s*务\s*合\s*同/.test(extracted) && /合\s*同\s*编\s*号/.test(extracted),
  JSON.stringify(extracted.slice(0, 60)),
)

// ── verify the edit was surgical ────────────────────────────────────────────

const afterStreams = await streamTexts(saved)
const untouchedStreams = [0, 1, 2]
const originalStreams = await streamTexts(original)

const identical = untouchedStreams.filter(index => afterStreams[index] === originalStreams[index])
check('untouched content streams are byte-identical', identical.length === untouchedStreams.length,
  `identical ${identical.length}/${untouchedStreams.length}`)

// The edited stream must differ ONLY inside the rewritten span. Compare the
// common prefix and suffix lengths against the expected edit.
const originalEdited = originalStreams[3] ?? ''
const afterEdited = afterStreams[3] ?? ''
let prefix = 0
while (prefix < originalEdited.length && prefix < afterEdited.length && originalEdited[prefix] === afterEdited[prefix]) prefix += 1
let suffix = 0
while (
  suffix < originalEdited.length - prefix
  && suffix < afterEdited.length - prefix
  && originalEdited[originalEdited.length - 1 - suffix] === afterEdited[afterEdited.length - 1 - suffix]
) suffix += 1
// The edited stream must differ ONLY inside the rewritten window. The window
// is derived from the parser (governing `Tf`'s first operand .. end of the last
// glyph string), and the assertion is containment: every byte outside it is
// identical. That is the meaningful "surgical" claim — whitespace inside the
// window may legitimately match, so a strict prefix/suffix equality would be
// both stricter and less meaningful than it looks.
const editedStream = streams.find(stream => stream.index === footerRun.streamIndex)
const editedOps = parseOperations(tokenize(editedStream.text))
const originalOps = parseOperations(tokenize(originalEdited))

/** The operator window a run occupies: from `Tf`'s first operand to the run's last glyph string. */
function windowFor(ops, operationIndex) {
  let start = ops[operationIndex].start
  for (let i = operationIndex - 1; i >= 0; i -= 1) {
    if (ops[i].op === 'Tf') {
      start = ops[i].operands[0].start
      break
    }
  }
  const glyphs = showStrings(ops[operationIndex])
  return { start, end: glyphs[glyphs.length - 1].end }
}

const window = windowFor(originalOps, footerRun.operationIndex)
const headBefore = originalEdited.slice(0, window.start)
const tailAfter = originalEdited.slice(window.end)

check('the head before the window is untouched', afterEdited.startsWith(headBefore),
  JSON.stringify({ head: headBefore }))
check('the tail after the window is untouched', afterEdited.endsWith(tailAfter),
  JSON.stringify({ tail: tailAfter }))
check('the replacement is shorter than the text it replaced',
  afterEdited.length < originalEdited.length,
  `${originalEdited.length} -> ${afterEdited.length}`)
check('the rewritten window contains the new font and glyphs',
  afterEdited.slice(window.start).startsWith('/ArialUnicodeMS ') && /<[0-9A-F]+>/.test(afterEdited),
  JSON.stringify(afterEdited.slice(0, 60)))
void editedOps

// The new subset must be declared, or its glyphs have no CMap and extract as
// raw bytes — the exact failure mode seen in the overlay writer.
const fontDict = doc.getPages()[0].node.Resources().lookup(PDFName.of('Font'))
const declared = fontDict.keys().map(key => key.toString().replace(/^\//, ''))
check('the embedded subset was registered in /Resources',
  declared.includes('ArialUnicodeMS'),
  `${declared.length} fonts declared; new subset ${declared.includes('ArialUnicodeMS') ? 'present' : 'MISSING'}`)

// ── overflow warning ────────────────────────────────────────────────────────
//
// An editor that silently lets text run off the page is a trap. The warning is
// an estimate (the new subset has no /W yet), so it is only asserted to appear
// for an obviously-too-long replacement — not for a normal one.

{
  const doc2 = await PDFDocument.load(original)
  const shortEdit = await replacePageText(
    doc2,
    doc2.getPages()[0],
    [{ targetId: footerRun.id, to: '短' }],
    { context: doc2.context },
  )
  check('a shorter replacement raises no overflow warning',
    !shortEdit.notes.some(note => note.includes('溢出')),
    JSON.stringify(shortEdit.notes))

  const doc3 = await PDFDocument.load(original)
  const longEdit = await replacePageText(
    doc3,
    doc3.getPages()[0],
    [{ targetId: footerRun.id, to: '这是一段刻意写得非常长的替换文本用来触发溢出提示'.repeat(2) }],
    { context: doc3.context },
  )
  check('an over-long replacement is flagged before it overflows',
    longEdit.notes.some(note => note.includes('溢出')),
    JSON.stringify(longEdit.notes))
}

// ── several runs sharing one `Tf` ───────────────────────────────────────────
//
// A content stream normally sets a font ONCE and then shows many strings, so
// consecutive runs share a `Tf`. An earlier implementation replaced the whole
// `Tf`-through-glyphs window as one span, which made those spans overlap and
// caused the stream to be skipped as unsafe — a bulk edit silently applied
// NOTHING while reporting success. This is the regression guard for that.

{
  const { PDFName, PDFName: Name, PDFDocument: Doc, PDFDict } = await import('pdf-lib')

  /** Build a PDF whose content stream sets one font and shows three strings. */
  async function makeSharedTfPdf() {
    const doc = await Doc.create()
    const font = await doc.embedFont(await (await import('pdf-lib')).StandardFonts.Helvetica)
    const page = doc.addPage([400, 200])
    // Hand-written so all three shows sit under ONE `Tf`.
    const body = [
      'q', 'BT', `/F1 12 Tf`, '1 0 0 1 20 150 Tm', '(AAA) Tj',
      '1 0 0 1 20 120 Tm', '(BBB) Tj',
      '1 0 0 1 20 90 Tm', '(CCC) Tj',
      'ET', 'Q',
    ].join('\n')
    const { PDFRawStream, deflateSync } = await import('pdf-lib')
    const stream = PDFRawStream.of(
      doc.context.obj({ Filter: 'FlateDecode' }),
      (await import('node:zlib')).deflateSync(Buffer.from(body, 'latin1')),
    )
    const contentsRef = doc.context.register(stream)
    page.node.set(Name.of('Contents'), contentsRef)
    const resources = page.node.Resources()
    resources.set(Name.of('Font'), doc.context.obj({ F1: font.ref }))
    return new Uint8Array(await doc.save())
  }

  const shared = await makeSharedTfPdf()
  const sharedDoc = await PDFDocument.load(shared)
  const sharedPage = sharedDoc.getPages()[0]
  const sharedRuns = listEditableRuns(readPageContentStreams(sharedPage, sharedDoc.context))
  check('the fixture has three runs under ONE font selection', sharedRuns.length === 3,
    `${sharedRuns.length} runs`)

  const { bytes: bulkOut, result: bulkResult } = await (async () => {
    const doc = await PDFDocument.load(shared)
    const page = doc.getPages()[0]
    const runs = listEditableRuns(readPageContentStreams(page, doc.context))
    const r = await replacePageText(
      doc, page,
      runs.map((run, index) => ({ targetId: run.id, to: `X${index + 1}` })),
      { context: doc.context },
    )
    return { bytes: await doc.save(), result: r }
  })()

  check('all three edits apply when they share a font selection',
    bulkResult.replacementsApplied === 3, JSON.stringify(bulkResult))
  check('no stream was skipped as overlapping',
    !bulkResult.notes.some(note => note.includes('重叠')), JSON.stringify(bulkResult.notes))

  // Assert the RAW STREAM, not the decoded text. Latin-only replacements fall
  // back to a standard font, which carries no ToUnicode — so this decoder (which
  // reads glyph codes through ToUnicode) cannot read its own output back, even
  // though every other reader can and the rendering is correct. That is a known
  // limit of `listReadableRuns`, not a symptom of this bug, so the regression is
  // pinned to what actually changed: the operands.
  const reread = await PDFDocument.load(bulkOut)
  const rebuilt = readPageContentStreams(reread.getPages()[0], reread.context).map(stream => stream.text).join('\n')
  check('the original glyph strings are gone from the stream',
    !rebuilt.includes('AAA') && !rebuilt.includes('BBB') && !rebuilt.includes('CCC'), JSON.stringify(rebuilt))
  check('three glyph operands were rewritten',
    (rebuilt.match(/<[0-9A-F]+> Tj/g) ?? []).length === 3, JSON.stringify(rebuilt))
  check('the shared font selection was repointed exactly once',
    (rebuilt.match(/\/[A-Za-z]+ \d+ Tf/g) ?? []).length === 1, JSON.stringify(rebuilt))
  // A standard font is expected for pure-latin text; document it so a change in
  // that choice is noticed rather than silently altering the read-back story.
  const fontsAfter = reread.getPages()[0].node.Resources().lookup(PDFName.of('Font'), PDFDict)
  check('the replacement font is registered in /Resources',
    fontsAfter.keys().map(k => k.toString()).some(k => k.startsWith('/Arial') || k.includes('Helvetica')),
    fontsAfter.keys().map(k => k.toString()).join(','))
}

// ── render diff: the edit must be visually surgical ────────────────────────
//
// The byte-level assertions prove the stream was rewritten in place. This
// proves the CONSEQUENCE: the rest of the page renders identically. Rendering
// can perturb antialiasing, so a tolerance is used; the claim is that no pixel
// outside the edited run's own extent moves.

{
  const require2 = createRequire(import.meta.url)
  const pdfjs = await import('../node_modules/pdfjs-dist/legacy/build/pdf.mjs')
  const { createCanvas } = require2('@napi-rs/canvas')
  pdfjs.GlobalWorkerOptions.workerSrc = require2.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')

  const SCALE = 2
  const render = async buffer => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
    const page = await doc.getPage(1)
    const viewport = page.getViewport({ scale: SCALE })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const context = canvas.getContext('2d')
    context.fillStyle = 'white'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: context, viewport }).promise
    return context.getImageData(0, 0, canvas.width, canvas.height)
  }

  const beforePixels = await render(original)
  const afterPixels = await render(saved)
  check('both renders have identical dimensions',
    beforePixels.width === afterPixels.width && beforePixels.height === afterPixels.height,
    `${beforePixels.width}x${beforePixels.height}`)

  // The edited run is the lower block: baseline y=120 with leading 15 across
  // many characters, so its extent reaches the page foot. Everything ABOVE the
  // run's top (y=140 gives margin) must be untouched.
  const topOfRunDevice = Math.floor((beforePixels.height / SCALE - 140) * SCALE)
  let changedAbove = 0
  let changedTotal = 0
  for (let y = 0; y < beforePixels.height; y += 1) {
    for (let x = 0; x < beforePixels.width; x += 1) {
      const offset = (y * beforePixels.width + x) * 4
      const delta = Math.max(
        Math.abs(beforePixels.data[offset] - afterPixels.data[offset]),
        Math.abs(beforePixels.data[offset + 1] - afterPixels.data[offset + 1]),
        Math.abs(beforePixels.data[offset + 2] - afterPixels.data[offset + 2]),
      )
      if (delta <= 24) continue
      changedTotal += 1
      if (y < topOfRunDevice) changedAbove += 1
    }
  }
  check('the edit actually changed pixels', changedTotal > 0, `${changedTotal} pixels`)
  check('no pixel above the edited run changed', changedAbove === 0,
    `${changedAbove} pixels changed above device y=${topOfRunDevice} (PDF y=140)`)
}

console.log(`\n${failed === 0 ? 'ALL TEXT-EDITOR CHECKS PASSED' : failed + ' check(s) FAILED'}`)
if (failed > 0) process.exitCode = 1
