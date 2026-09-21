import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { openSqliteStore, SqliteKnowledgeStore } from '../lib/kg-store.mjs'

// Optional read-only production input; all edits go to a disposable SQLite DB.
const documentId = process.env.KG_BENCH_DOCUMENT || 'document-deletion-benchmark'
let graph, sourceText
if (process.env.KG_BENCH_DOCUMENT) {
  const token = readFileSync('/tmp/dsh-kgsrc-web.log', 'utf8').match(/\?token=([A-Za-z0-9_-]+)/)?.[1]
  const read = async method => {
    const response = await fetch('http://127.0.0.1:3099/api/dsh-knowledge-graph/' + method, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, origin: 'http://127.0.0.1:3099', 'content-type': 'application/json' },
      body: JSON.stringify({ documentId, nodeLimit: 1 }),
    })
    if (!response.ok) throw new Error('Read failed: ' + response.status)
    const result = await response.json()
    if (result.error) throw new Error(result.error.message)
    return result
  }
  graph = (await read('document-export')).graph
  sourceText = (await read('document-load')).sourceText
} else {
  const nodes = Array.from({ length: 4700 }, (_, i) => ({ id: 'n' + i, type: 'fact', text: 'Material ' + i + ' describes the evidence for this specific observation.', paragraph: i, quote: 'Material ' + i + ' describes the evidence for this specific observation.' }))
  sourceText = nodes.map(node => node.text).join('\n\n')
  graph = { source: { id: 'source-benchmark', documentId }, nodes, edges: [] }
}
const metrics = {}
globalThis.kgMeasureDeletion = (name, fn) => {
  const start = performance.now()
  try { return fn() } finally {
    const entry = metrics[name] ||= { calls: 0, ms: 0 }
    entry.calls++; entry.ms += performance.now() - start
  }
}
for (const name of ['getDocument', 'getDocumentWindow', 'saveGraph', 'commitViewGraph']) {
  const original = SqliteKnowledgeStore.prototype[name]
  SqliteKnowledgeStore.prototype[name] = function (...args) { return kgMeasureDeletion(name, () => original.apply(this, args)) }
}
let host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8').replace("'./kg-store.mjs'", JSON.stringify(new URL('../lib/kg-store.mjs', import.meta.url).href))
for (const name of ['authenticateGraphEvidenceHost', 'validateGraphInvariantsHost', 'buildGraphViewHost', 'rememberCanonicalGraphHost']) {
  host = host.replace('function ' + name + '(', 'function ' + name + '(...args) { return globalThis.kgMeasureDeletion(' + JSON.stringify(name) + ', () => ' + name + 'Measured(...args)) }\nfunction ' + name + 'Measured(')
}
const plugin = await import('data:text/javascript;base64,' + Buffer.from(host).toString('base64'))
const dir = mkdtempSync(join(tmpdir(), 'kg-delete-benchmark-'))
process.env.DSH_KG_DB = join(dir, 'test.sqlite')
try {
  const store = await openSqliteStore(process.env.DSH_KG_DB)
  store.saveGraph(graph, { sourceText })
  const routes = []
  plugin.apply({ get: name => name === 'webServer' ? { register(spec) { routes.push(spec) } } : null, effect: fn => fn(), interval: () => () => {} })
  const api = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  const call = (method, body) => new Promise((resolve, reject) => {
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/api/dsh-knowledge-graph/' + method, headers: {} })
    api(req, { setHeader() {}, writeHead() {}, end(value) { resolve(JSON.parse(value)) } }).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
  const loaded = await call('document-load', { documentId, nodeLimit: 800 })
  const sandbox = { window: { React: {} }, console }
  runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), sandbox)
  const view = kgMeasureDeletion('client.makeView.before', () => sandbox.window.KGViewer.makeView(loaded.graph, sourceText))
  const deleteId = view.graph.nodes[0].id
  const next = kgMeasureDeletion('client.applyPatch', () => sandbox.window.KGViewer.applyPatch(view.graph, { targetKind: 'node', targetId: deleteId, proposedFix: { action: 'delete_node', nodePatch: { id: deleteId } } }))
  for (const key of Object.keys(metrics)) if (!key.startsWith('client.')) delete metrics[key]
  const body = { documentId, expectedRevision: loaded.revision, graph: { summary: next.summary, nodes: next.nodes, edges: next.edges, verification: next.verification }, baseNodeIds: view.graph.nodes.map(node => node.id), baseEdgeKeys: view.graph.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation) }
  const start = performance.now()
  const committed = await call('graph-commit', body)
  const commitMs = performance.now() - start
  if (committed.error) throw new Error(JSON.stringify(committed.error))
  const reloadStart = performance.now()
  const reloaded = await call('document-load', { documentId, nodeLimit: 800, includeSourceText: false })
  const reloadMs = performance.now() - reloadStart
  kgMeasureDeletion('client.makeView.after', () => sandbox.window.KGViewer.makeView(reloaded.graph, sourceText))
  console.log(JSON.stringify({ nodes: graph.nodes.length, edges: graph.edges.length, sourceChars: sourceText.length, requestBytes: Buffer.byteLength(JSON.stringify(body)), commitMs, reloadMs, metrics }, null, 2))
  store.close()
} finally { rmSync(dir, { recursive: true, force: true }) }
