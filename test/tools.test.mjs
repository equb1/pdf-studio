/**
 * Agent tool tests.
 *
 * The tools are the plugin's primary interface now, so this covers three
 * different things that can each fail independently:
 *
 *   1. **Registry shape.** The objects must match what the tool registry
 *      consumes. They are built here rather than by `defineTool` (which cannot
 *      be imported from this package — see `host/tools.ts`), so the shape is
 *      asserted rather than assumed.
 *   2. **Argument handling.** A malformed model call must produce a readable
 *      message, not a TypeError from inside a tool body.
 *   3. **Behaviour and safety.** Tools run against real files, and the source
 *      bytes must be untouched afterwards — the guarantee that makes them safe
 *      for an agent to call unattended.
 *
 * Run: node --experimental-strip-types test/tools.test.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { buildToolDefinitions } from '../src/host/tools.ts'

const CONTRACT = '/Users/Zhuanz/dsh-pdf-maker/demo/source/contract.pdf'
const SCAN = '/Users/Zhuanz/dsh-pdf-maker/demo/source/ceshi.pdf'
const OUT_DIR = '/tmp/pdf-studio-tools'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

console.log('agent tools\n')

// 这里测的是工具本身的机制，不是「执行前确认」本身，所以显式关掉确认闸门；
// 闸门行为由 test/confirmation.test.mjs 单独覆盖。
const tools = buildToolDefinitions({ workspaceRoot: OUT_DIR, confirmation: 'never' })
const byName = new Map(tools.map(tool => [tool.name, tool]))

// ── 1. registry shape ───────────────────────────────────────────────────────

check('the expected tools are defined', tools.length === 8, tools.map(t => t.name).join(', '))
for (const name of ['pdf_inspect', 'pdf_extract_text', 'pdf_make_searchable', 'pdf_edit_text', 'pdf_replace_line', 'pdf_watermark', 'pdf_protect', 'pdf_preview']) {
  check(`  ${name} is present`, byName.has(name))
}

{
  const tool = byName.get('pdf_inspect')
  check('every tool carries a description', typeof tool.description === 'string' && tool.description.length > 20)
  check('parameters are raw JSON Schema rooted at an object',
    tool.parameters.type === 'object' && typeof tool.parameters.properties === 'object',
    JSON.stringify(tool.parameters.type))
  check('required arguments are declared',
    Array.isArray(tool.parameters.required) && tool.parameters.required.includes('path'),
    JSON.stringify(tool.parameters.required))
  check('output declares a schema and a render function',
    tool.output !== undefined && typeof tool.output.render === 'function' && tool.output.schema !== undefined)
  check('every tool renders an ARRAY of content blocks (host contract)',
    tools.every(t => {
      const probe = t.name === 'pdf_preview'
        ? t.output.render({}, { text: 'x', images: [] })
        : t.output.render({}, { text: 'x' })
      return Array.isArray(probe)
    }),
    'a non-array return would throw assertRenderedContent at call time')
  check('execute is a function', typeof tool.execute === 'function')
  check('presentCall exists so a call renders as a card', typeof tool.presentCall === 'function')

  // The registry rejects an inferred `additionalProperties`, so every object
  // node in the schema tree must state it explicitly.
  // NESTED object nodes must state `additionalProperties`; the root parameters
  // object does not, which matches the shape the registry itself produces for a
  // parameter map. Asserting the stricter rule would test this compiler against
  // a contract the host does not actually impose.
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'object' && typeof node.additionalProperties !== 'boolean') {
      check(`  ${path} states additionalProperties explicitly`, false, JSON.stringify(node))
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.${key}`)
    if (node.items) walk(node.items, `${path}.items`)
  }
  for (const tool of tools) {
    for (const [key, child] of Object.entries(tool.parameters.properties ?? {})) {
      walk(child, tool.name + '.parameters.' + key)
    }
  }
  check('output schemas state additionalProperties explicitly',
    tools.every(tool => typeof tool.output.schema.additionalProperties === 'boolean'))
}

// ── 2. argument handling ────────────────────────────────────────────────────

{
  const tool = byName.get('pdf_inspect')
  let message = ''
  try { await tool.execute({}) } catch (error) { message = error.message }
  check('a missing required argument is reported readably', message.includes('path is required'), message)

  let enumMessage = ''
  try { await byName.get('pdf_watermark').execute({ path: CONTRACT, action: 'nonsense' }) }
  catch (error) { enumMessage = error.message }
  check('an out-of-enum argument is reported readably', enumMessage.includes('must be one of'), enumMessage)

  let typeMessage = ''
  try { await byName.get('pdf_inspect').execute({ path: 42 }) } catch (error) { typeMessage = error.message }
  check('a wrong-typed argument is reported readably', typeMessage.includes('must be a string'), typeMessage)
}

// ── 3. behaviour on real files ──────────────────────────────────────────────

const originalHashes = {
  contract: sha(new Uint8Array(await readFile(CONTRACT))),
  scan: sha(new Uint8Array(await readFile(SCAN))),
}

/** Run a tool and return its rendered text. */
async function runTool(name, args) {
  const tool = byName.get(name)
  const value = await tool.execute(args)
  // `output.render` must return an ARRAY of content blocks — the host's
  // `assertRenderedContent` throws otherwise. `[0].text` is the text block.
  const rendered = tool.output.render(args, value)
  assert.ok(Array.isArray(rendered), 'output.render must return an array')
  return rendered[0].text
}

