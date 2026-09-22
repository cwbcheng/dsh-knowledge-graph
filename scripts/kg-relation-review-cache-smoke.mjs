import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as host from '../lib/index.js'

// Exercise the cache binding independently of discovery ranking. The HTTP
// fixture below verifies the same behavior through generated persistent routes.
const previousHarness = globalThis.harness
const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = '      async function reviewHighRiskRelationsHost('
assert.equal(source.split(marker).length, 2)
const instrumented = source.replace(marker, `      harness.reviewApi = { reviewHighRiskRelationsHost, attach(task) { activeTask = task } }
${marker}`)
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))
const harness = { handle() {} }
globalThis.harness = harness
let directCalls = 0, mode = 'valid', verdict = 'insufficient'
plugin().apply({ get(name) { return name === 'kgExtractor' ? { async reviewRelations({ candidates, units }) {
  directCalls++
  if (mode === 'cancel') throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
  const verdicts = candidates.map(item => ({ id: item.id, verdict, reason: 'Independent fixture verdict', evidence: [{ paragraph: units[0].num, quote: units[0].text }] }))
  if (mode === 'malformed') verdicts.pop()
  return { verdicts }
} } : null }, interval() {} })
const baseline = {
  nodes: [{ id: 'a', type: 'positive_example', text: 'A worked example', quote: 'A worked example', paragraph: 0, stage: 'data' },
    { id: 'b', type: 'intension_description', text: 'a condition', quote: 'a condition', paragraph: 0, relKind: 'basic' }],
  edges: [{ fromNodeId: 'a', toNodeId: 'b', relation: 'exemplifies', role: 'input', mode: 'contrast', evidence: [{ paragraph: 0, quote: 'A worked example describes a condition.' }] }],
  warnings: [],
}
const sourceUnits = ['A worked example describes a condition.', 'An unrelated paragraph is still part of the source.']
const newTask = () => ({ kind: 'relation-retry', ontology: 'learning-view-v1', progress: {}, relationReviewCache: {} })
async function checkReview(task, graph = baseline, paragraphs = sourceUnits) {
  harness.reviewApi.attach(task)
  const copy = structuredClone(graph)
  const keys = new Set(copy.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation))
  const result = await harness.reviewApi.reviewHighRiskRelationsHost(task, null, copy, paragraphs, new Set(), keys)
  return { graph: copy, result }
}
try {
  let paragraphReads = 0
  const watchedSource = new Proxy(sourceUnits, { get(target, property, receiver) {
    if (/^\d+$/.test(String(property))) paragraphReads++
    return Reflect.get(target, property, receiver)
  } })
  assert.equal((await checkReview(newTask(), { ...baseline, edges: [] }, watchedSource)).result.eligible, 0)
  assert.equal(paragraphReads, 0, 'an empty review must not serialize/hash the whole source to construct unused cache keys')
  for (const kind of ['supported', 'contradicted', 'insufficient']) {
    verdict = kind
    const task = newTask(), start = directCalls
    await checkReview(task)
    const second = await checkReview(task)
    assert.equal(directCalls - start, 1)
    assert.equal(second.result.reused, 1)
    assert.equal(second.graph.edges.length, kind === 'supported' ? 1 : 0)
  }
  verdict = 'insufficient'
  const task = newTask()
  await checkReview(task)
  for (const mutate of [
    graph => { graph.nodes[0].text += ' changed' },
    graph => { graph.nodes[0].stage = 'processed' },
    graph => { graph.nodes[1].relKind = 'extended' },
    graph => { graph.edges[0].role = 'output' },
    graph => { graph.edges[0].mode = 'analogy' },
    graph => { [graph.edges[0].fromNodeId, graph.edges[0].toNodeId] = ['b', 'a'] },
    graph => { graph.edges[0].evidence[0].quote = 'describes a condition' },
  ]) {
    const graph = structuredClone(baseline), start = directCalls
    mutate(graph)
    assert.equal((await checkReview(task, graph)).result.reused, 0)
    assert.equal(directCalls - start, 1, 'changed candidate semantics must receive a fresh independent review')
  }
  const beforeSource = directCalls
  assert.equal((await checkReview(task, baseline, [sourceUnits[0], 'Changed source.'])).result.reused, 0)
  assert.equal(directCalls - beforeSource, 1, 'even out-of-batch source changes invalidate the task binding')
  task.ontology = 'proposition-v1'
  assert.equal((await checkReview(task)).result.reused, 0, 'ontology changes invalidate the task binding')

  const failedTask = newTask()
  mode = 'malformed'
  const failed = await checkReview(failedTask)
  assert.equal(failed.result.pending, 1)
  assert.equal(Object.keys(failedTask.relationReviewCache).length, 0, 'partial responses cannot populate cache')
  mode = 'valid'
  assert.equal((await checkReview(failedTask)).result.reused, 0)
  const cancelledTask = newTask()
  mode = 'cancel'
  await assert.rejects(checkReview(cancelledTask), error => error.code === 'cancelled')
  assert.equal(Object.keys(cancelledTask.relationReviewCache).length, 0)
  mode = 'valid'
  const sourceHash = createHash('sha256').update(sourceUnits.join('\n\n')).digest('hex')
  // Frozen pre-optimization v2 key, including property order.
  const legacyKey = createHash('sha256').update(JSON.stringify({ policy: 'relation-review-v2', edge: baseline.edges[0], from: baseline.nodes[0], to: baseline.nodes[1], sourceHash })).digest('hex')
  const legacyTask = newTask()
  legacyTask.postprocess = { sourceHash, decisions: { [legacyKey]: { verdict: 'insufficient', evidence: [], reason: 'Prior durable review' } } }
  const beforeLegacy = directCalls
  assert.equal((await checkReview(legacyTask)).result.reused, 1)
  assert.equal(directCalls, beforeLegacy, 'old extraction review checkpoints keep their exact codec')

  const writeFailure = newTask()
  const previousPostprocess = { sourceHash, decisions: {} }
  writeFailure.postprocess = previousPostprocess
  writeFailure.persistPostprocess = async () => { throw Object.assign(new Error('synthetic write failure'), { code: 'persistence_failed' }) }
  await assert.rejects(checkReview(writeFailure), error => error.code === 'persistence_failed')
  assert.equal(writeFailure.postprocess, previousPostprocess)
  assert.deepEqual(previousPostprocess.decisions, {}, 'failed durable writes cannot advance reusable decisions')
} finally {
  if (previousHarness === undefined) delete globalThis.harness
  else globalThis.harness = previousHarness
}

