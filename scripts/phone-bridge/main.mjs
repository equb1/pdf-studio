#!/usr/bin/env node
/**
 * 手机远控桥 —— 接线部分（I/O）：飞书收发 + `dsh --profile headless` 执行 + 产物回传。
 *
 * 纯逻辑都在 `core.ts`（已单测 51 条）；这里只做"把外部世界接起来"这件事：
 *
 * ```
 * 手机飞书消息 ──①轮询──▶ parseInstruction 过滤 ──▶ 队列（单飞）──▶ dsh headless 执行
 *                                                                      │
 * 手机 ◀──④回传文本+文件── lark-cli ◀──③扫描 outbox 新文件── ②产物写 outbox/<taskId>/
 * ```
 *
 * 用法：
 * ```sh
 * node scripts/phone-bridge/main.mjs --config scripts/phone-bridge.config.json           # 常驻
 * node scripts/phone-bridge/main.mjs --config <cfg> --once                               # 跑一轮就退出（launchd 友好）
 * node scripts/phone-bridge/main.mjs --config <cfg> --dry-run                            # 只打印将执行的指令与提示词
 * node scripts/phone-bridge/main.mjs --self-test                                         # 不联网自检整条流水线
 * ```
 *
 * 安全（与 core.ts 的约束互补，这里负责"不制造新的口子"）：
 *  - 消息内容**只作为 argv 的一个元素**传给 dsh，绝不拼接 shell（`spawn` 无 `shell: true`）；
 *  - 日志统一走 `maskSecrets`，不落密钥；
 *  - 回传文件只从 `outbox/<taskId>/` 里挑，扩展名与大小走白名单；
 *  - 去重在**入队时**就记账，避免轮询窗口内重复入队。
 *
 * @module phone-bridge/main
 */

import { spawn } from 'node:child_process'
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listArtifacts, startHttpBridge } from './http.ts'
import {
  Ledger,
  PendingInputs,
  TaskQueue,
  auditTaskOutput,
  expandPreset,
  extractText,
  formatAttachmentAck,
  formatBusyMessage,
  isAllowedSender,
  isAttachmentType,
  isTargetChat,
  isTaskDirName,
  parseAttachment,
  safeAttachmentName,
  selectExpiredTaskDirs,
  buildDownloadUrl,
  renderPreflightReport,
  isReadyLine,
  normalizeEventMessage,
  parseNdjsonLine,
  buildTaskPrompt,
  formatResultMessage,
  maskSecrets,
  normalizeConfig,
  parseInstruction,
  selectDeliverables,
} from './core.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 解析命令行参数（手写，保持零依赖）。 */
export function parseArgs(argv) {
  const args = { config: undefined, once: false, dryRun: false, selfTest: false, preflight: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--config') { args.config = argv[index + 1]; index += 1 }
    else if (token === '--once') args.once = true
    else if (token === '--dry-run') args.dryRun = true
    else if (token === '--self-test') args.selfTest = true
    else if (token === '--preflight') args.preflight = true
    else if (token === '--help' || token === '-h') args.help = true
  }
  return args
}

/** 发送者是不是应用（机器人自己）——这类消息用来判断"值不值得记日志"。 */
function isAppSender(message) {
  const sender = message?.sender ?? {}
  return sender.sender_type === 'app' || sender.id_type === 'app_id'
}

const USAGE = `用法：node scripts/phone-bridge/main.mjs --config <配置.json> [--once] [--dry-run]
      node scripts/phone-bridge/main.mjs --self-test     不联网自检
      node scripts/phone-bridge/main.mjs --help`

/**
 * 读配置：JSON 文件 + 相对路径按**配置文件所在目录**解析（这样 launchd 从任意 cwd 启动都对）。
 */
export function loadConfig(configPath) {
  const full = resolve(configPath)
  if (!existsSync(full)) throw new Error(`配置文件不存在：${full}`)
  const raw = JSON.parse(readFileSync(full, 'utf8'))
  const config = normalizeConfig(raw)
  const base = dirname(full)
  const absolutize = value => (value.startsWith('/') ? value : join(base, value))
  return { ...config, outboxDir: absolutize(config.outboxDir), statePath: absolutize(config.statePath), logPath: absolutize(config.logPath) }
}

/** 日志：同时写文件与 stderr（都先脱敏）。 */
export function makeLogger(logPath) {
  return message => {
    const line = `[${new Date().toISOString()}] ${maskSecrets(message)}`
    try {
      appendFileSync(logPath, line + '\n')
    } catch {
      // 日志写不进去不该让桥接器挂掉
    }
    process.stderr.write(line + '\n')
  }
}

/**
 * 跑一个子进程并收集输出（可选超时）。
 *
 * **不传 shell**：argv 数组直接交给 `spawn`，所以消息内容里的 `;`、`$()`、反引号都只是普通字符。
 */
export function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 0
  // `killTree`：超时时**连子进程一起杀**。`dsh headless` 会拉起自己的子进程，只杀直接子进程会
  // 留下孤儿继续跑（对常驻服务是隐患）。做法：`detached` 建独立进程组，然后给 **-pid** 发信号——
  // 先 SIGTERM 给机会收尾，宽限期后再 SIGKILL。
  const killTree = options.killTree === true
  const spawnImpl = options.spawnImpl ?? spawn
  const graceMs = options.graceMs ?? 3000
  return new Promise(resolvePromise => {
    const child = spawnImpl(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(killTree ? { detached: true } : {}),
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let graceTimer
    const signalProcess = signal => {
      try {
        if (killTree && typeof child.pid === 'number' && child.pid > 0) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch { /* 已经退出 */ }
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          signalProcess('SIGTERM')
          graceTimer = setTimeout(() => signalProcess('SIGKILL'), graceMs)
        }, timeoutMs)
      : undefined
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const clearTimers = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
    }
    child.on('error', error => {
      clearTimers()
      resolvePromise({ code: -1, stdout, stderr: `${stderr}\n${error.message}`, timedOut, pid: child.pid })
    })
    child.on('close', code => {
      clearTimers()
      resolvePromise({ code: code ?? -1, stdout, stderr, timedOut, pid: child.pid })
    })
  })
}

