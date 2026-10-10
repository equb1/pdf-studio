/**
 * 表单测试：列出字段 / 填写 / 压平。
 *
 * 两个必须钉住的事实：
 *   1. **中文值要能填进去**——pdf-lib 默认用 Helvetica 画字段外观，中文会抛
 *      "WinAnsi cannot encode"；实现里会用 CJK 字体重刷外观，这里断言回读值正确；
 *   2. 字段名写错必须**报错并列出可用字段名**，不能静默跳过（否则用户以为填上了）。
 *
 * Run: node --experimental-strip-types test/pdf-form.test.mjs
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { buildToolDefinitions } from '../src/host/tools.ts'
import { openPdf, pageSize } from '../src/core/pdf.ts'
import { runQpdf } from '../src/core/qpdf.ts'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

const WORK = mkdtempSync(join(tmpdir(), 'pdf-form-'))
const SRC = join(WORK, 'form.pdf')
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([500, 700])
  page.drawText('Registration form', { x: 40, y: 650, size: 16, font })
  const form = doc.getForm()
  form.createTextField('姓名').addToPage(page, { x: 40, y: 580, width: 200, height: 24 })
  form.createCheckBox('同意条款').addToPage(page, { x: 40, y: 540, width: 18, height: 18 })
  // 注意：pdf-lib 造字段时用标准字体画**选项标签**，中文标签会抛 WinAnsi 错误——
  // 所以夹具里选项用 ASCII；中文放在"字段名"（不绘制）与"文本域的值"（由实现用 CJK 字体刷外观）上。
  const gender = form.createRadioGroup('性别')
  gender.addOptionToPage('Male', page, { x: 300, y: 580, width: 18, height: 18 })
  gender.addOptionToPage('Female', page, { x: 360, y: 580, width: 18, height: 18 })
  const city = form.createDropdown('城市')
  city.setOptions(['Beijing', 'Shanghai', 'Guangzhou'])
  city.addToPage(page, { x: 40, y: 500, width: 160, height: 24 })
  const tags = form.createOptionList('标签')
  tags.setOptions(['Key', 'Normal'])
  tags.addToPage(page, { x: 40, y: 440, width: 160, height: 48 })
  await writeFile(SRC, await doc.save())
}
const srcSha = sha(await readFile(SRC))
const toolsNever = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'never' }).map(d => [d.name, d]))
const toolsGated = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'destructive' }).map(d => [d.name, d]))
const run = args => toolsNever.get('pdf_form').execute(args).then(value => value.text)
const readBack = async path => {
  const doc = await PDFDocument.load(new Uint8Array(await readFile(path)), { updateMetadata: false })
  return doc
}

// ── 1. list ───────────────────────────────────────────────────────────────
{
  const text = await run({ path: SRC, action: 'list' })
  check('list：报出字段总数', text.includes('5 个表单域'), text.split('\n')[0])
  check('list：区分类别（文本/勾选框/单选/下拉/列表）',
    ['文本', '勾选框', '单选', '下拉', '列表'].every(kind => text.includes(kind)),
    text.split('\n').slice(1, 6).join(' | '))
  check('list：列出可选项', text.includes('Beijing') && text.includes('Key'), text.split('\n').slice(1, 6).join(' | '))
  check('list：只读，不产出文件', !existsSync(join(WORK, 'form-form.pdf')))
}

// ── 2. fill（含中文） ─────────────────────────────────────────────────────
{
  const target = join(WORK, 'filled.pdf')
  const text = await run({
    path: SRC, action: 'fill',
    values: { 姓名: '张三', 同意条款: true, 性别: 'Female', 城市: 'Shanghai', 标签: 'Key' },
    output: target,
  })
  const doc = await readBack(target)
  const form = doc.getForm()
  check('fill：文本域写入中文并可回读', form.getTextField('姓名').getText() === '张三', String(form.getTextField('姓名').getText()))
  // pdf-lib 的 PDFDropdown.getSelected() 返回**数组**（单选组返回字符串）。
  check('fill：下拉可回读', (form.getDropdown('城市').getSelected() ?? []).includes('Shanghai'), String(form.getDropdown('城市').getSelected()))
  check('fill：单选可回读', form.getRadioGroup('性别').getSelected() === 'Female', String(form.getRadioGroup('性别').getSelected()))
  check('fill：列表可回读', (form.getOptionList('标签').getSelected() ?? []).includes('Key'), String(form.getOptionList('标签').getSelected()))
  check('fill：勾选框被勾上', form.getCheckBox('同意条款').isChecked())
  check('fill：结果里报告了每个字段', text.includes('姓名=张三') && text.includes('同意条款=已勾选'), text.split('\n')[1]?.slice(0, 80))
  check('fill：不压平时字段仍在（可继续编辑）', form.getFields().length === 5, String(form.getFields().length))

  const flatTarget = join(WORK, 'filled-flat.pdf')
  await run({ path: SRC, action: 'fill', values: { 姓名: '李四' }, flatten: true, output: flatTarget })
  const flatDoc = await readBack(flatTarget)
  check('fill + flatten=true：一步压平', flatDoc.getForm().getFields().length === 0, String(flatDoc.getForm().getFields().length))
}

// ── 3. flatten ────────────────────────────────────────────────────────────
{
  const target = join(WORK, 'flat.pdf')
  await run({ path: SRC, action: 'flatten', output: target })
  const doc = await readBack(target)
  check('flatten：字段全部消失', doc.getForm().getFields().length === 0, String(doc.getForm().getFields().length))
  const before = await openPdf(SRC)
  const after = await openPdf(target)
  const sizeBefore = await pageSize(before, 1)
  const sizeAfter = await pageSize(after, 1)
  await before.destroy?.()
  await after.destroy?.()
  check('flatten：页数与页面尺寸不变',
    doc.getPageCount() === 1 && Math.abs(sizeBefore.width - sizeAfter.width) < 1 && Math.abs(sizeBefore.height - sizeAfter.height) < 1,
    `${doc.getPageCount()} 页，${sizeAfter.width.toFixed(0)}×${sizeAfter.height.toFixed(0)}`)
  const qpdf = await runQpdf(['--check'], new Uint8Array(await readFile(target)), 'read-only')
  check('flatten：产物通过 qpdf --check', qpdf.exit === 0, `exit=${qpdf.exit}`)
}

// ── 4. 错误路径 ───────────────────────────────────────────────────────────
{
  const fail = async (args) => {
    try { await toolsNever.get('pdf_form').execute(args) } catch (error) { return error.message }
    return ''
  }
  const unknown = await fail({ path: SRC, action: 'fill', values: { 邮箱: 'a@b.c' }, output: join(WORK, 'x.pdf') })
  check('未知字段：报错并列出可用字段名',
    unknown.includes('邮箱') && unknown.includes('姓名') && unknown.includes('城市'), unknown.slice(0, 100))
  check('未知字段：不产出文件', !existsSync(join(WORK, 'x.pdf')))
  check('缺 values：中文错误', (await fail({ path: SRC, action: 'fill', output: join(WORK, 'y.pdf') })).includes('values'))
  check('未知 action：中文错误', (await fail({ path: SRC, action: 'submit' })).includes('未知 action'))
}

// ── 5. 门控 ───────────────────────────────────────────────────────────────
{
  const target = join(WORK, 'gated.pdf')
  const plan = (await toolsGated.get('pdf_form').execute({
    path: SRC, action: 'fill', values: { 姓名: '王五' }, output: target,
  })).text
  check('未确认：返回确认单', plan.includes('需要你确认'), plan.split('\n')[0].slice(0, 50))
  check('未确认：不产出文件', !existsSync(target))
  const planId = /计划 id：(p_\w+)/.exec(plan)?.[1]

  let tampered = ''
  try {
    await toolsGated.get('pdf_form').execute({
      path: SRC, action: 'fill', values: { 姓名: '赵六' }, output: target, confirm: planId,
    })
  } catch (error) { tampered = error.message }
  check('改 values 后带旧 planId：拒绝', tampered.includes('不一致'), tampered.split('\n')[0].slice(0, 50))

  await toolsGated.get('pdf_form').execute({ path: SRC, action: 'fill', values: { 姓名: '王五' }, output: target, confirm: planId })
  check('参数一致时带令牌可以执行', existsSync(target))

  const listUnderGate = await toolsGated.get('pdf_form').execute({ path: SRC, action: 'list' })
  check('list 是只读：即使在 destructive 策略下也直接给结果（不弹确认单）',
    listUnderGate.text.includes('5 个表单域'), listUnderGate.text.split('\n')[0])
  check('源文件未被改动（sha256 不变）', sha(await readFile(SRC)) === srcSha)
}

rmSync(WORK, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'ALL PDF-FORM CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
