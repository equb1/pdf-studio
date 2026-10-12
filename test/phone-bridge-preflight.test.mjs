/**
 * 上线自检（`--preflight`）测试。
 *
 * 这条命令的价值在于"差旅前把能自动查的都查掉"，所以测试重点有两个：
 *   1. **它绝不能有副作用**——发送项必须用 `--dry-run`（不真发消息）、也不许跑任务；
 *   2. 每一项失败都要给出**可直接照做的修复提示**，并且整体退出码要能反映通过与否。
 *
 * Run: node --experimental-strip-types test/phone-bridge-preflight.test.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig, renderPreflightReport } from '../scripts/phone-bridge/core.ts'
import { preflight } from '../scripts/phone-bridge/main.mjs'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

const WORK = mkdtempSync(join(tmpdir(), 'pb-pre-'))
const FUTURE = new Date(Date.now() + 86_400_000).toISOString()
const baseConfig = over =>
  ({ ...normalizeConfig({ chatId: 'oc_x', allowedSenderIds: ['ou_me'], outboxDir: join(WORK, 'outbox') }), ...over })

/** 收集 stdout 后再跑 preflight，避免测试输出被报告淹没。 */
async function runPreflight(config, runner) {
  const chunks = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = chunk => { chunks.push(String(chunk)); return true }
  try {
    const code = await preflight(config, { runner })
    return { code, text: chunks.join('') }
  } finally {
    process.stdout.write = original
  }
}

