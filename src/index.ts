/**
 * dsh-pdf-studio — host-only PDF tools for DeepSeek Harness.
 *
 * ## 主界面是助手工具；页面默认什么都不出现
 *
 * 用户描述目标，助手挑工具去执行。**默认配置下页面上不注入任何东西**：
 * 没有右下角入口、没有工作台、没有卡片，确认单以纯文本返回。
 *
 * 想要可视化工作台，把配置项 `surface` 设为 `true`（见下面的 `PdfStudioConfig`），
 * 那时才会往页面里注入浮层。
 *
 * ## 注入（仅 `surface: true`）为什么不用 client bundle
 *
 * 常规做法是 `dsh.client` 双面包：host 一半 + 浏览器 bundle。这种形态跨 DSH 构建很脆——
 * 客户端模块系统会拿插件声明的 `dsh.client.inject` 去匹配"当前 shell"的服务图，而桌面 shell 的
 * 服务图和 web shell 的不是同一张；插件声明了当前 shell 不提供的服务就永远不激活
 * （桌面端停在 `pending (waiting for service)`，功能无声消失）。
 *
 * 所以注入走宿主既有的两条通道，浏览器侧只是一段从我们自己路由下发的普通脚本：
 *
 *   - `webServer.tapIndex`   — web shell：改写 index.html。
 *   - `webserver/index-inject` — 桌面 shell：结构化行表交给渲染层追加。
 *
 * 两条都注册（各自在不用它的 shell 上是 no-op），行表按 `row.name` 去重，所以不会注入两次。
 * 浮层随后用同源 `/api/pdf-studio/*` 与宿主通信。
 *
 * ## 注册顺序陷阱（只在 `surface: true` 时相关）
 *
 * 桌面宿主在启动时只收集一次注入行表并缓存，没有刷新路径。如果插件的
 * `webserver/index-inject` 监听在收集之后才挂上，那一行就永远进不去，而且没有任何报错。
 * 所以监听是**同步**挂在 `apply()` 里的，依赖服务的动作都放在 `root.inject(...)` 内等。
 *
 * @module dsh-pdf-studio
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { PDF_API_PREFIX, PDF_SURFACE_SCRIPT, makePdfRoutes, type WebServerLike } from './host/routes.ts'
import { DEFAULT_CONFIRMATION_POLICY, type ConfirmationPolicy } from './core/confirmation.ts'
import { buildToolDefinitions, type AttachmentSink, type ToolRegistry } from './host/tools.ts'

/** Tool names, listed once so the boot log can name them. */
const TOOL_NAMES = ['pdf_inspect', 'pdf_extract_text', 'pdf_find_answers', 'pdf_make_searchable', 'pdf_edit_text', 'pdf_replace_line', 'pdf_watermark', 'pdf_protect', 'pdf_preview', 'pdf_split', 'pdf_crop', 'pdf_arrange', 'pdf_merge']

export { PDF_API_PREFIX, PDF_SURFACE_SCRIPT } from './host/routes.ts'
export { analyzeDocument, exportSearchable } from './host/engine.ts'
export { triageDocument, triagePage } from './core/triage.ts'


/** 注入到页面的全局变量名：浮层用它拿到绝对 API 地址。 */
const SURFACE_GLOBAL = '__DSH_PDF_STUDIO__'

