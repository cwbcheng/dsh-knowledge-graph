import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createImageNodeTools } from '../src/kg-image-nodes.mjs'
import { createGraphContract } from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'

const tools = createImageNodeTools(), contract = createGraphContract()
const image = { id: 'first:figure', name: 'same.png', caption: 'Earlier diagram', paragraphs: [0],
  interpretationStatus: 'ai_unverified', startParagraph: 2, endParagraph: 3, attachment: { attachmentId: 'owned-first' } }
const sourceText = ['Original text.', 'Another original paragraph.', 'Only for A at t0 in metres.',
  'A second input is necessary; an unknown arrow is not causation.', 'Later image.', 'Conflicting source at t1 in seconds.'].join('\n\n')
const graph = { source: { id: 'source:last', documentId: 'book', paragraphCount: 6,
  visualSource: { kind: 'markdown-assets', images: [image,
    { ...image, id: 'last:figure', caption: 'Later diagram', paragraphs: [4], startParagraph: 5, endParagraph: 5 }] } },
  staging: { documentId: 'book', sourceId: 'source:last', chunks: [
    { chunkId: 'original', sourceId: 'source:original', startParagraph: 0, endParagraph: 1 },
    { chunkId: 'first', sourceId: 'source:first', startParagraph: 2, endParagraph: 3 },
    { chunkId: 'last', sourceId: 'source:last', startParagraph: 4, endParagraph: 5 },
  ] }, nodes: [
    { id: 'first', type: 'fact', text: 'Only for A at t0 in metres.', quote: 'Only for A at t0 in metres.',
      documentId: 'book', sourceId: 'source:first', paragraph: 2, evidence: [{ paragraph: 2, quote: 'Only for A at t0 in metres.' }], entailmentStatus: 'unverified' },
    { id: 'second-input', type: 'fact', text: 'A second input is necessary; an unknown arrow is not causation.',
      paragraph: 3, sourceId: 'source:first', entailmentStatus: 'unsupported' },
    { id: 'evidence-only', type: 'concept', text: 'Original concept with a later citation.', paragraph: 0, sourceId: 'source:original',
      evidence: [{ documentId: 'book', sourceId: 'source:first', paragraph: 2, quote: 'Only for A at t0 in metres.' }] },
    { id: 'last', type: 'fact', text: 'Conflicting source at t1 in seconds.', paragraph: 5, sourceId: 'source:last' },
  ], edges: [] }
const input = JSON.stringify(graph)
const links = value => value.edges.filter(edge => edge.relation === 'visual_source').map(edge => [edge.fromNodeId, edge.toNodeId]).sort()
const expected = [['evidence-only', tools.nodeId(image.id)], ['first', tools.nodeId(image.id)],
  ['last', tools.nodeId('last:figure')], ['second-input', tools.nodeId(image.id)]].sort()
const materialized = tools.materialize(graph)
assert.deepEqual(links(materialized), expected, 'Earlier append-source nodes must retain their original-image provenance after a later append')
assert.deepEqual(contract.materializeImageNodes(graph), materialized, 'Dynamic Host and SQLite must use the same identity contract')
assert.equal(JSON.stringify(graph), input)
assert.deepEqual(tools.materialize(materialized), materialized)
assert.equal(materialized.nodes.find(node => node.id === 'second-input').entailmentStatus, 'unsupported')
assert(materialized.edges.every(edge => edge.relation === 'visual_source' && edge.evidence.length === 0))

const first = graph.nodes[0]
const rejected = [
  { ...first, documentId: 'book ' },
  { ...first, sourceId: 'source:first ' },
  { ...first, sourceId: 'foreign', evidence: [{ sourceId: 'source:first', paragraph: 2 }] },
  { ...first, sourceId: 'source:last' },
  { ...first, paragraph: 0, evidence: [{ documentId: 'other-book', sourceId: 'source:first', paragraph: 2 }] },
  { ...first, paragraph: 0, evidence: [{ sourceId: 'source:last', paragraph: 2 }] },
  { ...first, paragraph: 0, evidence: [{ sourceId: 'foreign', paragraph: 2 }] },
  { ...first, paragraph: 0, evidence: [{ paragraph: '2' }] },
  { ...first, type: 'image' },
]
for (const node of rejected) assert.equal(tools.matches(graph, image, node), false, JSON.stringify(node))
for (const chunk of [
  { sourceId: 'source:first', startParagraph: 4, endParagraph: 5 },
  { sourceId: 'source:first', startParagraph: 3, endParagraph: 2 },
  { sourceId: 'source:first', startParagraph: '2', endParagraph: 3 },
  { sourceId: 'source:first', startParagraph: -1, endParagraph: 3 },
  { sourceId: 'source:first', startParagraph: 2, endParagraph: Infinity },
  { sourceId: 'source:first', documentId: 'book ', startParagraph: 2, endParagraph: 3 },
]) {
  assert.equal(tools.matches({ ...graph, staging: { documentId: 'book', chunks: [chunk] } }, image, first), false)
}
assert.equal(tools.matches({ ...graph, staging: { ...graph.staging, documentId: 'book ' } }, image, first), false)
assert.equal(tools.matches({ ...graph, staging: undefined }, image, first), false, 'An unregistered source cannot be approved by paragraph coincidence')
assert.equal(tools.matches(graph, { ...image, interpretationStatus: 'not_requested' }, first), false)
assert.equal(tools.matches(graph, { ...image, startParagraph: 3, endParagraph: 2 }, first), false)
assert.equal(tools.matches(graph, image, { id: 'legacy', paragraph: 2 }), true, 'Legacy implicit source anchors remain compatible')
assert.equal(tools.matches(graph, image, { id: 'inherited', paragraph: 0, sourceId: 'source:first', evidence: [{ paragraph: 2 }] }), true)
const identity = structuredClone(graph)
identity.staging.chunks[1].sourceId = '来源:first '
identity.nodes[0].sourceId = '来源:first '
assert.equal(tools.matches(identity, image, identity.nodes[0]), true, 'Registered opaque source identity is not normalized')
assert.equal(tools.matches(identity, image, { ...identity.nodes[0], sourceId: '来源:first' }), false)

const hostSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const inspectStart = hostSource.indexOf('      function inspectImageHost(')
const inspectEnd = hostSource.indexOf('      function selectMarkdownImagesForInterpretationHost(', inspectStart)
assert(inspectStart >= 0 && inspectEnd > inspectStart)
const inspect = new Function('splitParagraphsHost', 'IMAGE_NODE_TOOLS', hostSource.slice(inspectStart, inspectEnd) + ';return inspectImageHost')(contract.splitParagraphs, tools)
const canonical = { ...materialized, sourceText, revision: 1 }
const args = { imageId: image.id, expectedRevision: 1 }
const inspection = inspect(canonical, args)
assert.equal(inspection.totalNodes, 3)
assert.deepEqual(inspection.nodes.map(node => node.id).sort(), ['evidence-only', 'first', 'second-input'])
assert(inspection.nodes.every(node => node.paragraph >= 2 && node.paragraph <= 3))
assert.equal(inspect(canonical, { ...args, expectedRevision: 0 }).error.code, 'revision_conflict')

const directory = mkdtempSync(join(tmpdir(), 'kg-image-provenance-'))
assert(resolve(directory).startsWith(resolve(tmpdir()) + '/kg-image-provenance-'))
const previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(directory, 'graph.sqlite')
const store = await openSqliteStore(process.env.DSH_KG_DB)
const routes = [], cleanups = []
let calls = 0, server
try {
  store.saveGraph(materialized, { sourceText })
  // Simulate the already-stored legacy omission only in this owned database.
  store.db.prepare("DELETE FROM graph_edges WHERE document_id=? AND relation='visual_source'").run('book')
  const legacy = store.getDocument('book'), legacyBytes = JSON.stringify(legacy)
  assert.equal(legacy.edges.length, 0)
  const host = await import('../lib/index.js?image-provenance=' + Date.now())
  host.apply({ get: name => name === 'webServer' ? { register: route => { routes.push(route); return () => {} } }
    : name === 'kgExtractor' ? { extractChunk() { calls++; throw new Error('No model may be called') } } : null,
    effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup }, interval: () => () => {} })
  const handler = routes.find(route => route.path === '/api/dsh-knowledge-graph')?.handler
  assert(handler)
  server = createServer((request, response) => { Promise.resolve(handler(request, response)).catch(error => { response.writeHead(500); response.end(error.message) }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const call = async (method, payload) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/' + method,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ documentId: 'book', ...payload }) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const read = await call('image-inspect', args)
  assert.equal(read.totalNodes, 3, 'Actual Host inspection must include earlier append-source nodes before any repair write')
  assert.equal(JSON.stringify(store.getDocument('book')), legacyBytes, 'Inspection cannot secretly materialize stored links')
  assert.equal((await call('image-nodes', { expectedRevision: 0 })).error.code, 'revision_conflict')
  assert.equal(JSON.stringify(store.getDocument('book')), legacyBytes)
  const repaired = await call('image-nodes', { expectedRevision: 1 })
  assert(!repaired.error, JSON.stringify(repaired))
  assert.equal(repaired.changed, true)
  assert.equal(repaired.revision, 2)
  const saved = store.getDocument('book')
  assert.deepEqual(links(saved), expected)
  assert.deepEqual(saved.nodes.filter(node => node.type !== 'image'), legacy.nodes.filter(node => node.type !== 'image'))
  assert.deepEqual(saved.source.visualSource, legacy.source.visualSource)
  assert.equal(saved.sourceText, legacy.sourceText)
  assert.equal((await call('image-nodes', { expectedRevision: 2 })).changed, false)
  assert.deepEqual(store.getDocument('book'), saved)
  const neighborhood = await call('graph-neighborhood', { expectedRevision: 2, centerId: tools.nodeId(image.id), limit: 80 })
  assert(!neighborhood.error, JSON.stringify(neighborhood))
  assert.equal(neighborhood.nodes.length, 4)
  assert.equal(neighborhood.edges.length, 3)
  const old = await call('image-inspect', args)
  assert.equal(old.error.code, 'revision_conflict')
  assert.equal((await call('image-inspect', { ...args, expectedRevision: 2 })).totalNodes, 3)
  const reopened = await openSqliteStore(process.env.DSH_KG_DB)
  try { assert.deepEqual(reopened.getDocument('book'), saved) } finally { reopened.close() }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM image_reviews').get().n, 0)
  assert.equal(calls, 0)
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  for (const cleanup of cleanups.reverse()) cleanup()
  store.close()
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(directory, { recursive: true, force: true })
}
console.log(JSON.stringify({ ok: true, earlierAppendProvenance: true, scopedSourcesAndEvidence: true,
  exactIdentity: true, foreignAndWrongRangeRejected: true, dynamicParity: true, actualHostHttp: true,
  inspectionReadOnly: true, localRepairAndReopen: true, staleAndIdempotent: true, noSemanticPromotion: true, modelCalls: calls }))
