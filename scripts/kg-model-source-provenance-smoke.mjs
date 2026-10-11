import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { modelMaterialPageFixture } from './kg-model-material-page-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'

const query = createGraphContract().connectionModels
const modes = [{}, { diagnosis: true }, { structureSources: true }, { compareModelId: 'right' }]
const read = (document, options = {}) => query(document, { modelId: 'left', expectedRevision: document.revision, ...options })
const measurements = []
const observe = (document, options = {}) => {
  const expected = read(document, options), chunks = document.graph.staging.chunks, find = chunks.find, set = Map.prototype.set
  const retained = new Set(), known = new Set(document.sourceUnits.map(unit => unit.paragraph))
  let sourceLookups = 0, retainedEntries = 0
  // Count actual provenance searches and retained results, separately from elapsed benchmarks.
  chunks.find = function(...args) { sourceLookups++; return find.apply(this, args) }
  Map.prototype.set = function(key, value) {
    if (Number.isInteger(key) && value && Object.keys(value).length === 3 && 'documentId' in value && 'sourceId' in value && 'chunkId' in value) {
      assert(known.has(key), 'Invalid or absent source identities must not accumulate provenance cache entries')
      retainedEntries++; retained.add(key)
    }
    return set.call(this, key, value)
  }
  try { assert.deepEqual(read(document, options), expected) }
  finally { delete chunks.find; Map.prototype.set = set }
  assert.equal(retainedEntries, retained.size, 'Compared models share one source resolution per known identity')
  assert(retainedEntries <= known.size)
  return { sourceLookups, retainedEntries }
}

for (const structured of [false, true]) for (const distributed of [false, true]) {
  const document = modelMaterialPageFixture({ structured, distributed, materials: 4096, chunks: 512 }), before = JSON.stringify(document)
  for (const mode of modes) {
    const work = observe(document, mode)
    assert(work.sourceLookups <= document.sourceUnits.length, 'Repeated citations resolve each stored paragraph at most once per selected-model query')
    assert.equal(work.sourceLookups, work.retainedEntries)
    measurements.push({ structured, distributed, mode, ...work })
  }
  const detail = read(document), expectedEvidence = document.sourceUnits.slice(-8)
  assert.equal(detail.ports.length, 40); assert.equal(detail.related.length, 20); assert.equal(detail.relatedTotal, 4096)
  for (const port of detail.ports) {
    assert.deepEqual(port.node.citations.map(({ paragraph, quote }) => ({ paragraph, quote })), expectedEvidence.map(unit => ({ paragraph: unit.paragraph, quote: unit.text })))
    assert.equal(port.node.state, 'candidate'); assert.equal(port.node.entailmentStatus, 'unverified')
  }
  if (structured) {
    const model = document.graph.nodes.find(node => node.id === 'left')
    assert.deepEqual(detail.structure.branches[0].condition, model.modelStructure.branches[0].condition)
    assert.deepEqual(detail.structure.branches[0].boundary, model.modelStructure.branches[0].boundary)
    assert.equal(detail.structure.identity, 'hypothesis')
  }
  for (const unit of read(document, { structureSources: true }).sourceUnits.items) {
    const chunk = document.graph.staging.chunks.find(item => unit.paragraph >= item.startParagraph && unit.paragraph <= item.endParagraph)
    assert.equal(unit.documentId, document.documentId); assert.equal(unit.sourceId, document.graph.source.id); assert.equal(unit.chunkId, chunk.chunkId)
    assert.equal(unit.text, document.sourceUnits.find(item => item.paragraph === unit.paragraph).text)
  }
  assert.equal(JSON.stringify(document), before, 'Queries preserve canonical identities, conditions, evidence and source order')
}

const invalid = modelMaterialPageFixture({ materials: 25, chunks: 64, distributed: true })
const material = invalid.graph.nodes.find(node => node.id === 'material-0')
material.evidence.push(...Array.from({ length: 4096 }, (_, index) => ({ paragraph: 1e9 + index, quote: 'not stored' })),
  ...[-1, 7.5, '7', null, NaN, Infinity, undefined].map(paragraph => ({ paragraph, quote: '' })), null, false)
const invalidBefore = JSON.stringify(invalid), invalidWork = observe(invalid, { structureSources: true })
assert(invalidWork.sourceLookups > 4096, 'Unknown integer identities retain the original uncached validation')
assert(invalidWork.retainedEntries <= invalid.sourceUnits.length)
assert.equal(read(invalid).related[0].citations.length, 1, 'Invalid records cannot crowd out the valid full quotation')
assert.equal(JSON.stringify(invalid), invalidBefore)

