import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as host from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'kg-verification-pause-'))
const oldDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(dir, 'graph.sqlite')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const store = await openSqliteStore(process.env.DSH_KG_DB)
function createHost(stream) {
  let handler
  host.apply({
    get(name) {
      if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
      return name === 'llm' ? { stream } : null
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
  assert.equal((await firstHost('resume-verify', { runId: id, retryFailed: true })).error.code, 'task_paused')
  assert.equal((await firstHost('resume-extract', { runId: id, resumePaused: true })).error.code, 'wrong_task_kind')

  const checkpoint = store.loadCheckpoint(id).checkpoint
  store.saveCheckpoint({ ...checkpoint, inputHash: 'tampered' }, { runId: id, status: 'paused', sourceText: text })
  assert.equal((await firstHost('resume-verify', { runId: id, resumePaused: true })).error.code, 'checkpoint_invalid')
  assert.equal(store.loadCheckpoint(id).status, 'paused', 'invalid resume must not consume saved work')
  store.saveCheckpoint(checkpoint, { runId: id, status: 'paused', sourceText: text })

  let resumedCalls = 0
  const secondHost = createHost(async function* () {
    resumedCalls++
    yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }
  })
  assert.equal((await secondHost('resume-verify', { runId: id })).error.code, 'task_paused')
  assert.equal(resumedCalls, 0, 'restart must not implicitly resume')
  const resumed = await secondHost('resume-verify', { runId: id, resumePaused: true })
  assert.equal(resumed.taskId, id, JSON.stringify(resumed))
  await until(async () => (await status(secondHost, id)).status === 'succeeded', 'Resumed verification did not finish')
  assert.equal(resumedCalls, 2, 'saved first batch must not be requested again')
  assert.equal(store.loadVerificationBatches(id).length, 3)
  assert.equal(store.loadCheckpoint(id).status, 'succeeded')
  assert.equal((await status(secondHost, id)).result.issues.length >= 0, true)

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
