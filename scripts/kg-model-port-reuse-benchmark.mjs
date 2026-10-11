import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { modelPortReuseFixture } from './kg-model-port-reuse-fixture-data.mjs'

const ref = process.argv[2]
assert(ref, 'Usage: node scripts/kg-model-port-reuse-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', ref + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
const baseline = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract().connectionModels
const current = createGraphContract().connectionModels
const rows = []
const count = (query, document, options, expected) => {
  const chunks = document.graph.staging.chunks, find = chunks.find
  let scans = 0, visits = 0
  chunks.find = function (predicate) {
    scans++; return find.call(this, (...args) => { visits++; return predicate(...args) })
  }
  try { assert.deepEqual(query(document, options), expected) }
  finally { delete chunks.find }
  return { scans, visits }
}
const statistics = samples => {
  samples.sort((a, b) => a - b)
  return { medianMs: samples[Math.floor(samples.length / 2)], p95Ms: samples[Math.floor(samples.length * 0.95)] }
}
for (const structured of [false, true]) for (const chunks of [64, 512, 4096]) {
  const document = modelPortReuseFixture({ structured, chunks }), before = JSON.stringify(document)
  for (const mode of ['detail', 'diagnosis', 'sources', 'compare']) {
    const options = { expectedRevision: 1, modelId: 'left', ...(mode === 'diagnosis' ? { diagnosis: true }
      : mode === 'sources' ? { structureSources: true } : mode === 'compare' ? { compareModelId: 'right' } : {}) }
    const expected = baseline(document, options)
    assert(!expected.error, JSON.stringify(expected.error))
    assert.deepEqual(current(document, options), expected, 'Complete responses must preserve every identity, role, condition, boundary and citation')
    const oldWork = count(baseline, document, options, expected), newWork = count(current, document, options, expected)
    for (let index = 0; index < 4; index++) { baseline(document, options); current(document, options) }
    const oldSamples = [], newSamples = []
    // Alternate actual implementations in one runtime. Instrumentation and equality checks are outside timing.
    for (let index = 0; index < 15; index++) for (const [query, samples] of index % 2
      ? [[current, newSamples], [baseline, oldSamples]] : [[baseline, oldSamples], [current, newSamples]]) {
      const started = performance.now(); query(document, options); samples.push(performance.now() - started)
    }
    rows.push({ structured, chunks, mode, baseline: { ...oldWork, ...statistics(oldSamples) }, current: { ...newWork, ...statistics(newSamples) } })
    assert.equal(JSON.stringify(document), before, 'Neither implementation may mutate the canonical input')
  }
}
let edgeCases = 0
for (const structured of [false, true]) for (const change of [
  document => { document.graph.nodes[0].evidence[0].sourceId = 'another-source' },
  document => { document.graph.nodes[0].evidence[0].documentId = 'another-document' },
  document => { document.graph.nodes[0].evidence[0].quote = 'A quotation absent from source' },
  document => { document.graph.nodes[0].state = 'rejected' },
  document => { document.graph.edges[0].role = 'unknown' },
  document => { document.graph.edges[0].state = 'rejected' },
  document => { document.graph.edges.push(structuredClone(document.graph.edges[0])) },
  document => { document.graph.nodes = document.graph.nodes.filter(node => node.id !== 'port-0') },
  document => { document.graph.edges = [] },
  document => { for (const node of document.graph.nodes) if (node.modelStructure) node.modelStructure.slots = [] },
]) {
  const document = modelPortReuseFixture({ structured, chunks: 64 }); change(document)
  const before = JSON.stringify(document)
  for (const options of [{}, { diagnosis: true }, { structureSources: true }, { structureEdit: true }, { compareModelId: 'right' }]) {
    const args = { expectedRevision: 1, modelId: 'left', ...options }
    assert.deepEqual(current(document, args), baseline(document, args), 'Invalid, empty and ambiguous endpoints keep the same complete response')
    edgeCases++
  }
  assert.equal(JSON.stringify(document), before)
}
const catalogue = modelPortReuseFixture({ chunks: 64 }), template = catalogue.graph.nodes.find(node => node.id === 'left')
const templateEdges = catalogue.graph.edges.filter(edge => edge.fromNodeId === 'left')
catalogue.graph.nodes = catalogue.graph.nodes.filter(node => node.type === 'concept'); catalogue.graph.edges = []
for (let index = 0; index < 128; index++) {
  const model = structuredClone(template); model.id = 'catalogue-' + index
  catalogue.graph.nodes.push(model)
  catalogue.graph.edges.push(...templateEdges.map(edge => ({ ...structuredClone(edge), fromNodeId: model.id })))
}
const catalogueBefore = JSON.stringify(catalogue)
const catalogueOptions = [{}, { offset: 120 }, { query: '对象、时间与条件' }, { peerOf: 'catalogue-0' },
  { chainOf: 'catalogue-0' }, { conceptId: 'port-0', role: 'input' }]
for (const options of catalogueOptions) assert.deepEqual(current(catalogue, { expectedRevision: 1, ...options }), baseline(catalogue, { expectedRevision: 1, ...options }))
assert.equal(JSON.stringify(catalogue), catalogueBefore)
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, timedScope: 'source contract only; excludes HTTP, SQLite and browser rendering',
  alternatedImplementations: true, completeResponseCases: rows.length, edgeCases, catalogueCases: catalogueOptions.length, catalogueModels: 128, readOnly: true, rows }, null, 2))
