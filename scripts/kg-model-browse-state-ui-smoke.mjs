import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createGraphContract } from '../src/index.host.js'
import { connectionFixture } from './kg-connection-model-fixture-data.mjs'
import { modelExamplesFixture } from './kg-consumption-model-examples-fixture-data.mjs'

const doc = connectionFixture(), query = createGraphContract().connectionModels
let current, cursor = 0, timerId = 0
const timers = new Map()
const slot = init => { const index = cursor++; return current.slots[index] ||= init() }
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useRef: initial => slot(() => ({ current: initial })),
  useState(initial) {
    const owner = current, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [state.value, next => owner.updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })]
  },
  useEffect(fn, deps) {
    const owner = current, state = slot(() => ({}))
    if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
      owner.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    }
  },
}
const context = { window: { React, confirm: () => true }, AbortController, console,
  setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id) }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const Component = context.window.KGViewer.ConnectionModelPanel
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const all = (node, test) => Array.isArray(node) ? node.flatMap(child => all(child, test)) : !node || typeof node !== 'object' ? []
  : [...(test(node) ? [node] : []), ...all(node.props?.children, test)]
let writes = 0
const mount = options => {
  const owner = { slots: [], effects: [], updates: [], requests: [], snapshots: [] }
  const props = { documentId: doc.documentId, revision: 1, ...options,
    load: (args, signal) => new Promise(resolve => owner.requests.push({ args, signal, resolve })),
    onStateChange: state => owner.snapshots.push(state),
    onRoles: () => { writes++; throw new Error('Browsing restoration cannot write') } }
  owner.props = props
  owner.render = () => {
    for (let index = 0; index < 20; index++) {
      owner.updates.splice(0).forEach(fn => fn()); current = owner; cursor = 0
      owner.tree = Component(props); owner.effects.splice(0).forEach(fn => fn())
      if (!owner.updates.length) return
    }
    throw new Error('Component update loop')
  }
  owner.control = label => {
    const item = all(owner.tree, node => node.props['aria-label'] === label || node.type === 'button' && text(node) === label)[0]
    assert(item, 'Missing control: ' + label); return item
  }
  owner.click = label => { const control = owner.control(label); assert(!control.props.disabled); control.props.onClick(); owner.render() }
  owner.settle = async () => { for (let index = 0; index < 6; index++) { await Promise.resolve(); owner.render() } }
  owner.resolve = async request => { request.resolve(query(doc, request.args)); await owner.settle() }
  owner.unmount = () => { for (const state of owner.slots) state.cleanup?.() }
  owner.render()
  return owner
}
const previousFocus = { documentId: doc.documentId, revision: 1, nodeId: 'unknown', type: 'connection_model' }
const cached = { documentId: doc.documentId, revision: 1, query: 'tail', search: 'tail', section: '', offset: 20,
  needsReview: true, modelId: 'wrong', tab: 'source', focusRequest: previousFocus,
  branchId: '', exampleOffset: 0, selectedSlot: 'slot:namespace', selectedExample: '例子甲',
  history: [{ modelId: 'taxi', tab: 'materials', materialOffset: 0, offset: 0 }],
  page: { unsafe: 'old response' }, detail: { unsafe: 'old source' }, roles: { unsafe: 'output' }, preview: { signature: 'fake approval' } }
