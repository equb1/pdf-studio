#!/usr/bin/env node
/**
 * 提交信息规范校验：中文 Conventional Commits。
 *
 * 规则来自仓库的 `AGENTS.md`：**所有 Git 提交信息（标题与正文）无条件使用中文**，
 * 格式为 `<type>(<scope>): <中文描述>`。
 *
 * 三种用法：
 *
 *   node scripts/commit-lint.mjs --file .git/COMMIT_EDITMSG   # commit-msg 钩子这样调用
 *   node scripts/commit-lint.mjs --message "fix: 修正居中定位"
 *   cat 消息.txt | node scripts/commit-lint.mjs               # 从 stdin 读
 *
 * 退出码：0 = 通过；1 = 不合规（钩子会据此拦住提交）。
 * 想临时绕过：`git commit --no-verify`（仅限确实不适用规范的场合，例如导入历史）。
 *
 * @module dsh-pdf-studio/scripts/commit-lint
 */

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

/** 这些提交由 Git 或工具自动生成，规范不适用。 */
function isExempt(header) {
  return /^(Merge |Revert |fixup!|squash!|amend!|Automatic |Revert\b)/.test(header)
    || /^(Merge|Revert)\b/.test(header)
}

/**
 * 校验一条完整提交信息。
 *
 * 返回 `{ ok, errors, warnings, parsed }`：`errors` 里有一条即视为不合规；
 * `warnings` 只提示、不拦截（例如正文过长、正文没写中文）。
 */
export function validateMessage(message) {
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
    if (header.length > 100) {
      errors.push(`标题过长（${header.length} 字符，上限 100）`)
    } else if (header.length > 72) {
      warnings.push(`标题偏长（${header.length} 字符，建议 ≤ 72）`)
    }
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

function main(argv) {
  let message = ''
  let file

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--file') {
      file = argv[i + 1]
      message = readFileSync(file, 'utf8')
      i += 1
    } else if (arg === '--message' || arg === '-m') {
      message = argv[i + 1] ?? ''
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        '用法：node scripts/commit-lint.mjs [--file <提交信息文件> | --message "<消息>"]\n'
        + '不带参数时从 stdin 读取。退出码 0=合规，1=不合规。\n',
      )
      return 0
    }
  }

  if (message === '') message = readStdin()

  const result = validateMessage(message)
  process.stdout.write(formatReport(result, { file }) + '\n')
  return result.ok ? 0 : 1
}

// 仅在被直接执行时进入 CLI（被 import 时只暴露函数）。
if (process.argv[1] !== undefined && process.argv[1].endsWith('commit-lint.mjs')) {
  process.exitCode = main(process.argv.slice(2))
}
