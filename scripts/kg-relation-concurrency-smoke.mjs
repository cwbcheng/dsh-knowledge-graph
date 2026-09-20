import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = '      async function runRelationQueueHost('
assert.equal(source.split(marker).length, 2)
const instrumented = source.replace(marker, `      harness.concurrentTest = { runRelationQueueHost, reviewHighRiskRelationsHost, weaveRelationsHost, attach(task) { activeTask = task } }
${marker}`)
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))
const harness = { handle() {} }
globalThis.harness = harness
let reviewer, weaver
plugin().apply({ get(name) { return name === 'kgExtractor' ? { reviewRelations: args => reviewer(args), weaveRelations: args => weaver(args) } : null }, interval() {} })
const { runRelationQueueHost, reviewHighRiskRelationsHost, weaveRelationsHost, attach } = harness.concurrentTest
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const key = edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation
const paragraphs = ['A bounded fixture observation supports a related proposition.']
function fixture(count = 256) {
  const nodes = Array.from({ length: count + 1 }, (_, i) => ({ id: 'n' + i, type: 'claim', text: paragraphs[0], paragraph: 0, quote: paragraphs[0] }))
  return { nodes, edges: nodes.slice(1).map(node => ({ fromNodeId: node.id, toNodeId: 'n0', relation: 'supports', evidence: [{ paragraph: 0, quote: paragraphs[0] }] })), warnings: [] }
}
const supported = candidates => ({ verdicts: candidates.map(item => ({ id: item.id, verdict: 'supported', reason: 'Synthetic traversal fixture', evidence: item.edge.evidence })) })
function taskFor(concurrency, decisions = {}) {
  return { concurrency, progress: {}, postprocess: { sourceHash: 'fixture', decisions: structuredClone(decisions) }, cancelHooks: [] }
}
function review(task, graph) {
  attach(task)
  return reviewHighRiskRelationsHost(task, null, graph, paragraphs, new Set(), new Set(graph.edges.map(key)))
}

// Same candidates and complete evidence; only the scheduler differs. Timings
// use controlled provider latency, not a claim about any paid model's speed.
const timings = []
for (const concurrency of [1, 2, 4]) {
  const graph = fixture(), task = taskFor(concurrency)
  let active = 0, peak = 0, writes = 0, durable, calls = 0
  reviewer = async ({ candidates }) => {
    calls++; peak = Math.max(peak, ++active)
    assert(candidates.length <= 16)
    await sleep(50)
    active--
    return supported(candidates)
  }
  task.persistPostprocess = async () => {
    assert.equal(++writes, 1, 'checkpoint writes must never overlap')
    await sleep(2)
    const snapshot = structuredClone(task.postprocess)
    if (durable) assert(Object.keys(snapshot.decisions).length > Object.keys(durable.decisions).length, 'no completed lane may be lost')
    durable = snapshot
    writes--
  }
  const start = performance.now()
  const result = await review(task, graph)
  timings.push({ concurrency, milliseconds: Math.round(performance.now() - start), calls, peak })
  assert.equal(peak, concurrency)
  assert.equal(calls, 16)
  assert.equal(result.reviewed, 256)
  assert.equal(result.pending, 0)
  assert.equal(Object.keys(durable.decisions).length, 256)
  assert.deepEqual(graph.edges, fixture().edges, 'concurrency must not change accepted graph order or evidence')
  assert.equal(task.progress.relationParallel, null)
}

const weaveTimings = []
let expectedEdges
for (const concurrency of [1, 2, 4]) {
  const units = Array.from({ length: 120 }, (_, i) => 'Record ' + i + ' describes an independent observation.')
  const nodes = units.map((text, paragraph) => ({ id: 'n' + paragraph, type: 'claim', text, quote: text, paragraph }))
  const acc = { nodes: new Map(nodes.map(node => [node.id, node])), edges: [], edgeKeys: new Set(), warnings: [] }
  const task = { concurrency, kind: 'extract', progress: {} }
  let active = 0, peak = 0, calls = 0, writes = 0, durable
  weaver = async ({ nodes }) => {
    calls++; peak = Math.max(peak, ++active)
    await sleep(60)
    active--
    return { edges: [{ fromNodeId: nodes[0].id, toNodeId: nodes[1].id, relation: 'supports', evidence: [{ paragraph: nodes[0].paragraph, quote: nodes[0].quote }] }] }
  }
  task.persistRelationWeave = async next => {
    assert.equal(++writes, 1)
    await sleep(2)
    durable = structuredClone(next)
    writes--
  }
  attach(task)
  const start = performance.now()
  const result = await weaveRelationsHost(task, null, acc, units, { documentId: 'fixture' }, units.join('\n\n'))
  weaveTimings.push({ concurrency, milliseconds: Math.round(performance.now() - start), calls, peak })
  assert.equal(peak, concurrency)
  assert.equal(calls, result.groups)
  assert.equal(Object.keys(durable.results).length, result.groups)
  assert.equal(task.progress.discovery.savedGroups, result.groups, 'coverage updates must retain durable group progress')
  assert.equal(task.progress.discovery.totalGroups, result.groups)
  if (expectedEdges) assert.deepEqual(acc.edges, expectedEdges, 'merge order cannot depend on lane completion order')
  expectedEdges = acc.edges
}

