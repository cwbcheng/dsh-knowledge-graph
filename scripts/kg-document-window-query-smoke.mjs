import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore, SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import * as hostPlugin from '../lib/index.js'
import { createGenerationStructureTools } from '../src/kg-generation-structure.mjs'
import { startDiagnosticHost } from './kg-document-window-diagnostics-benchmark.mjs'
import { countWindowQueryWork, isWindowQuerySql } from './kg-document-window-query-benchmark.mjs'
import { ordinaryWindowFixture } from './kg-document-window-ordinary-query-benchmark.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-window-query-')), database = join(directory, 'graph.sqlite')
const writer = await openSqliteStore(database)
writer.db.exec('PRAGMA journal_mode = WAL')
const reader = await openSqliteStore(database), nativePrepare = reader.db.prepare
let nativeCountChecks = 0
// The frozen COUNT uses the exact original predicate and parameters, inside
// the current read snapshot. Test instrumentation is excluded from the meter.
reader.db.prepare = function(sql) {
  const statement = nativePrepare.call(this, sql)
  if (isWindowQuerySql(sql) && sql.startsWith('SELECT *')) {
    const all = statement.all
    statement.all = function(...params) {
      const rows = all.apply(this, params), tail = ' ORDER BY paragraph, node_id LIMIT ?'
      assert(sql.endsWith(tail))
      const countSql = sql.slice(0, -tail.length).replace('SELECT *', 'SELECT COUNT(*) AS count')
      const count = nativePrepare.call(reader.db, countSql).get(...params.slice(0, -1)).count
      assert.equal(rows.length, Math.min(count, params.at(-1))); nativeCountChecks++
      return rows
    }
  }
  return statement
}
const meter = countWindowQueryWork(SqliteKnowledgeStore, database)
let reads = 0, httpReads = 0, interleavings = 0, maximum = 0, host
const compare = (fields, a, b) => {
  for (const field of fields) {
    if (a[field] == null && b[field] != null) return -1
    if (b[field] == null && a[field] != null) return 1
    const order = field === 'paragraph' ? (a[field] || 0) - (b[field] || 0) : Buffer.compare(Buffer.from(a[field] || ''), Buffer.from(b[field] || ''))
    if (order) return order
  }
  return 0
}
const nodeOrder = (a,b) => compare(['paragraph', 'id'], a,b)
const edgeOrder = (a,b) => compare(['fromNodeId', 'toNodeId', 'relation'], a,b)
const lowerAscii = value => String(value || '').replace(/[A-Z]/g, letter => letter.toLowerCase())
// Independent public-field reference: literal characters survive and direct
// matches precede bounded canonical neighbors. No production SQL is copied.
function reference(full, options) {
  const query = String(options.query || '').trim().slice(0, 200).toLowerCase()
  const nodes = [...full.nodes].sort(nodeOrder), edges = [...full.edges].sort(edgeOrder)
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(2000, options.limit) : 800
  const edgeLimit = Math.max(limit, Math.min(12000, Number.isInteger(options.edgeLimit) ? options.edgeLimit : limit * 6))
  const matches = nodes.filter(node => [node.id, node.type, node.text, node.quote, node.sectionId, node.sectionTitle].some(value => lowerAscii(value).includes(query)))
  const selected = matches.slice(0, limit), direct = new Set(selected.map(node => node.id))
  if (selected.length && selected.length < limit) {
    const incident = edges.filter(edge => direct.has(edge.fromNodeId) || direct.has(edge.toNodeId)).slice(0, edgeLimit)
    const neighbors = new Set(incident.flatMap(edge => [edge.fromNodeId, edge.toNodeId]).filter(id => !direct.has(id)))
    selected.push(...nodes.filter(node => neighbors.has(node.id)).slice(0, limit-selected.length))
  }
  const ids = new Set(selected.map(node => node.id))
  return { matched: matches.length, direct: Math.min(limit, matches.length), nodes: selected,
    edges: edges.filter(edge => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)).slice(0, edgeLimit), limit }
}
function check(documentId, options, full = writer.getDocument(documentId)) {
  const expected = reference(full, options)
  meter.reset()
  const actual = reader.getDocumentWindow(documentId, options)
  assert.deepEqual(actual.nodes, expected.nodes)
  assert.deepEqual(actual.edges, expected.edges)
  assert.equal(actual.view.matchedNodes, expected.matched)
  assert.equal(actual.view.nodeLimit, expected.limit)
  assert.equal(actual.view.query, options.query.trim().slice(0, 200))
  assert.equal(actual.view.totalNodes, full.nodes.length); assert.equal(actual.view.totalEdges, full.edges.length)
  assert.equal(actual.revision, full.revision); assert.deepEqual(actual.source, full.source)
  assert.deepEqual(actual.staging, full.staging); assert.deepEqual(actual.custom, full.custom)
  assert.equal(actual.sourceText, options.includeSourceText === false ? '' : full.sourceText)
  assert.equal(meter.counts.directRows, expected.direct)
  assert.equal(meter.counts.maxDirectRows, expected.direct)
  assert.equal(meter.counts.literalQueries, /[%_]/.test(options.query.trim().slice(0, 200)) ? 1 : 0)
  const countReads = expected.matched < expected.limit ? 0 : 1
  assert.equal(meter.counts.matchCountReads, countReads, 'Only an underfilled direct page may omit COUNT')
  assert.equal(meter.counts.matchingStatements, 1 + countReads)
  assert.equal(meter.counts.matched, expected.matched, 'Native count or exhausted candidate rows supply the total')
  maximum = Math.max(maximum, meter.counts.maxDirectRows); reads++
  return actual
}
const digest = value => createHash('sha256').update(value).digest('hex')
const inspect = graph => ({ canonicalNodes: graph.nodes.length, revision: graph.revision, sourceDigest: digest(graph.sourceText) })
try {
  const fixtures = [64, 12000].map(size => ordinaryWindowFixture(size, 'window-literal-' + size))
  const queries = ['node_17', 'NODE_17', 'node17', '100%', '%', '_', '%_', 'q%_uote', 'C:\\source\\_unit',
    'chapter_17', 'Section_17', '中_%_😀', "n')_% OR 1=1 --", 'absent_%', 'fact', 'observation 11999.']
  for (const fixture of fixtures) {
    writer.saveGraph(fixture.graph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
    // Exercise the persisted type column separately from opaque identities.
    writer.db.prepare('UPDATE graph_nodes SET type = ? WHERE document_id = ? AND node_id = ?').run('literal_type', fixture.documentId, 'type-marker')
    // Persisted legacy values exercise ordinary predicates in all six fields,
    // including SQLite's retained Unicode/ASCII case behavior.
    for (const [field, id, value] of [['text','n20','Uppercase CAFÉ only. windowexact'],['text','n21','Lowercase café only. windowexact'],
      ['quote','n22','Quoteonly Straße literal.'],['section_id','n23','ordinarychapter'],['section_title','n23','Ordinarytitle'],['type','n24','ordinarytype']]) {
      writer.db.prepare('UPDATE graph_nodes SET ' + field + ' = ? WHERE document_id = ? AND node_id = ?').run(value, fixture.documentId, id)
    }
    const full = writer.getDocument(fixture.documentId), untouched = JSON.stringify(full)
    for (const query of [...queries, 'literal_type']) for (const limit of [1, 4, 20, 800, 2000]) for (const includeSourceText of [false, true]) {
      check(fixture.documentId, { query, limit, includeSourceText }, full)
    }
    for (const query of ['  node_17  ', 'x'.repeat(199) + '_truncated', 'C:\\source\\', 'missing%\\', '%\\_']) {
      check(fixture.documentId, { query, limit: 20, edgeLimit: 20, includeSourceText: false }, full)
    }
    for (const query of ['NODE17','café','CAFÉ','quoteonly','ordinarychapter','ordinarytitle','ordinarytype','not-in-this-source']) {
      for (const limit of [1,20,800]) for (const includeSourceText of [false,true]) check(fixture.documentId, { query, limit, includeSourceText }, full)
    }
    for (const query of ['windowexact','windowunder']) for (const limit of [199,200,201]) for (const includeSourceText of [false,true]) {
      check(fixture.documentId, { query, limit, includeSourceText }, full)
    }
    for (const query of ['', '   ']) {
      meter.reset()
      assert.equal(reader.getDocumentWindow(fixture.documentId, { query, limit: 20 }).view.kind, 'window')
      assert.equal(meter.counts.queries, 0)
    }
    assert.equal(JSON.stringify(writer.getDocument(fixture.documentId)), untouched, 'Queries do not write canonical data')
    writer.db.prepare('UPDATE graph_nodes SET type = ? WHERE document_id = ? AND node_id = ?').run(fixture.graph.nodes[4].type, fixture.documentId, 'type-marker')
  }
  const fixture = fixtures[1], id = fixture.documentId
  const boundaries = [
    { query: '%_', limit: 1, boundary: sql => isWindowQuerySql(sql) && sql.startsWith('SELECT COUNT') },
    { query: '%_', limit: 20, boundary: sql => isWindowQuerySql(sql) && sql.startsWith('SELECT *') },
    { query: '%_', limit: 20, boundary: sql => sql.startsWith('SELECT * FROM graph_edges') && sql.includes('from_node_id IN (') && sql.includes('to_node_id IN (') && !sql.includes('json_each') },
    { query: 'never_%', limit: 20, boundary: sql => isWindowQuerySql(sql) && sql.startsWith('SELECT *') },
    ...[false,true].flatMap(afterRead => [
      { query: 'observation 11999.', limit: 20, afterRead, boundary: sql => isWindowQuerySql(sql) && sql.startsWith('SELECT *') },
      { query: 'node17', limit: 1, afterRead, boundary: sql => isWindowQuerySql(sql) && sql.startsWith('SELECT COUNT') },
    ]),
  ]
  for (const { boundary, query, limit, afterRead = true } of boundaries) {
    const options = { query, limit, includeSourceText: false }
    const before = reader.getDocumentWindow(id, options, inspect), prepare = reader.db.prepare
    let fired = false
    reader.db.prepare = function (sql) {
      const statement = prepare.call(this, sql)
      if (boundary(sql)) for (const method of ['get','all']) {
        const execute = statement[method]
        statement[method] = function (...args) {
          const commit = () => {
            fired = true; assert.throws(() => reader.db.exec('BEGIN'), /within a transaction/)
            const revised = writer.getDocument(id), newId = 'new%_match-' + interleavings
            revised.nodes.push({ id: newId, type: 'fact', text: 'Independent ' + query + ' observation.', paragraph: 11971 })
            revised.edges.push({ fromNodeId: 'literal%_target', toNodeId: newId, relation: 'supports' })
            revised.staging.chunks[0].summary = 'New chunk ' + interleavings
            writer.saveGraph(revised, { sourceText: revised.sourceText + '\n\nIndependent source.', expectedRevision: revised.revision })
            interleavings++
          }
          if (!fired && !afterRead) commit()
          const result = execute.apply(this, args)
          if (!fired && afterRead) commit()
          return result
        }
      }
      return statement
    }
    try { assert.deepEqual(reader.getDocumentWindow(id, options, inspect), before); assert(fired) }
    finally { reader.db.prepare = prepare }
    const next = check(id, options)
    assert.equal(next.revision, before.revision+1)
    assert.equal(next.view.matchedNodes, before.view.matchedNodes+1)
    assert.equal(reader.getDocumentWindow(id, options, inspect).graphStructureQuality.sourceDigest, digest(writer.getDocument(id).sourceText))
  }
  host = await startDiagnosticHost(database, hostPlugin)
  const full = writer.getDocument(id)
  const canonicalQuality = createGenerationStructureTools().inspect(full)
  for (const query of ['node_17', '100%', '%_', 'C:\\source\\_unit', "n')_% OR 1=1 --", 'absent_%', 'observation 11999.']) {
    for (const nodeLimit of [1, 20, 800]) {
      const result = await host.post({ documentId: id, query, nodeLimit, includeSourceText: false })
      assert(!result.error)
      const expected = reference(full, { query, limit: nodeLimit })
      assert.deepEqual(result.graph.nodes, expected.nodes); assert.deepEqual(result.graph.edges, expected.edges)
      assert.equal(result.graph.view.matchedNodes, expected.matched)
      assert.deepEqual(result.graph.graphStructureQuality, canonicalQuality)
      assert.equal(result.graph.graphStructureQuality.metrics.all.nodeCount, full.nodes.length)
      assert.equal(result.revision, full.revision); assert(!result.sourceText)
      httpReads++
    }
  }
  assert.equal(reader.getDocumentWindow('missing', { query: '%_' }), null)
  console.log(JSON.stringify({ ok: true, documents: fixtures.length, reads, httpReads, interleavings, maxDirectRows: maximum, nativeCountChecks,
    literalIdsAndSixFields: true, ordinaryAndEmptyQueries: true, boundedNativeRows: true,
    orderedNeighborsAndEvidence: true, immutableSourceAndMetadata: true, independentWalSnapshot: true, canonicalHttpDiagnostics: true,
    underfilledLiteralAndOrdinaryCountOmitted: true, fullAndExactBudgetCounted: true, nativeMatchCountParity: true, ordinaryUnicodeAndSixFields: true }))
} finally { await host?.stop(); meter.stop(); reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }) }
