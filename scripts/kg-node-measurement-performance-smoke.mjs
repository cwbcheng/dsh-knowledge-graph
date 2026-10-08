import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { runInNewContext } from 'node:vm'

// Exercise the generated loading pipeline and actual text measurement. The
// only substitutes are paint/yield scheduling and the unrelated layout work.
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const environment = { window: { React: {} }, console,
  document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: String(text).length * 8 }) }) }) },
}
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { prepareGraphScene, computeNodeSizes,'), environment)
const { prepareGraphScene, computeNodeSizes } = environment.window.KGViewer
const prepareSource = prepareGraphScene.toString()
const sizesJSON = sizes => JSON.stringify([...sizes])

async function measure(count, { cancel = false, slowEdges = false, fixture } = {}) {
  const nodes = fixture?.nodes || Array.from({ length: count }, (_, i) => ({
    id: '节点:' + i + (i % 97 === 0 ? ' ' : ''), type: i % 109 === 0 ? 'image' : i % 2 ? 'fact' : 'concept',
    text: 'Node ' + i + ' 测量示例 ' + (i % 103 === 0 ? 'long text '.repeat(60) : ''),
  }))
  const relations = fixture?.edges || nodes.flatMap((node, i) => [
    { fromNodeId: node.id, toNodeId: nodes[(i + 1) % count].id },
    { fromNodeId: node.id, toNodeId: i % 11 === 0 ? node.id : nodes[0].id },
    { fromNodeId: i % 19 === 0 ? 'missing:' + i : node.id, toNodeId: nodes[(i + 7) % count].id },
  ])
  const original = JSON.stringify({ nodes, relations })
  // A single unbatched production measurement is the geometry oracle: node
  // types, wrapping, hubs, loops and exact IDs must yield the same dimensions.
  const expected = sizesJSON(computeNodeSizes(nodes, relations))
  let edgeReads = 0, clock = 0, yields = 0, batches = 0, layouts = 0
  const edges = new Proxy(relations, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) { edgeReads++; if (slowEdges) clock += 0.01 }
      return Reflect.get(target, key, receiver)
    },
  })
  const controller = new AbortController(), progress = []
  const deps = {
    performance: { now: () => clock },
    async graphPaint(signal) { signal.throwIfAborted() },
    async graphYield(signal) { yields++; if (cancel) controller.abort(); signal.throwIfAborted() },
    computeNodeSizes(...args) { batches++; return computeNodeSizes(...args) },
    async computeGraphLayoutAsync(input, inputEdges, sizes, mode, signal) {
      signal.throwIfAborted(); layouts++
      assert.equal(input, nodes); assert.equal(inputEdges, edges); assert.equal(mode, 'overview')
      assert.equal(sizesJSON(sizes), expected, 'Batching must retain exact production dimensions and wrapping')
      return { pos: new Map(nodes.map((node, i) => [node.id, { x: i * 240, y: 0 }])) }
    },
    computeBBox: () => ({ w: 600, h: 400 }),
  }
  const run = new Function(...Object.keys(deps), 'return (' + prepareSource + ')')(...Object.values(deps))
  const started = performance.now()
  const pending = run(nodes, edges, 'overview', controller.signal, item => progress.push(item))
  if (cancel) {
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(batches, 0, 'Cancelling degree measurement must stop before text measurement')
    assert.equal(layouts, 0, 'Cancelling degree measurement must not start layout')
    assert(edgeReads > 0 && edgeReads <= 1000, 'Long relation scans must yield within a bounded batch')
    assert.equal(yields, 1)
    assert(!progress.some(item => item.stage > 0), 'Cancelled measurement cannot announce later loading stages')
  } else {
    const prepared = await pending
    assert.equal(sizesJSON(prepared.sizes), expected)
    assert.equal(batches, Math.ceil(count / 100), 'Text measurement remains bounded to 100-node batches')
    assert.equal(layouts, 1)
    assert.deepEqual([...new Set(progress.map(item => item.stage))], [0, 1, 2, 3])
    console.log(JSON.stringify({ nodes: count, edges: relations.length, edgeReads, textBatches: batches,
      ms: Math.round((performance.now() - started) * 100) / 100 }))
    assert(edgeReads <= relations.length, 'Node measurement must read each relation at most once, not once per text batch: ' + edgeReads)
    if (slowEdges) assert(yields > 1, 'Large degree scans must allow input/cancellation between batches')
  }
  assert.equal(JSON.stringify({ nodes, relations }), original, 'Preparing a view must never change graph data')
}

for (const count of [12000, 0, 1, 205]) await measure(count)
await measure(1901, { slowEdges: true })
await measure(1901, { slowEdges: true, cancel: true })

// Preserve degree behavior near the hub-size boundary, not only for saturated
// hubs: loops count twice, parallel edges each count, absent endpoints do not
// create nodes, and IDs that differ by trailing space remain separate.
const boundaryNodes = ['x', 'x ', 'y', 'z'].map(id => ({ id, type: 'fact', text: 'same text' }))
const boundaryEdges = [
  { fromNodeId: 'x', toNodeId: 'x' }, { fromNodeId: 'x', toNodeId: 'y' },
  { fromNodeId: 'x', toNodeId: 'y' }, { fromNodeId: 'x ', toNodeId: 'missing' },
]
const boundarySizes = computeNodeSizes(boundaryNodes, boundaryEdges)
assert(boundarySizes.get('x').w > boundarySizes.get('x ').w)
assert.equal(boundarySizes.get('x ').h, boundarySizes.get('z').h)
assert.equal(boundarySizes.get('y').w, boundarySizes.get('z').w)
await measure(boundaryNodes.length, { fixture: { nodes: boundaryNodes, edges: boundaryEdges } })
for (const path of ['src/index.client.js', 'lib/client.js']) {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  assert(source.includes(prepareSource), path + ': loading pipeline parity')
  assert(source.includes(computeNodeSizes.toString()), path + ': measurement parity')
}
console.log(JSON.stringify({ ok: true, singleRelationPass: true, exactSizes: true,
  boundedTextBatches: true, cancellableDegreeScan: true, generatedParity: true }))
