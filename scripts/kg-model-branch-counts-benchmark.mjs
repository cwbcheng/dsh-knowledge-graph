import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { modelBranchCountsFixture, modelBranchCountsModes, countFullExampleFilters } from './kg-model-branch-counts-fixture-data.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-branch-counts-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8e6 })
const contracts = [(await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract(), createGraphContract()]
const query = (contract, document, options) => (options.exercise ? contract.learningPlan : contract.connectionModels)(document, { expectedRevision: document.revision, ...options })
const result = (contract, document, options) => {
  try { return { response: query(contract, document, options) } }
  catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } }
}
const work = (contract, document, options, expected) => {
  const set = Map.prototype.set; let temporaryBranchCounters = 0
  Map.prototype.set = function(key, value) {
    if (value && Object.keys(value).sort().join(',') === 'incompleteExamples,pairedExamples') temporaryBranchCounters++
    return set.call(this, key, value)
  }
  try {
    const measured = countFullExampleFilters(() => result(contract, document, options))
    assert.deepEqual(measured.response, expected)
    return { fullExampleFilters: measured.calls, fullExampleFilterVisits: measured.visits, temporaryBranchCounters }
  } finally { Map.prototype.set = set }
}
const stats = values => { values.sort((a, b) => a - b); return { medianMs: values[7], p95Ms: values[14] } }
const rows = []
for (const slots of [2, 40]) for (const branches of [1, 2, 40]) for (const examples of [21, 100]) {
  const document = modelBranchCountsFixture({ slots, branches, examples }), before = JSON.stringify(document)
  for (const options of modelBranchCountsModes.slice(0, 4)) {
    const expected = result(contracts[0], document, options)
    assert.equal(expected.exception, undefined); assert.equal(expected.response.error, undefined)
    assert.deepEqual(result(contracts[1], document, options), expected)
    const measured = contracts.map(contract => work(contract, document, options, expected))
    assert.equal(measured[0].fullExampleFilterVisits - measured[1].fullExampleFilterVisits, 2 * branches * examples)
    assert.equal(measured[1].fullExampleFilterVisits, (branches + 2) * examples)
    assert.equal(measured[1].temporaryBranchCounters, branches + (options.compareModelId ? 1 : 0))
    for (let warm = 0; warm < 5; warm++) for (const contract of contracts) query(contract, document, options)
    const samples = [[], []]
    // Time actual synchronous queries independently of instrumentation, fixtures and assertions.
    for (let sample = 0; sample < 15; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now()
      for (let repeat = 0; repeat < 16; repeat++) query(contracts[index], document, options)
      samples[index].push((performance.now() - start) / 16)
    }
    const row = { slots, branches, examples, options, baselineWork: measured[0], currentWork: measured[1], baseline: stats(samples[0]), current: stats(samples[1]) }
    rows.push(row); console.log(JSON.stringify(row))
  }
  assert.equal(JSON.stringify(document), before)
}

let edgeCases = 0, exceptions = 0, catalogueControls = 0, learningControls = 0
const equal = (document, options) => {
  const expected = result(contracts[0], document, options)
  assert.deepEqual(result(contracts[1], document, options), expected, JSON.stringify(options))
  edgeCases++; if (expected.exception) exceptions++
  return expected
}
const modes = [...modelBranchCountsModes, {}, { query: 'missing' }, { conceptId: 'distance', role: 'input' },
  { concepts: true }, { modelId: 'taxi', concepts: true }, { modelId: 'taxi', expectedRevision: 0 },
  { modelId: 'taxi', exercise: 'prediction' }, { modelId: 'taxi', exercise: 'counterexample' }, { modelId: 'taxi', exercise: 'understanding' }]
