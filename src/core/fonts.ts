/**
 * Font embedding shared by every writer in this package.
 *
 * Embedding a font through pdf-lib 1.17.1 + fontkit 2.x takes three separate
 * compatibility repairs, all discovered the hard way and all silent when
 * missing. Keeping them in one module means a second writer (the text editor,
 * the watermark stamper, the overlay writer) cannot regress them by embedding
 * a font its own way.
 *
 * The three repairs:
 *
 * 1. **`subset.encodeStream()` was renamed.** pdf-lib expects a readable
 *    stream; fontkit 2 returns a `Uint8Array` from `encode()`. Without the
 *    bridge, saving dies with `subset.encodeStream is not a function`.
 * 2. **`subset.cff` disappeared.** pdf-lib reads its truthiness to choose
 *    `CIDFontType0`/`FontFile3` over `CIDFontType2`/`FontFile2`. Dropping it
 *    silently changes the embedded font's type.
 * 3. **`fontkit.create()` returns a collection for a `.ttc`.** Every CJK face
 *    macOS ships is a collection, and a collection has no `layout()`, so
 *    embedding an unadapted one throws.
 *
 * @module dsh-pdf-studio/core/fonts
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

/** Minimal EventEmitter shape pdf-lib's subset serializer listens on. */
interface ByteStream {
  on(event: string, listener: (arg?: unknown) => void): ByteStream
}

/**
 * Wrap bytes in the tiny stream interface pdf-lib expects.
 *
 * Hand-rolled rather than `node:stream` to match the exact
 * `on('data'|'end'|'error')` contract. Delivery is deferred a microtask so a
 * listener attached after the call is still invoked.
 */
function bytesToByteStream(bytes: Uint8Array): ByteStream {
  const handlers: Record<string, Array<(arg?: unknown) => void>> = {}
  const stream: ByteStream = {
    on(event, listener) {
      ;(handlers[event] ??= []).push(listener)
      return stream
    },
  }
  queueMicrotask(() => {
    try {
      for (const listener of handlers.data ?? []) listener(bytes)
      for (const listener of handlers.end ?? []) listener()
    } catch (error) {
      for (const listener of handlers.error ?? []) listener(error)
    }
  })
  return stream
}

const SHIMMED = Symbol.for('dsh-pdf-studio.fontkit-subset-shimmed')

/** Apply the `encodeStream` / `cff` repairs to one fontkit font object. */
export function shimSubsetCompatibility(font: unknown): unknown {
  const target = font as Record<string | symbol, unknown> & {
    createSubset?: (...args: unknown[]) => Record<string, unknown>
    directory?: { tables?: Record<string, unknown> }
  }
  if (target === null || typeof target !== 'object' || target[SHIMMED]) return font
  const originalCreateSubset = target.createSubset
  if (typeof originalCreateSubset !== 'function') return font

  const cffTable = target.directory?.tables?.['CFF ']

  target.createSubset = function createSubset(this: unknown) {
    const subset = originalCreateSubset.call(this) as Record<string, unknown> & {
      encodeStream?: () => unknown
      encode?: () => Uint8Array
      cff?: unknown
    }
    if (typeof subset.encodeStream !== 'function' && typeof subset.encode === 'function') {
      subset.encodeStream = () => bytesToByteStream(subset.encode!())
    }
    if (subset.cff === undefined && cffTable !== undefined) subset.cff = cffTable
    return subset
  }

  target[SHIMMED] = true
  return font
}

/** Prefer a Simplified-Chinese face out of a collection, else the first. */
export function pickPreferredFace(faces: Array<{ postscriptName?: unknown }>): unknown {
  if (!Array.isArray(faces) || faces.length === 0) return undefined
  return faces.find(face => /SC|GB/i.test(String(face?.postscriptName ?? ''))) ?? faces[0]
}

/**
 * Wrap a fontkit module so `create()` always yields an embeddable font.
 *
 * A `.ttc` makes fontkit return a collection; pdf-lib calls `create()` with no
 * face name and then needs `layout()`, which a collection lacks.
 */
export function makeFontkitAdapter(raw: Record<string, unknown>): Record<string, unknown> {
  const adapter: Record<string, unknown> = { ...raw }
  const rawCreate = raw.create as ((data: Uint8Array, name?: string) => unknown) | undefined
  adapter.create = (data: Uint8Array, postscriptName?: string) => {
    const created = rawCreate?.(data, postscriptName) as { fonts?: unknown[] } | undefined
    const font = created && Array.isArray(created.fonts) ? pickPreferredFace(created.fonts as never) : created
    return shimSubsetCompatibility(font)
  }
  return adapter
}

/** Import a fontkit implementation and adapt it for pdf-lib. */
export async function loadFontkitAdapter(): Promise<Record<string, unknown> | null> {
  for (const specifier of ['fontkit', '@pdf-lib/fontkit']) {
    try {
      const namespace = (await import(specifier)) as Record<string, unknown>
      for (const candidate of [namespace?.default, namespace]) {
        const value = candidate as { create?: unknown } | undefined
        if (value !== null && typeof value === 'object' && typeof value.create === 'function') {
          return makeFontkitAdapter(value as Record<string, unknown>)
        }
      }
    } catch {
      // Not installed — try the next candidate.
    }
  }
  return null
}

/**
 * System CJK candidates, cheapest-to-embed first.
 *
 * macOS paths come first because that is where this was developed, but the
 * Linux/Windows entries keep the list useful elsewhere.
 */
export const CJK_FONT_CANDIDATES: readonly string[] = [
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  'C:\\Windows\\Fonts\\msyh.ttc',
  'C:\\Windows\\Fonts\\simsun.ttc',
]

/** A font resolved from disk, ready to embed. */
export interface LoadedFont {
  path: string
  bytes: Uint8Array
  /** True when the face is expected to carry CJK glyphs. */
  cjk: boolean
}

/** Whether a string needs a CJK-capable font. */
export function needsCjkFont(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x3400 && code <= 0x9fff) return true
    if (code >= 0xf900 && code <= 0xfaff) return true
    if (code >= 0x3000 && code <= 0x303f) return true
    if (code >= 0xff00 && code <= 0xffef) return true
  }
  return false
}

/**
 * Resolve a font covering `text`, preferring an explicit path.
 *
 * Returns `null` rather than throwing when nothing is available, so a caller
 * can report the loss instead of failing the whole edit.
 */
export async function resolveFontForText(
  text: string,
  requestedPath?: string,
): Promise<LoadedFont | null> {
  const candidates = requestedPath !== undefined && requestedPath !== ''
    ? [requestedPath, ...CJK_FONT_CANDIDATES]
    : [...CJK_FONT_CANDIDATES]

  const wantCjk = needsCjkFont(text)
  const latinFallback: LoadedFont | null = null

  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const bytes = await readFile(path)
      return { path, bytes, cjk: wantCjk || /unicode|noto|hei|pingfang|song|yahei/i.test(path) }
    } catch {
      continue
    }
  }

  // No CJK face found. For pure-latin text the caller can still use a standard
  // font, so this is only a hard failure for CJK.
  return wantCjk ? null : latinFallback
}
