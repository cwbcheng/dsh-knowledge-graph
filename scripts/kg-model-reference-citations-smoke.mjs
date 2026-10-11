import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import hostPlugin, { createGraphContract } from '../src/index.host.js'
import { modelReferenceCitationsFixture, modelReferenceCitationsModes } from './kg-model-reference-citations-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'

const contract = createGraphContract(), read = (document, options = {}) => contract.connectionModels(document, { expectedRevision: document.revision, ...options })
const measurements = []
for (const structured of [false, true]) for (const shared of [false, true]) for (const quotes of [0, 8, 24]) {
  const document = modelReferenceCitationsFixture({ structured, shared, quotes }), before = JSON.stringify(document)
  for (const options of modelReferenceCitationsModes.slice(0, 6)) {
    const expected = read(document, options), node = document.graph.nodes.find(node => node.id === 'port-0')
    const descriptor = Object.getOwnPropertyDescriptor(node, 'evidence'), set = Map.prototype.set
    let evidenceReads = 0, retainedConcepts = 0
    Object.defineProperty(node, 'evidence', { configurable: true, enumerable: true, get() { evidenceReads++; return descriptor.value } })
    Map.prototype.set = function(key, value) {
      if (key?.type === 'concept' && Array.isArray(value)) retainedConcepts++
      return set.call(this, key, value)
    }
    try { assert.deepEqual(read(document, options), expected) }
    finally { Object.defineProperty(node, 'evidence', descriptor); Map.prototype.set = set }
    assert.equal(expected.error, undefined)
    if (structured && quotes) {
      assert.equal(evidenceReads, 2, 'A structured canonical concept validates citations only once per selected query')
      assert.equal(retainedConcepts, shared ? 1 : 40, 'Only concepts referenced by actual structure slots are retained')
    } else assert.equal(retainedConcepts, 0, 'Legacy-only and empty citations do not populate the slot cache')
    const detail = expected.left || read(document, { modelId: 'left' })
    assert.equal(detail.ports.length, 40); assert.equal(detail.model.entailmentStatus, 'unverified')
    if (structured) {
      assert.equal(detail.structure.identity, 'hypothesis')
      assert.deepEqual(detail.structure.branches[0].condition, document.graph.nodes.find(node => node.id === 'left').modelStructure.branches[0].condition)
      if (shared) {
        assert.equal(new Set(detail.ports.map(port => port.slotId)).size, 40)
        assert.equal(new Set(detail.ports.map(port => port.node.nodeId)).size, 1)
        assert.equal(new Set(detail.ports.map(port => port.unit)).size, 40)
        assert.equal(new Set(detail.ports.map(port => port.timeState)).size, 40)
        assert(detail.model.warnings.includes('结构槽位与原有图谱端点并不一一对应'))
      }
      for (let index = 1; index < detail.ports.length; index++) {
        assert.notEqual(detail.ports[0].node.citations, detail.ports[index].node.citations)
        if (shared && quotes) assert.notEqual(detail.ports[0].node.citations[0], detail.ports[index].node.citations[0])
      }
      if (options.compareModelId && quotes) assert.notEqual(expected.left.ports[0].node.citations[0], expected.right.ports[0].node.citations[0])
    }
    assert(detail.ports.every(port => port.node.citations.length === Math.min(quotes, 8)))
    measurements.push({ structured, shared, quotes, options, evidenceReads, retainedConcepts })
  }
  for (const options of modelReferenceCitationsModes.slice(6)) {
    const set = Map.prototype.set; let retainedConcepts = 0
    Map.prototype.set = function(key, value) { if (key?.type === 'concept' && Array.isArray(value)) retainedConcepts++; return set.call(this, key, value) }
    try { read(document, options) } finally { Map.prototype.set = set }
    assert.equal(retainedConcepts, 0, 'Catalogue, concepts and invalid requests retain no slot citation cache')
  }
  assert.equal(JSON.stringify(document), before)
}

const document = modelReferenceCitationsFixture(), concept = document.graph.nodes.find(node => node.id === 'port-0')
const first = concept.evidence[0]
concept.evidence.unshift({ ...first, documentId: 'other' }, { ...first, sourceId: 'other' }, { ...first, quote: 'not in source' },
  { paragraph: 1e9, quote: 'missing' }, ...structuredClone(concept.evidence))
