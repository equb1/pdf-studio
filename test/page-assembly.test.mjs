/**
 * 页级装配测试：拆分 2-up / 裁剪 / 重排 / 合并。
 *
 * 这四件事都会产出「看起来对、其实错了」的文件，所以测试不从返回值下手，而是从**结果文件**
 * 下手：页数、页面几何、文本层、真实渲染像素，最后用 qpdf 校验文件结构。
 *
 * 夹具全部用 pdf-lib 现场造在 `os.tmpdir()` 下，用例结束删除，仓库里不留临时文件。
 *
 * 渲染相关的断言（拆分的「拼回验证」、裁剪的「框外无 ink」）在**子进程**里跑，
 * 因为真实 canvas 需要的 `Path2D` 与 `test/support/dom-shim.mjs` 提供的替身冲突
 * （详见 `test/support/render-diff.mjs` 的模块说明）。
 *
 * Run: node --experimental-strip-types test/page-assembly.test.mjs
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFArray, PDFDocument, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib'
import { buildToolDefinitions } from '../src/host/tools.ts'
import { openPdfBytes } from '../src/core/pdf.ts'
import { extractTextLayer } from '../src/core/text-layer.ts'
import { runQpdf } from '../src/core/qpdf.ts'
import { parsePageOrder, parsePageSelection, readPageBoxes } from '../src/core/page-assembly.ts'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const close = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance
const planIdOf = text => {
  const match = /计划 id：(p_\w+)/.exec(text)
  if (match === null) throw new Error(`确认单里没有计划 id：\n${text}`)
  return match[1]
}

const WORK = mkdtempSync(join(tmpdir(), 'pdf-page-assembly-'))
const OUT = join(WORK, 'out')

/* ── 子进程渲染工具 ───────────────────────────────────────────────────────── */

const RENDER_DIFF = fileURLToPath(new URL('./support/render-diff.mjs', import.meta.url))

/** 在**不加载 dom-shim** 的子进程里渲染、合成、比较像素。 */
function renderDiff(spec) {
  const stdout = execFileSync(
    process.execPath,
    ['--experimental-strip-types', RENDER_DIFF, JSON.stringify(spec)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return JSON.parse(stdout.trim())
}

/* ── 夹具 ─────────────────────────────────────────────────────────────────── */

const EXAM = join(WORK, 'exam.pdf')          // 4 张规范 A3 横放 + 1 张 /Rotate 90 + 1 张 400×400
const PORTRAIT = join(WORK, 'portrait.pdf')  // 1 张竖放 A3（上下切成 297×210 ≠ A4）
const SEAM = join(WORK, 'seam.pdf')          // 中间有 20pt 空白缝
const BAR = join(WORK, 'bar.pdf')            // 中间有跨栏黑条
const PANELS = join(WORK, 'panels.pdf')      // 720×405「答案版 + 空白版并排」，中缝约 20pt
const PANELS_BAR = join(WORK, 'panels-bar.pdf') // 同上，但中缝被通栏黑条填满
const CROP = join(WORK, 'crop.pdf')          // 2 张 400×400，内容集中在中部
const ARRANGE = join(WORK, 'arrange.pdf')    // 4 张带标记的页面
const OTHER = join(WORK, 'other.pdf')        // 2 张带标记的页面（合并用）
const SINGLE = join(WORK, 'single-stream.pdf') // /Contents 是单条流（不是数组）的版本

await (async () => {
  {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 1; i <= 4; i += 1) {
      const page = doc.addPage([420, 297])
      // 标记都留在各自半页内，方便逐半核对文本层。
      page.drawText(`LEFT-PAGE-${i}`, { x: 30, y: 150, size: 18, font })
      page.drawText(`RIGHT-PAGE-${i}`, { x: 240, y: 150, size: 18, font })
    }
    const rotated = doc.addPage([420, 297])
    rotated.drawText('ROTATED', { x: 100, y: 150, size: 18, font })
    rotated.setRotation(degrees(90))
    const square = doc.addPage([400, 400])
    square.drawText('SQUARE', { x: 130, y: 190, size: 18, font })
    await writeFile(EXAM, await doc.save())
  }
  {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([297, 420])
    page.drawText('TOP-HALF', { x: 40, y: 300, size: 18, font })
    page.drawText('BOTTOM-HALF', { x: 40, y: 80, size: 18, font })
    await writeFile(PORTRAIT, await doc.save())
  }
  {
    const doc = await PDFDocument.create()
    const page = doc.addPage([420, 297])
    page.drawRectangle({ x: 0, y: 0, width: 200, height: 297, color: rgb(0, 0, 0) })
    page.drawRectangle({ x: 220, y: 0, width: 200, height: 297, color: rgb(0, 0, 0) })
    await writeFile(SEAM, await doc.save())
  }
  {
    const doc = await PDFDocument.create()
    const page = doc.addPage([420, 297])
    page.drawRectangle({ x: 0, y: 0, width: 200, height: 297, color: rgb(0, 0, 0) })
    page.drawRectangle({ x: 220, y: 0, width: 200, height: 297, color: rgb(0, 0, 0) })
    // 跨栏黑条：中线附近也有内容，测缝必须回退中线而不是硬报一个缝。
    page.drawRectangle({ x: 200, y: 0, width: 20, height: 297, color: rgb(0, 0, 0) })
    await writeFile(BAR, await doc.save())
  }
  {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    // 用户真实讲义的比例：720×405pt（254×143mm），左右两栏各带边框，中缝约 20pt。
    const page = doc.addPage([720, 405])
    page.drawRectangle({ x: 40, y: 40, width: 310, height: 325, borderColor: rgb(0, 0, 0), borderWidth: 2 })
    page.drawRectangle({ x: 370, y: 40, width: 310, height: 325, borderColor: rgb(0, 0, 0), borderWidth: 2 })
    page.drawText('PANEL-A-ANSWER', { x: 60, y: 210, size: 16, font })
    page.drawText('ANSWER-KEY', { x: 60, y: 170, size: 12, font })
    page.drawText('PANEL-B-BLANK', { x: 390, y: 210, size: 16, font })
    await writeFile(PANELS, await doc.save())
  }
  {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([720, 405])
    page.drawRectangle({ x: 40, y: 40, width: 310, height: 325, borderColor: rgb(0, 0, 0), borderWidth: 2 })
    page.drawRectangle({ x: 370, y: 40, width: 310, height: 325, borderColor: rgb(0, 0, 0), borderWidth: 2 })
    // 通栏黑条把中缝填满：必须回退中线，而不是硬报一个不存在的缝。
    page.drawRectangle({ x: 350, y: 0, width: 20, height: 405, color: rgb(0, 0, 0) })
    page.drawText('PANEL-A-ANSWER', { x: 60, y: 200, size: 16, font })
    page.drawText('PANEL-B-BLANK', { x: 390, y: 200, size: 16, font })
    await writeFile(PANELS_BAR, await doc.save())
  }
  {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (const [tag, inset] of [['A', 0], ['B', 12]]) {
      const page = doc.addPage([400, 400])
      page.drawRectangle({
        x: 120 + inset, y: 120 + inset, width: 160 - inset * 2, height: 160 - inset * 2,
        borderColor: rgb(0, 0, 0), borderWidth: 3,
      })
      page.drawText(tag, { x: 190, y: 195, size: 20, font })
    }
    await writeFile(CROP, await doc.save())
  }
  {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 1; i <= 4; i += 1) {
      doc.addPage([300, 400]).drawText(`PAGE-${i}`, { x: 40, y: 200, size: 20, font })
    }
    await writeFile(ARRANGE, await doc.save())
  }
  {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 1; i <= 2; i += 1) {
      doc.addPage([300, 200]).drawText(`B-${i}`, { x: 30, y: 100, size: 14, font })
    }
    await writeFile(OTHER, await doc.save())
  }
  {
    // pdf-lib 画出来的页面 /Contents 是**数组**；真实文件也常见**单条流**。
    // 这里把 exam 第 1 页改成单流版本，专门覆盖「单流 → [新流, 原流]」这条插入路径。
    const doc = await PDFDocument.load(new Uint8Array(await readFile(EXAM)))
    const page = doc.getPages()[0]
    const contents = page.node.get(PDFName.of('Contents'))
    if (contents instanceof PDFArray && contents.size() === 1) {
      page.node.set(PDFName.of('Contents'), contents.get(0))
    }
    await writeFile(SINGLE, await doc.save())
  }
})()