const previousDb = process.env.DSH_KG_DB
const dir = mkdtempSync(join(tmpdir(), 'kg-review-cache-'))
process.env.DSH_KG_DB = join(dir, 'fixture.sqlite')
const cleanups = []
const store = await openSqliteStore(process.env.DSH_KG_DB)
let handler, weaves = 0, reviews = 0
const quote = 'An observation records a measurement.'
store.saveGraph({ source: { id: 'cache-source', documentId: 'cache-document' }, warnings: [],
  nodes: Array.from({ length: 137 }, (_, i) => ({ id: 'n' + i, type: 'fact', text: quote, quote, paragraph: 0, evidence: [{ paragraph: 0, quote }] })), edges: [] }, { sourceText: quote })
host.apply({ get(name) {
  if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
  if (name !== 'kgExtractor') return null
  return {
    async weaveRelations({ nodes }) {
      weaves++
      const ids = new Set(nodes.map(node => node.id))
      assert.ok(ids.has('n0') && ids.has('n1'), 'fixture must actually repeat the same candidate across saved cycles')
      return { edges: [{ fromNodeId: 'n0', toNodeId: 'n1', relation: 'supports', evidence: [{ paragraph: 0, quote }] }] }
    },
    async reviewRelations({ candidates }) {
      reviews++
      return { verdicts: candidates.map(item => ({ id: item.id, verdict: 'insufficient', reason: 'Co-occurrence is not support.', evidence: [] })) }
    },
  }
}, effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); return cleanup }, interval() { return () => {} } })

function request(endpoint, body = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = Object.assign(new EventEmitter(), { method, headers: {}, url: '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '') })
    Promise.resolve(handler(req, { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } })).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
async function run(revision) {
  const started = await request('relation-retry', { documentId: 'cache-document', expectedRevision: revision, continuous: true })
  assert.ok(started.taskId, JSON.stringify(started))
  for (let i = 0; i < 2000; i++) {
    const status = await request('task-status', { taskId: started.taskId }, 'GET')
    if (status.status !== 'running') { assert.equal(status.status, 'succeeded', JSON.stringify(status)); return status }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('continuous relation test did not finish')
}
try {
  const first = await run(1)
  assert.equal(first.result.generation.relationDiscovery.remainingTargets, 0)
  assert.equal(first.result.generation.relationCompletion.savedCycles, 3)
  assert.equal(first.result.edges.length, 0, 'cached rejection must not become an admitted relation')
  assert.equal(weaves, 12, 'all target groups must still receive independent discovery opportunities')
  assert.equal(reviews, 1, 'identical rejected candidates must not trigger repeated paid review within the same continuous task')
  assert.equal(first.result.generation.relationRetrySemanticReview.reused, 1)
  assert.ok(!JSON.stringify(first).includes('relationReviewCache'), 'private review cache must not be exposed as graph authority')
  const second = await run(first.result.revision)
  assert.equal(reviews, 2, 'a new explicit run must not inherit an old task review cache')
  assert.equal(second.result.edges.length, 0)
  const persisted = store.getDocument('cache-document')
  assert.equal(persisted.edges.length, 0)
  assert.equal(persisted.generation.relationDiscovery.remainingTargets, 0)
  console.log(JSON.stringify({ ok: true, savedCycles: 6, weaves, reviews, directCalls, semanticInvalidation: true, invalidResponsesNotCached: true, rejectedCandidateReused: true, taskIsolation: true }))
} finally {
  for (const cleanup of cleanups.reverse()) cleanup()
  store.close()
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(dir, { recursive: true, force: true })
}
