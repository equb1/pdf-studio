#!/usr/bin/env node
/**
 * 提交信息规范校验：中文 Conventional Commits。
 *
 * 规则来自仓库的 `AGENTS.md`：**所有 Git 提交信息（标题与正文）无条件使用中文**，
 * 格式为 `<type>(<scope>): <中文描述>`。
 *
 * 除了格式，还检查三条**能用暂存区上下文验证**的规则（它们拦住的是"自动草稿"生成过的坏消息）：
 *
 * - **R1 禁止空话标题**：`新增 7 个文件` / `更新 12 个文件` 这类只有文件计数、没有实质名词的标题。
 * - **R2 scope 与暂存区一致**：暂存区里有 `src/**` 或 `public/**` 改动，但 scope（或 type 的语义位置）
 *   只落在 `test`/`docs` 这类附属目录 —— 标题会误导读者。纯 test、纯 docs 提交照常放行。
 * - **R3 禁止文件名碎片**：`新增a测试` / `新增foo文档` 这类从文件名拼出来的标题（全大写缩写如 OCR 不算）。
 *
 * 规则实现只有一份：本文件。commit-msg 钩子、提交助手 `commit.mjs` 与测试都调 `lintMessage`。
 *
 * 四种用法：
 *
 *   node scripts/commit-lint.mjs --file .git/COMMIT_EDITMSG   # commit-msg 钩子这样调用（自动读暂存区）
 *   node scripts/commit-lint.mjs --message "fix: 修正居中定位"
 *   node scripts/commit-lint.mjs --message "…" --staged "src/core/watermark.ts,test/x.mjs"
 *   cat 消息.txt | node scripts/commit-lint.mjs               # 从 stdin 读
 *
 * 暂存区路径：不给 `--staged`、或裸写 `--staged`（后面没有值）都表示**自动读**
 * `git diff --cached --name-only`；只有显式给了逗号/空格分隔的路径列表才用该列表。
 * （裸 `--staged` 曾被当成空列表，导致 R2 静默失效 —— 这是危险的假放行，已修。）
 *
 * 退出码：0 = 通过；1 = 不合规（钩子会据此拦住提交）。
 * 想临时绕过：`git commit --no-verify`（仅限确实不适用规范的场合，例如导入历史）。
 *
 * @module dsh-pdf-studio/scripts/commit-lint
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** 允许的 type 集合（Conventional Commits 常用子集 + revert）。 */
export const ALLOWED_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
]

/** 每个 type 的中文说明，供交互式助手展示。 */
export const TYPE_LABELS = {
  feat: '新功能',
  fix: '修 bug',
  docs: '文档',
  style: '格式（不影响逻辑）',
  refactor: '重构（不改行为）',
  perf: '性能',
  test: '测试',
  build: '构建/依赖/脚本',
  ci: 'CI 配置',
  chore: '杂项（版本号、生成物等）',
  revert: '回滚',
}

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()]*)\))?(?<breaking>!)?: (?<subject>.+)$/

/**
 * R1：空话标题 —— "动词 + 文件计数（+ 括号里的文件名列表）"，整句没有任何实质名词。
 * 例：`新增 7 个文件`、`删除 2 个文件（旧夹具）`、`更新 12 个脚本`。
 */
const EMPTY_SUBJECT = /^(新增|删除|更新|修改|调整)\s*\d+\s*个(文件|脚本|模块|文档|测试)(\s*[（(][^）)]*[）)])?$/

/**
 * R3：标题像是从**文件名碎片**拼出来的 —— "动词 + 1~3 个拉丁字符 + 测试/文档/文件/脚本"。
 * 例：`新增a测试`、`新增foo文档`（旧算法会把 `test/fixtures/a.png`、`test/a.test.mjs` 拼成这样）。
 * 全大写缩写（OCR/PDF）不算碎片，避免误伤 `新增OCR文档`。
 */
