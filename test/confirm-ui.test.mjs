/**
 * 待确认操作 (pending-plan confirmation) UI tests.
 *
 * A destructive tool call must not happen because an agent decided it should:
 * the host writes the plan down, the surface lists it, and the plan only runs
 * after a person presses 确认执行. These tests are about that human gate, and
 * about the two ways it can rot — a plan that never reaches the screen, and a
 * plan whose title is parsed as HTML.
 *
 * The harness is the same shape as `canvas-ui.test.mjs`: build a jsdom document,
 * stub `fetch`, evaluate `public/app.js` for real, then drive it. One detail
 * worth knowing: `window.eval` from jsdom (without `runScripts`) runs the
 * surface in the NODE realm, so the globals the surface reads — `window`,
 * `document`, `fetch` — are assigned on `globalThis` before evaluating it. That
 * also means `globalThis.__DSH_PDF_STUDIO__` is exactly the object the host
 * would inject, which is why the absolute-apiBase case is tested by setting it.
 * The poll timer is jsdom's own (`window.setInterval`), so every scenario closes
 * its window; otherwise Node would never exit.
 *
 * Run: node --experimental-strip-types test/confirm-ui.test.mjs
 */

import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

const surface = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
const BASE = '/api/pdf-studio'

// A late promise touching a window this file has already closed would otherwise
// kill the process with a non-zero exit and hide every result below it.
process.on('unhandledRejection', error => {
  check('no unhandled rejection', false, String((error && error.message) || error))
})

/** A Response stand-in: only ok/status/json are read by the surface. */
const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const planFixture = (over = {}) => {
  const now = Date.now()
  return {
    planId: 'p_3f9a1c2b',
    tool: 'pdf_watermark',
    action: 'remove',
    title: '移除水印',
    gate: 'destructive',
    sheet: '文件：/tmp/合同.pdf\n动作：移除水印\n参数：全部页\n影响：原文件会被覆盖\n要改哪一项直接说',
    status: 'pending',
    createdAt: now,
    expiresAt: now + 15 * 60 * 1000,
    hints: ['只要第 1 页就说「pages: [1]」'],
    ambiguous: ['未指定水印文字'],
    // The host is free to add fields; the surface must tolerate them.
    unknownField: { nested: ['ignored', 42] },
    ...over,
  }
}

/** Windows opened by `mount`, closed by `run` so a failed scenario cannot hang. */
const openWindows = []

/**
 * Build a jsdom page, inject the surface, and return handles.
 *
 * `handle(url, options)` answers every request. `apiBase` is injected through
 * `globalThis.__DSH_PDF_STUDIO__` when given; when omitted the global is
 * deleted first, which is the web-shell fallback case.
 */
const mount = async (handle, { apiBase } = {}) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:19387/',
  })
  const { window } = dom
  openWindows.push(window)
  globalThis.window = window
  globalThis.document = window.document
  globalThis.HTMLElement = window.HTMLElement

  const calls = []
  let alerts = 0
  window.alert = () => { alerts += 1 }
  window.confirm = () => { alerts += 1; return true }
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: (options && options.method) || 'GET', options: options || {} })
    return handle(String(url), options || {})
  }

  if (apiBase === undefined) {
    delete globalThis.__DSH_PDF_STUDIO__
    delete window.__DSH_PDF_STUDIO__
  } else {
    // In a browser `window === globalThis`, so the host's injection is visible
    // both ways; here the surface runs in the Node realm and reads globalThis,
    // so it is set on both to stay faithful.
    globalThis.__DSH_PDF_STUDIO__ = { apiBase }
    window.__DSH_PDF_STUDIO__ = globalThis.__DSH_PDF_STUDIO__
  }

  window.eval(surface)

  const host = window.document.getElementById('dsh-pdf-studio-host')
  const shadow = host.shadowRoot
  const $ = id => shadow.getElementById(id)
  return {
    window,
    host,
    shadow,
    $,
    calls,
    get alertCount() { return alerts },
    /** Open the panel the way a user does; the panel owns the polling. */
    open: async () => { shadow.querySelector('.launcher').click(); await tick() },
    /** The text of the whole panel, for "this word is nowhere" assertions. */
    panelText: () => shadow.querySelector('.panel').textContent,
    css: () => shadow.querySelector('style').textContent,
  }
}

