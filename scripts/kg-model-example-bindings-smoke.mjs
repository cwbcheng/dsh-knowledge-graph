import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createGraphContract } from '../src/index.host.js'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelBranchCountsFixture, modelBranchCountsModes } from './kg-model-branch-counts-fixture-data.mjs'
import { countExampleBindingReads, expectedBindingIndexWork } from './kg-model-example-bindings-fixture-data.mjs'

const contract = createGraphContract(), tools = createModelStructureTools()
const read = (document, options) => contract.connectionModels(document, { expectedRevision: document.revision, ...options })
let selectedQueries = 0, preparedExamples = 0, thresholdControls = 0
for (const slots of [2, 16, 18, 40]) for (const branches of [0, 1, 40]) for (const examples of [0, 1, 21, 100]) {
  const document = modelBranchCountsFixture({ slots, branches, examples }), s = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  tools.validateShape(s); const before = JSON.stringify(document), prepared = tools.prepareExampleStatus(s)
  const expectedWork = expectedBindingIndexWork(s)
  const { response: statuses, ...work } = countExampleBindingReads(() => s.examples.map(example => prepared(example)))
  assert.deepEqual(statuses, s.examples.map(example => tools.exampleStatus(s, example)))
  assert.equal(work.slotSetReads, expectedWork.slotSetReads); assert.equal(work.populatedSlotWrites, expectedWork.populatedSlotWrites)
  if (slots <= 16) assert.equal(expectedWork.slotSetReads, 0, 'small roles retain direct binding reads')
  if (slots >= 18) assert.equal(work.bindingSomeVisits, 0, 'wide validated bindings are not rescanned per slot')
  preparedExamples += statuses.length
  for (const options of modelBranchCountsModes.slice(0, 4)) {
    const expected = read(document, options), measured = countExampleBindingReads(() => read(document, options))
    assert.equal(expected.error, undefined); assert.deepEqual(measured.response, expected)
    if (slots === 40 && examples === 100 && branches === 40) assert.equal(measured.bindingSomeVisits, 58232, 'unchanged diagnostics remain in the whole-query budget')
    selectedQueries++
  }
  const view = read(document, { modelId: 'taxi' }).structure
  assert.equal(view.identity, 'hypothesis'); assert.equal(view.origin, 'reviewed_structure_not_verified_truth')
  assert.equal(view.exampleTotal, examples); assert.equal(view.examples.length, Math.min(examples, 20))
  assert.deepEqual(view.slots.map(({ conceptText, ...slot }) => slot), s.slots)
  for (const example of view.examples) assert.deepEqual({ missing: example.missing, complete: example.complete }, tools.exampleStatus(s, example))
  for (const branch of view.branches) {
    const stored = s.branches.find(item => item.id === branch.id)
    for (const key of ['condition', 'mapping', 'boundary']) assert.deepEqual(branch[key], stored[key])
    assert.equal(branch.pairedExamples + branch.incompleteExamples, s.examples.filter(example => example.branchId === branch.id).length)
  }
  assert.equal(JSON.stringify(document), before)
}
for (const width of [0, 1, 8, 9, 20]) for (const role of ['input', 'output']) {
  const document = modelBranchCountsFixture({ slots: 40, examples: 1 }), s = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  const example = s.examples[0], key = role === 'input' ? 'inputs' : 'outputs'
  example[key] = s.slots.filter(slot => slot.role === role).slice(0, width).map(slot => ({ slotId: slot.id, value: '0' }))
  tools.validateShape(s); const before = JSON.stringify(document), prepared = tools.prepareExampleStatus(s)
  const measured = countExampleBindingReads(() => prepared(example)), expectedWork = expectedBindingIndexWork(s)
  assert.deepEqual(measured.response, tools.exampleStatus(s, example)); assert.equal(measured.slotSetReads, expectedWork.slotSetReads)
  assert.equal(measured.populatedSlotWrites, expectedWork.populatedSlotWrites)
  assert.equal(JSON.stringify(document), before); thresholdControls++
}
const document = modelBranchCountsFixture({ slots: 40 }), s = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
for (const change of [() => {}, () => { s.slots.reverse() }, () => { s.examples[1].inputs.reverse(); s.examples[1].outputs.reverse() },
  () => { s.examples[1].outputs[0].value = '\u2003\u00a0' }, () => { s.examples[1].inputs = s.examples[1].inputs.slice(0, 8) },
  () => { s.branches[1].mapping.text = '  ' }, () => { s.examples[1].branchId = '' },
  () => { s.slots.forEach(slot => { slot.role = slot.role === 'input' ? 'output' : 'input' }); s.examples.forEach(example => { [example.inputs, example.outputs] = [example.outputs, example.inputs] }) },
  () => { document.revision++ }]) {
  change(); tools.validateShape(s); const before = JSON.stringify(document), prepared = tools.prepareExampleStatus(s)
  for (const example of s.examples) assert.deepEqual(prepared(example), tools.exampleStatus(s, example))
  const view = read(document, { modelId: 'taxi' }).structure
  for (const example of view.examples) assert.deepEqual({ missing: example.missing, complete: example.complete }, tools.exampleStatus(s, example))
  assert.equal(JSON.stringify(document), before)
}
assert.equal(read(document, { modelId: 'taxi', expectedRevision: document.revision - 1 }).error.code, 'revision_conflict')
const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const open = client.indexOf('      // >>> GENERATED MODEL STRUCTURE TOOLS >>>'), end = client.indexOf('      // <<< END MODEL STRUCTURE TOOLS <<<', open)
assert(open >= 0 && end > open)
const browser = new Function(client.slice(open, end) + '\nreturn MODEL_STRUCTURE_TOOLS')(), browserPrepared = browser.prepareExampleStatus(s)
for (const example of s.examples) {
  assert.deepEqual(browser.exampleStatus(s, example), tools.exampleStatus(s, example))
  assert.deepEqual(browserPrepared(example), tools.exampleStatus(s, example))
}
console.log(JSON.stringify({ ok: true, selectedQueries, preparedExamples, thresholdControls, wideBindingsIndexed: true, smallAndSparseBindingsDirect: true,
  generatedBrowserApiParity: true, independentSlotIdentityAndMissingOrder: true, conditionsAndEvidencePreserved: true, canonicalReadOnly: true }))
