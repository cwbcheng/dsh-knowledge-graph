// DSH 划线拆图 — popup app. Talks to the LOCAL DSH server's /dsh-kg endpoints
// (registered by the dsh-knowledge-graph plugin host; not gated by the
// browser-trust fence), renders the graph with the KGViewer bundle.
'use strict'

// ?mode=window → standalone resizable window (opened via ⛶ button): the
// browser popup itself cannot be resized, so this page adapts to the window.
const IS_WINDOW = new URLSearchParams(location.search).get('mode') === 'window'
if (IS_WINDOW) {
  const setFull = (el) => {
    el.style.width = '100%'
    el.style.height = '100%'
    el.style.overflow = 'auto'
  }
  setFull(document.documentElement)
  setFull(document.body)
  document.getElementById('root').style.width = '100%'
  document.getElementById('root').style.height = '100%'
  document.body.classList.add('kg-full-window')
}

const { useState, useEffect, useRef, useMemo } = React
const h = React.createElement
const KG = window.KGViewer
const { GraphViewer, makeView, splitParagraphs, TYPE_META, TYPE_ORDER, LAYOUT_MODES, NL } = KG

const DEFAULT_BASE = 'http://127.0.0.1:3080'
let BASE = DEFAULT_BASE

async function api(path, opts) {
  const res = await fetch(BASE + path, opts)
  return res.json()
}

// The GraphViewer expects a Cordis ctx; the popup only needs timeouts.
const ctxShim = {
  timeout(fn, ms) { const id = setTimeout(fn, ms); return () => clearTimeout(id) },
  interval(fn, ms) { const id = setInterval(fn, ms); return () => clearInterval(id) },
}

