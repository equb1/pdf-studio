/**
 * 提交工具测试：自动草稿的推断优先级 + 空话标题/scope 一致性规则。
 *
 * 背景（真实踩坑）：旧实现按**文件个数**投票推 scope，于是"src 里新增 1000 行核心模块 +
 * 顺手改了几个 test/docs"被写成 `feat(test): 新增 7 个文件`，历史里留下 3 条误导性消息。
 * 这份测试锁住修复后的行为：
 *
 * 1. `buildSuggestion({ runGit })` 以"路径层 + 变更行数"定主导模块，src/** 优先于 test/docs；
 * 2. `lintMessage(text, { stagedPaths })` 的 R1（空话标题）与 R2（scope 与暂存区不一致）能拦住那三条历史坏消息；
 * 3. 推断不出有意义标题时（只改了图片/夹具）不编标题：`--auto` 报错退出，显式 `--subject` 正常。
 *
 * **所有 git 操作都在 `os.tmpdir()` 的临时仓库里做**：本仓库只被读取（`git show` 取历史文件名），
 * 绝不 `git add` / `git commit`。
 *
 * Run: node test/commit-tools.test.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintMessage } from '../scripts/commit-lint.mjs'
import { buildSuggestion } from '../scripts/commit-suggest.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPTS_DIR = fileURLToPath(new URL('../scripts', import.meta.url))

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

/** 一个最小的 PNG（含 NUL 字节，git 会当二进制处理）。 */
const BINARY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x00,
])

/* ── 临时仓库工具 ─────────────────────────────────────────────────────────── */

const created = []

