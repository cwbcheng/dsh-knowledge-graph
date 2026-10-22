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
  const calls = [], previews = [], admissions = []
  let failNextPreview = false, failNextCommit = false
  const controller = createModelReviewController(state, { call: (method, args) => {
    calls.push({ method, args })
    if (method === 'graph-commit-preview' && failNextPreview) {
      failNextPreview = false
      return Promise.reject(new Error('fixture preview transport failure'))
    }
    if (method === 'graph-commit' && failNextCommit) {
      failNextCommit = false
      return Promise.reject(new Error('fixture commit transport failure'))
    }
    return harness.post(args, method)
  } })
  owner.slots = []; owner.effects = []; updates.splice(0); requests.splice(0); timers.clear()
  Object.assign(props, { documentId: identityDoc.documentId, revision: 1, focusRequest: null, onRoles: async request => {
    admissions.push(request)
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
  editRole('raw-mass', 'input')
  const previewClick = button('预览方向修改').props.onClick
  previewClick(); previewClick(); render()
  assert.equal(admissions.length, 1, 'Repeated preview activation before the disabled render must admit one request')
  assert(button('预览方向修改').props.disabled)
  previewClick()
  assert.equal(admissions.length, 1, 'A retained callback cannot bypass an in-flight preview')
  await settleCanonical()
  assert.equal(calls.filter(call => call.method === 'graph-commit-preview').length, 1)
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
  editRole('product-quality', 'input')
  failNextPreview = true
  click('预览方向修改'); await settleCanonical()
  assert(text(tree).includes('fixture preview transport failure'))
  assert.equal(roleSelect('product-quality').props.value, 'input', 'A failed preview preserves the selected role')
  assert(!button('预览方向修改').props.disabled, 'A failed request releases admission for an explicit retry')
  unchanged()
  click('预览方向修改'); await settleCanonical()
  assert(!text(tree).includes('fixture preview transport failure'))
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
  click('预览方向修改'); await settleCanonical()
  failNextCommit = true
  click('确认保存方向'); await settleCanonical()
  assert(text(tree).includes('fixture commit transport failure'))
  assert.equal(roleSelect('product-quality').props.value, 'output')
  assert(!all(tree, el => el.type === 'button' && text(el) === '确认保存方向').length, 'A failed confirmation requires a new explicit preview')
  unchanged()
  const failedCalls = calls.splice(0)
  assert.equal(failedCalls.filter(call => call.method === 'graph-commit').length, 1)
  click('预览方向修改'); await settleCanonical(); const accepted = previews.at(-1)
  const confirmClick = button('确认保存方向').props.onClick, beforeCommit = admissions.length
  confirmClick(); confirmClick(); render()
  assert.equal(admissions.length - beforeCommit, 1, 'Repeated confirmation must not queue a second canonical write')
  confirmClick()
  assert.equal(admissions.length - beforeCommit, 1)
  await settleCanonical()
  assert(!text(tree).includes('页面、版本或任务状态已变化'), 'Successful confirmation must not be replaced by a duplicate version failure')
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

  // An external revision must not silently rebase unsaved role choices, even
  // when the same canonical endpoint still exists under the same name.
  owner.slots = []; owner.effects = []; updates.splice(0); requests.splice(0); timers.clear()
  const latestController = async () => {
    const loaded = await harness.post({ documentId: identityDoc.documentId, includeSourceText: false }, 'document-export')
    const view = { graph: loaded.graph, sourceText: identityDoc.sourceText }
    return createModelReviewController({ resultView: view, currentResultRef: { current: view },
      graphRevisionRef: { current: loaded.revision }, graphCommitQueueRef: { current: Promise.resolve() }, verifyBusyRef: { current: false } },
    { call: (method, args) => harness.post(args, method) })
  }
  let currentController = await latestController()
  const scopedRequests = []
  Object.assign(props, { revision: 2, focusRequest: null, onRoles: args => { scopedRequests.push(args); return currentController(args) } })
  render(); await resolveIdentity(requests[0]); await resolveIdentity(requests.find(request => request.args.modelId === 'mass-quality'))
  click('核对方向'); editRole('raw-mass', 'input')
  const oldEdit = roleSelect('raw-mass').props.onChange, oldPreview = button('预览方向修改').props.onClick
  click('预览方向修改'); await settleCanonical()
  assert(button('确认保存方向'))
  const external = await latestController(), externalChanges = { 'mass-quality>raw-mass:maps_between': 'output' }
  const externalPreview = await external({ modelId: 'mass-quality', revision: 2, changes: externalChanges, preview: null })
  await external({ modelId: 'mass-quality', revision: 2, changes: externalChanges, preview: externalPreview })
  const externalSaved = structuredClone(harness.store.getDocument(identityDoc.documentId))
  assert.equal(externalSaved.revision, 3)
  currentController = await latestController(); props.revision = 3; render()
  const retainedDraft = () => {
    const draft = all(tree, el => el.props['aria-label'] === '旧版方向修改')[0]
    assert(draft, 'A pending or failed detail read must keep the old direction draft accessible')
    assert(text(draft).includes('raw-mass') && text(draft).includes(identityDoc.sourceUnits[1].text))
    assert(text(draft).includes('原文 P8') && text(draft).includes(identityDoc.graph.source.id))
    assert.equal(all(draft, el => el.type === 'button').length, 1, 'Old evidence is readable, never a current-source navigation target')
    return draft
  }
  retainedDraft()
  requests.filter(request => request.args.modelId).at(-1).reject(new Error('fixture current detail unavailable'))
  await settle()
  assert(text(tree).includes('fixture current detail unavailable'))
  retainedDraft()
  assert(!all(tree, el => el.type === 'button' && text(el) === '确认保存方向').length)
  const failedReadDiscard = button('放弃旧版方向修改').props.onClick
  context.window.confirm = () => { throw new Error('Hidden or retired draft actions must not ask for confirmation') }
  props.active = false; render(); failedReadDiscard(); await settle(); retainedDraft()
  props.active = true; render(); failedReadDiscard(); await settle(); retainedDraft()
  await resolveIdentity(requests.filter(request => !request.args.modelId).at(-1))
  await resolveIdentity(requests.filter(request => request.args.modelId).at(-1))
  assert(button('预览方向修改').props.disabled, 'A direction draft based on revision 2 must not be previewed against revision 3')
  assert.equal(roleSelect('raw-mass').props.value, 'output', 'Current controls must display the current canonical role, not the stale choice')
  assert(roleSelect('raw-mass').props.disabled)
  const staleDraft = all(tree, el => el.props['aria-label'] === '旧版方向修改')[0]
  assert(staleDraft && text(staleDraft).includes('第 2 版') && text(staleDraft).includes('第 3 版'))
  assert(text(staleDraft).includes('raw-mass') && text(staleDraft).includes('输入'))
  assert(text(staleDraft).includes(identityDoc.sourceUnits[1].text), 'Retain the exact old mapping evidence')
  assert(text(staleDraft).includes('原文 P8') && text(staleDraft).includes(identityDoc.graph.source.id), 'Old evidence keeps its paragraph and source identity')
  assert(!all(staleDraft, el => el.type === 'button' && text(el).startsWith('原文 P')).length, 'Old evidence must not navigate the current source')
  const scopedBefore = scopedRequests.length
  oldEdit({ target: { value: 'output' } }); oldPreview(); render(); await settleCanonical()
  assert.equal(scopedRequests.length, scopedBefore, 'Retired version handlers cannot rebase or publish a draft')
  assert.deepEqual(harness.store.getDocument(identityDoc.documentId), externalSaved)
  context.window.confirm = () => false
  click('放弃旧版方向修改')
  assert(all(tree, el => el.props['aria-label'] === '旧版方向修改').length)
  context.window.confirm = () => true
  click('放弃旧版方向修改')
  assert(!all(tree, el => el.props['aria-label'] === '旧版方向修改').length)
  assert(!roleSelect('raw-mass').props.disabled)
  assert.equal(roleSelect('raw-mass').props.value, 'output')
  oldEdit({ target: { value: 'input' } }); oldPreview(); render(); await settleCanonical()
  assert.equal(scopedRequests.length, scopedBefore, 'Discarding does not revive an old-version callback')
  assert(button('预览方向修改').props.disabled)
  editRole('raw-mass', 'input'); click('预览方向修改'); await settleCanonical()
  assert.equal(scopedRequests.at(-1).revision, 3)
  click('确认保存方向'); await settleCanonical()
  const resaved = harness.store.getDocument(identityDoc.documentId)
  assert.equal(resaved.revision, 4)
  assert.deepEqual(resaved.nodes, externalSaved.nodes)
  assert.deepEqual(resaved.edges, externalSaved.edges.map(edge => edge.toNodeId === 'raw-mass' ? { ...edge, role: 'input' } : edge))
  assert.equal(resaved.sourceText, original.sourceText)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(identityDoc.documentId)), sourceUnitsBefore)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)

  // Removing the entire selected model leaves no detail or task navigation.
  // Its previous direction choices must remain readable and explicitly discardable.
  props.revision = 4; render()
  await resolveIdentity(requests.filter(request => !request.args.modelId).at(-1))
  await resolveIdentity(requests.filter(request => request.args.modelId).at(-1))
  editRole('raw-mass', 'output'); click('下上对照')
  const removed = structuredClone(resaved)
  removed.nodes = removed.nodes.filter(node => node.id !== 'mass-quality')
  removed.edges = removed.edges.filter(edge => edge.fromNodeId !== 'mass-quality' && edge.toNodeId !== 'mass-quality')
  harness.store.saveGraph(removed, { sourceText: identityDoc.sourceText, sourceUnits: identityDoc.sourceUnits, expectedRevision: 4 })
  const afterRemoval = structuredClone(harness.store.getDocument(identityDoc.documentId)), writesBeforeRemoval = scopedRequests.length
  assert.equal(afterRemoval.revision, 5)
  props.revision = 5; render(); retainedDraft()
  await resolveIdentity(requests.filter(request => !request.args.modelId).at(-1))
  await resolveIdentity(requests.filter(request => request.args.modelId).at(-1))
  assert(text(retainedDraft()).includes('第 4 版') && text(retainedDraft()).includes('第 5 版'))
  assert(text(retainedDraft()).includes('输入 → 输出'))
  assert(button('核对').props.disabled, 'No model detail means the review task cannot be opened')
  context.window.confirm = () => false
  click('放弃旧版方向修改'); retainedDraft()
  context.window.confirm = () => true
  click('放弃旧版方向修改')
  assert(!all(tree, el => el.props['aria-label'] === '旧版方向修改').length)
  assert.equal(scopedRequests.length, writesBeforeRemoval, 'Inspecting or discarding a removed model draft cannot submit a write')
  assert.deepEqual(harness.store.getDocument(identityDoc.documentId), afterRemoval)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(identityDoc.documentId)), sourceUnitsBefore)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  for (const state of owner.slots) state.cleanup?.()
} finally { harness.stop() }
console.log(JSON.stringify({ ok: true, staleResponsesRejected: true, previewApprovalInvalidation: true,
  errorRetry: true, wholeGraphSearch: true, sourceNavigation: true, unmountAborts: true,
  singleDirectionPreviewAndConfirmation: true, failedDirectionPreviewAndCommitRetry: true,
  versionedDirectionDraft: true, oldDirectionEvidenceRetained: true, explicitCurrentVersionRecheck: true,
  failedReadDirectionDraftAccessible: true, removedModelDirectionDraftAccessible: true,
  sameNameDirectionIdentity: true, exactApprovalEvidence: true, actualCanonicalPreviewAndConfirmation: true, conditionsAndSourcePreserved: true }))
