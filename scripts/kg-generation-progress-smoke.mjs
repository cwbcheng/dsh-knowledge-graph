import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Expose the real request runner in an isolated plugin, without invoking a provider.
const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = '      async function callModel('
assert.equal(source.split(marker).length, 2)
const instrumented = source.replace(marker, `      harness.progressTest = { callModel, attach(task) { activeTask = task; tasks.set(task.id, task) } }
${marker}`)
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))
const handlers = new Map()
const harness = { handle(name, fn) { handlers.set(name, fn) } }
globalThis.harness = harness
const streams = []
plugin().apply({ get(name) { return name === 'llm' ? { stream() {
  const queue = [], readers = []
  const stream = {
    [Symbol.asyncIterator]() { return this },
    next() { return queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => readers.push(resolve)) },
    push(value) { const item = { done: false, value }; if (readers.length) readers.shift()(item); else queue.push(item) },
    return() { while (readers.length) readers.shift()({ done: true }); return Promise.resolve({ done: true }) },
  }
  streams.push(stream)
  return stream
} } : null }, interval() {} })
const task = { id: 'progress-test', status: 'running', createdAt: Date.now() - 46 * 60000, progress: { charsReceived: 3833, batch: { index: 203, total: 203 } }, checkpoint: { nextBatchIndex: 203 } }
harness.progressTest.attach(task)
const tick = () => new Promise(resolve => setImmediate(resolve))
const status = () => handlers.get('task-status')({ taskId: task.id })
task.progress.discovery = { totalTargets: 137, searchedTargets: 48, remainingTargets: 89, pass: 1 }
assert.deepEqual((await status()).progress.discovery, task.progress.discovery, 'dynamic task status must serialize discovery progress')
const call = stage => harness.progressTest.callModel({ provider: 'fake', model: 'fake' }, '', '', 1000, 0.1, null, { stage })
const a = call('关系补全（第 1/54 组）')
await tick()
let p = (await status()).progress
assert.equal(p.requests.length, 1)
assert.equal(p.requests[0].outputChars, 0)
assert.equal(p.requests[0].lastContentAt, null)
assert.equal(p.charsReceived, 0, 'previous request count must not survive startup')
assert.equal(p.completedBatches, 203)
assert.ok(p.elapsedMs >= 46 * 60000)
assert.ok(p.sampledAt - p.requests[0].startedAt < 1000, 'request time must not use task age')
streams[0].push({ type: 'text-delta', index: 0, text: '' })
streams[0].push({ type: 'reasoning-delta', index: 0 })
await tick()
assert.equal((await status()).progress.requests[0].lastContentAt, null, 'empty events are not activity')
streams[0].push({ type: 'reasoning-delta', index: 0, text: 'private reasoning' })
await tick()
p = (await status()).progress
assert.equal(p.requests[0].reasoningChars, 17)
assert.equal(p.requests[0].state, '模型思考中')
assert.ok(!JSON.stringify(p).includes('private reasoning'), 'status must not expose model contents')
const lastContentAt = p.requests[0].lastContentAt
const b = call('关系语义审校（第 1–20/80 条）')
await tick()
assert.equal((await status()).progress.requests.length, 2)
streams[1].push({ type: 'text-delta', index: 0, text: '{}' })
streams[0].push({ type: 'ping' })
await tick()
p = (await status()).progress
assert.equal(p.requests[0].lastContentAt, lastContentAt)
assert.equal(p.requests[0].outputChars, 0)
assert.equal(p.requests[1].outputChars, 2)
assert.ok(p.requests[0].stage.includes('1/54'))
assert.ok(p.requests[1].stage.includes('1–20/80'))
assert.equal(p.charsReceived, 19)
streams[0].push({ type: 'text-delta', index: 0, text: '{}' })
await tick()
await streams[0].return()
await a
assert.equal((await status()).progress.requests.length, 1, 'one completion must not clear siblings')
await streams[1].return()
await b
assert.equal((await status()).progress.requests.length, 0)
assert.equal((await status()).progress.lastRequest.state, '已完成')
const c = call('摘要汇总')
await tick()
await handlers.get('task-cancel')({ taskId: task.id })
await assert.rejects(c, error => error.code === 'cancelled')
assert.equal(task.progress.requests.length, 0, 'cancellation must remove active requests')

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const component = client.slice(client.indexOf('      function GenerationProgress('), client.indexOf('      // --------------------------- constants'))
const h = (tag, props, ...children) => ({ tag, props, children })
const render = new Function('h', component + '; return GenerationProgress')(h)
const htmlTree = JSON.stringify(render({ progress: p }))
assert.ok(htmlTree.includes('尚未完成'))
assert.ok(htmlTree.includes('当前请求'))
assert.ok(htmlTree.includes('距最近内容'))
assert.ok(htmlTree.includes('progress'))
assert.ok(JSON.stringify(render({ progress: { ...p, review: { eligible: 2955, reviewed: 2907, pending: 48, reused: 2907 } } })).includes('关系已审校 2907/2955 · 待审 48 · 已复用 2907'))
assert.ok(JSON.stringify(render({ progress: { stage: '等待首字', batch: { index: 203, total: 203 } } })).includes('旧版服务未提供请求级进度'))
console.log('generation progress smoke passed: isolated counters, phases, empty events, completion, cancellation, UI fallback')
