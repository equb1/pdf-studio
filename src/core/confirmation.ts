/**
 * 执行前确认（confirmation gate）。
 *
 * ## 为什么需要它
 *
 * 插件的使用者是普通人，他们的诉求常常是模糊的（"帮我把这个 PDF 弄一下"）。
 * 工具一旦被调用就必须返回结果，没有中途反问的机会，所以模糊输入最常见的失败方式不是报错，
 * 而是**"看起来成功"**：改到了错的文件、改错了页、什么都没改却说"已生成"。
 *
 * 这个模块把"确认"做成一次可校验的握手：
 *
 *   1. 工具先算出**这份操作计划**（文件指纹、参数、默认值、影响、可改项），把它返回给上层；
 *   2. 用户看到计划（浮层卡片或纯文本）后确认；
 *   3. 上层带着 `confirm: <planId>` 再调一次，这里**重新计算** planId 并比对——
 *      参数被改过、文件被换过、计划过期或被取消，都拒绝执行。
 *
 * planId 里不含时间戳，只含"要做什么 + 对哪个文件 + 写到哪"，所以第 3 步能机械地判断
 * "用户确认的"与"即将执行的"是不是同一件事。这就是"确认"不流于形式的原因。
 *
 * ## 三类门控
 *
 * - `destructive`：会改内容或覆盖已有文件（改写文字、移除水印、加密/解密、输出已存在）。
 * - `expensive`：代价高（整档 OCR、深层分诊、几十页的可搜索化）。
 * - `ambiguous`：会导致"猜"的地方（缺关键参数、同名多文件、整档几百页）。
 *
 * 策略 `requireConfirmation` 决定**从哪一级开始要求确认**：
 * `never` 从不问；`destructive`（默认）只在破坏性操作上问；`always` 三类都问。
 * 注意：`ambiguous` 里那些"必须靠猜才能继续"的情况在这里被当成**错误**处理
 * （例如同名多文件要求用户指明），而不是猜一个然后请人确认——猜错的文件名比多问一句危险得多。
 *
 * @module dsh-pdf-studio/core/confirmation
 */

import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'

/** 门控类别。 */
export type ConfirmationGate = 'none' | 'destructive' | 'expensive' | 'ambiguous'

/** 何时要求确认。 */
export type ConfirmationPolicy = 'destructive' | 'always' | 'never'

/** 默认策略：只有破坏性操作才需要确认。 */
export const DEFAULT_CONFIRMATION_POLICY: ConfirmationPolicy = 'destructive'

/** 计划有效期：超过这个时间就要求重新生成（避免用户半小时前点的"确认"被复用）。 */
export const PLAN_TTL_MS = 15 * 60 * 1000

/** 计划标识的算法版本；改动 planId 的构成时必须 +1，否则旧计划会被误判为匹配。 */
const PLAN_VERSION = 1

/** 一个文件的"身份"：路径 + 大小 + 修改时间，用来发现"计划生成后文件被换过"。 */
export interface FileFingerprint {
  path: string
  size: number
  mtimeMs: number
}

/** 计划状态机。 */
export type PlanStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'consumed'

/** 一份待确认的操作计划。 */
export interface OperationPlan {
  planId: string
  tool: string
  action: string
  /** 中文标题，给用户看。 */
  title: string
  gate: ConfirmationGate
  /** 为什么被判成这个门控（给上层解释，也给评审留痕）。 */
  gateReasons: string[]
  /** 多行确认单。文本回退与浮层卡片展示的是同一份，避免两处措辞漂移。 */
  sheet: string
  /** 参与读取的文件指纹。 */
  inputs: FileFingerprint[]
  /** 将要写入的位置，以及是否会覆盖已有文件。 */
  output?: { path: string; overwrites: boolean }
  /** 已解析的参数（含默认值），canonical 化后参与 planId。 */
  parameters: Record<string, unknown>
  /** 其中哪些是"用户没明说、由插件默认"的项。 */
  defaults: Record<string, unknown>
  /** 影响面：改不改源文件、写哪、多少页、能不能撤销。 */
  effects: string[]
  /** 可纠正项提示（普通用户看到就能改口）。 */
  hints: string[]
  /** 歧义点（存在时说明为什么需要人确认）。 */
  ambiguous: string[]
  createdAt: number
  expiresAt: number
  status: PlanStatus
}

