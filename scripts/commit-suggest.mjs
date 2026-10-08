#!/usr/bin/env node
/**
 * 根据暂存区改动，自动生成一份**中文 Conventional Commits 草稿**。
 *
 * 两种模式：
 *
 * 1. **离线规则模式（默认，不需要任何 API/网络）**：读 `git diff --cached`，
 *    按文件状态、路径、增删行、可见的符号变化与依赖变化拼出 type/scope/标题/正文。
 *    它不懂语义，写出来的是"骨架"——但把文件名、改动规模、依赖变化这些**人懒得抄**的东西都填好了。
 * 2. **AI 模式（可选）**：设置环境变量 `COMMIT_MSG_AI_CMD` 指向任意命令行模型，
 *    脚本会把规范说明 + 暂存区 diff 送到它的 stdin，用它的 stdout 当草稿。例如：
 *      export COMMIT_MSG_AI_CMD='ollama run qwen2.5'
 *      export COMMIT_MSG_AI_CMD='llm -m gpt-4o-mini'
 *    没配就自动用离线模式，绝不会因为网络问题卡住提交。
 *
 * 用法：
 *   node scripts/commit-suggest.mjs            # 打印草稿（标题 + 正文）
 *   node scripts/commit-suggest.mjs --json     # 结构化输出，供 commit.mjs 使用
 *
 * @module dsh-pdf-studio/scripts/commit-suggest
 */

import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** 去掉扩展名与目录，得到给人看的名字。 */
const shortName = (path) => basename(path).replace(/\.[^.]+$/, '')

/** 截断列表，避免标题过长。 */
function listOf(names, limit = 3) {
  const unique = [...new Set(names)]
  if (unique.length <= limit) return unique.join('、')
  return `${unique.slice(0, limit).join('、')} 等 ${unique.length} 项`
}

/**
 * 把一长串条目按宽度折行，避免正文出现超长行。
 * 续行用 `indent` 缩进，读起来仍是"一组"。
 */
function wrapList(prefix, items, indent = '  ', width = 88) {
  const lines = []
  let current = prefix
  for (const item of items) {
    const piece = current === prefix ? item : `、${item}`
    if (current.length + piece.length > width && current !== prefix) {
      lines.push(current)
      current = indent + item
    } else {
      current += piece
    }
  }
  if (current !== prefix) lines.push(current)
  return lines
}

/** 一组文件的**最长公共目录**（按路径段比较），用于概括成"新增 scripts/ 下 N 个脚本"。 */
function commonDir(paths) {
  const dirs = paths.map(path => path.split('/').slice(0, -1))
  if (dirs.length === 0) return ''
  let prefix = dirs[0]
  for (const dir of dirs.slice(1)) {
    let i = 0
    while (i < prefix.length && i < dir.length && prefix[i] === dir[i]) i += 1
    prefix = prefix.slice(0, i)
  }
  return prefix.length === 0 ? '' : `${prefix.join('/')}/`
}

