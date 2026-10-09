// Optional: node scripts/kg-document-window-totals-benchmark.mjs [baseline-revision] [--validate-only]
// Warm complete Store windows; SQL/value parity and work counts are outside timing.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openSqliteStore } from '../src/kg-store.mjs'
import { createGenerationStructureTools } from '../src/kg-generation-structure.mjs'
import { baselineModules, diagnosticFixture } from './kg-document-window-diagnostics-benchmark.mjs'

const totalSql = sql => /^SELECT COUNT\(\*\) AS count FROM graph_(nodes|edges) WHERE document_id = \?$/.test(sql)
function capture(store, id, options, inspect) {
  const prepare = store.db.prepare, calls = []
  store.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    for (const method of ['get', 'all']) {
      const execute = statement[method]
      statement[method] = function (...params) {
        const value = execute.apply(this, params)
        calls.push({ sql, method, params, value })
        return value
      }
    }
    return statement
  }
  try { return { window: store.getDocumentWindow(id, options, inspect), calls } }
  finally { store.db.prepare = prepare }
}
const median = values => [...values].sort((a, b) => a - b)[4]
function timePair(runs) {
  for (let i = 0; i < 3; i++) { runs[0](); runs[1]() }
  const times = [[], []]
  for (let i = 0; i < 9; i++) for (const index of i % 2 ? [1, 0] : [0, 1]) {
    const started = performance.now()
    runs[index]()
    times[index].push(performance.now() - started)
  }
  return { beforeMedianMs: median(times[0]), currentMedianMs: median(times[1]) }
}
async function benchmark() {
  const args = process.argv.slice(2), validateOnly = args.includes('--validate-only')
  const revisions = args.filter(arg => arg !== '--validate-only')
  assert(revisions.length <= 1 && revisions.every(arg => !arg.startsWith('-')))
  const revision = revisions[0] || 'f710ff5'
  const baseline = (await baselineModules(revision)).store
  const directory = mkdtempSync(join(tmpdir(), 'kg-window-totals-benchmark-'))
  const inspect = createGenerationStructureTools().inspect, samples = []
  try {
    for (const [size, quoteChars] of [[64, 0], [12000, 64], [96000, 64], [96000, 1024]]) {
      const database = join(directory, size + '-' + quoteChars + '.sqlite')
      const fixture = diagnosticFixture(size)
      for (const node of fixture.graph.nodes) node.quote += 'x'.repeat(quoteChars)
      const seed = await openSqliteStore(database)
      try { seed.saveGraph(fixture.graph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits }) }
      finally { seed.close() }
      const previous = await baseline.openSqliteStore(database), current = await openSqliteStore(database)
      const supported = current.db.isTransaction === false
      try {
        // Cold reads retain the same native COUNT results and complete hydration.
        const coldOptions = { limit: 200, includeSourceText: false }
        const beforeCold = capture(previous, fixture.documentId, coldOptions, inspect)
        const afterCold = capture(current, fixture.documentId, coldOptions, inspect)
        assert.deepEqual(afterCold, beforeCold)
        for (const [kind, options, diagnostic, transaction] of [
          ['first-200', { limit: 200 }, true, false],
          ['last-200', { limit: 200, offset: Math.max(0, size - 200) }, true, false],
          ['middle-800', { limit: 800, offset: Math.floor(size / 2) }, true, false],
          ['last-2000', { limit: 2000, offset: Math.max(0, size - 2000) }, true, false],
          ['single-match', { limit: 200, query: 'observation ' + (size - 1) + '.' }, true, false],
          ['empty-literal-query', { limit: 200, query: 'absent_%' }, true, false],
          ['without-inspector', { limit: 200, offset: Math.max(0, size - 200) }, false, false],
          ...(size <= 12000 ? [['enclosing-transaction', { limit: 200 }, true, true]] : []),
        ]) {
          options.includeSourceText = false
          if (transaction) { previous.db.exec('BEGIN'); current.db.exec('BEGIN') }
          try {
            const fn = diagnostic ? inspect : undefined
            const before = capture(previous, fixture.documentId, options, fn)
            const after = capture(current, fixture.documentId, options, fn)
            assert.deepEqual(after.window, before.window)
            assert.deepEqual(after.calls.filter(call => !totalSql(call.sql)), before.calls.filter(call => !totalSql(call.sql)),
              'Every other SQL statement, parameter and native value must remain identical')
            const oldCounts = before.calls.filter(call => totalSql(call.sql)), newCounts = after.calls.filter(call => totalSql(call.sql))
            assert.equal(oldCounts.length, 2)
            const reuse = supported && diagnostic && !transaction
            assert.deepEqual(newCounts, reuse ? [] : oldCounts)
            assert.equal(after.window.view.totalNodes, fixture.graph.nodes.length)
            assert.equal(after.window.view.totalEdges, fixture.graph.edges.length)
            const whole = validateOnly ? undefined : timePair([
              () => previous.getDocumentWindow(fixture.documentId, options, fn),
              () => current.getDocumentWindow(fixture.documentId, options, fn),
            ])
            samples.push({ nodes: size, edges: fixture.graph.edges.length, quoteChars, kind,
              returnedNodes: after.window.nodes.length, beforeTotalCounts: oldCounts.length, currentTotalCounts: newCounts.length,
              cacheSupported: supported, whole })
          } finally { if (transaction) { previous.db.exec('ROLLBACK'); current.db.exec('ROLLBACK') } }
        }
      } finally { previous.close(); current.close() }
    }
    console.log(JSON.stringify({ ok: true, baseline: revision, cases: samples.length, validationOnly: validateOnly,
      completeWindowsAndOtherNativeSqlIdentical: true, scope: 'Complete Store windows with the real structural inspector; 3 warmups and 9 alternating trials. Excludes HTTP, browser rendering and instrumentation.', samples }))
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await benchmark()
