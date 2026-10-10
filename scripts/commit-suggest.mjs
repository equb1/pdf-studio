#!/usr/bin/env node
/**
 * 根据暂存区改动，自动生成一份**中文 Conventional Commits 草稿**。
 *
 * ## 为什么重写（2025 修复"自动草稿与实际改动不符"）
 *
 * 旧实现按**文件个数**投票推断 type/scope：`src/core/line-redraw.ts`（1086 行新增）
 * 加上几个 `test/*.mjs`，票数会被 test 抢走，于是生成 `feat(test): 新增 7 个文件`——
 * 与实际改动完全不符。现在改为：
 *
 * 1. **先定路径层，再定模块**：`src/** > public/** > scripts/** > 配置 > test/** > docs/**`
 *    是**有序**优先级而不是投票；只要暂存区里有 src/public 改动，test/docs 就不可能当 scope。
 * 2. **层内按"变更行数"挑主导模块**（不是文件个数）：`src/core/<模块>.ts` / `src/host/<模块>.ts`
 *    取模块名当 scope，并用中文模块名表生成可读标题。
 * 3. **标题 = 动词 + 模块中文名 + 能力**（`新增页级装配能力`、`增强整行重绘`），
 *    永远不会退化成 `更新 N 个文件` 这种空话：推断不出有意义的主语时返回 `inscrutable: true`，
 *    由 `scripts/commit.mjs` 报错要求显式 `--subject`（见 commit.mjs 的提示文案）。
 * 4. **可测**：纯逻辑导出且 `runGit` 可注入（`buildSuggestion({ runGit })`），CLI 只是薄壳，
 *    `test/commit-tools.test.mjs` 在 `os.tmpdir()` 的临时仓库里端到端验证。
 *
 * ## 两种模式
 *
 * 1. **离线规则模式（默认，不需要任何 API/网络）**：读 `git diff --cached`。
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

/** 默认的 git 执行器：返回 stdout（不 trim，交给调用方解析）。 */
const defaultRunGit = (args) => execFileSync('git', args, {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
})

/** 截断列表，避免标题/正文单行过长。 */
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

/* ── 路径分层：有序优先级，不是按文件个数投票 ─────────────────────────────── */

const CONFIG_RE = /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.gitignore|\.npmrc|cordis\.patch\.yml|tsconfig(\.[^/]*)?\.json)$/
const DOCS_RE = /^(README|AGENTS|GEMINI|CHANGES)(\.[^/]*)?$|^docs\/|\.md$/

/**
 * 分层表：`rank` 越大越主导。决定顺位时先比 rank（严格有序），
 * 同一层内再按变更行数挑模块 —— 所以"src 核心模块 + 顺手改的 test/docs"永远是 src 说了算。
 */