/** 一组文件的统称（脚本 / 模块 / 文档 / 样式 / 文件），让概括句更自然。 */
function nounFor(paths) {
  const kinds = new Set()
  for (const path of paths) {
    const ext = /\.[^.]+$/.exec(path)?.[0].slice(1).toLowerCase()
    // 无扩展名的可执行脚本（例如 scripts/hooks/commit-msg）也算"脚本"，否则会被算成"文件"。
    if (ext !== undefined) kinds.add(ext)
    else kinds.add(/^scripts\/|\/bin\//.test(path) ? 'mjs' : 'noext')
  }
  if (kinds.size === 1) {
    const [ext] = [...kinds]
    if (ext === 'mjs' || ext === 'js' || ext === 'cjs') return '脚本'
    if (ext === 'ts' || ext === 'tsx') return '模块'
    if (ext === 'md') return '文档'
    if (ext === 'css' || ext === 'scss' || ext === 'less') return '样式'
    if (ext === 'json' || ext === 'yml' || ext === 'yaml') return '配置'
  }
  return '文件'
}

/** 生成"新增 …"这一小句：条目少就点名，条目多就概括。 */
function addPhrase(verb, paths, scope) {
  if (paths.length === 0) return ''
  if (paths.length <= 2) return `${verb} ${listOf(paths.map(shortName), 2)}`
  const dir = commonDir(paths)
  if (dir !== '' && dir !== `${scope}/`) return `${verb} ${dir} 下 ${paths.length} 个${nounFor(paths)}`
  return `${verb} ${paths.length} 个${nounFor(paths)}`
}

function classify(path) {
  if (path.startsWith('test/')) return 'test'
  if (path.startsWith('src/core/')) return 'core'
  if (path.startsWith('src/host/')) return 'host'
  if (path.startsWith('src/')) return 'src'
  if (/^(README|AGENTS|GEMINI|CHANGES|docs\/)/.test(path)) return 'docs'
  if (/^scripts\//.test(path)) return 'scripts'
  if (/^(package\.json|package-lock\.json|pnpm-lock\.yaml|\.gitignore|tsconfig|cordis\.patch\.yml)/.test(path)) return 'build'
  return path.split('/')[0]
}

function suggestScope(files) {
  const tally = new Map()
  for (const file of files) {
    const key = classify(file)
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  const [scope] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? []
  if (scope === 'core' || scope === 'host') {
    // 同一个子目录里的多个文件，用出现最多的模块名当 scope 更可读。
    const modules = files.filter(f => f.startsWith(`src/${scope}/`)).map(shortName)
    const moduleTally = new Map()
    for (const name of modules) moduleTally.set(name, (moduleTally.get(name) ?? 0) + 1)
    const [best] = [...moduleTally.entries()].sort((a, b) => b[1] - a[1])[0] ?? []
    if (best !== undefined && moduleTally.get(best) > 1) return best
    return best ?? scope
  }
  return scope ?? ''
}

/** 从 diff 里挑出"看起来是新增的导出符号"，用于正文里提示改了什么。 */
function addedSymbols(diff) {
  const symbols = new Set()
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const match = /^\+\s*export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (match !== null) symbols.add(match[1])
  }
  return [...symbols]
}

/** package.json 的依赖变化（新增/删除/版本）。 */
function dependencyChanges(diff) {
  const added = []
  const removed = []
  let inDeps = false
  for (const line of diff.split('\n')) {
    if (/^\+\+\+/.test(line)) continue
    if (/^[+-]\s*"(dependencies|devDependencies|peerDependencies)"/.test(line)) {
      inDeps = true
      continue
    }
    if (/^[+-]\s*}/.test(line)) {
      inDeps = false
      continue
    }
    if (!inDeps) continue
    const addedMatch = /^\+\s*"([^"]+)"\s*:/.exec(line)
    const removedMatch = /^-\s*"([^"]+)"\s*:/.exec(line)
    if (addedMatch !== null) added.push(addedMatch[1])
    if (removedMatch !== null) removed.push(removedMatch[1])
  }
  return { added, removed }
}

/** 改动涉及 package.json 的 scripts 段（新增/修改命令）。 */
function scriptChanges(diff) {
  const added = []
  let inScripts = false
  for (const line of diff.split('\n')) {
    if (/^[+-]\s*"scripts"/.test(line)) {
      inScripts = true
      continue
    }
    if (/^[+-]\s*}/.test(line)) {
      inScripts = false
      continue
    }
    if (!inScripts) continue
    const match = /^\+\s*"([^"]+)"\s*:/.exec(line)
    if (match !== null) added.push(match[1])
  }
  return added
}

/** 统计 diff 的增删行数。 */
function lineStats(diff) {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1
  }
  return { added, removed }
}

