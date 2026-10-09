/**
 * 「执行前确认」独立测试（confirm gate）。
 *
 * 覆盖 `src/core/confirmation.ts` 的判定与授权，以及 `src/host/tools.ts` /
 * `src/host/routes.ts` 是否真的把闸门挡在写盘之前。断言全部按**应有行为**写：
 * 报告里指出的实现问题不会被这里放宽。
 *
 * 最要紧的一条是「未确认绝不落盘」：工具一旦被调用就必须返回结果，没有中途反问的机会，
 * 所以"看起来成功"才是这类功能最危险的失败方式。每个用例都对着真实文件断言
 * `!fs.existsSync(output)`，而不是只看返回文本长得像不像确认单。
 *
 * 夹具用 pdf-lib 现场生成到 `os.tmpdir()` 下的独立目录，仓库里不留任何字节；
 * 每个用例用 `resetPlansForTests()` 隔离，用例之间不共享计划库状态。
 *
 * Run: node --experimental-strip-types test/confirmation.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

import { buildToolDefinitions } from '../src/host/tools.ts'
import { makePdfRoutes, PDF_API_PREFIX } from '../src/host/routes.ts'
import {
  PLAN_TTL_MS,
  authorize,
  classifyGate,
  computePlanId,
  getPlan,
  issuePlan,
  listPlans,
  prunePlans,
  requiresConfirmation,
  resetPlansForTests,
  setPlanStatus,
} from '../src/core/confirmation.ts'

/* ── 判定框架 ─────────────────────────────────────────────────────────────── */

let checks = 0
let failed = 0

