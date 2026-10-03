/**
 * Build the host bundle.
 *
 * ## Why dependencies stay external
 *
 * The host bundle is ESM loaded by the DSH host process. Three of this
 * plugin's dependencies cannot survive bundling:
 *
 *   - `@napi-rs/canvas` ships a native `.node` binary, which must be loaded
 *     from a real path on disk;
 *   - `pdfjs-dist` resolves its worker script by path and refuses to render in
 *     Node without it;
 *   - `tesseract.js` spawns a worker from a file path, and `tesseract.js-core`
 *     loads a WASM blob beside it.
 *
 * Bundling any of them produces a module that loads but fails on first use —
 * the worst failure shape. So every bare import stays external and resolves
 * from the profile's `node_modules`, which pnpm populates from `dependencies`.
 *
 * Only the plugin's own TypeScript is compiled and concatenated.
 *
 * @module dsh-pdf-studio/scripts/build
 */

import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outfile = join(root, 'lib', 'index.js')

/** Every bare specifier stays external — see the module comment. */
const externalPlugin = {
  name: 'externalize-bare-imports',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, args => ({ path: args.path, external: true }))
  },
}

await mkdir(join(root, 'lib'), { recursive: true })

const result = await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // The `.ts` specifiers in imports are part of the source convention; esbuild
  // resolves them natively, so no extension rewriting is needed.
  plugins: [externalPlugin],
})

if (result.errors.length > 0) {
  console.error('build failed')
  process.exitCode = 1
} else {
  const text = await readFile(outfile, 'utf8')
  await writeFile(outfile, text, 'utf8')
  console.log(`built ${outfile} (${(text.length / 1024).toFixed(1)}KB)`)
}