/** 递归扫描目录（限深度，跳过隐藏目录），返回文件清单。 */
export function scanFiles(root, depth = 3) {
  if (!existsSync(root)) return []
  const out = []
  const walk = (dir, level) => {
    if (level > depth) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        walk(full, level + 1)
      } else if (entry.isFile()) {
        try {
          const info = statSync(full)
          out.push({ path: full, size: info.size, mtimeMs: info.mtimeMs })
        } catch { /* 读不到就跳过 */ }
      }
    }
  }
  walk(root, 0)
  return out
}

/** lark-cli 适配器：把 CLI 用法收敛到三个函数，便于替换与测试。 */
export function makeLarkAdapter(config, logger, runner = runCommand) {
  const identityArgs = ['--as', config.identity]
  // 读用 readIdentity（群消息含文件需要 user 身份），发仍用 identity（bot 更像"机器人发给你"）
  const readIdentityArgs = ['--as', config.readIdentity ?? config.identity]
  const listMessages = async sinceMs => {
    const start = new Date(sinceMs).toISOString()
    const result = await runner(config.larkCliPath, [
      'im', '+chat-messages-list',
      '--chat-id', config.chatId,
      '--start', start,
      '--sort', 'asc',
      '--page-size', '50',
      '--format', 'json',
      ...readIdentityArgs,
    ], { timeoutMs: 60_000 })
    if (result.code !== 0) throw new Error(`拉取消息失败（exit ${result.code}）：${result.stderr.slice(0, 200)}`)
    const parsed = JSON.parse(result.stdout)
    // 真实响应是 { ok, identity, data: { messages: [...] } }——**嵌在 data 里**。
    // 早先只读 parsed.messages（我自己假数据就是那个形状），结果轮询永远拿到空数组、
    // 桥接器一条消息都处理不了（测试还全绿）——所以这里几种形状都认，测试也改用真形状。
    const list = parsed?.data?.messages ?? parsed?.data?.items ?? parsed?.messages ?? parsed?.items ?? []
    return Array.isArray(list) ? list : []
  }
  const sendText = async (text, idempotencyKey) => {
    const result = await runner(config.larkCliPath, [
      'im', '+messages-send',
      '--chat-id', config.chatId,
      '--text', text,
      ...(idempotencyKey === undefined ? [] : ['--idempotency-key', idempotencyKey]),
      ...identityArgs,
    ], { timeoutMs: 60_000 })
    if (result.code !== 0) logger(`发送文本失败（exit ${result.code}）：${result.stderr.slice(0, 200)}`)
    return result.code === 0
  }
  const sendFile = async (path, idempotencyKey) => {
    // **`--file` 只接受"当前目录下的相对路径"**：传绝对路径会被 CLI 以 exit 2 拒绝
    // （报 `--file must be a relative path within the current directory`）。
    // 实测踩过：文字回执照发、产物却一直发不出去，看起来像"成功但没有文件"。
    // 所以这里用「cwd = 文件所在目录 + 相对文件名」调用。
    const result = await runner(config.larkCliPath, [
      'im', '+messages-send',
      '--chat-id', config.chatId,
      '--file', basename(path),
      ...(idempotencyKey === undefined ? [] : ['--idempotency-key', idempotencyKey]),
      ...identityArgs,
    ], { timeoutMs: 5 * 60 * 1000, cwd: dirname(path) })
    if (result.code !== 0) logger(`发送文件失败（${path}，exit ${result.code}）：${result.stderr.slice(0, 200)}`)
    return result.code === 0
  }
  /** 按 message_id 取原始消息（文件/图片消息的 key 只在这里拿得到）。 */
  const getMessage = async messageId => {
    const result = await runner(config.larkCliPath, ['im', '+messages-mget', '--message-ids', messageId, '--format', 'json', ...readIdentityArgs], { timeoutMs: 60_000 })
    if (result.code !== 0) throw new Error(`取消息失败（exit ${result.code}）：${result.stderr.slice(0, 160)}`)
    const parsed = JSON.parse(result.stdout)
    const list = parsed?.data?.messages ?? parsed?.data?.items ?? []
    return Array.isArray(list) ? list[0] : undefined
  }
  /** 下载消息里的附件到 dir（`--output` 只接受相对路径，所以靠 cwd 落点）。 */
  const downloadResource = async ({ messageId, fileKey, kind, dir, name }) => {
    const result = await runner(config.larkCliPath, [
      'im', '+messages-resources-download',
      '--message-id', messageId,
      '--file-key', fileKey,
      '--type', kind === 'image' ? 'image' : 'file',
      '--output', name,
      ...readIdentityArgs,
    ], { timeoutMs: 5 * 60 * 1000, cwd: dir })
    if (result.code !== 0) throw new Error(`下载附件失败（exit ${result.code}）：${result.stderr.slice(0, 160)}`)
    return dir
  }
  return { listMessages, sendText, sendFile, getMessage, downloadResource }
}

/**
 * 执行一条指令：dsh headless → 扫描 outbox → 回传。
 *
 * `runner` 默认是 `runCommand`；自检时注入假实现（不联网、不跑 dsh）。
 */
