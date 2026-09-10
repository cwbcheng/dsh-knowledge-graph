import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { Worker as NodeWorker } from 'node:worker_threads'

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const exports = 'graphLayoutWorkerSource, computeGraphLayoutAsync, prepareGraphScene, GraphViewer, GraphLoading, graphPaint, useGraphDocumentLoading,'
const sandbox = { window: { React: {} }, setTimeout, clearTimeout, setInterval, clearInterval, console }
vm.runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = {' + exports), sandbox)
const engine = sandbox.window.KGViewer
const workerSource = engine.graphLayoutWorkerSource()
const plain = value => JSON.parse(JSON.stringify(value))
const graph = count => {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i, type: i % 3 ? 'claim' : 'example', text: 'Node ' + i, paragraph: i }))
  const edges = nodes.slice(1).flatMap((n, i) => i % 7 ? [{ fromNodeId: 'n' + i, toNodeId: n.id, relation: i % 3 ? 'causes' : 'example' }] : [])
  const sizes = new Map(nodes.map(n => [n.id, { w: 140, h: 80, lines: [n.text] }]))
  return { nodes, edges, sizes }
}
const inWorker = data => new Promise((resolve, reject) => {
  const progress = []
  const worker = new NodeWorker(`const { parentPort, workerData } = require('node:worker_threads'); require('node:vm').runInNewContext(workerData.source + '; self.onmessage({data:input})', {self: {postMessage: data => parentPort.postMessage(data)}, input: workerData.input, setTimeout, clearTimeout, setInterval, clearInterval});`, { eval: true, workerData: { source: workerSource, input: data } })
  worker.on('error', reject)
  worker.on('message', message => {
    if (message.progress) progress.push(message.progress)
    else { worker.terminate().then(() => message.error ? reject(new Error(message.error)) : resolve({ ...message, progress })) }
  })
})
for (const mode of ['layered', 'force', 'circular', 'radial']) {
  for (const count of [0, 1, 24]) {
    const data = graph(count)
    const expected = engine.layoutGraph(data.nodes, data.edges, data.sizes, mode)
    const actual = await inWorker({ ...data, mode })
    assert.equal(typeof actual.layout.pos?.[Symbol.iterator], 'function', mode + '/' + count + ': position table must be a Map: ' + JSON.stringify(actual.layout))
    assert.deepEqual(plain([...actual.layout.pos]), plain([...expected.pos]), mode + ': worker must preserve exact layout')
  }
}
let heartbeats = 0
const timer = setInterval(() => heartbeats++, 2)
const large = await inWorker({ ...graph(2000), mode: 'layered' })
clearInterval(timer)
assert.equal(large.layout.pos.size, 2000)
assert(heartbeats > 1, 'large graph layout must leave the caller responsive')
assert(large.progress.length > 0)
assert.equal(large.progress.at(-1).completed, 2000)
assert(large.progress.every((p, i, all) => p.completed <= p.total && (!i || p.completed >= all[i - 1].completed)))

function hooks(fn, dependencies) {
  let index = 0
  const slots = [], effects = []
  const api = {
    useState(initial) {
      const slot = index++
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
      return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
    },
    useRef(value) { const slot = index++; if (!(slot in slots)) slots[slot] = { current: value }; return slots[slot] },
    useEffect(effect, deps) {
      const slot = index++, previous = slots[slot]
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) effects.push(() => { previous?.cleanup?.(); slots[slot] = { deps, cleanup: effect() } })
    },
    useCallback(callback) { return callback },
    h: (type, props, ...children) => ({ type, props, children }),
    AbortController, DOMException,
    ...dependencies,
  }
  const render = new Function(...Object.keys(api), 'return (' + fn.toString() + ')')(...Object.values(api))
  return {
    render(props) { index = 0; const tree = render(props); while (effects.length) effects.shift()(); return tree },
    dispose() { for (const slot of slots) slot?.cleanup?.() },
  }
}
const jobs = [], Scene = () => {}, Loading = () => {}
const renderer = hooks(engine.GraphViewer, {
  GraphScene: Scene, GraphLoading: Loading,
  prepareGraphScene(nodes, edges, mode, signal, report) { return new Promise((resolve, reject) => jobs.push({ nodes, signal, report, resolve, reject })) },
})
const props = { nodes: [], edges: [], layoutMode: 'layered', height: 560 }
assert.equal(renderer.render(props).props['aria-busy'], true)
assert.equal(jobs.length, 1)
jobs[0].report({ stage: 2, title: 'routes' })
assert.equal(renderer.render(props).children[1].props.progress.stage, 2)
jobs[0].resolve({ layout: 'first' })
await Promise.resolve()
let tree = renderer.render(props)
assert.equal(tree.children[0].type, Scene)
assert.equal(tree.props['aria-busy'], true, 'must stay busy until the actual scene paint completes')
tree.children[0].props.onReady()
assert.equal(renderer.render(props).props['aria-busy'], false)
renderer.render({ ...props, selectedNodeId: 'n1' })
assert.equal(jobs.length, 1, 'selection cannot restart graph preparation')
const changed = { ...props, layoutMode: 'force' }
assert.equal(renderer.render(changed).children[0], null, 'new layout cannot show stale prepared geometry')
assert(jobs[0].signal.aborted)
jobs[0].report({ stage: 3, title: 'stale' })
jobs[1].reject(new Error('layout failed'))
await Promise.resolve(); await Promise.resolve()
tree = renderer.render(changed)
assert.equal(tree.children[1].props.error, 'layout failed')
tree.children[1].props.onRetry()
renderer.render(changed)
assert.equal(jobs.length, 3)
renderer.dispose()
assert(jobs[2].signal.aborted)
jobs[2].resolve({ layout: 'disposed' })
await Promise.resolve()

