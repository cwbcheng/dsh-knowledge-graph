import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: modelStructureFixture() })
const server = createServer((request, response) => harness.handler(request, response))
const query = createGraphContract().connectionModels
let httpRequests = 0, conflictingModes = 0
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const document = harness.store.getCanonicalDocument(harness.document.documentId)
  const snapshot = JSON.stringify(document)
  const base = { documentId: document.documentId, expectedRevision: document.revision }
  const compare = { modelId: 'taxi', compareModelId: 'multi' }
  const post = async options => {
    httpRequests++
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, ...options }),
    })
    assert.equal(response.status, 200, 'Conflicting read modes must return an explicit input error rather than HTTP 500')
    const value = await response.json()
    const current = options.documentId && options.documentId !== document.documentId ? null : document
    assert.deepEqual(value, query(current, { ...base, ...options }), 'Persistent Host and source contract must agree in every field')
    return value
  }
  const modes = ['diagnosis', 'structureSources', 'concepts']
  for (let bits = 1; bits < 8; bits++) {
    const flags = Object.fromEntries(modes.map((name, index) => [name, !!(bits & (1 << index))]))
    for (const structureEdit of [false, true]) {
      const value = await post({ ...compare, ...flags, structureEdit })
      assert.equal(value.error?.code, 'invalid_input', 'Comparison may not be silently replaced by a diagnosis, source or concept result')
      assert.equal(value.left, undefined); assert.equal(value.items, undefined); assert.equal(value.diagnosis, undefined)
      conflictingModes++
    }
  }
  const independent = [
    {}, { modelId: 'taxi' }, { modelId: 'taxi', diagnosis: true },
    { modelId: 'taxi', structureSources: true }, { concepts: true },
    compare, { ...compare, structureEdit: true },
    { ...compare, diagnosis: false, structureSources: false, concepts: false },
    { ...compare, diagnosis: 'true', structureSources: 1, concepts: null },
    { modelId: 'taxi', compareModelId: '', diagnosis: true },
    { modelId: 'taxi', compareModelId: '', structureSources: true },
    { compareModelId: '', concepts: true },
  ]
  for (const options of independent) assert.equal((await post(options)).error, undefined)
  const paired = await post({ ...compare, structureEdit: true })
  assert.equal(paired.equivalence, 'not_inferred')
  assert.equal(paired.left.structure.origin, 'reviewed_structure_not_verified_truth')
  assert.deepEqual(paired.left.modelStructure, document.graph.nodes.find(node => node.id === 'taxi').modelStructure)
  assert.deepEqual(paired.left.ports.map(port => [port.slotId, port.node.nodeId, port.role]),
    [['distance-slot', 'distance', 'input'], ['fare-slot', 'fare', 'output']])
  assert.equal(paired.left.structure.branches[0].condition.text, '0 <= 行驶距离 <= 3 km')
  assert.equal(paired.left.structure.branches[0].condition.provenance.quote, document.sourceUnits[0].text)
  assert.equal((await post({ ...compare, diagnosis: true, expectedRevision: 0 })).error.code, 'revision_conflict')
  assert.equal((await post({ ...compare, diagnosis: true, documentId: 'missing' })).error.code, 'not_found')
  for (const flags of [{ diagnosis: true }, { structureSources: true }, { concepts: true }]) {
    assert.equal((await post({ ...compare, ...flags, chainDraft: {} })).error.code, 'invalid_chain_draft', 'Existing chain query validation keeps its precedence')
  }
  assert.equal(JSON.stringify(document), snapshot, 'Source contract reads cannot mutate the canonical input')
  assert.equal(JSON.stringify(harness.store.getCanonicalDocument(document.documentId)), snapshot, 'HTTP reads cannot write graph structure, conditions or evidence')
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop()
}
console.log(JSON.stringify({ ok: true, actualHostHttp: true, conflictingModes, httpRequests,
  independentQueries: true, fullConditionsEvidenceAndIdentity: true, revisionAndChainValidation: true, readOnly: true }))
