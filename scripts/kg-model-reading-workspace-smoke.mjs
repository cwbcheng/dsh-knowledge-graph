import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createGraphContract } from '../src/index.host.js'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

const fixture = modelStructureFixture(), query = createGraphContract().connectionModels
const branches = fixture.graph.nodes.find(node => node.id === 'taxi').modelStructure.branches
branches[0].label = branches[1].label = '同名分支'
branches[0].boundary.provenance = { kind: 'source', paragraph: 1, quote: fixture.sourceUnits[1].text, note: '边界仍需逐项核对' }
const before = JSON.stringify(fixture)
let current, cursor = 0
const slot = init => { const index = cursor++; return current.slots[index] ||= init() }
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useRef: value => slot(() => ({ current: value })),
  useState(value) {
    const owner = current, state = slot(() => ({ value: typeof value === 'function' ? value() : value }))
    return [state.value, next => owner.updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })]
  },
  useEffect(fn, deps) {
    const owner = current, state = slot(() => ({}))
    if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
      owner.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    }
  },
}
const context = { window: { React, confirm: () => true }, AbortController, console, setTimeout, clearTimeout }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const components = context.window.KGViewer
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : String(node ?? '')
const all = (node, test, visible = true) => Array.isArray(node) ? node.flatMap(child => all(child, test, visible))
  : !node || typeof node !== 'object' || visible && node.props.hidden ? []
    : [...(test(node) ? [node] : []), ...all(node.props.children, test, visible)]
let writes = 0
const mount = (options = {}) => {
  const owner = { slots: [], updates: [], effects: [], requests: [], snapshots: [], focus: [] }
  owner.props = { documentId: fixture.documentId, revision: 1, ...options,
    load: (args, signal) => new Promise(resolve => owner.requests.push({ args, signal, resolve })),
    onStateChange: state => owner.snapshots.push(state),
    onRoles: async args => { writes++; assert.equal(args.preview, null); return { signature: 'test-preview', diff: [] } },
  }
  owner.render = (effects = true) => {
    for (let index = 0; index < 20; index++) {
      owner.updates.splice(0).forEach(fn => fn()); current = owner; cursor = 0
      owner.tree = components.ConnectionModelPanel(owner.props)
      for (const item of all(owner.tree, node => node.props.ref && (node.type === 'aside' || node.type === 'button'))) {
        item.props.ref.current = { focus: () => owner.focus.push(item.type), scrollIntoView: () => owner.focus.push('scroll') }
      }
      if (!effects) return
      owner.effects.splice(0).forEach(fn => fn())
      if (!owner.updates.length) return
    }
    throw new Error('Render loop')
  }
  owner.control = label => {
    const control = all(owner.tree, node => node.type === 'button' && text(node) === label)[0]
    assert(control, 'Missing visible control: ' + label); return control
  }
  owner.click = label => { const control = owner.control(label); assert(!control.props.disabled); control.props.onClick(); owner.render() }
  owner.settle = async () => { for (let index = 0; index < 8; index++) { await Promise.resolve(); owner.render() } }
  owner.resolve = async request => { assert(request); request.resolve(query(fixture, request.args)); await owner.settle() }
  owner.select = id => {
    const row = all(owner.tree, node => node.props['data-model-catalogue-row'] === id)[0]
    assert(row); all(row, node => node.type === 'button')[0].props.onClick()
  }
  owner.source = () => all(owner.tree, node => node.type === 'aside')[0]
  owner.child = name => all(owner.tree, node => node.type === components[name])[0]
  owner.unmount = () => owner.slots.forEach(state => state.cleanup?.())
  owner.render(); return owner
}
const owner = mount()
await owner.resolve(owner.requests[0]); await owner.resolve(owner.requests.find(item => item.args.modelId === 'taxi'))
assert(owner.control('阅读').props['aria-pressed'])
assert(owner.control('下上对照').props['aria-pressed'])
assert.equal(all(owner.tree, node => node.type === 'button' && text(node) === '核对结构').length, 0)
const reads = owner.requests.length
owner.click('学习'); assert(owner.control('我的理解').props['aria-pressed'])
owner.click('情境预测'); assert(owner.child('ModelLearningPanel').props.active)
owner.click('原文依据')
assert(owner.child('ModelLearningPanel').props.active, 'Opening evidence keeps the exercise active')
assert.equal(owner.snapshots.at(-1).tab, 'learn')
assert(owner.source()); assert(owner.control('原文依据').props['aria-expanded'])
assert.deepEqual(owner.focus.slice(-2), ['aside', 'scroll'])
owner.click('收起原文'); assert.equal(owner.focus.at(-1), 'button')
assert(!owner.source()); assert(owner.child('ModelLearningPanel').props.active)
owner.click('核对'); owner.click('核对结构')
const editor = owner.child('ModelStructureEditor')
owner.click('原文依据')
assert(owner.child('ModelStructureEditor').props.active)
assert.equal(owner.child('ModelStructureEditor').type, editor.type)
assert.equal(owner.child('ModelStructureEditor').props.modelId, editor.props.modelId)
owner.click('核对方向')
const role = all(owner.tree, node => node.type === 'select' && node.props['aria-label'] === '端点角色 distance')[0]
// Structured slots are edited through the structure editor; use a legacy model below for direction preview.
assert.equal(role, undefined)
assert.equal(owner.requests.length, reads, 'Changing tasks and showing existing evidence need no canonical reread')
owner.click('阅读')
const boundaries = all(owner.tree, node => node.props.className === 'kg-model-boundary')
assert.equal(boundaries.length, 3)
assert(boundaries.every(node => all(node, child => child.props.label === '边界来源').length === 1), 'Every boundary keeps its own provenance next to its text')
assert(text(boundaries[2]).includes('尚未核对'))

