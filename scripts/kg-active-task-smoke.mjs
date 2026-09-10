import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = '      function failTask('
const instrumented = source.replace(marker, `      harness.taskTest = { set(items, owner, locked) { tasks.clear(); for (const item of items) tasks.set(item.id, item); activeTask = owner; busy = locked }, activeTaskStatusHost, busyTaskResponseHost }
${marker}`)
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))
const handlers = new Map(), harness = { handle(name, fn) { handlers.set(name, fn) } }
globalThis.harness = harness
plugin().apply({ get() { return null }, interval() {} })
const api = harness.taskTest
const running = { id: 'task-running', kind: 'relation-retry', title: 'book', documentId: 'document-b', status: 'running', text: 'private source', graph: { nodes: [{ text: 'private node' }] }, checkpoint: { graph: { secret: true } }, createdAt: Date.now() - 10000, progress: { stage: '关系检索 2/4', discovery: { searchedTargets: 12, totalTargets: 140, remainingTargets: 128, pass: 1 }, requests: [] } }
const old = { id: 'old', status: 'succeeded', progress: {} }
api.set([old, running], old, true)
let response = await handlers.get('task-active')({})
assert.equal(response.task.taskId, running.id, 'ignore a stale activeTask pointer and find the real running owner')
assert.equal(response.task.documentId, 'document-b', 'do not infer document ownership from the viewing tab')
assert.ok(!JSON.stringify(response).includes('private'))
assert.ok(!Object.hasOwn(response.task, 'checkpoint'))
assert.equal(api.busyTaskResponseHost().error.activeTask.taskId, running.id)
const answer = { ...running, kind: 'answer' }
api.set([answer], answer, true)
assert.equal(api.activeTaskStatusHost().task.label, '知识图答疑')
api.set([old], old, true)
assert.deepEqual(api.activeTaskStatusHost(), { busy: true, task: null, trackedTask: null }, 'admission without an id is not a phantom old task')
assert.equal(api.busyTaskResponseHost().error.activeTask, null)
api.set([old], old, false)
assert.equal(api.activeTaskStatusHost({ taskId: 'old' }).trackedTask.status, 'succeeded')
assert.equal(api.activeTaskStatusHost({ taskId: 'missing' }).trackedTask, null)
const failed = { ...running, status: 'failed', finishedAt: Date.now(), errorCode: 'timeout', errorMessage: 'provider timeout' }
api.set([failed], null, false)
assert.equal(api.activeTaskStatusHost({ taskId: failed.id }).trackedTask.error.code, 'timeout')

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const components = client.slice(client.indexOf('      function GenerationProgress('), client.indexOf('      // --------------------------- constants'))
const flush = () => new Promise(resolve => setImmediate(resolve))
// Execute the real component/effect, with a tiny deterministic hook scheduler.
// It never exposes a model-start or cancel transport to the component.
function mount(transport, initialProps = {}) {
  const state = [], refs = [], effects = [], queue = new Set()
  let si = 0, ri = 0, ei = 0, pendingEffects = [], props = initialProps
  const host = { call(name, args) { assert.equal(name, 'task-active', 'discovery cannot submit or cancel work'); return transport(args) } }
  const ctx = { timeout(fn, delay) { assert.ok(delay >= 3000 && delay <= 30000); queue.add(fn); return () => queue.delete(fn) } }
  const useState = initial => { const index = si++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }] }
  const useRef = initial => { const index = ri++; return refs[index] ||= { current: initial } }
  const useEffect = (fn, deps) => {
    const index = ei++, prior = effects[index]
    if (!prior || deps.some((value, i) => value !== prior.deps[i])) pendingEffects.push(() => { prior?.cleanup?.(); effects[index] = { deps, cleanup: fn() } })
  }
  const h = (tag, attrs, ...children) => typeof tag === 'function' ? tag(attrs) : { tag, attrs, children }
  const renderComponent = new Function('h', 'host', 'useState', 'useRef', 'useEffect', components + '; return BackgroundTaskProgress')(h, host, useState, useRef, useEffect)
  return {
    render(next = props) { props = next; si = ri = ei = 0; pendingEffects = []; const tree = renderComponent({ ctx, ...props }); for (const effect of pendingEffects) effect(); return tree },
    async tick() { assert.equal(queue.size, 1); const [fn] = queue; queue.delete(fn); await fn() },
    close() { for (const effect of effects) effect.cleanup?.() }, queue, state,
  }
}
api.set([running], running, true)
let current = api.activeTaskStatusHost(), calls = 0
const ui = mount(async () => { calls++; return current })
assert.equal(ui.render(), null)
await flush()
let tree = JSON.stringify(ui.render())
assert.ok(tree.includes('关系检索 · 进行中'))
assert.ok(tree.includes('12/140'))
assert.ok(tree.includes('task-running'))
assert.ok(!tree.includes('查看更新后的知识图'), 'cannot open a future result while still running')
current = { busy: false, task: null, trackedTask: { ...current.task, status: 'succeeded' } }
await ui.tick()
tree = JSON.stringify(ui.render({ onOpenDocument() {} }))
assert.ok(tree.includes('已完成'))
assert.ok(tree.includes('查看更新后的知识图'))
current = { busy: false, task: null, trackedTask: null }
await ui.tick()
assert.ok(JSON.stringify(ui.render()).includes('已断开'), 'host restart cannot leave a stale running spinner')
ui.close(); assert.equal(ui.queue.size, 0)

