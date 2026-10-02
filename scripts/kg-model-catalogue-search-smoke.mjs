import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import { openSqliteStore } from '../src/kg-store.mjs'
import { createModelStructureTools, createModelConsumptionTools } from '../src/kg-model-structure.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelCatalogueSearchFixture } from './kg-model-catalogue-search-fixture-data.mjs'

const fixture = modelCatalogueSearchFixture({ scale: true })
const harness = await modelLearningHarness({ fixture })
console.log(JSON.stringify({ ownedFixture: harness.directory }))
const server = createServer((req, res) => harness.handler(req, res))
const query = createGraphContract().connectionModels
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const getDocument = SqliteKnowledgeStore.prototype.getDocument
let writer, armed = false, interleavings = 0, readerTransaction = false
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const post = async args => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        documentId: fixture.documentId, expectedRevision: 1, ...args }) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const baseline = harness.store.getCanonicalDocument(fixture.documentId)
  const read = async args => {
    const result = await post(args)
    assert(!result.error, JSON.stringify(result.error))
    assert.deepEqual(result, query(baseline, { expectedRevision: 1, ...args }), 'Generated HTTP and source catalogue must share the contract')
    return result
  }
  const cases = [['ONLYAFTERMIDNIGHT', 'search-condition', 'condition', 'user'],
    ['FAREBRANCHONLY', 'search-mapping', 'mapping', 'ai'], ['NOTOBSERVATION', 'search-boundary', 'boundary', 'source'],
    ['UNRESOLVEDCATALOGUE', 'catalogue-unknown-origin', 'condition', 'unknown'],
    ['fullwidthcondition', 'search-normalized', 'condition', 'user'],
    ['UNICODEPHRASE NORMALIZEDWORD', 'search-normalized', 'mapping', 'user']]
  for (const [text, id, field, origin] of cases) {
    const result = await read({ query: text })
    assert.equal(result.total, 1)
    assert.equal(result.items[0].nodeId, id)
    const matches = result.items[0].modelFieldMatches
    assert.equal(matches.basis, 'recorded_text_not_applicability')
    assert(matches.items.some(item => item.field === field && item.match === 'phrase' && item.provenanceKind === origin))
    assert(!Object.hasOwn(result.items[0], 'score'), 'Catalogue remains in source order, not confidence order')
    const detail = await read({ modelId: id })
    const original = baseline.graph.nodes.find(node => node.id === id)
    assert.deepEqual(detail.structure.slots.map(({ conceptText, ...slot }) => slot), original.modelStructure.slots)
    assert.deepEqual(detail.structure.branches.map(({ pairedExamples, incompleteExamples, ...branch }) => branch), original.modelStructure.branches)
    assert.equal(detail.model.entailmentStatus, original.entailmentStatus || 'unverified')
  }
  const roleCases = await read({ query: 'ROLEBRANCHCASE' })
  assert.equal(roleCases.total, 13)
  for (const item of roleCases.items) {
    const detail = await read({ modelId: item.nodeId })
    const original = baseline.graph.nodes.find(node => node.id === item.nodeId)
    assert.deepEqual(detail.structure.slots.map(({ conceptText, ...slot }) => slot), original.modelStructure.slots)
    assert.equal(detail.model.contentIdentity, original.modelStructure.identity)
    assert.equal(detail.model.entailmentStatus, original.entailmentStatus || 'unverified')
  }
  assert.equal(roleCases.items.find(item => item.nodeId === 'search-unknown-role').structureComplete, false)
  assert.equal(roleCases.items.find(item => item.nodeId === 'search-wrong-model').contentIdentity, 'wrong_example')
  assert.equal(roleCases.items.find(item => item.nodeId === 'search-type-model').contentIdentity, 'type_definition')
  const multi = await read({ modelId: 'search-multi' })
  assert.equal(multi.ports.filter(port => port.role === 'input').length, 2)
  assert.equal(multi.ports[0].node.nodeId, multi.ports[2].node.nodeId)
  assert.notEqual(multi.ports[0].slotId, multi.ports[2].slotId)
  assert.notEqual(multi.ports[0].timeState, multi.ports[2].timeState)
  const conflicts = await read({ query: 'CONFLICTBRANCHCASE' })
  assert.deepEqual(conflicts.items.map(item => item.nodeId), ['search-conflict-a', 'search-conflict-b'])
  assert.notEqual((await read({ modelId: 'search-conflict-a' })).structure.branches[0].mapping.text,
    (await read({ modelId: 'search-conflict-b' })).structure.branches[0].mapping.text)
  for (const text of ['NOTEONLYSENTINEL', 'EXAMPLEONLYSENTINEL', 'FIRSTRARECATALOGUE SECONDRARECATALOGUE',
    'BETWEENFIRSTCATALOGUE BETWEENSECONDCATALOGUE', 'unicodephrase---normalizedword', 'NONEXISTENTCATALOGUE']) {
    assert.equal((await read({ query: text })).total, 0, 'Only a phrase in one recorded field may extend catalogue search')
  }
  const tools = createModelConsumptionTools(createModelStructureTools())
  const split = fixture.graph.nodes.find(node => node.id === 'catalogue-split').modelStructure
  assert.equal(tools.matchFields(split, 'FIRSTRARECATALOGUE SECONDRARECATALOGUE').score, 16,
    'General consumption keeps its separately labelled partial-match behavior')
  assert.equal(tools.matchFields(split, 'FIRSTRARECATALOGUE SECONDRARECATALOGUE', { partial: false }), null)
  for (const [text, id] of [['OPERATORCATALOGUE x > 3', 'catalogue-split'],
    ['OPERATORCATALOGUE x < 3', 'catalogue-between-branches'], ['ARROWCATALOGUE input -> output', 'catalogue-split'],
    ['ARROWCATALOGUE output -> input', 'catalogue-between-branches']]) {
    const result = await read({ query: text })
    assert.equal(result.total, 1, 'A phrase must preserve inequality operators and recorded arrow direction')
    assert.equal(result.items[0].nodeId, id)
  }
  assert.equal(tools.matchFields(split, 'OPERATORCATALOGUE x < 3', { partial: false }), null)
  const dense = (await read({ query: 'DENSECATALOGUERECORD' })).items[0].modelFieldMatches
  assert.equal(dense.items.length, 8)
  assert.equal(dense.omitted, 28)
  assert(dense.items.every(item => item.match === 'phrase'))
  const tail = (await read({ query: 'BRANCHTAILCATALOGUE' })).items[0]
  assert.equal(tail.nodeId, 'catalogue-tail-branch')
  assert.equal(tail.modelFieldMatches.items[0].branchId, 'tail-39', 'Search covers every recorded branch, not only the first display page')
  for (const [args, expected] of [[{ sectionId: 'second' }, 0], [{ excludeModelId: 'search-condition' }, 0],
    [{ conceptId: 'fare', role: 'input' }, 0], [{ conceptId: 'fare', role: 'output' }, 1],
    [{ peerOf: 'taxi' }, 1], [{ chainOf: 'taxi' }, 0], [{ needsReview: true }, 1]]) {
    assert.equal((await read({ query: 'ONLYAFTERMIDNIGHT', ...args })).total, expected, 'A branch match cannot bypass existing selectors')
  }
  const chainCandidates = await read({ query: 'ROLEBRANCHCASE', chainOf: 'taxi' })
  assert(!chainCandidates.items.some(item => item.nodeId === 'search-same-name'), 'Matching text does not merge distinct concept identities')
  assert(chainCandidates.items.some(item => item.nodeId === 'search-units') && chainCandidates.items.some(item => item.nodeId === 'search-times'),
    'Candidate discovery is not a units/time compatibility verdict')
  const started = performance.now()
  const scaled = await read({ query: 'CATALOGUEPAGETOKEN' })
  const scaleMs = performance.now() - started
  assert.equal(scaled.total, 846)
  assert.equal(scaled.totalModels, baseline.graph.nodes.filter(node => node.type === 'connection_model').length)
  assert.equal(scaled.items.length, 20)
  const last = await read({ query: 'CATALOGUEPAGETOKEN', offset: 840 })
  assert.equal(last.items.length, 6)
  assert.equal(last.items.at(-1).nodeId, 'catalogue-scale-zzzz')
  assert.equal((await read({ query: 'PRECISIONTAILCATALOGUE' })).items[0].nodeId, 'catalogue-scale-zzzz')
  assert.equal(scaled.topics.reduce((count, topic) => count + topic.count, 0), scaled.totalModels)
  assert(scaled.items.every((item, index, all) => !index || all[index - 1].nodeId.localeCompare(item.nodeId) <= 0))
  assert(scaleMs < 5000, 'Full-graph search must remain bounded in the adversarial fixture')
  assert.equal((await post({ query: 'ONLYAFTERMIDNIGHT', graph: { nodes: [] }, ontology: 'forged' })).total, 1)
  assert.equal((await post({ expectedRevision: 0, query: 'ONLYAFTERMIDNIGHT' })).error.code, 'revision_conflict')

  // Broken records stay accessible by identity, but their contents are not searchable as a valid model structure.
  const row = harness.store.db.prepare('SELECT attributes_json FROM graph_nodes WHERE document_id = ? AND node_id = ?')
    .get(fixture.documentId, 'search-condition')
  const corruptions = [value => { value.version = 99 }, value => { value.verified = true },
    value => { value.slots[0].role = 'reverse' }, value => { value.slots[0].conceptId = 'absent-concept' },
    value => { value.branches[0].condition.provenance = { kind: 'source', paragraph: 0, quote: 'MISMATCHEDCATALOGUESOURCE', note: '' } },
    value => { value.branches[0].condition.text = { value: 'CORRUPTEDCATALOGUE' } }]
  for (const change of corruptions) {
    const attrs = JSON.parse(row.attributes_json)
    attrs.modelStructure.branches[0].condition.text = 'CORRUPTEDCATALOGUE'
    change(attrs.modelStructure)
    harness.store.db.prepare('UPDATE graph_nodes SET attributes_json = ? WHERE document_id = ? AND node_id = ?')
      .run(JSON.stringify(attrs), fixture.documentId, 'search-condition')
    assert.equal((await post({ query: 'CORRUPTEDCATALOGUE' })).total, 0)
    const accessible = await post({ query: 'search-condition' })
    assert.equal(accessible.items[0].hasStructure, false)
    assert(accessible.items[0].warnings.some(warning => warning.startsWith('结构记录需重新核对')))
  }
  harness.store.db.prepare('UPDATE graph_nodes SET attributes_json = ? WHERE document_id = ? AND node_id = ?')
    .run(row.attributes_json, fixture.documentId, 'search-condition')
  assert.equal(hash(harness.store.getCanonicalDocument(fixture.documentId)), hash(baseline), 'All search paths must be read-only')

  harness.store.db.exec('PRAGMA journal_mode=WAL')
  writer = await openSqliteStore(harness.database)
  writer.db.exec('PRAGMA journal_mode=WAL')
  const next = structuredClone(baseline)
  const branch = next.graph.nodes.find(node => node.id === 'search-condition').modelStructure.branches[0]
  branch.condition.text = 'NEXTMIDNIGHTCATALOGUE: only a different trip and time.'
  branch.condition.provenance = { kind: 'source', paragraph: next.sourceUnits.length, quote: branch.condition.text, note: '' }
  next.sourceUnits.push({ paragraph: branch.condition.provenance.paragraph, text: branch.condition.text })
  next.sourceText = next.sourceUnits.map(unit => unit.text).join('\n\n')
  SqliteKnowledgeStore.prototype.getDocument = function (id) {
    const graph = getDocument.call(this, id)
    if (armed && id === fixture.documentId && this.filename === harness.database) {
      armed = false; readerTransaction = this.db.isTransaction
      writer.saveGraph(next.graph, { expectedRevision: 1, sourceText: next.sourceText, sourceUnits: next.sourceUnits })
      interleavings++
    }
    return graph
  }
  const before = await post({ query: 'ONLYAFTERMIDNIGHT' })
  armed = true
  assert.deepEqual(await post({ query: 'ONLYAFTERMIDNIGHT' }), before, 'Match location, source provenance and catalogue revision must share one snapshot')
  assert.equal(interleavings, 1)
  assert.equal(readerTransaction, true)
  assert.equal((await post({ query: 'ONLYAFTERMIDNIGHT' })).error.code, 'revision_conflict')
  assert.equal((await post({ expectedRevision: 2, query: 'ONLYAFTERMIDNIGHT' })).total, 0)
  const current = await post({ expectedRevision: 2, query: 'NEXTMIDNIGHTCATALOGUE' })
  assert.equal(current.total, 1)
  assert.equal(current.items[0].modelFieldMatches.items[0].provenanceKind, 'source')
  const currentDetail = await post({ expectedRevision: 2, modelId: 'search-condition' })
  assert.equal(currentDetail.structure.branches[0].condition.text, branch.condition.text)
  assert(currentDetail.sourceUnits.some(unit => unit.text === branch.condition.text))
  assert.equal(currentDetail.model.entailmentStatus, 'unverified')
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
  console.log(JSON.stringify({ ok: true, actualHostHttp: true, sourceContractParity: true, fieldKinds: 3, declaredOrigins: 4,
    phraseOnly: true, operatorsAndArrowsPreserved: true, preservedRoleCases: 13, corruptionsRejected: corruptions.length, boundedMatchDetails: 8,
    allBranches: 40, fullGraphCandidates: 846, scaleMs, sourceOrderAndFiltersPreserved: true,
    independentWriterCommits: interleavings, oldRevisionRejected: true, noLearningWrites: true }))
} finally {
  SqliteKnowledgeStore.prototype.getDocument = getDocument
  writer?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  harness.stop()
}