const SHORT_LATIN_OBJECT = /^(新增|删除|更新|修改|调整|增强|精简)([A-Za-z0-9_-]{1,3})(测试|文档|文件|脚本)$/

/** R2：附属目录的 scope —— 暂存区里有 src/public 改动时不允许只落在这里。 */
const AUX_SCOPES = new Set(['test', 'docs'])
const SRC_LIKE = /^(src|public)\//

/** 这些提交由 Git 或工具自动生成，规范不适用。 */
function isExempt(header) {
  return /^(Merge |Revert |fixup!|squash!|amend!|Automatic |Revert\b)/.test(header)
    || /^(Merge|Revert)\b/.test(header)
}

/** 重命名路径 `旧 → 新` / `旧 => 新` 归一成新路径。 */
function normalizePath(path) {
  const parts = String(path).split(/\s*(?:→|=>)\s*/)
  return parts[parts.length - 1].trim()
}

/** 截断列表，避免报错信息过长。 */
function listOf(items, limit = 3) {
  const unique = [...new Set(items)]
  if (unique.length <= limit) return unique.join('、')
  return `${unique.slice(0, limit).join('、')} 等 ${unique.length} 个`
}

/**
 * R2 的实现：暂存区里有 src/public 改动，但 scope/type 的语义位置只落在 test/docs。
 *
 * 返回错误文案数组（空数组 = 通过）。**纯 test、纯 docs 提交不会命中**（那时 corePaths 为空）。
 */
function checkStagedConsistency(parsed, stagedPaths) {
  const corePaths = stagedPaths.map(normalizePath).filter(path => SRC_LIKE.test(path))
  if (corePaths.length === 0) return []

  const scopeIsAux = AUX_SCOPES.has(parsed.scope)
  const typeIsAux = parsed.type === 'test' || parsed.type === 'docs'
  if (!scopeIsAux && !typeIsAux) return []

  const hasSrc = corePaths.some(path => path.startsWith('src/'))
  const hasPublic = corePaths.some(path => path.startsWith('public/'))
  const kind = hasSrc && hasPublic ? 'src/ 与 public/' : hasSrc ? 'src/' : 'public/'

  const bits = []
  if (scopeIsAux) bits.push(`scope 是「${parsed.scope}」`)
  if (typeIsAux) bits.push(`type 是「${parsed.type}」（语义位置在 ${parsed.type}/）`)

  const first = corePaths.find(path => path.startsWith('src/')) ?? corePaths[0]
  const example = first.split('/').pop().replace(/\.[^.]+$/, '') || first

  return [
    `暂存区里有 ${kind} 改动（${listOf(corePaths)}），但 ${bits.join('、')}，标题会误导读者`
    + `——请把 scope 换成暂存区里的实际模块（例如 ${first} → 「${example}」），或改用能体现这些改动的 type。`,
  ]
}

/**
 * 校验一条完整提交信息。
 *
 * `stagedPaths` 是暂存区路径列表（来自 `git diff --cached --name-only`）；不传就跳过 R2
 * （例如只想检查格式时）。钩子与提交助手都会传，所以两者判定一致。
 *
 * 返回 `{ ok, errors, warnings, parsed }`：`errors` 里有一条即视为不合规；
 * `warnings` 只提示、不拦截（例如正文过长、正文没写中文）。
 */
