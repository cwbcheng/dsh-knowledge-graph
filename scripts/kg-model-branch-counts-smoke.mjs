import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import hostPlugin, { createGraphContract } from '../src/index.host.js'
import { modelBranchCountsFixture, modelBranchCountsModes, countFullExampleFilters } from './kg-model-branch-counts-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'

const contract = createGraphContract(), read = (document, options = {}) => contract.connectionModels(document, { expectedRevision: document.revision, ...options })
let selectedQueries = 0
for (const slots of [2, 40]) for (const branches of [0, 2, 40]) for (const examples of [0, 21, 100]) {
  const document = modelBranchCountsFixture({ slots, branches, examples }), before = JSON.stringify(document)
  for (const options of modelBranchCountsModes.slice(0, 4)) {
    const expected = read(document, options), measured = countFullExampleFilters(() => read(document, options))
    assert.deepEqual(measured.response, expected); assert.equal(expected.error, undefined)
    assert.equal(measured.visits, (branches + 2) * examples, 'Branch counts do not repeatedly filter the entire example list')
    selectedQueries++
  }
  const detail = read(document, { modelId: 'taxi' }), structure = detail.structure
  assert.equal(structure.identity, 'hypothesis'); assert.equal(structure.origin, 'reviewed_structure_not_verified_truth')
  assert.equal(structure.exampleTotal, examples); assert.equal(structure.filteredTotal, examples)
  assert.equal(structure.examples.length, Math.min(examples, 20)); assert.equal(structure.branches.length, branches)
  const original = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  for (const branch of structure.branches) {
    const index = Number(branch.id.slice(7)), assigned = Array.from({ length: examples }, (_, i) => i).filter(i => i % branches === index)
    const complete = assigned.filter(i => index % 7 !== 6 && i % 3 !== 0 && i % 5 !== 0).length
    assert.equal(branch.pairedExamples, complete); assert.equal(branch.incompleteExamples, assigned.length - complete)
    assert.deepEqual(branch.condition, original.branches[index].condition); assert.deepEqual(branch.boundary, original.branches[index].boundary)
  }
  assert.equal(structure.branches.reduce((n, branch) => n + branch.pairedExamples + branch.incompleteExamples, 0), branches ? examples : 0)
  const page = read(document, { modelId: 'taxi', exampleOffset: 20 }).structure
  assert.deepEqual(page.branches, structure.branches); assert.equal(page.examples.length, Math.min(20, Math.max(0, examples - 20)))
  assert.deepEqual(page.examples.map(example => example.id), original.examples.slice(20, 40).map(example => example.id))
  if (branches > 1) {
    const filtered = read(document, { modelId: 'taxi', branchId: 'branch-1' }).structure
    assert.deepEqual(filtered.branches, structure.branches); assert.equal(filtered.exampleTotal, examples)
    assert.equal(filtered.filteredTotal, Math.floor((examples + branches - 2) / branches))
    assert(filtered.examples.every(example => example.branchId === 'branch-1'))
  }
  assert.equal(JSON.stringify(document), before)
}

const document = modelBranchCountsFixture(), structure = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
const first = read(document, { modelId: 'taxi' }).structure
structure.examples[1].branchId = ''
let current = read(document, { modelId: 'taxi' }).structure
assert.equal(current.branches[1].pairedExamples, first.branches[1].pairedExamples - 1)
assert.equal(current.examples[1].complete, false)
structure.examples[2].inputs = []
current = read(document, { modelId: 'taxi' }).structure
assert.equal(current.branches[2].pairedExamples, first.branches[2].pairedExamples - 1)
assert.equal(current.branches[2].incompleteExamples, first.branches[2].incompleteExamples + 1)
structure.branches[4].mapping.text = ''
assert.equal(read(document, { modelId: 'taxi' }).structure.branches[4].pairedExamples, 0)
const invalidBranch = read(document, { modelId: 'taxi', branchId: 'missing' })
assert.equal(invalidBranch.error.code, 'invalid_input')
document.revision++
assert.equal(read(document, { modelId: 'taxi', expectedRevision: 1 }).error.code, 'revision_conflict')

