/**
 * Canvas UI tests — drive the real surface script in a DOM.
 *
 * The surface is plain JS loaded by injection, with no imports, so the only way
 * to test it is to run it for real. This harness does that: it builds a jsdom
 * document, evaluates `public/app.js`, and drives it through the edit flow with
 * a stubbed `fetch`.
 *
 * What is actually worth testing here is the BOX MATHS. PDF space is
 * bottom-left; the backdrop is a top-left bitmap. A sign error there mirrors
 * every overlay, which looks fine on a symmetric page and is wrong everywhere
 * else — so the projected coordinates are asserted against hand-computed values
 * derived from the run's own PDF geometry.
 *
 * Run: node --experimental-strip-types test/canvas-ui.test.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import { readEditableDocument } from '../src/host/engine.ts'

const SOURCE = '/Users/Zhuanz/dsh-pdf-maker/demo/source/contract.pdf'
/** Rendered page width in CSS px, chosen by the harness so the maths is exact. */
const IMG_WIDTH = 595
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

console.log('canvas ui\n')

// The real model, so the assertions use true run geometry rather than fixtures.
const model = await readEditableDocument(SOURCE)
const page1 = model.content[0]
const titleRun = page1.runs.find(run => run.id === '1:6')
const footerRun = page1.runs.find(run => run.id === '3:6')

// ── build the DOM and load the surface ──────────────────────────────────────

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:19387/',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
globalThis.HTMLElement = window.HTMLElement
globalThis.fetch = async (url, options) => {
  const target = String(url)
  const json = body => ({ ok: true, status: 200, json: async () => body })
  if (target.includes('/runs')) return json(model)
  if (target.includes('/info')) {
    return json({
      ok: true, sourcePath: SOURCE, pages: 2, encrypted: false,
      sizes: [{ page: 1, width: 595.28, height: 841.89 }, { page: 2, width: 595.28, height: 841.89 }],
    })
  }
  if (target.includes('/list')) return json({ ok: true, dir: '/tmp', count: 1, files: [SOURCE] })
  if (target.includes('/apply')) {
    const sent = JSON.parse(options.body)
    appliedPayload = sent
    return json({ ok: true, outputPath: '/tmp/edited.pdf', pages: 1, applied: sent.edits.length, notes: [] })
  }
  if (target.includes('/page.png')) return { ok: true, status: 200, json: async () => ({}) }
  if (target.includes('/watermark/scan')) {
    return json({
      ok: true, sourcePath: SOURCE, pages: 1,
      candidates: [{ page: 1, kind: 'xobject', reason: 'named-xobject', confidence: 1, xobjectName: 'dsh-pdf-studio-watermark', detail: '带水印标识的 Form XObject' }],
      refused: [{ page: 1, detail: '栅格化水印无法移除' }],
    })
  }
  if (target.includes('/watermark/add')) { addedPayload = JSON.parse(options.body); return json({ ok: true, outputPath: '/tmp/wm.pdf', pages: 1, textDrawn: '机密', droppedChars: [], notes: [] }) }
  if (target.includes('/watermark/remove')) { removedPayload = JSON.parse(options.body); return json({ ok: true, outputPath: '/tmp/clean.pdf', removed: [{ page: 1, confidence: 1 }], skipped: [], notes: [], dryRun: false }) }
  if (target.includes('/encryption')) return json({ ok: true, encrypted: true, opensWithoutPassword: false, raw: '' })
  if (target.includes('/protect')) { protectPayload = JSON.parse(options.body); return json({ ok: true, outputPath: '/tmp/p.pdf', encrypted: true, opensWithoutPassword: false, bytes: 1024, notes: [] }) }
  return json({ ok: true })
}
let appliedPayload = null
let addedPayload = null
let removedPayload = null
let protectPayload = null

const surface = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
// The surface is an IIFE; evaluating it in the jsdom context is exactly how the
// browser loads it after injection.
window.eval(surface)

const host = document.getElementById('dsh-pdf-studio-host')
check('the surface mounted its host element', host !== null)
const shadow = host.shadowRoot
check('the surface uses a shadow root (no style leakage)', shadow !== null)

const $ = id => shadow.getElementById(id)
check('the launcher is present', $('launcher') !== null || shadow.querySelector('.launcher') !== null)
check('both tabs exist', $('tabAnalyze') !== null && $('tabEdit') !== null)

// ── preview tab ─────────────────────────────────────────────────────────────
//
// The preview is the first thing a user meets, and it is the only way to see a
// document without committing to analysis (which OCRs scans) or editing.

