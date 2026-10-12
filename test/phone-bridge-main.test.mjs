/**
 * `main()` 入口的端到端测试（用假 lark-cli + 假 dsh，不联网、不跑真 agent）。
 *
 * 为什么必须有这一层：`createBridge` / `runTask` / `preflight` 都测过了，但**入口函数本身没测**，
 * 结果真机首跑时 `main()` 在「事件模式 --once」分支上崩了（`stopping is not defined` ——
 * 早前一次重构把 `let stopping` 和信号处理整段吃掉了，而当时没断言）。文件里说的"跑得起来"
 * 只有真跑一次才算数，所以这里把**两种来源模式**都真跑一遍。
 *
 * 假的 lark-cli 会：stderr 打就绪标记、stdout 吐一条 NDJSON 事件、把发送调用追写到日志文件；
 * 假的 dsh 会把"产物"写进提示词里指定的 outbox 目录。
 *
 * Run: node --experimental-strip-types test/phone-bridge-main.test.mjs
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../scripts/phone-bridge/main.mjs'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

const WORK = mkdtempSync(join(tmpdir(), 'pb-main-'))
const SENT_LOG = join(WORK, 'sent.ndjson')

/** 假 lark-cli：按参数分派，全部离线。 */
const FAKE_LARK = `#!/bin/sh
ARGS="$*"
if [ "$1" = "config" ] && [ "$2" = "show" ]; then echo '{"appId":"cli_fake"}'; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"identities":{"bot":{"status":"ready"},"user":{"status":"ready"}}}'; exit 0; fi
if [ "$1" = "event" ] && [ "$2" = "consume" ]; then
  echo "[event] ready event_key=im.message.receive_v1" >&2
  printf '%s\\n' "$FAKE_EVENT_JSON"
  while true; do sleep 1; done
fi
if [ "$1" = "im" ] && [ "$2" = "+messages-mget" ]; then
  printf '%s\n' "$FAKE_MGET_JSON"
  exit 0
fi
if [ "$1" = "im" ] && [ "$2" = "+messages-resources-download" ]; then
  # 用 cwd + 相对 --output 落盘（与真实 CLI 的约束一致）
  printf '%%PDF-1.4 fake input' > "$FAKE_DOWNLOAD_NAME"
  echo '{"ok":true}'
  exit 0
fi
if [ "$1" = "im" ] && [ "$2" = "+messages-send" ]; then
  printf '%s\\n' "$ARGS" >> "$FAKE_SENT_LOG"
  case "$ARGS" in
    *"--file"*) if [ -n "$FAKE_FILE_FAIL" ]; then echo '{"ok":false,"error":{"message":"--file must be a relative path"}}'; exit 2; fi ;;
  esac
  echo '{"ok":true}'
  exit 0
fi
if [ "$1" = "im" ] && [ "$2" = "+chat-messages-list" ]; then
  printf '%s\\n' "$FAKE_POLL_JSON"
  exit 0
fi
echo '{"ok":true}'
exit 0
`

/** 假 dsh：把产物写进提示词里出现的 outbox/<taskId>/ 目录，并汇报。 */
const FAKE_DSH = `#!/bin/sh
for last in "$@"; do :; done
PROMPT="$last"
printf '%s' "$PROMPT" > "$FAKE_PROMPT_LOG"
DIR=$(printf '%s' "$PROMPT" | grep -o '/[^ "]*/t-[^ "]*/' | head -1)
mkdir -p "$DIR"
printf '%%PDF-1.4 fake bridge artifact' > "$DIR/产物.pdf"
echo "已完成：产物 $DIR产物.pdf"
exit 0
`

/** 注入假可执行文件与环境变量。 */
function installStubs() {
  const lark = join(WORK, 'fake-lark-cli')
  const dsh = join(WORK, 'fake-dsh')
  writeFileSync(lark, FAKE_LARK, { mode: 0o755 })
  writeFileSync(dsh, FAKE_DSH, { mode: 0o755 })
  process.env.FAKE_SENT_LOG = SENT_LOG
  return { lark, dsh }
}

const { lark, dsh } = installStubs()
const NOW = Date.now()
const EVENT = {
  message_id: 'om_e2e_1', chat_id: 'oc_e2e', sender_id: 'ou_me', message_type: 'text',
  content: '/pdf 给测试.pdf 加页码', create_time: String(NOW), chat_id: 'oc_e2e',
}
process.env.FAKE_EVENT_JSON = JSON.stringify(EVENT)
// 轮询接口的**真实形状**与事件不同：content 是 JSON 字符串、发送者在 sender.id 里
const POLL_MESSAGE = {
  message_id: 'om_e2e_1', msg_type: 'text', content: JSON.stringify({ text: '/pdf 给测试.pdf 加页码' }),
  sender: { id: 'ou_me', name: '陈凡一' }, create_time: String(NOW),
}
// **真实形状**：{ ok, identity, data: { messages } }（早先写成扁平形状，掩盖了真实解析 bug）
process.env.FAKE_POLL_JSON = JSON.stringify({ ok: true, identity: 'user', data: { messages: [POLL_MESSAGE] } })