/* ── 工具实例与调用 ───────────────────────────────────────────────────────── */

// 默认策略（destructive）：四个页级装配工具都必须先给确认单。
const tools = new Map(buildToolDefinitions({ workspaceRoot: OUT }).map(tool => [tool.name, tool]))

/** 执行一个工具并取出渲染后的文本（`output.render` 必须返回数组）。 */
async function run(name, args) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`未定义的工具：${name}`)
  const value = await definition.execute(args)
  const rendered = definition.output.render(args, value)
  if (!Array.isArray(rendered)) throw new Error('output.render 必须返回数组')
  return rendered[0].text
}

/** 计划 → 确认 → 执行。 */
async function confirmed(name, args) {
  const plan = await run(name, { ...args, plan: true })
  return run(name, { ...args, confirm: planIdOf(plan) })
}

/** 捕获一个工具调用抛出的中文错误。 */
async function failureOf(fn) {
  try {
    await fn()
    return '(没有抛错)'
  } catch (error) {
    return String(error?.message ?? error)
  }
}

async function pageSizes(path) {
  const doc = await PDFDocument.load(new Uint8Array(await readFile(path)))
  return doc.getPages().map(page => {
    const boxes = readPageBoxes(page)
    return { width: boxes.width, height: boxes.height, rotate: boxes.rotate }
  })
}

async function pageTexts(path) {
  const doc = await openPdfBytes(new Uint8Array(await readFile(path)))
  try {
    const texts = []
    for (let n = 1; n <= doc.numPages; n += 1) {
      const lines = await extractTextLayer(doc, n)
      texts.push(lines.map(line => line.text).join(' '))
    }
    return texts
  } finally {
    await doc.dispose()
  }
}

console.log('页级装配：拆分 / 裁剪 / 重排 / 合并\n')

