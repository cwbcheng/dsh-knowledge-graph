import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore, SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import { createGenerationStructureTools } from '../src/kg-generation-structure.mjs'
import { diagnosticFixture, countHydration, startDiagnosticHost } from './kg-document-window-diagnostics-benchmark.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-window-diagnostics-'))
const database = join(directory, 'graph.sqlite')
const writer = await openSqliteStore(database)
writer.db.exec('PRAGMA journal_mode = WAL')
const large = diagnosticFixture()
writer.saveGraph(large.graph, { sourceText: large.sourceText, sourceUnits: large.sourceUnits })
const tools = createGenerationStructureTools()
const before = writer.getCanonicalDocument(large.documentId)
const host = await startDiagnosticHost(database, await import('../lib/index.js'))
const meter = countHydration(SqliteKnowledgeStore, database)
let reader, inspections = 0, interleavings = 0
const inspect = graph => { inspections++; return tools.inspect(graph) }

try {
  const expected = tools.inspect(before.graph)
  const opened = await host.post({ documentId: large.documentId, nodeLimit: 800 })
  assert.deepEqual(opened.graph.graphStructureQuality, expected)
  assert.equal(meter.counts.fullNodeReads, 1)
  assert.equal(meter.counts.fullEdgeReads, 1)
  meter.reset()
  for (const args of [{ nodeOffset: 800 }, { nodeOffset: 11200 }, { query: 'observation 11999.' }, { query: 'not-in-this-document' }]) {
    const response = await host.post({ documentId: large.documentId, nodeLimit: 800, includeSourceText: false, ...args })
    assert.equal(response.revision, 1)
    assert.equal(response.sourceText, '')
    assert.equal(response.graph.view.totalNodes, 12000)
    assert(response.graph.nodes.length <= 800)
    assert.deepEqual(response.graph.graphStructureQuality, expected, 'Diagnostics describe the canonical graph, including empty query windows')
  }
  assert.equal(meter.counts.fullNodeReads, 0)
  assert.equal(meter.counts.fullEdgeReads, 0)
  const warmHttp = { ...meter.counts }
  assert.deepEqual(writer.getCanonicalDocument(large.documentId), before)
  assert.equal(writer.listRevisions(large.documentId).length, 1)
  assert.equal(writer.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
  // Keep invalidation/interleaving cases small; all use real independent WAL connections.
  const small = diagnosticFixture(96)
  writer.db.prepare('DELETE FROM documents WHERE document_id = ?').run(small.documentId)
  const save = (store, fixture) => store.saveGraph(fixture.graph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
  save(writer, small)
  reader = await openSqliteStore(database)
  const canonical = () => tools.inspect(writer.getDocument(small.documentId))
  const read = (fn = inspect, options = { limit: 20 }) => reader.getDocumentWindow(small.documentId, options, fn)
  const first = read()
  assert.equal(inspections, 1)
  first.graphStructureQuality.metrics.all.nodeCount = -1
  first.graphStructureQuality.checks.length = 0
  first.nodes[0].text = 'Caller-owned mutation'
  assert.deepEqual(read().graphStructureQuality, canonical())
  assert.equal(inspections, 1, 'Repeated callers receive detached diagnostics without inspection')
  read(inspect, { limit: 2000, includeSourceText: false, query: 'observation 95.' })
  assert.equal(inspections, 1, 'Limits, source omission and query projections share canonical diagnostics')
  const otherInspector = graph => ({ ...inspect(graph), inspectorTag: 'other' })
  assert.equal(read(otherInspector).graphStructureQuality.inspectorTag, 'other')
  const previousCount = inspections
  assert.equal(read().graphStructureQuality.inspectorTag, undefined)
  assert.equal(inspections, previousCount + 1, 'Inspector identity is part of the cache key')

  const changed = structuredClone(small)
  changed.graph.source.sections[0].title = '版本说明'
  changed.graph.generation.relationDiscovery = { status: 'complete', totalTargets: 96, searchedTargets: 96, remainingTargets: 0 }
  save(reader, changed)
  const local = read()
  assert.equal(local.revision, 2)
  assert.equal(local.graphStructureQuality.metrics.main.nodeCount, 0)
  assert.equal(local.graphStructureQuality.relationSearch.status, 'complete')
  assert.deepEqual(local.graphStructureQuality, canonical())
  read()
  const localCount = inspections
  save(writer, small)
  assert.equal(read().revision, 3)
  assert.deepEqual(read().graphStructureQuality, canonical())
  assert.equal(inspections, localCount + 1, 'Independent canonical writes invalidate the diagnostic')

  // Out-of-band source, graph metadata and node/edge writes must invalidate even without a revision bump.
  for (const connection of [reader, writer]) {
    const source = JSON.parse(connection.db.prepare('SELECT source_json FROM documents WHERE document_id = ?').get(small.documentId).source_json)
    source.sections[0].title = source.sections[0].title === '正文' ? '来源说明' : '正文'
    connection.db.prepare('UPDATE documents SET source_json = ? WHERE document_id = ?').run(JSON.stringify(source), small.documentId)
    const count = inspections
    assert.deepEqual(read().graphStructureQuality, canonical())
    assert.equal(inspections, count + 1)
    connection.db.prepare('UPDATE graph_nodes SET type = ? WHERE document_id = ? AND node_id = ?').run('image', small.documentId, 'n0')
    assert.deepEqual(read().graphStructureQuality, canonical())
    connection.db.prepare('UPDATE documents SET graph_meta_json = ? WHERE document_id = ?')
      .run(JSON.stringify({ generation: { relationDiscovery: { status: 'not_assessed' } }, graphOntology: { id: 'proposition-v1' } }), small.documentId)
    assert.deepEqual(read().graphStructureQuality, canonical())
  }

  // Reuse the exact document ID AND revision; revision-only memoization would return the old graph.
  writer.db.prepare('UPDATE documents SET graph_revision = 1 WHERE document_id = ?').run(small.documentId)
  read()
  writer.db.prepare('DELETE FROM documents WHERE document_id = ?').run(small.documentId)
  const replacement = diagnosticFixture(64)
  save(writer, replacement)
  const recreated = read()
  assert.equal(recreated.revision, 1)
  assert.equal(recreated.graphStructureQuality.metrics.all.nodeCount, 64)
  assert.deepEqual(recreated.graphStructureQuality, canonical())
  writer.db.prepare('DELETE FROM documents WHERE document_id = ?').run(small.documentId)
  assert.equal(read(), null)
  save(writer, small)
  assert.equal(read().graphStructureQuality.metrics.all.nodeCount, 96)
  reader.db.prepare('DELETE FROM documents WHERE document_id = ?').run(small.documentId)
  save(reader, replacement)
  assert.equal(read().revision, 1)
  assert.equal(read().graphStructureQuality.metrics.all.nodeCount, 64, 'Same-connection recreation also invalidates revision 1')
  reader.db.prepare('DELETE FROM documents WHERE document_id = ?').run(small.documentId)
  save(reader, small)
  assert.equal(read().graphStructureQuality.metrics.all.nodeCount, 96)

  const deleteEdge = () => {
    const result = writer.db.prepare('DELETE FROM graph_edges WHERE edge_key = (SELECT edge_key FROM graph_edges WHERE document_id = ? ORDER BY edge_key LIMIT 1)').run(small.documentId)
    assert.equal(result.changes, 1)
  }
  function interleave(match, readWindow) {
    const prior = canonical()
    const prepare = reader.db.prepare
    let fired = false
    reader.db.prepare = function (sql) {
      const statement = prepare.call(this, sql)
      if (match(sql)) for (const name of ['get', 'all']) {
        const execute = statement[name]
        statement[name] = function (...args) {
          const result = execute.apply(this, args)
          if (!fired) { fired = true; assert.equal(reader.db.isTransaction, true); deleteEdge(); interleavings++ }
          return result
        }
      }
      return statement
    }
    let result
    try { result = readWindow() } finally { reader.db.prepare = prepare }
    assert(fired, 'Independent write must execute at the selected SQL boundary')
    assert.deepEqual(result.graphStructureQuality, prior, 'Window and diagnostic remain on the old coherent snapshot')
    assert.deepEqual(readWindow().graphStructureQuality, canonical(), 'Next read must refresh even at the same document revision')
  }
  const boundaries = [sql => sql === 'PRAGMA data_version', sql => sql.startsWith('SELECT total_changes()'),
    sql => sql === 'SELECT * FROM documents WHERE document_id = ?',
    sql => sql.startsWith('SELECT COUNT(*) AS count FROM graph_nodes'),
    sql => sql.startsWith('SELECT * FROM graph_nodes') && /LIMIT/.test(sql),
    sql => sql.startsWith('SELECT * FROM chunks')]
  for (const boundary of boundaries) { read(); interleave(boundary, () => read()) }
  for (const table of ['nodes', 'edges']) {
    const coldInspector = graph => inspect(graph)
    interleave(sql => sql.startsWith('SELECT * FROM graph_' + table) && !/LIMIT/.test(sql), () => read(coldInspector))
  }

  // Historical read and uncommitted write transactions never read or publish the process cache.
  const historical = canonical()
  read()
  reader.db.exec('BEGIN')
  reader.db.prepare('SELECT * FROM documents WHERE document_id = ?').get(small.documentId)
  deleteEdge()
  const transactionCount = inspections
  assert.deepEqual(read().graphStructureQuality, historical)
  assert.deepEqual(read().graphStructureQuality, historical)
  assert.equal(inspections, transactionCount + 2)
  reader.db.exec('ROLLBACK')
  assert.deepEqual(read().graphStructureQuality, canonical())
  const committed = canonical()
  reader.db.exec('BEGIN')
  reader.db.prepare('DELETE FROM graph_nodes WHERE document_id = ? AND node_id = ?').run(small.documentId, 'n1')
  assert.equal(read().graphStructureQuality.metrics.all.nodeCount, 95)
  reader.db.exec('ROLLBACK')
  assert.deepEqual(read().graphStructureQuality, committed, 'Rollback cannot leave uncommitted diagnostics cached')

  const failingInspector = graph => { inspect(graph); throw new Error('isolated inspector failure') }
  assert.throws(() => read(failingInspector), /isolated inspector failure/)
  assert.equal(reader.db.isTransaction, false)
  assert.deepEqual(read().graphStructureQuality, canonical())
  const execute = reader.db.exec
  let failedRelease = false
  reader.db.exec = function (sql) {
    if (!failedRelease && sql === 'RELEASE SAVEPOINT kg_document_read') {
      failedRelease = true; throw new Error('isolated release failure')
    }
    return execute.call(this, sql)
  }
  try { assert.throws(() => read(graph => inspect(graph)), /isolated release failure/) }
  finally { reader.db.exec = execute }
  assert.equal(reader.db.isTransaction, false)
  const failureCount = inspections
  assert.deepEqual(read().graphStructureQuality, canonical())
  assert.equal(inspections, failureCount + 1, 'Failed reads never publish a cached result')

  // The store retains one diagnostic, not an unbounded per-document map.
  const second = diagnosticFixture(40)
  second.documentId = second.graph.source.id = second.graph.source.documentId = 'second-window-diagnostic'
  for (const node of second.graph.nodes) for (const evidence of node.evidence) {
    evidence.documentId = evidence.sourceId = second.documentId
  }
  save(writer, second)
  read()
  const switchCount = inspections
  reader.getDocumentWindow(second.documentId, { limit: 20 }, inspect)
  read()
  assert.equal(inspections, switchCount + 2)
  const nonCloneable = graph => ({ count: graph.nodes.length, callback() {} })
  assert.equal(read(nonCloneable).graphStructureQuality.count, 96)
  assert.equal(read(nonCloneable).graphStructureQuality.count, 96)
  const runtimeDatabase = reader.db
  reader.db = { prepare: runtimeDatabase.prepare.bind(runtimeDatabase), exec: runtimeDatabase.exec.bind(runtimeDatabase) }
  const olderRuntimeCount = inspections
  try { read(); read() } finally { reader.db = runtimeDatabase }
  assert.equal(inspections, olderRuntimeCount + 2, 'Without an explicit transaction flag use the original uncached behavior')
  console.log(JSON.stringify({ ok: true, canonicalNodes: 12000, canonicalEdges: large.graph.edges.length, warmHttp,
    inspections, interleavings, canonicalDiagnosticsIdentical: true, detachedResults: true,
    localAndIndependentInvalidation: true, sameRevisionRecreation: true, historicalAndRollbackSafe: true, singleDiagnosticRetained: true }))
} finally {
  meter.stop()
  await host.stop()
  reader?.close()
  writer.close()
  rmSync(directory, { recursive: true, force: true })
}
