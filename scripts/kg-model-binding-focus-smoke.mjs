import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelBindingFocusFixture } from './kg-model-binding-focus-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: modelBindingFocusFixture() })
let owner, cursor = 0, tree, focused
const updates = [], cache = new Map()
const stateSlot = init => { const index = cursor++; return owner.states[index] ||= init() }
const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } } },
  useState(initial) { const state = stateSlot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, next => updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })] },
  useRef(initial) { return stateSlot(() => ({ current: initial })) },
  useEffect(fn, deps) { const state = stateSlot(() => ({})); if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) { owner.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps } },
}
const context = { window: { React, confirm: () => true }, console, AbortController,
  sessionStorage: { getItem: key => cache.get(key) || null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) },
  setTimeout: () => 1, clearTimeout() {} }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const { ModelStructureEditor, ModelGapList } = context.window.KGViewer
const text = element => Array.isArray(element) ? element.map(text).join('') : element && typeof element === 'object' ? text(element.props?.children) : String(element ?? '')
const all = (element, predicate) => Array.isArray(element) ? element.flatMap(child => all(child, predicate)) : !element || typeof element !== 'object' ? []
  : element.type === ModelGapList ? all(ModelGapList(element.props), predicate) : [...(predicate(element) ? [element] : []), ...all(element.props?.children, predicate)]
const props = { documentId: harness.document.documentId, revision: 1, modelId: 'multi', active: true, busy: false,
  load: args => harness.post(args, 'connection-models'), onCommit: () => { throw new Error('Gap navigation must not write') } }
owner = { states: [], effects: [] }
function render() {
  for (let i = 0; i < 30; i++) {
    updates.splice(0).forEach(fn => fn()); cursor = 0; tree = ModelStructureEditor(props)
    if (tree?.props.ref) tree.props.ref.current = { querySelectorAll: () => all(tree, e => e.props['aria-label']).map(e => ({
      getAttribute: name => e.props[name], closest: () => null, focus: () => { focused = e },
    })) }
    owner.effects.splice(0).forEach(fn => fn()); if (!updates.length) return
  }
  throw new Error('binding focus update loop')
}
const settle = async () => { for (let i = 0; i < 8; i++) { await new Promise(setImmediate); render() } }
const click = label => { const e = all(tree, e => e.type === 'button' && (e.props['aria-label'] === label || text(e) === label))[0]; assert(e); assert(!e.props.disabled); e.props.onClick(); render() }
const request = async (code, slotId) => {
  const report = await harness.post({ documentId: props.documentId, expectedRevision: 1, modelId: 'multi', diagnosis: true }, 'connection-models')
  assert.equal(report.error, undefined)
  const gap = report.diagnosis.items.find(item => item.code === code && item.target.id === 'identity-example-20')
  assert(gap); assert.equal(gap.missing[0].slotId, slotId)
  const targets = [], list = ModelGapList({ report: report.diagnosis, onEdit: target => targets.push(target), busy: false })
  const button = all(list, e => e.type === 'button' && e.props['aria-label'] === '整理缺口 ' + gap.id)[0]
  assert(button); button.props.onClick(); assert.equal(targets[0].missingSlotId, slotId)
  props.focusRequest = { ...targets[0], documentId: props.documentId, revision: 1, modelId: 'multi' }
  render(); await settle()
}
try {
  const before = JSON.stringify(harness.store.getDocument(props.documentId))
  render(); await settle()
  await request('example_inputs', 'other-speed')
  assert.equal(focused.props.value, '', 'same-name gap must focus its blank independent slot, not the populated first input')
  focused.props.onChange({ target: { value: '仅填写第二对象输入，仍未核验' } }); render(); await settle()
  let draft = JSON.parse(cache.values().next().value).spec, example = draft.examples.find(e => e.id === 'identity-example-20')
  assert.equal(example.inputs.find(b => b.slotId === 'initial-speed').value, '已填写的第一输入')
  assert.equal(example.inputs.find(b => b.slotId === 'other-speed').value, '仅填写第二对象输入，仍未核验')
  await request('example_outputs', 'other-final-speed')
  assert.equal(focused.props['aria-label'], '补齐输出槽位', 'an absent same-name binding must focus the explicit repair action')
  click('补齐输出槽位'); await settle()
  assert.equal(focused.props.value, '')
  focused.props.onChange({ target: { value: '仅填写第二对象输出，不做自动换算' } }); render(); await settle()
  draft = JSON.parse(cache.values().next().value).spec; example = draft.examples.find(e => e.id === 'identity-example-20')
  assert.equal(example.outputs.find(b => b.slotId === 'final-speed').value, '已填写的第一输出')
  assert.equal(example.outputs.find(b => b.slotId === 'other-final-speed').value, '仅填写第二对象输出，不做自动换算')
  assert(text(tree).includes('另一对象的初始时刻') && text(tree).includes('km/h') && text(tree).includes('另一对象的后续时刻'), 'instance fields expose recorded unit/state and independent identity')
  assert.equal(new Set(all(tree, e => e.type === 'textarea' && e.props['aria-label']?.includes('的实例状态')).map(e => e.props['aria-label'])).size, 5)
  const canonical = harness.store.getDocument(props.documentId), s = canonical.nodes.find(n => n.id === 'multi').modelStructure
  assert.deepEqual(JSON.parse(JSON.stringify(draft.slots)), s.slots); assert.deepEqual(JSON.parse(JSON.stringify(draft.branches)), s.branches)
  assert.equal(JSON.stringify(canonical), before); assert.equal(harness.store.getDocumentRevision(props.documentId), 1)
  const attempts = await harness.post({ action: 'attempts', documentId: props.documentId, modelId: 'multi' }); assert.deepEqual(attempts.attempts, [])
  props.active = false; focused = null; render(); assert.equal(focused, null)
  console.log(JSON.stringify({ ok: true, actualSlotIdentityFocus: true, absentBindingRepair: true, beyondVisibleExamplePage: true,
    sameNameInputOutputIndependent: true, unitStateEvidenceRetained: true, onlySelectedDraftBindingChanged: true, canonicalAndLearningUnchanged: true }))
} finally { owner.states.forEach(state => state.cleanup?.()); harness.stop() }
