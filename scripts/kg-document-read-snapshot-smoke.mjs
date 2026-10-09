import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

const fixture = modelStructureFixture()
fixture.graph.staging = { chunks: [{ chunkId: 'snapshot-chunk', startParagraph: 0, endParagraph: 7,
  summary: 'Original chunk', nodeIds: fixture.graph.nodes.map(node => node.id), edgeCount: fixture.graph.edges.length }] }
const replaceText = value => {
  if (Array.isArray(value)) return value.map(replaceText)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceText(item)]))
  return typeof value === 'string' ? value.replace(/10 元/g, '11 元') : value
}
const revised = replaceText(fixture)
const locationParagraph = fixture.graph.nodes.find(node => Number.isSafeInteger(node.paragraph)).paragraph
revised.graph.summary = 'Revised isolated graph'
revised.graph.source.title = 'Revised document title'
revised.graph.nodes.push({ ...structuredClone(revised.graph.nodes[0]), id: 'same-name-other-identity' })
revised.graph.edges.push({ fromNodeId: 'unknown', toNodeId: 'same-name-other-identity', relation: 'maps_between' })
revised.graph.staging.chunks[0].summary = 'Revised chunk'
revised.graph.staging.chunks[0].nodeIds.push('same-name-other-identity')
revised.graph.staging.chunks[0].edgeCount++

const harness = await modelLearningHarness({ fixture })
const { store, database, document, handler } = harness
// Only the isolated fixture uses WAL, allowing an independent writer to commit mid-read.
store.db.exec('PRAGMA journal_mode = WAL')
const writer = await openSqliteStore(database)
const originalMethods = Object.fromEntries(['getDocument', 'getDocumentWindow'].map(name => [name, SqliteKnowledgeStore.prototype[name]]))
const server = createServer((req, res) => handler(req, res))
let armed = null, interleavings = 0
const transactionStates = []
const save = value => writer.saveGraph(value.graph, { sourceText: value.sourceText, sourceUnits: value.sourceUnits,
  expectedRevision: writer.getDocumentRevision(document.documentId) })

