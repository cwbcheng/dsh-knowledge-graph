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
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { GraphScene, GraphEdgeInteraction, layoutOverview,'), context)
const { GraphScene, GraphEdgeInteraction, layoutOverview } = context.window.KGViewer
const owner = () => ({ slots: [], updates: 0 })
const render = (component, props, hooks) => { current = hooks; cursor = 0; return component(props) }
const all = (element, predicate) => {
  if (Array.isArray(element)) return element.flatMap(child => all(child, predicate))
  if (!element || typeof element !== 'object') return []
  return [...(predicate(element) ? [element] : []), ...all(element.props?.children, predicate)]
}
const byClass = name => element => element.props?.className?.split(' ').includes(name)
const count = 2000
let excerptReads = 0
const excerpt = '完整合成摘录，保留可访问证据。'.repeat(80)
const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i, type: 'claim', text: 'Node ' + i,
  get quote() { excerptReads++; return excerpt + i } }))
const edges = nodes.slice(1).map((node, i) => ({ fromNodeId: node.id, toNodeId: 'n' + i, relation: 'supports' }))
edges.push({ ...edges[1], relation: 'analogy' })
const sizes = new Map(nodes.map(node => [node.id, { w: 200, h: 120, lines: ['first', 'second', 'third', 'fourth'] }]))
const layout = { pos: new Map(nodes.map((node, i) => [node.id, { x: i % 10 * 300, y: Math.floor(i / 10) * 240 }])) }
const geometry = new Map(edges.map((edge, i) => [edge, { d: 'M 0 0 L 10 10', lblX: i * 10, lblY: 20, labelW: 30, labelH: 15, labelHidden: i === 0 }]))
let selectedEdge = null
const props = { nodes, edges, anchors: Object.fromEntries(nodes.map(node => [node.id, 0])), selectedNodeId: null, selectedEdgeId: null, focusReq: { seq: 0 },
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
assert.equal(parallel.props.role, 'group', 'Parallel relation controls must not be nested inside an atomic button')
assert(!all(parallel, item => item.props['aria-label']?.startsWith('并行关系：'))[0].props['aria-hidden'],
  'Independently selectable relations must remain exposed to assistive technology')
chips[1].props.onClick({ stopPropagation() {} })
assert.equal(selectedEdge, edges.length - 1, 'parallel chip selects its original relation index')
const selectedOrdinaryScene = render(GraphScene, { ...props, selectedEdgeId: selectedEdge }, owner())
const selectedOrdinaryGroup = render(GraphEdgeInteraction,
  all(selectedOrdinaryScene, item => item.type === GraphEdgeInteraction)[1].props, owner())
const ordinarySelectedPath = all(selectedOrdinaryGroup, item => item.type === 'path' && item.props.markerEnd)[0]
assert.equal(ordinarySelectedPath.props.opacity, 1, 'Selecting a parallel member never dims its shared line')
assert.equal(ordinarySelectedPath.props.strokeWidth, 3)
assert(byClass('sel')(all(selectedOrdinaryGroup, item => byClass('kg-edge-label')(item) && item.props.role === 'button')[1]))

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

// Switching an existing focus changes four nodes in this chain. Everything
// else keeps the complete SVG element, even when the parent replaces callbacks.
const firstSelectionNodes = all(scene, byClass('kg-node'))
const callbacks = [], nextProps = { ...props, selectedNodeId: 'n21', onSelectNode: id => callbacks.push(id) }
excerptReads = 0
scene = render(GraphScene, nextProps, root)
const secondSelectionNodes = all(scene, byClass('kg-node'))
const changedNodeShells = secondSelectionNodes.filter((node, i) => node !== firstSelectionNodes[i]).length
assert.equal(changedNodeShells, 4)
assert.equal(excerptReads, 0, 'Selection must reuse full evidence labels instead of reading every quote')
assert.equal(secondSelectionNodes[10], firstSelectionNodes[10])
assert(secondSelectionNodes[10].props['aria-label'].endsWith(excerpt + '10'), 'Accessible evidence is not truncated')
secondSelectionNodes[10].props.onKeyDown({ key: 'Enter', preventDefault() {} })
secondSelectionNodes[10].props.onClick({ stopPropagation() {} })
assert.deepEqual(callbacks, ['n10', 'n10'], 'Retained pointer and keyboard controls dispatch to the current callback')
assert.equal(secondSelectionNodes[20].props['aria-pressed'], false)
assert.equal(secondSelectionNodes[21].props['aria-pressed'], true)
assert.equal(secondSelectionNodes[22].props.style.opacity, 1)
assert.equal(secondSelectionNodes[19].props.style.opacity, 0.22)

// Context replacement must also refresh retained long-press/cancel actions.
let pressed = 0, cancelled = 0
scene = render(GraphScene, { ...nextProps, ctx: { timeout(fn, ms) { assert.equal(ms, 600); pressed++; return () => cancelled++ } } }, root)
const retained = all(scene, byClass('kg-node'))[10]
assert.equal(retained, secondSelectionNodes[10])
const viewportRef = all(scene, byClass('kg-graph-viewport'))[0].props.ref
viewportRef.current = { getBoundingClientRect: () => ({ left: 0, top: 0 }) }
retained.props.onPointerDown({ clientX: 20, clientY: 30, stopPropagation() {} })
retained.props.onPointerLeave()
assert.equal(pressed, 1)
assert.equal(cancelled, 1)
viewportRef.current = null

const report = { issues: [{ id: 'issue-10', targetKind: 'node', targetId: 'n10', status: 'open', severity: 'error' }] }
const issueHooks = owner(), opened = []
let issueScene = render(GraphScene, { ...props, selectedNodeId: 'n20', issueReport: report, onOpenNodeIssues: () => opened.push('old') }, issueHooks)
const beforeBadge = all(issueScene, byClass('kg-node-issue-badge'))[0]
issueScene = render(GraphScene, { ...props, selectedNodeId: 'n21', issueReport: report, onOpenNodeIssues: node => opened.push(node.id) }, issueHooks)
const afterBadge = all(issueScene, byClass('kg-node-issue-badge'))[0]
assert.equal(afterBadge, beforeBadge, 'Unchanged issue badges are retained')
afterBadge.props.onClick({ stopPropagation() {} })
afterBadge.props.onKeyDown({ key: ' ', preventDefault() {}, stopPropagation() {} })
assert.deepEqual(opened, ['n10', 'n10'])
issueScene = render(GraphScene, { ...props, issueReport: { issues: report.issues.map(issue => ({ ...issue, status: 'dismissed' })) } }, issueHooks)
assert.equal(all(issueScene, byClass('kg-node-issue-badge')).length, 0, 'New reports clear stale issue tint and badges')

const image = { id: 'figure>1', caption: 'Original', interpretationStatus: 'ai_unverified', startParagraph: 2, endParagraph: 3 }
const visualNodes = [{ id: 'image:' + encodeURIComponent(image.id), type: 'image', text: 'Original image', paragraph: 0 },
  { id: 'transcript', type: 'fact', text: 'Transcript', quote: 'Extracted text', paragraph: 2 }]
const visualSizes = new Map(visualNodes.map(node => [node.id, { w: 200, h: 180, lines: [node.text] }]))
const visualProps = { ...props, nodes: visualNodes, edges: [], anchors: { transcript: 0 }, visualSource: { images: [image] },
  prepared: { ...props.prepared, sizes: visualSizes, layout: { pos: new Map(visualNodes.map((node, i) => [node.id, { x: i * 300, y: 100 }])) } },
  renderSourceImage: source => React.createElement('span', { className: 'preview' }, source.caption) }
const visualHooks = owner()
let visualScene = render(GraphScene, visualProps, visualHooks)
assert.equal(all(visualScene, byClass('preview'))[0].props.children[0], 'Original')
assert.match(all(visualScene, byClass('kg-node'))[1].props['aria-label'], /AI 视觉转写摘录，非原书文字/)
visualScene = render(GraphScene, { ...visualProps, visualSource: { images: [{ ...image, caption: 'Updated', interpretationStatus: 'not_requested' }] } }, visualHooks)
assert.equal(all(visualScene, byClass('preview'))[0].props.children[0], 'Updated', 'New image metadata invalidates retained previews')
assert(!all(visualScene, byClass('kg-node'))[1].props['aria-label'].includes('AI 视觉转写'))
visualScene = render(GraphScene, { ...visualProps, renderSourceImage: () => React.createElement('span', { className: 'preview' }, 'New renderer') }, visualHooks)
assert.equal(all(visualScene, byClass('preview'))[0].props.children[0], 'New renderer', 'Replacing the renderer invalidates cached image elements')
visualScene = render(GraphScene, { ...visualProps, anchors: {} }, visualHooks)
assert.match(all(visualScene, byClass('kg-node'))[1].props['aria-label'], /无法定位来源/, 'Anchor replacement refreshes accessible evidence')

const movedLayout = { pos: new Map(layout.pos) }
movedLayout.pos.set('n20', { x: 123, y: 456 })
scene = render(GraphScene, { ...props, prepared: { ...props.prepared, layout: movedLayout } }, root)
assert.equal(all(scene, byClass('kg-node-name'))[20].props.x, 123, 'new layout invalidates cached text geometry')
const newNodes = nodes.map((node, i) => i === 20 ? { ...node, type: 'concept' } : node)
scene = render(GraphScene, { ...props, nodes: newNodes }, root)
assert.notEqual(all(scene, byClass('kg-node-name'))[20], labels[20], 'new node metadata invalidates cached text')

const allNodes = Array.from({ length: 5000 }, (_, i) => ({ id: 'full-' + i, type: 'claim', text: 'Node ' + i }))
let overviewEdgeReads = 0
const allEdges = new Proxy(allNodes.slice(1).map((node, i) => ({ fromNodeId: node.id, toNodeId: 'full-' + i, relation: 'supports' })), {
  get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) overviewEdgeReads++
    return Reflect.get(target, key, receiver)
  },
})
const parallelMemberIndex = allEdges.length
allEdges.push({ ...allEdges[2499], relation: 'analogy' })
allEdges.push({ fromNodeId: 'full-2500', toNodeId: 'full-2500', relation: 'supports' })
const allSizes = new Map(allNodes.map(node => [node.id, { w: 200, h: 120, lines: ['name'] }]))
const overviewLayout = layoutOverview(allNodes, allSizes)
assert.equal(overviewLayout.pos.size, allNodes.length, 'the complete overview must position every node')
assert.equal(new Set([...overviewLayout.pos.values()].map(point => point.x + ':' + point.y)).size, allNodes.length,
  'large overview positions must not collide')
