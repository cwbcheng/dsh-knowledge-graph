// Optional: node scripts/kg-document-window-source-benchmark.mjs [baseline-revision]
// Document SELECT/get and complete store windows are timed separately. Native
// hydration counts are measured outside timings; HTTP and rendering are excluded.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openSqliteStore, SqliteKnowledgeStore } from '../src/kg-store.mjs'
import { baselineModules } from './kg-document-window-diagnostics-benchmark.mjs'

const documentRead = sql => /^SELECT .* FROM documents WHERE document_id = \?$/.test(sql)
export function countWindowSourceHydration(Store, database) {
  const original = Store.prototype.getDocumentWindow
  const counts = { documentRows: 0, sourceTextReads: 0, sourceTextBytes: 0 }
  Store.prototype.getDocumentWindow = function (...args) {
    if (this.filename !== database) return original.apply(this, args)
    const prepare = this.db.prepare
    this.db.prepare = function (sql) {
      const statement = prepare.call(this, sql)
      if (documentRead(sql)) {
        const get = statement.get
        statement.get = function (...params) {
          const row = get.apply(this, params)
          if (row) {
            counts.documentRows++
            if (Object.hasOwn(row, 'source_text')) {
              counts.sourceTextReads++
              counts.sourceTextBytes += Buffer.byteLength(row.source_text || '')
            }
          }
          return row
        }
      }
      return statement
    }
    try { return original.apply(this, args) } finally { this.db.prepare = prepare }
  }
  return { counts, reset() { for (const key of Object.keys(counts)) counts[key] = 0 },
    stop() { Store.prototype.getDocumentWindow = original } }
}

function capture(store, id, options) {
  const prepare = store.db.prepare
  let sql
  store.db.prepare = function (query) {
    if (documentRead(query)) sql = query
    return prepare.call(this, query)
  }
  try { return { window: store.getDocumentWindow(id, options), sql } }
  finally { store.db.prepare = prepare }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
function timePair(before, after) {
  for (let i = 0; i < 3; i++) { before(); after() }
  const times = [[], []]
  for (let i = 0; i < 9; i++) {
    const pair = [[before, times[0]], [after, times[1]]]
    if (i % 2) pair.reverse()
    for (const [run, samples] of pair) { const start = performance.now(); run(); samples.push(performance.now() - start) }
  }
  return { beforeMedianMs: median(times[0]), currentMedianMs: median(times[1]) }
}

async function benchmark() {
  const revision = process.argv[2] || 'cce0a3e'
  if (process.argv.length > 3) throw new Error('Expected at most one baseline git revision')
  const baseline = (await baselineModules(revision)).store
  const directory = mkdtempSync(join(tmpdir(), 'kg-window-source-benchmark-'))
  const database = join(directory, 'graph.sqlite')
  const current = await openSqliteStore(database)
  let previous, oldMeter, meter
  try {
    const shapes = [0, 1024, 65536, 1048576, 8388608].map(bytes => ({ bytes, trace: false }))
    shapes.push({ bytes: 8388608, trace: true })
    for (const shape of shapes) {
      const sourceText = 'Source 原文 😀\n\n'.repeat(Math.ceil(shape.bytes / 20))
      const id = 'window-source-' + shape.bytes + '-' + shape.trace
      current.saveGraph({ source: { documentId: id, title: id },
        nodes: Array.from({ length: 12000 }, (_, i) => ({ id: 'n' + i, type: 'fact', text: 'Observation ' + i, paragraph: i })),
        edges: [], ...(shape.trace ? { traceText: sourceText } : {}) }, { sourceText })
      shape.id = id; shape.sourceBytes = Buffer.byteLength(sourceText); shape.sourceChars = sourceText.length
    }
    previous = await baseline.openSqliteStore(database)
    oldMeter = countWindowSourceHydration(baseline.SqliteKnowledgeStore, database)
    meter = countWindowSourceHydration(SqliteKnowledgeStore, database)
    const counts = []
    for (const shape of shapes) {
      const options = { limit: 800, offset: 11200, includeSourceText: false }
      oldMeter.reset(); meter.reset()
      const before = capture(previous, shape.id, options), after = capture(current, shape.id, options)
      assert.deepEqual(after.window, before.window, 'Complete source-omitted windows match the real baseline')
      assert.equal(meter.counts.sourceTextReads, 0)
      assert.equal(oldMeter.counts.sourceTextBytes, shape.sourceBytes)
      counts.push({ ...shape, before: { ...oldMeter.counts }, current: { ...meter.counts }, beforeSql: before.sql, currentSql: after.sql })
    }
    oldMeter.stop(); oldMeter = null; meter.stop(); meter = null
    const samples = []
    for (const shape of counts) {
      const before = previous.db.prepare(shape.beforeSql), after = current.db.prepare(shape.currentSql)
      for (const [key, value] of Object.entries(after.get(shape.id))) assert.deepEqual(value, before.get(shape.id)[key])
      const options = { limit: 800, offset: 11200, includeSourceText: false }
      const sqlTimes = timePair(() => before.get(shape.id), () => after.get(shape.id))
      const windowTimes = timePair(() => previous.getDocumentWindow(shape.id, options), () => current.getDocumentWindow(shape.id, options))
      const withSource = { ...options, includeSourceText: true }
      assert.deepEqual(current.getDocumentWindow(shape.id, withSource), previous.getDocumentWindow(shape.id, withSource))
      const requestedSourceControl = timePair(() => previous.getDocumentWindow(shape.id, withSource), () => current.getDocumentWindow(shape.id, withSource))
      samples.push({ ...shape, sqlTimes, windowTimes, requestedSourceControl })
    }
    console.log(JSON.stringify({ ok: true, baseline: revision, repeats: 9, nodes: 12000, limit: 800, offset: 11200,
      scope: 'SQL SELECT/get versus complete store window separately; no inspector, HTTP or rendering; hydration counters excluded from timings', samples }))
  } finally {
    meter?.stop(); oldMeter?.stop(); previous?.close(); current.close(); rmSync(directory, { recursive: true, force: true })
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await benchmark()
