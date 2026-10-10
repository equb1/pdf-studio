/**
 * 「整行重绘」（`pdf_replace_line` + `src/core/line-redraw.ts`）独立测试。
 *
 * ## 这个套件要证明什么
 *
 * `pdf_edit_text` 只换字形串、不移动后面的文字，把一个词改长就会与后一个字重叠。
 * 整行重绘的方案是：抹掉目标 `BT … ET` 组内的字形，再在**真实几何算出的页面坐标原点**
 * 重画长度自由的新文字。这里要钉住的正是"它真的能改长且不重叠"，而不是"它返回了成功文案"。
 *
 * 夹具用 pdf-lib 现场造在 `os.tmpdir()` 下，刻意模拟真实文档的难点：
 *
 *   - 一个全局 `q cm 1 0 0 -1 0 841.9` 的 y 翻转（CTM 链）；
 *   - 每行一个 `BT … ET` 组，组内用 `Tm 0.05 0 0 -0.05 …` + 逐字 `Td` 相对位移；
 *   - 目标行 `9.turn around/round 转身` 的后一个字**紧跟**，没有多余空间。
 *
 * 断言里最关键的两条是量化的：新行与其它行 **bbox 不相交**，且新行比原来**更宽**
 * （证明"改长"真的生效了，而不是什么都没改）。
 *
 * Run: node --import ./test/support/dom-shim.mjs --experimental-strip-types test/line-redraw.test.mjs
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
  beginText,
  concatTransformationMatrix,
  endText,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  setFontAndSize,
  showText,
} from 'pdf-lib'

import { buildToolDefinitions } from '../src/host/tools.ts'
import { openPdfBytes } from '../src/core/pdf.ts'
import { extractTextLayer } from '../src/core/text-layer.ts'
import { rectsIntersect } from '../src/core/coords.ts'
import { CJK_FONT_CANDIDATES, loadFontkitAdapter } from '../src/core/fonts.ts'
import { runQpdf } from '../src/core/qpdf.ts'
import { parseOperations, tokenize } from '../src/core/content-stream.ts'
import { readPageFonts } from '../src/core/font-map.ts'
import { listReadableRuns, readPageContentStreams } from '../src/core/text-editor.ts'
import {
  blankGroupGlyphs,
  collectTextGroups,
  findTextGroup,
  pageSpaceGeometry,
  redrawLineInPdfBytes,
  siblingGroupsOnSameLine,
  trackGraphicsState,
} from '../src/core/line-redraw.ts'

/* ── 判定框架 ─────────────────────────────────────────────────────────────── */

