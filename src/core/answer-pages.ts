/**
 * 答案页候选检测：从"每页的文字 + 页序号"里推断哪几页是答案，
 * 给出**候选页范围 + 中文依据 + 置信度**，交给用户确认。
 *
 * ## 为什么需要它
 *
 * 真实的"试卷 + 答案"PDF（例如 7 页全图片扫描件）里，哪几页是答案现在只能靠助手逐页看图/OCR
 * 猜出来——同一份文件问两次可能得到两个答案。这个模块把判定变成可复现的打分：
 * 页首答案标题词、答案速查表、解答句特征、题干特征，各自有固定权重，每一条命中都写进
 * `evidence`（中文），结论带置信度。
 *
 * ## 三条硬规则
 *
 * 1. **零误报优先**：纯题目卷（只有「（本小题 N 分）」「如图」「已知」）必须判成"不是答案页"，
 *    `answerRanges` 为空。宁可漏报，不可硬凑一个候选。
 * 2. **位置先验只做微弱 tiebreak**：总分绝对值 ≤ 1 且本页位于文档末 25% 时才 +0.5，
 *    依据里必须显式写「仅依据位置推断，置信度低」。这种页（`positionOnly`）**不进候选区间、
 *    不进拆分建议**——否则"第 7 页真答案 + 第 8 页空白"会被写成"候选 7-8 页（低）/ order=7-8"。
 * 3. **mixed 是诚实结论**：同一页同时有答案侧特征（标题词/速查表）和 ≥2 类题干特征时判 `mixed`，
 *    说明"答案与题目同页"，**不做内容级分离**，也不给"两段式"拆分建议。
 *
 * 另外：**"文本过少"不压强信号**。先算标题词/速查表，再决定要不要用字数门槛短路——
 * 短答案页（英文 `Answer Key` + `1. C 2. A`）经常只有几十个字符，先短路会把 +5/+4 直接丢掉。
 *
 * 纯函数、无 IO、可单测；PDF 读取与 OCR 由宿主工具负责（`src/host/tools.ts` 的 `pdf_find_answers`）。
 *
 * @module dsh-pdf-studio/core/answer-pages
 */

import type { PageKind } from './contracts.ts'

/** 单页判定结论。 */
export type AnswerVerdict = 'answer' | 'question' | 'mixed' | 'unknown'

/** 置信度：high / medium / low。 */
export type AnswerConfidence = 'high' | 'medium' | 'low'

/** 一页的打分输入。 */
export interface AnswerPageInput {
  /** 该页可读到的文字（文字层或 OCR 结果，按阅读顺序拼接）。 */
  text: string
  /** 1 基页号。 */
  pageNumber: number
  /** 文档总页数（位置先验要用）。 */
  pageCount: number
  /** 分诊给出的页类型。 */
  kind?: PageKind
  /**
   * 调用方明确"这页没做 OCR"（`ocr: false` 的图片页）。
   *
   * 加上这个可选字段是为了让"未做 OCR"和"文本过少"给出**不同**的依据：
   * 前者是"我们没看"，后者是"看了但内容太少"，不能混成一句话。
   */
  ocrSkipped?: boolean
}

/** 一页的打分结果。 */
export interface AnswerPageScore {
  verdict: AnswerVerdict
  score: number
  confidence: AnswerConfidence
  /** 中文依据，逐条对应命中的规则（含加减分）。 */
  evidence: string[]
  /**
   * `true` 表示这个 `answer` 结论**只来自位置先验**（没有任何文本证据）。
   *
   * 这种页只是"位于文档末尾"而已，**不能**进候选区间、**不能**进拆分建议：
   * 否则一个真答案页（第 7 页）后面跟一页空白（第 8 页）就会被写成
   * "候选：第 7-8 页（置信度 低）"并建议 `order="7-8"`，把无关的第 8 页一起拆出去。
   */
  positionOnly?: boolean
}

