import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelChainFixture, modelChainDraft, chainInput } from './kg-model-chain-fixture-data.mjs'
import { createModelChainTools } from '../src/kg-model-chain.mjs'

const fixture = modelChainFixture(), harness = await modelLearningHarness({ fixture })
const { document, store, post } = harness
const args = { documentId: document.documentId, expectedRevision: 1, modelId: 'taxi' }
const read = changes => post({ ...args, ...changes }, 'connection-models')
const check = draft => read({ compareModelId: draft.steps[1].modelId, chainDraft: draft })
const mutate = fn => { const draft = modelChainDraft(); fn(draft); return draft }
const code = async (draft, expected) => {
  const result = await check(draft)
  assert.equal(result.chain?.status, 'blocked', JSON.stringify(result))
  assert(result.chain.issues.some(item => item.code === expected), expected + ': ' + JSON.stringify(result.chain.issues))
  return result.chain
}
try {
  const graphBefore = store.getDocument(document.documentId), unitsBefore = store.getDocumentSourceUnits(document.documentId)
  const full = await read({ modelId: undefined, chainOf: 'taxi' })
  assert.equal(full.modelChainVersion, 1)
  assert(full.total > 20 && full.items.some(item => item.nodeId === 'budget-model'))
  assert(!full.items.some(item => item.nodeId === 'same-name'), 'same name does not establish concept identity')
  assert(!full.items.some(item => item.nodeId === 'taxi'))
  const page2 = await read({ modelId: undefined, chainOf: 'taxi', offset: 20 })
  assert(page2.items.length > 0 && !page2.items.some(item => full.items.some(first => first.nodeId === item.nodeId)))
  assert((await read({ modelId: undefined, chainOf: 'nonexistent' })).error)
  const result = await check(modelChainDraft())
  assert.equal(result.chain.status, 'worksheet_complete')
  assert.equal(result.chain.persisted, false)
  assert.equal(result.chain.basis, 'recorded_fields_and_learner_reports_not_semantic_validity')
  assert.equal(result.chain.steps[1].inputs[0].value, '14')
  assert.equal(result.chain.steps[1].inputs[0].source, 'learner_predicted_link')
  assert(result.chain.steps[1].branch.mapping.text.includes('往往'))
  assert(result.chain.warnings.some(item => item.code === 'hypothesis'))
  for (const id of ['source:model-beta', '模型乙']) {
    assert.equal((await check(modelChainDraft(id))).chain?.status, 'worksheet_complete', 'legal canonical model identities must not be restricted to ASCII tokens')
  }
  const missing = await code(mutate(draft => { draft.steps[0].inputs = [] }), 'input_missing')
  assert.equal(missing.firstStop, 1)
  assert.equal(missing.steps[1].inputs[0].value, null, 'manual output cannot bypass a blocked upstream model')
  await code(mutate(draft => { draft.steps[1].inputs.pop() }), 'input_missing')
  await code(mutate(draft => { draft.steps[0].outputs = [] }), 'output_prediction_missing')
  await code(mutate(draft => { draft.steps[1].conditions = '' }), 'conditions_missing')
  await code(mutate(draft => { draft.steps[1].branchId = 'no-such-branch' }), 'branch_missing')
  await code(mutate(draft => { draft.steps[1].inputs[0].fromSlotId = 'distance-slot' }), 'link_output_missing')
  await code(mutate(draft => { draft.steps[1].inputs[0].objectScope = '' }), 'link_objectScope_missing')
  await code(mutate(draft => { draft.steps[1].inputs[0] = chainInput('expense', '14', '用户输入') }), 'link_missing')
  for (const [id, expected] of [['units', 'unit_mismatch'], ['times', 'state_mismatch'], ['same-name', 'concept_mismatch'],
    ['unknown-unit', 'unit_unknown'], ['unknown-state', 'state_unknown'], ['wrong-model', 'identity_unusable'], ['type-model', 'identity_unusable'],
    ['unknown-role', 'role_unknown'], ['uncited', 'branch_condition_source_missing'], ['rejected-model', 'model_rejected'], ['unsupported-model', 'model_rejected']]) {
    let draft = modelChainDraft(id)
    if (id === 'unknown-role') draft.steps[1].inputs.pop()
    const stopped = await code(draft, expected)
    if (['units', 'times', 'same-name'].includes(id)) assert.equal(stopped.steps[1].inputs[0].value, null, 'conflicting link cannot provide a value')
  }
  const cyclic = await check(modelChainDraft('return-model'))
  assert(cyclic.chain.warnings.some(item => item.code === 'return_to_initial_concept'))
  const repeated = modelChainDraft('duplicate-concept')
  await code(repeated, 'input_missing')
  repeated.steps[1].inputs.push(chainInput('other-expense', '2', '此前行程独立记录'))
  assert.equal((await check(repeated)).chain.status, 'worksheet_complete', 'same concept has independent required slots')
  for (const fn of [draft => { draft.steps[0].inputs[0].source = 'link' }, draft => { draft.steps[1].outputs[0].slotId = 'expense' },
    draft => { draft.steps[1].inputs.push(draft.steps[1].inputs[0]) }, draft => { draft.steps[0].modelId = 'foreign' },
    draft => { draft.extra = 'unsupported' }, draft => { draft.steps[1].inputs[0].source = 'AI' },
    draft => { draft.scenario = 'x'.repeat(2001) }, draft => { draft.steps[1].modelId = 'taxi' },
    draft => { draft.steps[1].inputs[0].unit = { toString: () => 'same' } }]) {
    assert((await check(mutate(fn))).error, 'invalid payload must fail, not produce a complete worksheet')
  }
  assert.equal((await read({ compareModelId: 'budget-model', chainDraft: modelChainDraft(), expectedRevision: 0 })).error.code, 'revision_conflict')
  assert((await read({ chainDraft: modelChainDraft() })).error)
  assert((await read({ compareModelId: 'budget-model', chainDraft: modelChainDraft(), diagnosis: true })).error)
  const tools = createModelChainTools(), pair = await read({ compareModelId: 'budget-model' })
  const dynamicSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
  const block = dynamicSource.slice(dynamicSource.indexOf('      const MODEL_CHAIN_TOOLS = '), dynamicSource.indexOf('      // <<< END MODEL CHAIN TOOLS <<<'))
  const dynamic = runInNewContext(block + '\nMODEL_CHAIN_TOOLS')
  assert.deepEqual(JSON.parse(JSON.stringify(dynamic.evaluate(pair, modelChainDraft()))), tools.evaluate(pair, modelChainDraft()), 'dynamic and shared worksheet engines have identical output')
  assert.deepEqual(store.getDocument(document.documentId), graphBefore)
  assert.deepEqual(store.getDocumentSourceUnits(document.documentId), unitsBefore)
  assert.equal(store.listLearningAttempts(document.documentId).length, 0, 'read-only checks do not create learner evidence')
  console.log('model chain: explicit forward slots, full-canonical candidates, all inputs, upstream stops, source qualifications, unit/state/identity conflicts, no writes and dynamic parity passed')
} finally { harness.stop() }