{
  check('the preview tab is the default view',
    $('viewPreview').style.display !== 'none' && $('viewAnalyze').style.display === 'none',
    `preview=${$('viewPreview').style.display} analyze=${$('viewAnalyze').style.display}`)

  $('path').value = SOURCE
  $('previewOpen').click()
  await new Promise(resolve => setTimeout(resolve, 30))

  const figures = $('pages').querySelectorAll('figure')
  check('one thumbnail per page', figures.length === 2, `${figures.length} figures`)
  const imgs = [...$('pages').querySelectorAll('img')]
  check('every thumbnail points at the page renderer', imgs.every(img => img.src.includes('/page.png')),
    imgs.map(img => img.src).join(' '))
  check('thumbnails are lazy so a long document does not fetch everything',
    imgs.every(img => img.loading === 'lazy'), imgs.map(img => String(img.loading)).join(','))

  // The guard that matters most here. A `loading="lazy"` image that is
  // `display:none` never gets a layout box, so the browser never considers it
  // in the viewport, so it never loads — and a reveal-on-load handler then
  // never fires. That deadlock showed the user a grid of "第 N 页" placeholders
  // instead of the document, so it is asserted directly rather than implied.
  check('thumbnails are NOT hidden (a hidden lazy image never loads)',
    imgs.every(img => img.style.display !== 'none'),
    imgs.map(img => `display=${JSON.stringify(img.style.display)}`).join(' '))
  check('each thumbnail sits inside a positioned frame with a placeholder overlay',
    imgs.every(img => img.parentNode && img.parentNode.className === 'frame'),
    imgs.map(img => img.parentNode && img.parentNode.className).join(','))
  check('each thumbnail requests its own page',
    imgs.some(img => img.src.includes('page=1')) && imgs.some(img => img.src.includes('page=2')),
    imgs.map(img => img.src.replace(/.*page=/, 'page=').split('&')[0]).join(' '))
  check('the page count and dimensions are shown',
    $('previewInfo').textContent.includes('2') && $('previewInfo').textContent.includes('595'),
    $('previewInfo').textContent)

  // Switching tabs must hide the preview again.
  $('tabAnalyze').click()
  check('switching to analyze hides the preview', $('viewPreview').style.display === 'none')
  $('tabPreview').click()
  check('switching back shows the preview', $('viewPreview').style.display !== 'none')
}

// ── drive it: select a file, load runs, render the canvas ───────────────────

$('path').value = SOURCE
$('tabEdit').click()
check('the edit view becomes visible', $('viewEdit').style.display !== 'none')

$('loadRuns').click()
await new Promise(resolve => setTimeout(resolve, 30))

check('the canvas stage is shown', $('stage').style.display !== 'none')
check('a page image was inserted', $('wrap').querySelector('img') !== null)
check('the page label reflects the document', $('pageLabel').textContent.includes('/'), $('pageLabel').textContent)

// `img.clientWidth` is 0 in jsdom (no layout), so the surface falls back to the
// natural size it was given. Give it one and re-render by dispatching load.
const img = $('wrap').querySelector('img')
Object.defineProperty(img, 'clientWidth', { value: IMG_WIDTH, configurable: true })
Object.defineProperty(img, 'naturalWidth', { value: IMG_WIDTH, configurable: true })
img.dispatchEvent(new window.Event('load'))
await new Promise(resolve => setTimeout(resolve, 10))

const boxes = [...$('wrap').querySelectorAll('.run')]
check('one box per run on the page', boxes.length === page1.runs.length, `${boxes.length} vs ${page1.runs.length} runs`)

/**
 * Expected projection, computed independently of the surface's own code:
 *   scale  = renderedWidth / pageWidth
 *   height = fontSize * 1.25
 *   left   = x * scale
 *   top    = (pageHeight - (y + height)) * scale
 */
const expectBox = run => {
  const scale = IMG_WIDTH / PAGE_WIDTH
  const heightPt = (run.fontSize || 10) * 1.25
  return {
    left: run.x * scale,
    top: (PAGE_HEIGHT - (run.y + heightPt)) * scale,
    width: Math.max(6, (run.widthPt || 12) * scale),
    height: Math.max(6, heightPt * scale),
  }
}

// Boxes render in run order, so pair them up by index.
const titleIndex = page1.runs.indexOf(titleRun)
const footerIndex = page1.runs.indexOf(footerRun)

const nearly = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance

