import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import hostPlugin from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fixture(withDocumentId = false) {
  const documentId = 'document-timeout-smoke'
  const sourceId = 'source-timeout-smoke'
  const sourceText = '恢复依赖检查点。\n\n检查点支持断点续跑。'
  const source = {
    id: sourceId,
    ...(withDocumentId ? { documentId } : {}),
    title: '超时取消测试',
    chars: sourceText.length,
    paragraphCount: 2,
    chunkCount: 1,
    sectionCount: 1,
    sections: [{ id: 'section-main', title: '正文', startParagraph: 0, endParagraph: 1 }],
  }
  const graph = {
    summary: '恢复依赖检查点',
    source,
    nodes: [{
      id: 'n1', type: 'claim', text: '恢复依赖检查点', paragraph: 0, quote: '恢复依赖检查点',
      evidence: [{ documentId, sourceId, chunkId: 'chunk-main', paragraph: 0, quote: '恢复依赖检查点' }],
      documentId, sourceId, chunkId: 'chunk-main', sectionId: 'section-main', sectionTitle: '正文',
      groundingStatus: 'grounded', entailmentStatus: 'unverified', state: 'candidate',
    }],
    edges: [],
    staging: {
      sourceId, documentId, chunkCount: 1,
      chunks: [{ chunkId: 'chunk-main', sourceId, startParagraph: 0, endParagraph: 1, sectionIds: ['section-main'], sectionTitles: ['正文'], summary: '恢复', nodeIds: ['n1'], edgeCount: 0, warnings: [] }],
    },
  }
  return { documentId, sourceId, sourceText, graph }
}

function fakeLlm() {
  const state = {
    mode: 'success', calls: 0, aborts: 0, returns: 0, nextCalls: 0,
  }
  return {
    state,
    stream(request) {
      state.calls += 1
      if (request && request.signal) request.signal.addEventListener('abort', () => { state.aborts += 1 }, { once: true })
      if (state.mode === 'hang-create') return new Promise(() => {})
      if (state.mode === 'late-create') {
        return new Promise((resolve) => setTimeout(() => resolve({
          [Symbol.asyncIterator]() { return this },
          next() { state.nextCalls += 1; return new Promise(() => {}) },
          return() { state.returns += 1; return Promise.resolve({ done: true }) },
        }), 80))
      }
      if (state.mode === 'hang-next') {
        return {
          [Symbol.asyncIterator]() { return this },
          next() { state.nextCalls += 1; return new Promise(() => {}) },
          return() { state.returns += 1; return new Promise(() => {}) },
        }
      }
      if (state.mode === 'cooperative-next') {
        let resolveNext = null
        return {
          [Symbol.asyncIterator]() { return this },
          next() { state.nextCalls += 1; return new Promise((resolve) => { resolveNext = resolve }) },
          return() {
            state.returns += 1
            if (resolveNext) { resolveNext({ done: true }); resolveNext = null }
            return Promise.resolve({ done: true })
          },
        }
      }
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({
          status: 'answered',
          parts: [{ text: '资料表述，恢复依赖检查点。', evidenceIds: ['ev1'] }],
          confidence: 0.8,
        }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

async function waitDynamic(handlers, taskId, timeoutMs = 1200) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return { ...status, elapsedMs: Date.now() - startedAt }
    await sleep(5)
  }
  throw new Error('dynamic task did not settle: ' + taskId)
}

async function startDynamicAnswer(handlers, input) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await handlers.get('answer-graph')(input)
    if (!(response && response.error && response.error.code === 'busy')) return response
    await sleep(5)
  }
  throw new Error('dynamic busy lock was not released')
}

