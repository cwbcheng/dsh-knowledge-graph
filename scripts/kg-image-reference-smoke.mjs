import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImageNodeTools } from '../src/kg-image-nodes.mjs'
import { createGraphContract } from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'

const tools = createImageNodeTools(), contract = createGraphContract()
const texts = ['图 34-8 展示了辅助渐构“正外部性”判别模型的靶图。', '![](images/target.jpg)',
  '靶图中有三个例子。', '## 电子靶图', '图34-80 是另一个图。', '图34-8 中的万物。', '转写的正外部性。']
const units = texts.map((text, paragraph) => ({ paragraph, text })), map = new Map(units.map(unit => [unit.paragraph, unit.text]))
const graph = { ontology: 'proposition-v1', source: { id: 's', documentId: 'book', visualSource: {
  kind: 'markdown-assets', images: [{ id: 'fig', name: 'images/target.jpg', caption: '图34-8', paragraphs: [1],
    interpretationStatus: 'ai_unverified', startParagraph: 5, endParagraph: 6, attachment: { attachmentId: 'bytes-a' } }] } },
  staging: { documentId: 'book', chunks: [{ chunkId: 'c', sourceId: 's', startParagraph: 0, endParagraph: 6 }] },
  nodes: [0, 2, 3, 4, 5, 6].map(paragraph => ({ id: 'n' + paragraph, type: 'concept', text: texts[paragraph],
    quote: texts[paragraph], paragraph, sourceId: 's', documentId: 'book', evidence: [] })), edges: [] }
const candidates = value => tools.referenceCandidates(value, map, 'fig')
assert.deepEqual(candidates(graph).map(item => item.nodeId), ['n0'])
assert(!tools.materialize(graph, map).edges.some(edge => edge.relation === 'visual_reference'), 'Opening images is not approval')
const approve = value => ({ ...value, source: { ...value.source, visualSource: { ...value.source.visualSource,
  textReferences: tools.referenceCandidates(value, map, 'fig').map(({ saved, ...record }) => record) } } })
const linked = tools.materialize(approve(graph), map)
assert.equal(linked.edges.filter(edge => edge.relation === 'visual_reference').length, 1)
assert.equal(linked.edges.filter(edge => edge.relation === 'visual_source').length, 2)
assert.deepEqual(tools.errors(linked, map), [])
assert.deepEqual(tools.materialize(linked, map), linked)
assert.deepEqual(tools.semanticGraph(linked).nodes, graph.nodes)
assert.equal(tools.semanticGraph(linked).edges.length, 0, 'Book references cannot be inferred as semantic relations')
assert(!contract.buildFullVerifyPlan(texts.join('\n\n'), linked).batches.some(batch => batch.edges.some(edge => edge.relation === 'visual_reference')))
for (const mutate of [
  value => { value.nodes[0].sourceId = 'foreign' },
  value => { value.nodes[0].documentId = 'other-book' },
  value => { value.nodes[0].paragraph = 5 },
  value => { value.nodes[0].quote = '图34-80' },
  value => { value.nodes[0].quote = '图34-8 从未出现的伪造引文' },
  value => { value.source.visualSource.images[0].attachment = null },
  value => { value.source.visualSource.images[0].caption = '图34-8.1' },
  value => { value.source.visualSource.images[0].caption = '图34-8a' },
  value => { value.source.visualSource.images[0].name = 'unrelated.jpg' },
  value => { value.source.visualSource.images.push({ id: 'duplicate', caption: '图34-8' }) },
  value => { value.source.visualSource.kind = 'image-derived' },
  value => { value.staging.documentId = 'foreign' },
  value => { value.staging.chunks = [{ sourceId: 's', startParagraph: 0, endParagraph: 0 }] },
  value => { value.nodes[0].evidence = [{ paragraph: 0, quote: texts[0], sourceId: 'foreign' }]; value.nodes[0].quote = '' },
]) {
  const invalid = structuredClone(graph); mutate(invalid)
  assert.equal(candidates(invalid).length, 0, mutate.toString())
}
const differentFigure = structuredClone(graph)
differentFigure.source.visualSource.images[0].caption = '图34-80'
assert.deepEqual(candidates(differentFigure).map(item => item.nodeId), ['n4'], 'Figure 34-8 cannot prefix-match figure 34-80')
for (const mutate of [
  value => { value.nodes[0].text = '同名但新版本的概念' },
  value => { value.source.visualSource.images[0].attachment.attachmentId = 'new-bytes' },
  value => { value.source.visualSource.images[0].caption = '图34-9' },
  value => { value.nodes[0].quote = '' },
]) {
  const stale = structuredClone(linked); mutate(stale)
  assert(!tools.materialize(stale, map).edges.some(edge => edge.relation === 'visual_reference'))
  assert(tools.errors(stale, map).length, 'Stale approval must not validate itself')
}
const changedUnits = new Map(map); changedUnits.set(0, '原文已替换。')
assert(tools.errors(linked, changedUnits).length)
const absentUnits = new Map()
assert.equal(tools.referenceCandidates(graph, absentUnits, 'fig').length, 0)
for (const relation of ['visual_reference', 'visual_source']) {
  const forged = { nodes: graph.nodes.slice(0, 2), edges: [{ fromNodeId: 'n0', toNodeId: 'n2', relation, evidence: [] }] }
  assert(tools.errors(forged, map).length, 'A graph without retained images must not validate its own forged image links')
  assert.equal(tools.materialize(forged, map).edges.length, 0)
  assert.equal(tools.semanticGraph(forged).edges.length, 0)
}

