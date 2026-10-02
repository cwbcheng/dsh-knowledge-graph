import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import hostPlugin from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelChainFixture } from './kg-model-chain-fixture-data.mjs'

const fixture = modelChainFixture()
const prefix = 'model:' + 'namespace:'.repeat(16)
const modelId = prefix + 'A'
const peerId = prefix + 'B'
const aliasId = prefix.slice(0, 160)
const conceptPrefix = 'concept:' + 'identity:'.repeat(20)
const conceptIds = [conceptPrefix + 'A', conceptPrefix + 'B']
const unusualId = '命名空间:模型 "甲">:' + '概念'.repeat(90)
const sourceId = 'source:' + 'opaque:'.repeat(25)
const chunkId = 'chunk:' + 'opaque:'.repeat(25)
const sectionIds = ['section:' + 'opaque:'.repeat(25) + 'A', 'section:' + 'opaque:'.repeat(25) + 'B']
fixture.graph.source.id = sourceId
fixture.graph.source.sections = sectionIds.map((id, index) => ({ id, title: 'Distinct section ' + index,
  startParagraph: 0, endParagraph: 0 }))
const originals = new Map()
for (const [id, template] of [[modelId, 'multi'], [peerId, 'budget-model'], [aliasId, 'wrong-model'],
  ...['units', 'times', 'same-name', 'unknown-unit', 'unknown-state', 'wrong-model', 'type-model', 'unknown-role',
    'uncited', 'return-model', 'duplicate-concept', 'unsupported-model'].map(id => [prefix + id, id])]) {
  const model = structuredClone(fixture.graph.nodes.find(node => node.id === template))
  Object.assign(model, { id, documentId: fixture.documentId, sourceId, chunkId, sectionId: sectionIds[id === peerId ? 1 : 0] })
  model.evidence = (model.evidence || []).map(item => ({ ...item, documentId: fixture.documentId, sourceId, chunkId }))
  originals.set(id, model)
  fixture.graph.nodes.push(model)
}
for (const [index, id] of conceptIds.entries()) {
  fixture.graph.nodes.push({ id, type: 'concept', text: '同名变量', quote: fixture.sourceUnits[0].text, paragraph: 0,
    sectionId: sectionIds[index], documentId: fixture.documentId, sourceId, chunkId,
    evidence: [{ paragraph: 0, quote: fixture.sourceUnits[0].text, documentId: fixture.documentId, sourceId, chunkId }] })
}
fixture.graph.edges.push(...conceptIds.map((id, index) => ({ fromNodeId: index ? peerId : modelId, toNodeId: id,
  relation: 'maps_between', documentId: fixture.documentId, sourceId, chunkId,
  evidence: [{ paragraph: 0, quote: fixture.sourceUnits[0].text, documentId: fixture.documentId, sourceId, chunkId }] })))
