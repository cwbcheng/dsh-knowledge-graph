import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Exercise the generated production component, including its real hooks and
// camera scheduler. Browser verification separately checks layout and focus.
let current, cursor = 0
const frames = new Map()
const pendingUpdates = []
let frameId = 0
const slot = init => { const index = cursor++; return current.slots[index] ||= init() }
const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } } },
  useState(initial) {
    const owner = current, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [state.value, next => { pendingUpdates.push(() => {
      const value = typeof next === 'function' ? next(state.value) : next
      if (!Object.is(value, state.value)) { state.value = value; owner.dirty = true }
    }) }]
  },
  useRef(initial) { return slot(() => ({ current: initial })) },
  useMemo(fn, deps) {
    const memo = slot(() => ({}))
    if (!memo.deps || deps.some((dep, i) => !Object.is(dep, memo.deps[i]))) { memo.value = fn(); memo.deps = deps }
    return memo.value
  },
  useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
  useEffect(fn, deps) {
    const state = slot(() => ({}))
    if (!state.deps || deps.some((dep, i) => !Object.is(dep, state.deps[i]))) {
      current.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    }
  },
}
const context = { window: { React }, console, AbortController, DOMException,
  requestAnimationFrame: fn => { const id = frameId++; frames.set(id, fn); return id },
  cancelAnimationFrame: id => frames.delete(id), setTimeout: () => 1, clearTimeout() {},
  document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 10 }) }) }) } }
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../extension/viewer.css', import.meta.url), 'utf8')
assert(/\.kg-edge-label\[role="button"\]\s*\{\s*pointer-events:\s*auto;/.test(css),
  'Parallel relation chips need pointer hit testing, not just click handlers')
assert(/\.kg-node-search\s*\{[^}]*background:\s*var\(--kg-edge-label-bg\)/.test(css),
  'Search results must not be visually overlaid by graph content behind the panel')
const toolbarRule = css.match(/\.kg-graph-toolbar\s*\{([^}]+)\}/)?.[1]
assert(toolbarRule && !/position:\s*absolute/.test(toolbarRule) && /flex-wrap:\s*wrap/.test(toolbarRule),
  'Toolbar rows must occupy real layout space, including when controls wrap')