const check = (name, ok, detail) => {
  checks += 1
  const suffix = detail === undefined || detail === '' ? '' : ` — ${detail}`
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${suffix}`)
  if (!ok) failed += 1
}

/** 断言不抛：把一个 assert 包成一条 check。 */
const checkEq = (name, actual, expected) => {
  let ok = true
  let detail = ''
  try {
    assert.equal(actual, expected)
  } catch (error) {
    ok = false
    detail = String(error.message).split('\n').slice(0, 3).join(' ').slice(0, 220)
  }
  check(name, ok, ok ? String(actual) : detail)
}

const checkOk = (name, fn, detail) => {
  let ok = true
  let text = ''
  try {
    fn()
  } catch (error) {
    ok = false
    text = String(error.message).split('\n').slice(0, 3).join(' ').slice(0, 220)
  }
  check(name, ok, ok ? detail : text)
}

/* ── 夹具 ─────────────────────────────────────────────────────────────────── */

const ROOT = join(tmpdir(), 'pdf-studio-confirmation')
const IN = join(ROOT, 'in')
const OUT = join(ROOT, 'out')

/** 用 pdf-lib 造一份 n 页的 PDF；每页两行可编辑文字。 */
async function makePdf(path, pages) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let page = 1; page <= pages; page += 1) {
    const sheet = doc.addPage([595, 842])
    sheet.drawText(`Fixture page ${page}`, { x: 72, y: 720, size: 18, font, color: rgb(0, 0, 0) })
    sheet.drawText(`Line two of page ${page}`, { x: 72, y: 690, size: 12, font })
  }
  await writeFile(path, await doc.save({ updateMetadata: false }))
}

/** 重写同名 PDF 并追加填充注释，保证 size 一定变化（指纹必须能发现）。 */
async function replacePdfWithDifferentSize(path) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const sheet = doc.addPage([595, 842])
  sheet.drawText('Content was replaced after the plan was issued', { x: 72, y: 720, size: 18, font })
  const padding = `%${'x'.repeat(2000)}\n`
  await writeFile(path, await doc.save({ updatePadding: false, updateMetadata: false, objectsPerTick: 50 })
    .then(bytes => Buffer.concat([Buffer.from(padding, 'latin1'), Buffer.from(bytes)])))
}

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(IN, { recursive: true })
mkdirSync(OUT, { recursive: true })

const ONE = join(IN, 'one.pdf')
const MANY35 = join(IN, 'many35.pdf')
const MANY21 = join(IN, 'many21.pdf')
const MANY20 = join(IN, 'many20.pdf')
const MANY31 = join(IN, 'many31.pdf')
await makePdf(ONE, 1)
await makePdf(MANY21, 21)
await makePdf(MANY20, 20)
await makePdf(MANY31, 31)
await makePdf(MANY35, 35)

const ONE_BYTES = await readFile(ONE)
const ONE_SIZE = ONE_BYTES.byteLength
const out = name => join(OUT, name)

/* ── 工具实例 ─────────────────────────────────────────────────────────────── */

// 每个策略都要一个实例：`confirmation` 在 buildToolDefinitions 时就被捕获了。
const toolSets = {
  destructive: buildToolDefinitions({ workspaceRoot: OUT }), // 默认策略
  never: buildToolDefinitions({ workspaceRoot: OUT, confirmation: 'never' }),
  always: buildToolDefinitions({ workspaceRoot: OUT, confirmation: 'always' }),
}
const GATED_TOOLS = [
  'pdf_inspect', 'pdf_extract_text', 'pdf_make_searchable',
  'pdf_edit_text', 'pdf_replace_line', 'pdf_watermark', 'pdf_protect',
]
for (const [policy, tools] of Object.entries(toolSets)) {
  const names = tools.map(tool => tool.name)
  check(`工具集 ${policy} 暴露 8 个工具`, tools.length === 8, names.join(', '))
  // 会写盘或代价高的 7 个工具都必须声明 plan/confirm/force：这是"写盘前过 authorize"的入口。
  // pdf_preview 是纯只读渲染，没有闸门参数（也没有任何写盘路径），所以不在这一组里。
  for (const name of GATED_TOOLS) {
    const definition = tools.find(tool => tool.name === name)
    const keys = Object.keys(definition?.parameters.properties ?? {})
    check(`工具 ${policy}/${name} 声明 plan/confirm/force`,
      ['plan', 'confirm', 'force'].every(key => keys.includes(key)), keys.join(','))
  }
  check(`工具集 ${policy}：只读预览不声明闸门参数（没有写盘路径）`,
    ['plan', 'confirm', 'force'].every(key =>
      !Object.keys(tools.find(tool => tool.name === 'pdf_preview').parameters.properties ?? {}).includes(key)))
}

/** 执行一个工具并取出它渲染后的文本（`output.render` 必须返回数组）。 */
async function tool(policy, name, args) {
  const definition = toolSets[policy].find(item => item.name === name)
  if (definition === undefined) throw new Error(`未定义的策略/工具：${policy}/${name}`)
  const value = await definition.execute(args)
  const rendered = definition.output.render(args, value)
  assert.ok(Array.isArray(rendered), 'output.render 必须返回数组')
  return rendered[0].text
}

const isPlanText = text => text.startsWith('⚠️ 这个操作需要你确认后才会执行。')

/* ── 真实文字块 id ───────────────────────────────────────────────────────── */
//
// `pdf_edit_text` 对 0 处改写会抛错，所以断言"执行成功"的用例必须用**真实存在**的
// targetId。id 的形态是 `<内容流对象号>:<操作序号>`，由 `pdf_inspect runs=true` 给出——
// 硬编码一个猜出来的 id 只会把"闸门没生效"伪装成"改写没生效"。

/** 跑一次 pdf_inspect runs=true，解析出可编辑文字块的 id。 */
async function inspectRuns(policy, path) {
  const text = await tool(policy, 'pdf_inspect', { path, runs: true })
  const runs = [...text.matchAll(/第(\d+)页 (\S+?)｜/g)].map(match => ({
    page: Number(match[1]),
    id: match[2],
  }))
  return { text, runs }
}

const inspectedOne = await inspectRuns('destructive', ONE)
const REAL_RUN_ID = inspectedOne.runs[0]?.id
const REAL_RUN_PAGE = inspectedOne.runs[0]?.page ?? 1
check('夹具里有可用的真实文字块 id（编辑类断言的前提）',
  typeof REAL_RUN_ID === 'string' && REAL_RUN_ID.length > 0 && REAL_RUN_PAGE >= 1,
  inspectedOne.runs.map(run => `${run.page}:${run.id}`).join(',') || '（没有文字块）')

/** 编辑类用例的统一参数构造，保证 planId 与执行用的参数逐字一致。 */
const editArgs = (to, output) => ({
  path: ONE,
  edits: [{ page: REAL_RUN_PAGE, targetId: REAL_RUN_ID, to }],
  output,
})
/** 从确认单里取回 planId（用户复述给助手的那串）。 */
const planIdOf = text => {
  const match = /计划 id：(p_[0-9a-f]+)/.exec(text)
  if (match === null) throw new Error(`确认单里没有 plan id：\n${text}`)
  return match[1]
}

/** 跳过工具层、直接用确认模块的 `now` 覆盖能力模拟"计划已过期"。 */
async function authorizeWithNow(input) {
  const module = await import('../src/core/confirmation.ts')
  return module.authorize(input)
}

console.log('执行前确认（confirm gate）\n')

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. 未确认绝不落盘（最关键）
 * ═════════════════════════════════════════════════════════════════════════ */

console.log('1. 未确认绝不落盘\n')
{
  // 让每个用例的输出路径各不相同，避免"上一次运行留下的文件"污染断言。
  const cases = [
    {
      label: 'pdf_edit_text',
      run: () => tool('destructive', 'pdf_edit_text', {
        path: ONE,
        edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'CONFIRM-GATE-EDIT' }],
        output: 'case-edit.pdf',
      }),
      file: out('case-edit.pdf'),
      expect: '文件：one.pdf',
    },
    {
      label: 'pdf_watermark action=remove',
      run: () => tool('destructive', 'pdf_watermark', { path: ONE, action: 'remove', output: 'case-clean.pdf' }),
      file: out('case-clean.pdf'),
      expect: '动作：移除水印',
    },
    {
      label: 'pdf_protect action=encrypt',
      run: () => tool('destructive', 'pdf_protect', {
        path: ONE, action: 'encrypt', password: 'pw-confirm', output: 'case-locked.pdf',
      }),
      file: out('case-locked.pdf'),
      expect: '动作：加密',
    },
    {
      label: 'pdf_make_searchable',
      run: () => tool('always', 'pdf_make_searchable', { path: MANY35, output: out('case-searchable.pdf') }),
      file: out('case-searchable.pdf'),
      expect: '动作：生成可搜索 PDF',
    },
    {
      // 页数 21 落在"高成本"区间（> 20），但它不是破坏性操作：
      // 默认策略 destructive 只问"会改文件或有歧义"，所以这里会真的执行。
      // 这条断言的是**策略边界**（高成本不在默认策略的询问范围），
      // 不是"未确认不落盘"——那条由上面 35 页 + always 策略的用例覆盖。
      label: 'pdf_make_searchable（21 页，默认策略允许直接执行）',
      run: () => tool('destructive', 'pdf_make_searchable', { path: MANY21, output: out('case-searchable21.pdf') }),
      file: out('case-searchable21.pdf'),
      expect: null,
      expectExecuted: true,
    },
  ]

  for (const item of cases) {
    resetPlansForTests()
    if (existsSync(item.file)) rmSync(item.file)
    let text = ''
    let threw = ''
    try {
      text = await item.run()
    } catch (error) {
      threw = String(error.message)
    }
    if (item.expectExecuted === true) {
      check(`${item.label}：默认策略下直接执行（高成本不属于"会改文件/有歧义"）`,
        threw === '' && !isPlanText(text) && text.includes('已生成：'), threw === '' ? text.split('\n')[0] : threw)
      check(`${item.label}：执行了就会有文件（与上面的"未确认不落盘"形成对照）`,
        existsSync(item.file), item.file)
      continue
    }
    check(`${item.label}：未带 confirm 返回确认单而不是执行结果`,
      threw === '' && isPlanText(text), threw === '' ? text.split('\n')[0] : threw)
    check(`${item.label}：确认单里写明被操作的文件`,
      text.includes(item.expect), text.split('\n').find(line => line.startsWith('文件：')) ?? '')
    check(`${item.label}：输出文件不存在（!fs.existsSync）`,
      !existsSync(item.file), item.file)
  }

  // 破坏性操作在默认策略下（不带 confirm / plan / force）必须一律走确认单。
  // 这三条都刻意不给 output：默认输出路径就在源文件旁，所以"没落盘"这条断言
  // 覆盖的正是最容易被忽略的"Sibling 输出"。
  resetPlansForTests()
  const refusalProbe = [
    ['pdf_edit_text', { path: ONE, edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'x' }] }],
    ['pdf_watermark', { path: ONE, action: 'remove' }],
    ['pdf_protect', { path: ONE, action: 'encrypt', password: 'pw' }],
  ]
  for (const [name, args] of refusalProbe) {
    const text = await tool('destructive', name, args)
    check(`${name} 默认策略下不执行`, isPlanText(text), text.split('\n')[0])
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. planId 强校验
 * ═════════════════════════════════════════════════════════════════════════ */

console.log('\n2. planId 强校验\n')

// ── 2.1 正确 confirm → 执行且产出文件 ──────────────────────────────────────
{
  resetPlansForTests()
  const file = out('edit-ok.pdf')
  if (existsSync(file)) rmSync(file)
  const planText = await tool('destructive', 'pdf_edit_text', {
    path: ONE,
    edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'CONFIRMED-EDIT' }],
    output: 'edit-ok.pdf',
  })
  const planId = planIdOf(planText)
  check('正确 confirm：计划已登记且可在库里取回', getPlan(planId) !== undefined, planId)

  const done = await tool('destructive', 'pdf_edit_text', {
    path: ONE,
    edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'CONFIRMED-EDIT' }],
    output: 'edit-ok.pdf',
    confirm: planId,
  })
  check('正确 confirm：执行成功而不是再次返回确认单',
    !isPlanText(done) && done.includes('已生成：'), done.split('\n')[0])
  check('正确 confirm：产出文件存在', existsSync(file), file)
  check('正确 confirm：源文件字节未变',
    (await readFile(ONE)).equals(ONE_BYTES), `${ONE_SIZE} B`)
  checkEq('正确 confirm：计划被标记为一次性 consumed', getPlan(planId)?.status, 'consumed')
}

// ── 2.2 改一个参数 → refused 且不产出 ─────────────────────────────────────
{
  resetPlansForTests()
  const file = out('edit-mutated.pdf')
  if (existsSync(file)) rmSync(file)
  if (existsSync(file)) rmSync(file)
  const planText = await tool('destructive', 'pdf_edit_text', {
    path: ONE,
    edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'ORIGINAL-TEXT' }],
    output: 'edit-mutated.pdf',
  })
  const planId = planIdOf(planText)

  let message = ''
  try {
    await tool('destructive', 'pdf_edit_text', {
      path: ONE,
      edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'DIFFERENT-TEXT' }],
      output: 'edit-mutated.pdf',
      confirm: planId,
    })
  } catch (error) {
    message = String(error.message)
  }
  check('换掉 to 文字：refused', message.includes('已拒绝执行'), message.split('\n')[0])
  check('换掉 to 文字：拒绝信息指出是参数不一致',
    message.includes('参数') && message.includes('edits'), message.split('\n').slice(1, 3).join(' '))
  check('换掉 to 文字：没有产出文件', !existsSync(file), file)

  // 换个参数再验一遍：`pdf_protect encrypt`（同样是破坏性操作，默认策略必问）。
  resetPlansForTests()
  const lockFile = out('lock-mutated.pdf')
  if (existsSync(lockFile)) rmSync(lockFile)
  if (existsSync(lockFile)) rmSync(lockFile)
  const lockPlan = await tool('destructive', 'pdf_protect', {
    path: ONE, action: 'encrypt', password: 'pw-mutate', allow: ['print'], output: 'lock-mutated.pdf',
  })
  const lockId = planIdOf(lockPlan)
  let lockMessage = ''
  try {
    await tool('destructive', 'pdf_protect', {
      path: ONE, action: 'encrypt', password: 'pw-mutate', allow: ['print', 'modify'],
      output: 'lock-mutated.pdf', confirm: lockId,
    })
  } catch (error) {
    lockMessage = String(error.message)
  }
  check('换掉 allow：refused', lockMessage.includes('已拒绝执行'), lockMessage.split('\n')[0])
  check('换掉 allow：拒绝信息指出是参数不一致',
    lockMessage.includes('参数 allow'), lockMessage.split('\n').slice(1, 3).join(' '))
  check('换掉 allow：没有产出文件', !existsSync(lockFile), lockFile)
}

// ── 2.3 生成计划后输入文件被换掉 → refused（指纹不匹配） ──────────────────
{
  resetPlansForTests()
  const file = out('lock-fingerprint.pdf')
  if (existsSync(file)) rmSync(file)
  if (existsSync(file)) rmSync(file)
  const args = {
    path: ONE, action: 'encrypt', password: 'pw-fingerprint', output: 'lock-fingerprint.pdf',
  }
  const planId = planIdOf(await tool('destructive', 'pdf_protect', args))
  const before = (await readFile(ONE)).byteLength

  await replacePdfWithDifferentSize(ONE)
  const after = (await readFile(ONE)).byteLength
  check('输入文件确实被换掉了（size 变化）', before !== after, `${before} B → ${after} B`)

  let message = ''
  try {
    await tool('destructive', 'pdf_protect', { ...args, confirm: planId })
  } catch (error) {
    message = String(error.message)
  }
  check('文件指纹不匹配：refused', message.includes('已拒绝执行'), message.split('\n')[0])
  check('文件指纹不匹配：拒绝信息说明输入文件已变化',
    message.includes('输入文件已变化'), message.split('\n').slice(1, 3).join(' '))
  check('文件指纹不匹配：没有产出文件', !existsSync(file), file)

  // 复原夹具，后面的用例还要用。
  await makePdf(ONE, 1)
}

// ── 2.4 计划过期 → refused ────────────────────────────────────────────────
{
  resetPlansForTests()
  const file = out('edit-expired.pdf')
  if (existsSync(file)) rmSync(file)
  const input = { path: ONE, edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'EXPIRED' }], output: 'edit-expired.pdf' }
  const first = await tool('destructive', 'pdf_edit_text', input)
  const planId = planIdOf(first)
  const createdAt = getPlan(planId).createdAt

  // PLAN_TTL_MS 是 15 分钟，等不起；`authorize` 的 `now` 是它的公开输入，
  // 用它模拟"15 分钟零 1 秒之后"。
  const expired = await authorizeWithNow({
    tool: 'pdf_edit_text',
    action: 'edit',
    parameters: {
      edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'EXPIRED' }],
      pageCount: 1,
    },
    inputs: [ONE],
    output: file,
    confirm: planId,
    now: createdAt + PLAN_TTL_MS + 1000,
  })
  check('计划过期：authorize 返回 refused', expired.kind === 'refused', expired.kind)
  check('计划过期：拒绝信息写明已过期', String(expired.message).includes('已过期'), expired.message)
  check('计划过期：没有产出文件', !existsSync(file), file)

  // 边界对照：TTL 之内仍然可以执行，说明上面拒绝的确实是过期而不是别的原因。
  resetPlansForTests()
  const fresh = await tool('destructive', 'pdf_edit_text', input)
  const freshId = planIdOf(fresh)
  const inTime = await authorizeWithNow({
    tool: 'pdf_edit_text',
    action: 'edit',
    parameters: {
      edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'EXPIRED' }],
      pageCount: 1,
    },
    inputs: [ONE],
    output: file,
    confirm: freshId,
    now: getPlan(freshId).createdAt + PLAN_TTL_MS - 1000,
  })
  check('TTL 之内：同一个计划仍然 proceed（对照组）', inTime.kind === 'proceed', inTime.kind)
  if (existsSync(file)) rmSync(file)
}

// ── 2.5 计划已取消 → refused ──────────────────────────────────────────────
{
  resetPlansForTests()
  const file = out('edit-cancelled.pdf')
  if (existsSync(file)) rmSync(file)
  const planText = await tool('destructive', 'pdf_edit_text', {
    path: ONE,
    edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'CANCELLED' }],
    output: 'edit-cancelled.pdf',
  })
  const planId = planIdOf(planText)
  setPlanStatus(planId, 'cancelled')

  let message = ''
  try {
    await tool('destructive', 'pdf_edit_text', {
      path: ONE,
      edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'CANCELLED' }],
      output: 'edit-cancelled.pdf',
      confirm: planId,
    })
  } catch (error) {
    message = String(error.message)
  }
  check('计划已取消：refused', message.includes('已被取消'), message.split('\n')[0])
  check('计划已取消：没有产出文件', !existsSync(file), file)
}

// ── 2.6 计划一次性（同一 id 第二次执行） → refused ────────────────────────
{
  resetPlansForTests()
  const file = out('edit-once.pdf')
  if (existsSync(file)) rmSync(file)
  const args = {
    path: ONE,
    edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'ONCE' }],
    output: 'edit-once.pdf',
  }
  const planId = planIdOf(await tool('destructive', 'pdf_edit_text', args))
  const first = await tool('destructive', 'pdf_edit_text', { ...args, confirm: planId })
  check('一次性：第一次 confirm 执行成功', first.includes('已生成：'), first.split('\n')[0])
  const firstBytes = await readFile(file)

  let message = ''
  try {
    await tool('destructive', 'pdf_edit_text', { ...args, confirm: planId })
  } catch (error) {
    message = String(error.message)
  }
  check('一次性：第二次 confirm refused', message.includes('已经执行过一次'), message.split('\n')[0])
  check('一次性：第二次没有改写已产出的文件',
    (await readFile(file)).equals(firstBytes), file)
}

// ── 2.7 伪造一个不存在的 planId → refused ─────────────────────────────────
{
  resetPlansForTests()
  const file = out('edit-forged.pdf')
  if (existsSync(file)) rmSync(file)
  if (existsSync(file)) rmSync(file)
  let message = ''
  try {
    await tool('destructive', 'pdf_edit_text', {
      path: ONE,
      edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'FORGED' }],
      output: 'edit-forged.pdf',
      confirm: 'p_deadbeefcafe',
    })
  } catch (error) {
    message = String(error.message)
  }
  check('伪造 planId：refused', message.includes('不存在或已过期'), message.split('\n')[0])
  check('伪造 planId：没有产出文件', !existsSync(file), file)
  check('伪造 planId：提示重新生成计划', message.includes('重新生成'), message.split('\n')[0])
}

// ── 2.8 一次性确认之后：0 处改写不能假装成功（引擎 written=false） ─────────
{
  resetPlansForTests()
  const file = out('edit-zero.pdf')
  if (existsSync(file)) rmSync(file)
  if (existsSync(file)) rmSync(file)
  // 用一个不存在的 targetId：确认真单可以过，但真正落盘的改写是 0 处。
  const plan = await tool('destructive', 'pdf_edit_text', {
    path: ONE,
    edits: [{ page: 1, targetId: '1:999999', to: 'NEVER-APPLIED' }],
    output: 'edit-zero.pdf',
  })
  check('0 改写：未确认时仍是确认单', isPlanText(plan), plan.split('\n')[0])
  check('0 改写：未确认时没有产出文件', !existsSync(file), file)

  let message = ''
  try {
    await tool('destructive', 'pdf_edit_text', {
      path: ONE,
      edits: [{ page: 1, targetId: '1:999999', to: 'NEVER-APPLIED' }],
      output: 'edit-zero.pdf',
      confirm: planIdOf(plan),
    })
  } catch (error) {
    message = String(error.message)
  }
  check('0 改写：确认之后明确失败，而不是报"已生成"',
    message.includes('没有应用任何改写') && !message.includes('已生成：'), message.split('\n')[0])
  check('0 改写：错误信息给出下一步（重读 id / 先 make_searchable）',
    message.includes('pdf_inspect runs=true') && message.includes('pdf_make_searchable'),
    message.split('\n').slice(0, 2).join(' '))
  check('0 改写：不写盘（written=false）', !existsSync(file), file)
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. 三类门控 + 策略
 * ═════════════════════════════════════════════════════════════════════════ */

console.log('\n3. 三类门控 + 策略\n')

// ── 3.1 destructive ───────────────────────────────────────────────────────
{
  const destructive = [
    ['edit_text', { tool: 'pdf_edit_text', action: 'edit', parameters: {}, inputs: [ONE] }],
    ['watermark remove', { tool: 'pdf_watermark', action: 'remove', parameters: {}, inputs: [ONE] }],
    ['protect encrypt', { tool: 'pdf_protect', action: 'encrypt', parameters: {}, inputs: [ONE] }],
    ['protect decrypt', { tool: 'pdf_protect', action: 'decrypt', parameters: {}, inputs: [ONE] }],
    ['输出文件已存在', { tool: 'pdf_make_searchable', action: 'searchable', parameters: {}, inputs: [ONE], output: ONE }],
  ]
  for (const [label, input] of destructive) {
    const decision = classifyGate(input)
    check(`destructive：${label}`, decision.gate === 'destructive',
      `${decision.gate} / ${decision.reasons.join('；')}`)
    check(`destructive：${label} 默认策略要求确认`, requiresConfirmation(decision.gate, 'destructive'))
  }
  const hasOutput = classifyGate({
    tool: 'pdf_make_searchable', action: 'searchable', parameters: {}, inputs: [ONE], output: ONE,
  })
  check('destructive："输出文件已存在"的理由里带路径',
    hasOutput.reasons.some(reason => reason.includes('输出文件已存在') && reason.includes('one.pdf')),
    hasOutput.reasons.join('；'))

  // 只读动作不能被误判成 destructive。
  check('pdf_inspect 不带 analyze 不是 destructive',
    classifyGate({ tool: 'pdf_inspect', action: 'inspect', parameters: { analyze: false }, inputs: [ONE] }).gate === 'none')
  check('pdf_watermark action=scan 不是 destructive',
    classifyGate({ tool: 'pdf_watermark', action: 'scan', parameters: {}, inputs: [ONE] }).gate === 'none')
  check('pdf_protect action=check 不是 destructive',
    classifyGate({ tool: 'pdf_protect', action: 'check', parameters: {}, inputs: [ONE] }).gate === 'none')
}

// ── 3.2 expensive ─────────────────────────────────────────────────────────
{
  const analyze = classifyGate({ tool: 'pdf_inspect', action: 'analyze', parameters: { analyze: true }, inputs: [ONE], pageCount: 1 })
  check('expensive：pdf_inspect analyze=true', analyze.gate === 'expensive', analyze.gate + ' / ' + analyze.reasons.join('；'))
  check('expensive：pdf_inspect analyze=true 的理由写明会 OCR',
    analyze.reasons.some(reason => reason.includes('OCR')), analyze.reasons.join('；'))

  const over = classifyGate({
    tool: 'pdf_extract_text', action: 'extract-all', parameters: {}, inputs: [MANY21],
    pageCount: 21, wholeDocument: true,
  })
  check('expensive：整档提取 21 页', over.gate === 'expensive', `${over.gate} / ${over.reasons.join('；')}`)
  const at20 = classifyGate({
    tool: 'pdf_extract_text', action: 'extract-all', parameters: {}, inputs: [MANY20],
    pageCount: 20, wholeDocument: true,
  })
  check('expensive：整档提取 20 页不触发（阈值是 > 20）', at20.gate === 'none', at20.gate)
  check('expensive：20 页默认策略不要求确认', !requiresConfirmation(at20.gate, 'destructive'))

  // 可搜索化与"整档提取"问的是同一件事（逐页 OCR），所以两者阈值一致（20）。
  const searchable21 = classifyGate({
    tool: 'pdf_make_searchable', action: 'searchable', parameters: {}, inputs: [MANY21],
    pageCount: 21, wholeDocument: true, output: out('never-written.pdf'),
  })
  check('expensive：可搜索化 21 页', searchable21.gate === 'expensive',
    `${searchable21.gate} / ${searchable21.reasons.join('；')}`)
  check('expensive：可搜索化 21 页的理由写明"21 页超过 20 页阈值"',
    searchable21.reasons.some(reason => reason.includes('21 页超过 20 页阈值')),
    searchable21.reasons.join('；'))
  const searchable20 = classifyGate({
    tool: 'pdf_make_searchable', action: 'searchable', parameters: {}, inputs: [MANY20],
    pageCount: 20, wholeDocument: true, output: out('never-written.pdf'),
  })
  check('expensive：可搜索化 20 页不触发（阈值是 > 20）', searchable20.gate === 'none', searchable20.gate)
  check('expensive：可搜索化与整档提取用同一阈值（20 页都不触发）',
    searchable20.gate === at20.gate, `${searchable20.gate} vs ${at20.gate}`)

  // 工具层：analyze=true 在默认策略下只读，但 always 策略下必须先确认。
  resetPlansForTests()
  const alwaysAnalyze = await tool('always', 'pdf_inspect', { path: ONE, analyze: true })
  check('expensive：always 策略下 pdf_inspect analyze=true 返回确认单',
    isPlanText(alwaysAnalyze), alwaysAnalyze.split('\n')[0])
  const defaultAnalyze = await tool('destructive', 'pdf_inspect', { path: ONE, analyze: true })
  check('expensive：默认策略下 analyze=true 仍会执行（只读、非破坏）',
    !isPlanText(defaultAnalyze) && defaultAnalyze.includes('分诊：'),
    defaultAnalyze.split('\n')[0])

  resetPlansForTests()
  const alwaysExtract = await tool('always', 'pdf_extract_text', { path: MANY21 })
  check('expensive：always 策略下 21 页整档提取返回确认单',
    isPlanText(alwaysExtract), alwaysExtract.split('\n')[0])
  check('expensive：整档提取的确认单写明页数阈值理由（原因行）',
    alwaysExtract.split('\n').some(line => line.startsWith('原因：') && line.includes('21 页超过 20 页阈值')),
    alwaysExtract.split('\n').find(line => line.startsWith('原因：')) ?? '（没有原因行）')
  const alwaysExtract20 = await tool('always', 'pdf_extract_text', { path: MANY20 })
  check('expensive：always 策略下 20 页整档提取不需要确认（阈值 > 20）',
    !isPlanText(alwaysExtract20), alwaysExtract20.split('\n')[0])

  // 31 页（> 20 阈值）：确认单 + 不落盘。这条路径**只生成计划**，不跑到 exportSearchable——
  // 那条路在大夹具上会真的分析 31 页，而这个套件最贵的动作已经够多了，且"确认后能执行"
  // 由下面 21 页的用例证明，没必要付两遍代价。
  resetPlansForTests()
  const searchableFile = out('never-written-31.pdf')
  if (existsSync(searchableFile)) rmSync(searchableFile)
  const alwaysSearchable = await tool('always', 'pdf_make_searchable', { path: MANY31, output: searchableFile })
  check('expensive：always 策略下 31 页可搜索化返回确认单',
    isPlanText(alwaysSearchable), alwaysSearchable.split('\n')[0])
  check('expensive：31 页可搜索化没有产出文件', !existsSync(searchableFile), searchableFile)
  // 门控**原因**必须让用户看得到，否则确认单只是一句"请确认"，用户没法判断该不该点。
  // 先 reset：同参数已有一份 pending 计划，issuePlan 幂等会让直接调用拿回旧计划。
  resetPlansForTests()
  const searchablePlanData = authorize({
    tool: 'pdf_make_searchable', action: 'searchable', parameters: { mode: 'invisible', pages: 31 },
    inputs: [MANY31], output: searchableFile, pageCount: 31, wholeDocument: true, planOnly: true,
  })
  const searchablePlan = searchablePlanData.kind === 'plan' ? searchablePlanData.plan : undefined
  check('expensive：计划对象记录了"超过 20 页阈值"这一门控原因（数据层）',
    (searchablePlan?.gateReasons ?? []).some(reason => reason.includes('31 页超过 20 页阈值')),
    JSON.stringify(searchablePlan?.gateReasons))
  check('expensive：确认单里写明"超过 20 页阈值"（用户可见层）',
    searchablePlan !== undefined && searchablePlan.sheet.includes('31 页超过 20 页阈值'),
    searchablePlan?.sheet.split('\n').filter(line => line.startsWith('影响：')).join(' | ') ?? '')
  check('expensive：确认单用"原因："独立一行解释为什么被拦（不是只印在 effects 里）',
    searchablePlan !== undefined && searchablePlan.sheet.split('\n')
      .some(line => line.startsWith('原因：') && line.includes('31 页超过 20 页阈值')),
    searchablePlan?.sheet.split('\n').find(line => line.startsWith('原因：')) ?? '（没有原因行）')
  resetPlansForTests()

  // 高成本操作在 always 策略下带上 confirm 仍能跑通（闸门不是死锁）。
  // 用 21 页夹具：同样命中 > 20 的高成本门控，但执行代价小得多。
  const smallFile = out('confirmed-searchable-21.pdf')
  if (existsSync(smallFile)) rmSync(smallFile)
  resetPlansForTests()
  const smallPlanText = await tool('always', 'pdf_make_searchable', { path: MANY21, output: smallFile })
  check('expensive：21 页可搜索化在 always 下先要确认',
    isPlanText(smallPlanText), smallPlanText.split('\n')[0])
  check('expensive：21 页可搜索化确认前没有产出文件', !existsSync(smallFile), smallFile)
  const searchableDone = await tool('always', 'pdf_make_searchable', {
    path: MANY21, output: smallFile, confirm: planIdOf(smallPlanText),
  })
  check('expensive：确认之后可搜索化执行并落盘',
    searchableDone.includes('已生成：') && existsSync(smallFile), searchableDone.split('\n')[0])
}

// ── 3.3 ambiguous ─────────────────────────────────────────────────────────
{
  // 缺关键参数：绝不能用默认值替用户猜。
  resetPlansForTests()
  const file = out('one-watermarked.pdf')
  if (existsSync(file)) rmSync(file)
  const text = await tool('destructive', 'pdf_watermark', { path: ONE, action: 'add' })
  check('ambiguous：水印缺 text/imagePath 返回确认单', isPlanText(text), text.split('\n')[0])
  check('ambiguous：确认单写明"缺少关键参数"', text.includes('缺少关键参数'), text.split('\n').find(line => line.startsWith('待确认：')) ?? '')
  check('ambiguous：确认单点名 text / imagePath',
    text.includes('text') && text.includes('imagePath'), '')
  check('ambiguous：绝不能真的写文件（已修过的 bug）', !existsSync(file), file)

  // 缺参数**不能靠确认绕过**：执行时会退到插件默认值（例如水印文字 "WATERMARK"），
  // 那等于替用户瞎猜。所以工具必须抛错而不是放行。
  let missingConfirm = ''
  try {
    missingConfirm = await tool('destructive', 'pdf_watermark', {
      path: ONE, action: 'add', confirm: planIdOf(text),
    })
  } catch (error) {
    missingConfirm = `THREW: ${error.message}`
  }
  check('ambiguous：缺参数 + confirm 也被拒绝（不能靠确认继续）',
    missingConfirm.includes('缺少必需参数') && missingConfirm.includes('不能靠确认继续'),
    missingConfirm.split('\n')[0])
  check('ambiguous：缺参数 + confirm 也没有落盘', !existsSync(file), file)
  check('ambiguous：缺参数 + confirm 后计划仍是 pending（没有被消费）',
    getPlan(planIdOf(text))?.status === 'pending', getPlan(planIdOf(text))?.status)

  // 同名多文件：直接 refused 并列出候选。用 "add + 缺内容" 这条 already-ambiguous
  // 路径（没有任何 destructive 因素）来观察纯 ambiguous 判定。
  resetPlansForTests()
  const ghostFile = out('ghost-watermarked.pdf')
  const candidates = [join(IN, 'dup', 'a.pdf'), join(IN, 'dup', 'b.pdf'), join(IN, 'dup', 'c.pdf')]
  const decision = classifyGate({
    tool: 'pdf_watermark', action: 'add', parameters: {}, candidates,
    missing: ['水印文字（text）或图片（imagePath）'],
  })
  check('ambiguous：多个候选文件被判成 ambiguous（无破坏性动作时）',
    decision.gate === 'ambiguous', decision.gate)
  check('ambiguous：候选理由写明"多个文件"',
    decision.ambiguous.some(line => line.includes('多个文件')), decision.ambiguous.join('；'))

  const refused = authorize({
    tool: 'pdf_watermark', action: 'add', parameters: {}, inputs: [ONE], output: ghostFile,
    candidates, missing: ['水印文字（text）或图片（imagePath）'],
  })
  check('ambiguous：多个候选直接 refused', refused.kind === 'refused', refused.kind)
  check('ambiguous：拒绝信息列出候选',
    candidates.every(path => String(refused.message).includes(path)), String(refused.message).split('\n').slice(0, 4).join(' '))
  check('ambiguous：拒绝时附带计划（便于界面展示）', refused.plan !== undefined)
  check('ambiguous：多个候选的拒绝不是靠"缺参数"实现的（候选本身就该停）',
    String(refused.message).includes('多个文件'), String(refused.message).split('\n')[0])

  // 破坏性因素优先：一旦带 output，门控就是 destructive（更高优先级），
  // 但候选 > 1 依然先被 refused。
  const destructiveWithCandidates = classifyGate({
    tool: 'pdf_edit_text', action: 'edit', parameters: {}, inputs: [ONE], output: ghostFile, candidates,
  })
  check('ambiguous：destructive 优先级高于 ambiguous（门控类别）',
    destructiveWithCandidates.gate === 'destructive', destructiveWithCandidates.gate)
  check('ambiguous：destructive 场景下候选仍然记为待确认',
    destructiveWithCandidates.ambiguous.some(line => line.includes('多个文件')))

  // 给全参数（走 completePlan 的方式，不真的执行）后不再报缺参数。
  resetPlansForTests()
  const withContent = await tool('destructive', 'pdf_watermark', {
    path: ONE, action: 'add', text: 'GHOST', plan: true,
  })
  check('ambiguous：给全参数后不再报缺参数', !withContent.includes('缺少关键参数'), withContent.split('\n')[0])
  check('ambiguous：给全参数后是正常的确认单', isPlanText(withContent), withContent.split('\n')[0])
  check('ambiguous：给全参数后仍然没有落盘', !existsSync(ghostFile), ghostFile)

  // 超大文档（整档 > 200 页）也是 ambiguous。
  const huge = classifyGate({
    tool: 'pdf_make_searchable', action: 'searchable', parameters: {}, inputs: [ONE],
    pageCount: 250, wholeDocument: true, output: out('never-written.pdf'),
  })
  check('ambiguous：整档 250 页提示要确认全部页面',
    huge.ambiguous.some(line => line.includes('250 页')), `${huge.gate} / ${huge.ambiguous.join('；')}`)
  // 注意：destructive 优先级高于 ambiguous，这里没有输出文件存在所以应为 ambiguous。
  check('ambiguous：250 页且无输出覆盖时门控是 ambiguous', huge.gate === 'ambiguous', huge.gate)
}

// ── 3.4 策略 ──────────────────────────────────────────────────────────────
{
  check('策略：never 让破坏性操作直接执行',
    !requiresConfirmation('destructive', 'never'))
  check('策略：never 让高成本操作直接执行',
    !requiresConfirmation('expensive', 'never'))
  check('策略：always 要求高成本操作确认',
    requiresConfirmation('expensive', 'always'))
  check('策略：always 要求 ambiguous 确认',
    requiresConfirmation('ambiguous', 'always'))
  check('策略：destructive 不要求高成本操作确认',
    !requiresConfirmation('expensive', 'destructive'))
  // 按文档承诺，ambiguous 属于"三类门控"之一，destructive 策略下应当要问。
  check('策略：destructive 要求 ambiguous 确认',
    requiresConfirmation('ambiguous', 'destructive'))
  check('策略：三类策略下 none 都不要求确认',
    ['never', 'destructive', 'always'].every(policy => !requiresConfirmation('none', policy)))

  resetPlansForTests()
  const file = out('wm-never.pdf')
  if (existsSync(file)) rmSync(file)
  const neverText = await tool('never', 'pdf_watermark', {
    path: ONE, action: 'add', text: 'NEVER-POLICY', output: 'wm-never.pdf',
  })
  check('策略 never：水印直接执行', neverText.includes('已生成：'), neverText.split('\n')[0])
  check('策略 never：文件确实落盘', existsSync(file), file)

  resetPlansForTests()
  const lockFile = out('one-never-protected.pdf')
  if (existsSync(lockFile)) rmSync(lockFile)
  const neverEncrypt = await tool('never', 'pdf_protect', {
    path: ONE, action: 'encrypt', password: 'pw-never', output: 'one-never-protected.pdf',
  })
  check('策略 never：加密直接执行', neverEncrypt.includes('已生成：'), neverEncrypt.split('\n')[0])
  check('策略 never：加密产物存在', existsSync(lockFile), lockFile)

  // destructive（默认）：只读且便宜的操作不问。
  resetPlansForTests()
  const inspectText = await tool('destructive', 'pdf_inspect', { path: ONE })
  check('策略 destructive：pdf_inspect（不带 analyze）不要求确认',
    !isPlanText(inspectText) && inspectText.includes('1 页'), inspectText.split('\n')[0])
  const previewText = await tool('destructive', 'pdf_preview', { path: ONE })
  check('策略 destructive：pdf_preview 不要求确认',
    !isPlanText(previewText), previewText.split('\n')[0])
  const extractText = await tool('destructive', 'pdf_extract_text', { path: ONE })
  check('策略 destructive：pdf_extract_text 单页/整档小文档不要求确认',
    !isPlanText(extractText), extractText.split('\n')[0])
  const scanText = await tool('destructive', 'pdf_watermark', { path: ONE, action: 'scan' })
  check('策略 destructive：pdf_watermark action=scan 不要求确认',
    !isPlanText(scanText), scanText.split('\n')[0])

  // always：三类门控都要问。注意"只读 + 便宜"的操作被判成 gate='none'，
  // 而 none 在任何策略下都不要求确认（策略只决定"从哪一级开始问"）。
  resetPlansForTests()
  const alwaysAnalyzeInspect = await tool('always', 'pdf_inspect', { path: ONE, analyze: true })
  check('策略 always：pdf_inspect analyze=true（expensive）要求确认',
    isPlanText(alwaysAnalyzeInspect), alwaysAnalyzeInspect.split('\n')[0])
  check('策略 always：高成本确认单写明"只读，不修改任何文件"',
    alwaysAnalyzeInspect.includes('只读，不修改任何文件'), '')

  resetPlansForTests()
  const cheapInspect = await tool('always', 'pdf_inspect', { path: ONE })
  check('策略 always：只读且便宜的操作是 gate=none，仍然直接执行',
    !isPlanText(cheapInspect) && cheapInspect.includes('1 页'), cheapInspect.split('\n')[0])
  check('策略 always：便宜只读操作不会登记计划', listPlans().length === 0, String(listPlans().length))
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. plan: true
 * ═════════════════════════════════════════════════════════════════════════ */

console.log('\n4. plan: true\n')
{
  resetPlansForTests()
  const planInspect = await tool('never', 'pdf_inspect', { path: ONE, plan: true })
  check('plan=true：只读工具也只返回确认单', isPlanText(planInspect), planInspect.split('\n')[0])
  check('plan=true：确认单里带 plan id', /计划 id：p_[0-9a-f]+/.test(planInspect))
  check('plan=true：没有真的执行（不带页数结论）',
    !planInspect.includes('页面尺寸：') && !planInspect.includes('分诊：'), planInspect.split('\n')[1] ?? '')
  check('plan=true：计划进了计划库', listPlans().length === 1, String(listPlans().length))

  // never 策略 + plan=true 仍然要给计划：plan 是显式请求，不该被策略吃掉。
  resetPlansForTests()
  const planWm = await tool('never', 'pdf_watermark', {
    path: ONE, action: 'add', text: 'PLAN-ONLY', output: 'wm-plan-only.pdf', plan: true,
  })
  check('plan=true：破坏性工具只给计划不执行', isPlanText(planWm), planWm.split('\n')[0])
  check('plan=true：没有产出文件', !existsSync(out('wm-plan-only.pdf')), out('wm-plan-only.pdf'))

  resetPlansForTests()
  const planSearchable = await tool('never', 'pdf_make_searchable', { path: MANY21, plan: true })
  check('plan=true：高成本工具只给计划不执行', isPlanText(planSearchable), planSearchable.split('\n')[0])
  check('plan=true：没有产出 21 页的可搜索文件',
    !existsSync(join(IN, 'many21-searchable.pdf')), join(IN, 'many21-searchable.pdf'))
  const planned = listPlans()
  check('plan=true：三个计划都是 pending', planned.length === 1 && planned.every(plan => plan.status === 'pending'),
    planned.map(plan => `${plan.tool}:${plan.status}`).join(','))
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. force: true（逃生舱）
 * ═════════════════════════════════════════════════════════════════════════ */

console.log('\n5. force: true（逃生舱）\n')
{
  resetPlansForTests()
  const file = out('wm-forced.pdf')
  if (existsSync(file)) rmSync(file)
  const forced = await tool('destructive', 'pdf_watermark', {
    path: ONE, action: 'add', text: 'FORCED', output: 'wm-forced.pdf', force: true,
  })
  check('force=true：跳过确认直接执行（逃生舱，仅供脚本）',
    forced.includes('已生成：') && !isPlanText(forced), forced.split('\n')[0])
  check('force=true：确实写盘', existsSync(file), file)
  check('force=true：没有登记任何计划', listPlans().length === 0, String(listPlans().length))

  // force 连"缺关键参数"都能绕过——这正是它必须被显式使用的原因。
  // 注意输出位置：没给 output 时工具按设计把结果写到**源文件旁**，也就是 IN 目录。
  resetPlansForTests()
  const escaped = join(IN, 'one-watermarked.pdf')
  if (existsSync(escaped)) rmSync(escaped)
  let forcedMissing = ''
  try {
    forcedMissing = await tool('destructive', 'pdf_watermark', { path: ONE, action: 'add', force: true })
  } catch (error) {
    forcedMissing = `THREW: ${error.message}`
  }
  check('force=true：连缺关键参数也被放行（逃生舱的代价）',
    forcedMissing.startsWith('已生成：'), forcedMissing.split('\n')[0])
  check('force=true：缺参数也写出了文件（记录这一点，避免误用）',
    existsSync(escaped), escaped)

  // force 在 always 策略下同样生效，说明它优先于策略判定。
  // 用 21 页（命中 > 20 高成本）而不是 35 页：force 验证的是"跳过闸门"，
  // 页数只影响执行代价，不影响这条断言要说明的事。
  resetPlansForTests()
  const forcedFile = out('searchable-forced.pdf')
  if (existsSync(forcedFile)) rmSync(forcedFile)
  const alwaysForced = await tool('always', 'pdf_make_searchable', {
    path: MANY21, output: forcedFile, force: true,
  })
  check('force=true：always 策略 + 高成本也直接执行',
    alwaysForced.includes('已生成：'), alwaysForced.split('\n')[0])
  check('force=true：21 页可搜索化产物存在', existsSync(forcedFile), forcedFile)
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. 计划库
 * ═════════════════════════════════════════════════════════════════════════ */

console.log('\n6. 计划库\n')
{
  resetPlansForTests()
  checkEq('resetPlansForTests() 后为空', listPlans().length, 0)

  const planA = await tool('destructive', 'pdf_edit_text', {
    path: ONE, edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'A' }], output: out('lib-a.pdf'),
  })
  const planB = await tool('destructive', 'pdf_edit_text', {
    path: ONE, edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'B' }], output: out('lib-b.pdf'),
  })
  const idA = planIdOf(planA)
  const idB = planIdOf(planB)
  check('两个不同参数得到两个不同 planId', idA !== idB, `${idA} / ${idB}`)
  checkEq('listPlans() 列出两个 pending', listPlans().length, 2)
  check('listPlans() 只列 pending',
    listPlans().every(plan => plan.status === 'pending'),
    listPlans().map(plan => plan.status).join(','))

  // 同参数重复生成不该产生第二份计划。
  const planAAgain = await tool('destructive', 'pdf_edit_text', {
    path: ONE, edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'A' }], output: out('lib-a.pdf'),
  })
  checkEq('同参数重复生成仍是同一个 planId', planIdOf(planAAgain), idA)
  checkEq('同参数重复生成不会新增计划', listPlans().length, 2)

  const settled = setPlanStatus(idB, 'confirmed')
  checkEq('setPlanStatus 生效', settled.status, 'confirmed')
  checkEq('确认后的计划不再出现在 pending 列表', listPlans().length, 1)
  checkEq('includeSettled 可以看到它', listPlans({ includeSettled: true }).length, 2)
  checkEq('setPlanStatus 对未知 id 返回 undefined', setPlanStatus('p_ffffffffffff', 'cancelled'), undefined)

  // 过期：把时间推到 TTL 之后，prunePlans 会把 pending 标成 expired。
  const before = listPlans()
  checkEq('过期前仍有一个 pending', before.length, 1)
  prunePlans(Date.now() + PLAN_TTL_MS + 60_000)
  checkEq('prunePlans 后 pending 为空', listPlans().length, 0)
  const allAfter = listPlans({ includeSettled: true })
  const stale = allAfter.find(plan => plan.planId === idA)
  check('prunePlans 把过期计划标成 expired', stale?.status === 'expired', stale?.status)

  checkEq('resetPlansForTests() 之后为空（重新开始）', (resetPlansForTests(), listPlans({ includeSettled: true }).length), 0)

  // computePlanId 的性质：同输入同 id；时间不参与。
  const material = {
    tool: 'pdf_edit_text',
    action: 'edit',
    parameters: { edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'A' }] },
    inputs: [{ path: ONE, size: ONE_SIZE, mtimeMs: 1234 }],
    output: { path: out('lib-a.pdf'), overwrites: false },
  }
  checkEq('computePlanId 稳定（同输入同 id）', computePlanId(material), computePlanId(material))
  check('computePlanId 对参数变化敏感',
    computePlanId(material) !== computePlanId({ ...material, parameters: { edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'B' }] } }))
  check('computePlanId 对输入文件指纹变化敏感',
    computePlanId(material) !== computePlanId({ ...material, inputs: [{ path: ONE, size: ONE_SIZE + 1, mtimeMs: 1234 }] }))
  check('computePlanId 对输出位置变化敏感',
    computePlanId(material) !== computePlanId({ ...material, output: { path: out('lib-z.pdf'), overwrites: false } }))
  check('computePlanId 不随时间变化（同输入跨调用一致）',
    computePlanId(material) === computePlanId({ ...material }))

  // issuePlan 幂等：重复登记不覆盖已有状态。
  resetPlansForTests()
  const registered = await tool('destructive', 'pdf_edit_text', {
    path: ONE, edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'IDEM' }], output: out('lib-idem.pdf'),
  })
  const idemId = planIdOf(registered)
  setPlanStatus(idemId, 'cancelled')
  const planObject = getPlan(idemId)
  const reissued = issuePlan(planObject)
  checkEq('issuePlan 幂等：不覆盖已取消的状态', reissued.status, 'cancelled')

  // 上面那些用例产生过已结算计划，最后统一清干净。
  resetPlansForTests()
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. HTTP 路由
 * ═════════════════════════════════════════════════════════════════════════ */

console.log('\n7. HTTP 路由\n')

/** 最小 ServerResponse 捕获（与 test/routes.test.mjs 同形）。 */
function fakeRes() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
    },
    end(chunk) {
      if (chunk === undefined) return
      state.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    },
    setHeader() {},
  }
}

/** 最小 IncomingMessage；默认回环 Host，否则 guard() 会 403。 */
function fakeReq({ method = 'GET', url = '/', headers = {} } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:19387', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  }
}

{
  const routes = makePdfRoutes({ workspaceRoot: OUT })
  const plansRoute = routes.find(route => route.path.endsWith('/plans'))
  check('存在 path 以 /plans 结尾的路由', plansRoute !== undefined,
    routes.map(route => route.path).filter(path => path.includes('plans')).join(','))

  const call = async (method, url) => {
    const res = fakeRes()
    await plansRoute.handler(fakeReq({ method, url }), res)
    return { status: res.state.status, body: res.state.body === '' ? {} : JSON.parse(res.state.body) }
  }

  // GET /plans → pending 列表
  resetPlansForTests()
  const pendingPlanText = await tool('destructive', 'pdf_watermark', {
    path: ONE, action: 'remove', output: out('route-clean.pdf'),
  })
  const routeId = planIdOf(pendingPlanText)
  const listed = await call('GET', PDF_API_PREFIX + '/plans')
  checkEq('GET /plans 状态 200', listed.status, 200)
  checkEq('GET /plans 返回 ok:true', listed.body.ok, true)
  check('GET /plans 返回 plans 数组', Array.isArray(listed.body.plans), JSON.stringify(listed.body.plans)?.slice(0, 80))
  checkEq('GET /plans 列出待确认计划', listed.body.plans.length, 1)
  checkEq('GET /plans 返回的是刚登记的计划', listed.body.plans[0].planId, routeId)
  check('GET /plans 的计划带确认单与到期时间',
    typeof listed.body.plans[0].sheet === 'string' && typeof listed.body.plans[0].expiresAt === 'number',
    Object.keys(listed.body.plans[0]).join(','))

  // POST /plans/{id}/confirm
  const confirmed = await call('POST', `${PDF_API_PREFIX}/plans/${routeId}/confirm`)
  checkEq('POST {id}/confirm 状态 200', confirmed.status, 200)
  checkEq('POST {id}/confirm 返回 ok:true', confirmed.body.ok, true)
  checkEq('POST {id}/confirm 把状态改成 confirmed', confirmed.body.plan.status, 'confirmed')
  checkEq('POST {id}/confirm 后计划库里的状态也是 confirmed', getPlan(routeId).status, 'confirmed')
  const afterConfirm = await call('GET', PDF_API_PREFIX + '/plans')
  checkEq('确认后的计划不再出现在 pending 列表', afterConfirm.body.plans.length, 0)

  // POST /plans/{id}/cancel
  resetPlansForTests()
  const cancelPlanText = await tool('destructive', 'pdf_watermark', {
    path: ONE, action: 'remove', output: out('route-clean-2.pdf'),
  })
  const cancelId = planIdOf(cancelPlanText)
  const cancelled = await call('POST', `${PDF_API_PREFIX}/plans/${cancelId}/cancel`)
  checkEq('POST {id}/cancel 状态 200', cancelled.status, 200)
  checkEq('POST {id}/cancel 把状态改成 cancelled', cancelled.body.plan.status, 'cancelled')
  checkEq('cancel 后计划库里也是 cancelled', getPlan(cancelId).status, 'cancelled')

  // 未知 id → 404
  const missing = await call('POST', `${PDF_API_PREFIX}/plans/p_000000000000/confirm`)
  checkEq('未知 id confirm → 404', missing.status, 404)
  checkEq('未知 id confirm 返回 ok:false', missing.body.ok, false)
  const missingCancel = await call('POST', `${PDF_API_PREFIX}/plans/p_000000000000/cancel`)
  checkEq('未知 id cancel → 404', missingCancel.status, 404)

  // 错误方法 → 405
  const wrongList = await call('POST', PDF_API_PREFIX + '/plans')
  checkEq('POST /plans（列表）→ 405', wrongList.status, 405)
  const wrongVerb = await call('GET', `${PDF_API_PREFIX}/plans/p_000000000000/confirm`)
  checkEq('GET {id}/confirm → 405', wrongVerb.status, 405)

  // 非回环请求必须被 guard 挡掉（否则确认接口就是一个本地 CSRF 入口）。
  const res = fakeRes()
  await plansRoute.handler(fakeReq({
    method: 'GET',
    url: PDF_API_PREFIX + '/plans',
    headers: { host: 'evil.example.com' },
  }), res)
  checkEq('非回环 Host → 403', res.state.status, 403)

  // 路由确认之后，带同一个 id 调工具应该被 refused（状态不再是 pending）——
  // 这钉住"路由改状态"和"工具校验状态"是同一份数据。
  resetPlansForTests()
  const crossPlanText = await tool('destructive', 'pdf_watermark', {
    path: ONE, action: 'remove', output: out('route-cross.pdf'),
  })
  const crossId = planIdOf(crossPlanText)
  await call('POST', `${PDF_API_PREFIX}/plans/${crossId}/cancel`)
  let crossMessage = ''
  try {
    await tool('destructive', 'pdf_watermark', {
      path: ONE, action: 'remove', output: out('route-cross.pdf'), confirm: crossId,
    })
  } catch (error) {
    crossMessage = String(error.message)
  }
  check('路由取消后工具 confirm 被 refused', crossMessage.includes('已被取消'), crossMessage.split('\n')[0])
  check('路由取消后没有产出文件', !existsSync(out('route-cross.pdf')), out('route-cross.pdf'))

  resetPlansForTests()
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 8. 确认单内容
 * ═════════════════════════════════════════════════════════════════════════ */

console.log('\n8. 确认单内容\n')
{
  // 前面的指纹用例重写过 one.pdf，所以大小要重新量（mtime/size 都可能已变）。
  const currentSize = (await readFile(ONE)).byteLength
  resetPlansForTests()
  // 用破坏性操作来取确认单：默认策略下它必定返回计划。
  const text = await tool('destructive', 'pdf_edit_text', {
    path: ONE,
    edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'SHEET-CONTENT' }],
    output: 'sheet-edited.pdf',
  })
  check('确认单：确认单文本以"需要你确认"开头', text.startsWith('⚠️ 这个操作需要你确认后才会执行。'), text.split('\n')[0])

  check('确认单：出现文件 basename', text.includes(`文件：${basename(ONE)}`),
    text.split('\n').find(line => line.startsWith('文件：')) ?? '')
  check('确认单：出现文件大小', text.includes(`${currentSize} B`),
    text.split('\n').find(line => line.startsWith('文件：')) ?? '')
  check('确认单：出现最后修改时间', text.includes('最后修改'),
    text.split('\n').find(line => line.startsWith('文件：')) ?? '')
  check('确认单：出现动作中文标题', text.includes('动作：改写文字'),
    text.split('\n').find(line => line.startsWith('动作：')) ?? '')
  check('确认单：出现参数摘要（含用户给的改写内容）',
    text.includes('参数：') && text.includes('edits') && text.includes('pageCount'),
    text.split('\n').find(line => line.startsWith('参数：')) ?? '')
  check('确认单：出现影响行"不修改源文件"', text.includes('影响：不修改源文件'),
    text.split('\n').find(line => line.startsWith('影响：')) ?? '')
  check('确认单：影响行说明结果写入新的 PDF', text.includes('结果写入新的 PDF'),
    text.split('\n').filter(line => line.startsWith('影响：')).join(' | '))
  check('确认单：影响行提醒 id 会前移（改写文字专有）', text.includes('id 会整体前移'),
    text.split('\n').filter(line => line.startsWith('影响：')).join(' | '))
  check('确认单：给出可纠正项提示', text.includes('要改哪一项直接说'),
    text.split('\n').find(line => line.startsWith('要改哪一项')) ?? '')
  check('确认单：出现输出会覆盖与否的说明（新文件不带"会被覆盖"）',
    !text.includes('会被覆盖'), text.split('\n').filter(line => line.startsWith('影响：')).join(' | '))

  // 水印的确认单要带默认值说明（render=text / opacity=0.15 这些"你没指定"的项）。
  resetPlansForTests()
  const wmSheet = await tool('destructive', 'pdf_watermark', {
    path: ONE, action: 'add', text: '内部资料', output: 'sheet-watermarked.pdf', plan: true,
  })
  check('确认单（水印）：出现默认值说明段落', wmSheet.includes('默认值：'),
    wmSheet.split('\n').find(line => line.startsWith('默认值：')) ?? '')
  check('确认单（水印）：写明默认 render=text', /render=text/.test(wmSheet))
  check('确认单（水印）：写明默认 opacity=0.15', /opacity=0\.15/.test(wmSheet))
  check('确认单（水印）：写明默认 placement=tile / fontSize=48',
    /placement=tile/.test(wmSheet) && /fontSize=48/.test(wmSheet))
  check('确认单（水印）：写明"你没指定，用了这些"', wmSheet.includes('你没指定，用了这些'))
  check('确认单（水印）：参数摘要里带用户给的水印文字', wmSheet.includes('内部资料'),
    wmSheet.split('\n').find(line => line.startsWith('参数：')) ?? '')
  // 计划库后面还要 reset，所以先把计划对象本身抓住。
  const wmPlan = getPlan(planIdOf(wmSheet))

  // 缺参数时默认值说明 + 待确认段落同时出现。
  resetPlansForTests()
  const missingSheet = await tool('destructive', 'pdf_watermark', { path: ONE, action: 'add' })
  check('确认单（缺参数）：同时出现默认值与待确认',
    missingSheet.includes('默认值：') && missingSheet.includes('待确认：'),
    missingSheet.includes('待确认：') ? 'both' : 'missing one')
  check('确认单（缺参数）：默认值里含 placement=tile / fontSize=48',
    /placement=tile/.test(missingSheet) && /fontSize=48/.test(missingSheet))

  // renderPlanPrompt 的内容（用 water mark 的确认单，它同时带默认值与参数摘要）。
  check('renderPlanPrompt：出现"需要你确认"', wmSheet.includes('需要你确认'),
    wmSheet.split('\n')[0])
  check('renderPlanPrompt：出现 planId 与有效期',
    /计划 id：p_[0-9a-f]+（15 分钟内有效）/.test(wmSheet),
    wmSheet.split('\n').find(line => line.startsWith('计划 id：')) ?? '')
  check('renderPlanPrompt：告诉用户怎么继续（带 confirm=）', wmSheet.includes('confirm=p_'),
    wmSheet.split('\n').filter(line => line.includes('confirm=')).join(' | '))
  check('renderPlanPrompt：告诉用户怎么取消', wmSheet.includes('不想执行就说「取消」'))
  check('renderPlanPrompt：确认单正文原样嵌入（sheet 与卡片同一份）',
    wmSheet.includes('影响：不修改源文件') && wmSheet.includes(`文件：${basename(ONE)}`))

  // 计划里也带着同一份 sheet，界面与文本不会漂移（对象在 reset 之前就抓住了）。
  const plan = wmPlan
  check('计划对象里的 sheet 与提示文本逐字一致（同一份）',
    plan !== undefined && typeof plan.sheet === 'string' && wmSheet.includes(plan.sheet),
    plan === undefined ? '计划不在库里' : plan.sheet.split('\n')[0])
  check('计划对象的 title / effects 都已填好',
    plan.title === '添加水印' && plan.effects.length > 0,
    `${plan.title}/${plan.effects.length}`)
  check('计划对象的 gate 与动作一致（水印 add 无破坏性因素 → none）',
    plan.gate === 'none' && plan.action === 'add', `${plan.gate}/${plan.action}`)
  check('计划对象的 inputs 带真实文件指纹（size/mtime）',
    plan.inputs.length === 1 && plan.inputs[0].size === currentSize && plan.inputs[0].mtimeMs > 0,
    JSON.stringify(plan.inputs))
  check('计划对象的 expiresAt - createdAt 恰为 PLAN_TTL_MS',
    plan.expiresAt - plan.createdAt === PLAN_TTL_MS,
    String(plan.expiresAt - plan.createdAt))

  // 破坏性操作的确认单把 gate 标成 destructive（供界面标注风险等级）。
  resetPlansForTests()
  const editSheet = await tool('destructive', 'pdf_edit_text', {
    path: ONE, edits: [{ page: 1, targetId: REAL_RUN_ID, to: 'GATE' }], output: 'sheet-gate.pdf',
  })
  const editPlan = getPlan(planIdOf(editSheet))
  check('计划对象的 gate=destructive（改写文字）', editPlan?.gate === 'destructive', editPlan?.gate)
  check('计划对象的 output.overwrites=false（输出还不存在）',
    editPlan?.output?.overwrites === false, JSON.stringify(editPlan?.output))

  // 让输出文件真的存在之后，覆盖信息要出现在门控结果里（gateReasons / output.overwrites）。
  resetPlansForTests()
  const created = await tool('destructive', 'pdf_edit_text', {
    ...editArgs('GATE2', 'sheet-gate.pdf'), force: true,
  })
  check('预置输出文件成功（用于覆盖提示）', created.includes('已生成：'), created.split('\n')[0])
  resetPlansForTests()
  // 注意：`plan: true` 会跳过门控判定，所以这里不能用它——覆盖信息来自门控结果。
  const overwritePlanSheet = await tool('destructive', 'pdf_edit_text', editArgs('GATE4', 'sheet-gate.pdf'))
  check('确认单：输出已存在时仍然只是确认单（未执行）',
    isPlanText(overwritePlanSheet), overwritePlanSheet.split('\n')[0])
  // 工具自带自定义 effects（改写文字会传两条），覆盖警告仍必须出现——
  // 这正是"用户最需要看到的一行被自定义 effects 顶掉"那个 bug 的回归断言。
  check('确认单：带自定义 effects 时仍写明"会被覆盖"',
    overwritePlanSheet.includes('会被覆盖') && overwritePlanSheet.includes('sheet-gate.pdf'),
    overwritePlanSheet.split('\n').filter(line => line.startsWith('影响：')).join(' | '))
  check('确认单：覆盖警告是独立影响行（不是塞进别的行里）',
    overwritePlanSheet.split('\n').some(line => line.startsWith('影响：') && line.includes('会被覆盖')),
    overwritePlanSheet.split('\n').filter(line => line.startsWith('影响：')).join(' | '))
  const overwritePlan = getPlan(planIdOf(overwritePlanSheet))
  check('计划对象：output.overwrites=true（输出已存在）',
    overwritePlan?.output?.overwrites === true, JSON.stringify(overwritePlan?.output))
  check('计划对象：gateReasons 里记录"输出文件已存在"（门控原因，供界面标注）',
    (overwritePlan?.gateReasons ?? []).some(reason => reason.includes('输出文件已存在')),
    JSON.stringify(overwritePlan?.gateReasons))
  check('计划对象：gate 仍是 destructive（改写文字）', overwritePlan?.gate === 'destructive', overwritePlan?.gate)

  // 不带自定义 effects 的直接调用：覆盖警告同样要出现在默认影响行里。
  // （输出文件由上面的 force 用例真实创建过。）
  resetPlansForTests()
  const directOverwrite = authorize({
    tool: 'pdf_make_searchable', action: 'searchable', parameters: {}, inputs: [ONE],
    output: out('sheet-gate.pdf'), pageCount: 1,
  })
  check('默认影响行：输出已存在时写明"会被覆盖"并带路径',
    directOverwrite.kind === 'plan'
      && directOverwrite.plan.effects.some(line => line.includes('会被覆盖') && line.includes('sheet-gate.pdf')),
    directOverwrite.kind === 'plan' ? directOverwrite.plan.effects.join(' | ') : directOverwrite.kind)

  // 新输出（不存在）时默认影响行只说写入位置，不带覆盖警告。
  // 用 planOnly 保证拿到计划：这条路径不看门控等级，纯粹验证 createPlan 的默认影响行。
  resetPlansForTests()
  const directFresh = authorize({
    tool: 'pdf_make_searchable', action: 'searchable', parameters: {}, inputs: [ONE],
    output: out('sheet-fresh-does-not-exist.pdf'), pageCount: 1, planOnly: true,
  })
  check('默认影响行：新输出不带覆盖警告',
    directFresh.kind === 'plan' && directFresh.plan.effects.some(line => line.includes('结果写入：'))
      && !directFresh.plan.effects.some(line => line.includes('会被覆盖')),
    directFresh.kind === 'plan' ? directFresh.plan.effects.join(' | ') : directFresh.kind)

  resetPlansForTests()
}

/* ── 9. confirm 允许"唯一前缀"（浮层只显示前 8 位，用户会照抄） ───────────── */

{
  resetPlansForTests()
  const prefixFile = join(ROOT, 'out', 'prefix-confirm.pdf')
  if (existsSync(prefixFile)) rmSync(prefixFile)

  const made = authorize({
    tool: 'pdf_edit_text',
    action: 'edit',
    parameters: { edits: [{ page: 1, targetId: 'x', to: 'y' }] },
    output: prefixFile,
    planOnly: true,
  })
  const fullId = made.kind === 'plan' ? made.plan.planId : ''
  check('前缀用例：先拿到一份计划', fullId.startsWith('p_'), fullId)

  const byFull = authorize({
    tool: 'pdf_edit_text', action: 'edit',
    parameters: { edits: [{ page: 1, targetId: 'x', to: 'y' }] },
    output: prefixFile, confirm: fullId,
  })
  check('完整 id 可以确认', byFull.kind === 'proceed', byFull.kind)

  // 浮层卡片显示的就是前 8 位；用户照抄这 8 位必须能用，否则卡片上的指引是假的。
  resetPlansForTests()
  const made2 = authorize({
    tool: 'pdf_edit_text', action: 'edit',
    parameters: { edits: [{ page: 1, targetId: 'x', to: 'y' }] },
    output: prefixFile, planOnly: true,
  })
  const shortId = made2.kind === 'plan' ? made2.plan.planId.slice(0, 8) : ''
  const byShort = authorize({
    tool: 'pdf_edit_text', action: 'edit',
    parameters: { edits: [{ page: 1, targetId: 'x', to: 'y' }] },
    output: prefixFile, confirm: shortId,
  })
  check('浮层显示的 8 位前缀可以确认（唯一匹配）', byShort.kind === 'proceed', `${shortId} → ${byShort.kind}`)

  resetPlansForTests()
  authorize({
    tool: 'pdf_edit_text', action: 'edit',
    parameters: { edits: [{ page: 1, targetId: 'x', to: 'y' }] },
    output: prefixFile, planOnly: true,
  })
  const tooShort = authorize({
    tool: 'pdf_edit_text', action: 'edit',
    parameters: { edits: [{ page: 1, targetId: 'x', to: 'y' }] },
    output: prefixFile, confirm: 'p_ab',
  })
  check('过短的前缀（< 6 位）被拒绝', tooShort.kind === 'refused', tooShort.kind)

  const unknownPrefix = authorize({
    tool: 'pdf_edit_text', action: 'edit',
    parameters: { edits: [{ page: 1, targetId: 'x', to: 'y' }] },
    output: prefixFile, confirm: 'p_zzzzzz',
  })
  check('匹配不到的前缀被拒绝', unknownPrefix.kind === 'refused', unknownPrefix.kind)

  resetPlansForTests()
}

/* ── 10. 带令牌必须校验：与"本次操作是否需要确认"无关 ─────────────────────── */
//
// 这里钉住一个真实出现过的漏洞：`plan: true` 要到一份计划后，如果该操作本身
// `gate === 'none'`（例如水印加到尚未存在的新文件），旧实现会跳过令牌校验直接执行——
// 于是"改掉参数 + 带旧令牌"就能绕过一致性保证，而且计划状态还停在 pending。
{
  const planFile = out('token-mismatch.pdf')
  if (existsSync(planFile)) rmSync(planFile)
  resetPlansForTests()

  // 水印 add 到新文件：gate 是 none（不破坏、无歧义），所以默认策略下不会自动拦。
  const first = await tool('destructive', 'pdf_watermark', {
    path: ONE, action: 'add', text: '内部资料', render: 'outline', output: planFile, plan: true,
  })
  check('非门控操作 + plan:true 也给确认单', isPlanText(first), first.split('\n')[0])
  const token = /计划 id：(p_[0-9a-f]+)/.exec(first)?.[1]
  check('拿到计划 id', typeof token === 'string' && token.startsWith('p_'), String(token))
  check('要计划时绝不落盘', !existsSync(planFile))

  // ① 改参数 + 带旧令牌 → 必须拒绝（旧实现在这里直接执行了）
  let tampered = ''
  try {
    tampered = await tool('destructive', 'pdf_watermark', {
      path: ONE, action: 'add', text: '机密（偷偷改的）', render: 'outline', output: planFile, confirm: token,
    })
  } catch (error) {
    tampered = `ERROR: ${error.message}`
  }
  check('改参数后带旧令牌 → 拒绝', tampered.includes('不一致'), tampered.split('\n')[0].slice(0, 80))
  check('被拒绝时没有落盘', !existsSync(planFile))
  const stillPending = listPlans({ includeSettled: true }).some(p => p.planId === token && p.status === 'pending')
  check('被拒绝的计划仍是 pending（没有被误消费）', stillPending)

  // ② 参数一模一样再确认 → 执行，并且计划被消费
  const okText = await tool('destructive', 'pdf_watermark', {
    path: ONE, action: 'add', text: '内部资料', render: 'outline', output: planFile, confirm: token,
  })
  check('参数一致时带令牌可以执行', okText.includes('已生成') && existsSync(planFile), okText.split('\n')[0])
  const consumed = listPlans({ includeSettled: true }).some(p => p.planId === token && p.status === 'consumed')
  check('执行成功后计划被标记 consumed', consumed)

  // ③ 已经消费过 → 再来一次被拒
  let replay = ''
  try {
    replay = await tool('destructive', 'pdf_watermark', {
      path: ONE, action: 'add', text: '内部资料', render: 'outline', output: planFile, confirm: token,
    })
  } catch (error) {
    replay = `ERROR: ${error.message}`
  }
  check('同一令牌不能重复执行', replay.includes('已经执行过一次'), replay.split('\n')[0].slice(0, 60))

  resetPlansForTests()
}

/* ── 收尾 ─────────────────────────────────────────────────────────────────── */

rmSync(ROOT, { recursive: true, force: true })

console.log(`\n共 ${checks} 条 check，失败 ${failed} 条`)
if (failed > 0) {
  process.exitCode = 1
  console.log(`${failed} CONFIRMATION CHECK(S) FAILED`)
} else {
  console.log('ALL CONFIRMATION CHECKS PASSED')
}
