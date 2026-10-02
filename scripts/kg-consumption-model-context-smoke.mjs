import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import { openSqliteStore } from '../src/kg-store.mjs'
import hostPlugin from '../src/index.host.js'
import { createModelStructureTools, createModelConsumptionTools } from '../src/kg-model-structure.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelChainFixture } from './kg-model-chain-fixture-data.mjs'

const fixture = modelChainFixture()
const originalTaximodel = fixture.graph.nodes.find(node => node.id === 'taxi')
const sourceParagraph = fixture.sourceUnits.length
const sourceQuote = '结构专用来源：通常仅在无附加收费的本次行程中使用，不能证明实际账单或掌握。'
fixture.sourceUnits.push({ paragraph: sourceParagraph, text: sourceQuote })
fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
fixture.graph.source.paragraphCount = fixture.sourceUnits.length
const coreSource = { ...structuredClone(originalTaximodel), id: 'core-source', text: '独立字段来源模型' }
coreSource.modelStructure.branches[1].boundary = { text: sourceQuote,
  provenance: { kind: 'source', paragraph: sourceParagraph, quote: sourceQuote, note: '' } }
fixture.graph.nodes.push(coreSource)
const aiSource = { ...structuredClone(coreSource), id: 'ai-source', text: 'AI 个人字段不是来源证据' }
aiSource.modelStructure.branches[1].boundary.provenance.kind = 'ai'
fixture.graph.nodes.push(aiSource)
for (const [id, amount] of [['conflict-a', 10], ['conflict-b', 12]]) {
  const paragraph = fixture.sourceUnits.length
  const quote = '相互冲突的隔离来源 ' + id + '：同一行程、同一条件，基础费用 = ' + amount + ' 元，尚未独立验证。'
  fixture.sourceUnits.push({ paragraph, text: quote })
  const model = { ...structuredClone(originalTaximodel), id, text: '同一端点的冲突来源 ' + id }
  const field = text => ({ text, provenance: { kind: 'source', paragraph, quote, note: '' } })
  model.modelStructure.branches = [{ id: 'conflict', label: '同一行程、同一条件', condition: field('同一行程、同一条件'),
    mapping: field('基础费用 = ' + amount + ' 元'), boundary: field('来源互相冲突，尚未独立验证') }]
  model.modelStructure.examples = []
  fixture.graph.nodes.push(model)
}
const longParagraph = fixture.sourceUnits.length
const longQuote = '长字段来源：' + '已记录情境，'.repeat(140) + '但仅为错误模型示例，不代表事实成立。'
fixture.sourceUnits.push({ paragraph: longParagraph, text: longQuote })
const longSource = { ...structuredClone(originalTaximodel), id: 'long-source' }
longSource.modelStructure.branches[1].boundary = { text: '仅为错误模型示例，不代表事实成立。',
  provenance: { kind: 'source', paragraph: longParagraph, quote: longQuote, note: '' } }
fixture.graph.nodes.push(longSource)
const large = { ...structuredClone(originalTaximodel), id: 'large-core' }
const userField = text => ({ text, provenance: { kind: 'user', paragraph: null, quote: '', note: '' } })
large.modelStructure.branches = Array.from({ length: 30 }, (_, index) => ({ id: 'large-' + index, label: '复杂条件 ' + index,
  condition: userField('条件'.repeat(500)), mapping: userField('往往'.repeat(500)), boundary: userField('限定'.repeat(500)) }))
