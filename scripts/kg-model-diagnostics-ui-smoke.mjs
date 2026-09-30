import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { createModelReviewController } from './kg-model-review-controller-fixture.mjs'

const fixture = modelStructureFixture()
fixture.sourceUnits[0].text += ' 此处结果往往成立，但不保证必然成立。'
fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
const harness = await modelLearningHarness({ fixture })
let current, cursor = 0, uuid = 0, confirmReplacement = true, focused = '', scrolled = ''
const updates = [], cache = new Map()
const slot = init => { const index = cursor++; return current.slots[index] ||= init() }
const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } } },
  useState(initial) { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, next => updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })] },
  useRef(initial) { return slot(() => ({ current: initial })) },
  useEffect(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) { current.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps } },
}
const context = { window: { React, confirm: () => confirmReplacement }, console, AbortController,
  crypto: { randomUUID: () => 'diagnosis-' + (++uuid) },
  sessionStorage: { getItem: key => cache.get(key) || null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) },
  setTimeout: () => 1, clearTimeout() {} }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const { ModelStructureEditor, ModelGapPanel, ModelGapList, ModelSourceFieldPicker } = context.window.KGViewer
const text = element => Array.isArray(element) ? element.map(text).join('') : element && typeof element === 'object' ? text(element.props?.children) : String(element ?? '')
const all = (element, predicate) => Array.isArray(element) ? element.flatMap(child => all(child, predicate)) : !element || typeof element !== 'object' ? []
  : element.type === ModelGapList ? all(ModelGapList(element.props), predicate) : [...(predicate(element) ? [element] : []), ...all(element.props?.children, predicate)]
function mount(component, props) {
  const owner = { slots: [], effects: [] }; let tree
  const render = () => {
    for (let i = 0; i < 30; i++) {
      updates.splice(0).forEach(fn => fn()); current = owner; cursor = 0; tree = component(props)
      if (tree?.props.ref) tree.props.ref.current = { focus: () => { focused = tree.props['aria-label'] },
        scrollIntoView: () => { scrolled = tree.props['aria-label'] }, querySelectorAll: () => all(tree, element => element.props['aria-label']).map(element => ({
        getAttribute: name => element.props[name], closest: () => null, focus: () => { focused = element.props['aria-label'] },
      })) }
      owner.effects.splice(0).forEach(fn => fn()); if (!updates.length) return
    }
    throw new Error('diagnostics component update loop')
  }
  const settle = async () => { for (let i = 0; i < 8; i++) { await new Promise(setImmediate); render() } }
  const button = label => {
    const item = all(tree, element => element.type === 'button' && (element.props['aria-label'] === label || text(element) === label))[0]
    assert(item, 'missing button ' + label); return item
  }
  return { props, render, settle, button, get tree() { return tree },
    click(label) { const item = button(label); assert(!item.props.disabled, 'disabled button ' + label); item.props.onClick(); render() },
    change(label, value) { const field = all(tree, element => element.props['aria-label'] === label && ['input', 'select', 'textarea'].includes(element.type))[0]; assert(field); field.props.onChange({ target: { value } }); render() },
    unmount() { owner.slots.forEach(state => state.cleanup?.()); if (tree?.props.ref) tree.props.ref.current = null },
  }
}

const original = harness.store.getDocument(fixture.documentId)
const state = { resultView: { graph: original, sourceText: original.sourceText }, graphCommitQueueRef: { current: Promise.resolve() },
  currentResultRef: { current: null }, graphRevisionRef: { current: 1 }, verifyBusyRef: { current: false } }
