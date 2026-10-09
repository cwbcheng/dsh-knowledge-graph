import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../lib/kg-store.mjs'
import { diagnosticFixture } from './kg-document-window-diagnostics-benchmark.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-window-totals-'))
const database = join(directory, 'graph.sqlite')
const writer = await openSqliteStore(database)
writer.db.exec('PRAGMA journal_mode = WAL')
const reader = await openSqliteStore(database)
const supported = reader.db.isTransaction === false
let reads = 0, interleavings = 0, inspections = 0
const inspect = graph => { inspections++; return { nodes: graph.nodes.length, edges: graph.edges.length } }
const make = (id, size) => {
  const fixture = diagnosticFixture(size)
  fixture.documentId = fixture.graph.source.id = fixture.graph.source.documentId = id
  for (const node of fixture.graph.nodes) for (const evidence of node.evidence) evidence.documentId = evidence.sourceId = id
  return fixture
}
const small = make('totals-document', 128)
const second = make('totals-second', 40)
const save = (connection, fixture) => connection.saveGraph(fixture.graph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
const canonical = (id = small.documentId) => writer.getDocument(id)
const totalSql = sql => /^SELECT COUNT\(\*\) AS count FROM graph_(nodes|edges) WHERE document_id = \?$/.test(sql)
function read({ id = small.documentId, options = { limit: 20, includeSourceText: false }, inspector = inspect,
  expected = canonical(id), cached = false, forceCounts = false, boundary, mutate } = {}) {
  const prepare = reader.db.prepare
  let counts = 0, fired = false
  reader.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    for (const method of ['get', 'all']) {
      const execute = statement[method]
      statement[method] = function (...params) {
        const value = execute.apply(this, params)
        if (totalSql(sql)) counts++
        if (boundary?.(sql) && !fired) {
          fired = true
          assert(reader.db.isTransaction === undefined || reader.db.isTransaction === true)
          mutate()
          interleavings++
        }
        return value
      }
    }
    return statement
  }
  let actual
  try { actual = reader.getDocumentWindow(id, options, inspector) } finally { reader.db.prepare = prepare }
  if (boundary) assert(fired, 'The independent write must reach the intended SQLite boundary')
  if (expected === null) { assert.equal(actual, null); assert.equal(counts, 0) }
  else {
    assert.equal(actual.view.totalNodes, expected.nodes.length)
    assert.equal(actual.view.totalEdges, expected.edges.length)
    assert.equal(actual.view.truncated, expected.nodes.length > actual.nodes.length || expected.edges.length > actual.edges.length)
    assert.equal(actual.revision, expected.revision)
    assert.deepEqual(actual.source, expected.source)
    assert.equal(actual.sourceText, options.includeSourceText === false ? '' : expected.sourceText)
    if (inspector) {
      assert.equal(actual.graphStructureQuality.nodes, expected.nodes.length)
      assert.equal(actual.graphStructureQuality.edges, expected.edges.length)
    }
    assert.equal(counts, supported && cached && !forceCounts ? 0 : 2, 'Only a valid, independent diagnostic snapshot may skip both full counts')
  }
  reads++
  return actual
}
const deleteEdge = () => assert.equal(writer.db.prepare(
  'DELETE FROM graph_edges WHERE edge_key = (SELECT edge_key FROM graph_edges WHERE document_id = ? ORDER BY edge_key LIMIT 1)'
).run(small.documentId).changes, 1)

