import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore, SqliteKnowledgeStore } from '../src/kg-store.mjs'
import { countWindowSourceHydration } from './kg-document-window-source-benchmark.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-window-source-'))
const database = join(directory, 'graph.sqlite')
const writer = await openSqliteStore(database)
writer.db.exec('PRAGMA journal_mode = WAL')
const reader = await openSqliteStore(database)
const explicitTransactionFlag = typeof reader.db.isTransaction === 'boolean'
const meter = countWindowSourceHydration(SqliteKnowledgeStore, database)
const oldSql = 'SELECT * FROM documents WHERE document_id = ?'
const projected = sql => sql.startsWith('SELECT document_id, source_id, title, chars, ')
let reads = 0, interleavings = 0, inspections = 0
const digest = value => createHash('sha256').update(value).digest('hex')
const inspect = graph => {
  inspections++
  return { revision: graph.revision, canonicalCount: graph.nodes.length, sourceDigest: digest(graph.sourceText),
    source: graph.source, metadata: graph.custom, chunks: graph.staging.chunks.length }
}
function legacyRead(id, options) {
  const prepare = reader.db.prepare
  reader.db.prepare = function (sql) { return prepare.call(this, projected(sql) ? oldSql : sql) }
  try { return reader.getDocumentWindow(id, options) } finally { reader.db.prepare = prepare }
}
function check(id, options, inspector) {
  const expected = legacyRead(id, options)
  meter.reset()
  const actual = reader.getDocumentWindow(id, options, inspector)
  if (inspector && actual) {
    assert.deepEqual(actual.graphStructureQuality, inspect(writer.getDocument(id)))
    delete actual.graphStructureQuality
  }
  assert.deepEqual(actual, expected, 'Every window field matches the frozen full-row document query')
  if (!inspector && actual) {
    assert.equal(meter.counts.documentRows, 1)
    assert.equal(meter.counts.sourceTextReads, options.includeSourceText === false ? 0 : 1)
    if (options.includeSourceText === false) assert.equal(meter.counts.sourceTextBytes, 0, 'Omit text before Native hydration, not just HTTP serialization')
  }
  if (explicitTransactionFlag) assert.equal(reader.db.isTransaction, false)
  reads++
  return actual
}
function race(id, options, afterRead, commit, inspector = inspect) {
  const previous = reader.getDocumentWindow(id, options, inspector)
  const prepare = reader.db.prepare
  // Old runtimes deliberately bypass the diagnostic cache and have no
  // pre-header stamp. Pin an enclosing read for this before-header race;
  // otherwise a writer may validly commit before the snapshot even begins.
  const pinned = !explicitTransactionFlag && !afterRead
  if (pinned) { reader.db.exec('BEGIN'); reader.db.prepare('SELECT graph_revision FROM documents WHERE document_id = ?').get(id) }
  let fired = false
  reader.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (projected(sql)) {
      const get = statement.get
      statement.get = function (...args) {
        if (!fired && !afterRead) { fired = true; commit(); interleavings++ }
        const row = get.apply(this, args)
        if (!fired && afterRead) { fired = true; commit(); interleavings++ }
        return row
      }
    }
    return statement
  }
  try { assert.deepEqual(reader.getDocumentWindow(id, options, inspector), previous); assert(fired) }
  finally { reader.db.prepare = prepare; if (pinned) reader.db.exec('ROLLBACK') }
}
try {
  const sourceSizes = [0, 1024, 1048576]
  for (const [index, size] of sourceSizes.entries()) {
    const id = 'source-window-' + index
    const sourceText = 'Original 原文 😀\r\n\r\n'.repeat(Math.ceil(size / 24))
    const graph = { source: { documentId: id, title: '联结模型', customSource: { original: '内涵 / 陪域 / 槽位' } },
      nodes: Array.from({ length: 803 }, (_, i) => ({ id: 'n' + i, type: 'fact', text: 'Fact ' + i, paragraph: i,
        evidence: [{ paragraph: i, quote: 'Quoted ' + i }] })),
      edges: [{ fromNodeId: 'n801', toNodeId: 'n802', relation: 'supports', evidence: [{ paragraph: 802, quote: 'Evidence preserved' }] }],
      staging: { chunks: [{ chunkId: 'source-chunk', startParagraph: 0, endParagraph: 802,
        summary: 'Chunk content retained', nodeIds: ['n801', 'n802'], edgeCount: 1 }] },
      custom: { unicode: '中😀', nested: [null, 1, { original: true }] }, traceText: sourceText }
    writer.saveGraph(graph, { sourceText, sourceUnits: [{ paragraph: 0, text: 'Original unit' }] })
    const originalSourceJson = writer.db.prepare('SELECT source_json FROM documents WHERE document_id = ?').get(id).source_json
    for (const flag of [undefined, false, true, null, 0, '', 'false']) {
      for (const projection of [{}, { limit: 200, offset: 800 }, { limit: 2000, offset: 9999 },
        { limit: 20, query: 'Fact 801' }, { query: 'no-such-observation' }]) {
        check(id, { ...projection, includeSourceText: flag })
      }
    }
    for (const sourceJson of ['', '{broken', 'null', '{}']) {
      writer.db.prepare('UPDATE documents SET source_json = ? WHERE document_id = ?').run(sourceJson, id)
      check(id, { includeSourceText: false, limit: 4 })
      check(id, { includeSourceText: true, limit: 4 })
    }
    writer.db.prepare('UPDATE documents SET source_json = ? WHERE document_id = ?').run(originalSourceJson, id)
    check(id, { includeSourceText: false, limit: 200 }, inspect)
    meter.reset()
    const beforeWarm = inspections, warm = reader.getDocumentWindow(id, { includeSourceText: false, limit: 800, offset: 200 }, inspect)
    assert.equal(inspections, beforeWarm + (explicitTransactionFlag ? 0 : 1))
    assert.equal(meter.counts.sourceTextReads, explicitTransactionFlag ? 0 : 1,
      'Cacheable warm windows omit canonical source; old runtimes retain the uncached diagnostic path')
    assert.equal(warm.graphStructureQuality.sourceDigest, digest(sourceText))
    meter.reset()
    const cold = reader.getDocumentWindow(id, { includeSourceText: false }, graph => inspect(graph))
    assert.equal(meter.counts.sourceTextReads, 1, 'A cold inspector still receives the full canonical source')
    assert.equal(cold.graphStructureQuality.sourceDigest, digest(sourceText))
    assert.equal(cold.traceText, sourceText, 'Graph metadata and chunks remain complete even when they carry original text')
    check(id, { includeSourceText: true }, inspect)
  }
  const id = 'source-window-2', omitted = { includeSourceText: false, limit: 200, offset: 800 }
  for (const after of [false, true]) {
    race(id, omitted, after, () => {
      const full = writer.getDocument(id)
      full.source.title = 'New snapshot title'
      full.custom = { isolated: 'new metadata' }
      full.nodes.pop(); full.edges = []
      const remaining = new Set(full.nodes.map(node => node.id))
      for (const chunk of full.staging.chunks) chunk.nodeIds = chunk.nodeIds.filter(nodeId => remaining.has(nodeId))
      writer.saveGraph(full, { sourceText: full.sourceText + '\n\nNew independent source', expectedRevision: full.revision })
    })
    const next = check(id, omitted, inspect)
    assert.equal(next.source.title, 'New snapshot title')
  }
  // A raw source-only change at the same canonical revision must invalidate
  // diagnostics, even though the omitted document SELECT never requests it.
  for (const connection of [reader, writer]) {
    const before = reader.getDocumentWindow(id, omitted, inspect), text = 'Raw source ' + (connection === reader ? 'local' : 'independent')
    connection.db.prepare('UPDATE documents SET source_text = ? WHERE document_id = ?').run(text, id)
    meter.reset()
    const next = reader.getDocumentWindow(id, omitted, inspect)
    assert.equal(next.revision, before.revision)
    assert.equal(next.sourceText, '')
    assert.equal(next.graphStructureQuality.sourceDigest, digest(text))
    assert.equal(meter.counts.sourceTextReads, 1)
  }
  race(id, omitted, true, () => writer.db.prepare('DELETE FROM documents WHERE document_id = ?').run(id))
  assert.equal(reader.getDocumentWindow(id, omitted, inspect), null)
  const recreated = writer.getDocument('source-window-0')
  recreated.source.documentId = id; recreated.source.id = id
  writer.saveGraph(recreated, { sourceText: 'Recreated source' })
  assert.equal(check(id, omitted, inspect).revision, 1)
  assert.equal(reader.getDocumentWindow(id, omitted, inspect).graphStructureQuality.sourceDigest, digest('Recreated source'))
  meter.reset()
  assert.equal(reader.getDocumentWindow('missing', omitted), null)
  assert.equal(meter.counts.sourceTextReads, 0)
  console.log(JSON.stringify({ ok: true, documents: sourceSizes.length, reads, interleavings,
    fullWindowParity: true, nativeSourceOmission: true, strictFalseOnly: true, legacyMetadataFallback: true,
    completeMetadataAndChunks: true, coldCanonicalSource: true, explicitTransactionFlag,
    cacheableWarmSourceOmission: explicitTransactionFlag, olderRuntimeUncached: !explicitTransactionFlag,
    localAndIndependentSourceInvalidation: true, independentWalSnapshot: true, deleteRecreation: true }))
} finally { meter.stop(); reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }) }
