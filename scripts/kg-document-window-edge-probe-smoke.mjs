import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../lib/kg-store.mjs'
import { ordinaryWindowFixture } from './kg-document-window-ordinary-query-benchmark.mjs'
import { incidentShapeFixture } from './kg-document-window-incident-benchmark.mjs'
import { isWindowEdgeSql, isWindowEdgeProbeSql, normalizeWindowEdgeSql } from './kg-document-window-edge-reads.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-window-edge-probe-')), database = join(directory, 'graph.sqlite')
const writer = await openSqliteStore(database)
writer.db.exec('PRAGMA journal_mode = WAL')
const reader = await openSqliteStore(database), prepare = reader.db.prepare
const save = fixture => writer.saveGraph(fixture.graph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
const schema = () => prepare.call(reader.db, "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('graph_nodes', 'graph_edges') ORDER BY name").all()
const originalSchema = schema()
const counts = { windows: 0, probes: 0, probeBoolean: 0, probeFallback: 0, noProbe: 0, maxCandidates: 0, nativeReads: 0, interleavings: 0 }
let calls = [], totalEdges
// Compare actual complete Native rows with the frozen pre-probe SQL inside
// the same production read snapshot, including write interleavings below.
reader.db.prepare = function (sql) {
  const statement = prepare.call(this, sql)
  for (const method of ['get', 'all']) {
    const execute = statement[method]
    statement[method] = function (...params) {
      const value = execute.apply(this, params)
      if (sql === 'SELECT COUNT(*) AS count FROM graph_edges WHERE document_id = ?') totalEdges = value.count
      if (isWindowEdgeSql(sql)) {
        const n = JSON.parse(params[1]).length
        const normalized = normalizeWindowEdgeSql(sql)
        const original = totalEdges < n * n ? normalized.replace('AND to_node_id IN (SELECT value FROM json_each(?))',
          'AND (to_node_id IN (SELECT value FROM json_each(?))) = 1') : normalized
        assert.deepEqual(value, prepare.call(reader.db, original).all(...params), 'Every complete Native edge and its order must equal the original SQL')
        counts.nativeReads++
      }
      if (isWindowEdgeSql(sql) || isWindowEdgeProbeSql(sql)) calls.push({ sql, method, params, value })
      return value
    }
  }
  return statement
}
const meteredPrepare = reader.db.prepare
const compare = (a, b) => {
  for (const key of ['fromNodeId', 'toNodeId', 'relation']) {
    const order = Buffer.compare(Buffer.from(a[key]), Buffer.from(b[key]))
    if (order) return order
  }
  return 0
}
const full = id => {
  const graph = writer.getDocument(id)
  graph.edges.sort(compare)
  return graph
}
function check(id, options, expected = full(id)) {
  calls = []
  const window = reader.getDocumentWindow(id, options), selected = new Set(window.nodes.map(node => node.id))
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(2000, options.limit) : 800
  const edgeLimit = Math.max(limit, Math.min(12000, Number.isInteger(options.edgeLimit) ? options.edgeLimit : limit * 6))
  assert.deepEqual(window.edges, expected.edges.filter(edge => selected.has(edge.fromNodeId) && selected.has(edge.toNodeId)).slice(0, edgeLimit))
  assert.equal(window.view.totalNodes, expected.nodes.length); assert.equal(window.view.totalEdges, expected.edges.length)
  assert.equal(window.revision, expected.revision)
  assert.equal(window.sourceText, options.includeSourceText === false ? '' : expected.sourceText)
  assert.equal(window.view.truncated, expected.nodes.length > window.nodes.length || expected.edges.length > window.edges.length)
  const probes = calls.filter(call => isWindowEdgeProbeSql(call.sql)), edges = calls.filter(call => isWindowEdgeSql(call.sql))
  const needed = selected.size >= 64 && expected.edges.length >= selected.size * selected.size
  assert.equal(probes.length, needed ? 1 : 0); assert.equal(edges.length, selected.size ? 1 : 0)
  if (needed) {
    const probe = probes[0], outgoing = expected.edges.filter(edge => selected.has(edge.fromNodeId)).length
    assert.deepEqual(probe.params, [id, JSON.stringify([...selected]), 2049])
    assert.equal(probe.value.count, Math.min(2049, outgoing))
    const boolean = edges[0].sql !== normalizeWindowEdgeSql(edges[0].sql)
    assert.equal(boolean, outgoing <= 2048)
    assert.deepEqual(edges[0].params, [id, probe.params[1], probe.params[1], edgeLimit])
    const plan = prepare.call(reader.db, 'EXPLAIN QUERY PLAN ' + probe.sql).all(...probe.params).map(row => row.detail)
    assert(plan.some(detail => detail.includes('COVERING INDEX') && detail.includes('from_node_id=?')), 'Probe must use a narrow outgoing covering index')
    counts.probes++; counts[boolean ? 'probeBoolean' : 'probeFallback']++
    counts.maxCandidates = Math.max(counts.maxCandidates, probe.value.count)
  } else counts.noProbe++
  reader.db.exec('BEGIN; ROLLBACK') // Also valid on minimum Node 22 without isTransaction.
  counts.windows++
  return window
}

try {
  const sparse = ordinaryWindowFixture(14000, 'edge-probe-sparse')
  const ids = ['0', '00', '01', '1', '1.0', '1e0', '2', 'a%_', 'a"b', "n') OR 1=1 --", 'é', 'e\u0301', '中', '😀', '\uE000', 'n\nx']
  const renamed = new Map(sparse.graph.nodes.slice(0, ids.length).map((node, i) => [node.id, ids[i]]))
  sparse.graph.nodes.slice(0, ids.length).forEach((node, i) => { node.id = ids[i] })
  for (const edge of sparse.graph.edges) {
    edge.fromNodeId = renamed.get(edge.fromNodeId) || edge.fromNodeId
    edge.toNodeId = renamed.get(edge.toNodeId) || edge.toNodeId
  }
  sparse.graph.edges.push({ fromNodeId: '0', toNodeId: '1e0', relation: 'relates_to', evidence: [{ paragraph: 0, quote: 'Parallel evidence é e\u0301' }], custom: { retained: 'x'.repeat(1024) } })
  save(sparse)
  // saveGraph rejects new self-loops; legacy persisted rows must still read
  // identically. Inject only this owned database, using the existing schema.
  writer.db.prepare('INSERT INTO graph_edges SELECT ?,document_id,source_id,?,?,relation,evidence_json,attributes_json,chunk_id,state,created_at,updated_at FROM graph_edges WHERE document_id = ? AND from_node_id = ? AND to_node_id = ? AND relation = ?')
    .run('edge-probe-legacy-self', '0', '0', sparse.documentId, '0', '00', 'supports')
  const sparseFull = full(sparse.documentId)
  for (const limit of [1, 20, 63, 64, 65, 200, 800, 2000]) for (const offset of [0, 200, 13900]) {
    check(sparse.documentId, { limit, offset, includeSourceText: false }, sparseFull)
  }
  for (const query of ['windowunder', 'windowexact', 'observation 11', 'observation 13999.', 'absent_%', '%_']) {
    for (const limit of [200, 800]) check(sparse.documentId, { query, limit }, sparseFull)
  }
  for (const edgeLimit of [64, 384, 12000]) check(sparse.documentId, { limit: 64, edgeLimit }, sparseFull)

  const low = ordinaryWindowFixture(1600, 'edge-probe-threshold'), selected = new Set(low.graph.nodes.slice(0, 64).map(node => node.id))
  low.graph.edges = low.graph.edges.filter(edge => !selected.has(edge.fromNodeId))
  for (let i = 0; i < 2047; i++) low.graph.edges.push({ fromNodeId: low.graph.nodes[0].id,
    toNodeId: low.graph.nodes[64 + Math.floor(i / 2)].id, relation: i % 2 ? 'supports' : 'relates_to',
    evidence: [{ paragraph: 0, quote: 'Outside edge ' + i }], custom: { retained: 'Payload ' + i } })
  low.graph.edges.push({ fromNodeId: low.graph.nodes[1].id, toNodeId: low.graph.nodes[2].id, relation: 'supports' })
  const high = structuredClone(low)
  high.graph.edges.push({ fromNodeId: high.graph.nodes[2].id, toNodeId: high.graph.nodes[3].id, relation: 'relates_to' })
  for (const fixture of [low, high]) {
    save(fixture)
    const expected = full(fixture.documentId)
    for (const edgeLimit of [64, 384, 12000]) check(fixture.documentId, { limit: 64, edgeLimit }, expected)
    assert.equal(calls.find(call => isWindowEdgeProbeSql(call.sql)).value.count, fixture === low ? 2048 : 2049)
  }
  const empty = ordinaryWindowFixture(1600, 'edge-probe-no-outgoing')
  const first = new Set(empty.graph.nodes.slice(0, 64).map(node => node.id))
  empty.graph.edges = empty.graph.edges.filter(edge => !first.has(edge.fromNodeId))
  save(empty); check(empty.documentId, { limit: 64 })
  assert.equal(calls.find(call => isWindowEdgeProbeSql(call.sql)).value.count, 0)
  // Same opaque IDs in another document cannot affect the probe or result.
  check(sparse.documentId, { limit: 64 }, sparseFull)

  for (const [shape, size] of [['dense', 800], ['hub', 12000], ['outside', 12000], ['small', 64]]) {
    const fixture = incidentShapeFixture(shape, size, 'edge-probe-' + shape)
    save(fixture)
    const expected = full(fixture.documentId)
    for (const limit of [20, 63, 64, 200, 800]) for (const offset of [0, 400]) check(fixture.documentId, { limit, offset }, expected)
  }
  reader.db.exec('PRAGMA automatic_index = OFF')
  check(sparse.documentId, { limit: 64 }, sparseFull)
  reader.db.exec('PRAGMA automatic_index = ON; ANALYZE')
  check(sparse.documentId, { limit: 64 }, sparseFull)
  writer.db.exec('VACUUM')
  check(sparse.documentId, { limit: 200 }, sparseFull)

  // Both 2048/2049 strategies change during actual independent WAL commits,
  // before/after the aggregate and before/after complete edge retrieval.
  for (const [initial, changed] of [[low, high], [high, low]]) for (const boundary of [isWindowEdgeProbeSql, isWindowEdgeSql]) {
    for (const afterRead of [false, true]) {
      save(initial)
      const expected = full(initial.documentId), before = check(initial.documentId, { limit: 64 }, expected)
      let fired = false
      const commit = () => {
        if (fired) return
        fired = true
        assert.throws(() => reader.db.exec('BEGIN'), /within a transaction/)
        save(changed); counts.interleavings++
      }
      reader.db.prepare = function (sql) {
        const statement = meteredPrepare.call(this, sql)
        if (boundary(sql)) for (const method of ['get', 'all']) {
          const execute = statement[method]
          statement[method] = function (...params) {
            if (!afterRead) commit()
            const value = execute.apply(this, params)
            if (afterRead) commit()
            return value
          }
        }
        return statement
      }
      try { assert.deepEqual(check(initial.documentId, { limit: 64 }, expected), before); assert(fired) }
      finally { reader.db.prepare = meteredPrepare }
      const after = check(changed.documentId, { limit: 64 })
      assert.equal(after.revision, before.revision + 1)
      assert.equal(calls.find(call => isWindowEdgeProbeSql(call.sql)).value.count, changed === low ? 2048 : 2049)
    }
  }
  reader.db.prepare = function (sql) {
    if (isWindowEdgeProbeSql(sql)) throw new Error('Synthetic outgoing probe failure')
    return meteredPrepare.call(this, sql)
  }
  try { assert.throws(() => reader.getDocumentWindow(sparse.documentId, { limit: 64 }), /Synthetic outgoing probe failure/) }
  finally { reader.db.prepare = meteredPrepare }
  reader.db.exec('BEGIN; ROLLBACK')
  check(sparse.documentId, { limit: 64 }, sparseFull)
  assert.deepEqual(schema(), originalSchema)
  console.log(JSON.stringify({ ok: true, ...counts, outgoingBoundaries: [0, 2048, 2049], frozenNativeAndCanonicalEquality: true,
    binaryTextAffinityParallelSelfAndIsolation: true, automaticIndexAnalyzeVacuum: true, exceptionTransactionReleased: true, schemaUnchanged: true }))
} finally { reader.db.prepare = prepare; reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }) }
