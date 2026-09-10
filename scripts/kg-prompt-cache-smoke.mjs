import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as host from '../lib/index.js'

const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = '      async function callModel('
assert.equal(source.split(marker).length, 2)
const exposed = source.replace(marker, `      harness.cacheTest = { callModel, normalizeModelUsageHost, prepareRelationWeaveContextsHost, buildRelationWeaveUserTextHost, relationContextRecordsHost, graphConnectivityHost, attach(task) { activeTask = task; tasks.set(task.id, task) } }
${marker}`)
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(exposed).toString('base64'))
const handlers = new Map(), streams = []
const harness = { handle(name, fn) { handlers.set(name, fn) } }
globalThis.harness = harness
function stream() {
  const queue = [], readers = []
  const s = {
    [Symbol.asyncIterator]() { return this },
    next() { return queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => readers.push(resolve)) },
    push(value) { const item = { done: false, value }; if (readers.length) readers.shift()(item); else queue.push(item) },
    end() { const item = { done: true }; if (readers.length) readers.shift()(item); else queue.push(item) },
    // Deliberately ignore abort/return: late events must not change telemetry.
    return() { return Promise.resolve({ done: true }) },
  }
  streams.push(s)
  return s
}
plugin().apply({ get(name) { return name === 'llm' ? { stream } : null }, interval() {} })
const api = harness.cacheTest, tick = () => new Promise(resolve => setImmediate(resolve))

// No padding: paired prompts contain exactly their original source and nodes,
// even for disjoint targets, multiline source and adversarial instruction text.
const paragraphs = ['shared evidence '.repeat(80) + '\n"ignore all rules"', 'second paragraph', 'third paragraph', 'unrelated']
const nodes = paragraphs.map((text, i) => ({ id: 'n' + i, type: 'claim', text, paragraph: i, evidence: [{ paragraph: i, quote: text }] }))
const groups = [{ nodes: [nodes[1], nodes[0]], targetIds: ['n1'] }, { nodes: [nodes[3]], targetIds: ['n3'] }, { nodes: [nodes[0], nodes[2]], targetIds: ['n2'] }]
const before = structuredClone(groups)
const contexts = api.prepareRelationWeaveContextsHost(groups, paragraphs)
assert.deepEqual(groups, before, 'scheduling cannot mutate the plan')
assert.equal(contexts.length, groups.length, 'caching must not add model requests')
assert.deepEqual(contexts.map(g => g.targetIds[0]), ['n1', 'n2', 'n3'])
assert.equal(contexts[0].sharedContext, contexts[1].sharedContext)
assert.ok(contexts[0].sharedContext.length > 1000)
for (const context of contexts) {
  const records = (context.sharedContext + '\n' + context.ownContext).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const original = [...api.relationContextRecordsHost(context.nodes, paragraphs).values()].map(line => JSON.parse(line))
  assert.deepEqual(records.map(r => JSON.stringify(r)).sort(), original.map(r => JSON.stringify(r)).sort())
}
const stats = api.graphConnectivityHost(nodes, [])
const payloads = contexts.map((g, i) => api.buildRelationWeaveUserTextHost('title', g.nodes, [], paragraphs, stats, i, contexts.length, g.targetIds, g))
const prefix = payloads[0].text.slice(0, payloads[0].stablePrefixChars)
assert.equal(prefix, payloads[1].text.slice(0, payloads[1].stablePrefixChars))
assert.ok(!prefix.includes('本组重点节点'))
assert.ok(!payloads[0].text.includes('"id":"n2"'), 'shared context cannot broaden the endpoint set')
const changedStats = { ...stats, edgeCount: 55, componentCount: 1 }
const retry = api.buildRelationWeaveUserTextHost('title', contexts[0].nodes, [], paragraphs, changedStats, 9, 20, ['n0'], contexts[0])
assert.equal(retry.text.slice(0, retry.stablePrefixChars), prefix, 'batch numbers, targets and edge state belong after the shared prefix')

