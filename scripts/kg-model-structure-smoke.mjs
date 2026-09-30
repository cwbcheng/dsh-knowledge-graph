import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

const document = modelStructureFixture(), before = JSON.stringify(document)
const contract = createGraphContract(), tools = createModelStructureTools()
const query = args => contract.connectionModels(document, { expectedRevision: 1, ...args })
const taxi = query({ modelId: 'taxi' })
assert.equal(taxi.structure.branches[0].pairedExamples, 1)
assert.equal(taxi.structure.branches[1].pairedExamples, 1)
assert.equal(taxi.structure.branches[1].incompleteExamples, 1)
assert.deepEqual(taxi.structure.examples[2].missing, ['distance-slot'])
assert.equal(taxi.structure.examples[2].complete, false, 'missing necessary input must not count as a complete pair')
assert.equal(query({ modelId: 'taxi', branchId: 'extra' }).structure.filteredTotal, 2)
assert.equal(query({ modelId: 'taxi', branchId: 'missing' }).error.code, 'invalid_input')
assert.equal(taxi.structure.branches[2].condition.text, '', 'unknown condition must not become unconditional')
assert(query({ modelId: 'taxi' }).model.warnings.includes('存在未核对的适用条件'))
assert.equal(taxi.structure.examples[0].provenance.kind, 'user', 'derived examples must not become author quotations')
assert.equal(query({ modelId: 'taxi', structureEdit: true }).modelStructure.examples.length, 3)
assert.equal(taxi.modelStructure, undefined, 'read view does not expose the unpaged editing payload')
const motion = query({ modelId: 'multi' })
assert(motion.model.warnings.includes('结构槽位与原有图谱端点并不一一对应'))
assert(motion.legacyPorts.some(port => port.node.nodeId === 'fare' && port.role === 'output'), 'reviewed slots must not conceal different legacy graph endpoints')
const anomalous = structuredClone(document)
anomalous.graph.edges.push({ fromNodeId: 'taxi', toNodeId: 'factor', relation: 'maps_between', role: 'input' })
const withLegacyAnomaly = contract.connectionModels(anomalous, { expectedRevision: 1, modelId: 'taxi' })
assert(withLegacyAnomaly.model.warnings.includes('原有图谱端点仍有未定角色或异常关系'))
assert(withLegacyAnomaly.legacyPorts.some(port => port.node.nodeId === 'factor' && port.role === 'unknown'), 'anomalous graph relationships remain visible without being accepted as concept slots')
const speedSlots = motion.ports.filter(port => port.node.nodeId === 'speed')
assert.deepEqual(speedSlots.map(port => port.slotId), ['initial-speed', 'final-speed'])
assert.deepEqual(speedSlots.map(port => port.timeState), ['初始时刻', '后续时刻'])
assert.equal(new Set(speedSlots.map(port => port.edgeIndex)).size, 2)
assert(query({ conceptId: 'speed', role: 'input' }).items.some(item => item.nodeId === 'multi'))
assert(query({ conceptId: 'speed', role: 'output' }).items.some(item => item.nodeId === 'multi'))
assert.equal(query({ concepts: true, query: '速度' }).items[0].nodeId, 'speed')
const plan = contract.learningPlan(document, { expectedRevision: 1, modelId: 'multi' })
assert.equal(plan.tasks[0].model.inputs[0].slotId, 'initial-speed')
assert.equal(plan.tasks[0].model.outputs[0].slotId, 'final-speed')
assert.equal(plan.tasks[0].model.branches[0].provenance.mapping, 'user')
assert.equal(plan.tasks[0].model.examples, undefined, 'example answers must not leak into the pre-reveal model snapshot')
const nodes = new Map(document.graph.nodes.map(node => [node.id, node]))
const units = new Map(document.sourceUnits.map(unit => [unit.paragraph, unit.text]))
const specification = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
const invalid = change => {
  const spec = structuredClone(specification); change(spec)
  assert.throws(() => tools.validate(spec, nodes, units), error => error.code === 'invalid_model_structure')
}
invalid(spec => { spec.slots[1].id = spec.slots[0].id })
invalid(spec => { spec.slots[0].conceptId = 'factor' })
invalid(spec => { spec.examples[0].inputs.push({ slotId: 'distance-slot', value: '3' }) })
invalid(spec => { spec.examples[0].outputs[0].slotId = 'distance-slot' })
invalid(spec => { spec.examples[0].branchId = 'missing' })
invalid(spec => { spec.branches[0].mapping.provenance.quote = 'invented source' })
invalid(spec => { spec.branches[0].mapping.provenance.paragraph = 1 })
invalid(spec => { spec.identity = 'verified' })
invalid(spec => { spec.slots[0].confidence = 100 })
invalid(spec => { spec.slots = Array.from({ length: 41 }, (_, index) => ({ ...spec.slots[0], id: 'slot-' + index })) })
assert.equal(JSON.stringify(document), before, 'projection must not mutate canonical data')