try {
  /* ── 1. 顺序解析（纯逻辑）──────────────────────────────────────────────── */

  console.log('1. 页序解析')
  check('odd-even 先奇后偶', JSON.stringify(parsePageOrder('odd-even', 6)) === JSON.stringify([0, 2, 4, 1, 3, 5]),
    JSON.stringify(parsePageOrder('odd-even', 6)))
  check('reverse 逆序', JSON.stringify(parsePageOrder('reverse', 4)) === JSON.stringify([3, 2, 1, 0]))
  check('swap-pairs 两两互换', JSON.stringify(parsePageOrder('swap-pairs', 6)) === JSON.stringify([1, 0, 3, 2, 5, 4]))
  check('区间与显式列表混合', JSON.stringify(parsePageOrder('1-3,7,5', 8)) === JSON.stringify([0, 1, 2, 6, 4]))
  check('越界给中文错误',
    (() => { try { parsePageSelection('9', 6); return false } catch (error) { return error.message === '顺序里的第 9 页超出文档页数 6' } })())
  check('无法解析的片段给中文错误',
    (() => { try { parsePageSelection('abc', 6); return false } catch (e) { return e.message.includes('无法解析') } })())
  check('区间起点大于终点给中文错误',
    (() => { try { parsePageSelection('5-3', 6); return false } catch (e) { return e.message.includes('起点大于终点') } })())

  /* ── 2. 拆分：门控 ─────────────────────────────────────────────────────── */

  console.log('\n2. pdf_split：确认门控')
  const examBytesBefore = new Uint8Array(await readFile(EXAM))
  const examHashBefore = sha(examBytesBefore)
  const splitOut = join(OUT, 'exam-split.pdf')

  const splitPlan = await run('pdf_split', { path: EXAM, output: splitOut })
  check('未确认时返回确认单（不是结果）', splitPlan.startsWith('⚠️ 这个操作需要你确认后才会执行。'), splitPlan.split('\n')[0])
  check('确认单列出要跳过的页与原因', splitPlan.includes('第 5 页') && splitPlan.includes('/Rotate 90°') && splitPlan.includes('第 6 页'))
  check('未确认时不落盘', !existsSync(splitOut))
  check('未确认时源文件字节不变', sha(new Uint8Array(await readFile(EXAM))) === examHashBefore)

  /* ── 3. 拆分：执行、页序、尺寸、文本层 ─────────────────────────────────── */

  console.log('\n3. pdf_split：执行结果')
  const splitDone = await run('pdf_split', { path: EXAM, output: splitOut, confirm: planIdOf(splitPlan) })
  check('结果首行是「已生成：输出路径」', splitDone.startsWith(`已生成：${splitOut}`), splitDone.split('\n')[0])
  check('结果给出每页切出的两页原页号', splitDone.includes('第 1 页 → 输出第 1、2 页'))

  const splitSizes = await pageSizes(splitOut)
  check('输出页数 = 合格页数 × 2（4 × 2 = 8）', splitSizes.length === 8, String(splitSizes.length))
  check('每页尺寸都是 210×297pt（±0.5pt）',
    splitSizes.every(size => close(size.width, 210) && close(size.height, 297)),
    splitSizes.map(size => `${size.width.toFixed(1)}x${size.height.toFixed(1)}`).join(' '))

  const splitTexts = await pageTexts(splitOut)
  const expectedOrder = [
    'LEFT-PAGE-1', 'RIGHT-PAGE-1', 'LEFT-PAGE-2', 'RIGHT-PAGE-2',
    'LEFT-PAGE-3', 'RIGHT-PAGE-3', 'LEFT-PAGE-4', 'RIGHT-PAGE-4',
  ]
  check('输出页序是 L1,R1,L2,R2…',
    expectedOrder.every((marker, index) => splitTexts[index].includes(marker)),
    splitTexts.map(text => text.trim().slice(0, 14)).join(' | '))
  check('左半页里没有右半的标记',
    splitTexts[0].includes('LEFT-PAGE-1') && !splitTexts[0].includes('RIGHT-PAGE-1'), splitTexts[0])
  check('右半页里没有左半的标记',
    splitTexts[1].includes('RIGHT-PAGE-1') && !splitTexts[1].includes('LEFT-PAGE-1'), splitTexts[1])
  check('不规范页被跳过并在结果里给出中文原因',
    splitDone.includes('跳过 2 页') && splitDone.includes('不是规范的 2-up 版面') && splitDone.includes('长宽比'),
    splitDone.split('\n').find(line => line.startsWith('跳过')) ?? '')

  console.log('\n3b. pdf_split：/Contents 是单条流时也能插平移')
  const singleOut = join(OUT, 'single-split.pdf')
  await confirmed('pdf_split', { path: SINGLE, pages: '1', output: singleOut })
  const singleSizes = await pageSizes(singleOut)
  const singleTexts = await pageTexts(singleOut)
  check('单流 /Contents 拆出两页 210×297，且文字各归其半',
    singleSizes.length === 2
    && singleSizes.every(size => close(size.width, 210) && close(size.height, 297))
    && singleTexts[0].includes('LEFT-PAGE-1') && !singleTexts[0].includes('RIGHT-PAGE-1')
    && singleTexts[1].includes('RIGHT-PAGE-1') && !singleTexts[1].includes('LEFT-PAGE-1'),
    `${JSON.stringify(singleSizes)} ${singleTexts.map(text => text.trim()).join(' | ')}`)

  /* ── 4. 拆分：拼回验证（真实 canvas，子进程）──────────────────────────── */

  console.log('\n4. 拆分：把两半拼回去和原页比像素')
  const rebuilt = renderDiff({
    scale: 1,
    left: { pages: [{ path: EXAM, page: 1 }] },
    right: { pages: [{ path: splitOut, page: 1 }, { path: splitOut, page: 2 }] },
  })
  check('拼回的尺寸与原 A3 一致',
    rebuilt.left.width === rebuilt.right.width && rebuilt.left.height === rebuilt.right.height,
    `${rebuilt.left.width}x${rebuilt.left.height} vs ${rebuilt.right.width}x${rebuilt.right.height}`)
  check('拼回像素差异 < 1%', rebuilt.diffRatio < 0.01,
    `diffRatio=${(rebuilt.diffRatio * 100).toFixed(3)}%（${rebuilt.diffPixels}/${rebuilt.totalPixels} 像素，maxDelta=${rebuilt.maxDelta}）`)
  const inkLeft = rebuilt.left.inkPt
  const inkRight = rebuilt.right.inkPt
  check('内容 bbox 完全吻合（±0.5pt）',
    inkLeft !== undefined && inkRight !== undefined
      && close(inkLeft.x, inkRight.x) && close(inkLeft.y, inkRight.y)
      && close(inkLeft.width, inkRight.width) && close(inkLeft.height, inkRight.height),
    `原 ${JSON.stringify(inkLeft)} / 拼回 ${JSON.stringify(inkRight)}`)

  /* ── 5. targetSize 只是提示 ───────────────────────────────────────────── */

  console.log('\n5. pdf_split：竖放 A3 切出 297×210 ≠ A4 —— 只提示，不拒绝')
  const portraitOut = join(OUT, 'portrait-split.pdf')
  const portraitDone = await confirmed('pdf_split', { path: PORTRAIT, output: portraitOut })
  const portraitSizes = await pageSizes(portraitOut)
  check('竖放 A3 仍能按上下切成两页 297×210', portraitSizes.length === 2
    && close(portraitSizes[0].width, 297) && close(portraitSizes[0].height, 210), JSON.stringify(portraitSizes))
  check('结果里提示切出来的不是 A4',
    portraitDone.includes('不是 A4（210×297pt）') && portraitDone.includes('297.0×210.0pt'),
    portraitDone.split('\n').find(line => line.includes('不是 A4')) ?? '')

  const portraitPlan = await run('pdf_split', { path: PORTRAIT, output: join(OUT, 'portrait-plan.pdf'), plan: true })
  check('确认单里也写明了「不是 A4」的提示',
    portraitPlan.includes('不是 A4') && portraitPlan.includes('待确认'),
    portraitPlan.split('\n').find(line => line.includes('不是 A4')) ?? '')
  check('targetSize=keep 时不出现 A4 提示', await (async () => {
    const out = join(OUT, 'portrait-keep.pdf')
    const text = await confirmed('pdf_split', { path: PORTRAIT, targetSize: 'keep', output: out })
    return !text.includes('不是 A4')
  })())

  console.log('\n5a. pdf_split：上下排列的 keep=top / bottom')
  const topOut = join(OUT, 'portrait-top.pdf')
  await confirmed('pdf_split', { path: PORTRAIT, keep: 'top', targetSize: 'keep', output: topOut })
  const topSizes = await pageSizes(topOut)
  const topTexts = await pageTexts(topOut)
  check('keep=top 只留上半（1 页 297×210，含 TOP-HALF）',
    topSizes.length === 1 && close(topSizes[0].width, 297) && close(topSizes[0].height, 210)
    && topTexts[0].includes('TOP-HALF') && !topTexts[0].includes('BOTTOM-HALF'),
    `${JSON.stringify(topSizes)} ${topTexts.join('|')}`)

  const bottomOut = join(OUT, 'portrait-bottom.pdf')
  await confirmed('pdf_split', { path: PORTRAIT, keep: 'bottom', targetSize: 'keep', output: bottomOut })
  const bottomTexts = await pageTexts(bottomOut)
  check('keep=bottom 只留下半（1 页，含 BOTTOM-HALF）',
    bottomTexts.length === 1 && bottomTexts[0].includes('BOTTOM-HALF') && !bottomTexts[0].includes('TOP-HALF'),
    bottomTexts.join('|'))
  check('keep=left 用在上下排列页上 → 拒绝 + 中文原因',
    (await failureOf(() => run('pdf_split', { path: PORTRAIT, keep: 'left', output: join(OUT, 'portrait-bad.pdf'), plan: true })))
      .includes('上下排列，keep=left 不适用；上下排列请用 keep=top|bottom'))

  /* ── 5b. 720×405「答案版 + 空白版并排」── 与纸张尺寸无关 ──────────────── */

  console.log('\n5b. pdf_split：720×405pt 讲义（答案版 / 空白版并排）')
  const panelsOut = join(OUT, 'panels-both.pdf')
  const panelsDone = await confirmed('pdf_split', { path: PANELS, output: panelsOut })
  const panelsSizes = await pageSizes(panelsOut)
  check('720×405pt 不被当成不规范（拆分成功，2 页）', panelsSizes.length === 2, String(panelsSizes.length))
  check('切出两页各 360×405pt（±0.5pt）',
    panelsSizes.every(size => close(size.width, 360) && close(size.height, 405)),
    panelsSizes.map(size => `${size.width.toFixed(1)}x${size.height.toFixed(1)}`).join(' '))
  const panelsTexts = await pageTexts(panelsOut)
  check('左半在前、右半在后', panelsTexts[0].includes('PANEL-A-ANSWER') && panelsTexts[1].includes('PANEL-B-BLANK'),
    panelsTexts.map(text => text.trim()).join(' | '))
  check('两页文字不串页',
    !panelsTexts[0].includes('PANEL-B-BLANK') && !panelsTexts[1].includes('PANEL-A-ANSWER'))
  check('结果里出现「不是 A4」的提示',
    panelsDone.includes('不是 A4') && panelsDone.includes('360.0×405.0pt') && panelsDone.includes('127×143mm'),
    panelsDone.split('\n').find(line => line.includes('不是 A4')) ?? '')
  const panelsAutoPlan = await run('pdf_split', { path: PANELS, gutter: 'auto', output: join(OUT, 'panels-auto.pdf'), plan: true })
  check('gutter=auto 在 720×405 讲义上测到的中缝接近中线 360pt', await (async () => {
    const value = Number(/切分线在 ([\d.]+)pt/.exec(panelsAutoPlan)?.[1] ?? 'NaN')
    return Number.isFinite(value) && Math.abs(value - 360) <= 6
  })(), /切分线在 ([\d.]+)pt/.exec(panelsAutoPlan)?.[1] ?? '')
  check('确认单里也提示了「不是 A4」', panelsAutoPlan.includes('不是 A4') && panelsAutoPlan.includes('360.0×405.0pt'))

  const panelsRebuilt = renderDiff({
    scale: 1,
    left: { pages: [{ path: PANELS, page: 1 }] },
    right: { pages: [{ path: panelsOut, page: 1 }, { path: panelsOut, page: 2 }] },
  })
  check('720×405 拼回原页的像素差异 < 1%', panelsRebuilt.diffRatio < 0.01,
    `diffRatio=${(panelsRebuilt.diffRatio * 100).toFixed(3)}%（${panelsRebuilt.diffPixels}/${panelsRebuilt.totalPixels}）`)
  check('720×405 拼回的内容 bbox 吻合（±0.5pt）',
    panelsRebuilt.left.inkPt !== undefined && panelsRebuilt.right.inkPt !== undefined
      && close(panelsRebuilt.left.inkPt.x, panelsRebuilt.right.inkPt.x)
      && close(panelsRebuilt.left.inkPt.width, panelsRebuilt.right.inkPt.width),
    `原 ${JSON.stringify(panelsRebuilt.left.inkPt)} / 拼回 ${JSON.stringify(panelsRebuilt.right.inkPt)}`)

  const panelsBarPlan = await run('pdf_split', { path: PANELS_BAR, gutter: 'auto', output: join(OUT, 'panels-bar.pdf') })
  check('中缝被通栏黑条填满 → 回退中线并写明「未找到可靠中缝」',
    panelsBarPlan.includes('未找到可靠中缝') && panelsBarPlan.includes('按中线对半'),
    panelsBarPlan.split('\n').find(line => line.includes('未找到可靠中缝')) ?? '')

  /* ── 5c. keep：只保留一半 ─────────────────────────────────────────────── */

  console.log('\n5c. pdf_split：keep=left / right')
  check('keep=left 页数 = 处理页数（1 页）', await (async () => {
    const out = join(OUT, 'panels-left.pdf')
    await confirmed('pdf_split', { path: PANELS, gutter: 'auto', keep: 'left', output: out })
    const texts = await pageTexts(out)
    return texts.length === 1 && texts[0].includes('PANEL-A-ANSWER') && !texts[0].includes('PANEL-B-BLANK')
  })())
  const keepRightDone = await confirmed('pdf_split', { path: PANELS, gutter: 'auto', keep: 'right', output: join(OUT, 'panels-right.pdf') })
  const keepRightTexts = await pageTexts(join(OUT, 'panels-right.pdf'))
  check('keep=right 只留右半（空白版标记），页数 = 处理页数',
    keepRightTexts.length === 1 && keepRightTexts[0].includes('PANEL-B-BLANK') && !keepRightTexts[0].includes('PANEL-A-ANSWER'),
    keepRightTexts.map(text => text.trim()).join(' | '))
  check('结果写清保留了哪一半', keepRightDone.includes('只保留了每页的右半'), keepRightDone.split('\n')[1] ?? '')
  check('keep 出现在确认单的参数行与影响行', await (async () => {
    const plan = await run('pdf_split', { path: PANELS, keep: 'right', output: join(OUT, 'panels-right-plan.pdf'), plan: true })
    return plan.includes('keep=right') && plan.includes('每页只保留右半')
  })())

  check('keep=top 用在左右排列页上 → 拒绝 + 中文原因',
    (await failureOf(() => run('pdf_split', { path: PANELS, keep: 'top', output: join(OUT, 'panels-bad.pdf'), plan: true })))
      .includes('左右排列，keep=top 不适用；左右排列请用 keep=left|right'))
  check('keep 不匹配时不落盘', !existsSync(join(OUT, 'panels-bad.pdf')))

  console.log('\n5d. keep 参与 planId')
  const keepGateOut = join(OUT, 'panels-keep-gate.pdf')
  const keepPlan = await run('pdf_split', { path: PANELS, keep: 'left', output: keepGateOut })
  const keepMismatch = await failureOf(() => run('pdf_split', {
    path: PANELS, keep: 'right', output: keepGateOut, confirm: planIdOf(keepPlan),
  }))
  check('keep 改值后带旧 planId 被拒绝', keepMismatch.includes('计划与本次参数不一致') && keepMismatch.includes('keep'))

  /* ── 6. gutter=auto 测缝与回退 ────────────────────────────────────────── */

  console.log('\n6. pdf_split：gutter=auto')
  const seamOut = join(OUT, 'seam-split.pdf')
  const seamPlan = await run('pdf_split', { path: SEAM, gutter: 'auto', output: seamOut })
  check('有 20pt 空白缝时测到接近中线的位置',
    seamPlan.includes('测到中缝') && seamPlan.includes('间隔 20.0pt') && seamPlan.includes('置信度 high'),
    seamPlan.split('\n').find(line => line.includes('测到中缝')) ?? '')
  const seamDetected = Number(/切分线在 ([\d.]+)pt/.exec(seamPlan)?.[1] ?? 'NaN')
  check('测缝位置在中线 ±3pt 内', Math.abs(seamDetected - 210) <= 3, String(seamDetected))
  await run('pdf_split', { path: SEAM, gutter: 'auto', output: seamOut, confirm: planIdOf(seamPlan) })
  check('auto 测缝后照常产出两页', (await pageSizes(seamOut)).length === 2)

  const barOut = join(OUT, 'bar-split.pdf')
  const barPlan = await run('pdf_split', { path: BAR, gutter: 'auto', output: barOut })
  check('中间有跨栏黑条时回退中线并说明原因',
    barPlan.includes('回退中线') && barPlan.includes('未找到可靠中缝'),
    barPlan.split('\n').find(line => line.includes('回退')) ?? '')

  /* ── 7. 裁剪：fixed ───────────────────────────────────────────────────── */

  console.log('\n7. pdf_crop：fixed 模式')
  const cropOut = join(OUT, 'crop-fixed.pdf')
  const cropBox = { left: 100, bottom: 100, right: 300, top: 300 }
  const cropPlan = await run('pdf_crop', { path: CROP, mode: 'fixed', box: cropBox, output: cropOut })
  check('fixed 模式确认单给出裁切框与「只裁不缩」',
    cropPlan.includes('只改页面框，不缩放内容') && cropPlan.includes('"left":100'),
    cropPlan.split('\n').find(line => line.startsWith('参数')) ?? '')
  const cropDone = await run('pdf_crop', { path: CROP, mode: 'fixed', box: cropBox, output: cropOut, confirm: planIdOf(cropPlan) })
  check('fixed 模式报出每页裁切框与被裁比例', cropDone.includes('[100.0, 100.0, 300.0, 300.0]') && cropDone.includes('裁掉'))

  const cropSizes = await pageSizes(cropOut)
  check('裁后页数正确（2 页）', cropSizes.length === 2, String(cropSizes.length))
  check('裁后尺寸 = box 尺寸（200×200pt）', cropSizes.every(size => close(size.width, 200) && close(size.height, 200)),
    JSON.stringify(cropSizes))

  const cropPixels = renderDiff({
    scale: 1.5,
    left: { pages: [{ path: CROP, page: 1 }], cropPt: [100, 100, 300, 300] },
    right: { pages: [{ path: cropOut, page: 1 }] },
  })
  check('裁剪区域与原图对应区域像素差异 < 1%', cropPixels.diffRatio < 0.01,
    `diffRatio=${(cropPixels.diffRatio * 100).toFixed(3)}%（${cropPixels.diffPixels}/${cropPixels.totalPixels}）`)
  const cropInk = cropPixels.left.inkPt
  check('裁切框外无 ink（全部内容都在框内）',
    cropInk !== undefined
      && cropInk.x >= 100 - 0.6 && cropInk.x + cropInk.width <= 300 + 0.6
      && cropInk.y >= 100 - 0.6 && cropInk.y + cropInk.height <= 300 + 0.6,
    JSON.stringify(cropInk))

  const cropOnlyOut = join(OUT, 'crop-only.pdf')
  await confirmed('pdf_crop', {
    path: CROP, mode: 'fixed', box: cropBox, setCropBoxOnly: true, output: cropOnlyOut,
  })
  const cropOnlyDoc = await PDFDocument.load(new Uint8Array(await readFile(cropOnlyOut)))
  const cropOnlyBoxes = readPageBoxes(cropOnlyDoc.getPages()[0])
  check('setCropBoxOnly=true 时只改 /CropBox、/MediaBox 保持原样',
    close(cropOnlyBoxes.mediaBox.width, 400) && close(cropOnlyBoxes.mediaBox.height, 400)
    && close(cropOnlyBoxes.cropBox.width, 200) && close(cropOnlyBoxes.cropBox.height, 200),
    `media=${JSON.stringify(cropOnlyBoxes.mediaBox)} crop=${JSON.stringify(cropOnlyBoxes.cropBox)}`)

  /* ── 8. 裁剪：trim + uniform ──────────────────────────────────────────── */

  console.log('\n8. pdf_crop：trim 模式')
  const trimOut = join(OUT, 'crop-trim.pdf')
  const trimDone = await confirmed('pdf_crop', { path: CROP, mode: 'trim', margin: 6, output: trimOut })
  const trimSizes = await pageSizes(trimOut)
  check('trim 收掉了白边（尺寸小于原页 400×400）',
    trimSizes.every(size => size.width < 400 && size.height < 400),
    JSON.stringify(trimSizes))
  check('uniform=true 时各页尺寸一致',
    close(trimSizes[0].width, trimSizes[1].width, 0.01) && close(trimSizes[0].height, trimSizes[1].height, 0.01),
    JSON.stringify(trimSizes))
  check('trim 结果说明边界来自渲染且只裁不缩', trimDone.includes('只裁不缩') && trimDone.includes('暗像素包围盒'))

  const trimInk = renderDiff({ scale: 1.5, left: { pages: [{ path: CROP, page: 1 }] }, right: { pages: [{ path: trimOut, page: 1 }] } })
  const trimLoaded = await PDFDocument.load(new Uint8Array(await readFile(trimOut)))
  const trimBox = readPageBoxes(trimLoaded.getPages()[0])
  check('trim 后裁切框仍包含全部内容（没有切掉正文）',
    trimInk.left.inkPt !== undefined
      && trimInk.left.inkPt.x >= trimBox.visible.x - 0.6
      && trimInk.left.inkPt.x + trimInk.left.inkPt.width <= trimBox.visible.x + trimBox.visible.width + 0.6,
    `ink=${JSON.stringify(trimInk.left.inkPt)} box=${JSON.stringify(trimBox.visible)}`)

  /* ── 9. 重排 ──────────────────────────────────────────────────────────── */

  console.log('\n9. pdf_arrange：页序 / 删除 / 旋转')
  const oddOut = join(OUT, 'arrange-odd-even.pdf')
  await confirmed('pdf_arrange', { path: ARRANGE, order: 'odd-even', output: oddOut })
  check('odd-even 页序正确（1,3,2,4）',
    JSON.stringify(await pageTexts(oddOut)) === JSON.stringify(['PAGE-1', 'PAGE-3', 'PAGE-2', 'PAGE-4']),
    (await pageTexts(oddOut)).join(','))

  const explicitOut = join(OUT, 'arrange-explicit.pdf')
  await confirmed('pdf_arrange', { path: ARRANGE, order: '3,1,4', output: explicitOut })
  check('显式序列页序正确（3,1,4）',
    JSON.stringify(await pageTexts(explicitOut)) === JSON.stringify(['PAGE-3', 'PAGE-1', 'PAGE-4']),
    (await pageTexts(explicitOut)).join(','))

  const reverseOut = join(OUT, 'arrange-reverse.pdf')
  const reverseDone = await confirmed('pdf_arrange', {
    path: ARRANGE, order: 'reverse', rotate: { pages: '1-2', angle: 90 }, output: reverseOut,
  })
  check('reverse 页序正确（4,3,2,1）',
    JSON.stringify(await pageTexts(reverseOut)) === JSON.stringify(['PAGE-4', 'PAGE-3', 'PAGE-2', 'PAGE-1']),
    (await pageTexts(reverseOut)).join(','))
  const reverseSizes = await pageSizes(reverseOut)
  check('rotate 后 /Rotate 正确（重排后第 1、2 页 = 90°）',
    reverseSizes[0].rotate === 90 && reverseSizes[1].rotate === 90
    && reverseSizes[2].rotate === 0 && reverseSizes[3].rotate === 0,
    reverseSizes.map(size => `${size.rotate}°`).join(','))
  check('旋转只改 /Rotate 并在结果里说明', reverseDone.includes('只改 /Rotate') && reverseDone.includes('0°→90°'))

  const deleteOut = join(OUT, 'arrange-delete.pdf')
  const deleteDone = await confirmed('pdf_arrange', { path: ARRANGE, order: '1,3,4', delete: '2', output: deleteOut })
  check('delete 删除原第 2 页后的页序正确',
    JSON.stringify(await pageTexts(deleteOut)) === JSON.stringify(['PAGE-1', 'PAGE-3', 'PAGE-4']),
    (await pageTexts(deleteOut)).join(','))
  check('delete 在结果里报出删除的原页号', deleteDone.includes('删除的原页号：第 2 页'))

  check('非法顺序给中文错误',
    (await failureOf(() => run('pdf_arrange', { path: ARRANGE, order: 'abc', output: join(OUT, 'never.pdf') }))).includes('无法解析'))
  check('order 与 delete 重叠给中文错误',
    (await failureOf(() => run('pdf_arrange', { path: ARRANGE, order: '1-4', delete: '2', output: join(OUT, 'never2.pdf') }))).includes('已被 delete 删除'))
  check('缺少 order 走计划而不是直接执行',
    (await run('pdf_arrange', { path: ARRANGE, output: join(OUT, 'never3.pdf'), plan: true })).includes('缺少关键参数'))

  /* ── 10. 合并 ─────────────────────────────────────────────────────────── */

  console.log('\n10. pdf_merge：合并与来源')
  const mergedOut = join(OUT, 'merged.pdf')
  const mergePlan = await run('pdf_merge', { paths: [EXAM, OTHER], ranges: ['1-2', '2'], output: mergedOut })
  const mergeDone = await run('pdf_merge', { paths: [EXAM, OTHER], ranges: ['1-2', '2'], output: mergedOut, confirm: planIdOf(mergePlan) })
  const mergedSizes = await pageSizes(mergedOut)
  check('合并页数正确（2 + 1 = 3）', mergedSizes.length === 3, String(mergedSizes.length))
  const mergedTexts = await pageTexts(mergedOut)
  check('合并后的来源顺序正确（exam 1-2 在前，other 第 2 页在后）',
    mergedTexts[0].includes('LEFT-PAGE-1') && mergedTexts[1].includes('LEFT-PAGE-2') && mergedTexts[2].includes('B-2'),
    mergedTexts.map(text => text.trim().slice(0, 20)).join(' | '))
  check('结果逐文件报出来源页号', mergeDone.includes('exam.pdf（第 1, 2 页）') && mergeDone.includes('other.pdf（第 2 页）'),
    mergeDone.split('\n')[1] ?? '')

  const fullOut = join(OUT, 'merged-full.pdf')
  await confirmed('pdf_merge', { paths: [EXAM, OTHER], output: fullOut })
  check('不给 ranges 时取全部页（6 + 2 = 8）', (await pageSizes(fullOut)).length === 8)

  /* ── 11. 门控：令牌与参数一致性 ───────────────────────────────────────── */

  console.log('\n11. 门控：改参数 / 重复使用令牌')
  const gateOut1 = join(OUT, 'gate-1.pdf')
  const gatePlan = await run('pdf_split', { path: EXAM, pages: '1', output: gateOut1 })
  const mismatch = await failureOf(() => run('pdf_split', {
    path: EXAM, pages: '1', targetSize: 'keep', output: gateOut1, confirm: planIdOf(gatePlan),
  }))
  check('改了 targetSize 后带旧 planId 被拒绝',
    mismatch.includes('计划与本次参数不一致') && mismatch.includes('targetSize'), mismatch.split('\n')[1] ?? '')
  check('被拒绝时不落盘', !existsSync(gateOut1))

  const arrangeGateOut = join(OUT, 'gate-arrange.pdf')
  const arrangePlan = await run('pdf_arrange', { path: ARRANGE, order: 'reverse', output: arrangeGateOut })
  const orderMismatch = await failureOf(() => run('pdf_arrange', {
    path: ARRANGE, order: 'odd-even', output: arrangeGateOut, confirm: planIdOf(arrangePlan),
  }))
  check('改了页序后带旧 planId 被拒绝', orderMismatch.includes('计划与本次参数不一致') && orderMismatch.includes('order'))

  const onceOut = join(OUT, 'gate-once.pdf')
  const oncePlan = await run('pdf_split', { path: EXAM, pages: '1', output: onceOut })
  const onceText = await run('pdf_split', { path: EXAM, pages: '1', output: onceOut, confirm: planIdOf(oncePlan) })
  check('第一次带正确令牌可执行', onceText.startsWith(`已生成：${onceOut}`))
  const reused = await failureOf(() => run('pdf_split', { path: EXAM, pages: '1', output: onceOut, confirm: planIdOf(oncePlan) }))
  check('同一 planId 二次执行被拒绝', reused.includes('已经执行过一次'), reused.split('\n')[0])

  /* ── 12. 错误路径 ─────────────────────────────────────────────────────── */

  console.log('\n12. 错误路径都给中文错误')
  check('文件不存在',
    (await failureOf(() => run('pdf_split', { path: join(WORK, 'nope.pdf'), output: join(OUT, 'x.pdf') }))).includes('文件不存在'))
  check('页码范围越界',
    (await failureOf(() => run('pdf_split', { path: EXAM, pages: '9', output: join(OUT, 'x.pdf') }))).includes('超出文档页数 6'))
  check('合并文件数少于 2',
    (await failureOf(() => run('pdf_merge', { paths: [EXAM], output: join(OUT, 'x.pdf') }))).includes('至少需要 2 个文件'))
  check('box 与页面完全没有交集',
    (await failureOf(() => confirmed('pdf_crop', {
      path: CROP, mode: 'fixed', box: { left: 1000, bottom: 1000, right: 1200, top: 1200 }, output: join(OUT, 'x.pdf'),
    }))).includes('没有交集'))
  check('mode=fixed 缺 box → 走 missing 且带 confirm 也不能绕过',
    (await failureOf(() => run('pdf_crop', { path: CROP, mode: 'fixed', output: join(OUT, 'x.pdf'), confirm: 'p_000000000000' })))
      .includes('缺少必需参数'))
  check('box 部分越界时收拢并在结果里提示', await (async () => {
    const out = join(OUT, 'clamped.pdf')
    const text = await confirmed('pdf_crop', {
      path: CROP, mode: 'fixed', box: { left: -50, bottom: -50, right: 250, top: 250 }, output: out,
    })
    return text.includes('已收拢')
  })())

  /* ── 13. qpdf 校验与源文件完整性 ──────────────────────────────────────── */

  console.log('\n13. 结构校验与源文件完整性')
  for (const [label, path] of [
    ['拆分输出', splitOut], ['裁剪输出', cropOut], ['重排输出', reverseOut], ['合并输出', mergedOut],
  ]) {
    const result = await runQpdf(['--check'], new Uint8Array(await readFile(path)), 'read-only')
    check(`qpdf --check 通过（${label}）`, result.exit === 0, result.output.split('\n').slice(-1)[0] ?? '')
  }
  const examHashAfter = sha(new Uint8Array(await readFile(EXAM)))
  check('源文件在所有操作后字节不变（exam.pdf）', examHashAfter === examHashBefore,
    `${examHashBefore.slice(0, 12)} → ${examHashAfter.slice(0, 12)}`)
  const allSources = [PORTRAIT, SEAM, BAR, CROP, ARRANGE, OTHER]
  const clobbered = allSources.filter(path => {
    // 源文件必须还在原位；输出全部落在 out/ 下，不会覆盖它们。
    return !existsSync(path)
  })
  check('所有源文件仍然存在且输出都写到了输出目录', clobbered.length === 0 && splitOut.startsWith(OUT), clobbered.join(','))
} finally {
  rmSync(WORK, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'ALL PAGE-ASSEMBLY CHECKS PASSED' : failed + ' check(s) FAILED'}`)
if (failed > 0) process.exitCode = 1
