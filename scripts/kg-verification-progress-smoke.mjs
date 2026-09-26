import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import hostPlugin from '../src/index.host.js'

const flush = () => new Promise(resolve => setImmediate(resolve))
async function until(test) {
  for (let i = 0; i < 300; i++) {
    if (await test()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('verification fixture did not reach the expected state')
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Exercise the real runner with controlled streams, including retries and the
// separate evidence verifier. No provider or production database is involved.
const handlers = new Map(), streams = []
globalThis.harness = { handle(name, fn) { handlers.set(name, fn) } }
hostPlugin().apply({ interval() {}, get(name) {
  if (name !== 'llm') return null
  return { stream() {
    const pending = [], values = []
    let closed = false
    const stream = {
      [Symbol.asyncIterator]() { return this },
      next() { return values.length ? Promise.resolve(values.shift()) : closed ? Promise.resolve({ done: true }) : new Promise(resolve => pending.push(resolve)) },
      push(value) { const item = { done: false, value }; if (pending.length) pending.shift()(item); else values.push(item) },
      return() { closed = true; while (pending.length) pending.shift()({ done: true }); return Promise.resolve({ done: true }) },
      finish(value) { this.push({ type: 'text-delta', index: 0, text: value }); this.return() },
    }
    streams.push(stream)
    return stream
  } }
} })
const text = 'Evidence for the fixture.'
const graph = {
  nodes: Array.from({ length: 13 }, (_, i) => ({ id: 'n' + i, type: 'fact', text, quote: text, paragraph: 0 })),
  edges: [{ fromNodeId: 'n0', toNodeId: 'n12', relation: 'supports', evidence: [{ paragraph: 0, quote: text }] }],
}
const submit = () => handlers.get('verify-graph')({ text, graph, mode: 'standard', concurrency: 1, model: { provider: 'fixture', model: 'controlled' } })
const { taskId } = await submit()
assert.ok(taskId)
const status = () => handlers.get('task-status')({ taskId })
await until(() => streams.length === 1)
let progress = (await status()).progress
assert.equal(progress.verification.totalBatches, 3, 'cross-batch edges must remain covered')
assert.equal(progress.verification.completedBatches, 0)
assert.equal(progress.verification.activeBatches[0].batchIndex, 1)
assert.ok(progress.stage.includes('1/3'))
streams[0].push({ type: 'reasoning-delta', index: 0, text: 'private fixture reasoning' })
await flush()
progress = (await status()).progress
assert.equal(progress.requests[0].reasoningChars, 25)
assert.ok(!JSON.stringify(progress).includes('private fixture reasoning'))
streams[0].finish('not JSON')
await until(() => streams.length === 2)
progress = (await status()).progress
assert.equal(progress.verification.activeBatches[0].attempt, 2)
assert.equal(progress.verification.completedBatches, 0, 'a retry is not a completed batch')
assert.ok(progress.stage.includes('重试 1/2'))
streams[1].finish(JSON.stringify({ issues: [{ id: 'one', severity: 'warning', category: 'other', targetKind: 'node', targetId: 'n0', title: 'Fixture issue', detail: 'Fixture detail', evidence: [{ paragraph: 0, quote: text }], confidence: 0.9, proposedFix: { action: 'none' } }] }))
await until(() => streams.length === 3)
progress = (await status()).progress
assert.equal(progress.verification.phase, 'confirm')
assert.equal(progress.verification.completedBatches, 0, 'the batch is unfinished until independent confirmation returns')
assert.ok(progress.stage.includes('独立复核'))
streams[2].finish(JSON.stringify({ kept: [{ id: 'b1:one' }] }))
for (let i = 3; i < 5; i++) {
  await until(() => streams.length === i + 1)
  progress = (await status()).progress
  assert.equal(progress.verification.completedBatches, i - 2)
  assert.equal(progress.verification.activeBatches[0].batchIndex, i - 1)
  assert.equal(progress.verification.activeBatches[0].attempt, 1)
  streams[i].finish('{"issues":[]}')
}
await until(async () => (await status()).status === 'succeeded')
assert.ok((await status()).result.issues.some(issue => issue.id === 'b1:one'))
await flush()
const cancelled = await submit()
await until(() => streams.length === 6)
assert.equal((await handlers.get('task-cancel')({ taskId: cancelled.taskId })).status, 'cancelling')
await until(async () => (await handlers.get('task-status')({ taskId: cancelled.taskId })).status === 'cancelled')

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const common = client.slice(client.indexOf('      function watchVerificationTask('), client.indexOf('      function RelationDiscoveryStatus('))
function mount(transport, onReport = async () => {}) {
  let progress = { kind: 'verify', taskId: 'original', status: 'running', startedAt: Date.now(), stage: 'last known stage' }, current = true
  const queue = new Set(), delays = [], finishes = [], calls = []
  const setProgress = value => { progress = typeof value === 'function' ? value(progress) : value }
  const host = { call(method, args) { calls.push(method); assert.equal(args.taskId, 'original'); return transport(method, args) } }
  const { watchVerificationTask, cancelVerificationTask } = new Function('host', common + '; return { watchVerificationTask, cancelVerificationTask }')(host)
  const close = watchVerificationTask({ taskId: 'original', isCurrent: () => current, setProgress, onReport,
    onFinish: (...args) => finishes.push(args),
    ctx: { timeout(fn, ms) { assert.ok(ms >= 3000 && ms <= 15000); delays.push(ms); queue.add(fn); return () => queue.delete(fn) } },
  })
  return { get progress() { return progress }, setProgress, finishes, calls, queue, delays, close,
    invalidate() { current = false },
    cancel: () => cancelVerificationTask('original', () => current, setProgress),
    async tick() { assert.equal(queue.size, 1); const [fn] = queue; queue.delete(fn); return fn() },
  }
}
let polls = 0
const save = deferred()
const recovery = mount(async method => {
  assert.equal(method, 'task-status')
  polls++
  if (polls <= 8) throw new TypeError('offline')
  if (polls === 9) return { error: { message: 'bad gateway' } }
  if (polls === 10) return { status: 'running', progress: { stage: 'recovered', verification: { completedBatches: 1, totalBatches: 3 } } }
  return { status: 'succeeded', result: { issues: [], summary: 'done' } }
}, () => save.promise)
await flush()
assert.ok(recovery.progress.connectionError)
assert.equal(recovery.progress.stage, 'last known stage')
for (let i = 0; i < 9; i++) await recovery.tick()
assert.equal(recovery.progress.connectionError, '')
assert.equal(recovery.progress.stage, 'recovered')
assert.equal(recovery.finishes.length, 0)
const saving = recovery.tick()
await flush()
assert.equal(recovery.progress.status, 'saving')
assert.equal(recovery.finishes.length, 0, 'completion must wait for report persistence')
save.resolve()
await saving
assert.equal(recovery.progress.status, 'succeeded')
assert.equal(recovery.finishes.length, 1)
assert.equal(recovery.queue.size, 0)
assert.ok(recovery.calls.every(method => method === 'task-status'), 'reconnection cannot resubmit AI work')
recovery.close()

let pausePolls = 0
const pausedWatcher = mount(async () => {
  pausePolls++
  return pausePolls === 1 ? { status: 'paused', progress: { canPause: false, verification: { completedBatches: 1, totalBatches: 3 } } }
    : { status: 'running', progress: { canPause: true, verification: { completedBatches: 1, totalBatches: 3 } } }
})
await flush()
assert.equal(pausedWatcher.progress.status, 'paused')
assert.equal(pausedWatcher.finishes.length, 0, 'pause retains task ownership')
await pausedWatcher.tick()
assert.equal(pausedWatcher.progress.status, 'running', 'explicit resume is observed by the same watcher')
pausedWatcher.close()

for (const terminal of ['failed', 'cancelled', 'not_found', 'invalid-report', 'save-failed']) {
  const test = mount(async () => terminal === 'invalid-report' || terminal === 'save-failed'
    ? { status: 'succeeded', result: terminal === 'invalid-report' ? {} : { issues: [] } }
    : { status: terminal, error: { message: terminal } }, async () => { throw new Error('save failed') })
  await flush()
  assert.equal(test.finishes.length, 1)
  assert.notEqual(test.progress.status, 'succeeded')
  assert.equal(test.queue.size, 0)
  test.close()
}
for (const mode of ['late-resolve', 'late-reject', 'changed-document']) {
  const pending = deferred(), test = mount(() => pending.promise)
  if (mode === 'changed-document') test.invalidate()
  else test.close()
  if (mode === 'late-reject') pending.reject(new Error('offline'))
  else pending.resolve({ status: 'succeeded', result: { issues: [] } })
  await flush()
  assert.equal(test.finishes.length, 0)
  assert.equal(test.progress.stage, 'last known stage')
  assert.equal(test.queue.size, 0)
  test.close()
}
const cancelReply = deferred()
const cancellation = mount(async method => method === 'task-cancel' ? cancelReply.promise : { status: 'running', progress: { stage: 'working' } })
await flush()
const cancel = cancellation.cancel()
assert.equal(cancellation.progress.cancelling, true)
cancelReply.reject(new Error('offline'))
await cancel
assert.equal(cancellation.progress.cancelling, false)
assert.ok(cancellation.progress.cancelError)
assert.equal(cancellation.queue.size, 1, 'failed cancellation must keep tracking')
cancellation.close()

const lateCancelReply = deferred()
const lateCancel = mount(async method => method === 'task-cancel' ? lateCancelReply.promise : { status: 'running' })
await flush()
const lateCancellation = lateCancel.cancel()
lateCancel.setProgress({ taskId: 'new-run', status: 'running' })
lateCancelReply.reject(new Error('late cancellation failure'))
await lateCancellation
assert.deepEqual(lateCancel.progress, { taskId: 'new-run', status: 'running' }, 'old cancellation cannot modify the next task')
lateCancel.close()

// Run both real click handlers, not a second implementation of admission.
const handlersCode = client.split('        const startDeepVerify = async () => {').slice(1).map(part => 'const startDeepVerify = async () => {' + part.slice(0, part.indexOf('        const startFactCheck')) + '; return startDeepVerify')
assert.equal(handlersCode.length, 2)
for (const code of handlersCode) for (const mode of ['accepted', 'rejected', 'no-id', 'offline', 'changed-document']) {
  const admission = deferred(), values = { phase: 'idle', progress: null, taskId: null }, busy = { current: false }, generation = { current: 0 }
  let calls = 0
  const env = {
    resultView: { graph: { ...graph, ontology: 'learning-view-v1', source: { title: 'Reviewed material' } }, sourceText: text },
    view: { graph: { ...graph, source: { title: 'Reviewed material', ontology: 'learning-view-v1' } }, sourceText: text }, title: '', fullText: text,
    verifyConcurrency: 4,
    MAX_VERIFY_NODES: 2000, graphViewMetadata: () => null,
    window: { confirm: () => true }, graphCommitQueueRef: { current: Promise.resolve() },
    documentIdOfGraph: () => 'reviewed-document',
    effectiveModelArg: null, verificationSourcePayload: () => ({}), verifyBusyRef: busy, bulkRunRef: { current: false }, verifyGenRef: generation,
    verifySnapshotRef: { current: null }, graphRevisionRef: { current: 1 }, trajRevisionRef: { current: 1 },
    host: { call(method, payload) {
      assert.equal(method, 'verify-graph')
      assert.equal(payload.title, 'Reviewed material')
      assert.equal(payload.documentId, 'reviewed-document')
      assert.equal(payload.concurrency, 4)
      if (code.includes('graphCommitQueueRef')) {
        assert.equal(payload.canonicalFull, true)
        assert.equal(payload.graph, undefined, 'full review must read canonical data on the server')
      } else assert.equal(payload.graph.ontology, 'learning-view-v1')
      calls++; return admission.promise
    } }, setError() {},
    setVerifyPhase: value => { values.phase = value }, setVerifyTaskId: value => { values.taskId = value },
    setVerifyProgress: value => { values.progress = typeof value === 'function' ? value(values.progress) : value },
  }
  env.currentResultRef = { current: env.resultView }
  const start = new Function(...Object.keys(env), code)(...Object.values(env))
  const run = start()
  assert.equal(values.progress.status, 'submitting', 'the click must render status before admission returns')
  await start()
  assert.equal(calls, 1, 'double click cannot submit duplicate work')
  if (mode === 'changed-document') { generation.current++; values.progress = null; values.phase = 'new-view' }
  if (mode === 'offline') admission.reject(new Error('offline'))
  else admission.resolve(mode === 'no-id' ? {} : mode === 'rejected' ? { error: { code: 'busy', message: 'busy' } } : { taskId: 'accepted' })
  await run
  if (mode === 'changed-document') {
    assert.equal(values.progress, null)
    assert.equal(values.phase, 'new-view')
    assert.equal(values.taskId, null)
  } else {
    assert.equal(values.progress.status, mode === 'accepted' ? 'running' : 'failed')
    assert.equal(busy.current, mode === 'accepted')
    assert.equal(values.phase, mode === 'accepted' ? 'running' : 'idle')
  }
}

const fullHandler = handlersCode.find(code => code.includes('graphCommitQueueRef'))
for (const approved of [false, true, 'plan-error']) {
  const view = { graph: { ...graph, source: { title: 'Large graph' } }, sourceText: text }
  const busy = { current: false }, progress = { current: null }, calls = [], confirmations = []
  const env = {
    resultView: view, currentResultRef: { current: view }, graphCommitQueueRef: { current: Promise.resolve() },
    graphRevisionRef: { current: 242 }, verifySnapshotRef: { current: null }, verifyBusyRef: busy, bulkRunRef: { current: false },
    verifyGenRef: { current: 0 }, graphViewMetadata: () => ({ totalNodes: 4645 }), MAX_VERIFY_NODES: 2000,
    documentIdOfGraph: () => 'large-document', title: '', fullText: text, verifyConcurrency: 2,
    effectiveModelArg: null, verificationSourcePayload: () => ({}),
    window: { confirm(message) { confirmations.push(message); return approved } },
    host: { async call(method, payload) {
      calls.push({ method, payload })
      if (method === 'verification-plan') return approved === 'plan-error' ? { error: { message: '批次上下文过大' } }
        : { revision: 242, coverage: { nodeCount: 4645, edgeCount: 8539,
        sourceUnitCount: 5413, batchCount: 1200 }, minimumModelRequests: 1200 }
      assert.equal(method, 'verify-graph')
      assert.equal(payload.canonicalFull, true)
      assert.equal(payload.graph, undefined)
      return { taskId: 'large-review' }
    } },
    setError() {}, setVerifyPhase() {}, setVerifyTaskId() {},
    setVerifyProgress(value) { progress.current = typeof value === 'function' ? value(progress.current) : value },
  }
  await new Function(...Object.keys(env), fullHandler)(...Object.values(env))()
  assert.deepEqual(calls.map(call => call.method), approved === true ? ['verification-plan', 'verify-graph'] : ['verification-plan'])
  if (approved !== 'plan-error') assert.match(confirmations[0], /4645.*8539.*5413.*1200/)
  else assert.equal(confirmations.length, 0)
  assert.equal(busy.current, approved === true)
  assert.equal(progress.current?.status || null, approved === true ? 'running' : approved === 'plan-error' ? 'failed' : null)
}

const h = (tag, attrs, ...children) => ({ tag, attrs, children })
const render = new Function('h', 'useState', 'useEffect', 'TaskPauseControls', common + '; return VerificationTaskStatus')(h, value => [value, () => {}], () => {}, () => null)
const tree = render({ progress: { kind: 'verify', status: 'running', elapsedMs: 1500, startedAt: Date.now(), stage: 'waiting', verification: { totalBatches: 3, completedBatches: 1, phase: 'confirm' }, requests: [] }, taskId: 't', ctx: {} })
assert.ok(JSON.stringify(tree).includes('已审校 1/3 批'))
assert.ok(JSON.stringify(tree).includes('独立复核候选问题'))
assert.ok(JSON.stringify(tree).includes('1 秒'))
assert.equal(render({ progress: null, ctx: {} }), null)
let focused = false, scrolled = false
const reportPanel = { focus() { focused = true }, scrollIntoView() { scrolled = true } }
const reportStatus = new Function('h', 'useState', 'useEffect', 'document', 'TaskPauseControls', common + '; return VerificationTaskStatus')(
  h, value => [value, () => {}], () => {}, { getElementById(id) { assert.equal(id, 'report'); return reportPanel } }, () => null,
)({ progress: { kind: 'verify', status: 'succeeded', stage: 'done' }, panelId: 'report', ctx: {} })
const find = (tree, check) => tree && typeof tree === 'object' ? check(tree) ? tree : tree.children?.flat().map(child => find(child, check)).find(Boolean) : null
find(reportStatus, node => node.tag === 'button').attrs.onClick()
assert.equal(focused && scrolled, true, 'report navigation must use an in-scope DOM operation')

// The trajectory report must observe the same authoritative commit receipt as
// the workbench, and a delayed save must not overwrite a different session.
const commitCode = client.slice(client.indexOf('        const persistTrajGraph ='), client.indexOf('        const commitTrajGraph ='))
for (const mode of ['valid', 'malformed', 'rejected', 'switched']) {
  const view = { graph, sourceText: text }, currentViewRef = { current: view }, revision = { current: 7 }, writes = [], errors = [], reports = []
  const env = {
    view, currentViewRef, documentIdOfGraph: () => 'fixture', semanticOperationsOf: () => [],
    trajRevisionRef: revision, trajCommitQueueRef: { current: Promise.resolve() }, graphSemanticOperations: new WeakMap(),
    trajCommitEpochRef: { current: 0 }, mountedSessionRef: { current: 'original-session' },
    sessionId: 'original-session', traceEvents: [], writeTrajResult: (...args) => writes.push(args),
    setError: value => { const next = typeof value === 'function' ? value(errors.at(-1)) : value; if (next) errors.push(next) },
    setView: value => writes.push(value), makeView: value => value,
    setVerification: value => reports.push(['verification', value]),
    setFactReport: value => reports.push(['fact', value]),
    host: { async call(method, payload) {
      assert.equal(method, 'graph-commit')
      assert.equal(payload.expectedRevision, 4, 'report must use the revision that was actually reviewed')
      if (mode === 'switched') currentViewRef.current = { graph: {} }
      return mode === 'malformed' ? {} : mode === 'rejected' || mode === 'switched' ? { error: { message: 'rejected' } }
        : { documentId: 'fixture', revision: 5, graph }
    } },
  }
  const commit = new Function(...Object.keys(env), commitCode + '; return persistTrajGraph')(...Object.values(env))
  const result = await commit({ ...graph }, graph, 4)
  assert.equal(!!result, mode === 'valid')
  assert.equal(writes.length > 0, mode === 'valid')
  assert.equal(errors.length, mode === 'malformed' || mode === 'rejected' ? 1 : 0)
  assert.equal(reports.length, 0,
    'a pinned canonical commit is not optimistic; failure must retain the existing window and report without replacing them')
  if (mode !== 'valid') assert.equal(revision.current, 7)
}
console.log(JSON.stringify({ ok: true, realHostBatches: 3, retryAndIndependentConfirmation: true, reconnectWithoutResubmit: true, terminalStates: 5, lateResponses: 3, admissionScenarios: 10, cancellationRecovery: true, reportPersistenceBeforeCompletion: true }))
