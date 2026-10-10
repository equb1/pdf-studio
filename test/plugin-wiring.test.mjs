/**
 * 插件装配层测试：工具注册 + 浮层注入 + 确认策略配置。
 *
 * 这一层最容易"看起来对但其实没接上"：
 *
 *   - 浮层注入曾经只写在文档里，代码里一处都没注册（`index-inject` 在构建产物里出现 0 次），
 *     结果是浮层只在手动打开 `/api/pdf-studio/panel` 时才存在；
 *   - 桌面端通过 `file://` 加载页面，相对地址在那里没有意义，注入必须带上**绝对** API 地址；
 *   - 宿主可能把 `webserver/index-inject` 事件发在根上下文，也可能发在服务上下文上，
 *     两处都要挂，且**同一张行表不能重复注入**（否则浮层会挂两次）。
 *
 * 这里用最小的假 cordis 上下文把 `apply()` 跑起来，逐条钉住这些性质。
 *
 * Run: node --experimental-strip-types test/plugin-wiring.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pdfStudio = (await import('../src/index.ts')).default

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

/** 最小 cordis 上下文：记录监听器、把 inject 回调留到测试里手动触发。 */
function makeContext() {
  const listeners = new Map()
  const injected = []
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    inject(services, fn) {
      injected.push({ services, fn })
    },
    logger: { info() {}, warn() {} },
  }
  return {
    ctx,
    injected,
    disposers,
    /** 模拟宿主广播行表事件。 */
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length
    },
  }
}

/** 假的 webServer 服务：记录路由与 tapIndex 变换。 */
function makeWebServer({ port, host } = {}) {
  const routes = []
  const taps = []
  return {
    routes,
    taps,
    service: {
      ...(port === undefined ? {} : { port }),
      ...(host === undefined ? {} : { host }),
      register(route) {
        routes.push(route)
        return () => {}
      },
      tapIndex(transform) {
        taps.push(transform)
        return () => {}
      },
    },
  }
}

/**
 * 取一个**真实存在**的文字块 id。
 *
 * `pdf_edit_text` 在「0/N 处改写」时会明确失败，所以夹具不能再用 `1:0` 这种想当然的 id —— 
 * 那正是"假成功"时代留下的写法。
 */
async function realTargetId(tool, path) {
  const runs = (await tool.execute({ path, runs: true })).text
  const match = /(\d+:\d+)｜/.exec(runs)
  assert.ok(match !== null, `夹具应至少有一个可编辑文字块，实际输出：${runs.slice(0, 200)}`)
  return match[1]
}