// Reopening with empty browser state discovers the same owner; known local
// progress is not rendered twice. Read failures retain the last observation.
current = api.activeTaskStatusHost()
const reopened = mount(async () => current, { knownTaskIds: ['task-running'] })
reopened.render(); await flush(); assert.equal(reopened.render(), null)
reopened.close()
const lost = mount(async () => { throw new TypeError('Failed to fetch') }, { busyError: { code: 'busy', activeTask: current.task } })
lost.render(); await flush()
assert.ok(JSON.stringify(lost.render()).includes('正在重连'))
lost.close(); assert.equal(lost.queue.size, 0)
let release
const late = mount(() => new Promise(resolve => { release = resolve }))
late.render(); late.close(); release(current); await flush()
assert.equal(late.state[0], null); assert.equal(late.queue.size, 0, 'unmounted discovery cannot publish or schedule late responses')

// Pending references are small and task-owned, not a second copy of the book.
const saved = new Map()
const localStorage = { getItem(key) { return saved.get(key) || null }, setItem(key, value) { saved.set(key, value) }, removeItem(key) { saved.delete(key) } }
const storage = new Function('localStorage', 'LS_PENDING', components + '; return { rememberPendingTask, forgetPendingTask }')(localStorage, 'pending')
storage.rememberPendingTask('relation-1', { documentId: 'doc', title: 'book', relationRetry: true, text: 'must not persist full source' })
assert.deepEqual(Object.keys(JSON.parse(saved.get('pending'))).sort(), ['append', 'documentId', 'relationRetry', 'taskId', 'title', 'ts'])
assert.equal(JSON.parse(saved.get('pending')).relationRetry, true)
storage.forgetPendingTask('another-tab-task')
assert.ok(saved.has('pending'), 'one tab cannot clear a different pending task')
storage.forgetPendingTask('relation-1'); assert.equal(saved.size, 0)

// Exercise the actual submission path twice before React can re-render.
const retryStart = client.indexOf('        const retryRelations = async () => {')
const retryEnd = client.indexOf('        // Detect a mouse/keyboard text selection', retryStart)
const script = client.slice(retryStart, retryEnd)
const values = { resultView: { graph: { source: { documentId: 'doc', revision: 1 } } }, documentIdOfGraph: () => 'doc', cancelVerifyTasks() {}, setError() {}, effectiveModelArg: null, graphRevisionRef: { current: 1 }, submittedRef: { current: null }, submissionBusyRef: { current: false }, resumeAttemptRef: { current: false }, setExtractProgress() {}, setPhase() {}, setSelectedNodeId() {}, setSelectedEdgeId() {}, setActivePara() {}, setTaskId() {}, taskId: null, phase: 'done', title: 'book', fullText: 'source', rememberPendingTask: storage.rememberPendingTask, host: { call(name) { assert.equal(name, 'relation-retry'); calls++; return new Promise(resolve => { release = resolve }) } } }
const retry = new Function(...Object.keys(values), script + '; return retryRelations')(...Object.values(values))
calls = 0
const first = retry(), second = retry()
assert.equal(calls, 1, 'double click must not submit a second task or let a busy error hide the first progress')
release({ taskId: 'relation-accepted' }); await first; await second
assert.equal(JSON.parse(saved.get('pending')).taskId, 'relation-accepted')
assert.equal(values.submissionBusyRef.current, false)
assert.equal(values.resumeAttemptRef.current, false)

const resumeStart = client.indexOf('         const resumeLostTask = async () => {')
const resumeEnd = client.indexOf('// ---- adaptive-backoff polling while a task runs ----', resumeStart)
const resumeValues = { resumeAttemptRef: { current: false }, localStorage, LS_PENDING: 'pending', loadHistoryEntry: async entry => { assert.equal(entry.documentId, 'doc') }, setError(value) { assert.equal(value.code, 'relation_task_interrupted') }, host: { call() { throw Error('relation recovery must not resubmit extraction') } } }
const resume = new Function(...Object.keys(resumeValues), client.slice(resumeStart, resumeEnd) + '; return resumeLostTask')(...Object.values(resumeValues))
assert.equal(await resume(), false)
assert.ok(client.includes('relationRetry: pending.relationRetry === true'), 'reload must preserve the kind, not turn relation search into extraction')
console.log('active task smoke passed: real owner, admission, terminal state, content minimization, orphan discovery, reconnect/unmount, small owned references, double-click and restart safety')
