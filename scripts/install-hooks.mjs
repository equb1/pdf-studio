#!/usr/bin/env node
/**
 * 安装 / 卸载提交信息钩子。
 *
 * 不做"把文件复制进 .git/hooks"这套——那种装法在别人克隆、或 .git 被重建后就悄悄失效了。
 * 这里用 `git config core.hooksPath scripts/hooks`：配置随仓库走（写进 .git/config），
 * 钩子本体在版本控制里可评审，升级只需改代码，不用重装。
 *
 * 用法：
 *   node scripts/install-hooks.mjs                 # 本仓库安装（默认）
 *   node scripts/install-hooks.mjs --check         # 只看当前状态
 *   node scripts/install-hooks.mjs --uninstall     # 撤销
 *   node scripts/install-hooks.mjs --global        # 装到全局（影响你所有仓库，慎用）
 *
 * @module dsh-pdf-studio/scripts/install-hooks
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hooksDir = resolve(here, 'hooks')
const args = process.argv.slice(2)
const scope = args.includes('--global') ? '--global' : '--local'

const git = (gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8' }).trim()
const tryGit = (gitArgs) => {
  try {
    return git(gitArgs)
  } catch {
    return ''
  }
}

/** 检查项：钩子文件是否在、有无可执行位、git 配置指向哪里。 */
function status() {
  const hookPath = join(hooksDir, 'commit-msg')
  const configured = tryGit(['config', scope === '--global' ? '--global' : '--local', '--get', 'core.hooksPath'])
  const executable = existsSync(hookPath) && (statSync(hookPath).mode & 0o111) !== 0
  const effective = tryGit(['config', '--get', 'core.hooksPath'])
  return { hookPath, configured, executable, effective }
}

function report() {
  const { hookPath, configured, executable, effective } = status()
  process.stdout.write(`钩子脚本：${hookPath}（${existsSync(hookPath) ? '存在' : '缺失'}${executable ? '，可执行' : '，缺少可执行位'}）\n`)
  process.stdout.write(`core.hooksPath（本仓库实际生效值）：${effective === '' ? '（未设置，用默认 .git/hooks）' : effective}\n`)
  const ok = effective.endsWith('scripts/hooks') && executable
  process.stdout.write(ok ? '✅ 提交信息校验已启用\n' : '⚠️  提交信息校验未启用\n')
  return ok
}

function main() {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('用法：node scripts/install-hooks.mjs [--check|--uninstall|--global]\n')
    return 0
  }

  if (args.includes('--check')) {
    return report() ? 0 : 1
  }

  if (args.includes('--uninstall')) {
    tryGit(['config', scope, '--unset', 'core.hooksPath'])
    process.stdout.write('已撤销 core.hooksPath（提交信息不再被校验）\n')
    return 0
  }

  if (!existsSync(join(hooksDir, 'commit-msg'))) {
    process.stdout.write(`找不到钩子脚本：${join(hooksDir, 'commit-msg')}\n`)
    return 1
  }
  // Git 要求钩子可执行；从压缩包/跨平台复制过来的文件常常丢掉这个位。
  chmodSync(join(hooksDir, 'commit-msg'), 0o755)

  if (scope === '--global') {
    process.stdout.write(
      '⚠️  --global：core.hooksPath 将作用于你所有的仓库。其它仓库若没有 scripts/commit-lint.mjs，\n'
      + '    钩子会打印警告并放行（不会误拦）。确认要继续？[y/N] ',
    )
    const answer = execFileSync('sh', ['-c', 'read -r line; echo "$line"'], { encoding: 'utf8' }).trim().toLowerCase()
    if (answer !== 'y' && answer !== 'yes') {
      process.stdout.write('已取消。\n')
      return 0
    }
  }

  git(['config', scope, 'core.hooksPath', scope === '--global' ? hooksDir : 'scripts/hooks'])
  const ok = report()
  if (ok) {
    process.stdout.write('\n之后提交时：\n')
    process.stdout.write('  npm run commit        交互式生成规范中文提交信息\n')
    process.stdout.write('  npm run commit:lint   只校验一条消息\n')
    process.stdout.write('  git commit --no-verify  临时绕过（例如导入外部历史）\n')
  }
  return ok ? 0 : 1
}

process.exitCode = main()
