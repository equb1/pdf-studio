/**
 * 事件订阅模式测试（`--source event`）。
 *
 * 这条路径的坑全在**子进程契约**上（来自 `lark-event` skill）：
 *   1. `event consume` 把 **stdin EOF 当退出信号** → 父进程必须用 pipe 且**永不 end**（用 `ignore` 会立刻退出）；
 *   2. 必须**等 stderr 的 ready 标记**再读 stdout（不能靠 sleep，也不能抢跑）；
 *   3. 停止只用 **SIGTERM + 关 stdin**，**绝不 kill -9**（有 PreConsume 钩子的 key 会漏服务端退订）。
 *
 * 这里用假 `spawn` 把三条契约都钉住；另外验证事件负载归一化（三种形状）与"事件→入队→去重"。
 *
 * Run: node --experimental-strip-types test/phone-bridge-event.test.mjs
 */

import { EventEmitter } from 'node:events'
import { Ledger } from '../scripts/phone-bridge/core.ts'
import {
  normalizeEventMessage,
  parseNdjsonLine,
  isReadyLine,
} from '../scripts/phone-bridge/core.ts'
import { startEventSource, createBridge } from '../scripts/phone-bridge/main.mjs'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

/** 假子进程：三个流都是 EventEmitter，stdin 记录 end/kill 调用。 */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { ended: false, end() { this.ended = true } }
  child.kills = []
  child.kill = signal => { child.kills.push(signal); return true }
  child.exitCode = null
  child.close = code => { child.exitCode = code; child.emit('close', code) }
  return child
}

const CONFIG = {
  chatId: 'oc_x', identity: 'bot', larkCliPath: 'lark-cli', eventKey: 'im.message.receive_v1',
  allowedSenderIds: ['ou_me'], allowedSenderNames: [], prefix: '/pdf',
  outboxDir: '/tmp/pb-ev', maxAgeMs: 1800000, maxInstructionChars: 200,
  allowedExtensions: ['.pdf'], maxFileBytes: 1000, maxFilesPerTask: 2,
  statePath: '/tmp/pb-ev/state.json', dshPath: 'dsh', profile: 'headless', dshArgs: [],
  timeoutMs: 1000, pollMs: 1000, source: 'event',
}

const FLAT_EVENT = {
  message_id: 'om_1', chat_id: 'oc_x', chat_type: 'group', sender_id: 'ou_me',
  message_type: 'text', content: '/pdf 给 A.pdf 加页码', create_time: String(Date.now()),
}

// ── 1. 事件负载归一化 ─────────────────────────────────────────────────────
{
  const flat = normalizeEventMessage(FLAT_EVENT)
  check('扁平事件（im.message.receive_v1）：message_type → msg_type', flat.msg_type === 'text', JSON.stringify(flat))
  check('扁平事件：sender_id（只有 open_id，没有显示名）→ sender.id', flat.sender.id === 'ou_me' && flat.sender.name === undefined)
  check('扁平事件：content 是纯文本（**不做 fromjson**）', flat.content === '/pdf 给 A.pdf 加页码')

  const v2 = normalizeEventMessage({ event: { message_id: 'om_2', message_type: 'text', content: 'hi', sender_id: 'ou_2', create_time: '1' } })
  check('V2 信封（字段在 .event 下）也能归一化', v2.message_id === 'om_2' && v2.sender.id === 'ou_2')

  const oapi = normalizeEventMessage({ event: { message: { message_id: 'om_3', message_type: 'text', content: 'x', create_time: '2' }, sender: { sender_id: { open_id: 'ou_3' }, name: '陈凡一' } } })
  check('原始 OAPI 形状（sender 挂在信封上）也能取到 open_id 与名字',
    oapi.message_id === 'om_3' && oapi.sender.id === 'ou_3' && oapi.sender.name === '陈凡一', JSON.stringify(oapi.sender))

  check('非消息事件（如 chat 变更）返回 undefined', normalizeEventMessage({ event: { chat_id: 'oc_x' } }) === undefined)
  check('缺 message_id 返回 undefined', normalizeEventMessage({ message_type: 'text', content: 'x' }) === undefined)
  check('卡片消息的 content 保持原样（由上层按 msg_type 拒绝）',
    normalizeEventMessage({ message_id: 'om_4', message_type: 'interactive', content: '{"a":1}' }).msg_type === 'interactive')
}

// ── 2. NDJSON 与就绪标记 ─────────────────────────────────────────────────
{
  check('NDJSON：正常行解析成对象', parseNdjsonLine('{"a":1}')?.a === 1)
  check('NDJSON：坏行/空行返回 undefined（脏数据只跳过，不整体崩）',
    parseNdjsonLine('{不是 JSON') === undefined && parseNdjsonLine('   ') === undefined && parseNdjsonLine('not-json') === undefined)
  check('就绪标记识别', isReadyLine('[event] ready event_key=im.message.receive_v1', 'im.message.receive_v1'))
  check('非就绪的 stderr 行不算就绪', !isReadyLine('[event] connecting...', 'im.message.receive_v1'))
}

