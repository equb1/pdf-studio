/**
 * 整行重绘（line redraw）：把"一个词改长"这件真正困难的事做对。
 *
 * ## 为什么不能用「移动后面的文字」这个办法
 *
 * `pdf_edit_text` 只把某个文字块的字形串换掉，**不移动后面的文字**：PDF 里根本没有
 * "段落"这个概念，一行文字只是一串各自独立的绘制指令。于是 `turn` → `turning` 会直接
 * 压在后一个字上，引擎只能在 `notes` 里提示"可能向右溢出"。看起来最自然的补救——
 * 把这一行右边的文字整体右移——在真实文档（WPS 导出、73 页）上被渲染验证**证伪**了两次：
 *
 *   1. 只改相对位移链（`TD`）上的一个点：视觉上同一行的字在内容流里**不是按 x 从左到右**
 *      出现的，改一个点会让不相邻的字被搬到错误位置，`ning/u/nd/ro` 叠在一起；
 *   2. 给整行每个字写绝对 `Tm`：更糟，字被摊到整页。
 *
 * 根因有两条，它们决定了正确做法：
 *
 *   - **乱序绘制**：同一行的字在内容流里可以任意顺序出现，所以"改一个位移点"影响的是
 *     内容流顺序上的后继，不是视觉上的后继；
 *   - **每个绘制组有自己的坐标系**：`BT … ET` 组内的 `Tm` 坐标是该组文本空间里的坐标，
 *     不是页面坐标（`listReadableRuns()` 报出的 `x/y` 就是这个空间里的值）。想把它变成
 *     页面坐标，必须把组内文本矩阵 `Tm` 与当时的 CTM 复合，而 CTM 来自 `q`/`Q`/`cm` 链。
 *
 * ## 本模块的做法：抹掉整组 + 在原地重画
 *
 * 对"目标行"（= 包含指定文字块的那个 `BT … ET` 组）做两步：
 *
 *   1. **抹掉原文**：把该组内所有 show 操作的字形串替换成空串（`Tj` → `<>`；`TJ` 数组里
 *      每个字符串元素换成 `<>`、数字原样保留），用 `content-stream` 的 `replaceSpan`
 *      直接改解码后的字节，再用 `PDFRawStream.of` + `context.register` 把新流写回页面
 *      `/Contents`（与 `text-editor.ts` 的写回方式一致）。**不能用 `replacePageText` 做
 *      这一步**：它可能跳过空文本，而且要为替换嵌入字体——抹除不需要字体。
 *   2. **重画新行**：算出该组的页面坐标原点与页面字号，用 pdf-lib 的
 *      `page.drawText(newText, …)` 画上长度自由的新文字。新文字在**新追加的内容流**里
 *      绘制，起始 CTM 是单位矩阵（若原流结束时 CTM 不是单位矩阵，这里会补一个逆矩阵
 *      把它抵消），所以不会再与原来的字重叠。
 *
 * 代价是明确的：**它抹掉的是整个 `BT … ET` 组的文字**。若该组不只包含你要改的那一句，
 * 要么整组一起重写，要么改用 `pdf_edit_text`。这条限制在工具描述里也写明了。
 *
 * ## 坐标与字号换算（真实几何，不是硬编码）
 *
 * 文本渲染矩阵 `Trm = Tm × CTM`（行向量约定：先在文本空间变换，再过 CTM）。
 * 于是：
 *
 *   - 页面坐标原点：`pageX = Trm.e`，`pageY = Trm.f`
 *     （展开即 `ctm.a*tm.e + ctm.c*tm.f + ctm.e`、`ctm.b*tm.e + ctm.d*tm.f + ctm.f`）；
 *   - 页面字号：`Tf 的字号 × hypot(Trm.a, Trm.b)`
 *     ——即字号再乘上"文本空间 x 轴在页面空间里的长度"，同时涵盖 `Tm` 的缩放与 CTM 的缩放。
 *
 * 实测那份 WPS 文档：`Tf 209`、`Tm 0.05 0 0 -0.05 …`、CTM 是一次 `1 0 0 -1 0 841.9` 的
 * y 翻转（缩放为 1）→ `209 × 0.05 = 10.45pt`，与渲染结果一致。注意 `Tm` 的 `d` 为负是
 * 字体自身坐标被翻转的结果，复合后竖直方向仍为正——所以这里用 `hypot(a, b)` 取 x 轴长度，
 * 而不是拿 `d` 直接乘。
 *
 * @module dsh-pdf-studio/core/line-redraw
 */

import { deflateSync } from 'node:zlib'
import { PDFArray, PDFDocument, PDFName, PDFRawStream, concatTransformationMatrix, rgb } from 'pdf-lib'
import {
  parseOperations,
  replaceSpan,
  showKindOf,
  showStrings,
  tokenize,
  type Operation,
  type Token,
} from './content-stream.ts'
import {
  listReadableRuns,
  readPageContentStreams,
  type ContentStream,
  type ReadableRun,
} from './text-editor.ts'
import { readPageFonts } from './font-map.ts'
import { loadFontkitAdapter, resolveFontForText } from './fonts.ts'

/* ── 矩阵 ─────────────────────────────────────────────────────────────────── */

/** PDF 变换矩阵 `[a b c d e f]`，行向量约定（`p' = p × M`）。 */
export interface Matrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

/** 单位矩阵。 */
export const IDENTITY_MATRIX: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

/** 先应用 `m1`、再应用 `m2`（`m1 × m2`）。 */
export function multiplyMatrices(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.b * m2.c,
    b: m1.a * m2.b + m1.b * m2.d,
    c: m1.c * m2.a + m1.d * m2.c,
    d: m1.c * m2.b + m1.d * m2.d,
    e: m1.e * m2.a + m1.f * m2.c + m2.e,
    f: m1.e * m2.b + m1.f * m2.d + m2.f,
  }
}

