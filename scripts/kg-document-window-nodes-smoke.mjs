import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-window-nodes-'))
const database = join(directory, 'graph.sqlite')
const writer = await openSqliteStore(database)
writer.db.exec('PRAGMA journal_mode = WAL')
const reader = await openSqliteStore(database)
const oldSql = 'SELECT * FROM graph_nodes WHERE document_id = ? ORDER BY paragraph, node_id LIMIT ? OFFSET ?'
const prepare = reader.db.prepare
let reads = 0, deepReads = 0, interleavings = 0, lastQuery
let measuring = false, hydratedRows = 0, fullReads = 0, maxHydratedRows = 0
reader.db.prepare = function (sql) {
  const statement = prepare.call(this, sql)
  if (sql.startsWith('SELECT * FROM graph_nodes')) {
    const all = statement.all
    statement.all = function (...args) {
      if (sql.includes('OFFSET')) lastQuery = { sql, args }
      const rows = all.apply(this, args)
      if (measuring) {
        hydratedRows += rows.length
        if (!sql.includes('LIMIT') && !sql.includes('node_id IN')) fullReads++
      }
      return rows
    }
  }
  return statement
}
const compare = (a, b) => {
  for (const field of ['fromNodeId', 'toNodeId', 'relation']) {
    const order = Buffer.compare(Buffer.from(a[field]), Buffer.from(b[field]))
    if (order) return order
  }
  return 0
}
function check(id, options, full = writer.getDocument(id)) {
  lastQuery = null
  hydratedRows = fullReads = 0
  let window
  measuring = true
  try { window = reader.getDocumentWindow(id, options) } finally { measuring = false }
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(2000, options.limit) : 800
  const requested = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0
  const offset = Math.min(requested, Math.max(0, full.nodes.length - 1))
  const expected = full.nodes.slice(offset, offset + limit)
  assert.deepEqual(window.nodes, expected, 'Nodes, NULL-first/BINARY order and JSON metadata agree with the canonical graph')
  const selected = new Set(expected.map(node => node.id))
  const edgeLimit = Math.max(limit, Math.min(12000, Number.isInteger(options.edgeLimit) ? options.edgeLimit : limit * 6))
  const edges = full.edges.filter(edge => selected.has(edge.fromNodeId) && selected.has(edge.toNodeId)).sort(compare).slice(0, edgeLimit)
  assert.deepEqual(window.edges, edges)
  assert.deepEqual(window.source, full.source)
  assert.equal(window.sourceText, options.includeSourceText === false ? '' : full.sourceText)
  assert.equal(window.revision, full.revision)
  assert.equal(window.view.nodeOffset, offset)
  assert.equal(window.view.nodeLimit, limit)
  assert.equal(window.view.totalNodes, full.nodes.length)
  assert.equal(window.view.totalEdges, full.edges.length)
  assert(window.nodes.length <= limit)
  assert(hydratedRows <= limit, 'Native node hydration must respect the budget before JavaScript slicing')
  assert.equal(fullReads, 0, 'Ordinary windows must not preload the canonical graph')
  maxHydratedRows = Math.max(maxHydratedRows, hydratedRows)
  assert.deepEqual(prepare.call(reader.db, lastQuery.sql).all(...lastQuery.args),
    prepare.call(reader.db, oldSql).all(id, limit, offset), 'Actual production SQL returns every row field exactly as the frozen b389b313 query')
  const deep = offset >= limit * 4
  assert.equal(lastQuery.sql.includes('rowid IN'), deep, 'Clamped shallow pages keep the original direct query')
  if (deep) {
    const plan = prepare.call(reader.db, 'EXPLAIN QUERY PLAN ' + lastQuery.sql).all(...lastQuery.args)
    assert(plan.some(row => /SEARCH graph_nodes USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(row.detail)),
      'Full node records must be looked up by selected row identity, not scanned across the document')
    deepReads++
  } else assert.equal(lastQuery.sql, oldSql)
  reads++
  return window
}