try {
  save(writer, small)
  save(writer, second)
  const first = read()
  first.view.totalNodes = first.view.totalEdges = -1
  first.graphStructureQuality.nodes = -1
  first.nodes[0].text = 'Caller-owned mutation'
  const initialInspections = inspections
  for (const options of [
    { limit: 20, offset: 20 }, { limit: 20, offset: 10000, includeSourceText: false },
    { limit: 40, query: 'observation 127.', includeSourceText: false },
    { limit: 2000, query: 'absent_%', includeSourceText: false }, { limit: 2000 },
  ]) read({ options, cached: true })
  if (supported) assert.equal(inspections, initialInspections)
  read({ inspector: null })
  read({ inspector: null })
  read({ cached: true })
  const otherInspector = graph => inspect(graph)
  read({ inspector: otherInspector })
  read({ inspector: otherInspector, cached: true })
  read()
  read({ cached: true })

  // Any local or independent write invalidates the stamps, even at the same revision.
  for (const connection of [writer, reader]) for (const change of [
    () => connection.db.prepare('DELETE FROM graph_edges WHERE edge_key = (SELECT edge_key FROM graph_edges WHERE document_id = ? LIMIT 1)').run(small.documentId),
    () => connection.db.prepare('DELETE FROM graph_nodes WHERE document_id = ? AND node_id = ?').run(small.documentId, 'n127'),
    () => connection.db.prepare('UPDATE documents SET title = title || ? WHERE document_id = ?').run(' updated', small.documentId),
    () => connection.db.prepare('UPDATE documents SET graph_revision = graph_revision + 1 WHERE document_id = ?').run(small.documentId),
    () => save(connection, small),
    () => connection.db.prepare('UPDATE documents SET title = title || ? WHERE document_id = ?').run(' unrelated', second.documentId),
  ]) {
    change()
    read()
    read({ cached: true })
  }

  // A commit after the snapshot is pinned cannot alter either cached count mid-read.
  const warmBoundaries = [
    ...(supported ? [sql => sql === 'PRAGMA data_version', sql => sql.startsWith('SELECT total_changes()')] : []),
    sql => sql.startsWith('SELECT document_id, source_id'),
    sql => sql.startsWith('SELECT * FROM graph_nodes') && /LIMIT/.test(sql),
    sql => sql.startsWith('SELECT * FROM graph_edges') && /LIMIT/.test(sql),
    sql => sql.startsWith('SELECT * FROM chunks'),
  ]
  for (const boundary of warmBoundaries) {
    read({ cached: true })
    read({ cached: true, boundary, mutate: deleteEdge })
    read()
    read({ cached: true })
  }
  for (const table of ['nodes', 'edges']) {
    const coldInspector = graph => inspect(graph)
    read({ inspector: coldInspector, boundary: sql => sql === 'SELECT COUNT(*) AS count FROM graph_' + table + ' WHERE document_id = ?', mutate: deleteEdge })
    read({ inspector: coldInspector })
    read({ inspector: coldInspector, cached: true })
  }

  read()
  const historical = canonical()
  reader.db.exec('BEGIN')
  reader.db.prepare('SELECT document_id FROM documents WHERE document_id = ?').get(small.documentId)
  deleteEdge()
  read({ expected: historical, forceCounts: true })
  read({ expected: historical, forceCounts: true })
  reader.db.exec('ROLLBACK')
  read()
  read({ cached: true })
  const committed = canonical()
  reader.db.exec('BEGIN')
  reader.db.prepare('DELETE FROM graph_edges WHERE document_id = ?').run(small.documentId)
  read({ expected: { ...committed, edges: [] }, forceCounts: true })
  read({ expected: { ...committed, edges: [] }, forceCounts: true })
  reader.db.exec('ROLLBACK')
  read()
  read({ cached: true })
  reader.db.exec('BEGIN')
  reader.db.prepare('DELETE FROM graph_edges WHERE document_id = ?').run(small.documentId)
  read({ expected: { ...committed, edges: [] }, forceCounts: true })
  reader.db.exec('COMMIT')
  read()
  read({ cached: true })

  // Recreate at revision 1: revision alone is never a safe count cache key.
  for (const connection of [writer, reader]) {
    connection.db.prepare('DELETE FROM documents WHERE document_id = ?').run(small.documentId)
    read({ expected: null })
    save(connection, make(small.documentId, 64))
    assert.equal(read().revision, 1)
    read({ cached: true })
    connection.db.prepare('DELETE FROM documents WHERE document_id = ?').run(small.documentId)
    save(connection, small)
    assert.equal(read().view.totalNodes, 128)
    read({ cached: true })
  }
  read({ id: second.documentId })
  read({ id: second.documentId, cached: true })
  read()
  read({ cached: true })
  const nonCloneable = graph => ({ ...inspect(graph), callback() {} })
  read({ inspector: nonCloneable })
  read({ inspector: nonCloneable })
  read()
  const runtime = reader.db
  reader.db = { prepare: runtime.prepare.bind(runtime), exec: runtime.exec.bind(runtime) }
  try { read({ forceCounts: true }); read({ forceCounts: true }) } finally { reader.db = runtime }
  read({ cached: true })
  const failingInspector = () => { throw new Error('totals inspector failure') }
  assert.throws(() => reader.getDocumentWindow(small.documentId, { limit: 20 }, failingInspector), /totals inspector failure/)
  read()
  read({ cached: true })
  const execute = reader.db.exec
  let failedRelease = false
  reader.db.exec = function (sql) {
    if (!failedRelease && sql === 'RELEASE SAVEPOINT kg_document_read') {
      failedRelease = true
      throw new Error('totals release failure')
    }
    return execute.call(this, sql)
  }
  try { assert.throws(() => reader.getDocumentWindow(small.documentId, { limit: 20 }, inspect), /totals release failure/) }
  finally { reader.db.exec = execute }
  read()
  read({ cached: true })
  const empty = make('totals-empty', 40)
  empty.graph.nodes = []
  empty.graph.edges = []
  save(writer, empty)
  read({ id: empty.documentId, options: { limit: 20, offset: 999 } })
  read({ id: empty.documentId, cached: true })
  console.log(JSON.stringify({ ok: true, reads, interleavings, inspections, cacheSupported: supported,
    completeTotalsAndDiagnosticsIdentical: true, detachedResults: true, localAndIndependentInvalidation: true,
    historicalAndRollbackSafe: true, missingTransactionFlagFallback: true, singleDocumentRetained: true }))
} finally {
  reader.close()
  writer.close()
  rmSync(directory, { recursive: true, force: true })
}