const workspace = mkdtempSync(join(tmpdir(), 'pdf-wiring-'))
const sample = join(workspace, 'wiring.pdf')
{
  const { PDFDocument, StandardFonts } = require('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([300, 200]).drawText('wiring', { x: 30, y: 100, size: 14, font })
  writeFileSync(sample, await doc.save())
}

// ── 1. 工具注册与策略透传 ───────────────────────────────────────────────────
{
  const harness = makeContext()
  pdfStudio.apply(harness.ctx, { workspaceRoot: workspace, requireConfirmation: 'always' })

  const toolsInjection = harness.injected.find(item => item.services.includes('tools'))
  check('tools 服务依赖被声明', toolsInjection !== undefined)

  const registered = []
  toolsInjection.fn({
    tools: { register: definition => registered.push(definition) },
    logger: harness.ctx.logger,
    on: harness.ctx.on,
    effect: harness.ctx.effect,
  })
  check('12 个工具全部注册', registered.length === 12, registered.map(item => item.name).join(', '))
  check('写盘类工具带 confirm 参数',
    ['pdf_edit_text', 'pdf_replace_line', 'pdf_watermark', 'pdf_protect', 'pdf_make_searchable',
      'pdf_split', 'pdf_crop', 'pdf_arrange', 'pdf_merge'].every(name =>
      Object.keys(registered.find(item => item.name === name)?.parameters?.properties ?? {}).includes('confirm')))

  // 策略 always：连只读的水印扫描之外的写操作都要确认，且未确认时不落盘。
  const editTool = registered.find(item => item.name === 'pdf_edit_text')
  const output = join(workspace, 'never-written.pdf')
  const inspectTool = registered.find(item => item.name === 'pdf_inspect')
  const targetId = await realTargetId(inspectTool, sample)
  const text = (await editTool.execute({
    path: sample,
    edits: [{ page: 1, targetId, to: '改一下' }],
    output,
  })).text
  check('策略 always：适配层传入的配置真的生效（未确认返回计划）',
    typeof text === 'string' && text.includes('需要你确认'))
  let written = true
  try {
    readFileSync(output)
  } catch {
    written = false
  }
  check('未确认时不产出文件', written === false)
}

// ── 2. 两端注入：行表 + tapIndex ────────────────────────────────────────────
{
  const harness = makeContext()
  pdfStudio.apply(harness.ctx, { workspaceRoot: workspace, surface: true })
  const web = makeWebServer({ port: 19387, host: '127.0.0.1' })
  const webInjection = harness.injected.find(item => item.services.includes('webServer'))
  webInjection.fn({ webServer: web.service, logger: harness.ctx.logger, on: harness.ctx.on, effect: harness.ctx.effect })

  check('路由已注册到宿主', web.routes.length > 0, `${web.routes.length} 条`)
  check('tapIndex 兜底已挂上', web.taps.length === 1)
  check('注入事件在根上下文也有监听器', harness.listenerCount('webserver/index-inject') >= 1)

  // 行表：全局变量 + 脚本行，地址必须是绝对的（桌面端 file:// 下相对地址无效）
  const table = []
  harness.emit('webserver/index-inject', table)
  const globalRow = table.find(row => row.kind === 'global' && row.name === '__DSH_PDF_STUDIO__')
  const scriptRow = table.find(row => row.kind === 'script-src')
  check('行表包含 global + script-src', globalRow !== undefined && scriptRow !== undefined,
    JSON.stringify(table.map(row => row.kind)))
  check('global 里带绝对 apiBase（桌面端必需）',
    globalRow?.value?.apiBase === 'http://127.0.0.1:19387/api/pdf-studio',
    String(globalRow?.value?.apiBase))
  check('script-src 指向绝对地址',
    scriptRow?.src === 'http://127.0.0.1:19387/dsh-pdf-studio/app.js', String(scriptRow?.src))
  check('global 里带确认策略，浮层可据此提示',
    globalRow?.value?.requireConfirmation === 'destructive', String(globalRow?.value?.requireConfirmation))

  // 同一张表不能重复注入（否则浮层挂两次）
  const before = table.length
  harness.emit('webserver/index-inject', table)
  check('同一张表重复广播不会重复注入', table.length === before, `${before} → ${table.length}`)

  // tapIndex 兜底：没消费行表的宿主也能拿到浮层
  const html = web.taps[0]('<!doctype html><html><head><title>t</title></head><body></body></html>')
  check('tapIndex 注入 boot 全局', html.includes('__DSH_PDF_STUDIO__'))
  check('tapIndex 注入脚本标签', html.includes('http://127.0.0.1:19387/dsh-pdf-studio/app.js'))
  check('tapIndex 注入位置在 </head> 之前', html.indexOf('__DSH_PDF_STUDIO__') < html.indexOf('</head>'))
  const twice = web.taps[0](html)
  // 只数 <script src=…> 标签：boot 的 JSON 里也会出现同一个 URL，按字符串数会误判。
  check('tapIndex 幂等：已注入过的 HTML 不再重复插脚本',
    (twice.match(/<script src=/g) ?? []).length === (html.match(/<script src=/g) ?? []).length,
    `${(html.match(/<script src=/g) ?? []).length} → ${(twice.match(/<script src=/g) ?? []).length}`)
}

// ── 2'. 默认不注入：这个插件的定位是"助手调用工具"，页面上什么都不出现 ──────
{
  const harness = makeContext()
  pdfStudio.apply(harness.ctx, { workspaceRoot: workspace })
  const web = makeWebServer({ port: 19387, host: '127.0.0.1' })
  harness.injected.find(item => item.services.includes('webServer'))
    .fn({ webServer: web.service, logger: harness.ctx.logger, on: harness.ctx.on, effect: harness.ctx.effect })

  const table = []
  harness.emit('webserver/index-inject', table)
  check('默认配置：不注入任何行（页面里不出现浮层）', table.length === 0, `${table.length} 行`)
  check('默认配置：不注册行表监听器', harness.listenerCount('webserver/index-inject') === 0,
    String(harness.listenerCount('webserver/index-inject')))
  check('默认配置：不挂 tapIndex 兜底', web.taps.length === 0, `${web.taps.length} 个`)
  check('默认配置：路由仍然注册（助手工具/接口不受影响）', web.routes.length > 0, `${web.routes.length} 条`)

  // 确认功能不依赖浮层：纯文本路径必须照常可用。
  const registered = []
  const toolHarness = makeContext()
  pdfStudio.apply(toolHarness.ctx, { workspaceRoot: workspace })
  toolHarness.injected.find(item => item.services.includes('tools')).fn({
    tools: { register: definition => registered.push(definition) },
    logger: toolHarness.ctx.logger, on: toolHarness.ctx.on, effect: toolHarness.ctx.effect,
  })
  const editTool = registered.find(item => item.name === 'pdf_edit_text')
  const output = join(workspace, 'no-surface-plan.pdf')
  const text = (await editTool.execute({
    path: sample, edits: [{ page: 1, targetId: await realTargetId(registered.find(i => i.name === 'pdf_inspect'), sample), to: '改一下' }],
    output,
  })).text
  check('默认配置：确认单仍以纯文本返回（不依赖浮层）',
    typeof text === 'string' && text.includes('需要你确认') && text.includes('计划 id：'), String(text).split('\n')[0])
}

// ── 3. 没有端口的宿主（网页端相对路径）────────────────────────────────────
{
  const harness = makeContext()
  pdfStudio.apply(harness.ctx, { workspaceRoot: workspace, surface: true })
  const web = makeWebServer({})
  harness.injected.find(item => item.services.includes('webServer'))
    .fn({ webServer: web.service, logger: harness.ctx.logger, on: harness.ctx.on, effect: harness.ctx.effect })
  const table = []
  harness.emit('webserver/index-inject', table)
  const globalRow = table.find(row => row.kind === 'global')
  check('拿不到端口时回退相对地址',
    globalRow?.value?.apiBase === '/api/pdf-studio' && globalRow?.value?.scriptSrc === '/dsh-pdf-studio/app.js',
    JSON.stringify(globalRow?.value))
}

// ── 4. 绑定 0.0.0.0 时浏览器侧要用回环地址 ─────────────────────────────────
{
  const harness = makeContext()
  pdfStudio.apply(harness.ctx, { workspaceRoot: workspace, surface: true })
  const web = makeWebServer({ port: 8080, host: '0.0.0.0' })
  harness.injected.find(item => item.services.includes('webServer'))
    .fn({ webServer: web.service, logger: harness.ctx.logger, on: harness.ctx.on, effect: harness.ctx.effect })
  const table = []
  harness.emit('webserver/index-inject', table)
  check('0.0.0.0 映射为 127.0.0.1',
    table.find(row => row.kind === 'global')?.value?.apiBase === 'http://127.0.0.1:8080/api/pdf-studio',
    String(table.find(row => row.kind === 'global')?.value?.apiBase))
}

// ── 5. 配置优先级：环境变量兜底 ────────────────────────────────────────────
{
  const harness = makeContext()
  process.env.DSH_PDF_STUDIO_CONFIRM = 'never'
  try {
    pdfStudio.apply(harness.ctx, { workspaceRoot: workspace })
    const registered = []
    harness.injected.find(item => item.services.includes('tools')).fn({
      tools: { register: definition => registered.push(definition) },
      logger: harness.ctx.logger,
      on: harness.ctx.on,
      effect: harness.ctx.effect,
    })
    const output = join(workspace, 'env-policy.pdf')
    const policyEditTool = registered.find(item => item.name === 'pdf_edit_text')
    const policyInspectTool = registered.find(item => item.name === 'pdf_inspect')
    const policyTargetId = await realTargetId(policyInspectTool, sample)
    const text = (await policyEditTool.execute({
      path: sample,
      edits: [{ page: 1, targetId: policyTargetId, to: '环境变量策略' }],
      output,
    })).text
    check('DSH_PDF_STUDIO_CONFIRM=never 直接执行', text.includes('已生成'), text.split('\n')[0])
  } finally {
    delete process.env.DSH_PDF_STUDIO_CONFIRM
  }
}

console.log(`\n${failed === 0 ? 'ALL PLUGIN-WIRING CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
