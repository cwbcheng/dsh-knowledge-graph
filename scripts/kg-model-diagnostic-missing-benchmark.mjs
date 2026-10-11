import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelBranchCountsFixture, modelBranchCountsModes, countFullExampleFilters } from './kg-model-branch-counts-fixture-data.mjs'
import { countExampleBindingReads } from './kg-model-example-bindings-fixture-data.mjs'
import { diagnosticBranchCounts, diagnosticGetterFixture } from './kg-model-diagnostic-pair-fixture-data.mjs'
import { modelMissingChanges, diagnosticExampleStatuses } from './kg-model-diagnostic-missing-fixture-data.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-diagnostic-missing-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8e6 })
const contracts = [(await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createGraphContract(), createGraphContract()]
const toolSource = execFileSync('git', ['show', baselineCommit + ':src/kg-model-structure.mjs'], { cwd, encoding: 'utf8' })
const oldTools = (await import('data:text/javascript;base64,' + Buffer.from(toolSource).toString('base64'))).createModelStructureTools()
const currentTools = createModelStructureTools()
const result = callback => { try { return { response: callback() } } catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } } }
const query = (contract, document, options) => (options.exercise ? contract.learningPlan : contract.connectionModels)(document, { expectedRevision: document.revision, ...options })
const response = (contract, document, options) => result(() => query(contract, document, options))
const work = (contract, document, options, expected) => {
  const filtered = countFullExampleFilters(() => response(contract, document, options)), bound = countExampleBindingReads(() => response(contract, document, options))
  assert.deepEqual(filtered.response, expected); assert.deepEqual(bound.response, expected)
  return { exampleFilterCalls: filtered.calls, exampleFilterVisits: filtered.visits, bindingSomeCalls: bound.bindingSomeCalls,
    bindingSomeVisits: bound.bindingSomeVisits, slotSetReads: bound.slotSetReads, populatedSlotWrites: bound.populatedSlotWrites }
}
const stats = values => { values.sort((a,b) => a-b); return { medianMs: values[7], p95Ms: values[14] } }
const rows = []
for (const slots of [0, 1, 2, 40]) for (const branches of [0, 1, 40]) for (const examples of [0, 1, 21, 100]) {
  const document = modelBranchCountsFixture({ slots, branches, examples }), before = JSON.stringify(document)
  const s = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  currentTools.validate(s, new Map(document.graph.nodes.map(node => [node.id, node])), new Map(document.sourceUnits.map(unit => [unit.paragraph, unit.text])))
  const statusWork = countExampleBindingReads(() => s.examples.map(currentTools.prepareExampleStatus(s)))
  for (const options of modelBranchCountsModes.slice(0, 4)) {
    const expected = response(contracts[0], document, options)
    assert.equal(expected.exception, undefined); assert.equal(expected.response.error, undefined)
    assert.deepEqual(response(contracts[1], document, options), expected)
    const measured = contracts.map(contract => work(contract, document, options, expected))
    measured.forEach(value => assert.equal(value.exampleFilterVisits, 2 * examples))
    assert(measured[1].bindingSomeVisits <= measured[0].bindingSomeVisits)
    assert.equal(measured[1].bindingSomeVisits, statusWork.bindingSomeVisits)
    assert.equal(measured[1].slotSetReads, measured[0].slotSetReads); assert.equal(measured[1].populatedSlotWrites, measured[0].populatedSlotWrites)
    if (slots === 40) assert.equal(measured[1].bindingSomeVisits, 0)
    // Counters, fixtures and assertions are outside the alternating timing samples.
    for (const contract of contracts) for (let warm = 0; warm < 5; warm++) query(contract, document, options)
    const samples = [[], []]
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

let edgeCases = 0, exceptions = 0, rawDiagnoses = 0, rawExceptions = 0, indexedDiagnoses = 0, catalogueControls = 0, learningControls = 0
const equal = (document, options) => {
  const expected = response(contracts[0], document, options)
  assert.deepEqual(response(contracts[1], document, options), expected, JSON.stringify(options))
  edgeCases++; if (expected.exception) exceptions++
  return expected
}
const modes = [...modelBranchCountsModes, {}, { query: 'missing' }, { conceptId: 'distance', role: 'input' },
  { concepts: true }, { modelId: 'taxi', concepts: true }, { modelId: 'taxi', expectedRevision: 0 }, { modelId: 'multi', diagnosis: true },
  { modelId: 'taxi', exercise: 'prediction' }, { modelId: 'taxi', exercise: 'counterexample' }, { modelId: 'taxi', exercise: 'understanding' }]
const diagnoseEqual = (value, context = {}, counts, statuses) => {
  const expected = result(() => oldTools.diagnose(value, context))
  assert.deepEqual(result(() => currentTools.diagnose(value, context)), expected)
  assert.deepEqual(result(() => currentTools.diagnose(value, context, null, null)), expected)
  rawDiagnoses++; if (expected.exception) rawExceptions++
  if (statuses) {
    assert.deepEqual(result(() => currentTools.diagnose(value, context, counts)), expected, 'third-argument API retains default missing diagnostics')
    const measured = countExampleBindingReads(() => currentTools.diagnose(value, context, counts, statuses))
    assert.deepEqual({ response: measured.response }, expected); assert.equal(measured.bindingSomeVisits, 0); indexedDiagnoses++
  }
}
for (const slots of [2, 40]) for (const change of modelMissingChanges) {
  const document = modelBranchCountsFixture({ slots }), s = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  change(document, s); const before = JSON.stringify(document)
  for (const options of modes) equal(document, options)
  let counts, statuses
  try { counts = diagnosticBranchCounts(currentTools, document, s); statuses = diagnosticExampleStatuses(currentTools, document, s) } catch { /* Never prepare invalid canonical structures. */ }
  diagnoseEqual(s, {}, counts, statuses)
  diagnoseEqual(s, { invalid: '原文待核对', cautions: ['文本涉及错误示例', '', '图片或转写待核对'],
    names: { distance: '仅显示名称' }, ports: [{ edgeKey: 'legacy-1', edgeIndex: 2, role: 'unknown', editable: false,
      node: { nodeId: 'distance', citations: [{ paragraph: 0, quote: document.sourceText }] },
      citations: [{ paragraph: 0, quote: document.sourceText }] }] }, counts, statuses)
  assert.equal(JSON.stringify(document), before)
}
for (const structured of [false, true]) for (const branches of [0, 1, 40]) for (const examples of [0, 1, 20, 21, 100]) {
  const document = modelBranchCountsFixture({ structured, branches, examples }), before = JSON.stringify(document)
  for (const options of modes) equal(document, options)
  assert.equal(JSON.stringify(document), before)
}
const changed = modelBranchCountsFixture(), s = changed.graph.nodes.find(node => node.id === 'taxi').modelStructure
for (const change of [() => {}, () => { s.examples[1].inputs = [] }, () => { s.examples[1].branchId = '' },
  () => { s.branches[0].mapping.text = '' }, () => { s.branches.reverse() }, () => { s.examples.reverse() },
  () => { changed.sourceUnits[0].text = 'same identity changed source' }, () => { changed.revision++ }]) {
  change(); for (const options of modes) equal(changed, options)
}
for (const structured of [false, true]) {
  const document = modelBranchCountsFixture({ structured }), before = JSON.stringify(document)
  for (const options of [{}, { offset: 20 }, { query: 'absent' }, { conceptId: 'distance', role: 'input' }, { peerOf: 'taxi' }, { chainOf: 'taxi' }, { concepts: true }]) {
    const expected = equal(document, options), measured = contracts.map(contract => work(contract, document, options, expected))
    assert.deepEqual(measured[1], measured[0]); catalogueControls++
  }
  for (const exercise of ['prediction', 'counterexample', 'understanding']) { equal(document, { modelId: 'taxi', exercise }); learningControls++ }
  assert.equal(JSON.stringify(document), before)
}
for (const value of [undefined, null, false, 0, '', 1, 'raw', [], {}, { slots: null }, { examples: [null] }]) diagnoseEqual(value)
const getterResult = result(() => oldTools.diagnose(diagnosticGetterFixture(modelBranchCountsFixture)))
assert.equal(getterResult.exception.message, 'late first-branch output')
assert.deepEqual(result(() => currentTools.diagnose(diagnosticGetterFixture(modelBranchCountsFixture))), getterResult); rawDiagnoses++; rawExceptions++
console.log(JSON.stringify({ ok: true, baselineCommit, cases: rows.length, edgeCases, exceptions, rawDiagnoses, rawExceptions, indexedDiagnoses,
  catalogueControls, learningControls, catalogueAndLearningIncludedInEdgeCases: true, indexedIncludedInRawDiagnoses: true,
  validatedMissingIdsOnly: true, unchangedSourceAndReadonlyGraph: true, defaultDefensiveErrorOrder: true,
  timing: 'source_queries_only_alternating_15x16_no_counters_no_io', noHeapOrTransportTimingClaim: true, rows }))