/** 带页号的判定结果，供区间合并使用。 */
export type ScoredPage = AnswerPageScore & { page: number }

/** 一段连续的页区间。 */
export interface AnswerRange {
  from: number
  to: number
  /** 区间内**最弱**的那一页的置信度（区间不会比它的弱页更可信）。 */
  confidence: AnswerConfidence
}

/** 分组结果：连续页合并成区间。 */
export interface AnswerRanges {
  /**
   * 可据以拆分的答案候选区间：**只含 medium/high 置信度**的页。
   *
   * `low`（含纯位置先验得到的页）不在这里——见 `positionOnlyPages`。
   */
  answerRanges: AnswerRange[]
  questionRanges: AnswerRange[]
  /** 只有位置先验支撑的 `answer` 页（low）：仅供参考，不参与拆分。 */
  positionOnlyPages: number[]
  unknownPages: number[]
  mixedPages: number[]
}

/** 一条可直接执行的拆分建议（order 已按 pdf_arrange 的语法压缩成区间）。 */
export interface ArrangementSplit {
  /** `pdf_arrange` 的 order 值，例如 `1-6` / `2,4,6`。 */
  order: string
  role: 'questions' | 'answers'
  label: string
  pages: number[]
}

/** 下一步建议。 */
export interface ArrangementSuggestion {
  /** 能否按页拆成"试卷 / 答案"两个 PDF。 */
  separable: boolean
  note: string
  splits: ArrangementSplit[]
}

/** 权重与阈值，导出给测试与文档引用（改这里必须同步 README）。 */
export const ANSWER_PAGE_WEIGHTS = {
  /** 页首出现答案标题词。 */
  titleWord: 5,
  /** 答案速查表（连续递增 ≥ tableGroups 组「题号+字母」，或等长连续块）。 */
  answerTable: 4,
  /** 解答句特征（≥ solutionHits 处）。 */
  solutionMarker: 2,
  /** 每一类题干特征。 */
  questionCategory: -2,
  /** 位置先验（仅 |总分| ≤ 1 时的微弱 tiebreak）。 */
  positionTiebreak: 0.5,
  /** 正文有效字符下限：**只**在没有强信号（标题词/速查表）时才拦。 */
  minChars: 20,
  /** "页首"窗口（字符）。 */
  headChars: 200,
  /** 依据里回显本页识别文字的长度（便于核对"有效字符"计数口径）。 */
  excerptChars: 60,
  /** 速查表至少要有几组。 */
  tableGroups: 5,
  /** 解答句至少出现几次。 */
  solutionHits: 2,
  /** mixed 需要几类题干特征。 */
  mixedQuestionCategories: 2,
  /** ≥ 该分数判 answer。 */
  answerThreshold: 2,
  /** ≤ 该分数判 question。 */
  questionThreshold: -2,
  /** 末 25% 页算"尾部"。 */
  tailFraction: 0.25,
} as const

/** 答案侧标题词（中文）。只认这些，不做同义扩展——没收录就当没看到。 */
const TITLE_WORDS_CN = ['参考答案', '答案与解析', '答案速查', '评分标准', '试题解析', '答案及解析', '答案']

/** 答案侧标题词（英文，比较前会去掉空白并转小写）。 */
const TITLE_WORDS_EN = ['answerkey', 'answers', 'solutions', 'markscheme']

/**
 * 题干特征：**每类最多算一次**（−2），不管出现多少次。
 *
 * 正则里插 `\s*`：OCR 经常在汉字之间塞空格（`已知` → `已 知`），
 * 不这样写会把真实试卷的题干特征全部漏掉。
 */
