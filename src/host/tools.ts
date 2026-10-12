/**
 * Agent-facing PDF tools.
 *
 * ## Why this exists instead of a panel
 *
 * The first version of this plugin put a floating panel on screen and asked the
 * user to fill it in: pick a file, choose a tab, press a button. That is a
 * desktop application bolted onto a chat surface, and it made the plugin demand
 * attention before it had anything to show.
 *
 * This module is the other shape, and the one the brief called for from the
 * start: **describe the goal in natural language, the agent does the work.** Each
 * tool is a capability the agent can reach for; the results come back as text
 * the model can act on and as a card in the conversation. Nothing appears on
 * screen until there is something worth showing.
 *
 * ## Design rules followed here
 *
 * - **Destructive operations never overwrite the source.** Every tool that
 *   produces a file takes an optional `output` and derives a sibling path
 *   otherwise, so the input is read-only by construction.
 * - **Expensive work is opt-in.** `pdf_inspect` is cheap by default; OCR and
 *   full triage require an explicit flag, because silently spending thirty
 *   seconds on a scan is worse than asking.
 * - **Ambiguity is reported, not guessed.** A watermark the detector cannot
 *   justify is returned with its confidence and left alone.
 *
 * @module dsh-pdf-studio/host/tools
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from 'pdf-lib'
import { analyzeDocument, applyTextEdits, exportSearchable, inspectDocument, protectPdf, readEditableDocument, reportWatermarks, stampWatermark, stripWatermarks, lineSummary } from './engine.ts'
import { redrawLineInPdfBytes } from '../core/line-redraw.ts'
import { openPdf, openPdfBytes } from '../core/pdf.ts'
import { extractTextLayer, formatEmptyExtractionNotice } from '../core/text-layer.ts'
import {
  applyTemplate,
  drawTextOnPage,
  formatBates,
  pageSelection,
  resolveDrawFont,
  unknownPlaceholders,
  type TextAnchor,
} from '../core/page-text.ts'
import {
  ACTION_SUBTYPES,
  APPEARANCE_ACTIONS,
  DEFAULT_COLORS,
  DEFAULT_OPACITY,
  MARKUP_ACTIONS,
  NOTE_ICONS,
  addAnnotation,
  countAnnotations,
  locateInLine,
  type AnnotationAction,
} from '../core/annotate.ts'
import { inspectLanguageData, describeMissingLanguage } from '../core/ocr.ts'
import { loadFontkitAdapter, resolveFontForText } from '../core/fonts.ts'
import { bookletSheets, countAnnotsPerPage, nupPages, parseTargetSize, resizePages } from '../core/layout.ts'
import { applyMetadata, clearMetadata, clearOutline, listOutline, METADATA_FIELDS, readMetadata, setOutline, type MetadataField } from '../core/docinfo.ts'
import { redactPages, type RedactBox } from '../core/redact.ts'
import { describeSaving, optimizePdf, type OptimizeProfile } from '../core/optimize.ts'
import { comparePdfs, renderCompareReport } from '../core/compare.ts'
import { runQpdf } from '../core/qpdf.ts'
import {
  formatPages,
  formatRange,
  groupAnswerRanges,
  scoreAnswerPage,
  suggestArrangement,
  weakerConfidence,
  type AnswerConfidence,
  type AnswerVerdict,
  type ArrangementSplit,
  type ScoredPage,
} from '../core/answer-pages.ts'
import {
  axisLabel,
  classifyTwoUp,
  cropPages,
  detectGutter,
  isA4Half,
  keepLabel,
  keepMatchesAxis,
  keepOptionsFor,
  loadPdfDocument,
  mergeDocuments,
  parsePageOrder,
  parsePageSelection,
  readPageBoxes,
  rotatePages,
  splitPageIntoHalves,
  splitPageKeepingHalf,
  type CropBoxInput,
  type GutterDetection,
  type SplitKeep,
  type TwoUpAxis,
} from '../core/page-assembly.ts'
import {
  authorize,
  DEFAULT_CONFIRMATION_POLICY,
  renderPlanPrompt,
  type ConfirmationPolicy,
} from '../core/confirmation.ts'

/** Structural view of the `dsh-tools` service this module registers into. */
export interface ToolRegistry {
  register(definition: unknown): void
}

/** 数组元素的形状：比顶层参数轻，`description` 可选（`items: { type: 'integer' }` 是合法写法）。 */
interface ParamItems {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  description?: string
  required?: boolean
  enum?: readonly string[]
  items?: ParamItems
  properties?: Record<string, ParamSpec>
  additionalProperties?: boolean
}

/** Shape of a tool's parameter description, as `defineTool` expects it. */
interface ParamSpec {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  required?: boolean
  enum?: readonly string[]
  items?: ParamItems
  properties?: Record<string, ParamSpec>
  /** 对象参数是否允许额外字段（嵌套属性表用 false 收紧契约）。 */
  additionalProperties?: boolean
  description: string
}

/** A tool's declared call presentation. */
interface Presentation {
  card: string
  title: string
  kind: 'read' | 'write'
}

/**
 * The result every tool here returns: one block of text for the model.
 *
 * Tools do NOT build the `content` envelope themselves. `execute` returns a plain
 * value and `output.render` wraps it, which is the contract `defineTool`
 * enforces (it reads `options.output.render` unconditionally). Returning
 * `{ content: [...] }` from `execute` type-checks but is silently wrong.
 */
interface TextResult {
  text: string
  /** Attachment references to render as inline images, when a tool produced any. */
  images?: unknown[]
}

/** What `defineTool` accepts, to the extent this module uses it. */
interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, ParamSpec>
  /**
   * Output contract. `schema` describes the value `execute` returns and must
   * carry an explicit `additionalProperties`; it must NOT use `required`, which
   * the value-schema DSL rejects.
   */
  output: {
    schema: Record<string, unknown>
    /**
     * Must return an ARRAY of content blocks.
     *
     * This is enforced by the host's `assertRenderedContent`, which throws
     * "output.render ... must return an ARRAY of content blocks" otherwise. An
     * earlier version returned `{ content: [...] }` — which type-checks, passed
     * this package's own tests, and would have failed the moment a real tool
     * call ran.
     */
    render: (args: Record<string, unknown>, value: TextResult) => unknown[]
  }
  execute: (args: Record<string, unknown>) => Promise<TextResult>
  presentCall?: (args: Record<string, unknown>) => Presentation
}

/** One content block, as the host's renderer expects it. */
interface ContentBlock {
  type: string
  [key: string]: unknown
}

/** The shared output descriptor for a single text block. */
const TEXT_OUTPUT: ToolDefinition['output'] = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', description: '结果文本，供模型阅读。' } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

/**
 * Text plus inline images.
 *
 * Images ride along as attachment references, which the built-in `read_image`
 * card already knows how to display — so a page render shows up in the
 * conversation itself, with no client plugin involved.
 */
function makeImageOutput(): ToolDefinition['output'] {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '结果文本。' },
        images: { type: 'array', items: { type: 'object' }, description: '附件引用列表。' },
      },
    },
    render: (_args, value) => {
      const blocks: ContentBlock[] = [{ type: 'text', text: value.text }]
      for (const image of value.images ?? []) {
        blocks.push({ type: 'image', attachment: image })
      }
      return blocks
    },
  }
}

/**
 * The registry-ready tool object, matching what `defineTool` produces.
 *
 * The shape was read off `defineTool`'s implementation rather than guessed:
 *
 *     { name, description, parameters: <JSON Schema>,
 *       output: { schema, render(args, value) },
 *       execute(args, exec), presentCall(args) }
 *
 * ## Why this is built here instead of by importing `defineTool`
 *
 * `@deepseek-ai/dsh-tools` resolves from the host, but NOT from this package's
 * own directory — the plugin is installed with `link:`, and Node resolves a
 * symlinked package to its real path, so a bare `import('@deepseek-ai/dsh-tools')`
 * from the bundle throws MODULE_NOT_FOUND even though the profile can resolve
 * it. Depending on it would mean shipping a copy of a host package and hoping
 * the versions agree. Building the object directly costs one small schema
 * compiler and removes the coupling entirely.
 */
export interface RegistryTool {
  name: string
  description: string
  /** Raw JSON Schema for the arguments, in the subset the registry accepts. */
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    /**
     * Must return an ARRAY of content blocks.
     *
     * This is enforced by the host's `assertRenderedContent`, which throws
     * "output.render ... must return an ARRAY of content blocks" otherwise. An
     * earlier version returned `{ content: [...] }` — which type-checks, passed
     * this package's own tests, and would have failed the moment a real tool
     * call ran.
     */
    render: (args: Record<string, unknown>, value: TextResult) => unknown[]
  }
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<TextResult>
  presentCall?: (args: Record<string, unknown>) => Presentation
}

/** The value/spec node keywords this compiler understands. */
function compileParam(spec: ParamSpec | ParamItems, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  out.type = spec.type
  if (spec.enum !== undefined) out.enum = [...spec.enum]
  if (spec.description !== undefined) out.description = spec.description
  if (spec.type === 'array') {
    out.items = spec.items === undefined ? {} : compileParam(spec.items, path + '.items')
  }
  if (spec.properties !== undefined) {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, child] of Object.entries(spec.properties)) {
      properties[key] = compileParam(child, path + '.' + key)
      if (child.required === true) required.push(key)
    }
    out.properties = properties
    // The registry asserts `additionalProperties` is an explicit boolean, so it
    // is always emitted rather than inferred.
    out.additionalProperties = false
    if (required.length > 0) out.required = required
  } else if (spec.type === 'object') {
    // A free-form object must still say so explicitly.
    out.additionalProperties = true
  }
  return out
}

/** Compile the author-facing parameter map into raw JSON Schema. */
function compileParameters(parameters: Record<string, ParamSpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, spec] of Object.entries(parameters)) {
    properties[key] = compileParam(spec, 'parameters.' + key)
    if (spec.required === true) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
  }
}

/**
 * Validate arguments against a compiled parameter schema.
 *
 * `defineTool` does this for free; building the object directly means owning it.
 * The check is intentionally narrow — required presence, scalar type, enum
 * membership — because its job is to turn a malformed model call into a usable
 * message, not to re-implement JSON Schema.
 */
function assertArgs(parameters: Record<string, unknown>, args: Record<string, unknown>, toolName: string): void {
  const properties = (parameters.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = (parameters.required ?? []) as string[]
  const problems: string[] = []

  for (const key of required) {
    const value = args[key]
    if (value === undefined || value === null || value === '') problems.push(`${key} is required`)
  }
  for (const [key, schema] of Object.entries(properties)) {
    const value = args[key]
    if (value === undefined || value === null) continue
    const type = schema.type
    if (type === 'string' && typeof value !== 'string') problems.push(`${key} must be a string`)
    if (type === 'boolean' && typeof value !== 'boolean') problems.push(`${key} must be a boolean`)
    if ((type === 'number' || type === 'integer') && typeof value !== 'number') problems.push(`${key} must be a number`)
    if (type === 'array' && !Array.isArray(value)) problems.push(`${key} must be an array`)
    const allowed = schema.enum as unknown[] | undefined
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(value)) {
      problems.push(`${key} must be one of ${allowed.join(', ')}`)
    }
  }
  if (problems.length > 0) throw new Error(`${toolName}: invalid arguments: ${problems.join('; ')}`)
}

/**
 * The slice of the `attachments` service this module needs.
 *
 * Present on a normal host; absent in a bare test harness, which is why every
 * use is guarded and degrades to a text explanation rather than throwing.
 */
export interface AttachmentSink {
  saveImages(inputs: Array<{ data: Uint8Array; mediaType: string; name?: string }>): Promise<unknown[]>
}

/** Options passed to registration. */
export interface ToolOptions {
  /** Directory relative outputs are resolved against; the agent's workspace. */
  workspaceRoot: string
  /** Inline-image support, when the host provides it. */
  attachments?: AttachmentSink
  /**
   * 何时要求用户确认：`destructive`（默认，只有破坏性操作问）/ `always` / `never`。
   * 由 profile 配置或 `DSH_PDF_STUDIO_CONFIRM` 决定。
   */
  confirmation?: ConfirmationPolicy
  /**
   * OCR 语言数据目录（`<lang>.traineddata[.gz]`）。
   *
   * 不传时由 `src/core/ocr.ts` 的 `resolveLangPath()` 决定：
   * `DSH_PDF_STUDIO_TESSDATA` 环境变量 > 那个跨项目硬编码路径兜底。
   */
  tessdataPath?: string
}

