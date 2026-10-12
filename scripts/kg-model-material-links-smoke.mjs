import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { materialLinksFixture, materialLinksModes, materialLinksQuery, materialLinksWork } from './kg-model-material-links-fixture.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'

const contract = createGraphContract(), query = (document, options) => materialLinksQuery(contract, document, options)
let boundedPages = 0
for (const structured of [false, true]) for (const materials of [25, 4096]) {
  const document = materialLinksFixture({ structured, materials, chunks: 512 }), before = JSON.stringify(document)
  for (const offset of [0, 19, 20, materials - 1, materials, materials + 5, -1, '20', Number.MAX_SAFE_INTEGER]) {
    const expected = query(document, { offset }), work = materialLinksWork(query, document, { offset }, expected)
    assert.equal(expected.relatedTotal, materials + 5)
    assert.equal(work.relatedEntries, expected.relatedTotal, 'Every distinct identity still contributes to the total and original order')
    assert.equal(work.linkArrays, expected.related.length, 'Only displayed identities need link arrays')
    assert.equal(work.constructedLinks, expected.related.reduce((sum, item) => sum + item.links.length, 0), 'Off-page material links must not be constructed')
    boundedPages++
  }
  for (const key of ['diagnosis', 'structureSources']) {
    const args = { modelId: 'left', expectedRevision: 1 }
    Object.defineProperty(args, key, { get() { return false } })
    const expected = contract.connectionModels(document, args)
    const work = materialLinksWork((doc, options) => contract.connectionModels(doc, options), document, args, expected)
    assert.equal(work.linkArrays, materials + 5, 'Accessor mode flags retain the complete original collection path')
    assert.equal(work.constructedLinks, materials + 10)
  }
  const source = query(document, { structureSources: true, offset: materials + 5 })
  assert.equal(materialLinksWork(query, document, { structureSources: true, offset: materials + 5 }, source).constructedLinks, materials + 10)
  assert.equal(source.sourceUnits.basis, 'stored_model_and_related_context_not_field_entailment')
  assert.equal(materialLinksWork(query, document, { diagnosis: true }, query(document, { diagnosis: true })).relatedEntries, 0)
  assert.equal(JSON.stringify(document), before)
}

const document = materialLinksFixture(), before = JSON.stringify(document)
const last = query(document, { offset: 64 })
assert.deepEqual(last.related.map(item => item.nodeId), ['rule-a', 'mapping-material', 'verification-material', 'example-material', 'rule-b'])
assert.deepEqual(last.related.find(item => item.nodeId === 'mapping-material').links.map(({ relation, via }) => [relation, via]),
  [['states_mapping', 'rule-a'], ['states_mapping', 'rule-b'], ['states_mapping', 'left']])
assert.deepEqual(query(document, { compareModelId: 'right', offset: 1000 }).left, query(document), 'Comparison keeps its original default page')
assert.deepEqual(query(document, { structureEdit: true, offset: 64 }).modelStructure, document.graph.nodes.find(node => node.id === 'left').modelStructure)
const mutable = query(document, { offset: 64 }); mutable.related[1].links[0].via = 'caller-only'; mutable.related[1].citations[0].quote = 'caller-only'
assert.deepEqual(query(document, { offset: 64 }), last); assert.equal(JSON.stringify(document), before)
document.graph.nodes.push({ ...structuredClone(document.graph.nodes.find(node => node.id === 'mapping-material')), text: '最后一条同身份内容' })
assert.equal(query(document, { offset: 64 }).related.find(node => node.nodeId === 'mapping-material').text, '最后一条同身份内容')
assert.equal(query(document, { expectedRevision: 0 }).error.code, 'revision_conflict')
assert.equal(query(document, { diagnosis: true, compareModelId: 'right' }).error.code, 'invalid_input')

let httpRequests = 0, modelCalls = 0
const harness = await modelLearningHarness({ fixture: materialLinksFixture(), llm: { call() { modelCalls++; throw new Error('Read-only queries cannot call a model') } } })
const canonical = harness.store.getCanonicalDocument(harness.document.documentId), canonicalBefore = JSON.stringify(canonical)
const server = createServer((req, res) => harness.handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening')
try {
  for (const { exercise, ...options } of materialLinksModes) {
    const method = exercise ? 'learning-mode' : 'connection-models'
    const args = { documentId: canonical.documentId, modelId: 'left', expectedRevision: canonical.revision, ...options, ...(exercise ? { action: 'plan', exercise } : {}) }
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/' + method,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
    assert.equal(response.status, 200)
    const expected = (exercise ? contract.learningPlan : contract.connectionModels)(canonical, JSON.parse(JSON.stringify(args)))
    const view = exercise && !expected.error ? { ...expected, tasks: expected.tasks.map(task => task.kind === 'model_prediction'
      ? { ...task, referenceCount: task.references.length, references: [] } : task) } : expected
    assert.deepEqual(await response.json(), view); httpRequests++
  }
  assert.equal(JSON.stringify(harness.store.getCanonicalDocument(canonical.documentId)), canonicalBefore)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0); assert.equal(modelCalls, 0)
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
console.log(JSON.stringify({ ok: true, boundedPages, materialPageLinksOnly: true, identityTotalAndOrder: true,
  indirectLinksAndConditions: true, httpRequests, canonicalAndLearningReadOnly: true, modelCalls }))
