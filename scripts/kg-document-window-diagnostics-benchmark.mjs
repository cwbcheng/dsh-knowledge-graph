// Optional timing diagnostic: node scripts/kg-document-window-diagnostics-benchmark.mjs [baseline-git-revision]
// HTTP/SQLite timings include instrumentation and JSON, not browser rendering.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { openSqliteStore } from '../src/kg-store.mjs'
import { createGenerationStructureTools } from '../src/kg-generation-structure.mjs'

export function diagnosticFixture(size = 12000) {
  const documentId = 'window-diagnostic-fixture'
  const paragraphs = Array.from({ length: size }, (_, i) => 'Isolated source observation ' + i + '.')
  const bodySize = Math.floor(size * 0.8)
  const searchedTargets = Math.min(300, size)
  const graph = {
    source: { id: documentId, documentId, title: 'Window diagnostics fixture', sections: [
      { id: 'body', title: '正文', startParagraph: 0, endParagraph: bodySize - 1 },
      { id: 'notes', title: '来源说明', startParagraph: bodySize, endParagraph: size - 1 },
    ] },
    generation: { relationDiscovery: { status: 'partial', totalTargets: size, searchedTargets, remainingTargets: size - searchedTargets } },
    nodes: paragraphs.map((text, i) => ({ id: 'n' + i, type: i % 4 ? 'fact' : 'concept', text, quote: text,
      paragraph: i, sectionId: i < bodySize ? 'body' : 'notes',
      evidence: [{ documentId, sourceId: documentId, paragraph: i, quote: text }] })),
    edges: Array.from({ length: size - 32 }, (_, i) => [1, 2, 3].map(distance => ({
      fromNodeId: 'n' + i, toNodeId: 'n' + (i + distance), relation: 'supports',
      evidence: [{ paragraph: i, quote: paragraphs[i] }],
    }))).flat(),
  }
  return { documentId, graph, sourceText: paragraphs.join('\n\n'), sourceUnits: paragraphs.map((text, paragraph) => ({ paragraph, text })) }
}

export function countHydration(Store, database) {
  const original = Store.prototype.getDocumentWindow
  const counts = { nodes: 0, edges: 0, fullNodeReads: 0, fullEdgeReads: 0, requests: 0 }
  Store.prototype.getDocumentWindow = function (...args) {
    if (this.filename !== database) return original.apply(this, args)
    counts.requests++
    const prepare = this.db.prepare
    this.db.prepare = function (sql) {
      const statement = prepare.call(this, sql)
      const table = /^SELECT \* FROM graph_(nodes|edges)\b/.exec(sql)?.[1]
      if (table) {
        const all = statement.all
        statement.all = function (...params) {
          const rows = all.apply(this, params)
          counts[table] += rows.length
          if (!/\bLIMIT\b/.test(sql)) counts[table === 'nodes' ? 'fullNodeReads' : 'fullEdgeReads']++
          return rows
        }
      }
      return statement
    }
    try { return original.apply(this, args) } finally { this.db.prepare = prepare }
  }
  return { counts, reset() { for (const key of Object.keys(counts)) counts[key] = 0 },
    stop() { Store.prototype.getDocumentWindow = original } }
}

export async function startDiagnosticHost(database, host) {
  const previous = process.env.DSH_KG_DB
  process.env.DSH_KG_DB = database
  const routes = []
  host.apply({ get: name => name === 'webServer' ? { register: route => { routes.push(route); return () => {} } } : null,
    effect: fn => fn(), interval: () => () => {} })
  const handler = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  const server = createServer((req, res) => handler(req, res))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { post: async body => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/document-load', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(response.status, 200)
    return response.json()
  }, stop: async () => {
    await new Promise(resolve => server.close(resolve))
    if (previous === undefined) delete process.env.DSH_KG_DB
    else process.env.DSH_KG_DB = previous
  } }
}

async function baselineModules(revision) {
  const show = file => execFileSync('git', ['show', revision + ':' + file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  // Only replace the store under test; refuse a baseline with a different host or domain helpers.
  const hostSource = show('lib/index.js')
  const normalizeHost = source => source.replace(/\r\n/g, '\n').replace(/^export const hostBuildSha256 = '[a-f0-9]+'\n/, '')
  assert.equal(normalizeHost(hostSource), normalizeHost(readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')),
    'Only the generated build digest may differ between hosts')
  const storeSource = show('lib/kg-store.mjs').replace(/from '(\.\/[^']+)'/g, (whole, file) => {
    const url = new URL('../lib/' + file.slice(2), import.meta.url)
    assert.equal(show('lib/' + file.slice(2)).replace(/\r\n/g, '\n'), readFileSync(url, 'utf8').replace(/\r\n/g, '\n'))
    return 'from ' + JSON.stringify(url.href)
  })
  const storeUrl = 'data:text/javascript;base64,' + Buffer.from(storeSource).toString('base64')
  const hostUrl = 'data:text/javascript;base64,' + Buffer.from(hostSource.replace("from './kg-store.mjs'", 'from ' + JSON.stringify(storeUrl))).toString('base64')
  return { store: await import(storeUrl), host: await import(hostUrl) }
}

async function benchmark() {
  const revision = process.argv[2]
  if (revision?.startsWith('-')) throw new Error('Expected an optional baseline git revision')
  const variants = []
  if (revision) variants.push({ name: revision, ...await baselineModules(revision) })
  variants.push({ name: 'current', host: await import('../lib/index.js'), store: await import('../lib/kg-store.mjs') })
  const fixture = diagnosticFixture()
  const expected = createGenerationStructureTools().inspect(fixture.graph)
  const directory = mkdtempSync(join(tmpdir(), 'kg-window-diagnostics-benchmark-'))
  const database = join(directory, 'graph.sqlite')
  const seed = await openSqliteStore(database)
  seed.saveGraph(fixture.graph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
  seed.close()
  try {
    for (const variant of variants) {
      const elapsed = [], totals = []
      for (let trial = 0; trial < 5; trial++) {
        const host = await startDiagnosticHost(database, variant.host)
        const meter = countHydration(variant.store.SqliteKnowledgeStore, database)
        try {
          const opened = await host.post({ documentId: fixture.documentId, nodeLimit: 800 })
          assert.deepEqual(opened.graph.graphStructureQuality, expected)
          const opening = { ...meter.counts }
          meter.reset()
          const started = performance.now()
          for (const nodeOffset of [800, 1600, 2400, 11200]) {
            const response = await host.post({ documentId: fixture.documentId, nodeLimit: 800, nodeOffset, includeSourceText: false })
            assert.equal(response.graph.nodes.length, 800)
            assert.equal(response.graph.nodes[0].id, 'n' + nodeOffset)
            assert.equal(response.graph.view.totalNodes, fixture.graph.nodes.length)
            assert.deepEqual(response.graph.graphStructureQuality, expected)
          }
          elapsed.push(performance.now() - started)
          totals.push({ opening, pages: { ...meter.counts } })
        } finally { meter.stop(); await host.stop() }
      }
      assert(totals.every(value => JSON.stringify(value) === JSON.stringify(totals[0])), 'Deterministic hydration counts must agree')
      const median = [...elapsed].sort((a, b) => a - b)[2]
      console.log(JSON.stringify({ variant: variant.name, nodeCount: fixture.graph.nodes.length, edgeCount: fixture.graph.edges.length,
        nodeLimit: 800, trials: 5, fourPagesMedianMs: Math.round(median * 100) / 100,
        measurementsMs: elapsed.map(value => Math.round(value * 100) / 100), ...totals[0], canonicalDiagnosticsIdentical: true }))
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await benchmark()