const catalogue = modelMaterialPageFixture({ materials: 0, chunks: 64 }), template = catalogue.graph.nodes.find(node => node.id === 'left')
const templateEdges = catalogue.graph.edges.filter(edge => edge.fromNodeId === 'left')
catalogue.graph.nodes = catalogue.graph.nodes.filter(node => node.type === 'concept'); catalogue.graph.edges = []
for (let index = 0; index < 128; index++) {
  const model = structuredClone(template); model.id = 'catalogue-' + index
  catalogue.graph.nodes.push(model); catalogue.graph.edges.push(...templateEdges.map(edge => ({ ...structuredClone(edge), fromNodeId: model.id })))
}
const catalogueBefore = JSON.stringify(catalogue)
for (const options of [{ modelId: undefined }, { modelId: undefined, offset: 20 }, { modelId: 'catalogue-0', concepts: true }, { modelId: undefined, concepts: true }]) {
  assert.equal(observe(catalogue, options).retainedEntries, 0, 'Catalogue and concept reads do not retain provenance results')
}
assert.equal(query(catalogue, { expectedRevision: 1 }).total, 128)
assert.equal(JSON.stringify(catalogue), catalogueBefore)

// A new call must re-read the same object and revision, first matching interval and source fallback.
for (const structured of [false, true]) {
  const document = modelMaterialPageFixture({ structured, materials: 25, chunks: 64 }), sourceId = document.graph.source.id
  const first = { sourceId: 'other-source', chunkId: 'first-overlap', startParagraph: 0, endParagraph: 1e12 }
  document.graph.staging.chunks.unshift(first)
  assert.equal(read(document).ports[0].node.citations.length, 0, 'Source conflict rejects citations even when a later interval matches their source')
  assert(read(document, { structureSources: true }).sourceUnits.items.every(unit => unit.sourceId === 'other-source' && unit.chunkId === 'first-overlap'))
  first.sourceId = sourceId
  assert.equal(read(document).ports[0].node.citations.length, 8)
  if (structured) assert(read(document).legacyPorts[0].citations.every(citation => citation.chunkId === 'first-overlap'))
  document.graph.staging.chunks.reverse()
  const returned = read(document, { structureSources: true }).sourceUnits
  assert(returned.items.every(unit => unit.chunkId === 'part-' + unit.paragraph), 'First interval follows stored order rather than source sorting')
  returned.items[0].sourceId = 'caller-only'; returned.items[0].chunkId = 'caller-only'
  assert.equal(read(document, { structureSources: true }).sourceUnits.items[0].sourceId, sourceId)
  document.graph.staging.chunks = []
  assert(read(document, { structureSources: true }).sourceUnits.items.every(unit => unit.sourceId === sourceId && unit.chunkId === null))
  document.graph.source.id = null; document.graph.staging.sourceId = 'staging-fallback'
  assert(read(document, { structureSources: true }).sourceUnits.items.every(unit => unit.sourceId === 'staging-fallback' && unit.chunkId === null))
  document.graph.staging.sourceId = null
  assert(read(document, { structureSources: true }).sourceUnits.items.every(unit => unit.sourceId === null && unit.chunkId === null))
  assert.equal(read(document).ports[0].node.citations.length, 8, 'Absent provenance retains the original full-quote validation')
  document.sourceUnits.at(-1).text = 'Changed source text at the same identity'
  assert.equal(read(document).ports[0].node.citations.length, 7, 'A same-revision source edit cannot reuse the preceding call')
  document.revision = 2
  assert.equal(read(document, { expectedRevision: 1 }).error.code, 'revision_conflict')
  const independent = modelMaterialPageFixture({ materials: 25, chunks: 64 })
  assert.equal(read(independent).ports[0].node.citations.length, 8)
  assert(read(independent, { structureSources: true }).sourceUnits.items.every(unit => unit.sourceId === sourceId && unit.chunkId === 'part-' + unit.paragraph))
}

const fixture = modelMaterialPageFixture({ materials: 25, chunks: 64, distributed: true, rules: true })
let modelCalls = 0, httpRequests = 0
const harness = await modelLearningHarness({ fixture, llm: { async createMessage() { modelCalls++; throw new Error('No model calls') } } })
const server = createServer((req, res) => harness.handler(req, res))
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const canonical = harness.store.getCanonicalDocument(fixture.documentId), before = JSON.stringify(canonical)
  for (const options of [...modes, { structureSources: true, sourceOffset: 12 }, { offset: 20 }, { structureEdit: true }, { expectedRevision: 0 }]) {
    httpRequests++
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: fixture.documentId, modelId: 'left', expectedRevision: 1, ...options }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), read(canonical, options), 'Real generated Host TCP/SQLite queries preserve every response field')
  }
  assert.equal(JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId)), before)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  assert.equal(modelCalls, 0)
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
console.log(JSON.stringify({ ok: true, boundedQueries: measurements.length, measurements, knownIdentityRetentionOnly: true, invalidWork,
  catalogueModels: 128, catalogueAndConceptRetainedEntries: 0, independentCallsAndSourceOrder: true, fullConditionsAndEvidence: true,
  actualGeneratedHostHttp: true, httpRequests, canonicalAndLearningReadOnly: true, modelCalls }))
