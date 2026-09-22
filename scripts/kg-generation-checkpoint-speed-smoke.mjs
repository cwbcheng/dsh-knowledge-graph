import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSqliteStore, SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import * as host from '../lib/index.js'

const source = '# Alpha\n\nDevice A consumes five watts during the steady state laboratory measurement.\n\n# Beta\n\nDevice B consumes seven watts during the steady state laboratory measurement.'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const cleanups = []
function createHost(calls, blockSibling = false) {
  let handler
  host.apply({ get(name) {
    if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
    return name === 'kgExtractor' ? {
      async extractChunk({ chunk }) {
        const index = Number(chunk.chunkId.slice(-4)) - 1
        calls.push(index)
        if (blockSibling && index === 1) await new Promise(() => {})
        const unit = chunk.units.find(unit => unit.text.startsWith('Device'))
        return { summary: '', nodes: [{ id: 'n1', type: 'fact', text: unit.text, quote: unit.text, paragraph: unit.num }], edges: [] }
      },
      async reviewCoverage() { throw new Error('this fully covered fixture must not request coverage repair') },
      async weaveRelations() { return { edges: [] } },
    } : null
  }, effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); return cleanup }, interval() { return () => {} } })
  return (endpoint, body = {}, method = 'POST') => new Promise((resolve, reject) => {
    const req = Object.assign(new EventEmitter(), { method, headers: {}, url: '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '') })
    Promise.resolve(handler(req, { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } })).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
async function settle(api, started) {
  assert.ok(started.taskId, JSON.stringify(started))
  for (let i = 0; i < 2000; i++) {
    const status = await api('task-status', { taskId: started.taskId }, 'GET')
    if (status.status !== 'running' && !(await api('task-active', {}, 'GET')).busy) return status
    await sleep(5)
  }
  throw new Error('generation checkpoint test did not settle')
}
const completedFirst = checkpoint => checkpoint.nextBatchIndex === 0 && checkpoint.pendingWave?.results?.[0]?.stage === 'complete'
const save = SqliteKnowledgeStore.prototype.saveCheckpoint
if (process.argv[2] === 'crash-worker') {
  SqliteKnowledgeStore.prototype.saveCheckpoint = function(checkpoint, options) {
    const result = save.call(this, checkpoint, options)
    // Exit after the real durable write, before its promise is acknowledged.
    if (completedFirst(checkpoint)) process.exit(73)
    return result
  }
  const api = createHost([], true)
  await settle(api, await api('extract', { text: source, concurrency: 2 }))
  throw new Error('missed the complete-record boundary')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'kg-checkpoint-speed-'))
  const previousDb = process.env.DSH_KG_DB
  const stores = []
  try {
    process.env.DSH_KG_DB = join(dir, 'normal.sqlite')
    const normalStore = await openSqliteStore(process.env.DSH_KG_DB)
    stores.push(normalStore)
    let pendingWrites = 0, completeWrites = 0
    SqliteKnowledgeStore.prototype.saveCheckpoint = function(checkpoint, options) {
      const records = Object.values(checkpoint.pendingWave?.results || {})
      if (records.some(record => record.stage === 'coverage_pending')) pendingWrites++
      if (records.some(record => record.stage === 'complete')) completeWrites++
      return save.call(this, checkpoint, options)
    }
    const calls = [], api = createHost(calls)
    const normalStart = await api('extract', { text: source, concurrency: 2 })
    const normal = await settle(api, normalStart)
    assert.equal(normal.status, 'succeeded', JSON.stringify(normal.error))
    assert.deepEqual(calls, [0, 1])
    assert.equal(normal.result.nodes.length, 2)
    assert.deepEqual(normal.result.generation.initial, { nodes: 2, edges: 0 })
    assert.equal(normal.result.generation.coverage.attemptedBatches, 0)
    assert.equal(pendingWrites, 0, 'batches without coverage work must persist complete records directly, not two successive states')
    assert.equal(completeWrites, 2, 'each completed model result remains independently durable')
    assert.equal(normalStore.loadCheckpoint(normalStart.taskId).status, 'succeeded')
    SqliteKnowledgeStore.prototype.saveCheckpoint = save

    process.env.DSH_KG_DB = join(dir, 'crash.sqlite')
    const child = fork(fileURLToPath(import.meta.url), ['crash-worker'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env } })
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }).finally(() => clearTimeout(timer))
    assert.equal(exitCode, 73, stderr)
    const crashStore = await openSqliteStore(process.env.DSH_KG_DB)
    stores.push(crashStore)
    const run = crashStore.listIncompleteRuns()[0]
    const saved = crashStore.loadCheckpoint(run.runId)
    assert.equal(saved.checkpoint.nextBatchIndex, 0)
    assert.equal(saved.checkpoint.pendingWave.results[0].stage, 'complete')
    assert.equal(saved.checkpoint.pendingWave.results[0].metrics.nodes, 1)
    assert.equal(crashStore.listDocuments().length, 0, 'an unmerged wave cannot publish a canonical graph')
    const resumedCalls = [], resumedApi = createHost(resumedCalls)
    const resumed = await settle(resumedApi, await resumedApi('resume-extract', { runId: run.runId, retryFailed: true }))
    assert.equal(resumed.status, 'succeeded', JSON.stringify(resumed.error))
    assert.deepEqual(resumedCalls, [1], 'the durably completed sibling must not be regenerated after a process exit')
    const shape = graph => graph.nodes.map(({ id, type, text, paragraph }) => ({ id, type, text, paragraph }))
    assert.deepEqual(shape(resumed.result), shape(normal.result))
    assert.deepEqual(resumed.result.generation.initial, normal.result.generation.initial)
    assert.deepEqual(resumed.result.generation.coverage, normal.result.generation.coverage)
    assert.equal(crashStore.loadCheckpoint(run.runId).status, 'succeeded')

    process.env.DSH_KG_DB = join(dir, 'legacy-prepared.sqlite')
    const legacyStore = await openSqliteStore(process.env.DSH_KG_DB)
    stores.push(legacyStore)
    const legacy = structuredClone(saved.checkpoint)
    legacy.pendingWave.results[0].stage = 'coverage_pending'
    legacy.pendingWave.results[0].metrics = { repairs: [], retries: 0, collapseRetries: 0 }
    legacyStore.saveCheckpoint(legacy, { runId: run.runId, status: 'failed', sourceText: source })
    const legacyCalls = [], legacyApi = createHost(legacyCalls)
    const promoted = await settle(legacyApi, await legacyApi('resume-extract', { runId: run.runId, retryFailed: true }))
    assert.equal(promoted.status, 'succeeded', JSON.stringify(promoted.error))
    assert.deepEqual(legacyCalls, [1], 'a legacy prepared result without coverage work must not be regenerated')
    assert.deepEqual(shape(promoted.result), shape(normal.result))
    assert.deepEqual(promoted.result.generation.initial, normal.result.generation.initial)
    assert.deepEqual(promoted.result.generation.coverage, normal.result.generation.coverage)
    assert.equal(legacyStore.loadCheckpoint(run.runId).status, 'succeeded')

    process.env.DSH_KG_DB = join(dir, 'failed-write.sqlite')
    const failedStore = await openSqliteStore(process.env.DSH_KG_DB)
    stores.push(failedStore)
    SqliteKnowledgeStore.prototype.saveCheckpoint = function(checkpoint, options) {
      if (completedFirst(checkpoint)) throw new Error('synthetic complete-record write failure')
      return save.call(this, checkpoint, options)
    }
    const failedApi = createHost([])
    const failedStart = await failedApi('extract', { text: source, concurrency: 2 })
    const failed = await settle(failedApi, failedStart)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error.code, 'persistence_failed')
    const retained = failedStore.loadCheckpoint(failedStart.taskId).checkpoint
    assert.equal(retained.nextBatchIndex, 0)
    assert.deepEqual(retained.pendingWave.results, {}, 'a failed write cannot advance durable results')
    assert.equal(failedStore.listDocuments().length, 0)
    console.log(JSON.stringify({ ok: true, pendingWrites, completeWrites, crashAfterDurableWrite: true, replayedOnlyUnfinishedSibling: true, legacyPreparedPromotion: true, persistenceFailureRetained: true }))
  } finally {
    SqliteKnowledgeStore.prototype.saveCheckpoint = save
    for (const cleanup of cleanups.reverse()) cleanup()
    for (const store of stores) store.close()
    if (previousDb === undefined) delete process.env.DSH_KG_DB
    else process.env.DSH_KG_DB = previousDb
    rmSync(dir, { recursive: true, force: true })
  }
}
