/**
 * dsh-pdf-studio browser surface.
 *
 * Plain ES2020, no imports, no build step: the host serves this file and injects
 * it into whichever shell is running. The whole surface lives inside a shadow
 * root so the host page's CSS cannot reach in and ours cannot leak out — a
 * plugin that restyles the harness is a bug, not a feature.
 *
 * Two capabilities share one panel:
 *
 *   - **分析**: per-page triage plus the searchable-PDF rebuild (the scan path).
 *   - **编辑**: the editable canvas — the host rasterises a page, this file
 *     positions a clickable box over every run using the run's own PDF
 *     geometry, and edits are sent back by run id.
 *
 * The canvas box maths is the part worth reading carefully: PDF space is
 * bottom-left origin and the backdrop is a top-left bitmap, so every box does
 * one y flip. Getting it wrong puts the boxes mirrored, which looks plausible
 * on a symmetric page and is wrong everywhere else.
 */
;(function () {
  'use strict'

  // Two injection paths exist (the web shell and the desktop client can both
  // serve this file into the same page), so the surface must be idempotent:
  // mounting twice would stack two launchers and two panels on top of each
  // other. The first mount wins and the second returns immediately.
  if (window.__dshPdfStudioMounted) return
  // Bail out WITHOUT claiming the flag if the document is not ready yet: a
  // script injected into <head> has to be allowed to succeed when it is
  // injected again after the body exists.
  if (!document.body) return
  window.__dshPdfStudioMounted = true

  var API = '/api/pdf-studio'
  var HOST_ID = 'dsh-pdf-studio-host'
  if (document.getElementById(HOST_ID)) return

  /**
   * Base for every API call.
   *
   * The host may inject an absolute base (`globalThis.__DSH_PDF_STUDIO__ =
   * { apiBase: 'http://127.0.0.1:19387/api/pdf-studio' }`) because the desktop
   * client and the web GUI are not always the same origin as the page the
   * surface is injected into. When nothing is injected we fall back to the
   * same-origin relative path, which is what the in-page web shell uses.
   *
   * A trailing slash is stripped so `base + '/plans'` never produces `//plans`.
   */
  var apiBase = function () {
    var injected = globalThis.__DSH_PDF_STUDIO__
    var base = injected && typeof injected.apiBase === 'string' ? injected.apiBase.replace(/\s+$/, '') : ''
    if (!base) return API
    return base.replace(/\/+$/, '')
  }

  // ── host element + shadow root ────────────────────────────────────────────
  var host = document.createElement('div')
  host.id = HOST_ID
  host.setAttribute('data-dsh-pdf-studio-root', '')
  document.body.appendChild(host)
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host

  var style = document.createElement('style')
  style.textContent = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.launcher{position:fixed;right:18px;bottom:96px;z-index:2147483000;',
    'touch-action:none;',
    'font:600 12px/1.2 system-ui,-apple-system,"PingFang SC",sans-serif;',
    'display:flex;align-items:center;gap:6px;padding:8px 12px;border-radius:999px;',
    'border:1px solid rgba(126,152,255,.5);cursor:pointer;color:#eef2ff;',
    'background:linear-gradient(160deg,rgba(74,104,245,.95),rgba(47,68,184,.95));',
    'box-shadow:0 6px 18px rgba(2,6,23,.45)}',
    '.launcher:hover{filter:brightness(1.1)}',
    '.panel{position:fixed;right:18px;bottom:96px;z-index:2147483000;width:min(880px,calc(100vw - 36px));',
    'touch-action:none;',
    'max-height:min(84vh,900px);display:none;flex-direction:column;',
    'font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:#e6ebf8;',
    'border:1px solid rgba(126,152,255,.45);border-radius:14px;overflow:hidden;',
    'background:linear-gradient(165deg,rgba(19,28,54,.97),rgba(7,11,26,.98));',
    'box-shadow:0 18px 48px rgba(2,6,23,.6)}',
    '.panel.open{display:flex}',
    '.head{display:flex;align-items:center;gap:8px;padding:10px 14px;',
    'border-bottom:1px solid rgba(126,152,255,.22)}',
    '.title{font-weight:600;flex:1;cursor:move;user-select:none;padding:2px 0}',
    '.tabs{display:flex;gap:4px}',
    '.tab{cursor:pointer;font:inherit;padding:4px 10px;border-radius:8px;border:1px solid transparent;',
    'background:rgba(126,152,255,.12);color:#c7d2fe}',
    '.tab.on{background:rgba(126,152,255,.28);border-color:rgba(126,152,255,.5);color:#fff}',
    '.x{cursor:pointer;background:none;border:none;color:#9aa8d8;font-size:16px;padding:0 4px}',
    '.x:hover{color:#fff}',
    '.body{padding:12px 14px;overflow:auto;display:flex;flex-direction:column;gap:10px}',
    '.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    'input[type=text]{flex:1;min-width:120px;padding:6px 9px;border-radius:8px;font:inherit;',
    'color:#e6ebf8;background:rgba(19,28,54,.8);border:1px solid rgba(126,152,255,.4);outline:none}',
    'input[type=text]:focus{border-color:#4d6bfe}',
    'button{cursor:pointer;font:inherit;font-weight:600;padding:6px 12px;border-radius:8px;',
    'border:none;color:#fff;background:linear-gradient(#4a68f5,#3a55e0)}',
    'button:hover{filter:brightness(1.08)}',
    'button:disabled{opacity:.5;cursor:default;filter:none}',
    'button.ghost{background:rgba(126,152,255,.16);border:1px solid rgba(126,152,255,.4)}',
    'button.tiny{padding:2px 8px;font-size:12px}',
    '.muted{color:#9aa8d8;font-size:12px}',
    '.files{max-height:120px;overflow:auto;border:1px solid rgba(126,152,255,.22);border-radius:8px}',
    '.file{padding:6px 9px;cursor:pointer;border-bottom:1px solid rgba(126,152,255,.12);',
    'font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.file:last-child{border-bottom:none}',
    '.file:hover{background:rgba(126,152,255,.14)}',
    'table{width:100%;border-collapse:collapse;font-size:12px}',
    'th,td{text-align:left;padding:4px 6px;border-bottom:1px solid rgba(126,152,255,.16)}',
    'th{color:#9aa8d8;font-weight:600}',
    '.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600}',
    '.tag.text{background:rgba(52,211,153,.2);color:#6ee7b7}',
    '.tag.image{background:rgba(251,191,36,.2);color:#fcd34d}',
    '.tag.mixed{background:rgba(96,165,250,.22);color:#93c5fd}',
    '.tag.empty{background:rgba(148,163,184,.2);color:#cbd5e1}',
    '.log{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#9aa8d8;',
    'white-space:pre-wrap;max-height:90px;overflow:auto}',
    '.err{color:#fca5a5}',
    '.ok{color:#6ee7b7}',
    '.warn{color:#fcd34d}',
    /* canvas */
    '.stage{position:relative;overflow:auto;max-height:60vh;border:1px solid rgba(126,152,255,.22);',
    'border-radius:10px;background:#0b1020}',
    '.wrap{position:relative;line-height:0}',
    '.wrap img{display:block;width:100%;height:auto}',
    '.run{position:absolute;border:1px solid rgba(96,165,250,.55);background:rgba(96,165,250,.13);',
    'cursor:pointer;border-radius:2px;transition:background .1s,border-color .1s}',
    '.run:hover{background:rgba(96,165,250,.3);border-color:#93c5fd}',
    '.run.sel{background:rgba(250,204,21,.3);border-color:#facc15;z-index:2}',
    '.run.edited{background:rgba(52,211,153,.24);border-color:#34d399}',
    '.run.over{border-color:#fb7185;background:rgba(251,113,133,.22)}',
    '.editor{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:10px;',
    'background:rgba(126,152,255,.1);border:1px solid rgba(126,152,255,.28)}',
    '.editor .old{color:#9aa8d8;font-size:12px;word-break:break-all}',
    '.legend{display:flex;gap:12px;font-size:11px;color:#9aa8d8;flex-wrap:wrap}',
    /* preview */
    '.pages{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;',
    'max-height:56vh;overflow:auto;padding:4px;border:1px solid rgba(126,152,255,.18);border-radius:10px}',
    '.pages figure{margin:0;display:flex;flex-direction:column;gap:4px;align-items:center}',
    '.pages .frame{position:relative;width:100%}',
    '.pages img{width:100%;display:block;border:1px solid rgba(126,152,255,.35);border-radius:6px;',
    'background:#fff;cursor:zoom-in;min-height:60px}',
    '.pages figcaption{font-size:11px;color:#9aa8d8}',
    '.pages .ph{position:absolute;inset:0;border-radius:6px;background:rgba(20,30,58,.92);',
    'display:flex;align-items:center;justify-content:center;font-size:11px;color:#9aa8d8;',
    'text-align:center;padding:4px}',
    '.viewer{position:fixed;inset:0;z-index:2147483600;background:rgba(3,6,16,.92);',
    'display:flex;align-items:center;justify-content:center;cursor:zoom-out}',
    '.viewer img{max-width:96vw;max-height:96vh;background:#fff;border-radius:6px}',
    '.viewer .hint{position:absolute;top:14px;left:50%;transform:translateX(-50%);',
    'font-size:12px;color:#c7d2fe}',
    '.dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:middle}',
    /* pending plans: the confirmation card */
    '.plans{display:flex;flex-direction:column;gap:8px;padding:8px 10px;border-radius:10px;',
    'background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.4)}',
    '.plans-title{font-weight:600;font-size:12px;color:#fcd34d}',
    '.plan{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:8px;',
    'background:rgba(7,11,26,.6);border:1px solid rgba(126,152,255,.28)}',
    '.plan-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.plan-title{font-weight:600}',
    '.plan-id{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#9aa8d8}',
    /* The sheet is the host-supplied multi-line confirmation text: its newlines
       are meaningful, so it is laid out as pre-wrap TEXT and never as markup. */
    '.plan-sheet{margin:0;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#c7d2fe;',
    'white-space:pre-wrap;word-break:break-word;background:rgba(11,16,32,.8);border-radius:6px;',
    'padding:6px 8px;max-height:150px;overflow:auto}',
    '.plan-list{margin:2px 0 0;padding-left:18px;font-size:12px;color:#c7d2fe}',
    '.plan-list li{word-break:break-word}',
    '.plan-ok{color:#6ee7b7;font-size:12px;word-break:break-all}',
    '.tag.destructive{background:rgba(251,113,133,.22);color:#fda4af}',
    '.tag.expensive{background:rgba(251,191,36,.2);color:#fcd34d}',
    '.tag.ambiguous{background:rgba(96,165,250,.22);color:#93c5fd}',
  ].join('')
  root.appendChild(style)

  // ── DOM ───────────────────────────────────────────────────────────────────
  var launcher = document.createElement('button')
  launcher.className = 'launcher'
  launcher.type = 'button'
  launcher.textContent = 'PDF 工作台'
  root.appendChild(launcher)

  var panel = document.createElement('div')
  panel.className = 'panel'
  panel.innerHTML = [
    '<div class="head">',
    '  <span class="title">PDF 工作台</span>',
    '  <span class="tabs">',
    '    <button class="tab on" id="tabPreview" type="button">预览</button>',
  '    <button class="tab" id="tabAnalyze" type="button">分析</button>',
    '    <button class="tab" id="tabEdit" type="button">编辑</button>',
  '    <button class="tab" id="tabMark" type="button">水印 / 密码</button>',
    '  </span>',
    '  <button class="x" type="button" title="关闭">×</button>',
    '</div>',
    '<div class="body">',
    /* 待确认操作 — the very first thing in the panel. It stays fully hidden
       until the host reports a pending plan (or the plans route is missing),
       so it costs no space in the common case. */
    '  <div class="plans" id="plans" style="display:none">',
    '    <div class="plans-title">待确认操作</div>',
    '    <div id="planList"></div>',
    '    <div class="muted" id="plansDown" style="display:none">计划接口暂不可用</div>',
    '  </div>',
    '  <div class="row">',
    '    <input type="text" id="path" placeholder="PDF 路径，或从下方选择" />',
    '    <button class="ghost" id="list" type="button">浏览</button>',
    '    <label class="muted" title="搜索子目录的层数。层数越深越慢：2 层约 50ms，4 层可能几十秒。">',
    '      深度 <select id="depth">',
    '        <option value="1">1</option>',
    '        <option value="2" selected>2</option>',
    '        <option value="3">3</option>',
    '        <option value="4">4（慢）</option>',
    '      </select></label>',
    '  </div>',
    '  <div class="files" id="files" style="display:none"></div>',
    '  <div class="muted" id="status">就绪</div>',
    /* analyze view */
    '  <div id="viewPreview">',
    '    <div class="row">',
    '      <button id="previewOpen" type="button">打开预览</button>',
    '      <label class="muted">缩略图 <input type="range" id="previewSize" min="90" max="240" value="150" /></label>',
    '      <span class="muted" id="previewInfo">选择文件后点「打开预览」</span>',
    '    </div>',
    '    <div class="pages" id="pages"></div>',
    '  </div>',
    '  <div id="viewAnalyze" style="display:none">',
    '    <div class="row">',
    '      <button id="analyze" type="button">分析</button>',
    '      <button id="export" type="button" disabled>生成可搜索 PDF</button>',
    '      <label class="muted"><input type="checkbox" id="cover" /> 可见覆盖</label>',
    '    </div>',
    '    <div id="result"></div>',
    '  </div>',
    /* edit view */
    '  <div id="viewEdit" style="display:none">',
    '    <div class="row">',
    '      <button id="loadRuns" type="button">载入可编辑内容</button>',
    '      <span class="muted" id="pageNav" style="display:none">',
    '        <button class="ghost tiny" id="prevPage" type="button">‹</button>',
    '        <span id="pageLabel">1 / 1</span>',
    '        <button class="ghost tiny" id="nextPage" type="button">›</button>',
    '        <label class="muted">缩放 <input type="range" id="zoom" min="40" max="160" value="100" /></label>',
    '      </span>',
    '      <button id="apply" type="button" disabled>另存编辑结果</button>',
    '    </div>',
    '    <div class="legend">',
    '      <span><i class="dot" style="background:rgba(96,165,250,.5)"></i>可编辑文本</span>',
    '      <span><i class="dot" style="background:rgba(250,204,21,.8)"></i>已选中</span>',
    '      <span><i class="dot" style="background:rgba(52,211,153,.7)"></i>已修改</span>',
    '      <span><i class="dot" style="background:rgba(251,113,133,.8)"></i>无 ToUnicode（不可解码）</span>',
    '    </div>',
    '    <div class="editor" id="editor" style="display:none">',
    '      <div class="muted" id="editorMeta"></div>',
    '      <div class="old" id="editorOld"></div>',
    '      <div class="row">',
    '        <input type="text" id="editorInput" />',
    '        <button class="tiny" id="editorSave" type="button">应用</button>',
    '        <button class="ghost tiny" id="editorCancel" type="button">取消</button>',
    '      </div>',
    '      <div class="muted" id="editorHint"></div>',
    '    </div>',
    '    <div class="stage" id="stage" style="display:none"><div class="wrap" id="wrap"></div></div>',
    '    <div id="editSummary"></div>',
    '  </div>',
    '  <div id="viewMark" style="display:none">',
    '    <div class="row">',
    '      <input type="text" id="wmText" placeholder="水印文字，例如：机密 · 请勿外传" />',
    '    </div>',
    '    <div class="row">',
    '      <label class="muted">位置 <select id="wmPlace">',
    '        <option value="tile">平铺（斜向）</option>',
    '        <option value="center">居中</option>',
    '        <option value="corner">角落</option>',
    '      </select></label>',
    '      <label class="muted">透明度 <input type="range" id="wmOpacity" min="5" max="80" value="18" /></label>',
    '      <label class="muted">字号 <input type="range" id="wmSize" min="12" max="96" value="44" /></label>',
    '      <button id="wmAdd" type="button">添加水印</button>',
    '    </div>',
    '    <div class="row">',
    '      <button class="ghost" id="wmScan" type="button">扫描已有水印</button>',
    '      <button class="ghost" id="wmRemove" type="button" disabled>移除高置信度水印</button>',
    '    </div>',
    '    <div class="muted" id="wmHint">移除只处理能确认的对象。栅格化进页面图片的水印无法移除 —— 本工具不会假装可以。</div>',
    '    <div id="wmList"></div>',
    '    <hr style="border:none;border-top:1px solid rgba(126,152,255,.22);margin:4px 0" />',
    '    <div class="row">',
    '      <input type="text" id="pwUser" placeholder="打开密码（用户密码）" />',
    '      <button id="pwEncrypt" type="button">加密</button>',
    '    </div>',
    '    <div class="row">',
    '      <input type="text" id="pwDecrypt" placeholder="已有密码（解密用）" />',
    '      <button class="ghost" id="pwDecryptBtn" type="button">解除密码</button>',
    '      <button class="ghost" id="pwCheck" type="button">查询保护状态</button>',
    '    </div>',
    '    <div id="pwState"></div>',
    '  </div>',
    '  <div class="log" id="log"></div>',
    '</div>',
  ].join('')
  root.appendChild(panel)

  var $ = function (id) { return panel.querySelector('#' + id) }
  var pathInput = $('path')
  var filesBox = $('files')
  var statusEl = $('status')
  var logEl = $('log')
  var resultEl = $('result')
  var exportBtn = $('export')
  var coverChk = $('cover')
  var stageEl = $('stage')
  var wrapEl = $('wrap')
  var editorEl = $('editor')
  var editorMeta = $('editorMeta')
  var editorOld = $('editorOld')
  var editorInput = $('editorInput')
  var editorHint = $('editorHint')
  var pageLabel = $('pageLabel')
  var pageNav = $('pageNav')
  var editSummary = $('editSummary')
  var plansEl = $('plans')
  var planListEl = $('planList')
  var plansDownEl = $('plansDown')

  /** Model state for the edit view. */
  var model = null
  var currentPage = 0
  /** runId -> new text, pending export. */
  var edits = {}
  var selected = null

  var log = function (message, kind) {
    var line = document.createElement('div')
    if (kind) line.className = kind
    line.textContent = message
    logEl.appendChild(line)
    logEl.scrollTop = logEl.scrollHeight
  }
  var setStatus = function (text, kind) {
    statusEl.textContent = text
    statusEl.className = kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'muted'
  }
  var request = function (url, options) {
    return fetch(url, options).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body && body.error ? body.error : ('HTTP ' + response.status))
        return body
      })
    })
  }

  launcher.addEventListener('click', function () {
    panel.classList.add('open')
    launcher.style.display = 'none'
    // Polling is tied to the panel being on screen: a closed panel polls
    // nothing, an open one asks the host for pending plans every few seconds.
    startPlansPolling()
  })
  panel.querySelector('.x').addEventListener('click', function () {
    panel.classList.remove('open')
    launcher.style.display = 'flex'
    stopPlansPolling()
  })

  // ── tabs ──────────────────────────────────────────────────────────────────
  var TABS = [
    ['preview', 'tabPreview', 'viewPreview'],
    ['analyze', 'tabAnalyze', 'viewAnalyze'],
    ['edit', 'tabEdit', 'viewEdit'],
    ['mark', 'tabMark', 'viewMark'],
  ]
  var tabEls = TABS.map(function (entry) { return [entry[0], $(entry[1]), $(entry[2])] })
  var showTab = function (which) {
    tabEls.forEach(function (entry) {
      var on = entry[0] === which
      entry[1].className = 'tab' + (on ? ' on' : '')
      entry[2].style.display = on ? '' : 'none'
    })
  }
  tabEls.forEach(function (entry) { entry[1].addEventListener('click', function () { showTab(entry[0]) }) })

  // ── file browsing ─────────────────────────────────────────────────────────
  $('list').addEventListener('click', function () {
    var dir = pathInput.value.trim()
    var depth = $('depth').value
    setStatus('正在列出…')
    request(apiBase() + '/list?depth=' + depth + (dir ? '&dir=' + encodeURIComponent(dir) : ''))
      .then(function (body) {
        filesBox.style.display = 'block'
        filesBox.innerHTML = ''
        if (!body.files.length) {
          log('「' + body.dir + '」下（深度 ' + body.depth + '）没有 PDF。')
          log('提示：可以直接在路径框里粘贴 PDF 的完整路径，不必先浏览。')
          setStatus('未找到 PDF —— 可调大深度或直接粘贴路径', 'warn')
          return
        }
        body.files.forEach(function (file) {
          var row = document.createElement('div')
          row.className = 'file'
          // Show the path relative to the browsed root; absolute paths are long
          // and the common prefix carries no information.
          row.textContent = file.indexOf(body.dir) === 0 ? file.slice(body.dir.length + 1) : file
          row.title = file
          row.addEventListener('click', function () {
            pathInput.value = file
            setStatus('已选择：' + file)
          })
          filesBox.appendChild(row)
        })
        setStatus('找到 ' + body.count + ' 个 PDF' + (body.truncated ? '（结果已截断，调小深度或指定目录）' : ''),
          body.truncated ? 'warn' : 'ok')
      })
      .catch(function (error) { log('列出失败：' + error.message, 'err'); setStatus('列出失败', 'err') })
  })

  // ── analyze view ──────────────────────────────────────────────────────────
  var renderTriage = function (body) {
    var table = document.createElement('table')
    table.innerHTML = '<thead><tr><th>页</th><th>类型</th><th>行</th><th>置信</th><th>样例</th></tr></thead>'
    var tbody = document.createElement('tbody')
    var byPage = {}
    ;(body.summary || []).forEach(function (s) { byPage[s.page] = s })
    ;(body.triage || []).forEach(function (t) {
      var s = byPage[t.page] || {}
      var tr = document.createElement('tr')
      var label = { text: '文本', image: '图片', mixed: '混合', empty: '空' }[t.kind] || t.kind
      tr.innerHTML = '<td>' + t.page + '</td>'
        + '<td><span class="tag ' + t.kind + '">' + label + '</span></td>'
        + '<td>' + (s.lines == null ? '-' : s.lines) + '</td>'
        + '<td>' + (s.meanConfidence == null ? '-' : s.meanConfidence) + '</td>'
        + '<td class="sample"></td>'
      tr.querySelector('.sample').textContent = (s.sample && s.sample[0]) || ''
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    return table
  }

  $('analyze').addEventListener('click', function () {
    var target = pathInput.value.trim()
    if (!target) { setStatus('请先指定 PDF', 'err'); return }
    exportBtn.disabled = true
    resultEl.innerHTML = ''
    setStatus('分析中…（图片页需要 OCR，可能较慢）')
    request(apiBase() + '/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target }),
    }).then(function (body) {
      resultEl.appendChild(renderTriage(body))
      exportBtn.disabled = false
      setStatus('分析完成：' + body.pages + ' 页，' + body.elapsedMs + 'ms', 'ok')
      ;(body.notes || []).forEach(function (note) { log('· ' + note) })
    }).catch(function (error) { log('分析失败：' + error.message, 'err'); setStatus('分析失败', 'err') })
  })

  exportBtn.addEventListener('click', function () {
    var target = pathInput.value.trim()
    setStatus('生成中…')
    exportBtn.disabled = true
    request(apiBase() + '/export', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target, mode: coverChk.checked ? 'cover' : 'invisible' }),
    }).then(function (body) {
      setStatus('已生成：' + body.outputPath, 'ok')
      log('lines written=' + body.linesWritten + ' skipped=' + body.linesSkipped)
    }).catch(function (error) { log('生成失败：' + error.message, 'err'); setStatus('生成失败', 'err') })
      .then(function () { exportBtn.disabled = false })
  })

  // ── edit view: the canvas ─────────────────────────────────────────────────

  /**
   * Project a run's PDF-space box onto the rendered backdrop.
   *
   * The backdrop is a top-left bitmap; PDF space is bottom-left. So the box's
   * BOTTOM in PDF space is the box's TOP-offset from the image's bottom:
   *   top = (pageHeight - (y + height)) * scale
   * The run height is derived from the font size (ascender+descender ≈ 1.2em),
   * because a text operand carries a baseline, not a box.
   */
  var boxFor = function (run, page, imgWidth) {
    var scale = imgWidth / page.width
    var heightPt = (run.fontSize || 10) * 1.25
    var left = run.x * scale
    var top = (page.height - (run.y + heightPt)) * scale
    var width = Math.max(6, (run.widthPt || 12) * scale)
    var height = Math.max(6, heightPt * scale)
    return { left: left, top: top, width: width, height: height }
  }

  var renderCanvas = function () {
    if (model === null) return
    var page = model.content[currentPage]
    if (page === undefined) return
    pageNav.style.display = ''
    pageLabel.textContent = (currentPage + 1) + ' / ' + model.pages

    // Re-rendering is used both for page changes and for reflect-an-edit, and
    // the backdrop only needs to be refetched when the PAGE changes. Keeping
    // the image also keeps its measured width, which avoids a layout collapse
    // (and an overlay jump) on every keystroke-driven refresh.
    var needsImage = renderCanvas.page !== page.page || wrapEl.querySelector('img') === null
    renderCanvas.page = page.page
    var img
    if (needsImage) {
      wrapEl.innerHTML = ''
      img = document.createElement('img')
      img.alt = 'page ' + page.page
      img.src = apiBase() + '/page.png?scale=2&page=' + page.page + '&path=' + encodeURIComponent(model.sourcePath)
      wrapEl.appendChild(img)
    } else {
      img = wrapEl.querySelector('img')
      var stale = wrapEl.querySelectorAll('.run')
      for (var i = 0; i < stale.length; i += 1) stale[i].parentNode.removeChild(stale[i])
    }

    var drawBoxes = function () {
      var zoom = Number($('zoom').value) / 100
      wrapEl.style.width = (100 * zoom) + '%'
      var imgWidth = img.clientWidth || img.naturalWidth || 0
      if (imgWidth <= 0) return

      page.runs.forEach(function (run) {
        var box = boxFor(run, page, imgWidth)
        var el = document.createElement('div')
        el.className = 'run'
        el.style.left = box.left + 'px'
        el.style.top = box.top + 'px'
        el.style.width = box.width + 'px'
        el.style.height = box.height + 'px'
        el.title = run.text !== undefined ? run.text : '(无法解码：' + run.textUnavailable + ')'
        if (run.text === undefined) el.className += ' over'
        if (edits[run.id] !== undefined) el.className += ' edited'
        if (selected === run.id) el.className += ' sel'
        el.addEventListener('click', function (event) {
          event.stopPropagation()
          selectRun(run, page)
        })
        wrapEl.appendChild(el)
      })
    }

    if (needsImage) img.addEventListener('load', drawBoxes)
    else drawBoxes()
    // A cached image is already complete, so the load event will never fire
    // again; draw once directly as well to cover that case.
    if (img.complete) drawBoxes()
  }

  var selectRun = function (run, page) {
    selected = run.id
    editorEl.style.display = ''
    editorMeta.textContent = 'run ' + run.id + ' · 字体 ' + (run.fontName || '?')
      + ' · 字号 ' + (run.fontSize || '?') + ' · 基线 (' + run.x.toFixed(1) + ', ' + run.y.toFixed(1) + ')'
      + (run.widthPt ? ' · 宽 ' + run.widthPt.toFixed(1) + 'pt' : '')
    editorOld.textContent = run.text !== undefined ? '原文：' + run.text : '原文无法解码（该字体缺少 ToUnicode）'
    editorInput.value = edits[run.id] !== undefined ? edits[run.id] : (run.text || '')
    editorInput.disabled = run.text === undefined
    $('editorSave').disabled = run.text === undefined
    editorHint.textContent = run.text === undefined
      ? '这个 run 无法解码，因此不能安全改写 —— 我们不知道它当前是什么文字。'
      : '改写只影响这一处；PDF 其余部分保持逐字节不变。'
    renderCanvas()
  }

  $('editorSave').addEventListener('click', function () {
    if (selected === null) return
    var run = model.content[currentPage].runs.filter(function (r) { return r.id === selected })[0]
    var value = editorInput.value
    if (run.text !== undefined && value === run.text) delete edits[selected]
    else edits[selected] = value
    // Estimate overflow with the ORIGINAL metrics: a fair proxy for "will this
    // stick out past where the old text ended".
    if (run.text !== undefined && run.widthPt) {
      var perChar = run.widthPt / Math.max(1, run.text.replace(/\s+/g, '').length)
      var estimate = perChar * value.replace(/\s+/g, '').length
      if (estimate > run.widthPt * 1.05) {
        editorHint.textContent = '提示：预计宽约 ' + estimate.toFixed(1) + 'pt（估算），超过原 '
          + run.widthPt.toFixed(1) + 'pt，可能向右溢出。'
      } else {
        editorHint.textContent = '已记录修改。'
      }
    }
    updateSummary()
    renderCanvas()
  })
  $('editorCancel').addEventListener('click', function () {
    editorEl.style.display = 'none'
    selected = null
    renderCanvas()
  })

  var updateSummary = function () {
    var ids = Object.keys(edits)
    $('apply').disabled = ids.length === 0
    editSummary.innerHTML = ''
    if (ids.length === 0) return
    var table = document.createElement('table')
    table.innerHTML = '<thead><tr><th>run</th><th>新文本</th><th></th></tr></thead>'
    var tbody = document.createElement('tbody')
    ids.forEach(function (id) {
      var tr = document.createElement('tr')
      tr.innerHTML = '<td></td><td></td><td></td>'
      tr.children[0].textContent = id
      tr.children[1].textContent = edits[id].slice(0, 40)
      var undo = document.createElement('button')
      undo.className = 'ghost tiny'
      undo.textContent = '撤销'
      undo.addEventListener('click', function () { delete edits[id]; updateSummary(); renderCanvas() })
      tr.children[2].appendChild(undo)
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    editSummary.appendChild(table)
  }

  $('loadRuns').addEventListener('click', function () {
    var target = pathInput.value.trim()
    if (!target) { setStatus('请先指定 PDF', 'err'); return }
    setStatus('读取可编辑内容…')
    edits = {}
    selected = null
    editorEl.style.display = 'none'
    request(apiBase() + '/runs?path=' + encodeURIComponent(target))
      .then(function (body) {
        model = body
        currentPage = 0
        stageEl.style.display = ''
        var total = body.content.reduce(function (n, p) { return n + p.runs.length }, 0)
        var undecodable = body.content.reduce(function (n, p) { return n + p.undecodableFonts.length }, 0)
        setStatus('可编辑 run 共 ' + total + ' 个（' + body.pages + ' 页）' + (undecodable ? '，' + undecodable + ' 个字体缺 ToUnicode' : ''), 'ok')
        ;(body.notes || []).forEach(function (note) { log('· ' + note) })
        updateSummary()
        renderCanvas()
      })
      .catch(function (error) { log('读取失败：' + error.message, 'err'); setStatus('读取失败', 'err') })
  })

  $('prevPage').addEventListener('click', function () {
    if (model === null || currentPage === 0) return
    currentPage -= 1
    selected = null
    editorEl.style.display = 'none'
    renderCanvas()
  })
  $('nextPage').addEventListener('click', function () {
    if (model === null || currentPage >= model.pages - 1) return
    currentPage += 1
    selected = null
    editorEl.style.display = 'none'
    renderCanvas()
  })
  $('zoom').addEventListener('input', function () { renderCanvas() })

  $('apply').addEventListener('click', function () {
    if (model === null) return
    var list = Object.keys(edits).map(function (id) {
      var page = null
      model.content.forEach(function (p) {
        p.runs.forEach(function (r) { if (r.id === id) page = p })
      })
      return { page: page ? page.page : 1, targetId: id, to: edits[id] }
    })
    if (list.length === 0) return
    setStatus('正在写回…')
    $('apply').disabled = true
    request(apiBase() + '/apply', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: model.sourcePath, edits: list }),
    }).then(function (body) {
      setStatus('已写出：' + body.outputPath + '（应用 ' + body.applied + ' 处）', 'ok')
      ;(body.notes || []).forEach(function (note) { log('· ' + note, 'warn') })
      log('提示：改写后 run 的 id 会整体前移，请重新「载入可编辑内容」再继续编辑。')
    }).catch(function (error) { log('写回失败：' + error.message, 'err'); setStatus('写回失败', 'err') })
      .then(function () { $('apply').disabled = Object.keys(edits).length === 0 })
  })

  // ── watermark / password view ─────────────────────────────────────────────

  var renderCandidates = function (body) {
    var box = $('wmList')
    box.innerHTML = ''
    var candidates = body.candidates || []
    if (candidates.length === 0) {
      var none = document.createElement('div')
      none.className = 'muted'
      none.textContent = '没有找到可移除的水印对象。'
      box.appendChild(none)
    } else {
      var table = document.createElement('table')
      table.innerHTML = '<thead><tr><th>页</th><th>类型</th><th>置信度</th><th>依据</th></tr></thead>'
      var tbody = document.createElement('tbody')
      candidates.forEach(function (c) {
        var tr = document.createElement('tr')
        tr.innerHTML = '<td></td><td></td><td></td><td></td>'
        tr.children[0].textContent = c.page
        tr.children[1].textContent = c.kind === 'xobject' ? 'Form XObject' : '内联算子'
        tr.children[2].textContent = Math.round(c.confidence * 100) + '%'
        tr.children[3].textContent = c.detail
        tbody.appendChild(tr)
      })
      table.appendChild(tbody)
      box.appendChild(table)
    }
    // The refusals are the honest half: say what could not be examined, so an
    // empty list is never mistaken for "this file is clean".
    ;(body.refused || []).forEach(function (item) {
      var line = document.createElement('div')
      line.className = 'muted'
      line.textContent = '第 ' + item.page + ' 页：' + item.detail
      box.appendChild(line)
    })
    $('wmRemove').disabled = candidates.filter(function (c) { return c.confidence >= 0.9 }).length === 0
  }

  $('wmAdd').addEventListener('click', function () {
    var target = pathInput.value.trim()
    var text = $('wmText').value.trim()
    if (!target) { setStatus('请先指定 PDF', 'err'); return }
    if (!text) { setStatus('请输入水印文字', 'err'); return }
    setStatus('正在添加水印…')
    $('wmAdd').disabled = true
    request(apiBase() + '/watermark/add', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: target,
        text: text,
        placement: $('wmPlace').value,
        opacity: Number($('wmOpacity').value) / 100,
        fontSize: Number($('wmSize').value),
      }),
    }).then(function (body) {
      setStatus('已添加水印到 ' + body.pages + ' 页：' + body.outputPath, 'ok')
      if (body.droppedChars && body.droppedChars.length) {
        log('以下字符所选字体无法编码，已丢弃：' + body.droppedChars.join(' '), 'warn')
      }
      ;(body.notes || []).forEach(function (note) { log('· ' + note) })
    }).catch(function (error) { log('添加失败：' + error.message, 'err'); setStatus('添加失败', 'err') })
      .then(function () { $('wmAdd').disabled = false })
  })

  $('wmScan').addEventListener('click', function () {
    var target = pathInput.value.trim()
    if (!target) { setStatus('请先指定 PDF', 'err'); return }
    setStatus('正在扫描水印…')
    request(apiBase() + '/watermark/scan?path=' + encodeURIComponent(target))
      .then(function (body) {
        renderCandidates(body)
        setStatus('扫描到 ' + body.candidates.length + ' 个候选', body.candidates.length ? 'ok' : 'warn')
      })
      .catch(function (error) { log('扫描失败：' + error.message, 'err'); setStatus('扫描失败', 'err') })
  })

  $('wmRemove').addEventListener('click', function () {
    var target = pathInput.value.trim()
    if (!target) return
    setStatus('正在移除…')
    $('wmRemove').disabled = true
    request(apiBase() + '/watermark/remove', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target }),
    }).then(function (body) {
      if (body.dryRun) {
        setStatus('预览：将移除 ' + body.removed.length + ' 个', 'warn')
        return
      }
      setStatus('已移除 ' + body.removed.length + ' 个水印：' + body.outputPath, 'ok')
      ;(body.notes || []).forEach(function (note) { log('· ' + note, 'warn') })
      ;(body.skipped || []).forEach(function (c) {
        log('已保留（置信度 ' + Math.round(c.confidence * 100) + '%）：' + c.detail, 'warn')
      })
    }).catch(function (error) { log('移除失败：' + error.message, 'err'); setStatus('移除失败', 'err') })
      .then(function () { $('wmRemove').disabled = false })
  })

  var showProtection = function (body) {
    var box = $('pwState')
    box.innerHTML = ''
    var line = document.createElement('div')
    if (!body.encrypted) {
      line.className = 'muted'
      line.textContent = '该文件未加密（没有 /Encrypt）。'
    } else if (body.opensWithoutPassword) {
      line.className = 'warn'
      line.textContent = '该文件已加密，但无需密码即可打开（仅限制了复制/修改等权限）。'
    } else {
      line.className = 'ok'
      line.textContent = '该文件已加密，且需要密码才能打开。'
    }
    box.appendChild(line)
  }

  $('pwCheck').addEventListener('click', function () {
    var target = pathInput.value.trim()
    if (!target) { setStatus('请先指定 PDF', 'err'); return }
    request(apiBase() + '/encryption?path=' + encodeURIComponent(target))
      .then(function (body) { showProtection(body); setStatus('已查询保护状态') })
      .catch(function (error) { log('查询失败：' + error.message, 'err') })
  })

  $('pwEncrypt').addEventListener('click', function () {
    var target = pathInput.value.trim()
    var password = $('pwUser').value
    if (!target) { setStatus('请先指定 PDF', 'err'); return }
    if (!password) { setStatus('请输入密码', 'err'); return }
    setStatus('正在加密…')
    request(apiBase() + '/protect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target, action: 'encrypt', userPassword: password, allow: ['print'] }),
    }).then(function (body) {
      setStatus('已加密：' + body.outputPath + '（' + Math.round(body.bytes / 1024) + 'KB）', 'ok')
      showProtection(body)
      log('注意：加密会阻止未授权读取，但也会让部分工具无法再直接编辑。')
    }).catch(function (error) { log('加密失败：' + error.message, 'err'); setStatus('加密失败', 'err') })
  })

  $('pwDecryptBtn').addEventListener('click', function () {
    var target = pathInput.value.trim()
    var password = $('pwDecrypt').value
    if (!target) { setStatus('请先指定 PDF', 'err'); return }
    setStatus('正在解除密码…')
    request(apiBase() + '/protect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target, action: 'decrypt', password: password }),
    }).then(function (body) {
      setStatus('已解除密码：' + body.outputPath, 'ok')
      showProtection(body)
    }).catch(function (error) {
      log('解除失败：' + error.message, 'err')
      setStatus('解除失败（密码不对或文件未加密）', 'err')
    })
  })

  // ── preview ───────────────────────────────────────────────────────────────
  //
  // Renders every page as a thumbnail so the document is visible before making
  // any decision about it. Two deliberate choices:
  //
  //   - geometry comes from `/info`, NOT `/analyze`: previewing a scanned file
  //     must not trigger OCR (seconds per page) just to show page one.
  //   - thumbnails are lazy (`loading="lazy"`), so a 200-page document fetches
  //     only the pages actually scrolled to instead of rendering all of them.

  /** Render scale for a thumbnail of a given CSS width. */
  var thumbScale = function (pageWidth, cssWidth) {
    return Math.max(0.4, Math.min(2, cssWidth / Math.max(1, pageWidth)))
  }

  var openViewer = function (url) {
    var viewer = document.createElement('div')
    viewer.className = 'viewer'
    var img = document.createElement('img')
    img.src = url
    var hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = '点击任意处关闭'
    viewer.appendChild(img)
    viewer.appendChild(hint)
    viewer.addEventListener('click', function () { viewer.remove() })
    root.appendChild(viewer)
  }

  var renderPages = function (info) {
    var box = $('pages')
    box.innerHTML = ''
    var cssWidth = Number($('previewSize').value)
    box.style.gridTemplateColumns = 'repeat(auto-fill,minmax(' + cssWidth + 'px,1fr))'

    var loaded = 0
    var failed = 0
    var report = function () {
      var total = info.pages
      if (failed > 0) {
        $('previewInfo').textContent = loaded + ' / ' + total + ' 页已显示，' + failed + ' 页失败'
      } else if (loaded === total) {
        $('previewInfo').textContent = total + ' 页全部显示'
      }
    }

    info.sizes.forEach(function (size) {
      var figure = document.createElement('figure')
      var frame = document.createElement('div')
      frame.className = 'frame'

      var img = document.createElement('img')
      img.alt = '第 ' + size.page + ' 页'
      // The image is ALWAYS laid out; the placeholder covers it and is removed
      // once the image loads.
      //
      // This shape is deliberate. An earlier version hid the image with
      // `display:none` until `load` fired, which DEADLOCKS together with
      // `loading="lazy"`: an image with no layout box never intersects the
      // viewport, so the browser never fetches it, so `load` never fires, so it
      // never becomes visible. The user saw a grid of "第 N 页" placeholders
      // instead of the document.
      img.loading = 'lazy'
      var scale = thumbScale(size.width, cssWidth)
      var thumbUrl = apiBase() + '/page.png?page=' + size.page + '&scale=' + scale.toFixed(2)
        + '&path=' + encodeURIComponent(info.sourcePath)

      var placeholder = document.createElement('div')
      placeholder.className = 'ph'
      placeholder.textContent = '第 ' + size.page + ' 页'

      var reveal = function () {
        loaded += 1
        if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder)
        report()
      }
      img.addEventListener('load', reveal)
      img.addEventListener('error', function () {
        failed += 1
        placeholder.className = 'ph err'
        placeholder.textContent = '第 ' + size.page + ' 页加载失败'
        report()
      })
      img.addEventListener('click', function () {
        openViewer(apiBase() + '/page.png?page=' + size.page + '&scale=2&path=' + encodeURIComponent(info.sourcePath))
      })

      frame.appendChild(img)
      frame.appendChild(placeholder)
      figure.appendChild(frame)

      var caption = document.createElement('figcaption')
      caption.textContent = size.page + ' / ' + info.pages
      figure.appendChild(caption)
      box.appendChild(figure)
      // The source is set only AFTER insertion, so the browser's lazy loading
      // can defer the fetch for pages that are off-screen.
      img.src = thumbUrl
      if (img.complete && img.naturalWidth > 0) reveal()
    })
  }

  $('previewOpen').addEventListener('click', function () {
    var target = pathInput.value.trim()
    if (!target) { setStatus('请先指定 PDF（可直接粘贴完整路径）', 'err'); return }
    setStatus('读取文档信息…')
    $('pages').innerHTML = '<div class="muted" style="padding:8px">读取中…</div>'
    request(apiBase() + '/info?path=' + encodeURIComponent(target))
      .then(function (body) {
        var size = body.sizes[0]
        // Set the summary BEFORE rendering: `renderPages` updates the same line
        // as images finish, and writing afterwards would clobber its counter.
        $('previewInfo').textContent = body.pages + ' 页'
          + (size ? ' · ' + size.width.toFixed(0) + '×' + size.height.toFixed(0) + 'pt' : '')
          + (body.encrypted ? ' · 已加密' : '')
        renderPages(body)
        setStatus('已载入 ' + body.pages + ' 页预览', 'ok')
      })
      .catch(function (error) {
        $('pages').innerHTML = ''
        log('预览失败：' + error.message, 'err')
        setStatus('预览失败：' + error.message, 'err')
      })
  })

  $('previewSize').addEventListener('change', function () {
    var target = pathInput.value.trim()
    if (!target) return
    $('previewOpen').click()
  })

  // ── 待确认操作: plans waiting for a human ─────────────────────────────────
  //
  // A destructive call must not happen because an agent decided it should. The
  // host writes the plan down, this panel lists it, and the plan only runs
  // after the person in front of the screen presses 确认执行 — the assistant is
  // then told to continue with that exact plan id.
  //
  // Everything on a card (title, sheet, hints) arrives from the API and is
  // inserted with textContent. A title or a sheet is untrusted input: it is
  // never parsed as HTML, and no innerHTML concatenation happens below.

  var POLL_MS = 3000
  var GATE_LABELS = { destructive: '破坏性', expensive: '高成本', ambiguous: '有歧义' }
  /** Last list from GET /plans; left untouched when that route fails. */
  var plans = []
  var plansDown = false
  /** planId -> 'confirmed' | 'cancelled'. A local decision outranks a stale
   *  server list, so a handled card never flips back to 待确认. */
  var planDecisions = {}
  /** planId -> plan snapshot, so a confirmed card still shows the sentence the
   *  user has to paste even if a later poll no longer lists that plan. */
  var planSnapshots = {}
  var plansTimer = null

  var isExpired = function (plan) {
    return typeof plan.expiresAt === 'number' && plan.expiresAt <= Date.now()
  }
  /** First 8 characters: enough to identify a plan in a sentence, short enough
   *  to say out loud. */
  var shortId = function (plan) {
    return typeof plan.planId === 'string' ? plan.planId.slice(0, 8) : ''
  }
  var remainingText = function (plan) {
    if (typeof plan.expiresAt !== 'number') return ''
    var ms = plan.expiresAt - Date.now()
    if (ms <= 0) return '已过期'
    return '还有 ' + Math.ceil(ms / 60000) + ' 分钟'
  }

  /** A list of plain-text items, or nothing at all when it is empty/absent. */
  var appendPlanList = function (card, caption, items) {
    if (!Array.isArray(items) || items.length === 0) return
    var box = document.createElement('div')
    var label = document.createElement('div')
    label.className = 'muted'
    label.textContent = caption
    box.appendChild(label)
    var list = document.createElement('ul')
    list.className = 'plan-list'
    items.forEach(function (item) {
      var li = document.createElement('li')
      li.textContent = String(item)
      list.appendChild(li)
    })
    box.appendChild(list)
    card.appendChild(box)
  }

  var buildPlanCard = function (plan, decision) {
    var card = document.createElement('div')
    card.className = 'plan'
    card.setAttribute('data-plan-id', typeof plan.planId === 'string' ? plan.planId : '')

    var head = document.createElement('div')
    head.className = 'plan-head'
    var title = document.createElement('span')
    title.className = 'plan-title'
    title.textContent = plan.title ? String(plan.title) : '待确认操作'
    head.appendChild(title)

    var gateKey = typeof plan.gate === 'string' ? plan.gate : ''
    var gate = document.createElement('span')
    gate.className = 'tag ' + (GATE_LABELS[gateKey] ? gateKey : 'empty')
    gate.textContent = GATE_LABELS[gateKey] || gateKey || '待确认'
    head.appendChild(gate)

    var idEl = document.createElement('span')
    idEl.className = 'plan-id'
    idEl.textContent = '#' + shortId(plan)
    head.appendChild(idEl)

    var remaining = remainingText(plan)
    if (remaining) {
      var time = document.createElement('span')
      time.className = remaining === '已过期' ? 'warn' : 'muted'
      time.textContent = remaining
      head.appendChild(time)
    }
    card.appendChild(head)

    // The sheet is a multi-line confirmation slip. textContent + the pre-wrap
    // rule keep its newlines without ever treating it as markup.
    if (plan.sheet) {
      var sheet = document.createElement('div')
      sheet.className = 'plan-sheet'
      sheet.textContent = String(plan.sheet)
      card.appendChild(sheet)
    }
    appendPlanList(card, '可纠正项（直接说就能改）', plan.hints)
    appendPlanList(card, '需要确认的歧义', plan.ambiguous)

    if (decision === 'confirmed') {
      var done = document.createElement('div')
      done.className = 'plan-ok'
      done.textContent = '已确认，请对助手说：继续执行计划 ' + shortId(plan)
      card.appendChild(done)
      return card
    }

    var row = document.createElement('div')
    row.className = 'row'
    var confirmBtn = document.createElement('button')
    confirmBtn.type = 'button'
    confirmBtn.setAttribute('data-action', 'confirm')
    confirmBtn.textContent = '确认执行'
    var cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'ghost'
    cancelBtn.setAttribute('data-action', 'cancel')
    cancelBtn.textContent = '取消'
    var note = document.createElement('span')
    note.className = 'muted'
    row.appendChild(confirmBtn)
    row.appendChild(cancelBtn)
    row.appendChild(note)
    card.appendChild(row)

    var busy = false
    /**
     * POST confirm|cancel, then commit the answer locally.
     *
     * A failure must not pop a dialog (the panel has none) and must not lose
     * the plan: the buttons go back to enabled and the card says so once.
     */
    var resolvePlan = function (action, commit) {
      if (busy) return
      busy = true
      confirmBtn.disabled = true
      cancelBtn.disabled = true
      note.textContent = action === 'confirm' ? '正在确认…' : '正在取消…'
      request(apiBase() + '/plans/' + encodeURIComponent(plan.planId) + '/' + action, { method: 'POST' })
        .then(function (body) { commit(body && body.plan ? body.plan : plan) })
        .catch(function () {
          busy = false
          confirmBtn.disabled = false
          cancelBtn.disabled = false
          note.textContent = '操作失败，请重试'
        })
    }

    confirmBtn.addEventListener('click', function () {
      resolvePlan('confirm', function (updated) {
        planDecisions[plan.planId] = 'confirmed'
        planSnapshots[plan.planId] = updated && updated.planId ? updated : plan
        renderPlans()
      })
    })
    cancelBtn.addEventListener('click', function () {
      resolvePlan('cancel', function () {
        planDecisions[plan.planId] = 'cancelled'
        delete planSnapshots[plan.planId]
        renderPlans()
      })
    })
    return card
  }

  var renderPlans = function () {
    var entries = []
    var listed = {}

    plans.forEach(function (plan) {
      if (!plan || typeof plan !== 'object') return
      var id = plan.planId
      if (id === undefined || id === null) return
      listed[id] = true
      if (planDecisions[id] === 'cancelled') return
      // Only a LOCAL confirmation keeps a card on screen: a plan the server
      // already reports as confirmed was decided elsewhere, and the section is
      // for plans that still need a person.
      if (planDecisions[id] === 'confirmed') {
        entries.push({ plan: plan, decision: 'confirmed' })
        return
      }
      if (plan.status === 'pending') entries.push({ plan: plan, decision: null })
    })

    // A confirmed card outlives the list entry it came from: the user still has
    // to copy the sentence for the assistant.
    Object.keys(planSnapshots).forEach(function (id) {
      if (listed[id] || planDecisions[id] !== 'confirmed') return
      if (isExpired(planSnapshots[id])) { delete planSnapshots[id]; return }
      entries.push({ plan: planSnapshots[id], decision: 'confirmed' })
    })

    planListEl.innerHTML = ''
    entries.forEach(function (entry) { planListEl.appendChild(buildPlanCard(entry.plan, entry.decision)) })
    plansDownEl.style.display = plansDown ? '' : 'none'
    // Hidden entirely when there is nothing to confirm and the host answered:
    // no placeholder, no "暂无". The one exception is an unreachable route,
    // which has to say so — otherwise "no plans" and "could not ask" would look
    // identical.
    plansEl.style.display = (entries.length > 0 || plansDown) ? '' : 'none'
  }

  var refreshPlans = function () {
    return request(apiBase() + '/plans')
      .then(function (body) {
        plansDown = false
        plans = body && Array.isArray(body.plans) ? body.plans : []
        renderPlans()
      })
      .catch(function () {
        // Silent failure on purpose: a missing or older host route must not
        // throw anything over the panel, and the last known plans stay visible.
        plansDown = true
        renderPlans()
      })
  }

  var startPlansPolling = function () {
    if (plansTimer !== null) return
    refreshPlans()
    plansTimer = window.setInterval(refreshPlans, POLL_MS)
  }
  var stopPlansPolling = function () {
    if (plansTimer === null) return
    window.clearInterval(plansTimer)
    plansTimer = null
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') return
    // Returning to the tab is exactly when a plan may have appeared (or run
    // out), so refresh now instead of waiting up to POLL_MS.
    refreshPlans()
  })

  // Ask once at load: a plan may already be waiting before the panel is opened.
  refreshPlans()

  // ── movable surfaces ──────────────────────────────────────────────────────
  //
  // Both floating surfaces (the launcher and the panel) can be dragged anywhere
  // on screen and remember where they were put. Position is stored in CSS pixels
  // and CLAMPED to the viewport on restore: an unclamped saved position puts the
  // surface off-screen permanently the moment the window gets smaller, with no
  // way back except clearing storage. That is a trap, so the clamp runs on load
  // and on every resize.

  var POS_KEY = 'dsh-pdf-studio-positions'
  /** Keep at least this much of a surface on screen, so it stays grabbable. */
  var MIN_VISIBLE_X = 72
  var MIN_VISIBLE_Y = 32

  var readPositions = function () {
    try {
      var raw = window.localStorage.getItem(POS_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch (error) {
      // Storage can be unavailable (private mode, restricted renderer). Losing
      // persistence is acceptable; crashing the surface is not.
      return {}
    }
  }
  var positions = readPositions()

  var persist = function () {
    try { window.localStorage.setItem(POS_KEY, JSON.stringify(positions)) } catch (error) { /* ignore */ }
  }

  /** Pin a surface at an absolute spot, switching it off right/bottom anchoring. */
  var pin = function (el, left, top) {
    var maxLeft = Math.max(0, window.innerWidth - MIN_VISIBLE_X)
    var maxTop = Math.max(0, window.innerHeight - MIN_VISIBLE_Y)
    el.style.left = Math.max(0, Math.min(left, maxLeft)) + 'px'
    el.style.top = Math.max(0, Math.min(top, maxTop)) + 'px'
    el.style.right = 'auto'
    el.style.bottom = 'auto'
  }

  var restore = function (el, key) {
    var saved = positions[key]
    if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') pin(el, saved.left, saved.top)
  }

  /**
   * Make `el` draggable by `handle`.
   *
   * Uses pointer events with capture so a fast drag that leaves the element does
   * not drop the gesture. A grab that starts on a control inside the handle is
   * ignored, so clicking a tab or a slider never starts a drag.
   */
  var makeDraggable = function (el, handle, key, options) {
    var moved = false
    var dragging = false
    var offsetX = 0
    var offsetY = 0
    var startLeft = 0
    var startTop = 0
    var suppressClick = options && options.suppressClick === true

    handle.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return
      // Ignore a grab that starts on a CONTROL INSIDE the handle — but not the
      // handle itself. The launcher IS a button, so excluding every `button`
      // made it undraggable; the test caught that immediately.
      if (event.target !== handle && event.target.closest
        && event.target.closest('button, input, select, .tab')) return

      var rect = el.getBoundingClientRect()
      offsetX = event.clientX - rect.left
      offsetY = event.clientY - rect.top
      startLeft = rect.left
      startTop = rect.top
      dragging = true
      moved = false
      if (handle.setPointerCapture) {
        try { handle.setPointerCapture(event.pointerId) } catch (error) { /* ignore */ }
      }
      event.preventDefault()
    })

    handle.addEventListener('pointermove', function (event) {
      if (!dragging) return
      var left = event.clientX - offsetX
      var top = event.clientY - offsetY
      // Only commit to a drag once the pointer has actually travelled. A plain
      // click therefore leaves the surface anchored to its default corner
      // instead of silently pinning it to an absolute position.
      if (!moved) {
        if (Math.abs(left - startLeft) < 3 && Math.abs(top - startTop) < 3) return
        moved = true
        pin(el, startLeft, startTop)
      }
      pin(el, left, top)
    })

    var finish = function (event) {
      if (!dragging) return
      dragging = false
      if (handle.releasePointerCapture) {
        try { handle.releasePointerCapture(event.pointerId) } catch (error) { /* ignore */ }
      }
      if (moved) {
        positions[key] = { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 }
        persist()
      }
    }
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)

    if (suppressClick) {
      // A drag on a button must not also fire its click, or moving the launcher
      // would open the panel every time. Capture phase, so it runs before the
      // button's own open handler.
      handle.addEventListener('click', function (event) {
        if (moved) {
          event.stopPropagation()
          event.preventDefault()
          moved = false
        }
      }, true)
    }
  }

  makeDraggable(launcher, launcher, 'launcher', { suppressClick: true })
  restore(launcher, 'launcher')
  makeDraggable(panel, panel.querySelector('.head'), 'panel')
  // The header contains tabs and the close button; those are excluded inside
  // `makeDraggable`, so grabbing the empty part of the bar still moves it.
  restore(panel, 'panel')

  // Double-clicking the title bar returns the panel to its default corner. A
  // movable window needs an escape hatch: without one, a surface dragged to an
  // awkward spot has to be fixed by clearing site storage.
  panel.querySelector('.title').addEventListener('dblclick', function () {
    delete positions.panel
    persist()
    panel.style.left = ''
    panel.style.top = ''
    panel.style.right = '18px'
    panel.style.bottom = '96px'
  })
  launcher.addEventListener('dblclick', function () {
    delete positions.launcher
    persist()
    launcher.style.left = ''
    launcher.style.top = ''
    launcher.style.right = '18px'
    launcher.style.bottom = '96px'
  })

  // Re-clamp on resize so a surface can never become unreachable.
  // 卸载/测试用的停止钩子：jsdom 里 window.setInterval 会挂住 Node 事件循环，
  // 测试跑完必须能显式停掉轮询（页面里也用于将来可能的 HMR 卸载）。
  window.__dshPdfStudioStop = function () {
    if (plansTimer) {
      window.clearInterval(plansTimer)
      plansTimer = null
    }
  }

  window.addEventListener('resize', function () {
    var launcherSaved = positions.launcher
    if (launcherSaved) pin(launcher, launcherSaved.left, launcherSaved.top)
    var panelSaved = positions.panel
    if (panelSaved) pin(panel, panelSaved.left, panelSaved.top)
  })

  log('PDF 工作台已加载（host-only surface）')
})()