const frames = new Map(); let frameId = 0
const paint = new Function('requestAnimationFrame', 'cancelAnimationFrame', 'DOMException', 'return (' + engine.graphPaint.toString() + ')')(
  callback => { frames.set(++frameId, callback); return frameId }, id => frames.delete(id), DOMException)
const tick = () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback()) }
const controller = new AbortController()
let painted = false
const painting = paint(controller.signal).then(() => { painted = true })
tick(); await Promise.resolve(); assert.equal(painted, false)
tick(); await painting; assert.equal(painted, true)
const cancelled = new AbortController(), cancellation = paint(cancelled.signal)
tick(); cancelled.abort()
await assert.rejects(cancellation, { name: 'AbortError' })
assert.equal(frames.size, 0)

// Exercise resource ownership even when a terminated worker sends a late result.
let worker, revoked = 0, terminated = 0, fallback = 0
class FakeWorker { constructor() { worker = this } postMessage() {} terminate() { terminated++ } }
const asyncLayout = new Function('Worker', 'URL', 'Blob', 'DOMException', 'graphLayoutWorkerSource', 'graphPaint', 'layoutGraph', 'return (' + engine.computeGraphLayoutAsync.toString() + ')')(
  FakeWorker, { createObjectURL: () => 'blob:test', revokeObjectURL: () => revoked++ }, Blob, DOMException, () => 'code', async () => {}, () => { fallback++; return { pos: new Map() } })
const workerAbort = new AbortController(), pending = asyncLayout([], [], new Map(), 'layered', workerAbort.signal, () => {})
workerAbort.abort()
await assert.rejects(pending, { name: 'AbortError' })
worker.onmessage({ data: { layout: { stale: true } } })
assert.equal(terminated, 1); assert.equal(revoked, 1); assert.equal(fallback, 0)
const failure = asyncLayout([], [], new Map(), 'layered', new AbortController().signal, () => {})
worker.onmessage({ data: { error: 'bad geometry' } })
await assert.rejects(failure, /bad geometry/)
assert.equal(fallback, 0, 'algorithm failures must not masquerade as a successful fallback')
const restricted = asyncLayout([], [], new Map(), 'layered', new AbortController().signal, () => {})
worker.onerror({ preventDefault() {} })
await restricted
assert.equal(fallback, 1, 'CSP-restricted viewers must retain their existing layout capability')
assert.equal(terminated, 3); assert.equal(revoked, 3)

const reads = []
const documentLoader = hooks(engine.useGraphDocumentLoading, {
  graphPaint: async signal => { if (signal.aborted) throw new DOMException('cancelled', 'AbortError') },
  host: { call(method, body) { assert.equal(method, 'document-load'); return new Promise((resolve, reject) => reads.push({ body, resolve, reject })) } },
})
let [readProgress, load] = documentLoader.render()
assert.equal(readProgress, null)
const query = { documentId: 'doc', query: 'outside-window', nodeOffset: 0, includeSourceText: false }
const read = load(query)
assert.equal(documentLoader.render()[0].title, '读取知识图')
await Promise.resolve()
assert.deepEqual(reads[0].body, query, 'loading wrapper must preserve off-window query and source flags')
reads[0].resolve({ graph: { nodes: [{ id: 'outside-window' }], edges: [] } })
await read
assert.equal(documentLoader.render()[0], null)
const rejectedRead = load({ documentId: 'missing' })
await Promise.resolve(); reads[1].reject(new Error('network failed'))
await assert.rejects(rejectedRead, /network failed/)
assert.equal(documentLoader.render()[0], null, 'failed reads cannot leave a permanent spinner')
const unmountedRead = load({ documentId: 'slow' })
await Promise.resolve(); documentLoader.dispose()
reads[2].resolve({ graph: { nodes: [], edges: [] } })
await assert.rejects(unmountedRead, { name: 'AbortError' })

for (const path of ['lib/client.js', 'extension/viewer.js']) {
  const built = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  for (const name of ['graphLayoutWorkerSource', 'prepareGraphScene', 'GraphViewer', 'GraphLoading']) assert(built.includes(engine[name].toString()), path + ': ' + name + ' parity')
}
assert(source.includes('@media (prefers-reduced-motion: reduce)'))
console.log(JSON.stringify({ ok: true, layoutParity: '4 modes: empty, singleton, connected/disconnected', nodes: 2000, heartbeats, paintBarrier: true, cancelSafe: true, staleSafe: true, errorRetry: true, workerCleanup: true }))
