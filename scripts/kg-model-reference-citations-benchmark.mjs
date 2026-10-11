import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { modelReferenceCitationsFixture, modelReferenceCitationsModes } from './kg-model-reference-citations-fixture-data.mjs'
import { modelEndpointCitationsFixture } from './kg-model-endpoint-citations-fixture-data.mjs'
import { modelMaterialPageFixture } from './kg-model-material-page-fixture-data.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-reference-citations-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8e6 })
const contracts = [(await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract(), createGraphContract()]
const query = (contract, document, options) => (options.exercise ? contract.learningPlan : contract.connectionModels)(document, { expectedRevision: document.revision, ...options })
const result = (contract, document, options) => {
  try { return { response: query(contract, document, options) } }
  catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } }
}
let edgeCases = 0, exceptions = 0
const equal = (document, options) => {
  const expected = result(contracts[0], document, options)
  assert.deepEqual(result(contracts[1], document, options), expected, JSON.stringify(options)); edgeCases++
  if (expected.exception) exceptions++
  return expected
}
const count = (contract, document, options, expected) => {
  const texts = new Set(document.sourceUnits.filter(Boolean).map(unit => unit.text)), includes = String.prototype.includes
  const chunks = document.graph.staging.chunks, find = chunks.find, set = Map.prototype.set
  const concept = document.graph.nodes.find(node => node.id === 'port-0'), descriptor = Object.getOwnPropertyDescriptor(concept, 'evidence')
  let quoteChecks = 0, sourceLookups = 0, retainedConcepts = 0, evidenceReads = 0
  String.prototype.includes = function(quote, ...args) { if (texts.has(String(this)) && texts.has(quote)) quoteChecks++; return includes.call(this, quote, ...args) }
  chunks.find = function(...args) { sourceLookups++; return find.apply(this, args) }
  Map.prototype.set = function(key, value) { if (key?.type === 'concept' && Array.isArray(value)) retainedConcepts++; return set.call(this, key, value) }
  Object.defineProperty(concept, 'evidence', { configurable: true, enumerable: true, get() { evidenceReads++; return descriptor.value } })
  try { assert.deepEqual(result(contract, document, options), expected) }
  finally { String.prototype.includes = includes; delete chunks.find; Map.prototype.set = set; Object.defineProperty(concept, 'evidence', descriptor) }
  return { quoteChecks, sourceLookups, retainedConcepts, evidenceReads }
}
const statistics = values => { values.sort((a,b) => a-b); return { medianMs: values[7], p95Ms: values[14] } }
const rows = []
for (const structured of [false, true]) for (const shared of [false, true]) for (const chunks of [64, 512]) for (const quotes of [0, 8, 24]) {
  const document = modelReferenceCitationsFixture({ structured, shared, chunks, quotes }), before = JSON.stringify(document)
  for (const options of modelReferenceCitationsModes.filter((_, index) => [0,1,2,4].includes(index))) {
    const expected = result(contracts[0], document, options)
    assert.equal(expected.exception, undefined); assert.equal(expected.response.error, undefined)
    assert.deepEqual(result(contracts[1], document, options), expected)
    const work = contracts.map(contract => count(contract, document, options, expected))
    assert.equal(work[1].sourceLookups, work[0].sourceLookups, 'First source identity lookup behavior is unchanged')
    if (structured && quotes) {
      assert(work[1].quoteChecks < work[0].quoteChecks)
      assert.equal(work[1].retainedConcepts, shared ? 1 : 40); assert.equal(work[1].evidenceReads, 2)
    } else { assert.equal(work[1].quoteChecks, work[0].quoteChecks); assert.equal(work[1].retainedConcepts, 0) }
    for (let warm = 0; warm < 5; warm++) for (const contract of contracts) query(contract, document, options)
    const samples = [[], []]
    // Batch short pure source queries; counters, fixtures and response assertions are outside timing.
    for (let sample = 0; sample < 15; sample++) for (const index of sample % 2 ? [1,0] : [0,1]) {
      const start = performance.now(); for (let repeat = 0; repeat < 16; repeat++) query(contracts[index], document, options)
      samples[index].push((performance.now() - start) / 16)
    }
    const row = { structured, shared, chunks, quotes, options, baselineWork: work[0], currentWork: work[1], baseline: statistics(samples[0]), current: statistics(samples[1]) }
    rows.push(row); console.log(JSON.stringify(row))
  }
  assert.equal(JSON.stringify(document), before)
}
const longQuotes = modelReferenceCitationsFixture({ longText: true, quotes: 24 })
for (const options of modelReferenceCitationsModes) equal(longQuotes, options)
const changes = [
  document => {},
  document => { document.graph.edges[0].role = 'unknown'; document.graph.edges[1].state = 'rejected' },
  document => { document.graph.nodes[0].state = 'rejected'; document.graph.nodes[1].type = 'rule' },
  document => { document.graph.edges.push(structuredClone(document.graph.edges[0])); document.graph.edges[2].toNodeId = 'missing' },
  document => { document.graph.edges[0].fromNodeId = 'port-0'; document.graph.edges[0].toNodeId = 'left' },
  document => { document.graph.staging.chunks.unshift({ sourceId: 'other', chunkId: 'first', startParagraph: -1, endParagraph: 1e12 }) },
  document => { document.graph.staging.chunks.unshift({ chunkId: 'first', startParagraph: -1, endParagraph: 1e12 }) },
  document => { document.graph.staging.chunks.reverse() },
  document => { document.graph.staging.chunks.unshift(null, false, 7, { startParagraph: '7', endParagraph: 1e12 }) },
  document => { document.graph.staging.chunks = [] },
  document => { document.graph.staging.chunks = {} },
  document => { document.graph.source.id = null; document.graph.staging.sourceId = 'fallback' },
  document => { document.graph.staging = null; document.graph.source = null },
  document => { document.sourceUnits = [] },
  document => { document.sourceUnits.at(-1).text = 7 },
  document => { document.sourceUnits.push(null) },
  document => { const unit = document.sourceUnits.at(-1); document.sourceUnits.push({ paragraph: unit.paragraph, text: 'duplicate identity last text' }) },
  document => { document.graph.nodes[0].evidence.push(null, false, ...[-1, '7', 7.5, null, NaN, Infinity, {}, []].map(paragraph => ({ paragraph, quote: 'invalid' }))) },
  document => { const node = document.graph.nodes[0]; node.quote = document.sourceUnits[0].text; node.paragraph = 0 },
  document => { const node = document.graph.nodes[0]; node.evidence.unshift(...structuredClone(node.evidence)) },
  document => { const node = document.graph.nodes[0], cite = node.evidence[0]; node.evidence.unshift({ ...cite, documentId: 'other' }, { ...cite, sourceId: 'other' }, { ...cite, quote: {} }, { ...cite, quote: '' }) },
  document => { document.graph.edges[0].evidence = [{ paragraph: 1e9, quote: 'absent' }]; document.graph.nodes[0].evidence = [] },
  document => { for (const node of document.graph.nodes) if (node.modelStructure) node.modelStructure.slots[0].role = 'reverse' },
  document => { for (const node of document.graph.nodes) if (node.modelStructure) node.modelStructure.slots[0].conceptId = 'missing' },
  document => { for (const node of document.graph.nodes) if (node.modelStructure) node.modelStructure.branches[0].condition.provenance.quote = 'not stored' },
  document => { const node = document.graph.nodes.find(node => node.id === 'left'); if (node.modelStructure) node.modelStructure.identity = 'wrong_example'; node.state = 'rejected'; node.entailmentStatus = 'unsupported' },
  document => { document.graph.nodes[1].text = document.graph.nodes[0].text; document.graph.nodes.reverse(); document.graph.edges.reverse() },
  document => { document.graph.nodes.push({ ...structuredClone(document.graph.nodes[0]), text: 'duplicate ID last record', evidence: [] }) },
  document => { document.graph.nodes.push({ ...structuredClone(document.graph.nodes.find(node => node.id === 'left')), text: 'duplicate model last record' }) },
  document => { document.graph.nodes.push({ ...structuredClone(document.graph.nodes.find(node => node.id === 'left')), type: 'rule' }) },
  document => { document.graph.edges = [] },
  document => { for (const node of document.graph.nodes) if (node.modelStructure) { node.modelStructure.slots = []; node.modelStructure.branches = [] } },
]
for (const structured of [false, true]) for (const shared of [false, true]) for (const change of changes) {
  const document = modelReferenceCitationsFixture({ structured, shared, quotes: 24 }); change(document)
  const before = JSON.stringify(document)
  for (const options of modelReferenceCitationsModes) equal(document, options)
  assert.equal(JSON.stringify(document), before)
}
// Same object and revision must re-read new evidence, canonical nodes and source identities.
const changed = modelReferenceCitationsFixture()
for (const change of [() => {}, () => { changed.graph.nodes[0].evidence = [] },
  () => { changed.graph.nodes[0].evidence = changed.graph.nodes[1].evidence },
  () => { changed.graph.nodes[0].text = 'new canonical name' },
  () => { changed.sourceUnits.at(-1).text = 'changed source at same identity' },
  () => { changed.graph.nodes.find(node => node.id === 'left').modelStructure.slots[1].role = 'input' },
  () => { changed.graph.nodes.push({ ...structuredClone(changed.graph.nodes[0]), evidence: [] }) }, () => { changed.revision++ }]) {
  change(); for (const options of modelReferenceCitationsModes) equal(changed, options)
}
const catalogue = modelEndpointCitationsFixture({ models: 128, chunks: 64 }), catalogueBefore = JSON.stringify(catalogue)
const catalogueControls = [{}, { offset: 100 }, { query: 'absent' }, { peerOf: 'catalogue-000' },
  { chainOf: 'catalogue-000' }, { conceptId: 'port-0', role: 'input' }, { concepts: true }]
