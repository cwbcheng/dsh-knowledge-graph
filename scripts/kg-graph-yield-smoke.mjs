import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const context = { window: { React: {} }, console }
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { prepareGraphScene,'), context)
const prepareSource = context.window.KGViewer.prepareGraphScene.toString()

// Model a busy batch without timing thresholds. Painting is a phase barrier,
// not the cooperative yield between every batch of geometry calculations.
async function prepare(count, mode = 'layered', abortAt = null) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i }))
  const edges = nodes.slice(1).map((node, i) => ({ fromNodeId: 'n' + i, toNodeId: node.id }))
  const controller = new AbortController()
  let clock = 0, paints = 0, yields = 0, routes = 0, layouts = 0
  const progress = []
  const deps = {
    performance: { now: () => clock },
    async graphPaint(signal) { paints++; signal.throwIfAborted() },
    async graphYield(signal) {
      yields++
      if (yields === abortAt) controller.abort()
      signal.throwIfAborted()
    },
    computeNodeSizes(batch) {
      clock += 9
      return new Map(batch.map(node => [node.id, { w: 96, h: 40 }]))
    },
    async computeGraphLayoutAsync(input, inputEdges, sizes, inputMode, signal) {
      layouts++
      signal.throwIfAborted()
      assert.equal(input, nodes); assert.equal(inputEdges, edges); assert.equal(inputMode, mode)
      assert.equal(sizes.size, nodes.length)
      return { pos: new Map(nodes.map((node, i) => [node.id, { x: i * 200, y: 0 }])) }
    },
    buildLayeredEdgeLanes: () => new Map(),
    layeredOrthoPath(edge) { clock += 9; routes++; return { d: edge.toNodeId, lblX: routes * 200, lblY: 0 } },
    measureLabel: () => 20,
    edgeRelationLabel: () => 'relation',
    placeLayeredEdgeLabel: (x, y) => ({ x, y, hidden: false }),
    computeBBox: () => ({ w: 600, h: 400 }),
  }
  const run = new Function(...Object.keys(deps), 'return (' + prepareSource + ')')(...Object.values(deps))
  const pending = run(nodes, edges, mode, controller.signal, item => progress.push(item))
  if (abortAt !== null) {
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(yields, abortAt, 'cancellation stops at the current batch')
    assert(!progress.some(item => item.stage === 3), 'cancelled work must not announce drawing')
  } else {
    const result = await pending
    assert.equal(paints, 4, 'only the four loading stages may force a paint; per-batch paint waits inflate large-graph latency')
    assert.equal(yields, Math.ceil(count / 100) + (mode === 'layered' ? edges.length : 0))
    assert.equal(routes, mode === 'layered' ? edges.length : 0)
    assert.equal(result.layeredEdgeGeometry.size, routes)
    assert.equal(result.sizes.size, count)
    assert.deepEqual([...new Set(progress.map(item => item.stage))], [0, 1, 2, 3])
  }
  return { layouts, routes, paints, yields }
}
for (const count of [0, 1, 205]) await prepare(count)
await prepare(205, 'force')
assert.equal((await prepare(205, 'layered', 1)).layouts, 0, 'cancel during measurement before starting a worker')
assert.equal((await prepare(205, 'layered', 4)).routes, 1, 'cancel during routing before preparing further edges')

// Exercise the actual task yield with throttled animation frames and timer ID
// zero, including pre-abort, abort-before-dispatch and a late queued callback.
const timers = new Map(), delays = []
let nextTimer = 0, listeners = 0
const sandbox = {
  window: { React: {} }, console, DOMException,
  setTimeout(callback, ms) { const id = nextTimer++; timers.set(id, callback); delays.push(ms); return id },
  clearTimeout: id => timers.delete(id),
  requestAnimationFrame() { assert.fail('a cooperative task yield must not depend on animation frames') },
}
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { graphYield,'), sandbox)
const yieldTask = sandbox.window.KGViewer.graphYield
function trackedSignal() {
  const controller = new AbortController(), signal = controller.signal
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = (...args) => { listeners++; return add(...args) }
  signal.removeEventListener = (...args) => { listeners--; return remove(...args) }
  return controller
}
const controller = trackedSignal()
let finished = false
const pending = yieldTask(controller.signal).then(() => { finished = true })
await Promise.resolve()
assert.equal(finished, false, 'must yield to a task, not just resolve another microtask')
assert.deepEqual(delays, [0], 'must not add a fixed frame-length delay to each batch')
assert(timers.has(0))
timers.get(0)()
await pending
assert.equal(finished, true); assert.equal(timers.size, 0); assert.equal(listeners, 0)

const aborted = new AbortController(); aborted.abort()
const scheduled = delays.length
await assert.rejects(yieldTask(aborted.signal), { name: 'AbortError' })
assert.equal(delays.length, scheduled, 'pre-aborted work must not schedule a task')
const cancelled = trackedSignal(), cancellation = yieldTask(cancelled.signal)
const staleCallback = [...timers.values()][0]
cancelled.abort()
await assert.rejects(cancellation, { name: 'AbortError' })
assert.equal(timers.size, 0); assert.equal(listeners, 0)
staleCallback()
assert.equal(listeners, 0, 'late callbacks must not clean up twice')
for (const path of ['src/index.client.js', 'lib/client.js']) {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  assert(source.includes(yieldTask.toString()), path + ': graphYield parity')
  assert(source.includes(prepareSource), path + ': prepareGraphScene parity')
}
console.log(JSON.stringify({ ok: true, fixedPaintBarriers: 4, taskYieldBetweenBatches: true, frameIndependent: true, abortBeforeLayout: true, abortDuringRouting: true, timerCleanup: true, generatedParity: true }))
