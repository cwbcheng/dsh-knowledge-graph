import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createGraphContract } from '../src/index.host.js'
import { connectionFixture } from './kg-connection-model-fixture-data.mjs'
import { directionIdentityFixture } from './kg-model-direction-identity-fixture.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { createModelReviewController } from './kg-model-review-controller-fixture.mjs'

const doc = connectionFixture(), query = createGraphContract().connectionModels
let current, cursor = 0
const updates = [], timers = new Map()
let timerId = 0
const slot = init => { const index = cursor++; return current.slots[index] ||= init() }
const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } } },
  useState(initial) {
    const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [state.value, next => updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })]
  },
  useRef(initial) { return slot(() => ({ current: initial })) },
  useMemo(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((v, i) => !Object.is(v, state.deps[i]))) { state.value = fn(); state.deps = deps }; return state.value },
  useEffect(fn, deps) {
    const state = slot(() => ({}))
    if (!state.deps || deps.some((v, i) => !Object.is(v, state.deps[i]))) {
      current.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    }
  },
}
const context = { window: { React }, console, AbortController, setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id) }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const Component = context.window.KGViewer.ConnectionModelPanel
assert.equal(typeof Component, 'function')
const requests = [], writes = [], located = []
const props = { documentId: doc.documentId, revision: 1,
  load(args, signal) { return new Promise((resolve, reject) => requests.push({ args, signal, resolve, reject })) },
  onLocate: reference => located.push(reference),
  onRoles: async request => { writes.push(request); return request.preview ? { saved: true } : { signature: 'approved', diff: [{ text: '距离', before: '', after: 'input' }] } },
}
const owner = { slots: [], effects: [] }
let tree
function render() {
  for (let i = 0; i < 20; i++) {
    updates.splice(0).forEach(fn => fn()); current = owner; cursor = 0
    tree = Component(props); owner.effects.splice(0).forEach(fn => fn())
    if (!updates.length) return
  }
  throw new Error('Component update loop')
}
async function settle() { for (let i = 0; i < 6; i++) { await Promise.resolve(); render() } }
const text = el => Array.isArray(el) ? el.map(text).join('') : el && typeof el === 'object' ? text(el.props?.children) : String(el ?? '')
const all = (el, fn) => Array.isArray(el) ? el.flatMap(child => all(child, fn)) : !el || typeof el !== 'object' ? [] : [...(fn(el) ? [el] : []), ...all(el.props?.children, fn)]
const button = label => {
  const item = all(tree, el => el.type === 'button' && (el.props['aria-label'] === label || text(el) === label))[0]
  assert(item, 'Missing button: ' + label); return item
}
const click = label => { const item = button(label); assert(!item.props.disabled, 'Disabled: ' + label); item.props.onClick(); render() }
const resolve = async request => { request.resolve(query(doc, request.args)); await settle() }
render()
await resolve(requests[0])
await resolve(requests.find(request => request.args.modelId === 'taxi'))
assert(text(tree).includes('输入') && text(tree).includes('例子与验证材料'))
assert(text(tree).includes('2 km 对应 10 元'))
assert.equal(writes.length, 0, 'browsing must issue no writes')
click('核对方向')
const inputRole = all(tree, el => el.type === 'select' && el.props['aria-label'] === '端点角色 distance')[0]
inputRole.props.onChange({ target: { value: 'output' } }); render()
click('预览方向修改'); await settle()
assert(text(tree).includes('待确认的方向修改'))
assert.equal(writes.length, 1)
assert.equal(writes[0].preview, null)
inputRole.props.onChange({ target: { value: '' } }); render()
assert(!text(tree).includes('确认保存方向'), 'editing invalidates approval')
click('预览方向修改'); await settle()
click('确认保存方向'); await settle()
assert.equal(writes.length, 3)
assert.equal(writes[2].preview.signature, 'approved')
await resolve(requests.filter(request => request.args.modelId === 'taxi').at(-1))
await resolve(requests.filter(request => !request.args.modelId).at(-1))

props.focusRequest = { documentId: doc.documentId, revision: props.revision, nodeId: 'unknown', type: 'connection_model' }; render()
const stale = requests.at(-1)
props.focusRequest = { documentId: doc.documentId, revision: props.revision, nodeId: 'wrong', type: 'connection_model' }; render()
const fresh = requests.at(-1)
assert(stale.signal.aborted, 'switching model aborts the old detail request')
await resolve(fresh)
assert(text(tree).includes('文本涉及错误示例'))
await resolve(stale)
assert(text(tree).includes('文本涉及错误示例'), 'late response cannot replace the selected model')
click('核对原文')
assert(text(tree).includes('模型引用'))
const sourceButton = button('原文 P5')
sourceButton.props.onClick(); await settle()
assert.equal(located[0].paragraph, 4)