/** 解析 `--name-status` 输出。 */
function nameStatus() {
  const raw = git(['diff', '--cached', '--name-status'])
  const entries = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    const status = parts[0][0]
    const path = status === 'R' ? `${parts[1]} → ${parts[2]}` : parts[parts.length - 1]
    entries.push({ status, path, from: status === 'R' ? parts[1] : undefined })
  }
  return entries
}

/**
 * 生成草稿。返回 `{ type, scope, subject, body, source }`。
 *
 * `source` 是 `'ai'` 或 `'rules'`，便于调用方告诉用户草稿是怎么来的。
 */
export function buildSuggestion() {
  const entries = nameStatus()
  if (entries.length === 0) {
    return { type: '', scope: '', subject: '', body: '', source: 'rules', empty: true }
  }

  const files = entries.map(entry => (entry.from === undefined ? entry.path : entry.path.split(' → ')[1]))
  const diff = git(['diff', '--cached'])
  const stats = lineStats(diff)
  const statuses = entries.map(entry => entry.status)
  const scope = suggestScope(files)

  const added = entries.filter(entry => entry.status === 'A').map(entry => entry.path)
  const deleted = entries.filter(entry => entry.status === 'D').map(entry => entry.path)
  const renamed = entries.filter(entry => entry.status === 'R')
  const modified = entries.filter(entry => entry.status === 'M').map(entry => entry.path)

  // ── type ────────────────────────────────────────────────────────────────
  const all = (predicate) => files.length > 0 && files.every(predicate)
  let type = 'fix'
  if (all(file => file.startsWith('test/'))) type = 'test'
  else if (all(file => /^(README|AGENTS|GEMINI|CHANGES|docs\/)/.test(file))) type = 'docs'
  else if (all(file => /^(scripts\/|package\.json|package-lock\.json|pnpm-lock\.yaml|\.gitignore)/.test(file))) {
    type = 'build'
  } else if (added.length > 0 && modified.length === 0 && deleted.length === 0) type = 'feat'
  else if (deleted.length > 0 && added.length === 0 && modified.length === 0) type = 'chore'
  else if (added.length > 0) type = 'feat'
  else if (all(file => file.startsWith('test/'))) type = 'test'

  // ── 标题 ────────────────────────────────────────────────────────────────
  const pieces = []
  const addPiece = addPhrase('新增', added, scope)
  if (addPiece !== '') pieces.push(addPiece)
  if (renamed.length > 0) pieces.push(`重命名 ${listOf(renamed.map(entry => shortName(entry.path.split(' → ')[1])), 2)}`)
  if (deleted.length > 0 && added.length === 0) pieces.push(addPhrase('删除', deleted, scope))
  if (modified.length > 0) {
    const deps = dependencyChanges(diff)
    const scripts = scriptChanges(diff)
    if (modified.some(file => file.endsWith('package.json')) && deps.added.length + deps.removed.length > 0) {
      const bits = []
      if (deps.added.length > 0) bits.push(`新增依赖 ${listOf(deps.added, 2)}`)
      if (deps.removed.length > 0) bits.push(`移除依赖 ${listOf(deps.removed, 2)}`)
      pieces.push(bits.join('，'))
    } else if (scripts.length > 0) {
      pieces.push(`补充 ${listOf(scripts, 2)} 等脚本`)
    } else if (pieces.length === 0) {
      pieces.push(`调整 ${listOf(modified.map(shortName), 3)} 相关实现`)
    }
  }
  let subject = pieces.join('，') || `更新 ${files.length} 个文件`

  // ── 正文 ────────────────────────────────────────────────────────────────
  const bodyLines = []
  if (added.length > 0) bodyLines.push(...wrapList('新增：', added))
  if (modified.length > 0) bodyLines.push(...wrapList('修改：', modified))
  if (renamed.length > 0) bodyLines.push(...wrapList('重命名：', renamed.map(entry => entry.path)))
  if (deleted.length > 0) bodyLines.push(...wrapList('删除：', deleted))
  const deps = dependencyChanges(diff)
  if (deps.added.length + deps.removed.length > 0) {
    const bits = []
    if (deps.added.length > 0) bits.push(`新增 ${listOf(deps.added, 5)}`)
    if (deps.removed.length > 0) bits.push(`移除 ${listOf(deps.removed, 5)}`)
    bodyLines.push(`依赖变化：${bits.join('；')}`)
  }
  const symbols = addedSymbols(diff)
  if (symbols.length > 0) bodyLines.push(...wrapList('新增导出：', symbols, '  '))
  bodyLines.push(`改动规模：${files.length} 个文件，+${stats.added} / -${stats.removed} 行`)

  // 标题别超长：超了就退回更概括的说法。
  if (`${type}(${scope}): ${subject}`.length > 72) {
    subject = `${added.length > 0 ? '新增' : deleted.length > 0 ? '删除' : '更新'} ${files.length} 个文件（${listOf(files.map(shortName), 2)}）`
  }

  return { type, scope, subject, body: bodyLines.join('\n'), source: 'rules' }
}

