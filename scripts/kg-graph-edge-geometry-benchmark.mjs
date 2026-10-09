// Actual generated scene; deterministic routing work with simulated React hooks.
// node scripts/kg-graph-edge-geometry-benchmark.mjs [baseline-git-revision] [--smoke]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const smoke = process.argv.includes('--smoke')
const revision = process.argv.slice(2).find(arg => arg !== '--smoke')
if (revision?.startsWith('-')) throw new Error('Expected a git revision')
let bundle = revision ? execFileSync('git', ['show', revision + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const signature = 'function radialFreeAngle(base, rFrom, rTo, excludeA, excludeB, nodes, sizes, pos) {'
assert.equal(bundle.split(signature).length, 2)
const start = bundle.indexOf(signature), end = bundle.indexOf('\n      function ', start + signature.length)
const radial = bundle.slice(start, end)
assert.equal(radial.split('for (const n of nodes) {').length, 2)
bundle = bundle.slice(0, start) + radial.replace(signature, signature + ' routeWork.radialCalls++;')
  .replace('for (const n of nodes) {', 'for (const n of nodes) { routeWork.nodeVisits++;') + bundle.slice(end)
bundle = bundle.replace('function bezierGeometry(a, b, sa, sb, rawBend) {',
  'function bezierGeometry(a, b, sa, sb, rawBend) { routeWork.bezierCalls++;')
const count = smoke ? 32 : 800, trials = smoke ? 1 : 3, results = []
for (let trial = 0; trial < trials; trial++) {
  let owner, cursor = 0
  const slot = initial => { const index = cursor++; return owner.slots[index] ||= initial() }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value }]
    },
    useRef: initial => slot(() => ({ current: initial })),
    useMemo(fn, deps) {
      const memo = slot(() => ({}))
      if (!memo.deps || deps.some((value, i) => !Object.is(value, memo.deps[i]))) { memo.value = fn(); memo.deps = deps }
      return memo.value
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
    useEffect() {},
  }
  const routeWork = { radialCalls: 0, nodeVisits: 0, bezierCalls: 0 }
  const environment = { window: { React }, routeWork, console, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 10 }) }) }) } }
  runInNewContext(bundle.replace('window.KGViewer = {', 'window.KGViewer = { GraphScene, GraphEdgeInteraction, layoutRadial, computeBBox,'), environment)
  const { GraphScene, GraphEdgeInteraction, layoutRadial, computeBBox } = environment.window.KGViewer
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i, type: 'fact', text: 'Node ' + i, quote: 'Complete evidence ' + i }))
  const edges = nodes.slice(1).map(node => ({ fromNodeId: 'n0', toNodeId: node.id, relation: 'supports' }))
  for (let i = 1; i < count - 1; i += 4) edges.push({ fromNodeId: 'n' + i, toNodeId: 'n' + (i + 1), relation: 'example' })
  edges.push({ ...edges[0], relation: 'analogy' }, { fromNodeId: 'n2', toNodeId: 'n2', relation: 'supports' })
  const sizes = new Map(nodes.map(node => [node.id, { w: 200, h: 100, lines: [node.text] }]))
  const layout = { pos: layoutRadial(nodes, edges, sizes) }, hooks = { slots: [] }, events = []
  const props = { nodes, edges, anchors: Object.fromEntries(nodes.map(node => [node.id, 0])), selectedEdgeId: null, focusReq: { seq: 0 },
    ctx: { timeout: () => () => {} }, onSelectNode() {}, onReady() {}, onLayoutModeChange() {},
    prepared: { sizes, layout, bbox: computeBBox(nodes, layout, sizes), edgeLanes: new Map(), layeredEdgeGeometry: new Map() }, layoutMode: 'radial' }
  const render = (selectedNodeId, overrides = {}, sceneHooks = hooks) => {
    owner = sceneHooks; cursor = 0
    return GraphScene({ ...props, ...overrides, selectedNodeId, onSelectEdge: value => events.push([selectedNodeId, value]) })
  }
  const all = (tree, predicate) => Array.isArray(tree) ? tree.flatMap(item => all(item, predicate))
    : !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...all(tree.props?.children, predicate)]
  const digest = tree => createHash('sha256').update(JSON.stringify(all(tree, item => item.type === GraphEdgeInteraction).map(item => {
    const edge = item.props.render(false, {})
    return [edge.props.key, all(edge, item => item.type === 'path').map(item => item.props.d),
      all(edge, item => item.type === 'rect').map(item => [item.props.x, item.props.y, item.props.width, item.props.height]),
      all(edge, item => item.type === 'text').map(item => [item.props.x, item.props.y, item.props.children])]
  }))).digest('hex')
  const initial = render(null), initialWork = { ...routeWork }, geometry = digest(initial)
  assert(initialWork.radialCalls > 0 && initialWork.nodeVisits > 0)
  Object.assign(routeWork, { radialCalls: 0, nodeVisits: 0, bezierCalls: 0 })
  let tree
  for (const id of ['n10', 'n11', 'n12', 'n13']) {
    tree = render(id)
    assert.equal(digest(tree), geometry, 'Selection must preserve every path and label geometry')
    assert.deepEqual(all(tree, item => item.props?.className === 'kg-node' && item.props['aria-pressed']).map(item => item.props['data-node-id']), [id])
  }
  all(tree, item => item.type === GraphEdgeInteraction)[0].props.render(false, {}).props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.deepEqual(events, [['n13', 0]], 'Geometry reuse must dispatch through the latest relation callback')
  const warmWork = { ...routeWork }
  if (smoke && !revision) assert.deepEqual(warmWork, { radialCalls: 0, nodeVisits: 0, bezierCalls: 0 }, 'Selection and new callbacks must not reroute unchanged edges')
  const compareFresh = (overrides, message) => {
    const reused = digest(render('n10', overrides))
    assert.equal(reused, digest(render('n10', overrides, { slots: [] })), message + ': reused scene must match a fresh scene')
    return reused
  }
  const movedPos = new Map(layout.pos), point = movedPos.get('n1')
  movedPos.set('n1', { x: point.x + 110, y: point.y + 70 })
  assert.notEqual(compareFresh({ prepared: { ...props.prepared, layout: { pos: movedPos } } }, 'New positions'), geometry)
  const changedSizes = new Map(sizes)
  // A correctly sized radial ring leaves this spoke vertical. Change its
  // height as well so clipping must change even without angular avoidance.
  changedSizes.set('n1', { ...sizes.get('n1'), w: 360, h: 180 })
  assert.notEqual(compareFresh({ prepared: { ...props.prepared, sizes: changedSizes } }, 'New sizes'), geometry)
  const obstacle = { id: 'blocker', type: 'fact', text: 'Routing obstacle' }
  // A separate sparse spoke leaves a free alternative angle even at the
  // 800-node diagnostic size; a dense outer ring can legitimately fall back
  // to the original angle after every candidate is blocked.
  const obstacleNodes = nodes.slice(0, 2), obstacleEdges = [edges[0]]
  const obstaclePos = new Map([['n0', { x: 0, y: 0 }], ['n1', { x: 0, y: -1200 }], [obstacle.id, { x: 0, y: -600 }]])
  const obstacleSizes = new Map(sizes)
  obstacleSizes.set(obstacle.id, { w: 150, h: 100, lines: [obstacle.text] })
  const obstaclePrepared = { ...props.prepared, layout: { pos: obstaclePos }, sizes: obstacleSizes }
  const obstacleInputs = { prepared: obstaclePrepared, nodes: obstacleNodes, edges: obstacleEdges }
  const withoutObstacle = compareFresh(obstacleInputs, 'Unused positions')
  assert.notEqual(compareFresh({ ...obstacleInputs, nodes: [...obstacleNodes, obstacle] }, 'New obstacle membership'), withoutObstacle)
  const reversed = [...edges].reverse()
  compareFresh({ edges: reversed }, 'Canonical relation replacement')
  const changedRelations = edges.map((edge, i) => i === 0 ? { ...edge, relation: 'new_relation_label' } : edge)
  assert.notEqual(compareFresh({ edges: changedRelations }, 'New relation labels'), geometry)
  for (const layoutMode of ['force', 'circular', 'neighborhood', 'overview']) {
    const sceneHooks = { slots: [] }, overrides = { layoutMode }
    const first = render('n10', overrides, sceneHooks)
    Object.assign(routeWork, { radialCalls: 0, nodeVisits: 0, bezierCalls: 0 })
    const second = render('n10', overrides, sceneHooks)
    assert.equal(digest(second), digest(first), layoutMode + ': new parent callback preserves geometry')
    if (smoke && !revision) assert.deepEqual(routeWork, { radialCalls: 0, nodeVisits: 0, bezierCalls: 0 }, layoutMode + ': warm callback does not reroute')
    assert.equal(digest(second), digest(render('n10', overrides, { slots: [] })))
    if (layoutMode === 'overview') {
      const coldHooks = { slots: [] }
      Object.assign(routeWork, { radialCalls: 0, nodeVisits: 0, bezierCalls: 0 })
      render(null, overrides, coldHooks)
      assert.equal(routeWork.bezierCalls, 0, 'Unfocused overview must not eagerly route the whole graph')
    }
  }
  const layerGeometry = new Map(edges.map((edge, i) => [edge, { d: 'M 0 0 L ' + (i + 1) + ' 5', lblX: i * 10,
    lblY: 20, labelW: 40, labelH: 15, labelHidden: false }]))
  const layeredPrepared = { ...props.prepared, layeredEdgeGeometry: layerGeometry }
  const beforeLayered = compareFresh({ layoutMode: 'layered', prepared: layeredPrepared }, 'Layered paths')
  const newLayerGeometry = new Map(layerGeometry)
  newLayerGeometry.set(edges[0], { ...layerGeometry.get(edges[0]), d: 'M 20 30 L 70 90', lblX: 70, labelHidden: true })
  assert.notEqual(compareFresh({ layoutMode: 'layered', prepared: { ...layeredPrepared, layeredEdgeGeometry: newLayerGeometry } }, 'Replaced prepared geometry'), beforeLayered)
  results.push({ initialWork, warmWork, geometry })
}
assert(results.every(result => JSON.stringify(result) === JSON.stringify(results[0])))
console.log(JSON.stringify({ baseline: revision || 'current', graphNodes: count, canonicalEdges: count - 1 + Math.ceil((count - 2) / 4) + 2,
  trials, consecutiveSelections: 4, ...results[0], completeGeometryAndLatestCallbacks: true, inputInvalidationAndLazyOverview: true,
  scope: 'Actual production GraphScene, fixed prepared radial layout, simulated React hooks. Counts and complete edge geometry digest are deterministic; no browser latency or paint claim.' }))
