import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { runInNewContext } from 'node:vm'

// Mount the generated production scene with component-scoped hooks. Count
// graph traversal and React element creation instead of gating on CPU speed.
let current, cursor = 0, created = 0
const frames = new Map()
let nextFrame = 0
const slot = init => { const index = cursor++; return current.slots[index] ||= init() }
const React = {
  createElement(type, props, ...children) { created++; return { type, props: { ...props, children } } },
  useState(initial) {
    const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [state.value, next => { state.value = typeof next === 'function' ? next(state.value) : next }]
  },
  useRef(initial) { return slot(() => ({ current: initial })) },
  useMemo(fn, deps) {
    const memo = slot(() => ({}))
    if (!memo.deps || deps.some((dep, i) => !Object.is(dep, memo.deps[i]))) { memo.value = fn(); memo.deps = deps }
    return memo.value
  },
  useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
  useEffect() {},
}
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const environment = { window: { React }, console,
  requestAnimationFrame(fn) { const id = nextFrame++; frames.set(id, fn); return id },
  cancelAnimationFrame: id => frames.delete(id),
  document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 10 }) }) }) },
}
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { GraphScene, layoutOverview, computeBBox, createGraphViewportIndex,'), environment)
const { GraphScene, layoutOverview, computeBBox, createGraphViewportIndex } = environment.window.KGViewer
const all = (element, predicate) => Array.isArray(element) ? element.flatMap(child => all(child, predicate))
  : !element || typeof element !== 'object' ? []
    : [...(predicate(element) ? [element] : []), ...all(element.props?.children, predicate)]
const byClass = name => element => element.props?.className?.split(' ').includes(name)

function fixture(count, mode) {
  let nodeReads = 0
  const nodes = new Proxy(Array.from({ length: count }, (_, i) => ({ id: 'n' + i, type: 'claim', text: 'Node ' + i })), {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) nodeReads++
      return Reflect.get(target, key, receiver)
    },
  })
  const sizes = new Map(nodes.map(node => [node.id, { w: 200, h: 100, lines: ['first', 'second', 'third', 'fourth'] }]))
  const layout = layoutOverview(nodes, sizes)
  const props = { nodes, edges: [], anchors: {}, selectedNodeId: null, selectedEdgeId: null, focusReq: { seq: 0 },
    ctx: { timeout: () => () => {} }, onSelectNode() {}, onSelectEdge() {}, onReady() {}, onLayoutModeChange() {},
    prepared: { sizes, layout, bbox: computeBBox(nodes, layout, sizes), edgeLanes: new Map(), layeredEdgeGeometry: new Map() },
    layoutMode: mode }
  const owner = { slots: [] }
  const captures = new Set()
  const element = { clientWidth: 900, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id), contains: () => false }
  let tree
  const render = () => { current = owner; cursor = 0; tree = GraphScene(props); return tree }
  const viewport = () => all(tree, byClass('kg-graph-viewport'))[0]
  render(); viewport().props.ref.current = element
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); render() }
  const click = label => { all(tree, item => item.type === 'button' && item.props['aria-label'] === label)[0].props.onClick(); flush() }
  click('重置缩放为 100%')
  const measure = run => {
    const before = created
    nodeReads = 0
    const start = performance.now()
    run()
    return { elements: created - before, nodeReads, ms: Math.round((performance.now() - start) * 100) / 100 }
  }
  const panStart = () => { viewport().props.onPointerDown({ button: 0, pointerId: 1, clientX: 0, clientY: 0, target: { closest: () => null } }); render() }
  const pan = (x, y) => { viewport().props.onPointerMove({ pointerId: 1, clientX: x, clientY: y }); flush() }
  const panEnd = (x, y) => { viewport().props.onPointerUp({ pointerId: 1, clientX: x, clientY: y }); flush() }
  const transform = all(tree, item => item.type === 'g' && item.props.style?.transform)[0].props.style.transform
  const [tx, ty] = transform.match(/translate\(([-\d.eE+]+)px, ([-\d.eE+]+)px\)/).slice(1).map(Number)
  panStart(); pan(110 - tx, 110 - ty); panEnd(110 - tx, 110 - ty)
  return { props, render, click, measure, panStart, pan, panEnd, element,
    nodeElements: () => all(tree, byClass('kg-node')),
    labels: () => all(tree, byClass('kg-node-name')),
  }
}

const ordinary = fixture(2000, 'layered')
const ordinaryNodes = ordinary.nodeElements(), ordinaryLabels = ordinary.labels()
const ordinaryZoom = ordinary.measure(() => ordinary.click('放大（10%）'))
const ordinaryAfterZoom = ordinary.nodeElements(), ordinaryLabelsAfterZoom = ordinary.labels()
ordinary.panStart()
const ordinaryPan = ordinary.measure(() => ordinary.pan(1, 1))
ordinary.panEnd(1, 1)

