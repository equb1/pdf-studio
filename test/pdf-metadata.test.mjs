/**
 * 文档信息测试：属性读写清除 + 书签（大纲）。
 *
 * 断言从**结构**下手（重新载入后读 `/Info` 与 catalog 的 `/Outlines`），而不是只看返回文本：
 * 属性最容易出的错是"工具说写了、实际存进去是乱码或没写"，书签最容易出的错是
 * "生成了但点不动（`/Dest` 没写页面引用）"。
 *
 * Run: node --experimental-strip-types test/pdf-metadata.test.mjs
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib'
import { buildToolDefinitions } from '../src/host/tools.ts'
import { openPdf, pageSize } from '../src/core/pdf.ts'
import { runQpdf } from '../src/core/qpdf.ts'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

const WORK = mkdtempSync(join(tmpdir(), 'pdf-meta-'))
const SRC = join(WORK, 'src.pdf')
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let n = 1; n <= 3; n += 1) {
    doc.addPage([400, 300]).drawText(`META PAGE ${n}`, { x: 40, y: 150, size: 14, font })
  }
  await writeFile(SRC, Buffer.from(await doc.save()))
}
const srcSha = sha(await readFile(SRC))
const toolsNever = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'never' }).map(d => [d.name, d]))
const toolsGated = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'destructive' }).map(d => [d.name, d]))
const run = args => toolsNever.get('pdf_metadata').execute(args).then(value => value.text)
const out = name => join(WORK, name)
const load = async path => PDFDocument.load(new Uint8Array(await readFile(path)), { updateMetadata: false })

// ── 1. get ────────────────────────────────────────────────────────────────
{
  const text = await run({ path: SRC, action: 'get' })
  check('get：报出页数', text.includes('3 页'), text.split('\n')[0])
  check('get：六个属性都列出（无值显示"（空）"）',
    ['title', 'author', 'subject', 'keywords', 'creator', 'producer'].every(field => text.includes(field)) && text.includes('（空）'),
    text.split('\n').slice(1, 3).join(' | '))
  check('get：没有书签时如实说明', text.includes('书签：无'), text.split('\n').filter(l => l.includes('书签')).join(''))
}

// ── 2. set（含中文） ──────────────────────────────────────────────────────
{
  const target = out('set.pdf')
  const text = await run({ path: SRC, action: 'set', values: { title: '文言实词手册（2026 版）', author: '教务处', keywords: '文言文, 实词' }, output: target })
  check('set：结果里回报写入的字段', text.includes('title=') && text.includes('author='), text.split('\n')[1]?.slice(0, 60))
  const doc = await load(target)
  check('set：中文标题写入后可回读（不乱码）', doc.getTitle() === '文言实词手册（2026 版）', String(doc.getTitle()))
  check('set：中文作者可回读', doc.getAuthor() === '教务处', String(doc.getAuthor()))
  check('set：关键词可回读', doc.getKeywords() === '文言文, 实词', String(doc.getKeywords()))
  const reread = await run({ path: target, action: 'get' })
  check('set：再次 get 能看到新值', reread.includes('文言实词手册（2026 版）') && reread.includes('教务处'), reread.split('\n')[1])
  const info = await load(target)
  const raw = info.context.lookup(info.context.trailerInfo.Info)
  check('set：/Info 里标题是 hex 字符串（中文按 UTF-16 存）',
    raw instanceof PDFDict && raw.get(PDFName.of('Title')) instanceof PDFHexString,
    raw instanceof PDFDict ? String(raw.get(PDFName.of('Title'))).slice(0, 30) : '（没有 /Info）')
}

// ── 3. clear ──────────────────────────────────────────────────────────────
{
  const target = out('clear.pdf')
  await run({ path: out('set.pdf'), action: 'clear', output: target })
  const doc = await load(target)
  check('clear：属性清空', (doc.getTitle() ?? '') === '' && (doc.getAuthor() ?? '') === '', `${doc.getTitle()} / ${doc.getAuthor()}`)
  const raw = doc.context.lookup(doc.context.trailerInfo.Info)
  check('clear：创建/修改时间也被删除（去隐私）',
    raw instanceof PDFDict && raw.get(PDFName.of('CreationDate')) === undefined && raw.get(PDFName.of('ModDate')) === undefined,
    raw instanceof PDFDict ? raw.keys().map(String).join(',') : '（没有 /Info）')
}

// ── 4. 书签：生成 / 列出 / 删除 ───────────────────────────────────────────
{
  const target = out('outline.pdf')
  const text = await run({
    path: SRC, action: 'outline-set',
    outline: [{ title: '第一章 集合', page: 1 }, { title: '第二章 函数', page: 2 }, { title: '附录', page: 3 }],
    output: target,
  })
  check('outline-set：回报生成 3 条', text.includes('生成了 3 条书签'), text.split('\n')[1]?.slice(0, 60))
  const doc = await load(target)
  const outlines = doc.catalog.get(PDFName.of('Outlines'))
  check('outline-set：catalog 里有 /Outlines', outlines !== undefined)
  const outlineDict = doc.context.lookup(outlines)
  const first = doc.context.lookup(outlineDict instanceof PDFDict ? outlineDict.get(PDFName.of('First')) : undefined)
  check('outline-set：第一条书签的 /Dest 指向页面引用（不然点不动）',
    first instanceof PDFDict && first.get(PDFName.of('Dest')) instanceof PDFArray
    && first.get(PDFName.of('Dest')).get(0) === doc.getPages()[0].ref,
    first instanceof PDFDict ? String(first.get(PDFName.of('Title'))).slice(0, 24) : '（没有 First）')
  check('outline-set：页数与尺寸不变', doc.getPageCount() === 3, String(doc.getPageCount()))

  const listed = await run({ path: target, action: 'outline-list' })
  check('outline-list：列出全部 3 条且带页码',
    ['第一章 集合', '第二章 函数', '附录'].every(title => listed.includes(title)) && listed.includes('第 2 页'),
    listed.split('\n').slice(1, 4).join(' | '))

  const cleared = out('outline-cleared.pdf')
  await run({ path: target, action: 'outline-clear', output: cleared })
  const after = await load(cleared)
  check('outline-clear：catalog 里不再有 /Outlines', after.catalog.get(PDFName.of('Outlines')) === undefined)
  check('outline-clear：列出时说"没有书签"', (await run({ path: cleared, action: 'outline-list' })).includes('没有书签'))
  const qpdf = await runQpdf(['--check'], new Uint8Array(await readFile(cleared)), 'read-only')
  check('产物通过 qpdf --check', qpdf.exit === 0, `exit=${qpdf.exit}`)
}

// ── 5. 错误路径 ───────────────────────────────────────────────────────────
{
  const fail = async (args) => {
    try { await toolsNever.get('pdf_metadata').execute(args) } catch (error) { return error.message }
    return ''
  }
  check('set 缺 values：中文错误并列出可用字段',
    (await fail({ path: SRC, action: 'set', output: out('x.pdf') })).includes('title'), '')
  check('outline-set 缺 outline：中文错误', (await fail({ path: SRC, action: 'outline-set', output: out('x.pdf') })).includes('outline'))
  check('书签页号越界：中文错误并说明页数',
    (await fail({ path: SRC, action: 'outline-set', outline: [{ title: '越界', page: 99 }], output: out('x.pdf') })).includes('只有 3 页'))
  check('书签缺 title/page：中文错误',
    (await fail({ path: SRC, action: 'outline-set', outline: [{ title: '' }], output: out('x.pdf') })).includes('title'))
  check('未知 action：中文错误', (await fail({ path: SRC, action: 'rename' })).includes('未知 action'))
  check('错误路径不产出文件', !existsSync(out('x.pdf')))
}

// ── 6. 门控 ───────────────────────────────────────────────────────────────
{
  const target = out('gated.pdf')
  const plan = (await toolsGated.get('pdf_metadata').execute({ path: SRC, action: 'set', values: { title: 'X' }, output: target })).text
  check('未确认：返回确认单', plan.includes('需要你确认'), plan.split('\n')[0].slice(0, 40))
  check('未确认：不产出文件', !existsSync(target))
  check('确认单动作名是中文', plan.includes('写入文档信息'), plan.split('\n').filter(l => l.includes('动作')).join(''))
  // 只读 action：即使在 destructive 策略下也直通
  check('get 是只读：destructive 策略下也直接给结果',
    (await toolsGated.get('pdf_metadata').execute({ path: SRC, action: 'get' })).text.includes('3 页'))
  check('outline-list 同样是只读直通',
    (await toolsGated.get('pdf_metadata').execute({ path: SRC, action: 'outline-list' })).text.includes('没有书签'))
  const planId = /计划 id：(p_\w+)/.exec(plan)?.[1]
  let tampered = ''
  try {
    await toolsGated.get('pdf_metadata').execute({ path: SRC, action: 'set', values: { title: 'Y' }, output: target, confirm: planId })
  } catch (error) { tampered = error.message }
  check('改 values 后带旧 planId：拒绝', tampered.includes('不一致'), tampered.split('\n')[0].slice(0, 40))
  await toolsGated.get('pdf_metadata').execute({ path: SRC, action: 'set', values: { title: 'X' }, output: target, confirm: planId })
  check('参数一致时带令牌可以执行', existsSync(target))
  check('源文件未被改动（sha256 不变）', sha(await readFile(SRC)) === srcSha)
}

rmSync(WORK, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'ALL PDF-METADATA CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
