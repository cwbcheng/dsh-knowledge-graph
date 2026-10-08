import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Drive the generated scene's real search controls, and count text work in its
// own JS realm. Unrelated SVG/label reads cannot inflate this search metric.
let cursor = 0
const slots = [], frames = new Map()
let nextFrame = 0
const slot = init => slots[cursor++] ||= init()
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
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
const textWork = { nodes: 0, characters: 0 }
const environment = { window: { React }, console, textWork,
  requestAnimationFrame(fn) { const id = nextFrame++; frames.set(id, fn); return id },
  cancelAnimationFrame: id => frames.delete(id),
  document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 8 }) }) }) },
}
runInNewContext(`const normalize = String.prototype.normalize;
  String.prototype.normalize = function(form) {
    if (form === 'NFKC' && this.includes('\\n')) { textWork.nodes++; textWork.characters += this.length; }
    return normalize.call(this, form);
  };`, environment)
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { GraphScene, layoutOverview, computeBBox, createGraphNodeSearch,'), environment)
const { GraphScene, layoutOverview, computeBBox, createGraphNodeSearch } = environment.window.KGViewer
const all = (element, predicate) => Array.isArray(element) ? element.flatMap(child => all(child, predicate))
  : !element || typeof element !== 'object' ? []
    : [...(predicate(element) ? [element] : []), ...all(element.props?.children, predicate)]
const byClass = name => element => element.props?.className?.split(' ').includes(name)
const nodes = Array.from({ length: 12000 }, (_, i) => ({
  id: i === 5999 ? 'exact>id ' : 'n' + i, type: i % 3 ? 'fact' : 'concept', text: 'Node ' + i,
  quote: '合成摘录，保留完整证据。'.repeat(80) + ' Unique quote ' + i,
}))
const original = JSON.stringify(nodes)
const sizes = new Map(nodes.map(node => [node.id, { w: 200, h: 100, lines: [node.text] }]))
const layout = layoutOverview(nodes, sizes)
const props = { nodes, edges: [], anchors: {}, selectedNodeId: null, selectedEdgeId: null, focusReq: { seq: 0 },
  ctx: { timeout: () => () => {} }, onReady() {}, onLayoutModeChange() {},
  onSelectNode(id) { props.selectedNodeId = id; props.selectedEdgeId = null },
  onSelectEdge(id) { props.selectedEdgeId = id; props.selectedNodeId = null },
  prepared: { sizes, layout, bbox: computeBBox(nodes, layout, sizes), edgeLanes: new Map(), layeredEdgeGeometry: new Map() },
  layoutMode: 'overview' }
const viewportElement = { clientWidth: 900, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0 }) }
let tree
const render = () => {
  cursor = 0; tree = GraphScene(props)
  all(tree, byClass('kg-graph-viewport'))[0].props.ref.current = viewportElement
  return tree
}
const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); render() }
const click = label => { all(tree, item => item.type === 'button' && item.props['aria-label'] === label)[0].props.onClick(); flush() }
const searchInput = () => all(tree, item => item.type === 'input' && item.props.type === 'search')[0]
const query = value => { searchInput().props.onChange({ target: { value } }); render() }
const type = value => {
  all(tree, item => item.type === 'select' && item.props['aria-label'] === '查找节点类型')[0].props.onChange({ target: { value } }); render()
}
const results = () => all(tree, byClass('kg-node-search-result')).map(item => item.props['data-node-id'])
const resultsCount = () => all(tree, byClass('kg-node-search-count'))[0].props.children[0]
// Independent oracle preserves the existing NFKC, case, type and ordering
// contract; it must not read the implementation's cached normalized strings.
const expected = (value, nodeType = '', input = nodes) => {
  const normalized = value.trim().normalize('NFKC').toLocaleLowerCase()
  return input.filter(node => (!nodeType || node.type === nodeType) &&
    (!normalized || [node.id, node.text, node.quote].join('\n').normalize('NFKC').toLocaleLowerCase().includes(normalized)))
}
const check = (value, nodeType = '', input = nodes) => {
  const matches = expected(value, nodeType, input)
  assert.equal(resultsCount(), matches.length + ' 个匹配 · 当前视图 ' + input.length + ' 个节点')
  assert.deepEqual(results(), matches.slice(0, 20).map(node => node.id))
}

