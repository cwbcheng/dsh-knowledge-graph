import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../lib/kg-store.mjs'
import { diagnosticFixture } from './kg-document-window-diagnostics-benchmark.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-window-edges-'))
const database = join(directory, 'graph.sqlite')
const writer = await openSqliteStore(database)
writer.db.exec('PRAGMA journal_mode = WAL')
const reader = await openSqliteStore(database)
let reads = 0, interleavings = 0
const fixture = (name, size) => {
  const value = diagnosticFixture(size)
  value.documentId = value.graph.source.id = value.graph.source.documentId = name
  for (const node of value.graph.nodes) for (const evidence of node.evidence) {
    evidence.documentId = evidence.sourceId = name
  }
  return value
}
const save = value => writer.saveGraph(value.graph, { sourceText: value.sourceText, sourceUnits: value.sourceUnits })
// SQLite BINARY ordering compares UTF-8 bytes, including supplementary-plane IDs.
const compare = (a, b) => {
  for (const field of ['fromNodeId', 'toNodeId', 'relation']) {
    const order = Buffer.compare(Buffer.from(a[field]), Buffer.from(b[field]))
    if (order) return order
  }
  return 0
}
const reference = documentId => {
  const full = writer.getDocument(documentId)
  full.edges.sort(compare)
  return full
}
function check(documentId, options, expected = reference(documentId)) {
  const actual = reader.getDocumentWindow(documentId, options)
  const selected = new Set(actual.nodes.map(node => node.id))
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(2000, options.limit) : 800
  const edgeLimit = Math.max(limit, Math.min(12000, Number.isInteger(options.edgeLimit) ? options.edgeLimit : limit * 6))
  const edges = expected.edges.filter(edge => selected.has(edge.fromNodeId) && selected.has(edge.toNodeId)).slice(0, edgeLimit)
  assert.deepEqual(actual.edges, edges, 'Window membership, BINARY order, parallel relations and evidence must agree with the canonical graph')
  assert.equal(actual.view.totalNodes, expected.nodes.length)
  assert.equal(actual.view.totalEdges, expected.edges.length)
  assert.equal(actual.revision, expected.revision)
  assert.equal(actual.sourceText, options.includeSourceText === false ? '' : expected.sourceText)
  assert.equal(actual.view.truncated, expected.nodes.length > actual.nodes.length || expected.edges.length > actual.edges.length)
  if (typeof reader.db.isTransaction === 'boolean') assert.equal(reader.db.isTransaction, false)
  else reader.db.exec('BEGIN; ROLLBACK') // Older Node 22 has no transaction-state getter.
  reads++
  return actual
}