/** 纯平移矩阵。 */
export function translationMatrix(tx: number, ty: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }
}

/** 逆矩阵；奇异矩阵时退化为单位矩阵（调用方应视作异常几何）。 */
export function invertMatrix(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return { ...IDENTITY_MATRIX }
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  }
}

/** 矩阵 x 轴的长度，即该变换对该方向的缩放倍数。 */
export function matrixXScale(m: Matrix): number {
  return Math.hypot(m.a, m.b)
}

/** 是否为单位矩阵（允许浮点误差）。 */
export function isIdentityMatrix(m: Matrix): boolean {
  return Math.abs(m.a - 1) < 1e-9 && Math.abs(m.b) < 1e-9
    && Math.abs(m.c) < 1e-9 && Math.abs(m.d - 1) < 1e-9
    && Math.abs(m.e) < 1e-9 && Math.abs(m.f) < 1e-9
}

/** 取操作里的数值操作数。 */
function operandNumbers(operation: Operation): number[] {
  return operation.operands
    .filter((token: Token) => token.kind === 'number')
    .map((token: Token) => Number(token.raw))
}

function sixNumbers(operation: Operation): number[] | undefined {
  const values = operandNumbers(operation)
  if (values.length < 6 || !values.slice(0, 6).every(Number.isFinite)) return undefined
  return values.slice(0, 6)
}

/* ── 绘制状态追踪 ─────────────────────────────────────────────────────────── */

/** 一个 show 操作在内容流那一刻的完整文字状态。 */
export interface ShowTextState {
  /** 操作在解析后操作表中的下标。 */
  index: number
  /** 当时的图形状态矩阵（`q`/`Q`/`cm` 链的结果）。 */
  ctm: Matrix
  /** 当时的文本矩阵（`BT`/`Tm`/`Td`/`TD`/`T*` 链的结果），文本空间 → 用户空间。 */
  tm: Matrix
  /** 文本渲染矩阵 `tm × ctm`，文本空间 → 页面空间。 */
  trm: Matrix
  /** `Tf` 选中的字体资源名（不含前导斜杠）。 */
  fontName?: string
  /** `Tf` 的字号。 */
  fontSize?: number
  /** `Tr` 的渲染模式，默认 0（填充）。 */
  renderMode: number
}

/**
 * 追踪每个 show 操作生效时的图形状态与文字状态。
 *
 * 只解释影响几何的那几个操作符：`q`/`Q`/`cm` 维护 CTM，`BT` 重置文本矩阵，
 * `Tf`/`Tm`/`Td`/`TD`/`T*`/`TL`/`Tr` 维护文字状态。其余操作符一律忽略，所以
 * 遇到没见过的构造时仍然能给出"该 show 的位置"，而不是整体失败。
 *
 * @param operations - **单个内容流**解析后的操作表。
 * @returns show 操作下标 → 该操作的状态。
 */
export function trackGraphicsState(operations: readonly Operation[]): Map<number, ShowTextState> {
  const states = new Map<number, ShowTextState>()
  let ctm: Matrix = { ...IDENTITY_MATRIX }
  const stack: Matrix[] = []
  let tm: Matrix = { ...IDENTITY_MATRIX }
  let leading = 0
  let fontName: string | undefined
  let fontSize: number | undefined
  let renderMode = 0

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index] as Operation

    switch (operation.op) {
      case 'q':
        stack.push({ ...ctm })
        break
      case 'Q':
        // 不平衡的 Q 不该让整个页面失去几何：退回单位矩阵，后续仍可继续追踪。
        ctm = stack.pop() ?? { ...IDENTITY_MATRIX }
        break
      case 'cm': {
        const values = sixNumbers(operation)
        if (values !== undefined) {
          ctm = multiplyMatrices(
            { a: values[0]!, b: values[1]!, c: values[2]!, d: values[3]!, e: values[4]!, f: values[5]! },
            ctm,
          )
        }
        break
      }
      case 'BT':
        tm = { ...IDENTITY_MATRIX }
        break
      case 'ET':
        break
      case 'Tf': {
        const name = operation.operands.find((token: Token) => token.kind === 'name')
        const size = operandNumbers(operation)[0]
        if (name !== undefined) fontName = name.raw.replace(/^\//, '')
        if (size !== undefined && Number.isFinite(size)) fontSize = size
        break
      }
      case 'TL': {
        const value = operandNumbers(operation)[0]
        if (value !== undefined && Number.isFinite(value)) leading = value
        break
      }
      case 'Tm': {
        const values = sixNumbers(operation)
        if (values !== undefined) {
          tm = { a: values[0]!, b: values[1]!, c: values[2]!, d: values[3]!, e: values[4]!, f: values[5]! }
        }
        break
      }
      case 'Td':
      case 'TD': {
        const values = operandNumbers(operation)
        const tx = values[0] ?? 0
        const ty = values[1] ?? 0
        if (operation.op === 'TD') leading = -ty
        tm = multiplyMatrices(translationMatrix(tx, ty), tm)
        break
      }
      case 'T*':
        tm = multiplyMatrices(translationMatrix(0, -leading), tm)
        break
      case 'Tr': {
        const value = operandNumbers(operation)[0]
        if (value !== undefined && Number.isFinite(value)) renderMode = value
        break
      }
      default:
        break
    }

    if (showKindOf(operation.op) === undefined) continue
    states.set(index, {
      index,
      ctm: { ...ctm },
      tm: { ...tm },
      trm: multiplyMatrices(tm, ctm),
      ...(fontName === undefined ? {} : { fontName }),
      ...(fontSize === undefined ? {} : { fontSize }),
      renderMode,
    })
  }

  return states
}

