/**
 * 矩形密文：把指定矩形区域里的**文字真的从内容流里删掉**，再用色块盖住。
 *
 * ## 为什么不能只"画黑框"
 *
 * 只画黑框是**假密文**：文字还在内容流里，复制/搜索/提取照样能拿到——这是真实事故的常见成因。
 * 所以这里的做法是：定位每一条文字绘制指令 → 与矩形求交 → **把指令从内容流里删掉** →
 * 再补一个色块。验收标准也据此确定：**删除后再提取，那行字必须彻底消失**。
 *
 * ## 明确不做的部分（与纪律①一致）
 *
 * - **扫描件（整页图片）里的内容不做修补**：图片像素在 XObject 里，真删需要重画像素或栅格化整页。
 *   本工具会识别出这类页并在结果里**如实说明**，只做视觉遮盖，让人自己决定要不要发布。
 * - **矢量图形按整条路径判定，但有两条限制**：只删"与目标行相交"的矩形路径，且跳过面积 ≥ 页面 40% 的
 *   大矩形（页面白底/整页底色就是这种，删了会让画布露出未绘制区域、渲染成黑带）。结果里会报告删了多少条。
 * - **文字命中用"行带"判定**（基线落在目标行垂直带内 + 水平重叠），不用距离容差——水印常是
 *   "小字号 + 大 CTM 缩放"，容差会按缩放放大到几十 pt 而误伤邻近正文行（实测 + 回归测试在案）。
 * - **写盘前复核**：重新提取受影响页的文字，只要**目标之外的行少了一行就拒绝输出**。
 * - 改流的方式是**字节级替换**（把命中的字符串操作数换成空串），不重新序列化整条流——
 *   真文件的内容流里可能有内联图片等二进制片段，token 往返会破坏它们（实测整页渲染变暗）。
 * - 字体子集里残留的字形轮廓不清理（提取不出文字，但高级取证仍可能还原轮廓）——要更强保证，
 *   应当**只发布导出的图片**而不是这份 PDF。
 */

import { deflateSync } from 'node:zlib'
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, rgb } from 'pdf-lib'
import { locateShowText, parseOperations, showStrings, tokenize, type Operation } from './content-stream.ts'
import { listReadableRuns, readPageContentStreams } from './text-editor.ts'
import { readPageFonts } from './font-map.ts'
import { finalGraphicsState, IDENTITY_MATRIX, matrixXScale, multiplyMatrices, trackGraphicsState } from './line-redraw.ts'
import { openPdfBytes } from './pdf.ts'
import { extractTextLayer } from './text-layer.ts'

/** 一个待删除的矩形（页面坐标，pt，原点左下）。 */
export interface RedactBox {
  page: number
  x: number
  y: number
  width: number
  height: number
}

/** 密文执行报告（结果文本与测试都用它）。 */
export interface RedactReport {
  /** 删掉的文字绘制指令数。 */
  removedShows: number
  /** 删掉的注释数（注释里可能带文字）。 */
  removedAnnots: number
  /** 命中的矢量路径指令数。 */
  removedPaths: number
  /** 只含图片、无法做内容修补的页。 */
  imageOnlyPages: number[]
  /** 含图片对象的页（扫描件的典型特征：整页图片 + 可能叠了一层不可见 OCR 文字）。 */
  imagePages: number[]
  /** 每个矩形实际覆盖的页。 */
  boxes: RedactBox[]
}

const intersects = (
  box: { x: number; y: number; width: number; height: number },
  other: { x: number; y: number; width: number; height: number },
): boolean => box.x < other.x + other.width && other.x < box.x + box.width
  && box.y < other.y + other.height && other.y < box.y + box.height