assert(/\.kg-graph-viewport\s*\{[^}]*min-height:\s*0/.test(css), 'The canvas must shrink inside a fixed graph surface')
assert(/\.kg-graph-toolbar \.kg-graph-zoom\s*\{[^}]*width:\s*56px/.test(css),
  'Changing the zoom percentage cannot rewrap the toolbar and resize the canvas')
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { GraphScene,'), context)
const { GraphScene } = context.window.KGViewer
const all = (element, predicate) => Array.isArray(element) ? element.flatMap(child => all(child, predicate))
  : !element || typeof element !== 'object' ? []
    : [...(predicate(element) ? [element] : []), ...all(element.props?.children, predicate)]
const byClass = name => element => element.props?.className?.split(' ').includes(name)
const text = element => Array.isArray(element) ? element.map(text).join('')
  : element && typeof element === 'object' ? text(element.props?.children) : String(element ?? '')

const nodes = Array.from({ length: 65 }, (_, i) => ({ id: 'n' + i, type: i % 2 ? 'fact' : 'concept',
  text: i === 64 ? '<img src=x onerror=alert(1)> Tail needle' : 'Node ' + i, quote: 'Evidence ' + i, paragraph: i }))
const edges = [
  { fromNodeId: 'n0', toNodeId: 'n64', relation: 'supports' },
  { fromNodeId: 'n0', toNodeId: 'n64', relation: 'contradicts' },
  { fromNodeId: 'n64', toNodeId: 'n0', relation: 'analogy' },
  { fromNodeId: 'n0', toNodeId: 'n0', relation: 'supports' },
]
const original = JSON.stringify({ nodes, edges })
const owner = { slots: [], effects: [], dirty: false }
const listeners = new Map(), captured = new Set()
const el = { clientWidth: 900, clientHeight: 600,
  addEventListener(name, callback) { listeners.set(name, callback) },
  removeEventListener(name) { listeners.delete(name) },
  getBoundingClientRect: () => ({ left: 100, top: 160 }),
  setPointerCapture(id) { captured.add(id) }, hasPointerCapture: id => captured.has(id),
  releasePointerCapture(id) { captured.delete(id) },
  contains: item => all(tree, byClass('kg-graph-viewport')).some(viewport => all(viewport, node => node === item).length),
  querySelector: () => null, closest: () => null }
const layout = { pos: new Map(nodes.map((node, i) => [node.id, { x: i * 300, y: i * 200 }])) }
const props = { nodes, edges, anchors: Object.fromEntries(nodes.map((node, i) => [node.id, i * 10])),
  selectedNodeId: null, selectedEdgeId: null, focusReq: { seq: 0 }, layoutMode: 'layered',
  prepared: { sizes: new Map(nodes.map(node => [node.id, { w: 220, h: 100, lines: [node.text] }])),
    layout, bbox: { w: 20000, h: 13000, cx: 9600, cy: 6400 }, edgeLanes: new Map(),
    layeredEdgeGeometry: new Map(edges.map(edge => [edge, { d: 'M 0 0 L 10 10', lblX: 10, lblY: 10, labelW: 40, labelH: 18 }])) },
  ctx: { timeout: () => () => {} }, onReady() {}, onLayoutModeChange() {},
  onSelectNode(id) { props.selectedNodeId = id; props.selectedEdgeId = null; owner.dirty = true },
  onSelectEdge(index) { props.selectedEdgeId = index; props.selectedNodeId = null; owner.dirty = true },
}
let tree
function render() {
  for (let i = 0; i < 20; i++) {
    owner.dirty = false; current = owner; cursor = 0
    pendingUpdates.splice(0).forEach(fn => fn())
    tree = GraphScene(props)
    const viewport = all(tree, byClass('kg-graph-viewport'))[0]
    assert(viewport?.props.ref, 'Camera measurement must be attached to the actual canvas')
    viewport.props.ref.current = el
    owner.effects.splice(0).forEach(fn => fn())
    const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn())
    if (!owner.dirty && !frames.size && !pendingUpdates.length) return tree
  }
  throw new Error('Component did not settle')
}
const button = label => {
  const found = all(tree, item => item.type === 'button' && item.props['aria-label'] === label)[0]
  assert(found, 'Missing accessible control: ' + label)
  return found
}
const camera = () => all(tree, item => item.type === 'g' && item.props.style?.transform)[0].props.style.transform
const click = label => { const item = button(label); assert(!item.props.disabled, label + ' is disabled'); item.props.onClick(); render() }

render()
assert.equal(tree.props.role, 'group', 'Interactive SVG controls must not be hidden inside an atomic image role')
assert.equal(tree.props.ref, undefined, 'The camera cannot measure the graph plus toolbar')
assert.equal(tree.props.onPointerDown, undefined, 'Toolbar background must never start canvas panning')
const toolbar = all(tree, byClass('kg-graph-toolbar'))[0]
const viewport = () => all(tree, byClass('kg-graph-viewport'))[0]
assert(tree.props.children.includes(toolbar) && tree.props.children.includes(viewport()), 'Toolbar and canvas must be separate rows')
assert.equal(all(viewport(), byClass('kg-graph-toolbar')).length, 0, 'Toolbar cannot occlude the canvas')
assert.equal(all(viewport(), item => item.type === 'svg').length, 1, 'Export and panning use the same rendered SVG')
const initial = camera()
click('适合画布')
assert.notEqual(camera(), initial, 'Fit must actually include a large graph below the editor zoom floor')
const fitted = camera()
const fittedValues = fitted.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/)
for (const [coordinate, size, center, translation] of [[900, 20000, 9600, fittedValues[1]], [600, 13000, 6400, fittedValues[2]]]) {
  const near = (center - size / 2) * Number(fittedValues[3]) + Number(translation)
  const far = (center + size / 2) * Number(fittedValues[3]) + Number(translation)
  assert(near >= 16 - 1e-8 && far <= coordinate - 16 + 1e-8, 'Fit retains a canvas inset instead of clipping node borders')
}
click('放大（10%）')
assert.notEqual(camera(), fitted)
click('缩小（10%）')
const roundTrip = camera().match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/)
assert.equal(roundTrip[3], fittedValues[3], 'Zooming in from fit must not ratchet the minimum upward')
for (const axis of [1, 2]) assert(Math.abs(Number(roundTrip[axis]) - Number(fittedValues[axis])) < 1e-8,
  'Fit zoom round trip must preserve position apart from floating-point arithmetic')
