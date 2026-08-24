import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as persistentHost from '../lib/index.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function post(handler, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/api/dsh-knowledge-graph/' + endpoint
    req.headers = {}
    const res = {
      status: 0, body: '', setHeader() {},
      writeHead(status) { this.status = status },
      end(value) { this.body = value || ''; resolve(JSON.parse(this.body || '{}')) },
    }
    handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body || {}))); req.emit('end') })
  })
}

function get(handler, endpoint, params) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'GET'
    const query = new URLSearchParams(params || {}).toString()
    req.url = '/api/dsh-knowledge-graph/' + endpoint + (query ? '?' + query : '')
    req.headers = {}
    const res = {
      status: 0, body: '', setHeader() {},
      writeHead(status) { this.status = status },
      end(value) { this.body = value || ''; resolve(JSON.parse(this.body || '{}')) },
    }
    handler(req, res).catch(reject)
    process.nextTick(() => req.emit('end'))
  })
}

const dir = mkdtempSync('/tmp/dsh-kg-revision-')
const dbPath = join(dir, 'revision.sqlite')
process.env.DSH_KG_DB = dbPath
const documentId = 'document-append-revision'
const sourceText = '旧正文'
const baseGraph = {
  summary: 'base',
  source: { id: 'source-base', documentId, title: 'revision', chars: sourceText.length, paragraphCount: 1, chunkCount: 1, sectionCount: 1, sections: [{ id: 'section-base', title: '全文', startParagraph: 0, endParagraph: 0, summary: '' }] },
  staging: { sourceId: 'source-base', documentId, chunkCount: 1, chunks: [{ chunkId: 'chunk-base', sourceId: 'source-base', startParagraph: 0, endParagraph: 0, sectionIds: ['section-base'], sectionTitles: ['全文'], summary: '', nodeIds: ['n1'], edgeCount: 0, warnings: [] }] },
  nodes: [{ id: 'n1', type: 'fact', text: '旧事实', quote: '旧正文', paragraph: 0, evidence: [{ paragraph: 0, quote: '旧正文' }], documentId, sourceId: 'source-base', chunkId: 'chunk-base', sectionId: 'section-base', sectionTitle: '全文' }],
  edges: [],
}
const seedStore = await openSqliteStore(dbPath)
seedStore.saveGraph(baseGraph, { sourceText })
seedStore.close()

let activeExtractorGate = null
function armExtractorGate() {
  let release
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  const blocked = new Promise((resolve) => { release = resolve })
  activeExtractorGate = { started, blocked, markStarted, release }
  return activeExtractorGate
}
const kgExtractor = async ({ chunk }) => {
  const gate = activeExtractorGate
  if (!gate) throw new Error('extractor gate was not armed')
  gate.markStarted()
  await gate.blocked
  const unit = chunk.units[0]
  return {
    summary: 'append',
    nodes: [{ id: 'n2', type: 'fact', text: '追加事实', quote: unit.text, paragraph: unit.num }],
    edges: [],
  }
}

const routes = []
const webServer = { register(spec) { routes.push(spec); return () => {} } }
persistentHost.apply({
  get(name) {
    if (name === 'webServer') return webServer
    if (name === 'kgExtractor') return kgExtractor
    return null
  },
  effect(fn) { return fn() },
  interval() { return () => {} },
})
const api = routes.find((route) => route.path === '/api/dsh-knowledge-graph').handler

const appendGate = armExtractorGate()
const append = await post(api, 'append-extract', { documentId, title: 'revision', text: '追加正文' })
assert(append && append.taskId, 'append task was not created')
await appendGate.started

const loaded = await post(api, 'document-load', { documentId })
assert(loaded && loaded.revision === 1, 'append base revision was not 1')
const manual = await post(api, 'graph-commit', {
  documentId,
  expectedRevision: 1,
  graph: { summary: 'manual revision wins', nodes: loaded.graph.nodes, edges: loaded.graph.edges },
  baseNodeIds: loaded.graph.nodes.map((node) => node.id),
  baseEdgeKeys: [],
})
assert(manual && !manual.error && manual.revision === 2, 'concurrent manual graph commit failed')
appendGate.release()

let terminal = null
for (let i = 0; i < 200; i++) {
  const status = await get(api, 'task-status', { taskId: append.taskId })
  if (status.status === 'failed' || status.status === 'cancelled' || status.status === 'succeeded') { terminal = status; break }
  await new Promise((resolve) => setTimeout(resolve, 5))
}
assert(terminal && terminal.status === 'failed', 'stale append unexpectedly succeeded: ' + JSON.stringify(terminal))
assert(terminal.error && terminal.error.code === 'revision_conflict', 'stale append failed with the wrong code: ' + JSON.stringify(terminal))

const exported = await post(api, 'document-export', { documentId })
assert(exported && exported.revision === 2, 'stale append advanced canonical revision')
assert(exported.graph.summary === 'manual revision wins', 'stale append overwrote the concurrent manual summary')
assert(exported.graph.nodes.length === 1 && exported.graph.nodes[0].id === 'n1', 'stale append overwrote canonical nodes')

const replaceGate = armExtractorGate()
let replacement = null
for (let i = 0; i < 50; i++) {
  replacement = await post(api, 'extract', { documentId, title: 'revision', text: '重新拆分正文' })
  if (!(replacement && replacement.error && replacement.error.code === 'busy')) break
  await new Promise((resolve) => setTimeout(resolve, 5))
}
assert(replacement && replacement.taskId, 'non-append replacement task was not created')
await replaceGate.started
const replacementBase = await post(api, 'document-load', { documentId })
assert(replacementBase && replacementBase.revision === 2, 'replacement task did not capture revision 2')
const replacementManual = await post(api, 'graph-commit', {
  documentId,
  expectedRevision: 2,
  graph: { summary: 'manual replacement wins', nodes: replacementBase.graph.nodes, edges: replacementBase.graph.edges },
  baseNodeIds: replacementBase.graph.nodes.map((node) => node.id),
  baseEdgeKeys: [],
})
assert(replacementManual && !replacementManual.error && replacementManual.revision === 3, 'concurrent replacement graph commit failed')
replaceGate.release()
let replacementTerminal = null
for (let i = 0; i < 200; i++) {
  const status = await get(api, 'task-status', { taskId: replacement.taskId })
  if (status.status === 'failed' || status.status === 'cancelled' || status.status === 'succeeded') { replacementTerminal = status; break }
  await new Promise((resolve) => setTimeout(resolve, 5))
}
assert(replacementTerminal && replacementTerminal.status === 'failed' && replacementTerminal.error.code === 'revision_conflict', 'stale non-append extraction overwrote a newer canonical revision: ' + JSON.stringify(replacementTerminal))
const replacementExport = await post(api, 'document-export', { documentId })
assert(replacementExport && replacementExport.revision === 3 && replacementExport.graph.summary === 'manual replacement wins', 'stale non-append extraction advanced or overwrote canonical state')

rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify({ ok: true, baseRevision: 1, appendConcurrentRevision: 2, replacementConcurrentRevision: 3, appendStatus: terminal.error.code, replacementStatus: replacementTerminal.error.code }))