const QUESTION_MARKERS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: '（本小题 N 分）', re: /[（(]?\s*本\s*小\s*题\s*\d+\s*分\s*[）)]?/ },
  { label: '（本题 N 分）', re: /[（(]?\s*本\s*题\s*\d+\s*分\s*[）)]?/ },
  { label: '每小题 N 分', re: /每\s*小\s*题\s*\d+\s*分/ },
  { label: '解答应写出文字说明', re: /解\s*答\s*应\s*写\s*出\s*文\s*字\s*说\s*明/ },
  { label: '如图', re: /如\s*图/ },
  { label: '已知', re: /已\s*知/ },
  { label: '求证', re: /求\s*证/ },
]

/** 解答句特征（每处都计数，总数 ≥ solutionHits 才加分）。 */
const SOLUTION_MARKERS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: '解：', re: /解\s*[:：]/g },
  { label: '证明：', re: /证\s*明\s*[:：]/g },
  { label: '答：', re: /答\s*[:：]/g },
  { label: '∴', re: /∴/g },
  { label: '∵', re: /∵/g },
  { label: '由…得…', re: /由[^。．\n]{0,24}?得(?:出)?/g },
]

/** 有效字符数（忽略空白）。 */
export function meaningfulChars(text: string): number {
  let n = 0
  for (const char of text) if (!/\s/.test(char)) n += 1
  return n
}

/**
 * 答案速查表：`1 C 2 A 3 D` 这种"题号 + 单个字母"的**连续递增段**，以及 `1-5 CBDAB` 连续块。
 *
 * 为什么不能只数「数字+字母」的组数：真实试卷的选项列表就是 `A,5 B,4 C 3 D,2`——
 * 每个选项值后面紧跟着下一个选项字母，凭空造出 3 组「数字+字母」，一份 9 题的试卷能凑出 15 组。
 * 实测（`2025.10沈阳43中八上数学月考试卷+答案.pdf` 第 1 页）就是这么误报成答案页的。
 *
 * 真正的答案速查表有两个结构特征，选项列表没有：
 *   1. 题号**严格递增 +1**（选项值的数字是递减的，或同一数字重复）；
 *   2. 相邻两对**挨得很近**（选项列表中间隔着选项文字）。
 * 所以这里只认"最长连续递增段"，块状写法按 `字母数 === 结束号 − 开始号 + 1` 严格校验。
 * 字母认 **A–F**（有些卷子选项到 F）；但"连续递增 +1"与"间距 ≤ 24 字符"这两条**不能放宽**——
 * 一放宽，上面那份试卷第 1 页的选项列表立刻又会把整页判成答案页。
 */
const ANSWER_PAIR_RE = /(\d{1,3})\s*[.、．,，:：)）]?\s*([A-Fa-f])(?![A-Za-z0-9])/g

/** 连续块：`1-5 CBDAB`（字母数必须与区间长度相等）。 */
const ANSWER_BLOCK_RE = /(\d{1,3})\s*[-–—~]\s*(\d{1,3})\s*[.、．:：)）]?\s*([A-Fa-f]{2,})(?![A-Za-z0-9])/g

/** 速查表里相邻两对之间允许的最大间隔字符数（超过就认为不是同一张表）。 */
export const ANSWER_TABLE_MAX_GAP = 24

interface TablePair {
  number: number
  start: number
  end: number
  text: string
}

/**
 * 扫描答案速查表。
 *
 * 返回 `groups` = 最长连续递增段的长度（与连续块长度取较大者），以及 `samples`（前 3 对，供依据引用）。
 */
