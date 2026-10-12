import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelPrivateNameFixture, privateNameRequests, privateNameModes, privateNameIndexWork } from './kg-model-private-name-index-fixture.mjs'

const query = createGraphContract().connectionModels
const args = extra => ({ expectedRevision: 1, modelId: 'multi', ...extra }), measurements = []
for (const models of [32, 8192]) {
  const document = modelPrivateNameFixture({ models }), before = JSON.stringify(document)
  for (const conceptNames of privateNameRequests) {
    const options = args({ conceptNames }), expected = query(document, options)
    assert.deepEqual(expected, { documentId: document.documentId, revision: 1, modelId: 'multi',
      modelConceptNamesVersion: 1, conceptIds: [...conceptNames],
      items: conceptNames.map(nodeId => ({ nodeId, text: document.graph.nodes.find(n => n.id === nodeId).text })) })
    const work = privateNameIndexWork(query, document, options, expected)
    assert.equal(work.graphIndexEntries, conceptNames.length + 1, 'Private name reads must index only the bound model and requested literal IDs')
    assert.equal(work.nodeVisits, document.graph.nodes.length, 'Keep all identity reads and last-record-wins validation')
    assert.equal(work.edgeVisits, 0); assert.equal(work.sourceUnitVisits, 0)
    measurements.push({ nodes: document.graph.nodes.length, requestedIds: conceptNames.length, ...work })
  }
  assert.equal(JSON.stringify(document), before)
}
const duplicate = modelPrivateNameFixture(), concept = duplicate.graph.nodes.find(n => n.id === '__proto__')
duplicate.graph.nodes.push({ ...concept, text: '最后一条同身份概念' })
assert.deepEqual(query(duplicate, args({ conceptNames: ['__proto__', '__PROTO__'] })).items,
  [{ nodeId: '__proto__', text: '最后一条同身份概念' }, { nodeId: '__PROTO__', text: '同名目录概念' }])
duplicate.graph.nodes.push({ ...concept, state: 'rejected' })
assert.deepEqual(query(duplicate, args({ conceptNames: ['__proto__'] })).items, [])
duplicate.graph.nodes.push({ ...concept, id: 'multi', type: 'concept' })
assert.equal(query(duplicate, args({ conceptNames: [] })).error.code, 'not_found', 'Empty requests still validate the last bound-model record')

for (const kind of ['null', 'undefined', 'sparse']) {
  const document = modelPrivateNameFixture()
  if (kind === 'sparse') document.graph.nodes.length += 1
  else document.graph.nodes.push(kind === 'null' ? null : undefined)
  for (const extra of [{ conceptNames: [] }, { conceptNames: ['missing'], modelId: 'missing' }])
    assert.throws(() => query(document, args(extra)), error => error instanceof TypeError && error.message ===
      (kind === 'sparse' ? 'Iterator value undefined is not an entry object' : `Cannot read properties of ${kind} (reading 'id')`))
  assert.equal(query(document, args({ conceptNames: null })).error.code, 'invalid_input')
  assert.equal(query(document, args({ conceptNames: [], expectedRevision: 0 })).error.code, 'revision_conflict')
}
// An unrelated node's identity remains observable exactly once and in input order.
const observed = modelPrivateNameFixture(), identities = [], originalIds = observed.graph.nodes.map(n => n.id)
for (const node of observed.graph.nodes) {
  const id = node.id
  Object.defineProperty(node, 'id', { configurable: true, get() { identities.push(id); return id } })
}
assert.equal(query(observed, args({ conceptNames: [] })).error, undefined)
assert.deepEqual(identities, originalIds)
const priority = modelPrivateNameFixture(); priority.graph.nodes.length += 1
assert.throws(() => query(priority, { expectedRevision: 1, conceptNames: [], get modelId() { throw new Error('Wrong model-error priority') } }),
  { name: 'TypeError', message: 'Iterator value undefined is not an entry object' })

const fixture = modelPrivateNameFixture(), harness = await modelLearningHarness({ fixture })
const server = createServer((req, res) => harness.handler(req, res))
let httpRequests = 0
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const document = harness.store.getCanonicalDocument(fixture.documentId), before = JSON.stringify(document)
  const units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
  for (const extra of privateNameModes) {
    const options = { documentId: fixture.documentId, ...args(extra) }
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) })
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), query(document, options)); httpRequests++
  }
  assert.equal(JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
  assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
console.log(JSON.stringify({ ok: true, privateNamesUseBoundedIndex: true, allIdentityReadsAndErrorPriorityPreserved: true,
  literalIdentitiesAndLastRecordWins: true, actualHostHttp: true, httpRequests, canonicalAndLearningReadOnly: true, measurements }))