/** Options the plugin accepts from the profile patch. */
export interface PdfStudioConfig {
  /** Directory relative output paths resolve against, and the export guard scopes to. */
  workspaceRoot?: string
  /**
   * 注册助手可调用的工具。默认 true。
   *
   * 这是插件的主界面：用户描述目标，助手挑工具去做，页面上什么都不出现。
   * 想要可视化工作台另见下面的 `surface`（默认关闭）。
   */
  tools?: boolean
  /**
   * 何时要求用户确认：`destructive`（默认）/ `always` / `never`。
   * 也可以由环境变量 `DSH_PDF_STUDIO_CONFIRM` 指定。
   */
  requireConfirmation?: ConfirmationPolicy
  /**
   * 是否把浏览器浮层（右下角入口 + PDF 工作台 + 待确认卡片）注入页面。
   *
   * **默认 false**：这个插件的定位是"助手调用工具"，页面上什么都不出现。
   * 打开它只是为了给人一个可视化工作台；确认流程本身不依赖它——不注入时，
   * 确认单以纯文本返回，用户对助手说「确认执行」即可。
   */
  surface?: boolean
  /**
   * OCR 语言数据目录（放 `<lang>.traineddata[.gz]`）。
   *
   * 不配的话按 `DSH_PDF_STUDIO_TESSDATA` 环境变量 → 这个插件外的兜底路径来找，
   * 所以"换台机器就没有语言数据"这件事可以在这里一次配好。
   */
  tessdataPath?: string
}