const TIERS = [
  { id: 'src', rank: 5, match: /^src\// },
  { id: 'public', rank: 4, match: /^public\// },
  { id: 'scripts', rank: 3, match: /^scripts\// },
  { id: 'config', rank: 2, match: path => CONFIG_RE.test(path) },
  { id: 'test', rank: 1, match: /^test\// },
  { id: 'docs', rank: 0, match: path => DOCS_RE.test(path) },
]

const RANK = new Map(TIERS.map(tier => [tier.id, tier.rank]))

/** 单个路径 → 所属层（认不出来就是 `other`，会被判为"推断不出"）。 */
function tierOf(path) {
  for (const tier of TIERS) {
    if (typeof tier.match === 'function' ? tier.match(path) : tier.match.test(path)) return tier.id
  }
  return 'other'
}

/**
 * 中文模块名表：只收录本项目里语义明确的模块，**没收录就用模块名本身**（别编）。
 * 键是 `src/core/<模块>.ts` / `src/host/<模块>.ts` 的模块名（去扩展名）。
 */
export const MODULE_CN = {
  'page-assembly': '页级装配',
  'line-redraw': '整行重绘',
  watermark: '水印',
  confirmation: '执行前确认',
  'text-editor': '文本改写',
  fonts: '字体',
  ocr: 'OCR',
  'searchable-pdf': '可搜索化',
  routes: '接口路由',
  tools: '助手工具',
  index: '插件装配',
  triage: '分诊',
  'content-stream': '内容流',
  coords: '坐标换算',
}

/** 取模块名：去掉扩展名；测试文件再去掉 `.test`，让 `page-assembly.test.mjs` → `page-assembly`。 */
function moduleOf(path, tier) {
  const base = basename(path)
  let name = base.replace(/\.[^.]+$/, '')
  if (tier === 'test') name = name.replace(/\.test$/, '')
  return name === '' ? base : name
}

/**
 * 二进制/资源类扩展名：即使 `numstat` 给了数字（小文件会被 git 当文本，例如
 * `printf '\x89PNG\r\n\x1a\nbinary' > test/fixtures/a.png` 的 numstat 是 `3 0`），
 * 也不拿它当标题素材 —— 否则会拼出 `新增a测试` 这种从文件名碎片编出来的标题。
 */
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'ico', 'pdf', 'zip', 'dmg',
  '7z', 'gz', 'tar', 'exe', 'so', 'dylib', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'mov',
])

const extOf = (path) => (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase()

/**
 * 能不能拿这次改动当**标题素材**（决定 scope/动词/标题的那批文件）。
 *
 * 排除：numstat 为 `-` 的真二进制、`test/fixtures/**` 里的夹具、以及二进制扩展名。
 * 全被排除时 `buildSuggestion` 返回 `inscrutable`（不编标题），由 commit.mjs 报错要求显式 `--subject`。
 */
function isTitleMaterial(record) {
  if (record.binary) return false
  if (record.path.startsWith('test/fixtures/')) return false
  if (BINARY_EXT.has(extOf(record.path))) return false
  return true
}

/** 太短的拉丁词干（`a`、`foo`、`ab1`）不是可读的模块名；全大写缩写（OCR/PDF）除外。 */
const WEAK_MODULE = /^[A-Za-z0-9_-]{1,3}$/
const isWeakModuleName = (name) => WEAK_MODULE.test(name) && !/^[A-Z]{2,3}$/.test(name)

const cnOf = (module) => MODULE_CN[module] ?? module

/**
 * 动词 + 能力短语 → 标题。能力短语按层给，保证标题里**有实质名词**。
 * 例：`新增页级装配能力`、`增强整行重绘`、`新增页级装配测试`、`调整PROMPTING文档`。
 *
 * 模块名太短（`a`、`foo`）且该层会拼出 `…测试/…文档/…脚本/…资源` 时，退回层的通称 ——
 * 不然会产出 `新增a测试` 这种"从文件名碎片编出来"的标题（也会被 lint 的 R3 拒绝）。
 */
function capabilityOf(tier, module, verb) {
  const weak = isWeakModuleName(module)
  const cn = cnOf(module)
  switch (tier) {
    case 'src':
      return verb === '新增' ? `${cn}能力` : cn
    case 'public':
      return weak ? '前端资源' : `${cn}资源`
    case 'scripts':
      return weak ? '工具脚本' : `${cn}脚本`
    case 'config':
      return '构建配置'
    case 'test':
      return weak ? '测试用例' : `${cn}测试`
    case 'docs':
      return weak ? '文档说明' : `${cn}文档`
    default:
      return cn
  }
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

/** 解析 `--name-status` 输出（重命名取新路径）。 */
function nameStatus(runGit) {
  const raw = runGit(['diff', '--cached', '--name-status'])
  const entries = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    const status = parts[0][0]
    const path = status === 'R' ? parts[2] : parts[parts.length - 1]
    entries.push({ status, path, from: status === 'R' ? parts[1] : undefined })
  }
  return entries
}

/**
 * 解析 `--numstat -z` 输出 → `Map<新路径, { added, removed, binary }>`。
 *
 * `-z` 下重命名是 `added\tdeleted\t\0旧路径\0新路径\0`，所以空路径后面要再读两个 token。
 * 二进制文件是 `-\t-\t路径`（行数为 0），这正是"纯图片/夹具改动推断不出标题"的判据。
 */
function numstatMap(runGit) {
  const raw = runGit(['diff', '--cached', '--numstat', '-z'])
  const map = new Map()
  const tokens = raw.split('\0')
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '') continue
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token)
    if (match === null) continue
    const binary = match[1] === '-'
    let path = match[3]
    if (path === '') {
      // 重命名：跳过旧路径，取新路径。
      path = tokens[i + 2] ?? tokens[i + 1] ?? ''
      i += 2
    }
    map.set(path, {
      added: match[1] === '-' ? 0 : Number(match[1]),
      removed: match[2] === '-' ? 0 : Number(match[2]),
      binary,
    })
  }
  return map
}

