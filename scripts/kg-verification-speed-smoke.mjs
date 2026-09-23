import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
// Preserve the real retry/cancellation path while shortening only the provider
// cooldown in this isolated test. No real model or production database is used.
assert.equal(source.split('const RELATION_WEAVE_RATE_LIMIT_DELAY_MS = 30000').length, 2)
const instrumented = source.replace('const RELATION_WEAVE_RATE_LIMIT_DELAY_MS = 30000', 'const RELATION_WEAVE_RATE_LIMIT_DELAY_MS = 100') + '\n//# sourceURL=verification-speed-host.js'
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))
const text = 'The fixture records an observation with its original supporting evidence.'
const graph = {
  source: { title: 'Speed fixture', documentId: 'speed-fixture' },
  nodes: Array.from({ length: 72 }, (_, i) => ({ id: 'n' + i, type: 'fact', text: 'Observation ' + i, quote: text, paragraph: 0 })),
  edges: [{ fromNodeId: 'n0', toNodeId: 'n71', relation: 'supports', evidence: [{ paragraph: 0, quote: text }] }],
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(test, timeout = 10000) {
  const end = performance.now() + timeout
  while (performance.now() < end) { if (await test()) return; await sleep(2) }
  assert.fail('verification did not reach the expected state')
}
function payload(options) {
  const user = options.messages[0].content[0].text
  if (user.startsWith('候选问题列表')) return { phase: 'confirm', candidates: JSON.parse(user.split('\n')[1]) }
  return { phase: 'review', graph: JSON.parse(user.slice(user.lastIndexOf('\n') + 1)), relationsOnly: user.includes('本批只审校指定的跨批关系') }
}
function answer(request) {
  if (request.phase === 'confirm') return { kept: request.candidates.map(issue => ({ id: issue.id })) }
  const edge = request.relationsOnly ? request.graph.edges[0] : null
  const target = edge ? edge.fromNodeId + '>' + edge.toNodeId : request.graph.nodes[0].id
  return { issues: [{ id: 'check', severity: 'warning', category: edge ? 'relation' : 'other', targetKind: edge ? 'edge' : 'node', targetId: target,
    title: 'Check ' + target, detail: 'Fixture evidence check', evidence: [{ paragraph: 0, quote: text }], confidence: 0.9, proposedFix: { action: 'none' } }] }
}
function bind(plan = () => ({ delay: 100 })) {
  const handlers = new Map(), requests = [], live = new Set(), samples = []
  let maxActive = 0
  globalThis.harness = { handle(name, fn) { handlers.set(name, fn) } }
  plugin().apply({ interval() {}, get(name) {
    if (name !== 'llm') return null
    return { stream(options) {
      const request = { ...payload(options), options, index: requests.length, startedAt: performance.now() }
      requests.push(request)
      const policy = plan(request)
      const pending = [], values = []
      let closed = false, timer
      const stream = {
        [Symbol.asyncIterator]() { return this },
        next() { return values.length ? Promise.resolve(values.shift()) : closed ? Promise.resolve({ done: true }) : new Promise(resolve => pending.push(resolve)) },
        return() {
          if (!closed) { closed = true; clearTimeout(timer); live.delete(stream); request.finishedAt = performance.now() }
          while (pending.length) pending.shift()({ done: true })
          return Promise.resolve({ done: true })
        },
        finish(value) {
          if (closed) return
          const item = { done: false, value }
          if (pending.length) pending.shift()(item); else values.push(item)
          this.return()
        },
      }
      live.add(stream)
      maxActive = Math.max(maxActive, live.size)
      samples.push({ at: request.startedAt, active: live.size })
      if (!policy.hold) timer = setTimeout(() => stream.finish(policy.error
        ? { type: 'finish', reason: { kind: 'error', failure: policy.error } }
        : { type: 'text-delta', index: 0, text: typeof policy.raw === 'string' ? policy.raw : JSON.stringify(policy.result || answer(request)) }), policy.delay ?? 1)
      return stream
    } }
  } })
  return { handlers, requests, live, samples, get maxActive() { return maxActive },
    submit: concurrency => handlers.get('verify-graph')({ text, graph, mode: 'standard', concurrency, model: { provider: 'fixture', model: 'controlled' } }),
    status: taskId => handlers.get('task-status')({ taskId }),
    active: taskId => handlers.get('task-active')({ taskId }),
    cancel: taskId => handlers.get('task-cancel')({ taskId }),
  }
}

const benchmark = []
let expectedIssues, expectedRequests
for (const concurrency of [1, 2, 4]) {
  const host = bind(request => ({ delay: request.phase === 'review' && request.graph.nodes[0].id === 'n0' ? 180 : 100 }))
  const startedAt = performance.now(), { taskId } = await host.submit(concurrency)
  let previousCompleted = 0
  await until(async () => {
    const result = await host.status(taskId)
    if (result.status === 'running') {
      const count = result.progress.verification.completedBatches
      assert.ok(count >= previousCompleted, 'out-of-order completion cannot move progress backwards')
      assert.ok(result.progress.requests.length <= concurrency)
      assert.ok(result.progress.verification.activeBatches.length <= concurrency)
      previousCompleted = count
    }
    return result.status !== 'running'
  })
  const result = await host.status(taskId), elapsedMs = performance.now() - startedAt
  assert.equal(result.status, 'succeeded')
  assert.equal(host.live.size, 0)
  assert.equal(host.maxActive, concurrency)
  assert.equal(result.result.issues.filter(issue => issue.source === 'ai').length, 7, 'every batch must pass independent confirmation')
  assert.ok(result.result.issues.some(issue => issue.source === 'ai' && issue.targetId === 'n0>n71'), 'cross-batch relation review cannot be skipped')
  const covered = host.requests.map(request => request.phase === 'review'
    ? { phase: request.phase, nodes: request.graph.nodes.map(node => node.id), edges: request.graph.edges, relationsOnly: request.relationsOnly }
    : { phase: request.phase, ids: request.candidates.map(issue => issue.id) }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if (!expectedIssues) { expectedIssues = result.result.issues; expectedRequests = covered }
  else { assert.deepEqual(result.result.issues, expectedIssues); assert.deepEqual(covered, expectedRequests) }
  benchmark.push({ concurrency, elapsedMs: Math.round(elapsedMs), calls: host.requests.length, peakRequests: host.maxActive })
}
assert.ok(benchmark[1].elapsedMs < benchmark[0].elapsedMs * 0.8, 'two lanes must overlap real request waits')
assert.ok(benchmark[2].elapsedMs < benchmark[0].elapsedMs * 0.6, 'four lanes must overlap real request waits')

// Cancelling concurrent batches must drain all sibling streams and admit no more.
for (const cancelPhase of ['review', 'confirm']) {
  const host = bind(request => request.phase === cancelPhase ? { hold: true } : { delay: 1 }), { taskId } = await host.submit(4)
  await until(() => host.live.size === 4 && host.requests.filter(request => request.phase === cancelPhase).length === 4)
  const before = host.requests.length
  await host.cancel(taskId)
  await until(async () => (await host.status(taskId)).status === 'cancelled')
  assert.equal(host.live.size, 0)
  assert.equal(host.requests.length, before)
  const active = await host.active(taskId)
  assert.equal(active.busy, false)
  assert.equal(active.trackedTask.progress.verification.activeBatches.length, 0)
}

{
  const host = bind(request => request.index === 0 ? { error: { status: 401, message: 'fixture unauthorized' } } : { hold: true })
  const { taskId } = await host.submit(4)
  await until(async () => (await host.status(taskId)).status !== 'running')
  assert.equal((await host.status(taskId)).status, 'failed')
  assert.equal(host.requests.length, 4, 'permanent authentication failures must not be retried')
  assert.equal(host.live.size, 0)
}

// A malformed review or failed independent verifier is not a successful report.
for (const [failurePhase, invalid] of [['review', '{}'], ['confirm', '{}'], ['confirm', '{"kept":[{}]}'], ['confirm', '{"kept":[{"id":"another-batch"}]}']]) {
  const host = bind(request => {
    const firstBatch = request.phase === 'review' ? request.graph.nodes[0].id === 'n0' : request.candidates[0].id === 'b1:check'
    return firstBatch ? { raw: request.phase === failurePhase ? invalid : JSON.stringify(answer(request)) } : { hold: true }
  })
  const { taskId } = await host.submit(4)
  await until(async () => (await host.status(taskId)).status !== 'running')
  const status = await host.status(taskId)
  assert.equal(status.status, 'failed')
  assert.equal(status.result, undefined)
  assert.equal(host.live.size, 0, 'failure must drain siblings before releasing ownership')
  assert.equal((await host.active(taskId)).busy, false)
  assert.equal(host.requests.filter(request => request.phase === failurePhase && (request.phase === 'review' ? request.graph.nodes[0].id === 'n0' : request.candidates[0].id === 'b1:check')).length, 3)
}

// Provider throttling backs off, reduces later batches to one lane, and remains cancellable.
for (const cancelDuringDelay of [false, true]) {
  let limitedAt = 0
  const host = bind(request => request.index === 0 ? (limitedAt = performance.now(), { error: { code: 'RATE_LIMIT', status: 429, message: 'fixture rate limit' } }) : { delay: 2 })
  const { taskId } = await host.submit(4)
  await until(async () => (await host.status(taskId)).progress?.relationParallel?.limit === 1)
  if (cancelDuringDelay) await host.cancel(taskId)
  await until(async () => (await host.status(taskId)).status !== 'running')
  const result = await host.status(taskId)
  assert.equal(result.status, cancelDuringDelay ? 'cancelled' : 'succeeded')
  assert.equal(host.live.size, 0)
  if (!cancelDuringDelay) {
    const retry = host.requests.find(request => request.index > 0 && request.phase === 'review' && request.graph.nodes[0].id === 'n0')
    assert.ok(retry.startedAt - limitedAt >= 90, 'rate-limit retry must honor the cooldown')
    assert.ok(host.samples.filter(sample => sample.at >= retry.startedAt).every(sample => sample.active === 1))
    assert.deepEqual(result.result.issues, expectedIssues)
  }
}
console.log(JSON.stringify({ ok: true, benchmark, identicalRequestCoverageAndReport: true, independentConfirmationRequired: true, outOfOrderProgress: true, cancellationDrainsSiblings: true, rateLimitBackoffAndDowngrade: true }))
