/**
 * 文档信息：属性（Title/Author/…）读写清除，以及大纲（书签）的列出与生成。
 *
 * ## 为什么把"大纲"并进"文档信息"
 *
 * 两者都是**文档级结构信息**（不是页面内容、也不是批注），操作对象都是 catalog/Info 字典，
 * 且都很小。合成一个工具能把工具总数压在纪律②的上限内，语义上也讲得通。
 *
 * ## 两个真机教训（已固化）
 *
 * 1. **中文标题必须用 `PDFHexString.fromText`**：`PDFString.of('中文')` 会按单字节存，
 *    读回来是乱码（`PDFString.fromText` 在 pdf-lib 1.17 根本不存在）。
 * 2. **`/Dest` 指向页面要用页面对象引用**：写成页码数字在多数阅读器里不跳转；
 *    这里统一写 `[页面引用 /Fit]`。
 */

import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib'

/** 可读写的文档属性。 */
export const METADATA_FIELDS = ['title', 'author', 'subject', 'keywords', 'creator', 'producer'] as const
export type MetadataField = (typeof METADATA_FIELDS)[number]

const FIELD_NAMES: Readonly<Record<MetadataField, string>> = {
  title: 'Title',
  author: 'Author',
  subject: 'Subject',
  keywords: 'Keywords',
  creator: 'Creator',
  producer: 'Producer',
}

/** 从 Info 字典里取一个字段（自动按 UTF-16/单字节解码）。 */
function readInfoField(doc: PDFDocument, field: MetadataField): string | undefined {
  const info = doc.context.lookup(doc.context.trailerInfo.Info)
  if (!(info instanceof PDFDict)) return undefined
  const value = info.get(PDFName.of(FIELD_NAMES[field]))
  if (value === undefined) return undefined
  if (value instanceof PDFHexString || value instanceof PDFString) {
    const text = value.decodeText()
    return text === '' ? undefined : text
  }
  return String(value)
}

/** 读取全部属性 + 页数（只读）。 */
export function readMetadata(doc: PDFDocument): { fields: Partial<Record<MetadataField, string>>; pages: number } {
  const fields: Partial<Record<MetadataField, string>> = {}
  for (const field of METADATA_FIELDS) {
    const value = readInfoField(doc, field)
    if (value !== undefined) fields[field] = value
  }
  return { fields, pages: doc.getPageCount() }
}

/** 写入属性：给了哪个就写哪个（中文用 hex 字符串，避免乱码）。 */
export function applyMetadata(doc: PDFDocument, values: Partial<Record<MetadataField, string>>): MetadataField[] {
  const applied: MetadataField[] = []
  for (const field of METADATA_FIELDS) {
    const value = values[field]
    if (value === undefined) continue
    doc.context.trailerInfo.Info = doc.context.trailerInfo.Info
    const info = doc.context.lookup(doc.context.trailerInfo.Info)
    const dict = info instanceof PDFDict
      ? info
      : (() => {
          const created = doc.context.obj({})
          doc.context.trailerInfo.Info = doc.context.register(created)
          return created
        })()
    dict.set(PDFName.of(FIELD_NAMES[field]), PDFHexString.fromText(value))
    applied.push(field)
  }
  return applied
}

/** 清除属性（把可用字段置空；日期字段也一并清掉，避免泄露编辑时间）。 */
export function clearMetadata(doc: PDFDocument): void {
  const cleared = applyMetadata(doc, Object.fromEntries(METADATA_FIELDS.map(field => [field, ''])) as Partial<Record<MetadataField, string>>)
  void cleared
  const info = doc.context.lookup(doc.context.trailerInfo.Info)
  if (!(info instanceof PDFDict)) return
  for (const key of ['CreationDate', 'ModDate', 'Trapped']) {
    info.delete(PDFName.of(key))
  }
}

/** 一条书签。 */
export interface OutlineEntry {
  title: string
  /** 1 起的页码。 */
  page: number
}