large.modelStructure.examples = []
fixture.graph.nodes.push(large)
for (let index = 0; index < 8; index++) {
  const model = { ...structuredClone(originalTaximodel), id: 'medium-' + index, text: '预算压力模型 ' + index }
  model.modelStructure.branches = [{ id: 'medium', label: '不作语义保证', condition: userField('条件'.repeat(650)),
    mapping: userField('往往'.repeat(650)), boundary: userField('限制'.repeat(650)) }]
  model.modelStructure.examples = []
  fixture.graph.nodes.push(model)
}
fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
fixture.graph.source.paragraphCount = fixture.sourceUnits.length
const requests = []
const llm = { stream(request) {
  const userText = request.messages?.[0]?.content?.[0]?.text || ''
  requests.push({ system: request.system, userText })
  const output = request.system.includes('独立的逐句证据核验员') ? { decisions: [] }
    : { status: 'answered', parts: [{ text: '资料已证明该模型必然正确且读者已经掌握。', evidenceIds: ['ev1'] }], confidence: 1 }
  return (async function* () {
    yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
} }
const harness = await modelLearningHarness({ fixture, llm })
const server = createServer((req, res) => harness.handler(req, res))
let writer, interleavings = 0
const originalQuery = SqliteKnowledgeStore.prototype.queryDocumentGraph
const previousHarness = globalThis.harness
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/'
  const post = async (args, method = 'graph-query') => {
    const response = await fetch(base + method, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: harness.document.documentId, expectedRevision: 1, ...args }) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const query = options => harness.store.queryDocumentGraph(harness.document.documentId, { expectedRevision: 1, ...options })
  const one = id => post({ nodeIds: [id], hops: 0, maxNodes: 1 })
  const answer = async options => {
    const start = await post({ question: '请核对记录中的输入、条件和限定语，不作事实或掌握认证。',
      model: { provider: 'fake', model: 'fake' }, ...options }, 'answer-graph')
    assert(!start.error && start.taskId, JSON.stringify(start))
    for (let index = 0; index < 500; index++) {
      const response = await fetch(base + 'task-status?taskId=' + encodeURIComponent(start.taskId))
      const status = await response.json()
      if (status.status !== 'running') {
        assert.equal(status.status, 'succeeded', JSON.stringify(status))
        assert(!status.result.answer.includes('必然正确') && !status.result.answer.includes('已经掌握'),
          'Structured fields must not admit fabricated proof or mastery claims')
        return status.result
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Synthetic answer task did not complete')
  }
  const baseline = harness.store.getCanonicalDocument(harness.document.documentId)
  const result = await post({ nodeIds: ['multi'], hops: 0, maxNodes: 1 })
  assert(!result.error)
  console.log(JSON.stringify({ regressionObservation: true, nodes: result.graph.nodes.map(node => node.id),
    structuredContextPresent: !!result.modelContexts }))
  assert(result.modelContexts, 'Model retrieval must preserve independent inputs, outputs and branches even with a one-node graph window')
  assert.equal(result.modelContexts.items[0].status, 'recorded_core')
  assert.deepEqual(result.modelContexts.items[0].structure.slots.map(slot => [slot.id, slot.conceptId, slot.role, slot.unit, slot.state]),
    [['initial-speed', 'speed', 'input', 'm/s', '初始时刻'], ['net-force', 'force', 'input', 'N', '运动期间'],
      ['final-speed', 'speed', 'output', 'm/s', '后续时刻']])
  assert.equal(result.modelContexts.scope, 'slots_and_branches_only')
  assert.equal(result.metrics.returnedNodes, 1)
  assert.equal(result.metrics.returnedEdges, 0)
  assert(!result.graph.nodes[0].modelStructure, 'Do not expand bounded graph nodes into unbounded structures')
  assert.equal(result.modelContexts.items[0].structure.branches[0].boundary.text, '不能仅由两个输入作出确定数值预测')
  assert.deepEqual(result, query({ nodeIds: ['multi'], hops: 0, maxNodes: 1, includeSourceFallback: false }))

  const ids = ['taxi', 'budget-model', 'units', 'times', 'same-name', 'unknown-unit', 'unknown-state', 'wrong-model',
    'type-model', 'unknown-role', 'uncited', 'return-model', 'duplicate-concept', 'unsupported-model', 'core-source', 'ai-source',
    'conflict-a', 'conflict-b', 'long-source']
  for (const id of ids) {
    const found = await one(id), item = found.modelContexts.items[0]
    const canonical = baseline.graph.nodes.find(node => node.id === id).modelStructure
    assert.equal(item.modelId, id)
    assert.equal(item.status, 'recorded_core', id + ': ' + JSON.stringify(item))
    assert.deepEqual(item.structure, { version: canonical.version, identity: canonical.identity, slots: canonical.slots, branches: canonical.branches })
    assert.equal(item.examplesIncluded, 0)
    assert.equal(item.examplesOmitted, canonical.examples.length)
    assert.equal(item.documentId, harness.document.documentId)
    assert.equal(item.revision, 1)
    assert.equal(item.entailmentStatus, id === 'unsupported-model' ? 'unsupported' : 'unverified')
    assert.equal(found.metrics.modelContextChars, JSON.stringify(found.modelContexts).length)
    assert(found.metrics.contextChars <= found.metrics.contextBudget)
    assert(JSON.stringify(found.modelContexts).length <= found.modelContexts.budget)
  }
  assert.equal((await one('same-name')).modelContexts.items[0].structure.slots[0].conceptId, 'fare-other')
  assert.equal((await one('budget-model')).modelContexts.items[0].structure.slots[0].conceptId, 'fare')
  assert.equal((await one('duplicate-concept')).modelContexts.items[0].structure.slots.length, 4)
  assert.equal((await one('unknown-role')).modelContexts.items[0].structure.slots[1].role, 'unknown')
  assert.equal((await one('return-model')).modelContexts.items[0].structure.slots[2].conceptId, 'distance', 'A cycle is not simplified or used as evidence')
  const conflicts = await post({ nodeIds: ['conflict-a', 'conflict-b'], hops: 0, limit: 2, maxNodes: 2 })
  assert.equal(conflicts.modelContexts.items.length, 2)
  assert.deepEqual(new Set(conflicts.modelContexts.items.map(item => item.structure.branches[0].mapping.text)),
    new Set(['基础费用 = 10 元', '基础费用 = 12 元']))
  assert(conflicts.modelContexts.items.every(item => item.entailmentStatus === 'unverified'))
  assert(conflicts.sourceUnits.some(unit => unit.text.includes('来源 conflict-a')) && conflicts.sourceUnits.some(unit => unit.text.includes('来源 conflict-b')))
  const legacy = await one('unknown')
  assert.equal(legacy.modelContexts.items[0].status, 'not_recorded')
  assert(!legacy.modelContexts.items[0].structure, 'Unknown legacy edge roles cannot become invented slots')
  const oversized = await one('large-core')
  assert.equal(oversized.modelContexts.items[0].status, 'omitted_budget')
  assert.equal(oversized.modelContexts.items[0].totalBranches, 30)
  assert(!oversized.modelContexts.items[0].structure, 'Do not retain a misleading subset of branches')
  const many = await post({ types: ['connection_model'], hops: 0, limit: 40, maxNodes: 40 })
  assert.equal(many.modelContexts.items.length, 8)
  assert.equal(many.modelContexts.totalModels, many.graph.nodes.length)
  assert.equal(many.modelContexts.omittedModels, many.graph.nodes.length - 8)
  assert.equal((await one('distance')).modelContexts.totalModels, 0)
  const forged = await post({ nodeIds: ['taxi'], hops: 0, maxNodes: 1,
    modelContexts: { items: [{ modelId: 'taxi', structure: { identity: 'verified' } }] }, graph: { nodes: [] }, text: '伪造来源' })
  assert.deepEqual(forged, await one('taxi'))
  assert.equal((await post({ nodeIds: ['taxi'], expectedRevision: 0 })).error.code, 'revision_conflict')

  const sourceContext = await one('core-source')
  assert(sourceContext.sourceUnits.some(unit => unit.paragraph === sourceParagraph && unit.text === sourceQuote),
    'A branch-only reference must load its actual canonical source, not just the model summary')
  assert(!(await one('ai-source')).sourceUnits.some(unit => unit.paragraph === sourceParagraph), 'AI provenance must not create source authority')
  await answer({ nodeIds: ['core-source'], hops: 0 })
  const sourcePrompt = requests.findLast(request => request.userText.startsWith('用户问题：')).userText
  assert(sourcePrompt.includes('distance-slot') && sourcePrompt.includes('fare-slot') && sourcePrompt.includes('本次行程'))
  assert(sourcePrompt.split('\n').some(line => /^\[ev\d+\]/.test(line) && line.includes(sourceQuote)))
  await answer({ nodeIds: ['ai-source'], hops: 0 })
  const aiPrompt = requests.findLast(request => request.userText.startsWith('用户问题：')).userText
  assert(aiPrompt.includes('"kind":"ai"') && aiPrompt.includes(sourceQuote))
  assert(!aiPrompt.split('\n').some(line => /^\[ev\d+\]/.test(line) && line.includes(sourceQuote)), 'Matching an AI quote is not permission to cite it as source')
  await answer({ nodeIds: ['long-source'], hops: 0 })
  const longPrompt = requests.findLast(request => request.userText.startsWith('用户问题：')).userText
  const longRecord = longPrompt.split('\n').filter(line => line.startsWith('[模型记录] ')).map(line => JSON.parse(line.slice('[模型记录] '.length)))[0]
  assert.equal(longRecord.structure.branches[1].boundary.provenance.quote, longQuote, 'Do not clip a qualifier at the end of a field citation')
  assert(!longPrompt.split('\n').some(line => /^\[ev\d+\] node long-source\b/.test(line) && line.includes('| P' + longParagraph + ' |')),
    'A field citation longer than the evidence limit must be omitted, not turned into a truncated source authority')
  const pressure = await answer({ nodeIds: Array.from({ length: 8 }, (_, index) => 'medium-' + index), hops: 0, maxNodes: 8, limit: 8 })
  assert.equal(pressure.retrieval.modelContexts.items.length, 8)
  assert(pressure.retrieval.modelContexts.items.every(item => item.status === 'recorded_core'))
  const pressurePrompt = requests.findLast(request => request.userText.startsWith('用户问题：')).userText
  assert(pressurePrompt.length <= 24000)
  const promptModels = pressurePrompt.split('\n').filter(line => line.startsWith('[模型记录] ')).map(line => JSON.parse(line.slice('[模型记录] '.length)))
  assert(promptModels.length > 0 && promptModels.length < 8)
  for (const item of promptModels) assert.equal(item.structure.slots.length, 2)
  const omittedAtPrompt = Number(pressurePrompt.match(/提示词预算另行省略模型记录 (\d+) 个/)[1])
  assert.equal(omittedAtPrompt, 8 - promptModels.length)
  assert(pressurePrompt.includes('未知角色不得推断方向') && pressurePrompt.includes('同名不同 ID 不得合并'))
  assert(pressurePrompt.includes('不得自动逆推') && pressurePrompt.includes('循环充当证据') && pressurePrompt.includes('冲突来源'))

  const handlers = new Map()
  globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
  hostPlugin().apply({ get: () => null, interval: () => () => {} })
  const local = structuredClone(fixture.graph)
  delete local.source.documentId
  local.revision = 1
  const dynamic = await handlers.get('graph-query')({ graph: local, text: fixture.sourceText, nodeIds: ['multi'], hops: 0, maxNodes: 1 })
  assert(!dynamic.error, JSON.stringify(dynamic))
  assert.deepEqual(dynamic.modelContexts.items[0].structure, result.modelContexts.items[0].structure)
  assert.equal(dynamic.metrics.returnedNodes, 1)
  const dynamicSource = await handlers.get('graph-query')({ graph: local, text: fixture.sourceText, nodeIds: ['core-source'], hops: 0 })
  assert(dynamicSource.sourceUnits.some(unit => unit.paragraph === sourceParagraph && unit.text === sourceQuote))
  assert.equal((await handlers.get('graph-query')({ documentId: harness.document.documentId, graph: local, text: fixture.sourceText,
    nodeIds: ['multi'] })).error.code, 'not_found')

  const tools = createModelConsumptionTools(createModelStructureTools())
  const small = tools.build(fixture.graph.nodes, { documentId: harness.document.documentId, revision: 1, budget: 1024,
    loadNodes: ids => new Map(ids.map(id => [id, fixture.graph.nodes.find(node => node.id === id)])),
    loadUnits: paragraphs => new Map(paragraphs.map(paragraph => [paragraph, fixture.sourceUnits[paragraph].text])) })
  assert(JSON.stringify(small).length <= 1024)
  assert(small.items.every(item => !item.structure), 'Low budgets cannot chop core semantics into partial JSON')
  const originalAttributes = harness.store.db.prepare('SELECT attributes_json FROM graph_nodes WHERE document_id = ? AND node_id = ?')
    .get(harness.document.documentId, 'taxi').attributes_json
  const corruptions = [
    structure => { structure.slots[0].conceptId = 'missing' },
    structure => { structure.slots[0].conceptId = 'taxi' },
    structure => { structure.slots[1].id = structure.slots[0].id },
    structure => { structure.slots[0].role = 'causal' },
    structure => { structure.branches[0].condition.provenance.quote = 'not in stored source' },
    structure => { structure.branches[0].mapping.provenance.documentId = 'other-document' },
    structure => { structure.execute = 'globalThis.__SHOULD_NOT_EXECUTE__ = true' },
    structure => { structure.version = 2 },
    structure => { structure.identity = 'verified' },
  ]
  for (const corrupt of corruptions) {
    const attributes = JSON.parse(originalAttributes)
    corrupt(attributes.modelStructure)
    harness.store.db.prepare('UPDATE graph_nodes SET attributes_json = ? WHERE document_id = ? AND node_id = ?')
      .run(JSON.stringify(attributes), harness.document.documentId, 'taxi')
    const bad = await one('taxi')
    assert.equal(bad.modelContexts.items[0].status, 'invalid')
    assert(!bad.modelContexts.items[0].structure)
    assert.equal(harness.store.db.isTransaction, false)
  }
  for (const modelStructure of [false, 0, '', []]) {
    harness.store.db.prepare('UPDATE graph_nodes SET attributes_json = ? WHERE document_id = ? AND node_id = ?')
      .run(JSON.stringify({ modelStructure }), harness.document.documentId, 'taxi')
    assert.equal((await one('taxi')).modelContexts.items[0].status, 'invalid', 'Malformed falsy structures must not masquerade as absent')
  }
  harness.store.db.prepare('UPDATE graph_nodes SET attributes_json = ? WHERE document_id = ? AND node_id = ?')
    .run(originalAttributes, harness.document.documentId, 'taxi')
  assert(!globalThis.__SHOULD_NOT_EXECUTE__)
  const prepare = harness.store.db.prepare
  harness.store.db.prepare = function (sql) {
    if (sql.startsWith('SELECT paragraph, text FROM document_units')) throw new Error('synthetic canonical read failure')
    return prepare.call(this, sql)
  }
  try { assert.throws(() => query({ nodeIds: ['taxi'] }), /synthetic canonical read failure/) }
  finally { harness.store.db.prepare = prepare }
  assert.equal(harness.store.db.isTransaction, false)
  assert.deepEqual(harness.store.getCanonicalDocument(harness.document.documentId), baseline)

  harness.store.db.exec('PRAGMA journal_mode = WAL')
  writer = await openSqliteStore(harness.database)
  const updated = structuredClone(fixture)
  const updatedTaxi = updated.graph.nodes.find(node => node.id === 'taxi')
  updatedTaxi.modelStructure.slots[0].unit = 'm'
  updatedTaxi.modelStructure.slots[0].state = '下一次行程'
  updated.graph.nodes.find(node => node.id === 'distance').text = '修订后同名变量，须重新核对'
  let armed = true
  SqliteKnowledgeStore.prototype.queryDocumentGraph = function (...args) {
    if (this.filename !== harness.database || !armed) return originalQuery.apply(this, args)
    const prepare = this.db.prepare
    this.db.prepare = function (sql) {
      const statement = prepare.call(this, sql)
      if (sql.startsWith('SELECT * FROM graph_nodes WHERE document_id = ? AND node_id IN (')) {
        const all = statement.all
        statement.all = function (...params) {
          const rows = all.apply(this, params)
          if (armed) {
            armed = false
            writer.saveGraph(updated.graph, { sourceText: updated.sourceText, sourceUnits: updated.sourceUnits, expectedRevision: 1 })
            interleavings++
          }
          return rows
        }
      }
      return statement
    }
    try { return originalQuery.apply(this, args) }
    finally { this.db.prepare = prepare }
  }
  const beforeRace = query({ nodeIds: ['taxi'], hops: 0, maxNodes: 1, includeSourceFallback: false })
  const raced = await one('taxi')
  assert.deepEqual(raced, beforeRace, 'Core structure, concepts, source references and revision must share one SQLite snapshot')
  assert.equal(interleavings, 1)
  assert.equal((await one('taxi')).error.code, 'revision_conflict')
  const current = await post({ nodeIds: ['taxi'], hops: 0, maxNodes: 1, expectedRevision: 2 })
  assert.equal(current.modelContexts.items[0].structure.slots[0].unit, 'm')
  assert.equal(current.modelContexts.items[0].structure.slots[0].state, '下一次行程')
  assert.equal(current.modelContexts.items[0].concepts[0].text, '修订后同名变量，须重新核对')
  assert.notEqual(current.queryId, beforeRace.queryId)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
  console.log(JSON.stringify({ ok: true, actualHostHttp: true, oneNodeWindowIndependentSlots: true,
    retainedModels: ids.length, unknownRolesAndConflictingIdentityPreserved: true, unitStateAndQualifierPreserved: true,
    boundedAtomicCore: true, examplesExplicitlyExcluded: true, canonicalFieldSourceLoaded: true,
    userAiNotSourceAuthority: true, promptChars: pressurePrompt.length, promptModels: promptModels.length,
    conflictingSourcesBothRetained: true, longFieldCitationNeverClipped: true,
    corruptionsRejected: corruptions.length + 4, readFailureCleaned: true, interleavings, oldRevisionRejected: true,
    syntheticOnlyModelCalls: requests.length, noLearningWrites: true }))
} finally {
  SqliteKnowledgeStore.prototype.queryDocumentGraph = originalQuery
  globalThis.harness = previousHarness
  writer?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  harness.stop()
}
