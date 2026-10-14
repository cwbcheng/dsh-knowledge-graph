import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { modelSummaryRolesFixture, summaryRolesWork, summaryRolesTrace } from './kg-model-summary-roles-fixture.mjs'
import { modelCatalogueSelectorsFixture, modelCatalogueSelectorsModes } from './kg-model-catalogue-selectors-fixture-data.mjs'
import { materialLinksFixture, materialLinksQuery, materialLinksTrace, materialLinksModes, materialLinksChanges } from './kg-model-material-links-fixture.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-summary-roles-benchmark.mjs <baseline-commit> [--measure-baseline]')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8e6 })
const contracts = [(await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract(), createGraphContract()]
const query = contract => (document, options = {}) => contract.connectionModels(document, { expectedRevision: document.revision, ...options })
const outcome = (read, document, options) => {
  try { return { response: read(document, options) } }
  catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } }
}
if (process.argv.includes('--measure-baseline')) {
  const rows = [false, true].map(structured => {
    const document = modelSummaryRolesFixture({ structured }), expected = query(contracts[0])(document)
    return { structured, ...summaryRolesWork(query(contracts[0]), document, {}, expected) }
  })
  assert.equal(rows[0].roleReads, 128 * 40 * 4)
  assert.equal(rows[1].roleReads, 128 * 40 * 6)
  console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, rows }, null, 2))
  process.exit(0)
}
const stats = samples => { samples.sort((a, b) => a - b); return { medianMs: samples[12], p95Ms: samples[23] } }
const rows = []
for (const structured of [false, true]) for (const models of [32, 256]) {
  const document = modelSummaryRolesFixture({ structured, models }), before = JSON.stringify(document)
  for (const options of [{}, { offset: models - 8 }, { query: 'absent' }]) {
    const expected = query(contracts[0])(document, options)
    assert.equal(expected.error, undefined)
    assert.deepEqual(query(contracts[1])(document, options), expected)
    const work = contracts.map(contract => summaryRolesWork(query(contract), document, options, expected))
    assert.equal(work[1].projectedPorts, work[0].projectedPorts)
    assert.equal(work[1].sourceLookups, work[0].sourceLookups, 'Full quotation validation includes unreturned models')
    assert.equal(work[0].roleReads - work[1].roleReads, models * 40 * 3)
    for (let warm = 0; warm < 4; warm++) for (const contract of contracts) query(contract)(document, options)
    const samples = [[], []]
    // Actual synchronous queries only; observation and equality are outside timings.
    for (let sample = 0; sample < 25; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      const at = performance.now(), response = query(contracts[index])(document, options)
      samples[index].push(performance.now() - at); assert.deepEqual(response, expected)
    }
    rows.push({ structured, models, options, baselineWork: work[0], currentWork: work[1], baseline: stats(samples[0]), current: stats(samples[1]) })
  }
  assert.equal(JSON.stringify(document), before)
}
let responseCases = 0, readOrderCases = 0, exceptions = 0
const equal = (reads, document, options) => {
  const expected = outcome(reads[0], document, options)
  assert.deepEqual(outcome(reads[1], document, options), expected)
  responseCases++; if (expected.exception) exceptions++
}
for (const structured of [false, true]) {
  const document = modelCatalogueSelectorsFixture({ structured }), before = JSON.stringify(document)
  for (const options of modelCatalogueSelectorsModes) equal(contracts.map(query), document, options)
  assert.equal(JSON.stringify(document), before)
  for (const change of materialLinksChanges) {
    const material = materialLinksFixture({ structured }); change(material); const before = JSON.stringify(material)
    const reads = contracts.map(contract => (doc, args) => materialLinksQuery(contract, doc, args))
    for (const options of [{}, ...materialLinksModes]) equal(reads, material, options)
    assert.equal(JSON.stringify(material), before)
  }
  const material = materialLinksFixture({ structured, materials: 25 })
  for (const options of [{}, { diagnosis: true }, { structureSources: true }, { compareModelId: 'right' }, { exercise: 'prediction' }]) {
    const reads = contracts.map(contract => (doc, args) => materialLinksQuery(contract, doc, args))
    const original = materialLinksTrace(reads[0], material, options)
    assert.deepEqual(materialLinksTrace(reads[1], material, options), original); readOrderCases++
    const raw = summaryRolesTrace(reads[0], material, options)
    assert.deepEqual(summaryRolesTrace(reads[1], material, options), raw); readOrderCases++
    const labels = [...new Set(raw.trace)], failures = [...labels.filter(label => label.endsWith('.role')).slice(-6),
      ...labels.filter(label => label.endsWith('.paragraph') || label.endsWith('.text') || label.endsWith('.quote')).slice(-6)]
    for (const label of failures) for (const occurrence of new Set([1, raw.trace.filter(item => item === label).length])) {
      const failure = { label, occurrence }
      assert.deepEqual(summaryRolesTrace(reads[1], material, options, failure), summaryRolesTrace(reads[0], material, options, failure)); readOrderCases++
    }
  }
}
assert(readOrderCases >= 200, 'Exercise actual raw roles, conditions, source reads and injected failures')
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, samples: 25, alternatedImplementations: true,
  responseCases, exceptions, readOrderCases, completeSourceValidation: true, explicitRolesAndIdentity: true, canonicalReadOnly: true,
  timedScope: 'Synchronous source model queries; excludes counters, assertions, fixture construction, SQLite, HTTP, DOM and heap memory', rows }, null, 2))
