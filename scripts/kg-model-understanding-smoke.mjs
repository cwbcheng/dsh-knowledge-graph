import assert from 'node:assert/strict'
import { modelLearningHarness, learnerResponse, learnerReview } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

const understandingResponse = { inputs: '先判断里程与计费单位。', mapping: '基础费用加超出基础里程的收费。',
  outputs: '本次应付的金额，不包括尚未说明的额外收费。', conditions: '适用于这个简化计价情境。',
  boundary: '夜间附加收费尚未确认。', questions: '同一里程是否在所有时段都同价？', revisionReason: '', parentAttemptId: '', practiceIds: [] }

const harness = await modelLearningHarness({ legacy: true, fixture: modelStructureFixture() })
const { store, document, post } = harness
const base = { documentId: document.documentId, modelId: 'taxi', exercise: 'understanding' }
const save = (attemptId, response, expectedRevision = 1, extra = {}) => post({ ...base, action: 'save', expectedRevision,
  taskId: 'model_understanding:taxi', attemptId, selfRating: 'not_assessed', response, ...extra })
try {
  const before = store.getDocument(document.documentId), unitsBefore = store.getDocumentSourceUnits(document.documentId)
  const legacyBefore = store.getLearningAttempt('legacy')
  const plan = await post({ ...base, action: 'plan', expectedRevision: 1 })
  assert.equal((await post({ documentId: document.documentId, modelId: 'taxi', expectedRevision: 1 }, 'connection-models')).modelUnderstandingVersion, 1)
  assert.equal(plan.modelUnderstandingVersion, 1)
  assert.equal(plan.tasks[0].origin, 'personal_expression_not_source')
  assert.equal(plan.tasks[0].assessment, 'not_assessed')
  assert.equal(plan.tasks[0].model.branches[0].provenance.mapping.kind, 'source')
  assert(plan.tasks[0].model.branches[0].provenance.mapping.quote)
  assert(plan.tasks[0].references.length, 'personal comparison includes source without pretending it is a blind exercise')
  const predictionPlan = await post({ documentId: document.documentId, modelId: 'taxi', action: 'plan', expectedRevision: 1 })
  const prediction = await post({ documentId: document.documentId, modelId: 'taxi', action: 'save', expectedRevision: 1,
    taskId: predictionPlan.tasks[0].id, attemptId: 'practice', selfRating: 'uncertain', response: learnerResponse })
  assert(!prediction.error)
  const practiceBefore = store.getLearningAttempt('practice')
  const firstResponse = { ...understandingResponse, practiceIds: ['practice'] }
  const first = await save('understanding-1', firstResponse, 1, { task: { model: { text: 'Forged source' }, grading: 'mastered' } })
  assert(!first.error, JSON.stringify(first))
  assert.equal(first.attempt.modelId, 'taxi')
  assert.deepEqual(first.attempt.task.model, plan.tasks[0].model, 'snapshot comes from Host, not supplied task')
  assert.equal(first.attempt.task.practiceSnapshots[0].revealedAt, null)
  assert.equal(first.attempt.task.practiceSnapshots[0].review, null)
  assert(!JSON.stringify(first.attempt.task.practiceSnapshots).includes('references'), 'linking a prediction does not reveal its reference')
  assert.deepEqual(store.getLearningAttempt('practice'), practiceBefore, 'linking leaves practice immutable')
  assert.deepEqual((await save('understanding-1', firstResponse)).attempt, first.attempt, 'lost save response retry is idempotent')
  assert.equal((await save('understanding-1', { ...firstResponse, mapping: 'Attempted overwrite' })).error.code, 'attempt_conflict')
  assert.equal((await save('bad-rating', firstResponse, 1, { selfRating: 'confident' })).error.code, 'invalid_input')
  assert.equal((await save('blank', { ...firstResponse, mapping: '  ' })).error.code, 'invalid_input')
  assert.equal((await save('long', { ...firstResponse, mapping: 'x'.repeat(4001) })).error.code, 'invalid_input')
  assert.equal((await save('bad-parent', { ...firstResponse, parentAttemptId: 'missing', revisionReason: 'Change' })).error.code, 'attempt_conflict')
  assert.equal((await save('no-reason', { ...firstResponse, parentAttemptId: 'understanding-1' })).error.code, 'invalid_input')
  assert.equal((await save('cross-model', { ...firstResponse, practiceIds: ['understanding-1'], parentAttemptId: 'understanding-1', revisionReason: 'Change' })).error.code, 'invalid_input')
  const anotherGraph = structuredClone(document.graph)
  anotherGraph.source.documentId = 'other-document'
  store.saveGraph(anotherGraph, { sourceText: document.sourceText, sourceUnits: document.sourceUnits })
  const otherPlan = await post({ documentId: 'other-document', modelId: 'taxi', action: 'plan', expectedRevision: 1 })
  assert(!otherPlan.error, JSON.stringify(otherPlan))
  await post({ documentId: 'other-document', modelId: 'taxi', action: 'save', expectedRevision: 1, taskId: otherPlan.tasks[0].id,
    attemptId: 'foreign-practice', selfRating: 'uncertain', response: learnerResponse })
  assert.equal((await save('foreign', { ...firstResponse, practiceIds: ['foreign-practice'], parentAttemptId: 'understanding-1', revisionReason: 'Change' })).error.code, 'invalid_input')
  assert.equal((await save('duplicates', { ...firstResponse, practiceIds: ['practice', 'practice'] })).error.code, 'invalid_input')
  assert.equal((await post({ ...base, action: 'reveal', attemptId: 'understanding-1', expectedVersion: 1 })).error.code, 'invalid_input')
  assert.equal((await post({ ...base, action: 'get', modelId: 'unknown', attemptId: 'understanding-1' })).error.code, 'not_found')
  const revealed = await post({ documentId: document.documentId, modelId: 'taxi', action: 'reveal', attemptId: 'practice', expectedVersion: 1 })
  await post({ documentId: document.documentId, modelId: 'taxi', action: 'review', attemptId: 'practice', expectedVersion: revealed.attempt.version, review: learnerReview })
  assert.deepEqual(store.getLearningAttempt('understanding-1'), first.attempt, 'later reflection does not rewrite earlier attached evidence')
  const revision2 = { ...firstResponse, parentAttemptId: first.attempt.attemptId, revisionReason: '复盘发现需要保留时段限制。', mapping: '仅在条件明确的分支内使用里程计价。' }
  const [second, competing] = await Promise.all([save('understanding-2', revision2), save('understanding-competing', { ...revision2, mapping: 'Another concurrent opinion' })])
  assert(!second.error, JSON.stringify(second))
  assert.equal(competing.error.code, 'attempt_conflict', 'same-parent concurrent revisions cannot both become latest')
  assert.equal(second.attempt.task.practiceSnapshots[0].version, 3)
  assert.deepEqual(second.attempt.task.practiceSnapshots[0].review.content, learnerReview)
  assert.equal((await post({ ...base, action: 'attempts' })).attempts[0].attemptId, 'understanding-2')
  assert.deepEqual(store.getDocument(document.documentId), before)
  assert.deepEqual(store.getDocumentSourceUnits(document.documentId), unitsBefore)
  assert.deepEqual(store.getLearningAttempt('legacy'), legacyBefore)
  const updated = structuredClone(document.graph)
  updated.nodes.find(node => node.id === 'taxi').text = 'Changed canonical statement'
  store.saveGraph(updated, { sourceText: document.sourceText, sourceUnits: document.sourceUnits, expectedRevision: 1 })
  assert.equal((await save('stale', { ...revision2, parentAttemptId: 'understanding-2' })).error.code, 'revision_conflict')
  assert.equal((await save('understanding-2', revision2)).attempt.stale, true, 'old successful saves remain retryable after source revision changes')
  const third = await save('understanding-3', { ...revision2, parentAttemptId: 'understanding-2' }, 2)
  assert(!third.error)
  assert.equal(third.attempt.task.model.text, 'Changed canonical statement')
  assert.notEqual(store.getLearningAttempt('understanding-1').task.model.text, 'Changed canonical statement')
  const withoutQuotes = structuredClone(updated)
  for (const node of withoutQuotes.nodes) { node.quote = ''; node.evidence = []; node.modelStructure = null }
  for (const edge of withoutQuotes.edges) { edge.quote = ''; edge.evidence = [] }
  store.saveGraph(withoutQuotes, { sourceText: '', sourceUnits: [], expectedRevision: 2 })
  const ungrounded = await post({ ...base, action: 'plan', expectedRevision: 3 })
  assert.equal(ungrounded.tasks[0].references.length, 0)
  assert.equal(ungrounded.tasks.length, 1, 'personal expression is allowed without pretending it has a source answer')
  console.log(JSON.stringify({ ok: true, actualSqliteHttp: true, serverSnapshots: true, appendOnly: true, parentCAS: true,
    idempotentRetry: true, sourceRevisionFence: true, frozenPracticeEvidence: true, noMasteryCertification: true, canonicalUnchanged: true }))
} finally { harness.stop() }