/** Run one scenario; a throw is reported as a failure, never as an abort. */
const run = async (name, body) => {
  try {
    await body()
  } catch (error) {
    check(`${name}: scenario ran without throwing`, false, String((error && error.message) || error))
  } finally {
    while (openWindows.length) {
      const window = openWindows.pop()
      try { window.close() } catch (error) { /* already closed */ }
    }
  }
}

console.log('confirm ui — 待确认操作\n')

// ── 1. a pending plan is listed ─────────────────────────────────────────────

await run('pending plan', async () => {
  const plan = planFixture()
  const s = await mount(url => (url.endsWith('/plans') ? json({ ok: true, plans: [plan] }) : json({ ok: true })))
  await tick()

  check('without an injected apiBase the relative path is used',
    s.calls[0] && s.calls[0].url === BASE + '/plans', s.calls[0] && s.calls[0].url)

  const plans = s.$('plans')
  check('the section is populated from GET /plans', s.$('planList').querySelectorAll('.plan').length === 1,
    `${s.$('planList').querySelectorAll('.plan').length} card(s)`)
  check('the section sits at the very top of the panel body',
    s.shadow.querySelector('.body').firstElementChild === plans)
  check('the section is titled 待确认操作',
    plans.querySelector('.plans-title').textContent === '待确认操作',
    plans.querySelector('.plans-title').textContent)

  const card = s.$('planList').querySelector('.plan')
  check('the card shows the Chinese title', card.querySelector('.plan-title').textContent === '移除水印',
    card.querySelector('.plan-title').textContent)
  check('the gate is labelled in Chinese, not echoed as an enum',
    card.querySelector('.tag').textContent === '破坏性' && card.querySelector('.tag').className.includes('destructive'),
    `${card.querySelector('.tag').className} / ${card.querySelector('.tag').textContent}`)
  check('the id is shown as its first 8 characters',
    card.querySelector('.plan-id').textContent === '#p_3f9a1c', card.querySelector('.plan-id').textContent)
  check('the remaining validity is shown in minutes', card.textContent.includes('还有 15 分钟'), card.textContent)
  check('the multi-line sheet is rendered whole, with its newlines',
    card.querySelector('.plan-sheet').textContent === plan.sheet
      && card.querySelector('.plan-sheet').textContent.includes('\n'),
    JSON.stringify(card.querySelector('.plan-sheet').textContent))
  check('the sheet is laid out as pre-wrap monospace text',
    s.css().includes('.plan-sheet') && s.css().includes('white-space:pre-wrap'))
  check('optional hints are listed', card.textContent.includes('「pages: [1]」'), card.textContent)
  check('optional ambiguity is listed', card.textContent.includes('未指定水印文字'), card.textContent)
  check('both buttons are offered',
    card.querySelector('[data-action="confirm"]').textContent === '确认执行'
      && card.querySelector('[data-action="cancel"]').textContent === '取消')
  check('the unavailable notice is not shown on success',
    s.$('plansDown').style.display === 'none')
  check('an unknown plan field is tolerated and never rendered',
    !s.panelText().includes('ignored') && !s.panelText().includes('unknownField'))

  // Opening the panel is what starts the 3s poll, and it refreshes at once.
  const before = s.calls.length
  await s.open()
  check('opening the panel refreshes immediately', s.calls.length > before,
    `${before} → ${s.calls.length}`)
})

// ── the contract is tolerant: unknown fields in, optional fields out ────────

await run('minimal plan', async () => {
  const sparse = { planId: 'p_deadbeefcafe', status: 'pending' }
  const s = await mount(url => (url.endsWith('/plans') ? json({ ok: true, plans: [sparse] }) : json({ ok: true })))
  await tick()
  const card = s.$('planList').querySelector('.plan')
  check('a plan with only planId+status still renders', card !== null)
  check('it falls back to a neutral title', card.querySelector('.plan-title').textContent === '待确认操作',
    card.querySelector('.plan-title').textContent)
  check('a missing gate is not printed as "undefined"',
    !card.textContent.includes('undefined'), card.textContent)
  check('a missing sheet adds no empty slab', card.querySelector('.plan-sheet') === null)
  check('a missing expiresAt adds no bogus countdown',
    !card.textContent.includes('分钟') && !card.textContent.includes('NaN'), card.textContent)
  check('the plan fixture with unknown fields caused no error', s.alertCount === 0)
})

