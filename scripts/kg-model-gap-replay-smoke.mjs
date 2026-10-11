import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelBindingFocusFixture } from './kg-model-binding-focus-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: modelBindingFocusFixture() })
let owner = { states: [], effects: [] }, cursor = 0, tree, focused, hold = false
const updates = [], cache = new Map(), held = []
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
  load: async (args, signal) => {
    const result = await harness.post(args, 'connection-models')
    return hold && args.structureEdit ? new Promise(resolve => held.push({ signal, release: () => resolve(result) })) : result
  }, onCommit: () => { throw new Error('Gap navigation must not write') } }
function render() {
  for (let i = 0; i < 30; i++) {
    updates.splice(0).forEach(fn => fn()); cursor = 0; tree = ModelStructureEditor(props)
    if (tree?.props.ref) tree.props.ref.current = { querySelectorAll: () => all(tree, e => e.props['aria-label']).map(e => ({
      getAttribute: name => e.props[name], closest: () => null, focus: () => { focused = e },
    })) }
    owner.effects.splice(0).forEach(fn => fn()); if (!updates.length) return
  }
  throw new Error('gap replay update loop')
}
const settle = async () => { for (let i = 0; i < 8; i++) { await new Promise(setImmediate); render() } }
const field = label => { const e = all(tree, e => e.props['aria-label'] === label)[0]; assert(e, label); return e }
const click = label => { const e = all(tree, e => e.type === 'button' && (e.props['aria-label'] === label || text(e) === label))[0]; assert(e, label); assert(!e.props.disabled); e.props.onClick(); render() }
const select = id => { field('选择编辑实例').props.onChange({ target: { value: id } }); render() }
const returnToStructure = async () => {
  props.active = false; focused = null; render(); await settle(); assert.equal(tree, null)
  props.active = true; render(); await settle()
}
const request = async (code, slotId) => {
  const result = await harness.post({ documentId: props.documentId, expectedRevision: 1, modelId: 'multi', diagnosis: true }, 'connection-models')
  assert.equal(result.error, undefined)
  const gap = result.diagnosis.items.find(item => item.code === code && item.target.id === 'identity-example-20')
  assert(gap); assert.equal(gap.missing[0].slotId, slotId)
  const targets = [], list = ModelGapList({ report: result.diagnosis, onEdit: target => targets.push(target), busy: false })
  const button = all(list, e => e.type === 'button' && e.props['aria-label'] === '整理缺口 ' + gap.id)[0]
  assert(button); button.props.onClick(); assert.equal(targets[0].missingSlotId, slotId)
  props.focusRequest = { ...targets[0], documentId: props.documentId, revision: props.revision, modelId: props.modelId }
  focused = null; render(); await settle()
}
try {
  const before = JSON.stringify(harness.store.getDocument(props.documentId))
  render(); await settle(); await request('example_inputs', 'other-speed')
  assert.equal(focused.props.value, '')
  select('identity-example-19'); await settle()
  field('速度的实例状态 other-speed').props.onChange({ target: { value: '后来明确整理的个人草稿，尚未核验' } }); render(); await settle()
  const retainedDraft = cache.values().next().value
  await returnToStructure()
  assert.equal(field('选择编辑实例').props.value, 'identity-example-19', 'returning must preserve the later manual selection')
  assert.equal(focused, null, 'a completed gap must not take focus again after a read')
  assert.equal(cache.values().next().value, retainedDraft, 'reading does not change the later draft edit')
  click('条件分支 (1)'); await settle(); await returnToStructure()
  assert.equal(all(tree, e => e.type === 'button' && text(e) === '条件分支 (1)')[0].props['aria-pressed'], true)
  assert.equal(focused, null, 'returning must preserve the later manually chosen section')
  // The same target from a fresh public click is a new intent, not a replay.
  await request('example_inputs', 'other-speed')
  assert.equal(field('选择编辑实例').props.value, 'identity-example-20')
  assert.equal(focused.props['aria-label'], '速度的实例状态 other-speed'); assert.equal(focused.props.value, '')
  await request('example_outputs', 'other-final-speed')
  assert.equal(focused.props['aria-label'], '补齐输出槽位')
  click('补齐输出槽位'); await settle()
  assert.equal(focused.props['aria-label'], '速度的实例状态 other-final-speed'); assert.equal(focused.props.value, '')
  focused.props.onChange({ target: { value: '明确补齐的个人输出，仍未核验' } }); render(); await settle()
  const expected = JSON.parse(retainedDraft).spec, changed = JSON.parse(cache.values().next().value).spec
  expected.examples.find(e => e.id === 'identity-example-20').outputs.push({ slotId: 'other-final-speed', value: '明确补齐的个人输出，仍未核验' })
  assert.deepEqual(changed, expected, 'only explicit actual bindings change; all conditions, evidence, unit/state and other examples stay')
  select('identity-example-19'); await settle(); await returnToStructure()
  assert.equal(field('选择编辑实例').props.value, 'identity-example-19'); assert.equal(focused, null)
  assert.equal(field('速度的实例状态 other-speed').props.value, '后来明确整理的个人草稿，尚未核验')
  // Hold a real structure read: no target is consumed early, and the newest
  // public gap click wins once that exact response is available.
  owner.states.forEach(state => state.cleanup?.()); updates.splice(0); cache.clear()
  owner = { states: [], effects: [] }; props.focusRequest = null; hold = true; focused = null
  render(); await settle(); assert.equal(held.length, 1)
  await request('example_inputs', 'other-speed'); assert.equal(focused, null)
  await request('example_outputs', 'other-final-speed'); assert.equal(focused, null)
  assert.equal(held[0].signal.aborted, false); hold = false; held.shift().release(); await settle()
  assert.equal(field('选择编辑实例').props.value, 'identity-example-20')
  assert.equal(focused.props['aria-label'], '补齐输出槽位', 'the latest requested output waits for loading; the older input does not win')
  select('identity-example-19'); await settle(); await returnToStructure()
  assert.equal(field('选择编辑实例').props.value, 'identity-example-19'); assert.equal(focused, null)
  assert.equal(cache.size, 0)
  assert.equal(JSON.stringify(harness.store.getDocument(props.documentId)), before); assert.equal(harness.store.getDocumentRevision(props.documentId), 1)
  assert.deepEqual((await harness.post({ action: 'attempts', documentId: props.documentId, modelId: 'multi' })).attempts, [])
  console.log(JSON.stringify({ ok: true, generatedEditorAndProductionRoutes: true, completedGapNotReplayed: true,
    laterSelectionSectionAndDraftPreserved: true, explicitSameGapWorks: true, independentBindingRepairStillFocused: true,
    latestPublicGapWaitsForRealRead: true, canonicalConditionsEvidenceUnitStateAndLearningUnchanged: true, revision: 1, learningCount: 0 }))
} finally { owner.states.forEach(state => state.cleanup?.()); held.forEach(item => item.release()); harness.stop() }
