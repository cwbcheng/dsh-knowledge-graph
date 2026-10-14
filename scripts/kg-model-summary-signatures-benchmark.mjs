import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { modelSummarySignaturesFixture, summarySignaturesWork } from './kg-model-summary-signatures-fixture.mjs'
import { summaryRolesTrace } from './kg-model-summary-roles-fixture.mjs'
import { materialLinksFixture, materialLinksQuery, materialLinksModes, materialLinksChanges } from './kg-model-material-links-fixture.mjs'
import { modelCatalogueSelectorsFixture, modelCatalogueSelectorsModes } from './kg-model-catalogue-selectors-fixture-data.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-summary-signatures-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8e6 })
const contracts = [(await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract(), createGraphContract()]
const query = contract => (document, options = {}) => contract.connectionModels(document, { expectedRevision: document.revision, ...options })
const outcome = (read, document, options) => {
  try { return { response: read(document, options) } }
  catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } }
}
const stats = values => { values.sort((a,b) => a-b); return { medianMs: values[12], p95Ms: values[23] } }
const rows = []
for (const models of [8, 32]) for (const endpoints of [40, 256, 1024]) {
  const document = modelSummarySignaturesFixture({ models, endpoints }), before = JSON.stringify(document)
  const expected = query(contracts[0])(document), work = contracts.map(contract => summarySignaturesWork(query(contract), document, {}, expected))
  assert.equal(work[1].sourceLookups, work[0].sourceLookups)
  if (endpoints === 40) assert.deepEqual(work[1], work[0])
  else { assert.equal(work[0].sortValues - work[1].sortValues, models * endpoints); assert.equal(work[1].jsonCalls, 0) }
  for (let warm = 0; warm < 4; warm++) for (const contract of contracts) query(contract)(document)
  const samples = [[], []]
  for (let sample = 0; sample < 25; sample++) for (const index of sample % 2 ? [1,0] : [0,1]) {
    const at = performance.now(), result = query(contracts[index])(document)
    samples[index].push(performance.now() - at); assert.deepEqual(result, expected)
  }
  rows.push({ models, slots: 40, endpoints, baselineWork: work[0], currentWork: work[1], baseline: stats(samples[0]), current: stats(samples[1]) })
  assert.equal(JSON.stringify(document), before)
}
let responseCases = 0, exceptions = 0, readOrderCases = 0
const equal = (reads, document, options) => {
  const expected = outcome(reads[0], document, options)
  assert.deepEqual(outcome(reads[1], document, options), expected); responseCases++; if (expected.exception) exceptions++
}
for (const structured of [false, true]) {
  const document = modelCatalogueSelectorsFixture({ structured })
  for (const options of modelCatalogueSelectorsModes) equal(contracts.map(query), document, options)
  for (const change of materialLinksChanges) {
    const material = materialLinksFixture({ structured }); change(material); const before = JSON.stringify(material)
    const reads = contracts.map(contract => (doc, args) => materialLinksQuery(contract, doc, args))
    for (const options of [{}, ...materialLinksModes]) equal(reads, material, options)
    assert.equal(JSON.stringify(material), before)
  }
}
for (const endpoints of [0, 1, 39, 40, 41, 256]) {
  const document = modelSummarySignaturesFixture({ models: 2, endpoints })
  for (const options of [{}, { query: 'absent' }, { needsReview: true }, { offset: 20 },
    { modelId: 'catalogue-000' }, { modelId: 'catalogue-000', diagnosis: true },
    { modelId: 'catalogue-000', structureSources: true }, { modelId: 'catalogue-000', compareModelId: 'catalogue-001' }]) equal(contracts.map(query), document, options)
  for (const options of [{}, { modelId: 'catalogue-000', diagnosis: true }, { modelId: 'catalogue-000', compareModelId: 'catalogue-001' }]) {
    const reads = contracts.map(query), original = summaryRolesTrace(reads[0], document, options)
    assert.deepEqual(summaryRolesTrace(reads[1], document, options), original); readOrderCases++
    const labels = [...new Set(original.trace)], failures = [...labels.filter(label => label.endsWith('.role')).slice(-6),
      ...labels.filter(label => label.endsWith('.text') || label.endsWith('.quote')).slice(-6)]
    for (const label of failures) for (const occurrence of new Set([1, original.trace.filter(item => item === label).length])) {
      const failAt = { label, occurrence }
      assert.deepEqual(summaryRolesTrace(reads[1], document, options, failAt), summaryRolesTrace(reads[0], document, options, failAt)); readOrderCases++
    }
  }
}
// Damaged raw identities can coerce or throw. Keep all identity string reads,
// even when different counts make sorting and JSON comparison unnecessary.
let coercionCases = 0
for (const fails of [0, 1, 2, 3, 4, 5, 6]) {
  const document = modelSummarySignaturesFixture({ models: 1, endpoints: 41 }), node = document.graph.nodes.find(node => node.id === 'port-40')
  let reads = 0
  const identity = { toString() { reads++; if (reads === fails) throw new TypeError('raw identity coercion ' + reads); return 'coerced-extra' } }
  node.id = identity
  document.graph.edges.find(edge => edge.toNodeId === 'port-40').toNodeId = identity
  const runs = contracts.map(contract => { reads = 0; const result = outcome(query(contract), document, {}); return { result, reads } })
  assert.deepEqual(runs[1], runs[0]); coercionCases++
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, responseCases, exceptions, readOrderCases, coercionCases,
  samples: 25, alternatedImplementations: true, fullSourceValidation: true, canonicalReadOnly: true,
  timedScope: 'Synchronous source model queries; counters, assertions, fixtures, SQLite, HTTP, browser and heap memory excluded', rows }, null, 2))
