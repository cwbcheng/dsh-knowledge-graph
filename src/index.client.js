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
 *   - Graph: 8 node-type colors, ring + force-direction relaxation layout with
 *     overlap resolution, pan / ctrl+wheel zoom / toolbar +/- and % reset,
 *     long-press tooltip with the original-text quote, keyboard focusable.
 *   - History: localStorage keeps only lightweight document indexes; source
 *     text and canonical graphs are reloaded from Host/SQLite when revisited.
 *   - Toasts are rendered as a floating overlay so they never cause layout
 *     shifts.
 *
 * Plain JavaScript returning a Cordis Plugin. No TypeScript / JSX.
 */

export default function clientPlugin() {
  return {
    inject: ['slots', 'timer', 'sessions', 'inputTriggers'],
    async apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const sessions = ctx.get('sessions')
      const inputTriggers = ctx.get('inputTriggers')

      // ----------------------------- styles -----------------------------
      styles.insert(`
.kg-root { --kg-text: #1f2937; --kg-text-dim: #6b7280; --kg-border: rgba(100,116,139,0.28); --kg-panel: rgba(127,127,127,0.055); --kg-edge: #64748b; --kg-edge-label-bg: #ffffff; --kg-edge-label-text: #334155; font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; color: var(--kg-text); line-height: 1.5; min-width: 0; }
@media (prefers-color-scheme: dark) { .kg-root { --kg-text: #e5e7eb; --kg-text-dim: #9ca3af; --kg-border: rgba(148,163,184,0.30); --kg-panel: rgba(255,255,255,0.045); --kg-edge: #a8b3c4; --kg-edge-label-bg: #1f2937; --kg-edge-label-text: #e2e8f0; } }
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
.kg-model-picker { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; }
.kg-model-label { font-size: 12px; color: var(--kg-text-dim); white-space: nowrap; }
.kg-model-select { max-width: 280px; min-width: 0; border: 1px solid var(--kg-border); border-radius: 8px; background: var(--kg-panel); color: var(--kg-text); font: inherit; font-size: 12px; padding: 4px 6px; cursor: pointer; }
.kg-model-select:focus { outline: 2px solid rgba(59,130,246,0.45); border-color: #3b82f6; }
.kg-model-select:disabled { opacity: 0.55; cursor: wait; }
.kg-model-refresh { background: none; border: 1px solid var(--kg-border); border-radius: 8px; color: var(--kg-text-dim); font-size: 12px; line-height: 1; padding: 4px 7px; cursor: pointer; }
.kg-model-refresh:hover { color: var(--kg-text); border-color: var(--kg-text-dim); }
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
.kg-verify-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 0; }
.kg-verify-actions .kg-secondary, .kg-verify-actions .kg-primary { padding: 5px 12px; font-size: 12.5px; }
.kg-export-actions { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 5px; margin: -6px 0 0; }
.kg-export-actions .kg-secondary { padding: 4px 9px; font-size: 11.5px; }
.kg-export-label { color: var(--kg-text-dim); font-size: 11.5px; }
.kg-window-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0 10px; padding: 8px 10px; border: 1px solid var(--kg-border); border-radius: 10px; background: var(--kg-panel); font-size: 12px; color: var(--kg-text-dim); }
.kg-window-nav strong { color: var(--kg-text); font-weight: 600; }
.kg-window-nav .kg-secondary { padding: 4px 9px; font-size: 11.5px; }
.kg-window-page { width: 58px; box-sizing: border-box; border: 1px solid var(--kg-border); border-radius: 8px; padding: 4px 6px; background: transparent; color: var(--kg-text); font: inherit; font-size: 12px; text-align: center; }
.kg-window-query { min-width: 160px; flex: 1 1 220px; box-sizing: border-box; border: 1px solid var(--kg-border); border-radius: 8px; padding: 5px 8px; background: transparent; color: var(--kg-text); font: inherit; font-size: 12px; }
.kg-window-query:focus, .kg-window-page:focus { outline: 2px solid rgba(59,130,246,0.35); border-color: #3b82f6; }
.kg-window-sep { width: 1px; height: 22px; background: var(--kg-border); margin: 0 2px; }
@media (max-width: 720px) { .kg-window-sep { display: none; } .kg-window-query { flex-basis: 100%; } }
.kg-verify-metrics { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--kg-text-dim); margin: 6px 0 10px; }
.kg-verify-metrics .kg-ok { color: #059669; }
@media (prefers-color-scheme: dark) { .kg-verify-metrics .kg-ok { color: #34d399; } }
.kg-verify-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
.kg-verify-head-text { flex: 1; min-width: 0; }
.kg-verify-title { margin: 0; font-size: 14px; font-weight: 600; }
.kg-verify-summary { margin: 4px 0 0; font-size: 12.5px; color: var(--kg-text-dim); line-height: 1.6; }
.kg-verify-stale { margin: 4px 0 0; font-size: 12px; color: #b45309; }
@media (prefers-color-scheme: dark) { .kg-verify-stale { color: #fbbf24; } }
.kg-verify-filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.kg-filter-chip { border: 1px solid var(--kg-border); background: var(--kg-panel); color: var(--kg-text-dim); border-radius: 999px; padding: 2px 10px; font-size: 11.5px; cursor: pointer; }
.kg-filter-chip.on { border-color: #3b82f6; color: #3b82f6; background: rgba(59,130,246,0.10); }
.kg-issue { border: 1px solid var(--kg-border); border-left: 3px solid var(--kg-border); border-radius: 10px; padding: 9px 12px; margin-bottom: 8px; background: var(--kg-panel); cursor: pointer; }
.kg-issue:hover { border-color: rgba(59,130,246,0.6); }
.kg-issue.on { border-color: #3b82f6; background: rgba(59,130,246,0.07); box-shadow: 0 0 0 1px rgba(59,130,246,0.35), 0 4px 14px rgba(59,130,246,0.12); }
@media (prefers-color-scheme: dark) { .kg-issue.on { background: rgba(59,130,246,0.12); } }
.kg-issue.kg-issue-flash { animation: kg-issue-locate 1.3s ease; }
@keyframes kg-issue-locate { 0% { background: rgba(59,130,246,0.22); box-shadow: 0 0 0 3px rgba(59,130,246,0.45); } 100% { background: rgba(59,130,246,0.07); box-shadow: 0 0 0 1px rgba(59,130,246,0.35), 0 4px 14px rgba(59,130,246,0.12); } }
.kg-issue.kg-sev-error { border-left-color: rgba(220,38,38,0.45); }
.kg-issue.kg-sev-warning { border-left-color: rgba(217,119,6,0.45); }
.kg-issue.kg-sev-suggestion { border-left-color: rgba(37,99,235,0.45); }
.kg-issue-top { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.kg-sev-tag { display: inline-flex; align-items: center; padding: 0 7px; border-radius: 999px; border: 1px solid transparent; font-size: 10.5px; line-height: 16px; font-weight: 600; }
.kg-sev-error { color: #dc2626; background: rgba(220,38,38,0.07); border-color: rgba(220,38,38,0.20); } .kg-sev-warning { color: #b45309; background: rgba(217,119,6,0.07); border-color: rgba(217,119,6,0.20); } .kg-sev-suggestion { color: #2563eb; background: rgba(37,99,235,0.07); border-color: rgba(37,99,235,0.20); }
@media (prefers-color-scheme: dark) { .kg-sev-error { color: #fca5a5; background: rgba(239,68,68,0.10); border-color: rgba(248,113,113,0.22); } .kg-sev-warning { color: #fcd34d; background: rgba(217,119,6,0.10); border-color: rgba(251,191,36,0.20); } .kg-sev-suggestion { color: #93c5fd; background: rgba(59,130,246,0.10); border-color: rgba(96,165,250,0.22); } }
.kg-issue-cat { font-size: 10.5px; color: var(--kg-text-dim); border: 1px solid var(--kg-border); border-radius: 999px; padding: 0 7px; line-height: 16px; }
.kg-issue-title { font-size: 13px; font-weight: 600; margin: 4px 0 2px; }
.kg-issue-detail { font-size: 12.5px; color: var(--kg-text-dim); line-height: 1.65; }
.kg-issue-ev { margin-top: 5px; padding: 6px 8px; border-left: 3px solid var(--kg-border); background: rgba(127,127,127,0.06); border-radius: 4px; font-size: 12px; color: var(--kg-text-dim); white-space: pre-wrap; word-break: break-word; }
.kg-issue-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 7px; }
.kg-issue-actions button { padding: 3px 10px; font-size: 12px; }
.kg-danger { color: #dc2626; border: 1px solid rgba(220,38,38,0.35) !important; background: rgba(220,38,38,0.05) !important; }
.kg-danger:hover { color: #b91c1c !important; border-color: rgba(220,38,38,0.55) !important; background: rgba(220,38,38,0.10) !important; }
@media (prefers-color-scheme: dark) { .kg-danger { color: #fca5a5 !important; } }
.kg-issue-actions .kg-primary { background: rgba(59,130,246,0.10); color: #2563eb; border: 1px solid rgba(59,130,246,0.30); font-weight: 500; }
.kg-issue-actions .kg-primary:hover:not(:disabled) { background: rgba(59,130,246,0.18); }
@media (prefers-color-scheme: dark) { .kg-issue-actions .kg-primary { color: #93c5fd; } }
.kg-issue-status { margin-left: auto; font-size: 11.5px; color: var(--kg-text-dim); }
.kg-issue.kg-applied, .kg-issue.kg-rejected { opacity: 0.55; }
.kg-issue.kg-applied { border-left-color: #10b981; }
.kg-issue.kg-rejected { text-decoration: none; }
.kg-audit { margin-top: 10px; border-top: 1px dashed var(--kg-border); padding-top: 8px; }
.kg-audit-title { font-size: 12px; font-weight: 600; margin: 0 0 6px; }
.kg-audit-list { display: flex; flex-direction: column; gap: 4px; }
.kg-audit-item { font-size: 11.5px; color: var(--kg-text-dim); line-height: 1.5; }
.kg-audit-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.kg-audit-diff { margin: 3px 0 0 4px; padding: 4px 8px; border-left: 2px solid rgba(16,185,129,0.35); background: rgba(16,185,129,0.05); border-radius: 0 6px 6px 0; color: var(--kg-text); white-space: pre-wrap; word-break: break-word; }
.kg-audit-diff div + div { margin-top: 2px; }
.kg-audit-more { color: var(--kg-text-dim); font-size: 11px; }
.kg-audit-action { display: inline-flex; margin-right: 6px; padding: 0 6px; border-radius: 999px; border: 1px solid rgba(16,185,129,0.35); color: #047857; background: rgba(16,185,129,0.08); font-size: 10.5px; line-height: 16px; }
@media (prefers-color-scheme: dark) { .kg-audit-action { color: #6ee7b7; } }
.kg-question-bar { display: flex; gap: 8px; align-items: stretch; margin-top: 10px; }
.kg-question-bar .kg-primary { background: rgba(59,130,246,0.10); color: #2563eb; border: 1px solid rgba(59,130,246,0.30); font-weight: 500; }
.kg-question-bar .kg-primary:hover:not(:disabled) { background: rgba(59,130,246,0.18); }
@media (prefers-color-scheme: dark) { .kg-question-bar .kg-primary { color: #93c5fd; } }
.kg-question-input { flex: 1; min-width: 0; border: 1px solid var(--kg-border); border-radius: 10px; padding: 8px 10px; background: var(--kg-panel); color: var(--kg-text); font: inherit; font-size: 12.5px; }
.kg-question-input:focus { outline: 2px solid rgba(59,130,246,0.45); border-color: #3b82f6; }
.kg-question-target { margin: 8px 0 0; font-size: 11.5px; color: var(--kg-text-dim); }
.kg-question-result { margin-top: 10px; padding: 10px 12px; border: 1px solid rgba(59,130,246,0.4); border-radius: 10px; background: rgba(59,130,246,0.06); font-size: 12.5px; line-height: 1.7; }
.kg-verdict { display: inline-flex; align-items: center; padding: 0 7px; border-radius: 999px; border: 1px solid transparent; font-size: 10.5px; line-height: 16px; font-weight: 600; }
.kg-verdict-supported { color: #047857; background: rgba(5,150,105,0.08); border-color: rgba(5,150,105,0.22); } .kg-verdict-contradicted { color: #dc2626; background: rgba(220,38,38,0.08); border-color: rgba(220,38,38,0.22); } .kg-verdict-insufficient { color: #b45309; background: rgba(217,119,6,0.08); border-color: rgba(217,119,6,0.22); } .kg-verdict-out_of_scope { color: #475569; background: rgba(100,116,139,0.10); border-color: rgba(100,116,139,0.25); }
@media (prefers-color-scheme: dark) { .kg-verdict-supported { color: #6ee7b7; } .kg-verdict-contradicted { color: #fca5a5; } .kg-verdict-insufficient { color: #fcd34d; } .kg-verdict-out_of_scope { color: #cbd5e1; } }
.kg-fact-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
.kg-fact-rules { margin: 8px 0 10px; }
.kg-fact-head-text { flex: 1; min-width: 0; }
.kg-fact-title { margin: 0; font-size: 14px; font-weight: 600; }
.kg-fact-summary { margin: 4px 0 0; font-size: 12.5px; color: var(--kg-text-dim); line-height: 1.6; }
.kg-fact-note { margin: 4px 0 0; font-size: 11.5px; color: var(--kg-text-dim); }
.kg-fact-stale { color: #b45309; }
@media (prefers-color-scheme: dark) { .kg-fact-stale { color: #fbbf24; } }
.kg-fact-metrics { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--kg-text-dim); margin: 6px 0 10px; }
.kg-fact-claim { border: 1px solid var(--kg-border); border-left: 3px solid var(--kg-border); border-radius: 10px; padding: 9px 12px; margin-bottom: 8px; background: var(--kg-panel); cursor: pointer; }
.kg-fact-claim:hover, .kg-fact-claim.on { border-color: rgba(59,130,246,0.6); }
.kg-fact-claim.on { background: rgba(59,130,246,0.07); box-shadow: 0 0 0 1px rgba(59,130,246,0.30); }
.kg-fact-claim.kg-fv-supported { border-left-color: #10b981; } .kg-fact-claim.kg-fv-contradicted { border-left-color: #dc2626; } .kg-fact-claim.kg-fv-partially_supported { border-left-color: #d97706; }
.kg-fact-top { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.kg-fv-tag { display: inline-flex; align-items: center; padding: 0 7px; border-radius: 999px; border: 1px solid transparent; font-size: 10.5px; line-height: 16px; font-weight: 600; }
.kg-fact-text { font-size: 13px; font-weight: 600; margin: 4px 0 2px; }
.kg-fact-rationale { font-size: 12.5px; color: var(--kg-text-dim); line-height: 1.65; }
.kg-fact-quote { margin-top: 5px; padding: 6px 8px; border-left: 3px solid var(--kg-border); background: rgba(127,127,127,0.06); border-radius: 4px; font-size: 12px; color: var(--kg-text-dim); }
.kg-fact-ev { display: block; margin-top: 5px; font-size: 12px; color: #2563eb; text-decoration: none; word-break: break-all; }
.kg-fact-ev:hover { text-decoration: underline; }
.kg-fact-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 7px; }
.kg-fact-actions button { padding: 3px 10px; font-size: 12px; }
.kg-fact-status { margin-left: auto; font-size: 11.5px; color: var(--kg-text-dim); }
.kg-verify-spinner { display: inline-block; width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(59,130,246,0.25); border-top-color: #3b82f6; animation: kg-spin 0.9s linear infinite; vertical-align: -2px; margin-right: 6px; }
.kg-hint { margin: 0 0 10px; font-size: 12px; color: var(--kg-text-dim); }
.kg-cols { display: grid; gap: 14px; }
.kg-original { display: flex; flex-direction: column; gap: 10px; overflow: auto; user-select: text; }
.kg-select-bar { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 8px; padding: 6px 8px; margin: -1px -1px 0; background: var(--kg-win-bg); border-bottom: 1px solid var(--kg-border); border-radius: 10px 10px 0 0; }
.kg-select-count { font-size: 12px; color: var(--kg-text-dim); flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kg-select-btn { padding: 5px 14px; font-size: 12.5px; white-space: nowrap; }
.kg-sel-tool { position: fixed; z-index: 55; display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 10px; background: #3b82f6; color: #fff; font-size: 12.5px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.25); pointer-events: auto; border: none; font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; line-height: 1.4; }
.kg-sel-tool:hover { background: #2563eb; }
.kg-split-handle { display: none; }
.kg-h-handle { display: flex; align-items: center; justify-content: center; height: 10px; margin-top: 10px; cursor: row-resize; touch-action: none; user-select: none; }
.kg-h-bar { width: 56px; height: 3px; border-radius: 2px; background: var(--kg-border); transition: background 0.15s; }
.kg-h-handle:hover .kg-h-bar, .kg-h-handle:active .kg-h-bar { background: #3b82f6; }
.kg-para { border: 1px solid var(--kg-border); border-radius: 10px; padding: 9px 12px; background: var(--kg-panel); cursor: pointer; transition: border-color 0.15s; }
.kg-para:hover { border-color: rgba(59,130,246,0.6); }
.kg-para p { margin: 6px 0 2px; white-space: pre-wrap; font-size: 13.5px; word-break: break-word; }
.kg-para:focus-visible { outline: 2px solid rgba(59,130,246,0.55); outline-offset: 1px; }
.kg-para.kg-active { border-color: #3b82f6; box-shadow: inset 3px 0 0 #3b82f6; }
.kg-para-badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.kg-para-num { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; padding: 1px 8px; border-radius: 999px; border: 1px solid rgba(59,130,246,0.22); background: rgba(59,130,246,0.08); color: #2563eb; font-size: 11px; line-height: 18px; font-weight: 600; }
@media (prefers-color-scheme: dark) { .kg-para-num { color: #93c5fd; background: rgba(59,130,246,0.12); border-color: rgba(96,165,250,0.25); } }
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
.kg-edge-label rect { fill: var(--kg-edge-label-bg); stroke: color-mix(in srgb, var(--kg-edge) 60%, transparent); stroke-width: 1; }
.kg-edge-label text { fill: var(--kg-edge-label-text); font-size: 10px; font-weight: 600; }
.kg-edge-label.sel rect { fill: rgba(99,102,241,0.16); stroke: #6366f1; }
.kg-edge-label.sel text { fill: #6366f1; font-weight: 600; }
.kg-edge-label.hov rect { stroke: #6366f1; }
.kg-edge-label.hov text { fill: #6366f1; }
.kg-node-flash { animation: kg-node-pulse 1.4s ease; }
@keyframes kg-node-pulse { 0%, 100% { opacity: 1; } 35% { opacity: 0.3; } }
.kg-tooltip { position: absolute; z-index: 5; max-width: 300px; pointer-events: none; background: rgba(17,24,39,0.95); color: #f9fafb; border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.55; box-shadow: 0 4px 14px rgba(0,0,0,0.28); transform: translate(10px, 10px); }
.kg-tooltip-type { font-weight: 600; margin-bottom: 2px; }
.kg-tooltip-quote { margin-top: 4px; color: #cbd5e1; }
.kg-node-detail { position: absolute; left: 12px; right: 12px; top: 46px; z-index: 6; background: #ffffff; color: #1f2937; border: 1px solid var(--kg-border); border-radius: 10px; padding: 10px 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.28); font-size: 12.5px; line-height: 1.6; max-height: 55%; overflow: auto; user-select: text; }
@media (prefers-color-scheme: dark) { .kg-node-detail { background: #111827; color: #e5e7eb; } }
.kg-node-detail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.kg-node-detail-type { display: inline-flex; padding: 1px 8px; border-radius: 999px; color: #fff; font-size: 11px; font-weight: 600; line-height: 18px; }
.kg-node-detail-close { margin-left: auto; flex: none; background: none; border: none; cursor: pointer; font-size: 15px; line-height: 1; color: inherit; opacity: 0.65; padding: 2px 4px; }
.kg-node-detail-close:hover { opacity: 1; }
.kg-node-detail-text { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; }
.kg-node-detail-quote { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--kg-border); color: var(--kg-text-dim); font-size: 12px; }
.kg-node-detail-actions { margin-top: 10px; display: flex; justify-content: flex-end; }
.kg-node-detail-locate { padding: 4px 12px; font-size: 12px; }
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
.kg-doc-import-btn { display: inline-flex; align-items: center; gap: 5px; background: transparent; border: 1px solid transparent; border-radius: 8px; color: inherit; cursor: pointer; padding: 4px 8px; font-size: 12px; font-family: inherit; white-space: nowrap; }
.kg-doc-import-btn:hover:not(:disabled) { background: rgba(59,130,246,0.12); border-color: rgba(59,130,246,0.35); color: #2563eb; }
.kg-doc-import-btn:disabled { opacity: 0.5; cursor: not-allowed; }
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
.kg-section-filter { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin: 8px 0 10px; }
.kg-section-select { min-width: 180px; max-width: 100%; border: 1px solid var(--kg-border); border-radius: 8px; background: var(--kg-panel); color: var(--kg-text); font: inherit; font-size: 12px; padding: 5px 8px; }
.kg-section-select:focus { outline: 2px solid rgba(59,130,246,0.45); border-color: #3b82f6; }
.kg-section-meta { font-size: 11.5px; color: var(--kg-text-dim); }
.kg-candidate-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; }
.kg-candidate-list { display: flex; flex-direction: column; gap: 7px; max-height: 430px; overflow: auto; }
.kg-candidate { border: 1px solid var(--kg-border); border-left: 3px solid var(--kg-border); border-radius: 9px; padding: 8px 10px; background: var(--kg-panel); cursor: pointer; }
.kg-candidate:hover, .kg-candidate.on { border-color: rgba(59,130,246,0.6); background: rgba(59,130,246,0.07); }
.kg-candidate.kg-candidate-accepted { border-left-color: #10b981; }
.kg-candidate.kg-candidate-rejected { border-left-color: #dc2626; opacity: 0.72; }
.kg-candidate-top { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; }
.kg-candidate-kind { font-size: 10.5px; color: var(--kg-text-dim); border: 1px solid var(--kg-border); border-radius: 999px; padding: 0 7px; line-height: 16px; }
.kg-candidate-text { margin-top: 4px; font-size: 13px; font-weight: 600; line-height: 1.55; word-break: break-word; }
.kg-candidate-evidence { margin-top: 4px; font-size: 11.5px; color: var(--kg-text-dim); white-space: pre-wrap; word-break: break-word; }
.kg-candidate-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 6px; }
.kg-candidate-actions button { padding: 3px 8px; font-size: 11.5px; }
.kg-candidate-status { margin-left: auto; font-size: 11px; color: var(--kg-text-dim); }
.kg-candidate-empty { margin: 0; font-size: 12px; color: var(--kg-text-dim); }
.kg-candidate-counts { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 11.5px; color: var(--kg-text-dim); }
.kg-win { --kg-text: #1f2937; --kg-text-dim: #6b7280; --kg-border: rgba(100,116,139,0.28); --kg-panel: rgba(127,127,127,0.055); --kg-edge: #64748b; --kg-edge-label-bg: #ffffff; --kg-edge-label-text: #334155; --kg-win-bg: #ffffff; position: fixed; display: flex; flex-direction: column; border: 1px solid var(--kg-border); border-radius: 14px; background: var(--kg-win-bg); color: var(--kg-text); box-shadow: 0 16px 48px rgba(0,0,0,0.30); z-index: 60; pointer-events: auto; overflow: hidden; font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; line-height: 1.5; }
@media (prefers-color-scheme: dark) { .kg-win { --kg-text: #e5e7eb; --kg-text-dim: #9ca3af; --kg-border: rgba(148,163,184,0.30); --kg-panel: rgba(255,255,255,0.045); --kg-win-bg: #111827; --kg-edge: #a8b3c4; --kg-edge-label-bg: #1f2937; --kg-edge-label-text: #e2e8f0; } }
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
.kg-traj-body { position: relative; padding: 14px 4px 24px; min-width: 0; }
.kg-traj-cols { display: grid; grid-template-columns: 1fr; gap: 14px; align-items: start; }
@media (min-width: 860px) { .kg-traj-cols { grid-template-columns: minmax(240px, var(--kg-traj-split, 36%)) 12px minmax(0, 1fr); gap: 14px 0; } }
.kg-traj-split-handle { display: none; }
@media (min-width: 860px) { .kg-traj-split-handle { display: flex; align-items: center; justify-content: center; cursor: col-resize; touch-action: none; user-select: none; } }
.kg-traj-split-bar { width: 3px; height: 52px; border-radius: 2px; background: var(--kg-border); transition: background 0.15s; }
.kg-traj-split-handle:hover .kg-traj-split-bar, .kg-traj-split-handle:active .kg-traj-split-bar { background: #3b82f6; }
.kg-traj-original { display: flex; flex-direction: column; gap: 10px; overflow: auto; user-select: text; }
.kg-traj-ev-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 11px; color: var(--kg-text-dim); margin-bottom: 4px; }
.kg-traj-ev-chip { display: inline-flex; padding: 0 8px; border-radius: 999px; border: 1px solid var(--kg-border); background: var(--kg-panel); line-height: 18px; }
.kg-append-btn { padding: 6px 14px; font-size: 13px; }
`)

      // --------------------------- constants ----------------------------
      const h = React.createElement
      const { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } = React

      const NL = String.fromCharCode(10)
      const IDEO_SPACE = String.fromCharCode(12288)
      // The host chunks book-sized sources; the client only stores the text and
      // anchors, so keep the same source ceiling for pasted/attached material.
      const MAX_LEN = 1000000
       const MAX_VERIFY_SCOPE_CHARS = 240000
      const LS_PENDING = 'dsh-kg-pending-v2'
      const LS_RESULT = 'dsh-kg-result-v2'
      const LS_DRAFT = 'dsh-kg-draft-v1'
      const LEGACY_LARGE_STORAGE_KEYS = ['dsh-kg-pending-v1', 'dsh-kg-checkpoint-v1', 'dsh-kg-result-v1']
      const LS_WIN = 'dsh-kg-win-v1'
      const LS_HISTORY = 'dsh-kg-history-v1'
      const LS_SPLIT = 'dsh-kg-split-v1'
      const LS_HEIGHT = 'dsh-kg-height-v1'
      const LS_TRAJ_RESULT = 'dsh-kg-traj-result-v2' // + ':' + sessionId; reference-only
      const LS_TRAJ_RESULT_LEGACY = 'dsh-kg-traj-result-v1' // full graph/text payload from older releases
      const LS_TRAJ_PENDING = 'dsh-kg-traj-pending-v1' // + ':' + sessionId
      const LS_TRAJ_SPLIT = 'dsh-kg-traj-split-v1'
      const LS_TRAJ_HEIGHT = 'dsh-kg-traj-height-v1'
      const HISTORY_MAX = 20
      const LS_LAYOUT = 'dsh-kg-layout-v1'
       const LS_CANDIDATE_REVIEW = 'dsh-kg-candidate-review-v1'
      const LAYER_Y_GAP = 140
      const LAYER_X_GAP = 220
      const LAYER_COL_GAP = 20
      // A single layered row must not stretch much wider than the visible
      // canvas. Wide levels are wrapped into several parallel sub-rows (each
      // still a real row for the orthogonal channel router), so a 15-child
      // "second layer" becomes a few short rows instead of one endless band.
      const LAYER_MAX_ROW_WIDTH = 900
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
        // Fast path: when the four d3 modules are already loaded as plain
        // <script src> files (the Chrome extension ships them under
        // extension/d3/*.js, because MV3 extension pages forbid eval), reuse
        // the global d3 namespace instead of evaluating the embedded sources.
        if (typeof globalThis !== 'undefined' && globalThis.d3 &&
            typeof globalThis.d3.forceSimulation === 'function') {
          return globalThis.d3
        }
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
        claim: { label: '主张', color: '#0f766e', fill: 'rgba(15,118,110,0.15)' },
        inference: { label: '推论', color: '#8b5cf6', fill: 'rgba(139,92,246,0.15)' },
        concept: { label: '概念', color: '#10b981', fill: 'rgba(16,185,129,0.15)' },
        definition: { label: '定义', color: '#f59e0b', fill: 'rgba(245,158,11,0.16)' },
        example: { label: '例子', color: '#06b6d4', fill: 'rgba(6,182,212,0.15)' },
        counter_example: { label: '反例', color: '#ef4444', fill: 'rgba(239,68,68,0.15)' },
        rule: { label: '规则', color: '#7c3aed', fill: 'rgba(124,58,237,0.16)' },
      }
      const REL_LABEL = { supports: '支持', example: '例子', counter_example: '反例', defines: '定义', infers: '推断', causes: '因果', is_a: '属于', contains: '包含', driven_by: '受驱动于', not_is: '不是', analogy: '类比说明', aims_at: '旨在' }
      const REL_SOURCE_RULES = { example: 'example', counter_example: 'counter_example', defines: 'definition' }
      const TYPE_ORDER = ['fact', 'claim', 'inference', 'concept', 'definition', 'example', 'counter_example', 'rule']
       const CANDIDATE_ENTITY_TYPES = new Set(['concept', 'definition'])
       const CANDIDATE_CLAIM_TYPES = new Set(['fact', 'claim', 'inference', 'rule', 'definition', 'counter_example'])
       const REVIEW_STATUS_ORDER = ['candidate', 'accepted', 'rejected']
       const REVIEW_STATUS_LABEL = { candidate: '待审核', accepted: '已接受', rejected: '已驳回' }
       function chapterSectionsOf(graph) {
         const source = graph && graph.source && typeof graph.source === 'object' ? graph.source : null
         return source && Array.isArray(source.sections)
           ? source.sections.filter((section) => section && typeof section.id === 'string')
           : []
       }
       function nodeMatchesChapter(node, section) {
         if (!section) return true
         if (node && typeof node.sectionId === 'string' && node.sectionId === section.id) return true
         const paragraph = Number(node && node.paragraph)
         const start = Number(section.startParagraph)
         const end = Number(section.endParagraph)
         return Number.isInteger(paragraph) && Number.isInteger(start) && Number.isInteger(end) && paragraph >= start && paragraph <= end
       }
       function filterGraphByChapter(graph, sectionId) {
         if (!graph || !sectionId || sectionId === 'all') return graph
         const section = chapterSectionsOf(graph).find((item) => item.id === sectionId)
         if (!section) return graph
         const nodes = (Array.isArray(graph.nodes) ? graph.nodes : []).filter((node) => nodeMatchesChapter(node, section))
         const ids = new Set(nodes.map((node) => node.id))
         return {
           ...graph,
           nodes,
           edges: (Array.isArray(graph.edges) ? graph.edges : []).filter((edge) => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)),
         }
       }
       function reviewKeyFor(graph, node) {
         const source = graph && graph.source && typeof graph.source === 'object' ? graph.source : {}
         const documentId = source.documentId || graph.documentId || source.id || 'local'
         const kind = CANDIDATE_ENTITY_TYPES.has(node && node.type) ? 'entity' : 'claim'
         return documentId + '|' + kind + '|' + String(node && node.id || '')
       }
       function candidateKindFor(node) {
         if (!node || typeof node !== 'object') return null
         if (CANDIDATE_ENTITY_TYPES.has(node.type)) return 'entity'
         if (CANDIDATE_CLAIM_TYPES.has(node.type)) return 'claim'
         return null
       }
       function loadCandidateReviews() {
         try {
           const parsed = JSON.parse(localStorage.getItem(LS_CANDIDATE_REVIEW) || '{}')
           return parsed && typeof parsed === 'object' ? parsed : {}
         } catch (e) { return {} }
       }
       function saveCandidateReviews(value) {
         try { localStorage.setItem(LS_CANDIDATE_REVIEW, JSON.stringify(value || {})) } catch (e) {}
       }
       function candidateEvidenceText(node) {
         if (!node) return ''
         if (typeof node.quote === 'string' && node.quote.trim()) return node.quote.trim()
         const evidence = Array.isArray(node.evidence) ? node.evidence : []
         const first = evidence.find((item) => item && typeof item.quote === 'string' && item.quote.trim())
         return first ? first.quote.trim() : ''
       }
       function candidateGraphPayload(graph) {
         const source = graph && graph.source && typeof graph.source === 'object' ? graph.source : {}
         return {
           source: {
             documentId: source.documentId || graph && graph.documentId || '',
             id: source.id || '',
           },
           nodes: (Array.isArray(graph && graph.nodes) ? graph.nodes : []).map((node) => ({
             id: node.id,
             type: node.type,
             text: node.text,
             quote: node.quote,
             paragraph: node.paragraph,
             evidence: Array.isArray(node.evidence) ? node.evidence : [],
             sectionId: node.sectionId,
             sectionTitle: node.sectionTitle,
             confidence: node.confidence,
           })),
         }
       }
      const SEVERITY_META = {
        error: { label: '错误', cls: 'kg-sev-error' },
        warning: { label: '警告', cls: 'kg-sev-warning' },
        suggestion: { label: '建议', cls: 'kg-sev-suggestion' },
      }
      const SEVERITY_ORDER = ['error', 'warning', 'suggestion']
      const SEVERITY_COLOR = { error: '#dc2626', warning: '#d97706', suggestion: '#2563eb' }
      const ISSUE_CATEGORY_LABEL = {
        grounding: '事实性', type: '类型', relation: '关系', duplicate: '重复',
        contradiction: '矛盾', completeness: '遗漏', summary: '总结', other: '其它',
      }
      const VERDICT_LABEL = {
        supported: '图成立', contradicted: '质疑成立', insufficient: '证据不足', out_of_scope: '超出范围',
      }
      const FACT_VERDICT_META = {
        supported: { label: '支持', color: '#059669', bg: 'rgba(5,150,105,0.08)', border: 'rgba(5,150,105,0.25)' },
        contradicted: { label: '矛盾', color: '#dc2626', bg: 'rgba(220,38,38,0.08)', border: 'rgba(220,38,38,0.25)' },
        partially_supported: { label: '部分支持', color: '#d97706', bg: 'rgba(217,119,6,0.08)', border: 'rgba(217,119,6,0.25)' },
        insufficient: { label: '证据不足', color: '#64748b', bg: 'rgba(100,116,139,0.10)', border: 'rgba(100,116,139,0.25)' },
        unverifiable: { label: '无法核查', color: '#7c3aed', bg: 'rgba(124,58,237,0.08)', border: 'rgba(124,58,237,0.25)' },
        out_of_scope: { label: '超出范围', color: '#475569', bg: 'rgba(100,116,139,0.10)', border: 'rgba(100,116,139,0.25)' },
      }

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

      // Inbox for text selected on the PAGE (chat messages etc.) and turned
      // into a knowledge graph: SelectionTool pushes, WorkbenchBody consumes.
      const selListeners = new Set()
      let selInbox = null
      const selStore = {
        get() { return selInbox },
        push(text) {
          selInbox = { text, seq: (selInbox ? selInbox.seq : 0) + 1 }
          for (const fn of selListeners) fn()
        },
        clear() { selInbox = null; for (const fn of selListeners) fn() },
        subscribe(fn) { selListeners.add(fn); return () => selListeners.delete(fn) },
      }

      // Inbox for "make a knowledge graph from the composer attachments": the
      // button serializes the still-unsent attachment references, then
      // WorkbenchBody consumes their host-side marker and starts extraction.
      const docListeners = new Set()
      let docRequest = null
      const docStore = {
        get() { return docRequest },
        request(sessionId, pendingText) {
          docRequest = { sessionId, pendingText: typeof pendingText === 'string' ? pendingText : '', seq: (docRequest ? docRequest.seq : 0) + 1 }
          for (const fn of docListeners) fn()
          winStore.setOpen(true)
        },
        clear() { docRequest = null; for (const fn of docListeners) fn() },
        subscribe(fn) { docListeners.add(fn); return () => docListeners.delete(fn) },
      }

      // ----------------------------- history -----------------------------
      function normalizeStoredGraph(g) {
        if (!g || typeof g !== 'object') return { nodes: [], edges: [] }
        return {
          ...g,
          nodes: Array.isArray(g.nodes) ? g.nodes : [],
          edges: Array.isArray(g.edges) ? g.edges : [],
        }
      }
      function documentIdOfGraph(graph) {
        const source = graph && graph.source && typeof graph.source === 'object' ? graph.source : {}
        return typeof source.documentId === 'string' && source.documentId ? source.documentId : ''
      }
      function graphViewMetadata(graph) {
        const view = graph && graph.view && typeof graph.view === 'object' ? graph.view : null
        if (!view || !Number.isInteger(view.totalNodes) || !Number.isInteger(view.nodeLimit) || view.nodeLimit <= 0) return null
        const totalNodes = Math.max(0, view.totalNodes)
        const nodeOffset = Number.isInteger(view.nodeOffset) && view.nodeOffset >= 0 ? view.nodeOffset : 0
        const pageCount = Math.max(1, Math.ceil(totalNodes / view.nodeLimit))
        const page = Math.min(pageCount, Math.floor(nodeOffset / view.nodeLimit) + 1)
        const visibleNodes = graph && Array.isArray(graph.nodes) ? graph.nodes.length : 0
        return {
          kind: view.kind === 'query' ? 'query' : 'window',
          query: typeof view.query === 'string' ? view.query : '',
          matchedNodes: Number.isInteger(view.matchedNodes) ? view.matchedNodes : null,
          nodeOffset,
          nodeLimit: view.nodeLimit,
          totalNodes,
          totalEdges: Number.isInteger(view.totalEdges) ? view.totalEdges : (graph && Array.isArray(graph.edges) ? graph.edges.length : 0),
          page,
          pageCount,
          startNode: totalNodes > 0 && visibleNodes > 0 ? nodeOffset + 1 : 0,
          endNode: totalNodes > 0 && visibleNodes > 0 ? Math.min(totalNodes, nodeOffset + visibleNodes) : 0,
          visibleNodes,
          truncated: view.truncated === true,
        }
      }
      function historyMetadata(entry) {
        if (!entry || typeof entry !== 'object') return null
        const graph = entry.graph && typeof entry.graph === 'object' ? entry.graph : null
        const documentId = typeof entry.documentId === 'string' && entry.documentId
          ? entry.documentId
          : documentIdOfGraph(graph)
        if (!documentId) return null
        const nodeCount = Number.isInteger(entry.nodeCount)
          ? entry.nodeCount
          : (graph && graph.view && Number.isInteger(graph.view.totalNodes) ? graph.view.totalNodes : (graph && Array.isArray(graph.nodes) ? graph.nodes.length : 0))
        const edgeCount = Number.isInteger(entry.edgeCount)
          ? entry.edgeCount
          : (graph && graph.view && Number.isInteger(graph.view.totalEdges) ? graph.view.totalEdges : (graph && Array.isArray(graph.edges) ? graph.edges.length : 0))
        return {
          id: typeof entry.id === 'string' && entry.id ? entry.id : 'h-' + Date.now(),
          documentId,
          title: typeof entry.title === 'string' ? entry.title : '',
          summary: typeof entry.summary === 'string' ? entry.summary : (graph && typeof graph.summary === 'string' ? graph.summary : ''),
          nodeCount,
          edgeCount,
          ts: Number.isFinite(entry.ts) ? entry.ts : Date.now(),
        }
      }
      function loadHistory() {
        try {
          const arr = JSON.parse(localStorage.getItem(LS_HISTORY) || 'null')
          if (Array.isArray(arr)) {
            const metadata = arr.map(historyMetadata).filter(Boolean).slice(0, HISTORY_MAX)
            // Upgrade legacy entries in place: old versions embedded full
            // source text and graphs here, which can occupy many MiB forever
            // even after the new reference-only code stops reading them.
            localStorage.setItem(LS_HISTORY, JSON.stringify(metadata))
            return metadata
          }
        } catch (e) {}
        return []
      }
      function saveHistory(list) {
        const metadata = list.map(historyMetadata).filter(Boolean).slice(0, HISTORY_MAX)
        try { localStorage.setItem(LS_HISTORY, JSON.stringify(metadata)) } catch (e) {}
      }
      function appendHistory(list, entry) {
        const meta = historyMetadata(entry)
        if (!meta) return list
        const next = [meta].concat(list.filter((e) => e && e.documentId !== meta.documentId))
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
      function exportFilePart(value, fallback) {
        const text = String(value || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 80)
        return text || fallback
      }
      function csvValue(value) {
        if (value == null) return ''
        let text = typeof value === 'string' ? value : JSON.stringify(value)
        // Source text and LLM output are untrusted. Spreadsheet applications
        // interpret cells beginning with = + - @ as formulas, even after CSV
        // quoting, so neutralize before escaping the CSV field itself.
        if (/^[\t\r ]*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = "'" + text
        return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
      }
      function csvTable(headers, rows) {
        return [headers, ...rows].map((row) => row.map(csvValue).join(',')).join(NL) + NL
      }
      function downloadBrowserBlob(blob, filename, ctx) {
        if (!blob || typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        const revoke = () => { try { URL.revokeObjectURL(url) } catch (e) {} }
        if (ctx && typeof ctx.timeout === 'function') ctx.timeout(revoke, 1200)
        else revoke()
        return true
      }
      function exportGraphFile(graph, title, kind, ctx) {
        if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes)) return null
        const source = graph.source && typeof graph.source === 'object' ? graph.source : {}
        const base = exportFilePart(title || source.title || source.documentId, 'knowledge-graph')
        let filename = base + '.json'
        let content = JSON.stringify(graph, null, 2)
        let mime = 'application/json;charset=utf-8'
        if (kind === 'nodes') {
          filename = base + '-nodes.csv'
          content = '\ufeff' + csvTable(
            ['id', 'type', 'text', 'paragraph', 'quote', 'documentId', 'sourceId', 'chunkId', 'sectionId', 'sectionTitle', 'status', 'confidence', 'evidence', 'provenance'],
            graph.nodes.map((node) => [node.id, node.type, node.text, node.paragraph, node.quote, node.documentId, node.sourceId, node.chunkId, node.sectionId, node.sectionTitle, node.status, node.confidence, node.evidence, node.provenance]),
          )
          mime = 'text/csv;charset=utf-8'
        } else if (kind === 'edges') {
          filename = base + '-edges.csv'
          content = '\ufeff' + csvTable(
            ['id', 'fromNodeId', 'toNodeId', 'relation', 'documentId', 'sourceId', 'chunkId', 'paragraph', 'status', 'confidence', 'evidence', 'provenance'],
            (Array.isArray(graph.edges) ? graph.edges : []).map((edge) => [edge.id, edge.fromNodeId, edge.toNodeId, edge.relation, edge.documentId, edge.sourceId, edge.chunkId, edge.paragraph, edge.status, edge.confidence, edge.evidence, edge.provenance]),
          )
          mime = 'text/csv;charset=utf-8'
        }
        if (typeof Blob === 'undefined' || !downloadBrowserBlob(new Blob([content], { type: mime }), filename, ctx)) return null
        return filename
      }
      function exportRenderedGraphImage(container, title, ctx, exportBBox) {
        return new Promise((resolve, reject) => {
          try {
            if (!container || typeof container.querySelector !== 'function' || typeof XMLSerializer === 'undefined' || typeof Image === 'undefined') {
              resolve(null)
              return
            }
            const svg = container.querySelector('svg')
            if (!svg || typeof svg.cloneNode !== 'function') { resolve(null); return }
            const rect = container.getBoundingClientRect()
            const hasExportBBox = exportBBox && Number.isFinite(exportBBox.w) && Number.isFinite(exportBBox.h) && Number.isFinite(exportBBox.cx) && Number.isFinite(exportBBox.cy)
            const padding = 180
            const width = hasExportBBox ? Math.max(320, Math.ceil(exportBBox.w + padding * 2)) : Math.max(320, Math.round(rect.width || 0))
            const height = hasExportBBox ? Math.max(240, Math.ceil(exportBBox.h + padding * 2)) : Math.max(240, Math.round(rect.height || 0))
            const clone = svg.cloneNode(true)
            const svgNs = 'http://www.w3.org/2000/svg'
            clone.setAttribute('xmlns', svgNs)
            clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
            clone.setAttribute('width', String(width))
            clone.setAttribute('height', String(height))
            clone.setAttribute('viewBox', '0 0 ' + width + ' ' + height)
            if (hasExportBBox) {
              const scene = clone.querySelector('g')
              if (scene) {
                scene.removeAttribute('style')
                scene.setAttribute('transform', 'translate(' + (padding - (exportBBox.cx - exportBBox.w / 2)) + ' ' + (padding - (exportBBox.cy - exportBBox.h / 2)) + ')')
              }
            }
            const computed = typeof getComputedStyle === 'function' ? getComputedStyle(container) : null
            const textColor = computed && computed.getPropertyValue('--kg-text').trim() ? computed.getPropertyValue('--kg-text').trim() : '#1f2937'
            const panelColor = computed && computed.getPropertyValue('--kg-panel').trim() ? computed.getPropertyValue('--kg-panel').trim() : '#ffffff'
            const borderColor = computed && computed.getPropertyValue('--kg-border').trim() ? computed.getPropertyValue('--kg-border').trim() : '#cbd5e1'
            const style = document.createElementNS(svgNs, 'style')
            style.textContent = 'text{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}.kg-node-name{fill:' + textColor + '}.kg-edge-label rect{fill:' + panelColor + ';stroke:' + borderColor + ';stroke-width:1}.kg-edge-label text{fill:' + textColor + ';font-size:10px;font-weight:500}'
            const background = document.createElementNS(svgNs, 'rect')
            background.setAttribute('x', '0')
            background.setAttribute('y', '0')
            background.setAttribute('width', String(width))
            background.setAttribute('height', String(height))
            background.setAttribute('fill', panelColor)
            clone.insertBefore(background, clone.firstChild)
            clone.insertBefore(style, clone.firstChild)
            const svgUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' }))
            const image = new Image()
            image.onload = () => {
              try {
                const scale = 2
                const canvas = document.createElement('canvas')
                canvas.width = width * scale
                canvas.height = height * scale
                const context = canvas.getContext('2d')
                if (!context) throw new Error('当前浏览器不支持 Canvas')
                context.fillStyle = panelColor
                context.fillRect(0, 0, canvas.width, canvas.height)
                context.drawImage(image, 0, 0, canvas.width, canvas.height)
                canvas.toBlob((blob) => {
                  try { URL.revokeObjectURL(svgUrl) } catch (e) {}
                  if (!blob) { reject(new Error('PNG 生成失败')); return }
                  const filename = exportFilePart(title, 'knowledge-graph') + '.png'
                  resolve(downloadBrowserBlob(blob, filename, ctx) ? filename : null)
                }, 'image/png')
              } catch (error) {
                try { URL.revokeObjectURL(svgUrl) } catch (e) {}
                reject(error)
              }
            }
            image.onerror = () => {
              try { URL.revokeObjectURL(svgUrl) } catch (e) {}
              reject(new Error('图像渲染失败'))
            }
            image.src = svgUrl
          } catch (error) {
            reject(error)
          }
        })
      }
      function GraphExportActions({ graph, title, ctx }) {
        const runExport = async (kind) => {
          try {
            let exportGraph = graph
            const documentId = documentIdOfGraph(graph)
            const truncated = graph && graph.view && graph.view.truncated === true
            const canLoadCanonical = typeof host !== 'undefined' && host && typeof host.call === 'function'
            if (truncated && documentId && canLoadCanonical) {
              const loaded = await host.call('document-export', { documentId })
              if (!loaded || loaded.error || !loaded.graph || !Array.isArray(loaded.graph.nodes)) {
                throw new Error(loaded && loaded.error && loaded.error.message ? loaded.error.message : '无法读取完整 canonical graph')
              }
              exportGraph = loaded.graph
            } else if (truncated && documentId) {
              throw new Error('当前是截断工作窗口，请在知识库工作台中导出完整 canonical graph')
            }
            const filename = exportGraphFile(exportGraph, title, kind, ctx)
            if (filename) toastStore.show('已导出 ' + filename)
            else toastStore.show('当前浏览器不支持文件下载')
          } catch (error) {
            toastStore.show('导出失败：' + (error && error.message ? error.message : '未知错误'))
          }
        }
        return h('span', { className: 'kg-export-actions', title: '导出完整知识图，不受章节筛选影响' },
          h('span', { className: 'kg-export-label' }, '导出'),
          h('button', { type: 'button', className: 'kg-secondary', onClick: () => runExport('json'), title: '导出完整知识图 JSON（保留 provenance、验证与审计信息）' }, 'JSON'),
          h('button', { type: 'button', className: 'kg-secondary', onClick: () => runExport('nodes'), title: '导出节点表 CSV' }, '节点 CSV'),
          h('button', { type: 'button', className: 'kg-secondary', onClick: () => runExport('edges'), title: '导出关系表 CSV' }, '关系 CSV'),
        )
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
      // Structure-aware: each blank-line block is classified (heading / list /
      // dialogue / table / code / quote / prose) and split by that structure's
      // rules. MUST match the host's splitParagraphsOffsetsHost exactly.
      const SEG_MAX = 300
      const SEG_SOFT_MAX = 120
      const SEG_SENTENCE_MAX = 180
      const SEG_MIN_TOPIC = 24
      const SEG_TOPIC_SIM = 0.08
      const SENT_END = new Set(['。', '！', '？', '!', '?', '；', ';'])
      const SENT_CLOSER = new Set(['”', '’', '"', "'", '」', '』', '）', ')', '】', '》', '〉'])
      const SEG_SOFT = new Set(['，', '、', '：', ':', ',', '—', '…', ' ', '\t'])
      const SEG_TRANSITIONS = [
        '综上所述', '总而言之', '换句话说', '也就是说', '由此可见', '由此可知', '除此之外',
        '值得注意的是', '需要说明', '需要指出', '问题在于', '关键在于', '事实上', '实际上',
        '另一方面', '与此同时', '举例来说', '例如', '比如', '譬如', '特别是', '尤其是',
        '首先是', '其次', '再次', '最后', '总之', '综上', '因此', '所以', '于是', '因而',
        '故而', '然而', '但是', '不过', '可是', '只是', '相反', '反之', '此外', '另外',
        '而且', '并且', '况且', '再说', '进一步', '然后', '接下来', '接着', '随后',
        '首先', '最后一点',
      ].sort((a, b) => b.length - a.length)

      function hasSentEnd(s) {
        for (let i = 0; i < s.length; i++) if (SENT_END.has(s[i])) return true
        return false
      }
      function startsWithAny(s, prefixes) {
        const t = s.trimStart()
        for (const p of prefixes) if (t.startsWith(p)) return true
        return false
      }
      function lineIndent(line) {
        let i = 0
        while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
        return i
      }
      function listMarker(line) {
        const t = line.trim()
        if (!t) return false
        return /^[-*•·▪◦●○]\s+/.test(t)
          || /^[（(]?\d{1,3}[）).、]\s*/.test(t)
          || /^[一二三四五六七八九十]+[、.．]\s*/.test(t)
          || /^第[一二三四五六七八九十百0-9]+[条章节款]\s*/.test(t)
          || /^[a-zA-Z][.、]\s+/.test(t)
      }
      function dialogLine(line) {
        const t = line.trim()
        if (!t) return false
        if (/^[“"「『]/.test(t)) return true
        return /^[^：:]{0,12}(说|道|问|答|喊|讲)[：:]/.test(t)
      }
      function headingLine(line) {
        const t = line.trim()
        if (!t || t.length > 60 || hasSentEnd(t) || listMarker(t) || dialogLine(t)) return false
        return /^(第[一二三四五六七八九十百0-9]+[章节条款部分]|[一二三四五六七八九十]+[、.．]|\d+(\.\d+)*[、.．]?)\s*/.test(t)
          || !/[，。：；,;:?!？!]/.test(t)
      }
      // Hard sentence boundaries + trailing closing quotes/brackets.
      function atomicRanges(line) {
        const ranges = []
        let start = 0
        let i = 0
        while (i < line.length) {
          if (SENT_END.has(line[i])) {
            let end = i + 1
            while (end < line.length && SENT_CLOSER.has(line[end])) end++
            ranges.push({ start, end })
            start = end
            i = end
          } else {
            i += 1
          }
        }
        if (start < line.length) ranges.push({ start, end: line.length })
        return ranges
      }
      // Split one atomic sentence that still exceeds SEG_SENTENCE_MAX; prefer
      // soft punctuation, hard-cut as a last resort.
      function splitLongSentence(text, absStart, out) {
        let pos = 0
        const floor = Math.floor(SEG_SENTENCE_MAX * 0.55)
        while (text.length - pos > SEG_SENTENCE_MAX) {
          const limit = pos + SEG_SENTENCE_MAX
          let cut = -1
          for (let i = limit; i > pos + floor; i--) {
            if (SEG_SOFT.has(text[i - 1])) { cut = i; break }
          }
          if (cut < 0) cut = limit
          const piece = text.slice(pos, cut)
          if (piece.trim()) out.push({ text: piece, start: absStart + pos, end: absStart + cut })
          pos = cut
        }
        const rest = text.slice(pos)
        if (rest.trim()) out.push({ text: rest, start: absStart + pos, end: absStart + text.length })
      }
      function pushPiece(text, start, end, out) {
        const piece = text.slice(start, end)
        if (piece.trim()) out.push({ text: piece, start, end })
      }
      // Lexical topic signal for ordinary prose: CJK bigrams + latin words.
      function segTokenize(s) {
        const out = []
        let word = ''
        const flush = () => { if (word.length >= 2) { out.push(word); word = '' } }
        for (let i = 0; i < s.length; i++) {
          const c = s[i]
          if (/[A-Za-z0-9]/.test(c)) word += c.toLowerCase()
          else {
            flush()
            if (/[\u4e00-\u9fff]/.test(c)) {
              const next = i + 1 < s.length && /[\u4e00-\u9fff]/.test(s[i + 1])
              const prev = i > 0 && /[\u4e00-\u9fff]/.test(s[i - 1])
              if (next) out.push(c + s[i + 1])
              else if (!prev) out.push(c)
            }
          }
        }
        flush()
        return out
      }
      function topicSimilarity(a, b) {
        const sa = new Set(segTokenize(a))
        const sb = new Set(segTokenize(b))
        if (sa.size === 0 || sb.size === 0) return 0
        let hit = 0
        for (const t of sa) if (sb.has(t)) hit += 1
        return hit / Math.min(sa.size, sb.size)
      }
      function classifyBlock(texts) {
        const n = texts.length
        if (n === 0) return 'prose'
        if (n === 1 && headingLine(texts[0])) return 'heading'
        let dialog = 0
        let list = 0
        let code = 0
        let table = 0
        let quote = 0
        for (const t of texts) {
          if (dialogLine(t)) dialog += 1
          if (listMarker(t)) list += 1
          if (lineIndent(t) >= 2) code += 1
          if (t.indexOf('|') >= 0) table += 1
          if (t.trimStart().startsWith('>')) quote += 1
        }
        if (dialog / n >= 0.5) return 'dialogue'
        if (quote / n >= 0.6) return 'quote'
        if (table / n >= 0.6) return 'table'
        if (code / n >= 0.6) return 'code'
        if (list / n >= 0.6) return 'list'
        return 'prose'
      }
      // One structural line = one unit; over-long lines split at sentence
      // boundaries first (then soft punctuation / hard cap as fallback).
      function appendLineCapped(line, absStart, out) {
        const push = (s, e) => {
          const piece = line.slice(s, e)
          if (piece.trim()) out.push({ text: piece, start: absStart + s, end: absStart + e })
        }
        if (line.length <= SEG_SOFT_MAX) {
          push(0, line.length)
          return
        }
        const ranges = atomicRanges(line)
        let s = null
        let e = null
        const flush = () => {
          if (s != null) { push(s, e); s = null; e = null }
        }
        for (const r of ranges) {
          if (r.end - r.start > SEG_SENTENCE_MAX) {
            flush()
            splitLongSentence(line.slice(r.start, r.end), absStart + r.start, out)
            continue
          }
          if (s == null) { s = r.start; e = r.end }
          else if (r.end - s <= SEG_SOFT_MAX) { e = r.end }
          else { flush(); s = r.start; e = r.end }
        }
        flush()
      }
      // Code lines never get sentence-split; only hard-cap them.
      function appendRawLine(line, absStart, out) {
        if (line.length <= SEG_MAX) {
          if (line.trim()) out.push({ text: line, start: absStart, end: absStart + line.length })
        } else {
          splitLongSentence(line, absStart, out)
        }
      }
      // A quote block stays together while it fits the soft cap, then it
      // splits between whole lines.
      function appendQuoteBlock(lines, text, out) {
        if (lines.length === 0) return
        let s = lines[0].start
        let e = lines[0].end
        for (let i = 1; i < lines.length; i++) {
          const l = lines[i]
          if (l.end - s <= SEG_SOFT_MAX) { e = l.end; continue }
          pushPiece(text, s, e, out)
          s = l.start
          e = l.end
        }
        pushPiece(text, s, e, out)
      }
      // Ordinary prose: group sentences by topic transitions (discourse
      // markers / lexical topic drift), close a unit at a soft length limit,
      // and use the hard cap only as a last resort.
      function groupProseParts(parts, text, out) {
        let s = null
        let e = null
        for (const p of parts) {
          if (s == null) { s = p.start; e = p.end; continue }
          const mergedLen = (e - s) + (p.start - e) + (p.end - p.start)
          let boundary = false
          if (mergedLen > SEG_MAX) {
            boundary = true
          } else if (mergedLen > SEG_SOFT_MAX && e - s >= SEG_MIN_TOPIC) {
            boundary = true
          } else if (e - s >= SEG_MIN_TOPIC) {
            if (startsWithAny(p.text, SEG_TRANSITIONS)) boundary = true
            else if (topicSimilarity(text.slice(s, e), text.slice(p.start, p.end)) < SEG_TOPIC_SIM) boundary = true
          }
          if (boundary) {
            pushPiece(text, s, e, out)
            s = p.start
            e = p.end
          } else {
            e = p.end
          }
        }
        if (s != null) pushPiece(text, s, e, out)
      }

      function splitParagraphs(source) {
        const lines = source.split(NL)
        const blocks = []
        let cur = []
        let lineStart = 0
        for (const line of lines) {
          if (line.trim() === '') {
            if (cur.length > 0) { blocks.push(cur); cur = [] }
            lineStart += line.length + 1
            continue
          }
          cur.push({ text: line, start: lineStart, end: lineStart + line.length })
          lineStart += line.length + 1
        }
        if (cur.length > 0) blocks.push(cur)
        const out = []
        for (const block of blocks) {
          const kind = classifyBlock(block.map((l) => l.text))
          if (kind === 'quote') {
            appendQuoteBlock(block, source, out)
          } else if (kind === 'code') {
            for (const l of block) appendRawLine(l.text, l.start, out)
          } else if (kind === 'list' || kind === 'dialogue' || kind === 'table' || kind === 'heading') {
            for (const l of block) appendLineCapped(l.text, l.start, out)
          } else {
            const parts = []
            for (const l of block) {
              for (const r of atomicRanges(l.text)) {
                splitLongSentence(l.text.slice(r.start, r.end), l.start + r.start, parts)
              }
            }
            groupProseParts(parts, source, out)
          }
        }
        return out
      }

      // Build the view model: anchor every node to a paragraph offset and work
      // out each paragraph's node types (for badges) and node ids (for focus).
      function makeView(graph, sourceText) {
        const paragraphs = splitParagraphs(sourceText)
        const anchors = {}
        const unresolved = []
        const paraTypes = paragraphs.map(() => [])
        const paraNodes = paragraphs.map(() => [])
        // Normalize old / malformed stored data FIRST: missing `edges` (or
        // `nodes`) must degrade to an empty graph, never crash the render.
        if (!graph || typeof graph !== 'object') graph = { nodes: [], edges: [] }
        else graph = {
          ...graph,
          nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
          edges: Array.isArray(graph.edges) ? graph.edges : [],
        }
        // Sanitize edges: drop references to unknown nodes and self-loops.
        // d3-force throws "node not found" on a dangling edge — history data
        // from older sessions can contain them, which crashed the whole page.
        {
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

      // --------------------- verification helpers ---------------------
      const edgeKeyOf = (e) => (e && typeof e.fromNodeId === 'string' && typeof e.toNodeId === 'string') ? e.fromNodeId + '>' + e.toNodeId : ''
      function edgeIndexForIssue(graph, issue) {
        if (!graph || !issue) return null
        const edges = Array.isArray(graph.edges) ? graph.edges : []
        if (issue.targetId == null) return null
        if (/^\d+$/.test(issue.targetId) && Number(issue.targetId) < edges.length) return Number(issue.targetId)
        const key = String(issue.targetId)
        for (let i = 0; i < edges.length; i++) {
          if (edgeKeyOf(edges[i]) === key) return i
        }
        return null
      }
      function issueTargetsOf(report) {
        const nodeMap = new Map()
        const edgeMap = new Map()
        const graphIssues = []
        for (const it of (report && Array.isArray(report.issues) ? report.issues : [])) {
          if (it && it.targetKind === 'node' && it.targetId) {
            if (!nodeMap.has(it.targetId)) nodeMap.set(it.targetId, [])
            nodeMap.get(it.targetId).push(it)
          } else if (it && it.targetKind === 'edge') {
            graphIssues.push(it) // resolved to an index by the viewer via edgeKeyOf
            if (!edgeMap.has(String(it.targetId || ''))) edgeMap.set(String(it.targetId || ''), [])
            edgeMap.get(String(it.targetId || '')).push(it)
          } else if (it) {
            graphIssues.push(it)
          }
        }
        return { nodeMap, edgeMap, graphIssues }
      }
      function withVerification(graph, report, stale) {
        const prev = graph && graph.verification && typeof graph.verification === 'object' ? graph.verification : {}
        return { ...graph, verification: { ...prev, lastReport: report || prev.lastReport || null, stale: stale === true } }
      }
      function withFactCheck(graph, report, stale) {
        const prev = graph && graph.factCheck && typeof graph.factCheck === 'object' ? graph.factCheck : {}
        return { ...graph, factCheck: { ...prev, lastReport: report || prev.lastReport || null, stale: stale === true } }
      }
      function appendAudit(graph, action, targetId, detail, reportId, before, after) {
        const prev = graph && graph.verification && typeof graph.verification === 'object' ? graph.verification : {}
        const log = [...(Array.isArray(prev.auditLog) ? prev.auditLog : []), {
          ts: Date.now(), action, targetId: targetId || null, detail: detail || '', reportId: reportId || null,
          before: before || null, after: after || null,
        }].slice(-60)
        return { ...graph, verification: { ...prev, auditLog: log } }
      }
      function updateIssueStatus(report, issueId, status, userNote) {
        if (!report) return report
        const issues = (report.issues || []).map((it) => it.id === issueId ? { ...it, status, userNote: userNote || it.userNote || '' } : it)
        const counts = { error: 0, warning: 0, suggestion: 0 }
        for (const it of issues) {
          if ((it.status === 'open' || it.status === 'accepted') && counts[it.severity] != null) counts[it.severity] += 1
        }
        const invariantErrorCount = issues.filter((it) => (it.status === 'open' || it.status === 'accepted') && it.blocking === true).length
        const qualityWarningCount = issues.filter((it) => (it.status === 'open' || it.status === 'accepted') && it.blocking !== true && it.severity === 'warning').length
        return {
          ...report,
          issues,
          metrics: {
            ...(report.metrics || {}),
            errorCount: counts.error,
            warningCount: counts.warning,
            suggestionCount: counts.suggestion,
            ...(report.mode === 'quick' ? { invariantErrorCount, qualityWarningCount } : {}),
          },
        }
      }
      // One-click fix: apply every OPEN issue that has an applicable patch, in
      // report order. Each successful patch writes its own audit entry. Issues
      // without a patch (or whose target was already removed by an earlier
      // patch) are counted as skipped and left open for manual review.
      function applyAllFixable(graph, report) {
        let g = graph
        let r = report
        let applied = 0
        let skipped = 0
        for (const issue of (report && Array.isArray(report.issues) ? report.issues : [])) {
          if (!issue || issue.status !== 'open') continue
          const hasFix = issue.proposedFix && issue.proposedFix.action && issue.proposedFix.action !== 'none'
          if (!hasFix) { skipped += 1; continue }
          const next = applyPatch(g, issue)
          if (next !== g) {
            g = next
            r = updateIssueStatus(r, issue.id, 'applied')
            applied += 1
          } else {
            skipped += 1
          }
        }
        return { graph: g, report: r, applied, skipped }
      }
      function newNodeId() {
        const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null
        if (c && typeof c.randomUUID === 'function') return 'node_' + c.randomUUID()
        if (c && typeof c.getRandomValues === 'function') {
          const bytes = new Uint8Array(16)
          c.getRandomValues(bytes)
          return 'node_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
        }
        return 'node_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14)
      }
      const graphSemanticOperations = new WeakMap()
      function cloneNodes(nodes) { return (nodes || []).map((n) => ({ ...n })) }
      function cloneEdges(edges) { return (edges || []).map((e) => ({ ...e })) }
      function semanticOperationsOf(graph) {
        return graph && typeof graph === 'object' && graphSemanticOperations.has(graph)
          ? graphSemanticOperations.get(graph).map((operation) => ({ ...operation }))
          : []
      }
      function carrySemanticOperations(previous, next, operation) {
        if (!next || typeof next !== 'object') return next
        const pending = semanticOperationsOf(previous)
        if (operation) pending.push(operation)
        if (pending.length > 0) graphSemanticOperations.set(next, pending)
        return next
      }
      // Compute human-readable old -> new differences from an audit entry's
      // before/after snapshots. Used by the verification panel's "修复记录"
      // section so every applied fix shows WHAT actually changed.
      function auditDiffLines(before, after, maxLines) {
        const cap = typeof maxLines === 'number' && maxLines > 0 ? maxLines : 5
        if (!before || !after) return { lines: [], more: 0 }
        const lines = []
        const short = (s, n) => { const t = String(s == null ? '' : s).trim(); return t.length > (n || 44) ? t.slice(0, n || 44) + '…' : (t || '（空）') }
        const shortQuote = (s) => { const t = String(s == null ? '' : s).trim(); return t.length > 30 ? t.slice(0, 30) + '…' : (t || '（空）') }
        const bNodes = Array.isArray(before.nodes) ? before.nodes : []
        const aNodes = Array.isArray(after.nodes) ? after.nodes : []
        const bById = new Map(bNodes.map((n) => [n.id, n]))
        const aById = new Map(aNodes.map((n) => [n.id, n]))
        const push = (s) => { if (lines.length < cap) lines.push(s) }
        const nodeIds = new Set([...bById.keys(), ...aById.keys()])
        for (const id of nodeIds) {
          const b = bById.get(id)
          const a = aById.get(id)
          if (b && !a) push('删除节点 ' + id + '（' + short(b.text) + '）')
          else if (!b && a) push('新增节点 ' + id + '（' + short(a.text) + '）')
          else if (b && a) {
            if (String(a.text || '').trim() !== String(b.text || '').trim()) push('节点 ' + id + ' 表述：' + short(b.text, 34) + ' → ' + short(a.text, 34))
            if (a.type !== b.type) push('节点 ' + id + ' 类型：' + ((TYPE_META[b.type] || {}).label || b.type) + ' → ' + ((TYPE_META[a.type] || {}).label || a.type))
            if (Number.isInteger(a.paragraph) && Number.isInteger(b.paragraph) && a.paragraph !== b.paragraph) push('节点 ' + id + ' 段落：P' + (b.paragraph + 1) + ' → P' + (a.paragraph + 1))
            if (String(a.quote || '').trim() !== String(b.quote || '').trim()) push('节点 ' + id + ' 摘录：' + shortQuote(b.quote) + ' → ' + shortQuote(a.quote))
          }
        }
        const edgeCounts = (edges) => {
          const counts = new Map()
          for (const e of (Array.isArray(edges) ? edges : [])) {
            if (!e || typeof e.fromNodeId !== 'string' || typeof e.toNodeId !== 'string') continue
            const key = e.fromNodeId + '>' + e.toNodeId + ':' + e.relation
            counts.set(key, (counts.get(key) || 0) + 1)
          }
          return counts
        }
        const bEdges = edgeCounts(before.edges)
        const aEdges = edgeCounts(after.edges)
        const edgeKeys = new Set([...bEdges.keys(), ...aEdges.keys()])
        for (const key of edgeKeys) {
          const bCount = bEdges.get(key) || 0
          const aCount = aEdges.get(key) || 0
          if (bCount === aCount) continue
          const parts = key.split('>')
          const from = parts[0] || '?'
          const rest = parts[1] || ''
          const relIdx = rest.lastIndexOf(':')
          const to = relIdx >= 0 ? rest.slice(0, relIdx) : rest
          const rel = relIdx >= 0 ? rest.slice(relIdx + 1) : '?'
          const label = REL_LABEL[rel] || rel
          const desc = from + ' → ' + to + '（' + label + '）'
          if (bCount > aCount) push('删除关系 ' + desc)
          else push('新增关系 ' + desc)
        }
        if (String(after.summary || '').trim() !== String(before.summary || '').trim()) {
          push('总结：' + short(before.summary, 30) + ' → ' + short(after.summary, 30))
        }
        const total = lines.length
        return { lines: lines.slice(0, cap), more: total - cap }
      }
      // Build compact before/after snapshots for the audit log: only nodes and
      // edges that actually changed are kept. Storing whole graphs in every
      // audit entry would blow the localStorage quota after a few fixes.
      function compactAuditSnapshots(before, after, maxNodes, maxEdges) {
        const nodeCap = typeof maxNodes === 'number' && maxNodes > 0 ? maxNodes : 6
        const edgeCap = typeof maxEdges === 'number' && maxEdges > 0 ? maxEdges : 12
        const bNodes = Array.isArray(before.nodes) ? before.nodes : []
        const aNodes = Array.isArray(after.nodes) ? after.nodes : []
        const bById = new Map(bNodes.map((n) => [n.id, n]))
        const aById = new Map(aNodes.map((n) => [n.id, n]))
        const sameNode = (a, b) => !b || !a || (a.id === b.id && a.type === b.type && String(a.text || '') === String(b.text || '') && String(a.quote || '') === String(b.quote || '') && a.paragraph === b.paragraph && JSON.stringify(a.evidence || []) === JSON.stringify(b.evidence || []))
        const bOut = []
        const aOut = []
        const ids = new Set([...bById.keys(), ...aById.keys()])
        for (const id of ids) {
          const b = bById.get(id)
          const a = aById.get(id)
          if (sameNode(a, b)) continue
          if (bOut.length < nodeCap) bOut.push(b ? { ...b } : null)
          if (aOut.length < nodeCap) aOut.push(a ? { ...a } : null)
        }
        const edgeSig = (e) => (e && typeof e.fromNodeId === 'string' && typeof e.toNodeId === 'string') ? e.fromNodeId + '>' + e.toNodeId + ':' + e.relation : ''
        const bEdges = (Array.isArray(before.edges) ? before.edges : []).filter((e) => edgeSig(e))
        const aEdges = (Array.isArray(after.edges) ? after.edges : []).filter((e) => edgeSig(e))
        const counts = (arr) => {
          const m = new Map()
          for (const e of arr) {
            const k = edgeSig(e)
            m.set(k, (m.get(k) || 0) + 1)
          }
          return m
        }
        const bc = counts(bEdges)
        const ac = counts(aEdges)
        const keys = new Set([...bc.keys(), ...ac.keys()])
        const bEO = []
        const aEO = []
        for (const k of keys) {
          if ((bc.get(k) || 0) === (ac.get(k) || 0)) continue
          const fromB = bEdges.find((e) => edgeSig(e) === k)
          const fromA = aEdges.find((e) => edgeSig(e) === k)
          if (bEO.length < edgeCap) bEO.push(fromB ? { ...fromB } : null)
          if (aEO.length < edgeCap) aEO.push(fromA ? { ...fromA } : null)
        }
        const summaryChanged = String(after.summary || '') !== String(before.summary || '')
        return {
          before: { nodes: bOut, edges: bEO, ...(summaryChanged ? { summary: before.summary } : {}) },
          after: { nodes: aOut, edges: aEO, ...(summaryChanged ? { summary: after.summary } : {}) },
        }
      }

      function mergeEvidenceRecords(primary, secondary, limit = 8) {
         const out = []
         for (const item of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
           if (!item || typeof item !== 'object' || out.length >= limit) continue
           const key = String(item.documentId || '') + '|' + String(item.sourceId || '') + '|' + String(item.chunkId || '') + '|' + String(item.paragraph) + '|' + String(item.quote || '')
           if (out.some((existing) => String(existing.documentId || '') + '|' + String(existing.sourceId || '') + '|' + String(existing.chunkId || '') + '|' + String(existing.paragraph) + '|' + String(existing.quote || '') === key)) continue
           out.push({ ...item })
         }
         return out
       }
       function mergeNodeProvenance(target, source) {
         if (!target || !source) return target
         const merged = { ...target }
         if ((!merged.quote || !String(merged.quote).trim()) && source.quote) merged.quote = source.quote
         if (merged.paragraph == null && source.paragraph != null) merged.paragraph = source.paragraph
         for (const field of ['documentId', 'sourceId', 'chunkId', 'sectionId', 'sectionTitle']) {
           if (merged[field] == null && source[field] != null) merged[field] = source[field]
         }
         merged.evidence = mergeEvidenceRecords(target.evidence, source.evidence)
         if (merged.evidence.length > 0 || source.groundingStatus === 'grounded') merged.groundingStatus = 'grounded'
         else if (!merged.groundingStatus) merged.groundingStatus = source.groundingStatus || 'candidate'
         if (merged.entailmentStatus !== 'verified') merged.entailmentStatus = source.entailmentStatus || merged.entailmentStatus || 'unverified'
         return merged
       }
       // graph (original untouched). Structural fixes are deterministic; text
      // patches come from the AI and are still a user-confirmed action.
      function applyPatch(graph, issue) {
        const originalGraph = graph
        const fix = issue && issue.proposedFix ? issue.proposedFix : { action: 'none' }
        let semanticOperation = null
        const nodes = cloneNodes(graph.nodes)
        let edges = cloneEdges(graph.edges)
        const ids = new Set(nodes.map((n) => n.id))
        let changed = false
        let auditDetail = ''
        const patchNodeId = (fix.nodePatch && typeof fix.nodePatch.id === 'string' && ids.has(fix.nodePatch.id))
          ? fix.nodePatch.id
          : (issue && issue.targetKind === 'node' && typeof issue.targetId === 'string' && ids.has(issue.targetId) ? issue.targetId : null)
        if (fix.action === 'update_node' && fix.nodePatch && patchNodeId) {
          const n = nodes.find((x) => x.id === patchNodeId)
          const p = fix.nodePatch.patch || {}
          const before = { ...n }
          if (p.type && TYPE_META[p.type]) n.type = p.type
          if (typeof p.text === 'string' && p.text.trim()) n.text = p.text.trim()
          if (typeof p.quote === 'string') n.quote = p.quote.trim()
          const pNum = Number(p.paragraph)
          if (p.paragraph != null && Number.isInteger(pNum) && pNum >= 0) n.paragraph = pNum
          changed = before.type !== n.type || before.text !== n.text || before.quote !== n.quote || before.paragraph !== n.paragraph
          if (changed) auditDetail = 'update_node:' + n.id
        } else if (fix.action === 'delete_node' && fix.nodePatch && (ids.has(fix.nodePatch.id) || patchNodeId)) {
          const id = patchNodeId || fix.nodePatch.id
          edges = edges.filter((e) => e.fromNodeId !== id && e.toNodeId !== id)
          const idx = nodes.findIndex((x) => x.id === id)
          if (idx >= 0) { nodes.splice(idx, 1); changed = true; auditDetail = 'delete_node:' + id }
        } else if (fix.action === 'merge_nodes' && fix.nodePatch && fix.mergeIntoId && ids.has(fix.nodePatch.id) && ids.has(fix.mergeIntoId) && fix.nodePatch.id !== fix.mergeIntoId) {
          const from = fix.nodePatch.id
          const into = fix.mergeIntoId
          const redirected = []
          const byKey = new Map()
          for (const edge of edges) {
            const next = { ...edge, fromNodeId: edge.fromNodeId === from ? into : edge.fromNodeId, toNodeId: edge.toNodeId === from ? into : edge.toNodeId }
            if (next.fromNodeId === next.toNodeId) continue
            const key = next.fromNodeId + '>' + next.toNodeId + ':' + next.relation
            const previous = byKey.get(key)
            if (previous) previous.evidence = mergeEvidenceRecords(previous.evidence, next.evidence)
            else { byKey.set(key, next); redirected.push(next) }
          }
          edges = redirected
          const fromNode = nodes.find((x) => x.id === from)
          const intoIdx = nodes.findIndex((x) => x.id === into)
          if (fromNode && intoIdx >= 0) nodes[intoIdx] = mergeNodeProvenance(nodes[intoIdx], fromNode)
          const idx = nodes.findIndex((x) => x.id === from)
          if (idx >= 0) {
            nodes.splice(idx, 1)
            changed = true
            auditDetail = 'merge_nodes:' + from + '>' + into
            semanticOperation = { kind: 'merge_node', fromNodeId: from, intoNodeId: into }
          }
        } else if ((fix.action === 'update_edge' || fix.action === 'delete_edge' || fix.action === 'add_edge') && fix.edgePatch) {
          const p = fix.edgePatch
          let idx = Number.isInteger(p.index) && p.index >= 0 && p.index < edges.length ? p.index : -1
          if (idx < 0) idx = edges.findIndex((e) => e.fromNodeId === p.fromNodeId && e.toNodeId === p.toNodeId && (!p.relation || e.relation === p.relation))
          if (fix.action === 'update_edge' && idx >= 0) {
            if (p.relation && REL_LABEL[p.relation] && Array.isArray(p.evidence) && p.evidence.length > 0) {
              edges[idx] = { ...edges[idx], relation: p.relation, evidence: mergeEvidenceRecords([], p.evidence) }
              changed = true
              auditDetail = 'update_edge:' + edgeKeyOf(edges[idx])
            }
          } else if (fix.action === 'delete_edge' && idx >= 0) {
            const key = edgeKeyOf(edges[idx])
            edges.splice(idx, 1)
            changed = true
            auditDetail = 'delete_edge:' + key
          } else if (fix.action === 'add_edge' && ids.has(p.fromNodeId) && ids.has(p.toNodeId) && p.fromNodeId !== p.toNodeId && p.relation && REL_LABEL[p.relation] && Array.isArray(p.evidence) && p.evidence.length > 0) {
            const dup = edges.some((e) => e.fromNodeId === p.fromNodeId && e.toNodeId === p.toNodeId && e.relation === p.relation)
            if (!dup) {
              edges.push({ fromNodeId: p.fromNodeId, toNodeId: p.toNodeId, relation: p.relation, evidence: mergeEvidenceRecords([], p.evidence) })
              changed = true
              auditDetail = 'add_edge:' + p.fromNodeId + '>' + p.toNodeId
            }
          }
        } else if (fix.action === 'add_node' && fix.nodePatch) {
          const p = fix.nodePatch.patch || {}
          // A browser window never has enough information to allocate the next
          // sequential canonical id. UUID identity is collision-safe across
          // invisible windows; Host/SQLite still reject any unexpected clash.
          const id = newNodeId()
          if (p.type && TYPE_META[p.type] && typeof p.text === 'string' && p.text.trim()) {
            nodes.push({ id, type: p.type, text: p.text.trim(), quote: typeof p.quote === 'string' ? p.quote.trim() : '', paragraph: Number.isInteger(p.paragraph) ? p.paragraph : null })
            changed = true
            auditDetail = 'add_node:' + id
          }
        } else if (fix.action === 'update_summary' && fix.summaryPatch) {
          const prev = graph.summary
          graph = { ...graph, summary: fix.summaryPatch }
          changed = true
          auditDetail = 'update_summary'
          if (prev === graph.summary) changed = false
        }
        if (!changed) return graph
        let next = { ...graph, nodes, edges }
        const compact = compactAuditSnapshots(graph, next, 6, 12)
        next = appendAudit(next, fix.action, issue.targetId || null, auditDetail, issue.reportId || null,
          compact.before, compact.after)
        return carrySemanticOperations(originalGraph, next, semanticOperation)
      }
      // A patch may be a no-op because the target was already fixed elsewhere
      // (e.g. the paragraph was corrected by an earlier action, or the graph
      // was re-verified). Distinguish "already satisfied" from "cannot apply".
      function patchAlreadySatisfied(graph, issue) {
        const fix = issue && issue.proposedFix ? issue.proposedFix : null
        if (!fix || !graph) return false
        const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
        const edges = Array.isArray(graph.edges) ? graph.edges : []
        if (fix.action === 'update_node' && fix.nodePatch) {
          const id = fix.nodePatch.id || (issue.targetKind === 'node' ? issue.targetId : null)
          const n = nodes.find((x) => x.id === id)
          const p = fix.nodePatch.patch || {}
          if (!n) return false
          let hasField = false
          let ok = true
          if (p.type != null) { hasField = true; ok = ok && n.type === p.type }
          if (typeof p.text === 'string') { hasField = true; ok = ok && String(n.text || '').trim() === p.text.trim() }
          if (typeof p.quote === 'string') { hasField = true; ok = ok && String(n.quote || '').trim() === p.quote.trim() }
          if (p.paragraph != null) { hasField = true; ok = ok && Number(n.paragraph) === Number(p.paragraph) }
          return hasField && ok
        }
        if ((fix.action === 'delete_node' || fix.action === 'merge_nodes') && fix.nodePatch) {
          const id = fix.nodePatch.id || (issue.targetKind === 'node' ? issue.targetId : null)
          return !nodes.some((x) => x.id === id)
        }
        if (fix.action === 'delete_edge' && fix.edgePatch) {
          return !edges.some((e) => e.fromNodeId === fix.edgePatch.fromNodeId && e.toNodeId === fix.edgePatch.toNodeId && (!fix.edgePatch.relation || e.relation === fix.edgePatch.relation))
        }
        if (fix.action === 'update_edge' && fix.edgePatch) {
          const target = edges.find((e) => e.fromNodeId === fix.edgePatch.fromNodeId && e.toNodeId === fix.edgePatch.toNodeId)
          return !target || (fix.edgePatch.relation ? target.relation === fix.edgePatch.relation : true)
        }
        return false
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
      function computeNodeSizes(nodes, edges) {
        const canvas = document.createElement('canvas')
        const g = canvas.getContext('2d')
        g.font = '600 13px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
        const degree = new Map(nodes.map((node) => [node.id, 0]))
        for (const edge of edges || []) {
          if (degree.has(edge.fromNodeId)) degree.set(edge.fromNodeId, degree.get(edge.fromNodeId) + 1)
          if (degree.has(edge.toNodeId)) degree.set(edge.toNodeId, degree.get(edge.toNodeId) + 1)
        }
        const out = new Map()
        for (const node of nodes) {
          const meta = TYPE_META[node.type] || { label: '未知' }
          const labelW = g.measureText(meta.label).width
          const WRAP_W = 162
          const lines = wrapText(g, node.text, WRAP_W)
          let textW = labelW
          for (const ln of lines) textW = Math.max(textW, g.measureText(ln).width)
          const hubBoost = Math.min(18, Math.max(0, (degree.get(node.id) || 0) - 2) * 4)
          out.set(node.id, { w: clamp(textW + 34 + hubBoost, 96, 218), h: 20 * lines.length + 40 + (hubBoost > 0 ? 4 : 0), lines })
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
                const minDist = half + 30 + extra
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
        const geometry = bezierGeometry(a, b, sa, sb, fanRankOf(edge))
        return [[geometry.x1, geometry.y1, geometry.cx, geometry.cy], [geometry.cx, geometry.cy, geometry.x2, geometry.y2]]
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
        const simDegree = new Map(simNodes.map((node) => [node.id, 0]))
        for (const link of simLinks) {
          simDegree.set(link.source, (simDegree.get(link.source) || 0) + 1)
          simDegree.set(link.target, (simDegree.get(link.target) || 0) + 1)
        }
        const linkDistance = (l) => {
          const src = typeof l.source === 'object' ? l.source.id : l.source
          const tgt = typeof l.target === 'object' ? l.target.id : l.target
          const s1 = sizes.get(src)
          const s2 = sizes.get(tgt)
          return ((s1 ? s1.w : 120) + (s2 ? s2.w : 120)) / 2 + 52
        }
        const simulation = F.forceSimulation(simNodes)
          .force('link', F.forceLink(simLinks).id((d) => d.id).distance(linkDistance).strength(0.72))
          .force('charge', F.forceManyBody().strength((d) => (simDegree.get(d.id) || 0) === 0 ? -70 : -280))
          .force('collide', F.forceCollide((d) => {
            const s = sizes.get(d.id)
            if (!s) return 52
            // A circle based on max(width,height) makes wide text boxes repel
            // as though they were huge squares. Use an area-based seed radius;
            // the rectangle-aware deterministic post-pass handles exact boxes.
            return Math.sqrt(s.w * s.h) * 0.5 + 10
          }).iterations(3))
          .force('x', F.forceX(0).strength(0.055))
          .force('y', F.forceY(0).strength(0.055))
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
                if (d < 0.5) {
                  const angle = (((i + 1) * 97 + (j + 1) * 53) % 360) * Math.PI / 180
                  dx = Math.cos(angle)
                  dy = Math.sin(angle)
                  d = 1
                }
                const ux = dx / d
                const uy = dy / d
                const need = intersectDist(sa, ux, uy) + intersectDist(sb, ux, uy) + 14
                if (d >= need) continue
                const push = (need - d) / 2
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
        // Force simulation has no attractive force between disconnected
        // components. Pack their already-resolved bounding boxes into a compact,
        // deterministic shelf so isolated nodes do not fly to the canvas edge.
        packDisconnectedComponents(nodes, edges, sizes, pos, 38)
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
        // Radius sized by the ACTUAL node widths: circumference must fit
        // every node side by side plus a gap, otherwise the overlap pass
        // would deform the circle.
        let totalW = 0
        for (const nd of nodes) totalW += sizes.get(nd.id) ? sizes.get(nd.id).w : arc
        const radius = Math.max((totalW + n * 24) / (2 * Math.PI), 300)
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
          // Radius from the ring's ACTUAL node widths (circumference must fit
          // every node plus a gap), so rings never overlap and stay circular.
          let sumW = 0
          for (const id of list) sumW += sizes.get(id) ? sizes.get(id).w : 150
          const need = (sumW + list.length * 24) / (2 * Math.PI)
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
        if (n === 0) return pos
        if (n === 1) { pos.set(nodes[0].id, { x: 0, y: 0 }); return pos }
        const deg = new Map()
        for (const node of nodes) deg.set(node.id, 0)
        for (const e of edges) {
          if (deg.has(e.fromNodeId)) deg.set(e.fromNodeId, deg.get(e.fromNodeId) + 1)
          if (deg.has(e.toNodeId)) deg.set(e.toNodeId, deg.get(e.toNodeId) + 1)
        }
        const adj = new Map()
        for (const node of nodes) adj.set(node.id, [])
        for (const e of edges) {
          const fa = adj.get(e.fromNodeId)
          const tb = adj.get(e.toNodeId)
          if (fa && tb) { fa.push(e.toNodeId); tb.push(e.fromNodeId) }
        }
        // Relation-aware ranking. A causal/inference chain is the visual
        // backbone; examples/analogies/definitions become nearby branches.
        // Components without such a chain keep the old deterministic BFS
        // behaviour, so this is a projection change rather than a graph-model
        // change.
        const reasoningRelations = new Set(['causes', 'infers'])
        const satelliteRelations = new Set(['example', 'counter_example', 'analogy', 'defines', 'is_a', 'contains'])
        const directionalRelations = new Set(['supports', 'driven_by', 'aims_at'])
        // View-only reasoning lanes: a real multi-step causes/infers path may
        // align vertically, but lane identity never enters the canonical graph.
        const backbonePaths = []
        const level = new Map()
        const componentSeen = new Set()
        for (const start of nodes) {
          if (componentSeen.has(start.id)) continue
          const component = []
          const queue = [start.id]
          componentSeen.add(start.id)
          while (queue.length > 0) {
            const id = queue.shift()
            component.push(id)
            for (const nb of adj.get(id) || []) {
              if (componentSeen.has(nb)) continue
              componentSeen.add(nb)
              queue.push(nb)
            }
          }
          const componentSet = new Set(component)
          const componentEdges = edges.filter((edge) => edge && componentSet.has(edge.fromNodeId) && componentSet.has(edge.toNodeId))
          const reasoningEdges = componentEdges.filter((edge) => reasoningRelations.has(edge.relation))
          const local = new Map()
          if (reasoningEdges.length >= 2) {
            const reasonIds = new Set()
            const indegree = new Map()
            const outgoing = new Map()
            for (const edge of reasoningEdges) {
              reasonIds.add(edge.fromNodeId); reasonIds.add(edge.toNodeId)
            }
            for (const id of reasonIds) { indegree.set(id, 0); outgoing.set(id, []) }
            for (const edge of reasoningEdges) {
              indegree.set(edge.toNodeId, indegree.get(edge.toNodeId) + 1)
              outgoing.get(edge.fromNodeId).push(edge.toNodeId)
            }
            const topo = component.filter((id) => reasonIds.has(id) && indegree.get(id) === 0)
            const roots = topo.slice()
            const topoOrder = []
            for (const id of topo) local.set(id, 0)
            let processed = 0
            while (topo.length > 0) {
              const id = topo.shift()
              topoOrder.push(id)
              processed += 1
              const base = local.get(id) || 0
              for (const to of outgoing.get(id) || []) {
                local.set(to, Math.max(local.get(to) || 0, base + 1))
                indegree.set(to, indegree.get(to) - 1)
                if (indegree.get(to) === 0) topo.push(to)
              }
            }
            if (processed !== reasonIds.size) {
              local.clear()
            } else {
              // Pick only substantial reasoning backbones (>= 3 nodes). This
              // is deterministic longest-path selection inside the already
              // accepted causes/infers DAG, not semantic clustering.
              const remainingDepth = new Map()
              for (let orderIndex = topoOrder.length - 1; orderIndex >= 0; orderIndex--) {
                const id = topoOrder[orderIndex]
                let depth = 0
                for (const to of outgoing.get(id) || []) depth = Math.max(depth, 1 + (remainingDepth.get(to) || 0))
                remainingDepth.set(id, depth)
              }
              const used = new Set()
              roots.sort((a, b) => (remainingDepth.get(b) || 0) - (remainingDepth.get(a) || 0) || String(a).localeCompare(String(b)))
              for (const root of roots) {
                if (used.has(root)) continue
                const path = []
                let cursor = root
                while (cursor && !used.has(cursor)) {
                  path.push(cursor)
                  used.add(cursor)
                  const next = (outgoing.get(cursor) || [])
                    .filter((to) => !used.has(to))
                    .sort((a, b) => (remainingDepth.get(b) || 0) - (remainingDepth.get(a) || 0) || String(a).localeCompare(String(b)))[0]
                  cursor = next || null
                }
                if (path.length >= 3) backbonePaths.push(path)
              }
            }
          }
          if (local.size === 0) {
            let hub = nodes.find((node) => node.id === component[0])
            for (const id of component) {
              const node = nodes.find((candidate) => candidate.id === id)
              if (node && deg.get(node.id) > deg.get(hub.id)) hub = node
            }
            const bfs = [hub.id]
            local.set(hub.id, 0)
            while (bfs.length > 0) {
              const id = bfs.shift()
              for (const nb of adj.get(id) || []) {
                if (!componentSet.has(nb) || local.has(nb)) continue
                local.set(nb, local.get(id) + 1)
                bfs.push(nb)
              }
            }
          } else {
            for (let pass = 0; pass < component.length; pass++) {
              let changed = false
              for (const edge of componentEdges) {
                const fromLevel = local.get(edge.fromNodeId)
                const toLevel = local.get(edge.toNodeId)
                if (fromLevel == null && toLevel != null) {
                  local.set(edge.fromNodeId, satelliteRelations.has(edge.relation) || directionalRelations.has(edge.relation) ? Math.max(0, toLevel - 1) : toLevel + 1)
                  changed = true
                } else if (fromLevel != null && toLevel == null) {
                  local.set(edge.toNodeId, fromLevel + 1)
                  changed = true
                }
              }
              if (!changed) break
            }
            for (let pass = 0; pass < component.length; pass++) {
              let changed = false
              for (const id of component) {
                if (local.has(id)) continue
                const ranked = (adj.get(id) || []).find((nb) => local.has(nb))
                if (ranked) { local.set(id, local.get(ranked) + 1); changed = true }
              }
              if (!changed) break
            }
            const tail = local.size > 0 ? Math.max(...local.values()) + 1 : 1
            for (const id of component) if (!local.has(id)) local.set(id, tail)
          }
          for (const [id, rank] of local) level.set(id, rank)
        }
        const groups = new Map()
        for (const node of nodes) {
          const l = level.get(node.id) == null ? 1 : level.get(node.id)
          if (!groups.has(l)) groups.set(l, [])
          groups.get(l).push(node)
        }
        // Wrap a wide level into several sub-rows, each centered on x=0 and
        // placed on its own y-row so the orthogonal edge channels still work.
        const chunkLayer = (list) => {
          const chunks = []
          let cur = []
          let curWidth = 0
          for (const node of list) {
            const s = sizes.get(node.id)
            const w = s ? s.w : 200
            if (cur.length > 0 && curWidth + LAYER_COL_GAP + w > LAYER_MAX_ROW_WIDTH) {
              chunks.push(cur)
              cur = [node]
              curWidth = w
            } else {
              if (cur.length > 0) curWidth += LAYER_COL_GAP
              cur.push(node)
              curWidth += w
            }
          }
          if (cur.length > 0) chunks.push(cur)
          return chunks
        }
        const levels = Array.from(groups.keys()).sort((a, b) => a - b)
        for (const l of levels) groups.get(l).sort((a, b) => deg.get(b.id) - deg.get(a.id))

        const placeLevels = () => {
          pos.clear()
          let row = 0
          for (const l of levels) {
            const list = groups.get(l)
            const chunks = chunkLayer(list)
            // All sub-rows of one level share the same column grid (the widest
            // node per column), so a node in sub-row 2 sits exactly below the
            // same column as its sibling in sub-row 1 — related nodes stay
            // close even when their level wraps.
            const maxCols = chunks.reduce((m, c) => Math.max(m, c.length), 0)
            const colW = new Array(maxCols).fill(0)
            for (const chunk of chunks) {
              chunk.forEach((node, i) => {
                const s = sizes.get(node.id)
                colW[i] = Math.max(colW[i], s ? s.w : 200)
              })
            }
            const centers = new Array(maxCols).fill(0)
            for (let i = 1; i < maxCols; i++) {
              centers[i] = centers[i - 1] + (colW[i - 1] + colW[i]) / 2 + LAYER_COL_GAP
            }
            const mid = (centers[0] + centers[maxCols - 1]) / 2
            for (let i = 0; i < maxCols; i++) centers[i] -= mid
            for (const chunk of chunks) {
              for (let i = 0; i < chunk.length; i++) {
                const node = chunk[i]
                pos.set(node.id, { x: centers[i], y: row * LAYER_Y_GAP })
              }
              row += 1
            }
          }
          return pos
        }

        // Sugiyama-style crossing reduction: order every layer by the average
        // x of its neighbours in the adjacent layer, sweeping top-down
        // (parents) and bottom-up (children) until related nodes sit next to
        // each other instead of staying in arbitrary input order. Ordering
        // sweeps use ONE virtual row per level (no wrapping), so sub-row
        // recentering cannot make the sweep oscillate; wrapping happens only
        // for the final coordinates.
        const placeVirtual = () => {
          pos.clear()
          for (const l of levels) {
            const list = groups.get(l)
            const totalW = (list.length - 1) * LAYER_X_GAP
            list.forEach((node, i) => {
              pos.set(node.id, { x: i * LAYER_X_GAP - totalW / 2, y: l * LAYER_Y_GAP })
            })
          }
          return pos
        }
        const sortByNeighbours = (list, filter) => {
          const idx = new Map(list.map((node, i) => [node.id, i]))
          const meanOf = (node) => {
            const id = node.id
            let sum = 0
            let cnt = 0
            for (const nb of adj.get(id) || []) {
              if (!filter(level.get(nb))) continue
              const p = pos.get(nb)
              if (p) { sum += p.x; cnt += 1 }
            }
            return cnt > 0 ? sum / cnt : Infinity
          }
          list.sort((a, b) => {
            const ma = meanOf(a)
            const mb = meanOf(b)
            if (ma !== mb) return ma - mb
            return idx.get(a.id) - idx.get(b.id)
          })
        }

        placeVirtual()
        for (let pass = 0; pass < 3; pass++) {
          // top-down: align each node under its parents
          for (let li = 1; li < levels.length; li++) {
            const l = levels[li]
            sortByNeighbours(groups.get(l), (nl) => nl < l)
          }
          placeVirtual()
          // bottom-up: align each node above its children
          for (let li = levels.length - 2; li >= 0; li--) {
            const l = levels[li]
            sortByNeighbours(groups.get(l), (nl) => nl > l)
          }
          placeVirtual()
        }
        const placed = placeLevels()
        if (backbonePaths.length === 0) return placed

        // Keep every substantial reasoning backbone in a stable vertical lane.
        // Shift an entire visual row rather than one node, preserving the row
        // geometry and the existing orthogonal edge-router assumptions.
        const backboneLane = new Map()
        const laneGap = Math.max(LAYER_X_GAP * 2, 360)
        const laneMid = (backbonePaths.length - 1) / 2
        backbonePaths.forEach((path, laneIndex) => {
          const laneX = (laneIndex - laneMid) * laneGap
          for (const id of path) backboneLane.set(id, laneX)
        })
        const rowIds = new Map()
        for (const node of nodes) {
          const p = placed.get(node.id)
          if (!p) continue
          const list = rowIds.get(p.y) || []
          list.push(node.id)
          rowIds.set(p.y, list)
        }
        for (const ids of rowIds.values()) {
          const anchors = ids.filter((id) => backboneLane.has(id))
          if (anchors.length === 0) continue
          const shift = anchors.reduce((sum, id) => {
            const p = placed.get(id)
            return sum + backboneLane.get(id) - p.x
          }, 0) / anchors.length
          for (const id of ids) placed.get(id).x += shift
        }

        // Examples/analogies/definitions/concept branches stay next to the
        // backbone node they explain. They remain ordinary graph nodes; this is
        // only a view projection and resolveLayeredOverlaps handles collisions.
        const branchRelations = new Set(['example', 'counter_example', 'analogy', 'defines', 'is_a', 'contains'])
        const branchCount = new Map()
        for (const edge of edges) {
          if (!edge || !branchRelations.has(edge.relation)) continue
          const fromIsBackbone = backboneLane.has(edge.fromNodeId)
          const toIsBackbone = backboneLane.has(edge.toNodeId)
          if (fromIsBackbone === toIsBackbone) continue
          const targetId = fromIsBackbone ? edge.fromNodeId : edge.toNodeId
          const branchId = fromIsBackbone ? edge.toNodeId : edge.fromNodeId
          const target = placed.get(targetId)
          const branch = placed.get(branchId)
          if (!target || !branch) continue
          const count = branchCount.get(targetId) || 0
          const side = count % 2 === 0 ? -1 : 1
          const ring = Math.floor(count / 2) + 1
          const targetSize = sizes.get(targetId)
          const branchSize = sizes.get(branchId)
          const distance = Math.max(
            LAYER_X_GAP * 0.72,
            ((targetSize ? targetSize.w : 170) + (branchSize ? branchSize.w : 170)) / 2 + 24,
          )
          branch.x = target.x + side * distance * ring
          branchCount.set(targetId, count + 1)
        }
        return placed
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
              if (dx === 0) s = ((i + j) % 2 === 0 ? -1 : 1)
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

      function packDisconnectedComponents(nodes, edges, sizes, pos, gap) {
        if (!Array.isArray(nodes) || nodes.length < 2) return pos
        const order = new Map(nodes.map((node, index) => [node.id, index]))
        const ids = new Set(nodes.map((node) => node.id))
        const adj = new Map(nodes.map((node) => [node.id, new Set()]))
        for (const edge of edges || []) {
          if (!edge || !ids.has(edge.fromNodeId) || !ids.has(edge.toNodeId) || edge.fromNodeId === edge.toNodeId) continue
          adj.get(edge.fromNodeId).add(edge.toNodeId)
          adj.get(edge.toNodeId).add(edge.fromNodeId)
        }
        const seen = new Set()
        const components = []
        for (const node of nodes) {
          if (seen.has(node.id)) continue
          const component = []
          const queue = [node.id]
          seen.add(node.id)
          while (queue.length > 0) {
            const id = queue.shift()
            component.push(id)
            for (const neighbor of adj.get(id) || []) {
              if (seen.has(neighbor)) continue
              seen.add(neighbor)
              queue.push(neighbor)
            }
          }
          components.push(component)
        }
        if (components.length <= 1) return pos
        const boxes = components.map((component) => {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
          for (const id of component) {
            const p = pos.get(id)
            const s = sizes.get(id)
            if (!p || !s) continue
            x0 = Math.min(x0, p.x - s.w / 2)
            y0 = Math.min(y0, p.y - s.h / 2)
            x1 = Math.max(x1, p.x + s.w / 2)
            y1 = Math.max(y1, p.y + s.h / 2)
          }
          if (!isFinite(x0)) x0 = y0 = x1 = y1 = 0
          return {
            ids: component,
            x0, y0,
            w: Math.max(x1 - x0, 1),
            h: Math.max(y1 - y0, 1),
            order: Math.min(...component.map((id) => order.get(id) || 0)),
          }
        }).sort((a, b) => (b.w * b.h) - (a.w * a.h) || a.order - b.order)
        const totalArea = boxes.reduce((sum, box) => sum + (box.w + gap) * (box.h + gap), 0)
        const widest = boxes.reduce((max, box) => Math.max(max, box.w), 0)
        const targetWidth = Math.max(widest, Math.sqrt(totalArea) * 1.2)
        let cursorX = 0
        let cursorY = 0
        let rowHeight = 0
        let packedWidth = 0
        for (const box of boxes) {
          if (cursorX > 0 && cursorX + box.w > targetWidth) {
            cursorX = 0
            cursorY += rowHeight + gap
            rowHeight = 0
          }
          box.px = cursorX
          box.py = cursorY
          cursorX += box.w + gap
          rowHeight = Math.max(rowHeight, box.h)
          packedWidth = Math.max(packedWidth, cursorX - gap)
        }
        const packedHeight = cursorY + rowHeight
        const shiftX = -packedWidth / 2
        const shiftY = -packedHeight / 2
        for (const box of boxes) {
          const dx = shiftX + box.px - box.x0
          const dy = shiftY + box.py - box.y0
          for (const id of box.ids) {
            const p = pos.get(id)
            if (!p) continue
            p.x += dx
            p.y += dy
          }
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
              if (d < 0.5) {
                const angle = (((i + 1) * 97 + (j + 1) * 53) % 360) * Math.PI / 180
                dx = Math.cos(angle)
                dy = Math.sin(angle)
                d = 1
              }
              const ux = dx / d
              const uy = dy / d
              const need = intersectDist(sa, ux, uy) + intersectDist(sb, ux, uy) + gap
              if (d >= need) continue
              const push = (need - d) / 2
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

      // Angle-only overlap resolution for CIRCLE / RING shapes: every node
      // keeps its radius (distance from the hub), and overlapping neighbours
      // are pushed apart along the angle axis only. This preserves the
      // circular / radial geometry — the 2D center-line push would deform the
      // ring into a wobbly blob.
      function resolveAngleOverlaps(nodes, sizes, pos, gap) {
        const n = nodes.length
        if (n < 2) return pos
        const ids = nodes.map((x) => x.id)
        for (let iter = 0; iter < 160; iter++) {
          let moved = 0
          for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
              const a = pos.get(ids[i])
              const b = pos.get(ids[j])
              const sa = sizes.get(ids[i])
              const sb = sizes.get(ids[j])
              if (!sa || !sb) continue
              const ra = Math.hypot(a.x, a.y)
              const rb = Math.hypot(b.x, b.y)
              if (ra < 1 || rb < 1) continue // hub / center nodes stay put
              // Only same-ring pairs (radial rings / one circle) are spread;
              // cross-ring pairs are separated by the ring gap already.
              if (Math.abs(ra - rb) > (sa.h + sb.h) / 2 + 8) continue
              const d = Math.hypot(a.x - b.x, a.y - b.y)
              const need = (sa.w + sb.w) / 2 + gap
              if (d >= need) continue
              const r = Math.max((ra + rb) / 2, 1)
              const angA = Math.atan2(a.y, a.x)
              const angB = Math.atan2(b.y, b.x)
              let diff = angB - angA
              while (diff > Math.PI) diff -= 2 * Math.PI
              while (diff < -Math.PI) diff += 2 * Math.PI
              const sepNeed = Math.min(need / r, Math.PI)
              const increase = Math.max(sepNeed - Math.abs(diff), 0.02)
              const da = increase / 2
              const na = angA - da
              const nb = angB + da
              a.x = Math.cos(na) * ra
              a.y = Math.sin(na) * ra
              b.x = Math.cos(nb) * rb
              b.y = Math.sin(nb) * rb
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
        // Lane offsets separate parallel edges, but the entry/exit x must
        // stay ON the node's border span: with many siblings (n up to ~17)
        // the offset (lane*12, lane up to (n-1)/2) can exceed the node
        // half-width, leaving the arrow floating BESIDE the node. Clamp to
        // within the border (8px margin keeps the arrowhead clear of the
        // rounded corner).
        const w1 = s1 ? Math.max(s1.w / 2 - 8, 8) : 40
        const w2 = s2 ? Math.max(s2.w / 2 - 8, 8) : 40
        const ax = clamp(a.x + offX, a.x - w1, a.x + w1)
        const bx = clamp(b.x + offX, b.x - w2, b.x + w2)
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
          const d = 'M ' + ax + ' ' + y0 + ' L ' + ax + ' ' + cye
            + ' L ' + bx + ' ' + cye + ' L ' + bx + ' ' + y1
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
        const d = 'M ' + ax + ' ' + y0 + ' L ' + ax + ' ' + ch1e
          + ' L ' + xce + ' ' + ch1e + ' L ' + xce + ' ' + ch2e
          + ' L ' + bx + ' ' + ch2e + ' L ' + bx + ' ' + y1
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
          // Angle-only overlap pass keeps the circle a circle; the 2D push /
          // edge repulsion used to deform the ring into a wobbly blob.
          return { pos: resolveAngleOverlaps(nodes, sizes, pos, 14) }
        }
        if (mode === 'radial') {
          const pos = layoutRadial(nodes, edges, sizes)
          // Radial relies on angle dodging + the outside-the-rings arc, NOT on
          // the node repulsion: pushing ring nodes off spokes destroys the
          // ring structure itself (chain distortion across every ring).
          return { pos: resolveAngleOverlaps(nodes, sizes, pos, 18) }
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
      function bezierGeometry(a, b, sa, sb, rawBend) {
        const dx = b.x - a.x
        const dy = b.y - a.y
        const len = Math.max(Math.hypot(dx, dy), 0.001)
        const ux = dx / len
        const uy = dy / len
        const directA = intersectDist(sa, ux, uy)
        const directB = intersectDist(sb, ux, uy)
        const baseX1 = a.x + ux * directA
        const baseY1 = a.y + uy * directA
        const baseX2 = b.x - ux * directB
        const baseY2 = b.y - uy * directB
        const baseLen = Math.max(Math.hypot(baseX2 - baseX1, baseY2 - baseY1), 0.001)
        const bend = rawBend === 0 ? 0 : clamp(clamp(rawBend * 26, -104, 104), -baseLen * 0.35, baseLen * 0.35)
        const mx = (baseX1 + baseX2) / 2
        const my = (baseY1 + baseY2) / 2
        const cx = mx - uy * bend
        const cy = my + ux * bend
        // Clip along the actual quadratic tangents, not the center-to-center
        // line. This keeps both path endpoints exactly on the rectangle border
        // even for strongly fanned curves, without a visible 12px gap.
        let sdx = cx - a.x
        let sdy = cy - a.y
        let slen = Math.hypot(sdx, sdy)
        if (slen < 0.001) { sdx = ux; sdy = uy; slen = 1 }
        const sux = sdx / slen
        const suy = sdy / slen
        let tdx = cx - b.x
        let tdy = cy - b.y
        let tlen = Math.hypot(tdx, tdy)
        if (tlen < 0.001) { tdx = -ux; tdy = -uy; tlen = 1 }
        const tux = tdx / tlen
        const tuy = tdy / tlen
        const tA = intersectDist(sa, sux, suy)
        const tB = intersectDist(sb, tux, tuy)
        const x1 = a.x + sux * tA
        const y1 = a.y + suy * tA
        const x2 = b.x + tux * tB
        const y2 = b.y + tuy * tB
        const chordLen = Math.max(Math.hypot(x2 - x1, y2 - y1), 0.001)
        return { x1, y1, x2, y2, cx, cy, ex: (x2 - x1) / chordLen, ey: (y2 - y1) / chordLen }
      }
      function zoomAround(v, factor, px, py) {
        const wx = (px - v.tx) / v.k
        const wy = (py - v.ty) / v.k
        const k2 = clamp(v.k * factor, 0.5, 2)
        return { k: k2, tx: px - wx * k2, ty: py - wy * k2 }
      }

      // --------------------------- GraphViewer ---------------------------
      function GraphViewer({ nodes, edges, anchors, selectedNodeId, selectedEdgeId, focusReq, onSelectNode, onSelectEdge, ctx, height, layoutMode, onLayoutModeChange, issueReport, onQuestionNode, onQuestionEdge, onDeleteEdge, onOpenNodeIssues, exportTitle }) {
        const containerRef = useRef(null)
        const [view, setView] = useState({ k: 1, tx: 0, ty: 0 })
        const [dragging, setDragging] = useState(false)
        const [tooltip, setTooltip] = useState(null)
        const [detail, setDetail] = useState(null) // node whose full text is shown in the detail card
        const [flashId, setFlashId] = useState(null)
        const [hoverEdge, setHoverEdge] = useState(null)
        const pressTimer = useRef(null)
        const panRef = useRef(null)
        // The workbench window and the trajectory tab can render two
        // GraphViewers in the same document; a shared marker id would make
        // url(#kg-arrow) resolve to the wrong SVG after one unmounts.
        const markerIdRef = useRef(null)
        if (!markerIdRef.current) markerIdRef.current = 'kg-arrow-' + Math.random().toString(36).slice(2, 9)

        const sizes = useMemo(() => computeNodeSizes(nodes, edges), [nodes, edges])
        const nodeDegree = useMemo(() => {
          const degree = new Map((nodes || []).map((node) => [node.id, 0]))
          for (const edge of edges || []) {
            if (degree.has(edge.fromNodeId)) degree.set(edge.fromNodeId, degree.get(edge.fromNodeId) + 1)
            if (degree.has(edge.toNodeId)) degree.set(edge.toNodeId, degree.get(edge.toNodeId) + 1)
          }
          return degree
        }, [nodes, edges])
        const layout = useMemo(() => {
          try {
            return layoutGraph(nodes, edges, sizes, layoutMode || 'layered')
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
          setDetail(null)
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
        const exportImage = async () => {
          try {
            const filename = await exportRenderedGraphImage(containerRef.current, exportTitle || 'knowledge-graph', ctx, bbox)
            if (filename) toastStore.show('已导出图片 ' + filename)
            else toastStore.show('当前浏览器不支持图片下载')
          } catch (error) {
            toastStore.show('图片导出失败：' + (error && error.message ? error.message : '未知错误'))
          }
        }

        // Verification issue overlays: only OPEN (or accepted-but-not-applied)
        // issues tint their target node / edge by severity. Once an issue is
        // applied or dismissed, the tint disappears immediately — a visible
        // confirmation that the fix took effect. Selected focus still wins.
        const issueMaps = useMemo(() => issueTargetsOf(issueReport), [issueReport])
        const openIssuesOf = (list) => (list || []).filter((it) => it.status === 'open' || it.status === 'accepted')
        const issueSeverityFor = (nodeId) => {
          const list = openIssuesOf(issueMaps.nodeMap.get(nodeId))
          if (!list || list.length === 0) return null
          const order = { error: 0, warning: 1, suggestion: 2 }
          list.sort((a, b) => order[a.severity] - order[b.severity])
          return list[0].severity
        }
        const issueSeverityForEdge = (edge) => {
          const list = openIssuesOf(issueMaps.edgeMap.get(edgeKeyOf(edge)))
          if (!list || list.length === 0) return null
          const order = { error: 0, warning: 1, suggestion: 2 }
          list.sort((a, b) => order[a.severity] - order[b.severity])
          return list[0].severity
        }
        const edgeDetail = selectedEdgeId != null ? (edges || [])[selectedEdgeId] : null

        const markerId = markerIdRef.current
        const edgeEls = (edges || []).map((edge, i) => {
          const a = layout.pos.get(edge.fromNodeId)
          const b = layout.pos.get(edge.toNodeId)
          const sa = sizes.get(edge.fromNodeId)
          const sb = sizes.get(edge.toNodeId)
          if (!a || !b || !sa || !sb) return null
          const sel = selectedEdgeId === i
          const hover = hoverEdge === i
          const inFocus = focus ? related.edgeIdx.has(i) : true
          const dim = focus ? !inFocus : false
          const rel = REL_LABEL[edge.relation] || edge.relation
          const issueSev = issueSeverityForEdge(edge)
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
              // The arc sweeps in the EMPTY BAND just OUTSIDE the outer of the
              // two endpoint rings (ring radii grow by 240px, nodes extend
              // ~60px, so band = ring+60..ring+180): every edge stays local
              // instead of looping around the whole graph. Lane offsets spread
              // parallel arcs within the band (clamped so they never enter a
              // ring's node zone).
              const lane = edgeLanes.get(edge) || 0
              const R = Math.max(ra, rb) + 90 + Math.min(Math.abs(lane) * 16, 90)
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
            // edges fan out symmetrically by rank. Endpoints are clipped along
            // the curve tangents so the line and arrowhead touch node borders.
            const geometry = bezierGeometry(a, b, sa, sb, edgeFan.get(edge) || 0)
            d = 'M ' + geometry.x1 + ' ' + geometry.y1 + ' Q ' + geometry.cx + ' ' + geometry.cy + ' ' + geometry.x2 + ' ' + geometry.y2
            const bx = (geometry.x1 + 2 * geometry.cx + geometry.x2) / 4
            const by = (geometry.y1 + 2 * geometry.cy + geometry.y2) / 4
            lblX = bx - geometry.ey * 11
            lblY = by + geometry.ex * 11
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
              stroke: sel ? '#6366f1' : (issueSev ? SEVERITY_COLOR[issueSev] : ((inFocus && focus) ? '#6366f1' : 'var(--kg-edge)')),
              strokeWidth: sel || hover ? 3 : (inFocus && focus ? 2.5 : 2),
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
          const issueSev = issueSeverityFor(node.id)
          const issueCount = issueMaps.nodeMap.has(node.id) ? openIssuesOf(issueMaps.nodeMap.get(node.id)).length : 0
          const degree = nodeDegree.get(node.id) || 0
          const hub = degree >= 4
          const off = anchors[node.id]
          const aria = meta.label + '节点：' + node.text + (off == null ? '，无法回链原文' : '，原文摘录：' + (node.quote || ''))
          return h('g', {
            key: node.id, className: 'kg-node', role: 'button', tabIndex: 0,
            'aria-pressed': sel, 'aria-label': aria,
            style: { cursor: 'pointer', opacity: dim ? 0.22 : 1 },
            onPointerDown: (e) => { e.stopPropagation(); startPress(e, node) },
            onPointerUp: cancelPress,
            onPointerLeave: cancelPress,
            onClick: (e) => { e.stopPropagation(); cancelPress(); setTooltip(null); onSelectNode(node.id); setDetail((d) => (d && d.id === node.id ? null : node)) },
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectNode(node.id); setDetail((d) => (d && d.id === node.id ? null : node)) } },
          },
            h('rect', {
              x, y, width: s.w, height: s.h, rx: 10,
              fill: meta.fill,
              stroke: sel ? '#3b82f6' : (flash ? '#f59e0b' : (issueSev ? SEVERITY_COLOR[issueSev] : (neighbor ? '#3b82f6' : meta.color))),
              strokeWidth: sel || flash ? 3 : (issueSev ? 2.5 : (neighbor ? 2.4 : (hub ? 2.2 : 1.6))),
              className: flash ? 'kg-node-flash' : '',
              style: (sel || flash || neighbor || issueSev || hub) ? { filter: flash ? 'drop-shadow(0 0 8px rgba(245,158,11,0.9))' : (hub && !sel && !neighbor && !issueSev ? 'drop-shadow(0 2px 5px rgba(15,23,42,0.22))' : 'drop-shadow(0 0 6px rgba(59,130,246,0.8))') } : undefined,
            }),
            issueCount > 0
              ? h('g', {
                  className: 'kg-node-issue-badge',
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': '查看该节点的 ' + issueCount + ' 个问题',
                  style: { cursor: 'pointer' },
                  onPointerDown: (e) => e.stopPropagation(),
                  onPointerUp: (e) => e.stopPropagation(),
                  onClick: (e) => { e.stopPropagation(); if (typeof onOpenNodeIssues === 'function') onOpenNodeIssues(node) },
                  onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (typeof onOpenNodeIssues === 'function') onOpenNodeIssues(node) } },
                },
                  h('circle', { cx: x + s.w - 6, cy: y + 6, r: 7, fill: issueSev ? SEVERITY_COLOR[issueSev] : '#6b7280', stroke: '#fff', strokeWidth: 1.5 }),
                  h('text', { x: x + s.w - 6, y: y + 9.5, textAnchor: 'middle', fontSize: 8.5, fill: '#fff', fontWeight: 700 }, issueCount > 9 ? '9+' : String(issueCount)))
              : null,
            h('text', { className: 'kg-node-name', x: p.x, y: y + 25, textAnchor: 'middle', fontSize: hub ? 13.5 : 13, fontWeight: hub ? 700 : 600 },
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

        // Persistent detail card: nodes only display up to 4 lines / 36 chars
        // in the graph, so clicking a node opens the FULL text (plus quote and
        // a locate button) here — this is the primary way to read long nodes.
        const detailEl = detail
          ? h('div', { className: 'kg-node-detail', role: 'dialog', 'aria-label': '节点详情' },
              h('div', { className: 'kg-node-detail-head' },
                h('span', { className: 'kg-node-detail-type', style: { background: (TYPE_META[detail.type] || {}).color || '#6b7280' } },
                  (TYPE_META[detail.type] || { label: '未知' }).label),
                h('button', {
                  type: 'button', className: 'kg-node-detail-close', 'aria-label': '关闭详情',
                  onClick: () => setDetail(null),
                }, '×'),
              ),
              h('div', { className: 'kg-node-detail-text' }, detail.text),
              detail.quote
                ? h('div', { className: 'kg-node-detail-quote' }, '原文摘录：' + detail.quote)
                : null,
              h('div', { className: 'kg-node-detail-actions' },
                h('button', {
                  type: 'button', className: 'kg-secondary kg-node-detail-locate',
                  disabled: anchors[detail.id] == null,
                  onClick: () => { onSelectNode(detail.id) },
                }, anchors[detail.id] == null ? '无法回链原文' : '定位原文'),
                typeof onOpenNodeIssues === 'function' && issueMaps.nodeMap.has(detail.id) && openIssuesOf(issueMaps.nodeMap.get(detail.id)).length > 0
                  ? h('button', {
                      type: 'button', className: 'kg-secondary',
                      onClick: () => onOpenNodeIssues(detail),
                    }, '查看 ' + openIssuesOf(issueMaps.nodeMap.get(detail.id)).length + ' 个问题')
                  : null,
                typeof onQuestionNode === 'function'
                  ? h('button', {
                      type: 'button', className: 'kg-secondary',
                      onClick: () => onQuestionNode(detail),
                    }, '质疑此节点')
                  : null,
              ),
            )
          : null

        // Edge detail card: appears when an edge is selected. Edges have no
        // long text, but the card offers a "question this relation" entry and
        // a close button, keeping the selection UX consistent with nodes.
        const edgeDetailEl = edgeDetail
          ? h('div', { className: 'kg-node-detail', role: 'dialog', 'aria-label': '关系详情' },
              h('div', { className: 'kg-node-detail-head' },
                h('span', { className: 'kg-node-detail-type', style: { background: '#6366f1' } }, REL_LABEL[edgeDetail.relation] || edgeDetail.relation),
                h('button', {
                  type: 'button', className: 'kg-node-detail-close', 'aria-label': '关闭详情',
                  onClick: () => { onSelectEdge(null) },
                }, '×'),
              ),
              h('div', { className: 'kg-node-detail-text' }, edgeDetail.fromNodeId + ' → ' + edgeDetail.toNodeId),
              h('div', { className: 'kg-node-detail-quote' }, '关系：' + (REL_LABEL[edgeDetail.relation] || edgeDetail.relation)),
              h('div', { className: 'kg-node-detail-actions' },
                typeof onQuestionEdge === 'function'
                  ? h('button', {
                      type: 'button', className: 'kg-secondary',
                      onClick: () => onQuestionEdge(edgeDetail, selectedEdgeId),
                    }, '质疑此关系')
                  : null,
                typeof onDeleteEdge === 'function'
                  ? h('button', {
                      type: 'button', className: 'kg-secondary kg-danger',
                      onClick: () => onDeleteEdge(edgeDetail, selectedEdgeId),
                    }, '删除此关系')
                  : null),
            )
          : null

        return h('div', {
          className: 'kg-graph', ref: containerRef,
          role: 'img',
          style: height ? { height: height + 'px' } : undefined,
          'aria-label': '知识图，共 ' + (nodes || []).length + ' 个节点、' + (edges || []).length + ' 条关系。拖拽平移，Ctrl+滚轮缩放，点击节点查看完整内容并定位原文，点击段落聚焦节点。',
          onPointerDown: onBgPointerDown,
          onPointerMove: onBgPointerMove,
          onPointerUp: onBgPointerUp,
          onPointerLeave: () => { if (panRef.current) panRef.current = null },
        },
          h('svg', { width: '100%', height: '100%', style: { display: 'block' } },
            h('defs', null,
              h('marker', { id: markerId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' },
                h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--kg-edge)' }))),
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
              value: layoutMode || 'layered',
              'aria-label': '布局形态',
              title: '切换布局形态',
              onChange: (e) => onLayoutModeChange(e.target.value),
            }, LAYOUT_MODES.map((m) => h('option', { key: m.id, value: m.id }, m.label))),
            h('button', { type: 'button', 'aria-label': '导出知识图 PNG 图片', title: '导出当前知识图为 PNG 图片', onClick: exportImage }, 'PNG'),
            h('button', { type: 'button', 'aria-label': '缩小（10%）', onClick: () => zoomBy(-0.1) }, '−'),
            h('button', { type: 'button', 'aria-label': '重置缩放为 100%', onClick: zoomReset }, Math.round(view.k * 100) + '%'),
            h('button', { type: 'button', 'aria-label': '放大（10%）', onClick: () => zoomBy(0.1) }, '+'),
          ),
          tooltipEl,
          detailEl,
          edgeDetailEl,
        )
      }

      // --------------------- candidate review panel ---------------------
      function CandidateReviewPanel({ graph, chapterFilter, onChapterFilter, reviews, onSetReview, onLocate }) {
        const [statusFilter, setStatusFilter] = useState('candidate')
        const sections = chapterSectionsOf(graph)
        const activeSectionId = chapterFilter && chapterFilter !== 'all' && sections.some((section) => section.id === chapterFilter) ? chapterFilter : 'all'
        const activeSection = activeSectionId === 'all' ? null : sections.find((section) => section.id === activeSectionId)
        const candidates = (Array.isArray(graph && graph.nodes) ? graph.nodes : [])
          .filter((node) => candidateKindFor(node) && nodeMatchesChapter(node, activeSection))
        const counts = { candidate: 0, accepted: 0, rejected: 0 }
        for (const node of candidates) {
          const status = REVIEW_STATUS_ORDER.includes(reviews && reviews[reviewKeyFor(graph, node)]) ? reviews[reviewKeyFor(graph, node)] : 'candidate'
          counts[status] += 1
        }
        const shown = candidates.filter((node) => {
          const status = reviews && REVIEW_STATUS_ORDER.includes(reviews[reviewKeyFor(graph, node)]) ? reviews[reviewKeyFor(graph, node)] : 'candidate'
          return statusFilter === 'all' || status === statusFilter
        })
        return h('section', { className: 'kg-card', 'aria-label': '候选实体与声明审核' },
          h('div', { className: 'kg-panel-head' },
            h('h3', { className: 'kg-section-title' }, '章节与候选审核'),
            h('span', { className: 'kg-section-meta' }, candidates.length + ' 个候选'),
          ),
          h('div', { className: 'kg-section-filter' },
            h('label', { className: 'kg-section-meta', htmlFor: 'kg-section-select' }, '章节'),
            h('select', {
              id: 'kg-section-select', className: 'kg-section-select', value: activeSectionId,
              onChange: (event) => onChapterFilter(event.target.value),
              'aria-label': '按章节筛选知识图',
            },
              h('option', { value: 'all' }, '全部章节'),
              sections.map((section) => h('option', { key: section.id, value: section.id },
                section.title || section.id,
                Number.isInteger(Number(section.startParagraph)) && Number.isInteger(Number(section.endParagraph))
                  ? '（P' + (Number(section.startParagraph) + 1) + '–P' + (Number(section.endParagraph) + 1) + '）' : '')),
            ),
            activeSection ? h('span', { className: 'kg-section-meta' }, '当前仅显示「' + (activeSection.title || activeSection.id) + '」') : null,
          ),
          h('div', { className: 'kg-candidate-counts' },
            h('span', null, '待审核 ' + counts.candidate),
            h('span', null, '已接受 ' + counts.accepted),
            h('span', null, '已驳回 ' + counts.rejected),
          ),
          h('div', { className: 'kg-candidate-toolbar' },
            ['all', ...REVIEW_STATUS_ORDER].map((status) => h('button', {
              key: status, type: 'button', className: 'kg-filter-chip' + (statusFilter === status ? ' on' : ''),
              onClick: () => setStatusFilter(status),
            }, status === 'all' ? '全部 ' + candidates.length : REVIEW_STATUS_LABEL[status] + ' ' + counts[status])),
          ),
          shown.length === 0
            ? h('p', { className: 'kg-candidate-empty' }, candidates.length === 0 ? '当前章节没有可审核的候选实体或声明。' : '没有符合当前审核状态的候选。')
            : h('div', { className: 'kg-candidate-list' }, shown.map((node) => {
                const key = reviewKeyFor(graph, node)
                const kind = candidateKindFor(node)
                const status = reviews && REVIEW_STATUS_ORDER.includes(reviews[key]) ? reviews[key] : 'candidate'
                const meta = TYPE_META[node.type] || { label: node.type || '未知', color: '#64748b' }
                return h('div', {
                  key, className: 'kg-candidate kg-candidate-' + status, role: 'button', tabIndex: 0,
                  onClick: () => onLocate(node),
                  onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onLocate(node) } },
                },
                  h('div', { className: 'kg-candidate-top' },
                    h('span', { className: 'knowledge-type-badge', style: { background: meta.color } }, meta.label),
                    h('span', { className: 'kg-candidate-kind' }, kind === 'entity' ? '候选实体' : '候选声明'),
                    Number.isInteger(Number(node.paragraph)) ? h('span', { className: 'kg-candidate-kind' }, 'P' + (Number(node.paragraph) + 1)) : null,
                  ),
                  h('div', { className: 'kg-candidate-text' }, node.text || '（无文本）'),
                  candidateEvidenceText(node) ? h('div', { className: 'kg-candidate-evidence' }, '证据：' + candidateEvidenceText(node).slice(0, 220)) : null,
                  h('div', { className: 'kg-candidate-actions' },
                    REVIEW_STATUS_ORDER.map((nextStatus) => h('button', {
                      key: nextStatus, type: 'button',
                      className: nextStatus === status ? 'kg-primary' : 'kg-secondary',
                      onClick: (event) => { event.stopPropagation(); onSetReview(key, nextStatus) },
                    }, REVIEW_STATUS_LABEL[nextStatus])),
                    h('span', { className: 'kg-candidate-status' }, REVIEW_STATUS_LABEL[status]),
                  ),
                )
              })),
        )
      }

      // --------------------- verification panel ---------------------
      function VerificationPanel({ report, graph, resultView, verifying, activeIssueId, onSelectIssue, onApplyIssue, onRejectIssue, onRecheckIssue, onApplyAll, issueFilter, setIssueFilter, questionDraft, setQuestionDraft, questionTarget, clearQuestionTarget, questionResult, questionPhase, onSubmitQuestion, onDeleteTarget, panelId, progress, onCancel }) {
        const [flashIssueId, setFlashIssueId] = useState(null)
        const prevActiveIssueRef = useRef(null)
        useEffect(() => {
          if (!activeIssueId || activeIssueId === prevActiveIssueRef.current) return
          prevActiveIssueRef.current = activeIssueId
          setFlashIssueId(activeIssueId)
          const t = setTimeout(() => setFlashIssueId(null), 1300)
          return () => clearTimeout(t)
        }, [activeIssueId])
        const issues = (report && Array.isArray(report.issues) ? report.issues : [])
        const openIssues = issues.filter((it) => it.status === 'open')
        const fixableCount = openIssues.filter((it) => it.proposedFix && it.proposedFix.action && it.proposedFix.action !== 'none').length
        const shown = issues.filter((it) => {
          if (issueFilter && issueFilter !== 'all' && it.severity !== issueFilter) return false
          return true
        })
        const qNode = questionTarget && questionTarget.kind === 'node' && graph && Array.isArray(graph.nodes)
          ? graph.nodes.find((n) => n && n.id === questionTarget.id) : null
        const targetLabel = questionTarget
          ? (questionTarget.kind === 'node'
            ? '目标：节点 ' + questionTarget.id + (qNode ? '「' + String(qNode.text || '').slice(0, 40) + '」' : '')
            : questionTarget.kind === 'edge'
              ? '目标：关系 ' + questionTarget.id
              : '目标：整张图')
          : ''
        const qFix = questionResult && questionResult.proposedFix ? questionResult.proposedFix : null
        const qAction = qFix ? qFix.action : 'none'
        const qVerdict = questionResult ? questionResult.verdict : ''
        // A contradicted/insufficient answer without a structured fix is not a
        // deletion instruction. Never synthesize delete_node/delete_edge from
        // the target kind: the answer may be pointing out a missing relation
        // (for example, a node that should be connected to n2).
        const qNeedsManualRepair = (qVerdict === 'contradicted' || qVerdict === 'insufficient') && qAction === 'none'
        const auditLog = graph && graph.verification && Array.isArray(graph.verification.auditLog) ? graph.verification.auditLog : []
        const recentAudits = auditLog.slice(-5).reverse()
        return h('section', { id: panelId || 'kg-verify-panel', className: 'kg-card', 'aria-label': '验证与质疑' },
          h('div', { className: 'kg-verify-head' },
            h('div', { className: 'kg-verify-head-text' },
              h('h3', { className: 'kg-verify-title' }, '验证与质疑'),
              report && typeof report.summary === 'string'
                ? h('p', { className: 'kg-verify-summary' }, report.summary)
                : null,
              report && report.stale
                ? h('p', { className: 'kg-verify-stale' }, '⚠ 图已追加更新，本报告只覆盖旧版本，建议重新验证。')
                : null,
            ),
            typeof onApplyAll === 'function' && fixableCount > 0
              ? h('button', {
                  type: 'button', className: 'kg-primary',
                  style: { flex: 'none', marginLeft: 'auto' },
                  disabled: verifying,
                  onClick: onApplyAll,
                  title: '应用所有可自动修复的问题（' + fixableCount + ' 项）',
                }, '一键修复 ' + fixableCount + ' 项')
              : null,
            verifying
              ? h('div', { style: { flex: 'none', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 } },
                  h('span', { className: 'kg-verify-spinner', 'aria-label': '验证进行中' }),
                  progress
                    ? h('span', { className: 'kg-fact-note', style: { margin: 0 } },
                        (progress.stage || '运行中') + ' · ' + Math.round((progress.elapsedMs || 0) / 60000) + ' 分钟 · 已接收 ' + (progress.charsReceived || 0) + ' 字符' + (progress.model ? ' · 模型 ' + progress.model.provider + ' · ' + progress.model.model : ''))
                    : null,
                  progress && progress.warning
                    ? h('span', { className: 'kg-fact-note', style: { margin: 0, color: '#b45309' } }, '⚠ ' + progress.warning)
                    : null,
                  typeof onCancel === 'function'
                    ? h('button', { type: 'button', className: 'kg-secondary kg-danger', onClick: onCancel }, '取消')
                    : null)
              : null,
          ),
          report
            ? h('div', { className: 'kg-verify-metrics' },
                h('span', null, '已检查 ' + (report.metrics && report.metrics.checkedNodes != null ? report.metrics.checkedNodes : '?') + ' 节点 / ' + (report.metrics && report.metrics.checkedEdges != null ? report.metrics.checkedEdges : '?') + ' 关系'),
                report.metrics && report.metrics.connectedComponents != null ? h('span', null, '连通分量 ' + report.metrics.connectedComponents + ' · 孤立节点 ' + (report.metrics.isolatedNodes || 0)) : null,
                h('span', { style: { color: (report.metrics && report.metrics.errorCount) > 0 ? '#dc2626' : undefined } }, (report.mode === 'quick' ? '确定性错误 ' : '错误 ') + (report.metrics && report.metrics.errorCount || 0)),
                h('span', { style: { color: (report.metrics && report.metrics.warningCount) > 0 ? '#d97706' : undefined } }, (report.mode === 'quick' ? '质量警告 ' : '警告 ') + (report.metrics && report.metrics.warningCount || 0)),
                h('span', { style: { color: (report.metrics && report.metrics.suggestionCount) > 0 ? '#2563eb' : undefined } }, '建议 ' + (report.metrics && report.metrics.suggestionCount || 0)),
                report.metrics && report.metrics.anchorCoverage != null ? h('span', null, '锚点覆盖 ' + report.metrics.anchorCoverage + '%') : null,
                h('span', { className: (report.metrics && report.metrics.evidenceCoverage) >= 90 ? 'kg-ok' : undefined }, '证据覆盖 ' + (report.metrics && report.metrics.evidenceCoverage != null ? report.metrics.evidenceCoverage : '?') + '%'),
                report.metrics && report.metrics.entailmentCoverage != null ? h('span', null, '语义已验证 ' + report.metrics.entailmentCoverage + '%') : null,
                h('span', null, '段落覆盖 ' + (report.metrics && report.metrics.paragraphCoverage != null ? report.metrics.paragraphCoverage : '?') + '%'),
              )
            : null,
          h('div', { className: 'kg-verify-filters' },
            ['all', ...SEVERITY_ORDER].map((s) => h('button', {
              key: s, type: 'button',
              className: 'kg-filter-chip' + (issueFilter === s ? ' on' : ''),
              onClick: () => setIssueFilter(s),
            }, s === 'all' ? '全部 ' + issues.length : (SEVERITY_META[s].label + ' ' + issues.filter((it) => it.severity === s).length))),
          ),
          shown.length === 0
            ? h('p', { className: 'kg-hint' }, verifying ? '正在审校…' : '没有符合筛选条件的问题。')
            : h('div', { className: 'kg-issue-list' },
                shown.map((it) => {
                  const nodeTarget = it.targetKind === 'node' && graph ? graph.nodes.find((n) => n.id === it.targetId) : null
                  const edgeIndex = it.targetKind === 'edge' ? edgeIndexForIssue(graph, it) : null
                  const edgeTarget = edgeIndex != null && graph && Array.isArray(graph.edges) ? graph.edges[edgeIndex] : null
                  const relationRequiredSource = edgeTarget && REL_SOURCE_RULES[edgeTarget.relation]
                  const relationSourceNode = relationRequiredSource && graph && Array.isArray(graph.nodes)
                    ? graph.nodes.find((n) => n && n.id === edgeTarget.fromNodeId) : null
                  const relationTypeFix = it.title === '关系与源节点类型不匹配' && edgeTarget && relationRequiredSource && relationSourceNode && relationSourceNode.type !== relationRequiredSource
                    ? { ...it, proposedFix: { action: 'update_node', nodePatch: { id: relationSourceNode.id, patch: { type: relationRequiredSource } } } }
                    : null
                  const hasFix = it.proposedFix && it.proposedFix.action && it.proposedFix.action !== 'none'
                  return h('div', {
                    key: it.id,
                    className: 'kg-issue kg-sev-' + it.severity + (activeIssueId === it.id ? ' on' : '') + (flashIssueId === it.id ? ' kg-issue-flash' : '') + (it.status === 'applied' ? ' kg-applied' : it.status === 'rejected' ? ' kg-rejected' : ''),
                    role: 'button', tabIndex: 0,
                    onClick: () => onSelectIssue(it),
                    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectIssue(it) } },
                  },
                    h('div', { className: 'kg-issue-top' },
                      h('span', { className: 'kg-sev-tag ' + (SEVERITY_META[it.severity] || {}).cls }, (SEVERITY_META[it.severity] || {}).label || it.severity),
                      h('span', { className: 'kg-issue-cat' }, ISSUE_CATEGORY_LABEL[it.category] || it.category),
                      nodeTarget ? h('span', { className: 'kg-issue-cat' }, it.targetId) : null,
                      edgeTarget ? h('span', { className: 'kg-issue-cat' }, '关系 ' + it.targetId) : null,
                      typeof it.confidence === 'number' ? h('span', { className: 'kg-issue-cat' }, '置信 ' + Math.round(it.confidence * 100) + '%') : null,
                      it.source === 'local' ? h('span', { className: 'kg-issue-cat' }, '本地规则') : null,
                    ),
                    h('div', { className: 'kg-issue-title' }, it.title),
                    it.detail ? h('div', { className: 'kg-issue-detail' }, it.detail) : null,
                    (Array.isArray(it.evidence) && it.evidence.length > 0)
                      ? h('div', { className: 'kg-issue-ev' },
                          it.evidence.map((ev, k) => {
                            const pi = typeof ev.paragraph === 'number' ? ev.paragraph : null
                            return h('div', { key: k }, '原文第 ' + (pi == null ? '?' : pi + 1) + ' 段' + (ev.quote ? '：' + ev.quote.slice(0, 180) : ''))
                          }))
                      : null,
                    h('div', { className: 'kg-issue-actions' },
                      it.status === 'open' && relationTypeFix
                        ? h('button', { type: 'button', className: 'kg-primary', title: '把源节点类型改为「' + ((TYPE_META[relationRequiredSource] || {}).label || relationRequiredSource) + '」，保留当前关系', onClick: (e) => { e.stopPropagation(); onApplyIssue(relationTypeFix) } }, '将源节点改为「' + ((TYPE_META[relationRequiredSource] || {}).label || relationRequiredSource) + '」')
                        : null,
                      it.status === 'open' && relationTypeFix && typeof onDeleteTarget === 'function'
                        ? h('button', { type: 'button', className: 'kg-secondary kg-danger', onClick: (e) => { e.stopPropagation(); onDeleteTarget({ kind: 'edge', id: it.targetId }) } }, '删除这条关系')
                        : null,
                      it.status === 'open' && hasFix && !relationTypeFix
                        ? h('button', { type: 'button', className: 'kg-primary', onClick: (e) => { e.stopPropagation(); onApplyIssue(it) } }, '采纳修复')
                        : null,
                      it.status === 'open'
                        ? h('button', { type: 'button', className: 'kg-secondary', onClick: (e) => { e.stopPropagation(); onRejectIssue(it) } }, '忽略')
                        : null,
                      it.status === 'open'
                        ? h('button', { type: 'button', className: 'kg-secondary', onClick: (e) => { e.stopPropagation(); onRecheckIssue(it) } }, '复核并提交')
                        : null,
                      h('span', { className: 'kg-issue-status' }, it.status === 'applied' ? '已应用' : it.status === 'rejected' ? '已忽略' : it.status === 'accepted' ? '已确认' : ''),
                    ),
                  )
                }),
              ),
          recentAudits.length > 0
            ? h('div', { className: 'kg-audit' },
                h('p', { className: 'kg-audit-title' }, '修复记录（最近 ' + recentAudits.length + ' 条）'),
                h('div', { className: 'kg-audit-list' },
                  recentAudits.map((a, i) => {
                    const diff = auditDiffLines(a.before, a.after, 5)
                    return h('div', { key: i, className: 'kg-audit-item' },
                      h('div', { className: 'kg-audit-head' },
                        h('span', { className: 'kg-audit-action' }, a.action || 'fix'),
                        h('span', null, (a.detail || a.targetId || '') + ' · ' + formatTime(a.ts))),
                      diff.lines.length > 0
                        ? h('div', { className: 'kg-audit-diff' },
                            diff.lines.map((ln, k) => h('div', { key: k }, ln)),
                            diff.more > 0 ? h('div', { className: 'kg-audit-more' }, '… 另有 ' + diff.more + ' 处变化') : null)
                        : null,
                    )
                  })))
            : null,
          h('div', { className: 'kg-question-bar' },
            h('input', {
              className: 'kg-question-input', type: 'text',
              placeholder: '对这张图提问或提出质疑，例如：这条推论真的能从原文推出吗？',
              value: questionDraft,
              maxLength: 600,
              onChange: (e) => setQuestionDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmitQuestion() } },
              'aria-label': '质疑或提问输入框',
            }),
            h('button', {
              type: 'button', className: 'kg-primary',
              disabled: questionPhase === 'running' || !questionDraft.trim(),
              onClick: onSubmitQuestion,
            }, questionPhase === 'running' ? '提问中…' : '提问 / 质疑'),
          ),
          targetLabel ? h('p', { className: 'kg-question-target' }, targetLabel,
            h('button', { type: 'button', className: 'kg-filter-chip', style: { marginLeft: 8 }, onClick: clearQuestionTarget }, '清除目标')) : null,
          questionResult
            ? h('div', { className: 'kg-question-result' },
                h('div', null,
                  h('span', { className: 'kg-verdict kg-verdict-' + questionResult.verdict }, VERDICT_LABEL[questionResult.verdict] || questionResult.verdict),
                  questionResult.answer ? ' ' + questionResult.answer : ''),
                (Array.isArray(questionResult.evidence) && questionResult.evidence.length > 0)
                  ? h('div', { className: 'kg-issue-ev' },
                      questionResult.evidence.map((ev, k) => h('div', { key: k }, '原文第 ' + (typeof ev.paragraph === 'number' ? ev.paragraph + 1 : '?') + ' 段' + (ev.quote ? '：' + ev.quote.slice(0, 180) : ''))))
                  : null,
                qFix && qFix.action !== 'none'
                  ? h('div', { className: 'kg-issue-actions' },
                      h('button', {
                        type: 'button', className: 'kg-primary',
                        onClick: () => onApplyIssue({
                          id: 'qfix-' + Date.now(), source: 'question', severity: 'warning', category: 'other',
                          targetKind: questionTarget ? questionTarget.kind : 'graph', targetId: questionTarget ? questionTarget.id : null,
                          title: '采纳质疑建议：' + qFix.action, detail: questionResult.answer || '',
                          evidence: questionResult.evidence || [], confidence: 1,
                          proposedFix: qFix, status: 'open',
                        }),
                      }, '采纳修复建议'),
                    )
                  : null,
                qNeedsManualRepair
                  ? h('p', { className: 'kg-hint' }, qVerdict === 'contradicted'
                    ? '质疑成立，但 AI 未返回可自动应用的结构化修复；为避免误删节点，未提供删除兜底操作。请复核后生成更新节点或新增关系边的修复建议。'
                    : '原文证据不足，AI 未返回可自动应用的结构化修复；为避免误删节点，未提供删除兜底操作。请补充证据或重新复核。')
                  : null,
              )
            : null,
        )
      }

      // --------------------- external fact-check panel ---------------------
      function FactCheckPanel({ report, graph, resultView, verifying, activeClaimId, onSelectClaim, onRejectClaim, panelId, rulesDraft, setRulesDraft, onStartFactCheck, progress, onCancel }) {
        const claims = (report && Array.isArray(report.claims) ? report.claims : [])
        const m = report && report.metrics ? report.metrics : {}
        return h('section', { id: panelId || 'kg-fact-panel', className: 'kg-card', 'aria-label': '外部事实核查' },
          h('div', { className: 'kg-fact-head' },
            h('div', { className: 'kg-fact-head-text' },
              h('h3', { className: 'kg-fact-title' }, '外部事实核查'),
              report && typeof report.summary === 'string' ? h('p', { className: 'kg-fact-summary' }, report.summary) : null,
              report && report.stale ? h('p', { className: 'kg-fact-stale' }, '⚠ 图已追加更新，本报告只覆盖旧版本，建议重新核查。') : null,
              h('p', { className: 'kg-fact-note' }, report && report.mode === 'quick' ? '快速模式：仅基于模型知识，结论仅供提示。' : '深度模式：结论均绑定检索证据，可点击链接核对。'),
            ),
            verifying
              ? h('div', { style: { flex: 'none', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 } },
                  h('span', { className: 'kg-verify-spinner', 'aria-label': '核查进行中' }),
                  progress
                    ? h('span', { className: 'kg-fact-note', style: { margin: 0 } },
                        (progress.stage || '运行中') + ' · ' + Math.round((progress.elapsedMs || 0) / 60000) + ' 分钟 · 已接收 ' + (progress.charsReceived || 0) + ' 字符' + (progress.model ? ' · 模型 ' + progress.model.provider + ' · ' + progress.model.model : ''))
                    : null,
                  progress && progress.warning
                    ? h('span', { className: 'kg-fact-note', style: { margin: 0, color: '#b45309' } }, '⚠ ' + progress.warning)
                    : null,
                  typeof onCancel === 'function'
                    ? h('button', { type: 'button', className: 'kg-secondary kg-danger', onClick: onCancel }, '取消')
                    : null)
              : null,
          ),
          typeof setRulesDraft === 'function' && typeof onStartFactCheck === 'function'
            ? h('div', { className: 'kg-fact-rules' },
                h('textarea', {
                  className: 'kg-question-input',
                  style: { minHeight: 56, resize: 'vertical', display: 'block', width: '100%', boxSizing: 'border-box' },
                  placeholder: '领域规则来源（可选）：粘贴法条、制度、教材、标准等文本。填写后核查会同时使用 Wikipedia 与这些规则。',
                  value: rulesDraft || '',
                  maxLength: 10000,
                  onChange: (e) => setRulesDraft(e.target.value),
                  'aria-label': '领域规则来源',
                }),
                h('div', { className: 'kg-fact-actions', style: { marginTop: 8 } },
                  h('button', { type: 'button', className: 'kg-primary', disabled: verifying, onClick: onStartFactCheck },
                    verifying ? '核查中…' : (report ? '重新核查' : '开始外部核查')),
                  (rulesDraft || '').trim() ? h('span', { className: 'kg-fact-status', style: { marginLeft: 0 } }, '将附带 ' + rulesDraft.trim().split(/\n+/).length + ' 段规则') : null),
              )
            : null,
          report
            ? h('div', { className: 'kg-fact-metrics' },
                h('span', null, '共 ' + (m.totalClaims || 0) + ' 条声明'),
                h('span', { style: { color: (m.supported || 0) > 0 ? '#059669' : undefined } }, '支持 ' + (m.supported || 0)),
                h('span', { style: { color: (m.contradicted || 0) > 0 ? '#dc2626' : undefined } }, '矛盾 ' + (m.contradicted || 0)),
                h('span', { style: { color: (m.partially_supported || 0) > 0 ? '#d97706' : undefined } }, '部分支持 ' + (m.partially_supported || 0)),
                h('span', null, '证据不足 ' + (m.insufficient || 0)),
                h('span', null, '无法核查 ' + (m.unverifiable || 0)),
                h('span', { className: m.supportedRate >= 80 ? 'kg-ok' : undefined }, '支持率 ' + (m.supportedRate != null ? m.supportedRate : '?') + '%'),
              )
            : null,
          claims.length === 0 && !verifying ? h('p', { className: 'kg-hint' }, '还没有外部核查报告。') : null,
          claims.map((c) => {
            const meta = FACT_VERDICT_META[c.verdict] || FACT_VERDICT_META.insufficient
            return h('div', {
              key: c.id,
              className: 'kg-fact-claim kg-fv-' + c.verdict + (activeClaimId === c.id ? ' on' : ''),
              role: 'button', tabIndex: 0,
              onClick: () => onSelectClaim(c),
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectClaim(c) } },
            },
              h('div', { className: 'kg-fact-top' },
                h('span', { className: 'kg-fv-tag', style: { color: meta.color, background: meta.bg, borderColor: meta.border } }, meta.label),
                h('span', { className: 'kg-issue-cat' }, c.kind),
                c.nodeId ? h('span', { className: 'kg-issue-cat' }, c.nodeId) : null,
                typeof c.checkworthy === 'number' ? h('span', { className: 'kg-issue-cat' }, '可核查 ' + Math.round(c.checkworthy * 100) + '%') : null,
                typeof c.confidence === 'number' ? h('span', { className: 'kg-issue-cat' }, '置信 ' + Math.round(c.confidence * 100) + '%') : null,
              ),
              h('div', { className: 'kg-fact-text' }, c.claim),
              c.rationale ? h('div', { className: 'kg-fact-rationale' }, c.rationale) : null,
              c.evidenceQuote ? h('div', { className: 'kg-fact-quote' }, '证据引文：' + c.evidenceQuote) : null,
              (Array.isArray(c.evidence) && c.evidence.length > 0)
                ? h('div', { className: 'kg-issue-ev' },
                    c.evidence.slice(0, 3).map((ev) => ev && ev.url
                      ? h('a', { key: ev.id, className: 'kg-fact-ev', href: ev.url, target: '_blank', rel: 'noreferrer', onClick: (e) => e.stopPropagation() }, (ev.title || ev.provider) + '（' + (ev.provider || '来源') + '）')
                      : ev ? h('div', { key: ev.id }, (ev.title || ev.provider || '来源') + '：' + (ev.snippet || '').slice(0, 120)) : null))
                : null,
              c.correction ? h('div', { className: 'kg-issue-ev' }, '修正建议：' + c.correction) : null,
              h('div', { className: 'kg-fact-actions' },
                h('button', { type: 'button', className: 'kg-secondary', onClick: (e) => { e.stopPropagation(); onSelectClaim(c) } }, '在图中定位'),
                c.status === 'open'
                  ? h('button', { type: 'button', className: 'kg-secondary', onClick: (e) => { e.stopPropagation(); onRejectClaim(c) } }, '忽略')
                  : null,
                h('span', { className: 'kg-fact-status' }, c.status === 'rejected' ? '已忽略' : c.status === 'accepted' ? '已确认' : ''),
              ),
            )
          }),
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

      // Floating tool: select text ANYWHERE on the page (chat messages
      // included) and split the selection into a knowledge graph. Appears
      // just above the selection; excluded inside the workbench window and
      // inside input fields (which have their own selection handling).
      function SelectionTool() {
        const [tool, setTool] = useState(null)
        const timerRef = useRef(null)
        useEffect(() => {
          const detect = () => {
            if (timerRef.current) { timerRef.current(); timerRef.current = null }
            timerRef.current = ctx.timeout(() => {
              timerRef.current = null
              let sel = null
              try { sel = window.getSelection() } catch (e) {}
              const text = sel ? sel.toString().trim() : ''
              if (!text || text.length > MAX_LEN) { setTool(null); return }
              const node = sel.anchorNode
              const el = node && node.nodeType === 3 ? node.parentElement : node
              if (el && typeof el.closest === 'function') {
                if (el.closest('.kg-win, input, textarea')) { setTool(null); return }
              }
              let rect = null
              try {
                if (sel.rangeCount > 0) rect = sel.getRangeAt(0).getBoundingClientRect()
              } catch (e) {}
              if (!rect || (rect.width === 0 && rect.height === 0)) { setTool(null); return }
              const vw = window.innerWidth
              const left = clamp(rect.left, 8, vw - 190)
              const top = rect.top > 48 ? rect.top - 42 : rect.bottom + 8
              setTool({ text, left, top })
            }, 180)
          }
          document.addEventListener('mouseup', detect)
          document.addEventListener('selectionchange', detect)
          return () => {
            document.removeEventListener('mouseup', detect)
            document.removeEventListener('selectionchange', detect)
            if (timerRef.current) { timerRef.current(); timerRef.current = null }
          }
        }, [])
        const take = () => {
          if (!tool) return
          setTool(null)
          try { const sel = window.getSelection(); if (sel) sel.removeAllRanges() } catch (e) {}
          selStore.push(tool.text)
          winStore.setOpen(true)
        }
        if (!tool) return null
        return h('div', {
          className: 'kg-sel-tool',
          style: { left: tool.left, top: tool.top },
          role: 'button', tabIndex: 0,
          'aria-label': '把选中的文字拆成知识图',
          title: '把选中的 ' + tool.text.length + ' 字拆成知识图',
          onClick: take,
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); take() } },
        },
          GraphIcon(13),
          h('span', null, '拆成知识图（' + tool.text.length + ' 字）'),
        )
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

      // Composer button: make a knowledge graph from the attachments that are
      // still in the composer. dsh-paste-input keeps browser File objects in
      // its private store; serializeReference uploads the selected occurrence
      // without sending the chat message and returns the host-side marker.
      const PENDING_ATTACHMENT_SOURCE = 'dsh-paste-input'
      function pendingAttachmentOccurrences(input) {
        return input && Array.isArray(input.occurrences)
          ? input.occurrences.filter((occurrence) => occurrence && occurrence.source === PENDING_ATTACHMENT_SOURCE && typeof occurrence.ref === 'string' && !occurrence.invalid)
          : []
      }
      async function serializePendingAttachmentText(sessionId, input) {
        const occurrences = pendingAttachmentOccurrences(input)
        if (occurrences.length === 0) return ''
        if (!sessions || !inputTriggers) throw new Error('附件服务尚未就绪，请稍后重试')
        const actx = typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
        const controller = actx && typeof inputTriggers.sessionOf === 'function' ? inputTriggers.sessionOf(actx) : undefined
        if (!controller || typeof controller.serializeReference !== 'function') throw new Error('当前环境不支持读取未发送附件，请刷新页面后重试')
        const abort = typeof AbortController === 'function' ? new AbortController() : null
        const signal = abort ? abort.signal : { aborted: false }
        const markers = []
        for (const occurrence of occurrences) {
          const marker = await controller.serializeReference(occurrence.source, occurrence.ref, signal)
          if (typeof marker === 'string' && marker.trim()) markers.push(marker)
        }
        return markers.join(NL + NL)
      }
      function DocImportButton({ sessionId, input }) {
        const [busy, setBusy] = useState(false)
        const pendingCount = pendingAttachmentOccurrences(input).length
        const importPending = async () => {
          if (busy || !sessionId || pendingCount === 0) return
          setBusy(true)
          try {
            const pendingText = await serializePendingAttachmentText(sessionId, input)
            if (!pendingText) {
              toastStore.show('当前输入框没有可读取的未发送附件')
              return
            }
            docStore.request(sessionId, pendingText)
          } catch (e) {
            toastStore.show('读取未发送附件失败：' + (e && e.message ? e.message : '未知错误'))
          } finally {
            setBusy(false)
          }
        }
        const title = pendingCount > 0 ? '把输入框中未发送的附件文档生成知识图' : '请先在输入框中添加未发送的附件文档'
        return h('button', {
          type: 'button', className: 'kg-doc-import-btn', disabled: busy || !sessionId || pendingCount === 0,
          'aria-label': '把未发送附件文档生成知识图', title,
          onClick: importPending,
        },
          h('span', { 'aria-hidden': 'true' }, busy ? '⏳' : '📄'),
          h('span', null, busy ? '上传中…' : '知识图'),
        )
      }

      // ---- manual model selection (拆分 / 追加 / 审校 / 质疑 / 外部核查共用) ----
      const LS_MODEL = 'dsh-kg-model-v1'
      const MODEL_KEY_SEP = '::'

      function modelKeyOf(m) {
        if (!m || typeof m.provider !== 'string' || typeof m.model !== 'string') return ''
        return m.provider + MODEL_KEY_SEP + m.model
      }
      function parseModelKey(key) {
        if (typeof key !== 'string' || !key) return null
        const i = key.indexOf(MODEL_KEY_SEP)
        if (i <= 0 || i + MODEL_KEY_SEP.length >= key.length) return null
        return { provider: key.slice(0, i), model: key.slice(i + MODEL_KEY_SEP.length) }
      }
      function readModelChoice() {
        try {
          const key = localStorage.getItem(LS_MODEL)
          return parseModelKey(key) ? key : ''
        } catch (e) {}
        return ''
      }
      function writeModelChoice(key) {
        try {
          if (key) localStorage.setItem(LS_MODEL, key)
          else localStorage.removeItem(LS_MODEL)
        } catch (e) {}
      }
      function modelDisplayName(key) {
        const m = parseModelKey(key)
        return m ? (m.provider + ' · ' + m.model) : '跟随系统默认'
      }
      function modelLabelOf(m, fallbackKey) {
        if (m && typeof m.provider === 'string' && typeof m.model === 'string') return m.provider + ' · ' + m.model
        return modelDisplayName(fallbackKey)
      }

      // ---- shared model catalog store ----
      // Fetched once by whichever panel mounts first; both the picker and the
      // submit logic read it. If the user leaves "跟随系统默认", submit still
      // sends the CURRENT default model explicitly, so the host never has to
      // run model-catalog resolution for a task.
      let modelCatalogCache = null
      let modelCatalogLoading = false
      const modelCatalogListeners = new Set()
      function notifyModelCatalog() {
        for (const cb of modelCatalogListeners) { try { cb() } catch (e) {} }
      }
      function loadModelCatalog(force) {
        if (force) { modelCatalogCache = null; notifyModelCatalog() }
        if (modelCatalogCache || modelCatalogLoading) return
        modelCatalogLoading = true
        host.call('list-models', {})
          .then((res) => {
            if (res && Array.isArray(res.providers)) {
              modelCatalogCache = { providers: res.providers, current: res.current || null, error: null }
            } else {
              modelCatalogCache = { providers: [], current: null, error: (res && res.error && res.error.message) || '无法读取模型目录' }
            }
          })
          .catch(() => {
            modelCatalogCache = { providers: [], current: null, error: '读取模型目录失败，继续使用默认或已保存模型' }
          })
          .finally(() => {
            modelCatalogLoading = false
            notifyModelCatalog()
          })
      }
      function useModelCatalog() {
        const snap = useSyncExternalStore(
          (cb) => { modelCatalogListeners.add(cb); return () => modelCatalogListeners.delete(cb) },
          () => modelCatalogCache,
          () => modelCatalogCache,
        )
        useEffect(() => { loadModelCatalog(false) }, [])
        return snap
      }

      function ModelPicker({ value, onChange }) {
        const catalog = useModelCatalog()
        const loadError = catalog && catalog.error ? catalog.error : null
        const selectId = useMemo(() => 'kg-model-select-' + Math.random().toString(36).slice(2), [])
        const chosen = parseModelKey(value)
        const flat = []
        if (catalog) {
          for (const p of catalog.providers) {
            for (const m of p.models || []) flat.push({ key: p.id + MODEL_KEY_SEP + m.id, name: p.name + ' · ' + m.name })
          }
        }
        if (chosen && !flat.some((opt) => opt.key === value)) {
          flat.push({ key: value, name: chosen.provider + ' · ' + chosen.model + '（已保存）' })
        }
        const current = catalog && catalog.current && typeof catalog.current.provider === 'string' && typeof catalog.current.model === 'string'
          ? catalog.current
          : null
        const defaultLabel = '跟随系统默认' + (current ? '（' + current.provider + ' · ' + current.model + '）' : '')
        return h('span', { className: 'kg-model-picker', title: loadError || '选择拆分、追加、AI 审校、质疑与外部核查使用的模型' },
          h('label', { className: 'kg-model-label', htmlFor: selectId }, '模型'),
          h('select', {
            id: selectId,
            className: 'kg-model-select', value, 'aria-label': '选择 AI 模型',
            disabled: !catalog && !loadError,
            onChange: (e) => onChange(e.target.value),
          },
            h('option', { value: '' }, catalog ? defaultLabel : (loadError ? '跟随系统默认（目录不可用）' : '正在读取模型目录…')),
            flat.map((opt) => h('option', { key: opt.key, value: opt.key }, opt.name)),
          ),
          loadError ? h('button', { type: 'button', className: 'kg-model-refresh', 'aria-label': '重新读取模型目录', title: '重新读取模型目录', onClick: () => loadModelCatalog(true) }, '↻') : null,
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
          return 'layered'
        })
        const [chapterFilter, setChapterFilter] = useState('all')
        const [graphWindowLoading, setGraphWindowLoading] = useState(false)
        const [graphPageDraft, setGraphPageDraft] = useState('1')
        const [graphQueryDraft, setGraphQueryDraft] = useState('')
        const [candidateReviews, setCandidateReviews] = useState(() => loadCandidateReviews())
        const [candidateRemote, setCandidateRemote] = useState(null)
        const changeLayoutMode = (id) => {
          setLayoutMode(id)
          try { localStorage.setItem(LS_LAYOUT, id) } catch (e) {}
        }
        const [modelChoice, setModelChoice] = useState(readModelChoice)
        const modelCatalog = useModelCatalog()
        const handleModelChange = (key) => {
          setModelChoice(key)
          writeModelChoice(key)
        }
        const modelArg = parseModelKey(modelChoice)
        // "跟随系统默认" is still an explicit payload once the catalog is
        // loaded: sending the current default avoids host-side resolution.
        const effectiveModelArg = modelArg || (
          modelCatalog && modelCatalog.current && typeof modelCatalog.current.provider === 'string' && typeof modelCatalog.current.model === 'string'
            ? modelCatalog.current
            : null
        )
        const colsRef = useRef(null)
        const splitDragRef = useRef(null)
        const hHandleRef = useRef(null)
        const hDragRef = useRef(null)
        const submittedRef = useRef(null)
        const resumeAttemptRef = useRef(false)
        const graphRevisionRef = useRef(0)
        const graphCommitQueueRef = useRef(Promise.resolve())
        // ---- 划线拆分（select-text -> extract）----
        const [selectionText, setSelectionText] = useState(null)
        const suppressClickRef = useRef(false)
        const taRef = useRef(null)
        const [taSel, setTaSel] = useState(null)
        // ---- 追加拆分（incremental merge）----
        const [fullText, setFullText] = useState('') // accumulated source across appends
        const [currentHistoryId, setCurrentHistoryId] = useState(null)
        const [appendCount, setAppendCount] = useState(0)
        // ---- 验证 / 质疑（verify & question）----
        const [verification, setVerification] = useState(null) // VerificationReport | null
        const [verifyPhase, setVerifyPhase] = useState('idle') // idle | running
        const [verifyTaskId, setVerifyTaskId] = useState(null)
        const [activeIssueId, setActiveIssueId] = useState(null)
        const [issueFilter, setIssueFilter] = useState('all')
        const [questionDraft, setQuestionDraft] = useState('')
        const [questionTarget, setQuestionTarget] = useState(null) // {kind,id} | null
        const [questionResult, setQuestionResult] = useState(null)
        const [questionPhase, setQuestionPhase] = useState('idle') // idle | running
        const [questionTaskId, setQuestionTaskId] = useState(null)
        const [factReport, setFactReport] = useState(null)
        const [factPhase, setFactPhase] = useState('idle')
        const [factTaskId, setFactTaskId] = useState(null)
        const [factActiveId, setFactActiveId] = useState(null)
        const [factRules, setFactRules] = useState('')
        const [verifyProgress, setVerifyProgress] = useState(null)
        const [factProgress, setFactProgress] = useState(null)
        const [extractProgress, setExtractProgress] = useState(null)
        const verifyBusyRef = useRef(false)
        const verificationRef = useRef(null)
        const verifyGenRef = useRef(0)
        const factGenRef = useRef(0)
        const factReportRef = useRef(null)
        useEffect(() => { verificationRef.current = verification }, [verification])
        useEffect(() => { factReportRef.current = factReport }, [factReport])
        useEffect(() => {
          const meta = resultView && resultView.graph ? graphViewMetadata(resultView.graph) : null
          if (!meta) return
          setGraphPageDraft(String(meta.page))
          setGraphQueryDraft(meta.kind === 'query' ? meta.query : '')
        }, [resultView && resultView.graph && resultView.graph.view ? resultView.graph.view.nodeOffset : -1, resultView && resultView.graph && resultView.graph.view ? resultView.graph.view.kind : 'none', resultView && resultView.graph && resultView.graph.view ? resultView.graph.view.query : ''])
        // Cancel any in-flight verification/question/fact-check tasks; bumping
        // the generations invalidates stale polling callbacks.
        const cancelVerifyTasks = () => {
          verifyGenRef.current += 1
          factGenRef.current += 1
          setVerifyTaskId(null)
          setQuestionTaskId(null)
          setFactTaskId(null)
          setVerifyPhase('idle')
          setQuestionPhase('idle')
          setFactPhase('idle')
          verifyBusyRef.current = false
          setQuestionResult(null)
          setVerifyProgress(null)
          setFactProgress(null)
          setExtractProgress(null)
        }

        // ---- restore pending task / saved document reference / small draft ----
        useEffect(() => {
          let disposed = false
          try { for (const key of LEGACY_LARGE_STORAGE_KEYS) localStorage.removeItem(key) } catch (e) {}
          ;(async () => {
            let pending = null
            let saved = null
            let draft = null
            try { pending = JSON.parse(localStorage.getItem(LS_PENDING) || 'null') } catch (e) {}
            try { saved = JSON.parse(localStorage.getItem(LS_RESULT) || 'null') } catch (e) {}
            try { draft = JSON.parse(localStorage.getItem(LS_DRAFT) || 'null') } catch (e) {}
            if (pending && pending.taskId) {
              setTitle(typeof pending.title === 'string' ? pending.title : '')
              setTaskId(pending.taskId)
              setPhase('extracting')
              submittedRef.current = {
                title: typeof pending.title === 'string' ? pending.title : '',
                text: '',
                append: pending.append === true,
                baseText: '',
                documentId: typeof pending.documentId === 'string' ? pending.documentId : '',
                prevEdgeCount: -1,
              }
              return
            }
            if (saved && typeof saved.documentId === 'string' && saved.documentId) {
              try {
                const loaded = await host.call('document-load', { documentId: saved.documentId })
                if (disposed) return
                if (loaded && !loaded.error && loaded.graph && Array.isArray(loaded.graph.nodes)) {
                  const src = typeof loaded.sourceText === 'string' ? loaded.sourceText : ''
                  const g = loaded.graph
                  graphRevisionRef.current = Number.isInteger(loaded.revision) ? loaded.revision : (g.source && Number.isInteger(g.source.revision) ? g.source.revision : 0)
                  setTitle(typeof saved.title === 'string' && saved.title ? saved.title : ((g.source && g.source.title) || ''))
                  setText(src)
                  setFullText(src)
                  setResultView(makeView(g, src))
                  const ver = g.verification && g.verification.lastReport
                  setVerification(ver && ver.issues ? ver : null)
                  const fact = g.factCheck && g.factCheck.lastReport
                  setFactReport(fact && fact.claims ? fact : null)
                  setPhase('done')
                  setInputCollapsed(true)
                  const match = history.find((entry) => entry && entry.documentId === saved.documentId)
                  setCurrentHistoryId(match ? match.id : null)
                  return
                }
              } catch (e) { /* fall through to small draft */ }
            }
            if (draft) {
              setTitle(typeof draft.title === 'string' ? draft.title : '')
              setText(typeof draft.text === 'string' ? draft.text : '')
            }
          })()
          return () => { disposed = true }
        }, [])

        useEffect(() => {
          // localStorage is UI state, not the book store. Keep only a modest
          // pre-submit draft; large sources live in Host/SQLite after submit.
          try {
            if (text.length <= 64 * 1024) localStorage.setItem(LS_DRAFT, JSON.stringify({ title, text }))
            else localStorage.removeItem(LS_DRAFT)
          } catch (e) {}
        }, [title, text])

        // ---- consume page-selection inbox (chat 划线 -> knowledge graph) ----
        const selIn = useSyncExternalStore(selStore.subscribe, selStore.get)
        useEffect(() => {
          if (!selIn || !selIn.text) return
          selStore.clear()
          setTitle('')
          setText(selIn.text)
          if (resultView && resultView.graph && Array.isArray(resultView.graph.nodes)) {
            toastStore.show('正在把选中的 ' + selIn.text.length + ' 字追加到当前知识图...')
            appendSubmit(selIn.text)
          } else {
            toastStore.show('正在把选中的 ' + selIn.text.length + ' 字拆分为知识图...')
            submit(selIn.text)
          }
        }, [selIn ? selIn.seq : 0])

        // ---- consume composer attachment request (附件文档 -> knowledge graph) ----
        const docReq = useSyncExternalStore(docStore.subscribe, docStore.get)
        useEffect(() => {
          if (!docReq || !docReq.sessionId) return
          let disposed = false
          ;(async () => {
            try {
              const res = await host.call('document-import', { sessionId: docReq.sessionId, pending: docReq.pendingText })
              if (disposed) return
              docStore.clear()
              if (res && res.error) { setError(res.error); return }
              if (!res || !res.text || !res.text.trim()) { setError({ message: '附件文档没有可用的正文' }); return }
              const warnings = Array.isArray(res.warnings) ? res.warnings : []
              resetAll()
              setTitle(typeof res.title === 'string' ? res.title : '')
              setText(res.text)
              setFullText(res.text)
              if (warnings.length > 0) setError({ message: warnings.join('；') })
              toastStore.show('已读取 ' + (Array.isArray(res.files) ? res.files.length : 1) + ' 个附件文档，开始生成知识图…')
              submit(res.text, typeof res.title === 'string' ? res.title : '', res.manifest && typeof res.manifest.documentId === 'string' ? res.manifest.documentId : '')
            } catch (e) {
              if (disposed) return
              setError({ message: '读取附件文档失败：' + (e && e.message ? e.message : '未知错误') })
            }
          })()
          return () => { disposed = true }
        }, [docReq ? docReq.seq : 0])
         const candidateSyncKey = resultView && resultView.graph
           ? ((resultView.graph.source && resultView.graph.source.documentId) || '') + '|' + (resultView.graph.nodes || []).length + '|' + (resultView.graph.edges || []).length + '|' + ((resultView.graph.staging && resultView.graph.staging.chunkCount) || 0)
           : ''
         useEffect(() => {
           if (!resultView || !resultView.graph || !candidateSyncKey) {
             setCandidateRemote(null)
             return undefined
           }
           let disposed = false
           ;(async () => {
             try {
               const source = resultView.graph.source && typeof resultView.graph.source === 'object' ? resultView.graph.source : {}
               const res = await host.call('candidate-list', {
                 documentId: source.documentId || '',
                 graph: candidateGraphPayload(resultView.graph),
                 kind: 'all', status: 'all', limit: 500,
               })
               if (disposed) return
               const rows = res && Array.isArray(res.candidates) ? res.candidates : []
               setCandidateRemote(rows)
               if (rows.length > 0) {
                 setCandidateReviews((previous) => {
                   const next = { ...previous }
                   for (const row of rows) {
                     if (!row || !row.kind || !row.nodeId) continue
                     const key = (row.documentId || source.documentId || 'local') + '|' + row.kind + '|' + row.nodeId
                     if (REVIEW_STATUS_ORDER.includes(row.status)) next[key] = row.status
                   }
                   saveCandidateReviews(next)
                   return next
                 })
               }
             } catch (error) {
               if (!disposed) setCandidateRemote(null)
             }
           })()
           return () => { disposed = true }
         }, [candidateSyncKey])
         const loadGraphWindow = async ({ page, query } = {}) => {
           if (!resultView || !resultView.graph || graphWindowLoading) return false
           const documentId = documentIdOfGraph(resultView.graph)
           const currentMeta = graphViewMetadata(resultView.graph)
           if (!documentId || !currentMeta) return false
           const queryText = typeof query === 'string' ? query.trim().slice(0, 200) : ''
           const targetPage = queryText
             ? 1
             : Math.max(1, Math.min(currentMeta.pageCount, Number.isInteger(page) ? page : currentMeta.page))
           const nodeOffset = queryText ? 0 : (targetPage - 1) * currentMeta.nodeLimit
           if (!queryText && currentMeta.kind === 'window' && currentMeta.nodeOffset === nodeOffset) {
             setGraphPageDraft(String(targetPage))
             return true
           }
           if (queryText && currentMeta.kind === 'query' && currentMeta.query === queryText) return true
           setGraphWindowLoading(true)
           setError(null)
           try {
             // Do not navigate away from an uncommitted UI patch. This also
             // ensures the next window is loaded at the latest canonical revision.
             await graphCommitQueueRef.current.catch(() => {})
             const loaded = await host.call('document-load', {
               documentId,
               nodeOffset,
               includeSourceText: false,
               ...(queryText ? { query: queryText } : {}),
             })
             if (!loaded || loaded.error || !loaded.graph || !Array.isArray(loaded.graph.nodes)) {
               const err = loaded && loaded.error ? loaded.error : { message: '无法加载知识图窗口' }
               setError(err)
               return false
             }
             const sourceText = typeof loaded.sourceText === 'string' && loaded.sourceText
               ? loaded.sourceText
               : (fullText || resultView.sourceText || '')
             const nextGraph = loaded.graph
             graphRevisionRef.current = Number.isInteger(loaded.revision)
               ? loaded.revision
               : (nextGraph.source && Number.isInteger(nextGraph.source.revision) ? nextGraph.source.revision : graphRevisionRef.current)
             setResultView(makeView(nextGraph, sourceText))
             setText(sourceText)
             setFullText(sourceText)
             setChapterFilter('all')
             setSelectedNodeId(null)
             setSelectedEdgeId(null)
             setActivePara(-1)
             setFocusReq((value) => ({ nodeId: null, seq: value.seq + 1 }))
             const ver = nextGraph.verification && nextGraph.verification.lastReport
             setVerification(ver && ver.issues ? ver : null)
             const fact = nextGraph.factCheck && nextGraph.factCheck.lastReport
             setFactReport(fact && fact.claims ? fact : null)
             const nextMeta = graphViewMetadata(nextGraph)
             if (nextMeta) {
               setGraphPageDraft(String(nextMeta.page))
               if (nextMeta.kind === 'query') {
                 setGraphQueryDraft(nextMeta.query)
                 toastStore.show('子图查询完成：匹配 ' + (nextMeta.matchedNodes || 0) + ' 个节点，当前显示 ' + nextMeta.visibleNodes + ' 个节点（含一跳邻居）')
               } else {
                 setGraphQueryDraft('')
                 toastStore.show('已加载节点 ' + nextMeta.startNode + '–' + nextMeta.endNode + ' / ' + nextMeta.totalNodes)
               }
             }
             return true
           } catch (e) {
             setError({ message: '加载知识图窗口失败：' + (e && e.message ? e.message : '未知错误') })
             return false
           } finally {
             setGraphWindowLoading(false)
           }
         }
         const jumpGraphPage = () => {
           const meta = resultView && resultView.graph ? graphViewMetadata(resultView.graph) : null
           if (!meta) return
           const parsed = parseInt(graphPageDraft, 10)
           const page = Number.isInteger(parsed) ? Math.max(1, Math.min(meta.pageCount, parsed)) : meta.page
           setGraphPageDraft(String(page))
           loadGraphWindow({ page, query: '' })
         }
         const runGraphQuery = () => {
           const query = graphQueryDraft.trim()
           if (!query) loadGraphWindow({ page: 1, query: '' })
           else loadGraphWindow({ query })
         }
         const clearGraphQuery = () => {
           setGraphQueryDraft('')
           loadGraphWindow({ page: 1, query: '' })
         }

         const resumeLostTask = async () => {
           // Recovery is only for a task that disappeared because the Host was
           // restarted. Failed/cancelled tasks are terminal and are never
           // resubmitted automatically.
           if (resumeAttemptRef.current) return false
           let pending = null
           try { pending = JSON.parse(localStorage.getItem(LS_PENDING) || 'null') } catch (e) {}
           if (!pending || typeof pending.taskId !== 'string' || !pending.taskId) return false
           resumeAttemptRef.current = true
           try {
             const resumed = await host.call('resume-extract', {
               runId: pending.taskId,
               ...(effectiveModelArg ? { model: effectiveModelArg } : {}),
             })
             if (!resumed || resumed.error || !resumed.taskId) {
               setError(resumed && resumed.error ? resumed.error : { message: 'Host 没有可安全恢复的持久化 checkpoint' })
               return false
             }
             submittedRef.current = {
               title: typeof pending.title === 'string' ? pending.title : '',
               text: '',
               documentId: typeof pending.documentId === 'string' ? pending.documentId : '',
               append: pending.append === true,
               baseText: '',
               prevEdgeCount: -1,
             }
             setTaskId(resumed.taskId)
             setPhase('extracting')
             setExtractProgress(null)
             toastStore.show('检测到 Host 重启遗留的运行中任务，已从 SQLite checkpoint 安全续跑')
             return true
           } catch (e) {
             setError({ message: '续跑任务提交失败：' + (e && e.message ? e.message : '未知错误') })
             return false
           }
         }

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
            if (res && res.status === 'running') setExtractProgress(res.progress || null)
            if (res && res.status === 'succeeded') {
              let g = res.result
              if (g && Array.isArray(g.nodes)) {
                const sub = submittedRef.current || { title: '', text: '' }
                const documentId = documentIdOfGraph(g) || (typeof sub.documentId === 'string' ? sub.documentId : '')
                let viewText = typeof sub.text === 'string' ? sub.text : ''
                if (documentId) {
                  try {
                    const loaded = await host.call('document-load', { documentId })
                    if (disposed) return
                    if (loaded && !loaded.error && loaded.graph && Array.isArray(loaded.graph.nodes)) {
                      g = loaded.graph
                      viewText = typeof loaded.sourceText === 'string' ? loaded.sourceText : viewText
                      graphRevisionRef.current = Number.isInteger(loaded.revision)
                        ? loaded.revision
                        : (g.source && Number.isInteger(g.source.revision) ? g.source.revision : 0)
                    }
                  } catch (e) { /* current in-memory result remains usable */ }
                }
                if (!viewText && sub.append === true) {
                  const base = typeof sub.baseText === 'string' ? sub.baseText : ''
                  viewText = base ? base + NL + NL + (sub.text || '') : (sub.text || '')
                }
                // Append invalidates previous reports. Persisting this metadata
                // goes through the same revisioned canonical commit path below.
                const prevVer = verificationRef.current
                const prevFact = factReportRef.current
                let g2 = g
                let reportMetadataChanged = false
                if (prevVer && prevVer.issues) {
                  const staleReport = { ...prevVer, stale: true }
                  g2 = withVerification(g2, staleReport, true)
                  setVerification(staleReport)
                  reportMetadataChanged = true
                } else {
                  setVerification(null)
                }
                if (prevFact && Array.isArray(prevFact.claims)) {
                  const staleFact = { ...prevFact, stale: true }
                  g2 = withFactCheck(g2, staleFact, true)
                  setFactReport(staleFact)
                  reportMetadataChanged = true
                } else {
                  setFactReport(null)
                }
                setText(viewText)
                setFullText(viewText)
                setResultView(makeView(g2, viewText))
                setSelectedNodeId(null)
                setSelectedEdgeId(null)
                setActivePara(-1)
                setPhase('done')
                setTaskId(null)
                setExtractProgress(null)
                setInputCollapsed(true)
                const entryId = (sub.append === true || sub.relationRetry === true) && currentHistoryId ? currentHistoryId : 'h-' + Date.now()
                setCurrentHistoryId(entryId)
                setHistory((prev) => appendHistory(prev, {
                  id: entryId,
                  title: sub.title || ((g2.source && g2.source.title) || title),
                  documentId,
                  graph: g2,
                  ts: Date.now(),
                }))
                if (sub.relationRetry === true) {
                  const connectivity = g2.generation && g2.generation.connectivity
                  const added = connectivity && Number(connectivity.addedEdges || 0)
                  toastStore.show('关系补全完成：新增 ' + added + ' 条关系')
                } else if (sub.append === true) {
                  setAppendCount((c) => c + 1)
                  const added = Array.isArray(g2.addedNodeIds) ? g2.addedNodeIds.length : 0
                  toastStore.show('追加完成：新增 ' + added + ' 个节点，全文 ' + splitParagraphs(viewText).length + ' 段')
                } else {
                  setAppendCount(0)
                }
                if (reportMetadataChanged) persistGraph(g2, g)
                try {
                  localStorage.removeItem(LS_PENDING)
                  if (documentId) localStorage.setItem(LS_RESULT, JSON.stringify({ title: sub.title || title, documentId, ts: Date.now() }))
                } catch (e) {}
              } else {
                setPhase('idle')
                setTaskId(null)
                setExtractProgress(null)
                setError({ message: 'AI 返回的结果缺少图数据，请重试' })
              }
              return
            }
            if ((res && res.status === 'failed') || (res && res.status === 'cancelled')) {
              setPhase('idle')
              setTaskId(null)
              setExtractProgress(null)
              // A task that explicitly failed is never auto-resumed. Only a
              // missing in-memory task may be a Host-restart recovery case.
              try { localStorage.removeItem(LS_PENDING) } catch (e) {}
              const err = res.error || {}
              const submitted = submittedRef.current || {}
              setError({ code: err.code, message: err.message || (res.status === 'cancelled' ? '任务已取消' : (submitted.relationRetry ? '关系补全失败，请稍后重试' : 'AI 拆分失败，请稍后重试')) })
              return
            }
            if (res && res.status === 'not_found') {
              setPhase('idle')
              setTaskId(null)
              setExtractProgress(null)
              if (await resumeLostTask()) return
              try { localStorage.removeItem(LS_PENDING) } catch (e) {}
              setError((previous) => previous || { message: '拆分任务已过期，且没有可安全恢复的 SQLite checkpoint，请重新提交' })
              return
            }
            if (Date.now() - start > 60 * 1000) delay = Math.min(delay * 1.5, 15000)
            stop = ctx.timeout(tick, delay)
          }
          tick()
          return () => { disposed = true; if (stop) stop() }
        }, [taskId])

        // ---- verification task polling ----
        useEffect(() => {
          if (!verifyTaskId) return
          let disposed = false
          let stop = null
          let delay = 3000
          const myGen = verifyGenRef.current
          const start = Date.now()
          const tick = async () => {
            if (disposed || myGen !== verifyGenRef.current) return
            let res = null
            try {
              res = await host.call('task-status', { taskId: verifyTaskId })
            } catch (e) {
              if (disposed || myGen !== verifyGenRef.current) return
              setVerifyPhase('idle'); setVerifyTaskId(null)
              setError({ message: '查询验证任务失败：' + (e && e.message ? e.message : '未知错误') })
              return
            }
            if (disposed || myGen !== verifyGenRef.current) return
            if (res && res.status === 'running') setVerifyProgress(res.progress || null)
            if (res && res.status === 'succeeded' && res.result) {
              const report = res.result
              if (report && Array.isArray(report.issues)) {
                setVerification(report)
                if (resultView) {
                  const g2 = withVerification(resultView.graph, report, false)
                  setResultView(makeView(g2, resultView.sourceText))
                  persistGraph(g2)
                }
              }
              setVerifyPhase('idle'); setVerifyTaskId(null); setVerifyProgress(null)
              verifyBusyRef.current = false
              toastStore.show('知识图验证完成')
              return
            }
            if (res && res.status === 'failed' || res && res.status === 'cancelled') {
              setVerifyPhase('idle'); setVerifyTaskId(null); setVerifyProgress(null); verifyBusyRef.current = false
              const err = res.error || {}
              setError({ code: err.code, message: err.message || (res.status === 'cancelled' ? '任务已取消' : 'AI 审校失败，请稍后重试') })
              return
            }
            if (res && res.status === 'not_found') {
              setVerifyPhase('idle'); setVerifyTaskId(null); setVerifyProgress(null); verifyBusyRef.current = false
              setError({ message: '验证任务已过期（服务可能已重启），请重新验证' })
              return
            }
            if (Date.now() - start > 60 * 1000) delay = Math.min(delay * 1.5, 15000)
            stop = ctx.timeout(tick, delay)
          }
          tick()
          return () => { disposed = true; if (stop) stop() }
        }, [verifyTaskId])

        // ---- question task polling ----
        useEffect(() => {
          if (!questionTaskId) return
          let disposed = false
          let stop = null
          let delay = 3000
          const myGen = verifyGenRef.current
          const start = Date.now()
          const tick = async () => {
            if (disposed || myGen !== verifyGenRef.current) return
            let res = null
            try {
              res = await host.call('task-status', { taskId: questionTaskId })
            } catch (e) {
              if (disposed || myGen !== verifyGenRef.current) return
              setQuestionPhase('idle'); setQuestionTaskId(null)
              setError({ message: '查询质疑任务失败：' + (e && e.message ? e.message : '未知错误') })
              return
            }
            if (disposed || myGen !== verifyGenRef.current) return
            if (res && res.status === 'running') setVerifyProgress(res.progress || null)
            if (res && res.status === 'succeeded' && res.result) {
              setQuestionResult(res.result)
              setQuestionPhase('idle'); setQuestionTaskId(null); setVerifyProgress(null)
              toastStore.show('质疑判定完成')
              return
            }
            if (res && res.status === 'failed' || res && res.status === 'cancelled') {
              setQuestionPhase('idle'); setQuestionTaskId(null); setVerifyProgress(null)
              const err = res.error || {}
              setError({ code: err.code, message: err.message || (res.status === 'cancelled' ? '任务已取消' : 'AI 质疑判定失败，请稍后重试') })
              return
            }
            if (res && res.status === 'not_found') {
              setQuestionPhase('idle'); setQuestionTaskId(null); setVerifyProgress(null)
              setError({ message: '质疑任务已过期（服务可能已重启），请重新提问' })
              return
            }
            if (Date.now() - start > 60 * 1000) delay = Math.min(delay * 1.5, 15000)
            stop = ctx.timeout(tick, delay)
          }
          tick()
          return () => { disposed = true; if (stop) stop() }
        }, [questionTaskId])

        // ---- external fact-check task polling ----
        useEffect(() => {
          if (!factTaskId) return
          let disposed = false
          let stop = null
          let delay = 3000
          const myGen = factGenRef.current
          const start = Date.now()
          const tick = async () => {
            if (disposed || myGen !== factGenRef.current) return
            let res = null
            try {
              res = await host.call('task-status', { taskId: factTaskId })
            } catch (e) {
              if (disposed || myGen !== factGenRef.current) return
              setFactPhase('idle'); setFactTaskId(null)
              setError({ message: '查询外部核查任务失败：' + (e && e.message ? e.message : '未知错误') })
              return
            }
            if (disposed || myGen !== factGenRef.current) return
            if (res && res.status === 'running') setFactProgress(res.progress || null)
            if (res && res.status === 'succeeded' && res.result) {
              const report = res.result
              if (report && Array.isArray(report.claims)) {
                setFactReport(report)
                if (resultView) {
                  const g2 = withFactCheck(resultView.graph, report, false)
                  setResultView(makeView(g2, resultView.sourceText))
                  persistGraph(g2)
                }
              }
              setFactPhase('idle'); setFactTaskId(null); setFactProgress(null)
              toastStore.show('外部事实核查完成')
              return
            }
            if (res && res.status === 'failed' || res && res.status === 'cancelled') {
              setFactPhase('idle'); setFactTaskId(null); setFactProgress(null)
              const err = res.error || {}
              setError({ code: err.code, message: err.message || (res.status === 'cancelled' ? '任务已取消' : 'AI 外部事实核查失败，请稍后重试') })
              return
            }
            if (res && res.status === 'not_found') {
              setFactPhase('idle'); setFactTaskId(null); setFactProgress(null)
              setError({ message: '外部核查任务已过期（服务可能已重启），请重新核查' })
              return
            }
            if (Date.now() - start > 60 * 1000) delay = Math.min(delay * 1.5, 15000)
            stop = ctx.timeout(tick, delay)
          }
          tick()
          return () => { disposed = true; if (stop) stop() }
        }, [factTaskId])

        const submit = async (overrideText, overrideTitle, overrideDocumentId) => {
          const t = (overrideText != null ? overrideText : text).trim()
          const ti = typeof overrideTitle === 'string' && overrideTitle.trim() ? overrideTitle.trim().slice(0, 200) : title
          if (!t) { setError({ message: '请先粘贴资料正文' }); return }
          if (t.length > MAX_LEN) { setError({ message: '资料正文不能超过 ' + MAX_LEN + ' 字' }); return }
          if (overrideTitle != null) setTitle(ti)
          if (overrideText != null) setText(t)
          cancelVerifyTasks()
          setError(null)
          const payload = {
             title: ti,
             text: t,
             ...(typeof overrideDocumentId === 'string' && overrideDocumentId.trim() ? { documentId: overrideDocumentId.trim().slice(0, 160) } : {}),
             ...(effectiveModelArg ? { model: effectiveModelArg } : {}),
            }
          resumeAttemptRef.current = false
          submittedRef.current = { ...payload, append: false }
          setExtractProgress(null)
          setPhase('extracting')
          setResultView(null)
           setChapterFilter('all')
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
              localStorage.setItem(LS_PENDING, JSON.stringify({ taskId: res.taskId, title: ti, documentId: payload.documentId || '', append: false, ts: Date.now() }))
            } catch (e) {}
          } catch (e) {
            setPhase('idle')
            setError({ message: '无法提交拆分任务：' + (e && e.message ? e.message : '未知错误') })
          }
        }

        // Incremental append: send the NEW text plus the existing graph to the
        // host; the AI only produces new nodes (edges may reference existing
        // node ids) and the host returns the MERGED graph.
        const appendSubmit = async (overrideText) => {
          const t = (overrideText != null ? overrideText : text).trim()
          if (!t) { setError({ message: '请先粘贴要追加的资料正文' }); return }
          if (t.length > MAX_LEN) { setError({ message: '追加正文不能超过 ' + MAX_LEN + ' 字' }); return }
          if (!resultView || !resultView.graph || !Array.isArray(resultView.graph.nodes)) {
            setError({ message: '请先完成一次拆分，再追加内容' })
            return
          }
          cancelVerifyTasks()
          setError(null)
          const baseText = fullText || ''
          const offset = baseText ? splitParagraphs(baseText).length : 0
          const documentId = resultView.graph.source && resultView.graph.source.documentId ? resultView.graph.source.documentId : ''
          const payload = {
            title,
            text: t,
            paragraphOffset: offset,
            documentId,
            // Canonical knowledge lives in Host/SQLite. Only legacy/dynamic
            // graphs without a document id need a client-side fallback graph.
            ...(!documentId ? { existing: {
              summary: typeof resultView.graph.summary === 'string' ? resultView.graph.summary : '',
              nodes: resultView.graph.nodes,
              edges: resultView.graph.edges,
              source: resultView.graph.source,
              staging: resultView.graph.staging,
            } } : {}),
            ...(effectiveModelArg ? { model: effectiveModelArg } : {}),
          }
          resumeAttemptRef.current = false
          submittedRef.current = { title, text: t, append: true, baseText, documentId, prevEdgeCount: (resultView.graph.edges || []).length }
          setExtractProgress(null)
          setPhase('extracting')
          setSelectedNodeId(null)
          setSelectedEdgeId(null)
          setActivePara(-1)
          setHistoryOpen(false)
          try {
            const res = await host.call('append-extract', payload)
            if (res && res.error) {
              setPhase('idle')
              setError(res.error)
              return
            }
            if (!res || !res.taskId) {
              setPhase('idle')
              setError({ message: '无法提交追加任务，请重试' })
              return
            }
            setTaskId(res.taskId)
            try {
              localStorage.setItem(LS_PENDING, JSON.stringify({ taskId: res.taskId, title, append: true, documentId: payload.documentId || '', ts: Date.now() }))
            } catch (e) {}
          } catch (e) {
            setPhase('idle')
            setError({ message: '无法提交追加任务：' + (e && e.message ? e.message : '未知错误') })
          }
        }

        const retryRelations = async () => {
          if (!resultView || !resultView.graph) return
          const graph = resultView.graph
          const documentId = documentIdOfGraph(graph)
          if (!documentId) {
            setError({ message: '当前知识图没有 canonical documentId，无法单独补全关系' })
            return
          }
          cancelVerifyTasks()
          setError(null)
          const payload = {
            documentId,
            expectedRevision: graphRevisionRef.current || (graph.source && graph.source.revision) || 0,
            ...(effectiveModelArg ? { model: effectiveModelArg } : {}),
          }
          submittedRef.current = {
            title: (graph.source && graph.source.title) || title,
            text: fullText || resultView.sourceText || '',
            documentId,
            append: false,
            relationRetry: true,
          }
          setExtractProgress(null)
          setPhase('extracting')
          setSelectedNodeId(null)
          setSelectedEdgeId(null)
          setActivePara(-1)
          try {
            const res = await host.call('relation-retry', payload)
            if (res && res.error) {
              setPhase('done')
              setError(res.error)
              return
            }
            if (!res || !res.taskId) {
              setPhase('done')
              setError({ message: '无法提交关系补全任务，请重试' })
              return
            }
            setTaskId(res.taskId)
          } catch (error) {
            setPhase('done')
            setError({ message: '无法提交关系补全任务：' + (error && error.message ? error.message : '未知错误') })
          }
        }

        // Detect a mouse/keyboard text selection inside the original-text
        // column and offer to split JUST that selection into a knowledge graph.
        const detectSelection = () => {
          const sel = window.getSelection()
          let t = sel ? sel.toString().trim() : ''
          if (t.length > 0) {
            const node = sel.anchorNode
            const el = node && node.nodeType === 3 ? node.parentElement : node
            if (el && typeof el.closest === 'function' && el.closest('.kg-original')) {
              suppressClickRef.current = true
              setSelectionText(t)
              return
            }
          }
          setSelectionText(null)
        }
        const splitSelection = () => {
          const t = selectionText
          setSelectionText(null)
          if (!t) return
          setText(t)
          toastStore.show('正在把选中的 ' + t.length + ' 字拆分为知识图...')
          submit(t)
        }
        const onTaSelect = () => {
          const ta = taRef.current
          if (!ta) return
          const start = ta.selectionStart
          const end = ta.selectionEnd
          if (end > start) {
            const t = ta.value.substring(start, end).trim()
            setTaSel(t.length > 0 ? t : null)
          } else {
            setTaSel(null)
          }
        }

        const resetAll = () => {
          try { localStorage.removeItem(LS_PENDING); localStorage.removeItem(LS_RESULT); localStorage.removeItem(LS_DRAFT) } catch (e) {}
           resumeAttemptRef.current = false
          cancelVerifyTasks()
          setTitle(''); setText(''); setTaskId(null); setPhase('idle'); setResultView(null)
           setChapterFilter('all'); setGraphWindowLoading(false); setGraphPageDraft('1'); setGraphQueryDraft('')
          setError(null); toastStore.clear(); setSelectedNodeId(null); setSelectedEdgeId(null)
          setFocusReq({ nodeId: null, seq: 0 }); setFlashPara(-1); setActivePara(-1); setShowDiag(false)
          setHistoryOpen(false)
          setInputCollapsed(false)
          setFullText(''); setCurrentHistoryId(null); setAppendCount(0)
          setVerification(null); setActiveIssueId(null); setIssueFilter('all')
          setFactReport(null); setFactPhase('idle'); setFactTaskId(null); setFactActiveId(null); setFactRules('')
          setQuestionDraft(''); setQuestionTarget(null); setQuestionResult(null)
        }

        // ---- verification / questioning actions ----
        const persistGraph = (g, baseGraph) => {
          const documentId = documentIdOfGraph(g)
          if (!documentId) return Promise.resolve(null)
          const baseline = baseGraph && typeof baseGraph === 'object'
            ? baseGraph
            : (resultView && resultView.graph ? resultView.graph : g)
          const rollbackText = fullText || (resultView && resultView.sourceText) || ''
          const edgeRevisionKey = (edge) => edge && edge.fromNodeId && edge.toNodeId
            ? edge.fromNodeId + '>' + edge.toNodeId + ':' + String(edge.relation || '')
            : ''
          const pendingOperations = semanticOperationsOf(g)
          const graphPayload = {
            summary: typeof g.summary === 'string' ? g.summary : '',
            nodes: Array.isArray(g.nodes) ? g.nodes : [],
            edges: Array.isArray(g.edges) ? g.edges : [],
            ...(g.verification && typeof g.verification === 'object' ? { verification: g.verification } : {}),
            ...(g.factCheck && typeof g.factCheck === 'object' ? { factCheck: g.factCheck } : {}),
          }
          const rememberLocalGraph = () => {
            try { localStorage.setItem(LS_RESULT, JSON.stringify({ title, documentId, ts: Date.now() })) } catch (e) {}
            setHistory((prev) => {
              const entryId = currentHistoryId || 'h-' + Date.now()
              return appendHistory(prev, { id: entryId, title, documentId, graph: g, ts: Date.now() })
            })
          }
          const describeCommitError = (error) => {
            const details = error && error.details && typeof error.details === 'object' ? error.details : error
            const issues = details && Array.isArray(details.issues) ? details.issues : []
            const suffix = issues.length > 0
              ? '：' + issues.slice(0, 5).map((issue) => [issue.code, issue.title, issue.targetId].filter(Boolean).join(' / ')).join('；')
              : ''
            return (details && details.message ? details.message : '知识图提交失败') + suffix
          }
          const restoreAfterCommitFailure = (error) => {
            const details = error && error.details && typeof error.details === 'object' ? error.details : error
            setError({ ...(details && typeof details === 'object' ? details : {}), message: describeCommitError(error) })
            if (details && details.code === 'revision_conflict') {
              toastStore.show('知识图版本已变化，已恢复未提交状态，请重新载入后再编辑')
            } else if (details && details.code === 'invariant_violation') {
              toastStore.show('确定性验收未通过，未更新 canonical graph，已恢复未提交状态')
            }
            graphSemanticOperations.delete(g)
            if (baseline && baseline !== g) {
              setResultView(makeView(baseline, rollbackText))
              const previousReport = baseline.verification && baseline.verification.lastReport ? baseline.verification.lastReport : null
              const previousFactReport = baseline.factCheck && baseline.factCheck.lastReport ? baseline.factCheck.lastReport : null
              setVerification(previousReport)
              setFactReport(previousFactReport)
            }
          }
          const queued = graphCommitQueueRef.current.catch(() => {}).then(async () => {
            const expectedRevision = graphRevisionRef.current
            const response = await host.call('graph-commit', {
              documentId,
              expectedRevision,
              graph: graphPayload,
              operations: pendingOperations,
              baseNodeIds: (Array.isArray(baseline.nodes) ? baseline.nodes : []).map((node) => node && node.id).filter(Boolean),
              baseEdgeKeys: (Array.isArray(baseline.edges) ? baseline.edges : []).map(edgeRevisionKey).filter(Boolean),
            })
            if (response && response.error) {
              const failure = new Error(response.error.message || 'graph commit failed')
              failure.details = response.error
              throw failure
            }
            if (response && Number.isInteger(response.revision)) graphRevisionRef.current = response.revision
            graphSemanticOperations.delete(g)
            rememberLocalGraph()
            return response
          }).catch((error) => {
            restoreAfterCommitFailure(error)
            return null
          })
          graphCommitQueueRef.current = queued
          return queued
        }
        const commitGraph = (g) => {
          if (!resultView) return
          const src = fullText || resultView.sourceText || ''
          const baseline = resultView.graph
          setResultView(makeView(g, src))
          persistGraph(g, baseline)
        }
        const attachReport = (report, stale) => {
          if (!resultView) return
          const baseline = resultView.graph
          const g2 = withVerification(baseline, report, stale)
          setResultView(makeView(g2, resultView.sourceText))
          persistGraph(g2, baseline)
        }
        const verificationSourcePayload = (source, graph) => {
          if (typeof source !== 'string' || source.length <= MAX_VERIFY_SCOPE_CHARS) return {}
          const paragraphs = splitParagraphs(source)
          const wanted = new Set()
          for (const node of Array.isArray(graph && graph.nodes) ? graph.nodes : []) {
            if (!node || !Number.isInteger(node.paragraph) || node.paragraph < 0 || node.paragraph >= paragraphs.length) continue
            wanted.add(node.paragraph)
            if (node.paragraph > 0) wanted.add(node.paragraph - 1)
            if (node.paragraph + 1 < paragraphs.length) wanted.add(node.paragraph + 1)
          }
          const sourceUnits = []
          let chars = 0
          for (const paragraph of Array.from(wanted).sort((a, b) => a - b)) {
            const text = paragraphs[paragraph] && typeof paragraphs[paragraph].text === 'string' ? paragraphs[paragraph].text.trim() : ''
            if (!text || chars + text.length > MAX_VERIFY_SCOPE_CHARS) continue
            sourceUnits.push({ paragraph, text })
            chars += text.length
          }
          // Override the caller's full `text` field when a scoped payload is
          // available. This bounds browser→Host wire size for book-scale text.
          return sourceUnits.length > 0 ? { text: '', sourceUnits } : {}
        }
        const startQuickVerify = async () => {
          if (!resultView || verifyBusyRef.current) return
          setError(null)
          setVerifyPhase('running')
          verifyBusyRef.current = true
          try {
            const payload = {
              title, text: fullText || resultView.sourceText || '',
              graph: { summary: resultView.graph.summary || '', nodes: resultView.graph.nodes, edges: resultView.graph.edges },
               ...verificationSourcePayload(fullText || resultView.sourceText || '', resultView.graph),
              mode: 'quick',
              ...(effectiveModelArg ? { model: effectiveModelArg } : {}),
            }
            const res = await host.call('verify-graph', payload)
            if (res && res.error) { setError(res.error); return }
            if (res && res.report) {
              const m = res.report.metrics || {}
              setVerification(res.report)
              attachReport(res.report, false)
              setActiveIssueId(null)
              toastStore.show('快速体检完成：确定性错误 ' + (m.errorCount || 0) + ' / 质量警告 ' + (m.warningCount || 0) + ' / 建议 ' + (m.suggestionCount || 0))
            } else {
              setError({ message: '快速体检没有返回报告，请重试' })
            }
          } catch (e) {
            setError({ message: '快速体检失败：' + (e && e.message ? e.message : '未知错误') })
          } finally {
            setVerifyPhase('idle')
            verifyBusyRef.current = false
          }
        }
        const startDeepVerify = async () => {
          if (!resultView || verifyBusyRef.current) return
          setError(null)
          setVerifyPhase('running')
          verifyBusyRef.current = true
          try {
            const payload = {
              title, text: fullText || resultView.sourceText || '',
              graph: { summary: resultView.graph.summary || '', nodes: resultView.graph.nodes, edges: resultView.graph.edges },
               ...verificationSourcePayload(fullText || resultView.sourceText || '', resultView.graph),
              mode: 'standard',
              ...(effectiveModelArg ? { model: effectiveModelArg } : {}),
            }
            const res = await host.call('verify-graph', payload)
            if (res && res.error) {
              setVerifyPhase('idle'); verifyBusyRef.current = false
              setError(res.error)
              return
            }
            if (res && res.taskId) {
              setVerifyTaskId(res.taskId)
            } else {
              setVerifyPhase('idle'); verifyBusyRef.current = false
              setError({ message: '无法提交验证任务，请重试' })
            }
          } catch (e) {
            setVerifyPhase('idle'); verifyBusyRef.current = false
            setError({ message: '无法提交验证任务：' + (e && e.message ? e.message : '未知错误') })
          }
        }
        const startFactCheck = async () => {
          if (!resultView || factPhase === 'running') return
          setError(null)
          setFactPhase('running')
          try {
            const payload = {
              title, text: fullText || resultView.sourceText || '',
              graph: { summary: resultView.graph.summary || '', nodes: resultView.graph.nodes, edges: resultView.graph.edges },
               ...verificationSourcePayload(fullText || resultView.sourceText || '', resultView.graph),
              mode: 'deep',
              sources: factRules.trim() ? ['wikipedia', 'rules'] : ['wikipedia'],
              rules: factRules.trim(),
              ...(effectiveModelArg ? { model: effectiveModelArg } : {}),
            }
            const res = await host.call('fact-check', payload)
            if (res && res.error) { setFactPhase('idle'); setError(res.error); return }
            if (res && res.taskId) {
              setFactTaskId(res.taskId)
            } else {
              setFactPhase('idle')
              setError({ message: '无法提交外部核查任务，请重试' })
            }
          } catch (e) {
            setFactPhase('idle')
            setError({ message: '无法提交外部核查任务：' + (e && e.message ? e.message : '未知错误') })
          }
        }
        const handleCancelExtract = async () => {
          if (!taskId) return
          try {
            const res = await host.call('task-cancel', { taskId })
            if (res && res.status === 'cancelling') toastStore.show('正在取消拆分任务…')
          } catch (e) {
            toastStore.show('取消失败：' + (e && e.message ? e.message : '未知错误'))
          }
        }
        const handleCancelVerify = async () => {
          const id = verifyTaskId || questionTaskId
          if (!id) return
          try {
            const res = await host.call('task-cancel', { taskId: id })
            if (res && res.status === 'cancelling') toastStore.show('正在取消任务…')
          } catch (e) {
            toastStore.show('取消失败：' + (e && e.message ? e.message : '未知错误'))
          }
        }
        const handleCancelFact = async () => {
          if (!factTaskId) return
          try {
            const res = await host.call('task-cancel', { taskId: factTaskId })
            if (res && res.status === 'cancelling') toastStore.show('正在取消外部核查…')
          } catch (e) {
            toastStore.show('取消失败：' + (e && e.message ? e.message : '未知错误'))
          }
        }
        const handleSelectFactClaim = (claim) => {
          setFactActiveId(claim.id)
          if (!resultView || !claim) return
          if (claim.nodeId) {
            setSelectedNodeId(claim.nodeId)
            setSelectedEdgeId(null)
            const off = resultView.anchors[claim.nodeId]
            if (off != null) {
              const pi = resultView.paragraphs.findIndex((p) => off >= p.start && off < p.end)
              if (pi >= 0) {
                const el = document.getElementById('kg-para-' + pi)
                if (el) { scrollElIntoCenter(el); setActivePara(pi); setFlashPara(pi); ctx.timeout(() => setFlashPara(-1), 1400) }
              }
            }
          }
        }
        const handleRejectFactClaim = (claim) => {
          if (!factReport) return
          const report = { ...factReport, claims: (factReport.claims || []).map((c) => c.id === claim.id ? { ...c, status: 'rejected' } : c) }
          setFactReport(report)
          if (resultView) {
            const g2 = withFactCheck(resultView.graph, report, factReport.stale === true)
            setResultView(makeView(g2, resultView.sourceText))
            persistGraph(g2)
          }
          toastStore.show('已忽略该外部质疑')
        }
        const submitQuestion = async (draftOverride, targetOverride) => {
          const q = (typeof draftOverride === 'string' ? draftOverride : questionDraft).trim()
          if (!q || !resultView || questionPhase === 'running') return
          setError(null)
          setQuestionPhase('running')
          setQuestionResult(null)
          try {
            const payload = {
              title, text: fullText || resultView.sourceText || '',
              graph: { summary: resultView.graph.summary || '', nodes: resultView.graph.nodes, edges: resultView.graph.edges },
               ...verificationSourcePayload(fullText || resultView.sourceText || '', resultView.graph),
              target: targetOverride || questionTarget || { kind: 'graph', id: null },
              question: q,
              ...(effectiveModelArg ? { model: effectiveModelArg } : {}),
            }
            const res = await host.call('question-graph', payload)
            if (res && res.error) {
              setQuestionPhase('idle')
              setError(res.error)
              return
            }
            if (res && res.taskId) {
              setQuestionTaskId(res.taskId)
            } else {
              setQuestionPhase('idle')
              setError({ message: '无法提交质疑任务，请重试' })
            }
          } catch (e) {
            setQuestionPhase('idle')
            setError({ message: '无法提交质疑任务：' + (e && e.message ? e.message : '未知错误') })
          }
        }
        const handleApplyIssue = (issue) => {
          if (!resultView) return
          const next = applyPatch(resultView.graph, issue)
          if (next === resultView.graph) {
            if (patchAlreadySatisfied(resultView.graph, issue)) {
              let report = verification
              if (report && Array.isArray(report.issues) && !report.issues.some((it) => it.id === issue.id)) report = { ...report, issues: [...report.issues, issue] }
              if (report) report = updateIssueStatus(report, issue.id, 'applied')
              const g2 = withVerification(next, report, report ? report.stale === true : false)
              setVerification(report)
              setActiveIssueId(null)
              commitGraph(g2)
              toastStore.show('修复目标已是最新状态，已标记为已处理')
              return
            }
            toastStore.show('该问题没有可应用的补丁（目标可能已变化，请重新体检）')
            return
          }
          let report = verification
          if (report && Array.isArray(report.issues) && !report.issues.some((it) => it.id === issue.id)) {
            report = { ...report, issues: [...report.issues, issue] }
          }
          if (report) report = updateIssueStatus(report, issue.id, 'applied')
          const g2 = withVerification(next, report, report ? report.stale === true : false)
          setVerification(report)
          setActiveIssueId(null)
          if (issue.targetKind === 'node' && next.nodes.some((n) => n.id === issue.targetId)) {
            setSelectedNodeId(issue.targetId)
            setSelectedEdgeId(null)
          } else if (issue.targetKind === 'edge' && issue.targetId != null) {
            const idx = edgeIndexForIssue(next, issue)
            if (idx != null) { setSelectedEdgeId(idx); setSelectedNodeId(null) }
            else { setSelectedNodeId(null); setSelectedEdgeId(null) }
          } else {
            setSelectedNodeId(null)
            setSelectedEdgeId(null)
          }
          commitGraph(g2)
          toastStore.show('已应用修复：' + (issue.title || ''))
        }
        const handleApplyAll = () => {
          if (!resultView || !verification) return
          const open = (verification.issues || []).filter((it) => it.status === 'open')
          const fixable = open.filter((it) => it.proposedFix && it.proposedFix.action && it.proposedFix.action !== 'none')
          if (fixable.length === 0) {
            toastStore.show('没有可自动修复的待处理问题')
            return
          }
          if (!window.confirm('将一键应用 ' + fixable.length + ' 个可自动修复的问题' + (open.length > fixable.length ? '，另有 ' + (open.length - fixable.length) + ' 个需要人工复核' : '') + '。继续吗？')) return
          const res = applyAllFixable(resultView.graph, verificationRef.current || verification)
          const g2 = withVerification(res.graph, res.report, res.report ? res.report.stale === true : false)
          setVerification(res.report)
          setActiveIssueId(null)
          setSelectedNodeId(null)
          setSelectedEdgeId(null)
          commitGraph(g2)
          toastStore.show('一键修复完成：已应用 ' + res.applied + ' 项，跳过 ' + res.skipped + ' 项')
        }
        const handleRejectIssue = (issue) => {
          if (!verification) return
          const report = updateIssueStatus(verification, issue.id, 'rejected')
          setVerification(report)
          attachReport(report, verification.stale === true)
          toastStore.show('已忽略该问题')
        }
        const handleRecheckIssue = (issue) => {
          const target = issue.targetKind === 'graph' ? { kind: 'graph', id: null } : { kind: issue.targetKind, id: issue.targetId }
          const draft = '请复核这个问题：' + issue.title + (issue.detail ? '。' + issue.detail : '')
          setQuestionTarget(target)
          setQuestionDraft(draft)
          setQuestionResult(null)
          setActiveIssueId(issue.id)
          submitQuestion(draft, target)
          toastStore.show('已提交复核任务，等待质疑结果')
        }
        const handleQuestionNode = (node) => {
          setQuestionTarget({ kind: 'node', id: node.id })
          setQuestionResult(null)
          toastStore.show('已选择节点 ' + node.id + '，请在验证面板输入质疑')
        }
        const handleOpenNodeIssues = (node) => {
          if (!verification || !Array.isArray(verification.issues)) {
            toastStore.show('请先运行「快速体检」或「AI 深度审校」')
            return
          }
          const list = verification.issues.filter((it) => it.targetKind === 'node' && it.targetId === node.id && (it.status === 'open' || it.status === 'accepted'))
          if (list.length === 0) {
            toastStore.show('该节点没有待处理的问题')
            return
          }
          setActiveIssueId(list[0].id)
          setSelectedNodeId(node.id)
          setSelectedEdgeId(null)
          const panel = document.getElementById('kg-verify-panel-workbench')
          if (panel && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          toastStore.show('已定位该节点的 ' + list.length + ' 个问题')
        }
        const handleOpenFactPanel = () => {
          const panel = document.getElementById('kg-fact-panel-workbench')
          if (panel && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          toastStore.show('在下方「外部事实核查」面板粘贴领域规则并开始核查')
        }
        const handleQuestionEdge = (edge) => {
          setQuestionTarget({ kind: 'edge', id: edgeKeyOf(edge) })
          setQuestionResult(null)
          toastStore.show('已选择关系 ' + edgeKeyOf(edge) + '，请在验证面板输入质疑')
        }
        const handleDeleteEdge = (edge) => {
          if (!edge) return
          const key = edgeKeyOf(edge)
          const rel = REL_LABEL[edge.relation] || edge.relation
          if (!window.confirm('确定删除关系 ' + key + '（' + rel + '）吗？此操作会写入审计记录。')) return
          handleApplyIssue({
            id: 'manual-del-' + Date.now(), source: 'manual', severity: 'warning', category: 'relation',
            targetKind: 'edge', targetId: key,
            title: '手动删除关系：' + key + '（' + rel + '）',
            detail: '用户手动确认删除该关系。', evidence: [], confidence: 1,
            proposedFix: { action: 'delete_edge', edgePatch: { fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId, relation: edge.relation } },
            status: 'open',
          })
        }
        const handleDeleteQuestionTarget = (target) => {
          if (!resultView || !target || target.kind === 'graph') return
          if (target.kind === 'edge') {
            const edge = (resultView.graph.edges || []).find((e) => edgeKeyOf(e) === target.id)
            if (!edge) { toastStore.show('找不到该关系，可能已被删除'); return }
            handleDeleteEdge(edge)
          } else if (target.kind === 'node') {
            const node = (resultView.graph.nodes || []).find((n) => n.id === target.id)
            if (!node) { toastStore.show('找不到该节点，可能已被删除'); return }
            if (!window.confirm('确定删除节点 ' + node.id + '（' + node.text.slice(0, 40) + '）及其所有关系边吗？此操作会写入审计记录。')) return
            handleApplyIssue({
              id: 'manual-del-' + Date.now(), source: 'manual', severity: 'warning', category: 'other',
              targetKind: 'node', targetId: node.id,
              title: '手动删除节点：' + node.id,
              detail: '用户手动确认删除该节点。', evidence: [], confidence: 1,
              proposedFix: { action: 'delete_node', nodePatch: { id: node.id } },
              status: 'open',
            })
          }
        }
        const handleSelectIssue = (issue) => {
          setActiveIssueId(issue.id)
          if (!resultView) return
          if (issue.targetKind === 'node' && issue.targetId) {
            setSelectedNodeId(issue.targetId)
            setSelectedEdgeId(null)
            const off = resultView.anchors[issue.targetId]
            if (off != null) {
              const pi = resultView.paragraphs.findIndex((p) => off >= p.start && off < p.end)
              if (pi >= 0) {
                const el = document.getElementById('kg-para-' + pi)
                if (el) { scrollElIntoCenter(el); setActivePara(pi); setFlashPara(pi); ctx.timeout(() => setFlashPara(-1), 1400) }
              }
            }
          } else if (issue.targetKind === 'edge' && issue.targetId != null) {
            const idx = edgeIndexForIssue(resultView.graph, issue)
            if (idx != null) {
              setSelectedEdgeId(idx)
              setSelectedNodeId(null)
            }
          }
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
        const handleCandidateReview = async (key, status) => {
          const previousStatus = candidateReviews[key] || 'candidate'
          setCandidateReviews((previous) => {
            const next = { ...previous, [key]: status }
            saveCandidateReviews(next)
            return next
          })
          const remote = Array.isArray(candidateRemote)
            ? candidateRemote.find((row) => row && row.documentId + '|' + row.kind + '|' + row.nodeId === key)
            : null
          if (!remote || !resultView || !resultView.graph) return
          const source = resultView.graph.source && typeof resultView.graph.source === 'object' ? resultView.graph.source : {}
          try {
            const res = await host.call('candidate-update', {
              documentId: remote.documentId || source.documentId || '',
              kind: remote.kind,
              id: remote.id,
              nodeId: remote.nodeId,
              status,
              graph: candidateGraphPayload(resultView.graph),
            })
            if (!res || res.error || !res.candidate) throw new Error(res && res.error && res.error.message ? res.error.message : '候选状态同步失败')
            setCandidateRemote((previous) => Array.isArray(previous) ? previous.map((row) => row && row.id === remote.id ? { ...row, status: res.candidate.status || status } : row) : previous)
          } catch (error) {
            setCandidateReviews((previous) => {
              const next = { ...previous, [key]: previousStatus }
              saveCandidateReviews(next)
              return next
            })
            toastStore.show('候选状态未能同步：' + (error && error.message ? error.message : '未知错误'))
          }
        }
        const handleCandidateLocate = (node) => {
          if (!node || !resultView) return
          const section = chapterSectionsOf(resultView.graph).find((item) => nodeMatchesChapter(node, item) && (node.sectionId === item.id || (Number.isInteger(Number(node.paragraph)) && Number.isInteger(Number(item.startParagraph)) && Number.isInteger(Number(item.endParagraph)) && Number(node.paragraph) >= Number(item.startParagraph) && Number(node.paragraph) <= Number(item.endParagraph))))
          setChapterFilter(section ? section.id : 'all')
          ctx.timeout(() => handleSelectNode(node.id), 0)
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

        const loadHistoryEntry = async (entry) => {
          if (!entry || !entry.documentId) return
          cancelVerifyTasks()
          setError(null)
          try {
            const loaded = await host.call('document-load', { documentId: entry.documentId })
            if (!loaded || loaded.error || !loaded.graph || !Array.isArray(loaded.graph.nodes)) {
              setError(loaded && loaded.error ? loaded.error : { message: '无法从 Host/SQLite 载入历史知识图' })
              return
            }
            const graph = loaded.graph
            const sourceText = typeof loaded.sourceText === 'string' ? loaded.sourceText : ''
            graphRevisionRef.current = Number.isInteger(loaded.revision)
              ? loaded.revision
              : (graph.source && Number.isInteger(graph.source.revision) ? graph.source.revision : 0)
            setTitle(entry.title || (graph.source && graph.source.title) || '')
            setText(sourceText)
            setFullText(sourceText)
            setCurrentHistoryId(entry.id)
            setAppendCount(0)
            setResultView(makeView(graph, sourceText))
            setChapterFilter('all')
            setPhase('done')
            setSelectedNodeId(null)
            setSelectedEdgeId(null)
            setActivePara(-1)
            setShowDiag(false)
            toastStore.clear()
            setHistoryOpen(false)
            setInputCollapsed(true)
            const ver = graph.verification && graph.verification.lastReport
            setVerification(ver && ver.issues ? ver : null)
            const fact = graph.factCheck && graph.factCheck.lastReport
            setFactReport(fact && fact.claims ? fact : null)
            setActiveIssueId(null); setIssueFilter('all'); setFactActiveId(null)
            setQuestionTarget(null); setQuestionResult(null); setQuestionDraft('')
            try { localStorage.setItem(LS_RESULT, JSON.stringify({ title: entry.title || '', documentId: entry.documentId, ts: Date.now() })) } catch (e) {}
          } catch (e) {
            setError({ message: '载入历史知识图失败：' + (e && e.message ? e.message : '未知错误') })
          }
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
        const chapterSections = resultView ? chapterSectionsOf(resultView.graph) : []
        const activeChapter = chapterFilter !== 'all' ? chapterSections.find((section) => section.id === chapterFilter) : null
        const activeChapterId = activeChapter ? activeChapter.id : 'all'
        const visibleGraph = resultView ? filterGraphByChapter(resultView.graph, activeChapterId) : null
        const visibleParagraphs = resultView
          ? resultView.paragraphs.map((paragraph, index) => ({ paragraph, index })).filter(({ index }) => {
              if (!activeChapter) return true
              const start = Number(activeChapter.startParagraph)
              const end = Number(activeChapter.endParagraph)
              return Number.isInteger(start) && Number.isInteger(end) && index >= start && index <= end
            })
          : []
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
            h('div', { className: 'kg-para-badges' },
              h('span', { className: 'kg-para-num', title: '段落编号 P' + (i + 1) }, 'P' + (i + 1)),
              badges.map((t) => h('span', { key: t, className: 'knowledge-type-badge kg-badge-' + t }, TYPE_META[t].label))),
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
                  className: 'kg-textarea',
                  placeholder: resultView ? '粘贴要追加的段落或新资料（将合并进当前知识图，跨段关系自动建立）…' : '粘贴任意资料正文（章节、技术文档、学习笔记…）',
                  value: text, maxLength: MAX_LEN, onChange: (e) => setText(e.target.value), 'aria-label': '资料正文',
                }),
                h('div', { className: 'kg-actions' },
                  h('span', { className: 'kg-counter' },
                    '已输入 ' + text.length + ' / ' + MAX_LEN + ' 字' + (resultView ? ' · 将追加到当前图' : '')),
                  taSel
                    ? h('button', {
                        type: 'button', className: 'kg-secondary',
                        onClick: () => { setTaSel(null); submit(taSel) },
                      }, '拆分所选 ' + taSel.length + ' 字')
                    : null,
                  text.trim().length > 0
                    ? h('button', { type: 'button', className: 'kg-secondary', onClick: () => { setText(''); setTitle('') } }, '清空')
                    : null,
                  resultView
                    ? h('button', {
                        type: 'button', className: 'kg-primary',
                        disabled: text.trim().length === 0,
                        onClick: () => appendSubmit(),
                      }, '追加拆分')
                    : h('button', {
                        type: 'button', className: 'kg-primary',
                        disabled: text.trim().length === 0,
                        onClick: () => submit(),
                      }, 'AI 拆分'),
                ),
              ),
        )

        const resultPanel = resultView
          ? (() => {
              const graph = visibleGraph || resultView.graph
              const windowMeta = graphViewMetadata(resultView.graph)
              const resolvedCount = graph.nodes.filter((node) => resultView.anchors[node.id] != null).length
              const diagCount = (graph.warnings ? graph.warnings.length : 0) + resultView.unresolved.length
               const sourceMeta = graph.source && typeof graph.source === 'object' ? graph.source : null
               const stagingMeta = graph.staging && typeof graph.staging === 'object' ? graph.staging : null
               const generationMeta = graph.generation && typeof graph.generation === 'object' ? graph.generation : null
               const connectivityMeta = generationMeta && generationMeta.connectivity && typeof generationMeta.connectivity === 'object' ? generationMeta.connectivity : null
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
                  h('span', null, (graph.edges || []).length + ' 条关系'),
                  connectivityMeta && connectivityMeta.after
                    ? h('span', {
                        title: '全图连通性：最大连通分量覆盖 ' + Math.round((connectivityMeta.after.largestComponentRatio || 0) * 100) + '%' + (connectivityMeta.attempted ? '；已执行关系编织' : ''),
                      }, '全图 ' + (connectivityMeta.after.componentCount || 0) + ' 个分量 · ' + (connectivityMeta.after.isolatedNodes || 0) + ' 个孤立' + (connectivityMeta.addedEdges ? ' · 补 ' + connectivityMeta.addedEdges + ' 条关系' : ''))
                    : null,
                  h('span', null, '可回链 ' + resolvedCount + '/' + graph.nodes.length + ' 节点'),
                  connectivityMeta && connectivityMeta.after && ((connectivityMeta.after.componentCount || 0) > 1 || (connectivityMeta.after.isolatedNodes || 0) > 0)
                    ? h('button', {
                        type: 'button', className: 'kg-secondary', onClick: retryRelations,
                        title: '保留现有节点，只重新调用 AI 补充有原文证据的关系边',
                      }, '🧵 补全关系')
                    : null,
                  sourceMeta && sourceMeta.sectionCount > 0 ? h('span', null, sourceMeta.sectionCount + ' 个章节 · ' + (sourceMeta.chunkCount || 0) + ' 个内容块') : null,
                   stagingMeta && stagingMeta.chunkCount > 0 ? h('span', null, '已保留 ' + stagingMeta.chunkCount + ' 个分块结果') : null,
                   appendCount > 0 ? h('span', null, '已追加 ' + appendCount + ' 次') : null,
                   generationMeta ? h('span', {
                     style: { color: generationMeta.invariantErrors === 0 ? '#059669' : '#dc2626' },
                     title: generationMeta.sourceAudit === 'full' ? '已完成全文 deterministic invariant 验收' : '旧式追加调用缺少既有正文，只完成新增批次 grounding + 整图结构验收',
                   }, '生成验收：确定性错误 ' + (generationMeta.invariantErrors || 0) + (generationMeta.grounding && generationMeta.grounding.evidenceBackedClaims != null ? ' · 证据声明 ' + generationMeta.grounding.evidenceBackedClaims : '') + (generationMeta.grounding && (generationMeta.grounding.candidateClaims || generationMeta.grounding.unsupportedClaims) ? ' · 待证实声明 ' + ((generationMeta.grounding.candidateClaims || 0) + (generationMeta.grounding.unsupportedClaims || 0)) : '') + (generationMeta.grounding && generationMeta.grounding.entailmentStatus === 'unverified' ? ' · 语义未独立验证' : '') + (generationMeta.retryCount ? ' · 重试 ' + generationMeta.retryCount : '') + (generationMeta.autoRepairCount ? ' · 自动修复 ' + generationMeta.autoRepairCount : '') + (generationMeta.sourceAudit && generationMeta.sourceAudit !== 'full' ? ' · 部分来源复核' : '')) : null,
                  h('span', { className: 'kg-verify-actions', style: { margin: '-6px 0 0' } },
                    h('button', { type: 'button', className: 'kg-secondary', onClick: startQuickVerify, disabled: verifyPhase === 'running' || verifyBusyRef.current }, '⚡ 快速体检'),
                    h('button', { type: 'button', className: 'kg-secondary', onClick: startDeepVerify, disabled: verifyPhase === 'running' || verifyBusyRef.current }, verifyPhase === 'running' ? '审校中…' : '🤖 AI 深度审校'),
                    h('button', { type: 'button', className: 'kg-secondary', onClick: handleOpenFactPanel, disabled: factPhase === 'running' }, factPhase === 'running' ? '核查中…' : '🔎 外部事实核查')),
                  h(GraphExportActions, { graph: resultView.graph, title, ctx }),
                  diagCount > 0
                    ? h('button', {
                        type: 'button', className: 'kg-diag-toggle',
                        'aria-expanded': showDiag,
                        onClick: () => setShowDiag(!showDiag),
                      }, '已记录 ' + diagCount + ' 条诊断（含无法回链原文的节点）' + (showDiag ? ' ▴' : ' ▾'))
                    : null,
                ),
                windowMeta && (windowMeta.truncated || windowMeta.kind === 'query')
                  ? h('div', { className: 'kg-window-nav', 'aria-label': '大图窗口导航与子图查询' },
                      windowMeta.kind === 'query'
                        ? h(React.Fragment, null,
                            h('strong', null, '子图查询'),
                            h('span', null, '“' + windowMeta.query + '” · 匹配 ' + (windowMeta.matchedNodes || 0) + ' 个节点 · 当前显示 ' + windowMeta.visibleNodes + ' 个（含一跳邻居） · 全图 ' + windowMeta.totalNodes + ' 个'),
                            h('button', { type: 'button', className: 'kg-secondary', disabled: graphWindowLoading, onClick: clearGraphQuery }, graphWindowLoading ? '加载中…' : '返回全图窗口'))
                        : h(React.Fragment, null,
                            h('strong', null, '节点窗口 ' + windowMeta.startNode + '–' + windowMeta.endNode + ' / ' + windowMeta.totalNodes),
                            h('span', null, '第 ' + windowMeta.page + ' / ' + windowMeta.pageCount + ' 页'),
                            h('button', {
                              type: 'button', className: 'kg-secondary',
                              disabled: graphWindowLoading || windowMeta.page <= 1,
                              onClick: () => loadGraphWindow({ page: windowMeta.page - 1, query: '' }),
                            }, '上一页'),
                            h('input', {
                              className: 'kg-window-page', type: 'number', min: 1, max: windowMeta.pageCount,
                              value: graphPageDraft, disabled: graphWindowLoading,
                              'aria-label': '知识图页码',
                              onChange: (e) => setGraphPageDraft(e.target.value),
                              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); jumpGraphPage() } },
                            }),
                            h('button', { type: 'button', className: 'kg-secondary', disabled: graphWindowLoading, onClick: jumpGraphPage }, '跳转'),
                            h('button', {
                              type: 'button', className: 'kg-secondary',
                              disabled: graphWindowLoading || windowMeta.page >= windowMeta.pageCount,
                              onClick: () => loadGraphWindow({ page: windowMeta.page + 1, query: '' }),
                            }, '下一页')),
                      h('span', { className: 'kg-window-sep', 'aria-hidden': 'true' }),
                      h('input', {
                        className: 'kg-window-query', value: graphQueryDraft, disabled: graphWindowLoading,
                        placeholder: '按节点 ID / 文本 / 类型 / 章节查询子图…', maxLength: 200,
                        'aria-label': '查询知识图子图',
                        onChange: (e) => setGraphQueryDraft(e.target.value),
                        onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); runGraphQuery() } },
                      }),
                      h('button', { type: 'button', className: 'kg-secondary', disabled: graphWindowLoading || !graphQueryDraft.trim(), onClick: runGraphQuery }, graphWindowLoading ? '加载中…' : '查询子图'))
                  : null,
                showDiag ? h('div', { className: 'kg-diag-list' }, diagLines.join(NL)) : null,
                h('p', { className: 'kg-hint' }, '点击原文段落 → 图中聚焦该段节点；点击图中节点 → 弹出详情卡片（含完整内容）并滚动到对应原文段落；大图可按 800 节点窗口翻页，或按节点 ID / 文本 / 类型 / 章节查询带一跳邻居的子图；拖拽平移画布，Ctrl+滚轮缩放，右上角可切换布局形态（力导向 / 圆形 / 放射 / 分层），长按节点查看原文摘录。'),
                h('div', {
                  className: 'kg-cols',
                  ref: colsRef,
                  style: { '--kg-split': splitRatio + '%' },
                  onPointerMove: onSplitMove,
                  onPointerUp: onSplitUp,
                },
                  h('div', { className: 'kg-original', 'aria-label': '原文段落', style: { maxHeight: resultHeight + 'px' } },
                    visibleParagraphs.map(({ paragraph, index }) => paraEl(paragraph, index))),
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
                      issueReport: verification,
                      onQuestionNode: handleQuestionNode, onQuestionEdge: handleQuestionEdge,
                      onDeleteEdge: handleDeleteEdge,
                      onOpenNodeIssues: handleOpenNodeIssues,
                      exportTitle: title,
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
                    formatTime(entry.ts) + ' · ' + (entry.nodeCount || 0) + ' 节点 · ' + (entry.edgeCount || 0) + ' 条关系'),
                  h('div', { className: 'kg-history-item-summary' },
                    (entry.summary || '').slice(0, 60) + ((entry.summary || '').length > 60 ? '…' : '')),
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
            h('div', { style: { display: 'flex', gap: 8, flex: 'none', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } },
              h(ModelPicker, { value: modelChoice, onChange: handleModelChange }),
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
                h('p', null, submittedRef.current && submittedRef.current.relationRetry === true ? '正在用 AI 补全知识图关系…' : (submittedRef.current && submittedRef.current.append === true ? '正在用 AI 追加拆分…' : '正在用 AI 拆分资料…')),
                h('p', { className: 'kg-empty-sub' }, '使用模型：' + modelLabelOf((extractProgress && extractProgress.model) || effectiveModelArg, modelChoice)),
                extractProgress
                  ? h('p', { className: 'kg-empty-sub' },
                      (extractProgress.stage || '运行中') + ' · 已运行 ' + Math.round((extractProgress.elapsedMs || 0) / 60000) + ' 分钟 · 已接收 ' + (extractProgress.charsReceived || 0) + ' 字符' + (extractProgress.batch && extractProgress.batch.total ? ' · 内容块 ' + extractProgress.batch.index + '/' + extractProgress.batch.total : ''))
                  : null,
                extractProgress && extractProgress.warning
                  ? h('p', { className: 'kg-empty-sub', style: { color: '#b45309' } }, '⚠ ' + extractProgress.warning)
                  : null,
                h('p', { className: 'kg-empty-sub' }, '可以关闭窗口或离开页面；任务会自动保存，重新打开窗口后自动恢复轮询。'),
                h('button', { type: 'button', className: 'kg-secondary kg-danger', onClick: handleCancelExtract }, '取消任务'),
              )
            : historyOpen
              ? historyPanel
              : h(React.Fragment, null,
                  inputPanel,
                  resultPanel,
                  resultView
                    ? h(CandidateReviewPanel, {
                        graph: resultView.graph,
                        chapterFilter: activeChapterId,
                        onChapterFilter: setChapterFilter,
                        reviews: candidateReviews,
                        onSetReview: handleCandidateReview,
                        onLocate: handleCandidateLocate,
                      })
                    : null,
                  resultView && (verification || verifyPhase === 'running' || questionResult || questionTarget)
                    ? h(VerificationPanel, {
                        report: verification, graph: resultView.graph, resultView,
                        verifying: verifyPhase === 'running' || questionPhase === 'running',
                        activeIssueId, onSelectIssue: handleSelectIssue,
                        onApplyIssue: handleApplyIssue, onRejectIssue: handleRejectIssue, onRecheckIssue: handleRecheckIssue,
                        onApplyAll: handleApplyAll,
                        issueFilter, setIssueFilter,
                        questionDraft, setQuestionDraft, questionTarget,
                        clearQuestionTarget: () => { setQuestionTarget(null); setQuestionResult(null) },
                        questionResult, questionPhase, onSubmitQuestion: submitQuestion,
                        onDeleteTarget: handleDeleteQuestionTarget,
                        panelId: 'kg-verify-panel-workbench',
                        progress: verifyProgress,
                        onCancel: handleCancelVerify,
                      })
                    : null,
                  resultView
                    ? h(FactCheckPanel, {
                        report: factReport, graph: resultView.graph, resultView,
                        verifying: factPhase === 'running',
                        activeClaimId: factActiveId,
                        onSelectClaim: handleSelectFactClaim,
                        onRejectClaim: handleRejectFactClaim,
                        panelId: 'kg-fact-panel-workbench',
                        rulesDraft: factRules, setRulesDraft: setFactRules,
                        onStartFactCheck: startFactCheck,
                        progress: factProgress,
                        onCancel: handleCancelFact,
                      })
                    : null,
                ),
        )
      }

      // ------------------- conversation.view: 轨迹知识图 -------------------
      // A third conversation tab (beside 对话 / 轨迹): extracts the CURRENT
      // session's execution trace into a knowledge graph via the host
      // trajectory-extract RPC, with two-way linking between graph nodes and
      // trace events.
      const TRACE_TYPE_LABEL = {
        'turn/start': '回合开始',
        'turn/end': '回合结束',
        'user/message': '用户消息',
        'assistant/message': 'AI 回复',
        'tool/call': '工具调用',
        'tool/result': '工具结果',
      }

      // Trajectory state follows the same persistence contract as document
      // graphs: the browser keeps only a small document reference. Full trace
      // text, events and canonical graph live in Host/SQLite. The module-level
      // map may cache a hydrated view for fast tab switches, but localStorage
      // never becomes an alternate trajectory truth.
      const trajMem = new Map()
      const trajPendMem = new Map()
      function trajReference(entry) {
        if (!entry || typeof entry !== 'object') return null
        const graph = entry.graph && typeof entry.graph === 'object' ? entry.graph : null
        const documentId = typeof entry.documentId === 'string' && entry.documentId
          ? entry.documentId
          : documentIdOfGraph(graph)
        if (!documentId) return null
        const source = graph && graph.source && typeof graph.source === 'object' ? graph.source : {}
        return {
          documentId,
          revision: Number.isInteger(entry.revision) ? entry.revision : (Number.isInteger(source.revision) ? source.revision : 0),
          ts: Number.isFinite(entry.ts) ? entry.ts : Date.now(),
        }
      }
      function readTrajResult(sessionId) {
        if (!sessionId) return null
        if (trajMem.has(sessionId)) return trajMem.get(sessionId)
        let e = null
        try { e = JSON.parse(localStorage.getItem(LS_TRAJ_RESULT + ':' + sessionId) || 'null') } catch (err) {}
        if (e && typeof e.documentId === 'string' && e.documentId) return e
        // Upgrade old full-graph cache to a reference if it already has a
        // canonical document id. The full legacy payload is deleted either way.
        let legacy = null
        try { legacy = JSON.parse(localStorage.getItem(LS_TRAJ_RESULT_LEGACY + ':' + sessionId) || 'null') } catch (err) {}
        try { localStorage.removeItem(LS_TRAJ_RESULT_LEGACY + ':' + sessionId) } catch (err) {}
        const ref = trajReference(legacy)
        if (ref) {
          try { localStorage.setItem(LS_TRAJ_RESULT + ':' + sessionId, JSON.stringify(ref)) } catch (err) {}
          return ref
        }
        return null
      }
      function writeTrajResult(sessionId, entry) {
        if (!sessionId) return
        if (entry && entry.graph && Array.isArray(entry.graph.nodes)) trajMem.set(sessionId, entry)
        const ref = trajReference(entry)
        try {
          localStorage.removeItem(LS_TRAJ_RESULT_LEGACY + ':' + sessionId)
          if (ref) localStorage.setItem(LS_TRAJ_RESULT + ':' + sessionId, JSON.stringify(ref))
          else localStorage.removeItem(LS_TRAJ_RESULT + ':' + sessionId)
        } catch (e) {}
      }
      function clearTrajResult(sessionId) {
        if (!sessionId) return
        trajMem.delete(sessionId)
        try {
          localStorage.removeItem(LS_TRAJ_RESULT + ':' + sessionId)
          localStorage.removeItem(LS_TRAJ_RESULT_LEGACY + ':' + sessionId)
        } catch (e) {}
      }
      function readTrajPending(sessionId) {
        if (!sessionId) return null
        if (trajPendMem.has(sessionId)) return trajPendMem.get(sessionId)
        let e = null
        try { e = JSON.parse(localStorage.getItem(LS_TRAJ_PENDING + ':' + sessionId) || 'null') } catch (err) {}
        if (e && e.taskId) trajPendMem.set(sessionId, e)
        else e = null
        return e
      }
      function writeTrajPending(sessionId, entry) {
        if (!sessionId) return
        trajPendMem.set(sessionId, entry)
        try { localStorage.setItem(LS_TRAJ_PENDING + ':' + sessionId, JSON.stringify(entry)) } catch (e) {}
      }
      function clearTrajPending(sessionId) {
        if (!sessionId) return
        trajPendMem.delete(sessionId)
        try { localStorage.removeItem(LS_TRAJ_PENDING + ':' + sessionId) } catch (e) {}
      }
      // Old cached traces predate per-event [start, end) offsets. Rebuild them
      // from the serialized `line` list (events are joined by two newlines) so
      // the content-aware paragraph splitter can still map units back to events.
      function normalizeTraceEvents(traceText, events) {
        if (!Array.isArray(events) || events.length === 0) return events || []
        if (events.every((e) => e && typeof e.start === 'number' && typeof e.end === 'number')) return events
        let pos = 0
        return events.map((e, i) => {
          const line = e && typeof e.line === 'string' ? e.line : ''
          const out = { ...(e || {}), start: pos, end: pos + line.length }
          pos += line.length + (i < events.length - 1 ? 2 : 0)
          return out
        })
      }

      function TrajectoryTab({ sessionId }) {
        const [phase, setPhase] = useState('idle') // idle | extracting | done
        const [taskId, setTaskId] = useState(null)
        const [error, setError] = useState(null)
        const [view, setView] = useState(null)
        const [traceEvents, setTraceEvents] = useState([])
        const [selectedNodeId, setSelectedNodeId] = useState(null)
        const [selectedEdgeId, setSelectedEdgeId] = useState(null)
        const [focusReq, setFocusReq] = useState({ nodeId: null, seq: 0 })
        const [activePara, setActivePara] = useState(-1)
        const [flashPara, setFlashPara] = useState(-1)
        const [showDiag, setShowDiag] = useState(false)
        const [trajToast, setTrajToast] = useState(null)
        const [layoutMode, setLayoutMode] = useState(() => {
          try {
            const v = localStorage.getItem(LS_LAYOUT)
            if (v && LAYOUT_MODES.some((m) => m.id === v)) return v
          } catch (e) {}
          return 'layered'
        })
        const [modelChoice, setModelChoice] = useState(readModelChoice)
        const modelCatalog = useModelCatalog()
        const modelArg = parseModelKey(modelChoice)
        const effectiveModelArg = modelArg || (
          modelCatalog && modelCatalog.current && typeof modelCatalog.current.provider === 'string' && typeof modelCatalog.current.model === 'string'
            ? modelCatalog.current
            : null
        )
        const [splitRatio, setSplitRatio] = useState(() => {
          try {
            const v = parseFloat(localStorage.getItem(LS_TRAJ_SPLIT))
            if (isFinite(v) && v >= 24 && v <= 70) return v
          } catch (e) {}
          return 36
        })
        const [resultHeight, setResultHeight] = useState(() => {
          try {
            const v = parseInt(localStorage.getItem(LS_TRAJ_HEIGHT), 10)
            if (isFinite(v) && v >= 320 && v <= 900) return v
          } catch (e) {}
          return 560
        })
        const toastTimer = useRef(null)
        const sessionSeq = useRef(0)
        const colsRef = useRef(null)
        const splitDragRef = useRef(null)
        const hHandleRef = useRef(null)
        const hDragRef = useRef(null)
        const mountedSessionRef = useRef(null)
        const trajRevisionRef = useRef(0)
        const trajCommitQueueRef = useRef(Promise.resolve())
        const appendModeRef = useRef(false) // true while an append task is running
        const [appendCount, setAppendCount] = useState(0)
        // ---- verification / questioning ----
        const [verification, setVerification] = useState(null)
        const [verifyPhase, setVerifyPhase] = useState('idle')
        const [verifyTaskId, setVerifyTaskId] = useState(null)
        const [questionTaskId, setQuestionTaskId] = useState(null)
        const [activeIssueId, setActiveIssueId] = useState(null)
        const [issueFilter, setIssueFilter] = useState('all')
        const [questionDraft, setQuestionDraft] = useState('')
        const [questionTarget, setQuestionTarget] = useState(null)
        const [questionResult, setQuestionResult] = useState(null)
        const [questionPhase, setQuestionPhase] = useState('idle')
        const [factReport, setFactReport] = useState(null)
        const [factPhase, setFactPhase] = useState('idle')
        const [factTaskId, setFactTaskId] = useState(null)
        const [factActiveId, setFactActiveId] = useState(null)
        const [factRules, setFactRules] = useState('')
        const [verifyProgress, setVerifyProgress] = useState(null)
        const [factProgress, setFactProgress] = useState(null)
        const [extractProgress, setExtractProgress] = useState(null)
        const verifyBusyRef = useRef(false)
        const verificationRef = useRef(null)
        const verifyGenRef = useRef(0)
        const factGenRef = useRef(0)
        const factReportRef = useRef(null)
        useEffect(() => { verificationRef.current = verification }, [verification])
        useEffect(() => { factReportRef.current = factReport }, [factReport])
        const cancelTrajVerifyTasks = () => {
          sessionSeq.current += 1
          verifyGenRef.current += 1
          factGenRef.current += 1
          setVerifyTaskId(null)
          setQuestionTaskId(null)
          setFactTaskId(null)
          setVerifyPhase('idle')
          setQuestionPhase('idle')
          setFactPhase('idle')
          verifyBusyRef.current = false
          setQuestionResult(null)
          setVerifyProgress(null)
          setFactProgress(null)
          setExtractProgress(null)
        }

        const showToast = (msg) => {
          setTrajToast(msg)
          if (toastTimer.current) { toastTimer.current(); toastTimer.current = null }
          toastTimer.current = ctx.timeout(() => { toastTimer.current = null; setTrajToast(null) }, 3000)
        }
        const applyHydratedTrajectory = (graph, sourceText, events, revision) => {
          const tText = typeof graph.traceText === 'string' && graph.traceText ? graph.traceText : (sourceText || '')
          const rawEvents = Array.isArray(graph.traceEvents) ? graph.traceEvents : events
          const evs = normalizeTraceEvents(tText, Array.isArray(rawEvents) ? rawEvents : [])
          trajRevisionRef.current = Number.isInteger(revision)
            ? revision
            : (graph.source && Number.isInteger(graph.source.revision) ? graph.source.revision : 0)
          const hydrated = { graph, traceText: tText, traceEvents: evs, revision: trajRevisionRef.current, ts: Date.now() }
          setView(makeView(graph, tText))
          setTraceEvents(evs)
          writeTrajResult(sessionId, hydrated)
          const ver = graph.verification && graph.verification.lastReport
          setVerification(ver && ver.issues ? ver : null)
          const fact = graph.factCheck && graph.factCheck.lastReport
          setFactReport(fact && fact.claims ? fact : null)
          return hydrated
        }
        const hydrateTrajectoryDocument = async (documentId, expectedSeq) => {
          if (!documentId) return false
          try {
            const loaded = await host.call('document-load', { documentId })
            if (expectedSeq !== sessionSeq.current || mountedSessionRef.current !== sessionId) return false
            if (!loaded || loaded.error || !loaded.graph || !Array.isArray(loaded.graph.nodes)) {
              clearTrajResult(sessionId)
              setError(loaded && loaded.error ? loaded.error : { message: '无法从 Host/SQLite 恢复轨迹知识图' })
              return false
            }
            applyHydratedTrajectory(loaded.graph, loaded.sourceText || '', loaded.graph.traceEvents, loaded.revision)
            return true
          } catch (error) {
            if (expectedSeq !== sessionSeq.current || mountedSessionRef.current !== sessionId) return false
            setError({ message: '恢复轨迹知识图失败：' + (error && error.message ? error.message : '未知错误') })
            return false
          }
        }

        // Mount / session switch: RESTORE the last result (or a still-running
        // task) for this session instead of resetting — the tab is unmounted
        // whenever the user switches to another conversation tab, so state
        // must live outside the component.
        useEffect(() => {
          if (mountedSessionRef.current === sessionId) return
          mountedSessionRef.current = sessionId
          setError(null)
          setSelectedNodeId(null); setSelectedEdgeId(null); setActivePara(-1); setFlashPara(-1)
          setShowDiag(false); setTrajToast(null)
          setAppendCount(0)
          appendModeRef.current = false
          setVerification(null); setVerifyPhase('idle'); setVerifyTaskId(null); setQuestionTaskId(null)
          setFactReport(null); setFactPhase('idle'); setFactTaskId(null); setFactActiveId(null); setFactRules('')
          setActiveIssueId(null); setIssueFilter('all'); setQuestionDraft(''); setQuestionTarget(null); setQuestionResult(null); setQuestionPhase('idle')
          verifyBusyRef.current = false
          verifyGenRef.current += 1
          factGenRef.current += 1
          sessionSeq.current += 1
          if (!sessionId) return
          const cached = readTrajResult(sessionId)
          const pending = readTrajPending(sessionId)
          const restoreSeq = sessionSeq.current
          if (cached && cached.graph && Array.isArray(cached.graph.nodes)) {
            try {
              applyHydratedTrajectory(cached.graph, cached.traceText || '', cached.traceEvents || [], cached.revision)
              if (pending && pending.taskId) {
                setTaskId(pending.taskId)
                setPhase('extracting')
                appendModeRef.current = pending.append === true
              } else {
                setPhase('done')
                setTaskId(null)
              }
            } catch (err) {
              clearTrajResult(sessionId)
              setPhase('idle'); setView(null); setTraceEvents([])
            }
            return
          }
          if (cached && typeof cached.documentId === 'string' && cached.documentId) {
            setView(null); setTraceEvents([])
            if (pending && pending.taskId) {
              setTaskId(pending.taskId)
              setPhase('extracting')
              appendModeRef.current = pending.append === true
            } else {
              setTaskId(null)
              setPhase('extracting')
            }
            hydrateTrajectoryDocument(cached.documentId, restoreSeq).then((ok) => {
              if (restoreSeq !== sessionSeq.current || mountedSessionRef.current !== sessionId) return
              if (!pending) setPhase(ok ? 'done' : 'idle')
            })
            return
          }
          if (pending && pending.taskId) {
            setTaskId(pending.taskId)
            setPhase('extracting')
            setView(null); setTraceEvents([])
            appendModeRef.current = pending.append === true
            return
          }
          setPhase('idle')
          setView(null); setTraceEvents([])
        }, [sessionId])

        // Clear the toast timer on unmount.
        useEffect(() => () => {
          if (toastTimer.current) { toastTimer.current(); toastTimer.current = null }
        }, [])

        // ---- adaptive-backoff polling while a task runs ----
        useEffect(() => {
          if (!taskId) return
          let disposed = false
          let stop = null
          let delay = 3000
          const mySeq = sessionSeq.current
          const start = Date.now()
          const tick = async () => {
            if (disposed) return
            let res = null
            try {
              res = await host.call('trajectory-status', { taskId })
            } catch (e) {
              if (disposed) return
              setPhase('idle'); setTaskId(null)
              setError({ message: '查询任务状态失败：' + (e && e.message ? e.message : '未知错误') })
              return
            }
            if (disposed || mySeq !== sessionSeq.current) return
            if (res && res.status === 'running') setExtractProgress(res.progress || null)
            if (res && res.status === 'succeeded') {
              let g = res.result
              const resultAddedNodeIds = g && Array.isArray(g.addedNodeIds) ? g.addedNodeIds.slice() : []
              if (g && Array.isArray(g.nodes)) {
                if (g.source && Number.isInteger(g.source.revision)) trajRevisionRef.current = g.source.revision
                const documentId = documentIdOfGraph(g)
                if (documentId) {
                  try {
                    const loaded = await host.call('document-load', { documentId })
                    if (disposed || mySeq !== sessionSeq.current) return
                    if (loaded && !loaded.error && loaded.graph && Array.isArray(loaded.graph.nodes)) {
                      g = { ...loaded.graph, ...(resultAddedNodeIds.length > 0 ? { addedNodeIds: resultAddedNodeIds } : {}) }
                      trajRevisionRef.current = Number.isInteger(loaded.revision)
                        ? loaded.revision
                        : (g.source && Number.isInteger(g.source.revision) ? g.source.revision : trajRevisionRef.current)
                    }
                  } catch (error) { /* task result remains usable in dynamic mode */ }
                }
                const tText = typeof g.traceText === 'string' && g.traceText ? g.traceText : ''
                const evs = normalizeTraceEvents(tText, Array.isArray(g.traceEvents) ? g.traceEvents : [])
                const wasAppend = appendModeRef.current
                appendModeRef.current = false
                // Append invalidates the previous verification report.
                const prevVer = verificationRef.current
                const prevFact = factReportRef.current
                let g2 = g
                let reportMetadataChanged = false
                if (prevVer && prevVer.issues) {
                  const staleReport = { ...prevVer, stale: true }
                  g2 = withVerification(g2, staleReport, true)
                  setVerification(staleReport)
                  reportMetadataChanged = true
                } else {
                  setVerification(null)
                }
                if (prevFact && Array.isArray(prevFact.claims)) {
                  const staleFact = { ...prevFact, stale: true }
                  g2 = withFactCheck(g2, staleFact, true)
                  setFactReport(staleFact)
                  reportMetadataChanged = true
                } else {
                  setFactReport(null)
                }
                try {
                  setView(makeView(g2, tText))
                  setTraceEvents(evs)
                  setPhase('done'); setTaskId(null); setExtractProgress(null)
                  setSelectedNodeId(null); setSelectedEdgeId(null); setActivePara(-1)
                  clearTrajPending(sessionId)
                  writeTrajResult(sessionId, { graph: g2, traceText: tText, traceEvents: evs, revision: trajRevisionRef.current, ts: Date.now() })
                  if (reportMetadataChanged) persistTrajGraph(g2, g)
                  if (wasAppend) {
                    setAppendCount((c) => c + 1)
                    const added = resultAddedNodeIds.length
                    const lastEv = evs.length > 0 ? evs[evs.length - 1] : null
                    showToast('轨迹追加完成：新增 ' + added + ' 个节点' + (lastEv && typeof lastEv.seq === 'number' ? '，已覆盖到事件 #' + lastEv.seq : ''))
                  } else {
                    setAppendCount(0)
                    showToast('轨迹知识图已生成')
                  }
                } catch (err) {
                  setPhase('idle'); setTaskId(null); setExtractProgress(null)
                  clearTrajPending(sessionId)
                  setError({ message: '图数据无法渲染，请重新拆解' })
                }
              } else {
                setPhase('idle'); setTaskId(null); setExtractProgress(null)
                clearTrajPending(sessionId)
                setError({ message: 'AI 返回的结果缺少图数据，请重试' })
              }
              return
            }
            if (res && res.status === 'failed' || res && res.status === 'cancelled') {
              setPhase('idle'); setTaskId(null); setExtractProgress(null)
              clearTrajPending(sessionId)
              const err = res.error || {}
              setError({ code: err.code, message: err.message || (res.status === 'cancelled' ? '任务已取消' : 'AI 拆分失败，请稍后重试') })
              return
            }
            if (res && res.status === 'not_found') {
              setPhase('idle'); setTaskId(null); setExtractProgress(null)
              clearTrajPending(sessionId)
              setError({ message: '拆分任务已过期（服务可能已重启），请重新拆解' })
              return
            }
            if (Date.now() - start > 60 * 1000) delay = Math.min(delay * 1.5, 15000)
            stop = ctx.timeout(tick, delay)
          }
          tick()
          return () => { disposed = true; if (stop) stop() }
        }, [taskId])

        // ---- verification / question task polling (trajectory tab) ----
        useEffect(() => {
          if (!verifyTaskId) return
          let disposed = false
          let stop = null
          let delay = 3000
          const mySeq = sessionSeq.current
          const myGen = verifyGenRef.current
          const start = Date.now()
          const tick = async () => {
            if (disposed || mySeq !== sessionSeq.current || myGen !== verifyGenRef.current) return
            let res = null
            try { res = await host.call('task-status', { taskId: verifyTaskId }) }
            catch (e) {
              if (disposed || mySeq !== sessionSeq.current || myGen !== verifyGenRef.current) return
              setVerifyPhase('idle'); setVerifyTaskId(null); verifyBusyRef.current = false
              setError({ message: '查询验证任务失败：' + (e && e.message ? e.message : '未知错误') })
              return
            }
            if (disposed || mySeq !== sessionSeq.current || myGen !== verifyGenRef.current) return
            if (res && res.status === 'running') setVerifyProgress(res.progress || null)
            if (res && res.status === 'succeeded' && res.result) {
              const report = res.result
              if (report && Array.isArray(report.issues) && view) {
                setVerification(report)
                const baseline = view.graph
                const g2 = withVerification(baseline, report, false)
                setView(makeView(g2, view.sourceText))
                persistTrajGraph(g2, baseline)
              }
              setVerifyPhase('idle'); setVerifyTaskId(null); setVerifyProgress(null); verifyBusyRef.current = false
              showToast('轨迹知识图验证完成')
              return
            }
            if (res && res.status === 'failed' || res && res.status === 'cancelled') {
              setVerifyPhase('idle'); setVerifyTaskId(null); setVerifyProgress(null); verifyBusyRef.current = false
              const err = res.error || {}
              setError({ code: err.code, message: err.message || (res.status === 'cancelled' ? '任务已取消' : 'AI 审校失败，请稍后重试') })
              return
            }
            if (res && res.status === 'not_found') {
              setVerifyPhase('idle'); setVerifyTaskId(null); setVerifyProgress(null); verifyBusyRef.current = false
              setError({ message: '验证任务已过期（服务可能已重启），请重新验证' })
              return
            }
            if (Date.now() - start > 60 * 1000) delay = Math.min(delay * 1.5, 15000)
            stop = ctx.timeout(tick, delay)
          }
          tick()
          return () => { disposed = true; if (stop) stop() }
        }, [verifyTaskId])
        useEffect(() => {
          if (!questionTaskId) return
          let disposed = false
          let stop = null
          let delay = 3000
          const mySeq = sessionSeq.current
          const myGen = verifyGenRef.current
          const start = Date.now()
          const tick = async () => {
            if (disposed || mySeq !== sessionSeq.current || myGen !== verifyGenRef.current) return
            let res = null
            try { res = await host.call('task-status', { taskId: questionTaskId }) }
            catch (e) {
              if (disposed || mySeq !== sessionSeq.current || myGen !== verifyGenRef.current) return
              setQuestionPhase('idle'); setQuestionTaskId(null)
              setError({ message: '查询质疑任务失败：' + (e && e.message ? e.message : '未知错误') })
              return
            }
            if (disposed || mySeq !== sessionSeq.current || myGen !== verifyGenRef.current) return
            if (res && res.status === 'running') setVerifyProgress(res.progress || null)
            if (res && res.status === 'succeeded' && res.result) {
              setQuestionResult(res.result)
              setQuestionPhase('idle'); setQuestionTaskId(null); setVerifyProgress(null)
              showToast('质疑判定完成')
              return
            }
            if (res && res.status === 'failed' || res && res.status === 'cancelled') {
              setQuestionPhase('idle'); setQuestionTaskId(null); setVerifyProgress(null)
              const err = res.error || {}
              setError({ code: err.code, message: err.message || (res.status === 'cancelled' ? '任务已取消' : 'AI 质疑判定失败，请稍后重试') })
              return
            }
            if (res && res.status === 'not_found') {
              setQuestionPhase('idle'); setQuestionTaskId(null); setVerifyProgress(null)
              setError({ message: '质疑任务已过期（服务可能已重启），请重新提问' })
              return
            }
            if (Date.now() - start > 60 * 1000) delay = Math.min(delay * 1.5, 15000)
            stop = ctx.timeout(tick, delay)
          }
          tick()
          return () => { disposed = true; if (stop) stop() }
        }, [questionTaskId])

        // ---- external fact-check polling (trajectory) ----
        useEffect(() => {
          if (!factTaskId) return
          let disposed = false
          let stop = null
          let delay = 3000
          const mySeq = sessionSeq.current
          const myGen = factGenRef.current
          const start = Date.now()
          const tick = async () => {
            if (disposed || mySeq !== sessionSeq.current || myGen !== factGenRef.current) return
            let res = null
            try { res = await host.call('task-status', { taskId: factTaskId }) }
            catch (e) {
              if (disposed || mySeq !== sessionSeq.current || myGen !== factGenRef.current) return
              setFactPhase('idle'); setFactTaskId(null)
              setError({ message: '查询外部核查任务失败：' + (e && e.message ? e.message : '未知错误') })
              return
            }
            if (disposed || mySeq !== sessionSeq.current || myGen !== factGenRef.current) return
            if (res && res.status === 'running') setFactProgress(res.progress || null)
            if (res && res.status === 'succeeded' && res.result) {
              const report = res.result
              if (report && Array.isArray(report.claims) && view) {
                setFactReport(report)
                const baseline = view.graph
                const g2 = withFactCheck(baseline, report, false)
                setView(makeView(g2, view.sourceText))
                persistTrajGraph(g2, baseline)
              }
              setFactPhase('idle'); setFactTaskId(null); setFactProgress(null)
              showToast('轨迹外部事实核查完成')
              return
            }
            if (res && res.status === 'failed' || res && res.status === 'cancelled') {
              setFactPhase('idle'); setFactTaskId(null); setFactProgress(null)
              const err = res.error || {}
              setError({ code: err.code, message: err.message || (res.status === 'cancelled' ? '任务已取消' : 'AI 外部事实核查失败，请稍后重试') })
              return
            }
            if (res && res.status === 'not_found') {
              setFactPhase('idle'); setFactTaskId(null); setFactProgress(null)
              setError({ message: '外部核查任务已过期（服务可能已重启），请重新核查' })
              return
            }
            if (Date.now() - start > 60 * 1000) delay = Math.min(delay * 1.5, 15000)
            stop = ctx.timeout(tick, delay)
          }
          tick()
          return () => { disposed = true; if (stop) stop() }
        }, [factTaskId])

        const extract = async () => {
          cancelTrajVerifyTasks()
          setError(null)
          setPhase('extracting')
          setExtractProgress(null)
          setView(null); setTraceEvents([])
          setSelectedNodeId(null); setSelectedEdgeId(null); setActivePara(-1)
          setAppendCount(0)
          appendModeRef.current = false
          trajRevisionRef.current = 0
          clearTrajResult(sessionId)
          try {
            const res = await host.call('trajectory-extract', { sessionId, ...(effectiveModelArg ? { model: effectiveModelArg } : {}) })
            if (res && res.error) { setPhase('idle'); setError(res.error); return }
            if (res && res.taskId) {
              setTaskId(res.taskId)
              writeTrajPending(sessionId, { taskId: res.taskId, ts: Date.now() })
            }
            else { setPhase('idle'); setError({ message: '无法提交拆解任务，请重试' }) }
          } catch (e) {
            setPhase('idle')
            setError({ message: '无法提交拆解任务：' + (e && e.message ? e.message : '未知错误') })
          }
        }

        // Incremental trajectory append: only events AFTER the last included
        // one are extracted (host-side), then the result is the FULLY merged
        // graph + trace text + events — the success handler needs no merge.
        const appendExtract = async () => {
          if (!view || !view.graph || !Array.isArray(view.graph.nodes)) {
            showToast('请先完成一次拆解，再追加新事件')
            return
          }
          cancelTrajVerifyTasks()
          setError(null)
          setPhase('extracting')
          setExtractProgress(null)
          setSelectedNodeId(null); setSelectedEdgeId(null); setActivePara(-1)
          appendModeRef.current = true
          try {
            await trajCommitQueueRef.current.catch(() => {})
            const documentId = documentIdOfGraph(view.graph)
            if (!documentId) {
              setPhase('done')
              appendModeRef.current = false
              setError({ code: 'trajectory_state_incomplete', message: '当前轨迹没有 canonical documentId，请重新拆解一次后再追加' })
              return
            }
            const res = await host.call('trajectory-append-extract', {
              sessionId,
              documentId,
              expectedRevision: trajRevisionRef.current,
              ...(effectiveModelArg ? { model: effectiveModelArg } : {}),
            })
            if (res && res.error) { setPhase('idle'); setError(res.error); return }
            if (res && res.taskId) {
              setTaskId(res.taskId)
              writeTrajPending(sessionId, { taskId: res.taskId, append: true, documentId, revision: trajRevisionRef.current, ts: Date.now() })
            }
            else { setPhase('idle'); setError({ message: '无法提交追加任务，请重试' }) }
          } catch (e) {
            setPhase('idle')
            setError({ message: '无法提交追加任务：' + (e && e.message ? e.message : '未知错误') })
          }
        }

        // ---- verification / questioning actions (trajectory) ----
        // Trajectory edits share the same canonical revision protocol as the
        // document workbench. localStorage only remembers the document ref;
        // reports and repairs are durable only after graph-commit succeeds.
        const persistTrajGraph = (g, baseGraph) => {
          const documentId = documentIdOfGraph(g)
          if (!documentId) return Promise.resolve(null)
          const baseline = baseGraph && typeof baseGraph === 'object' ? baseGraph : (view && view.graph ? view.graph : g)
          const sourceText = view ? view.sourceText : ''
          const edgeRevisionKey = (edge) => edge && edge.fromNodeId && edge.toNodeId
            ? edge.fromNodeId + '>' + edge.toNodeId + ':' + String(edge.relation || '')
            : ''
          const operations = semanticOperationsOf(g)
          const graphPayload = {
            summary: typeof g.summary === 'string' ? g.summary : '',
            nodes: Array.isArray(g.nodes) ? g.nodes : [],
            edges: Array.isArray(g.edges) ? g.edges : [],
            ...(g.verification && typeof g.verification === 'object' ? { verification: g.verification } : {}),
            ...(g.factCheck && typeof g.factCheck === 'object' ? { factCheck: g.factCheck } : {}),
          }
          const queued = trajCommitQueueRef.current.catch(() => {}).then(async () => {
            const response = await host.call('graph-commit', {
              documentId,
              expectedRevision: trajRevisionRef.current,
              graph: graphPayload,
              operations,
              baseNodeIds: (Array.isArray(baseline.nodes) ? baseline.nodes : []).map((node) => node && node.id).filter(Boolean),
              baseEdgeKeys: (Array.isArray(baseline.edges) ? baseline.edges : []).map(edgeRevisionKey).filter(Boolean),
            })
            if (response && response.error) {
              const failure = new Error(response.error.message || 'trajectory graph commit failed')
              failure.details = response.error
              throw failure
            }
            if (response && Number.isInteger(response.revision)) trajRevisionRef.current = response.revision
            graphSemanticOperations.delete(g)
            writeTrajResult(sessionId, { graph: g, traceText: sourceText, traceEvents, revision: trajRevisionRef.current, ts: Date.now() })
            return response
          }).catch((error) => {
            const details = error && error.details && typeof error.details === 'object' ? error.details : error
            graphSemanticOperations.delete(g)
            setError({ ...(details && typeof details === 'object' ? details : {}), message: details && details.message ? details.message : '轨迹知识图提交失败' })
            if (baseline && baseline !== g) setView(makeView(baseline, sourceText))
            return null
          })
          trajCommitQueueRef.current = queued
          return queued
        }
        const commitTrajGraph = (g) => {
          if (!view) return
          const baseline = view.graph
          setView(makeView(g, view.sourceText))
          persistTrajGraph(g, baseline)
        }
        const attachTrajReport = (report, stale) => {
          if (!view) return
          const baseline = view.graph
          const g2 = withVerification(baseline, report, stale)
          setView(makeView(g2, view.sourceText))
          persistTrajGraph(g2, baseline)
        }
        const startQuickVerify = async () => {
          if (!view || verifyBusyRef.current) return
          setError(null)
          setVerifyPhase('running')
          verifyBusyRef.current = true
          try {
            const res = await host.call('verify-graph', {
              title: '', text: view.sourceText || '',
              graph: { summary: view.graph.summary || '', nodes: view.graph.nodes, edges: view.graph.edges },
              mode: 'quick',
              ...(effectiveModelArg ? { model: effectiveModelArg } : {}),
            })
            if (res && res.error) { setError(res.error); return }
            if (res && res.report) {
              const m = res.report.metrics || {}
              setVerification(res.report)
              attachTrajReport(res.report, false)
              setActiveIssueId(null)
              showToast('快速体检完成：确定性错误 ' + (m.errorCount || 0) + ' / 质量警告 ' + (m.warningCount || 0) + ' / 建议 ' + (m.suggestionCount || 0))
            } else setError({ message: '快速体检没有返回报告，请重试' })
          } catch (e) {
            setError({ message: '快速体检失败：' + (e && e.message ? e.message : '未知错误') })
          } finally {
            setVerifyPhase('idle')
            verifyBusyRef.current = false
          }
        }
        const startDeepVerify = async () => {
          if (!view || verifyBusyRef.current) return
          setError(null)
          setVerifyPhase('running')
          verifyBusyRef.current = true
          try {
            const res = await host.call('verify-graph', {
              title: '', text: view.sourceText || '',
              graph: { summary: view.graph.summary || '', nodes: view.graph.nodes, edges: view.graph.edges },
              mode: 'standard',
              ...(effectiveModelArg ? { model: effectiveModelArg } : {}),
            })
            if (res && res.error) {
              setVerifyPhase('idle'); verifyBusyRef.current = false
              setError(res.error)
              return
            }
            if (res && res.taskId) setVerifyTaskId(res.taskId)
            else { setVerifyPhase('idle'); verifyBusyRef.current = false; setError({ message: '无法提交验证任务，请重试' }) }
          } catch (e) {
            setVerifyPhase('idle'); verifyBusyRef.current = false
            setError({ message: '无法提交验证任务：' + (e && e.message ? e.message : '未知错误') })
          }
        }
        const startFactCheck = async () => {
          if (!view || factPhase === 'running') return
          setError(null)
          setFactPhase('running')
          try {
            const res = await host.call('fact-check', {
              title: '', text: view.sourceText || '',
              graph: { summary: view.graph.summary || '', nodes: view.graph.nodes, edges: view.graph.edges },
              mode: 'deep',
              sources: factRules.trim() ? ['wikipedia', 'rules'] : ['wikipedia'],
              rules: factRules.trim(),
              ...(effectiveModelArg ? { model: effectiveModelArg } : {}),
            })
            if (res && res.error) { setFactPhase('idle'); setError(res.error); return }
            if (res && res.taskId) setFactTaskId(res.taskId)
            else { setFactPhase('idle'); setError({ message: '无法提交外部核查任务，请重试' }) }
          } catch (e) {
            setFactPhase('idle')
            setError({ message: '无法提交外部核查任务：' + (e && e.message ? e.message : '未知错误') })
          }
        }
        const handleCancelExtract = async () => {
          if (!taskId) return
          try {
            const res = await host.call('task-cancel', { taskId })
            if (res && res.status === 'cancelling') showToast('正在取消拆解任务…')
          } catch (e) {
            showToast('取消失败：' + (e && e.message ? e.message : '未知错误'))
          }
        }
        const handleCancelVerify = async () => {
          const id = verifyTaskId || questionTaskId
          if (!id) return
          try {
            const res = await host.call('task-cancel', { taskId: id })
            if (res && res.status === 'cancelling') showToast('正在取消任务…')
          } catch (e) {
            showToast('取消失败：' + (e && e.message ? e.message : '未知错误'))
          }
        }
        const handleCancelFact = async () => {
          if (!factTaskId) return
          try {
            const res = await host.call('task-cancel', { taskId: factTaskId })
            if (res && res.status === 'cancelling') showToast('正在取消外部核查…')
          } catch (e) {
            showToast('取消失败：' + (e && e.message ? e.message : '未知错误'))
          }
        }
        const handleSelectFactClaim = (claim) => {
          setFactActiveId(claim.id)
          if (!view || !claim) return
          if (claim.nodeId) {
            setSelectedNodeId(claim.nodeId)
            setSelectedEdgeId(null)
            const off = view.anchors[claim.nodeId]
            if (off != null) {
              const pi = view.paragraphs.findIndex((p) => off >= p.start && off < p.end)
              if (pi >= 0) {
                const el = document.getElementById('kg-traj-para-' + pi)
                if (el) { scrollElIntoCenter(el); setActivePara(pi); setFlashPara(pi); ctx.timeout(() => setFlashPara(-1), 1400) }
              }
            }
          }
        }
        const handleRejectFactClaim = (claim) => {
          if (!factReport) return
          const report = { ...factReport, claims: (factReport.claims || []).map((c) => c.id === claim.id ? { ...c, status: 'rejected' } : c) }
          setFactReport(report)
          if (view) {
            const g2 = withFactCheck(view.graph, report, factReport.stale === true)
            setView(makeView(g2, view.sourceText))
            persistTrajGraph(g2)
          }
          showToast('已忽略该外部质疑')
        }
        const submitQuestion = async (draftOverride, targetOverride) => {
          const q = (typeof draftOverride === 'string' ? draftOverride : questionDraft).trim()
          if (!q || !view || questionPhase === 'running') return
          setError(null)
          setQuestionPhase('running')
          setQuestionResult(null)
          try {
            const res = await host.call('question-graph', {
              title: '', text: view.sourceText || '',
              graph: { summary: view.graph.summary || '', nodes: view.graph.nodes, edges: view.graph.edges },
              target: targetOverride || questionTarget || { kind: 'graph', id: null },
              question: q,
              ...(effectiveModelArg ? { model: effectiveModelArg } : {}),
            })
            if (res && res.error) { setQuestionPhase('idle'); setError(res.error); return }
            if (res && res.taskId) setQuestionTaskId(res.taskId)
            else { setQuestionPhase('idle'); setError({ message: '无法提交质疑任务，请重试' }) }
          } catch (e) {
            setQuestionPhase('idle')
            setError({ message: '无法提交质疑任务：' + (e && e.message ? e.message : '未知错误') })
          }
        }
        const handleApplyIssue = (issue) => {
          if (!view) return
          const next = applyPatch(view.graph, issue)
          if (next === view.graph) {
            if (patchAlreadySatisfied(view.graph, issue)) {
              let report = verification
              if (report && Array.isArray(report.issues) && !report.issues.some((it) => it.id === issue.id)) report = { ...report, issues: [...report.issues, issue] }
              if (report) report = updateIssueStatus(report, issue.id, 'applied')
              const g2 = withVerification(next, report, report ? report.stale === true : false)
              setVerification(report)
              setActiveIssueId(null)
              commitTrajGraph(g2)
              showToast('修复目标已是最新状态，已标记为已处理')
              return
            }
            showToast('该问题没有可应用的补丁（目标可能已变化，请重新体检）')
            return
          }
          let report = verification
          if (report && Array.isArray(report.issues) && !report.issues.some((it) => it.id === issue.id)) report = { ...report, issues: [...report.issues, issue] }
          if (report) report = updateIssueStatus(report, issue.id, 'applied')
          const g2 = withVerification(next, report, report ? report.stale === true : false)
          setVerification(report)
          setActiveIssueId(null)
          if (issue.targetKind === 'node' && next.nodes.some((n) => n.id === issue.targetId)) {
            setSelectedNodeId(issue.targetId)
            setSelectedEdgeId(null)
          } else if (issue.targetKind === 'edge' && issue.targetId != null) {
            const idx = edgeIndexForIssue(next, issue)
            if (idx != null) { setSelectedEdgeId(idx); setSelectedNodeId(null) }
            else { setSelectedNodeId(null); setSelectedEdgeId(null) }
          } else {
            setSelectedNodeId(null)
            setSelectedEdgeId(null)
          }
          commitTrajGraph(g2)
          showToast('已应用修复：' + (issue.title || ''))
        }
        const handleApplyAll = () => {
          if (!view || !verification) return
          const open = (verification.issues || []).filter((it) => it.status === 'open')
          const fixable = open.filter((it) => it.proposedFix && it.proposedFix.action && it.proposedFix.action !== 'none')
          if (fixable.length === 0) {
            showToast('没有可自动修复的待处理问题')
            return
          }
          if (!window.confirm('将一键应用 ' + fixable.length + ' 个可自动修复的问题' + (open.length > fixable.length ? '，另有 ' + (open.length - fixable.length) + ' 个需要人工复核' : '') + '。继续吗？')) return
          const res = applyAllFixable(view.graph, verificationRef.current || verification)
          const g2 = withVerification(res.graph, res.report, res.report ? res.report.stale === true : false)
          setVerification(res.report)
          setActiveIssueId(null)
          setSelectedNodeId(null)
          setSelectedEdgeId(null)
          commitTrajGraph(g2)
          showToast('一键修复完成：已应用 ' + res.applied + ' 项，跳过 ' + res.skipped + ' 项')
        }
        const handleRejectIssue = (issue) => {
          if (!verification) return
          const report = updateIssueStatus(verification, issue.id, 'rejected')
          setVerification(report)
          attachTrajReport(report, verification.stale === true)
          showToast('已忽略该问题')
        }
        const handleRecheckIssue = (issue) => {
          const target = issue.targetKind === 'graph' ? { kind: 'graph', id: null } : { kind: issue.targetKind, id: issue.targetId }
          const draft = '请复核这个问题：' + issue.title + (issue.detail ? '。' + issue.detail : '')
          setQuestionTarget(target)
          setQuestionDraft(draft)
          setQuestionResult(null)
          setActiveIssueId(issue.id)
          submitQuestion(draft, target)
          showToast('已提交复核任务，等待质疑结果')
        }
        const handleQuestionNode = (node) => {
          setQuestionTarget({ kind: 'node', id: node.id })
          setQuestionResult(null)
          showToast('已选择节点 ' + node.id + '，请在验证面板输入质疑')
        }
        const handleOpenNodeIssues = (node) => {
          if (!verification || !Array.isArray(verification.issues)) {
            showToast('请先运行「快速体检」或「AI 深度审校」')
            return
          }
          const list = verification.issues.filter((it) => it.targetKind === 'node' && it.targetId === node.id && (it.status === 'open' || it.status === 'accepted'))
          if (list.length === 0) {
            showToast('该节点没有待处理的问题')
            return
          }
          setActiveIssueId(list[0].id)
          setSelectedNodeId(node.id)
          setSelectedEdgeId(null)
          const panel = document.getElementById('kg-verify-panel-traj')
          if (panel && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          showToast('已定位该节点的 ' + list.length + ' 个问题')
        }
        const handleOpenFactPanel = () => {
          const panel = document.getElementById('kg-fact-panel-traj')
          if (panel && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          showToast('在下方「外部事实核查」面板粘贴领域规则并开始核查')
        }
        const handleQuestionEdge = (edge) => {
          setQuestionTarget({ kind: 'edge', id: edgeKeyOf(edge) })
          setQuestionResult(null)
          showToast('已选择关系 ' + edgeKeyOf(edge) + '，请在验证面板输入质疑')
        }
        const handleDeleteEdge = (edge) => {
          if (!edge) return
          const key = edgeKeyOf(edge)
          const rel = REL_LABEL[edge.relation] || edge.relation
          if (!window.confirm('确定删除关系 ' + key + '（' + rel + '）吗？此操作会写入审计记录。')) return
          handleApplyIssue({
            id: 'manual-del-' + Date.now(), source: 'manual', severity: 'warning', category: 'relation',
            targetKind: 'edge', targetId: key,
            title: '手动删除关系：' + key + '（' + rel + '）',
            detail: '用户手动确认删除该关系。', evidence: [], confidence: 1,
            proposedFix: { action: 'delete_edge', edgePatch: { fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId, relation: edge.relation } },
            status: 'open',
          })
        }
        const handleDeleteQuestionTarget = (target) => {
          if (!view || !target || target.kind === 'graph') return
          if (target.kind === 'edge') {
            const edge = (view.graph.edges || []).find((e) => edgeKeyOf(e) === target.id)
            if (!edge) { showToast('找不到该关系，可能已被删除'); return }
            handleDeleteEdge(edge)
          } else if (target.kind === 'node') {
            const node = (view.graph.nodes || []).find((n) => n.id === target.id)
            if (!node) { showToast('找不到该节点，可能已被删除'); return }
            if (!window.confirm('确定删除节点 ' + node.id + '（' + node.text.slice(0, 40) + '）及其所有关系边吗？此操作会写入审计记录。')) return
            handleApplyIssue({
              id: 'manual-del-' + Date.now(), source: 'manual', severity: 'warning', category: 'other',
              targetKind: 'node', targetId: node.id,
              title: '手动删除节点：' + node.id,
              detail: '用户手动确认删除该节点。', evidence: [], confidence: 1,
              proposedFix: { action: 'delete_node', nodePatch: { id: node.id } },
              status: 'open',
            })
          }
        }
        const handleSelectIssue = (issue) => {
          setActiveIssueId(issue.id)
          if (!view) return
          if (issue.targetKind === 'node' && issue.targetId) {
            setSelectedNodeId(issue.targetId)
            setSelectedEdgeId(null)
            const off = view.anchors[issue.targetId]
            if (off != null) {
              const pi = view.paragraphs.findIndex((p) => off >= p.start && off < p.end)
              if (pi >= 0) {
                const el = document.getElementById('kg-traj-para-' + pi)
                if (el) { scrollElIntoCenter(el); setActivePara(pi); setFlashPara(pi); ctx.timeout(() => setFlashPara(-1), 1400) }
              }
            }
          } else if (issue.targetKind === 'edge' && issue.targetId != null) {
            const idx = edgeIndexForIssue(view.graph, issue)
            if (idx != null) { setSelectedEdgeId(idx); setSelectedNodeId(null) }
          }
        }

        const scrollElIntoCenter = (el) => {
          const c = el.closest('.kg-traj-original')
          if (!c || c.scrollHeight <= c.clientHeight + 2) return false
          const cRect = c.getBoundingClientRect()
          const tRect = el.getBoundingClientRect()
          const delta = tRect.top - cRect.top - (cRect.height - tRect.height) / 2
          if (Math.abs(delta) > 4) { c.scrollBy({ top: delta, behavior: 'smooth' }); return true }
          return false
        }
        const handleSelectNode = (nodeId) => {
          setSelectedNodeId(nodeId)
          setSelectedEdgeId(null)
          if (!nodeId || !view) return
          const off = view.anchors[nodeId]
          if (off == null) { showToast('该节点无法回链轨迹原文'); return }
          const pi = view.paragraphs.findIndex((p) => off >= p.start && off < p.end)
          if (pi < 0) { showToast('未找到对应轨迹事件'); return }
          const el = document.getElementById('kg-traj-para-' + pi)
          if (!el) { showToast('未找到对应轨迹事件'); return }
          scrollElIntoCenter(el)
          setActivePara(pi)
          setFlashPara(pi)
          ctx.timeout(() => setFlashPara(-1), 1400)
          showToast('已定位轨迹事件 #' + (pi + 1))
        }
        const handleSelectEdge = (idx) => { setSelectedEdgeId(idx); setSelectedNodeId(null) }
        const handleParagraphClick = (pi) => {
          if (!view) return
          setActivePara(pi)
          const ids = view.paraNodes[pi] || []
          if (ids.length === 0) { showToast('该事件没有可定位的节点'); return }
          const id = ids[0]
          setSelectedNodeId(id)
          setSelectedEdgeId(null)
          setFocusReq((f) => ({ nodeId: id, seq: f.seq + 1 }))
          showToast('已在图中聚焦该事件节点')
        }
        const changeLayoutMode = (id) => {
          setLayoutMode(id)
          try { localStorage.setItem(LS_LAYOUT, id) } catch (e) {}
        }
        const handleModelChange = (key) => {
          setModelChoice(key)
          writeModelChoice(key)
        }

        // ---- column width / result height drag handlers ----
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
            try { localStorage.setItem(LS_TRAJ_SPLIT, String(Math.round(splitRatio))) } catch (err) {}
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
            try { localStorage.setItem(LS_TRAJ_HEIGHT, String(Math.round(resultHeight))) } catch (err) {}
          }
        }

        const paraEl = (p, i) => {
          const badges = view ? (view.paraTypes[i] || []) : []
          // New trace data records event offsets in traceText; one long event
          // may span several content units, so map by [start, end) and only
          // fall back to the 1:1 index for older cached results.
          let ev = traceEvents[i] || null
          if (p && typeof p.start === 'number' && Array.isArray(traceEvents)) {
            const ranged = traceEvents.find((e) => e && typeof e.start === 'number' && typeof e.end === 'number' && p.start >= e.start && p.start < e.end)
            if (ranged) ev = ranged
          }
          const evLabel = ev ? (TRACE_TYPE_LABEL[ev.type] || ev.type) : ''
          return h('div', {
            key: i, id: 'kg-traj-para-' + i,
            className: 'kg-para' + (activePara === i ? ' kg-active' : '') + (flashPara === i ? ' kg-flash' : ''),
            role: 'button', tabIndex: 0,
            'aria-label': '轨迹事件 ' + (i + 1) + (evLabel ? '（' + evLabel + '）' : '') + '，点击可在图中聚焦对应节点',
            onClick: () => handleParagraphClick(i),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleParagraphClick(i) } },
          },
            h('div', { className: 'kg-traj-ev-meta' },
              ev ? h('span', { className: 'kg-traj-ev-chip' }, evLabel) : null,
              h('span', null, '#' + (ev && typeof ev.seq === 'number' ? ev.seq : i + 1)),
              h('span', { className: 'kg-para-num', title: '段落编号 P' + (i + 1) }, 'P' + (i + 1)),
              badges.length > 0
                ? h('span', { className: 'kg-para-badges' },
                    badges.map((t) => h('span', { key: t, className: 'knowledge-type-badge kg-badge-' + t }, TYPE_META[t].label)))
                : null,
            ),
            h('p', null, p.text),
          )
        }

        const resultPanel = view
          ? (() => {
              const graph = view.graph
              const resolvedCount = graph.nodes.length - view.unresolved.length
              const diagCount = (graph.warnings ? graph.warnings.length : 0) + view.unresolved.length
               const sourceMeta = graph.source && typeof graph.source === 'object' ? graph.source : null
               const stagingMeta = graph.staging && typeof graph.staging === 'object' ? graph.staging : null
               const generationMeta = graph.generation && typeof graph.generation === 'object' ? graph.generation : null
               const connectivityMeta = generationMeta && generationMeta.connectivity && typeof generationMeta.connectivity === 'object' ? generationMeta.connectivity : null
              const diagLines = []
              for (const w of graph.warnings || []) diagLines.push('warning: ' + w)
              for (const u of view.unresolved) diagLines.push('anchor_unresolved:node:' + u.id + (u.quote ? '（摘录：' + u.quote + '…）' : '（无摘录）'))
              return h(React.Fragment, null,
                h('p', { className: 'kg-summary' }, h('strong', null, '一句话总结：'), ' ', graph.summary || '（无）'),
                h('div', { className: 'kg-stats' },
                  h('span', null, graph.nodes.length + ' 个节点'),
                  h('span', null, (graph.edges || []).length + ' 条关系'),
                  connectivityMeta && connectivityMeta.after
                    ? h('span', {
                        title: '全图连通性：最大连通分量覆盖 ' + Math.round((connectivityMeta.after.largestComponentRatio || 0) * 100) + '%' + (connectivityMeta.attempted ? '；已执行关系编织' : ''),
                      }, '全图 ' + (connectivityMeta.after.componentCount || 0) + ' 个分量 · ' + (connectivityMeta.after.isolatedNodes || 0) + ' 个孤立' + (connectivityMeta.addedEdges ? ' · 补 ' + connectivityMeta.addedEdges + ' 条关系' : ''))
                    : null,
                  h('span', null, '回链事件 ' + resolvedCount + '/' + graph.nodes.length),
                  sourceMeta && sourceMeta.sectionCount > 0 ? h('span', null, sourceMeta.sectionCount + ' 个章节 · ' + (sourceMeta.chunkCount || 0) + ' 个内容块') : null,
                   stagingMeta && stagingMeta.chunkCount > 0 ? h('span', null, '已保留 ' + stagingMeta.chunkCount + ' 个分块结果') : null,
                   appendCount > 0 ? h('span', null, '已追加 ' + appendCount + ' 次') : null,
                   generationMeta ? h('span', { style: { color: generationMeta.invariantErrors === 0 ? '#059669' : '#dc2626' } }, '生成验收：确定性错误 ' + (generationMeta.invariantErrors || 0) + (generationMeta.grounding && generationMeta.grounding.evidenceBackedClaims != null ? ' · 证据声明 ' + generationMeta.grounding.evidenceBackedClaims : '') + (generationMeta.grounding && (generationMeta.grounding.candidateClaims || generationMeta.grounding.unsupportedClaims) ? ' · 待证实声明 ' + ((generationMeta.grounding.candidateClaims || 0) + (generationMeta.grounding.unsupportedClaims || 0)) : '') + (generationMeta.grounding && generationMeta.grounding.entailmentStatus === 'unverified' ? ' · 语义未独立验证' : '') + (generationMeta.retryCount ? ' · 重试 ' + generationMeta.retryCount : '') + (generationMeta.autoRepairCount ? ' · 自动修复 ' + generationMeta.autoRepairCount : '')) : null,
                  h('span', { className: 'kg-verify-actions', style: { margin: '-6px 0 0' } },
                    h('button', { type: 'button', className: 'kg-secondary', onClick: startQuickVerify, disabled: verifyPhase === 'running' || verifyBusyRef.current }, '⚡ 快速体检'),
                    h('button', { type: 'button', className: 'kg-secondary', onClick: startDeepVerify, disabled: verifyPhase === 'running' || verifyBusyRef.current }, verifyPhase === 'running' ? '审校中…' : '🤖 AI 深度审校'),
                    h('button', { type: 'button', className: 'kg-secondary', onClick: handleOpenFactPanel, disabled: factPhase === 'running' }, factPhase === 'running' ? '核查中…' : '🔎 外部事实核查')),
                  h(GraphExportActions, { graph: view.graph, title: '轨迹知识图', ctx }),
                  diagCount > 0
                    ? h('button', {
                        type: 'button', className: 'kg-diag-toggle',
                        'aria-expanded': showDiag,
                        onClick: () => setShowDiag(!showDiag),
                      }, '诊断 ' + diagCount + ' 条（含无法回链的节点）' + (showDiag ? ' ▴' : ' ▾'))
                    : null,
                ),
                showDiag ? h('div', { className: 'kg-diag-list' }, diagLines.join(NL)) : null,
                h('p', { className: 'kg-hint' }, '点击轨迹事件 → 图中聚焦该事件节点；点击图中节点 → 弹出详情卡片（含完整内容）并滚动到对应事件；右上角可切换布局形态（力导向 / 圆形 / 放射 / 分层），长按节点查看轨迹摘录。拖拽中间竖条调整两列宽度，拖拽下方横条调整结果区高度。'),
                h('div', {
                  className: 'kg-traj-cols',
                  ref: colsRef,
                  style: { '--kg-traj-split': splitRatio + '%' },
                  onPointerMove: onSplitMove,
                  onPointerUp: onSplitUp,
                },
                  h('div', { className: 'kg-traj-original', 'aria-label': '轨迹事件', style: { maxHeight: resultHeight + 'px' } },
                    view.paragraphs.map(paraEl)),
                  h('div', {
                    className: 'kg-traj-split-handle', role: 'separator', 'aria-orientation': 'vertical',
                    'aria-label': '拖动调整轨迹事件与知识图宽度比例', title: '拖动调整宽度比例',
                    onPointerDown: startSplitDrag,
                  },
                    h('div', { className: 'kg-traj-split-bar' })),
                  h('div', { className: 'kg-graph-col' },
                    h(GraphViewer, {
                      nodes: graph.nodes, edges: graph.edges, anchors: view.anchors,
                      selectedNodeId, selectedEdgeId, focusReq,
                      onSelectNode: handleSelectNode, onSelectEdge: handleSelectEdge, ctx,
                      height: resultHeight,
                      layoutMode, onLayoutModeChange: changeLayoutMode,
                      issueReport: verification,
                      onQuestionNode: handleQuestionNode, onQuestionEdge: handleQuestionEdge,
                      onDeleteEdge: handleDeleteEdge,
                      onOpenNodeIssues: handleOpenNodeIssues,
                      exportTitle: '轨迹知识图',
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

        return h('div', { className: 'kg-root kg-traj-body' },
          trajToast ? h('div', { className: 'kg-toast', role: 'status' }, trajToast) : null,
          error
            ? h('div', { className: 'kg-banner', role: 'alert' },
                h('span', null, error.message || '出错了，请重试'),
                h('button', { type: 'button', 'aria-label': '关闭提示', onClick: () => setError(null) }, '×'),
              )
            : null,
          phase === 'extracting'
            ? h('div', { className: 'kg-empty' },
                h('div', { className: 'kg-spinner', 'aria-hidden': 'true' }),
                h('p', null, '正在用 AI 拆解本会话轨迹…'),
                h('p', { className: 'kg-empty-sub' }, '使用模型：' + modelLabelOf((extractProgress && extractProgress.model) || effectiveModelArg, modelChoice)),
                extractProgress
                  ? h('p', { className: 'kg-empty-sub' },
                      (extractProgress.stage || '运行中') + ' · 已运行 ' + Math.round((extractProgress.elapsedMs || 0) / 60000) + ' 分钟 · 已接收 ' + (extractProgress.charsReceived || 0) + ' 字符' + (extractProgress.batch && extractProgress.batch.total ? ' · 内容块 ' + extractProgress.batch.index + '/' + extractProgress.batch.total : ''))
                  : null,
                extractProgress && extractProgress.warning
                  ? h('p', { className: 'kg-empty-sub', style: { color: '#b45309' } }, '⚠ ' + extractProgress.warning)
                  : null,
                h('p', { className: 'kg-empty-sub' }, '拆解内容：查到了什么事实、做出了什么推论、使用了哪些工具与方法。'),
                h('button', { type: 'button', className: 'kg-secondary kg-danger', onClick: handleCancelExtract }, '取消任务'),
              )
            : view
              ? h('section', { className: 'kg-card kg-result', 'aria-label': '轨迹 ⇄ 知识图结果' },
                  h('div', { className: 'kg-panel-head' },
                    h('h3', { className: 'kg-section-title' }, '轨迹 ⇄ 知识图'),
                    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                      h(ModelPicker, { value: modelChoice, onChange: handleModelChange }),
                      h('button', { type: 'button', className: 'kg-primary kg-append-btn', onClick: appendExtract }, '追加新事件'),
                      h('button', { type: 'button', className: 'kg-secondary', onClick: extract }, '重新拆解'),
                    ),
                  ),
                  resultPanel,
                  (verification || verifyPhase === 'running' || questionResult || questionTarget)
                    ? h(VerificationPanel, {
                        report: verification, graph: view.graph, resultView: view,
                        verifying: verifyPhase === 'running' || questionPhase === 'running',
                        activeIssueId, onSelectIssue: handleSelectIssue,
                        onApplyIssue: handleApplyIssue, onRejectIssue: handleRejectIssue, onRecheckIssue: handleRecheckIssue,
                        onApplyAll: handleApplyAll,
                        issueFilter, setIssueFilter,
                        questionDraft, setQuestionDraft, questionTarget,
                        clearQuestionTarget: () => { setQuestionTarget(null); setQuestionResult(null) },
                        questionResult, questionPhase, onSubmitQuestion: submitQuestion,
                        onDeleteTarget: handleDeleteQuestionTarget,
                        panelId: 'kg-verify-panel-traj',
                        progress: verifyProgress,
                        onCancel: handleCancelVerify,
                      })
                    : null,
                  h(FactCheckPanel, {
                        report: factReport, graph: view.graph, resultView: view,
                        verifying: factPhase === 'running',
                        activeClaimId: factActiveId,
                        onSelectClaim: handleSelectFactClaim,
                        onRejectClaim: handleRejectFactClaim,
                        panelId: 'kg-fact-panel-traj',
                        rulesDraft: factRules, setRulesDraft: setFactRules,
                        onStartFactCheck: startFactCheck,
                        progress: factProgress,
                        onCancel: handleCancelFact,
                      })
                )
              : h('section', { className: 'kg-card', 'aria-label': '轨迹知识图' },
                  h('div', { className: 'kg-kicker' }, '会话轨迹'),
                  h('h3', { className: 'kg-section-title' }, '把本会话的 AI 轨迹做成知识图'),
                  h('p', { className: 'kg-subtitle' },
                    sessionId
                      ? '自动读取本会话的完整轨迹（用户消息、工具调用、工具结果、AI 回复），用 AI 拆解出「查到了什么事实、做出了什么推论、用了什么方法」，并在图与轨迹事件之间双向定位。'
                      : '未获取到会话上下文，请先在本会话中发言后再试。'),
                  h('div', { className: 'kg-actions' },
                    h('span', { style: { marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 8 } }, h(ModelPicker, { value: modelChoice, onChange: handleModelChange })),
                    h('button', {
                      type: 'button', className: 'kg-primary',
                      disabled: !sessionId,
                      onClick: extract,
                    }, sessionId ? '拆解本会话轨迹' : '当前会话不可用'),
                  ),
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
        { name: 'shell.overlay', id: 'kg-selection-tool', order: 89 },
        () => h(SelectionTool, null),
      ))

      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'kg-workbench-window', order: 90 },
        () => h(FloatingWindow, { ctx }),
      ))

      slots.inject('conversation.session.header.actions', () => slots.register(
        { name: 'conversation.session.header.actions', id: 'kg-workbench-launcher', label: '知识图' },
        () => h(HeaderLauncher, null),
      ))

      slots.inject('conversation.input.left', () => slots.register(
        { name: 'conversation.input.left', id: 'kg-document-import', order: -80, label: '附件生成知识图', inject: (sessionId) => ({ sessionId }) },
        (props) => h(DocImportButton, {
          sessionId: props ? props.sessionId : undefined,
          input: props ? props.input : undefined,
        }),
      ))

      slots.inject('conversation.view', () => slots.register(
        { name: 'conversation.view', id: 'kg-trajectory', order: 20, label: '轨迹知识图' },
        (props) => h(TrajectoryTab, { sessionId: props ? props.sessionId : undefined }),
      ))
    },
  }
}
