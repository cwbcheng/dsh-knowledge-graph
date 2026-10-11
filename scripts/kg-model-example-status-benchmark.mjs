import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { modelBranchCountsFixture, modelBranchCountsModes } from './kg-model-branch-counts-fixture-data.mjs'

import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { countExampleStatusReads } from './kg-model-example-status-fixture-data.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-example-status-benchmark.mjs <baseline-commit>')
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
  const { response, ...counts } = countExampleStatusReads(() => result(contract, document, options))
  assert.deepEqual(response, expected); return counts
}
const stats = values => { values.sort((a, b) => a - b); return { medianMs: values[7], p95Ms: values[14] } }
const rows = []
for (const slots of [2, 40]) for (const branches of [0, 1, 40]) for (const examples of [0, 1, 21, 100]) {
  const document = modelBranchCountsFixture({ slots, branches, examples }), before = JSON.stringify(document)
  for (const options of modelBranchCountsModes.slice(0, 4)) {
    const expected = result(contracts[0], document, options)
    assert.equal(expected.exception, undefined); assert.equal(expected.response.error, undefined)
    assert.deepEqual(result(contracts[1], document, options), expected)
    const measured = contracts.map(contract => work(contract, document, options, expected))
    assert.equal(measured[0].slotFilterVisits, (4 * examples + 1) * slots)
    assert.equal(measured[1].slotFilterVisits, (examples ? 2 * examples + 3 : 1) * slots)
    assert.equal(measured[0].branchFinds, branches ? examples : 0)
    assert.equal(measured[1].branchFinds, 0); assert.equal(measured[1].branchFindVisits, 0)
    assert.equal(measured[1].indexedBranches, examples ? branches : 0)
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
  (document, s) => { s.slots.reverse() },
  (document, s) => { s.examples.forEach(example => { example.inputs.reverse(); example.outputs.reverse() }) },
  (document, s) => { s.examples[1].inputs[0].value = ''; s.examples[1].outputs[0].value = '' },
  (document, s) => { const old = s.slots[0].id; s.slots[0].id = '__proto__'; s.examples.forEach(example => example.inputs.forEach(binding => { if (binding.slotId === old) binding.slotId = '__proto__' })) },
  (document, s) => { const old = s.slots[0].id; s.slots[0].id = 'constructor'; s.examples.forEach(example => example.inputs.forEach(binding => { if (binding.slotId === old) binding.slotId = 'constructor' })) },
  (document, s) => { s.branches[1].mapping.text = '  ' },
  (document, s) => { s.examples[1].outputs[0].value = '\u2003\u00a0' },
  (document, s) => { s.slots.forEach(slot => { slot.role = slot.role === 'input' ? 'output' : 'input' }); s.examples.forEach(example => { [example.inputs, example.outputs] = [example.outputs, example.inputs] }) },
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
    assert.deepEqual(measured[1], measured[0]); assert.equal(measured[1].indexedBranches, 0); catalogueControls++
  }
  for (const exercise of ['prediction', 'counterexample', 'understanding']) { equal(document, { modelId: 'taxi', exercise }); learningControls++ }
  assert.equal(JSON.stringify(document), before)
}
// Preserve the actual shared factory's two-argument behavior, including raw input exceptions.
const toolSource = execFileSync('git', ['show', baselineCommit + ':src/kg-model-structure.mjs'], { cwd, encoding: 'utf8' })
const oldTools = (await import('data:text/javascript;base64,' + Buffer.from(toolSource).toString('base64'))).createModelStructureTools()
const currentTools = createModelStructureTools()
const status = (tools, structure, example) => {
  try { return { response: tools.exampleStatus(structure, example) } }
  catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } }
}
let singleExampleCases = 0, singleExampleExceptions = 0, preparedExamples = 0
for (const slots of [2, 40]) for (const change of [
  () => {}, s => { s.slots.reverse() }, s => { s.examples[1].inputs = [] },
  s => { s.branches[1].mapping.text = '  ' },
  s => { const old = s.slots[0].id; s.slots[0].id = '__proto__'; s.examples.forEach(example => example.inputs.forEach(binding => { if (binding.slotId === old) binding.slotId = '__proto__' })) },
  s => { s.slots.forEach(slot => { slot.role = slot.role === 'input' ? 'output' : 'input' }); s.examples.forEach(example => { [example.inputs, example.outputs] = [example.outputs, example.inputs] }) },
]) {
  const document = modelBranchCountsFixture({ slots }), s = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  change(s); currentTools.validateShape(s); const before = JSON.stringify(s), prepared = currentTools.prepareExampleStatus(s)
  for (const example of s.examples) {
    const expected = status(oldTools, s, example)
    assert.equal(expected.exception, undefined); assert.deepEqual(status(currentTools, s, example), expected)
    assert.deepEqual(prepared(example), expected.response); singleExampleCases++; preparedExamples++
  }
  assert.equal(JSON.stringify(s), before)
}
for (const change of [
  s => { s.branches = null }, s => { s.slots = null }, s => { s.examples[1].inputs = null },
  s => { s.examples[1].inputs[0] = null }, s => { s.examples[1].inputs[0].value = null },
  s => { s.branches[1].mapping = null }, s => { s.branches[1].mapping.text = 7 },
  s => { s.examples[1].outputs[0].value = {} },
]) {
  const s = modelBranchCountsFixture().graph.nodes.find(node => node.id === 'taxi').modelStructure
  change(s); const before = JSON.stringify(s), expected = status(oldTools, s, s.examples[1])
  assert.deepEqual(status(currentTools, s, s.examples[1]), expected)
  singleExampleCases++; if (expected.exception) singleExampleExceptions++
  assert.equal(JSON.stringify(s), before)
}
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version, performanceCases: rows.length, edgeCases, matchedExceptions: exceptions,
  catalogueControls, learningControls, singleExampleCases, singleExampleExceptions, preparedExamples, canonicalReadOnly: true,
  samples: 15, queriesPerSample: 16, alternatedImplementations: true,
  timedScope: 'Actual synchronous source queries; excludes counters, assertions, fixture creation, SQLite, HTTP and browser rendering',
  noHeapMemoryClaim: true, primaryRows: rows.filter(row => row.branches === 40 && row.examples === 100) }))
