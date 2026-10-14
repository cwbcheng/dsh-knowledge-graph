import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { modelSummarySignaturesFixture, summarySignaturesWork } from './kg-model-summary-signatures-fixture.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'

const contract = createGraphContract(), read = (document, options = {}) => contract.connectionModels(document,
  { expectedRevision: document.revision, ...options })
const rows = []
for (const endpoints of [39, 40, 256, 1024]) {
  const document = modelSummarySignaturesFixture({ endpoints }), before = JSON.stringify(document)
  for (const options of [{}, { offset: 15 }, { query: 'absent' }, { needsReview: true }]) {
    const expected = read(document, options), work = summarySignaturesWork(read, document, options, expected)
    assert.equal(expected.totalModels, 16)
    if (endpoints !== 40) {
      assert.equal(work.sortValues, 16 * 40, 'Only the small slot signature is sorted when counts already differ')
      assert.equal(work.jsonCalls, 0, 'No signature arrays are serialized when unequal lengths already prove a difference')
    } else { assert.equal(work.sortValues, 16 * 80); assert.equal(work.jsonCalls, 32) }
    for (const model of expected.items) {
      assert.equal(model.warnings.includes('结构槽位与原有图谱端点并不一一对应'), endpoints !== 40)
      assert.equal(model.inputs.length, 20); assert.equal(model.outputs.length, 20)
      assert.equal(model.contentIdentity, 'hypothesis'); assert.equal(model.entailmentStatus, 'unverified')
      assert.equal(model.inputs[0].citations.length, 8)
    }
    rows.push({ endpoints, options, ...work })
  }
  assert.equal(JSON.stringify(document), before)
}
const equalLength = modelSummarySignaturesFixture({ models: 1, endpoints: 40 }), model = equalLength.graph.nodes.at(-1)
equalLength.graph.edges.reverse()
assert(!read(equalLength).items[0].warnings.includes('结构槽位与原有图谱端点并不一一对应'), 'Order alone cannot create a difference')
equalLength.graph.edges[0].role = 'input'
assert(read(equalLength).items[0].warnings.includes('结构槽位与原有图谱端点并不一一对应'), 'Equal counts still require full identity and explicit-role comparison')
equalLength.graph.edges[0].role = 'output'
model.modelStructure.slots[39].conceptId = 'port-1'
model.modelStructure.slots[39].state = '另一对象时间'
assert(read(equalLength).items[0].warnings.includes('结构槽位与原有图谱端点并不一一对应'), 'Separate slots sharing a concept keep their multiplicity')
const fixture = modelSummarySignaturesFixture({ models: 2 }), harness = await modelLearningHarness({ fixture,
  llm: { async createMessage() { throw new Error('Read-only model queries must not call the model') } } })
const server = createServer((req, res) => harness.handler(req, res))
let httpRequests = 0
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const canonical = harness.store.getCanonicalDocument(fixture.documentId), before = JSON.stringify(canonical)
  for (const options of [{}, { offset: 20 }, { query: 'absent' }, { needsReview: true }, { modelId: 'catalogue-000' },
    { modelId: 'catalogue-000', diagnosis: true }, { modelId: 'catalogue-000', structureSources: true },
    { modelId: 'catalogue-000', compareModelId: 'catalogue-001' }]) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: fixture.documentId, expectedRevision: 1, ...options }) })
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), read(canonical, options)); httpRequests++
  }
  assert.equal(JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId)), before)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
console.log(JSON.stringify({ ok: true, queries: rows.length, rows, httpRequests, actualGeneratedHostSqliteHttp: true,
  equalCountsFullyCompared: true, identityRoleAndMultiplicity: true, completeSourcesAndConditions: true,
  canonicalAndLearningReadOnly: true }))
