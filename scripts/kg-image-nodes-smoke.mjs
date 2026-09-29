import assert from 'node:assert/strict'
import { createGraphContract } from '../src/index.host.js'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'

const contract = createGraphContract()
const graph = { ontology: 'proposition-v1', source: { id: 's1', documentId: 'book-a', visualSource: {
  kind: 'markdown-assets', images: [
    { id: 'fig-1', name: 'same.png', caption: '条件表', paragraphs: [0], attachment: { attachmentId: 'a1' }, interpretationStatus: 'ai_unverified', startParagraph: 2, endParagraph: 3 },
    { id: 'fig-2', name: 'same.png', paragraphs: [1], attachment: { attachmentId: 'a2' }, interpretationStatus: 'not_requested' },
  ],
} }, nodes: [
  { id: 'n1', type: 'fact', text: '仅适用于 A。', quote: '仅适用于 A。', paragraph: 3, evidence: [{ paragraph: 3, quote: '仅适用于 A。' }] },
  { id: 'n2', type: 'concept', text: 'same.png', quote: '原文。', paragraph: 0 },
  { id: 'n3', type: 'fact', text: '别的来源。', paragraph: 3, sourceId: 'foreign' },
], edges: [] }
const before = JSON.stringify(graph)
const materialize = contract.materializeImageNodes || (value => value)
const next = materialize(graph)
assert.equal(next.nodes.filter(node => node.type === 'image').length, 2, 'Original images must be actual canonical graph nodes, not only sidebar attachments')
assert.equal(JSON.stringify(graph), before, 'Materialization must not mutate its input')
const first = next.nodes.find(node => node.type === 'image' && node.paragraph === 0)
const second = next.nodes.find(node => node.type === 'image' && node.paragraph === 1)
assert.notEqual(first.id, second.id, 'Same filename is not image identity')
assert.equal(first.quote, '')
assert.equal(first.entailmentStatus, 'unverified')
assert.deepEqual(next.edges.map(edge => [edge.fromNodeId, edge.toNodeId, edge.relation]), [['n1', first.id, 'visual_source']])
assert.deepEqual(materialize(next), next, 'Repeated synchronization is idempotent')
const changed = materialize({ ...next, nodes: next.nodes.map(node => node.id === 'n1' ? { ...node, paragraph: 0, evidence: [] } : node) })
assert.equal(changed.edges.length, 0, 'Reanchoring must not retain obsolete image links')
assert.throws(() => materialize({ ...graph, nodes: [...graph.nodes, { id: first.id, type: 'fact', text: 'collision' }] }), /image_node_conflict/)
const missing = { ...next, source: { ...graph.source, visualSource: { images: [] } } }
assert(contract.validateGraphInvariants(missing, '原文。\n\n原图。\n\n转写。\n\n仅适用于 A。').blockingIssues.some(issue => issue.code === 'image_source_invalid'))
const forged = contract.normalizeGraph({ nodes: [first], edges: [] }, 4)
assert.equal(forged.nodes.length, 0, 'Models cannot invent source image records')
const plan = contract.buildFullVerifyPlan('原文。\n\n原图。\n\n转写。\n\n仅适用于 A。', next)
assert(!plan.batches.some(batch => batch.nodes.some(node => node.type === 'image') || batch.edges.some(edge => edge.relation === 'visual_source')), 'Text review must not pretend to review image pixels')
const directory = mkdtempSync(join(tmpdir(), 'kg-image-nodes-'))
const previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(directory, 'graphs.sqlite')
const store = await openSqliteStore(process.env.DSH_KG_DB)
const routes = [], cleanups = []
const sourceText = '原文。\n\n原图。\n\n转写。\n\n仅适用于 A。'
const legacy = { ...graph, nodes: graph.nodes.slice(0, 2) }
store.saveGraph(legacy, { sourceText })
const invoke = (api, endpoint, payload) => new Promise((resolve, reject) => {
  const request = new EventEmitter()
  request.method = 'POST'
  request.url = '/api/dsh-knowledge-graph/' + endpoint
  request.headers = { 'content-type': 'application/json' }
  const response = { writeHead() {}, setHeader() {}, end(body) { resolve(body ? JSON.parse(body) : {}) } }
  Promise.resolve(api(request, response)).catch(reject)
  process.nextTick(() => { request.emit('data', Buffer.from(JSON.stringify(payload))); request.emit('end') })
})
try {
  const plugin = await import('../lib/index.js?image-nodes=' + Date.now())
  plugin.apply({ get(name) {
    if (name === 'webServer') return { register(spec) { routes.push(spec); return () => {} } }
    if (name === 'kgExtractor') return { extractChunk() { throw new Error('Image materialization must not use a model') } }
    return null
  }, effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup }, interval() { return () => {} } })
  const api = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  const baseline = store.getDocument('book-a')
  const call = (method, args = {}) => invoke(api, method, { documentId: 'book-a', ...args })
  assert.equal((await call('image-nodes', { expectedRevision: baseline.revision - 1 })).error.code, 'revision_conflict')
  assert.deepEqual(store.getDocument('book-a'), baseline)
  const created = await call('image-nodes', { expectedRevision: baseline.revision })
  assert.equal(created.changed, true, JSON.stringify(created))
  assert.equal(created.revision, baseline.revision + 1)
  const saved = store.getDocument('book-a')
  assert.equal(saved.nodes.filter(node => node.type === 'image').length, 2)
  assert.equal(saved.edges.filter(edge => edge.relation === 'visual_source').length, 1)
  assert.equal(saved.sourceText, sourceText)
  assert.deepEqual(saved.source.visualSource, baseline.source.visualSource)
  assert.deepEqual(saved.nodes.filter(node => node.type !== 'image'), baseline.nodes, 'image synchronization must not rewrite semantic nodes')
  assert.equal((await call('image-nodes', { expectedRevision: saved.revision })).changed, false)
  assert.deepEqual(store.getDocument('book-a'), saved, 'idempotent open must not append a revision or change timestamps')
  const imageSearch = await call('graph-query', { types: ['image'], hops: 0 })
  assert(!imageSearch.error, 'canonical image type must be searchable: ' + JSON.stringify(imageSearch.error))
  assert.deepEqual(imageSearch.graph.nodes.map(node => node.type), ['image', 'image'])
  const sourceSearch = await call('graph-query', { nodeIds: ['n1'], relations: ['visual_source'], hops: 1 })
  assert(!sourceSearch.error, 'source relation must be queryable: ' + JSON.stringify(sourceSearch.error))
  assert.equal(sourceSearch.graph.edges.length, 1)
  const imageNode = saved.nodes.find(node => node.type === 'image')
  const envelope = value => ({ graph: value, baseNodeIds: saved.nodes.map(node => node.id),
    baseEdgeKeys: saved.edges.map(edge => `${edge.fromNodeId}>${edge.toNodeId}:${edge.relation}`), expectedRevision: saved.revision })
  for (const mutate of [
    value => { value.nodes = value.nodes.filter(node => node.id !== imageNode.id) },
    value => { value.nodes.find(node => node.id === imageNode.id).text = 'AI invented evidence' },
    value => { value.nodes.push({ id: 'image:forged', type: 'image', text: 'forged' }) },
    value => { value.edges.push({ fromNodeId: 'n1', toNodeId: imageNode.id, relation: 'supports', evidence: [] }) },
    value => { value.edges[0].evidence = [{ paragraph: 0, quote: '原文。' }] },
  ]) {
    const invalid = structuredClone(saved)
    mutate(invalid)
    for (const method of ['graph-commit-preview', 'graph-commit']) {
      const result = await call(method, envelope(invalid))
      assert.equal(result.error?.code, 'image_node_readonly', JSON.stringify(result))
      assert.deepEqual(store.getDocument('book-a'), saved)
    }
  }
  const reanchor = structuredClone(saved)
  Object.assign(reanchor.nodes.find(node => node.id === 'n1'), { paragraph: 0, text: '原文。', quote: '原文。', evidence: [{ paragraph: 0, quote: '原文。' }] })
  assert.equal((await call('graph-commit-preview', envelope(reanchor))).valid, true)
  assert.deepEqual(store.getDocument('book-a'), saved, 'preview is read-only')
  const committed = await call('graph-commit', envelope(reanchor))
  assert(!committed.error, JSON.stringify(committed))
  const final = store.getDocument('book-a')
  assert.equal(final.nodes.filter(node => node.type === 'image').length, 2)
  assert.equal(final.edges.filter(edge => edge.relation === 'visual_source').length, 0, 'reanchoring must remove obsolete provenance in SQLite')
  assert.equal(final.sourceText, sourceText)
  const exported = await call('document-export', { includeSourceText: true })
  assert.equal(exported.graph.nodes.filter(node => node.type === 'image').length, 2, 'export must include real image nodes')
  const reopened = await openSqliteStore(process.env.DSH_KG_DB)
  try { assert.deepEqual(reopened.getDocument('book-a'), final) } finally { reopened.close() }
} finally {
  for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
  store.close()
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(directory, { recursive: true, force: true })
}
console.log(JSON.stringify({ ok: true, canonicalImageNodes: true, sourceLinks: true, idempotent: true, modelCannotForge: true, persistentRoundTrip: true, protectedSources: true }))
