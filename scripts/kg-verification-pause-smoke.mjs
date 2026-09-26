import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as host from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'kg-verification-pause-'))
const oldDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(dir, 'graph.sqlite')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const store = await openSqliteStore(process.env.DSH_KG_DB)
function createHost(stream, availableModels = []) {
  let handler
  host.apply({
    get(name) {
      if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
      return name === 'llm' ? { stream, listModels: async () => availableModels } : null
    },
    effect(fn) { fn() }, interval() { return () => {} },
  })
  return (endpoint, body = {}, method = 'POST') => new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method; req.headers = {}
    req.url = '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '')
    Promise.resolve(handler(req, { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } })).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
async function until(check, message) {
  for (let i = 0; i < 600; i++) { const value = await check(); if (value) return value; await sleep(5) }
  assert.fail(message)
}
const text = 'A durable verification fixture.'
const graph = {
  nodes: Array.from({ length: 13 }, (_, i) => ({ id: 'n' + i, type: 'fact', text, quote: text, paragraph: 0 })),
  edges: [{ fromNodeId: 'n0', toNodeId: 'n12', relation: 'supports', evidence: [{ paragraph: 0, quote: text }] }],
}
const model = { provider: 'fixture', model: 'frozen-model' }
const status = (api, id) => api('task-status', { taskId: id }, 'GET')
let calls = 0, aborts = 0
const firstHost = createHost(async function* ({ signal }) {
  calls++
  if (calls === 1) { yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }; return }
  await new Promise(resolve => signal.addEventListener('abort', () => { aborts++; resolve() }, { once: true }))
})
try {
  const started = await firstHost('verify-graph', { title: 'fixture', text, graph, mode: 'standard', concurrency: 1, model })
  assert.ok(started.taskId, JSON.stringify(started))
  const id = started.taskId
  await until(() => calls === 2 && store.loadVerificationBatches(id).length === 1, 'First batch was not persisted before second stream')
  assert.equal((await status(firstHost, id)).progress.canPause, true)
  const paused = await firstHost('task-pause', { taskId: id })
  assert(['pausing', 'paused'].includes(paused.status), JSON.stringify(paused))
  await until(async () => (await status(firstHost, id)).status === 'paused', 'Verification did not pause')
  assert.equal(aborts, 1)
  assert.equal(store.loadCheckpoint(id).status, 'paused')
  assert.equal(store.loadVerificationBatches(id).length, 1)
  assert.equal(store.listIncompleteRuns().find(run => run.runId === id).nextBatchIndex, 1)
  assert.equal(store.listIncompleteRuns().find(run => run.runId === id).modelId, model.model)
  assert.equal((await firstHost('resume-verify', { runId: id, retryFailed: true })).error.code, 'task_paused')
  assert.equal((await firstHost('resume-extract', { runId: id, resumePaused: true })).error.code, 'wrong_task_kind')

  const checkpoint = store.loadCheckpoint(id).checkpoint
  store.saveCheckpoint({ ...checkpoint, inputHash: 'tampered' }, { runId: id, status: 'paused', sourceText: text })
  assert.equal((await firstHost('resume-verify', { runId: id, resumePaused: true })).error.code, 'checkpoint_invalid')
  assert.equal(store.loadCheckpoint(id).status, 'paused', 'invalid resume must not consume saved work')
  store.saveCheckpoint(checkpoint, { runId: id, status: 'paused', sourceText: text })

  const selectedModel = { provider: 'fixture', model: 'selected-model' }
  let resumedCalls = 0
  const secondHost = createHost(async function* () {
    resumedCalls++
    yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }
  }, [{ id: selectedModel.model }])
  assert.equal((await secondHost('resume-verify', { runId: id })).error.code, 'task_paused')
  assert.equal(resumedCalls, 0, 'restart must not implicitly resume')
  assert.equal((await secondHost('resume-verify', { runId: id, resumePaused: true,
    model: { provider: 'fixture', model: 'unavailable' } })).error.code, 'model_unavailable')
  assert.deepEqual(store.loadCheckpoint(id).checkpoint.model, model, 'unavailable model must not change the checkpoint')
  assert.equal(store.loadVerificationBatches(id).length, 1)
  const resumed = await secondHost('resume-verify', { runId: id, resumePaused: true, model: selectedModel })
  assert.equal(resumed.taskId, id, JSON.stringify(resumed))
  await until(async () => (await status(secondHost, id)).status === 'succeeded', 'Resumed verification did not finish')
  assert.equal(resumedCalls, 2, 'saved first batch must not be requested again')
  assert.equal(store.loadVerificationBatches(id).length, 3)
  assert.equal(store.loadCheckpoint(id).status, 'succeeded')
  assert.deepEqual(store.loadCheckpoint(id).checkpoint.model, selectedModel)
  assert.deepEqual(store.loadCheckpoint(id).checkpoint.batchModels['0'], model)
  const resumedReport = (await status(secondHost, id)).result
  assert.equal(resumedReport.issues.length >= 0, true)
  assert.deepEqual(resumedReport.modelsUsed, [
    { ...model, batches: 1 }, { ...selectedModel, batches: 2 },
  ])
  assert.deepEqual(store.loadCheckpoint(id).checkpoint.report.modelsUsed, resumedReport.modelsUsed,
    'mixed-model provenance must survive report recovery')

  let multiFirstCalls = 0
  const multiFirst = createHost(async function* ({ signal }) {
    multiFirstCalls++
    if (multiFirstCalls === 1) { yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }; return }
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  })
  const multiStarted = await multiFirst('verify-graph', { text, graph, mode: 'standard', concurrency: 1, model })
  const multiId = multiStarted.taskId
  await until(() => multiFirstCalls === 2 && store.loadVerificationBatches(multiId).length === 1, 'First model did not save a batch')
  await multiFirst('task-pause', { taskId: multiId })
  await until(async () => (await status(multiFirst, multiId)).status === 'paused', 'First model did not pause')
  let multiSecondCalls = 0
  const multiSecond = createHost(async function* ({ signal }) {
    multiSecondCalls++
    if (multiSecondCalls === 1) { yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }; return }
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  }, [{ id: selectedModel.model }])
  assert.equal((await multiSecond('resume-verify', { runId: multiId, resumePaused: true, model: selectedModel })).taskId, multiId)
  await until(() => multiSecondCalls === 2 && store.loadVerificationBatches(multiId).length === 2, 'Second model did not save a batch')
  await multiSecond('task-pause', { taskId: multiId })
  await until(async () => (await status(multiSecond, multiId)).status === 'paused', 'Second model did not pause')
  const twicePaused = store.loadCheckpoint(multiId).checkpoint
  store.saveCheckpoint({ ...twicePaused, batchModels: { ...twicePaused.batchModels, 2: model } },
    { runId: multiId, status: 'paused', sourceText: text })
  const thirdModel = { provider: 'fixture', model: 'third-model' }
  const multiThird = createHost(async function* () {
    yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }
  }, [{ id: thirdModel.model }])
  assert.equal((await multiThird('resume-verify', { runId: multiId, resumePaused: true, model: thirdModel })).error.code,
    'checkpoint_invalid', 'provenance for an unsaved batch must be rejected')
  store.saveCheckpoint(twicePaused, { runId: multiId, status: 'paused', sourceText: text })
  assert.equal((await multiThird('resume-verify', { runId: multiId, resumePaused: true, model: thirdModel })).taskId, multiId)
  await until(async () => (await status(multiThird, multiId)).status === 'succeeded', 'Third model did not finish')
  assert.deepEqual((await status(multiThird, multiId)).result.modelsUsed, [
    { ...model, batches: 1 }, { ...selectedModel, batches: 1 }, { ...thirdModel, batches: 1 },
  ])

  let failedCalls = 0
  const failedHost = createHost(async function* () {
    failedCalls++
    yield { type: 'text-delta', index: 0, text: failedCalls === 1 ? '{"issues":[]}' : '{"wrong":[]}' }
  })
  const failedRun = await failedHost('verify-graph', { text, graph, mode: 'standard', concurrency: 1, model })
  await until(async () => (await status(failedHost, failedRun.taskId)).status === 'failed', 'Failure fixture did not settle')
  assert.equal(store.loadVerificationBatches(failedRun.taskId).length, 1)
  const failedResumeHost = createHost(async function* () {
    yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }
  }, [{ id: selectedModel.model }])
  assert.equal((await failedResumeHost('resume-verify', { runId: failedRun.taskId,
    retryFailed: true, model: selectedModel })).taskId, failedRun.taskId)
  await until(async () => (await status(failedResumeHost, failedRun.taskId)).status === 'succeeded', 'Failed run did not resume')
  assert.deepEqual((await status(failedResumeHost, failedRun.taskId)).result.modelsUsed, [
    { ...model, batches: 1 }, { ...selectedModel, batches: 2 },
  ])

  const documentId = 'verification-revision-fixture'
  const canonical = { ...graph, source: { documentId, sourceId: 'source-verification-fixture', title: 'fixture' } }
  store.saveGraph(canonical, { sourceText: text })
  let revisionCalls = 0
  const revisionHost = createHost(async function* ({ signal }) {
    revisionCalls++
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  })
  const revisionRun = await revisionHost('verify-graph', { text, graph, documentId, expectedRevision: 1,
    mode: 'standard', concurrency: 1, model })
  await until(() => revisionCalls === 1, 'Revision-fenced stream did not start')
  assert(['pausing', 'paused'].includes((await revisionHost('task-pause', { taskId: revisionRun.taskId })).status))
  await until(async () => (await status(revisionHost, revisionRun.taskId)).status === 'paused', 'Revision-fenced run did not pause')
  store.saveGraph(canonical, { sourceText: text, expectedRevision: 1 })
  assert.equal((await revisionHost('resume-verify', { runId: revisionRun.taskId, resumePaused: true })).error.code, 'revision_conflict')
  assert.equal(store.loadCheckpoint(revisionRun.taskId).status, 'paused')

  const reportDocumentId = 'verification-report-recovery-fixture'
  const reportGraph = { ...graph, source: { documentId: reportDocumentId, sourceId: 'source-report-fixture', title: 'report fixture' } }
  store.saveGraph(reportGraph, { sourceText: text })
  let reportCalls = 0
  const reportHost = createHost(async function* () {
    reportCalls++
    yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }
  })
  const reportRun = await reportHost('verify-graph', { text, graph, documentId: reportDocumentId,
    expectedRevision: 1, mode: 'standard', concurrency: 1, model })
  await until(async () => (await status(reportHost, reportRun.taskId)).status === 'succeeded', 'Report fixture did not finish')
  assert.equal(reportCalls, 3)
  assert.equal(store.listIncompleteRuns().find(run => run.runId === reportRun.taskId)?.status, 'succeeded',
    'completed but unattached report must stay discoverable')
  const restartedHost = createHost(() => { assert.fail('reading a completed report must not call the model') })
  const savedReport = await status(restartedHost, reportRun.taskId)
  assert.equal(savedReport.status, 'succeeded')
  assert.equal(savedReport.recovered, true)
  assert.equal(savedReport.baseRevision, 1)
  assert.equal(savedReport.documentId, reportDocumentId)
  assert.ok(savedReport.result.reportId)
  store.saveGraph({ ...reportGraph, verification: { lastReport: savedReport.result, stale: false } },
    { sourceText: text, expectedRevision: 1 })
  assert(!store.listIncompleteRuns().some(run => run.runId === reportRun.taskId),
    'a report attached to the canonical graph must leave the recovery list')

  const codeUnit = 'AtomicCodeSegment_'.repeat(14), nextUnit = 'A distinct later source unit.'
  const scopedText = codeUnit + '\n\n' + nextUnit
  const scopedUnits = [{ paragraph: 10, text: codeUnit }, { paragraph: 30, text: nextUnit }]
  const scopedGraph = { nodes: Array.from({ length: 13 }, (_, i) => ({ id: 's' + i, type: 'fact',
    text: i < 12 ? codeUnit : nextUnit, quote: i < 12 ? codeUnit : nextUnit, paragraph: i < 12 ? 10 : 30 })),
    edges: [{ fromNodeId: 's0', toNodeId: 's12', relation: 'supports', evidence: [{ paragraph: 30, quote: nextUnit }] }] }
  let scopedCalls = 0
  const scopedHost = createHost(async function* (request) {
    scopedCalls++
    assert.ok(request.messages[0].content[0].text.includes('[P0] ' + codeUnit + '\n[P1] ' + nextUnit),
      'the original scoped plan must retain atomic source units')
    if (scopedCalls === 1) { yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }; return }
    await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
  })
  const scopedRun = await scopedHost('verify-graph', { text: '', graph: scopedGraph, sourceUnits: scopedUnits,
    mode: 'standard', concurrency: 1, model })
  await until(() => scopedCalls === 2 && store.loadVerificationBatches(scopedRun.taskId).length === 1, 'Scoped batch was not saved')
  await scopedHost('task-pause', { taskId: scopedRun.taskId })
  await until(async () => (await status(scopedHost, scopedRun.taskId)).status === 'paused', 'Scoped task did not pause')
  const scopedCheckpoint = store.loadCheckpoint(scopedRun.taskId).checkpoint
  assert.deepEqual(scopedCheckpoint.sourceUnitLengths, [codeUnit.length, nextUnit.length])
  assert.equal(store.loadCheckpoint(scopedRun.taskId).sourceText, scopedText)
  store.saveCheckpoint({ ...scopedCheckpoint, sourceUnitLengths: [codeUnit.length - 1, nextUnit.length + 1] },
    { runId: scopedRun.taskId, status: 'paused', sourceText: scopedText })
  assert.equal((await scopedHost('resume-verify', { runId: scopedRun.taskId, resumePaused: true })).error.code, 'checkpoint_invalid',
    'the checkpoint hash must bind unit boundaries, not only concatenated text')
  const legacyScoped = { ...scopedCheckpoint }
  delete legacyScoped.sourceUnitLengths
  legacyScoped.inputHash = createHash('sha256').update(JSON.stringify({ version: 1, taskKind: 'verify',
    text: scopedText, graph: legacyScoped.graph, mode: legacyScoped.mode, scope: legacyScoped.scope,
    paragraphMap: legacyScoped.paragraphMap, model: legacyScoped.model })).digest('hex')
  store.saveCheckpoint(legacyScoped, { runId: scopedRun.taskId, status: 'paused', sourceText: scopedText })
  const legacyResponse = await scopedHost('resume-verify', { runId: scopedRun.taskId, resumePaused: true })
  assert.equal(legacyResponse.error.code, 'checkpoint_invalid')
  assert.match(legacyResponse.error.message, /段落边界/, 'legacy scoped plans cannot silently mix old and new paragraph meanings')
  assert.equal(store.loadCheckpoint(scopedRun.taskId).status, 'paused')
  assert.equal(store.loadVerificationBatches(scopedRun.taskId).length, 1)
  assert.equal(scopedCalls, 2, 'rejected recovery must not spend another model request')
  store.saveCheckpoint(scopedCheckpoint, { runId: scopedRun.taskId, status: 'paused', sourceText: scopedText })
  let scopedResumedCalls = 0
  const scopedRestart = createHost(async function* (request) {
    scopedResumedCalls++
    assert.ok(request.messages[0].content[0].text.includes('[P0] ' + codeUnit + '\n[P1] ' + nextUnit),
      'a fresh host must restore identical prompt boundaries')
    yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }
  }, [{ id: selectedModel.model }])
  assert.equal((await scopedRestart('resume-verify', { runId: scopedRun.taskId, resumePaused: true, model: selectedModel })).taskId,
    scopedRun.taskId)
  await until(async () => (await status(scopedRestart, scopedRun.taskId)).status === 'succeeded', 'Scoped recovery did not finish')
  assert.equal(scopedResumedCalls, 2, 'scoped recovery must not repeat the completed first batch')
  assert.deepEqual(store.loadCheckpoint(scopedRun.taskId).checkpoint.sourceUnitLengths, scopedCheckpoint.sourceUnitLengths)
  assert.ok(!(await status(scopedRestart, scopedRun.taskId)).result.issues.some(issue =>
    issue.targetId === 's12' && issue.invariantCode === 'node_paragraph_mismatch'))

  let cancelledCalls = 0
  const cancelHost = createHost(async function* ({ signal }) {
    cancelledCalls++
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  })
  const cancelledRun = await cancelHost('verify-graph', { text, graph, mode: 'standard', concurrency: 1, model })
  await until(() => cancelledCalls === 1, 'Cancellation stream did not start')
  assert.equal((await cancelHost('task-cancel', { taskId: cancelledRun.taskId })).status, 'cancelling')
  await until(async () => (await status(cancelHost, cancelledRun.taskId)).status === 'cancelled', 'Cancelled run did not settle')
  assert.equal(store.loadCheckpoint(cancelledRun.taskId).status, 'cancelled', 'cancel is not pause')
  assert.equal((await cancelHost('resume-verify', { runId: cancelledRun.taskId, resumePaused: true })).error.code, 'not_recoverable')
} finally {
  store.close()
  if (oldDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = oldDb
  rmSync(dir, { recursive: true, force: true })
}
console.log('verification pause/resume smoke passed')
