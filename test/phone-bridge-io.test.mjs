/**
 * 手机远控桥（I/O 接线层）测试：参数解析、配置加载、目录扫描、子进程执行、lark-cli 参数拼装、
 * 以及**轮询编排**（入队即记账、失败不阻塞）。
 *
 * 这里有一条**安全回归测试**最重要：`runCommand` 必须用 `spawn`（不开 shell），
 * 所以消息里带 `; touch xxx` 时那个文件绝不能出现——一旦有人把实现改成 `shell: true`，
 * 这条断言会立刻变红。
 *
 * 全部用例都不联网、不跑真实 dsh、不读写真实飞书。
 *
 * Run: node --experimental-strip-types test/phone-bridge-io.test.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../scripts/phone-bridge/core.ts'
import {
  collectExpiredOutbox,
  createBridge,
  loadConfig,
  makeLarkAdapter,
  parseArgs,
  runCommand,
  runTask,
  scanFiles,
} from '../scripts/phone-bridge/main.mjs'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
/** 进程是否还活着（发 0 号信号：ESRCH 表示已退出）。 */
const isAlive = pid => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const throws = fn => {
  try { fn(); return false } catch { return true }
}
const WORK = mkdtempSync(join(tmpdir(), 'pb-io-'))
/** 从提示词里取出这次任务的 outbox 目录（用于断言留档文件）。 */
const outboxOf = argv => {
  const match = /(\/[^\s"]+\/t-[^\s"]+)\//u.exec(String(argv.at(-1)))
  return match === null ? '' : match[1]
}

