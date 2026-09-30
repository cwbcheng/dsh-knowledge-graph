import assert from 'node:assert/strict'
import { createGraphContract } from '../src/index.host.js'
import { modelLearningHarness, learnerResponse, learnerReview } from './kg-model-learning-fixture-data.mjs'

const harness = await modelLearningHarness({ legacy: true })
const { document, store, post } = harness
const documentId = document.documentId, modelId = 'taxi'
const args = { documentId, modelId, expectedRevision: 1 }
try {
  assert.equal(store.getLearningAttempt('legacy').answer, 'Old learner answer', 'additive migration preserves legacy records')
  assert.equal(store.getLearningAttempt('legacy').version, 1)
  assert.equal(store.listLearningAttempts(documentId).length, 1)
  const before = JSON.stringify(store.getDocument(documentId))
  const contracts = createGraphContract()
  const unknown = contracts.learningPlan(document, { ...args, modelId: 'unknown' })
  assert.equal(unknown.tasks[0].model.inputs.length, 0, 'unknown roles cannot be guessed')
  assert.equal(unknown.tasks[0].model.unknown.length, 2)
  const wrong = contracts.learningPlan(document, { ...args, modelId: 'wrong' })
  assert(wrong.tasks[0].model.warnings.some(item => item.includes('错误示例')))
  assert.equal(contracts.learningPlan(document, { ...args, modelId: 'fare' }).error.code, 'not_found')
  assert.equal(contracts.learningPlan(document, { ...args, expectedRevision: undefined }).error.code, 'revision_conflict', 'model exercises require a revision fence')
  const ungrounded = structuredClone(document)
  Object.assign(ungrounded.graph.nodes.find(node => node.id === 'taxi'), { quote: 'invented', evidence: [] })
  assert.equal(contracts.learningPlan(ungrounded, args).tasks.length, 0)
  const task = (await post({ ...args, action: 'plan' })).tasks[0]
  assert.equal(task.modelId, modelId)
  assert.equal(task.novelty, 'not_verified')
  assert.equal(task.references.length, 0, 'HTTP plan conceals reference examples before prediction')
  assert(task.referenceCount >= 4)
  const body = { ...args, action: 'save', attemptId: 'prediction-1', taskId: task.id,
    selfRating: 'uncertain', response: learnerResponse, task: { references: [{ quote: 'forged' }] } }
  const reviewArgs = { documentId, modelId, attemptId: body.attemptId, action: 'review', expectedVersion: 1, review: learnerReview }
  assert.equal((await post(reviewArgs)).error.code, 'invalid_input', 'reveal/review before saving cannot succeed')
  assert.equal((await post({ ...body, modelId: 'unknown' })).error.code, 'invalid_input', 'task cannot cross model scopes')
  assert.equal((await post({ ...body, response: { ...learnerResponse, mapping: '' } })).error.code, 'invalid_input')
  assert.equal((await post({ ...body, response: { ...learnerResponse, scenario: document.sourceUnits[2].text } })).error.code, 'invalid_input')
  const saved = (await post(body)).attempt
  assert.equal(saved.version, 1)
  assert.equal(saved.revealedAt, null)
  assert.equal(saved.task.references.length, 0)
  assert.equal(saved.response.prediction, learnerResponse.prediction)
  assert.deepEqual((await post({ ...args, action: 'attempts' })).attempts.map(item => item.attemptId), ['prediction-1'])
  assert.equal((await post({ action: 'attempts', documentId })).attempts.length, 1, 'generic and model histories remain separate')
  assert.equal((await post(reviewArgs)).error.code, 'invalid_input', 'review requires explicit source reveal')
  assert.equal((await post({ ...body, response: { ...learnerResponse, prediction: '改成 16 元' } })).error.code, 'attempt_conflict')
  const reveal = { action: 'reveal', documentId, modelId, attemptId: saved.attemptId, expectedVersion: 1 }
  for (const change of [{ modelId: 'unknown' }, { documentId: 'other' }, { expectedVersion: 9 }]) {
    assert((await post({ ...reveal, ...change })).error, 'spoofed identities or future versions cannot reveal')
  }
  const revealed = (await post(reveal)).attempt
  assert.equal(revealed.version, 2)
  assert(revealed.revealedAt >= saved.createdAt)
  assert(revealed.task.references.some(ref => ref.nodeId === 'example'), 'references belong to this model, via its rule')
  assert(!JSON.stringify(revealed.task.references).includes('forged'), 'client-supplied task and reference are ignored')
  assert.equal((await post(reveal)).attempt.revealedAt, revealed.revealedAt, 'lost reveal responses are idempotent')
  assert.equal((await post(reviewArgs)).error.code, 'attempt_conflict', 'stale review version cannot overwrite')
  const reviewed = (await post({ ...reviewArgs, expectedVersion: 2 })).attempt
  assert.equal(reviewed.version, 3)
  assert.deepEqual(reviewed.review.content, learnerReview)
  assert.deepEqual(reviewed.response, saved.response, 'review never overwrites original prediction')
  assert.equal((await post({ ...reviewArgs, expectedVersion: 2 })).attempt.version, 3)
  assert.equal((await post({ ...reviewArgs, expectedVersion: 2, review: { ...learnerReview, reflection: '覆盖复盘' } })).error.code, 'attempt_conflict')
  assert.equal((await post({ ...reveal, action: 'get', modelId: 'unknown' })).error.code, 'not_found')
  assert.equal(JSON.stringify(store.getDocument(documentId)), before, 'the entire learning lifecycle is independent of canonical graph')

  // Other models must not evict this model's history before filtering.
  const otherTask = contracts.learningPlan(document, { ...args, modelId: 'unknown' }).tasks[0]
  for (let index = 0; index < 110; index++) store.saveLearningAttempt({ attemptId: 'other-' + index,
    documentId, expectedRevision: 1, task: otherTask, selfRating: 'uncertain', response: learnerResponse })
  assert.equal(store.listLearningAttempts(documentId, modelId).length, 1)
  assert.equal(store.listLearningAttempts(documentId, 'unknown').length, 100)
  assert(store.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM learning_attempts WHERE document_id = ? AND model_id = ?
    ORDER BY created_at DESC, attempt_id DESC LIMIT 100`).all(documentId, modelId).some(row => row.detail.includes('learning_attempts_model_idx')))
  store.saveGraph({ ...document.graph, nodes: document.graph.nodes.map(node => node.id === modelId ? { ...node, text: '新版模型' } : node) },
    { sourceText: document.sourceText, sourceUnits: document.sourceUnits, expectedRevision: 1 })
  const stale = (await post({ ...args, action: 'attempts' })).attempts[0]
  assert.equal(stale.stale, true)
  assert.equal(stale.task.model.text, reviewed.task.model.text, 'old model formulation is snapshotted')
  assert.equal((await post(body)).attempt.stale, true, 'exact committed-save retry works after source revision change')
  assert.equal((await post({ ...body, attemptId: 'stale-new' })).error.code, 'revision_conflict')
  assert.equal((await post({ ...reviewArgs, expectedVersion: 2 })).attempt.review.createdAt, reviewed.review.createdAt)
  assert.equal(store.getDocumentRevision(documentId), 2)
  console.log(JSON.stringify({ ok: true, migrationPreservesLegacy: true, modelScopedHistory: true,
    predictThenReveal: true, immutablePredictionAndReview: true, snapshotAndRetry: true, canonicalIndependent: true }))
} finally { harness.stop() }