// ── the section hides for statuses that need nothing ────────────────────────

await run('non-pending statuses', async () => {
  const plans = ['confirmed', 'cancelled', 'expired', 'consumed'].map((status, index) =>
    planFixture({ planId: `p_${status}${index}`, status }))
  const s = await mount(url => (url.endsWith('/plans') ? json({ ok: true, plans }) : json({ ok: true })))
  await tick()
  check('a list without a pending plan renders no cards',
    s.$('planList').querySelectorAll('.plan').length === 0,
    String(s.$('planList').querySelectorAll('.plan').length))
  check('...and the whole section is hidden (no placeholder, no 暂无)',
    s.$('plans').style.display === 'none', `display=${s.$('plans').style.display}`)
  check('no "暂无" placeholder is written anywhere',
    !s.panelText().includes('暂无'), s.panelText().slice(0, 80))
})

// ── 2. confirm hits the route and turns the card into a sentence ────────────

await run('confirm', async () => {
  const plan = planFixture()
  const s = await mount((url, options) => {
    if (url.endsWith('/plans')) return json({ ok: true, plans: [plan] })
    if (url.endsWith('/plans/p_3f9a1c2b/confirm')) {
      check('confirm is sent as POST', options.method === 'POST', String(options.method))
      return json({ ok: true, plan: { ...plan, status: 'confirmed' } })
    }
    return json({ ok: true })
  })
  await tick()
  await s.open()

  s.$('planList').querySelector('[data-action="confirm"]').click()
  await tick(50)

  const posts = s.calls.filter(call => call.method === 'POST')
  check('confirm posted exactly one request', posts.length === 1, JSON.stringify(posts.map(p => p.method + ' ' + p.url)))
  check('confirm used the contract URL',
    posts[0] && posts[0].url === BASE + '/plans/p_3f9a1c2b/confirm', posts[0] && posts[0].url)
  const text = s.$('planList').textContent
  check('the card says 已确认', text.includes('已确认'), text)
  check('the card hands the user the sentence to paste',
    text.includes('已确认，请对助手说：继续执行计划 p_3f9a1c'), text)
  check('the buttons are gone from a confirmed card',
    s.$('planList').querySelectorAll('[data-action="confirm"], [data-action="cancel"]').length === 0)

  // A poll that still reports the plan as pending (a stale host) must not undo
  // the decision the user already made.
  const before = s.calls.length
  s.window.document.dispatchEvent(new s.window.Event('visibilitychange'))
  await tick(50)
  check('regaining focus refreshes immediately', s.calls.length > before, `${before} → ${s.calls.length}`)
  check('a stale pending poll does not re-open the decision',
    s.$('planList').textContent.includes('继续执行计划 p_3f9a1c')
      && s.$('planList').querySelectorAll('[data-action="confirm"]').length === 0,
    s.$('planList').textContent)
  check('no dialog was raised during the confirm flow', s.alertCount === 0, String(s.alertCount))
})

// ── 3. cancel hits the route and removes the card ───────────────────────────

