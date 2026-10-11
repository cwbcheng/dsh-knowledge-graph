import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createGraphContract } from '../src/index.host.js'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelBranchCountsFixture, modelBranchCountsModes } from './kg-model-branch-counts-fixture-data.mjs'
import { countExampleStatusReads } from './kg-model-example-status-fixture-data.mjs'

const contract = createGraphContract(), tools = createModelStructureTools()
const read = (document, options) => contract.connectionModels(document, { expectedRevision: document.revision, ...options })
let selectedQueries = 0, examplesChecked = 0
for (const slots of [2, 40]) for (const branches of [0, 1, 2, 40]) for (const examples of [0, 1, 21, 100]) {
  const document = modelBranchCountsFixture({ slots, branches, examples }), before = JSON.stringify(document)
  const specification = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  for (const options of modelBranchCountsModes.slice(0, 4)) {
    const expected = read(document, options), measured = countExampleStatusReads(() => read(document, options))
    assert.equal(expected.error, undefined); assert.deepEqual(measured.response, expected)
    assert.equal(measured.slotFilters, examples ? 2 * examples + 3 : 1)
    assert.equal(measured.slotFilterVisits, (examples ? 2 * examples + 3 : 1) * slots)
    assert.equal(measured.branchFinds, 0); assert.equal(measured.branchFindVisits, 0)
    assert.equal(measured.indexedBranches, examples ? branches : 0, 'only the selected, nonempty example projection builds this branch index')
    selectedQueries++
  }
  const view = read(document, { modelId: 'taxi' }).structure
  assert.equal(view.identity, 'hypothesis'); assert.equal(view.origin, 'reviewed_structure_not_verified_truth')
  assert.equal(view.exampleTotal, examples); assert.equal(view.examples.length, Math.min(examples, 20))
  for (const example of view.examples) {
    assert.deepEqual({ missing: example.missing, complete: example.complete }, tools.exampleStatus(specification, example)); examplesChecked++
  }
  for (const branch of view.branches) {
    const stored = specification.branches.find(item => item.id === branch.id)
    assert.deepEqual(branch.condition, stored.condition); assert.deepEqual(branch.mapping, stored.mapping)
    assert.deepEqual(branch.boundary, stored.boundary)
    assert.equal(branch.pairedExamples + branch.incompleteExamples, specification.examples.filter(example => example.branchId === branch.id).length)
  }
  assert.deepEqual(view.slots.map(({ conceptText, ...slot }) => slot), specification.slots)
  assert.equal(JSON.stringify(document), before)
}

const document = modelBranchCountsFixture({ slots: 40 }), specification = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
for (const change of [() => {}, () => { specification.slots.reverse() },
  () => { specification.examples[1].inputs = [] }, () => { specification.examples[1].branchId = '' },
  () => { specification.branches[1].mapping.text = '' }, () => { specification.branches.reverse() },
  () => { specification.slots[0].role = 'unknown'; for (const example of specification.examples) example.outputs = example.outputs.filter(binding => binding.slotId !== specification.slots[0].id) },
  () => { document.revision++ }]) {
  change()
  const before = JSON.stringify(document), prepared = tools.prepareExampleStatus(specification)
  const view = read(document, { modelId: 'taxi' }).structure
  for (const example of view.examples) assert.deepEqual({ missing: example.missing, complete: example.complete }, tools.exampleStatus(specification, example))
  for (const example of specification.examples) assert.deepEqual(prepared(example), tools.exampleStatus(specification, example))
  assert.equal(JSON.stringify(document), before)
}
assert.equal(read(document, { modelId: 'taxi', expectedRevision: document.revision - 1 }).error.code, 'revision_conflict')

// Exercise the actual generated browser factory while keeping its two-argument caller.
const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const open = client.indexOf('      // >>> GENERATED MODEL STRUCTURE TOOLS >>>')
const end = client.indexOf('      // <<< END MODEL STRUCTURE TOOLS <<<', open)
assert(open >= 0 && end > open)
const browserTools = new Function(client.slice(open, end) + '\nreturn MODEL_STRUCTURE_TOOLS')()
for (const example of specification.examples) assert.deepEqual(browserTools.exampleStatus(specification, example), tools.exampleStatus(specification, example))
console.log(JSON.stringify({ ok: true, selectedQueries, examplesChecked, roleAndBranchWorkBounded: true,
  slotIdentityRoleUnitStateAndEvidencePreserved: true, conditionsAndCompletenessPreserved: true,
  sameObjectAndRevisionChanges: true, canonicalReadOnly: true, generatedBrowserSingleExampleApi: true }))