/** 判定的输入：由工具在"已经解析完参数、但还没写盘"时组装。 */
export interface GateInput {
  tool: string
  action: string
  /** 已解析参数（只放稳定、可比较的字段；不要把时间戳/随机值放进来）。 */
  parameters: Record<string, unknown>
  /** 要读的文件路径（不存在或 undefined 会被忽略）。 */
  inputs?: Array<string | undefined>
  /** 要写的位置。 */
  output?: string | undefined
  /** 文档页数（工具已经知道时传，用于高成本判定）。 */
  pageCount?: number | undefined
  /** 是否"整档"操作（未指定 pages）。 */
  wholeDocument?: boolean
  /** 必需但缺失的参数名（歧义）。 */
  missing?: string[]
  /** 路径消歧时的候选文件（>1 个即歧义）。 */
  candidates?: string[]
  /** 工具自己发现的歧义（例如"这一页没有文字层，需要先 OCR"）。 */
  notes?: string[]
  /**
   * 工具已经判定"这次不能做"的中文原因（例如拆分的候选页全是不规范页）。
   *
   * 与 `notes`（歧义 → 出确认单等人确认）不同：这里的原因意味着**即使确认也不能做**，
   * 所以 `authorize()` 直接走 `refused`，绝不落盘。
   */
  refusals?: string[]
}

/** 判定结果。 */
export interface GateDecision {
  gate: ConfirmationGate
  reasons: string[]
  ambiguous: string[]
}

/** 采集文件指纹；文件不存在时返回 undefined（调用方负责报"文件不存在"）。 */
export function fingerprint(path: string | undefined): FileFingerprint | undefined {
  if (path === undefined || path === '') return undefined
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    return { path, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
  } catch {
    return undefined
  }
}

/**
 * 稳定序列化：对象键排序后输出，保证同一份参数永远得到同一个字符串。
 * planId 建立在它之上，"参数没变 → id 不变"这条性质必须成立。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/** 计算 planId。**不包含**时间戳与状态，这样执行时能重算出同一个值做校验。 */
export function computePlanId(input: {
  tool: string
  action: string
  parameters: Record<string, unknown>
  inputs?: Array<FileFingerprint | undefined>
  output?: { path: string; overwrites: boolean } | undefined
}): string {
  const material = stableStringify({
    v: PLAN_VERSION,
    tool: input.tool,
    action: input.action,
    parameters: input.parameters,
    inputs: (input.inputs ?? []).filter((item): item is FileFingerprint => item !== undefined)
      .map(item => [item.path, item.size, item.mtimeMs])
      .sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1),
    output: input.output === undefined ? null : [input.output.path, input.output.overwrites],
  })
  return `p_${createHash('sha256').update(material).digest('hex').slice(0, 12)}`
}

/** 高成本阈值（页数）。 */
// 整档提取与可搜索化都是"逐页 OCR"，门槛必须一致：可搜索化更重（还要重建文件），
// 早先给它 30 页而提取给 20 页，会出现"25 页的扫描件提取要问、可搜索化反而直接跑"的怪事。
const OCR_WHOLE_DOC_PAGES = 20
const SEARCHABLE_PAGES = 20
const HUGE_DOCUMENT_PAGES = 200

/**
 * 页级装配工具集：永远归 destructive。
 *
 * 这四个工具的输出与源文件是"另一份文件"，看起来不如改写正文危险，但它们改的是
 * 页面结构、页序与几何，出错时用户拿到的是一份"看起来对、其实错了"的文件——
 * 那比直接报错更难发现。所以无条件要求确认。
 */
const PAGE_ASSEMBLY_TOOLS = new Set(['pdf_split', 'pdf_crop', 'pdf_arrange', 'pdf_merge'])

