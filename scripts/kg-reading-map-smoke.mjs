import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { openSqliteStore } from '../src/kg-store.mjs'

const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const start = source.indexOf('      function readingMapHost(')
const end = source.indexOf('      function splitParagraphsOffsetsHost(', start)
assert(start >= 0 && end > start, 'Reading map must be derived by the actual Host')
const readingMapHost = new Function('splitParagraphsHost', source.slice(start, end) + '\nreturn readingMapHost')(
  text => text.split(/\n\s*\n/),
)

const documentId = 'reading-map-fixture'
const sourceId = 'reading-source'
const paragraphs = ['Only source statement A.', 'Source statement B.', 'Other chapter statement.']
const node = (id, paragraph, sectionId, quote, extra = {}) => ({ id, type: 'claim', text: 'Claim ' + id,
  paragraph, sectionId, quote, evidence: [{ documentId, sourceId, paragraph, quote }], ...extra })
const graph = {
  source: { documentId, id: sourceId, title: 'Fixture book', sections: [
    { id: 'chapter-a', title: 'Chapter A', startParagraph: 0, endParagraph: 1 },
    { id: 'chapter-b', title: 'Chapter B', startParagraph: 2, endParagraph: 2 },
  ] },
  nodes: [
    node('a', 0, 'chapter-a', 'Only source statement A.'),
    node('b', 1, 'chapter-a', 'Invented quote'),
    node('c', 2, null, 'Other chapter statement.'),
    node('d', -1, null, '', { evidence: [] }),
    node('e', 0, 'chapter-a', 'Only source statement A.', { evidence: [{ documentId: 'foreign-book', sourceId, paragraph: 0, quote: 'Only source statement A.' }] }),
    node('f', 0, 'chapter-a', 'Only source statement A.', { evidence: [] }),
    node('g', 0, 'chapter-a', '', { evidence: [{ documentId: 'foreign-book', sourceId, paragraph: 0, quote: 'Only source statement A.' }] }),
  ], edges: [],
}
const document = { documentId, revision: 4, sourceText: paragraphs.join('\n\n'), graph }
const before = JSON.stringify(document)
const first = readingMapHost(document, { expectedRevision: 4, limit: 1 })
assert.equal(first.origin, 'canonical_derived')
assert.deepEqual(first.topics.map(topic => [topic.id, topic.count]), [['chapter-a', 5], ['chapter-b', 1], ['__unassigned__', 1]])
assert.equal(first.total, 5)
assert.equal(first.items.length, 1)
assert.equal(first.items[0].citations[0].quote, 'Only source statement A.')
const second = readingMapHost(document, { topicId: 'chapter-a', offset: 1, limit: 50 })
assert.deepEqual(second.items.map(item => item.nodeId), ['e', 'f', 'g', 'b'])
assert.deepEqual(second.items.map(item => item.citations.length), [1, 1, 0, 0], 'foreign evidence and fabricated quotes are not source anchors')
assert.equal(readingMapHost(document, { topicId: 'chapter-b' }).items[0].nodeId, 'c', 'paragraph fallback uses source section without rewriting the node')
assert.equal(readingMapHost(document, { topicId: '__unassigned__' }).items[0].nodeId, 'd')
const staleSection = { ...document, graph: { ...graph, nodes: [node('stale', 2, 'chapter-a', 'Other chapter statement.')] } }
assert.equal(readingMapHost(staleSection, { topicId: 'chapter-b' }).items[0].nodeId, 'stale',
  'an old sectionId must not override the actual source paragraph range')
const absentParagraph = { ...document, graph: { ...graph, nodes: [node('absent', null, null, '')] } }
assert.equal(readingMapHost(absentParagraph, { topicId: '__unassigned__' }).items[0].nodeId, 'absent',
  'null source paragraph must not be coerced to paragraph zero')
