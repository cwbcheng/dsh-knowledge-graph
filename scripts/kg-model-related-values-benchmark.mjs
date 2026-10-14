import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { materialLinksFixture, materialLinksModes, materialLinksQuery, materialLinksWork, materialLinksTrace, materialLinksChanges } from './kg-model-material-links-fixture.mjs'
import { materialValuesWork } from './kg-model-related-values-fixture.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-related-values-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8e6 })
const contracts = [(await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract(), createGraphContract()]
const query = contract => (document, options) => materialLinksQuery(contract, document, options)
const rows = [], stats = values => { values.sort((a, b) => a - b); return { medianMs: values[12], p95Ms: values[23] } }
let cases = 0
const outcome = (contract, document, options) => {
  try { return { response: query(contract)(document, options) } }
  catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } }
}
for (const structured of [false, true]) for (const materials of [25, 512, 4096]) {
  const document = materialLinksFixture({ structured, materials, chunks: 512 }), before = JSON.stringify(document)
  for (const mode of materialLinksModes) { assert.deepEqual(outcome(contracts[1], document, mode), outcome(contracts[0], document, mode)); cases++ }
  for (const offset of [0, 20, materials, materials + 5]) {
    const options = { offset }, expected = query(contracts[0])(document, options)
    const work = contracts.map(contract => materialLinksWork(query(contract), document, options, expected))
    assert.equal(work[0].relatedEntries, materials + 5); assert.equal(work[1].relatedEntries, materials + 5)
    assert.deepEqual(work[1], work[0], 'Identity and link collection are unchanged')
    assert.equal(work[1].linkArrays, expected.related.length)
    assert.equal(work[1].constructedLinks, expected.related.reduce((sum, item) => sum + item.links.length, 0))
    const valueWork = contracts.map(contract => materialValuesWork(query(contract), document, options, expected))
    assert.equal(valueWork[0].valuesYielded, materials + 5)
    assert.equal(valueWork[1].valuesYielded, 0)
    for (let warm = 0; warm < 5; warm++) for (const contract of contracts) query(contract)(document, options)
    const samples = [[], []]
    for (let sample = 0; sample < 25; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      const at = performance.now(), result = query(contracts[index])(document, options)
      samples[index].push(performance.now() - at); assert.deepEqual(result, expected)
    }
    rows.push({ structured, materials, offset, nodes: document.graph.nodes.length, edges: document.graph.edges.length,
      baselineWork: { ...work[0], ...valueWork[0] }, currentWork: { ...work[1], ...valueWork[1] }, baseline: stats(samples[0]), current: stats(samples[1]) })
  }
  assert.equal(JSON.stringify(document), before)
}
for (const structured of [false, true]) for (const change of materialLinksChanges) {
  const document = materialLinksFixture({ structured }); change(document); const before = JSON.stringify(document)
  for (const mode of materialLinksModes) { assert.deepEqual(outcome(contracts[1], document, mode), outcome(contracts[0], document, mode)); cases++ }
  assert.equal(JSON.stringify(document), before)
}

let readOrderCases = 0
for (const structured of [false, true]) {
  const document = materialLinksFixture({ structured, materials: 25 })
  for (const mode of [{}, { offset: 20 }, { offset: 30 }, { structureSources: true }, { diagnosis: true }, { compareModelId: 'right' }, { exercise: 'prediction' }]) {
    const original = materialLinksTrace(query(contracts[0]), document, mode)
    assert.deepEqual(materialLinksTrace(query(contracts[1]), document, mode), original); readOrderCases++
    if (mode.diagnosis || mode.compareModelId || mode.exercise || mode.structureSources) continue
    const labels = [...new Set(original.trace)]
    const failures = [...labels.filter(label => label.startsWith('edge-')).slice(-24),
      ...labels.filter(label => label.endsWith('.id')).slice(-8), ...labels.filter(label => label.endsWith('.type')).slice(-8)]
    for (const label of failures) for (const occurrence of new Set([1, original.trace.filter(item => item === label).length])) {
      const failure = { label, occurrence }
      assert.deepEqual(materialLinksTrace(query(contracts[1]), document, mode, failure), materialLinksTrace(query(contracts[0]), document, mode, failure)); readOrderCases++
    }
  }
  for (const field of ['diagnosis', 'structureSources', 'offset']) for (const value of [true, false, undefined, '20', 20]) for (const inherited of [false, true]) for (const throws of [false, true]) {
    const run = contract => {
      let reads = 0
      const request = { modelId: 'left', expectedRevision: 1 }, target = inherited ? {} : request
      Object.defineProperty(target, field, { get() { reads++; if (throws) throw new TypeError('fixture option ' + field); return value } })
      if (inherited) Object.setPrototypeOf(request, target)
      const result = materialLinksTrace((doc, args) => contract.connectionModels(doc, args), document, request)
      return { ...result, optionReads: reads }
    }
    assert.deepEqual(run(contracts[1]), run(contracts[0])); readOrderCases++
  }
  for (const sequence of [[true, false, false], [false, true, false], [false, false, true]]) {
    const run = contract => {
      let reads = 0
      const request = { modelId: 'left', expectedRevision: 1, offset: 20 }
      Object.defineProperty(request, 'structureSources', { get() { return sequence[Math.min(reads++, sequence.length - 1)] } })
      return { result: materialLinksTrace((doc, args) => contract.connectionModels(doc, args), document, request), reads }
    }
    assert.deepEqual(run(contracts[1]), run(contracts[0])); readOrderCases++
  }
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, samples: 25, alternatedImplementations: true,
  fullResponseCases: cases, readOrderCases, canonicalReadOnly: true, noOffPageValuesArray: true,
  timedScope: 'Actual source query computation only; full identity and relation traversal remains; excludes counters, assertions, SQLite, HTTP, DOM and heap memory', rows }, null, 2))