/**
 * 计算一段内容流（或几段按顺序拼接）跑完后的 CTM。
 *
 * 页面 `/Contents` 可以是数组，几段流在渲染时被当作一段连续的程序，图形状态会跨流延续。
 * pdf-lib 追加绘制内容时假设起始 CTM 是单位矩阵，所以这里必须先算出真实值：
 * 若不是单位矩阵，就要补一个逆矩阵把它抵消，否则新文字会被原来的 `cm` 二次变换。
 */
export function finalGraphicsState(streamTexts: readonly string[]): Matrix {
  let ctm: Matrix = { ...IDENTITY_MATRIX }
  const stack: Matrix[] = []
  for (const text of streamTexts) {
    const operations = parseOperations(tokenize(text))
    for (const operation of operations) {
      if (operation.op === 'q') stack.push({ ...ctm })
      else if (operation.op === 'Q') ctm = stack.pop() ?? { ...IDENTITY_MATRIX }
      else if (operation.op === 'cm') {
        const values = sixNumbers(operation)
        if (values !== undefined) {
          ctm = multiplyMatrices(
            { a: values[0]!, b: values[1]!, c: values[2]!, d: values[3]!, e: values[4]!, f: values[5]! },
            ctm,
          )
        }
      }
    }
  }
  return ctm
}

/* ── 文本组 ───────────────────────────────────────────────────────────────── */

/** 一个 `BT … ET` 组在操作表里的闭区间下标。 */
export interface TextGroupRange {
  /** `BT` 的下标。 */
  start: number
  /** `ET` 的下标。 */
  end: number
}

/**
 * 找包含指定 show 操作的 `BT … ET` 区间。
 *
 * 找不到 `BT` 或 `ET` 时返回 `undefined`：这意味着该 show 不在一个标准文本组里，
 * 本模块拒绝猜它的边界（猜错就等于抹掉别的文字）。
 */
export function findTextGroup(
  operations: readonly Operation[],
  showIndex: number,
): TextGroupRange | undefined {
  if (showIndex < 0 || showIndex >= operations.length) return undefined
  let start = -1
  for (let index = showIndex; index >= 0; index -= 1) {
    if (operations[index]?.op === 'BT') {
      start = index
      break
    }
  }
  if (start < 0) return undefined
  let end = -1
  for (let index = showIndex; index < operations.length; index += 1) {
    if (operations[index]?.op === 'ET') {
      end = index
      break
    }
  }
  if (end < 0) return undefined
  return { start, end }
}

/** 一个文本组的页面空间几何与解码后的原文。 */
export interface PageSpaceGeometry {
  /** 该组第一个 show 的页面坐标基线原点。 */
  origin: { x: number; y: number }
  /** 页面字号（`Tf` 字号 × 文本渲染矩阵的 x 轴缩放）。 */
  pageFontSize: number
  /** 组内所有 show 解码后拼接的原文。 */
  groupText: string
  /** 组内是否有文字块无法解码（缺少 ToUnicode）。 */
  hasUndecodableRuns: boolean
  /** 组内第一个 show 的操作下标。 */
  firstShowIndex: number
  /** 组内 show 操作数量。 */
  showCount: number
  /** 第一个 show 的文本渲染矩阵。 */
  trm: Matrix
}

/**
 * 算出一个文本组的页面坐标原点、页面字号与组内原文。
 *
 * `runs` 必须是**同一条内容流**的可读文字块（`listReadableRuns` 的产物）：组内原文
 * 就是"操作下标落在 `[start, end]` 内的那些 run 的文字按顺序拼接"。解码逻辑与
 * `listReadableRuns` 完全共用，不在这里重新实现一遍 CMap 解码。
 *
 * @returns 组内没有 show 操作、或缺少该 show 的状态时返回 `undefined`。
 */
export function pageSpaceGeometry(
  operations: readonly Operation[],
  states: ReadonlyMap<number, ShowTextState>,
  runs: readonly ReadableRun[],
  range: TextGroupRange,
): PageSpaceGeometry | undefined {
  const showIndices: number[] = []
  for (let index = range.start; index <= range.end; index += 1) {
    const operation = operations[index]
    if (operation !== undefined && showKindOf(operation.op) !== undefined) showIndices.push(index)
  }
  if (showIndices.length === 0) return undefined

  const firstShowIndex = showIndices[0]!
  const state = states.get(firstShowIndex)
  if (state === undefined) return undefined

  const groupRuns = runs
    .filter(run => run.operationIndex >= range.start && run.operationIndex <= range.end)
    .sort((a, b) => a.operationIndex - b.operationIndex)

  const groupText = groupRuns.map(run => run.text ?? '').join('')
  const hasUndecodableRuns = groupRuns.some(run => run.text === undefined)
  const pageFontSize = (state.fontSize ?? 0) * matrixXScale(state.trm)

  return {
    origin: { x: state.trm.e, y: state.trm.f },
    pageFontSize,
    groupText,
    hasUndecodableRuns,
    firstShowIndex,
    showCount: showIndices.length,
    trm: { ...state.trm },
  }
}

/* ── 跨组重排：同一视觉行的兄弟组 ─────────────────────────────────────────── */

/** 一个文本组，连同它的几何、原文宽度与当时的 CTM。 */
export interface TextGroup {
  /** `BT … ET` 区间。 */
  range: TextGroupRange
  /** 页面空间几何与原文。 */
  geometry: PageSpaceGeometry
  /** 组内的可读文字块（按操作下标升序）。 */
  runs: ReadableRun[]
  /** 原始文字在页面空间里的宽度（用原字体 /W 度量）。 */
  pageWidth: number
  /** 该组第一个 show 生效时的 CTM，用于把页面位移换算回锚点坐标。 */
  ctm: Matrix
}