assert.equal(read(document, { modelId: 'left' }).ports[0].node.citations.length, 8)
const response = read(document, { modelId: 'left', compareModelId: 'right' })
response.left.ports[0].node.citations[0].quote = 'caller mutation'
assert.notEqual(response.left.ports[1].node.citations[0].quote, 'caller mutation')
assert.notEqual(response.right.ports[0].node.citations[0].quote, 'caller mutation')
assert.notEqual(read(document, { modelId: 'left' }).ports[0].node.citations[0].quote, 'caller mutation')
const overlap = { sourceId: 'other', chunkId: 'first', startParagraph: -1, endParagraph: 1e12 }
concept.evidence = concept.evidence.filter(record => record.sourceId !== 'other')
document.graph.staging.chunks.unshift(overlap)
assert.equal(read(document, { modelId: 'left' }).ports[0].node.citations.length, 0)
overlap.sourceId = document.graph.source.id
assert.equal(read(document, { modelId: 'left' }).ports[0].node.citations.length, 8)
document.sourceUnits.at(-1).text = 'same identity, changed source'
assert.equal(read(document, { modelId: 'left' }).ports[0].node.citations.length, 7)
document.sourceUnits.at(-2).text = 7
assert.throws(() => read(document, { modelId: 'left' }), TypeError)
document.revision++
assert.equal(read(document, { modelId: 'left', expectedRevision: 1 }).error.code, 'revision_conflict')

let httpRequests = 0, modelCalls = 0
for (const structured of [false, true]) {
  const fixture = modelReferenceCitationsFixture({ structured })
  const harness = await modelLearningHarness({ fixture, llm: { async createMessage() { modelCalls++; throw new Error('No model calls') } } })
  const server = createServer((req, res) => harness.handler(req, res))
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const canonical = harness.store.getCanonicalDocument(fixture.documentId), before = JSON.stringify(canonical)
    for (const options of modelReferenceCitationsModes) {
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: fixture.documentId, expectedRevision: 1, ...options }) })
      const actual = await res.json(), expected = read(canonical, options)
      assert.deepEqual(actual, expected); httpRequests++
      assert.equal(res.status, 200, 'The query route returns contract errors in its JSON envelope')
    }
    assert.equal(JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId)), before)
    assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
}

const fixture = modelReferenceCitationsFixture(), handlers = new Map(), previousHarness = globalThis.harness
try {
  globalThis.harness = { handle: (name, handler) => handlers.set(name, handler) }
  hostPlugin().apply({ get: name => name === 'kgExtractor' ? async () => structuredClone(fixture.graph) : null, interval: () => () => {} })
} finally { globalThis.harness = previousHarness }
const task = await handlers.get('extract')({ documentId: fixture.documentId, text: fixture.sourceText, title: 'Independent slot citation regression', ontology: fixture.graph.ontology })
assert.equal(task.error, undefined)
let status
for (let index = 0; index < 300; index++) {
  status = await handlers.get('task-status')({ taskId: task.taskId }); if (status.status !== 'running') break
  await new Promise(resolve => setTimeout(resolve, 5))
}
assert.equal(status.status, 'succeeded', JSON.stringify(status))
const documentId = status.result.source.documentId, loaded = await handlers.get('document-export')({ documentId, includeSourceText: true })
assert.equal(loaded.graph.nodes.filter(node => node.type === 'connection_model').length, 2)
const models = fixture.graph.nodes.filter(node => node.modelStructure)
assert(models.every(node => loaded.graph.nodes.some(item => item.id === node.id)))
const request = { documentId, expectedRevision: loaded.revision, baseNodeIds: models.map(node => node.id), baseEdgeKeys: [],
  graph: { nodes: models.map(node => ({ ...loaded.graph.nodes.find(item => item.id === node.id), modelStructure: node.modelStructure })), edges: [] } }
assert.equal((await handlers.get('graph-commit-preview')(request)).valid, true)
assert.equal((await handlers.get('graph-commit')(request)).revision, loaded.revision + 1)
const exported = await handlers.get('document-export')({ documentId, includeSourceText: true })
const dynamicDocument = { documentId, revision: exported.revision, graph: exported.graph, sourceText: exported.sourceText,
  sourceUnits: contract.splitParagraphs(exported.sourceText).map((text, paragraph) => ({ paragraph, text })) }
let dynamicQueries = 0
for (const options of modelReferenceCitationsModes) {
  assert.deepEqual(await handlers.get('connection-models')({ documentId, expectedRevision: dynamicDocument.revision, ...options }), read(dynamicDocument, options)); dynamicQueries++
}
assert.equal(read(dynamicDocument, { modelId: 'left' }).structure.slots.length, 40)
assert.equal(new Set(read(dynamicDocument, { modelId: 'left' }).ports.map(port => port.node.nodeId)).size, 1)
assert.deepEqual(await handlers.get('document-export')({ documentId, includeSourceText: true }), exported)
assert.equal(modelCalls, 0)
console.log(JSON.stringify({ ok: true, selectedQueries: measurements.length, measurements, independentSlotsAndCitationObjects: true,
  queryLocalAndNoCatalogueCache: true, sourceOrderErrorsAndSameObjectChanges: true, actualGeneratedHostHttp: true, httpRequests,
  actualDynamicRpc: true, dynamicQueries, publicPreviewAndCommit: true, canonicalAndLearningReadOnly: true, modelCalls }))
