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
    learningCall: (args, signal) => new Promise(resolve => owner.requests.push({ args, signal, resolve })),
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
// The workbench mounts this panel before it is visible. An unopened workspace
// must not read every model catalogue or let a late reply choose a model.
const unopened = mount({ active: false })
assert.equal(unopened.requests.length, 0, 'An unopened model workspace must not start catalogue/detail reads')
unopened.props.revision = 2; unopened.render()
assert.equal(unopened.requests.length, 0, 'Hidden revision changes must not start reads')
unopened.props.active = true; unopened.render()
assert.equal(unopened.requests.length, 1)
assert.equal(unopened.requests[0].args.expectedRevision, 2)
unopened.unmount()

const beforeCleanup = mount({ restoreState: { documentId: fixture.documentId, revision: 1, modelId: 'taxi' } })
beforeCleanup.props.active = false; beforeCleanup.render(false)
for (const request of beforeCleanup.requests) request.resolve(query(fixture, request.args))
await Promise.resolve(); beforeCleanup.render(false)
assert(!beforeCleanup.child('ModelStructureEditor'), 'A reply after the hidden render is retired even before effect cleanup')
assert.equal(all(beforeCleanup.tree, node => node.props['data-model-catalogue-row']).length, 0)
beforeCleanup.render(); beforeCleanup.unmount()

// Cover partial completion as well as both pending/completed. Reuse only a
// successful response for the identical read scope, keeping child drafts mounted.
for (const completed of [[], ['catalogue'], ['detail'], ['catalogue', 'detail']]) {
  const panel = mount({ restoreState: { documentId: fixture.documentId, revision: 1, modelId: 'taxi', tab: 'structure' } })
  const initialRequests = panel.requests.slice()
  assert.equal(initialRequests.length, 2)
  for (const request of initialRequests) {
    if (completed.includes(request.args.modelId ? 'detail' : 'catalogue')) await panel.resolve(request)
  }
  const childBefore = panel.child('ModelStructureEditor')
  panel.props.active = false; panel.render()
  assert(initialRequests.every(request => request.signal.aborted), 'Hiding aborts both parent readers')
  assert.equal(panel.requests.length, 2, 'Hiding cannot start another read')
  for (const request of initialRequests) request.resolve({ error: { message: 'obsolete hidden parent reply' } })
  await panel.settle()
  assert(!text(panel.tree).includes('obsolete hidden parent reply'))
  if (childBefore) assert.equal(panel.child('ModelStructureEditor').type, childBefore.type, 'Keep completed detail mounted while hidden')
  panel.props.active = true; panel.render()
  const resumed = panel.requests.slice(2)
  assert.equal(resumed.length, 2 - completed.length, 'Resume exactly the incomplete parent reads')
  if (childBefore) assert.equal(panel.child('ModelStructureEditor').type, childBefore.type, 'Returning cannot unmount an existing draft')
  for (const request of resumed) await panel.resolve(request)
  assert(panel.child('ModelStructureEditor')); assert.equal(panel.snapshots.at(-1).tab, 'structure')
  const refresh = all(panel.tree, node => node.props['aria-label'] === '重新读取模型')[0]
  refresh.props.onClick(); panel.render()
  assert.equal(panel.requests.length, 6 - completed.length, 'Explicit refresh must bypass completed responses')
  panel.unmount()
}

const retry = mount({ restoreState: { documentId: fixture.documentId, revision: 1, modelId: 'taxi' } })
const detailPane = panel => all(panel.tree, node => node.props.className === 'kg-model-detail')[0]
assert(text(detailPane(retry)).includes('taxi · 请求版本 1'), 'Pending detail retains the requested model identity without claiming it was loaded')
retry.requests.forEach(request => request.resolve({ error: { message: 'current parent read failed' } }))
await retry.settle(); assert(text(retry.tree).includes('current parent read failed'))
assert(!text(detailPane(retry)).includes('选择一个联结模型'), 'A failed read does not mean the user has no selected model')
assert(text(detailPane(retry)).includes('taxi · 请求版本 1'))
retry.props.active = false; retry.render(); retry.props.active = true; retry.render()
assert.equal(retry.requests.length, 4, 'Failed reads retry on return')
for (const request of retry.requests.slice(2)) await retry.resolve(request)
assert(!text(retry.tree).includes('current parent read failed'))
retry.props.active = false; retry.render(); retry.props.revision = 2; retry.render(false)
assert(!retry.child('ModelStructureEditor'), 'A new version cannot reuse mounted old-version detail')
retry.render(); assert.equal(retry.requests.length, 4)
retry.props.active = true; retry.render()
assert.equal(retry.requests.length, 6)
assert(retry.requests.slice(4).every(request => request.args.expectedRevision === 2))
retry.unmount()

