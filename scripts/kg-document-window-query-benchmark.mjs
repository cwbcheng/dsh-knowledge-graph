// Optional: node scripts/kg-document-window-query-benchmark.mjs [baseline-revision]
// Compare actual store windows. Literal-query results intentionally correct the
// old matches; ordinary-query windows and SQL must remain identical.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openSqliteStore, SqliteKnowledgeStore } from '../src/kg-store.mjs'
import { baselineModules, diagnosticFixture } from './kg-document-window-diagnostics-benchmark.mjs'

export function literalWindowFixture(size = 12000, documentId = 'window-literal-' + size) {
  assert(size >= 64)
  const fixture = diagnosticFixture(size)
  fixture.documentId = fixture.graph.source.id = fixture.graph.source.documentId = documentId
  const changes = new Map([
    [0, { id: 'node_17', text: 'Opaque identifier node_17 remains distinct.' }],
    [1, { id: 'node17', text: 'Opaque identifier node17 is a different node.' }],
    [4, { id: 'type-marker' }],
    [5, { text: 'Observation with a verbatim quote.', quote: 'Quote token q%_uote is recorded.' }],
    [6, { text: 'Unicode token 中_%_😀 remains literal.' }],
    [7, { id: "n')_% OR 1=1 --", text: 'An opaque identifier is data.' }],
    [size - 30, { text: 'Fixture path C:\\source\\_unit is recorded.' }],
    [size - 29, { text: 'Fixture completion rate is 100%.' }],
    [size - 28, { id: 'literal%_target', text: 'Fixture literal token %_ is recorded.' }],
    [size - 26, { sectionId: 'chapter_17', sectionTitle: 'Section_17' }],
  ])
  const identities = new Map()
  fixture.graph.nodes = fixture.graph.nodes.map((node, index) => {
    const change = changes.get(index) || {}, quote = change.quote || change.text || node.quote
    const next = { ...node, ...change, quote, evidence: [{ documentId, sourceId: documentId, paragraph: index, quote }] }
    identities.set(node.id, next.id)
    return next
  })
  fixture.sourceUnits = fixture.graph.nodes.map(node => ({ paragraph: node.paragraph, text: node.quote }))
  fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
  fixture.graph.edges = fixture.graph.edges.map(edge => ({ ...edge,
    fromNodeId: identities.get(edge.fromNodeId), toNodeId: identities.get(edge.toNodeId),
    evidence: edge.evidence.map(item => ({ ...item, quote: fixture.sourceUnits[item.paragraph].text })) }))
  fixture.graph.source.sections.push({ id: 'chapter_17', title: 'Section_17', startParagraph: size - 26, endParagraph: size - 26 })
  fixture.graph.custom = { original: '联结模型 / 内涵 / 陪域 / 槽位', literalFixture: true }
  fixture.graph.staging = { chunks: [{ chunkId: 'literal-chunk', startParagraph: 0, endParagraph: size - 1,
    summary: 'Original chunk is retained', nodeIds: fixture.graph.nodes.slice(0, 8).map(node => node.id), edgeCount: 21 }] }
  return fixture
}

export const isWindowQuerySql = sql => sql.includes('LOWER(node_id) LIKE ?') || sql.includes('INSTR(LOWER(node_id), ?) > 0')
export function countWindowQueryWork(Store, database) {
  const original = Store.prototype.getDocumentWindow
  const counts = { queries: 0, literalQueries: 0, ordinaryQueries: 0, matched: 0, directRows: 0, maxDirectRows: 0,
    matchingStatements: 0, matchCountReads: 0 }
  Store.prototype.getDocumentWindow = function (...args) {
    if (this.filename !== database) return original.apply(this, args)
    const prepare = this.db.prepare
    let queryKind = '', nativeMatched = null, nativeDirect = 0
    this.db.prepare = function (sql) {
      const statement = prepare.call(this, sql)
      if (isWindowQuerySql(sql)) for (const method of ['get', 'all']) {
        const execute = statement[method]
        statement[method] = function (...params) {
          const value = execute.apply(this, params)
          queryKind = sql.includes('INSTR(') ? 'literalQueries' : 'ordinaryQueries'
          counts.matchingStatements++
          if (method === 'get') {
            nativeMatched = value.count; counts.matchCountReads++
          } else {
            nativeDirect += value.length; counts.directRows += value.length
            counts.maxDirectRows = Math.max(counts.maxDirectRows, value.length)
          }
          return value
        }
      }
      return statement
    }
    try { return original.apply(this, args) } finally {
      this.db.prepare = prepare
      if (queryKind) {
        counts.queries++; counts[queryKind]++
        counts.matched += nativeMatched ?? nativeDirect
      }
    }
  }
  return { counts, reset() { for (const key of Object.keys(counts)) counts[key] = 0 },
    stop() { Store.prototype.getDocumentWindow = original } }
}