for (const [label, run, index] of [['title', titleRun, titleIndex], ['footer', footerRun, footerIndex]]) {
  const el = boxes[index]
  const want = expectBox(run)
  const left = parseFloat(el.style.left)
  const top = parseFloat(el.style.top)
  check(`the ${label} box projects to the expected x`, nearly(left, want.left), `got ${left.toFixed(1)} want ${want.left.toFixed(1)}`)
  check(`the ${label} box projects to the expected y (y-flip correct)`, nearly(top, want.top), `got ${top.toFixed(1)} want ${want.top.toFixed(1)}`)
  check(`the ${label} box has a plausible size`, parseFloat(el.style.width) > 4 && parseFloat(el.style.height) > 4,
    `${el.style.width} x ${el.style.height}`)
}

// The strongest single statement about the flip: a run near the TOP of the page
// (large PDF y) must project to a SMALL top offset, and a run near the bottom
// (small PDF y) to a LARGE one.
{
  const titleEl = boxes[titleIndex]
  const footerEl = boxes[footerIndex]
  const titleTop = parseFloat(titleEl.style.top)
  const footerTop = parseFloat(footerEl.style.top)
  check('a high run is above a low run on screen (flip not inverted)',
    titleTop < footerTop,
    `title.top=${titleTop.toFixed(0)} (PDF y=${titleRun.y.toFixed(0)}) must be < footer.top=${footerTop.toFixed(0)} (PDF y=${footerRun.y.toFixed(0)})`)
}

// ── select a run and edit it ────────────────────────────────────────────────

boxes[footerIndex].dispatchEvent(new window.Event('click', { bubbles: true }))
await new Promise(resolve => setTimeout(resolve, 10))
check('the editor opens for the clicked run', $('editor').style.display !== 'none')
check('the editor shows the original text', $('editorOld').textContent.includes('法务终审'), $('editorOld').textContent)
check('the editor is seeded with the current text', $('editorInput').value === footerRun.text, $('editorInput').value)

$('editorInput').value = '改后的页脚文字'
$('editorSave').click()
await new Promise(resolve => setTimeout(resolve, 10))
check('the edited box is marked as edited', $('wrap').querySelectorAll('.run.edited').length >= 1)
check('the apply button becomes enabled', $('apply').disabled === false)

$('apply').click()
await new Promise(resolve => setTimeout(resolve, 30))
check('apply posted exactly the pending edit', appliedPayload !== null && appliedPayload.edits.length === 1,
  JSON.stringify(appliedPayload))
check('apply targeted the clicked run id', appliedPayload?.edits?.[0]?.targetId === footerRun.id,
  String(appliedPayload?.edits?.[0]?.targetId))
check('apply sent the new text', appliedPayload?.edits?.[0]?.to === '改后的页脚文字',
  String(appliedPayload?.edits?.[0]?.to))
check('apply sent the page number', appliedPayload?.edits?.[0]?.page === 1, String(appliedPayload?.edits?.[0]?.page))

// ── watermark / password tab ────────────────────────────────────────────────

{
  $('tabMark').click()
  check('the watermark tab becomes visible', $('viewMark').style.display !== 'none')
  check('the other views hide', $('viewEdit').style.display === 'none' && $('viewAnalyze').style.display === 'none')

  $('path').value = SOURCE
  $('wmScan').click()
  await new Promise(resolve => setTimeout(resolve, 30))
  check('the scan renders a candidate row', $('wmList').querySelectorAll('tbody tr').length === 1,
    String($('wmList').querySelectorAll('tbody tr').length))
  check('the refusal is surfaced so an empty list is not read as "clean"',
    $('wmList').textContent.includes('栅格化水印无法移除'), $('wmList').textContent.slice(0, 60))
  check('removal is enabled when a confident candidate exists', $('wmRemove').disabled === false)

  $('wmText').value = '机密 · 请勿外传'
  $('wmPlace').value = 'center'
  $('wmOpacity').value = '25'
  $('wmSize').value = '60'
  $('wmAdd').click()
  await new Promise(resolve => setTimeout(resolve, 30))
  check('adding posts the text', addedPayload?.text === '机密 · 请勿外传', JSON.stringify(addedPayload))
  check('adding posts the placement', addedPayload?.placement === 'center', String(addedPayload?.placement))
  check('adding converts the opacity slider to 0..1', Math.abs((addedPayload?.opacity ?? 0) - 0.25) < 1e-6,
    String(addedPayload?.opacity))
  check('adding posts the font size', addedPayload?.fontSize === 60, String(addedPayload?.fontSize))

  $('wmRemove').click()
  await new Promise(resolve => setTimeout(resolve, 30))
  check('removal posts the source path', removedPayload?.path === SOURCE, JSON.stringify(removedPayload))
  check('the client does not request a dry run when the user asked to remove',
    removedPayload?.dryRun === undefined || removedPayload?.dryRun === false, String(removedPayload?.dryRun))

  $('pwUser').value = 'hunter2'
  $('pwEncrypt').click()
  await new Promise(resolve => setTimeout(resolve, 30))
  check('encryption posts the password', protectPayload?.userPassword === 'hunter2', JSON.stringify(protectPayload))
  check('encryption requests the encrypt action', protectPayload?.action === 'encrypt', String(protectPayload?.action))

  $('pwCheck').click()
  await new Promise(resolve => setTimeout(resolve, 30))
  check('the protection state is explained in words, not just flags',
    $('pwState').textContent.includes('需要密码'), $('pwState').textContent)
}

