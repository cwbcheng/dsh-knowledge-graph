import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteStore, SqliteKnowledgeStore } from '../src/kg-store.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

if (process.argv[2] === '--worker') {
  const store = await openSqliteStore(process.argv[3])
  process.send({ kind: 'ready', busyTimeout: store.db.prepare('PRAGMA busy_timeout').get().timeout })
  process.on('message', message => {
    if (message.kind === 'stop') { store.close(); process.disconnect(); return }
    const started = performance.now()
    process.send({ kind: 'starting' })
    let result, error
    try { result = store.saveGraph(message.graph, message.options) }
    catch (failure) { error = { code: failure.code, message: failure.message } }
    process.send({ kind: 'result', result, error, elapsedMs: performance.now() - started, transaction: store.db.isTransaction })
  })
} else {
  const directory = mkdtempSync(join(tmpdir(), 'kg-sqlite-contention-'))
  const database = join(directory, 'graph.sqlite'), document = modelStructureFixture()
  const store = await openSqliteStore(database)
  store.saveGraph(document.graph, { sourceText: document.sourceText, sourceUnits: document.sourceUnits })
  const child = fork(fileURLToPath(import.meta.url), ['--worker', database], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  let releaseTimer
  const message = kind => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Worker did not reach ' + kind)) }, 10000)
    const received = value => { if (value.kind === kind) { cleanup(); resolve(value) } }
    const failed = code => { cleanup(); reject(new Error('Worker exited before ' + kind + ': ' + code)) }
    const cleanup = () => { clearTimeout(timer); child.off('message', received); child.off('exit', failed) }
    child.on('message', received); child.once('exit', failed)
  })
  const run = async (expectedRevision, releaseAfter = null) => {
    const started = message('starting'), completed = message('result')
    child.send({ graph: document.graph, options: { sourceText: document.sourceText, sourceUnits: document.sourceUnits, expectedRevision } })
    await started
    if (releaseAfter != null) releaseTimer = setTimeout(() => { store.db.exec('ROLLBACK'); releaseTimer = null }, releaseAfter)
    const result = await completed
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; store.db.exec('ROLLBACK') }
    assert.equal(result.transaction, false, 'A failed or successful write must release its entire transaction')
    return result
  }
  const holdRead = () => { store.db.exec('BEGIN'); store.db.prepare('SELECT * FROM documents').all() }
  try {
    const ready = await message('ready')
    const customDb = new DatabaseSync(':memory:')
    customDb.exec('PRAGMA busy_timeout = 1234')
    const custom = new SqliteKnowledgeStore(customDb, ':memory:')
    try { assert.equal(custom.db.prepare('PRAGMA busy_timeout').get().timeout, 1234, 'Respect an explicit caller lock timeout') }
    finally { custom.close() }
    assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete', 'Do not switch journal mode to evade the contention')
    holdRead()
    const briefRead = await run(1, 200)
    console.log(JSON.stringify({ regressionObservation: true, busyTimeout: ready.busyTimeout,
      briefReaderError: briefRead.error?.message || null, elapsedMs: briefRead.elapsedMs }))
    assert(!briefRead.error, 'A brief independent reader must not make a canonical commit fail immediately')
    assert.equal(briefRead.result.revision, 2)
    assert(briefRead.elapsedMs >= 150)
    assert(ready.busyTimeout > 0 && ready.busyTimeout <= 5000, 'Lock waiting must be bounded')

    store.db.exec('BEGIN IMMEDIATE')
    const briefWriter = await run(2, 200)
    assert(!briefWriter.error && briefWriter.result.revision === 3 && briefWriter.elapsedMs >= 150,
      'A brief writer must serialize BEGIN IMMEDIATE rather than randomly fail')
    const before = store.getCanonicalDocument(document.documentId)
    store.db.exec('BEGIN IMMEDIATE')
    const stale = await run(2, 200)
    assert.equal(stale.error?.code, 'revision_conflict', 'Lock waiting cannot bypass the original expectedRevision')
    assert(stale.elapsedMs >= 150)
    assert.deepEqual(store.getCanonicalDocument(document.documentId), before)

    holdRead()
    const persistentReader = await run(3)
    assert(persistentReader.error?.message.includes('database is locked'), 'A persistent lock must remain an honest failure')
    assert(persistentReader.elapsedMs >= ready.busyTimeout * 0.8 && persistentReader.elapsedMs < 8000,
      'Persistent locks must time out without spinning or waiting indefinitely')
    assert.deepEqual(store.getCanonicalDocument(document.documentId), before, 'A blocked commit cannot leak graph/source/revision changes')
    store.db.exec('ROLLBACK')
    const recovered = await run(3)
    assert(!recovered.error && recovered.result.revision === 4)
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
    console.log(JSON.stringify({ ok: true, independentProcess: true, rollbackJournalUnchanged: true,
      busyTimeoutMs: ready.busyTimeout, callerTimeoutPreserved: true, briefReaderWaitMs: briefRead.elapsedMs, briefWriterWaitMs: briefWriter.elapsedMs,
      staleRevisionStillRejected: true, persistentReaderWaitMs: persistentReader.elapsedMs,
      blockedCommitFullyRolledBack: true, retryAfterRelease: true, databaseIntegrity: true, noLearningWrites: true }))
  } finally {
    clearTimeout(releaseTimer)
    if (store.db.isTransaction) store.db.exec('ROLLBACK')
    if (child.exitCode == null && child.signalCode == null) {
      const exited = once(child, 'exit')
      child.send({ kind: 'stop' })
      const [code, signal] = await exited
      assert.equal(code, 0); assert.equal(signal, null)
    }
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
