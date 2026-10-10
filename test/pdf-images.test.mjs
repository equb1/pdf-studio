/**
 * 图片导出 / 合成测试。
 *
 * 这组能力的验收标准是"**文件真的存在、格式真的对、尺寸真的对**"：导出看魔法字节与像素尺寸，
 * 合成看页数与页面几何，最后一圈用 QuickLook（独立渲染器）验证"导出的图放回 PDF 后长得还是那样"。
 *
 * Run: node --experimental-strip-types test/pdf-images.test.mjs
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { buildToolDefinitions } from '../src/host/tools.ts'
import { openPdf, pageSize } from '../src/core/pdf.ts'
import { runQpdf } from '../src/core/qpdf.ts'

const require = createRequire(import.meta.url)
const { createCanvas, loadImage } = require('@napi-rs/canvas')

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

const WORK = mkdtempSync(join(tmpdir(), 'pdf-images-'))
const SRC = join(WORK, 'src.pdf')
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let n = 1; n <= 3; n += 1) {
    const page = doc.addPage([400, 300])
    page.drawRectangle({ x: 20, y: 20, width: 360, height: 260, color: rgb(0.9, 0.95, 0.9) })
    page.drawText(`IMAGE-FIXTURE-PAGE-${n}`, { x: 40, y: 150, size: 20, font })
  }
  await writeFile(SRC, await doc.save())
}
const srcSha = sha(await readFile(SRC))
const toolsNever = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'never' }).map(d => [d.name, d]))
const toolsGated = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'destructive' }).map(d => [d.name, d]))
const run = args => toolsNever.get('pdf_images').execute(args).then(value => value.text)

const isPng = path => {
  const head = readFileSync(path).subarray(0, 4)
  return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
}
const isJpeg = path => {
  const head = readFileSync(path).subarray(0, 3)
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
}

// ── 1. 导出 PNG ───────────────────────────────────────────────────────────
const pngDir = join(WORK, 'png')
{
  await run({ path: SRC, action: 'export', pages: '1-2', format: 'png', scale: 1, outputDir: pngDir })
  const files = readdirSync(pngDir).sort()
  check('export PNG：按页生成文件', files.length === 2, files.join(', '))
  check('export PNG：文件名带页号', files[0].endsWith('-p1.png') && files[1].endsWith('-p2.png'), files.join(', '))
  check('export PNG：文件是真正的 PNG（魔法字节）', files.every(name => isPng(join(pngDir, name))))
  check('export PNG：文件不是空的（> 5KB）', files.every(name => statSync(join(pngDir, name)).size > 5000),
    files.map(name => `${(statSync(join(pngDir, name)).size / 1024).toFixed(0)}KB`).join(', '))
  const image = await loadImage(readFileSync(join(pngDir, files[0])))
  check('export PNG：像素尺寸 = 页面尺寸 × scale（400×300）', image.width === 400 && image.height === 300, `${image.width}×${image.height}`)

  const oddDir = join(WORK, 'png-odd')
  await run({ path: SRC, action: 'export', pages: 'odd', format: 'png', scale: 1, outputDir: oddDir })
  check('export：pages=odd 只导出奇数页', readdirSync(oddDir).length === 2, readdirSync(oddDir).join(', '))
}

// ── 2. 导出 JPEG ──────────────────────────────────────────────────────────
const jpgDir = join(WORK, 'jpg')
{
  await run({ path: SRC, action: 'export', pages: '1', format: 'jpeg', quality: 0.8, scale: 1, outputDir: jpgDir })
  const files = readdirSync(jpgDir)
  check('export JPEG：生成 1 个 .jpg', files.length === 1 && files[0].endsWith('.jpg'), files.join(', '))
  check('export JPEG：文件是真正的 JPEG（魔法字节）', isJpeg(join(jpgDir, files[0])))
  const jpegSize = statSync(join(jpgDir, files[0])).size
  const pngSize = statSync(join(pngDir, readdirSync(pngDir).sort()[0])).size
  check('export JPEG：同样内容比 PNG 小（质量 0.8）', jpegSize < pngSize, `jpeg=${(jpegSize / 1024).toFixed(0)}KB png=${(pngSize / 1024).toFixed(0)}KB`)
}

// ── 3. 合成 PDF ───────────────────────────────────────────────────────────
{
  const pngs = readdirSync(pngDir).sort().map(name => join(pngDir, name))
  const jpg = join(jpgDir, readdirSync(jpgDir)[0])

  const fitOut = join(WORK, 'built-fit.pdf')
  await run({ action: 'build', images: pngs, pageSize: 'fit', output: fitOut })
  const fitDoc = await openPdf(fitOut)
  const fitSize = await pageSize(fitDoc, 1)
  check('build fit：页数 = 图片数', fitDoc.numPages === 2, String(fitDoc.numPages))
  check('build fit：页面尺寸 = 图片像素尺寸（1 倍率下 400×300）',
    Math.abs(fitSize.width - 400) < 1 && Math.abs(fitSize.height - 300) < 1,
    `${fitSize.width.toFixed(0)}×${fitSize.height.toFixed(0)}`)
  await fitDoc.destroy?.()

  const a4Out = join(WORK, 'built-a4.pdf')
  await run({ action: 'build', images: [...pngs, jpg], pageSize: 'a4', margin: 24, output: a4Out })
  const a4Doc = await openPdf(a4Out)
  const a4Size = await pageSize(a4Doc, 3)
  check('build a4：页数 = 图片数（PNG 与 JPEG 可混用）', a4Doc.numPages === 3, String(a4Doc.numPages))
  check('build a4：页面尺寸 = A4（595×842 ±1pt）',
    Math.abs(a4Size.width - 595.28) < 1 && Math.abs(a4Size.height - 841.89) < 1,
    `${a4Size.width.toFixed(1)}×${a4Size.height.toFixed(1)}`)
  await a4Doc.destroy?.()

  const qpdf = await runQpdf(['--check'], new Uint8Array(await readFile(a4Out)), 'read-only')
  check('build 产物通过 qpdf --check', qpdf.exit === 0, `exit=${qpdf.exit}`)
}

// ── 4. 错误路径 ───────────────────────────────────────────────────────────
{
  const fail = async (args) => {
    try { await toolsNever.get('pdf_images').execute(args) } catch (error) { return error.message }
    return ''
  }
  check('未知 action：中文错误', (await fail({ action: 'convert', path: SRC })).includes('未知 action'))
  check('未知 format：中文错误', (await fail({ path: SRC, action: 'export', format: 'webp', outputDir: join(WORK, 'x') })).includes('不支持'))
  check('未知 pageSize：中文错误', (await fail({ action: 'build', images: [join(jpgDir, readdirSync(jpgDir)[0])], pageSize: 'a3', output: join(WORK, 'x.pdf') })).includes('不支持'))
  check('build 缺 images：中文错误', (await fail({ action: 'build', output: join(WORK, 'y.pdf') })).includes('images'))
  check('build 缺 output：中文错误', (await fail({ action: 'build', images: [join(jpgDir, readdirSync(jpgDir)[0])] })).includes('output'))
  check('build 图片不存在：中文错误并指出第几张',
    (await fail({ action: 'build', images: ['/tmp/definitely-missing-xyz.png'], output: join(WORK, 'z.pdf') })).includes('第 1 张图片不存在'))
}

// ── 5. 门控 ───────────────────────────────────────────────────────────────
{
  const gatedDir = join(WORK, 'gated')
  const plan = (await toolsGated.get('pdf_images').execute({
    path: SRC, action: 'export', pages: '1', outputDir: gatedDir,
  })).text
  check('未确认：返回确认单', plan.includes('需要你确认'), plan.split('\n')[0].slice(0, 50))
  check('未确认：不生成任何图片', !existsSync(gatedDir) || readdirSync(gatedDir).length === 0)
  const planId = /计划 id：(p_\w+)/.exec(plan)?.[1]

  let tampered = ''
  try {
    await toolsGated.get('pdf_images').execute({
      path: SRC, action: 'export', pages: '1', scale: 3, outputDir: gatedDir, confirm: planId,
    })
  } catch (error) { tampered = error.message }
  check('改参数（scale）后带旧 planId：拒绝', tampered.includes('不一致'), tampered.split('\n')[0].slice(0, 50))

  await toolsGated.get('pdf_images').execute({ path: SRC, action: 'export', pages: '1', outputDir: gatedDir, confirm: planId })
  check('参数一致时带令牌可以执行', existsSync(gatedDir) && readdirSync(gatedDir).length === 1)

  let replay = ''
  try {
    await toolsGated.get('pdf_images').execute({ path: SRC, action: 'export', pages: '1', outputDir: gatedDir, confirm: planId })
  } catch (error) { replay = error.message }
  check('同一令牌不能重复执行', replay.includes('已经执行过一次'), replay.slice(0, 50))
  check('源 PDF 未被改动（sha256 不变）', sha(await readFile(SRC)) === srcSha)
}

// ── 6. 往返：导出的图放回 PDF，独立渲染器看还是一样 ───────────────────────
{
  let quickLook = true
  try { execFileSync('qlmanage', ['-h'], { stdio: 'ignore' }) } catch { quickLook = false }
  if (!quickLook) {
    check('QuickLook 往返渲染断言（本机没有 qlmanage，跳过）', true, 'SKIP')
  } else {
    try {
      const render = (pdf, tag) => {
        const dir = join(WORK, `ql-${tag}`)
        mkdirSync(dir, { recursive: true })
        execFileSync('qlmanage', ['-t', '-s', '900', '-o', dir, pdf], { stdio: 'ignore' })
        const png = readdirSync(dir).find(name => name.endsWith('.png'))
        if (png === undefined) throw new Error(`QuickLook 没有为 ${pdf} 出图`)
        return join(dir, png)
      }
      // 源文件第 1 页（单页抽出）与 build fit 出的第 1 页对比：内容应基本一致
      const single = join(WORK, 'single.pdf')
      const arrange = new Map(buildToolDefinitions({ workspaceRoot: WORK, confirmation: 'never' }).map(d => [d.name, d]))
      await arrange.get('pdf_arrange').execute({ path: SRC, order: '1', output: single })
      const a = await loadImage(await readFile(render(single, 'src')))
      const b = await loadImage(await readFile(render(join(WORK, 'built-fit.pdf'), 'built')))
      const pixels = async image => {
        const canvas = createCanvas(image.width, image.height)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(image, 0, 0)
        return { data: ctx.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height }
      }
      const pa = await pixels(a)
      const pb = await pixels(b)
      const width = Math.min(pa.width, pb.width)
      const height = Math.min(pa.height, pb.height)
      let diff = 0
      const total = width * height
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const ia = (y * pa.width + x) * 4
          const ib = (y * pb.width + x) * 4
          const delta = Math.max(Math.abs(pa.data[ia] - pb.data[ib]), Math.abs(pa.data[ia + 1] - pb.data[ib + 1]), Math.abs(pa.data[ia + 2] - pb.data[ib + 2]))
          if (delta > 24) diff += 1
        }
      }
      check('往返：导出→合成后，独立渲染与源页基本一致（差异 < 5%）',
        diff / total < 0.05, `${diff}/${total} = ${(diff / total * 100).toFixed(2)}%`)
    } catch (error) {
      check('QuickLook 往返渲染断言', false, error.message.slice(0, 100))
    }
  }
}

rmSync(WORK, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'ALL PDF-IMAGES CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
