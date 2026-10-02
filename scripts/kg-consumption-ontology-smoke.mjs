import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { openSqliteStore } from '../src/kg-store.mjs'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import { getOntology } from '../src/kg-ontology.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

const profile = getOntology('learning-view-v1')
const fixture = modelStructureFixture()
const sample = fixture.graph.nodes[0]
for (const type of profile.consumptionTypes) fixture.graph.nodes.push({ ...structuredClone(sample),
  id: 'type-' + type, type, text: '隔离材料 ' + type })
fixture.graph.nodes.push({ ...structuredClone(sample), id: 'same-name', text: sample.text })
fixture.graph.edges.push({ fromNodeId: 'unknown', toNodeId: 'same-name', relation: 'maps_between' })
for (const relation of profile.relationTypes) {
  const from = relation.from?.[0] || 'concept', to = relation.to?.[0] || 'concept'
  const fromNodeId = 'type-' + from
  let toNodeId = 'type-' + to
  if (fromNodeId === toNodeId) {
    toNodeId += '-target'
    fixture.graph.nodes.push({ ...structuredClone(sample), id: toNodeId, type: to, text: '隔离关系端点 ' + relation.id })
  }
  fixture.graph.edges.push({ fromNodeId, toNodeId, relation: relation.id })
}
const proposition = { ontology: 'proposition-v1', source: { ...fixture.graph.source },
  nodes: getOntology('proposition-v1').consumptionTypes.map(type => ({ ...structuredClone(sample),
    id: 'prop-' + type, type, text: '传统材料 ' + type })),
  edges: getOntology('proposition-v1').relationTypes.map(relation => ({
    fromNodeId: 'prop-concept', toNodeId: 'prop-rule', relation: relation.id })) }