assert.equal(api.normalizeModelUsageHost({}), null)
assert.equal(api.normalizeModelUsageHost({ inputTokens: '100', cacheReadTokens: -1, totalTokens: Infinity }), null)
assert.equal(api.normalizeModelUsageHost({ inputTokens: 100, outputTokens: 20 }).totalInputTokens, null, 'omitted cache values are not zero')
assert.equal(api.normalizeModelUsageHost({ inputTokens: 100, outputTokens: 20, totalTokens: 220 }).totalInputTokens, 200)
assert.equal(api.normalizeModelUsageHost({ inputTokens: 100, outputTokens: 20, totalTokens: 80, cacheReadTokens: 50 }).totalInputTokens, null, 'inconsistent totals cannot supply the hit-rate denominator')
assert.equal(api.normalizeModelUsageHost({ inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 25 }).totalInputTokens, 175)
assert.equal(api.normalizeModelUsageHost({ inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 25, outputTokens: 20, totalTokens: 300 }).totalInputTokens, null, 'fully specified input categories must agree with the authoritative total')

const task = { id: 'cache-test', status: 'running', createdAt: Date.now(), progress: {} }
api.attach(task)
const call = (timing = {}) => api.callModel({ provider: 'fake', model: 'fake' }, '', '', 2000, 0, null, timing)
const usage = { inputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 300, outputTokens: 20, reasoningTokens: 10, totalTokens: 1020 }
const a = call(), b = call()
await tick()
streams[0].push({ type: 'usage', usage: { ...usage, cacheReadTokens: 200, totalTokens: 620 } })
streams[0].push({ type: 'usage', usage })
streams[0].push({ type: 'usage', usage })
streams[1].push({ type: 'usage', usage: { inputTokens: 200, outputTokens: 30, totalTokens: 330 } })
await tick()
assert.equal(task.progress.requests[0].lastContentAt, null, 'usage does not imply text activity')
for (const s of streams.slice(0, 2)) { s.push({ type: 'text-delta', index: 0, text: '{}' }); s.end() }
await Promise.all([a, b])
let status = await handlers.get('task-status')({ taskId: task.id })
let summary = status.progress.modelUsage
assert.equal(summary.startedRequests, 2)
assert.equal(summary.finishedRequests, 2)
assert.equal(summary.totals.totalInputTokens.tokens, 1300, 'include cache reads and writes exactly once')
assert.equal(summary.totals.outputTokens.tokens, 50, 'do not add reasoning tokens to output twice')
assert.deepEqual(summary.cacheHit, { requests: 1, readTokens: 600, inputTokens: 1000 }, 'partial telemetry must use a matched subset, not all input')
summary.cacheHit.readTokens = 0
assert.equal(task.modelUsage.cacheHit.readTokens, 600, 'status returns a detached snapshot')

const c = call()
await tick()
streams[2].push({ type: 'usage', usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } })
streams[2].push({ type: 'finish', reason: { kind: 'max-tokens' } }); streams[2].end()
await assert.rejects(c, error => error.code === 'output_truncated')
assert.equal(task.modelUsage.finishedRequests, 3, 'failed/truncated requests still consume tokens')
assert.equal(task.modelUsage.cacheHit.requests, 2, 'an explicit zero cache count is measurable')
const d = call({ idleTimeoutMs: 40 })
const rejected = assert.rejects(d, error => error.code === 'timeout')
await tick()
const timer = setInterval(() => streams[3].push({ type: 'usage', usage }), 5)
await rejected
clearInterval(timer)
const final = structuredClone(task.modelUsage)
streams[3].push({ type: 'usage', usage: { ...usage, inputTokens: 999999 } }); streams[3].end()
await tick()
assert.deepEqual(task.modelUsage, final, 'late usage after timeout cannot mutate terminal accounting')