try {
  // ── 1. 参数解析 ─────────────────────────────────────────────────────────
  {
    const empty = parseArgs([])
    check('默认：无常驻标志、不 dry-run', empty.once === false && empty.dryRun === false && empty.selfTest === false)
    const full = parseArgs(['--config', '/tmp/x.json', '--once', '--dry-run'])
    check('--config 取值 / --once / --dry-run', full.config === '/tmp/x.json' && full.once && full.dryRun)
    check('--self-test 与 --help', parseArgs(['--self-test']).selfTest && parseArgs(['-h']).help)
  }

  // ── 2. 配置加载：相对路径按配置文件所在目录解析 ─────────────────────────
  {
    const dir = join(WORK, 'cfg1')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'pb.json')
    writeFileSync(path, JSON.stringify({
      chatId: 'oc_x',
      allowedSenderIds: ['ou_me'],
      outboxDir: 'out',
      statePath: 'state.json',
      logPath: 'bridge.log',
    }))
    const config = loadConfig(path)
    check('相对 outboxDir 解析成配置目录下的绝对路径', config.outboxDir === join(dir, 'out'), config.outboxDir)
    check('相对 statePath / logPath 同样解析', config.statePath === join(dir, 'state.json') && config.logPath === join(dir, 'bridge.log'))
    check('绝对路径保持原样', loadConfig(path).outboxDir.startsWith('/'))

    const noAllow = join(dir, 'no-allow.json')
    writeFileSync(noAllow, JSON.stringify({ chatId: 'oc_x', outboxDir: 'out' }))
    check('配置缺白名单 → 抛错（fail-closed）', throws(() => loadConfig(noAllow)))
    check('配置文件不存在 → 抛错', throws(() => loadConfig(join(dir, 'nope.json'))))
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ 不是 JSON')
    check('配置不是合法 JSON → 抛错', throws(() => loadConfig(bad)))
  }

  // ── 3. 目录扫描 ─────────────────────────────────────────────────────────
  {
    const dir = join(WORK, 'outbox')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    mkdirSync(join(dir, '.hidden'), { recursive: true })
    writeFileSync(join(dir, 'a.pdf'), 'x')
    writeFileSync(join(dir, 'sub', 'b.pdf'), 'yy')
    writeFileSync(join(dir, '.hidden', 'c.pdf'), 'zzz')
    const files = scanFiles(dir).map(entry => entry.path.replace(dir + '/', '')).sort()
    check('递归扫描到子目录文件', files.includes('sub/b.pdf'), files.join(','))
    check('跳过隐藏目录', !files.some(path => path.includes('.hidden')), files.join(','))
    check('带出 size/mtime（产物筛选要用）', scanFiles(dir).every(entry => typeof entry.size === 'number' && typeof entry.mtimeMs === 'number'))
    check('目录不存在时返回空数组（不抛）', scanFiles(join(WORK, 'nope')) .length === 0)
    check('深度上限生效', scanFiles(dir, 0).map(entry => entry.path.replace(dir + '/', '')).join(',') === 'a.pdf')
  }

  // ── 4. 子进程执行：**不开 shell** 的安全回归 ─────────────────────────────
  {
    const marker = join(WORK, `pwned-${Date.now()}`)
    const hostile = `; touch ${marker} && echo 注入成功`
    const result = await runCommand('/bin/echo', [hostile])
    check('恶意参数被当作普通字符串原样输出', result.stdout.trim() === hostile, result.stdout.trim().slice(0, 60))
    check('没有被执行：注入标记文件不存在（spawn 未开 shell）', !existsSync(marker))
    check('退出码为 0', result.code === 0)

    const failing = await runCommand('/bin/sh', ['-c', 'echo 出错信息 >&2; exit 3'])
    check('非零退出码与 stderr 都被捕获', failing.code === 3 && failing.stderr.includes('出错信息'))
    check('命令不存在时给出 code -1 与错误信息', (await runCommand('/nonexistent-cmd-xyz', [])).code === -1)

    const slow = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 300 })
    check('超时会杀掉子进程并标记 timedOut', slow.timedOut === true)
  }

  // ── 4b. 超时杀**进程组**（真进程验证：孤儿不能留） ──────────────────────
  {
    const slow = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300, killTree: true, graceMs: 200 })
    check('killTree：超时后标记 timedOut', slow.timedOut === true)
    check('killTree：进程组被杀干净（对 pid 发 0 号信号应抛 ESRCH）',
      typeof slow.pid === 'number' ? !isAlive(slow.pid) : true, `pid=${slow.pid}`)
  }

  // ── 5. lark-cli 参数拼装（注入假 runner，断言真实 argv） ─────────────────
  {
    const calls = []
    // 调用顺序：①拉消息 ②发文本 ③发文件（成功） ④发文件（失败）
    const codes = [0, 0, 0, 1]
    const runner = async (command, args, options) => {
      const code = codes[calls.length] ?? 0
      calls.push({ command, args, code, options })
      return { code, stdout: JSON.stringify({ ok: true, identity: 'user', data: { messages: [{ message_id: 'om_1' }] } }), stderr: code === 0 ? '' : 'boom', timedOut: false }
    }
    const logs = []
    const config = { chatId: 'oc_test', identity: 'bot', readIdentity: 'user', larkCliPath: '/usr/local/bin/lark-cli' }
    const adapter = makeLarkAdapter(config, line => logs.push(line), runner)

    const messages = await adapter.listMessages(Date.parse('2026-10-10T00:00:00Z'))
    check('拉消息：命令是 lark-cli', calls[0].command === '/usr/local/bin/lark-cli')
    check('拉消息：argv 含 im +chat-messages-list / --chat-id / --format json',
      calls[0].args.slice(0, 3).join(' ') === 'im +chat-messages-list --chat-id' && calls[0].args.includes('json'),
      calls[0].args.join(' '))
    check('拉消息：--start 传 ISO 时间', calls[0].args.includes('--start') && calls[0].args[calls[0].args.indexOf('--start') + 1].startsWith('2026-10-10'), calls[0].args[calls[0].args.indexOf('--start') + 1])
    check('拉消息用 readIdentity（--as user，群消息含文件必须 user 身份）', calls[0].args.at(-1) === 'user' && calls[0].args.at(-2) === '--as', calls[0].args.at(-2) + ' ' + calls[0].args.at(-1))
    check('拉消息：解析出 messages 数组', Array.isArray(messages) && messages[0].message_id === 'om_1')

    await adapter.sendText('回执文本', 'k-1')
    check('发文本：argv 含 --text 与 --idempotency-key', calls[1].args.includes('--text') && calls[1].args.includes('--idempotency-key'))
    check('发文本：文本与幂等键按位传入', calls[1].args[calls[1].args.indexOf('--text') + 1] === '回执文本' && calls[1].args[calls[1].args.indexOf('--idempotency-key') + 1] === 'k-1')
    check('发消息仍用 identity（--as bot，回执看起来像机器人发的）', calls[1].args.at(-1) === 'bot', String(calls[1].args.at(-1)))
    await adapter.sendFile('/tmp/结果.pdf', 'k-2')
    const fileArg = calls[2].args[calls[2].args.indexOf('--file') + 1]
    check('发文件：`--file` 必须是**相对文件名**（绝对路径会被 CLI 以 exit 2 拒绝）',
      fileArg === '结果.pdf' && !fileArg.startsWith('/'), fileArg)
    check('发文件：cwd 设为文件所在目录（配合相对路径）', calls[2].options?.cwd === '/tmp', String(calls[2].options?.cwd))
    check('非零退出码：返回 false 并记日志', (await adapter.sendFile('/tmp/坏.pdf')) === false && logs.some(line => line.includes('发送文件失败')), logs.at(-1)?.slice(0, 40))
  }

  // ── 6. 轮询编排：入队即记账、去重、失败不阻塞 ───────────────────────────
  {
    const now = () => Date.now()
    const messages = [
      { message_id: 'om_ok', msg_type: 'text', content: JSON.stringify({ text: '/pdf 加页码' }), sender: { id: 'ou_me' }, create_time: String(now()) },
      { message_id: 'om_stranger', msg_type: 'text', content: JSON.stringify({ text: '/pdf 乱指挥' }), sender: { id: 'ou_other' }, create_time: String(now()) },
      { message_id: 'om_noprefix', msg_type: 'text', content: JSON.stringify({ text: '闲聊' }), sender: { id: 'ou_me' }, create_time: String(now()) },
    ]
    const config = {
      chatId: 'oc_x', allowedSenderIds: ['ou_me'], allowedSenderNames: [], prefix: '/pdf',
      outboxDir: join(WORK, 'outbox2'), maxAgeMs: 1800000, maxInstructionChars: 200,
      allowedExtensions: ['.pdf'], maxFileBytes: 1000, maxFilesPerTask: 2,
      statePath: join(WORK, 'state2.json'), dshPath: 'dsh', profile: 'headless',
      timeoutMs: 1000, pollMs: 1000, identity: 'bot', larkCliPath: 'lark-cli',
    }
    const logs = []
    let persists = 0
    const sent = []
    const ledger = new Ledger()
    const bridge = createBridge(config, {
      logger: line => logs.push(line),
      ledger,
      persist: () => { persists += 1 },
      now,
      lark: {
        listMessages: async () => messages,
        sendText: async text => { sent.push(text); return true },
        sendFile: async () => true,
      },
      runner: async (_command, argv) => {
        const match = /(\/[^\s"]+\/t-[^\s"]+)\//u.exec(argv.at(-1))
        if (match !== null) {
          mkdirSync(match[1], { recursive: true })
          writeFileSync(join(match[1], 'out.pdf'), '%PDF-1.4')
        }
        return { code: 0, stdout: '已完成', stderr: '', timedOut: false }
      },
    })
    const accepted = await bridge.pollOnce()
    check('只接受白名单 + 带前缀的那一条', accepted === 1, String(accepted))
    check('非白名单被忽略并记日志', logs.some(line => line.includes('不在白名单')), logs.find(line => line.includes('不在白名单')))
    check('没有前缀的闲聊不记日志（避免噪音）', !logs.some(line => line.includes('没有以')))
    check('入队即记账（状态 queued）', ledger.statusOf('om_ok') !== undefined, String(ledger.statusOf('om_ok')))
    check('入队后立即持久化一次', persists >= 1, String(persists))

    while (bridge.queue.size > 0) await new Promise(resolveWait => setTimeout(resolveWait, 20))
    check('任务执行完把状态更新为 ok', ledger.statusOf('om_ok') === 'ok', String(ledger.statusOf('om_ok')))
    check('先回了「已收到」（任务可能要跑几分钟，不让人干等）',
      sent.some(text => text.includes('收到，开始处理')), sent[0]?.split('\n')[0] ?? '')
    check('完成后回了带完成标记的回执',
      sent.some(text => text.includes('✅ 完成')), sent.map(text => text.split('\n')[0]).join(' | ').slice(0, 100))

    const again = await bridge.pollOnce()
    check('第二轮轮询不重复执行同一条消息（去重）', again === 0, String(again))

    // 机器人自己的回执会被轮询到 → 必然不在白名单，但不该刷日志（常驻服务会被自己刷爆）
    const quietLogs = []
    const quiet = createBridge(config, {
      logger: line => quietLogs.push(line), ledger: new Ledger(), persist: () => {}, now,
      lark: { listMessages: async () => [], sendText: async () => true, sendFile: async () => true },
      runner: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    })
    const appMessage = { message_id: 'om_bot_receipt', msg_type: 'text', content: '✅ 完成', chat_id: 'oc_x', create_time: String(Date.now()), sender: { id: 'cli_aa9f', id_type: 'app_id', sender_type: 'app' } }
    check('机器人自己的消息：仍被忽略，但**不写日志**',
      quiet.handleMessage(appMessage) === 'ignored' && !quietLogs.some(line => line.includes('不在白名单')), quietLogs.join(' | '))
    const humanMessage = { ...appMessage, message_id: 'om_other_human', sender: { id: 'ou_other', id_type: 'open_id', sender_type: 'user' } }
    quiet.handleMessage(humanMessage)
    check('陌生人的消息仍然记日志（可追溯）', quietLogs.some(line => line.includes('不在白名单')), quietLogs.join(' | '))

    const failing = createBridge(config, {
      logger: () => {},
      ledger: new Ledger(),
      persist: () => {},
      now,
      lark: { listMessages: async () => { throw new Error('网络断了') }, sendText: async () => true, sendFile: async () => true },
    })
    check('拉消息失败不抛异常（返回 0，桥接器继续活着）', (await failing.pollOnce()) === 0)
  }

  // ── 7. 任务结果：超时与失败都要有回执 ───────────────────────────────────
  {
    const config = {
      chatId: 'oc_x', allowedSenderIds: ['ou_me'], allowedSenderNames: [], prefix: '/pdf',
      outboxDir: join(WORK, 'outbox3'), maxAgeMs: 1800000, maxInstructionChars: 200,
      allowedExtensions: ['.pdf'], maxFileBytes: 1000, maxFilesPerTask: 2,
      statePath: join(WORK, 'state3.json'), dshPath: 'dsh', profile: 'headless',
      timeoutMs: 1000, pollMs: 1000, identity: 'bot', larkCliPath: 'lark-cli',
    }
    const instruction = { messageId: 'om_t', chatId: 'oc_x', createdAtMs: Date.now(), text: '加页码' }
    const sent = []
    const lark = { listMessages: async () => [], sendText: async text => { sent.push(text); return true }, sendFile: async () => true }

    const timedOut = await runTask(config, instruction, {
      logger: () => {}, ledger: new Ledger(), lark,
      runner: async () => ({ code: -1, stdout: '', stderr: '', timedOut: true }),
    })
    // 回归：任务正文必须是**最后一个位置参数**，且不能出现多余字面量
    let seenArgv = []
    let seenOptions = {}
    const sentArgv = []   // 独立记录器：不要借共享的 sent，否则会打乱后面"超时/失败回执"的断言
    await runTask({ ...config, dshArgs: ['--patch', '/tmp/p.yml'] }, instruction, {
      logger: () => {}, ledger: new Ledger(),
      lark: { listMessages: async () => [], sendText: async text => { sentArgv.push(text); return true }, sendFile: async () => true },
      runner: async (_command, argv, options) => { seenArgv = argv; seenOptions = options; return { code: 0, stdout: '', stderr: '', timedOut: false } },
    })
    check('调用 dsh 时带 killTree（超时要连子进程一起杀）', seenOptions.killTree === true, JSON.stringify(seenOptions))
    check('agent 输出被留档（.log 不在回传白名单，不会发给用户）',
      existsSync(join(outboxOf(seenArgv), 'agent-output.log')), outboxOf(seenArgv))
    check('argv 形如 [--profile, headless, ...dshArgs, 提示词]',
      seenArgv[0] === '--profile' && seenArgv[1] === 'headless' && seenArgv[2] === '--patch' && seenArgv[3] === '/tmp/p.yml',
      seenArgv.slice(0, 4).join(' '))
    check('任务正文是最后一个参数，且不含多余的 headless 字面量',
      seenArgv.at(-1).includes('任务描述') && !seenArgv.slice(0, -1).includes('headless') === false && seenArgv.filter(item => item === 'headless' || item === 'profile').length === 1,
      String(seenArgv.filter(item => item === 'headless').length) + ' 个 headless')

        check('超时任务：状态 timeout', timedOut.status === 'timeout')
    check('超时任务：回执里写明超时', sent.at(-1).includes('⏱️ 超时'), sent.at(-1).split('\n')[0])

    const errored = await runTask(config, instruction, {
      logger: () => {}, ledger: new Ledger(), lark,
      runner: async () => ({ code: 1, stdout: '', stderr: 'dsh: profile not found', timedOut: false }),
    })
    check('失败任务：状态 error', errored.status === 'error')
    check('失败任务：回执里带上 stderr 摘要', sent.at(-1).includes('profile not found'), sent.at(-1).split('\n').at(-1))

    // 配置了「手机直下」时，回执里要能直接点开下载
    const withDownload = { ...config, downloadBaseUrl: 'http://100.1.2.3:19387', downloadToken: 'k'.repeat(24) }
    const sent2 = []
    await runTask(withDownload, instruction, {
      logger: () => {}, ledger: new Ledger(),
      lark: { listMessages: async () => [], sendText: async text => { sent2.push(text); return true }, sendFile: async () => true },
      runner: async (_command, argv) => {
        const match = /(\/[^\s"]+\/t-[^\s"]+)\//u.exec(argv.at(-1))
        if (match !== null) { mkdirSync(match[1], { recursive: true }); writeFileSync(join(match[1], 'r.pdf'), '%PDF-1.4') }
        return { code: 0, stdout: 'ok', stderr: '', timedOut: false }
      },
    })
    check('配置直下后：回执里带插件下载链接（含 token）',
      sent2.at(-1).includes('http://100.1.2.3:19387/api/pdf-studio/download?') && sent2.at(-1).includes('token='), sent2.at(-1)?.split('\n').slice(-2).join(' | '))
  }

  // ── 8. dry-run：只打印、不执行、不回传 ──────────────────────────────────
  {
    const config = {
      chatId: 'oc_x', allowedSenderIds: ['ou_me'], allowedSenderNames: [], prefix: '/pdf',
      outboxDir: join(WORK, 'outbox4'), maxAgeMs: 1800000, maxInstructionChars: 200,
      allowedExtensions: ['.pdf'], maxFileBytes: 1000, maxFilesPerTask: 2,
      statePath: join(WORK, 'state4.json'), dshPath: 'dsh', profile: 'headless',
      timeoutMs: 1000, pollMs: 1000, identity: 'bot', larkCliPath: 'lark-cli', dryRun: true,
    }
    const logs = []
    let ran = false
    const sent = []
    await runTask(config, { messageId: 'om_d', chatId: 'oc_x', createdAtMs: Date.now(), text: '加页码' }, {
      logger: line => logs.push(line),
      ledger: new Ledger(),
      lark: { listMessages: async () => [], sendText: async text => { sent.push(text); return true }, sendFile: async () => true },
      runner: async () => { ran = true; return { code: 0, stdout: '', stderr: '', timedOut: false } },
    })
    check('dry-run 不执行 dsh', ran === false)
    check('dry-run 不打开发送', sent.length === 0)
    check('dry-run 打印将执行的命令与提示词', logs.some(line => line.includes('[dry-run]') && line.includes('headless')), String(logs.length))
  }

  // ── 9. 背压：队列满了明确拒收（而不是静默堆积） ─────────────────────────
  {
    const config = {
      chatId: 'oc_x', allowedSenderIds: ['ou_me'], allowedSenderNames: [], prefix: '/pdf',
      outboxDir: join(WORK, 'outbox-bp'), maxAgeMs: 1800000, maxInstructionChars: 200,
      allowedExtensions: ['.pdf'], maxFileBytes: 1000, maxFilesPerTask: 2, maxQueueLength: 1,
      statePath: join(WORK, 'state-bp.json'), dshPath: 'dsh', profile: 'headless', dshArgs: [],
      timeoutMs: 1000, pollMs: 1000, identity: 'bot', larkCliPath: 'lark-cli',
    }
    const sent = []
    let release
    const gate = new Promise(resolve => { release = resolve })
    const bridge = createBridge(config, {
      logger: () => {}, ledger: new Ledger(), persist: () => {}, now: () => Date.now(),
      lark: { listMessages: async () => [], sendText: async text => { sent.push(text); return true }, sendFile: async () => true },
      // 第一个任务卡住不返回，好让队列一直处于"满"的状态
      runner: async () => { await gate; return { code: 0, stdout: '', stderr: '', timedOut: false } },
    })
    const first = bridge.handleMessage({ message_id: 'om_a', msg_type: 'text', content: '/pdf 一', sender: { id: 'ou_me' }, create_time: String(Date.now()) })
    const second = bridge.handleMessage({ message_id: 'om_b', msg_type: 'text', content: '/pdf 二', sender: { id: 'ou_me' }, create_time: String(Date.now()) })
    check('队列有空间 → 接受', first === 'accepted', first)
    check('队列已满 → 明确拒收（不是静默丢弃）', second === 'rejected', second)
    check('拒收时回一条"忙"回执', sent.some(text => text.includes('先没收') && text.includes('1/1')), sent.join(' | ').slice(0, 80))
    check('拒收状态记账（重启后不会被当成没处理过而重跑）', bridge.ledger.statusOf('om_b') === 'rejected-busy', String(bridge.ledger.statusOf('om_b')))
    release()
    while (bridge.queue.size > 0) await new Promise(resolveWait => setTimeout(resolveWait, 20))
    const third = bridge.handleMessage({ message_id: 'om_c', msg_type: 'text', content: '/pdf 三', sender: { id: 'ou_me' }, create_time: String(Date.now()) })
    check('队列腾空后恢复接受', third === 'accepted', third)
  }

  // ── 10. outbox 清理：只删自己命名的过期目录（真文件系统验证） ──────────
  {
    const outbox = join(WORK, 'outbox-gc')
    const old = join(outbox, 't-100-aaaaaa')
    const fresh = join(outbox, 't-200-bbbbbb')
    const foreign = join(outbox, '用户的资料')
    for (const dir of [old, fresh, foreign]) mkdirSync(dir, { recursive: true })
    const twentyDaysAgo = Date.now() / 1000 - 20 * 86400
    utimesSync(old, twentyDaysAgo, twentyDaysAgo)
    utimesSync(foreign, twentyDaysAgo, twentyDaysAgo)
    writeFileSync(join(outbox, 'note.txt'), 'x')

    const logs = []
    const config = { outboxDir: outbox, outboxRetentionDays: 14 }
    const removed = collectExpiredOutbox(config, { logger: line => logs.push(line), keep: [] })
    check('删掉了过期的任务目录', removed.length === 1 && removed[0] === old, removed.join(','))
    check('过期目录真的不在盘上了', !existsSync(old))
    check('**没有**碰目录名不认识的目录（哪怕它也很旧）', existsSync(foreign))
    check('没有碰新任务目录与普通文件', existsSync(fresh) && existsSync(join(outbox, 'note.txt')))
    check('清理有日志（可追溯）', logs.some(line => line.includes('已清理过期任务目录')), logs.join(' | '))

    // dry-run 只报告不删
    const dryDir = join(outbox, 't-300-cccccc')
    mkdirSync(dryDir, { recursive: true })
    utimesSync(dryDir, twentyDaysAgo, twentyDaysAgo)
    const dryRemoved = collectExpiredOutbox(config, { logger: () => {}, keep: [], dryRun: true })
    check('dry-run 只报告不删', dryRemoved.length === 1 && existsSync(dryDir), `removed=${dryRemoved.length}`)

    // keep（正在跑的任务）绝不动
    const keptRemoved = collectExpiredOutbox(config, { logger: () => {}, keep: [dryDir] })
    check('正在跑的任务目录不会被清（keep 生效）', keptRemoved.length === 0 && existsSync(dryDir))
    check('保留天数 0 → 直接返回空（不清理）', collectExpiredOutbox({ outboxDir: outbox, outboxRetentionDays: 0 }, { logger: () => {} }).length === 0)
  }

} finally {
  rmSync(WORK, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'ALL PHONE-BRIDGE IO CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