export function scanAnswerTable(text: string): {
  groups: number
  samples: string[]
  longestRun: number
  blockLetters: number
} {
  const pairs: TablePair[] = []
  const pairRe = new RegExp(ANSWER_PAIR_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = pairRe.exec(text)) !== null) {
    pairs.push({
      number: Number(match[1]),
      start: match.index,
      end: match.index + match[0].length,
      text: match[0].replace(/\s+/g, ' ').trim(),
    })
    if (match.index === pairRe.lastIndex) pairRe.lastIndex += 1 // 空匹配保护
  }

  let longestRun = 0
  let best: TablePair[] = []
  let runStart = 0
  for (let i = 0; i < pairs.length; i += 1) {
    if (i > 0) {
      const prev = pairs[i - 1]
      const cur = pairs[i]
      const linked = cur.number === prev.number + 1 && cur.start - prev.end <= ANSWER_TABLE_MAX_GAP
      if (!linked) runStart = i
    }
    const length = i - runStart + 1
    if (length > longestRun) {
      longestRun = length
      best = pairs.slice(runStart, i + 1)
    }
  }

  let blockLetters = 0
  let blockSample: string | undefined
  const blockRe = new RegExp(ANSWER_BLOCK_RE.source, 'g')
  while ((match = blockRe.exec(text)) !== null) {
    const from = Number(match[1])
    const to = Number(match[2])
    const letters = match[3]
    // 字母数必须与区间长度严格相等：`1-5 CBDAB` 是答案块，`1-5 题` 不是。
    if (to >= from && to - from + 1 === letters.length && letters.length > blockLetters) {
      blockLetters = letters.length
      blockSample = match[0].replace(/\s+/g, ' ').trim()
    }
    if (match.index === blockRe.lastIndex) blockRe.lastIndex += 1
  }

  const groups = Math.max(longestRun, blockLetters)
  const samples = longestRun >= blockLetters
    ? best.slice(0, 3).map(pair => pair.text)
    : (blockSample === undefined ? [] : [blockSample])
  return { groups, samples, longestRun, blockLetters }
}

/** 扫描解答句特征，返回总处数与命中标签。 */
export function scanSolutionMarkers(text: string): { total: number; labels: string[] } {
  let total = 0
  const labels: string[] = []
  for (const marker of SOLUTION_MARKERS) {
    const re = new RegExp(marker.re.source, 'g')
    const hits = text.match(re)?.length ?? 0
    if (hits > 0) {
      total += hits
      labels.push(`${marker.label}×${hits}`)
    }
  }
  return { total, labels }
}

/** 扫描题干特征：返回命中的类别（每类最多一次）。 */
export function scanQuestionMarkers(text: string): Array<{ label: string }> {
  return QUESTION_MARKERS.filter(marker => marker.re.test(text)).map(marker => ({ label: marker.label }))
}

/** 置信度排序，用于区间取"最弱页"。 */
const CONFIDENCE_RANK: Record<AnswerConfidence, number> = { low: 0, medium: 1, high: 2 }

/** 取两个置信度里更弱的那个。 */
export function weakerConfidence(a: AnswerConfidence, b: AnswerConfidence): AnswerConfidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b
}

/** 中文页列表，用于依据/提示文案。 */
export function formatPages(pages: readonly number[]): string {
  return pages.length <= 12
    ? `第 ${pages.join('、')} 页`
    : `第 ${pages.slice(0, 12).join('、')} 页等共 ${pages.length} 页`
}

/**
 * 给一页打分并给出结论。
 *
 * 判定顺序：**先算强信号**（标题词 +5 / 速查表 +4）→ 未做 OCR 或无强信号且文本过少 → unknown；
 * 答案侧 + ≥2 类题干 → mixed；总分 ≥ 2 → answer；≤ −2 → question；其余（|总分| ≤ 1）才轮到位置先验。
 *
 * 注意"文本过少"**不压强信号**：短答案页（`Answer Key` 或 `1. C 2. A` 就十几到几十个字符）
 * 一样按分数判 answer——用字数门槛在打分前短路，会把决定性的 +5/+4 直接丢掉。
 */
