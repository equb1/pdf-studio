/**
 * 注释标注测试：8 个 action 的**注释字典结构**、几何、门控与错误路径。
 *
 * 为什么从结果文件下手而不是看返回值：注释最容易出的错是"工具说加好了、阅读器里什么都没有"。
 * 所以这里既断言 `/Annots` 里的字典（Subtype / /F 4 / QuadPoints / `/AP`），
 * 也用 macOS QuickLook（PDFKit，认识注释）真实渲染一次，按像素确认"真的画出来了"。
 *
 * 两个来自真机的教训（本文件把它们钉死）：
 *   1. **文本标记与方框/椭圆必须带 `/AP`**：不带时 PDFKit 完全不画（实测 0 像素差异）；
 *   2. `/Annots` 里的元素是**间接引用**，`PDFRef.lookup()` 不带 context 会返回 undefined
 *      ——必须用 `doc.context.lookup(ref)`，否则会把"有注释"报成 0 个。
 *
 * Run: node --experimental-strip-types test/annotate.test.mjs
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { buildToolDefinitions } from '../src/host/tools.ts'
import { runQpdf } from '../src/core/qpdf.ts'
import { extractTextLayer } from '../src/core/text-layer.ts'
import { openPdf } from '../src/core/pdf.ts'

const require = createRequire(import.meta.url)
const { createCanvas, loadImage } = require('@napi-rs/canvas')

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

const WORK = mkdtempSync(join(tmpdir(), 'pdf-annotate-'))
const SRC = join(WORK, 'src.pdf')
const out = name => join(WORK, name)

// ── 夹具：两页，页 1 有两行真实文字（pdf.js 文字层读得到，find 才可用） ──────
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([595, 842])
  p1.drawText('Hello annotation world', { x: 60, y: 700, size: 18, font })
  p1.drawText('Second line for highlighting', { x: 60, y: 660, size: 18, font })
  const p2 = doc.addPage([595, 842])
  p2.drawText('Control page without marks', { x: 60, y: 700, size: 18, font })
  await writeFile(SRC, await doc.save())
}
const srcBytes = await readFile(SRC)
const srcSha = sha(srcBytes)

const run = async (args) => (await toolsNever.get('pdf_annotate').execute(args)).text
const toolsNever = new Map(
  buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'never' }).map(d => [d.name, d]),
)
const toolsGated = new Map(
  buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'destructive' }).map(d => [d.name, d]),
)

/** 读出结果文件里的所有注释（元素是间接引用，必须用 context 解引用）。 */
async function readAnnotations(path) {
  const doc = await PDFDocument.load(new Uint8Array(await readFile(path)), { updateMetadata: false })
  const found = []
  for (const [index, page] of doc.getPages().entries()) {
    const annots = page.node.Annots()
    if (!(annots instanceof PDFArray)) continue
    for (const entry of annots.asArray()) {
      const dict = doc.context.lookup(entry)
      if (dict instanceof PDFDict) found.push({ page: index + 1, dict })
    }
  }
  return { doc, found }
}
const fieldOf = (dict, key) => dict.get(PDFName.of(key))
const numberOf = (dict, key) => {
  const value = fieldOf(dict, key)
  return value === undefined ? undefined : Number(String(value))
}
/** 读出 PDF 字符串的**文本**：`PDFString.of('中文')` 存的是 UTF-16BE，必须 decodeText()。 */
const textOf = (dict, key) => {
  const value = fieldOf(dict, key)
  if (value === undefined) return undefined
  if (typeof value.decodeText === 'function') return value.decodeText()
  return String(value)
}
const arrayOf = (dict, key) => {
  const value = fieldOf(dict, key)
  return value instanceof PDFArray ? value.asArray().map(item => Number(String(item))) : undefined
}

