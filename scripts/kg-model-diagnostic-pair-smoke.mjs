import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createGraphContract } from '../src/index.host.js'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelBranchCountsFixture, modelBranchCountsModes, countFullExampleFilters } from './kg-model-branch-counts-fixture-data.mjs'
import { modelDiagnosticChanges, diagnosticBranchCounts, diagnosticGetterFixture } from './kg-model-diagnostic-pair-fixture-data.mjs'

const contract = createGraphContract(), tools = createModelStructureTools()
const query = (document, options) => contract.connectionModels(document, { expectedRevision: document.revision, ...options })
const result = callback => { try { return { response: callback() } } catch (error) { return { exception: { name: error.name, message: error.message, code: error.code } } } }
let selectedQueries = 0, indexedDiagnoses = 0, rawDiagnoses = 0
for (const slots of [0, 1, 2, 40]) for (const branches of [0, 1, 40]) for (const examples of [0, 1, 21, 100]) {
  const document = modelBranchCountsFixture({ slots, branches, examples }), before = JSON.stringify(document)
  const s = document.graph.nodes.find(node => node.id === 'taxi').modelStructure, counts = diagnosticBranchCounts(tools, document, s)
  const expected = tools.diagnose(s), measured = countFullExampleFilters(() => tools.diagnose(s, {}, counts))
  assert.deepEqual(measured.response, expected); assert.equal(measured.visits, examples)
  assert.equal(countFullExampleFilters(() => tools.diagnose(s)).visits, (branches + 1) * examples)
  indexedDiagnoses++
  for (const options of modelBranchCountsModes.slice(0, 4)) {
    const expected = query(document, options), measured = countFullExampleFilters(() => query(document, options))
    assert.equal(expected.error, undefined); assert.deepEqual(measured.response, expected)
    assert.equal(measured.visits, 2 * examples, 'validated Host diagnostics reuse existing branch counts')
    const diagnosis = expected.diagnosis
    if (diagnosis) {
      assert.equal(diagnosis.basis, 'recorded_fields_not_semantic_truth')
      assert.deepEqual(diagnosis.counts.examples, tools.diagnose(s).counts.examples)
    }
    selectedQueries++
  }
  assert.equal(JSON.stringify(document), before)
}
for (const slots of [2, 40]) for (const change of modelDiagnosticChanges) {
  const document = modelBranchCountsFixture({ slots }), s = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  change(document, s); const before = JSON.stringify(document)
  const context = { invalid: '原文引用待核对', cautions: ['文本涉及错误示例'], ports: [{ edgeKey: 'legacy-1', edgeIndex: 3, role: 'unknown', editable: false,
    node: { nodeId: 'distance', text: '独立概念', citations: [{ paragraph: 0, quote: document.sourceText }] },
    citations: [{ paragraph: 0, quote: document.sourceText }] }] }
  const expected = tools.diagnose(s, context), fallback = countFullExampleFilters(() => tools.diagnose(s, context, null))
  assert.deepEqual(fallback.response, expected); rawDiagnoses++
  let counts
  try { counts = diagnosticBranchCounts(tools, document, s) } catch { /* Raw drafts retain defensive reads. */ }
  if (counts) {
    assert.deepEqual(tools.diagnose(s, context, counts), expected); indexedDiagnoses++
    for (const options of modelBranchCountsModes.slice(0, 4)) assert.equal(query(document, options).error, undefined)
  }
  assert.equal(JSON.stringify(document), before)
}
const getterExpected = result(() => tools.diagnose(diagnosticGetterFixture(modelBranchCountsFixture)))
assert.equal(getterExpected.exception.message, 'late first-branch output')
assert.deepEqual(result(() => tools.diagnose(diagnosticGetterFixture(modelBranchCountsFixture), {}, null)), getterExpected); rawDiagnoses++

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const start = client.indexOf('const MODEL_STRUCTURE_TOOLS = ('), end = client.indexOf('// <<< END MODEL STRUCTURE TOOLS <<<', start)
assert(start >= 0 && end > start)
const browser = new Function(client.slice(start, end) + '\nreturn MODEL_STRUCTURE_TOOLS')()
const document = modelBranchCountsFixture({ slots: 40 }), s = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
const before = JSON.stringify(document), counts = diagnosticBranchCounts(tools, document, s)
assert.deepEqual(browser.diagnose(s), tools.diagnose(s)); assert.deepEqual(browser.diagnose(s, {}, counts), tools.diagnose(s))
assert.deepEqual(result(() => browser.diagnose(diagnosticGetterFixture(modelBranchCountsFixture))), getterExpected)
for (const change of [() => { s.examples[1].inputs = [] }, () => { s.examples[1].branchId = '' },
  () => { s.branches[0].mapping.text = '' }, () => { s.examples.reverse(); s.slots.reverse() }, () => { document.revision++ }]) {
  change(); const current = diagnosticBranchCounts(tools, document, s)
  assert.deepEqual(tools.diagnose(s, {}, current), tools.diagnose(s)); indexedDiagnoses++
  const response = query(document, { modelId: 'taxi', diagnosis: true })
  assert.equal(response.error, undefined); assert.equal(response.revision, document.revision)
  assert.equal(response.diagnosis.counts.examples, tools.diagnose(s).counts.examples)
}
assert.notEqual(JSON.stringify(document), before)
assert.equal(query(document, { modelId: 'taxi', expectedRevision: 1 }).error.code, 'revision_conflict')
console.log(JSON.stringify({ ok: true, selectedQueries, indexedDiagnoses, rawDiagnoses,
  validatedBranchCountsOnly: true, defaultDefensiveErrorOrder: true, sameIdentityFreshRead: true, canonicalReadOnly: true,
  browserFactoryParity: true, conditionsEvidenceAndUnverifiedIdentityPreserved: true }))
