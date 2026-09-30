import assert from 'node:assert/strict'
import { modelLearningHarness, learnerResponse, learnerReview } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { feedbackResponse } from './kg-model-feedback-fixture-data.mjs'

const harness = await modelLearningHarness({ legacy: true, fixture: modelStructureFixture() })
const { store, document, post } = harness
const base = { documentId: document.documentId, modelId: 'taxi' }
const history = (extra = {}) => post({ ...base, action: 'model-history', expectedRevision: 1, ...extra })
try {
  const plan = await post({ ...base, action: 'plan', expectedRevision: 1 })
  assert.equal((await post({ ...base, expectedRevision: 1 }, 'connection-models')).modelLearningHistoryVersion, 1)
  for (let index = 0; index < 125; index++) {
    await post({ ...base, action: 'save', expectedRevision: 1, taskId: plan.tasks[0].id,
      attemptId: 'prediction-' + String(index).padStart(3, '0'), selfRating: 'confident', response: learnerResponse })
  }
  const add = (id, predictionId, response) => store.saveModelFeedback({ ...base,
    attemptId: id, predictionId, expectedVersion: 1, expectedRevision: 1, response })
  const original = add('original', 'prediction-000', { ...feedbackResponse(), comparison: 'different', diagnosis: 'input' })
  let parent = original.attemptId
  for (let index = 0; index < 105; index++) {
    const correction = add('correction-' + index, 'prediction-000', { ...feedbackResponse(), comparison: 'consistent', diagnosis: 'no_change',
      parentResultId: parent, revisionReason: '修正重复转录，不增加独立观察。' })
    parent = correction.attemptId
  }
  add('distinct-observation', 'prediction-000', { ...feedbackResponse(), comparison: 'different', diagnosis: 'calculation' })
  add('ai-input', 'prediction-000', { ...feedbackResponse('ai_suggestion'), comparison: 'different', diagnosis: 'input' })
  add('condition-a', 'prediction-001', { ...feedbackResponse(), comparison: 'different', diagnosis: 'condition' })
  add('condition-b', 'prediction-001', { ...feedbackResponse(), comparison: 'different', diagnosis: 'condition' })
  add('not-an-observation-now', 'prediction-002', feedbackResponse())
  add('reclassified', 'prediction-002', { ...feedbackResponse('reflection'), parentResultId: 'not-an-observation-now', revisionReason: '并非实际观察。' })
  for (const type of ['reference', 'derivation', 'reflection']) add('typed-' + type, 'prediction-003', feedbackResponse(type))
  const challengePlan = await post({ ...base, action: 'plan', exercise: 'counterexample', expectedRevision: 1 })
  await post({ ...base, action: 'save', exercise: 'counterexample', taskId: challengePlan.tasks[0].id, expectedRevision: 1,
    attemptId: 'challenge', selfRating: 'uncertain', response: { ...learnerResponse, baseline: '原来行驶 2 km。', baselinePrediction: '预测 10 元。',
      changedVariable: '只改变里程，其余条件保持不变。', falsifier: '在相同口径下观察到不同费用。' } })
  add('challenge-result', 'challenge', feedbackResponse('derivation'))
  await post({ ...base, action: 'reveal', attemptId: 'prediction-004', expectedVersion: 1 })
  await post({ ...base, action: 'review', attemptId: 'prediction-004', expectedVersion: 2, review: { ...learnerReview, diagnosis: 'input' } })
  // Extra rows with the same root identity must not take over another model/document's chain.
  const foreignInsert = store.db.prepare(`INSERT INTO learning_attempts
    (attempt_id, document_id, base_revision, task_id, task_kind, task_json, answer, scenario, self_rating, created_at, model_id, response_json)
    SELECT ?, ?, base_revision, task_id, task_kind, task_json, answer, scenario, self_rating, created_at + 1000000, ?, response_json
    FROM learning_attempts WHERE attempt_id = ?`)
  foreignInsert.run('foreign-model', base.documentId, 'elsewhere', parent)
  foreignInsert.run('foreign-document', 'another-document', base.modelId, parent)
  const graphBefore = store.getDocument(base.documentId), unitsBefore = store.getDocumentSourceUnits(base.documentId)
  const rowsBefore = store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()
  const all = await history()
  assert(!all.error, JSON.stringify(all))
  assert.equal(all.basis, 'learner_reports_not_mastery')
  assert.equal(all.summary.predictions, 126)
  assert.equal(all.summary.currentRevision, 126)
  assert.equal(all.summary.withFeedback, 5)
  assert.equal(all.summary.withReview, 1)
  assert.equal(all.summary.unrevealed, 125)
  assert.equal(all.summary.corrections, 106)
  assert.equal(all.total, 126)
  assert.equal(all.items.length, 20)
  const observed = all.sourceCounts.find(item => item.type === 'observation')
  assert.equal(observed.predictions, 2, 'multiple observation roots and revisions on one prediction count once')
  assert.equal(observed.roots, 4)
  assert.equal(observed.consistent, 1)
  assert.equal(observed.different, 2)
  assert.equal(observed.mixed, 1, 'do not select a winner between distinct conflicting reported observations')
  assert.equal(all.sourceCounts.find(item => item.type === 'ai_suggestion').predictions, 1)
  assert.equal((await history({ sourceType: 'observation', diagnosis: 'input' })).total, 0,
    'old corrected diagnosis and an AI diagnosis cannot become current observation error evidence')
  const calculation = await history({ sourceType: 'observation', diagnosis: 'calculation', comparison: 'different' })
  assert.equal(calculation.total, 1)
  assert.equal(calculation.items[0].attemptId, 'prediction-000', 'filter the full archive, not the recent 100 predictions')
  assert.equal(calculation.items[0].matchingResultId, 'distinct-observation')
  assert(!JSON.stringify(calculation).includes('citations'), 'history cannot reveal source references before explicit reveal')
  const direct = await post({ ...base, action: 'get', attemptId: 'prediction-000', exercise: 'prediction' })
  assert.equal(direct.attempt.attemptId, 'prediction-000')
  assert.deepEqual(direct.attempt.task.references, [])
  const root = await post({ ...base, action: 'get', attemptId: original.attemptId, exercise: 'feedback' })
  assert.equal(root.resultHeadId, parent, 'a historical result outside the recent window still knows its current correction head')
  assert.equal((await post({ ...base, action: 'get', modelId: 'wrong', attemptId: original.attemptId, exercise: 'feedback' })).error.code, 'not_found')
  assert.equal((await history({ exercise: 'counterexample' })).total, 1)
  assert.equal((await history({ sourceType: 'observation', diagnosis: 'condition' })).total, 1)
  assert.equal((await history({ sourceType: 'ai_suggestion', diagnosis: 'calculation' })).total, 0,
    'source and diagnosis must match the same current result, not two different roots')
  const ids = new Set()
  for (let offset = 0; offset < all.total; offset += 20) {
    for (const item of (await history({ offset })).items) { assert(!ids.has(item.attemptId)); ids.add(item.attemptId) }
  }
  assert.equal(ids.size, 126)
  for (const invalid of [{ offset: -1 }, { offset: 1.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { sourceType: 'verified' },
    { diagnosis: 'boundary' }, { comparison: 'correct' }, { exercise: 'understanding' }, { modelId: '' }, { expectedRevision: '1' }]) {
    assert.equal((await history(invalid)).error.code, 'invalid_input', JSON.stringify(invalid))
  }
  assert.equal((await history({ expectedRevision: 2 })).error.code, 'revision_conflict')
  assert.deepEqual(store.getDocument(base.documentId), graphBefore)
  assert.deepEqual(store.getDocumentSourceUnits(base.documentId), unitsBefore)
  assert.deepEqual(store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all(), rowsBefore, 'history is read-only')
  store.saveGraph({ ...document.graph, summary: 'Explicit fixture revision' }, { sourceText: document.sourceText, sourceUnits: document.sourceUnits, expectedRevision: 1 })
  const older = await history({ expectedRevision: 2 })
  assert.equal(older.summary.currentRevision, 0)
  assert.equal(older.summary.olderRevision, 126)
  assert(older.items.every(item => item.stale))
  console.log(JSON.stringify({ ok: true, productionRoutesSqlite: true, archivePredictions: 126, correctionRows: 106,
    foldBeforeFilterAndPage: true, sourceIsolation: true, sameResultFilter: true, noMasteryOrAutoReveal: true, readOnly: true }))
} finally { harness.stop() }