// ── 1. 八个动作：结构断言 ──────────────────────────────────────────────────
const CASES = [
  ['highlight', { action: 'highlight', page: 1, find: 'annotation' }, 'Highlight', true],
  ['underline', { action: 'underline', page: 1, find: 'Second line' }, 'Underline', true],
  ['strikeout', { action: 'strikeout', page: 1, find: 'world' }, 'StrikeOut', true],
  ['box', { action: 'box', page: 1, rect: { x: 60, y: 100, width: 200, height: 50 } }, 'Square', false],
  ['ellipse', { action: 'ellipse', page: 1, rect: { x: 300, y: 100, width: 120, height: 60 } }, 'Circle', false],
  ['note', { action: 'note', page: 1, rect: { x: 500, y: 700, width: 24, height: 24 }, contents: '复核这里' }, 'Text', false],
  ['freetext', { action: 'freetext', page: 1, rect: { x: 60, y: 560, width: 240, height: 30 }, contents: '已校订' }, 'FreeText', false],
  ['stamp', { action: 'stamp', page: 2, rect: { x: 300, y: 600, width: 140, height: 60 }, contents: '已阅' }, 'Stamp', false],
]
for (const [label, args, subtype, markup] of CASES) {
  const target = out(`annot-${label}.pdf`)
  try {
    await run({ path: SRC, ...args, output: target })
  } catch (error) {
    check(`${label}：执行成功`, false, error.message.slice(0, 90))
    continue
  }
  const { doc, found } = await readAnnotations(target)
  const one = found[0]?.dict
  check(`${label}：写出 1 个注释`, found.length === 1, `${found.length} 个`)
  check(`${label}：子类型 = /${subtype}`,
    one !== undefined && String(fieldOf(one, 'Subtype')) === `/${subtype}`,
    one === undefined ? '（没有注释）' : String(fieldOf(one, 'Subtype')))
  check(`${label}：带 Print 标志 /F 4（否则打印看不到）`, numberOf(one, 'F') === 4, String(numberOf(one, 'F')))
  check(`${label}：有 /AP 外观流（阅读器不会自己画）`, fieldOf(one, 'AP') !== undefined)
  check(`${label}：/Rect 是 4 个数`, (arrayOf(one, 'Rect') ?? []).length === 4)
  check(`${label}：页数不变`, doc.getPageCount() === 2, String(doc.getPageCount()))
  if (markup) {
    const quads = arrayOf(one, 'QuadPoints')
    check(`${label}：有 /QuadPoints（≥ 8 个数）`, (quads ?? []).length >= 8, String((quads ?? []).length))
  } else {
    check(`${label}：没有 /QuadPoints（几何由 /Rect 描述）`, fieldOf(one, 'QuadPoints') === undefined)
  }
}

// ── 2. 定位几何：QuadPoints 要贴着那一行 ──────────────────────────────────
{
  const { found } = await readAnnotations(out('annot-highlight.pdf'))
  const quads = arrayOf(found[0].dict, 'QuadPoints')
  const doc = await openPdf(SRC)
  const lines = await extractTextLayer(doc, 1)
  await doc.destroy?.()
  const line = lines.find(item => item.text.includes('annotation'))
  const top = Math.max(quads[1], quads[3])
  const bottom = Math.min(quads[5], quads[7])
  check('highlight：QuadPoints 的上下边与文本行吻合（±2pt）',
    line !== undefined && Math.abs(top - (line.rect.y + line.rect.height)) <= 2 && Math.abs(bottom - line.rect.y) <= 2,
    `quads y=[${bottom.toFixed(1)}, ${top.toFixed(1)}] 行=[${line?.rect.y.toFixed(1)}, ${(line ? line.rect.y + line.rect.height : 0).toFixed(1)}]`)
  const lineLeft = line?.rect.x ?? 0
  const lineRight = line === undefined ? 0 : line.rect.x + line.rect.width
  check('highlight：QuadPoints 的左右落在该行范围内',
    Math.min(quads[0], quads[4]) >= lineLeft - 1 && Math.max(quads[2], quads[6]) <= lineRight + 1,
    `quads x=[${Math.min(quads[0], quads[4]).toFixed(1)}, ${Math.max(quads[2], quads[6]).toFixed(1)}] 行=[${lineLeft.toFixed(1)}, ${lineRight.toFixed(1)}]`)
}

