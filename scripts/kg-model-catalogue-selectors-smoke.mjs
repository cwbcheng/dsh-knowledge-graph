import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import hostPlugin, { createGraphContract } from '../src/index.host.js'
import { modelEndpointCitationsFixture } from './kg-model-endpoint-citations-fixture-data.mjs'
import { modelCatalogueSelectorsFixture, modelCatalogueSelectorsModes } from './kg-model-catalogue-selectors-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'

const contract = createGraphContract()
const read = (document, options = {}) => contract.connectionModels(document, { expectedRevision: document.revision, ...options })
const measurements = []
for (const structured of [false, true]) {
  const document = modelEndpointCitationsFixture({ structured, models: 128 }), before = JSON.stringify(document)
  let fullWork = 0
  for (const options of [{}, { conceptId: 'port-0', role: 'input' }, { peerOf: 'catalogue-000' },
    { chainOf: 'catalogue-000' }, { query: '端点 0' }, { query: 'absent' },
    { peerOf: 'catalogue-000', chainOf: 'catalogue-001', conceptId: 'port-0', query: '端点' }]) {
    const expected = read(document, options), chunks = document.graph.staging.chunks, find = chunks.find, set = Map.prototype.set
    let sourceLookups = 0, retainedEndpoints = 0, retainedProvenance = 0
    chunks.find = function(...args) { sourceLookups++; return find.apply(this, args) }
    Map.prototype.set = function(key, value) {
      if (Array.isArray(value) && value.some(port => port?.node && Object.hasOwn(port, 'role'))) retainedEndpoints += value.length
      if (Number.isInteger(key) && value && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'chunkId,documentId,sourceId') retainedProvenance++
      return set.call(this, key, value)
    }
    try { assert.deepEqual(read(document, options), expected) }
    finally { delete chunks.find; Map.prototype.set = set }
    if (!Object.keys(options).length) fullWork = sourceLookups
    const selectedSources = Number(!!options.peerOf) + Number(!!options.chainOf)
    assert(fullWork > 100000, 'All models still undergo full citation validation')
    assert(sourceLookups <= fullWork + selectedSources * fullWork / 128,
      'Directory selectors must not revalidate endpoint citations: ' + JSON.stringify({ structured, options, sourceLookups, fullWork }))
    assert.equal(retainedEndpoints, 0); assert.equal(retainedProvenance, 0)
    assert.equal(expected.totalModels, 128); assert.equal(expected.topics[0].count, 128)
    for (const model of expected.items) {
      assert.equal(model.entailmentStatus, 'unverified'); assert.equal(model.inputs.length, 20); assert.equal(model.outputs.length, 20)
      for (const endpoint of [...model.inputs, ...model.outputs]) {
        assert.deepEqual(endpoint.citations.map(({ paragraph, quote }) => ({ paragraph, quote })),
          document.sourceUnits.slice(-8).map(({ paragraph, text }) => ({ paragraph, quote: text })))
      }
    }
    measurements.push({ structured, options, sourceLookups, fullWork, retainedEndpoints, retainedProvenance })
  }
  assert.equal(JSON.stringify(document), before)
}