export function lintMessage(message, { stagedPaths = [] } = {}) {
  const errors = []
  const warnings = []
  // 去掉 Git 的注释行（编辑器里以 # 开头的模板说明）。
  const lines = message.replace(/\r\n/g, '\n').split('\n').filter(line => !line.startsWith('#'))
  const trimmed = lines.join('\n').trim()

  if (trimmed === '') {
    return { ok: false, errors: ['提交信息为空'], warnings, parsed: null }
  }

  const [header, ...rest] = trimmed.split('\n')
  const body = rest.join('\n').trim()

  if (isExempt(header)) {
    return { ok: true, errors, warnings, parsed: { exempt: true, header, body } }
  }

  // ── 标题 ────────────────────────────────────────────────────────────────
  const match = HEADER.exec(header)
  let parsed = { type: '', scope: '', breaking: false, subject: header, header, body }

  if (match === null) {
    errors.push(
      '标题不符合 `<type>(<scope>): <中文描述>` 格式（例如 `fix(watermark): 修正居中定位`）。'
      + '注意 type 后是英文冒号加一个空格。',
    )
  } else {
    const { type, scope, breaking, subject } = match.groups
    parsed = { type, scope: scope ?? '', breaking: breaking === '!', subject, header, body }

    if (!ALLOWED_TYPES.includes(type)) {
      errors.push(`type「${type}」不在允许列表：${ALLOWED_TYPES.join(' / ')}`)
    }
    if (scope !== undefined && !/^[a-z0-9][a-z0-9._/-]*$/.test(scope)) {
      errors.push(`scope「${scope}」只能用小写字母、数字、点、下划线、斜杠或连字符`)
    }
    if (!CJK.test(subject)) {
      errors.push(`标题描述必须用中文（当前：「${subject}」）——英文提交信息会被这里拦住`)
    }
    if (/[.。；;]$/.test(subject)) {
      errors.push('标题描述结尾不要加句号（中文句号也不行）')
    }
    if (/^(wip|WIP|update|updates|changes?)$/i.test(subject.trim())) {
      errors.push('标题描述过于笼统（如 update/changes/WIP），请说明改了什么')
    }
    if (EMPTY_SUBJECT.test(subject.trim())) {
      errors.push(
        `标题「${subject.trim()}」只有文件计数，没有说明改了什么`
        + '——请写出主导模块与改动性质（例如 `新增页级装配能力`）。',
      )
    }
    const shortLatin = SHORT_LATIN_OBJECT.exec(subject.trim())
    if (shortLatin !== null && !/^[A-Z]{2,3}$/.test(shortLatin[2])) {
      errors.push(
        `标题「${subject.trim()}」像是从文件名碎片拼出来的（"${shortLatin[2]}" 不是可读的模块名），`
        + '没有说明改了什么——请写出模块与改动性质（例如 `新增页级装配能力`）；'
        + '若这次改动只有图片/夹具，请用 `--subject` 明确说明改了什么。',
      )
    }
    if (header.length > 100) {
      errors.push(`标题过长（${header.length} 字符，上限 100）`)
    } else if (header.length > 72) {
      warnings.push(`标题偏长（${header.length} 字符，建议 ≤ 72）`)
    }

    // R2：scope/type 与暂存区是否一致（有暂存区上下文时才查）。
    errors.push(...checkStagedConsistency(parsed, stagedPaths))
  }

  // ── 正文 ────────────────────────────────────────────────────────────────
  if (body !== '') {
    // `rest` 的第一行就是标题之后的那一行：它必须是空行，否则正文与标题粘在一起。
    // （早先这里用 `find(非空行)`，结果"已经空了一行"的正常消息也会被警告。）
    if (rest.length > 0 && rest[0].trim() !== '') {
      warnings.push('标题与正文之间建议空一行')
    }
    if (!CJK.test(body)) {
      warnings.push('正文建议也用中文（AGENTS.md 要求提交信息整体使用中文）')
    }
    const longLine = body.split('\n').find(line => line.length > 120)
    if (longLine !== undefined) {
      warnings.push(`正文有超过 120 字符的行（建议折行）：${longLine.slice(0, 40)}…`)
    }
  }

  return { ok: errors.length === 0, errors, warnings, parsed }
}

/** 兼容旧名字：与 `lintMessage` 是同一份实现（第二个参数可传 `{ stagedPaths }`）。 */
export function validateMessage(message, options = {}) {
  return lintMessage(message, options)
}