/** 三类门控的判定。 */
export function classifyGate(input: GateInput): GateDecision {
  const reasons: string[] = []
  const ambiguous: string[] = []
  const exists = input.output !== undefined && input.output !== '' && existsSync(input.output)

  // ── destructive ─────────────────────────────────────────────────────────
  let destructive = false
  const mark = (reason: string): void => {
    destructive = true
    reasons.push(reason)
  }
  if (input.tool === 'pdf_edit_text') mark('改写正文文字属于不可逆操作')
  // 写注释同样改变文件内容：阅读器里能删，但这次写入已经发生。
  if (input.tool === 'pdf_annotate') mark('写入注释属于不可逆的内容改动')
  // 写字同样是改文件内容（写进内容流，属于文档内容而不是批注）。
  if (input.tool === 'pdf_text') mark('把文字写进页面属于不可逆的内容改动')
  // 导出会在磁盘上落一堆图片、合成会写出新 PDF：都属于写盘操作。
  if (input.tool === 'pdf_images') mark('导出/合成都会写出新文件')
  // 填写/压平表单会改写文件内容（压平不可逆）。只读的 action=list 由调用方传 proceed。
  if (input.tool === 'pdf_form' && input.action !== 'list') mark('填写或压平表单会改写内容')
  // 统一尺寸会改页面几何、拼版会重建页面结构，都不可逆。
  if (input.tool === 'pdf_layout') mark(`${titleFor(input.tool, input.action)}会改写页面几何/结构`)
  // 写属性/清除属性、改书签都会改写文件（只读的 get / outline-list 走 proceed）。
  if (input.tool === 'pdf_redact' && input.action === 'apply') mark('真删除内容不可逆')
  // patch 只在框内重绘背景色（不动文字），但同样写盘，必须拦。
  if (input.tool === 'pdf_redact' && input.action === 'patch') mark('原位涂色会改写页面内容流')
  // 优化会重写整个文件的字节结构（内容不变，但文件确实被改写了）。
  // compare 是只读比对（不写盘），不该被当成写操作拦下来。
  if (input.tool === 'pdf_optimize' && input.action !== 'compare') mark('重写对象层会生成新文件')
  if (input.tool === 'pdf_metadata' && input.action !== 'get' && input.action !== 'outline-list') {
    mark(`${titleFor(input.tool, input.action)}会改写文档信息`)
  }
  if (input.tool === 'pdf_replace_line') mark('整行重绘会抹掉该绘制组的原文并重画，属于不可逆操作')
  if (input.tool === 'pdf_watermark' && input.action === 'remove') mark('移除水印会改写页面内容流')
  if (input.tool === 'pdf_protect' && (input.action === 'encrypt' || input.action === 'decrypt')) {
    mark(input.action === 'encrypt' ? '加密会改变文件的打开方式' : '解除加密会改变文件的保护状态')
  }
  // 页级装配（拆 2-up / 裁剪 / 重排 / 合并）一律归 destructive：它们改的是页面的
  // 结构、顺序或几何，输出文件一旦落地就没有"撤销"这一说。
  if (PAGE_ASSEMBLY_TOOLS.has(input.tool)) {
    mark(`${titleFor(input.tool, input.action)}会改写页面结构/顺序/几何，属于不可逆操作`)
  }
  if (exists) mark(`输出文件已存在，将被覆盖：${input.output}`)

  // ── expensive ───────────────────────────────────────────────────────────
  let expensive = false
  const pages = input.pageCount ?? 0
  if (input.tool === 'pdf_inspect' && input.parameters.analyze === true) {
    expensive = true
    reasons.push('深层分诊会对扫描页逐页 OCR')
  }
  if (input.tool === 'pdf_extract_text' && input.wholeDocument === true && pages > OCR_WHOLE_DOC_PAGES) {
    expensive = true
    reasons.push(`整档 OCR：${pages} 页超过 ${OCR_WHOLE_DOC_PAGES} 页阈值`)
  }
  // 定位答案页同样是"整档逐页 OCR"：阈值与口径和 pdf_extract_text 完全一致。
  // 注意它没有 plan/confirm/force 令牌（只读工具），策略 always 下会得到一张确认单，
  // 提示用户把 pages 拆成 ≤ 阈值 的几段再调用。
  if (input.tool === 'pdf_find_answers' && input.wholeDocument === true && pages > OCR_WHOLE_DOC_PAGES) {
    expensive = true
    reasons.push(`整档 OCR：${pages} 页超过 ${OCR_WHOLE_DOC_PAGES} 页阈值`)
  }
  if (input.tool === 'pdf_make_searchable' && pages > SEARCHABLE_PAGES) {
    expensive = true
    reasons.push(`可搜索化：${pages} 页超过 ${SEARCHABLE_PAGES} 页阈值`)
  }

  // ── ambiguous ───────────────────────────────────────────────────────────
  for (const name of input.missing ?? []) ambiguous.push(`缺少关键参数：${name}`)
  if ((input.candidates ?? []).length > 1) {
    ambiguous.push(`名称对应多个文件（${(input.candidates ?? []).length} 个），需要指明具体是哪一个`)
  }
  if (input.wholeDocument === true && pages > HUGE_DOCUMENT_PAGES) {
    ambiguous.push(`文档有 ${pages} 页，确认要对全部页面操作`)
  }
  for (const note of input.notes ?? []) ambiguous.push(note)

  const gate: ConfirmationGate = destructive
    ? 'destructive'
    : ambiguous.length > 0
      ? 'ambiguous'
      : expensive
        ? 'expensive'
        : 'none'
  if (!destructive && gate === 'expensive') {
    // reasons 里已有说明
  }
  return { gate, reasons, ambiguous }
}