/**
 * 列出内容流里所有文本组。
 *
 * 真实文档会把**视觉上的一整行**拆成多个 `BT … ET` 组：`9.turn` 一组、`around/round` 一组、
 * `转身` 又一组，基线 y 相同、x 依次排开。要"把后面的字整体让开"，就必须先知道有哪些组、
 * 它们各自在页面空间的哪里——这正是"改相对位移链上的一个点"会翻车的原因：那只影响内容流
 * 顺序上的后继，与视觉顺序无关。
 *
 * @param runs - **同一条内容流**的可读文字块。
 */
export function collectTextGroups(
  operations: readonly Operation[],
  states: ReadonlyMap<number, ShowTextState>,
  runs: readonly ReadableRun[],
): TextGroup[] {
  const groups: TextGroup[] = []
  let start = -1
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index] as Operation
    if (operation.op === 'BT') {
      start = index
      continue
    }
    if (operation.op !== 'ET' || start < 0) continue
    const range: TextGroupRange = { start, end: index }
    start = -1
    const geometry = pageSpaceGeometry(operations, states, runs, range)
    if (geometry === undefined) continue
    const groupRuns = runs
      .filter(run => run.operationIndex >= range.start && run.operationIndex <= range.end)
      .sort((a, b) => a.operationIndex - b.operationIndex)
    const state = states.get(geometry.firstShowIndex)
    if (state === undefined) continue
    groups.push({
      range,
      geometry,
      runs: groupRuns,
      pageWidth: groupPageWidth(groupRuns, geometry.pageFontSize),
      ctm: { ...state.ctm },
    })
  }
  return groups
}

/**
 * 一个文本组原文的页面空间宽度。
 *
 * 用字体 `/W` 的**每千字宽**累加（`ReadableRun.advanceUnits`）再乘页面字号：
 * `width = ΣadvanceUnits / 1000 × pageFontSize`。这与"文本单位宽 × |trm.a|"等价
 * （实测那份文档：`493.2 × 0.05 ≈ 24.66pt`），但不需要假定缩放在哪一侧。
 *
 * 有任何文字块没有度量时返回 `undefined`，让调用方知道这个宽度不可靠。
 */
export function groupPageWidth(runs: readonly ReadableRun[], pageFontSize: number): number {
  let units = 0
  for (const run of runs) {
    if (run.text === undefined || run.advanceUnits === undefined) return Number.NaN
    units += run.advanceUnits
  }
  return (units / 1000) * pageFontSize
}

/**
 * 用 pdf-lib 的字体度量算一段文字在页面空间的宽度。
 *
 * 这是"新文字会不会压到别人"的唯一诚实话语方式：新字体与原字体的字宽通常不同，
 * 用字符数估算是错的。
 */
export function measureTextWidth(
  font: { widthOfTextAtSize(text: string, size: number): number },
  text: string,
  pageFontSize: number,
): number {
  return font.widthOfTextAtSize(text, pageFontSize)
}

/**
 * 与目标组处于**同一条视觉基线**、且在它右侧的所有文本组（按 x 升序）。
 *
 * 判定用页面空间的基线 y（`|Δy| ≤ tolerance`，默认 1.2pt），而不是内容流顺序——
 * 乱序绘制时内容流顺序与视觉顺序无关。
 */
export function siblingGroupsOnSameLine(
  groups: readonly TextGroup[],
  target: TextGroup,
  options: { tolerance?: number } = {},
): TextGroup[] {
  const tolerance = options.tolerance ?? 1.2
  return groups
    .filter(group => group !== target
      && Math.abs(group.geometry.origin.y - target.geometry.origin.y) <= tolerance
      && group.geometry.origin.x > target.geometry.origin.x)
    .sort((a, b) => a.geometry.origin.x - b.geometry.origin.x)
}

/**
 * 把"页面空间右移 `deltaPageX`"换算成锚点（组内第一个定位算符）坐标系的位移。
 *
 * ## 为什么不是 `deltaPageX / |trm.a|`
 *
 * `Tm` 的操作数位于**当前用户空间**，不是文本空间。锚点 `Tm.e` 加 δ，页面 x 变化
 * `δ × ctm.a`（ctm.b ≠ 0 时页面 y 也会变）。实测那份 WPS 文档：CTM 是
 * `[1 0 0 -1 0 841.9]`（缩放为 1），`Tm.e = 136.44` **就是**页面 x 136.44；
 * 若要右移 13.31pt，`Tm.e` 加 13.31，而不是加 `13.31 / 0.05 = 266.2`。
 *
 * 这里解的是二维方程 `[δe, δf] × CTM线性部分 = [deltaPageX, 0]`，所以同时正确处理
 * 带缩放（例如 CTM 有 20 倍缩放）与带旋转的 CTM：`δe = Δ·ctm.d/det`、`δf = −Δ·ctm.b/det`。
 *
 * @returns 锚点坐标里要施加的 `{ e, f }` 位移；CTM 奇异时返回 `undefined`。
 */
export function anchorDeltaFromPageShift(
  ctm: Matrix,
  deltaPageX: number,
): { e: number; f: number } | undefined {
  const det = ctm.a * ctm.d - ctm.b * ctm.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined
  return { e: (deltaPageX * ctm.d) / det, f: (-deltaPageX * ctm.b) / det }
}

/** 可以安全平移的最小条件：组内第一个定位算符是绝对锚定的 `Tm`。 */
const POSITIONING_OPERATORS = new Set(['Tm', 'Td', 'TD', 'T*'])

/** 平移一个兄弟组的结果。 */
export interface GroupShiftResult {
  ok: boolean
  /** 成功时要替换的 span（只动该组的 `Tm`，组内其余相对位移自动跟随）。 */
  spans: BlankSpan[]
  /** 在锚点坐标里实际施加的位移。 */
  delta: { e: number; f: number }
  /** 失败原因（中文）。 */
  reason?: string
}