/** 在 os.tmpdir() 里建一个临时 git 仓库（不加载任何钩子）。 */
function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-commit-tools-${label}-`))
  created.push(dir)
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  run(['init', '-q'])
  run(['config', 'user.email', 'commit-tools@example.com'])
  run(['config', 'user.name', '提交工具测试'])
  // 指到一个不存在的目录：临时仓库里绝不跑本仓库的 commit-msg 钩子。
  run(['config', 'core.hooksPath', join(dir, '.no-hooks')])
  return { dir, run }
}

const gitIn = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** 注入 runGit：buildSuggestion 的全部 git 读取都发生在临时仓库里。 */
const suggestIn = (dir, options = {}) => buildSuggestion({ runGit: (args) => gitIn(dir, args), ...options })

const stagedPathsIn = (dir) =>
  gitIn(dir, ['diff', '--cached', '--name-only']).split('\n').map(line => line.trim()).filter(line => line !== '')

/** 写一个 n 行的文本文件（内容是占位行，避免制造一堆 export 符号）。 */
function writeLines(dir, path, count, tag = '// 占位行') {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), Array.from({ length: count }, (_, i) => `${tag} ${i}`).join('\n') + '\n')
}

function writeBinary(dir, path, bytes) {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), bytes)
}

/** 从本仓库历史里读某次提交改过的文件（读不到就用 fallback，保证测试可独立运行）。 */
function pathsOfCommit(sha, fallback) {
  try {
    const raw = execFileSync('git', ['-C', REPO_ROOT, 'show', '--name-only', '--format=', sha], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const paths = raw.split('\n').map(line => line.trim()).filter(line => line !== '')
    return paths.length > 0 ? paths : fallback
  } catch {
    return fallback
  }
}

try {
  /* ── 用例 1：src 核心模块 + test + README → scope 必须来自 src ───────────── */
  {
    const { dir, run } = makeRepo('case1')
    writeLines(dir, 'README.md', 3)
    run(['add', '-A'])
    run(['commit', '-qm', '初始化'])

    writeLines(dir, 'src/core/page-assembly.ts', 400)
    writeLines(dir, 'test/page-assembly.test.mjs', 120)
    writeLines(dir, 'README.md', 30)
    run(['add', '-A'])

    const suggestion = suggestIn(dir)
    check('用例1：scope 来自改动最大的 src 模块', suggestion.scope === 'page-assembly', `scope=${suggestion.scope}`)
    check('用例1：scope 不是 test/docs', suggestion.scope !== 'test' && suggestion.scope !== 'docs', `scope=${suggestion.scope}`)
    check('用例1：type 是 feat（主导模块是新增）', suggestion.type === 'feat', `type=${suggestion.type}`)
    check('用例1：标题是"动词 + 模块中文名 + 能力"', suggestion.subject === '新增页级装配能力', suggestion.subject)
    check('用例1：标题不含"N 个文件"', !/个文件/.test(suggestion.subject), suggestion.subject)
    check('用例1：body 明确列出主导模块', /主导模块：页级装配（src\/core\/page-assembly\.ts/.test(suggestion.body),
      suggestion.body.split('\n')[0])
    check('用例1：body 保留"改动规模：N 个文件，+X/-Y 行"', /改动规模：3 个文件，\+\d+ \/ -\d+ 行/.test(suggestion.body))
    check('用例1：body 保留文件清单', /新增：src\/core\/page-assembly\.ts、test\/page-assembly\.test\.mjs/.test(suggestion.body))

    const result = lintMessage(`${suggestion.type}(${suggestion.scope}): ${suggestion.subject}`, {
      stagedPaths: stagedPathsIn(dir),
    })
    check('用例1：生成的标题通过 lint（钩子与助手同一套规则）', result.ok, result.errors.join('；'))
  }

  /* ── 用例 2：fonts + line-redraw + test/support → scope 不得是 test ──────── */
  {
    const { dir, run } = makeRepo('case2')
    writeLines(dir, 'src/core/line-redraw.ts', 5)
    run(['add', '-A'])
    run(['commit', '-qm', '初始化'])

    writeLines(dir, 'src/core/fonts.ts', 109)
    writeLines(dir, 'src/core/line-redraw.ts', 216)
    writeLines(dir, 'test/support/render-ink.mjs', 73)
    run(['add', '-A'])

    const suggestion = suggestIn(dir)
    check('用例2：scope 是改动行数最多的 src 模块（line-redraw），不是 test',
      suggestion.scope === 'line-redraw', `scope=${suggestion.scope}`)
    check('用例2：scope 不是 test', suggestion.scope !== 'test', `scope=${suggestion.scope}`)
    check('用例2：标题写"增强整行重绘"', suggestion.subject === '增强整行重绘', suggestion.subject)
    check('用例2：type 是 feat', suggestion.type === 'feat', `type=${suggestion.type}`)
    check('用例2：body 主导模块是整行重绘', /主导模块：整行重绘（src\/core\/line-redraw\.ts/.test(suggestion.body),
      suggestion.body.split('\n')[0])
  }

  /* ── 用例 3：只改 docs → type=docs、scope 省略（不产出 docs(docs)）───────── */
  {
    const { dir, run } = makeRepo('case3')
    writeLines(dir, 'docs/PROMPTING.md', 20)
    run(['add', '-A'])

    const suggestion = suggestIn(dir)
    check('用例3：只改 docs 时 type=docs', suggestion.type === 'docs', `type=${suggestion.type}`)
    check('用例3：scope 不重复成 docs（type/scope 不同时是 docs）',
      suggestion.scope !== 'docs', `scope=${JSON.stringify(suggestion.scope)}`)
    check('用例3：标题说明改了哪个文档', suggestion.subject === '新增PROMPTING文档', suggestion.subject)

    const header = `${suggestion.type}${suggestion.scope === '' ? '' : `(${suggestion.scope})`}: ${suggestion.subject}`
    const result = lintMessage(header, { stagedPaths: stagedPathsIn(dir) })
    check('用例3：纯 docs 提交正常放行（R2 不误伤）', result.ok, result.errors.join('；'))
  }

  /* ── 用例 4：只改 test/*.mjs → type=test、scope 省略（不产出 test(test)）── */
  {
    const { dir, run } = makeRepo('case4')
    writeLines(dir, 'test/watermark.test.mjs', 40)
    run(['add', '-A'])

    const suggestion = suggestIn(dir)
    check('用例4：只改 test 时 type=test', suggestion.type === 'test', `type=${suggestion.type}`)
    check('用例4：不产出 test(test)（scope 与 type 相同时省略）',
      suggestion.scope !== 'test', `scope=${JSON.stringify(suggestion.scope)}`)
    check('用例4：标题点出模块（水印）', suggestion.subject === '新增水印测试', suggestion.subject)

    const header = `${suggestion.type}${suggestion.scope === '' ? '' : `(${suggestion.scope})`}: ${suggestion.subject}`
    const result = lintMessage(header, { stagedPaths: stagedPathsIn(dir) })
    check('用例4：纯 test 提交正常放行（R2 不误伤）', result.ok, result.errors.join('；'))
  }

  /* ── 用例 5：纯夹具/图片改动 → 不编标题；--auto 非 0 且不产生提交 ────────── */
  {
    const { dir, run } = makeRepo('case5')
    // 复现 1 的关键：这个"PNG"没有 NUL 字节，git 当文本给出 numstat（3 0），
    // 光看 `binary` 标记拦不住，必须按 test/fixtures/** 与二进制扩展名一起排除。
    mkdirSync(join(dir, 'test/fixtures'), { recursive: true })
    writeFileSync(join(dir, 'test/fixtures/a.png'), '\x89PNG\r\n\x1a\nbinary')
    writeBinary(dir, 'test/fixtures/b.png', BINARY_PNG)
    run(['add', '-A'])

    const numstat = gitIn(dir, ['diff', '--cached', '--numstat'])
    check('用例5：前置条件成立（夹具被 git 当文本、有行数）',
      /^3\t0\ttest\/fixtures\/a\.png/m.test(numstat), numstat.trim().replace(/\n/g, ' ｜ '))

    const suggestion = suggestIn(dir)
    check('用例5：纯夹具不参与标题推断，返回"推断不出"（不编空话）',
      suggestion.inscrutable === true && suggestion.subject === '',
      `inscrutable=${suggestion.inscrutable} subject=${JSON.stringify(suggestion.subject)}`)
    check('用例5：中文原因点出二进制/夹具', /二进制|夹具/.test(suggestion.reason ?? ''), suggestion.reason)

    const auto = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'commit.mjs'), '--auto'], { cwd: dir, encoding: 'utf8' })
    const autoOutput = `${auto.stdout ?? ''}${auto.stderr ?? ''}`
    check('用例5：--auto 走"无法推断"分支并非 0 退出', auto.status !== 0, `status=${auto.status}`)
    check('用例5：报错提示"无法从暂存区推断有意义的提交标题"', autoOutput.includes('无法从暂存区推断有意义的提交标题'),
      autoOutput.trim().split('\n').slice(0, 2).join(' / '))
    check('用例5：报错提示要求显式 --subject', autoOutput.includes('--subject'), '（应出现 --subject 示例）')
    const head = (() => {
      try {
        return gitIn(dir, ['rev-parse', '--verify', 'HEAD']).trim()
      } catch {
        return ''
      }
    })()
    check('用例5：--auto 没有产生任何提交（不再把垃圾标题提交进去）', head === '', `HEAD=${head === '' ? '（不存在）' : head}`)

    const explicit = spawnSync(
      process.execPath,
      [join(SCRIPTS_DIR, 'commit.mjs'), '--type', 'feat', '--scope', 'test', '--subject', '新增测试夹具', '--print'],
      { cwd: dir, encoding: 'utf8' },
    )
    const explicitOutput = `${explicit.stdout ?? ''}${explicit.stderr ?? ''}`
    check('用例5：显式 --subject 时正常（--print 退出 0）', explicit.status === 0, `status=${explicit.status} ${explicitOutput.slice(-160)}`)
    check('用例5：显式标题原样保留', explicitOutput.includes('feat(test): 新增测试夹具'), '')
  }

  /* ── 用例 6：R1/R2 拦住三条历史坏消息，合规消息通过 ──────────────────────── */
  {
    const history = [
      {
        sha: '6d31e3a',
        message: 'feat(test): 新增 7 个文件',
        rule: 'R1',
        fallback: [
          'AGENTS.md', 'README.md', 'docs/PROMPTING.md', 'package.json', 'public/app.js',
          'src/core/confirmation.ts', 'src/core/font-map.ts', 'src/core/line-redraw.ts', 'src/core/text-editor.ts',
          'src/host/engine.ts', 'src/host/routes.ts', 'src/host/tools.ts', 'src/index.ts',
          'test/canvas-ui.test.mjs', 'test/confirm-ui.test.mjs', 'test/confirmation.test.mjs',
          'test/line-redraw.test.mjs', 'test/plugin-wiring.test.mjs', 'test/tools.test.mjs',
        ],
      },
      {
        sha: '6e14486',
        message: 'feat(docs): 新增 render-ink',
        rule: 'R2',
        fallback: [
          'AGENTS.md', 'README.md', 'docs/PROMPTING.md',
          'src/core/fonts.ts', 'src/core/line-redraw.ts', 'src/host/tools.ts',
          'test/line-redraw.test.mjs', 'test/support/render-ink.mjs',
        ],
      },
      {
        sha: '1495821',
        message: 'feat(test): 新增 3 个文件',
        rule: 'R1',
        fallback: [
          'AGENTS.md', 'README.md', 'docs/PROMPTING.md', 'package.json',
          'src/core/confirmation.ts', 'src/core/page-assembly.ts', 'src/core/watermark.ts',
          'src/host/tools.ts', 'src/index.ts',
          'test/confirmation.test.mjs', 'test/fixtures/make-fixtures.mjs', 'test/line-redraw.test.mjs',
          'test/page-assembly.test.mjs', 'test/plugin-wiring.test.mjs', 'test/support/render-diff.mjs',
          'test/tools.test.mjs', 'test/watermark.test.mjs',
        ],
      },
    ]

    for (const item of history) {
      const stagedPaths = pathsOfCommit(item.sha, item.fallback)
      const result = lintMessage(item.message, { stagedPaths })
      const why = result.errors.join(' ｜ ')
      check(`用例6：历史坏消息「${item.message}」（${item.sha}）被拒绝`, result.ok === false, why)
      check(`用例6：「${item.message}」命中 ${item.rule}`,
        item.rule === 'R1'
          ? result.errors.some(error => /只有文件计数/.test(error))
          : result.errors.some(error => /标题会误导读者/.test(error)),
        why)
    }

    const pageAssemblyPaths = pathsOfCommit('1495821', [])
    const compliant = lintMessage('feat(page-assembly): 新增页级装配能力', { stagedPaths: pageAssemblyPaths })
    check('用例6：合规消息「feat(page-assembly): 新增页级装配能力」通过', compliant.ok === true,
      compliant.errors.join('；'))

    const informative = lintMessage('feat(watermark): 新增 3 个水印检测规则', { stagedPaths: ['src/core/watermark.ts'] })
    check('用例6：有实质名词的标题（新增 3 个水印检测规则）不被 R1 误伤', informative.ok === true,
      informative.errors.join('；'))

    const srcScope = lintMessage('fix(watermark): 修正居中定位', { stagedPaths: ['src/core/watermark.ts', 'test/watermark.test.mjs'] })
    check('用例6：src 改动配 src 模块 scope 时 R2 不误伤', srcScope.ok === true, srcScope.errors.join('；'))

    const pureTest = lintMessage('test: 补充页级装配用例', { stagedPaths: ['test/page-assembly.test.mjs'] })
    check('用例6：纯 test 暂存区不误伤 test', pureTest.ok === true, pureTest.errors.join('；'))

    const pureDocs = lintMessage('docs: 调整PROMPTING文档', { stagedPaths: ['docs/PROMPTING.md'] })
    check('用例6：纯 docs 暂存区不误伤 docs', pureDocs.ok === true, pureDocs.errors.join('；'))
  }

  /* ── 用例 7：裸 `--staged` 必须自动读暂存区，不能静默放行 ────────────────── */
  {
    const { dir, run } = makeRepo('case7')
    writeLines(dir, 'src/core/watermark.ts', 5)
    writeLines(dir, 'test/w.test.mjs', 2)
    run(['add', '-A'])

    const bad = 'feat(docs): 新增 render-ink' // R2 该拦：暂存区有 src，scope 是 docs
    const lint = (...args) => spawnSync(
      process.execPath,
      [join(SCRIPTS_DIR, 'commit-lint.mjs'), ...args],
      { cwd: dir, encoding: 'utf8' },
    )

    const noFlag = lint('--message', bad)
    check('用例7：不给 --staged（自动读暂存区）→ exit 1', noFlag.status === 1, `status=${noFlag.status}`)

    const bare = lint('--message', bad, '--staged')
    check('用例7：裸 --staged（后面没有值）→ 自动读暂存区，exit 1', bare.status === 1, `status=${bare.status}`)

    const bareBeforeOption = lint('--staged', '--message', bad)
    check('用例7：裸 --staged 后面紧跟另一个选项 → 也自动读暂存区，exit 1',
      bareBeforeOption.status === 1, `status=${bareBeforeOption.status}`)

    const explicitComma = lint('--message', bad, '--staged', 'src/core/watermark.ts,test/w.test.mjs')
    check('用例7：显式 --staged（逗号分隔）→ exit 1', explicitComma.status === 1, `status=${explicitComma.status}`)

    const explicitSpace = lint('--message', bad, '--staged', 'src/core/watermark.ts test/w.test.mjs')
    check('用例7：显式 --staged（空格分隔）→ exit 1', explicitSpace.status === 1, `status=${explicitSpace.status}`)

    const inlineEmpty = lint('--message', bad, '--staged=')
    check('用例7：--staged=（空值）→ 自动读暂存区，exit 1', inlineEmpty.status === 1, `status=${inlineEmpty.status}`)

    // 反向对照：显式给"只有 docs"的列表时 R2 不该命中（证明上面的 1 确实来自暂存区内容）。
    const docsOnly = lint('--message', bad, '--staged', 'docs/PROMPTING.md')
    check('用例7：反向对照——显式只给 docs 路径时 R2 不命中（exit 0）', docsOnly.status === 0, `status=${docsOnly.status}`)
  }

  /* ── 用例 8：R3 拒绝文件名碎片标题；生成器也不产出这种标题 ──────────────── */
  {
    for (const message of ['feat(test): 新增a测试', 'docs: 新增foo文档', 'chore: 删除ab脚本']) {
      const result = lintMessage(message)
      check(`用例8：碎片标题「${message}」被 R3 拒绝`,
        result.ok === false && result.errors.some(error => /文件名碎片/.test(error)),
        result.errors.join('；') || '（竟然通过了）')
    }

    for (const message of ['feat(page-assembly): 新增页级装配能力', 'fix(watermark): 新增水印识别规则', 'docs: 新增OCR文档']) {
      const result = lintMessage(message)
      check(`用例8：正常标题「${message}」不被 R3 误伤`, result.ok === true, result.errors.join('；'))
    }

    // 生成器侧：模块名太短时用层的通称兜底，绝不产出会被 R3 拒绝的标题。
    const { dir, run } = makeRepo('case8')
    writeLines(dir, 'test/a.test.mjs', 30)
    run(['add', '-A'])
    const suggestion = suggestIn(dir)
    check('用例8：短模块名不再拼出 `新增a测试`', suggestion.subject !== '新增a测试', suggestion.subject)
    check('用例8：短模块名改用通称（新增测试用例）', suggestion.subject === '新增测试用例', suggestion.subject)
    const header = `${suggestion.type}${suggestion.scope === '' ? '' : `(${suggestion.scope})`}: ${suggestion.subject}`
    const result = lintMessage(header, { stagedPaths: stagedPathsIn(dir) })
    check('用例8：生成器给出的标题永远能过自己的 lint', result.ok === true, result.errors.join('；'))
    check('用例8：短模块名场景 type/scope 不重复', !(suggestion.type === 'test' && suggestion.scope === 'test'),
      `type=${suggestion.type} scope=${JSON.stringify(suggestion.scope)}`)
  }
} finally {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'ALL COMMIT-TOOLS CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