// A field's stored citation can be inspected beside the current task without
// navigating away or substituting the model's broader citation for that field.
let fieldNavigations = 0, fieldFinish, fieldAdmitted
owner.props.onLocate = async (reference, stillCurrent) => {
  fieldNavigations++
  assert.equal(reference.documentId, fixture.documentId); assert.equal(reference.revision, 1)
  assert.equal(reference.nodeId, 'taxi'); assert.equal(reference.sourceQuoteOnly, true)
  if (fieldFinish === 'delay') {
    await new Promise(resolve => { fieldFinish = resolve }); fieldAdmitted = stillCurrent(); return fieldAdmitted
  }
  throw new Error('原文包含多个相同片段，无法唯一定位')
}
owner.render()
const inspect = (branchId, field, panel = owner) => {
  const label = '旁侧核对' + ({ condition: '条件', mapping: '映射', boundary: '边界' }[field]) + '来源：同名分支（' + branchId + '）'
  const evidence = all(panel.tree, node => node.props.inspectLabel === label)[0]
  assert(evidence, 'The selected field needs an in-place evidence action')
  const tree = evidence.type(evidence.props)
  const button = all(tree, node => node.type === 'button' && text(node) === '旁侧核对')[0]
  assert(button && !button.props.disabled)
  button.props.onClick(); panel.render(); return button
}
const fieldCard = () => all(owner.source(), node => node.props['aria-label'] === '所选字段引用')[0]
const fieldJump = () => all(fieldCard(), node => node.type === 'button')[0]
const fieldEvidence = all(owner.tree, node => node.props.inspectLabel)[0]
for (const value of [
  { kind: 'source', paragraph: -1, quote: '无段落身份' },
  { kind: 'source', paragraph: 0, quote: '' },
  { kind: 'source', paragraph: 0, quote: '长'.repeat(2001) },
  { kind: 'user', paragraph: 0, quote: '个人理解' },
  { kind: 'ai', paragraph: 0, quote: 'AI 建议' },
]) {
  const tree = fieldEvidence.type({ ...fieldEvidence.props, value, onInspect: () => assert.fail('Invalid field inspection') })
  const button = all(tree, node => node.type === 'button' && text(node) === '旁侧核对')[0]
  assert(!button || button.props.disabled, 'Non-source and invalid evidence must not offer a usable source action')
  button?.props.onClick()
}
for (const [branchId, field] of [['base', 'condition'], ['extra', 'mapping'], ['base', 'boundary']]) {
  const expected = branches.find(item => item.id === branchId)[field]
  inspect(branchId, field)
  assert(fieldCard()); assert(text(fieldCard()).includes(branchId))
  assert(text(fieldCard()).includes(expected.text)); assert(text(fieldCard()).includes(expected.provenance.note))
  assert.equal(text(all(fieldCard(), node => node.type === 'blockquote')[0]), expected.provenance.quote)
  assert(text(fieldCard()).includes('语义待核对'))
  assert.equal(owner.snapshots.at(-1).tab, 'materials')
  assert.equal(fieldNavigations, 0, 'Inspecting a citation must not leave the current task')
}
assert.equal(owner.requests.length, reads, 'Field inspection uses the already loaded canonical detail')
await fieldJump().props.onClick(); await owner.settle()
assert(text(owner.tree).includes('无法唯一定位'), 'The existing exact locator still owns ambiguity handling')
assert(fieldCard(), 'Failed full-source navigation keeps the chosen field available')
fieldFinish = 'delay'; const pendingField = fieldJump().props.onClick()
inspect('extra', 'condition'); fieldFinish(); await pendingField; await owner.settle()
assert.equal(fieldAdmitted, false, 'A different field cancels the earlier field navigation')
assert(!text(owner.tree).includes('无法唯一定位'))
owner.click('学习'); owner.click('情境预测')
inspect('base', 'condition'); assert(owner.child('ModelLearningPanel').props.active)
owner.click('核对'); owner.click('核对结构')
inspect('base', 'boundary'); assert(owner.child('ModelStructureEditor').props.active)
owner.click('收起原文'); owner.click('原文依据')
assert(fieldCard(), 'Closing and reopening the same current detail retains the chosen field')
owner.click('阅读')
const staleInspect = inspect('extra', 'mapping')
owner.select('unknown'); owner.render(false)
assert(!fieldCard(), 'Hide the old field before the new detail effect')
staleInspect.props.onClick(); owner.render()
assert(!fieldCard(), 'A stale field handler cannot reopen old evidence')
await owner.resolve(owner.requests.at(-1))
owner.select('taxi'); owner.render(); await owner.resolve(owner.requests.at(-1))
assert(!fieldCard(), 'Returning to a model requires a fresh field selection')
inspect('base', 'boundary')
const selectedSnapshot = owner.snapshots.at(-1)
assert(!JSON.stringify(selectedSnapshot).includes('边界仍需逐项核对'), 'Browse preferences never cache field citation payloads')
owner.props.active = false; owner.render(false); assert(!fieldCard())
owner.props.active = true; owner.render(); assert(!fieldCard(), 'Reactivation does not revive a previous field selection')
inspect('base', 'condition')
owner.click('对照原文'); assert(!fieldCard(), 'Selecting related material retires the previous field citation')
inspect('base', 'boundary')