state.currentResultRef.current = state.resultView
const writes = [], requests = [], pending = [], failures = []
let delayReads = false, malformed = false, oldHost = false
const load = (args, signal) => {
  requests.push({ args, signal })
  if (delayReads) return new Promise(resolve => pending.push({ args, signal, resolve }))
  return harness.post(args, 'connection-models').then(result => {
    if (oldHost) delete result.modelDiagnosticsVersion
    if (malformed && args.diagnosis) delete result.diagnosis.counts
    if (malformed && args.structureSources) delete result.sourceUnits.total
    return result
  })
}
const props = { documentId: fixture.documentId, revision: 1, modelId: 'taxi', active: true, busy: false, load,
  async onCommit(args) { writes.push(args); return createModelReviewController(state, { call: async (method, body) => {
    const result = await harness.post(body, method); if (result.error) failures.push({ method, result }); return result
  } })(args) },
}
state.onSaved = view => { state.resultView = view; props.revision = state.graphRevisionRef.current }
const editor = mount(ModelStructureEditor, props)
let picker, gaps
try {
  editor.render(); await editor.settle()
  const report = await harness.post({ documentId: fixture.documentId, expectedRevision: 1, modelId: 'taxi', diagnosis: true }, 'connection-models')
  const missing = report.diagnosis.items.find(item => item.code === 'example_inputs')
  const targets = [], gapList = ModelGapList({ report: report.diagnosis, onEdit: target => targets.push(target), busy: false })
  all(gapList, element => element.type === 'button' && element.props['aria-label'] === '整理缺口 ' + missing.id)[0].props.onClick()
  assert.equal(targets[0].id, 'missing-distance'); assert.equal(targets[0].missingSlotId, 'distance-slot')
  props.focusRequest = { ...targets[0], documentId: fixture.documentId, modelId: 'taxi', revision: 1 }
  editor.render(); await editor.settle()
  assert.equal(focused, '补齐输入槽位', 'an absent binding must navigate to its explicit repair action')
  assert(text(editor.tree).includes('尚缺距离的情境'))
  editor.click('补齐输入槽位'); await editor.settle()
  assert.equal(focused, '行驶距离的实例状态', 'adding a blank binding must focus the missing value of the correct case')
  assert.equal(JSON.parse(cache.values().next().value).spec.examples.find(example => example.id === 'missing-distance').inputs[0].value, '', 'repair must not invent a concrete input state')

  editor.click('条件分支 (3)'); editor.click('预览结构修改'); await editor.settle()
  assert(text(editor.tree).includes('确认保存结构'), 'Expected a production preview. Failures: ' + JSON.stringify(failures) + '. Actual editor: ' + text(editor.tree).slice(-2000))
  editor.click('从原文选取 unreviewed condition')
  let pickerNode = all(editor.tree, element => element.type === ModelSourceFieldPicker)[0]
  assert(pickerNode)
  picker = mount(ModelSourceFieldPicker, pickerNode.props); picker.render(); await picker.settle()
  assert.equal(focused, '原文选取到结构草稿')
  assert.equal(scrolled, '原文选取到结构草稿', 'source candidates must be brought into view even when opened from the bottom of a long editor')
  picker.click('选取 P1')
  picker.change('待选原文片段', '结果必然成立')
  assert(picker.button('填入字段草稿').props.disabled)
  picker.button('填入字段草稿').props.onClick(); picker.render(); editor.render()
  assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
  picker.change('待选原文片段', fixture.sourceUnits[0].text)
  picker.click('填入字段草稿'); editor.render(); await editor.settle()
  assert.equal(focused, '适用条件 unreviewed', 'closing a source selection must return focus to its actual destination')
  assert(!text(editor.tree).includes('确认保存结构'), 'source selection must invalidate the previous approval')
  assert.equal(writes.filter(write => write.preview).length, 0, 'source selection is a draft edit, not a commit')
  const cached = JSON.parse(cache.get('dsh-kg-model-structure:' + JSON.stringify([fixture.documentId, 'taxi'])))
  const copied = cached.spec.branches.find(branch => branch.id === 'unreviewed').condition
  assert.equal(copied.text, fixture.sourceUnits[0].text); assert(copied.text.includes('往往') && copied.text.includes('不保证必然'))
  assert.equal(copied.provenance.kind, 'source'); assert.equal(copied.provenance.paragraph, 0)
  assert.equal(copied.provenance.quote, copied.text)
  assert.throws(() => pickerNode.props.onApply({ documentId: fixture.documentId, modelId: 'taxi', revision: 1,
    target: pickerNode.props.target, unit: fixture.sourceUnits[0], quote: fixture.sourceUnits[0].text }), /版本或选取目标已变化/, 'closed source selections must not mutate the draft')
  picker.unmount()

  editor.click('从原文选取 base mapping'); pickerNode = all(editor.tree, element => element.type === ModelSourceFieldPicker)[0]
  const baseBefore = JSON.parse(cache.values().next().value).spec.branches[0].mapping
  confirmReplacement = false
  assert.equal(pickerNode.props.onApply({ documentId: fixture.documentId, modelId: 'taxi', revision: 1,
    target: pickerNode.props.target, unit: fixture.sourceUnits[0], quote: fixture.sourceUnits[0].text }), false)
  assert.deepEqual(JSON.parse(cache.values().next().value).spec.branches[0].mapping, baseBefore, 'declining replacement preserves the current field and provenance')
  confirmReplacement = true
  pickerNode.props.onClose(); editor.render()
  editor.click('预览结构修改'); await editor.settle()
  assert(text(editor.tree).includes('逐字引用') && text(editor.tree).includes('往往'))
  editor.click('确认保存结构'); await editor.settle()
  assert.equal(harness.store.getDocumentRevision(fixture.documentId), 2)
  const stored = harness.store.getDocument(fixture.documentId)
  assert.equal(stored.nodes.find(node => node.id === 'taxi').modelStructure.branches[2].condition.text, fixture.sourceUnits[0].text)
  assert.equal(JSON.stringify(stored.edges), JSON.stringify(original.edges))
  for (const node of original.nodes) {
    assert.deepEqual(stored.nodes.find(saved => saved.id === node.id).evidence, node.evidence,
      'a source-selected structure save must retain later stored-paragraph evidence for ' + node.id)
  }
  assert.equal(stored.sourceText, original.sourceText)
  assert.equal(cache.size, 0)

  const onEdit = [], gapProps = { documentId: fixture.documentId, revision: 2, modelId: 'taxi', active: true, load, onEdit: target => onEdit.push(target) }
  gaps = mount(ModelGapPanel, gapProps); gaps.render(); await gaps.settle()
  assert(text(gaps.tree).includes('不等于条件满足或关系成立'))
  malformed = true; gaps.click('重读缺口'); await gaps.settle()
  assert(text(gaps.tree).includes('缺口诊断版本或记录身份不一致'))
  assert(!all(gaps.tree, element => element.type === 'button' && element.props['aria-label']?.startsWith('整理缺口')).length)
  malformed = false; delayReads = true; gaps.click('重读缺口')
  const lateGap = pending.at(-1); gapProps.modelId = 'multi'; gaps.render()
  assert(lateGap.signal.aborted)
  for (const request of pending.splice(0)) request.resolve(await harness.post(request.args, 'connection-models'))
  await gaps.settle(); delayReads = false
  assert(!text(gaps.tree).includes('尚缺距离的情境'), 'late old-model diagnostics must not replace the selected model')

  editor.click('条件分支 (3)'); editor.click('从原文选取 extra condition')
  pickerNode = all(editor.tree, element => element.type === ModelSourceFieldPicker)[0]
  const oldApply = pickerNode.props.onApply
  props.revision = 3; editor.render(); await editor.settle()
  assert.throws(() => oldApply({ documentId: fixture.documentId, modelId: 'taxi', revision: 2,
    target: pickerNode.props.target, unit: fixture.sourceUnits[0], quote: fixture.sourceUnits[0].text }), /版本或选取目标已变化/)
  assert.equal(harness.store.getDocumentRevision(fixture.documentId), 2)
  props.revision = 2; editor.render(); await editor.settle()
  oldHost = true; props.active = false; editor.render(); props.active = true; editor.render(); await editor.settle()
  editor.click('条件分支 (3)')
  assert(editor.button('从原文选取 extra condition').props.disabled)
  editor.button('从原文选取 extra condition').props.onClick(); editor.render()
  assert(!all(editor.tree, element => element.type === ModelSourceFieldPicker).length, 'old hosts must fail closed even if a disabled callback is invoked')
  assert.equal(harness.store.getDocumentRevision(fixture.documentId), 2)
  const attempts = await harness.post({ action: 'attempts', documentId: fixture.documentId, modelId: 'taxi' })
  assert.equal(attempts.attempts.length, 0)
} finally { picker?.unmount(); gaps?.unmount(); editor.unmount(); harness.stop() }
console.log(JSON.stringify({ ok: true, preciseGapNavigation: true, exactSourceDraftSelection: true, invalidQuoteBlocked: true,
  replacementRequiresConsent: true, previewInvalidated: true, canonicalSaveAndRefresh: true, sourceAndEdgesUnchanged: true,
  lateRepliesAndCallbacksRejected: true, malformedAndOldHostBlocked: true }))