let owner = mount({ restoreState: cached, focusRequest: previousFocus })
assert.equal(owner.control('搜索联结模型').props.value, 'tail', 'History remount lost the entered model query')
assert.equal(owner.requests.find(item => !item.args.modelId).args.offset, 20)
assert.equal(owner.requests.find(item => item.args.modelId).args.modelId, 'wrong', 'Consumed focus must not overwrite the later selection')
assert.equal(timers.size, 0, 'Restored settled query must not reset its page after a new debounce timer')
assert(!text(owner.tree).includes('old response') && !text(owner.tree).includes('old source'))
await owner.resolve(owner.requests.find(item => !item.args.modelId))
await owner.resolve(owner.requests.find(item => item.args.modelId))
assert(text(owner.tree).includes('文本涉及错误示例') && text(owner.tree).includes('模型引用'))
assert(owner.control('原文依据').props['aria-pressed'])
assert(!text(owner.tree).includes('确认保存方向'), 'Navigation never restores an approval')
for (const name of ['page', 'detail', 'roles', 'preview', 'saving', 'practiceRequest', 'understandingRequest']) {
  assert(!Object.hasOwn(owner.snapshots.at(-1), name), 'Only browsing intent may be cached: ' + name)
}
owner.click('返回上一个模型')
assert.equal(owner.requests.at(-1).args.modelId, 'taxi')
await owner.resolve(owner.requests.at(-1))
owner.props.focusRequest = { ...previousFocus }; owner.render()
assert.equal(owner.requests.at(-1).args.modelId, 'unknown', 'A fresh same-node focus event must still be consumed')
await owner.resolve(owner.requests.at(-1))
assert(text(owner.tree).includes('未定角色的端点'), 'Unknown direction cannot become an inferred input/output')
owner.control('搜索联结模型').props.onChange({ target: { value: 'not yet debounced' } }); owner.render()
const pendingText = owner.snapshots.at(-1)
assert.equal(pendingText.query, 'not yet debounced')
assert.equal(pendingText.search, 'tail')
owner.unmount()
assert.equal(timers.size, 0)
assert(owner.requests.every(item => item.signal.aborted), 'Unmount cancels both current catalogue and detail reads')
owner = mount({ restoreState: pendingText })
assert.equal(owner.control('搜索联结模型').props.value, 'not yet debounced')
assert.equal(owner.requests.find(item => !item.args.modelId).args.query, 'not yet debounced')
assert.equal(owner.requests.find(item => !item.args.modelId).args.offset, 0, 'New text cannot inherit the previous query page')
const failed = owner.requests.find(item => item.args.modelId)
failed.resolve({ error: { code: 'revision_conflict', message: 'Canonical source version changed' } }); await owner.settle()
assert(text(owner.tree).includes('Canonical source version changed'))
assert(!text(owner.tree).includes('输入到输出的模型') && !text(owner.tree).includes('模型引用'))
assert.equal(owner.control('搜索联结模型').props.value, 'not yet debounced')
owner.click('重新读取模型')
assert.equal(owner.requests.at(-1).args.expectedRevision, 1)
owner.unmount()

for (const value of [null, {}, { ...cached, documentId: doc.documentId + ' ' }, { ...cached, revision: 2 }]) {
  const fresh = mount({ restoreState: value })
  assert.equal(fresh.control('搜索联结模型').props.value, '')
  assert.equal(fresh.requests[0].args.offset, 0)
  assert(!fresh.requests.some(item => item.args.modelId), 'Different document/version cannot reuse a saved selection')
  fresh.unmount()
}
const exact = ' 模型：namespace:输入 t0／m/s → 输出 t1／km/h ' + 'unbroken'.repeat(500)
const identityOwner = mount({ restoreState: { ...cached, query: '', search: '', modelId: exact, concept: { nodeId: ' concept ', text: 'Concept' }, role: 'unknown' } })
assert.equal(identityOwner.requests.find(item => item.args.modelId).args.modelId, exact)
assert.equal(identityOwner.requests.find(item => !item.args.modelId).args.conceptId, ' concept ')
assert.equal(identityOwner.requests.find(item => !item.args.modelId).args.role, 'unknown')
identityOwner.unmount()
const malformed = mount({ restoreState: { ...cached, query: 2, search: 2, modelId: null, offset: Infinity, role: 'invented',
  concept: { nodeId: 2 }, tab: 'not-a-tab', materialOffset: -1, exampleOffset: 1.5,
  history: Array.from({ length: 50 }, () => ({ modelId: 'taxi', tab: 'materials', detail: { unsafe: true } })) } })