for (const structured of [false, true]) {
  const document = modelCatalogueSelectorsFixture({ structured }), before = JSON.stringify(document)
  const ids = options => read(document, options).items.map(model => model.nodeId)
  const chain = structured ? ['catalogue-001', 'catalogue-004'] : ['catalogue-001']
  assert.deepEqual(ids({ chainOf: 'catalogue-000' }), chain)
  assert.deepEqual(ids({ peerOf: 'catalogue-000', chainOf: 'catalogue-000', conceptId: 'port-1', role: 'input', query: '端点' }), chain)
  assert.deepEqual(ids({ conceptId: 'port-1', role: 'input' }), chain)
  assert.deepEqual(ids({ conceptId: 'other-port-1', role: 'input' }), ['catalogue-002'], 'Same name does not replace canonical identity')
  assert.equal(read(document, { conceptId: 'port-1', role: 'unknown' }).items[0].nodeId, 'catalogue-003')
  const detail = read(document, { modelId: 'catalogue-004' })
  if (structured) {
    const original = document.graph.nodes.find(node => node.id === 'catalogue-004').modelStructure
    assert.deepEqual(detail.structure.branches.map(({ pairedExamples, incompleteExamples, ...branch }) => branch), original.branches)
    assert.deepEqual(detail.structure.slots.map(({ conceptText, ...slot }) => slot), original.slots)
    assert.equal(detail.ports[39].unit, '另一单位口径'); assert.equal(detail.ports[39].timeState, '另一对象时间')
    assert.equal(detail.structure.origin, 'reviewed_structure_not_verified_truth')
  }
  assert.equal(JSON.stringify(document), before)
  if (!structured) {
    // Raw damaged JSON remains diagnosable, but is never used as a persisted valid fixture.
    const damaged = structuredClone(document)
    damaged.graph.edges.push({ fromNodeId: 'catalogue-004', toNodeId: 'port-1', relation: 'maps_between', role: 'input' })
    assert(read(damaged, { conceptId: 'port-1', role: 'input' }).items.some(model => model.nodeId === 'catalogue-004'))
    assert(!read(damaged, { chainOf: 'catalogue-000' }).items.some(model => model.nodeId === 'catalogue-004'), 'Repeated edge identities are not usable chain directions')
  }
  const concept = document.graph.nodes.find(node => node.id === 'port-1')
  if (structured) document.graph.nodes.find(node => node.id === 'catalogue-001').modelStructure.slots[1].role = 'unknown'
  document.graph.edges.find(edge => edge.fromNodeId === 'catalogue-001' && edge.toNodeId === concept.id).role = 'unknown'
  assert(!ids({ chainOf: 'catalogue-000' }).includes('catalogue-001'), 'New calls reread roles even at the same object and revision')
  document.revision++
  assert.equal(read(document, { expectedRevision: 1 }).error.code, 'revision_conflict')
}

// A duplicate ID can point at a non-model whose extra structure was not projected by the catalogue summaries.
const shadowed = modelEndpointCitationsFixture({ models: 1, chunks: 16 }), raw = shadowed.graph.nodes.at(-1)
const shadow = { ...structuredClone(raw), type: 'rule' }
delete raw.modelStructure; raw.evidence = []; shadowed.graph.edges = []
shadow.modelStructure.slots = [shadow.modelStructure.slots[0]]; shadow.modelStructure.branches = []
shadowed.graph.nodes[0].evidence = [{ paragraph: 0, quote: shadowed.sourceUnits[0].text }]
shadowed.sourceUnits[0].text = 7; shadowed.graph.nodes.push(shadow)
assert.throws(() => read(shadowed, { conceptId: 'port-0' }), TypeError)
const damaged = modelEndpointCitationsFixture({ structured: false, models: 21, chunks: 16 }), last = damaged.graph.nodes.at(-1)
damaged.graph.edges = damaged.graph.edges.filter(edge => edge.fromNodeId !== last.id); damaged.sourceUnits.at(-1).text = 7
for (const node of damaged.graph.nodes) if (node.id !== last.id) node.evidence = []
for (const edge of damaged.graph.edges) edge.evidence = []
assert.throws(() => read(damaged, { conceptId: 'port-0', query: 'absent' }), TypeError,
  'Filtering, pagination and an empty result cannot hide source errors in an unreturned model')

