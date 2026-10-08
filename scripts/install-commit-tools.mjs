#!/usr/bin/env node
/**
 * 把"中文提交规范工具链"安装到**任意** git 仓库。
 *
 * 为什么需要它：仓库自带的 `npm run commit` 只在该仓库里有效。如果你想在自己的其它项目
 * （例如那堆用 pnpm 的 Vue 项目）里也用同一套规则，不必手工复制文件、手工改 package.json、
 * 手工配钩子——跑这个脚本即可。
 *
 * 用法：
 *   node scripts/install-commit-tools.mjs --into /path/to/repo            # 安装
 *   node scripts/install-commit-tools.mjs --into /path/to/repo --dry-run  # 只看会改什么
 *   node scripts/install-commit-tools.mjs --into /path/to/repo --force    # 覆盖已有同名文件/脚本
 *   node scripts/install-commit-tools.mjs --into /path/to/repo --no-hook  # 只拷脚本，不装钩子
 *
 * 它做四件事（都可回退，且绝不覆盖你原有的 package.json 内容）：
 *   1. 复制 `commit-lint.mjs` / `commit.mjs` / `commit-suggest.mjs` / `install-hooks.mjs` / `hooks/commit-msg`
 *      到目标仓库的 `scripts/`；
 *   2. 往目标 `package.json` 合并 4 个 npm 脚本（commit / commit:lint / hooks:install / hooks:check），
 *      保留原有脚本、缩进风格与结尾换行；
 *   3. `git config core.hooksPath scripts/hooks`（仅目标仓库，不动全局）；
 *   4. 给钩子补可执行位，并自检一遍。
 *
 * @module dsh-pdf-studio/scripts/install-commit-tools
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)

const has = (flag) => argv.includes(flag)
const valueOf = (flag) => {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

/** 需要随安装一起落到目标仓库的文件（相对本脚本目录）。 */
const PAYLOAD = [
  { from: 'commit-lint.mjs', to: 'scripts/commit-lint.mjs', executable: true },
  { from: 'commit.mjs', to: 'scripts/commit.mjs', executable: true },
  { from: 'commit-suggest.mjs', to: 'scripts/commit-suggest.mjs', executable: true },
  // 必须一起带上：合并进去的 `hooks:install` / `hooks:check` 指向它，少了它那两个脚本会直接报错。
  { from: 'install-hooks.mjs', to: 'scripts/install-hooks.mjs', executable: true },
  { from: join('hooks', 'commit-msg'), to: join('scripts', 'hooks', 'commit-msg'), executable: true },
]

/** 要合并进目标 package.json 的脚本（值用 `node`，这样 npm / pnpm / yarn 都能跑）。 */
const SCRIPTS = {
  commit: 'node scripts/commit.mjs',
  'commit:lint': 'node scripts/commit-lint.mjs',
  'hooks:install': 'node scripts/install-hooks.mjs',
  'hooks:check': 'node scripts/install-hooks.mjs --check',
}

const out = (text = '') => process.stdout.write(text + '\n')
const say = (verb, text) => out(`  ${verb} ${text}`)