export async function runTask(config, instruction, deps) {
  const { logger, lark, ledger, runner = runCommand, now = () => Date.now(), inputs = [] } = deps
  const taskId = deps.taskId ?? `t-${now()}-${instruction.messageId.slice(-6)}`
  const outboxTaskDir = join(config.outboxDir, taskId)
  mkdirSync(outboxTaskDir, { recursive: true })
  deps.registerTaskDir?.(outboxTaskDir)   // 告诉 GC：这个目录正在用
  const startedAtMs = now()
  const prompt = buildTaskPrompt(instruction.text, { outboxDir: config.outboxDir, taskId, autoConfirm: config.autoConfirm !== false, inputs })
  // `dshArgs` 必须在 dry-run 分支**之前**声明：那个分支也要打印真实命令（否则 TDZ 报错）
  const dshArgs = Array.isArray(config.dshArgs) ? config.dshArgs : []
  logger(`任务 ${taskId} 开始：${instruction.text.slice(0, 120)}`)

  if (config.dryRun === true) {
    logger(`[dry-run] 将执行：${[config.dshPath, '--profile', config.profile, ...dshArgs, `<提示词 ${prompt.length} 字>`].join(' ')}`)
    logger(`[dry-run] 提示词：\n${prompt}`)
    return { taskId, status: 'ok', files: [], elapsedMs: 0 }
  }

  // 注意：任务正文是**位置参数**，`dsh` 会把多个位置参数用空格拼起来——
  // 所以这里绝不能多塞一个字面量（早先写成 `['--profile', p, 'headless', prompt]`，
  // 结果任务正文以 "headless " 开头）。`dshArgs` 用来叠加插件来源（如 --patch）。
  const argv = ['--profile', config.profile, ...dshArgs, prompt]
  const result = await runner(config.dshPath, argv, { timeoutMs: config.timeoutMs, killTree: true })
  const elapsedMs = now() - startedAtMs
  const status = result.timedOut ? 'timeout' : result.code === 0 ? 'ok' : 'error'
  // 把 agent 的完整输出留档（`.log` 不在回传白名单里，所以不会被发出去）——
  // 只留最后几行做回执的话，「为什么没产物」这类问题事后根本没法诊断（实测踩过）。
  const outputLog = join(outboxTaskDir, 'agent-output.log')
  try {
    writeFileSync(outputLog, `# 任务 ${taskId}\n# 指令：${instruction.text}\n# 状态：${status} 用时：${(elapsedMs / 1000).toFixed(1)}s\n\n## stdout\n${result.stdout}\n\n## stderr\n${result.stderr}\n`)
    logger(`任务输出已留档：${outputLog}`)
  } catch (error) {
    logger(`任务输出留档失败：${String(error)}`)
  }
  const summary = result.stdout.trim().split('\n').slice(-12).join('\n')
  const entries = scanFiles(outboxTaskDir)
  const files = selectDeliverables(entries, {
    startedAtMs,
    allowedExtensions: config.allowedExtensions,
    maxFileBytes: config.maxFileBytes,
    maxFilesPerTask: config.maxFilesPerTask,
  })
  logger(`任务 ${taskId} 结束：status=${status} 用时=${(elapsedMs / 1000).toFixed(1)}s 产物=${files.length} 个`)
  deps.recordArtifacts?.(instruction.messageId, files)

  // 配置了「手机直下」（插件侧 token 端点）时，回执里附上可点的下载链接
  const downloadBase = typeof config.downloadBaseUrl === 'string' ? config.downloadBaseUrl : ''
  const downloadToken = typeof config.downloadToken === 'string' ? config.downloadToken : ''
  const downloadUrls = downloadBase !== '' && downloadToken !== ''
    ? files.map(file => buildDownloadUrl(downloadBase, file.path, downloadToken))
    : []
  // 第二道网：扫一遍 agent 输出，把可疑信号（shell 迹象 / 写到 outbox 之外）如实附在回执里
  const audit = auditTaskOutput(`${result.stdout}\n${summary}`, { outboxDir: config.outboxDir })
  if (!audit.clean) logger(`任务 ${taskId} 审计提示：${audit.warnings.join('；')}`)
  const text = formatResultMessage({
    instruction: instruction.text,
    status,
    summary,
    files: files.map(file => file.path),
    elapsedMs,
    ...(status === 'error' ? { error: result.stderr.trim().slice(0, 400) } : {}),
    ...(downloadUrls.length === 0 ? {} : { downloadUrls }),
    ...(audit.warnings.length === 0 ? {} : { warnings: audit.warnings }),
  })
  await lark.sendText(text, `${instruction.messageId}-result`)
  const failed = []
  for (const [index, file] of files.entries()) {
    const ok = await lark.sendFile(file.path, `${instruction.messageId}-file-${index}`)
    if (ok !== true) failed.push(file.path)
  }
  if (failed.length > 0) {
    // 一定要说：否则用户看到"产物 N 个"却收不到文件（实测就是这个问题被用户发现的）
    await lark.sendText(
      `⚠️ 有 ${failed.length} 个产物没能发到飞书，文件仍在本机：\n${failed.map(path => `  ${path}`).join('\n')}`,
      `${instruction.messageId}-filefail`,
    )
    logger(`产物发送失败 ${failed.length} 个：${failed.join('、')}`)
  }
  ledger.mark(instruction.messageId, status, elapsedMs === 0 ? startedAtMs : startedAtMs + elapsedMs)
  return { taskId, status, files: files.map(file => file.path), elapsedMs }
}

/** 启动桥接器主循环。 */
/**
 * 装配桥接器（**可注入**，便于单测轮询循环与"入队即记账"等行为）。
 *
 * 生产环境用默认依赖（lark-cli + 真实 dsh + 写状态文件）；测试里把 `lark` / `runner` / `persist` / `now`
 * 换成假实现，就能在不联网、不跑 dsh 的前提下验证整条编排逻辑。
 */
