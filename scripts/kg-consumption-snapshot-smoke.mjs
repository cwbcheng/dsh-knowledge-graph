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
for (let i = 0; i < 610; i++) fixture.graph.nodes.push({ ...structuredClone(fixture.graph.nodes[0]),
  id: 'lexical-' + String(i).padStart(3, '0'), paragraph: 7, quote: fixture.sourceUnits[7].text,
  evidence: [{ documentId: fixture.documentId, sourceId: fixture.graph.source.id, paragraph: 7, quote: fixture.sourceUnits[7].text }],
  text: i === 609 ? '共有词 页尾目标' : '共有词 普通候选 ' + i })
for (let i = 8; i < 618; i++) fixture.sourceUnits.push({ paragraph: i, text: '原文独有 普通材料 ' + i })
fixture.sourceUnits[617].text = '原文独有 页尾资料'
fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
const replaceText = value => {
  if (Array.isArray(value)) return value.map(replaceText)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceText(item)]))
  return typeof value === 'string' ? value.replace(/10 元/g, '11 元').replace(/页尾资料/g, '已更新材料') : value
}
const revised = replaceText(fixture)
revised.graph.nodes = revised.graph.nodes.filter(node => node.id !== 'lexical-609')
revised.graph.nodes.push({ ...structuredClone(revised.graph.nodes[0]), id: 'same-name-other-identity' })
revised.graph.edges.push({ fromNodeId: 'unknown', toNodeId: 'same-name-other-identity', relation: 'maps_between' })
const harness = await modelLearningHarness({ fixture })
const { store, database, document, handler } = harness
store.db.exec('PRAGMA journal_mode = WAL')
const writer = await openSqliteStore(database)
const originalQuery = SqliteKnowledgeStore.prototype.queryDocumentGraph
const server = createServer((req, res) => handler(req, res))
let armed = null, interleavings = 0
const transactions = []
const save = value => writer.saveGraph(value.graph, { sourceText: value.sourceText, sourceUnits: value.sourceUnits,
  expectedRevision: writer.getDocumentRevision(document.documentId) })

