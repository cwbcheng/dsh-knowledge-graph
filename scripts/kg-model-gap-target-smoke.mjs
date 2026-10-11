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
  load: args => harness.post(args, 'connection-models'), onCommit: async () => { throw new Error('结构预览失败；草稿已保留。') } }
owner = { states: [], effects: [] }
function render() {
  for (let i = 0; i < 30; i++) {
    updates.splice(0).forEach(fn => fn()); cursor = 0; tree = ModelStructureEditor(props)
    if (tree?.props.ref) tree.props.ref.current = { querySelectorAll: () => all(tree, e => e.props['aria-label']).map(e => ({
      getAttribute: name => e.props[name], closest: () => null, focus: () => { focused = e },
    })) }
    owner.effects.splice(0).forEach(fn => fn()); if (!updates.length) return
  }
  throw new Error('gap target update loop')
}
const settle = async () => { for (let i = 0; i < 8; i++) { await new Promise(setImmediate); render() } }
const field = label => { const e = all(tree, e => e.props['aria-label'] === label)[0]; assert(e, label); return e }
const click = label => { const e = all(tree, e => e.type === 'button' && (e.props['aria-label'] === label || text(e) === label))[0]; assert(e, label); assert(!e.props.disabled); e.props.onClick(); render() }
const cacheKey = 'dsh-kg-model-structure:' + JSON.stringify([props.documentId, props.modelId])
const requestedId = 'identity-example-20', retainedId = 'identity-example-19'
const request = async (code, slotId) => {
  const report = await harness.post({ documentId: props.documentId, expectedRevision: 1, modelId: 'multi', diagnosis: true }, 'connection-models')
  assert.equal(report.error, undefined)
  const gap = report.diagnosis.items.find(item => item.code === code && item.target.id === requestedId)
  assert(gap); assert.equal(gap.missing[0].slotId, slotId)
  const targets = [], list = ModelGapList({ report: report.diagnosis, onEdit: target => targets.push(target), busy: false })
  const button = all(list, e => e.type === 'button' && e.props['aria-label'] === '整理缺口 ' + gap.id)[0]
  assert(button); button.props.onClick(); assert.equal(targets[0].missingSlotId, slotId)
  props.focusRequest = { ...targets[0], documentId: props.documentId, revision: 1, modelId: 'multi' }
  focused = null; render(); await settle()
}
try {
  const before = JSON.stringify(harness.store.getDocument(props.documentId))
  render(); await settle()
  // Use the real editor's explicit deletion to create a valid private draft.
  await request('example_inputs', 'other-speed')
  assert.equal(focused.props.value, '')
  click('删除实例 ' + requestedId); await settle()
  field('选择编辑实例').props.onChange({ target: { value: retainedId } }); render(); await settle()
  const deletedDraft = cache.get(cacheKey)
  assert.equal(JSON.parse(deletedDraft).spec.examples.some(e => e.id === requestedId), false)
  for (const [code, slotId] of [['example_inputs', 'other-speed'], ['example_outputs', 'other-final-speed']]) {
    await request(code, slotId)
    assert.equal(focused, null, 'a saved gap targeting a deleted draft example must not focus another example')
    assert.equal(field('选择编辑实例').props.value, retainedId, 'invalid navigation preserves the selected actual example')
    assert(text(tree).includes('该实例不在当前草稿中') && text(tree).includes('请选择要核对的实例'), 'missing target has an actionable, independently owned notice')
    assert.equal(field('速度的实例状态 other-speed').props.value, '第二输入')
    assert.equal(field('速度的实例状态 other-final-speed').props.value, '第二输出')
    assert.equal(cache.get(cacheKey), deletedDraft, 'navigation never restores the deleted example or mutates a cached draft')
  }
  // A valid local gap clears only the navigation notice, retaining write errors.
  click('预览结构修改'); await settle()
  assert(text(tree).includes('结构预览失败；草稿已保留。'))
  field('速度的实例状态 other-speed').props.onChange({ target: { value: '' } }); render(); await settle()
  let validGap
  for (let page = 0; page < 20; page++) {
    validGap = all(tree, e => e.type === 'button' && e.props['aria-label']?.startsWith('整理缺口 example_inputs:' + retainedId + ':'))[0]
    if (validGap) break
    click('下一页草稿待补充内容')
  }
  assert(validGap); focused = null; validGap.props.onClick(); render(); await settle()
  assert.equal(focused.props['aria-label'], '速度的实例状态 other-speed'); assert.equal(focused.props.value, '')
  assert.equal(field('选择编辑实例').props.value, retainedId)
  assert(!text(tree).includes('该实例不在当前草稿中'))
  assert(text(tree).includes('结构预览失败；草稿已保留。'), 'successful focus does not hide an unrelated preview error')
  focused.props.onChange({ target: { value: '明确编辑保留实例，尚未核验' } }); render(); await settle()
  const changed = JSON.parse(cache.get(cacheKey)).spec, expected = JSON.parse(deletedDraft).spec
  expected.examples.find(e => e.id === retainedId).inputs.find(b => b.slotId === 'other-speed').value = '明确编辑保留实例，尚未核验'
  assert.deepEqual(changed, expected, 'only the explicitly selected real draft binding changes, including all conditions and evidence')
  for (const mismatch of [{ documentId: 'other-document' }, { modelId: 'other-model' }, { revision: 2 }]) {
    props.focusRequest = { section: 'examples', id: requestedId, field: 'outputs', missingSlotId: 'other-final-speed',
      documentId: props.documentId, revision: props.revision, modelId: props.modelId, ...mismatch }
    focused = null; render(); await settle(); assert.equal(focused, null); assert.equal(field('选择编辑实例').props.value, retainedId)
  }
  props.active = false; focused = null; render(); await settle(); assert.equal(tree, null); assert.equal(focused, null)
  owner.states.forEach(state => state.cleanup?.()); updates.splice(0); owner = { states: [], effects: [] }
  props.active = true; props.focusRequest = null; render(); await settle()
  assert.equal(JSON.parse(cache.get(cacheKey)).spec.examples.some(e => e.id === requestedId), false, 'reopening preserves the explicit deletion')
  await request('example_outputs', 'other-final-speed'); assert.equal(focused, null); assert(text(tree).includes('该实例不在当前草稿中'))
  // A correctly scoped request still cannot focus a stale cached structure.
  owner.states.forEach(state => state.cleanup?.()); updates.splice(0); owner = { states: [], effects: [] }
  const oldDraft = JSON.stringify({ revision: 0, spec: JSON.parse(before).nodes.find(n => n.id === 'multi').modelStructure })
  cache.set(cacheKey, oldDraft); props.focusRequest = null; render(); await settle()
  await request('example_inputs', 'other-speed'); assert.equal(focused, null); assert(text(tree).includes('草稿基于第 0 版'))
  assert.equal(cache.get(cacheKey), oldDraft)
  assert.equal(JSON.stringify(harness.store.getDocument(props.documentId)), before); assert.equal(harness.store.getDocumentRevision(props.documentId), 1)
  assert.deepEqual((await harness.post({ action: 'attempts', documentId: props.documentId, modelId: 'multi' })).attempts, [])
  console.log(JSON.stringify({ ok: true, generatedEditorAndProductionRoutes: true, deletedDraftTargetBlocked: true,
    inputOutputTargetsBeyondFirstPage: true, actualSelectionAndDraftPreserved: true, explicitValidTargetRecovery: true,
    independentPreviewErrorRetained: true, reloadAndStaleDraftProtected: true, scopeAndInactiveGuards: true, canonicalConditionsEvidenceAndLearningUnchanged: true }))
} finally { owner.states.forEach(state => state.cleanup?.()); harness.stop() }
