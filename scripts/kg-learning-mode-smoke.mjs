import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { openSqliteStore } from '../src/kg-store.mjs'

const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const start = source.indexOf('      function learningPlanHost(')
const end = source.indexOf('      function splitParagraphsOffsetsHost(', start)
assert(start >= 0 && end > start, 'learning tasks must be derived from the authoritative Host graph')
const learningPlanHost = new Function('splitParagraphsHost', source.slice(start, end) + '\nreturn learningPlanHost')(
  text => text.split(/\n\s*\n/))

const documentId = 'learning-fixture'
const sourceId = 'learning-source'
const paragraphs = ['迁移是把学过的知识用于不同情境。', '机械重复是在相同情境中重做原步骤。',
  '迁移需要识别新情境中的关键特征。', '错误的引文并未出现。']
const node = (id, type, paragraph, quote) => ({ id, type, text: quote, paragraph, quote,
  evidence: [{ documentId, sourceId, paragraph, quote }] })
const graph = { source: { documentId, id: sourceId, title: 'Learning Fixture' }, nodes: [
  node('transfer', 'concept', 0, paragraphs[0]), node('repetition', 'concept', 1, paragraphs[1]),
  node('rule', 'rule', 2, paragraphs[2]), node('fabricated', 'concept', 3, '原文没有的第三个概念。'),
], edges: [{ fromNodeId: 'transfer', toNodeId: 'rule', relation: 'supports' }] }
const document = { documentId, revision: 1, graph, sourceText: paragraphs.join('\n\n'),
  sourceUnits: paragraphs.map((text, paragraph) => ({ text, paragraph })) }
const original = JSON.stringify(document)
const plan = learningPlanHost(document, { expectedRevision: 1 })
assert.deepEqual(plan.tasks.map(task => task.kind), ['distinction', 'mechanism', 'transfer'])
assert(plan.tasks.every(task => task.origin === 'derived_exercise_not_source' && task.grading === 'self_assessment_only'))
assert(plan.tasks.every(task => task.references.every(ref => paragraphs[ref.paragraph].includes(ref.quote))))
assert(!plan.tasks.some(task => task.references.some(ref => ref.nodeId === 'fabricated')))
assert.equal(plan.tasks.find(task => task.kind === 'transfer').scenarioOrigin, 'learner_provided')
assert.equal(learningPlanHost(document, { expectedRevision: 2 }).error.code, 'revision_conflict')
assert.equal(JSON.stringify(document), original, 'planning must never mutate the canonical graph')

