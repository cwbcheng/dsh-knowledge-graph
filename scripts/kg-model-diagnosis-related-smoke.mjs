import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { diagnosisRelatedFixture, diagnosisRelatedModes, diagnosisRelatedQuery, diagnosisRelatedWork } from './kg-model-diagnosis-related-fixture.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'

const contract = createGraphContract(), query = (document, options) => diagnosisRelatedQuery(contract, document, options)
let diagnosed = 0
for (const structured of [false, true]) for (const materials of [25, 4096]) {
  const document = diagnosisRelatedFixture({ structured, materials, chunks: 512 }), before = JSON.stringify(document)
  for (const options of [{ diagnosis: true }, { diagnosis: true, diagnosisOffset: 20 }, { diagnosis: true, structureSources: true }]) {
    const expected = query(document, options)
    assert(expected.diagnosis); assert.equal(expected.related, undefined)
    const work = diagnosisRelatedWork(query, document, options, expected)
    assert.equal(work.relatedEntries, 0, 'Diagnosis must not collect unused canonical material entries or their links')
    diagnosed++
  }
  const detail = query(document)
  assert.equal(detail.relatedTotal, materials + 5)
  assert.equal(diagnosisRelatedWork(query, document, {}, detail).relatedEntries, materials + 5, 'Material pages still collect all distinct identities and links')
  const source = query(document, { structureSources: true })
  assert.equal(diagnosisRelatedWork(query, document, { structureSources: true }, source).relatedEntries, materials + 5)
  assert.equal(source.sourceUnits.basis, 'stored_model_and_related_context_not_field_entailment')
  assert.equal(JSON.stringify(document), before)
}

const document = diagnosisRelatedFixture(), before = JSON.stringify(document)
const last = query(document, { offset: 64 })
assert.deepEqual(last.related.map(item => item.nodeId), ['rule-a', 'mapping-material', 'verification-material', 'example-material', 'rule-b'])
assert.deepEqual(last.related.find(item => item.nodeId === 'mapping-material').links.map(({ relation, via }) => [relation, via]),
  [['states_mapping', 'rule-a'], ['states_mapping', 'rule-b'], ['states_mapping', 'left']])
assert.deepEqual(last.related.find(item => item.nodeId === 'example-material').links.map(({ relation, via }) => [relation, via]),
  [['exemplifies', 'rule-a'], ['exemplifies', 'rule-b'], ['builds', 'left']])
const result = query(document, { diagnosis: true }), model = document.graph.nodes.find(node => node.id === 'left')
assert.equal(result.model.contentIdentity, 'hypothesis'); assert.equal(result.model.entailmentStatus, 'unverified')
assert(result.model.citations.length); assert(result.model.warnings.includes('假设'))
assert.deepEqual(query(document, { structureEdit: true }).modelStructure, model.modelStructure, 'Conditions, boundaries, provenance and identities are complete')
assert.equal(query(document, { diagnosis: true, branchId: 'missing' }).error.code, 'invalid_input')
assert.equal(query(document, { diagnosis: true, expectedRevision: 0 }).error.code, 'revision_conflict')
assert.equal(query(document, { diagnosis: true, compareModelId: 'right' }).error.code, 'invalid_input')
// Accessor options retain the original evaluation order and collection path.
const accessor = { modelId: 'left', expectedRevision: 1 }
let reads = 0
Object.defineProperty(accessor, 'diagnosis', { get() { reads++; return true } })
assert.deepEqual(contract.connectionModels(document, accessor), result); assert.equal(reads, 1)
assert.equal(JSON.stringify(document), before)

const throwing = diagnosisRelatedFixture(), rule = throwing.graph.nodes.find(node => node.id === 'rule-a')
let ruleReads = 0
Object.defineProperty(rule, 'type', { get() { if (++ruleReads === 2) throw new TypeError('rule traversal before diagnosis'); return 'rule' } })
assert.throws(() => query(throwing, { diagnosis: true }), /rule traversal before diagnosis/)
ruleReads = 0
const throwingOption = { modelId: 'left', expectedRevision: 1 }
Object.defineProperty(throwingOption, 'diagnosis', { get() { throw new TypeError('diagnosis option after rule traversal') } })
assert.throws(() => contract.connectionModels(throwing, throwingOption), /rule traversal before diagnosis/, 'Related rule errors still precede late diagnosis accessors')

let httpRequests = 0, modelCalls = 0
const harness = await modelLearningHarness({ fixture: diagnosisRelatedFixture(), llm: { call() { modelCalls++; throw new Error('Read-only queries cannot call a model') } } })
const canonical = harness.store.getCanonicalDocument(harness.document.documentId), canonicalBefore = JSON.stringify(canonical)
const server = createServer((req, res) => harness.handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening')
try {
  for (const { exercise, ...options } of diagnosisRelatedModes) {
    const method = exercise ? 'learning-mode' : 'connection-models'
    const args = { documentId: canonical.documentId, modelId: 'left', expectedRevision: canonical.revision, ...options, ...(exercise ? { action: 'plan', exercise } : {}) }
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/' + method,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
    assert.equal(response.status, 200)
    // Compare the actual JSON request, including omitted version fields.
    const expected = (exercise ? contract.learningPlan : contract.connectionModels)(canonical, JSON.parse(JSON.stringify(args)))
    const view = exercise && !expected.error ? { ...expected, tasks: expected.tasks.map(task => task.kind === 'model_prediction'
      ? { ...task, referenceCount: task.references.length, references: [] } : task) } : expected
    assert.deepEqual(await response.json(), view)
    httpRequests++
  }
  assert.equal(JSON.stringify(harness.store.getCanonicalDocument(canonical.documentId)), canonicalBefore)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0); assert.equal(modelCalls, 0)
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
console.log(JSON.stringify({ ok: true, diagnosed, diagnosisSkipsRelatedEntries: true, indirectLinksAndConditions: true,
  httpRequests, canonicalAndLearningReadOnly: true, modelCalls }))