try {
  const sparse = fixture('sparse-window', 2400)
  save(sparse)
  const sparseFull = reference(sparse.documentId)
  for (const limit of [1, 4, 20, 200, 800, 2000]) {
    for (const offset of [0, 200, 2200, 9999]) check(sparse.documentId, { limit, offset, includeSourceText: false }, sparseFull)
  }
  for (const query of ['observation 1800.', 'observation 2399.', 'not-in-this-source']) {
    check(sparse.documentId, { limit: 800, query }, sparseFull)
  }
  // Inspect the production query, not a separately reimplemented fast SQL.
  const prepare = reader.db.prepare
  let plan
  reader.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (sql.startsWith('SELECT * FROM graph_edges') && sql.includes('json_each')) {
      const all = statement.all
      statement.all = function (...args) {
        plan = prepare.call(reader.db, 'EXPLAIN QUERY PLAN ' + sql).all(...args).map(row => row.detail)
        return all.apply(this, args)
      }
    }
    return statement
  }
  try { check(sparse.documentId, { limit: 800, offset: 200 }, sparseFull) }
  finally { reader.db.prepare = prepare }
  assert(plan.some(detail => /\bSEARCH graph_edges\b/.test(detail) && detail.includes('from_node_id=?') && !detail.includes('to_node_id=?')),
    'A sparse 800-node window must not probe all endpoint pairs')
  reader.db.exec('PRAGMA automatic_index = OFF')
  check(sparse.documentId, { limit: 800, offset: 200 }, sparseFull)
  reader.db.exec('PRAGMA automatic_index = ON')
  reader.db.exec('ANALYZE')
  check(sparse.documentId, { limit: 800, offset: 200 }, sparseFull)

  const identities = fixture('identity-window', 80)
  const special = ['0', '00', '01', '1', '1.0', '1e0', '2', 'a%_', 'a\"b', "n') OR 1=1 --", 'é', 'e\u0301', '中', '😀', '\uE000', 'n\nx']
  special.forEach((id, i) => { identities.graph.nodes[i].id = id })
  identities.graph.edges = []
  for (const fromNodeId of special) for (const toNodeId of special) for (const relation of ['supports', 'relates_to']) {
    if (fromNodeId === toNodeId) continue
    identities.graph.edges.push({ fromNodeId, toNodeId, relation,
      evidence: [{ paragraph: 0, quote: fromNodeId + ' -> ' + toNodeId + ': ' + relation }] })
  }
  identities.graph.edges.push({ fromNodeId: 'n79', toNodeId: '0', relation: 'supports' },
    { fromNodeId: '0', toNodeId: 'n79', relation: 'supports' })
  save(identities)
  const identityFull = reference(identities.documentId)
  for (const limit of [1, 4, 20, 80]) for (const edgeLimit of [limit, 12000]) {
    check(identities.documentId, { limit, edgeLimit }, identityFull)
  }
  check(identities.documentId, { limit: 20, offset: 60 }, identityFull)
  const other = structuredClone(identities)
  other.documentId = other.graph.source.id = other.graph.source.documentId = 'other-identity-window'
  other.graph.edges = [{ fromNodeId: '0', toNodeId: '1', relation: 'different-document', evidence: [{ paragraph: 0, quote: 'Other document only' }] }]
  save(other)
  check(identities.documentId, { limit: 80, edgeLimit: 12000 }, identityFull)
  check(other.documentId, { limit: 80 })

  const hub = fixture('outside-degree-window', 240)
  hub.graph.edges = []
  for (let i = 0; i < 20; i++) for (let j = 120; j < 240; j++) {
    hub.graph.edges.push({ fromNodeId: 'n' + i, toNodeId: 'n' + j, relation: 'supports' })
  }
  save(hub)
  const hubFull = reference(hub.documentId)
  for (const limit of [1, 4, 20, 200]) check(hub.documentId, { limit }, hubFull)

  // Independent WAL commits cross both strategy selection and edge retrieval.
  for (const boundary of [sql => sql.startsWith('SELECT COUNT(*) AS count FROM graph_edges'),
    sql => sql.startsWith('SELECT * FROM graph_edges') && sql.includes('json_each')]) {
    const before = reader.getDocumentWindow(sparse.documentId, { limit: 800, offset: 200 })
    const changed = structuredClone(sparse)
    changed.graph.edges.push({ fromNodeId: 'n250', toNodeId: 'n251', relation: 'relates_to', evidence: [{ paragraph: 250, quote: 'New relation' }] })
    let fired = false
    reader.db.prepare = function (sql) {
      const statement = prepare.call(this, sql)
      if (boundary(sql)) for (const name of ['get', 'all']) {
        const execute = statement[name]
        statement[name] = function (...args) {
          const result = execute.apply(this, args)
          if (!fired) {
            fired = true
            assert.throws(() => reader.db.exec('BEGIN'), /within a transaction/)
            save(changed)
            interleavings++
          }
          return result
        }
      }
      return statement
    }
    try {
      assert.deepEqual(reader.getDocumentWindow(sparse.documentId, { limit: 800, offset: 200 }), before)
      assert(fired, 'The independent writer must actually commit at this boundary')
    } finally { reader.db.prepare = prepare }
    const after = check(sparse.documentId, { limit: 800, offset: 200 })
    assert.equal(after.revision, before.revision + 1)
    assert(after.edges.some(edge => edge.relation === 'relates_to'))
    save(sparse)
  }
  console.log(JSON.stringify({ reads, interleavings, sparseWindowPlan: plan, exactMembershipAndOrder: true,
    parallelRelationsAndEvidence: true, numericAndUnicodeIds: true, sourceUnchanged: true }))
} finally { reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }) }
