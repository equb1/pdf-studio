#!/usr/bin/env node
/**
 * 中文 Conventional Commits 提交助手。
 *
 * 为什么不用编辑器/工具自带的提交按钮：那些集成生成的提交信息往往是英文、且格式不受控，
 * 而本仓库（见 `AGENTS.md`）要求**提交信息无条件用中文**、格式为 `<type>(<scope>): <中文描述>`。
 * 这个脚本自己读 `git diff --cached`，给出 type/scope 建议，拼出规范消息，并在提交前用
 * `scripts/commit-lint.mjs`（与 commit-msg 钩子同一套规则）自检。
 *
 * 自动草稿以 `src/**` 的改动为准（见 `scripts/commit-suggest.mjs`）；如果从暂存区推断不出
 * 有意义的标题（例如只改了图片/夹具），**不会编一个"更新 N 个文件"式的空话**：
 * `--auto` / 非交互模式直接报错退出，交互模式则要求你显式输入。
 *
 * 用法：
 *   npm run commit                                   # 交互式（推荐）
 *   npm run commit -- --type fix --scope watermark --subject "修正居中定位" --print
 *   npm run commit -- --subject "补充提交规范工具" --body "新增 commit-lint 与提交助手" --yes
 *   npm run commit -- --amend                        # 修订上一次提交（沿用其类型与 scope）
 *
 * 选项：--type --scope --subject --body（可重复）--footer --amend --print --yes --no-verify --all --auto
 *   --all     先 `git add -A` 再提交（默认只提交已暂存内容）
 *   --print   只打印将要提交的信息，不真的提交
 *   --yes     不再逐项确认（仍会跑规范校验）
 *   --auto    直接采用自动草稿（推断不出标题时报错退出，要求显式 --subject）
 *
 * @module dsh-pdf-studio/scripts/commit
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { ALLOWED_TYPES, TYPE_LABELS, lintMessage } from './commit-lint.mjs'
import { buildAiSuggestion, buildSuggestion } from './commit-suggest.mjs'

const git = (args, { input } = {}) =>
  execFileSync('git', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd()

/** 给 commit-suggest 用的 git 执行器：返回原始 stdout（不 trim），让它自己解析。 */
const rawGit = (args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })

const tryGit = (args) => {
  try {
    return git(args)
  } catch (error) {
    return `（git ${args.join(' ')} 失败：${error.message.split('\n')[0]}）`
  }
}

/** 解析 `git diff --cached --name-status` 的输出。 */
function stagedChanges() {
  const raw = tryGit(['diff', '--cached', '--name-status'])
  if (raw === '' || raw.startsWith('（git')) return { files: [], statuses: [], raw }
  const files = []
  const statuses = []
  for (const line of raw.split('\n')) {
    const [status, ...rest] = line.split('\t')
    if (status === undefined || rest.length === 0) continue
    statuses.push(status[0])
    files.push(rest[rest.length - 1])
  }
  return { files, statuses, raw }
}

/** 上次提交的 type/scope，给 --amend 用。 */
function lastCommitParts() {
  try {
    const header = git(['log', '-1', '--pretty=%s'])
    const match = /^([a-z]+)(?:\(([^()]*)\))?!?: /.exec(header)
    return { type: match?.[1] ?? '', scope: match?.[2] ?? '', header }
  } catch {
    return { type: '', scope: '', header: '' }
  }
}