// ── 3. 子进程契约 ────────────────────────────────────────────────────────
{
  const child = fakeChild()
  const calls = []
  const spawnImpl = (command, args, options) => { calls.push({ command, args, options }); return child }
  const received = []
  const logs = []
  const source = startEventSource(CONFIG, {
    spawnImpl, logger: line => logs.push(line), onMessage: message => received.push(message),
  })

  check('命令是 lark-cli event consume <key> --as <identity>',
    calls[0].command === 'lark-cli' && calls[0].args.join(' ') === 'event consume im.message.receive_v1 --as bot', calls[0].args.join(' '))
  check('**stdin 必须是 pipe**（用 ignore 会因 EOF 立刻退出）', calls[0].options.stdio[0] === 'pipe', JSON.stringify(calls[0].options.stdio))

  // 就绪前投递：必须被缓冲，不能抢跑
  child.stdout.emit('data', JSON.stringify(FLAT_EVENT) + '\n')
  check('ready 之前收到的事件先缓冲（不抢跑）', received.length === 0, String(received.length))

  child.stderr.emit('data', '[event] ready event_key=im.message.receive_v1\n')
  await source.ready
  check('等 stderr 的 ready 标记后才算就绪', logs.some(line => line.includes('事件订阅已就绪')), logs.join(' | '))
  check('就绪后把缓冲的事件补投递', received.length === 1 && received[0].message_id === 'om_1', String(received.length))

  child.stdout.emit('data', JSON.stringify({ ...FLAT_EVENT, message_id: 'om_2' }) + '\n')
  child.stdout.emit('data', '垃圾行\n')
  child.stdout.emit('data', JSON.stringify({ event: { chat_id: 'oc_x' } }) + '\n')   // 非消息事件
  check('后续事件继续投递，脏行与非消息事件被跳过', received.length === 2 && received[1].message_id === 'om_2', String(received.length))

  source.stop()
  check('停止时先关 stdin（触发它自己的退出路径）', child.stdin.ended === true)
  check('停止用 SIGTERM，**绝不 SIGKILL**', child.kills.includes('SIGTERM') && !child.kills.includes('SIGKILL'), child.kills.join(','))
}

// ── 4. 就绪前失败 / 退出回调 ─────────────────────────────────────────────
{
  const child = fakeChild()
  const exits = []
  const source = startEventSource(CONFIG, { spawnImpl: () => child, logger: () => {}, onMessage: () => {}, onExit: code => exits.push(code) })
  child.emit('error', new Error('权限不足'))
  check('就绪前出错 → ready 被 reject（不会假装在跑）',
    await source.ready.then(() => false, error => String(error).includes('权限不足')))

  const child2 = fakeChild()
  const exits2 = []
  const source2 = startEventSource(CONFIG, { spawnImpl: () => child2, logger: () => {}, onMessage: () => {}, onExit: code => exits2.push(code) })
  child2.stderr.emit('data', '[event] ready event_key=im.message.receive_v1\n')
  await source2.ready
  child2.close(0)
  check('退出时回调 onExit（供主循环决定是否重启）', exits2.join(',') === '0', exits2.join(','))
}

// ── 5. 有界模式（--once 用）与事件→入队 ─────────────────────────────────
{
  const child = fakeChild()
  const calls = []
  startEventSource(CONFIG, { spawnImpl: (c, a, o) => { calls.push({ args: a, options: o }); return child }, logger: () => {}, onMessage: () => {}, bounded: true })
  check('有界模式追加 --max-events 1 --timeout 10m（配合 --once 退出）',
    calls[0].args.join(' ').includes('--max-events 1 --timeout 10m'), calls[0].args.join(' '))

  const queued = []
  const ledger = new Ledger()
  const bridge = createBridge(
    { ...CONFIG, source: 'event', dryRun: false },
    {
      logger: () => {},
      ledger,
      persist: () => {},
      now: () => Date.now(),
      lark: { listMessages: async () => [], sendText: async () => true, sendFile: async () => true },
      runner: async () => { queued.push('ran'); return { code: 0, stdout: '', stderr: '', timedOut: false } },
    },
  )
  const normalized = normalizeEventMessage(FLAT_EVENT)
  check('事件 → handleMessage 接受并入队', bridge.handleMessage(normalized) === 'accepted', ledger.statusOf('om_1'))
  check('同一事件再投递 → duplicate（按 message_id 去重）', bridge.handleMessage(normalized) === 'duplicate')
  check('非白名单事件 → ignored', bridge.handleMessage({ ...normalized, message_id: 'om_9', sender: { id: 'ou_other' } }) === 'ignored')
}

console.log(`\n${failed === 0 ? 'ALL PHONE-BRIDGE EVENT CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
