/**
 * 页面写字测试：页码 / 页眉页脚 / Bates / 插入文字。
 *
 * 这四件事的验收标准是"**写进去的确实是真文字**"——所以断言从**结果文件的文字层**下手
 * （`extractTextLayer`），而不是只看返回值：写在内容流里的文字必须能被搜索到、坐标要对，
 * 而且不能把原有内容挤掉或改动页数。
 *
 * 另外钉住一条设计意图：**未知占位符不静默吞掉**——`{pages}` 这种拼错的占位符要原样写进页面，
 * 并在结果里明确提示，而不是被换成空串让人以为写对了。
 *
 * Run: node --experimental-strip-types test/pdf-text.test.mjs
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { buildToolDefinitions } from '../src/host/tools.ts'
import { openPdf } from '../src/core/pdf.ts'
import { extractTextLayer } from '../src/core/text-layer.ts'
import { runQpdf } from '../src/core/qpdf.ts'

const require = createRequire(import.meta.url)
const { createCanvas, loadImage } = require('@napi-rs/canvas')

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

const WORK = mkdtempSync(join(tmpdir(), 'pdf-text-'))
const SRC = join(WORK, 'src.pdf')
const out = name => join(WORK, name)

// ── 夹具：5 页 A4，每页一行可识别文字 ─────────────────────────────────────
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let n = 1; n <= 5; n += 1) {
    const page = doc.addPage([595, 842])
    page.drawText(`Fixture page ${n}`, { x: 60, y: 700, size: 16, font })
  }
  await writeFile(SRC, await doc.save())
}
const srcBytes = await readFile(SRC)
const srcSha = sha(srcBytes)
const toolsNever = new Map(
  buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'never' }).map(d => [d.name, d]),
)
const toolsGated = new Map(
  buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'destructive' }).map(d => [d.name, d]),
)
const run = args => toolsNever.get('pdf_text').execute(args).then(value => value.text)

/** 读出某页文字层（含每行坐标）。 */
async function linesOf(path, page) {
  const doc = await openPdf(path)
  try {
    return (await extractTextLayer(doc, page)).map(line => ({ text: line.text, rect: line.rect }))
  } finally {
    await doc.destroy?.()
  }
}
const textOfPage = async (path, page) => (await linesOf(path, page)).map(line => line.text).join(' | ')

// ── 1. 页码 ───────────────────────────────────────────────────────────────
{
  const target = out('number-default.pdf')
  await run({ path: SRC, action: 'page-number', pages: '1-2', output: target })
  check('页码：默认模板写出 {page} / {total}',
    (await textOfPage(target, 1)).includes('1 / 5') && (await textOfPage(target, 2)).includes('2 / 5'),
    await textOfPage(target, 1))
  check('页码：没选中的页没有被写', !(await textOfPage(target, 3)).includes('/ 5'), await textOfPage(target, 3))
  check('页码：页数不变', (await openPdf(target)).numPages === 5)

  const custom = out('number-custom.pdf')
  await run({ path: SRC, action: 'page-number', pages: '3', text: '第 {page} 页 / 共 {total} 页', start: 10, output: custom })
  check('页码：自定义模板 + start 偏移',
    (await textOfPage(custom, 3)).includes('第 10 页 / 共 5 页'), await textOfPage(custom, 3))

  const odd = out('number-odd.pdf')
  await run({ path: SRC, action: 'page-number', pages: 'odd', output: odd })
  check('页码：pages=odd 只写奇数页',
    (await textOfPage(odd, 1)).includes('1 / 5') && !(await textOfPage(odd, 2)).includes('/ 5'),
    `${await textOfPage(odd, 1)} || ${await textOfPage(odd, 2)}`)
}

// ── 2. 页眉页脚 ───────────────────────────────────────────────────────────
{
  const target = out('header-footer.pdf')
  await run({
    path: SRC, action: 'header-footer', pages: '1',
    header: '内部资料 · {date}', footer: '第 {page} / {total} 页 · {filename}',
    output: target,
  })
  const text = await textOfPage(target, 1)
  const today = new Date().toISOString().slice(0, 10)
  check('页眉：模板替换 {date}', text.includes('内部资料') && text.includes(today), text)
  check('页脚：模板替换 {page}/{total}/{filename}', text.includes('第 1 / 5 页') && text.includes(basename(SRC)), text)

  const lines = await linesOf(target, 1)
  const header = lines.find(line => line.text.includes('内部资料'))
  const footer = lines.find(line => line.text.includes('第 1 / 5 页'))
  check('页眉在上、页脚在下（按页面坐标）',
    header !== undefined && footer !== undefined && header.rect.y > footer.rect.y,
    `页眉 y=${header?.rect.y?.toFixed(0)} 页脚 y=${footer?.rect.y?.toFixed(0)}`)
}