const overviewProps = { ...props, nodes: allNodes, edges: allEdges, layoutMode: 'overview',
  prepared: { sizes: allSizes, layout: overviewLayout, bbox: { w: 20000, h: 12000, cx: 0, cy: 0 },
    edgeLanes: new Map(), layeredEdgeGeometry: new Map() } }
const overviewHooks = owner()
let overview = render(GraphScene, overviewProps, overviewHooks)
assert.equal(all(overview, byClass('kg-node')).length, allNodes.length, 'fit view must represent every node')
assert.equal(all(overview, byClass('kg-node-name')).length, 0, 'fit view must not create thousands of unreadable labels')
assert.equal(all(overview, element => element.type === GraphEdgeInteraction).length, 0,
  'overview must not draw the entire relation tangle before a node is selected')
overviewEdgeReads = 0
overview = render(GraphScene, { ...overviewProps, selectedNodeId: 'full-2500' }, overviewHooks)
const overviewNodeSelectionReads = overviewEdgeReads
assert.equal(all(overview, element => element.type === GraphEdgeInteraction).length, 3,
  'overview selection must expose incident leaders and a single self-loop')
overviewEdgeReads = 0
overview = render(GraphScene, { ...overviewProps, selectedEdgeId: parallelMemberIndex }, overviewHooks)
const overviewParallelSelectionReads = overviewEdgeReads
console.log(JSON.stringify({ overviewEdges: allEdges.length, overviewNodeSelectionReads, overviewParallelSelectionReads }))
const selectedOverviewEdges = all(overview, element => element.type === GraphEdgeInteraction)
assert.equal(selectedOverviewEdges.length, 1, 'Selecting a parallel member must keep its visible leader in overview')
const selectedParallel = render(GraphEdgeInteraction, selectedOverviewEdges[0].props, owner())
const selectedPath = all(selectedParallel, item => item.type === 'path' && item.props.markerEnd)[0]
assert.equal(selectedPath.props.strokeWidth, 3, 'A selected parallel member highlights the shared relation line')
assert.equal(selectedPath.props.opacity, 1)
const selectedChips = all(selectedParallel, item => byClass('kg-edge-label')(item) && item.props.role === 'button')
assert.equal(selectedChips.length, 2, 'Selecting a parallel member reveals the bundled relation labels')
assert(byClass('sel')(selectedChips[1]), 'Only the canonical selected member is marked in the relation legend')
assert(!byClass('sel')(selectedChips[0]))
selectedChips[1].props.onClick({ stopPropagation() {} })
assert.equal(selectedEdge, parallelMemberIndex, 'Visible labels retain their canonical relation indices')
assert(overviewNodeSelectionReads < 10, 'Overview node selection must not scan all relations: ' + overviewNodeSelectionReads)
assert(overviewParallelSelectionReads < 10, 'Overview relation selection must not scan all relations: ' + overviewParallelSelectionReads)
for (const selectedEdgeId of [0, allEdges.length - 1, allEdges.length + 1]) {
  overviewEdgeReads = 0
  overview = render(GraphScene, { ...overviewProps, selectedEdgeId }, overviewHooks)
  const relations = all(overview, item => item.type === GraphEdgeInteraction)
  assert.equal(relations.length, selectedEdgeId < allEdges.length ? 1 : 0, 'Index zero, self-loops and stale selection indices remain valid')
  if (relations.length) {
    const relation = render(GraphEdgeInteraction, relations[0].props, owner())
    relation.props.onClick({ stopPropagation() {} })
    assert.equal(selectedEdge, selectedEdgeId)
  }
  assert(overviewEdgeReads < 10)
}
overviewEdgeReads = 0
overview = render(GraphScene, overviewProps, overviewHooks)
assert.equal(all(overview, item => item.type === GraphEdgeInteraction).length, 0, 'Clearing focus hides the relation tangle again')
assert.equal(overviewEdgeReads, 0)
const replacedEdges = [...allEdges].reverse()
overview = render(GraphScene, { ...overviewProps, edges: replacedEdges, selectedEdgeId: 0 }, overviewHooks)
const replacedRelation = render(GraphEdgeInteraction, all(overview, item => item.type === GraphEdgeInteraction)[0].props, owner())
assert.match(replacedRelation.props['aria-label'], /full-2500 → full-2500/, 'Replacing canonical edges rebuilds the index')

