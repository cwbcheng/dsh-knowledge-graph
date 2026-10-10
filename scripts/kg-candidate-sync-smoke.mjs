import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import hostPlugin from '../src/index.host.js'
import * as persistentHost from '../lib/index.js'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import { entityCandidateSet, claimCandidateSet } from '../src/kg-ontology.mjs'

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

const identities = { source: graph.source, ontology: 'proposition-v1', nodes: graph.nodes.map(({ id, type }) => ({ id, type })) }
const targetedGraph = {
  source: { documentId: 'candidate-targeted|opaque', id: 'targeted-source' }, ontology: 'proposition-v1',
  nodes: Array.from({ length: 1202 }, (_, i) => ({ id: 'candidate-' + i, type: i % 2 ? 'fact' : 'concept',
    text: '候选原文 ' + i, paragraph: i, quote: '候选原文 ' + i,
    evidence: [{ paragraph: i, quote: '候选原文 ' + i }] })), edges: [],
}
targetedGraph.nodes[1200].id = 'entity| "尾" |节点'
targetedGraph.nodes[1201].id = 'claim|尾\'"'
async function targetedSmoke(call, source, fixture = targetedGraph) {
  const options = { documentId: fixture.source.documentId, kind: 'all', status: 'all', limit: 500, reviewOnly: true, graph: fixture }
  const initial = await call('candidate-list', options)
  assert(initial.candidates.length === 500, source + ': preserve the initial bounded list')
  const initialIds = new Set(initial.candidates.map(row => row.nodeId))
  for (const node of fixture.nodes.slice(-2)) {
    assert(!initialIds.has(node.id), source + ': targeted fixture must be outside the initial 500')
    const kind = node.type === 'concept' ? 'entity' : 'claim'
    const requested = { ...options, nodeId: node.id, kind, limit: 1 }
    const found = await call('candidate-list', requested)
    assert(found.candidates.length === 1 && found.candidates[0].nodeId === node.id
      && found.candidates[0].documentId === fixture.source.documentId && found.candidates[0].kind === kind,
      source + ': precise lookup must find the late candidate before applying the limit')
    const row = found.candidates[0]
    const updated = await call('candidate-update', { ...requested, id: row.id, status: 'accepted' })
    assert(updated.candidate?.status === 'accepted', source + ': targeted candidate update failed')
    const readBack = await call('candidate-list', { ...requested, status: 'accepted' })
    assert(readBack.candidates.length === 1 && readBack.candidates[0].status === 'accepted', source + ': targeted update must read back')
    const rejected = await call('candidate-list', { ...requested, status: 'rejected' })
    assert(rejected.candidates.length === 0, source + ': preserve targeted status filtering')
  }
  assert((await call('candidate-list', { ...options, nodeId: 'absent', limit: 1 })).candidates.length === 0,
    source + ': missing node must not return an unrelated candidate')
  for (const nodeId of ['', null, 7, {}]) {
    assert((await call('candidate-list', { ...options, nodeId, limit: 1 })).error?.code === 'invalid_input',
      source + ': invalid node identity must not broaden the lookup')
  }
  return { source, nodes: fixture.nodes.length, initialLimit: initial.candidates.length, targetedKinds: 2,
    lateCandidatesReadBack: true, exactOpaqueNodeIds: true, missingRejected: true, invalidNodeIds: 4 }
}
async function compactSmoke(call, source) {
  const documentId = 'unsaved-' + source
  const localGraph = { ...identities, source: { documentId } }
  const options = { documentId, reviewOnly: true, kind: 'all', status: 'all', limit: 500 }
  const needed = await call('candidate-list', options)
  assert(needed.requiresGraph === true && needed.candidates.length === 0, source + ': missing canonical graph must explicitly request identities')
  const listed = await call('candidate-list', { ...options, graph: localGraph })
  assert(listed.candidates.length === 2 && !listed.requiresGraph, source + ': identity-only list lost local candidates')
  assert(listed.candidates.every(row => row.documentId === documentId && !('text' in row) && !('evidence' in row)), source + ': reviews must not fabricate source content')
  const claim = listed.candidates.find(row => row.kind === 'claim')
  const args = { documentId, reviewOnly: true, kind: claim.kind, nodeId: claim.nodeId, id: claim.id, status: 'accepted',
    graph: { ...localGraph, nodes: localGraph.nodes.filter(node => node.id === claim.nodeId) } }
  const updated = await call('candidate-update', args)
  assert(updated.candidate?.status === 'accepted', source + ': one-identity update failed')
  const accepted = await call('candidate-list', { ...options, graph: localGraph, status: 'accepted' })
  assert(accepted.candidates.length === 1 && accepted.candidates[0].nodeId === claim.nodeId, source + ': local status was lost')
  const targeted = await call('candidate-list', { ...options, graph: localGraph, kind: 'entity', nodeId: 'n-concept', limit: 1 })
  assert(targeted.candidates.length === 1 && targeted.candidates[0].nodeId === 'n-concept', source + ': compact targeted lookup failed')
  const missingLookup = await call('candidate-list', { ...options, graph: localGraph, nodeId: 'missing', limit: 1 })
  assert(missingLookup.candidates.length === 0, source + ': compact missing lookup must not return an unrelated candidate')
  const missing = await call('candidate-update', { ...args, nodeId: 'missing' })
  assert(missing.error?.code === 'not_found', source + ': nonexistent update must fail without writing a review')
  const invalid = await call('candidate-update', { ...args, status: 'invalid' })
  assert(invalid.error?.code === 'invalid_input', source + ': invalid status must fail')
  const legacy = await call('candidate-list', { documentId, graph: { ...graph, source: { documentId } }, limit: 20 })
  // Persistent healthy SQLite's legacy route deliberately remains SQLite-only.
  if (legacy.source !== 'sqlite') {
    assert(legacy.candidates.length === 2 && legacy.candidates[0].text && legacy.candidates[0].evidence.length,
      source + ': legacy callers must retain full candidate content and evidence')
  }
  const learningGraph = { ...localGraph, source: { documentId: documentId + '-learning' }, ontology: 'learning-view-v1',
    nodes: ['concept', 'rule', 'connection_model', 'discrimination_model', 'fact'].map((type, i) => ({ id: 'learning-' + i, type })) }
  const learning = await call('candidate-list', { ...options, documentId: learningGraph.source.documentId, graph: learningGraph })
  const entityTypes = entityCandidateSet(learningGraph.ontology), claimTypes = claimCandidateSet(learningGraph.ontology)
  const expected = learningGraph.nodes.flatMap(node => [entityTypes.has(node.type) ? 'entity|' + node.id : '',
    claimTypes.has(node.type) ? 'claim|' + node.id : ''].filter(Boolean)).sort().join(',')
  assert(learning.candidates.map(row => row.kind + '|' + row.nodeId).sort().join(',') === expected && expected,
    source + ': compact fallback must retain the learning ontology candidate types')
  return { source, identityList: listed.candidates.length, oneIdentityUpdate: true, acceptedFilter: true,
    missingRejected: true, invalidRejected: true, targetedSingleIdentity: true, learningKinds: expected }
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
  const compact = await compactSmoke((method, args) => handlers.get(method)(args), 'dynamic')
  const targeted = await targetedSmoke((method, args) => handlers.get(method)(args), 'dynamic')
  return { listed: listed.candidates.length, updated: updated.candidate.id, compact, targeted }
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
  store.saveGraph(targetedGraph, { sourceText: targetedGraph.nodes.map(node => node.text).join('\n\n') })
  const queryPlans = ['entity', 'claim'].map(kind => {
    const plan = store.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM ' + kind + '_candidates WHERE document_id = ? AND node_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(targetedGraph.source.documentId, targetedGraph.nodes.at(-1).id, 1).map(row => row.detail).join('; ')
    assert(plan.includes(kind + '_candidates_node_idx'), 'targeted candidate lookup must use the document/node index')
    return plan
  })
  const opaqueIds = [' spaced-candidate ', 'candidate:'.padEnd(180, 'x'), '候选:Ａ:"甲">', '候选:A:"甲">']
  for (const documentId of opaqueIds) store.saveGraph({ ...graph, source: { ...graph.source, documentId } }, { sourceText })
  store.close()
  const routes = []
  const webServer = { register(spec) { routes.push(spec); return () => {} } }
  persistentHost.apply({
    get(name) { return name === 'webServer' ? webServer : null },
    effect(fn) { return fn() },
    interval() { return () => {} },
  })
  const api = routes.find((route) => route.path === '/api/dsh-knowledge-graph').handler
  const targeted = await targetedSmoke((method, args) => request(api, args, method), 'sqlite')
  assert((await request(api, { reviewOnly: true, kind: 'claim', nodeId: targetedGraph.nodes.at(-1).id, limit: 1 })).error?.code === 'invalid_input',
    'targeted lookup must not search across all documents')
  const wrongDocument = await request(api, { documentId: graph.source.documentId, nodeId: targetedGraph.nodes.at(-1).id, limit: 1, reviewOnly: true })
  assert(wrongDocument.source === 'sqlite' && wrongDocument.candidates.length === 0, 'targeted lookup must stay within the exact document')
  for (const documentId of opaqueIds) {
    const options = { documentId, reviewOnly: true, kind: 'all', status: 'all', limit: 500 }
    const exact = await request(api, options)
    assert(exact.source === 'sqlite' && !exact.requiresGraph && exact.candidates.length === 2
      && exact.candidates.every(row => row.documentId === documentId), 'saved opaque candidate identity must not be trimmed, normalized or truncated: ' + documentId)
    const row = exact.candidates[0]
    const updated = await request(api, { documentId, reviewOnly: true, kind: row.kind, id: row.id,
      nodeId: row.nodeId, status: 'accepted', graph: { source: { documentId }, nodes: [{ id: row.nodeId, type: row.type }] } }, 'candidate-update')
    assert(updated.source === 'sqlite' && updated.candidate?.status === 'accepted', 'opaque candidate update must stay persistent')
    const again = await request(api, { ...options, status: 'accepted' })
    assert(again.source === 'sqlite' && again.candidates.length === 1 && again.candidates[0].nodeId === row.nodeId,
      'opaque candidate review must read back from the exact SQLite document')
  }
  const queried = await request(api, { documentId: graph.source.documentId, query: '概念候选' }, 'document-load')
  assert(queried && queried.graph && queried.graph.view && queried.graph.view.kind === 'query', 'persistent document-load did not expose query view metadata')
  assert(queried.graph.nodes.some((node) => node.id === 'n-concept'), 'persistent canonical query could not locate the requested node')
  const listed = await request(api, { documentId: graph.source.documentId, kind: 'all', status: 'all', limit: 20, graph })
  assert(listed.source === 'sqlite' && Array.isArray(listed.candidates) && listed.candidates.length === 2, 'persistent candidate list did not use SQLite')
  const entity = listed.candidates.find((candidate) => candidate.kind === 'entity')
  const options = { documentId: graph.source.documentId, kind: 'all', status: 'all', limit: 500, reviewOnly: true }
  const canonical = await request(api, options)
  assert(canonical.source === 'sqlite' && !canonical.requiresGraph && canonical.candidates.length === 2,
    'saved candidate list must work without graph data')
  const update = await request(api, { documentId: graph.source.documentId, kind: entity.kind, id: entity.id, nodeId: entity.nodeId,
    status: 'rejected', reviewOnly: true, graph: { ...identities, nodes: [{ id: entity.nodeId, type: 'concept' }] } }, 'candidate-update')
  assert(update.source === 'sqlite' && update.candidate && update.candidate.status === 'rejected', 'persistent candidate update failed')
  const compact = await compactSmoke((method, args) => request(api, args, method), 'sqlite-unsaved')
  assert((await request(api, { ...options, documentId: '' })).requiresGraph === true,
    'identity-only local request must not list other documents')
  const originalList = SqliteKnowledgeStore.prototype.listCandidates
  const originalUpdate = SqliteKnowledgeStore.prototype.updateCandidate
  let fallback
  try {
    SqliteKnowledgeStore.prototype.listCandidates = function (...args) {
      if (this.filename === dbPath) throw new Error('synthetic candidate read failure')
      return originalList.apply(this, args)
    }
    SqliteKnowledgeStore.prototype.updateCandidate = function (...args) {
      if (this.filename === dbPath) throw new Error('synthetic candidate write failure')
      return originalUpdate.apply(this, args)
    }
    const needsFallback = await request(api, options)
    assert(needsFallback.source === 'fallback' && needsFallback.requiresGraph === true,
      'failed SQLite query must request graph identities, not silently clear review state')
    fallback = await compactSmoke((method, args) => request(api, args, method), 'sqlite-fallback')
    // Use the saved identity too, so getDocumentRevision succeeds before SQL fails.
    const fromSaved = await request(api, { ...options, graph: identities })
    const row = fromSaved.candidates.find(row => row.kind === 'claim')
    const written = await request(api, { documentId: graph.source.documentId, reviewOnly: true,
      kind: row.kind, id: row.id, nodeId: row.nodeId, status: 'accepted',
      graph: { ...identities, nodes: [{ id: row.nodeId, type: 'fact' }] } }, 'candidate-update')
    assert(written.source === 'fallback' && written.candidate?.status === 'accepted', 'saved SQLite failure must support one-identity update')
    const readBack = await request(api, { ...options, graph: identities, status: 'accepted' })
    assert(readBack.candidates.length === 1 && readBack.candidates[0].nodeId === row.nodeId,
      'saved SQLite failure must retain fallback status on the same host')
  } finally {
    SqliteKnowledgeStore.prototype.listCandidates = originalList
    SqliteKnowledgeStore.prototype.updateCandidate = originalUpdate
  }
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
  // Fail the actual lazy SQLite open too, using only an owned file as a parent.
  // A request failure and an unavailable store are distinct fallback paths.
  process.env.DSH_KG_DB = join(dbPath, 'not-a-directory.sqlite')
  const unavailableRoutes = []
  persistentHost.apply({ get(name) { return name === 'webServer' ? { register(route) { unavailableRoutes.push(route); return () => {} } } : null },
    effect(fn) { return fn() }, interval() { return () => {} } })
  const unavailableApi = unavailableRoutes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  const unavailable = await compactSmoke((method, args) => request(unavailableApi, args, method), 'sqlite-open-failure')
  process.env.DSH_KG_DB = dbPath
  rmSync(dir, { recursive: true, force: true })
  return { listed: listed.candidates.length, queried: queried.graph.nodes.length, updated: update.candidate.id,
    revision: committed.revision, compact, fallback, unavailable, targeted, queryPlans, exactOpaqueIdentities: opaqueIds.length }
}

const dynamic = await dynamicSmoke()
const persistent = await persistentSmoke()
console.log(JSON.stringify({ ok: true, dynamic, persistent }))
