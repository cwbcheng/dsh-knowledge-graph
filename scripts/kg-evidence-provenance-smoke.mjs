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
    req.url = '/api/dsh-knowledge-graph/' + endpoint + '?' + new URLSearchParams(params || {}).toString()
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

async function waitTask(api, taskId) {
  for (let i = 0; i < 200; i++) {
    const status = await get(api, 'task-status', { taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish: ' + taskId)
}

const dir = mkdtempSync('/tmp/dsh-kg-provenance-')
const dbPath = join(dir, 'provenance.sqlite')
process.env.DSH_KG_DB = dbPath
const documentId = 'document-evidence-provenance'
const oldSourceId = 'source-old-version'
const oldChunkId = 'chunk-old-version'
const oldText = '目标事实；旧结论'
const seedGraph = {
  summary: 'old graph',
  source: {
    id: oldSourceId,
    documentId,
    title: 'provenance',
    chars: oldText.length,
    paragraphCount: 1,
    chunkCount: 1,
    sectionCount: 1,
    sections: [{ id: 'section-old', title: '全文', startParagraph: 0, endParagraph: 0, summary: '' }],
  },
  staging: {
    sourceId: oldSourceId,
    documentId,
    chunkCount: 1,
    chunks: [{ chunkId: oldChunkId, sourceId: oldSourceId, startParagraph: 0, endParagraph: 0, sectionIds: ['section-old'], sectionTitles: ['全文'], summary: '', nodeIds: ['n1', 'n2'], edgeCount: 1, warnings: [] }],
  },
  nodes: [
    { id: 'n1', type: 'fact', text: '目标事实', quote: '目标事实', paragraph: 0, evidence: [{ documentId, sourceId: oldSourceId, chunkId: oldChunkId, paragraph: 0, quote: '目标事实' }], groundingStatus: 'grounded', entailmentStatus: 'unverified', documentId, sourceId: oldSourceId, chunkId: oldChunkId },
    { id: 'n2', type: 'fact', text: '旧结论', quote: '旧结论', paragraph: 0, evidence: [{ documentId, sourceId: oldSourceId, chunkId: oldChunkId, paragraph: 0, quote: '旧结论' }], groundingStatus: 'grounded', entailmentStatus: 'unverified', documentId, sourceId: oldSourceId, chunkId: oldChunkId },
  ],
  edges: [{ fromNodeId: 'n1', toNodeId: 'n2', relation: 'supports', evidence: [{ documentId, sourceId: oldSourceId, chunkId: oldChunkId, paragraph: 0, quote: oldText }], documentId, sourceId: oldSourceId, chunkId: oldChunkId }],
}

const seedStore = await openSqliteStore(dbPath)
seedStore.saveGraph(seedGraph, { sourceText: oldText })
seedStore.close()

const kgExtractor = async ({ chunk }) => {
  const unit = chunk.units[0]
  return {
    summary: 'reconfirmed',
    nodes: [{ id: 'new-duplicate', type: 'fact', text: '目标事实', quote: '目标事实', paragraph: unit.num }],
    edges: [{ fromNodeId: 'n1', toNodeId: 'n2', relation: 'supports', evidence: [{ paragraph: unit.num, quote: unit.text }] }],
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

try {
  const appendText = '目标事实；旧结论'
  const started = await post(api, 'append-extract', { documentId, title: 'provenance', text: appendText })
  assert(started && started.taskId, 'provenance append task was not created')
  const terminal = await waitTask(api, started.taskId)
  assert(terminal.status === 'succeeded', 'provenance append failed: ' + JSON.stringify(terminal))

  const store = await openSqliteStore(dbPath)
  const canonical = store.getDocument(documentId)
  store.close()
  assert(canonical && canonical.revision === 2, 'provenance append did not advance revision')
  const node = canonical.nodes.find((item) => item.id === 'n1')
  const edge = canonical.edges.find((item) => item.fromNodeId === 'n1' && item.toNodeId === 'n2' && item.relation === 'supports')
  assert(node, 'semantic duplicate node disappeared')
  assert(edge, 'duplicate canonical edge disappeared')
  assert(node.evidence.length >= 2, 'semantic node dedupe discarded later evidence')
  assert(edge.evidence.length >= 2, 'duplicate edge discarded later relation evidence')
  const nodeSources = new Set(node.evidence.map((item) => item.sourceId))
  const edgeSources = new Set(edge.evidence.map((item) => item.sourceId))
  assert(nodeSources.has(oldSourceId) && nodeSources.has(canonical.source.id), 'node evidence does not preserve source-version provenance')
  assert(edgeSources.has(oldSourceId) && edgeSources.has(canonical.source.id), 'edge evidence does not preserve source-version provenance')
  for (const item of [...node.evidence, ...edge.evidence]) {
    assert(item.documentId === documentId && item.sourceId && item.chunkId && Number.isInteger(item.paragraph) && item.quote, 'evidence item lacks complete provenance: ' + JSON.stringify(item))
  }
  assert(node.groundingStatus === 'grounded' && node.entailmentStatus === 'unverified', 'grounding/entailment state did not survive evidence merge')

  console.log(JSON.stringify({
    ok: true,
    nodeEvidence: node.evidence.length,
    edgeEvidence: edge.evidence.length,
    sourceVersions: nodeSources.size,
    groundingStatus: node.groundingStatus,
    entailmentStatus: node.entailmentStatus,
  }))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
