import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelConceptEmptyFixture, emptyConceptModes, conceptSourceIndexWork } from './kg-model-concept-empty-fixture.mjs'

const query = createGraphContract().connectionModels, read = (document, options) => query(document, { expectedRevision: 1, ...options })
const measurements = []
for (const extraUnits of [32, 8192]) {
  const document = modelConceptEmptyFixture({ extraUnits }), before = JSON.stringify(document)
  for (const options of emptyConceptModes) {
    const args = { expectedRevision: 1, ...options }, expected = query(document, args)
    assert.equal(expected.error, undefined); assert.deepEqual(expected.items, [])
    const work = conceptSourceIndexWork(query, document, args, expected)
    assert.equal(work.sourceIndexEntries, 0, 'Empty concept pages must not construct an unused source Map')
    assert.equal(work.sourceIndexes, 0)
    assert.equal(work.sourceUnitVisits, document.sourceUnits.length, 'Keep source-entry reads and their existing errors')
    measurements.push({ extraUnits, options, ...work })
  }
  const options = { expectedRevision: 1, concepts: true, query: '检索概念', offset: 20 }, page = query(document, options)
  assert.equal(page.total, 128); assert.equal(page.items.length, 20)
  assert(page.items.every(item => item.citations[0].quote === document.sourceUnits[0].text && item.entailmentStatus === 'unverified'))
  assert.deepEqual(conceptSourceIndexWork(query, document, options, page), {
    sourceUnitVisits: document.sourceUnits.length, sourceIndexEntries: document.sourceUnits.length, sourceIndexes: 1 })
  assert.equal(JSON.stringify(document), before)
}
for (const kind of ['null', 'sparse']) {
  const document = modelConceptEmptyFixture()
  document.sourceUnits = kind === 'null' ? [null] : Array(3)
  if (kind === 'sparse') document.sourceUnits[0] = { paragraph: 0, text: '原文' }
  for (const options of [...emptyConceptModes, { concepts: true, query: { toString() { throw new Error('Wrong query-error priority') } } }])
    assert.throws(() => read(document, options), error => error instanceof TypeError &&
      error.message === (kind === 'null' ? "Cannot read properties of null (reading 'paragraph')" : 'Iterator value undefined is not an entry object'))
}
const rejected = modelConceptEmptyFixture()
for (const node of rejected.graph.nodes) if (node.type === 'concept') node.state = 'rejected'
assert.deepEqual(read(rejected, { concepts: true }), { documentId: rejected.documentId, revision: 1, modelStructureVersion: 1, total: 0, offset: 0, items: [] })

const fixture = modelConceptEmptyFixture(), harness = await modelLearningHarness({ fixture })
const server = createServer((req, res) => harness.handler(req, res))
let httpRequests = 0
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const document = harness.store.getCanonicalDocument(fixture.documentId), before = JSON.stringify(document)
  const units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
  for (const options of [...emptyConceptModes, { concepts: true, query: '检索概念', offset: 20 },
    { concepts: true, query: '同名目录概念' }, { concepts: true, expectedRevision: 0 },
    { concepts: true, modelId: 'taxi', compareModelId: 'multi' }, {}, { modelId: 'taxi' },
    { modelId: 'taxi', structureEdit: true }, { modelId: 'taxi', structureSources: true },
    { modelId: 'taxi', diagnosis: true }, { modelId: 'taxi', compareModelId: 'multi' }]) {
    const args = { documentId: fixture.documentId, expectedRevision: 1, ...options }
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), query(document, args)); httpRequests++
  }
  assert.equal(JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
console.log(JSON.stringify({ ok: true, emptyConceptsSkipSourceMap: true, inputReadsAndErrorPriorityPreserved: true,
  realPageCitationsValidated: true, actualHostHttp: true, httpRequests, canonicalAndLearningReadOnly: true, measurements }))
