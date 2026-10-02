import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { neighborhoodReadFixture, neighborhoodReadCases } from './kg-neighborhood-read-fixture-data.mjs'

const fixture = neighborhoodReadFixture(), revised = structuredClone(fixture)
revised.graph.nodes.find(node => node.id === 'distance').text = 'Revised input: a different trip'
revised.graph.nodes.push({ id: 'new-neighbor', type: 'concept', text: 'A newly recorded condition', paragraph: 0 })
revised.graph.edges.push({ fromNodeId: 'taxi', toNodeId: 'new-neighbor', relation: 'supports' })
const harness = await modelLearningHarness({ fixture })
const { store, database, document, handler } = harness
store.db.exec('PRAGMA journal_mode=WAL')
const writer = await openSqliteStore(database), original = SqliteKnowledgeStore.prototype.getGraphNeighborhood
const server = createServer(handler), states = []
let armed = null, interleavings = 0, httpReads = 0
const head = sql => sql === 'SELECT graph_revision FROM documents WHERE document_id = ?'
const currentRevision = () => writer.getDocument(document.documentId)?.revision ?? 0
const save = value => writer.saveGraph(value.graph, { sourceText: value.sourceText, sourceUnits: value.sourceUnits,
  expectedRevision: currentRevision() })
function interleave(reader, read, boundary, commit = () => save(revised)) {
  const prepare = reader.db.prepare
  let fired = false
  reader.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (!fired && boundary(sql)) for (const method of ['get', 'all']) {
      const execute = statement[method]
      statement[method] = function (...args) {
        const result = execute.apply(this, args)
        if (!fired) { fired = true; states.push(reader.db.isTransaction); commit(); interleavings++ }
        return result
      }
    }
    return statement
  }
  try { const result = read(); assert(fired, 'The independent writer must commit at the selected SQL boundary'); return result }
  finally { reader.db.prepare = prepare }
}
SqliteKnowledgeStore.prototype.getGraphNeighborhood = function (...args) {
  if (!armed || this.filename !== database) return original.apply(this, args)
  const boundary = armed; armed = null
  return interleave(this, () => original.apply(this, args), boundary)
}
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const post = async args => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/graph-neighborhood', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: document.documentId, expectedRevision: currentRevision(), centerId: 'taxi', ...args }) })
    assert.equal(response.status, 200); httpReads++
    return response.json()
  }
  const queries = [{}, { direction: 'in' }, { direction: 'out' }, { relation: 'analogy', limit: 3, offset: 3 },
    { hops: 3, limit: 3 }, { direction: 'out', hops: 5, relation: 'maps_between' },
    { relation: 'nonexistent' }, { centerId: 'absent' }, { limit: 201 }]
  for (const query of queries) {
    const revision = currentRevision(), args = { ...query, expectedRevision: revision }
    const baseline = await post(args)
    armed = head
    assert.deepEqual(await post(args), baseline, 'The entire HTTP response must remain in its original snapshot')
    assert.equal(currentRevision(), revision + 1)
    assert.equal((await post({ expectedRevision: revision })).error.code, 'revision_conflict', 'A later valid request must still reject an old version')
    save(document)
  }
  const boundaries = [
    ['document version', head],
    ['center hydration', sql => sql === 'SELECT * FROM graph_nodes WHERE document_id = ? AND node_id = ?'],
    ['frontier traversal', sql => sql.startsWith('SELECT from_node_id, to_node_id, relation FROM graph_edges')],
    ['neighbor ordering', sql => sql.startsWith('SELECT node_id, paragraph FROM graph_nodes')],
    ['page hydration', sql => sql.startsWith('SELECT * FROM graph_nodes WHERE document_id = ?\n')],
    ['induced edges', sql => sql.startsWith('SELECT * FROM graph_edges WHERE document_id = ?\n')],
  ]
  for (const [name, boundary] of boundaries) {
    const args = { centerId: 'taxi', expectedRevision: currentRevision(), hops: 3, limit: 3, offset: 3 }
    const read = () => store.getGraphNeighborhood(document.documentId, args), baseline = read()
    assert(!baseline.error)
    assert.deepEqual(interleave(store, read, boundary), baseline, name + ' must not mix revisions')
    assert.equal(store.db.isTransaction, false); assert.equal(read().error.code, 'revision_conflict')
    save(document)
  }
  assert(states.every(Boolean))
  const snapshot = store.getCanonicalDocument(document.documentId)
  const args = { centerId: 'taxi', expectedRevision: snapshot.revision, relation: 'analogy', limit: 3 }
  const collected = new Map(), edges = new Set()
  let offset = 0
  do {
    const page = await post({ ...args, offset })
    assert(!page.error); assert(page.nodes.length <= 4)
    for (const node of page.nodes) collected.set(node.id, node)
    for (const edge of page.edges) {
      const key = JSON.stringify([edge.fromNodeId, edge.toNodeId, edge.relation])
      assert(!edges.has(key), 'Induced edges may only be delivered once'); edges.add(key)
    }
    offset = page.nextOffset
    if (!page.hasMore) break
  } while (true)
  for (const id of neighborhoodReadCases) {
    const canonical = snapshot.graph.nodes.find(node => node.id === 'search-' + id)
    assert.deepEqual(collected.get(canonical.id).modelStructure, canonical.modelStructure)
  }
  const slots = collected.get('search-multi').modelStructure.slots
  assert.notEqual(slots[0].id, slots[2].id); assert.equal(slots[0].conceptId, slots[2].conceptId)
  const conflicts = await post({ relation: 'contradicts', direction: 'in' })
  assert(conflicts.nodes.some(node => node.id === 'search-conflict-a')); assert(conflicts.nodes.some(node => node.id === 'search-conflict-b'))
  assert.notEqual(conflicts.nodes.find(node => node.id === 'search-conflict-a').modelStructure.branches[0].mapping.text,
    conflicts.nodes.find(node => node.id === 'search-conflict-b').modelStructure.branches[0].mapping.text)
  assert.deepEqual(store.getCanonicalDocument(document.documentId), snapshot, 'Plain reads are nonmutating')
  const aliases = [document.documentId, ' ' + document.documentId + ' ', document.documentId + ':actual-document',
    'A:' + 'namespace'.repeat(50), 'Ａ:' + 'namespace'.repeat(50), 'bounded:'.padEnd(4096, 'x')]
  for (const [index, id] of aliases.entries()) {
    if (id !== document.documentId) {
      const value = neighborhoodReadFixture(id)
      for (let version = 0; version <= index; version++) writer.saveGraph(value.graph, { sourceText: value.sourceText, sourceUnits: value.sourceUnits })
    }
    const revision = writer.getDocument(id).revision, result = await post({ documentId: id, expectedRevision: revision })
    assert(!result.error); assert.equal(result.documentId, id); assert.equal(result.revision, revision)
    assert.equal((await post({ documentId: id, expectedRevision: revision + 1 })).error.code, 'revision_conflict')
  }
  assert.equal((await post({ documentId: 'missing' })).error.code, 'not_found')
  assert.equal((await post({ documentId: 'x'.repeat(4097) })).error.code, 'invalid_input')
  const revision = currentRevision(), read = () => store.getGraphNeighborhood(document.documentId, { centerId: 'taxi', expectedRevision: revision })
  const beforeDelete = read()
  assert.deepEqual(interleave(store, read, head, () => writer.db.prepare('DELETE FROM documents WHERE document_id = ?').run(document.documentId)), beforeDelete)
  assert.equal(read(), null); assert.equal((await post({ expectedRevision: revision })).error.code, 'not_found')
  save(document)
  const nestedRead = () => store.getGraphNeighborhood(document.documentId, { centerId: 'taxi', expectedRevision: currentRevision() })
  const beforeNested = nestedRead()
  store.db.exec('SAVEPOINT kg_document_read')
  store.db.prepare('UPDATE graph_nodes SET text = ? WHERE document_id = ? AND node_id = ?').run('Caller-owned pending edit', document.documentId, 'taxi')
  assert.equal(nestedRead().nodes[0].text, 'Caller-owned pending edit'); assert.equal(store.db.isTransaction, true)
  store.db.exec('ROLLBACK TO SAVEPOINT kg_document_read'); store.db.exec('RELEASE SAVEPOINT kg_document_read')
  assert.deepEqual(nestedRead(), beforeNested)
  const prepare = store.db.prepare
  store.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (sql.startsWith('SELECT * FROM graph_edges WHERE document_id = ?\n')) statement.all = () => { throw new Error('Isolated neighborhood hydration failure') }
    return statement
  }
  try {
    assert.throws(nestedRead, /Isolated neighborhood hydration failure/); assert.equal(store.db.isTransaction, false)
    store.db.exec('BEGIN IMMEDIATE')
    store.db.prepare('UPDATE documents SET title = ? WHERE document_id = ?').run('Preserved pending title', document.documentId)
    assert.throws(nestedRead, /Isolated neighborhood hydration failure/); assert.equal(store.db.isTransaction, true)
    assert.equal(store.db.prepare('SELECT title FROM documents WHERE document_id = ?').get(document.documentId).title, 'Preserved pending title')
  } finally { if (store.db.isTransaction) store.db.exec('ROLLBACK'); store.db.prepare = prepare }
  assert.deepEqual(nestedRead(), beforeNested)
  const directory = mkdtempSync(join(tmpdir(), 'kg-neighborhood-rollback-'))
  const rollbackReader = await openSqliteStore(join(directory, 'graph.sqlite')), rollbackWriter = await openSqliteStore(rollbackReader.filename)
  try {
    rollbackReader.saveGraph(document.graph, { sourceText: document.sourceText, sourceUnits: document.sourceUnits })
    const query = { centerId: 'taxi', expectedRevision: 1 }, baseline = rollbackReader.getGraphNeighborhood(document.documentId, query)
    assert.equal(rollbackReader.db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete')
    const result = interleave(rollbackReader, () => rollbackReader.getGraphNeighborhood(document.documentId, query), head, () => {
      assert.throws(() => rollbackWriter.saveGraph(revised.graph, { sourceText: revised.sourceText, sourceUnits: revised.sourceUnits, expectedRevision: 1 }), /database is locked/)
      assert.equal(rollbackWriter.db.isTransaction, false)
    })
    assert.deepEqual(result, baseline)
    rollbackWriter.saveGraph(revised.graph, { sourceText: revised.sourceText, sourceUnits: revised.sourceUnits, expectedRevision: 1 })
    assert.equal(rollbackReader.getGraphNeighborhood(document.documentId, query).error.code, 'revision_conflict')
  } finally { rollbackWriter.close(); rollbackReader.close(); rmSync(directory, { recursive: true, force: true }) }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
  assert(states.every(Boolean)); assert.equal(store.db.isTransaction, false)
  console.log(JSON.stringify({ ok: true, actualHostHttp: true, independentSqliteWriter: true, httpReads, interleavings,
    sqlBoundaries: boundaries.length, exactIdentities: aliases.length, semanticRecordCounterexamples: neighborhoodReadCases.length,
    coherentDeletion: true, paginationNonmutating: true, laterOldVersionRejected: true, nestedCallerPreserved: true,
    readFailureReleased: true, rollbackJournalProtected: true, noLearningWrites: true }))
} finally {
  SqliteKnowledgeStore.prototype.getGraphNeighborhood = original
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  writer.close(); harness.stop()
}