for (const options of catalogueControls) {
  const expected = equal(catalogue, options), work = contracts.map(contract => count(contract, catalogue, options, expected))
  assert.deepEqual(work[1], work[0], 'Full catalogue and concept queries have unchanged work and no slot cache')
}
assert.equal(JSON.stringify(catalogue), catalogueBefore)
const damaged = modelEndpointCitationsFixture({ structured: false, models: 21, chunks: 16 }), last = damaged.graph.nodes.at(-1)
damaged.graph.edges = damaged.graph.edges.filter(edge => edge.fromNodeId !== last.id); damaged.sourceUnits.at(-1).text = 7
for (const node of damaged.graph.nodes) if (node.id !== last.id) node.evidence = []
for (const edge of damaged.graph.edges) edge.evidence = []
for (const options of [{}, { conceptId: 'port-0', query: 'absent' }]) assert.equal(equal(damaged, options).exception.name, 'TypeError')
let learningControls = 0
for (const structured of [false, true]) {
  const document = modelMaterialPageFixture({ structured, materials: 25, chunks: 64, distributed: true, rules: true }), before = JSON.stringify(document)
  for (const exercise of ['prediction', 'counterexample', 'understanding']) { equal(document, { modelId: 'left', exercise }); learningControls++ }
  assert.equal(JSON.stringify(document), before)
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, samples: 15, queriesPerSample: 16,
  alternatedImplementations: true, performanceCases: rows.length, edgeCases, matchedExceptions: exceptions,
  catalogueControls: catalogueControls.length, learningControls, canonicalReadOnly: true, independentCitationObjectsCoveredBySmoke: true,
  timedScope: 'Actual synchronous source queries; excludes counters, assertions, fixture creation, SQLite, HTTP and browser rendering', noHeapMemoryClaim: true, rows }, null, 2))