function interleave(reader, read, boundary, mutate = () => save(revised)) {
  const prepare = reader.db.prepare
  let fired = false
  reader.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (boundary(sql)) for (const name of ['get', 'all']) {
      const execute = statement[name]
      statement[name] = function (...args) {
        const value = execute.apply(this, args)
        if (!fired) {
          fired = true
          transactions.push(reader.db.isTransaction)
          mutate()
          interleavings++
        }
        return value
      }
    }
    return statement
  }
  try { const result = read(); assert(fired, 'The independent writer boundary was not exercised'); return result }
  finally { reader.db.prepare = prepare }
}
SqliteKnowledgeStore.prototype.queryDocumentGraph = function (...args) {
  if (!armed || this.filename !== database) return originalQuery.apply(this, args)
  const boundary = armed
  armed = null
  return interleave(this, () => originalQuery.apply(this, args), boundary)
}

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = 'http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/graph-query'
  const post = async args => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: document.documentId, ...args }) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const nodeRows = sql => sql.startsWith('SELECT * FROM graph_nodes')
  const head = sql => sql === 'SELECT * FROM documents WHERE document_id = ?'
  const requests = [
    [{ nodeIds: ['taxi'], hops: 0, limit: 1 }, nodeRows],
    [{ query: '共有词 页尾目标', limit: 1, hops: 0 }, nodeRows],
    [{ relations: ['maps_between'], direction: 'out', hops: 1 }, head],
    [{ query: '行驶距离', types: ['concept'], groundingStatuses: ['candidate'], hops: 1 }, head],
    [{ query: 'no-such-node', hops: 2 }, head],
  ]
  for (const [args, boundary] of requests) {
    const revision = writer.getDocumentRevision(document.documentId)
    const baseline = await post({ ...args, expectedRevision: revision })
    assert(!baseline.error, JSON.stringify({ args, error: baseline.error }))
    if (args.query === '共有词 页尾目标') assert.equal(baseline.matches[0].nodeId, 'lexical-609')
    armed = boundary
    const raced = await post({ ...args, expectedRevision: revision })
    assert.deepEqual(raced, baseline, 'graph-query cannot attach a new source unit, ranking or identity to the old revision/queryId')
    assert.equal((await post({ ...args, expectedRevision: revision })).error.code, 'revision_conflict')
    const current = await post({ ...args, expectedRevision: revision + 1 })
    assert(!current.error)
    assert.equal(current.revision, revision + 1)
    assert.notEqual(current.queryId, baseline.queryId)
    if (args.nodeIds) assert(current.sourceUnits[0].text.includes('11 元'))
    if (args.query === '共有词 页尾目标') assert(!current.matches.some(match => match.nodeId === 'lexical-609'))
    if (args.relations) {
      const original = current.graph.nodes.find(node => node.id === 'distance')
      const sameName = current.graph.nodes.find(node => node.id === 'same-name-other-identity')
      assert(original && sameName)
      assert.equal(original.text, sameName.text)
      assert(!baseline.graph.nodes.some(node => node.id === sameName.id))
      assert(current.graph.edges.some(edge => edge.fromNodeId === 'unknown' && edge.toNodeId === sameName.id && edge.relation === 'maps_between'))
    }
    save(document)
  }
  const beforeDelete = store.queryDocumentGraph(document.documentId, { nodeIds: ['taxi'], hops: 1 })
  assert.deepEqual(interleave(store, () => store.queryDocumentGraph(document.documentId, { nodeIds: ['taxi'], hops: 1 }), head, () => {
    writer.db.exec('BEGIN IMMEDIATE')
    try { writer.db.prepare('DELETE FROM documents WHERE document_id = ?').run(document.documentId); writer.db.exec('COMMIT') }
    catch (error) { writer.db.exec('ROLLBACK'); throw error }
  }), beforeDelete, 'Deleting during retrieval cannot fabricate an empty old-version graph')
  assert.equal(store.queryDocumentGraph(document.documentId, { nodeIds: ['taxi'] }), null)
  save(document)

  const cases = [
    ['metadata', { nodeIds: ['taxi'], hops: 1 }, head],
    ['relation seeds', { relations: ['maps_between'], hops: 1 }, sql => sql.startsWith('SELECT from_node_id, to_node_id FROM graph_edges')],
    ['lexical page boundary', { query: '共有词 页尾目标', limit: 1, hops: 0 }, nodeRows],
    ['source hydration', { nodeIds: ['taxi'], hops: 0 }, sql => sql.startsWith('SELECT paragraph, text FROM document_units')],
    ['source-only keyset pages', { query: '原文独有 页尾资料', hops: 0, includeSourceFallback: true }, sql => sql.includes('FROM document_units WHERE') && sql.includes('paragraph > ?')],
    ['unknown match', { query: 'no-such-node', hops: 0 }, head],
  ]
  for (const [label, options, boundary] of cases) {
    const read = () => store.queryDocumentGraph(document.documentId, { ...options, expectedRevision: writer.getDocumentRevision(document.documentId) })
    const baseline = read()
    if (options.includeSourceFallback) assert(baseline.sourceUnits.some(unit => unit.paragraph === 617 && unit.sourceFallback))
    assert.deepEqual(interleave(store, read, boundary), baseline, label + ' mixed the evidence snapshot')
    assert.equal(store.db.isTransaction, false)
    save(document)
  }
  assert(transactions.every(Boolean))
  assert.equal(store.queryDocumentGraph('missing', { query: 'unknown' }), null)
  assert.equal(store.db.isTransaction, false)
  assert.throws(() => store.queryDocumentGraph(document.documentId, { query: '行驶距离', expectedRevision: 0 }), { code: 'revision_conflict' })
  assert.equal(store.db.isTransaction, false)
  const baseline = store.getCanonicalDocument(document.documentId)
  store.db.exec('SAVEPOINT kg_document_read')
  const prepare = store.db.prepare
  try {
    store.db.prepare('UPDATE documents SET title = ? WHERE document_id = ?').run('Caller change', document.documentId)
    assert(store.queryDocumentGraph(document.documentId, { nodeIds: ['taxi'] }))
    assert.equal(store.db.isTransaction, true)
    store.db.prepare = function (sql) {
      const statement = prepare.call(this, sql)
      if (sql.startsWith('SELECT paragraph, text FROM document_units')) statement.all = () => { throw new Error('Isolated source hydration failure') }
      return statement
    }
    assert.throws(() => store.queryDocumentGraph(document.documentId, { nodeIds: ['taxi'] }), /Isolated source hydration failure/)
    assert.equal(store.db.isTransaction, true)
    assert.equal(store.db.prepare('SELECT title FROM documents WHERE document_id = ?').get(document.documentId).title, 'Caller change')
  } finally {
    store.db.prepare = prepare
    store.db.exec('ROLLBACK TO SAVEPOINT kg_document_read')
    store.db.exec('RELEASE SAVEPOINT kg_document_read')
  }
  assert.deepEqual(store.getCanonicalDocument(document.documentId), baseline)

  const rollbackDirectory = mkdtempSync(join(tmpdir(), 'kg-consumption-rollback-'))
  const rollbackStore = await openSqliteStore(join(rollbackDirectory, 'graph.sqlite'))
  rollbackStore.saveGraph(document.graph, { sourceText: document.sourceText, sourceUnits: document.sourceUnits })
  const rollbackWriter = await openSqliteStore(rollbackStore.filename)
  try {
    assert.equal(rollbackStore.db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete')
    const options = { nodeIds: ['taxi'], expectedRevision: 1 }
    const rollbackBaseline = rollbackStore.queryDocumentGraph(document.documentId, options)
    const result = interleave(rollbackStore, () => rollbackStore.queryDocumentGraph(document.documentId, options), head, () => {
      assert.throws(() => rollbackWriter.saveGraph(revised.graph, { sourceText: revised.sourceText,
        sourceUnits: revised.sourceUnits, expectedRevision: 1 }), /database is locked/)
      assert.equal(rollbackWriter.db.isTransaction, false, 'A blocked writer must roll back its entire commit')
    })
    assert.deepEqual(result, rollbackBaseline)
    assert.deepEqual(rollbackWriter.queryDocumentGraph(document.documentId, options), rollbackBaseline)
    assert.equal(rollbackStore.db.isTransaction, false)
    rollbackWriter.saveGraph(revised.graph, { sourceText: revised.sourceText, sourceUnits: revised.sourceUnits, expectedRevision: 1 })
    const current = rollbackStore.queryDocumentGraph(document.documentId, { ...options, expectedRevision: 2 })
    assert.equal(current.revision, 2)
    assert(current.sourceUnits[0].text.includes('11 元'))
  } finally {
    rollbackWriter.close()
    rollbackStore.close()
    rmSync(rollbackDirectory, { recursive: true, force: true })
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
  assert(transactions.every(Boolean))
  console.log(JSON.stringify({ ok: true, actualHostHttp: true, independentSqliteWriter: true, httpCases: requests.length,
    sqlBoundaryCases: cases.length, interleavings, lexicalAndSourceKeysetPages: true, graphAndSourceSnapshot: true,
    oldRevisionRejected: true, queryIdRevisionBound: true, sameNameIdentityPreserved: true, deletionSnapshotCoherent: true,
    rollbackJournalProtected: true, callerPreservedOnReadFailure: true, noLearningWrites: true }))
} finally {
  SqliteKnowledgeStore.prototype.queryDocumentGraph = originalQuery
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  writer.close()
  harness.stop()
}