function App() {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [phase, setPhase] = useState('idle') // idle | extracting | done
  const [taskId, setTaskId] = useState(null)
  const [error, setError] = useState(null)
  const [view, setView] = useState(null)
  const [selectedNodeId, setSelectedNodeId] = useState(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState(null)
  const [focusReq, setFocusReq] = useState({ nodeId: null, seq: 0 })
  const [activePara, setActivePara] = useState(-1)
  const [flashPara, setFlashPara] = useState(-1)
  const [layoutMode, setLayoutMode] = useState('force')
  const [baseInput, setBaseInput] = useState('')
  const [baseSaved, setBaseSaved] = useState(false)
  const submittedRef = useRef({ title: '', text: '' })
  const busyRef = useRef(false)

  useEffect(() => {
    chrome.storage.local.get({ kgBase: DEFAULT_BASE }, (s) => {
      if (s && typeof s.kgBase === 'string' && s.kgBase) {
        BASE = s.kgBase
        setBaseInput(s.kgBase)
      }
    })
    // Standalone window: restore the draft (text/title/task) the popup handed
    // over when the ⛶ button was clicked, so work continues in the window.
    chrome.storage.session.get({ kgDraft: null }, (s) => {
      const d = s && s.kgDraft
      if (d && typeof d === 'object') {
        if (typeof d.text === 'string' && d.text) setText(d.text)
        if (typeof d.title === 'string' && d.title) setTitle(d.title)
        submittedRef.current = { title: typeof d.title === 'string' ? d.title : '', text: typeof d.text === 'string' ? d.text : '' }
        if (typeof d.taskId === 'string' && d.taskId) setTaskId(d.taskId)
        return
      }
      chrome.storage.session.get({ kgText: '' }, (s2) => {
        if (s2 && typeof s2.kgText === 'string' && s2.kgText) {
          setText(s2.kgText)
          chrome.storage.session.remove('kgText')
        }
      })
    })
    // Non-window popup: consume the selection stash as before.
    if (!IS_WINDOW) {
      chrome.storage.session.get({ kgText: '' }, (s) => {
        if (s && typeof s.kgText === 'string' && s.kgText) {
          setText(s.kgText)
          chrome.storage.session.remove('kgText')
          return
        }
        // Fallback: content script's last-resort storage.local stash.
        chrome.storage.local.get({ kgText: '' }, (sl) => {
          if (sl && typeof sl.kgText === 'string' && sl.kgText) {
            setText(sl.kgText)
            chrome.storage.local.remove('kgText')
          }
        })
      })
    }
  }, [])

  // ---- polling ----
  useEffect(() => {
    if (!taskId) return
    let stop = false
    let timer = null
    let delay = 3000
    const start = Date.now()
    const tick = async () => {
      if (stop) return
      let res = null
      try {
        res = await api('/dsh-kg/task-status?taskId=' + encodeURIComponent(taskId), { cache: 'no-store' })
      } catch (e) {
        if (stop) return
        setPhase('idle'); setTaskId(null)
        setError({ message: '无法连接 DSH 服务（' + BASE + '），请确认 dsh web 已启动' })
        return
      }
      if (stop) return
      if (res && res.status === 'succeeded') {
        const g = res.result
        if (g && Array.isArray(g.nodes)) {
          const sub = submittedRef.current
          setView(makeView(g, sub.text))
          setPhase('done'); setTaskId(null)
          setSelectedNodeId(null); setSelectedEdgeId(null); setActivePara(-1)
        } else {
          setPhase('idle'); setTaskId(null)
          setError({ message: 'AI 返回的结果缺少图数据，请重试' })
        }
        return
      }
      if (res && res.status === 'failed') {
        setPhase('idle'); setTaskId(null)
        const err = res.error || {}
        setError({ message: err.message || 'AI 拆分失败，请稍后重试' })
        return
      }
      if (res && res.status === 'not_found') {
        setPhase('idle'); setTaskId(null)
        setError({ message: '拆分任务已过期（服务可能已重启），请重新提交' })
        return
      }
      if (Date.now() - start > 45 * 60 * 1000) {
        setPhase('idle'); setTaskId(null)
        setError({ message: '等待超时，任务仍在后台运行，请重新提交' })
        return
      }
      if (Date.now() - start > 60 * 1000) delay = Math.min(delay * 1.5, 15000)
      timer = setTimeout(tick, delay)
    }
    tick()
    return () => { stop = true; if (timer) clearTimeout(timer) }
  }, [taskId])

  const submit = async () => {
    const t = text.trim()
    if (!t) { setError({ message: '请先粘贴或选中要拆分的文字' }); return }
    if (t.length > 20000) { setError({ message: '文字不能超过 20000 字' }); return }
    if (busyRef.current) return
    busyRef.current = true
    setError(null)
    setPhase('extracting')
    setView(null)
    setSelectedNodeId(null); setSelectedEdgeId(null); setActivePara(-1)
    const payload = { title, text: t }
    submittedRef.current = payload
    try {
      const res = await api('/dsh-kg/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res && res.error) { setPhase('idle'); setError(res.error); return }
      if (res && res.taskId) setTaskId(res.taskId)
      else { setPhase('idle'); setError({ message: '无法提交拆分任务，请重试' }) }
    } catch (e) {
      setPhase('idle')
      setError({ message: '无法连接 DSH 服务（' + BASE + '），请确认 dsh web 已启动' })
    } finally {
      busyRef.current = false
    }
  }

  const handleSelectNode = (nodeId) => {
    setSelectedNodeId(nodeId)
    setSelectedEdgeId(null)
    if (!nodeId || !view) return
    const off = view.anchors[nodeId]
    if (off == null) return
    const pi = view.paragraphs.findIndex((p) => off >= p.start && off < p.end)
    if (pi < 0) return
    setActivePara(pi)
    setFlashPara(pi)
    setTimeout(() => setFlashPara(-1), 1400)
    const el = document.getElementById('kg-ext-para-' + pi)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  const handleSelectEdge = (idx) => { setSelectedEdgeId(idx); setSelectedNodeId(null) }
  const handleParagraphClick = (pi) => {
    if (!view) return
    setActivePara(pi)
    const ids = view.paraNodes[pi] || []
    if (ids.length === 0) return
    setSelectedNodeId(ids[0])
    setSelectedEdgeId(null)
    setFocusReq((f) => ({ nodeId: ids[0], seq: f.seq + 1 }))
  }
  const changeLayoutMode = (id) => setLayoutMode(id)
  const saveBase = () => {
    const v = baseInput.trim() || DEFAULT_BASE
    BASE = v.replace(/\/+$/, '')
    chrome.storage.local.set({ kgBase: BASE })
    setBaseSaved(true)
    setTimeout(() => setBaseSaved(false), 1500)
  }

  const openWindow = async () => {
    // Hand the current draft (text/title/running task) to the standalone
    // resizable window, then open it.
    try {
      await chrome.storage.session.set({ kgDraft: { title, text, taskId } })
    } catch (e) {}
    const url = chrome.runtime.getURL('popup.html') + '?mode=window'
    try {
      await chrome.windows.create({ url, type: 'popup', width: 1200, height: 850 })
    } catch (e) {
      window.open(url, '_blank')
    }
  }

  const paraEl = (p, i) => {
    const badges = view ? (view.paraTypes[i] || []) : []
    return h('div', {
      key: i,
      id: 'kg-ext-para-' + i,
      className: 'kg-para' + (activePara === i ? ' kg-active' : '') + (flashPara === i ? ' kg-flash' : ''),
      role: 'button', tabIndex: 0,
      onClick: () => handleParagraphClick(i),
      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleParagraphClick(i) } },
    },
      badges.length > 0
        ? h('div', { className: 'kg-para-badges' },
            badges.map((t) => h('span', { key: t, className: 'knowledge-type-badge kg-badge-' + t }, TYPE_META[t].label)))
        : null,
      h('p', null, p.text),
    )
  }

  const resultPanel = view
    ? (() => {
        const graph = view.graph
        const resolvedCount = graph.nodes.length - view.unresolved.length
        return h('div', { className: 'kg-result' },
          h('p', { className: 'kg-summary' }, h('strong', null, '一句话总结：'), ' ', graph.summary || '（无）'),
          h('div', { className: 'kg-stats' },
            h('span', null, graph.nodes.length + ' 个节点'),
            h('span', null, graph.edges.length + ' 条关系'),
            h('span', null, '可回链 ' + resolvedCount + '/' + graph.nodes.length),
          ),
          h('p', { className: 'kg-hint' }, '点击原文段落 → 图中聚焦节点；点击图中节点 → 查看完整内容并定位原文。'),
          h('div', { className: 'kg-cols' },
            h('div', { className: 'kg-original', 'aria-label': '原文段落' },
              view.paragraphs.map(paraEl)),
            h('div', { className: 'kg-graph-col' },
              h(GraphViewer, {
                nodes: graph.nodes, edges: graph.edges, anchors: view.anchors,
                selectedNodeId, selectedEdgeId, focusReq,
                onSelectNode: handleSelectNode, onSelectEdge: handleSelectEdge,
                ctx: ctxShim,
                height: 380,
                layoutMode, onLayoutModeChange: changeLayoutMode,
              }),
              h('div', { className: 'kg-legend' },
                TYPE_ORDER.map((t) => h('span', { key: t, className: 'kg-legend-item' },
                  h('span', { className: 'kg-legend-dot', style: { background: TYPE_META[t].color } }),
                  TYPE_META[t].label))),
            ),
          ),
        )
      })()
    : null

  return h('div', { className: 'kg-root kg-ext' },
    h('div', { className: 'kg-win' },
      h('div', { className: 'kg-win-bar' },
        h('span', { className: 'kg-win-dot' }),
        h('span', { className: 'kg-win-title' }, 'DSH 划线拆图'),
        IS_WINDOW ? null : h('button', {
          type: 'button', className: 'kg-win-max', 'aria-label': '在新窗口打开（可调整大小）',
          title: '在新窗口打开（可调整大小）',
          onClick: () => openWindow(),
        }, '⛶'),
        h('button', { type: 'button', className: 'kg-win-close', 'aria-label': '关闭', onClick: () => window.close() }, '×'),
      ),
      h('div', { className: 'kg-win-body' },
        error
          ? h('div', { className: 'kg-banner', role: 'alert' },
              h('span', null, error.message || '出错了，请重试'),
              h('button', { type: 'button', 'aria-label': '关闭提示', onClick: () => setError(null) }, '×'))
          : null,
        phase === 'extracting'
          ? h('div', { className: 'kg-empty' },
              h('div', { className: 'kg-spinner', 'aria-hidden': 'true' }),
              h('p', null, '正在用 AI 拆分（约 15-40 秒）...'),
              h('p', { className: 'kg-empty-sub' }, '调用本机 DSH 服务：' + BASE),
            )
          : h(React.Fragment, null,
              h('input', {
                className: 'kg-input-title', placeholder: '标题（可选）', value: title, maxLength: 200,
                onChange: (e) => setTitle(e.target.value), 'aria-label': '标题（可选）',
              }),
              h('textarea', {
                className: 'kg-textarea',
                placeholder: '在任意网页选中文字后点「拆成知识图」，或直接粘贴文本…',
                value: text, maxLength: 20000,
                onChange: (e) => setText(e.target.value), 'aria-label': '要拆分的文字',
              }),
              h('div', { className: 'kg-actions' },
                h('span', { className: 'kg-counter' }, '已输入 ' + text.length + ' / 20000 字'),
                h('button', {
                  type: 'button', className: 'kg-primary',
                  disabled: text.trim().length === 0,
                  onClick: () => submit(),
                }, 'AI 拆分'),
              ),
              resultPanel,
              h('div', { className: 'kg-ext-settings' },
                h('span', null, 'DSH 服务：'),
                h('input', {
                  value: baseInput, placeholder: DEFAULT_BASE,
                  onChange: (e) => setBaseInput(e.target.value),
                  'aria-label': 'DSH 服务地址',
                }),
                h('button', { type: 'button', className: 'kg-secondary', onClick: saveBase }, baseSaved ? '已保存 ✓' : '保存'),
              ),
            ),
      ),
    ),
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(h(App))