const overview = fixture(12000, 'overview')
const overviewNodes = overview.nodeElements(), overviewLabels = overview.labels()
overview.panStart()
const overviewPan = overview.measure(() => overview.pan(1, 1))
const overviewAfterPan = overview.nodeElements(), overviewLabelsAfterPan = overview.labels()
const overviewCrossing = overview.measure(() => overview.pan(-300, -200))
const overviewAfterCrossing = overview.nodeElements()
overview.panEnd(-300, -200)
const overviewZoom = overview.measure(() => overview.click('放大（10%）'))

console.log(JSON.stringify({ ordinaryNodes: 2000, overviewNodes: 12000, visibleNodes: overviewNodes.length,
  ordinaryZoom, ordinaryPan, overviewPan, overviewCrossing, overviewZoom }))
assert(ordinaryZoom.elements < 100, 'Ordinary zoom must update the camera without rebuilding every node: ' + ordinaryZoom.elements)
assert.equal(ordinaryZoom.nodeReads, 0, 'Ordinary zoom must not traverse graph nodes')
assert(ordinaryPan.elements < 100)
assert.equal(ordinaryPan.nodeReads, 0)
assert.equal(ordinaryAfterZoom.length, 2000)
for (let i = 0; i < 2000; i++) {
  assert.equal(ordinaryAfterZoom[i], ordinaryNodes[i], 'Ordinary node subtrees retain their element identity on zoom')
  assert.equal(ordinaryLabelsAfterZoom[i], ordinaryLabels[i])
}
assert(overviewNodes.length > 0 && overviewNodes.length < 100, 'Overview zoom draws the visible window')
assert(overviewPan.elements < 100, 'Small overview pans must retain an unchanged visible window')
assert.equal(overviewPan.nodeReads, 0, 'Overview pan must query its spatial index, not scan the canonical graph')
assert.equal(overviewAfterPan.length, overviewNodes.length)
for (let i = 0; i < overviewNodes.length; i++) {
  assert.equal(overviewAfterPan[i], overviewNodes[i])
  assert.equal(overviewLabelsAfterPan[i], overviewLabels[i])
}
assert.equal(overviewCrossing.nodeReads, 0)
assert(overviewCrossing.elements < 1000, 'Crossing a viewport boundary builds only nearby SVG nodes')
assert(overviewAfterCrossing.length > 0 && overviewAfterCrossing.length < 100)
assert.notDeepEqual(overviewAfterCrossing.map(node => node.props['data-node-id']), overviewNodes.map(node => node.props['data-node-id']),
  'A camera crossing must reveal the new nodes rather than reuse stale membership')
assert.equal(overviewZoom.nodeReads, 0)
assert(overviewZoom.elements < 1000)
assert.equal(frames.size, 0, 'No camera work remains after pointer-up')

// A resize must refresh membership even when the camera does not change.
overview.element.clientWidth = 1600
const resize = overview.measure(overview.render)
assert.equal(resize.nodeReads, 0)
assert(overview.nodeElements().length > overviewAfterCrossing.length)
// Detail visibility changes once at the overview threshold, not on each zoom.
for (let i = 0; i < 13; i++) overview.click('缩小（10%）')
assert.equal(overview.labels().length, 0, 'Overview hides unreadable labels below 35%')
for (let i = 0; i < 4; i++) overview.click('放大（10%）')
assert(overview.labels().length > 0, 'Zooming back reveals labels in the new visible window')
overview.click('适合画布')
assert.equal(overview.nodeElements().length, 12000, 'Explicit fit still represents every graph node')
overview.panStart()
const wholeGraphPan = overview.measure(() => overview.pan(1, 1))
overview.panEnd(1, 1)
assert.equal(wholeGraphPan.nodeReads, 0)
assert(wholeGraphPan.elements < 100, 'Whole-graph fits must retain their scene on small pans')