// ── 3. Bates 编号 ─────────────────────────────────────────────────────────
{
  const target = out('bates.pdf')
  await run({ path: SRC, action: 'bates', pages: '2-4', prefix: 'DSH-', digits: 4, suffix: '-X', start: 7, output: target })
  const p2 = await textOfPage(target, 2)
  const p3 = await textOfPage(target, 3)
  const p4 = await textOfPage(target, 4)
  check('Bates：前缀/补零/后缀/起始号都对', p2.includes('DSH-0007-X'), p2)
  check('Bates：逐页递增（按选中顺序，不是页码）', p3.includes('DSH-0008-X') && p4.includes('DSH-0009-X'), `${p3} || ${p4}`)
  check('Bates：没选中的页没有编号', !(await textOfPage(target, 1)).includes('DSH-'), await textOfPage(target, 1))
}

// ── 4. 插入文字 ───────────────────────────────────────────────────────────
{
  const target = out('insert.pdf')
  await run({
    path: SRC, action: 'insert', pages: '1', text: '本页已校订\n（教务处）',
    rect: { x: 60, y: 300 }, fontSize: 12, color: '#b00020', background: '#fff3cd', output: target,
  })
  const text = await textOfPage(target, 1)
  check('插入：中文可提取（说明用的是嵌入字体的真文字）', text.includes('本页已校订'), text)
  check('插入：\\n 会写成两行', text.includes('（教务处）'), text)
  const lines = await linesOf(target, 1)
  const first = lines.find(line => line.text.includes('本页已校订'))
  check('插入：落点与 rect 的 y 大致吻合（±3pt）',
    first !== undefined && Math.abs(first.rect.y - 300) <= 3, `y=${first?.rect.y?.toFixed(1)}（期望 ≈300）`)
  check('插入：x 与 rect 吻合（±3pt）', first !== undefined && Math.abs(first.rect.x - 60) <= 3, `x=${first?.rect.x?.toFixed(1)}`)
}

// ── 5. 未知占位符：原样写入 + 明确提示 ────────────────────────────────────
{
  const target = out('unknown.pdf')
  const text = await run({ path: SRC, action: 'header-footer', pages: '1', header: '第 {pages} 页', output: target })
  check('未知占位符：原样写进页面（不静默替换成空）', (await textOfPage(target, 1)).includes('{pages}'), await textOfPage(target, 1))
  check('未知占位符：结果里明确提示', text.includes('{pages}') && text.includes('不是已知占位符'), text.split('\n').filter(line => line.includes('占位符')).join(''))
}

// ── 6. 错误路径与页选择 ───────────────────────────────────────────────────
{
  const bad = async (args) => {
    try { await run({ path: SRC, ...args, output: out('never.pdf') }) } catch (error) { return error.message }
    return ''
  }
  check('未知 action：中文错误', (await bad({ action: 'watermark' })).includes('未知 action'))
  check('非法 position：中文错误并列出可用值', (await bad({ action: 'insert', text: 'x', position: 'middle-top' })).includes('不是有效落点'))
  check('页范围倒序：中文错误', (await bad({ action: 'page-number', pages: '4-2' })).includes('不合法'))
  check('页码越界：中文错误', (await bad({ action: 'page-number', pages: '99' })).includes('不合法'))
  check('错误路径不产出文件', !existsSync(out('never.pdf')))
}