function capture(store, id, options) {
  const prepare = store.db.prepare, statements = []
  store.db.prepare = function (sql) { if (isWindowQuerySql(sql)) statements.push(sql); return prepare.call(this, sql) }
  try { return { window: store.getDocumentWindow(id, options), statements } }
  finally { store.db.prepare = prepare }
}
const median = values => [...values].sort((a,b) => a-b)[4]
async function benchmark() {
  const revision = process.argv[2] || 'b967b9f'
  if (process.argv.length > 3) throw new Error('Expected at most one baseline revision')
  const baseline = (await baselineModules(revision)).store
  const directory = mkdtempSync(join(tmpdir(), 'kg-window-query-benchmark-')), database = join(directory, 'graph.sqlite')
  const current = await openSqliteStore(database)
  let previous, meter, oldMeter
  try {
    const fixtures = [12000, 96000].map(size => literalWindowFixture(size))
    for (const fixture of fixtures) current.saveGraph(fixture.graph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
    previous = await baseline.openSqliteStore(database)
    oldMeter = countWindowQueryWork(baseline.SqliteKnowledgeStore, database)
    meter = countWindowQueryWork(SqliteKnowledgeStore, database)
    const samples = []
    for (const fixture of fixtures) for (const query of ['node_17', '100%', '%', '_', '%_', 'C:\\source\\_unit', 'absent_%', 'observation 11999.', 'not-in-this-source']) {
      const options = { query, limit: 800, includeSourceText: false }
      oldMeter.reset(); meter.reset()
      const before = capture(previous, fixture.documentId, options), after = capture(current, fixture.documentId, options)
      const expected = fixture.graph.nodes.filter(node => [node.id, node.type, node.text, node.quote, node.sectionId, node.sectionTitle]
        .some(value => String(value || '').replace(/[A-Z]/g, letter => letter.toLowerCase()).includes(query.toLowerCase())))
      assert.equal(after.window.view.matchedNodes, expected.length)
      assert.deepEqual(after.window.nodes.slice(0, Math.min(800, expected.length)).map(node => node.id), expected.slice(0, 800).map(node => node.id))
      if (!/[%_]/.test(query)) { assert.deepEqual(after.window, before.window); assert.deepEqual(after.statements, before.statements) }
      samples.push({ nodes: fixture.graph.nodes.length, documentId: fixture.documentId, query,
        beforeMatched: before.window.view.matchedNodes, currentMatched: after.window.view.matchedNodes,
        beforeReturned: before.window.nodes.length, currentReturned: after.window.nodes.length,
        before: { ...oldMeter.counts }, current: { ...meter.counts } })
    }
    oldMeter.stop(); oldMeter = null; meter.stop(); meter = null
    for (const sample of samples) {
      const options = { query: sample.query, limit: 800, includeSourceText: false }, times = [[], []]
      const runs = [() => previous.getDocumentWindow(sample.documentId, options), () => current.getDocumentWindow(sample.documentId, options)]
      for (let i = 0; i < 3; i++) { runs[0](); runs[1]() }
      for (let i = 0; i < 9; i++) {
        const order = i % 2 ? [1, 0] : [0, 1]
        for (const index of order) { const start = performance.now(); runs[index](); times[index].push(performance.now()-start) }
      }
      sample.beforeMedianMs = median(times[0]); sample.currentMedianMs = median(times[1])
    }
    console.log(JSON.stringify({ ok: true, baseline: revision, repeats: 9, limit: 800,
      scope: 'Complete store windows; no inspector, HTTP or rendering; Native counters outside timing; literal matches intentionally change, not a same-result speed claim', samples }))
  } finally { meter?.stop(); oldMeter?.stop(); previous?.close(); current.close(); rmSync(directory, { recursive: true, force: true }) }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await benchmark()