async function dynamicSmoke() {
  const llm = fakeLlm()
  const handlers = new Map()
  globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
  hostPlugin().apply({
    get(name) { return name === 'llm' ? llm : null },
    interval() { return () => {} },
  })
  const fx = fixture(false)
  const answerInput = { graph: fx.graph, text: fx.sourceText, question: '恢复依赖什么？', model: { provider: 'fake', model: 'fake' } }

  process.env.DSH_KG_MODEL_TIMEOUT_CAP_MS = '40'
  llm.state.mode = 'hang-create'
  const timedStart = await startDynamicAnswer(handlers, answerInput)
  assert(timedStart.taskId, 'dynamic timeout task did not start')
  const timed = await waitDynamic(handlers, timedStart.taskId)
  assert(timed.status === 'failed' && timed.error && timed.error.code === 'timeout', 'never-resolving stream creation did not fail with timeout: ' + JSON.stringify(timed))
  assert(timed.elapsedMs < 800 && llm.state.aborts >= 1, 'dynamic timeout was not prompt or did not abort the provider')

  const lateReturnsBefore = llm.state.returns
  const lateNextBefore = llm.state.nextCalls
  llm.state.mode = 'late-create'
  const lateStart = await startDynamicAnswer(handlers, answerInput)
  const lateTimed = await waitDynamic(handlers, lateStart.taskId)
  assert(lateTimed.status === 'failed' && lateTimed.error.code === 'timeout', 'late stream creation did not time out')
  await sleep(100)
  assert(llm.state.nextCalls === lateNextBefore, 'late iterator entered next() after the task deadline')
  assert(llm.state.returns === lateReturnsBefore + 1, 'late iterator was not closed exactly once after resolving')

  llm.state.mode = 'success'
  const recoveredStart = await startDynamicAnswer(handlers, answerInput)
  const recovered = await waitDynamic(handlers, recoveredStart.taskId)
  assert(recovered.status === 'succeeded' && recovered.result.status === 'answered', 'busy/active task state did not recover after timeout')

  process.env.DSH_KG_MODEL_TIMEOUT_CAP_MS = '1000'
  const cooperativeReturnsBefore = llm.state.returns
  llm.state.mode = 'cooperative-next'
  const cancelledStart = await startDynamicAnswer(handlers, answerInput)
  await sleep(20)
  const cancelResponse = await handlers.get('task-cancel')({ taskId: cancelledStart.taskId })
  assert(cancelResponse.status === 'cancelling', 'dynamic task-cancel did not acknowledge cancellation')
  const cancelled = await waitDynamic(handlers, cancelledStart.taskId)
  assert(cancelled.status === 'cancelled' && cancelled.error && cancelled.error.code === 'cancelled', 'blocked iterator cancellation did not settle as cancelled: ' + JSON.stringify(cancelled))
  await sleep(20)
  assert(cancelled.elapsedMs < 600 && llm.state.returns === cooperativeReturnsBefore + 1, 'cooperative iterator cancellation was slow or closed more than once')

  llm.state.mode = 'hang-next'
  const questionStart = await handlers.get('question-graph')({
    graph: fx.graph,
    text: fx.sourceText,
    target: { kind: 'node', id: 'n1' },
    question: '这个节点可靠吗？',
    model: { provider: 'fake', model: 'fake' },
  })
  assert(questionStart.taskId, 'dynamic question cancellation task did not start')
  await sleep(20)
  await handlers.get('task-cancel')({ taskId: questionStart.taskId })
  const questionCancelled = await waitDynamic(handlers, questionStart.taskId)
  assert(questionCancelled.status === 'cancelled' && questionCancelled.error.code === 'cancelled', 'question cancellation was swallowed or converted to schema_invalid')

  llm.state.mode = 'success'
  const finalStart = await startDynamicAnswer(handlers, answerInput)
  const final = await waitDynamic(handlers, finalStart.taskId)
  assert(final.status === 'succeeded', 'dynamic runtime did not recover after cancellation')
  return { timeoutMs: timed.elapsedMs, cancelMs: cancelled.elapsedMs, calls: llm.state.calls, aborts: llm.state.aborts }
}