/**
 * 按策略判断该门控是否需要用户确认。
 *
 * 三档语义（与 README 一字对应）：
 *   - `never`       从不问；
 *   - `destructive` 默认：**会改文件**或**有歧义**就问——歧义意味着"可能做错事"，
 *                   在改文件之前问一句比事后解释便宜得多；
 *   - `always`      再加上高成本操作（整档 OCR、深层分诊、几十页可搜索化）。
 *
 * 注意：缺关键参数、同名多文件这类"必须靠猜才能继续"的歧义**不看策略**，
 * 在 `authorize()` 里直接被拦成计划或拒绝（见那里的 hardMissing / hardAmbiguity）。
 */
export function requiresConfirmation(gate: ConfirmationGate, policy: ConfirmationPolicy): boolean {
  if (policy === 'never') return false
  if (gate === 'none') return false
  if (policy === 'always') return true
  return gate === 'destructive' || gate === 'ambiguous'
}

/** 动作的中文标题。 */
function titleFor(tool: string, action: string): string {
  if (tool === 'pdf_edit_text') return '改写文字'
  if (tool === 'pdf_replace_line') return '整行重绘'
  if (tool === 'pdf_annotate') return '添加标注'
  if (tool === 'pdf_text') return '页面写字'
  if (tool === 'pdf_images') return action === 'build' ? '图片合成 PDF' : '导出页面图片'
  if (tool === 'pdf_optimize') {
    if (action === 'compare') return '比对两版差异'
    return action === 'linearize' ? '线性化' : action === 'both' ? '垃圾回收 + 线性化' : '垃圾回收'
  }
  if (tool === 'pdf_redact') {
    if (action === 'apply') return '矩形密文（真删除）'
    if (action === 'patch') return '矩形涂色（原位覆盖）'
    return '密文空跑检查'
  }
  if (tool === 'pdf_metadata') {
    if (action === 'get') return '读取文档信息'
    if (action === 'set') return '写入文档信息'
    if (action === 'clear') return '清除文档信息'
    if (action === 'outline-list') return '列出书签'
    if (action === 'outline-set') return '生成书签'
    return '删除书签'
  }
  if (tool === 'pdf_layout') {
    if (action === 'nup') return 'N-up 拼版'
    if (action === 'booklet') return '生成小册子版面'
    return '统一页面尺寸'
  }
  if (tool === 'pdf_form') {
    if (action === 'list') return '列出表单字段'
    if (action === 'flatten') return '压平表单'
    return '填写表单'
  }
  if (tool === 'pdf_make_searchable') return '生成可搜索 PDF'
  if (tool === 'pdf_watermark') {
    if (action === 'remove') return '移除水印'
    if (action === 'scan') return '检查水印'
    return '添加水印'
  }
  if (tool === 'pdf_protect') {
    if (action === 'encrypt') return '加密'
    if (action === 'decrypt') return '解除加密'
    return '查询保护状态'
  }
  if (tool === 'pdf_inspect') return action === 'analyze' ? '深度分析（含 OCR）' : '检查文档'
  if (tool === 'pdf_extract_text') return '提取文字'
  if (tool === 'pdf_find_answers') return '定位答案页'
  if (tool === 'pdf_preview') return '渲染预览'
  if (tool === 'pdf_split') return '拆分 2-up 页面'
  if (tool === 'pdf_crop') return '裁剪页面'
  if (tool === 'pdf_arrange') return '重排页面'
  if (tool === 'pdf_merge') return '合并文档'
  return tool
}