const changes = [
  () => {},
  (document, s) => { s.examples = [] }, (document, s) => { s.branches = []; s.examples.forEach(example => { example.branchId = '' }) },
  (document, s) => { s.examples[1].branchId = '' }, (document, s) => { s.examples[1].inputs = [] },
  (document, s) => { s.examples[1].outputs[0].value = '  ' }, (document, s) => { s.branches[1].mapping.text = '' },
  (document, s) => { s.branches[1].condition.text = ''; s.branches[1].boundary.text = '' },
  (document, s) => { s.branches.reverse(); s.examples.reverse() },
  (document, s) => { const old = s.branches[0].id; s.branches[0].id = '__proto__'; s.examples.forEach(example => { if (example.branchId === old) example.branchId = '__proto__' }) },
  (document, s) => { const old = s.branches[0].id; s.branches[0].id = 'constructor'; s.examples.forEach(example => { if (example.branchId === old) example.branchId = 'constructor' }) },
  (document, s) => { s.identity = 'wrong_example' }, (document, s) => { s.identity = 'type_definition' },
  (document, s) => { s.slots[0].role = 'unknown'; s.examples.forEach(example => { example.inputs = example.inputs.filter(binding => binding.slotId !== s.slots[0].id) }) },
  (document, s) => { s.slots.forEach(slot => { slot.role = 'output' }); s.examples.forEach(example => { example.inputs = [] }) },
  (document, s) => { s.slots = []; s.examples.forEach(example => { example.inputs = []; example.outputs = [] }) },
  (document, s) => { s.examples[1].branchId = 'missing' }, (document, s) => { s.examples[1].id = s.examples[0].id },
  (document, s) => { s.branches[1].id = s.branches[0].id }, (document, s) => { s.slots[1].id = s.slots[0].id },
  (document, s) => { s.examples[1].inputs.push(structuredClone(s.examples[1].inputs[0])) },
  (document, s) => { s.examples[1].outputs[0].slotId = 'missing' },
  (document, s) => { s.examples.push(structuredClone(s.examples[0])) },
  (document, s) => { s.branches.push(structuredClone(s.branches[0])) },
  (document, s) => { s.version = 2 }, (document, s) => { s.examples[1].provenance = { kind: 'source', paragraph: 0, quote: 'not the source', note: '' } },
  document => { document.sourceUnits[0].text = 7 }, document => { document.sourceUnits.push(null) },
  document => { document.graph.staging = { chunks: {} } }, document => { document.sourceUnits = [] },
  document => { document.graph.nodes.find(node => node.id === 'distance').state = 'rejected' },
  document => { document.graph.nodes.push({ ...structuredClone(document.graph.nodes.find(node => node.id === 'taxi')), type: 'rule' }) },
]
for (const slots of [2, 40]) for (const change of changes) {
  const document = modelBranchCountsFixture({ slots }), structure = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  change(document, structure); const before = JSON.stringify(document)
  for (const options of modes) equal(document, options)
  assert.equal(JSON.stringify(document), before)
}
for (const structured of [false, true]) for (const branches of [0, 1, 40]) for (const examples of [0, 1, 20, 21, 100]) {
  const document = modelBranchCountsFixture({ structured, branches, examples }), before = JSON.stringify(document)
  for (const options of modes) equal(document, options)
  assert.equal(JSON.stringify(document), before)
}
const changed = modelBranchCountsFixture(), specification = changed.graph.nodes.find(node => node.id === 'taxi').modelStructure
for (const change of [() => {}, () => { specification.examples[1].inputs = [] }, () => { specification.examples[1].branchId = '' },
  () => { specification.branches[0].mapping.text = '' }, () => { specification.branches.reverse() },
  () => { specification.examples.reverse() }, () => { changed.sourceUnits[0].text = 'same identity changed source' }, () => { changed.revision++ }]) {
  change(); for (const options of modes) equal(changed, options)
}
for (const structured of [false, true]) {
  const document = modelBranchCountsFixture({ structured }), before = JSON.stringify(document)
  for (const options of [{}, { offset: 20 }, { query: 'absent' }, { conceptId: 'distance', role: 'input' }, { peerOf: 'taxi' }, { chainOf: 'taxi' }, { concepts: true }]) {
    const expected = equal(document, options), measured = contracts.map(contract => work(contract, document, options, expected))
    assert.deepEqual(measured[1], measured[0]); assert.equal(measured[1].temporaryBranchCounters, 0); catalogueControls++
  }
  for (const exercise of ['prediction', 'counterexample', 'understanding']) { equal(document, { modelId: 'taxi', exercise }); learningControls++ }
  assert.equal(JSON.stringify(document), before)
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, performanceCases: rows.length, edgeCases, matchedExceptions: exceptions,
  catalogueControls, learningControls, canonicalReadOnly: true, samples: 15, queriesPerSample: 16, alternatedImplementations: true,
  timedScope: 'Actual synchronous source queries; excludes counters, assertions, fixture creation, SQLite, HTTP and browser rendering', noHeapMemoryClaim: true, rows }, null, 2))