function invoke(handler, { method = 'POST', url, payload } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = { 'content-type': 'application/json' }
    const res = {
      status: 0, body: '', headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value },
      writeHead(status) { this.status = status },
      end(value) { this.body = value || ''; resolve({ status: this.status, body: this.body }) },
    }
    Promise.resolve(handler(req, res)).catch(reject)
    process.nextTick(() => {
      if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)))
      req.emit('end')
    })
  })
}

async function post(api, endpoint, payload) {
  const response = await invoke(api, { url: '/api/dsh-knowledge-graph/' + endpoint, payload })
  return response.body ? JSON.parse(response.body) : {}
}

async function waitHttp(api, taskId, timeoutMs = 1200) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const response = await invoke(api, { method: 'GET', url: '/api/dsh-knowledge-graph/task-status?taskId=' + encodeURIComponent(taskId) })
    const status = response.body ? JSON.parse(response.body) : {}
    if (status.status !== 'running') return { ...status, elapsedMs: Date.now() - startedAt }
    await sleep(5)
  }
  throw new Error('persistent task did not settle: ' + taskId)
}

async function startHttpAnswer(api, payload) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await post(api, 'answer-graph', payload)
    if (!(response && response.error && response.error.code === 'busy')) return response
    await sleep(5)
  }
  throw new Error('persistent busy lock was not released')
}

async function persistentSmoke() {
  const dir = mkdtempSync('/tmp/dsh-kg-timeout-')
  const dbPath = join(dir, 'timeout.sqlite')
  process.env.DSH_KG_DB = dbPath
  const fx = fixture(true)
  const store = await openSqliteStore(dbPath)
  store.saveGraph(fx.graph, { sourceText: fx.sourceText, sourceUnits: fx.sourceText.split('\n\n') })
  store.close()
  const llm = fakeLlm()
  const routes = []
  const cleanups = []
  const persistentHost = await import('../lib/index.js?timeout-smoke=' + Date.now())
  persistentHost.apply({
    get(name) {
      if (name === 'webServer') return { register(spec) { routes.push(spec); return () => {} } }
      if (name === 'llm') return llm
      return null
    },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup },
    interval() { return () => {} },
  })
  const route = routes.find((spec) => spec.path === '/api/dsh-knowledge-graph')
  assert(route && typeof route.handler === 'function', 'persistent API route missing')
  const api = route.handler
  const payload = { documentId: fx.documentId, expectedRevision: 1, question: '恢复依赖什么？', model: { provider: 'fake', model: 'fake' } }
  try {
    process.env.DSH_KG_MODEL_TIMEOUT_CAP_MS = '40'
    llm.state.mode = 'hang-create'
    const started = await startHttpAnswer(api, payload)
    assert(started.taskId, 'persistent timeout task did not start')
    const timed = await waitHttp(api, started.taskId)
    assert(timed.status === 'failed' && timed.error && timed.error.code === 'timeout', 'persistent timeout did not preserve timeout code: ' + JSON.stringify(timed))
    assert(timed.elapsedMs < 800 && llm.state.aborts >= 1, 'persistent timeout was not prompt or did not abort provider')

    llm.state.mode = 'success'
    const recoveredStart = await startHttpAnswer(api, payload)
    const recovered = await waitHttp(api, recoveredStart.taskId)
    assert(recovered.status === 'succeeded' && recovered.result.status === 'answered', 'persistent runtime did not recover after timeout')
    return { timeoutMs: timed.elapsedMs, calls: llm.state.calls, aborts: llm.state.aborts }
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch (error) {} }
    rmSync(dir, { recursive: true, force: true })
  }
}

const previousCap = process.env.DSH_KG_MODEL_TIMEOUT_CAP_MS
try {
  const dynamic = await dynamicSmoke()
  const persistent = await persistentSmoke()
  console.log(JSON.stringify({ ok: true, dynamic, persistent }))
} finally {
  if (previousCap === undefined) delete process.env.DSH_KG_MODEL_TIMEOUT_CAP_MS
  else process.env.DSH_KG_MODEL_TIMEOUT_CAP_MS = previousCap
  delete process.env.DSH_KG_DB
}