{
  const text = await runTool('pdf_inspect', { path: CONTRACT })
  check('pdf_inspect reports the page count', text.includes('1 页'), text.split('\n')[0])
  check('pdf_inspect reports the page size', text.includes('595'), text.split('\n')[1])
}

{
  const text = await runTool('pdf_inspect', { path: CONTRACT, runs: true })
  check('pdf_inspect lists editable runs when asked', text.includes('可编辑文字块：13 个'), text.split('\n')[2])
  check('a run carries its id, size and decoded text', /1:6｜22pt｜服\s*务\s*合\s*同/.test(text))
}

{
  const text = await runTool('pdf_extract_text', { path: CONTRACT })
  check('pdf_extract_text returns readable lines with coordinates',
    text.includes('服务合同') && /x=\d+/.test(text), text.split('\n')[1])
}

{
  const text = await runTool('pdf_protect', { path: CONTRACT, action: 'check' })
  check('pdf_protect check reports an unencrypted file', text.includes('未加密'), text)
}

{
  const text = await runTool('pdf_watermark', { path: CONTRACT, action: 'scan' })
  check('pdf_watermark scan finds nothing on a clean file', text.includes('0 个可移除候选'), text.split('\n')[0])
  check('scan explains what it cannot handle instead of implying "clean"',
    text.includes('不做处理'), text.split('\n').slice(-1)[0])
}

{
  const text = await runTool('pdf_watermark', {
    path: CONTRACT, action: 'add', text: '机密请勿外传', output: 'wm.pdf',
  })
  check('pdf_watermark add writes a new file', text.includes('/tmp/pdf-studio-tools/wm.pdf'), text.split('\n')[0])
  const rescan = await runTool('pdf_watermark', { path: '/tmp/pdf-studio-tools/wm.pdf', action: 'scan' })
  check('the added watermark is found again', rescan.includes('1 个可移除候选'), rescan.split('\n')[0])
}

{
  const text = await runTool('pdf_edit_text', {
    path: CONTRACT,
    edits: [{ page: 1, targetId: '1:76', to: '四、保密条款：已由法务修订。' }],
    output: 'edited.pdf',
  })
  check('pdf_edit_text reports the applied count', text.includes('应用 1 处改写'), text.split('\n')[1])
  check('pdf_edit_text warns that ids shift', text.includes('id 会整体前移'))
}