const n = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2))

/** 人类可读的大小。 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 参数摘要：只挑稳定、用户看得懂的字段，并限长。 */
function summarizeParameters(parameters: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(parameters)) {
    if (value === undefined) continue
    if (key === 'path' || key === 'output') continue
    let text: string
    if (Array.isArray(value)) {
      text = value.length > 8 ? `[${value.slice(0, 8).join(', ')}, …共 ${value.length} 项]` : `[${value.join(', ')}]`
    } else if (typeof value === 'object' && value !== null) {
      const keys = Object.keys(value as Record<string, unknown>)
      text = keys.length > 6 ? `{${keys.slice(0, 6).join(', ')}, …}` : stableStringify(value)
    } else {
      text = String(value)
    }
    parts.push(`${key}=${text.length > 60 ? `${text.slice(0, 57)}…` : text}`)
  }
  return parts.join('、') || '（无）'
}

/** 生成多行确认单（浮层与纯文本共用这一份）。 */
export function renderSheet(plan: Omit<OperationPlan, 'sheet' | 'planId'>): string {
  const lines: string[] = []
  for (const input of plan.inputs) {
    const stamp = new Date(input.mtimeMs).toLocaleString('zh-CN', { hour12: false })
    lines.push(`文件：${basename(input.path)}（${humanSize(input.size)}，最后修改 ${stamp}）`)
  }
  if (plan.inputs.length === 0) lines.push('文件：（未指定）')
  lines.push(`动作：${plan.title}`)
  lines.push(`参数：${summarizeParameters(plan.parameters)}`)
  const defaulted = Object.entries(plan.defaults)
  if (defaulted.length > 0) {
    lines.push(`默认值：${defaulted.map(([key, value]) => `${key}=${String(value)}`).join('、')}（你没指定，用了这些）`)
  }
  if (plan.gate !== 'none' && plan.gateReasons.length > 0) {
    // 让用户看得见"为什么被拦下来"：只说"请确认"，人是没法判断该不该点的。
    lines.push(`原因：${plan.gateReasons.join('；')}`)
  }
  for (const effect of plan.effects) lines.push(`影响：${effect}`)
  if (plan.ambiguous.length > 0) lines.push(`待确认：${plan.ambiguous.join('；')}`)
  if (plan.hints.length > 0) lines.push(`要改哪一项直接说，例如：${plan.hints.slice(0, 2).join('；')}`)
  return lines.join('\n')
}

/**
 * 组装一份计划（不登记）。
 *
 * 用 `renderSheet` 的同一份数据生成 `sheet`，所以卡片与文本永远不会不一致。
 */