/** 把数字写成内容流里的字面量，最多保留 4 位小数。 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return String(Number(value.toFixed(4)))
}

/**
 * 把一个兄弟组整体沿页面 x 方向平移 `deltaPageX`。
 *
 * ## 为什么只改组内第一个定位算符
 *
 * 每个组由它自己的绝对 `Tm` 锚定，组内后续 show 只是相对 `TD`/`Td` 位移。所以"整体右移
 * 一个组"等价于**只改那个 `Tm` 的 `e`（必要时连 `f`）**，组内其余位置自动跟随。反过来，
 * 在相对位移链上改一个点，只会搬动内容流顺序上的后继，与视觉顺序无关——那正是早先两次
 * 几何 hack 失败的原因。
 *
 * ## 什么时候拒绝
 *
 * 组内第一个定位算符不是 `Tm`（而是 `Td`/`TD`/`T*`，或根本没有）时**不猜**：
 * 这类组没有绝对锚点，平移会连带影响别的定位，返回中文原因让调用方降级为警告。
 *
 * @returns 成功时给出只替换该组 `Tm` 的 span；`streamText` 保持不变。
 */
export function shiftGroupAnchor(
  _streamText: string,
  operations: readonly Operation[],
  group: TextGroup,
  deltaPageX: number,
): GroupShiftResult {
  const failed = (reason: string): GroupShiftResult => ({ ok: false, spans: [], delta: { e: 0, f: 0 }, reason })

  let anchor: Operation | undefined
  for (let index = group.range.start; index < group.geometry.firstShowIndex; index += 1) {
    const operation = operations[index]
    if (operation !== undefined && POSITIONING_OPERATORS.has(operation.op)) {
      anchor = operation
      break
    }
  }
  if (anchor === undefined) {
    return failed('组内第一个 show 之前没有任何定位算符，无法确定锚点')
  }
  if (anchor.op !== 'Tm') {
    return failed(`组内第一个定位算符是 ${anchor.op}（相对定位），没有绝对锚点，平移会连带影响其它定位`)
  }

  const numbers = anchor.operands.filter((token: Token) => token.kind === 'number')
  if (numbers.length < 6) {
    return failed('组内第一个 Tm 的六个矩阵参数不完整，无法平移')
  }
  const translation = anchorDeltaFromPageShift(group.ctm, deltaPageX)
  if (translation === undefined) {
    return failed('该组的 CTM 不可逆，无法把页面位移换算回锚点坐标')
  }

  const eToken = numbers[4]!
  const fToken = numbers[5]!
  const newE = Number(eToken.raw) + translation.e
  const newF = Number(fToken.raw) + translation.f
  const spans: BlankSpan[] = [
    { start: eToken.start, end: eToken.end, text: formatNumber(newE) },
    { start: fToken.start, end: fToken.end, text: formatNumber(newF) },
  ]
  return { ok: true, spans, delta: translation }
}

/* ── 抹除字形 ─────────────────────────────────────────────────────────────── */

/** 一次 span 替换：把 `[start, end)` 换成 `text`。 */
export interface BlankSpan {
  start: number
  end: number
  text: string
}

/** 抹除结果。 */
export interface BlankGroupResult {
  /** 抹除后的完整内容流文本。 */
  text: string
  /** 被替换的区间。 */
  spans: BlankSpan[]
  /** 被抹掉字形串的 show 操作数量。 */
  blankedShows: number
}

/**
 * 把文本组内所有 show 操作的字形串换成空串。
 *
 * `TJ` 数组里的数字是字距调整、保留不动，只把字符串元素换成 `<>`；并且**不重建整个数组**，
 * 而是对每个字符串元素各自做一次 `replaceSpan`——这样数组里的空白、注释、换行都逐字节保留，
 * 不会因为重新序列化而破坏流（例如把注释和后面的内容并到同一行）。
 *
 * @param streamText - 解码后的内容流文本。
 * @param operations - 该流的操作表。
 * @param range - 目标文本组。
 */
export function blankGroupGlyphs(
  streamText: string,
  operations: readonly Operation[],
  range: TextGroupRange,
): BlankGroupResult {
  const spans: BlankSpan[] = []
  let blankedShows = 0

  for (let index = range.start; index <= range.end; index += 1) {
    const operation = operations[index]
    if (operation === undefined) continue
    const kind = showKindOf(operation.op)
    if (kind === undefined) continue

    if (kind === 'TJ') {
      const arrayToken = operation.operands.find((token: Token) => token.kind === 'array')
      if (arrayToken === undefined) continue
      // `showStrings` 返回的是数组内部（去掉外层方括号后）的 token，偏移相对内部起点，
      // 所以要加上 `arrayToken.start + 1` 才是整条流里的绝对偏移。
      const innerOffset = arrayToken.start + 1
      const strings = showStrings(operation)
      for (const token of strings) {
        spans.push({ start: innerOffset + token.start, end: innerOffset + token.end, text: '<>' })
      }
      if (strings.length > 0) blankedShows += 1
      continue
    }

    const strings = showStrings(operation)
    for (const token of strings) {
      spans.push({ start: token.start, end: token.end, text: '<>' })
    }
    if (strings.length > 0) blankedShows += 1
  }

  return { text: replaceSpan(streamText, spans), spans, blankedShows }
}

/* ── 写回与重画 ───────────────────────────────────────────────────────────── */

/** 本模块需要的最小 pdf-lib 文档视图。 */
export interface RedrawPdf {
  registerFontkit(adapter: unknown): void
  embedFont(
    bytes: Uint8Array,
    options?: { subset?: boolean },
  ): Promise<{
    ref: unknown
    name: string
    encodeText(text: string): { toString(): string }
    /** 新文字在同一字号下的宽度，用来判断会不会压到同一视觉行的相邻组。 */
    widthOfTextAtSize(text: string, size: number): number
  }>
}