let httpRequests = 0, modelCalls = 0
for (const structured of [false, true]) {
  const fixture = modelCatalogueSelectorsFixture({ structured })
  const harness = await modelLearningHarness({ fixture, llm: { async createMessage() { modelCalls++; throw new Error('No model calls') } } })
  const server = createServer((req, res) => harness.handler(req, res))
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const canonical = harness.store.getCanonicalDocument(fixture.documentId), before = JSON.stringify(canonical)
    for (const options of modelCatalogueSelectorsModes) {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: fixture.documentId, expectedRevision: 1, ...options }) })
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), read(canonical, options)); httpRequests++
    }
    assert.deepEqual(read(canonical, { chainOf: 'catalogue-000' }).items.map(model => model.nodeId), structured ? ['catalogue-001', 'catalogue-004'] : ['catalogue-001'])
    assert.equal(JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId)), before)
    assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
}

const fixture = modelCatalogueSelectorsFixture(), handlers = new Map(), previousHarness = globalThis.harness
// Extraction may coalesce identical text. Add the same-name record through the explicit commit instead.
const alias = fixture.graph.nodes.find(node => node.id === 'other-port-1'), aliasText = alias.text
alias.text += '（抽取阶段的独立身份）'
try {
  globalThis.harness = { handle: (name, handler) => handlers.set(name, handler) }
  hostPlugin().apply({ get: name => name === 'kgExtractor' ? async () => structuredClone(fixture.graph) : null, interval: () => () => {} })
} finally { globalThis.harness = previousHarness }
const task = await handlers.get('extract')({ documentId: fixture.documentId, text: fixture.sourceText, title: 'Catalogue selectors regression', ontology: fixture.graph.ontology })
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
assert.equal(loaded.graph.nodes.filter(node => node.type === 'connection_model').length, 24)
assert(models.every(node => loaded.graph.nodes.some(item => item.id === node.id)))
assert(loaded.graph.nodes.some(node => node.id === alias.id))
const request = { documentId, expectedRevision: loaded.revision, baseNodeIds: [...models.map(node => node.id), alias.id], baseEdgeKeys: [],
  graph: { nodes: [...models.map(node => ({ ...loaded.graph.nodes.find(item => item.id === node.id), modelStructure: node.modelStructure })),
    { ...loaded.graph.nodes.find(node => node.id === alias.id), text: aliasText }], edges: [] } }
assert.equal((await handlers.get('graph-commit-preview')(request)).valid, true)
assert.equal((await handlers.get('graph-commit')(request)).revision, loaded.revision + 1)
const exported = await handlers.get('document-export')({ documentId, includeSourceText: true })
const document = { documentId, revision: exported.revision, graph: exported.graph, sourceText: exported.sourceText,
  sourceUnits: contract.splitParagraphs(exported.sourceText).map((text, paragraph) => ({ paragraph, text })) }
let dynamicQueries = 0
for (const options of modelCatalogueSelectorsModes) {
  const args = { documentId, expectedRevision: document.revision, ...options }
  assert.deepEqual(await handlers.get('connection-models')(args), read(document, options)); dynamicQueries++
}
assert.equal(document.graph.nodes.filter(node => node.type === 'connection_model').length, 24)
assert.equal(document.graph.nodes.find(node => node.id === alias.id).text, document.graph.nodes.find(node => node.id === 'port-1').text)
assert.deepEqual(read(document, { chainOf: 'catalogue-000' }).items.map(model => model.nodeId), ['catalogue-001', 'catalogue-004'])
assert.deepEqual(await handlers.get('document-export')({ documentId, includeSourceText: true }), exported)
assert.equal(modelCalls, 0)
console.log(JSON.stringify({ ok: true, catalogueSelectorQueries: measurements.length, measurements,
  explicitRolesAndCanonicalIdentity: true, fullConditionsEvidenceAndIdentity: true, sameObjectChangesAndRevision: true,
  preservedNonModelShadowError: true, preservedUnreturnedSourceError: true, noCatalogueCaches: true,
  actualGeneratedHostHttp: true, httpRequests, modelCalls, actualDynamicRpc: true, dynamicQueries, publicPreviewAndCommit: true, canonicalAndLearningReadOnly: true }))