export function createBridge(config, deps = {}) {
  const logger = deps.logger ?? (() => {})
  const lark = deps.lark ?? makeLarkAdapter(config, logger)
  const ledger = deps.ledger ?? new Ledger()
  const now = deps.now ?? (() => Date.now())
  const pending = deps.pending ?? new PendingInputs()
  const persist = deps.persist ?? (() => {
    // 产物清单一起存（重启后网页仍能查到"这次交付了什么"）
    try {
      writeFileSync(config.statePath, JSON.stringify({
        ledger: ledger.toJSON(),
        pending: pending.toJSON(),
        artifacts: Object.fromEntries(artifactsByMessage),
      }))
    } catch { /* 写状态失败不影响任务本身 */ }
    try {
      writeFileSync(config.statePath, JSON.stringify({ ledger: ledger.toJSON(), pending: pending.toJSON() }, null, 2))
    } catch (error) {
      logger(`状态写入失败：${String(error)}`)
    }
  })
  const inFlightDirs = new Set()
  /** messageId → 实际交付的产物（持久化；状态查询的权威来源）。 */
  const artifactsByMessage = new Map()
  const recordArtifacts = (messageId, files) => {
    artifactsByMessage.set(String(messageId), (files ?? []).map(entry => (typeof entry === 'string' ? entry : entry.path)))
    persist()
  }

  const queue = new TaskQueue(job => runTask(config, job.instruction, {
    inputs: job.inputs,
    // **必须转发 taskId**：网页入口自己生成了 taskId 并按它查产物目录，
    // 不转发的话任务会跑在自动生成的名字下，网页永远查不到产物（飞书却收到了）✗
    ...(job.taskId === undefined ? {} : { taskId: job.taskId }),
    recordArtifacts,
    logger,
    lark,
    ledger,
    now,
    registerTaskDir: dir => inFlightDirs.add(dir),
    ...(deps.runner === undefined ? {} : { runner: deps.runner }),
  }))
  const collectOutbox = () => collectExpiredOutbox(config, { logger, keep: [...inFlightDirs], dryRun: config.dryRun === true })

  /**
   * 处理**一条**消息（轮询与事件两种来源共用同一套判定）。
   * 返回 'accepted' | 'duplicate' | 'ignored'。
   */
  const handleMessage = message => {
    const outcome = parseInstruction(message, config, now())
    if (!outcome.ok) {
      // **看不懂的指令要回一句话**，别静默丢掉：实测用户发 `/全处理 命名为…`（当时不支持带参数）
      // 被静默丢弃，看起来就像"机器人没反应"。只在"像是要下指令"时回（以 / 开头），不打扰闲聊。
      const rawText = extractText(message.content) ?? ''
      const looksLikeCommand = /^\//.test(String(rawText).trim().replace(/^(?:@[^\s]+\s+)+/u, ''))
      if (outcome.reason.includes('没有以') && looksLikeCommand && isAllowedSender(message, config) && isTargetChat(message, config)) {
        const names = Object.keys(config.presets ?? {})
        const presetHint = names.length > 0 ? `，或直接用预设名 ${names.map(name => `/${name}`).join(' / ')}（名字后面可以带要求）` : ''
        void lark.sendText(
          `❓ 没看懂这条指令：请以 ${config.prefix} 开头${presetHint}。\n例如：${config.prefix} 给它加页码；或 /全处理 命名为「XX试卷」和「XX答案」`,
          `${String(message.message_id)}-hint`,
        ).catch(() => {})
      }
      // 只记日志、不回消息：避免把"没通过白名单"变成骚扰，也避免泄露白名单规则。
      // 但**机器人自己发的回执**会被轮询到、必然不在白名单里——这类不写日志，
      // 否则常驻服务的日志会被自己刷爆（实测 10 分钟 1800 行）。
      if (!outcome.reason.includes('没有以') && !(isAppSender(message) && outcome.reason.includes('不在白名单'))) {
        logger(`忽略消息：${outcome.reason}`)
      }
      return 'ignored'
    }
    if (ledger.has(outcome.instruction.messageId)) return 'duplicate'
    // 预设展开：/水印、/pdf 拆分、或直接写预设名 → 换成整条指令
    const expanded = expandPreset(outcome.instruction.text, config.presets, { prefix: config.prefix })
    if (expanded.preset !== undefined) {
      logger(`预设命中「${expanded.preset}」：${expanded.text.slice(0, 80)}…`)
      outcome.instruction.text = expanded.text
    }
    // 背压：队列满了就**明确回执拒收**（比静默堆积好——用户知道要等一下）
    if (config.maxQueueLength > 0 && queue.size >= config.maxQueueLength) {
      ledger.mark(outcome.instruction.messageId, 'rejected-busy', now())
      persist()
      logger(`队列已满（${queue.size}/${config.maxQueueLength}），拒收：${outcome.instruction.text.slice(0, 60)}`)
      void lark.sendText(formatBusyMessage(queue.size, config.maxQueueLength), `${outcome.instruction.messageId}-busy`)
        .catch(error => logger(`发送忙回执失败：${String(error)}`))
      return 'rejected'
    }
    ledger.mark(outcome.instruction.messageId, 'queued', now())   // 先记账，避免重复入队
    persist()
    // 把"刚发来的附件"取出来带进这次任务（两段式用法：先发文件，再发指令）
    const senderId = typeof message.sender?.id === 'string' ? message.sender.id : ''
    const inputs = pending.take(config.chatId, senderId, now(), config.inputTtlMs).map(entry => entry.path)
    // 预设是"对刚发来的文件做事"：没有输入文件、消息里也没写路径时，直接提示，别白跑一次 agent
    if (expanded.preset !== undefined && inputs.length === 0 && !/[\/~]|\.pdf/i.test(outcome.instruction.text)) {
      logger(`预设「${expanded.preset}」触发但没有输入文件，已提示用户先发文件`)
      void lark.sendText(
        `📎 还没收到文件：先把文件发给我，再回 /${expanded.preset}（或 ${config.prefix} 指令）。`,
        `${outcome.instruction.messageId}-needfile`,
      ).catch(() => {})
      return 'ignored'
    }
    if (inputs.length > 0) logger(`本次任务带 ${inputs.length} 个输入文件：${inputs.join('、')}`)
    void queue.enqueue({ instruction: outcome.instruction, inputs }).then(persist, error => logger(`任务异常：${String(error)}`))
    // **立刻回一条"已收到"**：任务常常要跑 1~3 分钟，只在结束时回执会让人以为没反应（实测被问过）。
    const ahead = Math.max(0, queue.size - 1)
    void lark.sendText(
      `⏳ 收到，开始处理${ahead > 0 ? `（前面还有 ${ahead} 个任务）` : ''}，大约 1~3 分钟。完成后我立刻把产物发上来。`,
      `${outcome.instruction.messageId}-ack`,
    ).catch(error => logger(`发送"已收到"回执失败：${String(error)}`))
    return 'accepted'
  }

  /**
   * 处理**附件消息**（用户直接发文件/图片过来）。
   *
   * 飞书事件对附件只给"预渲染文本"，所以要先 mget 拿 key、再下载到 inbox，
   * 然后记住它并回一条"请告诉我怎么改"——下一条 /pdf 指令会把路径一起交给 agent。
   */
  const handleAttachment = async message => {
    const messageId = typeof message.message_id === 'string' ? message.message_id : ''
    if (messageId === '') return 'ignored'
    if (!isAllowedSender(message, config)) {
      if (!isAppSender(message)) logger(`忽略附件：发送者不在白名单（${String(message.sender?.id ?? '未知')}）`)
      return 'ignored'
    }
    if (!isTargetChat(message, config)) {
      logger(`忽略附件：不在目标会话（${String(message.chat_id ?? '未知')}）`)
      return 'ignored'
    }
    if (ledger.has(messageId)) return 'duplicate'
    ledger.mark(messageId, 'attachment', now())
    persist()
    try {
      const fetched = await lark.getMessage(messageId)
      const attachment = parseAttachment(fetched?.content)
      if (attachment === undefined) {
        logger(`附件消息 ${messageId}：没能从原始内容里解析出资源 key`)
        return 'ignored'
      }
      const dir = join(config.inboxDir, messageId)
      mkdirSync(dir, { recursive: true })
      const wanted = safeAttachmentName(attachment.name ?? `${attachment.kind}-${String(now())}`)
      await lark.downloadResource({ messageId, fileKey: attachment.key, kind: attachment.kind, dir, name: wanted })
      // 下载后的真实文件名可能被服务端补了扩展名，所以按目录里最新的文件取
      const landed = readdirSync(dir)
        .map(name => join(dir, name))
        .filter(path => { try { return statSync(path).isFile() } catch { return false } })
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
      if (landed === undefined) {
        logger(`附件 ${messageId}：下载后没找到文件`)
        return 'error'
      }
      const size = statSync(landed).size
      if (size > config.maxInputBytes) {
        rmSync(landed, { force: true })
        logger(`附件过大（${size} > ${config.maxInputBytes}），已删除`)
        await lark.sendText(`📎 这个文件太大了（${(size / 1048576).toFixed(1)}MB > ${(config.maxInputBytes / 1048576).toFixed(0)}MB），先没收。`, `${messageId}-toolarge`)
        return 'ignored'
      }
      const name = landed.split('/').pop() ?? wanted
      pending.remember({ chatId: config.chatId, senderId: String(message.sender?.id ?? ''), path: landed, name, at: now() })
      persist()
      await lark.sendText(
        formatAttachmentAck(name, Math.round(config.inputTtlMs / 60000), Object.keys(config.presets)),
        `${messageId}-ack`,
      )
      // 配了默认预设就起一个"等一会儿没人下指令就自动跑"的定时器（unref：别拖着进程不退出）
      const presetInstruction = config.defaultPreset === '' ? undefined : config.presets[config.defaultPreset]
      if (presetInstruction !== undefined && config.autoPresetDelayMs > 0) {
        const senderId = String(message.sender?.id ?? '')
        const timer = setTimeout(() => {
          const taken = pending.take(config.chatId, senderId, now(), config.inputTtlMs)
          if (taken.length === 0) return            // 用户已经自己下了指令，别重复跑
          const autoId = `auto-${String(now())}-${messageId}`
          if (ledger.has(autoId)) return
          ledger.mark(autoId, 'queued', now())
          persist()
          logger(`文件已到 ${Math.round(config.autoPresetDelayMs / 1000)}s 且没人下指令 → 按预设「${config.defaultPreset}」自动处理`)
          void lark.sendText(`⏳ 没收到指令，按预设「${config.defaultPreset}」开始处理，大约 1~3 分钟。`, `${messageId}-autoack`).catch(() => {})
          void queue.enqueue({
            instruction: { messageId: autoId, chatId: config.chatId, text: presetInstruction },
            inputs: taken.map(entry => entry.path),
          }).then(persist, error => logger(`自动任务异常：${String(error)}`))
        }, config.autoPresetDelayMs)
        timer.unref?.()
      }
      logger(`已收下附件：${name}（${size} 字节）→ ${landed}`)
      return 'attachment'
    } catch (error) {
      logger(`处理附件失败（${messageId}）：${String(error)}`)
      return 'error'
    }
  }

  /** 轮询一次：拉消息 → 过滤 → 入队（**入队即记账**，避免轮询窗口内重复执行）。返回接受条数。 */
  const pollOnce = async () => {
    const since = now() - config.maxAgeMs
    let messages = []
    try {
      messages = await lark.listMessages(since)
    } catch (error) {
      logger(`轮询失败：${String(error)}`)
      return 0
    }
    let accepted = 0
    for (const message of messages) {
      // 逐条隔离：单条消息处理出错（比如某个字段形状没见过）只记日志，
      // 绝不让异常穿透主循环——常驻服务不能被一条坏消息弄死（实测漏导入一个函数就会这样）。
      try {
        if (isAttachmentType(message.msg_type)) { await handleAttachment(message); continue }
        if (handleMessage(message) === 'accepted') accepted += 1
      } catch (error) {
        logger(`处理消息失败（${String(message.message_id ?? '未知')}）：${String(error)}`)
      }
    }
    ledger.prune(now(), 7 * 24 * 60 * 60 * 1000)
    return accepted
  }

  /**
   * 网页入口提交任务：预设名先用同一套 `expandPreset` 展开，再走同一条单飞队列。
   * 队列满时**抛错**（由 HTTP 层回 429），不静默丢。
   */
  const submitTask = ({ text, inputs: inputPaths, taskId }) => {
    if (config.maxQueueLength > 0 && queue.size >= config.maxQueueLength) throw new Error('queue-full')
    const expanded = expandPreset(text, config.presets, { prefix: config.prefix })
    if (expanded.preset !== undefined) logger(`网页任务命中预设「${expanded.preset}」`)
    const id = `web:${taskId}`
    ledger.mark(id, 'queued', now())
    persist()
    void queue.enqueue({
      instruction: { messageId: id, chatId: config.chatId, text: expanded.text },
      inputs: inputPaths ?? [],
      taskId,
    }).then(persist, error => logger(`网页任务异常：${String(error)}`))
    return taskId
  }

  /** 网页轮询状态：账本 + outbox/<taskId> 里的产物清单。 */
  const taskStatus = taskId => {
    const id = `web:${taskId}`
    const status = ledger.statusOf(id)
    if (status === undefined) return undefined
    const recorded = artifactsByMessage.get(id)
    return {
      status,
      // 记录优先（权威）；没有记录的老任务才扫目录兜底
      artifacts: recorded !== undefined && recorded.length > 0
        ? recorded
        : listArtifacts(config.outboxDir, taskId, config.allowedExtensions),
    }
  }

  return { pollOnce, handleMessage, handleAttachment, submitTask, taskStatus, recordArtifacts, queue, ledger, pending, persist, lark, collectOutbox }
}