/** 本模块需要的最小 pdf-lib 页面视图。 */
export interface RedrawPage {
  node: {
    Contents(): unknown
    set(key: unknown, value: unknown): void
  }
  drawText(
    text: string,
    options: { x: number; y: number; size: number; font: unknown; color?: unknown },
  ): void
  pushOperators(...operators: unknown[]): void
  /** 页面宽度，用于"平移后是否越出页面"的检查。 */
  getWidth(): number
}

/** 本模块需要的最小 pdf-lib 上下文视图。 */
export interface RedrawContext {
  lookup(ref: unknown): unknown
  register(value: unknown): unknown
  obj(value: unknown): unknown
}

/** 整行重绘的请求。 */
export interface RedrawOptions {
  /** 目标行里任意一个文字块的 id（`<内容流号>:<操作号>`）。 */
  targetId: string
  /** 新的整行文字。 */
  text: string
  /** 可选：覆盖页面字号；省略时用真实几何算出的页面字号。 */
  fontSize?: number
  /** 可选：新文字的颜色，默认黑色。 */
  color?: { r: number; g: number; b: number }
  /** 可选：指定字体文件路径；省略时走 `fonts.ts` 的系统字体候选。 */
  fontPath?: string
  /**
   * 是否连带把**同一视觉行右侧的兄弟组**整体右移，让出新的宽度（默认 `true`）。
   *
   * 置 `false` 时只重绘目标组，右侧组不动；若新文字越过它们，结果里会给出重叠警告。
   */
  shiftSiblings?: boolean
  /** 同一视觉行的基线容差（pt），默认 1.2。 */
  siblingTolerance?: number
  /** 平移后允许越出页面右边界的余量（pt），默认 0。 */
  overflowMargin?: number
}

/** 兄弟组平移的执行报告。 */
export interface SiblingShiftReport {
  /** 成功右移的兄弟组数量。 */
  shifted: number
  /** 实际施加的页面空间右移量（pt）；未平移时为 0。 */
  deltaPageX: number
  /** 被平移组的原文，便于回读确认。 */
  shiftedTexts: string[]
  /** 无法安全平移的组及其中文原因。 */
  failed: Array<{ text: string; reason: string }>
  /** 平移后视觉行最右边界是否越出页面。 */
  overflow?: { rightEdge: number; pageWidth: number; margin: number }
}

/** 整行重绘的结果。 */
export interface RedrawResult {
  /** 被抹除并重绘的文字块 id。 */
  replacedRuns: string[]
  /** 该文本组的原文（被抹掉的内容）。 */
  groupText: string
  /** 新文字的页面坐标基线原点。 */
  origin: { x: number; y: number }
  /** 实际使用的页面字号。 */
  pageFontSize: number
  /** 被抹掉字形串的 show 操作数量。 */
  blankedShows: number
  /** 实际使用的字体文件路径。 */
  fontPath: string
  /** 兄弟组平移的报告；未开启或同一行没有兄弟组时为 `undefined`。 */
  siblingShift?: SiblingShiftReport
  /** 需要提醒调用方的事项。 */
  notes: string[]
}

/** 截断用于报错的文字，避免把整页内容塞进一条消息。 */
function shorten(text: string, limit = 40): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** 把重写后的内容流写回页面 `/Contents`（数组时逐项替换，单流时整体替换）。 */
function writeBackStream(
  page: RedrawPage,
  context: RedrawContext,
  stream: ContentStream,
  newText: string,
): void {
  const deflated = new Uint8Array(deflateSync(Buffer.from(newText, 'latin1')))
  const dict = context.obj({ Filter: 'FlateDecode', Length: deflated.length })
  const fresh = PDFRawStream.of(dict as never, deflated)
  const ref = context.register(fresh)

  const contents = page.node.Contents()
  if (contents instanceof PDFArray) {
    for (let index = 0; index < contents.size(); index += 1) {
      if (contents.get(index) === stream.ref) contents.set(index, ref as never)
    }
    return
  }
  // 单流形态：整体替换。注意必须**先抹除、后 drawText**——drawText 会把 `/Contents`
  // 规范化成数组并在末尾追加新流；如果顺序反过来，这一步会把刚画上的新流一起丢掉。
  page.node.set(PDFName.of('Contents'), ref)
}

/**
 * 整行重绘：抹掉目标 `BT … ET` 组的原文，再在该组的页面坐标原点重画新文字。
 *
 * 失败时抛出带明确中文原因的 `Error`（找不到文字块 / 这一页没有文字层 / 字体加载失败 /
 * 组内没有可抹除的字形串），**不静默返回**——"看起来成功"比报错危险得多。
 *
 * @param pdf - pdf-lib 文档。
 * @param page - 目标页（pdf-lib `PDFPage`）。
 * @param context - pdf-lib 文档上下文。
 */
