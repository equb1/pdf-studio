/**
 * 体积/结构优化 + 两版差异 测试。
 *
 * 优化最容易出的错是"改坏了文件却报告成功"，所以断言从**结果文件**下手：
 * 页数、文字层、`qpdf --check` 全部要与源文件一致；体积变化则**如实断言**（可能没变小）。
 * `compare` 是只读，断言它精确报出增删行、且对扫描件如实说"无法比对"。
 *
 * Run: node --experimental-strip-types test/pdf-optimize.test.mjs
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { buildToolDefinitions } from '../src/host/tools.ts'
import { openPdf } from '../src/core/pdf.ts'
import { extractTextLayer } from '../src/core/text-layer.ts'
import { runQpdf } from '../src/core/qpdf.ts'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

const WORK = mkdtempSync(join(tmpdir(), 'pdf-optimize-'))
const A = join(WORK, 'a.pdf')
const B = join(WORK, 'b.pdf')
{
  const make = async (path, extraPage, changedLine) => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const p1 = doc.addPage([400, 300])
    p1.drawText('ALPHA LINE ONE', { x: 40, y: 200, size: 14, font })
    p1.drawText(changedLine, { x: 40, y: 160, size: 14, font })
    doc.addPage([400, 300]).drawText('ALPHA PAGE TWO', { x: 40, y: 200, size: 14, font })
    if (extraPage) doc.addPage([400, 300]).drawText('ALPHA PAGE THREE', { x: 40, y: 200, size: 14, font })
    await writeFile(path, Buffer.from(await doc.save()))
  }
  await make(A, false, 'SHARED LINE')
  await make(B, true, 'CHANGED LINE')
}
const aSha = sha(await readFile(A))
const toolsNever = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'never' }).map(d => [d.name, d]))
const toolsGated = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'destructive' }).map(d => [d.name, d]))
const run = args => toolsNever.get('pdf_optimize').execute(args).then(value => value.text)
const out = name => join(WORK, name)
const textOf = async (path, page) => {
  const doc = await openPdf(path)
  try {
    return (await extractTextLayer(doc, page)).map(line => line.text).join(' ')
  } finally {
    await doc.destroy?.()
  }
}
const pagesOf = async path => {
  const doc = await openPdf(path)
  try { return doc.numPages } finally { await doc.destroy?.() }
}

const beforeText = await textOf(A, 1)

// ── 1. 三个 profile：结构不变、文字不变、qpdf 通过、体积如实报告 ──────────
for (const profile of ['gc', 'linearize', 'both']) {
  const target = out(`opt-${profile}.pdf`)
  const text = await run({ path: A, profile, output: target })
  check(`${profile}：产出文件`, existsSync(target))
  check(`${profile}：页数不变`, (await pagesOf(target)) === 2, String(await pagesOf(target)))
  check(`${profile}：文字层不变`, (await textOf(target, 1)) === beforeText, await textOf(target, 1))
  check(`${profile}：报告里给出优化前后体积`, /体积(没有变小|.*KB → )/.test(text), text.split('\n')[1]?.slice(0, 70))
  check(`${profile}：报告里给出 qpdf 校验结果`, text.includes('qpdf --check exit 0'), text.split('\n')[2]?.slice(0, 60))
  const qpdf = await runQpdf(['--check'], new Uint8Array(await readFile(target)), 'read-only')
  check(`${profile}：产物通过 qpdf --check`, qpdf.exit === 0, `exit=${qpdf.exit}`)
}
check('优化不改动源文件（sha256 不变）', sha(await readFile(A)) === aSha)

// ── 2. compare：精确报出增删行 ────────────────────────────────────────────
{
  const self = await run({ path: A, profile: 'compare', other: A })
  check('compare：自比报告"没有差异"', self.includes('没有差异'), self.split('\n')[1])
  check('compare：报告里带两侧页数', self.includes('2 页） ↔') || self.includes('（2 页）'), self.split('\n')[0])

  const diff = await run({ path: A, profile: 'compare', other: B })
  check('compare：报出页数不同（2 vs 3）', diff.includes('页数不同'), diff.split('\n').find(l => l.includes('页数不同')) ?? '')
  check('compare：报出有差异的页', diff.includes('有差异'), diff.split('\n').find(l => l.includes('文字层')) ?? '')
  check('compare：列出新增行（+ CHANGED LINE）', diff.includes('+ CHANGED LINE'), diff.split('\n').filter(l => l.startsWith('    +')).join(' | '))
  check('compare：列出删除行（- SHARED LINE）', diff.includes('- SHARED LINE'), diff.split('\n').filter(l => l.startsWith('    -')).join(' | '))
  check('compare：第 3 页标为新增页', diff.includes('第 3 页（新增页）'), diff.split('\n').filter(l => l.includes('第 3 页')).join(''))
  check('compare：说明只比文字层（不误报排版/颜色）', diff.includes('纯排版/颜色/图片变化不会体现在结果里'), '')
  check('compare：是只读——destructive 策略下也直接给结果（不弹确认单）',
    (await toolsGated.get('pdf_optimize').execute({ path: A, profile: 'compare', other: B })).text.includes('有差异'))
}

// ── 3. compare：扫描件如实说"无法比对" ───────────────────────────────────
{
  // 造一个没有文字层的页（只有矩形，没有文字）
  const blank = join(WORK, 'blank.pdf')
  {
    const doc = await PDFDocument.create()
    doc.addPage([300, 200]).drawRectangle({ x: 10, y: 10, width: 100, height: 50 })
    await writeFile(blank, Buffer.from(await doc.save()))
  }
  const text = await run({ path: blank, profile: 'compare', other: blank })
  check('compare：无文字层的页如实报告"无法按文字比对"', text.includes('无法按文字比对'), text.split('\n').slice(-2).join(' ').slice(0, 90))
}

// ── 4. 错误路径 ───────────────────────────────────────────────────────────
{
  const fail = async (args) => {
    try { await toolsNever.get('pdf_optimize').execute(args) } catch (error) { return error.message }
    return ''
  }
  check('未知 profile：中文错误并列出可用值',
    (await fail({ path: A, profile: 'shrink', output: out('x.pdf') })).includes('gc / linearize / both / compare'))
  check('compare 缺 other：中文错误', (await fail({ path: A, profile: 'compare' })).includes('other'))
  check('compare 的 other 不存在：中文错误', (await fail({ path: A, profile: 'compare', other: join(WORK, 'nope.pdf') })).includes('不存在'))
  check('错误路径不产出文件', !existsSync(out('x.pdf')))
}

// ── 5. 门控（写盘档） ─────────────────────────────────────────────────────
{
  const target = out('gated.pdf')
  const plan = (await toolsGated.get('pdf_optimize').execute({ path: A, profile: 'gc', output: target })).text
  check('未确认：返回确认单', plan.includes('需要你确认'), plan.split('\n')[0].slice(0, 40))
  check('未确认：不产出文件', !existsSync(target))
  check('确认单动作名是中文', plan.includes('垃圾回收'), plan.split('\n').filter(l => l.includes('动作')).join(''))
  const planId = /计划 id：(p_\w+)/.exec(plan)?.[1]
  let tampered = ''
  try {
    await toolsGated.get('pdf_optimize').execute({ path: A, profile: 'linearize', output: target, confirm: planId })
  } catch (error) { tampered = error.message }
  check('改 profile 后带旧 planId：拒绝', tampered.includes('不一致'), tampered.split('\n')[0].slice(0, 40))
  await toolsGated.get('pdf_optimize').execute({ path: A, profile: 'gc', output: target, confirm: planId })
  check('参数一致时带令牌可以执行', existsSync(target))
  let replay = ''
  try {
    await toolsGated.get('pdf_optimize').execute({ path: A, profile: 'gc', output: target, confirm: planId })
  } catch (error) { replay = error.message }
  check('同一令牌不能重复执行', replay.includes('已经执行过一次'), replay.slice(0, 40))
}

rmSync(WORK, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'ALL PDF-OPTIMIZE CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
