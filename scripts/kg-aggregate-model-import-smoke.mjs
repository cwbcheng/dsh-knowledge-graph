import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { getOntology, withManualModels, hasMaterialCoordinates } from '../src/kg-ontology.mjs'
import { openSqliteStore } from '../src/kg-store.mjs'

const contract = createGraphContract(), documentId = 'aggregate-import-test'
const sourceText = '故知足不辱，知止不殆，可以长久。'
const citation = { paragraph: 0, quote: sourceText }
const node = (id, type, text) => ({ id, type, text, ...citation, evidence: [citation], state: 'candidate', entailmentStatus: 'unverified' })
const base = { ontology: 'aggregate-v1', source: { id: 'source-test', documentId, title: '经典文本', paragraphCount: 1 },
  nodes: [node('claim', 'claim', sourceText), node('input', 'concept', '知足知止'), node('output', 'concept', '长久')], edges: [] }
const provenance = { kind: 'ai', ...citation, note: '依据原文归纳，待审校' }
const model = { ...node('model', 'connection_model', '知足知止与长久'), modelStructure: { version: 1, identity: 'hypothesis',
  slots: [{ id: 'in', conceptId: 'input', label: '知足知止', role: 'input', unit: '', state: '实践', provenance },
    { id: 'out', conceptId: 'output', label: '长久', role: 'output', unit: '', state: '结果', provenance }],
  branches: [{ id: 'limits', label: '知足知止', condition: { text: '知足知止', provenance }, mapping: { text: '不辱、不殆，可以长久', provenance },
    boundary: { text: '文本中的实践主张，未作普遍因果认证', provenance } }], examples: [] } }
const edges = [{ fromNodeId: 'model', toNodeId: 'input', relation: 'maps_between', role: 'input', evidence: [citation] },
  { fromNodeId: 'model', toNodeId: 'output', relation: 'maps_between', role: 'output', evidence: [citation] }]
assert.equal(getOntology('aggregate-v1').nodeTypes.length, 8, 'extraction vocabulary remains frozen')
assert.equal(withManualModels(getOntology('aggregate-v1')).nodeTypes.length, 9)
assert.equal(hasMaterialCoordinates(withManualModels(getOntology('aggregate-v1'))), false, 'classic claims must not be relabeled as learning materials')
const full = { ...base, nodes: [...base.nodes, model], edges }
assert.equal(contract.validateGraphInvariants(full, sourceText, { includeQuality: false }).blockingIssues.length, 0)
assert(contract.validateGraphInvariants({ ...full, ontology: 'proposition-v1' }, sourceText, { includeQuality: false }).blockingIssues.length > 0,
  'the authored extension must not silently widen the proposition ontology')
const directory = mkdtempSync(join(tmpdir(), 'kg-aggregate-model-import-')), previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(directory, 'test.sqlite')
let store
try {
  store = await openSqliteStore(process.env.DSH_KG_DB)
  store.saveGraph(base, { sourceText, sourceUnits: [{ paragraph: 0, text: sourceText }] })
  const routes = [], { apply } = await import('../lib/index.js')
  apply({ get: name => name === 'webServer' ? { register: route => { routes.push(route); return () => {} } } : null,
    effect: fn => fn(), interval: () => () => {} })
  const route = routes.find(item => item.path === '/api/dsh-knowledge-graph')
  const post = (method, body) => new Promise((resolve, reject) => {
    const req = new EventEmitter(); req.method = 'POST'; req.url = '/api/dsh-knowledge-graph/' + method; req.headers = {}
    const res = { setHeader() {}, writeHead() {}, end(data) { try { resolve(JSON.parse(data)) } catch (error) { reject(error) } } }
    route.handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
  const request = { documentId, expectedRevision: 1, baseNodeIds: [], baseEdgeKeys: [], graph: { nodes: [model], edges } }
  assert.equal((await post('graph-commit-preview', request)).valid, true)
  assert.equal(store.getDocumentRevision(documentId), 1, 'preview is read-only')
  const saved = await post('graph-commit', request)
  assert.equal(saved.revision, 2, JSON.stringify(saved.error))
  assert(saved.graph.graphOntology.nodeTypes.some(type => type.id === 'connection_model'))
  assert.deepEqual(saved.graph.graphOntology.edgeAttributes, ['role'])
  assert(!saved.graph.graphOntology.nodeTypes.some(type => type.kind), 'classic node semantics are preserved')
  assert.equal((await post('graph-commit', request)).error.code, 'revision_conflict')
  const bad = structuredClone(model); bad.id = 'bad'; bad.modelStructure.slots[0].provenance.quote = '编造摘录'
  assert((await post('graph-commit', { ...request, expectedRevision: 2, graph: { nodes: [bad], edges: [] } })).error)
  assert.equal(store.getDocumentRevision(documentId), 2)
  const read = await post('connection-models', { documentId, expectedRevision: 2, modelId: 'model' })
  assert.equal(read.model.inputs.length, 1)
  assert.equal(read.model.outputs.length, 1)
  assert.equal(read.structure.branches[0].mapping.provenance.kind, 'ai')
  store.close(); store = await openSqliteStore(process.env.DSH_KG_DB)
  assert.deepEqual(store.getDocument(documentId).nodes.find(item => item.id === 'model').modelStructure, model.modelStructure)
  assert.equal(store.getDocument(documentId).edges[0].role, 'input', 'roles survive a database reopen')
  for (const original of base.nodes) {
    const retained = store.getDocument(documentId).nodes.find(item => item.id === original.id)
    assert(retained, 'the original node must remain present')
    assert.equal(retained.text, original.text)
    assert.equal(retained.quote, original.quote)
    assert.equal(retained.type, original.type)
  }
  assert.equal(store.getDocument(documentId).sourceText, sourceText)
} finally {
  store?.close()
  if (previousDb === undefined) delete process.env.DSH_KG_DB; else process.env.DSH_KG_DB = previousDb
  rmSync(directory, { recursive: true, force: true })
}
console.log(JSON.stringify({ ok: true, authoredClassicModels: true, originalGraphPreserved: true, staleWritesRejected: true, sourceQuotesChecked: true, sqliteReopen: true }))
