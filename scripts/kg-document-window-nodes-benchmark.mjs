// Optional: node scripts/kg-document-window-nodes-benchmark.mjs
// Frozen b389b313 node SELECT versus the SQL captured from production windows.
// Measures prepared SELECT/all only, not node JSON conversion, other window
// queries, diagnostics, HTTP, view construction or browser rendering.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'

const oldSql = 'SELECT * FROM graph_nodes WHERE document_id = ? ORDER BY paragraph, node_id LIMIT ? OFFSET ?'
const directory = mkdtempSync(join(tmpdir(), 'kg-window-nodes-benchmark-'))
const store = await openSqliteStore(join(directory, 'graph.sqlite'))
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
function capture(id, limit, offset) {
  const prepare = store.db.prepare
  let query
  store.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (sql.startsWith('SELECT * FROM graph_nodes') && sql.includes('OFFSET')) {
      const all = statement.all
      statement.all = function (...args) { query = { sql, args }; return all.apply(this, args) }
    }
    return statement
  }
  try { const window = store.getDocumentWindow(id, { limit, offset, includeSourceText: false }); return { window, query } }
  finally { store.db.prepare = prepare }
}
try {
  const samples = []
  for (const shape of [
    { count: 12000, quoteChars: 64, peers: 1 }, { count: 12000, quoteChars: 1024, peers: 1 },
    { count: 96000, quoteChars: 64, peers: 1 }, { count: 96000, quoteChars: 1024, peers: 1 },
    { count: 12000, quoteChars: 1024, peers: 100 },
  ]) {
    const id = 'node-window-' + JSON.stringify(shape)
    const quote = 'Source observation '.repeat(Math.ceil(shape.quoteChars / 19)).slice(0, shape.quoteChars)
    const nodes = Array.from({ length: shape.count }, (_, i) => ({ id: 'opaque-' + (shape.count - i).toString(36),
      type: 'fact', text: 'Observation ' + i, quote, paragraph: Math.floor(i / shape.peers) }))
    store.saveGraph({ source: { documentId: id }, nodes, edges: [] }, { sourceText: '' })
    const before = store.db.prepare(oldSql)
    for (const limit of [200, 800, 2000]) for (const offset of [0, limit, limit * 4, Math.floor(shape.count / 2), shape.count - limit]) {
      const { window, query } = capture(id, limit, offset)
      const after = store.db.prepare(query.sql), args = [id, limit, offset]
      assert.deepEqual(after.all(...query.args), before.all(...args))
      assert.equal(query.sql.includes('rowid IN'), offset >= limit * 4)
      assert.equal(window.nodes.length, limit)
      for (let warm = 0; warm < 3; warm++) { before.all(...args); after.all(...query.args) }
      const times = [[], []]
      for (let run = 0; run < 9; run++) {
        const pair = [[before, args, times[0]], [after, query.args, times[1]]]
        if (run % 2) pair.reverse()
        for (const [statement, params, values] of pair) {
          const start = performance.now(); statement.all(...params); values.push(performance.now() - start)
        }
      }
      samples.push({ ...shape, limit, offset, deferred: query.sql.includes('rowid IN'),
        beforeMedianMs: median(times[0]), currentMedianMs: median(times[1]),
        ...(limit === 800 && offset === shape.count - limit ? {
          beforePlan: store.db.prepare('EXPLAIN QUERY PLAN ' + oldSql).all(...args).map(row => row.detail),
          currentPlan: store.db.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.args).map(row => row.detail),
        } : {}) })
    }
  }
  console.log(JSON.stringify({ ok: true, baseline: 'b389b313 frozen node SELECT', repeats: 9, cases: samples.length,
    scope: 'prepared node SELECT/all only; excludes JSON parsing, remaining window queries, diagnostics, HTTP, view and DOM', samples }))
} finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
