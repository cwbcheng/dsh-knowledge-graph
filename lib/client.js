/**
 * dsh-knowledge-graph — persistent client half (browser __ModuleLoader__ module).
 *
 * Mirrors src/index.client.js (dynamic-package format) for the persistent
 * install: same UI, but CSS is injected manually and RPC goes over fetch() to
 * the host webServer route instead of the package-private host.call. Keep UI
 * logic in sync with src/index.client.js.
 */
window.__ModuleLoader__.load({
  id: "dsh-knowledge-graph",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");

    // ---------- CSS injection (no `styles` closure in composition mode) ----------
    const CSS_TAG_ID = "dsh-knowledge-graph"
    function insertStyles(cssText) {
      if (typeof document === "undefined") return
      const selector = "style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]"
      if (document.querySelector(selector) !== null) return
      const el = document.createElement("style")
      el.setAttribute("data-plugin-css", JSON.stringify(CSS_TAG_ID))
      el.textContent = cssText
      document.head.appendChild(el)
    }

    // ---------- RPC to the host half (webServer route, replaces host.call) ----------
    async function rpc(method, body) {
      if (method === "extract") {
        const res = await fetch("/api/dsh-knowledge-graph/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        return res.json()
      }
      const res = await fetch("/api/dsh-knowledge-graph/task-status?taskId=" + encodeURIComponent(body.taskId), { cache: "no-store" })
      return res.json()
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // ----------------------------- styles -----------------------------
      insertStyles(`
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
.kg-layout-select { height: 28px; border: 1px solid var(--kg-border); border-radius: 7px; background: var(--kg-panel); color: var(--kg-text); font-size: 12px; cursor: pointer; padding: 0 6px; }
.kg-layout-select:hover { border-color: rgba(59,130,246,0.6); color: #3b82f6; }
.kg-layout-select option { background: var(--kg-win-bg); color: var(--kg-text); }
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
      const LS_LAYOUT = 'dsh-kg-layout-v1'
      const LAYER_Y_GAP = 210
      const LAYER_X_GAP = 220
      const LAYOUT_MODES = [
        { id: 'force', label: '力导向' },
        { id: 'circular', label: '圆形' },
        { id: 'radial', label: '放射' },
        { id: 'layered', label: '分层' },
      ]

      // ---- vendored d3-force 3.0.0 (ISC license, https://d3js.org/d3-force) ----
      // d3-force's only deps are d3-quadtree / d3-dispatch / d3-timer; all four
      // are embedded as strings and loaded through a tiny CommonJS shim, so no
      // module system or bundler is required (works in both dynamic and
      // composition client formats).
      const D3_TIMER_SRC = "// https://d3js.org/d3-timer/ v3.0.1 Copyright 2010-2021 Mike Bostock\n!function(t,n){\"object\"==typeof exports&&\"undefined\"!=typeof module?n(exports):\"function\"==typeof define&&define.amd?define([\"exports\"],n):n((t=\"undefined\"!=typeof globalThis?globalThis:t||self).d3=t.d3||{})}(this,(function(t){\"use strict\";var n,e,o=0,i=0,r=0,l=0,u=0,a=0,s=\"object\"==typeof performance&&performance.now?performance:Date,c=\"object\"==typeof window&&window.requestAnimationFrame?window.requestAnimationFrame.bind(window):function(t){setTimeout(t,17)};function f(){return u||(c(_),u=s.now()+a)}function _(){u=0}function m(){this._call=this._time=this._next=null}function p(t,n,e){var o=new m;return o.restart(t,n,e),o}function w(){f(),++o;for(var t,e=n;e;)(t=u-e._time)>=0&&e._call.call(void 0,t),e=e._next;--o}function d(){u=(l=s.now())+a,o=i=0;try{w()}finally{o=0,function(){var t,o,i=n,r=1/0;for(;i;)i._call?(r>i._time&&(r=i._time),t=i,i=i._next):(o=i._next,i._next=null,i=t?t._next=o:n=o);e=t,y(r)}(),u=0}}function h(){var t=s.now(),n=t-l;n>1e3&&(a-=n,l=t)}function y(t){o||(i&&(i=clearTimeout(i)),t-u>24?(t<1/0&&(i=setTimeout(d,t-s.now()-a)),r&&(r=clearInterval(r))):(r||(l=s.now(),r=setInterval(h,1e3)),o=1,c(d)))}m.prototype=p.prototype={constructor:m,restart:function(t,o,i){if(\"function\"!=typeof t)throw new TypeError(\"callback is not a function\");i=(null==i?f():+i)+(null==o?0:+o),this._next||e===this||(e?e._next=this:n=this,e=this),this._call=t,this._time=i,y()},stop:function(){this._call&&(this._call=null,this._time=1/0,y())}},t.interval=function(t,n,e){var o=new m,i=n;return null==n?(o.restart(t,n,e),o):(o._restart=o.restart,o.restart=function(t,n,e){n=+n,e=null==e?f():+e,o._restart((function r(l){l+=i,o._restart(r,i+=n,e),t(l)}),n,e)},o.restart(t,n,e),o)},t.now=f,t.timeout=function(t,n,e){var o=new m;return n=null==n?0:+n,o.restart((e=>{o.stop(),t(e+n)}),n,e),o},t.timer=p,t.timerFlush=w,Object.defineProperty(t,\"__esModule\",{value:!0})}));\n"
      const D3_DISPATCH_SRC = "// https://d3js.org/d3-dispatch/ v3.0.1 Copyright 2010-2021 Mike Bostock\n!function(n,e){\"object\"==typeof exports&&\"undefined\"!=typeof module?e(exports):\"function\"==typeof define&&define.amd?define([\"exports\"],e):e((n=\"undefined\"!=typeof globalThis?globalThis:n||self).d3=n.d3||{})}(this,(function(n){\"use strict\";var e={value:()=>{}};function t(){for(var n,e=0,t=arguments.length,o={};e<t;++e){if(!(n=arguments[e]+\"\")||n in o||/[\\s.]/.test(n))throw new Error(\"illegal type: \"+n);o[n]=[]}return new r(o)}function r(n){this._=n}function o(n,e){return n.trim().split(/^|\\s+/).map((function(n){var t=\"\",r=n.indexOf(\".\");if(r>=0&&(t=n.slice(r+1),n=n.slice(0,r)),n&&!e.hasOwnProperty(n))throw new Error(\"unknown type: \"+n);return{type:n,name:t}}))}function i(n,e){for(var t,r=0,o=n.length;r<o;++r)if((t=n[r]).name===e)return t.value}function f(n,t,r){for(var o=0,i=n.length;o<i;++o)if(n[o].name===t){n[o]=e,n=n.slice(0,o).concat(n.slice(o+1));break}return null!=r&&n.push({name:t,value:r}),n}r.prototype=t.prototype={constructor:r,on:function(n,e){var t,r=this._,l=o(n+\"\",r),a=-1,u=l.length;if(!(arguments.length<2)){if(null!=e&&\"function\"!=typeof e)throw new Error(\"invalid callback: \"+e);for(;++a<u;)if(t=(n=l[a]).type)r[t]=f(r[t],n.name,e);else if(null==e)for(t in r)r[t]=f(r[t],n.name,null);return this}for(;++a<u;)if((t=(n=l[a]).type)&&(t=i(r[t],n.name)))return t},copy:function(){var n={},e=this._;for(var t in e)n[t]=e[t].slice();return new r(n)},call:function(n,e){if((t=arguments.length-2)>0)for(var t,r,o=new Array(t),i=0;i<t;++i)o[i]=arguments[i+2];if(!this._.hasOwnProperty(n))throw new Error(\"unknown type: \"+n);for(i=0,t=(r=this._[n]).length;i<t;++i)r[i].value.apply(e,o)},apply:function(n,e,t){if(!this._.hasOwnProperty(n))throw new Error(\"unknown type: \"+n);for(var r=this._[n],o=0,i=r.length;o<i;++o)r[o].value.apply(e,t)}},n.dispatch=t,Object.defineProperty(n,\"__esModule\",{value:!0})}));\n"
      const D3_QUADTREE_SRC = "// https://d3js.org/d3-quadtree/ v3.0.1 Copyright 2010-2021 Mike Bostock\n!function(t,i){\"object\"==typeof exports&&\"undefined\"!=typeof module?i(exports):\"function\"==typeof define&&define.amd?define([\"exports\"],i):i((t=\"undefined\"!=typeof globalThis?globalThis:t||self).d3=t.d3||{})}(this,(function(t){\"use strict\";function i(t,i,e,n){if(isNaN(i)||isNaN(e))return t;var r,s,h,o,a,u,l,_,f,c=t._root,x={data:n},y=t._x0,d=t._y0,p=t._x1,v=t._y1;if(!c)return t._root=x,t;for(;c.length;)if((u=i>=(s=(y+p)/2))?y=s:p=s,(l=e>=(h=(d+v)/2))?d=h:v=h,r=c,!(c=c[_=l<<1|u]))return r[_]=x,t;if(o=+t._x.call(null,c.data),a=+t._y.call(null,c.data),i===o&&e===a)return x.next=c,r?r[_]=x:t._root=x,t;do{r=r?r[_]=new Array(4):t._root=new Array(4),(u=i>=(s=(y+p)/2))?y=s:p=s,(l=e>=(h=(d+v)/2))?d=h:v=h}while((_=l<<1|u)==(f=(a>=h)<<1|o>=s));return r[f]=c,r[_]=x,t}function e(t,i,e,n,r){this.node=t,this.x0=i,this.y0=e,this.x1=n,this.y1=r}function n(t){return t[0]}function r(t){return t[1]}function s(t,i,e){var s=new h(null==i?n:i,null==e?r:e,NaN,NaN,NaN,NaN);return null==t?s:s.addAll(t)}function h(t,i,e,n,r,s){this._x=t,this._y=i,this._x0=e,this._y0=n,this._x1=r,this._y1=s,this._root=void 0}function o(t){for(var i={data:t.data},e=i;t=t.next;)e=e.next={data:t.data};return i}var a=s.prototype=h.prototype;a.copy=function(){var t,i,e=new h(this._x,this._y,this._x0,this._y0,this._x1,this._y1),n=this._root;if(!n)return e;if(!n.length)return e._root=o(n),e;for(t=[{source:n,target:e._root=new Array(4)}];n=t.pop();)for(var r=0;r<4;++r)(i=n.source[r])&&(i.length?t.push({source:i,target:n.target[r]=new Array(4)}):n.target[r]=o(i));return e},a.add=function(t){const e=+this._x.call(null,t),n=+this._y.call(null,t);return i(this.cover(e,n),e,n,t)},a.addAll=function(t){var e,n,r,s,h=t.length,o=new Array(h),a=new Array(h),u=1/0,l=1/0,_=-1/0,f=-1/0;for(n=0;n<h;++n)isNaN(r=+this._x.call(null,e=t[n]))||isNaN(s=+this._y.call(null,e))||(o[n]=r,a[n]=s,r<u&&(u=r),r>_&&(_=r),s<l&&(l=s),s>f&&(f=s));if(u>_||l>f)return this;for(this.cover(u,l).cover(_,f),n=0;n<h;++n)i(this,o[n],a[n],t[n]);return this},a.cover=function(t,i){if(isNaN(t=+t)||isNaN(i=+i))return this;var e=this._x0,n=this._y0,r=this._x1,s=this._y1;if(isNaN(e))r=(e=Math.floor(t))+1,s=(n=Math.floor(i))+1;else{for(var h,o,a=r-e||1,u=this._root;e>t||t>=r||n>i||i>=s;)switch(o=(i<n)<<1|t<e,(h=new Array(4))[o]=u,u=h,a*=2,o){case 0:r=e+a,s=n+a;break;case 1:e=r-a,s=n+a;break;case 2:r=e+a,n=s-a;break;case 3:e=r-a,n=s-a}this._root&&this._root.length&&(this._root=u)}return this._x0=e,this._y0=n,this._x1=r,this._y1=s,this},a.data=function(){var t=[];return this.visit((function(i){if(!i.length)do{t.push(i.data)}while(i=i.next)})),t},a.extent=function(t){return arguments.length?this.cover(+t[0][0],+t[0][1]).cover(+t[1][0],+t[1][1]):isNaN(this._x0)?void 0:[[this._x0,this._y0],[this._x1,this._y1]]},a.find=function(t,i,n){var r,s,h,o,a,u,l,_=this._x0,f=this._y0,c=this._x1,x=this._y1,y=[],d=this._root;for(d&&y.push(new e(d,_,f,c,x)),null==n?n=1/0:(_=t-n,f=i-n,c=t+n,x=i+n,n*=n);u=y.pop();)if(!(!(d=u.node)||(s=u.x0)>c||(h=u.y0)>x||(o=u.x1)<_||(a=u.y1)<f))if(d.length){var p=(s+o)/2,v=(h+a)/2;y.push(new e(d[3],p,v,o,a),new e(d[2],s,v,p,a),new e(d[1],p,h,o,v),new e(d[0],s,h,p,v)),(l=(i>=v)<<1|t>=p)&&(u=y[y.length-1],y[y.length-1]=y[y.length-1-l],y[y.length-1-l]=u)}else{var w=t-+this._x.call(null,d.data),N=i-+this._y.call(null,d.data),g=w*w+N*N;if(g<n){var A=Math.sqrt(n=g);_=t-A,f=i-A,c=t+A,x=i+A,r=d.data}}return r},a.remove=function(t){if(isNaN(s=+this._x.call(null,t))||isNaN(h=+this._y.call(null,t)))return this;var i,e,n,r,s,h,o,a,u,l,_,f,c=this._root,x=this._x0,y=this._y0,d=this._x1,p=this._y1;if(!c)return this;if(c.length)for(;;){if((u=s>=(o=(x+d)/2))?x=o:d=o,(l=h>=(a=(y+p)/2))?y=a:p=a,i=c,!(c=c[_=l<<1|u]))return this;if(!c.length)break;(i[_+1&3]||i[_+2&3]||i[_+3&3])&&(e=i,f=_)}for(;c.data!==t;)if(n=c,!(c=c.next))return this;return(r=c.next)&&delete c.next,n?(r?n.next=r:delete n.next,this):i?(r?i[_]=r:delete i[_],(c=i[0]||i[1]||i[2]||i[3])&&c===(i[3]||i[2]||i[1]||i[0])&&!c.length&&(e?e[f]=c:this._root=c),this):(this._root=r,this)},a.removeAll=function(t){for(var i=0,e=t.length;i<e;++i)this.remove(t[i]);return this},a.root=function(){return this._root},a.size=function(){var t=0;return this.visit((function(i){if(!i.length)do{++t}while(i=i.next)})),t},a.visit=function(t){var i,n,r,s,h,o,a=[],u=this._root;for(u&&a.push(new e(u,this._x0,this._y0,this._x1,this._y1));i=a.pop();)if(!t(u=i.node,r=i.x0,s=i.y0,h=i.x1,o=i.y1)&&u.length){var l=(r+h)/2,_=(s+o)/2;(n=u[3])&&a.push(new e(n,l,_,h,o)),(n=u[2])&&a.push(new e(n,r,_,l,o)),(n=u[1])&&a.push(new e(n,l,s,h,_)),(n=u[0])&&a.push(new e(n,r,s,l,_))}return this},a.visitAfter=function(t){var i,n=[],r=[];for(this._root&&n.push(new e(this._root,this._x0,this._y0,this._x1,this._y1));i=n.pop();){var s=i.node;if(s.length){var h,o=i.x0,a=i.y0,u=i.x1,l=i.y1,_=(o+u)/2,f=(a+l)/2;(h=s[0])&&n.push(new e(h,o,a,_,f)),(h=s[1])&&n.push(new e(h,_,a,u,f)),(h=s[2])&&n.push(new e(h,o,f,_,l)),(h=s[3])&&n.push(new e(h,_,f,u,l))}r.push(i)}for(;i=r.pop();)t(i.node,i.x0,i.y0,i.x1,i.y1);return this},a.x=function(t){return arguments.length?(this._x=t,this):this._x},a.y=function(t){return arguments.length?(this._y=t,this):this._y},t.quadtree=s,Object.defineProperty(t,\"__esModule\",{value:!0})}));\n"
      const D3_FORCE_SRC = "// https://d3js.org/d3-force/ v3.0.0 Copyright 2010-2021 Mike Bostock\n!function(n,t){\"object\"==typeof exports&&\"undefined\"!=typeof module?t(exports,require(\"d3-quadtree\"),require(\"d3-dispatch\"),require(\"d3-timer\")):\"function\"==typeof define&&define.amd?define([\"exports\",\"d3-quadtree\",\"d3-dispatch\",\"d3-timer\"],t):t((n=\"undefined\"!=typeof globalThis?globalThis:n||self).d3=n.d3||{},n.d3,n.d3,n.d3)}(this,(function(n,t,e,r){\"use strict\";function i(n){return function(){return n}}function u(n){return 1e-6*(n()-.5)}function o(n){return n.x+n.vx}function f(n){return n.y+n.vy}function a(n){return n.index}function c(n,t){var e=n.get(t);if(!e)throw new Error(\"node not found: \"+t);return e}const l=4294967296;function h(n){return n.x}function v(n){return n.y}var y=Math.PI*(3-Math.sqrt(5));n.forceCenter=function(n,t){var e,r=1;function i(){var i,u,o=e.length,f=0,a=0;for(i=0;i<o;++i)f+=(u=e[i]).x,a+=u.y;for(f=(f/o-n)*r,a=(a/o-t)*r,i=0;i<o;++i)(u=e[i]).x-=f,u.y-=a}return null==n&&(n=0),null==t&&(t=0),i.initialize=function(n){e=n},i.x=function(t){return arguments.length?(n=+t,i):n},i.y=function(n){return arguments.length?(t=+n,i):t},i.strength=function(n){return arguments.length?(r=+n,i):r},i},n.forceCollide=function(n){var e,r,a,c=1,l=1;function h(){for(var n,i,h,y,d,g,x,s=e.length,p=0;p<l;++p)for(i=t.quadtree(e,o,f).visitAfter(v),n=0;n<s;++n)h=e[n],g=r[h.index],x=g*g,y=h.x+h.vx,d=h.y+h.vy,i.visit(M);function M(n,t,e,r,i){var o=n.data,f=n.r,l=g+f;if(!o)return t>y+l||r<y-l||e>d+l||i<d-l;if(o.index>h.index){var v=y-o.x-o.vx,s=d-o.y-o.vy,p=v*v+s*s;p<l*l&&(0===v&&(p+=(v=u(a))*v),0===s&&(p+=(s=u(a))*s),p=(l-(p=Math.sqrt(p)))/p*c,h.vx+=(v*=p)*(l=(f*=f)/(x+f)),h.vy+=(s*=p)*l,o.vx-=v*(l=1-l),o.vy-=s*l)}}}function v(n){if(n.data)return n.r=r[n.data.index];for(var t=n.r=0;t<4;++t)n[t]&&n[t].r>n.r&&(n.r=n[t].r)}function y(){if(e){var t,i,u=e.length;for(r=new Array(u),t=0;t<u;++t)i=e[t],r[i.index]=+n(i,t,e)}}return\"function\"!=typeof n&&(n=i(null==n?1:+n)),h.initialize=function(n,t){e=n,a=t,y()},h.iterations=function(n){return arguments.length?(l=+n,h):l},h.strength=function(n){return arguments.length?(c=+n,h):c},h.radius=function(t){return arguments.length?(n=\"function\"==typeof t?t:i(+t),y(),h):n},h},n.forceLink=function(n){var t,e,r,o,f,l,h=a,v=function(n){return 1/Math.min(o[n.source.index],o[n.target.index])},y=i(30),d=1;function g(r){for(var i=0,o=n.length;i<d;++i)for(var a,c,h,v,y,g,x,s=0;s<o;++s)c=(a=n[s]).source,v=(h=a.target).x+h.vx-c.x-c.vx||u(l),y=h.y+h.vy-c.y-c.vy||u(l),v*=g=((g=Math.sqrt(v*v+y*y))-e[s])/g*r*t[s],y*=g,h.vx-=v*(x=f[s]),h.vy-=y*x,c.vx+=v*(x=1-x),c.vy+=y*x}function x(){if(r){var i,u,a=r.length,l=n.length,v=new Map(r.map(((n,t)=>[h(n,t,r),n])));for(i=0,o=new Array(a);i<l;++i)(u=n[i]).index=i,\"object\"!=typeof u.source&&(u.source=c(v,u.source)),\"object\"!=typeof u.target&&(u.target=c(v,u.target)),o[u.source.index]=(o[u.source.index]||0)+1,o[u.target.index]=(o[u.target.index]||0)+1;for(i=0,f=new Array(l);i<l;++i)u=n[i],f[i]=o[u.source.index]/(o[u.source.index]+o[u.target.index]);t=new Array(l),s(),e=new Array(l),p()}}function s(){if(r)for(var e=0,i=n.length;e<i;++e)t[e]=+v(n[e],e,n)}function p(){if(r)for(var t=0,i=n.length;t<i;++t)e[t]=+y(n[t],t,n)}return null==n&&(n=[]),g.initialize=function(n,t){r=n,l=t,x()},g.links=function(t){return arguments.length?(n=t,x(),g):n},g.id=function(n){return arguments.length?(h=n,g):h},g.iterations=function(n){return arguments.length?(d=+n,g):d},g.strength=function(n){return arguments.length?(v=\"function\"==typeof n?n:i(+n),s(),g):v},g.distance=function(n){return arguments.length?(y=\"function\"==typeof n?n:i(+n),p(),g):y},g},n.forceManyBody=function(){var n,e,r,o,f,a=i(-30),c=1,l=1/0,y=.81;function d(r){var i,u=n.length,f=t.quadtree(n,h,v).visitAfter(x);for(o=r,i=0;i<u;++i)e=n[i],f.visit(s)}function g(){if(n){var t,e,r=n.length;for(f=new Array(r),t=0;t<r;++t)e=n[t],f[e.index]=+a(e,t,n)}}function x(n){var t,e,r,i,u,o=0,a=0;if(n.length){for(r=i=u=0;u<4;++u)(t=n[u])&&(e=Math.abs(t.value))&&(o+=t.value,a+=e,r+=e*t.x,i+=e*t.y);n.x=r/a,n.y=i/a}else{(t=n).x=t.data.x,t.y=t.data.y;do{o+=f[t.data.index]}while(t=t.next)}n.value=o}function s(n,t,i,a){if(!n.value)return!0;var h=n.x-e.x,v=n.y-e.y,d=a-t,g=h*h+v*v;if(d*d/y<g)return g<l&&(0===h&&(g+=(h=u(r))*h),0===v&&(g+=(v=u(r))*v),g<c&&(g=Math.sqrt(c*g)),e.vx+=h*n.value*o/g,e.vy+=v*n.value*o/g),!0;if(!(n.length||g>=l)){(n.data!==e||n.next)&&(0===h&&(g+=(h=u(r))*h),0===v&&(g+=(v=u(r))*v),g<c&&(g=Math.sqrt(c*g)));do{n.data!==e&&(d=f[n.data.index]*o/g,e.vx+=h*d,e.vy+=v*d)}while(n=n.next)}}return d.initialize=function(t,e){n=t,r=e,g()},d.strength=function(n){return arguments.length?(a=\"function\"==typeof n?n:i(+n),g(),d):a},d.distanceMin=function(n){return arguments.length?(c=n*n,d):Math.sqrt(c)},d.distanceMax=function(n){return arguments.length?(l=n*n,d):Math.sqrt(l)},d.theta=function(n){return arguments.length?(y=n*n,d):Math.sqrt(y)},d},n.forceRadial=function(n,t,e){var r,u,o,f=i(.1);function a(n){for(var i=0,f=r.length;i<f;++i){var a=r[i],c=a.x-t||1e-6,l=a.y-e||1e-6,h=Math.sqrt(c*c+l*l),v=(o[i]-h)*u[i]*n/h;a.vx+=c*v,a.vy+=l*v}}function c(){if(r){var t,e=r.length;for(u=new Array(e),o=new Array(e),t=0;t<e;++t)o[t]=+n(r[t],t,r),u[t]=isNaN(o[t])?0:+f(r[t],t,r)}}return\"function\"!=typeof n&&(n=i(+n)),null==t&&(t=0),null==e&&(e=0),a.initialize=function(n){r=n,c()},a.strength=function(n){return arguments.length?(f=\"function\"==typeof n?n:i(+n),c(),a):f},a.radius=function(t){return arguments.length?(n=\"function\"==typeof t?t:i(+t),c(),a):n},a.x=function(n){return arguments.length?(t=+n,a):t},a.y=function(n){return arguments.length?(e=+n,a):e},a},n.forceSimulation=function(n){var t,i=1,u=.001,o=1-Math.pow(u,1/300),f=0,a=.6,c=new Map,h=r.timer(g),v=e.dispatch(\"tick\",\"end\"),d=function(){let n=1;return()=>(n=(1664525*n+1013904223)%l)/l}();function g(){x(),v.call(\"tick\",t),i<u&&(h.stop(),v.call(\"end\",t))}function x(e){var r,u,l=n.length;void 0===e&&(e=1);for(var h=0;h<e;++h)for(i+=(f-i)*o,c.forEach((function(n){n(i)})),r=0;r<l;++r)null==(u=n[r]).fx?u.x+=u.vx*=a:(u.x=u.fx,u.vx=0),null==u.fy?u.y+=u.vy*=a:(u.y=u.fy,u.vy=0);return t}function s(){for(var t,e=0,r=n.length;e<r;++e){if((t=n[e]).index=e,null!=t.fx&&(t.x=t.fx),null!=t.fy&&(t.y=t.fy),isNaN(t.x)||isNaN(t.y)){var i=10*Math.sqrt(.5+e),u=e*y;t.x=i*Math.cos(u),t.y=i*Math.sin(u)}(isNaN(t.vx)||isNaN(t.vy))&&(t.vx=t.vy=0)}}function p(t){return t.initialize&&t.initialize(n,d),t}return null==n&&(n=[]),s(),t={tick:x,restart:function(){return h.restart(g),t},stop:function(){return h.stop(),t},nodes:function(e){return arguments.length?(n=e,s(),c.forEach(p),t):n},alpha:function(n){return arguments.length?(i=+n,t):i},alphaMin:function(n){return arguments.length?(u=+n,t):u},alphaDecay:function(n){return arguments.length?(o=+n,t):+o},alphaTarget:function(n){return arguments.length?(f=+n,t):f},velocityDecay:function(n){return arguments.length?(a=1-n,t):1-a},randomSource:function(n){return arguments.length?(d=n,c.forEach(p),t):d},force:function(n,e){return arguments.length>1?(null==e?c.delete(n):c.set(n,p(e)),t):c.get(n)},find:function(t,e,r){var i,u,o,f,a,c=0,l=n.length;for(null==r?r=1/0:r*=r,c=0;c<l;++c)(o=(i=t-(f=n[c]).x)*i+(u=e-f.y)*u)<r&&(a=f,r=o);return a},on:function(n,e){return arguments.length>1?(v.on(n,e),t):v.on(n)}}},n.forceX=function(n){var t,e,r,u=i(.1);function o(n){for(var i,u=0,o=t.length;u<o;++u)(i=t[u]).vx+=(r[u]-i.x)*e[u]*n}function f(){if(t){var i,o=t.length;for(e=new Array(o),r=new Array(o),i=0;i<o;++i)e[i]=isNaN(r[i]=+n(t[i],i,t))?0:+u(t[i],i,t)}}return\"function\"!=typeof n&&(n=i(null==n?0:+n)),o.initialize=function(n){t=n,f()},o.strength=function(n){return arguments.length?(u=\"function\"==typeof n?n:i(+n),f(),o):u},o.x=function(t){return arguments.length?(n=\"function\"==typeof t?t:i(+t),f(),o):n},o},n.forceY=function(n){var t,e,r,u=i(.1);function o(n){for(var i,u=0,o=t.length;u<o;++u)(i=t[u]).vy+=(r[u]-i.y)*e[u]*n}function f(){if(t){var i,o=t.length;for(e=new Array(o),r=new Array(o),i=0;i<o;++i)e[i]=isNaN(r[i]=+n(t[i],i,t))?0:+u(t[i],i,t)}}return\"function\"!=typeof n&&(n=i(null==n?0:+n)),o.initialize=function(n){t=n,f()},o.strength=function(n){return arguments.length?(u=\"function\"==typeof n?n:i(+n),f(),o):u},o.y=function(t){return arguments.length?(n=\"function\"==typeof t?t:i(+t),f(),o):n},o},Object.defineProperty(n,\"__esModule\",{value:!0})}));\n"
      const d3force = (function () {
        const modules = Object.create(null)
        const load = (name, src) => {
          const m = { exports: {} }
          const req = (id) => modules[id]
          new Function('module', 'exports', 'require', src)(m, m.exports, req)
          modules[name] = m.exports
          return m.exports
        }
        load('d3-timer', D3_TIMER_SRC)
        load('d3-dispatch', D3_DISPATCH_SRC)
        load('d3-quadtree', D3_QUADTREE_SRC)
        return load('d3-force', D3_FORCE_SRC)
      })()


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
        // Sanitize edges: drop references to unknown nodes and self-loops.
        // d3-force throws "node not found" on a dangling edge — history data
        // from older sessions can contain them, which crashed the whole page.
        if (graph && Array.isArray(graph.nodes) && Array.isArray(graph.edges)) {
          const ids = new Set(graph.nodes.map((n) => n.id))
          const clean = graph.edges.filter((e) => e && e.fromNodeId !== e.toNodeId && ids.has(e.fromNodeId) && ids.has(e.toNodeId))
          if (clean.length !== graph.edges.length) graph = { ...graph, edges: clean }
        }
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
      // Edge-node repulsion over explicit path segments: every node not
      // touching an edge is pushed along each segment's normal until it clears
      // by a margin. `bendAware` adds fan-rank clearance for curved modes.
      function applyEdgeNodeRepulsion(nodes, edges, sizes, pos, segmentsOf, bendAware) {
        const n = nodes.length
        if (n < 2) return
        const ids = nodes.map((x) => x.id)
        const bendRank = new Map()
        if (bendAware) {
          const bySrc = new Map()
          for (const e of edges) {
            if (!bySrc.has(e.fromNodeId)) bySrc.set(e.fromNodeId, [])
            bySrc.get(e.fromNodeId).push(e)
          }
          for (const list of bySrc.values()) {
            if (list.length < 2) continue
            list.sort((x, y) => {
              const px = pos.get(x.toNodeId)
              const py = pos.get(y.toNodeId)
              const a0 = pos.get(x.fromNodeId)
              if (!px || !py || !a0) return 0
              return Math.atan2(px.y - a0.y, px.x - a0.x) - Math.atan2(py.y - a0.y, py.x - a0.x)
            })
            list.forEach((e, k) => bendRank.set(e, k - (list.length - 1) / 2))
          }
        }
        for (let iter = 0; iter < 40; iter++) {
          const pushX = new Map()
          const pushY = new Map()
          for (const id of ids) { pushX.set(id, 0); pushY.set(id, 0) }
          let moved = 0
          for (const e of edges) {
            const segs = segmentsOf(e, sizes, pos)
            if (!segs) continue
            const extra = bendAware ? Math.abs(bendRank.get(e) || 0) * 13 : 0
            for (const seg of segs) {
              const x1 = seg[0]
              const y1 = seg[1]
              const x2 = seg[2]
              const y2 = seg[3]
              const abx = x2 - x1
              const aby = y2 - y1
              const len2 = abx * abx + aby * aby
              if (len2 < 1) continue
              const nx = -aby / Math.sqrt(len2)
              const ny = abx / Math.sqrt(len2)
              for (const node of nodes) {
                if (node.id === e.fromNodeId || node.id === e.toNodeId) continue
                const p = pos.get(node.id)
                const s = sizes.get(node.id)
                let t = ((p.x - x1) * abx + (p.y - y1) * aby) / len2
                t = Math.max(0, Math.min(1, t))
                const cx = x1 + abx * t
                const cy = y1 + aby * t
                const d = Math.abs((p.x - cx) * nx + (p.y - cy) * ny)
                const half = s ? Math.max((s.w + s.h) / 4, 44) : 44
                const minDist = half + 46 + extra
                if (d < minDist) {
                  const push = minDist - d
                  const sgn = (p.x - cx) * nx + (p.y - cy) * ny >= 0 ? 1 : -1
                  pushX.set(node.id, pushX.get(node.id) + nx * push * sgn)
                  pushY.set(node.id, pushY.get(node.id) + ny * push * sgn)
                  moved += 1
                }
              }
            }
          }
          if (moved === 0) break
          for (const id of ids) {
            const p = pos.get(id)
            const px = clamp(pushX.get(id), -60, 60)
            const py = clamp(pushY.get(id), -60, 60)
            p.x += px
            p.y += py
          }
        }
      }

      // Path segments for fanned bezier edges (force / circular): the curve
      // stays inside the P0-control-P2 triangle, so protecting the two control
      // edges covers the whole curve.
      function bezierSegmentsOf(edge, sizes, pos) {
        const a = pos.get(edge.fromNodeId)
        const b = pos.get(edge.toNodeId)
        if (!a || !b) return null
        const sa = sizes.get(edge.fromNodeId)
        const sb = sizes.get(edge.toNodeId)
        if (!sa || !sb) return null
        const dx = b.x - a.x
        const dy = b.y - a.y
        const len = Math.max(Math.hypot(dx, dy), 0.001)
        const ux = dx / len
        const uy = dy / len
        const s1 = intersectDist(sa, ux, uy)
        const s2 = intersectDist(sb, ux, uy)
        const x1 = a.x + ux * s1
        const y1 = a.y + uy * s1
        const x2 = b.x - ux * s2
        const y2 = b.y - uy * s2
        const elen0 = Math.max(Math.hypot(x2 - x1, y2 - y1), 0.001)
        const ex = (x2 - x1) / elen0
        const ey = (y2 - y1) / elen0
        const EXT = 12
        const x1p = x1 + ex * EXT
        const y1p = y1 + ey * EXT
        const x2p = x2 - ex * EXT
        const y2p = y2 - ey * EXT
        const elen = Math.max(Math.hypot(x2p - x1p, y2p - y1p), 0.001)
        const rank = fanRankOf(edge)
        const bend = rank === 0 ? 0 : clamp(clamp(rank * 26, -104, 104), -elen * 0.35, elen * 0.35)
        const mx = (x1p + x2p) / 2
        const my = (y1p + y2p) / 2
        const cxp = mx - ey * bend
        const cyp = my + ex * bend
        return [[x1p, y1p, cxp, cyp], [cxp, cyp, x2p, y2p]]
      }

      // Path segments for radial polyline edges: the out/in radial segments
      // (the outer arc already sweeps clear of every ring).
      function radialSegmentsOf(edge, sizes, pos) {
        const a = pos.get(edge.fromNodeId)
        const b = pos.get(edge.toNodeId)
        if (!a || !b) return null
        const sa = sizes.get(edge.fromNodeId)
        const sb = sizes.get(edge.toNodeId)
        if (!sa || !sb) return null
        const ra = Math.hypot(a.x, a.y)
        const rb = Math.hypot(b.x, b.y)
        const out = []
        if (ra < 1 || rb < 1) {
          const target = ra < 1 ? b : a
          const tBase = Math.atan2(target.y, target.x)
          const tFree = radialFreeAngle(tBase, 0, Math.max(ra, rb), edge.fromNodeId, edge.toNodeId, nodes, sizes, pos)
          const exu = Math.cos(tFree)
          const eyu = Math.sin(tFree)
          const tOut = intersectDist(sa, exu, eyu)
          const tIn = intersectDist(sb, exu, eyu)
          out.push([a.x + exu * tOut, a.y + eyu * tOut, target.x - exu * tIn, target.y - eyu * tIn])
          return out
        }
        const R = outerR + 122
        const tae = radialFreeAngle(Math.atan2(a.y, a.x), ra, R, edge.fromNodeId, edge.toNodeId, nodes, sizes, pos)
        const tbe = radialFreeAngle(Math.atan2(b.y, b.x), rb, R, edge.fromNodeId, edge.toNodeId, nodes, sizes, pos)
        const exu = Math.cos(tae)
        const eyu = Math.sin(tae)
        const exv = Math.cos(tbe)
        const eyv = Math.sin(tbe)
        const tA = intersectDist(sa, exu, eyu)
        const tB = intersectDist(sb, exv, eyv)
        out.push([a.x + exu * tA, a.y + eyu * tA, exu * R, eyu * R])
        out.push([exv * R, eyv * R, b.x + exv * tB, b.y + eyv * tB])
        return out
      }

      // fan rank / shared position tables (set per layout run)
      const fanRank = new Map()
      const posOf = new Map()
      let outerR = 0
      function fanRankOf(edge) {
        const r = fanRank.get(edge)
        return r == null ? 0 : r
      }
      function buildFanRanks(edges) {
        fanRank.clear()
        const bySrc = new Map()
        for (const e of edges) {
          if (!bySrc.has(e.fromNodeId)) bySrc.set(e.fromNodeId, [])
          bySrc.get(e.fromNodeId).push(e)
        }
        for (const list of bySrc.values()) {
          if (list.length < 2) continue
          list.sort((x, y) => {
            const px = posOf.get(x.toNodeId)
            const py = posOf.get(y.toNodeId)
            const a0 = posOf.get(x.fromNodeId)
            if (!px || !py || !a0) return 0
            return Math.atan2(px.y - a0.y, px.x - a0.x) - Math.atan2(py.y - a0.y, py.x - a0.x)
          })
          list.forEach((e, k) => fanRank.set(e, k - (list.length - 1) / 2))
        }
      }

      function layoutForce(nodes, edges, sizes) {
        const n = nodes.length
        const pos = new Map()
        if (n === 0) return { pos }
        if (n === 1) { pos.set(nodes[0].id, { x: 0, y: 0 }); return { pos } }
        // d3-force simulation: organic spread with collision — the de-facto
        // open-source engine (d3-force, ISC) used by force-graph,
        // react-force-graph, etc. Collision keeps node boxes apart; the link
        // distance scales with node width so big nodes keep their edges clear.
        posOf.clear()
        for (const nd of nodes) posOf.set(nd.id, { x: nd.x || 0, y: nd.y || 0 })
        buildFanRanks(edges)
        const F = d3force
        const simNodes = nodes.map((nd) => ({ id: nd.id }))
        const nodeIds = new Set(simNodes.map((nd) => nd.id))
        const simLinks = []
        for (const e of edges) {
          if (nodeIds.has(e.fromNodeId) && nodeIds.has(e.toNodeId) && e.fromNodeId !== e.toNodeId) {
            simLinks.push({ source: e.fromNodeId, target: e.toNodeId })
          }
        }
        const linkDistance = (l) => {
          const src = typeof l.source === 'object' ? l.source.id : l.source
          const tgt = typeof l.target === 'object' ? l.target.id : l.target
          const s1 = sizes.get(src)
          const s2 = sizes.get(tgt)
          return ((s1 ? s1.w : 120) + (s2 ? s2.w : 120)) / 2 + 84
        }
        const simulation = F.forceSimulation(simNodes)
          .force('link', F.forceLink(simLinks).id((d) => d.id).distance(linkDistance).strength(0.55))
          .force('charge', F.forceManyBody().strength(-560))
          .force('collide', F.forceCollide((d) => {
            const s = sizes.get(d.id)
            return (s ? Math.max(s.w, s.h) : 80) / 2 + 18
          }).iterations(4))
          .force('x', F.forceX(0).strength(0.035))
          .force('y', F.forceY(0).strength(0.035))
          .alpha(1)
        for (let iter = 0; iter < 600 && simulation.alpha() > 0.005; iter++) simulation.tick()
        simulation.stop()
        for (const nd of simNodes) pos.set(nd.id, { x: nd.x, y: nd.y })
        posOf.clear()
        for (const nd of nodes) posOf.set(nd.id, pos.get(nd.id))
        // Post-pass order: overlap resolution FIRST, then edge-node repulsion
        // (running repulsion before overlap let the overlap pass push nodes
        // back onto edge lines).
        resolveNodeOverlaps(nodes, sizes, pos, 14)
        applyEdgeNodeRepulsion(nodes, edges, sizes, pos, bezierSegmentsOf, true)
        // Post-pass B — resolve any residual node-box overlaps by pushing
        // pairs apart ALONG their center line (axis-only separation can
        // oscillate on closed topologies).
        if (n > 1) {
          const ids = nodes.map((x) => x.id)
          for (let iter = 0; iter < 120; iter++) {
            let moved = 0
            for (let i = 0; i < n; i++) {
              for (let j = i + 1; j < n; j++) {
                const a = pos.get(ids[i])
                const b = pos.get(ids[j])
                const sa = sizes.get(ids[i])
                const sb = sizes.get(ids[j])
                if (!sa || !sb) continue
                let dx = b.x - a.x
                let dy = b.y - a.y
                let d = Math.hypot(dx, dy)
                if (d < 0.5) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = Math.hypot(dx, dy) }
                const need = Math.hypot((sa.w + sb.w) / 2 + 16, (sa.h + sb.h) / 2 + 16)
                if (d >= need) continue
                const push = (need - d) / 2
                const ux = dx / d
                const uy = dy / d
                a.x -= ux * push
                a.y -= uy * push
                b.x += ux * push
                b.y += uy * push
                moved += 1
              }
            }
            if (moved === 0) break
          }
        }
        return { pos }
      }


      // Deterministic circular layout: nodes on a circle (alternating high/low
      // degree shortens chords), interior empty so chords never hit nodes.
      function layoutCircular(nodes, edges, sizes) {
        const n = nodes.length
        const pos = new Map()
        if (n === 0) return { pos }
        if (n === 1) { pos.set(nodes[0].id, { x: 0, y: 0 }); return { pos } }
        const deg = new Map()
        for (const node of nodes) deg.set(node.id, 0)
        for (const e of edges) {
          if (deg.has(e.fromNodeId)) deg.set(e.fromNodeId, deg.get(e.fromNodeId) + 1)
          if (deg.has(e.toNodeId)) deg.set(e.toNodeId, deg.get(e.toNodeId) + 1)
        }
        const sorted = [...nodes].sort((a, b) => deg.get(b.id) - deg.get(a.id))
        const ordered = []
        let lo = 0
        let hi = sorted.length - 1
        while (lo <= hi) {
          ordered.push(sorted[lo])
          lo += 1
          if (lo <= hi) { ordered.push(sorted[hi]); hi -= 1 }
        }
        const arc = 150
        const radius = Math.max((n * arc) / (2 * Math.PI), 300)
        for (let i = 0; i < n; i++) {
          const angle = (i / n) * Math.PI * 2 - Math.PI / 2
          pos.set(ordered[i].id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
        }
        return pos
      }

      // Radial hub-and-spoke: highest-degree node at center, the rest on BFS
      // distance rings (deterministic).
      function layoutRadial(nodes, edges, sizes) {
        const n = nodes.length
        const pos = new Map()
        if (n === 0) return { pos }
        if (n === 1) { pos.set(nodes[0].id, { x: 0, y: 0 }); return { pos } }
        const deg = new Map()
        for (const node of nodes) deg.set(node.id, 0)
        for (const e of edges) {
          if (deg.has(e.fromNodeId)) deg.set(e.fromNodeId, deg.get(e.fromNodeId) + 1)
          if (deg.has(e.toNodeId)) deg.set(e.toNodeId, deg.get(e.toNodeId) + 1)
        }
        let hub = nodes[0]
        for (const node of nodes) if (deg.get(node.id) > deg.get(hub.id)) hub = node
        const adj = new Map()
        for (const node of nodes) adj.set(node.id, [])
        for (const e of edges) {
          const fa = adj.get(e.fromNodeId)
          const tb = adj.get(e.toNodeId)
          if (fa && tb) { fa.push(e.toNodeId); tb.push(e.fromNodeId) }
        }
        const level = new Map([[hub.id, 0]])
        const queue = [hub.id]
        while (queue.length > 0) {
          const id = queue.shift()
          for (const nb of adj.get(id)) {
            if (!level.has(nb)) { level.set(nb, level.get(id) + 1); queue.push(nb) }
          }
        }
        const groups = new Map()
        for (const node of nodes) {
          const l = level.get(node.id) == null ? 1 : level.get(node.id)
          if (!groups.has(l)) groups.set(l, [])
          groups.get(l).push(node)
        }
        // Ring radii grow monotonically AND leave angular clearance between
        // neighbours so radial segments can thread through: each node needs
        // ~61px of lateral room on both sides, so circumference >= n*(120+122)
        // -> radius >= n*38.5. Without this, 10+ nodes on a ring leave gaps
        // too narrow for any spoke to pass (dodge can never succeed).
        let prevR = 0
        const levels = [...groups.keys()].sort((a, b) => a - b)
        for (const l of levels) {
          const list = groups.get(l)
          list.sort((a, b) => deg.get(b.id) - deg.get(a.id))
          const need = list.length * 39
          const R = l === 0 ? 0 : Math.max(prevR + 240, need)
          prevR = R
          list.forEach((node, i) => {
            const angle = (i / list.length) * Math.PI * 2 - Math.PI / 2
            pos.set(node.id, { x: Math.cos(angle) * R, y: Math.sin(angle) * R })
          })
        }
        return pos
      }

      // Layered (hierarchical): BFS levels stacked top-down, each level
      // centered with degree-descending order (deterministic).
      function layoutLayered(nodes, edges, sizes) {
        const n = nodes.length
        const pos = new Map()
        if (n === 0) return { pos }
        if (n === 1) { pos.set(nodes[0].id, { x: 0, y: 0 }); return { pos } }
        const deg = new Map()
        for (const node of nodes) deg.set(node.id, 0)
        for (const e of edges) {
          if (deg.has(e.fromNodeId)) deg.set(e.fromNodeId, deg.get(e.fromNodeId) + 1)
          if (deg.has(e.toNodeId)) deg.set(e.toNodeId, deg.get(e.toNodeId) + 1)
        }
        let hub = nodes[0]
        for (const node of nodes) if (deg.get(node.id) > deg.get(hub.id)) hub = node
        const adj = new Map()
        for (const node of nodes) adj.set(node.id, [])
        for (const e of edges) {
          const fa = adj.get(e.fromNodeId)
          const tb = adj.get(e.toNodeId)
          if (fa && tb) { fa.push(e.toNodeId); tb.push(e.fromNodeId) }
        }
        const level = new Map([[hub.id, 0]])
        const queue = [hub.id]
        while (queue.length > 0) {
          const id = queue.shift()
          for (const nb of adj.get(id)) {
            if (!level.has(nb)) { level.set(nb, level.get(id) + 1); queue.push(nb) }
          }
        }
        const groups = new Map()
        for (const node of nodes) {
          const l = level.get(node.id) == null ? 1 : level.get(node.id)
          if (!groups.has(l)) groups.set(l, [])
          groups.get(l).push(node)
        }
        for (const [l, list] of groups) {
          list.sort((a, b) => deg.get(b.id) - deg.get(a.id))
          const totalW = (list.length - 1) * LAYER_X_GAP
          list.forEach((node, i) => {
            pos.set(node.id, { x: i * LAYER_X_GAP - totalW / 2, y: l * LAYER_Y_GAP })
          })
        }
        return pos
      }

      // Row-preserving overlap resolution for the LAYERED layout: pushes
      // overlapping pairs apart along the ROW axis (x) only, so nodes never
      // drift off their row centers. Drifted rows would put the channel lines
      // inside node rects, making edges appear to start inside the node.
      function resolveLayeredOverlaps(nodes, sizes, pos, gap) {
        const n = nodes.length
        if (n < 2) return pos
        const ids = nodes.map((x) => x.id)
        for (let iter = 0; iter < 120; iter++) {
          let moved = 0
          for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
              const a = pos.get(ids[i])
              const b = pos.get(ids[j])
              const sa = sizes.get(ids[i])
              const sb = sizes.get(ids[j])
              if (!sa || !sb) continue
              let dx = b.x - a.x
              let dy = b.y - a.y
              if (Math.abs(dy) > (sa.h + sb.h) / 2 + gap) continue
              const need = (sa.w + sb.w) / 2 + gap
              if (Math.abs(dx) >= need) continue
              let s = dx >= 0 ? 1 : -1
              if (dx === 0) s = Math.random() < 0.5 ? -1 : 1
              const push = (need - Math.abs(dx)) / 2
              a.x -= s * push
              b.x += s * push
              moved += 1
            }
          }
          if (moved === 0) break
        }
        return pos
      }

      // Center-line overlap resolution shared by deterministic layouts.
      function resolveNodeOverlaps(nodes, sizes, pos, gap) {
        const n = nodes.length
        if (n < 2) return pos
        const ids = nodes.map((x) => x.id)
        for (let iter = 0; iter < 120; iter++) {
          let moved = 0
          for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
              const a = pos.get(ids[i])
              const b = pos.get(ids[j])
              const sa = sizes.get(ids[i])
              const sb = sizes.get(ids[j])
              if (!sa || !sb) continue
              let dx = b.x - a.x
              let dy = b.y - a.y
              let d = Math.hypot(dx, dy)
              if (d < 0.5) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = Math.hypot(dx, dy) }
              const need = Math.hypot((sa.w + sb.w) / 2 + gap, (sa.h + sb.h) / 2 + gap)
              if (d >= need) continue
              const push = (need - d) / 2
              const ux = dx / d
              const uy = dy / d
              a.x -= ux * push
              a.y -= uy * push
              b.x += ux * push
              b.y += uy * push
              moved += 1
            }
          }
          if (moved === 0) break
        }
        return pos
      }

      // ---- orthogonal (right-angle) edge routing for the layered layout ----
      // Rows are horizontal bands separated by empty channels. Every cross-row
      // edge runs: vertical inside its own row band -> horizontal in a channel
      // -> vertical through a node-free corridor -> horizontal in a channel ->
      // vertical into the target. Same-row edges detour through the channel
      // below (or above, for the last row). Every bend is 90 degrees and no
      // segment crosses a node rect.
      function corridorFree(x, r1, r2, nodes, sizes, pos) {
        for (const n of nodes) {
          const r = Math.round(pos.get(n.id).y / LAYER_Y_GAP)
          if (r <= r1 || r >= r2) continue
          const s = sizes.get(n.id)
          // margin 6px past the rect edge: dense rows leave only ~20px gaps
          // between 200px-wide nodes, so a w/2+16 margin made corridors
          // impossible and the vertical run ploughed through the row
          const half = (s ? s.w : 120) / 2 + 6
          if (Math.abs(x - pos.get(n.id).x) < half) return false
        }
        return true
      }
      function findCorridor(fromX, r1, r2, nodes, sizes, pos) {
        let step = 24
        let dir = 1
        let i = 1
        while (i < 40) {
          for (const sign of [dir, -dir]) {
            const x = fromX + sign * i * step
            if (corridorFree(x, r1, r2, nodes, sizes, pos)) return x
          }
          i += 1
        }
        return fromX
      }
      // Vertical band (y range) of the channel between row r and r+1 that is
      // clear of every node rect; used to clamp horizontal runs and lane
      // offsets so they can never enter a node body or a row band.
      function channelBand(r, nodes, sizes, pos) {
        let lo = -Infinity
        let hi = Infinity
        for (const n of nodes) {
          const nr = Math.round(pos.get(n.id).y / LAYER_Y_GAP)
          const s = sizes.get(n.id)
          const half = s ? s.h / 2 : 40
          if (nr === r) lo = Math.max(lo, pos.get(n.id).y + half)
          if (nr === r + 1) hi = Math.min(hi, pos.get(n.id).y - half)
        }
        if (!isFinite(lo)) lo = r * LAYER_Y_GAP + LAYER_Y_GAP / 2
        if (!isFinite(hi)) hi = (r + 1) * LAYER_Y_GAP + LAYER_Y_GAP / 2
        lo += 4
        hi -= 4
        if (lo > hi) { const m = (lo + hi) / 2; lo = m; hi = m }
        return [lo, hi]
      }

      function layeredOrthoPath(edge, a, b, sizes, pos, nodes, lane) {
        const offY = lane * 8
        const offX = lane * 12
        // Start/end on the node BORDERS, not the centers (node fills are
        // translucent, so a center-starting line shows through the body).
        const s1 = sizes.get(edge.fromNodeId)
        const s2 = sizes.get(edge.toNodeId)
        const h1 = s1 ? s1.h / 2 : 40
        const h2 = s2 ? s2.h / 2 : 40
        const r1 = Math.round(a.y / LAYER_Y_GAP)
        const r2 = Math.round(b.y / LAYER_Y_GAP)
        if (r1 === r2) {
          let maxRow = 0
          for (const n of nodes) maxRow = Math.max(maxRow, Math.round(pos.get(n.id).y / LAYER_Y_GAP))
          // detour through the channel below the row (above, for the last row),
          // clamped into that channel's node-free band so lane offsets can
          // never push the run into a row band or a node body
          const band = channelBand(r1 >= maxRow ? r1 - 1 : r1, nodes, sizes, pos)
          const cy = r1 >= maxRow ? r1 * LAYER_Y_GAP - LAYER_Y_GAP / 2 : r1 * LAYER_Y_GAP + LAYER_Y_GAP / 2
          const cye = clamp(cy + offY, band[0], band[1])
          const y0 = a.y + (cye > a.y ? h1 : -h1)
          const y1 = b.y - (b.y > cye ? h2 : -h2)
          const d = 'M ' + (a.x + offX) + ' ' + y0 + ' L ' + (a.x + offX) + ' ' + cye
            + ' L ' + (b.x + offX) + ' ' + cye + ' L ' + (b.x + offX) + ' ' + y1
          const lblY = cye + (cy > a.y ? 14 : -14)
          return { d, lblX: (a.x + b.x) / 2, lblY }
        }
        // Direction-aware: edges may run upward (deeper row to shallower row),
        // so each endpoint exits/enters through the channel on ITS OWN side.
        const lo = Math.min(r1, r2)
        const hi = Math.max(r1, r2)
        const ch1 = r1 < r2 ? r1 * LAYER_Y_GAP + LAYER_Y_GAP / 2 : (r1 - 1) * LAYER_Y_GAP + LAYER_Y_GAP / 2
        const ch2 = r1 < r2 ? (r2 - 1) * LAYER_Y_GAP + LAYER_Y_GAP / 2 : r2 * LAYER_Y_GAP + LAYER_Y_GAP / 2
        let xc = a.x
        if (!corridorFree(xc, lo, hi, nodes, sizes, pos)) {
          xc = b.x
          if (!corridorFree(xc, lo, hi, nodes, sizes, pos)) {
            xc = findCorridor(a.x, lo, hi, nodes, sizes, pos)
          }
        }
        const xce = corridorFree(xc + offX, lo, hi, nodes, sizes, pos) ? xc + offX : xc
        // clamp the channel runs into their node-free bands (lane offsets and
        // row drift must never push a run into a row band or node body)
        const band1 = channelBand(r1 < r2 ? r1 : r1 - 1, nodes, sizes, pos)
        const band2 = channelBand(r1 < r2 ? r2 - 1 : r2, nodes, sizes, pos)
        const ch1e = clamp(ch1 + offY, band1[0], band1[1])
        const ch2e = clamp(ch2 + offY, band2[0], band2[1])
        const y0 = a.y + (ch1e > a.y ? h1 : -h1)
        const y1 = b.y - (b.y > ch2e ? h2 : -h2)
        const d = 'M ' + (a.x + offX) + ' ' + y0 + ' L ' + (a.x + offX) + ' ' + ch1e
          + ' L ' + xce + ' ' + ch1e + ' L ' + xce + ' ' + ch2e
          + ' L ' + (b.x + offX) + ' ' + ch2e + ' L ' + (b.x + offX) + ' ' + y1
        return { d, lblX: xce + 14, lblY: (ch1e + ch2e) / 2 }
      }

      // Subdivide a circular arc from angle a1 to a2 at radius R into straight
      // segments that hug the circle. A single chord between two arc endpoints
      // cuts through the interior when the endpoints are far apart in angle.
      function arcSegments(a1, a2, R) {
        let diff = a2 - a1
        while (diff > Math.PI) diff -= 2 * Math.PI
        while (diff < -Math.PI) diff += 2 * Math.PI
        const STEPS = Math.max(4, Math.ceil(Math.abs(diff) / (Math.PI / 12)))
        const pts = []
        for (let i = 1; i <= STEPS; i++) {
          const ang = a1 + diff * (i / STEPS)
          pts.push([Math.cos(ang) * R, Math.sin(ang) * R])
        }
        return pts
      }

      // Pick an exit/entry angle whose radial segment from rFrom to rTo does
      // not cut through any node rect; tries small offsets around the base
      // angle, best effort.
      function radialFreeAngle(base, rFrom, rTo, excludeA, excludeB, nodes, sizes, pos) {
        const deltas = []
        for (let d = 0; d <= 30; d += 2) { deltas.push(d); if (d > 0) deltas.push(-d) }
        for (const delta of deltas) {
          const ang = base + (delta * Math.PI) / 180
          const ux = Math.cos(ang)
          const uy = Math.sin(ang)
          let ok = true
          for (const n of nodes) {
            if (n.id === excludeA || n.id === excludeB) continue
            const p = pos.get(n.id)
            const s = sizes.get(n.id)
            if (!p || !s) continue
            for (let k = 1; k <= 10; k++) {
              const t = k / 10
              const rr = rFrom + (rTo - rFrom) * t
              const qx = ux * rr
              const qy = uy * rr
              if (Math.abs(qx - p.x) < s.w / 2 - 3 && Math.abs(qy - p.y) < s.h / 2 - 3) {
                ok = false
                break
              }
            }
            if (!ok) break
          }
          if (ok) return ang
        }
        return base
      }

      function layoutGraph(nodes, edges, sizes, mode) {
        if (mode === 'circular') {
          const pos = layoutCircular(nodes, edges, sizes)
          posOf.clear()
          for (const nd of nodes) posOf.set(nd.id, pos.get(nd.id))
          buildFanRanks(edges)
          resolveNodeOverlaps(nodes, sizes, pos, 14)
          applyEdgeNodeRepulsion(nodes, edges, sizes, pos, bezierSegmentsOf, true)
          return { pos }
        }
        if (mode === 'radial') {
          const pos = layoutRadial(nodes, edges, sizes)
          // Radial relies on angle dodging + the outside-the-rings arc, NOT on
          // the node repulsion: pushing ring nodes off spokes destroys the
          // ring structure itself (chain distortion across every ring).
          return { pos: resolveNodeOverlaps(nodes, sizes, pos, 18) }
        }
        if (mode === 'layered') {
          // channels between rows already guarantee node-free paths; keep the
          // rows perfectly aligned so the channel lines stay outside nodes
          return { pos: resolveLayeredOverlaps(nodes, sizes, layoutLayered(nodes, edges, sizes), 18) }
        }
        return layoutForce(nodes, edges, sizes)
      }      function computeBBox(nodes, layout, sizes) {
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
      function GraphViewer({ nodes, edges, anchors, selectedNodeId, selectedEdgeId, focusReq, onSelectNode, onSelectEdge, ctx, height, layoutMode, onLayoutModeChange }) {
        const containerRef = useRef(null)
        const [view, setView] = useState({ k: 1, tx: 0, ty: 0 })
        const [dragging, setDragging] = useState(false)
        const [tooltip, setTooltip] = useState(null)
        const [flashId, setFlashId] = useState(null)
        const [hoverEdge, setHoverEdge] = useState(null)
        const pressTimer = useRef(null)
        const panRef = useRef(null)

        const sizes = useMemo(() => computeNodeSizes(nodes), [nodes])
        const layout = useMemo(() => {
          try {
            return layoutGraph(nodes, edges, sizes, layoutMode || 'force')
          } catch (e) {
            // A layout failure must never take down the whole page: fall back
            // to a degenerate safe layout and keep rendering.
            console.error('[dsh-knowledge-graph] layout failed:', e)
            const pos = new Map()
            for (let i = 0; i < nodes.length; i++) {
              const ang = (i / Math.max(nodes.length, 1)) * Math.PI * 2
              pos.set(nodes[i].id, { x: Math.cos(ang) * 320, y: Math.sin(ang) * 320 })
            }
            return { pos }
          }
        }, [nodes, edges, sizes, layoutMode])
        const bbox = useMemo(() => computeBBox(nodes, layout, sizes), [nodes, layout, sizes])

        // Selection focus: selecting a node highlights it, its neighbours and
        // its incident edges; selecting an edge highlights it and its two
        // endpoints. Everything else dims.
        const focus = useMemo(() => {
          if (selectedNodeId) return { kind: 'node', id: selectedNodeId }
          if (selectedEdgeId != null) return { kind: 'edge', idx: selectedEdgeId }
          return null
        }, [selectedNodeId, selectedEdgeId])
        const related = useMemo(() => {
          const ids = new Set()
          const edgeIdx = new Set()
          if (!focus) return { ids, edgeIdx }
          if (focus.kind === 'node') {
            ids.add(focus.id)
            for (let i = 0; i < (edges || []).length; i++) {
              const e = edges[i]
              if (e.fromNodeId === focus.id || e.toNodeId === focus.id) {
                ids.add(e.fromNodeId)
                ids.add(e.toNodeId)
                edgeIdx.add(i)
              }
            }
          } else {
            const e = (edges || [])[focus.idx]
            if (e) {
              ids.add(e.fromNodeId)
              ids.add(e.toNodeId)
              edgeIdx.add(focus.idx)
            }
          }
          return { ids, edgeIdx }
        }, [focus, edges])

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
            list.forEach((edge, k) => {
              curve.set(edge, k - (n - 1) / 2)
            })
          }
          return curve
        }, [edges, layout])

        // Per-edge lanes: edges sharing a row pair (layered) or ring pair
        // (radial) get a lane index so their channel/corridor/arc runs separate
        // by a few px instead of stacking into one indistinguishable line.
        const edgeLanes = useMemo(() => {
          const lanes = new Map()
          if (layoutMode !== 'layered' && layoutMode !== 'radial') return lanes
          const groups = new Map()
          const keyOf = (edge) => {
            const a = layout.pos.get(edge.fromNodeId)
            const b = layout.pos.get(edge.toNodeId)
            if (!a || !b) return null
            if (layoutMode === 'layered') {
              const r1 = Math.round(a.y / LAYER_Y_GAP)
              const r2 = Math.round(b.y / LAYER_Y_GAP)
              return r1 === r2 ? 'row' + r1 : Math.min(r1, r2) + '>' + Math.max(r1, r2)
            }
            const r1 = Math.round(Math.hypot(a.x, a.y) / 280)
            const r2 = Math.round(Math.hypot(b.x, b.y) / 280)
            return Math.min(r1, r2) + '>' + Math.max(r1, r2)
          }
          for (const edge of edges || []) {
            const key = keyOf(edge)
            if (key == null) continue
            if (!groups.has(key)) groups.set(key, [])
            groups.get(key).push(edge)
          }
          for (const list of groups.values()) {
            const n = list.length
            list.forEach((e, k) => lanes.set(e, k - (n - 1) / 2))
          }
          return lanes
        }, [layoutMode, edges, layout])

        // Outermost ring radius (radial mode) so arcs sweep beyond every ring.
        const outerRingR = useMemo(() => {
          let r = 0
          for (const n of nodes) {
            const p = layout.pos.get(n.id)
            if (p) r = Math.max(r, Math.hypot(p.x, p.y))
          }
          return r
        }, [nodes, layout])

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
          const sel = selectedEdgeId === i
          const hover = hoverEdge === i
          const inFocus = focus ? related.edgeIdx.has(i) : true
          const dim = focus ? !inFocus : false
          const rel = REL_LABEL[edge.relation] || edge.relation
          // Radial mode: polylines — each edge leaves its source radially,
          // sweeps along an arc just OUTSIDE the outer ring of its two
          // endpoints, then enters the target radially. Hub edges stay
          // straight spokes. Other modes keep the fanned quadratic bezier.
          let d
          let lblX
          let lblY
          if (layoutMode === 'layered') {
            const o = layeredOrthoPath(edge, a, b, sizes, layout.pos, nodes, edgeLanes.get(edge) || 0)
            d = o.d
            lblX = o.lblX
            lblY = o.lblY
          } else if (layoutMode === 'radial') {
            const ra = Math.hypot(a.x, a.y)
            const rb = Math.hypot(b.x, b.y)
            if (ra < 1 || rb < 1) {
              // hub spokes: straight, border to border, but dodge ring nodes
              // that sit on the same angle
              const target = ra < 1 ? b : a
              const tR = ra < 1 ? rb : ra
              const tA = ra < 1 ? a : b
              const tBase = Math.atan2(target.y, target.x)
              const tFree = radialFreeAngle(tBase, 0, tR, edge.fromNodeId, edge.toNodeId, nodes, sizes, layout.pos)
              const exu = Math.cos(tFree)
              const eyu = Math.sin(tFree)
              const sT = sizes.get(edge.toNodeId)
              const sF = sizes.get(edge.fromNodeId)
              const tOut = sF ? intersectDist(sF, exu, eyu) : 0
              const tIn = sT ? intersectDist(sT, exu, eyu) : 0
              const pxA = tA.x + exu * tOut
              const pyA = tA.y + eyu * tOut
              const pxB = target.x - exu * tIn
              const pyB = target.y - eyu * tIn
              d = 'M ' + pxA + ' ' + pyA + ' L ' + pxB + ' ' + pyB
              const llen = Math.max(Math.hypot(pxA + pxB, pyA + pyB), 0.001)
              lblX = (pxA + pxB) / 2 + ((pxA + pxB) / 2) / llen * 14
              lblY = (pyA + pyB) / 2 + ((pyA + pyB) / 2) / llen * 14
            } else {
              // The arc sweeps OUTSIDE the outermost ring (with a per-group
              // lane offset) so it can never cut through ring nodes; the in/out
              // radial segments dodge intermediate ring nodes by trying small
              // angular offsets, and start/end exactly on the node borders.
              const lane = edgeLanes.get(edge) || 0
              const R = outerRingR + 122 + lane * 16
              const ta = Math.atan2(a.y, a.x)
              const tb = Math.atan2(b.y, b.x)
              const sA = sizes.get(edge.fromNodeId)
              const sB = sizes.get(edge.toNodeId)
              const tae = radialFreeAngle(ta, ra, R, edge.fromNodeId, edge.toNodeId, nodes, sizes, layout.pos)
              const tbe = radialFreeAngle(tb, rb, R, edge.fromNodeId, edge.toNodeId, nodes, sizes, layout.pos)
              const exu = Math.cos(tae)
              const eyu = Math.sin(tae)
              const exv = Math.cos(tbe)
              const eyv = Math.sin(tbe)
              const tA = sA ? intersectDist(sA, exu, eyu) : 0
              const tB = sB ? intersectDist(sB, exv, eyv) : 0
              const pxA = a.x + exu * tA
              const pyA = a.y + eyu * tA
              const pxB = b.x + exv * tB
              const pyB = b.y + eyv * tB
              const arc = arcSegments(tae, tbe, R)
              const parts = ['M ' + pxA + ' ' + pyA]
              for (const ap of arc) parts.push('L ' + ap[0] + ' ' + ap[1])
              parts.push('L ' + pxB + ' ' + pyB)
              d = parts.join(' ')
              let diff = tbe - tae
              while (diff > Math.PI) diff -= 2 * Math.PI
              while (diff < -Math.PI) diff += 2 * Math.PI
              const midAng = tae + diff / 2
              lblX = Math.cos(midAng) * (R + 14)
              lblY = Math.sin(midAng) * (R + 14)
            }
          } else {
            // Quadratic bezier with a signed perpendicular bend: same-source
            // edges fan out symmetrically by rank so arrows never pile onto
            // one line (0 = straight for single edges).
            const rawBend = edgeFan.get(edge) || 0
            const elen0 = Math.max(Math.hypot(pts.x2 - pts.x1, pts.y2 - pts.y1), 0.001)
            const ex = (pts.x2 - pts.x1) / elen0
            const ey = (pts.y2 - pts.y1) / elen0
            // Start/end a few px OUTSIDE the node border so the fanned curve
            // can never clip the node's corner on departure.
            const EXT = 12
            const x1p = pts.x1 + ex * EXT
            const y1p = pts.y1 + ey * EXT
            const x2p = pts.x2 - ex * EXT
            const y2p = pts.y2 - ey * EXT
            const elen = Math.max(Math.hypot(x2p - x1p, y2p - y1p), 0.001)
            const bend = rawBend === 0 ? 0 : clamp(clamp(rawBend * 26, -104, 104), -elen * 0.35, elen * 0.35)
            const mx = (x1p + x2p) / 2
            const my = (y1p + y2p) / 2
            const cxp = mx - ey * bend
            const cyp = my + ex * bend
            d = 'M ' + x1p + ' ' + y1p + ' Q ' + cxp + ' ' + cyp + ' ' + x2p + ' ' + y2p
            const bx = (x1p + 2 * cxp + x2p) / 4
            const by = (y1p + 2 * cyp + y2p) / 4
            lblX = bx - ey * 11
            lblY = by + ex * 11
          }
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
              stroke: sel || (inFocus && focus) ? '#6366f1' : '#9ca3af',
              strokeWidth: sel || hover ? 2.5 : (inFocus && focus ? 2 : 1.5),
              markerEnd: 'url(#' + markerId + ')',
              opacity: dim ? 0.15 : 1,
            }),
            // relation-type label chip at the path's label point (curve
            // midpoint / outer-arc midpoint), offset so it stays off the line
            h('g', {
              key: 'lbl' + i,
              className: 'kg-edge-label' + (sel ? ' sel' : '') + (hover ? ' hov' : ''),
              'aria-hidden': 'true',
              style: dim ? { opacity: 0.15 } : undefined,
            },
              (function () {
                const lw = measureLabel(rel) + 10
                const lh = 15
                return [
                  h('rect', {
                    x: lblX - lw / 2, y: lblY - lh / 2, width: lw, height: lh, rx: 4,
                  }),
                  h('text', { x: lblX, y: lblY + 3.5, textAnchor: 'middle' }, rel),
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
          const inFocus = focus ? related.ids.has(node.id) : true
          const dim = focus ? !inFocus : false
          const neighbor = focus && inFocus && !sel
          const off = anchors[node.id]
          const aria = meta.label + '节点：' + node.text + (off == null ? '，无法回链原文' : '，原文摘录：' + (node.quote || ''))
          return h('g', {
            key: node.id, className: 'kg-node', role: 'button', tabIndex: 0,
            'aria-pressed': sel, 'aria-label': aria,
            style: { cursor: 'pointer', opacity: dim ? 0.22 : 1 },
            onPointerDown: (e) => { e.stopPropagation(); startPress(e, node) },
            onPointerUp: cancelPress,
            onPointerLeave: cancelPress,
            onClick: (e) => { e.stopPropagation(); cancelPress(); setTooltip(null); onSelectNode(node.id) },
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectNode(node.id) } },
          },
            h('rect', {
              x, y, width: s.w, height: s.h, rx: 10,
              fill: meta.fill,
              stroke: sel ? '#3b82f6' : (flash ? '#f59e0b' : (neighbor ? '#3b82f6' : meta.color)),
              strokeWidth: sel || flash ? 3 : (neighbor ? 2 : 1.5),
              className: flash ? 'kg-node-flash' : '',
              style: (sel || flash || neighbor) ? { filter: flash ? 'drop-shadow(0 0 8px rgba(245,158,11,0.9))' : 'drop-shadow(0 0 6px rgba(59,130,246,0.8))' } : undefined,
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
            h('select', {
              className: 'kg-layout-select',
              value: layoutMode || 'force',
              'aria-label': '布局形态',
              title: '切换布局形态',
              onChange: (e) => onLayoutModeChange(e.target.value),
            }, LAYOUT_MODES.map((m) => h('option', { key: m.id, value: m.id }, m.label))),
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
        const [layoutMode, setLayoutMode] = useState(() => {
          try {
            const v = localStorage.getItem(LS_LAYOUT)
            if (v && LAYOUT_MODES.some((m) => m.id === v)) return v
          } catch (e) {}
          return 'force'
        })
        const changeLayoutMode = (id) => {
          setLayoutMode(id)
          try { localStorage.setItem(LS_LAYOUT, id) } catch (e) {}
        }
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
              res = await rpc('task-status', { taskId })
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
            const res = await rpc('extract', payload)
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
                h('p', { className: 'kg-hint' }, '点击原文段落 → 图中聚焦该段节点；点击图中节点 → 滚动到对应原文段落；拖拽平移画布，Ctrl+滚轮缩放，右上角可切换布局形态（力导向 / 圆形 / 放射 / 分层），长按节点查看原文摘录。'),
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
                      layoutMode, onLayoutModeChange: changeLayoutMode,
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
    }

    exports.inject = ["slots", "timer"];
    exports.apply = apply;
    return module.exports;
  }
});