click('返回上一位置')
assert.equal(camera(), initial, 'Back restores the exact camera rather than fitting again')
click('查找节点')
const input = all(tree, item => item.type === 'input' && item.props.type === 'search')[0]
assert(input, 'Node search is available without querying or replacing the graph')
input.props.onChange({ target: { value: 'TAIL NEEDLE' } }); render()
const result = all(tree, byClass('kg-node-search-result'))
assert.equal(result.length, 1)
assert(text(result[0]).includes('<img src=x onerror=alert(1)>'), 'Source-like markup is displayed as literal text')
result[0].props.onClick(); render()
assert.equal(props.selectedNodeId, 'n64')
assert(all(tree, byClass('kg-node-detail')).some(item => text(item).includes('Tail needle')))
assert.match(camera(), /scale\(0\.85\)/, 'Finding a node restores a readable zoom in every layout')
click('返回上一位置')
assert.equal(camera(), initial)
assert.equal(props.selectedNodeId, null)

// A graph relation must expose actual endpoint text, not just opaque IDs.
props.onSelectEdge(1); render()
const detail = all(tree, item => item.props['aria-label'] === '关系详情')[0]
assert(text(detail).includes('Node 0') && text(detail).includes('Tail needle'))
const endpoint = all(detail, item => item.type === 'button' && item.props['data-node-id'] === 'n64')[0]
assert(endpoint, 'Relationship endpoints must be navigable')
endpoint.props.onClick(); render()
assert.equal(props.selectedNodeId, 'n64')
assert.equal(all(tree, item => item.props.role === 'dialog').length, 1, 'Node and edge dialogs must never overlap')
click('返回上一位置')
assert.equal(props.selectedEdgeId, 1, 'Parallel relation identity survives navigation')

// Search never silently truncates a long result set and has a real empty state.
click('查找节点')
let search = all(tree, item => item.type === 'input' && item.props.type === 'search')[0]
search.props.onChange({ target: { value: '' } }); render()
const seen = new Set()
for (;;) {
  const results = all(tree, byClass('kg-node-search-result'))
  assert(results.length <= 20, 'Only one bounded page is mounted')
  results.forEach(item => seen.add(item.props['data-node-id']))
  if (button('下一页匹配节点').props.disabled) break
  click('下一页匹配节点')
}
assert.equal(seen.size, 65)
const typeFilter = all(tree, item => item.type === 'select' && item.props['aria-label'] === '查找节点类型')[0]
typeFilter.props.onChange({ target: { value: 'concept' } }); render()
assert.equal(all(tree, byClass('kg-node-search-result'))[0].props['data-node-id'], 'n0', 'Changing filters resets the page')
assert(all(tree, byClass('kg-node-search-result')).every(item => Number(item.props['data-node-id'].slice(1)) % 2 === 0))
typeFilter.props.onChange({ target: { value: '' } }); render()
search = all(tree, item => item.type === 'input' && item.props.type === 'search')[0]
search.props.onChange({ target: { value: 'ＥＶＩＤＥＮＣＥ 64' } }); render()
assert.equal(all(tree, byClass('kg-node-search-result'))[0].props['data-node-id'], 'n64', 'Search includes source quotes and normalizes full-width text')
search = all(tree, item => item.type === 'input' && item.props.type === 'search')[0]
search.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() { throw new Error('IME confirmation was consumed') } })
assert.equal(props.selectedEdgeId, 1, 'IME composition cannot accidentally navigate away')
search = all(tree, item => item.type === 'input' && item.props.type === 'search')[0]
search.props.onChange({ target: { value: 'no-such-node' } }); render()
assert.equal(all(tree, byClass('kg-node-search-result')).length, 0)
assert(text(tree).includes('当前视图没有匹配节点'))