render(); click('重置缩放为 100%')
const initialWork = { ...textWork }
console.log(JSON.stringify({ graphNodes: nodes.length, searchClosed: true, normalizedNodes: initialWork.nodes, normalizedCharacters: initialWork.characters }))
assert.equal(initialWork.nodes, 0, 'Initial graph loading must not normalize every quote for a closed search panel')
click('查找节点'); check('')
assert.equal(textWork.nodes, 0, 'Opening an empty search needs only node references, not normalized text')
type('fact'); check('', 'fact')
click('下一页匹配节点')
assert.deepEqual(results(), expected('', 'fact').slice(20, 40).map(node => node.id))
assert.equal(textWork.nodes, 0, 'Blank queries, type filtering and pagination do not need text normalization')
query('  ＵＮＩＱＵＥ ｑｕｏｔｅ １１９９９  '); check('  ＵＮＩＱＵＥ ｑｕｏｔｅ １１９９９  ', 'fact')
const factWork = { ...textWork }
assert.equal(factWork.nodes, 8000, 'The first text query only normalizes nodes in the selected type')
query('node 5999'); check('node 5999', 'fact')
assert.equal(textWork.nodes, factWork.nodes, 'Editing a query reuses normalized text')
query('exact>id'); check('exact>id', 'fact')
searchInput().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() {} }); flush()
assert.equal(props.selectedNodeId, null, 'IME composition cannot accidentally navigate')
searchInput().props.onKeyDown({ key: 'Enter', preventDefault() {} }); flush()
assert.equal(props.selectedNodeId, 'exact>id ', 'Search navigation preserves full canonical identity')
click('查找节点'); check('exact>id', 'fact')
assert.equal(textWork.nodes, factWork.nodes, 'Closing and reopening retains the current graph search cache')
type('concept'); check('exact>id', 'concept')
assert.equal(textWork.nodes, nodes.length, 'Changing type fills only the previously unsearched nodes')
type(''); query(' unique quote 11999 '); check(' unique quote 11999 ')
assert.equal(textWork.nodes, nodes.length, 'All subsequent queries reuse one normalization per node')
click('关闭查找'); click('放大（10%）'); click('缩小（10%）')
assert.equal(textWork.nodes, nodes.length, 'Camera updates and a closed panel do no additional search text work')

// A replaced node array must invalidate old quote matches, even with the same
// IDs/layout. The old cache cannot retain obsolete objects or evidence.
const replacement = nodes.map(node => node.id === 'n11999' ? { ...node, quote: 'new evidence only' } : node)
props.nodes = replacement; render()
assert.equal(textWork.nodes, nodes.length, 'A graph change still does not prebuild a closed search')
click('查找节点'); check(' unique quote 11999 ', '', replacement)
assert.equal(textWork.nodes, nodes.length * 2)
query('new evidence only'); check('new evidence only', '', replacement)
assert.deepEqual(results(), ['n11999'])
query(''); check('', '', replacement)
click('下一页匹配节点')
assert.deepEqual(results(), replacement.slice(20, 40).map(node => node.id))
assert.equal(textWork.nodes, nodes.length * 2)
assert.equal(JSON.stringify(nodes), original, 'Searching cannot modify canonical nodes or excerpts')
assert.equal(frames.size, 0)
for (const path of ['src/index.client.js', 'lib/client.js']) {
  assert(readFileSync(new URL('../' + path, import.meta.url), 'utf8').includes(createGraphNodeSearch.toString()), path + ': search helper parity')
}
console.log(JSON.stringify({ ok: true, initialWork, firstTypedFilter: factWork,
  cachedQueryEdits: true, quoteSearch: true, unicodeQuery: true, canonicalOrder: true,
  exactIdentityNavigation: true, emptyQueryPagination: true, graphReplacementInvalidatesCache: true, readOnly: true }))