const dir = mkdtempSync(join(tmpdir(), 'kg-learning-'))
try {
  const database = join(dir, 'graphs.sqlite')
  const store = await openSqliteStore(database)
  store.saveGraph(graph, { sourceText: document.sourceText, sourceUnits: document.sourceUnits })
  const task = plan.tasks.find(item => item.kind === 'transfer')
  const saved = store.saveLearningAttempt({ attemptId: 'attempt-1', documentId, expectedRevision: 1,
    task, answer: '我会在新问题中先识别关键特征，再尝试迁移。', scenario: '第一次学习编程时尝试调试陌生报错。',
    selfRating: 'needs_work' })
  assert.equal(saved.task.origin, 'derived_exercise_not_source')
  assert.equal(store.getDocumentRevision(documentId), 1, 'learning progress must not revise canonical graph')
  assert.equal(store.listLearningAttempts(documentId).length, 1)
  assert.equal(store.saveLearningAttempt({ attemptId: 'attempt-1', documentId, expectedRevision: 1, task,
    answer: '我会在新问题中先识别关键特征，再尝试迁移。', scenario: '第一次学习编程时尝试调试陌生报错。',
    selfRating: 'needs_work' }).attemptId, 'attempt-1', 'retry must be idempotent')
  assert.throws(() => store.saveLearningAttempt({ attemptId: 'attempt-1', documentId, expectedRevision: 1, task,
    answer: 'changed answer', scenario: 'different', selfRating: 'confident' }), { code: 'attempt_conflict' })
  assert.throws(() => store.saveLearningAttempt({ attemptId: 'attempt-2', documentId, expectedRevision: 2, task,
    answer: 'answer', scenario: 'scenario', selfRating: 'needs_work' }), { code: 'revision_conflict' })
  assert.throws(() => store.saveLearningAttempt({ attemptId: 'copied-scenario', documentId, expectedRevision: 1, task,
    answer: '这是原文重述，不是新情境。', scenario: paragraphs[2], selfRating: 'needs_work' }),
  { code: 'invalid_input' }, 'short verbatim source text is not a learner-provided novel scenario')
  store.close()
  process.env.DSH_KG_DB = database
  const host = await import('../lib/index.js')
  const routes = []
  host.apply({ get(name) { return name === 'webServer' ? { register(route) { routes.push(route); return () => {} } } : null },
    effect(fn) { return fn() }, interval() { return () => {} } })
  const route = routes.find(item => item.path === '/api/dsh-knowledge-graph')
  assert(route)
  const post = body => new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'; req.url = '/api/dsh-knowledge-graph/learning-mode'; req.headers = {}
    const res = { setHeader() {}, writeHead() {}, end(data) { try { resolve(JSON.parse(data)) } catch (error) { reject(error) } } }
    route.handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
  const apiPlan = await post({ action: 'plan', documentId, expectedRevision: 1 })
  assert.deepEqual(apiPlan.tasks.map(item => item.kind), ['distinction', 'mechanism', 'transfer'])
  assert.equal((await post({ action: 'save', documentId, expectedRevision: 1,
    taskId: 'forged-task', attemptId: 'forged', answer: 'invented', scenario: '', selfRating: 'confident' })).error.code,
  'invalid_input', 'a client must not invent an exercise detached from the canonical plan')
  assert.equal((await post({ action: 'save', documentId, expectedRevision: 1,
    taskId: apiPlan.tasks.find(item => item.kind === 'transfer').id, attemptId: 'copied-via-api',
    answer: '这只是原文照搬。', scenario: paragraphs[2] + ' ', selfRating: 'needs_work' })).error.code,
  'invalid_input', 'the Host must reject a verbatim source quotation as a new scenario')
  const apiSaved = await post({ action: 'save', documentId, expectedRevision: 1,
    taskId: apiPlan.tasks[0].id, attemptId: 'api-attempt', answer: '两个概念的适用情境不同。',
    selfRating: 'uncertain' })
  assert.equal(apiSaved.attempt.task.kind, 'distinction')
  assert.equal((await post({ action: 'attempts', documentId })).attempts.length, 2)
  assert.equal((await post({ action: 'plan', documentId, expectedRevision: 2 })).error.code, 'revision_conflict')
  const revisedStore = await openSqliteStore(database)
  revisedStore.saveGraph({ ...graph, nodes: graph.nodes.map(item => item.id === 'rule' ?
    { ...item, text: '迁移还需要主动比较新旧情境。' } : item) },
  { sourceText: document.sourceText, sourceUnits: document.sourceUnits, expectedRevision: 1 })
  assert.equal(revisedStore.getDocumentRevision(documentId), 2)
  revisedStore.close()
  assert((await post({ action: 'attempts', documentId })).attempts.every(item => item.stale),
    'old progress must remain visible but explicitly stale after the source graph changes')
  const retriedAfterEdit = await post({ action: 'save', documentId, expectedRevision: 1,
    taskId: apiPlan.tasks[0].id, attemptId: 'api-attempt', answer: '两个概念的适用情境不同。',
    selfRating: 'uncertain' })
  assert.equal(retriedAfterEdit.attempt?.attemptId, 'api-attempt',
    'an exact retry of an already committed attempt must be acknowledged even after revision changes')
  assert.equal(retriedAfterEdit.attempt?.stale, true)
  assert.equal((await post({ action: 'save', documentId, expectedRevision: 1,
    taskId: apiPlan.tasks[0].id, attemptId: 'stale-attempt', answer: 'old graph',
    selfRating: 'needs_work' })).error.code, 'revision_conflict')
  delete process.env.DSH_KG_DB
} finally { delete process.env.DSH_KG_DB; rmSync(dir, { recursive: true, force: true }) }
console.log(JSON.stringify({ groundedTasks: 3, fabricatedQuoteExcluded: true, independentProgress: true }))