// External source navigation also gets readable focus, and a changed graph
// cannot resurrect old detail objects, camera history or parallel edge indexes.
props.onSelectNode('n0'); props.focusReq = { seq: 1, nodeId: 'n0' }; render()
assert.match(camera(), /scale\(0\.85\)/)
click('返回上一位置')
assert.equal(props.selectedEdgeId, 1, 'Source navigation returns to the previous exact relationship')
assert.equal(camera(), initial)
click('查找节点')
search = all(tree, item => item.type === 'input' && item.props.type === 'search')[0]
search.props.onChange({ target: { value: 'tail needle' } }); render()
all(tree, byClass('kg-node-search-result'))[0].props.onClick(); render()
el.clientWidth = 390; el.clientHeight = 844
click('返回上一位置')
const savedCamera = initial.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/)
assert.equal(camera(), 'translate(' + (Number(savedCamera[1]) - 255) + 'px, ' + (Number(savedCamera[2]) + 122) + 'px) scale(' + savedCamera[3] + ')',
  'Back after resizing preserves the same world point under the viewport center')
el.clientWidth = 900; el.clientHeight = 600
props.nodes = nodes.slice(1); props.edges = []; render()
assert(button('返回上一位置').props.disabled)
assert.equal(all(tree, byClass('kg-node-detail')).length, 0)
assert.equal(JSON.stringify({ nodes, edges }), original, 'Browsing never mutates canonical graph data')
const beforeWheel = camera().match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/)
let wheelPrevented = false
listeners.get('wheel')({ctrlKey:true,deltaY:-1,clientX:550,clientY:460,preventDefault(){wheelPrevented=true},target:{closest:()=>null}})
render()
assert(wheelPrevented)
const zoomed = camera().match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/)
assert(Math.abs((450 - Number(zoomed[1])) / Number(zoomed[3]) - (450 - Number(beforeWheel[1])) / Number(beforeWheel[3])) < 1e-8)
assert(Math.abs((300 - Number(zoomed[2])) / Number(zoomed[3]) - (300 - Number(beforeWheel[2])) / Number(beforeWheel[3])) < 1e-8,
  'Ctrl-wheel anchors to canvas coordinates, not the toolbar or outer surface')
const prePan = camera()
const panTarget = {closest:()=>null}
viewport().props.onPointerDown({button:0,pointerId:1,clientX:110,clientY:170,target:panTarget}); render()
assert(captured.has(1))
viewport().props.onPointerMove({pointerId:1,clientX:140,clientY:190}); render()
assert.notEqual(camera(), prePan)
const moved = camera()
viewport().props.onPointerCancel({pointerId:1,clientX:900,clientY:900}); render()
assert.equal(camera(), moved, 'Cancelled gestures cannot apply a late pointer coordinate')
assert.equal(captured.size, 0)
viewport().props.onPointerMove({pointerId:1,clientX:500,clientY:500}); render()
assert.equal(camera(), moved, 'No stale panning after pointer cancellation')
viewport().props.onPointerDown({button:0,pointerId:2,clientX:140,clientY:190,target:panTarget}); render()
viewport().props.onPointerUp({pointerId:2,clientX:110,clientY:170}); render()
assert.equal(camera(), prePan)
owner.slots.forEach(state => state.cleanup?.())
assert.equal(frames.size, 0, 'Unmount cancels pending camera work')

// A bounding-box center can lie in a large empty gap between real nodes.
// DOM node count is not a rendering assertion; mount the actual component.
const sparseNodes = [
  { id: 'shared:model', text: 'Same label', type: 'connection_model' },
  { id: 'shared:model ', text: 'Same label', type: 'connection_model' },
]
const sparsePrepared = { sizes: new Map(sparseNodes.map(node => [node.id, { w: 220, h: 100, lines: [node.text] }])),
  layout: { pos: new Map([['shared:model', { x: -20000, y: -10000 }], ['shared:model ', { x: 20000, y: 10000 }]]) },
  bbox: { w: 40220, h: 20100, cx: 0, cy: 0 }, edgeLanes: new Map(), layeredEdgeGeometry: new Map() }