for (const next of [{ revision: 2 }, { documentId: 'different-document' }]) {
  const failed = mount({ restoreState: { documentId: fixture.documentId, revision: 1, modelId: 'taxi', sourceOpen: true } })
  failed.requests.find(request => request.args.modelId).resolve({ error: { message: 'retired detail failure' } })
  await failed.settle(); assert(text(detailPane(failed)).includes('retired detail failure'))
  Object.assign(failed.props, next); failed.render(false)
  assert(!text(detailPane(failed)).includes('retired detail failure'), 'Retire a previous context error before effects run')
  assert(!all(failed.tree, node => node.type === 'button' && text(node) === '重试读取模型详情').length)
  assert(!text(failed.source()).includes('依据未能读取'), 'A previous failure cannot label the new source context')
  failed.unmount()
}

const debounced = mount({ restoreState: { documentId: fixture.documentId, revision: 1, modelId: 'taxi' } })
for (const request of debounced.requests.slice()) await debounced.resolve(request)
all(debounced.tree, node => node.props['aria-label'] === '搜索联结模型')[0].props.onChange({ target: { value: 'new search' } })
debounced.render(); debounced.props.active = false; debounced.render()
await new Promise(resolve => setTimeout(resolve, 240)); await debounced.settle()
assert.equal(debounced.requests.length, 2, 'A pending debounce must not fetch a hidden catalogue')
assert.equal(all(debounced.tree, node => node.props['data-model-catalogue-row']).length, 0, 'Old filter results cannot stand in for the new scope')
debounced.props.active = true; debounced.render()
assert.equal(debounced.requests.length, 3)
assert.equal(debounced.requests.at(-1).args.query, 'new search')
assert(debounced.child('ModelStructureEditor'), 'Changing the catalogue filter cannot discard the current detail')
debounced.unmount()

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
assert(text(owner.source()).includes('重试读取模型详情'), 'The source pane points to the draft-preserving detail retry')
assert(!text(detailPane(owner)).includes('选择一个联结模型'))
assert(text(detailPane(owner)).includes('unknown · 请求版本 2'))
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

// A hide/show retires only readers. A user-requested write still publishes its
// preview/result for the same read scope, with the existing explicit confirmation.
const writing = mount({ restoreState: { documentId: fixture.documentId, revision: 1, modelId: 'wrong', tab: 'review' } })
for (const request of writing.requests.slice()) await writing.resolve(request)
const explicitWrites = []
writing.props.onRoles = args => new Promise(resolve => explicitWrites.push({ args, resolve }))
writing.render()
all(writing.tree, node => node.props['aria-label'] === '端点角色 distance')[0].props.onChange({ target: { value: 'output' } })
writing.render(); writing.click('预览方向修改')
writing.props.active = false; writing.render()
const previewResult = { signature: 'retained-preview', diff: [], revision: 1 }
assert.equal(explicitWrites[0].args.preview, null)
explicitWrites[0].resolve(previewResult); await writing.settle()
writing.props.active = true; writing.render()
assert.equal(explicitWrites.length, 1, 'Visibility cannot auto-confirm a direction preview')
writing.click('确认保存方向')
assert.equal(explicitWrites[1].args.preview, previewResult)
writing.props.active = false; writing.render()
explicitWrites[1].resolve({ revision: 2 }); await writing.settle()
assert.equal(writing.requests.length, 2, 'A confirmed hidden write defers its refresh read')
writing.props.active = true; writing.render()
assert.equal(writing.requests.length, 4, 'Returning after a confirmed write cannot reuse its pre-write responses')
writing.unmount()

// Direction choices and their old evidence survive an external revision; a
// late preview (success or failure) cannot approve them for the new version.
for (const outcome of ['success', 'failure']) {
  const stale = mount({ restoreState: { documentId: fixture.documentId, revision: 1, modelId: 'wrong', tab: 'review' } })
  for (const request of stale.requests.slice()) await stale.resolve(request)
  const pendingWrites = []
  stale.props.onRoles = args => new Promise((resolve, reject) => pendingWrites.push({ args, resolve, reject }))
  stale.render()
  const oldSelect = all(stale.tree, node => node.props['aria-label'] === '端点角色 distance')[0]
  oldSelect.props.onChange({ target: { value: 'output' } }); stale.render()
  const oldPreview = stale.control('预览方向修改')
  stale.click('预览方向修改')
  stale.props.revision = 2; stale.render(false)
  oldPreview.props.onClick(); oldSelect.props.onChange({ target: { value: 'input' } })
  assert.equal(pendingWrites.length, 1, 'Old-version callbacks are fenced during render, before effect cleanup')
  stale.render()
  const newer = structuredClone(fixture)
  newer.revision = 2
  newer.graph.edges = newer.graph.edges.filter(edge => !(edge.fromNodeId === 'wrong' && edge.toNodeId === 'distance'))
  for (const request of stale.requests.filter(request => request.args.expectedRevision === 2)) {
    request.resolve(query(newer, request.args)); await stale.settle()
  }
  assert(!all(stale.tree, node => node.props['aria-label'] === '端点角色 distance').length, 'The old endpoint was actually removed')
  if (outcome === 'success') pendingWrites[0].resolve({ signature: 'old-version-approval', diff: [] })
  else pendingWrites[0].reject(new Error('late old direction failure'))
  await stale.settle()
  const retained = all(stale.tree, node => node.props['aria-label'] === '旧版方向修改')[0]
  assert(retained && text(retained).includes('distance') && text(retained).includes('输出'), 'A deleted endpoint remains identifiable in the old draft')
  assert(!text(stale.tree).includes('late old direction failure'))
  assert(!all(stale.tree, node => node.type === 'button' && text(node) === '确认保存方向').length)
  assert(stale.control('预览方向修改').props.disabled)
  assert(!stale.control('放弃旧版方向修改').props.disabled, 'Settling an obsolete request releases the discard action')
  stale.click('放弃旧版方向修改')
  assert(!all(stale.tree, node => node.props['aria-label'] === '旧版方向修改').length)
  assert.equal(pendingWrites.length, 1, 'Discarding never writes or automatically re-previews')
  stale.unmount()
}

