import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { openSqliteStore } from '../src/kg-store.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
async function until(fn) {
  for (let i = 0; i < 600; i++) {
    const result = await fn()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw Error('Fixture did not settle')
}
async function bind(kind, services = {}, limit = 2) {
  let source = readFileSync(new URL(kind === 'dynamic' ? '../src/index.host.js' : '../lib/index.js', import.meta.url), 'utf8')
    .replace("from './kg-store.mjs'", 'from ' + JSON.stringify(new URL('../lib/kg-store.mjs', import.meta.url).href))
  const marker = '      function failTask('
  assert(source.includes(marker))
  source = source.replace(marker, `      ctx.multiTaskTest = { tasks, startTaskHost, callModel, taskStage, reserveTaskHost, releaseTaskHost, activeTaskStatusHost,
    ${kind === 'persistent' ? 'setStore(store) { sqliteStorePromise = Promise.resolve(store) },' : ''}
  };\n` + marker)
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  const handlers = new Map(), cleanups = []
  let route
  const ctx = { get(name) {
    if (name === 'webServer') return { register(spec) { if (spec.path === '/api/dsh-knowledge-graph') route = spec.handler; return () => {} } }
    return services[name] || null
  }, interval() {}, effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) } }
  const priorHarness = globalThis.harness, priorLimit = process.env.DSH_KG_MAX_CONCURRENT_TASKS
  globalThis.harness = { handle(name, fn) { handlers.set(name, fn) } }
  process.env.DSH_KG_MAX_CONCURRENT_TASKS = String(limit)
  try { if (kind === 'dynamic') module.default().apply(ctx); else module.apply(ctx) }
  finally {
    globalThis.harness = priorHarness
    if (priorLimit === undefined) delete process.env.DSH_KG_MAX_CONCURRENT_TASKS
    else process.env.DSH_KG_MAX_CONCURRENT_TASKS = priorLimit
  }
  return { ...ctx.multiTaskTest, close() { cleanups.reverse().forEach(fn => fn()) }, async call(name, args = {}, method = 'POST') {
    if (kind === 'dynamic') return handlers.get(name)(args)
    const req = new EventEmitter()
    req.method = method; req.headers = {}
    req.url = '/api/dsh-knowledge-graph/' + name + (method === 'GET' ? '?' + new URLSearchParams(args) : '')
    let response
    const pending = route(req, { setHeader() {}, writeHead() {}, end(data) { response = JSON.parse(data) } })
    if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(args)))
    req.emit('end')
    await pending
    return response
  } }
}

// Real request collectors overlap. All stream events remain owned by the task
// passed into the collector; cancelling A must leave B's stream and usage intact.
for (const kind of ['dynamic', 'persistent']) {
  const streams = new Map()
  const host = await bind(kind, { llm: { stream({ messages, signal }) {
    const id = messages[0].content[0].text, queue = [], readers = []
    let closed = false
    const stream = {
      signal, [Symbol.asyncIterator]() { return this },
      next() { return queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve({ done: true }) : new Promise(resolve => readers.push(resolve)) },
      push(value) { const event = { done: false, value }; if (readers.length) readers.shift()(event); else queue.push(event) },
      return() { closed = true; while (readers.length) readers.shift()({ done: true }); return Promise.resolve({ done: true }) },
    }
    streams.set(id, stream)
    return stream
  } } })
  try {
    const run = async task => {
      try {
        host.taskStage(task, '请求 ' + task.id)
        task.result = await host.callModel({ provider: 'fixture', model: 'fixture' }, '', task.id, 2000, 0, null, { task })
        task.status = 'succeeded'
      } catch (error) { task.status = error.code === 'cancelled' ? 'cancelled' : 'failed'; task.errorCode = error.code }
      task.finishedAt = Date.now()
    }
    const a = { id: 'a', documentId: 'doc-a', status: 'running', createdAt: Date.now() }
    const b = { id: 'b', documentId: 'doc-b', status: 'running', createdAt: Date.now() }
    assert.equal(host.startTaskHost(a, run).taskId, 'a')
    assert.equal(host.startTaskHost(b, run).taskId, 'b')
    assert.equal(host.startTaskHost({ id: 'duplicate', documentId: 'doc-a' }, run).error.code, 'busy')
    assert.equal(host.startTaskHost({ id: 'over-cap', documentId: 'doc-c' }, run).error.code, 'busy')
    await tick()
    assert.equal(streams.size, 2, 'the two model calls must truly overlap')
    assert.equal(host.activeTaskStatusHost().activeCount, 2)
    streams.get('a').push({ type: 'text-delta', index: 0, text: 'A' })
    streams.get('b').push({ type: 'text-delta', index: 0, text: 'BBB' })
    streams.get('b').push({ type: 'usage', usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 } })
    await tick()
    assert.equal(a.progress.charsReceived, 1)
    assert.equal(b.progress.charsReceived, 3)
    const cancellation = await host.call('task-cancel', { taskId: 'a' })
    assert.equal(cancellation.status, 'cancelling', kind + ': cancel request was not accepted')
    await until(() => a.status === 'cancelled' && host.activeTaskStatusHost().activeCount === 1)
    assert.equal(host.activeTaskStatusHost().activeCount, 1, kind + ': A cancellation must release only A')
    assert.equal(streams.get('a').signal.aborted, true)
    assert.equal(streams.get('b').signal.aborted, false)
    const before = structuredClone(b.progress)
    streams.get('a').push({ type: 'text-delta', index: 0, text: 'LATE' })
    await tick()
    assert.deepEqual(b.progress, before, 'late A responses cannot update B')
    const c = { id: 'c', documentId: 'doc-c', status: 'running', createdAt: Date.now() }
    assert.equal(host.startTaskHost(c, async () => { throw Error('synthetic failure') }).taskId, 'c')
    const originalError = console.error
    console.error = () => {}
    try { await until(() => c.status === 'failed' && host.activeTaskStatusHost().activeCount === 1) }
    finally { console.error = originalError }
    assert.equal(b.status, 'running', 'another task failure must preserve B ownership')
    streams.get('b').push({ type: 'text-delta', index: 0, text: 'B' })
    await streams.get('b').return()
    await until(() => b.status === 'succeeded' && host.activeTaskStatusHost().activeCount === 0)
    assert.equal(b.result, 'BBBB')
    assert.equal(b.modelUsage.finishedRequests, 1)
    assert.equal(b.modelUsage.totals.outputTokens.tokens, 3)
    const preparation = host.reserveTaskHost({ documentId: 'preparing' })
    assert.equal(host.activeTaskStatusHost().preparingCount, 1)
    host.releaseTaskHost({})
    assert.equal(host.activeTaskStatusHost().activeCount, 1, 'an unrelated finally cannot release another reservation')
    host.releaseTaskHost(preparation.token)
  } finally { host.close() }
}

