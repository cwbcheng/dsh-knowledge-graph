import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { openSqliteStore } from '../src/kg-store.mjs'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: modelStructureFixture() })
const { store, database, document, handler } = harness
store.db.exec('PRAGMA journal_mode = WAL')
const writer = await openSqliteStore(database)
const getDocument = SqliteKnowledgeStore.prototype.getDocument
const server = createServer((req, res) => handler(req, res))
let armed = false, interleavings = 0, readerTransactions = []

// Two real SQLite connections commit between the graph read and source-unit read.
// WAL is an isolated fixture setting; the production database configuration is untouched.
const revised = structuredClone(document)
const replaceText = value => {
  if (Array.isArray(value)) return value.map(replaceText)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceText(item)]))
  return typeof value === 'string' ? value.replace(/10 元/g, '11 元') : value
}
revised.graph = replaceText(revised.graph)
revised.sourceUnits = replaceText(revised.sourceUnits)
revised.sourceText = replaceText(revised.sourceText)
revised.graph.summary = 'Explicitly revised isolated model'

SqliteKnowledgeStore.prototype.getDocument = function (id) {
  const graph = getDocument.call(this, id)
  if (armed && this.filename === database && id === document.documentId) {
    armed = false
    readerTransactions.push(this.db.isTransaction)
    writer.saveGraph(revised.graph, { sourceText: revised.sourceText, sourceUnits: revised.sourceUnits,
      expectedRevision: graph.revision })
    interleavings++
  }
  return graph
}

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/'
  const post = async (method, args) => {
    const response = await fetch(baseUrl + method, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: document.documentId, ...args }) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const requests = [
    ['connection-models', { modelId: 'taxi' }],
    ['connection-models', { query: '行驶距离' }],
    ['connection-models', { modelId: 'taxi', compareModelId: 'multi' }],
    ['connection-models', { modelId: 'taxi', structureSources: true }],
    ['connection-models', { modelId: 'taxi', diagnosis: true }],
    ['reading-map', { topicId: 'first' }],
    ['learning-mode', { action: 'plan', modelId: 'taxi', exercise: 'understanding' }],
    ['learning-mode', { action: 'plan', modelId: 'taxi' }],
  ]
  for (const [method, args] of requests) {
    const revision = writer.getDocumentRevision(document.documentId)
    const original = await post(method, { ...args, expectedRevision: revision })
    assert(!original.error, JSON.stringify(original.error))
    armed = true
    const interleaved = await post(method, { ...args, expectedRevision: revision })
    assert.deepEqual(interleaved, original,
      method + ' must not label newer graph/source data with the older revision')
    assert.equal(writer.getDocumentRevision(document.documentId), revision + 1)
    const stale = await post(method, { ...args, expectedRevision: revision })
    assert.equal(stale.error.code, 'revision_conflict')
    const current = await post(method, { ...args, expectedRevision: revision + 1 })
    assert(!current.error, JSON.stringify(current.error))
    assert.equal(current.revision, revision + 1)
    if (method === 'connection-models' && args.modelId === 'taxi' && !args.diagnosis) {
      const detail = current.left || current
      assert.equal(detail.model.hasStructure, true, 'current source and model structure must still agree')
      assert(detail.model.text.includes('11 元'))
    }
    writer.saveGraph(document.graph, { sourceText: document.sourceText, sourceUnits: document.sourceUnits,
      expectedRevision: revision + 1 })
  }
  assert.equal(interleavings, requests.length)
  assert(readerTransactions.every(Boolean), 'a read transaction must cover graph and source units together')
  assert.equal((await post('connection-models', { documentId: 'missing', expectedRevision: 1 })).error.code, 'not_found')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0,
    'model browsing and planning must not create learning records')

  const headBaseline = store.getDocument(document.documentId)
  const headUnits = store.getDocumentSourceUnits(document.documentId)
  const prepare = store.db.prepare
  let headInterleaved = false
  store.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (sql === 'SELECT * FROM documents WHERE document_id = ?' && !headInterleaved) {
      const get = statement.get
      statement.get = function (...args) {
        const row = get.apply(this, args)
        headInterleaved = true
        writer.saveGraph(revised.graph, { sourceText: revised.sourceText, sourceUnits: revised.sourceUnits,
          expectedRevision: row.graph_revision })
        return row
      }
    }
    return statement
  }
  try {
    assert.deepEqual(store.getCanonicalDocument(document.documentId), { documentId: document.documentId,
      revision: headBaseline.revision, sourceText: headBaseline.sourceText, sourceUnits: headUnits, graph: headBaseline },
    'metadata, nodes, edges and chunks must share the source snapshot, not only the final source-unit query')
    assert(headInterleaved)
  } finally { store.db.prepare = prepare }
  writer.saveGraph(document.graph, { sourceText: document.sourceText, sourceUnits: document.sourceUnits,
    expectedRevision: headBaseline.revision + 1 })

  const getCanonicalDocument = SqliteKnowledgeStore.prototype.getCanonicalDocument
  let lateWrite = true
  SqliteKnowledgeStore.prototype.getCanonicalDocument = function (id) {
    const snapshot = getCanonicalDocument.call(this, id)
    if (lateWrite && this.filename === database && id === document.documentId) {
      lateWrite = false
      assert.equal(this.db.isTransaction, false, 'read transaction must end before the separate save transaction')
      writer.saveGraph(revised.graph, { sourceText: revised.sourceText, sourceUnits: revised.sourceUnits,
        expectedRevision: snapshot.revision })
    }
    return snapshot
  }
  const saveRevision = writer.getDocumentRevision(document.documentId)
  try {
    const saved = await post('learning-mode', { action: 'save', modelId: 'taxi', exercise: 'understanding',
      expectedRevision: saveRevision, taskId: 'model_understanding:taxi', attemptId: 'changed-after-plan', selfRating: 'not_assessed',
      response: { inputs: '', outputs: '', mapping: 'A personal expression, not a truth claim.', conditions: '',
        boundary: '', questions: '', revisionReason: '', parentAttemptId: '', practiceIds: [] } })
    assert.equal(saved.error.code, 'revision_conflict', 'a coherent read is not permission to save across a later source revision')
    assert.equal(store.getLearningAttempt('changed-after-plan'), null)
    assert.equal(lateWrite, false)
  } finally { SqliteKnowledgeStore.prototype.getCanonicalDocument = getCanonicalDocument }
  writer.saveGraph(document.graph, { sourceText: document.sourceText, sourceUnits: document.sourceUnits,
    expectedRevision: saveRevision + 1 })

  const before = store.getDocument(document.documentId)
  const units = store.getDocumentSourceUnits(document.documentId)
  const snapshot = store.getCanonicalDocument(document.documentId)
  assert.deepEqual(snapshot, { documentId: document.documentId, revision: before.revision,
    sourceText: before.sourceText, sourceUnits: units, graph: before })
  assert.equal(store.db.isTransaction, false)
  assert.equal(store.getCanonicalDocument('missing'), null)
  assert.equal(store.db.isTransaction, false, 'missing document must not retain a transaction')

  store.db.exec('BEGIN IMMEDIATE')
  try {
    store.db.prepare('UPDATE documents SET title = ? WHERE document_id = ?').run('Uncommitted outer change', document.documentId)
    assert(store.getCanonicalDocument(document.documentId))
    assert.equal(store.db.isTransaction, true, 'a nested read cannot commit the caller transaction')
  } finally { store.db.exec('ROLLBACK') }
  assert.deepEqual(store.getDocument(document.documentId), before)

  const getUnits = store.getDocumentSourceUnits
  store.getDocumentSourceUnits = () => { throw new Error('Isolated source read failure') }
  assert.throws(() => store.getCanonicalDocument(document.documentId), /Isolated source read failure/)
  assert.equal(store.db.isTransaction, false, 'failed standalone read must release its transaction')
  store.db.exec('BEGIN IMMEDIATE')
  try {
    store.db.prepare('UPDATE documents SET title = ? WHERE document_id = ?').run('Preserved caller change', document.documentId)
    assert.throws(() => store.getCanonicalDocument(document.documentId), /Isolated source read failure/)
    assert.equal(store.db.isTransaction, true, 'failed nested read must not roll back the caller transaction')
    assert.equal(store.db.prepare('SELECT title FROM documents WHERE document_id = ?').get(document.documentId).title, 'Preserved caller change')
  } finally { store.db.exec('ROLLBACK'); store.getDocumentSourceUnits = getUnits }
  assert.deepEqual(store.getDocument(document.documentId), before)
  assert.deepEqual(store.getDocumentSourceUnits(document.documentId), units)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)

  console.log(JSON.stringify({ ok: true, actualHostHttp: true, independentSqliteWriter: true,
    interleavings, graphAndSourceSnapshot: true, graphRowInterleaving: true, staleRevisionRejected: true,
    laterSaveStillRevisionFenced: true, nestedReadPreservesCaller: true, readFailureReleased: true, noLearningWrites: true }))
} finally {
  SqliteKnowledgeStore.prototype.getDocument = getDocument
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  writer.close()
  harness.stop()
}
