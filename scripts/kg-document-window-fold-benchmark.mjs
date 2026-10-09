// Optional: node scripts/kg-document-window-fold-benchmark.mjs [baseline-revision] [--validate-only]
// Complete Store and prepared matching stages are measured separately.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openSqliteStore } from '../src/kg-store.mjs'
import { baselineModules } from './kg-document-window-diagnostics-benchmark.mjs'
import { ordinaryWindowFixture } from './kg-document-window-ordinary-query-benchmark.mjs'
import { isWindowQuerySql, isWindowQueryFoldSql, assertWindowQueryCallParity } from './kg-document-window-query-benchmark.mjs'

function capture(store, id, options) {
  const prepare = store.db.prepare, calls = []
  store.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    for (const method of ['get', 'all']) {
      const execute = statement[method]
      statement[method] = function (...params) {
        const value = execute.apply(this, params); calls.push({ sql, method, params, value }); return value
      }
    }
    return statement
  }
  try { return { window: store.getDocumentWindow(id, options), calls } }
  finally { store.db.prepare = prepare }
}
const median = values => [...values].sort((a, b) => a - b)[4]
function timePair(runs) {
  for (let i = 0; i < 3; i++) { runs[0](); runs[1]() }
  const times = [[], []]
  for (let trial = 0; trial < 9; trial++) for (const index of trial % 2 ? [1, 0] : [0, 1]) {
    const start = performance.now(); runs[index](); times[index].push(performance.now() - start)
  }
  return { beforeMedianMs: median(times[0]), currentMedianMs: median(times[1]) }
}
async function benchmark() {
  const validateOnly = process.argv.includes('--validate-only'), args = process.argv.slice(2).filter(arg => arg !== '--validate-only')
  if (args.length > 1 || args.some(arg => arg.startsWith('-'))) throw new Error('Expected an optional baseline revision and --validate-only')
  const revision = args[0] || 'f710ff5', baseline = (await baselineModules(revision)).store
  const directory = mkdtempSync(join(tmpdir(), 'kg-window-fold-benchmark-')), samples = []
  try {
    for (const [size, quoteChars] of [[64, 0], [12000, 64], [96000, 64], [96000, 1024]]) {
      const database = join(directory, size + '-' + quoteChars + '.sqlite')
      const fixture = ordinaryWindowFixture(size, 'fold-benchmark-' + size + '-' + quoteChars)
      for (const node of fixture.graph.nodes) node.quote += 'x'.repeat(quoteChars)
      const seed = await openSqliteStore(database)
      try { seed.saveGraph(fixture.graph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits }) }
      finally { seed.close() }
      const previous = await baseline.openSqliteStore(database), current = await openSqliteStore(database)
      try {
        for (const sensitive of [false, true]) {
          previous.db.exec('PRAGMA case_sensitive_like = ' + (sensitive ? 'ON' : 'OFF'))
          current.db.exec('PRAGMA case_sensitive_like = ' + (sensitive ? 'ON' : 'OFF'))
          for (const [kind, query, limit] of sensitive ? [
            ['single-match', 'observation ' + (size - 1) + '.', 200], ['empty-query', 'absentordinary', 200],
            ['exact-budget', 'windowexact', 200], ['many-matches', 'fact', 800],
            ['literal-empty', 'absent_%', 200], ['ordinary-page', '', 200],
          ] : [
            ['single-match', 'observation ' + (size - 1) + '.', 200], ['empty-query', 'absentordinary', 200],
            ['exact-budget', 'windowexact', 200], ['underfilled-budget', 'windowexact', 800],
            ['underfilled-199', 'windowunder', 200], ['many-matches', 'fact', 200], ['many-matches', 'fact', 800],
            ['large-budget', 'observation', 2000], ['opaque-id', 'node17', 200],
            ['literal-id', 'node_17', 200], ['literal-empty', 'absent_%', 200], ['ordinary-page', '', 200],
          ]) {
            const options = { limit, query, includeSourceText: false }
            const before = capture(previous, fixture.documentId, options), after = capture(current, fixture.documentId, options)
            assert.deepEqual(after.window, before.window)
            assertWindowQueryCallParity(before.calls, after.calls, after.window)
            const other = call => !isWindowQuerySql(call.sql) && !isWindowQueryFoldSql(call.sql)
            assert.deepEqual(after.calls.filter(other), before.calls.filter(other),
              'All other SQL, parameters, complete Native values and execution order must remain identical')
            const guard = after.calls.find(call => isWindowQueryFoldSql(call.sql))
            if (guard) assert.equal(guard.value.folds_ascii, sensitive ? 0 : 1)
            const whole = validateOnly ? undefined : timePair([
              () => previous.getDocumentWindow(fixture.documentId, options),
              () => current.getDocumentWindow(fixture.documentId, options),
            ])
            const stages = [before, after].map((capture, index) => capture.calls
              .filter(call => isWindowQuerySql(call.sql) || isWindowQueryFoldSql(call.sql))
              .map(call => ({ ...call, statement: [previous, current][index].db.prepare(call.sql) })))
            const matching = validateOnly || !stages[0].length ? undefined : timePair(stages.map(calls => () => {
              for (const call of calls) call.statement[call.method](...call.params)
            }))
            samples.push({ nodes: size, edges: fixture.graph.edges.length, quoteChars, kind, query, limit, sensitive,
              matched: after.window.view.matchedNodes, returnedNodes: after.window.nodes.length, foldChecks: guard ? 1 : 0,
              cast: after.calls.some(call => call.sql.includes('CAST(node_id AS TEXT) LIKE ?')), whole, matching })
          }
        }
      } finally { previous.close(); current.close() }
    }
    console.log(JSON.stringify({ ok: true, baseline: revision, cases: samples.length, validationOnly: validateOnly,
      completeWindowsAndNativeMatchingAndOtherSqlIdentical: true, samples,
      scope: 'Complete Store windows and prepared guard/get plus matching SELECT/all and COUNT/get measured separately, never added. Real native query/parameter/full-record/count/order parity and unrelated SQL parity outside timing. Three warmups and nine alternating trials. No inspector, HTTP, browser rendering or CI timing gate; literal, ordinary page, small graph and case-sensitive fallback controls included.' }))
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await benchmark()
