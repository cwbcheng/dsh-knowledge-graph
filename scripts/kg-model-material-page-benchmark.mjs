import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { modelMaterialPageFixture } from './kg-model-material-page-fixture-data.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-material-page-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
const baseline = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract(), current = createGraphContract()
const modes = [['detail', {}], ['later-page', { offset: 20 }], ['diagnosis', { diagnosis: true }], ['sources', { structureSources: true }],
  ['comparison', { compareModelId: 'right' }], ...['prediction', 'counterexample', 'understanding'].map(exercise => [exercise, { exercise }])]
const query = (contract, document, options) => (options.exercise ? contract.learningPlan : contract.connectionModels)(document, { modelId: 'left', expectedRevision: 1, ...options })
const count = (contract, document, options, expected) => {
  const chunks = document.graph.staging.chunks, nativeFind = chunks.find
  let sourceLookups = 0, paragraphVisits = 0
  chunks.find = function(predicate) { sourceLookups++; return nativeFind.call(this, (item, index, array) => { paragraphVisits++; return predicate(item, index, array) }) }
  try { assert.deepEqual(query(contract, document, options), expected) }
  finally { delete chunks.find }
  return { sourceLookups, paragraphVisits }
}
const stats = values => { values.sort((a, b) => a - b); return { medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.floor(values.length * 0.95)] } }
const rows = []
for (const structured of [false, true]) for (const materials of [25, 512, 4096]) {
  const document = modelMaterialPageFixture({ structured, materials, chunks: 512 }), before = JSON.stringify(document)
  for (const [mode, options] of modes) {
    const expected = query(baseline, document, options); assert.equal(expected.error, undefined)
    assert.deepEqual(query(current, document, options), expected, 'Every field, material link, source context, condition, boundary and citation must match')
    const baselineWork = count(baseline, document, options, expected), currentWork = count(current, document, options, expected)
    if (mode === 'sources') assert.deepEqual(currentWork, baselineWork, 'Full source selection must not skip material evidence')
    else assert(currentWork.sourceLookups < baselineWork.sourceLookups)
    for (let warm = 0; warm < 3; warm++) { query(baseline, document, options); query(current, document, options) }
    const oldSamples = [], newSamples = []
    // Timed calls are uninstrumented and alternate actual source implementations in one runtime.
    for (let index = 0; index < 11; index++) for (const [contract, samples] of index % 2
      ? [[current, newSamples], [baseline, oldSamples]] : [[baseline, oldSamples], [current, newSamples]]) {
      const start = performance.now(); query(contract, document, options); samples.push(performance.now() - start)
    }
    const row = { structured, materials, mode, baselineWork, currentWork, baseline: stats(oldSamples), current: stats(newSamples) }
    rows.push(row); console.log(JSON.stringify(row))
  }
  assert.equal(JSON.stringify(document), before)
}
let edgeCases = 0
const changes = [
  document => { document.graph.nodes.find(node => node.id === 'material-0').evidence = [] },
  document => { document.graph.nodes.find(node => node.id === 'material-20').evidence[0].sourceId = 'different-source' },
  document => { document.graph.nodes.find(node => node.id === 'material-0').evidence[0].documentId = 'different-document' },
  document => { document.graph.nodes.find(node => node.id === 'material-0').evidence[0].quote = 'Missing full quotation' },
  document => { const node = document.graph.nodes.find(node => node.id === 'material-20'); node.paragraph = 999999; node.evidence[0].paragraph = 999999 },
  document => { const node = document.graph.nodes.find(node => node.id === 'material-0'); node.evidence.push(...structuredClone(node.evidence)) },
  document => { document.graph.nodes.find(node => node.id === 'material-0').state = 'rejected' },
  document => { document.graph.nodes = document.graph.nodes.filter(node => node.id !== 'material-0') },
  document => { document.graph.nodes.push({ ...structuredClone(document.graph.nodes.find(node => node.id === 'material-0')), text: 'Last canonical entry for this identity' }) },
  document => { document.graph.edges.push(structuredClone(document.graph.edges.find(edge => edge.fromNodeId === 'material-0'))) },
  document => { document.graph.edges.reverse(); document.sourceUnits.reverse() },
  document => { document.graph.edges = [] },
  document => { const model = document.graph.nodes.find(node => node.id === 'left'); if (model.modelStructure) model.modelStructure.slots[0].conceptId = 'missing-concept' },
  document => { document.graph.nodes.find(node => node.id === 'left').evidence = [] },
  document => { document.graph.edges.push({ fromNodeId: 'left', toNodeId: 'left', relation: 'composes' }) },
]
const options = [...modes.map(([, options]) => options), { offset: 40 }, { offset: 100 }, { offset: -1 }, { offset: '20' },
  { structureSources: true, sourceOffset: 12 }, { structureSources: true, sourceOffset: 100 }, { diagnosis: true, structureSources: true },
  { compareModelId: 'right', structureEdit: true }, { compareModelId: 'right', diagnosis: true }, { branchId: 'missing-branch' },
  { structureEdit: true }, { expectedRevision: 0 }, { expectedRevision: undefined }]
for (const structured of [false, true]) for (const change of changes) {
  const document = modelMaterialPageFixture({ structured, materials: 25, chunks: 64, distributed: true, rules: true }); change(document)
  const before = JSON.stringify(document)
  for (const option of options) { assert.deepEqual(query(current, document, option), query(baseline, document, option)); edgeCases++ }
  assert.equal(JSON.stringify(document), before)
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, samples: 11, alternatedImplementations: true,
  timedScope: 'Actual source model/learning query computation only; excludes instrumentation, equality checks, SQLite, HTTP and browser rendering',
  completeResponseCases: rows.length, edgeCases, canonicalReadOnly: true, rows }, null, 2))
