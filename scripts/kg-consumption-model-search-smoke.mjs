import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import { openSqliteStore } from '../src/kg-store.mjs'
import hostPlugin from '../src/index.host.js'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelSearchFixture } from './kg-consumption-model-search-fixture-data.mjs'
import { createModelStructureTools, createModelConsumptionTools } from '../src/kg-model-structure.mjs'

const fixture = modelSearchFixture()
const tools = createModelConsumptionTools(createModelStructureTools())
const field = text => ({ text, provenance: { kind: 'user', paragraph: null, quote: '', note: '' } })
const original = fixture.graph.nodes.find(node => node.id === 'search-condition')
for (let index = 0; index < 850; index++) {
  const model = structuredClone(original)
  model.id = 'search-scale-' + index; model.paragraph = index
  model.modelStructure.branches[0].condition = field('NEXUS partial candidate ' + index)
  fixture.graph.nodes.push(model)
}
const late = structuredClone(original)
late.id = 'search-scale-late'; late.paragraph = 5000
late.modelStructure.branches[0].condition = field('NEXUS PRECISIONTAIL')
fixture.graph.nodes.push(late)
const requests = []
const llm = { stream(request) {
  requests.push(request.messages?.[0]?.content?.[0]?.text || '')
  const output = request.system.includes('独立的逐句证据核验员') ? { decisions: [] }
    : { status: 'answered', parts: [{ text: '已记录条件证明模型必然成立且已经掌握。', evidenceIds: ['ev1'] }] }
  return (async function* () {
    yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
} }
const harness = await modelLearningHarness({ fixture, llm })
console.log(JSON.stringify({ ownedFixture: harness.directory }))
const server = createServer((req, res) => harness.handler(req, res))
const previousHarness = globalThis.harness
const originalQuery = SqliteKnowledgeStore.prototype.queryDocumentGraph
let writer, commits = 0
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
  const options = query => ({ query, types: ['connection_model'], hops: 0, maxNodes: 1, limit: 1, includeSourceFallback: false })
  const result = await post(options('ONLYAFTERMIDNIGHT'))
  console.log(JSON.stringify({ regressionObservation: true, error: result.error || null,
    nodes: result.graph?.nodes.map(node => node.id) }))
  assert(!result.error)
  assert.equal(result.matches[0]?.nodeId, original.id, 'A recorded model condition must be discoverable without copying it into the model title')
  const baseline = harness.store.getCanonicalDocument(harness.document.documentId)
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const sourceHash = hash(baseline.sourceUnits)
  const calls = new Map()
  globalThis.harness = { handle(name, handler) { calls.set(name, handler) } }
  hostPlugin().apply({ get: () => null, interval: () => () => {} })
  const local = structuredClone(fixture.graph)
  delete local.source.documentId
  local.revision = 1
  for (const [query, id, key, origin] of [['ONLYAFTERMIDNIGHT', 'search-condition', 'condition', 'user'],
    ['FAREBRANCHONLY', 'search-mapping', 'mapping', 'ai'], ['NOTOBSERVATION', 'search-boundary', 'boundary', 'source'],
    ['fullwidthcondition', 'search-normalized', 'condition', 'user'], ['UNICODEPHRASE NORMALIZEDWORD', 'search-normalized', 'mapping', 'user']]) {
    const found = await post(options(query))
    assert(!found.error, JSON.stringify(found))
    assert.equal(found.matches[0]?.nodeId, id)
    const match = found.matches[0].modelFieldMatches
    assert.equal(match.basis, 'recorded_text_not_applicability')
    assert(match.items.some(item => item.field === key && item.match === 'phrase' && item.provenanceKind === origin))
    assert.equal(found.modelContexts.items[0].entailmentStatus, 'unverified')
    assert.equal(found.graph.nodes.length, 1)
    assert.equal(found.graph.edges.length, 0)
    assert.deepEqual(found, harness.store.queryDocumentGraph(harness.document.documentId, { expectedRevision: 1, ...options(query) }))
    const dynamic = await calls.get('graph-query')({ ...options(query), expectedRevision: 1, graph: local, text: fixture.sourceText })
    assert(!dynamic.error, JSON.stringify(dynamic))
    assert.equal(dynamic.matches[0]?.nodeId, id)
    assert.deepEqual(dynamic.matches[0].modelFieldMatches, match)
    assert.deepEqual(dynamic.modelContexts.items[0].structure, found.modelContexts.items[0].structure)
  }
  const roleCases = await post({ ...options('ROLEBRANCHCASE'), limit: 20, maxNodes: 20 })
  assert.equal(roleCases.matches.length, 13)
  for (const match of roleCases.matches) {
    const item = (await post({ ...options('ROLEBRANCHCASE'), nodeIds: [match.nodeId] })).modelContexts.items[0]
    const canonical = baseline.graph.nodes.find(node => node.id === item.modelId)
    assert.deepEqual(item.structure, { version: canonical.modelStructure.version, identity: canonical.modelStructure.identity,
      slots: canonical.modelStructure.slots, branches: canonical.modelStructure.branches })
    assert.equal(item.entailmentStatus, canonical.entailmentStatus)
  }
  assert.equal(roleCases.modelContexts.omittedModels, 5, 'Keep the existing eight-core context limit')
  const conflicts = await post({ ...options('CONFLICTBRANCHCASE'), limit: 2, maxNodes: 2 })
  assert.deepEqual(new Set(conflicts.matches.map(item => item.nodeId)), new Set(['search-conflict-a', 'search-conflict-b']))
  assert.notEqual(conflicts.modelContexts.items[0].structure.branches[0].mapping.text,
    conflicts.modelContexts.items[1].structure.branches[0].mapping.text)
  for (const query of ['NOTEONLYSENTINEL', 'EXAMPLEONLYSENTINEL', 'NOSUCHBRANCHRECORD']) {
    const found = await post(options(query))
    assert(!found.error && found.matches.length === 0, 'Do not match provenance metadata, examples or fabricated text')
  }
  for (const [filters, expected] of [[{ types: ['concept'] }, false], [{ sectionIds: ['nonexistent'] }, false],
    [{ groundingStatuses: ['unsupported'] }, false], [{ entailmentStatuses: ['verified'] }, false], [{ nodeIds: ['taxi'] }, true]]) {
    const found = await post({ ...options('ONLYAFTERMIDNIGHT'), ...filters })
    assert(!found.error)
    if (!expected) assert.equal(found.matches.length, 0, 'Structured search must not bypass canonical filters')
    else assert.equal(found.matches[0].nodeId, 'taxi', 'Existing explicit identity ranking stays ahead of lexical suggestions')
  }
  assert.equal((await post({ ...options('ONLYAFTERMIDNIGHT'), types: ['forged-type'] })).error?.code, 'invalid_input')
  const changes = [value => { value.version = 99 }, value => { value.verified = true }, value => { value.slots[0].role = 'reverse' },
    value => { value.branches[0].condition.text = { fake: 'CORRUPTEDBRANCHRECORD' } }, () => false, () => [], () => 0]
  for (const change of changes) {
    const corrupt = structuredClone(original.modelStructure)
    corrupt.branches[0].condition.text = 'CORRUPTEDBRANCHRECORD'
    const changed = change(corrupt)
    harness.store.db.prepare('UPDATE graph_nodes SET attributes_json = ? WHERE document_id = ? AND node_id = ?')
      .run(JSON.stringify({ modelStructure: changed === undefined ? corrupt : changed }), fixture.documentId, original.id)
    assert.equal((await post(options('CORRUPTEDBRANCHRECORD'))).matches.length, 0)
  }
  harness.store.db.prepare('UPDATE graph_nodes SET attributes_json = ? WHERE document_id = ? AND node_id = ?')
    .run(JSON.stringify({ modelStructure: original.modelStructure }), fixture.documentId, original.id)
  const dense = structuredClone(original.modelStructure)
  dense.branches = Array.from({ length: 12 }, (_, index) => ({ id: 'branch-' + index, label: 'Branch ' + index,
    condition: field('DENSEBRANCHRECORD'), mapping: field('DENSEBRANCHRECORD'), boundary: field('DENSEBRANCHRECORD') }))
  dense.examples = []
  const denseMatch = tools.matchFields(dense, 'DENSEBRANCHRECORD')
  assert.equal(denseMatch.score, 44, 'Many matching branches cannot multiply ranking or imply confidence')
  assert.equal(denseMatch.fieldMatches.items.length, 8)
  assert.equal(denseMatch.fieldMatches.omitted, 28)
  dense.branches[0].condition.text = 'ONERAREWORD'; dense.branches[0].mapping.text = 'TWORAREWORD'
  const partial = tools.matchFields(dense, 'ONERAREWORD TWORAREWORD')
  assert.equal(partial.score, 16)
  assert(partial.fieldMatches.items.every(item => item.match === 'partial'), 'Separate fields do not fabricate a contiguous phrase')
  const started = performance.now()
  const scaled = await post(options('NEXUS PRECISIONTAIL'))
  const scaleMs = performance.now() - started
  assert.equal(scaled.matches[0]?.nodeId, late.id, 'An exact late structured match must not be hidden behind the first candidate page')
  assert.equal(scaled.metrics.candidateMatches, 851, 'Candidate counts must not include unrelated models merely inspected for structured text')
  assert(scaleMs < 5000, 'Bounded-page structured search exceeded the adversarial fixture runtime cap')
  const task = await post({ ...options('ONLYAFTERMIDNIGHT'), question: 'ONLYAFTERMIDNIGHT', model: { provider: 'fake', model: 'fake' } }, 'answer-graph')
  assert(task.taskId && !task.error, JSON.stringify(task))
  let finished = false
  for (let index = 0; index < 500; index++) {
    const status = await (await fetch(base + 'task-status?taskId=' + encodeURIComponent(task.taskId))).json()
    if (status.status !== 'running') {
      assert.equal(status.status, 'succeeded', JSON.stringify(status))
      assert(!status.result.answer.includes('必然成立') && !status.result.answer.includes('已经掌握'))
      finished = true; break
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert(finished)
  assert(requests[0].includes('ONLYAFTERMIDNIGHT applies only to this recorded trip.') && requests[0].includes('"modelId":"search-condition"'))
  assert.equal(hash(harness.store.getCanonicalDocument(fixture.documentId).graph), hash(baseline.graph))
  harness.store.db.exec('PRAGMA journal_mode=WAL')
  writer = await openSqliteStore(harness.database)
  writer.db.exec('PRAGMA journal_mode=WAL')
  const next = structuredClone(baseline.graph)
  next.nodes.find(node => node.id === original.id).modelStructure.branches[0].condition.text = 'NEXTMIDNIGHTCASE: next object and time, not the previous trip.'
  SqliteKnowledgeStore.prototype.queryDocumentGraph = function (...args) {
    const prepare = this.db.prepare.bind(this.db)
    this.db.prepare = sql => {
      const statement = prepare(sql)
      if (sql.startsWith('SELECT * FROM graph_nodes WHERE') && sql.includes('LOWER(node_id)') && !commits) {
        const all = statement.all.bind(statement)
        statement.all = (...params) => {
          const rows = all(...params)
          if (!commits) {
            writer.saveGraph(next, { expectedRevision: 1, sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
            commits++
          }
          return rows
        }
      }
      return statement
    }
    try { return originalQuery.apply(this, args) }
    finally { this.db.prepare = prepare }
  }
  const raced = await post(options('ONLYAFTERMIDNIGHT'))
  assert.equal(commits, 1)
  assert.equal(raced.revision, 1)
  assert.equal(raced.matches[0].nodeId, original.id)
  assert.equal(raced.modelContexts.items[0].structure.branches[0].condition.text, original.modelStructure.branches[0].condition.text)
  assert.equal((await post(options('ONLYAFTERMIDNIGHT'))).error?.code, 'revision_conflict')
  assert.equal((await post({ ...options('ONLYAFTERMIDNIGHT'), expectedRevision: 2 })).matches.length, 0)
  const current = await post({ ...options('NEXTMIDNIGHTCASE'), expectedRevision: 2 })
  assert.equal(current.matches[0].nodeId, original.id)
  assert.notEqual(current.queryId, raced.queryId)
  assert.equal(current.modelContexts.items[0].entailmentStatus, 'unverified')
  assert.equal(hash(harness.store.getCanonicalDocument(fixture.documentId).sourceUnits), sourceHash)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
  console.log(JSON.stringify({ ok: true, actualHostHttp: true, branchFieldKinds: 3, preservedRoleCases: 13,
    nonAuthorityMatches: true, corruptionsRejected: changes.length, boundedMatchDetails: true, lateCandidates: 851,
    scaleMs, interleavings: commits, syntheticOnlyCalls: requests.length, noLearningWrites: true }))
} finally {
  SqliteKnowledgeStore.prototype.queryDocumentGraph = originalQuery
  if (previousHarness === undefined) delete globalThis.harness
  else globalThis.harness = previousHarness
  writer?.close()
  await new Promise(resolve => server.close(resolve))
  harness.stop()
}