/** 计算注入用的基线地址：能拿到端口就用绝对地址（桌面端必需），否则退回相对路径。 */
function surfaceBase(webServer: { port?: number; host?: string } | undefined): {
  apiBase: string
  scriptSrc: string
} {
  const port = webServer?.port
  if (typeof port === 'number' && port > 0) {
    const rawHost = webServer?.host ?? '127.0.0.1'
    // 绑定 0.0.0.0/:: 时，浏览器侧要用回环地址去连。
    const host = rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost
    const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`
    return { apiBase: origin + PDF_API_PREFIX, scriptSrc: origin + PDF_SURFACE_SCRIPT }
  }
  return { apiBase: PDF_API_PREFIX, scriptSrc: PDF_SURFACE_SCRIPT }
}

/** 往 index.html 里补注入（tapIndex 用的逃生口，兜住"行表没被消费"的宿主）。 */
function injectIntoHtml(html: string, base: { apiBase: string; scriptSrc: string }): string {
  const boot = `<script>window.${SURFACE_GLOBAL}=${JSON.stringify({ apiBase: base.apiBase, scriptSrc: base.scriptSrc })};</script>`
  const tag = `<script src="${base.scriptSrc}" defer></script>`
  if (html.includes(PDF_SURFACE_SCRIPT)) {
    return html.includes(SURFACE_GLOBAL) ? html : html.replace('</head>', `${boot}</head>`)
  }
  return html.replace('</head>', `${boot}${tag}</head>`)
}

/** Whether a directory looks like a DSH profile rather than a documents folder. */
function isProfileDirectory(dir: string): boolean {
  // Deliberately narrow: only a DSH profile path triggers the fallback, so a
  // user who intentionally points the plugin at a subdirectory keeps it.
  return dir.includes('/.dsh/profiles/') || dir.includes('\\.dsh\\profiles\\')
}

/** The cordis plugin object (the shape DSH loads from its roster). */
export default {
  name: 'pdf-studio',

  apply(root: Context, config: PdfStudioConfig = {}): void {
    const disposers: Array<() => void> = []
    root.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A failing teardown must not mask the others.
        }
      }
    })

    // Resolve the directory relative output paths resolve against, and that the
    // export guard scopes to. Prefer an explicit setting, then the environment,
    // then somewhere that actually holds documents: `process.cwd()` is a poor
    // last resort on the desktop, where the host runs from its own profile
    // directory and the resulting empty picker made the plugin look broken.
    const workspaceRoot = config.workspaceRoot
      ?? process.env.DSH_PDF_STUDIO_WORKSPACE
      ?? (isProfileDirectory(process.cwd()) ? homedir() : process.cwd())

    // ── 1. Agent tools ───────────────────────────────────────────────────────
    //
    // The primary interface: the user describes a goal and the agent picks a
    // tool. Nothing renders until there is something to show, which is the whole
    // reason the floating panel was removed.
    //
    // Registration is synchronous because the definitions do no I/O; the tools
    // load their heavy dependencies lazily inside `core/*` when actually run.
    const confirmation = config.requireConfirmation
      ?? (process.env.DSH_PDF_STUDIO_CONFIRM as ConfirmationPolicy | undefined)
      ?? DEFAULT_CONFIRMATION_POLICY

    // ── 0. 浏览器浮层的注入（默认不做！）───────────────────────────────────
    //
    // 这个插件的主界面是"助手调用工具"，页面里**不出现任何东西**。只有显式
    // `surface: true` 时才注入浮层（右下角入口 + 工作台 + 待确认卡片）。
    // 注意：确认功能本身与此无关，关闭注入时确认单以纯文本返回。
    const surface = config.surface === true
    //
    // 同一个 `public/app.js` 同时服务网页端与桌面端：宿主把"结构化行表"渲染进 index.html，
    // 桌面端也消费同一张表。这里**同步**挂监听器——桌面宿主启动时只收集一次，晚一步行就永远
    // 进不去且没有任何报错（见模块文档）。行本身按表去重，所以两端、双重注册都不会注入两次。
    // `root.webServer` 未必能直接读到（服务可能挂在子上下文上），而注入回调里一定拿得到；
    // 这里把它记下来供行表使用，这样桌面端才能拿到绝对地址。
    let surfaceWebServer: WebServerLike | undefined
    const injectSurface = (table: unknown): void => {
      if (!Array.isArray(table)) return
      const rows = table as Array<Record<string, unknown>>
      if (rows.some(row => row?.name === SURFACE_GLOBAL)) return
      const base = surfaceBase(surfaceWebServer ?? (root as Context & { webServer?: WebServerLike }).webServer)
      rows.push({
        kind: 'global',
        name: SURFACE_GLOBAL,
        value: { apiBase: base.apiBase, scriptSrc: base.scriptSrc, requireConfirmation: confirmation },
      })
      rows.push({ kind: 'script-src', placement: 'body', src: base.scriptSrc })
    }
    if (surface) {
      root.effect(() => root.on('webserver/index-inject' as never, injectSurface as never))
    }

    if (config.tools !== false) {
      // `attachments` is optional: without it the preview tool degrades to a
      // text explanation instead of failing, so the plugin still loads on a host
      // that does not expose it.
      root.inject(['tools', 'attachments'], (ctx: Context) => {
        const registry = (ctx as Context & { tools?: ToolRegistry }).tools
        if (registry === undefined) return
        const attachments = (ctx as Context & { attachments?: AttachmentSink }).attachments
        try {
          for (const definition of buildToolDefinitions({
            workspaceRoot,
            confirmation,
            ...(config.tessdataPath === undefined ? {} : { tessdataPath: config.tessdataPath }),
            ...(attachments === undefined ? {} : { attachments }),
          })) {
            registry.register(definition)
          }
          ctx.logger?.info?.('[pdf-studio] registered ' + String(TOOL_NAMES.length) + ' tools: ' + TOOL_NAMES.join(', '))
        } catch (error) {
          // A tool that will not register must not take the host down with it.
          ctx.logger?.warn?.('[pdf-studio] tool registration failed: ' + String(error))
        }
      })
    }

    // ── 2. Service-dependent wiring ─────────────────────────────────────────
    root.inject(['webServer'], (ctx: Context) => {
      const webServer = (ctx as Context & { webServer?: WebServerLike }).webServer
      if (webServer === undefined) return
      surfaceWebServer = webServer

      if (surface) {
        // 2a. 事件挂在服务上下文上时，root 上的监听器收不到——两处都挂，行表去重保证只注入一次。
        root.effect(() => ctx.on('webserver/index-inject' as never, injectSurface as never))

        // 2a'. tapIndex 作为兜底：万一某个宿主没有消费行表，也把浮层挂上去。
        if (typeof webServer.tapIndex === 'function') {
          disposers.push(webServer.tapIndex(html => injectIntoHtml(html, surfaceBase(webServer))))
        }
      }

      // 2b. The API and asset routes the surface talks to.
      for (const route of makePdfRoutes({ workspaceRoot })) {
        disposers.push(webServer.register(route))
      }

      ctx.logger?.info?.(
        '[pdf-studio] surface ready at ' + PDF_API_PREFIX + ' (workspace: ' + workspaceRoot + ')',
      )
    })
  },
}