/** Read a required string argument, or throw with a usable message. */
function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少必填参数 ${key}`)
  }
  return value.trim()
}

/** Read an optional string argument. */
function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Read an optional boolean argument. */
function optionalBoolean(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true
}

/** Read an optional number argument, rejecting values that are not finite. */
function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Resolve the input path and verify it looks like a PDF.
 *
 * The check is deliberately shallow (exists + extension). Deep validation is the
 * loader's job, and a tool that second-guesses a valid file is worse than one
 * that reports the loader's error.
 */
function resolveInput(args: Record<string, unknown>): string {
  const raw = requireString(args, 'path')
  const full = resolve(raw)
  if (!existsSync(full)) throw new Error(`文件不存在：${full}`)
  if (extname(full).toLowerCase() !== '.pdf') throw new Error(`不是 PDF 文件：${full}`)
  return full
}

/**
 * Decide where an output goes.
 *
 * Never the input: every producing tool writes a NEW sibling file unless the
 * caller names a target. That guarantee is what makes these tools safe for an
 * agent to call without asking.
 */
function resolveOutput(
  source: string,
  args: Record<string, unknown>,
  suffix: string,
  workspaceRoot: string,
): string {
  const requested = optionalString(args, 'output')
  if (requested !== undefined) {
    const full = resolve(workspaceRoot, requested)
    if (full === resolve(source)) throw new Error('输出路径不能与源文件相同')
    return full
  }
  const stem = basename(source, extname(source))
  return join(dirname(source), `${stem}${suffix}.pdf`)
}

/** A short page-kind tally, e.g. "text×1" or "image×6". */
function kindTally(kinds: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  return [...counts].map(([kind, n]) => `${kind}×${n}`).join(', ')
}

/**
 * Build every tool definition.
 *
 * Kept as one function rather than a module-level constant so the workspace root
 * and the `defineTool` factory are injected explicitly — the definitions do not
 * need to know how the host resolves those.
 */
/**
 * 计划/确认参数：所有"会写盘"或"代价高"的工具都带上。
 *
 * 这不只是礼貌性的确认：`confirm` 是**令牌**，工具执行前会重算计划 id 并比对参数与文件指纹，
 * 参数被改过、文件被换过、计划过期或被取消都会被拒绝——避免"用户确认的是 A、执行的是 B"。
 */
const CONFIRM_PARAMS: Record<string, ParamSpec> = {
  plan: { type: 'boolean', description: '只返回执行计划（确认单），不做任何写入。' },
  confirm: { type: 'string', description: '确认令牌：把上一次返回的计划 id 原样传回即执行；参数或文件变了会被拒绝。' },
  force: { type: 'boolean', description: '跳过确认直接执行（危险，仅供脚本与测试显式使用）。' },
}

/** 把工具参数翻译成确认模块的授权开关。 */
function confirmationArgs(
  options: ToolOptions,
  args: Record<string, unknown>,
): { policy: ConfirmationPolicy; planOnly: boolean; confirm: string | undefined; force: boolean } {
  return {
    policy: options.confirmation ?? DEFAULT_CONFIRMATION_POLICY,
    planOnly: optionalBoolean(args, 'plan') === true,
    confirm: optionalString(args, 'confirm'),
    force: optionalBoolean(args, 'force') === true,
  }
}

export function buildToolDefinitions(options: ToolOptions): unknown[] {
  // ── preview ──────────────────────────────────────────────────────────────
  //
  // Renders pages and returns them as inline images, so the document appears in
  // the conversation instead of being described. This is the competitor-style
  // "live preview" and it needs no client-side plugin: images ride along as
  // attachment references, which the built-in image card already renders.
  const preview: ToolDefinition = {
    name: 'pdf_preview',
    description:
      '把 PDF 的页面渲染成图片直接显示在会话里，用于查看文档内容。'
      + '默认渲染第 1 页；也可以指定若干页。改了文件之后想确认效果时用它。',
    parameters: {
      path: { type: 'string', required: true, description: 'PDF 路径。' },
      pages: {
        type: 'array',
        items: { type: 'integer' },
        description: '要渲染的页码（1 开始），最多 4 页以免刷屏。省略则渲染第 1 页。',
      },
      scale: { type: 'number', description: '渲染倍率，默认 1.4。' },
    },
    output: makeImageOutput(),
    presentCall: args => ({ card: 'generic', title: `预览 ${basename(String(args.path ?? ''))}`, kind: 'read' }),
    async execute(args) {
      const source = resolveInput(args)
      if (options.attachments === undefined) {
        return { text: '当前宿主没有提供图片附件服务，无法在会话中显示预览。' }
      }
      const info = await inspectDocument(source)
      if (!info.readable) {
        return {
          text: `${basename(source)} 已加密，且没有提供密码，无法渲染预览。请先用 pdf_protect action=decrypt 解除保护。`,
        }
      }
      const requested = Array.isArray(args.pages)
        ? (args.pages as unknown[]).map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= info.pages)
        : [1]
      const wanted = (requested.length === 0 ? [1] : requested).slice(0, 4)
      const scale = typeof args.scale === 'number' && args.scale > 0 && args.scale <= 3 ? args.scale : 1.4

      const { renderPagePng } = await import('./render.ts')
      const images: Array<{ data: Uint8Array; mediaType: string; name: string }> = []
      for (const pageNumber of wanted) {
        const png = await renderPagePng(source, pageNumber, scale)
        images.push({ data: png, mediaType: 'image/png', name: basename(source, extname(source)) + `-p${pageNumber}.png` })
      }
      const refs = await options.attachments.saveImages(images)
      return {
        text: `${basename(source)}：渲染第 ${wanted.join(', ')} 页（共 ${info.pages} 页）。`,
        images: refs,
      }
    },
  }

  // ── inspect ──────────────────────────────────────────────────────────────
  const inspect: ToolDefinition = {
    name: 'pdf_inspect',
    description:
      '查看一个 PDF 的基本情况：页数、页面尺寸、是否加密，以及按页的类型（文字页 / 扫描图片页）。'
      + '默认很快；analyze=true 会做完整分诊（扫描页需要 OCR，可能很慢）。'
      + 'runs=true 会列出可编辑的文字块及其 id，供 pdf_edit_text / pdf_replace_line 使用。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: 'PDF 的完整路径或相对工作区路径。' },
      analyze: { type: 'boolean', description: '是否做完整分诊。扫描件会触发 OCR，耗时可能从秒到分钟。' },
      runs: { type: 'boolean', description: '是否列出现有文字块（含 id、文字、字体、字号、位置）。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({ card: 'generic', title: `检查 ${basename(String(args.path ?? ''))}`, kind: 'read' }),
    async execute(args) {
      const source = resolveInput(args)
      const analyze = optionalBoolean(args, 'analyze') === true
      const info = await inspectDocument(source)
      const lines: string[] = [
        info.readable
          ? `${basename(source)}：${info.pages} 页${info.encrypted ? '，已加密' : ''}`
          : `${basename(source)}：已加密，未提供密码时页数不可读`,
        ...info.notes,
      ]
      const first = info.sizes[0]
      if (first !== undefined) {
        lines.push(`页面尺寸：${first.width.toFixed(0)} × ${first.height.toFixed(0)} pt`)
      }

      const gate = authorize({
        tool: 'pdf_inspect',
        action: analyze ? 'analyze' : 'inspect',
        parameters: { analyze, pages: info.pages, encrypted: info.encrypted },
        inputs: [source],
        // 只有深层分诊才昂贵；普通检查连页数探针都不额外花钱（info 已经拿到了）。
        ...(analyze ? { pageCount: info.pages, wholeDocument: true } : {}),
        hints: ['只想快速看结构就别加 analyze', '要改内容请用 pdf_edit_text'],
        effects: analyze
          ? ['只读，不修改任何文件', '扫描页会逐页 OCR，可能需要一段时间']
          : ['只读，不修改任何文件'],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)

      if (analyze) {
        const analysis = await analyzeDocument(source)
        const summary = lineSummary(analysis.content)
        lines.push(`分诊：${kindTally(analysis.kinds)}`)
        for (const page of summary.slice(0, 20)) {
          lines.push(`  第 ${page.page} 页：${page.kind}，${page.lines} 行`)
        }
        if (summary.length > 20) lines.push(`  …其余 ${summary.length - 20} 页省略`)
        for (const note of analysis.notes.slice(0, 5)) lines.push(`注意：${note}`)
      }

      if (optionalBoolean(args, 'runs')) {
        const model = await readEditableDocument(source)
        const runs = model.content.flatMap(page => page.runs.map(run => ({ page: page.page, run })))
        lines.push(`可编辑文字块：${runs.length} 个`)
        for (const { page, run } of runs.slice(0, 40)) {
          const text = run.text === undefined ? `（无法解码：${run.textUnavailable}）` : run.text
          lines.push(`  第${page}页 ${run.id}｜${run.fontSize ?? '?'}pt｜${text}`)
        }
        if (runs.length > 40) lines.push(`  …其余 ${runs.length - 40} 个省略`)
        for (const note of model.notes) lines.push(`注意：${note}`)
      }

      // 注释层报告：之前批过什么、能不能批注，一眼看到。只读，不额外花 OCR。
      try {
        const pdfDoc = await PDFDocument.load(new Uint8Array(await readFile(source)), {
          updateMetadata: false,
          ignoreEncryption: true,
        })
        let annotTotal = 0
        const bySubtype: Record<string, number> = {}
        for (const page of pdfDoc.getPages()) {
          const counted = countAnnotations(page as never, pdfDoc.context as never)
          annotTotal += counted.total
          for (const [key, value] of Object.entries(counted.bySubtype)) {
            bySubtype[key] = (bySubtype[key] ?? 0) + value
          }
        }
        if (annotTotal > 0) {
          lines.push(
            `注释：${annotTotal} 个（${Object.entries(bySubtype).map(([key, value]) => `${key} ×${value}`).join('、')}）`,
          )
        }
      } catch {
        // 注释统计失败不该影响检查本身。
      }

      return { text: lines.join('\n') }
    },
  }

  // ── extract text ─────────────────────────────────────────────────────────
  const extract: ToolDefinition = {
    name: 'pdf_extract_text',
    description:
      '提取 PDF 的文字内容，带每一行的坐标。文字页走文本层，扫描页走 OCR。'
      + '用于阅读内容、搜索关键词、确认某段文字在哪里。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: 'PDF 路径。' },
      page: { type: 'integer', description: '只提取这一页（1 开始）。省略则提取全部页。' },
      ocr: { type: 'boolean', description: '是否对图片页做 OCR。默认 true。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({ card: 'generic', title: `提取文字 ${basename(String(args.path ?? ''))}`, kind: 'read' }),
    async execute(args) {
      const source = resolveInput(args)
      const wanted = typeof args.page === 'number' ? Number(args.page) : undefined
      // 整档 OCR 是高成本操作：页数多时先给计划，避免用户随口一句就要等几分钟。
      // 只有"整档 + 要 OCR"才需要页数探针，单页提取不该为了一次确认多加载一遍文档。
      // 注意：`optionalBoolean` 在参数缺失时返回 false，所以不能用它判断"默认 true"的三态。
      // `ocr` 的语义是"默认开"——缺省时必须当 true，否则整档提取的高成本门控就形同虚设。
      const ocrEnabled = args.ocr === undefined ? true : args.ocr === true
      const wholeDocument = wanted === undefined && ocrEnabled
      const probe = wholeDocument ? await inspectDocument(source) : undefined
      const gate = authorize({
        tool: 'pdf_extract_text',
        action: wholeDocument ? 'extract-all' : 'extract-page',
        parameters: { page: wanted ?? '全部', ocr: ocrEnabled, ...(probe === undefined ? {} : { pages: probe.pages }) },
        inputs: [source],
        ...(probe === undefined ? {} : { pageCount: probe.pages, wholeDocument: true }),
        hints: ['只想看某一页就说「只看第 3 页」', '只要文字不要 OCR 就加 ocr=false'],
        effects: probe === undefined
          ? ['只读，不修改任何文件']
          : ['只读，不修改任何文件', `将对全部 ${probe.pages} 页做文字提取（图片页走 OCR）`],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)
      const analysis = await analyzeDocument(source)
      const out: string[] = []
      for (const page of analysis.content) {
        if (wanted !== undefined && page.page !== wanted) continue
        out.push(`── 第 ${page.page} 页（${page.kind}）──`)
        if (page.kind === 'image') {
          // 图片页的文字是 OCR 出来的，普通人很容易把识别噪声当正文。声明清楚，
          // 并给出"要可搜索副本"的下一步，而不是让他自己琢磨为什么文字是乱的。
          out.push('   ⚠️ 本页是图片页：以下文字来自 OCR，可能有错字或多余空格。'
            + '需要一份可搜索/可复制的副本，请用 pdf_make_searchable。')
        }
        for (const line of page.lines.slice(0, 80)) {
          out.push(`${line.text}   [x=${line.rect.x.toFixed(0)} y=${line.rect.y.toFixed(0)} w=${line.rect.width.toFixed(0)}]`)
        }
        if (page.lines.length > 80) out.push(`…本页其余 ${page.lines.length - 80} 行省略`)
      }
      if (out.length === 0) {
        // 分开说：页号超范围 ≠ 页存在但没有可提取文字（后者要指向 OCR，别让人以为文件缺页）
        out.push(...formatEmptyExtractionNotice({ pageCount: analysis.pages, kinds: analysis.kinds, ...(wanted === undefined ? {} : { wanted }) }))
      }
      return { text: out.join('\n') }
    },
  }

  // ── find answers（定位答案页，只读）──────────────────────────────────────
  //
  // 只读工具，**不接 CONFIRM_PARAMS**：它不写盘、不删改，结论是"候选 + 依据 + 置信度"，
  // 让用户确认后再用 pdf_arrange 去拆。唯一的例外是整档 OCR 的成本门控：策略为 `always`
  // 且页数超过阈值时会返回确认单（本工具没有令牌参数，提示用户把 pages 拆小再调用）。
  const findAnswers: ToolDefinition = {
    name: 'pdf_find_answers',
    description:
      '定位 PDF 里的答案页候选：给候选页范围、中文依据与置信度（只读，不修改文件，也不擅自拆分）。'
      + '判定依据是页首答案标题词（答案/参考答案/评分标准/Answer Key）、答案速查表（1 C 2 A…）、'
      + '解答句特征与题干特征；答案与题目同页时只如实报告"无法按页分离"，不硬凑。'
      + '扫描页默认走 OCR；ocr=false 时只读文字层，图片页标为"未做 OCR"。',
    parameters: {
      path: { type: 'string', required: true, description: 'PDF 路径。' },
      pages: { type: 'string', description: '要判定的页码范围，例如 "5-7"；省略则判定全部页。' },
      ocr: {
        type: 'boolean',
        description: '是否对图片页做 OCR。默认 true；false 时图片页标为 unknown 并说明未做 OCR。',
      },
      lang: { type: 'string', description: 'OCR 语言，默认 chi_sim+eng。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({ card: 'generic', title: `定位答案页 ${basename(String(args.path ?? ''))}`, kind: 'read' }),
    async execute(args) {
      const source = resolveInput(args)
      const pagesSpec = optionalString(args, 'pages')
      const ocrEnabled = args.ocr === undefined ? true : args.ocr === true
      const lang = optionalString(args, 'lang') ?? 'chi_sim+eng'
      // 语言数据先查一次：tesseract 缺语言文件时抛的是**未捕获的 worker 错误**（直接崩进程），
      // 不是可捕获的 rejection。缺语言就退化到可用子集并在结论里写明；一个都没有就中文报错。
      let effectiveLang = lang
      let langNote: string | undefined
      if (ocrEnabled) {
        // langPath 优先级：profile 的 tessdataPath > DSH_PDF_STUDIO_TESSDATA > 兜底路径。
        const status = inspectLanguageData(lang, options.tessdataPath)
        if (status.available.length === 0) {
          throw new Error(
            `OCR 语言数据缺失：${status.langPath} 里找不到 ${status.missing.join('、')}。`
            + '请改用已安装的语言（例如 lang=chi_sim），或把对应的 <语言>.traineddata[.gz] 放进该目录'
            + '（也可以用 DSH_PDF_STUDIO_TESSDATA 环境变量或 profile 的 tessdataPath 指向别处）。',
          )
        }
        if (status.missing.length > 0) {
          effectiveLang = status.available.join('+')
          langNote = `请求 lang=${lang}，但语言数据目录（${status.langPath}）里 `
            + `${status.missingForms.map(describeMissingLanguage).join('；')}，已退化为 ${effectiveLang}`
        }
      }

      // 页范围要页数来解析；"整档"判定也要页数——与 pdf_extract_text 同一口径：
      // 只有"整档且要 OCR"才为了一次确认额外探一遍页数。
      const info = pagesSpec !== undefined || ocrEnabled ? await inspectDocument(source) : undefined
      const pageCount = info?.pages ?? 0
      if (info !== undefined && !info.readable) {
        // 加密且没给密码：读不了内容，判定无从谈起——如实说明，不要抛一个底层解析错误。
        return {
          text: `${basename(source)} 已加密，且没有提供密码，无法读取内容做答案页判定。`
            + '请先用 pdf_protect action=decrypt 解除保护（或提供密码）后重试。',
        }
      }
      if (pagesSpec !== undefined && (info === undefined || pageCount < 1)) {
        throw new Error('这个 PDF 的页数不可读，无法解析 pages。')
      }
      let wanted: number[] | undefined
      if (pagesSpec !== undefined) {
        wanted = parsePageSelection(pagesSpec, pageCount).map(index => index + 1).sort((a, b) => a - b)
      }
      // "整档"= 没给 pages，或给的页范围覆盖了全部页（例如 7 页文档的 "1-7"）。
      const coversAll = wanted !== undefined && pageCount > 0 && wanted.length === pageCount
      const wholeDocument = ocrEnabled && (pagesSpec === undefined || coversAll)

      const gate = authorize({
        tool: 'pdf_find_answers',
        action: 'find-answers',
        parameters: { pages: pagesSpec ?? '全部', ocr: ocrEnabled, lang },
        inputs: [source],
        ...(info === undefined ? {} : { pageCount }),
        ...(wholeDocument ? { wholeDocument: true } : {}),
        hints: [
          '只想看某几页就说 pages=6-7',
          '没有文字层的扫描页需要 ocr=true（默认）',
          '本工具只给候选，确认后再用 pdf_arrange 拆分',
        ],
        effects: [
          '只读，不修改任何文件',
          ...(wholeDocument ? [`将对全部 ${pageCount} 页做文字读取（图片页走 OCR）`] : []),
        ],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') {
        return {
          text: `${renderPlanPrompt(gate.plan)}\n\n`
            + '注意：这是只读工具，没有 plan/confirm/force 令牌参数。要跳过这次确认，请把 pages 拆成'
            + '不超过阈值的几段分别调用（例如 pages=1-20、pages=21-40），或把确认策略改回 destructive。',
        }
      }
      if (gate.kind === 'refused') throw new Error(gate.message)

      const started = Date.now()
      const analysis = await analyzeDocument(source, {
        lang: effectiveLang,
        ...(options.tessdataPath === undefined ? {} : { langPath: options.tessdataPath }),
        ocr: ocrEnabled,
        ...(wanted === undefined ? {} : { onlyPages: wanted }),
      })
      const elapsedMs = Date.now() - started
      const total = analysis.pages
      const range = wanted ?? Array.from({ length: total }, (_, index) => index + 1)
      const contentByPage = new Map(analysis.content.map(page => [page.page, page]))

      const scored: ScoredPage[] = range.map(pageNumber => {
        const kind = analysis.triage[pageNumber - 1]?.kind ?? 'empty'
        const content = contentByPage.get(pageNumber)
        const text = content === undefined ? '' : content.lines.map(line => line.text).join('\n')
        // 图片页 + ocr=false：没有内容不是"页面空白"，而是"我们没识别"。
        const ocrSkipped = !ocrEnabled && kind === 'image' && content === undefined
        return {
          page: pageNumber,
          ...scoreAnswerPage({ text, pageNumber, pageCount: total, kind, ocrSkipped }),
        }
      })

      const ranges = groupAnswerRanges(scored)
      const coversWhole = wanted === undefined || wanted.length === total
      const suggestion = coversWhole
        ? suggestArrangement(total, ranges)
        : {
          separable: false,
          note: `只判定了第 ${range.join('、')} 页（文档共 ${total} 页，未覆盖全文），不给出整档拆分建议；`
            + '要看整档拆分请省略 pages。',
          splits: [] as ArrangementSplit[],
        }

      const verdictLabel: Record<AnswerVerdict, string> = {
        answer: '答案',
        question: '试卷',
        mixed: '答案与题目同页',
        unknown: '无法判定',
      }
      const confidenceLabel: Record<AnswerConfidence, string> = { high: '高', medium: '中', low: '低' }

      const lines: string[] = []
      // 1. 一行结论（不硬凑：没有候选就明说"未找到答案页"）。
      //    候选只用 medium/high：纯位置先验的页（low）不算候选，只说"位置可疑"。
      if (ranges.answerRanges.length > 0) {
        const where = ranges.answerRanges.map(range => formatRange(range)).join('、')
        const weakest = ranges.answerRanges
          .map(range => range.confidence)
          .reduce((a, b) => weakerConfidence(a, b), 'high' as AnswerConfidence)
        lines.push(`答案页候选：${where}（置信度 ${confidenceLabel[weakest]}）`)
      } else {
        // 没有 medium/high 候选时，结论行只给一条最关键的原因（其余细节在下面的逐页表格与注意行里）：
        // 同页 > 位置可疑 > 无法判定。位置可疑的说法与 suggestArrangement 的中文提示保持一致。
        const reason = ranges.mixedPages.length > 0
          ? `${formatPages(ranges.mixedPages)}答案与题目同页`
          : ranges.positionOnlyPages.length > 0
            ? `仅${formatPages(ranges.positionOnlyPages)}位置可疑，无文本证据`
            : ranges.unknownPages.length > 0
              ? `${formatPages(ranges.unknownPages)}无法判定`
              : ''
        lines.push(`未找到答案页${reason === '' ? '' : `（${reason}）`}`)
      }
      lines.push(`判定了 ${range.length} 页（文档共 ${total} 页，ocr=${ocrEnabled ? 'true' : 'false'}，lang=${effectiveLang}）`
        + `，用时 ${(elapsedMs / 1000).toFixed(1)} 秒`)
      if (langNote !== undefined) lines.push(`注意：${langNote}`)

      // 2. 逐页表格
      lines.push('')
      lines.push('逐页判定：')
      for (const page of scored) {
        const oneLine = page.evidence.join('；').replace(/\s+/g, ' ').trim()
        const clipped = oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine
        lines.push(`第 ${page.page} 页｜${verdictLabel[page.verdict]}｜${page.score}｜${clipped}`)
      }

      // 3. 位置推断单独列一节：它不是证据，仅供参考，绝不参与拆分
      if (ranges.positionOnlyPages.length > 0) {
        lines.push('')
        lines.push('位置推断（仅供参考，不建议据此拆分）：')
        for (const page of scored.filter(item => item.positionOnly === true)) {
          lines.push(
            `第 ${page.page} 页｜分数 ${page.score}｜位于文档末 25%，无文本证据`,
          )
        }
      }

      // 4. 可拆分时给两条可直接复制的 pdf_arrange 调用（order 只由 medium/high 页决定）
      lines.push('')
      if (suggestion.separable && suggestion.splits.length === 2) {
        const stem = basename(source, extname(source))
        const dir = dirname(source)
        const suffixOf = (role: ArrangementSplit['role']): string => (role === 'answers' ? '-答案' : '-试卷')
        lines.push('拆分建议（先确认候选对不对，再执行；这是新文件，不动源文件）：')
        suggestion.splits.forEach((split, index) => {
          lines.push(
            `  ${index + 1}. pdf_arrange path="${source}" order="${split.order}" `
            + `output="${join(dir, `${stem}${suffixOf(split.role)}.pdf`)}"   # ${split.label}`,
          )
        })
        lines.push(`  （${suggestion.note}）`)
      } else {
        lines.push(`不给出拆分建议：${suggestion.note}`)
      }

      // 5. mixed / unknown / 位置可疑 如实列出
      if (ranges.mixedPages.length > 0) {
        lines.push(
          `注意：${formatPages(ranges.mixedPages)}答案与题目同页，无法按页分离——本工具不做内容级拆分，`
          + '请人工确认后再决定（例如只取题目的那部分页码）。',
        )
      }
      if (ranges.unknownPages.length > 0) {
        lines.push(`注意：${formatPages(ranges.unknownPages)}无法判定（文本过少或未做 OCR），没有硬凑成答案页。`)
      }
      if (ranges.positionOnlyPages.length > 0) {
        lines.push(
          `注意：${formatPages(ranges.positionOnlyPages)}只是"位置可疑"（位于文档末 25%），`
          + '**没有文本证据**，未计入候选与拆分建议；不要仅凭位置就拆。',
        )
      }
      if (!ocrEnabled) {
        lines.push('注意：ocr=false，图片页只标"未做 OCR"，没有做任何识别；要判定请加 ocr=true。')
      } else if (analysis.triage.some(t => t.kind === 'image' && range.includes(t.page))) {
        lines.push('注意：图片页的文字来自 OCR，可能有错字/多余空格；判定依据已按容错正则处理（允许字间空格）。')
      }
      lines.push('注意：以上是**候选**，不是结论；本工具只读，未修改、未拆分任何文件。')
      return { text: lines.join('\n') }
    },
  }

  // ── searchable PDF ───────────────────────────────────────────────────────
  const searchable: ToolDefinition = {
    name: 'pdf_make_searchable',
    description:
      '把扫描件变成可搜索的 PDF：对图片页做 OCR，把识别出的文字作为不可见文字层写入，'
      + '页面外观保持不变。生成新文件，绝不覆盖源文件。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      output: { type: 'string', description: '输出路径。省略则在源文件旁生成 <名字>-searchable.pdf。' },
      mode: {
        type: 'string',
        enum: ['invisible', 'cover'],
        description: 'invisible（默认）：文字层不可见。cover：把识别文字可见地覆盖在图片上，便于核对。',
      },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({ card: 'generic', title: `生成可搜索 PDF ${basename(String(args.path ?? ''))}`, kind: 'write' }),
    async execute(args) {
      const source = resolveInput(args)
      const output = resolveOutput(source, args, '-searchable', options.workspaceRoot)
      const info = await inspectDocument(source)
      const gate = authorize({
        tool: 'pdf_make_searchable',
        action: 'searchable',
        parameters: { mode: args.mode === 'cover' ? 'cover' : 'invisible', pages: info.pages },
        inputs: [source],
        output,
        pageCount: info.pages,
        wholeDocument: true,
        hints: ['想先看效果就用 pdf_preview', '想把识别文字可见地盖上去用 mode=cover'],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)
      const analysis = await analyzeDocument(source)
      const result = await exportSearchable(
        analysis,
        output,
        args.mode === 'cover' ? 'cover' : 'invisible',
      )
      const text = [
        `已生成：${output}`,
        `页数：${result.pages ?? analysis.pages}，写入文字行：${(result as { linesWritten?: number }).linesWritten ?? '(见日志)'}`,
        `原始文件未改动：${source}`,
      ].join('\n')
      return { text }
    },
  }

  // ── edit text ────────────────────────────────────────────────────────────
  const edit: ToolDefinition = {
    name: 'pdf_edit_text',
    description:
      '替换 PDF 中已有的文字，保持位置和其余内容不变。先用 pdf_inspect 并设 runs=true 拿到文字块的 id。'
      + '一次编辑要用同一份列表里的 id（改写后 id 会整体前移）。生成新文件，绝不覆盖源文件。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      edits: {
        type: 'array',
        required: true,
        description: '编辑数组，每项形如 {"page":1,"targetId":"1:6","to":"新文字"}，可选 "fontSize"。',
        items: {
          type: 'object',
          description: '一条文字替换。',
          // The schema subset requires an explicit `additionalProperties`, and
          // declaring the fields is better than allowing anything: the model
          // gets a real contract instead of a free-form bag.
          additionalProperties: false,
          properties: {
            page: { type: 'integer', required: true, description: '页码，从 1 开始。' },
            targetId: { type: 'string', required: true, description: '文字块 id，来自 pdf_inspect 的 runs。' },
            to: { type: 'string', required: true, description: '替换后的文字。' },
            fontSize: { type: 'number', description: '可选，替换后的字号。' },
          },
        },
      },
      output: { type: 'string', description: '输出路径。省略则生成 <名字>-edited.pdf。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: `改写文字 ${basename(String(args.path ?? ''))}（${Array.isArray(args.edits) ? args.edits.length : 0} 处）`,
      kind: 'write',
    }),
    async execute(args) {
      const source = resolveInput(args)
      const raw = args.edits
      if (!Array.isArray(raw) || raw.length === 0) throw new Error('edits 必须是非空数组')
      const output = resolveOutput(source, args, '-edited', options.workspaceRoot)
      // Validate the shape here rather than letting it surface as a confusing
      // failure deep inside the writer.
      const edits = raw.map((entry, index) => {
        if (entry === null || typeof entry !== 'object') throw new Error(`edits[${index}] 不是对象`)
        const item = entry as Record<string, unknown>
        const page = Number(item.page)
        const targetId = String(item.targetId ?? '')
        const to = String(item.to ?? '')
        if (!Number.isFinite(page) || page < 1) throw new Error(`edits[${index}].page 无效`)
        if (targetId === '') throw new Error(`edits[${index}].targetId 缺失`)
        return {
          page,
          targetId,
          to,
          ...(typeof item.fontSize === 'number' ? { fontSize: item.fontSize } : {}),
        }
      })

      const gate = authorize({
        tool: 'pdf_edit_text',
        action: 'edit',
        // 参数里放完整的改写清单：改一处不同的文字就应得到不同的 planId。
        parameters: { edits, pageCount: edits.length },
        inputs: [source],
        output,
        hints: ['只改某一页就说「只改第 3 页」', '想换新文字就直接说新的文字'],
        effects: ['不修改源文件，结果写入新的 PDF', '改写后文字块的 id 会整体前移，需要重新读取'],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)
      const result = await applyTextEdits(source, output, edits)
      // 0 产出的"已生成"是最危险的假成功：用户以为改好了，其实文件里一个字都没变。
      // 这里改成明确失败，并给出下一步（多半是 targetId 过期，或者这页根本没有文字层）。
      if (result.applied === 0) {
        const why = result.notes.join('；') || '没有找到可改写的文字块'
        throw new Error(
          `没有应用任何改写（0/${edits.length}）：${why}。`
          + '请先用 pdf_inspect runs=true 重新读取文字块 id（改写后 id 会整体前移）；'
          + '如果这一页是图片页（没有文字层），需要先 pdf_make_searchable 生成可搜索副本，再改写。',
        )
      }
      const text = [
        `已生成：${result.outputPath}`,
        `应用 ${result.applied} 处改写，共 ${edits.length} 处请求。`,
        ...result.notes.map(note => `注意：${note}`),
        '提示：改写后文字块的 id 会整体前移，继续编辑前请重新读取。',
      ].join('\n')
      return { text }
    },
  }

  // ── replace line (整行重绘) ─────────────────────────────────────────────────
  //
  // 「把一个词改长」是 `pdf_edit_text` 做不对的事：它只换字形串、不移动后面的文字，
  // PDF 又没有段落重排，于是 `turn` → `turning` 会与后一个字重叠。正确做法是找到该文字块
  // 所在的 `BT … ET` 绘制组，抹掉整组文字，再在算出的页面坐标原点重画长度自由的新文字。
  const replaceLine: ToolDefinition = {
    name: 'pdf_replace_line',
    description:
      '整行重绘：把某个文字块所在的整行文字抹掉，再在原位重画新的整行文字。'
      + '这是「把一个词改长/改短」的正确做法——pdf_edit_text 只换字形串、不移动后面的文字，'
      + '改长会与后一个字重叠（引擎只提示"可能向右溢出"，不阻止）。'
      + '先用 pdf_inspect 并设 runs=true 拿到目标行里任意一个文字块的 id。'
      + '默认还会做「跨组重排」：真实文档常把视觉上的一整行拆成多个 BT…ET 绘制组，'
      + '新文字变长时，会把同一视觉行右侧的兄弟组整体右移同样多的距离（只改各组自己的 Tm 锚点），'
      + '避免重叠；不想动版面就传 shiftSiblings=false（那时若变长越界会给出重叠警告）。'
      + '注意：它抹掉的是该文字块所在的整个 BT…ET 绘制组内的文字；'
      + '如果这一组不只有你要改的那一句，请改用 pdf_edit_text（先用 pdf_inspect runs=true 看清组内文字）。'
      + '生成新文件，绝不覆盖源文件。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      page: { type: 'integer', required: true, description: '页码（1 开始）。' },
      targetId: { type: 'string', description: '目标行里任意一个文字块 id，来自 pdf_inspect 的 runs。' },
      text: { type: 'string', description: '这一整组的新文字（长度自由，不会再与后文重叠）。' },
      fontSize: { type: 'number', description: '可选，覆盖页面字号；省略时按原几何算出的页面字号。' },
      shiftSiblings: {
        type: 'boolean',
        description: '是否把同一视觉行右侧的兄弟组整体右移让位，默认 true；false 则只重绘目标组。',
      },
      output: { type: 'string', description: '输出路径。省略则生成 <名字>-line-redrawn.pdf。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: `整行重绘 ${basename(String(args.path ?? ''))}`,
      kind: 'write',
    }),
    async execute(args) {
      const source = resolveInput(args)
      const page = Number(args.page)
      if (!Number.isFinite(page) || page < 1) throw new Error('page 无效：应为从 1 开始的页码')
      const output = resolveOutput(source, args, '-line-redrawn', options.workspaceRoot)
      const targetId = optionalString(args, 'targetId')
      const text = optionalString(args, 'text')
      const fontSize = typeof args.fontSize === 'number' && args.fontSize > 0 ? args.fontSize : undefined
      // 三态：未指定 → 默认开启跨组重排；显式 false 才关闭。它必须参与 planId，
      // 否则"确认的是会挪版面、执行的是不挪"就成了一条绕过一致性的通道。
      const shiftSiblings = args.shiftSiblings === undefined ? true : args.shiftSiblings === true

      const gate = authorize({
        tool: 'pdf_replace_line',
        action: 'redraw',
        // 参数里放完整的重绘规格：换一行、换文字、换字号或换跨组重排开关都应得到不同的 planId。
        parameters: {
          page,
          targetId: targetId ?? '(缺失)',
          text: text ?? '(缺失)',
          shiftSiblings,
          ...(fontSize === undefined ? {} : { fontSize }),
        },
        inputs: [source],
        output,
        // 缺 id 或新文字时按"缺关键参数"处理：先给确认单，且带 confirm 也不能绕过。
        missing: [
          ...(targetId === undefined ? ['目标文字块 id（targetId）'] : []),
          ...(text === undefined ? ['新的整行文字（text）'] : []),
        ],
        hints: [
          '不确定改哪一行，就先 pdf_inspect runs=true 列文字块',
          '如果这一组里不止你要改的那一句，改用 pdf_edit_text 更稳妥',
          '不想让相邻片段跟着挪动就加 shiftSiblings=false',
        ],
        effects: [
          '不修改源文件，结果写入新的 PDF',
          '该文字块所在的整个绘制组会被抹掉后重画',
          ...(shiftSiblings ? ['同一视觉行右侧的相邻绘制组会被整体右移让位'] : []),
        ],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)

      // `force: true` 会跳过"缺关键参数"的硬拦截，所以这里再兜一次，绝不让 undefined 进入写入路径。
      if (targetId === undefined || text === undefined) {
        throw new Error('缺少 targetId 或 text 参数：整行重绘需要「改哪一行」和「改成什么」两样都明确。')
      }

      const { bytes, result } = await redrawLineInPdfBytes(new Uint8Array(await readFile(source)), {
        page,
        targetId,
        text,
        shiftSiblings,
        ...(fontSize === undefined ? {} : { fontSize }),
      })
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, bytes)

      const oneLine = (value: string): string => {
        const flat = value.replace(/\s+/g, ' ').trim()
        return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`
      }
      const shift = result.siblingShift
      const siblingLine = !shiftSiblings
        ? '相邻片段处理：未移动相邻片段（shiftSiblings=false）。'
        : shift === undefined
          ? '相邻片段处理：这一行没有需要处理的相邻片段。'
          : shift.shifted > 0
            ? `相邻片段处理：已把同一视觉行右侧 ${shift.shifted} 个片段整体右移 ${shift.deltaPageX.toFixed(2)}pt。`
            : shift.failed.length > 0
              ? `相邻片段处理：${shift.failed.length} 个相邻片段无法安全平移（见下方注意）。`
              : '相邻片段处理：新文字没有变长，未移动相邻片段。'
      const choice = result.fontChoice
      const fontLine = choice.matched
        ? `字体处理：沿用原文的字体家族${choice.originalPostScriptName === undefined ? '' : ` ${choice.originalPostScriptName}`}。`
        : choice.originalPostScriptName === undefined
          ? `字体处理：原文没有可识别的字体家族，使用 ${basename(choice.usedPath)}。`
          : `字体处理：原文 ${choice.originalPostScriptName} 无法完整渲染新文字，已改用 ${basename(choice.usedPath)}`
            + `${choice.sizeAdjustedFrom === undefined ? '' : `（并按${choice.sizeAdjustBasis}把字号估算调整为 ${result.pageFontSize.toFixed(2)}pt）`}，`
            + '字面可能略有差异。'
      return {
        text: [
          `已生成：${output}`,
          `这一行改成了：${oneLine(text)}`,
          `被抹掉的原文：${oneLine(result.groupText) || '（无法解码）'}`,
          fontLine,
          siblingLine,
          ...result.notes.map(note => `注意：${note}`),
        ].join('\n'),
      }
    },
  }

  // ── watermark ────────────────────────────────────────────────────────────
  const watermark: ToolDefinition = {
    name: 'pdf_watermark',
    description:
      '水印三合一。action=add 添加文字或图片水印；action=scan 查找已有水印（返回置信度与依据，不改文件）；'
      + 'action=remove 移除能确认的水印（默认只动置信度 ≥ 0.9 的候选）。'
      + 'scan 会把「看到了但不敢删」的对象单独列出来（例如被标成 /Artifact<</Subtype/Header>> 的页眉类对象，'
      + '置信度 0.7）：确认那是水印后，用 minConfidence=0.7 让 remove 一并清掉。'
      + '默认 render=text（真实文字，可被搜索/复制）；若水印不应进入文字层（例如内部资料、机密标记），'
      + '用 render=outline 把同样字形画成矢量路径，外观一致但无法被文本提取。'
      + '注意：栅格化进页面图片的水印、或当正文绘制的水印，无法可靠移除，scan 会说明原因。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: 'PDF 路径。' },
      action: {
        type: 'string',
        required: true,
        enum: ['add', 'scan', 'remove'],
        description: 'add 添加；scan 只查找不改动；remove 移除置信度达标的候选水印。',
      },
      minConfidence: {
        type: 'number',
        description: 'action=remove 的删除门槛，默认 0.9。scan 里报为「页眉/页脚类 /Artifact 对象」的候选'
          + '置信度是 0.7，只有显式传 0.7（或更低）才会被删除——这是刻意留给人确认的一步。',
      },
      text: { type: 'string', description: 'action=add 时的水印文字（与 imagePath 二选一）。' },
      imagePath: { type: 'string', description: 'action=add 时用图片作水印（PNG/JPEG 路径，与 text 二选一）。' },
      render: {
        type: 'string',
        enum: ['text', 'outline'],
        description: 'text（默认）画真实文字；outline 画矢量轮廓 —— 外观相同但不进入文字层，且不嵌入字体。',
      },
      placement: {
        type: 'string',
        enum: ['tile', 'center', 'corner'],
        description: '位置：tile 斜向平铺（默认）、center 居中、corner 角落。',
      },
      corner: {
        type: 'string',
        enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
        description: 'placement=corner 时的角，默认 bottom-right。',
      },
      rotation: { type: 'number', description: '旋转角度（逆时针），默认 tile 45、其它 0。' },
      opacity: { type: 'number', description: '透明度 0..1，默认 0.15。' },
      fontSize: { type: 'number', description: '字号，默认 48。' },
      color: { type: 'string', description: '颜色 #rrggbb，默认 #d92626。' },
      margin: { type: 'number', description: '边距（角标位置与平铺留白），默认 24。' },
      artifact: {
        type: 'boolean',
        description: '是否把水印标记为 /Artifact（默认 true）：声明它是装饰而非正文，辅助阅读与 PDF/UA 会跳过它。',
      },
      pages: {
        type: 'array',
        items: { type: 'integer' },
        description: '要加水印的页码（从 1 开始），默认全部；越界页号会被忽略并提示。',
      },
      output: { type: 'string', description: 'add / remove 的输出路径。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: `水印 ${String(args.action ?? '')} ${basename(String(args.path ?? ''))}`,
      kind: args.action === 'scan' ? 'read' : 'write',
    }),
    async execute(args) {
      const source = resolveInput(args)
      const action = requireString(args, 'action')

      if (action === 'scan') {
        const report = await reportWatermarks(source)
        // 分两段说：默认就会被删的（≥ 0.9），和"看到了但要人点头"的（< 0.9）。
        // 混在一起报会让用户以为 remove 会照单全删，而它不会。
        const confident = report.candidates.filter(candidate => candidate.confidence >= 0.9)
        const unsure = report.candidates.filter(candidate => candidate.confidence < 0.9)
        const lines: string[] = []
        if (unsure.length === 0) {
          // 只有这一类时保持原来的说法：别把"找到 N 个"和"没找到"写进同一次回答。
          lines.push(`共 ${report.pages} 页，找到 ${report.candidates.length} 个可移除候选：`)
          for (const candidate of confident) {
            lines.push(
              `  第${candidate.page}页｜${Math.round(candidate.confidence * 100)}%｜${candidate.detail}`,
            )
          }
          if (confident.length === 0) lines.push('  （没有找到按结构可识别的水印）')
        } else {
          lines.push(`共 ${report.pages} 页，找到 ${report.candidates.length} 个候选：`
            + `其中 ${confident.length} 个达到默认删除门槛 0.9，${unsure.length} 个需要你确认。`)
          for (const candidate of confident) {
            lines.push(
              `  第${candidate.page}页｜${Math.round(candidate.confidence * 100)}%｜${candidate.detail}`,
            )
          }
          lines.push(`另有 ${unsure.length} 个候选置信度低于默认删除门槛 0.9，需要你确认后才会删除：`)
          for (const candidate of unsure) {
            lines.push(
              `  第${candidate.page}页｜${Math.round(candidate.confidence * 100)}%｜${candidate.detail}`,
            )
          }
          const lowest = Math.min(...unsure.map(candidate => candidate.confidence))
          lines.push(`  确认这些确实是水印，就用 minConfidence=${lowest} 重跑 action=remove。`)
        }
        for (const refused of report.refused) {
          lines.push(`无法处理 · 第${refused.page}页：${refused.detail}`)
        }
        return { text: lines.join('\n') }
      }

      if (action === 'remove') {
        const output = resolveOutput(source, args, '-clean', options.workspaceRoot)
        // 门槛是本次执行的一部分，所以它必须进确认单：计划说 0.9、执行却按 0.7 删，
        // 就等于用户确认了一件与实际发生的事不同的操作。
        const requested = optionalNumber(args, 'minConfidence')
        if (requested !== undefined && (requested < 0 || requested > 1)) {
          throw new Error(`minConfidence 必须在 0..1 之间，收到 ${requested}`)
        }
        const minConfidence = requested ?? 0.9
        // 这里不预扫一遍水印：真正执行时引擎自己会扫，再扫一次只是白花时间。
        // 计划只声明"移除置信度达标的候选"，而这与文件指纹一一对应，planId 依然稳定。
        const gate = authorize({
          tool: 'pdf_watermark',
          action: 'remove',
          parameters: {
            candidates: `全部候选（置信度 ≥ ${minConfidence}）`,
            置信度门槛: minConfidence,
          },
          inputs: [source],
          output,
          hints: ['只想删某几页就说「只删第 1 页」', '想先看候选清单就先跑 action=scan'],
          effects: ['不修改源文件，结果写入新的 PDF', `只移除置信度 ≥ ${minConfidence} 的候选（更低的会被保留）`],
          ...confirmationArgs(options, args),
        })
        if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
        if (gate.kind === 'refused') throw new Error(gate.message)
        const result = await stripWatermarks(source, output, { dryRun: false, minConfidence })
        // 用 `in` 收窄而不是 `result.dryRun`：返回值是联合类型，靠判别属性在部分
        // TypeScript 版本下收不窄，而 `outputPath` 只存在于非 dry-run 分支。
        if (!('outputPath' in result)) {
          return { text: `没有置信度 ≥ ${minConfidence} 的可移除水印，文件未改动。跳过 ${result.skipped.length} 个低置信度候选。` }
        }
        const lines = [
          `已生成：${result.outputPath}`,
          `移除 ${result.removed.length} 个水印。`,
          ...result.notes,
        ]
        if (result.skipped.length > 0) {
          lines.push(`保留 ${result.skipped.length} 个低置信度候选（自动删除可能损伤正文）：`)
          for (const candidate of result.skipped) lines.push(`  ${candidate.detail}`)
        }
        return { text: lines.join('\n') }
      }

      if (action !== 'add') throw new Error(`未知 action：${action}`)
      const text = optionalString(args, 'text')
      const imagePath = optionalString(args, 'imagePath')
      const image = imagePath === undefined ? undefined : new Uint8Array(await readFile(imagePath))
      const output = resolveOutput(source, args, '-watermarked', options.workspaceRoot)
      // 水印的完整规格只在这里构造一次：确认单里的内容与实际执行的参数是同一份对象，
      // 从根上杜绝"计划说 A、执行 B"。
      const spec = {
        ...(text === undefined ? {} : { text }),
        ...(image === undefined ? {} : { image }),
        ...(typeof args.placement === 'string' ? { placement: args.placement as never } : {}),
        ...(typeof args.render === 'string' ? { render: args.render as never } : {}),
        ...(typeof args.corner === 'string' ? { corner: args.corner as never } : {}),
        ...(typeof args.rotation === 'number' ? { rotation: args.rotation } : {}),
        ...(typeof args.opacity === 'number' ? { opacity: args.opacity } : {}),
        ...(typeof args.fontSize === 'number' ? { fontSize: args.fontSize } : {}),
        ...(typeof args.color === 'string' ? { color: args.color } : {}),
        ...(typeof args.margin === 'number' ? { margin: args.margin } : {}),
        ...(typeof args.artifact === 'boolean' ? { artifact: args.artifact } : {}),
        ...(Array.isArray(args.pages) ? { pages: (args.pages as unknown[]).map(Number) } : {}),
      }
      const watermarkDefaults: Record<string, unknown> = {}
      if (args.render === undefined) watermarkDefaults.render = 'text'
      if (args.placement === undefined) watermarkDefaults.placement = 'tile'
      if (args.opacity === undefined) watermarkDefaults.opacity = 0.15
      if (args.fontSize === undefined) watermarkDefaults.fontSize = 48
      if (args.artifact === undefined) watermarkDefaults.artifact = true
      if (args.pages === undefined) watermarkDefaults.pages = '全部页面'
      const gate = authorize({
        tool: 'pdf_watermark',
        action: 'add',
        parameters: {
          content: text ?? (imagePath === undefined ? undefined : `图片文件 ${basename(imagePath)}`),
          ...spec,
          image: undefined,
        },
        inputs: [source, imagePath],
        output,
        // 没给水印内容时不要猜：给出一张"缺内容"的确认单，把常见取值直接摆在用户面前。
        missing: text === undefined && imagePath === undefined ? ['水印文字（text）或图片（imagePath）'] : [],
        defaults: watermarkDefaults,
        hints: ['没想好写什么？常见的是「内部资料」「机密」「请勿外传」', '只加某几页就说「只要第 1、3 页」', '想换颜色就说「改成蓝色 #1050a0」'],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)
      const result = await stampWatermark(source, output, spec)
      const shown = result.textDrawn === '' ? `${basename(imagePath ?? '')}（图片）` : result.textDrawn
      const lines = [
        `已生成：${result.outputPath}`,
        `水印「${shown}」已加到 ${result.pages} 页（${result.render === 'outline' ? '矢量轮廓，不进入文字层' : result.render === 'image' ? '图片' : '文字层文字'}${result.artifact ? '，已标记 /Artifact' : ''}）。`,
      ]
      if (result.droppedChars.length > 0) {
        lines.push(`以下字符所选字体无法编码，已丢弃：${result.droppedChars.join(' ')}`)
      }
      lines.push(...result.notes)
      return { text: lines.join('\n') }
    },
  }

  // ── protect ──────────────────────────────────────────────────────────────
  const protect: ToolDefinition = {
    name: 'pdf_protect',
    description:
      '密码保护。action=check 查询是否加密、是否需要密码；action=encrypt 加密；action=decrypt 凭密码解除。'
      + '注意：查询结果区分「已加密」与「需要密码才能打开」，这是两件事。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: 'PDF 路径。' },
      action: {
        type: 'string',
        required: true,
        enum: ['check', 'encrypt', 'decrypt'],
        description: 'check 查询；encrypt 加密；decrypt 解除。',
      },
      password: { type: 'string', description: 'encrypt 时作为打开密码；decrypt 时作为要解除的密码。' },
      allow: {
        type: 'array',
        items: { type: 'string' },
        description: 'encrypt 时授予的权限：print / modify / extract / annotate / form / assembly / high-quality-print。默认只有 print。',
      },
      output: { type: 'string', description: 'encrypt / decrypt 的输出路径。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: `密码 ${String(args.action ?? '')} ${basename(String(args.path ?? ''))}`,
      kind: args.action === 'check' ? 'read' : 'write',
    }),
    async execute(args) {
      const source = resolveInput(args)
      const action = requireString(args, 'action')

      if (action === 'check') {
        const info = await inspectDocument(source)
        const verdict = !info.encrypted
          ? '未加密：任何人都能打开和修改。'
          : info.opensWithoutPassword
            ? '已加密，但无需密码即可打开（权限受 /Encrypt 约束）。'
            : '已加密，需要密码才能打开。'
        const pages = info.readable ? `共 ${info.pages} 页。` : '页数不可读，需要密码。'
        return { text: [`${basename(source)}：${verdict}${pages}`, ...info.notes].join('\n') }
      }

      const password = optionalString(args, 'password')
      if (action === 'encrypt') {
        if (password === undefined) throw new Error('action=encrypt 需要 password 参数')
        const output = resolveOutput(source, args, '-protected', options.workspaceRoot)
        const allow = Array.isArray(args.allow) ? (args.allow as string[]) : undefined
        const gate = authorize({
          tool: 'pdf_protect',
          action: 'encrypt',
          parameters: { allow: allow ?? ['print'], password: '（已提供，不写入计划）' },
          inputs: [source],
          output,
          hints: ['想放开更多权限就用 allow 列出', '只想查状态用 action=check'],
          effects: ['不修改源文件，结果写入新的 PDF', '打开文件将需要密码'],
          ...confirmationArgs(options, args),
        })
        if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
        if (gate.kind === 'refused') throw new Error(gate.message)
        const result = await protectPdf(source, output, {
          kind: 'encrypt',
          userPassword: password,
          ...(allow === undefined ? {} : { allow: allow as never }),
        })
        return {
          text: `已生成：${result.outputPath}\n加密：${result.encrypted}，需要密码才能打开：${!result.opensWithoutPassword}`,
        }
      }

      if (action !== 'decrypt') throw new Error(`未知 action：${action}`)
      const output = resolveOutput(source, args, '-unlocked', options.workspaceRoot)
      const gate = authorize({
        tool: 'pdf_protect',
        action: 'decrypt',
        parameters: { password: '（已提供，不写入计划）' },
        inputs: [source],
        output,
        hints: ['想只查状态用 action=check', '密码不对会失败，不会产出文件'],
        effects: ['不修改源文件，结果写入新的 PDF', '结果不再受密码保护'],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)
      const result = await protectPdf(source, output, { kind: 'decrypt', password: password ?? '' })
      return {
        text: `已生成：${result.outputPath}\n加密：${result.encrypted}（应为 false）`,
      }
    },
  }

  /** 动作 → 中文说法（结果文本用）。 */
  const ANNOTATION_LABELS: Record<AnnotationAction, string> = {
    highlight: '高亮',
    underline: '加下划线',
    strikeout: '加删除线',
    box: '加方框',
    ellipse: '加椭圆',
    freetext: '写入自由文本',
    note: '加便签',
    stamp: '盖章',
  }

  // ── annotate ─────────────────────────────────────────────────────────────
  const annotate: ToolDefinition = {
    name: 'pdf_annotate',
    description:
      '注释标注：高亮 / 下划线 / 删除线 / 方框 / 椭圆 / 自由文本 / 便签 / 图章，写进 PDF 的注释层'
      + '（可在阅读器里选中、编辑、导出；带 Print 标志，打印时会出现）。'
      + '文本标记类（highlight/underline/strikeout）用 find="要标注的文字" 在该页文字层里定位，不必自己算坐标；'
      + '其余动作用 rect={x,y,width,height}（pt，原点左下）。生成新文件，绝不覆盖源文件。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      action: {
        type: 'string',
        required: true,
        description: 'highlight | underline | strikeout | box | ellipse | freetext | note | stamp。',
      },
      page: { type: 'integer', required: true, description: '页码（1 开始）。' },
      find: { type: 'string', description: '要标注的文字（文本标记类必填），在该页文字层里定位。' },
      occurrence: { type: 'integer', description: '同一页里第几次出现，默认 1。' },
      rect: {
        type: 'object',
        description: '位置与大小 {x,y,width,height}（pt，原点左下）：框/椭圆/自由文本/便签/图章必填。',
      },
      contents: { type: 'string', description: '自由文本 / 便签 / 图章的正文。' },
      color: { type: 'string', description: '颜色 #rrggbb；省略用动作默认色（高亮黄、下划线红、图章蓝…）。' },
      opacity: { type: 'number', description: '不透明度 0..1；省略用动作默认（高亮 0.4、其余 1）。' },
      borderWidth: { type: 'number', description: '边框宽度（pt），默认 1.5。' },
      fontSize: { type: 'number', description: '自由文本默认 12、图章默认 24。' },
      icon: { type: 'string', description: `便签图标：${NOTE_ICONS.join(' | ')}，默认 Comment。` },
      author: { type: 'string', description: '注释作者，默认 dsh-pdf-studio。' },
      output: { type: 'string', description: '输出路径。省略则生成 <名字>-annotated.pdf。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: `添加标注 ${basename(String(args.path ?? ''))}`,
      kind: 'write',
    }),
    async execute(args) {
      const source = resolveInput(args)
      const actionRaw = String(args.action ?? '').trim()
      if (!(actionRaw in ACTION_SUBTYPES)) {
        throw new Error(`未知 action：${actionRaw === '' ? '（空）' : actionRaw}；支持 ${Object.keys(ACTION_SUBTYPES).join(' / ')}`)
      }
      const action = actionRaw as AnnotationAction
      const pageNumber = Number(args.page)
      if (!Number.isFinite(pageNumber) || pageNumber < 1) throw new Error('page 无效：应为从 1 开始的页码')
      const output = resolveOutput(source, args, '-annotated', options.workspaceRoot)
      const isMarkup = MARKUP_ACTIONS.includes(action)
      const needsAppearance = APPEARANCE_ACTIONS.includes(action)
      const find = optionalString(args, 'find')
      const contents = optionalString(args, 'contents')
      const occurrence = typeof args.occurrence === 'number' && args.occurrence >= 1 ? Math.floor(args.occurrence) : 1
      const rectArg = args.rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined
      const rect = rectArg !== undefined
        && [rectArg.x, rectArg.y, rectArg.width, rectArg.height].every(
          value => typeof value === 'number' && Number.isFinite(value),
        )
        ? { x: Number(rectArg.x), y: Number(rectArg.y), width: Number(rectArg.width), height: Number(rectArg.height) }
        : undefined
      const color = optionalString(args, 'color')
      const author = optionalString(args, 'author')
      const icon = optionalString(args, 'icon')
      if (icon !== undefined && !NOTE_ICONS.includes(icon)) {
        throw new Error(`icon "${icon}" 不是标准便签图标；可用：${NOTE_ICONS.join(' / ')}`)
      }
      const opacity = typeof args.opacity === 'number' && args.opacity >= 0 && args.opacity <= 1 ? args.opacity : undefined
      const borderWidth = typeof args.borderWidth === 'number' && args.borderWidth > 0 ? args.borderWidth : undefined
      const fontSize = typeof args.fontSize === 'number' && args.fontSize > 0 ? args.fontSize : undefined

      const missing: string[] = []
      if (isMarkup && find === undefined) missing.push('要标注的文字（find）')
      if (!isMarkup && rect === undefined) missing.push('注释位置（rect: {x,y,width,height}）')
      if (needsAppearance && contents === undefined) missing.push('注释内容（contents）')

      // 文本标记：先在文字层里定位。算出来的几何会写进计划参数，
      // 于是"确认的是这个位置、执行的是这个位置"由 planId 绑死。
      let quads: Array<{ x: number; y: number; width: number; height: number }> | undefined
      let locatedLine: string | undefined
      if (isMarkup && find !== undefined && missing.length === 0) {
        const doc = await openPdf(source)
        let lines: Array<{ text: string; rect: { x: number; y: number; width: number; height: number } }> = []
        try {
          if (pageNumber > doc.numPages) throw new Error(`页码 ${pageNumber} 超出范围（共 ${doc.numPages} 页）`)
          lines = (await extractTextLayer(doc, pageNumber)).map(line => ({ text: line.text, rect: line.rect }))
        } finally {
          await doc.dispose()
        }
        const hit = lines.find(line => line.text.includes(find))
        if (hit === undefined) {
          const head = lines.slice(0, 3).map(line => line.text).join(' / ') || '（这一页没有文字层，可能是扫描图；先 pdf_make_searchable）'
          throw new Error(`第 ${pageNumber} 页没有找到文字「${find}」。这一页前几行是：${head}`)
        }
        const window = locateInLine(hit, find, occurrence)
        if (window === undefined) {
          throw new Error(`第 ${pageNumber} 页找到该行，但第 ${occurrence} 次出现的「${find}」定位失败`)
        }
        quads = [window]
        locatedLine = hit.text.slice(0, 60)
      }

      const gate = authorize({
        tool: 'pdf_annotate',
        action,
        parameters: {
          page: pageNumber,
          action,
          find,
          ...(find === undefined ? {} : { occurrence }),
          rect,
          quads,
          contents,
          color,
          opacity,
          borderWidth,
          fontSize,
          icon,
          author,
        },
        inputs: [source],
        output,
        missing,
        defaults: {
          color: DEFAULT_COLORS[action],
          opacity: DEFAULT_OPACITY[action],
          ...(needsAppearance ? { fontSize: action === 'stamp' ? 24 : 12 } : {}),
          ...(action === 'note' ? { icon: 'Comment' } : {}),
        },
        hints: [
          '文本标记给 find="原句" 就能定位；框/椭圆/图章给 rect={x,y,width,height}（pt，原点左下）',
          '自由文本 / 便签 / 图章必须给 contents',
        ],
        effects: [
          '不修改源文件，结果写入新的 PDF',
          '注释带 Print 标志（/F 4），打印与打印预览里会出现',
          '注释写在注释层，可在阅读器里选中 / 编辑 / 删除',
        ],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)

      const pdfDoc = await PDFDocument.load(new Uint8Array(await readFile(source)), { updateMetadata: false })
      const page = pdfDoc.getPages()[pageNumber - 1]
      if (page === undefined) throw new Error(`页码 ${pageNumber} 超出范围（共 ${pdfDoc.getPageCount()} 页）`)
      const size = page.getSize()
      const target = rect ?? { x: 0, y: 0, width: 0, height: 0 }
      if (rect !== undefined) {
        // 越界收拢而不是拒绝：用户给的矩形常常只差几个点。
        target.x = Math.max(0, Math.min(rect.x, size.width - 1))
        target.y = Math.max(0, Math.min(rect.y, size.height - 1))
        target.width = Math.max(1, Math.min(rect.width, size.width - target.x))
        target.height = Math.max(1, Math.min(rect.height, size.height - target.y))
      }
      const result = await addAnnotation(
        pdfDoc as never,
        page as never,
        pdfDoc.context as never,
        {
          action,
          rect: isMarkup && quads !== undefined ? quads[0] : target,
          ...(quads === undefined ? {} : { quads }),
          ...(color === undefined ? {} : { color }),
          ...(opacity === undefined ? {} : { opacity }),
          ...(borderWidth === undefined ? {} : { borderWidth }),
          ...(contents === undefined ? {} : { contents }),
          ...(author === undefined ? {} : { author }),
          ...(fontSize === undefined ? {} : { fontSize }),
          ...(icon === undefined ? {} : { icon }),
        },
      )
      await writeFile(output, await pdfDoc.save())
      const label = ANNOTATION_LABELS[action]
      const details = isMarkup
        ? `「${find}」已${label}（定位行：${locatedLine ?? ''}）`
        : `${label}已加在第 ${pageNumber} 页 (${target.x.toFixed(0)}, ${target.y.toFixed(0)}) ${target.width.toFixed(0)}×${target.height.toFixed(0)}pt`
      const overflow = !isMarkup && contents !== undefined && action === 'freetext'
        && target.width < contents.length * (fontSize ?? 12) * 0.6
      return {
        text: [
          `已生成：${output}`,
          `第 ${pageNumber} 页：${details}${result.appearance ? '，并生成了外观流（/AP）' : ''}。`,
          ...(overflow ? ['注意：文字可能超出这个框的宽度（本工具不自动换行，需要换行请用 \n）。'] : []),
          '注意：注释由阅读器渲染；我们的预览走 pdf.js 的 canvas，可能不显示注释层——请在系统预览 / Acrobat 里确认观感。',
        ].join('\n'),
      }
    },
  }

  // ── page text（页码 / 页眉页脚 / Bates / 插入文字）──────────────────────
  const PAGE_TEXT_ACTIONS = ['insert', 'page-number', 'header-footer', 'bates'] as const
  const PAGE_TEXT_LABELS: Record<(typeof PAGE_TEXT_ACTIONS)[number], string> = {
    insert: '插入文字',
    'page-number': '写页码',
    'header-footer': '写页眉页脚',
    bates: '写 Bates 编号',
  }
  const pageText: ToolDefinition = {
    name: 'pdf_text',
    description:
      '在页面上写字（写进内容流，属文档内容：打印会出现、可搜索）：'
      + 'action=insert 在指定位置插入文字；page-number 写页码（{page}/{total}）；'
      + 'header-footer 写页眉/页脚（{page}/{total}/{date}/{filename}）；bates 写递增编号。'
      + '中文自动嵌入系统字体；生成新文件，绝不覆盖源文件。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      action: {
        type: 'string',
        required: true,
        description: 'insert | page-number | header-footer | bates。',
      },
      pages: {
        type: 'string',
        description: '要写哪些页，默认全部；支持 1-3,7 与 odd/even。',
      },
      text: { type: 'string', description: 'insert：要插入的文字（可含 \\n 换行）。' },
      header: { type: 'string', description: 'header-footer：页眉模板，例如 "内部资料 · {date}"。' },
      footer: { type: 'string', description: 'header-footer：页脚模板，例如 "第 {page} / {total} 页"。' },
      position: {
        type: 'string',
        description: '落点：top-left|top-center|top-right|bottom-left|bottom-center|bottom-right|center。'
          + 'insert 默认 center；page-number 默认 bottom-center；bates 默认 bottom-right；header-footer 固定用顶部/底部居中。',
      },
      rect: {
        type: 'object',
        description: 'insert 的位置 {x,y}（pt，原点左下）或 {x,y,width,height}（宽高仅用于汇报）。给了它就不再按 position 算。',
      },
      fontSize: { type: 'number', description: '字号，默认 10。' },
      color: { type: 'string', description: '颜色 #rrggbb，默认 #333333。' },
      marginX: { type: 'number', description: '左右边距（pt），默认 40。' },
      marginY: { type: 'number', description: '上下边距（pt），默认 28。' },
      rotate: { type: 'number', description: '逆时针旋转角度，默认 0。' },
      background: {
        type: 'string',
        description: '底衬颜色（#rrggbb）：给了就在文字下画一个色块，压住花哨背景。',
      },
      start: { type: 'integer', description: 'page-number / bates 的起始编号，默认 1。' },
      prefix: { type: 'string', description: 'bates 前缀。' },
      suffix: { type: 'string', description: 'bates 后缀。' },
      digits: { type: 'integer', description: 'bates 补零位数，默认 6。' },
      output: { type: 'string', description: '输出路径。省略则生成 <名字>-text.pdf。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: `页面写字 ${basename(String(args.path ?? ''))}`,
      kind: 'write',
    }),
    async execute(args) {
      const source = resolveInput(args)
      const actionRaw = String(args.action ?? '').trim()
      if (!PAGE_TEXT_ACTIONS.includes(actionRaw as never)) {
        throw new Error(`未知 action：${actionRaw === '' ? '（空）' : actionRaw}；支持 ${PAGE_TEXT_ACTIONS.join(' / ')}`)
      }
      const action = actionRaw as (typeof PAGE_TEXT_ACTIONS)[number]
      const output = resolveOutput(source, args, '-text', options.workspaceRoot)
      const text = optionalString(args, 'text')
      const header = optionalString(args, 'header')
      const footer = optionalString(args, 'footer')
      const position = optionalString(args, 'position') as TextAnchor | undefined
      const anchors: readonly TextAnchor[] = [
        'top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right', 'center',
      ]
      if (position !== undefined && !anchors.includes(position)) {
        throw new Error(`position "${position}" 不是有效落点；可用：${anchors.join(' / ')}`)
      }
      const color = optionalString(args, 'color') ?? '#333333'
      const background = optionalString(args, 'background')
      const prefix = optionalString(args, 'prefix') ?? ''
      const suffix = optionalString(args, 'suffix') ?? ''
      const fontSize = typeof args.fontSize === 'number' && args.fontSize > 0 ? args.fontSize : 10
      const marginX = typeof args.marginX === 'number' ? args.marginX : 40
      const marginY = typeof args.marginY === 'number' ? args.marginY : 28
      const rotate = typeof args.rotate === 'number' ? args.rotate : 0
      const start = typeof args.start === 'number' && Number.isFinite(args.start) ? Math.floor(args.start) : 1
      const digits = typeof args.digits === 'number' && args.digits > 0 ? Math.floor(args.digits) : 6
      const rectArg = args.rect as { x?: unknown; y?: unknown } | undefined
      const at = rectArg !== undefined && typeof rectArg.x === 'number' && typeof rectArg.y === 'number'
        ? { x: Number(rectArg.x), y: Number(rectArg.y) }
        : undefined
      const pages = optionalString(args, 'pages')

      const missing: string[] = []
      if (action === 'insert' && text === undefined) missing.push('要插入的文字（text）')
      if (action === 'header-footer' && header === undefined && footer === undefined) {
        missing.push('页眉或页脚模板（header / footer）')
      }

      // 模板里出现我们不认识的占位符：如实提示，而不是静默留成 `{xxx}`。
      const templates = [text, header, footer].filter((value): value is string => value !== undefined)
      const known = ['page', 'total', 'date', 'filename', 'bates']
      const unknown = templates.flatMap(template => unknownPlaceholders(template, known))

      const gate = authorize({
        tool: 'pdf_text',
        action,
        parameters: {
          action, pages, text, header, footer, position, at, fontSize, color, marginX, marginY, rotate, background,
          ...(action === 'page-number' || action === 'bates' ? { start } : {}),
          ...(action === 'bates' ? { prefix, suffix, digits } : {}),
        },
        inputs: [source],
        output,
        missing,
        defaults: { fontSize: 10, color: '#333333', marginX: 40, marginY: 28 },
        hints: [
          '页码用 {page}/{total}；页眉页脚还可用 {date}/{filename}；Bates 用 start/prefix/digits',
          'insert 想固定在某个位置就传 rect={x,y}（pt，原点左下）',
        ],
        effects: [
          '不修改源文件，结果写入新的 PDF',
          '写在内容流里（不是注释层）：打印会出现、文本可搜索、可被后续改写',
          ...(unknown.length > 0 ? [`模板里的占位符 ${unknown.map(name => `{${name}}`).join('、')} 不会被替换，会原样写进页面`] : []),
        ],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)

      const doc = await PDFDocument.load(new Uint8Array(await readFile(source)), { updateMetadata: false })
      const pageCount = doc.getPageCount()
      const selected = pageSelection(pages, pageCount)
      if (selected.length === 0) throw new Error('没有选中任何页')
      const today = new Date().toISOString().slice(0, 10)
      // 字体按"将要写的全部文字"挑：含中文就嵌 CJK 字号，纯 ASCII 走内置 Helvetica。
      const sample = templates.join(' ') + ' 0123456789'
      const font = await resolveDrawFont(doc as never, sample)
      let lastText = ''
      for (const [index, pageNumber] of selected.entries()) {
        const page = doc.getPages()[pageNumber - 1]
        if (page === undefined) continue
        const vars = {
          // `{page}` 是"**显示的**页码"：从 `start` 开始、按**选中顺序**递增（与 bates 一致）。
          // 全文档编号时 start=1，于是它就等于真实页号；只选 3 且 start=10 时显示 10。
          page: start + index,
          total: pageCount,
          date: today,
          filename: basename(source),
          bates: formatBates(start + index, { prefix, digits, suffix }),
        }
        const draws: Array<{ text: string; anchor: TextAnchor; at?: { x: number; y: number } }> = []
        if (action === 'insert' && text !== undefined) {
          draws.push({ text: applyTemplate(text, vars), anchor: position ?? 'center', ...(at === undefined ? {} : { at }) })
        } else if (action === 'page-number') {
          draws.push({ text: applyTemplate(text ?? '{page} / {total}', vars), anchor: position ?? 'bottom-center' })
        } else if (action === 'bates') {
          draws.push({ text: vars.bates, anchor: position ?? 'bottom-right' })
        } else {
          if (header !== undefined) {
            draws.push({ text: applyTemplate(header, vars), anchor: position ?? 'top-center' })
          }
          if (footer !== undefined) {
            draws.push({ text: applyTemplate(footer, vars), anchor: position ?? 'bottom-center' })
          }
        }
        for (const spec of draws) {
          drawTextOnPage(page as never, font, {
            text: spec.text,
            size: fontSize,
            colorHex: color,
            anchor: spec.anchor,
            marginX,
            marginY,
            rotate,
            ...(spec.at === undefined ? {} : { at: spec.at }),
            ...(background === undefined ? {} : { background: { colorHex: background, padding: 4 } }),
          })
          lastText = spec.text
        }
      }
      await writeFile(output, await doc.save())
      return {
        text: [
          `已生成：${output}`,
          `${PAGE_TEXT_LABELS[action]}：写了 ${selected.length} 页（第 ${selected[0]}${selected.length > 1 ? `…${selected[selected.length - 1]}` : ''} 页）`
            + `，字号 ${fontSize}pt、颜色 ${color}${background === undefined ? '' : `、底衬 ${background}`}；最后一页写的是「${lastText}」。`,
          ...(unknown.length > 0 ? [`注意：模板里的 ${unknown.map(name => `{${name}}`).join('、')} 不是已知占位符，已原样写入。`] : []),
          '注意：文字写在内容流里（不是注释层），因此可搜索、打印会出现，也能被后续改写。',
        ].join('\n'),
      }
    },
  }

  // ── images（导出页面为图片 / 图片合成 PDF）────────────────────────────────
  const images: ToolDefinition = {
    name: 'pdf_images',
    description:
      '图片与 PDF 互转：action=export 把页面导出成 PNG/JPG（页范围、缩放倍率、JPEG 质量）；'
      + 'action=build 把多张图片按顺序合成一个 PDF（页尺寸 a4/letter/fit、方向、边距）。'
      + '导出写到目录（每页一个文件），合成写成一个 PDF；都不覆盖任何源文件。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', description: 'export 用：源 PDF 路径。' },
      images: {
        type: 'array',
        description: 'build 用：按顺序排列的图片路径（png/jpg），至少 1 张。',
      },
      action: { type: 'string', required: true, description: 'export | build。' },
      pages: { type: 'string', description: 'export 用：要导出哪些页，默认全部；支持 1-3,7 与 odd/even。' },
      format: { type: 'string', description: 'export 用：png（默认）或 jpeg。' },
      scale: { type: 'number', description: 'export 用：渲染倍率，默认 2（1=72dpi，2=144dpi，3=216dpi）。' },
      quality: { type: 'number', description: 'export 用：JPEG 质量 0..1，默认 0.9。' },
      outputDir: { type: 'string', description: 'export 用：输出目录，默认源文件旁的 <名字>-pages/。' },
      pageSize: { type: 'string', description: 'build 用：a4 | letter | fit（默认，页面等于图片尺寸）。' },
      margin: { type: 'number', description: 'build 用：页边距（pt），默认 0。' },
      output: { type: 'string', description: 'build 用：输出的 PDF 路径。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: String(args.action ?? '') === 'build' ? '图片合成 PDF' : `导出页面图片 ${basename(String(args.path ?? ''))}`,
      kind: 'write',
    }),
    async execute(args) {
      const action = String(args.action ?? '').trim()
      if (action !== 'export' && action !== 'build') {
        throw new Error(`未知 action：${action === '' ? '（空）' : action}；支持 export / build`)
      }

      // ── build：图片 → PDF ────────────────────────────────────────────────
      if (action === 'build') {
        const list = Array.isArray(args.images) ? (args.images as unknown[]).map(String) : []
        if (list.length === 0) throw new Error('build 需要 images：按顺序给出至少一张图片路径')
        const outputRaw = optionalString(args, 'output')
        if (outputRaw === undefined) throw new Error('build 需要 output：输出 PDF 路径')
        const output = resolve(outputRaw)
        const margin = typeof args.margin === 'number' && args.margin >= 0 ? args.margin : 0
        const pageSizeRaw = (optionalString(args, 'pageSize') ?? 'fit').toLowerCase()
        if (!['a4', 'letter', 'fit'].includes(pageSizeRaw)) {
          throw new Error(`pageSize "${pageSizeRaw}" 不支持；可用 a4 / letter / fit`)
        }
        const gate = authorize({
          tool: 'pdf_images',
          action: 'build',
          parameters: { images: list, pageSize: pageSizeRaw, margin, output },
          inputs: list,
          output,
          hints: ['顺序就是 images 数组的顺序；想重排就先调整数组'],
          effects: ['不改动任何源图片', `生成 1 个 PDF（${list.length} 页）`],
          ...confirmationArgs(options, args),
        })
        if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
        if (gate.kind === 'refused') throw new Error(gate.message)

        const doc = await PDFDocument.create()
        const sizes: Record<string, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] }
        for (const [index, imagePath] of list.entries()) {
          const full = resolve(imagePath)
          if (!existsSync(full)) throw new Error(`第 ${index + 1} 张图片不存在：${imagePath}`)
          const bytes = new Uint8Array(await readFile(full))
          const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
          const embedded = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
          if (pageSizeRaw === 'fit') {
            const page = doc.addPage([embedded.width + margin * 2, embedded.height + margin * 2])
            page.drawImage(embedded, { x: margin, y: margin, width: embedded.width, height: embedded.height })
          } else {
            const [pw, ph] = sizes[pageSizeRaw]
            const page = doc.addPage([pw, ph])
            const scale = Math.min((pw - margin * 2) / embedded.width, (ph - margin * 2) / embedded.height)
            const width = embedded.width * scale
            const height = embedded.height * scale
            page.drawImage(embedded, { x: (pw - width) / 2, y: (ph - height) / 2, width, height })
          }
        }
        await mkdir(dirname(output), { recursive: true })
        await writeFile(output, await doc.save())
        return {
          text: [
            `已生成：${output}`,
            `合成 ${list.length} 页（${list.map(item => basename(item)).join(' → ')}）。`,
            `页面：${pageSizeRaw === 'fit' ? '等于图片尺寸' : pageSizeRaw.toUpperCase()}，边距 ${margin}pt。`,
            '注意：合成后的文字是图片内容，不可搜索——需要可搜索请对原 PDF 用 pdf_make_searchable。',
          ].join('\n'),
        }
      }

      // ── export：PDF → 图片 ──────────────────────────────────────────────
      const source = resolveInput(args)
      const format = (optionalString(args, 'format') ?? 'png').toLowerCase()
      if (format !== 'png' && format !== 'jpeg') throw new Error(`format "${format}" 不支持；可用 png / jpeg`)
      const scale = typeof args.scale === 'number' && args.scale > 0 && args.scale <= 6 ? args.scale : 2
      const quality = typeof args.quality === 'number' && args.quality > 0 && args.quality <= 1 ? args.quality : 0.9
      const info = await inspectDocument(source)
      if (!info.readable) throw new Error(`${basename(source)} 已加密且没有提供密码，无法渲染导出`)
      const selected = pageSelection(optionalString(args, 'pages'), info.pages)
      const dir = optionalString(args, 'outputDir') === undefined
        ? join(dirname(source), `${basename(source, extname(source))}-pages`)
        : resolve(String(args.outputDir))
      const gate = authorize({
        tool: 'pdf_images',
        action: 'export',
        parameters: { pages: selected, format, scale, quality, outputDir: dir },
        inputs: [source],
        // 导出是一批文件：这里报第一个目标路径；真正的目录在确认单的"影响"里说明。
        output: join(dir, `${basename(source, extname(source))}-p${selected[0]}.${format === 'jpeg' ? 'jpg' : 'png'}`),
        hints: ['想拉高清晰度就把 scale 调大（3 ≈ 216dpi）', '只要某几页就传 pages="1-3"'],
        effects: ['不修改源文件', `在目录里生成 ${selected.length} 个图片文件`, '页面会按 scale 倍率栅格化，文字变成图片'],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)

      const { renderPagePng, renderPageJpeg } = await import('./render.ts')
      await mkdir(dir, { recursive: true })
      const written: string[] = []
      for (const pageNumber of selected) {
        const ext = format === 'jpeg' ? 'jpg' : 'png'
        const target = join(dir, `${basename(source, extname(source))}-p${pageNumber}.${ext}`)
        const bytes = format === 'jpeg'
          ? await renderPageJpeg(source, pageNumber, scale, quality)
          : await renderPagePng(source, pageNumber, scale)
        await writeFile(target, bytes)
        written.push(target)
      }
      return {
        text: [
          `已导出 ${written.length} 张图片到：${dir}`,
          `格式 ${format.toUpperCase()}、倍率 ${scale}${format === 'jpeg' ? `、质量 ${quality}` : ''}；`
            + `例如 ${written.slice(0, 3).map(item => basename(item)).join('、')}${written.length > 3 ? '…' : ''}。`,
          '注意：导出是栅格化（文字变图片、不可搜索）；不修改源文件。',
        ].join('\n'),
      }
    },
  }

  // ── form（列字段 / 填写 / 扁平化）────────────────────────────────────────
  const formTool: ToolDefinition = {
    name: 'pdf_form',
    description:
      '表单：action=list 列出 AcroForm 字段（名字/类型/当前值/可选项）；'
      + 'action=fill 按字段名填值（文本/勾选/单选/下拉/列表）；action=flatten 把表单"压平"成静态内容（不可再编辑，适合归档）。'
      + '填完可以顺带 flatten。字段名不对会报错并列出该文件里真正可用的字段名。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      action: { type: 'string', required: true, description: 'list | fill | flatten。' },
      values: {
        type: 'object',
        description: 'fill 用：{ 字段名: 值 }。文本填字符串；勾选框填 true/false；单选/下拉/列表填选项字符串。',
      },
      flatten: { type: 'boolean', description: 'fill 用：填完顺手压平（默认 false）。' },
      output: { type: 'string', description: 'fill/flatten 用：输出路径，省略则生成 <名字>-form.pdf。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: `表单 ${basename(String(args.path ?? ''))}`,
      kind: String(args.action ?? '') === 'list' ? 'read' : 'write',
    }),
    async execute(args) {
      const source = resolveInput(args)
      const action = String(args.action ?? '').trim()
      if (!['list', 'fill', 'flatten'].includes(action)) {
        throw new Error(`未知 action：${action === '' ? '（空）' : action}；支持 list / fill / flatten`)
      }
      const values = (args.values !== undefined && typeof args.values === 'object' && !Array.isArray(args.values))
        ? args.values as Record<string, unknown>
        : undefined
      const wantFlatten = optionalBoolean(args, 'flatten') === true
      const isWrite = action !== 'list'
      const output = isWrite ? resolveOutput(source, args, '-form', options.workspaceRoot) : undefined

      if (isWrite && action === 'fill' && values === undefined) {
        throw new Error('fill 需要 values：给出 { 字段名: 值 }（先用 action=list 看有哪些字段）')
      }

      const gate = authorize({
        tool: 'pdf_form',
        action,
        parameters: { action, values, flatten: wantFlatten },
        inputs: [source],
        ...(output === undefined ? {} : { output }),
        effects: isWrite
          ? [
              '不修改源文件，结果写入新的 PDF',
              action === 'fill' && !wantFlatten ? '表单域保留可编辑（想变成静态内容就加 flatten=true）' : '表单域会被压平成静态内容，之后不可再编辑',
            ]
          : ['只读，不修改任何文件'],
        hints: ['先用 action=list 看字段名与可选项，再 fill', '归档场景建议 fill + flatten=true'],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)

      const doc = await PDFDocument.load(new Uint8Array(await readFile(source)), { updateMetadata: false })
      const form = doc.getForm()
      const fields = form.getFields()
      const describe = (field: unknown): string => {
        const named = field as { getName(): string }
        if (field instanceof PDFTextField) {
          const value = field.getText()
          return `${named.getName()}｜文本｜${value === undefined || value === '' ? '（空）' : value}`
        }
        if (field instanceof PDFCheckBox) return `${named.getName()}｜勾选框｜${field.isChecked() ? '已勾选' : '未勾选'}`
        if (field instanceof PDFRadioGroup) return `${named.getName()}｜单选｜${field.getSelected() ?? '（未选）'}｜可选 ${field.getOptions().join('/')}`
        if (field instanceof PDFDropdown) return `${named.getName()}｜下拉｜${(field.getSelected() ?? []).join(',') || '（未选）'}｜可选 ${field.getOptions().join('/')}`
        if (field instanceof PDFOptionList) return `${named.getName()}｜列表｜${(field.getSelected() ?? []).join(',') || '（未选）'}｜可选 ${field.getOptions().join('/')}`
        return `${named.getName()}｜其他（${(field as object).constructor.name}）`
      }

      if (action === 'list') {
        if (fields.length === 0) return { text: `${basename(source)}：没有表单域（AcroForm 为空）。` }
        return {
          text: [
            `${basename(source)}：${fields.length} 个表单域`,
            ...fields.map(field => `  ${describe(field)}`),
            '字段名就是 fill 的 values 里的键；可选项来自上面列出的"可选"。',
          ].join('\n'),
        }
      }

      // fill：字段名必须先校验，错了就把可用字段名列出来（不静默跳过）。
      const applied: string[] = []
      if (action === 'fill' && values !== undefined) {
        const known = new Map(fields.map(field => [(field as { getName(): string }).getName(), field]))
        const unknown = Object.keys(values).filter(name => !known.has(name))
        if (unknown.length > 0) {
          throw new Error(
            `这些字段不存在：${unknown.join('、')}。`
            + `该文件可用的字段名：${[...known.keys()].join('、') || '（没有表单域）'}`,
          )
        }
        for (const [name, raw] of Object.entries(values)) {
          const field = known.get(name)
          const value = String(raw)
          if (field instanceof PDFTextField) field.setText(value)
          else if (field instanceof PDFCheckBox) { if (raw === true || value === 'true' || value === '是') field.check(); else field.uncheck() }
          else if (field instanceof PDFRadioGroup) field.select(value)
          else if (field instanceof PDFDropdown) field.select(value)
          else if (field instanceof PDFOptionList) field.select(value)
          else throw new Error(`字段 "${name}" 的类型暂不支持填写（只支持文本/勾选框/单选/下拉/列表）`)
          applied.push(`${name}=${raw === true ? '已勾选' : raw === false ? '未勾选' : value}`)
        }
      }
      // 中文/非 Latin-1 的值：pdf-lib 默认用 Helvetica 画字段外观，会抛
      // "WinAnsi cannot encode …"。这里在填完后用我们自己的 CJK 字体重刷一遍外观，
      // 中文表单才填得进去（这是真实需求，不是可选项）。
      const needsCjk = applied.some(item => /[^\x00-\xff]/.test(item))
      if (action === 'fill' && needsCjk) {
        const cjk = await resolveFontForText('中文')
        if (cjk !== null) {
          if (typeof (doc as { registerFontkit?: unknown }).registerFontkit === 'function') {
            const fontkit = await loadFontkitAdapter()
            if (fontkit !== null) (doc as unknown as { registerFontkit(a: unknown): void }).registerFontkit(fontkit)
          }
          const embedded = await doc.embedFont(cjk.bytes, { subset: true })
          form.updateFieldAppearances(embedded as never)
        }
      }
      if (wantFlatten || action === 'flatten') form.flatten()
      await writeFile(output as string, await doc.save())
      return {
        text: [
          `已生成：${output}`,
          action === 'fill'
            ? `填了 ${applied.length} 个字段：${applied.join('；')}${wantFlatten ? '，并已压平（不可再编辑）' : ''}。`
            : '已把表单压平成静态内容（不可再编辑）。',
          '注意：压平后的内容成为页面普通内容，无法再作为表单填写；需要保留可填写请用 action=fill（不加 flatten）。',
        ].join('\n'),
      }
    },
  }

  // ── layout（统一尺寸/缩放 / N-up / 小册子）──────────────────────────────
  const layout: ToolDefinition = {
    name: 'pdf_layout',
    description:
      '版面重排：action=resize 把页面等比缩放到统一纸张（文字仍可搜索）；'
      + 'action=nup 每张纸放 2/4/6/8/9 页（拼版省纸）；action=booklet 按骑马钉顺序生成对折小册子的版面。'
      + '注意：缩放只作用于内容，注释/表单域不会跟着缩放；nup/booklet 用嵌入页面的方式实现，源页注释不会带过去。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      action: { type: 'string', required: true, description: 'resize | nup | booklet。' },
      pageSize: {
        type: 'string',
        description: '目标纸张：a3/a4/a5/letter/legal，可加 -landscape/-portrait。'
          + '默认 a4；booklet 默认 a4-landscape（一张 A4 横放两页）。',
      },
      margin: { type: 'number', description: '页边距（pt），默认 nup/booklet 12、resize 0。' },
      gap: { type: 'number', description: 'nup/booklet：格子间距（pt），默认 8。' },
      mode: { type: 'string', description: 'resize 用：fit（默认，保持长宽比）或 stretch（拉伸，会变形）。' },
      perSheet: { type: 'integer', description: 'nup 用：每张纸几页，可用 2/4/6/8/9，默认 2。' },
      pages: { type: 'string', description: 'resize 用：只处理这些页，默认全部（支持 1-3,7 与 odd/even）。' },
      output: { type: 'string', description: '输出路径，省略则生成 <名字>-layout.pdf。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: `版面重排 ${basename(String(args.path ?? ''))}`,
      kind: 'write',
    }),
    async execute(args) {
      const source = resolveInput(args)
      const action = String(args.action ?? '').trim()
      if (!['resize', 'nup', 'booklet'].includes(action)) {
        throw new Error(`未知 action：${action === '' ? '（空）' : action}；支持 resize / nup / booklet`)
      }
      const output = resolveOutput(source, args, '-layout', options.workspaceRoot)
      const bytes = new Uint8Array(await readFile(source))
      const probe = await PDFDocument.load(bytes, { updateMetadata: false })
      const pageCount = probe.getPageCount()
      const annots = countAnnotsPerPage(probe)
      const defaultSize = action === 'booklet' ? 'a4-landscape' : 'a4'
      const target = parseTargetSize(optionalString(args, 'pageSize') ?? defaultSize)
      const margin = typeof args.margin === 'number' && args.margin >= 0
        ? args.margin
        : (action === 'resize' ? 0 : 12)
      const gap = typeof args.gap === 'number' && args.gap >= 0 ? args.gap : 8
      const mode = (optionalString(args, 'mode') ?? 'fit').toLowerCase()
      if (action === 'resize' && mode !== 'fit' && mode !== 'stretch') {
        throw new Error(`mode "${mode}" 不支持；可用 fit / stretch`)
      }
      const perSheet = action === 'nup'
        ? (typeof args.perSheet === 'number' ? Math.floor(args.perSheet) : 2)
        : 2
      const selected = action === 'resize' ? pageSelection(optionalString(args, 'pages'), pageCount) : undefined

      const gate = authorize({
        tool: 'pdf_layout',
        action,
        parameters: {
          action,
          pageSize: optionalString(args, 'pageSize') ?? defaultSize,
          target,
          margin,
          ...(action === 'nup' || action === 'booklet' ? { gap } : {}),
          ...(action === 'resize' ? { mode, pages: selected } : {}),
          ...(action === 'nup' ? { perSheet } : {}),
        },
        inputs: [source],
        output,
        hints: [
          'resize 只改页面尺寸与缩放，不改内容；要"裁剪"用 pdf_crop（不缩放）',
          'booklet 生成的是"打印后对折"的版面：一张纸两页，正反面交替',
        ],
        effects: [
          '不修改源文件，结果写入新的 PDF',
          action === 'resize'
            ? `把每页内容等比缩放到 ${target[0].toFixed(0)}×${target[1].toFixed(0)}pt 并居中（文字仍可搜索）`
            : `每张纸放 ${perSheet} 页 / 对折版面，共 ${action === 'nup' ? Math.ceil(pageCount / perSheet) : bookletSheets(pageCount).length} 张`,
          ...(annots > 0
            ? [action === 'resize'
                ? `注意：本文件有 ${annots} 个注释/表单域，它们的位置**不会**跟着缩放（内容会缩，注释还在原坐标）`
                : `注意：本文件有 ${annots} 个注释/表单域，拼版（嵌入页面）**不会**把它们带过去`]
            : []),
        ],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)

      if (action === 'resize') {
        const result = await resizePages(bytes, { target, margin, mode: mode as 'fit' | 'stretch', pages: selected })
        await writeFile(output, result.bytes)
        return {
          text: [
            `已生成：${output}`,
            `把 ${result.resized.length} 页缩放到 ${target[0].toFixed(0)}×${target[1].toFixed(0)}pt`
              + `（${mode === 'fit' ? '保持长宽比、可能留白' : '拉伸填满'}，边距 ${margin}pt）。`,
            ...(annots > 0 ? [`注意：${annots} 个注释/表单域的位置没有跟着缩放，请核对。`] : []),
            '注意：内容是缩放而不是裁剪——文字/矢量保持原生，仍可搜索与改写。',
          ].join('\n'),
        }
      }

      const sheets = action === 'booklet'
        ? bookletSheets(pageCount)
        : undefined
      const result = await nupPages(bytes, {
        perSheet,
        target,
        margin,
        gap,
        ...(sheets === undefined ? {} : { sheets }),
      })
      await writeFile(output, result.bytes)
      return {
        text: [
          `已生成：${output}`,
          action === 'booklet'
            ? `骑马钉小册子：源 ${pageCount} 页 → ${result.sheets} 个"面"（每面 2 页，打印后对折装订）。`
            : `拼版：源 ${pageCount} 页 → ${result.sheets} 张纸（每张 ${perSheet} 页）。`,
          `纸张 ${target[0].toFixed(0)}×${target[1].toFixed(0)}pt，边距 ${margin}pt、间距 ${gap}pt。`,
          ...(annots > 0 ? [`注意：${annots} 个注释/表单域没有带过去（拼版走嵌入页面）。`] : []),
          '注意：拼版后的页面是嵌入的页面对象，文字仍可提取，但不能再用文字工具逐块改写。',
        ].join('\n'),
      }
    },
  }

  // ── metadata（文档属性 + 大纲/书签）──────────────────────────────────────
  const metadata: ToolDefinition = {
    name: 'pdf_metadata',
    description:
      '文档信息：action=get 读属性（标题/作者/主题/关键词/创建者/生成器）；action=set 写属性；action=clear 清除属性与编辑时间；'
      + 'action=outline-list 列出书签（含目标页）；action=outline-set 用「标题 → 页码」生成书签；action=outline-clear 删除书签。'
      + 'get / outline-list 是只读；其余会写盘（走确认门控）。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      action: {
        type: 'string',
        required: true,
        description: 'get | set | clear | outline-list | outline-set | outline-clear。',
      },
      values: {
        type: 'object',
        description: 'set 用：{ title, author, subject, keywords, creator, producer } 里要写的字段（支持中文）。',
      },
      outline: {
        type: 'array',
        description: 'outline-set 用：[{ "title": "第一章", "page": 1 }, …]，按数组顺序排列（扁平一层）。',
      },
      output: { type: 'string', description: '写操作输出路径，省略则生成 <名字>-meta.pdf。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: `文档信息 ${basename(String(args.path ?? ''))}`,
      kind: String(args.action ?? '').startsWith('get') || String(args.action ?? '') === 'outline-list' ? 'read' : 'write',
    }),
    async execute(args) {
      const source = resolveInput(args)
      const action = String(args.action ?? '').trim()
      const readOnly = action === 'get' || action === 'outline-list'
      if (!['get', 'set', 'clear', 'outline-list', 'outline-set', 'outline-clear'].includes(action)) {
        throw new Error(`未知 action：${action === '' ? '（空）' : action}；支持 get / set / clear / outline-list / outline-set / outline-clear`)
      }
      const values = (args.values !== undefined && typeof args.values === 'object' && !Array.isArray(args.values))
        ? args.values as Partial<Record<MetadataField, string>>
        : undefined
      const outlineRaw = Array.isArray(args.outline) ? args.outline as Array<{ title?: unknown; page?: unknown }> : undefined
      if (action === 'set' && (values === undefined || Object.keys(values).length === 0)) {
        throw new Error(`set 需要 values：{ ${METADATA_FIELDS.join(' / ')} } 里至少一个字段`)
      }
      if (action === 'outline-set' && (outlineRaw === undefined || outlineRaw.length === 0)) {
        throw new Error('outline-set 需要 outline：[{ "title": "第一章", "page": 1 }, …]')
      }
      const output = readOnly ? undefined : resolveOutput(source, args, '-meta', options.workspaceRoot)

      const gate = authorize({
        tool: 'pdf_metadata',
        action,
        parameters: { action, values, outline: outlineRaw },
        inputs: [source],
        ...(output === undefined ? {} : { output }),
        effects: readOnly
          ? ['只读，不修改任何文件']
          : action === 'clear'
            ? ['不修改源文件，结果写入新的 PDF', '清除标题/作者等属性与创建/修改时间（用于对外发布前去掉隐私信息）']
            : action.startsWith('outline')
              ? ['不修改源文件，结果写入新的 PDF', '按数组顺序生成扁平书签（只支持一层）']
              : ['不修改源文件，结果写入新的 PDF', '属性支持中文（写入时用 UTF-16 编码）'],
        hints: ['对外发布前用 action=clear 去掉作者/标题等隐私信息', '书签只支持一层：要嵌套就分几次做（当前版本未实现嵌套）'],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)

      const doc = await PDFDocument.load(new Uint8Array(await readFile(source)), { updateMetadata: false })
      if (action === 'get') {
        const info = readMetadata(doc)
        const lines = [`${basename(source)}：${info.pages} 页`]
        for (const field of METADATA_FIELDS) {
          lines.push(`  ${field}：${info.fields[field] ?? '（空）'}`)
        }
        const outline = listOutline(doc)
        lines.push(outline.length === 0 ? '  书签：无' : `  书签：${outline.length} 条（用 action=outline-list 看明细）`)
        return { text: lines.join('\n') }
      }
      if (action === 'outline-list') {
        const outline = listOutline(doc)
        if (outline.length === 0) return { text: `${basename(source)}：没有书签。` }
        return {
          text: [
            `${basename(source)}：${outline.length} 条书签`,
            ...outline.map(entry => `  ${'  '.repeat(entry.depth)}${entry.title} → 第 ${entry.page} 页`),
          ].join('\n'),
        }
      }
      if (action === 'set' && values !== undefined) {
        const applied = applyMetadata(doc, values)
        await writeFile(output as string, await doc.save())
        return {
          text: [
            `已生成：${output}`,
            `写入 ${applied.length} 个属性：${applied.map(field => `${field}=${values[field]}`).join('；')}。`,
            '注意：中文用 UTF-16 编码写入，阅读器里显示正常；属性是文档级信息，不影响页面内容。',
          ].join('\n'),
        }
      }
      if (action === 'clear') {
        clearMetadata(doc)
        await writeFile(output as string, await doc.save())
        return {
          text: [
            `已生成：${output}`,
            `已清空 ${METADATA_FIELDS.length} 个属性并删除创建/修改时间。`,
            '注意：这只清 Info 字典里的属性；页面内容、注释、表单里的信息不受影响。',
          ].join('\n'),
        }
      }
      if (action === 'outline-set' && outlineRaw !== undefined) {
        const entries = outlineRaw.map(item => {
          const title = String(item.title ?? '').trim()
          const page = Number(item.page)
          if (title === '' || !Number.isFinite(page) || page < 1) {
            throw new Error('outline 每一项都要有 title（非空）与 page（1 起的页码）')
          }
          return { title, page: Math.floor(page) }
        })
        const count = setOutline(doc, entries)
        await writeFile(output as string, await doc.save())
        return {
          text: [
            `已生成：${output}`,
            `生成了 ${count} 条书签：${entries.map(entry => `${entry.title}→第${entry.page}页`).join('、')}。`,
            '注意：当前只支持**一层**书签（按 given 顺序排列）；嵌套大纲未实现。',
          ].join('\n'),
        }
      }
      clearOutline(doc)
      await writeFile(output as string, await doc.save())
      return {
        text: [
          `已生成：${output}`,
          '已删除全部书签（目录里不再有 /Outlines）。',
          '注意：删除的是书签，不影响页面内容。',
        ].join('\n'),
      }
    },
  }

  // ── redact（矩形密文：真删除）────────────────────────────────────────────
  const redact: ToolDefinition = {
    name: 'pdf_redact',
    description:
      '矩形密文：把指定矩形里的**文字从内容流里真删掉**（不是画黑框遮住——遮住的还能复制/搜索出来），再补色块；'
      + '落在框里的注释也一并删除。action=preview 先空跑报告会删掉什么，action=apply 真删并写盘。'
      + '扫描件（整页图片）的内容无法修补，会在结果里如实说明。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      action: { type: 'string', description: 'preview（默认，空跑报告）| apply（真删并写盘）。' },
      rects: {
        type: 'array',
        description: '要涂掉的矩形：[{ "page": 1, "x": 60, "y": 700, "width": 200, "height": 20 }, …]（pt，原点左下）。',
      },
      color: { type: 'string', description: '色块颜色 #rrggbb，默认 #000000。' },
      output: { type: 'string', description: 'apply 的输出路径，省略则生成 <名字>-redacted.pdf。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: `密文涂黑 ${basename(String(args.path ?? ''))}`,
      kind: String(args.action ?? 'preview') === 'apply' ? 'write' : 'read',
    }),
    async execute(args) {
      const source = resolveInput(args)
      const action = (optionalString(args, 'action') ?? 'preview').toLowerCase()
      if (action !== 'preview' && action !== 'apply') {
        throw new Error(`未知 action：${action}；支持 preview / apply`)
      }
      const rawRects = Array.isArray(args.rects) ? args.rects as Array<Record<string, unknown>> : []
      if (rawRects.length === 0) {
        throw new Error('需要 rects：[{ page, x, y, width, height }, …]（pt，原点左下；可以先用 pdf_extract_text 看坐标）')
      }
      const boxes: RedactBox[] = rawRects.map(item => {
        const page = Number(item.page)
        const x = Number(item.x)
        const y = Number(item.y)
        const width = Number(item.width)
        const height = Number(item.height)
        if (![page, x, y, width, height].every(Number.isFinite) || page < 1 || width <= 0 || height <= 0) {
          throw new Error('rects 每一项都需要 page（≥1）与 x/y/width/height（数字，宽高为正）')
        }
        return { page: Math.floor(page), x, y, width, height }
      })
      const color = optionalString(args, 'color') ?? '#000000'
      const isApply = action === 'apply'
      const output = isApply ? resolveOutput(source, args, '-redacted', options.workspaceRoot) : undefined
      const gate = authorize({
        tool: 'pdf_redact',
        action,
        parameters: { action, rects: boxes, color },
        inputs: [source],
        ...(output === undefined ? {} : { output }),
        effects: isApply
          ? [
              '不修改源文件，结果写入新的 PDF',
              `把 ${boxes.length} 个矩形里的文字**从内容流删除**（复制/搜索/提取都拿不到），并补 ${color} 色块`,
              '落在框里的注释一并删除',
            ]
          : ['空跑：只报告会删掉什么，不写任何文件'],
        hints: ['先用 pdf_extract_text 拿到精确坐标，再 preview 确认，最后 apply', '坐标是 pt、原点左下（与 pdf_crop 的 box 同一套）'],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)

      // 先读出"每个框里原本有哪些文字"（来自文字层），交给核心按**内容**匹配删除。
      const targetsByPage = new Map<number, string[]>()
      const targetLineByPage = new Map<number, string[]>()
      const targetRectsByPage = new Map<number, Array<{ x: number; y: number; width: number; height: number }>>()
      {
        const probe = await openPdf(source)
        try {
          // 先把页号校验掉：越界要在"取文字层"之前给出明确中文错误，
          // 否则会被 pdf.js 的内部报错抢先，用户看不懂。
          const pageCount = probe.numPages
          for (const box of boxes) {
            if (box.page > pageCount) throw new Error(`密文框指定了第 ${box.page} 页，但文档只有 ${pageCount} 页`)
          }
          for (const pageNumber of [...new Set(boxes.map(box => box.page))]) {
            const lines = await extractTextLayer(probe, pageNumber)
            const targets: string[] = []
            const allLines: string[] = []
            const targetRects: Array<{ x: number; y: number; width: number; height: number }> = []
            for (const line of lines) {
              const text = line.text.trim()
              if (text.length === 0) continue
              allLines.push(text)
              const hit = boxes.some(box => box.page === pageNumber
                && line.rect.x < box.x + box.width && box.x < line.rect.x + line.rect.width
                && line.rect.y < box.y + box.height && box.y < line.rect.y + line.rect.height)
              if (hit) {
                targets.push(text)
                targetRects.push({ x: line.rect.x, y: line.rect.y, width: line.rect.width, height: line.rect.height })
              }
            }
            targetsByPage.set(pageNumber, targets)
            targetRectsByPage.set(pageNumber, targetRects)
            targetLineByPage.set(pageNumber, allLines)
          }
        } finally {
          await probe.dispose()
        }
      }
      const result = await redactPages(new Uint8Array(await readFile(source)), { boxes, color, targetsByPage, targetLinesByPage: targetRectsByPage })

      // **强制复核**：密文最容易出的错是"报告删掉了、其实还能提取出来"。
      // 所以写盘之前，对每个矩形做一次"框内文字是否还在"的对照：
      // 框内原本能提取到的文字，若在结果里仍然能提取到，就**拒绝输出**并说清原因——
      // 宁可明确失败，也不能给出一个看起来涂黑了、实际还能复制的假密文。
      if (isApply) {
        const insideBox = (line: { rect: { x: number; y: number; width: number; height: number } }, box: RedactBox) =>
          line.rect.x < box.x + box.width && box.x < line.rect.x + line.rect.width
          && line.rect.y < box.y + box.height && box.y < line.rect.y + line.rect.height
        const beforeDoc = await openPdf(source)
        // pdf.js 会 **transfer**（分离）传给它的缓冲区：复核必须用副本，
        // 否则随后的 writeFile(result.bytes) 会抛 detached ArrayBuffer。
        const afterDoc = await openPdfBytes(new Uint8Array(result.bytes))
        const leftovers: string[] = []
        try {
          for (const pageNumber of [...new Set(boxes.map(box => box.page))]) {
            const pageBoxes = boxes.filter(box => box.page === pageNumber)
            const beforeLines = await extractTextLayer(beforeDoc, pageNumber)
            const afterLines = await extractTextLayer(afterDoc, pageNumber)
            for (const box of pageBoxes) {
              const targets = beforeLines.filter(line => insideBox(line, box) && line.text.trim().length > 1)
              for (const target of targets) {
                const still = afterLines.some(line => insideBox(line, box) && line.text.includes(target.text.slice(0, 12)))
                if (still) leftovers.push(`第 ${pageNumber} 页「${target.text.slice(0, 24)}」`)
              }
            }
          }
          // 第二道护栏：**误删**别的行同样不可接受（密文工具最容易"顺手删掉半页"）。
          // 注意：它必须留在 `try` 里——文档在 `finally` 里就 dispose 了，
          // 放到外面会变成"对已释放的文档取页"（实测崩在 pdf.js 的 getPage）。
            if (leftovers.length === 0) {
            for (const pageNumber of [...new Set(boxes.map(box => box.page))]) {
              const beforeLines = (await extractTextLayer(beforeDoc, pageNumber)).map(line => line.text.trim()).filter(text => text.length > 0)
              const afterLines = (await extractTextLayer(afterDoc, pageNumber)).map(line => line.text.trim()).filter(text => text.length > 0)
              const targets = targetsByPage.get(pageNumber) ?? []
              const collateral = beforeLines.filter(text => !targets.includes(text) && !afterLines.includes(text))
              if (collateral.length > 0) {
                throw new Error(
                  `密文会影响框外内容，已拒绝输出：第 ${pageNumber} 页的「${collateral.slice(0, 3).join('、')}」等 ${collateral.length} 行本不该被删。`
                    + '请把矩形缩到刚好覆盖目标文字，或改用"导出图片→涂黑→重新合成"的方式。',
                  )
                }
              }
            }
        } finally {
          await beforeDoc.dispose()
          await afterDoc.dispose()
        }
        if (leftovers.length > 0) {
          throw new Error(
            `密文未真正生效，已拒绝输出：${leftovers.slice(0, 3).join('、')}${leftovers.length > 3 ? ` 等 ${leftovers.length} 处` : ''} 仍能被提取出来。`
            + '原因通常是这一页的文字分散在多个内容流/嵌套结构里，本次改写没有覆盖到。'
            + '这属于本工具的已知限制（不做"看起来涂黑了其实还能复制"的假密文）。'
            + (result.report.imagePages.length > 0
                ? `
另外：第 ${result.report.imagePages.join('、')} 页含整页图片（扫描件/图片层）——`
                  + '本工具按纪律（不做图片内容修补）不会去改图片像素，'
                  + '即使删掉了叠在上面的 OCR 文字，画面也可能原样可见。'
                : '')
            + '\n可靠做法：pdf_images action=export 导出这几页 → 在图片上涂黑 → pdf_images action=build 重新合成。',
          )
        }
      }
      const summary = [
        `删掉文字指令 ${result.report.removedShows} 条、注释 ${result.report.removedAnnots} 个、矢量路径 ${result.report.removedPaths} 条。`,
        ...(result.report.imageOnlyPages.length > 0
          ? [`注意：第 ${result.report.imageOnlyPages.join('、')} 页没有文字层（扫描件），**图片里的内容无法修补**，这里只做了视觉遮盖——要真安全请改用"导出这些页的图片→涂黑→重新合成"，或干脆不发布这几页。`]
          : []),
        '注意：文字已从内容流删除（可用 pdf_extract_text 复核）；但字体子集里的字形轮廓未清理，'
          + '需要更强保证时应当只发布导出的图片版。',
        ...(result.report.imagePages.length > 0
          ? [`注意：第 ${result.report.imagePages.join('、')} 页含图片对象——文字层删了，但**图片像素里的内容不会被修补**`
            + '（若这几页是扫描件，请核对是否仍能看出敏感信息）。']
          : []),
      ]
      if (!isApply) {
        return { text: [`（空跑，未写入文件）`, ...summary].join('\n') }
      }
      await writeFile(output as string, result.bytes)
      return { text: [`已生成：${output}`, ...summary].join('\n') }
    },
  }

  // ── optimize（体积/结构优化）────────────────────────────────────────────
  const optimize: ToolDefinition = {
    name: 'pdf_optimize',
    description:
      '体积与结构优化（走 qpdf 重写对象层）：profile=gc 垃圾回收（对象流 + 重压缩 + 清理未引用资源）、'
      + 'linearize 线性化（Web 快速打开）、both 两者都做。会同时给出优化前后字节数——'
      + '实测：图片占主导时可能只省 ~2%，也可能不变甚至略增（对象流本身有开销）；想大幅变小请走 pdf_images 导出 JPEG。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      profile: { type: 'string', description: 'gc（默认）| linearize | both。' },
      other: { type: 'string', description: 'compare 用：另一份 PDF 的路径（与 path 比对）。' },
      output: { type: 'string', description: '输出路径。省略则生成 <名字>-optimized.pdf。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: `优化 ${basename(String(args.path ?? ''))}`,
      kind: 'write',
    }),
    async execute(args) {
      const source = resolveInput(args)
      const profileRaw = (optionalString(args, 'profile') ?? 'gc').toLowerCase()
      if (!['gc', 'linearize', 'both', 'compare'].includes(profileRaw)) {
        throw new Error(`profile "${profileRaw}" 不支持；可用 gc / linearize / both / compare`)
      }

      // ── compare：两版差异（只读，不写盘、不弹确认单）────────────────────
      if (profileRaw === 'compare') {
        const otherRaw = optionalString(args, 'other')
        if (otherRaw === undefined) throw new Error('compare 需要 other：给出另一份 PDF 的路径')
        const other = resolve(otherRaw)
        if (!existsSync(other)) throw new Error(`另一份文件不存在：${other}`)
        const mine = new Uint8Array(await readFile(source))
        const theirs = new Uint8Array(await readFile(other))
        const gate = authorize({
          tool: 'pdf_optimize',
          action: 'compare',
          parameters: { other },
          inputs: [source, other],
          effects: ['只读：只比对文字层，不修改任何文件'],
          hints: ['差异以文字层为准；扫描件会如实报告"无法比对"'],
          ...confirmationArgs(options, args),
        })
        if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
        if (gate.kind === 'refused') throw new Error(gate.message)
        const compared = await comparePdfs(mine, theirs)
        return { text: renderCompareReport(basename(source), basename(other), compared) }
      }

      const profile = profileRaw as OptimizeProfile
      const output = resolveOutput(source, args, '-optimized', options.workspaceRoot)
      const bytes = new Uint8Array(await readFile(source))
      const gate = authorize({
        tool: 'pdf_optimize',
        action: profile,
        parameters: { profile },
        inputs: [source],
        output,
        effects: [
          '不修改源文件，结果写入新的 PDF',
          profile === 'linearize'
            ? '重排为线性化结构（Web 上可先看第一页）'
            : profile === 'gc'
              ? '重写对象层：生成对象流、重压缩流、清理未引用资源（页面内容不变）'
              : '先垃圾回收再线性化',
          '注意：这是对象层重写，**不改变页面内容**；想大幅减小体积请用 pdf_images 导出为 JPEG',
        ],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)

      const result = await optimizePdf(bytes, profile)
      await writeFile(output, result.bytes)
      const saving = describeSaving(bytes.length, result.bytes.length)
      const qpdfCheck = await runQpdf(['--check'], result.bytes, 'read-only')
      return {
        text: [
          `已生成：${output}`,
          `profile=${profile}（${profile === 'linearize' ? '线性化' : profile === 'gc' ? '垃圾回收' : '垃圾回收 + 线性化'}）：${saving.text}。`,
          `结构校验：qpdf --check exit ${qpdfCheck.exit}${qpdfCheck.exit === 0 ? '（通过）' : '（有问题，请勿使用）'}。`,
          '说明：优化只重写对象层，页面内容/文字/注释都不变。若体积没降（甚至略增），通常是因为图片已经压过、'
            + '而对象流本身有额外开销——这种情况请直接用源文件，不要用这次的结果。',
        ].join('\n'),
      }
    },
  }

  // ── split 2-up（页级装配）─────────────────────────────────────────────────
  //
  // 把 A3 试卷对半切成 A4 是页级装配里最容易做错的一件：渲染再切会丢文字层、字体与矢量。
  // 这里只改页面框 + 在内容流最前面插一条平移，切完的文字仍然可以搜索、复制。
  const split: ToolDefinition = {
    name: 'pdf_split',
    description:
      '把 2-up（一张纸印两页）的 PDF 对半切成单页：'
      + '只要页面 /Rotate 为 0 且长宽比明显偏离 1（≥1.25）就能拆——A3 试卷、'
      + '720×405pt 的「答案版 + 空白版并排」讲义都可以，与纸张尺寸无关；'
      + '只改页面框并平移内容流，不栅格化、也不缩放，切出来的页面文字仍可搜索、可复制。'
      + 'layout 默认 auto（按页面方向推断）；keep 默认 both（两半都留），'
      + '也可以只留一半：left/right 用于左右排列，top/bottom 用于上下排列——'
      + '「左=答案版 / 右=空白版」的讲义用 keep=right 直接得到只含空白题的册子，不必先拆再删。'
      + 'keep 与切法不匹配（例如左右排列传 top）的页会被跳过并给出中文原因。'
      + 'targetSize 默认 a4，**只做信息提示**：'
      + '切出的每半如果不是 A4（210×297pt）会在确认单与结果里写明，但不会因此拒绝执行。'
      + '旋转页、比例接近 1 的页面、方向与 layout 不一致的页会被跳过，并在结果里逐页给出中文原因。'
      + 'gutter=middle（默认）严格按中线切；gutter=auto 会低倍渲染，按「左右内容框的间隔」找中缝'
      + '（间隔 ≥ 8pt 才算找到），找不到或偏离中线 > 15% 就回退中线并说明。'
      + '生成新文件，绝不覆盖源文件。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      layout: {
        type: 'string',
        enum: ['auto', 'left-right', 'top-bottom'],
        description: '切法：auto（默认）按页面方向推断；left-right 左右切；top-bottom 上下切。',
      },
      keep: {
        type: 'string',
        enum: ['both', 'left', 'right', 'top', 'bottom'],
        description: '保留哪一半：both（默认）两半都留；left/right 只留左半/右半；top/bottom 只留上半/下半。',
      },
      gutter: {
        type: 'string',
        enum: ['middle', 'auto'],
        description: '切分线：middle（默认）严格中线；auto 渲染找两栏之间的中缝（≥8pt），找不到回退中线。',
      },
      pages: { type: 'string', description: '要拆的页，例如 "1-3,7"；省略则全部页。' },
      targetSize: {
        type: 'string',
        enum: ['a4', 'keep'],
        description: 'a4（默认）只做提示：切出的每半若不是 210×297pt（±3pt）会在结果里写明；keep 不提示。',
      },
      output: { type: 'string', description: '输出路径。省略则生成 <名字>-split.pdf。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({ card: 'generic', title: `拆分 2-up ${basename(String(args.path ?? ''))}`, kind: 'write' }),
    async execute(args) {
      const source = resolveInput(args)
      const output = resolveOutput(source, args, '-split', options.workspaceRoot)
      const doc = await loadPdfDocument(source)
      const pageCount = doc.getPageCount()
      if (pageCount < 1) throw new Error(`${basename(source)} 没有可拆分的页面`)

      const layoutArg = typeof args.layout === 'string' ? args.layout : 'auto'
      const layout: 'auto' | TwoUpAxis = layoutArg === 'left-right' || layoutArg === 'top-bottom' ? layoutArg : 'auto'
      const gutterMode = args.gutter === 'auto' ? 'auto' : 'middle'
      const targetSize = args.targetSize === 'keep' ? 'keep' : 'a4'
      const keep: SplitKeep = args.keep === 'left' || args.keep === 'right' || args.keep === 'top' || args.keep === 'bottom'
        ? args.keep
        : 'both'
      const pagesSpec = optionalString(args, 'pages')
      const selected = pagesSpec === undefined
        ? Array.from({ length: pageCount }, (_, index) => index)
        : parsePageSelection(pagesSpec, pageCount)

      interface SplitPlan { index: number; axis: TwoUpAxis; gutterPt: number; detection?: GutterDetection }
      const planned: SplitPlan[] = []
      const skipped: Array<{ page: number; reason: string }> = []
      const detections: Array<{ page: number; detection: GutterDetection }> = []
      // targetSize='a4' 时只收集「切出来不是 A4」的事实，用于提示——**不**作为跳过理由。
      const notA4: Array<{ page: number; axis: TwoUpAxis; size: { width: number; height: number } }> = []

      for (const index of selected) {
        const page = doc.getPages()[index]
        if (page === undefined) continue
        const boxes = readPageBoxes(page)
        const classification = classifyTwoUp(page, boxes)
        if (!classification.ok) {
          skipped.push({ page: index + 1, reason: classification.reason ?? '不是可拆的 2-up 页面' })
          continue
        }
        if (layout !== 'auto' && classification.axis !== layout) {
          skipped.push({
            page: index + 1,
            reason: `页面方向是 ${classification.axis}（${boxes.width.toFixed(1)}×${boxes.height.toFixed(1)}pt），与 layout=${layout} 不一致`,
          })
          continue
        }
        if (!keepMatchesAxis(classification.axis, keep)) {
          skipped.push({
            page: index + 1,
            reason: `这一页是${axisLabel(classification.axis)}排列，keep=${keep} 不适用；`
              + `${axisLabel(classification.axis)}排列请用 ${keepOptionsFor(classification.axis)}`,
          })
          continue
        }
        if (targetSize === 'a4' && !isA4Half(classification.halfSize)) {
          notA4.push({ page: index + 1, axis: classification.axis, size: classification.halfSize })
        }
        const extent = classification.axis === 'left-right' ? boxes.visible.width : boxes.visible.height
        if (gutterMode === 'auto') {
          const detection = await detectGutter(source, index + 1, { axis: classification.axis })
          detections.push({ page: index + 1, detection })
          planned.push({ index, axis: classification.axis, gutterPt: detection.gutterPt, detection })
        } else {
          planned.push({ index, axis: classification.axis, gutterPt: extent / 2 })
        }
      }

      const defaults: Record<string, unknown> = {}
      if (args.layout === undefined) defaults.layout = 'auto'
      if (args.keep === undefined) defaults.keep = 'both'
      if (args.gutter === undefined) defaults.gutter = 'middle'
      if (args.targetSize === undefined) defaults.targetSize = 'a4'
      if (pagesSpec === undefined) defaults.pages = `全部 ${pageCount} 页`

      const notes: string[] = []
      for (const { page, detection } of detections) {
        notes.push(detection.fellBack
          ? `第 ${page} 页的切分线检测回退中线：${detection.reason ?? '未找到可靠中缝'}`
          : `第 ${page} 页测到中缝：切分线在 ${detection.gutterPt.toFixed(1)}pt 处（间隔 ${detection.bandWidthPt.toFixed(1)}pt，置信度 ${detection.confidence}）`)
      }
      const mmOf = (pt: number): number => (pt * 25.4) / 72
      const a4Hint = (size: { width: number; height: number }): string =>
        `切出的一页是 ${size.width.toFixed(1)}×${size.height.toFixed(1)}pt`
        + `（${mmOf(size.width).toFixed(0)}×${mmOf(size.height).toFixed(0)}mm），不是 A4（210×297pt）；`
        + '需要 A4 可打印尺寸必须先缩放（当前版本不做缩放）。'
      // 按尺寸归并，避免 20 页时同一句提示刷 20 遍。
      const notA4Groups = new Map<string, { size: { width: number; height: number }; pages: number[] }>()
      for (const item of notA4) {
        const key = `${item.size.width.toFixed(2)}x${item.size.height.toFixed(2)}`
        const group = notA4Groups.get(key) ?? { size: item.size, pages: [] }
        group.pages.push(item.page)
        notA4Groups.set(key, group)
      }
      for (const group of notA4Groups.values()) {
        notes.push(`${a4Hint(group.size)}（涉及第 ${group.pages.join(', ')} 页）`)
      }
      if (skipped.length > 0) {
        notes.push(`将跳过 ${skipped.length} 页不规范页：${skipped.map(item => `第 ${item.page} 页（${item.reason}）`).join('；')}`)
      }

      const refusals: string[] = []
      if (planned.length === 0) {
        refusals.push(`选中的 ${selected.length} 页都不是可拆的 2-up 页面，没有可拆的内容`)
        for (const item of skipped) refusals.push(`第 ${item.page} 页：${item.reason}`)
      }

      const keepEffect = keep === 'both'
        ? `把 ${planned.length} 页拆成 ${planned.length * 2} 页`
        : `每页只保留${keepLabel(keep)}，输出 ${planned.length} 页（不产出另一半）`

      const gate = authorize({
        tool: 'pdf_split',
        action: 'split',
        parameters: { layout, keep, gutter: gutterMode, targetSize, pages: pagesSpec ?? '全部', pageCount },
        inputs: [source],
        output,
        pageCount,
        ...(pagesSpec === undefined ? { wholeDocument: true } : {}),
        defaults,
        notes,
        refusals,
        hints: ['切法不对就说「按上下切」', '只想拆某几页就说「只拆第 1、3 页」', '缝不在正中就用 gutter=auto 测缝', '只要空白版就说「只保留右半」'],
        effects: [
          '不修改源文件，结果写入新的 PDF',
          keepEffect,
          '拆分只改页面框并平移内容流，不栅格化、不缩放（文字仍可搜索）',
        ],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)
      // `force: true` 会跳过门控，所以这里再兜一次：没有可拆的页就绝不做出一份空文件。
      if (planned.length === 0) throw new Error('没有可拆分的 2-up 页面，未生成文件。')

      const out = await PDFDocument.create()
      const produced: Array<{ source: number; axis: TwoUpAxis }> = []
      for (const item of planned) {
        const [copied] = await out.copyPages(doc, [item.index])
        out.addPage(copied)
        if (keep === 'both') {
          splitPageIntoHalves(out, copied, { axis: item.axis, gutterPt: item.gutterPt })
        } else {
          splitPageKeepingHalf(out, copied, { axis: item.axis, gutterPt: item.gutterPt, keep })
        }
        produced.push({ source: item.index + 1, axis: item.axis })
      }
      const bytes = await out.save()
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, bytes)

      const halfNames = (axis: TwoUpAxis): [string, string] => axis === 'left-right' ? ['左', '右'] : ['上', '下']
      const lines = [
        `已生成：${output}`,
        keep === 'both'
          ? `拆了 ${planned.length} 页，得到 ${out.getPageCount()} 页：`
            + produced.map((item, n) => `第 ${item.source} 页 → 输出第 ${n * 2 + 1}、${n * 2 + 2} 页`).join('；')
          : `只保留了每页的${keepLabel(keep)}：共 ${out.getPageCount()} 页（源第 ${produced.map(item => item.source).join(', ')} 页）。`,
      ]
      if (keep === 'both') {
        lines.push(`输出页序：${produced.flatMap(item => halfNames(item.axis).map(half => `第${item.source}页${half}半`)).join(' → ')}`)
      } else {
        lines.push(`每一页只改了页面框，只保留${keepLabel(keep)}的内容；另一半没有被写进输出。`)
      }
      if (skipped.length > 0) {
        lines.push(`跳过 ${skipped.length} 页：${skipped.map(item => `第 ${item.page} 页（${item.reason}）`).join('；')}`)
      }
      if (gutterMode === 'auto') {
        lines.push('切分线（gutter=auto）：' + detections.map(({ page, detection }) => detection.fellBack
          ? `第 ${page} 页回退中线 ${detection.gutterPt.toFixed(1)}pt（${detection.reason ?? ''}）`
          : `第 ${page} 页测到中缝 ${detection.gutterPt.toFixed(1)}pt（间隔 ${detection.bandWidthPt.toFixed(1)}pt，置信度 ${detection.confidence}）`).join('；'))
      } else {
        lines.push('切分线：严格按中线（gutter=middle）。')
      }
      lines.push('注意：源文件未被改动，输出是新文件。')
      if (targetSize === 'a4' && notA4.length > 0) {
        for (const group of notA4Groups.values()) {
          lines.push(`注意：${a4Hint(group.size)}`)
        }
      }
      if (skipped.length > 0) {
        lines.push('注意：被跳过的页面没有写进输出；旋转页请先用 pdf_arrange 的 rotate 处理，比例接近 1 的页面请先确认是不是 2-up 版面。')
      }
      lines.push('注意：拆分只改页面框与内容流平移，页面上的批注/表单域会随页树保留（暂不按半边拆分或删除批注）。')
      return { text: lines.join('\n') }
    },
  }

  // ── crop（批量裁剪）────────────────────────────────────────────────────────
  const crop: ToolDefinition = {
    name: 'pdf_crop',
    description:
      '批量裁剪 PDF 的页面框：只裁不缩，绝不缩放页面内容。'
      + 'mode=fixed（默认）用同一个矩形（box，单位 pt，原点左下；越界会自动收拢并提示）；'
      + 'mode=trim 逐页渲染找内容边界（暗像素包围盒）再加 margin（默认 6pt）留白，'
      + 'uniform（默认 true）时取所有页边界的并集，保证裁完每页尺寸一致。'
      + '默认同时把 /MediaBox 与 /CropBox 设为裁切后区域，setCropBoxOnly=true 则只改 /CropBox。'
      + '生成新文件，绝不覆盖源文件。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      mode: {
        type: 'string',
        enum: ['fixed', 'trim'],
        description: 'fixed（默认）用 box 指定矩形；trim 逐页找内容边界再加 margin。',
      },
      box: {
        type: 'object',
        description: 'mode=fixed 的裁切框（pt，原点左下）：{left,bottom,right,top}。',
        properties: {
          left: { type: 'number', required: true, description: '左边界（pt）。' },
          bottom: { type: 'number', required: true, description: '下边界（pt）。' },
          right: { type: 'number', required: true, description: '右边界（pt）。' },
          top: { type: 'number', required: true, description: '上边界（pt）。' },
        },
      },
      margin: { type: 'number', description: 'mode=trim 的留白（pt），默认 6。' },
      uniform: { type: 'boolean', description: 'mode=trim 是否取所有页边界的并集（保证尺寸一致），默认 true。' },
      setCropBoxOnly: { type: 'boolean', description: '只改 /CropBox、不动 /MediaBox，默认 false（两个都改）。' },
      pages: { type: 'string', description: '要裁的页，例如 "1-3,7"；省略则全部页。' },
      output: { type: 'string', description: '输出路径。省略则生成 <名字>-cropped.pdf。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({ card: 'generic', title: `裁剪 ${basename(String(args.path ?? ''))}`, kind: 'write' }),
    async execute(args) {
      const source = resolveInput(args)
      const output = resolveOutput(source, args, '-cropped', options.workspaceRoot)
      const mode = args.mode === 'trim' ? 'trim' : 'fixed'
      const pagesSpec = optionalString(args, 'pages')
      const margin = typeof args.margin === 'number' && Number.isFinite(args.margin) ? args.margin : 6
      const uniform = args.uniform === undefined ? true : args.uniform === true
      const setCropBoxOnly = args.setCropBoxOnly === true
      if (margin < 0) throw new Error('margin 不能是负数')

      let box: CropBoxInput | undefined
      const missing: string[] = []
      const rawBox = args.box
      if (rawBox !== undefined && rawBox !== null) {
        if (typeof rawBox !== 'object' || Array.isArray(rawBox)) {
          throw new Error('box 必须是 {left,bottom,right,top} 对象（单位 pt）')
        }
        const entry = rawBox as Record<string, unknown>
        const nums = ['left', 'bottom', 'right', 'top'].map(key => Number(entry[key]))
        if (nums.some(value => !Number.isFinite(value))) {
          throw new Error('box 的 left/bottom/right/top 必须都是数字（单位 pt）')
        }
        box = { left: nums[0], bottom: nums[1], right: nums[2], top: nums[3] }
      }
      if (mode === 'fixed' && box === undefined) {
        missing.push('裁切框 box（left/bottom/right/top，单位 pt）')
      }
      if (mode === 'fixed' && box !== undefined) {
        if (box.right <= box.left) throw new Error(`box 无效：right（${box.right}）必须大于 left（${box.left}）`)
        if (box.top <= box.bottom) throw new Error(`box 无效：top（${box.top}）必须大于 bottom（${box.bottom}）`)
      }

      const doc = await loadPdfDocument(source)
      const pageCount = doc.getPageCount()
      if (pageCount < 1) throw new Error(`${basename(source)} 没有可裁剪的页面`)
      const selected = pagesSpec === undefined
        ? Array.from({ length: pageCount }, (_, index) => index)
        : parsePageSelection(pagesSpec, pageCount)

      const defaults: Record<string, unknown> = {}
      if (args.mode === undefined) defaults.mode = 'fixed'
      if (args.margin === undefined) defaults.margin = 6
      if (args.uniform === undefined) defaults.uniform = true
      if (args.setCropBoxOnly === undefined) defaults.setCropBoxOnly = false
      if (pagesSpec === undefined) defaults.pages = `全部 ${pageCount} 页`

      const gate = authorize({
        tool: 'pdf_crop',
        action: 'crop',
        parameters: {
          mode,
          box: box ?? '（缺失）',
          margin,
          uniform,
          setCropBoxOnly,
          pages: pagesSpec ?? '全部',
          pageCount,
        },
        inputs: [source],
        output,
        pageCount,
        ...(pagesSpec === undefined ? { wholeDocument: true } : {}),
        missing,
        defaults,
        hints: ['裁多了就说「上下再多留 20pt」', '扫描件黑边用 mode=trim 自动收', '只想裁某几页就说「只裁第 2 页」'],
        effects: [
          '不修改源文件，结果写入新的 PDF',
          `只改页面框，不缩放内容；处理 ${selected.length} 页`,
          setCropBoxOnly ? '只改 /CropBox' : '同时改 /MediaBox 与 /CropBox',
        ],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)
      if (mode === 'fixed' && box === undefined) throw new Error('mode=fixed 需要 box，未生成文件。')

      const outcomes = await cropPages(doc, selected, {
        mode,
        ...(box === undefined ? {} : { box }),
        margin,
        uniform,
        setCropBoxOnly,
        sourcePath: source,
      })
      const bytes = await doc.save()
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, bytes)

      const formatBox = (value: { x: number; y: number; width: number; height: number }): string =>
        `[${value.x.toFixed(1)}, ${value.y.toFixed(1)}, ${(value.x + value.width).toFixed(1)}, ${(value.y + value.height).toFixed(1)}]`
      const lines = [
        `已生成：${output}`,
        `裁剪 ${outcomes.length} 页（mode=${mode}，margin=${margin}pt，uniform=${String(uniform)}，`
          + `${setCropBoxOnly ? '只改 /CropBox' : '同时改 /MediaBox 与 /CropBox'}），只裁不缩。`,
        ...outcomes.slice(0, 20).map(item =>
          `  第 ${item.page} 页 → ${formatBox(item.box)}（裁掉 ${(item.croppedRatio * 100).toFixed(1)}% 面积）`),
        ...(outcomes.length > 20 ? [`  …其余 ${outcomes.length - 20} 页省略`] : []),
      ]
      const notes = outcomes.flatMap(item => item.notes)
      for (const note of notes.slice(0, 10)) lines.push(`注意：${note}`)
      if (notes.length > 10) lines.push(`注意：另有 ${notes.length - 10} 条收拢提示省略。`)
      lines.push('注意：源文件未被改动，输出是新文件；裁剪不缩放，内容坐标保持原值。')
      if (mode === 'trim') {
        lines.push('注意：trim 的边界来自低倍渲染的暗像素包围盒，浅色内容（很浅的灰底、细彩线）可能不算作内容。')
      }
      return { text: lines.join('\n') }
    },
  }

  // ── arrange（重排页序）────────────────────────────────────────────────────
  const arrange: ToolDefinition = {
    name: 'pdf_arrange',
    description:
      '重排页序：按 order 重新排列页面，可选删除若干页、可选旋转若干页。'
      + 'order 支持显式列表 "1,3,5"、区间 "1-3,7,4-6"，以及预设 odd-even（先所有奇数页、再所有偶数页）/ '
      + 'reverse（逆序）/ swap-pairs（2,1,4,3…）。'
      + 'delete 按**原文件页号**删除（与 order 不能重叠）。'
      + 'rotate 形如 {"pages":"1-3","angle":90}，pages 指**重排后**的页号，只改 /Rotate、不动内容。'
      + '它只改顺序与 /Rotate，不裁剪、不缩放页面几何。生成新文件，绝不覆盖源文件。',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      order: {
        type: 'string',
        description: '页序：1,3,5 / 1-3,7,4-6 / odd-even / reverse / swap-pairs。必填。',
      },
      delete: { type: 'string', description: '要删除的原页号范围，例如 "2,5"；省略则不删除。' },
      rotate: {
        type: 'object',
        description: '可选旋转：{"pages":"1-3","angle":90}；pages 指重排后的页号。',
        properties: {
          pages: { type: 'string', required: true, description: '重排后的页号，例如 "1-3"。' },
          angle: { type: 'number', required: true, description: '旋转角度，90 的倍数。' },
        },
      },
      output: { type: 'string', description: '输出路径。省略则生成 <名字>-arranged.pdf。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({ card: 'generic', title: `重排 ${basename(String(args.path ?? ''))}`, kind: 'write' }),
    async execute(args) {
      const source = resolveInput(args)
      const output = resolveOutput(source, args, '-arranged', options.workspaceRoot)
      const doc = await loadPdfDocument(source)
      const pageCount = doc.getPageCount()
      if (pageCount < 1) throw new Error(`${basename(source)} 没有可重排的页面`)

      const orderSpec = optionalString(args, 'order')
      const deleteSpec = optionalString(args, 'delete')
      const missing: string[] = []
      if (orderSpec === undefined) {
        missing.push('页序 order（例如 1,3,5，或 odd-even / reverse / swap-pairs）')
      }
      const order = orderSpec === undefined ? undefined : parsePageOrder(orderSpec, pageCount)
      const removed = deleteSpec === undefined ? [] : parsePageSelection(deleteSpec, pageCount)
      const removedSet = new Set(removed)
      if (order !== undefined) {
        const clash = order.find(index => removedSet.has(index))
        if (clash !== undefined) {
          throw new Error(`页序里的第 ${clash + 1} 页已被 delete 删除，请把 order 与 delete 改成不重叠。`)
        }
      }

      let rotateSpec: { pagesSpec: string; angle: number; indices: number[] } | undefined
      const rawRotate = args.rotate
      if (rawRotate !== undefined && rawRotate !== null) {
        if (typeof rawRotate !== 'object' || Array.isArray(rawRotate)) {
          throw new Error('rotate 必须是 {"pages":"1-3","angle":90} 这样的对象')
        }
        const entry = rawRotate as Record<string, unknown>
        const pagesText = typeof entry.pages === 'string' && entry.pages.trim() !== '' ? entry.pages.trim() : undefined
        const angle = Number(entry.angle)
        if (pagesText === undefined) throw new Error('rotate.pages 缺失：请写明要旋转哪些页（重排后的页号）')
        if (!Number.isFinite(angle) || angle % 90 !== 0) throw new Error('rotate.angle 必须是 90 的倍数')
        if (order === undefined) throw new Error('rotate 需要同时给出 order（pages 指重排后的页号）')
        rotateSpec = { pagesSpec: pagesText, angle, indices: parsePageSelection(pagesText, order.length) }
      }

      const defaults: Record<string, unknown> = {}
      if (deleteSpec === undefined) defaults.delete = '不删除任何页'
      if (rotateSpec === undefined) defaults.rotate = '不旋转'

      const notes: string[] = []
      if (removed.length > 0) notes.push(`将删除 ${removed.length} 页：第 ${removed.map(index => index + 1).join(', ')} 页`)

      const gate = authorize({
        tool: 'pdf_arrange',
        action: 'arrange',
        parameters: {
          order: orderSpec ?? '（缺失）',
          delete: deleteSpec ?? '无',
          rotate: rotateSpec === undefined ? '无' : { pages: rotateSpec.pagesSpec, angle: rotateSpec.angle },
          pageCount,
        },
        inputs: [source],
        output,
        pageCount,
        missing,
        defaults,
        notes,
        hints: ['想逆序就说 order=reverse', '想先奇后偶就说 order=odd-even', '想转正某几页就加 rotate'],
        effects: [
          '不修改源文件，结果写入新的 PDF',
          `只改页序${removed.length > 0 ? '并删除指定页' : ''}${rotateSpec === undefined ? '' : '，并写入新的 /Rotate'}`,
          '不改动页面几何，不裁剪、不缩放',
        ],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)
      if (order === undefined) throw new Error('缺少 order：请写明页序，未生成文件。')

      const out = await PDFDocument.create()
      const copied = await out.copyPages(doc, order)
      for (const page of copied) out.addPage(page)
      const rotated = rotateSpec === undefined ? [] : rotatePages(out, rotateSpec.indices, rotateSpec.angle)
      const bytes = await out.save()
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, bytes)

      const lines = [
        `已生成：${output}`,
        `原 ${pageCount} 页 → 输出 ${out.getPageCount()} 页${removed.length > 0 ? `（删除 ${removed.length} 页）` : ''}。`,
        `页序：${orderSpec ?? ''} → 第 ${order.map(index => index + 1).join(', ')} 页。`,
      ]
      if (removed.length > 0) lines.push(`删除的原页号：第 ${removed.map(index => index + 1).join(', ')} 页。`)
      if (rotated.length > 0) {
        lines.push(`旋转：${rotated.map(item => `重排后第 ${item.page} 页 ${item.from}°→${item.to}°`).join('；')}（只改 /Rotate）。`)
      }
      lines.push('注意：源文件未被改动，输出是新文件；重排只改顺序，不改页面几何。')
      return { text: lines.join('\n') }
    },
  }

  // ── merge（合并）───────────────────────────────────────────────────────────
  const merge: ToolDefinition = {
    name: 'pdf_merge',
    description:
      '按文件顺序合并多个 PDF：paths 至少 2 个文件；ranges 可选、与 paths 一一对应'
      + '（例如 ["1-3","","5"]，空串表示整份取全）。'
      + '每页来源（文件名 + 原页号）会在结果里列出。'
      + '输出默认落在第一个文件所在目录（<第一个文件名>-merged.pdf）。生成新文件，绝不覆盖任何源文件。',
    parameters: {
      ...CONFIRM_PARAMS,
      paths: {
        type: 'array',
        required: true,
        items: { type: 'string', description: '一个要合并的 PDF 路径。' },
        description: '要合并的 PDF 路径列表（至少 2 个，按给出顺序拼接）。',
      },
      ranges: {
        type: 'array',
        items: { type: 'string', description: '该文件要取的页范围，空串表示整份。' },
        description: '与 paths 一一对应的页范围，例如 ["1-3","","5"]；省略则每个文件取全部页。',
      },
      output: { type: 'string', description: '输出路径。省略则生成在第一个文件所在目录（<第一个文件名>-merged.pdf）。' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: `合并 ${Array.isArray(args.paths) ? args.paths.length : 0} 个文件`,
      kind: 'write',
    }),
    async execute(args) {
      const rawPaths = Array.isArray(args.paths)
        ? (args.paths as unknown[]).map(value => String(value).trim()).filter(value => value !== '')
        : []
      if (rawPaths.length < 2) {
        throw new Error(`合并至少需要 2 个文件，当前只给了 ${rawPaths.length} 个`)
      }
      const paths = rawPaths.map(raw => {
        const full = resolve(raw)
        if (!existsSync(full)) throw new Error(`文件不存在：${full}`)
        if (extname(full).toLowerCase() !== '.pdf') throw new Error(`不是 PDF 文件：${full}`)
        return full
      })
      const rangesArg = Array.isArray(args.ranges)
        ? (args.ranges as unknown[]).map(value => (value === undefined || value === null ? '' : String(value).trim()))
        : undefined
      if (rangesArg !== undefined && rangesArg.length > paths.length) {
        throw new Error(`ranges 有 ${rangesArg.length} 项，多于 paths 的 ${paths.length} 个文件`)
      }

      const requested = optionalString(args, 'output')
      let output: string
      if (requested !== undefined) {
        output = resolve(options.workspaceRoot, requested)
        if (paths.some(path => path === output)) throw new Error('输出路径不能与任何源文件相同')
      } else {
        output = join(dirname(paths[0]), `${basename(paths[0], extname(paths[0]))}-merged.pdf`)
      }

      const defaults: Record<string, unknown> = {}
      if (rangesArg === undefined) defaults.ranges = '每个文件取全部页'

      const gate = authorize({
        tool: 'pdf_merge',
        action: 'merge',
        parameters: {
          files: paths.map(path => basename(path)),
          ranges: rangesArg ?? '全部页',
          fileCount: paths.length,
        },
        inputs: paths,
        output,
        defaults,
        hints: ['只想取某个文件的前几页就用 ranges', '输出默认放在第一个文件旁边'],
        effects: [
          '不修改任何源文件，结果写入新的 PDF',
          `按顺序拼接 ${paths.length} 个文件`,
        ],
        ...confirmationArgs(options, args),
      })
      if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
      if (gate.kind === 'refused') throw new Error(gate.message)

      const result = await mergeDocuments(paths, rangesArg)
      const bytes = await result.doc.save()
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, bytes)

      // 逐页来源按文件归并，避免几十页时把结果文本撑爆。
      const byFile: Array<{ file: string; pages: number[] }> = []
      for (const page of result.pages) {
        const last = byFile[byFile.length - 1]
        if (last !== undefined && last.file === page.file) last.pages.push(page.sourcePage)
        else byFile.push({ file: page.file, pages: [page.sourcePage] })
      }
      const summarize = (pages: number[]): string =>
        pages.length <= 12 ? `第 ${pages.join(', ')} 页` : `第 ${pages.slice(0, 12).join(', ')} 页等共 ${pages.length} 页`
      const lines = [
        `已生成：${output}`,
        `合并 ${paths.length} 个文件，共 ${result.pageCount} 页：`
          + byFile.map(item => `${item.file}（${summarize(item.pages)}）`).join(' → '),
        ...result.notes.map(note => `来源：${note}`),
      ]
      lines.push('注意：所有源文件都未被改动，输出是新文件。')
      return { text: lines.join('\n') }
    },
  }

  // Compile to the registry-ready shape. Argument validation is wrapped around
  // `execute` here, so a malformed call fails with a readable message instead of
  // a TypeError from deep inside a tool body.
  return [inspect, extract, findAnswers, searchable, edit, replaceLine, annotate, pageText, images, formTool, layout, metadata, redact, optimize, watermark, protect, preview, split, crop, arrange, merge].map((definition) => {
    const parameters = compileParameters(definition.parameters)
    const execute = definition.execute
    return {
      name: definition.name,
      description: definition.description,
      parameters,
      output: definition.output,
      async execute(args: Record<string, unknown>, exec?: unknown) {
        assertArgs(parameters, args, definition.name)
        return execute(args)
      },
      ...(definition.presentCall === undefined ? {} : { presentCall: definition.presentCall }),
    }
  })
}
