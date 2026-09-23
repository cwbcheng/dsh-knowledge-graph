import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSqliteStore, SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import * as host from '../lib/index.js'

const source = Array.from({ length: 5 }, (_, i) => '# Chapter ' + i + '\n\nDevice ' + i + ' consumes ' + (i + 3) + ' watts during the steady state laboratory measurement.').join('\n\n')
const cleanups = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const save = SqliteKnowledgeStore.prototype.saveCheckpoint
function createHost(calls, beforeExtract = () => {}) {
  let handler
  host.apply({ get(name) {
    if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
    return name === 'kgExtractor' ? {
      async extractChunk({ chunk }) {
        const index = Number(chunk.chunkId.slice(-4)) - 1
        calls.push(index)
        await beforeExtract(index)
        const unit = chunk.units.find(unit => unit.text.startsWith('Device'))
        return { summary: '', nodes: [{ id: 'n1', type: 'fact', text: unit.text, quote: unit.text, paragraph: unit.num }], edges: [] }
      },
      async reviewCoverage() { throw new Error('fully covered fixture requested coverage repair') },
      async weaveRelations() { return { edges: [] } },
    } : null
  }, effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) }, interval() { return () => {} } })
  return (endpoint, body = {}, method = 'POST') => new Promise((resolve, reject) => {
    const req = Object.assign(new EventEmitter(), { method, headers: {}, url: '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '') })
    Promise.resolve(handler(req, { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } })).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
async function until(fn) {
  for (let i = 0; i < 2000; i++) { const value = await fn(); if (value) return value; await sleep(5) }
  throw new Error('wave handoff test did not settle')
}
const settle = (api, start) => {
  assert.ok(start.taskId, JSON.stringify(start))
  return until(async () => {
    const status = await api('task-status', { taskId: start.taskId }, 'GET')
    return !['running', 'pausing'].includes(status.status) && !(await api('task-active', {}, 'GET')).busy ? status : null
  })
}
const shape = graph => JSON.parse(JSON.stringify({ nodes: graph.nodes, edges: graph.edges, initial: graph.generation.initial, coverage: graph.generation.coverage }, (key, value) => key === 'documentId' ? '<document>' : value))
const firstWaveComplete = checkpoint => checkpoint.pendingWave?.start === 0 && [0, 1].every(i => checkpoint.pendingWave.results[i]?.stage === 'complete')
const nextWaveAdmission = checkpoint => checkpoint.nextBatchIndex === 2 && checkpoint.pendingWave?.start === 2 && !Object.keys(checkpoint.pendingWave.results).length

if (process.argv[2] === 'kill-worker') {
  const boundary = process.argv[3]
  SqliteKnowledgeStore.prototype.saveCheckpoint = function(checkpoint, options) {
    const result = save.call(this, checkpoint, options)
    if ((boundary === 'results' && firstWaveComplete(checkpoint)) || (boundary === 'admission' && nextWaveAdmission(checkpoint))) {
      // Stop before the durable write is acknowledged or more model work starts.
      process.kill(process.pid, 'SIGKILL')
    }
    return result
  }
  const api = createHost([])
  await settle(api, await api('extract', { text: source, concurrency: 2 }))
  throw new Error('missed the requested kill boundary')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'kg-wave-handoff-'))
  const previousDb = process.env.DSH_KG_DB
  const stores = []
  const open = async name => {
    process.env.DSH_KG_DB = join(dir, name + '.sqlite')
    const store = await openSqliteStore(process.env.DSH_KG_DB)
    stores.push(store)
    return store
  }
  try {
    let expected, legacyCheckpoint
    for (const concurrency of [1, 2, 4]) {
      const store = await open('normal-' + concurrency)
      const writes = [], calls = []
      SqliteKnowledgeStore.prototype.saveCheckpoint = function(checkpoint, options) {
        if (options.status === 'running') writes.push(structuredClone(checkpoint))
        return save.call(this, checkpoint, options)
      }
      const api = createHost(calls, index => {
        const run = store.listIncompleteRuns()[0]
        const durable = store.loadCheckpoint(run.runId).checkpoint
        assert.equal(durable.pendingWave.start, Math.floor(index / concurrency) * concurrency, 'the next wave must be durable before any model request')
        assert.equal(durable.graph.nodes.length, durable.pendingWave.start, 'admission includes every prior merged result')
      })
      const start = await api('extract', { text: source, concurrency })
      const result = await settle(api, start)
      assert.equal(result.status, 'succeeded', JSON.stringify(result.error))
      assert.deepEqual(calls, [0, 1, 2, 3, 4])
      assert.equal(result.result.nodes.length, 5, 'colliding batch-local IDs must all survive ordered merge')
      assert.equal(writes.filter(cp => cp.nextBatchIndex > 0 && cp.nextBatchIndex < cp.totalBatches && !cp.pendingWave).length, 0,
        'do not write the same merged graph twice between adjacent waves')
      for (let index = 0; index < 5; index++) assert.equal(writes.filter(cp => cp.pendingWave?.results?.[index]?.stage === 'complete').length,
        Math.min(concurrency - index % concurrency, 5 - index), 'every result is durably saved before the wave can merge')
      if (concurrency === 2) {
        expected = shape(result.result)
        legacyCheckpoint = structuredClone(writes.find(nextWaveAdmission))
        delete legacyCheckpoint.pendingWave
      }
      SqliteKnowledgeStore.prototype.saveCheckpoint = save
    }

    for (const boundary of ['results', 'admission']) {
      const store = await open('kill-' + boundary)
      const child = fork(fileURLToPath(import.meta.url), ['kill-worker', boundary], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env } })
      let stderr = '', timedOut = false
      child.stderr.on('data', data => { stderr += data })
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 20000)
      const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) }).finally(() => clearTimeout(timer))
      assert.equal(timedOut, false, stderr)
      assert.equal(exit.signal, 'SIGKILL', stderr)
      const run = store.listIncompleteRuns()[0]
      assert.ok(run, stderr)
      const checkpoint = store.loadCheckpoint(run.runId).checkpoint
      assert.ok(boundary === 'results' ? firstWaveComplete(checkpoint) : nextWaveAdmission(checkpoint))
      assert.equal(store.listDocuments().length, 0, 'a killed task must not publish a partial graph')
      const calls = [], api = createHost(calls)
      const resumed = await settle(api, await api('resume-extract', { runId: run.runId, retryFailed: true }))
      assert.equal(resumed.status, 'succeeded', JSON.stringify(resumed.error))
      assert.deepEqual(calls, [2, 3, 4], 'neither completed batch may be regenerated across a handoff crash')
      assert.deepEqual(shape(resumed.result), expected, 'recovery must preserve graph, evidence and generation metrics')
      assert.equal(store.loadCheckpoint(run.runId).status, 'succeeded')
    }

    const failedStore = await open('failed-admission')
    const failedCalls = []
    // Exercise the SQLite rollback path, not just a rejected promise.
    failedStore.db.exec(`CREATE TRIGGER reject_handoff BEFORE UPDATE ON extraction_runs
      WHEN json_extract(NEW.checkpoint_json, '$.pendingWave.start') = 2
      BEGIN SELECT RAISE(ABORT, 'fixture handoff write failure'); END`)
    const failedApi = createHost(failedCalls)
    const failedStart = await failedApi('extract', { text: source, concurrency: 2 })
    const failed = await settle(failedApi, failedStart)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error.code, 'persistence_failed')
    assert.deepEqual(failedCalls, [0, 1], 'a failed next-wave admission must not call the model')
    assert.ok(firstWaveComplete(failedStore.loadCheckpoint(failedStart.taskId).checkpoint))
    assert.equal(failedStore.listDocuments().length, 0)
    failedStore.db.exec('DROP TRIGGER reject_handoff')
    const retryCalls = [], retryApi = createHost(retryCalls)
    const retry = await settle(retryApi, await retryApi('resume-extract', { runId: failedStart.taskId, retryFailed: true }))
    assert.equal(retry.status, 'succeeded', JSON.stringify(retry.error))
    assert.deepEqual(retryCalls, [2, 3, 4])
    assert.deepEqual(shape(retry.result), expected)

    const legacyStore = await open('legacy-merged')
    legacyStore.saveCheckpoint(legacyCheckpoint, { runId: 'legacy-run', status: 'failed', sourceText: source })
    const legacyCalls = [], legacyApi = createHost(legacyCalls)
    const legacy = await settle(legacyApi, await legacyApi('resume-extract', { runId: 'legacy-run', retryFailed: true }))
    assert.equal(legacy.status, 'succeeded', JSON.stringify(legacy.error))
    assert.deepEqual(legacyCalls, [2, 3, 4])
    assert.deepEqual(shape(legacy.result), expected, 'legacy between-wave checkpoints must remain resumable')

    const pauseStore = await open('pause-handoff')
    let release, entered = false
    const pauseApi = createHost([], async index => {
      if (index === 2) { entered = true; await new Promise(resolve => { release = resolve }) }
    })
    const pauseStart = await pauseApi('extract', { text: source, concurrency: 2 })
    await until(() => entered && pauseStore.loadCheckpoint(pauseStart.taskId)?.checkpoint.pendingWave?.results?.[3]?.stage === 'complete')
    assert.equal((await pauseApi('task-pause', { taskId: pauseStart.taskId })).status, 'pausing')
    release()
    assert.equal((await settle(pauseApi, pauseStart)).status, 'paused')
    assert.equal(pauseStore.loadCheckpoint(pauseStart.taskId).checkpoint.graph.nodes.length, 2)
    const resumedCalls = [], resumedApi = createHost(resumedCalls)
    assert.equal((await resumedApi('resume-extract', { runId: pauseStart.taskId, retryFailed: true })).error.code, 'task_paused')
    assert.deepEqual(resumedCalls, [])
    const resumed = await settle(resumedApi, await resumedApi('resume-extract', { runId: pauseStart.taskId, resumePaused: true }))
    assert.equal(resumed.status, 'succeeded', JSON.stringify(resumed.error))
    assert.deepEqual(resumedCalls, [2, 4], 'a completed sibling in the newly admitted wave must survive pause and a new Host')
    assert.deepEqual(shape(resumed.result), expected)
    console.log(JSON.stringify({ ok: true, concurrency: [1, 2, 4], redundantHandoffWrites: 0, durableBeforeModel: true,
      sigkillBoundaries: ['results', 'admission'], sqliteFailureRecovery: true, legacyResume: true, pauseNewHostResume: true }))
  } finally {
    SqliteKnowledgeStore.prototype.saveCheckpoint = save
    for (const cleanup of cleanups.reverse()) cleanup()
    for (const store of stores) store.close()
    if (previousDb === undefined) delete process.env.DSH_KG_DB
    else process.env.DSH_KG_DB = previousDb
    rmSync(dir, { recursive: true, force: true })
  }
}