let checks = 0
let failed = 0
const check = (name, ok, detail) => {
  checks += 1
  const suffix = detail === undefined || detail === '' ? '' : ` — ${detail}`
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${suffix}`)
  if (!ok) failed += 1
}
const checkEq = (name, actual, expected) => {
  check(name, Object.is(actual, expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}
/** 断言不抛；返回 {ok, message}。 */
const tryCall = async (fn) => {
  try {
    return { ok: true, value: await fn(), message: '' }
  } catch (error) {
    return { ok: false, value: undefined, message: String(error?.message ?? error) }
  }
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const norm = text => text.replace(/\s+/g, '')
const near = (a, b, tolerance = 0.05) => Math.abs(a - b) <= tolerance

console.log('整行重绘（pdf_replace_line）\n')

/* ── 夹具 ─────────────────────────────────────────────────────────────────── */

const ROOT = join(tmpdir(), 'pdf-studio-line-redraw')
const IN = join(ROOT, 'in')
const OUT = join(ROOT, 'out')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(IN, { recursive: true })
mkdirSync(OUT, { recursive: true })

const SOURCE = join(IN, 'line-source.pdf')
const SIBLING = join(IN, 'line-sibling.pdf')
const TD_ANCHOR = join(IN, 'line-td-anchor.pdf')
const TIMES_FIXTURE = join(IN, 'line-times.pdf')
const IMAGE_ONLY = join(IN, 'image-only.pdf')
const outPath = name => join(OUT, name)

/** 夹具里的字号与文本矩阵缩放：页面字号 = 209 × 0.05 = 10.45pt。 */
const FIXTURE_TF_SIZE = 209
const FIXTURE_TM_SCALE = 0.05
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89

const LINE_ONE = '9.turn around/round 转身'
const LINE_TWO = 'Line two is unrelated 第二行'
const LINE_THREE = 'Line three is unrelated 第三行'

/** 第一个存在的中文字体；全都找不到时套件跳过（不作假通过）。 */
function resolveFixtureFontPath() {
  for (const candidate of CJK_FONT_CANDIDATES) if (existsSync(candidate)) return candidate
  return undefined
}

const num = value => PDFNumber.of(value)

/**
 * 生成一行文字的操作符：`q BT Tf Tm (逐字 Tj + Td) ET Q`。
 *
 * 逐字 `Td` 是关键——真实文档就是这样画的，也正是"改一个位移点搬错字"那种做法会翻车的原因。
 */
function lineOperators(font, fontKey, text, tx, ty) {
  const operators = [
    pushGraphicsState(),
    beginText(),
    setFontAndSize(fontKey, FIXTURE_TF_SIZE),
    PDFOperator.of('Tm', [
      num(FIXTURE_TM_SCALE), num(0), num(0), num(-FIXTURE_TM_SCALE), num(tx), num(ty),
    ]),
  ]
  for (const char of text) {
    operators.push(showText(font.encodeText(char)))
    operators.push(moveText(font.widthOfTextAtSize(char, FIXTURE_TF_SIZE), 0))
  }
  operators.push(endText(), popGraphicsState())
  return operators
}

async function makeLineFixture(path) {
  const fontPath = resolveFixtureFontPath()
  if (fontPath === undefined) return undefined
  const doc = await PDFDocument.create()
  doc.registerFontkit(await loadFontkitAdapter())
  const font = await doc.embedFont(await readFile(fontPath), { subset: true })
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  const fontKey = page.node.newFontDictionary('F1', font.ref)

  const operators = [
    pushGraphicsState(),
    // 与真实 WPS 文档一致的全局 y 翻转：CTM = [1 0 0 -1 0 841.89]。
    concatTransformationMatrix(1, 0, 0, -1, 0, PAGE_HEIGHT),
  ]
  operators.push(...lineOperators(font, fontKey, LINE_ONE, 109.08, 477.89))
  operators.push(...lineOperators(font, fontKey, LINE_TWO, 109.08, 447.89))
  operators.push(...lineOperators(font, fontKey, LINE_THREE, 109.08, 417.89))
  operators.push(popGraphicsState())
  page.pushOperators(...operators)

  await writeFile(path, await doc.save({ updateMetadata: false }))
  return fontPath
}

/**
 * 同一视觉行被拆成**三个** `BT … ET` 组：`9.turn` / `around/round` / `转身`，各自用自己的
 * `Tm` 绝对锚定；另有一条不同基线的对照行。
 *
 * 这正是那份 73 页 WPS 文档的真实结构。用它来验证跨组重排：新文字变长时，右侧三个组
 * 要各自按同样的 Δ 右移（只改自己的 `Tm`），对照行必须纹丝不动。
 */
async function makeMultiGroupFixture(path) {
  const fontPath = resolveFixtureFontPath()
  if (fontPath === undefined) return undefined
  const doc = await PDFDocument.create()
  doc.registerFontkit(await loadFontkitAdapter())
  const font = await doc.embedFont(await readFile(fontPath), { subset: true })
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  const fontKey = page.node.newFontDictionary('F1', font.ref)
  const operators = [
    pushGraphicsState(),
    concatTransformationMatrix(1, 0, 0, -1, 0, PAGE_HEIGHT),
  ]
  operators.push(...lineOperators(font, fontKey, '9.turn', 109.08, 477.89))
  operators.push(...lineOperators(font, fontKey, 'around/round', 136.44, 477.89))
  operators.push(...lineOperators(font, fontKey, '转身', 198.24, 477.89))
  // 对照行：不同基线，坐标与文字都不允许被改动。
  operators.push(...lineOperators(font, fontKey, 'Control line 对照行', 109.08, 447.89))
  operators.push(popGraphicsState())
  page.pushOperators(...operators)
  await writeFile(path, await doc.save({ updateMetadata: false }))
  return fontPath
}

/**
 * 兄弟组用 `Td` 相对锚定的反例。
 *
 * `BT` 之后第一个定位算符是 `Td`（而不是 `Tm`）时，本模块**不猜**——拒绝平移并给出中文原因，
 * 让调用方降级为重叠警告。
 */
async function makeTdAnchorFixture(path) {
  const fontPath = resolveFixtureFontPath()
  if (fontPath === undefined) return undefined
  const doc = await PDFDocument.create()
  doc.registerFontkit(await loadFontkitAdapter())
  const font = await doc.embedFont(await readFile(fontPath), { subset: true })
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  const fontKey = page.node.newFontDictionary('F1', font.ref)
  const operators = [
    pushGraphicsState(),
    concatTransformationMatrix(1, 0, 0, -1, 0, PAGE_HEIGHT),
  ]
  operators.push(...lineOperators(font, fontKey, '9.turn', 109.08, 477.89))
  // 第二个组：BT 后第一个定位算符是 Td。
  operators.push(pushGraphicsState(), beginText(), setFontAndSize(fontKey, FIXTURE_TF_SIZE))
  operators.push(moveText(136.44, 477.89))
  for (const char of 'around') {
    operators.push(showText(font.encodeText(char)))
    operators.push(moveText(font.widthOfTextAtSize(char, FIXTURE_TF_SIZE), 0))
  }
  operators.push(endText(), popGraphicsState())
  operators.push(popGraphicsState())
  page.pushOperators(...operators)
  await writeFile(path, await doc.save({ updateMetadata: false }))
  return fontPath
}

/** 系统里真实存在的 Times New Roman；夹具与"沿用原文家族"的断言都依赖它。 */
const TIMES_FILE = '/System/Library/Fonts/Supplemental/Times New Roman.ttf'

/** 去掉子集前缀与 pdf-lib 的数字后缀，得到可比较的家族名。 */
const normalizeFontName = (name) =>
  (name ?? '').replace(/^\//, '').replace(/^[A-Z]{6}\+/, '').replace(/-\d+$/, '')

/**
 * 复刻真文件里"按名字引用、不内嵌"的字体 + 一个内嵌的兄弟组。
 *
 * - 目标组用**手工造的非内嵌 Type0**，`BaseFont=/ABCDEF+TimesNewRomanPSMT`、带 ToUnicode 与 `/W`
 *   （真文件里的 FT67 就是这样：`/AUWCNV+TimesNewRomanPSMT`，没有 FontFile）。
 * - 兄弟组用**真正内嵌的 Times New Roman**，这样渲染时两边都应该是 Times，ink 高度才有可比性。
 *
 * 返回 `{ times }`，测试用它在同一字号下算字形列偏移。
 */
async function makeTimesFixture(path) {
  if (!existsSync(TIMES_FILE)) return undefined
  const timesBytes = new Uint8Array(await readFile(TIMES_FILE))
  const doc = await PDFDocument.create()
  doc.registerFontkit(await loadFontkitAdapter())
  const times = await doc.embedFont(timesBytes, { subset: true })
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  const siblingKey = page.node.newFontDictionary('FT', times.ref)

  // ── 手工造非内嵌 Type0（目标组用）──
  const targetText = '9.turn'
  const widthParts = []
  const bfchars = []
  for (const char of targetText) {
    const code = char.codePointAt(0)
    widthParts.push(code, [Math.round(times.widthOfTextAtSize(char, 1000))])
    const hex = code.toString(16).toUpperCase().padStart(4, '0')
    bfchars.push(`<${hex}> <${hex}>`)
  }
  const cmapText = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    `${bfchars.length} beginbfchar`,
    ...bfchars,
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n')
  const cmapRef = doc.context.register(doc.context.flateStream(Buffer.from(cmapText, 'latin1')))
  const cidFont = doc.context.obj({
    Type: 'Font',
    Subtype: 'CIDFontType2',
    BaseFont: PDFName.of('ABCDEF+TimesNewRomanPSMT'),
    CIDSystemInfo: { Registry: 'Adobe', Ordering: 'Identity', Supplement: 0 },
    FontDescriptor: {
      Type: 'FontDescriptor',
      FontName: PDFName.of('ABCDEF+TimesNewRomanPSMT'),
      Flags: 4,
      FontBBox: [-250, -250, 1000, 1000],
      ItalicAngle: 0,
      Ascent: 683,
      Descent: -217,
      CapHeight: 662,
      StemV: 80,
    },
    DW: 500,
    W: widthParts,
  })
  const cidRef = doc.context.register(cidFont)
  const type0 = doc.context.obj({
    Type: 'Font',
    Subtype: 'Type0',
    BaseFont: PDFName.of('ABCDEF+TimesNewRomanPSMT'),
    Encoding: PDFName.of('Identity-H'),
    DescendantFonts: [cidRef],
    ToUnicode: cmapRef,
  })
  const targetKey = page.node.newFontDictionary('FTmo', doc.context.register(type0))

  const operators = [
    pushGraphicsState(),
    concatTransformationMatrix(1, 0, 0, -1, 0, PAGE_HEIGHT),
  ]
  // 目标组：手工字体，码位 = Unicode 码点。
  operators.push(pushGraphicsState(), beginText(), setFontAndSize(targetKey, FIXTURE_TF_SIZE))
  operators.push(PDFOperator.of('Tm', [
    num(FIXTURE_TM_SCALE), num(0), num(0), num(-FIXTURE_TM_SCALE), num(109.08), num(477.89),
  ]))
  for (const char of targetText) {
    operators.push(showText(PDFHexString.of(char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))))
    operators.push(moveText(times.widthOfTextAtSize(char, FIXTURE_TF_SIZE), 0))
  }
  operators.push(endText(), popGraphicsState())
  // 兄弟组：内嵌 Times。
  operators.push(...lineOperators(times, siblingKey, 'around/round', 136.44, 477.89))
  // 对照行（不同基线）。
  operators.push(...lineOperators(times, siblingKey, 'Control 对照行', 109.08, 447.89))
  operators.push(popGraphicsState())
  page.pushOperators(...operators)

  await writeFile(path, await doc.save({ updateMetadata: false }))
  return { times }
}

/** 用真实 canvas（子进程、不加载 dom-shim）测 ink 高度。 */
function renderInk(pdfPath, spec) {
  const helper = fileURLToPath(new URL('./support/render-ink.mjs', import.meta.url))
  const stdout = execFileSync(process.execPath, ['--experimental-strip-types', helper, pdfPath, JSON.stringify(spec)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return JSON.parse(stdout.trim())
}

/** 只有图形、没有文字层的页面（模拟图片页）。 */
async function makeImageOnlyFixture(path) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  const operators = [
    pushGraphicsState(),
    PDFOperator.of('re', [num(50), num(50), num(400), num(600)]),
    PDFOperator.of('f', []),
    popGraphicsState(),
  ]
  page.pushOperators(...operators)
  await writeFile(path, await doc.save({ updateMetadata: false }))
}

const fontPath = await makeLineFixture(SOURCE)
if (fontPath === undefined) {
  console.log('SKIP：系统里找不到可用的中文字体，无法生成夹具。')
  process.exitCode = 0
} else {
  await makeImageOnlyFixture(IMAGE_ONLY)
  await makeMultiGroupFixture(SIBLING)
  await makeTdAnchorFixture(TD_ANCHOR)
  const timesFixture = await makeTimesFixture(TIMES_FIXTURE)
  console.log(`夹具字体：${fontPath}`)

  const SOURCE_BYTES = new Uint8Array(await readFile(SOURCE))
  const SOURCE_HASH = sha(SOURCE_BYTES)

  /** 用 pdf.js 取一页的文本行（每次从磁盘重读，避免 pdf.js 转移走 buffer）。 */
  async function readLines(path, page = 1) {
    const doc = await openPdfBytes(new Uint8Array(await readFile(path)))
    try {
      return await extractTextLayer(doc, page)
    } finally {
      await doc.dispose()
    }
  }
  const findLine = (lines, needle) => lines.find(line => norm(line.text).includes(norm(needle)))

  /**
   * 用 pdf-lib + 本模块读出**所有内容流**里的文本组。
   *
   * 必须遍历全部内容流：pdf-lib 追加绘制内容时会把原流用 q/Q 包起来并新增一条流，
   * 原流不一定在第 0 条。返回带页面原点、宽度与原文的 `TextGroup`。
   */
  async function readGroups(path, pageNumber = 1) {
    const doc = await PDFDocument.load(new Uint8Array(await readFile(path)))
    const page = doc.getPages()[pageNumber - 1]
    const streams = readPageContentStreams(page, doc.context)
    const runs = listReadableRuns(streams, readPageFonts(doc.context, page))
    const groups = []
    for (const stream of streams) {
      const operations = parseOperations(tokenize(stream.text))
      const states = trackGraphicsState(operations)
      groups.push(...collectTextGroups(operations, states, runs.filter(run => run.streamIndex === stream.index)))
    }
    // 重绘后目标组的原字形已被抹空（原文为空串）——那不是"文字组"，过滤掉，
    // 否则它会在同一基线上多出一个空组，干扰位移断言。
    return groups.filter(group => group.geometry.groupText !== '')
  }
  /** 目标文字块 id（第一行第一个字）。 */
  const firstRunId = async path => {
    const doc = await PDFDocument.load(new Uint8Array(await readFile(path)))
    const page = doc.getPages()[0]
    const streams = readPageContentStreams(page, doc.context)
    return listReadableRuns(streams, readPageFonts(doc.context, page))[0]?.id
  }

  const beforeLines = await readLines(SOURCE)
  const beforeOne = findLine(beforeLines, LINE_ONE)
  const beforeTwo = findLine(beforeLines, LINE_TWO)
  const beforeThree = findLine(beforeLines, LINE_THREE)

  // 目标文字块 = 第 1 行第一个字（'9'）的 id。这里从模块自身读出来，不硬编码。
  const modelDoc = await PDFDocument.load(SOURCE_BYTES)
  const modelPage = modelDoc.getPages()[0]
  const modelStreams = readPageContentStreams(modelPage, modelDoc.context)
  const modelRuns = listReadableRuns(modelStreams, readPageFonts(modelDoc.context, modelPage))
  const targetRun = modelRuns[0]
  const TARGET_ID = targetRun?.id
  const operations = parseOperations(tokenize(modelStreams[0].text))
  const streamRuns = modelRuns.filter(run => run.streamIndex === 0)

  /* ── 1. 核心几何 ───────────────────────────────────────────────────────── */

  console.log('\n1. 核心几何（CTM / Tm / 页面坐标 / 字号）\n')

  check('夹具里能读出目标文字块 id', typeof TARGET_ID === 'string' && TARGET_ID.includes(':'), String(TARGET_ID))
  check('目标文字块解码成夹具首字符', targetRun?.text === LINE_ONE[0], JSON.stringify(targetRun?.text))
  checkEq('夹具共 3 行文字', beforeLines.length, 3)

  const states = trackGraphicsState(operations)
  const targetIndex = targetRun.operationIndex
  const targetState = states.get(targetIndex)
  check('trackGraphicsState 覆盖目标 show 操作', targetState !== undefined)
  check('CTM 追踪到了全局 y 翻转 [1 0 0 -1 0 841.89]',
    targetState !== undefined
      && near(targetState.ctm.a, 1) && near(targetState.ctm.b, 0)
      && near(targetState.ctm.c, 0) && near(targetState.ctm.d, -1)
      && near(targetState.ctm.f, PAGE_HEIGHT),
    targetState === undefined ? '（无状态）' : JSON.stringify(targetState.ctm))
  check('Tm 追踪到了 0.05 缩放', targetState !== undefined && near(targetState.tm.a, FIXTURE_TM_SCALE),
    targetState === undefined ? '（无状态）' : JSON.stringify(targetState.tm))
  checkEq('Tf 字号被记录', targetState?.fontSize, FIXTURE_TF_SIZE)
  check('渲染模式默认 0', targetState?.renderMode === 0)

  const range = findTextGroup(operations, targetIndex)
  check('findTextGroup 找到了 BT…ET 区间', range !== undefined)
  checkEq('区间起点是 BT', range === undefined ? '' : operations[range.start].op, 'BT')
  checkEq('区间终点是 ET', range === undefined ? '' : operations[range.end].op, 'ET')

  const geometry = range === undefined
    ? undefined
    : pageSpaceGeometry(operations, states, streamRuns, range)
  check('pageSpaceGeometry 算出了几何', geometry !== undefined)
  check('页面坐标原点 = (109.08, 364.00)（841.89 − 477.89）',
    geometry !== undefined && near(geometry.origin.x, 109.08) && near(geometry.origin.y, PAGE_HEIGHT - 477.89),
    geometry === undefined ? '（无几何）' : JSON.stringify(geometry.origin))
  check('页面字号 = 209 × 0.05 = 10.45pt',
    geometry !== undefined && near(geometry.pageFontSize, 10.45),
    geometry === undefined ? '（无几何）' : String(geometry.pageFontSize))
  checkEq('组内原文完整拼出目标行', geometry?.groupText, LINE_ONE)
  checkEq('组内 show 数量 = 目标行字符数', geometry?.showCount, LINE_ONE.length)

  const blanked = range === undefined ? undefined : blankGroupGlyphs(modelStreams[0].text, operations, range)
  check('blankGroupGlyphs 抹掉了组内每个 show 的字形',
    blanked !== undefined && blanked.blankedShows === LINE_ONE.length,
    blanked === undefined ? '（无结果）' : String(blanked.blankedShows))
  if (blanked !== undefined && range !== undefined) {
    const afterOps = parseOperations(tokenize(blanked.text))
    const leftovers = []
    for (let index = range.start; index <= range.end; index += 1) {
      const op = afterOps[index]
      if (op === undefined) continue
      for (const token of op.operands.filter(item => item.kind === 'string')) {
        if (token.raw !== '<>') leftovers.push(token.raw.slice(0, 12))
      }
    }
    check('抹除后组内不再有任何非空字形串', leftovers.length === 0, leftovers.join(','))
    checkEq('抹除后操作数总量不变（只换字节，不删操作）', afterOps.length, operations.length)
  }

  /* ── 2. TJ 数组的抹除（数字保留、注释不丢） ─────────────────────────────── */

  console.log('\n2. TJ 数组：字形清空、字距数字与注释原样保留\n')

  {
    const tjText = 'q BT /F1 12 Tf 1 0 0 1 10 10 Tm [<0041> -250 % keep me\n <0042>] TJ ET Q'
    const tjOps = parseOperations(tokenize(tjText))
    // 操作表：0 q / 1 BT / 2 Tf / 3 Tm / 4 TJ / 5 ET / 6 Q
    const tjRange = findTextGroup(tjOps, 4)
    const result = tjRange === undefined ? undefined : blankGroupGlyphs(tjText, tjOps, tjRange)
    check('TJ 数组被识别为可抹除的字形串', result !== undefined && result.blankedShows === 1)
    check('TJ 里的字符串元素被替换成空串', result !== undefined && !/<0041>|<0042>/.test(result.text),
      result === undefined ? '（无结果）' : JSON.stringify(result.text))
    check('TJ 里的字距数字 -250 保留', result !== undefined && result.text.includes('-250'))
    check('TJ 里的注释 % keep me 保留', result !== undefined && result.text.includes('% keep me'))
  }

  /* ── 3. 工具：确认闸门 + 整行重绘 ─────────────────────────────────────── */

  console.log('\n3. pdf_replace_line：确认单 → 执行 → 结果\n')

  // 默认策略（destructive）：破坏性操作必须先给确认单。
  const tools = new Map(buildToolDefinitions({ workspaceRoot: OUT }).map(tool => [tool.name, tool]))
  const replaceLine = tools.get('pdf_replace_line')
  check('pdf_replace_line 已注册', replaceLine !== undefined)
  checkEq('工具表共 8 个工具', tools.size, 8)
  check('pdf_replace_line 带 plan/confirm/force',
    ['plan', 'confirm', 'force'].every(key => key in replaceLine.parameters.properties),
    Object.keys(replaceLine.parameters.properties).join(','))

  const OUTPUT = outPath('line-done.pdf')
  const runTool = async (args) => {
    const value = await replaceLine.execute(args)
    const rendered = replaceLine.output.render(args, value)
    return rendered[0].text
  }
  const isPlanText = text => text.startsWith('⚠️ 这个操作需要你确认后才会执行。')
  const planIdOf = text => {
    const match = /计划 id：(p_[0-9a-f]+)/.exec(text)
    if (match === null) throw new Error(`确认单里没有 plan id：\n${text}`)
    return match[1]
  }

  const NEW_LINE = '9.turning around/round 转身'
  const planText = await runTool({ path: SOURCE, page: 1, targetId: TARGET_ID, text: NEW_LINE, output: OUTPUT })
  check('未确认时返回确认单', isPlanText(planText), planText.split('\n')[0])
  check('确认单写明动作是「整行重绘」', planText.includes('动作：整行重绘'))
  check('未确认时不落盘', !existsSync(OUTPUT))
  check('未确认时源文件字节不变', sha(new Uint8Array(await readFile(SOURCE))) === SOURCE_HASH)

  const planId = planIdOf(planText)
  const doneText = await runTool({ path: SOURCE, page: 1, targetId: TARGET_ID, text: NEW_LINE, output: OUTPUT, confirm: planId })
  check('带正确 confirm 后生成新文件', existsSync(OUTPUT))
  check('结果第一行是「已生成：<路径>」', doneText.split('\n')[0] === `已生成：${OUTPUT}`, doneText.split('\n')[0])
  check('结果说明这一行改成了什么', doneText.includes(`这一行改成了：${NEW_LINE}`))
  check('结果给出被抹掉的原文', doneText.includes('被抹掉的原文：9.turn around/round 转身'),
    doneText.split('\n').find(line => line.startsWith('被抹掉的原文：')))
  check('结果提示该组包含多个文字块', doneText.includes('整组抹除并重绘'))
  check('源文件在执行后依然字节不变', sha(new Uint8Array(await readFile(SOURCE))) === SOURCE_HASH)

  /* ── 4. 输出文件：新文字在、旧文字没了、其它行不变 ─────────────────────── */

  console.log('\n4. 输出文件的内容与结构\n')

  const afterLines = await readLines(OUTPUT)
  const afterOne = findLine(afterLines, NEW_LINE)
  check('输出文件里能提取到新行', afterOne !== undefined, afterLines.map(line => norm(line.text)).join(' | '))
  check('旧行文字不再被提取到（抹除生效，不是盖了一层）',
    !afterLines.some(line => norm(line.text).includes(norm(LINE_ONE))))
  check('新行里新旧文字没有叠在一起（不会同时出现 turn 与 turning 两段）',
    afterOne !== undefined && !norm(afterOne.text).includes('9.turnaround/round转身'))
  {
    const pagesDoc = await openPdfBytes(new Uint8Array(await readFile(OUTPUT)))
    checkEq('页面数不变', pagesDoc.numPages, 1)
    await pagesDoc.dispose()
  }

  const afterTwo = findLine(afterLines, LINE_TWO)
  const afterThree = findLine(afterLines, LINE_THREE)
  check('第 2 行文字完全没变', afterTwo !== undefined && beforeTwo !== undefined
    && norm(afterTwo.text) === norm(beforeTwo.text),
    afterTwo === undefined ? '（丢失）' : norm(afterTwo.text))
  check('第 3 行文字完全没变', afterThree !== undefined && beforeThree !== undefined
    && norm(afterThree.text) === norm(beforeThree.text),
    afterThree === undefined ? '（丢失）' : norm(afterThree.text))
  check('第 2 行坐标完全没变', afterTwo !== undefined && beforeTwo !== undefined
    && near(afterTwo.rect.x, beforeTwo.rect.x) && near(afterTwo.rect.y, beforeTwo.rect.y)
    && near(afterTwo.rect.width, beforeTwo.rect.width))
  check('第 3 行坐标完全没变', afterThree !== undefined && beforeThree !== undefined
    && near(afterThree.rect.x, beforeThree.rect.x) && near(afterThree.rect.y, beforeThree.rect.y)
    && near(afterThree.rect.width, beforeThree.rect.width))

  {
    const qpdf = await runQpdf(['--check'], new Uint8Array(await readFile(OUTPUT)), 'read-only')
    check('qpdf --check 通过', qpdf.exit === 0, `exit=${qpdf.exit} ${qpdf.output.split('\n')[0] ?? ''}`)
  }

  /* ── 5. 不重叠（本功能存在的理由，必须量化） ───────────────────────────── */

  console.log('\n5. 改长之后不与右侧/下一行重叠（量化断言）\n')

  check('新行确实变长了（bbox 宽度增加）',
    afterOne !== undefined && beforeOne !== undefined && afterOne.rect.width > beforeOne.rect.width + 1,
    afterOne === undefined || beforeOne === undefined
      ? '（缺 bbox）'
      : `${beforeOne.rect.width.toFixed(2)} → ${afterOne.rect.width.toFixed(2)}`)
  check('新行与第 2 行 bbox 不相交',
    afterOne !== undefined && afterTwo !== undefined && !rectsIntersect(afterOne.rect, afterTwo.rect),
    afterOne === undefined || afterTwo === undefined
      ? '（缺 bbox）'
      : `${JSON.stringify(afterOne.rect)} vs ${JSON.stringify(afterTwo.rect)}`)
  check('新行与第 3 行 bbox 不相交',
    afterOne !== undefined && afterThree !== undefined && !rectsIntersect(afterOne.rect, afterThree.rect),
    afterOne === undefined || afterThree === undefined
      ? '（缺 bbox）'
      : `${JSON.stringify(afterOne.rect)} vs ${JSON.stringify(afterThree.rect)}`)
  if (afterOne !== undefined) {
    const sorted = [...afterOne.runs].sort((a, b) => a.x - b.x)
    let overlaps = 0
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]
      const right = previous.x + (previous.width ?? 0)
      if (sorted[index].x < right - 0.1) overlaps += 1
    }
    check('新行内部相邻文本块之间没有相互压字', overlaps === 0, `overlaps=${overlaps}`)
  }
  check('新行的基线 y 与原来一致（没有被搬到别处）',
    afterOne !== undefined && beforeOne !== undefined && near(afterOne.rect.y, beforeOne.rect.y, 0.5),
    afterOne === undefined || beforeOne === undefined
      ? '（缺 bbox）'
      : `${beforeOne?.rect.y} → ${afterOne?.rect.y}`)
  check('新行左边界与原来一致',
    afterOne !== undefined && beforeOne !== undefined && near(afterOne.rect.x, beforeOne.rect.x, 0.5))

  /* ── 6. 确认令牌：改参数拒绝、二次执行拒绝、缺参数不能被绕过 ────────────── */

  console.log('\n6. 确认令牌的强校验\n')

  {
    const other = outPath('line-token.pdf')
    const planA = await runTool({ path: SOURCE, page: 1, targetId: TARGET_ID, text: '9.turn', output: other })
    const tokenA = planIdOf(planA)
    const tampered = await tryCall(() => runTool({
      path: SOURCE, page: 1, targetId: TARGET_ID, text: '9.turned', output: other, confirm: tokenA,
    }))
    check('改了 text 参数后带旧 planId 被拒绝',
      tampered.ok === false && tampered.message.includes('不一致'), tampered.message.split('\n')[0])
    check('被拒绝时没有落盘', !existsSync(other))

    // shiftSiblings 必须参与 planId：默认 true 的计划，改成 false 后不能复用旧令牌。
    check('确认单把 shiftSiblings 默认值写进参数', planA.includes('shiftSiblings=true'),
      planA.split('\n').find(line => line.startsWith('参数：')) ?? '（无参数行）')
    const tamperedShift = await tryCall(() => runTool({
      path: SOURCE, page: 1, targetId: TARGET_ID, text: '9.turn', output: other,
      shiftSiblings: false, confirm: tokenA,
    }))
    check('改了 shiftSiblings 后带旧 planId 被拒绝',
      tamperedShift.ok === false && tamperedShift.message.includes('不一致'),
      tamperedShift.message.split('\n')[0])

    const replay = await tryCall(() => runTool({
      path: SOURCE, page: 1, targetId: TARGET_ID, text: NEW_LINE, output: OUTPUT, confirm: planId,
    }))
    check('同一个 planId 二次执行被拒绝',
      replay.ok === false && replay.message.includes('已经执行过一次'), replay.message.split('\n')[0])

    // 缺 targetId / text：先给确认单；带 confirm 也不能绕过。
    const missing = await runTool({ path: SOURCE, page: 1, output: outPath('line-missing.pdf') })
    check('缺 targetId/text 时返回确认单', isPlanText(missing), missing.split('\n')[0])
    check('确认单把缺失参数列为「待确认」',
      missing.includes('待确认：') && missing.includes('targetId') && missing.includes('text'),
      missing.split('\n').find(line => line.startsWith('待确认：')))
    const missingWithConfirm = await tryCall(() => runTool({
      path: SOURCE, page: 1, output: outPath('line-missing.pdf'), confirm: planIdOf(missing),
    }))
    check('缺关键参数时带 confirm 也不能执行',
      missingWithConfirm.ok === false && missingWithConfirm.message.includes('不能靠确认继续'),
      missingWithConfirm.message.split('\n')[0])
    check('缺参数时没有落盘', !existsSync(outPath('line-missing.pdf')))
  }

  /* ── 7. 错误路径：给出中文原因，而不是崩溃 ─────────────────────────────── */

  console.log('\n7. 错误路径的中文原因\n')

  {
    // 用 never 策略的实例，直接走到执行路径，看错误消息本身。
    const plain = new Map(
      buildToolDefinitions({ workspaceRoot: OUT, confirmation: 'never' }).map(tool => [tool.name, tool]),
    )
    const run = async args => {
      const value = await plain.get('pdf_replace_line').execute(args)
      return plain.get('pdf_replace_line').output.render(args, value)[0].text
    }

    const ghost = await tryCall(() => run({
      path: SOURCE, page: 1, targetId: '0:99999', text: 'x', output: outPath('ghost.pdf'),
    }))
    check('找不到 targetId：给出中文原因而不是崩溃',
      ghost.ok === false && ghost.message.includes('找不到文字块') && /[\u4e00-\u9fff]/.test(ghost.message),
      ghost.message.split('\n')[0])
    check('找不到 targetId：不写盘', !existsSync(outPath('ghost.pdf')))

    const badId = await tryCall(() => run({
      path: SOURCE, page: 1, targetId: 'not-an-id', text: 'x', output: outPath('bad-id.pdf'),
    }))
    check('targetId 格式不对：给出中文原因',
      badId.ok === false && badId.message.includes('格式不对'), badId.message.split('\n')[0])

    const imagePage = await tryCall(() => run({
      path: IMAGE_ONLY, page: 1, targetId: '0:0', text: 'x', output: outPath('image.pdf'),
    }))
    check('图片页（无文字层）：给出中文原因而不是崩溃',
      imagePage.ok === false && imagePage.message.includes('没有文字层'), imagePage.message.split('\n')[0])
    check('图片页：不写盘', !existsSync(outPath('image.pdf')))

    const ghostPage = await tryCall(() => run({
      path: SOURCE, page: 99, targetId: '0:6', text: 'x', output: outPath('page99.pdf'),
    }))
    check('页码越界：给出中文原因',
      ghostPage.ok === false && ghostPage.message.includes('第 99 页不存在'), ghostPage.message.split('\n')[0])
  }

  /* ── 8. 跨组重排：同一视觉行的兄弟组整体右移 ───────────────────────────── */

  console.log('\n8. shiftSiblings=true：同一视觉行右侧的兄弟组整体右移\n')

  const MULTI_NEW = '9.turning'
  {
    // 夹具结构：`9.turn`(109.08) / `around/round`(136.44) / `转身`(198.24) 同基线，
    // 另有对照行（不同基线）。
    const beforeGroups = await readGroups(SIBLING)
    const beforeLineA = beforeGroups
      .filter(group => Math.abs(group.geometry.origin.y - 364.01) < 1.5)
      .sort((a, b) => a.geometry.origin.x - b.geometry.origin.x)
    check('多组夹具：同一基线上有 3 个组（目标 + 2 个兄弟）', beforeLineA.length === 3,
      beforeLineA.map(group => `${group.geometry.origin.x.toFixed(2)}:${group.geometry.groupText}`).join(' | '))
    check('多组夹具：兄弟组原文依次是 around/round、转身',
      beforeLineA.slice(1).map(group => group.geometry.groupText).join(',') === 'around/round,转身',
      beforeLineA.slice(1).map(group => group.geometry.groupText).join(','))
    const foundSiblings = siblingGroupsOnSameLine(beforeGroups, beforeLineA[0], { tolerance: 1.2 })
    check('siblingGroupsOnSameLine 找到右侧 2 个同基线组（不含对照行）',
      foundSiblings.length === 2
        && foundSiblings.every(group => group.geometry.origin.x > beforeLineA[0].geometry.origin.x),
      foundSiblings.map(group => `${group.geometry.origin.x}:${group.geometry.groupText}`).join(' | '))
    const targetSiblingId = (await firstRunId(SIBLING))

    const shifted = await redrawLineInPdfBytes(new Uint8Array(await readFile(SIBLING)), {
      page: 1, targetId: targetSiblingId, text: MULTI_NEW, shiftSiblings: true,
    })
    await writeFile(outPath('line-multi-shift.pdf'), shifted.bytes)
    const report = shifted.result.siblingShift
    check('跨组重排：报告 2 个组被右移', report?.shifted === 2, JSON.stringify(report))
    check('跨组重排：右移量为正（新文字变长）', (report?.deltaPageX ?? 0) > 0, String(report?.deltaPageX))
    check('跨组重排：没有平移失败的组', report?.failed.length === 0, JSON.stringify(report?.failed))
    check('跨组重排：结果里如实汇报右移了多少', shifted.result.notes.some(note =>
      note.includes('已把同一视觉行右侧') && note.includes('右移')), shifted.result.notes.join(' | '))

    // 每个兄弟组的页面原点 x 恰好 +Δ（逐一断言，容差 0.05pt）。
    const afterGroups = await readGroups(outPath('line-multi-shift.pdf'))
    const afterLineA = afterGroups
      .filter(group => Math.abs(group.geometry.origin.y - 364.01) < 1.5)
      .sort((a, b) => a.geometry.origin.x - b.geometry.origin.x)
    const beforeSiblings = beforeLineA.slice(1)
    const afterSiblings = afterLineA.slice(1)
    checkEq('跨组重排后同基线组数不变', afterLineA.length, 3)
    for (let index = 0; index < beforeSiblings.length; index += 1) {
      const expected = beforeSiblings[index].geometry.origin.x + (report?.deltaPageX ?? 0)
      const actual = afterSiblings[index]?.geometry.origin.x
      check(`跨组重排：兄弟「${beforeSiblings[index].geometry.groupText}」原点右移 Δ`,
        actual !== undefined && near(actual, expected, 0.05),
        `before=${beforeSiblings[index].geometry.origin.x.toFixed(2)} expected=${expected.toFixed(2)} actual=${actual?.toFixed(2)}`)
      check(`跨组重排：兄弟「${beforeSiblings[index].geometry.groupText}」原文不变`,
        afterSiblings[index]?.geometry.groupText === beforeSiblings[index].geometry.groupText)
    }

    // 不重叠：用 pdf.js 的 run 位置量化。
    const afterLine = (await readLines(outPath('line-multi-shift.pdf')))
      .find(line => Math.abs(line.rect.y - 364.01) < 1.5)
    check('跨组重排后能提取到新行', afterLine !== undefined, JSON.stringify(afterLine?.text))
    if (afterLine !== undefined) {
      const runs = [...afterLine.runs].sort((a, b) => a.x - b.x)
      // pdf.js 会按间距把相邻片段合并成一个 run（这里是 around/round + 转身），
      // 所以只断言"至少拆成新文字与右侧片段两段"，重叠与否由下面的量化断言决定。
      check('新行至少被拆成新文字与右侧片段两段', runs.length >= 2, runs.map(run => run.text).join('|'))
      let overlaps = 0
      for (let index = 1; index < runs.length; index += 1) {
        const right = runs[index - 1].x + (runs[index - 1].width ?? 0)
        if (runs[index].x < right - 0.05) overlaps += 1
      }
      check('跨组重排后同一视觉行内没有压字（相邻 run 不重叠）', overlaps === 0,
        `overlaps=${overlaps} runs=${runs.map(run => `${run.x.toFixed(1)}..${(run.x + (run.width ?? 0)).toFixed(1)}`).join(' ')}`)
      const turning = runs.find(run => norm(run.text).includes('turning'))
      const around = runs.find(run => norm(run.text).includes('around'))
      check('新文字右边界 ≤ 下一个片段的新起点（量化不重叠）',
        turning !== undefined && around !== undefined
          && turning.x + (turning.width ?? 0) <= around.x + 0.05,
        turning === undefined || around === undefined
          ? '缺 run'
          : `turning right=${(turning.x + (turning.width ?? 0)).toFixed(2)} around left=${around.x.toFixed(2)}`)
    }

    // 对照行（另一条基线）必须坐标与文字完全不变。
    const controlBefore = beforeGroups.filter(group => Math.abs(group.geometry.origin.y - 394.01) < 1.5)
      .sort((a, b) => a.geometry.origin.x - b.geometry.origin.x)
    const controlAfter = afterGroups.filter(group => Math.abs(group.geometry.origin.y - 394.01) < 1.5)
      .sort((a, b) => a.geometry.origin.x - b.geometry.origin.x)
    check('对照行组数不变', controlBefore.length === controlAfter.length && controlBefore.length > 0,
      `${controlBefore.length} vs ${controlAfter.length}`)
    check('对照行每个组的原点与文字都完全不变',
      controlBefore.length === controlAfter.length
        && controlBefore.every((group, index) => near(group.geometry.origin.x, controlAfter[index].geometry.origin.x, 0.001)
          && near(group.geometry.origin.y, controlAfter[index].geometry.origin.y, 0.001)
          && group.geometry.groupText === controlAfter[index].geometry.groupText),
      controlBefore.map(group => `${group.geometry.origin.x}:${group.geometry.groupText}`).join(' | '))
  }

  /* ── 9. shiftSiblings=false：不动版面 + 重叠警告 ───────────────────────── */

  console.log('\n9. shiftSiblings=false：相邻组原地不动，并给出重叠警告\n')

  {
    const targetId = await firstRunId(SIBLING)
    const plain = buildToolDefinitions({ workspaceRoot: OUT, confirmation: 'never' })
      .find(tool => tool.name === 'pdf_replace_line')
    const OUT_NO_SHIFT = outPath('line-multi-noshift.pdf')
    const text = (await plain.execute({
      path: SIBLING, page: 1, targetId, text: MULTI_NEW, output: OUT_NO_SHIFT, shiftSiblings: false,
    })).text
    check('shiftSiblings=false：结果给出中文重叠警告',
      text.includes('相邻绘制组') && text.includes('重叠') && text.includes('shiftSiblings=false'),
      text.split('\n').find(line => line.includes('重叠'))?.slice(0, 80) ?? text.split('\n').slice(-1)[0])
    check('shiftSiblings=false：结果行说明没有移动相邻片段',
      text.split('\n').some(line => line.startsWith('相邻片段处理') && line.includes('shiftSiblings=false')),
      text.split('\n').find(line => line.startsWith('相邻片段处理')) ?? '（无该行）')

    const before = (await readGroups(SIBLING)).filter(group => Math.abs(group.geometry.origin.y - 364.01) < 1.5)
      .sort((a, b) => a.geometry.origin.x - b.geometry.origin.x)
    const after = (await readGroups(OUT_NO_SHIFT)).filter(group => Math.abs(group.geometry.origin.y - 364.01) < 1.5)
      .sort((a, b) => a.geometry.origin.x - b.geometry.origin.x)
    check('shiftSiblings=false：所有兄弟组原点保持不变',
      before.slice(1).every((group, index) => near(group.geometry.origin.x, after.slice(1)[index].geometry.origin.x, 0.001)),
      after.slice(1).map(group => group.geometry.origin.x.toFixed(2)).join(','))
  }

  /* ── 10. Td 锚定的兄弟组：不猜，给出无法安全平移的原因 ─────────────────── */

  console.log('\n10. Td 锚定的相邻组：拒绝平移并说明原因\n')

  {
    const tdTargetId = await firstRunId(TD_ANCHOR)
    const result = await redrawLineInPdfBytes(new Uint8Array(await readFile(TD_ANCHOR)), {
      page: 1, targetId: tdTargetId, text: MULTI_NEW, shiftSiblings: true,
    })
    await writeFile(outPath('line-td-shift.pdf'), result.bytes)
    check('Td 锚定组：没有任何组被平移', result.result.siblingShift?.shifted === 0,
      JSON.stringify(result.result.siblingShift))
    check('Td 锚定组：给出「无法安全平移」的中文原因',
      result.result.siblingShift?.failed.some(failure => failure.reason.includes('相对定位'))
        ?? false,
      JSON.stringify(result.result.siblingShift?.failed))
    check('Td 锚定组：结果里如实说明它没被移动、可能重叠',
      result.result.notes.some(note => note.includes('无法平移相邻片段') && note.includes('重叠')),
      result.result.notes.join(' | '))

    const after = (await readGroups(outPath('line-td-shift.pdf')))
      .filter(group => Math.abs(group.geometry.origin.y - 364.01) < 1.5)
      .sort((a, b) => a.geometry.origin.x - b.geometry.origin.x)
    check('Td 锚定组：原点仍是 136.44（没有被移动）',
      after.some(group => near(group.geometry.origin.x, 136.44, 0.001)),
      after.map(group => group.geometry.origin.x.toFixed(2)).join(','))
  }

  /* ── 11. 溢出：越出页面右边界只警告，不拒绝写盘 ────────────────────────── */

  console.log('\n11. 平移后越出页面：给出警告但仍然写出文件\n')

  {
    const targetId = await firstRunId(SIBLING)
    const OVERFLOW_OUT = outPath('line-overflow.pdf')
    if (existsSync(OVERFLOW_OUT)) rmSync(OVERFLOW_OUT)
    // 足够长的中文，让最右边界超过 595.28pt。
    const longText = '9.turning ' + '这一行故意写得很长很长很长'.repeat(6)
    const result = await redrawLineInPdfBytes(new Uint8Array(await readFile(SIBLING)), {
      page: 1, targetId, text: longText, shiftSiblings: true,
    })
    await writeFile(OVERFLOW_OUT, result.bytes)
    check('溢出：报告里给出「超出页面」警告',
      result.result.notes.some(note => note.includes('超出页面')), result.result.notes.join(' | '))
    check('溢出：报告里记录了右边界与页面宽度',
      result.result.siblingShift?.overflow !== undefined
        && result.result.siblingShift.overflow.rightEdge > result.result.siblingShift.overflow.pageWidth,
      JSON.stringify(result.result.siblingShift?.overflow))
    check('溢出：文件仍然写出（不因越界而拒绝执行）', existsSync(OVERFLOW_OUT))
    const qpdfOverflow = await runQpdf(['--check'], new Uint8Array(await readFile(OVERFLOW_OUT)), 'read-only')
    check('溢出：写出的文件结构仍然有效（qpdf --check exit 0）', qpdfOverflow.exit === 0,
      `exit=${qpdfOverflow.exit}`)
  }

  /* ── 12. 沿用原文的字体家族（真文件里 Times New Roman 的场景） ───────────── */

  console.log('\n12. 重画优先沿用原文的字体家族（Times New Roman），并用真实 canvas 对比 ink 高度\n')

  if (timesFixture === undefined) {
    console.log('SKIP：系统里没有 Times New Roman，跳过字体家族相关断言。')
  } else {
    const { times } = timesFixture
    // 夹具里的字体名：目标组是 /ABCDEF+TimesNewRomanPSMT（非内嵌），兄弟组是内嵌 Times。
    const fixtureFonts = await (async () => {
      const doc = await PDFDocument.load(new Uint8Array(await readFile(TIMES_FIXTURE)))
      return readPageFonts(doc.context, doc.getPages()[0])
    })()
    const targetBase = [...fixtureFonts.values()].find(info => (info.baseFont ?? '').includes('TimesNewRoman'))
    check('夹具里目标组的字体是带子集前缀的非内嵌 Times',
      targetBase !== undefined && normalizeFontName(targetBase.baseFont) === 'TimesNewRomanPSMT',
      [...fixtureFonts.values()].map(info => info.baseFont).join(', '))

    const timesTargetId = await firstRunId(TIMES_FIXTURE)
    const result = await redrawLineInPdfBytes(new Uint8Array(await readFile(TIMES_FIXTURE)), {
      page: 1, targetId: timesTargetId, text: '9.turning', shiftSiblings: true,
    })
    const TIMES_OUT = outPath('line-times-out.pdf')
    await writeFile(TIMES_OUT, result.bytes)
    check('字体家族：matched=true（沿用了原文家族）', result.result.fontChoice.matched === true,
      JSON.stringify(result.result.fontChoice))
    check('字体家族：用的是 Times New Roman 文件',
      result.result.fontChoice.usedPath.includes('Times New Roman'), result.result.fontChoice.usedPath)
    check('字体家族：结果里写明已沿用', result.result.notes.some(note => note.includes('已沿用原文的字体家族')),
      result.result.notes.join(' | '))

    // 读回输出：新文字所在内容流的 Tf 指向的字体，其 BaseFont 去前缀后应与兄弟组一致。
    const outDoc = await PDFDocument.load(new Uint8Array(await readFile(TIMES_OUT)))
    const outPage = outDoc.getPages()[0]
    const outStreams = readPageContentStreams(outPage, outDoc.context)
    const outFonts = readPageFonts(outDoc.context, outPage)
    const drawingStream = outStreams[outStreams.length - 1]
    const drawingShows = [...trackGraphicsState(parseOperations(tokenize(drawingStream.text))).values()]
    const newFontName = drawingShows.find(show => show.fontName !== undefined)?.fontName
    const newBase = newFontName === undefined ? undefined : outFonts.get(newFontName)?.baseFont
    check('字体家族：新文字的字体不再是 Arial Unicode', normalizeFontName(newBase) !== 'ArialUnicodeMS',
      String(newBase))
    check('字体家族：新文字的 BaseFont 与兄弟组一致（去子集前缀后）',
      normalizeFontName(newBase) === 'TimesNewRomanPSMT', String(newBase))

    // ink 高度：用"只含 x-height 的字形列"比较——整段 run 的 ink 高度会被 'g' 的降部、
    // '9' 的数字高度等字形差异污染，不能直接代表"字面大小"。
    // 新文字 '9.turning' 里的 'u','r','n'；兄弟组 'around/round' 里的 'a','r','o','u','n'。
    const size = FIXTURE_TF_SIZE * FIXTURE_TM_SCALE
    const newX0 = result.result.origin.x + times.widthOfTextAtSize('9.t', size)
    const newX1 = newX0 + times.widthOfTextAtSize('urn', size)
    const siblingX = 136.44 + (result.result.siblingShift?.deltaPageX ?? 0)
    const sibX0 = siblingX
    const sibX1 = siblingX + times.widthOfTextAtSize('aroun', size)
    const ink = renderInk(TIMES_OUT, {
      page: 1,
      scale: 6,
      band: [358, 370],
      columns: [
        { name: 'new', x0: newX0, x1: newX1 },
        { name: 'sibling', x0: sibX0, x1: sibX1 },
      ],
    })
    const newInk = ink.find(entry => entry.name === 'new')
    const sibInk = ink.find(entry => entry.name === 'sibling')
    check('ink 测量：两侧都测到了墨迹',
      (newInk?.inkHeightPt ?? 0) > 0 && (sibInk?.inkHeightPt ?? 0) > 0,
      JSON.stringify(ink))
    const ratio = (newInk?.inkHeightPt ?? 0) / (sibInk?.inkHeightPt ?? 1)
    check('ink 高度：新文字与兄弟组的 x-height 比值在 ±5% 内（沿用同族字体后视觉一致）',
      Math.abs(ratio - 1) <= 0.05,
      `new=${newInk?.inkHeightPt}pt sibling=${sibInk?.inkHeightPt}pt ratio=${ratio.toFixed(3)}`)

    /* ── 13. 回退路径：新文字含 Times 没有的字符 → 换字体并说明 ─────────────── */

    console.log('\n13. 新文字含原文没有的字符：显式回退并说明\n')

    const fallback = await redrawLineInPdfBytes(new Uint8Array(await readFile(TIMES_FIXTURE)), {
      page: 1, targetId: timesTargetId, text: '9.turning 转身', shiftSiblings: true,
    })
    const FALLBACK_OUT = outPath('line-times-fallback.pdf')
    await writeFile(FALLBACK_OUT, fallback.bytes)
    check('回退：matched=false', fallback.result.fontChoice.matched === false,
      JSON.stringify(fallback.result.fontChoice))
    check('回退：原因写明 Times 里没有这些字符',
      (fallback.result.fontChoice.fallbackReason ?? '').includes('没有的字符'),
      String(fallback.result.fontChoice.fallbackReason))
    check('回退：结果里出现「已改用」的说明',
      fallback.result.notes.some(note => note.includes('已改用') && note.includes('TimesNewRomanPSMT')),
      fallback.result.notes.join(' | '))
    check('回退：文件仍然写出', existsSync(FALLBACK_OUT))
    if (fallback.result.fontChoice.sizeAdjustedFrom !== undefined) {
      check('回退：字号调整被标注为估算',
        fallback.result.notes.some(note => note.includes('估算')), fallback.result.notes.join(' | '))
    }
    const fallbackDoc = await PDFDocument.load(new Uint8Array(await readFile(FALLBACK_OUT)))
    const fallbackPage = fallbackDoc.getPages()[0]
    const fallbackFonts = readPageFonts(fallbackDoc.context, fallbackPage)
    const fallbackStreams = readPageContentStreams(fallbackPage, fallbackDoc.context)
    const fallbackShows = [...trackGraphicsState(
      parseOperations(tokenize(fallbackStreams[fallbackStreams.length - 1].text)),
    ).values()]
    const fallbackFontName = fallbackShows.find(show => show.fontName !== undefined)?.fontName
    const fallbackBase = fallbackFontName === undefined ? undefined : fallbackFonts.get(fallbackFontName)?.baseFont
    check('回退：新文字用的是能画中文的字体，而不是 Times',
      normalizeFontName(fallbackBase) !== 'TimesNewRomanPSMT' && (fallbackBase ?? '') !== '',
      String(fallbackBase))
  }

  /* ── 安全不变量 + 收尾 ─────────────────────────────────────────────────── */

  check('整轮测试后源文件仍然字节不变', sha(new Uint8Array(await readFile(SOURCE))) === SOURCE_HASH,
    basename(SOURCE))

  rmSync(ROOT, { recursive: true, force: true })

  console.log(`\n共 ${checks} 条 check，失败 ${failed} 条`)
  if (failed > 0) {
    process.exitCode = 1
    console.log(`${failed} LINE-REDRAW CHECK(S) FAILED`)
  } else {
    console.log('ALL LINE-REDRAW CHECKS PASSED')
  }
}
