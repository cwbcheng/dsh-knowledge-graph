import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { getOntology } from '../src/kg-ontology.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelPortReuseFixture } from './kg-model-port-reuse-fixture-data.mjs'

const contracts = createGraphContract(), exercises = ['prediction', 'counterexample', 'understanding']
const referencesOf = detail => {
  const first = new Map()
  for (const item of [detail.model, ...detail.ports.map(port => port.node), ...detail.related]) {
    if (!first.has(item.nodeId)) first.set(item.nodeId, item)
  }
  return [...first.values()].filter(item => item.citations.length).slice(0, 40).map(item => ({
    nodeId: item.nodeId, type: item.type, label: item.label, text: item.text,
    state: item.state, entailmentStatus: item.entailmentStatus, citations: item.citations,
  }))
}
const view = plan => ({ ...plan, tasks: plan.tasks.map(task => task.kind === 'model_prediction'
  ? { ...task, referenceCount: task.references.length, references: [] } : task) })
const measures = []
let planCases = 0
for (const [structured, slots] of [[false, 8192], [true, 40], [false, 4]]) {
  const document = modelPortReuseFixture({ chunks: 8, slots, structured })
  const model = document.graph.nodes.find(node => node.id === 'left')
  if (structured) {
    // The same concept may occupy distinct input/output slots and time states.
    model.modelStructure.slots[1].conceptId = 'port-0'
    model.modelStructure.slots[1].label = '同一概念的后续输出'
    model.modelStructure.slots[1].state = '后续情境'
  } else {
    document.graph.edges.push({ ...structuredClone(document.graph.edges[0]), role: 'unknown' })
  }
  for (let index = 0; index < 25; index++) {
    document.graph.nodes.push({ ...structuredClone(document.graph.nodes[0]), id: 'material-' + index, type: 'factor_material' })
    document.graph.edges.push({ fromNodeId: 'material-' + index, toNodeId: 'left', relation: 'builds',
      evidence: structuredClone(document.graph.nodes[0].evidence) })
  }
  document.graph.edges.push({ fromNodeId: 'port-0', toNodeId: 'left', relation: 'transfers_from',
    evidence: structuredClone(document.graph.nodes[0].evidence) })
  const nodeTypes = new Map(document.graph.nodes.map(node => [node.id, node.type]))
  const relations = new Map(getOntology(document.graph.ontology).relationTypes.map(relation => [relation.id, relation]))
  for (const edge of document.graph.edges) {
    const relation = relations.get(edge.relation)
    assert(relation, 'Test materials must use the document ontology')
    assert(relation.from.includes(nodeTypes.get(edge.fromNodeId)) && relation.to.includes(nodeTypes.get(edge.toNodeId)), 'Material/model endpoints must match the ontology')
  }
  if (slots === 4) document.graph.nodes.find(node => node.id === 'material-1').evidence.forEach(item => { item.sourceId = 'wrong-source' })
  const before = JSON.stringify(document), args = { modelId: 'left', expectedRevision: 1 }
  const detail = contracts.connectionModels(document, args), expectedReferences = referencesOf(detail)
  for (const exercise of exercises) {
    const plan = contracts.learningPlan(document, { ...args, exercise }), task = plan.tasks[0]
    assert.equal(plan.error, undefined); assert.equal(plan.tasks.length, 1)
    assert.deepEqual(task.references, expectedReferences, 'Evidence keeps model/port/material priority, first identity and complete citations')
    assert(task.references.length <= 40); assert.equal(task.referencesLimited, true)
    if (slots >= 40) assert.equal(task.references.length, 40)
    else {
      assert(task.references.some(item => item.nodeId === 'material-0' && item.text === '端点 0'), 'Same text with a different canonical identity is distinct evidence')
      assert(!task.references.some(item => item.nodeId === 'material-1'), 'Evidence from another source is not a model reference')
    }
    assert.equal(task.relatedTotal, 26)
    assert.equal(task.model.inputs.length, detail.ports.filter(port => port.role === 'input').length)
    assert.equal(task.model.outputs.length, detail.ports.filter(port => port.role === 'output').length)
    assert.equal(task.model.unknown.length, detail.ports.filter(port => port.role === 'unknown').length)
    assert.equal(task.references[1].nodeId, 'port-0'); assert.equal(task.references[1].text, '端点 0')
    assert.equal(task.origin, exercise === 'understanding' ? 'personal_expression_not_source' : 'derived_exercise_not_source')
    if (exercise !== 'understanding') assert.equal(task.novelty, 'not_verified')
    if (structured) {
      assert.equal(task.model.outputs[0].nodeId, 'port-0')
      assert.equal(task.model.outputs[0].slotId, 'slot-1'); assert.equal(task.model.outputs[0].state, '后续情境')
      assert.deepEqual(task.model.branches.map(branch => [branch.condition, branch.mapping, branch.boundary]),
        model.modelStructure.branches.map(branch => [branch.condition.text, branch.mapping.text, branch.boundary.text]))
      if (exercise === 'understanding') assert.deepEqual(task.model.branches[0].provenance.condition,
        model.modelStructure.branches[0].condition.provenance)
    }
    for (const reference of task.references) for (const citation of reference.citations) {
      assert.equal(citation.nodeId, reference.nodeId)
      assert(document.sourceUnits.some(unit => unit.paragraph === citation.paragraph && unit.text.includes(citation.quote)))
    }
    planCases++
  }
  if (!structured) {
    const findIndex = Array.prototype.findIndex
    let predicateVisits = 0
    // Observe actual nested reference searches, outside elapsed-time measurement.
    Array.prototype.findIndex = function (predicate, context) {
      if (this[0]?.nodeId !== 'left' || !Array.isArray(this[0]?.citations)) return findIndex.call(this, predicate, context)
      return findIndex.call(this, (item, index, all) => { predicateVisits++; return predicate.call(context, item, index, all) })
    }
    try { assert.deepEqual(contracts.learningPlan(document, { ...args, exercise: 'understanding' }).tasks[0].references, expectedReferences) }
    finally { Array.prototype.findIndex = findIndex }
    assert(predicateVisits <= (detail.ports.length + detail.related.length + 1) * 4, 'Reference merging must not repeatedly scan all preceding endpoint identities')
    measures.push({ ports: detail.ports.length, nestedPredicateVisits: predicateVisits })
  }
  assert.equal(JSON.stringify(document), before, 'Learning projections leave canonical roles, conditions and evidence unchanged')
  model.evidence = []; model.quote = ''
  assert.equal(contracts.learningPlan(document, args).tasks.length, 0, 'An uncited model cannot create a prediction exercise')
  const uncited = contracts.learningPlan(document, { ...args, exercise: 'understanding' }).tasks[0]
  assert(!uncited.references.some(item => item.nodeId === 'left'))
  assert.equal(uncited.references[0].nodeId, 'port-0', 'Uncited records do not consume the 40-reference budget')
  assert.equal(contracts.learningPlan(document, { ...args, expectedRevision: 0 }).error.code, 'revision_conflict')
}

const fixture = modelPortReuseFixture({ chunks: 8, slots: 4096, structured: false })
const harness = await modelLearningHarness({ fixture }), server = createServer(harness.handler)
let httpRequests = 0
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const canonical = harness.store.getCanonicalDocument(fixture.documentId), before = JSON.stringify(canonical)
  for (const exercise of exercises) {
    const args = { action: 'plan', documentId: fixture.documentId, modelId: 'left', expectedRevision: 1, exercise }
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dsh-knowledge-graph/learning-mode`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
    httpRequests++; assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), view(contracts.learningPlan(canonical, args)), 'Actual generated Host/SQLite HTTP preserves the complete learning view')
  }
  assert.equal(JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId)), before)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop()
}
console.log(JSON.stringify({ ok: true, planCases, measures, httpRequests, fullConditionsEvidenceAndIdentity: true,
  unchangedReferencePriorityAndLimit: true, predictionEvidenceHidden: true, actualPersistentHttp: true, readOnly: true }))