const spatialNodes = Array.from({ length: 50000 }, (_, i) => ({ id: i % 997 === 0 ? 'exact ' + i + ' ' : 'large-' + i }))
const spatialSizes = new Map(spatialNodes.map((node, i) => [node.id, { w: 100 + i % 6 * 35, h: 50 + i % 5 * 20 }]))
const spatialLayout = layoutOverview(spatialNodes, spatialSizes)
// Negative cells, a body whose center is offscreen, and very sparse coordinates.
spatialLayout.pos.set(spatialNodes[0].id, { x: -2000, y: -1500 })
spatialLayout.pos.set(spatialNodes[1].id, { x: -1000, y: 10 })
spatialSizes.set(spatialNodes[1].id, { w: 2100, h: 50 })
spatialLayout.pos.set(spatialNodes[2].id, { x: 1e9, y: -1e9 })
spatialLayout.pos.set(spatialNodes[3].id, { x: -512, y: 512 })
spatialLayout.pos.set(spatialNodes[4].id, { x: 512, y: -512 })
spatialLayout.pos.delete(spatialNodes[5].id)
spatialSizes.delete(spatialNodes[6].id)
const originalGeometry = JSON.stringify([[...spatialLayout.pos], [...spatialSizes]])
const spatialIndex = createGraphViewportIndex(spatialNodes, spatialLayout, spatialSizes)
const bruteForce = (view, width, height) => spatialNodes.filter(node => {
  const point = spatialLayout.pos.get(node.id), size = spatialSizes.get(node.id)
  if (!point || !size) return false
  const x = point.x * view.k + view.tx, y = point.y * view.k + view.ty
  const margin = Math.max(size.w, size.h) * view.k / 2 + 20
  return x >= -margin && x <= width + margin && y >= -margin && y <= height + margin
})
let seed = 42, parityCases = 0
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
for (const k of [0.00001, 0.02, 0.349, 0.35, 0.85, 1, 2]) {
  for (let pass = 0; pass < 15; pass++) {
    const view = { k, tx: (random() - 0.8) * 40000 * k, ty: (random() - 0.8) * 30000 * k }
    const width = 344 + Math.floor(random() * 1200), height = 320 + Math.floor(random() * 500)
    assert.deepEqual([...spatialIndex.query(view, width, height)], bruteForce(view, width, height),
      'Spatial query must match the exhaustive visibility oracle in canonical order')
    parityCases++
  }
}
for (const [tx, ty] of [[0, 0], [2000, 1500], [-1e9, 1e9], [512, -512]]) {
  const view = { k: 1, tx, ty }
  assert.deepEqual([...spatialIndex.query(view, 900, 600)], bruteForce(view, 900, 600))
  parityCases++
}
const exact = spatialNodes[0], localView = { k: 1, tx: 2200, ty: 1700 }
const firstQuery = spatialIndex.query(localView, 344, 320)
assert(firstQuery.includes(exact), 'Exact node identities, including trailing spaces, must survive lookup')
assert.equal(spatialIndex.query({ ...localView, tx: localView.tx + 0.01 }, 344, 320), firstQuery,
  'Unchanged viewport membership returns the same array for React memoization')
for (const view of [{ k: 0, tx: 0, ty: 0 }, { k: NaN, tx: 0, ty: 0 }, { k: 1, tx: Infinity, ty: 0 }]) {
  assert.equal(spatialIndex.query(view, 900, 600).length, 0)
}
assert.equal(spatialIndex.query(localView, 0, 600).length, 0)
assert.equal(createGraphViewportIndex([], { pos: new Map() }, new Map()).query(localView, 900, 600).length, 0)
const borderNode = { id: 'border' }, borderPoint = { x: 512, y: -512 }, borderSize = { w: 200, h: 100 }
const borderIndex = createGraphViewportIndex([borderNode], { pos: new Map([[borderNode.id, borderPoint]]) }, new Map([[borderNode.id, borderSize]]))
let boundaryCases = 0
for (const k of [0.02, 0.349, 0.35, 0.85, 1, 1.1, 2]) {
  const margin = 100 * k + 20
  for (const x of [-margin, 344 + margin, 100]) {
    for (const y of [-margin, 320 + margin, 100]) {
      for (const offset of [-0.0001, 0, 0.0001]) {
        const view = { k, tx: x + offset - borderPoint.x * k, ty: y + offset - borderPoint.y * k }
        // Use the legacy screen-space calculation, including exact borders.
        const px = borderPoint.x * view.k + view.tx, py = borderPoint.y * view.k + view.ty
        const visible = px >= -margin && px <= 344 + margin && py >= -margin && py <= 320 + margin
        assert.equal(borderIndex.query(view, 344, 320).includes(borderNode), visible, JSON.stringify({ k, x, y, offset }))
        boundaryCases++
      }
    }
  }
}
assert.equal(JSON.stringify([[...spatialLayout.pos], [...spatialSizes]]), originalGeometry, 'Viewport queries must not change graph geometry')
for (const file of ['src/index.client.js', 'lib/client.js']) {
  assert(readFileSync(new URL('../' + file, import.meta.url), 'utf8').includes(createGraphViewportIndex.toString()), file + ': generated spatial-index parity')
}
console.log(JSON.stringify({ ok: true, spatialNodes: spatialNodes.length, parityCases, boundaryCases, stableWindow: true,
  negativeAndSparseCoordinates: true, oversizeBodies: true, viewportResize: true, labelThreshold: true, wholeGraphPan, generatedParity: true }))
