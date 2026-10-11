import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { modelMaterialPageFixture } from './kg-model-material-page-fixture-data.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-citation-identity-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8e6 })
const contracts = [(await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract(), createGraphContract()]
const modes = [['detail', {}], ['later-page', { offset: 20 }], ['diagnosis', { diagnosis: true }], ['sources', { structureSources: true }],
  ['comparison', { compareModelId: 'right' }], ...['prediction', 'counterexample', 'understanding'].map(exercise => [exercise, { exercise }])]
const query = (contract, document, options) => (options.exercise ? contract.learningPlan : contract.connectionModels)(document,
  { modelId: 'left', expectedRevision: document.revision, ...options })
const result = (contract, document, options) => {
  try { return { response: query(contract, document, options) } }
  catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } }
}
const count = (contract, document, options, expected) => {
  const chunks = document.graph.staging.chunks, find = chunks.find
  let sourceLookups = 0, paragraphVisits = 0
  chunks.find = function(predicate) { sourceLookups++; return find.call(this, (item, index, array) => { paragraphVisits++; return predicate(item, index, array) }) }
  try { assert.deepEqual(result(contract, document, options), expected) }
  finally { delete chunks.find }
  return { sourceLookups, paragraphVisits }
}
const missingRecords = count => Array.from({ length: count }, (_, index) => ({ paragraph: 1e9 + index, quote: 'not a stored quotation' }))
const stats = values => { values.sort((a, b) => a - b); return { medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.floor(values.length * .95)] } }
const rows = []
for (const structured of [false, true]) for (const distributed of [false, true]) for (const missing of [0, 512, 4096]) {
  const document = modelMaterialPageFixture({ structured, distributed, materials: 25, chunks: 512 })
  document.graph.nodes.find(node => node.id === 'material-0').evidence.unshift(...missingRecords(missing))
  const snapshot = JSON.stringify(document)
  for (const [mode, options] of modes) {
    const expected = result(contracts[0], document, options)
    assert.equal(expected.exception, undefined); assert.equal(expected.response.error, undefined)
    assert.deepEqual(result(contracts[1], document, options), expected, 'Complete conditions, evidence, provenance and personal learning boundaries must match')
    const work = contracts.map(contract => count(contract, document, options, expected))
    if (!missing || ['later-page', 'diagnosis'].includes(mode)) assert.deepEqual(work[1], work[0], 'Valid and unaffected control workloads retain their searches')
    else assert(work[1].sourceLookups < work[0].sourceLookups, 'Absent identities must not scan source chunks')
    assert(work[1].sourceLookups <= document.sourceUnits.length)
    for (let warm = 0; warm < 3; warm++) for (const contract of contracts) query(contract, document, options)
    const samples = [[], []]
    // Alternate uninstrumented source calls. Exclude fixture construction, assertions and search counters.
    for (let sample = 0; sample < 11; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      const at = performance.now(); query(contracts[index], document, options); samples[index].push(performance.now() - at)
    }
    const row = { structured, distributed, missing, mode, baselineWork: work[0], currentWork: work[1], baseline: stats(samples[0]), current: stats(samples[1]) }
    rows.push(row); console.log(JSON.stringify(row))
  }
  assert.equal(JSON.stringify(document), snapshot)
}