/**
 * 清理 outbox 里的**过期任务目录**（保留天数由 `outboxRetentionDays` 决定，0 = 不清理）。
 *
 * 安全要点：只删**桥接器自己命名的**目录（`t-<时间戳>-<消息尾号>`），并且跳过正在跑的任务；
 * `--dry-run` 下**只报告不删**。
 */
export function collectExpiredOutbox(config, deps = {}) {
  const logger = deps.logger ?? (() => {})
  const retentionMs = (config.outboxRetentionDays ?? 0) * 24 * 60 * 60 * 1000
  if (retentionMs <= 0) return []
  let entries = []
  try {
    entries = readdirSync(config.outboxDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const path = join(config.outboxDir, entry.name)
        let mtimeMs = 0
        try { mtimeMs = statSync(path).mtimeMs } catch { /* 读不到就当 0（更可能被清） */ }
        return { name: entry.name, path, mtimeMs }
      })
  } catch {
    return []                                  // 目录还不存在：没什么可清的
  }
  const expired = selectExpiredTaskDirs(entries, {
    nowMs: deps.now?.() ?? Date.now(),
    retentionMs,
    keep: deps.keep ?? [],
  })
  const dryRun = deps.dryRun === true
  for (const entry of expired) {
    if (dryRun) {
      logger(`[dry-run] 将清理过期任务目录：${entry.name}`)
      continue
    }
    try {
      rmSync(entry.path, { recursive: true, force: true })
      logger(`已清理过期任务目录：${entry.name}`)
    } catch (error) {
      logger(`清理失败（${entry.name}）：${String(error)}`)
    }
  }
  return expired.map(entry => entry.path)
}

