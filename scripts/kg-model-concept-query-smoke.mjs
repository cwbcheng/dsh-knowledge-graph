import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelConceptQueryFixture, conceptQueryWork, conceptQueryModes } from './kg-model-concept-query-fixture.mjs'

const query = createGraphContract().connectionModels, work = []
const read = (document, options) => query(document, { expectedRevision: document.revision, ...options })
for (const models of [32, 4096]) {
  const document = modelConceptQueryFixture({ models }), before = JSON.stringify(document)
  for (const options of conceptQueryModes) {
    const args = { expectedRevision: 1, ...options }, result = query(document, args)
    const measured = conceptQueryWork(query, document, args, result)
    assert.equal(measured.indexedEdges, 0, 'Concept search/pagination must not prepare the whole relation index')
    assert.equal(measured.indexedNodes, 0, 'Concept queries do not need the model lookup Map')
    work.push({ models, options, ...measured })
  }
  const page = read(document, { concepts: true, query: '检索概念', offset: 20 })
  assert.equal(page.total, 128); assert.equal(page.items.length, 20)
  assert.deepEqual(page.items.map(node => node.nodeId), Array.from({ length: 20 }, (_, i) => 'search-concept-' + (20 + i)))
  assert(page.items.every(node => node.entailmentStatus === 'unverified' && node.citations[0].quote === document.sourceUnits[0].text))
  assert.deepEqual(read(document, { concepts: true, query: '同名目录概念' }).items.map(node => node.nodeId),
    ['__proto__', 'constructor', 'spaced/id:opaque identity', '__PROTO__'])
  assert.equal(read(document, { concepts: true, query: 'rejected-concept' }).total, 0)
  const descriptor = Object.getOwnPropertyDescriptor(document.graph, 'edges')
  Object.defineProperty(document.graph, 'edges', { configurable: true, get() { throw new Error('Concept-only query accessed relations') } })
  try { assert.deepEqual(read(document, { concepts: true, query: '检索概念', offset: 20 }), page) }
  finally { Object.defineProperty(document.graph, 'edges', descriptor) }
  assert.equal(JSON.stringify(document), before)
}

const fixture = modelConceptQueryFixture(), harness = await modelLearningHarness({ fixture })
const server = createServer((req, res) => harness.handler(req, res))
let httpRequests = 0
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const document = harness.store.getCanonicalDocument(fixture.documentId), before = JSON.stringify(document)
  const units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
  for (const options of [...conceptQueryModes, {}, { modelId: 'taxi' }, { modelId: 'taxi', structureEdit: true },
    { modelId: 'multi', conceptNames: ['__proto__'] }, { modelId: 'taxi', diagnosis: true }, { modelId: 'taxi', structureSources: true },
    { modelId: 'taxi', compareModelId: 'multi' }]) {
    const args = { documentId: fixture.documentId, expectedRevision: 1, ...options }
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), query(document, args)); httpRequests++
  }
  assert.equal(JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
console.log(JSON.stringify({ ok: true, conceptsSkipRelationPreparation: true, actualHostHttp: true, httpRequests,
  literalIdentityCitationsAndUnverifiedState: true, independentModesAndRevisionErrors: true, canonicalReadOnly: true, work }))