// ── 3. 内容/样式入参 ──────────────────────────────────────────────────────
{
  const { found } = await readAnnotations(out('annot-note.pdf'))
  check('note：默认图标 /Comment', String(fieldOf(found[0].dict, 'Name')) === '/Comment', String(fieldOf(found[0].dict, 'Name')))
  check('note：/Contents 是给定的文字', (textOf(found[0].dict, 'Contents') ?? '').includes('复核这里'), String(textOf(found[0].dict, 'Contents')))

  const iconOut = out('annot-note-key.pdf')
  await run({ path: SRC, action: 'note', page: 1, rect: { x: 400, y: 400, width: 24, height: 24 }, contents: '重点', icon: 'Key', output: iconOut })
  const key = await readAnnotations(iconOut)
  check('note：icon=Key 写进 /Name', String(fieldOf(key.found[0].dict, 'Name')) === '/Key', String(fieldOf(key.found[0].dict, 'Name')))

  const styled = out('annot-styled.pdf')
  await run({ path: SRC, action: 'highlight', page: 1, find: 'Hello', color: '#00ff00', opacity: 0.8, output: styled })
  const style = await readAnnotations(styled)
  const color = arrayOf(style.found[0].dict, 'C')
  check('highlight：自定义颜色写进 /C', (color ?? []).map(v => v.toFixed(2)).join(',') === '0.00,1.00,0.00', String(color))
  check('highlight：自定义不透明度写进 /CA', Math.abs(numberOf(style.found[0].dict, 'CA') - 0.8) < 0.001, String(numberOf(style.found[0].dict, 'CA')))

  const border = out('annot-border.pdf')
  await run({ path: SRC, action: 'box', page: 1, rect: { x: 100, y: 100, width: 80, height: 40 }, borderWidth: 3, output: border })
  const bordered = await readAnnotations(border)
  check('box：borderWidth 写进 /Border', (arrayOf(bordered.found[0].dict, 'Border') ?? [])[2] === 3, String(arrayOf(bordered.found[0].dict, 'Border')))
  const rect = arrayOf(bordered.found[0].dict, 'Rect')
  check('box：/Rect 与入参一致（±0.5pt）',
    rect !== undefined && Math.abs(rect[0] - 100) < 0.5 && Math.abs(rect[1] - 100) < 0.5 && Math.abs(rect[2] - 180) < 0.5 && Math.abs(rect[3] - 140) < 0.5,
    String(rect))

  const free = await readAnnotations(out('annot-freetext.pdf'))
  check('freetext：有 /DA 默认外观串', fieldOf(free.found[0].dict, 'DA') !== undefined)
}

// ── 4. 错误路径 ───────────────────────────────────────────────────────────
{
  const missOut = out('annot-missing.pdf')
  let message = ''
  try { await run({ path: SRC, action: 'highlight', page: 1, find: '这句话不存在', output: missOut }) } catch (error) { message = error.message }
  check('find 找不到：中文错误并提示该页内容', message.includes('没有找到') && message.includes('这一页前几行'), message.slice(0, 80))
  check('find 找不到：不产出文件', !existsSync(missOut))

  let badAction = ''
  try { await run({ path: SRC, action: 'sparkle', page: 1, rect: { x: 1, y: 1, width: 10, height: 10 }, output: out('x.pdf') }) } catch (error) { badAction = error.message }
  check('未知 action：中文错误', badAction.includes('未知 action'), badAction.slice(0, 60))

  let badIcon = ''
  try { await run({ path: SRC, action: 'note', page: 1, rect: { x: 1, y: 1, width: 20, height: 20 }, contents: 'x', icon: 'Sparkles', output: out('y.pdf') }) } catch (error) { badIcon = error.message }
  check('非法 icon：中文错误并列出可用值', badIcon.includes('icon') && badIcon.includes('Comment'), badIcon.slice(0, 70))

  const clampOut = out('annot-clamp.pdf')
  await run({ path: SRC, action: 'box', page: 1, rect: { x: 580, y: 830, width: 200, height: 200 }, output: clampOut })
  const clamped = await readAnnotations(clampOut)
  const clampedRect = arrayOf(clamped.found[0].dict, 'Rect')
  check('rect 越界：收拢到页面内而不是报错',
    clampedRect !== undefined && clampedRect[2] <= 595 + 0.5 && clampedRect[3] <= 842 + 0.5 && clampedRect[2] > clampedRect[0],
    String(clampedRect))
}

// ── 5. 门控：未确认不落盘、改参数被拒、一次性 ──────────────────────────────
{
  const gatedOut = out('annot-gated.pdf')
  const plan = (await toolsGated.get('pdf_annotate').execute({
    path: SRC, action: 'highlight', page: 1, find: 'Hello', output: gatedOut,
  })).text
  check('未确认：返回确认单', plan.includes('需要你确认'), plan.split('\n')[0].slice(0, 60))
  check('未确认：不产出文件', !existsSync(gatedOut))
  const planId = /计划 id：(p_\w+)/.exec(plan)?.[1]
  check('确认单里有计划 id', typeof planId === 'string' && planId.startsWith('p_'))

  let tampered = ''
  try {
    await toolsGated.get('pdf_annotate').execute({
      path: SRC, action: 'highlight', page: 1, find: 'Hello', color: '#123456', output: gatedOut, confirm: planId,
    })
  } catch (error) { tampered = error.message }
  check('改参数后带旧 planId：拒绝', tampered.includes('不一致'), tampered.split('\n')[0].slice(0, 60))
  check('被拒后仍未落盘', !existsSync(gatedOut))

  await toolsGated.get('pdf_annotate').execute({
    path: SRC, action: 'highlight', page: 1, find: 'Hello', output: gatedOut, confirm: planId,
  })
  check('参数一致时带令牌可以执行', existsSync(gatedOut))

  let replay = ''
  try {
    await toolsGated.get('pdf_annotate').execute({
      path: SRC, action: 'highlight', page: 1, find: 'Hello', output: gatedOut, confirm: planId,
    })
  } catch (error) { replay = error.message }
  check('同一令牌不能重复执行', replay.includes('已经执行过一次'), replay.slice(0, 60))

  const missingPlan = (await toolsGated.get('pdf_annotate').execute({
    path: SRC, action: 'highlight', page: 1, output: out('annot-nofind.pdf'),
  })).text
  check('缺 find：给确认单并说明缺什么', missingPlan.includes('缺少关键参数') && missingPlan.includes('find'), missingPlan.split('\n').filter(l => l.includes('待确认')).join(''))
}

