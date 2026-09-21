import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSqliteStore } from '../src/kg-store.mjs'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import * as host from '../lib/index.js'

const source = 'The device consumes five watts.'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const failures = []
async function check(name, run) {
  try { await run(); console.log('PASS ' + name) }
  catch (error) { failures.push(error); console.error('FAIL ' + name + ': ' + error.message) }
}
function createHost(onExtract = () => {}) {
  let handler
  host.apply({
    get(name) {
      if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
      if (name === 'sessions') return { get: () => ({ events: [{ seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: source }] } }] }) }
      if (name === 'kgExtractor') return async ({ chunk }) => {
        onExtract()
        const unit = chunk.units[0]
        return { summary: 'Device record', nodes: [{ id: 'n1', type: 'fact', text: unit.text, quote: unit.text, paragraph: unit.num }], edges: [] }
      }
      return null
    },
    effect(fn) { return fn() },
    interval() { return () => {} },
  })
  return (endpoint, body = {}, method = 'POST') => new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method; req.headers = {}
    req.url = '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '')
    Promise.resolve(handler(req, { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } })).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
async function settle(api, started) {
  assert.ok(started.taskId, JSON.stringify(started))
  for (let i = 0; i < 2000; i++) {
    const status = await api('task-status', { taskId: started.taskId }, 'GET')
    const active = await api('task-active', {}, 'GET')
    if (status.status !== 'running' && !active.busy) return status
    await sleep(5)
  }
  throw new Error('Task did not settle')
}
const seedGraph = {
  source: { id: 'source-original', documentId: 'document-original' },
  nodes: [{ id: 'n1', type: 'fact', text: source, quote: source, paragraph: 0, evidence: [{ paragraph: 0, quote: source }] }],
  edges: [],
}

