/**
 * 答案页候选检测测试：打分规则 / 区间合并 / 拆分建议（纯逻辑），以及 `pdf_find_answers` 的端到端行为。
 *
 * 最重要的两条：
 *   1. **零误报**——纯题目卷必须"未找到答案页"，`answerRanges` 为空（宁可漏报，不许硬凑）；
 *   2. **位置先验只做 tiebreak**——文本特征不足时 +0.5 且依据必须写"仅依据位置推断，置信度低"。
 *
 * 夹具全部建在 `os.tmpdir()` 下，用例结束删除；全程只读，不碰任何用户文件。
 *
 * Run: node --experimental-strip-types test/answer-pages.test.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { createCanvas } from '@napi-rs/canvas'
import { buildToolDefinitions } from '../src/host/tools.ts'
import { inspectLanguageData } from '../src/core/ocr.ts'
import { groupAnswerRanges, scoreAnswerPage, suggestArrangement } from '../src/core/answer-pages.ts'

let failed = 0
let skipped = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
/** 环境缺语言数据时**显式**跳过（打印 SKIP 并在结尾汇总，不计入 ok）。 */
const skip = (name, why) => {
  skipped += 1
  console.log(`  SKIP  ${name}${why === undefined ? '' : ' — ' + why}`)
}

const WORK = mkdtempSync(join(tmpdir(), 'dsh-answer-pages-'))

/* ── 夹具文字 ─────────────────────────────────────────────────────────────── */

/** 纯题目文字：只有题干特征，没有任何答案侧特征。 */
const QUESTION_TEXT = [
  '一、选择题（本小题 3 分）',
  '如图，已知 AB 与 CD 相交于点 O，求∠1 的度数。',
  '二、解答题（本题 8 分）',
  '解答应写出文字说明，证明过程或演算步骤。',
  '已知 a+b=5，求证 a²+b² 的最小值。',
].join('\n')

/** 答案文字：页首「参考答案」+ 速查表 + 解答句。 */
const ANSWER_TEXT = [
  '参考答案',
  '1 C 2 A 3 D 4 B 5 A',
  '一、1．解：由题意得 ∠1=30°',
  '∴ ∠2=60°',
  '证明：∵ AB∥CD，两直线平行内错角相等',
].join('\n')

/** 中性文字：过字符数下限，但没有任何答案/题目特征。 */
const NEUTRAL_TEXT = [
  '这一页只有占位文字，用来测试在没有足够文本特征时会发生什么。',
  '这里继续补充一些内容，让有效字符数超过四十个，从而不会因为文本过少被直接判为无法判定。',
].join('\n')

const pagesOf = (texts, kind = 'text') => texts.map((text, index) => ({
  page: index + 1,
  ...scoreAnswerPage({ text, pageNumber: index + 1, pageCount: texts.length, kind }),
}))

/* ── PDF 夹具 ─────────────────────────────────────────────────────────────── */

/** 纯文字页 PDF：每页给若干行 ASCII 文本（StandardFonts 画不了中文，端到端用英文）。 */
async function writeTextPdf(path, pages) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const lines of pages) {
    const page = doc.addPage([595.28, 841.89])
    let y = 780
    for (const line of lines) {
      page.drawText(line, { x: 50, y, size: 13, font, color: rgb(0, 0, 0) })
      y -= 24
    }
  }
  writeFileSync(path, await doc.save())
}

/** 整页图片 PDF（真实 canvas 画字 → PNG → pdf-lib 嵌入）。 */
async function writeImagePdf(path, draw) {
  const canvas = createCanvas(1100, 500)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 1100, 500)
  ctx.fillStyle = '#000000'
  draw(ctx)
  const png = canvas.toBuffer('image/png')
  const doc = await PDFDocument.create()
  const image = await doc.embedPng(png)
  const page = doc.addPage([595.28, 841.89])
  page.drawImage(image, { x: 40, y: 400, width: 515, height: 234 })
  writeFileSync(path, await doc.save())
}

