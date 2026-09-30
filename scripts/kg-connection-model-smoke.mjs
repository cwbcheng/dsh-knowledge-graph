import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'
import { connectionFixture } from './kg-connection-model-fixture-data.mjs'

const query = createGraphContract().connectionModels
const doc = connectionFixture(), original = JSON.stringify(doc)
const read = options => query(doc, { expectedRevision: 1, ...options })
assert.equal(read().items.length, 20)
assert.equal(read().totalModels, 31)
assert.equal(read({ offset: 20 }).items.length, 11)
assert.equal(read({ query: 'tail' }).items[0].nodeId, 'model-24', 'NFKC query covers the whole graph')
assert(read({ sectionId: 'second' }).items.every(item => item.sectionId === 'second'))
assert.equal(read({ expectedRevision: 0 }).error.code, 'revision_conflict')
assert.equal(query(doc, {}).error.code, 'revision_conflict', 'a version fence is required')
assert.equal(read({ modelId: 'missing' }).error.code, 'not_found')
const taxi = read({ modelId: 'taxi' })
assert.deepEqual(taxi.model.inputs.map(node => node.nodeId), ['distance'])
assert.deepEqual(taxi.model.outputs.map(node => node.nodeId), ['fare'])
assert(taxi.related.some(item => item.nodeId === 'example' && item.links[0].via === 'rule'))
assert(taxi.sourceUnits.some(unit => unit.text === doc.sourceUnits[2].text))
const unknown = read({ modelId: 'unknown' })
assert.equal(unknown.ports.length, 2)
assert(unknown.ports.every(port => port.role === 'unknown'), 'storage arrows must not supply semantic roles')
assert.equal(unknown.model.structureComplete, false)
const legacy = read({ modelId: 'legacy' })
assert.equal(legacy.ports.length, 0)
assert(legacy.related.some(item => item.type === 'factor_material'), 'legacy material endpoints remain visible but are not promoted to concepts')
const wrong = read({ modelId: 'wrong' })
assert(wrong.model.structureComplete)
assert(wrong.model.warnings.includes('文本涉及错误示例'), 'completeness must not certify truth')
assert(read({ modelId: 'definition' }).model.warnings.includes('可能仅为类型说明'))
assert.equal(read({ modelId: 'multi' }).model.inputs.length, 2)
assert(read({ conceptId: 'distance', role: 'input' }).items.some(item => item.nodeId === 'taxi'))
assert(!read({ conceptId: 'distance', role: 'output' }).items.some(item => item.nodeId === 'taxi'))
assert(read({ conceptId: 'distance', role: 'unknown' }).items.some(item => item.nodeId === 'unknown'))
const foreign = structuredClone(doc)
foreign.graph.nodes.find(node => node.id === 'taxi').evidence[0].documentId = 'foreign'
delete foreign.graph.nodes.find(node => node.id === 'taxi').quote
assert.equal(query(foreign, { expectedRevision: 1, modelId: 'taxi' }).model.citations.length, 0)
const units = structuredClone(doc)
units.sourceUnits[0].text = 'Authoritative source changed.'
assert.equal(query(units, { expectedRevision: 1, modelId: 'taxi' }).model.citations.length, 0, 'stored units outrank legacy text')
const invalid = structuredClone(doc)
invalid.graph.edges[0].fromNodeId = 'distance'; invalid.graph.edges[0].toNodeId = 'taxi'
assert.equal(query(invalid, { expectedRevision: 1, modelId: 'taxi' }).ports[0].role, 'unknown')
const sameConcept = structuredClone(doc)
sameConcept.graph.edges.push({ fromNodeId: 'multi', toNodeId: 'speed', relation: 'maps_between', role: 'output' })
const slots = query(sameConcept, { expectedRevision: 1, modelId: 'multi' }).ports.filter(port => port.node.nodeId === 'speed')
assert.equal(slots.length, 2, 'same concept in two roles must retain both slots')
assert(slots.every(port => !port.editable), 'ambiguous identities must not offer a direction editor')
assert.equal(JSON.stringify(doc), original, 'browsing must not mutate canonical data')

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const production = (start, end) => {
  const from = client.indexOf(start), to = client.indexOf(end, from)
  assert(from >= 0 && to > from, 'Production code boundaries must exist')
  return client.slice(from, to)
}
const edgeKey = edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation
// Execute the shipped identity and commit helpers, not a test replacement.
const { patch, controller } = new Function(`
  ${production('      const edgeKeyOf =', '      function edgeIndexForIssue(')}
  ${production('      function connectionRolePatch(', '      function ConnectionModelPanel(')}
  ${production('      function documentIdOfGraph(', '      function graphViewMetadata(')}
  ${production('      function asAllNodesGraph(', '      function historyMetadata(')}
  ${production('      function semanticOperationsOf(', '      function carrySemanticOperations(')}
  const graphSemanticOperations = new WeakMap()
  return { patch: connectionRolePatch, controller(state, host) {
    const { resultView, graphCommitQueueRef, currentResultRef, graphRevisionRef, verifyBusyRef } = state
    const generationTaskActive = false, questionPhase = '', fullText = resultView.sourceText
    const makeView = (graph, sourceText) => ({ graph, sourceText })
    const setResultView = view => { state.savedView = view; currentResultRef.current = view }
    const setVerification = value => { state.verification = value }
    const setQuestionResult = value => { state.questionResult = value }
    ${production('        const reviewConnectionRoles =', '        const reviewConnectionModel =')}
    return reviewConnectionRoles
  } }
`)()
const changes = Object.fromEntries(unknown.ports.map(port => [port.edgeKey, port.node.nodeId === 'distance' ? 'input' : 'output']))
const planned = patch(doc.graph, 'unknown', changes)
assert.equal(planned.diff.length, 2)
assert.equal(planned.graph.edges[4].role, 'input')
assert.deepEqual(planned.graph.edges[4].evidence, doc.graph.edges[4].evidence)
assert.equal(planned.graph.nodes, doc.graph.nodes, 'direction review must not rewrite concepts')
const audited = patch({ ...doc.graph, verification: { stale: false, lastReport: { reportId: 'old' } }, factCheck: { stale: false } }, 'unknown', changes)
assert.equal(audited.graph.verification.stale, true, 'old reports cannot certify an edited relation')
assert.equal(audited.graph.factCheck.stale, true)
assert.throws(() => patch(doc.graph, 'unknown', { 'taxi>fare:maps_between': 'output' }), /身份不明确/)
assert.throws(() => patch(sameConcept.graph, 'multi', { 'multi>speed:maps_between': 'output' }), /身份不明确/, 'ambiguous edge keys cannot be silently merged')
assert.throws(() => patch(doc.graph, 'unknown', { 'unknown>fare:maps_between': 'positive' }), /身份不明确/)
assert.equal(JSON.stringify(doc), original)