const many = structuredClone(document)
const manySpec = many.graph.nodes.find(node => node.id === 'taxi').modelStructure
manySpec.examples.push(...Array.from({ length: 23 }, (_, index) => ({ ...structuredClone(manySpec.examples[1]), id: 'extra-' + index })))
const page = contract.connectionModels(many, { expectedRevision: 1, modelId: 'taxi', branchId: 'extra', exampleOffset: 20 })
assert.equal(page.structure.examples.length, 5)
assert.equal(page.structure.filteredTotal, 25)
assert.equal(page.structure.branches[1].pairedExamples, 24)
const unitVariant = structuredClone(document)
const copy = structuredClone(unitVariant.graph.nodes.find(node => node.id === 'multi'))
copy.id = 'motion-copy'; copy.modelStructure.slots[0].unit = 'km/h'
unitVariant.graph.nodes.push(copy)
const comparison = contract.connectionModels(unitVariant, { expectedRevision: 1, modelId: 'multi', compareModelId: copy.id })
assert.equal(comparison.endpointStatus, 'different_recorded_direction', 'same concepts with different unit/state slots are not identical endpoints')
assert.equal(comparison.conditions, 'structured_text_not_executable')
assert.equal(comparison.equivalence, 'not_inferred')

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const production = (start, end) => {
  const from = client.indexOf(start), to = client.indexOf(end, from)
  assert(from >= 0 && to > from); return client.slice(from, to)
}
const helpers = new Function(`
  ${production('      const edgeKeyOf =', '      function edgeIndexForIssue(')}
  ${production('      function connectionRolePatch(', '      function ConnectionModelPanel(')}
  ${production('      function documentIdOfGraph(', '      function graphViewMetadata(')}
  ${production('      function asAllNodesGraph(', '      function historyMetadata(')}
  ${production('      function semanticOperationsOf(', '      function carrySemanticOperations(')}
  const graphSemanticOperations = new WeakMap()
  return { patch: connectionStructurePatch, controller(state, host) {
    const { resultView, graphCommitQueueRef, currentResultRef, graphRevisionRef, verifyBusyRef } = state
    const generationTaskActive = false, questionPhase = '', fullText = resultView.sourceText
    const makeView = (graph, sourceText) => ({ graph, sourceText })
    const setResultView = view => { state.savedView = view; currentResultRef.current = view }
    const setVerification = () => {}, setQuestionResult = () => {}
    ${production('        const reviewConnectionRoles =', '        const reviewConnectionModel =')}
    return reviewConnectionRoles
  } }
`)()
const directory = mkdtempSync(join(tmpdir(), 'kg-model-structure-'))
const oldDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(directory, 'isolated.sqlite')
try {
  let store = await openSqliteStore(process.env.DSH_KG_DB)
  store.saveGraph(document.graph, { sourceText: document.sourceText, sourceUnits: document.sourceUnits })
  store.close(); store = await openSqliteStore(process.env.DSH_KG_DB)
  assert.deepEqual(store.getDocument(document.documentId).nodes.find(node => node.id === 'multi').modelStructure, nodes.get('multi').modelStructure, 'slot identities and time states must survive SQLite reopen')
  const routes = [], persistent = await import('../lib/index.js')
  persistent.apply({ get: name => name === 'webServer' ? { register: route => { routes.push(route); return () => {} } } : null,
    effect: fn => fn(), interval: () => () => {} })
  const route = routes.find(item => item.path === '/api/dsh-knowledge-graph')
  const post = (method, body) => new Promise((resolve, reject) => {
    const req = new EventEmitter(); req.method = 'POST'; req.url = '/api/dsh-knowledge-graph/' + method; req.headers = {}
    const res = { setHeader() {}, writeHead() {}, end(data) { try { resolve(JSON.parse(data)) } catch (error) { reject(error) } } }
    route.handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
  const read = revision => post('connection-models', { documentId: document.documentId, expectedRevision: revision, modelId: 'multi', structureEdit: true })
  assert.equal((await read(1)).ports.filter(port => port.node.nodeId === 'speed').length, 2)
  const original = store.getDocument(document.documentId)
  const resultView = { graph: original, sourceText: document.sourceText }
  const state = { resultView, currentResultRef: { current: resultView }, graphCommitQueueRef: { current: Promise.resolve() }, graphRevisionRef: { current: 1 }, verifyBusyRef: { current: false } }
  const calls = []
  const controller = helpers.controller(state, { call: (method, args) => { calls.push({ method, args }); return post(method, args) } })
  const proposed = structuredClone(nodes.get('multi').modelStructure)
  proposed.slots[2].state = '10 秒后'
  const unsupportedCalls = []
  const unsupportedController = helpers.controller(state, { call: async (method, args) => {
    unsupportedCalls.push(method)
    const result = await post(method, args)
    if (method === 'connection-models') delete result.modelStructureVersion
    return result
  } })
  await assert.rejects(unsupportedController({ modelId: 'multi', revision: 1, modelStructure: proposed }), /Host 尚未部署/)
  assert(!unsupportedCalls.some(method => method.startsWith('graph-commit')), 'a mixed-version Host must not receive structural previews or writes')
  const preview = await controller({ modelId: 'multi', revision: 1, modelStructure: proposed })
  assert.equal(preview.changes.length, 1)
  assert(preview.changes[0].text.includes('final-speed') && preview.changes[0].text.includes('时间或对象状态'))
  assert.equal(preview.changes[0].before, '后续时刻'); assert.equal(preview.changes[0].after, '10 秒后')
  const taxiDraft = structuredClone(nodes.get('taxi').modelStructure)
  taxiDraft.examples[0].outputs[0].value = '999'
  taxiDraft.branches[0].mapping.provenance.kind = 'ai'
  const semanticDiff = helpers.patch(original, 'taxi', taxiDraft).changes
  assert(semanticDiff.some(change => change.text.includes('输出状态') && change.before === '10' && change.after === '999'), 'paired answers must be visible in the approval')
  assert(semanticDiff.some(change => change.text.includes('来源身份') && change.after.includes('AI 建议')), 'provenance changes must be visible in the approval')
  assert.equal(store.getDocumentRevision(document.documentId), 1, 'preview must be read-only')
  const previewRequest = calls.find(call => call.method === 'graph-commit-preview').args
  assert.equal(previewRequest.graph.nodes.length, 1, 'only the target model is changed')
  assert.equal(previewRequest.graph.edges.length, 0, 'structure editing must not invent formal graph edges')
  const changed = structuredClone(proposed); changed.slots[2].state = '20 秒后'
  await assert.rejects(controller({ modelId: 'multi', revision: 1, modelStructure: changed, preview }), /重新预览/)
  await controller({ modelId: 'multi', revision: 1, modelStructure: proposed, preview })
  assert.equal((await read(2)).ports[2].timeState, '10 秒后')
  assert.equal(store.getDocument(document.documentId).edges.length, original.edges.length)
  assert.equal((await post('graph-commit', previewRequest)).error.code, 'revision_conflict')
  const current = store.getDocument(document.documentId), target = current.nodes.find(node => node.id === 'multi')
  const bad = structuredClone(target); bad.modelStructure.slots[0].conceptId = 'missing'
  const request = { documentId: document.documentId, expectedRevision: 2, baseNodeIds: ['multi'], baseEdgeKeys: [], graph: { nodes: [bad], edges: [] } }
  assert.equal((await post('graph-commit-preview', request)).error.code, 'invariant_violation')
  assert.equal((await post('graph-commit', request)).error.code, 'invariant_violation')
  assert.equal(store.getDocumentRevision(document.documentId), 2)
  const removeConcept = { documentId: document.documentId, expectedRevision: 2, baseNodeIds: ['speed'], baseEdgeKeys: [], graph: { nodes: [], edges: [] } }
  assert.equal((await post('graph-commit', removeConcept)).error.code, 'invariant_violation', 'removing a referenced concept must be rejected even when the relationship is stored as a slot')
  const stripped = { ...target }; delete stripped.modelStructure; stripped.text += '（保留结构）'
  assert(!(await post('graph-commit', { ...request, graph: { nodes: [stripped], edges: [] } })).error)
  assert.equal((await read(3)).ports[2].timeState, '10 秒后', 'older projections cannot erase reviewed structure')
  const rawInvalid = structuredClone(store.getDocument(document.documentId)); rawInvalid.nodes.find(node => node.id === 'multi').modelStructure.slots[0].conceptId = 'missing'
  assert.throws(() => store.saveGraph(rawInvalid, { sourceText: document.sourceText, expectedRevision: 3 }), error => error.code === 'invalid_model_structure')
  assert.equal(store.getDocumentRevision(document.documentId), 3, 'invalid raw store writes must roll back atomically')
  assert.equal(store.getDocument(document.documentId).sourceText, document.sourceText)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  store.close()
} finally {
  if (oldDb === undefined) delete process.env.DSH_KG_DB; else process.env.DSH_KG_DB = oldDb
  rmSync(directory, { recursive: true, force: true })
}
console.log(JSON.stringify({ ok: true, independentSlotIdentity: true, sqliteReopen: true, sourceKindSeparated: true,
  branchCoverageNotTruth: true, missingInputVisible: true, pagedExamples: true, productionController: true,
  staleAndChangedApprovalRejected: true, structuralReferencesProtected: true, legacyProjectionPreservesStructure: true }))