// ── 7. 门控 ───────────────────────────────────────────────────────────────
{
  const target = out('gated.pdf')
  const plan = (await toolsGated.get('pdf_text').execute({
    path: SRC, action: 'page-number', pages: '1', output: target,
  })).text
  check('未确认：返回确认单', plan.includes('需要你确认'), plan.split('\n')[0].slice(0, 50))
  check('未确认：不产出文件', !existsSync(target))
  const planId = /计划 id：(p_\w+)/.exec(plan)?.[1]

  let tampered = ''
  try {
    await toolsGated.get('pdf_text').execute({
      path: SRC, action: 'page-number', pages: '1', color: '#ff0000', output: target, confirm: planId,
    })
  } catch (error) { tampered = error.message }
  check('改参数（颜色）后带旧 planId：拒绝', tampered.includes('不一致'), tampered.split('\n')[0].slice(0, 50))

  await toolsGated.get('pdf_text').execute({ path: SRC, action: 'page-number', pages: '1', output: target, confirm: planId })
  check('参数一致时带令牌可以执行', existsSync(target))

  let replay = ''
  try {
    await toolsGated.get('pdf_text').execute({ path: SRC, action: 'page-number', pages: '1', output: target, confirm: planId })
  } catch (error) { replay = error.message }
  check('同一令牌不能重复执行', replay.includes('已经执行过一次'), replay.slice(0, 50))

  const missing = (await toolsGated.get('pdf_text').execute({ path: SRC, action: 'insert', pages: '1', output: out('nope.pdf') })).text
  check('insert 缺 text：确认单里说明缺什么', missing.includes('缺少关键参数') && missing.includes('text'), missing.split('\n').filter(line => line.includes('待确认')).join(''))
  const missingHf = (await toolsGated.get('pdf_text').execute({ path: SRC, action: 'header-footer', pages: '1', output: out('nope2.pdf') })).text
  check('header-footer 缺模板：确认单里说明缺什么', missingHf.includes('缺少关键参数') && missingHf.includes('header'), missingHf.split('\n').filter(line => line.includes('待确认')).join(''))
}

// ── 8. 结构校验与源文件不变 ───────────────────────────────────────────────
{
  const qpdf = await runQpdf(['--check'], new Uint8Array(await readFile(out('insert.pdf'))), 'read-only')
  check('产物通过 qpdf --check', qpdf.exit === 0, `exit=${qpdf.exit}`)
  check('源文件未被改动（sha256 不变）', sha(await readFile(SRC)) === srcSha)
}

// ── 9. 真实渲染：写上去的字必须真的可见（QuickLook） ─────────────────────
{
  let quickLook = true
  try { execFileSync('qlmanage', ['-h'], { stdio: 'ignore' }) } catch { quickLook = false }
  if (!quickLook) {
    check('QuickLook 渲染断言（本机没有 qlmanage，跳过）', true, 'SKIP')
  } else {
    const render = (pdf, tag) => {
      const dir = join(WORK, `ql-${tag}`)
      mkdirSync(dir, { recursive: true })
      execFileSync('qlmanage', ['-t', '-s', '1200', '-o', dir, pdf], { stdio: 'ignore' })
      const png = readdirSync(dir).find(name => name.endsWith('.png'))
      if (png === undefined) throw new Error(`QuickLook 没有为 ${pdf} 出图`)
      return join(dir, png)
    }
    try {
      const before = await loadImage(await readFile(render(SRC, 'before')))
      const after = await loadImage(await readFile(render(out('insert.pdf'), 'after')))
      const readPixels = async image => {
        const canvas = createCanvas(image.width, image.height)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(image, 0, 0)
        return ctx.getImageData(0, 0, image.width, image.height).data
      }
      const a = await readPixels(before)
      const b = await readPixels(after)
      // insert 落在 (60, 300)：换算到图像坐标（原点左上）附近统计差异
      const scale = before.width / 595
      const y0 = Math.max(0, Math.round((842 - 300 - 40) * scale))
      const y1 = Math.min(before.height, Math.round((842 - 300 + 40) * scale))
      const x0 = Math.max(0, Math.round(40 * scale))
      const x1 = Math.min(before.width, Math.round(260 * scale))
      let inside = 0
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * before.width + x) * 4
          const delta = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
          if (delta > 16) inside += 1
        }
      }
      check('QuickLook 渲染：插入的文字与底衬真的出现在目标区域', inside > 200, `${inside} px（区域 ${x1 - x0}×${y1 - y0}）`)
    } catch (error) {
      check('QuickLook 渲染断言', false, error.message.slice(0, 100))
    }
  }
}

rmSync(WORK, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'ALL PDF-TEXT CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
