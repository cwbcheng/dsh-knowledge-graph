import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { modelConceptQueryFixture, conceptQueryWork, conceptQueryModes } from './kg-model-concept-query-fixture.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-concept-query-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8e6 })
const queries = [(await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract().connectionModels,
  createGraphContract().connectionModels]
const result = (query, document, options) => {
  try { return { response: query(document, { expectedRevision: document.revision, ...options }) } }
  catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } }
}
const stats = values => { values.sort((a, b) => a - b); return { medianMs: values[6], p95Ms: values[12] } }
const rows = []
let cases = 0
for (const models of [32, 4096, 16384]) {
  const document = modelConceptQueryFixture({ models }), before = JSON.stringify(document)
  for (const options of [conceptQueryModes[0], conceptQueryModes[1], conceptQueryModes[4]]) {
    const args = { expectedRevision: 1, ...options }, expected = queries[0](document, args)
    assert.deepEqual(queries[1](document, args), expected); assert.equal(expected.error, undefined)
    const work = queries.map(query => conceptQueryWork(query, document, args, expected))
    assert.deepEqual(work[0], { indexedNodes: document.graph.nodes.length, indexedEdges: document.graph.edges.length })
    assert.deepEqual(work[1], { indexedNodes: 0, indexedEdges: 0 })
    for (let warm = 0; warm < 3; warm++) for (const query of queries) query(document, args)
    const samples = [[], []]
    // Alternating actual source computation only; no counters, IO or assertions in the timed span.
    for (let sample = 0; sample < 13; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      const at = performance.now(); const response = queries[index](document, args); samples[index].push(performance.now() - at)
      assert.deepEqual(response, expected)
    }
    const row = { models, nodes: document.graph.nodes.length, edges: document.graph.edges.length, options,
      baselineWork: work[0], currentWork: work[1], baseline: stats(samples[0]), current: stats(samples[1]) }
    rows.push(row); console.log(JSON.stringify(row))
  }
  assert.equal(JSON.stringify(document), before)
}
const changes = [
  () => {}, document => { document.graph.edges = [] }, document => { document.graph.edges.reverse(); document.graph.nodes.reverse() },
  document => { document.sourceUnits = [] }, document => { document.sourceUnits.reverse() },
  document => { document.graph.source.id = 'different-source' },
  document => { document.graph.nodes.find(node => node.id === 'distance').evidence.push(null, { paragraph: 0, quote: 'not in source' }) },
  document => { const node = document.graph.nodes.find(node => node.id === 'distance'); node.evidence.push(...structuredClone(node.evidence)) },
  document => { document.graph.nodes.find(node => node.id === 'distance').evidence[0].documentId = 'foreign-document' },
  document => { document.graph.nodes.find(node => node.id === 'distance').state = 'rejected' },
  document => { document.sourceUnits[0].text = 7 },
  document => { document.graph.nodes.find(node => node.id === 'taxi').modelStructure.slots[0].conceptId = 'missing-concept' },
]
const modes = [...conceptQueryModes, {}, { modelId: 'taxi' }, { modelId: 'taxi', structureEdit: true },
  { modelId: 'taxi', diagnosis: true }, { modelId: 'taxi', structureSources: true },
  { modelId: 'taxi', compareModelId: 'multi' }, { modelId: 'multi', conceptNames: ['__proto__'] }, { concepts: false, modelId: 'taxi' }]
for (const change of changes) {
  const document = modelConceptQueryFixture(); change(document)
  const before = JSON.stringify(document)
  for (const options of modes) { assert.deepEqual(result(queries[1], document, options), result(queries[0], document, options)); cases++ }
  assert.equal(JSON.stringify(document), before)
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, samples: 13, alternatedImplementations: true, fullResponseCases: cases,
  timedScope: 'Actual source concept query computation; excludes SQLite, HTTP, browser rendering, counters and equality assertions',
  canonicalReadOnly: true, rows }, null, 2))