/** 跑一次 pdf_find_answers，返回渲染文本。 */
async function runFindAnswers(args) {
  const tools = buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'never' })
  const tool = tools.find(item => item.name === 'pdf_find_answers')
  if (tool === undefined) throw new Error('pdf_find_answers 未注册')
  return (await tool.execute(args)).text
}

try {
  /* ── 用例 1：纯题目卷必须"未找到答案页"（零误报）───────────────────────── */
  {
    const scored = pagesOf([QUESTION_TEXT, QUESTION_TEXT, QUESTION_TEXT, QUESTION_TEXT])
    check('用例1：纯题目卷每一页都判为试卷',
      scored.every(page => page.verdict === 'question'),
      scored.map(page => `${page.page}:${page.verdict}(${page.score})`).join(' '))

    const ranges = groupAnswerRanges(scored)
    check('用例1：纯题目卷 answerRanges 为空（零误报）', ranges.answerRanges.length === 0,
      JSON.stringify(ranges.answerRanges))
    check('用例1：纯题目卷没有任何 answer 判定',
      scored.every(page => page.verdict !== 'answer'),
      scored.map(page => page.verdict).join(','))

    const suggestion = suggestArrangement(4, ranges)
    check('用例1：不给拆分建议', suggestion.separable === false && suggestion.splits.length === 0,
      suggestion.note)
  }

  /* ── 用例 2：答案单独成末页 → 候选恰好是该页、high、依据含标题与速查表 ──── */
  {
    const scored = pagesOf([QUESTION_TEXT, QUESTION_TEXT, QUESTION_TEXT, QUESTION_TEXT, QUESTION_TEXT, QUESTION_TEXT, ANSWER_TEXT])
    const ranges = groupAnswerRanges(scored)
    check('用例2：候选恰好是第 7 页',
      ranges.answerRanges.length === 1 && ranges.answerRanges[0].from === 7 && ranges.answerRanges[0].to === 7,
      JSON.stringify(ranges.answerRanges))
    check('用例2：置信度 high', ranges.answerRanges[0]?.confidence === 'high', String(ranges.answerRanges[0]?.confidence))

    const answerPage = scored[6]
    check('用例2：依据里出现「参考答案」', answerPage.evidence.some(line => line.includes('参考答案')),
      answerPage.evidence.join(' ｜ '))
    check('用例2：依据里出现「速查表」', answerPage.evidence.some(line => line.includes('速查表')),
      answerPage.evidence.join(' ｜ '))
    check('用例2：题干页判为试卷', scored.slice(0, 6).every(page => page.verdict === 'question'),
      scored.slice(0, 6).map(page => page.verdict).join(','))

    const suggestion = suggestArrangement(7, ranges)
    check('用例2：可拆分为两个 PDF', suggestion.separable === true && suggestion.splits.length === 2,
      JSON.stringify(suggestion.splits.map(split => split.order)))
    check('用例2：两条 pdf_arrange 的 order 与实际页范围一致（1-6 / 7）',
      suggestion.splits[0]?.order === '1-6' && suggestion.splits[1]?.order === '7',
      suggestion.splits.map(split => split.order).join(' / '))
    check('用例2：角色分别是 questions / answers',
      suggestion.splits[0]?.role === 'questions' && suggestion.splits[1]?.role === 'answers',
      suggestion.splits.map(split => split.role).join(' / '))
  }

  /* ── 用例 3：答案与题目交替 → 多段候选，且不给"两段式"错误建议 ───────────── */
  {
    const texts = [QUESTION_TEXT, ANSWER_TEXT, QUESTION_TEXT, ANSWER_TEXT, QUESTION_TEXT, ANSWER_TEXT, QUESTION_TEXT, ANSWER_TEXT]
    const scored = pagesOf(texts)
    const ranges = groupAnswerRanges(scored)
    check('用例3：答案页给出多段候选区间', ranges.answerRanges.length === 4,
      JSON.stringify(ranges.answerRanges))
    check('用例3：每段都是单独一页（2/4/6/8）',
      ranges.answerRanges.map(range => `${range.from}-${range.to}`).join(',') === '2-2,4-4,6-6,8-8',
      JSON.stringify(ranges.answerRanges))

    const suggestion = suggestArrangement(8, ranges)
    check('用例3：不给出"两段式"拆分建议', suggestion.separable === false && suggestion.splits.length === 0,
      suggestion.note)
    check('用例3：中文说明"交替分布"', suggestion.note.includes('交替分布'), suggestion.note)
  }

  /* ── 用例 4：答案与题目同页 → mixed + 无法按页分离 + 不给拆分建议 ────────── */
  {
    const mixedText = `${ANSWER_TEXT}\n${QUESTION_TEXT}`
    const scored = pagesOf([QUESTION_TEXT, mixedText, QUESTION_TEXT])
    check('用例4：同页判为 mixed', scored[1].verdict === 'mixed', `${scored[1].verdict}(${scored[1].score})`)
    check('用例4：依据同时写出答案侧与题干侧',
      scored[1].evidence.some(line => line.includes('答案')) && scored[1].evidence.some(line => line.includes('题干特征')),
      scored[1].evidence.join(' ｜ '))

    const ranges = groupAnswerRanges(scored)
    check('用例4：mixedPages 记录该页', ranges.mixedPages.join(',') === '2', JSON.stringify(ranges.mixedPages))
    const suggestion = suggestArrangement(3, ranges)
    check('用例4：不给拆分建议', suggestion.separable === false && suggestion.splits.length === 0, suggestion.note)
    check('用例4：中文提示"无法按页分离"', suggestion.note.includes('无法按页分离'), suggestion.note)
  }

  /* ── 用例 5：英文卷 Answer Key + 1. C 2. A → 判为答案页 ─────────────────── */
  {
    const english = [
      'Answer Key',
      '1. C 2. A 3. D 4. B 5. A',
      'Solutions: each question is worth five points.',
    ].join('\n')
    const scored = scoreAnswerPage({ text: english, pageNumber: 1, pageCount: 1, kind: 'text' })
    check('用例5：英文卷判为答案页', scored.verdict === 'answer', `${scored.verdict}(${scored.score})`)
    check('用例5：依据里出现 Answer Key 标题词',
      scored.evidence.some(line => line.includes('answerkey')), scored.evidence.join(' ｜ '))
    check('用例5：依据里出现速查表', scored.evidence.some(line => line.includes('速查表')),
      scored.evidence.join(' ｜ '))
  }

  /* ── 补充：文本过少 / 强信号不受字数门槛限制 / 位置先验只做 tiebreak ─────── */
  {
    // "文本过少"只压没有强信号的页：没有任何特征的短文本 → unknown，并给出可复核的计数口径。
    const short = scoreAnswerPage({ text: '占位', pageNumber: 1, pageCount: 3, kind: 'text' })
    check('补充：无强信号的短文本判 unknown 并说明计数口径',
      short.verdict === 'unknown' && short.evidence.some(line => line.includes('文本过少'))
      && short.evidence.some(line => line.includes('去掉空白后的字符数') && line.includes('下限 20')),
      short.evidence.join(' ｜ '))
    check('补充：文本过少的依据里回显本页识别到的文字（便于核对计数）',
      short.evidence.some(line => line.includes('本页识别到的文字') && line.includes('占位')),
      short.evidence.join(' ｜ '))

    // 反过来：短答案页只要有标题词就不受门槛限制（真文件里"读对了却被字数门槛压掉"的那类）。
    const tinyTitle = scoreAnswerPage({ text: '答案', pageNumber: 1, pageCount: 3, kind: 'text' })
    check('补充：只有两个字的「答案」也判 answer/high（标题词不受字数门槛限制）',
      tinyTitle.verdict === 'answer' && tinyTitle.confidence === 'high' && tinyTitle.score === 5,
      `${tinyTitle.verdict}/${tinyTitle.confidence}(${tinyTitle.score})`)

    const shortEnglish = scoreAnswerPage({
      text: 'Answer Key\n1 C 2. A 3. D 4. B 5. C\n6. D 7. B 8. A 9. C 10. D',
      pageNumber: 1,
      pageCount: 1,
      kind: 'image',
    })
    check('补充：短英文答案页判 answer/high（+5 标题词 +4 速查表）',
      shortEnglish.verdict === 'answer' && shortEnglish.confidence === 'high' && shortEnglish.score === 9,
      `${shortEnglish.verdict}/${shortEnglish.confidence}(${shortEnglish.score})`)
    check('补充：短英文答案页的依据含 Answer Key 与速查表',
      shortEnglish.evidence.some(line => line.includes('answerkey'))
      && shortEnglish.evidence.some(line => line.includes('速查表')),
      shortEnglish.evidence.join(' ｜ '))

    const scored = pagesOf([NEUTRAL_TEXT, NEUTRAL_TEXT, NEUTRAL_TEXT, NEUTRAL_TEXT])
    check('补充：特征不足的末 25% 页走位置先验（answer/low）',
      scored[3].verdict === 'answer' && scored[3].confidence === 'low',
      `${scored[3].verdict}/${scored[3].confidence}(${scored[3].score})`)
    check('补充：位置先验的依据必须写明"仅依据位置推断，置信度低"',
      scored[3].evidence.some(line => line.includes('仅依据位置推断，置信度低')),
      scored[3].evidence.join(' ｜ '))
    check('补充：不在末 25% 的中性页判 unknown（位置不是证据）',
      scored[2].verdict === 'unknown', `${scored[2].verdict}(${scored[2].score})`)
    check('补充：位置先验只加 0.5', scored[3].score === 0.5, String(scored[3].score))
  }

  /* ── 用例 7：pages 范围限定生效（真实文字层 PDF，端到端）────────────────── */
  {
    const pdfPath = join(WORK, 'text-4p.pdf')
    const filler = [
      'This page carries only placeholder prose so the text layer passes the trusted-characters bar.',
      'It deliberately contains no answer heading, no answer table and no Chinese question markers.',
    ]
    await writeTextPdf(pdfPath, [
      filler, filler, filler,
      ['Answer Key', '1. C 2. A 3. D 4. B 5. A', 'Each question is worth five points.'],
    ])

    const whole = await runFindAnswers({ path: pdfPath })
    check('用例7：整档判定时候选是第 4 页',
      /答案页候选：第 4 页/.test(whole), whole.split('\n')[0])
    check('用例7：给出两条可直接复制的 pdf_arrange 调用（order=1-3 / 4）',
      /order="1-3"/.test(whole) && /order="4"/.test(whole), whole.split('\n').filter(line => line.includes('pdf_arrange')).join(' ｜ '))
    check('用例7：两条命令都写明了输出文件',
      /output=".*-试卷\.pdf"/.test(whole) && /output=".*-答案\.pdf"/.test(whole), '')

    const ranged = await runFindAnswers({ path: pdfPath, pages: '3-4' })
    check('用例7：pages=3-4 只判这两页',
      /第 3 页｜/.test(ranged) && /第 4 页｜/.test(ranged)
      && !/第 1 页｜/.test(ranged) && !/第 2 页｜/.test(ranged),
      ranged.split('\n').filter(line => line.startsWith('第 ')).join(' ｜ '))
    check('用例7：pages=3-4 时说明未覆盖全文、不给整档拆分建议',
      ranged.includes('未覆盖全文') && !/pdf_arrange/.test(ranged), '')

    const front = await runFindAnswers({ path: pdfPath, pages: '1-2' })
    check('用例7：pages=1-2 判为"未找到答案页"（不硬凑）',
      front.includes('未找到答案页') && !front.includes('答案页候选'), front.split('\n')[0])
  }

  /* ── 用例 6：图片页 + ocr:false 判 unknown 并说明未做 OCR；ocr:true 能判答案页 ── */
  {
    const pdfPath = join(WORK, 'scan-1p.pdf')
    await writeImagePdf(pdfPath, (ctx) => {
      ctx.font = 'bold 64px sans-serif'
      ctx.fillText('Answer Key', 40, 120)
      ctx.fillText('1. C   2. A   3. D   4. B   5. A', 40, 240)
      ctx.font = '48px sans-serif'
      ctx.fillText('Each answer is worth five points.', 40, 360)
    })

    const off = await runFindAnswers({ path: pdfPath, ocr: false })
    check('用例6：ocr=false 时图片页判"无法判定"', /第 1 页｜无法判定/.test(off), off.split('\n').slice(0, 4).join(' / '))
    check('用例6：ocr=false 时依据说明"未做 OCR"', off.includes('未做 OCR'), '')
    check('用例6：ocr=false 时不猜答案（没有候选）', off.includes('未找到答案页'), off.split('\n')[0])

    // OCR 需要本机语言数据。缺失时**显式跳过并汇总**，不把断言悄悄放水。
    const status = inspectLanguageData('chi_sim')
    if (status.available.length === 0) {
      skip('用例6：ocr=true 时图片页能判为答案页', `语言数据缺失：${status.langPath}`)
    } else {
      const on = await runFindAnswers({ path: pdfPath, ocr: true })
      check('用例6：ocr=true 时图片页判为答案页', /第 1 页｜答案/.test(on),
        on.split('\n').filter(line => line.startsWith('第 ') || line.startsWith('答案页候选')).join(' ｜ '))
      check('用例6：OCR 后依据里出现速查表', on.includes('速查表'), '')
      // 默认 lang=chi_sim+eng；本机若缺 eng 数据，工具必须退化为可用语言并写明。
      const requested = inspectLanguageData('chi_sim+eng')
      if (requested.missing.length > 0) {
        check('用例6：语言数据缺失时退化为可用语言并在结论里写明',
          on.includes('已退化为') && on.includes(requested.missing.join('、')),
          on.split('\n').find(line => line.includes('退化为')) ?? '（没有退化说明）')
      }
    }
  }
  /* ── 用例 8：真答案页 + 紧跟的中性末页 → 位置先验不得稀释候选与 order ────── */
  {
    // 复现真文件现象：第 7 页是真答案（标题词 + 速查表，high），第 8 页空白/中性且落在末 25%。
    const scored = pagesOf([QUESTION_TEXT, QUESTION_TEXT, QUESTION_TEXT, QUESTION_TEXT, QUESTION_TEXT, QUESTION_TEXT, ANSWER_TEXT, NEUTRAL_TEXT])
    check('用例8：第 7 页判 answer/high', scored[6].verdict === 'answer' && scored[6].confidence === 'high',
      `${scored[6].verdict}/${scored[6].confidence}`)
    check('用例8：第 8 页是纯位置先验（answer/low + positionOnly）',
      scored[7].verdict === 'answer' && scored[7].confidence === 'low' && scored[7].positionOnly === true,
      `${scored[7].verdict}/${scored[7].confidence}/positionOnly=${String(scored[7].positionOnly)}`)

    const ranges = groupAnswerRanges(scored)
    check('用例8：候选只有第 7 页（low 不进候选）',
      ranges.answerRanges.length === 1 && ranges.answerRanges[0].from === 7 && ranges.answerRanges[0].to === 7,
      JSON.stringify(ranges.answerRanges))
    check('用例8：候选置信度不被稀释（仍是 high）', ranges.answerRanges[0]?.confidence === 'high',
      String(ranges.answerRanges[0]?.confidence))
    check('用例8：第 8 页归入 positionOnlyPages', ranges.positionOnlyPages.join(',') === '8',
      JSON.stringify(ranges.positionOnlyPages))

    const suggestion = suggestArrangement(8, ranges)
    check('用例8：可拆分且答案部分 order 不含第 8 页',
      suggestion.separable === true && suggestion.splits[1]?.order === '7',
      JSON.stringify(suggestion.splits.map(split => split.order)))
    check('用例8：其余部分 order 为 1-6,8（第 8 页归入试卷侧）',
      suggestion.splits[0]?.order === '1-6,8', String(suggestion.splits[0]?.order))
    check('用例8：说明里点出第 8 页只是"位置可疑"、未计入答案页',
      suggestion.note.includes('位置可疑') && suggestion.note.includes('第 8 页'), suggestion.note)
  }

  /* ── 用例 9：整份文档只有空白/中性末页 → 未找到答案页（仅位置可疑）、不给建议 ── */
  {
    const texts = [NEUTRAL_TEXT, NEUTRAL_TEXT, NEUTRAL_TEXT, NEUTRAL_TEXT]
    const scored = pagesOf(texts)
    const ranges = groupAnswerRanges(scored)
    check('用例9：没有 medium/high 的候选', ranges.answerRanges.length === 0, JSON.stringify(ranges.answerRanges))
    check('用例9：只有第 4 页是位置可疑页', ranges.positionOnlyPages.join(',') === '4',
      JSON.stringify(ranges.positionOnlyPages))

    const suggestion = suggestArrangement(4, ranges)
    check('用例9：不给拆分建议', suggestion.separable === false && suggestion.splits.length === 0, suggestion.note)
    check('用例9：中文说明"位置可疑、位置不是证据"',
      suggestion.note.includes('位置可疑') && suggestion.note.includes('位置不是证据'), suggestion.note)
  }

  /* ── 用例 10：端到端复现"真答案页 + 紧跟中性末页"（真文件现象）──────────── */
  {
    const filler = [
      'This page carries only placeholder prose so the text layer passes the trusted-characters bar.',
      'It deliberately contains no answer heading, no answer table and no Chinese question markers.',
    ]
    const pdfPath = join(WORK, 'text-5p-tail.pdf')
    await writeTextPdf(pdfPath, [
      filler, filler, filler,
      ['Answer Key', '1. C 2. A 3. D 4. B 5. A', 'Each question is worth five points.'],
      filler,
    ])
    const out = await runFindAnswers({ path: pdfPath })
    check('用例10：结论行只报第 4 页（置信度 高）',
      /答案页候选：第 4 页（置信度 高）/.test(out), out.split('\n')[0])
    check('用例10：出现「位置推断（仅供参考，不建议据此拆分）」一节',
      out.includes('位置推断（仅供参考，不建议据此拆分）')
      && /第 5 页｜分数 0\.5｜位于文档末 25%，无文本证据/.test(out),
      out.split('\n').filter(line => line.includes('仅供参考') || /^第 5 页｜分数/.test(line)).join(' ｜ '))
    check('用例10：order 不含第 5 页（答案部分是 "4"、其余部分是 "1-3,5"）',
      /order="4"/.test(out) && /order="1-3,5"/.test(out) && !/order="4-5"/.test(out),
      out.split('\n').filter(line => line.includes('pdf_arrange')).map(line => /order="[^"]*"/.exec(line)?.[0]).join(' / '))

    const onlyTailPath = join(WORK, 'text-4p-neutral.pdf')
    await writeTextPdf(onlyTailPath, [filler, filler, filler, filler])
    const onlyTail = await runFindAnswers({ path: onlyTailPath })
    check('用例10：只有中性末页时结论为"未找到答案页（仅第 4 页位置可疑，无文本证据）"',
      /未找到答案页（仅第 4 页位置可疑，无文本证据）/.test(onlyTail), onlyTail.split('\n')[0])
    check('用例10：只有中性末页时不给拆分建议（不出现 pdf_arrange）',
      !/pdf_arrange/.test(onlyTail), onlyTail.split('\n').find(line => line.includes('不给出拆分建议')) ?? '')
  }

  /* ── 用例 11：语言数据混装（chi_sim 只有 .gz + eng 只有裸文件）不许崩 ────── */
  {
    const realDir = inspectLanguageData('chi_sim').langPath
    const chiSimGz = join(realDir, 'chi_sim.traineddata.gz')
    const engRaw = join(realDir, 'eng.traineddata')
    if (!existsSync(chiSimGz) || !existsSync(engRaw)) {
      skip('用例11：混装语言数据的降级与"不崩"', `缺少真实样本：${chiSimGz} / ${engRaw}`)
    } else {
      const mixedDir = join(WORK, 'tessdata-mixed')
      const bothGzDir = join(WORK, 'tessdata-both-gz')
      mkdirSync(mixedDir, { recursive: true })
      mkdirSync(bothGzDir, { recursive: true })
      // 混装：chi_sim 只有 .gz、eng 只有裸 .traineddata（用软链接，不复制 44MB）
      symlinkSync(chiSimGz, join(mixedDir, 'chi_sim.traineddata.gz'))
      symlinkSync(engRaw, join(mixedDir, 'eng.traineddata'))
      // 另一种：两种语言都有 .gz
      symlinkSync(chiSimGz, join(bothGzDir, 'chi_sim.traineddata.gz'))
      const engGz = join(realDir, 'eng.traineddata.gz')
      const hasEngGz = existsSync(engGz)
      if (hasEngGz) symlinkSync(engGz, join(bothGzDir, 'eng.traineddata.gz'))

      const imagePdf = join(WORK, 'scan-1p-lang.pdf')
      await writeImagePdf(imagePdf, (ctx) => {
        ctx.font = 'bold 64px sans-serif'
        ctx.fillText('Answer Key', 40, 120)
        ctx.fillText('1. C   2. A   3. D   4. B   5. A', 40, 240)
        ctx.font = '48px sans-serif'
        ctx.fillText('Each answer is worth five points.', 40, 360)
      })
      const textPdf = join(WORK, 'text-1p-lang.pdf')
      await writeTextPdf(textPdf, [[
        'This page carries only placeholder prose so the text layer passes the trusted-characters bar.',
      ]])

      const saved = process.env.DSH_PDF_STUDIO_TESSDATA
      try {
        // ── 混装：按选定模式逐语言降级，且绝不把缺形式的语言交给 tesseract ──
        process.env.DSH_PDF_STUDIO_TESSDATA = mixedDir
        const mixed = inspectLanguageData('chi_sim+eng')
        check('用例11：混装时 gzip 模式定为 .gz，eng 因缺 .gz 被列为 missing',
          mixed.gzip === true && mixed.missing.join(',') === 'eng'
          && mixed.missingForms[0]?.want === 'gz' && mixed.missingForms[0]?.has.join(',') === 'raw',
          JSON.stringify(mixed))

        const out = await runFindAnswers({ path: imagePdf }) // 默认 lang=chi_sim+eng，会真跑 OCR
        check('用例11：混装语言数据不崩（同进程继续执行，且给出了判定）',
          /第 1 页｜/.test(out), out.split('\n').filter(line => line.startsWith('第 ')).join(' ｜ '))
        check('用例11：结果里写明为什么退化（eng 只有裸文件、当前需要 .gz）',
          out.includes('已退化为 chi_sim') && out.includes('只有裸文件'), 
          out.split('\n').find(line => line.includes('退化为')) ?? '（没有退化说明）')

        // ── 两种语言都有 .gz：都可用，无退化提示 ──
        if (hasEngGz) {
          process.env.DSH_PDF_STUDIO_TESSDATA = bothGzDir
          const both = inspectLanguageData('chi_sim+eng')
          check('用例11：两种语言都有 .gz 时都可用、gzip 模式、无 missing',
            both.available.length === 2 && both.missing.length === 0 && both.gzip === true,
            JSON.stringify(both))
          const out2 = await runFindAnswers({ path: textPdf })
          check('用例11：语言齐备时结果里没有退化提示', !out2.includes('已退化'),
            out2.split('\n').find(line => line.includes('已退化')) ?? '（无退化提示）')
        } else {
          skip('用例11：两种语言都有 .gz 时无退化', `缺少 ${engGz}`)
        }
      } finally {
        if (saved === undefined) delete process.env.DSH_PDF_STUDIO_TESSDATA
        else process.env.DSH_PDF_STUDIO_TESSDATA = saved
      }
    }
  }

  /* ── 用例 12：英文短答案页真跑 OCR（lang=eng）→ answer/high ──────────────── */
  {
    const engReady = inspectLanguageData('eng').available.length > 0
    if (!engReady) {
      skip('用例12：英文短答案页 OCR 判为 answer/high', '缺少 eng 语言数据')
    } else {
      const answerPdf = join(WORK, 'scan-en-answer.pdf')
      await writeImagePdf(answerPdf, (ctx) => {
        ctx.font = 'bold 64px sans-serif'
        ctx.fillText('Answer Key', 40, 120)
        ctx.fillText('1 C   2. A   3. D   4. B   5. C', 40, 240)
        ctx.fillText('6. D   7. B   8. A   9. C   10. D', 40, 340)
      })
      const out = await runFindAnswers({ path: answerPdf, lang: 'eng' })
      check('用例12：英文短答案页真跑 OCR 后判为答案页/高',
        /答案页候选：第 1 页（置信度 高）/.test(out) && /第 1 页｜答案｜9/.test(out),
        out.split('\n').filter(line => line.startsWith('第 ') || line.startsWith('答案页候选')).join(' ｜ '))
      check('用例12：依据含 Answer Key 标题词与速查表',
        /answerkey/.test(out) && /速查表/.test(out),
        out.split('\n').find(line => line.startsWith('第 1 页｜')) ?? '')
      check('用例12：不再被"文本过少"拦下',
        !out.includes('文本过少'), out.split('\n').find(line => line.includes('文本过少')) ?? '（没有文本过少）')

      // 只有一行 "Answer Key"、没有任何速查表 → 标题词单独足够
      const titleOnlyPdf = join(WORK, 'scan-en-title-only.pdf')
      await writeImagePdf(titleOnlyPdf, (ctx) => {
        ctx.font = 'bold 72px sans-serif'
        ctx.fillText('Answer Key', 60, 200)
      })
      const titleOnly = await runFindAnswers({ path: titleOnlyPdf, lang: 'eng' })
      check('用例12：只有一行 Answer Key 也判 answer/high（标题词单独足够）',
        /答案页候选：第 1 页（置信度 高）/.test(titleOnly) && /第 1 页｜答案｜5/.test(titleOnly),
        titleOnly.split('\n').filter(line => line.startsWith('第 ') || line.startsWith('答案页候选')).join(' ｜ '))
    }
  }

  /* ── 补充：整档 OCR > 20 页在 always 策略下走 expensive 门控 ─────────────── */
  {
    const pdfPath = join(WORK, 'text-21p.pdf')
    const filler = [
      'This page carries only placeholder prose so the text layer passes the trusted-characters bar.',
      'It deliberately contains no answer heading, no answer table and no Chinese question markers.',
    ]
    await writeTextPdf(pdfPath, Array.from({ length: 21 }, () => filler))

    const run = async (policy, args) => {
      const tools = buildToolDefinitions({ workspaceRoot: WORK, confirmation: policy })
      const tool = tools.find(item => item.name === 'pdf_find_answers')
      return (await tool.execute(args)).text
    }

    const gated = await run('always', { path: pdfPath })
    check('补充：always 策略下整档判定（21 页 > 20）返回确认单而不是直接跑',
      /计划 id：p_/.test(gated) && gated.includes('超过 20 页阈值'),
      gated.split('\n').slice(0, 3).join(' / '))
    check('补充：确认单说明本工具没有令牌参数、要拆段调用',
      gated.includes('没有 plan/confirm/force 令牌参数') && gated.includes('pages=1-20'),
      gated.split('\n').find(line => line.includes('令牌参数')) ?? '（缺少说明）')

    const ranged = await run('always', { path: pdfPath, pages: '1-5' })
    check('补充：always 策略下给 pages（≤ 阈值）直接执行，不出确认单',
      !/计划 id：p_/.test(ranged) && ranged.includes('逐页判定'), ranged.split('\n')[0])

    const never = await run('never', { path: pdfPath })
    check('补充：never 策略下整档判定直接执行',
      never.includes('逐页判定') && !/计划 id：p_/.test(never), never.split('\n')[0])
  }
} finally {
  rmSync(WORK, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'ALL ANSWER-PAGES CHECKS PASSED' : `${failed} check(s) FAILED`}`
  + `${skipped === 0 ? '' : `（SKIP ${skipped} 项，见上方 SKIP 行）`}`)
if (failed > 0) process.exitCode = 1