function gitOrNull(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

/** 探测 JSON 文件的缩进与结尾换行，避免把别人的 package.json 重排。 */
function detectFormatting(source) {
  const indentMatch = /^([ \t]+)"/m.exec(source)
  const indent = indentMatch?.[1] ?? '  '
  return { indent, trailingNewline: source.endsWith('\n') }
}

function patchPackageJson(targetRoot, { dryRun, force }) {
  const file = join(targetRoot, 'package.json')
  if (!existsSync(file)) {
    say('⚠️ ', '目标没有 package.json：跳过 npm 脚本合并（仍可直接 `node scripts/commit.mjs`）')
    return { changed: false, skipped: true }
  }

  const source = readFileSync(file, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    say('❌', `package.json 不是合法 JSON，未改动：${error.message}`)
    return { changed: false, failed: true }
  }

  const scripts = parsed.scripts ?? {}
  const added = []
  const conflicts = []
  for (const [name, command] of Object.entries(SCRIPTS)) {
    if (scripts[name] === undefined) {
      scripts[name] = command
      added.push(name)
    } else if (scripts[name] !== command) {
      if (force) {
        scripts[name] = command
        added.push(`${name}（覆盖）`)
      } else {
        conflicts.push(`${name} = ${JSON.stringify(scripts[name])}`)
      }
    }
  }

  if (added.length === 0 && conflicts.length === 0) {
    say('=', 'package.json 里 4 个脚本都已是本工具链的值，无需改动')
    return { changed: false }
  }
  for (const conflict of conflicts) {
    say('⚠️ ', `package.json 已有同名脚本，未覆盖（要覆盖加 --force）：${conflict}`)
  }
  if (added.length === 0) return { changed: false }

  if (dryRun) {
    say('→', `将会向 package.json 添加脚本：${added.join(', ')}`)
    return { changed: true, dryRun: true }
  }

  const { indent, trailingNewline } = detectFormatting(source)
  parsed.scripts = scripts
  const next = JSON.stringify(parsed, null, indent) + (trailingNewline ? '\n' : '')
  writeFileSync(file, next, 'utf8')
  say('✓', `package.json 已添加脚本：${added.join(', ')}`)
  return { changed: true }
}

function main() {
  if (has('--help') || has('-h')) {
    out('用法：node scripts/install-commit-tools.mjs --into <目标仓库> [--dry-run] [--force] [--no-hook]')
    return 0
  }

  const into = valueOf('--into')
  if (into === undefined || into === '') {
    out('缺少必填参数 --into <目标仓库路径>（用 --help 看用法）')
    return 1
  }

  const dryRun = has('--dry-run')
  const force = has('--force')
  const withHook = !has('--no-hook')

  const requested = resolve(into)
  if (!existsSync(requested)) {
    out(`目标不存在：${requested}`)
    return 1
  }

  const topLevel = gitOrNull(['rev-parse', '--show-toplevel'], requested)
  if (topLevel === null) {
    out(`不是 git 仓库（或不在仓库内）：${requested}`)
    return 1
  }
  if (resolve(topLevel) === resolve(join(here, '..'))) {
    out('目标是本工具链自己的仓库，无需安装。')
    return 1
  }

  out(`${dryRun ? '（dry-run，不会写入任何文件）' : ''}目标仓库：${topLevel}`)
  out('')

  // ── 1. 复制脚本 ───────────────────────────────────────────────────────────
  out('① 复制工具脚本')
  let blocked = false
  for (const item of PAYLOAD) {
    const from = join(here, item.from)
    const to = join(topLevel, item.to)
    if (!existsSync(from)) {
      say('❌', `源文件缺失：${from}`)
      blocked = true
      continue
    }
    const same = existsSync(to) && readFileSync(to, 'utf8') === readFileSync(from, 'utf8')
    if (same) {
      say('=', `${item.to} 已是最新，跳过`)
      continue
    }
    if (existsSync(to) && !force) {
      say('⚠️ ', `${item.to} 已存在且内容不同，未覆盖（要覆盖加 --force）`)
      blocked = true
      continue
    }
    if (dryRun) {
      say('→', `将会写入 ${item.to}`)
      continue
    }
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, readFileSync(from))
    if (item.executable) chmodSync(to, 0o755)
    say('✓', `写入 ${item.to}`)
  }

  // ── 2. 合并 npm 脚本 ─────────────────────────────────────────────────────
  out('')
  out('② 合并 npm 脚本（保留你原有的脚本与格式）')
  patchPackageJson(topLevel, { dryRun, force })

  // ── 3. 安装钩子 ──────────────────────────────────────────────────────────
  out('')
  out('③ 安装 commit-msg 钩子')
  if (!withHook) {
    say('=', '--no-hook：跳过（之后可在目标仓库里跑 node scripts/install-hooks.mjs 手动装）')
  } else if (blocked) {
    say('⚠️ ', '上面有未覆盖的文件，本次不改 git 配置（避免钩子指向半套脚本）')
  } else if (dryRun) {
    say('→', '将会执行 git config core.hooksPath scripts/hooks')
  } else {
    const existing = gitOrNull(['config', '--local', '--get', 'core.hooksPath'], topLevel)
    if (existing !== null && existing !== 'scripts/hooks' && !force) {
      say('⚠️ ', `目标仓库已有 core.hooksPath = ${existing}，未改动（要改写加 --force）`)
    } else {
      execFileSync('git', ['config', '--local', 'core.hooksPath', 'scripts/hooks'], { cwd: topLevel })
      chmodSync(join(topLevel, 'scripts', 'hooks', 'commit-msg'), 0o755)
      say('✓', 'core.hooksPath = scripts/hooks（仅该仓库）')
    }
  }

  // ── 4. 自检 ──────────────────────────────────────────────────────────────
  if (!dryRun && !blocked) {
    out('')
    out('④ 自检')
    const lint = join(topLevel, 'scripts', 'commit-lint.mjs')
    if (!existsSync(lint)) {
      say('⚠️ ', '目标仓库没有 scripts/commit-lint.mjs，跳过自检')
    } else {
      const sample = 'fix(demo): 验证提交信息校验是否可用'
      try {
        execFileSync('node', [lint, '--message', sample], { cwd: topLevel, stdio: ['ignore', 'ignore', 'pipe'] })
        say('✓', `校验器可用（样例：${sample}）`)
      } catch {
        say('❌', '校验器跑不通，请检查目标仓库里 Node 的可用性')
      }
    }
    const hookPath = gitOrNull(['config', '--local', '--get', 'core.hooksPath'], topLevel)
    say(hookPath === 'scripts/hooks' ? '✓' : '⚠️ ', `core.hooksPath = ${hookPath ?? '未设置'}`)
  }

  out('')
  if (dryRun) {
    out('dry-run 结束：没有写入任何文件。去掉 --dry-run 即执行。')
  } else {
    out('完成。到目标仓库里用：')
    out(`  cd ${topLevel}`)
    out('  npm run commit          # 交互式生成规范中文提交信息（pnpm/yarn 同理）')
    out('  npm run commit -- --auto   # 直接采用自动生成的草稿')
    out('  npm run commit:lint -- --message "fix: 修正…"')
    out('  git commit --no-verify  # 临时绕过校验')
  }
  return blocked && !force ? 2 : 0
}

process.exitCode = main()
