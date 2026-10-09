// Optional: node scripts/kg-document-window-edges-benchmark.mjs [baseline-revision] [--validate-only]
// Complete identical Store windows and prepared probe/edge stages, separately.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openSqliteStore, SqliteKnowledgeStore } from '../src/kg-store.mjs'
import { baselineModules } from './kg-document-window-diagnostics-benchmark.mjs'
import { ordinaryWindowFixture } from './kg-document-window-ordinary-query-benchmark.mjs'
import { incidentShapeFixture } from './kg-document-window-incident-benchmark.mjs'
import { isWindowEdgeSql, isWindowEdgeProbeSql, assertWindowEdgeCallParity, countWindowEdgeWork } from './kg-document-window-edge-reads.mjs'

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
  try { return { window: store.getDocumentWindow(id, options), calls } } finally { store.db.prepare = prepare }
}
const median = values => [...values].sort((a, b) => a - b)[4]
function timePair(runs) {
  for (let i = 0; i < 3; i++) { runs[0](); runs[1]() }
  const times = [[], []]
  for (let i = 0; i < 9; i++) for (const index of i % 2 ? [1, 0] : [0, 1]) {
    const start = performance.now(); runs[index](); times[index].push(performance.now() - start)
  }
  return { beforeMedianMs: median(times[0]), currentMedianMs: median(times[1]) }
}
async function benchmark() {
  const validateOnly = process.argv.includes('--validate-only'), args = process.argv.slice(2).filter(arg => arg !== '--validate-only')
  if (args.length > 1 || args.some(arg => arg.startsWith('-'))) throw new Error('Expected an optional baseline revision and --validate-only')
  const revision = args[0] || '82d96ce', baseline = (await baselineModules(revision)).store
  const directory = mkdtempSync(join(tmpdir(), 'kg-window-edges-benchmark-')), database = join(directory, 'graph.sqlite')
  const current = await openSqliteStore(database)
  let previous, meter, oldMeter
  try {
    const fixtures = []
    for (const [shape, size, quoteChars] of [
      ...[12000, 96000].flatMap(size => [64, 1024].map(chars => ['chain', size, chars])),
      ['dense', 800, 0], ['hub', 12000, 0], ['outside', 12000, 0], ['small', 64, 0],
    ]) {
      const id = 'edges-benchmark-' + shape + '-' + size + '-' + quoteChars
      const fixture = shape === 'chain' ? ordinaryWindowFixture(size, id) : incidentShapeFixture(shape, size, id)
      for (const node of fixture.graph.nodes) node.quote += 'x'.repeat(quoteChars)
      current.saveGraph(fixture.graph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
      fixtures.push({ shape, size, quoteChars, id })
    }
    for (const bound of [2048, 2049]) {
      const id = 'edges-benchmark-bound-' + bound, fixture = ordinaryWindowFixture(1600, id)
      const selected = new Set(fixture.graph.nodes.slice(0, 64).map(node => node.id))
      fixture.graph.edges = fixture.graph.edges.filter(edge => !selected.has(edge.fromNodeId))
      for (let i = 0; i < bound - 1; i++) fixture.graph.edges.push({ fromNodeId: fixture.graph.nodes[0].id,
        toNodeId: fixture.graph.nodes[64 + Math.floor(i / 2)].id, relation: i % 2 ? 'supports' : 'relates_to',
        evidence: [{ paragraph: 0, quote: 'Bounded outgoing ' + i }], custom: { retained: 'x'.repeat(1024) } })
      fixture.graph.edges.push({ fromNodeId: fixture.graph.nodes[1].id, toNodeId: fixture.graph.nodes[2].id, relation: 'supports' })
      current.saveGraph(fixture.graph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
      fixtures.push({ shape: 'bound', size: 1600, quoteChars: 0, bound, id })
    }
    previous = await baseline.openSqliteStore(database)
    const results = []
    async function phase(analyzed) {
      meter = countWindowEdgeWork(SqliteKnowledgeStore, database); oldMeter = countWindowEdgeWork(baseline.SqliteKnowledgeStore, database)
      const samples = []
      for (const fixture of fixtures) {
        const cases = analyzed ? (fixture.shape === 'chain' ? [['first-page', 64], ['first-page', 200]] : []) : fixture.shape === 'chain' ? [
          ...[20, 63, 64, 65, 200, 800, 2000].map(limit => ['first-page', limit]),
          ['last-page', 64], ['last-page', 200], ['windowunder', 200], ['windowunder', 800],
          ['windowexact', 200], ['windowexact', 800], ['observation 11', 2000], ['%_', 800], ['absent_%', 800],
        ] : fixture.shape === 'bound' ? [['bound-default', 64], ['bound-full', 64]]
          : [20, 63, 64, 200, 800, 2000].map(limit => ['first-page', limit])
        for (const [kind, limit] of cases) {
          const options = { limit, includeSourceText: false,
            ...(kind === 'last-page' ? { offset: fixture.size - limit } : kind === 'bound-full' ? { edgeLimit: 12000 }
              : kind === 'first-page' || kind === 'bound-default' ? {} : { query: kind }) }
          meter.reset(); oldMeter.reset()
          const before = capture(previous, fixture.id, options), after = capture(current, fixture.id, options)
          assert.deepEqual(after.window, before.window); assertWindowEdgeCallParity(before.calls, after.calls)
          const unrelated = call => !isWindowEdgeSql(call.sql) && !isWindowEdgeProbeSql(call.sql)
          assert.deepEqual(after.calls.filter(unrelated), before.calls.filter(unrelated), 'All unrelated SQL, params, Native values and execution order must be identical')
          assert.equal(meter.counts.edgeRows, oldMeter.counts.edgeRows)
          const n = after.window.nodes.length, needed = n >= 64 && after.window.view.totalEdges >= n * n
          assert.equal(meter.counts.probes, needed ? 1 : 0); assert(meter.counts.maxProbeCandidates <= 2049)
          if (fixture.shape === 'bound') assert.equal(meter.counts.probeCandidates, fixture.bound)
          const plans = after.calls.filter(call => isWindowEdgeProbeSql(call.sql) || isWindowEdgeSql(call.sql)).map(call => ({
            method: call.method, plan: current.db.prepare('EXPLAIN QUERY PLAN ' + call.sql).all(...call.params).map(row => row.detail),
          }))
          samples.push({ ...fixture, analyzed, kind, limit, options, before, after, plans,
            beforeWork: { ...oldMeter.counts }, currentWork: { ...meter.counts } })
        }
      }
      meter.stop(); meter = null; oldMeter.stop(); oldMeter = null
      for (const sample of samples) {
        const whole = validateOnly ? undefined : timePair([
          () => previous.getDocumentWindow(sample.id, sample.options), () => current.getDocumentWindow(sample.id, sample.options),
        ])
        const stages = [sample.before, sample.after].map((captured, index) => captured.calls
          .filter(call => isWindowEdgeSql(call.sql) || isWindowEdgeProbeSql(call.sql))
          .map(call => ({ ...call, statement: [previous, current][index].db.prepare(call.sql) })))
        const edges = validateOnly || !stages[0].length ? undefined : timePair(stages.map(calls => () => {
          for (const call of calls) call.statement[call.method](...call.params)
        }))
        results.push({ nodes: sample.size, shape: sample.shape, quoteChars: sample.quoteChars, bound: sample.bound, analyzed,
          kind: sample.kind, limit: sample.limit, matched: sample.after.window.view.matchedNodes, returnedNodes: sample.after.window.nodes.length,
          beforeWork: sample.beforeWork, currentWork: sample.currentWork, whole, edges, plans: sample.plans })
      }
    }
    await phase(false)
    current.db.exec('ANALYZE')
    await phase(true)
    console.log(JSON.stringify({ ok: true, baseline: revision, cases: results.length, validationOnly: validateOnly, repeats: validateOnly ? 0 : 9, samples: results,
      scope: 'Identical complete production Store windows; window edge SQL may only switch boolean membership vs direct IN, preserving document/selected IDs/budget and every complete Native edge in order; all unrelated SQL, parameters, Native values and execution sequence strictly identical; prepared bounded aggregate plus edge reads timed separately, not added to whole Store; ANALYZE performed only after the first phase is fully measured; equivalence/counters/plans outside timing; excludes inspector, HTTP, browser rendering and CI performance gates' }))
  } finally { meter?.stop(); oldMeter?.stop(); previous?.close(); current.close(); rmSync(directory, { recursive: true, force: true }) }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await benchmark()
