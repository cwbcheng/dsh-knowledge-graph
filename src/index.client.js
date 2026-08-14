/**
 * dsh-knowledge-graph — Client half (DSH Cordis plugin, browser)
 *
 * A floating workbench registered into three slots:
 *   - shell.overlay        : the draggable/resizable floating window
 *   - sidebar.footer.action : a persistent "知识图" launcher visible in every
 *                             conversation
 *   - tool.view.cordis     : a compact launcher card inside the run card
 *
 * Features:
 *   - Input panel (schedule an AI extraction) that auto-collapses after a
 *     successful split to save vertical space.
 *   - Result panel: left original text (split into paragraphs, each with a
 *     type badge) and right an SVG knowledge graph. Width ratio and height of
 *     the pair are adjustable by dragging the split bars, and persisted.
 *   - Two-way linking: clicking a node scrolls to the paragraph it anchors to;
 *     clicking a paragraph focuses the node in the graph. Anchoring is driven
 *     primarily by the model-supplied paragraph number (deterministic), with
 *     quote matching and token-overlap as fallbacks. Unresolvable nodes appear
 *     in a diagnostics list.
 *   - Graph: 7 node-type colors, ring + force-direction relaxation layout with
 *     overlap resolution, pan / ctrl+wheel zoom / toolbar +/- and % reset,
 *     long-press tooltip with the original-text quote, keyboard focusable.
 *   - History: every successful split is saved (localStorage) and can be
 *     revisited, deleted or cleared.
 *   - Toasts are rendered as a floating overlay so they never cause layout
 *     shifts.
 *
 * Plain JavaScript returning a Cordis Plugin. No TypeScript / JSX.
 */