/**
 * 事件来源：`lark-cli event consume <key>` 的长连接（比轮询即时，但要在飞书侧配置事件订阅）。
 *
 * 三个**必须**遵守的契约（来自 `lark-event` skill，踩错就是"看起来在跑但收不到"）：
 *  1. **stdin 必须保持打开**：`event consume` 把 stdin EOF 当优雅退出信号，
 *     所以 `stdio[0]` 必须是 `'pipe'` 且**永不 end**（用 `ignore` 会立刻退出）；
 *  2. **等 stderr 的 ready 标记**（`[event] ready event_key=…`）再读 stdout，不能靠 sleep；
 *  3. **停止只用 SIGTERM + 关 stdin**，**绝不 kill -9**（有 PreConsume 钩子的 key 会漏掉服务端退订，
 *     下次启动报 "subscription already exists" 并重复投递）。
 */
export function startEventSource(config, deps) {
  const spawnImpl = deps.spawnImpl ?? spawn
  const eventKey = config.eventKey ?? 'im.message.receive_v1'
  const argv = ['event', 'consume', eventKey, '--as', config.identity]
  if (deps.bounded === true) argv.push('--max-events', '1', '--timeout', '10m')
  const child = spawnImpl(config.larkCliPath, argv, { stdio: ['pipe', 'pipe', 'pipe'] })
  let ready = false
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let resolveReady
  let rejectReady
  const readyPromise = new Promise((resolvePromise, rejectPromise) => { resolveReady = resolvePromise; rejectReady = rejectPromise })

  const handleStderr = chunk => {
    stderrBuffer += String(chunk)
    const lines = stderrBuffer.split('\n')
    stderrBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!ready && isReadyLine(line, eventKey)) {
        ready = true
        deps.logger(`事件订阅已就绪：${eventKey}`)
        resolveReady()
        processStdoutLines()   // 把就绪前缓冲到的行补处理
        continue
      }
      if (line.trim() !== '') deps.logger(`[event] ${line.trim()}`)
    }
  }
  const processStdoutLines = () => {
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const payload = parseNdjsonLine(line)
      if (payload === undefined) continue          // 脏行只跳过，不整体崩
      const message = normalizeEventMessage(payload)
      if (message === undefined) continue          // 不是消息事件（如 chat 变更）
      deps.onMessage(message)
    }
  }
  const handleStdout = chunk => {
    stdoutBuffer += String(chunk)
    // 契约：**未就绪前先缓冲**，别抢跑（skill 明确要求"阻塞到 ready 再读 stdout"）
    if (!ready) return
    processStdoutLines()
  }

  child.stderr?.on('data', handleStderr)
  child.stdout?.on('data', handleStdout)
  child.on?.('error', error => {
    if (!ready) rejectReady(error)
    deps.logger(`事件消费启动失败：${String(error)}`)
  })
  child.on?.('close', code => {
    if (!ready) rejectReady(new Error(`事件消费在就绪前退出（exit ${code}）`))
    deps.onExit?.(code ?? -1)
  })

  return {
    child,
    ready: readyPromise,
    /** 优雅停止：先关 stdin（触发它自己的退出路径），再 SIGTERM；**不用 SIGKILL**。 */
    stop() {
      try { child.stdin?.end() } catch { /* 已经关了 */ }
      try { child.kill('SIGTERM') } catch { /* 已经退出 */ }
    },
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) { process.stdout.write(USAGE + '\n'); return 0 }

  if (args.selfTest) return selfTest()
  if (args.preflight) {
    if (args.config === undefined) { process.stderr.write('--preflight 需要 --config <配置.json>\n'); return 2 }
    return preflight(loadConfig(args.config))
  }

  if (args.config === undefined) {
    process.stderr.write('缺少 --config <配置.json>（或用 --self-test 自检）\n' + USAGE + '\n')
    return 2
  }
  const config = loadConfig(args.config)
  const logger = makeLogger(config.logPath)
  // 状态文件有两种历史形状：旧的整个文件就是账本；新的是 { ledger, pending }。
  // 两种都要能读（否则升级后会"忘了去过重"，同一条消息会被重复执行——实测踩过）。
  const stateRaw = existsSync(config.statePath) ? JSON.parse(readFileSync(config.statePath, 'utf8')) : {}
  const ledger = new Ledger(stateRaw.ledger ?? stateRaw)
  const pending = new PendingInputs(stateRaw.pending ?? [])
  logger(`桥接器启动：chat=${config.chatId} 轮询=${config.pollMs}ms 超时=${config.timeoutMs}ms outbox=${config.outboxDir}`)

  const bridge = createBridge({ ...config, dryRun: args.dryRun }, { logger, ledger, pending })
  const { queue, persist, pollOnce, handleMessage, handleAttachment, submitTask, taskStatus } = bridge

  // 手机网页（可选）：配了 httpToken 才启动；没配就完全不开端口（fail-closed）
  let web = null
  if (typeof config.httpToken === 'string' && config.httpToken.trim() !== '') {
    try {
      const page = readFileSync(join(HERE, 'web', 'index.html'), 'utf8')
      web = await startHttpBridge({
        host: config.httpHost,
        port: config.httpPort,
        token: config.httpToken,
        outboxDir: config.outboxDir,
        inboxDir: config.inboxDir,
        maxBodyBytes: config.maxBodyBytes,
        presets: config.presets,
        presetFields: config.presetFields,
        page,
        pagePath: join(HERE, 'web', 'index.html'),
        logger,
        submit: task => { submitTask(task) },
        status: taskId => taskStatus(taskId),
      })
      logger(`手机网页地址：${web.url}`)
    } catch (error) {
      logger(`手机网页启动失败：${String(error)}`)
    }
  }

  // 停止信号：只置标志位让主循环自然收尾（不硬杀正在跑的任务）
  let stopping = false
  const stop = signal => {
    logger(`收到 ${signal}，等待当前任务结束…`)
    stopping = true
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
  const drain = async () => { while (queue.size > 0) await sleep(500) }
  // outbox 清理：启动时来一次，之后每天一次（无人值守跑久了不至于把盘占满）
  const { collectOutbox } = bridge
  let lastGcMs = 0
  const gcIfDue = () => {
    if (Date.now() - lastGcMs < 24 * 60 * 60 * 1000) return
    lastGcMs = Date.now()
    collectOutbox()
  }
  gcIfDue()

  // ── 事件模式（长连接）：比轮询即时；异常退出后自动重启 ──────────────────
  if (config.source === 'event') {
    // `--once` 下要计数：收到并接受一条就收工，否则会一直等到子进程退出/超时（实测白等 60s）
    let accepted = 0
    const startOnce = async (bounded) => {
      const source = startEventSource(config, {
        logger,
        onMessage: message => {
          // 附件（文件/图片）与文本走不同处理：附件要先下载再等指令；单条出错只记日志
          try {
            if (isAttachmentType(message.msg_type)) { void handleAttachment(message); return }
            if (handleMessage(message) === 'accepted') accepted += 1
          } catch (error) {
            logger(`处理事件失败（${String(message.message_id ?? '未知')}）：${String(error)}`)
          }
        },
        onExit: code => { if (!stopping && !args.once) logger(`事件消费已退出（exit ${code}），准备重启`) },
        ...(bounded ? { bounded: true } : {}),
      })
      await source.ready
      return source
    }

    if (args.once) {
      let source
      try {
        source = await startOnce(true)
      } catch (error) {
        logger(`事件模式启动失败：${String(error)}`)
        return 1
      }
      // 等到"有一条被接受"（或超时/子进程退出）就收工；随后把队列跑完
      const deadline = Date.now() + config.timeoutMs + 30_000
      while (!stopping && Date.now() < deadline && accepted === 0 && source.child.exitCode == null) await sleep(500)
      await drain()
      source.stop()
      persist()
      logger('--once：事件模式结束，退出')
      return 0
    }

    while (!stopping) {
      let source
      try {
        source = await startOnce(false)
      } catch (error) {
        logger(`事件模式启动失败：${String(error)}`)
        await sleep(Math.min(30_000, config.pollMs * 2))
        continue
      }
      await new Promise(resolveClose => {
        if (source.child.exitCode != null) { resolveClose(); return }
        source.child.once('close', () => resolveClose())
        // 收到停止信号时主动优雅关闭，让上面那个 close 触发
        const onStop = () => source.stop()
        process.once('SIGINT', onStop)
        process.once('SIGTERM', onStop)
      })
      if (stopping) break
      source.stop()
      await sleep(Math.min(30_000, config.pollMs * 2))   // 退避后重启
    }
    await drain()
    persist()
    logger('已退出')
    return 0
  }

  // ── 轮询模式（默认）────────────────────────────────────────────────────
  if (args.once) {
    await pollOnce()
    await drain()
    persist()
    if (web !== null) await web.close().catch(() => {})
    logger('--once：一轮结束，退出')
    return 0
  }

  while (!stopping) {
    await pollOnce()
    gcIfDue()
    await sleep(config.pollMs)
  }
  await drain()
  persist()
  if (web !== null) await web.close().catch(() => {})
  logger('已退出')
  return 0
}