export function scoreAnswerPage(input: AnswerPageInput): AnswerPageScore {
  const text = typeof input.text === 'string' ? input.text : ''
  const chars = meaningfulChars(text)
  const evidence: string[] = []
  const W = ANSWER_PAGE_WEIGHTS

  if (input.ocrSkipped === true) {
    return {
      verdict: 'unknown',
      score: 0,
      confidence: 'low',
      evidence: ['未做 OCR（ocr=false）：这是图片页，不做识别就无法判断；需要判定请加 ocr=true'],
    }
  }

  let score = 0

  // ── 标题词（页首 headChars 字内）──────────────────────────────────────────
  const head = text.slice(0, W.headChars)
  const headFlat = head.replace(/\s+/g, '').toLowerCase()
  const titleHits = [...TITLE_WORDS_CN, ...TITLE_WORDS_EN].filter(word => headFlat.includes(word))
  if (titleHits.length > 0) {
    score += W.titleWord
    evidence.push(`页首出现答案标题词：${titleHits.join('、')}（+${W.titleWord}）`)
  } else {
    evidence.push('页首没有答案标题词（答案 / 参考答案 / 评分标准 / Answer Key 等）')
  }

  // ── 答案速查表 ──────────────────────────────────────────────────────────
  const table = scanAnswerTable(text)
  const tableHit = table.groups >= W.tableGroups
  if (tableHit) {
    score += W.answerTable
    evidence.push(
      `答案速查表：连续 ${table.groups} 组「题号+字母」（如 ${table.samples.join('、')}）（+${W.answerTable}）`,
    )
  } else if (table.groups > 0) {
    evidence.push(`只找到连续 ${table.groups} 组「题号+字母」，不足 ${W.tableGroups} 组，不计为速查表`)
  }

  // ── "文本过少"只压没有强信号的页 ─────────────────────────────────────────
  //
  // 先算完标题词与速查表再判断：短答案页（英文 `Answer Key` + `1. C 2. A`，十几到几十个字符）
  // 在真实 OCR 里很常见，用字数门槛在打分**之前**短路会把 +5/+4 这两个决定性信号直接压掉——
  // 实测一份**读对了**的英文答案页被写成"文本过少，无法判断（35 个字符）"。
  // 现在：命中标题词或速查表就不受门槛限制；只有"没有强信号且文本确实很少"才 unknown。
  const strong = titleHits.length > 0 || tableHit
  if (!strong && chars < W.minChars) {
    const excerpt = text.replace(/\s+/g, ' ').trim()
    evidence.push(
      `文本过少，无法判断（有效字符 ${chars} 个＝去掉空白后的字符数，下限 ${W.minChars}；`
      + '且未命中答案标题词/速查表这类强信号）',
    )
    if (excerpt !== '') {
      evidence.push(`本页识别到的文字（前 ${W.excerptChars} 字）：${excerpt.slice(0, W.excerptChars)}`)
    }
    return { verdict: 'unknown', score: 0, confidence: 'low', evidence }
  }

  // ── 解答句特征 ──────────────────────────────────────────────────────────
  const solution = scanSolutionMarkers(text)
  if (solution.total >= W.solutionHits) {
    score += W.solutionMarker
    evidence.push(`解答句特征 ${solution.total} 处（${solution.labels.join('、')}）（+${W.solutionMarker}）`)
  }

  // ── 题干特征（每类各算一次）─────────────────────────────────────────────
  const questions = scanQuestionMarkers(text)
  if (questions.length > 0) {
    const delta = W.questionCategory * questions.length
    score += delta
    evidence.push(`题干特征 ${questions.length} 类：${questions.map(item => item.label).join('、')}（${delta}）`)
  }

  const answerSide = titleHits.length > 0 || tableHit

  // ── 结论 ────────────────────────────────────────────────────────────────
  if (answerSide && questions.length >= W.mixedQuestionCategories) {
    evidence.push(
      `同一页既有答案特征（${titleHits.length > 0 ? '标题词' : ''}${titleHits.length > 0 && tableHit ? '/' : ''}`
      + `${tableHit ? '速查表' : ''}）又有 ${questions.length} 类题干特征 → 判为 mixed：答案与题目同页，无法按页分离`,
    )
    return { verdict: 'mixed', score, confidence: 'medium', evidence }
  }

  if (score >= W.answerThreshold) {
    return { verdict: 'answer', score, confidence: score >= W.titleWord ? 'high' : 'medium', evidence }
  }

  if (score <= W.questionThreshold) {
    return {
      verdict: 'question',
      score,
      confidence: score <= W.questionCategory * 2 ? 'high' : 'medium',
      evidence,
    }
  }

  // ── 位置先验（只在这里、只加 0.5）────────────────────────────────────────
  const pageCount = Number.isFinite(input.pageCount) && input.pageCount > 0 ? input.pageCount : 0
  const tailStart = pageCount === 0 ? 1 : Math.floor(pageCount * (1 - W.tailFraction)) + 1
  const inTail = pageCount > 0 && input.pageNumber >= tailStart
  if (Math.abs(score) <= 1 && inTail) {
    score += W.positionTiebreak
    evidence.push(
      `仅依据位置推断，置信度低：本页位于文档末 ${Math.round(W.tailFraction * 100)}%（第 ${input.pageNumber}/${pageCount} 页），`
      + '文本特征不足以判定，位置不是证据（+0.5 tiebreak）',
    )
    return { verdict: 'answer', score, confidence: 'low', evidence, positionOnly: true }
  }

  evidence.push('文本特征不足以判定类别（既不像答案页，也不像题目页）')
  return { verdict: 'unknown', score, confidence: 'low', evidence }
}