/** 把校验结果打印成人能读的样子。 */
export function formatReport(result, { file } = {}) {
  const out = []
  if (result.ok) {
    out.push(`✅ 提交信息合规${file === undefined ? '' : `：${file}`}`)
  } else {
    out.push('❌ 提交信息不符合本项目规范（AGENTS.md：<type>(<scope>): <中文描述>，且必须用中文）')
    if (file !== undefined) out.push(`   文件：${file}`)
    for (const error of result.errors) out.push(`   • ${error}`)
  }
  for (const warning of result.warnings) out.push(`   ⚠️  ${warning}`)
  if (!result.ok) {
    out.push('')
    out.push('   推荐做法：用交互式助手重新组织提交信息')
    out.push('     npm run commit            # 自动分析暂存区并给出建议')
    out.push('   实在不适用规范时（例如导入外部历史）：git commit --no-verify')
  }
  return out.join('\n')
}

/* ── CLI：供 commit-msg 钩子或人工直接调用 ─────────────────────────────────── */

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** 暂存区路径（钩子运行时 cwd 就是仓库根；不在 git 仓库或没有暂存内容时返回空数组）。 */
export function stagedPathsFromGit() {
  try {
    const raw = execFileSync('git', ['diff', '--cached', '--name-only'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return raw.split('\n').map(line => line.trim()).filter(line => line !== '')
  } catch {
    return []
  }
}

/** 把 `--staged` 后面的值解析成路径列表；没有值（或值是另一个选项）时返回 undefined。 */
function parseStagedValue(raw) {
  const text = (raw ?? '').trim()
  // 裸 `--staged`（或 `--staged --message …`）一律当"没给值"：交给调用方自动读暂存区。
  // 这点很重要：把裸 `--staged` 当成空列表会让 R2 静默失效（危险的假放行）。
  if (text === '' || text.startsWith('-')) return undefined
  return text.split(/[,\s]+/).map(item => item.trim()).filter(item => item !== '')
}

function main(argv) {
  let message = ''
  let file
  let stagedPaths
  let stagedAuto = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--file') {
      file = argv[i + 1]
      message = readFileSync(file, 'utf8')
      i += 1
    } else if (arg === '--message' || arg === '-m') {
      message = argv[i + 1] ?? ''
      i += 1
    } else if (arg === '--staged' || arg.startsWith('--staged=')) {
      const inline = arg.startsWith('--staged=') ? arg.slice('--staged='.length) : undefined
      const value = parseStagedValue(inline !== undefined ? inline : argv[i + 1])
      if (inline === undefined && value !== undefined) i += 1 // 只有真的吃掉了值才前进一步
      if (value === undefined) {
        stagedAuto = true
        stagedPaths = undefined
      } else {
        stagedAuto = false
        stagedPaths = value
      }
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        '用法：node scripts/commit-lint.mjs [--file <提交信息文件> | --message "<消息>"] [--staged ["路径,…"]]\n'
        + '\n'
        + '  --staged "路径,路径"   显式指定暂存区路径（逗号或空格分隔），供 R2 判断\n'
        + '  --staged（裸写，不带值） 与完全不带 --staged 一样：自动读 `git diff --cached --name-only`\n'
        + '\n'
        + '不带消息参数时从 stdin 读取。退出码 0=合规，1=不合规。\n'
        + '规则：R1 空话标题（`新增 7 个文件`）、R2 scope 与暂存区不一致、R3 标题像文件名碎片（`新增a测试`）。\n',
      )
      return 0
    }
  }

  if (message === '') message = readStdin()
  if (stagedPaths === undefined || stagedAuto) stagedPaths = stagedPathsFromGit()

  const result = lintMessage(message, { stagedPaths })
  process.stdout.write(formatReport(result, { file }) + '\n')
  return result.ok ? 0 : 1
}

// 仅在被直接执行时进入 CLI（被 import 时只暴露函数）。
if (process.argv[1] !== undefined && process.argv[1].endsWith('commit-lint.mjs')) {
  process.exitCode = main(process.argv.slice(2))
}