const harness = await modelLearningHarness({ fixture })
const { store, database, document, handler } = harness
const server = createServer((req, res) => handler(req, res))
let writer, armed = false, interleavings = 0, readCalls = 0
const originalQuery = SqliteKnowledgeStore.prototype.queryDocumentGraph
SqliteKnowledgeStore.prototype.queryDocumentGraph = function (...args) {
  if (this.filename !== database) return originalQuery.apply(this, args)
  readCalls++
  if (!armed) return originalQuery.apply(this, args)
  armed = false
  const prepare = this.db.prepare
  let fired = false
  this.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (sql === 'SELECT * FROM documents WHERE document_id = ?') {
      const get = statement.get
      statement.get = function (...params) {
        const row = get.apply(this, params)
        if (!fired) {
          fired = true
          writer.saveGraph(proposition, { sourceText: document.sourceText, sourceUnits: document.sourceUnits,
            expectedRevision: row.graph_revision })
          interleavings++
        }
        return row
      }
    }
    return statement
  }
  try { const result = originalQuery.apply(this, args); assert(fired); return result }
  finally { this.db.prepare = prepare }
}

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/'
  const post = async (args, method = 'graph-query') => {
    const response = await fetch(base + method, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: document.documentId, expectedRevision: store.getDocumentRevision(document.documentId), ...args }) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const query = args => store.queryDocumentGraph(document.documentId, args)
  const baseline = store.getCanonicalDocument(document.documentId)
  const first = await post({ types: ['connection_model'], hops: 0, limit: 40 })
  const sqlFirst = query({ types: ['connection_model'], hops: 0, limit: 40 })
  console.log(JSON.stringify({ regressionObservation: true, httpError: first.error?.code || null,
    sqlTypes: [...new Set(sqlFirst.graph.nodes.map(node => node.type))] }))
  assert(!first.error, 'The existing learning-view type control must query the canonical ontology, not proposition defaults')
  assert(first.matches.length > 0 && first.graph.nodes.every(node => node.type === 'connection_model'))
  assert(sqlFirst.matches.length > 0 && sqlFirst.graph.nodes.every(node => node.type === 'connection_model'),
    'SQLite must not drop an unsupported selector and silently broaden a model search')

  let selections = 0, rejections = 0
  for (const type of [...profile.consumptionTypes, 'image']) {
    const options = { types: [' ' + type + ' ', type], hops: 0, limit: 40 }
    const result = await post(options)
    assert(!result.error, type + ': ' + JSON.stringify(result.error))
    assert.deepEqual(result, query({ ...options, expectedRevision: 1, includeSourceFallback: false }))
    assert(result.graph.nodes.every(node => node.type === type))
    if (type !== 'image') assert(result.matches.length > 0)
    else assert.equal(result.matches.length, 0, 'An allowed empty filter must remain empty, not fall back to all types')
    assert.equal(result.metrics.directMatches, result.graph.nodes.length)
    selections++
  }
  for (const relation of [...profile.relationTypes.map(item => item.id), 'visual_source', 'visual_reference']) {
    const result = await post({ relations: [relation], hops: 1, limit: 40, maxNodes: 100, maxEdges: 300 })
    assert(!result.error, relation + ': ' + JSON.stringify(result.error))
    assert(result.graph.edges.every(edge => edge.relation === relation))
    if (!['visual_source', 'visual_reference'].includes(relation)) assert(result.graph.edges.length > 0, relation + ' was silently discarded')
    else assert.equal(result.matches.length, 0)
    selections++
  }
  const maps = await post({ nodeIds: ['taxi'], relations: ['maps_between'], direction: 'out', hops: 1 })
  assert.deepEqual(new Set(maps.graph.edges.map(edge => edge.role)), new Set(['input', 'output']),
    'Stored edge orientation is not model input/output direction')
  const storedModels = store.getDocument(document.documentId)
  assert.equal(storedModels.nodes.find(node => node.id === 'taxi').modelStructure.slots[0].unit, 'km')
  assert.equal(storedModels.nodes.find(node => node.id === 'taxi').modelStructure.branches[1].boundary.text, '仅为简化计价模型')
  assert(maps.graph.nodes.every(node => node.entailmentStatus === 'unverified'))
  const unknown = await post({ nodeIds: ['unknown'], relations: ['maps_between'], direction: 'out', hops: 1 })
  assert(unknown.graph.edges.length >= 3 && unknown.graph.edges.every(edge => !edge.role), 'Unknown roles cannot be invented')
  assert.equal(unknown.graph.nodes.find(node => node.id === 'distance').text, unknown.graph.nodes.find(node => node.id === 'same-name').text)
  const multiple = await post({ nodeIds: ['multi'], hops: 0 })
  assert.equal(multiple.matches[0].nodeId, 'multi')
  assert.deepEqual(storedModels.nodes.find(node => node.id === 'multi').modelStructure.slots.map(slot => [slot.conceptId, slot.role, slot.unit, slot.state]),
    [['speed', 'input', 'm/s', '初始时刻'], ['force', 'input', 'N', '运动期间'], ['speed', 'output', 'm/s', '后续时刻']])
  assert.notEqual(maps.queryId, (await post({ nodeIds: ['taxi'], relations: ['has_rule'], hops: 1 })).queryId)
  assert.notEqual(first.queryId, (await post({ types: ['factor_material'], hops: 0, limit: 40 })).queryId)

  const invalid = [
    [{ types: ['fact'] }, 'invalid_input'], [{ relations: ['supports'] }, 'invalid_input'],
    [{ types: ['connection_model', 'not-a-type'] }, 'invalid_input'],
    [{ relations: ['maps_between', 'not-a-relation'] }, 'invalid_input'],
    [{ types: 'connection_model' }, 'invalid_input'], [{ relations: {} }, 'invalid_input'],
    [{ types: [null] }, 'invalid_input'], [{ relations: [1] }, 'invalid_input'],
    [{ types: [' '] }, 'invalid_input'], [{ nodeIds: [''] }, 'invalid_input'],
    [{ sectionIds: [1] }, 'invalid_input'], [{ nodeIds: 'taxi' }, 'invalid_input'],
    [{ groundingStatuses: ['verified'] }, 'invalid_input'], [{ entailmentStatuses: ['grounded'] }, 'invalid_input'],
    [{ direction: 'input' }, 'invalid_input'],
    ...['types', 'relations', 'nodeIds', 'sectionIds', 'groundingStatuses', 'entailmentStatuses'].map(field =>
      [{ [field]: Array(41).fill('concept') }, 'limit_exceeded']),
  ]
  for (const [options, code] of invalid) {
    assert.throws(() => query({ query: '行驶距离', ...options }), error => error.code === code)
    for (const method of ['graph-query', 'answer-graph']) {
      const result = await post({ query: '行驶距离', question: '行驶距离', ...options,
        ontology: 'proposition-v1', graph: proposition }, method)
      assert.equal(result.error?.code, code, method + ' must reject the whole invalid filter before any task starts')
      assert(!result.taskId && !result.started)
    }
    assert.equal(store.db.isTransaction, false)
    rejections++
  }
  const forged = await post({ types: ['connection_model'], ontology: 'proposition-v1', graph: proposition, hops: 0 })
  assert.deepEqual(forged, await post({ types: ['connection_model'], hops: 0 }))
  assert.equal((await post({ types: ['connection_model'], expectedRevision: 0 })).error?.code, 'revision_conflict')
  assert.equal((await post({ query: '', types: [], relations: [] })).error?.code, 'invalid_input')
  assert.deepEqual(store.getCanonicalDocument(document.documentId), baseline)

  const save = graph => store.saveGraph(graph, { sourceText: document.sourceText, sourceUnits: document.sourceUnits,
    expectedRevision: store.getDocumentRevision(document.documentId) })
  for (const alias of ['learning-view', 'xuexiguan']) {
    save({ ...document.graph, ontology: alias })
    assert(!(await post({ types: ['connection_model'] })).error)
  }
  const sourceOnly = structuredClone(document.graph)
  delete sourceOnly.ontology
  sourceOnly.source.ontology = 'learning-view-v1'
  save(sourceOnly)
  assert(!(await post({ types: ['connection_model'] })).error, 'A source-only canonical ontology must survive re-open')
  const reopened = await openSqliteStore(database)
  try { assert(reopened.queryDocumentGraph(document.documentId, { types: ['connection_model'], hops: 0 }).graph.nodes.every(node => node.type === 'connection_model')) }
  finally { reopened.close() }
  store.db.exec('PRAGMA journal_mode = WAL')
  writer = await openSqliteStore(database)
  const revision = store.getDocumentRevision(document.documentId)
  const before = await post({ types: ['connection_model'], hops: 0 })
  armed = true
  const raced = await post({ types: ['connection_model'], hops: 0 })
  assert.deepEqual(raced, before, 'Ontology validation and graph selection must use the same document snapshot')
  assert.equal(interleavings, 1)
  assert.equal((await post({ types: ['connection_model'], expectedRevision: revision })).error?.code, 'revision_conflict')
  assert.equal((await post({ types: ['connection_model'], ontology: 'learning-view-v1', graph: document.graph })).error?.code, 'invalid_input')
  assert(!(await post({ types: ['fact'] })).error)
  writer.close(); writer = null
  const legacy = structuredClone(proposition)
  delete legacy.ontology
  save(legacy)
  for (const type of [...getOntology('proposition-v1').consumptionTypes, 'image']) {
    const result = await post({ types: [type], hops: 0 })
    assert(!result.error && result.graph.nodes.every(node => node.type === type))
    selections++
  }
  for (const relation of [...getOntology('proposition-v1').relationTypes.map(item => item.id), 'visual_source', 'visual_reference']) {
    const result = await post({ relations: [relation], hops: 1 })
    assert(!result.error && result.graph.edges.every(edge => edge.relation === relation))
    if (!['visual_source', 'visual_reference'].includes(relation)) assert(result.graph.edges.length > 0)
    selections++
  }
  assert.equal((await post({ types: ['connection_model'] })).error?.code, 'invalid_input')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
  assert.equal(store.db.isTransaction, false)
  const activeResponse = await fetch(base + 'task-active')
  const active = await activeResponse.json()
  assert.equal(active.busy, false, 'Rejected answer filters must never start a model task')
  assert(readCalls > 0, 'The generated persistent Host must actually use SQLite')
  console.log(JSON.stringify({ ok: true, actualHostHttp: true, selections, rejections,
    canonicalOntologyOnly: true, legacyAndAliases: true, sourceOnlyReopened: true, interleavings,
    unknownRoleAndIdentityPreserved: true, canonicalUnitsAndTemporalSlotsPreserved: true,
    invalidAnswerCannotStartTask: true, noRealModelCalls: true, noLearningWrites: true }))
} finally {
  SqliteKnowledgeStore.prototype.queryDocumentGraph = originalQuery
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  writer?.close()
  harness.stop()
}
