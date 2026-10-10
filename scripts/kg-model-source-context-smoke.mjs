import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelSourceContextFixture } from './kg-model-source-context-fixture-data.mjs'

const document = modelSourceContextFixture(), contract = createGraphContract()
const before = JSON.stringify(document), expected = document.sourceUnits.slice(0, 4)
const query = (fixture, args = {}) => contract.connectionModels(fixture, { expectedRevision: 1, modelId: 'taxi', ...args })
const units = result => result.sourceUnits.items || result.sourceUnits
const plain = values => values.map(({ paragraph, text }) => ({ paragraph, text }))
for (const args of [{}, { structureSources: true }, { structureEdit: true }]) {
  const result = query(document, args)
  assert(!result.error, JSON.stringify(result.error))
  assert.deepEqual(plain(units(result)), expected, 'context follows stored source order, not numeric +/- paragraph identities')
  assert.equal(new Set(units(result).map(unit => unit.paragraph)).size, 4)
  assert(!units(result).some(unit => unit.paragraph === 2000000000), 'unrelated text beyond the bounded neighbor range stays out')
  const unordered = structuredClone(document); unordered.sourceUnits.reverse()
  assert.deepEqual(query(unordered, args), result, 'SQLite and in-memory source enumeration order must agree')
}
const picker = query(document, { structureSources: true })
assert.equal(picker.sourceUnits.basis, 'stored_model_and_related_context_not_field_entailment')
assert.deepEqual(picker.sourceUnits.items.map(unit => unit.sourceId), Array(4).fill(document.graph.source.id))
const selected = { section: 'branches', id: 'base', field: 'condition' }
const tools = (await import('../src/kg-model-structure.mjs')).createModelStructureTools()
assert.deepEqual(tools.fieldFromSource(selected, picker.sourceUnits.items[0], expected[0].text), {
  text: expected[0].text, provenance: { kind: 'source', paragraph: 0, quote: expected[0].text, note: '' },
})
const withProvenance = structuredClone(document)
withProvenance.graph.nodes[0].modelStructure.branches[0].boundary = {
  text: document.sourceUnits[4].text,
  provenance: { kind: 'source', paragraph: 2000000000, quote: document.sourceUnits[4].text, note: '' },
}
assert.deepEqual(plain(query(withProvenance).sourceUnits), document.sourceUnits, 'field provenance has the same neighbor semantics as node evidence')
const absent = structuredClone(document)
absent.graph.nodes[0].paragraph = 6; absent.graph.nodes[0].quote = ''; absent.graph.nodes[0].evidence = []
absent.graph.nodes[0].modelStructure = null; absent.graph.nodes = [absent.graph.nodes[0]]; absent.graph.edges = []
assert.deepEqual(query(absent).sourceUnits, [], 'missing identity must not resolve to the nearest stored paragraph')
const dense = structuredClone(document), ids = new Map(document.sourceUnits.map((unit, index) => [unit.paragraph, index]))
const remap = value => {
  if (Array.isArray(value)) return value.map(remap)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key === 'paragraph' && ids.has(item) ? ids.get(item) : remap(item)]))
  return value
}
dense.graph = remap(dense.graph); dense.sourceUnits = remap(dense.sourceUnits)
assert.deepEqual(plain(query(dense).sourceUnits), dense.sourceUnits.slice(0, 4), 'dense identities retain the existing context range')
const fallback = { ...dense, sourceUnits: undefined }
assert.deepEqual(query(fallback).sourceUnits, query(dense).sourceUnits, 'legacy documents still use the normal parser fallback')
assert.equal(query(document, { expectedRevision: 0 }).error.code, 'revision_conflict')
assert.equal(JSON.stringify(document), before, 'projection does not mutate graph, source text or identities')

const many = structuredClone(document)
for (let index = 0; index < 30; index++) {
  const paragraph = 2000001000 + index * 1000, text = '关联材料 ' + index + '：仅在原文所述条件和边界内使用。'
  const evidence = [{ documentId: many.documentId, sourceId: many.graph.source.id, paragraph, quote: text }]
  many.sourceUnits.push({ paragraph, text })
  many.graph.nodes.push({ id: 'material-' + index, type: 'relation_material', text, paragraph, quote: text, evidence })
  many.graph.edges.push({ fromNodeId: 'material-' + index, toNodeId: 'taxi', relation: 'states_mapping', evidence })
}
many.sourceText = many.sourceUnits.map(unit => unit.text).join('\n\n')
const allPages = [], total = query(many, { structureSources: true }).sourceUnits.total
for (let sourceOffset = 0; sourceOffset < total; sourceOffset += 12) {
  const page = query(many, { structureSources: true, sourceOffset }).sourceUnits
  assert(page.items.length <= 12); assert.equal(page.total, total)
  allPages.push(...page.items)
}
assert.deepEqual(plain(allPages), many.sourceUnits, 'source picker includes sparse context around related materials beyond the first material page')
assert.equal(total, 35)

let modelCalls = 0, httpRequests = 0
const harness = await modelLearningHarness({ fixture: document, llm: { async createMessage() { modelCalls++; throw new Error('No model calls') } } })
const server = createServer((req, res) => harness.handler(req, res))
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const canonicalBefore = JSON.stringify(harness.store.getDocument(document.documentId))
  const sourceBefore = JSON.stringify(harness.store.getDocumentSourceUnits(document.documentId))
  const reopened = await openSqliteStore(harness.database)
  try { assert.deepEqual(plain(reopened.getDocumentSourceUnits(document.documentId)), document.sourceUnits) }
  finally { reopened.close() }
  const post = async args => {
    httpRequests++
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: document.documentId, expectedRevision: 1, modelId: 'taxi', ...args }),
    })
    assert.equal(response.status, 200); return response.json()
  }
  for (const args of [{}, { structureSources: true }, { structureEdit: true }]) {
    assert.deepEqual(await post(args), query(document, args), 'real persistent HTTP and dynamic Host preserve identical context and provenance')
  }
  const offset = await post({ structureSources: true, sourceOffset: 2 })
  assert.equal(offset.sourceUnits.total, 4)
  assert.deepEqual(plain(offset.sourceUnits.items), expected.slice(2), 'pagination counts actual stored units, not the largest identity')
  assert.equal((await post({ expectedRevision: 2 })).error.code, 'revision_conflict')
  assert.equal(JSON.stringify(harness.store.getDocument(document.documentId)), canonicalBefore)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(document.documentId)), sourceBefore)
  assert.equal(harness.store.getDocumentRevision(document.documentId), 1)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  assert.equal(modelCalls, 0)
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
console.log(JSON.stringify({ ok: true, sparseStoredNeighbors: expected.map(unit => unit.paragraph), boundedContext: true,
  fullConditionsAndBoundary: true, exactIdentityAndProvenance: true, absentAnchorNotGuessed: true, denseAndLegacyParity: true,
  allRelatedPages: total, sourcePageLimit: 12, httpRequests, sqliteReopen: true, readOnly: true, modelCalls }))