/** 把消息写到临时文件后用 `git commit -F`，避免多行/引号被 shell 拆坏。 */
function commitWith(message, { amend, noVerify }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-commit-'))
  const file = join(dir, 'COMMIT_EDITMSG')
  writeFileSync(file, message.endsWith('\n') ? message : message + '\n', 'utf8')
  const args = ['commit', '-F', file]
  if (amend) args.push('--amend')
  if (noVerify) args.push('--no-verify')
  try {
    const output = execFileSync('git', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] })
    process.stdout.write(output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function parseArgs(argv) {
  const options = {
    type: '',
    scope: '',
    subject: '',
    body: [],
    footer: '',
    amend: false,
    print: false,
    yes: false,
    noVerify: false,
    all: false,
    auto: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const take = () => argv[i += 1] ?? ''
    if (arg === '--type') options.type = take()
    else if (arg === '--scope') options.scope = take()
    else if (arg === '--subject' || arg === '-m') options.subject = take()
    else if (arg === '--body') options.body.push(take())
    else if (arg === '--footer') options.footer = take()
    else if (arg === '--amend') options.amend = true
    else if (arg === '--print' || arg === '--dry-run') options.print = true
    else if (arg === '--yes' || arg === '-y') options.yes = true
    else if (arg === '--no-verify') options.noVerify = true
    else if (arg === '--auto') options.auto = true
    else if (arg === '--all' || arg === '-a') options.all = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else process.stdout.write(`⚠️  忽略未知参数：${arg}\n`)
  }
  return options
}

const HELP = `用法：npm run commit -- [选项]

  --type <feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert>
  --scope <scope>        例如 watermark / test / docs（可省略）
  --subject "中文描述"   必填，必须是中文
  --body "段落"          可重复，作为正文
  --footer "脚注"        例如 BREAKING CHANGE: … 或 Refs: #12
  --auto                 直接采用自动生成的草稿（不再逐项询问）
  --amend                修订上一次提交（沿用其 type/scope）
  --all                  提交前先 git add -A
  --print                只打印消息，不提交
  --yes                  不再逐项确认
  --no-verify            跳过 commit-msg 钩子（规范校验）
  -h, --help             显示本帮助

自动草稿的规则：按"路径层 + 变更行数"定主导改动，src/** 优先于 public/scripts/配置，
test/docs 只在没有 src/public 改动时才配当 scope；标题永远是"动词 + 模块中文名 + 能力"
（例如 \`新增页级装配能力\`），不会写成"新增 N 个文件"；scope 与 type 相同时省略 scope
（不产出 \`test(test)\`）。二进制文件与 \`test/fixtures/**\` **不作为标题素材**。
若从暂存区推断不出有意义的标题（例如只改了图片/夹具），**不会编一个空话标题**：
--auto / 非交互模式直接报错退出，交互模式则要求你显式输入 --subject。
（\`npm run commit:lint\` 的裸 \`--staged\` 与不给 \`--staged\` 一样，都会自动读暂存区。）
`

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  if (options.all) {
    git(['add', '-A'])
    process.stdout.write('已执行 git add -A\n')
  }

  const { files, raw } = stagedChanges()
  if (files.length === 0) {
    process.stdout.write('暂存区为空，先 `git add <文件>`（或用 `npm run commit -- --all`）。\n')
    return 1
  }

  // 先让生成器给出草稿（配了 COMMIT_MSG_AI_CMD 就是 AI 生成的，否则是离线规则生成）。
  // 显式 `--type` 作为 typeHint 传进去，标题会跟着写成"修正…"而不是瞎猜。
  const previous = options.amend ? lastCommitParts() : { type: '', scope: '', header: '' }
  const ai = buildAiSuggestion({ runGit: rawGit })
  const draft = ai ?? buildSuggestion({ runGit: rawGit, typeHint: options.type })
  const suggestedScope = options.scope !== '' ? options.scope : draft.scope
  const suggestedType = draft.type !== '' ? draft.type : 'fix'
  const hasDraft = draft.empty !== true && draft.inscrutable !== true && draft.subject !== ''

  process.stdout.write('\n暂存区改动：\n')
  process.stdout.write(raw.split('\n').map(line => `  ${line}`).join('\n') + '\n')
  if (hasDraft) {
    const draftHeader = `${draft.type}${draft.scope === '' ? '' : `(${draft.scope})`}: ${draft.subject}`
    process.stdout.write(`\n自动生成的草稿（来源：${ai === undefined ? '离线规则' : 'AI 命令'}）：\n`)
    process.stdout.write(`  ${draftHeader}\n`)
    if (draft.body !== '') {
      process.stdout.write(draft.body.split('\n').map(line => `  ${line}`).join('\n') + '\n')
    }
    process.stdout.write('（回车即采用草稿；也可以逐项改写）\n')
  } else if (draft.inscrutable === true) {
    process.stdout.write(`\n⚠️  无法从暂存区推断有意义的提交标题：${draft.reason}。\n`)
    process.stdout.write('    请显式指定标题（--subject）。\n')
  }
  process.stdout.write('\n')

  const interactive = process.stdin.isTTY === true && !options.yes && !options.auto
    && (options.subject === '' || options.type === '')
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null
  const ask = async (question, fallback = '') => {
    if (rl === null) return fallback
    const answer = (await rl.question(question)).trim()
    return answer === '' ? fallback : answer
  }

  try {
    // ── type ──────────────────────────────────────────────────────────────
    let type = options.type !== '' ? options.type : previous.type
    if (type === '' || !ALLOWED_TYPES.includes(type)) {
      if (rl !== null) {
        process.stdout.write('选择 type：\n')
        ALLOWED_TYPES.forEach((name, index) => {
          const mark = name === suggestedType ? ' ←建议' : ''
          process.stdout.write(`  ${String(index + 1).padStart(2)}. ${name.padEnd(9)}${TYPE_LABELS[name]}${mark}\n`)
        })
        const answer = (await rl.question(`type（序号或名称，回车取 ${suggestedType}）：`)).trim()
        if (answer === '') type = suggestedType
        else if (/^\d+$/.test(answer)) type = ALLOWED_TYPES[Number(answer) - 1] ?? suggestedType
        else type = answer
      } else {
        type = ALLOWED_TYPES.includes(type) ? type : suggestedType
      }
    }

    // ── scope ─────────────────────────────────────────────────────────────
    let scope = options.scope !== '' ? options.scope : previous.scope
    if (scope === '' && rl !== null) {
      scope = await ask(`scope（回车取 ${suggestedScope || '不填'}，输入 - 表示不填）：`, suggestedScope)
      if (scope === '-') scope = ''
    } else if (scope === '') {
      scope = suggestedScope
    }

    // ── subject ───────────────────────────────────────────────────────────
    let subject = options.subject !== '' ? options.subject : (options.auto ? draft.subject : '')
    if (subject === '' && rl !== null) {
      const shown = draft.subject === '' ? '' : `（回车采用草稿：${draft.subject}）`
      while (subject === '') {
        subject = (await rl.question(`中文描述${shown}：`)).trim()
        if (subject === '') subject = draft.subject
        if (subject === '') process.stdout.write('  描述不能为空。\n')
      }
    }
    if (subject === '') {
      if (draft.inscrutable === true) {
        process.stdout.write(
          `❌ 无法从暂存区推断有意义的提交标题：${draft.reason}。\n`
          + '   请显式传 --subject "…"，例如：\n'
          + '     npm run commit -- --type fix --scope watermark --subject "修正居中定位"\n',
        )
      } else {
        process.stdout.write('缺少 --subject，且当前不是交互终端。\n')
      }
      return 1
    }

    // ── body / footer ─────────────────────────────────────────────────────
    const bodyLines = [...options.body]
    if (bodyLines.length === 0 && options.auto) {
      bodyLines.push(...draft.body.split('\n').filter(line => line.trim() !== ''))
    }
    if (rl !== null && bodyLines.length === 0 && options.body.length === 0) {
      process.stdout.write('正文（可多行，直接回车结束）：\n')
      for (;;) {
        const line = (await rl.question('  > ')).trimEnd()
        if (line === '') break
        bodyLines.push(line)
      }
    }
    let footer = options.footer
    if (rl !== null && footer === '') footer = await ask('脚注（可空，如 Refs: #12）：')

    // 修订上一次提交时，如果原信息带破坏性标记（`!`）就沿用，避免 amend 时无意丢掉它。
    const breaking = options.amend && previous.header.includes('!:') ? '!' : ''
    const header = `${type}${scope === '' ? '' : `(${scope})`}${breaking}: ${subject}`
    const message = [header, ...(bodyLines.length > 0 ? ['', ...bodyLines] : []), ...(footer === '' ? [] : ['', footer])].join('\n')

    // ── 自检（与钩子同一套规则，含"空话标题"与"scope 与暂存区不一致"）───────
    const result = lintMessage(message, { stagedPaths: files })
    process.stdout.write('\n将要提交的信息：\n')
    process.stdout.write(message.split('\n').map(line => `  │ ${line}`).join('\n') + '\n\n')
    for (const warning of result.warnings) process.stdout.write(`⚠️  ${warning}\n`)
    if (!result.ok) {
      process.stdout.write('❌ 规范自检未通过：\n')
      for (const error of result.errors) process.stdout.write(`   • ${error}\n`)
      return 1
    }
    process.stdout.write('✅ 规范自检通过\n')

    if (options.print) {
      process.stdout.write('（--print：未提交）\n')
      return 0
    }

    if (rl !== null) {
      const answer = (await rl.question('确认提交？[Y/n] ')).trim().toLowerCase()
      if (answer !== '' && answer !== 'y' && answer !== 'yes') {
        process.stdout.write('已取消。\n')
        return 0
      }
    }

    commitWith(message, { amend: options.amend, noVerify: options.noVerify })
    process.stdout.write(`\n已提交：${header}\n`)
    return 0
  } finally {
    rl?.close()
  }
}

process.exitCode = await main()
