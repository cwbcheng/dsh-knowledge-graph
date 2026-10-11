import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import hostPlugin, { createGraphContract } from '../src/index.host.js'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'

const fixture = modelStructureFixture(), handlers = new Map(), previousHarness = globalThis.harness
try {
  globalThis.harness = { handle: (name, handler) => handlers.set(name, handler) }
  hostPlugin().apply({ get: name => name === 'kgExtractor' ? async () => structuredClone(fixture.graph) : null,
    interval: () => () => {} })
} finally { globalThis.harness = previousHarness }
// Seed the temporary Host through its real extraction path, without a live model
// or direct access to its canonical maps; all subsequent reads use public RPCs.
const started = await handlers.get('extract')({ text: fixture.sourceText, documentId: fixture.documentId,
  title: 'Model learning query isolation', ontology: fixture.graph.ontology })
assert(!started.error, JSON.stringify(started))
let status
for (let n = 0; n < 300; n++) {
  status = await handlers.get('task-status')({ taskId: started.taskId })
  if (status.status !== 'running') break
  await new Promise(resolve => setTimeout(resolve, 5))
}
assert.equal(status.status, 'succeeded', JSON.stringify(status))
const documentId = status.result.source.documentId
// Extraction supplies legacy ports. Add the separately reviewed structure via
// preview and revision-checked commit, so both representations exercise RPCs.
const loaded = await handlers.get('document-export')({ documentId, includeSourceText: true })
const structures = fixture.graph.nodes.filter(node => node.modelStructure)
const request = { documentId, expectedRevision: loaded.revision, baseNodeIds: structures.map(node => node.id), baseEdgeKeys: [],
  graph: { nodes: structures.map(node => ({ ...loaded.graph.nodes.find(item => item.id === node.id), modelStructure: node.modelStructure })), edges: [] } }
const preview = await handlers.get('graph-commit-preview')(request)
assert.equal(preview.valid, true, JSON.stringify(preview))
assert.equal((await handlers.get('graph-commit')(request)).revision, loaded.revision + 1)
const exported = await handlers.get('document-export')({ documentId, includeSourceText: true })
const document = { documentId, revision: exported.revision, graph: exported.graph, sourceText: exported.sourceText,
  sourceUnits: createGraphContract().splitParagraphs(exported.sourceText).map((text, paragraph) => ({ paragraph, text })) }
const inputSnapshot = JSON.stringify(document)
const contracts = createGraphContract(), harness = await modelLearningHarness({ fixture: document })
// The fixture harness starts at revision 1; align it with the dynamic commit.
harness.store.saveGraph(document.graph, { sourceText: document.sourceText, sourceUnits: document.sourceUnits, expectedRevision: 1 })
const storedSnapshot = JSON.stringify(harness.store.getCanonicalDocument(documentId))
const server = createServer(harness.handler)
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let httpRequests = 0, dynamicQueries = 0, headlessQueries = 0
const call = async body => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dsh-knowledge-graph/learning-mode`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  httpRequests++
  assert.equal(response.status, 200)
  return response.json()
}
const revealView = plan => plan?.error ? plan : { ...plan, tasks: plan.tasks.map(task => task.kind === 'model_prediction'
  ? { ...task, referenceCount: task.references.length, references: [] } : task) }
const noise = [{ diagnosis: true }, { structureSources: true }, { concepts: true }, { compareModelId: 'multi' },
  { diagnosis: true, structureSources: true, concepts: true, compareModelId: 'multi', structureEdit: true },
  { chainDraft: {}, branchId: 'extra', sourceOffset: 7, offset: 20, limit: 1, query: '不存在' }]
try {
  // All three exercises must retain the full selected model, rather than a
  // differently shaped or branch-filtered connection-model query response.
  for (const modelId of ['taxi', 'multi', 'unknown']) for (const exercise of ['prediction', 'counterexample', 'understanding']) {
    const args = { action: 'plan', documentId, modelId, exercise, expectedRevision: document.revision }
    const expected = contracts.learningPlan(document, args), view = revealView(expected)
    assert.equal(expected.error, undefined); assert.equal(expected.tasks.length, 1)
    const baselineRpc = await handlers.get('learning-mode')(args); dynamicQueries++
    assert.deepEqual(baselineRpc, view); assert.deepEqual(await call(args), view)
    for (const options of noise) {
      const body = { ...args, ...options }
      assert.deepEqual(await handlers.get('learning-mode')(body), view); dynamicQueries++
      assert.deepEqual(contracts.learningPlan(document, body), expected); headlessQueries++
      assert.deepEqual(await call(body), view)
    }
    const task = expected.tasks[0]
    assert.equal(task.origin, exercise === 'understanding' ? 'personal_expression_not_source' : 'derived_exercise_not_source')
    if (exercise !== 'understanding') assert.equal(task.novelty, 'not_verified')
    for (const reference of task.references) for (const citation of reference.citations) {
      assert.equal(citation.nodeId, reference.nodeId)
      assert(document.sourceUnits.some(unit => unit.paragraph === citation.paragraph && unit.text.includes(citation.quote)))
    }
    if (modelId === 'taxi') {
      assert.deepEqual(task.model.inputs.map(port => [port.slotId, port.nodeId]), [['distance-slot', 'distance']])
      assert.deepEqual(task.model.outputs.map(port => [port.slotId, port.nodeId]), [['fare-slot', 'fare']])
      assert.deepEqual(task.model.branches.map(branch => [branch.id, branch.condition, branch.mapping, branch.boundary]),
        fixture.graph.nodes.find(node => node.id === modelId).modelStructure.branches.map(branch =>
          [branch.id, branch.condition.text, branch.mapping.text, branch.boundary.text]))
    }
    if (modelId === 'unknown') assert.equal(task.model.inputs.length + task.model.outputs.length, 0)
  }
  const args = { action: 'plan', documentId, modelId: 'taxi', expectedRevision: document.revision }
  for (const change of [{ expectedRevision: 0 }, { expectedRevision: undefined }, { modelId: 'fare' }, { exercise: 'invalid' }]) {
    const body = { ...args, ...change, ...noise[4] }, expected = contracts.learningPlan(document, body)
    assert.equal(expected.error?.code, change.modelId ? 'not_found' : change.exercise ? 'invalid_input' : 'revision_conflict')
    assert.deepEqual(await handlers.get('learning-mode')(body), expected); dynamicQueries++
    assert.deepEqual(await call(body), expected)
  }
  assert.equal((await handlers.get('learning-mode')({ ...args, action: 'save' })).error.code, 'persistence_unavailable')
  assert.equal((await handlers.get('learning-mode')({ ...args, documentId: 'missing' })).error.code, 'not_found')
  assert.equal(JSON.stringify(document), inputSnapshot)
  assert.deepEqual(await handlers.get('document-export')({ documentId, includeSourceText: true }), exported)
  assert.equal(JSON.stringify(harness.store.getCanonicalDocument(documentId)), storedSnapshot)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop()
}
console.log(JSON.stringify({ ok: true, actualDynamicRpc: true, actualPersistentHttp: true,
  httpRequests, dynamicQueries, headlessQueries, fullConditionsEvidenceAndIdentity: true, readOnly: true }))