const addExample = document => {
  const model = document.graph.nodes.find(node => node.id === 'left'), specification = model.modelStructure
  if (!specification) return
  specification.examples.push({ id: 'recorded', title: '未核验记录', scenario: '只检查所存结构与引文，不证明预测或掌握。',
    branchId: 'conditional', inputs: specification.slots.filter(slot => slot.role === 'input').map(slot => ({ slotId: slot.id, value: 'input record' })),
    outputs: specification.slots.filter(slot => slot.role === 'output').map(slot => ({ slotId: slot.id, value: 'output record' })),
    reasoning: '未核验配对记录', provenance: { ...specification.slots[0].provenance } })
}
const changes = [
  document => { document.graph.staging.chunks.unshift({ sourceId: 'first-conflict', chunkId: 'first', startParagraph: -10, endParagraph: 1e20 }) },
  document => { document.graph.staging.chunks.unshift({ startParagraph: -10, endParagraph: 1e20 }) },
  document => { document.graph.staging.chunks.reverse() },
  document => { document.graph.staging.chunks.unshift(null, false, 7, 'malformed', { startParagraph: '7', endParagraph: 1e20 }, { startParagraph: 1000, endParagraph: -1 }) },
  document => { document.graph.staging.chunks = [] },
  document => { document.graph.staging.chunks = {} },
  document => { document.graph.staging = null; document.graph.source = null },
  document => { document.graph.source.id = null; document.graph.staging.sourceId = 'fallback'; document.graph.source.documentId = 'other-document' },
  document => { document.sourceUnits = [] },
  document => { document.sourceUnits.at(-1).text = 7 },
  document => { document.sourceUnits.push(null) },
  document => { const unit = document.sourceUnits.at(-1); document.sourceUnits.push({ paragraph: unit.paragraph, text: 'duplicate identity last text' }) },
  document => { const unit = document.sourceUnits.at(-1); document.sourceUnits.push({ paragraph: -1, text: unit.text }, { paragraph: '7', text: unit.text }) },
  document => { const item = document.graph.nodes.find(node => node.id === 'material-0'); item.evidence.push(null, false, ...[-1, 7.5, '7', null, undefined, NaN, Infinity, {}, [], true].map(paragraph => ({ paragraph, quote: 'invalid' }))) },
  document => { const item = document.graph.nodes.find(node => node.id === 'material-0'); item.quote = 'not stored'; item.paragraph = 1e9; item.evidence.unshift(...structuredClone(item.evidence)) },
  document => { const item = document.graph.nodes.find(node => node.id === 'material-0'); item.evidence = document.sourceUnits.slice(0, 10).map(unit => ({ paragraph: unit.paragraph, quote: unit.text })); item.evidence.unshift(...missingRecords(32)); item.evidence.push(...missingRecords(32), ...structuredClone(item.evidence)) },
  document => { const item = document.graph.nodes.find(node => node.id === 'material-0'); const citation = item.evidence[0]; item.evidence.unshift({ ...citation, documentId: 'wrong-document' }, { ...citation, sourceId: 'wrong-source' }, { ...citation, quote: '' }, { ...citation, quote: {} }) },
  document => { const model = document.graph.nodes.find(node => node.id === 'left'); if (model.modelStructure) for (const slot of model.modelStructure.slots) slot.provenance = { ...slot.provenance, paragraph: 1e9 } },
  document => { const model = document.graph.nodes.find(node => node.id === 'left'); if (model.modelStructure) for (const field of ['condition', 'mapping', 'boundary']) model.modelStructure.branches[0][field].provenance = { ...model.modelStructure.branches[0][field].provenance, paragraph: 1e9 } },
  document => { addExample(document) },
  document => { addExample(document); const specification = document.graph.nodes.find(node => node.id === 'left').modelStructure; if (specification) specification.examples[0].provenance.paragraph = 1e9 },
  document => { addExample(document); const specification = document.graph.nodes.find(node => node.id === 'left').modelStructure; if (specification) specification.examples[0].provenance.kind = 'user' },
  document => { document.graph.nodes.find(node => node.id === 'left').evidence.unshift(...missingRecords(32)); document.graph.nodes.find(node => node.id === 'port-0').evidence.unshift(...missingRecords(32)); document.graph.edges[0].evidence.unshift(...missingRecords(32)) },
  document => { document.sourceUnits.reverse(); document.graph.edges.reverse() },
]
const options = [...modes.map(([, option]) => option), { modelId: undefined }, { concepts: true }, { expectedRevision: 0 }, { chainDraft: {} },
  { compareModelId: 'right', structureSources: true }, { structureEdit: true }, { structureSources: true, sourceOffset: 12 }, { offset: -1 }, { offset: '20' }]
let edgeCases = 0, exceptions = 0
const equal = (document, option) => {
  const expected = result(contracts[0], document, option)
  assert.deepEqual(result(contracts[1], document, option), expected)
  if (expected.exception) exceptions++
  edgeCases++
}
for (const structured of [false, true]) for (const change of changes) {
  const document = modelMaterialPageFixture({ structured, distributed: true, materials: 25, chunks: 64, rules: true })
  document.graph.nodes.find(node => node.id === 'material-0').evidence.unshift(...missingRecords(32)); change(document)
  const snapshot = JSON.stringify(document)
  for (const option of options) equal(document, option)
  assert.equal(JSON.stringify(document), snapshot)
}
for (const structured of [false, true]) {
  const updated = modelMaterialPageFixture({ structured, distributed: true, materials: 25, chunks: 64 })
  updated.graph.nodes.find(node => node.id === 'material-0').evidence.unshift(...missingRecords(32))
  for (const change of [
    document => { document.graph.staging.chunks.at(-1).chunkId = 'same-revision-new-chunk' },
    document => { document.sourceUnits.push({ paragraph: 1e9, text: 'not a stored quotation' }) },
    document => { document.sourceUnits.at(-1).text = 'changed quotation at the same stored identity' },
    document => { document.sourceUnits.pop(); document.revision++ },
    document => { document.graph.staging.chunks.unshift({ sourceId: 'earlier-source', chunkId: 'earlier', startParagraph: -10, endParagraph: 1e20 }) },
    document => { document.graph.staging.chunks = []; document.graph.source.id = null; document.graph.staging.sourceId = 'new-fallback' },
  ]) {
    change(updated); const snapshot = JSON.stringify(updated)
    for (const [, option] of modes) equal(updated, option)
    assert.equal(JSON.stringify(updated), snapshot)
  }
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, samples: 11, alternatedImplementations: true,
  timedScope: 'Actual synchronous source model/learning query computation; excludes instrumentation, assertions, fixture, SQLite, HTTP and browser time',
  completeResponseCases: rows.length, edgeCases, matchedExceptions: exceptions, canonicalReadOnly: true, noHeapMemoryClaim: true, rows }, null, 2))