/**
 * 生成草稿。返回 `{ type, scope, subject, body, source }`。
 *
 * `runGit(args) -> stdout` 可注入，便于测试在临时仓库里跑（默认走真实 git）。
 * `typeHint` 是用户显式传的 `--type`：显式参数优先，推断只负责把标题写顺（例如 fix → `修正…`）。
 *
 * 推断不出有意义的主语时返回 `{ inscrutable: true, reason }` 且 `subject` 为空，
 * 由调用方决定报错还是让用户自己写（**绝不退回 `更新 N 个文件` 这种空话**）。
 */
export function buildSuggestion({ runGit = defaultRunGit, typeHint = '' } = {}) {
  const entries = nameStatus(runGit)
  if (entries.length === 0) {
    return { type: '', scope: '', subject: '', body: '', source: 'rules', empty: true }
  }

  const files = entries.map(entry => entry.path)
  const numstat = numstatMap(runGit)
  const diff = runGit(['diff', '--cached'])
  const stats = lineStats(diff)

  const records = entries.map(entry => {
    const tier = tierOf(entry.path)
    const stat = numstat.get(entry.path) ?? { added: 0, removed: 0, binary: false }
    return {
      ...entry,
      tier,
      module: moduleOf(entry.path, tier),
      added: stat.added,
      removed: stat.removed,
      binary: stat.binary,
      weight: stat.added + stat.removed,
    }
  })

  // ── 标题素材：二进制 / 测试夹具不参与"推断改了什么" ────────────────────
  // （小图片会被 git 当文本给出 numstat 数字，所以除了 `binary`，还要按路径与扩展名排除。）
  const material = records.filter(isTitleMaterial)
  const excluded = records.filter(record => !isTitleMaterial(record))
  if (material.length === 0) {
    return inscrutable(
      files,
      `暂存区只有二进制文件或测试夹具（${listOf(excluded.map(record => record.path), 3)}），看不出改了什么`,
    )
  }

  // ── 主导层：严格按 rank 取最高层（同层内才比行数）──────────────────────
  const knownTiers = [...new Set(material.map(record => record.tier))].filter(tier => tier !== 'other')
  if (knownTiers.length === 0) {
    return inscrutable(files, '暂存区只有无法识别的路径（既不是 src/public，也不是 test/docs 或配置）')
  }
  const dominantTier = knownTiers.sort((a, b) => RANK.get(b) - RANK.get(a))[0]

  // ── 主导模块：同层内按**变更行数**挑，不看文件个数 ─────────────────────
  const inTier = material.filter(record => record.tier === dominantTier)
  const byModule = new Map()
  for (const record of inTier) {
    const bucket = byModule.get(record.module) ?? { name: record.module, weight: 0, files: [], records: [] }
    bucket.weight += record.weight
    bucket.files.push(record.path)
    bucket.records.push(record)
    byModule.set(record.module, bucket)
  }
  // 行数相同时按路径字典序，保证结果稳定可测。
  const dominant = [...byModule.values()].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))[0]
  if (dominant.weight === 0) {
    return inscrutable(
      files,
      `主导改动（${dominant.files.join('、')}）没有可统计的文本改动（纯重命名/改权限？），看不出改了什么`,
    )
  }

  // ── 动词：按变更性质选，保持诚实 ───────────────────────────────────────
  const addedFiles = dominant.records.filter(record => record.status === 'A')
  const modifiedFiles = dominant.records.filter(record => record.status === 'M')
  const deletedFiles = dominant.records.filter(record => record.status === 'D')
  const netAdded = dominant.records.reduce((sum, record) => sum + record.added, 0)
  const netRemoved = dominant.records.reduce((sum, record) => sum + record.removed, 0)

  let verb
  if (addedFiles.length > 0 && modifiedFiles.length === 0 && deletedFiles.length === 0) verb = '新增'
  else if (netRemoved > netAdded) verb = '精简'
  else if (netAdded > netRemoved) verb = '增强'
  else verb = '调整'
  // 用户显式声明这是 fix 时，标题跟着写"修正"（显式参数优先于推断）。
  if (typeHint === 'fix' && verb !== '新增' && verb !== '精简') verb = '修正'

  // ── type：整套都是 test/docs/scripts+配置 时按目录给，否则由动词决定 ────
  // 判定用**分层结果**（而不是正则），这样 `src/core/xxx.md` 仍算 src，不会把 type 写成 docs。
  const tiers = material.map(record => record.tier)
  let type
  if (tiers.every(tier => tier === 'test')) type = 'test'
  else if (tiers.every(tier => tier === 'docs')) type = 'docs'
  else if (tiers.every(tier => tier === 'scripts' || tier === 'config')) type = 'build'
  else if (typeHint !== '') type = typeHint
  else if (verb === '新增' || verb === '增强') type = 'feat'
  else if (verb === '精简') type = 'refactor'
  else type = 'fix'

  // ── scope：src/public 取模块名；test/docs/scripts/config 用目录名 ──────
  let scope = dominantTier === 'src' || dominantTier === 'public'
    ? dominant.name
    : dominantTier === 'config' ? 'build' : dominantTier
  // `test(test): …` / `docs(docs): …` / `build(build): …` 是重复的废话：scope 与 type 相同时省略 scope。
  if (scope === type) scope = ''

  let subject = verb + capabilityOf(dominantTier, dominant.name, verb)
  // 标题别超长：先去掉"能力/测试/脚本/文档/资源"这类后缀（**不退回文件计数**）。
  if (`${type}${scope === '' ? '' : `(${scope})`}: ${subject}`.length > 72) {
    const shorter = verb + cnOf(dominant.name)
    if (shorter !== subject) subject = shorter
  }

  // ── 正文：保留规模与文件清单，并明确列出主导模块 ────────────────────────
  const added = entries.filter(entry => entry.status === 'A').map(entry => entry.path)
  const deleted = entries.filter(entry => entry.status === 'D').map(entry => entry.path)
  const renamed = entries.filter(entry => entry.status === 'R')
  const modified = entries.filter(entry => entry.status === 'M').map(entry => entry.path)

  const bodyLines = [`主导模块：${cnOf(dominant.name)}（${listOf(dominant.files, 3)}，+${netAdded} / -${netRemoved} 行）`]
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

  return { type, scope, subject, body: bodyLines.join('\n'), source: 'rules' }
}

