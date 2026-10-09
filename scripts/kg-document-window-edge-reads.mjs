// Instrumentation shared by independent regression and optional benchmarks.
// This module is not imported by production code.
import assert from 'node:assert/strict'

export const isWindowEdgeSql = sql => sql.startsWith('SELECT * FROM graph_edges') && sql.includes('json_each')
export const isWindowEdgeProbeSql = sql => sql === 'SELECT COUNT(*) AS count FROM (SELECT 1 FROM graph_edges WHERE document_id = ? AND from_node_id IN (SELECT value FROM json_each(?)) LIMIT ?)'
export const normalizeWindowEdgeSql = sql => sql.replace('(to_node_id IN (SELECT value FROM json_each(?))) = 1', 'to_node_id IN (SELECT value FROM json_each(?))')

// Allow only boolean membership vs direct IN, preserving every other SQL
// byte, method, document/selected-ID/budget parameter and complete Native row.
export function assertWindowEdgeCallParity(before, after) {
  const reads = calls => calls.filter(call => isWindowEdgeSql(call.sql)).map(call => ({ ...call, sql: normalizeWindowEdgeSql(call.sql) }))
  assert.deepEqual(reads(after), reads(before))
  const probes = after.filter(call => isWindowEdgeProbeSql(call.sql)), edges = after.filter(call => isWindowEdgeSql(call.sql))
  assert(probes.length <= 1)
  for (const probe of probes) {
    assert.equal(probe.method, 'get')
    assert.deepEqual(probe.params, [edges[0].params[0], edges[0].params[1], 2049])
    assert(JSON.parse(probe.params[1]).length >= 64)
    if (Object.hasOwn(probe, 'value')) {
      assert(Number.isInteger(probe.value.count) && probe.value.count >= 0 && probe.value.count <= 2049)
      assert.equal(edges[0].sql !== normalizeWindowEdgeSql(edges[0].sql), probe.value.count <= 2048)
    }
  }
}

export function countWindowEdgeWork(Store, database) {
  const original = Store.prototype.getDocumentWindow
  const counts = { probes: 0, probeCandidates: 0, maxProbeCandidates: 0, booleanReads: 0, pairReads: 0, edgeRows: 0, maxEdgeRows: 0 }
  Store.prototype.getDocumentWindow = function (...args) {
    if (this.filename !== database) return original.apply(this, args)
    const prepare = this.db.prepare
    this.db.prepare = function (sql) {
      const statement = prepare.call(this, sql)
      if (isWindowEdgeProbeSql(sql)) {
        const get = statement.get
        statement.get = function (...params) {
          const value = get.apply(this, params)
          counts.probes++; counts.probeCandidates += value.count
          counts.maxProbeCandidates = Math.max(counts.maxProbeCandidates, value.count)
          return value
        }
      }
      if (isWindowEdgeSql(sql)) {
        const all = statement.all
        statement.all = function (...params) {
          const value = all.apply(this, params)
          counts[sql === normalizeWindowEdgeSql(sql) ? 'pairReads' : 'booleanReads']++
          counts.edgeRows += value.length; counts.maxEdgeRows = Math.max(counts.maxEdgeRows, value.length)
          return value
        }
      }
      return statement
    }
    try { return original.apply(this, args) } finally { this.db.prepare = prepare }
  }
  return { counts, reset() { for (const key of Object.keys(counts)) counts[key] = 0 }, stop() { Store.prototype.getDocumentWindow = original } }
}
