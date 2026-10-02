import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import hostPlugin, { createGraphContract } from '../src/index.host.js'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import { openSqliteStore } from '../src/kg-store.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { browseDocumentIds as ids, documentBrowseIdentityFixture } from './kg-document-browse-identity-fixture-data.mjs'

const selected = documentBrowseIdentityFixture(ids.selected)
let providerCalls = 0
const harness = await modelLearningHarness({ fixture: selected, llm: { stream() {
  providerCalls++; throw new Error('An identity rejection must not invoke a model')
} } })
const fixtures = new Map([[ids.selected, selected]])
for (const [key, id] of Object.entries(ids)) {
  if (id === ids.selected) continue
  const fixture = documentBrowseIdentityFixture(id, 'DOCUMENT_' + key.toUpperCase(), '隔离文档 ' + key)
  fixtures.set(id, fixture)
  harness.store.saveGraph(fixture.graph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const before = new Map([...fixtures.keys()].map(id => [id, hash(harness.store.getCanonicalDocument(id))]))
const server = createServer((req, res) => harness.handler(req, res))
const getDocument = SqliteKnowledgeStore.prototype.getDocument
const getWindow = SqliteKnowledgeStore.prototype.getDocumentWindow
const previousHarness = globalThis.harness
const handlers = new Map()
let writer, armed = '', interleavings = 0, inReadTransaction = false, readCases = 0, rejectedWrites = 0
const contract = createGraphContract()
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/'
  const post = async (method, args) => {
    const response = await fetch(base + method, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, ...args }) })
    const result = await response.json()
    assert.equal(response.status, 200, method + ': ' + JSON.stringify(result.error))
    return result
  }
  const browse = ['document-load', 'document-export', 'connection-models', 'reading-map', 'graph-neighborhood']
  globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
  hostPlugin().apply({ get: () => null, interval: () => () => {} })
  for (const [documentId, fixture] of fixtures) {
    if (documentId === ids.oversized) continue
    const canonical = harness.store.getCanonicalDocument(documentId)
    for (const method of browse) {
      const result = await post(method, { documentId, centerId: 'taxi', hops: 1, includeSourceText: true, modelId: 'search-condition' })
      assert(!result.error, method + ': ' + JSON.stringify(result.error))
      assert.equal(result.documentId, documentId)
      assert.equal(result.revision, 1)
      if (['document-load', 'document-export'].includes(method)) {
        assert.equal(result.graph.source.documentId, documentId)
        assert.equal(result.graph.source.title, fixture.graph.source.title)
      }
      if (result.sourceText) assert.equal(result.sourceText, fixture.sourceText)
      if (method === 'connection-models') {
        assert.deepEqual(result, contract.connectionModels(canonical, { expectedRevision: 1, modelId: 'search-condition' }))
        assert.equal(result.structure.branches[0].condition.text,
          fixture.graph.nodes.find(node => node.id === 'search-condition').modelStructure.branches[0].condition.text)
      }
      if (method === 'reading-map') {
        assert(result.items.every(item => canonical.graph.nodes.some(node => node.id === item.nodeId)))
        assert(result.items.every(item => item.citations.every(citation =>
          canonical.sourceUnits.some(unit => unit.paragraph === citation.paragraph && unit.text.includes(citation.quote)))))
      }
      readCases++
    }
    const candidates = await post('candidate-list', { documentId })
    assert(!candidates.error)
    assert(candidates.candidates.every(item => item.documentId === documentId))
    const omitted = await post('document-load', { documentId, includeSourceText: false, nodeLimit: 20 })
    assert.equal(omitted.sourceText, '')
    assert.equal(omitted.documentId, documentId)
    assert(omitted.graph.nodes.length <= 20)
  }

  const missing = ids.alias + ':not-in-canonical-store'
  for (const method of browse) {
    const forged = { documentId: missing, graph: { source: { documentId: ids.alias }, nodes: [{ id: 'taxi', type: 'connection_model',
      text: 'Forged prefix model' }], edges: [] }, text: 'Forged prefix source', centerId: 'taxi' }
    assert.equal((await post(method, forged)).error.code, 'not_found', method + ' must not use a prefix document or supplied graph')
    assert.equal((await handlers.get(method)(forged)).error.code, 'not_found', 'Dynamic Host must not substitute a prefix or supplied graph')
    for (const documentId of ['', null, 123, [], {}, ids.oversized]) {
      assert.equal((await post(method, { documentId, centerId: 'taxi' })).error.code, 'invalid_input', method)
      assert.equal((await handlers.get(method)({ documentId, centerId: 'taxi' })).error.code, 'invalid_input', method)
    }
  }
  for (const documentId of [ids.spaced, ids.normalizedPeer]) {
    const result = await post('graph-query', { documentId, nodeIds: ['search-condition'], hops: 0 })
    assert(!result.error)
    assert.equal(result.documentId, documentId, 'Consumption must not trim a newly reopened opaque identity')
  }
  for (const method of ['connection-models', 'reading-map', 'graph-neighborhood']) {
    const old = await post(method, { documentId: ids.selected, expectedRevision: 0, centerId: 'taxi' })
    assert.equal(old.error.code, 'revision_conflict')
    assert.equal(old.error.currentRevision, 1)
  }

  // The selected document is now readable, but existing write contracts still
  // cap IDs at 160. Reject rather than mutate the real prefix document.
  const writes = [
    ['graph-commit', { graph: fixtures.get(ids.alias).graph, baseNodeIds: fixtures.get(ids.alias).graph.nodes.map(node => node.id) }],
    ['graph-commit-preview', { graph: fixtures.get(ids.alias).graph }],
    ['graph-source-peers', { nodeId: 'taxi', patch: { text: 'Possible correction' } }],
    ['image-nodes', { action: 'materialize' }], ['image-review', { action: 'save', imageId: 'missing' }],
    ['graph-undo-bulk-review', { expectedRevision: 2, parentRevision: 1, reportId: 'isolated' }],
    ['relation-retry', {}], ['append-extract', { text: 'Do not append to a prefix.', existing: fixtures.get(ids.alias).graph }],
    ['extract', { text: 'Do not replace the prefix.', model: { provider: 'synthetic', model: 'synthetic' } }],
    ['verification-plan', {}], ['verify-graph', { mode: 'canonical_full' }],
    ['perspectives', { action: 'save', perspective: { name: 'Must not be saved', state: {} } }],
    ['perspectives', { action: 'delete', id: 'missing', expectedVersion: 1 }],
    ['learning-mode', { action: 'plan' }],
  ]
  for (const documentId of [ids.selected, ids.spaced]) {
    for (const [method, args] of writes) {
      const result = await post(method, { documentId, ...args })
      assert(result.error, method + ' must reject the unsupported write identity')
      assert(!result.taskId, method + ' must not start background work')
      if (handlers.has(method)) {
        const dynamic = await handlers.get(method)({ documentId, expectedRevision: 1, ...args })
        assert(dynamic.error && !dynamic.taskId, method + ' must also fail closed in dynamic mode')
      }
      rejectedWrites++
    }
    const checkpoint = await post('extract', { documentId: '', checkpoint: { documentId }, text: 'Invalid resume identity' })
    assert.equal(checkpoint.error.code, 'invalid_input')
    assert.equal((await handlers.get('extract')({ documentId: '', checkpoint: { documentId }, text: 'Invalid resume identity' })).error.code, 'invalid_input')
  }
  assert.equal(providerCalls, 0)
  for (const [id, digest] of before) assert.equal(hash(harness.store.getCanonicalDocument(id)), digest)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS count FROM document_perspectives').get().count, 0)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)

  const canonical = harness.store.getCanonicalDocument(ids.selected)
  const roles = await post('connection-models', { documentId: ids.selected, query: 'ROLEBRANCHCASE' })
  assert.equal(roles.total, 13)
  for (const item of roles.items) {
    const detail = await post('connection-models', { documentId: ids.selected, modelId: item.nodeId })
    const original = canonical.graph.nodes.find(node => node.id === item.nodeId)
    assert.deepEqual(detail.structure.slots.map(({ conceptText, ...slot }) => slot), original.modelStructure.slots)
    assert.deepEqual(detail.structure.branches.map(({ pairedExamples, incompleteExamples, ...branch }) => branch), original.modelStructure.branches)
    assert.equal(detail.model.contentIdentity, original.modelStructure.identity)
    assert.equal(detail.model.entailmentStatus, original.entailmentStatus || 'unverified')
  }
  assert.equal(roles.items.find(item => item.nodeId === 'search-unknown-role').structureComplete, false)
  assert.equal(roles.items.find(item => item.nodeId === 'search-wrong-model').contentIdentity, 'wrong_example')
  const multi = await post('connection-models', { documentId: ids.selected, modelId: 'search-multi' })
  assert.equal(multi.ports.filter(port => port.role === 'input').length, 2)
  assert.equal(multi.ports[0].node.nodeId, multi.ports[2].node.nodeId)
  assert.notEqual(multi.ports[0].timeState, multi.ports[2].timeState)
  const conflicts = await post('connection-models', { documentId: ids.selected, query: 'CONFLICTBRANCHCASE' })
  assert.deepEqual(conflicts.items.map(item => item.nodeId), ['search-conflict-a', 'search-conflict-b'])
  assert.notEqual((await post('connection-models', { documentId: ids.selected, modelId: 'search-conflict-a' })).structure.branches[0].mapping.text,
    (await post('connection-models', { documentId: ids.selected, modelId: 'search-conflict-b' })).structure.branches[0].mapping.text)

  harness.store.db.exec('PRAGMA journal_mode=WAL')
  writer = await openSqliteStore(harness.database)
  const revised = documentBrowseIdentityFixture(ids.selected, 'REVISEDDOCUMENT', '选中的长标识文档 · 新版本')
  for (const [name, original] of [['getDocument', getDocument], ['getDocumentWindow', getWindow]]) {
    SqliteKnowledgeStore.prototype[name] = function (id, ...args) {
      if (armed !== name || id !== ids.selected || this.filename !== harness.database) return original.call(this, id, ...args)
      armed = ''
      const prepare = this.db.prepare
      const readerDb = this.db
      let fired = false
      this.db.prepare = function (sql) {
        const statement = prepare.call(this, sql)
        if (sql === 'SELECT * FROM documents WHERE document_id = ?') {
          const get = statement.get
          statement.get = function (...params) {
            const row = get.apply(this, params)
            if (!fired) {
              fired = true
              inReadTransaction = readerDb.isTransaction
              writer.saveGraph(revised.graph, { sourceText: revised.sourceText, sourceUnits: revised.sourceUnits,
                expectedRevision: row.graph_revision })
              interleavings++
            }
            return row
          }
        }
        return statement
      }
      try { const value = original.call(this, id, ...args); assert(fired); return value }
      finally { this.db.prepare = prepare }
    }
  }
  // One genuine writer commit during a history window read, followed by a
  // model read fence. Other detailed snapshot boundaries remain in their tests.
  const baseline = await post('document-load', { documentId: ids.selected })
  armed = 'getDocumentWindow'
  const raced = await post('document-load', { documentId: ids.selected })
  assert.deepEqual(raced, baseline)
  assert.equal(interleavings, 1)
  assert.equal(inReadTransaction, true)
  assert.equal((await post('connection-models', { documentId: ids.selected })).error.code, 'revision_conflict')
  const current = await post('document-load', { documentId: ids.selected })
  assert.equal(current.documentId, ids.selected)
  assert.equal(current.revision, 2)
  assert.equal(current.graph.source.title, revised.graph.source.title)
  assert.equal(current.sourceText, revised.sourceText)
  assert.equal((await post('connection-models', { documentId: ids.selected, expectedRevision: 2, query: 'REVISEDDOCUMENT' })).items[0].nodeId, 'search-condition')
  assert.equal(hash(harness.store.getCanonicalDocument(ids.alias)), before.get(ids.alias))
  assert.equal(hash(harness.store.getCanonicalDocument(ids.peer)), before.get(ids.peer))
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
  console.log(JSON.stringify({ ok: true, actualHostHttp: true, exactReadCases: readCases, documentIdentities: fixtures.size,
    noPrefixOrWhitespaceAlias: true, normalizedIdentitiesDistinct: true, boundedAt4096: true,
    rejectedWrites, providerCalls, canonicalSnapshotsUnchangedByRejectedWrites: true,
    semanticCounterexampleModels: roles.total, interleavings, inReadTransaction, noLearningWrites: true }))
} finally {
  SqliteKnowledgeStore.prototype.getDocument = getDocument
  SqliteKnowledgeStore.prototype.getDocumentWindow = getWindow
  if (previousHarness === undefined) delete globalThis.harness
  else globalThis.harness = previousHarness
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  writer?.close()
  harness.stop()
}
