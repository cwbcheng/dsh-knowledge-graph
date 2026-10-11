import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { modelEndpointCitationsFixture } from './kg-model-endpoint-citations-fixture-data.mjs'
import { modelMaterialPageFixture } from './kg-model-material-page-fixture-data.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-endpoint-citations-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8e6 })
const contracts = [(await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract(), createGraphContract()]
const query = (contract, document, options) => (options.exercise ? contract.learningPlan : contract.connectionModels)(document,
  { expectedRevision: document.revision, ...options })
const result = (contract, document, options) => {
  try { return { response: query(contract, document, options) } }
  catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } }
}
const count = (contract, document, options, expected) => {
  const chunks = document.graph.staging.chunks, find = chunks.find, includes = String.prototype.includes
  const sourceTexts = new Set(document.sourceUnits.map(unit => unit.text))
  let sourceLookups = 0, paragraphVisits = 0, quoteChecks = 0
  chunks.find = function(predicate) { sourceLookups++; return find.call(this, (item, index, array) => { paragraphVisits++; return predicate(item, index, array) }) }
  String.prototype.includes = function(quote, ...args) {
    if (sourceTexts.has(String(this)) && sourceTexts.has(quote)) quoteChecks++
    return includes.call(this, quote, ...args)
  }
  try { assert.deepEqual(result(contract, document, options), expected) }
  finally { delete chunks.find; String.prototype.includes = includes }
  return { sourceLookups, paragraphVisits, quoteChecks }
}
const stats = values => { values.sort((a, b) => a - b); return { medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.floor(values.length * .95)] } }
const rows = []
for (const structured of [false, true]) for (const models of [32, 128]) for (const chunks of [64, 512]) {
  const document = modelEndpointCitationsFixture({ structured, models, chunks }), before = JSON.stringify(document)
  for (const [mode, options] of [['first-page', {}], ['later-page', { offset: 20 }], ['concept-filter', { conceptId: 'port-0', role: 'input' }]]) {
    const expected = result(contracts[0], document, options)
    assert.equal(expected.exception, undefined); assert.equal(expected.response.error, undefined)
    assert.deepEqual(result(contracts[1], document, options), expected, 'Complete catalogue summaries, topic order, filtering and full quotes match')
    const work = contracts.map(contract => count(contract, document, options, expected))
    assert(work[1].sourceLookups < work[0].sourceLookups); assert(work[1].quoteChecks < work[0].quoteChecks)
    for (let warm = 0; warm < 3; warm++) for (const contract of contracts) query(contract, document, options)
    const samples = [[], []]
    // Time actual source queries only; counters, assertions and fixture construction are excluded.
    for (let sample = 0; sample < 11; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      const at = performance.now(); query(contracts[index], document, options); samples[index].push(performance.now() - at)
    }
    const row = { structured, models, chunks, mode, baselineWork: work[0], currentWork: work[1], baseline: stats(samples[0]), current: stats(samples[1]) }
    rows.push(row); console.log(JSON.stringify(row))
  }
  assert.equal(JSON.stringify(document), before)
}

let edgeCases = 0, exceptions = 0
const equal = (document, options) => {
  const expected = result(contracts[0], document, options)
  assert.deepEqual(result(contracts[1], document, options), expected, JSON.stringify(options))
  edgeCases++; if (expected.exception) exceptions++
  return expected
}
const modes = [{}, { offset: 20 }, { offset: 999 }, { offset: -1 }, { offset: '20' }, { query: '暂记输入到输出' },
  { query: '端点 1' }, { query: ' ＣＡＴＡＬＯＧＵＥ ' }, { query: 'absent' }, { query: '   ' },
  { conceptId: 'port-0', role: 'input' }, { conceptId: 'port-0', role: 'output' }, { conceptId: 'absent' },
  { peerOf: 'catalogue-000' }, { chainOf: 'catalogue-000' }, { peerOf: 'absent' }, { chainOf: 'absent' },
  { sectionId: 'measured' }, { sectionId: 'absent' }, { needsReview: true }, { excludeModelId: 'catalogue-001' },
  { modelId: 'catalogue-000' }, { modelId: 'catalogue-000', diagnosis: true }, { modelId: 'catalogue-000', structureSources: true },
  { modelId: 'catalogue-000', structureEdit: true }, { modelId: 'catalogue-000', compareModelId: 'catalogue-001' },
  { modelId: 'catalogue-000', compareModelId: 'catalogue-001', concepts: true }, { concepts: true }, { expectedRevision: 0 }, { chainDraft: {} }]