// Persist a later batch first, pause while siblings still have a reply in
// flight, then resume only the missing decisions from the durable snapshot.
{
  const task = taskFor(4), graph = fixture(80)
  let durable, calls = 0
  reviewer = async ({ candidates }) => {
    const index = calls++
    await sleep(index === 1 ? 5 : 40)
    return supported(candidates)
  }
  task.persistPostprocess = async () => {
    durable = structuredClone(task.postprocess)
    task.cancelled = true
    task.pauseRequested = true
  }
  await assert.rejects(review(task, graph), error => error.code === 'cancelled')
  assert.equal(calls, 4, 'pause must stop new dispatch, including the fifth batch')
  assert.equal(Object.keys(durable.decisions).length, 16)
  assert.equal(task.progress.review.reviewed, 16, 'late replies cannot advance saved progress')
  assert.deepEqual(graph.edges, fixture(80).edges, 'pause must not partially remove candidates')
  const resumed = taskFor(2, durable.decisions)
  const called = []
  reviewer = async ({ candidates }) => { called.push(...candidates.map(item => item.id)); return supported(candidates) }
  const result = await review(resumed, fixture(80))
  assert.equal(result.reused, 16)
  assert.equal(result.reviewed, 80)
  assert.equal(called.length, 64)
  assert(called.every(id => Number(id.slice(1)) < 16 || Number(id.slice(1)) >= 32), 'saved second batch must not call the reviewer again')
}

// A failed durable write cannot count as reviewed or dispatch more model work.
{
  const task = taskFor(4)
  let calls = 0, writes = 0, durable
  reviewer = async ({ candidates }) => {
    const index = calls++
    await sleep(5 + index * 15)
    return supported(candidates)
  }
  task.persistPostprocess = async () => {
    if (++writes === 2) throw Object.assign(Error('fixture disk failure'), { code: 'persistence_failed' })
    durable = structuredClone(task.postprocess)
  }
  await assert.rejects(review(task, fixture(96)), error => error.code === 'persistence_failed')
  assert.equal(writes, 2)
  assert.equal(calls, 5, 'only one extra batch can dispatch before the second write fails')
  assert.equal(Object.keys(durable.decisions).length, 16)
  assert.equal(Object.keys(task.postprocess.decisions).length, 16)
  assert.equal(task.progress.review.reviewed, 16)
}

// One malformed response must not discard siblings or admit an unreviewed
// relation. Recursive splitting uses the same bounded queue, not new workers.
{
  const task = taskFor(4), graph = fixture(81)
  let active = 0, peak = 0
  reviewer = async ({ candidates }) => {
    peak = Math.max(peak, ++active)
    await sleep(2)
    active--
    const result = supported(candidates)
    for (const verdict of result.verdicts) if (verdict.id === 'r20') verdict.id = 'unknown'
    return result
  }
  const result = await review(task, graph)
  assert(peak <= 4)
  assert.equal(result.reviewed, 80)
  assert.equal(result.pending, 1)
  assert.deepEqual(result.withheld.map(item => item.edge.fromNodeId), ['n21'])
  assert.equal(result.withheld[0].verdict, 'pending')
  assert.equal(graph.edges.length, 80)
}

// Once a rate limit is observed, drain existing requests and continue serially.
{
  const task = taskFor(4)
  let active = 0, peak = 0, afterDrain = 0
  await runRelationQueueHost(task, Array.from({ length: 12 }, (_, i) => i), 'fixture', async index => {
    active++; peak = Math.max(peak, active)
    if (index >= 4) afterDrain = Math.max(afterDrain, active)
    await sleep(index === 0 ? 2 : 10)
    if (index === 0) task.relationConcurrencyLimit = 1
    active--
  })
  assert.equal(peak, 4)
  assert.equal(afterDrain, 1)
}

// Pool failure aborts sibling model hooks but must not rewrite the root error.
{
  const task = taskFor(2)
  let calls = 0, aborted = false
  await assert.rejects(runRelationQueueHost(task, [0, 1, 2], 'fixture', async index => {
    calls++
    if (!index) { await sleep(5); throw Object.assign(Error('disk'), { code: 'persistence_failed' }) }
    await new Promise((resolve, reject) => task.cancelHooks.push(() => { aborted = true; reject(Object.assign(Error('aborted'), { code: 'cancelled' })) }))
  }), error => error.code === 'persistence_failed')
  assert.equal(calls, 2)
  assert(aborted)
  assert(!task.cancelled)
}

await assert.rejects(runRelationQueueHost({ cancelled: true }, [], 'fixture', async () => {}), error => error.code === 'cancelled')

console.log(JSON.stringify({ controlledLatencyBenchmark: { review: timings, weave: weaveTimings }, boundedParallelism: true, serializedDurableWrites: true,
  outOfOrderPauseResume: true, lateRepliesIgnored: true, writeFailureStopsDispatch: true, malformedBatchIsolated: true,
  rateLimitDownshift: true, siblingAbortPreservesRootFailure: true }))
