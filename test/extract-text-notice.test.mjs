/**
 * `pdf_extract_text` 在"什么都没提取出来"时的措辞测试。
 *
 * 这条文案曾经只有一句 `第 N 页不存在。`，把「页号超范围」和「页存在但被判为 empty/图片」混为一谈，
 * 真机任务里的助手因此误判文件缺页。这个套件把两种情况钉住。
 *
 * Run: node --experimental-strip-types test/extract-text-notice.test.mjs
 */

import { formatEmptyExtractionNotice } from '../src/core/text-layer.ts'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

{
  const outOfRange = formatEmptyExtractionNotice({ wanted: 99, pageCount: 2, kinds: ['text', 'text'] })
  check('页号真的超出范围 → 说"页不存在"并给出总页数',
    outOfRange.length === 1 && outOfRange[0].includes('第 99 页不存在') && outOfRange[0].includes('共 2 页'), outOfRange.join(' / '))

  const emptyPage = formatEmptyExtractionNotice({ wanted: 2, pageCount: 2, kinds: ['empty', 'empty'] })
  check('页存在但被判 empty → **不能**说"页不存在"',
    emptyPage[0].includes('第 2 页没有可提取的文字') && !emptyPage[0].includes('不存在'), emptyPage[0])
  check('并明确澄清"不是页不存在、也不是工具坏了"',
    emptyPage.some(line => line.includes('不是"页不存在"')), '')
  check('并给出下一步（OCR / 可搜索副本）',
    emptyPage.some(line => line.includes('pdf_make_searchable')), '')

  const imagePage = formatEmptyExtractionNotice({ wanted: 1, pageCount: 3, kinds: ['image', 'text', 'text'] })
  check('图片页同样指向 OCR 且报出该页类型', imagePage[0].includes('image'), imagePage[0])

  const wholeDoc = formatEmptyExtractionNotice({ pageCount: 2, kinds: ['empty', 'empty'] })
  check('整档无内容 → 说清原因（都判为 empty）',
    wholeDoc[0].includes('没有提取到内容') && wholeDoc.some(line => line.includes('ToUnicode')), wholeDoc.join(' / '))

  const partial = formatEmptyExtractionNotice({ pageCount: 2, kinds: ['text', 'empty'] })
  check('只有部分页不可信时不给"全都不可信"的结论',
    partial[0].includes('没有提取到内容') && !partial.some(line => line.includes('2 页都被判为')), partial.join(' / '))
}

console.log(`\n${failed === 0 ? 'ALL EXTRACT-TEXT NOTICE CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