owner.select('unknown'); owner.render(false)
assert(!text(owner.source()).includes('taxi ·'), 'Old evidence is hidden during render, before effects run')
assert(!owner.child('ModelStructureEditor'), 'Old detail controls are unavailable until the selected model is read')
owner.render(); const stale = owner.requests.at(-1)
owner.select('wrong'); owner.render(); const fresh = owner.requests.at(-1)
assert(stale.signal.aborted)
await owner.resolve(fresh); await owner.resolve(stale)
assert(text(owner.source()).includes('wrong · 版本 1'))
assert(text(owner.source()).includes('图片中的学偏联结模型是错误模型'))
assert(!text(owner.source()).includes('unknown ·'))
assert(owner.control('原文依据').props['aria-expanded'], 'Open evidence follows model selection')
owner.click('核对'); owner.click('核对方向')
all(owner.tree, node => node.type === 'select' && node.props['aria-label'] === '端点角色 distance')[0].props.onChange({ target: { value: 'output' } })
owner.render(); owner.click('预览方向修改'); await owner.settle()
assert(owner.control('确认保存方向'))
owner.click('收起原文'); owner.click('原文依据')
assert(owner.control('确认保存方向'), 'Reading evidence does not invalidate or submit the explicit direction preview')
assert.equal(writes, 1)
owner.click('取消预览')

