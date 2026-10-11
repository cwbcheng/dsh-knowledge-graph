import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { getOntology } from '../src/kg-ontology.mjs'
import { modelMaterialPageFixture } from './kg-model-material-page-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'

const contract = createGraphContract()
const query = (document, options = {}) => contract.connectionModels(document, { modelId: 'left', expectedRevision: document.revision, ...options })
const observe = (document, options) => {
  const reads = [], descriptors = []
  for (const node of document.graph.nodes.filter(node => !['concept', 'connection_model'].includes(node.type))) {
    const descriptor = Object.getOwnPropertyDescriptor(node, 'evidence')
    descriptors.push([node, descriptor])
    Object.defineProperty(node, 'evidence', { configurable: true, enumerable: true, get() { reads.push(node.id); return descriptor.value } })
  }
  let result
  try { result = query(document, options) }
  finally { for (const [node, descriptor] of descriptors) Object.defineProperty(node, 'evidence', descriptor) }
  return { result, reads }
}
let boundedQueries = 0
for (const structured of [false, true]) for (const materials of [25, 4096]) {
  const document = modelMaterialPageFixture({ structured, materials, chunks: 512 }), before = JSON.stringify(document)
  for (const offset of [0, 20, materials - 1, materials, -1, '20']) {
    const { result, reads } = observe(document, { offset })
    assert.equal(result.relatedTotal, materials)
    const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
    const expected = Array.from({ length: Math.max(0, Math.min(20, materials - start)) }, (_, index) => 'material-' + (start + index))
    // Citation validation reads the evidence once for its array guard and once for its records.
    assert.equal(reads.length, expected.length * 2, 'Only displayed material identities may resolve evidence')
    assert.deepEqual(reads, expected.flatMap(id => [id, id]))
    assert.deepEqual(result.related.map(node => node.nodeId), expected)
    for (const node of result.related) {
      assert.equal(node.citations.length, 8); assert.equal(node.state, 'candidate'); assert.equal(node.entailmentStatus, 'unverified')
      assert(!('node' in node), 'Canonical objects must not leak into returned projections')
      assert(node.citations.every(citation => citation.nodeId === node.nodeId && citation.sourceId === document.graph.source.id))
      assert.deepEqual(node.links.map(link => [link.relation, link.via]), [['builds', 'left']])
    }
    if (structured) assert.deepEqual(result.structure.branches[0].condition, document.graph.nodes.find(node => node.id === 'left').modelStructure.branches[0].condition)
    boundedQueries++
  }
  for (const options of [{ diagnosis: true }, { diagnosis: true, structureSources: true }]) {
    const { result, reads } = observe(document, options)
    assert.equal(reads.length, 0, 'Diagnosis does not display or validate related-material references')
    assert(result.diagnosis); boundedQueries++
  }
  const source = observe(document, { structureSources: true })
  assert.equal(source.reads.length, materials * 2, 'Full source selection still resolves every related material')
  assert.equal(source.result.sourceUnits.basis, 'stored_model_and_related_context_not_field_entailment')
  assert.equal(JSON.stringify(document), before, 'Reading cannot change canonical data or evidence')
}

const document = modelMaterialPageFixture({ materials: 64, distributed: true, rules: true }), before = JSON.stringify(document)
const labels = new Map(getOntology(document.graph.ontology).relationTypes.map(item => [item.id, item.zh]))
const last = query(document, { offset: 64 })
assert.deepEqual(last.related.map(item => item.nodeId), ['rule-a', 'mapping-material', 'verification-material', 'example-material', 'rule-b'])
for (const [id, relation, finalLink] of [['mapping-material', 'states_mapping', ['states_mapping', 'left']],
  ['verification-material', 'verifies', null], ['example-material', 'exemplifies', ['builds', 'left']]]) {
  const item = last.related.find(node => node.nodeId === id)
  assert.deepEqual(item.links.map(link => [link.relation, link.via]), [[relation, 'rule-a'], [relation, 'rule-b'], ...(finalLink ? [finalLink] : [])])
  assert(item.links.every(link => link.label === labels.get(link.relation)), 'Multiple rule and direct links keep their original labels and order')
}
const sourceUnits = [], sourceTotal = query(document, { structureSources: true }).sourceUnits.total
for (let sourceOffset = 0; sourceOffset < sourceTotal; sourceOffset += 12) sourceUnits.push(...query(document, { structureSources: true, sourceOffset }).sourceUnits.items)
assert.deepEqual(sourceUnits.map(({ paragraph, text }) => ({ paragraph, text })), document.sourceUnits, 'All sparse source contexts, including materials after the first page, remain available')
const first = query(document)
first.related[0].text = 'Caller-only change'; first.related[0].citations[0].quote = 'Caller-only quote'; first.related[0].links.push({ relation: 'caller-only' })
assert.equal(JSON.stringify(document), before)
assert.equal(query(document).related[0].links.length, 1, 'Related projections are never reused across requests')
document.graph.nodes.find(node => node.id === 'material-40').text = '当前 canonical 身份的新文字'
assert.equal(query(document, { offset: 40 }).related[0].text, '当前 canonical 身份的新文字')
document.revision = 2
assert.equal(query(document, { expectedRevision: 1 }).error.code, 'revision_conflict')
assert.equal(query(document, { offset: 40 }).revision, 2)

const fixture = modelMaterialPageFixture({ materials: 64, distributed: true, rules: true })
let modelCalls = 0, httpRequests = 0
const harness = await modelLearningHarness({ fixture, llm: { call() { modelCalls++; throw new Error('Read-only model queries cannot call a model') } } })
const canonical = harness.store.getCanonicalDocument(fixture.documentId), canonicalBefore = JSON.stringify(canonical)
const server = createServer((req, res) => harness.handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening')
try {
  for (const options of [{}, { offset: 20 }, { offset: 64 }, { offset: 69 }, { structureEdit: true }, { diagnosis: true },
    { structureSources: true }, { structureSources: true, sourceOffset: 48 }, { compareModelId: 'right' }, { expectedRevision: 0 }]) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: fixture.documentId, modelId: 'left', expectedRevision: 1, ...options }),
    })
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), query(canonical, options)); httpRequests++
  }
  assert.equal(JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId)), canonicalBefore)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  assert.equal(modelCalls, 0)
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
console.log(JSON.stringify({ ok: true, boundedQueries, materialLimit: 20, diagnosisMaterialProjections: 0,
  fullSourceContexts: sourceTotal, indirectAndDirectLinks: true, httpRequests, canonicalAndLearningReadOnly: true, modelCalls }))