// ── 6. pdf_inspect 会报注释；qpdf 校验；源文件未变 ────────────────────────
{
  const inspectText = (await toolsNever.get('pdf_inspect').execute({ path: out('annot-stamp.pdf') })).text
  check('pdf_inspect 报出注释数量与子类型',
    inspectText.includes('注释：1 个') && inspectText.includes('Stamp ×1'),
    inspectText.split('\n').filter(line => line.includes('注释')).join(''))

  const qpdf = await runQpdf(['--check'], new Uint8Array(await readFile(out('annot-highlight.pdf'))), 'read-only')
  check('注释产物通过 qpdf --check', qpdf.exit === 0, `exit=${qpdf.exit}`)
  check('源文件未被改动（sha256 不变）', sha(await readFile(SRC)) === srcSha)
}

// ── 7. 真实渲染：QuickLook（PDFKit）必须真的把注释画出来 ──────────────────
{
  const render = (pdf, tag) => {
    const dir = join(WORK, `ql-${tag}`)
    mkdirSync(dir, { recursive: true })
    execFileSync('qlmanage', ['-t', '-s', '1200', '-o', dir, pdf], { stdio: 'ignore' })
    const png = readdirSync(dir).find(name => name.endsWith('.png'))
    if (png === undefined) throw new Error(`QuickLook 没有为 ${pdf} 出图`)
    return join(dir, png)
  }
  let quickLook = true
  try { execFileSync('qlmanage', ['-h'], { stdio: 'ignore' }) } catch { quickLook = false }
  if (!quickLook) {
    check('QuickLook 渲染断言（本机没有 qlmanage，跳过）', true, 'SKIP')
  } else {
    try {
      const before = await loadImage(await readFile(render(SRC, 'before')))
      const after = await loadImage(await readFile(render(out('annot-highlight.pdf'), 'after')))
      const canvas = createCanvas(before.width, before.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(before, 0, 0)
      const beforePixels = ctx.getImageData(0, 0, before.width, before.height).data
      const canvas2 = createCanvas(after.width, after.height)
      const ctx2 = canvas2.getContext('2d')
      ctx2.drawImage(after, 0, 0)
      const afterPixels = ctx2.getImageData(0, 0, after.width, after.height).data
      let diff = 0, minY = 1e9, maxY = -1, r = 0, g = 0, b = 0
      for (let y = 0; y < before.height; y++) {
        for (let x = 0; x < before.width; x++) {
          const i = (y * before.width + x) * 4
          const delta = Math.max(
            Math.abs(beforePixels[i] - afterPixels[i]),
            Math.abs(beforePixels[i + 1] - afterPixels[i + 1]),
            Math.abs(beforePixels[i + 2] - afterPixels[i + 2]),
          )
          if (delta > 16) {
            diff += 1
            if (y < minY) minY = y
            if (y > maxY) maxY = y
            r += afterPixels[i]; g += afterPixels[i + 1]; b += afterPixels[i + 2]
          }
        }
      }
      check('QuickLook 渲染：高亮真的被画出来了（像素差异 > 0）', diff > 100, `${diff} px`)
      const mean = diff === 0 ? [0, 0, 0] : [r / diff, g / diff, b / diff]
      check('QuickLook 渲染：差异区偏黄（R、G 高，B 低）',
        mean[0] > mean[2] + 20 && mean[1] > mean[2] + 10,
        `平均 RGB (${mean.map(v => Math.round(v)).join(', ')})`)
      // 夹具是 595×842，文字在 y=700 附近（图像坐标里靠上）
      check('QuickLook 渲染：差异落在注释所在的文字带内', minY < before.height * 0.4 && maxY < before.height * 0.45,
        `y [${minY}, ${maxY}] / 高 ${before.height}`)
    } catch (error) {
      check('QuickLook 渲染断言', false, error.message.slice(0, 100))
    }
  }
}

rmSync(WORK, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'ALL ANNOTATE CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