export async function redrawTextLine(
  pdf: RedrawPdf,
  page: RedrawPage,
  context: RedrawContext,
  options: RedrawOptions,
): Promise<RedrawResult> {
  const streams = readPageContentStreams(page as never, context as never)
  const fonts = readPageFonts(context as never, page as never)
  const runs = listReadableRuns(streams, fonts)

  if (streams.length === 0 || runs.length === 0) {
    throw new Error(
      '这一页没有文字层（可能是图片页/扫描页），无法整行重绘：'
      + '请先用 pdf_make_searchable 生成可搜索副本；pdf_edit_text 对图片页同样无效。',
    )
  }

  const [streamIndexText, operationIndexText] = options.targetId.split(':')
  const streamIndex = Number(streamIndexText)
  const operationIndex = Number(operationIndexText)
  if (!Number.isFinite(streamIndex) || !Number.isFinite(operationIndex)) {
    throw new Error(
      `文字块 id「${shorten(options.targetId)}」格式不对：应为 <内容流号>:<操作号>（例如 1:6）。`
      + '请用 pdf_inspect runs=true 重新读取。',
    )
  }

  const stream = streams.find(candidate => candidate.index === streamIndex)
  if (stream === undefined) {
    throw new Error(
      `找不到文字块 ${options.targetId}：这一页没有第 ${streamIndex} 号内容流。`
      + '请用 pdf_inspect runs=true 重新读取 id（改写后 id 会整体前移）。',
    )
  }

  const operations = parseOperations(tokenize(stream.text))
  const targetOperation = operations[operationIndex]
  if (targetOperation === undefined || showKindOf(targetOperation.op) === undefined) {
    throw new Error(
      `找不到文字块 ${options.targetId}：第 ${streamIndex} 号内容流里没有这个绘制文字的操作。`
      + '请用 pdf_inspect runs=true 重新读取 id。',
    )
  }

  const range = findTextGroup(operations, operationIndex)
  if (range === undefined) {
    throw new Error(
      `文字块 ${options.targetId} 不在 BT…ET 文本组内，无法确定整行边界；请改用 pdf_edit_text。`,
    )
  }

  const states = trackGraphicsState(operations)
  const streamRuns = runs.filter(run => run.streamIndex === stream.index)
  const allGroups = collectTextGroups(operations, states, streamRuns)
  const targetGroup = allGroups.find(group =>
    group.range.start === range.start && group.range.end === range.end)
  if (targetGroup === undefined) {
    throw new Error(
      `文字块 ${options.targetId} 所在文本组没有可用的几何信息，无法定位重画位置。`,
    )
  }
  const geometry = targetGroup.geometry
  const groupRuns = targetGroup.runs

  const computedSize = geometry.pageFontSize
  if (!(computedSize > 0)) {
    throw new Error(
      `文字块 ${options.targetId} 的页面字号算出来是 ${computedSize}，几何异常，已放弃重绘。`,
    )
  }
  const size = options.fontSize ?? computedSize

  const blanked = blankGroupGlyphs(stream.text, operations, range)
  if (blanked.spans.length === 0) {
    throw new Error(
      `文字块 ${options.targetId} 所在文本组没有可抹除的字形串（可能是空字符串绘制），无需重绘。`,
    )
  }

  const loaded = await resolveFontForText(options.text, options.fontPath)
  if (loaded === null) {
    throw new Error(
      `没有可用字体渲染「${shorten(options.text)}」：系统里找不到能覆盖这些字符的字体。`
      + '请确认已安装中文字体（macOS 通常自带 STHeiti / PingFang）。',
    )
  }

  const fontkit = await loadFontkitAdapter()
  if (fontkit !== null) pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(loaded.bytes, { subset: true })

  const notes: string[] = []
  const newWidth = measureTextWidth(font, options.text, size)
  const shiftSiblings = options.shiftSiblings !== false
  const tolerance = options.siblingTolerance ?? 1.2
  const margin = options.overflowMargin ?? 0
  const siblings = siblingGroupsOnSameLine(allGroups, targetGroup, { tolerance })
  const originalWidth = targetGroup.pageWidth
  const canMeasureGrowth = Number.isFinite(originalWidth) && Number.isFinite(newWidth)
  const growth = canMeasureGrowth ? newWidth - originalWidth : Number.NaN

  // ── 跨组重排：让同一视觉行右侧的兄弟组整体右移 ──────────────────────────────
  //
  // 真实文档把视觉一行拆成多个 `BT … ET` 组（`9.turn` / `around/round` / `转身`）。
  // 每个组由自己的绝对 `Tm` 锚定，所以"整体右移一个组"只改那个 `Tm` 的 e（必要时连 f），
  // 组内相对位移自动跟随。详见 `shiftGroupAnchor`。
  const shiftSpans: BlankSpan[] = []
  let siblingShift: SiblingShiftReport | undefined
  const unshiftedSiblings: TextGroup[] = []

  if (shiftSiblings && siblings.length > 0) {
    siblingShift = { shifted: 0, deltaPageX: 0, shiftedTexts: [], failed: [] }
    // 只有在**变长**时才需要让位；变短不会与右侧重叠，没必要挪动版面。
    if (growth > 0) {
      for (const sibling of siblings) {
        const outcome = shiftGroupAnchor(stream.text, operations, sibling, growth)
        if (outcome.ok && outcome.spans.length > 0) {
          shiftSpans.push(...outcome.spans)
          siblingShift.shifted += 1
          siblingShift.shiftedTexts.push(sibling.geometry.groupText)
        } else {
          siblingShift.failed.push({
            text: sibling.geometry.groupText,
            reason: outcome.reason ?? '未知原因',
          })
          unshiftedSiblings.push(sibling)
        }
      }
      siblingShift.deltaPageX = siblingShift.shifted > 0 ? growth : 0
    }
  }

  // 溢出检查：平移后视觉行最右边界是否越出页面。**只是警告，不拒绝执行**——
  // 用户可能就是要硬来，插件该做的是把后果说清楚。
  if (siblingShift !== undefined && siblingShift.shifted > 0) {
    let rightEdge = geometry.origin.x + newWidth
    for (const sibling of siblings) {
      const moved = !unshiftedSiblings.includes(sibling)
      rightEdge = Math.max(
        rightEdge,
        sibling.geometry.origin.x + (moved ? growth : 0)
          + (Number.isFinite(sibling.pageWidth) ? sibling.pageWidth : 0),
      )
    }
    const pageWidth = page.getWidth()
    if (rightEdge > pageWidth - margin) {
      siblingShift.overflow = { rightEdge, pageWidth, margin }
      notes.push(
        `⚠️ 平移后这一视觉行的最右边界约 ${rightEdge.toFixed(1)}pt，超出页面宽度 ${pageWidth.toFixed(1)}pt`
        + `${margin > 0 ? `（减去安全边距 ${margin}pt）` : ''}：文字可能被裁掉或被阅读器当成越界内容。`
        + '文件已经写出，但建议把这一行缩短后再试。',
      )
    }
  }

  if (siblingShift !== undefined) {
    if (siblingShift.shifted > 0) {
      notes.push(
        `已把同一视觉行右侧 ${siblingShift.shifted} 个片段整体右移 ${siblingShift.deltaPageX.toFixed(2)}pt：`
        + `${siblingShift.shiftedTexts.map(text => `「${shorten(text, 20)}」`).join('、')}。`,
      )
    }
    for (const failure of siblingShift.failed) {
      notes.push(
        `无法平移相邻片段「${shorten(failure.text, 20)}」：${failure.reason}。`
        + '它没有被移动，可能与新文字重叠。',
      )
    }
  }

  // 没有平移（关闭了 shiftSiblings，或部分组平移失败）时，如实给出重叠警告。
  const overlapWarningNeeded = !shiftSiblings
    ? siblings.length > 0 && canMeasureGrowth
      && geometry.origin.x + newWidth > (siblings[0]!.geometry.origin.x - 0.5)
    : unshiftedSiblings.some(sibling =>
      canMeasureGrowth && geometry.origin.x + newWidth > sibling.geometry.origin.x - 0.5)
  if (overlapWarningNeeded) {
    const firstBlocking = shiftSiblings ? unshiftedSiblings[0]! : siblings[0]!
    notes.push(
      `⚠️ 新文字实测宽约 ${newWidth.toFixed(1)}pt，会越过同一视觉行右侧相邻绘制组的起点`
      + `（x=${firstBlocking.geometry.origin.x.toFixed(1)}，本组起点 x=${geometry.origin.x.toFixed(1)}），可能与那一组重叠。`
      + (shiftSiblings
        ? '原因：该相邻组无法安全平移（见上一条）。'
        : '原因：shiftSiblings=false，右侧相邻组没有被移动。')
      + '要避免重叠，可以开启 shiftSiblings（默认开启）、把这一行缩短，或改用等长替换。',
    )
  }

  // 抹掉目标组字形 + 平移兄弟组锚点：两组 span 互不重叠，一次性写回。
  const rebuilt = replaceSpan(stream.text, [...blanked.spans, ...shiftSpans])
  writeBackStream(page, context, stream, rebuilt)

  // 原内容流跑完后的 CTM 若不是单位矩阵，pdf-lib 追加的绘制内容会继承它。补一个逆矩阵
  // 把它抵消，保证新文字落在我们用页面坐标算出的位置上。
  const finalCtm = finalGraphicsState(streams.map(candidate => candidate.text))
  if (!isIdentityMatrix(finalCtm)) {
    const inverse = invertMatrix(finalCtm)
    // 必须用 pdf-lib 自己的操作符对象：`pushOperators` 会做 `instanceof PDFOperator` 校验，
    // 传一个只实现了 `toString()` 的普通对象会被断言直接拒绝。
    page.pushOperators(
      concatTransformationMatrix(inverse.a, inverse.b, inverse.c, inverse.d, inverse.e, inverse.f),
    )
    notes.push(
      '原内容流结束时图形状态矩阵不是单位矩阵，已补一个逆矩阵抵消，确保新文字落在页面坐标原点。',
    )
  }

  const color = options.color ?? { r: 0, g: 0, b: 0 }
  page.drawText(options.text, {
    x: geometry.origin.x,
    y: geometry.origin.y,
    size,
    font: font as never,
    color: rgb(color.r, color.g, color.b),
  })

  if (groupRuns.length > 1) {
    notes.push(
      `该文本组包含 ${groupRuns.length} 个文字块（${shorten(geometry.groupText, 60)}），已整组抹除并重绘。`
      + '如果这不是你想要的，请改用 pdf_edit_text（它只换字形、不整组重绘）。',
    )
  }

  if (geometry.hasUndecodableRuns) {
    notes.push('该文本组里有文字块缺少 ToUnicode、无法解码：抹除仍会生效，但上面显示的原文可能不完整。')
  }
  if (options.fontSize !== undefined && Math.abs(options.fontSize - computedSize) > 0.01) {
    notes.push(
      `按参数使用了 ${options.fontSize}pt（按原几何应为 ${computedSize.toFixed(2)}pt）。`,
    )
  }

  return {
    replacedRuns: groupRuns.map(run => run.id),
    groupText: geometry.groupText,
    origin: geometry.origin,
    pageFontSize: size,
    blankedShows: blanked.blankedShows,
    fontPath: loaded.path,
    ...(siblingShift === undefined ? {} : { siblingShift }),
    notes,
  }
}

/** 在内存里的 PDF 字节上做整行重绘，返回新字节与结果。 */
export async function redrawLineInPdfBytes(
  bytes: Uint8Array,
  options: RedrawOptions & { page: number },
): Promise<{ bytes: Uint8Array; result: RedrawResult }> {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPages()[options.page - 1]
  if (page === undefined) {
    throw new Error(`第 ${options.page} 页不存在（该文件共 ${doc.getPageCount()} 页）。`)
  }
  const result = await redrawTextLine(
    doc as unknown as RedrawPdf,
    page as unknown as RedrawPage,
    doc.context as unknown as RedrawContext,
    options,
  )
  const output = await doc.save()
  return { bytes: output, result }
}

/** 模块标记，便于从测试里 grep 到本模块的意图。 */
export const LINE_REDRAW_MODULE = 'dsh-pdf-studio/core/line-redraw'
