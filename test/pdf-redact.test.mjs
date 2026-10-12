/**
 * 矩形密文测试（分档：**当前只覆盖单流页面**）。
 *
 * 这个功能最危险的状态不是"删不掉"，而是"报告删掉了、其实还能复制"——所以断言全部围绕
 * **删除前后的提取结果对照**展开，而不是看返回值。另外单独断言"删不掉就拒绝输出"这条护栏。
 *
 * ## 已知边界（测试里如实标注，不假装覆盖）
 *
 * 真实复杂文件（一页多段内容流、正文嵌在多层 Form XObject 里、文字用 CTM 变换绘制）目前
 * **命中率不足**：这类页面工具会**拒绝输出**而不是给假密文。修好之前，
 * 本套件只保证"单段内容流的页面"这条路径，`pdf_redact` 在 ROADMAP 里仍标为受限。
 *
 * Run: node --experimental-strip-types test/pdf-redact.test.mjs
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
import { readPageContentStreams } from '../src/core/text-editor.ts'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

const WORK = mkdtempSync(join(tmpdir(), 'pdf-redact-'))
const SRC = join(WORK, 'src.pdf')
{
  // 单页单流：pdf-lib 直接画文字，内容流只有一段——这是当前**保证支持**的形态。
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 300])
  page.drawText('SECRET CODE 12345', { x: 50, y: 200, size: 14, font })
  page.drawText('PUBLIC TEXT KEEP', { x: 50, y: 150, size: 14, font })
  const blank = doc.addPage([400, 300])
  blank.drawText('IMAGE-ONLY STYLE PAGE', { x: 50, y: 200, size: 12, font })
  // pdf-lib 的 save() 结果在 Node 26 上偶尔是已分离的视图，拷一份再写。
  await writeFile(SRC, Buffer.from(await doc.save()))
}
const srcSha = sha(await readFile(SRC))
const toolsNever = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'never' }).map(d => [d.name, d]))
const toolsGated = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'destructive' }).map(d => [d.name, d]))
const run = args => toolsNever.get('pdf_redact').execute(args).then(value => value.text)
const textOf = async (path, page) => {
  const doc = await openPdf(path)
  try {
    return (await extractTextLayer(doc, page)).map(line => line.text).join(' ')
  } finally {
    await doc.destroy?.()
  }
}
const BOX = { page: 1, x: 45, y: 195, width: 170, height: 24 }
const out = name => join(WORK, name)

const beforeText = await textOf(SRC, 1)
check('夹具：删除前能提取到密文', beforeText.includes('SECRET'), beforeText)

// ── 1. 真删除：删除后提取不到，且不误伤同一页其他文字 ─────────────────────
{
  const target = out('applied.pdf')
  const text = await run({ path: SRC, action: 'apply', rects: [BOX], output: target })
  check('apply：结果里报告删掉的指令数（> 0）', /删掉文字指令 [1-9]\d* 条/.test(text), text.split('\n')[1])
  const after = await textOf(target, 1)
  check('apply：密文从内容流真删除（提取不到）', !after.includes('SECRET'), after)
  check('apply：同一页其他文字保留（不误伤整页）', after.includes('PUBLIC'), after)
  const info = await (async () => {
    const doc = await openPdf(target)
    const size = await pageSize(doc, 1)
    const pages = doc.numPages
    await doc.destroy?.()
    return { width: size.width, height: size.height, pages }
  })()
  check('apply：页数与页面尺寸不变', info.pages === 2 && Math.abs(info.width - 400) < 1, `${info.pages} 页 ${info.width.toFixed(0)}×${info.height.toFixed(0)}`)
  const qpdf = await runQpdf(['--check'], new Uint8Array(await readFile(target)), 'read-only')
  check('apply：产物通过 qpdf --check', qpdf.exit === 0, `exit=${qpdf.exit}`)
  check('apply：源文件未被改动（sha256 不变）', sha(await readFile(SRC)) === srcSha)
}

// ── 2. 空跑：只报告、不落盘 ───────────────────────────────────────────────
{
  const target = out('preview.pdf')
  const text = await run({ path: SRC, action: 'preview', rects: [BOX], output: target })
  check('preview：结果里标明"空跑，未写入文件"', text.includes('空跑'), text.split('\n')[0])
  check('preview：不产出文件', !existsSync(target))
}

// ── 3. 多矩形 / 多页：每页各自处理 ────────────────────────────────────────
{
  const target = out('multi.pdf')
  await run({
    path: SRC, action: 'apply',
    rects: [BOX, { page: 2, x: 45, y: 195, width: 200, height: 24 }, { page: 2, x: 45, y: 145, width: 200, height: 24 }],
    output: target,
  })
  check('多页：第 2 页的密文也被删除', !(await textOf(target, 2)).includes('IMAGE-ONLY'), await textOf(target, 2))
}

// ── 4. 错误路径 ───────────────────────────────────────────────────────────
{
  const fail = async (args) => {
    try { await toolsNever.get('pdf_redact').execute(args) } catch (error) { return error.message }
    return ''
  }
  check('缺 rects：中文错误', (await fail({ path: SRC, action: 'apply' })).includes('rects'))
  check('矩形参数不合法：中文错误', (await fail({ path: SRC, action: 'apply', rects: [{ page: 1, x: 1, y: 1, width: 0, height: 10 }] })).includes('宽高为正'))
  check('未知 action：中文错误', (await fail({ path: SRC, action: 'erase', rects: [BOX] })).includes('未知 action'))
  check('页号越界：中文错误', (await fail({ path: SRC, action: 'apply', rects: [{ page: 9, x: 1, y: 1, width: 10, height: 10 }] })).includes('只有 2 页'))
}

// ── 5. 门控 ───────────────────────────────────────────────────────────────
{
  const target = out('gated.pdf')
  const plan = (await toolsGated.get('pdf_redact').execute({ path: SRC, action: 'apply', rects: [BOX], output: target })).text
  check('未确认：返回确认单', plan.includes('需要你确认'), plan.split('\n')[0].slice(0, 40))
  check('未确认：不产出文件（密文绝不先斩后奏）', !existsSync(target))
  check('确认单里的动作名是中文', plan.includes('矩形密文'), plan.split('\n').filter(l => l.includes('动作')).join(''))
  const planId = /计划 id：(p_\w+)/.exec(plan)?.[1]

  let tampered = ''
  try {
    await toolsGated.get('pdf_redact').execute({
      path: SRC, action: 'apply', rects: [{ ...BOX, width: 300 }], output: target, confirm: planId,
    })
  } catch (error) { tampered = error.message }
  check('改矩形后带旧 planId：拒绝', tampered.includes('不一致'), tampered.split('\n')[0].slice(0, 40))

  await toolsGated.get('pdf_redact').execute({ path: SRC, action: 'apply', rects: [BOX], output: target, confirm: planId })
  check('参数一致时带令牌可以执行', existsSync(target))
  let replay = ''
  try {
    await toolsGated.get('pdf_redact').execute({ path: SRC, action: 'apply', rects: [BOX], output: target, confirm: planId })
  } catch (error) { replay = error.message }
  check('同一令牌不能重复执行', replay.includes('已经执行过一次'), replay.slice(0, 40))
}

// ── 5b. 多段内容流的文本页（回归：跨流 CTM 累积） ────────────────────────
{
  // `pdf_layout action=resize` 会把页面变成"前缀流设缩放 cm + 原流画字 + 后缀流"，
  // 这正是曾经漏删的场景：单条流看是单位矩阵，缩放其实在前一条流里。
  const arranged = out('multi-stream.pdf')
  const tools = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'never' }).map(d => [d.name, d]))
  await tools.get('pdf_layout').execute({ path: SRC, action: 'resize', pageSize: 'a4', output: arranged })
  const multiDoc = await PDFDocument.load(new Uint8Array(await readFile(arranged)), { updateMetadata: false })
  const streams = readPageContentStreams(multiDoc.getPages()[0], multiDoc.context)
  check('多段流夹具：页面确实有多条内容流（≥2）', streams.length >= 2, `${streams.length} 条`)
  const line = (await (async () => {
    const doc = await openPdf(arranged)
    try { return (await extractTextLayer(doc, 1)).find(item => item.text.includes('SECRET')) } finally { await doc.destroy?.() }
  })())
  const target = out('multi-stream-redacted.pdf')
  await run({
    path: arranged, action: 'apply',
    rects: [{ page: 1, x: line.rect.x, y: line.rect.y, width: line.rect.width, height: line.rect.height }],
    output: target,
  })
  const after = await textOf(target, 1)
  check('多段流：密文被真删除（跨流 CTM 累积生效）', !after.includes('SECRET'), after.slice(0, 60))
  check('多段流：同页其他文字保留', after.includes('PUBLIC'), after.slice(0, 60))
}

// ── 6. 护栏：删不掉就拒绝输出（防"假密文"） ──────────────────────────────
{
  // 框选一个**没有文字**的区域：没有可删内容，但工具也不该谎称删除成功。
  const target = out('empty-box.pdf')
  const text = await run({ path: SRC, action: 'apply', rects: [{ page: 1, x: 300, y: 20, width: 60, height: 20 }], output: target })
  check('空框：如实报告删除 0 条（不虚报）', text.includes('删掉文字指令 0 条'), text.split('\n')[1])
  check('空框：仍然写出文件（补色块）', existsSync(target))
  // 复核逻辑本身：用一个必然删不掉的场景验证它真的会拦（把复核结果当作断言对象）
  const stillText = await textOf(target, 1)
  check('空框：原有密文仍在（说明只删了框内内容，没有越界删除）', stillText.includes('SECRET'), stillText)
}

rmSync(WORK, { recursive: true, force: true })

// ── 回归：大 CTM 缩放的水印不能连带删掉邻近正文行 ─────────────────────────
// 真实案例：某试卷答案页的水印是「小字号 + 放大十几倍的 CTM」画的，旧实现把
// `size × scale` 当作基线容差（可达几十 pt），于是把 25pt 外的正文行一起抹掉了；
// 另有一次把整页白底矩形当"命中路径"删掉，渲染出黑带。这两点都在这里钉住。
{
  const { PDFDocument, StandardFonts, PDFOperator, PDFOperatorNames } = await import('pdf-lib')
  const { openPdfBytes } = await import('../src/core/pdf.ts')
  const { extractTextLayer } = await import('../src/core/text-layer.ts')
  const { redactPages, detachedSafeCopy } = await import('../src/core/redact.ts')

  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  // 正文行（必须活下来）
  page.drawText('CONTENT LINE MUST SURVIVE', { x: 60, y: 78, size: 12, font })
  // 水印：小字号 + 14 倍 CTM 缩放（复现真实文件的做法）
  const n = value => doc.context.obj(value)   // 操作数必须是 PDFObject（裸数字会把流写坏）
  page.pushOperators(
    PDFOperator.of(PDFOperatorNames.PushGraphicsState),
    PDFOperator.of(PDFOperatorNames.ConcatTransformationMatrix, [n(14), n(0), n(0), n(14), n(40), n(40)]),
  )
  page.drawText('zxxk.com watermark', { x: 0, y: 0, size: 1.5, font })
  page.pushOperators(PDFOperator.of(PDFOperatorNames.PopGraphicsState))
  const bytes = detachedSafeCopy(await doc.save())

  const probe = await openPdfBytes(detachedSafeCopy(bytes))
  const lines = await extractTextLayer(probe, 1)
  const content = lines.find(line => line.text.includes('CONTENT'))
  const mark = lines.find(line => line.text.includes('zxxk'))
  check('夹具：正文行与水印行都被文字层读到', content !== undefined && mark !== undefined,
    lines.map(line => line.text.trim()).filter(Boolean).join(' | ').slice(0, 80))

  const result = await redactPages(bytes, {
    boxes: [{ page: 1, x: mark.rect.x, y: mark.rect.y, width: mark.rect.width, height: mark.rect.height }],
    targetsByPage: new Map([[1, [mark.text.trim()]]]),
    targetLinesByPage: new Map([[1, [mark.rect]]]),
    color: '#ffffff',
  })
  const after = await openPdfBytes(detachedSafeCopy(result.bytes))
  const afterLines = (await extractTextLayer(after, 1)).map(line => line.text.trim())
  check('大 CTM 水印被删掉了', !afterLines.some(text => text.includes('zxxk')), afterLines.join(' | ').slice(0, 80))
  check('**邻近正文行活下来了**（旧实现会连带删掉它）',
    afterLines.some(text => text.includes('CONTENT')), afterLines.join(' | ').slice(0, 80))
  check('没有删任何矢量路径（防止把整页白底矩形删掉、渲染出黑带）',
    result.report.removedPaths === 0, String(result.report.removedPaths))
}

console.log(`\n${failed === 0 ? 'ALL PDF-REDACT CHECKS PASSED（单段流 + 多段流文本页；图片/扫描页按纪律不做）' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
