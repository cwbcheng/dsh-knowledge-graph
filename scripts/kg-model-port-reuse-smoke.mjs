import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelPortReuseFixture } from './kg-model-port-reuse-fixture-data.mjs'

const query = createGraphContract().connectionModels
const modes = [{}, { diagnosis: true }, { structureSources: true }, { compareModelId: 'right' }]
const read = (document, options = {}) => query(document, { expectedRevision: document.revision, modelId: 'left', ...options })
const measurements = []
for (const structured of [false, true]) {
  const document = modelPortReuseFixture({ structured }), before = JSON.stringify(document)
  for (const mode of modes) {
    const expected = read(document, mode)
    assert(!expected.error, JSON.stringify(expected.error))
    const chunks = document.graph.staging.chunks, find = chunks.find
    let scans = 0
    // Count real source resolution work; the native search and response are unchanged.
    chunks.find = function (...args) { scans++; return find.apply(this, args) }
    try { assert.deepEqual(read(document, mode), expected) }
    finally { delete chunks.find }
    const models = mode.compareModelId ? 2 : 1
    assert(scans <= models * (40 * 52 + 100), 'Endpoint citation work must not multiply for detail, diagnosis and summary consumers')
    measurements.push({ structured, mode, scans })
  }
  const detail = read(document)
  assert.equal(detail.ports.length, 40)
  assert.equal(detail.model.inputs.length, 20); assert.equal(detail.model.outputs.length, 20)
  assert.equal(detail.model.entailmentStatus, 'unverified')
  for (const [index, port] of detail.ports.entries()) {
    assert.equal(port.node.nodeId, 'port-' + index)
    assert.equal(port.role, index % 2 ? 'output' : 'input')
    assert.deepEqual(port.node.citations.map(({ paragraph, quote }) => ({ paragraph, quote })),
      document.sourceUnits.slice(-8).map(({ paragraph, text }) => ({ paragraph, quote: text })))
  }
  if (structured) {
    assert.equal(detail.structure.identity, 'hypothesis')
    assert.deepEqual(detail.structure.branches[0].condition, document.graph.nodes.at(-2).modelStructure.branches[0].condition)
    assert.deepEqual(detail.structure.branches[0].boundary, document.graph.nodes.at(-2).modelStructure.branches[0].boundary)
    assert.equal(detail.structure.origin, 'reviewed_structure_not_verified_truth')
    assert(detail.legacyPorts.every(port => port.citations.every(citation => citation.documentId === document.documentId
      && citation.revision === 1 && citation.chunkId === 'part-' + citation.paragraph)))
  }
  assert.equal(JSON.stringify(document), before, 'Projection never edits canonical nodes, roles, conditions or evidence')
  detail.ports[0].node.text = 'Caller-only change'
  assert.equal(read(document).ports[0].node.text, '端点 0', 'Returned references cannot persist across requests')

  const left = document.graph.nodes.find(node => node.id === 'left')
  document.graph.edges.find(edge => edge.fromNodeId === 'left').role = 'unknown'
  if (structured) left.modelStructure.slots[0].role = 'unknown'
  assert.equal(read(document).ports[0].role, 'unknown', 'Even the same object and revision must be re-read on a new call')
  const comparison = read(document, { compareModelId: 'right' })
  assert(comparison.shared.find(item => item.node.nodeId === 'port-0').uncertain, 'Independent models retain different explicit roles')
  document.revision = 2
  document.graph.nodes[0].text = 'Changed canonical concept'
  if (structured) left.modelStructure.slots[0].label = 'Changed canonical slot'
  assert.equal(read(document).ports[0].node.text, structured ? 'Changed canonical slot' : 'Changed canonical concept')
  assert.equal(read(document, { expectedRevision: 1 }).error.code, 'revision_conflict')
  if (structured) {
    left.modelStructure.slots[0].conceptId = 'missing-concept'
    assert.equal(read(document).model.hasStructure, false, 'Invalid structure falls back to the current canonical edges')
    assert(read(document).model.warnings.some(warning => warning.startsWith('结构记录需重新核对')))
  }
}

const catalogue = modelPortReuseFixture({ chunks: 64 }), template = catalogue.graph.nodes.find(node => node.id === 'left')
const templateEdges = catalogue.graph.edges.filter(edge => edge.fromNodeId === 'left')
catalogue.graph.nodes = catalogue.graph.nodes.filter(node => node.type === 'concept'); catalogue.graph.edges = []
for (let index = 0; index < 128; index++) {
  const model = structuredClone(template); model.id = 'catalogue-' + index
  catalogue.graph.nodes.push(model)
  catalogue.graph.edges.push(...templateEdges.map(edge => ({ ...structuredClone(edge), fromNodeId: model.id })))
}
const catalogueBefore = JSON.stringify(catalogue), set = Map.prototype.set
let retainedEndpoints = 0
// Observe endpoint projections retained in request-local maps during the full directory read.
Map.prototype.set = function (key, value) {
  if (key?.type === 'connection_model' && Array.isArray(value)) retainedEndpoints += value.length
  return set.call(this, key, value)
}
try { assert.equal(query(catalogue, { expectedRevision: 1 }).total, 128) }
finally { Map.prototype.set = set }
assert.equal(retainedEndpoints, 0, 'A full catalogue query must not retain per-model endpoint projection caches')
assert.equal(JSON.stringify(catalogue), catalogueBefore)

const fixture = modelPortReuseFixture({ chunks: 64 }), harness = await modelLearningHarness({ fixture })
const server = createServer((req, res) => harness.handler(req, res))
let httpRequests = 0
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const canonical = harness.store.getCanonicalDocument(fixture.documentId), before = JSON.stringify(canonical)
  const post = async options => {
    httpRequests++
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: fixture.documentId, expectedRevision: 1, modelId: 'left', ...options }),
    })
    assert.equal(response.status, 200); return response.json()
  }
  for (const mode of [...modes, { structureEdit: true }, { structureSources: true, sourceOffset: 3 }]) {
    assert.deepEqual(await post(mode), read(canonical, mode), 'Generated persistent Host HTTP must equal the source contract in every field')
  }
  assert.equal((await post({ expectedRevision: 0 })).error.code, 'revision_conflict')
  assert.equal(JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId)), before)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop()
}
console.log(JSON.stringify({ ok: true, endpointCitationBudget: true, measurements, catalogueModels: 128, retainedEndpoints, independentRequestsAndModels: true,
  revisionConflict: true, invalidStructureFallback: true, fullConditionsEvidenceAndIdentity: true, actualHostHttp: true, httpRequests, readOnly: true }))