assert.equal(malformed.requests[0].args.offset, 0)
assert.equal(malformed.requests[0].args.conceptId, '')
assert.equal(malformed.snapshots[0].history.length, 30)
assert(malformed.snapshots[0].history.every(item => !Object.hasOwn(item, 'detail')))
const stale = malformed.requests[0]
malformed.unmount()
const nextDocument = mount({ documentId: doc.documentId + ' ', revision: 3, restoreState: cached })
const beforeSnapshots = nextDocument.snapshots.length
stale.resolve(query(doc, stale.args)); await nextDocument.settle()
assert.equal(nextDocument.snapshots.length, beforeSnapshots, 'Late old-document response cannot write into the new browsing cache')
assert.equal(nextDocument.requests[0].args.documentId, doc.documentId + ' ')
assert.equal(nextDocument.requests[0].args.expectedRevision, 3)
nextDocument.unmount()
for (const focusRequest of [{ ...previousFocus, documentId: doc.documentId + ' ' },
  { ...previousFocus, revision: 2 }, { nodeId: 'unknown', type: 'connection_model' }]) {
  const scoped = mount({ focusRequest })
  assert(!scoped.requests.some(item => item.args.modelId), 'A pending old or unbound focus cannot select a new document/version model')
  scoped.props.focusRequest = { ...previousFocus }; scoped.render()
  assert.equal(scoped.requests.at(-1).args.modelId, 'unknown', 'A fresh explicitly scoped intent remains usable after a stale intent')
  scoped.unmount()
}
const riskFixture = modelExamplesFixture()
const riskIds = ['multi', 'units', 'times', 'same-name', 'unknown-unit', 'unknown-state', 'wrong-model',
  'type-model', 'unknown-role', 'uncited', 'return-model', 'duplicate-concept', 'unsupported-model'].map(id => 'pair-' + id)
for (const id of [...riskIds, 'pair-conflict-a', 'pair-conflict-b']) {
  const reading = mount({ restoreState: { ...cached, query: '', search: '', modelId: id, tab: 'materials' } })
  const request = reading.requests.find(item => item.args.modelId === id)
  assert(request, 'Restore must use full distinct canonical identity: ' + id)
  const response = query(riskFixture, request.args)
  assert(!response.error, 'Semantic counterexample fixture must be readable: ' + id)
  const original = JSON.stringify(response)
  request.resolve(response); await reading.settle()
  const semanticStatus = response.model.entailmentStatus === 'unverified' ? '语义未独立核验' : response.model.entailmentStatus
  assert.notEqual(response.model.entailmentStatus, 'verified', 'These counterexamples are not independently verified')
  assert(text(reading.tree).includes('图谱抽取表述 · ' + semanticStatus), 'Restoration cannot promote or erase the canonical semantic status: ' + id)
  const snapshot = reading.snapshots.at(-1)
  reading.unmount()
  const returned = mount({ restoreState: snapshot })
  const reread = returned.requests.find(item => item.args.modelId === id)
  assert(reread)
  assert.equal(JSON.stringify(query(riskFixture, reread.args)), original, 'Roles, necessary inputs, state, qualifiers, loops or conflicting source were changed: ' + id)
  assert(!Object.hasOwn(snapshot, 'detail') && !Object.hasOwn(snapshot, 'structure'))
  returned.unmount()
}
assert.equal(writes, 0)

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const generated = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const slice = value => value.slice(value.indexOf('function connectionModelBrowseState('), value.indexOf('function ConnectionSourceUnits('))
assert(slice(source).startsWith('function connectionModelBrowseState('))
assert.equal(slice(source).replaceAll('host.call(', 'rpc('), slice(generated))
assert(source.includes('restoreState: connectionPerspectiveRef.current') && generated.includes('restoreState: connectionPerspectiveRef.current'))
assert(source.includes('setConnectionFocus({ documentId: workspaceDocumentId, revision: graphRevisionRef.current,')
  && generated.includes('setConnectionFocus({ documentId: workspaceDocumentId, revision: graphRevisionRef.current,'))
assert.equal(timers.size, 0)
console.log(JSON.stringify({ ok: true, freshCanonicalReads: true, catalogueAndDetailRestored: true, boundedHistory: 30,
  pendingQueryRetained: true, consumedFocusNotReplayed: true, focusDocumentAndRevisionBound: true, staleDocumentAndVersionRejected: true,
  errorsDoNotRestoreEvidence: true, semanticCounterexamples: riskIds.length, conflictingSources: 2,
  sourceGeneratedParity: true, writes, browserAcceptanceRequired: true }))
