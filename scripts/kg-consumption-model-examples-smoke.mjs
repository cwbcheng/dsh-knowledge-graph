import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import { openSqliteStore } from '../src/kg-store.mjs'
import hostPlugin from '../src/index.host.js'
import { createModelStructureTools, createModelConsumptionTools } from '../src/kg-model-structure.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelExamplesFixture } from './kg-consumption-model-examples-fixture-data.mjs'

const fixture = modelExamplesFixture(), requests = []
const llm = { stream(request) {
  requests.push(request.messages?.[0]?.content?.[0]?.text || '')
  const output = request.system.includes('独立的逐句证据核验员') ? { decisions: [] }
    : { status: 'answered', parts: [{ text: '资料证明条件必然满足，计算正确，模型成立且读者已经掌握。', evidenceIds: ['ev1'] }], confidence: 1 }
  return (async function* () {
    yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
} }
const harness = await modelLearningHarness({ fixture, llm })
const server = createServer((req, res) => harness.handler(req, res))
const originalQuery = SqliteKnowledgeStore.prototype.queryDocumentGraph, previousHarness = globalThis.harness
let writer, interleavings = 0
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/'
  const post = async (args, method = 'graph-query') => {
    const response = await fetch(base + method, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: fixture.documentId, expectedRevision: 1, ...args }) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const options = id => ({ nodeIds: [id], hops: 0, maxNodes: 1 })
  const one = id => post(options(id))
  const canonical = id => fixture.graph.nodes.find(node => node.id === id).modelStructure
  const answer = async nodeIds => {
    const started = await post({ nodeIds, hops: 0, limit: 8, maxNodes: 8,
      question: '请核对已记录实例、缺项和来源，不能确认实际适用、数值正确、独立验证或掌握。',
      model: { provider: 'fake', model: 'fake' } }, 'answer-graph')
    assert(started.taskId && !started.error, JSON.stringify(started))
    for (let index = 0; index < 500; index++) {
      const state = await (await fetch(base + 'task-status?taskId=' + encodeURIComponent(started.taskId))).json()
      if (state.status !== 'running') {
        assert.equal(state.status, 'succeeded', JSON.stringify(state))
        assert(!/必然满足|计算正确|模型成立|已经掌握/.test(state.result.answer), 'Saved pairs cannot certify applicability, calculation, truth or mastery')
        return state.result
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Synthetic answer did not complete')
  }
  const baseline = harness.store.getCanonicalDocument(fixture.documentId)
  const taxi = await one('taxi')
  assert(!taxi.error, JSON.stringify(taxi))
  assert.equal(taxi.graph.nodes.length, 1)
  assert.equal(taxi.graph.edges.length, 0)
  assert(!taxi.graph.nodes[0].modelStructure)
  assert.equal(taxi.modelContexts.scope, 'slots_and_branches_only', 'Preserve the separate atomic core contract')
  assert.equal(taxi.modelExampleContexts.basis, 'recorded_examples_not_validation')
  assert.equal(taxi.modelExampleContexts.totalExamples, 3)
  assert.equal(taxi.modelExampleContexts.examplesIncluded, 2)
  assert.equal(taxi.modelExampleContexts.examplesOmitted, 1)
  assert.deepEqual(taxi.modelExampleContexts.items.map(item => item.example), canonical('taxi').examples.slice(0, 2))
  assert(taxi.modelExampleContexts.items.every(item => item.revision === 1 && item.documentId === fixture.documentId))
  assert.deepEqual(taxi, harness.store.queryDocumentGraph(fixture.documentId, { expectedRevision: 1, ...options('taxi'), includeSourceFallback: false }))
  const handlers = new Map()
  globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
  hostPlugin().apply({ get: () => null, interval: () => () => {} })
  const local = structuredClone(fixture.graph)
  delete local.source.documentId
  local.revision = 1
  const ids = ['multi', 'units', 'times', 'same-name', 'unknown-unit', 'unknown-state', 'wrong-model', 'type-model',
    'unknown-role', 'uncited', 'return-model', 'duplicate-concept', 'unsupported-model'].map(id => 'pair-' + id)
  for (const id of ids) {
    const found = await one(id), core = found.modelContexts.items[0], pair = found.modelExampleContexts.items[0]
    assert.equal(core.status, 'recorded_core', id)
    assert.deepEqual(core.structure.slots, canonical(id).slots)
    assert.deepEqual(core.structure.branches, canonical(id).branches)
    assert.deepEqual(pair.example, canonical(id).examples[0])
    assert.equal(pair.fieldCheck.complete, id !== 'pair-unknown-role')
    assert.equal(core.entailmentStatus, id === 'pair-unsupported-model' ? 'unsupported' : 'unverified')
    assert.equal(found.metrics.modelExampleContextChars, JSON.stringify(found.modelExampleContexts).length)
    assert(found.metrics.contextChars <= found.metrics.contextBudget)
    const dynamic = await handlers.get('graph-query')({ graph: local, text: fixture.sourceText, ...options(id) })
    assert(!dynamic.error, JSON.stringify(dynamic))
    assert.deepEqual(dynamic.modelExampleContexts.items[0].example, pair.example)
    assert.deepEqual(dynamic.modelExampleContexts.items[0].fieldCheck, pair.fieldCheck)
  }
  const incomplete = (await one('pair-incomplete')).modelExampleContexts.items[0]
  assert.equal(incomplete.fieldCheck.complete, false)
  assert.deepEqual(incomplete.fieldCheck.missingBindings, ['net-force'])
  const unknown = (await one('pair-unknown-role')).modelExampleContexts.items[0]
  assert.deepEqual(unknown.fieldCheck.unknownRoleSlots, ['available'])
  const noBranch = (await one('pair-no-branch')).modelExampleContexts.items[0]
  assert.equal(noBranch.fieldCheck.branchRecorded, false)
  assert.equal(noBranch.fieldCheck.complete, false)
  assert.equal((await one('pair-no-reasoning')).modelExampleContexts.items[0].fieldCheck.reasoningRecorded, false)
  const conflicts = await post({ nodeIds: ['pair-conflict-a', 'pair-conflict-b'], hops: 0, limit: 2, maxNodes: 2 })
  assert.deepEqual(new Set(conflicts.modelExampleContexts.items.map(item => item.example.outputs[0].value)), new Set(['10', '12']))
  assert.equal(conflicts.modelContexts.items.length, 2, 'Do not collapse conflicting examples into a consensus or mix their model identities')
  const many = await post({ nodeIds: Array.from({ length: 8 }, (_, index) => 'pair-many-' + index), hops: 0, limit: 8, maxNodes: 8 })
  assert.equal(many.modelExampleContexts.totalExamples, 16)
  assert.equal(many.modelExampleContexts.items.length, 8)
  assert.equal(many.modelExampleContexts.examplesOmitted, 8)
  assert(many.modelExampleContexts.models.every(model => model.checkedExamples <= 2))
  const huge = await one('pair-huge')
  assert.equal(huge.modelContexts.items[0].status, 'recorded_core')
  assert.equal(huge.modelContexts.items[0].structure.slots.length, 33)
  assert.equal(huge.modelExampleContexts.items.length, 0, 'Never cut required bindings to fit an oversized pair')
  assert.equal(huge.modelExampleContexts.models[0].budgetOmittedExamples, 1)
  assert.equal(huge.modelExampleContexts.examplesOmitted, 1)
  assert.equal((await one('unknown')).modelExampleContexts.modelsWithoutCore, 1)
  assert.equal((await post({ ...options('taxi'), expectedRevision: 0 })).error.code, 'revision_conflict')
  const forged = await post({ ...options('taxi'), modelExampleContexts: { items: [{ example: { outputs: ['PROVEN'] } }] },
    graph: { nodes: [] }, text: 'forged source' })
  assert.deepEqual(forged, taxi)
  const tools = createModelConsumptionTools(createModelStructureTools())
  const context = { documentId: fixture.documentId, revision: 1, budget: 1024,
    loadNodes: ids => new Map(ids.map(id => [id, fixture.graph.nodes.find(node => node.id === id)])),
    loadUnits: paragraphs => new Map(paragraphs.map(paragraph => [paragraph, fixture.sourceUnits[paragraph].text])) }
  const small = tools.buildExamples(fixture.graph.nodes, (await one('pair-long-source')).modelContexts, context)
  assert(JSON.stringify(small).length <= 1024)
  assert.equal(small.items.length, 0)
  assert.equal(small.examplesOmitted, 1)

  const sourceParagraph = canonical('pair-source').examples[0].provenance.paragraph
  for (const kind of ['source', 'user', 'ai', 'unknown']) {
    const id = 'pair-' + kind, found = await one(id)
    assert.equal(found.modelExampleContexts.items[0].example.provenance.kind, kind)
    assert.equal(found.sourceUnits.some(unit => unit.paragraph === sourceParagraph), kind === 'source')
    await answer([id])
    const prompt = requests.findLast(text => text.startsWith('用户问题：'))
    const records = prompt.split('\n').filter(line => line.startsWith('[模型记录] ')).map(line => JSON.parse(line.slice('[模型记录] '.length)))
    assert.deepEqual(records[0].pairedExamples[0].example, canonical(id).examples[0])
    const quoted = prompt.split('\n').some(line => /^\[ev\d+\]/.test(line) && line.includes('PAIRSOURCEONLY'))
    assert.equal(quoted, kind === 'source', 'A matching user/AI/unknown quote is not citation authority')
    assert(prompt.includes('已经包含输出') && prompt.includes('不是未见题或新情境验证') && prompt.includes('不检查条件满足、数值正确'))
  }
  await answer(['pair-long-source'])
  const longPrompt = requests.findLast(text => text.startsWith('用户问题：'))
  assert(longPrompt.includes(canonical('pair-long-source').examples[0].provenance.quote))
  assert(!longPrompt.split('\n').some(line => /^\[ev\d+\]/.test(line) && line.includes('PAIRLONGSOURCE')),
    'An overlong quote cannot acquire citation authority by losing its final qualifier')
  await answer(Array.from({ length: 8 }, (_, index) => 'pair-many-' + index))
  const pressure = requests.findLast(text => text.startsWith('用户问题：'))
  assert(pressure.length <= 24000)
  const records = pressure.split('\n').filter(line => line.startsWith('[模型记录] ')).map(line => JSON.parse(line.slice('[模型记录] '.length)))
  const includedAtPrompt = records.reduce((count, record) => count + (record.pairedExamples?.length || 0), 0)
  for (const record of records) {
    assert.deepEqual(record.structure.slots, canonical(record.modelId).slots)
    assert.deepEqual(record.structure.branches, canonical(record.modelId).branches)
    for (const pair of record.pairedExamples || []) {
      assert.equal(pair.modelId, record.modelId)
      assert.deepEqual(pair.example, canonical(record.modelId).examples.find(example => example.id === pair.example.id))
    }
  }
  assert.equal(Number(pressure.match(/提示词预算另行省略成对实例 (\d+) 个/)[1]), 8 - includedAtPrompt)
  const pressured = await answer(Array.from({ length: 4 }, (_, index) => 'pair-pressure-' + index))
  const pressuredPrompt = requests.findLast(text => text.startsWith('用户问题：'))
  assert(pressuredPrompt.length <= 24000)
  const pressuredRecords = pressuredPrompt.split('\n').filter(line => line.startsWith('[模型记录] ')).map(line => JSON.parse(line.slice('[模型记录] '.length)))
  const pressuredCount = pressuredRecords.reduce((count, record) => count + (record.pairedExamples?.length || 0), 0)
  console.log(JSON.stringify({ promptBudgetObservation: true, chars: pressuredPrompt.length,
    retrievedPairs: pressured.retrieval.modelExampleContexts.items.length, promptedPairs: pressuredCount,
    records: pressuredRecords.map(record => ({ id: record.modelId, chars: JSON.stringify(record).length })) }))
  assert(pressuredCount < pressured.retrieval.modelExampleContexts.items.length, 'Exercise real prompt-level pair omission in addition to the HTTP sample budget')
  assert.equal(Number(pressuredPrompt.match(/提示词预算另行省略成对实例 (\d+) 个/)[1]), pressured.retrieval.modelExampleContexts.items.length - pressuredCount)
  for (const record of pressuredRecords) {
    assert.deepEqual(record.structure.slots, canonical(record.modelId).slots)
    assert.deepEqual(record.structure.branches, canonical(record.modelId).branches)
    for (const pair of record.pairedExamples || []) assert.deepEqual(pair.example,
      canonical(record.modelId).examples.find(example => example.id === pair.example.id))
  }

  const originalAttributes = harness.store.db.prepare('SELECT attributes_json FROM graph_nodes WHERE document_id = ? AND node_id = ?')
    .get(fixture.documentId, 'pair-source').attributes_json
  const corruptions = [
    structure => { structure.examples[0].inputs.push(structure.examples[0].inputs[0]) },
    structure => { structure.examples[0].outputs[0].slotId = 'distance-slot' },
    structure => { structure.examples[0].branchId = 'missing' },
    structure => { structure.examples[0].provenance.kind = 'observation' },
    structure => { structure.examples[0].execute = 'globalThis.__PAIR_EXECUTED__ = true' },
  ]
  for (const corrupt of corruptions) {
    const attributes = JSON.parse(originalAttributes)
    corrupt(attributes.modelStructure)
    harness.store.db.prepare('UPDATE graph_nodes SET attributes_json = ? WHERE document_id = ? AND node_id = ?')
      .run(JSON.stringify(attributes), fixture.documentId, 'pair-source')
    const bad = await one('pair-source')
    assert.equal(bad.modelContexts.items[0].status, 'invalid')
    assert.equal(bad.modelExampleContexts.items.length, 0)
    assert.equal(bad.modelExampleContexts.modelsWithoutCore, 1)
  }
  const attributes = JSON.parse(originalAttributes)
  attributes.modelStructure.examples[0].provenance.quote = 'not in the canonical source'
  harness.store.db.prepare('UPDATE graph_nodes SET attributes_json = ? WHERE document_id = ? AND node_id = ?')
    .run(JSON.stringify(attributes), fixture.documentId, 'pair-source')
  const invalidQuote = await one('pair-source')
  assert.equal(invalidQuote.modelContexts.items[0].status, 'recorded_core')
  assert.equal(invalidQuote.modelExampleContexts.models[0].invalidExamples, 1)
  assert.equal(invalidQuote.modelExampleContexts.items.length, 0)
  assert(!invalidQuote.sourceUnits.some(unit => unit.paragraph === sourceParagraph))
  harness.store.db.prepare('UPDATE graph_nodes SET attributes_json = ? WHERE document_id = ? AND node_id = ?')
    .run(originalAttributes, fixture.documentId, 'pair-source')
  assert(!globalThis.__PAIR_EXECUTED__)
  const prepare = harness.store.db.prepare
  harness.store.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (sql.startsWith('SELECT paragraph, text FROM document_units')) {
      const all = statement.all
      statement.all = function (...params) {
        if (params.includes(sourceParagraph)) throw new Error('synthetic example-only source read failure')
        return all.apply(this, params)
      }
    }
    return statement
  }
  try { assert.throws(() => harness.store.queryDocumentGraph(fixture.documentId, { expectedRevision: 1, ...options('pair-source') }), /example-only source read failure/) }
  finally { harness.store.db.prepare = prepare }
  assert.equal(harness.store.db.isTransaction, false)
  assert.deepEqual(harness.store.getCanonicalDocument(fixture.documentId), baseline)

  harness.store.db.exec('PRAGMA journal_mode = WAL')
  writer = await openSqliteStore(harness.database)
  const updated = structuredClone(fixture), changed = updated.graph.nodes.find(node => node.id === 'pair-source').modelStructure.examples[0]
  changed.outputs[0].value = '11'
  changed.scenario = 'PAIRNEWSOURCE: the same synthetic trip predicts 11 units; not validated.'
  changed.provenance.quote = changed.scenario
  updated.sourceUnits[sourceParagraph].text += '\n' + changed.scenario
  updated.sourceText = updated.sourceUnits.map(unit => unit.text).join('\n\n')
  let armed = true
  SqliteKnowledgeStore.prototype.queryDocumentGraph = function (...args) {
    if (this.filename !== harness.database || !armed) return originalQuery.apply(this, args)
    const prepare = this.db.prepare
    this.db.prepare = function (sql) {
      const statement = prepare.call(this, sql)
      if (sql.startsWith('SELECT paragraph, text FROM document_units')) {
        const all = statement.all
        statement.all = function (...params) {
          const rows = all.apply(this, params)
          if (armed && params.includes(sourceParagraph)) {
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
  const before = harness.store.queryDocumentGraph(fixture.documentId, { expectedRevision: 1, ...options('pair-source'), includeSourceFallback: false })
  const raced = await one('pair-source')
  assert.deepEqual(raced, before, 'Pair values, branch core, source units and revision must remain one read snapshot')
  assert.equal(interleavings, 1)
  assert.equal((await one('pair-source')).error.code, 'revision_conflict')
  const current = await post({ ...options('pair-source'), expectedRevision: 2 })
  assert.equal(current.modelExampleContexts.items[0].example.outputs[0].value, '11')
  assert(current.sourceUnits.some(unit => unit.text.includes('PAIRNEWSOURCE')))
  assert.notEqual(current.queryId, before.queryId)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
  console.log(JSON.stringify({ ok: true, actualHostHttp: true, roleCases: ids.length, incompleteFieldsPreserved: true,
    declaredOrigins: 4, sampleLimit: 8, atomicHugePairOmission: true, coreContractUnchanged: true,
    corruptionsRejected: corruptions.length + 1, promptChars: pressure.length, promptExamples: includedAtPrompt,
    interleavings, syntheticOnlyCalls: requests.length, noLearningWrites: true }))
} finally {
  SqliteKnowledgeStore.prototype.queryDocumentGraph = originalQuery
  globalThis.harness = previousHarness
  writer?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  harness.stop()
}