const directory = mkdtempSync(join(tmpdir(), 'kg-image-reference-'))
const previous = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(directory, 'graph.sqlite')
const store = await openSqliteStore(process.env.DSH_KG_DB), routes = [], cleanups = []
const sourceText = texts.join('\n\n')
store.saveGraph(tools.materialize(graph), { sourceText, sourceUnits: units })
let server
try {
  const plugin = await import('../lib/index.js?image-references=' + Date.now())
  plugin.apply({ get: name => name === 'webServer' ? { register: route => { routes.push(route); return () => {} } } : null,
    effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup }, interval: () => () => {} })
  const handler = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  server = createServer((request, response) => Promise.resolve(handler(request, response)).catch(error => {
    response.statusCode = 500; response.end(JSON.stringify({ unexpected: error.message }))
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const call = async (method, data) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/' + method,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ documentId: 'book', ...data }) })
    assert.equal(response.status, 200); return response.json()
  }
  const before = store.getDocument('book')
  const preview = await call('image-references', { action: 'preview', imageId: 'fig', expectedRevision: 1 })
  assert.deepEqual(preview.candidates.map(item => item.nodeId), ['n0'])
  assert.deepEqual(store.getDocument('book'), before)
  for (const args of [
    { confirm: false }, { nodeIds: ['n5'] }, { nodeIds: ['n0', 'n0'] }, { expectedRevision: 0 },
    { nodeIds: ['n0'], imageId: 'foreign' }, { nodeIds: [] },
  ]) {
    const result = await call('image-references', { action: 'save', imageId: 'fig', nodeIds: ['n0'], confirm: true, expectedRevision: 1, ...args })
    assert(result.error, JSON.stringify(result)); assert.deepEqual(store.getDocument('book'), before)
  }
  const saved = await call('image-references', { action: 'save', imageId: 'fig', nodeIds: ['n0'], confirm: true, expectedRevision: 1 })
  assert.equal(saved.revision, 2); assert.equal(saved.changed, true)
  const after = store.getDocument('book'), edge = after.edges.find(edge => edge.relation === 'visual_reference')
  assert.equal(edge.fromNodeId, 'n0'); assert.equal(edge.toNodeId, 'image:fig')
  assert.equal(edge.evidence[0].quote, texts[0])
  assert.deepEqual(after.nodes, before.nodes)
  assert.deepEqual(after.edges.filter(edge => edge.relation !== 'visual_reference'), before.edges)
  assert.equal(after.sourceText, sourceText); assert.deepEqual(store.getDocumentSourceUnits('book').map(unit => ({ ...unit })), units)
  assert.equal((await call('image-references', { action: 'preview', imageId: 'fig', expectedRevision: 2 })).candidates[0].saved, true)
  assert.equal((await call('image-references', { action: 'save', imageId: 'fig', nodeIds: ['n0'], confirm: true, expectedRevision: 1 })).error.code, 'revision_conflict')
  assert.equal((await call('image-references', { action: 'save', imageId: 'fig', nodeIds: ['n0'], confirm: true, expectedRevision: 2 })).changed, false)
  assert.deepEqual(store.getDocument('book'), after)
  assert.equal((await call('image-nodes', { expectedRevision: 2 })).changed, false)
  assert.deepEqual(store.getDocument('book'), after)
  const gathered = await call('graph-query', { nodeIds: ['image:fig'], relations: ['visual_reference'], hops: 1 })
  assert(!gathered.error, JSON.stringify(gathered.error)); assert.equal(gathered.graph.edges.length, 1)
  const edited = structuredClone(after); edited.edges.find(edge => edge.relation === 'visual_reference').evidence[0].quote = '图 34-8'
  const envelope = { graph: edited, baseNodeIds: after.nodes.map(node => node.id), baseEdgeKeys: after.edges.map(edge => `${edge.fromNodeId}>${edge.toNodeId}:${edge.relation}`), expectedRevision: 2 }
  for (const method of ['graph-commit-preview', 'graph-commit']) assert.equal((await call(method, envelope)).error.code, 'image_node_readonly')
  assert.deepEqual(store.getDocument('book'), after)
  store.saveGraph(after, { sourceText, sourceUnits: units.map(unit => unit.paragraph === 0 ? { ...unit, text: '原文已替换。' } : unit), expectedRevision: 2 })
  assert(!store.getDocument('book').edges.some(edge => edge.relation === 'visual_reference'), 'Store must recheck canonical units inside its write transaction')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  for (const cleanup of cleanups.reverse()) cleanup()
  store.close()
  if (previous === undefined) delete process.env.DSH_KG_DB; else process.env.DSH_KG_DB = previous
  rmSync(directory, { recursive: true, force: true })
}
console.log(JSON.stringify({ ok: true, explicitBookReference: true, optInOnly: true, staleApprovalRejected: true,
  canonicalUnitsRequired: true, noAdjacencyOrNameMerge: true, realHttpSqlite: true, semanticAndLearningRecordsUnchanged: true }))