const themedGraph = { ...graph, nodes: [
  node('concept-a', 0, 'chapter-a', 'Only source statement A.', { type: 'concept', text: 'Shared name' }),
  node('claim-a', 1, 'chapter-a', 'Source statement B.'),
  node('unsupported-a', 1, 'chapter-a', 'Source statement B.', { entailmentStatus: 'unsupported' }),
  node('invented-a', 1, 'chapter-a', 'Invented claim quotation'),
  node('example-a', 1, 'chapter-a', 'Source statement B.', { type: 'example' }),
  node('concept-b', 2, 'chapter-b', 'Other chapter statement.', { type: 'concept', text: 'Shared name' }),
  node('claim-b', 2, 'chapter-b', 'Other chapter statement.'),
], edges: [
  { fromNodeId: 'concept-a', toNodeId: 'claim-a', relation: 'supports' },
  { fromNodeId: 'concept-a', toNodeId: 'claim-a', relation: 'infers' },
  { fromNodeId: 'concept-a', toNodeId: 'example-a', relation: 'example' },
  { fromNodeId: 'concept-a', toNodeId: 'claim-b', relation: 'supports' },
  { fromNodeId: 'claim-b', toNodeId: 'concept-b', relation: 'supports' },
] }
const themed = { ...document, graph: themedGraph }
const themedBefore = JSON.stringify(themed)
const themePage = readingMapHost(themed, { topicId: 'chapter-a' })
assert.deepEqual(themePage.themes.map(theme => [theme.nodeId, theme.linkedCount]), [['concept-a', 1]],
  'candidate themes need a same-section direct claim and must not merge homonyms or examples')
assert.equal(themePage.themes[0].origin, 'graph_concept', 'theme labels are derived graph nodes, not source headings')
assert.deepEqual(themePage.featuredItems.map(item => item.nodeId), ['claim-a'],
  'reading priorities must exclude unsupported and ungrounded claims')
assert.deepEqual(readingMapHost(themed, { topicId: 'chapter-a', themeId: 'concept-a' }).items.map(item => item.nodeId),
  ['concept-a', 'claim-a'], 'theme view must show only the exact concept and linked same-section claim')
assert.deepEqual(readingMapHost(themed, { topicId: 'chapter-a', themeId: 'concept-a' }).featuredItems.map(item => item.nodeId),
  ['claim-a'], 'themed priority must retain exact source evidence')
assert.equal(readingMapHost(themed, { topicId: 'chapter-a', themeId: 'concept-b' }).error.code, 'invalid_input',
  'cross-chapter homonym must not be selectable as this chapter theme')
assert.equal(readingMapHost(themed, { topicId: 'chapter-b' }).themes[0].nodeId, 'concept-b')
const changedUnits = paragraphs.map((text, paragraph) => ({ paragraph, text: paragraph === 1 ? 'Changed authoritative paragraph.' : text }))
assert.deepEqual(readingMapHost({ ...themed, sourceUnits: changedUnits }, { topicId: 'chapter-a' }).featuredItems, [],
  'a legacy text match cannot promote a claim when authoritative paragraph units disagree')
assert.equal(JSON.stringify(themed), themedBefore, 'candidate themes and featured claims may not mutate canonical graph')
const manyConcepts = Array.from({ length: 15 }, (_, index) => node('concept-' + index, 0, 'chapter-a',
  'Only source statement A.', { type: 'concept', text: 'Theme ' + index }))
const manyClaims = Array.from({ length: 15 }, (_, index) => node('claim-' + index, 1, 'chapter-a', 'Source statement B.'))
const manyThemes = { ...document, graph: { ...graph, nodes: [...manyConcepts, ...manyClaims],
  edges: manyConcepts.map((concept, index) => ({ fromNodeId: concept.id, toNodeId: manyClaims[index].id, relation: 'supports' })) } }
assert.equal(readingMapHost(manyThemes, { topicId: 'chapter-a' }).themes.length, 12, 'theme candidate response must be bounded')
assert.equal(readingMapHost(manyThemes, { topicId: 'chapter-a', themeOffset: 12 }).themes.length, 3,
  'candidate theme navigation must reach the remaining page')