/** 把同一结论的连续页合并成区间。 */
function mergeRuns(pages: readonly ScoredPage[]): AnswerRange[] {
  const sorted = [...pages].sort((a, b) => a.page - b.page)
  const out: AnswerRange[] = []
  for (const page of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && last.to === page.page - 1) {
      last.to = page.page
      last.confidence = weakerConfidence(last.confidence, page.confidence)
      continue
    }
    out.push({ from: page.page, to: page.page, confidence: page.confidence })
  }
  return out
}

/**
 * 逐页判定 → 分组区间。
 *
 * **候选区间只收 medium/high**：纯位置先验（`positionOnly`）或 `low` 置信度的页会被归到
 * `positionOnlyPages`，既不进候选、也不进 order——这样"第 7 页真答案 + 第 8 页空白"给出的是
 * `第 7 页` 与 `order="7"`，而不是被稀释成 `第 7-8 页（低）` / `order="7-8"`。
 */
export function groupAnswerRanges(pages: readonly ScoredPage[]): AnswerRanges {
  const sorted = [...pages].sort((a, b) => a.page - b.page)
  const isConfidentAnswer = (page: ScoredPage): boolean =>
    page.verdict === 'answer' && page.positionOnly !== true && page.confidence !== 'low'
  const isPositionOnly = (page: ScoredPage): boolean =>
    page.verdict === 'answer' && (page.positionOnly === true || page.confidence === 'low')
  return {
    answerRanges: mergeRuns(sorted.filter(isConfidentAnswer)),
    questionRanges: mergeRuns(sorted.filter(page => page.verdict === 'question')),
    positionOnlyPages: sorted.filter(isPositionOnly).map(page => page.page),
    unknownPages: sorted.filter(page => page.verdict === 'unknown').map(page => page.page),
    mixedPages: sorted.filter(page => page.verdict === 'mixed').map(page => page.page),
  }
}

/** 区间 → 中文描述（`第 1-2 页` / `第 7 页`）。 */
export function formatRange(range: AnswerRange): string {
  return range.from === range.to ? `第 ${range.from} 页` : `第 ${range.from}-${range.to} 页`
}

