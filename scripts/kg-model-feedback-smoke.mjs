import assert from 'node:assert/strict'
import { modelLearningHarness, learnerResponse, learnerReview } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { feedbackResponse } from './kg-model-feedback-fixture-data.mjs'

const harness = await modelLearningHarness({ legacy: true, fixture: modelStructureFixture() })
const { store, document, post } = harness
const base = { documentId: document.documentId, modelId: 'taxi' }
const save = (attemptId, response = feedbackResponse(), extra = {}) => post({ ...base, action: 'save-result',
  predictionId: 'prediction', attemptId, expectedRevision: 1, expectedVersion: 1, response, ...extra })
try {
  const graphBefore = store.getDocument(document.documentId), unitsBefore = store.getDocumentSourceUnits(document.documentId)
  const legacyBefore = store.getLearningAttempt('legacy')
  const plan = await post({ ...base, action: 'plan', expectedRevision: 1 })
  assert.equal(plan.modelFeedbackVersion, 1)
  assert.equal((await post({ ...base, expectedRevision: 1 }, 'connection-models')).modelFeedbackVersion, 1)
  await post({ ...base, action: 'save', expectedRevision: 1, taskId: plan.tasks[0].id,
    attemptId: 'prediction', selfRating: 'uncertain', response: learnerResponse })
  const predictionBefore = store.getLearningAttempt('prediction')
  const observed = await save('observation', feedbackResponse(), { task: { assessment: 'verified', references: ['forged'] }, selfRating: 'confident' })
  assert(!observed.error, JSON.stringify(observed))
  assert.equal(observed.modelFeedbackVersion, 1)
  assert.equal(observed.attempt.selfRating, 'not_assessed')
  assert.equal(observed.attempt.task.assessment, 'not_independently_verified')
  assert.equal(observed.attempt.task.predictionSnapshot.version, 1)
  assert.deepEqual(observed.attempt.task.predictionSnapshot.response, learnerResponse)
  assert(!JSON.stringify(observed.attempt.task).includes('citations'), 'result cannot reveal hidden source references')
  assert.deepEqual(store.getLearningAttempt('prediction'), predictionBefore, 'results do not reveal or modify the prediction')
  assert.deepEqual((await save('observation')).attempt, observed.attempt)
  assert.equal((await save('observation', { ...feedbackResponse(), content: 'Overwrite' })).error.code, 'attempt_conflict')
  for (const [name, patch] of Object.entries({ blank: { content: '  ' }, long: { content: 'x'.repeat(4001) }, planned: { observationConfirmed: false },
    missingContext: { context: '' }, future: { observedOn: '9999-12-31' }, invalidDay: { observedOn: '2025-02-29' },
    noZone: { observedTimeZone: '' }, invalidZone: { observedTimeZone: 'Invented/Zone' },
    unsafeLink: { sourceUrl: 'javascript:alert(1)' }, credentials: { sourceUrl: 'https://user:secret@example.test/a' },
    unknown: { type: 'verified' }, noRationale: { rationale: '' }, prematureDiagnosis: { comparison: 'not_compared', diagnosis: 'input' } })) {
    assert.equal((await save('bad-' + name, { ...feedbackResponse(), ...patch })).error.code, 'invalid_input', name)
  }
  const actualNow = Date.now
  try {
    Date.now = () => Date.parse('2026-01-01T18:00:00Z')
    assert(!(await save('time-zone-day', { ...feedbackResponse(), observedOn: '2026-01-02' })).error, 'an already-started local calendar day is not future just because UTC is yesterday')
  } finally { Date.now = actualNow }
  assert.equal((await save('wrong-model', feedbackResponse(), { modelId: 'speed' })).error.code, 'invalid_input')
  assert.equal((await save('wrong-document', feedbackResponse(), { documentId: 'elsewhere' })).error.code, 'invalid_input')
  assert.equal((await save('wrong-revision', feedbackResponse(), { expectedRevision: 2 })).error.code, 'invalid_input')
  assert.equal((await save('wrong-version', feedbackResponse(), { expectedVersion: 2 })).error.code, 'attempt_conflict')
  for (const invalidId of [null, {}, 'x'.repeat(121)]) assert.equal((await post({ ...base, action: 'results', predictionId: invalidId })).error.code, 'invalid_input')
  assert.equal((await save('review-as-observation', { ...feedbackResponse('reflection'), observationConfirmed: true })).error.code, 'invalid_input')
  assert.equal((await save('ai-without-source', { ...feedbackResponse('ai_suggestion'), sourceName: '' })).error.code, 'invalid_input')
  assert.equal((await save('empty-derivation', { ...feedbackResponse('derivation'), context: '' })).error.code, 'invalid_input')
  assert.equal((await save('unlocatable-reference', { ...feedbackResponse('reference'), sourceLocator: '' })).error.code, 'invalid_input')
  for (const type of ['reflection', 'ai_suggestion', 'derivation', 'reference']) assert(!(await save(type, feedbackResponse(type))).error, type)
  const citation = predictionBefore.task.references[0].citations[0]
  const reference = { nodeId: predictionBefore.task.references[0].nodeId, paragraph: citation.paragraph, quote: citation.quote.slice(0, 100) }
  const bookResponse = { ...feedbackResponse('reference'), sourceName: '', sourceLocator: '', reference }
  assert.equal((await save('hidden-reference', bookResponse)).error.code, 'invalid_input')
  const revealed = await post({ ...base, action: 'reveal', attemptId: 'prediction', expectedVersion: 1 })
  const frozenObservation = store.getLearningAttempt('observation')
  assert.equal((await save('stale-prediction', feedbackResponse())).error.code, 'attempt_conflict')
  assert.deepEqual((await save('observation')).attempt, frozenObservation, 'retry is based on the original receipt, not latest reveal version')
  assert.equal((await save('forged-quote', { ...bookResponse, reference: { ...reference, quote: 'Invented source' } }, { expectedVersion: 2 })).error.code, 'invalid_input')
  assert.equal((await save('forged-node', { ...bookResponse, reference: { ...reference, nodeId: 'foreign' } }, { expectedVersion: 2 })).error.code, 'invalid_input')
  const book = await save('book', bookResponse, { expectedVersion: revealed.attempt.version })
  assert(!book.error, JSON.stringify(book))
  assert.equal(book.attempt.task.reference.origin, 'frozen_source_reference_not_outcome')
  await post({ ...base, action: 'review', attemptId: 'prediction', expectedVersion: 2, review: learnerReview })
  assert.deepEqual(store.getLearningAttempt('book'), book.attempt, 'later review cannot rewrite an evidence snapshot')
  const change = { ...feedbackResponse(), parentResultId: 'observation', revisionReason: '更正实付金额，保留之前的记录。', content: '实付为 20 元，仍包含额外费用。' }
  const [correction, competing] = await Promise.all([save('correction', change, { expectedVersion: 3 }), save('competing', { ...change, content: 'Another correction' }, { expectedVersion: 3 })])
  assert(!correction.error)
  assert.equal(correction.attempt.task.rootResultId, 'observation')
  assert.equal(competing.error.code, 'attempt_conflict', 'a corrected result cannot fork into two current versions')
  assert.equal((await save('no-reason', { ...change, revisionReason: '' }, { expectedVersion: 3 })).error.code, 'invalid_input')
  assert.equal((await save('wrong-parent', { ...change, parentResultId: 'prediction' }, { expectedVersion: 3 })).error.code, 'invalid_input')
  assert.equal((await post({ ...base, action: 'reveal', exercise: 'feedback', attemptId: 'book', expectedVersion: 1 })).error.code, 'invalid_input')
  await post({ ...base, action: 'save', expectedRevision: 1, taskId: plan.tasks[0].id, attemptId: 'other-prediction', selfRating: 'uncertain', response: learnerResponse })
  assert.equal((await save('cross-prediction-parent', { ...change, parentResultId: 'book' }, { predictionId: 'other-prediction' })).error.code, 'invalid_input')
  const challengePlan = await post({ ...base, action: 'plan', exercise: 'counterexample', expectedRevision: 1 })
  await post({ ...base, action: 'save', exercise: 'counterexample', expectedRevision: 1, taskId: challengePlan.tasks[0].id,
    attemptId: 'challenge', selfRating: 'uncertain', response: { ...learnerResponse, baseline: '在相同条件下行驶 2 km。', baselinePrediction: '我预测 10 元。',
      changedVariable: '仅将里程增加到 7 km，其余收费条件保持不变。', falsifier: '若无额外费用而账单基础费用不为 18 元，则需要检查这个规律。' } })
  const challengeResult = await save('challenge-result', feedbackResponse('reflection'), { predictionId: 'challenge', expectedVersion: 1 })
  assert(!challengeResult.error)
  assert.equal(challengeResult.attempt.task.predictionSnapshot.exercise, 'counterexample')
  assert(challengeResult.attempt.task.predictionSnapshot.response.falsifier)
  for (let index = 0; index < 101; index++) {
    store.saveModelFeedback({ ...base, attemptId: 'unrelated-' + index, predictionId: 'other-prediction', expectedVersion: 1, expectedRevision: 1, response: feedbackResponse('reflection') })
  }
  const history = await post({ ...base, action: 'results', predictionId: 'prediction' })
  assert.equal(history.total, 8)
  assert.equal(history.attempts.length, 8, 'prediction filter applies before the 100-record limit')
  assert(history.attempts.every(item => item.task.predictionId === 'prediction'))
  const understanding = await post({ ...base, action: 'save', exercise: 'understanding', expectedRevision: 1, taskId: 'model_understanding:taxi',
    attemptId: 'understanding', selfRating: 'not_assessed', response: { inputs: '', mapping: '附加费用仍需核对。', outputs: '', conditions: '', boundary: '',
      questions: '', revisionReason: '', parentAttemptId: '', practiceIds: ['prediction'] } })
  assert(!understanding.error, JSON.stringify(understanding))
  assert.equal(understanding.attempt.task.practiceSnapshots[0].feedbackSnapshots.length, 5)
  assert.equal(understanding.attempt.task.practiceSnapshots[0].feedbackLimited, true)
  assert.equal((await save('understanding-as-prediction', feedbackResponse(), { predictionId: 'understanding', expectedVersion: 1 })).error.code, 'invalid_input')
  assert.deepEqual(store.getDocument(document.documentId), graphBefore, 'feedback leaves the whole canonical graph unchanged')
  assert.deepEqual(store.getDocumentSourceUnits(document.documentId), unitsBefore)
  assert.deepEqual(store.getLearningAttempt('legacy'), legacyBefore)
  const updated = structuredClone(document.graph)
  updated.nodes.find(node => node.id === 'taxi').text = 'Changed canonical model'
  for (const node of updated.nodes) node.modelStructure = null
  store.saveGraph(updated, { sourceText: 'New unrelated source', sourceUnits: [{ paragraph: 0, text: 'New unrelated source' }], expectedRevision: 1 })
  const updatedBefore = store.getDocument(document.documentId), updatedUnitsBefore = store.getDocumentSourceUnits(document.documentId)
  const late = await save('late-observation', feedbackResponse(), { expectedVersion: 3 })
  assert(!late.error, JSON.stringify(late))
  assert.equal(late.attempt.stale, true, 'late observations remain bound to the original prediction, not the current graph')
  assert.notEqual(late.attempt.task.predictionSnapshot.model.text, 'Changed canonical model')
  assert(!(await save('late-book', bookResponse, { expectedVersion: 3 })).error, 'old source evidence is validated against its frozen reference')
  assert.equal((await save('observation')).attempt.stale, true, 'an exact receipt remains retryable after source changes')
  assert.deepEqual(store.getLearningAttempt('understanding').task, understanding.attempt.task, 'later results do not rewrite a saved understanding')
  assert.deepEqual(store.getLearningAttempt('legacy'), { ...legacyBefore, stale: true })
  assert.deepEqual(store.getDocument(document.documentId), updatedBefore)
  assert.deepEqual(store.getDocumentSourceUnits(document.documentId), updatedUnitsBefore)
  assert.notDeepEqual(store.getDocumentSourceUnits(document.documentId), unitsBefore, 'only explicit fixture change replaces source units')
  console.log(JSON.stringify({ ok: true, productionRoutesSqlite: true, typedSources: 5, noVerdictOrMastery: true, hiddenReferencesProtected: true,
    calendarTimeZone: true, correctionCAS: true, immutablePrediction: true, receiptRetry: true, lateObservationOldVersion: true, frozenUnderstandingEvidence: true }))
} finally { harness.stop() }