const search = all(tree, el => el.type === 'input' && el.props['aria-label'] === '搜索联结模型')[0]
search.props.onChange({ target: { value: 'tail' } }); render()
for (const fn of [...timers.values()]) fn(); timers.clear(); render()
const searchRequest = requests.filter(request => !request.args.modelId).at(-1)
assert.equal(searchRequest.args.query, 'tail')
await resolve(searchRequest)
assert(text(tree).includes('跨窗口目标'))
const listItem = all(tree, el => el.type === 'button' && el.props.className === 'kg-model-list-item')[0]
listItem.props.onClick(); render()
const failure = requests.at(-1); failure.reject(new Error('fixture network error')); await settle()
assert(text(tree).includes('fixture network error'))
click('重新读取模型')
await resolve(requests.filter(request => request.args.modelId).at(-1))
assert(text(tree).includes('模型 24'))
click('返回上一个模型')
await resolve(requests.filter(request => request.args.modelId).at(-1))
assert(text(tree).includes('文本涉及错误示例'))

props.revision = 2; render()
assert(!text(tree).includes('模型引用'), 'a revision change removes stale detail immediately')
requests.at(-1).resolve({ error: { code: 'revision_conflict', message: '版本已变化' } }); await settle()
assert(text(tree).includes('版本已变化'))
const pending = requests.filter(request => !request.signal.aborted)
for (const state of owner.slots) state.cleanup?.()
assert(pending.every(request => request.signal.aborted), 'unmount aborts outstanding reads')
assert.equal(writes.length, 3, 'retries and navigation may never trigger another write')

