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
const el = { clientWidth: 900, clientHeight: 600, addEventListener() {}, removeEventListener() {},
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
    tree = GraphScene(props); tree.props.ref.current = el
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
const initial = camera()
click('适合画布')
assert.notEqual(camera(), initial, 'Fit must actually include a large graph below the editor zoom floor')
const fitted = camera()
click('放大（10%）')
assert.notEqual(camera(), fitted)
click('缩小（10%）')
assert.equal(camera(), fitted, 'Zooming in from fit must not ratchet the minimum upward')
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
owner.slots.forEach(state => state.cleanup?.())
assert.equal(frames.size, 0, 'Unmount cancels pending camera work')
console.log(JSON.stringify({ ok: true, nodeSearch: true, paginatedResults: 65, readableFocus: true,
  cameraRestoration: true, endpointNavigation: true, parallelRelationIdentity: true, readOnly: true }))