export function createPlan(input: GateInput & {
  defaults?: Record<string, unknown>
  hints?: string[]
  effects?: string[]
  now?: number
}): OperationPlan {
  const decision = classifyGate(input)
  const inputs = (input.inputs ?? [])
    .map(path => fingerprint(path))
    .filter((item): item is FileFingerprint => item !== undefined)
  const output = input.output === undefined || input.output === ''
    ? undefined
    : { path: input.output, overwrites: existsSync(input.output) }
  const now = input.now ?? Date.now()

  const effects: string[] = [...(input.effects ?? [
    '不修改源文件',
    output === undefined ? '结果写入新的输出文件' : `结果写入：${output.path}`,
  ])]
  // "会覆盖已有文件"是用户最需要看到的一行，所以**不依赖调用方是否自带 effects**：
  // 工具为了说清自己的影响常常传入自定义 effects，早先的实现会把这条覆盖警告一起顶掉。
  if (output?.overwrites === true && !effects.some(line => line.includes('会被覆盖'))) {
    effects.push(`输出文件已存在，会被覆盖：${output.path}`)
  }

  const partial: Omit<OperationPlan, 'sheet' | 'planId'> = {
    tool: input.tool,
    action: input.action,
    title: titleFor(input.tool, input.action),
    gate: decision.gate,
    gateReasons: decision.reasons,
    inputs,
    ...(output === undefined ? {} : { output }),
    parameters: input.parameters,
    defaults: input.defaults ?? {},
    effects,
    hints: input.hints ?? [],
    ambiguous: decision.ambiguous,
    createdAt: now,
    expiresAt: now + PLAN_TTL_MS,
    status: 'pending',
  }
  return {
    ...partial,
    planId: computePlanId({
      tool: partial.tool,
      action: partial.action,
      parameters: partial.parameters,
      inputs: partial.inputs,
      output: partial.output,
    }),
    sheet: renderSheet(partial),
  }
}

/* ── 计划库 ───────────────────────────────────────────────────────────────── */

const plans = new Map<string, OperationPlan>()

/** 清理过期计划（过期状态保留一会儿，便于界面显示"已过期"而不是凭空消失）。 */
export function prunePlans(now = Date.now()): void {
  for (const [id, plan] of plans) {
    if (plan.status === 'pending' && plan.expiresAt <= now) plan.status = 'expired'
    // 状态终态且超过两倍 TTL 的直接丢弃，避免内存无限增长。
    if (plan.status !== 'pending' && plan.createdAt + PLAN_TTL_MS * 2 <= now) plans.delete(id)
  }
}

/** 登记一份计划（同 id 幂等：重复生成不会覆盖已有的确认状态）。 */
export function issuePlan(plan: OperationPlan): OperationPlan {
  prunePlans()
  const existing = plans.get(plan.planId)
  if (existing !== undefined && existing.status !== 'pending' && existing.status !== 'expired') return existing
  plans.set(plan.planId, plan)
  return plan
}

/** 取一份计划。 */
export function getPlan(planId: string): OperationPlan | undefined {
  prunePlans()
  return plans.get(planId)
}

/**
 * 把用户/浮层给的 id 解析成一份计划。
 *
 * 浮层卡片只显示 planId 的**前 8 位**（完整 id 太长，展示不合适），用户很可能就照抄那 8 位。
 * 所以这里允许"唯一前缀"：长度 ≥ 6 且只匹配到一份计划时接受；匹配不到返回 undefined，
 * 匹配到多份返回 `'ambiguous'`（宁可让人补全，也不要猜错计划去执行）。
 */
export function resolvePlanId(candidate: string): OperationPlan | undefined | 'ambiguous' {
  prunePlans()
  const exact = plans.get(candidate)
  if (exact !== undefined) return exact
  const key = candidate.trim()
  if (key.length < 6) return undefined
  const matches = [...plans.values()].filter(plan => plan.planId.startsWith(key))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) return 'ambiguous'
  return undefined
}

/** 列出计划（默认只列待确认的）。 */
export function listPlans(options: { includeSettled?: boolean } = {}): OperationPlan[] {
  prunePlans()
  const all = [...plans.values()].sort((a, b) => b.createdAt - a.createdAt)
  return options.includeSettled === true ? all : all.filter(plan => plan.status === 'pending')
}

/** 改状态；返回改后的计划。 */
export function setPlanStatus(planId: string, status: PlanStatus): OperationPlan | undefined {
  prunePlans()
  const plan = plans.get(planId)
  if (plan === undefined) return undefined
  plan.status = status
  return plan
}

/** 仅供测试：清空计划库。 */
export function resetPlansForTests(): void {
  plans.clear()
}

