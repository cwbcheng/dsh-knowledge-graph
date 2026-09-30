import assert from 'node:assert/strict'
import { createGraphContract } from '../src/index.host.js'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'

const tools = createModelStructureTools(), contract = createGraphContract(), document = modelStructureFixture()
const taxi = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
const motion = document.graph.nodes.find(node => node.id === 'multi').modelStructure
const before = JSON.stringify(document)
const diagnosis = tools.diagnose(taxi)
assert(diagnosis.items.some(item => item.code === 'branch_condition' && item.target.id === 'unreviewed'))
assert(diagnosis.items.some(item => item.code === 'branch_no_pair' && item.branchId === 'unreviewed'))
assert.deepEqual(diagnosis.items.find(item => item.code === 'example_inputs').missing, [{ slotId: 'distance-slot', name: '行驶距离' }])
assert.equal(diagnosis.basis, 'recorded_fields_not_semantic_truth')
assert(!Object.hasOwn(diagnosis, 'confidence') && !Object.hasOwn(diagnosis, 'mastery') && !Object.hasOwn(diagnosis, 'verified'))
assert.equal(diagnosis.origins.source, 4)
assert.equal(new Set(diagnosis.items.map(item => item.id)).size, diagnosis.total)

const repeated = structuredClone(motion)
repeated.slots[0].state = ''; repeated.slots[2].state = ''
assert.deepEqual(tools.diagnose(repeated).items.filter(item => item.code === 'slot_state').map(item => item.target.id), ['initial-speed', 'final-speed'])
const unfinished = structuredClone(motion)
unfinished.examples.push({ id: 'in-progress', title: '', scenario: '', branchId: 'motion', inputs: [], outputs: [], reasoning: '',
  provenance: { kind: 'user', paragraph: null, quote: '', note: '' } })
const draft = tools.diagnose(unfinished)
assert(draft.items.some(item => item.code === 'shape_invalid'))
assert(draft.items.some(item => item.code === 'example_scenario'))
assert.deepEqual(draft.items.find(item => item.code === 'example_inputs').missing.map(item => item.slotId), ['initial-speed', 'net-force'])
assert(draft.items.some(item => item.code === 'branch_no_pair'), 'a blank scenario must not count as a paired case')

const fullWrong = structuredClone(taxi)
fullWrong.identity = 'wrong_example'; fullWrong.branches = fullWrong.branches.slice(0, 2); fullWrong.examples = fullWrong.examples.slice(0, 2)
const wrong = tools.diagnose(fullWrong)
assert.equal(wrong.counts.structure, 0)
assert.equal(wrong.counts.examples, 0)
assert(wrong.items.some(item => item.code === 'identity_caution' && item.identity === 'wrong_example'))
assert.equal(wrong.basis, 'recorded_fields_not_semantic_truth', 'complete wrong examples are not approved knowledge')
const conditionsUnknown = structuredClone(fullWrong)
conditionsUnknown.identity = 'assertion'; conditionsUnknown.branches[0].condition.text = ''
assert(tools.diagnose(conditionsUnknown).items.some(item => item.code === 'branch_condition'))
assert(!tools.diagnose(conditionsUnknown).items.some(item => item.code === 'branch_no_pair' && item.branchId === 'base'), 'pairing completeness is not condition satisfiability')

const copyTarget = { section: 'branches', id: 'base', field: 'mapping' }
const sourceUnit = { paragraph: 99, text: '在条件 A 下，结果往往为 B，但不保证必然成立。' }
assert.equal(tools.fieldFromSource(copyTarget, sourceUnit, sourceUnit.text).text, sourceUnit.text)
assert.equal(tools.fieldFromSource(copyTarget, sourceUnit, '往往为 B').provenance.quote, '往往为 B')
assert.throws(() => tools.fieldFromSource(copyTarget, sourceUnit, '结果必然为 B'), /quote does not match/)
assert.throws(() => tools.fieldFromSource({ section: 'slots', field: 'role' }, sourceUnit, '往往为 B'), /invalid destination/)
assert.throws(() => tools.fieldFromSource(copyTarget, { paragraph: -1, text: sourceUnit.text }, sourceUnit.text), /invalid stored/)
assert.throws(() => tools.fieldFromSource(copyTarget, { paragraph: 1, text: 'x'.repeat(2001) }, 'x'.repeat(2001)), /invalid text/)
assert.equal(JSON.stringify(document), before, 'diagnosis and source selection must not modify their inputs')

