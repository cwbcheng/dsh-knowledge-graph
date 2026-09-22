import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { openSqliteStore } from '../src/kg-store.mjs'

const hostSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const from = hostSource.indexOf('function graphNeighborhoodHost(')
const hostQuery = new Function(hostSource.slice(from, hostSource.indexOf('function buildGraphViewHost(', from)) + '; return graphNeighborhoodHost')()
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const sandbox = { window: { React: {} }, setTimeout, clearTimeout, setInterval, clearInterval, console }
vm.runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = {mergeNeighborhoodPage, neighborhoodEdgeKey, neighborhoodAnchors, layoutNeighborhood,'), sandbox)
const engine = sandbox.window.KGViewer
const plain = value => JSON.parse(JSON.stringify(value))
const store = await openSqliteStore(':memory:')
try {
  const nodes = Array.from({ length: 4800 }, (_, i) => ({ id: 'n' + i, text: 'Node ' + i, type: 'fact', paragraph: i }))
  nodes[4600].text = nodes[0].text
  const edges = Array.from({ length: 501 }, (_, i) => ({ fromNodeId: 'n0', toNodeId: 'n' + (4299 + i), relation: i % 2 ? 'supports' : 'analogy' }))
  edges.push({ fromNodeId: 'n4799', toNodeId: 'n0', relation: 'contradicts' },
    { fromNodeId: 'n0', toNodeId: 'n4799', relation: 'supports' },
    { fromNodeId: 'n4299', toNodeId: 'n4799', relation: 'supports' },
    { fromNodeId: 'n4799', toNodeId: 'n4500', relation: 'supports' })
  const documentId = 'neighborhood-fixture', graph = { source: { documentId, id: 'source' }, nodes, edges }
  store.saveGraph(graph, { sourceText: 'fixture source' })
  const saved = store.getDocument(documentId), revision = saved.revision
  const before = JSON.stringify(saved)
  assert.equal(store.getDocumentWindow(documentId).nodes.length, 800)
  assert.equal(store.getDocumentWindow(documentId).edges.length, 0, 'base window intentionally has no visible neighbors')
  for (const direction of ['both', 'in', 'out']) {
    for (const relation of ['', 'supports', 'analogy', 'contradicts', 'missing']) {
      let merged = null, offset = 0
      do {
        const args = { centerId: 'n0', direction, relation, expectedRevision: revision, offset, limit: 37 }
        const page = store.getGraphNeighborhood(documentId, args)
        const memory = hostQuery(documentId, { graph: saved, revision }, args)
        assert.deepEqual(plain(page), plain(memory), 'SQL and dynamic route parity')
        merged = engine.mergeNeighborhoodPage(merged, page)
        offset = page.nextOffset
        assert(page.nodes.length <= 38, 'hydrate only one page plus center')
      } while (merged.hasMore)
      const eligible = saved.edges.filter(e => (!relation || e.relation === relation) &&
        ((direction !== 'in' && e.fromNodeId === 'n0') || (direction !== 'out' && e.toNodeId === 'n0')))
      const ids = new Set(['n0', ...eligible.flatMap(e => [e.fromNodeId, e.toNodeId])])
      assert.equal(merged.nodes.length, ids.size)
      assert.deepEqual(new Set(merged.nodes.map(n => n.id)), ids)
      const expectedEdges = saved.edges.filter(e => ids.has(e.fromNodeId) && ids.has(e.toNodeId) && (!relation || e.relation === relation) &&
        (direction === 'both' || (e.fromNodeId !== 'n0' && e.toNodeId !== 'n0') || (direction === 'in' ? e.toNodeId === 'n0' : e.fromNodeId === 'n0')))
      assert.deepEqual(new Set(merged.edges.map(engine.neighborhoodEdgeKey)), new Set(expectedEdges.map(engine.neighborhoodEdgeKey)))
    }
  }
  const baseArgs = { centerId: 'n0', expectedRevision: revision }
  const first = store.getGraphNeighborhood(documentId, baseArgs)
  assert.equal(first.neighborsTotal, 501)
  assert.equal(first.nextOffset, 80)
  const isolated = store.getGraphNeighborhood(documentId, { ...baseArgs, centerId: 'n1' })
  assert.equal(isolated.neighborsTotal, 0)
  assert.equal(isolated.nodes.length, 1)
  assert.equal(isolated.hasMore, false)
  assert.equal(store.getGraphNeighborhood(documentId, { ...baseArgs, centerId: 'n' }).error.code, 'not_found', 'exact ID, never fuzzy matching')
  for (const args of [{ expectedRevision: undefined }, { expectedRevision: -1 }, { limit: 201 }, { offset: -1 }, { offset: NaN }, { limit: 2.5 }, { direction: 'sideways' }, { relation: [] }]) {
    assert.equal(store.getGraphNeighborhood(documentId, { ...baseArgs, ...args }).error.code, 'invalid_input')
    assert.equal(hostQuery(documentId, { graph: saved, revision }, { ...baseArgs, ...args }).error.code, 'invalid_input')
  }
  assert.equal(store.getGraphNeighborhood(documentId, { ...baseArgs, expectedRevision: revision + 1 }).error.code, 'revision_conflict')
  assert.throws(() => engine.mergeNeighborhoodPage(first, { ...first, offset: 80, revision: revision + 1 }), /分页已失效/)
  assert.throws(() => engine.mergeNeighborhoodPage(first, { ...first, offset: 80, centerId: first.nodes[1].id, nodes: [first.nodes[1], first.nodes[0], ...first.nodes.slice(2)] }), /分页已失效/)
  assert.throws(() => engine.mergeNeighborhoodPage(null, { ...first, edges: [{ fromNodeId: 'n0', toNodeId: 'absent', relation: 'supports' }] }), /不完整/)
  assert.equal(JSON.stringify(store.getDocument(documentId)), before, 'neighborhood reads cannot modify canonical data or revision')

  // Self-loops in legacy/dynamic data must not inflate the neighbor count or
  // disappear from the projection. The normal save contract rejects these.
  const loopGraph = { nodes: [nodes[0]], edges: [{ fromNodeId: 'n0', toNodeId: 'n0', relation: 'analogy' }] }
  const loop = hostQuery(documentId, { graph: loopGraph, revision }, baseArgs)
  assert.equal(loop.neighborsTotal, 0); assert.equal(loop.edges.length, 1)

  for (const count of [1, 2, 8, 81, 502]) {
    const local = nodes.slice(0, count), sizes = new Map(local.map((n, i) => [n.id, { w: 80 + i % 5 * 53, h: 50 + i % 4 * 31 }]))
    const start = performance.now(), layout = engine.layoutNeighborhood(local, sizes)
    assert.deepEqual(plain(layout.pos.get('n0')), { x: 0, y: 0 })
    assert.equal(layout.pos.size, count)
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
      const a = layout.pos.get(local[i].id), b = layout.pos.get(local[j].id), sa = sizes.get(local[i].id), sb = sizes.get(local[j].id)
      assert(Math.abs(a.x - b.x) >= (sa.w + sb.w) / 2 || Math.abs(a.y - b.y) >= (sa.h + sb.h) / 2, 'no node rectangles overlap')
    }
    assert.deepEqual(plain([...layout.pos]), plain([...engine.layoutNeighborhood(local, sizes).pos]), 'deterministic layout')
    if (count === 502) console.log(JSON.stringify({ layoutNodes: count, layoutAndCollisionAssertionsMs: Math.round(performance.now() - start) }))
  }
  const anchors = engine.neighborhoodAnchors([{ id: 'outside', paragraph: 2, quote: '', text: 'third' }], 'first\n\nsecond\n\nthird', {})
  assert.equal(anchors.outside, 15, 'off-window source backlink')
  assert.notEqual(engine.neighborhoodEdgeKey({ fromNodeId: 'a>b', toNodeId: 'c', relation: 'r' }), engine.neighborhoodEdgeKey({ fromNodeId: 'a', toNodeId: 'b>c', relation: 'r' }))
  console.log(JSON.stringify({ ok: true, crossWindow: 4800, neighbors: 501, paging: true, dynamicSqlParity: true, readOnly: true, noOverlaps: true }))
} finally { store.close() }

