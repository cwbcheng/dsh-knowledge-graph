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
  const sourceText = '事实候选\n\n概念候选'
  store.saveGraph(graph, { sourceText })
  store.close()
  const routes = []
  const webServer = { register(spec) { routes.push(spec); return () => {} } }
  persistentHost.apply({
    get(name) { return name === 'webServer' ? webServer : null },
    effect(fn) { return fn() },
    interval() { return () => {} },
  })
  const api = routes.find((route) => route.path === '/api/dsh-knowledge-graph').handler
  const queried = await request(api, { documentId: graph.source.documentId, query: '概念候选' }, 'document-load')
  assert(queried && queried.graph && queried.graph.view && queried.graph.view.kind === 'query', 'persistent document-load did not expose query view metadata')
  assert(queried.graph.nodes.some((node) => node.id === 'n-concept'), 'persistent canonical query could not locate the requested node')
  const listed = await request(api, { documentId: graph.source.documentId, kind: 'all', status: 'all', limit: 20, graph })
  assert(listed.source === 'sqlite' && Array.isArray(listed.candidates) && listed.candidates.length === 2, 'persistent candidate list did not use SQLite')
  const entity = listed.candidates.find((candidate) => candidate.kind === 'entity')
  const update = await request(api, { documentId: graph.source.documentId, kind: entity.kind, id: entity.id, nodeId: entity.nodeId, status: 'rejected', graph }, 'candidate-update')
  assert(update.source === 'sqlite' && update.candidate && update.candidate.status === 'rejected', 'persistent candidate update failed')
  const loaded = await request(api, { documentId: graph.source.documentId }, 'document-load')
  assert(loaded && loaded.sourceText === sourceText && loaded.revision === 1 && loaded.graph.nodes.length === 2, 'persistent document-load did not hydrate canonical state')
  const commitPayload = {
    documentId: graph.source.documentId,
    expectedRevision: 1,
    graph: { summary: 'route commit', nodes: graph.nodes, edges: graph.edges,
      verification: { lastReport: { reportId: 'report-work-package', issues: [{ id: 'issue-1', status: 'applied' }] } } },
    baseNodeIds: graph.nodes.map((node) => node.id),
    baseEdgeKeys: [],
    commitKind: 'bulk_review',
  }
  const preview = await request(api, commitPayload, 'graph-commit-preview')
  assert(preview && preview.valid === true && preview.revision === 1, 'read-only graph preflight did not validate the actual commit payload')
  const afterPreview = await request(api, { documentId: graph.source.documentId }, 'document-export')
  assert(afterPreview.revision === 1 && afterPreview.graph.summary !== 'route commit', 'graph preflight modified canonical state')
  const invalidPreview = await request(api, { ...commitPayload, graph: { nodes: [{ id: 'bad-node', type: 'fact', text: '无锚点节点', quote: '', paragraph: null }], edges: [] }, baseNodeIds: [] }, 'graph-commit-preview')
  assert(invalidPreview?.error?.code === 'invariant_violation', 'graph preflight accepted an invalid patch')
  const afterInvalidPreview = await request(api, { documentId: graph.source.documentId }, 'document-export')
  assert(afterInvalidPreview.revision === 1, 'invalid graph preflight changed canonical revision')
  const committed = await request(api, commitPayload, 'graph-commit')
  assert(committed && !committed.error && committed.revision === 2, 'persistent graph-commit did not advance revision')
  const stalePreview = await request(api, commitPayload, 'graph-commit-preview')
  assert(stalePreview?.error?.code === 'revision_conflict', 'graph preflight must reject a changed canonical revision')
  const rejectedCommit = await request(api, {
    documentId: graph.source.documentId,
    expectedRevision: 2,
    graph: { summary: 'invalid route commit', nodes: [{ id: 'bad-node', type: 'fact', text: '无锚点节点', quote: '', paragraph: null }], edges: [] },
    baseNodeIds: [],
    baseEdgeKeys: [],
  }, 'graph-commit')
  assert(rejectedCommit && rejectedCommit.error && rejectedCommit.error.code === 'invariant_violation', 'persistent graph-commit bypassed the canonical invariant gate')
  const exported = await request(api, { documentId: graph.source.documentId }, 'document-export')
  assert(exported && exported.revision === 2 && exported.graph.nodes.length === 2, 'rejected persistent graph-commit mutated canonical state')
  const afterCommit = await request(api, { documentId: graph.source.documentId, kind: 'entity', status: 'rejected', limit: 20 }, 'candidate-list')
  assert(afterCommit.candidates.length === 1 && afterCommit.candidates[0].nodeId === 'n-concept', 'candidate review state was lost across graph revision')
  const wrongUndo = await request(api, { documentId: graph.source.documentId, expectedRevision: 2,
    parentRevision: 1, reportId: 'different-report' }, 'graph-undo-bulk-review')
  assert(wrongUndo?.error?.code === 'undo_conflict', 'another report must not undo this group')
  const undone = await request(api, { documentId: graph.source.documentId, expectedRevision: 2,
    parentRevision: 1, reportId: 'report-work-package' }, 'graph-undo-bulk-review')
  assert(undone?.revision === 3 && !undone.error, 'one-group undo did not restore the prior canonical snapshot')
  const restored = await request(api, { documentId: graph.source.documentId }, 'document-export')
  assert(restored.revision === 3 && restored.graph.summary !== 'route commit'
    && !restored.graph.verification?.lastReport, 'undo must restore both graph content and review state')
  const repeatedUndo = await request(api, { documentId: graph.source.documentId, expectedRevision: 2,
    parentRevision: 1, reportId: 'report-work-package' }, 'graph-undo-bulk-review')
  assert(repeatedUndo?.error?.code === 'revision_conflict', 'an old receipt must not undo newer canonical revisions')
  const secondGroup = await request(api, { ...commitPayload, expectedRevision: 3,
    graph: { ...commitPayload.graph, summary: 'second work package' } }, 'graph-commit')
  assert(secondGroup.revision === 4 && !secondGroup.error, 'a second isolated group was not saved')
  const laterEdit = await request(api, { documentId: graph.source.documentId, expectedRevision: 4,
    graph: { summary: 'later independent edit', nodes: [], edges: [] }, baseNodeIds: [], baseEdgeKeys: [] }, 'graph-commit')
  assert(laterEdit.revision === 5 && !laterEdit.error, 'an unrelated later edit was not saved')
  const unsafeUndo = await request(api, { documentId: graph.source.documentId, expectedRevision: 4,
    parentRevision: 3, reportId: 'report-work-package' }, 'graph-undo-bulk-review')
  assert(unsafeUndo?.error?.code === 'revision_conflict', 'undo must not erase an edit made after the work package')
  const afterUnsafeUndo = await request(api, { documentId: graph.source.documentId }, 'document-export')
  assert(afterUnsafeUndo.revision === 5 && afterUnsafeUndo.graph.summary === 'later independent edit',
    'a rejected undo changed canonical graph contents')
  rmSync(dir, { recursive: true, force: true })
  return { listed: listed.candidates.length, queried: queried.graph.nodes.length, updated: update.candidate.id, revision: committed.revision }
}

const dynamic = await dynamicSmoke()
const persistent = await persistentSmoke()
console.log(JSON.stringify({ ok: true, dynamic, persistent }))