try {
  // ── 1. 报告渲染（纯逻辑） ───────────────────────────────────────────────
  {
    const allOk = renderPreflightReport([{ name: 'A', ok: true, detail: 'fine' }, { name: 'B', ok: true }])
    check('全部通过时给出"可以启动"的结论', allOk.ok === true && allOk.text.includes('全部通过'), allOk.text.split('\n').at(-1))
    const oneFail = renderPreflightReport([{ name: 'A', ok: true }, { name: 'B', ok: false, fix: '跑这条命令' }])
    check('有失败项时 ok=false 且计数正确', oneFail.ok === false && oneFail.text.includes('有 1 项没过'))
    check('失败项带可照做的修复提示', oneFail.text.includes('↳ 修复：跑这条命令'))
    check('通过/失败用不同符号区分', oneFail.text.includes('✅ A') && oneFail.text.includes('❌ B'))
  }

  // ── 2. 全部正常：退出码 0 ───────────────────────────────────────────────
  {
    const calls = []
    const runner = async (command, args) => {
      calls.push({ command, args })
      if (args[0] === 'config' && args[1] === 'show') return { code: 0, stdout: JSON.stringify({ appId: 'cli_x' }), stderr: '', timedOut: false }
      if (args[0] === 'auth' && args[1] === 'status') return { code: 0, stdout: JSON.stringify({ identities: { bot: { status: 'ready' }, user: { status: 'missing' } } }), stderr: '', timedOut: false }
      if (args[0] === 'im' && args[1] === '+chat-messages-list') return { code: 0, stdout: '{"ok":true,"identity":"user","data":{"messages":[]}}', stderr: '', timedOut: false }
      if (args[0] === 'im' && args[1] === '+messages-send') return { code: 0, stdout: '{"dryRun":true}', stderr: '', timedOut: false }
      if (args.includes('--help')) return { code: 0, stdout: 'Usage: dsh --profile headless [options] [task...]', stderr: '', timedOut: false }
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const { code, text } = await runPreflight(baseConfig(), runner)
    check('全部正常 → 退出码 0 且报告说"全部通过"', code === 0 && text.includes('全部通过'), `code=${code}`)
    check('检查了 lark-cli / 会话可读 / 发送 / dsh / outbox 五项以上',
      ['lark-cli 可用', '能读取目标会话的消息', '发送参数可用', 'dsh 可用', 'outbox 目录可写'].every(name => text.includes(name)),
      text.split('\n').filter(line => line.startsWith('✅') || line.startsWith('❌')).length + ' 项')

    const sendCall = calls.find(call => call.args[0] === 'im' && call.args[1] === '+messages-send')
    check('**发送检查必须带 --dry-run**（自检绝不真发消息）', sendCall.args.includes('--dry-run'), sendCall.args.join(' '))
    check('发送检查带上了目标 chat-id', sendCall.args.includes('--chat-id') && sendCall.args.includes('oc_x'))
    const dshCall = calls.find(call => call.args.includes('--help'))
    check('dsh 检查用 --profile <p> --help（只验证可用性，不跑任务）',
      dshCall.args.join(' ').includes('--profile') && !dshCall.args.some(arg => arg.includes('任务')), dshCall.args.join(' '))
    check('自检不调用 lark-cli event / 不执行任务正文', !calls.some(call => call.args[0] === 'event'))
  }

  // ── 3. 授权过期 ─────────────────────────────────────────────────────────
  {
    const runner = async (command, args) => {
      if (args[0] === 'config') return { code: 0, stdout: JSON.stringify({ appId: 'cli_x' }), stderr: '', timedOut: false }
      if (args[0] === 'auth') return { code: 0, stdout: JSON.stringify({ identities: { bot: { status: 'ready' }, user: { status: 'missing', expiresAt: '2026-05-26T16:04:01+08:00' } } }), stderr: '', timedOut: false }
      if (args.includes('--help')) return { code: 0, stdout: 'Usage: dsh', stderr: '', timedOut: false }
      return { code: 0, stdout: '{}', stderr: '', timedOut: false }
    }
    const { code, text } = await runPreflight(baseConfig(), runner)
    check('bot 身份：**不因 user token 过期而失败**（bot 本就不需要 auth login）',
      code === 0 && text.includes('bot 身份就绪') && !text.includes('lark-cli auth login'), text.split('\n').find(line => line.includes('身份')) ?? '')
    const asUser = await runPreflight(baseConfig({ identity: 'user' }), runner)
    check('user 身份：授权过期 → 失败并给出 auth login 命令',
      asUser.code === 1 && asUser.text.includes('user 身份就绪') && asUser.text.includes('lark-cli auth login'), '')
  }

  // ── 4. 读不到会话 / dsh 不可用 / outbox 不可写 ──────────────────────────
  {
    const runner = async (command, args) => {
      if (args[0] === 'config') return { code: 0, stdout: JSON.stringify({ appId: 'cli_x' }), stderr: '', timedOut: false }
      if (args[0] === 'auth') return { code: 0, stdout: JSON.stringify({ identities: { bot: { status: 'ready' }, user: { status: 'ready' } } }), stderr: '', timedOut: false }
      if (args[1] === '+chat-messages-list') return { code: 1, stdout: '', stderr: 'permission denied: im:message:readonly', timedOut: false }
      if (args.includes('--help')) return { code: 127, stdout: '', stderr: 'dsh: command not found', timedOut: false }
      return { code: 0, stdout: '{}', stderr: '', timedOut: false }
    }
    // outbox 指向一个"文件下面"的路径 → mkdir 必然失败
    const blocker = join(WORK, 'blocker')
    writeFileSync(blocker, 'x')
    const { code, text } = await runPreflight(baseConfig({ outboxDir: join(blocker, 'nope') }), runner)
    check('读不到会话 → 失败并提示检查 chat_id/权限', text.includes('能读取目标会话的消息') && text.includes('im:message:readonly'), '')
    check('dsh 不可用 → 失败并指向 §4.1（插件叠加）', text.includes('dsh 可用') && text.includes('§4.1'), '')
    check('outbox 不可写 → 失败并给出目录', text.includes('outbox 目录可写') && text.includes('blocker'), '')
    check('多项失败 → 退出码 1', code === 1, `code=${code}`)
  }

  // ── 5. 事件模式的额外提醒 ───────────────────────────────────────────────
  {
    const runner = async (command, args) => {
      if (args[0] === 'config') return { code: 0, stdout: JSON.stringify({ appId: 'cli_x' }), stderr: '', timedOut: false }
      if (args[0] === 'auth') return { code: 0, stdout: JSON.stringify({ identities: { bot: { status: 'ready' }, user: { status: 'ready' } } }), stderr: '', timedOut: false }
      if (args.includes('--help')) return { code: 0, stdout: 'Usage: dsh', stderr: '', timedOut: false }
      return { code: 0, stdout: '{}', stderr: '', timedOut: false }
    }
    const eventCalls = []
    const eventRunner = async (command, args) => { eventCalls.push(args.join(' ')); return runner(command, args) }
    const { text } = await runPreflight(baseConfig({ source: 'event', eventKey: 'im.message.receive_v1' }), eventRunner)
    check('事件模式不调用「读消息列表」（bot 身份读列表会 230027，是预期）',
      !eventCalls.some(call => call.includes('+chat-messages-list')) && text.includes('不需要读消息列表接口'), eventCalls.join(' | ').slice(0, 80))
    check('事件模式会额外提示"需飞书侧配置事件订阅"（本地无法判定）',
      text.includes('事件模式前置') && text.includes('im.message.receive_v1'), '')
    const pollText = (await runPreflight(baseConfig(), runner)).text
    check('轮询模式不显示该提示', !pollText.includes('事件模式前置'))
  }
} finally {
  rmSync(WORK, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'ALL PHONE-BRIDGE PREFLIGHT CHECKS PASSED' : `${failed} check(s) FAILED`}`)
if (failed > 0) process.exitCode = 1