/** 推断不出有意义主语的统一返回：**不编标题**。 */
function inscrutable(files, reason) {
  return {
    type: '',
    scope: '',
    subject: '',
    body: '',
    source: 'rules',
    inscrutable: true,
    reason,
    files,
  }
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
export function buildAiSuggestion({ runGit = defaultRunGit } = {}) {
  const command = process.env.COMMIT_MSG_AI_CMD
  if (command === undefined || command.trim() === '') return undefined

  const stat = runGit(['diff', '--cached', '--stat'])
  let patch = runGit(['diff', '--cached'])
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
      + '  按"路径层 + 变更行数"推断主导模块，生成中文 Conventional Commits 草稿。\n'
      + '  二进制文件与 test/fixtures/** 不作为标题素材；推断不出有意义的标题时打印中文提示\n'
      + '  并以非 0 退出（请改用 commit.mjs 显式传 --subject）。\n'
      + '  scope 与 type 相同时省略 scope（不产出 test(test)）。\n'
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
  if (suggestion.inscrutable === true) {
    process.stdout.write(
      `无法从暂存区推断有意义的提交标题：${suggestion.reason}。\n`
      + '请显式指定标题，例如：\n'
      + '  npm run commit -- --type fix --scope watermark --subject "修正居中定位"\n',
    )
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