function interleave(reader, read, sqlMatch, commit = () => save(revised)) {
  const prepare = reader.db.prepare
  let fired = false
  reader.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (!fired && sqlMatch(sql)) {
      for (const name of ['get', 'all']) {
        const execute = statement[name]
        statement[name] = function (...args) {
          const value = execute.apply(this, args)
          if (!fired) {
            fired = true
            transactionStates.push(reader.db.isTransaction)
            commit()
            interleavings++
          }
          return value
        }
      }
    }
    return statement
  }
  try {
    const value = read()
    assert(fired, 'The writer must really commit at the selected SQL boundary')
    return value
  } finally { reader.db.prepare = prepare }
}
const head = sql => /^SELECT (?:\*|document_id, .*) FROM documents WHERE document_id = \?$/.test(sql)
for (const [name, original] of Object.entries(originalMethods)) {
  SqliteKnowledgeStore.prototype[name] = function (...args) {
    if (!armed || this.filename !== database) return original.apply(this, args)
    const boundary = armed
    armed = null
    return interleave(this, () => original.apply(this, args), boundary)
  }
}

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/'
  const post = async (method, args) => {
    const response = await fetch(baseUrl + method, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: document.documentId, ...args,
        ...(args.focusParagraph === undefined ? {} : { expectedRevision: writer.getDocumentRevision(document.documentId) }) }) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const requests = [
    ['document-load', {}],
    ['document-load', { nodeLimit: 20, nodeOffset: 30, includeSourceText: false }],
    ['document-load', { nodeLimit: 20, query: '行驶距离' }],
    ['document-load', { query: 'no-such-node', includeSourceText: false }],
    ['document-load', { focusParagraph: locationParagraph, nodeLimit: 20, includeSourceText: false }],
    ['document-load', { focusParagraph: 10000, includeSourceText: false }],
    ['document-export', { includeSourceText: true }],
    ['document-export', {}],
  ]
  for (const [method, args] of requests) {
    const baseline = await post(method, args)
    assert(!baseline.error)
    armed = head
    const raced = await post(method, args)
    assert.deepEqual(raced, baseline, method + ' must not label newer nodes, edges, chunks or counts with the old revision')
    assert.equal(writer.getDocumentRevision(document.documentId), baseline.revision + 1)
    const current = await post(method, args)
    assert.equal(current.revision, baseline.revision + 1)
    assert.equal(current.graph.staging.chunks[0].summary, 'Revised chunk')
    if (method === 'document-load') {
      assert.equal(current.graph.view.totalNodes, baseline.graph.view.totalNodes + 1)
      assert.equal(current.graph.view.totalEdges, baseline.graph.view.totalEdges + 1)
    } else {
      assert(current.graph.nodes.some(node => node.id === 'same-name-other-identity'))
      assert.equal(current.graph.nodes.length, baseline.graph.nodes.length + 1)
    }
    if (args.includeSourceText === false || (method === 'document-export' && !args.includeSourceText)) {
      assert(!current.sourceText, 'Source omission must remain intact')
    }
    save(document)
  }

  const reads = [
    ['full metadata', () => store.getDocument(document.documentId), head],
    ['full nodes', () => store.getDocument(document.documentId), sql => sql.startsWith('SELECT * FROM graph_nodes')],
    ['full edges', () => store.getDocument(document.documentId), sql => sql.startsWith('SELECT * FROM graph_edges')],
    ['window count', () => store.getDocumentWindow(document.documentId, { limit: 5 }), sql => sql.startsWith('SELECT COUNT(*) AS count FROM graph_nodes')],
    ['window rows', () => store.getDocumentWindow(document.documentId, { limit: 5, offset: 4 }), sql => sql.startsWith('SELECT * FROM graph_nodes')],
    ['query neighbors', () => store.getDocumentWindow(document.documentId, { query: '行驶距离', limit: 20 }), sql => sql.startsWith('SELECT * FROM graph_edges')],
    ['query empty', () => store.getDocumentWindow(document.documentId, { query: 'no-such-node', limit: 20 }), head],
    ['tail clamping', () => store.getDocumentWindow(document.documentId, { offset: 999, limit: 2000 }), head],
    ['last chunk query', () => store.getDocumentWindow(document.documentId), sql => sql.startsWith('SELECT * FROM chunks')],
    ['paragraph identity', () => store.getDocumentWindow(document.documentId, { focusParagraph: locationParagraph,
      expectedRevision: writer.getDocumentRevision(document.documentId), limit: 5 }), sql => sql.includes('paragraph = ? ORDER BY node_id LIMIT 1')],
    ['paragraph rank', () => store.getDocumentWindow(document.documentId, { focusParagraph: locationParagraph,
      expectedRevision: writer.getDocumentRevision(document.documentId), limit: 5 }), sql => sql.includes('paragraph IS NULL') && sql.includes('paragraph < ?')],
    ['paragraph rows', () => store.getDocumentWindow(document.documentId, { focusParagraph: locationParagraph,
      expectedRevision: writer.getDocumentRevision(document.documentId), limit: 5 }), sql => sql.startsWith('SELECT * FROM graph_nodes')],
  ]
  for (const [label, read, boundary] of reads) {
    const baseline = read()
    const raced = interleave(store, read, boundary)
    assert.deepEqual(raced, baseline, label + ' must use a single document snapshot')
    assert.equal(store.db.isTransaction, false, label + ' must release its transaction')
    assert.equal(writer.getDocumentRevision(document.documentId), baseline.revision + 1)
    save(document)
  }
  assert(transactionStates.every(Boolean), 'All SQL boundaries must remain inside a read transaction')

  const beforeDelete = store.getDocumentWindow(document.documentId)
  const deletingRead = interleave(store, () => store.getDocumentWindow(document.documentId), head, () => {
    writer.db.exec('BEGIN IMMEDIATE')
    try { writer.db.prepare('DELETE FROM documents WHERE document_id = ?').run(document.documentId); writer.db.exec('COMMIT') }
    catch (error) { writer.db.exec('ROLLBACK'); throw error }
  })
  assert.deepEqual(deletingRead, beforeDelete, 'A deletion during a read must not turn the old document into an empty fabricated graph')
  assert.equal(store.getDocument(document.documentId), null)
  assert.equal(store.getDocumentWindow(document.documentId), null)
  assert.equal((await post('document-load', {})).error.code, 'not_found')
  assert.equal((await post('document-export', {})).error.code, 'not_found')
  save(document)

  for (const read of [() => store.getDocument(document.documentId), () => store.getDocumentWindow(document.documentId),
    () => store.getCanonicalDocument(document.documentId)]) {
    const baseline = read()
    assert.equal(store.db.isTransaction, false)
    // An identically named enclosing savepoint must not be released by a nested read.
    store.db.exec('SAVEPOINT kg_document_read')
    store.db.prepare('UPDATE documents SET title = ? WHERE document_id = ?').run('Caller change', document.documentId)
    assert(read())
    assert.equal(store.db.isTransaction, true)
    assert.equal(store.db.prepare('SELECT title FROM documents WHERE document_id = ?').get(document.documentId).title, 'Caller change')
    store.db.exec('ROLLBACK TO SAVEPOINT kg_document_read')
    store.db.exec('RELEASE SAVEPOINT kg_document_read')
    assert.deepEqual(read(), baseline)

    const prepare = store.db.prepare
    store.db.prepare = function (sql) {
      const statement = prepare.call(this, sql)
      if (sql.startsWith('SELECT * FROM chunks')) statement.all = () => { throw new Error('Isolated chunk read failure') }
      return statement
    }
    try {
      assert.throws(read, /Isolated chunk read failure/)
      assert.equal(store.db.isTransaction, false, 'Failed standalone read retained a transaction')
      store.db.exec('BEGIN IMMEDIATE')
      store.db.prepare('UPDATE documents SET title = ? WHERE document_id = ?').run('Preserved caller change', document.documentId)
      assert.throws(read, /Isolated chunk read failure/)
      assert.equal(store.db.isTransaction, true)
      assert.equal(store.db.prepare('SELECT title FROM documents WHERE document_id = ?').get(document.documentId).title, 'Preserved caller change')
    } finally {
      if (store.db.isTransaction) store.db.exec('ROLLBACK')
      store.db.prepare = prepare
    }
    assert.deepEqual(read(), baseline)
  }
  assert.equal(store.getDocument('missing'), null)
  assert.equal(store.getDocumentWindow('missing'), null)
  assert.equal(store.db.isTransaction, false)

  // Also prove the default rollback-journal lock behavior, without changing production settings.
  const rollbackDirectory = mkdtempSync(join(tmpdir(), 'kg-document-rollback-'))
  const rollbackStore = await openSqliteStore(join(rollbackDirectory, 'graph.sqlite'))
  rollbackStore.saveGraph(document.graph, { sourceText: document.sourceText, sourceUnits: document.sourceUnits })
  const rollbackWriter = await openSqliteStore(rollbackStore.filename)
  const rollbackBaseline = rollbackStore.getDocument(document.documentId)
  try {
    assert.equal(rollbackStore.db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete')
    const result = interleave(rollbackStore, () => rollbackStore.getDocument(document.documentId), head, () => {
      assert.throws(() => rollbackWriter.saveGraph(revised.graph, { sourceText: revised.sourceText,
        sourceUnits: revised.sourceUnits, expectedRevision: rollbackBaseline.revision }), /database is locked/)
      assert.equal(rollbackWriter.db.isTransaction, false, 'A blocked commit must roll back the whole write')
    })
    assert.deepEqual(result, rollbackBaseline)
    assert.deepEqual(rollbackWriter.getDocument(document.documentId), rollbackBaseline)
    rollbackWriter.saveGraph(revised.graph, { sourceText: revised.sourceText, sourceUnits: revised.sourceUnits,
      expectedRevision: rollbackBaseline.revision })
    const history = rollbackWriter.db.prepare('SELECT snapshot_json FROM graph_revisions WHERE document_id = ? AND revision = ?')
      .get(document.documentId, rollbackBaseline.revision)
    assert.deepEqual(JSON.parse(history.snapshot_json).graph, rollbackBaseline, 'A read inside saveGraph must preserve the historical snapshot')
  } finally {
    rollbackWriter.close()
    rollbackStore.close()
    rmSync(rollbackDirectory, { recursive: true, force: true })
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
  assert(transactionStates.every(Boolean))
  console.log(JSON.stringify({ ok: true, actualHostHttp: true, independentSqliteWriter: true, httpReads: requests.length,
    sqlBoundaryReads: reads.length, interleavings, windowAndExportCoherent: true, deletionSnapshotCoherent: true,
    rollbackJournalProtected: true, nestedCallerPreserved: true, failedReadReleased: true, historyPreserved: true, noLearningWrites: true }))
} finally {
  for (const [name, original] of Object.entries(originalMethods)) SqliteKnowledgeStore.prototype[name] = original
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  writer.close()
  harness.stop()
}
