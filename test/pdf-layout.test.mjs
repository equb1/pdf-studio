/**
 * 版面重排测试：统一尺寸/缩放、N-up、小册子。
 *
 * 断言从**结果文件**下手，而不是只看返回值：
 *   - 缩放：页面尺寸变成目标纸张，且**文字仍可提取、坐标按缩放比例走**（缩放不改内容语义）；
 *   - N-up：纸张数 = ⌈页数 ÷ 每张页数⌉，每张纸尺寸正确；
 *   - 小册子：**对折顺序**要对——第 1 面应该是「最后一页 + 第 1 页」（用文字层验证）；
 *   - 有注释时必须在结果里提示"注释位置不会跟着缩放"。
 *
 * Run: node --experimental-strip-types test/pdf-layout.test.mjs
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { buildToolDefinitions } from '../src/host/tools.ts'
import { openPdf, pageSize } from '../src/core/pdf.ts'
import { extractTextLayer } from '../src/core/text-layer.ts'
import { runQpdf } from '../src/core/qpdf.ts'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

const WORK = mkdtempSync(join(tmpdir(), 'pdf-layout-'))
const SRC = join(WORK, 'src.pdf')
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let n = 1; n <= 6; n += 1) {
    const page = doc.addPage([400, 300])
    page.drawText(`LAYOUT-PAGE-${n}`, { x: 40, y: 150, size: 18, font })
  }
  await writeFile(SRC, await doc.save())
}
const srcSha = sha(await readFile(SRC))
const toolsNever = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'never' }).map(d => [d.name, d]))
const toolsGated = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'destructive' }).map(d => [d.name, d]))
const run = args => toolsNever.get('pdf_layout').execute(args).then(value => value.text)
const out = name => join(WORK, name)
const textOf = async (path, page) => {
  const doc = await openPdf(path)
  try {
    return (await extractTextLayer(doc, page)).map(line => line.text).join(' | ')
  } finally {
    await doc.destroy?.()
  }
}
const sizeOf = async (path, page) => {
  const doc = await openPdf(path)
  try {
    const size = await pageSize(doc, page)
    return { width: size.width, height: size.height, pages: doc.numPages }
  } finally {
    await doc.destroy?.()
  }
}

// ── 1. resize ─────────────────────────────────────────────────────────────
{
  const target = out('resize-a4.pdf')
  const text = await run({ path: SRC, action: 'resize', pageSize: 'a4', output: target })
  const info = await sizeOf(target, 3)
  check('resize：页数不变', info.pages === 6, String(info.pages))
  check('resize：页面尺寸变成 A4（595.28×841.89 ±1pt）',
    Math.abs(info.width - 595.28) < 1 && Math.abs(info.height - 841.89) < 1,
    `${info.width.toFixed(1)}×${info.height.toFixed(1)}`)
  const body = await textOf(target, 1)
  check('resize：文字仍可提取（缩放不改变内容语义）', body.includes('LAYOUT-PAGE-1'), body.slice(0, 40))
  // 原始 x=40，等比缩放 ≈1.488、水平居中后 ≈59.5pt
  const doc = await openPdf(target)
  const line = (await extractTextLayer(doc, 1)).find(item => item.text.includes('LAYOUT-PAGE-1'))
  await doc.destroy?.()
  const expectedX = 40 * Math.min(595.28 / 400, 841.89 / 300) + Math.max(0, (595.28 - 400 * Math.min(595.28 / 400, 841.89 / 300)) / 2)
  check('resize：文字坐标按缩放比例平移（±3pt）',
    line !== undefined && Math.abs(line.rect.x - expectedX) < 3,
    `实际 x=${line?.rect.x?.toFixed(1)} 期望 ≈${expectedX.toFixed(1)}`)

  const subset = out('resize-12.pdf')
  await run({ path: SRC, action: 'resize', pageSize: 'a4', pages: '1-2', output: subset })
  check('resize：pages=1-2 只处理这两页', (await sizeOf(subset, 1)).pages === 2, String((await sizeOf(subset, 1)).pages))

  const stretch = out('resize-stretch.pdf')
  const stretchText = await run({ path: SRC, action: 'resize', pageSize: 'a5-landscape', mode: 'stretch', output: stretch })
  check('resize：stretch 模式说明写成"拉伸填满"', stretchText.includes('拉伸填满'), stretchText.split('\n')[1]?.slice(0, 60))
  check('resize：a5-landscape 也支持', (await sizeOf(stretch, 1)).width > (await sizeOf(stretch, 1)).height)
}

// ── 2. N-up ───────────────────────────────────────────────────────────────
{
  const target = out('nup4.pdf')
  const text = await run({ path: SRC, action: 'nup', perSheet: 4, pageSize: 'a4', output: target })
  const info = await sizeOf(target, 1)
  check('nup：纸张数 = ⌈6 ÷ 4⌉ = 2', info.pages === 2, String(info.pages))
  check('nup：纸张尺寸 = A4', Math.abs(info.width - 595.28) < 1 && Math.abs(info.height - 841.89) < 1,
    `${info.width.toFixed(0)}×${info.height.toFixed(0)}`)
  check('nup：第 1 张纸含前 4 页的文字', (await textOf(target, 1)).includes('LAYOUT-PAGE-4'), (await textOf(target, 1)).slice(0, 60))

  const nine = out('nup9.pdf')
  await run({ path: SRC, action: 'nup', perSheet: 9, pageSize: 'a4', output: nine })
  check('nup：perSheet=9 也支持（1 张纸装下 6 页）', (await sizeOf(nine, 1)).pages === 1)
}

// ── 3. 小册子：对折顺序 ───────────────────────────────────────────────────
{
  const target = out('booklet.pdf')
  const text = await run({ path: SRC, action: 'booklet', output: target })
  const info = await sizeOf(target, 1)
  check('booklet：6 页 → 3 个面', info.pages === 3, String(info.pages))
  check('booklet：纸张是横放（宽 > 高）', info.width > info.height, `${info.width.toFixed(0)}×${info.height.toFixed(0)}`)
  const first = await textOf(target, 1)
  const last = await textOf(target, 3)
  check('booklet：第 1 面 = 最后一页 + 第 1 页（对折顺序）',
    first.includes('LAYOUT-PAGE-6') && first.includes('LAYOUT-PAGE-1'), first.slice(0, 60))
  check('booklet：第 3 面 = 第 3 页 + 第 4 页',
    last.includes('LAYOUT-PAGE-3') && last.includes('LAYOUT-PAGE-4'), last.slice(0, 60))
  check('booklet：结果里说明是"打印后对折装订"', text.includes('对折装订'), text.split('\n')[1]?.slice(0, 60))
}

// ── 4. 有注释时必须提示（缩放不会带注释一起缩） ──────────────────────────
{
  const annotated = out('annotated.pdf')
  const annotate = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'never' }).map(d => [d.name, d]))
  await annotate.get('pdf_annotate').execute({
    path: SRC, action: 'highlight', page: 1, find: 'LAYOUT-PAGE-1', output: annotated,
  })
  const text = await run({ path: annotated, action: 'resize', pageSize: 'a4', output: out('annotated-resized.pdf') })
  check('有注释时：结果里提示"注释位置没有跟着缩放"',
    text.includes('注释') && text.includes('没有跟着缩放'), text.split('\n').find(line => line.includes('注释'))?.slice(0, 80))
  const nupText = await run({ path: annotated, action: 'nup', perSheet: 2, output: out('annotated-nup.pdf') })
  check('有注释时：拼版提示"不会带过去"', nupText.includes('没有带过去'), nupText.split('\n').find(line => line.includes('注释'))?.slice(0, 80))
}

// ── 5. 错误路径 ───────────────────────────────────────────────────────────
{
  const fail = async (args) => {
    try { await toolsNever.get('pdf_layout').execute(args) } catch (error) { return error.message }
    return ''
  }
  check('未知 action：中文错误', (await fail({ path: SRC, action: 'rotate' })).includes('未知 action'))
  check('不支持的纸张：中文错误并列出可用值', (await fail({ path: SRC, action: 'resize', pageSize: 'a2', output: out('x.pdf') })).includes('不支持'))
  check('不支持的 mode：中文错误', (await fail({ path: SRC, action: 'resize', mode: 'squash', output: out('x.pdf') })).includes('mode'))
  check('不支持的 perSheet：中文错误并列出可用值', (await fail({ path: SRC, action: 'nup', perSheet: 5, output: out('x.pdf') })).includes('不支持'))
  check('错误路径不产出文件', !existsSync(out('x.pdf')))
}

// ── 6. 门控 ───────────────────────────────────────────────────────────────
{
  const target = out('gated.pdf')
  const plan = (await toolsGated.get('pdf_layout').execute({
    path: SRC, action: 'resize', pageSize: 'a4', output: target,
  })).text
  check('未确认：返回确认单', plan.includes('需要你确认'), plan.split('\n')[0].slice(0, 50))
  check('未确认：不产出文件', !existsSync(target))
  const planId = /计划 id：(p_\w+)/.exec(plan)?.[1]
  check('确认单里的动作名是中文', plan.includes('统一页面尺寸'), plan.split('\n').filter(line => line.includes('动作')).join(''))

  let tampered = ''
  try {
    await toolsGated.get('pdf_layout').execute({
      path: SRC, action: 'resize', pageSize: 'letter', output: target, confirm: planId,
    })
  } catch (error) { tampered = error.message }
  check('改纸张后带旧 planId：拒绝', tampered.includes('不一致'), tampered.split('\n')[0].slice(0, 50))

  await toolsGated.get('pdf_layout').execute({ path: SRC, action: 'resize', pageSize: 'a4', output: target, confirm: planId })
  check('参数一致时带令牌可以执行', existsSync(target))
  let replay = ''
  try {
    await toolsGated.get('pdf_layout').execute({ path: SRC, action: 'resize', pageSize: 'a4', output: target, confirm: planId })
  } catch (error) { replay = error.message }
  check('同一令牌不能重复执行', replay.includes('已经执行过一次'), replay.slice(0, 50))

  const qpdf = await runQpdf(['--check'], new Uint8Array(await readFile(out('booklet.pdf'))), 'read-only')
  check('小册子产物通过 qpdf --check', qpdf.exit === 0, `exit=${qpdf.exit}`)
  check('源文件未被改动（sha256 不变）', sha(await readFile(SRC)) === srcSha)
}

rmSync(WORK, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'ALL PDF-LAYOUT CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
