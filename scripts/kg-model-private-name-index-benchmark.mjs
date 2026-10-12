import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { conceptQueryModes } from './kg-model-concept-query-fixture.mjs'
import { modelPrivateNameFixture, privateNameRequests, privateNameModes, privateNameIndexWork } from './kg-model-private-name-index-fixture.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-private-name-index-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8e6 })
const queries = [(await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract().connectionModels,
  createGraphContract().connectionModels]
const outcome = (query, document, extra) => {
  try { return { response: query(document, { expectedRevision: 1, modelId: 'multi', ...extra }) } }
  catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } }
}
const rows = []
for (const models of [32, 8192, 32768]) {
  const document = modelPrivateNameFixture({ models }), before = JSON.stringify(document)
  for (const conceptNames of privateNameRequests) {
    const args = { expectedRevision: 1, modelId: 'multi', conceptNames }, expected = queries[0](document, args)
    assert.deepEqual(queries[1](document, args), expected)
    const work = queries.map(query => privateNameIndexWork(query, document, args, expected)), total = document.graph.nodes.length
    assert.deepEqual(work[0], { nodeVisits: total, edgeVisits: 0, sourceUnitVisits: 0, graphIndexEntries: total })
    assert.deepEqual(work[1], { nodeVisits: total, edgeVisits: 0, sourceUnitVisits: 0, graphIndexEntries: conceptNames.length + 1 })
    for (let warm = 0; warm < 5; warm++) for (const query of queries) query(document, args)
    const samples = [[], []]
    for (let sample = 0; sample < 25; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      const at = performance.now(), result = queries[index](document, args)
      samples[index].push(performance.now() - at); assert.deepEqual(result, expected)
    }
    const stats = values => { values.sort((a, b) => a - b); return { medianMs: values[12], p95Ms: values[23] } }
    rows.push({ nodes: total, edges: document.graph.edges.length, requestedIds: conceptNames.length,
      baselineWork: work[0], currentWork: work[1], baseline: stats(samples[0]), current: stats(samples[1]) })
  }
  assert.equal(JSON.stringify(document), before)
}
const duplicate = (document, id, extra, first = false) => {
  const node = { ...structuredClone(document.graph.nodes.find(n => n.id === id)), ...extra }
  document.graph.nodes[first ? 'unshift' : 'push'](node)
}
const changes = [
  () => {}, document => document.graph.nodes.reverse(), document => document.graph.edges.reverse(),
  document => duplicate(document, '__proto__', { text: '最后一条不同名称' }),
  document => duplicate(document, '__proto__', { text: '第一条不同名称' }, true),
  document => duplicate(document, '__proto__', { state: 'rejected' }),
  document => duplicate(document, '__proto__', { type: 'rule' }),
  document => duplicate(document, 'multi', { type: 'concept' }),
  document => duplicate(document, 'multi', { type: 'concept' }, true),
  document => duplicate(document, 'multi', { state: 'rejected' }),
  document => { for (const node of document.graph.nodes) if (node.type === 'concept') node.state = 'rejected' },
  ...[null, undefined, 0, '', false].map(value => document => document.graph.nodes.push(value)),
  document => { document.graph.nodes.length += 2 }, document => { delete document.graph.nodes[0] },
  document => { delete document.graph.nodes[document.graph.nodes.length - 1] },
  document => { delete document.graph.nodes[0]; document.graph.nodes.push(null) },
  document => { document.graph.nodes.find(n => n.id === '__proto__').text = 7 },
  document => { document.graph.nodes.find(n => n.id === '__proto__').text = null },
  document => { delete document.graph.nodes.find(n => n.id === '__proto__').id },
  document => { document.graph.nodes.push({ id: undefined, type: 'concept', text: '无身份旧节点' }) },
  document => { document.sourceUnits = [null] }, document => { document.sourceUnits = Array(3) },
  document => { document.sourceText = {}; document.sourceUnits = [] },
  document => { document.graph.nodes.find(n => n.id === 'distance').evidence[0].documentId = 'other-document' },
  document => { document.graph.nodes.find(n => n.id === 'taxi').modelStructure.slots[0].conceptId = 'missing-concept' },
  document => { document.graph.nodes = [] }, document => { document.graph.nodes = null }, document => { document.graph = null },
]
const modes = [...privateNameModes, ...conceptQueryModes, { conceptNames: Array(1) },
  { conceptNames: ['__proto__', ,] }, { conceptNames: ['__proto__', '__PROTO__', 'constructor', 'spaced/id:opaque identity'] },
  {}, { modelId: 'taxi' }, { modelId: 'taxi', structureEdit: true }, { modelId: 'taxi', structureSources: true },
  { modelId: 'taxi', diagnosis: true }, { modelId: 'taxi', compareModelId: 'multi' }, { expectedRevision: '1', conceptNames: [] }]
let cases = 0
for (const change of changes) {
  const document = modelPrivateNameFixture(); change(document); const before = JSON.stringify(document)
  for (const extra of modes) { assert.deepEqual(outcome(queries[1], document, extra), outcome(queries[0], document, extra)); cases++ }
  assert.equal(JSON.stringify(document), before)
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, samples: 25, alternatedImplementations: true,
  fullResponseCases: cases, timedScope: 'Actual source query computation only; all node identity reads remain; excludes SQLite, HTTP, DOM, memory, counters and equality assertions',
  canonicalReadOnly: true, rows }, null, 2))