function writeConfig(name, over) {
  const path = join(WORK, name)
  writeFileSync(path, JSON.stringify({
    chatId: 'oc_e2e',
    allowedSenderIds: ['ou_me'],
    allowedSenderNames: [],
    prefix: '/pdf',
    outboxDir: join(WORK, name.replace('.json', '') + '-outbox'),
    dshPath: dsh,
    profile: 'headless',
    identity: 'bot',
    larkCliPath: lark,
    timeoutMs: 30_000,
    pollMs: 200,
    statePath: join(WORK, name.replace('.json', '') + '-state.json'),
    logPath: join(WORK, name.replace('.json', '') + '-bridge.log'),
    ...over,
  }, null, 2))
  return path
}

try {
  // ── 1. 事件模式：等一条事件 → 执行 → 回传 → 记账（真跑 main()）───────────
  {
    const configPath = writeConfig('event.json', { source: 'event', eventKey: 'im.message.receive_v1' })
    const code = await main(['--config', configPath, '--once'])
    check('事件模式 --once：main() 正常返回 0（不再崩在入口）', code === 0, `code=${code}`)

    const outbox = join(WORK, 'event-outbox')
    const found = existsSync(outbox) ? readdirSync(outbox).filter(name => name.startsWith('t-')) : []
    check('事件触发后真的建了任务目录', found.length === 1, found.join(','))
    const artifact = found.length === 1 ? join(outbox, found[0], '产物.pdf') : ''
    check('假 dsh 的产物落在 outbox/<taskId>/ 下', artifact !== '' && existsSync(artifact), artifact)

    const sent = existsSync(SENT_LOG) ? readFileSync(SENT_LOG, 'utf8') : ''
    check('回传了文本回执（含完成标记）', sent.includes('--text') && sent.includes('完成'), sent.split('\n')[0]?.slice(0, 90))
    check('开始处理时先回一条「已收到」（不让人干等）', sent.includes('收到，开始处理'), sent.split('\n')[1]?.slice(0, 80) ?? '')
    check('回传了产物文件（--file 指向产物）', sent.includes('--file') && sent.includes('产物.pdf'), sent.split('\n').find(line => line.includes('--file'))?.slice(0, 90) ?? '（没有 --file 调用）')
    const state = JSON.parse(readFileSync(join(WORK, 'event-state.json'), 'utf8'))
    // 状态文件是 { ledger, pending }（兼容旧格式时整份就是账本）
    const ledgerEntries = state.ledger ?? state
    check('账本记为 ok（崩溃重启后不会重跑）', ledgerEntries.om_e2e_1?.status === 'ok', JSON.stringify(state).slice(0, 120))
    const log = readFileSync(join(WORK, 'event-bridge.log'), 'utf8')
    check('日志里有就绪、任务开始与结束', log.includes('事件订阅已就绪') && log.includes('开始') && log.includes('结束'), '')
  }

  // ── 2. 轮询模式：同样真跑一遍 main() ────────────────────────────────────
  {
    rmSync(SENT_LOG, { force: true })
    const configPath = writeConfig('poll.json', { source: 'poll' })
    const code = await main(['--config', configPath, '--once'])
    check('轮询模式 --once：main() 正常返回 0', code === 0, `code=${code}`)
    const sent = existsSync(SENT_LOG) ? readFileSync(SENT_LOG, 'utf8') : ''
    check('轮询模式同样能跑完并回传（且先回了「已收到」）', sent.includes('完成') && sent.includes('收到，开始处理'), sent.split('\n').length + ' 条发送')
    const outbox = join(WORK, 'poll-outbox')
    const found = existsSync(outbox) ? readdirSync(outbox).filter(name => name.startsWith('t-')) : []
    check('轮询模式也产出了任务目录', found.length === 1, found.join(','))
  }

  // ── 3. 重放同一条消息：去重（不会重复执行）─────────────────────────────
  {
    rmSync(SENT_LOG, { force: true })
    const configPath = writeConfig('poll.json', { source: 'poll' })
    const code = await main(['--config', configPath, '--once'])
    const sent = existsSync(SENT_LOG) ? readFileSync(SENT_LOG, 'utf8') : ''
    check('同一 message_id 再跑一次：不重复执行（账本已记）', code === 0 && sent === '', `code=${code} sent=${sent.slice(0, 40)}`)
  }
  // ── 3b. 手机发文件 → 下载 → 收到回执；再发指令 → 文件被带进任务 ──────────
  {
    const PROMPT_LOG = join(WORK, 'prompt.txt')
    const inboxState = join(WORK, 'attach-state.json')
    const attachmentConfig = writeConfig('attach.json', { source: 'event', statePath: inboxState })
    process.env.FAKE_PROMPT_LOG = PROMPT_LOG
    process.env.FAKE_DOWNLOAD_NAME = '输入.pdf'
    process.env.FAKE_MGET_JSON = JSON.stringify({
      ok: true,
      data: { messages: [{ message_id: 'om_file_1', msg_type: 'file', content: '<file key="file_v3_test" name="输入.pdf"/>' }] },
    })

    // ① 事件是"文件"消息 → 应当下载 + 回执 + 记账（不执行任务）
    rmSync(SENT_LOG, { force: true })
    process.env.FAKE_EVENT_JSON = JSON.stringify({
      message_id: 'om_file_1', chat_id: 'oc_e2e', sender_id: 'ou_me', message_type: 'file',
      content: '输入.pdf', create_time: String(Date.now()),
    })
    const first = await main(['--config', attachmentConfig, '--once'])
    const sentAfterFile = existsSync(SENT_LOG) ? readFileSync(SENT_LOG, 'utf8') : ''
    check('收到文件消息：main() 正常返回', first === 0, `code=${first}`)
    check('回了"已收到"引导消息（而不是直接执行任务）',
      sentAfterFile.includes('已收到') && sentAfterFile.includes('输入.pdf'), sentAfterFile.split('\n')[0]?.slice(0, 80))
    const inboxDir = join(WORK, 'attach-outbox', 'inbox', 'om_file_1')
    const landed = existsSync(inboxDir) ? readdirSync(inboxDir) : []
    check('附件被下载到 inbox/<messageId>/ 下', landed.includes('输入.pdf'), landed.join(','))
    const attachState = JSON.parse(readFileSync(inboxState, 'utf8'))
    check('账本记了附件、并记住了待处理输入',
      attachState.ledger?.om_file_1?.status === 'attachment' && attachState.pending?.length === 1, JSON.stringify(attachState).slice(0, 140))

    // ② 下一条是 /pdf 指令 → 提示词里要带上刚下载的文件路径
    rmSync(SENT_LOG, { force: true })
    process.env.FAKE_EVENT_JSON = JSON.stringify({
      message_id: 'om_text_2', chat_id: 'oc_e2e', sender_id: 'ou_me', message_type: 'text',
      content: '/pdf 给这份文件加页码', create_time: String(Date.now()),
    })
    const second = await main(['--config', attachmentConfig, '--once'])
    const prompt = existsSync(PROMPT_LOG) ? readFileSync(PROMPT_LOG, 'utf8') : ''
    check('第二条指令正常执行', second === 0, `code=${second}`)
    check('**提示词里带上了刚发来的文件路径**（两段式用法生效）',
      prompt.includes(join(inboxDir, '输入.pdf')), prompt.includes('inbox') ? '含 inbox 路径' : '提示词里没有输入文件')
    check('提示词同时说明"这是源文件、不要覆盖"', prompt.includes('不要覆盖'), '')
    const afterState = JSON.parse(readFileSync(inboxState, 'utf8'))
    check('用过的输入被清空（不会混进下一个任务）', (afterState.pending ?? []).length === 0, JSON.stringify(afterState.pending ?? []))
  }

  // ── 3c. 产物发送失败 → 必须明确告知（不能只说"产物 N 个"却收不到文件）────────
  {
    const cfg = writeConfig('failfile.json', { source: 'poll', statePath: join(WORK, 'failfile-state.json') })
    rmSync(SENT_LOG, { force: true })
    process.env.FAKE_FILE_FAIL = '1'
    process.env.FAKE_EVENT_JSON = JSON.stringify({
      message_id: 'om_failfile_1', chat_id: 'oc_e2e', sender_id: 'ou_me', message_type: 'text',
      content: '/pdf 加页码', create_time: String(Date.now()),
    })
    const code = await main(['--config', cfg, '--once'])
    const sent = existsSync(SENT_LOG) ? readFileSync(SENT_LOG, 'utf8') : ''
    check('发文件失败时：群里收到明确的失败说明（含本机路径）',
      code === 0 && sent.includes('没能发到飞书') && sent.includes('本机'), sent.split('\n').filter(line => line.includes('没能发到飞书')).join('').slice(0, 90))
    delete process.env.FAKE_FILE_FAIL
  }

  // ── 4. 真作为子进程跑 `--once`：必须自己退出（曾经会挂住，还多占一个事件消费者）──
  {
    const { spawn } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const configPath = writeConfig('child.json', { source: 'event', eventKey: 'im.message.receive_v1', statePath: join(WORK, 'child-state.json') })
    const started = Date.now()
    const child = spawn(process.execPath, ['--experimental-strip-types', 'scripts/phone-bridge/main.mjs', '--config', configPath, '--once'], {
      cwd: repo,
      env: { ...process.env, FAKE_EVENT_JSON: JSON.stringify({ ...EVENT, message_id: 'om_child_1' }), FAKE_SENT_LOG: SENT_LOG },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const outcome = await new Promise(resolveWait => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolveWait({ code: 'timeout', ms: Date.now() - started }) }, 30_000)
      child.on('close', code => { clearTimeout(timer); resolveWait({ code, ms: Date.now() - started }) })
    })
    check('作为子进程跑 --once：自己在 30s 内退出（曾经会挂住不退出）',
      outcome.code === 0, `code=${outcome.code} 用时=${outcome.ms}ms`)
  }
} finally {
  rmSync(WORK, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'ALL PHONE-BRIDGE MAIN CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
