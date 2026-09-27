import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as host from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'kg-report-history-'))
const previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(dir, 'graph.sqlite')
let store = await openSqliteStore(process.env.DSH_KG_DB)
const cleanups = []
const documentId = 'report-history-document'
const model = { provider: 'fixture', model: 'report-history' }
const paragraphs = Array.from({ length: 13 }, (_, i) => 'Observation ' + i + ': ' + ('Independent source evidence ' + i + '. ').repeat(4).trim())
const graph = { source: { documentId, id: documentId, title: 'Report history fixture' },
  nodes: paragraphs.map((text, i) => ({ id: 'n' + i, type: 'fact', text, quote: text, paragraph: i, groundingStatus: 'grounded',
    evidence: [{ documentId, sourceId: documentId, paragraph: i, quote: text }] })), edges: [] }
let modelCalls = 0
function createHost() {
  let handler
  host.apply({ get(name) {
    if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
    if (name === 'llm') return { async *stream() { modelCalls++; yield { type: 'text-delta', index: 0, text: '{"issues":[]}' } } }
    return null
  }, effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); return cleanup }, interval() { return () => {} } })
  return (endpoint, body = {}, method = 'POST') => new Promise((resolve, reject) => {
    const req = new EventEmitter()
    Object.assign(req, { method, headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
      url: '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '') })
    Promise.resolve(handler(req, { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } })).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
const input = (extra = {}) => ({ documentId, expectedRevision: store.getDocumentRevision(documentId), canonicalFull: true,
  mode: 'standard', concurrency: 1, model, ...extra })
async function finish(api, extra = {}) {
  const started = await api('verify-graph', input(extra))
  assert(started.taskId, JSON.stringify(started))
  for (let i = 0; i < 1000; i++) {
    const status = await api('task-status', { taskId: started.taskId }, 'GET')
    if (status.status !== 'running') {
      assert.equal(status.status, 'succeeded', JSON.stringify(status))
      return { runId: started.taskId, result: status.result, baseRevision: status.baseRevision }
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('controlled review did not finish')
}
const listed = async api => (await api('extraction-run-list', {}, 'GET')).runs.map(run => run.runId).sort()
function saveReport(api, report, expectedRevision = store.getDocumentRevision(documentId)) {
  const current = store.getDocument(documentId)
  return api('graph-commit', { documentId, expectedRevision,
    graph: { ...current, verification: { lastReport: report, stale: false } },
    baseNodeIds: current.nodes.map(node => node.id), baseEdgeKeys: [] })
}
try {
  store.saveGraph(graph, { sourceText: paragraphs.join('\n\n') })
  let api = createHost()
  const first = await finish(api)
  assert.deepEqual(await listed(api), [first.runId], 'a never-saved report must remain recoverable')
  const staleDelete = { runId: first.runId, expectedUpdatedAt: store.loadCheckpoint(first.runId).updatedAt }
  assert.equal((await saveReport(api, first.result)).revision, 2)
  assert.deepEqual(await listed(api), [])
  const callsBeforeReuse = modelCalls
  const second = await finish(api, { reuseVerified: true })
  assert.notEqual(first.result.reportId, second.result.reportId)
  assert.equal(modelCalls, callsBeforeReuse)
  assert.equal((await saveReport(api, second.result)).revision, 3)
  api = createHost()
  assert.deepEqual(await listed(api), [], 'a previously saved report must not reappear when a second report becomes current')
  assert.equal((await api('extraction-run-delete', staleDelete)).error?.code, 'run_conflict',
    'a stale pending-report delete must not remove an already published run or its reusable batches')
  assert.equal(store.loadCheckpoint(first.runId).updatedAt, staleDelete.expectedUpdatedAt,
    'publication must not rewrite checkpoint identity or fake new review progress')
  for (const run of [first, second]) {
    assert.equal(store.loadVerificationBatches(run.runId).length, run.result.coverage.batchCount)
    assert.equal((await api('task-status', { taskId: run.runId }, 'GET')).result.reportId, run.result.reportId)
  }

  const third = await finish(api, { reuseVerified: true })
  const graphBeforeFailure = store.getDocument(documentId)
  const revisionsBeforeFailure = store.db.prepare('SELECT * FROM graph_revisions ORDER BY revision').all()
  store.db.exec("CREATE TRIGGER refuse_report_save AFTER INSERT ON graph_revisions BEGIN SELECT RAISE(ABORT, 'fixture disk full after snapshot'); END")
  const failed = await saveReport(api, third.result)
  assert(failed.error, JSON.stringify(failed))
  assert.deepEqual(store.getDocument(documentId), graphBeforeFailure, 'failed report save must roll back the graph')
  assert.deepEqual(store.db.prepare('SELECT * FROM graph_revisions ORDER BY revision').all(), revisionsBeforeFailure,
    'failed report save must roll back snapshots and their publication evidence')
  assert.deepEqual(await listed(createHost()), [third.runId], 'a real failed save must remain discoverable after Host recreation')
  assert.equal(store.loadVerificationBatches(third.runId).length, third.result.coverage.batchCount)
  store.db.exec('DROP TRIGGER refuse_report_save')
  assert.equal((await saveReport(api, third.result, 2)).error?.code, 'revision_conflict')
  assert.deepEqual(await listed(api), [third.runId], 'a stale save attempt cannot acknowledge publication')
  const recovered = await createHost()('task-status', { taskId: third.runId }, 'GET')
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.baseRevision, 3)
  assert.equal((await saveReport(api, recovered.result, recovered.baseRevision)).revision, 4)
  assert.equal(store.restoreRevision(documentId, 2, 4).revision, 5)
  assert.equal(store.getDocument(documentId).verification.lastReport.reportId, first.result.reportId)
  assert.deepEqual(await listed(api), [], 'restoring the first report must not reopen later published reports')
  assert.equal(store.restoreRevision(documentId, 1, 5).revision, 6)
  assert.equal(store.getDocument(documentId).verification, undefined)
  assert.deepEqual(await listed(api), [], 'restoring a pre-review revision must not undo publication history')
  assert.throws(() => store.restoreRevision(documentId, 2, 5), error => error.code === 'revision_conflict')
  assert.equal(modelCalls, callsBeforeReuse, 'listing, recovery, restore and reuse must not spend extra model calls')

  // The same report ID in another document cannot acknowledge this document.
  store.saveGraph({ source: { documentId: 'other-document', id: 'other-source' }, nodes: [], edges: [],
    verification: { lastReport: { reportId: 'collision', issues: [] } } })
  store.saveGraph({ source: { documentId: 'other-document', id: 'other-source' }, nodes: [], edges: [] }, { expectedRevision: 1 })
  const seed = (runId, reportId, status = 'succeeded') => store.saveCheckpoint({ taskKind: 'verify', documentId,
    totalBatches: 1, report: { reportId, issues: [] } }, { runId, status })
  seed('never-published', 'collision')
  seed('failed-run', first.result.reportId, 'failed')
  seed('paused-run', first.result.reportId, 'paused')
  seed('running-run', first.result.reportId, 'running')
  assert.deepEqual(await listed(api), ['failed-run', 'never-published', 'paused-run', 'running-run'],
    'document scope and unfinished statuses must be independent of completed report history')
  const pendingDelete = { runId: 'never-published', expectedUpdatedAt: store.loadCheckpoint('never-published').updatedAt }
  assert.equal((await api('extraction-run-delete', pendingDelete)).deleted, true, 'a genuinely unsaved report remains explicitly deletable')

  // Simulate reopening a pre-index database. Existing committed snapshots are
  // publication evidence; a legacy row without such evidence stays recoverable.
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  seed('legacy-unknown', 'no-publication-proof')
  store.db.exec('DROP INDEX IF EXISTS verification_report_history_idx')
  const contentBeforeMigration = store.db.prepare('SELECT * FROM graph_revisions ORDER BY document_id, revision').all()
  store.close()
  store = await openSqliteStore(process.env.DSH_KG_DB)
  api = createHost()
  assert.deepEqual(await listed(api), ['failed-run', 'legacy-unknown', 'paused-run', 'running-run'])
  assert.deepEqual(store.db.prepare('SELECT * FROM graph_revisions ORDER BY document_id, revision').all(), contentBeforeMigration)
  assert.equal((await api('verification-plan', input({ reuseVerified: true }))).minimumModelRequests, 0,
    'published batch results survive report replacement, restores and migration')

  let listingSql
  const prepare = store.db.prepare.bind(store.db)
  store.db.prepare = sql => { if (sql.includes('FROM extraction_runs AS run WHERE')) listingSql = sql; return prepare(sql) }
  store.listIncompleteRuns()
  store.db.prepare = prepare
  const plan = prepare('EXPLAIN QUERY PLAN ' + listingSql).all(50).map(row => row.detail)
  assert(plan.some(detail => /SEARCH.*verification_report_history_idx/.test(detail)), JSON.stringify(plan))
  assert(!plan.some(detail => /SCAN history/.test(detail)), 'the recovery list must not parse every large revision snapshot per run')

  const legacyPath = join(dir, 'pre-snapshot.sqlite')
  const legacy = new DatabaseSync(legacyPath)
  legacy.exec(`CREATE TABLE graph_revisions (document_id TEXT NOT NULL, revision INTEGER NOT NULL,
    parent_revision INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'extract', summary_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, PRIMARY KEY (document_id, revision))`)
  legacy.close()
  const migrated = await openSqliteStore(legacyPath)
  try {
    assert(migrated.db.prepare('PRAGMA table_info(graph_revisions)').all().some(row => row.name === 'snapshot_json'))
    assert(migrated.db.prepare('PRAGMA index_list(graph_revisions)').all().some(row => row.name === 'verification_report_history_idx'))
  } finally { migrated.close() }
  console.log(JSON.stringify({ reportReplacement: true, durableHistory: true, failedSaveRollback: true, revisionFence: true,
    reportRecovery: true, restoreHistory: true, preservedBatches: true, staleDeleteRejected: true, documentIsolation: true,
    unfinishedRunsVisible: true, legacyMigration: true, indexedLookup: true, controlledModelCalls: modelCalls }))
} finally {
  for (const cleanup of cleanups.reverse()) cleanup()
  store.close()
  if (previousDb === undefined) delete process.env.DSH_KG_DB; else process.env.DSH_KG_DB = previousDb
  rmSync(dir, { recursive: true, force: true })
}
