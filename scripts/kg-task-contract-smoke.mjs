import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'

const marker = '      function failTask('
const dynamicSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const persistentSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  .replace("from './kg-store.mjs'", 'from ' + JSON.stringify(new URL('../lib/kg-store.mjs', import.meta.url).href))
const bindings = []
for (const [kind, source] of [['dynamic', dynamicSource], ['persistent', persistentSource]]) {
  assert(source.includes(marker))
  const expose = '      ctx.taskTest = { tasks, seedExplicitRelationEdgesHost' +
    (kind === 'persistent' ? ', setStore(store) { sqliteStorePromise = Promise.resolve(store) }' : '') + ' };\n'
  const module = await import('data:text/javascript;base64,' + Buffer.from(source.replace(marker, expose + marker)).toString('base64'))
  const handlers = new Map(), cleanups = []
  let http
  globalThis.harness = { handle(name, fn) { handlers.set(name, fn) } }
  const ctx = { get(name) {
    return name === 'webServer' ? { register(route) { if (route.path === '/api/dsh-knowledge-graph') http = route.handler; return () => {} } } : null
  }, interval() {}, effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) } }
  if (kind === 'dynamic') module.default().apply(ctx)
  else module.apply(ctx)
  bindings.push({ kind, ...ctx.taskTest, close() { cleanups.reverse().forEach(fn => fn()) },
    async post(endpoint, body) {
      const req = new EventEmitter()
      req.method = 'POST'; req.url = '/api/dsh-knowledge-graph/' + endpoint; req.headers = {}
      let response, status
      const pending = http(req, { setHeader() {}, writeHead(code) { status = code }, end(data) { response = JSON.parse(data) } })
      req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end')
      await pending
      return { status, response }
    },
    async status(name, taskId, includeCheckpoint) {
      if (kind === 'dynamic') return handlers.get(name)({ taskId, includeCheckpoint })
      const url = '/api/dsh-knowledge-graph/' + name + '?' + new URLSearchParams({ taskId, includeCheckpoint: includeCheckpoint ? '1' : '0' })
      let response
      await http({ method: 'GET', url, headers: {} }, { setHeader() {}, writeHead() {}, end(data) { response = JSON.parse(data) } })
      return response
    },
  })
}

try {
  const task = { id: 'fixture', status: 'running', createdAt: Date.now() - 1000,
    text: 'PRIVATE SOURCE', checkpoint: { nextBatchIndex: 5, secret: 'PRIVATE CHECKPOINT' },
    progress: { stage: 'fixture', parallel: { completed: 2 }, discovery: { savedGroups: 3 }, completion: { savedCycles: 1 },
      requests: [{ stage: 'weave', outputChars: 123 }], lastRequest: { stage: 'extract', outputChars: 456 } } }
  const stable = result => {
    const snapshot = JSON.parse(JSON.stringify(result))
    if (snapshot.progress) { delete snapshot.progress.sampledAt; delete snapshot.progress.elapsedMs }
    return snapshot
  }
  for (const state of ['running', 'failed', 'cancelled', 'succeeded', 'not_found']) {
    task.status = state; task.errorCode = 'fixture'; task.errorMessage = 'fixture error'; task.result = { summary: 'final graph' }
    for (const host of bindings) { host.tasks.clear(); if (state !== 'not_found') host.tasks.set(task.id, task) }
    for (const include of [false, true]) {
      const responses = []
      for (const host of bindings) for (const name of ['task-status', 'trajectory-status']) {
        const result = await host.status(name, task.id, include)
        assert.equal(result.status, state)
        if (!include) assert(!JSON.stringify(result).includes('PRIVATE'), 'normal polling must not expose source or checkpoint')
        if (state === 'running') {
          assert.deepEqual(result.progress.parallel, task.progress.parallel)
          assert.deepEqual(result.progress.completion, task.progress.completion)
          assert.deepEqual(result.progress.discovery, task.progress.discovery)
          assert.deepEqual(result.progress.checkpoint, include ? task.checkpoint : null)
        } else if (include && ['failed', 'cancelled'].includes(state)) assert.deepEqual(result.checkpoint, task.checkpoint)
        responses.push(stable(result))
      }
      for (const response of responses.slice(1)) assert.deepEqual(response, responses[0], 'RPC and HTTP aliases must share one status contract')
    }
  }
  const seed = bindings[0].seedExplicitRelationEdgesHost
  let reads = 0
  const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: 'n' + i, type: 'claim', text: 'one',
    get paragraph() { reads++; return i } }))
  const acc = { nodes: new Map(nodes.map(node => [node.id, node])), edges: [], edgeKeys: new Set(), warnings: [] }
  assert.equal(seed(acc, nodes.map(() => 'one')), 0)
  assert(reads <= nodes.length * 8, 'disjoint paragraphs must require linear work, not all-pairs scanning: ' + reads)

  // Interleaved paragraphs exercise stable edge ordering under the seed cap.
  const paragraphs = Array.from({ length: 20 }, (_, i) => '原因' + i + '因此结果' + i)
  const causes = paragraphs.map((text, i) => ({ id: 'a' + i, type: 'fact', text: '原因' + i, quote: '原因' + i, paragraph: i }))
  const effects = paragraphs.map((text, i) => ({ id: 'b' + i, type: 'inference', text: '结果' + i, quote: '结果' + i, paragraph: i }))
  for (const node of [...causes, ...effects]) node.evidence = [{ paragraph: node.paragraph, quote: node.quote, sourceId: 's', chunkId: 'c' }]
  const mixed = { nodes: new Map([...causes, ...effects].map(node => [node.id, node])), edges: [], edgeKeys: new Set(), warnings: [] }
  assert.equal(seed(mixed, paragraphs), 16)
  assert.deepEqual(mixed.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation), Array.from({ length: 16 }, (_, i) => 'a' + i + '>b' + i + ':infers'))
  assert.equal(seed(mixed, paragraphs), 4, 'existing pairs cannot be reseeded')
  assert.equal(seed(mixed, paragraphs), 0)
  const persistent = bindings.find(host => host.kind === 'persistent')
  persistent.setStore({ getDocument() { throw Error('fixture storage read failure') } })
  for (const endpoint of ['relation-retry', 'append-extract']) {
    const result = await persistent.post(endpoint, { documentId: 'existing-document', expectedRevision: 1,
      text: 'new text', existing: { nodes: [{ id: 'stale-browser-node', text: 'stale' }], edges: [] } })
    assert.equal(result.status, 500, 'storage failures must not become missing documents or client fallback')
    assert.equal(result.response.error.code, 'internal')
    assert.match(result.response.error.message, /storage read failure/)
    assert.equal(persistent.tasks.size, 0, 'storage failures cannot start a task against a stale browser graph')
  }
  console.log(JSON.stringify({ statusContractParity: true, checkpointOptIn: true, trajectoryProgressFields: true,
    disjointParagraphReads: reads, stableSeedOrderAndCap: true, storageFailuresStayErrors: true }))
} finally {
  for (const host of bindings) host.close()
  delete globalThis.harness
}