// Ordered pairs cannot be grouped by a concatenated delimiter: both of the
// first two edges spell 'a>b>c', but they have different exact endpoints.
const identityNodes = ['a>b', 'c', 'a', 'b>c', ' c '].map(id => ({ id, type: 'claim', text: id }))
const identityEdges = [
  { fromNodeId: 'a>b', toNodeId: 'c', relation: 'supports' },
  { fromNodeId: 'a', toNodeId: 'b>c', relation: 'analogy' },
  { fromNodeId: 'c', toNodeId: 'a>b', relation: 'supports' },
  { fromNodeId: ' c ', toNodeId: 'a>b', relation: 'analogy' },
]
const identityBefore = JSON.stringify(identityEdges)
const identitySizes = new Map(identityNodes.map(node => [node.id, { w: 200, h: 120, lines: [node.id] }]))
const identityProps = { ...overviewProps, nodes: identityNodes, edges: identityEdges,
  prepared: { ...overviewProps.prepared, sizes: identitySizes, layout: layoutOverview(identityNodes, identitySizes) } }
const identityHooks = owner()
let identityScene = render(GraphScene, { ...identityProps, selectedNodeId: 'a' }, identityHooks)
let identityRelations = all(identityScene, item => item.type === GraphEdgeInteraction)
assert.equal(identityRelations.length, 1, 'Delimiter-containing IDs cannot hide an unrelated relation as a parallel member')
const identityRelation = render(GraphEdgeInteraction, identityRelations[0].props, owner())
assert.equal(identityRelation.props.role, 'button', 'Distinct endpoint pairs do not become a bundled relation group')
identityRelation.props.onClick({ stopPropagation() {} })
assert.equal(selectedEdge, 1)
identityScene = render(GraphScene, { ...identityProps, selectedNodeId: 'a>b' }, identityHooks)
identityRelations = all(identityScene, item => item.type === GraphEdgeInteraction)
assert.equal(identityRelations.length, 3, 'Incoming, outgoing and whitespace-sensitive endpoints retain separate relations')
assert.deepEqual(identityRelations.map(item => render(GraphEdgeInteraction, item.props, owner()).props['aria-label']),
  ['关系边：支持（a>b → c）', '关系边：支持（c → a>b）', '关系边：类比说明（ c  → a>b）'], 'Incident paths retain canonical order')
assert.equal(JSON.stringify(identityEdges), identityBefore, 'Selection does not mutate canonical relations')
console.log(JSON.stringify({ nodes: count, edges: edges.length, hoverElements, selectionElements, localFocus: true, hiddenLabels: true, parallelSelection: true, cachedTextInvalidation: true, overviewNodes: allNodes.length,
  overviewNodeSelectionReads, overviewParallelSelectionReads, canonicalIndices: true, exactEndpointIdentity: true, selfLoops: true,
  changedNodeShells, retainedShells: count - changedNodeShells, currentCallbacks: true, contextReplacement: true, issueAndImageInvalidation: true, fullAccessibleEvidence: true }))
