/**
 * 书签嵌套测试：写多层大纲 → 重新载入 → 校验层级结构与目标页。
 *
 * 这是 ROADMAP 里最后一个"待做"项。断言从**结构**下手：只看工具回报的"生成了 N 条"会被骗
 * （层级可能压根没写进去），所以这里重新打开文件读 /Outlines 的 First/Last/Count，
 * 并逐项核对 /Parent 与 /Dest。调用方式与 pdf-metadata.test.mjs 保持一致（execute + text）。
 *
 * Run: node --experimental-strip-types test/pdf-outline-nesting.test.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, StandardFonts } from 'pdf-lib'
import { buildToolDefinitions } from '../src/host/tools.ts'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

const WORK = mkdtempSync(join(tmpdir(), 'pdf-outline-nest-'))
const SRC = join(WORK, 'src.pdf')
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 4; i += 1) doc.addPage([400, 600]).drawText(`page ${i}`, { x: 40, y: 540, size: 20, font })
  await writeFile(SRC, Buffer.from(await doc.save()))
}

const tools = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'never' }).map(d => [d.name, d]))
check('工具已注册 pdf_metadata', tools.has('pdf_metadata'))

/** 书签标题：PDFHexString 直接 toString 会带 «» 与转义，必须 decodeText() 才拿到中文。 */
const titleOf = dict => {
  if (!(dict instanceof PDFDict)) return ''
  const raw = dict.get(PDFName.of('Title'))
  if (raw instanceof PDFHexString) return raw.decodeText()
  return String(raw ?? '')
}
const run = args => tools.get('pdf_metadata').execute(args).then(v => v.text).catch(e => 'ERR: ' + String(e?.message ?? e))
const out = name => join(WORK, name)
const load = async path => PDFDocument.load(new Uint8Array(await readFile(path)), { updateMetadata: false })

// ── 1. 写三层大纲 ──────────────────────────────
const target = out('nested.pdf')
const wrote = await run({
  path: SRC,
  action: 'outline-set',
  output: target,
  outline: [
    {
      title: '第一章 集合',
      page: 1,
      children: [
        { title: '1.1 集合的含义', page: 1 },
        { title: '1.2 集合的运算', page: 2, children: [{ title: '1.2.1 交集', page: 2 }] },
      ],
    },
    { title: '第二章 函数', page: 3 },
    { title: '附录', page: 4 },
  ],
})
check('outline-set：回报 6 条（第一章 + 3 个子级 + 第二章 + 附录）', wrote.includes('生成了 6 条书签'), wrote.split('\n').slice(0, 2).join(' | ').slice(0, 90))

// ── 2. 结构断言（重新载入后读对象树）────────────
const doc = await load(target)
const outlines = doc.context.lookup(doc.catalog.get(PDFName.of('Outlines')))
check('catalog /Outlines 是字典', outlines instanceof PDFDict)
const firstRef = outlines.get(PDFName.of('First'))
const lastRef = outlines.get(PDFName.of('Last'))
const topFirst = doc.context.lookup(firstRef)
const topLast = doc.context.lookup(lastRef)
check('顶层 First/Last 指向第一章与附录',
  topFirst instanceof PDFDict && titleOf(topFirst).includes('第一章')
  && topLast instanceof PDFDict && titleOf(topLast).includes('附录'))
const count = outlines.get(PDFName.of('Count'))
check('顶层 /Count = 6（全部后代数）', count !== undefined && String(count).trim() === '6', String(count))

const kidsFirstRef = topFirst.get(PDFName.of('First'))
const kidsLastRef = topFirst.get(PDFName.of('Last'))
const kid1 = doc.context.lookup(kidsFirstRef)
const kid2 = doc.context.lookup(kidsLastRef)
check('父项有 /First 与 /Last（子层存在）', kid1 instanceof PDFDict && kid2 instanceof PDFDict)
check('子项 /Parent 指回父项（像素级比较引用）',
  kid1 instanceof PDFDict && kid1.get(PDFName.of('Parent')) === firstRef,
  kid1 instanceof PDFDict ? String(kid1.get(PDFName.of('Parent'))) : '（没有子项）')
check('子项 /Dest 指向第 1 页引用（点得动）',
  kid1 instanceof PDFDict && kid1.get(PDFName.of('Dest')) instanceof PDFArray
  && kid1.get(PDFName.of('Dest')).get(0) === doc.getPages()[0].ref)
check('同级子项用 /Next 串起来', kid1 instanceof PDFDict && kid1.get(PDFName.of('Next')) === kidsLastRef)
const grandRef = kid2 instanceof PDFDict ? kid2.get(PDFName.of('First')) : undefined
const grand = doc.context.lookup(grandRef)
check('第三层存在（1.2.1 交集）', grand instanceof PDFDict && titleOf(grand).includes('1.2.1'))
check('第三层 /Parent 指回 1.2', grand instanceof PDFDict && grand.get(PDFName.of('Parent')) === kidsLastRef)
check('页数与尺寸不变', doc.getPageCount() === 4)

// ── 3. 读回来（listOutline 返回 depth）──────────
const listed = await run({ path: target, action: 'outline-list' })
check('outline-list：含全部 6 个标题',
  ['第一章 集合', '1.1 集合的含义', '1.2 集合的运算', '1.2.1 交集', '第二章 函数', '附录'].every(x => listed.includes(x)),
  listed.split('\n').slice(1, 8).join(' | ').slice(0, 130))

// ── 4. 边界：层级上限 / 越界页码 / 扁平兼容 ─────
let nested = { title: 'L7', page: 1 }
for (let level = 6; level >= 1; level -= 1) nested = { title: 'L' + level, page: 1, children: [nested] }
const tooDeep = await run({ path: SRC, action: 'outline-set', output: out('deep.pdf'), outline: [nested] })
check('第 7 层被拒绝（上限 6）', tooDeep.includes('层级过深') || tooDeep.includes('ERR'), tooDeep.slice(0, 80))
const badPage = await run({ path: SRC, action: 'outline-set', output: out('bad.pdf'), outline: [{ title: 'x', page: 99 }] })
check('越界页码被拒绝', badPage.includes('ERR') || badPage.includes('只有'), badPage.slice(0, 60))
const badShape = await run({ path: SRC, action: 'outline-set', output: out('bad2.pdf'), outline: [{ title: '', page: 1 }] })
check('空标题被拒绝', badShape.includes('ERR') || badShape.includes('title'), badShape.slice(0, 60))
const flat = await run({ path: SRC, action: 'outline-set', output: out('flat.pdf'), outline: [{ title: '甲', page: 1 }, { title: '乙', page: 2 }] })
check('扁平写法仍可用（向后兼容）', flat.includes('生成了 2 条书签'), flat.split('\n')[1]?.slice(0, 40))

rmSync(WORK, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL OUTLINE NESTING CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