const structured = { ...document, sourceText: 'Misleading legacy split.', sourceUnits: paragraphs.map((text, paragraph) => ({ paragraph, text })) }
assert.equal(readingMapHost(structured).items[0].citations[0].quote, 'Only source statement A.', 'persisted paragraph units outrank a mismatched legacy split')
assert.equal(readingMapHost(document, { expectedRevision: 3 }).error.code, 'revision_conflict')
assert.equal(readingMapHost(document, { topicId: 'missing' }).error.code, 'invalid_input')
assert.equal(JSON.stringify(document), before, 'reading map cannot mutate canonical graph')
assert(source.includes("harness.handle('reading-map'"), 'dynamic RPC must expose map')
for (const file of ['../lib/index.js', '../lib/client.js', '../extension/viewer.js']) {
  const generated = readFileSync(new URL(file, import.meta.url), 'utf8')
  assert(generated.includes(file.includes('index.js') ? "pathname === '/api/dsh-knowledge-graph/reading-map'" : "reading-map"), file + ' lacks reading-map parity')
}

const directory = mkdtempSync(join(tmpdir(), 'kg-reading-map-'))
const database = join(directory, 'graph.sqlite')
process.env.DSH_KG_DB = database
try {
  const store = await openSqliteStore(database)
  store.saveGraph(graph, { sourceText: document.sourceText, sourceUnits: paragraphs })
  store.close()
  const persistentHost = await import('../lib/index.js')
  const routes = []
  persistentHost.apply({
    get(name) { return name === 'webServer' ? { register(route) { routes.push(route); return () => {} } } : null },
    effect(fn) { return fn() }, interval() { return () => {} },
  })
  const route = routes.find(item => item.path === '/api/dsh-knowledge-graph')
  assert(route, 'persistent Host did not register the HTTP API')
  const post = body => new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'; req.url = '/api/dsh-knowledge-graph/reading-map'; req.headers = {}
    const res = { setHeader() {}, writeHead() {}, end(data) { try { resolve(JSON.parse(data)) } catch (error) { reject(error) } } }
    route.handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
  const http = await post({ documentId, expectedRevision: 1, topicId: 'chapter-a', limit: 2 })
  assert.equal(http.revision, 1)
  assert.equal(http.items.length, 2)
  assert.equal(http.items[0].citations[0].quote, 'Only source statement A.')
  assert.equal((await post({ documentId, expectedRevision: 0 })).error.code, 'revision_conflict')
  assert.equal((await post({ documentId: 'absent' })).error.code, 'not_found')
  const after = await openSqliteStore(database)
  assert.equal(after.getDocumentRevision(documentId), 1, 'read-only route changed canonical revision')
  const largeId = 'reading-map-large'
  const largeNodes = Array.from({ length: 5000 }, (_, index) => ({ id: 'large-' + index, type: 'fact', text: 'Statement ' + index,
    paragraph: index, sectionId: 'topic-' + Math.floor(index / 500), quote: '', evidence: [] }))
  const largeEdges = Array.from({ length: 8500 }, (_, index) => ({ fromNodeId: 'large-' + (index % 4999),
    toNodeId: 'large-' + ((index % 4999) + 1), relation: index < 4999 ? 'supports' : 'infers' }))
  after.saveGraph({ source: { documentId: largeId, id: 'large-source', sections: Array.from({ length: 10 }, (_, index) => ({
    id: 'topic-' + index, title: 'Topic ' + index, startParagraph: index * 500, endParagraph: index * 500 + 499,
  })) }, nodes: largeNodes, edges: largeEdges }, { sourceText: 'Large isolated fixture' })
  const started = performance.now()
  const large = await post({ documentId: largeId, expectedRevision: 1, topicId: 'topic-9', offset: 480, limit: 20 })
  const largeMs = Math.round(performance.now() - started)
  assert.equal(large.topics.length, 10)
  assert.equal(large.total, 500)
  assert.equal(large.items.length, 20)
  assert.equal(large.items.at(-1).nodeId, 'large-4999')
  assert(JSON.stringify(large).length < 30000, 'map response must not send the whole book graph')
  console.log(JSON.stringify({ largeNodes: largeNodes.length, largeEdges: largeEdges.length, responseBytes: JSON.stringify(large).length, largeMs }))
  after.close()
} finally {
  delete process.env.DSH_KG_DB
  rmSync(directory, { recursive: true, force: true })
}
console.log(JSON.stringify({ topics: first.topics.length, paginated: true, invalidEvidenceExcluded: true, readOnly: true, revisionFence: true }))