// Exercise the child hooks with props from the actual mounted parent. Testing
// the children alone misses a parent that never tells them it became hidden.
const followChild = (parent, name) => {
  const child = { slots: [], updates: [], effects: [] }
  child.render = () => {
    for (let index = 0; index < 30; index++) {
      child.updates.splice(0).forEach(fn => fn()); current = child; cursor = 0
      const element = parent.child(name)
      assert(element, 'Keep the child mounted to preserve its private state')
      child.tree = element.type(element.props)
      child.effects.splice(0).forEach(fn => fn())
      if (!child.updates.length) return
    }
    throw new Error(name + ' render loop')
  }
  child.settle = async () => { for (let index = 0; index < 8; index++) { await Promise.resolve(); child.render() } }
  child.unmount = () => child.slots.forEach(state => state.cleanup?.())
  child.render(); return child
}
const activityCases = [
  ['gaps', 'ModelGapPanel'], ['compare', 'ConnectionModelComparison'], ['chain', 'ConnectionModelChain'],
  ['history', 'ModelLearningHistoryPanel'], ['understanding', 'ModelUnderstandingPanel'],
  ['learn', 'ModelLearningPanel'], ['structure', 'ModelStructureEditor'],
]
for (const [tab, name] of activityCases) {
  const panel = mount({ restoreState: { documentId: fixture.documentId, revision: 1, modelId: 'taxi', tab } })
  await panel.resolve(panel.requests.find(item => item.args.modelId === 'taxi'))
  const readCount = panel.requests.length, child = followChild(panel, name)
  const pending = panel.requests.slice(readCount)
  assert(pending.length, name + ' must actually have a pending read')
  assert(pending.every(item => item.signal && !item.signal.aborted))
  panel.props.active = false; panel.render(); child.render()
  assert(pending.every(item => item.signal.aborted), name + ': leaving the model workspace must cancel child reads')
  assert.equal(child.tree, null, name + ': hidden child controls cannot receive focus')
  assert.equal(panel.snapshots.at(-1).tab, tab, 'Hiding keeps the chosen task')
  const hiddenCount = panel.requests.length
  await child.settle()
  assert.equal(panel.requests.length, hiddenCount, 'Hidden child does not restart its reads')
  panel.props.active = true; panel.render(); child.render()
  const fresh = panel.requests.slice(hiddenCount)
  assert(fresh.length, name + ': returning must start a fresh child read')
  pending.forEach(item => item.resolve({ error: { message: 'discarded hidden read' } }))
  await child.settle()
  assert(!text(child.tree).includes('discarded hidden read'), 'Late replies cannot revive after hide -> show')
  fresh.forEach(item => item.resolve({ error: { message: 'current read failure' } }))
  await child.settle()
  assert(text(child.tree).includes('current read failure'), 'A current read failure remains actionable')
  assert.equal(panel.child(name).props.modelId, 'taxi')
  child.unmount(); panel.unmount()
}
assert.equal(JSON.stringify(fixture), before)
assert.equal(writes, 1, 'Only the explicit preview callback ran; no browsing writes')
console.log(JSON.stringify({ groupedVisibleActions: true, learningAndEditorStayActive: true, directionPreviewRetained: true,
  fieldEvidenceInPlace: true, exactFieldIdentityAndQuote: true, fieldChangeCancelsNavigation: true, noCachedFieldPayload: true,
  fieldProvenanceAdjacent: true, sourceFollowsSelection: true, staleEvidenceHiddenBeforeEffects: true,
  sourceCloseCancelsNavigation: true, unknownRolesSeparate: true, sourcePreferenceRestoredWithoutPayload: true,
  hiddenChildReadsCancelled: activityCases.length, reactivationFencesLateReplies: true,
  hiddenParentReadsDeferred: true, parentPartialCompletionCases: 4, completedDetailMountPreserved: true,
  parentFailuresRetried: true, explicitRefreshAndRevisionReadAgain: true,
  hiddenDebounceDeferred: true, explicitDirectionWriteLifecyclePreserved: true,
  staleDirectionDraftRetained: true, removedEndpointRetained: true, lateDirectionResultsFenced: true,
  keyboardFocus: true, canonicalDataUnchanged: true, browserGeometryNotTested: true }))
