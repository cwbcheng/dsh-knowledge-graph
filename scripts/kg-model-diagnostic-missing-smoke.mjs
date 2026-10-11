import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createGraphContract } from '../src/index.host.js'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelBranchCountsFixture, modelBranchCountsModes, countFullExampleFilters } from './kg-model-branch-counts-fixture-data.mjs'
import { countExampleBindingReads } from './kg-model-example-bindings-fixture-data.mjs'
import { diagnosticBranchCounts, diagnosticGetterFixture } from './kg-model-diagnostic-pair-fixture-data.mjs'
import { modelMissingChanges, diagnosticExampleStatuses } from './kg-model-diagnostic-missing-fixture-data.mjs'

const tools = createModelStructureTools(), contract = createGraphContract()
const query = (document, options) => contract.connectionModels(document, { expectedRevision: document.revision, ...options })
const result = callback => { try { return { response: callback() } } catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } } }
let selectedQueries = 0, indexedDiagnoses = 0, rawDiagnoses = 0, examplesChecked = 0
for (const slots of [0, 1, 2, 40]) for (const branches of [0, 1, 40]) for (const examples of [0, 1, 21, 100]) {
  const document = modelBranchCountsFixture({ slots, branches, examples }), before = JSON.stringify(document)
  const s = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  const counts = diagnosticBranchCounts(tools, document, s), statuses = diagnosticExampleStatuses(tools, document, s)
  const expected = tools.diagnose(s), measured = countExampleBindingReads(() => tools.diagnose(s, {}, counts, statuses))
  assert.deepEqual(measured.response, expected)
  assert.equal(measured.bindingSomeVisits, 0, 'validated diagnostics reuse existing missing IDs for every example')
  assert.equal(countFullExampleFilters(() => tools.diagnose(s, {}, counts, statuses)).visits, examples)
  const statusWork = countExampleBindingReads(() => s.examples.map(tools.prepareExampleStatus(s)))
  for (const example of s.examples) {
    const missing = expected.items.filter(item => ['example_inputs', 'example_outputs'].includes(item.code) && item.target.id === example.id)
      .flatMap(item => item.missing.map(slot => slot.slotId))
    assert.deepEqual(missing, statuses.get(example.id).missing); examplesChecked++
  }
  for (const options of modelBranchCountsModes.slice(0, 4)) {
    const expected = query(document, options), measured = countExampleBindingReads(() => query(document, options))
    assert.equal(expected.error, undefined); assert.deepEqual(measured.response, expected)
    assert.equal(measured.bindingSomeVisits, statusWork.bindingSomeVisits, 'whole-query binding budget retains the actual status reads')
    assert.equal(countFullExampleFilters(() => query(document, options)).visits, 2 * examples)
    if (expected.diagnosis) assert.deepEqual(expected.diagnosis.counts.examples, tools.diagnose(s).counts.examples)
    selectedQueries++
  }
  assert.equal(JSON.stringify(document), before); indexedDiagnoses++
}
for (const slots of [2, 40]) for (const change of modelMissingChanges) {
  const document = modelBranchCountsFixture({ slots }), s = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  change(document, s); const before = JSON.stringify(document)
  const context = { invalid: '原文引用待核对', cautions: ['文本涉及错误示例'], names: { distance: '仅显示名称' },
    ports: [{ edgeKey: 'legacy-1', edgeIndex: 3, role: 'unknown', editable: false,
      node: { nodeId: 'distance', text: '独立概念', citations: [{ paragraph: 0, quote: document.sourceText }] },
      citations: [{ paragraph: 0, quote: document.sourceText }] }] }
  const expected = result(() => tools.diagnose(s, context))
  assert.deepEqual(result(() => tools.diagnose(s, context, null, null)), expected); rawDiagnoses++
  let counts, statuses
  try { counts = diagnosticBranchCounts(tools, document, s); statuses = diagnosticExampleStatuses(tools, document, s) } catch { /* Never reuse invalid canonical drafts. */ }
  if (statuses) {
    const measured = countExampleBindingReads(() => tools.diagnose(s, context, counts, statuses))
    assert.deepEqual({ response: measured.response }, expected); assert.equal(measured.bindingSomeVisits, 0); indexedDiagnoses++
    assert.deepEqual(result(() => tools.diagnose(s, context, counts, new Map())), expected, 'missing projection entries retain the raw fallback')
  }
  assert.equal(JSON.stringify(document), before)
}
const getterExpected = result(() => tools.diagnose(diagnosticGetterFixture(modelBranchCountsFixture)))
assert.equal(getterExpected.exception.message, 'late first-branch output')
assert.deepEqual(result(() => tools.diagnose(diagnosticGetterFixture(modelBranchCountsFixture), {}, null, null)), getterExpected); rawDiagnoses++
const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const start = client.indexOf('const MODEL_STRUCTURE_TOOLS = ('), end = client.indexOf('// <<< END MODEL STRUCTURE TOOLS <<<', start)
assert(start >= 0 && end > start)
const browser = new Function(client.slice(start, end) + '\nreturn MODEL_STRUCTURE_TOOLS')()
const document = modelBranchCountsFixture({ slots: 40 }), s = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
for (const change of [() => {}, () => { s.examples[1].inputs = [] }, () => { s.examples.at(-1).outputs = [] },
  () => { s.examples[1].branchId = '' }, () => { s.branches[0].mapping.text = '' },
  () => { s.examples.reverse(); s.slots.reverse() }, () => { document.revision++ }]) {
  change(); const before = JSON.stringify(document), counts = diagnosticBranchCounts(tools, document, s), statuses = diagnosticExampleStatuses(tools, document, s)
  const expected = tools.diagnose(s)
  assert.deepEqual(browser.diagnose(s), expected); assert.deepEqual(browser.diagnose(s, {}, counts, statuses), expected)
  assert.equal(countExampleBindingReads(() => browser.diagnose(s, {}, counts, statuses)).bindingSomeVisits, 0)
  const response = query(document, { modelId: 'taxi', diagnosis: true, exampleOffset: 20 })
  assert.equal(response.error, undefined); assert.equal(response.revision, document.revision)
  assert.deepEqual(response.diagnosis.counts.examples, expected.counts.examples)
  assert.equal(JSON.stringify(document), before); indexedDiagnoses++
}
assert.deepEqual(result(() => browser.diagnose(diagnosticGetterFixture(modelBranchCountsFixture))), getterExpected)
assert.equal(query(document, { modelId: 'taxi', expectedRevision: document.revision - 1 }).error.code, 'revision_conflict')
console.log(JSON.stringify({ ok: true, selectedQueries, indexedDiagnoses, rawDiagnoses, examplesChecked,
  validatedMissingIdsOnly: true, allExamplesDiagnosed: true, missingOrderNamesTargetsAndEvidence: true, defaultDefensiveErrorOrder: true,
  sameIdentityFreshRead: true, canonicalReadOnly: true, browserFactoryParity: true, conditionsAndUnverifiedIdentityPreserved: true }))