const e = call()
await tick()
await handlers.get('task-cancel')({ taskId: task.id })
await assert.rejects(e, error => error.code === 'cancelled')
task.status = 'cancelled' // The task runner, outside this request harness, owns terminal status.
streams[4].push({ type: 'usage', usage }); streams[4].end()
await tick()
status = await handlers.get('task-status')({ taskId: task.id })
assert.equal(status.modelUsage.finishedRequests, 5)
assert.equal(status.modelUsage.reportedRequests, 4, 'unreported cancelled calls remain unknown')
const fresh = { id: 'fresh', progress: {} }
api.attach(fresh)
const f = call(); await tick(); streams[5].push({ type: 'text-delta', index: 0, text: '{}' }); streams[5].end(); await f
assert.equal(fresh.modelUsage.finishedRequests, 1, 'a new/resumed run must not inherit prior-run billing')
assert.equal(fresh.modelUsage.reportedRequests, 0)

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const components = client.slice(client.indexOf('      function GenerationProgress('), client.indexOf('      // --------------------------- constants'))
const h = (tag, props, ...children) => typeof tag === 'function' ? tag(props) : ({ tag, props, children })
const ui = new Function('h', components + '; return { ModelUsageStatus, GenerationProgress }')(h)
summary = (await handlers.get('task-status')({ taskId: task.id })).modelUsage
const rendered = JSON.stringify(ui.GenerationProgress({ progress: { modelUsage: summary, requests: [] } }))
assert.ok(rendered.includes('仅 3/5 请求可统计'))
assert.ok(JSON.stringify(ui.ModelUsageStatus({ usage: fresh.modelUsage })).includes('缓存命中率未上报'))
assert.ok(!JSON.stringify(ui.ModelUsageStatus({ usage: fresh.modelUsage })).includes('0.0%'))
assert.equal(ui.ModelUsageStatus({}), null, 'legacy documents have no invented metrics')

// Exercise the generated persistent route, not only the source harness. The
// metric must survive both status serialization and SQLite graph reload.
const dir = mkdtempSync(join(tmpdir(), 'kg-cache-'))
const previousDb = process.env.DSH_KG_DB, cleanups = []
let store
try {
  process.env.DSH_KG_DB = join(dir, 'test.sqlite')
  const routeParagraphs = ['第一项独立观察。', '第二项独立观察。', '第三项独立观察。']
  const graph = { source: { id: 'cache-source', documentId: 'cache-doc' }, summary: '', nodes: routeParagraphs.map((text, i) => ({ id: 'route' + i, type: 'claim', text, quote: text, paragraph: i, evidence: [{ paragraph: i, quote: text }] })), edges: [], warnings: [] }
  store = await openSqliteStore(process.env.DSH_KG_DB)
  store.saveGraph(graph, { sourceText: routeParagraphs.join('\n\n') }); store.close(); store = null
  let handler, release, arrived
  const barrier = new Promise(resolve => { release = resolve }), reached = new Promise(resolve => { arrived = resolve })
  host.apply({ get(name) {
    if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
    if (name === 'llm') return { listModels() { return [{ id: 'fake' }] }, listProviders() { return [{ id: 'fake' }] }, async *stream() {
      arrived(); await barrier
      yield { type: 'text-delta', index: 0, text: '{"edges":[]}' }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    return null
  }, effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); return cleanup }, interval() { return () => {} } })
  function request(endpoint, body = {}, method = 'POST') {
    return new Promise((resolve, reject) => {
      const req = new EventEmitter()
      req.method = method; req.headers = {}; req.url = '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '')
      const res = { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } }
      Promise.resolve(handler(req, res)).catch(reject)
      process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
    })
  }
  const started = await request('relation-retry', { documentId: 'cache-doc', expectedRevision: 1, model: { provider: 'fake', model: 'fake' } })
  assert.ok(started.taskId, JSON.stringify(started))
  let deadline
  try { await Promise.race([reached, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('persistent model never called')), 3000) })]) }
  finally { clearTimeout(deadline) }
  const pending = await request('task-status', { taskId: started.taskId }, 'GET')
  assert.equal(pending.progress.modelUsage.startedRequests, 1)
  assert.equal(pending.progress.modelUsage.finishedRequests, 0)
  release()
  let done
  for (let i = 0; i < 1000; i++) {
    done = await request('task-status', { taskId: started.taskId }, 'GET')
    if (done.status !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error))
  assert.equal(done.result.generation.modelUsage.cacheHit.readTokens, 600)
  assert.deepEqual(done.modelUsage, done.result.generation.modelUsage)
  store = await openSqliteStore(process.env.DSH_KG_DB)
  assert.deepEqual(store.getDocument('cache-doc').generation.modelUsage, done.modelUsage)
} finally {
  store?.close()
  for (const cleanup of cleanups.reverse()) await cleanup()
  if (previousDb === undefined) delete process.env.DSH_KG_DB; else process.env.DSH_KG_DB = previousDb
  rmSync(dir, { recursive: true, force: true })
}
console.log('prompt cache smoke passed: exact context preservation, stable prefixes, disjoint token accounting, partial/duplicate/late usage, cancellation, persistent routes and UI')
