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
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { analyzeDocument, applyTextEdits, exportSearchable, inspectDocument, protectPdf, readEditableDocument, reportWatermarks, stampWatermark, stripWatermarks, lineSummary } from './engine.ts'

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
      + 'runs=true 会列出可编辑的文字块及其 id，供 pdf_edit_text 使用。',
    parameters: {
      path: { type: 'string', required: true, description: 'PDF 的完整路径或相对工作区路径。' },
      analyze: { type: 'boolean', description: '是否做完整分诊。扫描件会触发 OCR，耗时可能从秒到分钟。' },
      runs: { type: 'boolean', description: '是否列出现有文字块（含 id、文字、字体、字号、位置）。' },
    },
    output: TEXT_OUTPUT,
    output: TEXT_OUTPUT,
    presentCall: args => ({ card: 'generic', title: `检查 ${basename(String(args.path ?? ''))}`, kind: 'read' }),
    async execute(args) {
      const source = resolveInput(args)
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

      if (optionalBoolean(args, 'analyze')) {
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
      path: { type: 'string', required: true, description: 'PDF 路径。' },
      page: { type: 'integer', description: '只提取这一页（1 开始）。省略则提取全部页。' },
      ocr: { type: 'boolean', description: '是否对图片页做 OCR。默认 true。' },
    },
    output: TEXT_OUTPUT,
    output: TEXT_OUTPUT,
    presentCall: args => ({ card: 'generic', title: `提取文字 ${basename(String(args.path ?? ''))}`, kind: 'read' }),
    async execute(args) {
      const source = resolveInput(args)
      const analysis = await analyzeDocument(source)
      const wanted = typeof args.page === 'number' ? Number(args.page) : undefined
      const out: string[] = []
      for (const page of analysis.content) {
        if (wanted !== undefined && page.page !== wanted) continue
        out.push(`── 第 ${page.page} 页（${page.kind}）──`)
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
      path: { type: 'string', required: true, description: '源 PDF 路径。' },
      output: { type: 'string', description: '输出路径。省略则在源文件旁生成 <名字>-searchable.pdf。' },
      mode: {
        type: 'string',
        enum: ['invisible', 'cover'],
        description: 'invisible（默认）：文字层不可见。cover：把识别文字可见地覆盖在图片上，便于核对。',
      },
    },
    output: TEXT_OUTPUT,
    output: TEXT_OUTPUT,
    presentCall: args => ({ card: 'generic', title: `生成可搜索 PDF ${basename(String(args.path ?? ''))}`, kind: 'write' }),
    async execute(args) {
      const source = resolveInput(args)
      const output = resolveOutput(source, args, '-searchable', options.workspaceRoot)
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

      const result = await applyTextEdits(source, output, edits)
      const text = [
        `已生成：${result.outputPath}`,
        `应用 ${result.applied} 处改写，共 ${edits.length} 处请求。`,
        ...result.notes.map(note => `注意：${note}`),
        '提示：改写后文字块的 id 会整体前移，继续编辑前请重新读取。',
      ].join('\n')
      return { text }
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
      if (text === undefined && imagePath === undefined) {
        throw new Error('action=add 需要 text 或 imagePath 参数')
      }
      const image = imagePath === undefined ? undefined : new Uint8Array(await readFile(imagePath))
      const output = resolveOutput(source, args, '-watermarked', options.workspaceRoot)
      const result = await stampWatermark(source, output, {
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
      })
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
      const result = await protectPdf(source, output, { kind: 'decrypt', password: password ?? '' })
      return {
        text: `已生成：${result.outputPath}\n加密：${result.encrypted}（应为 false）`,
      }
    },
  }

  // Compile to the registry-ready shape. Argument validation is wrapped around
  // `execute` here, so a malformed call fails with a readable message instead of
  // a TypeError from deep inside a tool body.
  return [inspect, extract, searchable, edit, watermark, protect, preview].map((definition) => {
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