/** 估算一条文字指令占的宽度（pt）。宁可略宽，避免"看起来删了其实还留一半"。 */
function estimateWidth(operation: Operation, fontSize: number): number {
  let glyphs = 0
  for (const token of showStrings(operation)) {
    const raw = token.raw
    glyphs += raw.startsWith('<') || raw.startsWith('[') ? Math.ceil(raw.length / 2) : raw.length
  }
  // 中文按 1em、拉丁按 0.6em 估；都再加一成余量。
  return Math.max(fontSize * 0.6, glyphs * fontSize * 0.75) * 1.1
}

/**
 * 递归清理 **Form XObject** 里的文字。
 *
 * 真实文件的正文经常不在页面自己的内容流里，而在 `/Resources /XObject` 的 Form 里
 * （实测：某试卷页 8 段页面级流只画了表格与页眉，正文在 XObject 中——只改页面级流会
 * "报告删了、其实一行没删"）。XObject 每段只有一个流，所以这里用**原地字节替换**写回。
 */
function redactForms(
  context: { lookup(ref: unknown): unknown; register(value: unknown): unknown; obj(value: unknown): unknown },
  resources: unknown,
  boxes: readonly RedactBox[],
  report: RedactReport,
  depth = 0,
): void {
  if (depth > 4) return
  const dict = resources instanceof PDFDict ? resources : undefined
  const xobjects = dict?.lookup(PDFName.of('XObject'), PDFDict)
  if (!(xobjects instanceof PDFDict)) return
  for (const key of xobjects.keys()) {
    const entryRef = xobjects.get(key as never)
    const entry = context.lookup(entryRef)
    if (!(entry instanceof PDFRawStream)) continue
    const subtype = entry.dict.get(PDFName.of('Subtype'))
    if (subtype === undefined || String(subtype) !== '/Form') continue
    let text: string
    try {
      text = Buffer.from(decodePDFRawStream(entry as never).decode()).toString('latin1')
    } catch {
      continue
    }
    const operations = parseOperations(tokenize(text))
    const shows = locateShowText(operations)
    const drop = new Set<number>()
    for (const show of shows) {
      const size = show.fontSize ?? 10
      const rect = { x: show.x, y: show.y - size * 0.25, width: estimateWidth(operations[show.index], size), height: size * 1.25 }
      if (boxes.some(box => intersects(rect, box))) drop.add(show.index)
    }
    if (drop.size > 0) {
      const ranges: Array<{ start: number; end: number; replacement: string }> = []
      for (const index of drop) {
        for (const token of showStrings(operations[index])) {
          ranges.push({ start: token.start, end: token.end, replacement: token.raw.startsWith('<') ? '<>' : '()' })
        }
      }
      ranges.sort((a, b) => b.start - a.start)
      let rebuilt = text
      for (const range of ranges) {
        const pad = ' '.repeat(Math.max(0, range.end - range.start - range.replacement.length))
        rebuilt = rebuilt.slice(0, range.start) + range.replacement + pad + rebuilt.slice(range.end)
      }
      const deflated = new Uint8Array(deflateSync(Buffer.from(rebuilt, 'latin1')))
      const fresh = PDFRawStream.of(context.obj({ ...entry.dict.entries(), Filter: 'FlateDecode', Length: deflated.length }) as never, deflated)
      xobjects.set(key as never, context.register(fresh) as never)
      report.removedShows += drop.size
    }
    // 继续往里走（Form 里还能嵌 Form）
    redactForms(context, entry.dict.get(PDFName.of('Resources')), boxes, report, depth + 1)
  }
}

/**
 * 执行密文。源字节不变，返回新字节与报告。
 */
