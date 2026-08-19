import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import hostPlugin from '../src/index.host.js'
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

async function waitTask(handlers, taskId) {
  for (let i = 0; i < 160; i++) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish: ' + taskId)
}

const dir = mkdtempSync('/tmp/dsh-kg-trust-boundary-')
const dbPath = join(dir, 'trust.sqlite')
process.env.DSH_KG_DB = dbPath
const documentId = 'document-trust-boundary'
const sourceId = 'source-canonical'
const chunkId = 'chunk-canonical'
const sourceText = '可信声明'
const seedGraph = {
  summary: 'trust boundary',
  source: {
    id: sourceId,
    documentId,
    title: 'trust-boundary',
    chars: sourceText.length,
    paragraphCount: 1,
    chunkCount: 1,
    sectionCount: 1,
    sections: [{ id: 'section-1', title: '全文', startParagraph: 0, endParagraph: 0, summary: '' }],
  },
  staging: {
    sourceId,
    documentId,
    chunkCount: 1,
    chunks: [{ chunkId, sourceId, startParagraph: 0, endParagraph: 0, sectionIds: ['section-1'], sectionTitles: ['全文'], summary: '', nodeIds: ['n1'], edgeCount: 0, warnings: [] }],
  },
  nodes: [{
    id: 'n1', type: 'fact', text: '可信声明', quote: '可信声明', paragraph: 0,
    evidence: [{ documentId, sourceId, chunkId, paragraph: 0, quote: '可信声明' }],
    groundingStatus: 'grounded', entailmentStatus: 'verified', documentId, sourceId, chunkId,
  }],
  edges: [],
}

let store = await openSqliteStore(dbPath)
store.saveGraph(seedGraph, { sourceText })
store.close()

const routes = []
const webServer = { register(spec) { routes.push(spec); return () => {} } }
persistentHost.apply({
  get(name) { return name === 'webServer' ? webServer : null },
  effect(fn) { return fn() },
  interval() { return () => {} },
})
const api = routes.find((route) => route.path === '/api/dsh-knowledge-graph').handler

try {
  const forged = await post(api, 'graph-commit', {
    documentId,
    expectedRevision: 1,
    graph: {
      summary: 'forged provenance attempt',
      nodes: [{
        id: 'n1', type: 'fact', text: '可信声明', quote: '可信声明', paragraph: 0,
        evidence: [{ documentId: 'document-forged', sourceId: 'source-forged', chunkId: 'chunk-forged', paragraph: 0, quote: '可信声明' }],
        groundingStatus: 'grounded', entailmentStatus: 'unverified',
        documentId: 'document-forged', sourceId: 'source-forged', chunkId: 'chunk-forged',
      }],
      edges: [],
    },
    baseNodeIds: ['n1'],
    baseEdgeKeys: [],
  })
  assert(forged && !forged.error && forged.revision === 2, 'same-claim provenance commit failed: ' + JSON.stringify(forged))

  store = await openSqliteStore(dbPath)
  let canonical = store.getDocument(documentId)
  store.close()
  const canonicalNode = canonical.nodes.find((node) => node.id === 'n1')
  assert(canonicalNode && canonicalNode.evidence.length === 1, 'canonical evidence disappeared after authentication')
  assert(canonicalNode.evidence[0].documentId === documentId && canonicalNode.evidence[0].sourceId === sourceId && canonicalNode.evidence[0].chunkId === chunkId, 'caller forged evidence provenance survived canonical authentication: ' + JSON.stringify(canonicalNode.evidence[0]))
  assert(canonicalNode.documentId === documentId && canonicalNode.sourceId === sourceId && canonicalNode.chunkId === chunkId, 'caller forged node provenance survived canonical authentication')
  assert(canonicalNode.entailmentStatus === 'verified', 'unchanged claim lost its trusted entailment status')

  const rewritten = await post(api, 'graph-commit', {
    documentId,
    expectedRevision: 2,
    graph: {
      summary: 'claim rewrite',
      nodes: [{
        ...canonicalNode,
        text: '修改后的声明',
        entailmentStatus: 'verified',
      }],
      edges: [],
    },
    baseNodeIds: ['n1'],
    baseEdgeKeys: [],
  })
  assert(rewritten && !rewritten.error && rewritten.revision === 3, 'claim rewrite commit failed: ' + JSON.stringify(rewritten))
  store = await openSqliteStore(dbPath)
  canonical = store.getDocument(documentId)
  store.close()
  assert(canonical.nodes[0].text === '修改后的声明', 'claim rewrite was not persisted')
  assert(canonical.nodes[0].entailmentStatus === 'unverified', 'verified entailment survived a semantic claim rewrite')

  const handlers = new Map()
  const extractor = {
    async extractChunk({ title }) {
      if (title === 'unsafe-endpoint-seed') {
        return {
          summary: 'unsafe endpoint seed',
          nodes: [
            { id: 'u1', type: 'fact', text: '本书帮助重建学习系统', quote: '本书帮助重建学习系统', paragraph: 0 },
            { id: 'u2', type: 'concept', text: '学习系统', quote: '学习系统', paragraph: 1 },
            { id: 'u3', type: 'fact', text: '另一事实', quote: '另一事实', paragraph: 2 },
          ],
          edges: [],
        }
      }
      return {
        summary: 'safe explicit relation',
        nodes: [
          { id: 'r1', type: 'fact', text: '缺少目标', quote: '缺少目标', paragraph: 0 },
          { id: 'r2', type: 'inference', text: '方法会走形', quote: '方法会走形', paragraph: 0 },
          { id: 'r3', type: 'fact', text: '另一事实', quote: '另一事实', paragraph: 1 },
        ],
        edges: [],
      }
    },
    async weaveRelations() { return { edges: [] } },
  }
  globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
  hostPlugin().apply({
    get(name) { return name === 'kgExtractor' ? extractor : null },
    interval() { return () => {} },
  })

  const unsafeStart = await handlers.get('extract')({ title: 'unsafe-endpoint-seed', text: ['本书帮助重建学习系统', '学习系统', '另一事实'].join('\n\n') })
  const unsafe = await waitTask(handlers, unsafeStart.taskId)
  assert(unsafe.status === 'succeeded', 'unsafe seed fixture failed unexpectedly: ' + JSON.stringify(unsafe))
  assert(unsafe.result.edges.length === 0, 'endpoint evidence was promoted into a canonical relation: ' + JSON.stringify(unsafe.result.edges))

  const safeStart = await handlers.get('extract')({ title: 'safe-relation-seed', text: ['缺少目标，因此方法会走形', '另一事实'].join('\n\n') })
  const safe = await waitTask(handlers, safeStart.taskId)
  assert(safe.status === 'succeeded', 'safe seed fixture failed unexpectedly: ' + JSON.stringify(safe))
  assert(safe.result.edges.length === 1 && safe.result.edges[0].fromNodeId === 'r1' && safe.result.edges[0].toNodeId === 'r2' && safe.result.edges[0].relation === 'infers', 'explicit same-source relation was not seeded')
  assert(safe.result.edges[0].evidence.length === 1 && safe.result.edges[0].evidence[0].quote.includes('因此'), 'safe seed evidence does not contain the relation-bearing source span')

  console.log(JSON.stringify({
    ok: true,
    canonicalProvenance: true,
    entailmentFingerprintFence: true,
    endpointEvidenceNotRelationEvidence: true,
    safeRelationSeed: safe.result.edges[0].relation,
  }))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
