import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import hostPlugin, { createGraphContract } from '../src/index.host.js'
import { modelEndpointCitationsFixture } from './kg-model-endpoint-citations-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelMaterialPageFixture } from './kg-model-material-page-fixture-data.mjs'

const contract = createGraphContract(), measurements = []
const read = (document, options = {}) => contract.connectionModels(document, { expectedRevision: document.revision, ...options })
for (const structured of [false, true]) {
  const document = modelEndpointCitationsFixture({ structured, models: 128 }), before = JSON.stringify(document)
  for (const options of [{}, { offset: 20 }]) {
    const expected = read(document, options), chunks = document.graph.staging.chunks, find = chunks.find, set = Map.prototype.set
    let sourceLookups = 0, retainedEndpoints = 0, retainedProvenance = 0
    chunks.find = function (...args) { sourceLookups++; return find.apply(this, args) }
    Map.prototype.set = function(key, value) {
      if (key?.type === 'connection_model' && Array.isArray(value)) retainedEndpoints += value.length
      if (Number.isInteger(key) && value && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'chunkId,documentId,sourceId') retainedProvenance++
      return set.call(this, key, value)
    }
    try { assert.deepEqual(read(document, options), expected) }
    finally { delete chunks.find; Map.prototype.set = set }
    assert(sourceLookups <= 128 * (structured ? 1648 : 1288), 'A legacy endpoint must not validate the same citations twice')
    assert.equal(retainedEndpoints, 0); assert.equal(retainedProvenance, 0)
    assert.equal(expected.total, 128); assert.equal(expected.items.length, 20); assert.equal(expected.topics[0].count, 128)
    assert(expected.items.every(item => item.inputs.length === 20 && item.outputs.length === 20
      && item.state === 'candidate' && item.entailmentStatus === 'unverified'))
    for (const model of expected.items) for (const endpoint of [...model.inputs, ...model.outputs]) {
      assert.deepEqual(endpoint.citations.map(({ paragraph, quote }) => ({ paragraph, quote })),
        document.sourceUnits.slice(-8).map(({ paragraph, text }) => ({ paragraph, quote: text })))
      if (!structured) assert(endpoint.citations.every(citation => citation.sourceId === document.graph.source.id
        && citation.documentId === document.documentId && citation.revision === document.revision && citation.chunkId === 'part-' + citation.paragraph),
      'Legacy references still carry every enriched provenance field')
    }
    measurements.push({ structured, offset: expected.offset, sourceLookups, retainedEndpoints, retainedProvenance })
  }
  assert.equal(JSON.stringify(document), before)
}

// Selected queries already cache source identities; count full quote validation separately.
let selectedQueries = 0
const selectedMeasurements = []
for (const structured of [false, true]) {
  const document = modelMaterialPageFixture({ structured, materials: 25, chunks: 64, distributed: true, rules: true })
  const sourceTexts = new Set(document.sourceUnits.map(unit => unit.text)), before = JSON.stringify(document)
  for (const options of [{}, { diagnosis: true }, { structureSources: true }, { compareModelId: 'right' }]) {
    const includes = String.prototype.includes
    let quoteChecks = 0
    String.prototype.includes = function (quote, ...args) {
      if (sourceTexts.has(String(this)) && sourceTexts.has(quote)) quoteChecks++
      return includes.call(this, quote, ...args)
    }
    let response
    try { response = read(document, { modelId: 'left', ...options }) }
    finally { String.prototype.includes = includes }
    assert.equal(response.error, undefined)
    // Includes structure validation, material references and all consumers; the redundant 320 endpoint checks are absent.
    assert(quoteChecks <= (options.compareModelId ? 2 : 1) * (structured ? 1200 : 740), 'Already validated legacy references must not repeat source-text verification: ' + JSON.stringify({ structured, options, quoteChecks }))
    selectedMeasurements.push({ structured, options, quoteChecks })
    assert.deepEqual(response, read(document, { modelId: 'left', ...options }))
    const detail = options.compareModelId ? response.left : options.diagnosis || options.structureSources ? read(document, { modelId: 'left' }) : response
    assert.equal(detail.ports.length, 40); assert.equal(detail.model.entailmentStatus, 'unverified')
    if (structured) {
      assert.deepEqual(detail.structure.branches[0].condition, document.graph.nodes.find(node => node.id === 'left').modelStructure.branches[0].condition)
      assert.deepEqual(detail.structure.branches[0].boundary, document.graph.nodes.find(node => node.id === 'left').modelStructure.branches[0].boundary)
    }
    const ports = detail.legacyPorts || detail.ports
    assert(ports.every(port => port.node.citations.length === 8 && port.node.citations.every(citation => citation.documentId === document.documentId
      && citation.revision === 1 && citation.sourceId === document.graph.source.id && citation.chunkId === 'part-' + ((citation.paragraph - 7) / 1000))))
    selectedQueries++
  }
  assert.equal(JSON.stringify(document), before)
  const target = document.graph.nodes.find(node => node.id === 'port-0'), first = target.evidence[0]
  target.evidence.unshift({ ...first, documentId: 'wrong' }, { ...first, sourceId: 'wrong' }, { ...first, quote: 'not stored' },
    { paragraph: 1e9, quote: 'absent identity' }, ...structuredClone(target.evidence))
  assert.equal(read(document, { modelId: 'left' }).ports[0].node.citations.length, 8)
  const overlap = { sourceId: 'overlap-conflict', chunkId: 'first', startParagraph: -1, endParagraph: 1e12 }
  document.graph.staging.chunks.unshift(overlap)
  assert.equal(read(document, { modelId: 'left' }).ports[0].node.citations.length, 0)
  overlap.sourceId = document.graph.source.id
  const enriched = read(document, { modelId: 'left' }); const legacy = enriched.legacyPorts || enriched.ports
  assert(legacy[0].node.citations.every(citation => citation.chunkId === 'first'))
  legacy[0].node.citations[0].quote = 'caller-only'
  const reread = read(document, { modelId: 'left' })
  assert.notEqual((reread.legacyPorts || reread.ports)[0].node.citations[0].quote, 'caller-only')
  document.sourceUnits.at(-1).text = 'Same identity, changed source quotation'
  assert.equal(read(document, { modelId: 'left' }).ports[0].node.citations.length, 7)
  document.revision++
  assert.equal(read(document, { expectedRevision: 1, modelId: 'left' }).error.code, 'revision_conflict')
}