// ── movable surfaces ────────────────────────────────────────────────────────
//
// jsdom reports `getBoundingClientRect()` as all zeros, which makes the drag
// maths DETERMINISTIC here: the grab offset is the pointer position itself, so
// a move to (clientX, clientY) must land the surface at exactly the delta. That
// is a stronger check than eyeballing a real window.

{
  const panel = shadow.querySelector('.panel')
  const title = shadow.querySelector('.title')
  const pointer = (type, x, y) => {
    const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true })
    title.dispatchEvent(event)
  }

  pointer('pointerdown', 100, 100)
  pointer('pointermove', 160, 140)
  check('dragging the header moves the panel to the pointer delta',
    panel.style.left === '60px' && panel.style.top === '40px',
    `left=${panel.style.left} top=${panel.style.top}`)
  check('dragging switches off the right/bottom anchoring',
    panel.style.right === 'auto' && panel.style.bottom === 'auto',
    `right=${panel.style.right} bottom=${panel.style.bottom}`)
  pointer('pointerup', 160, 140)

  const saved = JSON.parse(window.localStorage.getItem('dsh-pdf-studio-positions') || '{}')
  check('the panel position is persisted', saved.panel?.left === 60 && saved.panel?.top === 40,
    JSON.stringify(saved))

  // A surface must never be draggable out of reach.
  pointer('pointerdown', 10, 10)
  pointer('pointermove', 99999, 99999)
  pointer('pointerup', 99999, 99999)
  const maxLeft = window.innerWidth - 72
  check('a drag past the edge is clamped so the surface stays grabbable',
    parseFloat(panel.style.left) <= maxLeft, `${panel.style.left} vs max ${maxLeft}`)

  // Double-clicking the title restores the default corner.
  title.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))
  check('double-clicking the title resets the position',
    panel.style.left === '' && panel.style.right === '18px', `left=${panel.style.left} right=${panel.style.right}`)
  const afterReset = JSON.parse(window.localStorage.getItem('dsh-pdf-studio-positions') || '{}')
  check('the reset clears the saved position', afterReset.panel === undefined, JSON.stringify(afterReset))
}

// ── the launcher must distinguish a drag from a click ───────────────────────
//
// The launcher both opens the panel and moves. If a drag also fired its click,
// every attempt to reposition it would pop the panel open — the kind of bug
// that makes a feature feel broken.

{
  const panel = shadow.querySelector('.panel')
  const launcher = shadow.querySelector('.launcher')

  // Start from a known state: the panel is open from the earlier sections.
  shadow.querySelector('.x').click()
  check('closing the panel hides it', !panel.classList.contains('open'))

  launcher.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 500, clientY: 500, button: 0, bubbles: true }))
  launcher.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 560, clientY: 540, bubbles: true }))
  launcher.dispatchEvent(new window.MouseEvent('pointerup', { clientX: 560, clientY: 540, bubbles: true }))
  launcher.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  check('dragging the launcher does NOT open the panel', !panel.classList.contains('open'),
    `class=${panel.className}`)
  check('the launcher moved to the drag delta',
    launcher.style.left === '60px' && launcher.style.top === '40px',
    `left=${launcher.style.left} top=${launcher.style.top}`)

  launcher.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  check('a plain click still opens the panel', panel.classList.contains('open'), `class=${panel.className}`)
}

console.log(`\n${failed === 0 ? 'ALL CANVAS-UI CHECKS PASSED' : failed + ' check(s) FAILED'}`)
if (failed > 0) process.exitCode = 1
