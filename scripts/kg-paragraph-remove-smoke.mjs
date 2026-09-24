import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { openSqliteStore } from '../src/kg-store.mjs'
import { createGraphContract } from '../src/index.host.js'
import * as persistentHost from '../lib/index.js'

// Exercise the shipped client helpers, not a second implementation of deletion.
const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const sandbox = { window: { React: {} }, console }
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { paragraphTypeNodes, removeParagraphType, graphViewMetadata, documentIdOfGraph, asAllNodesGraph, graphCommitViewPatch,'), sandbox)
const helpers = sandbox.window.KGViewer
const sourceText = '# Sample book\n\n# Contents and learning reuse Learning concept\n\nExample Author reuses Learning concept\n\nLearning concept'
const documentId = 'document-paragraph-remove-test'
const graph = {
  ontology: 'learning-view-v1',
  source: { id: 'source-paragraph-remove-test', documentId, title: 'Paragraph removal test', sections: [] },
  graphOntology: createGraphContract().ontologies.find(record => record.id === 'learning-view-v1'),
  nodes: [
    { id: 'toc-a', type: 'memory_material', text: 'Contents', paragraph: 1, quote: 'Contents', evidence: [{ paragraph: 1, quote: 'Contents' }] },
    { id: 'toc-b', type: 'memory_material', text: 'learning', paragraph: 1, quote: 'learning', evidence: [{ paragraph: 1, quote: 'learning' }] },
    { id: 'concept', type: 'concept', text: 'Learning concept', paragraph: 3, quote: 'Learning concept', evidence: [{ paragraph: 3, quote: 'Learning concept' }] },
    { id: 'author', type: 'memory_material', text: 'Example Author', paragraph: 2, quote: 'Example Author', evidence: [{ paragraph: 2, quote: 'Example Author' }] },
  ],
  edges: [
    { fromNodeId: 'toc-a', toNodeId: 'concept', relation: 'transfers_from', evidence: [{ paragraph: 1, quote: 'Contents and learning reuse Learning concept' }] },
    { fromNodeId: 'author', toNodeId: 'concept', relation: 'transfers_from', evidence: [{ paragraph: 2, quote: 'Example Author reuses Learning concept' }] },
  ],
  verification: { lastReport: { id: 'report', issues: [] } },
  factCheck: { lastReport: { id: 'fact-report', claims: [] } },
}
const ids = nodes => Array.from(nodes, node => node.id)
const view = helpers.makeView(graph, sourceText)
assert.deepEqual(ids(helpers.paragraphTypeNodes(view, 1, 'memory_material')), ['toc-a', 'toc-b'])
const next = helpers.removeParagraphType(view, 1, 'memory_material')
assert.deepEqual(ids(next.nodes), ['concept', 'author'])
assert.equal(next.edges.length, 1)
assert.equal(next.edges[0].fromNodeId, 'author')
assert.equal(next.verification.stale, true)
assert.equal(next.factCheck.stale, true)
assert.equal(next.verification.auditLog.length, 2)
assert.equal(graph.nodes.length, 4, 'editing must not mutate the baseline')
assert.equal(helpers.removeParagraphType(view, 0, 'memory_material'), view.graph)
const movedAnchor = helpers.makeView({ ...graph, nodes: [{ ...graph.nodes[0], paragraph: 0 }, { ...graph.nodes[0], id: 'other-type', type: 'concept' }] }, sourceText)
assert.deepEqual(ids(helpers.paragraphTypeNodes(movedAnchor, 1, 'memory_material')), ['toc-a'], 'use the displayed quote anchor, not the raw paragraph field')
assert.deepEqual(ids(helpers.removeParagraphType(movedAnchor, 1, 'memory_material').nodes), ['other-type'], 'keep other types in the same paragraph')

// Drive the actual async UI action with controlled failures and races.
const actionStart = source.indexOf('        const handleRemoveParagraphType = async')
const actionEnd = source.indexOf('        const commitGraph =', actionStart)
assert(actionStart >= 0 && actionEnd > actionStart)
function actionHarness(overrides = {}) {
  const calls = [], errors = [], toasts = [], views = [], progress = [], painted = []
  const env = {
    ...helpers, resultView: view, currentResultRef: { current: view }, paragraphRemovalRef: { current: false },
    graphRevisionRef: { current: 7 }, taskId: null, phase: 'done', graphWindowLoading: false, documentLoading: null,
    TYPE_META: { memory_material: { label: 'Memory' } }, window: { confirm: () => true },
    host: { call: async method => { calls.push(method); return { busy: false } } },
    persistGraph: async (g, baseline, revision) => { calls.push(['commit', ids(g.nodes), baseline, revision]); return { documentId, revision: 8, graph: { ...g, revision: 8 } } },
    loadGraphDocument: async () => { throw new Error('unexpected reload') },
    setError: e => { if (e) errors.push(e) }, toastStore: { show: text => toasts.push(text) },
    setResultView: value => views.push(value), setRemovingParagraphType: value => progress.push(value),
    graphPaint: async () => { painted.push(progress.at(-1)) }, setSelectedNodeId() {}, setSelectedEdgeId() {},
    setActiveIssueId() {}, setFocusReq() {}, setQuestionTarget() {}, setQuestionResult() {}, setVerification() {}, setFactReport() {},
    setGraphPageDraft() {}, setGraphQueryDraft() {}, ...overrides,
  }
  const action = new Function(...Object.keys(env), source.slice(actionStart, actionEnd) + '\nreturn handleRemoveParagraphType')(...Object.values(env))
  return { action, env, calls, errors, toasts, views, progress, painted }
}
let ui = actionHarness({ window: { confirm: () => false } })
await ui.action(1, 'memory_material')
assert.equal(ui.calls.length, 0, 'cancel must not send a request')
for (const active of [{ busy: true }, {}, null]) {
  ui = actionHarness({ host: { call: async () => active } })
  await ui.action(1, 'memory_material')
  assert.equal(ui.views.length, 0)
  assert.equal(ui.toasts.length, 0)
  assert.equal(ui.errors.length, 1)
}
ui = actionHarness({ persistGraph: async () => null })
await ui.action(1, 'memory_material')
assert.equal(ui.views.length, 0, 'failed persistence must keep the displayed tags')
assert.equal(ui.toasts.length, 0, 'failed persistence must not report success')
assert.equal(ui.progress.at(-1), false, 'failed persistence must clear busy state')
assert(!ui.progress.some(value => String(value).includes('删除已保存')), 'do not report saved before acknowledgment')
ui = actionHarness()
await ui.action(1, 'memory_material')
assert.deepEqual(ui.calls[1].slice(0, 2), ['commit', ['concept', 'author']])
assert.equal(ui.calls[1][3], 7, 'pin the original revision across queued edits')
assert.equal(ui.views.length, 1)
assert.equal(ui.views[0].paraTypes[1].includes('memory_material'), false)
assert.equal(ui.toasts.length, 1)
assert.deepEqual(ui.painted, ['正在校验并保存删除结果…', '删除已保存，正在刷新知识图…'], 'paint actual stages before synchronous work')
assert.equal(ui.progress.at(-1), false)
let release
const waiting = new Promise(resolve => { release = resolve })
ui = actionHarness({ host: { call: () => waiting } })
const firstClick = ui.action(1, 'memory_material')
await ui.action(1, 'memory_material')
ui.env.currentResultRef.current = helpers.makeView(graph, sourceText)
release({ busy: false })
await firstClick
assert.equal(ui.calls.length, 0, 'view changes and double clicks must not commit stale selections')
assert.equal(ui.env.paragraphRemovalRef.current, false)

const windowView = helpers.makeView({ ...graph, view: { kind: 'query', query: 'Contents', nodeOffset: 0, nodeLimit: 200, totalNodes: 4, totalEdges: 2 } }, sourceText)
for (const reloadFails of [false, true]) {
  const reloads = []
  ui = actionHarness({ resultView: windowView, currentResultRef: { current: windowView }, loadGraphDocument: async body => {
    reloads.push(body)
    if (reloadFails) throw new Error('offline')
    return { graph: { ...next, revision: 8 } }
  } })
  await ui.action(1, 'memory_material')
  assert.equal(reloads[0].query, 'Contents', 'preserve the selected query window')
  assert.equal(reloads[0].nodeLimit, 200)
  assert.deepEqual(ids(ui.views[0].graph.nodes), ['concept', 'author'])
  assert.equal(ui.errors.length, reloadFails ? 1 : 0, 'a failed refresh must still display the acknowledged saved graph')
}

const allView = helpers.makeView(helpers.asAllNodesGraph(graph), sourceText)
const allNext = helpers.removeParagraphType(allView, 1, 'memory_material')
ui = actionHarness({ resultView: allView, currentResultRef: { current: allView },
  host: { call: async method => method === 'task-active' ? { busy: false }
    : method === 'document-export' ? { documentId, revision: 8, graph: allNext }
      : { error: { message: 'unexpected request' } } },
  loadGraphDocument: async () => { throw new Error('all-node mode must not reload a bounded window') },
})
await ui.action(1, 'memory_material')
assert.equal(ui.views.length, 1)
assert.equal(ui.views[0].graph.view.kind, 'all', 'deletion must preserve the complete working view')
assert.deepEqual(ids(ui.views[0].graph.nodes), ['concept', 'author'])

const persistStart = source.indexOf('        const persistGraph = (g, baseGraph, pinnedRevision)')
assert(persistStart >= 0 && persistStart < actionStart)
function persistHarness(response, overrides = {}) {
  const errors = [], saved = [], requests = [], views = []
  const env = {
    ...helpers, resultView: view, currentResultRef: { current: view }, fullText: sourceText, title: 'test', currentHistoryId: 'test',
    semanticOperationsOf: () => [], graphSemanticOperations: new WeakMap(),
    graphRevisionRef: { current: 12 }, graphCommitQueueRef: { current: Promise.resolve() }, graphCommitEpochRef: { current: 0 },
    localStorage: { setItem: (...args) => saved.push(args) }, LS_RESULT: 'test-result', setHistory() {}, appendHistory: value => value,
    setError: e => errors.push(e), setResultView: value => views.push(value), setVerification() {}, setFactReport() {}, toastStore: { show() {} },
    host: { call: async (method, body) => { requests.push(body); return response } }, ...overrides,
  }
  const persist = new Function(...Object.keys(env), source.slice(persistStart, actionStart) + '\nreturn persistGraph')(...Object.values(env))
  return { env, persist, errors, saved, requests, views }
}
for (const response of [null, {}, { documentId, revision: 8 }, { error: { code: 'revision_conflict', message: 'Conflict' } }]) {
  const commit = persistHarness(response)
  assert.equal(await commit.persist(next, view.graph, 7), null)
  assert.equal(commit.errors.length, 1)
  assert.equal(commit.saved.length, 0, 'do not store a success reference without an acknowledged commit')
  assert.equal(commit.env.graphRevisionRef.current, 12)
}
const ack = { documentId, revision: 8, graph: next }
let commit = persistHarness(ack)
assert.equal(await commit.persist(next, view.graph, 7), ack)
assert.equal(commit.requests[0].expectedRevision, 7, 'do not silently rebase the confirmed deletion onto another revision')
assert.equal(commit.saved.length, 1)
commit = persistHarness(ack, { resultView: allView, currentResultRef: { current: allView } })
assert.equal(await commit.persist(allNext, allView.graph, 7), ack)
assert.deepEqual(Array.from(commit.requests[0].graph.nodes), [], 'complete-view deletion must not upload unchanged nodes')
assert.deepEqual(Array.from(commit.requests[0].baseNodeIds), ['toc-a', 'toc-b'])
assert.equal(commit.requests[0].graph.edges.length, 0)
assert.deepEqual(Array.from(commit.requests[0].baseEdgeKeys), ['toc-a>concept:transfers_from'])
let editedView = helpers.makeView(helpers.asAllNodesGraph(allNext), sourceText)
commit = persistHarness(ack, { resultView: allView, currentResultRef: { current: editedView },
  graphRevisionRef: { current: 7 },
  setResultView: updater => { editedView = typeof updater === 'function' ? updater(editedView) : updater },
})
await commit.persist(allNext, allView.graph)
assert.equal(editedView.graph.view.kind, 'all')
assert.equal(editedView.graph.view.totalNodes, 2, 'complete view count must follow a saved deletion')
assert.equal(editedView.graph.revision, 8, 'complete view must carry the acknowledged revision')
commit = persistHarness(ack, { currentResultRef: { current: null } })
await commit.persist(next, view.graph, 7)
assert.equal(commit.env.graphRevisionRef.current, 12, 'a late reply must not overwrite the newly selected document revision')
assert.equal(commit.saved.length, 0)

function request(handler, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    Object.assign(req, { method: 'POST', url: '/api/dsh-knowledge-graph/' + endpoint, headers: {} })
    const res = { setHeader() {}, writeHead() {}, end(value) { resolve(JSON.parse(value || '{}')) } }
    handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
const dir = mkdtempSync(join(tmpdir(), 'kg-paragraph-remove-'))
const dbPath = join(dir, 'test.sqlite')
process.env.DSH_KG_DB = dbPath
try {
  let store = await openSqliteStore(dbPath)
  store.saveGraph(graph, { sourceText })
  store.close()
  const routes = []
  persistentHost.apply({ get: name => name === 'webServer' ? { register(spec) { routes.push(spec); return () => {} } } : null, effect: fn => fn(), interval: () => () => {} })
  const api = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  const before = await request(api, 'document-load', { documentId, nodeLimit: 2 })
  assert.equal(before.graph.nodes.length, 2)
  assert.equal(before.graph.edges.length, 0, 'cross-window edge must not be in the client payload')
  const edited = helpers.removeParagraphType(helpers.makeView(before.graph, sourceText), 1, 'memory_material')
  const payload = { documentId, expectedRevision: before.revision, graph: edited, baseNodeIds: ids(before.graph.nodes), baseEdgeKeys: [] }
  const committed = await request(api, 'graph-commit', payload)
  assert(!committed.error, JSON.stringify(committed.error))
  assert.equal(committed.revision, 2)
  const stale = await request(api, 'graph-commit', payload)
  assert.equal(stale.error?.code, 'revision_conflict')
  const reloaded = await request(api, 'document-load', { documentId })
  assert.deepEqual(ids(reloaded.graph.nodes).sort(), ['author', 'concept'])
  assert.equal(reloaded.graph.edges.length, 1, 'remove incident edges even outside the edited window')
  assert.equal(reloaded.sourceText, sourceText, 'preserve source paragraphs and their numbering')
  assert.equal(reloaded.graph.graphOntology.id, 'learning-view-v1')
  assert.equal(reloaded.graph.verification.auditLog.length, 2)
  assert.equal(reloaded.graph.verification.stale, true)
  store = await openSqliteStore(dbPath)
  assert.deepEqual(ids(store.getDocument(documentId).nodes).sort(), ['author', 'concept'], 'a new DB connection must see the deletion')
  const restored = store.restoreRevision(documentId, 1, 2)
  assert(!restored.error, JSON.stringify(restored.error))
  assert.deepEqual(ids(store.getDocument(documentId).nodes).sort(), ids(graph.nodes).sort(), 'retain the pre-edit revision for recovery')
  store.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log('paragraph removal: anchors, selective deletion, cancellation, failures, stale views, CAS, cross-window edges, persistence and revision recovery passed')