/**
 * `--preflight`：**上线自检**——把差旅前能自动查的都查掉。
 *
 * 刻意**不真发消息**（发送项用 `--dry-run`）也**不跑任务**，所以可以放心在真实配置上跑。
 * 每项失败都给出可直接照做的修复命令；返回 0/1 供脚本判断。
 */
export async function preflight(config, deps = {}) {
  const runner = deps.runner ?? runCommand
  const checks = []
  const push = (name, ok, detail, fix) => checks.push({ name, ok, ...(detail === undefined ? {} : { detail }), ...(fix === undefined ? {} : { fix }) })

  // 1) lark-cli 可用 + 身份就绪情况（脱敏：只取 appId/身份状态/到期时间，不打印 secret）
  //
  // 注意：**bot 身份不需要 auth login**，所以不能因为"用户 token 过期"就判失败——
  // 那是默认配置下的正常状态。只有配置成 user 身份时，用户授权才是硬要求。
  const cli = await runner(config.larkCliPath, ['config', 'show'], { timeoutMs: 30_000 })
  if (cli.code !== 0) {
    push('lark-cli 可用', false, `exit ${cli.code}：${cli.stderr.trim().slice(0, 120)}`, '确认已安装并在 PATH 里：lark-cli config init')
  } else {
    let appId = ''
    try { appId = String(JSON.parse(cli.stdout).appId ?? '') } catch { /* 非 JSON 输出也算可用 */ }
    push('lark-cli 可用', true, appId || undefined)

    const status = await runner(config.larkCliPath, ['auth', 'status'], { timeoutMs: 30_000 })
    let identities = {}
    try { identities = JSON.parse(status.stdout).identities ?? {} } catch { /* 拿不到就跳过身份判定 */ }
    const botState = String(identities?.bot?.status ?? 'unknown')
    const userState = String(identities?.user?.status ?? 'unknown')
    const userExpires = String(identities?.user?.expiresAt ?? '')

    if (config.identity === 'bot') {
      push('bot 身份就绪（发送/事件都用它）', botState === 'ready',
        `bot=${botState}；user=${userState}${userExpires === '' ? '' : `（${userExpires} 过期）`}`,
        'bot 身份由应用凭证自动获得，不需要 auth login；若未就绪请检查 appId/appSecret 配置')
    } else {
      push('user 身份就绪（授权未过期）', userState === 'ready',
        `user=${userState}${userExpires === '' ? '' : `（记录到期 ${userExpires}）`}`,
        'lark-cli auth login --scope "im:message:readonly im:message"')
    }
  }

  // 2) 能读到目标会话：**只有轮询模式才需要**这一步。
  //    事件模式下机器人是通过长连接收消息的，读列表接口用 bot 身份会 230027——那是预期行为，不是故障。
  if (config.source === 'event') {
    push('消息来源（事件模式）', true, `用长连接收 ${config.eventKey}，不需要读消息列表接口`)
  } else {
    // 读消息要按 readIdentity（群消息含文件只有 user 身份才读得到），不能一律用 identity
    const list = await runner(config.larkCliPath, ['im', '+chat-messages-list', '--chat-id', config.chatId, '--page-size', '1', '--format', 'json', '--as', config.readIdentity ?? config.identity], { timeoutMs: 60_000 })
    push('能读取目标会话的消息', list.code === 0,
      list.code === 0 ? undefined : `exit ${list.code}：${(list.stderr || list.stdout).trim().slice(0, 160)}`,
      '检查 chat_id 是否正确、机器人在不在会话里、以及 im:message:readonly 权限')
  }

  // 3) 发送参数（**用 --dry-run，不发真消息**）
  const send = await runner(config.larkCliPath, ['im', '+messages-send', '--chat-id', config.chatId, '--text', '手机远控自检（dry-run，不会真的发出去）', '--dry-run', '--as', config.identity], { timeoutMs: 30_000 })
  push('发送参数可用（dry-run，不真发）', send.code === 0,
    send.code === 0 ? undefined : `exit ${send.code}：${(send.stderr || send.stdout).trim().slice(0, 160)}`,
    '检查发送权限（bot 身份还要把机器人拉进会话）')

  // 4) dsh 可执行 + profile 可用（打印 usage 即视为存在；不跑任务）
  const dsh = await runner(config.dshPath, ['--profile', config.profile, '--help'], { timeoutMs: 60_000 })
  push(`dsh 可用且 --profile ${config.profile} 存在`, dsh.code === 0 && (dsh.stdout + dsh.stderr).includes('Usage'),
    dsh.code === 0 ? undefined : `exit ${dsh.code}：${(dsh.stderr || dsh.stdout).trim().slice(0, 120)}`,
    '确认 dsh 在 PATH 里；headless 的插件来源见 docs/PHONE-BRIDGE.md §4.1（dshArgs + --patch）')

  // 5) outbox 可写
  try {
    mkdirSync(config.outboxDir, { recursive: true })
    accessSync(config.outboxDir, constants.W_OK)
    push('outbox 目录可写', true, config.outboxDir)
  } catch (error) {
    push('outbox 目录可写', false, String(error), `检查目录权限或改配置：${config.outboxDir}`)
  }

  // 6) 事件模式额外提醒（飞书侧配置无法从本地判定）
  if (config.source === 'event') {
    push('事件模式前置（需飞书侧配置事件订阅）', true, `将消费 ${config.eventKey}；本地无法判定，若启动报错按 §4.2 处理`)
  }

  const report = renderPreflightReport(checks)
  process.stdout.write(report.text + '\n')
  return report.ok ? 0 : 1
}