const changes = [
  document => {},
  document => { document.graph.edges[0].role = 'unknown'; document.graph.edges[1].state = 'rejected' },
  document => { document.graph.nodes[0].state = 'rejected'; document.graph.nodes[1].type = 'rule' },
  document => { document.graph.edges[2].toNodeId = 'absent'; document.graph.edges.push(structuredClone(document.graph.edges[0])) },
  document => { document.graph.edges[0].fromNodeId = 'port-0'; document.graph.edges[0].toNodeId = 'catalogue-000' },
  document => { document.graph.staging.chunks.unshift({ sourceId: 'conflict', chunkId: 'first', startParagraph: -1, endParagraph: 1e12 }) },
  document => { document.graph.staging.chunks.unshift({ startParagraph: -1, endParagraph: 1e12 }) },
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
  document => { document.graph.nodes[0].quote = document.sourceUnits[0].text; document.graph.nodes[0].paragraph = document.sourceUnits[0].paragraph },
  document => { const node = document.graph.nodes[0]; node.evidence = document.sourceUnits.slice(0, 10).map(unit => ({ paragraph: unit.paragraph, quote: unit.text })); node.evidence.unshift(...structuredClone(node.evidence)); node.evidence.push({ paragraph: 1e9, quote: 'absent' }) },
  document => { const node = document.graph.nodes[0], cite = node.evidence[0]; node.evidence.unshift({ ...cite, documentId: 'other' }, { ...cite, sourceId: 'other' }, { ...cite, quote: {} }, { ...cite, quote: '' }) },
  document => { document.graph.edges[0].evidence = [{ paragraph: 1e9, quote: 'absent' }]; document.graph.nodes[0].evidence = [] },
  document => { const model = document.graph.nodes.find(node => node.type === 'connection_model'); if (model.modelStructure) model.modelStructure.slots[0].role = 'reverse' },
  document => { const model = document.graph.nodes.find(node => node.type === 'connection_model'); if (model.modelStructure) model.modelStructure.slots[0].conceptId = 'absent' },
  document => { const model = document.graph.nodes.find(node => node.type === 'connection_model'); if (model.modelStructure) model.modelStructure.branches[0].condition.provenance.quote = 'not stored' },
  document => { const model = document.graph.nodes.find(node => node.type === 'connection_model'); if (model.modelStructure) model.modelStructure.identity = 'wrong_example'; model.state = 'rejected'; model.entailmentStatus = 'unsupported' },
  document => { const model = document.graph.nodes.find(node => node.type === 'connection_model'); if (model.modelStructure) { model.modelStructure.slots[1].conceptId = 'port-0'; model.modelStructure.slots[1].state = '另一时间'; model.modelStructure.slots[1].unit = '另一单位' } },
  document => { document.graph.nodes[1].text = document.graph.nodes[0].text; document.graph.nodes.reverse(); document.graph.edges.reverse() },
  document => { document.graph.source.sections.unshift({ id: 'first', title: '先存章节', startParagraph: -1, endParagraph: 1e12 }); document.graph.nodes.find(node => node.type === 'connection_model').paragraph = null },
  document => { document.graph.nodes.push({ ...structuredClone(document.graph.nodes.find(node => node.type === 'connection_model')), text: '重复ID末记录' }) },
  document => { document.graph.nodes = document.graph.nodes.filter(node => node.type !== 'connection_model') },
  document => { document.graph.edges = [] },
]
for (const structured of [false, true]) for (const change of changes) {
  const document = modelEndpointCitationsFixture({ structured, models: 3, chunks: 16, distributed: true }); change(document)
  const before = JSON.stringify(document)
  for (const options of modes) equal(document, options)
  assert.equal(JSON.stringify(document), before)
}
for (const structured of [false, true]) {
  const document = modelEndpointCitationsFixture({ structured, models: 3, chunks: 16, distributed: true })
  for (const change of [
    value => { value.graph.staging.chunks.at(-1).chunkId = 'same-revision-new-chunk' },
    value => { value.sourceUnits.at(-1).text = 'same identity, changed quote' },
    value => { value.graph.nodes[0].evidence = []; value.graph.edges[0].role = 'unknown' },
    value => { value.graph.staging.chunks.unshift({ sourceId: 'earlier', chunkId: 'first', startParagraph: -1, endParagraph: 1e12 }) },
    value => { value.graph.staging.chunks = []; value.graph.source.id = null; value.graph.staging.sourceId = 'new-fallback' },
    value => { value.revision++ },
  ]) {
    change(document); const before = JSON.stringify(document)
    for (const options of modes) equal(document, options)
    assert.equal(JSON.stringify(document), before)
  }
}

// Full catalogue validation still observes damage in a model outside the first returned page.
const damaged = modelEndpointCitationsFixture({ structured: false, models: 21, chunks: 16 }), last = damaged.graph.nodes.at(-1)
damaged.graph.edges = damaged.graph.edges.filter(edge => edge.fromNodeId !== last.id); damaged.sourceUnits.at(-1).text = 7
for (const node of damaged.graph.nodes) if (node.id !== last.id) node.evidence = []
for (const edge of damaged.graph.edges) edge.evidence = []
assert.equal(equal(damaged, {}).exception.name, 'TypeError')

const selectedWork = []
for (const structured of [false, true]) {
  const document = modelMaterialPageFixture({ structured, materials: 25, chunks: 64, distributed: true, rules: true }), before = JSON.stringify(document)
  for (const options of [{}, { diagnosis: true }, { structureSources: true }, { compareModelId: 'right' },
    ...['prediction', 'counterexample', 'understanding'].map(exercise => ({ exercise })), { concepts: true }]) {
    const args = { modelId: 'left', ...options }, expected = equal(document, args)
    const work = contracts.map(contract => count(contract, document, args, expected))
    // Selected requests already share provenance; reduced quote checks, not chunk search counts, measure this change.
    assert.equal(work[1].sourceLookups, work[0].sourceLookups)
    if (options.concepts) assert.deepEqual(work[1], work[0])
    else assert(work[1].quoteChecks < work[0].quoteChecks)
    selectedWork.push({ structured, options, baselineWork: work[0], currentWork: work[1] })
  }
  assert.equal(JSON.stringify(document), before)
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, samples: 11, alternatedImplementations: true,
  completePerformanceCases: rows.length, edgeCases, matchedExceptions: exceptions, selectedControls: selectedWork.length,
  preservedUnreturnedSourceError: true, canonicalReadOnly: true, noHeapMemoryClaim: true,
  timedScope: 'Actual synchronous source model queries; excludes instrumentation, assertions, fixture construction, SQLite, HTTP and browser time', rows, selectedWork }, null, 2))