// Two meanings of the same word must remain distinguishable at approval time.
// Use the actual production controller and canonical SQLite HTTP validation.
const identityDoc = directionIdentityFixture(), harness = await modelLearningHarness({ fixture: identityDoc })
try {
  const original = structuredClone(harness.store.getDocument(identityDoc.documentId))
  const sourceUnitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(identityDoc.documentId))
  const windowed = await harness.post({ documentId: identityDoc.documentId, nodeLimit: 1, query: 'raw-mass', includeSourceText: false }, 'document-load')
  const openingView = { graph: windowed.graph, sourceText: identityDoc.sourceText }
  const state = { resultView: openingView, currentResultRef: { current: openingView }, graphRevisionRef: { current: 1 },
    graphCommitQueueRef: { current: Promise.resolve() }, verifyBusyRef: { current: false } }
  const calls = [], previews = []
  const controller = createModelReviewController(state, { call: (method, args) => { calls.push({ method, args }); return harness.post(args, method) } })
  owner.slots = []; owner.effects = []; updates.splice(0); requests.splice(0); timers.clear()
  Object.assign(props, { documentId: identityDoc.documentId, revision: 1, focusRequest: null, onRoles: async request => {
    const result = await controller(request); if (!request.preview) previews.push(result); return result
  } })
  const resolveIdentity = async request => { request.resolve(await harness.post(request.args, 'connection-models')); await settle() }
  const settleCanonical = async () => { for (let index = 0; index < 8; index++) { await new Promise(setImmediate); await settle() } }
  const roleSelect = id => all(tree, el => el.type === 'select' && el.props['aria-label'] === '端点角色 ' + id)[0]
  const editRole = (id, value) => { const select = roleSelect(id); assert(select); select.props.onChange({ target: { value } }); render() }
  const approvalBlock = () => all(tree, el => el.type === 'div' && el.props.children?.some(child => child?.type === 'h4' && text(child) === '待确认的方向修改')).at(-1)
  const unchanged = () => {
    assert.deepEqual(harness.store.getDocument(identityDoc.documentId), original, 'preview and cancellation must preserve canonical graph, identities, conditions and full evidence')
    assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(identityDoc.documentId)), sourceUnitsBefore)
    assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  }
  render(); await resolveIdentity(requests[0]); await resolveIdentity(requests.find(request => request.args.modelId === 'mass-quality'))
  click('核对方向')
  for (const id of ['raw-mass', 'product-quality']) {
    const label = all(tree, el => el.type === 'label' && all(el, child => child === roleSelect(id)).length)[0]
    assert(text(label).includes(id), 'Same-name role selector must visibly identify its concept: ' + id)
  }
  editRole('raw-mass', 'input'); click('预览方向修改'); await settleCanonical()
  const rawPreview = previews.at(-1), rawBlock = approvalBlock()
  assert.equal(rawPreview.diff[0].nodeId, 'raw-mass')
  assert.equal(rawPreview.diff[0].edgeKey, 'mass-quality>raw-mass:maps_between')
  assert(text(rawBlock).includes('raw-mass') && text(rawBlock).includes(identityDoc.sourceUnits[1].text))
  assert(!text(rawBlock).includes(identityDoc.sourceUnits[2].text), 'Approval cannot borrow the other same-name concept evidence')
  const rawReference = all(rawBlock, el => el.type === 'button' && text(el) === '原文 P8')[0]
  assert(rawReference); const previousLocated = located.length
  rawReference.props.onClick(); await settle()
  assert.equal(located[previousLocated].nodeId, null, 'Mapping evidence must stay a source citation rather than borrowing a node locator')
  assert.equal(located[previousLocated].documentId, identityDoc.documentId); assert.equal(located[previousLocated].revision, 1)
  assert.equal(located[previousLocated].sourceId, identityDoc.graph.source.id); assert.equal(located[previousLocated].sourceQuoteOnly, true)
  assert.equal(located[previousLocated].paragraph, 7)
  assert.equal(located[previousLocated].quote, identityDoc.sourceUnits[1].text)
  unchanged(); click('取消预览'); editRole('raw-mass', '')
  editRole('product-quality', 'input'); click('预览方向修改'); await settleCanonical()
  const qualityPreview = previews.at(-1), qualityBlock = approvalBlock()
  assert.equal(qualityPreview.diff[0].nodeId, 'product-quality')
  assert(text(qualityBlock).includes('product-quality') && text(qualityBlock).includes(identityDoc.sourceUnits[2].text))
  assert(!text(qualityBlock).includes(identityDoc.sourceUnits[1].text))
  assert.notEqual(rawPreview.signature, qualityPreview.signature, 'Two different canonical endpoint changes must keep different approvals')
  assert.notEqual(text(rawBlock), text(qualityBlock), 'Two different endpoint approvals must be distinguishable to the reader')
  editRole('raw-mass', 'input'); editRole('product-quality', 'output'); click('预览方向修改'); await settleCanonical()
  const together = previews.at(-1), combinedBlock = approvalBlock()
  assert.deepEqual(together.diff.map(item => item.nodeId).sort(), ['product-quality', 'raw-mass'])
  for (const item of together.diff) {
    const card = all(combinedBlock, el => el.type === 'div' && el.props.key === item.edgeKey)[0]
    const own = identityDoc.sourceUnits[item.nodeId === 'raw-mass' ? 1 : 2].text, other = identityDoc.sourceUnits[item.nodeId === 'raw-mass' ? 2 : 1].text
    assert(text(card).includes(item.nodeId) && text(card).includes(own) && !text(card).includes(other), 'Each simultaneous same-name change keeps its own mapping evidence')
  }
  unchanged(); editRole('raw-mass', '')
  const changes = { 'mass-quality>product-quality:maps_between': 'output' }
  editRole('product-quality', 'output')
  assert(!all(tree, el => el.type === 'button' && text(el) === '确认保存方向').length, 'A new role edit invalidates the visible approval')
  await assert.rejects(controller({ modelId: 'mass-quality', revision: 1, changes, preview: qualityPreview }), /重新预览/)
  unchanged(); assert(!calls.some(call => call.method === 'graph-commit'), 'Browsing, previewing, cancellation and stale approval must never commit')
  click('预览方向修改'); await settleCanonical(); const accepted = previews.at(-1)
  click('确认保存方向'); await settleCanonical()
  const commits = calls.filter(call => call.method === 'graph-commit')
  assert.equal(commits.length, 1, 'Only explicit UI confirmation may write the single selected endpoint')
  assert.equal(JSON.stringify(commits[0].args), accepted.signature)
  assert.equal(commits[0].args.graph.nodes.length, 0)
  assert.equal(commits[0].args.graph.edges.length, 1)
  assert.equal(commits[0].args.graph.edges[0].toNodeId, 'product-quality')
  const saved = harness.store.getDocument(identityDoc.documentId)
  assert.equal(saved.revision, 2); assert.deepEqual(saved.nodes, original.nodes)
  assert.deepEqual(saved.edges, original.edges.map(edge => edge.toNodeId === 'product-quality' ? { ...edge, role: 'output' } : edge))
  assert.equal(saved.sourceText, original.sourceText); assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(identityDoc.documentId)), sourceUnitsBefore)
  assert.equal((await harness.post(commits[0].args, 'graph-commit')).error.code, 'revision_conflict', 'Old approval still requires canonical version CAS')
  assert.equal(harness.store.getDocumentRevision(identityDoc.documentId), 2)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  for (const state of owner.slots) state.cleanup?.()
} finally { harness.stop() }
console.log(JSON.stringify({ ok: true, staleResponsesRejected: true, previewApprovalInvalidation: true,
  errorRetry: true, wholeGraphSearch: true, sourceNavigation: true, unmountAborts: true,
  sameNameDirectionIdentity: true, exactApprovalEvidence: true, actualCanonicalPreviewAndConfirmation: true, conditionsAndSourcePreserved: true }))