/* ── 授权 ─────────────────────────────────────────────────────────────────── */

/** 授权输入。 */
export interface AuthorizeInput extends GateInput {
  defaults?: Record<string, unknown>
  hints?: string[]
  effects?: string[]
  /** 策略，默认取 DEFAULT_CONFIRMATION_POLICY。 */
  policy?: ConfirmationPolicy
  /** 调用方带来的确认 id。 */
  confirm?: string
  /** 显式请求"只给我计划"（即使该操作本来不需要确认）。 */
  planOnly?: boolean
  /** 逃生舱：跳过确认（仅供脚本/测试显式使用）。 */
  force?: boolean
  now?: number
}

/** 授权结果。 */
export type AuthorizeResult =
  | { kind: 'proceed' }
  | { kind: 'plan'; plan: OperationPlan }
  | { kind: 'refused'; message: string; plan?: OperationPlan }

/** 比较"计划里的"与"现在要执行的"，列出差异（用于拒绝时给出可读原因）。 */
function describeMismatch(plan: OperationPlan, current: {
  parameters: Record<string, unknown>
  inputs: FileFingerprint[]
  output?: { path: string; overwrites: boolean }
}): string[] {
  const diffs: string[] = []
  const before = stableStringify(plan.parameters)
  const after = stableStringify(current.parameters)
  if (before !== after) {
    const keys = new Set([...Object.keys(plan.parameters), ...Object.keys(current.parameters)])
    for (const key of keys) {
      const a = stableStringify(plan.parameters[key])
      const b = stableStringify(current.parameters[key])
      if (a !== b) diffs.push(`参数 ${key}：计划里是 ${a}，现在是 ${b}`)
    }
    if (diffs.length === 0) diffs.push('参数与计划不一致')
  }
  const beforeFiles = plan.inputs.map(item => `${item.path}@${item.size}/${item.mtimeMs}`).sort().join(' | ')
  const afterFiles = current.inputs.map(item => `${item.path}@${item.size}/${item.mtimeMs}`).sort().join(' | ')
  if (beforeFiles !== afterFiles) diffs.push(`输入文件已变化：计划基于 ${beforeFiles || '（无）'}，现在是 ${afterFiles || '（无）'}`)
  if ((plan.output?.path ?? '') !== (current.output?.path ?? '')) {
    diffs.push(`输出位置不同：计划是 ${plan.output?.path ?? '（无）'}，现在是 ${current.output?.path ?? '（无）'}`)
  }
  return diffs
}

/**
 * 授权：决定"直接执行 / 返回计划 / 拒绝"。
 *
 * 这是工具写盘前的唯一闸门。工具必须在**任何写入之前**调用它。
 */
export function authorize(input: AuthorizeInput): AuthorizeResult {
  const policy = input.policy ?? DEFAULT_CONFIRMATION_POLICY
  if (input.force === true) return { kind: 'proceed' }

  const now = input.now ?? Date.now()
  const plan = createPlan(input)

  // 工具已判定"这次做不了"（例如拆分的候选页全是不规范页）：直接拒绝，不落盘，也不发计划。
  // 这类原因**不是**让用户确认就能继续的，所以不走 plan 通道。
  const refusals = input.refusals ?? []
  if (refusals.length > 0) {
    return {
      kind: 'refused',
      message: `无法执行：\n${refusals.map(reason => `  • ${reason}`).join('\n')}`,
      plan,
    }
  }

  // 歧义里"必须靠猜"的情况直接判错：猜错文件名比多问一句危险得多。
  const hardAmbiguity = (input.candidates ?? []).length > 1
  if (hardAmbiguity && input.planOnly !== true) {
    const list = (input.candidates ?? []).slice(0, 5).map(path => `  • ${path}`).join('\n')
    return {
      kind: 'refused',
      message: `名称对应多个文件，请指明具体路径后再试：\n${list}`,
      plan,
    }
  }

  // 缺关键参数属于"无法继续"：这时必须回到用户，且**不能靠确认绕过**——
  // 否则执行时会退到插件的默认值（例如水印文字 "WATERMARK"），那就是在替用户瞎猜。
  const hardMissing = (input.missing ?? []).length > 0
  if (hardMissing) {
    if (input.confirm !== undefined && input.confirm !== '') {
      return {
        kind: 'refused',
        message: `计划缺少必需参数（${(input.missing ?? []).join('、')}），不能靠确认继续。请补齐参数后重新生成计划。`,
        plan,
      }
    }
    return { kind: 'plan', plan: issuePlan(plan) }
  }

  const confirm = input.confirm
  const hasConfirm = confirm !== undefined && confirm !== ''

  // ── 带了确认令牌：**无论本次操作是否需要确认，都必须校验它** ──────────────
  //
  // 这里曾经把校验放在"需要确认"之后，于是出现一条绕过通道：用 `plan: true` 要到一份计划，
  // 再改掉参数、带旧令牌调用——因为该操作本身 `gate === 'none'`，代码直接执行，
  // 令牌根本没被检查（计划还是 pending，文件已经落盘）。令牌只在该校验的地方校验，等于没有。
  if (hasConfirm) {
    return authorizeWithToken(input, plan, policy, now)
  }

  if (input.planOnly === true) return { kind: 'plan', plan: issuePlan(plan) }
  if (!requiresConfirmation(plan.gate, policy)) return { kind: 'proceed' }
  return { kind: 'plan', plan: issuePlan(plan) }
}