export default function clientPlugin() {
  return {
    inject: ['timer'],
    async apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // ----------------------------- styles -----------------------------
      styles.insert(`
.kg-root { --kg-text: #1f2937; --kg-text-dim: #6b7280; --kg-border: rgba(100,116,139,0.28); --kg-panel: rgba(127,127,127,0.055); font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; color: var(--kg-text); line-height: 1.5; min-width: 0; }
@media (prefers-color-scheme: dark) { .kg-root { --kg-text: #e5e7eb; --kg-text-dim: #9ca3af; --kg-border: rgba(148,163,184,0.30); --kg-panel: rgba(255,255,255,0.045); } }
.kg-kicker { font-size: 11px; letter-spacing: 0.08em; color: #3b82f6; font-weight: 600; margin-bottom: 2px; }
.kg-subtitle { margin: 6px 0 0; font-size: 13px; color: var(--kg-text-dim); line-height: 1.7; }
.kg-banner { display: flex; align-items: flex-start; gap: 10px; background: rgba(239,68,68,0.10); border: 1px solid rgba(239,68,68,0.45); color: #dc2626; border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-bottom: 12px; }
.kg-banner button { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; font-size: 15px; line-height: 1; padding: 0 2px; }
.kg-toast { position: absolute; top: 50px; left: 50%; transform: translateX(-50%); z-index: 70; pointer-events: none; padding: 8px 14px; border-radius: 10px; font-size: 12.5px; background: rgba(30,64,175,0.92); border: 1px solid rgba(96,165,250,0.6); color: #eff6ff; box-shadow: 0 6px 18px rgba(0,0,0,0.25); white-space: nowrap; }
.kg-card { border: 1px solid var(--kg-border); border-radius: 12px; padding: 14px 16px; background: var(--kg-panel); margin-bottom: 14px; }
.kg-section-title { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
.kg-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.kg-panel-head .kg-section-title { margin: 0; }
.kg-collapse-btn { padding: 4px 12px; font-size: 12px; border-radius: 8px; }
.kg-input-title { display: block; width: 100%; box-sizing: border-box; margin-bottom: 10px; border: 1px solid var(--kg-border); border-radius: 10px; padding: 9px 12px; background: var(--kg-panel); color: var(--kg-text); font: inherit; font-size: 14px; }
.kg-input-title:focus, .kg-textarea:focus { outline: 2px solid rgba(59,130,246,0.45); border-color: #3b82f6; }
.kg-textarea { display: block; width: 100%; box-sizing: border-box; min-height: 220px; resize: vertical; border: 1px solid var(--kg-border); border-radius: 10px; padding: 10px 12px; background: var(--kg-panel); color: var(--kg-text); font: inherit; font-size: 14px; line-height: 1.7; }
.kg-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 10px; }
.kg-counter { font-size: 12px; color: var(--kg-text-dim); margin-right: auto; }
.kg-primary { background: #3b82f6; color: #fff; border: none; border-radius: 10px; padding: 8px 20px; font-size: 14px; font-weight: 600; cursor: pointer; }
.kg-primary:hover:not(:disabled) { background: #2563eb; }
.kg-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.kg-secondary { background: transparent; color: var(--kg-text-dim); border: 1px solid var(--kg-border); border-radius: 10px; padding: 7px 14px; font-size: 13px; cursor: pointer; }
.kg-secondary:hover { color: var(--kg-text); border-color: var(--kg-text-dim); }
.kg-body-toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.kg-body-toolbar-text { min-width: 0; }
.kg-body-toolbar .kg-subtitle { margin: 4px 0 0; }
.kg-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 84px 20px; }
.kg-spinner { width: 38px; height: 38px; border-radius: 50%; border: 3px solid rgba(59,130,246,0.22); border-top-color: #3b82f6; animation: kg-spin 0.9s linear infinite; }
@keyframes kg-spin { to { transform: rotate(360deg); } }
.kg-empty p { margin: 0; font-size: 15px; color: var(--kg-text); }
.kg-empty-sub { font-size: 12px !important; color: var(--kg-text-dim) !important; }
.kg-summary { margin: 4px 0 10px; font-size: 13.5px; line-height: 1.7; }
.kg-summary strong { color: #3b82f6; }
.kg-stats { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-bottom: 8px; font-size: 12px; color: var(--kg-text-dim); }
.kg-diag-toggle { background: none; border: none; color: #b45309; cursor: pointer; font-size: 12px; padding: 0; }
@media (prefers-color-scheme: dark) { .kg-diag-toggle { color: #fbbf24; } }
.kg-diag-list { margin: 8px 0 10px; padding: 10px 12px; background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.35); border-radius: 8px; font-size: 12px; color: #92400e; white-space: pre-wrap; word-break: break-all; }
@media (prefers-color-scheme: dark) { .kg-diag-list { color: #fcd34d; } }
.kg-hint { margin: 0 0 10px; font-size: 12px; color: var(--kg-text-dim); }
.kg-cols { display: grid; gap: 14px; }
.kg-original { display: flex; flex-direction: column; gap: 10px; overflow: auto; }
.kg-split-handle { display: none; }
.kg-h-handle { display: flex; align-items: center; justify-content: center; height: 10px; margin-top: 10px; cursor: row-resize; touch-action: none; user-select: none; }
.kg-h-bar { width: 56px; height: 3px; border-radius: 2px; background: var(--kg-border); transition: background 0.15s; }
.kg-h-handle:hover .kg-h-bar, .kg-h-handle:active .kg-h-bar { background: #3b82f6; }
.kg-para { border: 1px solid var(--kg-border); border-radius: 10px; padding: 9px 12px; background: var(--kg-panel); cursor: pointer; transition: border-color 0.15s; }
.kg-para:hover { border-color: rgba(59,130,246,0.6); }
.kg-para p { margin: 6px 0 2px; white-space: pre-wrap; font-size: 13.5px; word-break: break-word; }
.kg-para:focus-visible { outline: 2px solid rgba(59,130,246,0.55); outline-offset: 1px; }
.kg-para.kg-active { border-color: #3b82f6; box-shadow: inset 3px 0 0 #3b82f6; }
.kg-para-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.knowledge-type-badge { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 18px; color: #fff; font-weight: 500; }
.kg-badge-fact { background: #3b82f6; } .kg-badge-inference { background: #8b5cf6; } .kg-badge-concept { background: #10b981; } .kg-badge-definition { background: #f59e0b; } .kg-badge-example { background: #06b6d4; } .kg-badge-counter_example { background: #ef4444; } .kg-badge-rule { background: #7c3aed; }
.kg-para.kg-flash { animation: kg-para-glow 1.4s ease; }
@keyframes kg-para-glow { 0%, 100% { background: transparent; } 30% { background: rgba(59,130,246,0.22); } }
.kg-graph { position: relative; overflow: hidden; border: 1px solid var(--kg-border); border-radius: 10px; height: 460px; background: var(--kg-panel); touch-action: none; user-select: none; }
.kg-graph-toolbar { position: absolute; top: 10px; right: 10px; z-index: 2; display: flex; gap: 6px; }
.kg-graph-toolbar button { min-width: 30px; height: 28px; padding: 0 8px; border: 1px solid var(--kg-border); border-radius: 7px; background: var(--kg-panel); color: var(--kg-text); font-size: 12px; cursor: pointer; }
.kg-graph-toolbar button:hover { border-color: rgba(59,130,246,0.6); color: #3b82f6; }
.kg-node-name { fill: var(--kg-text); }
.kg-node:hover rect { stroke-width: 2.5 !important; }
.kg-node:focus-visible rect { stroke: #3b82f6; stroke-width: 3; }
.kg-edge-label { pointer-events: none; }
.kg-edge-label rect { fill: var(--kg-win-bg); stroke: var(--kg-border); stroke-width: 1; }
.kg-edge-label text { fill: var(--kg-text-dim); font-size: 10px; font-weight: 500; }
.kg-edge-label.sel rect { fill: rgba(99,102,241,0.16); stroke: #6366f1; }
.kg-edge-label.sel text { fill: #6366f1; font-weight: 600; }
.kg-edge-label.hov rect { stroke: #6366f1; }
.kg-edge-label.hov text { fill: #6366f1; }
.kg-node-flash { animation: kg-node-pulse 1.4s ease; }
@keyframes kg-node-pulse { 0%, 100% { opacity: 1; } 35% { opacity: 0.3; } }
.kg-tooltip { position: absolute; z-index: 5; max-width: 300px; pointer-events: none; background: rgba(17,24,39,0.95); color: #f9fafb; border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.55; box-shadow: 0 4px 14px rgba(0,0,0,0.28); transform: translate(10px, 10px); }
.kg-tooltip-type { font-weight: 600; margin-bottom: 2px; }
.kg-tooltip-quote { margin-top: 4px; color: #cbd5e1; }
.kg-legend { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 8px; font-size: 11px; color: var(--kg-text-dim); }
.kg-legend-item { display: inline-flex; align-items: center; gap: 5px; }
.kg-legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.kg-launcher { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border: 1px solid var(--kg-border); border-radius: 12px; background: var(--kg-panel); }
.kg-launcher-text { min-width: 0; }
.kg-launcher-title { font-size: 14px; font-weight: 600; }
.kg-launcher-sub { font-size: 12px; color: var(--kg-text-dim); margin-top: 2px; }
.kg-launcher .kg-primary { white-space: nowrap; }
.kg-sidebar-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; background: transparent; border: 0; border-radius: 8px; color: inherit; cursor: pointer; padding: 5px 8px; font-size: 12px; font-family: inherit; }
.kg-sidebar-btn:hover { background: rgba(127,127,127,0.16); }
.kg-header-btn { display: inline-flex; align-items: center; gap: 5px; background: transparent; border: 1px solid transparent; border-radius: 8px; color: inherit; cursor: pointer; padding: 4px 10px; font-size: 12.5px; font-family: inherit; }
.kg-header-btn:hover { background: rgba(127,127,127,0.14); border-color: rgba(127,127,127,0.28); }
.kg-history-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.kg-history-head .kg-section-title { margin: 0; }
.kg-history-list { display: flex; flex-direction: column; gap: 8px; }
.kg-history-item { border: 1px solid var(--kg-border); border-radius: 10px; padding: 10px 12px; background: var(--kg-panel); cursor: pointer; }
.kg-history-item:hover { border-color: rgba(59,130,246,0.6); }
.kg-history-item-title { font-size: 13.5px; font-weight: 600; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.kg-history-item-meta { font-size: 11.5px; color: var(--kg-text-dim); margin-top: 3px; }
.kg-history-item-summary { font-size: 12.5px; color: var(--kg-text-dim); margin-top: 4px; line-height: 1.6; }
.kg-history-del { flex: none; background: none; border: none; color: var(--kg-text-dim); cursor: pointer; font-size: 13px; padding: 0 4px; }
.kg-history-del:hover { color: #dc2626; }
.kg-win { --kg-text: #1f2937; --kg-text-dim: #6b7280; --kg-border: rgba(100,116,139,0.28); --kg-panel: rgba(127,127,127,0.055); --kg-win-bg: #ffffff; position: fixed; display: flex; flex-direction: column; border: 1px solid var(--kg-border); border-radius: 14px; background: var(--kg-win-bg); color: var(--kg-text); box-shadow: 0 16px 48px rgba(0,0,0,0.30); z-index: 60; pointer-events: auto; overflow: hidden; font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; line-height: 1.5; }
@media (prefers-color-scheme: dark) { .kg-win { --kg-text: #e5e7eb; --kg-text-dim: #9ca3af; --kg-border: rgba(148,163,184,0.30); --kg-panel: rgba(255,255,255,0.045); --kg-win-bg: #111827; } }
.kg-win-bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--kg-border); background: var(--kg-panel); cursor: grab; user-select: none; touch-action: none; }
.kg-win-bar:active { cursor: grabbing; }
.kg-win-dot { width: 8px; height: 8px; border-radius: 50%; background: #3b82f6; flex: none; }
.kg-win-title { font-size: 13.5px; font-weight: 600; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kg-win-close { flex: none; width: 26px; height: 26px; border: none; border-radius: 7px; background: transparent; color: var(--kg-text-dim); font-size: 16px; line-height: 1; cursor: pointer; }
.kg-win-close:hover { background: rgba(239,68,68,0.14); color: #dc2626; }
.kg-win-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px; container-type: inline-size; }
.kg-win-resize { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; touch-action: none; }
.kg-win-resize::after { content: ''; position: absolute; right: 4px; bottom: 4px; width: 8px; height: 8px; border-right: 2px solid var(--kg-text-dim); border-bottom: 2px solid var(--kg-text-dim); border-bottom-right-radius: 2px; }
@container (min-width: 900px) { .kg-cols { grid-template-columns: minmax(240px, var(--kg-split, 46%)) 12px minmax(0, 1fr); align-items: start; gap: 14px 0; } .kg-split-handle { display: flex; align-items: center; justify-content: center; cursor: col-resize; touch-action: none; user-select: none; } .kg-split-bar { width: 3px; height: 52px; border-radius: 2px; background: var(--kg-border); transition: background 0.15s; } .kg-split-handle:hover .kg-split-bar, .kg-split-handle:active .kg-split-bar { background: #3b82f6; } .kg-graph-col { position: sticky; top: 10px; } }
`)

      // --------------------------- constants ----------------------------
      const h = React.createElement
      const { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } = React

      const NL = String.fromCharCode(10)
      const IDEO_SPACE = String.fromCharCode(12288)
      const MAX_LEN = 20000
      const LS_PENDING = 'dsh-kg-pending-v1'
      const LS_RESULT = 'dsh-kg-result-v1'
      const LS_DRAFT = 'dsh-kg-draft-v1'
      const LS_WIN = 'dsh-kg-win-v1'
      const LS_HISTORY = 'dsh-kg-history-v1'
      const LS_SPLIT = 'dsh-kg-split-v1'
      const LS_HEIGHT = 'dsh-kg-height-v1'
      const HISTORY_MAX = 20

      const TYPE_META = {
        fact: { label: '事实', color: '#3b82f6', fill: 'rgba(59,130,246,0.15)' },
        inference: { label: '推论', color: '#8b5cf6', fill: 'rgba(139,92,246,0.15)' },
        concept: { label: '概念', color: '#10b981', fill: 'rgba(16,185,129,0.15)' },
        definition: { label: '定义', color: '#f59e0b', fill: 'rgba(245,158,11,0.16)' },
        example: { label: '例子', color: '#06b6d4', fill: 'rgba(6,182,212,0.15)' },
        counter_example: { label: '反例', color: '#ef4444', fill: 'rgba(239,68,68,0.15)' },
        rule: { label: '规则', color: '#7c3aed', fill: 'rgba(124,58,237,0.16)' },
      }
      const REL_LABEL = { supports: '支持', example: '例子', counter_example: '反例', defines: '定义', infers: '推断', causes: '因果' }
      const TYPE_ORDER = ['fact', 'inference', 'concept', 'definition', 'example', 'counter_example', 'rule']

      // ------------------------ cross-component stores ------------------------
      const winListeners = new Set()
      let winOpen = false
      const winStore = {
        setOpen(v) { if (winOpen !== v) { winOpen = v; for (const fn of winListeners) fn() } },
        getOpen() { return winOpen },
        subscribe(fn) { winListeners.add(fn); return () => winListeners.delete(fn) },
      }

      const toastListeners = new Set()
      let toastMsg = null
      let toastTimer = null
      const toastStore = {
        get() { return toastMsg },
        show(msg) {
          toastMsg = msg
          for (const fn of toastListeners) fn()
          if (toastTimer) { toastTimer(); toastTimer = null }
          toastTimer = ctx.timeout(() => {
            toastTimer = null
            toastMsg = null
            for (const fn of toastListeners) fn()
          }, 3000)
        },
        clear() {
          if (toastTimer) { toastTimer(); toastTimer = null }
          toastMsg = null
          for (const fn of toastListeners) fn()
        },
        subscribe(fn) { toastListeners.add(fn); return () => toastListeners.delete(fn) },
      }

      // ----------------------------- history -----------------------------
      function loadHistory() {
        try {
          const arr = JSON.parse(localStorage.getItem(LS_HISTORY) || 'null')
          if (Array.isArray(arr)) {
            return arr.filter((e) => e && e.graph && Array.isArray(e.graph.nodes) && typeof e.text === 'string').slice(0, HISTORY_MAX)
          }
        } catch (e) {}
        return []
      }
      function saveHistory(list) {
        try { localStorage.setItem(LS_HISTORY, JSON.stringify(list.slice(0, HISTORY_MAX))) } catch (e) {}
      }
      function appendHistory(list, entry) {
        const next = [entry].concat(list.filter((e) => e && e.text !== entry.text))
        if (next.length > HISTORY_MAX) next.length = HISTORY_MAX
        saveHistory(next)
        return next
      }
      function formatTime(ts) {
        const d = new Date(ts)
        if (isNaN(d.getTime())) return ''
        const p = (n) => (n < 10 ? '0' + n : '' + n)
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
      }

      function GraphIcon(size) {
        return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          h('circle', { cx: 4.5, cy: 11.5, r: 2, stroke: 'currentColor', strokeWidth: 1.4 }),
          h('circle', { cx: 11.5, cy: 4.5, r: 2, stroke: 'currentColor', strokeWidth: 1.4 }),
          h('circle', { cx: 11.5, cy: 11.5, r: 1.6, stroke: 'currentColor', strokeWidth: 1.4 }),
          h('path', { d: 'M 6.2 10.4 L 9.8 5.7', stroke: 'currentColor', strokeWidth: 1.4 }),
          h('path', { d: 'M 10.1 4.5 L 10.1 9.9', stroke: 'currentColor', strokeWidth: 1.4 }),
        )
      }

      // ----------------------------- utils -----------------------------
      const clamp = (v, a, b) => Math.min(Math.max(v, a), b)
      const isWS = (ch) => ch === ' ' || ch === NL || ch === IDEO_SPACE || ch.charCodeAt(0) === 9

      function tokenize(s) {
        const out = []
        let cur = ''
        for (const ch of s) {
          if (isWS(ch)) { if (cur) { out.push(cur); cur = '' } } else cur += ch
        }
        if (cur) out.push(cur)
        return out
      }

      // --------------------- anchor resolution ---------------------
      // Quote normalization modes for fuzzy matching.
      const PUNCT_CHARS = (function () {
        const set = new Set()
        const add = (s) => { for (const ch of s) set.add(ch) }
        add('，。！？、；：…—（）,.!?;:()·～')
        add(String.fromCharCode(8220) + String.fromCharCode(8221) + String.fromCharCode(8216) + String.fromCharCode(8217))
        add(String.fromCharCode(12300) + String.fromCharCode(12301) + String.fromCharCode(12302) + String.fromCharCode(12303))
        return set
      })()
      function normalizeFor(s, mode) {
        const out = []
        const map = []
        let pendingWS = false
        for (let i = 0; i < s.length; i++) {
          const ch = s[i]
          const ws = isWS(ch)
          const punct = PUNCT_CHARS.has(ch)
          if (mode === 'ws' && ws) {
            if (out.length > 0 && !pendingWS) { out.push(' '); map.push(i); pendingWS = true }
          } else if (mode === 'punct' && punct) {
            pendingWS = false
          } else if (mode === 'both' && (ws || punct)) {
            if (out.length > 0 && !pendingWS) { out.push(' '); map.push(i); pendingWS = true }
          } else {
            out.push(ch); map.push(i); pendingWS = false
          }
        }
        return { text: out.join(''), map }
      }
      function fuzzyMatch(needle, source, maxSkips) {
        if (!needle || needle.length < 3 || !source) return null
        const anchor = needle[0]
        let pos = -1
        let best = null
        let scanned = 0
        while (scanned < 80) {
          pos = source.indexOf(anchor, pos + 1)
          if (pos < 0) break
          scanned += 1
          let qi = 0
          let si = pos
          let skips = 0
          let gap = 0
          while (qi < needle.length && si < source.length) {
            if (source[si] === needle[qi]) { qi += 1; si += 1; gap = 0 }
            else if (skips < maxSkips && gap < 6) { skips += 1; si += 1; gap += 1 }
            else break
          }
          if (!best || qi > best.matched) best = { pos, matched: qi }
          if (best && best.matched >= needle.length - 1) break
        }
        if (!best) return null
        const required = needle.length <= 4 ? needle.length : needle.length - 2
        return best.matched >= required ? best.pos : null
      }
      function resolveNeedle(needle, source) {
        if (!needle) return null
        const q = needle.trim()
        if (!q) return null
        const idx = source.indexOf(q)
        if (idx >= 0) return idx
        const modes = ['ws', 'punct', 'both']
        for (const mode of modes) {
          const qn = normalizeFor(q, mode)
          if (qn.text.length < 2) continue
          const sn = normalizeFor(source, mode)
          const hit = sn.text.indexOf(qn.text)
          if (hit >= 0) return sn.map[hit]
        }
        const minLen = 3
        const maxLen = Math.min(q.length, 24)
        for (let len = maxLen; len >= minLen; len--) {
          const idx2 = source.indexOf(q.slice(0, len))
          if (idx2 >= 0) return idx2
        }
        for (let len = maxLen; len >= minLen; len--) {
          const idx2 = source.indexOf(q.slice(q.length - len))
          if (idx2 >= 0) return idx2
        }
        const rawHit = fuzzyMatch(q, source, 3)
        if (rawHit != null) return rawHit
        const pn = normalizeFor(q, 'punct')
        if (pn.text.length >= 3) {
          const sn2 = normalizeFor(source, 'punct')
          const pnHit = fuzzyMatch(pn.text, sn2.text, 2)
          if (pnHit != null) return sn2.map[pnHit]
        }
        return null
      }
      function resolveAnchor(quote, source, fallbackText) {
        let off = resolveNeedle(quote, source)
        if (off == null && fallbackText && fallbackText !== quote) off = resolveNeedle(fallbackText, source)
        return off
      }

      // Split the source into paragraphs with [start, end) offsets.
      // MUST match the host's splitParagraphsHost numbering exactly.
      function splitParagraphs(source) {
        const lines = source.split(NL)
        const out = []
        const para = []
        let offset = 0
        for (const line of lines) {
          if (line.trim() === '') {
            if (para.length > 0) {
              const text = para.join(NL)
              out.push({ text, start: offset - text.length - 1, end: offset - 1 })
              para.length = 0
            }
          } else {
            para.push(line)
          }
          offset += line.length + 1
        }
        if (para.length > 0) {
          const text = para.join(NL)
          out.push({ text, start: offset - text.length - 1, end: offset - 1 })
        }
        return out.filter((p) => p.text.trim().length > 0)
      }

      // Build the view model: anchor every node to a paragraph offset and work
      // out each paragraph's node types (for badges) and node ids (for focus).
      function makeView(graph, sourceText) {
        const paragraphs = splitParagraphs(sourceText)
        const anchors = {}
        const unresolved = []
        const paraTypes = paragraphs.map(() => [])
        const paraNodes = paragraphs.map(() => [])
        for (const n of graph.nodes) {
          // 1) precise quote match; 2) deterministic paragraph number; 3) token overlap
          let off = resolveAnchor(n.quote, sourceText, n.text)
          if (off == null && typeof n.paragraph === 'number' && n.paragraph >= 0 && n.paragraph < paragraphs.length) {
            off = paragraphs[n.paragraph].start
          }
          if (off == null && n.quote) {
            const qt = tokenize(n.quote)
            if (qt.length > 0) {
              let bestPi = -1
              let bestScore = 0
              for (let i = 0; i < paragraphs.length; i++) {
                const tokens = new Set(tokenize(paragraphs[i].text))
                let score = 0
                for (const t of qt) {
                  if (t.length >= 2 && tokens.has(t)) score += 1
                }
                if (score > bestScore) { bestScore = score; bestPi = i }
              }
              if (bestScore >= 2) off = paragraphs[bestPi].start
            }
          }
          anchors[n.id] = off
          if (off == null) unresolved.push({ id: n.id, quote: (n.quote || '').slice(0, 30) })
        }
        for (const n of graph.nodes) {
          const off = anchors[n.id]
          if (off == null) continue
          const pi = paragraphs.findIndex((p) => off >= p.start && off < p.end)
          if (pi < 0) continue
          if (paraTypes[pi].indexOf(n.type) < 0) paraTypes[pi].push(n.type)
          paraNodes[pi].push(n.id)
        }
        for (let i = 0; i < paraTypes.length; i++) {
          paraTypes[i].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b))
        }
        return { graph, sourceText, paragraphs, anchors, unresolved, paraTypes, paraNodes }
      }

      // --------------------------- graph layout ---------------------------
      function wrapText(g, text, maxWidth) {
        const trimmed = (text || '').trim()
        if (!trimmed) return ['']
        const words = tokenize(trimmed)
        const lines = []
        let line = ''
        for (const word of words) {
          if (g.measureText(word).width > maxWidth) {
            if (line) { lines.push(line); line = '' }
            let cur = ''
            for (const ch of word) {
              const test = cur + ch
              if (cur && g.measureText(test).width > maxWidth) { lines.push(cur); cur = ch }
              else cur = test
            }
            if (cur) line = cur
            continue
          }
          const test = line ? line + ' ' + word : word
          if (g.measureText(test).width <= maxWidth || !line) line = test
          else { lines.push(line); line = word }
        }
        if (line) lines.push(line)
        if (lines.length > 4) { lines.length = 4; lines[3] = lines[3].slice(0, 36) + '…' }
        return lines.length > 0 ? lines : ['']
      }
      function computeNodeSizes(nodes) {
        const canvas = document.createElement('canvas')
        const g = canvas.getContext('2d')
        g.font = '600 13px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
        const out = new Map()
        for (const node of nodes) {
          const meta = TYPE_META[node.type] || { label: '未知' }
          const labelW = g.measureText(meta.label).width
          const WRAP_W = 162
          const lines = wrapText(g, node.text, WRAP_W)
          let textW = labelW
          for (const ln of lines) textW = Math.max(textW, g.measureText(ln).width)
          out.set(node.id, { w: clamp(textW + 34, 96, 200), h: 20 * lines.length + 40, lines })
        }
        return out
      }
      let labelMeasurer = null
      function measureLabel(text) {
        if (!labelMeasurer) {
          const canvas = document.createElement('canvas')
          labelMeasurer = canvas.getContext('2d')
          labelMeasurer.font = '500 10px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
        }
        return labelMeasurer.measureText(text).width
      }
      function layoutGraph(nodes, edges, sizes) {
        const n = nodes.length
        const pos = new Map()
        if (n === 0) return { pos }
        const deg = new Map()
        for (const node of nodes) deg.set(node.id, 0)
        for (const e of edges) {
          if (deg.has(e.fromNodeId)) deg.set(e.fromNodeId, deg.get(e.fromNodeId) + 1)
          if (deg.has(e.toNodeId)) deg.set(e.toNodeId, deg.get(e.toNodeId) + 1)
        }
        let center = nodes[0]
        for (const node of nodes) if (deg.get(node.id) > deg.get(center.id)) center = node
        pos.set(center.id, { x: 0, y: 0 })
        const rest = nodes.filter((x) => x.id !== center.id)
        rest.sort((a, b) => deg.get(b.id) - deg.get(a.id))
        const RING_GAP = 330
        const CAP = 8
        let ring = 1
        let count = 0
        for (const node of rest) {
          const radius = ring * RING_GAP
          const angle = (count / CAP) * Math.PI * 2 + (ring % 2) * (Math.PI / CAP)
          pos.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
          count += 1
          if (count === CAP) { ring += 1; count = 0 }
        }
        if (n > 1) {
          const ids = nodes.map((x) => x.id)
          const ideal = 280
          const repK = 11000
          const spring = 0.02
          const gravity = 0.0018
          for (let iter = 0; iter < 80; iter++) {
            const fx = new Map()
            const fy = new Map()
            for (const id of ids) { fx.set(id, 0); fy.set(id, 0) }
            for (let i = 0; i < n; i++) {
              for (let j = i + 1; j < n; j++) {
                const a = pos.get(ids[i])
                const b = pos.get(ids[j])
                let dx = a.x - b.x
                let dy = a.y - b.y
                let d2 = dx * dx + dy * dy
                if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx * dx + dy * dy }
                const d = Math.sqrt(d2)
                const f = repK / (d * d)
                const ux = dx / d
                const uy = dy / d
                fx.set(ids[i], fx.get(ids[i]) + ux * f)
                fy.set(ids[i], fy.get(ids[i]) + uy * f)
                fx.set(ids[j], fx.get(ids[j]) - ux * f)
                fy.set(ids[j], fy.get(ids[j]) - uy * f)
              }
            }
            for (const e of edges) {
              const a = pos.get(e.fromNodeId)
              const b = pos.get(e.toNodeId)
              if (!a || !b) continue
              let dx = b.x - a.x
              let dy = b.y - a.y
              const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.001)
              const f = (d - ideal) * spring
              const ux = dx / d
              const uy = dy / d
              fx.set(e.fromNodeId, fx.get(e.fromNodeId) + ux * f)
              fy.set(e.fromNodeId, fy.get(e.fromNodeId) + uy * f)
              fx.set(e.toNodeId, fx.get(e.toNodeId) - ux * f)
              fy.set(e.toNodeId, fy.get(e.toNodeId) - uy * f)
            }
            // Edge-node repulsion: push every node that does NOT touch an edge
            // away from that edge's line, so arrows stop slicing through nodes.
            for (const e of edges) {
              const ea = pos.get(e.fromNodeId)
              const eb = pos.get(e.toNodeId)
              if (!ea || !eb) continue
              const abx = eb.x - ea.x
              const aby = eb.y - ea.y
              const len2 = abx * abx + aby * aby
              if (len2 < 1) continue
              for (const node of nodes) {
                if (node.id === e.fromNodeId || node.id === e.toNodeId) continue
                const p = pos.get(node.id)
                const s = sizes.get(node.id)
                let t = ((p.x - ea.x) * abx + (p.y - ea.y) * aby) / len2
                t = Math.max(0, Math.min(1, t))
                const cx = ea.x + abx * t
                const cy = ea.y + aby * t
                const dx = p.x - cx
                const dy = p.y - cy
                const d = Math.max(Math.hypot(dx, dy), 0.001)
                const half = s ? Math.max((s.w + s.h) / 4, 44) : 44
                const minDist = half + 40
                if (d < minDist) {
                  const f = (minDist - d) * 0.028
                  const ux = dx / d
                  const uy = dy / d
                  fx.set(node.id, fx.get(node.id) + ux * f)
                  fy.set(node.id, fy.get(node.id) + uy * f)
                }
              }
            }
            for (const id of ids) {
              if (id === center.id) continue
              const p = pos.get(id)
              const moveX = clamp(fx.get(id) - p.x * gravity, -40, 40)
              const moveY = clamp(fy.get(id) - p.y * gravity, -40, 40)
              p.x += moveX
              p.y += moveY
            }
          }
        }
        if (n > 1) {
          const ids = nodes.map((x) => x.id)
          for (let iter = 0; iter < 50; iter++) {
            let moved = 0
            for (let i = 0; i < n; i++) {
              for (let j = i + 1; j < n; j++) {
                const a = pos.get(ids[i])
                const b = pos.get(ids[j])
                const sa = sizes.get(ids[i])
                const sb = sizes.get(ids[j])
                if (!sa || !sb) continue
                const dx = b.x - a.x
                const dy = b.y - a.y
                const minDx = (sa.w + sb.w) / 2 + 34
                const minDy = (sa.h + sb.h) / 2 + 34
                const ox = minDx - Math.abs(dx)
                const oy = minDy - Math.abs(dy)
                if (ox <= 0 || oy <= 0) continue
                if (ox < oy) {
                  let s = dx >= 0 ? 1 : -1
                  if (dx === 0) s = Math.random() < 0.5 ? -1 : 1
                  a.x -= (s * ox) / 2
                  b.x += (s * ox) / 2
                } else {
                  let s = dy >= 0 ? 1 : -1
                  if (dy === 0) s = Math.random() < 0.5 ? -1 : 1
                  a.y -= (s * oy) / 2
                  b.y += (s * oy) / 2
                }
                moved += 1
              }
            }
            if (moved === 0) break
          }
        }
        return { pos }
      }
      function computeBBox(nodes, layout, sizes) {
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        for (const n of nodes) {
          const p = layout.pos.get(n.id)
          const s = sizes.get(n.id)
          if (!p || !s) continue
          x0 = Math.min(x0, p.x - s.w / 2); y0 = Math.min(y0, p.y - s.h / 2)
          x1 = Math.max(x1, p.x + s.w / 2); y1 = Math.max(y1, p.y + s.h / 2)
        }
        if (!isFinite(x0)) return { w: 600, h: 400, cx: 0, cy: 0, key: 'empty' }
        const w = Math.max(x1 - x0, 1)
        const hgt = Math.max(y1 - y0, 1)
        return { w, h: hgt, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, key: Math.round(w) + 'x' + Math.round(hgt) }
      }
      function intersectDist(size, ux, uy) {
        let t = Infinity
        if (ux !== 0) t = Math.min(t, size.w / 2 / Math.abs(ux))
        if (uy !== 0) t = Math.min(t, size.h / 2 / Math.abs(uy))
        return isFinite(t) ? t : 0
      }
      function edgePoints(a, b, sa, sb) {
        const dx = b.x - a.x
        const dy = b.y - a.y
        const len = Math.max(Math.hypot(dx, dy), 0.001)
        const ux = dx / len
        const uy = dy / len
        const s1 = intersectDist(sa, ux, uy)
        const s2 = intersectDist(sb, ux, uy)
        return { x1: a.x + ux * s1, y1: a.y + uy * s1, x2: b.x - ux * s2, y2: b.y - uy * s2 }
      }
      function zoomAround(v, factor, px, py) {
        const wx = (px - v.tx) / v.k
        const wy = (py - v.ty) / v.k
        const k2 = clamp(v.k * factor, 0.5, 2)
        return { k: k2, tx: px - wx * k2, ty: py - wy * k2 }
      }

      // --------------------------- GraphViewer ---------------------------
      function GraphViewer({ nodes, edges, anchors, selectedNodeId, selectedEdgeId, focusReq, onSelectNode, onSelectEdge, ctx, height }) {
        const containerRef = useRef(null)
        const [view, setView] = useState({ k: 1, tx: 0, ty: 0 })
        const [dragging, setDragging] = useState(false)
        const [tooltip, setTooltip] = useState(null)
        const [flashId, setFlashId] = useState(null)
        const [hoverEdge, setHoverEdge] = useState(null)
        const pressTimer = useRef(null)
        const panRef = useRef(null)

        const sizes = useMemo(() => computeNodeSizes(nodes), [nodes])
        const layout = useMemo(() => layoutGraph(nodes, edges, sizes), [nodes, edges, sizes])
        const bbox = useMemo(() => computeBBox(nodes, layout, sizes), [nodes, layout, sizes])

        // Fan-out curvature: for every source node with 2+ outgoing edges,
        // sort them by target angle and give each a signed perpendicular bend.
        // This spreads the arrows instead of letting them overlap in a bundle.
        const edgeFan = useMemo(() => {
          const curve = new Map()
          const bySource = new Map()
          for (const edge of edges || []) {
            const a = layout.pos.get(edge.fromNodeId)
            if (!a) continue
            if (!bySource.has(edge.fromNodeId)) bySource.set(edge.fromNodeId, [])
            bySource.get(edge.fromNodeId).push(edge)
          }
          for (const list of bySource.values()) {
            const n = list.length
            if (n < 2) continue
            list.sort((x, y) => {
              const px = layout.pos.get(x.toNodeId)
              const py = layout.pos.get(y.toNodeId)
              if (!px || !py) return 0
              return Math.atan2(px.y - layout.pos.get(x.fromNodeId).y, px.x - layout.pos.get(x.fromNodeId).x)
                - Math.atan2(py.y - layout.pos.get(y.fromNodeId).y, py.x - layout.pos.get(y.fromNodeId).x)
            })
            const SPREAD = 26
            list.forEach((edge, k) => {
              const rank = k - (n - 1) / 2
              curve.set(edge, Math.max(-104, Math.min(104, rank * SPREAD)))
            })
          }
          return curve
        }, [edges, layout])

        const fitView = useCallback(() => {
          const el = containerRef.current
          if (!el) return
          const cw = el.clientWidth
          const ch = el.clientHeight
          if (cw <= 0 || ch <= 0) return
          const k = clamp(Math.min(cw / Math.max(bbox.w, 1), ch / Math.max(bbox.h, 1), 1), 0.3, 1)
          setView({ k, tx: cw / 2 - bbox.cx * k, ty: ch / 2 - bbox.cy * k })
        }, [bbox])

        useEffect(() => { fitView() }, [bbox.key])

        // Refit (debounced) when the container resizes (window resize / split drag / height drag).
        useEffect(() => {
          const el = containerRef.current
          if (!el || typeof ResizeObserver === 'undefined') return
          let timer = null
          const ro = new ResizeObserver(() => {
            if (timer) { timer(); timer = null }
            timer = ctx.timeout(() => { timer = null; fitView() }, 250)
          })
          ro.observe(el)
          return () => { ro.disconnect(); if (timer) { timer(); timer = null } }
        }, [fitView])

        // Focus a node (paragraph click -> graph).
        useEffect(() => {
          if (!focusReq || !focusReq.nodeId || !focusReq.seq) return
          const el = containerRef.current
          const p = layout.pos.get(focusReq.nodeId)
          if (!el || !p) return
          const cw = el.clientWidth
          const ch = el.clientHeight
          setView((v) => ({ ...v, tx: cw / 2 - p.x * v.k, ty: ch / 2 - p.y * v.k }))
          setFlashId(focusReq.nodeId)
          return ctx.timeout(() => setFlashId(null), 2000)
        }, [focusReq.seq])

        useEffect(() => {
          const el = containerRef.current
          if (!el) return
          const onWheel = (e) => {
            if (!e.ctrlKey && !e.metaKey) return
            e.preventDefault()
            const rect = el.getBoundingClientRect()
            setView((v) => zoomAround(v, e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top))
          }
          el.addEventListener('wheel', onWheel, { passive: false })
          return () => el.removeEventListener('wheel', onWheel)
        }, [])

        useEffect(() => () => {
          if (pressTimer.current) { pressTimer.current(); pressTimer.current = null }
        }, [])

        const startPress = (e, node) => {
          const el = containerRef.current
          if (!el) return
          const rect = el.getBoundingClientRect()
          const x0 = e.clientX - rect.left
          const y0 = e.clientY - rect.top
          if (pressTimer.current) { pressTimer.current(); pressTimer.current = null }
          pressTimer.current = ctx.timeout(() => setTooltip({ node, x: x0, y: y0 }), 600)
        }
        const cancelPress = () => {
          if (pressTimer.current) { pressTimer.current(); pressTimer.current = null }
        }

        const onBgPointerDown = (e) => {
          const t = e.target
          if (t && typeof t.closest === 'function') {
            if (t.closest('button, .kg-node, .kg-edge')) return
          }
          cancelPress()
          setTooltip(null)
          const el = containerRef.current
          if (!el) return
          el.setPointerCapture(e.pointerId)
          panRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty, moved: false }
          setDragging(true)
        }
        const onBgPointerMove = (e) => {
          const pan = panRef.current
          if (!pan || pan.id !== e.pointerId) return
          const dx = e.clientX - pan.sx
          const dy = e.clientY - pan.sy
          if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true
          setView((v) => ({ ...v, tx: pan.tx + dx, ty: pan.ty + dy }))
        }
        const onBgPointerUp = (e) => {
          const pan = panRef.current
          if (!pan || pan.id !== e.pointerId) return
          panRef.current = null
          setDragging(false)
          if (!pan.moved) {
            onSelectEdge(null)
            onSelectNode(null)
          }
        }

        const zoomBy = (f) => {
          const el = containerRef.current
          if (!el) return
          setView((v) => zoomAround(v, 1 + f, el.clientWidth / 2, el.clientHeight / 2))
        }
        const zoomReset = () => {
          const el = containerRef.current
          if (!el) return
          setView((v) => zoomAround(v, 1 / v.k, el.clientWidth / 2, el.clientHeight / 2))
        }

        const markerId = 'kg-arrow'
        const edgeEls = (edges || []).map((edge, i) => {
          const a = layout.pos.get(edge.fromNodeId)
          const b = layout.pos.get(edge.toNodeId)
          const sa = sizes.get(edge.fromNodeId)
          const sb = sizes.get(edge.toNodeId)
          if (!a || !b || !sa || !sb) return null
          const pts = edgePoints(a, b, sa, sb)
          // quadratic bezier with a signed perpendicular bend (0 = straight)
          const rawBend = edgeFan.get(edge) || 0
          const elen = Math.max(Math.hypot(pts.x2 - pts.x1, pts.y2 - pts.y1), 0.001)
          const bend = rawBend === 0 ? 0 : clamp(rawBend, -elen * 0.35, elen * 0.35)
          const ex = (pts.x2 - pts.x1) / elen
          const ey = (pts.y2 - pts.y1) / elen
          const mx = (pts.x1 + pts.x2) / 2
          const my = (pts.y1 + pts.y2) / 2
          const cxp = mx - ey * bend
          const cyp = my + ex * bend
          const d = 'M ' + pts.x1 + ' ' + pts.y1 + ' Q ' + cxp + ' ' + cyp + ' ' + pts.x2 + ' ' + pts.y2
          const sel = selectedEdgeId === i
          const hover = hoverEdge === i
          const rel = REL_LABEL[edge.relation] || edge.relation
          return h('g', {
            key: edge.fromNodeId + '>' + edge.toNodeId + ':' + i,
            className: 'kg-edge', role: 'button', tabIndex: 0,
            'aria-pressed': sel,
            'aria-label': '关系边：' + rel + '（' + edge.fromNodeId + ' → ' + edge.toNodeId + '）',
            style: { cursor: 'pointer' },
            onFocus: () => setHoverEdge(i), onBlur: () => setHoverEdge(null),
            onPointerEnter: () => setHoverEdge(i), onPointerLeave: () => setHoverEdge(null),
            onClick: (e) => { e.stopPropagation(); onSelectEdge(i) },
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectEdge(i) } },
          },
            h('title', null, rel + '：' + edge.fromNodeId + ' → ' + edge.toNodeId),
            h('path', { d, fill: 'none', stroke: 'transparent', strokeWidth: 14 }),
            h('path', {
              d, fill: 'none',
              stroke: sel ? '#6366f1' : '#9ca3af',
              strokeWidth: sel || hover ? 2.5 : 1.5,
              markerEnd: 'url(#' + markerId + ')',
            }),
            // relation-type label chip at the bezier midpoint (offset
            // perpendicular along the curve normal so it does not sit on the
            // line); the tangent at t=0.5 is parallel to the chord, so the
            // same perpendicular works for straight and curved edges
            h('g', {
              key: 'lbl' + i,
              className: 'kg-edge-label' + (sel ? ' sel' : '') + (hover ? ' hov' : ''),
              'aria-hidden': 'true',
            },
              (function () {
                const bx = (pts.x1 + 2 * cxp + pts.x2) / 4
                const by = (pts.y1 + 2 * cyp + pts.y2) / 4
                const lx = bx - ey * 11
                const ly = by + ex * 11
                const lw = measureLabel(rel) + 10
                const lh = 15
                return [
                  h('rect', {
                    x: lx - lw / 2, y: ly - lh / 2, width: lw, height: lh, rx: 4,
                  }),
                  h('text', { x: lx, y: ly + 3.5, textAnchor: 'middle' }, rel),
                ]
              })(),
            ),
          )
        })

        const nodeEls = (nodes || []).map((node) => {
          const p = layout.pos.get(node.id)
          const s = sizes.get(node.id)
          if (!p || !s) return null
          const meta = TYPE_META[node.type] || { label: '未知', color: '#6b7280', fill: 'rgba(107,114,128,0.15)' }
          const x = p.x - s.w / 2
          const y = p.y - s.h / 2
          const sel = selectedNodeId === node.id
          const flash = flashId === node.id
          const off = anchors[node.id]
          const aria = meta.label + '节点：' + node.text + (off == null ? '，无法回链原文' : '，原文摘录：' + (node.quote || ''))
          return h('g', {
            key: node.id, className: 'kg-node', role: 'button', tabIndex: 0,
            'aria-pressed': sel, 'aria-label': aria,
            style: { cursor: 'pointer' },
            onPointerDown: (e) => { e.stopPropagation(); startPress(e, node) },
            onPointerUp: cancelPress,
            onPointerLeave: cancelPress,
            onClick: (e) => { e.stopPropagation(); cancelPress(); setTooltip(null); onSelectNode(node.id) },
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectNode(node.id) } },
          },
            h('rect', {
              x, y, width: s.w, height: s.h, rx: 10,
              fill: meta.fill,
              stroke: sel ? '#3b82f6' : (flash ? '#f59e0b' : meta.color),
              strokeWidth: sel || flash ? 3 : 1.5,
              className: flash ? 'kg-node-flash' : '',
              style: (sel || flash) ? { filter: flash ? 'drop-shadow(0 0 8px rgba(245,158,11,0.9))' : 'drop-shadow(0 0 6px rgba(59,130,246,0.8))' } : undefined,
            }),
            h('text', { className: 'kg-node-name', x: p.x, y: y + 25, textAnchor: 'middle', fontSize: 13, fontWeight: 600 },
              s.lines.map((ln, li) => h('tspan', { key: li, x: p.x, dy: li === 0 ? 0 : 20 }, ln))),
            h('text', { x: p.x, y: y + s.h - 8, textAnchor: 'middle', fontSize: 10, fill: meta.color, fontWeight: 500 }, meta.label),
          )
        })

        const tooltipEl = tooltip
          ? h('div', { className: 'kg-tooltip', style: { left: tooltip.x, top: tooltip.y } },
              h('div', { className: 'kg-tooltip-type', style: { color: (TYPE_META[tooltip.node.type] || {}).color || '#6b7280' } },
                (TYPE_META[tooltip.node.type] || { label: '未知' }).label),
              h('div', null, tooltip.node.text),
              h('div', { className: 'kg-tooltip-quote' },
                '原文摘录：' + (tooltip.node.quote || '（无摘录）') + (anchors[tooltip.node.id] == null ? '（无法回链原文）' : '')),
            )
          : null

        return h('div', {
          className: 'kg-graph', ref: containerRef,
          role: 'img',
          style: height ? { height: height + 'px' } : undefined,
          'aria-label': '知识图，共 ' + (nodes || []).length + ' 个节点、' + (edges || []).length + ' 条关系。拖拽平移，Ctrl+滚轮缩放，点击节点定位原文，点击段落聚焦节点。',
          onPointerDown: onBgPointerDown,
          onPointerMove: onBgPointerMove,
          onPointerUp: onBgPointerUp,
          onPointerLeave: () => { if (panRef.current) panRef.current = null },
        },
          h('svg', { width: '100%', height: '100%', style: { display: 'block' } },
            h('defs', null,
              h('marker', { id: markerId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' },
                h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#94a3b8' }))),
            h('g', {
              style: {
                transform: 'translate(' + view.tx + 'px, ' + view.ty + 'px) scale(' + view.k + ')',
                transformOrigin: '0px 0px',
                transition: dragging ? 'none' : 'transform 0.35s ease',
              },
            }, edgeEls, nodeEls),
          ),
          h('div', { className: 'kg-graph-toolbar' },
            h('button', { type: 'button', 'aria-label': '缩小（10%）', onClick: () => zoomBy(-0.1) }, '−'),
            h('button', { type: 'button', 'aria-label': '重置缩放为 100%', onClick: zoomReset }, Math.round(view.k * 100) + '%'),
            h('button', { type: 'button', 'aria-label': '放大（10%）', onClick: () => zoomBy(0.1) }, '+'),
          ),
          tooltipEl,
        )
      }

      // --------------------------- window floor ---------------------------
      function WindowInner({ ctx }) {
        const winRef = useRef(null)
        const dragRef = useRef(null)
        const resizeRef = useRef(null)
        const [rect, setRect] = useState(() => loadWinRect())
        const rectRef = useRef(rect)
        const toastMsg = useSyncExternalStore(toastStore.subscribe, toastStore.get)
        useEffect(() => { rectRef.current = rect }, [rect])

        useEffect(() => {
          const onKey = (e) => { if (e.key === 'Escape') winStore.setOpen(false) }
          document.addEventListener('keydown', onKey)
          return () => document.removeEventListener('keydown', onKey)
        }, [])

        const saveRect = (r) => {
          try { localStorage.setItem(LS_WIN, JSON.stringify({ x: r.x, y: r.y, w: r.w, h: r.h })) } catch (e) {}
        }

        const onBarDown = (e) => {
          if (e.button !== 0 && e.pointerType === 'mouse') return
          if (e.target && typeof e.target.closest === 'function' && e.target.closest('button')) return
          const el = winRef.current
          if (!el) return
          el.setPointerCapture(e.pointerId)
          dragRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: rectRef.current.x, y: rectRef.current.y }
        }
        const onResizeDown = (e) => {
          if (e.button !== 0 && e.pointerType === 'mouse') return
          const el = winRef.current
          if (!el) return
          el.setPointerCapture(e.pointerId)
          resizeRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, w: rectRef.current.w, h: rectRef.current.h }
        }
        const onWinMove = (e) => {
          const d = dragRef.current
          if (d && d.id === e.pointerId) {
            const r = rectRef.current
            setRect({
              ...r,
              x: clamp(d.x + (e.clientX - d.sx), -r.w + 140, window.innerWidth - 80),
              y: clamp(d.y + (e.clientY - d.sy), 0, window.innerHeight - 44),
            })
            return
          }
          const z = resizeRef.current
          if (z && z.id === e.pointerId) {
            const r = rectRef.current
            setRect({
              ...r,
              w: clamp(z.w + (e.clientX - z.sx), 480, window.innerWidth - 12),
              h: clamp(z.h + (e.clientY - z.sy), 360, window.innerHeight - 12),
            })
          }
        }
        const onWinUp = (e) => {
          if (dragRef.current && dragRef.current.id === e.pointerId) {
            dragRef.current = null
            saveRect(rectRef.current)
          }
          if (resizeRef.current && resizeRef.current.id === e.pointerId) {
            resizeRef.current = null
            saveRect(rectRef.current)
          }
        }

        return h('div', {
          className: 'kg-win', ref: winRef,
          role: 'dialog', 'aria-label': '资料 ⇄ 知识图 浮动工作台',
          style: { left: rect.x, top: rect.y, width: rect.w, height: rect.h },
          onPointerMove: onWinMove,
          onPointerUp: onWinUp,
        },
          h('div', { className: 'kg-win-bar', onPointerDown: onBarDown, title: '拖动移动窗口' },
            h('span', { className: 'kg-win-dot', 'aria-hidden': 'true' }),
            h('span', { className: 'kg-win-title' }, '知识库 · 资料 ⇄ 知识图'),
            h('button', { type: 'button', className: 'kg-win-close', 'aria-label': '关闭工作台', onClick: () => winStore.setOpen(false) }, '×'),
          ),
          h('div', { className: 'kg-win-body' }, h(WorkbenchBody, { ctx })),
          toastMsg ? h('div', { className: 'kg-toast', role: 'status' }, toastMsg) : null,
          h('div', { className: 'kg-win-resize', 'aria-hidden': 'true', onPointerDown: onResizeDown, title: '拖动调整大小' }),
        )
      }

      function FloatingWindow({ ctx }) {
        const open = useSyncExternalStore(winStore.subscribe, winStore.getOpen)
        if (!open) return null
        return h(WindowInner, { ctx })
      }

      function LauncherCard() {
        const open = useSyncExternalStore(winStore.subscribe, winStore.getOpen)
        return h('div', { className: 'kg-root kg-launcher' },
          h('div', { className: 'kg-launcher-text' },
            h('div', { className: 'kg-launcher-title' }, '资料 ⇄ 知识图'),
            h('div', { className: 'kg-launcher-sub' }, 'AI 知识拆解工作台：浮动窗口，可拖动、可调整大小，图与原文双向定位'),
          ),
          h('button', { type: 'button', className: 'kg-primary', onClick: () => winStore.setOpen(!open) },
            open ? '收起工作台' : '打开工作台'),
        )
      }

      // Header launcher: rendered in the conversation header action row
      // (beside the session title), NOT in the sidebar footer row — the
      // footer row is shared with other plugins' buttons (Cordis Plugin etc.)
      // and gets crowded. Every conversation gets its own copy of this button.
      function HeaderLauncher() {
        return h('button', {
          type: 'button', className: 'kg-header-btn',
          'aria-label': '打开知识图工作台', title: '打开知识图工作台（浮动窗口）',
          onClick: () => winStore.setOpen(true),
        },
          GraphIcon(14),
          h('span', null, '知识图'),
        )
      }

      // -------------------------- workbench body --------------------------
      function WorkbenchBody({ ctx }) {
        const [title, setTitle] = useState('')
        const [text, setText] = useState('')
        const [phase, setPhase] = useState('idle')
        const [taskId, setTaskId] = useState(null)
        const [resultView, setResultView] = useState(null)
        const [error, setError] = useState(null)
        const [showDiag, setShowDiag] = useState(false)
        const [selectedNodeId, setSelectedNodeId] = useState(null)
        const [selectedEdgeId, setSelectedEdgeId] = useState(null)
        const [focusReq, setFocusReq] = useState({ nodeId: null, seq: 0 })
        const [flashPara, setFlashPara] = useState(-1)
        const [activePara, setActivePara] = useState(-1)
        const [history, setHistory] = useState(() => loadHistory())
        const [historyOpen, setHistoryOpen] = useState(false)
        const [inputCollapsed, setInputCollapsed] = useState(false)
        const [splitRatio, setSplitRatio] = useState(() => {
          try {
            const v = parseFloat(localStorage.getItem(LS_SPLIT))
            if (isFinite(v) && v >= 24 && v <= 70) return v
          } catch (e) {}
          return 46
        })
        const [resultHeight, setResultHeight] = useState(() => {
          try {
            const v = parseInt(localStorage.getItem(LS_HEIGHT), 10)
            if (isFinite(v) && v >= 320 && v <= 900) return v
          } catch (e) {}
          return 560
        })
        const colsRef = useRef(null)
        const splitDragRef = useRef(null)
        const hHandleRef = useRef(null)
        const hDragRef = useRef(null)
        const submittedRef = useRef(null)

        // ---- restore pending task / saved result / draft on mount ----
        useEffect(() => {
          let pending = null
          let saved = null
          let draft = null
          try { pending = JSON.parse(localStorage.getItem(LS_PENDING) || 'null') } catch (e) {}
          try { saved = JSON.parse(localStorage.getItem(LS_RESULT) || 'null') } catch (e) {}
          try { draft = JSON.parse(localStorage.getItem(LS_DRAFT) || 'null') } catch (e) {}
          if (pending && pending.taskId) {
            setTitle(typeof pending.title === 'string' ? pending.title : '')
            setText(typeof pending.text === 'string' ? pending.text : '')
            setTaskId(pending.taskId)
            setPhase('extracting')
            submittedRef.current = { title: typeof pending.title === 'string' ? pending.title : '', text: typeof pending.text === 'string' ? pending.text : '' }
          } else if (saved && saved.graph && Array.isArray(saved.graph.nodes)) {
            const src = typeof saved.text === 'string' ? saved.text : ''
            setTitle(typeof saved.title === 'string' ? saved.title : '')
            setText(src)
            setResultView(makeView(saved.graph, src))
            setPhase('done')
            setInputCollapsed(true)
            setHistory((prev) => {
              if (prev.length === 0) {
                const seed = [{ id: 'h-seed', title: typeof saved.title === 'string' ? saved.title : '', text: src, graph: saved.graph, ts: saved.ts || Date.now() }]
                saveHistory(seed)
                return seed
              }
              return prev
            })
          } else if (draft) {
            setTitle(typeof draft.title === 'string' ? draft.title : '')
            setText(typeof draft.text === 'string' ? draft.text : '')
          }
        }, [])

        useEffect(() => {
          try { localStorage.setItem(LS_DRAFT, JSON.stringify({ title, text })) } catch (e) {}
        }, [title, text])

        // ---- adaptive-backoff polling while a task runs ----
        useEffect(() => {
          if (!taskId) return
          let disposed = false
          let stop = null
          let delay = 3000
          const start = Date.now()
          const tick = async () => {
            if (disposed) return
            let res = null
            try {
              res = await host.call('task-status', { taskId })
            } catch (e) {
              if (disposed) return
              setPhase('idle')
              setTaskId(null)
              setError({ message: '查询任务状态失败：' + (e && e.message ? e.message : '未知错误') })
              return
            }
            if (disposed) return
            if (res && res.status === 'succeeded') {
              const g = res.result
              if (g && Array.isArray(g.nodes)) {
                const sub = submittedRef.current || { title: '', text }
                const rv = makeView(g, sub.text)
                setResultView(rv)
                setSelectedNodeId(null)
                setSelectedEdgeId(null)
                setActivePara(-1)
                setPhase('done')
                setTaskId(null)
                setInputCollapsed(true)
                try {
                  localStorage.removeItem(LS_PENDING)
                  localStorage.setItem(LS_RESULT, JSON.stringify({ title: sub.title, text: sub.text, graph: g, ts: Date.now() }))
                } catch (e) {}
                setHistory((prev) => appendHistory(prev, { id: 'h-' + Date.now(), title: sub.title, text: sub.text, graph: g, ts: Date.now() }))
              } else {
                setPhase('idle')
                setTaskId(null)
                setError({ message: 'AI 返回的结果缺少图数据，请重试' })
              }
              return
            }
            if (res && res.status === 'failed') {
              setPhase('idle')
              setTaskId(null)
              try { localStorage.removeItem(LS_PENDING) } catch (e) {}
              const err = res.error || {}
              setError({ code: err.code, message: err.message || 'AI 拆分失败，请稍后重试' })
              return
            }
            if (res && res.status === 'not_found') {
              setPhase('idle')
              setTaskId(null)
              try { localStorage.removeItem(LS_PENDING) } catch (e) {}
              setError({ message: '拆分任务已过期（服务可能已重启），请重新提交' })
              return
            }
            if (Date.now() - start > 45 * 60 * 1000) {
              setPhase('idle')
              setTaskId(null)
              setError({ message: '等待超时，任务仍在后台运行，可刷新页面后继续恢复轮询' })
              return
            }
            if (Date.now() - start > 60 * 1000) delay = Math.min(delay * 1.5, 15000)
            stop = ctx.timeout(tick, delay)
          }
          tick()
          return () => { disposed = true; if (stop) stop() }
        }, [taskId])

        const submit = async () => {
          const t = text.trim()
          if (!t) { setError({ message: '请先粘贴资料正文' }); return }
          if (t.length > MAX_LEN) { setError({ message: '资料正文不能超过 ' + MAX_LEN + ' 字' }); return }
          setError(null)
          const payload = { title, text: t }
          submittedRef.current = payload
          setPhase('extracting')
          setResultView(null)
          setSelectedNodeId(null)
          setSelectedEdgeId(null)
          setActivePara(-1)
          setHistoryOpen(false)
          try {
            const res = await host.call('extract', payload)
            if (res && res.error) {
              setPhase('idle')
              setError(res.error)
              return
            }
            setTaskId(res.taskId)
            try {
              localStorage.setItem(LS_PENDING, JSON.stringify({ taskId: res.taskId, title, text: t, ts: Date.now() }))
            } catch (e) {}
          } catch (e) {
            setPhase('idle')
            setError({ message: '无法提交拆分任务：' + (e && e.message ? e.message : '未知错误') })
          }
        }

        const resetAll = () => {
          try { localStorage.removeItem(LS_PENDING); localStorage.removeItem(LS_RESULT) } catch (e) {}
          setTitle(''); setText(''); setTaskId(null); setPhase('idle'); setResultView(null)
          setError(null); toastStore.clear(); setSelectedNodeId(null); setSelectedEdgeId(null)
          setFocusReq({ nodeId: null, seq: 0 }); setFlashPara(-1); setActivePara(-1); setShowDiag(false)
          setHistoryOpen(false)
          setInputCollapsed(false)
        }

        // ---- scrolling helper that works inside the fixed window ----
        const scrollElIntoCenter = (el) => {
          const containers = [el.closest('.kg-original'), el.closest('.kg-win-body')]
          let did = false
          for (const c of containers) {
            if (!c) continue
            if (c.scrollHeight <= c.clientHeight + 2) continue
            const cRect = c.getBoundingClientRect()
            const tRect = el.getBoundingClientRect()
            const delta = tRect.top - cRect.top - (cRect.height - tRect.height) / 2
            if (Math.abs(delta) > 4) {
              c.scrollBy({ top: delta, behavior: 'smooth' })
              did = true
            }
          }
          return did
        }

        const handleSelectNode = (nodeId) => {
          setSelectedNodeId(nodeId)
          setSelectedEdgeId(null)
          if (!nodeId) return
          const off = resultView.anchors[nodeId]
          if (off == null) {
            toastStore.show('该节点无法回链原文，已记入诊断列表')
            return
          }
          const pi = resultView.paragraphs.findIndex((p) => off >= p.start && off < p.end)
          if (pi < 0) {
            toastStore.show('未找到对应原文段落')
            return
          }
          const el = document.getElementById('kg-para-' + pi)
          if (!el) {
            toastStore.show('未找到对应原文段落')
            return
          }
          scrollElIntoCenter(el)
          setActivePara(pi)
          setFlashPara(pi)
          ctx.timeout(() => setFlashPara(-1), 1400)
          toastStore.show('已定位原文第 ' + (pi + 1) + ' 段')
        }
        const handleSelectEdge = (idx) => {
          setSelectedEdgeId(idx)
          setSelectedNodeId(null)
        }
        const handleParagraphClick = (pi) => {
          setActivePara(pi)
          const ids = resultView.paraNodes[pi] || []
          if (ids.length === 0) {
            toastStore.show('该段没有可定位的节点')
            return
          }
          const id = ids[0]
          setSelectedNodeId(id)
          setSelectedEdgeId(null)
          setFocusReq((f) => ({ nodeId: id, seq: f.seq + 1 }))
          toastStore.show('已在图中聚焦该段节点')
        }

        const loadHistoryEntry = (entry) => {
          setTitle(entry.title || '')
          setText(entry.text || '')
          setResultView(makeView(entry.graph, entry.text || ''))
          setPhase('done')
          setSelectedNodeId(null)
          setSelectedEdgeId(null)
          setActivePara(-1)
          setShowDiag(false)
          setError(null)
          toastStore.clear()
          setHistoryOpen(false)
          setInputCollapsed(true)
          try {
            localStorage.setItem(LS_RESULT, JSON.stringify({ title: entry.title, text: entry.text, graph: entry.graph, ts: Date.now() }))
          } catch (e) {}
        }
        const removeHistory = (id) => {
          setHistory((prev) => {
            const next = prev.filter((e) => e.id !== id)
            saveHistory(next)
            return next
          })
        }
        const clearHistory = () => {
          setHistory([])
          saveHistory([])
        }

        // ---- column width / row height drag handlers ----
        const startSplitDrag = (e) => {
          if (e.button !== 0 && e.pointerType === 'mouse') return
          const el = colsRef.current
          if (!el) return
          el.setPointerCapture(e.pointerId)
          splitDragRef.current = { id: e.pointerId, startX: e.clientX, startW: el.clientWidth, startRatio: splitRatio }
        }
        const onSplitMove = (e) => {
          const d = splitDragRef.current
          if (!d || d.id !== e.pointerId) return
          const el = colsRef.current
          if (!el) return
          const dx = e.clientX - d.startX
          setSplitRatio(clamp(d.startRatio + (dx / Math.max(d.startW, 1)) * 100, 24, 70))
        }
        const onSplitUp = (e) => {
          if (splitDragRef.current && splitDragRef.current.id === e.pointerId) {
            splitDragRef.current = null
            try { localStorage.setItem(LS_SPLIT, String(Math.round(splitRatio))) } catch (err) {}
          }
        }

        const startHDrag = (e) => {
          if (e.button !== 0 && e.pointerType === 'mouse') return
          const el = hHandleRef.current
          if (!el) return
          el.setPointerCapture(e.pointerId)
          hDragRef.current = { id: e.pointerId, startY: e.clientY, startH: resultHeight }
        }
        const onHMove = (e) => {
          const d = hDragRef.current
          if (!d || d.id !== e.pointerId) return
          setResultHeight(clamp(d.startH + (e.clientY - d.startY), 320, 900))
        }
        const onHUp = (e) => {
          if (hDragRef.current && hDragRef.current.id === e.pointerId) {
            hDragRef.current = null
            try { localStorage.setItem(LS_HEIGHT, String(Math.round(resultHeight))) } catch (err) {}
          }
        }

        // ---- view constructors ----
        const paraEl = (p, i) => {
          const badges = resultView.paraTypes[i] || []
          return h('div', {
            key: i, id: 'kg-para-' + i,
            className: 'kg-para' + (activePara === i ? ' kg-active' : '') + (flashPara === i ? ' kg-flash' : ''),
            role: 'button', tabIndex: 0,
            'aria-label': '原文第 ' + (i + 1) + ' 段' + (badges.length > 0 ? '，包含类型：' + badges.map((t) => TYPE_META[t].label).join('、') : '') + '，点击可在图中聚焦对应节点',
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

        const inputPanel = h('section', { className: 'kg-card', 'aria-label': '输入资料' },
          h('div', { className: 'kg-panel-head' },
            h('h3', { className: 'kg-section-title' }, '输入资料'),
            h('button', {
              type: 'button', className: 'kg-secondary kg-collapse-btn',
              'aria-expanded': !inputCollapsed,
              onClick: () => setInputCollapsed(!inputCollapsed),
            }, inputCollapsed ? '展开 ▾' : '收起 ▴'),
          ),
          inputCollapsed
            ? h('p', { className: 'kg-hint', style: { margin: 0 } },
                '输入区已收起' + (title ? '（标题：' + title + '）' : '') + ' · 正文 ' + text.length + ' 字')
            : h(React.Fragment, null,
                h('input', {
                  className: 'kg-input-title', placeholder: '资料标题（可选）', value: title, maxLength: 200,
                  onChange: (e) => setTitle(e.target.value), 'aria-label': '资料标题（可选）',
                }),
                h('textarea', {
                  className: 'kg-textarea', placeholder: '粘贴任意资料正文（章节、技术文档、学习笔记…）',
                  value: text, maxLength: MAX_LEN, onChange: (e) => setText(e.target.value), 'aria-label': '资料正文',
                }),
                h('div', { className: 'kg-actions' },
                  h('span', { className: 'kg-counter' }, '已输入 ' + text.length + ' / ' + MAX_LEN + ' 字'),
                  text.trim().length > 0
                    ? h('button', { type: 'button', className: 'kg-secondary', onClick: () => { setText(''); setTitle('') } }, '清空')
                    : null,
                  h('button', {
                    type: 'button', className: 'kg-primary',
                    disabled: text.trim().length === 0,
                    onClick: submit,
                  }, 'AI 拆分'),
                ),
              ),
        )

        const resultPanel = resultView
          ? (() => {
              const graph = resultView.graph
              const resolvedCount = graph.nodes.length - resultView.unresolved.length
              const diagCount = (graph.warnings ? graph.warnings.length : 0) + resultView.unresolved.length
              const diagLines = []
              for (const w of graph.warnings || []) diagLines.push('warning: ' + w)
              for (const u of resultView.unresolved) {
                diagLines.push('anchor_unresolved:node:' + u.id + (u.quote ? '（摘录：' + u.quote + '…）' : '（无摘录）'))
              }
              return h('section', { className: 'kg-card kg-result', 'aria-label': '原文 ⇄ 知识图结果' },
                h('h3', { className: 'kg-section-title' }, '原文 ⇄ 知识图'),
                h('p', { className: 'kg-summary' },
                  h('strong', null, '一句话总结：'), ' ', graph.summary || '（无）'),
                h('div', { className: 'kg-stats' },
                  h('span', null, graph.nodes.length + ' 个节点'),
                  h('span', null, graph.edges.length + ' 条关系'),
                  h('span', null, '可回链 ' + resolvedCount + '/' + graph.nodes.length + ' 节点'),
                  diagCount > 0
                    ? h('button', {
                        type: 'button', className: 'kg-diag-toggle',
                        'aria-expanded': showDiag,
                        onClick: () => setShowDiag(!showDiag),
                      }, '已记录 ' + diagCount + ' 条诊断（含无法回链原文的节点）' + (showDiag ? ' ▴' : ' ▾'))
                    : null,
                ),
                showDiag ? h('div', { className: 'kg-diag-list' }, diagLines.join(NL)) : null,
                h('p', { className: 'kg-hint' }, '点击原文段落 → 图中聚焦该段节点；点击图中节点 → 滚动到对应原文段落；拖拽平移画布，Ctrl+滚轮缩放，长按节点查看原文摘录。'),
                h('div', {
                  className: 'kg-cols',
                  ref: colsRef,
                  style: { '--kg-split': splitRatio + '%' },
                  onPointerMove: onSplitMove,
                  onPointerUp: onSplitUp,
                },
                  h('div', { className: 'kg-original', 'aria-label': '原文段落', style: { maxHeight: resultHeight + 'px' } },
                    resultView.paragraphs.map(paraEl)),
                  h('div', {
                    className: 'kg-split-handle', role: 'separator', 'aria-orientation': 'vertical',
                    'aria-label': '拖动调整原文与知识图宽度比例', title: '拖动调整宽度比例',
                    onPointerDown: startSplitDrag,
                  },
                    h('div', { className: 'kg-split-bar' })),
                  h('div', { className: 'kg-graph-col' },
                    h(GraphViewer, {
                      nodes: graph.nodes, edges: graph.edges, anchors: resultView.anchors,
                      selectedNodeId, selectedEdgeId, focusReq,
                      onSelectNode: handleSelectNode, onSelectEdge: handleSelectEdge, ctx,
                      height: resultHeight,
                    }),
                    h('div', { className: 'kg-legend' },
                      TYPE_ORDER.map((t) => h('span', { key: t, className: 'kg-legend-item' },
                        h('span', { className: 'kg-legend-dot', style: { background: TYPE_META[t].color } }),
                        TYPE_META[t].label))),
                  ),
                ),
                h('div', {
                  className: 'kg-h-handle', role: 'separator', 'aria-orientation': 'horizontal',
                  'aria-label': '拖动调整结果区高度', title: '拖动调整高度',
                  ref: hHandleRef,
                  onPointerDown: startHDrag,
                  onPointerMove: onHMove,
                  onPointerUp: onHUp,
                },
                  h('div', { className: 'kg-h-bar' })),
              )
            })()
          : null

        const historyPanel = h('section', { className: 'kg-card', 'aria-label': '历史记录' },
          h('div', { className: 'kg-history-head' },
            h('h3', { className: 'kg-section-title' }, '历史记录（' + history.length + ' 条）'),
            h('div', { style: { display: 'flex', gap: 8 } },
              history.length > 0
                ? h('button', { type: 'button', className: 'kg-secondary', onClick: clearHistory }, '清空历史')
                : null,
              h('button', { type: 'button', className: 'kg-secondary', onClick: () => setHistoryOpen(false) }, '返回工作台'),
            ),
          ),
          history.length === 0
            ? h('p', { className: 'kg-hint' }, '还没有历史记录。完成一次「AI 拆分」后会自动保存（最多 ' + HISTORY_MAX + ' 条）。')
            : h('div', { className: 'kg-history-list' },
                history.map((entry) => h('div', {
                  key: entry.id, className: 'kg-history-item', role: 'button', tabIndex: 0,
                  onClick: () => loadHistoryEntry(entry),
                  onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadHistoryEntry(entry) } },
                },
                  h('div', { className: 'kg-history-item-title' },
                    h('span', null, entry.title || '（无标题）'),
                    h('button', {
                      type: 'button', className: 'kg-history-del', 'aria-label': '删除该条记录',
                      onClick: (e) => { e.stopPropagation(); removeHistory(entry.id) },
                    }, '×'),
                  ),
                  h('div', { className: 'kg-history-item-meta' },
                    formatTime(entry.ts) + ' · ' + entry.graph.nodes.length + ' 节点 · ' + entry.graph.edges.length + ' 条关系'),
                  h('div', { className: 'kg-history-item-summary' },
                    (entry.graph.summary || '').slice(0, 60) + ((entry.graph.summary || '').length > 60 ? '…' : '')),
                )),
              ),
        )

        return h(React.Fragment, null,
          h('div', { className: 'kg-body-toolbar' },
            h('div', { className: 'kg-body-toolbar-text' },
              h('div', { className: 'kg-kicker' }, '知识库'),
              h('p', { className: 'kg-subtitle' },
                '把任意资料用 AI 拆成「事实 / 推论 / 概念 / 定义 / 例子 / 反例 / 规则」组成的知识图，并在图与原文之间双向定位。'),
            ),
            h('div', { style: { display: 'flex', gap: 8, flex: 'none' } },
              h('button', { type: 'button', className: 'kg-secondary', onClick: () => setHistoryOpen(!historyOpen) },
                historyOpen ? '返回工作台' : '历史'),
              resultView ? h('button', { type: 'button', className: 'kg-secondary', onClick: resetAll }, '重新开始') : null,
            ),
          ),
          error
            ? h('div', { className: 'kg-banner', role: 'alert' },
                h('span', null, error.message || '出错了，请重试'),
                h('button', { type: 'button', 'aria-label': '关闭提示', onClick: () => setError(null) }, '×'),
              )
            : null,
          phase === 'extracting'
            ? h('div', { className: 'kg-empty' },
                h('div', { className: 'kg-spinner', 'aria-hidden': 'true' }),
                h('p', null, '正在用 AI 拆分资料（约 15-40 秒）...'),
                h('p', { className: 'kg-empty-sub' }, '可以关闭窗口或离开页面；任务会自动保存，重新打开窗口后自动恢复轮询。'),
              )
            : historyOpen
              ? historyPanel
              : h(React.Fragment, null,
                  inputPanel,
                  resultPanel,
                ),
        )
      }

      function loadWinRect() {
        let r = null
        try { r = JSON.parse(localStorage.getItem(LS_WIN) || 'null') } catch (e) {}
        const vw = window.innerWidth
        const vh = window.innerHeight
        const w = clamp(r && typeof r.w === 'number' ? r.w : Math.min(940, vw - 40), 480, vw - 12)
        const hh = clamp(r && typeof r.h === 'number' ? r.h : Math.min(700, vh - 60), 360, vh - 12)
        let x = r && typeof r.x === 'number' ? r.x : Math.max(12, Math.round((vw - w) / 2))
        let y = r && typeof r.y === 'number' ? r.y : Math.max(12, Math.round((vh - hh) / 2))
        x = clamp(x, -w + 140, vw - 80)
        y = clamp(y, 0, vh - 44)
        return { x, y, w, h: hh }
      }

      // --------------------------- slot registration ---------------------------
      slots.inject('tool.view.cordis', () => slots.register(
        { name: 'tool.view.cordis', key: 'self' },
        () => h(LauncherCard, null),
      ))

      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'kg-workbench-window', order: 90 },
        () => h(FloatingWindow, { ctx }),
      ))

      slots.inject('conversation.session.header.actions', () => slots.register(
        { name: 'conversation.session.header.actions', id: 'kg-workbench-launcher', label: '知识图' },
        () => h(HeaderLauncher, null),
      ))
    },
  }
}