/**
 * `--self-test`：**不联网、不跑 dsh** 地验证整条流水线接线是否正确。
 *
 * 用假的消息列表、假的 runner（往 outbox 写一个 PDF）与假的发送器，
 * 覆盖"过滤 → 入队 → 执行 → 扫描产物 → 回传文本与文件 → 记账"。
 */
export async function selfTest() {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const work = mkdtempSync(join(tmpdir(), 'pb-selftest-'))
  const outbox = join(work, 'outbox')
  mkdirSync(outbox, { recursive: true })
  const config = {
    ...normalizeConfig({
      chatId: 'oc_selftest',
      allowedSenderIds: ['ou_me'],
      outboxDir: outbox,
      statePath: join(work, 'state.json'),
      logPath: join(work, 'bridge.log'),
    }),
    dryRun: false,
  }
  const sent = { texts: [], files: [] }
  const lines = []
  const deps = {
    logger: line => lines.push(line),
    ledger: new Ledger(),
    lark: {
      listMessages: async () => [],
      sendText: async text => { sent.texts.push(text); return true },
      sendFile: async path => { sent.files.push(path); return true },
    },
    runner: async (_command, argv) => {
      // 假 dsh：把"产物"写到提示词里写明的 outbox 目录，并返回一段汇报
      const prompt = argv[argv.length - 1]
      const match = /(\/[^\s"]+\/t-[^\s"]+)\//u.exec(prompt)
      const dir = match === null ? outbox : match[1]
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '结果.pdf'), '%PDF-1.4 自检产物')
      return { code: 0, stdout: '已给 1 页加页码，产物：结果.pdf', stderr: '', timedOut: false }
    },
  }
  const instruction = { messageId: 'om_selftest', chatId: 'oc_selftest', createdAtMs: Date.now(), text: '给自检.pdf 加页码' }
  const result = await runTask(config, instruction, deps)
  const checks = [
    ['任务状态为 ok', result.status === 'ok'],
    ['回传了 1 个文件', sent.files.length === 1 && sent.files[0].endsWith('结果.pdf')],
    ['回传文本含"完成"与指令摘要', sent.texts.length === 1 && sent.texts[0].includes('✅ 完成') && sent.texts[0].includes('给自检.pdf 加页码')],
    ['产物落在 outbox/<taskId>/ 下', sent.files[0].includes(`/outbox/${result.taskId}/`)],
    ['账本已记账', deps.ledger.statusOf('om_selftest') === 'ok'],
    ['日志已记录任务开始与结束', lines.some(line => line.includes('开始')) && lines.some(line => line.includes('结束'))],
  ]
  let failed = 0
  for (const [name, ok] of checks) {
    console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}`)
    if (!ok) failed += 1
  }
  rmSync(work, { recursive: true, force: true })
  console.log(`\n${failed === 0 ? 'SELF-TEST PASSED' : `${failed} check(s) FAILED`}`)
  return failed === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(code => {
    // **必须显式退出**：`main()` 返回后，事件循环里可能还挂着与子进程相关的句柄，
    // 不退出就会留下一个"活着但什么都不干"的进程——实测它仍占着一个事件消费者，
    // 于是同一条手机消息会被**两个进程各执行一次**（去重账本是进程内的，挡不住跨进程）。
    // 日志用 appendFileSync + 重定向到文件的 stderr，都是同步写，exit 不会丢日志。
    process.exitCode = code
    process.exit(code)
  }, error => {
    process.stderr.write(maskSecrets(`桥接器崩溃：${String(error?.stack ?? error)}`) + '\n')
    process.exit(1)
  })
}