if (process.argv[2] === 'commit-worker') {
  const saveGraph = SqliteKnowledgeStore.prototype.saveGraph
  SqliteKnowledgeStore.prototype.saveGraph = function (...args) {
    saveGraph.apply(this, args)
    // Exit after the actual SQLite COMMIT but before the Host can acknowledge it.
    process.exit(73)
  }
  const api = createHost()
  await settle(api, await api('extract', { text: source }))
  throw new Error('Worker missed the commit boundary')
} else {
  const directory = mkdtempSync(join(tmpdir(), 'kg-persistence-atomicity-'))
  const previousDb = process.env.DSH_KG_DB
  const stores = []
  const open = async name => {
    process.env.DSH_KG_DB = join(directory, name + '.sqlite')
    const store = await openSqliteStore(process.env.DSH_KG_DB)
    stores.push(store)
    return store
  }
  try {
    await check('checkpoint serialization failure preserves the last recovery record', async () => {
      const store = await open('checkpoint-json')
      const checkpoint = { version: 2, documentId: 'document-original', graph: seedGraph, nextBatchIndex: 1 }
      store.saveCheckpoint(checkpoint, { runId: 'run-json', sourceText: source })
      const before = store.loadCheckpoint('run-json')
      for (const bad of [1n, {}]) {
        if (typeof bad === 'object') bad.cycle = bad
        assert.throws(() => store.saveCheckpoint({ ...checkpoint, extra: bad }, { runId: 'run-json', sourceText: source }))
        assert.deepEqual(store.loadCheckpoint('run-json'), before)
      }
    })

    await check('graph serialization failure rolls back graph, evidence and revision', async () => {
      const store = await open('graph-json')
      store.saveGraph(seedGraph, { sourceText: source, sourceUnits: [source] })
      const before = store.getDocument('document-original')
      const revisions = store.listRevisions('document-original')
      const candidates = store.listCandidates({ documentId: 'document-original' })
      const circular = {}; circular.self = circular
      for (const patch of [
        { generation: circular },
        { nodes: [{ ...seedGraph.nodes[0], evidence: [{ paragraph: 0, quote: source, invalid: 1n }] }] },
      ]) {
        assert.throws(() => store.saveGraph({ ...seedGraph, ...patch }, { sourceText: 'replacement', expectedRevision: 1 }))
        assert.deepEqual(store.getDocument('document-original'), before)
        assert.deepEqual(store.listRevisions('document-original'), revisions)
        assert.deepEqual(store.listCandidates({ documentId: 'document-original' }), candidates)
      }
    })

    await check('initial checkpoint failure stops before spending model calls', async () => {
      const store = await open('initial-failure')
      let calls = 0, writes = 0
      const original = SqliteKnowledgeStore.prototype.saveCheckpoint
      SqliteKnowledgeStore.prototype.saveCheckpoint = function (...args) {
        if (++writes === 1) throw new Error('fixture initial checkpoint failure')
        return original.apply(this, args)
      }
      try {
        const api = createHost(() => { calls++ })
        const result = await settle(api, await api('extract', { text: source }))
        assert.equal(result.status, 'failed', 'initial checkpoint failure cannot be swallowed')
        assert.equal(result.error.code, 'persistence_failed')
        assert.equal(calls, 0)
        assert.equal(store.listDocuments().length, 0)
      } finally { SqliteKnowledgeStore.prototype.saveCheckpoint = original }
    })

    await check('completion identity cannot target a different document, source or revision', async () => {
      const store = await open('completion-identity')
      store.saveGraph(seedGraph, { sourceText: source })
      const checkpoint = { version: 2, documentId: 'document-original', sourceId: 'source-original', baseRevision: 1, graph: seedGraph }
      store.saveCheckpoint(checkpoint, { runId: 'run-identity', sourceText: source })
      const before = store.getDocument('document-original')
      const recovery = store.loadCheckpoint('run-identity')
      for (const patch of [{ documentId: 'different' }, { sourceId: 'different' }, { baseRevision: 0 }]) {
        assert.throws(() => store.saveGraph(seedGraph, {
          sourceText: source, expectedRevision: 1,
          completedRun: { runId: 'run-identity', checkpoint: { ...checkpoint, ...patch }, sourceText: source },
        }), { code: 'checkpoint_invalid' })
        assert.deepEqual(store.getDocument('document-original'), before)
        assert.deepEqual(store.loadCheckpoint('run-identity'), recovery)
      }
    })

    for (const mode of ['create', 'replace', 'append', 'trajectory']) await check('atomic completion and restart recovery: ' + mode, async () => {
      const store = await open('completion-' + mode)
      let calls = 0
      const api = createHost(() => { calls++ })
      const existing = mode === 'replace' || mode === 'append'
      if (existing) store.saveGraph(seedGraph, { sourceText: source, sourceUnits: [source] })
      let documentId = existing ? 'document-original' : 'document-new'
      const before = store.getDocument(documentId)
      const revisions = store.listRevisions(documentId)
      const candidates = store.listCandidates({ documentId })
      store.db.exec("CREATE TRIGGER reject_completion BEFORE UPDATE ON extraction_runs WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'fixture completion write failure'); END")
      const input = mode === 'append' ? 'The second device consumes six watts.' : source
      const started = mode === 'trajectory'
        ? await api('trajectory-extract', { sessionId: 'fixture-session' })
        : await api(mode === 'append' ? 'append-extract' : 'extract', { text: input, documentId })
      const result = await settle(api, started)
      assert.equal(result.status, 'failed', 'cannot acknowledge graph success when the recovery record could not complete')
      assert.equal(result.error.code, 'persistence_failed')
      const saved = store.loadCheckpoint(started.taskId)
      if (mode === 'trajectory') documentId = saved.documentId
      assert.deepEqual(store.getDocument(documentId), before)
      assert.deepEqual(store.listRevisions(documentId), revisions)
      assert.deepEqual(store.listCandidates({ documentId }), candidates)
      assert.equal(saved.status, 'failed')
      assert.equal(saved.checkpoint.baseRevision, existing ? 1 : 0)
      assert.equal(saved.checkpoint.nextBatchIndex, saved.checkpoint.totalBatches)
      const callsBeforeResume = calls
      store.db.exec('DROP TRIGGER reject_completion')
      const restarted = createHost(() => { calls++ })
      const resumed = await settle(restarted, await restarted('resume-extract', { runId: started.taskId, retryFailed: true }))
      assert.equal(resumed.status, 'succeeded', JSON.stringify(resumed.error))
      assert.equal(calls, callsBeforeResume, 'completed extraction must not run again after a failed commit')
      const completed = store.loadCheckpoint(started.taskId)
      assert.equal(completed.status, 'succeeded')
      assert.deepEqual(completed.checkpoint.graph.nodes, resumed.result.nodes)
      assert.equal(completed.sourceText, saved.sourceText, 'append checkpoint must keep only the appended input, not duplicate the full source')
      assert.equal(store.listIncompleteRuns().length, 0)
      assert.equal(store.getDocument(documentId).revision, existing ? 2 : 1)
      if (mode === 'append') assert.equal(store.getDocument(documentId).sourceText, source + '\n\n' + input)
    })

    await check('process exit immediately after commit leaves no phantom unfinished run', async () => {
      const store = await open('commit-exit')
      const child = fork(fileURLToPath(import.meta.url), ['commit-worker'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      let stderr = ''
      child.stderr.on('data', data => { stderr += data })
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
      try { const [code] = await once(child, 'exit'); assert.equal(code, 73, stderr) }
      finally { clearTimeout(timer) }
      const documents = store.listDocuments()
      assert.equal(documents.length, 1)
      assert.equal(store.getDocument(documents[0].documentId).nodes.length, 1)
      assert.equal(store.listIncompleteRuns().length, 0, 'canonical graph and completion record must commit together')
      const row = store.db.prepare('SELECT run_id, status FROM extraction_runs').get()
      assert.equal(row.status, 'succeeded')
      let calls = 0
      const api = createHost(() => { calls++ })
      assert.equal((await api('resume-extract', { runId: row.run_id, retryFailed: true })).error?.code, 'not_recoverable')
      assert.equal(calls, 0)
    })
  } finally {
    for (const store of stores) store.close()
    if (previousDb === undefined) delete process.env.DSH_KG_DB
    else process.env.DSH_KG_DB = previousDb
    rmSync(directory, { recursive: true, force: true })
  }
  if (failures.length) throw new AggregateError(failures, 'Persistence atomicity regressions')
}