// Run the production controller against out-of-order responses. DOM/layout
// rendering is covered separately by the worker and real-browser fixtures.
function hooks(fn, dependencies) {
  let index = 0
  const slots = [], effects = []
  const changed = (old, deps) => !old || deps.some((value, i) => value !== old.deps[i])
  const api = {
    useState(initial) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    useRef(value) { const i = index++; if (!(i in slots)) slots[i] = { current: value }; return slots[i] },
    useEffect(effect, deps) { const i = index++, old = slots[i]; if (changed(old, deps)) effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: effect() } }) },
    useCallback(fn, deps) { return api.useMemo(() => fn, deps) },
    useMemo(fn, deps) { const i = index++; if (changed(slots[i], deps)) slots[i] = { deps, value: fn() }; return slots[i].value },
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    AbortController, ...dependencies,
  }
  const render = new Function(...Object.keys(api), 'return (' + fn.toString() + ')')(...Object.values(api))
  return { render(props) { index = 0; const tree = render(props); while (effects.length) effects.shift()(); return tree }, dispose() { for (const slot of slots) slot?.cleanup?.() } }
}
const jobs = [], Canvas = () => {}, projections = []
let restored = 0
const props = { documentId: 'ui', revision: 1, nodes: [{ id: 'a' }], edges: [], anchors: {}, sourceText: 'source', focusReq: { seq: 0 },
  selectedNodeId: 'a', loadNeighborhood(args, signal) { return new Promise((resolve, reject) => jobs.push({ args, signal, resolve, reject })) },
  onGatherEnd() { restored++ }, onGatherProjection(value) { projections.push(value) } }
