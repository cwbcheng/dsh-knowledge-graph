import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

export const draftDiagnosisText = element => Array.isArray(element) ? element.map(draftDiagnosisText).join('')
  : element && typeof element === 'object' ? draftDiagnosisText(element.props?.children) : String(element ?? '')
export const draftDiagnosisJson = value => JSON.parse(JSON.stringify(value))

// Exercise the generated editor and real Host reads. Observers and manual
// debounce timers are test controls; neither is included in benchmark timings.
export function draftDiagnosisView(source, harness, { observe, transform, console: runtimeConsole = console } = {}) {
  const owner = { states: [], effects: [] }, updates = [], cache = new Map(), timers = new Map()
  let cursor = 0, tree, focused = null, timerId = 0
  const slot = init => { const index = cursor++; return owner.states[index] ||= init() }
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } } },
    useState(initial) { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, next => updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })] },
    useRef(initial) { return slot(() => ({ current: initial })) },
    useEffect(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) { owner.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps } },
  }
  const context = { window: { React, confirm: () => true }, console: runtimeConsole, AbortController,
    sessionStorage: { getItem: key => cache.get(key) || null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id),
    __observeDraft: (spec, ports, names, report) => { observe({ spec, ports, names, report }); return report } }
  const method = source.includes('MODEL_STRUCTURE_TOOLS.diagnoseOwnedDraft(spec,') ? 'diagnoseOwnedDraft' : 'diagnose'
  const call = 'MODEL_STRUCTURE_TOOLS.' + method + '(spec, { ports: legacyPorts, names: endpointNames })'
  if (observe) { assert.equal(source.split(call).length, 2); source = source.replace(call, '__observeDraft(spec, legacyPorts, endpointNames, ' + call + ')') }
  runInNewContext(source, context)
  const { ModelStructureEditor, ModelGapList } = context.window.KGViewer
  const all = (e, predicate) => Array.isArray(e) ? e.flatMap(child => all(child, predicate)) : !e || typeof e !== 'object' ? []
    : [...(predicate(e) ? [e] : []), ...(e.type === ModelGapList ? all(ModelGapList(e.props), predicate) : all(e.props?.children, predicate))]
  const props = { documentId: harness.document.documentId, revision: 1, modelId: 'taxi', active: true, busy: false,
    async load(args, signal) { const result = await harness.post(args, 'connection-models'); return transform ? transform(args, result, signal) : result },
    onCommit: () => { throw new Error('Draft diagnosis controls must not save') } }
  function render() {
    for (let i = 0; i < 30; i++) {
      updates.splice(0).forEach(fn => fn()); cursor = 0; tree = ModelStructureEditor(props)
      if (tree?.props.ref) tree.props.ref.current = { querySelectorAll: () => all(tree, e => e.props['aria-label']).map(e => ({
        getAttribute: name => e.props[name], closest: () => null, focus: () => { focused = e },
      })) }
      owner.effects.splice(0).forEach(fn => fn()); if (!updates.length) return
    }
    throw new Error('draft diagnosis update loop')
  }
  const settle = async () => { for (let i = 0; i < 8; i++) { await new Promise(setImmediate); render() } }
  const button = label => { const e = all(tree, e => e.type === 'button' && (e.props['aria-label'] === label || draftDiagnosisText(e) === label))[0]; assert(e, label); assert(!e.props.disabled); return e }
  const field = label => { const e = all(tree, e => e.props['aria-label'] === label)[0]; assert(e, label); return e }
  const report = () => all(tree, e => e.type === ModelGapList)[0]?.props.report
  return { props, cache, render, settle, button, field, report,
    change(label, value) { field(label).props.onChange({ target: { value } }); render() },
    click(label) { button(label).props.onClick(); render() },
    async flushDebounce() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); render(); await settle() },
    stop() { owner.states.forEach(state => state.cleanup?.()); timers.clear() },
    get tree() { return tree }, get focused() { return focused } }
}
