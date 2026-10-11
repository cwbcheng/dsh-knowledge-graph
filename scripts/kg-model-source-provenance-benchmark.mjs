import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { modelMaterialPageFixture } from './kg-model-material-page-fixture-data.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-source-provenance-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8e6 })
const baseline = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract(), current = createGraphContract()
const modes = [['detail', {}], ['later-page', { offset: 20 }], ['diagnosis', { diagnosis: true }], ['sources', { structureSources: true }],
  ['comparison', { compareModelId: 'right' }], ...['prediction', 'counterexample', 'understanding'].map(exercise => [exercise, { exercise }])]
const query = (contract, document, options) => (options.exercise ? contract.learningPlan : contract.connectionModels)(document, { modelId: 'left', expectedRevision: document.revision, ...options })
const count = (contract, document, options, expected) => {
  const chunks = document.graph.staging.chunks, find = chunks.find
  let sourceLookups = 0, paragraphVisits = 0
  chunks.find = function(predicate) { sourceLookups++; return find.call(this, (item, index, array) => { paragraphVisits++; return predicate(item, index, array) }) }
  try { assert.deepEqual(query(contract, document, options), expected) }
  finally { delete chunks.find }
  return { sourceLookups, paragraphVisits }
}
const stats = values => { values.sort((a, b) => a - b); return { medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.floor(values.length * .95)] } }
const rows = []
for (const structured of [false, true]) for (const distributed of [false, true]) for (const materials of [25, 512, 4096]) {
  const document = modelMaterialPageFixture({ structured, distributed, materials, chunks: 512 }), before = JSON.stringify(document)
  for (const [mode, options] of modes) {
    const expected = query(baseline, document, options); assert.equal(expected.error, undefined)
    assert.deepEqual(query(current, document, options), expected, 'Every condition, boundary, link, quote and provenance identity must match')
    const baselineWork = count(baseline, document, options, expected), currentWork = count(current, document, options, expected)
    assert(currentWork.sourceLookups < baselineWork.sourceLookups)
    assert(currentWork.sourceLookups <= document.sourceUnits.length)
    for (let index = 0; index < 3; index++) { query(baseline, document, options); query(current, document, options) }
    const samples = [[], []], contracts = [baseline, current]
    // Alternate real, uninstrumented source calls in one runtime. Fixture and equality work are excluded.
    for (let sample = 0; sample < 11; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      const at = performance.now(); query(contracts[index], document, options); samples[index].push(performance.now() - at)
    }
    const row = { structured, distributed, materials, mode, baselineWork, currentWork, baseline: stats(samples[0]), current: stats(samples[1]) }
    rows.push(row); console.log(JSON.stringify(row))
  }
  assert.equal(JSON.stringify(document), before)
}

let edgeCases = 0
const checks = options => [...modes.map(([, option]) => option), ...options]
const changes = [
  document => { document.graph.staging.chunks.unshift({ sourceId: 'wrong-first-source', chunkId: 'first-overlap', startParagraph: 0, endParagraph: 1e12 }) },
  document => { document.graph.staging.chunks.unshift({ startParagraph: 0, endParagraph: 1e12 }) },
  document => { document.graph.staging.chunks.reverse() },
  document => { document.graph.staging.chunks.unshift(null, { startParagraph: '7', endParagraph: 1e12 }, { startParagraph: 1000, endParagraph: -1 }) },
  document => { document.graph.staging.chunks = [] },
  document => { document.graph.staging.chunks = { startParagraph: 0, endParagraph: 1e12 } },
  document => { delete document.graph.staging },
  document => { document.graph.source.id = null; document.graph.staging.sourceId = 'staging-fallback'; document.graph.source.documentId = 'source-document-identity' },
  document => { document.graph.source.id = null; document.graph.staging.sourceId = null; document.graph.source.documentId = null; document.graph.staging.documentId = null },
  document => { document.sourceUnits = [] },
  document => { const unit = document.sourceUnits.at(-1); document.sourceUnits.push({ paragraph: unit.paragraph, text: 'Last stored text for this identity' }) },
  document => { document.graph.nodes.find(node => node.id === 'material-0').evidence.push(null, false,
    ...[-1, 7.5, '7', null, undefined, Number.MAX_SAFE_INTEGER, 1e20].map(paragraph => ({ paragraph, quote: 'not stored' }))) },
  document => { const node = document.graph.nodes.find(node => node.id === 'material-0'); node.evidence.push(...structuredClone(node.evidence),
    { paragraph: node.paragraph, quote: node.evidence[0].quote, documentId: 'wrong-document' },
    { paragraph: node.paragraph, quote: node.evidence[0].quote, sourceId: 'wrong-source' }) },
  document => { document.graph.nodes.find(node => node.id === 'material-0').evidence = []; document.graph.nodes.find(node => node.id === 'left').evidence = [] },
  document => { const model = document.graph.nodes.find(node => node.id === 'left'); if (model.modelStructure) model.modelStructure.slots[0].conceptId = 'missing-concept' },
  document => { document.sourceUnits.reverse(); document.graph.edges.reverse() },
]
const options = checks([{ structureEdit: true }, { offset: 40 }, { offset: -1 }, { offset: '20' }, { structureSources: true, sourceOffset: 12 },
  { diagnosis: true, structureSources: true }, { compareModelId: 'right', diagnosis: true }, { concepts: true },
  { modelId: undefined }, { modelId: 'missing' }, { chainDraft: {} }, { expectedRevision: 0 }])
for (const structured of [false, true]) for (const change of changes) {
  const document = modelMaterialPageFixture({ structured, distributed: true, materials: 25, chunks: 64, rules: true }); change(document)
  const before = JSON.stringify(document)
  for (const option of options) { assert.deepEqual(query(current, document, option), query(baseline, document, option)); edgeCases++ }
  assert.equal(JSON.stringify(document), before)
}
const updated = modelMaterialPageFixture({ materials: 25, chunks: 64 })
for (const change of [
  document => { document.graph.staging.chunks[63].chunkId = 'same-revision-new-chunk' },
  document => { document.graph.staging.chunks.unshift({ sourceId: 'earlier-source', chunkId: 'earlier', startParagraph: 0, endParagraph: 63 }) },
  document => { document.sourceUnits.at(-1).text = 'Changed at the same source identity'; document.revision = 2 },
  document => { document.graph.staging.chunks = []; document.graph.source.id = null; document.graph.staging.sourceId = 'new-fallback' },
]) {
  change(updated); const before = JSON.stringify(updated)
  for (const [, option] of modes) { assert.deepEqual(query(current, updated, option), query(baseline, updated, option)); edgeCases++ }
  assert.equal(JSON.stringify(updated), before)
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, samples: 11, alternatedImplementations: true,
  timedScope: 'Actual synchronous source model/learning query computation; excludes instrumentation, assertions, fixture, SQLite, HTTP and browser time',
  completeResponseCases: rows.length, edgeCases, canonicalReadOnly: true, noHeapMemoryClaim: true, rows }, null, 2))