// A closed source pane cancels its pending navigation, including close -> reopen.
let finish, admitted
owner.props.onLocate = async (reference, stillCurrent) => {
  assert.equal(reference.nodeId, 'wrong'); assert.equal(reference.sourceQuoteOnly, true)
  await new Promise(resolve => { finish = resolve }); admitted = stillCurrent(); return admitted
}
owner.render()
all(owner.source(), node => node.type === 'button' && text(node) === '原文 P5')[0].props.onClick()
owner.click('收起原文'); owner.click('原文依据'); finish(); await owner.settle()
assert.equal(admitted, false)

owner.select('unknown'); owner.render(); await owner.resolve(owner.requests.at(-1))
const unknown = all(owner.tree, node => node.props.className === 'kg-model-unknown')[0]
assert(unknown); assert.equal(all(unknown, node => node.props.className === 'kg-model-port').length, 2)
const flow = all(owner.tree, node => node.props.className === 'kg-model-flow')[0]
assert.equal(all(flow, node => node.props.className === 'kg-model-port').length, 0, 'Unknown endpoints are never placed in an input/output lane')
const saved = owner.snapshots.at(-1)
owner.props.revision = 2; owner.render(false)
assert(!text(owner.source()).includes('unknown ·'), 'Revision change hides source before effects')
owner.render(); owner.requests.at(-1).resolve({ error: { message: '版本已变化' } }); await owner.settle()
assert(!all(owner.source(), node => node.props.className === 'kg-model-evidence').length)
assert(text(owner.source()).includes('依据未能读取'))
owner.unmount()
const restored = mount({ restoreState: saved })
assert(restored.source()); assert(!all(restored.source(), node => node.props.className === 'kg-model-evidence').length)
await restored.resolve(restored.requests.find(item => item.args.modelId === 'unknown'))
assert(text(restored.source()).includes('unknown · 版本 1'))
restored.unmount()
for (const next of [{ revision: 2 }, { documentId: 'different-document' }]) {
  const scoped = mount({ restoreState: selectedSnapshot })
  await scoped.resolve(scoped.requests.find(item => item.args.modelId === 'taxi'))
  const oldAction = inspect('base', 'boundary', scoped)
  assert(text(scoped.source()).includes('边界仍需逐项核对'))
  Object.assign(scoped.props, next); scoped.render(false)
  assert(!text(scoped.source()).includes('边界仍需逐项核对'), 'Retire field content before document/revision effects')
  oldAction.props.onClick(); scoped.render()
  assert(!text(scoped.source()).includes('边界仍需逐项核对'), 'Old document/revision handlers remain inert')
  scoped.unmount()
}
assert.equal(JSON.stringify(fixture), before)
assert.equal(writes, 1, 'Only the explicit preview callback ran; no browsing writes')
console.log(JSON.stringify({ groupedVisibleActions: true, learningAndEditorStayActive: true, directionPreviewRetained: true,
  fieldEvidenceInPlace: true, exactFieldIdentityAndQuote: true, fieldChangeCancelsNavigation: true, noCachedFieldPayload: true,
  fieldProvenanceAdjacent: true, sourceFollowsSelection: true, staleEvidenceHiddenBeforeEffects: true,
  sourceCloseCancelsNavigation: true, unknownRolesSeparate: true, sourcePreferenceRestoredWithoutPayload: true,
  keyboardFocus: true, canonicalDataUnchanged: true, browserGeometryNotTested: true }))