const directory = mkdtempSync(join(tmpdir(), 'kg-connection-model-'))
const previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(directory, 'isolated.sqlite')
try {
  const store = await openSqliteStore(process.env.DSH_KG_DB)
  // The legacy invalid edge is a browsing fixture, not a new canonical mutation.
  const graph = structuredClone(doc.graph)
  graph.edges = graph.edges.filter(edge => edge.relation !== 'states_variable')
  store.saveGraph(graph, { sourceText: doc.sourceText, sourceUnits: doc.sourceUnits })
  const stored = store.getDocument(doc.documentId)
  const routes = []
  const persistent = await import('../lib/index.js')
  persistent.apply({ get: name => name === 'webServer' ? { register: route => { routes.push(route); return () => {} } } : null,
    effect: fn => fn(), interval: () => () => {} })
  const route = routes.find(item => item.path === '/api/dsh-knowledge-graph')
  const post = (method, body) => new Promise((resolve, reject) => {
    const req = new EventEmitter(); req.method = 'POST'; req.url = '/api/dsh-knowledge-graph/' + method; req.headers = {}
    const res = { setHeader() {}, writeHead() {}, end(data) { try { resolve(JSON.parse(data)) } catch (error) { reject(error) } } }
    route.handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
  const http = await post('connection-models', { documentId: doc.documentId, expectedRevision: 1, modelId: 'taxi' })
  assert.equal(http.model.nodeId, 'taxi')
  assert.equal(http.model.inputs[0].nodeId, 'distance')
  assert.equal((await post('connection-models', { documentId: doc.documentId, expectedRevision: 0 })).error.code, 'revision_conflict')
  assert.equal((await post('connection-models', { documentId: 'missing', expectedRevision: 1 })).error.code, 'not_found')
  assert.equal(store.getDocumentRevision(doc.documentId), 1)
  const resultView = { graph: stored, sourceText: doc.sourceText }
  const state = { resultView, currentResultRef: { current: resultView }, graphCommitQueueRef: { current: Promise.resolve() },
    graphRevisionRef: { current: 1 }, verifyBusyRef: { current: false } }
  const calls = []
  const review = controller(state, { call: (method, args) => { calls.push({ method, args }); return post(method, args) } })
  const currentUnknown = await post('connection-models', { documentId: doc.documentId, expectedRevision: 1, modelId: 'unknown' })
  const currentChanges = Object.fromEntries(currentUnknown.ports.map(port => [port.edgeKey, port.node.nodeId === 'distance' ? 'input' : 'output']))
  const preview = await review({ modelId: 'unknown', revision: 1, changes: currentChanges })
  assert.equal(preview.diff.length, 2)
  assert(preview.signature)
  assert.deepEqual(calls.map(call => call.method), ['document-export', 'graph-commit-preview'])
  const request = calls[1].args
  assert.equal(request.graph.nodes.length, 0, 'the real controller must submit only changed identities')
  assert.deepEqual(request.graph.edges.map(edgeKey).sort(), Object.keys(currentChanges).sort())
  assert.equal(store.getDocumentRevision(doc.documentId), 1, 'preview is read-only')
  await assert.rejects(review({ modelId: 'unknown', revision: 1, changes: { ...currentChanges, [currentUnknown.ports[0].edgeKey]: 'output' }, preview }), /重新预览/)
  assert.equal(store.getDocumentRevision(doc.documentId), 1, 'changed drafts cannot reuse old approval')
  const saved = await review({ modelId: 'unknown', revision: 1, changes: currentChanges, preview })
  assert.equal(saved.revision, 2, JSON.stringify(saved.error))
  assert.equal(state.graphRevisionRef.current, 2)
  assert(state.savedView.graph.edges.some(edge => edge.fromNodeId === 'unknown' && edge.role === 'input'))
  const refreshed = await post('connection-models', { documentId: doc.documentId, expectedRevision: 2, modelId: 'unknown' })
  assert.equal(refreshed.model.structureComplete, true, 'persisted roles must survive canonical readback')
  assert.equal((await post('graph-commit', request)).error.code, 'revision_conflict', 'stale approval cannot overwrite another edit')
  assert.equal(store.getDocument(doc.documentId).nodes.length, stored.nodes.length)
  assert.equal(store.getDocument(doc.documentId).sourceText, stored.sourceText)
  store.close()
} finally {
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(directory, { recursive: true, force: true })
}
const large = structuredClone(doc)
large.graph.nodes.push(...Array.from({ length: 5000 }, (_, index) => ({ id: 'unused-' + index, type: 'concept', text: 'Unrelated ' + index })))
large.graph.edges.push(...Array.from({ length: 8500 }, (_, index) => ({ fromNodeId: 'unused-' + (index % 4999), toNodeId: 'unused-' + ((index % 4999) + 1), relation: 'extension_relation' })))
const started = performance.now()
const response = query(large, { expectedRevision: 1, query: 'tail' })
assert.equal(response.items[0].nodeId, 'model-24')
assert(JSON.stringify(response).length < 30000, 'directory must not ship the full graph')
console.log(JSON.stringify({ ok: true, readOnly: true, canonicalRoleCommit: true, productionController: true, staleCommitRejected: true,
  wholeGraphSearch: true, multiInput: true, wrongModelWarning: true, largeMs: Math.round(performance.now() - started) }))