await run('cancel', async () => {
  const plan = planFixture()
  let cancelled = false
  const s = await mount((url, options) => {
    if (url.endsWith('/plans')) return json({ ok: true, plans: cancelled ? [] : [plan] })
    if (url.endsWith('/plans/p_3f9a1c2b/cancel')) {
      cancelled = true
      check('cancel is sent as POST', options.method === 'POST', String(options.method))
      return json({ ok: true, plan: { ...plan, status: 'cancelled' } })
    }
    return json({ ok: true })
  })
  await tick()
  await s.open()
  check('the card exists before the cancel', s.$('planList').querySelectorAll('.plan').length === 1)

  s.$('planList').querySelector('[data-action="cancel"]').click()
  await tick(50)

  const posts = s.calls.filter(call => call.method === 'POST')
  check('cancel posted exactly one request', posts.length === 1, JSON.stringify(posts.map(p => p.url)))
  check('cancel used the contract URL',
    posts[0] && posts[0].url === BASE + '/plans/p_3f9a1c2b/cancel', posts[0] && posts[0].url)
  check('the card is removed from the list',
    s.$('planList').querySelectorAll('.plan').length === 0,
    String(s.$('planList').querySelectorAll('.plan').length))
  check('the section hides again once nothing is pending',
    s.$('plans').style.display === 'none', `display=${s.$('plans').style.display}`)
  check('no 已确认 sentence is left behind by a cancel',
    !s.panelText().includes('继续执行计划'), s.panelText().slice(0, 80))
})

// ── 4. an unreachable plans route degrades silently ─────────────────────────

await run('500 response', async () => {
  const s = await mount(() => json({ error: 'boom' }, 500))
  await tick()
  await s.open()
  check('a 500 on /plans shows the grey notice',
    s.$('plansDown').textContent === '计划接口暂不可用' && s.$('plansDown').style.display !== 'none',
    `${s.$('plansDown').style.display} / ${s.$('plansDown').textContent}`)
  check('...and the notice is grey, not an error red',
    s.$('plansDown').className.includes('muted'), s.$('plansDown').className)
  check('no plan card is invented from a failed response',
    s.$('planList').querySelectorAll('.plan').length === 0)
  check('the rest of the panel is untouched: status is still 就绪',
    s.$('status').textContent === '就绪', s.$('status').textContent)
  s.$('tabMark').click()
  check('the other tabs still work after the failure',
    s.$('viewMark').style.display !== 'none' && s.$('viewAnalyze').style.display === 'none')
  check('no dialog was raised for the failed route', s.alertCount === 0, String(s.alertCount))
})

await run('network failure', async () => {
  const s = await mount(() => { throw new Error('network down') })
  await tick()
  await s.open()
  check('a fetch rejection degrades silently too',
    s.$('plansDown').style.display !== 'none' && s.$('plansDown').textContent === '计划接口暂不可用',
    s.$('plansDown').style.display)
  check('the panel body is still mounted and usable after the rejection',
    s.shadow.querySelector('.launcher') !== null && s.$('previewOpen') !== null)
  check('no dialog was raised for the network failure', s.alertCount === 0, String(s.alertCount))
})

// ── 5. API strings are text, never markup ───────────────────────────────────

await run('escaping', async () => {
  const evil = '<img src=x onerror=alert(1)>'
  const plan = planFixture({
    title: evil,
    sheet: '文件：' + evil + '\n参数：<script>alert(2)</script>',
    hints: ['<b>加粗</b>'],
    ambiguous: [evil],
  })
  const s = await mount(url => (url.endsWith('/plans') ? json({ ok: true, plans: [plan] }) : json({ ok: true })))
  await tick()
  await s.open()

  // `document.querySelector` cannot see into a shadow root, so both scopes are
  // asserted: the required document-level check, plus the one that would
  // actually catch an injected <img>.
  check('document.querySelector("img") === null', s.window.document.querySelector('img') === null)
  check('the panel\'s shadow root holds no img element either', s.shadow.querySelector('img') === null)
  check('no element was created from the script payload', s.shadow.querySelector('script') === null)
  check('no element was created from the hint payload', s.shadow.querySelector('b') === null)
  check('the title is displayed verbatim as text',
    s.$('planList').querySelector('.plan-title').textContent === evil,
    s.$('planList').querySelector('.plan-title').textContent)
  check('the sheet is displayed verbatim as text',
    s.$('planList').querySelector('.plan-sheet').textContent.includes(evil),
    s.$('planList').querySelector('.plan-sheet').textContent)
  check('the evil string is not double-escaped either (it reads as the user wrote it)',
    !s.$('planList').textContent.includes('&lt;img'),
    s.$('planList').textContent.slice(0, 60))
  check('the hostile page raised no dialog', s.alertCount === 0, String(s.alertCount))
})

// ── 6. the surface is idempotent ────────────────────────────────────────────

