import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { createSourceRelationTools } from '../src/kg-source-relations.mjs'
import { openSqliteStore } from '../src/kg-store.mjs'

const sourceText = '失道矣而后德，失德而后仁，失仁而后义，失义而后礼。\n\n故知足不辱，知止不殆，可以长久。'
const units = sourceText.split('\n\n').map((text, paragraph) => ({ text, paragraph }))
const provenance = { kind: 'source', paragraph: 0, quote: units[0].text, note: '' }
const field = text => ({ text, provenance })
const node = (id, type, text) => ({ id, type, text, paragraph: 0, quote: units[0].text, evidence: [provenance], state: 'candidate', entailmentStatus: 'unverified' })
const graph = { ontology: 'aggregate-v1', source: { documentId: 'source-relations-fixture', id: 'source-relations-source', title: '条件映射' },
  nodes: [node('dao', 'concept', '道（失道语境）'), node('de', 'concept', '德（失道语境）'),
    { ...node('model', 'connection_model', '失道而后德的文本次序'), modelStructure: { version: 1, identity: 'hypothesis',
      slots: ['dao', 'de'].map((conceptId, i) => ({ id: 's' + i, conceptId, label: conceptId, role: i ? 'output' : 'input', state: '', unit: '', provenance })),
      branches: [{ id: 'loss', label: '失道后德', condition: field('失道'), mapping: field('失道矣而后德'),
        boundary: { text: '这是原文的规范性次序，不能升级为历史演化或无条件的经验因果。'.repeat(4),
          provenance: { kind: 'ai', paragraph: null, quote: '', note: '解释边界' } } }], examples: [] } }], edges: [] }
const tools = createSourceRelationTools(), contract = createGraphContract()
graph.edges.push(tools.build(graph, 'model', 'loss', 'dao', 'de'))
assert.equal(contract.validateGraphInvariants(graph, sourceText, { sourceUnits: units }).blockingIssues.length, 0)
assert(graph.edges[0].boundary.length > 64)
for (const change of [edge => { edge.condition = '' }, edge => { edge.statement = '道导致德' }, edge => { edge.modelId = 'de' },
  edge => { edge.branchId = 'missing' }, edge => { edge.evidence = [] }, edge => { edge.boundary = edge.boundary.slice(0, 64) }]) {
  const bad = structuredClone(graph); change(bad.edges[0])
  assert(contract.validateGraphInvariants(bad, sourceText, { sourceUnits: units }).blockingIssues.some(issue => issue.code === 'source_relation_invalid'))
}
const detached = structuredClone(graph); detached.nodes[2].modelStructure.slots.pop()
assert(tools.errors(detached, new Map(units.map(unit => [unit.paragraph, unit.text]))).length)
const forged = structuredClone(graph); forged.nodes[2].modelStructure.branches[0].condition.provenance = { ...provenance, quote: '虚构条件' }
assert(tools.errors(forged, new Map(units.map(unit => [unit.paragraph, unit.text]))).length)
const unconditional = structuredClone(graph); unconditional.nodes[2].modelStructure.branches[0].condition.text = '任何时候'
assert.throws(() => tools.build(unconditional, 'model', 'loss', 'dao', 'de'), { code: 'invalid_source_relation' })
const causal = structuredClone(graph); causal.edges[0].relation = 'causes'
assert(tools.errors(causal, new Map(units.map(unit => [unit.paragraph, unit.text]))).length, 'tagged source correspondence cannot be silently promoted to a causal relation')
for (const ontology of ['proposition-v1', 'learning-view-v1']) {
  assert(contract.validateGraphInvariants({ ...graph, ontology }, sourceText, { sourceUnits: units }).blockingIssues.length)
}
const batch = { units: [{ num: 0, text: units[0].text }] }, compressed = { ontology: 'aggregate-v1', nodes: [node('summary', 'claim', units[0].text)], edges: [] }
assert.equal(contract.mechanismCoverageNeeded(batch, compressed), true, 'classical multi-step conditions trigger the bounded coverage pass')
assert.equal(contract.mechanismCoverageNeeded(batch, { ...compressed, ontology: 'proposition-v1' }), false, 'classical cues do not alter the frozen default trigger')
assert.match(contract.ontologySystemPrompts['aggregate-v1'], /失道而后德.*不可改写为.*道导致德/)

const directory = mkdtempSync(join(tmpdir(), 'kg-source-relations-')), previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(directory, 'test.sqlite')
let store
try {
  store = await openSqliteStore(process.env.DSH_KG_DB)
  store.saveGraph({ ...graph, edges: [] }, { sourceText, sourceUnits: units })
  const routes = [], { apply } = await import('../lib/index.js')
  apply({ get: name => name === 'webServer' ? { register: route => { routes.push(route); return () => {} } } : null, effect: fn => fn(), interval: () => () => {} })
  const route = routes.find(item => item.path === '/api/dsh-knowledge-graph')
  const post = (method, body) => new Promise((resolve, reject) => {
    const req = new EventEmitter(); Object.assign(req, { method: 'POST', url: '/api/dsh-knowledge-graph/' + method, headers: {} })
    const res = { setHeader() {}, writeHead() {}, end(data) { try { resolve(JSON.parse(data)) } catch (error) { reject(error) } } }
    route.handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
  const request = { documentId: graph.source.documentId, expectedRevision: 1, baseNodeIds: [], baseEdgeKeys: [], graph: { nodes: [], edges: graph.edges } }
  assert.equal((await post('graph-commit-preview', request)).valid, true)
  assert.equal(store.getDocumentRevision(request.documentId), 1)
  const saved = await post('graph-commit', request)
  assert.equal(saved.revision, 2, JSON.stringify(saved.error))
  assert.equal((await post('graph-commit', request)).error.code, 'revision_conflict')
  const badRequest = structuredClone(request); badRequest.expectedRevision = 2; badRequest.baseEdgeKeys = ['dao>de:source_relation']; badRequest.graph.edges[0].condition = ''
  assert.equal((await post('graph-commit-preview', badRequest)).error.code, 'invariant_violation')
  store.close(); store = await openSqliteStore(process.env.DSH_KG_DB)
  const after = store.getDocument(request.documentId)
  for (const key of tools.attributes) assert.equal(after.edges[0][key], graph.edges[0][key], 'SQLite reopen retains ' + key)
  assert.equal(after.nodes.find(item => item.id === 'model').modelStructure.identity, 'hypothesis')
  assert(after.nodes.every(item => item.entailmentStatus !== 'supported'), 'locating a quote is not semantic truth verification')
  const badStore = structuredClone(after); badStore.edges[0].condition = ''
  assert.throws(() => store.saveGraph(badStore, { sourceText, expectedRevision: 2 }), { code: 'invalid_source_relation' })
  assert.equal(store.getDocumentRevision(request.documentId), 2)
} finally {
  store?.close(); if (previousDb === undefined) delete process.env.DSH_KG_DB; else process.env.DSH_KG_DB = previousDb
  rmSync(directory, { recursive: true, force: true })
}
console.log(JSON.stringify({ ok: true, sourceConditions: true, longBoundariesPreserved: true, staleWritesRejected: true, missingBindingsRejected: true, hypothesesPreserved: true, classicalCoverage: true }))