/** 页号数组 → `pdf_arrange` 的 order 串（压缩连续段：`1-3,7`）。 */
export function compressOrder(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const parts: string[] = []
  let start: number | undefined
  let prev: number | undefined
  for (const page of sorted) {
    if (start === undefined) {
      start = page
      prev = page
      continue
    }
    if (prev !== undefined && page === prev + 1) {
      prev = page
      continue
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`)
    start = page
    prev = page
  }
  if (start !== undefined) parts.push(start === prev ? String(start) : `${start}-${prev}`)
  return parts.join(',')
}

/** 区间列表 → 页号数组。 */
function flattenRanges(ranges: readonly AnswerRange[]): number[] {
  const out: number[] = []
  for (const range of ranges) for (let page = range.from; page <= range.to; page += 1) out.push(page)
  return out
}

/**
 * 生成下一步建议。
 *
 * - `mixedPages` 非空 → **不给**拆分建议，只说明"答案与题目同页，无法按页分离"；
 * - 只有位置先验的页（`positionOnlyPages`）→ 也不给拆分建议（位置不是证据）；
 * - 答案页分多段（与题目交替）→ 也不给"两段式"建议（那会切错），改为如实说明；
 * - 恰好一段连续答案页（medium/high）→ 给两条 `pdf_arrange` 的 order（其余部分 / 答案部分）。
 *
 * 这里只产出**纯数据**（order + 角色 + 标签）；把 path/output 拼成可复制的命令是宿主工具的事。
 */
export function suggestArrangement(pageCount: number, ranges: AnswerRanges): ArrangementSuggestion {
  if (ranges.mixedPages.length > 0) {
    return {
      separable: false,
      note: `${formatPages(ranges.mixedPages)}答案与题目同页，无法按页分离（本工具不做内容级拆分）。`,
      splits: [],
    }
  }

  if (ranges.answerRanges.length === 0) {
    return {
      separable: false,
      note: ranges.positionOnlyPages.length > 0
        ? `${formatPages(ranges.positionOnlyPages)}只是"位置可疑"（位于文档末 25%，没有任何文本证据），`
          + '不给出拆分建议——位置不是证据。'
        : '未找到答案页候选，不给出拆分建议。',
      splits: [],
    }
  }

  if (ranges.answerRanges.length > 1) {
    const where = ranges.answerRanges.map(range => formatRange(range)).join('、')
    return {
      separable: false,
      note: `答案页分成 ${ranges.answerRanges.length} 段且与题目交替分布（${where}），不能按"两段式"拆分——`
        + '那样会切错；请先人工确认哪几页是答案，或按段分别用 pdf_arrange 重排。',
      splits: [],
    }
  }

  const answers = flattenRanges(ranges.answerRanges)
  if (answers.length >= pageCount) {
    return { separable: false, note: '全部页面都是答案页候选，无需拆分。', splits: [] }
  }

  const answerSet = new Set(answers)
  const questions: number[] = []
  for (let page = 1; page <= pageCount; page += 1) if (!answerSet.has(page)) questions.push(page)

  const extras: string[] = []
  if (ranges.positionOnlyPages.length > 0) {
    extras.push(`${formatPages(ranges.positionOnlyPages)}只是"位置可疑"（无文本证据），未计入答案页`)
  }
  if (ranges.unknownPages.length > 0) {
    extras.push(`${formatPages(ranges.unknownPages)}无法判定，已归入"其余部分"，请人工核对`)
  }
  const tailNote = extras.length === 0 ? '' : `（${extras.join('；')}）`

  const splits: ArrangementSplit[] = [
    {
      order: compressOrder(questions),
      role: 'questions',
      label: `其余部分（${formatPages(questions)}）`,
      pages: questions,
    },
    {
      order: compressOrder(answers),
      role: 'answers',
      label: `答案部分（${formatPages(answers)}）`,
      pages: answers,
    },
  ]

  return {
    separable: true,
    note: `答案页集中在${formatRange(ranges.answerRanges[0])}，可按页拆成两个 PDF（两次 pdf_arrange）${tailNote}`,
    splits,
  }
}
