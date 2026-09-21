import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const graph = {
  ontology: 'learning-view-v1', revision: 1,
  source: { documentId: 'document-admission', title: 'Admission', revision: 1 },
  nodes: [{ id: 'n1', type: 'concept', text: 'Alpha' }, { id: 'n2', type: 'concept', text: 'Beta' }], edges: [],
  sourceText: 'Alpha.\n\nBeta.',
}
const documentId = graph.source.documentId
const events = [1, 2].map(seq => ({ seq, type: 'user/message', data: { content: [{ type: 'text', text: 'Message ' + seq }] } }))
graph.traceEvents = events.slice(0, 1)
graph.traceText = graph.sourceText
const store = {
  getDocumentRevision: () => 1,
  getDocument: () => structuredClone(graph),
  queryDocumentGraph: () => ({ graph: structuredClone(graph), matches: [] }),
}

async function bind(kind) {
  const file = kind === 'dynamic' ? '../src/index.host.js' : '../lib/index.js'
  let source = readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace("from './kg-store.mjs'", 'from ' + JSON.stringify(new URL('../lib/kg-store.mjs', import.meta.url).href))
  const marker = '      function failTask('
  assert(source.includes(marker))
  // Only the task body is held: route parsing, admission, errors and lock
  // ownership are production code, exercised across both transports.
  source = source.replace(marker, `      ctx.admissionTest = {
    tasks, activeTaskStatusHost, rememberCanonicalGraphHost,
    setRunner(run) { runTask = run; runRelationRetryTask = run; runConsumptionAnswerTask = run },
    ${kind === 'persistent' ? 'setStore(store) { sqliteStorePromise = Promise.resolve(store) },' : ''}
  };
` + marker)
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  const handlers = new Map(), cleanups = []
  let http
  const ctx = {
    get(name) { return name === 'sessions' ? { get: () => ({ events }) } : name === 'webServer' ? { register(route) {
      if (route.path === '/api/dsh-knowledge-graph') http = route.handler
      return () => {}
    } } : null },
    interval() {}, effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) },
  }
  const previousHarness = globalThis.harness
  globalThis.harness = { handle(name, fn) { handlers.set(name, fn) } }
  try {
    if (kind === 'dynamic') module.default().apply(ctx)
    else module.apply(ctx)
  } finally { globalThis.harness = previousHarness }
  const host = ctx.admissionTest
  host.rememberCanonicalGraphHost(graph, graph.sourceText, graph.revision)
  if (host.setStore) host.setStore(store)
  return { kind, ...host, close() { cleanups.reverse().forEach(fn => fn()) },
    async post(endpoint, body) {
      if (kind === 'dynamic') return { status: 200, response: await handlers.get(endpoint)(body) }
      const req = new EventEmitter()
      Object.assign(req, { method: 'POST', url: '/api/dsh-knowledge-graph/' + endpoint, headers: {} })
      let response, status
      const pending = http(req, { setHeader() {}, writeHead(code) { status = code }, end(data) { response = JSON.parse(data) } })
      req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end')
      await pending
      return { status, response }
    },
  }
}

const failures = []
async function check(name, run) {
  try { await run(); console.log('PASS ' + name) }
  catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message) }
}

await check('persistent extraction preparation failure releases admission lock', async () => {
  const host = await bind('persistent'), ready = deferred()
  try {
    host.setStore(ready.promise)
    const preparing = host.post('extract', { documentId, text: graph.sourceText })
    await tick()
    assert.equal(host.activeTaskStatusHost().busy, true, 'reserve admission before the store lookup')
    assert.equal(host.activeTaskStatusHost().task, null, 'preparation is not a fictitious running task')
    const blocked = await host.post('answer-graph', { documentId, question: 'Alpha?' })
    assert.equal(blocked.response.error?.code, 'busy')
    ready.resolve({ ...store, getDocument() { throw Error('fixture storage read failure') } })
    const result = await preparing
    assert.equal(result.status, 500)
    assert.match(result.response.error.message, /storage read failure/)
    assert.equal(host.tasks.size, 0)
    assert.equal(host.activeTaskStatusHost().busy, false, 'a failed preparation must not leave a permanent busy state')
  } finally { host.close() }
})

await check('overlapping persistent admissions start exactly one task', async () => {
  const host = await bind('persistent'), ready = deferred(), finished = deferred()
  let runs = 0
  try {
    host.setStore(ready.promise)
    host.setRunner(async task => { runs++; await finished.promise; task.status = 'succeeded' })
    const input = { documentId, question: 'Alpha?' }
    const first = host.post('answer-graph', input), second = host.post('answer-graph', input)
    ready.resolve(store)
    const responses = (await Promise.all([first, second])).map(result => result.response)
    await tick()
    assert.equal(responses.filter(result => result.taskId).length, 1, 'awaiting the store must not admit both requests')
    assert.equal(responses.filter(result => result.error?.code === 'busy').length, 1)
    assert.equal(runs, 1)
    assert.equal(host.tasks.size, 1, 'a rejected request must not create an orphan task')
    const winner = responses.find(result => result.taskId)
    assert.equal(host.activeTaskStatusHost().task.taskId, winner.taskId)
  } finally { finished.resolve(); await tick(); host.close() }
  assert.equal(host.activeTaskStatusHost().busy, false)
})