const modes = [{}, { offset: 20 }, { conceptId: 'port-0', role: 'input' }, { conceptId: 'port-0', role: 'output' },
  { peerOf: 'catalogue-000' }, { chainOf: 'catalogue-000' }, { sectionId: 'measured', needsReview: true },
  { query: '暂记输入到输出' }, { query: '端点 1' }, { excludeModelId: 'catalogue-000' }, { concepts: true },
  { modelId: 'catalogue-000', structureEdit: true }, { modelId: 'catalogue-000', diagnosis: true },
  { modelId: 'catalogue-000', structureSources: true }, { modelId: 'catalogue-000', compareModelId: 'catalogue-001' },
  { modelId: 'catalogue-000', compareModelId: 'catalogue-001', concepts: true }, { expectedRevision: 0 }]
let httpRequests = 0, modelCalls = 0
for (const structured of [false, true]) {
  const fixture = modelEndpointCitationsFixture({ structured })
  const harness = await modelLearningHarness({ fixture, llm: { async createMessage() { modelCalls++; throw new Error('No model calls') } } })
  const server = createServer((req, res) => harness.handler(req, res))
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const canonical = harness.store.getCanonicalDocument(fixture.documentId), before = JSON.stringify(canonical)
    for (const options of modes) {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: fixture.documentId, expectedRevision: 1, ...options }) })
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), read(canonical, options)); httpRequests++
    }
    assert.equal(JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId)), before)
    assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
}

// Dynamic Host: extraction and explicit preview/commit expose the same catalogue and selected-model contracts.
const fixture = modelEndpointCitationsFixture({ structured: true })
const handlers = new Map(), previousHarness = globalThis.harness
try {
  globalThis.harness = { handle: (name, handler) => handlers.set(name, handler) }
  hostPlugin().apply({ get: name => name === 'kgExtractor' ? async () => structuredClone(fixture.graph) : null, interval: () => () => {} })
} finally { globalThis.harness = previousHarness }
const task = await handlers.get('extract')({ documentId: fixture.documentId, text: fixture.sourceText, title: 'Endpoint citation regression', ontology: fixture.graph.ontology })
assert.equal(task.error, undefined)
let status
for (let index = 0; index < 300; index++) {
  status = await handlers.get('task-status')({ taskId: task.taskId })
  if (status.status !== 'running') break
  await new Promise(resolve => setTimeout(resolve, 5))
}
assert.equal(status.status, 'succeeded', JSON.stringify(status))
const documentId = status.result.source.documentId
const loaded = await handlers.get('document-export')({ documentId, includeSourceText: true })
const models = fixture.graph.nodes.filter(node => node.modelStructure)
const request = { documentId, expectedRevision: loaded.revision, baseNodeIds: models.map(node => node.id), baseEdgeKeys: [],
  graph: { nodes: models.map(node => ({ ...loaded.graph.nodes.find(item => item.id === node.id), modelStructure: node.modelStructure })), edges: [] } }
assert.equal((await handlers.get('graph-commit-preview')(request)).valid, true)
assert.equal((await handlers.get('graph-commit')(request)).revision, loaded.revision + 1)
const exported = await handlers.get('document-export')({ documentId, includeSourceText: true })
const document = { documentId, revision: exported.revision, graph: exported.graph, sourceText: exported.sourceText,
  sourceUnits: contract.splitParagraphs(exported.sourceText).map((text, paragraph) => ({ paragraph, text })) }
let dynamicQueries = 0
for (const options of modes) {
  const args = { documentId, expectedRevision: document.revision, ...options }
  assert.deepEqual(await handlers.get('connection-models')(args), read(document, options)); dynamicQueries++
}
assert.deepEqual(await handlers.get('document-export')({ documentId, includeSourceText: true }), exported)
assert.equal(modelCalls, 0)
console.log(JSON.stringify({ ok: true, catalogueQueries: measurements.length, selectedQueries, fullConditionsEvidenceAndIdentity: true,
  noCatalogueProjectionCache: true, sameObjectSourceChanges: true, sourceOrderAndRevisionPreserved: true, measurements, selectedMeasurements,
  actualGeneratedHostHttp: true, httpRequests, modelCalls, actualDynamicRpc: true, dynamicQueries, publicPreviewAndCommit: true, canonicalAndLearningReadOnly: true }))