{
  const text = await runTool('pdf_protect', {
    path: CONTRACT, action: 'encrypt', password: 'pw123', output: 'locked.pdf',
  })
  check('pdf_protect encrypt reports a password-gated file',
    text.includes('需要密码才能打开：true'), text.split('\n')[1])
  const check2 = await runTool('pdf_protect', { path: '/tmp/pdf-studio-tools/locked.pdf', action: 'check' })
  check('the produced file reads back as encrypted', check2.includes('已加密'), check2)
}

{
  // The scrub tool must refuse to write when the caller names the source.
  let message = ''
  try {
    await byName.get('pdf_watermark').execute({
      path: CONTRACT, action: 'add', text: 'x', output: CONTRACT,
    })
  } catch (error) { message = error.message }
  check('a tool refuses to overwrite its own source', message.includes('不能与源文件相同'), message)
}

// ── inline preview ──────────────────────────────────────────────────────────
//
// The visual half of the interaction: a page rendered as an image block that the
// built-in image card displays in the conversation. No client-side plugin is
// involved, which is why this is testable here at all.

{
  const saved = []
  const sink = {
    async saveImages(inputs) {
      for (const input of inputs) saved.push(input)
      return inputs.map((input, n) => ({
        attachmentId: 'att' + n, mediaType: 'image/png', bytes: input.data.length,
        width: 800, height: 1130, name: input.name,
      }))
    },
  }
  const withSink = new Map(
    buildToolDefinitions({ workspaceRoot: OUT_DIR, attachments: sink }).map(t => [t.name, t]),
  )
  const tool = withSink.get('pdf_preview')

  const value = await tool.execute({ path: CONTRACT, pages: [1] })
  const parts = tool.output.render({}, value)
  check('preview returns a text block plus an image block',
    parts.length === 2 && parts[0].type === 'text' && parts[1].type === 'image',
    parts.map(p => p.type).join(','))
  check('the image block carries an attachment reference',
    parts[1].attachment !== undefined && typeof parts[1].attachment.attachmentId === 'string',
    JSON.stringify(parts[1].attachment))
  check('a real PNG was handed to the attachment sink',
    saved.length === 1 && saved[0].mediaType === 'image/png' && saved[0].data.length > 10000,
    saved.map(x => `${(x.data.length / 1024).toFixed(0)}KB`).join(','))
  check('the PNG signature is valid',
    saved[0].data[0] === 0x89 && saved[0].data[1] === 0x50, String(saved[0].data[0]))

  // The page list is bounded so a stray request cannot flood the conversation.
  saved.length = 0
  const many = await tool.execute({ path: CONTRACT, pages: [1, 2, 3, 4, 5, 6] })
  check('at most four pages are rendered per call', saved.length <= 4, String(saved.length))
  void many

  // Without the service the tool must explain itself, never throw.
  const bare = new Map(buildToolDefinitions({ workspaceRoot: OUT_DIR }).map(t => [t.name, t]))
  const fallback = bare.get('pdf_preview').output.render({}, await bare.get('pdf_preview').execute({ path: CONTRACT }))
  check('preview degrades to text when the host has no attachment service',
    fallback.length === 1 && fallback[0].type === 'text' && fallback[0].text.includes('附件服务'),
    JSON.stringify(fallback[0].text).slice(0, 60))
}

// ── the safety invariant ────────────────────────────────────────────────────

check('the born-digital source is byte-identical after every tool ran',
  sha(new Uint8Array(await readFile(CONTRACT))) === originalHashes.contract)
check('the scanned source is byte-identical after every tool ran',
  sha(new Uint8Array(await readFile(SCAN))) === originalHashes.scan)
check('the tools wrote their outputs beside the requested location',
  existsSync('/tmp/pdf-studio-tools/wm.pdf') && existsSync('/tmp/pdf-studio-tools/edited.pdf'))

console.log(`\n${failed === 0 ? 'ALL TOOL CHECKS PASSED' : failed + ' check(s) FAILED'}`)
if (failed > 0) process.exitCode = 1
