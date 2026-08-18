import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import hostPlugin from '../src/index.host.js'
import * as persistentHost from '../lib/index.js'

const graph = {
  source: { id: 'source-candidate-smoke', documentId: 'document-candidate-smoke', title: 'candidate smoke', sections: [] },
  nodes: [
    { id: 'n-fact', type: 'fact', text: '事实候选', paragraph: 0, evidence: [{ paragraph: 0, quote: '事实候选' }] },
    { id: 'n-concept', type: 'concept', text: '概念候选', paragraph: 1, evidence: [{ paragraph: 1, quote: '概念候选' }] },
  ],
  edges: [],
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function dynamicSmoke() {
  const handlers = new Map()
  globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
  hostPlugin().apply({ get() { return null }, interval() { return () => {} } })
  const listed = await handlers.get('candidate-list')({ graph, status: 'all', limit: 20 })
  assert(Array.isArray(listed.candidates) && listed.candidates.length === 2, 'dynamic candidate list count is wrong')
  const claim = listed.candidates.find((candidate) => candidate.kind === 'claim')
  assert(claim && claim.nodeId === 'n-fact', 'dynamic claim candidate missing')
  const updated = await handlers.get('candidate-update')({ graph, documentId: graph.source.documentId, kind: 'claim', id: claim.id, nodeId: claim.nodeId, status: 'accepted' })
  assert(updated.candidate && updated.candidate.status === 'accepted', 'dynamic candidate update failed')
  const accepted = await handlers.get('candidate-list')({ graph, status: 'accepted', limit: 20 })
  assert(accepted.candidates.length === 1 && accepted.candidates[0].nodeId === 'n-fact', 'dynamic candidate status was not retained')
  return { listed: listed.candidates.length, updated: updated.candidate.id }
}

function request(handler, body, endpoint = 'candidate-list') {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/api/dsh-knowledge-graph/' + endpoint
    req.headers = {}
    const res = {
      status: 0,
      body: '',
      setHeader() {},
      writeHead(status) { this.status = status },
      end(value) { this.body = value || ''; resolve(JSON.parse(this.body || '{}')) },
    }
    handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}

async function persistentSmoke() {
  const dir = mkdtempSync('/tmp/dsh-kg-candidate-')
  const dbPath = join(dir, 'candidate.sqlite')
  process.env.DSH_KG_DB = dbPath
  const store = await openSqliteStore(dbPath)
  store.saveGraph(graph)
  store.close()
  const routes = []
  const webServer = { register(spec) { routes.push(spec); return () => {} } }
  persistentHost.apply({
    get(name) { return name === 'webServer' ? webServer : null },
    effect(fn) { return fn() },
    interval() { return () => {} },
  })
  const api = routes.find((route) => route.path === '/api/dsh-knowledge-graph').handler
  const listed = await request(api, { documentId: graph.source.documentId, kind: 'all', status: 'all', limit: 20, graph })
  assert(listed.source === 'sqlite' && Array.isArray(listed.candidates) && listed.candidates.length === 2, 'persistent candidate list did not use SQLite')
  const entity = listed.candidates.find((candidate) => candidate.kind === 'entity')
  const update = await request(api, { documentId: graph.source.documentId, kind: entity.kind, id: entity.id, nodeId: entity.nodeId, status: 'rejected', graph }, 'candidate-update')
  assert(update.source === 'sqlite' && update.candidate && update.candidate.status === 'rejected', 'persistent candidate update failed')
  rmSync(dir, { recursive: true, force: true })
  return { listed: listed.candidates.length, updated: update.candidate.id }
}

const dynamic = await dynamicSmoke()
const persistent = await persistentSmoke()
console.log(JSON.stringify({ ok: true, dynamic, persistent }))
