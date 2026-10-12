import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { diagnosisRelatedFixture, diagnosisRelatedModes, diagnosisRelatedQuery, diagnosisRelatedWork, diagnosisRelatedTrace } from './kg-model-diagnosis-related-fixture.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-diagnosis-related-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8e6 })
const contracts = [(await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract(), createGraphContract()]
const query = contract => (document, options) => diagnosisRelatedQuery(contract, document, options)
const rows = [], stats = values => { values.sort((a, b) => a - b); return { medianMs: values[12], p95Ms: values[23] } }
let cases = 0
for (const structured of [false, true]) for (const materials of [25, 512, 4096]) {
  const document = diagnosisRelatedFixture({ structured, materials, chunks: 512 }), before = JSON.stringify(document), options = { diagnosis: true }
  const expected = query(contracts[0])(document, options)
  const work = contracts.map(contract => diagnosisRelatedWork(query(contract), document, options, expected))
  assert.equal(work[0].relatedEntries, materials + 5); assert.equal(work[1].relatedEntries, 0)
  for (const mode of diagnosisRelatedModes) { assert.deepEqual(query(contracts[1])(document, mode), query(contracts[0])(document, mode)); cases++ }
  for (let warm = 0; warm < 5; warm++) for (const contract of contracts) query(contract)(document, options)
  const samples = [[], []]
  // Counters, assertions, SQLite, HTTP and DOM are outside the timed calls.
  for (let sample = 0; sample < 25; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
    const at = performance.now(), result = query(contracts[index])(document, options)
    samples[index].push(performance.now() - at); assert.deepEqual(result, expected)
  }
  rows.push({ structured, materials, nodes: document.graph.nodes.length, edges: document.graph.edges.length,
    baselineWork: work[0], currentWork: work[1], baseline: stats(samples[0]), current: stats(samples[1]) })
  assert.equal(JSON.stringify(document), before)
}

const duplicate = (document, id, extra, first = false) => document.graph.nodes[first ? 'unshift' : 'push']({
  ...structuredClone(document.graph.nodes.find(node => node.id === id)), ...extra })
const changes = [() => {}, document => document.graph.nodes.reverse(), document => document.graph.edges.reverse(), document => document.sourceUnits.reverse(),
  ...[{}, { text: '最后一条同身份内容' }, { state: 'rejected' }, { type: 'concept' }].map(extra => document => duplicate(document, 'material-0', extra)),
  document => duplicate(document, 'left', { type: 'concept' }), document => duplicate(document, 'left', { type: 'concept' }, true),
  document => { document.graph.nodes.find(node => node.id === 'material-1').text = document.graph.nodes.find(node => node.id === 'material-0').text },
  document => { document.graph.edges.push(structuredClone(document.graph.edges.find(edge => edge.fromNodeId === 'mapping-material'))) },
  document => { document.graph.edges.push({ fromNodeId: 'left', toNodeId: 'left', relation: 'composes' }) },
  document => { document.graph.edges = document.graph.edges.filter(edge => edge.relation !== 'maps_between') },
  document => { document.graph.edges = [] }, document => { document.graph.edges = [null] }, document => { document.graph.edges = Array(2) },
  document => { document.graph.nodes = document.graph.nodes.filter(node => node.id !== 'material-0') },
  document => { document.graph.nodes = document.graph.nodes.filter(node => node.id !== 'rule-a') },
  document => { document.graph.nodes.find(node => node.id === 'rule-a').type = 'concept' },
  document => { document.graph.nodes.find(node => node.id === 'material-0').evidence = [] },
  document => { document.graph.nodes.find(node => node.id === 'material-20').evidence[0].sourceId = 'foreign-source' },
  document => { document.graph.nodes.find(node => node.id === 'material-20').evidence[0].documentId = 'foreign-document' },
  document => { document.graph.nodes.find(node => node.id === 'material-20').evidence[0].quote = '原文没有这句' },
  document => { document.graph.nodes.find(node => node.id === 'material-20').evidence[0].paragraph = 999999 },
  document => { document.sourceUnits = document.sourceUnits.filter((unit, index) => index % 3 !== 0) },
  document => { document.sourceUnits = [null] }, document => { document.sourceUnits = Array(2) },
  document => { document.graph.nodes.push(null) }, document => { delete document.graph.nodes[0] },
  document => { const model = document.graph.nodes.find(node => node.id === 'left'); if (model.modelStructure) model.modelStructure.slots[0].conceptId = 'missing-concept' },
  document => { const model = document.graph.nodes.find(node => node.id === 'left'); if (model.modelStructure) model.modelStructure.branches[0].condition.provenance.quote = '原文没有这句' },
  document => { for (const node of document.graph.nodes) node.state = 'rejected' },
  document => { for (const [index, id] of ['__proto__', '__PROTO__', 'constructor', 'spaced/id:opaque identity'].entries()) {
    const old = 'material-' + index; document.graph.nodes.find(node => node.id === old).id = id
    for (const edge of document.graph.edges) { if (edge.fromNodeId === old) edge.fromNodeId = id; if (edge.toNodeId === old) edge.toNodeId = id }
  } },
]
const outcome = (contract, document, options) => {
  try { return { response: query(contract)(document, options) } }
  catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } }
}
for (const structured of [false, true]) for (const change of changes) {
  const document = diagnosisRelatedFixture({ structured }); change(document); const before = JSON.stringify(document)
  for (const mode of diagnosisRelatedModes) { assert.deepEqual(outcome(contracts[1], document, mode), outcome(contracts[0], document, mode)); cases++ }
  assert.equal(JSON.stringify(document), before)
}
let readOrderCases = 0
for (const structured of [false, true]) {
  const traceDocument = diagnosisRelatedFixture({ structured, materials: 25 }), options = { diagnosis: true }
  const original = diagnosisRelatedTrace(query(contracts[0]), traceDocument, options)
  assert.deepEqual(diagnosisRelatedTrace(query(contracts[1]), traceDocument, options), original); readOrderCases++
  // Throw at both first and last reads: catches delayed collection or omitted
  // indirect material/rule traversal, not just equality of a happy response.
  const labels = [...new Set(original.trace)]
  const failureLabels = [...labels.filter(label => label.startsWith('edge-')).slice(-24),
    ...labels.filter(label => label.endsWith('.id')).slice(-8), ...labels.filter(label => label.endsWith('.type')).slice(-8)]
  for (const label of failureLabels) {
    const total = original.trace.filter(item => item === label).length
    for (const occurrence of new Set([1, total])) {
      const failure = { label, occurrence }
      assert.deepEqual(diagnosisRelatedTrace(query(contracts[1]), traceDocument, options, failure), diagnosisRelatedTrace(query(contracts[0]), traceDocument, options, failure)); readOrderCases++
    }
  }
  for (const value of [true, false, undefined, 'true']) for (const throws of [false, true]) {
    const run = contract => {
      let reads = 0
      const request = { modelId: 'left', expectedRevision: 1 }
      Object.defineProperty(request, 'diagnosis', { get() { reads++; if (throws) throw new TypeError('fixture diagnosis option'); return value } })
      const result = diagnosisRelatedTrace((doc, args) => contract.connectionModels(doc, args), traceDocument, request)
      return { ...result, optionReads: reads }
    }
    assert.deepEqual(run(contracts[1]), run(contracts[0])); readOrderCases++
  }
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, samples: 25, alternatedImplementations: true,
  fullResponseCases: cases, readOrderCases, canonicalReadOnly: true, diagnosisSkipsRelatedEntries: true,
  timedScope: 'Actual source query computation only; relation, identity and type reads remain; excludes counters, equality checks, SQLite, HTTP, DOM and memory', rows }, null, 2))