for (const kind of ['dynamic', 'persistent']) {
  await check(kind + ' unexpected task errors release all runtime ownership', async () => {
    const host = await bind(kind)
    const logged = [], originalError = console.error
    console.error = (...args) => logged.push(args)
    try {
      host.setRunner(task => {
        task.cancelHooks = [() => {}]
        task.persistPostprocess = () => {}
        task.persistRelationWeave = () => {}
        throw Error('fixture task failure')
      })
      const started = await host.post('extract', { text: 'New source.' })
      assert(started.response.taskId)
      await tick()
      const task = host.tasks.get(started.response.taskId)
      assert.equal(task.status, 'failed')
      assert.equal(host.activeTaskStatusHost().busy, false)
      assert.equal(host.activeTaskStatusHost().task, null)
      assert.equal(task.cancelHooks.length, 0)
      assert.equal(task.persistPostprocess, null)
      assert.equal(task.persistRelationWeave, null)
      assert(logged.some(args => args.some(value => value?.message === 'fixture task failure')))
      host.setRunner(async next => { next.status = 'succeeded' })
      assert((await host.post('extract', { text: 'Retry source.' })).response.taskId)
      await tick()
    } finally { console.error = originalError; host.close() }
  })

  await check(kind + ' relation settings survive transport and reject ontology conflicts', async () => {
    const host = await bind(kind)
    let runs = 0
    host.setRunner(async task => { runs++; task.status = 'succeeded' })
    try {
      for (const concurrency of [1, 2, 4, undefined, 3]) {
        const result = await host.post('relation-retry', { documentId, expectedRevision: 1, concurrency })
        assert(result.response.taskId)
        const task = host.tasks.get(result.response.taskId)
        assert.equal(task.concurrency, [1, 2, 4].includes(concurrency) ? concurrency : 2)
        assert.equal(task.ontology, graph.ontology)
        await tick()
      }
      const before = runs
      const conflict = await host.post('relation-retry', { documentId, expectedRevision: 1, ontology: 'proposition-v1' })
      assert.equal(conflict.response.error?.code, 'ontology_conflict')
      await tick()
      assert.equal(runs, before, 'a conflicting ontology must never reach the model')
      assert.equal(host.activeTaskStatusHost().busy, false)
    } finally { await tick(); host.close() }
  })

  await check(kind + ' extraction validates once and preserves document/checkpoint ontology', async () => {
    const host = await bind(kind)
    let runs = 0
    host.setRunner(async task => { runs++; task.status = 'succeeded' })
    try {
      const base = { version: 2, documentId, baseRevision: 1, ontology: graph.ontology, graph: { nodes: [], edges: [] } }
      for (const [checkpoint, code] of [
        [{ ...base, baseRevision: undefined }, 'checkpoint_invalid'],
        [{ ...base, documentId: 'wrong' }, 'checkpoint_invalid'],
        [{ ...base, baseRevision: 0 }, 'revision_conflict'],
        [{ ...base, ontology: 'proposition-v1' }, 'ontology_conflict'],
      ]) {
        const rejected = await host.post('extract', { documentId, text: graph.sourceText, checkpoint })
        assert.equal(rejected.response.error?.code, code)
        assert.equal(host.activeTaskStatusHost().busy, false)
        assert.equal(runs, 0)
      }
      const conflict = await host.post('extract', { documentId, text: graph.sourceText, ontology: 'proposition-v1' })
      assert.equal(conflict.response.error?.code, 'ontology_conflict')
      assert.equal(runs, 0)
      const resumed = await host.post('extract', { text: graph.sourceText, checkpoint: base })
      assert(resumed.response.taskId)
      assert.equal(host.tasks.get(resumed.response.taskId).ontology, graph.ontology)
      await tick()
      const rejectedResume = await host.post('extract', { text: graph.sourceText, checkpoint: base, ontology: 'proposition-v1' })
      assert.equal(rejectedResume.response.error?.code, 'ontology_conflict')
      assert.equal(host.activeTaskStatusHost().busy, false)
    } finally { await tick(); host.close() }
  })

  await check(kind + ' trajectory creation and append preserve ontology', async () => {
    const host = await bind(kind)
    host.setRunner(async task => { task.status = 'succeeded' })
    try {
      const created = await host.post('trajectory-extract', { sessionId: 'session', ontology: graph.ontology })
      assert(created.response.taskId)
      assert.equal(host.tasks.get(created.response.taskId).ontology, graph.ontology)
      await tick()
      const input = { sessionId: 'session', documentId, expectedRevision: 1 }
      const conflict = await host.post('trajectory-append-extract', { ...input, ontology: 'proposition-v1' })
      assert.equal(conflict.response.error?.code, 'ontology_conflict')
      assert.equal(host.activeTaskStatusHost().busy, false)
      const appended = await host.post('trajectory-append-extract', input)
      assert(appended.response.taskId)
      assert.equal(host.tasks.get(appended.response.taskId).ontology, graph.ontology)
    } finally { await tick(); host.close() }
  })
}

assert.deepEqual(failures, [], 'task admission regressions')