/** 校验确认令牌并（成功时）消费计划。 */
function authorizeWithToken(
  _input: AuthorizeInput,
  plan: OperationPlan,
  _policy: ConfirmationPolicy,
  now: number,
): AuthorizeResult {
  const confirm = String(_input.confirm)
  const issued = resolvePlanId(confirm)
  if (issued === undefined) {
    return {
      kind: 'refused',
      message: `计划 ${confirm} 不存在或已过期（计划保留 ${Math.round(PLAN_TTL_MS / 60000)} 分钟）。请重新生成计划，确认后再执行。`,
    }
  }
  if (issued === 'ambiguous') {
    return {
      kind: 'refused',
      message: `计划前缀 ${confirm} 对应多个计划，请使用完整 id 再试。`,
    }
  }
  if (issued.status === 'cancelled') {
    return { kind: 'refused', message: `计划 ${confirm} 已被取消，未执行任何操作。`, plan: issued }
  }
  if (issued.status === 'consumed') {
    return { kind: 'refused', message: `计划 ${confirm} 已经执行过一次（计划是一次性的），如需再执行请重新生成。`, plan: issued }
  }
  if (issued.expiresAt <= now || issued.status === 'expired') {
    return { kind: 'refused', message: `计划 ${confirm} 已过期，未执行任何操作。请重新生成计划。`, plan: issued }
  }

  // 重新计算：确认单里的内容必须与这次要执行的内容逐字一致。
  const expected = computePlanId({
    tool: plan.tool,
    action: plan.action,
    parameters: plan.parameters,
    inputs: plan.inputs,
    output: plan.output,
  })
  if (expected !== issued.planId) {
    const diffs = describeMismatch(issued, { parameters: plan.parameters, inputs: plan.inputs, output: plan.output })
    return {
      kind: 'refused',
      message: `计划与本次参数不一致，已拒绝执行（避免"确认的是 A、执行的是 B"）：\n`
        + diffs.map(line => `  • ${line}`).join('\n')
        + `\n如需继续，请重新生成计划并确认。`,
      plan: issued,
    }
  }

  issued.status = 'consumed'
  return { kind: 'proceed' }
}

/** 计划在文本对话里回显给用户的完整文案（含"如何继续"的说明）。 */
export function renderPlanPrompt(plan: OperationPlan): string {
  return [
    '⚠️ 这个操作需要你确认后才会执行。',
    '',
    plan.sheet,
    '',
    `计划 id：${plan.planId}（${Math.round(PLAN_TTL_MS / 60000)} 分钟内有效）`,
    `确认后请对助手说「确认执行」；助手会用同样的参数带 confirm=${plan.planId} 再调一次。`,
    '不想执行就说「取消」，或直接改口（比如换一页、换颜色）。',
  ].join('\n')
}