const controller = hooks(engine.GraphViewer, { GraphCanvas: Canvas, mergeNeighborhoodPage: engine.mergeNeighborhoodPage,
  neighborhoodEdgeKey: engine.neighborhoodEdgeKey, neighborhoodAnchors: engine.neighborhoodAnchors, REL_LABEL: {} })
const find = (tree, predicate) => !tree || typeof tree !== 'object' ? null : predicate(tree) ? tree : tree.children?.map(child => find(child, predicate)).find(Boolean)
const action = (tree, label) => { const node = find(tree, n => n.props['aria-label'] === label || n.children?.includes(label)); assert(node, label); return node.props.onClick }
const base = tree => tree.children[0].children[0]
const local = tree => find(tree.children[1], n => n.type === Canvas)
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const reply = (id, extras = {}) => ({ documentId: 'ui', revision: 1, centerId: id, direction: 'both', relation: '', relationTypes: ['supports'], offset: 0, nextOffset: 1,
  neighborsTotal: 1, hasMore: false, nodes: [{ id }, { id: 'neighbor' }], edges: [{ fromNodeId: id, toNodeId: 'neighbor', relation: 'supports' }], ...extras })
let tree = controller.render(props)
base(tree).props.onGather('a')
tree = controller.render(props)
const frozenBase = base(tree)
assert.equal(jobs.length, 1)
action(tree, '重新读取相关节点')()
tree = controller.render(props)
assert(jobs[0].signal.aborted)
jobs[1].resolve(reply('a')); await flush()
tree = controller.render(props)
assert.equal(local(tree).props.nodes[0].id, 'a')
assert.strictEqual(base(tree), frozenBase, 'local requests never rerender the base scene')
local(tree).props.onGather('neighbor')
tree = controller.render(props)
local(tree).props.onGather('a')
tree = controller.render(props)
assert(jobs[2].signal.aborted)
jobs[3].resolve(reply('a')); await flush()
jobs[2].resolve(reply('neighbor')); jobs[0].resolve(reply('wrong')); await flush()
tree = controller.render(props)
assert.equal(local(tree).props.nodes[0].id, 'a', 'late A/B requests cannot replace the latest center')
assert.equal(local(tree).props.onDeleteEdge, undefined, 'off-window edge index must never reach base edit handlers')
const parentRerender = { ...props, onSelectNode() {} }
tree = controller.render(parentRerender)
assert.strictEqual(base(tree), frozenBase, 'source-panel updates do not rerender the hidden 2000-node scene')
action(tree, '重新读取相关节点')(); tree = controller.render(parentRerender)
jobs.at(-1).reject(new Error('offline')); await flush()
tree = controller.render(parentRerender)
assert.equal(find(tree, n => n.props.role === 'alert').children[0], 'offline')
assert.equal(local(tree).props.nodes[0].id, 'a', 'failed queries keep the last successful projection')
action(tree, '重试')(); tree = controller.render(parentRerender)
action(tree, '退出聚拢')(); tree = controller.render(parentRerender)
assert(jobs.at(-1).signal.aborted)
assert.equal(tree.children[1], null)
assert.equal(restored, 1)
jobs.at(-1).resolve(reply('a')); await flush()
assert.equal(controller.render(parentRerender).children[1], null, 'exit invalidates queued results')
base(tree).props.onGather('a'); tree = controller.render(parentRerender)
const changedRevision = { ...parentRerender, revision: 2 }
controller.render(changedRevision); tree = controller.render(changedRevision)
assert(jobs.at(-1).signal.aborted)
assert.equal(tree.children[1], null, 'canonical revision changes invalidate local projections')
assert.equal(restored, 1, 'never restore stale selection into a different document version')
base(tree).props.onGather('a'); controller.render(changedRevision)
controller.dispose(); assert(jobs.at(-1).signal.aborted)
console.log(JSON.stringify({ controller: true, outOfOrder: true, exitAndUnmountSafe: true, baseSceneFrozen: true, retry: true, revisionInvalidation: true }))

let edited = null
const rightEdge = reply('a').edges[0], wrongRelation = { ...rightEdge, relation: 'analogy' }
const editProps = { ...props, edges: [wrongRelation, rightEdge], onDeleteEdge: (edge, index) => { edited = { edge, index } } }
const editing = hooks(engine.GraphViewer, { GraphCanvas: Canvas, mergeNeighborhoodPage: engine.mergeNeighborhoodPage,
  neighborhoodEdgeKey: engine.neighborhoodEdgeKey, neighborhoodAnchors: engine.neighborhoodAnchors, REL_LABEL: {} })
tree = editing.render(editProps); base(tree).props.onGather('a'); editing.render(editProps)
jobs.at(-1).resolve(reply('a')); await flush(); tree = editing.render(editProps)
local(tree).props.onSelectEdge(0); tree = editing.render(editProps)
local(tree).props.onDeleteEdge(); assert.deepEqual(edited, { edge: rightEdge, index: 1 })
editing.dispose()
console.log(JSON.stringify({ stableEdgeIdentity: true, parallelRelationMappedToCanonicalIndex: true }))
