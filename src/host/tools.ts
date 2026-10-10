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
import { analyzeDocument, applyTextEdits, exportSearchable, inspectDocument, protectPdf, readEditableDocument, reportWatermarks, stampWatermark, stripWatermarks, lineSummary } from './engine.ts'
import { redrawLineInPdfBytes } from '../core/line-redraw.ts'
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

/** Shape of a tool's parameter description, as `defineTool` expects it. */
interface ParamSpec {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  required?: boolean
  enum?: readonly string[]
  items?: ParamSpec
  properties?: Record<string, ParamSpec>
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
function compileParam(spec: ParamSpec, path: string): Record<string, unknown> {
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
      if (out.length === 0) out.push(wanted === undefined ? '没有提取到内容。' : `第 ${wanted} 页不存在。`)
      return { text: out.join('\n') }
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
      + 'action=remove 移除能确认的水印。'
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
        description: 'add 添加；scan 只查找不改动；remove 移除高置信度水印。',
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
        const lines = [`共 ${report.pages} 页，找到 ${report.candidates.length} 个可移除候选：`]
        for (const candidate of report.candidates) {
          lines.push(
            `  第${candidate.page}页｜${Math.round(candidate.confidence * 100)}%｜${candidate.detail}`,
          )
        }
        if (report.candidates.length === 0) lines.push('  （没有找到按结构可识别的水印）')
        for (const refused of report.refused) {
          lines.push(`无法处理 · 第${refused.page}页：${refused.detail}`)
        }
        return { text: lines.join('\n') }
      }

      if (action === 'remove') {
        const output = resolveOutput(source, args, '-clean', options.workspaceRoot)
        // 这里不预扫一遍水印：真正执行时引擎自己会扫，再扫一次只是白花时间。
        // 计划只声明"移除全部高置信度候选"，而这与文件指纹一一对应，planId 依然稳定。
        const gate = authorize({
          tool: 'pdf_watermark',
          action: 'remove',
          parameters: { candidates: '全部高置信度候选（置信度 ≥ 0.9）' },
          inputs: [source],
          output,
          hints: ['只想删某几页就说「只删第 1 页」', '想先看候选清单就先跑 action=scan'],
          effects: ['不修改源文件，结果写入新的 PDF', '只移除能自证的水印（低置信度候选会被保留）'],
          ...confirmationArgs(options, args),
        })
        if (gate.kind === 'plan') return { text: renderPlanPrompt(gate.plan) }
        if (gate.kind === 'refused') throw new Error(gate.message)
        const result = await stripWatermarks(source, output, { dryRun: false })
        if (result.dryRun) {
          return { text: `没有可移除的高置信度水印，文件未改动。跳过 ${result.skipped.length} 个低置信度候选。` }
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

  // Compile to the registry-ready shape. Argument validation is wrapped around
  // `execute` here, so a malformed call fails with a readable message instead of
  // a TypeError from deep inside a tool body.
  return [inspect, extract, searchable, edit, replaceLine, watermark, protect, preview].map((definition) => {
    const parameters = compileParameters(definition.parameters)
    const execute = definition.execute
    return {
      name: definition.name,
      description: definition.description,
      parameters,
      output: definition.output,
      async execute(args: Record<string, unknown>, exec?: unknown) {
        assertArgs(parameters, args, definition.name)
        return execute(args, exec)
      },
      ...(definition.presentCall === undefined ? {} : { presentCall: definition.presentCall }),
    }
  })
}