/** 页面引用 → 页码（1 起）。 */
function pageNumberOf(doc: PDFDocument, ref: unknown, pages: readonly PDFRef[]): number | undefined {
  const index = pages.findIndex(item => item === ref)
  return index < 0 ? undefined : index + 1
}

/** 列出大纲（只读，扁平列出；嵌套结构按深度缩进）。 */
export function listOutline(doc: PDFDocument): Array<OutlineEntry & { depth: number }> {
  const catalog = doc.catalog
  const outlinesRef = catalog.get(PDFName.of('Outlines'))
  const outlines = outlinesRef instanceof PDFRef ? doc.context.lookup(outlinesRef) : outlinesRef
  if (!(outlines instanceof PDFDict)) return []
  const pageRefs = doc.getPages().map(page => page.ref)
  const result: Array<OutlineEntry & { depth: number }> = []
  const walk = (dict: PDFDict | undefined, depth: number): void => {
    let current = dict
    let guard = 0
    while (current !== undefined && guard < 5000) {
      guard += 1
      const titleRaw = current.get(PDFName.of('Title'))
      const title = titleRaw instanceof PDFHexString || titleRaw instanceof PDFString ? titleRaw.decodeText() : String(titleRaw ?? '')
      const dest = current.get(PDFName.of('Dest'))
      const destArray = dest instanceof PDFArray ? dest : (dest instanceof PDFRef ? doc.context.lookup(dest) : undefined)
      const target = destArray instanceof PDFArray ? destArray.get(0) : undefined
      const page = pageNumberOf(doc, target, pageRefs)
      result.push({ title, ...(page === undefined ? { page: 0 } : { page }), depth })
      const child = current.get(PDFName.of('First'))
      const childDict = child instanceof PDFRef ? doc.context.lookup(child) : child
      if (childDict instanceof PDFDict) walk(childDict, depth + 1)
      const next = current.get(PDFName.of('Next'))
      current = next instanceof PDFRef ? doc.context.lookup(next) as PDFDict : (next as PDFDict | undefined)
    }
  }
  const first = outlines.get(PDFName.of('First'))
  walk(first instanceof PDFRef ? doc.context.lookup(first) as PDFDict : first as PDFDict | undefined, 0)
  return result
}

/**
 * 生成/替换大纲：扁平一层，按给定顺序排列，每条指向 `page`（1 起）。
 *
 * 中文标题走 `PDFHexString.fromText`；`/Dest` 用 `[页面引用 /Fit]`。
 */
export function setOutline(doc: PDFDocument, entries: readonly OutlineEntry[]): number {
  const context = doc.context
  const catalog = doc.catalog
  const pageRefs = doc.getPages().map(page => page.ref)
  const outlines = context.obj({ Type: 'Outlines' }) as PDFDict
  const outlinesRef = context.register(outlines)
  const items = entries.map(entry => {
    const pageRef = pageRefs[entry.page - 1]
    if (pageRef === undefined) throw new Error(`书签「${entry.title}」指向第 ${entry.page} 页，但文档只有 ${pageRefs.length} 页`)
    const dict = context.obj({
      Title: PDFHexString.fromText(entry.title),
      Parent: outlinesRef,
      Dest: context.obj([pageRef, 'Fit']),
    }) as PDFDict
    return { ref: context.register(dict), dict }
  })
  for (const [index, item] of items.entries()) {
    if (index > 0) item.dict.set(PDFName.of('Prev'), items[index - 1].ref)
    if (index < items.length - 1) item.dict.set(PDFName.of('Next'), items[index + 1].ref)
  }
  if (items.length > 0) {
    outlines.set(PDFName.of('First'), items[0].ref)
    outlines.set(PDFName.of('Last'), items[items.length - 1].ref)
    outlines.set(PDFName.of('Count'), context.obj(entries.length))
  }
  catalog.set(PDFName.of('Outlines'), outlinesRef)
  return items.length
}

/** 删除大纲（连 catalog 里的引用一起去掉）。 */
export function clearOutline(doc: PDFDocument): void {
  doc.catalog.delete(PDFName.of('Outlines'))
}