/* ── AI 模式（可选）────────────────────────────────────────────────────────── */

const AI_PROMPT_HEADER = `你在为 git 仓库生成一条提交信息。规则（必须严格遵守）：
- 输出只有提交信息本身，不要任何解释、不要代码块围栏。
- 第一行格式：<type>(<scope>): <中文描述>，type 只能取 feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert。
- 描述必须用中文，结尾不加句号，整行不超过 72 个字符。
- 第二行留空，之后可以写中文正文（每行一条要点）。
- 不要编造 diff 里没有的改动。

以下是暂存区内容（git diff --cached --stat 与 patch）：

`

/** 用外部 AI 命令生成草稿；未配置或失败时返回 undefined。 */
export function buildAiSuggestion() {
  const command = process.env.COMMIT_MSG_AI_CMD
  if (command === undefined || command.trim() === '') return undefined

  const stat = git(['diff', '--cached', '--stat'])
  let patch = git(['diff', '--cached'])
  const LIMIT = 120_000
  if (patch.length > LIMIT) patch = `${patch.slice(0, LIMIT)}\n…（diff 过长已截断）`

  try {
    const raw = execFileSync('sh', ['-c', command], {
      input: AI_PROMPT_HEADER + stat + '\n' + patch,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    })
    const cleaned = raw.replace(/^```[a-z]*\n?/gm, '').replace(/```\s*$/gm, '').trim()
    if (cleaned === '') return undefined
    const [header, ...rest] = cleaned.split('\n')
    const match = /^([a-z]+)(?:\(([^()]*)\))?!?: (.+)$/.exec(header.trim())
    if (match === null) return undefined
    return {
      type: match[1],
      scope: match[2] ?? '',
      subject: match[3],
      body: rest.join('\n').trim(),
      source: 'ai',
    }
  } catch {
    return undefined
  }
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(
      '用法：node scripts/commit-suggest.mjs [--json]\n'
      + '  环境变量 COMMIT_MSG_AI_CMD 指向一个命令行模型即可启用 AI 模式（可选）。\n',
    )
    return 0
  }
  const ai = buildAiSuggestion()
  const suggestion = ai ?? buildSuggestion()
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(suggestion, null, 2) + '\n')
    return 0
  }
  if (suggestion.empty === true) {
    process.stdout.write('暂存区为空：先 git add，再生成草稿。\n')
    return 1
  }
  const header = `${suggestion.type}${suggestion.scope === '' ? '' : `(${suggestion.scope})`}: ${suggestion.subject}`
  process.stdout.write(`${header}\n`)
  if (suggestion.body !== '') process.stdout.write(`\n${suggestion.body}\n`)
  process.stdout.write(`\n（草稿来源：${suggestion.source === 'ai' ? `AI 命令 ${process.env.COMMIT_MSG_AI_CMD}` : '离线规则'}；请按实际情况修改后提交）\n`)
  return 0
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('commit-suggest.mjs')) {
  process.exitCode = main()
}