try {
  let seed = 0x8031f
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const ids = ['0', '00', '01', '1', '1.0', '1e0', 'a%_', "n') OR 1=1 --", 'A', 'a', 'Ω', '中', '😀', '\uE000', '\u{10000}']
  const fixtures = [0, 1, 23, 101, 1001, 10003, ...Array.from({ length: 8 }, (_, i) => 87 + i * 31)]
  for (let index = 0; index < fixtures.length; index++) {
    const id = '窗口:' + index, size = fixtures[index]
    const quote = 'UTF-16 quote 😀 and source text '.repeat(index === 5 ? 32 : 2)
    const nodes = Array.from({ length: size }, (_, i) => ({ id: i < ids.length ? ids[i] : 'opaque-' + i.toString(36),
      type: i % 5 ? 'fact' : 'concept', text: 'Observation ' + i, quote,
      ...(i % 9 ? { paragraph: [0, 7, 21, 1000000000][random() % 4] } : {}),
      sectionId: i % 3 ? 'section-b' : 'section-a', evidence: [{ paragraph: 0, quote, sourceId: id }],
      custom: { originalIndex: i, labels: ['中', '😀'], nullable: null } }))
    const edges = nodes.slice(1, 80).flatMap((node, i) => ['supports', 'relates_to'].map(relation => ({
      fromNodeId: nodes[i].id, toNodeId: node.id, relation, evidence: [{ paragraph: 0, quote: 'Preserved ' + i }] })))
    writer.saveGraph({ source: { documentId: id, title: id }, nodes: nodes.reverse(), edges }, { sourceText: 'Original source\n\n第二段' })
    // These internal keys must not become node IDs, page order or JS numbers.
    if (index === 5) {
      for (const [nodeId, rowid] of [[ids[0], -11n], [ids[1], 0n], [ids[2], 9223372036854775807n]]) {
        writer.db.prepare('UPDATE graph_nodes SET rowid = ? WHERE document_id = ? AND node_id = ?').run(rowid, id, nodeId)
      }
    }
    const full = writer.getDocument(id)
    for (const limit of [1, 4, 20, 200, 800, 2000, 9999, 0]) {
      for (const offset of new Set([-1, 0, limit, limit * 4 - 1, limit * 4, Math.floor(size / 2), size - limit, size + 100000])) {
        check(id, { limit, offset, includeSourceText: index % 2 === 0 }, full)
      }
    }
  }
  const id = '窗口:5', options = { limit: 800, offset: 8000 }
  for (const command of ['ANALYZE', 'PRAGMA automatic_index = OFF', 'VACUUM']) {
    const full = writer.getDocument(id)
    writer.db.exec(command)
    assert.deepEqual(writer.getDocument(id), full, 'Statistics and VACUUM preserve public identities and contents')
    check(id, options, full)
  }
  // Commits before the bounded node SELECT and after it remain outside the
  // complete window snapshot, including after row identities are reassigned.
  for (const afterRead of [false, true]) {
    const before = reader.getDocumentWindow(id, options), full = writer.getDocument(id)
    const changed = structuredClone(full)
    changed.nodes[changed.nodes.length - 1].text += ' independently changed'
    changed.nodes = changed.nodes.slice(1).reverse()
    const remainingIds = new Set(changed.nodes.map(node => node.id))
    changed.edges = changed.edges.filter(edge => remainingIds.has(edge.fromNodeId) && remainingIds.has(edge.toNodeId))
    let fired = false
    const observedPrepare = reader.db.prepare
    reader.db.prepare = function (sql) {
      const statement = observedPrepare.call(this, sql)
      if (sql.startsWith('SELECT * FROM graph_nodes') && sql.includes('rowid IN')) {
        const all = statement.all
        statement.all = function (...args) {
          const commit = () => { fired = true; writer.saveGraph(changed, { expectedRevision: full.revision, sourceText: full.sourceText }); interleavings++ }
          if (!fired && !afterRead) commit()
          const result = all.apply(this, args)
          if (!fired && afterRead) commit()
          return result
        }
      }
      return statement
    }
    try { assert.deepEqual(reader.getDocumentWindow(id, options), before); assert(fired) }
    finally { reader.db.prepare = observedPrepare }
    const next = check(id, options)
    assert.equal(next.revision, before.revision + 1)
  }
  console.log(JSON.stringify({ ok: true, documents: fixtures.length, reads, deepReads, interleavings, maxHydratedRows,
    frozenQueryAndCanonicalParity: true, nullFirstBinaryAndSparseParagraphs: true, fullMetadataAndRelations: true,
    shallowQueryUnchanged: true, crossDocumentIsolation: true, internal64BitRowIds: true,
    analyzeAutomaticIndexAndVacuum: true, rowIdsNotPersisted: true, independentWalSnapshot: true }))
} finally { reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }) }
