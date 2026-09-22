import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Hook slots are scoped per component, like React. Count element creation and
// retain element identity; browser tests separately cover actual DOM/paint.
let current, cursor = 0, created = 0
const slot = init => { const index = cursor++; return current.slots[index] ||= init() }
const React = {
  createElement(type, props, ...children) { created++; return { type, props: { ...props, children } } },
  useState(initial) {
    const owner = current, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [state.value, next => { const value = typeof next === 'function' ? next(state.value) : next; if (!Object.is(value, state.value)) { state.value = value; owner.updates++ } }]
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
const context = { window: { React }, console, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 10 }) }) }) } }
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { GraphScene, GraphEdgeInteraction,'), context)
const { GraphScene, GraphEdgeInteraction } = context.window.KGViewer
const owner = () => ({ slots: [], updates: 0 })
const render = (component, props, hooks) => { current = hooks; cursor = 0; return component(props) }
const all = (element, predicate) => {
  if (Array.isArray(element)) return element.flatMap(child => all(child, predicate))
  if (!element || typeof element !== 'object') return []
  return [...(predicate(element) ? [element] : []), ...all(element.props?.children, predicate)]
}
const byClass = name => element => element.props?.className?.split(' ').includes(name)
const count = 2000
const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i, type: 'claim', text: 'Node ' + i }))
const edges = nodes.slice(1).map((node, i) => ({ fromNodeId: node.id, toNodeId: 'n' + i, relation: 'supports' }))
edges.push({ ...edges[1], relation: 'analogy' })
const sizes = new Map(nodes.map(node => [node.id, { w: 200, h: 120, lines: ['first', 'second', 'third', 'fourth'] }]))
const layout = { pos: new Map(nodes.map((node, i) => [node.id, { x: i % 10 * 300, y: Math.floor(i / 10) * 240 }])) }
const geometry = new Map(edges.map((edge, i) => [edge, { d: 'M 0 0 L 10 10', lblX: i * 10, lblY: 20, labelW: 30, labelH: 15, labelHidden: i === 0 }]))
let selectedEdge = null
const props = { nodes, edges, anchors: {}, selectedNodeId: null, selectedEdgeId: null, focusReq: { seq: 0 },
  onSelectNode() {}, onSelectEdge: index => { selectedEdge = index }, ctx: { timeout: () => () => {} },
  prepared: { sizes, layout, bbox: { w: 3000, h: 48000, cx: 0, cy: 0 }, edgeLanes: new Map(), layeredEdgeGeometry: geometry },
  layoutMode: 'layered', onLayoutModeChange() {}, onReady() {} }
const root = owner()
let scene = render(GraphScene, props, root)
const edgeElements = all(scene, element => element.type === GraphEdgeInteraction)
assert.equal(edgeElements.length, 1999, 'parallel edges retain a single leader')
const hooks = owner(), element = edgeElements[0]
let edge = render(GraphEdgeInteraction, element.props, hooks)
assert.equal(all(edge, byClass('kg-edge-label')).length, 0, 'colliding label starts hidden')
const path = () => all(edge, item => item.type === 'path' && item.props.markerEnd)[0]
const before = created
edge.props.onPointerEnter()
edge = render(GraphEdgeInteraction, element.props, hooks)
assert.equal(path().props.strokeWidth, 3)
assert.equal(all(edge, byClass('hov')).length, 1, 'hover reveals the hidden label')
const hoverElements = created - before
assert(hoverElements <= 10, 'hover must rebuild one edge, not the entire scene: ' + hoverElements)
assert.equal(root.updates, 0, 'edge hover never updates the root scene')

edge.props.onFocus()
edge.props.onPointerLeave()
edge = render(GraphEdgeInteraction, element.props, hooks)
assert.equal(path().props.strokeWidth, 3, 'pointer leaving must not conceal a keyboard-focused label')
edge.props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} })
edge = render(GraphEdgeInteraction, element.props, hooks)
assert.equal(path().props.strokeWidth, 3, 'focus moving into a parallel chip stays active')
edge.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null })
edge = render(GraphEdgeInteraction, element.props, hooks)
assert.equal(path().props.strokeWidth, 2)
assert.equal(all(edge, byClass('kg-edge-label')).length, 0)
edge.props.onKeyDown({ key: 'Enter', preventDefault() {} })
assert.equal(selectedEdge, 0, 'edge index zero is selectable with keyboard')

const parallel = render(GraphEdgeInteraction, edgeElements[1].props, owner())
const chips = all(parallel, item => byClass('kg-edge-label')(item) && item.props.role === 'button')
assert.equal(chips.length, 2)
chips[1].props.onClick({ stopPropagation() {} })
assert.equal(selectedEdge, edges.length - 1, 'parallel chip selects its original relation index')

const labels = all(scene, byClass('kg-node-name'))
const selectionBefore = created
scene = render(GraphScene, { ...props, selectedNodeId: 'n20' }, root)
const selectionElements = created - selectionBefore
const nextLabels = all(scene, byClass('kg-node-name'))
assert.equal(nextLabels.length, count)
for (let i = 0; i < count; i++) assert.equal(nextLabels[i], labels[i], 'static node text must retain React element identity')
assert(selectionElements < count * 4, 'selection must not recreate static text/tspan subtrees: ' + selectionElements)
const selected = all(scene, byClass('kg-node')).find(node => node.props['data-node-id'] === 'n20')
assert.equal(selected.props['aria-pressed'], true)
assert.equal(selected.props.style.opacity, 1)
assert.equal(all(scene, byClass('kg-node'))[0].props.style.opacity, 0.22)

const movedLayout = { pos: new Map(layout.pos) }
movedLayout.pos.set('n20', { x: 123, y: 456 })
scene = render(GraphScene, { ...props, prepared: { ...props.prepared, layout: movedLayout } }, root)
assert.equal(all(scene, byClass('kg-node-name'))[20].props.x, 123, 'new layout invalidates cached text geometry')
const newNodes = nodes.map((node, i) => i === 20 ? { ...node, type: 'concept' } : node)
scene = render(GraphScene, { ...props, nodes: newNodes }, root)
assert.notEqual(all(scene, byClass('kg-node-name'))[20], labels[20], 'new node metadata invalidates cached text')
console.log(JSON.stringify({ nodes: count, edges: edges.length, hoverElements, selectionElements, localFocus: true, hiddenLabels: true, parallelSelection: true, cachedTextInvalidation: true }))