await run('idempotent injection', async () => {
  const plan = planFixture()
  const s = await mount(url => (url.endsWith('/plans') ? json({ ok: true, plans: [plan] }) : json({ ok: true })))
  await tick()
  check('the mount flag is set', s.window.__dshPdfStudioMounted === true,
    String(s.window.__dshPdfStudioMounted))

  s.window.eval(surface) // the second injection (web shell + desktop client)
  await tick()

  check('the second injection adds no second host element',
    s.window.document.querySelectorAll('#dsh-pdf-studio-host').length === 1,
    String(s.window.document.querySelectorAll('#dsh-pdf-studio-host').length))
  check('...no second launcher', s.shadow.querySelectorAll('.launcher').length === 1,
    String(s.shadow.querySelectorAll('.launcher').length))
  check('...no second panel', s.shadow.querySelectorAll('.panel').length === 1,
    String(s.shadow.querySelectorAll('.panel').length))
  check('...and no second confirmation card',
    s.$('planList').querySelectorAll('.plan').length === 1,
    String(s.$('planList').querySelectorAll('.plan').length))
})

// ── 7. an injected absolute apiBase is used by every call ───────────────────

await run('injected absolute apiBase', async () => {
  const base = 'http://127.0.0.1:9999/api/pdf-studio'
  const plan = planFixture()
  const s = await mount((url) => {
    if (url.endsWith('/plans')) return json({ ok: true, plans: [plan] })
    if (url.endsWith('/confirm')) return json({ ok: true, plan: { ...plan, status: 'confirmed' } })
    if (url.includes('/info')) {
      return json({
        ok: true, sourcePath: '/tmp/a.pdf', pages: 1, encrypted: false,
        sizes: [{ page: 1, width: 595.28, height: 841.89 }],
      })
    }
    return json({ ok: true })
  }, { apiBase: base })
  await tick()
  await s.open()

  check('GET /plans uses the injected base',
    s.calls[0] && s.calls[0].url === base + '/plans', s.calls[0] && s.calls[0].url)
  check('the base is read from globalThis.__DSH_PDF_STUDIO__',
    s.window.__DSH_PDF_STUDIO__ !== undefined && s.window.__DSH_PDF_STUDIO__.apiBase === base,
    String(s.window.__DSH_PDF_STUDIO__ && s.window.__DSH_PDF_STUDIO__.apiBase))

  s.$('planList').querySelector('[data-action="confirm"]').click()
  await tick(50)
  const post = s.calls.find(call => call.method === 'POST')
  check('POST confirm uses the injected base too',
    post && post.url === base + '/plans/p_3f9a1c2b/confirm', post && post.url)

  s.$('path').value = '/tmp/a.pdf'
  s.$('previewOpen').click()
  await tick(50)
  const img = s.$('pages').querySelector('img')
  check('page renders are fetched from the injected base as well',
    img !== null && img.src.indexOf(base) === 0, img && img.src)
})

await run('apiBase trailing slash', async () => {
  const s = await mount(
    url => (url.endsWith('/plans') ? json({ ok: true, plans: [] }) : json({ ok: true })),
    { apiBase: 'http://127.0.0.1:9999/api/pdf-studio/' })
  await tick()
  check('a trailing slash on apiBase does not double up',
    s.calls[0] && s.calls[0].url === 'http://127.0.0.1:9999/api/pdf-studio/plans',
    s.calls[0] && s.calls[0].url)
})

// ── the poll cadence: 3s while the panel is open ────────────────────────────

await run('poll cadence', async () => {
  let gets = 0
  const s = await mount(url => {
    if (url.endsWith('/plans')) { gets += 1; return json({ ok: true, plans: [] }) }
    return json({ ok: true })
  })
  await tick()
  await s.open()
  const before = gets
  await tick(3400)
  check('an open panel polls /plans about every 3s', gets > before,
    `${before} GET(s) before the wait, ${gets} after 3.4s`)
})

console.log(`\n${failed === 0 ? 'ALL CONFIRM-UI CHECKS PASSED' : failed + ' check(s) FAILED'}`)
if (failed > 0) process.exitCode = 1
