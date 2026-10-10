/**
 * 两版差异：逐页比文字层，报告"哪些页变了、变了什么"。
 *
 * ## 为什么以文字层为准
 *
 * 页级像素比对需要把两版都渲成图（重活、且对"重新导出过的同一份内容"会误报为全页不同）。
 * 文字层比对直接回答用户最常问的问题——"这两版差在哪几页、改了哪些字"，
 * 而且**可复现、可断言**（不需要渲染）。
 *
 * ## 明确不做的
 *
 * 扫描件（整页图片）没有文字层：本工具会**如实报告"无法比对"**并建议先做可搜索化，
 * 或者导出图片人工比——不会假装"没有差异"。
 */

import { extractTextLayer } from './text-layer.ts'
import { openPdfBytes } from './pdf.ts'

/** 单页的比对结果。 */
export interface PageDiff {
  /** 1 起的页码。 */
  page: number
  status: 'same' | 'changed' | 'added' | 'removed' | 'no-text'
  /** 只在这一版出现的行（最多保留前若干条，供报告用）。 */
  added: string[]
  /** 只在另一版出现的行。 */
  removed: string[]
}

/** 整体比对结果。 */
export interface CompareResult {
  pagesA: number
  pagesB: number
  diffs: PageDiff[]
  /** 文字层不可用的页（整页图片/空页），两版合并去重。 */
  noTextPages: number[]
}

/** 归一化一行：去首尾空白、压缩中间空白（排版微调不该算"改了内容"）。 */
function normalize(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

/**
 * 比对两份 PDF 的文字层。
 *
 * @param limit - 每页最多记录多少条增/删行（避免报告爆炸），仅影响展示。
 */
export async function comparePdfs(
  bytesA: Uint8Array,
  bytesB: Uint8Array,
  limit = 8,
): Promise<CompareResult> {
  const docA = await openPdfBytes(new Uint8Array(bytesA))
  const docB = await openPdfBytes(new Uint8Array(bytesB))
  try {
    const pagesA = docA.numPages
    const pagesB = docB.numPages
    const total = Math.max(pagesA, pagesB)
    const diffs: PageDiff[] = []
    const noText = new Set<number>()
    for (let page = 1; page <= total; page += 1) {
      if (page > pagesA) {
        const lines = page > pagesB ? [] : (await extractTextLayer(docB, page)).map(line => normalize(line.text)).filter(Boolean)
        diffs.push({ page, status: 'added', added: lines.slice(0, limit), removed: [] })
        continue
      }
      if (page > pagesB) {
        const lines = (await extractTextLayer(docA, page)).map(line => normalize(line.text)).filter(Boolean)
        diffs.push({ page, status: 'removed', added: [], removed: lines.slice(0, limit) })
        continue
      }
      const linesA = (await extractTextLayer(docA, page)).map(line => normalize(line.text)).filter(Boolean)
      const linesB = (await extractTextLayer(docB, page)).map(line => normalize(line.text)).filter(Boolean)
      if (linesA.length === 0 && linesB.length === 0) {
        noText.add(page)
        diffs.push({ page, status: 'no-text', added: [], removed: [] })
        continue
      }
      const setA = new Set(linesA)
      const setB = new Set(linesB)
      const added = linesB.filter(line => !setA.has(line))
      const removed = linesA.filter(line => !setB.has(line))
      diffs.push({
        page,
        status: added.length === 0 && removed.length === 0 ? 'same' : 'changed',
        added: added.slice(0, limit),
        removed: removed.slice(0, limit),
      })
    }
    return { pagesA, pagesB, diffs, noTextPages: [...noText].sort((a, b) => a - b) }
  } finally {
    // `PdfDoc` 只有 `dispose()`：写 `destroy?.()` 是**空操作**，会静默泄漏文档与 worker。
    await docA.dispose()
    await docB.dispose()
  }
}

/** 把比对结果渲染成中文报告。 */
export function renderCompareReport(nameA: string, nameB: string, result: CompareResult): string {
  const changed = result.diffs.filter(diff => diff.status === 'changed' || diff.status === 'added' || diff.status === 'removed')
  const lines: string[] = []
  lines.push(`比对：${nameA}（${result.pagesA} 页） ↔ ${nameB}（${result.pagesB} 页）`)
  if (result.pagesA !== result.pagesB) {
    lines.push(`页数不同：相差 ${Math.abs(result.pagesA - result.pagesB)} 页。`)
  }
  lines.push(changed.length === 0 ? '文字层：没有差异。' : `文字层：${changed.length} 页有差异。`)
  for (const diff of changed.slice(0, 20)) {
    const label = diff.status === 'added' ? '新增页' : diff.status === 'removed' ? '删除页' : '有改动'
    lines.push(`  第 ${diff.page} 页（${label}）`)
    for (const line of diff.added) lines.push(`    + ${line.slice(0, 80)}`)
    for (const line of diff.removed) lines.push(`    - ${line.slice(0, 80)}`)
  }
  if (changed.length > 20) lines.push(`  …还有 ${changed.length - 20} 页有差异（报告只列前 20 页）`)
  if (result.noTextPages.length > 0) {
    lines.push(
      `注意：第 ${result.noTextPages.slice(0, 12).join('、')}${result.noTextPages.length > 12 ? ' 等' : ''} 页没有文字层`
      + `（扫描件/空页），**无法按文字比对**——这类页请先 pdf_make_searchable，或用 pdf_images 导出图片人工比。`,
    )
  }
  lines.push('说明：比对基于文字层；纯排版/颜色/图片变化不会体现在结果里。')
  return lines.join('\n')
}