fixture.graph.nodes.push({ ...structuredClone(fixture.graph.nodes.find(node => node.id === conceptIds[0])), id: unusualId })
const requests = []
const llm = { stream(request) {
  const userText = request.messages?.[0]?.content?.[0]?.text || ''
  requests.push(userText)
  const output = request.system.includes('独立的逐句证据核验员') ? { decisions: JSON.parse(userText).parts.map(part => ({
    partId: part.partId, verdict: 'supported', evidenceIds: part.evidence.map(item => item.evidenceId),
  })) }
    : { status: 'answered', parts: [{ text: fixture.sourceUnits[0].text, evidenceIds: ['ev1'] }], confidence: 0 }
  return (async function* () {
    yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
} }
const harness = await modelLearningHarness({ fixture, llm })
const server = createServer((req, res) => harness.handler(req, res))
const previousHarness = globalThis.harness
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
  const query = options => harness.store.queryDocumentGraph(fixture.documentId, { expectedRevision: 1, ...options })
  const answer = async options => {
    const start = await post({ question: fixture.sourceUnits[0].text, nodeIds: [conceptIds[0]], hops: 0,
      model: { provider: 'synthetic', model: 'synthetic' }, ...options }, 'answer-graph')
    assert(start.taskId && !start.error, JSON.stringify(start))
    for (let index = 0; index < 500; index++) {
      const status = await (await fetch(base + 'task-status?taskId=' + encodeURIComponent(start.taskId))).json()
      if (status.status !== 'running') {
        assert.equal(status.status, 'succeeded', JSON.stringify(status))
        return status.result
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Synthetic answer task did not finish')
  }
  const handlers = new Map()
  globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
  hostPlugin().apply({ get: () => null, interval: () => () => {} })
  const local = structuredClone(fixture.graph)
  delete local.source.documentId
  local.revision = 1
  const dynamic = options => handlers.get('graph-query')({ graph: local, text: fixture.sourceText, expectedRevision: 1, ...options })
  const baseline = harness.store.getCanonicalDocument(fixture.documentId)
  const result = await post({ nodeIds: [modelId], hops: 0, maxNodes: 1 })
  assert(!result.error, 'An accepted opaque model ID must not crash or be changed during retrieval')
  assert.equal(result.graph.nodes[0].id, modelId)
  assert.equal(result.modelContexts.items[0].modelId, modelId)
  assert.equal(result.modelContexts.items[0].structure.slots.length, 3)
  for (const [id, model] of originals) {
    const options = { nodeIds: [id], hops: 0, maxNodes: 1 }
    const stored = query(options), http = await post(options), inMemory = await dynamic(options)
    assert.deepEqual(http, stored)
    for (const found of [http, inMemory]) {
      assert(!found.error, JSON.stringify(found.error))
      assert.equal(found.graph.nodes[0].id, id)
      assert.equal(found.matches[0].nodeId, id)
      const item = found.modelContexts.items[0]
      assert.equal(item.modelId, id)
      assert.equal(item.status, 'recorded_core')
      assert.deepEqual(item.structure, { version: model.modelStructure.version, identity: model.modelStructure.identity,
        slots: model.modelStructure.slots, branches: model.modelStructure.branches })
      assert.equal(item.entailmentStatus, model.entailmentStatus || 'unverified')
      assert(found.metrics.contextChars <= found.metrics.contextBudget)
      assert(JSON.stringify(found).length <= found.metrics.contextBudget + 20000)
    }
  }
  const options = { nodeIds: [modelId, peerId, aliasId, ...conceptIds], limit: 5, maxNodes: 5, hops: 0 }
  for (const found of [await post(options), await dynamic(options)]) {
    assert.equal(new Set(found.graph.nodes.map(node => node.id)).size, 5, 'Prefix aliases are not the same identity')
    assert.deepEqual(new Set(found.matches.map(match => match.nodeId)), new Set(options.nodeIds))
    assert.deepEqual(new Set(found.graph.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId)),
      new Set([modelId + '>' + conceptIds[0], peerId + '>' + conceptIds[1]]))
    assert.equal(found.graph.source.id, sourceId)
    assert.deepEqual(found.graph.source.sections.map(section => section.id), sectionIds)
    for (const node of found.graph.nodes) {
      assert.equal(node.sourceId, sourceId)
      assert.equal(node.chunkId, chunkId)
      assert(sectionIds.includes(node.sectionId))
      for (const evidence of node.evidence) {
        assert.equal(evidence.documentId, fixture.documentId)
        assert.equal(evidence.sourceId, sourceId)
        assert.equal(evidence.chunkId, chunkId)
      }
    }
    for (const edge of found.graph.edges) {
      assert.equal(edge.sourceId, sourceId)
      assert.equal(edge.chunkId, chunkId)
      assert.equal(edge.evidence[0].sourceId, sourceId)
      assert.equal(edge.evidence[0].chunkId, chunkId)
    }
    const sourceNodeIds = new Set(found.sourceUnits.flatMap(unit => unit.nodeIds))
    assert(sourceNodeIds.has(modelId) && sourceNodeIds.has(peerId))
    assert(found.sourceUnits.flatMap(unit => unit.edgeIds).includes(modelId + '>' + conceptIds[0] + ':maps_between'))
  }
  const section = await post({ sectionIds: [sectionIds[1]], maxNodes: 5, hops: 0 })
  assert.deepEqual(new Set(section.matches.map(match => match.nodeId)), new Set([peerId, conceptIds[1]]))
  assert.notEqual((await post({ nodeIds: [modelId] })).queryId, (await post({ nodeIds: [peerId] })).queryId)
  assert.equal((await post({ nodeIds: [prefix + 'missing'], hops: 0 })).graph.nodes.length, 0)
  const answered = await answer({})
  assert(answered.citations.some(citation => citation.targetId === conceptIds[0] && citation.nodeId === conceptIds[0]))
  assert(answered.supportingNodeIds.includes(conceptIds[0]))
  assert(answered.citations.some(citation => citation.sourceId === sourceId && citation.chunkId === chunkId && citation.sectionId === sectionIds[0]))
  assert(!answered.supportingNodeIds.includes(conceptIds[0].slice(0, 160)))
  assert(requests.some(request => request.includes(conceptIds[0])), 'Prompt evidence must preserve full target identity')
  assert(answered.followUps.some(question => question.includes(conceptIds[0])), 'Follow-up questions must not address a shortened prefix alias')
  assert(answered.followUps.every(question => question.length <= 600))
  const unusualAnswer = await answer({ nodeIds: [unusualId] })
  assert(unusualAnswer.citations.some(citation => citation.targetId === unusualId))
  assert(unusualAnswer.followUps.some(question => question.includes(JSON.stringify(unusualId))))
  assert(unusualAnswer.followUps.every(question => question.length <= 600))

  const documentPrefix = 'document:' + 'namespace:'.repeat(16)
  const aliasDocument = { ...structuredClone(fixture.graph), source: { ...fixture.graph.source, documentId: documentPrefix.slice(0, 160) } }
  const longDocument = { ...structuredClone(fixture.graph), source: { ...fixture.graph.source, documentId: documentPrefix + 'B' } }
  harness.store.saveGraph(aliasDocument, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
  harness.store.saveGraph(longDocument, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
  const longResult = await post({ documentId: longDocument.source.documentId, nodeIds: [modelId], hops: 0 })
  assert.equal(longResult.documentId, longDocument.source.documentId)
  assert.equal(longResult.graph.nodes[0].documentId, longDocument.source.documentId)
  assert.equal(longResult.modelContexts.items[0].documentId, longDocument.source.documentId)
  assert.equal((await answer({ documentId: longDocument.source.documentId })).retrieval.documentId, longDocument.source.documentId)
  const missingDocument = documentPrefix + 'missing'
  assert.equal((await post({ documentId: missingDocument, nodeIds: [modelId] })).error.code, 'not_found')
  assert.equal((await post({ documentId: missingDocument, question: 'Read the model' }, 'answer-graph')).error.code, 'not_found')
  assert.equal((await handlers.get('graph-query')({ documentId: missingDocument, graph: local, text: fixture.sourceText,
    nodeIds: [modelId] })).error.code, 'not_found', 'Canonical IDs cannot fall back to client graphs')

  // Read-only APIs must reject oversized identities, not mutate stored graphs or
  // return clipped IDs that now point at a different, shorter canonical node.
  const hugeId = '巨大身份:'.repeat(90000)
  const huge = { ...structuredClone(fixture.graph), source: { ...fixture.graph.source, documentId: 'huge-identities' } }
  huge.nodes = [{ id: hugeId, type: 'concept', text: 'Huge identity record', paragraph: 0 }]
  huge.edges = []
  harness.store.saveGraph(huge, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
  const hugeBaseline = harness.store.getDocument('huge-identities')
  const callsBeforeRejections = requests.length
  assert.throws(() => harness.store.queryDocumentGraph('huge-identities', { types: ['concept'] }), { code: 'limit_exceeded' })
  assert.equal((await post({ documentId: 'huge-identities', types: ['concept'] })).error.code, 'limit_exceeded')
  assert.equal((await post({ documentId: 'huge-identities', types: ['concept'], question: 'Huge identity record' }, 'answer-graph')).error.code, 'limit_exceeded')
  const hugeLocal = structuredClone(huge)
  delete hugeLocal.source.documentId
  assert.equal((await handlers.get('graph-query')({ graph: hugeLocal, types: ['concept'] })).error.code, 'limit_exceeded')
  assert.equal((await handlers.get('answer-graph')({ graph: hugeLocal, types: ['concept'], question: 'Huge identity record' })).error.code, 'limit_exceeded')
  assert.equal(requests.length, callsBeforeRejections, 'Oversized records must not start model tasks')
  assert.equal(harness.store.db.isTransaction, false)
  assert.deepEqual(harness.store.getDocument('huge-identities'), hugeBaseline)
  const hugeSource = structuredClone(huge)
  hugeSource.source.documentId = 'huge-source'
  hugeSource.source.id = 'opaque:'.repeat(9000)
  hugeSource.nodes = [{ id: 'ordinary', type: 'concept', text: 'ordinary' }]
  harness.store.saveGraph(hugeSource, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
  assert.equal((await post({ documentId: 'huge-source', nodeIds: ['ordinary'] })).error.code, 'limit_exceeded')
  const sourceLocal = structuredClone(hugeSource)
  delete sourceLocal.source.documentId
  assert.equal((await handlers.get('graph-query')({ graph: sourceLocal, nodeIds: ['ordinary'] })).error.code, 'limit_exceeded')
  const envelope = structuredClone(fixture.graph)
  envelope.source.documentId = 'envelope'
  envelope.nodes = [{ id: 'identity:'.repeat(19000), type: 'concept', text: 'Envelope record', paragraph: 0,
    quote: fixture.sourceUnits[0].text }]
  envelope.edges = []
  harness.store.saveGraph(envelope, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
  assert.equal((await post({ documentId: 'envelope', types: ['concept'] })).error.code, 'limit_exceeded',
    'Repeated full IDs in matches and source refs must count toward the public envelope')
  delete envelope.source.documentId
  assert.equal((await handlers.get('graph-query')({ graph: envelope, text: fixture.sourceText, types: ['concept'] })).error.code, 'limit_exceeded')
  const mediumIdentity = structuredClone(fixture.graph)
  mediumIdentity.source.documentId = 'medium-identity'
  mediumIdentity.nodes = [{ id: 'identity:'.repeat(2500), type: 'concept', text: 'Complete medium identity', paragraph: 0,
    quote: fixture.sourceUnits[0].text }]
  mediumIdentity.edges = []
  harness.store.saveGraph(mediumIdentity, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
  const accepted = await post({ documentId: 'medium-identity', types: ['concept'] })
  assert(!accepted.error && accepted.graph.nodes[0].id === mediumIdentity.nodes[0].id)
  assert(JSON.stringify(accepted).length <= accepted.metrics.contextBudget + 20000)
  const mediumAnswer = await answer({ documentId: 'medium-identity', nodeIds: [mediumIdentity.nodes[0].id] })
  assert(mediumAnswer.citations.some(citation => citation.targetId === mediumIdentity.nodes[0].id))
  assert.equal(mediumAnswer.followUps.length, 0, 'Omit a follow-up that cannot bind its full identity; do not pretend a relative target remains in the next request')
  assert(!((await post({ nodeIds: [modelId], hops: 0, maxNodes: 1 })).error), 'Rejection must release the snapshot and leave other reads usable')

  harness.store.db.exec('PRAGMA journal_mode = WAL')
  writer = await openSqliteStore(harness.database)
  const revised = structuredClone(fixture)
  revised.graph.nodes.find(node => node.id === modelId).modelStructure.slots[0].state = '下一次行程'
  const originalQuery = SqliteKnowledgeStore.prototype.queryDocumentGraph
  SqliteKnowledgeStore.prototype.queryDocumentGraph = function (...args) {
    if (this.filename !== harness.database || interleavings) return originalQuery.apply(this, args)
    const prepare = this.db.prepare
    this.db.prepare = function (sql) {
      const statement = prepare.call(this, sql)
      if (sql.startsWith('SELECT * FROM graph_nodes')) {
        const all = statement.all
        statement.all = function (...params) {
          const rows = all.apply(this, params)
          if (!interleavings) {
            assert(this !== writer.db)
            writer.saveGraph(revised.graph, { sourceText: revised.sourceText, sourceUnits: revised.sourceUnits, expectedRevision: 1 })
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
  try {
    const old = await post({ nodeIds: [modelId], hops: 0, maxNodes: 1 })
    assert.equal(old.revision, 1)
    assert.equal(old.modelContexts.items[0].structure.slots[0].state, originals.get(modelId).modelStructure.slots[0].state)
    assert.equal(old.graph.nodes[0].id, modelId)
  } finally { SqliteKnowledgeStore.prototype.queryDocumentGraph = originalQuery }
  assert.equal(interleavings, 1)
  assert.equal((await post({ nodeIds: [modelId] })).error.code, 'revision_conflict')
  const current = await post({ nodeIds: [modelId], expectedRevision: 2, hops: 0, maxNodes: 1 })
  assert.equal(current.modelContexts.items[0].structure.slots[0].state, '下一次行程')
  assert.equal(current.graph.nodes[0].id, modelId)
  assert.deepEqual(harness.store.getDocumentSourceUnits(fixture.documentId), baseline.sourceUnits)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
  console.log(JSON.stringify({ ok: true, opaqueModels: originals.size, sharedPrefixIdentities: 5, fullSourceIdentity: true,
    canonicalDocumentSelection: true, citationTargetIdentity: true, budgetsRetained: true, interleavings,
    syntheticOnlyModelCalls: requests.length, noLearningWrites: true }))
} finally {
  globalThis.harness = previousHarness
  writer?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  harness.stop()
}