export async function redactPages(
  bytes: Uint8Array,
  options: {
    boxes: readonly RedactBox[]
    color?: string
    /** 每页"框内原本有哪些文字"（来自文字层）。给了它就**按内容匹配**删。 */
    targetsByPage?: ReadonlyMap<number, readonly string[]>
    /**
     * 每页"框内那些行的矩形"（来自文字层）。
     *
     * 这是最可靠的匹配依据：**只有这些行才是候选**，其余行永不参与，
     * 从构造上排除"顺手删掉框外正文"。指令的**基线 y** 与行的**顶边**对齐
     * （实测：行 rect.y+height ≈ 指令 y ± 1pt），据此加 x 重叠判定。
     */
    targetLinesByPage?: ReadonlyMap<number, ReadonlyArray<{ x: number; y: number; width: number; height: number }>>
  },
): Promise<{ bytes: Uint8Array; report: RedactReport }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const context = doc.context as unknown as {
    lookup(ref: unknown): unknown
    register(value: unknown): unknown
    obj(value: unknown): unknown
  }
  const boxColor = options.color ?? '#000000'
  const match = /^#?([0-9a-fA-F]{6})$/.exec(boxColor.trim())
  if (match === null) throw new Error(`密文色块颜色 "${boxColor}" 不是 #rrggbb 形式`)
  const value = Number.parseInt(match[1], 16)
  const color = { r: ((value >> 16) & 0xff) / 255, g: ((value >> 8) & 0xff) / 255, b: (value & 0xff) / 255 }

  const report: RedactReport = { removedShows: 0, removedAnnots: 0, removedPaths: 0, imageOnlyPages: [], imagePages: [], boxes: [...options.boxes] }
  const byPage = new Map<number, RedactBox[]>()
  for (const box of options.boxes) {
    const list = byPage.get(box.page) ?? []
    list.push(box)
    byPage.set(box.page, list)
  }

  // 复核用的"删除前文字快照"：只取本次要动的页（其它页不受影响，没必要解析）。
  // 写盘前会用它做"其它行一个都不能少"的最后检查——见函数末尾。
  const beforeLinesByPage = new Map<number, readonly string[]>()
  try {
    const probe = await openPdfBytes(detachedSafeCopy(bytes))
    for (const pageNumber of byPage.keys()) {
      const lines = await extractTextLayer(probe, pageNumber)
      beforeLinesByPage.set(pageNumber, lines.map(line => line.text))
    }
  } catch { /* 提取不了就不做复核：宁可少一道检查，也不要因为复核失败而阻断正常删除 */ }

  const pages = doc.getPages()
  for (const [pageNumber, boxes] of byPage) {
    const page = pages[pageNumber - 1]
    if (page === undefined) throw new Error(`密文框指定了第 ${pageNumber} 页，但文档只有 ${pages.length} 页`)

    // ① 读内容流 → 找出落在框里的文字指令并删除。
    //
    // 写回必须**按引用身份替换**：真实文件一页常有 8 段内容流，`/Contents` 也可能是
    // 间接数组甚至继承自页树。用下标 `set()` 会改错位置（实测：命中的流没动、另一段被写坏，
    // 于是"报告删了 6 条、其实一行没删"）。这里改为：
    //   读 → 用 `.Contents()`（与读路径同一个访问器）拿到**全部** ref
    //   写 → 把命中的 ref 换成新 ref，其余原样，最后显式写回整个数组。
    const streams = readPageContentStreams(page as never, context as never)
    // 内容流是**顺序拼接**执行的：前一条流里设的 `cm` 会影响后面的流
    // （`pdf_layout resize` 生成的页面就是"前缀流设缩放 + 原流画字"）。
    // `trackGraphicsState` 只看单条流、从单位矩阵起算，所以这里自己跨流累积。
    let carryCtm = IDENTITY_MATRIX
    const parts: string[] = []
    let anyHit = false
    const targets = options.targetsByPage?.get(pageNumber) ?? []
    const targetLines = options.targetLinesByPage?.get(pageNumber) ?? []
    // 按内容匹配需要"每条文字指令解出来的文字"：用文字编辑链路里的同一套解码（ToUnicode）。
    const fonts = readPageFonts(context as never, page as never)
    const runs = listReadableRuns(streams, fonts)
    let sawText = false
    for (const stream of streams) {
      const operations = parseOperations(tokenize(stream.text))
      const shows = locateShowText(operations)
      if (shows.length > 0) sawText = true
      const drop = new Set<number>()
      const states = trackGraphicsState(operations)
      // ① 内容匹配（字体有 ToUnicode 时最准）——但**必须再用几何确认一次**。
      // 只按"文字包含"匹配会被短片段坑到：真文件里别处一个单字/短串恰好是目标串的子串，
      // 就会被一起抹掉（实测：删答案页水印时连带删掉了相邻一行答案）。
      for (const run of runs) {
        if (run.streamIndex !== stream.index) continue
        const text = run.text?.trim() ?? ''
        if (text.length === 0) continue
        if (!targets.some(target => target.includes(text))) continue
        if (targetLines.length === 0) { drop.add(run.operationIndex); continue }
        // 与 show 路径同样的换算：run 的 x/y 是文本空间，要乘 `ctm` 才落到页面空间
        const runState = states.get(run.operationIndex)
        const runTotal = multiplyMatrices(carryCtm, runState?.ctm ?? IDENTITY_MATRIX)
        const runX = runTotal.a * run.x + runTotal.c * run.y + runTotal.e
        const runY = runTotal.b * run.x + runTotal.d * run.y + runTotal.f
        // 与 show 同规则：基线必须在目标行的垂直带内、且水平有重叠
        const inTargetLine = targetLines.some(line =>
          runY >= line.y - 2 && runY <= line.y + line.height + 2
          && runX >= line.x - 1 && runX <= line.x + line.width + 1)
        if (inTargetLine) drop.add(run.operationIndex)
      }
      // ② 几何匹配：**只在"框内目标行"里找**，其余行永不参与（构造上排除误删）。
      //
      // 关键：指令的 `x/y` 是**文本空间**坐标，而文字层的行矩形是**页面空间**坐标。
      // 中间隔着 `tm × ctm`（`resize` 这类前插 `cm` 的页面尤其明显：文本 y=300 在页面上是 540）。
      // 所以必须用 `trackGraphicsState` 给出的 `trm` 把指令原点映射到页面空间再比。
      for (const show of shows) {
        const size = show.fontSize ?? 10
        const state = states.get(show.index)
        // 注意：`show.x/y` 已经是**用户空间**里的文字原点（locateShowText 自己跟了 Tm/Td），
        // 所以这里只需再乘 **CTM**（乘 `trm` 会重复计算 tm 的平移）。
        const total = multiplyMatrices(carryCtm, state?.ctm ?? IDENTITY_MATRIX)
        const scale = Math.max(0.01, matrixXScale(total))
        const originX = total.a * show.x + total.c * show.y + total.e
        const originY = total.b * show.x + total.d * show.y + total.f
        const showLeft = originX
        const showRight = originX + estimateWidth(operations[show.index], size) * scale
        for (const line of targetLines) {
          // **判定规则：基线落在该行的垂直带内（±2pt）且水平与该行有重叠。**
          // 这里刻意不用"距离容差"：水印常是"小字号 + 放大十几倍的 CTM"，
          // 按 `size × scale` 算出来的容差会有几十 pt，把邻近正文行一起圈进来
          // （实测：删答案页水印把 25pt 外的一行答案也删了；回归夹具复现了同一现象）。
          // 行内基线位置差异（顶/底/居中）本来就落在行带内，用行带表达既准确又不受缩放影响。
          const inBand = originY >= line.y - 2 && originY <= line.y + line.height + 2
          const overlapsX = showRight >= line.x - 1 && showLeft <= line.x + line.width + 1
          if (inBand && overlapsX) {
            drop.add(show.index)
            break
          }
        }
      }
      // 命中的矢量路径：`re`（矩形）路径整体删除
      for (const operation of operations) {
        if (operation.op !== 're') continue
        const numbers = operation.operands.filter(token => token.kind === 'number').map(token => Number(token.raw))
        if (numbers.length < 4) continue
        const rect = { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] }
        // 只删**与目标行相交**的路径，且跳过"大面积矩形"：页面白底/整页底色就是这种，
        // 它跟水印无关，删了会让画布露出未绘制区域（实测渲染出黑带）。
        const pageArea = page.getWidth() * page.getHeight()
        if (rect.width * rect.height >= pageArea * 0.4) continue
        const hitsTargetLine = targetLines.some(line => intersects(rect, { x: line.x, y: line.y, width: line.width, height: line.height }))
        if (hitsTargetLine && boxes.some(box => intersects(rect, box))) {
          drop.add(operations.indexOf(operation))
        }
      }
      // 注意：**每一段流都要进 parts**（没命中的原样进），否则合并时会把它们整段丢掉。
      // **字节级**外科手术：只把命中的文字操作数原地换成空串 `()`（或 `<>`），
      // 其余字节一个不动。为什么不整条流重新序列化：真文件的内容流里可能有内联图片
      // 等二进制片段，token 往返会破坏它们——实测整片页面变暗（渲染抽样 44,44,44），
      // 而"只改这几个字节"是可以用字节比对证明的。
      const ranges: Array<{ start: number; end: number; replacement: string }> = []
      for (const index of drop) {
        for (const token of showStrings(operations[index])) {
          const hex = token.raw.startsWith('<')
          ranges.push({ start: token.start, end: token.end, replacement: hex ? '<>' : '()' })
        }
      }
      ranges.sort((a, b) => b.start - a.start)
      let rebuilt = stream.text
      for (const range of ranges) {
        const pad = ' '.repeat(Math.max(0, range.end - range.start - range.replacement.length))
        rebuilt = rebuilt.slice(0, range.start) + range.replacement + pad + rebuilt.slice(range.end)
      }
      report.removedShows += drop.size
      if (drop.size > 0) anyHit = true
      parts.push(rebuilt)
      // 这条流结束后，它的图像状态（如缩放 cm）会带到下一条流
      carryCtm = multiplyMatrices(carryCtm, finalGraphicsState([stream.text]))
    }

    // 写回：**把这一页的所有内容流合并成一条新流**整体替换 `/Contents`。
    // 为什么不按引用/下标去改数组：`/Contents` 可能是直接数组、间接数组、甚至继承自页树，
    // 实测下标 `set()` 与引用身份匹配都会"改到不相干的位置，原流原样保留"（最小复现：
    // 输出成了 [2, 226, 2, 106]，原 226 字节那段没动）。合并成一条流不依赖任何数组语义。
    // 每段源流各自用 `q … Q` 包住，避免跨流的图形状态互相影响。
    if (anyHit) {
      const merged = parts.map(part => `q\n${part}\nQ`).join('\n')
      const deflated = new Uint8Array(deflateSync(Buffer.from(merged, 'latin1')))
      const dict = context.obj({ Filter: 'FlateDecode', Length: deflated.length })
      const fresh = PDFRawStream.of(dict as never, deflated)
      page.node.set(PDFName.of('Contents'), context.register(fresh) as never)
    }

    // ② 落在框里的注释：一并删除（注释正文也可能泄露信息）。
    const annots = page.node.Annots()
    if (annots instanceof PDFArray) {
      const keep: unknown[] = []
      for (const entry of annots.asArray()) {
        const dict = context.lookup(entry)
        const rectRaw = (dict as { get?(key: unknown): unknown } | undefined)?.get?.(PDFName.of('Rect'))
        const rect = rectRaw instanceof PDFArray
          ? {
              x: Number(String(rectRaw.get(0))),
              y: Number(String(rectRaw.get(1))),
              width: Number(String(rectRaw.get(2))) - Number(String(rectRaw.get(0))),
              height: Number(String(rectRaw.get(3))) - Number(String(rectRaw.get(1))),
            }
          : undefined
        if (rect !== undefined && boxes.some(box => intersects(rect, box))) {
          report.removedAnnots += 1
          continue
        }
        keep.push(entry)
      }
      if (keep.length !== annots.size()) {
        if (keep.length === 0) page.node.delete(PDFName.of('Annots'))
        else page.node.set(PDFName.of('Annots'), context.obj(keep) as never)
      }
    }

    // ②b 递归清理嵌套 Form XObject 里的文字（正文经常在那里）。
    const resources = page.node.Resources()
    redactForms(context as never, resources, boxes, report)
    if (report.removedShows > 0) sawText = sawText || true

    // ③ 没有任何文字指令：多半是扫描页（整页图片）——如实报告，只做遮盖。
    if (!sawText) report.imageOnlyPages.push(pageNumber)

    // ③b 记下"含图片对象的页"：扫描件常是"整页图片 + 一层不可见 OCR 文字"，
    // 这时**删除 OCR 文字并不能涂掉可见内容**（可见内容在图片像素里），必须说清。
    const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict)
    if (xobjects instanceof PDFDict) {
      for (const key of xobjects.keys()) {
        const entry = context.lookup(xobjects.get(key as never))
        const subtype = (entry as { dict?: { get(key: unknown): unknown } } | undefined)?.dict?.get(PDFName.of('Subtype'))
        if (subtype !== undefined && String(subtype) === '/Image') { report.imagePages.push(pageNumber); break }
      }
    }

    // ④ 画色块（追加在内容流末尾，盖住残留的图片/矢量）。
    for (const box of boxes) {
      page.drawRectangle({ x: box.x, y: box.y, width: box.width, height: box.height, color: rgb(color.r, color.g, color.b) })
    }
  }

  report.imageOnlyPages = [...new Set(report.imageOnlyPages)].sort((a, b) => a - b)
  report.imagePages = [...new Set(report.imagePages)].sort((a, b) => a - b)
  const outBytes = detachedSafeCopy(await doc.save())

  // **写盘前的最后一道护栏**：重新提取受影响页的文字，确认"目标之外的行一行都没少"。
  // 这道检查以前只在工具层做，直接调用 core 的路径就绕过了它——而"组内连带 / 短片段误伤"
  // 正是那种会在工具层被拦下、在 core 层悄悄改坏文件的失败（实测踩过：水印与邻行同组时，
  // 邻行被一起抹掉，还有一次删掉整页白底矩形导致渲染出黑带）。宁可拒绝输出，也不交出坏文件。
  if (report.removedShows > 0 && beforeLinesByPage.size > 0) {
    const after = await openPdfBytes(detachedSafeCopy(outBytes)).catch(() => undefined)
    if (after !== undefined) {
      for (const [pageNumber, beforeLines] of beforeLinesByPage) {
        const afterLines = (await extractTextLayer(after, pageNumber).catch(() => [])).map(line => line.text.trim())
        const afterSet = new Set(afterLines)
        const targetTexts = options.targetsByPage?.get(pageNumber) ?? []
        const lost = beforeLines
          .map(text => text.trim())
          .filter(text => text.length > 0 && !afterSet.has(text))
          .filter(text => !targetTexts.some(target => text.includes(target.trim()) || target.trim().includes(text)))
        if (lost.length > 0) {
          throw new Error(
            `拒绝输出：这次删除会连带抹掉第 ${pageNumber} 页的其它文字（例如「${lost[0].slice(0, 30)}」）。`
            + '多半是目标文字与它处在同一个绘制组里；请把框收得更准，或把这个例子报告给插件维护者。',
          )
        }
      }
    }
  }
  return { bytes: outBytes, report }
}


/**
 * 把字节拷到**独立 ArrayBuffer**里。
 *
 * Node 的 `Buffer`/小 `Uint8Array` 分配来自共享池，别处一旦 `transfer` 就会把整段池分离，
 * 于是写出时抛 `Cannot perform Construct on a detached ArrayBuffer`（本机 Node 26 实测）。
 * `new ArrayBuffer()` 不走池，能彻底避开。
 */
export function detachedSafeCopy(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length))
  copy.set(bytes)
  return copy
}
