import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { createGraphContract } from '../src/index.host.js'
import { modelBranchCountsFixture } from './kg-model-branch-counts-fixture-data.mjs'
import { modelDiagnosticChanges } from './kg-model-diagnostic-pair-fixture-data.mjs'
import { modelSummarySignaturesFixture } from './kg-model-summary-signatures-fixture.mjs'
import { diagnosticIdentityFixture, diagnosticIdentityCases, diagnosticIdentityTrace } from './kg-model-diagnostic-identities-fixture.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-diagnostic-identities-compare.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const load = async file => import('data:text/javascript;base64,' + Buffer.from(execFileSync('git', ['show', baselineCommit + ':' + file],
  { cwd, encoding: 'utf8', maxBuffer: 8e6 })).toString('base64'))
const tools = [(await load('src/kg-model-structure.mjs')).createModelStructureTools(), createModelStructureTools()]
const contracts = [(await load('src/index.host.js')).createGraphContract(), createGraphContract()]
const result = callback => { try { return { response: callback() } } catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } } }
const withoutDifference = outcome => {
  if (outcome.exception) return outcome
  const report = outcome.response, differences = report.items.filter(item => item.code === 'legacy_difference').length
  return { response: { ...report, items: report.items.filter(item => item.code !== 'legacy_difference'), total: report.total - differences,
    counts: { ...report.counts, review: report.counts.review - differences } } }
}
let unchangedCases = 0, correctedCases = 0, readOrderCases = 0, coercionCases = 0, hostCases = 0
for (const slots of [2, 40]) for (const change of modelDiagnosticChanges) {
  const document = modelBranchCountsFixture({ slots }), structure = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  change(document, structure)
  const context = { ports: [{ node: { nodeId: 'distance', text: '独立旧端点' }, role: 'unknown', editable: false,
    citations: [{ paragraph: 0, quote: '条件 A 下，仍待核对' }] }], names: { distance: '记录名称' }, cautions: ['原文待核对'] }
  const runs = tools.map(tool => result(() => tool.diagnose(structure, context)))
  assert.deepEqual(runs[1], runs[0]); unchangedCases++
  for (const options of [{ modelId: 'taxi', diagnosis: true }, { modelId: 'taxi', structureSources: true }, { modelId: 'taxi', compareModelId: 'multi' }]) {
    const runs = contracts.map(contract => result(() => contract.connectionModels(document, { expectedRevision: 1, ...options })))
    assert.deepEqual(runs[1], runs[0]); hostCases++
  }
}
for (const value of [undefined, null, false, 0, '', 1, 'raw', [], {}, { slots: null }, { examples: [null] }]) {
  assert.deepEqual(result(() => tools[1].diagnose(value)), result(() => tools[0].diagnose(value))); unchangedCases++
}
for (const test of diagnosticIdentityCases) {
  const { structure, ports } = diagnosticIdentityFixture(test.identity); test.change(ports[0])
  const runs = tools.map(tool => result(() => tool.diagnose(structure, { ports })))
  assert(!runs[0].response.items.some(item => item.code === 'legacy_difference'), test.name + ' must reproduce the old omission')
  assert(runs[1].response.items.some(item => item.code === 'legacy_difference'))
  assert.deepEqual(withoutDifference(runs[1]), withoutDifference(runs[0])); correctedCases++
}
for (const identity of ['distance', 'undefined', 'part:string:input']) {
  const { structure, ports } = diagnosticIdentityFixture(identity)
  const baseline = diagnosticIdentityTrace(tools[0].diagnose, structure, ports)
  assert.deepEqual(diagnosticIdentityTrace(tools[1].diagnose, structure, ports), baseline); readOrderCases++
  for (const key of new Set(baseline.trace)) for (const occurrence of new Set([1, baseline.trace.filter(item => item === key).length])) {
    const failAt = { key, occurrence }
    assert.deepEqual(diagnosticIdentityTrace(tools[1].diagnose, structure, ports, failAt), diagnosticIdentityTrace(tools[0].diagnose, structure, ports, failAt)); readOrderCases++
  }
}
for (const fails of [0, 1, 2]) {
  const runs = tools.map(tool => {
    const { structure, ports } = diagnosticIdentityFixture(), trace = []
    let reads = 0
    ports[0].node.nodeId = { toString() { trace.push('identity'); if (++reads === fails) throw new TypeError('identity coercion'); return 'undefined' } }
    Object.defineProperty(ports[0], 'role', { get() { trace.push('role'); return 'input' } })
    return { outcome: withoutDifference(result(() => tool.diagnose(structure, { ports }))), trace }
  })
  assert.deepEqual(runs[1], runs[0]); coercionCases++
}
// The diagnostic path keeps custom array sorting and serialization. Count
// shortcuts cannot assume that these raw arrays serialize their own members.
for (const fails of ['none', 'sort', 'toJSON']) {
  const runs = tools.map(tool => {
    const { structure } = diagnosticIdentityFixture(), trace = []
    let slotStrings
    const stringify = JSON.stringify
    class Ports extends Array {
      sort(...args) { trace.push('sort'); if (fails === 'sort') throw new TypeError('custom sort'); return super.sort(...args) }
      toJSON() { trace.push('toJSON'); if (fails === 'toJSON') throw new TypeError('custom JSON'); return slotStrings }
    }
    JSON.stringify = function(value, ...args) {
      if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.every(item => typeof item === 'string')) slotStrings = [...value]
      return stringify.call(this, value, ...args)
    }
    let outcome
    try { outcome = result(() => tool.diagnose(structure, { ports: new Ports({ node: { nodeId: 'extra' }, role: 'input', editable: true }) })) }
    finally { JSON.stringify = stringify }
    return { outcome, trace }
  })
  assert.deepEqual(runs[1], runs[0]); unchangedCases++
}
const rows = [], stats = values => { values.sort((a, b) => a - b); return { medianMs: values[12], p95Ms: values[23] } }
for (const endpoints of [40, 1024, 4096]) {
  const document = modelSummarySignaturesFixture({ models: 1, endpoints })
  const structure = document.graph.nodes.find(node => node.type === 'connection_model').modelStructure
  const ports = contracts[1].connectionModels(document, { expectedRevision: 1, modelId: 'catalogue-000', structureEdit: true }).legacyPorts
  const before = JSON.stringify({ structure, ports }), expected = tools[0].diagnose(structure, { ports }), samples = [[], []]
  assert.deepEqual(tools[1].diagnose(structure, { ports }), expected)
  for (let warm = 0; warm < 8; warm++) for (const tool of tools) tool.diagnose(structure, { ports })
  for (let sample = 0; sample < 25; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
    const start = performance.now()
    for (let repeat = 0; repeat < 8; repeat++) tools[index].diagnose(structure, { ports })
    samples[index].push((performance.now() - start) / 8)
  }
  assert.equal(JSON.stringify({ structure, ports }), before)
  rows.push({ endpoints, baseline: stats(samples[0]), current: stats(samples[1]) })
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, unchangedCases, correctedCases, readOrderCases,
  coercionCases, hostCases, arraysStillSortedAndSerialized: true, samples: 25, repeats: 8,
  timedScope: 'Standalone synchronous source diagnosis; fixtures, assertions, counters, Host, SQLite, HTTP, browser and heap excluded', rows }, null, 2))
