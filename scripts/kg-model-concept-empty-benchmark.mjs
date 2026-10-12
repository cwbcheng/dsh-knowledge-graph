import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { conceptQueryModes } from './kg-model-concept-query-fixture.mjs'
import { modelConceptEmptyFixture, emptyConceptModes, conceptSourceIndexWork } from './kg-model-concept-empty-fixture.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-concept-empty-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8e6 })
const queries = [(await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract().connectionModels,
  createGraphContract().connectionModels]
const outcome = (query, document, options) => {
  try { return { response: query(document, { expectedRevision: document.revision, ...options }) } }
  catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } }
}
const rows = []
for (const extraUnits of [32, 8192, 32768]) {
  const document = modelConceptEmptyFixture({ extraUnits }), before = JSON.stringify(document)
  for (const options of [emptyConceptModes[0], emptyConceptModes[2], { concepts: true, query: '检索概念', offset: 20 }]) {
    const args = { expectedRevision: 1, ...options }, expected = queries[0](document, args)
    assert.deepEqual(queries[1](document, args), expected); assert.equal(expected.error, undefined)
    const work = queries.map(query => conceptSourceIndexWork(query, document, args, expected)), total = document.sourceUnits.length
    assert.deepEqual(work[0], { sourceUnitVisits: total, sourceIndexEntries: total, sourceIndexes: 1 })
    assert.deepEqual(work[1], { sourceUnitVisits: total, sourceIndexEntries: expected.items.length ? total : 0, sourceIndexes: expected.items.length ? 1 : 0 })
    for (let warm = 0; warm < 3; warm++) for (const query of queries) query(document, args)
    const samples = [[], []]
    for (let sample = 0; sample < 13; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      const at = performance.now(), response = queries[index](document, args); samples[index].push(performance.now() - at)
      assert.deepEqual(response, expected)
    }
    const stats = values => { values.sort((a, b) => a - b); return { medianMs: values[6], p95Ms: values[12] } }
    const row = { sourceUnits: total, options, baselineWork: work[0], currentWork: work[1], baseline: stats(samples[0]), current: stats(samples[1]) }
    rows.push(row); console.log(JSON.stringify(row))
  }
  assert.equal(JSON.stringify(document), before)
}
const changes = [
  () => {}, document => document.sourceUnits.reverse(),
  document => document.sourceUnits.push({ paragraph: 0, text: '同一身份已变更原文' }),
  document => document.sourceUnits.unshift({ paragraph: 0, text: '前一条同身份记录' }),
  document => { document.sourceUnits[0].paragraph = 10000 }, document => { document.sourceUnits = [] },
  document => { document.sourceUnits = undefined }, document => { document.sourceUnits = null },
  document => { document.sourceUnits = [null] }, document => { document.sourceUnits = [undefined] },
  document => { document.sourceUnits = Array(3); document.sourceUnits[0] = { paragraph: 0, text: '原文' } },
  document => { document.sourceUnits[0].text = 7 }, document => { document.sourceUnits[0].text = null },
  document => { document.sourceText = '甲。\n\n乙。\n\n丙。'; document.sourceUnits = [] },
  document => { document.sourceText = {}; document.sourceUnits = [] },
  document => { document.graph.nodes.reverse(); document.graph.edges.reverse() },
  document => { for (const node of document.graph.nodes) if (node.type === 'concept') node.state = 'rejected' },
  document => { document.graph.source.id = 'another-source' },
  document => { document.graph.nodes.find(node => node.id === 'distance').evidence[0].documentId = 'foreign-document' },
  document => { const node = document.graph.nodes.find(node => node.id === 'distance'); node.evidence.push(...structuredClone(node.evidence), null, { paragraph: 1e9, quote: '不存在' }) },
  document => { document.graph.nodes.push(null) },
  document => { document.sourceUnits = Array(2); document.graph.nodes.push(null) },
  document => { document.sourceUnits[0].paragraph = -1 },
  document => { document.graph.nodes.find(node => node.id === 'taxi').modelStructure.slots[0].conceptId = 'missing-concept' },
]
const modes = [...conceptQueryModes, ...emptyConceptModes, {}, { modelId: 'taxi' }, { modelId: 'taxi', structureEdit: true },
  { modelId: 'taxi', diagnosis: true }, { modelId: 'taxi', structureSources: true }, { modelId: 'taxi', compareModelId: 'multi' },
  { modelId: 'multi', conceptNames: ['__proto__'] }, { concepts: true, query: { toString() { throw new Error('query coercion error') } } }]
let cases = 0
for (const change of changes) {
  const document = modelConceptEmptyFixture(); change(document); const before = JSON.stringify(document)
  for (const options of modes) { assert.deepEqual(outcome(queries[1], document, options), outcome(queries[0], document, options)); cases++ }
  assert.equal(JSON.stringify(document), before)
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, samples: 13, alternatedImplementations: true, fullResponseCases: cases,
  timedScope: 'Actual source query computation; source-entry reads remain; excludes SQLite, HTTP, DOM, counters and equality assertions',
  canonicalReadOnly: true, rows }, null, 2))
