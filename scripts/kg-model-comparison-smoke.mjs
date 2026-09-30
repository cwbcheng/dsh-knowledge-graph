import assert from 'node:assert/strict'
import { createGraphContract } from '../src/index.host.js'
import { modelLearningHarness, learnerResponse, learnerReview } from './kg-model-learning-fixture-data.mjs'
import { comparisonFixture, counterexampleResponse } from './kg-model-comparison-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: comparisonFixture() })
const { document, store, post } = harness
const contract = createGraphContract()
const args = { documentId: document.documentId, expectedRevision: 1, modelId: 'taxi' }
const compare = compareModelId => post({ ...args, compareModelId }, 'connection-models')
try {
  const before = JSON.stringify(store.getDocument(document.documentId))
  const night = await compare('night')
  assert.equal(night.endpointStatus, 'same_recorded_direction')
  assert.equal(night.equivalence, 'not_inferred')
  assert.equal(night.conditions, 'not_structured')
  assert(night.right.model.text.includes('20%'))
  assert.deepEqual(night.shared.map(item => item.node.nodeId).sort(), ['distance', 'fare'])
  assert.equal(night.left.related.find(item => item.nodeId === 'example').citations[0].paragraph, 2)
  const reversed = await compare('reverse')
  assert.equal(reversed.endpointStatus, 'different_recorded_direction')
  assert.deepEqual(reversed.shared.find(item => item.node.nodeId === 'distance').rightRoles, ['output'])
  const named = await compare('named-copy')
  assert.equal(named.shared.length, 0, 'same labels cannot merge canonical identities')
  assert.equal(named.sameNamedTotal, 2, 'NFKC matches names only, not concept identity')
  assert.equal(named.equivalence, 'not_inferred')
  assert.equal((await compare('unknown')).endpointStatus, 'incomplete')
  assert((await compare('wrong')).right.model.warnings.includes('文本涉及错误示例'))
  assert.equal((await compare('taxi')).error.code, 'invalid_input')
  assert.equal((await compare('factor')).error.code, 'not_found')
  assert.equal((await post({ ...args, compareModelId: 'night', expectedRevision: 2 }, 'connection-models')).error.code, 'revision_conflict')
  const damaged = structuredClone(document)
  damaged.graph.edges.push(structuredClone(damaged.graph.edges[0]))
  assert.equal(contract.connectionModels(damaged, { ...args, compareModelId: 'night' }).endpointStatus, 'incomplete', 'duplicate edges cannot prove direction completeness')
  const incoming = structuredClone(document)
  const inverse = incoming.graph.edges.find(edge => edge.fromNodeId === 'night' && edge.toNodeId === 'distance')
  inverse.fromNodeId = 'distance'; inverse.toNodeId = 'night'
  assert.equal(contract.connectionModels(incoming, { ...args, compareModelId: 'night' }).endpointStatus, 'incomplete', 'inverse edge does not imply an input')
  const manyNames = structuredClone(document)
  for (let index = 0; index < 60; index++) {
    for (const [model, prefix] of [['taxi', 'a-'], ['night', 'b-']]) {
      manyNames.graph.nodes.push({ id: prefix + index, type: 'concept', text: '同名变量' })
      manyNames.graph.edges.push({ fromNodeId: model, toNodeId: prefix + index, relation: 'maps_between', role: 'input' })
    }
  }
  const bounded = contract.connectionModels(manyNames, { ...args, compareModelId: 'night' })
  assert.equal(bounded.sameNamedTotal, 3600); assert.equal(bounded.sameNamed.length, 50, 'same-name expansion is bounded without suppressing total count')
  const emptyName = structuredClone(document)
  emptyName.graph.nodes.find(node => node.id === 'distance').text = ''
  assert.equal(contract.connectionModels(emptyName, { ...args, compareModelId: 'night' }).sameNamedTotal, 0)
  const peers = await post({ documentId: document.documentId, expectedRevision: 1, peerOf: 'taxi' }, 'connection-models')
  assert(peers.total > 20); assert(!peers.items.some(item => item.nodeId === 'taxi' || item.nodeId === 'named-copy'))
  const late = await post({ documentId: document.documentId, expectedRevision: 1, peerOf: 'taxi', offset: 20 }, 'connection-models')
  assert(late.items.some(item => item.nodeId === 'peer-9') && !peers.items.some(item => item.nodeId === 'peer-9'), 'comparison pagination reaches beyond the initial page')
  const searched = await post({ documentId: document.documentId, expectedRevision: 1, peerOf: 'taxi', query: '分段模型 9' }, 'connection-models')
  assert.equal(searched.items[0].nodeId, 'peer-9', 'comparison search is over canonical graph, not current page')
  const excluded = await post({ documentId: document.documentId, expectedRevision: 1, excludeModelId: 'taxi', query: '行驶距离' }, 'connection-models')
  assert(!excluded.items.some(item => item.nodeId === 'taxi'))

  const exercise = 'counterexample'
  const plan = await post({ ...args, exercise, action: 'plan' })
  const task = plan.tasks[0]
  assert.equal(task.id, 'model_counterexample:taxi'); assert.equal(task.controlledChange, 'learner_reported_not_verified')
  assert.deepEqual(task.references, []); assert(task.referenceCount > 0)
  const save = (response = counterexampleResponse, extra = {}) => post({ ...args, exercise, action: 'save', taskId: task.id,
    attemptId: 'challenge-1', selfRating: 'uncertain', response, ...extra })
  for (const field of ['baseline', 'baselinePrediction', 'changedVariable', 'falsifier']) {
    assert.equal((await save({ ...counterexampleResponse, [field]: '' })).error.code, 'invalid_input', field)
  }
  assert.equal((await save({ ...counterexampleResponse, baseline: '7 km', scenario: '７ ｋｍ！' })).error.code, 'invalid_input')
  assert.equal((await save({ ...counterexampleResponse, scenario: '!!!' })).error.code, 'invalid_input')
  assert.equal((await save({ ...counterexampleResponse, falsifier: 'a'.repeat(2001) })).error.code, 'invalid_input')
  assert.equal((await save(counterexampleResponse, { exercise: 'prediction' })).error.code, 'invalid_input', 'client cannot forge challenge snapshot under prediction plan')
  const initial = (await save()).attempt
  assert.equal(initial.response.baseline, counterexampleResponse.baseline)
  assert.equal(initial.task.exercise, 'counterexample'); assert.deepEqual(initial.task.references, [])
  assert.equal((await save()).attempt.version, 1)
  assert.equal((await save({ ...counterexampleResponse, baseline: 'different baseline' })).error.code, 'attempt_conflict')
  assert.equal((await post({ ...args, action: 'get', exercise: 'prediction', attemptId: initial.attemptId })).error.code, 'not_found')
  assert.equal((await post({ ...args, action: 'reveal', exercise: 'prediction', attemptId: initial.attemptId, expectedVersion: 1 })).error.code, 'invalid_input')
  const revealed = (await post({ ...args, action: 'reveal', exercise, attemptId: initial.attemptId, expectedVersion: 1 })).attempt
  assert.equal(revealed.version, 2); assert(revealed.task.references.length)
  const reviewed = (await post({ ...args, action: 'review', exercise, attemptId: initial.attemptId, expectedVersion: 2, review: learnerReview })).attempt
  assert.equal(reviewed.version, 3); assert.deepEqual(reviewed.response, initial.response)
  assert.equal(reviewed.task.refutation, 'not_verified', 'self review is not empirical refutation')

  const prediction = contract.learningPlan(document, { ...args }).tasks[0]
  store.saveLearningAttempt({ attemptId: 'prediction-before-flood', documentId: document.documentId, expectedRevision: 1,
    task: prediction, selfRating: 'uncertain', response: learnerResponse })
  const challenge = contract.learningPlan(document, { ...args, exercise }).tasks[0]
  for (let index = 0; index < 110; index++) store.saveLearningAttempt({ attemptId: 'challenge-flood-' + index, documentId: document.documentId,
    expectedRevision: 1, task: challenge, selfRating: 'uncertain', response: counterexampleResponse })
  assert.equal((await post({ ...args, exercise: 'prediction', action: 'attempts' })).attempts.length, 1, 'exercise scope must precede history LIMIT')
  assert.equal((await post({ ...args, exercise, action: 'attempts' })).attempts.length, 100)
  assert.equal(JSON.stringify(store.getDocument(document.documentId)), before, 'comparison and challenge lifecycle cannot alter canonical graph')
  store.saveGraph({ ...document.graph, summary: 'source revision changed' }, { sourceText: document.sourceText, sourceUnits: document.sourceUnits, expectedRevision: 1 })
  assert.equal((await save()).attempt.stale, true, 'lost acknowledgement retry preserves old version snapshot')
  assert.equal((await post({ ...args, exercise, action: 'get', attemptId: initial.attemptId })).attempt.response.falsifier, counterexampleResponse.falsifier)
  assert.equal((await post({ ...args, exercise: 'unknown', action: 'plan' })).error.code, 'invalid_input')
  console.log(JSON.stringify({ ok: true, identityNotLabel: true, comparisonDoesNotInferEquivalence: true, unknownAndDuplicatePortsVisible: true,
    canonicalPagination: true, controlledChangeNotAutoVerified: true, immutableCounterexample: true, scopedHistoryBeforeLimit: true, graphUnchanged: true }))
} finally { harness.stop() }
