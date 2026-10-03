/**
 * dsh-pdf-studio — host-only PDF editing surface for DeepSeek Harness.
 *
 * ## Why this plugin has no client bundle
 *
 * The obvious way to build a GUI plugin is the `dsh.client` dual-face package:
 * a host half plus a browser bundle materialised by the GUI's client-module
 * system. That shape is fragile across DSH builds. The client-module system
 * resolves a plugin's declared `dsh.client.inject` against the service graph
 * of whichever shell is running, and the desktop shell's graph is not the web
 * shell's. A plugin that declares a service the running shell does not expose
 * never activates — the desktop app reports `pending (waiting for service)`
 * and the feature simply does not appear.
 *
 * This plugin therefore ships a HOST-ONLY surface. The browser side is a plain
 * script served from our own routes and injected into the page:
 *
 *   - `webServer.tapIndex`   — the web shell's route, transforms index.html.
 *   - `webserver/index-inject` — the desktop shell's route: a structured row
 *     table handed to the renderer, which appends it to the document.
 *
 * Both are registered, and each is the no-op on the shell that does not use it.
 * The surface then talks to the host over same-origin `/api/pdf-studio/*`.
 *
 * ## The registration-order trap
 *
 * The desktop host collects the injection table ONCE, at startup, and caches
 * it with no refresh path. If a plugin's `webserver/index-inject` listener is
 * not attached by the time that collection runs, its row is never seen and the
 * surface never appears — with no error anywhere. Deferring `apply` behind a
 * service dependency is exactly what causes that, so the listener is attached
 * synchronously as the first statement of `apply`, and every service-dependent
 * action waits inside `root.inject(...)` instead.
 *
 * @module dsh-pdf-studio
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { PDF_API_PREFIX, makePdfRoutes, type WebServerLike } from './host/routes.ts'
import { buildToolDefinitions, type AttachmentSink, type ToolRegistry } from './host/tools.ts'

/** Tool names, listed once so the boot log can name them. */
const TOOL_NAMES = ['pdf_inspect', 'pdf_extract_text', 'pdf_make_searchable', 'pdf_edit_text', 'pdf_watermark', 'pdf_protect', 'pdf_preview']

export { PDF_API_PREFIX, PDF_SURFACE_SCRIPT } from './host/routes.ts'
export { analyzeDocument, exportSearchable } from './host/engine.ts'
export { triageDocument, triagePage } from './core/triage.ts'


/** Options the plugin accepts from the profile patch. */
export interface PdfStudioConfig {
  /** Directory relative output paths resolve against, and the export guard scopes to. */
  workspaceRoot?: string
  /**
   * Register the agent-facing tools. Default true.
   *
   * There is no `surface` option any more: the floating panel was removed in
   * favour of tools the agent calls, so there is no browser surface to attach.
   */
  tools?: boolean
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