let httpRequests = 0, modelCalls = 0
for (const structured of [false, true]) {
  const fixture = modelBranchCountsFixture({ structured }), harness = await modelLearningHarness({ fixture,
    llm: { async createMessage() { modelCalls++; throw new Error('Read-only model queries must not call an LLM') } } })
  const server = createServer((req, res) => harness.handler(req, res))
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const canonical = harness.store.getCanonicalDocument(fixture.documentId), before = JSON.stringify(canonical)
    for (const options of modelBranchCountsModes) {
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: fixture.documentId, expectedRevision: 1, ...options }) })
      assert.deepEqual(await res.json(), read(canonical, options)); assert.equal(res.status, 200); httpRequests++
    }
    assert.equal(JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId)), before)
    assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
}

const fixture = modelBranchCountsFixture(), handlers = new Map(), previousHarness = globalThis.harness
try {
  globalThis.harness = { handle: (name, handler) => handlers.set(name, handler) }
  hostPlugin().apply({ get: name => name === 'kgExtractor' ? async () => structuredClone(fixture.graph) : null, interval: () => () => {} })
} finally { globalThis.harness = previousHarness }
const task = await handlers.get('extract')({ documentId: fixture.documentId, text: fixture.sourceText, title: 'Model branch example counts', ontology: fixture.graph.ontology })
assert.equal(task.error, undefined)
let status
for (let index = 0; index < 300; index++) {
  status = await handlers.get('task-status')({ taskId: task.taskId }); if (status.status !== 'running') break
  await new Promise(resolve => setTimeout(resolve, 5))
}
assert.equal(status.status, 'succeeded', JSON.stringify(status))
const documentId = status.result.source.documentId, loaded = await handlers.get('document-export')({ documentId, includeSourceText: true })
assert.equal(loaded.graph.nodes.filter(node => node.type === 'connection_model').length,
  fixture.graph.nodes.filter(node => node.type === 'connection_model').length)
const models = fixture.graph.nodes.filter(node => node.modelStructure)
assert(models.every(model => loaded.graph.nodes.some(node => node.id === model.id)))
const request = { documentId, expectedRevision: loaded.revision, baseNodeIds: models.map(node => node.id), baseEdgeKeys: [],
  graph: { nodes: models.map(model => ({ ...loaded.graph.nodes.find(node => node.id === model.id), modelStructure: model.modelStructure })), edges: [] } }
assert.equal((await handlers.get('graph-commit-preview')(request)).valid, true)
assert.equal((await handlers.get('graph-commit')(request)).revision, loaded.revision + 1)
const exported = await handlers.get('document-export')({ documentId, includeSourceText: true })
const dynamicDocument = { documentId, revision: exported.revision, graph: exported.graph, sourceText: exported.sourceText,
  sourceUnits: contract.splitParagraphs(exported.sourceText).map((text, paragraph) => ({ paragraph, text })) }
let dynamicQueries = 0
for (const options of modelBranchCountsModes) {
  assert.deepEqual(await handlers.get('connection-models')({ documentId, expectedRevision: dynamicDocument.revision, ...options }), read(dynamicDocument, options)); dynamicQueries++
}
assert.equal(read(dynamicDocument, { modelId: 'taxi' }).structure.exampleTotal, 100)
assert.equal(read(dynamicDocument, { modelId: 'taxi' }).structure.branches.length, 40)
assert.deepEqual(await handlers.get('document-export')({ documentId, includeSourceText: true }), exported)
assert.equal(modelCalls, 0)
console.log(JSON.stringify({ ok: true, selectedQueries, independentBranchCounts: true, completeAndIncompleteBindings: true,
  paginationConditionsEvidenceAndIdentity: true, sameObjectAndRevisionChanges: true, actualGeneratedHostHttp: true, httpRequests,
  actualDynamicRpc: true, dynamicQueries, publicPreviewAndCommit: true, canonicalAndLearningReadOnly: true, modelCalls }))
