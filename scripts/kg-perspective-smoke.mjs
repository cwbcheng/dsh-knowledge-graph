import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { openSqliteStore } from '../src/kg-store.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-perspective-'))
const database = join(directory, 'graph.sqlite')
const documentId = 'perspective-fixture'
const graph = { source: { id: 'perspective-source', documentId, title: 'Fixture', paragraphCount: 1, sections: [
  { id: 'chapter-a', title: 'Chapter A', startParagraph: 0, endParagraph: 0 },
] }, nodes: [{ id: 'n1', type: 'claim', text: 'Claim one', paragraph: 0, sectionId: 'chapter-a',
  quote: 'Source paragraph.', evidence: [] }], edges: [] }
const view = { tab: 'search', query: 'claim', filters: { type: 'claim', section: 'chapter-a', grounding: 'all', entailment: 'all' },
  chapterId: 'chapter-a', layout: 'layered', focusNodeId: 'n1',
  gather: { centerId: 'n1', direction: 'both', relation: '', hops: 2 },
  reading: { open: true, topicId: 'chapter-a', themeId: '', offset: 0, themeOffset: 0 }, sourceParagraph: 0 }
try {
  let store = await openSqliteStore(database)
  store.saveGraph(graph, { sourceText: 'Source paragraph.' })
  const revision = store.getDocumentRevision(documentId)
  const saved = store.savePerspective(documentId, { name: 'Evidence check', state: view, expectedRevision: revision })
  assert.equal(saved.version, 1)
  assert.equal(saved.baseRevision, revision)
  assert.equal(store.getDocumentRevision(documentId), revision, 'saving a view must not revise canonical graph')
  assert.equal(store.listPerspectives(documentId)[0].state.focusNodeId, 'n1')
  assert.deepEqual(store.resolvePerspective(documentId, saved.id).warnings, [])
  assert(!JSON.stringify(store.listPerspectives(documentId)).includes('Source paragraph.'), 'views must not copy source text')
  assert.throws(() => store.savePerspective(documentId, { name: 'Unsafe', state: { ...view, graph }, expectedRevision: revision }),
    { code: 'invalid_input' }, 'a preset must not store a graph copy')
  assert.throws(() => store.savePerspective(documentId, { name: 'Stale', state: view, expectedRevision: revision + 1 }),
    { code: 'revision_conflict' })
  const otherDocumentId = 'other-perspective-fixture'
  store.saveGraph({ ...graph, source: { ...graph.source, documentId: otherDocumentId } },
    { sourceText: 'Source paragraph.' })
  assert.deepEqual(store.listPerspectives(otherDocumentId), [], 'saved views must be document-scoped')
  assert.equal(store.resolvePerspective(otherDocumentId, saved.id), null)
  assert.equal(store.deletePerspective(otherDocumentId, saved.id, 1), false)
  store.close()

  store = await openSqliteStore(database)
  assert.equal(store.listPerspectives(documentId)[0].id, saved.id, 'view must survive store recreation')
  const updated = store.savePerspective(documentId, { id: saved.id, name: 'Evidence check', state: view,
    expectedRevision: revision, expectedVersion: 1 })
  assert.equal(updated.version, 2)
  assert.throws(() => store.savePerspective(documentId, { id: saved.id, name: 'Lost update', state: view,
    expectedRevision: revision, expectedVersion: 1 }), { code: 'perspective_conflict' })
  assert.equal(store.listPerspectives(documentId)[0].state.focusNodeId, 'n1')

  store.saveGraph({ ...graph, source: { ...graph.source, sections: [] }, nodes: [] },
    { expectedRevision: revision, sourceText: 'Source paragraph.' })
  const afterEdit = store.listPerspectives(documentId)[0]
  assert.equal(afterEdit.baseRevision, 1, 'a graph change must not silently re-author a saved view')
  assert.equal(afterEdit.state.focusNodeId, 'n1')
  const resolved = store.resolvePerspective(documentId, saved.id)
  assert.equal(resolved.revisionChanged, true)
  assert.equal(resolved.state.chapterId, 'all')
  assert.equal(resolved.state.filters.section, 'all')
  assert.equal(resolved.state.focusNodeId, null)
  assert.equal(resolved.state.gather, null)
  assert.equal(resolved.state.reading.topicId, '')
  assert.equal(resolved.state.sourceParagraph, 0, 'unchanged source positions remain usable')
  assert.equal(afterEdit.state.gather.centerId, 'n1', 'applying an old view must not rewrite its saved record')
  assert.equal(store.getDocumentRevision(documentId), 2)
  assert.throws(() => store.deletePerspective(documentId, saved.id, 1), { code: 'perspective_conflict' })
  assert.equal(store.deletePerspective(documentId, saved.id, 2), true)
  assert.deepEqual(store.listPerspectives(documentId), [])
  store.close()

  process.env.DSH_KG_DB = database
  const persistentHost = await import('../lib/index.js')
  const routes = []
  persistentHost.apply({
    get(name) { return name === 'webServer' ? { register(route) { routes.push(route); return () => {} } } : null },
    effect(fn) { return fn() }, interval() { return () => {} },
  })
  const route = routes.find(item => item.path === '/api/dsh-knowledge-graph')
  assert(route, 'persistent HTTP Host did not register the API')
  const post = body => new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'; req.url = '/api/dsh-knowledge-graph/perspectives'; req.headers = {}
    const res = { setHeader() {}, writeHead() {}, end(data) { try { resolve(JSON.parse(data)) } catch (error) { reject(error) } } }
    route.handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
  const created = await post({ action: 'save', documentId, perspective: { name: 'Review evidence', state: view, expectedRevision: 2 } })
  assert.equal(created.perspective.version, 1)
  assert.equal((await post({ action: 'list', documentId })).perspectives.length, 1)
  const reopened = await post({ action: 'resolve', documentId, id: created.perspective.id })
  assert.equal(reopened.resolved.revision, 2)
  assert.equal(reopened.resolved.state.gather, null)
  assert.equal((await post({ action: 'save', documentId, perspective: { id: created.perspective.id, name: 'Stale',
    state: view, expectedRevision: 1, expectedVersion: 1 } })).error.code, 'revision_conflict')
  assert.equal((await post({ action: 'delete', documentId, id: created.perspective.id, expectedVersion: 1 })).deleted, true)
  assert.deepEqual((await post({ action: 'list', documentId })).perspectives, [])
  delete process.env.DSH_KG_DB
} finally {
  delete process.env.DSH_KG_DB
  rmSync(directory, { recursive: true, force: true })
}
console.log(JSON.stringify({ durable: true, independentOfGraphRevision: true, staleWritesRejected: true, graphCopiesRejected: true }))