// The production extraction, checkpoint, pause and resume paths share a real,
// isolated SQLite database. No model provider or user's database is contacted.
const store = await openSqliteStore(':memory:')
const gates = new Map([['Book A', deferred()], ['Book B', deferred()]])
const entered = new Set(), calls = []
const extractor = async ({ title, chunk }) => {
  entered.add(title); calls.push(title)
  if (gates.has(title)) await gates.get(title).promise
  const unit = chunk.units[0]
  return { summary: title, nodes: [{ id: 'n1', type: 'fact', text: unit.text, quote: unit.text, paragraph: unit.num }], edges: [] }
}
extractor.weaveRelations = async () => ({ edges: [] })
const host = await bind('persistent', { kgExtractor: extractor })
host.setStore(store)
try {
  const [a, b] = await Promise.all([
    host.call('extract', { title: 'Book A', text: '甲设备功率为一瓦。' }),
    host.call('extract', { title: 'Book B', text: '乙设备功率为二瓦。' }),
  ])
  assert(a.taskId && b.taskId)
  assert.notEqual(a.taskId, b.taskId)
  assert.notEqual(a.documentId, b.documentId)
  await until(() => entered.size === 2)
  const unrelated = { source: { documentId: 'doc-c' }, summary: 'C', nodes: [
    { id: 'nc', type: 'fact', text: '丙设备功率为三瓦。', quote: '丙设备功率为三瓦。', paragraph: 0 },
  ], edges: [] }
  store.saveGraph(unrelated, { sourceText: '丙设备功率为三瓦。' })
  const edited = await host.call('graph-commit', { documentId: 'doc-c', expectedRevision: 1,
    graph: { ...unrelated, summary: 'Edited C' }, baseNodeIds: ['nc'], baseEdgeKeys: [] })
  assert.equal(edited.revision, 2, 'an unrelated graph remains editable when all task slots are occupied')
  assert.equal((await host.call('graph-commit', { documentId: a.documentId, expectedRevision: 0,
    graph: { nodes: [], edges: [] } })).error.code, 'busy', 'the generating document must reject edits')
  assert.equal((await host.call('extract', { documentId: a.documentId, text: '重复资料。' })).error.code, 'busy')
  assert.equal((await host.call('extract', { title: 'Book C', text: '丙设备功率为三瓦。' })).error.code, 'busy')
  assert.equal(store.loadCheckpoint(a.taskId).documentId, a.documentId)
  assert.equal(store.loadCheckpoint(b.taskId).documentId, b.documentId)
  assert.equal((await host.call('task-pause', { taskId: a.taskId })).status, 'pausing')
  assert.equal(host.activeTaskStatusHost().activeCount, 2, 'pause holds A until its worker drains')
  gates.get('Book A').resolve()
  await until(() => host.tasks.get(a.taskId).status === 'paused' && host.activeTaskStatusHost().activeCount === 1)
  assert.equal(store.loadCheckpoint(a.taskId).status, 'paused')
  assert.equal(store.loadCheckpoint(b.taskId).status, 'running')
  assert.equal(host.tasks.get(b.taskId).status, 'running')
  const resumed = await host.call('resume-extract', { runId: a.taskId, resumePaused: true })
  assert.equal(resumed.taskId, a.taskId)
  await until(() => host.tasks.get(a.taskId).status === 'succeeded')
  assert.equal(host.tasks.get(b.taskId).status, 'running')
  gates.get('Book B').resolve()
  await until(() => host.tasks.get(b.taskId).status === 'succeeded' && host.activeTaskStatusHost().activeCount === 0)
  const graphA = store.getDocument(a.documentId), graphB = store.getDocument(b.documentId)
  assert.equal(graphA.source.title, 'Book A')
  assert.equal(graphB.source.title, 'Book B')
  assert(graphA.nodes.every(node => !node.text.includes('乙')))
  assert(graphB.nodes.every(node => !node.text.includes('甲')))
  assert.equal(calls.filter(title => title === 'Book B').length, 1, 'resuming A cannot regenerate B')
} finally {
  for (const gate of gates.values()) gate.resolve()
  await tick()
  host.close(); store.close()
}
console.log('multitask smoke passed: real overlapping streams, per-document fence, cap, cancellation, failure, progress, usage, SQLite isolation, pause and resume')