const firstViews = []
for (const width of [900, 344]) {
  for (const [layoutMode, selectedNodeId] of [['layered', null], ['radial', 'shared:model '], ['neighborhood', 'shared:model '], ['overview', null]]) {
    const instance = { slots: [], effects: [], dirty: false }
    let firstTree, selectionCalls = 0, animationCalls = 0, animationCancels = 0
    el.clientWidth = width; el.clientHeight = 481
    el.querySelectorAll = selector => {
      assert.equal(selector, '.kg-node')
      return all(firstTree, byClass('kg-node')).map(element => ({
        getAttribute: name => element.props[name],
        animate(keyframes, options) {
          assert.equal(options.duration, 240)
          assert.equal(keyframes[1].transform, 'translate(0px,0px)')
          animationCalls++
          return { cancel() { animationCancels++ } }
        },
      }))
    }
    const firstProps = { ...props, nodes: sparseNodes, edges: [], selectedNodeId, selectedEdgeId: null,
      prepared: sparsePrepared, focusReq: { seq: 0 }, layoutMode,
      onSelectNode() { selectionCalls++ }, onSelectEdge() { selectionCalls++ } }
    const mount = () => {
      for (let pass = 0; pass < 20; pass++) {
        instance.dirty = false; current = instance; cursor = 0
        pendingUpdates.splice(0).forEach(fn => fn())
        firstTree = GraphScene(firstProps)
        all(firstTree, byClass('kg-graph-viewport'))[0].props.ref.current = el
        instance.effects.splice(0).forEach(fn => fn())
        const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn())
        if (!instance.dirty && !frames.size && !pendingUpdates.length) return
      }
      throw new Error('Initial view did not settle')
    }
    mount()
    const transform = all(firstTree, item => item.type === 'g' && item.props.style?.transform)[0].props.style.transform
    const match = transform.match(/translate\(([-\d.eE+]+)px, ([-\d.eE+]+)px\) scale\(([-\d.eE+]+)\)/)
    assert(match, 'Initial camera is finite and inspectable')
    const [tx, ty, k] = match.slice(1).map(Number)
    const visible = sparseNodes.filter(node => {
      const point = sparsePrepared.layout.pos.get(node.id), size = sparsePrepared.sizes.get(node.id)
      const x = point.x * k + tx, y = point.y * k + ty
      return x - size.w * k / 2 >= 16 - 1e-8 && x + size.w * k / 2 <= width - 16 + 1e-8
        && y - size.h * k / 2 >= 16 - 1e-8 && y + size.h * k / 2 <= 481 - 16 + 1e-8
    })
    assert(visible.length > 0, 'First sparse graph view must contain an actual visible node, not just DOM nodes')
    if (layoutMode === 'overview') assert.equal(visible.length, sparseNodes.length, 'Overview fits the full graph below its former zoom floor')
    else {
      assert(k >= 0.85, 'A large graph must start at a readable local scale, not as microscopic labels')
      if (layoutMode === 'neighborhood') assert.equal(visible[0].id, sparseNodes[0].id, 'Neighborhood keeps its root rather than an off-center selection')
      else if (selectedNodeId) assert.equal(visible[0].id, selectedNodeId, 'Prefer exact selected identity, including trailing space')
    }
    firstProps.selectedNodeId = sparseNodes[0].id
    mount()
    assert.equal(all(firstTree, item => item.type === 'g' && item.props.style?.transform)[0].props.style.transform, transform,
      'A selection update cannot rerun the initial fit and overwrite the camera')
    assert.equal(selectionCalls, 0, 'Initial camera placement must not silently select or edit knowledge')
    firstViews.push({ width, layoutMode, visible: visible.length, scale: k })
    instance.slots.forEach(state => state.cleanup?.())
    assert.equal(animationCalls, layoutMode === 'neighborhood' ? sparseNodes.length : 0)
    assert.equal(animationCancels, animationCalls, 'Neighborhood transition is disposed without changing the camera')
    assert.equal(frames.size, 0)
  }
}
console.log(JSON.stringify({ ok: true, nodeSearch: true, paginatedResults: 65, readableFocus: true,
  cameraRestoration: true, endpointNavigation: true, parallelRelationIdentity: true,
  separateToolbarAndCanvas: true, canvasWheelAnchor: true, pointerCancellation: true, readOnly: true, firstViews }))