for (let i = 0; i < 30; i++) {
  const paragraph = document.sourceUnits.length, text = '相关材料 ' + i + '：在条件 A 下，结果往往为 B；仅为待核对表述。'
  document.sourceUnits.push({ paragraph, text })
  document.graph.nodes.push({ id: 'related-' + i, type: 'relation_material', text, paragraph, quote: text,
    evidence: [{ documentId: document.documentId, sourceId: document.graph.source.id, paragraph, quote: text }], state: 'candidate' })
  document.graph.edges.push({ fromNodeId: 'related-' + i, toNodeId: 'rule', relation: 'states_mapping' })
}
document.sourceText = document.sourceUnits.map(unit => unit.text).join('\n\n')
const many = document.graph.nodes.find(node => node.id === 'multi').modelStructure
many.examples.push(...Array.from({ length: 25 }, (_, i) => ({ id: 'motion-case-' + i, title: '运动情境 ' + i,
  scenario: '记录了初始速度和后续速度。', branchId: 'motion', inputs: [{ slotId: 'initial-speed', value: '1' }],
  outputs: [{ slotId: 'final-speed', value: '2' }], reasoning: '', provenance: { kind: 'user', paragraph: null, quote: '', note: '' } })))
const query = args => contract.connectionModels(document, { expectedRevision: 1, ...args })
const first = query({ modelId: 'multi', diagnosis: true })
assert.equal(first.modelDiagnosticsVersion, 1)
assert.equal(first.diagnosis.items.length, 20)
const allIssues = []
for (let offset = 0; offset < first.diagnosis.total; offset += 20) {
  const page = query({ modelId: 'multi', diagnosis: true, diagnosisOffset: offset })
  assert(page.diagnosis.items.length <= 20); allIssues.push(...page.diagnosis.items)
}
assert.equal(allIssues.length, first.diagnosis.total)
assert.equal(new Set(allIssues.map(item => item.id)).size, allIssues.length)
assert(allIssues.some(item => item.target?.id === 'motion-case-24' && item.missing?.some(slot => slot.slotId === 'net-force')), 'all cases, not only the first reading page, must be diagnosed')
assert.equal(first.structure, undefined); assert.equal(first.modelStructure, undefined, 'diagnosis must not expose instance answers')
const old = query({ modelId: 'legacy', diagnosis: true })
assert(old.diagnosis.items.some(item => item.code === 'missing_input'))
assert.equal(old.model.inputs.length, 0, 'factor materials must not silently become concept inputs')
assert(query({ modelId: 'wrong', diagnosis: true }).diagnosis.items.some(item => item.code === 'wording_caution'))
assert.equal(contract.connectionModels(document, { modelId: 'taxi', expectedRevision: 0, diagnosis: true }).error.code, 'revision_conflict')
assert.equal(query({ modelId: 'missing', structureSources: true }).error.code, 'not_found')
const sources = []
const sourceFirst = query({ modelId: 'taxi', structureSources: true })
assert.equal(sourceFirst.sourceUnits.items.length, 12)
for (let offset = 0; offset < sourceFirst.sourceUnits.total; offset += 12) sources.push(...query({ modelId: 'taxi', structureSources: true, sourceOffset: offset }).sourceUnits.items)
assert(sources.some(unit => unit.paragraph === document.sourceUnits.at(-1).paragraph), 'source candidates must include later material pages')
assert.equal(new Set(sources.map(unit => unit.paragraph)).size, sources.length)
assert(sources.every(unit => document.sourceUnits[unit.paragraph].text === unit.text), 'source candidates preserve exact stored text and qualifiers')
assert.equal(sourceFirst.sourceUnits.basis, 'stored_model_and_related_context_not_field_entailment')

const harness = await modelLearningHarness({ fixture: document })
try {
  const canonicalBefore = JSON.stringify(harness.store.getDocument(document.documentId))
  const persistent = await harness.post({ documentId: document.documentId, expectedRevision: 1, modelId: 'multi', diagnosis: true }, 'connection-models')
  assert.deepEqual(persistent.diagnosis, first.diagnosis, 'dynamic and persistent diagnostics must agree')
  const storedSources = await harness.post({ documentId: document.documentId, expectedRevision: 1, modelId: 'taxi', structureSources: true }, 'connection-models')
  assert.deepEqual(storedSources.sourceUnits, sourceFirst.sourceUnits)
  assert.equal(JSON.stringify(harness.store.getDocument(document.documentId)), canonicalBefore, 'read-only diagnostics and candidates must not write graph data')
  assert.equal(harness.store.getDocumentRevision(document.documentId), 1)
  const attempts = await harness.post({ action: 'attempts', documentId: document.documentId, modelId: 'taxi' })
  assert.equal(attempts.attempts.length, 0)
} finally { harness.stop() }
console.log(JSON.stringify({ ok: true, explicitMissingStates: true, independentSlots: true, wrongExampleNotApproved: true,
  allCasesDiagnosed: true, allRelatedSourcePages: true, exactQualifierCopy: true, readOnlyDynamicPersistentParity: true }))
